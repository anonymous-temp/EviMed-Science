// The knowledge package of 「虚拟临研」, without a database: the packs a study works
// from (shipped, AI-drafted, promoted), the account's library of population
// definitions (saved, versioned, reused, counted) and the comparison of two
// versions, over stores that keep their rows in memory. `vcrKnowledge.integration.test.mjs`
// runs the same package over PostgreSQL and the real engine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { VCR_SHIPPED_PACKS, VCR_JOB_METHODS, validateScenario } from "@evimed/domain";

import { HttpError } from "../src/security.mjs";
import { Readable } from "node:stream";

import { VcrKnowledge, definitionBodyOf, presentComparison, presentPack } from "../src/vcrKnowledge.mjs";
import { VCR_WRITE_WHATS, VCR_READ_WHATS, VcrService } from "../src/vcrService.mjs";
import { createVcrGatewayHandler, vcrRuntimeWrite } from "../src/vcrGateway.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A tiny shipped registry of one curated pack, so these tests do not depend on what ships. */
const CURATED = Object.freeze({
  schema: "evimed.vcr.knowledge-pack/1", id: "demo_cancer", version: 3, status: "curated", updated: "2026-10-04",
  disease: { key: "demo_cancer", name: "Demo cancer", nameZh: "示例癌", aliases: ["DC"], aliasesZh: ["示例瘤"] },
  sources: [
    { id: "guide", title: "A guideline", url: "https://example.org/guide", accessed: "2026-10-04", licence: "link-only" },
    { id: "own", title: "EviMed authored dataset field-name hints", url: "https://www.evimed.com/", accessed: "2026-10-04", licence: "evimed-own" },
  ],
  terms: [{ id: "t_dx", kind: "disease", label: "Demo cancer", labelZh: "示例癌", concept: "demo_cancer", sources: ["guide"] }],
  phenotypes: [{ id: "p_dx", label: "Demo cancer", labelZh: "示例癌", type: "diagnosis", rule: { op: "present", variable: "demo_cancer" }, text: "Has it.", textZh: "患有。", terms: ["t_dx"], sources: ["guide"] }],
  endpoints: [{ id: "e_os", label: "OS", labelZh: "总生存期", type: "time_to_event", definition: "Time to death.", definitionZh: "至死亡的时间。", standard: { name: "Death from any cause" }, sources: ["guide"] }],
  criteria: [{ id: "c_ecog", kind: "inclusion", criterionType: "performance_status", requirement: { op: "compare", variable: "ecog", comparator: "lte", value: 1 }, text: "ECOG 0 or 1.", textZh: "ECOG 0 或 1。", sources: ["guide"] }],
  mappings: [
    { id: "m_age", concept: "age", label: "Age", labelZh: "年龄", type: "number", role: "covariate", unit: "years", fieldNames: ["AGE", "age_years"], sources: ["own"] },
    { id: "m_ecog", concept: "ecog", label: "ECOG", labelZh: "ECOG", type: "number", role: "covariate", fieldNames: ["ECOG", "ecog_ps"], sources: ["own"] },
    { id: "m_dx", concept: "demo_cancer", label: "Diagnosis", labelZh: "诊断", type: "flag", fieldNames: ["DX"], sources: ["own"] },
  ],
  background: [{ id: "b_1", text: "Background.", textZh: "背景。", sources: ["guide"] }],
});

/** The store's interface in memory, holding what the real one holds. */
function memoryStore() {
  const state = { packs: new Map(), bindings: new Map(), definitions: new Map(), versions: [], uses: [], results: [], seq: 0 };
  const id = (/** @type {string} */ prefix) => `${prefix}_${String(++state.seq).padStart(22, "0")}`;
  return {
    state,
    async savePack({ userId, studyId = null, diseaseKey, status, body }) {
      const version = [...state.packs.values()].filter((row) => row.userId === userId && row.diseaseKey === diseaseKey).length + 1;
      const row = { id: id("pkg"), userId, studyId, diseaseKey, version, status, body: { ...body, version, status }, reviewedBy: null, reviewedAt: null };
      state.packs.set(row.id, row);
      return row;
    },
    async getPack(userId, packId) { const row = state.packs.get(packId); return row && row.userId === userId ? row : null; },
    async listPacks(userId) {
      return [...state.packs.values()].filter((row) => row.userId === userId
        && (row.status === "curated" || [...state.bindings.values()].some((binding) => binding.origin === "stored" && binding.packId === row.id)));
    },
    async promotePack({ userId, id: packId, reviewer }) {
      const row = state.packs.get(packId);
      if (!row || row.userId !== userId || row.status !== "ai-draft") return null;
      Object.assign(row, { status: "curated", reviewedBy: reviewer, reviewedAt: "2026-10-04T00:00:00.000Z", body: { ...row.body, status: "curated" } });
      return row;
    },
    async studyBinding(studyId) { return state.bindings.get(studyId) ?? null; },
    async bindStudy({ studyId, userId, origin, packId, packVersion, actor }) {
      const binding = { studyId, userId, origin, packId, packVersion, boundBy: actor, boundAt: "2026-10-04T00:00:00.000Z" };
      state.bindings.set(studyId, binding);
      return binding;
    },
    async saveDefinitionVersion({ userId, definitionId = null, name = "", text, body, packRefs = [], studyId = null, populationId = null }) {
      let definition = definitionId ? state.definitions.get(definitionId) : null;
      if (definitionId && (!definition || definition.userId !== userId)) return null;
      if (!definition) { definition = { id: id("dfn"), userId, name }; state.definitions.set(definition.id, definition); }
      const version = state.versions.filter((row) => row.definitionId === definition.id).length + 1;
      const row = { id: id("dfv"), definitionId: definition.id, version, text, body, packRefs, sourceStudyId: studyId, createdBy: userId, createdAt: "2026-10-04T00:00:00.000Z" };
      state.versions.push(row);
      if (studyId) state.uses.push({ definitionId: definition.id, version, studyId, userId, populationId });
      return { definition: { id: definition.id, name: definition.name }, version: row };
    },
    async recordDefinitionUse({ userId, definitionId, version, studyId, populationId = null }) {
      const found = state.versions.find((row) => row.definitionId === definitionId && row.version === version && state.definitions.get(definitionId)?.userId === userId);
      if (!found) return null;
      if (!state.uses.some((use) => use.definitionId === definitionId && use.version === version && use.studyId === studyId)) state.uses.push({ definitionId, version, studyId, userId, populationId });
      return found;
    },
    async listDefinitions(userId) {
      return [...state.definitions.values()].filter((row) => row.userId === userId).map((row) => {
        const versions = state.versions.filter((version) => version.definitionId === row.id);
        return { id: row.id, name: row.name, versions: versions.length, uses: new Set(state.uses.filter((use) => use.definitionId === row.id).map((use) => use.studyId)).size,
          latest: versions.at(-1) ?? null, createdAt: null, updatedAt: null };
      });
    },
    async getDefinition(userId, definitionId) {
      const row = state.definitions.get(definitionId);
      if (!row || row.userId !== userId) return null;
      const uses = state.uses.filter((use) => use.definitionId === definitionId);
      return { id: row.id, name: row.name, createdAt: null, updatedAt: null, versions: state.versions.filter((v) => v.definitionId === definitionId).sort((a, b) => b.version - a.version),
        uses: uses.map((use) => ({ version: use.version, studyId: use.studyId, studyName: "", at: null })), studyCount: new Set(uses.map((use) => use.studyId)).size };
    },
    async definitionsUsedBy(studyId, userId) {
      return state.uses.filter((use) => use.studyId === studyId && use.userId === userId).map((use) => {
        const definition = state.definitions.get(use.definitionId);
        const version = state.versions.find((row) => row.definitionId === use.definitionId && row.version === use.version);
        return { definitionId: use.definitionId, version: use.version, populationId: use.populationId, name: definition?.name ?? "", text: version?.text ?? "", packRefs: version?.packRefs ?? [],
          versions: state.versions.filter((row) => row.definitionId === use.definitionId).length, uses: new Set(state.uses.filter((other) => other.definitionId === use.definitionId).map((other) => other.studyId)).size, usedAt: null };
      });
    },
    async comparisonResults(studyId) { return state.results.filter((row) => row.studyId === studyId); },
  };
}

/** The study store's population side. @param {any[]} populations */
function studyStoreOf(populations = []) {
  return {
    populations,
    async populations_(/** @type {string} */ _id) { return populations; },
    async savePopulation(/** @type {any} */ input) {
      const row = { id: `pop_${populations.length + 1}`, version: populations.length + 1, ...input };
      populations.push(row);
      return row;
    },
  };
}
const studyStoreWith = (/** @type {any[]} */ populations) => {
  const store = studyStoreOf(populations);
  return { ...store, populations: async () => populations };
};

const STUDY_A = { id: "std_a", userId: "u1", projectId: "prj_a" };
const STUDY_B = { id: "std_b", userId: "u1", projectId: "prj_b" };

const cmp = (/** @type {string} */ column, /** @type {string} */ comparator, /** @type {number} */ value) => ({ op: "compare", column, comparator, value });
const RULES_V1 = [{ name: "adult", rule: cmp("AGE", "gte", 18) }, { name: "fit", rule: cmp("ECOG", "lte", 1) }];
const RULES_V2 = [{ name: "adult", rule: cmp("AGE", "gte", 50) }, { name: "fit", rule: cmp("ECOG", "lte", 1) }];

/** A knowledge package over memory, one curated pack shipped. */
function compose({ populations = [], jobs = null, dataStore = null } = {}) {
  const store = memoryStore();
  const studyStore = studyStoreWith(populations);
  const knowledge = new VcrKnowledge({ store: /** @type {any} */ (store), studyStore, dataStore, jobs, shipped: { demo_cancer: CURATED }, now: () => new Date("2026-10-04T09:00:00Z") });
  return { knowledge, store, studyStore, populations };
}

const DRAFT = Object.freeze({
  disease: { key: "rare_thing", nameZh: "某罕见病", aliases: ["RT"] },
  sources: [{ id: "paper", title: "A review", url: "https://example.org/review", accessed: "2026-10-04", licence: "link-only" }],
  terms: [{ id: "t1", labelZh: "某罕见病", kind: "disease", sources: ["paper"] }],
  endpoints: [{ id: "e1", labelZh: "症状评分变化", type: "continuous", definitionZh: "治疗后评分相对基线的变化。", standard: { name: "the scale the review names" }, sources: ["paper"] }],
  criteria: [{ id: "c1", kind: "inclusion", criterionType: "demographic", requirement: { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "years" }, textZh: "年龄不小于 18 岁。", sources: ["paper"] }],
});

test("the catalogue lists the shipped packs and the account's own, and searches the names a pack lists", async () => {
  const { knowledge } = compose();
  await knowledge.draftPack(STUDY_A, structuredClone(DRAFT), "u1");
  const all = await knowledge.listPacks("u1");
  assert.deepEqual(all.packs.map((pack) => [pack.origin, pack.status, pack.diseaseKey]), [["shipped", "curated", "demo_cancer"], ["stored", "ai-draft", "rare_thing"]]);
  assert.equal((await knowledge.listPacks("u1", "示例")).packs.length, 1, "a Chinese alias finds the shipped pack");
  assert.equal((await knowledge.listPacks("u1", "rare")).packs[0].origin, "stored");
  assert.equal((await knowledge.listPacks("u1", "nothing like it")).packs.length, 0);
  assert.deepEqual((await knowledge.listPacks("u2")).packs.map((pack) => pack.origin), ["shipped"], "another account's draft is not in the catalogue");
  assert.equal(all.packs[0].counts.criteria, 1);
  assert.deepEqual(all.packs[0].sources.map((source) => [source.id, source.use]), [["guide", "link-only"], ["own", "own"]]);
});

test("a pack is read whole with every entry's sources resolved, by its shipped id or by the account's own row id", async () => {
  const { knowledge } = compose();
  const written = await knowledge.draftPack(STUDY_A, structuredClone(DRAFT), "u1");
  assert.equal(written.ok, true);
  const shipped = await knowledge.getPack("u1", "demo_cancer");
  assert.equal(shipped.origin, "shipped");
  assert.deepEqual(shipped.sections.criteria[0].sources, ["guide"], "an entry names its sources by id");
  assert.equal(shipped.sources.find((source) => source.id === "guide")?.licence, "link-only");
  assert.deepEqual(shipped.sections.endpoints[0].standard, { name: "Death from any cause" });
  const stored = await knowledge.getPack("u1", /** @type {any} */ (written).id);
  assert.equal(stored.status, "ai-draft");
  await assert.rejects(knowledge.getPack("u2", /** @type {any} */ (written).id), { status: 404, code: "vcr_pack_not_found" }, "another account's pack answers like one that does not exist");
  await assert.rejects(knowledge.getPack("u1", "no_such_pack"), { status: 404, code: "vcr_pack_not_found" });
  assert.equal(presentPack("shipped", CURATED).sections.terms.length, 1);
});

test("an AI draft is written at the floor, marked, and bound to the study; a curated binding refuses a draft by name", async () => {
  const { knowledge, store } = compose();
  const done = await knowledge.draftPack(STUDY_A, structuredClone(DRAFT), "run:r1");
  assert.equal(done.ok, true);
  const [row] = [...store.state.packs.values()];
  assert.deepEqual([row.status, row.body.status, row.body.id, row.body.updated, row.studyId, row.userId], ["ai-draft", "ai-draft", "rare_thing", "2026-10-04", "std_a", "u1"]);
  assert.deepEqual(store.state.bindings.get("std_a")?.origin, "stored");

  const refused = await knowledge.draftPack(STUDY_A, { ...structuredClone(DRAFT), sources: [{ ...DRAFT.sources[0], url: "https://trialsearch.who.int/Trial2.aspx?TrialID=X" }] }, "run:r1");
  assert.equal(refused.ok, false);
  assert.ok(/** @type {any} */ (refused).issues.some((/** @type {any} */ issue) => issue.code === "pack_source_restricted"));
  assert.equal(store.state.packs.size, 1, "a refused draft writes nothing");

  await knowledge.bindPack(STUDY_B, "demo_cancer", "u1");
  const blocked = await knowledge.draftPack(STUDY_B, structuredClone(DRAFT), "run:r2");
  assert.equal(blocked.ok, false);
  assert.equal(/** @type {any} */ (blocked).issues[0].code, "pack_curated_in_use");
});

test("the runtime's pack write binds a catalogue pack or drafts one, refuses what the platform sets, and says why an unknown id is refused", async () => {
  const { knowledge } = compose();
  assert.deepEqual((await knowledge.writePack(STUDY_A, { use: "demo_cancer" }, "run")).ok, true);
  assert.equal((await knowledge.writePack(STUDY_A, { use: "demo_cancer", terms: [] }, "run")).ok, false);
  const unknown = await knowledge.writePack(STUDY_A, { use: "nope" }, "run");
  assert.equal(/** @type {any} */ (unknown).issues[0].code, "pack_unknown");
  const set = await knowledge.writePack(STUDY_B, { ...structuredClone(DRAFT), status: "curated" }, "run");
  assert.equal(/** @type {any} */ (set).issues[0].field, "status", "a draft cannot name its own status");
  assert.equal((await knowledge.writePack(STUDY_B, structuredClone(DRAFT), "run")).ok, true);
});

test("a draft is promoted by a review: the same row becomes curated, once, and a curated pack is not promoted again", async () => {
  const { knowledge, store } = compose();
  await knowledge.draftPack(STUDY_A, structuredClone(DRAFT), "run");
  const promoted = await knowledge.promotePack(STUDY_A, "lead-1");
  assert.deepEqual([promoted.status, promoted.reviewedBy], ["curated", "lead-1"]);
  assert.equal([...store.state.packs.values()][0].status, "curated");
  await assert.rejects(knowledge.promotePack(STUDY_A, "lead-1"), { status: 409 });
  await assert.rejects(knowledge.promotePack(STUDY_B, "lead-1"), { status: 404, code: "vcr_pack_not_found" }, "a study with no draft has nothing to promote");
  await knowledge.bindPack(STUDY_B, "demo_cancer", "u1");
  await assert.rejects(knowledge.promotePack(STUDY_B, "lead-1"), { status: 404 }, "a shipped pack is not a draft");
  // the study page shows what stands behind the pack and who may promote
  const view = await knowledge.studyKnowledge(STUDY_A, { canPromote: true });
  assert.equal(view.pack?.status, "curated");
  assert.equal(view.pack?.canPromote, false, "nothing left to promote");
});

test("the study page's block carries the pack's status and sources, and the promote action only for a draft", async () => {
  const { knowledge } = compose();
  await knowledge.draftPack(STUDY_A, structuredClone(DRAFT), "run");
  const draft = await knowledge.studyKnowledge(STUDY_A, { canPromote: true });
  assert.deepEqual([draft.pack?.status, draft.pack?.canPromote, draft.pack?.sources.length, draft.pack?.counts.endpoints], ["ai-draft", true, 1, 1]);
  assert.equal((await knowledge.studyKnowledge(STUDY_A, { canPromote: false })).pack?.canPromote, false);
  assert.equal((await knowledge.studyKnowledge(STUDY_B)).pack, null);
});

test("the runtime reads the catalogue when nothing is bound, the bound pack whole or by section, and the dataset's field mapping", async () => {
  const sources = [{ id: "src_1", fieldMap: { columns: [{ table: "adsl.csv", column: "AGE", concept: "" }, { table: "adsl.csv", column: "DX_FLAG", concept: "demo_cancer" }, { table: "adsl.csv", column: "SMOKE", concept: "smoking" }] } }];
  const { knowledge } = compose({ dataStore: { listSourcesForStudy: async () => sources } });
  const none = await knowledge.runtimeReadPack(STUDY_A, {});
  assert.equal(none.bound, null);
  assert.deepEqual(none.packs.map((pack) => pack.id), ["demo_cancer"]);
  assert.ok(none.packs.every((pack) => !("sources" in pack)), "the catalogue is short");
  await knowledge.bindPack(STUDY_A, "demo_cancer", "run");
  const index = await knowledge.runtimeReadPack(STUDY_A, {});
  assert.deepEqual(Object.keys(index.sections), ["terms", "phenotypes", "endpoints", "criteria", "mappings", "background"]);
  assert.deepEqual(index.sections.criteria, [{ id: "c_ecog", name: "ECOG 0 或 1。", kind: "inclusion", criterionType: "performance_status" }], "the index names each entry and carries none of its text");
  assert.deepEqual(index.sections.mappings.map((entry) => entry.concept), ["age", "ecog", "demo_cancer"]);
  assert.equal(index.sources, undefined);
  assert.deepEqual(index.bound, { origin: "shipped", id: "demo_cancer", status: "curated", version: 3, name: "Demo cancer", nameZh: "示例癌", counts: { terms: 1, phenotypes: 1, endpoints: 1, criteria: 1, mappings: 3, background: 1 } });
  assert.deepEqual(index.mapping, {
    realised: [{ concept: "age", table: "adsl.csv", column: "AGE", by: "name" }, { concept: "demo_cancer", table: "adsl.csv", column: "DX_FLAG", by: "concept" }],
    missing: ["ecog"], unknown: ["smoking"],
  });
  const one = await knowledge.runtimeReadPack(STUDY_A, { kind: "endpoints" });
  assert.deepEqual(Object.keys(one.sections), ["endpoints"]);
  assert.deepEqual(one.sections.endpoints[0].standard, { name: "Death from any cause" });
  assert.deepEqual(one.sections.endpoints[0].sources, ["guide"], "an entry cites its sources by id");
  assert.deepEqual(one.sources.map((source) => [source.id, source.use, source.licence]), [["guide", "link-only", "link-only"]], "and the section carries only the sources it cites, once");
  await assert.rejects(knowledge.runtimeReadPack(STUDY_A, { kind: "prices" }), { status: 400, code: "vcr_read_filter_invalid" });
  const searched = await knowledge.runtimeReadPack(STUDY_A, { query: "示例" });
  assert.equal(searched.bound, null, "a search word asks for the catalogue even when a pack is bound");
});

test("the matching run is told which concept names the pack uses for the variables the criteria name, and which columns realise them", async () => {
  const { knowledge } = compose({ dataStore: { listSourcesForStudy: async () => [{ fieldMap: { columns: [{ table: "t.csv", column: "ecog_ps", concept: "" }] } }] } });
  await knowledge.bindPack(STUDY_A, "demo_cancer", "run");
  const bound = await knowledge.studyPack(STUDY_A);
  const guide = await knowledge.matchingGuide(STUDY_A, /** @type {any} */ (bound), [
    { requirement: { op: "compare", variable: "ecog", comparator: "lte", value: 1 } },
    { requirement: { op: "absent", variable: "pneumonitis", window: { months: 6 } }, applicability: { op: "compare", variable: "age", comparator: "gte", value: 18 } },
  ]);
  assert.deepEqual(guide.concepts.map((entry) => entry.concept).sort(), ["age", "ecog"]);
  assert.deepEqual(guide.outsidePack, ["pneumonitis"]);
  assert.deepEqual(guide.dataset?.realised, [{ concept: "ecog", table: "t.csv", column: "ecog_ps", by: "name" }]);
  assert.deepEqual(guide.dataset?.missing, ["age"]);
  assert.deepEqual(guide.pack, { origin: "shipped", id: "demo_cancer", status: "curated" });
});

test("a definition is saved from a study into the account's library, versioned, and counted by the studies that used it", async () => {
  const populations = [{ id: "pop_1", version: 1, kind: "real", name: "成人 ECOG 0-1", definition: { rules: RULES_V1, timeZero: { column: "DXDT" }, snapshotId: "snp_x" } }];
  const { knowledge, store } = compose({ populations });
  const first = await knowledge.saveFromStudy(STUDY_A, { populationId: "pop_1", text: "年龄不小于 18 岁、ECOG 0 或 1。" }, "u1");
  assert.deepEqual([first.version, first.name], [1, "成人 ECOG 0-1"]);
  const body = store.state.versions[0].body;
  assert.deepEqual(Object.keys(body).sort(), ["rules", "timeZero"], "only the cohort job's own keys are kept; a snapshot id is not part of a definition");
  const second = await knowledge.saveFromStudy(STUDY_A, { populationId: "pop_1", definitionId: first.definitionId, text: "年龄不小于 50 岁。" }, "u1");
  assert.equal(second.version, 2);
  // a second study uses version 1
  const used = await knowledge.useInStudy(STUDY_B, { definitionId: first.definitionId, version: 1 }, "u1");
  assert.equal(used.version, 1);
  // the same study reusing it again changes nothing
  await knowledge.useInStudy(STUDY_B, { definitionId: first.definitionId, version: 1 }, "u1");
  const library = await knowledge.listLibrary("u1");
  assert.deepEqual(library.definitions.map((entry) => [entry.name, entry.versions, entry.uses, entry.latest?.version]), [["成人 ECOG 0-1", 2, 2, 2]]);
  const detail = await knowledge.getLibraryDefinition("u1", first.definitionId);
  assert.equal(detail.uses, 2);
  assert.deepEqual(detail.versions.map((version) => version.version), [2, 1]);
  const page = await knowledge.studyKnowledge(STUDY_B);
  assert.deepEqual(page.definitions.map((entry) => [entry.name, entry.version, entry.versions, entry.uses]), [["成人 ECOG 0-1", 1, 2, 2]]);
  assert.equal(populations.length, 3, "each reuse defines a population in the study (a version of it); the use is counted once per study");
});

test("another account's library is not read, saved to, used or compared", async () => {
  const { knowledge } = compose({ populations: [{ id: "pop_1", version: 1, kind: "real", name: "x", definition: { rules: RULES_V1 } }] });
  const mine = await knowledge.saveFromStudy(STUDY_A, { populationId: "pop_1", name: "x", text: "t" }, "u1");
  const stranger = { id: "std_z", userId: "u2", projectId: "prj_z" };
  assert.deepEqual((await knowledge.listLibrary("u2")).definitions, []);
  await assert.rejects(knowledge.getLibraryDefinition("u2", mine.definitionId), { status: 404, code: "vcr_definition_not_found" });
  await assert.rejects(knowledge.useInStudy(stranger, { definitionId: mine.definitionId }, "u2"), { status: 404, code: "vcr_definition_not_found" });
  await assert.rejects(knowledge.saveFromStudy({ ...stranger }, { populationId: "pop_1", definitionId: mine.definitionId, text: "t" }, "u2"), HttpError, "the stranger's own study has no such population, and the definition is not theirs either");
  const runtime = await knowledge.runtimeReadLibrary(stranger, {});
  assert.deepEqual(runtime.definitions, [], "a run reads its study owner's library only");
});

test("a library entry needs what a person would need to recognise it: a real population with rules, a name and the plain-language text", async () => {
  const { knowledge } = compose({ populations: [
    { id: "pop_s", version: 1, kind: "scenario", name: "s", definition: { n: 10 } },
    { id: "pop_r", version: 2, kind: "real", name: "r", definition: { rules: RULES_V1 } },
    { id: "pop_bad", version: 3, kind: "real", name: "bad", definition: { rules: [{ name: "x", rule: { op: "compare", column: "A", comparator: "~", value: 1 } }] } },
  ] });
  await assert.rejects(knowledge.saveFromStudy(STUDY_A, { populationId: "pop_s", name: "s", text: "t" }, "u1"), { code: "vcr_definition_invalid" });
  await assert.rejects(knowledge.saveFromStudy(STUDY_A, { populationId: "pop_r", name: "", text: "t" }, "u1"), { code: "vcr_definition_invalid" });
  await assert.rejects(knowledge.saveFromStudy(STUDY_A, { populationId: "pop_r", name: "r", text: "  " }, "u1"), { code: "vcr_definition_invalid" });
  await assert.rejects(knowledge.saveFromStudy(STUDY_A, { populationId: "pop_bad", name: "bad", text: "t" }, "u1"), { code: "vcr_definition_invalid" });
  await assert.rejects(knowledge.saveFromStudy(STUDY_A, { populationId: "pop_none", name: "n", text: "t" }, "u1"), { code: "vcr_object_unknown" });
});

test("reusing a definition renames the dataset's columns only where the pack makes it unambiguous, and says every rename and every column left", async () => {
  const header = { listSnapshots: async () => [{ id: "snp_1" }], listAnalysisTables: async () => [{ shape: "subject", columns: ["USUBJID", "age_years", "ecog_ps", "SITE"] }, { shape: "events", columns: [] }] };
  const { knowledge, populations } = compose({
    populations: [{ id: "pop_1", version: 1, kind: "real", name: "成人", definition: { rules: [...RULES_V1, { name: "site", rule: cmp("HOSPITAL", "eq", 1) }], timeZero: { column: "AGE" } } }],
    dataStore: header,
  });
  await knowledge.bindPack(STUDY_B, "demo_cancer", "u1");
  const saved = await knowledge.saveFromStudy(STUDY_A, { populationId: "pop_1", name: "成人", text: "t" }, "u1");
  const used = await knowledge.useInStudy(STUDY_B, { definitionId: saved.definitionId, name: "本研究的人群" }, "u1");
  assert.deepEqual(used.renamed.map((entry) => [entry.from, entry.to, entry.by, entry.concept]), [["AGE", "age_years", "pack", "age"], ["ECOG", "ecog_ps", "pack", "ecog"]]);
  assert.deepEqual(used.unmatched, ["HOSPITAL"], "a column no mapping knows is left for a person, not guessed");
  const made = populations.at(-1);
  assert.deepEqual([made.kind, made.name, made.snapshotId, made.definition.timeZero], ["real", "本研究的人群", "snp_1", { column: "age_years" }]);
  assert.deepEqual(made.definition.rules.map((step) => step.rule.column), ["age_years", "ecog_ps", "HOSPITAL"]);
  // an explicit rename wins over the pack's suggestion
  const again = await knowledge.useInStudy(STUDY_B, { definitionId: saved.definitionId, columnMap: { HOSPITAL: "SITE" } }, "u1");
  assert.deepEqual(again.renamed.find((entry) => entry.from === "HOSPITAL"), { from: "HOSPITAL", to: "SITE", by: "caller" });
  assert.deepEqual(again.unmatched, []);
  // a rename that is not a column of the rules, or not a column name, is ignored
  const ignored = await knowledge.useInStudy(STUDY_B, { definitionId: saved.definitionId, columnMap: { NOT_READ: "X", HOSPITAL: "bad name!" } }, "u1");
  assert.deepEqual(ignored.unmatched, ["HOSPITAL"]);
});

test("the pack entries a definition rests on are the mappings its columns match, plus the entries a caller names that exist", async () => {
  const { knowledge, store } = compose({ populations: [{ id: "pop_1", version: 1, kind: "real", name: "成人", definition: { rules: RULES_V1 } }] });
  await knowledge.bindPack(STUDY_A, "demo_cancer", "u1");
  const saved = await knowledge.saveFromStudy(STUDY_A, { populationId: "pop_1", name: "成人", text: "t", packEntries: [{ section: "criteria", id: "c_ecog" }] }, "u1");
  assert.deepEqual(saved.packRefs.map((ref) => [ref.section, ref.id]), [["mappings", "m_age"], ["mappings", "m_ecog"], ["criteria", "c_ecog"]]);
  assert.deepEqual(store.state.versions[0].packRefs.map((ref) => ref.pack), ["demo_cancer", "demo_cancer", "demo_cancer"]);
  await assert.rejects(knowledge.saveFromStudy(STUDY_A, { populationId: "pop_1", name: "x", text: "t", packEntries: [{ section: "criteria", id: "c_nothing" }] }, "u1"), { code: "vcr_definition_invalid" });
});

test("comparing two versions queues the cohort job with the second as `compare`, on the study's dataset, kept apart from the study's results", async () => {
  /** @type {any[]} */
  const queued = [];
  const jobs = { enqueue: async (/** @type {any} */ input) => { queued.push(input); return { job: { id: "job_1" }, created: true }; } };
  const dataStore = { listSnapshots: async () => [{ id: "snp_9" }], listAnalysisTables: async () => [{ shape: "subject", columns: ["USUBJID", "AGE", "ECOG", "bad column", "SEX"] }] };
  const populations = [{ id: "pop_1", version: 1, kind: "real", name: "成人", definition: { rules: RULES_V1 } }];
  const { knowledge } = compose({ populations, jobs, dataStore });
  const v1 = await knowledge.saveFromStudy(STUDY_A, { populationId: "pop_1", name: "成人", text: "v1" }, "u1");
  populations[0] = { ...populations[0], definition: { rules: RULES_V2 } };
  const v2 = await knowledge.saveFromStudy(STUDY_A, { populationId: "pop_1", definitionId: v1.definitionId, text: "v2" }, "u1");
  const done = await knowledge.compareVersions(STUDY_A, { id: "u1" }, { definitionId: v1.definitionId, versionA: 1, versionB: 2 });
  assert.equal(done.created, true);
  const [job] = queued;
  assert.deepEqual([job.kind, job.studyId, job.userId, job.inputs], ["build_cohort", "std_a", "u1", [{ kind: "snapshot", id: "snp_9" }]]);
  assert.deepEqual(job.scenario.rules, RULES_V1);
  assert.deepEqual(job.scenario.compare, { rules: RULES_V2, covariates: ["AGE", "ECOG", "SEX"] }, "the subject table's columns, the identifier and a name the grammar cannot spell left out");
  assert.deepEqual([job.detail.resultKind, job.detail.subjectId], ["definition_comparison", `defcmp:${v1.definitionId}:1:2:snp_9`]);
  assert.equal(v2.version, 2);
  // the scenario is one the domain's own schema for the method accepts
  const issues = validateScenario(VCR_JOB_METHODS.build_cohort, job.scenario);
  assert.deepEqual(issues, [], JSON.stringify(issues));
  const typo = validateScenario(VCR_JOB_METHODS.build_cohort, { ...job.scenario, compare: { ...job.scenario.compare, covariates: [] } });
  assert.ok(typo.length > 0, "a comparison with no covariate to compare on is refused by the schema");
  // what it refuses to compare
  await assert.rejects(knowledge.compareVersions(STUDY_A, { id: "u1" }, { definitionId: v1.definitionId, versionA: 1, versionB: 1 }), { code: "vcr_definition_invalid" });
  await assert.rejects(knowledge.compareVersions(STUDY_A, { id: "u1" }, { definitionId: v1.definitionId, versionA: 1, versionB: 7 }), { status: 404 });
  await assert.rejects(knowledge.compareVersions(STUDY_A, { id: "u1" }, { definitionId: v1.definitionId, versionA: 1, versionB: 2, covariates: ["nope"] }), { code: "vcr_definition_invalid" });
  await assert.rejects(knowledge.compareVersions({ ...STUDY_A, userId: "u2" }, { id: "u2" }, { definitionId: v1.definitionId, versionA: 1, versionB: 2 }), { status: 404 });
  const noData = compose({ populations, jobs, dataStore: { listSnapshots: async () => [], listAnalysisTables: async () => [] } });
  const own = await noData.knowledge.saveFromStudy(STUDY_A, { populationId: "pop_1", name: "x", text: "t" }, "u1");
  await noData.knowledge.saveFromStudy(STUDY_A, { populationId: "pop_1", definitionId: own.definitionId, text: "t2" }, "u1");
  await assert.rejects(noData.knowledge.compareVersions(STUDY_A, { id: "u1" }, { definitionId: own.definitionId, versionA: 1, versionB: 2 }), { code: "vcr_definition_invalid" },
    "no dataset, no comparison");
  const noJobs = compose({ populations });
  await assert.rejects(noJobs.knowledge.compareVersions(STUDY_A, { id: "u1" }, { definitionId: "dfn_x", versionA: 1, versionB: 2 }), { status: 503 });
});

test("a finished comparison is presented as the engine reported it: sizes, overlap and each covariate's standardized difference", () => {
  const view = presentComparison({
    id: "res_1", subjectId: "defcmp:dfn_1:1:2:snp_9", version: 1, createdAt: "2026-10-04T10:00:00.000Z",
    diagnostics: { comparison: {
      cohortSizeA: 417, cohortSizeB: 324, overlap: { both: 324, onlyA: 93, onlyB: 0 }, waterfallA: [{ rule: "adult", kept: 500 }], waterfallB: [],
      covariates: [{ covariate: "age", kind: "continuous", meanA: 60, meanB: 64, standardizedDifference: 0.32 }, { covariate: "site", skipped: "not_numeric" }],
      standardizedDifferenceFloor: 0.1, binaryConvention: "difference of proportions",
    } },
  });
  assert.deepEqual([view?.definitionId, view?.versionA, view?.versionB, view?.snapshotId, view?.cohortSizeA, view?.overlap.onlyA, view?.floor], ["dfn_1", 1, 2, "snp_9", 417, 93, 0.1]);
  assert.equal(view?.covariates[0].standardizedDifference, 0.32);
  assert.equal(presentComparison({ id: "r", subjectId: "pop_1", version: 1, diagnostics: {}, createdAt: null }), null, "a result that is not a comparison is not shown as one");
  assert.deepEqual(definitionBodyOf({ rules: [1], exit: { column: "X" }, snapshotId: "snp", counts: { n: 3 } }), { rules: [1], exit: { column: "X" } });
});

test("the runtime writes a pack through the gateway, and a population may name a library definition instead of writing one", async () => {
  const populations = [{ id: "pop_1", version: 1, kind: "real", name: "成人", definition: { rules: RULES_V1 } }];
  const { knowledge } = compose({ populations });
  const saved = await knowledge.saveFromStudy(STUDY_A, { populationId: "pop_1", name: "成人", text: "t" }, "u1");
  /** @type {any} */
  const stores = { populations: async () => populations, one: async () => null, savePopulation: (/** @type {any} */ input) => studyStoreWith(populations).savePopulation(input) };
  const write = (/** @type {string} */ what, /** @type {any} */ rows) => vcrRuntimeWrite({
    store: stores, service: {}, orchestrator: null, study: STUDY_B, what, items: rows.items ?? null, data: rows.data ?? null, knowledge, caller: { runtimeRunId: "run_7" },
  });
  const bound = await write("pack", { data: { use: "demo_cancer" } });
  assert.deepEqual([bound.ok, bound.issues], [true, []]);
  const refused = await write("pack", { data: { ...structuredClone(DRAFT), terms: [{ id: "t1", labelZh: "x", codes: [{ system: "MedDRA", code: "1" }], sources: ["paper"] }] } });
  assert.equal(refused.ok, false);
  assert.ok(refused.issues.some((issue) => /pack_code_system_restricted/.test(issue.message) || issue.code === "vcr_write_value_invalid"));
  const smuggled = await write("pack", { data: { ...structuredClone(DRAFT), results: { n: 3 } } });
  assert.equal(smuggled.ok, false, "a number the run did not compute is refused by name");
  const reused = await write("population", { items: [{ fromLibrary: { definitionId: saved.definitionId, version: 1 }, name: "复用" }] });
  assert.equal(reused.ok, true, JSON.stringify(reused.issues));
  assert.deepEqual([reused.results?.[0].definitionId, reused.results?.[0].version], [saved.definitionId, 1]);
  const both = await write("population", { items: [{ fromLibrary: { definitionId: saved.definitionId }, definition: { rules: RULES_V1 } }] });
  assert.equal(both.ok, false);
  const wrongKind = await write("population", { items: [{ fromLibrary: { definitionId: saved.definitionId }, kind: "scenario" }] });
  assert.equal(wrongKind.ok, false);
  const missingKnowledge = await vcrRuntimeWrite({ store: stores, service: {}, orchestrator: null, study: STUDY_B, what: "pack", items: null, data: { use: "demo_cancer" } });
  assert.equal(missingKnowledge.ok, false, "a deployment without the package says so");
  assert.ok(VCR_WRITE_WHATS.includes("pack") && VCR_READ_WHATS.includes("pack") && VCR_READ_WHATS.includes("library"));
});

test("the skill's own draft example is a pack the platform accepts at the floor, and the shipped registry loads", async () => {
  const text = readFileSync(join(root, "capabilities/vcr-protocol/SKILL.md"), "utf8");
  const block = /```json vcr:pack_draft\n([\s\S]*?)```/.exec(text)?.[1];
  assert.ok(block, "the protocol skill shows a pack draft");
  const example = JSON.parse(block);
  assert.equal(example.what, "pack");
  const { knowledge, store } = compose();
  const done = await knowledge.writePack(STUDY_A, example.data, "run:skill");
  assert.equal(done.ok, true, JSON.stringify(/** @type {any} */ (done).issues));
  assert.equal([...store.state.packs.values()][0].status, "ai-draft");
  assert.ok(Object.keys(VCR_SHIPPED_PACKS).length >= 1, "the shipped packs load through their validator");
});

test("the capability reads a pack through the tool's own path: the gateway, the service's boundary and the knowledge package", async () => {
  const { knowledge } = compose({ populations: [{ id: "pop_1", version: 1, kind: "real", name: "成人", definition: { rules: RULES_V1 } }] });
  const study = { ...STUDY_A, name: "EV-301", dataTier: "T0", intendedUse: "exploratory", status: "active", steps: {}, budget: {}, outcomeSeal: {} };
  const service = new VcrService({ store: /** @type {any} */ ({}), config: { vcrEnabled: true, vcrAudience: "all" }, knowledge });
  const handler = createVcrGatewayHandler({ vcrEnabled: true, vcrAudience: "all", modelGatewayInternalUrl: "http://127.0.0.1:8788/internal/models/v1" },
    { assertActiveModelGatewayToken: () => ({ userId: "u1", projectId: "prj_a" }) },
    { vcr: /** @type {any} */ ({ service, store: { studyByControlProject: async () => study }, knowledge, jobs: null, orchestrator: null }) });
  /** @param {string} operation @param {any} body */
  const call = async (operation, body) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url: `/internal/vcr/v1/${operation}`, headers: { authorization: "Bearer t" } });
    /** @type {{ status: number, body: string }} */
    const res = { status: 0, body: "" };
    await handler(req, { writeHead(/** @type {number} */ status) { res.status = status; return this; }, end(/** @type {string} */ chunk = "") { res.body = String(chunk); } }, () => null);
    return { status: res.status, data: JSON.parse(res.body).data ?? JSON.parse(res.body) };
  };
  // no pack yet: the catalogue, short
  const catalogue = await call("read", { what: "pack", filter: { query: "示例" } });
  assert.equal(catalogue.status, 200);
  assert.deepEqual([catalogue.data.what, catalogue.data.bound, catalogue.data.packs.map((/** @type {any} */ pack) => pack.id)], ["pack", null, ["demo_cancer"]]);
  // a draft written through the tool is marked as one, and the study goes on with it
  const draft = await call("write", { what: "pack", data: structuredClone(DRAFT) });
  assert.equal(draft.data.ok, true, JSON.stringify(draft.data.issues));
  assert.equal((await knowledge.studyPack(study))?.pack.status, "ai-draft");
  assert.equal((await call("read", { what: "pack" })).data.bound.status, "ai-draft", "a read says so");
  // binding the catalogue's pack replaces it, and a curated binding is read whole by section
  const bound = await call("write", { what: "pack", data: { use: "demo_cancer" } });
  assert.deepEqual([bound.status, bound.data.ok, bound.data.issues], [200, true, []]);
  const criteria = await call("read", { what: "pack", filter: { kind: "criteria" } });
  assert.equal(criteria.status, 200);
  assert.deepEqual(criteria.data.sections.criteria.map((/** @type {any} */ entry) => [entry.id, entry.requirement.variable, entry.requirement.value]), [["c_ecog", "ecog", 1]]);
  assert.deepEqual(criteria.data.sources.map((/** @type {any} */ source) => source.id), ["guide"]);
  assert.equal(criteria.data.bound.status, "curated");
  // a section the pack does not have is the call being wrong, with the filter's own code
  const bad = await call("read", { what: "pack", filter: { kind: "prices" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, "vcr_read_filter_invalid");
  // the library read is the owner's, through the same boundary
  const library = await call("read", { what: "library" });
  assert.deepEqual([library.status, library.data.definitions, library.data.used], [200, [], []]);
});
