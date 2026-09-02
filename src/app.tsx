import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "preact/hooks";

type Tab = {
  id: string;
  label: string;
  available: boolean;
  unavailableReason?: string;
};

type SerialPortDescriptor = {
  name: string;
  kind: "usb" | "bluetooth" | "pci" | "unknown";
  product?: string;
};

type HeartbeatInfo = {
  portName: string;
  baudRate: number;
  systemId: number;
  componentId: number;
  vehicleType: string;
  autopilot: string;
  systemStatus: string;
  mavlinkVersion: number;
};

type TelemetrySnapshot = {
  messageCount: number;
  armed?: boolean;
  customMode?: number;
  systemStatus?: string;
  cpuLoadPercent?: number;
  batteryVoltageV?: number;
  batteryCurrentA?: number;
  batteryRemainingPercent?: number;
  rollRad?: number;
  pitchRad?: number;
  yawRad?: number;
  gpsFix?: string;
  satellitesVisible?: number;
  rcChannels?: number[];
  rcChannelCount?: number;
  rcRssi?: number;
};

type ControllerEvent =
  | { kind: "heartbeat"; heartbeat: HeartbeatInfo }
  | { kind: "telemetry"; telemetry: TelemetrySnapshot }
  | { kind: "disconnected"; reason: string; expected: boolean };

type ParameterValue = {
  name: string;
  value: number;
  parameterType: string;
  index: number;
};

type ParameterSnapshot = {
  items: ParameterValue[];
  receivedCount: number;
  refreshReceivedCount: number;
  totalCount: number;
  complete: boolean;
  loading: boolean;
};

type ParameterFileEntry = { name: string; value: number };
type ParameterDifference = ParameterFileEntry & { currentValue?: number; selected: boolean };
type ParameterWriteStatus = {
  active: boolean;
  total: number;
  completed: number;
  failed: number;
  currentName?: string;
  lastError?: string;
};

type ConnectionCardProps = {
  label: string;
  description: string;
  optional?: boolean;
};

function ConnectionCard({ label, description, optional = false }: ConnectionCardProps) {
  return (
    <article class="connection-card">
      <div class="connection-heading">
        <span class="status-dot" aria-hidden="true" />
        <div>
          <h3>{label}</h3>
          <p>{description}</p>
        </div>
      </div>
      <div class="connection-footer">
        <span class="status-label">Не подключено</span>
        <button type="button" disabled>
          {optional ? "Настроить позже" : "Подключить"}
        </button>
      </div>
    </article>
  );
}

function Metric({ label, value, unit }: { label: string; value?: string | number; unit?: string }) {
  return (
    <div class="metric">
      <span>{label}</span>
      <strong>{value ?? "Нет данных"}</strong>
      {value !== undefined && unit && <small>{unit}</small>}
    </div>
  );
}

export function App() {
  const isTauriRuntime = "__TAURI_INTERNALS__" in window;
  const [activeTab, setActiveTab] = useState("connections");
  const [ports, setPorts] = useState<SerialPortDescriptor[]>([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [heartbeat, setHeartbeat] = useState<HeartbeatInfo | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [parameters, setParameters] = useState<ParameterSnapshot | null>(null);
  const [parameterSearch, setParameterSearch] = useState("");
  const [parameterError, setParameterError] = useState<string | null>(null);
  const [comparisonFile, setComparisonFile] = useState<string | null>(null);
  const [parameterDifferences, setParameterDifferences] = useState<ParameterDifference[]>([]);
  const [stagedChanges, setStagedChanges] = useState<Record<string, number>>({});
  const [writeStatus, setWriteStatus] = useState<ParameterWriteStatus | null>(null);
  const wasWriting = useRef(false);
  const [editingParameter, setEditingParameter] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  const scanPorts = () => {
    if (!isTauriRuntime) {
      setIsScanning(false);
      return;
    }
    setIsScanning(true);
    setConnectionError(null);
    invoke<SerialPortDescriptor[]>("scan_serial_ports")
      .then((availablePorts) => {
        const hardwarePorts = availablePorts.filter(
          (port) => port.kind === "usb" || port.kind === "pci",
        );
        setPorts(hardwarePorts);
        setSelectedPort((current) =>
          hardwarePorts.some((port) => port.name === current)
            ? current
            : (hardwarePorts[0]?.name ?? ""),
        );
      })
      .catch((error: unknown) => setConnectionError(String(error)))
      .finally(() => setIsScanning(false));
  };

  useEffect(() => {
    if (!isTauriRuntime) {
      setIsScanning(false);
      return;
    }

    let unlisten: UnlistenFn | undefined;
    listen<ControllerEvent>("flight-controller-event", ({ payload }) => {
      if (payload.kind === "heartbeat") {
        setHeartbeat(payload.heartbeat);
        setConnectionError(null);
      } else if (payload.kind === "telemetry") {
        setTelemetry(payload.telemetry);
      } else {
        setHeartbeat(null);
        setTelemetry(null);
        setConnectionError(payload.expected ? null : payload.reason);
        setActiveTab("connections");
      }
    }).then((stopListening) => {
      unlisten = stopListening;
    });

    scanPorts();
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!isTauriRuntime || !heartbeat) return;

    let cancelled = false;
    const refreshTelemetry = () => {
      invoke<TelemetrySnapshot | null>("get_flight_controller_telemetry")
        .then((snapshot) => {
          if (!cancelled && snapshot) setTelemetry(snapshot);
        })
        .catch((error: unknown) => {
          if (!cancelled) setConnectionError(String(error));
        });
    };

    refreshTelemetry();
    const timer = window.setInterval(refreshTelemetry, 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [heartbeat]);

  useEffect(() => {
    if (!isTauriRuntime || !heartbeat || activeTab !== "parameters") return;

    let cancelled = false;
    setParameterError(null);
    invoke("request_flight_controller_parameters").catch((error: unknown) => {
      if (!cancelled) setParameterError(String(error));
    });

    const refreshParameters = () => {
      invoke<ParameterSnapshot>("get_flight_controller_parameters")
        .then((snapshot) => {
          if (!cancelled) setParameters(snapshot);
        })
        .catch((error: unknown) => {
          if (!cancelled) setParameterError(String(error));
        });
    };
    refreshParameters();
    const timer = window.setInterval(refreshParameters, 300);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeTab, heartbeat?.portName]);

  useEffect(() => {
    if (!isTauriRuntime || activeTab !== "parameters") return;
    const timer = window.setInterval(() => {
      invoke<ParameterWriteStatus>("get_parameter_write_status").then((status) => {
        setWriteStatus(status);
        if (status.active) wasWriting.current = true;
        if (wasWriting.current && !status.active && status.total > 0 && status.completed + status.failed >= status.total) {
          wasWriting.current = false;
          if (status.failed === 0) {
            setStagedChanges({});
          }
        }
      });
    }, 300);
    return () => window.clearInterval(timer);
  }, [activeTab]);

  const connectFlightController = () => {
    if (!selectedPort) return;
    setIsConnecting(true);
    setConnectionError(null);
    setHeartbeat(null);
    setTelemetry(null);
    invoke<HeartbeatInfo>("connect_flight_controller", {
      portName: selectedPort,
      baudRate: 115200,
    })
      .then(setHeartbeat)
      .catch((error: unknown) => setConnectionError(String(error)))
      .finally(() => setIsConnecting(false));
  };

  const disconnectFlightController = () => {
    setIsConnecting(true);
    invoke("disconnect_flight_controller")
      .catch((error: unknown) => setConnectionError(String(error)))
      .finally(() => {
        setHeartbeat(null);
        setTelemetry(null);
        setIsConnecting(false);
        setActiveTab("connections");
      });
  };

  const hasAnyConnection = heartbeat !== null;
  const tabs: Tab[] = [
    { id: "connections", label: "Подключения", available: true },
    {
      id: "tests",
      label: "Испытания",
      available: hasAnyConnection,
      unavailableReason: "Подключите хотя бы одно устройство",
    },
    {
      id: "telemetry",
      label: "Телеметрия",
      available: hasAnyConnection,
      unavailableReason: "Подключите источник телеметрии или измерений",
    },
    {
      id: "control",
      label: "Управление",
      available: false,
      unavailableReason: "Требуется управляющее соединение",
    },
    {
      id: "parameters",
      label: "Параметры",
      available: hasAnyConnection,
      unavailableReason: "Требуется подключение полётного контроллера",
    },
    { id: "scenarios", label: "Сценарии", available: true },
    { id: "results", label: "Результаты", available: true },
  ];
  const normalizedParameterSearch = parameterSearch.trim().toLowerCase();
  const parameterGroups = Object.entries(
    (parameters?.items ?? [])
      .filter((parameter) => parameter.name.toLowerCase().includes(normalizedParameterSearch))
      .reduce<Record<string, ParameterValue[]>>((groups, parameter) => {
        const prefix = parameter.name.split("_")[0].replace(/\d+$/, "") || "OTHER";
        (groups[prefix] ??= []).push(parameter);
        return groups;
      }, {}),
  ).sort(([left], [right]) => left.localeCompare(right));

  const saveParameterBackup = async () => {
    if (!parameters?.items.length) return;
    try {
      setParameterError(null);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const path = await save({
        defaultPath: `uav-parameters-${stamp}.param`,
        filters: [{ name: "Mission Planner parameters", extensions: ["param", "parm"] }],
      });
      if (!path) return;
      await invoke("save_mission_planner_parameter_file", {
        path,
        entries: parameters.items.map(({ name, value }) => ({ name, value })),
      });
    } catch (error) {
      setParameterError(String(error));
    }
  };

  const compareParameterFile = async () => {
    try {
      setParameterError(null);
      const path = await open({
        multiple: false,
        filters: [{ name: "Mission Planner parameters", extensions: ["param", "parm"] }],
      });
      if (!path || Array.isArray(path)) return;
      const entries = await invoke<ParameterFileEntry[]>("load_mission_planner_parameter_file", { path });
      const current = new Map((parameters?.items ?? []).map((item) => [item.name, item.value]));
      setParameterDifferences(entries
        .filter((entry) => current.get(entry.name) === undefined || Math.abs((current.get(entry.name) ?? 0) - entry.value) > 0.00001)
        .map((entry) => ({ ...entry, currentValue: current.get(entry.name), selected: false })));
      setComparisonFile(path.split(/[\\/]/).pop() ?? path);
    } catch (error) {
      setParameterError(String(error));
    }
  };

  const stageSelectedDifferences = () => {
    setStagedChanges((current) => {
      const next = { ...current };
      parameterDifferences.filter((item) => item.selected && item.currentValue !== undefined)
        .forEach((item) => { next[item.name] = item.value; });
      return next;
    });
    setComparisonFile(null);
    setParameterDifferences([]);
  };

  const writeStagedParameters = async () => {
    const requests = Object.entries(stagedChanges).map(([name, value]) => ({ name, value }));
    if (!requests.length) return;
    const approved = await confirm(
      `Записать ${requests.length} параметров в полётный контроллер? Каждый параметр будет проверен ответом контроллера.`,
      { title: "Подтверждение записи", kind: "warning" },
    );
    if (!approved) return;
    try {
      setParameterError(null);
      // A fast controller can acknowledge the write before the first status poll.
      // Mark the operation here so its completed state is still handled.
      wasWriting.current = true;
      await invoke("write_flight_controller_parameters", { requests });
    } catch (error) {
      wasWriting.current = false;
      setParameterError(String(error));
    }
  };

  const applyParameterEdit = (parameter: ParameterValue) => {
    const value = Number(editingValue.replace(",", "."));
    if (!Number.isFinite(value)) {
      setParameterError(`Некорректное значение для ${parameter.name}`);
      return;
    }
    setStagedChanges((current) => {
      const next = { ...current };
      if (Math.abs(value - parameter.value) <= 0.00001) delete next[parameter.name];
      else next[parameter.name] = value;
      return next;
    });
    setParameterError(null);
    setEditingParameter(null);
    setEditingValue("");
  };

  return (
    <div class="app-shell">
      <nav class="tabs" aria-label="Основные разделы">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            class={tab.id === activeTab ? "tab active" : "tab"}
            type="button"
            disabled={!tab.available}
            title={tab.available ? undefined : tab.unavailableReason}
            aria-current={tab.id === activeTab ? "page" : undefined}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
            {!tab.available && <span class="lock" aria-hidden="true">●</span>}
          </button>
        ))}
      </nav>

      <main>
        {activeTab === "connections" && (
          <>
            <section class="hero">
              <p class="eyebrow">Подготовка стенда</p>
              <h1>Подключения</h1>
              <p class="hero-copy">
                Перед запуском испытания подключите контроллер и эталонный амперметр.
                Управляющий маршрут выбирается отдельно.
              </p>
            </section>

            <section class="connection-grid" aria-label="Подключения устройств">
              <article class={heartbeat ? "connection-card connected" : "connection-card"}>
                <div class="connection-heading">
                  <span class="status-dot" aria-hidden="true" />
                  <div>
                    <h3>Полётный контроллер</h3>
                    <p>USB · MAVLink · только чтение</p>
                  </div>
                </div>

                {heartbeat ? (
                  <dl class="device-details">
                    <div><dt>Порт</dt><dd>{heartbeat.portName}</dd></div>
                    <div><dt>Система</dt><dd>{heartbeat.systemId}:{heartbeat.componentId}</dd></div>
                    <div><dt>Тип</dt><dd>{heartbeat.vehicleType}</dd></div>
                    <div><dt>Автопилот</dt><dd>{heartbeat.autopilot}</dd></div>
                    <div><dt>Состояние</dt><dd>{heartbeat.systemStatus}</dd></div>
                  </dl>
                ) : (
                  <div class="port-picker">
                    <label for="flight-controller-port">Serial-порт</label>
                    <select
                      id="flight-controller-port"
                      value={selectedPort}
                      onChange={(event) => setSelectedPort(event.currentTarget.value)}
                      disabled={isScanning || isConnecting}
                    >
                      {ports.length === 0 && <option value="">USB-устройства не найдены</option>}
                      {ports.map((port) => (
                        <option key={port.name} value={port.name}>
                          {port.product ? `${port.product} · ` : ""}{port.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {connectionError && <p class="connection-error">{connectionError}</p>}
                <div class="connection-footer">
                  <span class="status-label">
                    {heartbeat
                      ? "Постоянная сессия активна"
                      : isConnecting
                        ? "Ожидание heartbeat…"
                        : `${ports.length} USB-порт(а)`}
                  </span>
                  {heartbeat ? (
                    <button type="button" onClick={disconnectFlightController} disabled={isConnecting}>
                      Отключить
                    </button>
                  ) : (
                    <div class="connection-actions">
                      <button type="button" onClick={scanPorts} disabled={isScanning || isConnecting}>
                        Обновить
                      </button>
                      <button
                        class="primary-button"
                        type="button"
                        onClick={connectFlightController}
                        disabled={!selectedPort || isScanning || isConnecting}
                      >
                        Подключить
                      </button>
                    </div>
                  )}
                </div>
              </article>
              <ConnectionCard label="Arduino-амперметр" description="USB · Serial" />
              <ConnectionCard
                label="Управляющий маршрут"
                description="Через соединение контроллера"
                optional
              />
            </section>

            <section class="safety-panel">
              <div>
                <p class="eyebrow">Состояние системы</p>
                <h2>{heartbeat ? "CONNECTED" : "DISCONNECTED"}</h2>
              </div>
              <p>
                {heartbeat
                  ? "Контроллер отвечает по MAVLink. Управляющие воздействия и запись параметров по-прежнему заблокированы."
                  : "Управляющие воздействия заблокированы, пока обязательные устройства не подключены и стенд не переведён в безопасное состояние."}
              </p>
            </section>
          </>
        )}

        {activeTab === "telemetry" && heartbeat && (
          <>
            <section class="hero compact-hero">
              <p class="eyebrow">MAVLink · {heartbeat.portName}</p>
              <h1>Телеметрия</h1>
              <p class="hero-copy">Текущие входящие данные. Отсутствующие сигналы не заменяются нулевыми значениями.</p>
            </section>
            <section class="telemetry-grid">
              <Metric label="Состояние" value={telemetry?.systemStatus ?? heartbeat.systemStatus} />
              <Metric label="Arm" value={telemetry?.armed === undefined ? undefined : telemetry.armed ? "ARMED" : "DISARMED"} />
              <Metric label="Загрузка CPU" value={telemetry?.cpuLoadPercent?.toFixed(1)} unit="%" />
              <Metric label="Сообщений принято" value={telemetry?.messageCount} />
              <Metric label="Напряжение" value={telemetry?.batteryVoltageV?.toFixed(2)} unit="V" />
              <Metric label="Ток контроллера" value={telemetry?.batteryCurrentA?.toFixed(2)} unit="A" />
              <Metric label="Заряд" value={telemetry?.batteryRemainingPercent} unit="%" />
              <Metric label="GPS fix" value={telemetry?.gpsFix} />
              <Metric label="Спутники" value={telemetry?.satellitesVisible} />
              <Metric label="Roll" value={telemetry?.rollRad?.toFixed(3)} unit="rad" />
              <Metric label="Pitch" value={telemetry?.pitchRad?.toFixed(3)} unit="rad" />
              <Metric label="Yaw" value={telemetry?.yawRad?.toFixed(3)} unit="rad" />
            </section>
            <section class="rc-panel">
              <div>
                <p class="eyebrow">RC input</p>
                <h2>{telemetry?.rcChannelCount ? `${telemetry.rcChannelCount} каналов` : "Нет данных"}</h2>
              </div>
              <div class="rc-values">
                {telemetry?.rcChannels?.slice(0, Math.min(telemetry.rcChannelCount ?? 0, 18)).map((value, index) => (
                  <span key={index}>CH{index + 1} <strong>{value === u16Max ? "—" : value}</strong></span>
                ))}
              </div>
            </section>
          </>
        )}

        {activeTab === "parameters" && heartbeat && (
          <>
            <div class="parameter-sticky-header">
              <section class="hero compact-hero parameters-hero">
                <div class="parameter-title">
                  <div><p class="eyebrow">MAVLink · только чтение</p><h1>Параметры</h1></div>
                  <p class="hero-copy">Настройки прошивки контроллера. Запись пока заблокирована.</p>
                </div>
                <div class="parameter-progress">
                  <strong>{parameters?.loading ? parameters.refreshReceivedCount : (parameters?.receivedCount ?? 0)} / {parameters?.totalCount || "—"}</strong>
                  <span>
                    {parameters?.loading
                      ? parameters.items.length > 0 ? "Обновление в фоне · показан кэш" : "Получение параметров…"
                      : "Загружено"}
                  </span>
                </div>
              </section>

              <section class="parameter-toolbar">
                <input type="search" value={parameterSearch} placeholder="Поиск по имени параметра" onInput={(event) => setParameterSearch(event.currentTarget.value)} />
                <button type="button" onClick={saveParameterBackup}>Сохранить backup</button>
                <button type="button" onClick={compareParameterFile}>Сравнить файл</button>
                <button type="button" onClick={() => invoke("request_flight_controller_parameters")}>Обновить</button>
                {Object.keys(stagedChanges).length > 0 && (
                  <>
                    <button class="primary-button" type="button" disabled={writeStatus?.active || parameters?.loading} onClick={writeStagedParameters}>
                      Записать · {Object.keys(stagedChanges).length}
                    </button>
                    <button type="button" disabled={writeStatus?.active} onClick={() => setStagedChanges({})}>Отменить</button>
                  </>
                )}
              </section>
              {parameterError && <p class="connection-error">{parameterError}</p>}
              {writeStatus?.active && <p class="write-status">Запись {writeStatus.completed + writeStatus.failed} / {writeStatus.total} · {writeStatus.currentName}</p>}
              {!writeStatus?.active && writeStatus?.failed ? <p class="connection-error">Не записано: {writeStatus.failed}. {writeStatus.lastError}</p> : null}
            </div>

            {comparisonFile && (
              <section class="parameter-comparison">
                <div class="comparison-heading">
                  <div>
                    <p class="eyebrow">Сравнение · {comparisonFile}</p>
                    <h2>{parameterDifferences.length} отличий</h2>
                  </div>
                  <div class="comparison-actions">
                    <button type="button" onClick={() => setParameterDifferences((items) => items.map((item) => ({ ...item, selected: true })))}>Выбрать все</button>
                    <button type="button" disabled={!parameterDifferences.some((item) => item.selected && item.currentValue !== undefined)} onClick={stageSelectedDifferences}>Подготовить к записи</button>
                    <button type="button" onClick={() => { setComparisonFile(null); setParameterDifferences([]); }}>Закрыть</button>
                  </div>
                </div>
                <div class="comparison-list">
                  {parameterDifferences.map((difference, index) => (
                    <label key={difference.name}>
                      <input
                        type="checkbox"
                        checked={difference.selected}
                        onChange={(event) => setParameterDifferences((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, selected: event.currentTarget.checked } : item))}
                      />
                      <strong>{difference.name}</strong>
                      <span>{difference.currentValue ?? "нет в контроллере"}</span>
                      <span>→</span>
                      <span>{difference.value}</span>
                    </label>
                  ))}
                </div>
              </section>
            )}
            <section class="parameter-groups" aria-label="Параметры прошивки">
              {parameterGroups.map(([group, items]) => (
                <details class="parameter-group" key={group} open={normalizedParameterSearch.length > 0 || undefined}>
                  <summary>
                    <strong>{group}</strong>
                    <span>{items.length} параметров</span>
                  </summary>
                  <div class="parameter-table">
                    <div class="parameter-row parameter-header">
                      <span>Параметр</span><span>Значение</span><span>Тип</span><span>Действие</span>
                    </div>
                    {items.map((parameter) => (
                      <div class="parameter-row" key={parameter.index}>
                        <strong>{parameter.name}</strong>
                        {editingParameter === parameter.name ? (
                          <input
                            class="parameter-value editing"
                            type="text"
                            inputMode="decimal"
                            value={editingValue}
                            autofocus
                            onInput={(event) => setEditingValue(event.currentTarget.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") applyParameterEdit(parameter);
                              if (event.key === "Escape") setEditingParameter(null);
                            }}
                          />
                        ) : (
                          <span class={stagedChanges[parameter.name] !== undefined ? "parameter-display modified" : "parameter-display"}>
                            {stagedChanges[parameter.name] ?? parameter.value}
                          </span>
                        )}
                        <span>{parameter.parameterType.replace("MAV_PARAM_TYPE_", "")}</span>
                        {editingParameter === parameter.name ? (
                          <div class="parameter-edit-actions">
                            <button class="primary-button" type="button" onClick={() => applyParameterEdit(parameter)}>Применить</button>
                            <button type="button" onClick={() => setEditingParameter(null)}>Отмена</button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={writeStatus?.active}
                            onClick={() => {
                              setEditingParameter(parameter.name);
                              setEditingValue(String(stagedChanges[parameter.name] ?? parameter.value));
                            }}
                          >
                            {stagedChanges[parameter.name] !== undefined ? "Исправить" : "Изменить"}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </section>
          </>
        )}

        {!["connections", "telemetry", "parameters"].includes(activeTab) && (
          <section class="hero">
            <p class="eyebrow">Следующий этап</p>
            <h1>{tabs.find((tab) => tab.id === activeTab)?.label}</h1>
            <p class="hero-copy">Раздел подключён к навигации и будет реализован на соответствующем этапе.</p>
          </section>
        )}
      </main>
    </div>
  );
}

const u16Max = 65_535;
