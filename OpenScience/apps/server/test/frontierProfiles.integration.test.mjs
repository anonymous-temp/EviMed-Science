// 「与你相关」 against a real PostgreSQL and a real memory store (build spec D.4):
// a profile from what the reader stated or confirmed, ranked by phrase vectors
// over the last 72 hours, each reason re-checked against the memory it names;
// the states a reader can be in; the keyword basis without vectors.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierProfiles } from "../src/frontierProfiles.mjs";
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
const users = { reader: `reader_${suffix}`, paused: `paused_${suffix}`, empty: `empty_${suffix}` };
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
  await insertSource(database, "nejm", { authority: 5 });
  await insertSource(database, "stat", { name: "STAT", source_type: "media", authority: 3 });
  await insertSource(database, "muted", { name: "Muted", source_type: "media" });
  for (const id of Object.values(users)) await database.query("INSERT INTO evimed_frontier.user_prefs (user_id, last_seen_at) VALUES ($1, $2)", [id, hoursAgo(2)]);
});

/** The phrases the model is scripted to find, and the vector each embeds to. */
const PHRASES = [
  { text: "SGLT2 抑制剂与心衰", memory: "project", vector: vectorAt(1) },
  { text: "心内科临床", memory: "profile", vector: vectorAt(0, 1) },
];

function profiles({ embedder = { ...testEmbedder, embedQuery: async (text) => PHRASES.find((phrase) => phrase.text === text)?.vector ?? vectorAt(0, 9) },
  researchMemory = memory, budget = async () => ({ state: "ok" }), now = () => NOW } = {}) {
  const calls = [];
  const editor = {
    available: true,
    extractProfile: async (input) => {
      calls.push(input);
      return { specialties: ["cardiology"], phrases: PHRASES.map((phrase) => ({ text: phrase.text, memoryId: memories[phrase.memory].id })), dropped: [], error: null };
    },
  };
  const glossary = { current: async () => new FrontierGlossary([{ kind: "drug", termEn: "SGLT2 inhibitors", termZh: "SGLT2 抑制剂", keepOriginal: false }]) };
  return { calls, profiles: new FrontierProfiles({ database, researchMemory, editor, embedder, glossary, config: CONFIG, budget, now }) };
}

/** Published items of the last 72 hours with vectors, and what should keep each out. */
async function seedItems() {
  const cardiology = { specialties: ["cardiology"], visibleAt: hoursAgo(5), timelineAt: hoursAgo(5) };
  return {
    exact: await insertComposedItem(database, { ...cardiology, sourceId: "nejm", title: "SGLT2 in HF", scoreTotal: 70, vector: vectorAt(1) }),
    clinic: await insertComposedItem(database, { ...cardiology, sourceId: "nejm", title: "Clinic", scoreTotal: 60, vector: vectorAt(0, 1) }),
    between: await insertComposedItem(database, { ...cardiology, sourceId: "stat", sourceType: "media", title: "Between", scoreTotal: 50, vector: vectorAt(0.6, 1) }),
    far: await insertComposedItem(database, { ...cardiology, sourceId: "stat", sourceType: "media", title: "Far", scoreTotal: 90, vector: vectorAt(0, 5) }),
    hidden: await insertComposedItem(database, { ...cardiology, sourceId: "nejm", title: "Hidden", scoreTotal: 99, vector: vectorAt(1) }),
    muted: await insertComposedItem(database, { ...cardiology, sourceId: "muted", sourceType: "media", title: "Muted", scoreTotal: 99, vector: vectorAt(1) }),
    old: await insertComposedItem(database, { ...cardiology, sourceId: "nejm", title: "Old", visibleAt: hoursAgo(80), timelineAt: hoursAgo(80), vector: vectorAt(1) }),
    otherField: await insertComposedItem(database, { specialties: ["oncology"], sourceId: "nejm", title: "Oncology", visibleAt: hoursAgo(5), timelineAt: hoursAgo(5), vector: vectorAt(1) }),
    entity: await insertComposedItem(database, { specialties: ["nephrology"], entityKeys: ["drug:sglt2 inhibitors"], sourceId: "nejm", title: "Kidney and SGLT2",
      visibleAt: hoursAgo(4), timelineAt: hoursAgo(4), vector: vectorAt(0.9, 3) }),
  };
}

async function hide(userId, itemId) {
  await database.query("INSERT INTO evimed_frontier.user_state (user_id, item_id, hidden_at) VALUES ($1, $2, now())", [userId, itemId]);
}

/** The service's hydration, in miniature: public id → a card with the reader's marks. */
async function hydrate(user, publicIds) {
  const rows = (await database.query(`SELECT i.public_id, i.title_raw, us.hidden_at IS NOT NULL AS hidden FROM evimed_frontier.items i
    LEFT JOIN evimed_frontier.user_state us ON us.item_id = i.id AND us.user_id = $2 WHERE i.public_id = ANY($1::text[])`, [publicIds, user.id])).rows;
  return new Map(rows.map((row) => [row.public_id, { id: row.public_id, title: row.title_raw, state: { hidden: row.hidden } }]));
}

test("a profile from stated and confirmed memories only, ranked by phrase vectors; hidden, muted, old and unrelated items left out", options, async () => {
  const items = await seedItems();
  await hide(users.reader, items.hidden.id);
  await database.query("INSERT INTO evimed_frontier.user_follows (user_id, kind, key, label, muted) VALUES ($1, 'source', 'muted', 'Muted', true)", [users.reader]);
  const { calls, profiles: reader } = profiles();
  assert.equal(reader.state(), "available");
  const refreshed = await reader.refreshUser(users.reader);
  assert.deepEqual(refreshed, { state: "available", phrases: 2 });
  assert.deepEqual(calls[0].memories.map((entry) => entry.id).sort(), [memories.profile.id, memories.project.id].sort(),
    "an inference never feeds the profile");
  const stored = (await database.query("SELECT specialties, phrases FROM evimed_frontier.user_profiles WHERE user_id = $1", [users.reader])).rows[0];
  assert.deepEqual(stored.specialties, ["cardiology"]);
  assert.equal(typeof stored.phrases[0].vector, "string", "the phrase vectors are kept with the profile for the reranks");

  const answer = await reader.forYou({ id: users.reader }, hydrate);
  assert.equal(answer.state, "available");
  assert.equal(answer.basis, "vector");
  assert.deepEqual(answer.items.map((entry) => [entry.item.title, entry.reason.text, entry.reason.memoryId]), [
    ["SGLT2 in HF", "因为你在做：SGLT2 抑制剂与心衰", memories.project.id],
    ["Clinic", "因为你关注：心内科临床", memories.profile.id],
    ["Kidney and SGLT2", "因为你在做：SGLT2 抑制剂与心衰", memories.project.id],
    ["Between", "因为你关注：心内科临床", memories.profile.id],
  ], "by cosine; the entity in common admits another specialty's item; far, hidden, muted, old and unrelated left out");
});

test("a reason whose memory is gone takes its item with it at once, without a new ranking", options, async () => {
  const items = await seedItems();
  await hide(users.reader, items.hidden.id);
  await hide(users.reader, items.muted.id);
  const { profiles: reader } = profiles();
  await reader.refreshUser(users.reader);
  const doomed = await memory.upsertRecord(users.reader, { scope: "user", kind: "profile", key: "profile.department", value: "心内科主治医师",
    summary: "心内科主治医师", origin: "explicit", status: "archived", confidence: 1, importance: 0.8 }, null, { expectedVersion: memories.profile.version });
  assert.equal(doomed.status, "archived");
  const answer = await reader.forYou({ id: users.reader }, hydrate);
  assert.deepEqual(answer.items.map((entry) => entry.item.title), ["SGLT2 in HF", "Kidney and SGLT2"]);
  assert.equal(reader.counters.reasonsDropped, 2);
  // Put it back for the tests after this one.
  memories.profile = await memory.upsertRecord(users.reader, { scope: "user", kind: "profile", key: "profile.department", value: "心内科主治医师",
    summary: "心内科主治医师", origin: "explicit", status: "active", confidence: 1, importance: 0.8 }, null, { expectedVersion: doomed.version });
  // Recall paused after the ranking was cached: the block is off at once, not at tomorrow's refresh.
  await memory.updateSettings(users.reader, { recallPaused: true });
  try {
    assert.deepEqual(await reader.forYou({ id: users.reader }, hydrate), { state: "off", basis: null, items: [] });
  } finally {
    await memory.updateSettings(users.reader, { recallPaused: false });
  }
});

test("off for a reader who paused recall or said nothing usable; unavailable while the memory store fails; off without a model", options, async () => {
  await seedItems();
  const { calls, profiles: reader } = profiles();
  assert.deepEqual(await reader.refreshUser(users.paused), { state: "off", reason: "recall-paused" });
  assert.deepEqual(await reader.forYou({ id: users.paused }, hydrate), { state: "off", basis: null, items: [] });
  assert.deepEqual(await reader.refreshUser(users.empty), { state: "off", reason: "no-memory" });
  assert.deepEqual(await reader.forYou({ id: users.empty }, hydrate), { state: "off", basis: null, items: [] });
  assert.equal(calls.length, 0, "no model call for a reader with nothing to read");
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
  const { profiles: reader } = profiles({ embedder: { configured: false, modelKey: "none@1024" }, now: () => now });
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

test("the round: readers seen lately without a profile or with a day-old one, only while the budget allows a call", options, async () => {
  await seedItems();
  for (const state of ["exhausted", "throttled"]) {
    const spent = profiles({ budget: async () => ({ state }) });
    assert.deepEqual(await spent.profiles.refreshDue(), { refreshed: 0, ranked: 0, skipped: 0 }, `no profile while the budget is ${state}`);
    assert.equal(spent.calls.length, 0);
  }
  const round = profiles();
  const summary = await round.profiles.refreshDue();
  assert.equal(summary.refreshed, 3, "each reader seen in 14 days gets a profile (two of them an empty one)");
  assert.equal(round.calls.length, 1, "one model call: the reader with something to read");
  assert.deepEqual(await round.profiles.refreshDue(), { refreshed: 0, ranked: 0, skipped: 0 }, "a day-old profile is not due for a day");
  // Seven hours on, the reader seen three days ago still has a ranking ready
  // before they come back: the background re-rank reaches every active reader.
  await database.query("UPDATE evimed_frontier.user_prefs SET last_seen_at = $2 WHERE user_id = $1", [users.reader, hoursAgo(72)]);
  const later = profiles({ now: () => new Date(NOW.getTime() + 7 * 3_600_000) });
  assert.equal((await later.profiles.refreshDue()).ranked, 1, "a ranking older than six hours is recomputed, in SQL alone");
  assert.equal(later.calls.length, 0);
});
