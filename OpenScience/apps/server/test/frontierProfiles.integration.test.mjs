// 「与你相关」 against a real PostgreSQL and a real memory store (build spec D.4;
// rebuilt 2026-09-24): a profile from the reader's memory of every provenance,
// their recent questions and the items they starred or opened; every item of
// the window ranked by phrase vectors, no phrase picking more than two; what
// they hid pushing its near-duplicates out; each memory reason re-checked
// against the memory it names; the states a reader can be in; the keyword
// basis without vectors; and a profile due at the next round once its inputs
// change.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierProfiles, encodeVector } from "../src/frontierProfiles.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";
import { insertSource } from "./helpers/frontierFixtures.mjs";
import { insertComposedItem, resetFrontier, testEmbedder, vectorAt } from "./helpers/frontierComposeFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const suffix = randomUUID().slice(0, 8);
const users = { reader: `reader_${suffix}`, paused: `paused_${suffix}`, empty: `empty_${suffix}`, fresh: `fresh_${suffix}` };
const NOW = new Date("2026-09-22T04:00:00Z");
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const CONFIG = { deepseekProviderEnabled: true, deepseekApiKey: "test-only-key", frontierAudience: "all", kbEmbeddingDimension: 1024 };
let database;
let memory;
const memories = {};

const evidence = (quote) => ({ sourceType: "conversation_message", sourceRef: "sessions/ses_1/messages/m1", quote, observedAt: NOW.toISOString(), weight: 1 });

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
  for (const id of Object.values(users)) await database.query("INSERT INTO evimed_control.users(id, name, auth_type) VALUES ($1, $1, 'development')", [id]);
  memory = new ResearchMemoryStore({}, { database });
  memories.project = await memory.upsertRecord(users.reader, { scope: "user", kind: "project_fact", key: "project.sglt2",
    value: "正在做 SGLT2 抑制剂与心衰住院的 Meta 分析", summary: "正在做 SGLT2 抑制剂与心衰住院的 Meta 分析",
    origin: "explicit", status: "active", confidence: 1, importance: 0.9 }, evidence("我在做 SGLT2 心衰的 Meta 分析"));
  memories.profile = await memory.upsertRecord(users.reader, { scope: "user", kind: "profile", key: "profile.department",
    value: "心内科主治医师", summary: "心内科主治医师", origin: "explicit", status: "active", confidence: 1, importance: 0.8 }, evidence("我是心内科的"));
  memories.inferred = await memory.upsertRecord(users.reader, { scope: "user", kind: "preference", key: "preference.oncology",
    value: "可能关注肿瘤免疫", summary: "可能关注肿瘤免疫", origin: "inferred", status: "active", confidence: 0.4, importance: 0.3 },
  { sourceType: "assistant_message", sourceRef: "sessions/ses_1/messages/m2", quote: "肿瘤", observedAt: NOW.toISOString(), weight: 0.5 });
  await memory.upsertRecord(users.paused, { scope: "user", kind: "profile", key: "profile.department", value: "肿瘤科", summary: "肿瘤科",
    origin: "explicit", status: "active", confidence: 1, importance: 0.8 }, evidence("我是肿瘤科的"));
  await memory.updateSettings(users.paused, { recallPaused: true });
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id = ANY($1::text[])", [Object.values(users)]);
  await database.close();
});

beforeEach(async () => {
  if (!database) return;
  await resetFrontier(database);
  await database.query("DELETE FROM evimed_frontier.user_state WHERE user_id = ANY($1::text[])", [Object.values(users)]);
  await insertSource(database, "nejm", { authority: 5 });
  await insertSource(database, "stat", { name: "STAT", source_type: "media", authority: 3 });
  await insertSource(database, "muted", { name: "Muted", source_type: "media" });
  for (const id of Object.values(users)) await database.query("INSERT INTO evimed_frontier.user_prefs (user_id, last_seen_at) VALUES ($1, $2)", [id, hoursAgo(2)]);
});

/** The reader's own runs, as the run ledger would give them (`researcherRuns`), by project. */
const RUNS = {
  [users.reader]: [
    { projectId: "p1", run: { id: "run_1", startedAt: hoursAgo(30), question: "替尔泊肽对射血分数保留心衰的住院结局有什么证据？", titleSource: "question" } },
    { projectId: "p1", run: { id: "run_2", startedAt: hoursAgo(20), question: "帮我删掉的那个问题", deleted: true } },
    { projectId: "evimed-learning", run: { id: "run_3", startedAt: hoursAgo(10), question: "方法提炼的内部问题" } },
    { projectId: "p1", run: { id: "run_4", startedAt: hoursAgo(24 * 40), question: "四十天前的问题" } },
  ],
};

/**
 * The phrases the model is scripted to find — from a memory, from a question,
 * from an item — and the vector each embeds to (one axis each).
 */
const PHRASES = [
  { text: "SGLT2 抑制剂与心衰", source: "memory", memory: "project", kind: "project_fact", vector: vectorAt(1) },
  { text: "心内科临床", source: "memory", memory: "profile", kind: "profile", vector: vectorAt(0, 1) },
  { text: "替尔泊肽与心衰", source: "question", kind: "question", vector: vectorAt(0, 2) },
];

function profiles({ embedder = { ...testEmbedder, embedQuery: async (text) => PHRASES.find((phrase) => phrase.text === text)?.vector ?? vectorAt(0, 9) },
  researchMemory = memory, budget = async () => ({ state: "ok" }), now = () => NOW, phrases = PHRASES } = {}) {
  const calls = [];
  const editor = {
    available: true,
    extractProfile: async (input) => {
      calls.push(input);
      return { specialties: ["cardiology"], dropped: [], error: null,
        phrases: phrases.map((phrase) => ({ text: phrase.text, source: phrase.source, kind: phrase.kind,
          memoryId: phrase.source === "memory" ? memories[phrase.memory].id : "" })) };
    },
  };
  return { calls, profiles: new FrontierProfiles({ database, researchMemory, editor, embedder, config: CONFIG, budget, now,
    conversations: async (userId) => RUNS[userId] ?? [] }) };
}

/** Published items with vectors, and what should keep each out or bring it in. */
async function seedItems() {
  const cardiology = { specialties: ["cardiology"], visibleAt: hoursAgo(5), timelineAt: hoursAgo(5) };
  return {
    exact: await insertComposedItem(database, { ...cardiology, sourceId: "nejm", title: "SGLT2 in HF", scoreTotal: 70, vector: vectorAt(1) }),
    clinic: await insertComposedItem(database, { ...cardiology, sourceId: "nejm", title: "Clinic", scoreTotal: 60, vector: vectorAt(0, 1) }),
    between: await insertComposedItem(database, { ...cardiology, sourceId: "stat", sourceType: "media", title: "Between", scoreTotal: 50, vector: vectorAt(0.6, 1) }),
    asked: await insertComposedItem(database, { ...cardiology, sourceId: "nejm", title: "Tirzepatide HFpEF", scoreTotal: 80, vector: vectorAt(0, 2) }),
    far: await insertComposedItem(database, { ...cardiology, sourceId: "stat", sourceType: "media", title: "Far", scoreTotal: 90, vector: vectorAt(0, 5) }),
    muted: await insertComposedItem(database, { ...cardiology, sourceId: "muted", sourceType: "media", title: "Muted", scoreTotal: 99, vector: vectorAt(1) }),
    old: await insertComposedItem(database, { ...cardiology, sourceId: "nejm", title: "Old", visibleAt: hoursAgo(24 * 8), timelineAt: hoursAgo(24 * 8), vector: vectorAt(1) }),
    // Another specialty, no entity in common: the editor's coarse cut kept it out; every item of the window is a candidate now.
    otherField: await insertComposedItem(database, { specialties: ["oncology"], sourceId: "nejm", title: "Oncology", visibleAt: hoursAgo(5), timelineAt: hoursAgo(5), vector: vectorAt(1) }),
    // Near the first phrase, after two nearer ones: the phrase is full.
    third: await insertComposedItem(database, { specialties: ["nephrology"], sourceId: "nejm", title: "Kidney and SGLT2",
      visibleAt: hoursAgo(4), timelineAt: hoursAgo(4), vector: vectorAt(0.9, 3) }),
    // What the reader starred and opened: read from, never recommended back.
    starred: await insertComposedItem(database, { ...cardiology, sourceId: "nejm", title: "Finerenone in HFpEF", titleZh: "非奈利酮用于射血分数保留心衰",
      scoreTotal: 90, vector: vectorAt(1), visibleAt: hoursAgo(24 * 20), timelineAt: hoursAgo(24 * 20) }),
    opened: await insertComposedItem(database, { ...cardiology, sourceId: "nejm", title: "AF ablation", titleZh: "房颤消融术后抗凝时长", scoreTotal: 90,
      vector: vectorAt(0, 1) }),
  };
}

async function mark(userId, itemId, column) {
  await database.query(`INSERT INTO evimed_frontier.user_state (user_id, item_id, ${column}) VALUES ($1, $2, $3)
    ON CONFLICT (user_id, item_id) DO UPDATE SET ${column} = EXCLUDED.${column}`, [userId, itemId, hoursAgo(1)]);
}

/** The service's hydration, in miniature: public id → a card with the reader's marks. */
async function hydrate(user, publicIds) {
  const rows = (await database.query(`SELECT i.public_id, i.title_raw, us.hidden_at IS NOT NULL AS hidden FROM evimed_frontier.items i
    LEFT JOIN evimed_frontier.user_state us ON us.item_id = i.id AND us.user_id = $2 WHERE i.public_id = ANY($1::text[])`, [publicIds, user.id])).rows;
  return new Map(rows.map((row) => [row.public_id, { id: row.public_id, title: row.title_raw, state: { hidden: row.hidden } }]));
}

test("a profile from memory of every provenance, the reader's questions and what they starred or opened; every item of the window ranked, two a phrase", options, async () => {
  const items = await seedItems();
  await mark(users.reader, items.starred.id, "starred_at");
  await mark(users.reader, items.opened.id, "read_at");
  await database.query("INSERT INTO evimed_frontier.user_follows (user_id, kind, key, label, muted) VALUES ($1, 'source', 'muted', 'Muted', true)", [users.reader]);
  const { calls, profiles: reader } = profiles();
  assert.equal(reader.state(), "available");
  assert.deepEqual(await reader.refreshUser(users.reader), { state: "available", phrases: 3 });
  assert.equal(calls.length, 1, "one model call for the whole profile");
  assert.deepEqual(calls[0].memories.map((entry) => entry.id).sort(), [memories.profile.id, memories.project.id, memories.inferred.id].sort(),
    "an inferred memory feeds the ranking too");
  assert.deepEqual(calls[0].questions.map((entry) => entry.text), ["替尔泊肽对射血分数保留心衰的住院结局有什么证据？"],
    "a deleted conversation, an internal project's and one older than 30 days are not read");
  assert.deepEqual(calls[0].items, [{ text: "非奈利酮用于射血分数保留心衰", starred: true }, { text: "房颤消融术后抗凝时长", starred: false }],
    "stars first, as the titles the reader saw");
  const stored = (await database.query("SELECT specialties, phrases, memory_mark FROM evimed_frontier.user_profiles WHERE user_id = $1", [users.reader])).rows[0];
  assert.deepEqual(stored.specialties, ["cardiology"]);
  assert.deepEqual(stored.phrases.map((phrase) => [phrase.source, phrase.memoryId === "" ? "" : "memory"]),
    [["memory", "memory"], ["memory", "memory"], ["question", ""]], "each phrase keeps where it came from");
  assert.equal(typeof stored.phrases[0].vector, "string", "the phrase vectors are kept with the profile for the reranks");
  assert.match(stored.memory_mark, /^3:\d+:/, "the memory it was read from, as a mark");

  const answer = await reader.forYou({ id: users.reader }, hydrate);
  assert.equal(answer.state, "available");
  assert.equal(answer.basis, "vector");
  assert.deepEqual(answer.items.map((entry) => [entry.item.title, entry.reason.topic, entry.reason.source]), [
    ["Tirzepatide HFpEF", "替尔泊肽与心衰", "question"],
    ["SGLT2 in HF", "SGLT2 抑制剂与心衰", "memory"],
    ["Clinic", "心内科临床", "memory"],
    ["Oncology", "SGLT2 抑制剂与心衰", "memory"],
    ["Between", "心内科临床", "memory"],
  ], "by cosine with a tenth of the editorial score; another specialty's item is a candidate; the first phrase full, Kidney is left out; "
    + "far, muted, older than seven days, starred and opened left out");
  assert.equal(answer.items[0].reason.memoryId, null, "a question names no memory");
  assert.equal(answer.items[1].reason.memoryId, memories.project.id);
});

test("what the reader hid pushes back: its event and its near-duplicates by meaning are left out", options, async () => {
  const cardiology = { specialties: ["cardiology"], visibleAt: hoursAgo(5), timelineAt: hoursAgo(5), sourceId: "nejm" };
  const hidden = await insertComposedItem(database, { ...cardiology, title: "Hidden story", vector: vectorAt(0, 6) });
  // cos 0.5 to the first phrase, 0.87 to the hidden item: the same story told again.
  const twin = await insertComposedItem(database, { ...cardiology, title: "Twin", scoreTotal: 90, vector: vectorAt(0.5, 6) });
  const sibling = await insertComposedItem(database, { ...cardiology, title: "Same event", scoreTotal: 90, vector: vectorAt(0.95, 7) });
  const kept = await insertComposedItem(database, { ...cardiology, title: "Kept", scoreTotal: 10, vector: vectorAt(0.45, 8) });
  const event = (await database.query(`INSERT INTO evimed_frontier.events (public_id, title_zh, lane, first_at, last_at, report_count)
    VALUES ($1, '同一事件', 'evidence', $2, $2, 2) RETURNING id`, [`e${suffix}hidden`, hoursAgo(5)])).rows[0].id;
  await database.query("UPDATE evimed_frontier.items SET event_id = $1 WHERE id = ANY($2::bigint[])", [event, [hidden.id, sibling.id]]);
  const { profiles: reader } = profiles({ phrases: [PHRASES[0]] });
  await reader.refreshUser(users.reader);
  const before = await reader.forYou({ id: users.reader }, hydrate);
  assert.deepEqual(before.items.map((entry) => entry.item.title), ["Same event", "Twin"], "two for the phrase, before any hide");
  await mark(users.reader, hidden.id, "hidden_at");
  await reader.noteItemAction(users.reader, "hide");
  const after = await reader.forYou({ id: users.reader }, hydrate);
  assert.deepEqual(after.items.map((entry) => entry.item.title), ["Kept"], "ranked again at once, in SQL: the hidden item's event and its twin are gone");
  assert.equal(reader.counters.hiddenDropped, 1, "the twin, by meaning");
  assert.ok(twin && kept);
});

test("a reason whose memory is gone takes its item with it at once; a question's reason stands", options, async () => {
  await seedItems();
  await database.query("INSERT INTO evimed_frontier.user_follows (user_id, kind, key, label, muted) VALUES ($1, 'source', 'muted', 'Muted', true)", [users.reader]);
  const { profiles: reader } = profiles();
  await reader.refreshUser(users.reader);
  const doomed = await memory.upsertRecord(users.reader, { scope: "user", kind: "profile", key: "profile.department", value: "心内科主治医师",
    summary: "心内科主治医师", origin: "explicit", status: "archived", confidence: 1, importance: 0.8 }, null, { expectedVersion: memories.profile.version });
  assert.equal(doomed.status, "archived");
  const answer = await reader.forYou({ id: users.reader }, hydrate);
  assert.deepEqual(answer.items.map((entry) => entry.item.title), ["Tirzepatide HFpEF", "SGLT2 in HF", "Oncology"]);
  assert.equal(reader.counters.reasonsDropped, 2);
  // Put it back for the tests after this one.
  memories.profile = await memory.upsertRecord(users.reader, { scope: "user", kind: "profile", key: "profile.department", value: "心内科主治医师",
    summary: "心内科主治医师", origin: "explicit", status: "active", confidence: 1, importance: 0.8 }, null, { expectedVersion: doomed.version });
  // Recall paused after the ranking was cached: the block is off at once, not at the next refresh.
  await memory.updateSettings(users.reader, { recallPaused: true });
  try {
    assert.deepEqual(await reader.forYou({ id: users.reader }, hydrate), { state: "off", basis: null, paused: true, items: [] });
  } finally {
    await memory.updateSettings(users.reader, { recallPaused: false });
  }
});

test("off for a reader who paused recall; nothing yet for one with nothing to read; a star is enough; unavailable while the memory store fails", options, async () => {
  const items = await seedItems();
  const { calls, profiles: reader } = profiles();
  assert.deepEqual(await reader.refreshUser(users.paused), { state: "off", reason: "recall-paused" });
  assert.deepEqual(await reader.forYou({ id: users.paused }, hydrate), { state: "off", basis: null, paused: true, items: [] });
  assert.deepEqual(await reader.refreshUser(users.empty), { state: "off", reason: "no-signal" });
  assert.deepEqual(await reader.forYou({ id: users.empty }, hydrate), { state: "available", basis: null, items: [] },
    "nothing yet is not a state of its own");
  assert.equal(calls.length, 0, "no model call for a reader with nothing to read");
  // A reader with no memory and no conversation, who starred one item.
  await mark(users.fresh, items.starred.id, "starred_at");
  await reader.refreshUser(users.fresh);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].memories, calls[0].questions, calls[0].items],
    [[], [], [{ text: "非奈利酮用于射血分数保留心衰", starred: true }]]);
  const broken = profiles({ researchMemory: { configured: true, settings: async () => ({ recallPaused: false, pausedProjects: [] }),
    listAllRecords: async () => { throw Object.assign(new Error("down"), { code: "memory_unavailable" }); } } }).profiles;
  await assert.rejects(broken.refreshUser(users.reader), { code: "memory_unavailable" });
  assert.equal(broken.state(), "unavailable");
  assert.deepEqual(await broken.forYou({ id: users.reader }, hydrate), { state: "unavailable", basis: null, items: [] });
  const modelless = new FrontierProfiles({ database, researchMemory: memory, config: { frontierAudience: "all" } });
  assert.equal(modelless.state(), "off");
  assert.deepEqual(await modelless.forYou({ id: users.reader }, hydrate), { state: "off", basis: null, items: [] });
});

test("without vectors the phrases are matched as keywords and the answer says so; a stale ranking is recomputed in SQL alone", options, async () => {
  await insertComposedItem(database, { specialties: ["cardiology"], sourceId: "nejm", title: "HF", titleZh: "SGLT2 抑制剂降低心衰住院", scoreTotal: 70,
    visibleAt: hoursAgo(3), timelineAt: hoursAgo(3) });
  await insertComposedItem(database, { specialties: ["cardiology"], sourceId: "nejm", title: "Other", titleZh: "房颤消融新技术", scoreTotal: 90,
    visibleAt: hoursAgo(3), timelineAt: hoursAgo(3) });
  let now = NOW;
  const { profiles: reader } = profiles({ embedder: { configured: false, modelKey: "none@1024" }, now: () => now, phrases: PHRASES.slice(0, 2) });
  await reader.refreshUser(users.reader);
  const first = await reader.forYou({ id: users.reader }, hydrate);
  assert.equal(first.basis, "tags");
  assert.deepEqual(first.items.map((entry) => [entry.item.title, entry.reason.memoryId]), [["HF", memories.project.id]]);
  const before = (await database.query("SELECT for_you_at FROM evimed_frontier.user_profiles WHERE user_id = $1", [users.reader])).rows[0].for_you_at;
  now = new Date(NOW.getTime() + 7 * 3_600_000);
  await insertComposedItem(database, { specialties: ["cardiology"], sourceId: "stat", sourceType: "media", title: "New", titleZh: "心衰新药上市",
    visibleAt: new Date(now.getTime() - 3_600_000).toISOString(), timelineAt: new Date(now.getTime() - 3_600_000).toISOString() });
  const second = await reader.forYou({ id: users.reader }, hydrate);
  const after = (await database.query("SELECT for_you_at FROM evimed_frontier.user_profiles WHERE user_id = $1", [users.reader])).rows[0].for_you_at;
  assert.ok(new Date(after).getTime() > new Date(before).getTime(), "older than six hours: ranked again");
  assert.ok(second.items.some((entry) => entry.item.title === "New"));
});

/** The profiles computed so far, by reader. */
async function computedAt() {
  const rows = (await database.query("SELECT user_id, computed_at FROM evimed_frontier.user_profiles WHERE user_id = ANY($1::text[])",
    [Object.values(users)])).rows;
  return new Map(rows.map((row) => [row.user_id, new Date(row.computed_at).getTime()]));
}

test("the round: missing and day-old profiles, and — at the next round, not the next day — any whose inputs changed; visitors first", options, async () => {
  const items = await seedItems();
  for (const state of ["exhausted", "throttled"]) {
    const spent = profiles({ budget: async () => ({ state }) });
    assert.deepEqual(await spent.profiles.refreshDue(), { refreshed: 0, ranked: 0, skipped: 0 }, `no profile while the budget is ${state}`);
    assert.equal(spent.calls.length, 0);
  }
  // A reader who opened 与我相关 and has no profile yet is computed first.
  let minute = 0;
  const clock = () => new Date(NOW.getTime() + minute * 60_000);
  const visitor = profiles({ now: clock });
  await visitor.profiles.forYou({ id: users.empty }, hydrate);
  minute += 1;
  assert.equal((await visitor.profiles.refreshDue({ limit: 1 })).refreshed, 1);
  assert.deepEqual([...(await computedAt()).keys()], [users.empty], "the visitor before the readers who did not open the block");
  minute += 1;
  const round = profiles({ now: clock });
  assert.equal((await round.profiles.refreshDue()).refreshed, 3, "the other readers seen in 14 days");
  assert.equal(round.calls.length, 1, "one model call: the reader with something to read");
  minute += 1;
  assert.deepEqual(await round.profiles.refreshDue(), { refreshed: 0, ranked: 0, skipped: 0 }, "nothing changed: nothing due");

  // A star: due at the next round.
  await mark(users.reader, items.clinic.id, "starred_at");
  await round.profiles.noteItemAction(users.reader, "star");
  minute += 5;
  const afterStar = profiles({ now: clock });
  assert.equal((await afterStar.profiles.refreshDue()).refreshed, 1);
  assert.equal(afterStar.calls.length, 1);
  assert.ok(afterStar.calls[0].items.some((item) => item.text === "Clinic" && item.starred), "the star is read");

  // A new memory, written by any writer: marked by the round itself.
  await memory.upsertRecord(users.reader, { scope: "user", kind: "project_fact", key: "project.af", value: "在做房颤消融的队列研究",
    summary: "在做房颤消融的队列研究", origin: "inferred", status: "active", confidence: 0.6, importance: 0.5 }, evidence("房颤消融"));
  minute += 5;
  const afterMemory = profiles({ now: clock });
  assert.equal((await afterMemory.profiles.refreshDue()).refreshed, 1, "a memory change makes the profile due");
  assert.ok(afterMemory.calls[0].memories.some((entry) => entry.text === "在做房颤消融的队列研究"));
  assert.ok(afterMemory.profiles.counters.staleMarks >= 1);

  // A new question in a conversation.
  afterMemory.profiles.noteConversation(users.reader, { id: "run_9", question: "房颤消融后多久停抗凝？" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  minute += 5;
  const afterQuestion = profiles({ now: clock });
  assert.equal((await afterQuestion.profiles.refreshDue()).refreshed, 1, "a new question makes the profile due");

  // A hide drops only the ranking: the round ranks again without a model call.
  await mark(users.reader, items.exact.id, "hidden_at");
  await afterQuestion.profiles.noteItemAction(users.reader, "hide");
  minute += 5;
  const afterHide = profiles({ now: clock });
  assert.deepEqual(await afterHide.profiles.refreshDue(), { refreshed: 0, ranked: 1, skipped: 0 });
  assert.equal(afterHide.calls.length, 0);

  // Seven hours on, the reader seen three days ago still has a ranking ready
  // before they come back: the background re-rank reaches every active reader.
  await database.query("UPDATE evimed_frontier.user_prefs SET last_seen_at = $2 WHERE user_id = $1", [users.reader, hoursAgo(72)]);
  const later = profiles({ now: () => new Date(NOW.getTime() + 7 * 3_600_000) });
  assert.equal((await later.profiles.refreshDue()).ranked, 1, "a ranking older than six hours is recomputed, in SQL alone");
  assert.equal(later.calls.length, 0);
});

test("a profile stored before the other signals existed reads as memory reasons, and is due at the first round", options, async () => {
  const items = await seedItems();
  await database.query(`INSERT INTO evimed_frontier.user_profiles (user_id, specialties, phrases, for_you, computed_at, for_you_at)
    VALUES ($1, '{cardiology}', $2::jsonb, $3::jsonb, $4, $4)`, [users.reader,
    JSON.stringify([{ text: "SGLT2 抑制剂与心衰", memoryId: memories.project.id, kind: "project_fact", vector: encodeVector(vectorAt(1)) }]),
    JSON.stringify({ state: "available", basis: "vector", items: [{ itemId: items.exact.publicId, text: "SGLT2 抑制剂与心衰", memoryId: memories.project.id,
      kind: "project_fact" }], computedAt: NOW.toISOString() }), NOW]);
  const { profiles: reader } = profiles();
  const answer = await reader.forYou({ id: users.reader }, hydrate);
  assert.deepEqual(answer.items.map((entry) => [entry.item.title, entry.reason.memoryId, entry.reason.source]),
    [["SGLT2 in HF", memories.project.id, "memory"]]);
  const round = profiles();
  await round.profiles.refreshDue();
  assert.equal(round.calls.length, 1, "no mark yet: due at the first round");
  assert.deepEqual([round.calls[0].memories.some((entry) => entry.id === memories.inferred.id), round.calls[0].questions.length], [true, 1],
    "read again with every signal");
});
