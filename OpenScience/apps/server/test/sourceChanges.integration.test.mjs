// The one durable source-change fact against a real PostgreSQL (plan 2026-10-05 B5): a record per identifier in the
// product ledger, owned by one platform account, with a feed that has a position and a check that cannot call a failure
// clean. The Crossref lookup is the real one over a fake network.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { evidencePublicationStatus } from "../src/evidenceCardContent.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { createSourceChanges, recordFrontierNotices, recordFromPublicationStatus, sourceChangeMetricFamilies, sourceIdentifiersOf } from "../src/sourceChanges.mjs";
import { createSourceUpdateLookup } from "../src/sourceUpdates.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {any} */ let database; /** @type {any} */ let documents;
/** @type {string[]} */ const owners = [];
const T0 = Date.parse("2026-10-05T00:00:00.000Z");
const HOUR = 3_600_000;

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 8, databaseConnectionTimeoutMs: 5_000 });
  await migrateProductStore(database);
  documents = new ProductDocuments(database);
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [owners]);
  await database.close();
});

/** A platform account of its own for each test, so one test's feed is not another's. */
async function fixture({ lookup = null, maxAgeMs = undefined } = {}) {
  const owner = `source_change_${randomUUID()}`; owners.push(owner);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Source change platform','development')", [owner]);
  const clock = { at: T0 };
  const store = createSourceChanges({ documents, ownerUserId: owner, lookup, maxAgeMs, now: () => new Date(clock.at) });
  return { owner, store, clock };
}
const retraction = (extra = {}) => ({ kind: "retraction", noticeIdentifier: "10.1000/notice", date: "2026-09-01", ...extra });
const DOI = "10.1000/work.one";

test("Postgres: a retraction recorded once is read back by get, getMany and the feed, and carries nothing of a tenant", options, async () => {
  const { store, owner } = await fixture();
  const written = await store.record(DOI, retraction({ evidence: { updateKind: "retraction" } }), { assertedBy: "crossref" });
  assert.equal(written.state, "changed");
  assert.equal(written.identifier, `doi:${DOI}`);
  assert.deepEqual(written.changes.map(change => [change.kind, change.noticeIdentifier, change.date, change.assertedBy]), [["retraction", "10.1000/notice", "2026-09-01", ["crossref"]]]);

  assert.deepEqual((await store.get(`https://doi.org/${DOI.toUpperCase()}`)).changes, written.changes, "any spelling of the DOI is the one record");
  const many = await store.getMany([DOI, "10.1000/never.asked", "not an identifier"]);
  assert.deepEqual([...many.keys()], [`doi:${DOI}`, "doi:10.1000/never.asked"], "an input that is no identifier is left out");
  assert.equal(many.get(`doi:${DOI}`)?.state, "changed");
  assert.deepEqual([many.get("doi:10.1000/never.asked")?.state, many.get("doi:10.1000/never.asked")?.lastCheckedAt], ["unknown", null]);
  const feed = await store.changedSince(0, 10);
  assert.deepEqual(feed.items.map(item => item.identifier), [`doi:${DOI}`]);
  assert.deepEqual([feed.cursor, feed.hasMore, feed.items[0].seq], [1, false, 1]);

  // Public bibliographic facts under the platform's account and no project: nothing says who asked.
  const rows = (await database.query("SELECT user_id, project_id, payload FROM evimed_product.documents WHERE kind='source-change' AND user_id=$1", [owner])).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].user_id, rows[0].project_id], [owner, null]);
  assert.deepEqual(Object.keys(rows[0].payload).sort(), ["changes", "identifier", "lastCheckedAt", "lastOutcome", "recordType", "schemaVersion", "seq"]);
  assert.ok(!/user|project|tenant|owner|account/i.test(JSON.stringify(rows[0].payload)), "no tenant, project or account is in the record");
});

test("Postgres: the same retraction asserted by two detectors is one change with both kept, and a detector's second sight is a counter", options, async () => {
  const { store, owner, clock } = await fixture();
  await store.record(DOI, retraction(), { assertedBy: "crossref" });
  const history = async () => (await documents.history(owner, "source-change", (await database.query("SELECT id FROM evimed_product.documents WHERE user_id=$1 AND kind='source-change'", [owner])).rows[0].id, { limit: 50 })).length;
  assert.equal(await history(), 1);

  clock.at += HOUR;
  const second = await store.record(DOI, retraction({ date: null }), { assertedBy: "retraction-watch" });
  assert.equal(second.changes.length, 1, "one retraction, two witnesses");
  assert.deepEqual(second.changes[0].assertedBy, ["crossref", "retraction-watch"]);
  assert.equal(second.changes[0].firstSeenAt, new Date(T0).toISOString());
  assert.equal(await history(), 2, "a second witness is a fact and is kept in the history");

  clock.at += HOUR;
  const again = await store.record(DOI, retraction(), { assertedBy: "crossref" });
  assert.equal(again.changes[0].lastCheckedAt, new Date(clock.at).toISOString(), "the sight moved the check time");
  assert.equal(await history(), 2, "and wrote no revision row");
  assert.equal((await store.changedSince(0, 10)).items.length, 1, "neither re-assertion is a new position in the feed");
  assert.deepEqual([(await store.changedSince(0, 10)).cursor], [1]);
  const stats = store.stats();
  assert.deepEqual([stats.recorded.crossref, stats.recorded["retraction-watch"], stats.duplicates], [1, 1, 1]);

  // A different notice of the same work is another change, and the work is announced again at its new position.
  await store.record(DOI, retraction({ kind: "correction", noticeIdentifier: "10.1000/erratum" }), { assertedBy: "crossref" });
  const feed = await store.changedSince(1, 10);
  assert.deepEqual(feed.items.map(item => [item.identifier, item.seq, item.changes.length]), [[`doi:${DOI}`, 2, 2]]);
});

test("Postgres: checked and nothing found is not never checked, and a check that was not answered records nothing", options, async () => {
  const { store } = await fixture();
  await store.noteChecked(["10.1000/clean.one", "PMID 123"]);
  await store.noteChecked(["10.1000/elsewhere"], { outcome: "not_indexed" });
  const facts = await store.getMany(["10.1000/clean.one", "pmid:123", "10.1000/elsewhere", "10.1000/never.asked"]);
  assert.deepEqual([...facts.values()].map(fact => fact.state), ["clean", "clean", "unknown", "unknown"]);
  assert.deepEqual([...facts.values()].map(fact => fact.lastCheckedAt !== null), [true, true, true, false], "asked is told apart from never asked");
  assert.equal((await store.changedSince(0, 10)).items.length, 0, "a clean answer is not news");

  // A work with a retraction on record is never made clean by a later check that found less.
  await store.record(DOI, retraction(), { assertedBy: "crossref" });
  await store.noteChecked([DOI]);
  assert.equal((await store.get(DOI)).state, "changed");
});

test("Postgres: the feed has a position, so pages tile it, and parallel writers each take one", options, async () => {
  const { store } = await fixture();
  const identifiers = Array.from({ length: 12 }, (_, index) => `10.1000/parallel.${index}`);
  await Promise.all(identifiers.map(identifier => store.record(identifier, retraction({ noticeIdentifier: `10.1000/n-${identifier}` }), { assertedBy: "crossref" })));
  const seen = [];
  let cursor = 0;
  for (let page = 0; page < 10; page += 1) {
    const reply = await store.changedSince(cursor, 5);
    seen.push(...reply.items.map(item => item.seq));
    cursor = reply.cursor;
    if (!reply.hasMore) break;
  }
  assert.deepEqual(seen, Array.from({ length: 12 }, (_, index) => index + 1), "twelve distinct positions, in order, none skipped or repeated");
  assert.deepEqual((await store.changedSince(cursor, 5)).items, [], "nothing after the last position");
  await assert.rejects(() => store.changedSince(-1), { code: "source_change_invalid" });
  await assert.rejects(() => store.changedSince(0, 0), { code: "source_change_invalid" });
  await assert.rejects(() => store.record("not an identifier", retraction(), { assertedBy: "crossref" }), { code: "source_change_invalid" });
  assert.deepEqual((await store.record(DOI, { kind: "rumour" }, { assertedBy: "crossref" })).changes, [], "an unknown kind records nothing");
});

test("Postgres: each account's feed is its own, and a store without an owner knows nothing and writes nothing", options, async () => {
  const one = await fixture();
  const other = await fixture();
  await one.store.record(DOI, retraction(), { assertedBy: "crossref" });
  assert.equal((await other.store.get(DOI)).state, "unknown");
  assert.deepEqual((await other.store.changedSince(0, 10)).items, []);
  const none = createSourceChanges({ documents, ownerUserId: () => null });
  assert.equal((await none.get(DOI)).state, "unknown");
  assert.deepEqual((await none.changedSince(0, 10)).items, []);
  await assert.rejects(() => none.record(DOI, retraction(), { assertedBy: "crossref" }), { code: "source_change_unavailable" });
});

/** The real Crossref lookup over a fake network, writing through the store. */
function crossrefLookup(store, { clock, answers = new Map(), missing = new Set(["10.1000/not.in.crossref"]), fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (/** @type {URL} */ request) => {
    calls.push(request.searchParams.get("filter"));
    if (fail) return new Response("down", { status: 503 });
    const dois = request.searchParams.get("filter").split(",").map(part => part.replace(/^doi:/, ""));
    const items = dois.filter(doi => !missing.has(doi)).map(doi => ({ DOI: doi, "updated-by": answers.get(doi) ?? [] }));
    return new Response(JSON.stringify({ message: { items } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const lookup = createSourceUpdateLookup({ fetchImpl, userAgent: "test", now: () => clock.at, changes: store });
  store.useLookup(lookup);
  return { lookup, calls };
}

test("Postgres: check asks Crossref only for what was never checked or is stale, records the answer, and calls a failure unknown", options, async () => {
  const { store, clock } = await fixture();
  const answers = new Map([["10.1000/retracted.one", [{ type: "retraction", DOI: "10.1000/N1", source: "retraction-watch", updated: { "date-time": "2026-02-03T00:00:00Z" } }]]]);
  const network = crossrefLookup(store, { clock, answers });

  const first = await store.check(["10.1000/retracted.one", "10.1000/fine.one", "10.1000/not.in.crossref", "PMID 123"]);
  assert.deepEqual(network.calls, ["doi:10.1000/retracted.one,doi:10.1000/fine.one,doi:10.1000/not.in.crossref"]);
  assert.deepEqual([...first.values()].map(fact => fact.state), ["changed", "clean", "unknown", "unknown"]);
  assert.deepEqual(first.get("doi:10.1000/retracted.one")?.changes.map(change => [change.kind, change.assertedBy]), [["retraction", ["retraction-watch"]]]);
  assert.equal(first.get("doi:10.1000/not.in.crossref")?.lastCheckedAt !== null, true, "Crossref was asked about it");
  assert.equal(first.get("pmid:123")?.lastCheckedAt, null, "there is no Crossref lookup for a PMID, so it was not asked");

  clock.at += HOUR;
  await store.check(["10.1000/retracted.one", "10.1000/fine.one", "10.1000/not.in.crossref"]);
  assert.equal(network.calls.length, 1, "fresh answers are read from the record, not asked for again");
  clock.at += 13 * HOUR;
  await store.check(["10.1000/fine.one"]);
  assert.equal(network.calls.length, 2, "an answer older than the default freshness is asked again");
  clock.at += 120_000;
  await store.check(["10.1000/fine.one"]);
  assert.equal(network.calls.length, 2, "two minutes later the answer is still fresh by default");
  await store.check(["10.1000/fine.one"], { maxAgeMs: 60_000 });
  assert.equal(network.calls.length, 3, "but not for a caller that allows a minute");

  // A lookup that fails is unknown: nothing is recorded, nothing is called clean, and the next read asks again.
  const down = await fixture();
  const failing = crossrefLookup(down.store, { clock: down.clock, fail: true });
  const unanswered = await down.store.check(["10.1000/fine.two"]);
  assert.deepEqual([unanswered.get("doi:10.1000/fine.two")?.state, unanswered.get("doi:10.1000/fine.two")?.lastCheckedAt], ["unknown", null]);
  assert.equal(down.store.stats().lookupFailures, 1);
  await down.store.check(["10.1000/fine.two"]);
  assert.equal(failing.calls.length, 2, "an unanswered check is asked again at the next read");
  assert.equal((await down.store.get("10.1000/fine.two")).lastCheckedAt, null);
  // And a notice another detector recorded is not undone by the failure.
  await down.store.record("10.1000/fine.three", retraction(), { assertedBy: "crossref" });
  const recordedAt = new Date(down.clock.at).toISOString();
  down.clock.at += 13 * HOUR;
  assert.equal((await down.store.check(["10.1000/fine.three"])).get("doi:10.1000/fine.three")?.state, "changed");
  // The lookup itself says so too: its answer to a work it could not ask about is the notice on record, with the record's
  // own check time, and a work with nothing on record is a gap that names its reason.
  const statuses = await failing.lookup.lookupStatuses(["10.1000/fine.three", "10.1000/fine.four"]);
  assert.deepEqual([statuses.get("10.1000/fine.three")?.state, statuses.get("10.1000/fine.three")?.checkedAt, statuses.get("10.1000/fine.three")?.updates.map(update => update.kind)],
    ["changed", recordedAt, ["retraction"]]);
  assert.deepEqual([statuses.get("10.1000/fine.four")?.state, statuses.get("10.1000/fine.four")?.reason], ["unavailable", "http_503"]);

  const text = JSON.stringify(sourceChangeMetricFamilies(store.stats()));
  assert.match(text, /open_science_source_changes_recorded_total/);
  assert.equal(store.stats().reads.check, 5);
});

test("Postgres: a card's sources are read for what is recorded against them", options, async () => {
  const { store } = await fixture();
  await store.record("10.1056/NEJMoa2307563", retraction({ noticeIdentifier: "pmid:999" }), { assertedBy: "europepmc" });
  await store.noteChecked(["pmid:37952131"]);
  const sources = [
    { title: "Retracted", url: "https://doi.org/10.1056/NEJMoa2307563" },
    { title: "Clean", url: "https://pubmed.ncbi.nlm.nih.gov/37952131/" },
    { title: "Never checked", url: "https://clinicaltrials.gov/study/NCT03574597" },
    { title: "No identifier", url: "https://example.org/a-page" },
    { title: "Two names for one work", url: "https://pubmed.ncbi.nlm.nih.gov/37952131/", doi: "10.1056/NEJMoa2307563" },
  ];
  assert.deepEqual(sourceIdentifiersOf(sources[4]), ["pmid:37952131", "doi:10.1056/nejmoa2307563"]);
  const read = await store.changesForCardSources(sources);
  assert.deepEqual(read.map(entry => [entry.index, entry.state, entry.changes.length]), [[0, "changed", 1], [1, "clean", 0], [2, "unknown", 0], [3, "unknown", 0], [4, "changed", 1]]);
  assert.deepEqual(read[2].identifiers, ["reg:NCT03574597"]);
  assert.deepEqual(read[3].identifiers, []);
  assert.equal(read[4].changes[0].noticeIdentifier, "pmid:999", "each change once, however many names the source has");
});

test("Postgres: the evidence zone's Europe PMC reading is recorded by europepmc, a clear reading is an answered check, and no reading is nothing", options, async () => {
  const { store } = await fixture();
  const status = evidencePublicationStatus({ kind: "retracted", notices: ["Retraction in · Doe · retracted for error · MED:111", "Erratum in · Doe · MED:222"] });
  const recorded = await store.recordPublicationStatus(DOI, status);
  assert.deepEqual(recorded?.changes.map(change => [change.kind, change.noticeIdentifier, change.assertedBy]).sort(), [
    ["correction", "pmid:222", ["europepmc"]], ["retraction", "pmid:111", ["europepmc"]]]);
  assert.deepEqual(recordFromPublicationStatus(DOI, status).entries.length, 2);
  assert.equal(await store.recordPublicationStatus("10.1000/unread", undefined), null);
  assert.equal((await store.get("10.1000/unread")).state, "unknown", "a record that supplied no status says nothing");
  await store.recordPublicationStatus("10.1000/clear", null);
  assert.equal((await store.get("10.1000/clear")).state, "clean", "a verified clear status is an answered check");
});

test("Postgres: frontier notices are recorded as changes of the work they name, and a store that is absent or failing costs the pipeline nothing", options, async () => {
  const { store } = await fixture();
  await recordFrontierNotices(store, [
    { kind: "retraction", noticeDoi: "10.1000/retraction-notice", doi: "10.1000/cited.work", date: "2026-09-22" },
    { kind: "preprint-of", noticeDoi: null, doi: "10.1000/ignored" },
  ]);
  const fact = await store.get("10.1000/cited.work");
  assert.deepEqual(fact.changes.map(change => [change.kind, change.noticeIdentifier, change.date, change.assertedBy, change.evidence.crossref]), [
    ["retraction", "10.1000/retraction-notice", "2026-09-22", ["crossref"], { channel: "frontier", relation: "retraction" }]]);
  assert.equal((await store.get("10.1000/ignored")).state, "unknown");
  await recordFrontierNotices(null, [{ kind: "retraction", noticeDoi: null, doi: "10.1000/x" }]);
  const broken = createSourceChanges({ documents, ownerUserId: () => null });
  await recordFrontierNotices(broken, [{ kind: "retraction", noticeDoi: null, doi: "10.1000/x" }]);
  assert.equal(broken.stats().writeFailures, 1);
});

test("Postgres: the migration is idempotent and accepts a ledger that already holds other kinds", options, async () => {
  // A second database object has its own migration memory, so this runs the whole script again over what is there.
  const again = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    await migrateProductStore(again);
    await migrateProductStore(again);
    const constraint = (await again.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='product_documents_kind_check'")).rows[0].definition;
    assert.match(constraint, /source-change/);
    assert.match(constraint, /result-version/, "the kinds that were there still are");
    const index = await again.query("SELECT 1 FROM pg_indexes WHERE indexname='product_source_change_seq_idx'");
    assert.equal(index.rowCount, 1);
  } finally { await again.close(); }
});
