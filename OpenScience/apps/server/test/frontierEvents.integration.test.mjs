// The event layer against a real PostgreSQL (build spec D.1): clustering by
// identifier, by vector with a shared entity, by the model's verdict in the
// band; merges with their aliases, redirects and moved edges; the hot list and
// its versions; digests earned, rewritten on a new primary, kept on failure.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FrontierEvents } from "../src/frontierEvents.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { insertSource } from "./helpers/frontierFixtures.mjs";
import { eventOf, insertComposedItem, metaValue, resetFrontier, testEmbedder, vectorAt } from "./helpers/frontierComposeFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const NOW = new Date("2026-09-22T04:00:00Z");
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

let database;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
});

after(async () => {
  if (database) await database.close();
});

beforeEach(async () => {
  if (!database) return;
  await resetFrontier(database);
  await insertSource(database, "nejm", { authority: 5, owner_entity: "nejm-group" });
  await insertSource(database, "reuters", { name: "Reuters", source_type: "media", authority: 3, owner_entity: "reuters" });
  await insertSource(database, "stat", { name: "STAT", source_type: "media", authority: 3, owner_entity: "stat" });
  await insertSource(database, "yimaitong", { name: "医脉通", source_type: "media", authority: 2, owner_entity: "yimaitong" });
  await insertSource(database, "fda", { name: "FDA", lane: "regulatory", source_type: "regulator", authority: 5, owner_entity: "us-fda" });
  await insertSource(database, "ema", { name: "EMA", lane: "regulatory", source_type: "regulator", authority: 5, owner_entity: "eu-ema" });
  await insertSource(database, "ctgov", { name: "ClinicalTrials.gov", lane: "evidence", source_type: "evidence-body", authority: 4, owner_entity: "nlm" });
});

/** An editor stub: available, judging every pair as `verdict`, writing digests as told. */
function stubEditor({ verdict = "no", digest = null } = {}) {
  const calls = { judge: [], digest: [] };
  return {
    calls,
    available: true,
    judgeSameEvent: async (input) => { calls.judge.push(input); return { verdicts: input.candidates.map(() => verdict), error: null, attempts: 1 }; },
    writeEventDigest: async (input) => {
      calls.digest.push(input);
      return digest ?? { verification: "passed", digestZh: `综述第 ${calls.digest.length} 版`, latestZh: "最新一条", error: null };
    },
  };
}

function layer({ editor = null, budget = async () => ({ state: "ok" }), embedder = testEmbedder } = {}) {
  return new FrontierEvents({ database, editor, embedder, budget, now: () => NOW, config: {} });
}

test("identifiers: a trial's later news joins its first item's event; an unrelated item is an event of its own", options, async () => {
  const events = layer({ embedder: null });
  const paper = await insertComposedItem(database, { sourceId: "nejm", title: "FLOW trial", titleZh: "FLOW 试验", registryIds: ["NCT03819153"],
    visibleAt: hoursAgo(6), timelineAt: hoursAgo(6) });
  const lone = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Unrelated", visibleAt: hoursAgo(5), timelineAt: hoursAgo(5) });
  const before = await metaValue(database, "content_version");
  assert.deepEqual(await events.clusterPending(), { clustered: 2, created: 2, joined: 0, merged: 0, skipped: 0 });
  assert.equal(await metaValue(database, "content_version"), before, "a new singleton changes no card");
  const results = await insertComposedItem(database, { sourceId: "ctgov", sourceType: "evidence-body", evidenceType: "other", title: "FLOW results posted",
    identityKey: "reg:NCT03819153:results-posted:2026-09-21", registryIds: ["NCT03819153"], visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  assert.deepEqual(await events.clusterPending(), { clustered: 1, created: 0, joined: 1, merged: 0, skipped: 0 });
  const trial = await eventOf(database, paper.id);
  assert.equal((await eventOf(database, results.id)).id, trial.id);
  assert.notEqual((await eventOf(database, lone.id)).id, trial.id);
  assert.equal(await metaValue(database, "content_version"), before + 1, "a join is a change the cards show");
  const members = (await database.query("SELECT item_id, role, joined_by FROM evimed_frontier.event_items WHERE event_id = $1 ORDER BY item_id", [trial.id])).rows;
  assert.deepEqual(members.map((row) => [String(row.item_id), row.role, row.joined_by]),
    [[paper.id, "primary", "identifier"], [results.id, "report", "identifier"]]);
  assert.equal(trial.report_count, 2);
  assert.equal(trial.title_zh, "FLOW 试验", "the event is named by its primary source");
  assert.equal(trial.latest_zh, "FLOW results posted", "「最新进展」 is the newest report");
  assert.equal(await events.clusterPending().then((summary) => summary.clustered), 0, "an item is clustered once");
});

test("vectors: a shared drug and cosine ≥ 0.82 join; no shared entity never does; the band is asked, and not while the budget is not ok", options, async () => {
  // Each vector leans off the first item's axis on an axis of its own, so its
  // cosine to the first is chosen and to every other one is low.
  const editor = stubEditor({ verdict: "yes" });
  const events = layer({ editor });
  const first = await insertComposedItem(database, { sourceId: "nejm", title: "Semaglutide cuts kidney events", entityKeys: ["drug:semaglutide"],
    vector: vectorAt(1), visibleAt: hoursAgo(10), timelineAt: hoursAgo(10) });
  await events.clusterPending();
  const near = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Novo drug protects kidneys", entityKeys: ["drug:semaglutide", "org:novo"],
    vector: vectorAt(0.9, 1), visibleAt: hoursAgo(9), timelineAt: hoursAgo(9) });
  const stranger = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Metformin news", entityKeys: ["drug:metformin"],
    vector: vectorAt(0.95, 3), visibleAt: hoursAgo(8), timelineAt: hoursAgo(8) });
  await events.clusterPending();
  const story = await eventOf(database, first.id);
  assert.equal((await eventOf(database, near.id)).id, story.id);
  assert.notEqual((await eventOf(database, stranger.id)).id, story.id, "similar words about another drug are another event");
  assert.equal(editor.calls.judge.length, 0, "nothing in the band, nothing asked");

  const band = await insertComposedItem(database, { sourceId: "yimaitong", sourceType: "media", lang: "zh", title: "司美格鲁肽肾脏获益", entityKeys: ["drug:semaglutide"],
    vector: vectorAt(0.78, 2), visibleAt: hoursAgo(7), timelineAt: hoursAgo(7) });
  await events.clusterPending();
  assert.equal(editor.calls.judge.length, 1);
  assert.equal(editor.calls.judge[0].candidates.length, 1, "one pair per event, and only one event is in the band");
  assert.equal((await eventOf(database, band.id)).id, story.id, "`yes` joins");
  const joinedBy = (await database.query("SELECT item_id, joined_by FROM evimed_frontier.event_items WHERE event_id = $1 ORDER BY item_id", [story.id])).rows;
  assert.deepEqual(joinedBy.map((row) => row.joined_by), ["identifier", "vector", "model"]);
  const bilingual = await eventOf(database, first.id);
  assert.ok(bilingual.heat > 0);

  const throttled = layer({ editor, budget: async () => ({ state: "throttled" }) });
  const unasked = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Another take", entityKeys: ["drug:semaglutide"],
    vector: vectorAt(0.78, 4), visibleAt: hoursAgo(6), timelineAt: hoursAgo(6) });
  await throttled.clusterPending();
  assert.equal(editor.calls.judge.length, 1, "past 80% of the budget the band is not asked");
  assert.notEqual((await eventOf(database, unasked.id)).id, story.id);
  assert.equal(throttled.counters.adjudicationSkipped, 1);

  const related = layer({ editor: stubEditor({ verdict: "related" }) });
  const follow = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Label update follows", entityKeys: ["drug:semaglutide"],
    vector: vectorAt(0.74, 5), visibleAt: hoursAgo(5), timelineAt: hoursAgo(5) });
  await related.clusterPending();
  const own = await eventOf(database, follow.id);
  assert.notEqual(own.id, story.id);
  const links = (await database.query("SELECT relation, asserted_by FROM evimed_frontier.event_links WHERE from_event_id = $1 AND to_event_id = $2", [own.id, story.id])).rows;
  assert.deepEqual(links, [{ relation: "related", asserted_by: "model" }], "`related` is an edge, not a merge");
});

test("an item waits for its vector (30 min) and its edit (24 h); items older than seven days are left alone", options, async () => {
  const events = layer();
  const fresh = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Fresh", visibleAt: hoursAgo(0.2), timelineAt: hoursAgo(0.2) });
  const owed = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Owed its edit", verification: "pending",
    vector: vectorAt(0.1), visibleAt: hoursAgo(2), timelineAt: hoursAgo(2) });
  const old = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Old", visibleAt: hoursAgo(8 * 24), timelineAt: hoursAgo(8 * 24) });
  assert.equal((await events.clusterPending()).clustered, 0);
  await database.query("INSERT INTO evimed_frontier.item_vectors (item_id, model_key, embedding) VALUES ($1, $2, $3)",
    [fresh.id, testEmbedder.modelKey, `[${vectorAt(0.2).join(",")}]`]);
  assert.equal((await events.clusterPending()).clustered, 1, "the vector arrived");
  assert.ok(await eventOf(database, fresh.id));
  assert.equal(await eventOf(database, owed.id), null);
  assert.equal(await eventOf(database, old.id), null);
});

test("a bridge merges: the older event survives, the absorbed id redirects for good, members, edges and aliases move with it", options, async () => {
  const events = layer({ editor: stubEditor() });
  const oldest = await insertComposedItem(database, { sourceId: "fda", sourceType: "regulator", evidenceType: "regulatory-decision", title: "FDA approves X",
    registryIds: ["NCT07000001"], visibleAt: hoursAgo(30), timelineAt: hoursAgo(30) });
  const trialPaper = await insertComposedItem(database, { sourceId: "nejm", title: "Trial of X", registryIds: ["NCT09000001"], visibleAt: hoursAgo(20), timelineAt: hoursAgo(20) });
  const coverage = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "X coverage", entityKeys: ["drug:x"],
    vector: vectorAt(1), visibleAt: hoursAgo(12), timelineAt: hoursAgo(12) });
  const elsewhere = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Elsewhere", visibleAt: hoursAgo(11), timelineAt: hoursAgo(11) });
  await events.clusterPending();
  const [e0, e1, e2, e3] = await Promise.all([oldest, trialPaper, coverage, elsewhere].map((item) => eventOf(database, item.id)));
  await database.query(`INSERT INTO evimed_frontier.event_links (from_event_id, to_event_id, relation, asserted_by) VALUES ($1, $2, 'related', 'model')`, [e2.id, e3.id]);

  // One item that is the trial (registry id) and the coverage (vector): E1 and E2 are one event, and E1 is older.
  const bridge = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "X trial and its coverage", registryIds: ["NCT09000001"],
    clusterKeys: [], entityKeys: ["drug:x"], vector: vectorAt(0.95), visibleAt: hoursAgo(3), timelineAt: hoursAgo(3) });
  assert.equal((await events.clusterPending()).merged, 1);
  const survivor = await eventOf(database, bridge.id);
  assert.equal(survivor.id, e1.id, "the older event survives");
  assert.equal((await eventOf(database, coverage.id)).id, e1.id, "the absorbed event's members move");
  const absorbed = (await database.query("SELECT merged_into, status FROM evimed_frontier.events WHERE id = $1", [e2.id])).rows[0];
  assert.equal(String(absorbed.merged_into), String(e1.id));
  assert.equal(absorbed.status, "settled");
  assert.deepEqual((await database.query("SELECT event_id FROM evimed_frontier.event_aliases WHERE public_id = $1", [e2.public_id])).rows.map((row) => String(row.event_id)), [String(e1.id)]);
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.event_links WHERE from_event_id = $1 AND to_event_id = $2", [e1.id, e3.id])).rows[0].n, 1,
    "the absorbed event's edge moves to the survivor");
  assert.deepEqual(await events.read(e2.public_id), { redirect: e1.public_id });

  // A second merge flattens the chain: E1 folds into the older E0, and E2's old id now goes straight to E0.
  const second = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "FDA and the trial", registryIds: ["NCT07000001", "NCT09000001"],
    clusterKeys: [], visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  await layer({ embedder: null }).clusterPending();
  assert.equal((await eventOf(database, second.id)).id, e0.id);
  assert.equal((await eventOf(database, trialPaper.id)).id, e0.id);
  assert.deepEqual(await events.read(e1.public_id), { redirect: e0.public_id });
  assert.deepEqual(await events.read(e2.public_id), { redirect: e0.public_id }, "one hop, whatever the history");
  assert.equal(String((await database.query("SELECT merged_into FROM evimed_frontier.events WHERE id = $1", [e2.id])).rows[0].merged_into), String(e0.id));
  const page = await events.read(e0.public_id);
  assert.equal(page.event.public_id, e0.public_id);
  assert.equal(page.members[0].role, "primary", "the first-hand source leads the page");
  assert.equal(page.members.length, 5);
  assert.deepEqual(page.related.map((link) => [link.id, link.relation]), [[e3.public_id, "related"]]);
  assert.equal(await events.read("f0f0f0f0f0f0f0f0"), null);
  assert.equal(await events.read("../etc"), null);
});

test("the hot list: the eligible by decayed heat, a snapshot every run, hot_version only when the list moved, settled after 72 h", options, async () => {
  const events = layer({ embedder: null });
  const trial = await insertComposedItem(database, { sourceId: "nejm", title: "Trial", titleZh: "试验", registryIds: ["NCT01"], visibleAt: hoursAgo(20), timelineAt: hoursAgo(20) });
  await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Trial coverage", registryIds: ["NCT01"], clusterKeys: [], visibleAt: hoursAgo(10), timelineAt: hoursAgo(10) });
  const alone = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "One outlet", visibleAt: hoursAgo(2), timelineAt: hoursAgo(2) });
  // A safety notice is selected by rule (safety-bypass), so a regulator's
  // notice alone is hot; a routine regulator update below the line is not.
  const notice = await insertComposedItem(database, { sourceId: "fda", sourceType: "regulator", evidenceType: "safety-notice", title: "FDA warning",
    selected: true, selectedRule: "safety-bypass", safetyAlert: true, visibleAt: hoursAgo(30), timelineAt: hoursAgo(30) });
  const routine = await insertComposedItem(database, { sourceId: "ema", sourceType: "regulator", evidenceType: "regulatory-decision",
    title: "EPAR revision", visibleAt: hoursAgo(3), timelineAt: hoursAgo(3) });
  const stale = await insertComposedItem(database, { sourceId: "fda", sourceType: "regulator", evidenceType: "safety-notice", title: "Old warning", visibleAt: hoursAgo(80), timelineAt: hoursAgo(80) });
  await events.clusterPending();
  // An event past 72 h but still marked developing is settled by the hot run.
  await database.query("UPDATE evimed_frontier.events SET status = 'developing' WHERE id = (SELECT event_id FROM evimed_frontier.items WHERE id = $1)", [stale.id]);
  const hotBefore = await metaValue(database, "hot_version");
  const first = await events.computeHot();
  assert.equal(first.changed, true);
  assert.equal(await metaValue(database, "hot_version"), hotBefore + 1);
  const trialEvent = await eventOf(database, trial.id);
  const noticeEvent = await eventOf(database, notice.id);
  assert.deepEqual(first.ranking.map((entry) => entry.eventId), [trialEvent.public_id, noticeEvent.public_id],
    "two entities, then a regulator's primary alone; one outlet alone is not hot");
  assert.deepEqual(first.ranking[0], { rank: 1, eventId: trialEvent.public_id, sourceCount: 2, reportCount: 2, delta: null });
  assert.equal((await eventOf(database, alone.id)).status, "developing");
  const routineEvent = await eventOf(database, routine.id);
  assert.ok(routineEvent, "the routine update has its own event");
  assert.ok(!first.ranking.some((entry) => entry.eventId === routineEvent.public_id), "an unselected regulator update alone is not hot");
  assert.equal((await eventOf(database, stale.id)).status, "settled");
  const again = await events.computeHot();
  assert.equal(again.changed, false);
  assert.equal(again.ranking[0].delta, 0);
  assert.equal(await metaValue(database, "hot_version"), hotBefore + 1, "an unchanged list does not move the version");
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.hot_snapshots")).rows[0].n >= 1, true);
  const list = await events.hotList();
  assert.deepEqual(list.events.map((event) => [event.rank, event.id, event.primary, event.sourceCount72h, event.reportCount, event.status]), [
    [1, trialEvent.public_id, "paper", 2, 2, "developing"],
    [2, noticeEvent.public_id, "official", 1, 1, "developing"],
  ]);
  assert.equal(list.events[0].title, "试验");
  assert.equal(list.events[0].latest, "Trial coverage");
  assert.equal(list.events[0].heat, undefined, "heat is never on the wire");
});

test("digests: earned by the hot list or a primary with two reports, rewritten on a new primary, kept when a rewrite fails", options, async () => {
  const editor = stubEditor();
  const events = layer({ editor, embedder: null });
  const paper = await insertComposedItem(database, { sourceId: "nejm", title: "Paper", registryIds: ["NCT02"], visibleAt: hoursAgo(20), timelineAt: hoursAgo(20) });
  await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Lone report", visibleAt: hoursAgo(19), timelineAt: hoursAgo(19) });
  await events.clusterPending();
  assert.deepEqual(await events.writeDigests(), { written: 0, dropped: 0, skipped: 0 }, "a lone primary or a lone report earns no digest");
  await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Coverage", registryIds: ["NCT02"], clusterKeys: [], visibleAt: hoursAgo(10), timelineAt: hoursAgo(10) });
  await events.clusterPending();
  assert.equal((await events.writeDigests()).written, 1);
  let event = await eventOf(database, paper.id);
  assert.equal(event.digest_zh, "综述第 1 版");
  assert.equal(event.digest_state, "written");
  assert.equal(editor.calls.digest[0].reports[0].role, "primary", "primary sources first");
  assert.deepEqual((await database.query("SELECT revision, cause FROM evimed_frontier.event_revisions WHERE event_id = $1", [event.id])).rows, [{ revision: 1, cause: "new-primary" }]);
  assert.equal((await events.writeDigests()).written, 0, "nothing new, nothing written");

  await insertComposedItem(database, { sourceId: "yimaitong", sourceType: "media", lang: "zh", title: "报道", registryIds: ["NCT02"], clusterKeys: [], visibleAt: hoursAgo(5), timelineAt: hoursAgo(5) });
  await events.clusterPending();
  event = await eventOf(database, paper.id);
  assert.equal(event.digest_state, "stale");
  assert.equal(event.latest_zh, "报道");
  assert.equal((await events.writeDigests()).written, 0, "a report alone does not buy a rewrite");

  await insertComposedItem(database, { sourceId: "fda", sourceType: "regulator", evidenceType: "regulatory-decision", title: "FDA acts", registryIds: ["NCT02"], clusterKeys: [],
    visibleAt: hoursAgo(2), timelineAt: hoursAgo(2) });
  await events.clusterPending();
  const failing = layer({ editor: stubEditor({ digest: { verification: "dropped", digestZh: null, latestZh: null, error: null } }), embedder: null });
  assert.equal((await failing.writeDigests()).dropped, 1);
  assert.equal((await eventOf(database, paper.id)).digest_zh, "综述第 1 版", "a failed rewrite keeps the previous digest");
  assert.equal((await layer({ editor, embedder: null, budget: async () => ({ state: "throttled" }) }).writeDigests()).written, 0, "not while the budget is not ok");
  assert.equal((await events.writeDigests()).written, 1);
  event = await eventOf(database, paper.id);
  assert.equal(event.digest_zh, "综述第 2 版");
  assert.equal(event.digest_revision, 2);
  assert.equal(editor.calls.digest[1].previousDigest, "综述第 1 版", "the previous version goes with the rewrite, so contradictions are marked");
});
