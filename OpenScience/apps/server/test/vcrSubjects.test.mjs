// Which object a computation is for: the matcher a conversation's design job and the backfill share, the stages a job is, and the
// command-line of the backfill script. The database half is in vcrOrchestrator.integration.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { parseBackfillArguments } from "../../../scripts/vcr/backfill-result-subjects.mjs";
import {
  VCR_SUBJECT_KINDS, vcrBackfillSubjectFor, vcrCurrentObjects, vcrDesignShare, vcrJobObjectKind, vcrJobStage, vcrMatchTrialScenarios,
} from "../src/vcrSubjects.mjs";

const fixed21 = { id: "scn_a", version: 1, label: "A 2:1", design: "two_arm_fixed", endpointType: "time_to_event", configuration: { design: { nTreat: 120, nControl: 60 }, truth: { hazardRatio: 0.7 } } };
const fixed11 = { id: "scn_b", version: 2, label: "B 1:1", design: "two_arm_fixed", endpointType: "time_to_event", configuration: { design: { nTreat: 90, nControl: 90, allocation: 0.5 }, truth: { hazardRatio: 0.7 } } };
const sequential = { id: "scn_c", version: 3, label: "C 1:1 序贯", design: "group_sequential", endpointType: "time_to_event", configuration: { design: { allocation: 0.5, informationRates: [0.5, 1] } } };

test("a design's allocation share is the treatment fraction however the design states it", () => {
  assert.equal(vcrDesignShare({ allocation: 0.6667 }), 0.6667);
  assert.equal(vcrDesignShare({ nTreat: 120, nControl: 60 }), 2 / 3);
  assert.equal(vcrDesignShare({ allocation: 1.5, nTreat: 1, nControl: 1 }), 0.5, "an allocation that is not a fraction is not the share");
  assert.equal(vcrDesignShare({}), null);
});

test("a job's scenario fits the designs that agree with it where both say something, and the numbers it shares break a tie", () => {
  const all = [sequential, fixed11, fixed21];
  assert.deepEqual(vcrMatchTrialScenarios({ design: { kind: "two_arm_fixed", allocation: 0.5 } }, all).map((row) => row.id), ["scn_b"]);
  assert.deepEqual(vcrMatchTrialScenarios({ design: { kind: "two_arm_fixed", nTreat: 200, nControl: 100 } }, all).map((row) => row.id), ["scn_a"], "the share, not the size");
  assert.deepEqual(vcrMatchTrialScenarios({ design: { kind: "group_sequential" }, endpoint: { type: "time_to_event" } }, all).map((row) => row.id), ["scn_c"]);
  assert.deepEqual(vcrMatchTrialScenarios({ design: { allocation: 0.5 } }, all).map((row) => row.id).sort(), ["scn_b", "scn_c"], "two designs fit equally: both are returned, and the caller does not choose");
  assert.deepEqual(vcrMatchTrialScenarios({ design: { allocation: 0.5, nTreat: 90, nControl: 90 } }, all).map((row) => row.id), ["scn_b"], "the one that shares the sizes fits better");
  assert.deepEqual(vcrMatchTrialScenarios({ design: { kind: "single_arm" } }, all), []);
  assert.deepEqual(vcrMatchTrialScenarios({ design: { kind: "two_arm_fixed" }, endpoint: { type: "binary" } }, all), [], "another endpoint is another design");
});

test("the current objects are the newest of each design, comparator route and kind", () => {
  const older = { ...fixed11, id: "scn_b0", version: 1 };
  assert.deepEqual(vcrCurrentObjects("trial_scenario", [older, fixed21, fixed11, sequential]).map((row) => row.id), ["scn_c", "scn_b", "scn_a"]);
  assert.deepEqual(vcrCurrentObjects("population", [{ id: "pop_1", version: 1 }, { id: "pop_2", version: 2 }]).map((row) => row.id), ["pop_2"]);
  assert.deepEqual(vcrCurrentObjects("comparator", [{ id: "c1", version: 1, route: "literature_control" }, { id: "c2", version: 2, route: "external_control" }, { id: "c3", version: 3, route: "external_control" }]).map((row) => row.id), ["c3", "c1"]);
});

test("a job is for an object only when its result is filed under one, and a stage is the orchestrator's own word", () => {
  assert.deepEqual([...VCR_SUBJECT_KINDS], ["population", "patient_set", "comparator", "trial_scenario", "design_grid"]);
  for (const [kind, object] of /** @type {Array<[string, string | null]>} */ ([
    ["design_analytic", "trial_scenario"], ["design_simulation", "trial_scenario"], ["assurance", "trial_scenario"], ["design_grid", "design_grid"],
    ["generate_population", "population"], ["generate_patients", "patient_set"], ["weighted_cox_comparator", "comparator"],
    ["pool_evidence", null], ["accrual_forecast", null], ["match_criteria", null], ["reconstruct_km", null],
  ])) assert.equal(vcrJobObjectKind(kind), object, kind);
  assert.equal(vcrJobStage("design_analytic", "trial_scenario"), "analytic");
  assert.equal(vcrJobStage("design_simulation", "trial_scenario"), "simulation");
  assert.equal(vcrJobStage("assurance", "trial_scenario"), "assurance");
  assert.equal(vcrJobStage("weighted_cox_comparator", "comparator"), "primary");
  assert.equal(vcrJobStage("tipping_point", "comparator"), "tipping_point");
  assert.equal(vcrJobStage("generate_population", "population"), null);
});

test("the backfill matches a design by its job, and gives the other kinds of result to the study's one object or to nobody", () => {
  const rows = [sequential, fixed11, fixed21];
  assert.equal(vcrBackfillSubjectFor({ objectKind: "trial_scenario", rows, job: { scenario: { design: { kind: "two_arm_fixed", allocation: 0.6667 } } } }).subject?.id, "scn_a");
  assert.equal(vcrBackfillSubjectFor({ objectKind: "trial_scenario", rows, job: { scenario: { design: { allocation: 0.5 } } } }).reason, "ambiguous");
  assert.equal(vcrBackfillSubjectFor({ objectKind: "trial_scenario", rows, job: { scenario: { design: { kind: "single_arm" } } } }).reason, "no_fit");
  assert.equal(vcrBackfillSubjectFor({ objectKind: "trial_scenario", rows, job: null }).reason, "no_job");
  assert.equal(vcrBackfillSubjectFor({ objectKind: "trial_scenario", rows: [], job: { scenario: {} } }).reason, "no_object");
  assert.equal(vcrBackfillSubjectFor({ objectKind: "population", rows: [{ id: "pop_2", version: 2 }, { id: "pop_1", version: 1 }], job: null }).subject?.id, "pop_2");
  assert.equal(vcrBackfillSubjectFor({ objectKind: "comparator", rows: [{ id: "c1", version: 1, route: "a" }, { id: "c2", version: 1, route: "b" }], job: null }).reason, "ambiguous");
});

test("the backfill's command line takes a study and --apply and nothing else", () => {
  assert.deepEqual(parseBackfillArguments([]), { apply: false, studyId: null });
  assert.deepEqual(parseBackfillArguments(["--study", "std_ab12", "--apply"]), { apply: true, studyId: "std_ab12" });
  assert.throws(() => parseBackfillArguments(["--study"]), /needs a study id/);
  assert.throws(() => parseBackfillArguments(["--study", "../x"]), /study id/);
  assert.throws(() => parseBackfillArguments(["--force"]), /unknown argument/);
});
