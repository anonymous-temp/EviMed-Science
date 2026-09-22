// 「与你相关」 without a database (build spec D.4): which memories may feed a
// profile, how a reason reads, how phrase vectors are stored, and how the
// per-phrase scores become five items with one reason each.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FRONTIER_FOR_YOU_SIZE,
  FrontierProfiles,
  decodeVector,
  encodeVector,
  frontierForYouRanking,
  frontierProfileMemories,
  frontierReasonText,
} from "../src/frontierProfiles.mjs";

const record = (id, overrides = {}) => ({
  id, scope: "user", scopeId: "", kind: "profile", key: `profile.${id}`, value: `value ${id}`, summary: `心血管专科医生 ${id}`,
  status: "active", sensitive: false, provenance: { basis: "stated" }, ...overrides,
});

test("a profile reads only what the reader said, confirmed or edited — active, not sensitive, not a run summary", () => {
  const memories = frontierProfileMemories([
    record("stated"),
    record("confirmed", { provenance: { basis: "confirmed" } }),
    record("edited", { provenance: { basis: "edited" }, summary: "" }),
    record("inferred", { provenance: { basis: "inferred" } }),
    record("assistant", { provenance: { basis: "assistant" } }),
    record("pending", { status: "pending" }),
    record("archived", { status: "archived" }),
    record("sensitive", { sensitive: true }),
    record("summary", { kind: "run_summary" }),
    record("project", { scope: "project", scopeId: "sglt2-meta", kind: "project_fact" }),
    record("paused", { scope: "project", scopeId: "paused-project", kind: "project_fact" }),
    record("internal", { scope: "project", scopeId: "evimed-learning", kind: "project_fact" }),
    record("session", { scope: "session", scopeId: "s1" }),
    record("empty", { summary: " ", value: " " }),
  ], { pausedProjects: ["paused-project"] });
  assert.deepEqual(memories.map((memory) => memory.id), ["stated", "confirmed", "edited", "project"]);
  assert.equal(memories[2].text, "value edited", "the value stands in for an empty summary");
  assert.deepEqual(memories[0], { id: "stated", kind: "profile", text: "心血管专科医生 stated" });
});

test("a reason says what the reader works on, or what they follow, by the kind of memory it came from", () => {
  assert.equal(frontierReasonText({ text: "SGLT2 抑制剂与心衰的 Meta 分析", kind: "project_fact" }), "因为你在做：SGLT2 抑制剂与心衰的 Meta 分析");
  assert.equal(frontierReasonText({ text: "GLP-1 受体激动剂", kind: "preference" }), "因为你关注：GLP-1 受体激动剂");
  assert.equal(frontierReasonText({ text: "肿瘤免疫", kind: undefined }), "因为你关注：肿瘤免疫");
});

test("a phrase vector is stored as float32 base64 and read back only at its own width", () => {
  const vector = [0.5, -0.25, 0.125, 1];
  const stored = encodeVector(vector);
  assert.equal(typeof stored, "string");
  assert.deepEqual(decodeVector(stored, 4), vector);
  assert.equal(decodeVector(stored, 1024), null, "another width is no vector");
  assert.equal(decodeVector("", 4), null);
  assert.equal(decodeVector(null, 4), null);
  // Decoded many times over, a small vector lands at every offset of Node's
  // shared Buffer pool; it must read the same at each.
  for (let round = 0; round < 64; round += 1) {
    Buffer.from("x".repeat(round % 7 + 1));
    assert.deepEqual(decodeVector(stored, 4), vector);
  }
});

test("the ranking: each item once, by its best phrase; ties by weight; below the floor nothing; at most five", () => {
  const ranked = frontierForYouRanking([
    { itemId: "a", phrase: 0, score: 0.6, weight: 70 },
    { itemId: "a", phrase: 1, score: 0.8, weight: 70 },
    { itemId: "b", phrase: 0, score: 0.8, weight: 90 },
    { itemId: "c", phrase: 2, score: 0.3, weight: 99 },
    ...Array.from({ length: 6 }, (_, index) => ({ itemId: `z${index}`, phrase: 3, score: 0.5, weight: index })),
  ], { minScore: 0.4 });
  assert.equal(ranked.length, FRONTIER_FOR_YOU_SIZE);
  assert.deepEqual(ranked.slice(0, 2), [{ itemId: "b", phrase: 0, score: 0.8 }, { itemId: "a", phrase: 1, score: 0.8 }],
    "equal scores: the item with more weight first; each with the phrase that matched it best");
  assert.equal(ranked.some((entry) => entry.itemId === "c"), false, "an item near nothing the reader said is not 与你相关");
});

test("personalization is off without a memory store or a model, and unavailable while the memory store is failing", () => {
  const database = { query: async () => ({ rows: [] }) };
  const config = { deepseekProviderEnabled: true, deepseekApiKey: "test-only-key" };
  assert.equal(new FrontierProfiles({ database, config }).state(), "off", "no memory store");
  assert.equal(new FrontierProfiles({ database, config: {}, researchMemory: { configured: true } }).state(), "off", "no model to read it with");
  let now = new Date("2026-09-22T04:00:00Z");
  const profiles = new FrontierProfiles({ database, config, researchMemory: { configured: true }, now: () => now });
  assert.equal(profiles.state(), "available");
  profiles.memoryFailedAt = now.getTime();
  assert.equal(profiles.state(), "unavailable");
  now = new Date(now.getTime() + 16 * 60_000);
  assert.equal(profiles.state(), "available", "a failure is reported for a while, not for ever");
});
