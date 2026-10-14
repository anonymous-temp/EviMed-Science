// A reading made before the slots were assigned by type (2026-10-07 / 2026-10-13) is read again, and nothing else is: a paper keeps its
// clinical slots (they are its type's optional ones), a reading with only the slots its type has is left alone.
import assert from "node:assert/strict";
import test from "node:test";
import { outdatedUnderstandings, requeueOutdated, understandingFit } from "../src/sourceUnderstandingCurrency.mjs";

const slots = (...keys) => Object.fromEntries(keys.map((key) => [key, { state: "known", value: "x", evidence: [] }]));

test("a reading is current when every slot it carries is one its type has today, and made under that type's schema", () => {
  // A paper read before the discipline-neutral slots has only the clinical ones, and they are a paper's optional ones.
  assert.equal(understandingFit("published-paper", { docType: "published-paper", slots: slots("doi", "design", "population", "interventionExposure", "outcomes", "effectEstimates", "limitations") }).current, true);
  assert.equal(understandingFit("published-paper", { docType: "published-paper", slots: slots("question", "method", "dataOrSubjects", "mainResults", "limitations", "doi") }).current, true);
  assert.equal(understandingFit("document", { docType: "document", slots: slots("purpose", "keyInformation", "limitations") }).current, true);
  assert.equal(understandingFit("research-protocol", { docType: "research-protocol", slots: slots("purpose", "steps", "checks") }).current, true);
  assert.equal(understandingFit("note-memo", { docType: "note-memo", slots: slots("topic", "decisions") }).current, true);
  // No record of the type it was made under: judged by its slots alone.
  assert.equal(understandingFit("document", { slots: slots("purpose") }).current, true);
  assert.equal(understandingFit("document", {}).current, true);
});

test("a reading is outdated when it carries a slot its type does not have, or was made under another schema", () => {
  const product = understandingFit("document", { docType: "document", slots: slots("design", "population", "interventionExposure", "purpose") });
  assert.deepEqual([product.current, product.schema, product.extra], [false, false, ["design", "population", "interventionExposure"]]);
  // A paper's slots on a policy document; and a general reading of what has since been named a paper (or the other way round).
  assert.equal(understandingFit("policy-document", { docType: "policy-document", slots: slots("outcomes") }).current, false);
  const retyped = understandingFit("published-paper", { docType: "document", slots: slots("purpose", "keyInformation") });
  assert.deepEqual([retyped.current, retyped.schema, retyped.extra.length > 0], [false, true, true]);
  const demoted = understandingFit("document", { docType: "published-paper", slots: slots("question") });
  assert.deepEqual([demoted.current, demoted.schema], [false, true]);
  // A type this vocabulary no longer knows reads with the general schema.
  assert.equal(understandingFit("audio-recording", { docType: "audio-recording", slots: slots("purpose") }).current, true);
});

/** A database that answers the candidate query with these rows, and a ledger that holds these understandings. */
function ledger(rows, understandings) {
  return {
    database: { query: async (text, values) => { assert.match(text, /kind='source'/); return { rows: values[0] ? rows.filter((row) => values[0].includes(row.user_id)) : rows }; } },
    documents: { get: async (_userId, kind, id) => { assert.equal(kind, "knowledge"); return understandings[id] ?? null; } },
  };
}
const candidate = (id, docType, over = {}) => ({ user_id: "u1", id, project_id: "p1", revision: 3, doc_type: docType, understanding_id: `understanding:${id}:g1`, path: `knowledge-base/${id}.pdf`, connector: "upload", ...over });
const understanding = (id, output) => ({ [`understanding:${id}:g1`]: { payload: { recordType: "source-understanding", sourceId: id, output } } });

test("a pass reports the outdated sources by id with what made them so, skips pages the platform compiled, and reads nothing it does not need", async () => {
  const rows = [candidate("src_product", "document"), candidate("src_paper", "published-paper"), candidate("src_ok", "document"), candidate("src_wiki", "document", { path: "knowledge-base/wiki/index.md", connector: "internal" }),
    candidate("src_other", "document", { user_id: "u2" })];
  const held = {
    ...understanding("src_product", { docType: "document", slots: slots("design", "purpose") }),
    ...understanding("src_paper", { docType: "published-paper", slots: slots("design", "doi") }),
    ...understanding("src_ok", { docType: "document", slots: slots("purpose") }),
    ...understanding("src_wiki", { docType: "document", slots: slots("design") }),
    ...understanding("src_other", { docType: "document", slots: slots("design") }),
  };
  const found = await outdatedUnderstandings({ ...ledger(rows, held), userIds: ["u1"] });
  assert.equal(found.scanned, 3, "the compiled page is not scanned, nor another account's source");
  assert.deepEqual(found.outdated.map((item) => [item.sourceId, item.extra, item.schema, item.revision]), [["src_product", ["design"], false, 3]]);
  assert.deepEqual((await outdatedUnderstandings({ ...ledger(rows, held), userIds: null })).outdated.map((item) => item.sourceId), ["src_product", "src_other"]);
});

test("applying asks for a new reading through the source service's retry, at the revision it read, at most `limit` of them, and says what it did not do", async () => {
  const asked = [];
  const sources = { retry: async (userId, sourceId, input) => {
    asked.push([userId, sourceId, input.expectedRevision]);
    if (sourceId === "src_moved") throw Object.assign(new Error("moved"), { code: "source_revision_conflict" });
    return {};
  } };
  const outdated = ["src_a", "src_moved", "src_b", "src_c"].map((sourceId) => ({ userId: "u1", projectId: "p1", sourceId, revision: 4, docType: "document", schema: false, extra: ["design"] }));
  const result = await requeueOutdated({ sources }, outdated, { limit: 2 });
  assert.deepEqual(asked, [["u1", "src_a", 4], ["u1", "src_moved", 4], ["u1", "src_b", 4]], "the limit counts what was queued: a refused one does not use it up");
  assert.deepEqual([result.queued, result.left, result.failed], [["src_a", "src_b"], 1, [{ sourceId: "src_moved", code: "source_revision_conflict" }]]);
});
