// 「时间轴」 is derived when read: every event below comes from a record that
// already has an owner, so nothing here writes, and nothing can be missing
// because a writer forgot.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { MEMORY_TIMELINE_RECORDS, createMemoryTimelineRoutes, feedbackTimelineEvents, memoryTimeline, methodEvents, recordEvents, runEvents } from "../src/memoryTimeline.mjs";
import { sendError } from "../src/security.mjs";

const user = { id: "usr_1" };
const project = { id: "prj_1", userId: "usr_1" };

function record(overrides = {}) {
  return {
    id: "rec_1", scope: "user", scopeId: "", kind: "preference", key: "evidence.design", value: "只看 RCT", summary: "只看 RCT",
    origin: "explicit", status: "active", version: 1, createdAt: "2026-08-01T01:00:00Z", updatedAt: "2026-08-01T01:00:00Z",
    supersededBy: null, invalidSince: null, provenance: { basis: "stated", observations: 1, runs: 1, conversations: 1 }, revisions: [],
    ...overrides,
  };
}

test("a memory's history is its writing, each revision with who made it, and 「曾经如此」 when it was replaced", () => {
  const edited = record({
    value: "RCT 优先，接受高质量队列", summary: "RCT 优先，接受高质量队列", version: 3, updatedAt: "2026-09-17T01:00:00Z",
    revisions: [
      { version: 1, value: "只看 RCT", summary: "只看 RCT", status: "active", changedAt: "2026-09-10T01:00:00Z", reason: "extracted", by: "extraction", runId: "run_7" },
      { version: 2, value: "RCT 优先", summary: "RCT 优先", status: "active", changedAt: "2026-09-17T01:00:00Z", reason: "user updated", by: "user" },
    ],
  });
  const events = recordEvents(edited);
  assert.deepEqual(events.map((event) => [event.change, event.before ?? null, event.after, event.by ?? null]), [
    ["created", null, "只看 RCT", null],
    ["updated", "只看 RCT", "RCT 优先", "extraction"],
    ["updated", "RCT 优先", "RCT 优先，接受高质量队列", "user"],
  ]);
  assert.equal(events[1].runId, "run_7", "the run that taught it");

  const replacement = record({ id: "rec_2", key: "dose.warfarin", kind: "project_fact", value: "华法林 3 mg", summary: "华法林 3 mg" });
  const old = record({
    id: "rec_old", key: "dose.warfarin.old", kind: "project_fact", value: "华法林 2.5 mg", summary: "华法林 2.5 mg", status: "superseded",
    supersededBy: "rec_2", invalidSince: "2026-09-15T00:00:00Z", version: 2,
    revisions: [{ version: 1, value: "华法林 2.5 mg", summary: "华法林 2.5 mg", status: "active", changedAt: "2026-09-15T00:00:00Z", reason: "superseded", by: "extraction" }],
  });
  const superseded = recordEvents(old, new Map([["rec_2", replacement]]));
  assert.deepEqual(superseded.map((event) => event.change), ["created", "superseded"],
    "a supersession is told once, with the fact that replaced it");
  assert.equal(superseded[1].before, "华法林 2.5 mg");
  assert.equal(superseded[1].after, "华法林 3 mg");
  assert.equal(superseded[1].wasTrue, true);
  assert.equal(superseded[1].at, "2026-09-15T00:00:00.000Z");

  const archived = record({ status: "archived", version: 2,
    revisions: [{ version: 1, value: "只看 RCT", summary: "只看 RCT", status: "active", changedAt: "2026-09-12T00:00:00Z", reason: "", by: "user" }] });
  assert.equal(recordEvents(archived)[1].change, "archived");
  assert.deepEqual(recordEvents(record({ kind: "run_summary" })), [], "a run summary is the run's event, not a memory's");
});

test("runs, methods and the researcher's own acts are events; the platform's own runs are not", () => {
  assert.deepEqual(runEvents({ id: "run_1", status: "succeeded", title: "阿司匹林一级预防", finishedAt: "2026-09-18T02:00:00Z",
    recalledMemories: [{ id: "a" }, { id: "b" }, { id: "c" }], methodsLoaded: [{ name: "m" }] }).map((event) => [event.title, event.recalled, event.methods]),
  [["阿司匹林一级预防", 3, 1]]);
  assert.deepEqual(runEvents({ id: "run_2", status: "succeeded", automated: true, finishedAt: "2026-09-18T02:00:00Z" }), []);

  const method = { id: "mth_1", createdAt: "2026-09-10T00:00:00Z",
    payload: { status: "approved", statusChangedAt: "2026-09-16T00:00:00Z", frontmatter: { name: "证据矩阵先行" }, origin: "inferred" } };
  assert.deepEqual(methodEvents(method).map((event) => [event.change, event.name]), [["learned", "证据矩阵先行"], ["approved", "证据矩阵先行"]]);
  // Why it started is the rule, the same for every method, and was stored as
  // the rule's English sentence; why it stopped is worth its line.
  const reasoned = (status, statusReason) => methodEvents({ ...method, payload: { ...method.payload, status, statusReason } }).at(-1).reason;
  assert.equal(reasoned("approved", "learned from the researcher’s own work: it takes effect immediately"), undefined);
  assert.equal(reasoned("retired", "用上它的 3 次研究里有 3 次交付被退回，明显多于平常，已先停用。"), "用上它的 3 次研究里有 3 次交付被退回，明显多于平常，已先停用。");

  assert.deepEqual(feedbackTimelineEvents({ id: "f1", trigger: "memory-rejected", occurredAt: "2026-09-12T00:00:00Z", detail: { reason: "deleted", kind: "preference" } })
    .map((event) => event.change), ["memory-deleted"]);
  assert.deepEqual(feedbackTimelineEvents({ id: "f2", trigger: "memory-rejected", occurredAt: "2026-09-12T00:00:00Z", detail: { reason: "archived" } }), [],
    "an archive is already a revision of the record");
  assert.deepEqual(feedbackTimelineEvents({ id: "f3", trigger: "deliverable-adopted", occurredAt: "2026-09-12T00:00:00Z", runId: "run_1" })
    .map((event) => event.change), ["deliverable-adopted"]);
});

function sources({ failRuns = false } = {}) {
  const records = [
    record({ id: "rec_1", createdAt: "2026-09-01T01:00:00Z" }),
    record({ id: "rec_2", key: "k2", createdAt: "2026-09-10T16:30:00Z" }),
  ];
  return {
    researchMemory: { configured: true, timelineRecords: async () => records },
    agentRuns: { list: async () => { if (failRuns) throw new Error("ledger"); return [{ id: "run_1", status: "succeeded", title: "t", finishedAt: "2026-09-05T00:00:00Z" }]; } },
    learning: { listMethods: async () => ({ items: [{ id: "mth_1", createdAt: "2026-09-08T00:00:00Z", payload: { status: "candidate", frontmatter: { name: "m" } } }] }) },
    feedbackEvents: { list: async () => ({ items: [] }) },
    now: () => new Date("2026-09-20T00:00:00Z"),
  };
}

test("a page is newest first with a cursor, and the density band counts days in the researcher's zone", async () => {
  const first = await memoryTimeline(sources(), user, project, { limit: 2 });
  assert.deepEqual(first.items.map((item) => item.id), ["memory:rec_2:created", "method:mth_1:created"]);
  assert.equal(first.nextBefore, "2026-09-08T00:00:00.000Z");
  const second = await memoryTimeline(sources(), user, project, { limit: 2, before: first.nextBefore });
  assert.deepEqual(second.items.map((item) => item.id), ["run:run_1", "memory:rec_1:created"]);
  assert.equal(second.nextBefore, null);
  // 16:30 UTC on 9-10 is 00:30 on 9-11 in Shanghai.
  assert.equal(first.items[0].day, "2026-09-11");
  assert.ok(first.density.some((bucket) => bucket.day === "2026-09-11" && bucket.memory === 1));
  assert.equal((await memoryTimeline(sources(), user, project, { timeZone: "UTC" })).items[0].day, "2026-09-10");
  await assert.rejects(() => memoryTimeline(sources(), user, project, { timeZone: "Mars/Olympus" }), { code: "memory_timeline_invalid" });
  await assert.rejects(() => memoryTimeline(sources(), user, project, { before: "yesterday" }), { code: "memory_timeline_invalid" });

  // A source that cannot be read is named, and the rest is still the page.
  const partial = await memoryTimeline(sources({ failRuns: true }), user, project, {});
  assert.deepEqual(partial.missing, ["runs"]);
  assert.equal(partial.items.length, 3);
});

test("the memory half of a page reads the most recently changed memories of the project's view, bounded", async () => {
  // Security review 2026-09-20: every page read every memory of the account
  // whole — up to 100,000 rows of up to 100,000 characters.
  /** @type {any[]} */ const asked = [];
  const source = sources();
  source.researchMemory = { configured: true, timelineRecords: async (/** @type {string} */ userId, /** @type {any} */ options) => {
    asked.push({ userId, ...options });
    return [];
  } };
  await memoryTimeline(source, user, project, {});
  assert.deepEqual(asked, [{ userId: "usr_1", projectId: "prj_1", limit: MEMORY_TIMELINE_RECORDS }]);
  assert.ok(MEMORY_TIMELINE_RECORDS <= 5_000);
});

test("the route is read-only and answers only its own path", async (t) => {
  const routes = createMemoryTimelineRoutes({ ...sources(), config: {}, context: async () => ({ user, project }) });
  const server = createServer((req, res) => {
    routes(req, res).then((handled) => { if (!handled) { res.statusCode = 404; res.end(); } }).catch((error) => sendError(res, error));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await (await fetch(`${base}/api/memory/timeline?limit=1&timeZone=UTC`)).json();
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.timeZone, "UTC");
  assert.equal((await fetch(`${base}/api/memory/timeline`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${base}/api/memory/other`)).status, 404);
});
