// What a researcher can do to a capability handbook from the memory page: read
// the list and one handbook whole, see the versions it has held, stop it, bring
// it back, and go back to the version before. Against the in-memory ledger, with
// the real learning loop applying the handbooks.
import assert from "node:assert/strict";
import test from "node:test";
import { HandbookConsolidation } from "../src/handbookConsolidation.mjs";
import { HandbookLibrary } from "../src/handbookLibrary.mjs";
import { createHandbookRoutes, handbookView } from "../src/handbookRoutes.mjs";
import { fixture, registry } from "./helpers/handbookFixture.mjs";

/** A handbook applied by the real loop, with its steps in the researcher's language and a title written for them. */
async function applied(f, loop, overrides = {}) {
  const input = f.input(overrides);
  await f.learning.recordHandbookCandidate("alice", { ...input, display: { title: "引用核对要逐条对应", summary: "正文每处引用都对应文献表里的一条。" },
    steps: "1. 把每个引用标记对应到文献表\n2. 列出没有对应的标记" });
  const job = f.queued.at(-1);
  const result = await loop.run({ job });
  return f.documents.get("alice", "method", result.handbookId);
}

test("a handbook is listed with the title and sentence written for the researcher, and read whole with its steps", async () => {
  const f = fixture();
  const loop = new HandbookConsolidation({ ...f, registry });
  const library = new HandbookLibrary({ learning: f.learning });
  const handbook = await applied(f, loop);

  const page = await library.list("alice");
  assert.deepEqual(page.items.map((item) => item.id), [handbook.id]);
  const view = handbookView(page.items[0]);
  assert.equal(view.title, "引用核对要逐条对应");
  assert.equal(view.summary, "正文每处引用都对应文献表里的一条。");
  assert.equal(view.capabilityId, "geo-content");
  assert.equal(view.status, "active");
  assert.deepEqual(view.source, { projectId: "source-project", sessionId: null });
  assert.equal("body" in view, false, "the row carries no body; the drawer reads it whole");

  // The steps travel with the handbook once applied, and are found on the candidate for one applied before they did.
  assert.equal(await library.stepsOf("alice", handbook), "1. 把每个引用标记对应到文献表\n2. 列出没有对应的标记");
  const { displaySteps: _steps, ...older } = handbook.payload;
  assert.equal(await library.stepsOf("alice", { ...handbook, payload: older }), "1. 把每个引用标记对应到文献表\n2. 列出没有对应的标记");
  // Steps that render another body are not shown for this one.
  assert.equal(await library.stepsOf("alice", { ...handbook, payload: { ...older, contentDigest: "sha256:other" } }), null);

  await assert.rejects(library.get("bob", handbook.id), { code: "handbook_unavailable" });
  assert.deepEqual((await library.list("bob")).items, []);
  await assert.rejects(library.list("alice", { status: "queued" }), { code: "handbook_status_invalid" });
});

test("the versions a handbook has held are its bodies, newest first, and going back saves the earlier one forward", async () => {
  const f = fixture();
  const loop = new HandbookConsolidation({ ...f, registry });
  const library = new HandbookLibrary({ learning: f.learning });
  const first = await applied(f, loop);
  // Use counters move the revision without saving history; they are not a version.
  await f.documents.put("alice", "method", first.id, first.payload, { expectedRevision: first.revision, telemetry: true });
  await f.learning.recordHandbookCandidate("alice", { ...f.input({ body: `${first.payload.body}\nA second body.` }), display: { title: "引用核对要逐条对应", summary: "更新后的句子。" } });
  await loop.run({ job: f.queued.at(-1) });
  const second = await f.documents.get("alice", "method", first.id);

  const versions = await library.history("alice", first.id);
  assert.deepEqual(versions.map((item) => [item.version, item.current]), [[2, true], [1, false]]);
  assert.equal(versions[1].summary, "正文每处引用都对应文献表里的一条。");
  assert.equal(versions[1].steps, "1. 把每个引用标记对应到文献表\n2. 列出没有对应的标记");
  assert.equal(versions[0].steps, null);
  assert.ok(versions[0].body.includes("A second body."), "a version with no steps shows its text, so it can still be read");

  const restored = await library.rollback("alice", first.id, { expectedRevision: second.revision, targetRevision: versions[1].revision });
  assert.equal(restored.payload.body, first.payload.body);
  assert.equal(restored.payload.status, "active");
  assert.deepEqual(restored.payload.observations, [], "use counts belong to the version they were counted on");
  // Going back is a new version holding the old text, as it is for a learned method; nothing is deleted.
  assert.deepEqual((await library.history("alice", first.id)).map((item) => [item.version, item.current]), [[3, true], [2, false], [1, false]]);
  await assert.rejects(library.rollback("alice", first.id, { expectedRevision: second.revision, targetRevision: versions[1].revision }), { code: "product_revision_conflict" });
  await assert.rejects(library.rollback("alice", first.id, { expectedRevision: restored.revision, targetRevision: restored.revision }), { code: "handbook_revision_unavailable" });
});

test("a handbook that is stopped is no longer used, stays readable under 已忘记的内容, and is brought back by restoring", async () => {
  const f = fixture();
  const loop = new HandbookConsolidation({ ...f, registry });
  const library = new HandbookLibrary({ learning: f.learning });
  const handbook = await applied(f, loop);

  const stopped = await library.retire("alice", handbook.id, { expectedRevision: handbook.revision, reason: "在记忆页里停用" });
  assert.equal(stopped.payload.status, "retired");
  assert.deepEqual((await library.list("alice")).items, [], "every reader of handbooks asks for the ones in force");
  assert.deepEqual((await library.list("alice", { status: "retired" })).items.map((item) => item.id), [handbook.id]);

  // The undo of stopping is the revision before it, which is what the page names.
  const back = await library.rollback("alice", handbook.id, { expectedRevision: stopped.revision, targetRevision: stopped.revision - 1 });
  assert.equal(back.payload.status, "active");
  assert.equal(back.payload.body, handbook.payload.body);
  assert.deepEqual((await library.list("alice")).items.map((item) => item.id), [handbook.id]);
  await assert.rejects(library.retire("bob", handbook.id, { expectedRevision: back.revision }), { code: "handbook_unavailable" });
});

test("a lesson of the name a researcher stopped does not put the handbook back in force", async () => {
  const f = fixture();
  const loop = new HandbookConsolidation({ ...f, registry });
  const library = new HandbookLibrary({ learning: f.learning });
  const handbook = await applied(f, loop);
  const stopped = await library.retire("alice", handbook.id, { expectedRevision: handbook.revision });
  await f.learning.recordHandbookCandidate("alice", f.input({ body: `${handbook.payload.body}\nA later lesson.` }));
  const result = await loop.run({ job: f.queued.at(-1) });
  assert.equal(result.disposition, "rejected");
  assert.equal(result.reason, "handbook_retired_by_owner");
  assert.equal((await f.documents.get("alice", "method", handbook.id)).revision, stopped.revision, "nothing was written over it");
});

test("the routes read, stop and go back for the signed-in account and answer by name when there is no store", async () => {
  const f = fixture();
  const loop = new HandbookConsolidation({ ...f, registry });
  const library = new HandbookLibrary({ learning: f.learning });
  const handbook = await applied(f, loop);
  const store = { async ensureSessionUser() { return { user: { id: "alice" } }; }, async assertCsrf() {} };
  const routes = createHandbookRoutes({ store, library, maxJsonBytes: 10_000,
    resolveRun: async (_user, projectId, runId) => (projectId === "source-project" && runId === "source-run"
      ? { id: runId, sessionId: "ses_9", title: "儿童疳证中医药新证据", finishedAt: "2026-09-22T08:00:00.000Z" } : null) });
  /** @param {string} method @param {string} url @param {any} [body] */
  const call = async (method, url, body) => {
    /** @type {{ status: number, body: any }} */
    const out = { status: 0, body: null };
    const text = body === undefined ? "" : JSON.stringify(body);
    const req = Object.assign((async function* () { if (text) yield Buffer.from(text); })(), { url, method, headers: { "content-type": "application/json" } });
    const res = { statusCode: 200, setHeader() {}, writeHead(/** @type {number} */ status) { out.status = status; return this; }, end(/** @type {string} */ value) { out.body = JSON.parse(value); } };
    const handled = await routes(req, res);
    assert.equal(handled, true);
    return out;
  };

  const list = await call("GET", "/api/handbooks");
  assert.equal(list.status, 200);
  assert.equal(list.body.data.items[0].title, "引用核对要逐条对应");
  const id = encodeURIComponent(handbook.id);
  const detail = await call("GET", `/api/handbooks/${id}`);
  assert.equal(detail.body.data.steps, "1. 把每个引用标记对应到文献表\n2. 列出没有对应的标记");
  assert.deepEqual(detail.body.data.sources, [{ projectId: "source-project", sessionId: "ses_9", title: "儿童疳证中医药新证据", at: "2026-09-22T08:00:00.000Z" }]);
  assert.deepEqual((await call("GET", `/api/handbooks/${id}/history`)).body.data.items.map((item) => item.version), [1]);
  const retired = await call("POST", `/api/handbooks/${id}/retire`, { expectedRevision: handbook.revision });
  assert.equal(retired.body.data.status, "retired");
  assert.equal((await call("GET", "/api/handbooks")).body.data.items.length, 0);
  assert.equal((await call("GET", "/api/handbooks?status=retired")).body.data.items.length, 1);
  await assert.rejects(call("POST", `/api/handbooks/${id}/retire`, { expectedRevision: handbook.revision, surprise: true }), { code: "handbook_payload_invalid" });
  await assert.rejects(call("GET", "/api/handbooks/nothing-here"), { code: "handbook_unavailable" });

  const without = createHandbookRoutes({ store, library: null, maxJsonBytes: 10_000 });
  await assert.rejects(without({ url: "/api/handbooks", method: "GET", headers: {} }, {}), { code: "handbook_store_unavailable" });
  assert.equal(await routes({ url: "/api/methods", method: "GET", headers: {} }, {}), false);
});
