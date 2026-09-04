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
  status: "running" | "passed" | "warning" | "failed";
  message: string;
};
type FreshParameter = { name: string; value: number };
type MotorRotationCommand = {
  throttleChannel: number;
  inputPwm: number;
  minimumInputPwm: number;
  expectedServo1Pwm: number;
};
type RotationDecision = "correct" | "incorrect" | "notRotating" | "cancelled";
type RotationPrompt = {
  question: string;
  throttlePercent: number;
  rcChannel: number;
  inputPwm: number;
  servo1Pwm: number;
  averageCurrentA?: number;
  peakCurrentA?: number;
  averageControllerCurrentA?: number;
  peakControllerCurrentA?: number;
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
const TEMPLATE_SEEDED_KEY = "uav-test-station.motor-template.v19";
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
      durationSeconds: 1,
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
      comparisonToleranceA: 1,
      maximumDurationSeconds: 2,
      emergencyCurrentA: 35,
    },
    { id: "motor-8", type: "disarmController" },
    { id: "motor-9", type: "resultMessage", message: "Тест двигателя завершён" },
  ],
};

const motorTestTemplates: SavedScenario[] = [
  {
    id: "built-in-telemetry-check-v1",
    name: "00 — Проверка основной телеметрии",
    updatedAt: Date.now(),
    blocks: [
      { id: "telemetry-1", type: "requireController" },
      {
        id: "telemetry-2",
        type: "checkTelemetryAlive",
        seconds: 5,
        minimumChangingGroups: 2,
      },
      { id: "telemetry-3", type: "resultMessage", message: "Основная телеметрия проверена" },
    ],
  },
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
        durationSeconds: 1,
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
        type: "findCurrentLoad",
        targetCurrentA: 20,
        toleranceA: 2,
        startThrottlePercent: 28,
        throttleStepPercent: 2,
        maximumThrottlePercent: 65,
        pulseDurationSeconds: 1,
        holdDurationSeconds: 2,
        cooldownSeconds: 0.5,
        emergencyCurrentA: 35,
      },
      {
        id: "calibration-4",
        type: "calibrateControllerCurrent",
        parameterName: "BATT_AMP_PERVLT",
        targetCurrentA: 20,
        targetToleranceA: 2,
        comparisonToleranceA: 1,
        maximumDurationSeconds: 2,
        emergencyCurrentA: 35,
      },
      {
        id: "calibration-5",
        type: "resultMessage",
        message: "Показания тока контроллера откалиброваны",
      },
    ],
  },
  {
    id: "built-in-find-current-load-v1",
    name: "05 — Поиск нагрузки 20 А",
    updatedAt: Date.now(),
    blocks: [
      { id: "find-load-1", type: "prepareMotorTest", maximumIdleCurrentA: 1 },
      { id: "find-load-2", ...safetyConfirmation },
      {
        id: "find-load-3",
        type: "findCurrentLoad",
        targetCurrentA: 20,
        toleranceA: 2,
        startThrottlePercent: 28,
        throttleStepPercent: 2,
        maximumThrottlePercent: 65,
        pulseDurationSeconds: 1,
        holdDurationSeconds: 2,
        cooldownSeconds: 0.5,
        emergencyCurrentA: 35,
      },
      {
        id: "find-load-4",
        type: "calibrateControllerCurrent",
        parameterName: "BATT_AMP_PERVLT",
        targetCurrentA: 20,
        targetToleranceA: 2,
        comparisonToleranceA: 1,
        maximumDurationSeconds: 2,
        emergencyCurrentA: 35,
      },
      { id: "find-load-5", type: "disarmController" },
      {
        id: "find-load-6",
        type: "resultMessage",
        message: "Нагрузка 20 А найдена, FCA откалиброван по CA",
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
              template.id === "built-in-telemetry-check-v1" ||
              template.id === "built-in-find-current-load-v1" ||
              template.id === "built-in-current-calibration-v1" ||
              template.id === motorTestTemplate.id,
          )
          .map((template) => [template.id, template]),
      );
      const migrated = scenarios.map((scenario) => updatedBuiltIns.get(scenario.id) ?? scenario);
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
  if (block.type === "checkTelemetryAlive")
    return (
      <div class="block-fields">
        <label>
          Время проверки, с
          <input
            disabled={disabled}
            type="number"
            min="2"
            max="30"
            step="1"
            value={block.seconds}
            onInput={(e) => replace({ ...block, seconds: e.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Минимум изменяющихся групп
          <input
            disabled={disabled}
            type="number"
            min="1"
            max="4"
            step="1"
            value={block.minimumChangingGroups}
            onInput={(e) =>
              replace({ ...block, minimumChangingGroups: e.currentTarget.valueAsNumber })
            }
          />
        </label>
      </div>
    );
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
            max="5"
            value={block.throttlePercent}
            onInput={(e) => replace({ ...block, throttlePercent: e.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Длительность, с
          <select
            disabled={disabled}
            value={block.durationSeconds}
            onChange={(e) => replace({ ...block, durationSeconds: Number(e.currentTarget.value) })}
          >
            {Array.from({ length: 10 }, (_, index) => (index + 1) / 2).map((seconds) => (
              <option value={seconds}>{seconds.toLocaleString("ru-RU")}</option>
            ))}
          </select>
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
  if (block.type === "findCurrentLoad")
    return (
      <div class="block-fields three-fields">
        <label>
          Цель, A
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
          Начальный газ, % диапазона RC
          <input
            disabled={disabled}
            type="number"
            min="1"
            max="69"
            value={block.startThrottlePercent}
            onInput={(e) =>
              replace({ ...block, startThrottlePercent: e.currentTarget.valueAsNumber })
            }
          />
        </label>
        <label>
          Шаг газа, %
          <input
            disabled={disabled}
            type="number"
            min="1"
            max="10"
            value={block.throttleStepPercent}
            onInput={(e) =>
              replace({ ...block, throttleStepPercent: e.currentTarget.valueAsNumber })
            }
          />
        </label>
        <label>
          Максимальный газ, % диапазона RC
          <input
            disabled={disabled}
            type="number"
            min="2"
            max="70"
            value={block.maximumThrottlePercent}
            onInput={(e) =>
              replace({ ...block, maximumThrottlePercent: e.currentTarget.valueAsNumber })
            }
          />
        </label>
        <label>
          Импульс, с
          <select
            disabled={disabled}
            value={block.pulseDurationSeconds}
            onChange={(e) =>
              replace({ ...block, pulseDurationSeconds: Number(e.currentTarget.value) })
            }
          >
            {Array.from({ length: 10 }, (_, index) => (index + 1) / 2).map((seconds) => (
              <option value={seconds}>{seconds.toLocaleString("ru-RU")}</option>
            ))}
          </select>
        </label>
        <label>
          Удержание цели, с
          <select
            disabled={disabled}
            value={block.holdDurationSeconds}
            onChange={(e) =>
              replace({ ...block, holdDurationSeconds: Number(e.currentTarget.value) })
            }
          >
            {Array.from({ length: 10 }, (_, index) => (index + 1) / 2).map((seconds) => (
              <option value={seconds}>{seconds.toLocaleString("ru-RU")}</option>
            ))}
          </select>
        </label>
        <label>
          Пауза, с
          <select
            disabled={disabled}
            value={block.cooldownSeconds}
            onChange={(e) => replace({ ...block, cooldownSeconds: Number(e.currentTarget.value) })}
          >
            {Array.from({ length: 10 }, (_, index) => (index + 1) / 2).map((seconds) => (
              <option value={seconds}>{seconds.toLocaleString("ru-RU")}</option>
            ))}
          </select>
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
  const [status, setStatus] = useState<
    "idle" | "running" | "passed" | "warning" | "failed" | "cancelled"
  >("idle");
  const cancelled = useRef(false);
  const motorActive = useRef(false);
  const activeEmergencyCurrentA = useRef<number | null>(null);
  const overcurrentState = useRef({ startedAt: 0, consecutive: 0, peakA: 0 });
  const rotationDecisionResolver = useRef<((value: RotationDecision) => void) | null>(null);
  const [rotationPrompt, setRotationPrompt] = useState<RotationPrompt | null>(null);
  const stopReason = useRef("Остановлено оператором");
  const running = status === "running";
  const emergencyStop = async (reason = "Остановлено оператором") => {
    stopReason.current = reason;
    cancelled.current = true;
    rotationDecisionResolver.current?.("cancelled");
    rotationDecisionResolver.current = null;
    setRotationPrompt(null);
    try {
      await invoke("emergency_stop_motor");
    } catch (error) {
      console.error("Не удалось подтвердить аварийную остановку", error);
    } finally {
      motorActive.current = false;
      activeEmergencyCurrentA.current = null;
      overcurrentState.current = { startedAt: 0, consecutive: 0, peakA: 0 };
    }
  };
  const requestRotationDecision = (prompt: RotationPrompt) =>
    new Promise<RotationDecision>((resolve) => {
      rotationDecisionResolver.current = resolve;
      setRotationPrompt(prompt);
    });
  const answerRotationDecision = (decision: RotationDecision) => {
    const resolve = rotationDecisionResolver.current;
    rotationDecisionResolver.current = null;
    setRotationPrompt(null);
    resolve?.(decision);
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
    const limit = activeEmergencyCurrentA.current;
    const currentA = Math.abs(context.ammeterCurrentA ?? 0);
    const now = Date.now();
    let currentLimitExceeded = false;
    let currentLimitReason = "";
    if (running && motorActive.current && limit !== null && currentA >= limit * 1.5) {
      currentLimitExceeded = true;
      currentLimitReason = `Критический ток CA: ${currentA.toFixed(2)} A`;
    } else if (running && motorActive.current && limit !== null && currentA >= limit) {
      const state = overcurrentState.current;
      if (state.consecutive === 0) state.startedAt = now;
      state.consecutive += 1;
      state.peakA = Math.max(state.peakA, currentA);
      if (state.consecutive >= 3 && now - state.startedAt >= 200) {
        currentLimitExceeded = true;
        currentLimitReason = `Устойчивый аварийный ток CA: пик ${state.peakA.toFixed(2)} A, длительность ${now - state.startedAt} мс`;
      }
    } else {
      overcurrentState.current = { startedAt: 0, consecutive: 0, peakA: 0 };
    }
    if (
      running &&
      motorActive.current &&
      (!context.controllerConnected || !context.ammeterConnected || currentLimitExceeded)
    ) {
      const reason = currentLimitExceeded
        ? currentLimitReason
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
    const controllerIsArmed = () => latestContext.current.armed === true;
    let integratedCalibrationMessage: string | null = null;
    let runHasWarnings = false;
    for (const [blockIndex, block] of blocks.entries()) {
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
        let entryStatus: RunEntry["status"] = "passed";
        if (block.type === "checkTelemetryAlive") {
          if (!latestContext.current.controllerConnected)
            throw new Error("Полётный контроллер не подключён");
          const samples: NonNullable<ScenarioContext["telemetry"]>[] = [];
          const ammeterSamples: Array<{
            current?: number;
            voltage?: number;
            messageCount?: number;
          }> = [];
          const deadline = Date.now() + block.seconds * 1000;
          while (Date.now() < deadline) {
            const sample = latestContext.current.telemetry;
            if (sample) samples.push({ ...sample });
            if (latestContext.current.ammeterConnected)
              ammeterSamples.push({
                current: latestContext.current.ammeterCurrentA,
                voltage: latestContext.current.ammeterSensorVoltage,
                messageCount: latestContext.current.ammeterMessageCount,
              });
            await new Promise((resolve) => window.setTimeout(resolve, 250));
            if (cancelled.current) throw new Error("Выполнение отменено оператором");
          }
          if (samples.length < 2) throw new Error("Не получены снимки основной телеметрии");
          const first = samples[0];
          const last = samples[samples.length - 1];
          const stale = [
            ["батарея", first.batteryUpdateCount, last.batteryUpdateCount],
            ["ASPD", first.airspeedUpdateCount, last.airspeedUpdateCount],
            ["барометр", first.barometerUpdateCount, last.barometerUpdateCount],
            ["IMU", first.imuUpdateCount, last.imuUpdateCount],
            ["RC input", first.rcUpdateCount, last.rcUpdateCount],
          ].filter(([, start, end]) => end === start);
          if (stale.length)
            throw new Error(
              `Не обновляются группы телеметрии: ${stale.map(([label]) => label).join(", ")}`,
            );
          const required = [
            ["напряжение батареи", last.batteryVoltageV],
            ["текущий ток", last.batteryCurrentA],
            ["заряд батареи", last.batteryRemainingPercent],
            ["ASPD", last.airspeedMps],
            ["барометр", last.barometerPressureHpa],
            ["температура барометра", last.barometerTemperatureC],
            ["акселерометр X", last.accelerometerXMg],
            ["акселерометр Y", last.accelerometerYMg],
            ["акселерометр Z", last.accelerometerZMg],
            ["курс компаса", last.compassHeadingDeg],
          ] as const;
          const missing = required.filter(
            ([, value]) => value === undefined || !Number.isFinite(value),
          );
          if (missing.length)
            throw new Error(`Нет корректных данных: ${missing.map(([label]) => label).join(", ")}`);
          if (last.armed === undefined) throw new Error("Нет данных ARM/DISARM");
          const rcCount = Math.min(last.rcChannelCount ?? 0, last.rcChannels?.length ?? 0, 18);
          if (!rcCount) throw new Error("Нет данных RC input");
          const rcValues = last.rcChannels!.slice(0, rcCount);
          if (rcValues.some((value) => !Number.isFinite(value) || value === 0xffff))
            throw new Error("В RC input есть отсутствующие или некорректные каналы");
          const ammeterFirst = ammeterSamples[0];
          const ammeterLast = ammeterSamples[ammeterSamples.length - 1];
          if (latestContext.current.ammeterConnected) {
            if (
              !ammeterFirst ||
              !ammeterLast ||
              ammeterLast.current === undefined ||
              !Number.isFinite(ammeterLast.current) ||
              ammeterLast.voltage === undefined ||
              !Number.isFinite(ammeterLast.voltage)
            )
              throw new Error("Нет корректных данных внешнего амперметра");
            if (ammeterFirst.messageCount === ammeterLast.messageCount)
              throw new Error("Не обновляются данные внешнего амперметра");
          }
          const range = (values: Array<number | undefined>) => {
            const finite = values.filter(
              (value): value is number => value !== undefined && Number.isFinite(value),
            );
            return finite.length ? Math.max(...finite) - Math.min(...finite) : 0;
          };
          const batteryVoltageRange = range(samples.map((sample) => sample.batteryVoltageV));
          const batteryCurrentRange = range(samples.map((sample) => sample.batteryCurrentA));
          const airspeedRange = range(samples.map((sample) => sample.airspeedMps));
          const pressureRange = range(samples.map((sample) => sample.barometerPressureHpa));
          const accelerometerXRange = range(samples.map((sample) => sample.accelerometerXMg));
          const accelerometerYRange = range(samples.map((sample) => sample.accelerometerYMg));
          const accelerometerZRange = range(samples.map((sample) => sample.accelerometerZMg));
          const headingRange = range(samples.map((sample) => sample.compassHeadingDeg));
          const groupChanges = {
            battery: batteryVoltageRange >= 0.001 || batteryCurrentRange >= 0.01,
            airspeed: airspeedRange >= 0.01,
            barometer: pressureRange >= 0.01,
            imu:
              accelerometerXRange >= 1 ||
              accelerometerYRange >= 1 ||
              accelerometerZRange >= 1 ||
              headingRange >= 1,
          };
          const changing = Object.values(groupChanges).filter(Boolean).length;
          const state = (changed: boolean) => (changed ? "ИЗМЕНЯЕТСЯ" : "СТАБИЛЬНО");
          const report = [
            `Проверено за ${block.seconds} с (${samples.length} снимков):`,
            `Контроллер — ${last.armed ? "ARMED" : "DISARMED"}`,
            `Батарея — ${state(groupChanges.battery)}, обновлений: ${last.batteryUpdateCount - first.batteryUpdateCount}`,
            `  Напряжение: ${last.batteryVoltageV!.toFixed(3)} V; разброс: ${batteryVoltageRange.toFixed(3)} V`,
            `  Ток: ${last.batteryCurrentA!.toFixed(3)} A; разброс: ${batteryCurrentRange.toFixed(3)} A`,
            `  Заряд: ${last.batteryRemainingPercent}%`,
            `ASPD — ${state(groupChanges.airspeed)}, обновлений: ${last.airspeedUpdateCount - first.airspeedUpdateCount}`,
            `  Значение: ${last.airspeedMps!.toFixed(3)} m/s; разброс: ${airspeedRange.toFixed(3)} m/s`,
            `Барометр — ${state(groupChanges.barometer)}, обновлений: ${last.barometerUpdateCount - first.barometerUpdateCount}`,
            `  Давление: ${last.barometerPressureHpa!.toFixed(2)} hPa; разброс: ${pressureRange.toFixed(2)} hPa`,
            `  Температура: ${last.barometerTemperatureC!.toFixed(1)} °C`,
            `IMU — ${state(groupChanges.imu)}, обновлений: ${last.imuUpdateCount - first.imuUpdateCount}`,
            `  Акселерометр: X=${last.accelerometerXMg} mg (разброс ${accelerometerXRange.toFixed(0)}), Y=${last.accelerometerYMg} mg (разброс ${accelerometerYRange.toFixed(0)}), Z=${last.accelerometerZMg} mg (разброс ${accelerometerZRange.toFixed(0)})`,
            `  Курс компаса: ${last.compassHeadingDeg}°; разброс: ${headingRange.toFixed(0)}°`,
            `RC input — обновлений: ${last.rcUpdateCount - first.rcUpdateCount}; каналов: ${rcCount}`,
            `  ${rcValues.map((value, index) => `CH${index + 1}=${value}`).join(", ")}`,
            ...(latestContext.current.ammeterConnected
              ? [
                  `Внешний амперметр — обновлений: ${(ammeterLast!.messageCount ?? 0) - (ammeterFirst!.messageCount ?? 0)}`,
                  `  Эталонный ток: ${ammeterLast!.current!.toFixed(3)} A; напряжение датчика: ${ammeterLast!.voltage!.toFixed(3)} V`,
                ]
              : ["Внешний амперметр — не подключён, на экране не отображается"]),
            `Итог: изменяются ${changing} из 4 групп (требуется минимум ${block.minimumChangingGroups}).`,
          ].join("\n");
          if (changing < block.minimumChangingGroups)
            throw new Error(`Недостаточно живых показаний.\n${report}`);
          const zeroValues: string[] = required
            .filter(([, value]) => value === 0)
            .map(([label]) => label);
          rcValues.forEach((value, index) => {
            if (value === 0) zeroValues.push(`RC CH${index + 1}`);
          });
          if (latestContext.current.ammeterConnected) {
            if (ammeterLast!.current === 0) zeroValues.push("эталонный ток");
            if (ammeterLast!.voltage === 0) zeroValues.push("напряжение внешнего датчика");
          }
          if (zeroValues.length) {
            entryStatus = "warning";
            runHasWarnings = true;
            message = `ВНИМАНИЕ! НУЛЕВЫЕ ПОКАЗАНИЯ: ${zeroValues.join(", ")}.
ОПЕРАТОР ДОЛЖЕН УТОЧНИТЬ ДАННЫЕ.

${report}`;
          } else {
            message = report;
          }
        } else if (block.type === "wait") {
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
            while (!controllerIsArmed() && Date.now() < deadline) {
              await new Promise((resolve) => window.setTimeout(resolve, 100));
              if (cancelled.current) throw new Error(stopReason.current);
            }
            if (!controllerIsArmed()) {
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
          const currentSamplesA: number[] = [];
          const controllerCurrentSamplesA: number[] = [];
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
            const currentA = latestContext.current.ammeterCurrentA;
            const controllerCurrentA = latestContext.current.controllerCurrentA;
            if (
              currentA !== undefined &&
              Number.isFinite(currentA) &&
              output !== undefined &&
              output >= motorCommand.expectedServo1Pwm - 40 &&
              Date.now() - startedAt <= block.durationSeconds * 1000
            )
              currentSamplesA.push(Math.abs(currentA));
            if (
              controllerCurrentA !== undefined &&
              Number.isFinite(controllerCurrentA) &&
              output !== undefined &&
              output >= motorCommand.expectedServo1Pwm - 40 &&
              Date.now() - startedAt <= block.durationSeconds * 1000
            )
              controllerCurrentSamplesA.push(Math.abs(controllerCurrentA));
            if (Date.now() >= nextDiagnosticAt) {
              const elapsedSeconds = (Date.now() - startedAt) / 1000;
              const sample = `${elapsedSeconds.toFixed(1)}с: ARM=${latestContext.current.armed === true ? "да" : "нет"}, RC${motorCommand.throttleChannel}=${input ?? "—"}, SERVO1=${output ?? "—"}, FCA=${controllerCurrentA?.toFixed(2) ?? "—"} A, CA=${currentA?.toFixed(2) ?? "—"} A`;
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
          const averageCurrentA = currentSamplesA.length
            ? currentSamplesA.reduce((sum, value) => sum + value, 0) / currentSamplesA.length
            : undefined;
          const peakCurrentA = currentSamplesA.length ? Math.max(...currentSamplesA) : undefined;
          const averageControllerCurrentA = controllerCurrentSamplesA.length
            ? controllerCurrentSamplesA.reduce((sum, value) => sum + value, 0) /
              controllerCurrentSamplesA.length
            : undefined;
          const peakControllerCurrentA = controllerCurrentSamplesA.length
            ? Math.max(...controllerCurrentSamplesA)
            : undefined;
          const rotationDecision = await requestRotationDecision({
            question: block.confirmation,
            throttlePercent: block.throttlePercent,
            rcChannel: motorCommand.throttleChannel,
            inputPwm: observedInputPwm,
            servo1Pwm: observedServo1Pwm,
            averageCurrentA,
            peakCurrentA,
            averageControllerCurrentA,
            peakControllerCurrentA,
          });
          if (rotationDecision === "cancelled") throw new Error(stopReason.current);
          if (rotationDecision === "incorrect")
            throw new Error(
              `Двигатель вращался в неправильном направлении. Лог: ${diagnostics.join("; ")}`,
            );
          if (rotationDecision === "notRotating")
            throw new Error(`Двигатель не вращался. Лог: ${diagnostics.join("; ")}`);
          message = `Вращение подтверждено: газ ${block.throttlePercent}%, ${block.durationSeconds} с; FCA ${averageControllerCurrentA?.toFixed(2) ?? "нет данных"} A (пик ${peakControllerCurrentA?.toFixed(2) ?? "нет данных"} A); CA ${averageCurrentA?.toFixed(2) ?? "нет данных"} A (пик ${peakCurrentA?.toFixed(2) ?? "нет данных"} A)`;
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
        } else if (block.type === "findCurrentLoad") {
          const followingBlock = blocks[blockIndex + 1];
          const calibrationBlock =
            followingBlock?.type === "calibrateControllerCurrent" ? followingBlock : null;
          const attemptLogs: string[] = [];
          const currentHistory: string[] = [];
          let reachedMessage: string | null = null;
          let reachedThrottle: number | null = null;
          let lastCaAverage: number | null = null;
          let lastFcaAverage: number | null = null;
          let lastThrottle: number | null = null;
          const measuredPoints: Array<{ throttle: number; current: number }> = [];
          let throttle = block.startThrottlePercent;
          let searchAttempts = 0;
          while (
            searchAttempts < 12 &&
            throttle >= 1 &&
            throttle <= block.maximumThrottlePercent + 1e-6
          ) {
            searchAttempts += 1;
            if (cancelled.current) throw new Error(stopReason.current);
            updateEntry(block.id, {
              message: `Установка ступени ${throttle}%… ${attemptLogs.join(" | ")}`,
            });
            if (latestContext.current.armed !== true) {
              await invoke("set_flight_controller_armed", { armed: true, force: true });
              const armDeadline = Date.now() + 5000;
              while (!controllerIsArmed() && Date.now() < armDeadline) {
                await new Promise((resolve) => window.setTimeout(resolve, 100));
                if (cancelled.current) throw new Error(stopReason.current);
              }
              if (!controllerIsArmed())
                throw new Error(`ARM не подтверждён перед ступенью ${throttle}%`);
            }

            motorActive.current = true;
            activeEmergencyCurrentA.current = block.emergencyCurrentA;
            const controlLeaseSeconds = Math.min(
              5,
              block.pulseDurationSeconds + block.cooldownSeconds + 0.5,
            );
            const command = await invoke<MotorRotationCommand>("start_motor_rotation", {
              throttlePercent: throttle,
              durationSeconds: controlLeaseSeconds,
            });
            const startedAt = Date.now();
            const deadline = startedAt + block.pulseDurationSeconds * 1000;
            const caSamples: number[] = [];
            const fcaSamples: number[] = [];
            let nextCurrentLogAt = startedAt;
            let bestRc: number | undefined;
            let lastReportedRc: number | undefined;
            let maxServo1: number | undefined;
            while (Date.now() < deadline) {
              await new Promise((resolve) => window.setTimeout(resolve, 50));
              const rc = latestContext.current.rcChannels?.[command.throttleChannel - 1];
              lastReportedRc = rc;
              const servo1 = latestContext.current.servo1OutputPwm;
              if (
                rc !== undefined &&
                rc >= 800 &&
                rc <= 2200 &&
                (bestRc === undefined ||
                  Math.abs(rc - command.inputPwm) < Math.abs(bestRc - command.inputPwm))
              )
                bestRc = rc;
              if (servo1 !== undefined && (maxServo1 === undefined || servo1 > maxServo1))
                maxServo1 = servo1;
              const underLoad = servo1 !== undefined && servo1 >= command.expectedServo1Pwm - 40;
              const elapsedLoadMs = Date.now() - startedAt;
              if (
                underLoad &&
                elapsedLoadMs >= block.pulseDurationSeconds * 500 &&
                elapsedLoadMs <= block.pulseDurationSeconds * 1000
              ) {
                const ca = latestContext.current.ammeterCurrentA;
                const fca = latestContext.current.controllerCurrentA;
                if (ca !== undefined && Number.isFinite(ca)) caSamples.push(Math.abs(ca));
                if (fca !== undefined && Number.isFinite(fca)) fcaSamples.push(Math.abs(fca));
              }
              if (Date.now() >= nextCurrentLogAt) {
                currentHistory.push(
                  `${throttle}%/${((Date.now() - startedAt) / 1000).toFixed(1)}с: FCA=${latestContext.current.controllerCurrentA?.toFixed(2) ?? "—"} A, CA=${latestContext.current.ammeterCurrentA?.toFixed(2) ?? "—"} A`,
                );
                nextCurrentLogAt += 100;
              }
              updateEntry(block.id, {
                message: `Ступень ${throttle}%: RC${command.throttleChannel}=${rc ?? "—"}, SERVO1=${servo1 ?? "—"}, FCA=${latestContext.current.controllerCurrentA?.toFixed(2) ?? "—"} A, CA=${latestContext.current.ammeterCurrentA?.toFixed(2) ?? "—"} A`,
              });
              if (cancelled.current)
                throw new Error(`${stopReason.current}. Все токи: ${currentHistory.join("; ")}`);
            }
            if (bestRc !== undefined && Math.abs(bestRc - command.inputPwm) > 25)
              throw new Error(`На ${throttle}% RC override не подтверждён: RC=${bestRc ?? "—"}`);
            if (maxServo1 === undefined || maxServo1 < command.expectedServo1Pwm - 40)
              throw new Error(`На ${throttle}% SERVO1 не достиг команды: ${maxServo1 ?? "—"} мкс`);
            if (!caSamples.length)
              throw new Error(`На ${throttle}% нет свежих данных внешнего амперметра`);
            const average = (values: number[]) =>
              values.reduce((sum, value) => sum + value, 0) / values.length;
            const caAverage = average(caSamples);
            const caPeak = Math.max(...caSamples);
            const fcaAverage = fcaSamples.length ? average(fcaSamples) : undefined;
            const fcaPeak = fcaSamples.length ? Math.max(...fcaSamples) : undefined;
            lastCaAverage = caAverage;
            lastFcaAverage = fcaAverage ?? null;
            lastThrottle = throttle;
            measuredPoints.push({ throttle, current: caAverage });
            const spikeWarning =
              caPeak >= block.emergencyCurrentA ? `, одиночный пик CA ${caPeak.toFixed(2)} A` : "";
            const rcReport =
              bestRc !== undefined
                ? `${bestRc}`
                : `нет телеметрии (последнее ${lastReportedRc ?? "—"})`;
            const attempt = `${throttle}%: RC${command.throttleChannel}=${rcReport}, SERVO1=${maxServo1}, FCA=${fcaAverage?.toFixed(2) ?? "—"} A (пик ${fcaPeak?.toFixed(2) ?? "—"}), CA=${caAverage.toFixed(2)} A (пик ${caPeak.toFixed(2)})${spikeWarning}`;
            attemptLogs.push(attempt);
            updateEntry(block.id, { message: attemptLogs.join(" | ") });
            if (
              caAverage >= block.targetCurrentA - block.toleranceA &&
              caAverage <= block.targetCurrentA + block.toleranceA
            ) {
              reachedMessage = `Нагрузка найдена на ${throttle}%: FCA ${fcaAverage?.toFixed(2) ?? "—"} A (пик ${fcaPeak?.toFixed(2) ?? "—"}), CA ${caAverage.toFixed(2)} A (пик ${caPeak.toFixed(2)}). Лог: ${attemptLogs.join(" | ")}`;
              reachedThrottle = throttle;
              break;
            }
            const lowerPoints = measuredPoints
              .filter((point) => point.current < block.targetCurrentA && point.throttle < throttle)
              .sort((left, right) => right.current - left.current);
            const upperPoints = measuredPoints
              .filter((point) => point.current > block.targetCurrentA && point.throttle > throttle)
              .sort((left, right) => left.current - right.current);
            let nextThrottle: number;
            let estimationMethod: string;
            if (caAverage > block.targetCurrentA + block.toleranceA) {
              const lower = lowerPoints[0];
              if (lower && caAverage > lower.current) {
                const interpolated =
                  lower.throttle +
                  ((block.targetCurrentA - lower.current) * (throttle - lower.throttle)) /
                    (caAverage - lower.current);
                nextThrottle = Math.max(
                  lower.throttle + 1,
                  Math.min(throttle - 1, Math.round(interpolated)),
                );
                estimationMethod = `уточнение между ${lower.throttle}% и ${throttle}%`;
              } else {
                nextThrottle = Math.max(1, throttle - block.throttleStepPercent);
                estimationMethod = "уточнение вниз";
              }
            } else {
              const upper = upperPoints[0];
              const previousPoint = measuredPoints.at(-2);
              if (upper && upper.current > caAverage) {
                const interpolated =
                  throttle +
                  ((block.targetCurrentA - caAverage) * (upper.throttle - throttle)) /
                    (upper.current - caAverage);
                nextThrottle = Math.max(
                  throttle + 1,
                  Math.min(upper.throttle - 1, Math.round(interpolated)),
                );
                estimationMethod = `уточнение между ${throttle}% и ${upper.throttle}%`;
              } else {
                const currentSlope = previousPoint
                  ? (caAverage - previousPoint.current) / (throttle - previousPoint.throttle)
                  : 0;
                const estimatedThrottle =
                  previousPoint && currentSlope > 0.2
                    ? throttle + (block.targetCurrentA - caAverage) / currentSlope
                    : caAverage > 0.5
                      ? throttle * Math.cbrt(block.targetCurrentA / caAverage)
                      : throttle + 5;
                nextThrottle = Math.min(
                  block.maximumThrottlePercent,
                  Math.max(
                    throttle + block.throttleStepPercent,
                    Math.min(throttle + 7, Math.round(estimatedThrottle)),
                  ),
                );
                estimationMethod =
                  previousPoint && currentSlope > 0.2
                    ? "по двум последним точкам"
                    : "по текущей точке";
              }
            }
            if (Math.abs(nextThrottle - throttle) < 1e-6) break;
            attemptLogs.push(`следующий газ ${nextThrottle}% (${estimationMethod})`);
            updateEntry(block.id, { message: attemptLogs.join(" | ") });
            if (nextThrottle <= block.maximumThrottlePercent) {
              const cooldownDeadline = Date.now() + block.cooldownSeconds * 1000;
              while (Date.now() < cooldownDeadline) {
                await new Promise((resolve) => window.setTimeout(resolve, 100));
                if (cancelled.current) throw new Error(stopReason.current);
              }
            }
            throttle = nextThrottle;
          }
          if (!reachedMessage)
            throw new Error(
              `Целевой ток не найден за ${searchAttempts} измерений. Последнее измерение на ${lastThrottle ?? block.maximumThrottlePercent}%: CA=${lastCaAverage?.toFixed(2) ?? "—"} A, FCA=${lastFcaAverage?.toFixed(2) ?? "—"} A; требуется CA ${block.targetCurrentA}±${block.toleranceA} A. Максимальный разрешённый газ ${block.maximumThrottlePercent}%, аварийная защита не срабатывала. Лог: ${attemptLogs.join(" | ")}`,
            );
          const holdThrottle = reachedThrottle!;
          if (latestContext.current.armed !== true)
            throw new Error(`ARM потерян перед удержанием ${holdThrottle}%`);
          motorActive.current = true;
          activeEmergencyCurrentA.current = block.emergencyCurrentA;
          const holdCommand = await invoke<MotorRotationCommand>("start_motor_rotation", {
            throttlePercent: holdThrottle,
            durationSeconds: calibrationBlock ? 5 : block.holdDurationSeconds,
          });
          const holdStartedAt = Date.now();
          const holdDeadline = holdStartedAt + block.holdDurationSeconds * 1000;
          const holdCa: number[] = [];
          const holdFca: number[] = [];
          const holdHistory: string[] = [];
          let nextHoldLogAt = holdStartedAt;
          while (Date.now() < holdDeadline) {
            await new Promise((resolve) => window.setTimeout(resolve, 50));
            const elapsedMs = Date.now() - holdStartedAt;
            const servo1 = latestContext.current.servo1OutputPwm;
            const ca = latestContext.current.ammeterCurrentA;
            const fca = latestContext.current.controllerCurrentA;
            if (
              elapsedMs <= block.holdDurationSeconds * 1000 &&
              elapsedMs >= Math.min(300, block.holdDurationSeconds * 250) &&
              servo1 !== undefined &&
              servo1 >= holdCommand.expectedServo1Pwm - 40
            ) {
              if (ca !== undefined && Number.isFinite(ca)) holdCa.push(Math.abs(ca));
              if (fca !== undefined && Number.isFinite(fca)) holdFca.push(Math.abs(fca));
            }
            if (Date.now() >= nextHoldLogAt) {
              const sample = `${(elapsedMs / 1000).toFixed(1)}с: FCA=${fca?.toFixed(2) ?? "—"} A, CA=${ca?.toFixed(2) ?? "—"} A`;
              holdHistory.push(sample);
              updateEntry(block.id, {
                message: `Удержание ${holdThrottle}% (${Math.min(elapsedMs / 1000, block.holdDurationSeconds).toFixed(1)}/${block.holdDurationSeconds.toFixed(1)} с): FCA=${fca?.toFixed(2) ?? "—"} A, CA=${ca?.toFixed(2) ?? "—"} A`,
              });
              nextHoldLogAt += 100;
            }
            if (cancelled.current)
              throw new Error(`${stopReason.current}. Удержание: ${holdHistory.join("; ")}`);
          }
          if (!holdCa.length) throw new Error("Нет данных CA во время удержания цели");
          const holdAverage = (values: number[]) =>
            values.reduce((sum, value) => sum + value, 0) / values.length;
          const holdCaAverage = holdAverage(holdCa);
          const holdCaPeak = Math.max(...holdCa);
          const sortedHoldCa = [...holdCa].sort((left, right) => left - right);
          const middle = Math.floor(sortedHoldCa.length / 2);
          const holdCaMedian =
            sortedHoldCa.length % 2
              ? sortedHoldCa[middle]
              : (sortedHoldCa[middle - 1] + sortedHoldCa[middle]) / 2;
          const holdFcaAverage = holdFca.length ? holdAverage(holdFca) : undefined;
          const holdFcaPeak = holdFca.length ? Math.max(...holdFca) : undefined;
          if (Math.abs(holdCaAverage - block.targetCurrentA) > block.toleranceA)
            throw new Error(
              `При удержании CA вышел из диапазона: средний ${holdCaAverage.toFixed(2)} A. ${holdHistory.join("; ")}`,
            );
          const holdSpikeWarning =
            holdCaPeak >= block.emergencyCurrentA
              ? ` Одиночный пик CA ${holdCaPeak.toFixed(2)} A отмечен как предупреждение.`
              : "";
          if (holdFcaAverage === undefined)
            throw new Error("Нет данных FCA во время удержания цели");
          if (calibrationBlock) {
            const parameterName = calibrationBlock.parameterName.trim().toUpperCase();
            const originalParameter = await invoke<FreshParameter>(
              "read_flight_controller_parameter",
              {
                name: parameterName,
              },
            );
            let currentParameterValue = originalParameter.value;
            let measuredCa = holdCaAverage;
            let measuredFca = holdFcaAverage;
            const calibrationLogs: string[] = [];
            let calibrated = false;
            for (let attempt = 1; attempt <= 3; attempt += 1) {
              const beforeDifference = Math.abs(measuredFca - measuredCa);
              if (beforeDifference <= calibrationBlock.comparisonToleranceA) {
                calibrated = true;
                calibrationLogs.push(
                  `попытка ${attempt}: коррекция не нужна, разница ${beforeDifference.toFixed(2)} A`,
                );
                break;
              }
              const ratio = measuredCa / measuredFca;
              if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 2)
                throw new Error(
                  `Небезопасный коэффициент коррекции ${ratio.toFixed(3)}; параметр не изменён`,
                );
              const requestedValue = currentParameterValue * ratio;
              await invoke<MotorRotationCommand>("start_motor_rotation", {
                throttlePercent: holdThrottle,
                durationSeconds: 5,
              });
              await invoke("write_flight_controller_parameters", {
                requests: [{ name: parameterName, value: requestedValue }],
              });
              await new Promise((resolve) => window.setTimeout(resolve, 1000));
              const confirmed = await invoke<FreshParameter>("read_flight_controller_parameter", {
                name: parameterName,
              });
              if (
                Math.abs(confirmed.value - requestedValue) >
                Math.max(0.01, Math.abs(requestedValue) * 0.005)
              )
                throw new Error(
                  `Запись ${parameterName} не подтверждена: ожидалось ${requestedValue.toFixed(4)}, получено ${confirmed.value.toFixed(4)}`,
                );
              currentParameterValue = confirmed.value;
              await invoke<MotorRotationCommand>("start_motor_rotation", {
                throttlePercent: holdThrottle,
                durationSeconds: Math.min(5, calibrationBlock.maximumDurationSeconds + 1),
              });
              const verifyStartedAt = Date.now();
              const verifyDeadline =
                verifyStartedAt + calibrationBlock.maximumDurationSeconds * 1000;
              const verifyCa: number[] = [];
              const verifyFca: number[] = [];
              while (Date.now() < verifyDeadline) {
                await new Promise((resolve) => window.setTimeout(resolve, 50));
                const ca = latestContext.current.ammeterCurrentA;
                const fca = latestContext.current.controllerCurrentA;
                if (Date.now() - verifyStartedAt >= 500) {
                  if (ca !== undefined && Number.isFinite(ca)) verifyCa.push(Math.abs(ca));
                  if (fca !== undefined && Number.isFinite(fca)) verifyFca.push(Math.abs(fca));
                }
                updateEntry(block.id, {
                  message: `Калибровка ${attempt}/3 без изменения газа (${holdThrottle}%): FCA=${fca?.toFixed(2) ?? "—"} A, CA=${ca?.toFixed(2) ?? "—"} A`,
                });
                if (cancelled.current) throw new Error(stopReason.current);
              }
              if (!verifyCa.length || !verifyFca.length)
                throw new Error(`Недостаточно данных для проверки попытки ${attempt}`);
              measuredCa = holdAverage(verifyCa);
              measuredFca = holdAverage(verifyFca);
              const difference = Math.abs(measuredFca - measuredCa);
              calibrationLogs.push(
                `попытка ${attempt}: ${parameterName}=${currentParameterValue.toFixed(4)}, FCA=${measuredFca.toFixed(2)} A, CA=${measuredCa.toFixed(2)} A, разница ${difference.toFixed(2)} A`,
              );
              if (difference <= calibrationBlock.comparisonToleranceA) {
                calibrated = true;
                break;
              }
            }
            if (!calibrated) {
              await invoke("write_flight_controller_parameters", {
                requests: [{ name: parameterName, value: originalParameter.value }],
              });
              throw new Error(
                `Калибровка не достигла допуска ±${calibrationBlock.comparisonToleranceA} A за 3 попытки. Старое значение ${originalParameter.value.toFixed(4)} отправлено на восстановление. ${calibrationLogs.join(" | ")}`,
              );
            }
            integratedCalibrationMessage = `${parameterName}: ${originalParameter.value.toFixed(4)} → ${currentParameterValue.toFixed(4)}; газ непрерывно удерживался на ${holdThrottle}%. ${calibrationLogs.join(" | ")}`;
          }
          await invoke("emergency_stop_motor");
          motorActive.current = false;
          activeEmergencyCurrentA.current = null;
          message = `Нагрузка удерживалась ${block.holdDurationSeconds} с на ${holdThrottle}%: FCA ${holdFcaAverage?.toFixed(2) ?? "—"} A (пик ${holdFcaPeak?.toFixed(2) ?? "—"}), CA средний ${holdCaAverage.toFixed(2)} A, медиана ${holdCaMedian.toFixed(2)} A (пик ${holdCaPeak.toFixed(2)}).${holdSpikeWarning} Поиск: ${attemptLogs.join(" | ")}. Удержание: ${holdHistory.join("; ")}`;
        } else if (block.type === "calibrateControllerCurrent") {
          if (!integratedCalibrationMessage)
            throw new Error("Блок калибровки должен находиться сразу после поиска нагрузки");
          message = integratedCalibrationMessage;
          integratedCalibrationMessage = null;
        } else if (block.type === "measureMaximumCurrent" || block.type === "tuneRcMaxByCurrent") {
          throw new Error(
            "Моторный backend ещё не активирован: управляющая команда не отправлялась",
          );
        } else message = evaluateImmediateBlock(block, latestContext.current);
        updateEntry(block.id, { status: entryStatus, message });
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
    setStatus(runHasWarnings ? "warning" : "passed");
  };
  const statusText = {
    idle: "Ещё не запускался",
    running: "Выполняется",
    passed: "Успешно",
    warning: "Требуется проверка оператора",
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
                  {entry.status === "passed"
                    ? "✓"
                    : entry.status === "warning"
                      ? "!"
                      : entry.status === "failed"
                        ? "×"
                        : "…"}
                </span>
                <div>
                  <strong>{entry.label}</strong>
                  {entry.status === "warning" ? (
                    <>
                      <div class="run-warning-banner">{entry.message.split("\n\n")[0]}</div>
                      <p>{entry.message.split("\n\n").slice(1).join("\n\n")}</p>
                    </>
                  ) : (
                    <p>{entry.message}</p>
                  )}
                </div>
              </div>
            ))}
            {!entries.length && (
              <p class="muted">После запуска здесь появятся результаты блоков.</p>
            )}
          </div>
        </aside>
      </section>
      {rotationPrompt && (
        <div class="rotation-prompt-backdrop" role="presentation">
          <section class="rotation-prompt" role="dialog" aria-modal="true">
            <p class="eyebrow">Проверка оператором</p>
            <h2>{rotationPrompt.question}</h2>
            <p>
              Газ {rotationPrompt.throttlePercent}% · RC{rotationPrompt.rcChannel}=
              {rotationPrompt.inputPwm} мкс · SERVO1={rotationPrompt.servo1Pwm} мкс
            </p>
            <p>
              FCA: средний {rotationPrompt.averageControllerCurrentA?.toFixed(2) ?? "нет данных"} A
              · пик {rotationPrompt.peakControllerCurrentA?.toFixed(2) ?? "нет данных"} A
            </p>
            <p>
              CA: средний {rotationPrompt.averageCurrentA?.toFixed(2) ?? "нет данных"} A · пик{" "}
              {rotationPrompt.peakCurrentA?.toFixed(2) ?? "нет данных"} A
            </p>
            <div class="rotation-prompt-actions">
              <button
                type="button"
                class="primary-button"
                onClick={() => answerRotationDecision("correct")}
              >
                Вращался правильно
              </button>
              <button type="button" onClick={() => answerRotationDecision("incorrect")}>
                Вращался неправильно
              </button>
              <button
                type="button"
                class="danger-button"
                onClick={() => answerRotationDecision("notRotating")}
              >
                Не вращался
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
