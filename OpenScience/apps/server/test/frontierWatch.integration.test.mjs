import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import { FrontierFollowWatch, FRONTIER_FOLLOW_SCAN_LIMIT } from "../src/frontierFollowMatches.mjs";
import { encodeVector } from "../src/frontierProfiles.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { TEST_VOCABULARY, insertItem, insertSource } from "./helpers/frontierFixtures.mjs";
import { createTypedFollow } from "./helpers/typedFollows.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const alice = { id: "alice" };
const bob = { id: "bob" };
const NOW = new Date("2026-10-25T12:00:00.000Z");
const at = (/** @type {number} */ minutes) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

const glossary = new FrontierGlossary([
  { kind: "drug", termEn: "semaglutide", termZh: "司美格鲁肽" },
  { kind: "disease", termEn: "pancreatitis", termZh: "胰腺炎" },
  { kind: "disease", termEn: "heart failure", termZh: "心力衰竭" },
]);

let db, isolated, service, watch, clock, answer, parsed;
/** @type {{ available: boolean, callJson: (messages: any, limits: any) => Promise<any> }} */
const editor = {
  available: true,
  async callJson(messages) {
    parsed.push(JSON.parse(messages[1].content).typed);
    if (answer instanceof Error) throw answer;
    return answer;
  },
};

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "watch");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('alice','Alice','development'),('bob','Bob','development')");
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.items, evimed_frontier.user_follows, evimed_frontier.user_prefs, evimed_frontier.follow_matches CASCADE");
  await db.query("DELETE FROM evimed_frontier.sources");
  await insertSource(db, "nejm");
  clock = new Date(NOW);
  answer = {
    kind: "question",
    concepts: [
      { type: "drug", zh: ["司美格鲁肽"], en: ["semaglutide"] },
      { type: "disease", zh: ["胰腺炎"], en: ["pancreatitis"] },
    ],
  };
  parsed = [];
  watch = new FrontierFollowWatch({ database: db, editor, glossary: { current: async () => glossary }, now: () => clock, dimension: 1024 });
  service = new FrontierService({
    database: db, vocabulary: frontierVocabularyView(TEST_VOCABULARY), config: { frontierEnabled: true, frontierAudience: "all" },
    profiles: null, watch, now: () => clock,
  });
});

/** An item visible `minutes` from NOW, about the named things. */
async function publish(minutes, title, { keys = [], titleZh = null, summaryZh = null, state = "published" } = {}) {
  const item = await insertItem(db, { title, titleZh, summaryZh, state, visibleAt: at(minutes), timelineAt: at(minutes), publishedAt: at(minutes) });
  if (keys.length) await db.query("UPDATE evimed_frontier.items SET entity_keys = $2 WHERE id = $1", [item.id, keys]);
  return item;
}
const feed = async (user, followId) => (await service.listItems(user, new URLSearchParams({ view: "all", follow: followId }))).body.items.map((/** @type {any} */ row) => row.id);
// Typed follows became zones (2026-10-29); the matching below still serves the follows that are left until the notices are replaced.
const typed = (user, label) => createTypedFollow({ db, watch, service, now: () => clock }, user, label);

test("a typed follow is stored with how its words were read, and lists the items that are about every thing it names", options, async () => {
  const both = await publish(-60, "Semaglutide and acute pancreatitis: a cohort", { keys: ["drug:semaglutide", "disease:pancreatitis"] });
  await publish(-60, "Semaglutide and weight loss in adults", { keys: ["drug:semaglutide"] });
  await publish(-60, "Pancreatitis after endoscopy", { keys: ["disease:pancreatitis"] });
  const byWords = await publish(-30, "司美格鲁肽与胰腺炎风险", { titleZh: "司美格鲁肽与胰腺炎风险" });
  await publish(-30, "Heart failure outcomes", { keys: ["disease:heart failure"] });
  const { follow } = await typed(alice, "司美格鲁肽 和胰腺炎");
  assert.equal(follow.kind, "query");
  assert.equal(follow.label, "司美格鲁肽 和胰腺炎");
  assert.equal(follow.newItems, 0, "what was there before the follow is not new");
  assert.equal(follow.query.kind, "question");
  assert.deepEqual(follow.query.concepts, [["司美格鲁肽", "semaglutide"], ["胰腺炎", "pancreatitis"]]);
  assert.deepEqual(parsed, ["司美格鲁肽 和胰腺炎"]);
  const listed = await feed(alice, follow.id);
  assert.deepEqual(new Set(listed), new Set([both.publicId, byWords.publicId]), "both concepts, by key or by words; neither half alone");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.follow_matches")).rows[0].n, 2);
  assert.equal((await db.query("SELECT kind, query->>'version' AS v, matched_through FROM evimed_frontier.user_follows")).rows[0].v, "follow-query-1");
  assert.ok((await db.query("SELECT matched_through FROM evimed_frontier.user_follows")).rows[0].matched_through, "the backfill ran");
});

test("the backfill reaches seven days back and no further, and withdrawn or unpublished items are not listed", options, async () => {
  const week = await publish(-6 * 24 * 60, "Semaglutide pancreatitis signal", { keys: ["drug:semaglutide", "disease:pancreatitis"] });
  await publish(-8 * 24 * 60, "Semaglutide pancreatitis old report", { keys: ["drug:semaglutide", "disease:pancreatitis"] });
  await publish(-10, "Semaglutide pancreatitis unpublished", { keys: ["drug:semaglutide", "disease:pancreatitis"], state: "scored" });
  const { follow } = await typed(alice, "司美格鲁肽 和胰腺炎");
  assert.deepEqual(await feed(alice, follow.id), [week.publicId]);
  await db.query("UPDATE evimed_frontier.items SET state = 'withdrawn' WHERE id = $1", [week.id]);
  assert.deepEqual(await feed(alice, follow.id), [], "a withdrawn item leaves the feed with no cleanup of the match");
});

test("items published after the follow are found by the sweep, once each, newest first, and counted new until the reader opens it", options, async () => {
  const { follow } = await typed(alice, "司美格鲁肽 和胰腺炎");
  assert.deepEqual(await feed(alice, follow.id), []);
  const first = await publish(5, "Semaglutide and pancreatitis in a registry", { keys: ["drug:semaglutide", "disease:pancreatitis"] });
  await publish(6, "Unrelated oncology trial", { keys: ["disease:lung cancer"] });
  clock = new Date(at(10));
  assert.deepEqual(await watch.sweep(), { followed: 1, matched: 1, failed: 0 });
  const second = await publish(12, "Another semaglutide pancreatitis case series", { keys: ["drug:semaglutide", "disease:pancreatitis"] });
  clock = new Date(at(20));
  assert.deepEqual(await watch.sweep(), { followed: 1, matched: 1, failed: 0 });
  // The overlap rescans the first item: it is not matched twice.
  clock = new Date(at(25));
  assert.deepEqual(await watch.sweep(), { followed: 1, matched: 0, failed: 0 });
  assert.deepEqual(await feed(alice, follow.id), [second.publicId, first.publicId]);
  const [row] = (await service.listFollows(alice)).follows;
  assert.equal(row.newItems, 2);
  const seen = await service.markFollowSeen(alice, follow.id);
  assert.equal(seen.follow.newItems, 0);
  assert.ok(seen.follow.seenAt);
  assert.equal((await service.listFollows(alice)).follows[0].newItems, 0);
  await publish(40, "A third semaglutide pancreatitis report", { keys: ["drug:semaglutide", "disease:pancreatitis"] });
  clock = new Date(at(45));
  await watch.sweep();
  assert.equal((await service.listFollows(alice)).follows[0].newItems, 1, "only what came after they looked");
});

test("c3 review: an item committed after the sweep had passed its visible time is found by the next sweep", options, async () => {
  const { follow } = await typed(alice, "司美格鲁肽 和胰腺炎");
  clock = new Date(at(30));
  await watch.sweep();
  // A long round: the item carries the round's start (minute 5) as its visible time, and is committed at minute 32.
  const late = await publish(5, "Semaglutide pancreatitis, committed late in its round", { keys: ["drug:semaglutide", "disease:pancreatitis"] });
  await db.query("UPDATE evimed_frontier.items SET updated_at = $2 WHERE id = $1", [late.id, at(32)]);
  clock = new Date(at(33));
  assert.deepEqual(await watch.sweep(), { followed: 1, matched: 1, failed: 0 });
  assert.deepEqual(await feed(alice, follow.id), [late.publicId]);
});

test("a sweep leaves a follow whose scan is recent alone, and finds a follow whose backfill failed", options, async () => {
  const { follow } = await typed(alice, "司美格鲁肽 和胰腺炎");
  clock = new Date(at(0.5));
  assert.deepEqual(await watch.sweep(), { followed: 0, matched: 0, failed: 0 }, "scanned half a minute ago");
  await db.query("UPDATE evimed_frontier.user_follows SET matched_through = NULL WHERE id = $1", [follow.id]);
  await publish(-60 * 24, "Semaglutide pancreatitis day-old report", { keys: ["drug:semaglutide", "disease:pancreatitis"] });
  assert.deepEqual(await watch.sweep(), { followed: 1, matched: 1, failed: 0 });
});

test("new matches move the reader's state version, so a feed read before them is not answered 304", options, async () => {
  const { follow } = await typed(alice, "司美格鲁肽 和胰腺炎");
  const before = await service.listItems(alice, new URLSearchParams({ view: "all", follow: follow.id }));
  assert.equal((await service.listItems(alice, new URLSearchParams({ view: "all", follow: follow.id }), before.etag)).status, 304);
  await publish(5, "Semaglutide pancreatitis again", { keys: ["drug:semaglutide", "disease:pancreatitis"] });
  clock = new Date(at(10));
  await watch.sweep();
  const after = await service.listItems(alice, new URLSearchParams({ view: "all", follow: follow.id }), before.etag);
  assert.equal(after.status, 200);
  assert.equal(after.body.items.length, 1);
});

test("a model that fails still stores the follow, and it matches by the typed words", options, async () => {
  answer = Object.assign(new Error("budget"), { code: "usage_budget_exceeded" });
  const found = await publish(-60, "Long COVID rehabilitation trial", { titleZh: "长新冠康复试验" });
  await publish(-60, "COVID vaccine uptake", {});
  const { follow } = await typed(alice, "long covid");
  assert.equal(follow.label, "long covid");
  assert.deepEqual(follow.query.concepts, [["long covid"]]);
  assert.deepEqual(await feed(alice, follow.id), [found.publicId]);
  answer = { concepts: [] };
  const { follow: second } = await typed(alice, "长新冠");
  assert.deepEqual(await feed(alice, second.id), [found.publicId]);
});

test("a follow of someone else's, and one that does not exist, is not opened", options, async () => {
  const { follow } = await typed(alice, "司美格鲁肽 和胰腺炎");
  await assert.rejects(service.markFollowSeen(bob, follow.id), { code: "frontier_follow_not_found" });
  await assert.rejects(service.markFollowSeen(alice, "999999"), { code: "frontier_follow_not_found" });
  await assert.rejects(service.markFollowSeen(alice, "x"), { code: "frontier_follow_not_found" });
  assert.deepEqual(await feed(bob, follow.id).catch((error) => error.code), "frontier_follow_not_found");
});

test("removing a follow removes its matches; the other kinds are counted new too, through the predicate their feed uses", options, async () => {
  const { follow } = await typed(alice, "司美格鲁肽 和胰腺炎");
  await publish(-30, "Semaglutide pancreatitis", { keys: ["drug:semaglutide", "disease:pancreatitis"] });
  await service.createFollow(alice, { kind: "drug", key: "semaglutide", label: "司美格鲁肽" });
  await service.createFollow(alice, { kind: "topic", key: "heart failure", label: "heart failure" });
  // The generic follows are stamped by the database's clock; the test's items are on the test's.
  await db.query("UPDATE evimed_frontier.user_follows SET created_at = $1 WHERE kind IN ('drug', 'topic')", [NOW.toISOString()]);
  clock = new Date(at(5));
  await publish(10, "Semaglutide in obesity", { keys: ["drug:semaglutide"] });
  await publish(11, "Heart failure with preserved ejection fraction", {});
  await publish(12, "Semaglutide pancreatitis follow-up", { keys: ["drug:semaglutide", "disease:pancreatitis"] });
  clock = new Date(at(20));
  await watch.sweep();
  const counts = Object.fromEntries((await service.listFollows(alice)).follows.map((row) => [row.kind, row.newItems]));
  assert.deepEqual(counts, { query: 1, drug: 2, topic: 1 });
  await service.deleteFollow(alice, follow.id);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.follow_matches")).rows[0].n, 0);
});

test("an item the reader hid is not counted new, and a source switched off takes its items out", options, async () => {
  const { follow } = await typed(alice, "司美格鲁肽 和胰腺炎");
  const hidden = await publish(5, "Semaglutide pancreatitis hidden", { keys: ["drug:semaglutide", "disease:pancreatitis"] });
  await publish(6, "Semaglutide pancreatitis shown", { keys: ["drug:semaglutide", "disease:pancreatitis"] });
  clock = new Date(at(10));
  await watch.sweep();
  assert.equal((await service.listFollows(alice)).follows[0].newItems, 2);
  await service.setItemState(alice, hidden.publicId, "hide");
  assert.equal((await service.listFollows(alice)).follows[0].newItems, 1);
  await db.query("UPDATE evimed_frontier.sources SET enabled = false WHERE id = 'nejm'");
  assert.equal((await service.listFollows(alice)).follows[0].newItems, 0);
  assert.deepEqual(await feed(alice, follow.id), []);
});

test("the count stops at ninety-nine", options, async () => {
  await typed(alice, "司美格鲁肽 和胰腺炎");
  for (let index = 0; index < 105; index += 1) await publish(1 + index / 100, `Semaglutide pancreatitis report ${index}`, { keys: ["drug:semaglutide", "disease:pancreatitis"] });
  clock = new Date(at(10));
  await watch.sweep();
  assert.equal((await service.listFollows(alice)).follows[0].newItems, 99);
  assert.ok((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.follow_matches")).rows[0].n <= FRONTIER_FOLLOW_SCAN_LIMIT);
});

test("the typed words alone, when the model gives nothing, still need every word", options, async () => {
  answer = null;
  await publish(-30, "Gut microbiome and depression", {});
  const only = await publish(-30, "Gut microbiome and depression in adolescents trial", {});
  const { follow } = await typed(alice, "microbiome depression");
  const found = new Set(await feed(alice, follow.id));
  assert.equal(found.size, 2, "both words are in both titles");
  assert.ok(found.has(only.publicId));
  const { follow: narrow } = await typed(alice, "microbiome adolescents");
  assert.deepEqual(await feed(alice, narrow.id), [only.publicId]);
});

test("a query with no key also takes the items near its words by embedding, and a keyed one does not", options, async () => {
  const dimension = 1024;
  const vector = (/** @type {number} */ hot) => Array.from({ length: dimension }, (_, index) => (index === hot ? 1 : 0));
  const embedder = { configured: true, modelKey: "test@1024", dimension, embedQuery: async () => vector(3) };
  watch = new FrontierFollowWatch({ database: db, editor, embedder, glossary: { current: async () => glossary }, now: () => clock, dimension, config: { frontierFollowMinCosinePercent: 60 } });
  service = new FrontierService({ database: db, vocabulary: frontierVocabularyView(TEST_VOCABULARY), config: { frontierEnabled: true, frontierAudience: "all" },
    profiles: null, watch, now: () => clock });
  const capabilities = await migrateFrontier(db, { dimension });
  if (!capabilities.vector) return;
  const near = await publish(-30, "Intestinal flora and mood disorders", {});
  const far = await publish(-30, "Knee arthroplasty outcomes", {});
  const type = capabilities.halfvec ? "halfvec" : "vector";
  for (const [item, hot] of [[near, 3], [far, 900]]) {
    await db.query(`INSERT INTO evimed_frontier.item_vectors (item_id, model_key, embedding, embedded_at) VALUES ($1, 'test@1024', $2::${type}, now())`, [item.id, `[${vector(hot).join(",")}]`]);
  }
  answer = { kind: "question", concepts: [{ type: "topic", zh: ["肠道菌群", "抑郁"], en: [] }] };
  const { follow } = await typed(alice, "肠道菌群和抑郁");
  assert.deepEqual(await feed(alice, follow.id), [near.publicId]);
  const stored = (await db.query("SELECT query FROM evimed_frontier.user_follows WHERE id = $1", [follow.id])).rows[0].query;
  assert.equal(stored.vector_model, "test@1024");
  assert.equal(typeof stored.vector, "string");
  assert.equal(JSON.stringify((await service.listFollows(alice)).follows[0]).includes(stored.vector), false, "the vector is never sent");
  assert.equal(stored.vector, encodeVector(vector(3)));
  // A keyed query takes no embedding at all.
  answer = { kind: "drug", concepts: [{ type: "drug", zh: ["司美格鲁肽"], en: [] }] };
  const { follow: keyed } = await typed(alice, "司美格鲁肽");
  const keyedStored = (await db.query("SELECT query FROM evimed_frontier.user_follows WHERE id = $1", [keyed.id])).rows[0].query;
  assert.equal(keyedStored.vector, undefined);
  assert.deepEqual(await feed(alice, keyed.id), []);
});

test("the daily issue lists, for the reader alone, the typed follows with news and no other kind, nor any in the weekly", options, async () => {
  const issue = (/** @type {string} */ day) => ({ day, weekStart: day, weekEnd: "2026-10-25", windowStart: at(-1440), windowEnd: at(0), generatedAt: at(0), lead: null, sections: [], safety: [],
    aiMinute: null, markdown: "日报", previousDay: null, nextDay: null });
  const daily = { async read(/** @type {string} */ day) { return issue(day); } };
  service = new FrontierService({ database: db, vocabulary: frontierVocabularyView(TEST_VOCABULARY), config: { frontierEnabled: true, frontierAudience: "all" },
    profiles: null, watch, daily, weekly: daily, now: () => clock });
  const semaglutide = await typed(alice, "司美格鲁肽 和胰腺炎");
  await service.createFollow(alice, { kind: "drug", key: "semaglutide", label: "司美格鲁肽" });
  await typed(alice, "没有新动态的词");
  await publish(5, "Semaglutide pancreatitis once", { keys: ["drug:semaglutide", "disease:pancreatitis"] });
  await publish(6, "Semaglutide pancreatitis twice", { keys: ["drug:semaglutide", "disease:pancreatitis"] });
  clock = new Date(at(10));
  await watch.sweep();
  const mine = (await service.issue(alice, "2026-10-25")).daily.followedQueries;
  assert.deepEqual(mine, [{ id: semaglutide.follow.id, label: "司美格鲁肽 和胰腺炎", newItems: 2 }]);
  assert.deepEqual((await service.issue(bob, "2026-10-25")).daily.followedQueries, [], "another reader's issue holds none of it");
  assert.deepEqual((await service.issue(alice, "2026-10-19", true)).weekly.followedQueries, [], "the weekly names none");
  await service.markFollowSeen(alice, semaglutide.follow.id);
  assert.deepEqual((await service.issue(alice, "2026-10-25")).daily.followedQueries, [], "opened, it is no longer news");
});

test("全部关注 lists what typed follows matched beside what the other follows list, once, and 与我相关's reasons name the typed words", options, async () => {
  const { follow } = await typed(alice, "司美格鲁肽 和胰腺炎");
  await service.createFollow(alice, { kind: "topic", key: "heart failure", label: "heart failure" });
  const both = await publish(-30, "Semaglutide and pancreatitis", { keys: ["drug:semaglutide", "disease:pancreatitis"] });
  const topic = await publish(-20, "Heart failure registry");
  await publish(-10, "Unrelated oncology report");
  clock = new Date(at(5));
  await watch.scan({ id: follow.id, userId: "alice", query: (await db.query("SELECT query FROM evimed_frontier.user_follows WHERE id = $1", [follow.id])).rows[0].query }, { since: new Date(at(-60)), until: clock });
  const listed = (await service.listItems(alice, new URLSearchParams({ view: "all", follow: "all" }))).body.items.map((/** @type {any} */ row) => row.id);
  assert.deepEqual(new Set(listed), new Set([both.publicId, topic.publicId]));
  assert.equal(listed.length, 2, "an item two follows list is listed once");
  const read = await service.subscriptions.read("alice");
  assert.deepEqual(read.follows.filter((entry) => entry.kind === "query").map((entry) => entry.label), ["司美格鲁肽 和胰腺炎"]);
});
