mod ammeter;
mod flight_controller;
mod mcp_server;
pub mod motor_test;
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
async fn read_flight_controller_parameter(
    manager: State<'_, Arc<ControllerManager>>,
    name: String,
) -> Result<flight_controller::ParameterValue, String> {
    let manager = Arc::clone(manager.inner());
    tauri::async_runtime::spawn_blocking(move || manager.read_parameter(name))
        .await
        .map_err(|error| format!("Задача чтения параметра завершилась с ошибкой: {error}"))?
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
fn save_scenario_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents)
        .map_err(|error| format!("Не удалось сохранить сценарии в {path}: {error}"))
}

#[tauri::command]
fn load_scenario_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path)
        .map_err(|error| format!("Не удалось прочитать сценарии из {path}: {error}"))
}

#[tauri::command]
fn write_flight_controller_parameters(
    manager: State<'_, Arc<ControllerManager>>,
    requests: Vec<ParameterWriteRequest>,
) -> Result<(), String> {
    manager.write_parameters(requests)
}

#[tauri::command]
fn start_motor_rotation(
    manager: State<'_, Arc<ControllerManager>>,
    throttle_percent: f32,
    duration_seconds: f32,
) -> Result<(), String> {
    if !throttle_percent.is_finite() || !(1.0..=30.0).contains(&throttle_percent) {
        return Err("Для проверки вращения разрешён газ от 1 до 30%".to_owned());
    }
    if !duration_seconds.is_finite() || !(0.1..=5.0).contains(&duration_seconds) {
        return Err("Проверка вращения должна длиться от 0.1 до 5 секунд".to_owned());
    }
    let minimum_pwm = 1_000_u16;
    let pwm = minimum_pwm + (throttle_percent * 10.0).round() as u16;
    manager.start_rc_pulse(
        1,
        pwm,
        minimum_pwm,
        std::time::Duration::from_secs_f32(duration_seconds),
    )
}

#[tauri::command]
fn emergency_stop_motor(manager: State<'_, Arc<ControllerManager>>) -> Result<(), String> {
    manager.emergency_stop()
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
    let controller_on_window_event = Arc::clone(&controller);
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
            read_flight_controller_parameter,
            save_mission_planner_parameter_file,
            load_mission_planner_parameter_file,
            save_scenario_file,
            load_scenario_file,
            write_flight_controller_parameters,
            start_motor_rotation,
            emergency_stop_motor,
            connect_ammeter,
            disconnect_ammeter,
            get_mcp_status,
            start_mcp_server,
            stop_mcp_server
        ])
        .on_window_event(move |_window, event| {
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                let _ = controller_on_window_event.emergency_stop();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run UAV Test Station");
}
