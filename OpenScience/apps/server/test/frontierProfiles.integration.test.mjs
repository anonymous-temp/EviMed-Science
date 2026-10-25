// 「与你相关」 against a real PostgreSQL and the memory engine's files (build spec D.4; rebuilt
// 2026-09-24, read from the engine's files since 2026-10-25): a profile from the reader's memory lines,
// their recent questions and the items they starred or opened; every item of
// the window ranked by phrase vectors, no phrase picking more than two; what
// they hid pushing its near-duplicates out; each memory reason re-checked
// against the memory it names; the states a reader can be in; the keyword
// basis without vectors; and a profile due at the next round once its inputs
// change.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FRONTIER_RANKING, FrontierProfiles, encodeVector } from "../src/frontierProfiles.mjs";
import { MemorySettingsStore } from "../src/memorySettings.mjs";
import { migrateMemorySettings } from "../src/memorySettingsPersistence.mjs";
import { NativeMemoryOverlay } from "../src/nativeMemoryOverlay.mjs";
import { migrateNativeMemory } from "../src/nativeMemoryPersistence.mjs";
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
let overlay;
const memories = {};

/**
 * The memory engine's side, in memory: the files of each reader, and what the store would answer for them. A change is made the way the
 * engine's store makes one — the file, and the overlay's record of it (its file row and a revision), which is what the profile's memory
 * mark reads. The mark moving under the real store's operations is held in frontierProfileMark.integration.test.mjs.
 */
const held = new Map();
const nativeMemory = {
  configured: true,
  failing: false,
  async files(/** @type {string} */ userId) {
    if (nativeMemory.failing) throw Object.assign(new Error("the engine is down"), { code: "memory_engine_unavailable" });
    return structuredClone(held.get(userId) ?? []);
  },
};
const lineId = (uri, text) => `native:${uri}#${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
/** Write (or replace) one memory file of a reader, with one line of text; returns the profile's name for the line. */
async function writeFile(userId, rel, type, text, { projectId = null } = {}) {
  const uri = `viking://user/${userId}/memories/${rel}`;
  const files = held.get(userId) ?? [];
  const at = files.findIndex((file) => file.uri === uri);
  const body = `- ${text}`;
  const file = { uri, type, body, hash: createHash("sha256").update(body).digest("hex"), sensitive: false, projectId, modTime: NOW.toISOString() };
  if (at >= 0) files[at] = file; else files.push(file);
  held.set(userId, files);
  await overlay.upsertFile({ userId, uri, memoryType: type, body, ...(projectId ? { projectId } : {}) });
  await overlay.addRevision({ userId, uri, memoryType: type, change: at >= 0 ? "updated" : "added", actor: "engine", reason: "", before: null, after: body });
  return { id: lineId(uri, text), uri, text };
}
/** Take a file out of a reader's memory, as a forget does: the file is gone and the overlay says so. */
async function dropFile(userId, uri) {
  const type = held.get(userId).find((file) => file.uri === uri).type;
  held.set(userId, held.get(userId).filter((file) => file.uri !== uri));
  await overlay.removeFile(userId, uri);
  await overlay.addRevision({ userId, uri, memoryType: type, change: "deleted", actor: "user", reason: "forgotten", before: "x", after: null });
}

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
  for (const id of Object.values(users)) await database.query("INSERT INTO evimed_control.users(id, name, auth_type) VALUES ($1, $1, 'development')", [id]);
  // The memory schema is the settings store's (the server migrates it first); a database of its own has none yet.
  await migrateMemorySettings(database);
  await migrateNativeMemory(database);
  memory = new MemorySettingsStore({}, { database });
  overlay = new NativeMemoryOverlay({ database });
  memories.project = await writeFile(users.reader, "projects/sglt2.md", "project_context", "正在做 SGLT2 抑制剂与心衰住院的 Meta 分析");
  memories.profile = await writeFile(users.reader, "profile.md", "profile", "心内科主治医师");
  memories.inferred = await writeFile(users.reader, "preferences/oncology.md", "preferences", "可能关注肿瘤免疫");
  await writeFile(users.paused, "profile.md", "profile", "肿瘤科");
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
  memorySettings = memory, budget = async () => ({ state: "ok" }), now = () => NOW, phrases = PHRASES } = {}) {
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
  // The exploration draw takes the first of its pool, so a test knows which item it is.
  return { calls, profiles: new FrontierProfiles({ database, memorySettings, nativeMemory, editor, embedder, config: CONFIG, budget, now, random: () => 0,
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
    "every line of the three files feeds the ranking");
  assert.deepEqual(calls[0].questions.map((entry) => entry.text), ["替尔泊肽对射血分数保留心衰的住院结局有什么证据？"],
    "a deleted conversation, an internal project's and one older than 30 days are not read");
  assert.deepEqual(calls[0].items, [{ text: "非奈利酮用于射血分数保留心衰", starred: true }, { text: "房颤消融术后抗凝时长", starred: false }],
    "stars first, as the titles the reader saw");
  const stored = (await database.query("SELECT specialties, phrases, memory_mark FROM evimed_frontier.user_profiles WHERE user_id = $1", [users.reader])).rows[0];
  assert.deepEqual(stored.specialties, ["cardiology"]);
  assert.deepEqual(stored.phrases.map((phrase) => [phrase.source, phrase.memoryId === "" ? "" : "memory"]),
    [["memory", "memory"], ["memory", "memory"], ["question", ""]], "each phrase keeps where it came from");
  assert.equal(typeof stored.phrases[0].vector, "string", "the phrase vectors are kept with the profile for the reranks");
  assert.match(stored.memory_mark, /^3:[\d.]+:\d+$/, "the memory it was read from, as a mark: three files, the latest change, the newest revision");

  const answer = await reader.forYou({ id: users.reader }, hydrate);
  assert.equal(answer.state, "available");
  assert.equal(answer.basis, "vector");
  assert.deepEqual(answer.items.map((entry) => [entry.item.title, entry.reason.topic, entry.reason.source]), [
    ["Tirzepatide HFpEF", "替尔泊肽与心衰", "question"],
    ["SGLT2 in HF", "SGLT2 抑制剂与心衰", "memory"],
    ["Oncology", "SGLT2 抑制剂与心衰", "memory"],
    ["Clinic", "心内科临床", "memory"],
    ["Between", "心内科临床", "memory"],
    ["Far", "心血管", "specialty"],
  ], "by cosine with the editorial share; another specialty's item is a candidate; the first phrase full, Kidney is left out; each topic's "
    + "entries together, in the order of its best; the specialty the model read (心血管, finally used) brings in Far, of 精选 quality, which no "
    + "phrase is near; muted, older than seven days, starred and opened left out");
  assert.deepEqual(answer.items.map((entry) => entry.slot), ["personal", "personal", "personal", "personal", "personal", "personal"],
    "nothing outside the profile is good enough to explore with, and no safety alert is in the window");
  assert.equal(answer.policy, FRONTIER_RANKING.policy);
  assert.equal(answer.onboarding, false, "a reader the platform knows is not asked");
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
  // The reader forgets the profile file: its line, and the two items that rested on it, leave at once, with no refresh in between.
  await dropFile(users.reader, memories.profile.uri);
  const answer = await reader.forYou({ id: users.reader }, hydrate);
  assert.deepEqual(answer.items.map((entry) => entry.item.title), ["Tirzepatide HFpEF", "SGLT2 in HF", "Oncology", "Far"]);
  assert.equal(reader.counters.reasonsDropped, 2);
  // Put it back for the tests after this one.
  memories.profile = await writeFile(users.reader, "profile.md", "profile", "心内科主治医师");
  // Recall paused after the ranking was cached: the block is off at once, not at the next refresh.
  await memory.updateSettings(users.reader, { recallPaused: true });
  try {
    assert.deepEqual(await reader.forYou({ id: users.reader }, hydrate), { state: "off", basis: null, paused: true, items: [] });
  } finally {
    await memory.updateSettings(users.reader, { recallPaused: false });
  }
});

test("off for a reader who paused recall; nothing yet for one with nothing to read; a star is enough; unavailable while the memory engine fails", options, async () => {
  const items = await seedItems();
  const { calls, profiles: reader } = profiles();
  assert.deepEqual(await reader.refreshUser(users.paused), { state: "off", reason: "recall-paused" });
  assert.deepEqual(await reader.forYou({ id: users.paused }, hydrate), { state: "off", basis: null, paused: true, items: [] });
  assert.deepEqual(await reader.refreshUser(users.empty), { state: "off", reason: "no-signal" });
  const nothing = await reader.forYou({ id: users.empty }, hydrate);
  assert.deepEqual([nothing.state, nothing.basis, nothing.onboarding], ["available", null, true],
    "nothing yet is not a state of its own, and a reader the platform knows nothing of is asked");
  assert.deepEqual(nothing.items.map((entry) => [entry.item.title, entry.slot, entry.reason.topic, entry.propensity]), [["Muted", "explore", "精选", 0.333333]],
    "no item of the window is 精选, so the block is the exploration entry alone: the best of three items of 精选 quality, drawn with its probability");
  assert.equal(calls.length, 0, "no model call for a reader with nothing to read");
  // A reader with no memory and no conversation, who starred one item.
  await mark(users.fresh, items.starred.id, "starred_at");
  await reader.refreshUser(users.fresh);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].memories, calls[0].questions, calls[0].items],
    [[], [], [{ text: "非奈利酮用于射血分数保留心衰", starred: true }]]);
  nativeMemory.failing = true;
  const broken = profiles().profiles;
  await assert.rejects(broken.refreshUser(users.reader), { code: "memory_engine_unavailable" });
  assert.equal(broken.state(), "unavailable");
  // What does not come from memory is still served while the store is down: the editor's and the exploration entry.
  const degraded = await broken.forYou({ id: users.reader }, hydrate);
  assert.deepEqual([degraded.state, degraded.items.map((entry) => entry.slot)], ["available", ["explore"]]);
  nativeMemory.failing = false;
  // A store that cannot say whether the reader paused recall answers nothing it cannot stand behind.
  const silent = profiles({ memorySettings: { configured: true, settings: async () => { throw Object.assign(new Error("down"), { code: "memory_unavailable" }); } } }).profiles;
  assert.deepEqual(await silent.forYou({ id: users.reader }, hydrate), { state: "unavailable", basis: null, items: [] });
  const modelless = new FrontierProfiles({ database, memorySettings: memory, config: { frontierAudience: "all" } });
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
  assert.deepEqual(first.items.map((entry) => [entry.item.title, entry.reason.memoryId, entry.reason.source]),
    [["HF", memories.project.id, "memory"], ["Other", null, "specialty"]], "a keyword hit, then the specialty's item of 精选 quality");
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
  await writeFile(users.reader, "projects/af.md", "project_context", "在做房颤消融的队列研究");
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
    JSON.stringify({ state: "available", basis: "vector", policy: FRONTIER_RANKING.policy, items: [{ itemId: items.exact.publicId, text: "SGLT2 抑制剂与心衰",
      memoryId: memories.project.id, kind: "project_fact" }], computedAt: NOW.toISOString() }), NOW]);
  const { profiles: reader } = profiles();
  const answer = await reader.forYou({ id: users.reader }, hydrate);
  assert.deepEqual(answer.items.map((entry) => [entry.item.title, entry.reason.memoryId, entry.reason.source, entry.slot]),
    [["SGLT2 in HF", memories.project.id, "memory", "personal"]], "a cached entry with no source or slot reads as a memory reason, personal");
  // A ranking cached under another policy (or none) is ranked again at once, so a list is never recorded under a policy that did not make it.
  await database.query("UPDATE evimed_frontier.user_profiles SET for_you = for_you - 'policy' WHERE user_id = $1", [users.reader]);
  const reranked = await reader.forYou({ id: users.reader }, hydrate);
  assert.equal(reranked.policy, FRONTIER_RANKING.policy);
  assert.ok(reranked.items.length > 1, "ranked again with the current policy");
  const round = profiles();
  await round.profiles.refreshDue();
  assert.equal(round.calls.length, 1, "no mark yet: due at the first round");
  assert.deepEqual([round.calls[0].memories.some((entry) => entry.id === memories.inferred.id), round.calls[0].questions.length], [true, 1],
    "read again with every signal");
});

/** A tag of the tree, active, and the items carrying it. @param {string} slug @param {string} name @param {string[]} itemIds */
async function tagItems(slug, name, itemIds) {
  const tag = (await database.query(`INSERT INTO evimed_frontier.tags (slug, name, state, origin) VALUES ($1, $2, 'active', 'seed')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [slug, name])).rows[0].id;
  for (const itemId of itemIds) {
    await database.query("INSERT INTO evimed_frontier.item_tags (item_id, tag_id, rank, origin) VALUES ($1, $2, 0, 'edit') ON CONFLICT DO NOTHING", [itemId, tag]);
  }
  return tag;
}

test("a reader the model knows nothing of is ranked from what they stated: onboarding, a follow, the must-see, the editor and one drawn entry", options, async () => {
  await insertSource(database, "fda", { name: "FDA", lane: "regulatory", source_type: "regulator", authority: 5, owner_entity: "us-fda" });
  const recent = { visibleAt: hoursAgo(3), timelineAt: hoursAgo(3) };
  const items = {
    alert: await insertComposedItem(database, { sourceId: "fda", lane: "safety", sourceType: "regulator", evidenceType: null, safetyAlert: true, selected: true,
      title: "Class I recall", visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) }),
    tagged: await insertComposedItem(database, { ...recent, sourceId: "nejm", title: "Empagliflozin outcomes", scoreTotal: 50 }),
    followed: await insertComposedItem(database, { ...recent, sourceId: "stat", sourceType: "media", title: "STAT story", scoreTotal: 45 }),
    cardioPick: await insertComposedItem(database, { ...recent, sourceId: "nejm", title: "Cardiology pick", specialties: ["cardiology"], scoreTotal: 88, selected: true }),
    cardioWeak: await insertComposedItem(database, { ...recent, sourceId: "nejm", title: "Cardiology weak", specialties: ["cardiology"], scoreTotal: 40 }),
    otherPick: await insertComposedItem(database, { ...recent, sourceId: "nejm", title: "Oncology pick", specialties: ["oncology"], scoreTotal: 95, selected: true }),
    unmatched: await insertComposedItem(database, { ...recent, sourceId: "nejm", title: "Nephrology good", specialties: ["nephrology"], scoreTotal: 85 }),
  };
  const slug = `sglt2-${suffix}`;
  await tagItems(slug, "SGLT2 抑制剂", [items.tagged.id]);
  const { FrontierTagStore } = await import("../src/frontierTags.mjs");
  const reader = new FrontierProfiles({ database, memorySettings: memory, editor: { available: true, extractProfile: async () => ({ phrases: [], specialties: [], error: null }) },
    embedder: { configured: false, modelKey: "none@1024" }, config: CONFIG, now: () => NOW, random: () => 0, tags: new FrontierTagStore({ database, now: () => NOW }) });
  const before = await reader.forYou({ id: users.fresh }, hydrate);
  assert.equal(before.onboarding, true, "nothing known and nothing answered: the card is shown");
  assert.deepEqual(before.items.map((entry) => [entry.item.title, entry.slot]).slice(0, 1), [["Class I recall", "must-see"]]);
  await reader.savePrefs(users.fresh, { role: "pharmacist", specialties: ["cardiology"], interests: [slug], done: true });
  await database.query("INSERT INTO evimed_frontier.user_follows (user_id, kind, key, label) VALUES ($1, 'source', 'stat', 'STAT')", [users.fresh]);
  const answer = await reader.forYou({ id: users.fresh }, hydrate);
  assert.equal(answer.onboarding, false, "answered: never asked again");
  assert.deepEqual(answer.items.map((entry) => [entry.item.title, entry.slot, entry.reason.topic, entry.reason.source]), [
    ["Class I recall", "must-see", "安全警示", "must-see"],
    ["Empagliflozin outcomes", "personal", "SGLT2 抑制剂", "interest"],
    ["STAT story", "personal", "STAT", "follow"],
    ["Nephrology good", "explore", "其他领域精选", "explore"],
    ["Cardiology pick", "personal", "心血管", "specialty"],
    ["Oncology pick", "editorial", "精选", "editorial"],
  ], "the alert first; what they stated, in rank order, each topic once; the one good item nothing matched, drawn, at the first boundary from the "
    + "fourth place; the editor's pick in the room left; a weak item of their specialty is not 精选 quality");
  const drawn = answer.items.find((entry) => entry.slot === "explore");
  assert.equal(drawn.propensity, 1, "a pool of one");
  assert.ok(answer.items.every((entry) => typeof entry.score === "number"));
  const prefs = await reader.prefs(users.fresh);
  assert.deepEqual([prefs.role, prefs.specialties, prefs.interests, prefs.interestTags], ["pharmacist", ["cardiology"], [slug], [{ slug, name: "SGLT2 抑制剂" }]]);
  // Changed an hour later from 管理关注: the answer moves, its first time stays (a changed answer is not a second onboarding).
  const later = new FrontierProfiles({ database, memorySettings: memory, config: CONFIG, now: () => new Date(NOW.getTime() + 3_600_000), tags: reader.tags });
  const changed = await later.savePrefs(users.fresh, { specialties: ["cardiology", "oncology"], done: true });
  assert.deepEqual([changed.specialties, changed.onboardedAt], [["cardiology", "oncology"], prefs.onboardedAt]);
  // Skipping is an answer too, for a reader who has not given one.
  await reader.savePrefs(users.empty, { skipped: true });
  assert.equal((await reader.forYou({ id: users.empty }, hydrate)).onboarding, false);
});

test("what the reader reads leans their block: papers read to the end come before news scrolled past, of the same score and reason", options, async () => {
  const recent = { visibleAt: hoursAgo(3), timelineAt: hoursAgo(3), specialties: ["cardiology"], selected: true, scoreTotal: 88 };
  const news = await insertComposedItem(database, { ...recent, sourceId: "stat", sourceType: "media", title: "Cardiology news" });
  const paper = await insertComposedItem(database, { ...recent, sourceId: "nejm", title: "Cardiology trial" });
  const reader = new FrontierProfiles({ database, memorySettings: memory, embedder: { configured: false, modelKey: "none@1024" }, config: CONFIG,
    now: () => NOW, random: () => 0, ranking: { ...FRONTIER_RANKING, explore: { ...FRONTIER_RANKING.explore, slots: 0 } } });
  await reader.savePrefs(users.fresh, { specialties: ["cardiology"], done: true });
  const neutral = await reader.forYou({ id: users.fresh }, hydrate);
  assert.deepEqual(neutral.items.map((entry) => entry.item.title), ["Cardiology news", "Cardiology trial"], "no history and no role: a tie, the older row first");
  // Their last weeks: papers seen, opened and read to the end; news seen and never opened.
  const history = [];
  for (let index = 0; index < 4; index += 1) {
    const read = await insertComposedItem(database, { sourceId: "nejm", title: `Old trial ${index}`, visibleAt: hoursAgo(24 * 9), timelineAt: hoursAgo(24 * 9) });
    const skipped = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: `Old news ${index}`, visibleAt: hoursAgo(24 * 9), timelineAt: hoursAgo(24 * 9) });
    history.push([read.id, "paper", "impression"], [read.id, "paper", "open"], [read.id, "paper", "reach-end"], [skipped.id, "news", "impression"]);
  }
  for (const [index, [itemId, genre, type]] of history.entries()) {
    await database.query(`INSERT INTO evimed_frontier.interactions (user_id, client_id, type, surface, item_id, genre, session_id, client_at)
      VALUES ($1, $2, $3, 'feed', $4, $5, 'ses_00000001', $6)`, [users.fresh, `evt_${suffix}_h${index}`, type, itemId, genre, hoursAgo(24 * 8)]);
  }
  await database.query("UPDATE evimed_frontier.user_profiles SET for_you_at = NULL WHERE user_id = $1", [users.fresh]);
  const leaning = await reader.forYou({ id: users.fresh }, hydrate);
  assert.deepEqual(leaning.items.map((entry) => entry.item.title), ["Cardiology trial", "Cardiology news"]);
  assert.ok(news && paper);
});

/** A reader's hide of an item, as the table keeps it: when, and the reason they gave (none is null). */
async function hide(userId, item, { daysAgo = 5, reason = null } = {}) {
  await database.query(`INSERT INTO evimed_frontier.user_state (user_id, item_id, hidden_at, hidden_reason) VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, item_id) DO UPDATE SET hidden_at = EXCLUDED.hidden_at, hidden_reason = EXCLUDED.hidden_reason`,
  [userId, item.id, hoursAgo(24 * daysAgo), reason]);
}

test("what the reader said was not their specialty lowers it for them for ninety days, except what they stated (c2-hide)", options, async () => {
  const recent = { visibleAt: hoursAgo(3), timelineAt: hoursAgo(3), selected: true, sourceId: "nejm" };
  const oncology = await insertComposedItem(database, { ...recent, title: "Oncology A", specialties: ["oncology"], scoreTotal: 88 });
  await insertComposedItem(database, { ...recent, title: "Oncology B", specialties: ["oncology"], scoreTotal: 86 });
  await insertComposedItem(database, { ...recent, title: "Cardiology A", specialties: ["cardiology"], scoreTotal: 80 });
  assert.ok(oncology);
  const reader = new FrontierProfiles({ database, memorySettings: memory, embedder: { configured: false, modelKey: "none@1024" }, config: CONFIG,
    now: () => NOW, random: () => 0, ranking: { ...FRONTIER_RANKING, explore: { ...FRONTIER_RANKING.explore, slots: 0 } } });
  const order = async (userId = users.fresh) => {
    await database.query("UPDATE evimed_frontier.user_profiles SET for_you_at = NULL WHERE user_id = $1", [userId]);
    return (await reader.forYou({ id: userId }, hydrate)).items.map((entry) => entry.item.title);
  };
  assert.deepEqual(await order(), ["Oncology A", "Oncology B", "Cardiology A"], "by the editor's score while nobody has said anything");
  // Three oncology items hidden as 「不是我的专科」, and three more hidden for other reasons, which say nothing of a specialty.
  const said = [];
  for (let index = 0; index < 3; index += 1) {
    said.push(await insertComposedItem(database, { ...recent, title: `Said ${index}`, specialties: ["oncology"], scoreTotal: 70 }));
    await hide(users.fresh, said[index], { reason: "not-my-specialty" });
    await hide(users.fresh, await insertComposedItem(database, { ...recent, title: `Other ${index}`, specialties: ["oncology"], scoreTotal: 70 }),
      { reason: ["already-seen", "promotional", null][index] });
  }
  assert.deepEqual(await order(), ["Cardiology A", "Oncology A", "Oncology B"],
    "three hides take twelve points off the specialty: the 80 now leads the 88 and the 86; the other reasons moved nothing");
  assert.ok((await reader.rank(users.fresh)).policy === FRONTIER_RANKING.policy);
  assert.ok(reader.counters.demotedRanks >= 1);
  // One that is older than the window is forgotten; another reader's word is not this reader's.
  for (const item of said) await hide(users.fresh, item, { reason: "not-my-specialty", daysAgo: FRONTIER_RANKING.notMySpecialty.windowDays + 1 });
  assert.deepEqual(await order(), ["Oncology A", "Oncology B", "Cardiology A"], "ninety days and it is no longer said");
  for (const item of said) await hide(users.paused, item, { reason: "not-my-specialty" });
  assert.deepEqual(await order(), ["Oncology A", "Oncology B", "Cardiology A"], "what another reader said is theirs");
  // What they stated in onboarding stands over a hide of one item: oncology is theirs, so those hides lower nothing.
  for (const item of said) await hide(users.fresh, item, { reason: "not-my-specialty" });
  assert.deepEqual(await order(), ["Cardiology A", "Oncology A", "Oncology B"]);
  await reader.savePrefs(users.fresh, { specialties: ["oncology"], done: true });
  const stated = await order();
  assert.equal(stated[0], "Oncology A", `the reader's own specialty is not lowered (${stated.join(", ")})`);
});

test("「看过了」 keeps an item out and counts against no genre; any other hide is one more failure of it (c2-hide)", options, async () => {
  const recent = { visibleAt: hoursAgo(3), timelineAt: hoursAgo(3), selected: true, specialties: ["cardiology"] };
  await insertComposedItem(database, { ...recent, sourceId: "stat", sourceType: "media", title: "Cardiology news", scoreTotal: 88 });
  await insertComposedItem(database, { ...recent, sourceId: "nejm", title: "Cardiology trial", scoreTotal: 76 });
  const reader = new FrontierProfiles({ database, memorySettings: memory, embedder: { configured: false, modelKey: "none@1024" }, config: CONFIG,
    now: () => NOW, random: () => 0, ranking: { ...FRONTIER_RANKING, explore: { ...FRONTIER_RANKING.explore, slots: 0 } } });
  await reader.savePrefs(users.fresh, { specialties: ["cardiology"], done: true });
  // Their last week: four news items seen, then hidden — with the reason in both records the way the page writes it.
  const history = [];
  for (let index = 0; index < 4; index += 1) {
    const old = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: `Old news ${index}`, visibleAt: hoursAgo(24 * 9), timelineAt: hoursAgo(24 * 9) });
    await hide(users.fresh, old, { daysAgo: 8, reason: "already-seen" });
    history.push([old.id, "impression", null], [old.id, "hide", "already-seen"]);
  }
  for (const [index, [itemId, type, detail]] of history.entries()) {
    await database.query(`INSERT INTO evimed_frontier.interactions (user_id, client_id, type, surface, item_id, genre, detail, session_id, client_at)
      VALUES ($1, $2, $3, 'feed', $4, 'news', $5, 'ses_00000001', $6)`, [users.fresh, `evt_${suffix}_s${index}`, type, itemId, detail, hoursAgo(24 * 8)]);
  }
  const order = async () => {
    await database.query("UPDATE evimed_frontier.user_profiles SET for_you_at = NULL WHERE user_id = $1", [users.fresh]);
    return (await reader.forYou({ id: users.fresh }, hydrate)).items.map((entry) => entry.item.title);
  };
  assert.deepEqual(await order(), ["Cardiology news", "Cardiology trial"],
    "four news items seen and hidden as already seen: the genre is lowered only by the impressions, not enough to pass a trial 12 points behind");
  await database.query("UPDATE evimed_frontier.user_state SET hidden_reason = NULL WHERE user_id = $1 AND hidden_reason = 'already-seen'", [users.fresh]);
  await database.query("UPDATE evimed_frontier.interactions SET detail = NULL WHERE user_id = $1 AND type = 'hide'", [users.fresh]);
  assert.deepEqual(await order(), ["Cardiology trial", "Cardiology news"], "the same four hides with no reason are four failures of the genre, and the trial passes");
});
