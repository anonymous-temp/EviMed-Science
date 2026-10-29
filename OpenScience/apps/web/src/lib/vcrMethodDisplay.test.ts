import { describe, expect, it } from "vitest";
import { VCR_JOB_METHODS } from "@evimed/domain";
import { completeMethodCatalogue, methodEntries, methodTask, methodPurpose, patientModes, methodNeedsSnapshot, initialMethodScenario, knownJobProgress } from "./vcrMethodDisplay";
import { vcrCalculationPath, vcrMethodPath } from "./vcrMethodLocation";
describe("task display over canonical protocols", () => {
  const methods = Object.entries(VCR_JOB_METHODS).filter(([, method]) => !method.startsWith("forecast.")).map(([id, method]) => ({ id, method, name: method }));
  const all = completeMethodCatalogue(methods);
  it("preserves all 32 R and four forecast protocols and consolidates only four patient seed entries", () => {
    expect(all).toHaveLength(36); expect(methodEntries(all)).toHaveLength(33); expect(patientModes(all)).toHaveLength(4);
    expect(completeMethodCatalogue(all)).toHaveLength(36);
  });
  it("assigns every protocol purpose, input and output without changing its identity", () => {
    for (const method of all) { expect(methodTask(method.method!)).not.toBe("其他方法"); expect(methodPurpose(method).purpose).not.toBe("配置此方法并保留计算结果。"); }
    expect(methodTask("matching.evaluate")).toBe("招募与匹配"); expect(methodTask("comparator.covariate_sets")).toBe("稳健性分析");
  });
  it("keeps a multi-method calculation container separate and addresses historical method and job together", () => {
    expect(vcrCalculationPath("calculation_1")).toBe("/app/capabilities/calculations/calculation_1");
    expect(vcrMethodPath("patients.continuous", { studyId: "calculation_1", jobId: "old_job" })).toBe("/app/capabilities/methods/patients.continuous?study=calculation_1&job=old_job");
  });
});

it("requires subject data only for column-based negative controls and tipping-point outcomes", () => {
  expect(methodNeedsSnapshot("comparator.negative_control", { controls: [{ estimate: 0, se: 0.1 }] })).toBe(false);
  expect(methodNeedsSnapshot("comparator.negative_control", { controls: [{ column: "negative_outcome" }] })).toBe(true);
  expect(methodNeedsSnapshot("comparator.tipping_point", { endpoint: { type: "binary" }, counts: { treatment: { n: 20, responders: 10 } } })).toBe(false);
  expect(methodNeedsSnapshot("comparator.tipping_point", { endpoint: { type: "binary" }, outcomeColumn: "response" })).toBe(true);
  expect(methodNeedsSnapshot("comparator.tipping_point", { endpoint: { type: "time_to_event" } })).toBe(true);
  expect(methodNeedsSnapshot("design.procova", { n: 100 })).toBe(false);
});

it("fills only the declared fixed endpoint and never numeric assumptions or unknown endpoint fields", () => {
  expect(initialMethodScenario("patients.binary")).toEqual({ endpoint: { type: "binary" } });
  expect(initialMethodScenario("comparator.rmst")).toEqual({});
  expect(initialMethodScenario("patients.binary", { endpoint: { type: "continuous" } })).toEqual({ endpoint: { type: "continuous" } });
});
it("renders progress only for known coherent counts", () => {
  expect(knownJobProgress({})).toBeNull(); expect(knownJobProgress({ done: 0, total: 0 })).toBeNull(); expect(knownJobProgress({ done: null, total: 10 })).toBeNull(); expect(knownJobProgress({ done: 4, total: 3 })).toBeNull(); expect(knownJobProgress({ done: 0, total: 10 })).toEqual({ done: 0, total: 10 });
});
