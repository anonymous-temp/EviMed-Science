// The source-change record's rules that need no database (plan 2026-10-05 B5): what a card's Europe PMC reading and a
// frontier notice become, what each reader does with a record it is handed, and what a store with nothing to stand on says.
// `sourceChanges.integration.test.mjs` and `sourceChangeReaders.integration.test.mjs` hold the same behaviour against
// PostgreSQL.
import assert from "node:assert/strict";
import test from "node:test";
import { SOURCE_CHANGE_ASSERTERS, foldSourceChanges, sourceChangeFact } from "@evimed/domain";
import { evidencePublicationStatus } from "../src/evidenceCardContent.mjs";
import { KnowledgeChangeService } from "../src/knowledgeChange.mjs";
import { ResultImpactService } from "../src/resultImpact.mjs";
import { createSourceChanges, recordFrontierNotices, recordFromPublicationStatus, sourceChangeMetricFamilies, sourceIdentifiersOf } from "../src/sourceChanges.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const DOI = "10.9999/unit.work";
const AT = "2026-10-05T00:00:00.000Z";

/** @param {Record<string, any>[]} entries @param {string} [identifier] */
const factOf = (entries, identifier = `doi:${DOI}`) => sourceChangeFact(identifier, foldSourceChanges(null, /** @type {any} */ (entries), { identifier, at: AT }).record);
const retraction = { assertedBy: "crossref", kind: "retraction", noticeIdentifier: "10.9999/notice", date: "2026-10-01" };

test("a card source's publication status is recorded as the changes its notices are, and a clear or missing one is not a change", () => {
  const status = evidencePublicationStatus({ kind: "retracted", notices: ["Retraction in · Doe J. · MED:111", "Published Erratum · Doe J. · MED:222", "Europe PMC: isRetracted=Y"] });
  const { identifier, entries } = recordFromPublicationStatus("https://doi.org/10.9999/Unit.Work", status);
  assert.equal(identifier, `doi:${DOI}`);
  assert.deepEqual(entries.map(entry => [entry.assertedBy, entry.kind, entry.noticeIdentifier]).sort(),
    [["europepmc", "correction", "pmid:222"], ["europepmc", "retraction", "pmid:111"], ["europepmc", "retraction", null]].sort());
  assert.deepEqual(recordFromPublicationStatus(DOI, evidencePublicationStatus({ kind: "concern", notices: [] })).entries.map(entry => entry.kind), ["concern"]);
  assert.deepEqual(recordFromPublicationStatus(DOI, null).entries, [], "verified clear is not a change");
  assert.deepEqual(recordFromPublicationStatus(DOI, undefined).entries, [], "no status is not a change");
  assert.equal(recordFromPublicationStatus("not an identifier", status).identifier, null);
});

test("a source names its identifiers by every field and link the code already reads", () => {
  assert.deepEqual(sourceIdentifiersOf({ url: "https://doi.org/10.1056/NEJMoa2307563" }), ["doi:10.1056/nejmoa2307563"]);
  assert.deepEqual(sourceIdentifiersOf({ url: "https://pubmed.ncbi.nlm.nih.gov/37952131/", doi: "10.1056/NEJMoa2307563", pmid: 37952131 }), ["pmid:37952131", "doi:10.1056/nejmoa2307563"]);
  assert.deepEqual(sourceIdentifiersOf({ url: "https://clinicaltrials.gov/study/NCT03574597" }), ["reg:NCT03574597"]);
  assert.deepEqual(sourceIdentifiersOf({ url: "https://example.org/page", title: "10.1056/not-read-from-a-title" }), []);
  assert.deepEqual(sourceIdentifiersOf(null), []);
});

test("frontier notices become source changes of the work they name; a failing store is counted and never thrown", async () => {
  /** @type {any[]} */
  const calls = [];
  const store = /** @type {any} */ ({ async recordMany(identifier, entries) { calls.push([identifier, entries]); }, failed() { throw new Error("not expected"); } });
  await recordFrontierNotices(store, [
    { kind: "correction", noticeDoi: "10.9999/erratum", doi: DOI, date: "2026-09-30" },
    { kind: "expression-of-concern", noticeDoi: "10.9999/eoc", doi: DOI },
    { kind: "preprint-of", noticeDoi: null, doi: DOI },
  ]);
  assert.deepEqual(calls.map(([identifier, entries]) => [identifier, entries[0].kind, entries[0].noticeIdentifier, entries[0].date, entries[0].assertedBy]), [
    [`doi:${DOI}`, "correction", "10.9999/erratum", "2026-09-30", "crossref"], [`doi:${DOI}`, "concern", "10.9999/eoc", null, "crossref"]]);
  await recordFrontierNotices(null, [{ kind: "retraction", noticeDoi: null, doi: DOI }]);
  const failures = [];
  const failing = /** @type {any} */ ({ async recordMany() { throw Object.assign(new Error("down"), { code: "source_change_unavailable" }); }, failed(/** @type {string} */ code) { failures.push(code); } });
  await recordFrontierNotices(failing, [{ kind: "retraction", noticeDoi: null, doi: DOI }]);
  assert.deepEqual(failures, ["source_change_unavailable"]);
});

test("a store with no database or no owner knows nothing and refuses to write, and refuses what is no identifier", async () => {
  const store = createSourceChanges({ documents: productDocumentsDouble(), ownerUserId: "platform" });
  assert.deepEqual([(await store.get(DOI)).state, (await store.get(DOI)).lastCheckedAt], ["unknown", null]);
  assert.deepEqual((await store.changedSince(0, 5)).items, []);
  assert.equal((await store.getMany([DOI])).get(`doi:${DOI}`)?.state, "unknown");
  await assert.rejects(() => store.record(DOI, { kind: "retraction" }, { assertedBy: "crossref" }), { code: "source_change_unavailable" });
  await assert.rejects(() => store.noteChecked([DOI]), { code: "source_change_unavailable" });
  await assert.rejects(() => store.get("not an identifier"), { code: "source_change_invalid" });
  await assert.rejects(() => store.getMany("10.1/x"), { code: "source_change_invalid" });
  await assert.rejects(() => store.getMany(Array.from({ length: 501 }, (_, index) => `10.1000/many.${index}`)), { code: "source_change_invalid" });
  assert.deepEqual((await store.recordPublicationStatus(DOI, undefined)), null);
});

test("the store's counters are one series per detector, one per read, and the failures", () => {
  const store = createSourceChanges({ documents: productDocumentsDouble(), ownerUserId: "platform" });
  store.failed("source_change_write_failed");
  const families = sourceChangeMetricFamilies(store.stats());
  const byName = new Map(families.map(family => [family.name, family]));
  assert.deepEqual(byName.get("open_science_source_changes_recorded_total")?.series.map(sample => sample.labels?.asserter), [...SOURCE_CHANGE_ASSERTERS]);
  assert.deepEqual(byName.get("open_science_source_change_reads_total")?.series.map(sample => sample.labels?.reader), ["get", "getMany", "changedSince", "check"]);
  assert.equal(byName.get("open_science_source_change_write_failures_total")?.series[0].value, 1);
  assert.deepEqual(sourceChangeMetricFamilies(null), []);
});

/** One project whose result cites one work, read with the store handed to it. */
async function impactFixture(sourceChanges) {
  const documents = productDocumentsDouble();
  const versions = [{ versionId: "rv_cites", projectId: "p", digest: "a".repeat(64), findings: [],
    inputs: [{ kind: "source", id: DOI, digest: "digest-1", versionId: null, availability: "captured" }] },
  { versionId: "rv_other", projectId: "p", digest: "b".repeat(64), findings: [],
    inputs: [{ kind: "source", id: "10.9999/other.work", digest: "digest-2", versionId: null, availability: "captured" }] }];
  const scans = { lists: 0 };
  const results = {
    async scope(userId, projectId) { if (userId === "alice" && projectId === "p") return { userId: "alice", id: "p" }; throw Object.assign(new Error("scope denied"), { status: 403 }); },
    async list() { scans.lists += 1; return { items: versions, nextCursor: null }; },
    async get(_user, _project, id) { const row = versions.find(item => item.versionId === id); if (!row) throw Object.assign(new Error("Unavailable"), { code: "result_not_found" }); return structuredClone(row); },
  };
  const notices = [];
  const failures = [];
  const service = new ResultImpactService({ documents, results, sourceChanges, report: code => failures.push(code), now: () => new Date("2026-10-05T12:00:00Z"),
    notifications: { async create(_user, input) { notices.push(input); } } });
  return { service, notices, failures, scans };
}
const recordedFact = (doi, entries = [retraction]) => factOf(entries, `doi:${doi}`);

test("a check is read together with the record: a retraction on record is not undone by a lookup that failed, and a record that says nothing changes nothing", async () => {
  const gets = [];
  const store = { async get(identifier) { gets.push(identifier); return identifier === `doi:${DOI}` ? recordedFact(DOI) : sourceChangeFact(identifier, null); } };
  const f = await impactFixture(store);
  const unavailable = { state: "unavailable", checkedAt: AT, reason: "timeout", updates: [] };
  const reply = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI }, status: unavailable });
  assert.deepEqual(reply.items.map(item => [item.payload.versionId, item.payload.effect]), [["rv_cites", "potentially_affected"]]);
  assert.deepEqual(reply.items[0].payload.sourceStatus.updates.map(update => [update.kind, update.noticeDoi]), [["retraction", "10.9999/notice"]]);
  assert.equal(f.notices.length, 1, "told once, as a check would have told it");
  assert.deepEqual(gets, [`doi:${DOI}`]);

  const unrecorded = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: "10.9999/other.work" }, status: unavailable });
  assert.equal(unrecorded.items[0].payload.effect, "source_gap", "a work with nothing on record is a gap, exactly as before");
  // A knowledge-base source names no DOI and is not looked up at all.
  const before = gets.length;
  await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: `src_${"a".repeat(32)}` }, status: unavailable });
  assert.equal(gets.length, before);
});

test("a record that cannot be read leaves the check as the caller found it, and says so", async () => {
  const f = await impactFixture({ async get() { throw Object.assign(new Error("down"), { code: "source_change_unavailable" }); } });
  const reply = await f.service.reconcileSourceUpdate("alice", { projectId: "p", source: { id: DOI },
    status: { state: "changed", checkedAt: AT, updates: [{ kind: "correction", noticeDoi: null, date: null, source: null }] } });
  assert.equal(reply.items.length, 1);
  assert.deepEqual(f.failures, ["source_change_unavailable"]);
});

test("what was recorded since a position is reconciled against one project, whose results are read once, and only works it cites make impacts", async () => {
  /** @type {any[]} */
  const asked = [];
  const facts = [recordedFact(DOI), recordedFact("10.9999/not.cited"), factOf([{ ...retraction, kind: "new_version" }], "doi:10.9999/only.a.new.version"), factOf([retraction], "pmid:123")];
  const store = {
    async changedSince(cursor, limit) { asked.push([cursor, limit]); return { items: facts, cursor: 4, hasMore: true }; },
    async get(identifier) { return facts.find(fact => fact.identifier === identifier) ?? sourceChangeFact(identifier, null); },
  };
  const f = await impactFixture(store);
  const caught = await f.service.reconcileSince("alice", { projectId: "p", since: 0, limit: 25 });
  assert.deepEqual(asked, [[0, 25]]);
  assert.deepEqual(caught.items.map(item => item.payload.versionId), ["rv_cites"]);
  assert.deepEqual([caught.cursor, caught.hasMore, caught.scanned], [4, true, 2]);
  assert.equal(f.scans.lists, 1, "the project was read once for the page, not once per work");
  assert.equal(f.notices.length, 1);
  // Another account's project is refused before the feed is read.
  await assert.rejects(() => f.service.reconcileSince("mallory", { projectId: "p" }), { status: 403 });
  assert.equal(asked.length, 1);
  // With no record composed there is nothing to catch up on.
  const bare = await impactFixture(null);
  assert.deepEqual(await bare.service.reconcileSince("alice", { projectId: "p", since: 7 }), { items: [], cursor: 7, hasMore: false, scanned: 0, unavailable: true });
});

test("memories are labelled from the feed by the works whose changes were recorded, one account at a time", async () => {
  const labelled = [];
  const memory = { configured: true,
    async dependentsOfSource(owner, link) { return owner === "alice" && link.id === DOI ? [{ recordId: "mem_1", scope: "user", scopeId: null, kind: "preference", status: "active", state: "current" }] : []; },
    async markSourceLinks(owner, link, finding) { labelled.push([owner, link.id, finding.state, finding.reason]); return { recordIds: ["mem_1"] }; } };
  const facts = [recordedFact(DOI), recordedFact("10.9999/nobody.names.this")];
  const service = new KnowledgeChangeService({ memory, sourceChanges: { async changedSince() { return { items: facts, cursor: 2, hasMore: false }; } } });
  const reply = await service.labelSince("alice", "p", { since: 0 });
  assert.deepEqual(reply.items?.map(entry => [entry.identifier, entry.memories.map(item => [item.recordId, item.state])]), [[`doi:${DOI}`, [["mem_1", "retracted"]]]]);
  assert.deepEqual(labelled, [["alice", DOI, "retracted", "retraction"]]);
  assert.deepEqual([reply.cursor, reply.hasMore], [2, false]);
  assert.deepEqual((await service.labelSince("bob", "p")).items, [], "another account's memories are not found by this one's links");
  assert.deepEqual(await new KnowledgeChangeService({ memory }).labelSince("alice", "p"), { unknown: "unavailable" });
  const reported = [];
  const broken = new KnowledgeChangeService({ memory, report: code => reported.push(code), sourceChanges: { async changedSince() { throw Object.assign(new Error("down"), { code: "source_change_unavailable" }); } } });
  assert.deepEqual(await broken.labelSince("alice", "p"), { unknown: "lookup_failed" });
  assert.deepEqual(reported, ["source_change_unavailable"]);
});
