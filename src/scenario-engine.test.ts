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
