// The registry watch (G15) on a real table: a trial whose record changed has its finished verdicts marked and kept, one that did not has nothing marked, a frozen collection and
// a withdrawn person are left alone, a tick reads a bounded number the least recently checked first, a registry that is down costs its own entries and nobody else's, and a read of
// a person's trials shows the mark. The registry is a double. PostgreSQL.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VCR_TABLES } from "../src/vcrPersistence.mjs";
import { createMatchJudgmentReads } from "../src/vcrMatchJudge.mjs";
import { VcrMatchJudgmentStore } from "../src/vcrMatchJudgmentStore.mjs";
import { VcrRegistryPageStore, createRegistryPages } from "../src/vcrRegistryPages.mjs";
import { createRegistryWatch, createRegistryWatchCounters } from "../src/vcrRegistryWatch.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "An isolated PostgreSQL is required" };
let database, isolated, studies, judgments;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "regwatch");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  studies = new VcrStore({ database });
  await studies.ready();
  judgments = new VcrMatchJudgmentStore({ database });
});
after(async () => { await database?.close(); await isolated?.drop(); });

let sequence = 0;
const newStudy = (userId = "owner") => studies.createStudy({ userId, projectId: `prj_w${++sequence}`, name: `Watch ${sequence}`, question: "q", dataTier: "T0" });
/** Every test starts from an empty ledger: the watch reads across studies. */
const clean = () => studies.query("DELETE FROM evimed_vcr.match_target_checks; DELETE FROM evimed_vcr.match_judgments");
const T0 = new Date("2026-11-04T10:00:00Z");

/** A finished row of one person and trial, made of the record whose hash is `targetHash`. */
const row = (studyId, { subjectKey = "P-1", targetId = "NCT00000001", targetHash = "h1", mode = "fit", registry = "clinicaltrials.gov", collection = null, fit = 70, extra = {} } = {}) => ({
  studyId, userId: "owner", subjectKey, targetKind: "candidate_trial", targetId, targetHash, documentHash: "d1", mode, promptVersion: `${mode}-1`, model: "deepseek-flash", thinking: "high", producer: "job",
  status: "done", fit, confidence: 0.5, verdict: "possible", answer: { target: { kind: "candidate_trial", id: targetId, registry, registryId: targetId, ...(collection ? { collection } : {}) }, reasons: { eligible: ["x"] } },
  usage: {}, documentIds: ["doc_1"], ...extra,
});

/** The registry as a double: what each trial reads as now, or the code it fails with. */
function world(entries) {
  const reads = [];
  return {
    entries, reads,
    targets: { async trial({ registry, registryId, userId, signal }) {
      reads.push(registryId);
      assert.ok(signal instanceof AbortSignal && userId, "a read carries its deadline and the study owner");
      const entry = entries[registryId];
      if (entry?.error) throw Object.assign(new Error(entry.error), { code: entry.error });
      if (!entry) throw Object.assign(new Error("unknown"), { code: "registry_not_found" });
      return { hash: entry.hash, registry };
    } },
  };
}
const watching = (registry, { clock = T0, config = {}, reports = [] } = {}) => {
  let at = clock;
  const counters = createRegistryWatchCounters();
  const watch = createRegistryWatch({ judgments, targets: registry.targets, config: { vcrRegistryWatchBatch: 20, vcrRegistryWatchHours: 168, vcrRegistryWatchRetryHours: 6, vcrRegistryWatchReadTimeoutMs: 5_000, ...config },
    report: (code) => reports.push(code), counters, now: () => at });
  return { watch, counters, reports, advance: (ms) => { at = new Date(at.getTime() + ms); }, set: (date) => { at = date; } };
};
const rowsOf = (studyId, targetId) => judgments.list({ studyId, targetKind: "candidate_trial", targetId });
const check = async (studyId, targetId) => studies.one("SELECT * FROM evimed_vcr.match_target_checks WHERE study_id=$1 AND target_id=$2", [studyId, targetId]);

test("both tables are declared, and a study takes its checks and its verdicts with it", options, async () => {
  assert.ok(VCR_TABLES.includes("match_target_checks") && VCR_TABLES.includes("registry_pages"));
  await clean();
  const study = await newStudy();
  await judgments.save(row(study.id));
  await judgments.recordCheck({ studyId: study.id, targetId: "NCT00000001", hash: "h1", status: "ok", at: T0.toISOString() });
  assert.equal((await check(study.id, "NCT00000001")).last_hash, "h1");
  await studies.query("DELETE FROM evimed_vcr.studies WHERE id=$1", [study.id]);
  assert.equal(await check(study.id, "NCT00000001"), null);
  assert.equal((await studies.rows("SELECT 1 FROM evimed_vcr.match_judgments WHERE study_id=$1", [study.id])).length, 0);
});

test("a trial whose record changed has every older verdict marked and kept; a trial that did not has nothing marked; a second tick has nothing due", options, async () => {
  await clean();
  const study = await newStudy();
  for (const subjectKey of ["P-1", "P-2"]) {
    await judgments.save(row(study.id, { subjectKey }));
    await judgments.save(row(study.id, { subjectKey, mode: "criteria", fit: null }));
  }
  await judgments.save(row(study.id, { subjectKey: "P-3", targetHash: "h2" }));
  await judgments.save(row(study.id, { subjectKey: "P-1", targetId: "NCT00000002" }));
  const registry = world({ NCT00000001: { hash: "h2" }, NCT00000002: { hash: "h1" } });
  const { watch, counters } = watching(registry);
  const done = await watch.tick();
  assert.deepEqual(done, { due: 2, checked: 2, changed: 1, marked: 4, failed: 0, deferred: 0 });
  const changed = await rowsOf(study.id, "NCT00000001");
  assert.equal(changed.length, 5, "nothing was deleted");
  const marked = changed.filter((entry) => entry.basisChanged);
  assert.deepEqual(marked.map((entry) => entry.subjectKey).sort(), ["P-1", "P-1", "P-2", "P-2"]);
  for (const entry of marked) {
    assert.equal(entry.basisChanged.kind, "registry_record");
    assert.equal(entry.basisChanged.label, "登记记录已更新，结论来自旧版本");
    assert.equal(entry.basisChanged.newHash, "h2");
    assert.equal(entry.basisChanged.at, T0.toISOString());
    assert.equal(entry.status, "done");
    assert.ok(entry.targetHash === "h1", "the verdict is still the one made of the old record");
  }
  assert.equal(changed.find((entry) => entry.subjectKey === "P-3").basisChanged, null, "a verdict already made of the new record is not marked");
  assert.equal((await rowsOf(study.id, "NCT00000002"))[0].basisChanged, null, "an unchanged record marks nothing");
  assert.deepEqual([(await check(study.id, "NCT00000001")).last_hash, (await check(study.id, "NCT00000001")).last_status], ["h2", "ok"]);
  assert.equal((await check(study.id, "NCT00000002")).last_hash, "h1");
  assert.deepEqual([counters.checked, counters.changed, counters.marked], [2, 1, 4]);
  // The period has not passed: nothing is due, nothing is read.
  registry.reads.length = 0;
  assert.equal((await watch.tick()).due, 0);
  assert.deepEqual(registry.reads, []);
});

test("the mark never writes over a cause another writer left; its own mark follows the record, and goes when the record goes back", options, async () => {
  await clean();
  const study = await newStudy();
  await judgments.save(row(study.id, { subjectKey: "P-1" }));
  await judgments.save(row(study.id, { subjectKey: "P-2" }));
  await studies.query("UPDATE evimed_vcr.match_judgments SET basis_changed='document' WHERE study_id=$1 AND subject_key='P-1'", [study.id]);
  const registry = world({ NCT00000001: { hash: "h2" } });
  const { watch, advance } = watching(registry);
  await watch.tick();
  const [first, second] = await Promise.all(["P-1", "P-2"].map(async (subjectKey) => (await judgments.list({ studyId: study.id, subjectKey }))[0]));
  assert.equal(first.basisChanged, "document", "a cause the erasure store wrote stands");
  assert.equal(second.basisChanged.newHash, "h2");
  // The record changes again: the watch's own mark is brought up to date, the other cause still stands.
  registry.entries.NCT00000001.hash = "h3";
  advance(169 * 3_600_000);
  await watch.tick();
  assert.equal((await judgments.list({ studyId: study.id, subjectKey: "P-1" }))[0].basisChanged, "document");
  assert.equal((await judgments.list({ studyId: study.id, subjectKey: "P-2" }))[0].basisChanged.newHash, "h3");
  // The record goes back to the one the verdict was made of: the mark is withdrawn.
  registry.entries.NCT00000001.hash = "h1";
  advance(169 * 3_600_000);
  await watch.tick();
  assert.equal((await judgments.list({ studyId: study.id, subjectKey: "P-2" }))[0].basisChanged, null);
  assert.equal((await judgments.list({ studyId: study.id, subjectKey: "P-1" }))[0].basisChanged, "document");
});

test("a frozen collection's trial is never read, and a person who withdrew keeps rows no mark reaches", options, async () => {
  await clean();
  const study = await newStudy();
  await judgments.save(row(study.id, { targetId: "NCT00000010", collection: { id: "c1", revision: "r1" } }));
  await judgments.save(row(study.id, { subjectKey: "P-9", targetId: "NCT00000011" }));
  await judgments.save(row(study.id, { subjectKey: "P-1", targetId: "NCT00000012" }));
  await judgments.save(row(study.id, { subjectKey: "P-9", targetId: "NCT00000012" }));
  await studies.query("INSERT INTO evimed_vcr.subject_withdrawals (study_id, subject_key, withdrawn_by, detail) VALUES ($1,'P-9','owner','{}'::jsonb)", [study.id]);
  const registry = world({ NCT00000010: { hash: "h2" }, NCT00000011: { hash: "h2" }, NCT00000012: { hash: "h2" } });
  const { watch } = watching(registry);
  const done = await watch.tick();
  assert.deepEqual(registry.reads, ["NCT00000012"], "the frozen trial and the withdrawn person's only trial were not read");
  assert.equal(done.due, 1);
  const raw = await studies.rows("SELECT subject_key, target_id, basis_changed FROM evimed_vcr.match_judgments WHERE study_id=$1 ORDER BY target_id, subject_key", [study.id]);
  assert.deepEqual(raw.map((entry) => [entry.target_id, entry.subject_key, entry.basis_changed === null]), [
    ["NCT00000010", "P-1", true], ["NCT00000011", "P-9", true], ["NCT00000012", "P-1", false], ["NCT00000012", "P-9", true]]);
  // A deleted study is not watched at all.
  await studies.query("UPDATE evimed_vcr.studies SET deleted_at=now() WHERE id=$1", [study.id]);
  await clean();
  const other = await newStudy();
  await judgments.save(row(other.id));
  await studies.query("UPDATE evimed_vcr.studies SET deleted_at=now() WHERE id=$1", [other.id]);
  registry.reads.length = 0;
  assert.equal((await watch.tick()).due, 0);
});

test("a tick reads only its batch, never-checked trials first and then the least recently checked, and a trial checked inside the period waits", options, async () => {
  await clean();
  const study = await newStudy();
  const ids = ["NCT00000021", "NCT00000022", "NCT00000023", "NCT00000024", "NCT00000025"];
  for (const targetId of ids) await judgments.save(row(study.id, { targetId }));
  const day = 24 * 3_600_000;
  await judgments.recordCheck({ studyId: study.id, targetId: "NCT00000023", hash: "h1", status: "ok", at: new Date(T0.getTime() - 10 * day).toISOString() });
  await judgments.recordCheck({ studyId: study.id, targetId: "NCT00000024", hash: "h1", status: "ok", at: new Date(T0.getTime() - 20 * day).toISOString() });
  await judgments.recordCheck({ studyId: study.id, targetId: "NCT00000025", hash: "h1", status: "ok", at: new Date(T0.getTime() - 1 * day).toISOString() });
  const registry = world(Object.fromEntries(ids.map((targetId) => [targetId, { hash: "h1" }])));
  const { watch } = watching(registry, { config: { vcrRegistryWatchBatch: 2 } });
  assert.equal((await watch.tick()).due, 2);
  assert.deepEqual(registry.reads, ["NCT00000021", "NCT00000022"], "never checked comes first");
  registry.reads.length = 0;
  await watch.tick();
  assert.deepEqual(registry.reads, ["NCT00000024", "NCT00000023"], "then the one checked longest ago");
  registry.reads.length = 0;
  const last = await watch.tick();
  assert.deepEqual([last.due, registry.reads], [0, []], "the one checked yesterday is not due for a week");
});

test("a registry that does not answer costs its own entries: two failures leave the rest of it for later, the others are read, and the failed come back after the retry window", options, async () => {
  await clean();
  const study = await newStudy();
  const down = ["NCTD0000001", "NCTD0000002", "NCTD0000003", "NCTD0000004"];
  const up = ["NCT00000031", "NCT00000032", "NCT00000033"];
  for (const targetId of down) await judgments.save(row(study.id, { targetId, registry: "ctis" }));
  for (const targetId of up) await judgments.save(row(study.id, { targetId }));
  await judgments.save(row(study.id, { targetId: "NCT00000099" }));
  const registry = world({ ...Object.fromEntries(down.map((targetId) => [targetId, { error: "registry_unavailable" }])), ...Object.fromEntries(up.map((targetId) => [targetId, { hash: "h2" }])) });
  const reports = [];
  const { watch, counters, advance } = watching(registry, { reports });
  const first = await watch.tick();
  assert.deepEqual(first, { due: 8, checked: 3 + 1, changed: 3, marked: 3, failed: 2, deferred: 2 });
  assert.equal(counters.missing, 1, "a trial the registry no longer has is an answer, not an outage");
  assert.deepEqual(reports, ["registry_watch_registry_unavailable"], "one line for a registry that is down, not one per trial");
  for (const targetId of up) assert.equal((await rowsOf(study.id, targetId))[0].basisChanged.newHash, "h2");
  assert.equal((await rowsOf(study.id, "NCT00000099"))[0].basisChanged, null, "its verdict stands");
  const failed = (await studies.rows("SELECT target_id, last_status FROM evimed_vcr.match_target_checks WHERE study_id=$1 AND last_status<>'ok' ORDER BY target_id", [study.id])).map((entry) => [entry.target_id, entry.last_status]);
  assert.deepEqual(failed, [["NCT00000099", "registry_not_found"], ["NCTD0000001", "registry_unavailable"], ["NCTD0000002", "registry_unavailable"]]);
  // An hour on the failed ones are inside their retry window: the deferred ones get the next turn, and nothing else is read.
  registry.reads.length = 0;
  advance(3_600_000);
  const second = await watch.tick();
  assert.deepEqual(registry.reads, ["NCTD0000003", "NCTD0000004"]);
  assert.deepEqual([second.due, second.failed, second.deferred], [2, 2, 0]);
  // Six hours on the registry is back: the failed come due again and are checked.
  for (const targetId of down) registry.entries[targetId] = { hash: "h2" };
  registry.reads.length = 0;
  advance(6 * 3_600_000 + 60_000);
  const third = await watch.tick();
  assert.equal(third.checked, 4);
  assert.deepEqual([...registry.reads].sort(), down);
  assert.equal((await rowsOf(study.id, "NCTD0000001"))[0].basisChanged.newHash, "h2");
});

test("one trial held by two studies is read once in a tick and marked in both", options, async () => {
  await clean();
  const [one, two] = [await newStudy(), await newStudy("someone")];
  await judgments.save(row(one.id));
  await judgments.save(row(two.id, { extra: { userId: "someone" } }));
  const registry = world({ NCT00000001: { hash: "h2" } });
  const { watch } = watching(registry);
  const done = await watch.tick();
  assert.deepEqual([done.due, done.changed, done.marked, registry.reads.length], [2, 2, 2, 1]);
});

// ---- the read: the mark shown

/** A read of a study's judgments. */
function reader() {
  return { reads: createMatchJudgmentReads({ judgments, documents: {}, targets: {}, matchStore: {} }) };
}

async function marked() {
  await clean();
  const study = await newStudy();
  await judgments.save(row(study.id, { targetId: "NCT00000001" }));
  await judgments.save(row(study.id, { targetId: "NCT00000002" }));
  const registry = world({ NCT00000001: { hash: "h2" }, NCT00000002: { hash: "h1" } });
  await watching(registry).watch.tick();
  return study;
}

test("a read shows the mark beside the old verdict", options, async () => {
  const study = await marked();
  const { reads } = reader();
  const answer = await reads.forSubject(study, "P-1");
  assert.equal(answer.ranking.length, 2, "the old verdicts are still shown");
  const stale = answer.ranking.find((entry) => entry.target.id === "NCT00000001");
  const fresh = answer.ranking.find((entry) => entry.target.id === "NCT00000002");
  assert.equal(stale.restsOnOlder, "登记记录已更新，结论来自旧版本");
  assert.equal(stale.verdictLabel.length > 0, true);
  assert.equal(fresh.restsOnOlder, undefined);
});

test("a ChiCTR page read is kept across processes: a second job finds the words in the table and makes no request", options, async () => {
  const store = new VcrRegistryPageStore({ database });
  const text = "| 纳入标准： | （1） 成年人。 |\n| 排除标准： | （1） 妊娠。 |\n";
  const reader = { calls: 0, async read() { this.calls += 1; return { text }; } };
  const clock = new Date("2026-11-04T10:00:00Z");
  const make = () => createRegistryPages({ store, webReader: reader, config: { vcrRegistryPageDays: 7, vcrRegistryPageFailureHours: 6, vcrRegistryPageTimeoutMs: 5_000 }, now: () => clock });
  const input = { registry: "chictr", registryId: "ChiCTR2000000001", url: "https://www.chictr.org.cn/showproj.html?proj=1" };
  const first = await make().eligibilityFor(input);
  const second = await make().eligibilityFor(input);
  assert.equal(reader.calls, 1);
  assert.deepEqual(second, first);
  const held = await store.get({ registry: "chictr", registryId: "ChiCTR2000000001" });
  assert.deepEqual([held.status, held.source, held.eligibility.startsWith("Inclusion Criteria:")], ["ok", "web_read", true]);
  // A failure for another record is a row with its reason and time, and is remembered.
  const broken = { calls: 0, async read() { this.calls += 1; throw Object.assign(new Error("x"), { code: "web_read_needs_browser" }); } };
  const failing = createRegistryPages({ store, webReader: broken, config: { vcrRegistryPageFailureHours: 6, vcrRegistryPageTimeoutMs: 5_000 }, now: () => clock });
  const other = { ...input, registryId: "ChiCTR2000000002", url: "https://www.chictr.org.cn/showproj.html?proj=2" };
  assert.equal(await failing.eligibilityFor(other), null);
  assert.equal(await createRegistryPages({ store, webReader: broken, config: { vcrRegistryPageFailureHours: 6 }, now: () => clock }).eligibilityFor(other), null);
  assert.equal(broken.calls, 1);
  const failedRow = await store.get({ registry: "chictr", registryId: "ChiCTR2000000002" });
  assert.deepEqual([failedRow.status, failedRow.reason, failedRow.eligibility], ["failed", "web_read_needs_browser", ""]);
});
