// 「时间轴」 is derived when read: every event below comes from a record that
// already has an owner, so nothing here writes, and nothing can be missing
// because a writer forgot. The page, route and read that listed them are gone (2026-10-24); the map's document is made of these.
import assert from "node:assert/strict";
import test from "node:test";

import { dayOf, feedbackTimelineEvents, methodEvents, recordEvents, runEvents, timeZoneOrDefault } from "../src/memoryTimeline.mjs";

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
  // A claim's independent re-check is the platform's, whichever programme dispatched it.
  for (const effectiveRouteReason of ["autopilot-verify", "autopilot-verify:evidence"]) {
    assert.deepEqual(runEvents({ id: "run_3", status: "succeeded", effectiveRouteReason, finishedAt: "2026-09-18T02:00:00Z" }), []);
  }
  assert.equal(runEvents({ id: "run_4", status: "succeeded", effectiveRouteReason: "autopilot:literature-sentinel", finishedAt: "2026-09-18T02:00:00Z" }).length, 1);

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

test("a calendar day is the day in the researcher's zone, and a zone that does not exist is refused by name", () => {
  const format = (/** @type {string} */ timeZone) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  // 16:30 UTC on 9-10 is 00:30 on 9-11 in Shanghai.
  assert.equal(dayOf("2026-09-10T16:30:00Z", format("Asia/Shanghai")), "2026-09-11");
  assert.equal(dayOf("2026-09-10T16:30:00Z", format("UTC")), "2026-09-10");
  assert.equal(timeZoneOrDefault("UTC"), "UTC");
  assert.equal(timeZoneOrDefault(""), "Asia/Shanghai");
  assert.throws(() => timeZoneOrDefault("Mars/Olympus"), { code: "memory_timeline_invalid" });
});
