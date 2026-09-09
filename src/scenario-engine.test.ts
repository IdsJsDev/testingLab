import { describe, expect, it } from "vitest";

import {
  evaluateImmediateBlock,
  evaluateParameterValue,
  validateScenario,
  type ScenarioContext,
} from "./scenario-engine";

const context: ScenarioContext = {
  controllerConnected: true,
  controllerName: "MatekH743",
  armed: false,
  ammeterConnected: true,
  ammeterCurrentA: 0.03,
  parameters: [{ name: "BATT_MONITOR", value: 4 }],
};

describe("scenario validation", () => {
  it("rejects invalid configurable blocks", () => {
    expect(
      validateScenario("Test", [
        { id: "1", type: "wait", seconds: 301 },
        { id: "2", type: "currentInRange", minimum: 2, maximum: 1 },
      ]),
    ).toHaveLength(2);
  });

  it("accepts a valid scenario", () => {
    expect(validateScenario("Preflight", [{ id: "1", type: "requireController" }])).toEqual([]);
  });

  it("validates sound repetition settings", () => {
    expect(
      validateScenario("Sound", [{ id: "1", type: "sound", repeats: 0, intervalSeconds: 1 }]),
    ).toEqual(["Блок 1: число звуков должно быть от 1 до 20"]);
  });

  it("validates an individual telemetry signal check", () => {
    const block = {
      id: "telemetry",
      type: "checkTelemetrySignal" as const,
      signal: "batteryVoltageV" as const,
      durationSeconds: 3,
      minimum: 18,
      maximum: 26,
      requireUpdates: true,
      behavior: "changing" as const,
      variation: 0.01,
    };
    expect(validateScenario("Telemetry", [block])).toEqual([]);
    expect(validateScenario("Telemetry", [{ ...block, minimum: 30 }])).toContain(
      "Блок 1: некорректный допустимый диапазон",
    );
    expect(validateScenario("Telemetry", [{ ...block, variation: -1 }])).toContain(
      "Блок 1: изменение должно быть неотрицательным числом",
    );
  });

  it("accepts motor rotation duration only in half-second steps", () => {
    const rotation = (durationSeconds: number) => ({
      id: "rotation",
      type: "checkMotorRotation" as const,
      throttlePercent: 10,
      durationSeconds,
      emergencyCurrentA: 40,
      confirmation: "Направление правильное?",
    });
    expect(validateScenario("Rotation", [rotation(1.5)])).toEqual([]);
    expect(validateScenario("Rotation", [rotation(0.7)])).toContain(
      "Блок 1: запуск должен длиться от 0,5 до 5 секунд с шагом 0,5 секунды",
    );
  });

  it("validates safe current-load search limits", () => {
    const block = {
      id: "load",
      type: "findCurrentLoad" as const,
      targetCurrentA: 20,
      toleranceA: 2,
      startThrottlePercent: 10,
      throttleStepPercent: 2,
      maximumThrottlePercent: 30,
      pulseDurationSeconds: 1,
      holdDurationSeconds: 2,
      cooldownSeconds: 1,
      emergencyCurrentA: 40,
    };
    expect(validateScenario("Find load", [block])).toEqual([]);
    expect(validateScenario("Find load", [{ ...block, emergencyCurrentA: 20 }])).toContain(
      "Блок 1: аварийный ток должен быть выше целевого диапазона",
    );
  });

  it("validates the maximum-current limiting cycle", () => {
    const block = {
      id: "maximum-current",
      type: "limitMaximumCurrent" as const,
      parameterName: "RC1_MAX",
      targetCurrentA: 160,
      toleranceA: 3,
      emergencyCurrentA: 250,
      rampDurationSeconds: 0.75,
      peakHoldSeconds: 0.5,
      cooldownSeconds: 5,
    };
    expect(validateScenario("Maximum current", [block])).toEqual([]);
    expect(validateScenario("Maximum current", [{ ...block, rampDurationSeconds: 1.5 }])).toContain(
      "Блок 1: плавный набор должен длиться от 0,5 до 1 секунды",
    );
  });

  it("validates the full-throttle stand run duration", () => {
    const block = {
      id: "full-throttle",
      type: "fullThrottleStandRun" as const,
      throttlePercent: 100,
      rampDurationSeconds: 1,
      durationSeconds: 0.5,
    };
    expect(validateScenario("Stand", [block])).toEqual([]);
    expect(validateScenario("Stand", [{ ...block, durationSeconds: 0.05 }])).toContain(
      "Блок 1: полный газ должен длиться от 0,1 до 5 секунд",
    );
    expect(validateScenario("Stand", [{ ...block, throttlePercent: 101 }])).toContain(
      "Блок 1: газ должен быть от 1 до 100%",
    );
    expect(validateScenario("Stand", [{ ...block, rampDurationSeconds: 0.3 }])).toContain(
      "Блок 1: время набора должно быть от 0 до 5 секунд с шагом 0,5 секунды",
    );
  });
});

describe("immediate block evaluation", () => {
  it("evaluates connected devices and values", () => {
    expect(evaluateImmediateBlock({ id: "1", type: "requireDisarmed" }, context)).toContain(
      "DISARM",
    );
    expect(
      evaluateImmediateBlock(
        { id: "2", type: "parameterEquals", name: "BATT_MONITOR", expected: 4, tolerance: 0 },
        context,
      ),
    ).toContain("актуальное значение 4");
  });

  it("reports a failed condition", () => {
    expect(() =>
      evaluateImmediateBlock({ id: "1", type: "currentInRange", minimum: 1, maximum: 2 }, context),
    ).toThrow("вне диапазона");
  });

  it("compares a freshly read parameter value", () => {
    expect(
      evaluateParameterValue(
        { id: "1", type: "parameterEquals", name: "BATT_MONITOR", expected: 4, tolerance: 0 },
        4,
      ),
    ).toContain("актуальное значение 4");
  });
});
