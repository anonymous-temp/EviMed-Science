import { beforeEach, expect, it, vi } from "vitest";
import { activateMethodDraftOwner, clearMethodDrafts, methodDraftKey, readMethodDraft, writeMethodDraft, type MethodDraftScope } from "./vcrMethodDraft";
const scope: MethodDraftScope = { userId: "user_a", tenantId: "tenant_a", projectId: "project_a", studyId: "study_a", method: "design.analytic" };
const form = { studyId: "study_a", method: "design.analytic", scenario: { endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.73 }, design: { kind: "two_arm_fixed" } }, seed: "123", replicates: "", snapshots: ["snapshot_a"], subjectId: "subject_a", model: { id: "model_a", version: "2" }, reconstructionResultId: null, qualityBasis: null };
beforeEach(() => { clearMethodDrafts(); window.sessionStorage.clear(); activateMethodDraftOwner(scope.userId, scope.tenantId); });
it("retains bounded form values and opaque references while discarding arbitrary patient rows and transient state", () => {
  expect(writeMethodDraft(scope, { active: { ...form, scenario: { ...form.scenario, rawPatients: [{ name: "Private row" }] }, busy: true, error: "transient" }, modes: [] })).toBe(true);
  const restored = readMethodDraft(scope)!;
  expect(restored.active).toMatchObject(form);
  expect(restored.active.scenario).not.toHaveProperty("rawPatients"); expect(restored.active).not.toHaveProperty("busy"); expect(restored.active).not.toHaveProperty("error");
  expect(window.sessionStorage.getItem(methodDraftKey(scope))).not.toContain("Private row");
});
it("isolates account, tenant, project, study, method, historical job, source version and explicit launch scopes", () => {
  writeMethodDraft(scope, { active: form, modes: [] });
  for (const changed of [{ userId: "user_b" }, { tenantId: "tenant_b" }, { projectId: "project_b" }, { studyId: "study_b" }, { method: "design.simulate" }, { jobId: "job_a" }, { modelId: "model_a" }, { modelVersion: "3" }, { launchId: "explicit_scenario_b" }]) expect(readMethodDraft({ ...scope, ...changed })).toBeNull();
  activateMethodDraftOwner("user_b", "tenant_a"); activateMethodDraftOwner(scope.userId, scope.tenantId); expect(readMethodDraft(scope)).toBeNull();
});
it("rejects malformed, oversized or mismatched stored records without hydrating them", () => {
  for (const value of ["{", JSON.stringify({ schema: 1, scope: methodDraftKey(scope), active: null }), JSON.stringify({ schema: 1, scope: methodDraftKey(scope), active: { ...form, seed: {} } }), "x".repeat(150_000)]) {
    window.sessionStorage.setItem(methodDraftKey(scope), value); expect(readMethodDraft(scope)).toBeNull();
  }
  expect(writeMethodDraft(scope, { active: { ...form, scenario: { ...form.scenario, design: { kind: "group_sequential", informationRates: Array(501).fill(0.5) } } }, modes: [] })).toBe(false);
});
it("retains valid multi-row correlations without treating cell bounds as array-length bounds", () => {
  const target = { ...scope, method: "population.scenario" };
  const active = { ...form, method: target.method, scenario: { n: 100, population: { variables: [{ name: "age", family: "normal", mean: 60, sd: 10 }, { name: "score", family: "normal", mean: 5, sd: 1 }], correlation: [[1, 0.2], [0.2, 1]] } } };
  expect(writeMethodDraft(target, { active, modes: [] })).toBe(true);
  expect(readMethodDraft(target)!.active.scenario).toEqual(active.scenario);
});

it("keeps the latest in-tab copy when storage writes fail but reads still succeed", () => {
  const failed = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  try { expect(writeMethodDraft(scope, { active: form, modes: [] })).toBe(true); expect(readMethodDraft(scope)!.active.seed).toBe("123"); }
  finally { failed.mockRestore(); }
});
