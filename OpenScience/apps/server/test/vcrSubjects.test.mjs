// Which object a computation is for: the matcher a conversation's design job and the backfill share, the stages a job is, and the
// command-line of the backfill script. The database half is in vcrOrchestrator.integration.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { parseBackfillArguments } from "../../../scripts/vcr/backfill-result-subjects.mjs";
import {
  VCR_SUBJECT_KINDS, vcrBackfillSubjectFor, vcrConversationSubject, vcrCurrentObjects, vcrDesignShare, vcrJobFroze, vcrJobObjectKind, vcrJobStage, vcrMatchTrialScenarios,
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

// A conversation's second design is a second design: the numbers it states decide whether the study's object is the one it means.
const design300 = { design: { kind: "two_arm_fixed", nTreat: 150, nControl: 150 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.7, controlMedian: 12 },
  analysis: { method: "logrank", alpha: 0.025, sided: 1 }, accrual: { kind: "uniform", duration: 12, followup: 12 } };

/** A store that holds one design (n=300) and writes whatever it is given, as the real one would. */
function storeHoldingOneDesign() {
  /** @type {any[]} */
  const saved = [];
  const held = { id: "scn_300", version: 1, label: "设计 1", design: "two_arm_fixed", endpointType: "time_to_event", configuration: design300 };
  const rows = () => [held, ...saved.map((input, at) => ({ id: `scn_new${at}`, version: 2 + at, label: input.label, design: input.design, endpointType: input.endpointType, configuration: input.configuration }))];
  return { saved, store: {
    async trialScenarios() { return rows(); },
    async methodConfigurationObject(/** @type {any} */ _client, /** @type {string} */ _studyId, /** @type {string} */ _kind, /** @type {string | null} */ subjectId) { return subjectId ? rows().find((row) => row.id === subjectId) ?? null : null; },
    async saveTrialScenario(/** @type {any} */ input) { saved.push(input); return { id: `scn_new${saved.length - 1}`, version: 1 + saved.length }; },
    async transaction(/** @type {(client: any) => Promise<any>} */ run) { return run({ query: async () => ({ rows: [] }) }); },
  } };
}

test("a conversation that states other numbers than the design the study holds files a design of its own, and the same numbers are the one it holds", async () => {
  const { store, saved } = storeHoldingOneDesign();
  const study = { id: "std_1", userId: "u1", scope: "conversation" };
  const n500 = { ...design300, design: { kind: "two_arm_fixed", nTreat: 250, nControl: 250 } };
  assert.equal(await vcrConversationSubject({ store, study, userId: "u1", kind: "design_simulation", scenario: design300 }), null, "the same numbers are the design the study holds");
  const made = await vcrConversationSubject({ store, study, userId: "u1", kind: "design_simulation", scenario: n500 });
  assert.ok(made, "n=500 is not the n=300 design");
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].configuration.design, { kind: "two_arm_fixed", nTreat: 250, nControl: 250 });
  // the n=500 design is now the one that scenario fits, and with no number said both designs fit (the resolver then names them)
  assert.equal(await vcrConversationSubject({ store, study, userId: "u1", kind: "design_simulation", scenario: n500 }), null);
  assert.equal(saved.length, 1, "asking again for n=500 files nothing");
});

test("a running job froze a scenario when every value the scenario states is its own, and it may hold more", () => {
  const frozen = { design: { kind: "two_arm_fixed", nTreat: 150, nControl: 150, informationRates: [0.5, 1] }, truth: { hazardRatio: 0.7 }, seedless: true };
  assert.equal(vcrJobFroze(frozen, { design: { nTreat: 150 }, truth: { hazardRatio: 0.7 } }), true);
  assert.equal(vcrJobFroze(frozen, {}), true);
  assert.equal(vcrJobFroze(frozen, { design: { nTreat: 250 } }), false, "another number is another scenario");
  assert.equal(vcrJobFroze(frozen, { design: { informationRates: [0.5, 1] } }), true);
  assert.equal(vcrJobFroze(frozen, { design: { informationRates: [0.3, 1] } }), false);
  assert.equal(vcrJobFroze(frozen, { accrual: { duration: 12 } }), false, "a value the job never held is not one it froze");
  assert.equal(vcrJobFroze(undefined, { truth: { hazardRatio: 0.7 } }), false);
});

test("an explicit subjectId with a scenario that contradicts the design is a new version of that design, written like the browser's method configurations; one that only adds is the design as it is", async () => {
  const { store, saved } = storeHoldingOneDesign();
  const study = { id: "std_1", userId: "u1", scope: "conversation" };
  const ask = (/** @type {Record<string, any>} */ scenario, /** @type {string} */ subjectId = "scn_300") => vcrConversationSubject({ store, study, userId: "u1", kind: "design_simulation", subjectId, scenario });
  assert.equal(await ask({}), null, "no scenario: the object as it was written is started");
  assert.equal(await ask(design300), null, "the same numbers");
  assert.equal(await ask({ ...design300, accrual: { ...design300.accrual, dropoutAnnual: 0.05 } }), null, "a key the design does not state contradicts nothing");
  assert.equal(saved.length, 0);
  const n500 = { ...design300, design: { kind: "two_arm_fixed", nTreat: 250, nControl: 250 } };
  const made = await ask(n500);
  assert.ok(made && made !== "scn_300", "the numbers it sent are not the design's: a version of its own");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].label, "设计 1", "the same line of the same design, so the version replaces the earlier result and nothing else");
  assert.deepEqual(saved[0].configuration.design, { kind: "two_arm_fixed", nTreat: 250, nControl: 250 });
  assert.deepEqual(saved[0].configuration, n500, "the scenario it sent is the version's configuration, as it is for a design made from a scenario");
  // a scenario the engine would refuse is refused by what is wrong with it, and no version is written
  await assert.rejects(ask({ ...n500, truth: { hazardRatio: -1 } }), { code: "vcr_job_scenario_invalid" });
  assert.equal(saved.length, 1);
  // a study with a page of its own keeps its objects: nothing is written here
  assert.equal(await vcrConversationSubject({ store, study: { ...study, scope: "study" }, userId: "u1", kind: "design_simulation", subjectId: "scn_300", scenario: n500 }), null);
});
