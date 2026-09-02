mod flight_controller;
mod status;

use std::sync::Arc;

use flight_controller::{
    ControllerManager, HeartbeatInfo, ParameterSnapshot, SerialPortDescriptor, TelemetrySnapshot,
};
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
fn get_flight_controller_telemetry(
    manager: State<'_, Arc<ControllerManager>>,
) -> Option<TelemetrySnapshot> {
    manager.latest_telemetry()
}

#[tauri::command]
fn request_flight_controller_parameters(
    manager: State<'_, Arc<ControllerManager>>,
) -> Result<(), String> {
    manager.request_parameters()
}

#[tauri::command]
fn get_flight_controller_parameters(
    manager: State<'_, Arc<ControllerManager>>,
) -> ParameterSnapshot {
    manager.latest_parameters()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(ControllerManager::default()))
        .invoke_handler(tauri::generate_handler![
            get_core_status,
            scan_serial_ports,
            connect_flight_controller,
            disconnect_flight_controller,
            get_flight_controller_telemetry,
            request_flight_controller_parameters,
            get_flight_controller_parameters
        ])
        .run(tauri::generate_context!())
        .expect("failed to run UAV Test Station");
}
