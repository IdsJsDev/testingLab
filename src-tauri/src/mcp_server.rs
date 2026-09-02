use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Response;
use parking_lot::Mutex;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{ServerCapabilities, ServerInfo};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use crate::ammeter::AmmeterManager;
use crate::flight_controller::ControllerManager;

const ADDRESS: &str = "127.0.0.1:8765";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClient {
    pub name: String,
    pub session_id: Option<String>,
    pub last_seen_unix_ms: u64,
    pub request_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLogEntry {
    pub timestamp_unix_ms: u64,
    pub client: String,
    pub action: String,
    pub accepted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub address: String,
    pub access_mode: String,
    pub public_address: Option<String>,
    pub token: String,
    pub clients: Vec<McpClient>,
    pub log: Vec<McpLogEntry>,
}

#[derive(Default)]
struct Activity {
    clients: Vec<McpClient>,
    log: VecDeque<McpLogEntry>,
}

struct RunningServer {
    cancellation: CancellationToken,
}

pub struct McpManager {
    token: String,
    running: Mutex<Option<RunningServer>>,
    activity: Arc<Mutex<Activity>>,
    controller: Arc<ControllerManager>,
    ammeter: Arc<AmmeterManager>,
    public_address: Mutex<Option<String>>,
}

impl McpManager {
    pub fn new(controller: Arc<ControllerManager>, ammeter: Arc<AmmeterManager>) -> Self {
        let bytes: [u8; 24] = rand::random();
        let token = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        Self {
            token,
            running: Mutex::new(None),
            activity: Arc::new(Mutex::new(Activity::default())),
            controller,
            ammeter,
            public_address: Mutex::new(None),
        }
    }

    pub fn status(&self) -> McpStatus {
        let activity = self.activity.lock();
        let public_address = self.public_address.lock().clone();
        McpStatus {
            running: self.running.lock().is_some(),
            address: public_address
                .as_deref()
                .map(mcp_endpoint)
                .unwrap_or_else(|| format!("http://{ADDRESS}/mcp")),
            access_mode: if public_address.is_some() {
                "public".into()
            } else {
                "local".into()
            },
            public_address,
            token: self.token.clone(),
            clients: activity.clients.clone(),
            log: activity.log.iter().cloned().collect(),
        }
    }

    pub async fn start(
        self: &Arc<Self>,
        app: AppHandle,
        public_address: Option<String>,
    ) -> Result<McpStatus, String> {
        if self.running.lock().is_some() {
            return Ok(self.status());
        }
        let public = public_address
            .map(|address| validate_public_address(&address))
            .transpose()?;
        let listener = tokio::net::TcpListener::bind(ADDRESS)
            .await
            .map_err(|error| format!("Не удалось запустить MCP на {ADDRESS}: {error}"))?;
        let cancellation = CancellationToken::new();
        let service_state = McpTools::new(
            Arc::clone(&self.controller),
            Arc::clone(&self.ammeter),
            Arc::clone(&self.activity),
        );
        let mut config = StreamableHttpServerConfig::default();
        config.cancellation_token = cancellation.clone();
        config.json_response = true;
        config.allowed_hosts = vec!["127.0.0.1:8765".into(), "localhost:8765".into()];
        if let Some(public) = &public {
            config.allowed_hosts.push(public.host.clone());
            if let Some(authority) = &public.authority {
                config.allowed_hosts.push(authority.clone());
            }
            config.allowed_origins.push(public.origin.clone());
        }
        let service: StreamableHttpService<McpTools, LocalSessionManager> =
            StreamableHttpService::new(
                move || Ok(service_state.clone()),
                LocalSessionManager::default().into(),
                config,
            );
        let auth = AuthState {
            token: self.token.clone(),
            activity: Arc::clone(&self.activity),
            emitter: Some((app, Arc::clone(self))),
        };
        let router = Router::new()
            .nest_service("/mcp", service)
            .layer(middleware::from_fn_with_state(auth, authorize_and_track));
        let shutdown = cancellation.clone();
        tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(shutdown.cancelled_owned())
                .await;
        });
        *self.running.lock() = Some(RunningServer { cancellation });
        *self.public_address.lock() = public.map(|public| public.base_url);
        Ok(self.status())
    }

    pub fn stop(&self) -> McpStatus {
        if let Some(server) = self.running.lock().take() {
            server.cancellation.cancel();
        }
        self.activity.lock().clients.clear();
        self.status()
    }
}

struct PublicAddress {
    base_url: String,
    host: String,
    authority: Option<String>,
    origin: String,
}

fn validate_public_address(address: &str) -> Result<PublicAddress, String> {
    if address.contains("YOUR-TUNNEL-DOMAIN") {
        return Err("Замените YOUR-TUNNEL-DOMAIN на адрес запущенного туннеля".into());
    }
    let parsed = url::Url::parse(address.trim())
        .map_err(|_| "Публичный адрес должен быть корректным HTTPS URL".to_owned())?;
    if parsed.scheme() != "https" {
        return Err("Для публичного режима разрешён только HTTPS".into());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Публичный адрес не должен содержать query или fragment".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "В публичном адресе отсутствует домен".to_owned())?
        .to_owned();
    let authority = parsed.port().map(|port| format!("{host}:{port}"));
    let origin = parsed.origin().ascii_serialization();
    let base_url = address
        .trim()
        .trim_end_matches('/')
        .trim_end_matches("/mcp")
        .to_owned();
    Ok(PublicAddress {
        base_url,
        host,
        authority,
        origin,
    })
}

fn mcp_endpoint(base_url: &str) -> String {
    format!("{}/mcp", base_url.trim_end_matches('/'))
}

#[derive(Clone)]
struct AuthState {
    token: String,
    activity: Arc<Mutex<Activity>>,
    emitter: Option<(AppHandle, Arc<McpManager>)>,
}

async fn authorize_and_track(
    State(state): State<AuthState>,
    headers: HeaderMap,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let client = headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("MCP client")
        .to_owned();
    let session_id = headers
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let accepted = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| token == state.token);
    record_request(&state.activity, client, session_id, accepted);
    if !accepted {
        emit_status(&state);
        return Err(StatusCode::UNAUTHORIZED);
    }
    let response = next.run(request).await;
    // Tool handlers add their audit records while processing the request, so emit only after
    // they have completed. This keeps the UI in sync without waiting for another request.
    emit_status(&state);
    Ok(response)
}

fn emit_status(state: &AuthState) {
    if let Some((app, manager)) = &state.emitter {
        let _ = app.emit("mcp-status", manager.status());
    }
}

fn record_request(
    activity: &Arc<Mutex<Activity>>,
    client_name: String,
    session_id: Option<String>,
    accepted: bool,
) {
    let now = unix_ms();
    let mut activity = activity.lock();
    if accepted {
        if let Some(client) = activity.clients.iter_mut().find(|client| {
            client.name == client_name
                && (client.session_id == session_id
                    || client.session_id.is_none()
                    || session_id.is_none())
        }) {
            client.last_seen_unix_ms = now;
            client.request_count += 1;
            if session_id.is_some() {
                client.session_id = session_id.clone();
            }
        } else {
            activity.clients.push(McpClient {
                name: client_name.clone(),
                session_id,
                last_seen_unix_ms: now,
                request_count: 1,
            });
        }
    }
    activity.log.push_front(McpLogEntry {
        timestamp_unix_ms: now,
        client: client_name,
        action: "MCP HTTP request".to_owned(),
        accepted,
    });
    activity.log.truncate(50);
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ParameterQuery {
    #[schemars(description = "Case-insensitive part of the parameter name")]
    query: Option<String>,
    #[schemars(description = "Maximum number of results, from 1 to 500")]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ParameterName {
    name: String,
}

#[derive(Clone)]
struct McpTools {
    tool_router: ToolRouter<Self>,
    controller: Arc<ControllerManager>,
    ammeter: Arc<AmmeterManager>,
    activity: Arc<Mutex<Activity>>,
}

impl McpTools {
    fn new(
        controller: Arc<ControllerManager>,
        ammeter: Arc<AmmeterManager>,
        activity: Arc<Mutex<Activity>>,
    ) -> Self {
        Self {
            tool_router: Self::tool_router(),
            controller,
            ammeter,
            activity,
        }
    }

    fn log_tool(&self, action: &str) {
        let mut activity = self.activity.lock();
        activity.log.push_front(McpLogEntry {
            timestamp_unix_ms: unix_ms(),
            client: "authorized MCP client".to_owned(),
            action: action.to_owned(),
            accepted: true,
        });
        activity.log.truncate(50);
    }
}

#[tool_router]
impl McpTools {
    #[tool(description = "Get read-only connection status for the flight controller and ammeter")]
    fn get_connection_status(&self) -> String {
        self.log_tool("get_connection_status");
        json!({
            "flightControllerConnected": self.controller.is_connected(),
            "ammeterConnected": self.ammeter.snapshot().is_some(),
            "readOnly": true
        })
        .to_string()
    }

    #[tool(description = "Get the latest MAVLink telemetry snapshot")]
    fn get_telemetry(&self) -> String {
        self.log_tool("get_telemetry");
        serde_json::to_string(&self.controller.telemetry_snapshot())
            .unwrap_or_else(|_| "null".into())
    }

    #[tool(description = "Get the latest external reference ammeter measurement")]
    fn get_ammeter_reading(&self) -> String {
        self.log_tool("get_ammeter_reading");
        serde_json::to_string(&self.ammeter.snapshot()).unwrap_or_else(|_| "null".into())
    }

    #[tool(description = "Search and list flight-controller parameters from the application cache")]
    fn list_parameters(&self, Parameters(query): Parameters<ParameterQuery>) -> String {
        self.log_tool("list_parameters");
        let needle = query.query.unwrap_or_default().to_ascii_lowercase();
        let limit = query.limit.unwrap_or(100).clamp(1, 500);
        let snapshot = self.controller.parameter_snapshot();
        let items: Vec<_> = snapshot
            .items
            .iter()
            .filter(|item| item.name.to_ascii_lowercase().contains(&needle))
            .take(limit)
            .collect();
        serde_json::to_string(&json!({
            "loaded": snapshot.complete,
            "total": snapshot.total_count,
            "returned": items.len(),
            "parameters": items
        }))
        .unwrap_or_else(|_| "null".into())
    }

    #[tool(description = "Get one flight-controller parameter by its exact name")]
    fn get_parameter(&self, Parameters(input): Parameters<ParameterName>) -> String {
        self.log_tool("get_parameter");
        let snapshot = self.controller.parameter_snapshot();
        let item = snapshot
            .items
            .iter()
            .find(|item| item.name.eq_ignore_ascii_case(&input.name));
        serde_json::to_string(&item).unwrap_or_else(|_| "null".into())
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for McpTools {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Read-only access to live UAV test-station telemetry, parameters, and ammeter data. Never claim that these tools can modify or control the vehicle.",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Activity, AuthState, McpTools, authorize_and_track, record_request, validate_public_address,
    };
    use crate::ammeter::AmmeterManager;
    use crate::flight_controller::ControllerManager;
    use axum::Router;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::middleware;
    use http_body_util::BodyExt;
    use parking_lot::Mutex;
    use rmcp::transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    };
    use std::sync::Arc;
    use tower::ServiceExt;

    #[test]
    fn tracks_authorized_clients_and_rejected_requests() {
        let activity = Arc::new(Mutex::new(Activity::default()));
        record_request(&activity, "client-a".into(), Some("one".into()), true);
        record_request(&activity, "client-a".into(), Some("one".into()), true);
        record_request(&activity, "unknown".into(), None, false);
        let activity = activity.lock();
        assert_eq!(activity.clients.len(), 1);
        assert_eq!(activity.clients[0].request_count, 2);
        assert_eq!(activity.log.len(), 3);
    }

    #[test]
    fn promotes_initial_request_to_the_same_session_client() {
        let activity = Arc::new(Mutex::new(Activity::default()));
        record_request(&activity, "client-a".into(), None, true);
        record_request(&activity, "client-a".into(), Some("session-a".into()), true);
        let activity = activity.lock();
        assert_eq!(activity.clients.len(), 1);
        assert_eq!(activity.clients[0].session_id.as_deref(), Some("session-a"));
        assert_eq!(activity.clients[0].request_count, 2);
    }

    #[test]
    fn validates_public_https_tunnel_address() {
        let address = validate_public_address("https://uav-example.ngrok-free.app/mcp/")
            .expect("valid public address");
        assert_eq!(address.base_url, "https://uav-example.ngrok-free.app");
        assert_eq!(address.host, "uav-example.ngrok-free.app");
        assert_eq!(address.origin, "https://uav-example.ngrok-free.app");
        assert!(validate_public_address("http://example.test").is_err());
        assert!(validate_public_address("https://YOUR-TUNNEL-DOMAIN.ngrok-free.app").is_err());
    }

    #[tokio::test]
    async fn completes_mcp_initialize_list_and_tool_call() {
        let activity = Arc::new(Mutex::new(Activity::default()));
        let tools = McpTools::new(
            Arc::new(ControllerManager::default()),
            Arc::new(AmmeterManager::default()),
            Arc::clone(&activity),
        );
        let mut config = StreamableHttpServerConfig::default();
        config.json_response = true;
        config.allowed_hosts = vec!["127.0.0.1:8765".into()];
        let service: StreamableHttpService<McpTools, LocalSessionManager> =
            StreamableHttpService::new(
                move || Ok(tools.clone()),
                LocalSessionManager::default().into(),
                config,
            );
        let auth = AuthState {
            token: "test-token".into(),
            activity: Arc::clone(&activity),
            emitter: None,
        };
        let router = Router::new()
            .nest_service("/mcp", service)
            .layer(middleware::from_fn_with_state(auth, authorize_and_track));

        let unauthorized = router
            .clone()
            .oneshot(mcp_request(
                None,
                None,
                r#"{"jsonrpc":"2.0","id":0,"method":"ping"}"#,
            ))
            .await
            .expect("router response");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let initialized = router
            .clone()
            .oneshot(mcp_request(
                Some("test-token"),
                None,
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"integration-test","version":"1.0"}}}"#,
            ))
            .await
            .expect("initialize response");
        assert_eq!(initialized.status(), StatusCode::OK);
        let session = initialized
            .headers()
            .get("mcp-session-id")
            .expect("session header")
            .to_str()
            .expect("session id")
            .to_owned();
        let body = initialized
            .into_body()
            .collect()
            .await
            .expect("initialize body")
            .to_bytes();
        assert!(String::from_utf8_lossy(&body).contains("serverInfo"));

        let listed = router
            .clone()
            .oneshot(mcp_request(
                Some("test-token"),
                Some(&session),
                r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
            ))
            .await
            .expect("tools/list response");
        assert_eq!(listed.status(), StatusCode::OK);
        let body = listed
            .into_body()
            .collect()
            .await
            .expect("tools/list body")
            .to_bytes();
        assert!(String::from_utf8_lossy(&body).contains("get_telemetry"));

        let called = router
            .oneshot(mcp_request(
                Some("test-token"),
                Some(&session),
                r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_connection_status","arguments":{}}}"#,
            ))
            .await
            .expect("tools/call response");
        assert_eq!(called.status(), StatusCode::OK);
        let body = called
            .into_body()
            .collect()
            .await
            .expect("tools/call body")
            .to_bytes();
        assert!(String::from_utf8_lossy(&body).contains("flightControllerConnected"));
    }

    fn mcp_request(
        token: Option<&str>,
        session: Option<&str>,
        body: &'static str,
    ) -> Request<Body> {
        let mut builder = Request::post("/mcp")
            .header("host", "127.0.0.1:8765")
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("user-agent", "integration-test");
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        if let Some(session) = session {
            builder = builder.header("mcp-session-id", session);
        }
        builder.body(Body::from(body)).expect("valid request")
    }
}
