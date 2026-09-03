import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  blockCatalog,
  blockLabel,
  evaluateImmediateBlock,
  evaluateParameterValue,
  validateScenario,
  type BlockType,
  type ScenarioBlock,
  type ScenarioContext,
} from "./scenario-engine";

type RunEntry = {
  blockId: string;
  label: string;
  status: "running" | "passed" | "failed";
  message: string;
};
type FreshParameter = { name: string; value: number };
type MotorRotationCommand = {
  throttleChannel: number;
  inputPwm: number;
  minimumInputPwm: number;
  expectedServo1Pwm: number;
};
type Props = { context: ScenarioContext };
type SavedScenario = {
  id: string;
  name: string;
  blocks: ScenarioBlock[];
  updatedAt: number;
};
type ScenarioFile = {
  format: "uav-test-station-scenarios";
  version: 1;
  scenarios: SavedScenario[];
};

const STORAGE_KEY = "uav-test-station.scenarios.v1";
const TEMPLATE_SEEDED_KEY = "uav-test-station.motor-template.v8";
const safetyConfirmation = {
  type: "operatorConfirmation" as const,
  message: "БПЛА закреплён, защитная зона свободна, аварийное отключение готово",
};

const motorTestTemplate: SavedScenario = {
  id: "built-in-motor-test-v1",
  name: "Тест двигателя БПЛА",
  updatedAt: Date.now(),
  blocks: [
    { id: "motor-1", type: "prepareMotorTest", maximumIdleCurrentA: 1 },
    {
      id: "motor-2",
      type: "operatorConfirmation",
      message: "БПЛА закреплён, защитная зона свободна, аварийное отключение готово",
    },
    {
      id: "motor-3",
      type: "armController",
      force: true,
    },
    {
      id: "motor-4",
      type: "checkMotorRotation",
      throttlePercent: 10,
      durationSeconds: 2,
      emergencyCurrentA: 40,
      confirmation: "Пропеллер вращается в правильном направлении?",
    },
    {
      id: "motor-5",
      type: "measureMaximumCurrent",
      durationSeconds: 2,
      settlingSeconds: 0.5,
      emergencyCurrentA: 250,
    },
    {
      id: "motor-6",
      type: "tuneRcMaxByCurrent",
      parameterName: "RC1_MAX",
      targetCurrentA: 160,
      toleranceA: 3,
      emergencyCurrentA: 250,
      maximumAttempts: 6,
      cooldownSeconds: 5,
    },
    {
      id: "motor-7",
      type: "calibrateControllerCurrent",
      parameterName: "BATT_AMP_PERVLT",
      targetCurrentA: 20,
      targetToleranceA: 1,
      comparisonToleranceA: 0.5,
      maximumDurationSeconds: 10,
      emergencyCurrentA: 40,
    },
    { id: "motor-8", type: "disarmController" },
    { id: "motor-9", type: "resultMessage", message: "Тест двигателя завершён" },
  ],
};

const motorTestTemplates: SavedScenario[] = [
  {
    id: "built-in-motor-rotation-v1",
    name: "01 — Проверка вращения двигателя",
    updatedAt: Date.now(),
    blocks: [
      { id: "rotation-1", type: "prepareMotorTest", maximumIdleCurrentA: 1 },
      { id: "rotation-2", ...safetyConfirmation },
      { id: "rotation-3", type: "armController", force: true },
      {
        id: "rotation-4",
        type: "checkMotorRotation",
        throttlePercent: 10,
        durationSeconds: 2,
        emergencyCurrentA: 40,
        confirmation: "Пропеллер вращается в правильном направлении?",
      },
      { id: "rotation-5", type: "disarmController" },
      { id: "rotation-6", type: "resultMessage", message: "Направление вращения проверено" },
    ],
  },
  {
    id: "built-in-maximum-current-v1",
    name: "02 — Измерение максимального тока",
    updatedAt: Date.now(),
    blocks: [
      { id: "maximum-1", type: "prepareMotorTest", maximumIdleCurrentA: 1 },
      { id: "maximum-2", ...safetyConfirmation },
      {
        id: "maximum-3",
        type: "measureMaximumCurrent",
        durationSeconds: 2,
        settlingSeconds: 0.5,
        emergencyCurrentA: 250,
      },
      {
        id: "maximum-4",
        type: "resultMessage",
        message: "Максимальный ток двигателя измерен",
      },
    ],
  },
  {
    id: "built-in-rc-max-tuning-v1",
    name: "03 — Настройка максимального тока 160 А",
    updatedAt: Date.now(),
    blocks: [
      { id: "rcmax-1", type: "prepareMotorTest", maximumIdleCurrentA: 1 },
      { id: "rcmax-2", ...safetyConfirmation },
      {
        id: "rcmax-3",
        type: "tuneRcMaxByCurrent",
        parameterName: "RC1_MAX",
        targetCurrentA: 160,
        toleranceA: 3,
        emergencyCurrentA: 250,
        maximumAttempts: 6,
        cooldownSeconds: 5,
      },
      { id: "rcmax-4", type: "resultMessage", message: "Ограничение максимального тока настроено" },
    ],
  },
  {
    id: "built-in-current-calibration-v1",
    name: "04 — Калибровка тока на 20 А",
    updatedAt: Date.now(),
    blocks: [
      { id: "calibration-1", type: "prepareMotorTest", maximumIdleCurrentA: 1 },
      { id: "calibration-2", ...safetyConfirmation },
      {
        id: "calibration-3",
        type: "calibrateControllerCurrent",
        parameterName: "BATT_AMP_PERVLT",
        targetCurrentA: 20,
        targetToleranceA: 1,
        comparisonToleranceA: 0.5,
        maximumDurationSeconds: 10,
        emergencyCurrentA: 40,
      },
      {
        id: "calibration-4",
        type: "resultMessage",
        message: "Показания тока контроллера откалиброваны",
      },
    ],
  },
  motorTestTemplate,
];

function loadScenarios(): SavedScenario[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    const scenarios = Array.isArray(value) ? (value as SavedScenario[]) : [];
    if (localStorage.getItem(TEMPLATE_SEEDED_KEY) !== "1") {
      localStorage.setItem(TEMPLATE_SEEDED_KEY, "1");
      const updatedBuiltIns = new Map(
        motorTestTemplates
          .filter(
            (template) =>
              template.id === "built-in-motor-rotation-v1" ||
              template.id === motorTestTemplate.id,
          )
          .map((template) => [template.id, template]),
      );
      const migrated = scenarios.map(
        (scenario) => updatedBuiltIns.get(scenario.id) ?? scenario,
      );
      const existingIds = new Set(migrated.map((item) => item.id));
      return [...motorTestTemplates.filter((item) => !existingIds.has(item.id)), ...migrated];
    }
    return scenarios;
  } catch {
    return [];
  }
}

async function playComputerTone() {
  const audio = new AudioContext();
  await audio.resume();
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = "square";
  oscillator.frequency.value = 720;
  gain.gain.setValueAtTime(0.45, audio.currentTime);
  gain.gain.setValueAtTime(0.45, audio.currentTime + 0.65);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.8);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + 0.82);
  await new Promise((resolve) => window.setTimeout(resolve, 850));
  await audio.close();
}

function Fields({
  block,
  replace,
  disabled,
}: {
  block: ScenarioBlock;
  replace: (value: ScenarioBlock) => void;
  disabled: boolean;
}) {
  if (block.type === "parameterEquals")
    return (
      <div class="block-fields three-fields">
        <label>
          Параметр
          <input
            disabled={disabled}
            value={block.name}
            onInput={(e) => replace({ ...block, name: e.currentTarget.value.toUpperCase() })}
          />
        </label>
        <label>
          Значение
          <input
            disabled={disabled}
            type="number"
            value={block.expected}
            onInput={(e) => replace({ ...block, expected: e.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Допуск
          <input
            disabled={disabled}
            type="number"
            min="0"
            step="0.001"
            value={block.tolerance}
            onInput={(e) => replace({ ...block, tolerance: e.currentTarget.valueAsNumber })}
          />
        </label>
      </div>
    );
  if (block.type === "currentInRange")
    return (
      <div class="block-fields">
        <label>
          Минимум, A
          <input
            disabled={disabled}
            type="number"
            step="0.1"
            value={block.minimum}
            onInput={(e) => replace({ ...block, minimum: e.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Максимум, A
          <input
            disabled={disabled}
            type="number"
            step="0.1"
            value={block.maximum}
            onInput={(e) => replace({ ...block, maximum: e.currentTarget.valueAsNumber })}
          />
        </label>
      </div>
    );
  if (block.type === "wait")
    return (
      <div class="block-fields">
        <label>
          Секунды
          <input
            disabled={disabled}
            type="number"
            min="0"
            max="300"
            step="0.1"
            value={block.seconds}
            onInput={(e) => replace({ ...block, seconds: e.currentTarget.valueAsNumber })}
          />
        </label>
      </div>
    );
  if (block.type === "sound")
    return (
      <div class="block-fields">
        <label>
          Количество
          <input
            disabled={disabled}
            type="number"
            min="1"
            max="20"
            step="1"
            value={block.repeats}
            onInput={(e) => replace({ ...block, repeats: e.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Интервал, с
          <input
            disabled={disabled}
            type="number"
            min="0"
            max="60"
            step="0.1"
            value={block.intervalSeconds}
            onInput={(e) => replace({ ...block, intervalSeconds: e.currentTarget.valueAsNumber })}
          />
        </label>
      </div>
    );
  if (block.type === "operatorConfirmation" || block.type === "resultMessage")
    return (
      <div class="block-fields">
        <label>
          Текст
          <input
            disabled={disabled}
            value={block.message}
            onInput={(e) => replace({ ...block, message: e.currentTarget.value })}
          />
        </label>
      </div>
    );
  if (block.type === "prepareMotorTest")
    return (
      <div class="block-fields">
        <label>
          Максимальный ток покоя, A
          <input
            disabled={disabled}
            type="number"
            min="0"
            step="0.1"
            value={block.maximumIdleCurrentA}
            onInput={(e) =>
              replace({ ...block, maximumIdleCurrentA: e.currentTarget.valueAsNumber })
            }
          />
        </label>
      </div>
    );
  if (block.type === "armController")
    return (
      <div class="block-fields">
        <label>
          <input
            disabled={disabled}
            type="checkbox"
            checked={block.force}
            onChange={(e) => replace({ ...block, force: e.currentTarget.checked })}
          />
          Принудительный ARM — обойти pre-arm checks (только стенд без пропеллера)
        </label>
      </div>
    );
  if (block.type === "checkMotorRotation")
    return (
      <div class="block-fields three-fields">
        <label>
          Малый газ, %
          <input
            disabled={disabled}
            type="number"
            min="1"
            max="30"
            value={block.throttlePercent}
            onInput={(e) => replace({ ...block, throttlePercent: e.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Длительность, с
          <input
            disabled={disabled}
            type="number"
            min="0.1"
            max="5"
            step="0.1"
            value={block.durationSeconds}
            onInput={(e) => replace({ ...block, durationSeconds: e.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Аварийный ток, A
          <input
            disabled={disabled}
            type="number"
            min="1"
            step="1"
            value={block.emergencyCurrentA}
            onInput={(e) => replace({ ...block, emergencyCurrentA: e.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Подтверждение
          <input
            disabled={disabled}
            value={block.confirmation}
            onInput={(e) => replace({ ...block, confirmation: e.currentTarget.value })}
          />
        </label>
      </div>
    );
  if (block.type === "measureMaximumCurrent")
    return (
      <div class="block-fields three-fields">
        <label>
          Длительность, с
          <input
            disabled={disabled}
            type="number"
            min="0.1"
            max="5"
            step="0.1"
            value={block.durationSeconds}
            onInput={(e) => replace({ ...block, durationSeconds: e.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Стабилизация, с
          <input
            disabled={disabled}
            type="number"
            min="0"
            step="0.1"
            value={block.settlingSeconds}
            onInput={(e) => replace({ ...block, settlingSeconds: e.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Аварийный ток, A
          <input
            disabled={disabled}
            type="number"
            min="1"
            step="1"
            value={block.emergencyCurrentA}
            onInput={(e) => replace({ ...block, emergencyCurrentA: e.currentTarget.valueAsNumber })}
          />
        </label>
      </div>
    );
  if (block.type === "tuneRcMaxByCurrent")
    return (
      <div class="block-fields three-fields">
        <label>
          Параметр
          <input
            disabled={disabled}
            value={block.parameterName}
            onInput={(e) =>
              replace({ ...block, parameterName: e.currentTarget.value.toUpperCase() })
            }
          />
        </label>
        <label>
          Целевой ток, A
          <input
            disabled={disabled}
            type="number"
            min="1"
            value={block.targetCurrentA}
            onInput={(e) => replace({ ...block, targetCurrentA: e.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Допуск, A
          <input
            disabled={disabled}
            type="number"
            min="0"
            step="0.1"
            value={block.toleranceA}
            onInput={(e) => replace({ ...block, toleranceA: e.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Аварийный ток, A
          <input
            disabled={disabled}
            type="number"
            min="1"
            value={block.emergencyCurrentA}
            onInput={(e) => replace({ ...block, emergencyCurrentA: e.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Попыток
          <input
            disabled={disabled}
            type="number"
            min="1"
            max="10"
            value={block.maximumAttempts}
            onInput={(e) => replace({ ...block, maximumAttempts: e.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Пауза, с
          <input
            disabled={disabled}
            type="number"
            min="0"
            max="300"
            value={block.cooldownSeconds}
            onInput={(e) => replace({ ...block, cooldownSeconds: e.currentTarget.valueAsNumber })}
          />
        </label>
      </div>
    );
  if (block.type === "calibrateControllerCurrent")
    return (
      <div class="block-fields three-fields">
        <label>
          Параметр
          <input
            disabled={disabled}
            value={block.parameterName}
            onInput={(e) =>
              replace({ ...block, parameterName: e.currentTarget.value.toUpperCase() })
            }
          />
        </label>
        <label>
          Целевой ток, A
          <input
            disabled={disabled}
            type="number"
            min="1"
            value={block.targetCurrentA}
            onInput={(e) => replace({ ...block, targetCurrentA: e.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Допуск нагрузки, A
          <input
            disabled={disabled}
            type="number"
            min="0"
            step="0.1"
            value={block.targetToleranceA}
            onInput={(e) => replace({ ...block, targetToleranceA: e.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Допуск сравнения, A
          <input
            disabled={disabled}
            type="number"
            min="0"
            step="0.1"
            value={block.comparisonToleranceA}
            onInput={(e) =>
              replace({ ...block, comparisonToleranceA: e.currentTarget.valueAsNumber })
            }
          />
        </label>
        <label>
          Макс. время, с
          <input
            disabled={disabled}
            type="number"
            min="1"
            max="30"
            value={block.maximumDurationSeconds}
            onInput={(e) =>
              replace({ ...block, maximumDurationSeconds: e.currentTarget.valueAsNumber })
            }
          />
        </label>
        <label>
          Аварийный ток, A
          <input
            disabled={disabled}
            type="number"
            min="1"
            value={block.emergencyCurrentA}
            onInput={(e) => replace({ ...block, emergencyCurrentA: e.currentTarget.valueAsNumber })}
          />
        </label>
      </div>
    );
  return null;
}

export function ScenarioEditor({ context }: Props) {
  const latestContext = useRef(context);
  latestContext.current = context;
  const [savedScenarios, setSavedScenarios] = useState<SavedScenario[]>(loadScenarios);
  const [scenarioId, setScenarioId] = useState<string>(() => crypto.randomUUID());
  const [name, setName] = useState("Новый сценарий");
  const [blocks, setBlocks] = useState<ScenarioBlock[]>([]);
  const [page, setPage] = useState<"list" | "editor">("list");
  const [dirty, setDirty] = useState(false);
  const [selectedType, setSelectedType] = useState<BlockType>("requireController");
  const [errors, setErrors] = useState<string[]>([]);
  const [entries, setEntries] = useState<RunEntry[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "passed" | "failed" | "cancelled">(
    "idle",
  );
  const cancelled = useRef(false);
  const motorActive = useRef(false);
  const activeEmergencyCurrentA = useRef<number | null>(null);
  const stopReason = useRef("Остановлено оператором");
  const running = status === "running";
  const emergencyStop = async (reason = "Остановлено оператором") => {
    stopReason.current = reason;
    cancelled.current = true;
    try {
      await invoke("emergency_stop_motor");
    } catch (error) {
      console.error("Не удалось подтвердить аварийную остановку", error);
    } finally {
      motorActive.current = false;
      activeEmergencyCurrentA.current = null;
    }
  };
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedScenarios));
  }, [savedScenarios]);
  useEffect(() => {
    if (!running) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      event.preventDefault();
      void emergencyStop("Остановлено клавишей Space");
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [running]);
  useEffect(() => {
    const currentLimitExceeded =
      activeEmergencyCurrentA.current !== null &&
      context.ammeterCurrentA !== undefined &&
      Math.abs(context.ammeterCurrentA) >= activeEmergencyCurrentA.current;
    if (
      running &&
      motorActive.current &&
      (!context.controllerConnected || !context.ammeterConnected || currentLimitExceeded)
    ) {
      const reason = currentLimitExceeded
        ? `Аварийный ток: ${context.ammeterCurrentA?.toFixed(2)} A`
        : !context.controllerConnected
          ? "Потеряно соединение с контроллером"
          : "Потеряно соединение с амперметром";
      void emergencyStop(reason);
    }
  }, [running, context.controllerConnected, context.ammeterConnected, context.ammeterCurrentA]);

  const changeDraft = () => {
    setDirty(true);
    setStatus("idle");
  };
  const replace = (value: ScenarioBlock) => {
    setBlocks((all) => all.map((item) => (item.id === value.id ? value : item)));
    changeDraft();
  };
  const move = (index: number, offset: number) => {
    setBlocks((all) => {
      const target = index + offset;
      if (target < 0 || target >= all.length) return all;
      const next = [...all];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    changeDraft();
  };
  const add = () => {
    const definition = blockCatalog.find((item) => item.type === selectedType);
    if (definition)
      setBlocks((all) => [...all, definition.create(`${Date.now()}-${Math.random()}`)]);
    setErrors([]);
    changeDraft();
  };
  const discardDraftApproved = async () =>
    !dirty ||
    (await confirm("Несохранённые изменения будут потеряны. Продолжить?", {
      title: "Несохранённый сценарий",
      kind: "warning",
    }));
  const createScenario = async () => {
    if (!(await discardDraftApproved())) return;
    setScenarioId(crypto.randomUUID());
    setName("Новый сценарий");
    setBlocks([]);
    setEntries([]);
    setErrors([]);
    setStatus("idle");
    setPage("editor");
    setDirty(true);
  };
  const selectScenario = async (scenario: SavedScenario) => {
    if (running || !(await discardDraftApproved())) return;
    setScenarioId(scenario.id);
    setName(scenario.name);
    setBlocks(structuredClone(scenario.blocks));
    setEntries([]);
    setErrors([]);
    setStatus("idle");
    setPage("editor");
    setDirty(false);
  };
  const saveScenario = () => {
    const found = validateScenario(name, blocks);
    setErrors(found);
    if (found.length) return;
    const saved = {
      id: scenarioId,
      name: name.trim(),
      blocks: structuredClone(blocks),
      updatedAt: Date.now(),
    };
    setSavedScenarios((all) => [saved, ...all.filter((item) => item.id !== scenarioId)]);
    setName(saved.name);
    setDirty(false);
  };
  const deleteScenario = async () => {
    if (
      running ||
      !(await confirm(`Удалить сценарий «${name}»? Это действие нельзя отменить.`, {
        title: "Удаление сценария",
        kind: "warning",
      }))
    )
      return;
    setSavedScenarios((all) => all.filter((item) => item.id !== scenarioId));
    setPage("list");
    setDirty(false);
    setEntries([]);
    setStatus("idle");
  };
  const exportScenario = async () => {
    const found = validateScenario(name, blocks);
    setErrors(found);
    if (found.length) return;
    try {
      const safeName = name.trim().replace(/[\\/:*?"<>|]+/g, "-");
      const path = await save({
        title: `Экспорт сценария «${name.trim()}»`,
        defaultPath: `${safeName || "scenario"}.json`,
        filters: [{ name: "Сценарий UAV Test Station", extensions: ["json"] }],
      });
      if (!path) return;
      const scenario: SavedScenario = {
        id: scenarioId,
        name: name.trim(),
        blocks: structuredClone(blocks),
        updatedAt: Date.now(),
      };
      const file: ScenarioFile = {
        format: "uav-test-station-scenarios",
        version: 1,
        scenarios: [scenario],
      };
      await invoke("save_scenario_file", { path, contents: JSON.stringify(file, null, 2) });
    } catch (error) {
      window.alert(`Не удалось экспортировать сценарий: ${String(error).replace(/^Error: /, "")}`);
    }
  };
  const importScenarios = async () => {
    const path = await open({
      title: "Импорт сценариев",
      multiple: false,
      directory: false,
      filters: [{ name: "Сценарии UAV Test Station", extensions: ["json"] }],
    });
    if (!path) return;
    try {
      const contents = await invoke<string>("load_scenario_file", { path });
      const file = JSON.parse(contents) as Partial<ScenarioFile>;
      if (
        file.format !== "uav-test-station-scenarios" ||
        file.version !== 1 ||
        !Array.isArray(file.scenarios)
      )
        throw new Error("Файл не является экспортом сценариев UAV Test Station версии 1");
      for (const scenario of file.scenarios) {
        if (
          !scenario ||
          typeof scenario.id !== "string" ||
          typeof scenario.name !== "string" ||
          !Array.isArray(scenario.blocks) ||
          validateScenario(scenario.name, scenario.blocks).length
        )
          throw new Error(`Некорректный сценарий: ${scenario?.name ?? "без названия"}`);
      }
      setSavedScenarios((current) => {
        const importedIds = new Set(file.scenarios!.map((item) => item.id));
        return [...file.scenarios!, ...current.filter((item) => !importedIds.has(item.id))];
      });
    } catch (error) {
      window.alert(`Не удалось импортировать сценарии: ${String(error).replace(/^Error: /, "")}`);
    }
  };
  const backToList = async () => {
    if (running || !(await discardDraftApproved())) return;
    setPage("list");
    setDirty(false);
    setEntries([]);
    setStatus("idle");
  };
  const updateEntry = (id: string, result: Partial<RunEntry>) =>
    setEntries((all) =>
      all.map((entry) => (entry.blockId === id ? { ...entry, ...result } : entry)),
    );
  const run = async () => {
    const found = validateScenario(name, blocks);
    setErrors(found);
    if (found.length) return;
    cancelled.current = false;
    stopReason.current = "Остановлено оператором";
    setEntries([]);
    setStatus("running");
    for (const block of blocks) {
      if (cancelled.current) {
        setStatus("cancelled");
        return;
      }
      setEntries((all) => [
        ...all,
        { blockId: block.id, label: blockLabel(block), status: "running", message: "Выполняется…" },
      ]);
      try {
        let message: string;
        if (block.type === "wait") {
          const deadline = Date.now() + block.seconds * 1000;
          while (Date.now() < deadline) {
            await new Promise((resolve) =>
              window.setTimeout(resolve, Math.min(100, deadline - Date.now())),
            );
            if (cancelled.current) throw new Error("Выполнение отменено оператором");
          }
          message = `Ожидание ${block.seconds} с завершено`;
        } else if (block.type === "parameterEquals") {
          const parameter = await invoke<FreshParameter>("read_flight_controller_parameter", {
            name: block.name.trim(),
          });
          message = evaluateParameterValue(block, parameter.value);
        } else if (block.type === "sound") {
          for (let index = 0; index < block.repeats; index += 1) {
            if (cancelled.current) throw new Error("Выполнение отменено оператором");
            await playComputerTone();
            if (index + 1 < block.repeats && block.intervalSeconds > 0) {
              const deadline = Date.now() + block.intervalSeconds * 1000;
              while (Date.now() < deadline) {
                await new Promise((resolve) =>
                  window.setTimeout(resolve, Math.min(100, deadline - Date.now())),
                );
                if (cancelled.current) throw new Error("Выполнение отменено оператором");
              }
            }
          }
          message = `Подано сигналов через динамик компьютера: ${block.repeats}`;
        } else if (block.type === "operatorConfirmation") {
          if (!(await confirm(block.message, { title: `Сценарий: ${name}`, kind: "warning" })))
            throw new Error("Оператор не подтвердил действие");
          message = `Оператор подтвердил: ${block.message}`;
        } else if (block.type === "armController") {
          if (!latestContext.current.controllerConnected)
            throw new Error("Полётный контроллер не подключён");
          if (latestContext.current.armed === true) {
            message = "Контроллер уже находится в состоянии ARM";
          } else {
            const previousStatusText = latestContext.current.controllerStatusText;
            await invoke("set_flight_controller_armed", { armed: true, force: block.force });
            const deadline = Date.now() + 5000;
            while (!Boolean(latestContext.current.armed) && Date.now() < deadline) {
              await new Promise((resolve) => window.setTimeout(resolve, 100));
              if (cancelled.current) throw new Error(stopReason.current);
            }
            if (!Boolean(latestContext.current.armed)) {
              const statusText = latestContext.current.controllerStatusText;
              throw new Error(
                statusText && statusText !== previousStatusText
                  ? `Контроллер отклонил ARM: ${statusText}`
                  : block.force
                    ? "Контроллер отклонил даже принудительный ARM или не подтвердил его по heartbeat"
                    : "Контроллер отклонил ARM или не подтвердил его по heartbeat. Проверьте сообщения pre-arm в Mission Planner",
              );
            }
            message = "Контроллер подтвердил состояние ARM";
          }
        } else if (block.type === "disarmController") {
          await invoke("emergency_stop_motor");
          const deadline = Date.now() + 5000;
          while (latestContext.current.armed !== false && Date.now() < deadline) {
            await new Promise((resolve) => window.setTimeout(resolve, 100));
          }
          if (latestContext.current.armed !== false)
            throw new Error(
              `Контроллер не подтвердил принудительный DISARM по heartbeat; ARM=${latestContext.current.armed === true ? "да" : "неизвестно"}, сообщение=${latestContext.current.controllerStatusText ?? "нет"}`,
            );
          message = "Двигатель остановлен, контроллер подтвердил DISARM";
        } else if (block.type === "checkMotorRotation") {
          if (latestContext.current.armed !== true)
            throw new Error("Перед запуском двигателя контроллер должен находиться в ARM");
          motorActive.current = true;
          activeEmergencyCurrentA.current = block.emergencyCurrentA;
          const motorCommand = await invoke<MotorRotationCommand>("start_motor_rotation", {
            throttlePercent: block.throttlePercent,
            durationSeconds: block.durationSeconds,
          });
          const deadline = Date.now() + block.durationSeconds * 1000 + 350;
          const startedAt = Date.now();
          let nextDiagnosticAt = startedAt;
          const diagnostics: string[] = [];
          let observedInputPwm: number | undefined;
          let observedServo1Pwm: number | undefined;
          while (Date.now() < deadline) {
            await new Promise((resolve) => window.setTimeout(resolve, 50));
            if (cancelled.current) throw new Error(stopReason.current);
            const input = latestContext.current.rcChannels?.[motorCommand.throttleChannel - 1];
            if (
              input !== undefined &&
              input > 0 &&
              (observedInputPwm === undefined ||
                Math.abs(input - motorCommand.inputPwm) <
                  Math.abs(observedInputPwm - motorCommand.inputPwm))
            )
              observedInputPwm = input;
            const output = latestContext.current.servo1OutputPwm;
            if (
              output !== undefined &&
              output > 0 &&
              (observedServo1Pwm === undefined || output > observedServo1Pwm)
            )
              observedServo1Pwm = output;
            if (Date.now() >= nextDiagnosticAt) {
              const elapsedSeconds = (Date.now() - startedAt) / 1000;
              const sample = `${elapsedSeconds.toFixed(1)}с: ARM=${latestContext.current.armed === true ? "да" : "нет"}, RC${motorCommand.throttleChannel}=${input ?? "—"}, SERVO1=${output ?? "—"}`;
              diagnostics.push(sample);
              updateEntry(block.id, {
                message: `Газ ${block.throttlePercent}%: цель RC${motorCommand.throttleChannel}=${motorCommand.inputPwm}, SERVO1≈${motorCommand.expectedServo1Pwm} мкс. ${sample}`,
              });
              nextDiagnosticAt += 200;
            }
          }
          await invoke("emergency_stop_motor");
          motorActive.current = false;
          activeEmergencyCurrentA.current = null;
          if (
            observedInputPwm === undefined ||
            Math.abs(observedInputPwm - motorCommand.inputPwm) > 25
          )
            throw new Error(
              `Контроллер не применил RC override: отправлено RC${motorCommand.throttleChannel}=${motorCommand.inputPwm} мкс, получено ${observedInputPwm ?? "нет данных"} мкс. Лог: ${diagnostics.join("; ")}`,
            );
          if (
            observedServo1Pwm === undefined ||
            observedServo1Pwm < motorCommand.expectedServo1Pwm - 40
          )
            throw new Error(
              `Выход SERVO1 не достиг команды газа: ожидалось около ${motorCommand.expectedServo1Pwm} мкс, получено ${observedServo1Pwm ?? "нет данных"} мкс. Лог: ${diagnostics.join("; ")}`,
            );
          if (
            !(await confirm(block.confirmation, {
              title: `Сценарий: ${name}`,
              kind: "warning",
            }))
          )
            throw new Error("Направление вращения не подтверждено оператором");
          message = `Двигатель: ${block.durationSeconds} с на ${block.throttlePercent}% газа; RC${motorCommand.throttleChannel}=${observedInputPwm} мкс, SERVO1=${observedServo1Pwm} мкс; направление подтверждено. Лог: ${diagnostics.join("; ")}`;
        } else if (block.type === "prepareMotorTest") {
          const current = latestContext.current;
          if (!current.controllerConnected) throw new Error("Полётный контроллер не подключён");
          if (!current.ammeterConnected || current.ammeterCurrentA === undefined)
            throw new Error("Нет актуальных данных амперметра");
          if (Math.abs(current.ammeterCurrentA) > block.maximumIdleCurrentA)
            throw new Error(
              `Ток покоя ${current.ammeterCurrentA.toFixed(2)} A превышает ${block.maximumIdleCurrentA} A`,
            );
          message = `Контроллер и амперметр готовы, ток покоя ${current.ammeterCurrentA.toFixed(2)} A`;
        } else if (
          block.type === "measureMaximumCurrent" ||
          block.type === "tuneRcMaxByCurrent" ||
          block.type === "calibrateControllerCurrent"
        ) {
          throw new Error(
            "Моторный backend ещё не активирован: управляющая команда не отправлялась",
          );
        } else message = evaluateImmediateBlock(block, latestContext.current);
        updateEntry(block.id, { status: "passed", message });
      } catch (error) {
        if (motorActive.current) {
          try {
            await invoke("emergency_stop_motor");
          } finally {
            motorActive.current = false;
            activeEmergencyCurrentA.current = null;
          }
        }
        updateEntry(block.id, { status: "failed", message: String(error).replace(/^Error: /, "") });
        setStatus(cancelled.current ? "cancelled" : "failed");
        return;
      }
    }
    setStatus("passed");
  };
  const statusText = {
    idle: "Ещё не запускался",
    running: "Выполняется",
    passed: "Успешно",
    failed: "Ошибка",
    cancelled: "Отменено",
  }[status];
  if (page === "list")
    return (
      <>
        <section class="scenario-page-header">
          <div>
            <p class="eyebrow">Библиотека</p>
            <h1>Доступные сценарии</h1>
            <p>Выберите сценарий для редактирования и запуска.</p>
          </div>
          <div class="editor-header-actions">
            <button type="button" onClick={importScenarios}>
              Импорт
            </button>
            <button type="button" class="primary-button" onClick={createScenario}>
              + Добавить сценарий
            </button>
          </div>
        </section>
        <section class="scenario-list-page">
          {savedScenarios.map((scenario) => (
            <button type="button" class="scenario-card" onClick={() => selectScenario(scenario)}>
              <div>
                <strong>{scenario.name}</strong>
                <span>{scenario.blocks.length} блоков</span>
              </div>
              <time>Изменён {new Date(scenario.updatedAt).toLocaleString()}</time>
              <span class="scenario-card-arrow">→</span>
            </button>
          ))}
          {!savedScenarios.length && (
            <div class="scenario-empty">
              <h2>Сценариев пока нет</h2>
              <p>Создайте первый сценарий и добавьте в него нужные блоки.</p>
              <button type="button" onClick={createScenario}>
                Добавить сценарий
              </button>
            </div>
          )}
        </section>
      </>
    );

  return (
    <>
      <section class="scenario-page-header editor-header">
        <button type="button" class="back-button" onClick={backToList} disabled={running}>
          ← Назад
        </button>
        <div>
          <p class="eyebrow">Редактор сценария</p>
          <h1>{name || "Без названия"}</h1>
          <span class={dirty ? "draft-state dirty" : "draft-state"}>
            {dirty ? "Есть несохранённые изменения" : "Сохранено"}
          </span>
        </div>
        <div class="editor-header-actions">
          <button type="button" onClick={saveScenario} disabled={running}>
            Сохранить
          </button>
          <button type="button" onClick={exportScenario} disabled={running}>
            Экспорт
          </button>
          <button type="button" class="danger-button" onClick={deleteScenario} disabled={running}>
            Удалить
          </button>
          {running ? (
            <button type="button" class="danger-button" onClick={() => void emergencyStop()}>
              СТОП (Space)
            </button>
          ) : (
            <button type="button" class="primary-button" onClick={run}>
              Запустить
            </button>
          )}
        </div>
      </section>
      <section class="scenario-edit-page">
        <div class="scenario-editor">
          <label class="scenario-name">
            <span>Название сценария</span>
            <input
              value={name}
              disabled={running}
              onInput={(e) => {
                setName(e.currentTarget.value);
                changeDraft();
              }}
            />
          </label>
          <div class="block-adder">
            <select
              value={selectedType}
              disabled={running}
              onChange={(e) => setSelectedType(e.currentTarget.value as BlockType)}
            >
              {blockCatalog.map((item) => (
                <option value={item.type}>{item.label}</option>
              ))}
            </select>
            <button type="button" onClick={add} disabled={running}>
              Добавить блок
            </button>
          </div>
          <p class="block-help">
            {blockCatalog.find((item) => item.type === selectedType)?.description}
          </p>
          <div class="scenario-blocks">
            {blocks.length ? (
              blocks.map((block, index) => (
                <article class="scenario-block" key={block.id}>
                  <div class="scenario-block-heading">
                    <span class="block-number">{index + 1}</span>
                    <div>
                      <h3>{blockLabel(block)}</h3>
                      <small>{block.type}</small>
                    </div>
                    <div class="block-actions">
                      <button
                        type="button"
                        disabled={index === 0 || running}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        disabled={index === blocks.length - 1 || running}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        class="danger-button"
                        disabled={running}
                        onClick={() => {
                          setBlocks((all) => all.filter((item) => item.id !== block.id));
                          changeDraft();
                        }}
                      >
                        Удалить
                      </button>
                    </div>
                  </div>
                  <Fields block={block} replace={replace} disabled={running} />
                </article>
              ))
            ) : (
              <div class="scenario-empty">Выберите тип блока выше и нажмите «Добавить блок».</div>
            )}
          </div>
          {errors.length > 0 && (
            <div class="scenario-errors">
              {errors.map((error) => (
                <p>{error}</p>
              ))}
            </div>
          )}
        </div>
        <aside class="scenario-run-panel">
          <p class="eyebrow">Результат запуска</p>
          <div class={`run-summary ${status}`}>{statusText}</div>
          <div class="run-entries">
            {entries.map((entry) => (
              <div class={`run-entry ${entry.status}`} key={entry.blockId}>
                <span>
                  {entry.status === "passed" ? "✓" : entry.status === "failed" ? "×" : "…"}
                </span>
                <div>
                  <strong>{entry.label}</strong>
                  <p>{entry.message}</p>
                </div>
              </div>
            ))}
            {!entries.length && (
              <p class="muted">После запуска здесь появятся результаты блоков.</p>
            )}
          </div>
        </aside>
      </section>
    </>
  );
}
