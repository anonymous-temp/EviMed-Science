// The re-clustering sweep against a real PostgreSQL (c3-cluster 2026-10-25): events that were placed apart are compared, the model's
// verdicts folded in through the one merge, and what must hold afterwards does — one selected report, a stale digest, the old public
// id answering a redirect, the heat and the hot list counted again, the content version moved. Also: what is not asked again, a
// verdict about an event that changed since is refused, a related pair becomes one link, a spent budget stops the run.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_GROUP_INSTRUCTIONS, FRONTIER_GROUP_PAIR_INSTRUCTIONS } from "../src/frontierEventGrouping.mjs";
import { FrontierEvents } from "../src/frontierEvents.mjs";
import { FRONTIER_RECLUSTER_INSTRUCTIONS, FRONTIER_RECLUSTER_PAIR_INSTRUCTIONS } from "../src/frontierRecluster.mjs";
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
  await insertSource(database, "stat", { name: "STAT", source_type: "media", authority: 3, owner_entity: "stat" });
  await insertSource(database, "reuters", { name: "Reuters", source_type: "media", authority: 3, owner_entity: "reuters" });
  await insertSource(database, "pr", { name: "PR Newswire", lane: "industry", source_type: "company", authority: 2, owner_entity: "prnewswire" });
});

/**
 * An editor stub: the placement's grouping calls answer UNRELATED for every candidate (so each item is an event of its own, as the
 * review found them), the sweep's batch call answers with `verdict(a, b)` per pair (`a` and `b` the two events' first titles), and
 * its second look with `second(a, b)`. `onBatch` runs before the batch answer (a hook for an event that changes while the model
 * is read).
 */
function stubEditor({ verdict = () => "SAME", second = null, onBatch = null } = {}) {
  const calls = { batch: [], pair: [], other: 0 };
  /** The two events of each block of a batch prompt: the titles of the first report each lists. */
  const titles = (input) => input.split("═══ 配对").slice(1).map((block) => [...block.matchAll(/事件标题（系统概括，以下面的报道为准）：([^\n]*)/g)].map((match) => match[1]));
  return {
    calls,
    available: true,
    callJson: async (messages) => {
      const [system, user] = [messages[0].content, messages[1].content];
      if (system === FRONTIER_GROUP_INSTRUCTIONS) {
        const candidates = (user.match(/【候选 C\d+】/g) ?? []).length;
        return { query: "q", selection: { addsValue: true, reason: "新" }, decisions: Array.from({ length: candidates }, (_, index) => ({ id: `C${index + 1}`, relation: "UNRELATED", confidence: 0.9, note: "" })) };
      }
      if (system === FRONTIER_GROUP_PAIR_INSTRUCTIONS) return { relation: "UNRELATED", confidence: 0.9, difference: "" };
      if (system === FRONTIER_RECLUSTER_INSTRUCTIONS) {
        const pairs = titles(user);
        calls.batch.push(pairs);
        if (onBatch) await onBatch(pairs);
        return { pairs: pairs.map((pair, index) => ({ id: `P${index + 1}`, relation: verdict(...pair), confidence: 0.9, reason: "测试" })) };
      }
      if (system === FRONTIER_RECLUSTER_PAIR_INSTRUCTIONS) {
        const pair = [...user.matchAll(/事件标题（系统概括，以下面的报道为准）：([^\n]*)/g)].map((match) => match[1]);
        calls.pair.push(pair);
        return { relation: (second ?? verdict)(...pair), confidence: 0.9, difference: "" };
      }
      calls.other += 1;
      throw new Error("an unexpected call");
    },
    writeJson: async () => ({ verification: "passed", output: { title: "t", digest: "d" } }),
  };
}

function layer({ editor = stubEditor(), budget = async () => ({ state: "ok" }), config = {} } = {}) {
  return new FrontierEvents({ database, editor, embedder: testEmbedder, budget, now: () => NOW, config });
}

let axis = 1;
/** A published item placed in an event of its own (the placement judged every candidate unrelated). */
async function placed(events, spec) {
  axis += 1;
  const { genre = "news", score = 50, selected = false, rule = null, zh = false, safety = false, vectorAxis = axis, hours = 10, ...rest } = spec;
  const item = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", evidenceType: "other", lang: zh ? "zh" : "en", vector: vectorAt(0, vectorAxis),
    visibleAt: hoursAgo(hours), timelineAt: hoursAgo(hours), scoreTotal: score, selected, selectedRule: rule, safetyAlert: safety, ...rest });
  await database.query("UPDATE evimed_frontier.items SET genre = $2, selected_at = CASE WHEN $3::boolean THEN clock_timestamp() ELSE NULL END WHERE id = $1",
    [item.id, genre, selected]);
  await events.clusterPending();
  return { ...item, event: await eventOf(database, item.id) };
}

const selectedIds = async (ids) => (await database.query("SELECT id FROM evimed_frontier.items WHERE id = ANY($1::bigint[]) AND selected ORDER BY id", [ids])).rows.map((row) => String(row.id));
const event = async (id) => (await database.query("SELECT * FROM evimed_frontier.events WHERE id = $1", [id])).rows[0];

test("two events of one readout are folded: the older survives with one pick, a stale digest, the old id redirecting and the heat counted again", options, async () => {
  const editor = stubEditor();
  const events = layer({ editor });
  const keys = ["trial:g-hope-001", "drug:arcotatug tavatecan"];
  const paper = await placed(events, { title: "G-HOPE-001 readout", sourceId: "nejm", sourceType: "journal", evidenceType: "rct", genre: "paper", score: 75,
    selected: true, rule: "threshold", entityKeys: keys, hours: 30 });
  const rewrite = await placed(events, { title: "Takeda announces G-HOPE-001", genre: "conference", score: 62, selected: true, rule: "genre-floor", entityKeys: keys, hours: 20 });
  const third = await placed(events, { title: "Gastric cancer ADC data", sourceId: "reuters", genre: "news", entityKeys: keys, hours: 10 });
  assert.equal(new Set([paper.event.id, rewrite.event.id, third.event.id]).size, 3, "the placement left them apart");
  await database.query("UPDATE evimed_frontier.events SET digest_zh = '旧概览', digest_state = 'written' WHERE id = $1", [paper.event.id]);
  const hotBefore = await metaValue(database, "hot_version");
  const contentBefore = await metaValue(database, "content_version");
  const heatBefore = Number((await event(paper.event.id)).heat);

  const summary = await events.reclusterSweep();
  assert.equal(summary.stopped, null);
  assert.equal(summary.merged, 2);
  assert.ok(summary.pairs >= 2);

  const survivor = await event(paper.event.id);
  assert.equal(survivor.merged_into, null);
  assert.equal(survivor.report_count, 3);
  assert.equal(survivor.digest_state, "stale", "the digest no longer covers every report");
  assert.ok(Number(survivor.heat) > heatBefore, "three entities report it now");
  assert.equal(survivor.recluster_checked_at, null, "a merged survivor is a new event and is looked at again");
  for (const absorbed of [rewrite.event, third.event]) {
    const row = await event(absorbed.id);
    assert.equal(String(row.merged_into), paper.event.id);
    assert.equal(Number(row.heat), 0);
    assert.deepEqual(await events.read(absorbed.public_id), { redirect: paper.event.public_id }, "the old public id answers a redirect to the survivor");
    assert.equal((await database.query("SELECT event_id FROM evimed_frontier.event_aliases WHERE public_id = $1", [absorbed.public_id])).rows[0].event_id, paper.event.id);
  }
  assert.deepEqual(await selectedIds([paper.id, rewrite.id, third.id]), [paper.id], "one selected report: the paper");
  const left = (await database.query("SELECT selected_rule, same_event_item_id FROM evimed_frontier.items WHERE id = $1", [rewrite.id])).rows[0];
  assert.equal(left.selected_rule, null);
  assert.equal(String(left.same_event_item_id), paper.id, "the report that left names the one that stays");
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_frontier.item_changes WHERE item_id = $1 AND reason = 'same-event'", [rewrite.id])).rows[0].n, 1);
  assert.equal(await metaValue(database, "content_version") > contentBefore, true);
  assert.equal(await metaValue(database, "hot_version") > hotBefore, true, "the hot list was counted again");
  const ranking = (await database.query("SELECT ranking FROM evimed_frontier.hot_snapshots ORDER BY taken_at DESC LIMIT 1")).rows[0]?.ranking ?? [];
  assert.deepEqual(ranking.map((entry) => entry.eventId), [paper.event.public_id], "the hot list holds the survivor once and no folded event");
  assert.ok(events.counters.reclusterMerged >= 2 && events.counters.reclusterPicksUnselected >= 1);
  assert.ok(editor.calls.pair.length >= 1, "a merge is only made after the second look");
});

test("a pair judged different is stamped and not asked again; an event that changed is asked about once more", options, async () => {
  const editor = stubEditor({ verdict: () => "DIFFERENT" });
  const events = layer({ editor });
  const a = await placed(events, { title: "Trial alpha readout", entityKeys: ["trial:alpha"], hours: 20 });
  const b = await placed(events, { title: "Alpha trial in another cancer", entityKeys: ["trial:alpha"], hours: 10 });
  const first = await events.reclusterSweep();
  assert.equal(first.different, 1);
  assert.equal(first.merged, 0);
  assert.notEqual((await event(a.event.id)).recluster_checked_at, null, "judged, so stamped");
  assert.notEqual((await event(b.event.id)).recluster_checked_at, null);
  const callsAfterFirst = editor.calls.batch.length;
  assert.equal((await events.reclusterSweep()).anchors, 0, "nothing changed, nothing to check");
  assert.equal(editor.calls.batch.length, callsAfterFirst);

  // A new report joins b: it is due again (after the recheck interval), and the pair is asked about once more because b changed.
  const joined = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "More on alpha", vector: vectorAt(0, 40), visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  await database.query("INSERT INTO evimed_frontier.event_items (event_id, item_id, role, joined_by) VALUES ($1, $2, 'report', 'model')", [b.event.id, joined.id]);
  await database.query("UPDATE evimed_frontier.items SET event_id = $2 WHERE id = $1", [joined.id, b.event.id]);
  // The test's clock is the layer's, not the database's: the reports joined "ten hours ago" and the events were checked three hours ago.
  await database.query("UPDATE evimed_frontier.event_items SET joined_at = $1 WHERE item_id <> $2", [new Date(NOW.getTime() - 10 * 3_600_000), joined.id]);
  await database.query("UPDATE evimed_frontier.events SET recluster_checked_at = $2 WHERE id = ANY($1::bigint[])", [[a.event.id, b.event.id], new Date(NOW.getTime() - 3 * 3_600_000)]);
  await database.query("UPDATE evimed_frontier.event_items SET joined_at = $2 WHERE item_id = $1", [joined.id, new Date(NOW.getTime() - 60_000)]);
  const again = await events.reclusterSweep();
  assert.equal(again.anchors, 1, "only the event that changed");
  assert.equal(again.pairs, 1);
  assert.equal(editor.calls.batch.length, callsAfterFirst + 1);
});

test("a verdict about an event that gained a report while the model was read is refused", options, async () => {
  let hook = null;
  const editor = stubEditor({ onBatch: async () => { await hook?.(); } });
  const events = layer({ editor });
  const keys = ["trial:beta"];
  const a = await placed(events, { title: "Beta readout", sourceId: "nejm", sourceType: "journal", evidenceType: "rct", genre: "paper", entityKeys: keys, hours: 20 });
  const b = await placed(events, { title: "Beta announced", entityKeys: keys, hours: 10 });
  hook = async () => {
    const late = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Beta, a new report", vector: vectorAt(0, 41), visibleAt: hoursAgo(0.5), timelineAt: hoursAgo(0.5) });
    await database.query("INSERT INTO evimed_frontier.event_items (event_id, item_id, role, joined_by) VALUES ($1, $2, 'report', 'model')", [b.event.id, late.id]);
    await database.query("UPDATE evimed_frontier.items SET event_id = $2 WHERE id = $1", [late.id, b.event.id]);
  };
  const summary = await events.reclusterSweep();
  assert.equal(summary.merged, 0);
  assert.equal(events.counters.reclusterStale, 1);
  assert.equal((await event(b.event.id)).merged_into, null);
  assert.equal(Number((await event(a.event.id)).report_count), 1);
});

test("a second look that disagrees merges nothing; a related pair becomes one link and is not asked again", options, async () => {
  const editor = stubEditor({ verdict: (a) => (a.includes("Gamma") ? "SAME" : "RELATED"), second: () => "RELATED" });
  const events = layer({ editor });
  await placed(events, { title: "Gamma readout", entityKeys: ["trial:gamma"], hours: 20 });
  const g2 = await placed(events, { title: "Gamma, said again", entityKeys: ["trial:gamma"], hours: 10 });
  const d1 = await placed(events, { title: "Delta preview", entityKeys: ["trial:delta"], hours: 20 });
  const d2 = await placed(events, { title: "Delta data", entityKeys: ["trial:delta"], hours: 10 });
  const summary = await events.reclusterSweep();
  assert.equal(summary.merged, 0, "the batch said SAME, the second look did not");
  assert.equal(summary.links, 1, "the Delta pair is related");
  const links = (await database.query("SELECT from_event_id, to_event_id, relation, asserted_by FROM evimed_frontier.event_links")).rows;
  assert.equal(links.length, 1);
  assert.deepEqual([String(links[0].from_event_id), String(links[0].to_event_id), links[0].relation, links[0].asserted_by], [d1.event.id, d2.event.id, "related", "model"]);
  assert.equal((await event(g2.event.id)).merged_into, null);
  const calls = editor.calls.batch.length;
  await events.reclusterSweep();
  assert.equal(editor.calls.batch.length, calls, "neither pair is asked about again");
});

test("a safety alert and an operator's pin stay selected; the arithmetic picks beside them leave", options, async () => {
  const events = layer();
  const keys = ["drug:sildenafil", "trial:recall-1"];
  const alert = await placed(events, { title: "Recall of supplements", sourceId: "nejm", genre: "safety", safety: true, selected: true, rule: "safety-bypass", entityKeys: keys, hours: 20 });
  const pinned = await placed(events, { title: "Recall, said by a newsroom", genre: "news", selected: true, rule: "operator-pin", entityKeys: keys, hours: 15 });
  const counted = await placed(events, { title: "Recall, said again", sourceId: "reuters", genre: "news", score: 80, selected: true, rule: "threshold", entityKeys: keys, hours: 10 });
  await events.reclusterSweep();
  assert.deepEqual(await selectedIds([alert.id, pinned.id, counted.id]), [alert.id, pinned.id].sort((x, y) => Number(x) - Number(y)));
  assert.equal((await database.query("SELECT same_event_item_id FROM evimed_frontier.items WHERE id = $1", [counted.id])).rows[0].same_event_item_id, alert.id);
});

test("only while the day's budget is ok, and a lever of 0 turns the sweep off", options, async () => {
  const editor = stubEditor();
  const keys = ["trial:eps"];
  const seed = layer({ editor });
  await placed(seed, { title: "Eps one", entityKeys: keys, hours: 20 });
  await placed(seed, { title: "Eps two", entityKeys: keys, hours: 10 });
  const callsBefore = editor.calls.batch.length;
  const throttled = layer({ editor, budget: async () => ({ state: "throttled" }) });
  assert.equal((await throttled.reclusterSweep()).stopped, "budget");
  const off = layer({ editor, config: { frontierReclusterMaxPairs: 0 } });
  assert.equal((await off.reclusterSweep()).stopped, "off");
  assert.equal(editor.calls.batch.length, callsBefore, "the model was never asked");
  const merged = await layer({ editor }).reclusterSweep();
  assert.equal(merged.merged, 1);
});
