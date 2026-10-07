// 「哪天学会了什么」: the growth page's list under its line, derived from the
// records that already say it — never from a log of its own.
import assert from "node:assert/strict";
import test from "node:test";
import { METHOD_SKILL_SCHEMA } from "@evimed/domain";
import { HandbookConsolidation } from "../src/handbookConsolidation.mjs";
import { HandbookLibrary } from "../src/handbookLibrary.mjs";
import { memoryLearned } from "../src/memoryTimeline.mjs";
import { fixture, registry } from "./helpers/handbookFixture.mjs";

const BODY = ["## Purpose", "Align every citation marker with one reference.", "## When to Use", "When a report needs references.", "## Inputs", "The report.",
  "## Workflow", "1. Match markers.", "## Verification", "- Every marker has one entry.", "## Constraints", "- Do not invent entries.", "## Output", "A reference list."].join("\n");
const method = (name, extra = {}) => ({
  frontmatter: { name, description: "Align citations.", whenToUse: "When a report needs references.",
    metadata: { role: "functional", applies_when: "A report with references.", not_when: "No citations.", derived_from: "run:run_1", evimed_schema: METHOD_SKILL_SCHEMA } },
  body: BODY, provenance: { origin: "inferred", runId: "run_1", sourceProjectId: "meta" }, ...extra,
});
const memory = (days) => ({ async growthDays() { return days; } });

test("the days a capsule learned things: the first memory, each method and handbook, and each later body of one", async () => {
  const f = fixture();
  const loop = new HandbookConsolidation({ ...f, registry });
  const handbooks = new HandbookLibrary({ learning: f.learning });
  const created = await f.learning.createCandidate("alice", { ...method("citation-alignment"), projectId: "meta", display: { title: "引用标记对齐", summary: "每个标记对应一条。" } });
  await f.learning.approve("alice", created.id, { expectedRevision: created.revision }).catch(() => null);
  await f.learning.amendMethod("alice", created.id, { expectedRevision: (await f.learning.getMethod("alice", created.id)).revision,
    ...method("citation-alignment", { body: `${BODY}\n## Notes\nSecond.` }), display: { title: "引用标记对齐（新）", summary: "更新后。" } });
  // The amendment sent it back to candidate; a method still waiting is not yet something that was learned.
  const learned = await f.learning.getMethod("alice", created.id);
  await f.documents.put("alice", "method", created.id, { ...learned.payload, status: "approved" }, { expectedRevision: learned.revision });

  await f.learning.recordHandbookCandidate("alice", { ...f.input(), display: { title: "每一句结论落回来源", summary: "写结论时同时写出处。" } });
  await loop.run({ job: f.queued.at(-1) });

  const result = await memoryLearned({ researchMemory: memory([{ day: "2026-08-20", added: 4, ended: 0 }, { day: "2026-08-21", added: 0, ended: 1 }]),
    learning: f.learning, handbooks }, { id: "alice" }, { timeZone: "UTC" });
  assert.equal(result.timeZone, "UTC");
  const flat = result.days.flatMap((entry) => entry.items.map((item) => [item.kind, item.what, item.title]));
  assert.deepEqual(flat.filter((item) => item[0] === "start"), [["start", null, ""]]);
  assert.ok(flat.some((item) => item[0] === "learned" && item[1] === "method" && item[2] === "引用标记对齐（新）"), JSON.stringify(flat));
  assert.ok(flat.some((item) => item[0] === "improved" && item[1] === "method"), "a second body is a day of its own");
  assert.ok(flat.some((item) => item[0] === "learned" && item[1] === "handbook" && item[2] === "每一句结论落回来源"), "a handbook is learned like a method");
  // Newest day first, one row per day, and what began the capsule is on its first day.
  const order = result.days.map((entry) => entry.day);
  assert.deepEqual(order, [...order].sort().reverse());
  assert.equal(new Set(order).size, order.length);
  assert.equal(result.days.at(-1).items[0].kind, "start");
});

test("a method that was stopped is not in the story, and a source that cannot be read leaves only its own rows out", async () => {
  const f = fixture();
  const stopped = await f.learning.createCandidate("alice", { ...method("stopped-one"), projectId: "meta", display: { title: "已停用的做法", summary: "不再用了。" } });
  await f.documents.put("alice", "method", stopped.id, { ...stopped.payload, status: "retired" }, { expectedRevision: stopped.revision });
  const kept = await f.learning.createCandidate("alice", { ...method("kept-one"), projectId: "meta", display: { title: "在用的做法", summary: "还在用。" } });
  await f.documents.put("alice", "method", kept.id, { ...kept.payload, status: "approved" }, { expectedRevision: kept.revision });

  const result = await memoryLearned({
    researchMemory: { async growthDays() { throw new Error("memory store down"); } },
    learning: f.learning,
    handbooks: { async list() { throw new Error("handbook store down"); } },
  }, { id: "alice" }, { timeZone: "Asia/Shanghai" });
  const titles = result.days.flatMap((entry) => entry.items.map((item) => item.title));
  assert.deepEqual(titles, ["在用的做法"]);
  await assert.rejects(memoryLearned({ researchMemory: memory([]) }, { id: "alice" }, { timeZone: "Nowhere/Land" }), { code: "memory_timeline_invalid" });
  assert.deepEqual((await memoryLearned({ researchMemory: memory([]) }, { id: "alice" })).days, [], "nothing learned yet is an empty list, not an error");
});
