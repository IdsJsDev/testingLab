use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{BufReader, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use mavlink::MavHeader;
use mavlink::dialects::ardupilotmega::{
    COMMAND_LONG_DATA, MavAutopilot, MavCmd, MavMessage, MavModeFlag, MavParamType,
    PARAM_REQUEST_LIST_DATA, PARAM_REQUEST_READ_DATA, PARAM_SET_DATA, RC_CHANNELS_OVERRIDE_DATA,
};
use mavlink::error::MessageReadError;
use mavlink::peek_reader::PeekReader;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serialport::{SerialPortInfo, SerialPortType};
use tauri::{AppHandle, Emitter};

const READ_TIMEOUT: Duration = Duration::from_millis(200);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(5);
const HEARTBEAT_LOSS_TIMEOUT: Duration = Duration::from_secs(3);
const TELEMETRY_EMIT_INTERVAL: Duration = Duration::from_millis(250);
const MAVLINK_PARSE_DEADLINE: Duration = Duration::from_millis(300);

struct DeadlineReader<R> {
    inner: R,
    deadline: Instant,
}

impl<R> DeadlineReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            deadline: Instant::now() + MAVLINK_PARSE_DEADLINE,
        }
    }

    fn reset_deadline(&mut self) {
        self.deadline = Instant::now() + MAVLINK_PARSE_DEADLINE;
    }
}

impl<R: Read> Read for DeadlineReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if Instant::now() >= self.deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "MAVLink parser deadline reached",
            ));
        }
        self.inner.read(buffer)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortDescriptor {
    pub name: String,
    pub kind: &'static str,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
    pub vendor_id: Option<u16>,
    pub product_id: Option<u16>,
}

impl From<SerialPortInfo> for SerialPortDescriptor {
    fn from(port: SerialPortInfo) -> Self {
        match port.port_type {
            SerialPortType::UsbPort(usb) => Self {
                name: port.port_name,
                kind: "usb",
                manufacturer: usb.manufacturer,
                product: usb.product,
                serial_number: usb.serial_number,
                vendor_id: Some(usb.vid),
                product_id: Some(usb.pid),
            },
            SerialPortType::BluetoothPort => Self {
                name: port.port_name,
                kind: "bluetooth",
                manufacturer: None,
                product: None,
                serial_number: None,
                vendor_id: None,
                product_id: None,
            },
            SerialPortType::PciPort => Self {
                name: port.port_name,
                kind: "pci",
                manufacturer: None,
                product: None,
                serial_number: None,
                vendor_id: None,
                product_id: None,
            },
            SerialPortType::Unknown => Self {
                name: port.port_name,
                kind: "unknown",
                manufacturer: None,
                product: None,
                serial_number: None,
                vendor_id: None,
                product_id: None,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatInfo {
    pub port_name: String,
    pub baud_rate: u32,
    pub system_id: u8,
    pub component_id: u8,
    pub vehicle_type: String,
    pub autopilot: String,
    pub system_status: String,
    pub mavlink_version: u8,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySnapshot {
    pub message_count: u64,
    pub armed: Option<bool>,
    pub custom_mode: Option<u32>,
    pub system_status: Option<String>,
    pub status_text: Option<String>,
    pub cpu_load_percent: Option<f32>,
    pub battery_voltage_v: Option<f32>,
    pub battery_current_a: Option<f32>,
    pub battery_remaining_percent: Option<i8>,
    pub roll_rad: Option<f32>,
    pub pitch_rad: Option<f32>,
    pub yaw_rad: Option<f32>,
    pub gps_fix: Option<String>,
    pub satellites_visible: Option<u8>,
    pub rc_channels: Option<[u16; 18]>,
    pub rc_channel_count: Option<u8>,
    pub rc_rssi: Option<u8>,
    pub servo1_output_pwm: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterValue {
    pub name: String,
    pub value: f32,
    pub parameter_type: String,
    pub index: u16,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterSnapshot {
    pub items: Vec<ParameterValue>,
    pub received_count: usize,
    pub refresh_received_count: usize,
    pub total_count: u16,
    pub complete: bool,
    pub loading: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterWriteRequest {
    pub name: String,
    pub value: f32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterWriteStatus {
    pub active: bool,
    pub total: usize,
    pub completed: usize,
    pub failed: usize,
    pub current_name: Option<String>,
    pub last_error: Option<String>,
}

enum WorkerCommand {
    RequestParameters,
    ReadParameter {
        name: String,
        reply: mpsc::SyncSender<Result<ParameterValue, String>>,
    },
    WriteParameters(Vec<ParameterWriteRequest>),
    StartRcPulse {
        channel: u8,
        pwm: u16,
        minimum_pwm: u16,
        duration: Duration,
        reply: mpsc::SyncSender<Result<(), String>>,
    },
    EmergencyStop {
        reply: mpsc::SyncSender<Result<(), String>>,
    },
    SetArmed {
        armed: bool,
        force: bool,
        reply: mpsc::SyncSender<Result<(), String>>,
    },
}

struct ActiveRcPulse {
    channel: u8,
    pwm: u16,
    minimum_pwm: u16,
    deadline: Instant,
    last_sent: Instant,
}

struct PendingParameterRead {
    name: String,
    reply: mpsc::SyncSender<Result<ParameterValue, String>>,
    started_at: Instant,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ControllerEvent {
    Heartbeat { heartbeat: HeartbeatInfo },
    Telemetry { telemetry: TelemetrySnapshot },
    Parameters { snapshot: ParameterSnapshot },
    ParameterWriteStatus { status: ParameterWriteStatus },
    Disconnected { reason: String, expected: bool },
}

pub struct ControllerSession {
    stop: Arc<AtomicBool>,
    commands: mpsc::Sender<WorkerCommand>,
    worker: JoinHandle<()>,
}

struct SessionSharedState {
    latest_telemetry: Arc<Mutex<Option<TelemetrySnapshot>>>,
    latest_parameters: Arc<Mutex<ParameterSnapshot>>,
    parameter_write_status: Arc<Mutex<ParameterWriteStatus>>,
}

#[derive(Default)]
pub struct ControllerManager {
    session: Mutex<Option<ControllerSession>>,
    latest_telemetry: Arc<Mutex<Option<TelemetrySnapshot>>>,
    latest_parameters: Arc<Mutex<ParameterSnapshot>>,
    parameter_write_status: Arc<Mutex<ParameterWriteStatus>>,
}

impl ControllerManager {
    pub fn is_connected(&self) -> bool {
        self.session.lock().is_some()
    }

    pub fn telemetry_snapshot(&self) -> Option<TelemetrySnapshot> {
        self.latest_telemetry.lock().clone()
    }

    pub fn parameter_snapshot(&self) -> ParameterSnapshot {
        self.latest_parameters.lock().clone()
    }

    pub fn connect(
        &self,
        app: AppHandle,
        port_name: String,
        baud_rate: u32,
    ) -> Result<HeartbeatInfo, String> {
        self.disconnect();

        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let worker_telemetry = Arc::clone(&self.latest_telemetry);
        let worker_parameters = Arc::clone(&self.latest_parameters);
        let worker_write_status = Arc::clone(&self.parameter_write_status);
        *worker_telemetry.lock() = None;
        let (first_heartbeat_tx, first_heartbeat_rx) = mpsc::sync_channel(1);
        let (commands, worker_commands) = mpsc::channel();
        let worker = thread::spawn(move || {
            run_session(
                app,
                port_name,
                baud_rate,
                worker_stop,
                SessionSharedState {
                    latest_telemetry: worker_telemetry,
                    latest_parameters: worker_parameters,
                    parameter_write_status: worker_write_status,
                },
                worker_commands,
                first_heartbeat_tx,
            );
        });

        *self.session.lock() = Some(ControllerSession {
            stop,
            commands,
            worker,
        });

        match first_heartbeat_rx.recv_timeout(HEARTBEAT_TIMEOUT + Duration::from_secs(1)) {
            Ok(Ok(heartbeat)) => Ok(heartbeat),
            Ok(Err(error)) => {
                self.disconnect();
                Err(error)
            }
            Err(_) => {
                self.disconnect();
                Err("Не получен MAVLink heartbeat за отведённое время".to_owned())
            }
        }
    }

    pub fn disconnect(&self) {
        let session = self.session.lock().take();

        if let Some(session) = session {
            session.stop.store(true, Ordering::Relaxed);
            let _ = session.worker.join();
        }

        *self.latest_telemetry.lock() = None;
        *self.latest_parameters.lock() = ParameterSnapshot::default();
        *self.parameter_write_status.lock() = ParameterWriteStatus::default();
    }

    pub fn request_parameters(&self) -> Result<(), String> {
        let mut parameters = self.latest_parameters.lock();
        parameters.loading = true;
        parameters.complete = false;
        parameters.refresh_received_count = 0;
        drop(parameters);
        let session = self.session.lock();
        let session = session
            .as_ref()
            .ok_or_else(|| "Полётный контроллер не подключён".to_owned())?;
        session
            .commands
            .send(WorkerCommand::RequestParameters)
            .map_err(|_| "Сессия контроллера уже завершена".to_owned())
    }

    pub fn read_parameter(&self, name: String) -> Result<ParameterValue, String> {
        let name = name.trim().to_owned();
        if name.is_empty() || name.len() > 16 || !name.is_ascii() {
            return Err(
                "Имя MAVLink-параметра должно содержать от 1 до 16 ASCII-символов".to_owned(),
            );
        }
        let (reply, response) = mpsc::sync_channel(1);
        {
            let session = self.session.lock();
            session
                .as_ref()
                .ok_or_else(|| "Полётный контроллер не подключён".to_owned())?
                .commands
                .send(WorkerCommand::ReadParameter {
                    name: name.clone(),
                    reply,
                })
                .map_err(|_| "Сессия контроллера уже завершена".to_owned())?;
        }
        response
            .recv_timeout(Duration::from_secs(4))
            .map_err(|_| format!("Контроллер не ответил на запрос параметра {name}"))?
    }

    pub fn write_parameters(&self, requests: Vec<ParameterWriteRequest>) -> Result<(), String> {
        if requests.is_empty() || requests.len() > 200 {
            return Err("Выберите от 1 до 200 параметров".to_owned());
        }
        let parameters = self.latest_parameters.lock();
        for request in &requests {
            if !request.value.is_finite()
                || !parameters
                    .items
                    .iter()
                    .any(|item| item.name == request.name)
            {
                return Err(format!(
                    "Некорректный или неизвестный параметр {}",
                    request.name
                ));
            }
        }
        drop(parameters);
        let session = self.session.lock();
        session
            .as_ref()
            .ok_or_else(|| "Полётный контроллер не подключён".to_owned())?
            .commands
            .send(WorkerCommand::WriteParameters(requests))
            .map_err(|_| "Сессия контроллера уже завершена".to_owned())
    }

    pub fn start_rc_pulse(
        &self,
        channel: u8,
        pwm: u16,
        minimum_pwm: u16,
        duration: Duration,
    ) -> Result<(), String> {
        if !(1..=8).contains(&channel) {
            return Err("Канал газа должен быть от 1 до 8".to_owned());
        }
        if !(800..=2200).contains(&pwm) || !(800..=2200).contains(&minimum_pwm) {
            return Err("PWM должен находиться в диапазоне 800…2200".to_owned());
        }
        if pwm <= minimum_pwm {
            return Err("Рабочий PWM должен быть выше минимального".to_owned());
        }
        if duration.is_zero() || duration > Duration::from_secs(5) {
            return Err("Импульс газа должен длиться от 0 до 5 секунд".to_owned());
        }
        let (reply, response) = mpsc::sync_channel(1);
        self.session
            .lock()
            .as_ref()
            .ok_or_else(|| "Полётный контроллер не подключён".to_owned())?
            .commands
            .send(WorkerCommand::StartRcPulse {
                channel,
                pwm,
                minimum_pwm,
                duration,
                reply,
            })
            .map_err(|_| "Сессия контроллера уже завершена".to_owned())?;
        response
            .recv_timeout(Duration::from_secs(1))
            .map_err(|_| "Контроллер не подтвердил отправку команды газа".to_owned())?
    }

    pub fn emergency_stop(&self) -> Result<(), String> {
        let (reply, response) = mpsc::sync_channel(1);
        let session = self.session.lock();
        let Some(session) = session.as_ref() else {
            return Ok(());
        };
        session
            .commands
            .send(WorkerCommand::EmergencyStop { reply })
            .map_err(|_| "Сессия контроллера уже завершена".to_owned())?;
        response
            .recv_timeout(Duration::from_secs(1))
            .map_err(|_| "Не получено подтверждение аварийной остановки".to_owned())?
    }

    pub fn set_armed(&self, armed: bool, force: bool) -> Result<(), String> {
        let (reply, response) = mpsc::sync_channel(1);
        self.session
            .lock()
            .as_ref()
            .ok_or_else(|| "Полётный контроллер не подключён".to_owned())?
            .commands
            .send(WorkerCommand::SetArmed {
                armed,
                force,
                reply,
            })
            .map_err(|_| "Сессия контроллера уже завершена".to_owned())?;
        response
            .recv_timeout(Duration::from_secs(1))
            .map_err(|_| "Контроллер не подтвердил отправку команды ARM/DISARM".to_owned())?
    }
}

pub fn list_serial_ports() -> Result<Vec<SerialPortDescriptor>, String> {
    let mut ports: Vec<_> = serialport::available_ports()
        .map_err(|error| format!("Не удалось получить список Serial-портов: {error}"))?
        .into_iter()
        .map(SerialPortDescriptor::from)
        .collect();

    ports.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(ports)
}

#[cfg(test)]
pub fn wait_for_heartbeat(port_name: String, baud_rate: u32) -> Result<HeartbeatInfo, String> {
    let port = serialport::new(&port_name, baud_rate)
        .timeout(READ_TIMEOUT)
        .open()
        .map_err(|error| format!("Не удалось открыть {port_name}: {error}"))?;

    let mut reader = PeekReader::new(DeadlineReader::new(BufReader::new(port)));
    let deadline = Instant::now() + HEARTBEAT_TIMEOUT;

    while Instant::now() < deadline {
        reader.reader_mut().reset_deadline();
        match mavlink::read_any_msg::<MavMessage, _>(&mut reader) {
            Ok((header, MavMessage::HEARTBEAT(heartbeat))) => {
                return Ok(HeartbeatInfo {
                    port_name,
                    baud_rate,
                    system_id: header.system_id,
                    component_id: header.component_id,
                    vehicle_type: format!("{:?}", heartbeat.mavtype),
                    autopilot: format!("{:?}", heartbeat.autopilot),
                    system_status: format!("{:?}", heartbeat.system_status),
                    mavlink_version: heartbeat.mavlink_version,
                });
            }
            Ok(_) | Err(_) => continue,
        }
    }

    Err(format!(
        "На {port_name} не получен MAVLink heartbeat за {} с",
        HEARTBEAT_TIMEOUT.as_secs()
    ))
}

fn run_session(
    app: AppHandle,
    port_name: String,
    baud_rate: u32,
    stop: Arc<AtomicBool>,
    shared: SessionSharedState,
    commands: mpsc::Receiver<WorkerCommand>,
    first_heartbeat_tx: mpsc::SyncSender<Result<HeartbeatInfo, String>>,
) {
    let SessionSharedState {
        latest_telemetry,
        latest_parameters,
        parameter_write_status,
    } = shared;
    let port = match serialport::new(&port_name, baud_rate)
        .timeout(READ_TIMEOUT)
        .open()
    {
        Ok(port) => port,
        Err(error) => {
            let _ =
                first_heartbeat_tx.send(Err(format!("Не удалось открыть {port_name}: {error}")));
            return;
        }
    };

    let mut writer = match port.try_clone() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = first_heartbeat_tx.send(Err(format!(
                "Не удалось подготовить канал запросов телеметрии на {port_name}: {error}"
            )));
            return;
        }
    };
    let mut reader = PeekReader::new(DeadlineReader::new(BufReader::new(port)));
    let started_at = Instant::now();
    let mut first_heartbeat_tx = Some(first_heartbeat_tx);
    let mut last_heartbeat: Option<Instant> = None;
    let mut last_telemetry_emit = Instant::now();
    let mut last_parameter_emit = Instant::now() - Duration::from_secs(1);
    let mut last_emitted_write_status = ParameterWriteStatus::default();
    let mut telemetry = TelemetrySnapshot::default();
    let mut read_error_count = 0_u32;
    let mut telemetry_requested = false;
    let mut outbound_sequence = 0_u8;
    let mut parameters = BTreeMap::<u16, ParameterValue>::new();
    let mut parameter_types = HashMap::<String, MavParamType>::new();
    let mut write_queue = VecDeque::<ParameterWriteRequest>::new();
    let mut awaiting_write: Option<(ParameterWriteRequest, Instant, u8)> = None;
    let mut target = None;
    let mut pending_parameter_read: Option<PendingParameterRead> = None;
    let mut active_rc_pulse: Option<ActiveRcPulse> = None;

    while !stop.load(Ordering::Relaxed) {
        while let Ok(command) = commands.try_recv() {
            match command {
                WorkerCommand::RequestParameters => {
                    if let Err(error) =
                        request_parameter_list(&mut writer, 1, 1, &mut outbound_sequence)
                    {
                        eprintln!("Failed to request parameters on {port_name}: {error}");
                    } else {
                        parameters.clear();
                        let snapshot = latest_parameters.lock().clone();
                        let _ = app.emit(
                            "flight-controller-event",
                            ControllerEvent::Parameters { snapshot },
                        );
                    }
                }
                WorkerCommand::ReadParameter { name, reply } => {
                    if pending_parameter_read.is_some() {
                        let _ =
                            reply.send(Err("Уже выполняется чтение другого параметра".to_owned()));
                    } else if let Some((target_system, target_component)) = target {
                        match request_parameter(
                            &mut writer,
                            target_system,
                            target_component,
                            &name,
                            &mut outbound_sequence,
                        ) {
                            Ok(()) => {
                                pending_parameter_read = Some(PendingParameterRead {
                                    name,
                                    reply,
                                    started_at: Instant::now(),
                                })
                            }
                            Err(error) => {
                                let _ = reply.send(Err(error));
                            }
                        }
                    } else {
                        let _ = reply.send(Err("Целевой контроллер ещё не определён".to_owned()));
                    }
                }
                WorkerCommand::WriteParameters(requests) => {
                    write_queue = requests.into();
                    awaiting_write = None;
                    *parameter_write_status.lock() = ParameterWriteStatus {
                        active: true,
                        total: write_queue.len(),
                        ..ParameterWriteStatus::default()
                    };
                }
                WorkerCommand::StartRcPulse {
                    channel,
                    pwm,
                    minimum_pwm,
                    duration,
                    reply,
                } => {
                    eprintln!(
                        "Motor RC override start: channel={channel}, pwm={pwm}, minimum={minimum_pwm}, duration_ms={}",
                        duration.as_millis()
                    );
                    let result = target
                        .ok_or_else(|| "Целевой контроллер ещё не определён".to_owned())
                        .and_then(|target| {
                            send_rc_override(
                                &mut writer,
                                target,
                                channel,
                                pwm,
                                &mut outbound_sequence,
                            )
                        });
                    if result.is_ok() {
                        active_rc_pulse = Some(ActiveRcPulse {
                            channel,
                            pwm,
                            minimum_pwm,
                            deadline: Instant::now() + duration,
                            last_sent: Instant::now(),
                        });
                    }
                    let _ = reply.send(result);
                }
                WorkerCommand::EmergencyStop { reply } => {
                    eprintln!("Motor emergency stop: minimum override, release and DISARM");
                    let stop_result = stop_rc_override(
                        &mut writer,
                        target,
                        active_rc_pulse.take(),
                        &mut outbound_sequence,
                    );
                    let disarm_result = target
                        .ok_or_else(|| "Целевой контроллер ещё не определён".to_owned())
                        .and_then(|target| {
                            for _ in 0..3 {
                                send_arm_disarm(
                                    &mut writer,
                                    target,
                                    false,
                                    true,
                                    &mut outbound_sequence,
                                )?;
                            }
                            Ok(())
                        });
                    let _ = reply.send(stop_result.and(disarm_result));
                }
                WorkerCommand::SetArmed {
                    armed,
                    force,
                    reply,
                } => {
                    let result = target
                        .ok_or_else(|| "Целевой контроллер ещё не определён".to_owned())
                        .and_then(|target| {
                            send_arm_disarm(
                                &mut writer,
                                target,
                                armed,
                                force,
                                &mut outbound_sequence,
                            )
                        });
                    let _ = reply.send(result);
                }
            }
        }

        if active_rc_pulse
            .as_ref()
            .is_some_and(|pulse| Instant::now() >= pulse.deadline)
        {
            let _ = stop_rc_override(
                &mut writer,
                target,
                active_rc_pulse.take(),
                &mut outbound_sequence,
            );
        } else if let (Some(target), Some(pulse)) = (target, active_rc_pulse.as_mut())
            && pulse.last_sent.elapsed() >= Duration::from_millis(250)
        {
            if send_rc_override(
                &mut writer,
                target,
                pulse.channel,
                pulse.pwm,
                &mut outbound_sequence,
            )
            .is_err()
            {
                let _ = stop_rc_override(
                    &mut writer,
                    Some(target),
                    active_rc_pulse.take(),
                    &mut outbound_sequence,
                );
            } else {
                pulse.last_sent = Instant::now();
            }
        }

        process_parameter_write(
            &mut writer,
            &mut outbound_sequence,
            target,
            &parameter_types,
            &mut write_queue,
            &mut awaiting_write,
            &parameter_write_status,
        );

        reader.reader_mut().reset_deadline();
        match mavlink::read_any_msg::<MavMessage, _>(&mut reader) {
            Ok((header, message)) => {
                read_error_count = 0;
                telemetry.message_count += 1;
                update_telemetry(&mut telemetry, &message);
                if let MavMessage::PARAM_VALUE(data) = &message {
                    let parameter_name = data.param_id.to_str().unwrap_or("").to_owned();
                    let parameter = ParameterValue {
                        name: parameter_name.clone(),
                        value: data.param_value,
                        parameter_type: format!("{:?}", data.param_type),
                        index: data.param_index,
                    };
                    parameter_types.insert(parameter_name.clone(), data.param_type);
                    let write_confirmed = awaiting_write
                        .as_ref()
                        .is_some_and(|(request, _, _)| request.name == parameter_name);
                    let parameter = upsert_parameter_by_name(&mut parameters, parameter);
                    if pending_parameter_read
                        .as_ref()
                        .is_some_and(|pending| pending.name == parameter_name)
                        && let Some(pending) = pending_parameter_read.take()
                    {
                        let _ = pending.reply.send(Ok(parameter.clone()));
                    }
                    if write_confirmed {
                        awaiting_write = None;
                        let mut status = parameter_write_status.lock();
                        status.completed += 1;
                        status.current_name = None;
                        status.active = status.completed + status.failed < status.total;
                    }
                    let refresh_received_count = parameters.len();
                    let refresh_complete = refresh_received_count >= usize::from(data.param_count);
                    let snapshot_for_event = {
                        let mut snapshot = latest_parameters.lock();

                        // PARAM_SET is acknowledged with PARAM_VALUE. Apply that confirmed
                        // value directly to the cached list instead of requesting all
                        // parameters again after a point update.
                        if write_confirmed
                            && let Some(cached) = snapshot
                                .items
                                .iter_mut()
                                .find(|item| item.name == parameter_name)
                        {
                            *cached = parameter.clone();
                        }

                        // Keep the previous complete list visible while a refresh is in progress.
                        // During the first load there is no cache, so partial results are useful.
                        if snapshot.items.is_empty() || refresh_complete {
                            snapshot.items = parameters.values().cloned().collect();
                            snapshot.received_count = refresh_received_count;
                        }
                        snapshot.refresh_received_count = refresh_received_count;
                        snapshot.total_count = data.param_count;
                        snapshot.complete = refresh_complete;
                        snapshot.loading = !refresh_complete;

                        (write_confirmed
                            || refresh_complete
                            || last_parameter_emit.elapsed() >= Duration::from_millis(100))
                        .then(|| snapshot.clone())
                    };
                    if let Some(snapshot) = snapshot_for_event {
                        let _ = app.emit(
                            "flight-controller-event",
                            ControllerEvent::Parameters { snapshot },
                        );
                        last_parameter_emit = Instant::now();
                    }
                }
                *latest_telemetry.lock() = Some(telemetry.clone());

                if let MavMessage::HEARTBEAT(heartbeat) = message
                    && heartbeat.autopilot != MavAutopilot::MAV_AUTOPILOT_INVALID
                {
                    let info = HeartbeatInfo {
                        port_name: port_name.clone(),
                        baud_rate,
                        system_id: header.system_id,
                        component_id: header.component_id,
                        vehicle_type: format!("{:?}", heartbeat.mavtype),
                        autopilot: format!("{:?}", heartbeat.autopilot),
                        system_status: format!("{:?}", heartbeat.system_status),
                        mavlink_version: heartbeat.mavlink_version,
                    };
                    last_heartbeat = Some(Instant::now());
                    target = Some((header.system_id, header.component_id));
                    if let Some(sender) = first_heartbeat_tx.take() {
                        eprintln!(
                            "MAVLink connected on {port_name}: system={}, component={}",
                            header.system_id, header.component_id
                        );
                        let _ = sender.send(Ok(info.clone()));
                    }

                    if !telemetry_requested {
                        telemetry_requested = request_telemetry_messages(
                            &mut writer,
                            header.system_id,
                            header.component_id,
                            &mut outbound_sequence,
                            &port_name,
                        );
                    }

                    if let Err(error) = app.emit(
                        "flight-controller-event",
                        ControllerEvent::Heartbeat { heartbeat: info },
                    ) {
                        eprintln!("Failed to emit heartbeat event: {error}");
                    }
                }

                if last_telemetry_emit.elapsed() >= TELEMETRY_EMIT_INTERVAL {
                    if let Err(error) = app.emit(
                        "flight-controller-event",
                        ControllerEvent::Telemetry {
                            telemetry: telemetry.clone(),
                        },
                    ) {
                        eprintln!("Failed to emit telemetry event: {error}");
                    }
                    last_telemetry_emit = Instant::now();
                }
            }
            Err(MessageReadError::Io(error)) if error.kind() == std::io::ErrorKind::TimedOut => {
                // A short serial timeout is expected while no complete MAVLink
                // packet is available. The loop must wake up periodically to
                // process commands and detect a lost heartbeat.
            }
            Err(error) => {
                read_error_count += 1;
                if read_error_count <= 3 {
                    eprintln!("MAVLink read error on {port_name}: {error:?}");
                }
                thread::sleep(Duration::from_millis(5));
            }
        }

        let current_write_status = parameter_write_status.lock().clone();
        if current_write_status != last_emitted_write_status {
            let _ = app.emit(
                "flight-controller-event",
                ControllerEvent::ParameterWriteStatus {
                    status: current_write_status.clone(),
                },
            );
            last_emitted_write_status = current_write_status;
        }

        if pending_parameter_read
            .as_ref()
            .is_some_and(|pending| pending.started_at.elapsed() >= Duration::from_secs(3))
            && let Some(pending) = pending_parameter_read.take()
        {
            let _ = pending.reply.send(Err(format!(
                "Контроллер не ответил на запрос параметра {}",
                pending.name
            )));
        }

        if first_heartbeat_tx.is_some() && started_at.elapsed() >= HEARTBEAT_TIMEOUT {
            if let Some(sender) = first_heartbeat_tx.take() {
                let _ = sender.send(Err(format!(
                    "На {port_name} не получен MAVLink heartbeat за {} с",
                    HEARTBEAT_TIMEOUT.as_secs()
                )));
            }
            break;
        }

        if last_heartbeat.is_some_and(|instant| instant.elapsed() >= HEARTBEAT_LOSS_TIMEOUT) {
            eprintln!("MAVLink heartbeat lost on {port_name}");
            let reason = "Потерян MAVLink heartbeat".to_owned();
            let _ = app.emit(
                "flight-controller-event",
                ControllerEvent::Disconnected {
                    reason: reason.clone(),
                    expected: false,
                },
            );
            break;
        }
    }

    let _ = stop_rc_override(
        &mut writer,
        target,
        active_rc_pulse.take(),
        &mut outbound_sequence,
    );

    if stop.load(Ordering::Relaxed) {
        let _ = app.emit(
            "flight-controller-event",
            ControllerEvent::Disconnected {
                reason: "Соединение закрыто пользователем".to_owned(),
                expected: true,
            },
        );
    }
}

fn upsert_parameter_by_name(
    parameters: &mut BTreeMap<u16, ParameterValue>,
    mut parameter: ParameterValue,
) -> ParameterValue {
    // A PARAM_SET acknowledgement may carry a service index (often u16::MAX)
    // instead of the index used in PARAM_REQUEST_LIST. Parameter names are the
    // stable identity, so preserve the known index and remove stale duplicates.
    let index = parameters
        .iter()
        .find_map(|(index, current)| (current.name == parameter.name).then_some(*index))
        .unwrap_or(parameter.index);
    parameters
        .retain(|current_index, current| current.name != parameter.name || *current_index == index);
    parameter.index = index;
    parameters.insert(index, parameter.clone());
    parameter
}

fn request_parameter_list(
    writer: &mut Box<dyn serialport::SerialPort>,
    target_system: u8,
    target_component: u8,
    sequence: &mut u8,
) -> Result<(), String> {
    let request = MavMessage::PARAM_REQUEST_LIST(PARAM_REQUEST_LIST_DATA {
        target_system,
        target_component,
    });
    let header = MavHeader {
        system_id: 255,
        component_id: 190,
        sequence: *sequence,
    };
    mavlink::write_v2_msg(writer, header, &request)
        .map_err(|error| format!("Не удалось отправить PARAM_REQUEST_LIST: {error}"))?;
    *sequence = sequence.wrapping_add(1);
    Ok(())
}

fn request_parameter(
    writer: &mut Box<dyn serialport::SerialPort>,
    target_system: u8,
    target_component: u8,
    name: &str,
    sequence: &mut u8,
) -> Result<(), String> {
    let request = MavMessage::PARAM_REQUEST_READ(PARAM_REQUEST_READ_DATA {
        param_index: -1,
        target_system,
        target_component,
        param_id: name.into(),
    });
    let header = MavHeader {
        system_id: 255,
        component_id: 190,
        sequence: *sequence,
    };
    mavlink::write_v2_msg(writer, header, &request)
        .map_err(|error| format!("Не удалось запросить параметр {name}: {error}"))?;
    *sequence = sequence.wrapping_add(1);
    Ok(())
}

fn process_parameter_write(
    writer: &mut Box<dyn serialport::SerialPort>,
    sequence: &mut u8,
    target: Option<(u8, u8)>,
    parameter_types: &HashMap<String, MavParamType>,
    queue: &mut VecDeque<ParameterWriteRequest>,
    awaiting: &mut Option<(ParameterWriteRequest, Instant, u8)>,
    shared_status: &Arc<Mutex<ParameterWriteStatus>>,
) {
    let Some((target_system, target_component)) = target else {
        return;
    };

    if let Some((request, sent_at, attempts)) = awaiting.as_mut() {
        if sent_at.elapsed() < Duration::from_millis(900) {
            return;
        }
        if *attempts >= 3 {
            let failed_name = request.name.clone();
            *awaiting = None;
            let mut status = shared_status.lock();
            status.failed += 1;
            status.last_error = Some(format!("Контроллер не подтвердил {failed_name}"));
            status.current_name = None;
            status.active = status.completed + status.failed < status.total;
            return;
        }
        if let Some(parameter_type) = parameter_types.get(&request.name).copied()
            && send_parameter_set(
                writer,
                sequence,
                target_system,
                target_component,
                request,
                parameter_type,
            )
            .is_ok()
        {
            *sent_at = Instant::now();
            *attempts += 1;
        }
        return;
    }

    let Some(request) = queue.pop_front() else {
        let mut status = shared_status.lock();
        if status.completed + status.failed >= status.total {
            status.active = false;
        }
        return;
    };
    let Some(parameter_type) = parameter_types.get(&request.name).copied() else {
        let mut status = shared_status.lock();
        status.failed += 1;
        status.last_error = Some(format!("Неизвестен MAVLink-тип {}", request.name));
        return;
    };
    match send_parameter_set(
        writer,
        sequence,
        target_system,
        target_component,
        &request,
        parameter_type,
    ) {
        Ok(()) => {
            shared_status.lock().current_name = Some(request.name.clone());
            *awaiting = Some((request, Instant::now(), 1));
        }
        Err(error) => {
            let mut status = shared_status.lock();
            status.failed += 1;
            status.last_error = Some(error);
        }
    }
}

fn send_parameter_set(
    writer: &mut Box<dyn serialport::SerialPort>,
    sequence: &mut u8,
    target_system: u8,
    target_component: u8,
    request: &ParameterWriteRequest,
    parameter_type: MavParamType,
) -> Result<(), String> {
    let message = MavMessage::PARAM_SET(PARAM_SET_DATA {
        param_value: request.value,
        target_system,
        target_component,
        param_id: request.name.as_str().into(),
        param_type: parameter_type,
    });
    let header = MavHeader {
        system_id: 255,
        component_id: 190,
        sequence: *sequence,
    };
    mavlink::write_v2_msg(writer, header, &message)
        .map_err(|error| format!("Не удалось записать {}: {error}", request.name))?;
    *sequence = sequence.wrapping_add(1);
    Ok(())
}

fn request_telemetry_messages(
    writer: &mut Box<dyn serialport::SerialPort>,
    target_system: u8,
    target_component: u8,
    sequence: &mut u8,
    port_name: &str,
) -> bool {
    // SYS_STATUS, GPS_RAW_INT, ATTITUDE, SERVO_OUTPUT_RAW, RC_CHANNELS and BATTERY_STATUS.
    let requests = [
        (1_u32, 500_000_u32),
        (24, 500_000),
        (30, 200_000),
        (36, 100_000),
        (65, 200_000),
        (147, 500_000),
    ];

    for (message_id, interval_us) in requests {
        let command = MavMessage::COMMAND_LONG(COMMAND_LONG_DATA {
            param1: message_id as f32,
            param2: interval_us as f32,
            param3: 0.0,
            param4: 0.0,
            param5: 0.0,
            param6: 0.0,
            param7: 0.0,
            command: MavCmd::MAV_CMD_SET_MESSAGE_INTERVAL,
            target_system,
            target_component,
            confirmation: 0,
        });
        let header = MavHeader {
            system_id: 255,
            component_id: 190,
            sequence: *sequence,
        };

        if let Err(error) = mavlink::write_v2_msg(writer, header, &command) {
            eprintln!("Failed to request MAVLink message {message_id} on {port_name}: {error}");
            return false;
        }
        *sequence = sequence.wrapping_add(1);
    }

    eprintln!("Requested MAVLink telemetry messages on {port_name}");
    true
}

fn send_rc_override(
    writer: &mut Box<dyn serialport::SerialPort>,
    target: (u8, u8),
    channel: u8,
    value: u16,
    sequence: &mut u8,
) -> Result<(), String> {
    let mut channels = [u16::MAX; 8];
    channels[usize::from(channel - 1)] = value;
    let message = MavMessage::RC_CHANNELS_OVERRIDE(RC_CHANNELS_OVERRIDE_DATA {
        target_system: target.0,
        target_component: target.1,
        chan1_raw: channels[0],
        chan2_raw: channels[1],
        chan3_raw: channels[2],
        chan4_raw: channels[3],
        chan5_raw: channels[4],
        chan6_raw: channels[5],
        chan7_raw: channels[6],
        chan8_raw: channels[7],
    });
    let header = MavHeader {
        system_id: 255,
        component_id: 190,
        sequence: *sequence,
    };
    mavlink::write_v2_msg(writer, header, &message)
        .map_err(|error| format!("Не удалось отправить RC override: {error}"))?;
    *sequence = sequence.wrapping_add(1);
    Ok(())
}

fn send_arm_disarm(
    writer: &mut Box<dyn serialport::SerialPort>,
    target: (u8, u8),
    armed: bool,
    force: bool,
    sequence: &mut u8,
) -> Result<(), String> {
    let message = MavMessage::COMMAND_LONG(COMMAND_LONG_DATA {
        param1: if armed { 1.0 } else { 0.0 },
        param2: if force { 21_196.0 } else { 0.0 },
        param3: 0.0,
        param4: 0.0,
        param5: 0.0,
        param6: 0.0,
        param7: 0.0,
        command: MavCmd::MAV_CMD_COMPONENT_ARM_DISARM,
        target_system: target.0,
        target_component: target.1,
        confirmation: 0,
    });
    let header = MavHeader {
        system_id: 255,
        component_id: 190,
        sequence: *sequence,
    };
    mavlink::write_v2_msg(writer, header, &message)
        .map_err(|error| format!("Не удалось отправить команду ARM/DISARM: {error}"))?;
    *sequence = sequence.wrapping_add(1);
    Ok(())
}

fn stop_rc_override(
    writer: &mut Box<dyn serialport::SerialPort>,
    target: Option<(u8, u8)>,
    pulse: Option<ActiveRcPulse>,
    sequence: &mut u8,
) -> Result<(), String> {
    let (Some(target), Some(pulse)) = (target, pulse) else {
        return Ok(());
    };
    for _ in 0..3 {
        send_rc_override(writer, target, pulse.channel, pulse.minimum_pwm, sequence)?;
    }
    send_rc_override(writer, target, pulse.channel, 0, sequence)
}

fn update_telemetry(snapshot: &mut TelemetrySnapshot, message: &MavMessage) {
    match message {
        MavMessage::HEARTBEAT(data) => {
            snapshot.armed = Some(
                data.base_mode
                    .contains(MavModeFlag::MAV_MODE_FLAG_SAFETY_ARMED),
            );
            snapshot.custom_mode = Some(data.custom_mode);
            snapshot.system_status = Some(format!("{:?}", data.system_status));
        }
        MavMessage::SYS_STATUS(data) => {
            snapshot.cpu_load_percent = Some(f32::from(data.load) / 10.0);
            snapshot.battery_voltage_v = (data.voltage_battery != u16::MAX)
                .then(|| f32::from(data.voltage_battery) / 1000.0);
            snapshot.battery_current_a =
                (data.current_battery >= 0).then(|| f32::from(data.current_battery) / 100.0);
            snapshot.battery_remaining_percent =
                (data.battery_remaining >= 0).then_some(data.battery_remaining);
        }
        MavMessage::BATTERY_STATUS(data) => {
            snapshot.battery_current_a =
                (data.current_battery >= 0).then(|| f32::from(data.current_battery) / 100.0);
            snapshot.battery_remaining_percent =
                (data.battery_remaining >= 0).then_some(data.battery_remaining);
        }
        MavMessage::ATTITUDE(data) => {
            snapshot.roll_rad = Some(data.roll);
            snapshot.pitch_rad = Some(data.pitch);
            snapshot.yaw_rad = Some(data.yaw);
        }
        MavMessage::SERVO_OUTPUT_RAW(data) => {
            snapshot.servo1_output_pwm = Some(data.servo1_raw);
        }
        MavMessage::GPS_RAW_INT(data) => {
            snapshot.gps_fix = Some(format!("{:?}", data.fix_type));
            snapshot.satellites_visible =
                (data.satellites_visible != u8::MAX).then_some(data.satellites_visible);
        }
        MavMessage::STATUSTEXT(data) => {
            let text = data.text.to_str().unwrap_or("").trim().to_owned();
            if !text.is_empty() {
                snapshot.status_text = Some(text);
            }
        }
        MavMessage::RC_CHANNELS(data) => {
            snapshot.rc_channels = Some([
                data.chan1_raw,
                data.chan2_raw,
                data.chan3_raw,
                data.chan4_raw,
                data.chan5_raw,
                data.chan6_raw,
                data.chan7_raw,
                data.chan8_raw,
                data.chan9_raw,
                data.chan10_raw,
                data.chan11_raw,
                data.chan12_raw,
                data.chan13_raw,
                data.chan14_raw,
                data.chan15_raw,
                data.chan16_raw,
                data.chan17_raw,
                data.chan18_raw,
            ]);
            snapshot.rc_channel_count = Some(data.chancount);
            snapshot.rc_rssi = (data.rssi != u8::MAX).then_some(data.rssi);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::io::BufReader;
    use std::time::{Duration, Instant};

    use mavlink::dialects::ardupilotmega::MavMessage;
    use mavlink::peek_reader::PeekReader;

    use super::{
        DeadlineReader, ParameterValue, ParameterWriteRequest, READ_TIMEOUT, SerialPortDescriptor,
        SerialPortInfo, SerialPortType, request_parameter_list, request_telemetry_messages,
        send_parameter_set, upsert_parameter_by_name, wait_for_heartbeat,
    };

    #[test]
    fn converts_unknown_serial_port() {
        let descriptor = SerialPortDescriptor::from(SerialPortInfo {
            port_name: "test-port".to_owned(),
            port_type: SerialPortType::Unknown,
        });

        assert_eq!(descriptor.name, "test-port");
        assert_eq!(descriptor.kind, "unknown");
    }

    #[test]
    fn parameter_ack_replaces_cached_value_by_name() {
        let mut parameters = BTreeMap::from([(
            42,
            ParameterValue {
                name: "TEST_PARAM".to_owned(),
                value: 1.0,
                parameter_type: "MAV_PARAM_TYPE_REAL32".to_owned(),
                index: 42,
            },
        )]);

        let confirmed = upsert_parameter_by_name(
            &mut parameters,
            ParameterValue {
                name: "TEST_PARAM".to_owned(),
                value: 2.0,
                parameter_type: "MAV_PARAM_TYPE_REAL32".to_owned(),
                index: u16::MAX,
            },
        );

        assert_eq!(parameters.len(), 1);
        assert_eq!(confirmed.index, 42);
        assert_eq!(parameters.get(&42).unwrap().value, 2.0);
    }

    #[test]
    fn mavlink_parser_times_out_on_continuous_wrong_protocol() {
        let source = std::io::repeat(b'A');
        let mut reader = PeekReader::new(DeadlineReader::new(source));
        let started_at = Instant::now();

        let result = mavlink::read_any_msg::<MavMessage, _>(&mut reader);

        assert!(result.is_err());
        assert!(started_at.elapsed() < Duration::from_secs(1));
    }

    #[test]
    #[ignore = "requires a real flight controller and UAV_TEST_SERIAL_PORT"]
    fn receives_heartbeat_from_hardware() {
        let port = std::env::var("UAV_TEST_SERIAL_PORT")
            .expect("UAV_TEST_SERIAL_PORT must contain a serial device path");
        let heartbeat = wait_for_heartbeat(port, 115_200).expect("heartbeat should be received");

        eprintln!("hardware heartbeat: {heartbeat:?}");
    }

    #[test]
    #[ignore = "requires a real non-MAVLink device and UAV_TEST_WRONG_DEVICE_PORT"]
    fn rejects_non_mavlink_hardware_without_hanging() {
        let port = std::env::var("UAV_TEST_WRONG_DEVICE_PORT")
            .expect("UAV_TEST_WRONG_DEVICE_PORT must contain a serial device path");
        let started_at = Instant::now();

        let result = wait_for_heartbeat(port, 115_200);

        assert!(result.is_err());
        assert!(started_at.elapsed() < Duration::from_secs(7));
    }

    #[test]
    #[ignore = "requires a real flight controller and UAV_TEST_SERIAL_PORT"]
    fn receives_requested_telemetry_from_hardware() {
        let port_name = std::env::var("UAV_TEST_SERIAL_PORT")
            .expect("UAV_TEST_SERIAL_PORT must contain a serial device path");
        let port = serialport::new(&port_name, 115_200)
            .timeout(READ_TIMEOUT)
            .open()
            .expect("serial port should open");
        let mut writer = port.try_clone().expect("serial port should clone");
        let mut reader = PeekReader::new(BufReader::new(port));
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut requested = false;
        let mut sequence = 0;
        let mut received = Vec::new();

        while Instant::now() < deadline {
            let Ok((header, message)) = mavlink::read_any_msg::<MavMessage, _>(&mut reader) else {
                continue;
            };

            if matches!(message, MavMessage::HEARTBEAT(_)) && !requested {
                requested = request_telemetry_messages(
                    &mut writer,
                    header.system_id,
                    header.component_id,
                    &mut sequence,
                    &port_name,
                );
            }

            let name = match message {
                MavMessage::SYS_STATUS(_) => Some("SYS_STATUS"),
                MavMessage::GPS_RAW_INT(_) => Some("GPS_RAW_INT"),
                MavMessage::ATTITUDE(_) => Some("ATTITUDE"),
                MavMessage::RC_CHANNELS(_) => Some("RC_CHANNELS"),
                MavMessage::BATTERY_STATUS(_) => Some("BATTERY_STATUS"),
                _ => None,
            };
            if let Some(name) = name
                && !received.contains(&name)
            {
                received.push(name);
            }
        }

        eprintln!("requested telemetry received: {received:?}");
        assert!(requested, "telemetry request should be sent");
        assert!(
            !received.is_empty(),
            "no requested telemetry messages received"
        );
    }

    #[test]
    #[ignore = "requires a real flight controller and UAV_TEST_SERIAL_PORT"]
    fn receives_parameter_list_from_hardware() {
        let port_name = std::env::var("UAV_TEST_SERIAL_PORT")
            .expect("UAV_TEST_SERIAL_PORT must contain a serial device path");
        let port = serialport::new(&port_name, 115_200)
            .timeout(READ_TIMEOUT)
            .open()
            .expect("serial port should open");
        let mut writer = port.try_clone().expect("serial port should clone");
        let mut reader = PeekReader::new(BufReader::new(port));
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut requested = false;
        let mut sequence = 0;
        let mut names = std::collections::BTreeSet::new();
        let mut expected = 0_u16;

        while Instant::now() < deadline {
            let Ok((header, message)) = mavlink::read_any_msg::<MavMessage, _>(&mut reader) else {
                continue;
            };
            if matches!(message, MavMessage::HEARTBEAT(_)) && !requested {
                request_parameter_list(
                    &mut writer,
                    header.system_id,
                    header.component_id,
                    &mut sequence,
                )
                .expect("parameter request should be sent");
                requested = true;
            }
            if let MavMessage::PARAM_VALUE(data) = message {
                expected = data.param_count;
                names.insert(data.param_id.to_str().unwrap_or("").to_owned());
                if names.len() >= usize::from(expected) {
                    break;
                }
            }
        }

        eprintln!("parameters received: {}/{}", names.len(), expected);
        assert!(expected > 0, "controller did not report parameter count");
        assert_eq!(names.len(), usize::from(expected));
        assert!(names.iter().all(|name| !name.is_empty()));
    }

    #[test]
    #[ignore = "writes and restores GCS_PID_MASK on real hardware"]
    fn writes_and_restores_parameter_on_hardware() {
        let port_name = std::env::var("UAV_TEST_SERIAL_PORT")
            .expect("UAV_TEST_SERIAL_PORT must contain a serial device path");
        let port = serialport::new(&port_name, 115_200)
            .timeout(READ_TIMEOUT)
            .open()
            .expect("serial port should open");
        let mut writer = port.try_clone().expect("serial port should clone");
        let mut reader = PeekReader::new(BufReader::new(port));
        let mut sequence = 0;
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut target = None;
        let mut original = None;

        while Instant::now() < deadline && original.is_none() {
            let Ok((header, message)) = mavlink::read_any_msg::<MavMessage, _>(&mut reader) else {
                continue;
            };
            if matches!(message, MavMessage::HEARTBEAT(_)) && target.is_none() {
                target = Some((header.system_id, header.component_id));
                request_parameter_list(
                    &mut writer,
                    header.system_id,
                    header.component_id,
                    &mut sequence,
                )
                .expect("parameter request should be sent");
            }
            if let MavMessage::PARAM_VALUE(data) = message
                && data.param_id.to_str().unwrap_or("") == "GCS_PID_MASK"
            {
                original = Some((data.param_value, data.param_type));
            }
        }

        let (target_system, target_component) = target.expect("heartbeat should be received");
        let (original_value, parameter_type) = original.expect("GCS_PID_MASK should be received");
        let changed_value = if original_value.abs() < 0.5 { 1.0 } else { 0.0 };
        let changed = ParameterWriteRequest {
            name: "GCS_PID_MASK".to_owned(),
            value: changed_value,
        };
        send_parameter_set(
            &mut writer,
            &mut sequence,
            target_system,
            target_component,
            &changed,
            parameter_type,
        )
        .expect("changed value should be sent");

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut confirmed_changed = false;
        while Instant::now() < deadline {
            let Ok((_, message)) = mavlink::read_any_msg::<MavMessage, _>(&mut reader) else {
                continue;
            };
            if let MavMessage::PARAM_VALUE(data) = message
                && data.param_id.to_str().unwrap_or("") == "GCS_PID_MASK"
                && (data.param_value - changed_value).abs() < 0.001
            {
                confirmed_changed = true;
                break;
            }
        }

        let restore = ParameterWriteRequest {
            name: "GCS_PID_MASK".to_owned(),
            value: original_value,
        };
        send_parameter_set(
            &mut writer,
            &mut sequence,
            target_system,
            target_component,
            &restore,
            parameter_type,
        )
        .expect("original value should be restored");

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut confirmed_restored = false;
        while Instant::now() < deadline {
            let Ok((_, message)) = mavlink::read_any_msg::<MavMessage, _>(&mut reader) else {
                continue;
            };
            if let MavMessage::PARAM_VALUE(data) = message
                && data.param_id.to_str().unwrap_or("") == "GCS_PID_MASK"
                && (data.param_value - original_value).abs() < 0.001
            {
                confirmed_restored = true;
                break;
            }
        }

        assert!(
            confirmed_changed,
            "controller did not confirm changed value"
        );
        assert!(
            confirmed_restored,
            "controller did not confirm restored value"
        );
    }
}
