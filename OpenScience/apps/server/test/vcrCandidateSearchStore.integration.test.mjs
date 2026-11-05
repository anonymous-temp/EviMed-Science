// The receipt of a search for a patient's trials on the real table (G24): it belongs to its study, keeps the last twenty, is read back by page and by
// the judging job's selection, goes with the study, and never holds what the run said of the patient. PostgreSQL.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VCR_TABLES } from "../src/vcrPersistence.mjs";
import { CANDIDATE_SEARCHES_KEPT, VcrCandidateSearchStore, summaryStamp } from "../src/vcrCandidateSearchStore.mjs";
import { VcrClauseDefinitionStore } from "../src/vcrClauseDefinitions.mjs";
import { createVcrEvidencePipeline } from "../src/vcrEvidence.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "An isolated PostgreSQL is required" };
let database, isolated, studies, searches, definitions;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "vcrsearch");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  studies = new VcrStore({ database });
  searches = new VcrCandidateSearchStore({ database });
  definitions = new VcrClauseDefinitionStore({ database });
  await studies.ready();
});
after(async () => { await database?.close(); await isolated?.drop(); });

let sequence = 0;
const newStudy = () => studies.createStudy({ userId: "owner", projectId: `prj_s${++sequence}`, name: `Search ${sequence}`, question: "q", dataTier: "T0" });
const rows = (count, from = 1) => Array.from({ length: count }, (_, at) => ({ registry: "clinicaltrials.gov", registryId: `NCT${String(from + at).padStart(8, "0")}`, title: `T${from + at}`, rank: at + 1 }));
const entry = (items, extra = {}) => ({ subjectKey: "P-1", request: { condition: "lung cancer", terms: ["NSCLC"], summary: summaryStamp("a summary") }, registries: [{ registry: "ctis", state: "failed" }],
  rerank: { state: "ranked", applied: true }, found: items.length + 4, items, ...extra });

test("the table is declared and a receipt is the study's: kept with its list in order, read back by id, and by no other study", options, async () => {
  assert.ok(VCR_TABLES.includes("candidate_searches"));
  const study = await newStudy();
  const other = await newStudy();
  const id = await searches.save(study, entry(rows(5)));
  assert.match(id, /^cns_/);
  const receipt = await searches.get(study, id);
  assert.deepEqual([receipt.id, receipt.studyId, receipt.subjectKey, receipt.found, receipt.rerank.applied, receipt.registries[0].state], [id, study.id, "P-1", 9, true, "failed"]);
  assert.deepEqual(receipt.items.map((item) => item.registryId), rows(5).map((item) => item.registryId), "the order the search kept");
  assert.equal(await searches.get(other, id), null, "another study's receipt is not readable");
  assert.equal(await searches.get(study, "cns_nope"), null);
  assert.equal(JSON.stringify(receipt).includes("a summary"), false, "only a hash and a length of the summary are kept");
  assert.deepEqual(receipt.request.summary, { sha256: summaryStamp("a summary").sha256, chars: 9 });
});

test("the newest receipt of a study (or of one patient) is found without its list, and only twenty are kept", options, async () => {
  const study = await newStudy();
  await searches.save(study, entry(rows(2), { subjectKey: "P-1" }));
  const second = await searches.save(study, entry(rows(3), { subjectKey: "P-2" }));
  const latest = await searches.latest(study);
  assert.deepEqual([latest.id, latest.items, latest.found], [second, [], 7], "the line a page shows needs the state, not five hundred rows");
  assert.equal((await searches.latest(study, { subjectKey: "P-1" })).subjectKey, "P-1");
  assert.equal(await searches.latest(study, { subjectKey: "P-9" }), null);
  const ids = [];
  for (let at = 0; at < CANDIDATE_SEARCHES_KEPT + 3; at += 1) ids.push(await searches.save(study, entry(rows(1, at + 1))));
  const kept = await searches.rows("SELECT id FROM evimed_vcr.candidate_searches WHERE study_id=$1 ORDER BY created_at DESC, id DESC", [study.id]);
  assert.equal(kept.length, CANDIDATE_SEARCHES_KEPT);
  assert.equal(await searches.get(study, ids[0]), null, "the oldest were dropped");
  assert.ok(await searches.get(study, ids.at(-1)));
});

test("a judging selection takes the first N rows of a saved search in its order, with a frozen collection carried along, and an unknown search is nothing", options, async () => {
  const study = await newStudy();
  const id = await searches.save(study, entry([...rows(4), { registry: "chictr", registryId: "ChiCTR2400000001" }, { registry: "clinicaltrials.gov", registryId: "NCT00000002" }]));
  const all = await searches.resolveSelection(study, id);
  assert.deepEqual(all.registryIds, ["NCT00000001", "NCT00000002", "NCT00000003", "NCT00000004", "ChiCTR2400000001"], "a repeat is one id");
  assert.deepEqual([all.available, all.collection, all.collectionRevision], [6, null, null]);
  assert.deepEqual((await searches.resolveSelection(study, id, 2)).registryIds, ["NCT00000001", "NCT00000002"]);
  assert.equal(await searches.resolveSelection(study, "cns_nope", 2), null);
  const frozenId = await searches.save(study, entry(rows(3), { collection: { id: "snapshot-1", revision: "a".repeat(64) } }));
  const frozen = await searches.resolveSelection(study, frozenId, 2);
  assert.deepEqual([frozen.registryIds.length, frozen.collection, frozen.collectionRevision], [2, "snapshot-1", "a".repeat(64)]);
});

test("a study's deletion takes its receipts", options, async () => {
  const study = await newStudy();
  const id = await searches.save(study, entry(rows(2)));
  await searches.query("DELETE FROM evimed_vcr.studies WHERE id=$1", [study.id]);
  assert.equal(await searches.get(study, id), null);
  assert.equal(Number((await searches.one("SELECT count(*)::int AS n FROM evimed_vcr.candidate_searches WHERE study_id=$1", [study.id])).n), 0);
});

test("a trial's definition cards are one row a text, prompt version and model: the first words stay, a registry trial's are shared and a protocol's go with its study", options, async () => {
  assert.ok(VCR_TABLES.includes("clause_definitions"));
  const study = await newStudy();
  const key = { studyId: null, targetHash: "h".repeat(16), promptVersion: "defs-1", model: "deepseek-flash" };
  assert.equal(await definitions.get(key), null);
  const first = await definitions.save({ ...key, definitions: [{ number: 1, counts: "first", doesNotCount: "", source: "knowledge" }], usage: { calls: 1 } });
  const second = await definitions.save({ ...key, definitions: [{ number: 1, counts: "second", doesNotCount: "", source: "knowledge" }] });
  assert.deepEqual([first[0].counts, second[0].counts], ["first", "first"], "a second writer reads the first row");
  assert.equal(await definitions.get({ ...key, promptVersion: "defs-2" }), null);
  assert.equal(await definitions.get({ ...key, model: "other" }), null);
  const own = { ...key, studyId: study.id };
  assert.equal(await definitions.get(own), null, "a study's protocol does not read the shared row");
  await definitions.save({ ...own, definitions: [{ number: 1, counts: "mine", doesNotCount: "", source: "knowledge" }] });
  assert.equal((await definitions.get(own))[0].counts, "mine");
  await definitions.query("DELETE FROM evimed_vcr.studies WHERE id=$1", [study.id]);
  assert.equal(await definitions.get(own), null, "its cards went with the study");
  assert.equal((await definitions.get(key))[0].counts, "first", "the shared row stayed");
});

test("a search through the evidence pipeline writes its receipt to the real table, and a second page is read from it without a registry", options, async () => {
  const study = await newStudy();
  let asked = 0;
  const item = (id) => ({ registry: "clinicaltrials.gov", registryId: id, title: `Trial ${id}`, overallStatus: "RECRUITING", phases: ["PHASE2"], conditions: ["Lung cancer"], interventions: ["Drug"],
    url: `https://example.org/${id}`, sex: "ALL", minimumAge: "18 Years", maximumAge: "N/A", secondaryIds: [] });
  const registry = { async search() { asked += 1; return { status: "ok", total: 45, retrievedAt: "2026-11-04T08:00:00.000Z", items: Array.from({ length: 45 }, (_, at) => item(`NCT${String(at + 1).padStart(8, "0")}`)) }; },
    async searchCtis() { return { status: "registry_unavailable", reason: "registry_not_configured", items: [] }; }, async searchChictr() { return { status: "registry_unavailable", reason: "registry_not_configured", items: [] }; } };
  const pipeline = createVcrEvidencePipeline({ store: {}, registry, searches, now: () => new Date("2026-11-04T08:00:00.000Z") });
  const first = await pipeline.candidatesFor({ id: study.id, userId: "owner" }, { condition: "lung cancer", subjectKey: "P-1" }, 20);
  assert.match(first.searchId, /^cns_/);
  assert.deepEqual([first.retrieved, first.returned, first.nextOffset], [45, 20, 20]);
  const receipt = await searches.get(study, first.searchId);
  assert.deepEqual([receipt.items.length, receipt.subjectKey, receipt.registries.map((entry) => entry.registry), receipt.rerank.state], [45, "P-1", ["clinicaltrials.gov", "ctis", "chictr"], "unconfigured"]);
  assert.equal((await searches.latest(study, { subjectKey: "P-1" })).id, first.searchId);
  const before = asked;
  const third = await pipeline.candidatesFor({ id: study.id, userId: "owner" }, { searchId: first.searchId, offset: 40, limit: 20 }, 20);
  assert.deepEqual([third.returned, third.more, third.candidates[0].registryId, asked], [5, false, "NCT00000041", before]);
  assert.deepEqual((await searches.resolveSelection(study, first.searchId, 3)).registryIds, ["NCT00000001", "NCT00000002", "NCT00000003"]);
});

test("a search made without a person, judged for one, becomes theirs; one that already has a person keeps it, and a withdrawn person takes nothing", options, async () => {
  const study = await newStudy();
  const open = await searches.save(study, entry(rows(2), { subjectKey: null }));
  const owned = await searches.save(study, entry(rows(2), { subjectKey: "P-1" }));
  await searches.stampSubject(study, open, "P-7");
  await searches.stampSubject(study, owned, "P-7");
  assert.equal((await searches.get(study, open)).subjectKey, "P-7");
  assert.equal((await searches.get(study, owned)).subjectKey, "P-1");
  const lone = await searches.save(study, entry(rows(1), { subjectKey: null }));
  await searches.query("INSERT INTO evimed_vcr.subject_withdrawals (study_id, subject_key) VALUES ($1, 'P-8')", [study.id]);
  await searches.stampSubject(study, lone, "P-8");
  assert.equal((await searches.get(study, lone)).subjectKey, null);
});
