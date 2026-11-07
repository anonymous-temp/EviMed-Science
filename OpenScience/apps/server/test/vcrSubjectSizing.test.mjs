import assert from "node:assert/strict";
import test from "node:test";
import { resolveJobSubject, vcrConversationSubject, vcrSizingDiffers, vcrTrialScenarioFit } from "../src/vcrSubjects.mjs";

// Live defect D1 (2026-11-07): a fixed 250-per-arm simulation was filed as a version of the design solved for 90% power (367 per arm),
// whose page then read 734 patients beside a power of 76%.
const solvedConfiguration = { design: { kind: "two_arm_fixed", allocation: 0.5 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.75, controlMedian: 12 },
  analysis: { method: "logrank", alpha: 0.025, power: 0.9, sided: 1 }, accrual: { kind: "uniform", duration: 12, followup: 18 } };
const simulation = (/** @type {number} */ perArm) => ({ design: { kind: "two_arm_fixed", nTreat: perArm, nControl: perArm }, endpoint: { type: "time_to_event" },
  truth: { hazardRatio: 0.75, controlMedian: 12 }, analysis: { method: "logrank", alpha: 0.025, sided: 1 }, accrual: { kind: "uniform", duration: 12, followup: 18 } });

function storeHoldingSolvedDesign() {
  /** @type {any[]} */
  const saved = [];
  const held = { id: "scn_solved", version: 1, label: "试验方案 1", design: "two_arm_fixed", endpointType: "time_to_event", configuration: solvedConfiguration, resultId: "res_solved" };
  const rows = () => [held, ...saved.map((input, at) => ({ id: `scn_new${at}`, version: 2 + at, label: input.label, design: input.design, endpointType: input.endpointType, configuration: input.configuration }))];
  return { saved, store: {
    async trialScenarios() { return rows(); },
    async result(/** @type {string} */ _studyId, /** @type {string} */ id) { return id === "res_solved" ? { id, measures: [{ name: "required_patients", value: 734 }, { name: "required_events", value: 508 }] } : null; },
    async methodConfigurationObject(/** @type {any} */ _client, /** @type {string} */ _studyId, /** @type {string} */ _kind, /** @type {string | null} */ subjectId) { return subjectId ? rows().find((row) => row.id === subjectId) ?? null : null; },
    async saveTrialScenario(/** @type {any} */ input) { saved.push(input); return { id: `scn_new${saved.length - 1}`, version: 1 + saved.length }; },
    async transaction(/** @type {(client: any) => Promise<any>} */ run) { return run({ query: async () => ({ rows: [] }) }); },
  } };
}
const study = { id: "std_1", userId: "u1", scope: "conversation" };

test("a fixed-size scenario and a design solved for a power are different designs unless the sizes are the solved ones", () => {
  const row = { configuration: solvedConfiguration, solvedPatients: 734 };
  assert.equal(vcrSizingDiffers(simulation(250), row), true);
  assert.equal(vcrSizingDiffers(simulation(367), row), false, "a simulation at the solved size is the design's next stage");
  assert.equal(vcrSizingDiffers(simulation(367), { configuration: solvedConfiguration }), true, "a design with no solved size yet cannot be told to be the same");
  assert.equal(vcrSizingDiffers({ ...solvedConfiguration }, { configuration: simulation(250) }), true, "a solve-for-power scenario is not a fixed design either");
  assert.equal(vcrSizingDiffers({ design: { kind: "two_arm_fixed" } }, row), false, "a scenario that says nothing about the sample is the design");
  assert.equal(vcrTrialScenarioFit(simulation(250), { design: "two_arm_fixed", endpointType: "time_to_event", configuration: solvedConfiguration }).fits, false);
});

test("the live case: 250 per arm is not filed under the design solved for 90% power, 367 per arm is", async () => {
  const { store, saved } = storeHoldingSolvedDesign();
  const made = await vcrConversationSubject({ store, study, userId: "u1", kind: "design_simulation", scenario: simulation(250) });
  assert.ok(made, "a design of its own is made for the 250 per arm scenario");
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].configuration.design, { kind: "two_arm_fixed", nTreat: 250, nControl: 250 });
  assert.equal(await vcrConversationSubject({ store, study, userId: "u1", kind: "design_simulation", scenario: simulation(367) }), null);
  assert.equal(saved.length, 1);
  assert.equal((await resolveJobSubject({ store, study, kind: "design_simulation", subjectId: made, scenario: simulation(250) })).row.id, made);
  assert.equal((await resolveJobSubject({ store, study, kind: "design_simulation", scenario: simulation(367) })).row.id, "scn_solved");
});

test("naming the solved design and sending a fixed size under it still makes another design", async () => {
  const { store, saved } = storeHoldingSolvedDesign();
  const made = await vcrConversationSubject({ store, study, userId: "u1", kind: "design_simulation", subjectId: "scn_solved", scenario: simulation(250) });
  assert.ok(made);assert.equal(saved.length, 1);assert.notEqual(saved[0].label, "试验方案 1", "not a version of the solved design's line");
});
