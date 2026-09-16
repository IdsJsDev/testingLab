import { confirm } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  blockCatalog,
  blockLabel,
  evaluateImmediateBlock,
  evaluateParameterValue,
  telemetrySignalCatalog,
  validateScenario,
  type BlockType,
  type ScenarioBlock,
  type ScenarioContext,
} from "./scenario-engine";
import { UiInput, UiSelect } from "./ui";

type RunEntry = {
  blockId: string;
  label: string;
  status: "running" | "passed" | "warning" | "failed" | "skipped";
  message: string;
};
type SavedRunReport = {
  format: "uav-test-station-report";
  version: 1;
  id: string;
  scenarioId: string;
  scenarioName: string;
  serialNumber?: string;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "warning" | "failed" | "cancelled";
  entries: RunEntry[];
};
type FreshParameter = { name: string; value: number };
type MotorRotationCommand = {
  throttleChannel: number;
  inputPwm: number;
  minimumInputPwm: number;
  motorOutput: number;
  expectedServo1Pwm: number;
};
type RotationDecision = "correct" | "incorrect" | "notRotating" | "cancelled";
type RotationPrompt = {
  question: string;
  throttlePercent: number;
  rcChannel: number;
  inputPwm: number;
  motorOutput: number;
  servoOutputPwm: number;
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
  archived?: boolean;
};

const STORAGE_KEY = "uav-test-station.scenarios.v1";
const SERIAL_NUMBER_KEY = "uav-test-station.device-serial-number.v1";
const TEMPLATE_SEEDED_KEY = "uav-test-station.motor-template.v30";
const motorTestTemplate: SavedScenario = {
  id: "built-in-motor-test-v1",
  name: "04 — Тест двигателя БПЛА",
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
  ],
};

const motorTestTemplates: SavedScenario[] = [
  {
    id: "built-in-telemetry-check-v1",
    name: "00 — Проверка основной телеметрии",
    updatedAt: Date.now(),
    blocks: [
      { id: "telemetry-1", type: "requireController" },
      ...telemetrySignalCatalog.map((signal, index) => ({
        id: `telemetry-${index + 2}`,
        type: "checkTelemetrySignal" as const,
        signal: signal.id,
        durationSeconds: 2,
        minimum: signal.defaultMinimum,
        maximum: signal.defaultMaximum,
        requireUpdates: true,
        behavior: "any" as const,
        variation: signal.defaultVariation,
      })),
    ],
  },
  {
    id: "built-in-motor-rotation-v1",
    name: "01 — Проверка вращения двигателя",
    updatedAt: Date.now(),
    blocks: [
      { id: "rotation-1", type: "requireController" },
      { id: "rotation-2", type: "sound", repeats: 3, intervalSeconds: 0.5 },
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
    ],
  },
  {
    id: "built-in-maximum-current-limiting-v1",
    name: "02 — Измерение и ограничение максимального тока",
    updatedAt: Date.now(),
    blocks: [
      { id: "maximum-limit-1", type: "prepareMotorTest", maximumIdleCurrentA: 1 },
      {
        id: "maximum-limit-2",
        type: "limitMaximumCurrent",
        parameterName: "RC1_MAX",
        targetCurrentA: 160,
        toleranceA: 3,
        emergencyCurrentA: 250,
        rampDurationSeconds: 0.75,
        peakHoldSeconds: 0.5,
        cooldownSeconds: 5,
      },
    ],
  },
  {
    id: "built-in-find-current-load-v1",
    name: "03 — Калибровка тока на 20 А",
    updatedAt: Date.now(),
    blocks: [
      { id: "find-load-1", type: "prepareMotorTest", maximumIdleCurrentA: 1 },
      { id: "find-load-2", type: "sound", repeats: 3, intervalSeconds: 0.5 },
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
    ],
  },
  {
    id: "built-in-full-throttle-stand-v1",
    name: "05 — Резкий полный газ (стенд)",
    updatedAt: Date.now(),
    blocks: [
      { id: "full-throttle-1", type: "requireController" },
      { id: "full-throttle-2", type: "sound", repeats: 3, intervalSeconds: 0.5 },
      {
        id: "full-throttle-3",
        type: "fullThrottleStandRun",
        throttlePercent: 100,
        throttleMode: "percent",
        pwmTarget: "servo",
        saveServoMaxAfterRun: false,
        rampDurationSeconds: 1,
        durationSeconds: 0.5,
      },
      { id: "full-throttle-4", type: "disarmController" },
    ],
  },
  motorTestTemplate,
];

function loadScenarios(): SavedScenario[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    const scenarios = Array.isArray(value)
      ? (value as SavedScenario[]).map((scenario) => ({
          ...scenario,
          blocks: scenario.blocks.map((block) =>
            block.type === "fullThrottleStandRun"
              ? {
                  ...block,
                  throttleMode: block.throttleMode ?? "percent",
                  // Old PWM scenarios stored PWM as an RC input. Preserve that
                  // interpretation so they cannot command an unintended ESC
                  // output after this change.
                  pwmTarget: block.pwmTarget ?? (block.throttleMode === "pwm" ? "rc" : "servo"),
                  saveServoMaxAfterRun:
                    block.saveServoMaxAfterRun ??
                    (block as unknown as { saveRcMaxAfterRun?: boolean }).saveRcMaxAfterRun ??
                    false,
                }
              : block.type === "disarmController"
                ? { ...block, disabled: false }
                : block,
          ),
        }))
      : [];
    if (localStorage.getItem(TEMPLATE_SEEDED_KEY) !== "1") {
      localStorage.setItem(TEMPLATE_SEEDED_KEY, "1");
      const updatedBuiltIns = new Map(
        motorTestTemplates.map((template) => [template.id, template]),
      );
      const retiredBuiltInIds = new Set([
        "built-in-maximum-current-v1",
        "built-in-rc-max-tuning-v1",
        "built-in-current-calibration-v1",
      ]);
      const migrated = scenarios
        .filter((scenario) => !retiredBuiltInIds.has(scenario.id))
        .map((scenario) => updatedBuiltIns.get(scenario.id) ?? scenario);
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

type TelemetryCheckBlock = Extract<ScenarioBlock, { type: "checkTelemetrySignal" }>;
type TimedTelemetrySample = {
  elapsedMs: number;
  telemetry: NonNullable<ScenarioContext["telemetry"]>;
};

function evaluateTelemetryCheck(
  block: TelemetryCheckBlock,
  allSamples: TimedTelemetrySample[],
): string {
  const definition = telemetrySignalCatalog.find((signal) => signal.id === block.signal);
  if (!definition) throw new Error(`Неизвестный сигнал телеметрии: ${block.signal}`);
  const samples = allSamples
    .filter((sample) => sample.elapsedMs <= block.durationSeconds * 1000)
    .map((sample) => sample.telemetry);
  if (samples.length < 2) throw new Error(`Не получены данные: ${definition.label}`);
  const first = samples[0];
  const last = samples[samples.length - 1];
  const values = samples
    .map((sample) => sample[block.signal])
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (!values.length) throw new Error(`Нет корректных данных: ${definition.label}`);
  if (block.requireUpdates && first[definition.updateCounter] === last[definition.updateCounter])
    throw new Error(`Не обновляются данные: ${definition.label}`);
  const latest = values[values.length - 1];
  const minimumObserved = Math.min(...values);
  const maximumObserved = Math.max(...values);
  const variation = maximumObserved - minimumObserved;
  if (values.some((value) => value < block.minimum || value > block.maximum))
    throw new Error(
      `${definition.label}: зафиксировано ${minimumObserved.toFixed(3)}…${maximumObserved.toFixed(3)} ${definition.unit}, допустимо ${block.minimum}…${block.maximum} ${definition.unit}`,
    );
  if (block.behavior === "changing" && variation < block.variation)
    throw new Error(
      `${definition.label} не изменяется достаточно: ${variation.toFixed(3)} ${definition.unit}, требуется не менее ${block.variation} ${definition.unit}`,
    );
  if (block.behavior === "stable" && variation > block.variation)
    throw new Error(
      `${definition.label} нестабилен: ${variation.toFixed(3)} ${definition.unit}, допускается не более ${block.variation} ${definition.unit}`,
    );
  const behaviorText =
    block.behavior === "changing"
      ? `изменение не менее ${block.variation} ${definition.unit}`
      : block.behavior === "stable"
        ? `изменение не более ${block.variation} ${definition.unit}`
        : "изменение не ограничено";
  return [
    `${definition.label}: ${latest.toFixed(3)} ${definition.unit}`,
    `Наблюдалось: ${minimumObserved.toFixed(3)}…${maximumObserved.toFixed(3)} ${definition.unit}`,
    `Допустимо: ${block.minimum}…${block.maximum} ${definition.unit}`,
    `Разброс: ${variation.toFixed(3)} ${definition.unit}; ${behaviorText}`,
    `Новых сообщений группы: ${last[definition.updateCounter] - first[definition.updateCounter]}`,
  ].join("\n");
}

function Fields({
  block,
  replace,
  disabled,
  context,
}: {
  block: ScenarioBlock;
  replace: (value: ScenarioBlock) => void;
  disabled: boolean;
  context: ScenarioContext;
}) {
  if (block.type === "checkTelemetrySignal") {
    const definition =
      telemetrySignalCatalog.find((signal) => signal.id === block.signal) ??
      telemetrySignalCatalog[0];
    return (
      <div class="block-fields three-fields">
        <label>
          Сигнал
          <select
            disabled={disabled}
            value={block.signal}
            onChange={(event) => {
              const next = telemetrySignalCatalog.find(
                (signal) => signal.id === event.currentTarget.value,
              );
              if (!next) return;
              replace({
                ...block,
                signal: next.id,
                minimum: next.defaultMinimum,
                maximum: next.defaultMaximum,
                variation: next.defaultVariation,
              });
            }}
          >
            {telemetrySignalCatalog.map((signal) => (
              <option value={signal.id}>{signal.label}</option>
            ))}
          </select>
        </label>
        <label>
          Время проверки, с
          <input
            disabled={disabled}
            type="number"
            min="1"
            max="30"
            step="1"
            value={block.durationSeconds}
            onInput={(event) =>
              replace({ ...block, durationSeconds: event.currentTarget.valueAsNumber })
            }
          />
        </label>
        <label>
          Минимум, {definition.unit}
          <input
            disabled={disabled}
            type="number"
            step="any"
            value={block.minimum}
            onInput={(event) => replace({ ...block, minimum: event.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Максимум, {definition.unit}
          <input
            disabled={disabled}
            type="number"
            step="any"
            value={block.maximum}
            onInput={(event) => replace({ ...block, maximum: event.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Поведение
          <select
            disabled={disabled}
            value={block.behavior}
            onChange={(event) =>
              replace({
                ...block,
                behavior: event.currentTarget.value as typeof block.behavior,
              })
            }
          >
            <option value="any">Может быть стабильным</option>
            <option value="changing">Должен изменяться</option>
            <option value="stable">Должен быть стабильным</option>
          </select>
        </label>
        {block.behavior !== "any" && (
          <label>
            {block.behavior === "changing" ? "Минимальное" : "Максимальное"} изменение,{" "}
            {definition.unit}
            <input
              disabled={disabled}
              type="number"
              min="0"
              step="any"
              value={block.variation}
              onInput={(event) =>
                replace({ ...block, variation: event.currentTarget.valueAsNumber })
              }
            />
          </label>
        )}
        <label class="checkbox-field">
          <input
            disabled={disabled}
            type="checkbox"
            checked={block.requireUpdates}
            onChange={(event) => replace({ ...block, requireUpdates: event.currentTarget.checked })}
          />
          Требовать новые данные
        </label>
      </div>
    );
  }
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
      <div class="block-fields three-fields">
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
  if (block.type === "operatorConfirmation")
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
  if (block.type === "fullThrottleStandRun") {
    const throttleChannel = Math.round(
      context.parameters.find((parameter) => parameter.name === "RCMAP_THROTTLE")?.value ?? 1,
    );
    const minimum = context.parameters.find(
      (parameter) => parameter.name === `RC${throttleChannel}_MIN`,
    )?.value;
    const maximum = context.parameters.find(
      (parameter) => parameter.name === `RC${throttleChannel}_MAX`,
    )?.value;
    const hasRange =
      minimum !== undefined &&
      maximum !== undefined &&
      Number.isFinite(minimum) &&
      Number.isFinite(maximum) &&
      minimum < maximum;
    const motorOutput = Array.from({ length: 8 }, (_, index) => index + 1).find(
      (output) =>
        Math.round(
          context.parameters.find((parameter) => parameter.name === `SERVO${output}_FUNCTION`)
            ?.value ?? Number.NaN,
        ) === 70,
    );
    const servoMinimum = motorOutput
      ? context.parameters.find((parameter) => parameter.name === `SERVO${motorOutput}_MIN`)?.value
      : undefined;
    const servoMaximum = motorOutput
      ? context.parameters.find((parameter) => parameter.name === `SERVO${motorOutput}_MAX`)?.value
      : undefined;
    const hasServoRange =
      servoMinimum !== undefined &&
      servoMaximum !== undefined &&
      Number.isFinite(servoMinimum) &&
      Number.isFinite(servoMaximum) &&
      servoMinimum < servoMaximum;
    const pwmTargetsServo = block.pwmTarget !== "rc";
    const legacyRcPwm =
      block.throttleMode === "pwm" && !pwmTargetsServo ? block.throttlePwm : undefined;
    const targetServoPwm =
      block.throttleMode === "pwm"
        ? pwmTargetsServo
          ? block.throttlePwm
          : hasServoRange && hasRange && legacyRcPwm !== undefined
            ? Math.round(
                servoMinimum +
                  ((servoMaximum - servoMinimum) * (legacyRcPwm - minimum)) / (maximum - minimum),
              )
            : undefined
        : hasServoRange
          ? Math.round(servoMinimum + ((servoMaximum - servoMinimum) * block.throttlePercent) / 100)
          : undefined;
    const shownPercent =
      legacyRcPwm !== undefined && hasRange
        ? ((legacyRcPwm - minimum) / (maximum - minimum)) * 100
        : hasServoRange && targetServoPwm !== undefined
          ? ((targetServoPwm - servoMinimum) / (servoMaximum - servoMinimum)) * 100
          : block.throttlePercent;
    const targetPwm =
      legacyRcPwm ??
      (hasRange && Number.isFinite(shownPercent)
        ? Math.round(minimum + ((maximum - minimum) * shownPercent) / 100)
        : undefined);
    return (
      <div class="block-fields three-fields">
        <label>
          Задать газ
          <select
            disabled={disabled}
            value={block.throttleMode}
            onChange={(e) =>
              replace({ ...block, throttleMode: e.currentTarget.value as "percent" | "pwm" })
            }
          >
            <option value="percent">Проценты</option>
            <option value="pwm">Выход SERVO, мкс</option>
          </select>
        </label>
        <label>
          {block.throttleMode === "percent"
            ? "Газ, %"
            : pwmTargetsServo
              ? `Выход SERVO${motorOutput ?? 1}, мкс`
              : `Устаревшая команда RC${throttleChannel}, мкс`}
          <input
            disabled={disabled}
            type="number"
            min={block.throttleMode === "percent" ? "1" : "800"}
            max={block.throttleMode === "percent" ? "100" : "2200"}
            step="1"
            value={
              block.throttleMode === "percent" ? block.throttlePercent : (block.throttlePwm ?? "")
            }
            onInput={(e) =>
              replace(
                block.throttleMode === "percent"
                  ? { ...block, throttlePercent: e.currentTarget.valueAsNumber }
                  : { ...block, throttlePwm: e.currentTarget.valueAsNumber },
              )
            }
          />
        </label>
        <p class="throttle-parameter-note">
          {targetServoPwm === undefined || !motorOutput
            ? "Для расчёта выхода ESC подключите контроллер и обновите параметры."
            : `Целевой выход SERVO${motorOutput}: ${targetServoPwm} мкс (${shownPercent.toFixed(1)}%)`}
          <br />
          RCMAP_THROTTLE: RC{throttleChannel} · RC{throttleChannel}_MIN: {minimum ?? "нет данных"}{" "}
          мкс · RC{throttleChannel}_MAX: {maximum ?? "нет данных"} мкс
          <br />
          {targetPwm !== undefined && `Команда RC${throttleChannel}: ${Math.round(targetPwm)} мкс`}
        </p>
        <label>
          Набор газа, с
          <input
            disabled={disabled}
            type="number"
            min="0"
            max="5"
            step="0.5"
            value={block.rampDurationSeconds}
            onInput={(e) =>
              replace({ ...block, rampDurationSeconds: e.currentTarget.valueAsNumber })
            }
          />
        </label>
        <label>
          Удержание газа, с
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
        <label class="checkbox-field">
          <input
            disabled={disabled}
            type="checkbox"
            checked={block.saveServoMaxAfterRun}
            onChange={(e) => replace({ ...block, saveServoMaxAfterRun: e.currentTarget.checked })}
          />
          Сохранить целевое значение в SERVO{motorOutput ?? 1}_MAX после успешного запуска
        </label>
      </div>
    );
  }
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
  if (block.type === "limitMaximumCurrent")
    return (
      <div class="block-fields three-fields">
        <label>
          Параметр ограничения
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
          Набор газа, с
          <input
            disabled={disabled}
            type="number"
            min="0.5"
            max="1"
            step="0.05"
            value={block.rampDurationSeconds}
            onInput={(e) =>
              replace({ ...block, rampDurationSeconds: e.currentTarget.valueAsNumber })
            }
          />
        </label>
        <label>
          Удержание 100%, с
          <input
            disabled={disabled}
            type="number"
            min="0.1"
            max="1"
            step="0.1"
            value={block.peakHoldSeconds}
            onInput={(e) => replace({ ...block, peakHoldSeconds: e.currentTarget.valueAsNumber })}
          />
        </label>
        <label>
          Пауза между циклами, с
          <input
            disabled={disabled}
            type="number"
            min="0"
            max="300"
            value={block.cooldownSeconds}
            onInput={(e) => replace({ ...block, cooldownSeconds: e.currentTarget.valueAsNumber })}
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
  const [serialNumber, setSerialNumber] = useState(
    () => localStorage.getItem(SERIAL_NUMBER_KEY) ?? "",
  );
  const [blocks, setBlocks] = useState<ScenarioBlock[]>([]);
  const [page, setPage] = useState<"list" | "editor">("list");
  const [scenarioFilter, setScenarioFilter] = useState<"all" | "active" | "archived">("active");
  const [dirty, setDirty] = useState(false);
  const [selectedType, setSelectedType] = useState<BlockType>("wait");
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
  const displayedScenarios = savedScenarios.filter(
    (scenario) =>
      scenarioFilter === "all" ||
      (scenarioFilter === "archived" ? scenario.archived : !scenario.archived),
  );
  const operatorBlockTypes: BlockType[] = ["wait", "sound", "operatorConfirmation"];
  const canEditBlock = (block: ScenarioBlock) =>
    operatorBlockTypes.includes(block.type) || block.type === "fullThrottleStandRun";
  const canToggleBlock = (block: ScenarioBlock) => block.type !== "disarmController";
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
    localStorage.setItem(SERIAL_NUMBER_KEY, serialNumber);
  }, [serialNumber]);
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
    if (page !== "editor") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;
      if (event.key === "Escape" && !running) {
        event.preventDefault();
        void backToList();
      } else if (event.key === "Enter" && !running && !isEditing && !event.repeat) {
        event.preventDefault();
        void run();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [page, running, dirty, blocks, name]);
  useEffect(() => {
    const limit = activeEmergencyCurrentA.current;
    const currentA = Math.abs(context.ammeterPeakA ?? context.ammeterCurrentA ?? 0);
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
      (!context.controllerConnected ||
        (limit !== null && !context.ammeterConnected) ||
        currentLimitExceeded)
    ) {
      const reason = currentLimitExceeded
        ? currentLimitReason
        : !context.controllerConnected
          ? "Потеряно соединение с контроллером"
          : "Потеряно соединение с амперметром";
      void emergencyStop(reason);
    }
  }, [
    running,
    context.controllerConnected,
    context.ammeterConnected,
    context.ammeterCurrentA,
    context.ammeterPeakA,
  ]);

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
  const moveScenario = (scenarioIdToMove: string, offset: number) => {
    setSavedScenarios((all) => {
      const index = all.findIndex((scenario) => scenario.id === scenarioIdToMove);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= all.length) return all;
      const next = [...all];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  const add = () => {
    if (!operatorBlockTypes.includes(selectedType)) return;
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
      archived: savedScenarios.find((item) => item.id === scenarioId)?.archived,
    };
    setSavedScenarios((all) => {
      const index = all.findIndex((item) => item.id === scenarioId);
      if (index < 0) return [...all, saved];
      const next = [...all];
      next[index] = saved;
      return next;
    });
    setName(saved.name);
    setDirty(false);
  };
  const archiveScenario = async () => {
    if (
      running ||
      !(await discardDraftApproved()) ||
      !(await confirm(
        `${savedScenarios.find((item) => item.id === scenarioId)?.archived ? "Восстановить" : "Архивировать"} сценарий «${name}»?`,
        {
          title: "Сценарий",
          kind: "warning",
        },
      ))
    )
      return;
    setSavedScenarios((all) =>
      all.map((item) =>
        item.id === scenarioId
          ? { ...item, archived: !item.archived, updatedAt: Date.now() }
          : item,
      ),
    );
    setPage("list");
    setDirty(false);
    setEntries([]);
    setStatus("idle");
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
    const startedAt = new Date().toISOString();
    const reportEntries: RunEntry[] = [];
    const saveReport = async (result: SavedRunReport["status"]) => {
      const report: SavedRunReport = {
        format: "uav-test-station-report",
        version: 1,
        id: crypto.randomUUID(),
        scenarioId,
        scenarioName: name.trim(),
        serialNumber: serialNumber.trim() || undefined,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: result,
        entries: reportEntries,
      };
      const fileName = `report-${report.finishedAt.replace(/[:.]/g, "-")}-${report.id}.json`;
      try {
        await invoke("save_run_report", { fileName, contents: JSON.stringify(report, null, 2) });
      } catch (error) {
        console.error("Не удалось сохранить отчёт", error);
      }
    };
    const controllerIsArmed = () => latestContext.current.armed === true;
    const originalMotorAccessParameters = new Map<string, number>();
    let originalFixedWingMode: number | null = null;
    const waitFor = async (milliseconds: number) => {
      const deadline = Date.now() + milliseconds;
      while (Date.now() < deadline) {
        await new Promise((resolve) =>
          window.setTimeout(resolve, Math.min(100, deadline - Date.now())),
        );
        if (cancelled.current) throw new Error(stopReason.current);
      }
    };
    const configureFixedWingMotorAccess = async () => {
      if (latestContext.current.vehicleType !== "MAV_TYPE_FIXED_WING") return "";
      const rcOptions = await invoke<FreshParameter>("read_flight_controller_parameter", {
        name: "RC_OPTIONS",
      });
      const gcsSystemId = await invoke<FreshParameter>("read_flight_controller_parameter", {
        name: "MAV_GCS_SYSID",
      });
      const requestedRcOptions = Math.trunc(rcOptions.value) & ~2;
      const requests: Array<{ name: string; value: number }> = [];
      if (requestedRcOptions !== rcOptions.value) {
        originalMotorAccessParameters.set("RC_OPTIONS", rcOptions.value);
        requests.push({ name: "RC_OPTIONS", value: requestedRcOptions });
      }
      if (Math.round(gcsSystemId.value) !== 255) {
        originalMotorAccessParameters.set("MAV_GCS_SYSID", gcsSystemId.value);
        requests.push({ name: "MAV_GCS_SYSID", value: 255 });
      }
      if (requests.length) {
        await invoke("write_flight_controller_parameters", { requests });
        await waitFor(1000);
        for (const request of requests) {
          const confirmed = await invoke<FreshParameter>("read_flight_controller_parameter", {
            name: request.name,
          });
          if (Math.abs(confirmed.value - request.value) > 0.5)
            throw new Error(
              `Не удалось подготовить ${request.name}: ожидалось ${request.value}, получено ${confirmed.value}`,
            );
        }
      }
      if (latestContext.current.customMode !== 0) {
        originalFixedWingMode ??= latestContext.current.customMode ?? null;
        await invoke("set_flight_controller_mode", { customMode: 0 });
        const deadline = Date.now() + 3000;
        while (latestContext.current.customMode !== 0 && Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 100));
          if (cancelled.current) throw new Error(stopReason.current);
        }
        if (latestContext.current.customMode !== 0)
          throw new Error("Контроллер не подтвердил переход в режим MANUAL");
      }
      const changes = requests.map((request) => `${request.name}=${request.value}`).join(", ");
      return ` Fixed-wing подготовлен: MANUAL${changes ? `; временно установлено ${changes}` : ""}.`;
    };
    const restoreMotorAccess = async () => {
      if (originalMotorAccessParameters.size) {
        const requests = [...originalMotorAccessParameters].map(([name, value]) => ({
          name,
          value,
        }));
        await invoke("write_flight_controller_parameters", { requests });
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        originalMotorAccessParameters.clear();
      }
      if (originalFixedWingMode !== null) {
        await invoke("set_flight_controller_mode", { customMode: originalFixedWingMode });
        originalFixedWingMode = null;
      }
    };
    let integratedCalibrationMessage: string | null = null;
    const telemetryResults = new Map<string, { message?: string; error?: string }>();
    const precreatedEntries = new Map<string, RunEntry>();
    for (const [blockIndex, block] of blocks.entries()) {
      if (cancelled.current) {
        setStatus("cancelled");
        await restoreMotorAccess();
        await saveReport("cancelled");
        return;
      }
      if (block.disabled && block.type !== "disarmController") {
        const skippedEntry: RunEntry = {
          blockId: block.id,
          label: blockLabel(block),
          status: "skipped",
          message: "Отключён оператором — не выполнялся",
        };
        reportEntries.push(skippedEntry);
        setEntries((all) => [...all, skippedEntry]);
        continue;
      }
      const runningEntry =
        precreatedEntries.get(block.id) ??
        ({
          blockId: block.id,
          label: blockLabel(block),
          status: "running",
          message: "Выполняется…",
        } satisfies RunEntry);
      if (!precreatedEntries.has(block.id)) {
        reportEntries.push(runningEntry);
        setEntries((all) => [...all, runningEntry]);
      }
      try {
        let message: string;
        const entryStatus: RunEntry["status"] = "passed";
        if (block.type === "checkTelemetrySignal") {
          if (!latestContext.current.controllerConnected)
            throw new Error("Полётный контроллер не подключён");
          if (!telemetryResults.has(block.id)) {
            const batch: TelemetryCheckBlock[] = [];
            for (let index = blockIndex; index < blocks.length; index += 1) {
              const candidate = blocks[index];
              if (candidate.type !== "checkTelemetrySignal" || candidate.disabled) break;
              batch.push(candidate);
            }
            const additionalEntries = batch.slice(1).map((candidate) => {
              const entry: RunEntry = {
                blockId: candidate.id,
                label: blockLabel(candidate),
                status: "running",
                message: "Параллельный замер…",
              };
              precreatedEntries.set(candidate.id, entry);
              reportEntries.push(entry);
              return entry;
            });
            if (additionalEntries.length) setEntries((all) => [...all, ...additionalEntries]);
            const maximumDuration = Math.max(
              ...batch.map((candidate) => candidate.durationSeconds),
            );
            const batchStartedAt = Date.now();
            const samples: TimedTelemetrySample[] = [];
            while (Date.now() - batchStartedAt < maximumDuration * 1000) {
              const sample = latestContext.current.telemetry;
              if (sample)
                samples.push({ elapsedMs: Date.now() - batchStartedAt, telemetry: { ...sample } });
              await new Promise((resolve) => window.setTimeout(resolve, 250));
              if (cancelled.current) throw new Error("Выполнение отменено оператором");
            }
            for (const candidate of batch) {
              try {
                telemetryResults.set(candidate.id, {
                  message: evaluateTelemetryCheck(candidate, samples),
                });
              } catch (error) {
                telemetryResults.set(candidate.id, {
                  error: String(error).replace(/^Error: /, ""),
                });
              }
            }
            for (const candidate of batch) {
              const result = telemetryResults.get(candidate.id)!;
              const status = result.error ? "failed" : "passed";
              const resultMessage = result.error ?? result.message!;
              const entry =
                candidate.id === block.id ? runningEntry : precreatedEntries.get(candidate.id)!;
              Object.assign(entry, { status, message: resultMessage });
              updateEntry(candidate.id, { status, message: resultMessage });
            }
          }
          const result = telemetryResults.get(block.id);
          if (result?.error) throw new Error(result.error);
          message = result?.message ?? "Проверка телеметрии не выполнена";
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
        } else if (block.type === "fullThrottleStandRun") {
          if (!latestContext.current.controllerConnected)
            throw new Error("Полётный контроллер не подключён");

          const throttleChannelParameter = await invoke<FreshParameter>(
            "read_flight_controller_parameter",
            { name: "RCMAP_THROTTLE" },
          );
          const throttleChannel = Math.round(throttleChannelParameter.value);
          if (throttleChannel < 1 || throttleChannel > 8)
            throw new Error("RCMAP_THROTTLE содержит недопустимый канал");
          const minimumParameterName = `RC${throttleChannel}_MIN`;
          const maximumParameterName = `RC${throttleChannel}_MAX`;
          // The MAVLink worker performs one point parameter read at a time.
          // Do not use Promise.all here: the second request would otherwise
          // be rejected while the first response is still pending.
          const minimumParameter = await invoke<FreshParameter>(
            "read_flight_controller_parameter",
            { name: minimumParameterName },
          );
          const maximumParameter = await invoke<FreshParameter>(
            "read_flight_controller_parameter",
            { name: maximumParameterName },
          );
          const minimumPwm = Math.round(minimumParameter.value);
          const maximumPwm = Math.round(maximumParameter.value);
          if (minimumPwm >= maximumPwm)
            throw new Error(`Некорректные ${minimumParameterName}/${maximumParameterName}`);
          const motorOutput = Array.from({ length: 8 }, (_, index) => index + 1).find(
            (output) =>
              Math.round(
                latestContext.current.parameters.find(
                  (parameter) => parameter.name === `SERVO${output}_FUNCTION`,
                )?.value ?? Number.NaN,
              ) === 70,
          );
          if (!motorOutput)
            throw new Error(
              "Не найден выход двигателя: обновите параметры и задайте SERVOx_FUNCTION = 70 (Throttle)",
            );
          const servoMinimumParameterName = `SERVO${motorOutput}_MIN`;
          const servoMaximumParameterName = `SERVO${motorOutput}_MAX`;
          const servoMinimumParameter = await invoke<FreshParameter>(
            "read_flight_controller_parameter",
            { name: servoMinimumParameterName },
          );
          const servoMaximumParameter = await invoke<FreshParameter>(
            "read_flight_controller_parameter",
            { name: servoMaximumParameterName },
          );
          const servoMinimumPwm = Math.round(servoMinimumParameter.value);
          const servoMaximumPwm = Math.round(servoMaximumParameter.value);
          if (servoMinimumPwm >= servoMaximumPwm)
            throw new Error(
              `Некорректные ${servoMinimumParameterName}/${servoMaximumParameterName}`,
            );
          const pwmTargetsServo = block.pwmTarget !== "rc";
          const legacyRcPwm =
            block.throttleMode === "pwm" && !pwmTargetsServo
              ? Math.round(block.throttlePwm ?? Number.NaN)
              : undefined;
          if (
            legacyRcPwm !== undefined &&
            (!Number.isFinite(legacyRcPwm) || legacyRcPwm <= minimumPwm || legacyRcPwm > maximumPwm)
          )
            throw new Error(
              `Устаревшая команда RC должна быть больше ${minimumParameterName} (${minimumPwm} мкс) и не превышать ${maximumParameterName} (${maximumPwm} мкс)`,
            );
          const targetServoPwm =
            legacyRcPwm !== undefined
              ? Math.round(
                  servoMinimumPwm +
                    ((servoMaximumPwm - servoMinimumPwm) * (legacyRcPwm - minimumPwm)) /
                      (maximumPwm - minimumPwm),
                )
              : block.throttleMode === "pwm"
                ? Math.round(block.throttlePwm ?? Number.NaN)
                : Math.round(
                    servoMinimumPwm +
                      ((servoMaximumPwm - servoMinimumPwm) * block.throttlePercent) / 100,
                  );
          if (
            !Number.isFinite(targetServoPwm) ||
            targetServoPwm <= servoMinimumPwm ||
            targetServoPwm > servoMaximumPwm
          )
            throw new Error(
              `Целевой выход должен быть больше ${servoMinimumParameterName} (${servoMinimumPwm} мкс) и не превышать ${servoMaximumParameterName} (${servoMaximumPwm} мкс)`,
            );
          const throttlePercent =
            ((targetServoPwm - servoMinimumPwm) * 100) / (servoMaximumPwm - servoMinimumPwm);
          const targetPwm =
            legacyRcPwm ??
            Math.round(minimumPwm + ((maximumPwm - minimumPwm) * throttlePercent) / 100);

          const motorAccessMessage = await configureFixedWingMotorAccess();
          if (latestContext.current.armed !== true) {
            await invoke("set_flight_controller_armed", { armed: true, force: true });
            const armDeadline = Date.now() + 5000;
            while (!controllerIsArmed() && Date.now() < armDeadline) {
              await new Promise((resolve) => window.setTimeout(resolve, 100));
              if (cancelled.current) throw new Error(stopReason.current);
            }
            if (!controllerIsArmed())
              throw new Error("ARM не подтверждён перед подачей полного газа");
          }

          let maximumServoOutput: number | undefined;
          let motorCommand: MotorRotationCommand | undefined;
          const ammeterAverageCurrentSamples: number[] = [];
          const ammeterInstantaneousCurrentSamples: number[] = [];
          motorActive.current = true;
          activeEmergencyCurrentA.current = null;
          try {
            if (block.rampDurationSeconds > 0) {
              // Три крупные ступени повторяют уже проверенный сценарий ограничения тока.
              // Первые 10–20% часто ниже порога старта двигателя и не должны многократно
              // перезаписывать RC override до финальной команды газа.
              const stepCount = 3;
              const stepDurationSeconds = block.rampDurationSeconds / stepCount;
              for (let step = 1; step < stepCount; step += 1) {
                const stepThrottlePercent = Math.max(1, (throttlePercent * step) / stepCount);
                await invoke<MotorRotationCommand>("start_motor_rotation", {
                  throttlePercent: stepThrottlePercent,
                  durationSeconds: Math.min(5, stepDurationSeconds + 0.2),
                });
                updateEntry(block.id, {
                  message: `Плавный набор: ${stepThrottlePercent.toFixed(0)}% из ${throttlePercent.toFixed(1)}%`,
                });
                await waitFor(stepDurationSeconds * 1000);
              }
            }
            motorCommand = await invoke<MotorRotationCommand>("start_motor_rotation", {
              throttlePercent,
              durationSeconds: block.durationSeconds,
            });
            const startedAt = Date.now();
            const deadline = startedAt + block.durationSeconds * 1000;
            while (Date.now() < deadline) {
              await new Promise((resolve) => window.setTimeout(resolve, 25));
              if (cancelled.current) throw new Error(stopReason.current);
              const servoOutput =
                latestContext.current.servoOutputPwms?.[motorCommand.motorOutput - 1];
              if (servoOutput !== undefined)
                maximumServoOutput = Math.max(maximumServoOutput ?? servoOutput, servoOutput);
              if (latestContext.current.ammeterConnected) {
                const { ammeterCurrentA, ammeterInstantaneousA } = latestContext.current;
                if (ammeterCurrentA !== undefined && Number.isFinite(ammeterCurrentA))
                  ammeterAverageCurrentSamples.push(ammeterCurrentA);
                if (ammeterInstantaneousA !== undefined && Number.isFinite(ammeterInstantaneousA))
                  ammeterInstantaneousCurrentSamples.push(ammeterInstantaneousA);
              }
              updateEntry(block.id, {
                message: `${targetPwm} мкс (${throttlePercent.toFixed(1)}%) газа`,
              });
            }
          } finally {
            await invoke("emergency_stop_motor");
            motorActive.current = false;
            activeEmergencyCurrentA.current = null;
          }

          if (!motorCommand) throw new Error("Не удалось отправить команду полного газа");
          const servoMessage =
            maximumServoOutput === undefined
              ? `SERVO${motorCommand.motorOutput}: нет данных телеметрии; ожидается около ${motorCommand.expectedServo1Pwm} мкс`
              : `SERVO${motorCommand.motorOutput}: ${maximumServoOutput} мкс (цель около ${motorCommand.expectedServo1Pwm} мкс)`;
          const rampMessage =
            block.rampDurationSeconds > 0
              ? `с плавным набором за ${block.rampDurationSeconds.toLocaleString("ru-RU")} с`
              : "резко";
          let savedParameterMessage = "";
          if (block.saveServoMaxAfterRun && targetServoPwm !== servoMaximumPwm) {
            const approved = await confirm(
              `${servoMaximumParameterName} будет изменён: ${servoMaximumPwm} → ${targetServoPwm} мкс. Сохранить это значение в полётном контроллере?`,
              { title: "Сохранение предела газа", kind: "warning" },
            );
            if (approved) {
              await invoke("write_flight_controller_parameters", {
                requests: [{ name: servoMaximumParameterName, value: targetServoPwm }],
              });
              const verified = await invoke<FreshParameter>("read_flight_controller_parameter", {
                name: servoMaximumParameterName,
              });
              if (Math.abs(verified.value - targetServoPwm) > 0.5)
                throw new Error(`Запись ${servoMaximumParameterName} не подтверждена`);
              savedParameterMessage = ` ${servoMaximumParameterName}: ${servoMaximumPwm} → ${targetServoPwm} мкс сохранён.`;
            } else {
              savedParameterMessage = ` Сохранение ${servoMaximumParameterName} отменено оператором.`;
            }
          } else if (block.saveServoMaxAfterRun) {
            savedParameterMessage = ` ${servoMaximumParameterName} уже равен ${targetServoPwm} мкс.`;
          }
          const average = (samples: number[]) =>
            samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : undefined;
          const averageCurrentA = average(ammeterAverageCurrentSamples);
          const averageInstantaneousCurrentA = average(ammeterInstantaneousCurrentSamples);
          const peakCurrentA = ammeterInstantaneousCurrentSamples.length
            ? Math.max(...ammeterInstantaneousCurrentSamples)
            : undefined;
          const ammeterMessage =
            averageCurrentA !== undefined ||
            averageInstantaneousCurrentA !== undefined ||
            peakCurrentA !== undefined
              ? ` Амперметр за время полного газа: средний по «среднему току» ${averageCurrentA?.toFixed(3) ?? "—"} A; средний по мгновенному току ${averageInstantaneousCurrentA?.toFixed(3) ?? "—"} A; пик мгновенного тока за всё время ${peakCurrentA?.toFixed(3) ?? "—"} A.`
              : latestContext.current.ammeterConnected
                ? " Амперметр подключён, но показания тока не получены."
                : " Амперметр не подключён — ток не записывался.";
          message = `${servoMessage}; ${rampMessage}, удержание ${block.durationSeconds.toLocaleString("ru-RU")} с. Команда RC${throttleChannel}: ${targetPwm} мкс (${throttlePercent.toFixed(1)}%).${motorAccessMessage}${savedParameterMessage}${ammeterMessage}`;
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
            const output = latestContext.current.servoOutputPwms?.[motorCommand.motorOutput - 1];
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
              const sample = `${elapsedSeconds.toFixed(1)}с: ARM=${latestContext.current.armed === true ? "да" : "нет"}, RC${motorCommand.throttleChannel}=${input ?? "—"}, SERVO${motorCommand.motorOutput}=${output ?? "—"}, FCA=${controllerCurrentA?.toFixed(2) ?? "—"} A, CA=${currentA?.toFixed(2) ?? "—"} A`;
              diagnostics.push(sample);
              updateEntry(block.id, {
                message: `Газ ${block.throttlePercent}%: цель RC${motorCommand.throttleChannel}=${motorCommand.inputPwm}, SERVO${motorCommand.motorOutput}≈${motorCommand.expectedServo1Pwm} мкс. ${sample}`,
              });
              nextDiagnosticAt += 200;
            }
          }
          await invoke("emergency_stop_motor");
          motorActive.current = false;
          activeEmergencyCurrentA.current = null;
          if (
            observedServo1Pwm === undefined ||
            observedServo1Pwm < motorCommand.expectedServo1Pwm - 40
          )
            throw new Error(
              `Выход двигателя SERVO${motorCommand.motorOutput} не достиг команды газа: ожидалось около ${motorCommand.expectedServo1Pwm} мкс, получено ${observedServo1Pwm ?? "нет данных"} мкс. Лог: ${diagnostics.join("; ")}`,
            );
          const rcInputNote =
            observedInputPwm === undefined ||
            Math.abs(observedInputPwm - motorCommand.inputPwm) > 25
              ? ` Вход RC${motorCommand.throttleChannel}=${observedInputPwm ?? "нет данных"} мкс оставлен только для диагностики: он может отражать приёмник, а не MAVLink override.`
              : "";
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
            inputPwm: motorCommand.inputPwm,
            motorOutput: motorCommand.motorOutput,
            servoOutputPwm: observedServo1Pwm,
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
          message = `Вращение подтверждено: газ ${block.throttlePercent}%, ${block.durationSeconds} с; FCA ${averageControllerCurrentA?.toFixed(2) ?? "нет данных"} A (пик ${peakControllerCurrentA?.toFixed(2) ?? "нет данных"} A); CA ${averageCurrentA?.toFixed(2) ?? "нет данных"} A (пик ${peakCurrentA?.toFixed(2) ?? "нет данных"} A).${rcInputNote}`;
        } else if (block.type === "prepareMotorTest") {
          const current = latestContext.current;
          if (!current.controllerConnected) throw new Error("Полётный контроллер не подключён");
          if (!current.ammeterConnected || current.ammeterCurrentA === undefined)
            throw new Error("Нет актуальных данных амперметра");
          if (Math.abs(current.ammeterCurrentA) > block.maximumIdleCurrentA)
            throw new Error(
              `Ток покоя ${current.ammeterCurrentA.toFixed(2)} A превышает ${block.maximumIdleCurrentA} A`,
            );
          const motorAccessMessage = await configureFixedWingMotorAccess();
          message = `Контроллер и амперметр готовы, ток покоя ${current.ammeterCurrentA.toFixed(2)} A.${motorAccessMessage}`;
        } else if (block.type === "limitMaximumCurrent") {
          const parameterName = block.parameterName.trim().toUpperCase();
          let parameter = await invoke<FreshParameter>("read_flight_controller_parameter", {
            name: parameterName,
          });
          const originalParameterValue = parameter.value;
          const cycleResults: string[] = [];
          let cycle = 0;
          let continueTuning = true;
          while (continueTuning) {
            cycle += 1;
            for (let tone = 0; tone < 3; tone += 1) {
              await playComputerTone();
              if (tone < 2) await new Promise((resolve) => window.setTimeout(resolve, 500));
              if (cancelled.current) throw new Error(stopReason.current);
            }
            if (latestContext.current.armed !== true) {
              await invoke("set_flight_controller_armed", { armed: true, force: true });
              const armDeadline = Date.now() + 5000;
              while (!controllerIsArmed() && Date.now() < armDeadline) {
                await new Promise((resolve) => window.setTimeout(resolve, 100));
                if (cancelled.current) throw new Error(stopReason.current);
              }
              if (!controllerIsArmed()) throw new Error("ARM не подтверждён перед измерением");
            }

            motorActive.current = true;
            activeEmergencyCurrentA.current = block.emergencyCurrentA;
            const stepDuration = block.rampDurationSeconds / 3;
            try {
              for (const throttlePercent of [33, 66]) {
                await invoke<MotorRotationCommand>("start_motor_rotation", {
                  throttlePercent,
                  durationSeconds: stepDuration + 0.25,
                });
                await new Promise((resolve) => window.setTimeout(resolve, stepDuration * 1000));
                if (cancelled.current) throw new Error(stopReason.current);
              }
              const fullCommand = await invoke<MotorRotationCommand>("start_motor_rotation", {
                throttlePercent: 100,
                durationSeconds: block.peakHoldSeconds + 0.5,
              });
              const startedAt = Date.now();
              const deadline = startedAt + block.peakHoldSeconds * 1000;
              const averageSamples: number[] = [];
              const peakSamples: number[] = [];
              let maximumServo1: number | undefined;
              while (Date.now() < deadline) {
                await new Promise((resolve) => window.setTimeout(resolve, 25));
                if (cancelled.current) throw new Error(stopReason.current);
                const servo1 = latestContext.current.servoOutputPwms?.[fullCommand.motorOutput - 1];
                if (servo1 !== undefined) maximumServo1 = Math.max(maximumServo1 ?? servo1, servo1);
                const currentA = latestContext.current.ammeterCurrentA;
                const peakA = latestContext.current.ammeterPeakA ?? currentA;
                if (
                  currentA !== undefined &&
                  peakA !== undefined &&
                  Number.isFinite(currentA) &&
                  Number.isFinite(peakA) &&
                  servo1 !== undefined &&
                  servo1 >= fullCommand.expectedServo1Pwm - 40
                ) {
                  averageSamples.push(Math.abs(currentA));
                  peakSamples.push(Math.abs(peakA));
                }
                updateEntry(block.id, {
                  message: `Цикл ${cycle}: плавный набор завершён, 100% газа; CA средний ${currentA?.toFixed(2) ?? "—"} A, пик ${peakA?.toFixed(2) ?? "—"} A`,
                });
              }
              if (maximumServo1 === undefined || maximumServo1 < fullCommand.expectedServo1Pwm - 40)
                throw new Error(
                  `Выход двигателя SERVO${fullCommand.motorOutput} не достиг полного газа`,
                );
              if (!peakSamples.length) throw new Error("Нет данных амперметра на полном газе");
              const peakCurrentA = Math.max(...peakSamples);
              const averageCurrentA =
                averageSamples.reduce((sum, value) => sum + value, 0) / averageSamples.length;
              await invoke("emergency_stop_motor");
              motorActive.current = false;
              activeEmergencyCurrentA.current = null;
              const lowerBound = block.targetCurrentA - block.toleranceA;
              const upperBound = block.targetCurrentA + block.toleranceA;
              const withinTarget = peakCurrentA >= lowerBound && peakCurrentA <= upperBound;
              const cycleMessage = `Цикл ${cycle}: CA средний ${averageCurrentA.toFixed(2)} A, пик ${peakCurrentA.toFixed(2)} A; цель ${block.targetCurrentA} ± ${block.toleranceA} A; ${parameterName}=${parameter.value.toFixed(2)}`;
              cycleResults.push(cycleMessage);
              const shouldContinue = await confirm(
                `${cycleMessage}\n\n${withinTarget ? "Целевой диапазон достигнут." : "Требуется корректировка."}\nПродолжить настройку и выполнить следующий цикл?`,
                {
                  title: "Ограничение максимального тока",
                  kind: withinTarget ? "info" : "warning",
                },
              );
              if (!shouldContinue) {
                continueTuning = false;
                continue;
              }
              const rawRatio = block.targetCurrentA / peakCurrentA;
              const safeRatio = Math.min(1.1, Math.max(0.9, rawRatio));
              const requestedValue = parameter.value * safeRatio;
              await invoke("write_flight_controller_parameters", {
                requests: [{ name: parameterName, value: requestedValue }],
              });
              await new Promise((resolve) => window.setTimeout(resolve, 1000));
              parameter = await invoke<FreshParameter>("read_flight_controller_parameter", {
                name: parameterName,
              });
              if (
                Math.abs(parameter.value - requestedValue) >
                Math.max(0.01, Math.abs(requestedValue) * 0.005)
              )
                throw new Error(`Запись ${parameterName} не подтверждена`);
              cycleResults.push(
                `${parameterName}: ${(requestedValue / safeRatio).toFixed(2)} → ${parameter.value.toFixed(2)} (коэффициент ${safeRatio.toFixed(3)})`,
              );
              const pauseDeadline = Date.now() + block.cooldownSeconds * 1000;
              while (Date.now() < pauseDeadline) {
                await new Promise((resolve) => window.setTimeout(resolve, 100));
                if (cancelled.current) throw new Error(stopReason.current);
              }
            } finally {
              if (motorActive.current) {
                await invoke("emergency_stop_motor");
                motorActive.current = false;
                activeEmergencyCurrentA.current = null;
              }
            }
          }
          message = `Исходный ${parameterName}=${originalParameterValue.toFixed(2)}. ${cycleResults.join(" | ")}`;
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
              const servo1 = latestContext.current.servoOutputPwms?.[command.motorOutput - 1];
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
                message: `Ступень ${throttle}%: RC${command.throttleChannel}=${rc ?? "—"}, SERVO${command.motorOutput}=${servo1 ?? "—"}, FCA=${latestContext.current.controllerCurrentA?.toFixed(2) ?? "—"} A, CA=${latestContext.current.ammeterCurrentA?.toFixed(2) ?? "—"} A`,
              });
              if (cancelled.current)
                throw new Error(`${stopReason.current}. Все токи: ${currentHistory.join("; ")}`);
            }
            if (maxServo1 === undefined || maxServo1 < command.expectedServo1Pwm - 40)
              throw new Error(
                `На ${throttle}% SERVO${command.motorOutput} не достиг команды: ${maxServo1 ?? "—"} мкс`,
              );
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
                ? Math.abs(bestRc - command.inputPwm) > 25
                  ? `${bestRc} (вход приёмника)`
                  : `${bestRc}`
                : `нет телеметрии (последнее ${lastReportedRc ?? "—"})`;
            const attempt = `${throttle}%: RC${command.throttleChannel}=${rcReport}, SERVO${command.motorOutput}=${maxServo1}, FCA=${fcaAverage?.toFixed(2) ?? "—"} A (пик ${fcaPeak?.toFixed(2) ?? "—"}), CA=${caAverage.toFixed(2)} A (пик ${caPeak.toFixed(2)})${spikeWarning}`;
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
            const servo1 = latestContext.current.servoOutputPwms?.[holdCommand.motorOutput - 1];
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
        Object.assign(runningEntry, { status: entryStatus, message });
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
        const result = cancelled.current ? "cancelled" : "failed";
        Object.assign(runningEntry, {
          status: "failed",
          message: String(error).replace(/^Error: /, ""),
        });
        try {
          await restoreMotorAccess();
        } catch (restoreError) {
          console.error("Не удалось восстановить параметры моторного доступа", restoreError);
        }
        setStatus(result);
        await saveReport(result);
        return;
      }
    }
    const result = "passed";
    await restoreMotorAccess();
    setStatus(result);
    await saveReport(result);
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
          <div class="scenario-list-controls">
            <UiSelect
              aria-label="Фильтр сценариев"
              value={scenarioFilter}
              onChange={(event) =>
                setScenarioFilter(event.currentTarget.value as "all" | "active" | "archived")
              }
            >
              <option value="active">Активные</option>
              <option value="archived">Архивные</option>
              <option value="all">Все</option>
            </UiSelect>
            <label>
              <span>Серийный номер устройства</span>
              <UiInput
                value={serialNumber}
                placeholder="Например, UAV-001"
                onInput={(event) => setSerialNumber(event.currentTarget.value)}
              />
            </label>
          </div>
        </section>
        <section class="scenario-list-page">
          {displayedScenarios.map((scenario) => {
            const index = savedScenarios.findIndex((item) => item.id === scenario.id);
            return (
              <article class={`scenario-card ${scenario.archived ? "archived" : ""}`}>
                <button
                  type="button"
                  class="scenario-card-main"
                  onClick={() => selectScenario(scenario)}
                >
                  <div>
                    <strong>{scenario.name}</strong>
                    <span>
                      {scenario.blocks.length} блоков{scenario.archived ? " · В архиве" : ""}
                    </span>
                  </div>
                  <time>Изменён {new Date(scenario.updatedAt).toLocaleString()}</time>
                  <span class="scenario-card-arrow">→</span>
                </button>
                <div
                  class="scenario-order-actions"
                  aria-label={`Порядок сценария ${scenario.name}`}
                >
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => moveScenario(scenario.id, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={index === savedScenarios.length - 1}
                    onClick={() => moveScenario(scenario.id, 1)}
                  >
                    ↓
                  </button>
                </div>
              </article>
            );
          })}
          {!displayedScenarios.length && (
            <div class="scenario-empty">
              <h2>
                {savedScenarios.length ? "Нет сценариев в выбранном фильтре" : "Сценариев пока нет"}
              </h2>
              <p>
                {savedScenarios.length
                  ? "Измените фильтр, чтобы увидеть другие сценарии."
                  : "Сценарии добавляются разработчиком вместе с приложением."}
              </p>
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
          <button type="button" onClick={archiveScenario} disabled={running}>
            {savedScenarios.find((item) => item.id === scenarioId)?.archived
              ? "Восстановить"
              : "Архивировать"}
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
          <div class="scenario-name">
            <span>Название сценария</span>
            <strong>{name}</strong>
          </div>
          <div class="block-adder">
            <select
              value={selectedType}
              disabled={running}
              onChange={(e) => setSelectedType(e.currentTarget.value as BlockType)}
            >
              {blockCatalog
                .filter((item) => operatorBlockTypes.includes(item.type))
                .map((item) => (
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
                <article
                  class={`scenario-block ${block.disabled ? "disabled" : ""}`}
                  key={block.id}
                >
                  <div class="scenario-block-heading">
                    <span class="block-number">{index + 1}</span>
                    <div>
                      <h3>{blockLabel(block)}</h3>
                      <small>{block.type}</small>
                    </div>
                    <div class="block-actions">
                      <button
                        type="button"
                        disabled={index === 0 || running || !canEditBlock(block)}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        disabled={index === blocks.length - 1 || running || !canEditBlock(block)}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        class={block.disabled ? "primary-button" : ""}
                        disabled={running || !canToggleBlock(block)}
                        title={
                          canToggleBlock(block)
                            ? undefined
                            : "DISARM обязателен для безопасного завершения сценария"
                        }
                        onClick={() => {
                          replace({ ...block, disabled: !block.disabled });
                          changeDraft();
                        }}
                      >
                        {block.disabled ? "Включить" : "Отключить"}
                      </button>
                    </div>
                  </div>
                  <Fields
                    block={block}
                    replace={replace}
                    context={context}
                    disabled={running || block.disabled || !canEditBlock(block)}
                  />
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
                        : entry.status === "skipped"
                          ? "—"
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
              {rotationPrompt.inputPwm} мкс · SERVO{rotationPrompt.motorOutput}=
              {rotationPrompt.servoOutputPwm} мкс
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
