import assert from "node:assert/strict";
import test from "node:test";
import { FRONTIER_SPECIALTIES } from "@evimed/domain";
import {
  FRONTIER_ITEM_TAGS_MAX, FRONTIER_TOPICS, FRONTIER_TOPIC_GROUPS, frontierItemTags, frontierItemTopics, frontierTopicTable, frontierTopicTagNames, topicKey,
} from "../src/frontierTopics.mjs";

test("the topic table: 60 to 100 medical topics in the five groups, every specialty one, every row named and defined", () => {
  assert.ok(FRONTIER_TOPICS.length >= 60 && FRONTIER_TOPICS.length <= 100, `${FRONTIER_TOPICS.length} topics`);
  for (const group of FRONTIER_TOPIC_GROUPS) assert.ok(FRONTIER_TOPICS.some((topic) => topic.group === group), group);
  for (const key of FRONTIER_SPECIALTIES) {
    assert.ok(FRONTIER_TOPICS.some((topic) => topic.group === "specialty" && topic.tags.includes(`specialty:${key}`)), `specialty ${key}`);
  }
  assert.equal(new Set(FRONTIER_TOPICS.map((topic) => topic.slug)).size, FRONTIER_TOPICS.length);
  for (const topic of FRONTIER_TOPICS) assert.ok(topic.name && topic.definition && (topic.tags.length || topic.aliases.length), topic.slug);
  // A name that belongs to two topics would put every item that says it in both: one name, one topic.
  const owners = new Map();
  for (const topic of FRONTIER_TOPICS) {
    for (const key of new Set([topic.name, ...topic.tags, ...topic.aliases].map(topicKey))) {
      assert.ok(!owners.has(key), `${key} is in ${owners.get(key)} and ${topic.slug}`);
      owners.set(key, topic.slug);
    }
  }
});

test("a bad row stops the start by its slug", () => {
  const row = { slug: "x-1", name: "X", group: "disease", tags: ["X"], aliases: [], definition: "X。" };
  assert.equal(frontierTopicTable({ topics: [row] }).length, 1);
  assert.throws(() => frontierTopicTable({ topics: [row, row] }), /repeated/);
  assert.throws(() => frontierTopicTable({ topics: [{ ...row, group: "company" }] }), /x-1 has no known group/);
  assert.throws(() => frontierTopicTable({ topics: [{ ...row, definition: "" }] }), /x-1 needs a name and a definition/);
  assert.throws(() => frontierTopicTable({}), /no topics/);
});

test("an item is in a topic by equality of names: specialties, entities, tags, evidence type, lane, flags, the source", () => {
  const slugs = (/** @type {any} */ item) => frontierItemTopics(item).map((topic) => topic.slug);
  assert.deepEqual(slugs({ specialties: ["cardiology", "endocrinology"], entities: { drugs: ["司美格鲁肽"], diseases: ["肥胖"] }, evidenceType: "rct" }),
    ["cardiology", "endocrinology", "obesity", "glp1", "rct"], "group order, then table order");
  assert.deepEqual(slugs({ tags: ["SGLT2 抑制剂"], entities: { orgs: ["FDA"] }, lane: "safety", flags: ["boxed-warning"] }), ["sglt2", "fda", "drug-safety"]);
  assert.deepEqual(slugs({ entities: { drugs: ["Semaglutide"] } }), ["glp1"], "case and spaces do not matter");
  assert.deepEqual(slugs({ tags: ["GLP-1受体激动剂"] }), ["glp1"]);
  assert.deepEqual(slugs({ sourceName: "国家药品监督管理局" }), ["nmpa"]);
  // Equality, never a substring: a name that only contains a topic's name is not in it.
  assert.deepEqual(slugs({ entities: { diseases: ["妊娠期糖尿病"] } }), []);
  assert.deepEqual(slugs({ tags: ["糖尿病肾病"] }), []);
  assert.deepEqual(slugs({ entities: { diseases: ["1型糖尿病"] } }), ["diabetes"]);
  assert.deepEqual(slugs({}), []);
  assert.deepEqual(slugs({ specialties: ["astrology"], entities: "x", tags: null }), []);
  assert.equal(frontierItemTopics({ specialties: [...FRONTIER_SPECIALTIES] }).length, 8, "eight at most");
  assert.deepEqual(frontierItemTopics({ lane: "ai" }), [{ slug: "medical-ai", name: "医学 AI", group: "genre" }], "a topic as the reader gets it");
});

test("the reader's tags are the editor's then the evidence type, each once, eight at most; the offered names are disease and drug tags", () => {
  assert.deepEqual(frontierItemTags({ tags: ["肥胖", "GLP-1 受体激动剂"], evidenceTypeLabel: "RCT" }), ["肥胖", "GLP-1 受体激动剂", "RCT"]);
  assert.deepEqual(frontierItemTags({ tags: ["RCT", "肥胖"], evidenceTypeLabel: "RCT" }), ["RCT", "肥胖"]);
  assert.deepEqual(frontierItemTags({ tags: null, evidenceTypeLabel: null }), []);
  const many = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"];
  assert.deepEqual(frontierItemTags({ tags: many, evidenceTypeLabel: "RCT" }), [...many.slice(0, 7), "RCT"]);
  assert.equal(frontierItemTags({ tags: many }).length, FRONTIER_ITEM_TAGS_MAX - 1);
  const names = frontierTopicTagNames();
  assert.ok(names.includes("糖尿病") && names.includes("GLP-1 受体激动剂") && names.includes("CAR-T"));
  assert.ok(!names.some((name) => name.includes(":")), "no typed key is offered");
  assert.ok(!names.includes("FDA") && !names.includes("心血管"), "no organisation, no specialty");
});
