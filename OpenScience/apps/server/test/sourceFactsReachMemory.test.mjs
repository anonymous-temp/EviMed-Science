// A document's understanding reaches the researcher's capsule when it is
// understood, not when somebody presses a button per file.
//
// There was a button — 「放进胶囊」, once per document, beside 「加入资料库」 —
// and it asked the researcher to do by hand the one thing the platform had just
// finished doing: the understanding was already computed, already
// quote-anchored, already theirs. Both went on 2026-09-20 (plan §3.10).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { LibraryService, PUBLICATION_RECORD_TYPE, PUBLICATION_RULE, libraryCapsuleEntries } from "../src/libraryService.mjs";

const USER = "usr_1";
const SOURCE = `src_${"a".repeat(32)}`;

const understanding = {
  generation: 1,
  summary: "非瓣膜性房颤的抗凝指南。",
  slots: { design: { state: "known", value: "随机对照试验", evidence: [{ quote: "randomised controlled trial" }] } },
  claims: [{ id: "c1", statement: "利伐沙班推荐 20 mg 每日一次", evidence: [{ quote: "rivaroxaban 20 mg once daily", start: 10, end: 38 }] }],
  methods: [{ id: "m1", title: "剂量核对", description: "按肾功能核对", steps: [], checks: [], evidence: [] }],
};

/** The product document store, reduced to what the publication path uses. */
function fixture({ understandingFor = async () => ({ current: understanding }) } = {}) {
  const rows = new Map();
  const entries = new Map();
  const added = [];
  const capsule = { id: "capsule:own", payload: { title: "我的记忆胶囊" } };
  const documents = {
    database: { async query() { return { rows: [] }; } },
    async get(_userId, kind, id) { return kind === "fact" ? entries.get(id) ?? null : rows.get(id) ?? null; },
    async put(_userId, _kind, id, payload, { expectedRevision = 0 } = {}) {
      const current = rows.get(id);
      if ((current?.revision ?? 0) !== expectedRevision) {
        throw Object.assign(new Error("conflict"), { status: 409, code: "product_revision_conflict" });
      }
      const next = { id, revision: expectedRevision + 1, payload };
      rows.set(id, next);
      return next;
    },
    async list() { return { items: [], nextCursor: null }; },
  };
  const capsules = {
    async ownCapsule() { return capsule; },
    async active() { return { items: [{ capsuleId: capsule.id, mode: "own" }] }; },
    async get() { return capsule; },
    async addEntry(_userId, capsuleId, input) {
      const id = `fact_${added.length + 1}`;
      added.push({ id, capsuleId, ...input });
      const entry = { id, revision: 1, payload: { capsuleId, status: "candidate", ...input } };
      entries.set(id, entry);
      return entry;
    },
    async updateEntry(_userId, capsuleId, id, patch) {
      const entry = entries.get(id);
      const next = { ...entry, revision: entry.revision + 1, payload: { ...entry.payload, ...patch } };
      entries.set(id, next);
      return next;
    },
  };
  const sources = {
    async get(userId, id) {
      if (userId !== USER || id !== SOURCE) throw Object.assign(new Error("gone"), { code: "source_not_found" });
      return { id: SOURCE, projectId: "prj_1", payload: { status: "complete", paths: ["knowledge-base/指南.pdf"], fingerprint: { sha256: "b".repeat(64) } } };
    },
    getUnderstanding: understandingFor,
  };
  return {
    rows, entries, added,
    library: new LibraryService({ documents, sources, capsules, libraryDir: () => "/nonexistent/library" }),
  };
}

test("the facts a document yields carry their quotes and their source, which is what the page labels 来自资料", () => {
  const written = libraryCapsuleEntries({ title: "抗凝指南", sourceId: SOURCE, understanding });
  assert.equal(written.length, 2, "the summary and the one anchored claim; no template field, no method draft");
  for (const entry of written) {
    assert.match(entry.content, /^(资料《抗凝指南》的摘要|据资料《抗凝指南》)：/);
    for (const item of entry.provenance) {
      assert.equal(item.type, "source", "the provenance the row reads 「来自资料」 from");
      assert.ok(String(item.id).startsWith(SOURCE));
    }
  }
});

test("understanding a document puts its facts in the capsule, once, with no button anywhere", async () => {
  const { library, added, rows } = fixture();
  const first = await library.publishSourceUnderstanding(USER, SOURCE);
  assert.ok(first.added > 0);
  assert.equal(first.capsuleId, "capsule:own");
  for (const entry of added) {
    assert.equal(entry.layer, "sources");
    assert.equal(entry.origin, "inferred", "the platform read it; the researcher did not say it");
    // Stamped with its document and that document's project: it is recalled
    // there and nowhere else, and the capsule page does not list it.
    assert.deepEqual(entry.derivedFrom, { sourceId: SOURCE, projectId: "prj_1" });
  }
  // The bookkeeping is keyed by the document, not by a library entry: this
  // happens to every document the platform reads.
  const ledger = rows.get(`source-publication:${SOURCE}`);
  assert.equal(ledger.payload.recordType, PUBLICATION_RECORD_TYPE);
  assert.equal(ledger.payload.sourceId, SOURCE);
  assert.equal(ledger.payload.projectId, "prj_1");
  assert.equal(ledger.payload.rule, PUBLICATION_RULE, "what the republication script reads to skip a document already current");

  // Idempotent, so the worker may call it more than once for one generation.
  const again = await library.publishSourceUnderstanding(USER, SOURCE);
  assert.equal(again.added, 0);
  assert.equal(again.kept, first.added);
});

test("a document with no understanding, and one this account does not hold, are refused by name", async () => {
  const { library } = fixture({ understandingFor: async () => ({ current: null }) });
  await assert.rejects(() => library.publishSourceUnderstanding(USER, SOURCE), { code: "library_understanding_missing" });
  await assert.rejects(() => library.publishSourceUnderstanding("usr_other", SOURCE), { code: "library_source_removed" });
  await assert.rejects(() => library.publishSourceUnderstanding(USER, "not-an-id"), { code: "library_payload_invalid" });
});

test("the button and its route are gone, and the worker's completion hook is what calls this instead", async () => {
  const { library } = fixture();
  assert.equal(typeof (/** @type {any} */ (library).publishToCapsule), "undefined");
  const source = await readFile(new URL("../src/libraryService.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /publish-to-capsule/, "no route, and no path left in the route table's own docstring");
  const server = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.match(server, /libraryService\?\.publishSourceUnderstanding\(job\.userId, job\.payload\?\.sourceId\)/,
    "the source worker's onPublished hook is the caller");
});
