import { describe, expect, it } from "vitest";
import { factText } from "./dataSemanticsView";

describe("factText for the meaning of a table's codes", () => {
  it("reads a value map in the researcher's words, not as an object", () => {
    expect(factText("valueMap", { values: { 0: "absent", 1: "present", "N/A": "unknown" }, measurement: false })).toBe("0 = 无、1 = 有、N/A = 不详");
    expect(factText("valueMap", { values: {}, measurement: true })).toBe("数值本身就是测量结果");
    expect(factText("valueMap", { values: {}, measurement: false })).toBe("不按有无看");
  });

  it("lists the variables already looked for", () => {
    expect(factText("askedConcepts", ["egfr_mutation", "pregnancy"])).toBe("egfr_mutation、pregnancy");
  });
});
