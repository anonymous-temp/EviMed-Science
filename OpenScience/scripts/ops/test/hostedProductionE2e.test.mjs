import assert from "node:assert/strict";
import test from "node:test";
import { assertAutomatedMemoryIsolation, specialistOutputs } from "../hosted-production-e2e.mjs";

test("live E2E reads the complete package at the paths recorded by its run", () => {
  for (const prefix of ["", "deliverables/aspirin-adr-signal-analysis/"]) {
    const report = `${prefix}safety-report.md`, signals = `${prefix}signals.csv`;
    assert.deepEqual(specialistOutputs(["artifacts/hosted-production-e2e.json", report, signals]), { report, signals });
  }
});

test("missing, mixed or ambiguous packages cannot certify delivery", () => {
  for (const artifacts of [
    undefined,
    ["safety-report.md"],
    ["deliverables/a/safety-report.md", "deliverables/b/signals.csv"],
    ["safety-report.md", "signals.csv", "deliverables/a/safety-report.md", "deliverables/a/signals.csv"],
    ["../safety-report.md", "../signals.csv"],
  ]) assert.throws(() => specialistOutputs(artifacts), { code: "hosted_e2e_specialist_output_untracked" });
});

test("automated acceptance proves memory exclusion instead of requiring a forbidden extraction", () => {
  const run = { automated: true }, existing = new Set(["old"]);
  assert.doesNotThrow(() => assertAutomatedMemoryIsolation(run, [], [{ id: "old", value: "marker" }], existing, "marker"));
  assert.throws(() => assertAutomatedMemoryIsolation({}, [], [], existing, "marker"), { code: "hosted_e2e_automation_untracked" });
  for (const [project, profile] of [[[{ kind: "run_summary" }], []], [[], [{ id: "new", value: "marker" }]]]) {
    assert.throws(() => assertAutomatedMemoryIsolation(run, project, profile, existing, "marker"), { code: "hosted_e2e_automated_memory_leak" });
  }
});
