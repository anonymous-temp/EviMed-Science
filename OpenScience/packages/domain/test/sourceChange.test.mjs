import assert from "node:assert/strict";
import test from "node:test";
import {
  SOURCE_CURRENCY_LABELS, canonicalSourceIdentifier, changeFromFrontierLink, changesFromCrossrefUpdates, changesFromPublicationStatus,
  currencyLabel, doiOfSourceIdentifier, foldSourceChanges, mergeSourceUpdateStatus, noticeIdentifierOf, sourceChangeFact,
  sourceUpdateStatusOfFact, sourceUpdatesFromCrossref, sourceUpdatesOfChanges,
} from "../index.mjs";

const AT = "2026-10-05T00:00:00.000Z";
const LATER = "2026-10-06T00:00:00.000Z";
const ID = "doi:10.1000/work";
/** @param {string} assertedBy @param {Record<string, any>} [extra] */
const retraction = (assertedBy, extra = {}) => ({ assertedBy, kind: "retraction", noticeIdentifier: "10.1000/notice", date: "2026-09-01", evidence: {}, ...extra });

test("an identifier is read into the one form every module compares, and nothing else is one", () => {
  for (const text of ["10.1056/NEJMoa2307563", "doi:10.1056/NEJMoa2307563", "https://doi.org/10.1056/NEJMoa2307563.", "DOI: 10.1056/nejmoa2307563"]) {
    assert.equal(canonicalSourceIdentifier(text), "doi:10.1056/nejmoa2307563", text);
  }
  for (const text of ["PMID: 37952131", "pmid:37952131", "https://pubmed.ncbi.nlm.nih.gov/37952131/", "https://www.ncbi.nlm.nih.gov/pubmed/37952131"]) {
    assert.equal(canonicalSourceIdentifier(text), "pmid:37952131", text);
  }
  for (const text of ["NCT03574597", "nct03574597", "reg:NCT03574597", "https://clinicaltrials.gov/study/NCT03574597"]) {
    assert.equal(canonicalSourceIdentifier(text), "reg:NCT03574597", text);
  }
  assert.equal(canonicalSourceIdentifier("ChiCTR2000012345"), "reg:CHICTR2000012345");
  assert.equal(canonicalSourceIdentifier("2012-004567-12"), "reg:2012-004567-12");
  for (const text of ["", null, undefined, "semaglutide", "https://example.org/paper", "12345", "NCT123", "x".repeat(700)]) {
    assert.equal(canonicalSourceIdentifier(text), null, String(text));
  }
  assert.equal(doiOfSourceIdentifier("doi:10.1000/work"), "10.1000/work");
  assert.equal(doiOfSourceIdentifier("pmid:123"), null);
  assert.equal(noticeIdentifierOf("https://doi.org/10.1000/Notice"), "10.1000/notice");
  assert.equal(noticeIdentifierOf("https://pubmed.ncbi.nlm.nih.gov/999/"), "pmid:999");
  assert.equal(noticeIdentifierOf("https://example.org/notice#top"), "https://example.org/notice");
  assert.equal(noticeIdentifierOf("a notice, in words"), null);
});

test("a change is kept once however many detectors saw it, and each detector that did is kept", () => {
  const first = foldSourceChanges(null, [retraction("crossref")], { identifier: ID, at: AT });
  assert.deepEqual([first.appended, first.confirmed, first.duplicates], [1, 0, 0]);
  const second = foldSourceChanges(first.record, [retraction("retraction-watch", { date: null })], { identifier: ID, at: LATER });
  assert.deepEqual([second.appended, second.confirmed], [0, 1], "a second witness of the same notice is not a second retraction");
  assert.equal(second.record.changes.length, 1);
  assert.deepEqual(second.record.changes[0].assertedBy, ["crossref", "retraction-watch"]);
  assert.equal(second.record.changes[0].firstSeenAt, AT);
  assert.equal(second.record.changes[0].lastCheckedAt, LATER);
  assert.equal(second.record.changes[0].date, "2026-09-01", "a date the first detector gave is not lost to one that gave none");
  const again = foldSourceChanges(second.record, [retraction("crossref")], { identifier: ID, at: LATER });
  assert.deepEqual([again.appended, again.confirmed, again.duplicates], [0, 0, 1]);
  assert.deepEqual(again.record.changes[0].assertedBy, ["crossref", "retraction-watch"]);
  // A different notice of the same kind, and a different kind of the same notice, are other changes.
  const more = foldSourceChanges(again.record, [retraction("crossref", { noticeIdentifier: "10.1000/other" }), retraction("crossref", { kind: "correction" })],
    { identifier: ID, at: LATER });
  assert.equal(more.record.changes.length, 3);
});

test("a change the vocabulary does not know, and a detector it does not know, record nothing and say so", () => {
  const folded = foldSourceChanges(null, [retraction("crossref", { kind: "rumour" }), retraction("a-blog"), retraction("operator")], { identifier: ID, at: AT });
  assert.equal(folded.rejected, 2);
  assert.deepEqual(folded.record.changes.map((change) => change.assertedBy), [["operator"]]);
});

test("looked at and found nothing is not the same as never looked at", () => {
  assert.equal(sourceChangeFact(ID, null).state, "unknown");
  assert.equal(sourceChangeFact(ID, null).lastCheckedAt, null);
  const clean = foldSourceChanges(null, [], { identifier: ID, at: AT }).record;
  assert.deepEqual([sourceChangeFact(ID, clean).state, sourceChangeFact(ID, clean).lastCheckedAt], ["clean", AT]);
  const notIndexed = foldSourceChanges(null, [], { identifier: ID, at: AT, outcome: "not_indexed" }).record;
  assert.equal(sourceChangeFact(ID, notIndexed).state, "unknown", "an index that does not hold the work has not cleared it");
  assert.equal(sourceChangeFact(ID, notIndexed).lastCheckedAt, AT, "but it was asked");
  assert.deepEqual(sourceUpdateStatusOfFact(sourceChangeFact(ID, null)), { state: "unknown", checkedAt: null, reason: "never_checked", updates: [] });
  assert.deepEqual(sourceUpdateStatusOfFact(sourceChangeFact(ID, clean)), { state: "no_update", checkedAt: AT, updates: [] });
  assert.equal(sourceUpdateStatusOfFact(sourceChangeFact(ID, notIndexed)).reason, "not_in_crossref");
  // A later clean answer never removes what an earlier one found.
  const held = foldSourceChanges(null, [retraction("crossref")], { identifier: ID, at: AT }).record;
  const checkedAgain = foldSourceChanges(held, [], { identifier: ID, at: LATER }).record;
  assert.equal(sourceChangeFact(ID, checkedAgain).state, "changed");
});

test("what Crossref said comes back out of the record exactly as the result impact path reads it", () => {
  const work = { "updated-by": [
    { type: "partial_retraction", DOI: "10.1000/N1", updated: { "date-time": "2026-02-03T00:00:00Z" }, source: "publisher" },
    { type: "correction", DOI: "10.1000/N2", updated: { "date-parts": [[2024, 5]] }, source: "retraction-watch" },
    { type: "expression_of_concern", DOI: "10.1000/N3", updated: {}, source: "publisher" },
    { type: "addendum", DOI: "10.1000/N4" },
  ] };
  const updates = sourceUpdatesFromCrossref(work);
  const entries = changesFromCrossrefUpdates(updates);
  assert.deepEqual(entries.map((entry) => [entry.assertedBy, entry.kind]).sort(), [["crossref", "concern"], ["crossref", "retraction"], ["retraction-watch", "correction"]]);
  const record = foldSourceChanges(null, entries, { identifier: ID, at: AT }).record;
  assert.deepEqual(sourceUpdatesOfChanges(record.changes).map((/** @type {any} */ update) => [update.kind, update.noticeDoi, update.date]),
    updates.map((/** @type {any} */ update) => [update.kind, update.noticeDoi, update.date]));
  assert.equal(sourceUpdatesOfChanges(record.changes).find((update) => update.kind === "correction")?.source, "retraction-watch");
});

test("a recorded notice is not undone by a check that did not see it, and a record with none does not weaken a fresh check", () => {
  const recorded = sourceUpdateStatusOfFact(sourceChangeFact(ID, foldSourceChanges(null, [retraction("crossref")], { identifier: ID, at: AT }).record));
  const unavailable = { state: "unavailable", checkedAt: LATER, reason: "timeout", updates: [] };
  const merged = mergeSourceUpdateStatus(unavailable, recorded);
  assert.equal(merged?.state, "changed");
  assert.deepEqual(merged?.updates.map((/** @type {any} */ update) => update.kind), ["retraction"]);
  const correction = { state: "changed", checkedAt: LATER, updates: [{ kind: "correction", noticeDoi: "10.1000/c", date: null, source: null }] };
  assert.deepEqual(mergeSourceUpdateStatus(correction, recorded)?.updates.map((/** @type {any} */ update) => update.kind), ["retraction", "correction"]);
  assert.equal(mergeSourceUpdateStatus(correction, recorded)?.checkedAt, LATER, "the check's own time stays");
  const sameNotice = { state: "changed", checkedAt: LATER, updates: recorded.updates };
  assert.equal(mergeSourceUpdateStatus(sameNotice, recorded)?.updates.length, 1, "one notice seen twice is one");
  const none = sourceUpdateStatusOfFact(sourceChangeFact(ID, null));
  assert.equal(mergeSourceUpdateStatus(correction, none), correction);
  assert.equal(mergeSourceUpdateStatus(unavailable, none), unavailable);
});

test("a frontier relation is a change of the work it points at, a preprint link is not", () => {
  assert.deepEqual(changeFromFrontierLink({ kind: "expression-of-concern", noticeIdentifier: "10.1000/n", date: "2026-09-22" }), {
    assertedBy: "crossref", kind: "concern", noticeIdentifier: "10.1000/n", date: "2026-09-22", evidence: { channel: "frontier", relation: "expression-of-concern" } });
  for (const kind of ["retraction", "correction", "withdrawal", "new-version"]) assert.ok(changeFromFrontierLink({ kind }), kind);
  assert.equal(changeFromFrontierLink({ kind: "preprint-of" }), null);
});

test("a card source's publication status is read into changes, each notice by its own type where it has one", () => {
  assert.deepEqual(changesFromPublicationStatus({ kind: "retracted", notices: ["Europe PMC: isRetracted=Y"] }), [
    { assertedBy: "europepmc", kind: "retraction", noticeIdentifier: null, date: null, evidence: { notices: ["Europe PMC: isRetracted=Y"] } }]);
  const mixed = changesFromPublicationStatus({ kind: "retracted", notices: [
    "Retraction in · Doe J. Retraction notice · retracted for error · MED:111", "Erratum in · Smith · MED:222", "Published Erratum", "Retracted Publication"] });
  assert.deepEqual(mixed.map((change) => [change.kind, change.noticeIdentifier]).sort(), [
    ["correction", "pmid:222"], ["correction", null], ["retraction", "pmid:111"], ["retraction", null]].sort());
  assert.deepEqual(changesFromPublicationStatus({ kind: "concern", notices: ["Expression of concern in · X · MED:5"] }).map((change) => change.kind), ["concern"]);
  assert.deepEqual(changesFromPublicationStatus({ kind: "corrected", notices: ["Something unlisted"] }).map((change) => change.kind), ["correction"],
    "a type the table does not hold takes the kind of the status as a whole");
  assert.deepEqual(changesFromPublicationStatus({ kind: "corrected", notices: [] }).map((change) => [change.kind, change.noticeIdentifier]), [["correction", null]]);
  for (const status of [null, undefined, "retracted", { kind: "fine", notices: [] }, { notices: ["x"] }]) assert.deepEqual(changesFromPublicationStatus(status), []);
  // A status is a change when folded: asserted once by Europe PMC, and a detector's second sight is not another change.
  const folded = foldSourceChanges(null, changesFromPublicationStatus({ kind: "retracted", notices: ["Retraction in · A · MED:111"] }), { identifier: ID, at: AT });
  assert.equal(folded.record.changes[0].noticeIdentifier, "pmid:111");
  assert.deepEqual(folded.record.changes[0].assertedBy, ["europepmc"]);
});

test("the five 时效 labels, and which wins when several are true", () => {
  /** @param {string} kind */
  const change = (kind) => ({ kind });
  assert.equal(currencyLabel({}), "current");
  assert.equal(currencyLabel({ changes: [], lastCheckedAt: AT }), "current");
  assert.equal(currencyLabel({ hasNewEvidence: true }), "new_evidence_pending");
  assert.equal(currencyLabel({ changes: [change("new_version")] }), "new_evidence_pending", "a newer version of a source is news about the evidence");
  for (const kind of ["retraction", "withdrawal", "concern", "correction"]) assert.equal(currencyLabel({ changes: [change(kind)] }), "source_changed", kind);
  assert.equal(currencyLabel({ superseded: true }), "superseded");
  assert.equal(currencyLabel({ retired: true }), "no_longer_updated");
  // A card with a successor says so first; a changed source is the next thing; a retired card still says its source changed;
  // new evidence waits behind the card's retirement, which is why it will not be taken up.
  assert.equal(currencyLabel({ superseded: true, changes: [change("retraction")], retired: true }), "superseded");
  assert.equal(currencyLabel({ changes: [change("retraction")], retired: true, hasNewEvidence: true }), "source_changed");
  assert.equal(currencyLabel({ retired: true, hasNewEvidence: true }), "no_longer_updated");
  assert.equal(currencyLabel({ hasNewEvidence: true, changes: [change("new_version")] }), "new_evidence_pending");
  for (const label of ["current", "new_evidence_pending", "source_changed", "superseded", "no_longer_updated"]) assert.ok(SOURCE_CURRENCY_LABELS.includes(label));
  assert.equal(SOURCE_CURRENCY_LABELS.length, 5);
});
