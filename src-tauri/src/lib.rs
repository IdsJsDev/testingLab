mod ammeter;
mod flight_controller;
mod mcp_server;
mod parameter_file;
mod status;

use std::sync::Arc;

use ammeter::{AmmeterManager, AmmeterSnapshot};
use flight_controller::{
    ControllerManager, HeartbeatInfo, ParameterWriteRequest, SerialPortDescriptor,
};
use mcp_server::{McpManager, McpStatus};
use parameter_file::ParameterFileEntry;
use status::CoreStatus;
use tauri::{AppHandle, State};

#[tauri::command]
fn get_core_status() -> CoreStatus {
    CoreStatus::disconnected()
}

#[tauri::command]
async fn scan_serial_ports() -> Result<Vec<SerialPortDescriptor>, String> {
    tauri::async_runtime::spawn_blocking(flight_controller::list_serial_ports)
        .await
        .map_err(|error| format!("Задача поиска портов завершилась с ошибкой: {error}"))?
}

#[tauri::command]
async fn connect_flight_controller(
    app: AppHandle,
    manager: State<'_, Arc<ControllerManager>>,
    port_name: String,
    baud_rate: u32,
) -> Result<HeartbeatInfo, String> {
    let manager = Arc::clone(manager.inner());
    tauri::async_runtime::spawn_blocking(move || manager.connect(app, port_name, baud_rate))
        .await
        .map_err(|error| format!("Задача подключения завершилась с ошибкой: {error}"))?
}

#[tauri::command]
async fn disconnect_flight_controller(
    manager: State<'_, Arc<ControllerManager>>,
) -> Result<(), String> {
    let manager = Arc::clone(manager.inner());
    tauri::async_runtime::spawn_blocking(move || manager.disconnect())
        .await
        .map_err(|error| format!("Задача отключения завершилась с ошибкой: {error}"))
}

#[tauri::command]
fn request_flight_controller_parameters(
    manager: State<'_, Arc<ControllerManager>>,
) -> Result<(), String> {
    manager.request_parameters()
}

#[tauri::command]
fn save_mission_planner_parameter_file(
    path: String,
    entries: Vec<ParameterFileEntry>,
) -> Result<(), String> {
    parameter_file::save(std::path::Path::new(&path), &entries)
}

#[tauri::command]
fn load_mission_planner_parameter_file(path: String) -> Result<Vec<ParameterFileEntry>, String> {
    parameter_file::load(std::path::Path::new(&path))
}

#[tauri::command]
fn write_flight_controller_parameters(
    manager: State<'_, Arc<ControllerManager>>,
    requests: Vec<ParameterWriteRequest>,
) -> Result<(), String> {
    manager.write_parameters(requests)
}

#[tauri::command]
async fn connect_ammeter(
    app: AppHandle,
    manager: State<'_, Arc<AmmeterManager>>,
    port_name: String,
) -> Result<AmmeterSnapshot, String> {
    let manager = Arc::clone(manager.inner());
    tauri::async_runtime::spawn_blocking(move || manager.connect(app, port_name))
        .await
        .map_err(|error| format!("Задача подключения завершилась с ошибкой: {error}"))?
}

#[tauri::command]
async fn disconnect_ammeter(manager: State<'_, Arc<AmmeterManager>>) -> Result<(), String> {
    let manager = Arc::clone(manager.inner());
    tauri::async_runtime::spawn_blocking(move || manager.disconnect())
        .await
        .map_err(|error| format!("Задача отключения завершилась с ошибкой: {error}"))
}

#[tauri::command]
fn get_mcp_status(manager: State<'_, Arc<McpManager>>) -> McpStatus {
    manager.status()
}

#[tauri::command]
async fn start_mcp_server(
    app: AppHandle,
    manager: State<'_, Arc<McpManager>>,
    public_address: Option<String>,
) -> Result<McpStatus, String> {
    Arc::clone(manager.inner()).start(app, public_address).await
}

#[tauri::command]
fn stop_mcp_server(manager: State<'_, Arc<McpManager>>) -> McpStatus {
    manager.stop()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let controller = Arc::new(ControllerManager::default());
    let ammeter = Arc::new(AmmeterManager::default());
    let mcp = Arc::new(McpManager::new(
        Arc::clone(&controller),
        Arc::clone(&ammeter),
    ));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(controller)
        .manage(ammeter)
        .manage(mcp)
        .invoke_handler(tauri::generate_handler![
            get_core_status,
            scan_serial_ports,
            connect_flight_controller,
            disconnect_flight_controller,
            request_flight_controller_parameters,
            save_mission_planner_parameter_file,
            load_mission_planner_parameter_file,
            write_flight_controller_parameters,
            connect_ammeter,
            disconnect_ammeter,
            get_mcp_status,
            start_mcp_server,
            stop_mcp_server
        ])
        .run(tauri::generate_context!())
        .expect("failed to run UAV Test Station");
}
