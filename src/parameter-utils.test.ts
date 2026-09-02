import { describe, expect, it } from "vitest";

import {
  compareParameters,
  groupParameters,
  isWriteFinished,
  type ParameterValue,
} from "./parameter-utils";

const parameters: ParameterValue[] = [
  { name: "BATT_AMP_PERVLT", value: 50, parameterType: "REAL32", index: 2 },
  { name: "ARMING_CHECK", value: 1, parameterType: "INT32", index: 1 },
  { name: "BATT_MONITOR", value: 4, parameterType: "INT32", index: 3 },
];

describe("parameter utilities", () => {
  it("groups filtered parameters by stable prefix", () => {
    expect(groupParameters(parameters, "batt")).toEqual([["BATT", [parameters[0], parameters[2]]]]);
  });

  it("returns only changed and unknown file parameters", () => {
    expect(
      compareParameters(
        [
          { name: "ARMING_CHECK", value: 1 },
          { name: "BATT_MONITOR", value: 5 },
          { name: "NEW_PARAM", value: 7 },
        ],
        parameters,
      ),
    ).toEqual([
      { name: "BATT_MONITOR", value: 5, currentValue: 4, selected: false },
      { name: "NEW_PARAM", value: 7, currentValue: undefined, selected: false },
    ]);
  });

  it("recognizes completed writes even if they finish before the first UI poll", () => {
    expect(isWriteFinished({ active: false, total: 1, completed: 1, failed: 0 })).toBe(true);
    expect(isWriteFinished({ active: true, total: 1, completed: 0, failed: 0 })).toBe(false);
  });
});
