// The first round of a project whose documents were there before anything asked for one (2026-10-14, production: one document,
// uploaded before the compile existed, `wiki:state` untouched at round 1 with no `compiledAt`, no job of any kind). No document
// turns readable and no person presses a button, so the periodic pass reads the ledger and queues the round by itself — once,
// and never for a project that has compiled, is compiling, has pages, failed, or has nothing to compile.
import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgePageService } from "../src/knowledgePageService.mjs";
import { KnowledgePageWorker } from "../src/knowledgePageWorker.mjs";

const NOW = new Date("2026-10-14T08:00:00Z");

/** In-memory stand-ins for the ledger's documents and the job queue, holding what a real pass would read and write. */
function fixture({ readable = [], pages = [], state = null, minSources = 1, enabled = true } = {}) {
  const rows = new Map();
  if (state) rows.set("wiki:state:p1", { revision: 1, payload: { projectId: "p1", ...state } });
  const jobs = [];
  const documents = {
    get: async (_userId, _kind, id) => rows.get(id) ?? null,
    put: async (_userId, _kind, id, payload, { expectedRevision }) => {
      const held = rows.get(id);
      if ((held?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error("moved"), { code: "product_revision_conflict" });
      rows.set(id, { revision: expectedRevision + 1, payload });
    },
    list: async () => ({ items: pages.map((path) => ({ id: `page:${path}`, payload: { recordType: "wiki-page", tree: "wiki", path } })), nextCursor: null }),
  };
  const queue = {
    enqueue: async (userId, kind, payload, options) => {
      const held = jobs.find((job) => job.idempotencyKey === options.idempotencyKey);
      if (held) return held;
      const job = { userId, kind, payload, ...options };
      jobs.push(job);
      return job;
    },
    bringForward: async () => true,
  };
  const sources = { list: async () => ({ items: readable.map((id) => ({ id, projectId: "p1", deletedAt: null, payload: { paths: [`knowledge-base/uploads/${id}.pdf`], connector: { type: "upload" } } })), nextCursor: null }) };
  const service = new KnowledgePageService({
    config: { ovKnowledgeEnabled: true, knowledgePagesMinSources: minSources, knowledgePagesDebounceMs: 600_000 },
    documents, jobs: queue, sources, store: {}, resources: { configured: enabled }, entries: {}, now: () => NOW,
  });
  return { service, rows, jobs };
}

test("a project whose one readable document predates the compile gets its first round queued, after the usual quiet period, by the periodic pass", async () => {
  const { service, rows, jobs } = fixture({ readable: ["src_a"], state: { round: 1, pending: {}, lastChangeAt: null, compiledAt: null, lastRound: null, lastError: null, run: null } });
  const summary = await service.catchUpAll({ projects: async () => [{ userId: "u1", projectId: "p1" }] });
  assert.deepEqual([summary.projects, summary.scheduled, summary.error], [1, 1, null]);
  assert.equal(jobs.length, 1);
  assert.deepEqual([jobs[0].kind, jobs[0].payload, jobs[0].idempotencyKey], ["wiki-compile", { projectId: "p1", round: 1 }, "wiki-compile:p1:1"]);
  assert.equal(jobs[0].runAfter.getTime(), NOW.getTime() + 600_000, "the round waits the quiet period, as one a fresh upload asks for does");
  assert.deepEqual(rows.get("wiki:state:p1").payload.pending, { catchUp: "added" }, "the status reads 'queued', not 'idle'");
  // A second pass finds the round already asked for: the same job, nothing new.
  assert.equal(await service.catchUp("u1", "p1"), "waiting");
  assert.equal(jobs.length, 1);
});

test("a project that has no state record at all is read as untouched, and a closed round below an older threshold is asked again", async () => {
  const none = fixture({ readable: ["src_a", "src_b"] });
  assert.equal(await none.service.catchUp("u1", "p1"), "scheduled");
  assert.equal(none.jobs.length, 1);
  // The round the threshold of five closed (round 2, nothing produced) is asked again now that one document is enough.
  const closed = fixture({ readable: ["src_a"], state: { round: 2, pending: {}, compiledAt: null, lastRound: null, lastError: null, run: null } });
  assert.equal(await closed.service.catchUp("u1", "p1"), "scheduled");
  assert.equal(closed.jobs[0].idempotencyKey, "wiki-compile:p1:2");
});

test("nothing is queued for a project with no readable document, one that compiled, one that failed, one with pages, or one still running", async () => {
  const states = {
    empty: [{ readable: [], state: { round: 1, pending: {} } }, "skipped"],
    compiled: [{ readable: ["src_a"], state: { round: 3, pending: {}, compiledAt: "2026-10-13T00:00:00Z", lastRound: { at: "x" } } }, "skipped"],
    failed: [{ readable: ["src_a"], state: { round: 3, pending: {}, lastError: { code: "knowledge_compile_failed" } } }, "skipped"],
    typed: [{ readable: ["src_a"], state: { round: 2, pending: {}, pages: { wiki: 4, kg: 0 } } }, "skipped"],
    mirrored: [{ readable: ["src_a"], pages: ["index.md"], state: { round: 1, pending: {} } }, "skipped"],
    running: [{ readable: ["src_a"], state: { round: 1, pending: { src_a: "added" }, run: { step: "wiki" } } }, "waiting"],
  };
  for (const [name, [setup, expected]] of Object.entries(states)) {
    const held = fixture(setup);
    assert.equal(await held.service.catchUp("u1", "p1"), expected, name);
    assert.equal(held.jobs.length, 0, `${name}: no job`);
  }
});

test("a threshold above the number of readable documents still holds for an operator who sets one", async () => {
  const held = fixture({ readable: ["src_a", "src_b"], minSources: 3, state: { round: 1, pending: {} } });
  assert.equal(await held.service.catchUp("u1", "p1"), "skipped");
  assert.equal(held.jobs.length, 0);
});

test("a deployment with the compile off queues nothing", async () => {
  const held = fixture({ readable: ["src_a"], enabled: false, state: { round: 1, pending: {} } });
  assert.deepEqual(await held.service.catchUpAll({ projects: async () => [{ userId: "u1", projectId: "p1" }] }), { at: NOW.toISOString(), projects: 0, scheduled: 0, error: null });
  assert.equal(held.jobs.length, 0);
});

test("one project failing is its own: the others are still looked at, and the failure is reported by code", async () => {
  const held = fixture({ readable: ["src_a"], state: { round: 1, pending: {} } });
  const reported = [];
  held.service.report = (code) => reported.push(code);
  const broken = held.service.catchUp.bind(held.service);
  held.service.catchUp = async (userId, projectId) => { if (projectId === "bad") throw Object.assign(new Error("x"), { code: "product_unavailable" }); return broken(userId, projectId); };
  const summary = await held.service.catchUpAll({ projects: async () => [{ userId: "u1", projectId: "bad" }, { userId: "u1", projectId: "p1" }] });
  assert.deepEqual([summary.projects, summary.scheduled], [2, 1]);
  assert.deepEqual(reported, ["product_unavailable"]);
});

test("the worker makes the pass on its own timer, once at a time, and a worker given no projects makes none", async () => {
  const held = fixture({ readable: ["src_a"], state: { round: 1, pending: {} } });
  let calls = 0;
  const projects = async () => { calls += 1; return [{ userId: "u1", projectId: "p1" }]; };
  const worker = new KnowledgePageWorker({ jobs: {}, service: held.service, projects, catchUpMs: 3_600_000, firstCatchUpMs: 3_600_000 });
  const first = worker.catchUp();
  assert.equal(worker.catchUp(), first, "a pass under way is the answer to a second ask");
  await first;
  assert.equal(calls, 1);
  assert.deepEqual([worker.status().lastCatchUp.scheduled, held.jobs.length], [1, 1]);
  await worker.close();
  const bare = new KnowledgePageWorker({ jobs: {}, service: held.service });
  assert.equal(bare.catchUp(), null);
  await bare.close();
});
