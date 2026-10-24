// 「与你相关」 without a database (build spec D.4; signals widened 2026-09-24):
// which memories and questions may feed a profile, how a reason reads, how
// phrase vectors are stored, how the ranking's parts become at most eight
// entries in display order (no reason picking more than its cap, must-see
// first, one exploration entry with its propensity), how genre affinity is
// smoothed, and what marks a profile due.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isResearcherRun } from "../src/agentRuns.mjs";
import {
  FRONTIER_FOR_YOU_PER_PHRASE,
  FRONTIER_FOR_YOU_SIZE,
  FRONTIER_RANKING,
  FrontierProfiles,
  decodeVector,
  encodeVector,
  frontierEditorialShare,
  frontierForYouBlock,
  frontierGenreAffinity,
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
  assert.equal(isResearcherRun({ id: "r7", effectiveRouteReason: "platform-learning" }), false);
  assert.equal(isResearcherRun({ id: "r8", dispatchId: "methodeval_abc" }), true, "a dispatch id a browser can type says nothing about whose run it is");
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

/** A candidate of the block: an id, a score out of 100, and whatever else the case needs. */
const candidate = (id, overrides = {}) => ({ id, publicId: `pub${id}`, weight: 50, selected: false, safetyAlert: false, genre: "paper", specialties: [],
  visibleAt: NOW_MS - 3_600_000, ...overrides });
const reason = (topic, cap = FRONTIER_FOR_YOU_PER_PHRASE) => ({ topic, kind: "project_fact", cap });
const NOW_MS = Date.parse("2026-10-24T08:00:00Z");
const NO_EXPLORE = { ...FRONTIER_RANKING, explore: { ...FRONTIER_RANKING.explore, slots: 0 } };
/** The block with what a test does not name left plain: no editorial share, no genre term, nothing to explore. */
const block = (input) => frontierForYouBlock({ readerSpecialties: [], editorialShare: 0, terms: {}, now: NOW_MS, selectThreshold: 82, ranking: NO_EXPLORE,
  random: () => 0, ...input });

test("the block: each item once, under its best reason; ties by weight", () => {
  const entries = block({
    candidates: [candidate("a", { weight: 70 }), candidate("b", { weight: 90 })],
    reasons: [reason("A"), reason("B")],
    pairs: [{ itemId: "a", reason: 0, score: 0.6 }, { itemId: "a", reason: 1, score: 0.8 }, { itemId: "b", reason: 0, score: 0.8 }],
  });
  assert.deepEqual(entries.map((entry) => [entry.itemId, entry.topic, entry.slot]), [["b", "A", "personal"], ["a", "B", "personal"]],
    "equal scores: the item with more weight first; each under the reason that matched it best");
});

test("the block: a reason picks at most its cap, an item whose reason is full comes in under its next, at most eight", () => {
  const candidates = [...Array.from({ length: 6 }, (_, index) => candidate(`sglt2-${index}`)), ...Array.from({ length: 4 }, (_, index) => candidate(`other-${index}`)),
    ...Array.from({ length: 3 }, (_, index) => candidate(`weak-${index}`))];
  const pairs = [
    // Six items all nearest one phrase — the 2026-09-23 block where four of five came from one memory.
    ...Array.from({ length: 6 }, (_, index) => ({ itemId: `sglt2-${index}`, reason: 0, score: 0.9 - index * 0.01 })),
    // The third of them is also near a second phrase, above the floor.
    { itemId: "sglt2-2", reason: 1, score: 0.5 },
    ...Array.from({ length: 4 }, (_, index) => ({ itemId: `other-${index}`, reason: 2 + Math.floor(index / 2), score: 0.7 - index * 0.01 })),
    ...Array.from({ length: 3 }, (_, index) => ({ itemId: `weak-${index}`, reason: 4, score: 0.45 - index * 0.01 })),
  ];
  const entries = block({ candidates, reasons: ["P0", "P1", "P2", "P3", "P4"].map((topic) => reason(topic)), pairs });
  assert.equal(entries.length, FRONTIER_FOR_YOU_SIZE);
  const perReason = new Map();
  for (const entry of entries) perReason.set(entry.topic, (perReason.get(entry.topic) ?? 0) + 1);
  assert.ok([...perReason.values()].every((count) => count <= FRONTIER_FOR_YOU_PER_PHRASE), JSON.stringify([...perReason]));
  assert.deepEqual(entries.filter((entry) => entry.topic === "P0").map((entry) => entry.itemId), ["sglt2-0", "sglt2-1"]);
  assert.equal(entries.find((entry) => entry.itemId === "sglt2-2")?.topic, "P1", "its best reason full, the item comes in under the next that holds");
  assert.deepEqual(entries.filter((entry) => entry.topic === "P4").map((entry) => entry.itemId), ["weak-0"], "the eighth place, and no ninth");
  assert.equal(new Set(entries.map((entry) => entry.itemId)).size, entries.length, "an item once");
  // Served in display order: each topic's run is contiguous, so the index is the position the block shows it at.
  const runs = entries.map((entry) => entry.topic).filter((topic, index, all) => index === 0 || all[index - 1] !== topic);
  assert.equal(new Set(runs).size, runs.length, runs.join());
});

test("the block: the editorial share orders near-equals, shrinking as the reader comes back; the genre term leans by what they read", () => {
  const candidates = [candidate("strong-match", { weight: 40 }), candidate("better-edited", { weight: 95 })];
  const reasons = [reason("A"), reason("B")];
  const pairs = [{ itemId: "strong-match", reason: 0, score: 0.62 }, { itemId: "better-edited", reason: 1, score: 0.6 }];
  assert.deepEqual(block({ candidates, reasons, pairs, editorialShare: frontierEditorialShare(0) }).map((entry) => entry.itemId), ["better-edited", "strong-match"]);
  assert.deepEqual(block({ candidates, reasons, pairs: [{ itemId: "strong-match", reason: 0, score: 0.9 }, pairs[1]], editorialShare: frontierEditorialShare(50) })
    .map((entry) => entry.itemId), ["strong-match", "better-edited"], "a light blend, not a re-sort by score");
  assert.equal(frontierEditorialShare(0), FRONTIER_RANKING.editorial.ceiling);
  assert.equal(frontierEditorialShare(FRONTIER_RANKING.editorial.visitsHalf), (FRONTIER_RANKING.editorial.ceiling + FRONTIER_RANKING.editorial.floor) / 2);
  assert.ok(frontierEditorialShare(1_000) < FRONTIER_RANKING.editorial.floor + 0.01);
  const leaning = block({ candidates: [candidate("paper", { genre: "paper" }), candidate("alert", { genre: "approval" })], reasons: [reason("A"), reason("B")],
    pairs: [{ itemId: "paper", reason: 0, score: 0.6 }, { itemId: "alert", reason: 1, score: 0.6 }], terms: frontierGenreAffinity([], "pharmacist") });
  assert.deepEqual(leaning.map((entry) => entry.itemId), ["alert", "paper"], "a pharmacist's prior leans to approvals");
});

test("genre affinity: Beta-smoothed toward the role's prior; an open counts half, a satisfied read one, a hide one more failure", () => {
  const empty = frontierGenreAffinity([], null);
  assert.equal(empty.paper.mean, FRONTIER_RANKING.genre.base);
  assert.equal(empty.paper.term, 0, "no evidence and no role: no lean");
  const pharmacist = frontierGenreAffinity([], "pharmacist");
  assert.equal(pharmacist.safety.mean, FRONTIER_RANKING.genre.lean);
  assert.ok(pharmacist.safety.term > 0 && pharmacist.paper.term === 0);
  const read = frontierGenreAffinity([
    ...Array.from({ length: 6 }, () => ({ genre: "guideline", seen: true, opened: true, satisfied: true })),
    { genre: "guideline", seen: true, opened: true, satisfied: false },
    ...Array.from({ length: 10 }, () => ({ genre: "news", seen: true })),
    { genre: "news", seen: true, hidden: true },
  ], null);
  assert.deepEqual([read.guideline.trials, read.guideline.successes], [7, 6.5]);
  assert.deepEqual([read.news.trials, read.news.successes], [12, 0], "a hide is the impression's failure and one more");
  assert.ok(read.guideline.term > 0 && read.news.term < 0);
  assert.ok(read.guideline.term <= FRONTIER_RANKING.genre.share && read.news.term >= -FRONTIER_RANKING.genre.share, "clipped to the share");
  assert.equal(frontierGenreAffinity([{ genre: "not-a-genre", seen: true }], null).paper.trials, 0, "an unknown genre counts nowhere");
});

test("must-see first: a recent safety alert in the reader's specialties or none, then a selected guideline or approval of theirs; at most two", () => {
  const entries = block({
    readerSpecialties: ["cardiology"],
    candidates: [
      candidate("alert-other", { safetyAlert: true, genre: "safety", specialties: ["dermatology"] }),
      candidate("alert-broad", { safetyAlert: true, genre: "safety", specialties: [], visibleAt: NOW_MS - 2 * 3_600_000 }),
      candidate("alert-old", { safetyAlert: true, genre: "safety", visibleAt: NOW_MS - 80 * 3_600_000 }),
      candidate("guideline", { selected: true, genre: "guideline", specialties: ["cardiology"], weight: 90 }),
      candidate("approval", { selected: true, genre: "approval", specialties: ["cardiology"], weight: 85 }),
      candidate("mine", { weight: 60 }),
    ],
    reasons: [reason("A")], pairs: [{ itemId: "mine", reason: 0, score: 0.7 }],
  });
  assert.deepEqual(entries.map((entry) => [entry.itemId, entry.slot, entry.topic]).slice(0, 3), [
    ["alert-broad", "must-see", "安全警示"], ["guideline", "must-see", "指南共识"], ["mine", "personal", "A"]],
    "another specialty's alert, and one older than 72 hours, are not must-see; the approval waits for room");
  assert.deepEqual(entries.find((entry) => entry.itemId === "approval")?.slot, "editorial", "then the editor's pick fills the room left");
});

test("the exploration entry: drawn uniformly from the best unmatched items, its probability recorded, at the first boundary from the fourth place", () => {
  const ranking = FRONTIER_RANKING;
  const candidates = [
    ...["a", "b", "c", "d", "e"].map((id) => candidate(id, { weight: 60 })),
    candidate("good-1", { weight: 95 }), candidate("good-2", { weight: 90 }), candidate("good-3", { weight: 83 }), candidate("weak", { weight: 70 }),
  ];
  const pairs = [{ itemId: "a", reason: 0, score: 0.8 }, { itemId: "b", reason: 0, score: 0.79 }, { itemId: "c", reason: 1, score: 0.7 },
    { itemId: "d", reason: 1, score: 0.69 }, { itemId: "e", reason: 2, score: 0.6 }];
  const draws = [];
  for (const draw of [0, 0.5, 0.99]) {
    const entries = block({ candidates, reasons: [reason("X"), reason("Y"), reason("Z")], pairs, ranking, random: () => draw });
    const explore = entries.filter((entry) => entry.slot === "explore");
    assert.equal(explore.length, 1);
    assert.equal(explore[0].propensity, Math.round(1_000_000 / 3) / 1_000_000, "three items of 精选 quality outside the profile; weak is not one");
    assert.equal(explore[0].topic, "其他领域精选");
    assert.equal(entries.indexOf(explore[0]), 4, "not inside Y's run at the fourth place: after it");
    draws.push(explore[0].itemId);
  }
  assert.deepEqual(draws, ["good-1", "good-2", "good-3"], "the draw decides which, uniformly over the pool (best first, so a draw of 0 is the best)");
  // With no reason of the reader's at all: 精选 by score, and the drawn entry joins their run.
  const cold = block({ candidates: [candidate("s1", { selected: true, weight: 99 }), candidate("s2", { selected: true, weight: 90 }),
    candidate("s3", { selected: true, weight: 85 }), candidate("x", { weight: 88 })], reasons: [], pairs: [], ranking, random: () => 0 });
  assert.deepEqual(cold.map((entry) => [entry.itemId, entry.slot, entry.topic]), [["s1", "editorial", "精选"], ["s2", "editorial", "精选"],
    ["s3", "editorial", "精选"], ["x", "explore", "精选"]]);
  assert.equal(cold[3].propensity, 1);
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
