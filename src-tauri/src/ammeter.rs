use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const BAUD_RATE: u32 = 9_600;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);
const DATA_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmmeterSnapshot {
    pub port_name: String,
    pub protocol: &'static str,
    pub baud_rate: u32,
    pub current_amps: f32,
    pub sensor_voltage: f32,
    pub message_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AmmeterEvent {
    Measurement { snapshot: AmmeterSnapshot },
    Disconnected { reason: String },
}

struct AmmeterSession {
    stop: Arc<AtomicBool>,
    worker: JoinHandle<()>,
}

#[derive(Default)]
pub struct AmmeterManager {
    session: Mutex<Option<AmmeterSession>>,
    latest: Arc<Mutex<Option<AmmeterSnapshot>>>,
}

impl AmmeterManager {
    pub fn snapshot(&self) -> Option<AmmeterSnapshot> {
        self.latest.lock().clone()
    }

    pub fn connect(&self, app: AppHandle, port_name: String) -> Result<AmmeterSnapshot, String> {
        self.disconnect();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let latest = Arc::clone(&self.latest);
        let (identified_tx, identified_rx) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            run_session(app, port_name, worker_stop, latest, identified_tx);
        });
        *self.session.lock() = Some(AmmeterSession { stop, worker });

        match identified_rx.recv_timeout(CONNECT_TIMEOUT + Duration::from_secs(1)) {
            Ok(Ok(snapshot)) => Ok(snapshot),
            Ok(Err(error)) => {
                self.disconnect();
                Err(error)
            }
            Err(_) => {
                self.disconnect();
                Err("Амперметр не ответил: ожидались PONG и DATA:<amps>:<volts>".to_owned())
            }
        }
    }

    pub fn disconnect(&self) {
        let session = self.session.lock().take();
        if let Some(session) = session {
            session.stop.store(true, Ordering::Relaxed);
            let _ = session.worker.join();
        }
        *self.latest.lock() = None;
    }
}

fn run_session(
    app: AppHandle,
    port_name: String,
    stop: Arc<AtomicBool>,
    latest: Arc<Mutex<Option<AmmeterSnapshot>>>,
    identified_tx: mpsc::SyncSender<Result<AmmeterSnapshot, String>>,
) {
    let port = match serialport::new(&port_name, BAUD_RATE)
        .timeout(Duration::from_millis(250))
        .open()
    {
        Ok(port) => port,
        Err(error) => {
            let _ = identified_tx.send(Err(format!(
                "Не удалось открыть порт амперметра {port_name}: {error}"
            )));
            return;
        }
    };
    let mut writer = match port.try_clone() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = identified_tx.send(Err(format!(
                "Не удалось подготовить порт амперметра {port_name}: {error}"
            )));
            return;
        }
    };
    let mut reader = BufReader::new(port);
    let started_at = Instant::now();
    let mut last_ping = Instant::now() - Duration::from_secs(1);
    let mut saw_pong = false;
    let mut first_data = None;
    let mut identified = false;
    let mut last_data = Instant::now();
    let mut message_count = 0;

    while !stop.load(Ordering::Relaxed) {
        if !identified && last_ping.elapsed() >= Duration::from_millis(500) {
            let _ = writer.write_all(b"PING\n");
            let _ = writer.flush();
            last_ping = Instant::now();
        }

        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => {}
            Ok(_) => {
                let line = line.trim();
                if line == "PONG" {
                    saw_pong = true;
                }
                if let Some((current_amps, sensor_voltage)) = parse_data_line(line) {
                    first_data = Some((current_amps, sensor_voltage));
                    last_data = Instant::now();
                    message_count += 1;

                    if identified {
                        let snapshot = AmmeterSnapshot {
                            port_name: port_name.clone(),
                            protocol: "ammeter-ascii-v1",
                            baud_rate: BAUD_RATE,
                            current_amps,
                            sensor_voltage,
                            message_count,
                        };
                        *latest.lock() = Some(snapshot.clone());
                        let _ = app.emit("ammeter-event", AmmeterEvent::Measurement { snapshot });
                    }
                }

                if !identified
                    && saw_pong
                    && let Some((current_amps, sensor_voltage)) = first_data
                {
                    let snapshot = AmmeterSnapshot {
                        port_name: port_name.clone(),
                        protocol: "ammeter-ascii-v1",
                        baud_rate: BAUD_RATE,
                        current_amps,
                        sensor_voltage,
                        message_count,
                    };
                    *latest.lock() = Some(snapshot.clone());
                    let _ = identified_tx.send(Ok(snapshot.clone()));
                    let _ = app.emit("ammeter-event", AmmeterEvent::Measurement { snapshot });
                    identified = true;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => {
                let reason = format!("Ошибка чтения амперметра: {error}");
                if !identified {
                    let _ = identified_tx.send(Err(reason));
                } else {
                    let _ = app.emit("ammeter-event", AmmeterEvent::Disconnected { reason });
                }
                return;
            }
        }

        if !identified && started_at.elapsed() >= CONNECT_TIMEOUT {
            let _ = identified_tx.send(Err(format!(
                "Порт {port_name} не соответствует протоколу амперметра: ожидались PONG и DATA:<amps>:<volts> на 9600 бод"
            )));
            return;
        }
        if identified && last_data.elapsed() >= DATA_TIMEOUT {
            let _ = app.emit(
                "ammeter-event",
                AmmeterEvent::Disconnected {
                    reason: "Амперметр перестал передавать DATA".to_owned(),
                },
            );
            return;
        }
    }
}

fn parse_data_line(line: &str) -> Option<(f32, f32)> {
    let mut fields = line.split(':');
    if fields.next()? != "DATA" {
        return None;
    }
    let amps = fields.next()?.trim().parse::<f32>().ok()?;
    let volts = fields.next()?.trim().parse::<f32>().ok()?;
    if fields.next().is_some() || !amps.is_finite() || !volts.is_finite() {
        return None;
    }
    Some((amps, volts))
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};
    use std::time::{Duration, Instant};

    use super::parse_data_line;

    #[test]
    fn parses_firmware_data_line() {
        assert_eq!(parse_data_line("DATA:12.345:0.247"), Some((12.345, 0.247)));
    }

    #[test]
    fn rejects_other_serial_protocols() {
        assert_eq!(parse_data_line("HEARTBEAT:1:1"), None);
        assert_eq!(parse_data_line("DATA:broken:0.1"), None);
        assert_eq!(parse_data_line("DATA:1:2:3"), None);
    }

    #[test]
    #[ignore = "requires a real ammeter and UAV_TEST_AMMETER_PORT"]
    fn identifies_ammeter_hardware() {
        let port_name = std::env::var("UAV_TEST_AMMETER_PORT")
            .expect("UAV_TEST_AMMETER_PORT must contain a serial device path");
        let port = serialport::new(&port_name, 9_600)
            .timeout(Duration::from_millis(250))
            .open()
            .expect("ammeter port should open");
        let mut writer = port.try_clone().expect("ammeter port should clone");
        let mut reader = BufReader::new(port);
        let deadline = Instant::now() + Duration::from_secs(6);
        let mut last_ping = Instant::now() - Duration::from_secs(1);
        let mut saw_pong = false;
        let mut saw_data = false;

        while Instant::now() < deadline && !(saw_pong && saw_data) {
            if last_ping.elapsed() >= Duration::from_millis(500) {
                writer.write_all(b"PING\n").expect("PING should be sent");
                writer.flush().expect("PING should be flushed");
                last_ping = Instant::now();
            }
            let mut line = String::new();
            if reader.read_line(&mut line).is_ok() {
                let line = line.trim();
                saw_pong |= line == "PONG";
                saw_data |= parse_data_line(line).is_some();
            }
        }

        assert!(saw_pong, "device did not answer PONG");
        assert!(saw_data, "device did not provide a valid DATA line");
    }

    #[test]
    #[ignore = "requires a non-ammeter serial device and UAV_TEST_WRONG_DEVICE_PORT"]
    fn rejects_non_ammeter_hardware() {
        let port_name = std::env::var("UAV_TEST_WRONG_DEVICE_PORT")
            .expect("UAV_TEST_WRONG_DEVICE_PORT must contain a serial device path");
        let port = serialport::new(&port_name, 9_600)
            .timeout(Duration::from_millis(250))
            .open()
            .expect("serial port should open");
        let mut writer = port.try_clone().expect("serial port should clone");
        let mut reader = BufReader::new(port);
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut saw_pong = false;
        let mut saw_data = false;
        writer.write_all(b"PING\n").expect("PING should be sent");
        writer.flush().expect("PING should be flushed");

        while Instant::now() < deadline {
            let mut line = String::new();
            if reader.read_line(&mut line).is_ok() {
                let line = line.trim();
                saw_pong |= line == "PONG";
                saw_data |= parse_data_line(line).is_some();
            }
        }

        assert!(
            !(saw_pong && saw_data),
            "non-ammeter unexpectedly matched the ammeter protocol"
        );
    }
}
