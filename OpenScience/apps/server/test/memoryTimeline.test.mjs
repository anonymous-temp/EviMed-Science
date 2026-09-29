// 「时间轴」 is derived when read: every event below comes from a record that
// already has an owner, so nothing here writes, and nothing can be missing
// because a writer forgot.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  MEMORY_GROWTH_MONTHS, MEMORY_TIMELINE_RECORDS, createMemoryTimelineRoutes, feedbackTimelineEvents, growthBuckets, memoryGrowth, memoryTimeline,
  methodEvents, recordEvents, runEvents,
} from "../src/memoryTimeline.mjs";
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

test("a page never ends inside one instant: events stamped in the same millisecond are all on one page", async () => {
  // Three memories written in one millisecond (one import, one transaction)
  // and an older one. The next page is "strictly before the last time
  // shown", so a page cut after the first of the three put the other two on
  // neither page.
  const records = [
    record({ id: "rec_a", key: "a", createdAt: "2026-09-10T00:00:00.123Z" }),
    record({ id: "rec_b", key: "b", createdAt: "2026-09-10T00:00:00.123Z" }),
    record({ id: "rec_c", key: "c", createdAt: "2026-09-10T00:00:00.123Z" }),
    record({ id: "rec_d", key: "d", createdAt: "2026-09-01T00:00:00Z" }),
  ];
  const read = { researchMemory: { configured: true, timelineRecords: async () => records }, now: () => new Date("2026-09-20T00:00:00Z") };
  /** @type {string[]} */
  const seen = [];
  let before = null;
  for (let page = 0; page < 5; page += 1) {
    const result = await memoryTimeline(read, user, project, { limit: 1, before });
    seen.push(...result.items.map((item) => item.id));
    before = result.nextBefore;
    if (!before) break;
  }
  assert.deepEqual(seen, ["memory:rec_c:created", "memory:rec_b:created", "memory:rec_a:created", "memory:rec_d:created"],
    "every event exactly once, newest first");
  const first = await memoryTimeline(read, user, project, { limit: 1 });
  assert.equal(first.items.length, 3, "the page runs on to the end of its last instant");
  assert.equal(first.nextBefore, "2026-09-10T00:00:00.123Z");
  const last = await memoryTimeline(read, user, project, { limit: 3 });
  assert.equal(last.items.length, 3);
  assert.equal(last.nextBefore, "2026-09-10T00:00:00.123Z", "an instant that exactly fills a page still has a next page");
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

// 「成长」: the capsule page's one chart. It counts the rows the page lists,
// from the day each began to hold to the day it stopped, over every one of
// them — never a page of a list.

/**
 * A product document store as the growth read uses it: pages of at most
 * `limit`, newest first, a filter matched on the payload, and a cursor.
 * @param {Record<string, any[]>} byKind
 */
function documentStore(byKind) {
  /** @type {Array<{ kind: string, filter: any, fields: any }>} */
  const asked = [];
  return {
    asked,
    /** @param {string} _userId @param {string} kind @param {any} options */
    async list(_userId, kind, { limit, cursor = null, filter = {}, fields } = {}) {
      asked.push({ kind, filter, fields });
      const matching = (byKind[kind] ?? []).filter((item) => Object.entries(filter).every(([key, value]) => item.payload?.[key] === value));
      const from = cursor ? Number(cursor) : 0;
      const items = matching.slice(from, from + limit);
      return { items, nextCursor: from + limit < matching.length ? String(from + limit) : null };
    },
  };
}

test("the line is weekly for a short history, monthly for a long one, and starts at zero when the whole history fits", () => {
  // 2026-09-10 is a Thursday; its week starts on Monday 09-07.
  assert.deepEqual(growthBuckets("2026-09-10", "2026-09-28"), {
    unit: "week", starts: ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"],
  });
  assert.deepEqual(growthBuckets("2026-09-28", "2026-09-28"), { unit: "week", starts: ["2026-09-21", "2026-09-28"] });
  const months = growthBuckets("2026-01-15", "2026-09-28");
  assert.equal(months.unit, "month");
  assert.deepEqual([months.starts[0], months.starts.at(-1), months.starts.length], ["2025-12-01", "2026-09-01", 10]);
  const long = growthBuckets("2020-03-02", "2026-09-28");
  assert.equal(long.starts.length, MEMORY_GROWTH_MONTHS + 1, "the furthest back it reaches is two years");
  assert.equal(long.starts.at(-1), "2026-09-01");
});

function growthSources({ failMethods = false } = {}) {
  const learning = { documents: documentStore({
    method: [
      { id: "method:learned:grade", createdAt: "2026-09-16T02:00:00Z", updatedAt: "2026-09-16T02:00:00Z",
        payload: { recordType: "learned-method", status: "approved", provenance: { origin: "inferred" },
          display: { title: "Meta 分析先报 GRADE 再报效应量", summary: "先给证据确定性，再给效应量。" } } },
      { id: "method:learned:gone", createdAt: "2026-09-08T02:00:00Z", updatedAt: "2026-09-20T02:00:00Z",
        payload: { recordType: "learned-method", status: "retired", statusChangedAt: "2026-09-20T02:00:00Z", provenance: { origin: "inferred" },
          frontmatter: { name: "screen-in-batches" } } },
    ],
  }) };
  if (failMethods) learning.documents.list = async () => { throw new Error("product store"); };
  const notes = Array.from({ length: 150 }, (_, index) => ({ id: `note_${index}`, createdAt: "2026-09-22T02:00:00Z", updatedAt: "2026-09-22T02:00:00Z",
    payload: { capsuleId: "cap_own", status: "approved", layer: "knowledge" } }));
  const capsules = { documents: documentStore({
    capsule: [
      { id: "cap_own", createdAt: "2026-09-01T00:00:00Z", payload: { title: "我的胶囊" } },
      { id: "cap_li", createdAt: "2026-09-23T00:00:00Z", payload: { imported: true, title: "李主任的工作方式", transfer: { importedAt: "2026-09-24T03:00:00Z" } } },
    ],
    fact: [
      ...notes,
      // A document's facts are the document's, and a note waiting for review is not on the page.
      { id: "note_source", createdAt: "2026-09-22T02:00:00Z", payload: { capsuleId: "cap_own", status: "approved", layer: "sources" } },
      { id: "note_waiting", createdAt: "2026-09-22T02:00:00Z", payload: { capsuleId: "cap_own", status: "candidate", layer: "knowledge" } },
      { id: "note_retired", createdAt: "2026-09-15T02:00:00Z", updatedAt: "2026-09-17T02:00:00Z", payload: { capsuleId: "cap_own", status: "retired", layer: "methods" } },
      // What someone else's capsule holds is theirs, not a row of this page.
      { id: "pack_note", createdAt: "2026-09-24T03:00:00Z", payload: { capsuleId: "cap_li", status: "approved", layer: "methods" } },
    ],
  }) };
  /** @type {any[]} */ const zones = [];
  const researchMemory = { configured: true, growthDays: async (/** @type {string} */ _userId, /** @type {any} */ options) => {
    zones.push(options.timeZone);
    return [
      { day: "2026-09-10", added: 3, ended: 0 },
      // A fact replaced on 09-15 by a new one: one ended, one added, the line flat.
      { day: "2026-09-15", added: 1, ended: 1 },
      { day: "2026-09-21", added: 0, ended: 2 },
    ];
  } };
  return { researchMemory, learning, capsules, zones, now: () => new Date("2026-09-28T04:00:00Z") };
}

test("each point is what the page listed at the end of its week, a moment is a method learned or a capsule received", async () => {
  const sources = growthSources();
  const growth = await memoryGrowth(sources, user, { timeZone: "Asia/Shanghai" });
  assert.equal(growth.unit, "week");
  assert.equal(growth.first, "2026-09-08", "the retired method was the first row");
  assert.equal(growth.fromStart, true);
  assert.deepEqual(growth.points, [
    { start: "2026-08-31", known: 0 },
    // 3 memories and the method learned on 09-08.
    { start: "2026-09-07", known: 4 },
    // + the GRADE method, − the method stood down on 09-20; the replaced fact
    // is carried by its replacement; a note came and went.
    { start: "2026-09-14", known: 4 },
    // − two forgotten memories, + 150 notes.
    { start: "2026-09-21", known: 152 },
    { start: "2026-09-28", known: 152 },
  ]);
  assert.deepEqual(growth.moments, [
    { day: "2026-09-08", kind: "method", title: "screen-in-batches" },
    { day: "2026-09-16", kind: "method", title: "Meta 分析先报 GRADE 再报效应量" },
    { day: "2026-09-24", kind: "capsule", title: "李主任的工作方式" },
  ]);
  assert.deepEqual(sources.zones, ["Asia/Shanghai"], "the memories are grouped by day in the researcher's zone");
  // Every note was read, not the first page of them.
  const factReads = sources.capsules.documents.asked.filter((read) => read.kind === "fact");
  assert.equal(factReads.length, 2, "two pages of the own capsule, none of the received one");
  assert.ok(factReads.every((read) => read.filter.capsuleId === "cap_own"));
  // The methods are read light: never a method's whole body.
  const methodRead = sources.learning.documents.asked.find((read) => read.kind === "method");
  assert.equal(methodRead?.fields?.body, undefined);
  assert.ok(methodRead?.fields, "a projection, not the whole document");
  assert.deepEqual(methodRead?.filter, { recordType: "learned-method" });
});

test("an account with nothing has no line, a bad zone is refused, and a source that cannot be read fails the read", async () => {
  const empty = await memoryGrowth({ researchMemory: { growthDays: async () => [] }, now: () => new Date("2026-09-28T00:00:00Z") }, user, {});
  assert.deepEqual(empty, { unit: null, first: null, fromStart: false, points: [], moments: [], timeZone: "Asia/Shanghai" });
  await assert.rejects(() => memoryGrowth(growthSources(), user, { timeZone: "Mars/Olympus" }), { code: "memory_timeline_invalid" });
  // A line missing the methods would look exactly like a true one.
  await assert.rejects(() => memoryGrowth(growthSources({ failMethods: true }), user, {}), /product store/);
});

test("a long history is counted in months and reaches back at most two years, carrying what held before it", async () => {
  const growth = await memoryGrowth({
    researchMemory: { growthDays: async () => [{ day: "2023-05-04", added: 7, ended: 0 }, { day: "2026-08-20", added: 2, ended: 1 }] },
    now: () => new Date("2026-09-28T04:00:00Z"),
  }, user, { timeZone: "UTC" });
  assert.equal(growth.unit, "month");
  assert.equal(growth.fromStart, false);
  assert.equal(growth.points.length, MEMORY_GROWTH_MONTHS + 1);
  assert.deepEqual(growth.points[0], { start: "2024-09-01", known: 7 });
  assert.deepEqual(growth.points.slice(-2), [{ start: "2026-08-01", known: 8 }, { start: "2026-09-01", known: 8 }]);
});

test("the growth route answers its own path, read-only", async (t) => {
  const sources = growthSources();
  const routes = createMemoryTimelineRoutes({ ...sources, config: {}, context: async () => ({ user, project }) });
  const server = createServer((req, res) => {
    routes(req, res).then((handled) => { if (!handled) { res.statusCode = 404; res.end(); } }).catch((error) => sendError(res, error));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const growth = await (await fetch(`${base}/api/memory/growth?timeZone=UTC`)).json();
  assert.equal(growth.data.unit, "week");
  assert.equal(growth.data.timeZone, "UTC");
  assert.equal(growth.data.points.at(-1).known, 152);
  assert.equal((await fetch(`${base}/api/memory/growth`, { method: "DELETE" })).status, 405);
  assert.equal((await fetch(`${base}/api/memory/growth?timeZone=Mars%2FOlympus`)).status, 400);
});
