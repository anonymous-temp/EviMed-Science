// The records a comparison keeps beside its estimate (remediation plan A6, A7, A8, A13), on the REAL store of a real PostgreSQL: the
// closed target-trial record a write stores (whichever shape it arrived in), the role of an effect on its assumption card and its
// carrying over a person's edit, and the lower ceiling of use a benchmark is filed with.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { vcrTargetTrial } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { vcrRuntimeWrite } from "../src/vcrGateway.mjs";

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
/** @type {pg.Client | null} */
let admin = null;
let isolatedName = "";

before(async () => {
  if (!databaseUrl) return;
  const source = new URL(databaseUrl);
  isolatedName = `${decodeURIComponent(source.pathname.slice(1))}_vcrrec_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  assert.match(isolatedName, /^evimed_test[a-z0-9_]*$/);
  admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${isolatedName}"`);
  source.pathname = `/${isolatedName}`;
  database = new ControlPlaneDatabase({ databaseUrl: source.href, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  store = new VcrStore({ database });
  await store.ready();
});

after(async () => {
  await database?.close().catch(() => {});
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

async function furnish(intendedUse = "specified_analysis") {
  const userId = `u_${randomUUID().slice(0, 8)}`;
  const created = await store.createStudy({ userId, projectId: `prj_${randomUUID().slice(0, 8)}`, name: "对照记录", question: "q" });
  await store.saveDefinition({ studyId: created.id, userId, pico: { population: "成人" }, endpointType: "time_to_event", intendedUse });
  const study = await store.studyById(created.id);
  return { study: /** @type {any} */ (study), userId };
}

const write = (/** @type {any} */ study, /** @type {string} */ what, /** @type {any} */ data) =>
  vcrRuntimeWrite({ store, service: /** @type {any} */ ({}), orchestrator: null, study, what, items: null, data });

const CLOSED = {
  eligibility: { status: "approximate", text: "入排更宽" }, strategies: { status: "exact", text: "试验药对标准治疗" }, assignment: { status: "approximate", text: "靠协变量加权" },
  timeZero: { status: "approximate", text: "从开始治疗之日起算" }, outcome: { status: "exact", text: "总生存期" }, contrast: { status: "exact", text: "风险比" },
  analysis: { status: "exact", text: "加权 Cox" },
};

test("A6: the target trial is stored as the closed record whichever shape it arrived in, and a complete record needs no reminder", options, async () => {
  const { study } = await furnish();
  const complete = await write(study, "comparator", { route: "external_control", estimand: "ATT", targetTrial: CLOSED,
    configuration: { covariates: ["age"], applicability: { state: "suitable", claim: "superiority", note: "同一年代的登记库" } } });
  assert.equal(complete.ok, true, JSON.stringify(complete.issues));
  assert.deepEqual(complete.issues, [], "complete records: nothing refused, nothing to remind");
  const [row] = await store.comparatorDesigns(study.id, 5);
  assert.deepEqual(row.targetTrial, CLOSED);
  assert.equal(row.configuration.applicability.state, "suitable");

  // the page's old two sentences are stored as components with their text, and read back as one record
  const legacy = await write(study, "comparator", { route: "external_control", estimand: "ATT", targetTrial: { population: "二线 NSCLC", treatment: "多西他赛", note: "公开方案" }, configuration: {} });
  assert.equal(legacy.ok, true);
  const stored = (await store.comparatorDesigns(study.id, 5))[0].targetTrial;
  assert.deepEqual(stored.eligibility, { text: "二线 NSCLC" });
  assert.deepEqual(stored.strategies, { text: "多西他赛" });
  assert.equal(stored.note, "公开方案");
  assert.equal(vcrTargetTrial(stored).components.length, 2);
  // it has no status for any component and no applicability: the answer says so, as reminders, and the comparator is saved all the same
  assert.deepEqual(legacy.issues.map((/** @type {any} */ issue) => [issue.field, issue.code]), [["targetTrial", "vcr_comparator_record_incomplete"], ["configuration.applicability", "vcr_comparator_record_incomplete"]]);
  assert.match(legacy.issues[0].message, /还缺：入选标准（没标 status）、处理策略（没标 status）、分配方式、随访起点（时间零点）、结局、对比、分析方法。/,
    "a sentence the run wrote without a status is said apart from a component it did not write");
  assert.match(legacy.issues[0].message, /status 取 exact \/ approximate \/ not_possible/, "and the message says how to write them");
});

test("A6, A7: a status or a claim outside the closed words is refused by name, and nothing is saved", options, async () => {
  const { study } = await furnish();
  const before = (await store.comparatorDesigns(study.id, 5)).length;
  const bad = await write(study, "comparator", { route: "external_control", targetTrial: { timeZero: { status: "maybe", text: "x" } }, configuration: {} });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.issues.map((/** @type {any} */ issue) => [issue.field, issue.code]), [["targetTrial.timeZero", "vcr_write_value_invalid"]]);
  const stray = await write(study, "comparator", { route: "external_control", targetTrial: { followup: { status: "exact" } }, configuration: {} });
  assert.deepEqual(stray.issues.map((/** @type {any} */ issue) => issue.field), ["targetTrial.followup"]);
  const claim = await write(study, "comparator", { route: "external_control", targetTrial: CLOSED, configuration: { applicability: { state: "suitable", claim: "better" } } });
  assert.deepEqual(claim.issues.map((/** @type {any} */ issue) => issue.field), ["configuration.applicability"]);
  const text = await write(study, "comparator", { route: "external_control", targetTrial: { outcome: { status: "exact", text: "x".repeat(400) } }, configuration: {} });
  assert.equal(text.ok, false);
  assert.equal((await store.comparatorDesigns(study.id, 5)).length, before, "a refused item writes nothing");
});

test("A13: an effect card keeps its role, a person's edit carries it over, and a card of an effect without one is reminded and saved", options, async () => {
  const { study, userId } = await furnish();
  const missing = await write(study, "assumption", { key: "hazard_ratio", name: "风险比", pointValue: 0.7, sourceKind: "expert_set", valueSource: "assumed" });
  assert.equal(missing.ok, true);
  assert.deepEqual(missing.issues.map((/** @type {any} */ issue) => [issue.field, issue.code]), [["effectRole", "vcr_assumption_role_missing"]]);
  assert.equal((await store.assumptions(study.id)).find((card) => card.key === "hazard_ratio")?.effectRole, null, "saved all the same");

  const stated = await write(study, "assumption", { key: "hazard_ratio", name: "风险比", pointValue: 0.65, sourceKind: "expert_set", valueSource: "assumed", effectRole: "important_difference" });
  assert.deepEqual(stated.issues, []);
  let card = (await store.assumptions(study.id)).find((entry) => entry.key === "hazard_ratio");
  assert.deepEqual([card?.version, card?.effectRole, card?.pointValue], [2, "important_difference", 0.65]);

  // a person's edit on the page does not say a role; the card keeps the one it had
  await store.saveAssumption({ studyId: study.id, userId, key: "hazard_ratio", name: "风险比", pointValue: 0.6, sourceKind: "expert_set", valueSource: "assumed" });
  card = (await store.assumptions(study.id)).find((entry) => entry.key === "hazard_ratio");
  assert.deepEqual([card?.version, card?.effectRole, card?.pointValue], [3, "important_difference", 0.6]);

  // a card that is no effect is not reminded of a role it has no use for; a role outside the closed words is refused
  const control = await write(study, "assumption", { key: "dropout_rate", name: "脱落率", pointValue: 0.1, sourceKind: "expert_set", valueSource: "assumed" });
  assert.deepEqual(control.issues, []);
  const wrong = await write(study, "assumption", { key: "risk_difference", name: "风险差", pointValue: 0.1, sourceKind: "expert_set", valueSource: "assumed", effectRole: "main" });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.issues[0].field, "effectRole");
  assert.equal((await store.assumptions(study.id)).some((entry) => entry.key === "risk_difference"), false);
});

test("A8: a benchmark is filed with a use no higher than design support, and says what it is a benchmark of", options, async () => {
  const { study, userId } = await furnish("specified_analysis");
  const file = (/** @type {Record<string, any>} */ input) => store.recordResult({ studyId: study.id, userId, kind: "comparator", conclusion: "limited", counts: {}, measures: [],
    diagnostics: {}, tables: [], tiers: ["data"], requestedUse: "specified_analysis", ...input });

  const unanchored = await file({ method: "comparator.maic", diagnostics: { anchored: false, targetPopulation: "aggregate_data_trial" }, subjectId: "cmp_a" });
  assert.equal(unanchored.intendedUse, "design_support", "the method's tier would allow a specified analysis; a benchmark is not one");
  assert.equal(unanchored.useDowngrade?.reason, "benchmark_only");
  assert.equal(unanchored.useDowngrade?.ceiling, "design_support");
  assert.equal(unanchored.diagnostics.benchmarkBasis, "unanchored_maic");

  const anchored = await file({ method: "comparator.maic", diagnostics: { anchored: true }, subjectId: "cmp_b" });
  assert.equal(anchored.intendedUse, "specified_analysis");
  assert.equal(anchored.useDowngrade, null);
  assert.equal(anchored.diagnostics.benchmarkBasis, undefined);

  // a stage folded into an earlier one: the word the earlier stage left in the diagnostics does not follow the later stage's numbers
  const curve = await file({ method: "evidence.reconstruct_km", subjectId: "cmp_c", measures: [{ name: "median_survival", value: 9, source: "reconstructed" }] });
  assert.equal(curve.diagnostics.benchmarkBasis, "literature_curve");
  const compared = await file({ method: "comparator.rmst", subjectId: "cmp_c", diagnostics: { benchmarkBasis: "literature_curve" }, measures: [{ name: "rmst_difference", value: 1.2, source: "calculated" }] });
  assert.equal(compared.diagnostics.benchmarkBasis, undefined);
  assert.equal(compared.intendedUse, "specified_analysis");

  // the ordinary exploratory study is not downgraded by it: the ceiling only lowers
  const { study: exploring, userId: other } = await furnish("exploratory");
  const filed = await store.recordResult({ studyId: exploring.id, userId: other, kind: "comparator", conclusion: "limited", counts: {}, measures: [],
    diagnostics: { anchored: false, targetPopulation: "aggregate_data_trial" }, tables: [], tiers: ["data"], method: "comparator.maic", requestedUse: "exploratory" });
  assert.equal(filed.intendedUse, "exploratory");
  assert.equal(filed.useDowngrade, null);
});
