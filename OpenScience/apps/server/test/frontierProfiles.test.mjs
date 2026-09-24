// 「与你相关」 without a database (build spec D.4; signals widened 2026-09-24):
// which memories and questions may feed a profile, how a reason reads, how
// phrase vectors are stored, how per-phrase scores become at most eight items
// with no phrase picking more than two, and what marks a profile due.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isResearcherRun } from "../src/agentRuns.mjs";
import {
  FRONTIER_FOR_YOU_PER_PHRASE,
  FRONTIER_FOR_YOU_SIZE,
  FrontierProfiles,
  decodeVector,
  encodeVector,
  frontierForYouRanking,
  frontierPhraseSource,
  frontierProfileMemories,
  frontierProfileQuestions,
  frontierReasonText,
} from "../src/frontierProfiles.mjs";

const record = (id, overrides = {}) => ({
  id, scope: "user", scopeId: "", kind: "profile", key: `profile.${id}`, value: `value ${id}`, summary: `心血管专科医生 ${id}`,
  status: "active", sensitive: false, origin: "explicit", provenance: { basis: "stated" }, ...overrides,
});

test("a profile reads memory of every provenance — active, not sensitive, not a run summary, not a paused or internal project", () => {
  const memories = frontierProfileMemories([
    record("stated"),
    record("confirmed", { provenance: { basis: "confirmed" } }),
    record("edited", { origin: "manual", provenance: { basis: "edited" }, summary: "" }),
    record("inferred", { origin: "inferred", provenance: { basis: "inferred" } }),
    record("assistant", { origin: "system", provenance: { basis: "assistant" } }),
    record("tool", { origin: "system", provenance: { basis: "tool" } }),
    record("pending", { status: "pending" }),
    record("archived", { status: "archived" }),
    record("superseded", { status: "superseded" }),
    record("sensitive", { sensitive: true }),
    record("summary", { kind: "run_summary" }),
    record("project", { scope: "project", scopeId: "sglt2-meta", kind: "project_fact" }),
    record("paused", { scope: "project", scopeId: "paused-project", kind: "project_fact" }),
    record("internal", { scope: "project", scopeId: "evimed-learning", kind: "project_fact" }),
    record("session", { scope: "session", scopeId: "s1" }),
    record("empty", { summary: " ", value: " " }),
  ], { pausedProjects: ["paused-project"] });
  assert.deepEqual(memories.map((memory) => memory.id), ["stated", "confirmed", "edited", "inferred", "assistant", "tool", "project"],
    "what the reader said and what was inferred from their conversations both count");
  assert.equal(memories[2].text, "value edited", "the value stands in for an empty summary");
  assert.deepEqual(memories[0], { id: "stated", kind: "profile", text: "心血管专科医生 stated" });
});

const run = (id, startedAt, overrides = {}) => ({ id, startedAt, question: `问题 ${id}`, titleSource: "question", title: `问题 ${id}`, ...overrides });

test("a profile reads the researcher's own questions of 30 days: newest first, each once, none deleted, paused, internal or placeholder", () => {
  const since = new Date("2026-08-25T00:00:00Z");
  const questions = frontierProfileQuestions([
    { projectId: "p1", run: run("old", "2026-08-01T00:00:00Z") },
    { projectId: "p1", run: run("a", "2026-09-20T00:00:00Z", { question: "替尔泊肽 与  心衰住院\n结局" }) },
    { projectId: "p1", run: run("b", "2026-09-23T00:00:00Z") },
    { projectId: "p2", run: run("again", "2026-09-21T00:00:00Z", { question: "替尔泊肽 与 心衰住院 结局" }) },
    { projectId: "p1", run: run("deleted", "2026-09-22T00:00:00Z", { deleted: true }) },
    { projectId: "paused-project", run: run("paused", "2026-09-22T00:00:00Z") },
    { projectId: "evimed-learning", run: run("lesson", "2026-09-22T00:00:00Z") },
    { projectId: "p1", run: run("titled", "2026-09-19T00:00:00Z", { question: null, title: "SGLT2 与肾病", titleSource: "user" }) },
    { projectId: "p1", run: run("placeholder", "2026-09-18T00:00:00Z", { question: null, title: "未命名的研究", titleSource: "question" }) },
    { projectId: "p1", run: run("undated", undefined) },
  ], { since, pausedProjects: ["paused-project"] });
  assert.deepEqual(questions.map((question) => question.text), ["问题 b", "替尔泊肽 与 心衰住院 结局", "SGLT2 与肾病"]);
  const many = frontierProfileQuestions(Array.from({ length: 45 }, (_, index) => ({ projectId: "p1",
    run: run(`r${index}`, new Date(Date.UTC(2026, 8, 1) + index * 3_600_000).toISOString()) })), { since });
  assert.equal(many.length, 30, "at most thirty");
  assert.equal(many[0].text, "问题 r44", "the newest first");
});

test("a researcher's run is theirs: not an automated run, an autopilot episode, a lesson, a source being read or an evaluation cell", () => {
  assert.equal(isResearcherRun({ id: "r1", effectiveAgentId: "clinical-evidence-synthesis" }), true);
  assert.equal(isResearcherRun({ id: "r2" }), true, "an open-domain answer");
  assert.equal(isResearcherRun({ id: "r3", automated: true }), false);
  assert.equal(isResearcherRun({ id: "r4", effectiveRouteReason: "autopilot:literature-sentinel" }), false);
  assert.equal(isResearcherRun({ id: "r5", effectiveAgentId: "method-distillation" }), false);
  assert.equal(isResearcherRun({ id: "r6", effectiveAgentId: "source-understanding" }), false);
  assert.equal(isResearcherRun({ id: "r7", dispatchId: "methodeval_abc" }), false);
  assert.equal(isResearcherRun(null), false);
});

test("a reason says what the reader works on, asked, or follows, by what the phrase came from", () => {
  assert.equal(frontierReasonText({ text: "SGLT2 抑制剂与心衰的 Meta 分析", kind: "project_fact" }), "因为你在做：SGLT2 抑制剂与心衰的 Meta 分析");
  assert.equal(frontierReasonText({ text: "GLP-1 受体激动剂", kind: "preference" }), "因为你关注：GLP-1 受体激动剂");
  assert.equal(frontierReasonText({ text: "替尔泊肽与心衰", kind: "question" }), "因为你问过：替尔泊肽与心衰");
  assert.equal(frontierReasonText({ text: "非奈利酮", kind: "frontier-item" }), "因为你关注：非奈利酮");
  assert.equal(frontierReasonText({ text: "肿瘤免疫", kind: undefined }), "因为你关注：肿瘤免疫");
  assert.equal(frontierPhraseSource({ memoryId: "mem_1" }), "memory", "a phrase stored before the other signals names a memory");
  assert.equal(frontierPhraseSource({ source: "question", memoryId: "" }), "question");
  assert.equal(frontierPhraseSource({ source: "frontier-item" }), "frontier-item");
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

test("the ranking: each item once, by its best phrase; ties by weight; below the floor nothing", () => {
  const ranked = frontierForYouRanking([
    { itemId: "a", phrase: 0, score: 0.6, weight: 70 },
    { itemId: "a", phrase: 1, score: 0.8, weight: 70 },
    { itemId: "b", phrase: 0, score: 0.8, weight: 90 },
    { itemId: "c", phrase: 2, score: 0.3, weight: 99 },
  ], { minScore: 0.4 });
  assert.deepEqual(ranked, [{ itemId: "b", phrase: 0, score: 0.8 }, { itemId: "a", phrase: 1, score: 0.8 }],
    "equal scores: the item with more weight first; each with the phrase that matched it best");
  assert.equal(ranked.some((entry) => entry.itemId === "c"), false, "an item near nothing the reader showed interest in is not 与你相关");
});

test("the ranking: a phrase picks at most two items, an item whose phrase is full comes in under its next, at most eight", () => {
  const matches = [
    // Six items all nearest one phrase — the 2026-09-23 block where four of five came from one memory.
    ...Array.from({ length: 6 }, (_, index) => ({ itemId: `sglt2-${index}`, phrase: 0, score: 0.9 - index * 0.01, weight: 50 })),
    // The third of them is also near a second phrase, above the floor.
    { itemId: "sglt2-2", phrase: 1, score: 0.5, weight: 50 },
    // Two phrases with two items each, and a third with three weak ones.
    ...Array.from({ length: 4 }, (_, index) => ({ itemId: `other-${index}`, phrase: 2 + Math.floor(index / 2), score: 0.7 - index * 0.01, weight: 50 })),
    ...Array.from({ length: 3 }, (_, index) => ({ itemId: `weak-${index}`, phrase: 4, score: 0.45 - index * 0.01, weight: 50 })),
  ];
  const ranked = frontierForYouRanking(matches, { minScore: 0.4 });
  assert.equal(ranked.length, FRONTIER_FOR_YOU_SIZE);
  const perPhrase = new Map();
  for (const entry of ranked) perPhrase.set(entry.phrase, (perPhrase.get(entry.phrase) ?? 0) + 1);
  assert.ok([...perPhrase.values()].every((count) => count <= FRONTIER_FOR_YOU_PER_PHRASE), JSON.stringify([...perPhrase]));
  assert.deepEqual(ranked.filter((entry) => entry.phrase === 0).map((entry) => entry.itemId), ["sglt2-0", "sglt2-1"]);
  assert.deepEqual(ranked.find((entry) => entry.itemId === "sglt2-2"), { itemId: "sglt2-2", phrase: 1, score: 0.5 },
    "its best phrase full, the item comes in under the next phrase that still holds");
  assert.deepEqual(ranked.filter((entry) => entry.phrase === 4).map((entry) => entry.itemId), ["weak-0"], "the eighth place, and no ninth");
  assert.equal(new Set(ranked.map((entry) => entry.itemId)).size, ranked.length, "an item once");
});

test("the ranking: the editorial score orders near-equals and never lifts an item past the floor", () => {
  const ranked = frontierForYouRanking([
    { itemId: "strong-match", phrase: 0, score: 0.62, weight: 40 },
    { itemId: "better-edited", phrase: 1, score: 0.6, weight: 95 },
    { itemId: "below-floor", phrase: 2, score: 0.39, weight: 100 },
  ], { minScore: 0.4, editorial: 0.1 });
  assert.deepEqual(ranked.map((entry) => entry.itemId), ["better-edited", "strong-match"]);
  assert.deepEqual(frontierForYouRanking([
    { itemId: "strong-match", phrase: 0, score: 0.8, weight: 0 },
    { itemId: "better-edited", phrase: 1, score: 0.6, weight: 100 },
  ], { minScore: 0.4, editorial: 0.1 }).map((entry) => entry.itemId), ["strong-match", "better-edited"], "a light blend, not a re-sort by score");
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

/** A database that records every statement and answers each with `rowCount: 1`. */
function recordingDatabase({ fail = false } = {}) {
  const statements = [];
  return {
    statements,
    query: async (text, values) => {
      statements.push({ text: String(text).replace(/\s+/g, " "), values });
      if (fail) throw Object.assign(new Error("down"), { code: "database_unavailable" });
      return { rows: [], rowCount: 1 };
    },
  };
}

test("a star, an unstar or a new question marks the profile due; an item opened only while there is nothing yet; a hide drops only the ranking", async () => {
  const database = recordingDatabase();
  const profiles = new FrontierProfiles({ database, researchMemory: { configured: true } });
  await profiles.noteItemAction("u1", "star");
  await profiles.noteItemAction("u1", "unstar");
  await profiles.noteItemAction("u1", "read");
  await profiles.noteItemAction("u1", "hide");
  await profiles.noteItemAction("u1", "unhide");
  const marks = database.statements.filter((statement) => statement.text.includes("inputs_version = inputs_version + 1"));
  assert.deepEqual(marks.map((statement) => statement.values), [["u1", false], ["u1", false], ["u1", true]],
    "star and unstar mark the profile; an item opened marks it only when it has no phrase yet");
  const dropped = database.statements.filter((statement) => statement.text.includes("SET for_you_at = NULL"));
  assert.equal(dropped.length, 2, "a hide and an unhide re-rank in SQL; the model reads no hide");
  assert.equal(profiles.counters.staleMarks, 3);

  database.statements.length = 0;
  profiles.noteConversation("u1", { id: "run_1", question: "替尔泊肽与心衰？" });
  profiles.noteConversation("u1", { id: "run_1", question: "替尔泊肽与心衰？", status: "completed" });
  profiles.noteConversation("u1", { id: "run_2", question: null });
  profiles.noteConversation("u1", { id: "run_1", question: "替尔泊肽与心衰？", deleted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(database.statements.length, 2, "a question once, its deletion once, a run with no question yet not at all");
  assert.ok(database.statements.every((statement) => statement.text.includes("inputs_version = inputs_version + 1")));
});

test("a mark that cannot be written fails nothing: it is counted, and the profile waits for its day", async () => {
  const database = recordingDatabase({ fail: true });
  const profiles = new FrontierProfiles({ database, researchMemory: { configured: true } });
  await profiles.noteItemAction("u1", "star");
  await profiles.noteItemAction("u1", "hide");
  profiles.noteConversation("u1", { id: "run_1", question: "问题" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(profiles.counters.staleMarkFailures, 3);
  assert.equal(profiles.lastError, "database_unavailable");
});
