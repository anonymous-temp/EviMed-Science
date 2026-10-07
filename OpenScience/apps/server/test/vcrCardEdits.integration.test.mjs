// The cards a person edits on a study's page (R10): a population's settings, a design's settings and the numbers inside the criteria.
//
// On PostgreSQL, because the claim is about rows: an edit writes the object's NEXT version (never an update in place), the step it
// belongs to is asked for, what stood on the old version is marked stale, and a number the engine's schema would refuse writes nothing.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { VcrMatchStore } from "../src/vcrMatchStore.mjs";
import { createVcrCardEdits, criteriaSettings, designSettings, populationSettings } from "../src/vcrCardEdits.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {ControlPlaneDatabase} */
let database;
/** @type {VcrStore} */
let store;
/** @type {VcrMatchStore} */
let matchStore;
/** @type {pg.Client | null} */
let admin = null;
let isolatedName = "";

const SCENARIO_POPULATION = {
  population: { variables: [
    { family: "normal", name: "age", mean: 58, sd: 10 },
    { family: "bernoulli", name: "female", prob: 0.45 },
  ] },
  n: 1000,
};
const TWO_ARM = {
  design: { kind: "two_arm_fixed", nTreat: 400, nControl: 400 }, endpoint: { type: "time_to_event" },
  truth: { hazardRatio: 0.8, controlMedian: 12 }, analysis: { alpha: 0.025, sided: 1 }, accrual: { duration: 24, followup: 12 }, cost: 800,
};

before(async () => {
  if (!databaseUrl) return;
  const source = new URL(databaseUrl);
  isolatedName = `${decodeURIComponent(source.pathname.slice(1))}_vcrcard_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  assert.match(isolatedName, /^evimed_test[a-z0-9_]*$/);
  admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${isolatedName}"`);
  source.pathname = `/${isolatedName}`;
  database = new ControlPlaneDatabase({ databaseUrl: source.href, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  store = new VcrStore({ database });
  matchStore = new VcrMatchStore({ database });
  await store.ready();
});

after(async () => {
  await database?.close().catch(() => {});
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

/** A study with a generated population, two designs and a protocol; and the editor over it, with an orchestrator that records what it was told. */
async function furnish() {
  const userId = `u_${randomUUID().slice(0, 8)}`;
  const study = await store.createStudy({ userId, projectId: `prj_${randomUUID().slice(0, 8)}`, name: "卡片研究", question: "q" });
  await store.saveDefinition({ studyId: study.id, userId, pico: { population: "成人" }, endpointType: "time_to_event" });
  const population = await store.savePopulation({ studyId: study.id, userId, kind: "scenario", name: "情景人群", definition: SCENARIO_POPULATION, allowedUses: ["design"], reviewState: "ai_set" });
  const a = await store.saveTrialScenario({ studyId: study.id, userId, label: "A 固定设计", design: "two_arm_fixed", endpointType: "time_to_event", configuration: TWO_ARM, assumptionIds: [] });
  const b = await store.saveTrialScenario({ studyId: study.id, userId, label: "B 固定设计", design: "two_arm_fixed", endpointType: "time_to_event", configuration: { ...TWO_ARM, truth: { hazardRatio: 0.7, controlMedian: 12 } }, assumptionIds: [] });
  await matchStore.saveProtocolVersion({
    studyId: study.id, userId, title: "方案 v1",
    criteria: [
      { kind: "inclusion", criterionType: "demographic", sourceText: "年龄 ≥ 18 岁", sourceLocator: { page: 12 }, requirement: { op: "compare", variable: "age", comparator: "gte", value: 18 }, applicability: { op: "present", variable: "enrolled" }, evidenceNeeded: [] },
      { kind: "exclusion", criterionType: "time_window", sourceText: "末次免疫治疗距今不足 28 天", sourceLocator: { page: 13 }, requirement: { op: "elapsed_since", variable: "last_immunotherapy", days: 28 }, evidenceNeeded: [] },
    ],
  });
  /** @type {any[]} */
  const heard = [];
  const orchestrator = { recomputeAfterChange: async (/** @type {any} */ input) => { heard.push(input); return {}; } };
  const cards = createVcrCardEdits({ store, matchStore, orchestrator });
  return { study, userId, population, a, b, cards, heard };
}

test("a population offers its record count and each declared variable's numbers, by name; a design its closed list of numbers", () => {
  const settings = populationSettings({ kind: "scenario", definition: SCENARIO_POPULATION });
  assert.deepEqual(settings.map((entry) => [entry.path, entry.label, entry.value]), [
    ["n", "生成记录数", 1000],
    ["population.variables.0.mean", "age 均数", 58],
    ["population.variables.0.sd", "age 标准差", 10],
    ["population.variables.1.prob", "female 比例", 0.45],
  ]);
  assert.equal(settings[0].integer, true);
  assert.equal(populationSettings({ kind: "real", definition: { timeZero: "x" } }).length, 0, "a cohort's definition is words, not numbers");
  assert.deepEqual(designSettings({ configuration: TWO_ARM }).map((entry) => entry.path), [
    "design.nTreat", "design.nControl", "truth.hazardRatio", "truth.controlMedian", "analysis.alpha", "accrual.duration", "accrual.followup", "cost"]);
  assert.deepEqual(designSettings({ configuration: { design: { kind: "x" }, mystery: { knob: 3 } } }), [], "a number the table does not name is not offered");
  const criteria = criteriaSettings([
    { sourceText: "年龄 ≥ 18 岁", requirement: { op: "compare", variable: "age", value: 18 } },
    { sourceText: "妊娠", requirement: { op: "absent", variable: "pregnancy" } },
    { sourceText: "ECOG 0–1（近 4 周内）", requirement: { op: "compare", variable: "ecog", value: 1, window: { days: 28 } } },
  ]);
  assert.deepEqual(criteria.map((entry) => [entry.path, entry.label]), [
    ["0.requirement.value", "年龄 ≥ 18 岁 · 界值"], ["2.requirement.value", "ECOG 0–1（近 4 周内） · 界值"], ["2.requirement.window.days", "ECOG 0–1（近 4 周内） · 证据时效"]]);
});

test("editing a population writes its next version, asks for the step and marks what stood on the old version", options, async () => {
  const { study, userId, population, cards, heard } = await furnish();
  const read = await cards.read(study, "population", null);
  assert.equal(read.objectId, population.id);
  assert.equal(read.settings.find((entry) => entry.path === "n")?.value, 1000);

  const written = await cards.apply(study, { id: userId }, { kind: "population", objectId: population.id, set: { n: 2000, "population.variables.0.mean": 60 } });
  assert.equal(written.kind, "population");
  assert.equal(written.changed, 2);
  const [next, old] = await store.populations(study.id, 5);
  assert.equal(next.id, written.id);
  assert.notEqual(next.id, old.id, "the old version stays as it was: an edit is a new version, never an update");
  assert.equal(next.version, old.version + 1);
  assert.equal(next.definition.n, 2000);
  assert.equal(next.definition.population.variables[0].mean, 60);
  assert.equal(old.definition.n, 1000);
  assert.equal(next.reviewState, "reviewed", "a person's edit is a reviewed version, like an assumption card the page edits");
  assert.equal(next.name, "情景人群");
  assert.deepEqual(next.allowedUses, ["design"]);

  assert.equal((await store.studyById(study.id))?.steps.population.requested, true, "the person who changed a number wants the result under it");
  assert.equal(heard.length, 1);
  assert.deepEqual(heard[0].changed, [`population:${old.id}@${old.version}`], "what stood on the old version is what goes stale");
  assert.equal(heard[0].reason, "criterion_changed");

  // Only the newest version is edited.
  await assert.rejects(cards.apply(study, { id: userId }, { kind: "population", objectId: old.id, set: { n: 1 } }), { code: "vcr_card_not_current" });
});

test("a value the engine's schema refuses, a setting the object does not offer and a change that changes nothing write nothing", options, async () => {
  const { study, userId, population, cards, heard } = await furnish();
  const before = (await store.populations(study.id, 10)).length;
  /** @param {Record<string, any>} set */
  const attempt = (set) => cards.apply(study, { id: userId }, { kind: "population", objectId: population.id, set });
  await assert.rejects(attempt({ "population.variables.0.sd": -3 }), (/** @type {any} */ error) => error.code === "vcr_card_edit_refused" && /age 标准差/.test(error.message));
  await assert.rejects(attempt({ n: 1000.5 }), (/** @type {any} */ error) => error.code === "vcr_card_edit_refused" && /整数/.test(error.message));
  await assert.rejects(attempt({ n: "2000" }), { code: "vcr_card_edit_refused" });
  await assert.rejects(attempt({ "population.variables.0.name": 3 }), { code: "vcr_card_edit_refused" }, "a path the list does not hold is refused");
  await assert.rejects(attempt({ "population.variables.9.mean": 3 }), { code: "vcr_card_edit_refused" });
  await assert.rejects(attempt({ n: 1000 }), { code: "vcr_card_edit_unchanged" });
  await assert.rejects(attempt({}), { code: "vcr_card_edit_empty" });
  assert.equal((await store.populations(study.id, 10)).length, before, "nothing was versioned");
  assert.deepEqual(heard, [], "and nothing went stale");
});

test("editing a design versions that design alone, under its label, and the other designs are not touched", options, async () => {
  const { study, userId, a, b, cards, heard } = await furnish();
  const read = await cards.read(study, "trial_scenario", a.id);
  assert.equal(read.title, "A 固定设计");
  assert.equal(read.settings.find((entry) => entry.path === "design.nTreat")?.label, "试验组人数");

  const written = await cards.apply(study, { id: userId }, { kind: "trial_scenario", objectId: a.id, set: { "design.nTreat": 450, "design.nControl": 450, "analysis.alpha": 0.05 } });
  const scenarios = await store.trialScenarios(study.id, 20);
  const next = scenarios.find((row) => row.id === written.id);
  assert.equal(next.label, "A 固定设计");
  assert.equal(next.configuration.design.nTreat, 450);
  assert.equal(next.configuration.analysis.alpha, 0.05);
  assert.equal(next.configuration.truth.hazardRatio, 0.8, "what was not edited is carried over");
  assert.equal(scenarios.find((row) => row.id === a.id).configuration.design.nTreat, 400, "the old version is as it was");
  assert.equal(scenarios.find((row) => row.id === b.id).configuration.design.nTreat, 400, "another design is untouched");
  assert.equal((await store.studyById(study.id))?.steps.trial.requested, true);
  assert.deepEqual(heard[0].changed, [`trial_scenario:${a.id}@${a.version}`]);
  assert.equal(heard[0].reason, "protocol_revised");

  await assert.rejects(cards.apply(study, { id: userId }, { kind: "trial_scenario", objectId: a.id, set: { "design.nTreat": 500 } }), { code: "vcr_card_not_current" }, "the old version of a design is not edited");
  await assert.rejects(cards.apply(study, { id: userId }, { kind: "trial_scenario", objectId: written.id, set: { "analysis.alpha": 0.9 } }), { code: "vcr_card_edit_refused" });
  await assert.rejects(cards.apply(study, { id: userId }, { kind: "trial_scenario", objectId: "scn_nobody", set: { "design.nTreat": 5 } }), { code: "vcr_card_not_found" });
});

test("editing the criteria's numbers writes the whole protocol again as its next version, with the applicability each criterion had", options, async () => {
  const { study, userId, cards, heard } = await furnish();
  const read = await cards.read(study, "criteria", null);
  assert.deepEqual(read.settings.map((entry) => entry.label), ["年龄 ≥ 18 岁 · 界值", "末次免疫治疗距今不足 28 天 · 时间窗"]);

  const written = await cards.apply(study, { id: userId }, { kind: "criteria", set: { "0.requirement.value": 20, "1.requirement.days": 42 } });
  assert.equal(written.version, 2);
  const protocol = await store.latestProtocolVersion(study.id);
  assert.equal(protocol.version, 2);
  const criteria = await matchStore.listCriteria({ studyId: study.id, protocolVersionId: protocol.id });
  assert.equal(criteria.length, 2, "every criterion travels, not only the edited ones");
  assert.equal(criteria[0].requirement.value, 20);
  assert.equal(criteria[1].requirement.days, 42);
  assert.equal(criteria[0].sourceText, "年龄 ≥ 18 岁", "the protocol's own sentence is kept");
  assert.equal(criteria[0].reviewState, "reviewed");
  assert.deepEqual(criteria[0].applicability, { op: "present", variable: "enrolled" }, "applicability is its own column and travels with the criterion");
  assert.equal(criteria[1].applicability ?? null, null);
  assert.equal(heard[0].reason, "criterion_changed");
  assert.deepEqual(heard[0].changed, [`protocol_version:${protocol.id}@2`]);
  assert.equal((await store.studyById(study.id))?.steps.population.requested, true);

  await assert.rejects(cards.apply(study, { id: userId }, { kind: "criteria", set: { "1.requirement.days": -2 } }), { code: "vcr_card_edit_refused" });
  await assert.rejects(cards.apply(study, { id: userId }, { kind: "criteria", set: { "5.requirement.value": 1 } }), { code: "vcr_card_edit_refused" });
});

test("a study with nothing to edit says so by name", options, async () => {
  const userId = `u_${randomUUID().slice(0, 8)}`;
  const study = await store.createStudy({ userId, projectId: `prj_${randomUUID().slice(0, 8)}`, name: "空研究" });
  const cards = createVcrCardEdits({ store, matchStore });
  await assert.rejects(cards.read(study, "population", null), { code: "vcr_card_not_found" });
  await assert.rejects(cards.read(study, "criteria", null), { code: "vcr_card_not_found" });
  await assert.rejects(cards.read(study, "trial_scenario", "scn_x"), { code: "vcr_card_not_found" });
});
