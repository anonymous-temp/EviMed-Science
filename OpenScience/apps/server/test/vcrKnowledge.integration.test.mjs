// The knowledge package of 「虚拟临研」 on a real PostgreSQL: the packs that are
// rows, the study's binding, the account's library of population definitions
// with its versions and uses, the tenant boundary and the deletion paths.
// Skipped when OPEN_SCIENCE_TEST_POSTGRES_URL is not configured.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { VCR_SHIPPED_PACKS } from "@evimed/domain";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrKnowledge } from "../src/vcrKnowledge.mjs";
import { VcrKnowledgeStore } from "../src/vcrKnowledgeStore.mjs";
import { VCR_COMPARISON_RESULT_KIND } from "../src/vcrPersistence.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { deleteVcrStudyRows, deleteVcrUserRows } from "../src/vcrStoreBase.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {any} */
let database = null;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
/** @type {VcrStore} */
let studies;
/** @type {VcrKnowledgeStore} */
let store;
/** @type {VcrKnowledge} */
let knowledge;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "knowledge");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  studies = new VcrStore({ database });
  store = new VcrKnowledgeStore({ database });
  await studies.ready();
  knowledge = new VcrKnowledge({ store, studyStore: studies });
});

after(async () => {
  if (database) await database.close();
  await isolated?.drop();
});

/** @param {string} sql @param {unknown[]} [values] */
const q = async (sql, values = []) => (await database.query(sql, values)).rows;

let counter = 0;
/** @param {string} userId */
async function newStudy(userId) {
  counter += 1;
  return studies.createStudy({ userId, projectId: `prj_k${counter}`, name: `研究 ${counter}`, question: "q", dataTier: "T0", intendedUse: "exploratory" });
}

const cmp = (/** @type {string} */ column, /** @type {string} */ comparator, /** @type {number} */ value) => ({ op: "compare", column, comparator, value });
const RULES_V1 = [{ name: "adult", rule: cmp("age", "gte", 18) }, { name: "fit", rule: cmp("ecog", "lte", 1) }];
const RULES_V2 = [{ name: "adult", rule: cmp("age", "gte", 50) }, { name: "fit", rule: cmp("ecog", "lte", 1) }];

const DRAFT = Object.freeze({
  disease: { key: "rare_thing", nameZh: "某罕见病", aliases: ["RT"] },
  sources: [{ id: "paper", title: "A review", url: "https://example.org/review", accessed: "2026-10-04", licence: "link-only" }],
  terms: [{ id: "t1", labelZh: "某罕见病", kind: "disease", sources: ["paper"] }],
  endpoints: [{ id: "e1", labelZh: "症状评分变化", type: "continuous", definitionZh: "治疗后评分相对基线的变化。", standard: { name: "the scale the review names" }, sources: ["paper"] }],
  criteria: [{ id: "c1", kind: "inclusion", criterionType: "demographic", requirement: { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "years" }, textZh: "年龄不小于 18 岁。", sources: ["paper"] }],
});

test("the five tables exist, a pack's status is CHECKed to the two words the plan names, and a second start is a no-op", options, async () => {
  for (const table of ["knowledge_packs", "study_packs", "definitions", "definition_versions", "definition_uses"]) {
    assert.equal((await q("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'evimed_vcr' AND table_name = $1", [table]))[0].n, 1, table);
  }
  const study = await newStudy("u_check");
  await assert.rejects(q(`INSERT INTO evimed_vcr.knowledge_packs (id, user_id, study_id, disease_key, version, status, body) VALUES ('pkg_bad', 'u_check', $1, 'x', 1, 'draft', '{}')`, [study.id]), /check|violates/i);
  await q(`INSERT INTO evimed_vcr.knowledge_packs (id, user_id, study_id, disease_key, version, status, body) VALUES ('pkg_good', 'u_check', $1, 'x', 1, 'ai-draft', '{}')`, [study.id]);
});

test("a draft is written for the study, bound to it, versioned per account and disease, and read back through the page's block", options, async () => {
  const study = await newStudy("u_draft");
  const first = await knowledge.draftPack(study, structuredClone(DRAFT), "run:r1");
  assert.equal(first.ok, true, JSON.stringify(/** @type {any} */ (first).issues));
  const binding = await store.studyBinding(study.id);
  assert.deepEqual([binding?.origin, binding?.packVersion], ["stored", 1]);
  // a second draft for the same disease by the same account is the next version, and the study points at it
  const again = await knowledge.draftPack(study, structuredClone(DRAFT), "run:r1");
  assert.equal(again.ok, true);
  assert.equal((await store.studyBinding(study.id))?.packVersion, 2);
  const view = await knowledge.studyKnowledge(study, { canPromote: true });
  assert.deepEqual([view.pack?.status, view.pack?.version, view.pack?.canPromote, view.pack?.origin], ["ai-draft", 2, true, "stored"]);
  assert.deepEqual(view.pack?.sources.map((source) => source.licence), ["link-only"]);
  // the catalogue of this account lists the bound draft; another account's does not
  assert.deepEqual((await knowledge.listPacks("u_draft", "rare")).packs.map((pack) => pack.status), ["ai-draft"]);
  assert.deepEqual((await knowledge.listPacks("u_other", "rare")).packs, []);
  // another account cannot read the row by its id
  await assert.rejects(knowledge.getPack("u_other", /** @type {any} */ (again).id), { status: 404 });
  // an AI draft carries the pack's own head: the platform set status and version
  const row = await store.getPack("u_draft", /** @type {any} */ (again).id);
  assert.deepEqual([row?.body.status, row?.body.version, row?.body.id, row?.studyId], ["ai-draft", 2, "rare_thing", study.id]);
});

test("a reviewed draft is promoted: the same row, curated, with who reviewed it; the catalogue then lists it without a study", options, async () => {
  const study = await newStudy("u_promote");
  await knowledge.draftPack(study, structuredClone({ ...DRAFT, disease: { key: "promotable", nameZh: "可升级的病", aliases: ["PR"] } }), "run");
  const promoted = await knowledge.promotePack(study, "lead_1");
  assert.deepEqual([promoted.status, promoted.reviewedBy], ["curated", "lead_1"]);
  const row = (await q("SELECT status, reviewed_by, body->>'status' AS body_status FROM evimed_vcr.knowledge_packs WHERE disease_key = 'promotable'"))[0];
  assert.deepEqual([row.status, row.reviewed_by, row.body_status], ["curated", "lead_1", "curated"]);
  await assert.rejects(knowledge.promotePack(study, "lead_1"), { status: 409 });
  // the study is deleted: the promoted pack is the account's own and stays, with no origin
  await studies.transaction((client) => deleteVcrStudyRows(client, study.id));
  const kept = (await q("SELECT study_id FROM evimed_vcr.knowledge_packs WHERE disease_key = 'promotable'"))[0];
  assert.equal(kept.study_id, null);
  assert.deepEqual((await knowledge.listPacks("u_promote", "可升级")).packs.map((pack) => pack.status), ["curated"]);
});

test("an unpromoted draft goes with its study; the account's deletion takes every pack and definition it has", options, async () => {
  const study = await newStudy("u_gone");
  await knowledge.draftPack(study, structuredClone({ ...DRAFT, disease: { key: "ephemeral", nameZh: "短暂的病", aliases: ["EP"] } }), "run");
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.knowledge_packs WHERE disease_key = 'ephemeral'"))[0].n, 1);
  await studies.transaction((client) => deleteVcrStudyRows(client, study.id));
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.knowledge_packs WHERE disease_key = 'ephemeral'"))[0].n, 0, "the draft went with the study");
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.study_packs WHERE study_id = $1", [study.id]))[0].n, 0);

  const mine = await newStudy("u_gone");
  await knowledge.draftPack(mine, structuredClone({ ...DRAFT, disease: { key: "kept_draft", nameZh: "保留的病", aliases: ["KD"] } }), "run");
  await knowledge.promotePack(mine, "u_gone");
  await studies.savePopulation({ studyId: mine.id, userId: "u_gone", name: "p", kind: "real", definition: { rules: RULES_V1 } });
  const populations = await studies.populations(mine.id, 10);
  await knowledge.saveFromStudy(mine, { populationId: populations[0].id, name: "我的定义", text: "t" }, "u_gone");
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.definitions WHERE user_id = 'u_gone'"))[0].n, 1);
  await studies.transaction((client) => deleteVcrUserRows(client, "u_gone"));
  for (const table of ["definitions", "definition_versions", "definition_uses", "knowledge_packs"]) {
    assert.equal((await q(`SELECT count(*)::int AS n FROM evimed_vcr.${table} WHERE user_id = 'u_gone'`))[0].n, 0, table);
  }
});

test("a definition is saved from one study, reused in a second, versioned, and counted by the studies that used it", options, async () => {
  const one = await newStudy("u_lib");
  const two = await newStudy("u_lib");
  await studies.savePopulation({ studyId: one.id, userId: "u_lib", name: "成人 ECOG 0-1", kind: "real", definition: { rules: RULES_V1, timeZero: { column: "dxdt" }, snapshotId: "snp_ignored" } });
  const [population] = await studies.populations(one.id, 10);
  const v1 = await knowledge.saveFromStudy(one, { populationId: population.id, text: "年龄不小于 18 岁、ECOG 0 或 1。" }, "u_lib");
  assert.deepEqual([v1.version, v1.name], [1, "成人 ECOG 0-1"]);
  const stored = (await q("SELECT body, source_study_id FROM evimed_vcr.definition_versions WHERE definition_id = $1", [v1.definitionId]))[0];
  assert.deepEqual(Object.keys(stored.body).sort(), ["rules", "timeZero"]);
  assert.equal(stored.source_study_id, one.id);

  // a changed population is the next version of the same entry
  await studies.savePopulation({ studyId: one.id, userId: "u_lib", name: "成人 ECOG 0-1", kind: "real", definition: { rules: RULES_V2 } });
  const newest = (await studies.populations(one.id, 10))[0];
  const v2 = await knowledge.saveFromStudy(one, { populationId: newest.id, definitionId: v1.definitionId, text: "年龄不小于 50 岁、ECOG 0 或 1。" }, "u_lib");
  assert.equal(v2.version, 2);

  // the second study uses version 1; using it again in the same study is not a second use
  const used = await knowledge.useInStudy(two, { definitionId: v1.definitionId, version: 1 }, "u_lib");
  assert.equal(used.version, 1);
  await knowledge.useInStudy(two, { definitionId: v1.definitionId, version: 1 }, "u_lib");
  const library = await knowledge.listLibrary("u_lib");
  assert.deepEqual(library.definitions.map((entry) => [entry.name, entry.versions, entry.uses, entry.latest?.version]), [["成人 ECOG 0-1", 2, 2, 2]]);
  const detail = await knowledge.getLibraryDefinition("u_lib", v1.definitionId);
  assert.deepEqual(detail.versions.map((version) => version.version), [2, 1]);
  assert.deepEqual([...new Set(detail.studies.map((study) => study.studyName))].sort(), [one.name, two.name].sort());
  assert.deepEqual(detail.versions[1].rules, RULES_V1, "version 1 is what it was when the second study used it");

  // the second study's page says what it used, and the population that came of it is a real one with the rules
  const page = await knowledge.studyKnowledge(two);
  assert.deepEqual(page.definitions.map((entry) => [entry.name, entry.version, entry.versions, entry.uses]), [["成人 ECOG 0-1", 1, 2, 2]]);
  const made = (await studies.populations(two.id, 10)).at(-1);
  assert.deepEqual([made?.kind, made?.definition.rules], ["real", RULES_V1]);

  // deleting the second study takes its use with it; the definition and the count of what remains stay true
  await studies.transaction((client) => deleteVcrStudyRows(client, two.id));
  assert.equal((await knowledge.listLibrary("u_lib")).definitions[0].uses, 1);
  assert.equal((await knowledge.getLibraryDefinition("u_lib", v1.definitionId)).versions.length, 2);
});

test("another account's library is invisible: it is not listed, read, saved to, used or compared", options, async () => {
  const mine = await newStudy("u_a");
  await studies.savePopulation({ studyId: mine.id, userId: "u_a", name: "私有定义", kind: "real", definition: { rules: RULES_V1 } });
  const [population] = await studies.populations(mine.id, 10);
  const saved = await knowledge.saveFromStudy(mine, { populationId: population.id, text: "t" }, "u_a");
  const theirs = await newStudy("u_b");
  assert.deepEqual((await knowledge.listLibrary("u_b")).definitions, []);
  await assert.rejects(knowledge.getLibraryDefinition("u_b", saved.definitionId), { status: 404, code: "vcr_definition_not_found" });
  await assert.rejects(knowledge.useInStudy(theirs, { definitionId: saved.definitionId }, "u_b"), { status: 404, code: "vcr_definition_not_found" });
  await studies.savePopulation({ studyId: theirs.id, userId: "u_b", name: "x", kind: "real", definition: { rules: RULES_V2 } });
  const [theirPopulation] = await studies.populations(theirs.id, 10);
  await assert.rejects(knowledge.saveFromStudy(theirs, { populationId: theirPopulation.id, definitionId: saved.definitionId, text: "t" }, "u_b"), { status: 404, code: "vcr_definition_not_found" });
  assert.equal((await q("SELECT count(*)::int AS n FROM evimed_vcr.definition_versions WHERE definition_id = $1", [saved.definitionId]))[0].n, 1, "nothing was written to the other account's entry");
  // a run reads the library of its study's owner only
  assert.deepEqual((await knowledge.runtimeReadLibrary(theirs, {})).definitions, []);
  assert.equal((await knowledge.runtimeReadLibrary(mine, {})).definitions.length, 1);
});

test("a comparison of two versions is a result of its own: the study's own results never list it, the library's reader does", options, async () => {
  const study = await newStudy("u_cmp");
  const own = await studies.recordResult({ studyId: study.id, userId: "u_cmp", kind: "population", conclusion: "estimable", counts: { realPatients: 300 }, measures: [], diagnostics: {}, tables: [] });
  const comparison = await studies.recordResult({
    studyId: study.id, userId: "u_cmp", kind: VCR_COMPARISON_RESULT_KIND, subjectId: "defcmp:dfn_1:1:2:snp_1", conclusion: "estimable", counts: { realPatients: 417 }, measures: [],
    diagnostics: { comparison: { cohortSizeA: 417, cohortSizeB: 324, overlap: { both: 324, onlyA: 93, onlyB: 0 }, covariates: [{ covariate: "age", kind: "continuous", standardizedDifference: 0.32 }], standardizedDifferenceFloor: 0.1 } }, tables: [],
  });
  assert.deepEqual((await studies.results(study.id)).map((row) => row.id), [own.id], "the study's results do not list the comparison");
  assert.deepEqual((await studies.allResults(study.id)).map((row) => row.id), [own.id]);
  const shown = (await knowledge.studyKnowledge(study)).comparisons;
  assert.deepEqual(shown.map((row) => [row.definitionId, row.versionA, row.versionB, row.snapshotId, row.cohortSizeA, row.covariates[0].standardizedDifference]), [["dfn_1", 1, 2, "snp_1", 417, 0.32]]);
  // asking again for the same pair supersedes the earlier answer instead of piling up
  await studies.recordResult({ studyId: study.id, userId: "u_cmp", kind: VCR_COMPARISON_RESULT_KIND, subjectId: "defcmp:dfn_1:1:2:snp_1", conclusion: "estimable", counts: {}, measures: [],
    diagnostics: { comparison: { cohortSizeA: 1, cohortSizeB: 1, overlap: {}, covariates: [] } }, tables: [] });
  assert.equal((await knowledge.studyKnowledge(study)).comparisons.length, 1);
  assert.notEqual(comparison.id, (await knowledge.studyKnowledge(study)).comparisons[0].id);
});

test("the shipped registry is what the catalogue lists, with the pack's counts and sources", options, async () => {
  const ids = Object.keys(VCR_SHIPPED_PACKS);
  const catalogue = await new VcrKnowledge({ store, studyStore: studies }).listPacks("u_catalogue");
  assert.deepEqual(catalogue.packs.filter((pack) => pack.origin === "shipped").map((pack) => pack.id).sort(), [...ids].sort());
  for (const pack of catalogue.packs) assert.ok(pack.sources.length > 0 && pack.counts.criteria > 0, pack.id);
});
