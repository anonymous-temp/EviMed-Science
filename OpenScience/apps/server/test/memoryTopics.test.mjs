// 「主题」: the model groups, code re-verifies. What the code half guarantees — every member is a memory the model was shown, a
// topic has at least two, a label is short, ids survive a regrouping — and how the researcher's word is applied over the model's.
import assert from "node:assert/strict";
import test from "node:test";

import {
  MEMORY_TOPICS_RULES, TOPIC_LIMITS, groupable, labelKey, parseTopics, shownTopics, topicIdFor, topicMark, topicsRequestBody,
} from "../src/memoryTopics.mjs";

const NOW = new Date("2026-10-12T08:00:00Z");

function record(id, overrides = {}) {
  return {
    id, scope: "user", scopeId: "", kind: "preference", summary: `记忆 ${id}`, value: `记忆 ${id}`, status: "active", importance: 0.5, sensitive: false, version: 1,
    createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", ...overrides,
  };
}
const reply = (topics) => JSON.stringify({ topics });
const shown = ["a", "b", "c", "d", "e", "f"];

test("a reply is reduced to what stands: only ids the model was shown, at least two of them, a short label, no repeated theme", () => {
  const made = parseTopics(reply([
    { id: "", label: "数据库性能", members: ["a", "b", "zzz", "a"] },
    { id: "", label: "数据库 性能！", members: ["c"] },
    { id: "", label: "只有一条", members: ["d"] },
    { id: "", label: "", members: ["e", "f"] },
    { id: "", label: "一个特别特别特别特别特别特别长的主题名字超过二十个字符", members: ["e", "f"] },
    { id: "", label: "编造", members: ["x1", "x2"] },
  ]), shown);
  assert.deepEqual(made.map((topic) => [topic.label, topic.members]), [
    ["数据库性能", ["a", "b", "c"]],
    ["一个特别特别特别特别特别特别长的主题名…", ["e", "f"]],
  ], "a theme worded twice is one; a topic of one memory, of none shown, or without a name is dropped");
  assert.ok(made.every((topic) => [...topic.label].length <= TOPIC_LIMITS.label));
  assert.deepEqual(parseTopics("not json", shown), []);
  assert.deepEqual(parseTopics(reply("nope"), shown), []);
  assert.deepEqual(parseTopics(undefined, shown), []);
  assert.equal(topicIdFor("数据库性能"), topicIdFor(" 数据库 性能 "), "the id is the theme's, not the spelling's");
  assert.match(topicIdFor("x"), /^topic:[a-f0-9]{10}$/u);
});

test("there are at most thirty topics, the largest kept", () => {
  const ids = Array.from({ length: 80 }, (_, index) => `m${index}`);
  const topics = ids.slice(0, 40).map((_, index) => ({ id: "", label: `主题${index}`, members: [ids[index], ids[index + 1], ...(index < 5 ? [ids[index + 2], ids[index + 3]] : [])] }));
  const made = parseTopics(reply(topics), ids);
  assert.equal(made.length, TOPIC_LIMITS.max);
  assert.ok(made.slice(0, 5).every((topic) => topic.members.length === 4), "the biggest come first and survive the cut");
});

test("an old id is kept when the theme is still there, and a theme the model gave a new id under its old name is that topic", () => {
  const existing = [{ id: "topic:1111111111", label: "数据库性能", modelLabel: "数据库性能" }, { id: "topic:2222222222", label: "我的招聘", modelLabel: "招聘" }];
  const made = parseTopics(reply([
    { id: "topic:1111111111", label: "数据库调优", members: ["a", "b"] },
    { id: "topic:9999999999", label: "招聘", members: ["c", "d"] },
    { id: "topic:1111111111", label: "又是它", members: ["e", "f"] },
  ]), shown, existing);
  assert.deepEqual(made.map((topic) => topic.id).sort(), ["topic:1111111111", "topic:2222222222", topicIdFor("又是它")].sort(),
    "the unknown id is matched by the model's own earlier label; an id taken twice is given to the first");
  assert.equal(made.find((topic) => topic.id === "topic:1111111111").label, "数据库调优");
});

test("the researcher's word is applied over the model's: a rename, a merge, a dismissal and a memory taken out", () => {
  const records = ["a", "b", "c", "d", "e", "f", "g"].map((id) => record(id, { createdAt: id < "d" ? "2026-10-01T00:00:00Z" : "2026-08-01T00:00:00Z" }));
  const topics = [
    { id: "topic:t1", label: "数据库性能", members: ["a", "b", "c"] },
    { id: "topic:t2", label: "查询优化", members: ["c", "d"] },
    { id: "topic:t3", label: "招聘", members: ["e", "f"] },
    { id: "topic:t4", label: "旅行", members: ["g", "a"] },
  ];
  const plain = shownTopics(topics, {}, records, NOW);
  assert.deepEqual(plain.map((topic) => [topic.id, topic.weight]), [["topic:t1", 3], ["topic:t2", 2], ["topic:t3", 2], ["topic:t4", 2]]);
  assert.equal(plain[0].trend, 3, "three memories began in the last thirty days and none in the thirty before");

  const edited = shownTopics(topics, {
    renamed: { "topic:t1": "性能与查询" }, merged: { "topic:t2": "topic:t1" }, dismissed: [{ id: "topic:t4", label: "旅行" }], removed: { "topic:t3": ["f"] },
  }, records, NOW);
  assert.deepEqual(edited.map((topic) => [topic.id, topic.label, topic.members]), [
    ["topic:t1", "性能与查询", ["a", "b", "c", "d"]],
    ["topic:t3", "招聘", ["e"]],
  ].filter((row) => row[0] !== "topic:t3"), "the merged topic joins the one it was merged into; the dismissed one is gone; a topic the model made falls below two members and goes");
  assert.equal(edited[0].edited, true);

  // A name the researcher gave keeps a topic of one memory; a dismissed name is dismissed under a new id too.
  const kept = shownTopics(topics, { renamed: { "topic:t3": "我的招聘" }, removed: { "topic:t3": ["f"] } }, records, NOW);
  assert.deepEqual(kept.find((topic) => topic.id === "topic:t3")?.members, ["e"]);
  const again = shownTopics([{ id: "topic:t9", label: "旅 行", members: ["g", "a"] }], { dismissed: [{ id: "topic:t4", label: "旅行" }] }, records, NOW);
  assert.deepEqual(again, [], "what the researcher refused does not come back under another id");

  // A merge loop is cut, not followed forever.
  const looped = shownTopics(topics, { merged: { "topic:t1": "topic:t2", "topic:t2": "topic:t1" } }, records, NOW);
  assert.ok(looped.length >= 1);
  // A memory that is gone is no member.
  assert.deepEqual(shownTopics(topics, {}, records.filter((entry) => entry.id !== "e"), NOW).map((topic) => topic.id), ["topic:t1", "topic:t2", "topic:t4"]);
});

test("what is grouped is what the map draws: memories in force, never sensitive, the most important first, bounded", () => {
  const records = [
    record("ok"), record("secret", { sensitive: true }), record("summary", { kind: "run_summary" }), record("gone", { status: "archived" }),
    record("old", { status: "superseded" }), record("empty", { summary: "", value: "  " }), record("pending", { status: "pending", importance: 0.9 }),
  ];
  assert.deepEqual(groupable(records).map((entry) => entry.id), ["pending", "ok"]);
  const many = Array.from({ length: 400 }, (_, index) => record(`m${String(index).padStart(3, "0")}`, { importance: index / 400 }));
  const chosen = groupable(many);
  assert.equal(chosen.length, TOPIC_LIMITS.shown);
  assert.equal(chosen[0].id, "m399");
});

test("a grouping is stale when the memories changed and not before: the mark follows ids and versions, not the order they are read in", () => {
  const records = ["a", "b", "c"].map((id) => record(id));
  const mark = topicMark(records);
  assert.equal(topicMark([...records].reverse()), mark);
  assert.notEqual(topicMark(records.slice(1)), mark, "a memory forgotten");
  assert.notEqual(topicMark([...records, record("d")]), mark, "a memory added");
  assert.notEqual(topicMark([record("a", { version: 2 }), ...records.slice(1)]), mark, "a memory edited");
  assert.match(mark, /^[a-f0-9]{32}$/u);
  assert.match(MEMORY_TOPICS_RULES, /^[a-f0-9]{16}$/u);
});

test("the request names no subject and no closed list, tells the model which names are the researcher's, and shows each memory briefly", () => {
  const body = topicsRequestBody("deepseek-v4-flash", {
    existing: [{ id: "topic:1111111111", label: "我的招聘", fixed: true }, { id: "topic:2222222222", label: "数据库性能" }],
    dismissed: ["旅行"], memories: [record("a", { scope: "project", summary: "字".repeat(500) })],
  });
  assert.equal(body.response_format.type, "json_object");
  assert.deepEqual(body.thinking, { type: "disabled" });
  const system = body.messages[0].content;
  assert.match(system, /Prefer the broader theme/u);
  assert.match(system, /at most thirty/u);
  assert.match(system, /open/u);
  assert.doesNotMatch(system, /专科|specialt|cardiolog|oncolog|drug|disease|药|病/iu, "a general prompt: no medical vocabulary");
  const user = JSON.parse(body.messages[1].content);
  assert.deepEqual(user.existing, [{ id: "topic:1111111111", label: "我的招聘", fixed: true }, { id: "topic:2222222222", label: "数据库性能" }]);
  assert.deepEqual(user.dismissed, ["旅行"]);
  assert.equal(user.memories[0].scope, "project");
  assert.ok([...user.memories[0].text].length <= TOPIC_LIMITS.excerpt);
  assert.equal(labelKey("  数据库-性能！ "), "数据库性能");
});
