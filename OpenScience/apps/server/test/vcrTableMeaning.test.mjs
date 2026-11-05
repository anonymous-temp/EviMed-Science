// What a study's subject table means (G7, G21): the model proposes once, the dataset remembers, the evaluator applies it exactly.
//
// The model is a double that answers from the prompt it is given; the dataset-semantics service runs on the ledger double (and, in the
// last case, on PostgreSQL), so what is recorded is what the real service accepts. Nothing here calls a provider.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { DATA_DRIFT_BOUNDS, isDatasetId } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { DataSemanticsService } from "../src/dataSemanticsService.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { vcrSubjectTableSeam } from "../src/vcrComposition.mjs";
import { assessSubject, storedExclusion } from "../src/vcrMatching.mjs";
import { subjectTableFacts } from "../src/vcrMatchingTable.mjs";
import {
  TABLE_MEANING_TABLE, acceptTableMeaning, ensureTableMeaning, meaningDigest, planTableMeaning, readTableMeaning, tableMeaningDatasetId,
} from "../src/vcrTableMeaning.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const STUDY = { id: "std_1", userId: "u1", projectId: "p1" };
const config = { deepseekModel: "deepseek-flash" };
const PEOPLE = Array.from({ length: 12 }, (_, index) => `P${String(index + 1).padStart(3, "0")}`);
/** Two people have diabetes (P003 and P007); the others do not. */
const DIABETES = (/** @type {string} */ key) => (key === "P003" || key === "P007" ? "1" : "0");

/** @param {{ diabetes?: (key: string) => string }} [options] */
function table({ diabetes = DIABETES } = {}) {
  return {
    available: true, snapshotId: "snp_Table/1", sha256: "a".repeat(64), withheld: [],
    header: ["USUBJID", "age", "DIABETES", "EGFR_STATUS", "hb"],
    rows: PEOPLE.map((key, index) => [key, String(40 + index), diabetes(key), index % 3 === 0 ? "Positive" : index % 3 === 1 ? "Negative" : "Unknown", String(100 + index * 3)]),
    columns: [
      { name: "age", source: "AGE", concept: "age", unit: "year", type: "integer" },
      { name: "DIABETES", source: "DIABETES", concept: "", unit: null, type: "integer" },
      { name: "EGFR_STATUS", source: "EGFR", concept: "", unit: null, type: "text" },
      { name: "hb", source: "HGB", concept: "haemoglobin", unit: "g/L", type: "number" },
    ],
  };
}

/** The model's answer, as the double gives it: what a careful reader would say of the fixture's columns. */
const READING = {
  columns: [
    { name: "DIABETES", concept: "diabetes", measurement: false, values: { 0: "absent", 1: "present" } },
    { name: "EGFR_STATUS", concept: "egfr_mutation", measurement: false, values: { Positive: "present", Negative: "absent", Unknown: "unknown" } },
    { name: "hb", concept: null, measurement: true, values: {} },
    { name: "age", concept: null, measurement: true },
  ],
};

/** @param {any} answer a value or a function of the prompt */
function model(answer = READING) {
  /** @type {any[]} */ const calls = [];
  const callModel = async (/** @type {any} */ _deps, /** @type {any} */ call) => {
    calls.push(call);
    const next = typeof answer === "function" ? answer(call) : answer;
    if (next instanceof Error) throw next;
    return { choices: [{ finish_reason: "stop", message: { content: typeof next === "string" ? next : JSON.stringify(next) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
  };
  return { callModel, calls };
}

const semanticsOn = (/** @type {any} */ documents = productDocumentsDouble()) => new DataSemanticsService({ documents });
const ensure = (/** @type {any} */ over) => ensureTableMeaning({ study: STUDY, table: table(), variables: ["age", "diabetes"], config, ...over });

test("the dataset id is derived from the snapshot and always in the semantics alphabet", () => {
  for (const snapshot of ["snp_1", "SNP/Weird Name!", "é".repeat(200)]) assert.equal(isDatasetId(tableMeaningDatasetId(snapshot)), true, snapshot);
  assert.notEqual(tableMeaningDatasetId("a"), tableMeaningDatasetId("b"));
});

test("the model is shown names, types, units and the codes of a vocabulary column, and never a row or a person", async () => {
  const double = model();
  await ensure({ semantics: semanticsOn(), callModel: double.callModel, variables: ["age", "diabetes", "egfr_mutation"] });
  assert.equal(double.calls.length, 1);
  const call = double.calls[0];
  assert.equal(call.purpose, "vcr");
  assert.equal(call.body.model, "deepseek-flash");
  assert.deepEqual(call.body.response_format, { type: "json_object" });
  const prompt = call.body.messages.map((/** @type {any} */ message) => message.content).join("\n");
  assert.match(prompt, /"name":"DIABETES"/);
  assert.match(prompt, /"values":\["0","1"\]/);
  assert.match(prompt, /egfr_mutation/);
  assert.doesNotMatch(prompt, /P0\d\d/, "no subject key");
  assert.doesNotMatch(prompt, /"values":\[[^\]]*"100"/, "a column of one value per person is a measurement and lists none");
  assert.doesNotMatch(prompt, /Table\/1/, "not even the snapshot's name");
});

test("a column with more codes than a vocabulary may have is offered with no codes and gets no map; a small table's codes are offered", async () => {
  const wide = table();
  wide.rows = Array.from({ length: 60 }, (_, index) => [`P${index}`, String(20 + index), String(index % 40), "Positive", "120"]);
  const plan = planTableMeaning({ table: wide, variables: ["diabetes"], meaning: { columns: {}, asked: [] }, floor: 10 });
  const brief = (/** @type {string} */ name) => plan?.briefs.find((item) => item.name === name);
  assert.equal(brief("DIABETES")?.values, undefined);
  assert.equal(brief("DIABETES")?.distinct, `more than ${DATA_DRIFT_BOUNDS.vocabularyMax}`);
  const small = table();
  small.rows = small.rows.slice(0, 5);
  // A small table's codes are read too: 0 and 1 mean what they mean however few people there are, and without them every presence criterion stays open for good.
  const codes = planTableMeaning({ table: small, variables: ["diabetes"], meaning: { columns: {}, asked: [] }, floor: 10 })?.briefs.find((item) => item.name === "DIABETES");
  assert.deepEqual(codes?.values, ["0", "1"], "under the small-cell floor");
  const two = table();
  two.rows = two.rows.slice(0, 2);
  assert.ok(planTableMeaning({ table: two, variables: ["diabetes"], meaning: { columns: {}, asked: [] }, floor: 10 })?.briefs.find((item) => item.name === "DIABETES")?.values?.length, "two people, two codes");
  const manyLevels = table();
  manyLevels.rows = Array.from({ length: 8 }, (_, index) => [`P${index}`, String(20 + index), `level-${index}`, "Positive", "120"]);
  assert.equal(planTableMeaning({ table: manyLevels, variables: ["diabetes"], meaning: { columns: {}, asked: [] }, floor: 10 })?.briefs.find((item) => item.name === "DIABETES")?.values, undefined, "one value a person is no list of codes, in a small table as in a large one");
  // an answer that lists codes for such a column is not kept
  const accepted = acceptTableMeaning({ columns: [{ name: "DIABETES", measurement: false, values: { 1: "present" } }] }, /** @type {any} */ (plan));
  assert.deepEqual(accepted.get("DIABETES"), { valueMap: { values: {}, measurement: false } });
});

test("the proposal is recorded as model_inferred facts of the dataset, and the next start finds it and asks nothing", async () => {
  const documents = productDocumentsDouble();
  const semantics = semanticsOn(documents);
  const double = model();
  const first = await ensure({ semantics, callModel: double.callModel, variables: ["age", "diabetes", "egfr_mutation"] });
  assert.equal(first.status, "proposed");
  assert.equal(double.calls.length, 1);
  assert.deepEqual(first.meaning?.columns.DIABETES?.valueMap, { values: { 0: "absent", 1: "present" }, measurement: false });
  assert.equal(first.meaning?.columns.EGFR_STATUS?.concept, "egfr_mutation");
  assert.equal(first.meaning?.columns.hb?.valueMap?.measurement, true);
  assert.ok(first.digest, "the meaning does something for these variables, so it has a digest");

  const record = await semantics.get("u1", "p1", tableMeaningDatasetId("snp_Table/1"));
  const variable = record?.asset.tables.find((/** @type {any} */ item) => item.name === TABLE_MEANING_TABLE).variables.find((/** @type {any} */ item) => item.name === "DIABETES");
  assert.equal(variable.facts.valueMap.basis, "model_inferred");
  assert.ok(variable.facts.valueMap.inferredFrom.length >= 1);
  assert.equal(JSON.stringify(record?.asset).includes("P003"), false, "no subject key in the record");

  const again = await ensure({ semantics, callModel: double.callModel, variables: ["age", "diabetes", "egfr_mutation"] });
  assert.equal(again.status, "recorded");
  assert.equal(double.calls.length, 1, "a second start costs nothing");
  assert.equal(again.digest, first.digest);
  const subset = await ensure({ semantics, callModel: double.callModel, variables: ["diabetes"] });
  assert.equal(subset.status, "recorded");
  assert.equal(double.calls.length, 1, "a smaller set of criteria costs nothing either");
  // variables looked for and not found are remembered too
  const asked = await ensure({ semantics, callModel: double.callModel, variables: ["diabetes", "pregnancy"] });
  assert.equal(double.calls.length, 2, "a new variable is one question");
  const afterwards = await ensure({ semantics, callModel: double.callModel, variables: ["diabetes", "pregnancy"] });
  assert.equal(double.calls.length, 2, "and a question the model could not answer is not asked again");
  assert.equal(asked.status, "proposed");
  assert.equal(afterwards.status, "recorded");
});

test("a researcher's word outranks the model's and a later proposal never overwrites it", async () => {
  const semantics = semanticsOn();
  const datasetId = tableMeaningDatasetId("snp_Table/1");
  // the researcher corrects the meaning first: 2 means present, and nothing else is claimed
  await semantics.write("u1", "p1", {
    datasetId, basis: "researcher_confirmed", statement: "DIABETES 列：1 和 2 都是有，0 是没有",
    variables: [{ table: TABLE_MEANING_TABLE, name: "DIABETES", concept: "diabetes", valueMap: { values: { 0: "absent", 1: "present", 2: "present" }, measurement: false } }],
  }, { via: "conversation" });
  const double = model();
  const found = await ensure({ semantics, callModel: double.callModel, variables: ["age", "diabetes", "egfr_mutation"] });
  const briefed = double.calls[0].body.messages[0].content;
  assert.doesNotMatch(briefed, /"name":"DIABETES"/, "a column the researcher has settled is not asked about");
  assert.deepEqual(found.meaning?.columns.DIABETES?.valueMap?.values, { 0: "absent", 1: "present", 2: "present" });
  // and a stale proposal that reaches the dataset any other way is kept beside it, not over it
  const late = await semantics.write("u1", "p1", {
    datasetId, basis: "model_inferred", inferredFrom: ["a later reading"],
    variables: [{ table: TABLE_MEANING_TABLE, name: "DIABETES", valueMap: { values: { 0: "absent", 1: "absent" }, measurement: false } }],
  }, { via: "conversation" });
  assert.equal(late.outcomes.find((/** @type {any} */ item) => item.target.endsWith(":valueMap"))?.outcome, "kept_stronger");
  const kept = readTableMeaning((await semantics.get("u1", "p1", datasetId))?.asset);
  assert.deepEqual(kept.columns.DIABETES.valueMap.values, { 0: "absent", 1: "present", 2: "present" });
});

test("what the model says is held to what was offered: an invented code, a state out of vocabulary, a concept not asked and a column not shown are dropped", () => {
  const plan = /** @type {NonNullable<ReturnType<typeof planTableMeaning>>} */ (planTableMeaning({ table: table(), variables: ["diabetes", "egfr_mutation"], meaning: { columns: {}, asked: [] }, floor: 10 }));
  const accepted = acceptTableMeaning({ columns: [
    { name: "DIABETES", concept: "diabetes_mellitus", measurement: false, values: { 0: "absent", 1: "yes", 9: "present" } },
    { name: "EGFR_STATUS", concept: "egfr_mutation", measurement: "maybe", values: { Positive: "present" } },
    { name: "NOT_A_COLUMN", concept: "egfr_mutation", values: { 1: "present" } },
    { name: "EGFR_STATUS", concept: "other", values: { Negative: "present" } },
  ] }, plan);
  assert.deepEqual(accepted.get("DIABETES"), { valueMap: { values: { 0: "absent" }, measurement: false } });
  assert.deepEqual(accepted.get("EGFR_STATUS"), { concept: "egfr_mutation", valueMap: { values: { Positive: "present" }, measurement: false } }, "the first entry for a column is the one kept");
  assert.equal(accepted.has("NOT_A_COLUMN"), false);
  assert.deepEqual(acceptTableMeaning("nonsense", plan).get("hb"), { valueMap: { values: {}, measurement: false } }, "an unreadable answer still marks the columns as read, with nothing in them");
});

test("a model that fails, answers badly or is refused leaves every code unknown and says the meaning could not be proposed; nothing throws", async () => {
  const cases = [
    ["the model is down", model(Object.assign(new Error("down"), { code: "upstream_unavailable" })), "upstream_unavailable"],
    ["the budget is spent", model(Object.assign(new Error("spent"), { code: "insufficient_quota" })), "insufficient_quota"],
    ["the answer is not JSON", model("sorry, I cannot"), "vcr_table_meaning_failed"],
  ];
  for (const [label, double, code] of /** @type {Array<[string, ReturnType<typeof model>, string]>} */ (cases)) {
    const semantics = semanticsOn();
    const result = await ensure({ semantics, callModel: double.callModel });
    assert.equal(result.status, "not_proposed", label);
    assert.equal(result.code, code, label);
    assert.match(result.message ?? "", /未记载/, label);
    assert.equal(result.meaning?.columns && Object.keys(result.meaning.columns).length, 0, label);
    assert.equal(result.digest, null, label);
    assert.equal(await semantics.get("u1", "p1", tableMeaningDatasetId("snp_Table/1")), null, `${label}: nothing was written`);
    // and the codes read unknown, which the evaluator never turns into an exclusion
    const built = subjectTableFacts({ ...table(), variables: ["diabetes"], meaning: result.meaning });
    assert.ok(built.subjects.every((subject) => subject.facts.every((fact) => fact.presence === "unknown")), label);
  }
  const cut = await ensure({ semantics: semanticsOn(), callModel: async () => ({ choices: [{ finish_reason: "length", message: { content: "{" } }] }) });
  assert.equal(cut.status, "not_proposed");
  const slow = await ensure({ semantics: semanticsOn(), signal: AbortSignal.abort(), callModel: async (_deps, call) => { call.signal.throwIfAborted(); return {}; } });
  assert.equal(slow.status, "not_proposed");
});

test("the codes leave only under the source's cloud permission: a refusal makes no call and says why", async () => {
  const double = model();
  const refused = await ensure({ semantics: semanticsOn(), callModel: double.callModel,
    authorizeCloud: async () => { throw Object.assign(new Error("no"), { code: "vcr_cloud_processing_not_authorized" }); } });
  assert.equal(double.calls.length, 0);
  assert.deepEqual([refused.status, refused.code], ["not_proposed", "vcr_cloud_processing_not_authorized"]);
  const allowed = [];
  const fine = await ensure({ semantics: semanticsOn(), callModel: double.callModel, authorizeCloud: async (/** @type {any} */ input) => { allowed.push(input.fields); } });
  assert.equal(fine.status, "proposed");
  assert.deepEqual(allowed[0].sort(), ["DIABETES", "age"]);
});

test("a job that only runs never asks the model, and with no semantics service nothing is asked or written", async () => {
  const double = model();
  const running = await ensure({ semantics: semanticsOn(), callModel: double.callModel, propose: false });
  assert.deepEqual([running.status, double.calls.length, running.digest], ["recorded", 0, null]);
  const none = await ensure({ semantics: null, callModel: double.callModel });
  assert.deepEqual([none.status, none.meaning, double.calls.length], ["unavailable", null, 0]);
  const projectless = await ensureTableMeaning({ study: { id: "s", userId: "u" }, table: table(), variables: ["diabetes"], semantics: semanticsOn(), config, callModel: double.callModel });
  assert.equal(projectless.status, "unavailable");
  const broken = await ensure({ semantics: { get: async () => { throw Object.assign(new Error("db"), { code: "database_unavailable" }); }, write: async () => {} }, callModel: double.callModel });
  assert.deepEqual([broken.status, broken.code, double.calls.length], ["unavailable", "database_unavailable", 0]);
  const unwritable = await ensure({ semantics: { get: async () => null, write: async () => { throw Object.assign(new Error("too big"), { code: "semantics_asset_too_large" }); } }, callModel: double.callModel });
  assert.deepEqual([unwritable.status, unwritable.code], ["not_proposed", "semantics_asset_too_large"]);
});

test("two starts at once make one call", async () => {
  const semantics = semanticsOn();
  let release = () => {};
  const gate = new Promise((resolve) => { release = () => resolve(null); });
  const double = model(() => READING);
  const slowModel = async (/** @type {any} */ deps, /** @type {any} */ call) => { await gate; return double.callModel(deps, call); };
  const both = Promise.all([ensure({ semantics, callModel: slowModel }), ensure({ semantics, callModel: slowModel })]);
  release();
  const [a, b] = await both;
  assert.equal(double.calls.length, 1);
  assert.equal(a.digest, b.digest);
});

test("the digest names what the meaning does to the criteria's variables and moves when a map is corrected", async () => {
  const semantics = semanticsOn();
  const found = await ensure({ semantics, callModel: model().callModel, variables: ["diabetes", "egfr_mutation"] });
  const subject = table();
  assert.equal(meaningDigest({ table: subject, variables: ["pregnancy"], meaning: found.meaning }), null, "a variable no column answers has nothing to digest");
  assert.equal(meaningDigest({ table: subject, variables: ["diabetes"], meaning: null }), null);
  const before = meaningDigest({ table: subject, variables: ["diabetes"], meaning: found.meaning });
  assert.ok(before);
  assert.equal(meaningDigest({ table: subject, variables: ["diabetes", "diabetes"], meaning: found.meaning }), before);
  const corrected = structuredClone(found.meaning);
  /** @type {any} */ (corrected).columns.DIABETES.valueMap.values["1"] = "absent";
  assert.notEqual(meaningDigest({ table: subject, variables: ["diabetes"], meaning: corrected }), before);
  // a column the variables do not reach does not move it
  /** @type {any} */ const elsewhere = structuredClone(found.meaning);
  elsewhere.columns.EGFR_STATUS.valueMap.values.Unknown = "present";
  assert.equal(meaningDigest({ table: subject, variables: ["diabetes"], meaning: elsewhere }), before);
});

// ---------------------------------------------------------------------------
// Through the seam, into the plan: the prefilter inherits the fix
// ---------------------------------------------------------------------------

const CRITERIA = [
  { id: "age", kind: "inclusion", criterionType: "demographic", sourceText: "Age >= 18", requirement: { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "year" } },
  { id: "dm", kind: "exclusion", criterionType: "comorbidity", sourceText: "Diabetes", requirement: storedExclusion({ op: "present", variable: "diabetes" }) },
  { id: "egfr", kind: "inclusion", criterionType: "biomarker", sourceText: "EGFR mutation", requirement: { op: "present", variable: "egfr_mutation" } },
  // a variable no column holds: the record is read for it, which is what makes a prefilter worth having
  { id: "bm", kind: "exclusion", criterionType: "comorbidity", sourceText: "Active brain metastases", requirement: storedExclusion({ op: "present", variable: "brain_metastasis" }) },
];
/** The seam over a plane double that serves the fixture table and records its cloud authorizations. */
function seamOn(/** @type {any} */ double, /** @type {any} */ semantics = semanticsOn(), /** @type {any} */ source = table()) {
  /** @type {any[]} */ const authorized = [];
  const dataPlane = {
    async subjectTableForMatching() { return structuredClone(source); },
    async authorizeSubjectTableCloudRead(/** @type {any} */ input) { authorized.push(input); return { basis: "deployment_agreements" }; },
  };
  return { seam: vcrSubjectTableSeam({ dataPlane: /** @type {any} */ (dataPlane), semantics: () => semantics, config, callModel: double.callModel }), authorized };
}

test("the seam reads the meaning with the table when asked the variables, and a running job reads it without asking", async () => {
  const double = model();
  const semantics = semanticsOn();
  const { seam } = seamOn(double, semantics);
  const plain = await seam.read(STUDY);
  assert.equal(plain.meaning, undefined);
  assert.equal(double.calls.length, 0);
  const running = await seam.read(STUDY, { variables: ["diabetes"], propose: false });
  assert.deepEqual([running.meaningStatus.status, running.meaningDigest, double.calls.length], ["recorded", null, 0]);
  const frozen = await seam.read(STUDY, { variables: ["diabetes"], propose: true });
  assert.equal(frozen.meaningStatus.status, "proposed");
  assert.ok(frozen.meaningDigest);
  const later = await seam.read(STUDY, { variables: ["diabetes"], propose: false });
  assert.equal(later.meaningDigest, frozen.meaningDigest, "what the freeze saw is what the run sees");
  assert.equal(later.meaningStatus.status, "recorded");
  // the facts the evaluator reads
  const facts = subjectTableFacts({ ...later, variables: ["diabetes"] });
  const by = (/** @type {string} */ key) => assessSubject({ studyId: "s", subjectKey: key, criteria: [CRITERIA[1]], facts: facts.subjects.find((item) => item.subjectKey === key)?.facts ?? [], asOf: "2026-10-05T00:00:00.000Z" }).summary;
  assert.deepEqual([by("P001"), by("P003")], ["eligible", "ineligible"]);
});

// ---------------------------------------------------------------------------
// On PostgreSQL
// ---------------------------------------------------------------------------

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const owner = `tablemeaning_${randomUUID()}`;
/** @type {any} */ let database;
/** @type {any} */ let isolated;
/** @type {any} */ let documents;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "tablemeaning");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Table meaning test','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'project-vcr','Table meaning project',1000000)", [owner]);
  documents = new ProductDocuments(database);
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  await database.close();
  await isolated.drop();
});

test("on PostgreSQL: the proposal survives the process that made it, a correction is a revision that outranks it, and a later start costs nothing", { skip: !databaseUrl && "Local test Postgres is not configured" }, async () => {
  const study = { id: "std_pg", userId: owner, projectId: "project-vcr" };
  const asks = [];
  const double = model();
  const first = await ensureTableMeaning({ study, table: table(), variables: ["diabetes", "egfr_mutation"], semantics: new DataSemanticsService({ documents }), config, callModel: double.callModel });
  assert.equal(first.status, "proposed");
  asks.push(double.calls.length);
  // another service object over the same ledger: a restart
  const restarted = new DataSemanticsService({ documents });
  const second = await ensureTableMeaning({ study, table: table(), variables: ["diabetes", "egfr_mutation"], semantics: restarted, config, callModel: double.callModel });
  assert.equal(second.status, "recorded");
  assert.equal(double.calls.length, 1);
  assert.equal(second.digest, first.digest);

  const datasetId = tableMeaningDatasetId("snp_Table/1");
  await restarted.write(owner, "project-vcr", {
    datasetId, basis: "researcher_confirmed", statement: "是 / Yes 也算有",
    variables: [{ table: TABLE_MEANING_TABLE, name: "DIABETES", valueMap: { values: { 0: "absent", 1: "present", 是: "present" }, measurement: false } }],
  }, { via: "conversation" });
  const stale = await restarted.write(owner, "project-vcr", {
    datasetId, basis: "model_inferred", inferredFrom: ["a stale proposal"],
    variables: [{ table: TABLE_MEANING_TABLE, name: "DIABETES", valueMap: { values: { 0: "present" }, measurement: false } }],
  }, { via: "conversation" });
  assert.equal(stale.outcomes.find((/** @type {any} */ item) => item.target.endsWith(":valueMap"))?.outcome, "kept_stronger");
  const third = await ensureTableMeaning({ study, table: table(), variables: ["diabetes", "egfr_mutation"], semantics: restarted, config, callModel: double.callModel });
  assert.deepEqual(third.meaning?.columns.DIABETES?.valueMap?.values, { 0: "absent", 1: "present", 是: "present" });
  assert.notEqual(third.digest, first.digest, "the corrected map is a different input to a job frozen before it");
  assert.equal(double.calls.length, 1);
  // another project's dataset of the same snapshot is another asset
  const other = await ensureTableMeaning({ study: { ...study, projectId: "project-elsewhere" }, table: table(), variables: ["diabetes"], semantics: restarted, config, callModel: double.callModel, propose: false });
  assert.deepEqual([other.status, Object.keys(other.meaning?.columns ?? {}).length], ["recorded", 0], "nothing is read across projects");
});
