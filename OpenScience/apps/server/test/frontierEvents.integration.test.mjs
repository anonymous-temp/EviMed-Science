// The event layer against a real PostgreSQL (build spec D.1; fr-events 2026-10-22): recall by vector at any subject, by
// trial and by words; the grouping call's four relations, the second look and the `follows` links; one selected item per
// event; merges with their aliases, redirects and moved edges; the hot list and its versions; overviews earned, rewritten on a
// new primary, kept on failure; the event page's order and developments; the item's follow-ups; the backfill.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_GROUP_INSTRUCTIONS, FRONTIER_GROUP_PAIR_INSTRUCTIONS } from "../src/frontierEventGrouping.mjs";
import { frontierItemFollowups } from "../src/frontierEventReading.mjs";
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

/**
 * The reports a prompt describes (`frontierEventGrouping.mjs`): each block's label, its title, the registry ids, the
 * milestone and the DOI it states, and whether a selected report stands beside it.
 * @param {string} input
 */
function reportsOf(input) {
  return input.split("\n\n").filter((block) => block.startsWith("【")).map((block) => ({
    label: /^【([^】]+)】/.exec(block)[1],
    title: /\n标题：([^\n]*)/.exec(block)?.[1] ?? "",
    registry: [...block.matchAll(/注册号 ([^；\n]+)/g)].map((match) => match[1]),
    milestone: /\n试验节点：([^\n]*)/.exec(block)?.[1] ?? null,
    doi: /DOI ([^；\n]+)/.exec(block)?.[1] ?? null,
    selected: block.includes("【已入选】"),
    block,
  }));
}

/** The default verdict: two reports that name one trial are one occurrence; anything else is another. */
const sameTrial = (report, candidate) => (report.registry.some((id) => candidate.registry.includes(id)) ? "SAME_OCCURRENCE" : "UNRELATED");
const always = (relation) => () => relation;

/**
 * An editor stub: available, answering the grouping call with `decide(report, candidate)` per candidate and the reading value
 * `selection`, the second look with `pair(a, b)`, and the overview as told.
 */
function stubEditor({ decide = sameTrial, pair = null, selection = { addsValue: true, reason: "有新的数据" }, digest = null } = {}) {
  const calls = { group: [], pair: [], digest: [] };
  return {
    calls,
    available: true,
    callJson: async (messages) => {
      const [system, user] = [messages[0].content, messages[1].content];
      const reports = reportsOf(user);
      if (system === FRONTIER_GROUP_INSTRUCTIONS) {
        const [report, ...candidates] = reports;
        calls.group.push({ report, candidates, input: user });
        return { query: report.title, selection,
          decisions: candidates.map((candidate, index) => ({ id: `C${index + 1}`, relation: decide(report, candidate), confidence: 0.9, note: "" })) };
      }
      if (system === FRONTIER_GROUP_PAIR_INSTRUCTIONS) {
        calls.pair.push({ a: reports[0], b: reports[1] });
        return { relation: (pair ?? decide)(reports[0], reports[1]), confidence: 0.9, difference: "" };
      }
      throw new Error("an unexpected call");
    },
    writeJson: async (instructions, input) => {
      calls.digest.push(input);
      return digest ?? { verification: "passed", output: { title: `事件第 ${calls.digest.length} 版`, digest: `综述第 ${calls.digest.length} 版` } };
    },
  };
}

function layer({ editor = stubEditor(), budget = async () => ({ state: "ok" }), embedder = testEmbedder } = {}) {
  return new FrontierEvents({ database, editor, embedder, budget, now: () => NOW, config: {} });
}

test("D-16: items whose candidates could not be asked about wait unplaced and do not hold up the items behind them; a deployment with no editor still makes singletons", options, async () => {
  const editor = stubEditor({ decide: always("SAME_OCCURRENCE") });
  let state = "throttled";
  const events = layer({ editor, budget: async () => ({ state }) });
  const first = await insertComposedItem(database, { sourceId: "nejm", title: "Semaglutide cuts kidney events", entityKeys: ["drug:semaglutide"],
    vector: vectorAt(1), visibleAt: hoursAgo(20), timelineAt: hoursAgo(20) });
  await events.clusterPending(); // nothing to ask: its own event, whatever the budget
  const story = await eventOf(database, first.id);
  assert.ok(story);
  const take = (title, axis, hours) => insertComposedItem(database, { sourceId: "stat", sourceType: "media", title, entityKeys: ["drug:semaglutide"],
    vector: vectorAt(0.78, axis), visibleAt: hoursAgo(hours), timelineAt: hoursAgo(hours) });
  const [a, b, c] = [await take("Take A", 2, 10), await take("Take B", 3, 9), await take("Take C", 4, 8)];
  const lone = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Metformin news", entityKeys: ["drug:metformin"],
    vector: vectorAt(0, 6), visibleAt: hoursAgo(7), timelineAt: hoursAgo(7) });

  // Two a round, oldest first: A and B are asked about and cannot be, so they wait — and C and the item behind it get their turn.
  assert.deepEqual(await events.clusterPending({ limit: 2 }), { clustered: 0, created: 0, joined: 0, merged: 0, skipped: 2 });
  assert.equal(await eventOf(database, a.id), null);
  assert.equal(await eventOf(database, b.id), null);
  assert.deepEqual(await events.clusterPending({ limit: 2 }), { clustered: 1, created: 1, joined: 0, merged: 0, skipped: 1 });
  assert.equal(await eventOf(database, c.id), null, "C waits too");
  assert.ok(await eventOf(database, lone.id), "…and the item with nothing to ask was not starved by the three");
  assert.equal(events.counters.deferred, 3);
  assert.equal(editor.calls.group.length, 0, "the model was never asked while the budget was not ok");

  // The budget comes back: everything that waited is looked at at once, asked, looked at again (0.78 is below 0.85), and placed.
  state = "ok";
  assert.deepEqual(await events.clusterPending(), { clustered: 3, created: 0, joined: 3, merged: 0, skipped: 0 });
  for (const waiting of [a, b, c]) assert.equal((await eventOf(database, waiting.id)).id, story.id);
  assert.equal(editor.calls.group.length, 3);
  assert.equal(editor.calls.pair.length, 3, "each join below 0.85 had its second look");

  // With no editor at all nothing will ever answer, so waiting would be for nothing: an event of its own, as before.
  await resetFrontier(database);
  await insertSource(database, "nejm", { authority: 5, owner_entity: "nejm-group" });
  await insertSource(database, "stat", { name: "STAT", source_type: "media", authority: 3, owner_entity: "stat" });
  const bare = layer({ editor: null, embedder: null });
  const one = await insertComposedItem(database, { sourceId: "nejm", title: "Registry update", registryIds: ["NCT05555555"], visibleAt: hoursAgo(4), timelineAt: hoursAgo(4) });
  const two = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Trial delayed", registryIds: ["NCT05555555"], visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  await bare.clusterPending();
  assert.notEqual((await eventOf(database, one.id)).id, (await eventOf(database, two.id)).id);
  assert.equal(bare.counters.deferred, 0);
});

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
    [[paper.id, "primary", "identifier"], [results.id, "report", "model"]]);
  assert.equal(trial.report_count, 2);
  assert.equal(trial.title_zh, "FLOW 试验", "the event is named by its primary source");
  assert.equal(trial.latest_zh, "FLOW results posted", "「最新进展」 is the newest report");
  assert.equal(await events.clusterPending().then((summary) => summary.clustered), 0, "an item is clustered once");
});

test("vectors: any subject from 0.6 is a candidate; 0.85 joins on one answer, below it on two; the second look can refuse; not while the budget is not ok", options, async () => {
  // Each vector leans off the first item's axis on an axis of its own, so its
  // cosine to the first is chosen and to every other one is the product.
  const editor = stubEditor({ decide: always("SAME_OCCURRENCE") });
  const events = layer({ editor });
  const first = await insertComposedItem(database, { sourceId: "nejm", title: "Semaglutide cuts kidney events", entityKeys: ["drug:semaglutide"],
    vector: vectorAt(1), visibleAt: hoursAgo(10), timelineAt: hoursAgo(10) });
  await events.clusterPending();
  // No entity in common: the recall no longer asks for one (2026-10-22: it hid nine in ten of the pairs that were one story).
  const near = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Novo drug protects kidneys",
    vector: vectorAt(0.9, 1), visibleAt: hoursAgo(9), timelineAt: hoursAgo(9) });
  const stranger = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Metformin news", entityKeys: ["drug:semaglutide"],
    vector: vectorAt(0.5, 3), visibleAt: hoursAgo(8), timelineAt: hoursAgo(8) });
  await events.clusterPending();
  const story = await eventOf(database, first.id);
  assert.equal((await eventOf(database, near.id)).id, story.id, "0.9 and the answer: one occurrence, no second look");
  assert.notEqual((await eventOf(database, stranger.id)).id, story.id, "below 0.6 nothing is asked, whatever the entities");
  assert.equal(editor.calls.group.length, 1);
  assert.equal(editor.calls.pair.length, 0);
  assert.equal(editor.calls.group[0].candidates.length, 1);

  const band = await insertComposedItem(database, { sourceId: "yimaitong", sourceType: "media", lang: "zh", title: "司美格鲁肽肾脏获益",
    vector: vectorAt(0.78, 2), visibleAt: hoursAgo(7), timelineAt: hoursAgo(7) });
  await events.clusterPending();
  assert.equal(editor.calls.group.length, 2);
  assert.equal(editor.calls.group[1].candidates.length, 1, "one candidate per event: the near report and the first are one");
  assert.equal(editor.calls.pair.length, 1, "0.78: looked at again");
  assert.equal((await eventOf(database, band.id)).id, story.id, "the second look agreed");
  const joinedBy = (await database.query("SELECT item_id, joined_by FROM evimed_frontier.event_items WHERE event_id = $1 ORDER BY item_id", [story.id])).rows;
  assert.deepEqual(joinedBy.map((row) => row.joined_by), ["identifier", "model", "model"]);

  const refused = layer({ editor: stubEditor({ decide: always("SAME_OCCURRENCE"), pair: always("UNRELATED") }) });
  const lookalike = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Another kidney story",
    vector: vectorAt(0.8, 7), visibleAt: hoursAgo(6.5), timelineAt: hoursAgo(6.5) });
  await refused.clusterPending();
  assert.notEqual((await eventOf(database, lookalike.id)).id, story.id, "the merge stands only when the second look agrees");
  assert.equal(refused.counters.secondLooks, 1);
  assert.equal(refused.counters.secondLooksAgreed, 0);

  const throttled = layer({ editor, budget: async () => ({ state: "throttled" }) });
  const unasked = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Another take",
    vector: vectorAt(0.9, 4), visibleAt: hoursAgo(6), timelineAt: hoursAgo(6) });
  await throttled.clusterPending();
  assert.equal(editor.calls.group.length, 2, "past 80% of the budget nothing is asked");
  assert.equal(await eventOf(database, unasked.id), null, "…and the item waits unplaced instead of becoming an event of its own for good (D-16)");
  assert.equal(throttled.counters.deferred, 1);
  await layer({ editor }).clusterPending();
  assert.equal(editor.calls.group.length, 3, "once the budget allows, it is asked");
  assert.equal((await eventOf(database, unasked.id)).id, story.id, "…and the answer places it");
});

test("an item waits for its vector (30 min) and its edit (24 h); items older than fourteen days are left alone", options, async () => {
  const events = layer();
  const fresh = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Fresh", visibleAt: hoursAgo(0.2), timelineAt: hoursAgo(0.2) });
  const owed = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Owed its edit", verification: "pending",
    vector: vectorAt(0.1), visibleAt: hoursAgo(2), timelineAt: hoursAgo(2) });
  const old = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Old", visibleAt: hoursAgo(15 * 24), timelineAt: hoursAgo(15 * 24) });
  assert.equal((await events.clusterPending()).clustered, 0);
  await database.query("INSERT INTO evimed_frontier.item_vectors (item_id, model_key, embedding) VALUES ($1, $2, $3)",
    [fresh.id, testEmbedder.modelKey, `[${vectorAt(0.2).join(",")}]`]);
  assert.equal((await events.clusterPending()).clustered, 1, "the vector arrived");
  assert.ok(await eventOf(database, fresh.id));
  assert.equal(await eventOf(database, owed.id), null);
  assert.equal(await eventOf(database, old.id), null);
});

test("a bridge merges: the older event survives, the absorbed id redirects for good, members, edges and aliases move with it", options, async () => {
  const events = layer({ editor: stubEditor({ decide: always("SAME_OCCURRENCE") }) });
  const oldest = await insertComposedItem(database, { sourceId: "fda", sourceType: "regulator", evidenceType: "regulatory-decision", title: "FDA approves X",
    registryIds: ["NCT07000001"], visibleAt: hoursAgo(30), timelineAt: hoursAgo(30) });
  const trialPaper = await insertComposedItem(database, { sourceId: "nejm", title: "Trial of X", registryIds: ["NCT09000001"], visibleAt: hoursAgo(20), timelineAt: hoursAgo(20) });
  const coverage = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "X coverage", entityKeys: ["drug:x"],
    vector: vectorAt(1), visibleAt: hoursAgo(12), timelineAt: hoursAgo(12) });
  const elsewhere = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Elsewhere", visibleAt: hoursAgo(11), timelineAt: hoursAgo(11) });
  await events.clusterPending();
  const [e0, e1, e2, e3] = await Promise.all([oldest, trialPaper, coverage, elsewhere].map((item) => eventOf(database, item.id)));
  await database.query(`INSERT INTO evimed_frontier.event_links (from_event_id, to_event_id, relation, asserted_by) VALUES ($1, $2, 'related', 'model')`, [e2.id, e3.id]);

  // One first-hand item that is the trial (registry id) and the coverage (vector): E1 and E2 are one
  // event, and E1 is older. First-hand because only a first-hand item folds two events into one.
  const bridge = await insertComposedItem(database, { sourceId: "nejm", sourceType: "journal", title: "X trial and its coverage", registryIds: ["NCT09000001"],
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
  const second = await insertComposedItem(database, { sourceId: "fda", sourceType: "regulator", title: "FDA and the trial", registryIds: ["NCT07000001", "NCT09000001"],
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

test("a daily column joins one event and links the others; a second work is asked about, not joined", options, async () => {
  // The column is one occurrence with everything it covers; the second protocol is, says the first answer, the first one — and
  // the second look, which a different work always gets, says it is not.
  const editor = stubEditor({
    decide: (report, candidate) => (report.title.startsWith("Pharmalittle:")
      || (report.title.startsWith("Protocol: service") && candidate.title.startsWith("Protocol:")) ? "SAME_OCCURRENCE" : "UNRELATED"),
    pair: always("UNRELATED"),
  });
  const events = layer({ editor });
  const capital = await insertComposedItem(database, { sourceId: "fda", sourceType: "regulator", title: "Novo capital markets day",
    registryIds: ["NCT08000001"], entityKeys: ["drug:semaglutide"], vector: vectorAt(1), visibleAt: hoursAgo(6), timelineAt: hoursAgo(6) });
  // 0.68 to the capital-markets item: close enough to be asked about (the stub says no), not to join.
  const adhd = await insertComposedItem(database, { sourceId: "nejm", sourceType: "journal", title: "An orexin agonist in ADHD",
    registryIds: ["NCT08000002"], clusterKeys: [], entityKeys: ["drug:semaglutide", "drug:orexin"], vector: vectorAt(0.68, 1),
    visibleAt: hoursAgo(5), timelineAt: hoursAgo(5) });
  await events.clusterPending();
  const capitalEvent = await eventOf(database, capital.id);
  const adhdEvent = await eventOf(database, adhd.id);
  assert.notEqual(capitalEvent.id, adhdEvent.id);
  // The column names both trials: its registry ids are mentions, and what it matches it reports on.
  const column = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Pharmalittle: Novo's plans, early ADHD data, and more",
    registryIds: ["NCT08000001", "NCT08000002"], clusterKeys: [], entityKeys: ["drug:semaglutide", "drug:orexin"],
    vector: vectorAt(0.9, 1), visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  const summary = await events.clusterPending();
  assert.equal(summary.merged, 0, "a report never folds two events into one");
  const columnJudgment = editor.calls.group.find(input => input.report.title.startsWith("Pharmalittle:"));
  assert.equal(columnJudgment?.candidates.length, 2, "both mentioned events require a semantic verdict");
  assert.equal(editor.calls.pair.length, 0, "both above 0.85: no second look");
  assert.equal(String((await eventOf(database, column.id)).id), String(capitalEvent.id), "it joins the oldest it matched");
  assert.equal(String((await eventOf(database, adhd.id)).id), String(adhdEvent.id), "the other event stands");
  const edges = (await database.query(`SELECT count(*)::integer AS n FROM evimed_frontier.event_links
    WHERE (from_event_id = $1 AND to_event_id = $2) OR (from_event_id = $2 AND to_event_id = $1)`, [capitalEvent.id, adhdEvent.id])).rows[0].n;
  assert.equal(edges, 1, "the event it also covered becomes an edge");

  // Two protocols of one collaboration, one topic, different DOIs: the cosine proposes, the model decides.
  await insertSource(database, "cochrane", { name: "Cochrane", owner_entity: "cochrane" });
  await insertSource(database, "pubmed-sr", { name: "PubMed SR stream", owner_entity: "nlm" });
  const first = await insertComposedItem(database, { sourceId: "pubmed-sr", title: "Protocol: monitoring lipid-lowering therapy",
    doi: "10.1002/14651858.CD016386", entityKeys: ["drug:statin"], vector: vectorAt(1, 2), visibleAt: hoursAgo(4), timelineAt: hoursAgo(4) });
  await events.clusterPending();
  const second = await insertComposedItem(database, { sourceId: "cochrane", title: "Protocol: service delivery for lipid testing",
    doi: "10.1002/14651858.CD016382", clusterKeys: [], entityKeys: ["drug:statin"], vector: vectorAt(0.99, 2),
    visibleAt: hoursAgo(2), timelineAt: hoursAgo(2) });
  const judged = editor.calls.group.length;
  await events.clusterPending();
  assert.notEqual(String((await eventOf(database, second.id)).id), String((await eventOf(database, first.id)).id),
    "a cosine of 0.99 and one answer do not make two works one event");
  assert.equal(editor.calls.group.length, judged + 1, "it was asked about");
  assert.deepEqual(editor.calls.pair.map(({ b }) => b.title), ["Protocol: monitoring lipid-lowering therapy"], "…and looked at again, because it is another work");
});

test("the hot list: the eligible by decayed heat, a snapshot every run, hot_version only when the list moved, settled after 72 h", options, async () => {
  const events = layer({ embedder: null });
  const trial = await insertComposedItem(database, { sourceId: "nejm", title: "Trial", titleZh: "试验", registryIds: ["NCT01"], visibleAt: hoursAgo(20), timelineAt: hoursAgo(20) });
  await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Trial coverage", registryIds: ["NCT01"], clusterKeys: [], visibleAt: hoursAgo(10), timelineAt: hoursAgo(10) });
  const alone = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "One outlet", visibleAt: hoursAgo(2), timelineAt: hoursAgo(2) });
  // A regulator's notice alone is hot only when it is major — selected and
  // scored in the top band; a lone safety alert below it has the page's own
  // rail, and a routine regulator update below the line is not hot either.
  const notice = await insertComposedItem(database, { sourceId: "fda", sourceType: "regulator", evidenceType: "safety-notice", title: "FDA warning",
    selected: true, selectedRule: "safety-bypass", safetyAlert: true, scoreTotal: 88, visibleAt: hoursAgo(30), timelineAt: hoursAgo(30) });
  const recall = await insertComposedItem(database, { sourceId: "fda", sourceType: "regulator", evidenceType: "safety-notice", title: "Class I recall of a device",
    selected: true, selectedRule: "safety-bypass", safetyAlert: true, scoreTotal: 70, visibleAt: hoursAgo(5), timelineAt: hoursAgo(5) });
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
  const recallEvent = await eventOf(database, recall.id);
  assert.ok(!first.ranking.some((entry) => entry.eventId === recallEvent.public_id), "a lone safety alert below the top band is not hot");
  assert.equal((await eventOf(database, stale.id)).status, "settled");
  const again = await events.computeHot();
  assert.equal(again.changed, false);
  assert.equal(again.ranking[0].delta, 0);
  assert.equal(await metaValue(database, "hot_version"), hotBefore + 1, "an unchanged list does not move the version");
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.hot_snapshots")).rows[0].n >= 1, true);
  const list = await events.hotList();
  assert.deepEqual(list.events.map((event) => [event.rank, event.id, event.primary, event.hasPrimary, event.sourceCount72h, event.reportCount, event.status]), [
    [1, trialEvent.public_id, "paper", true, 2, 2, "developing"],
    [2, noticeEvent.public_id, "official", true, 1, 1, "developing"],
  ]);
  assert.equal(list.events[0].title, "试验");
  assert.equal(list.events[0].latest, "Trial coverage");
  assert.equal(list.events[0].firstAt, hoursAgo(20));
  // Shown since 2026-09-24: the heat the run measured, ×10 and rounded.
  const stored = (await database.query("SELECT heat FROM evimed_frontier.events WHERE id = $1", [trialEvent.id])).rows[0].heat;
  assert.equal(list.events[0].heat, Math.round(stored * 10));
  const heats = (await database.query("SELECT heats FROM evimed_frontier.hot_snapshots ORDER BY taken_at DESC LIMIT 1")).rows[0].heats;
  assert.deepEqual(Object.keys(heats).sort(), [trialEvent.public_id, noticeEvent.public_id].sort(), "every event that could be listed, and nothing else");
  assert.equal(heats[trialEvent.public_id], Math.round(stored * 10_000) / 10_000);
  assert.deepEqual([list.events[0].rankChange, list.events[0].badge, list.events[0].trend, list.events[0].period], [null, null, null, null],
    "no list six hours old yet: nothing to compare, no trend");
});

test("a snapshot records the heat of what could be listed; the list reads its trend, rank change and badge from the snapshots", options, async () => {
  const events = layer({ embedder: null });
  const old = await insertComposedItem(database, { sourceId: "nejm", title: "Old trial", registryIds: ["NCT11"], visibleAt: hoursAgo(40), timelineAt: hoursAgo(40) });
  await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Old trial coverage", registryIds: ["NCT11"], clusterKeys: [],
    visibleAt: hoursAgo(30), timelineAt: hoursAgo(30) });
  const fresh = await insertComposedItem(database, { sourceId: "nejm", title: "Fresh trial", registryIds: ["NCT22"], visibleAt: hoursAgo(5), timelineAt: hoursAgo(5) });
  await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Fresh trial coverage", registryIds: ["NCT22"], clusterKeys: [],
    visibleAt: hoursAgo(4), timelineAt: hoursAgo(4) });
  await events.clusterPending();
  const oldEvent = await eventOf(database, old.id);
  const freshEvent = await eventOf(database, fresh.id);
  // An event folded into the old one since: older snapshots name it by its own id.
  await database.query(`INSERT INTO evimed_frontier.events (public_id, title_zh, lane, first_at, last_at, merged_into)
    VALUES ('0123456789abcdef', '并入的事件', 'evidence', $1, $1, $2)`, [hoursAgo(45), oldEvent.id]);
  // Earlier lists, as the worker left them: the old story listed and cooler,
  // no snapshot at all around 20, 12, 8 and 4 hours ago, the fresh one nowhere.
  const snapshot = (hours, ranking, heats) => database.query(`INSERT INTO evimed_frontier.hot_snapshots (taken_at, ranking, heats)
    VALUES ($1, $2::jsonb, $3::jsonb)`, [hoursAgo(hours), JSON.stringify(ranking), JSON.stringify(heats)]);
  await snapshot(24, [{ rank: 1, eventId: oldEvent.public_id }], { [oldEvent.public_id]: 0.9 });
  await snapshot(20.5, [{ rank: 1, eventId: "0123456789abcdef" }], { "0123456789abcdef": 0.7 });
  await snapshot(16.5, [{ rank: 1, eventId: oldEvent.public_id }], { [oldEvent.public_id]: 1.1 });
  await snapshot(6.25, [{ rank: 2, eventId: oldEvent.public_id }], { [oldEvent.public_id]: 0.6 });
  await events.computeHot();
  const list = await events.hotList();
  assert.deepEqual(list.events.map((event) => event.id), [freshEvent.public_id, oldEvent.public_id], "the fresh story is hotter now");
  const [hot, cooling] = list.events;
  assert.equal(hot.badge, "new", "first reported five hours ago");
  assert.equal(hot.rankChange, "new", "not on the list six hours ago");
  assert.equal(hot.trend, null, "no heat recorded six hours ago: 「暂无走势」");
  assert.equal(cooling.rankChange, 0, "second then, second now");
  assert.equal(cooling.badge, "rising", "hotter than the 6 it was shown at six hours ago");
  assert.deepEqual(cooling.trend.map((point) => point.heat), [9, 7, 11, null, null, null, cooling.heat],
    "seven points four hours apart; the folded-in event's heat is this event's; an hour without a snapshot is null");
  assert.equal(cooling.trend[0].at, hoursAgo(24));
  assert.equal(cooling.trend.at(-1).at, list.takenAt);
});

test("the week's and the month's rankings: institutions in the window, first-hand material, the best rank reached; time on the list", options, async () => {
  const editor = stubEditor();
  const at = (hours) => new FrontierEvents({ database, editor, embedder: null, now: () => new Date(NOW.getTime() - hours * 3_600_000),
    budget: async () => ({ state: "ok" }), config: {} });
  const story = async (key, reports, hoursBack = 0) => {
    let first = null;
    for (const [index, report] of reports.entries()) {
      const row = await insertComposedItem(database, { sourceId: report.source, sourceType: report.type ?? "media", title: `${key} ${index}`,
        registryIds: [key], clusterKeys: index === 0 ? undefined : [], visibleAt: hoursAgo(report.hours), timelineAt: hoursAgo(report.hours) });
      first ??= row;
    }
    await at(hoursBack).clusterPending();
    return eventOf(database, first.id);
  };
  const a = await story("NCT-A", [{ source: "nejm", type: "journal", hours: 30 }, { source: "reuters", hours: 29 }, { source: "stat", hours: 28 }]);
  const b = await story("NCT-B", [{ source: "fda", type: "regulator", hours: 50 }, { source: "stat", hours: 49 }]);
  const c = await story("NCT-C", [{ source: "reuters", hours: 20 }, { source: "yimaitong", hours: 19 }]);
  const d = await story("NCT-D", [{ source: "ema", type: "regulator", hours: 70 }]);
  const e = await story("NCT-E", [{ source: "stat", hours: 10 }]);
  const f = await story("NCT-F", [{ source: "nejm", type: "journal", hours: 216 }, { source: "reuters", hours: 215 }, { source: "stat", hours: 214 }], 200);
  // Six lists ten minutes apart, three days ago: D first, B second — seventy
  // minutes each, the last list counted until the next run could have come.
  for (let index = 0; index < 6; index += 1) {
    await database.query("INSERT INTO evimed_frontier.hot_snapshots (taken_at, ranking, heats) VALUES ($1, $2::jsonb, '{}'::jsonb)",
      [new Date(NOW.getTime() - 72 * 3_600_000 + index * 600_000), JSON.stringify([{ rank: 1, eventId: d.public_id }, { rank: 2, eventId: b.public_id }])]);
  }
  const events = layer({ embedder: null });
  const week = await events.hotPeriod("week");
  assert.equal(week.since, hoursAgo(7 * 24));
  assert.equal(week.at, NOW.toISOString());
  assert.deepEqual(week.events.map((event) => event.id), [a.public_id, b.public_id, c.public_id, d.public_id],
    "three institutions first; then two with first-hand material; one institution only because it was listed; E alone and never listed is not here");
  assert.deepEqual(week.events.map((event) => event.period), [
    { institutions: 3, reports: 3, hoursOnList: null, bestRank: null },
    { institutions: 2, reports: 2, hoursOnList: 1, bestRank: 2 },
    { institutions: 2, reports: 2, hoursOnList: null, bestRank: null },
    { institutions: 1, reports: 1, hoursOnList: 1, bestRank: 1 },
  ]);
  assert.deepEqual(week.events.map((event) => [event.rank, event.hasPrimary, event.primary]),
    [[1, true, "paper"], [2, true, "official"], [3, false, null], [4, true, "official"]]);
  assert.deepEqual([week.events[0].heat, week.events[0].trend, week.events[0].badge, week.events[0].rankChange], [null, null, null, null],
    "a window's ranking carries no heat, trend or badge: those are the current list's");
  assert.ok(!week.events.some((event) => event.id === e.public_id));
  const month = await events.hotPeriod("month");
  assert.deepEqual(month.events.map((event) => event.id), [a.public_id, f.public_id, b.public_id, c.public_id, d.public_id],
    "nine days ago is in the month: three institutions and a paper, after A only by its latest report");
  await assert.rejects(events.hotPeriod("year"), { code: "frontier_query_invalid" });
});

test("the event page's facts, computed when read: the heat now, the institutions of 72 hours by kind, the hourly trend, the first-hand material", options, async () => {
  const events = layer({ embedder: null });
  // The earliest report holds the trial's key, as the first sighting would.
  await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Early word", registryIds: ["NCT33"],
    visibleAt: hoursAgo(80), timelineAt: hoursAgo(80) });
  const paper = await insertComposedItem(database, { sourceId: "nejm", title: "Paper", registryIds: ["NCT33"], clusterKeys: [],
    visibleAt: hoursAgo(10), timelineAt: hoursAgo(10) });
  await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Coverage", registryIds: ["NCT33"], clusterKeys: [],
    visibleAt: hoursAgo(4), timelineAt: hoursAgo(4) });
  await events.clusterPending();
  const event = await eventOf(database, paper.id);
  const read = await events.read(event.public_id);
  assert.deepEqual(read.institutions, { total: 2, byType: [{ type: "journal", count: 1 }, { type: "media", count: 1 }] },
    "the report of 80 hours ago is outside the 72 hours");
  assert.equal(read.primary, "paper");
  assert.equal(read.trend.length, 73, "the first report is older than the window: every hour of it");
  assert.equal(read.trend.at(-1).at, NOW.toISOString());
  assert.equal(read.trend.at(-1).heat, read.heat, "the last point is the heat now");
  assert.ok(read.heat > 0 && Number.isInteger(read.heat));
  assert.ok(read.trend.at(-1).heat > read.trend.at(-11).heat, "the paper ten hours ago and the coverage since lifted it");
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
  assert.equal(event.title_zh, "事件第 1 版", "the overview's title names the event from now on");
  assert.equal(event.digest_title_zh, "事件第 1 版");
  assert.match(editor.calls.digest[0], /^上一版综述：无\n报道（一手来源在前）：\n\[1\] 一手来源｜/, "primary sources first");
  assert.deepEqual((await database.query("SELECT revision, cause FROM evimed_frontier.event_revisions WHERE event_id = $1", [event.id])).rows, [{ revision: 1, cause: "new-primary" }]);
  assert.equal((await events.writeDigests()).written, 0, "nothing new, nothing written");

  await insertComposedItem(database, { sourceId: "yimaitong", sourceType: "media", lang: "zh", title: "报道", registryIds: ["NCT02"], clusterKeys: [], visibleAt: hoursAgo(5), timelineAt: hoursAgo(5) });
  await events.clusterPending();
  event = await eventOf(database, paper.id);
  assert.equal(event.digest_state, "stale");
  assert.equal(event.latest_zh, "报道");
  assert.equal(event.title_zh, "事件第 1 版", "a new report does not take the title back");
  assert.equal((await events.writeDigests()).written, 0, "a report alone does not buy a rewrite");

  await insertComposedItem(database, { sourceId: "fda", sourceType: "regulator", evidenceType: "regulatory-decision", title: "FDA acts", registryIds: ["NCT02"], clusterKeys: [],
    visibleAt: hoursAgo(2), timelineAt: hoursAgo(2) });
  await events.clusterPending();
  const failing = layer({ editor: stubEditor({ digest: { verification: "dropped", output: null, error: null } }), embedder: null });
  assert.equal((await failing.writeDigests()).dropped, 1);
  assert.equal((await eventOf(database, paper.id)).digest_zh, "综述第 1 版", "a failed rewrite keeps the previous digest");
  assert.equal((await layer({ editor, embedder: null, budget: async () => ({ state: "throttled" }) }).writeDigests()).written, 0, "not while the budget is not ok");
  assert.equal((await events.writeDigests()).written, 1);
  event = await eventOf(database, paper.id);
  assert.equal(event.digest_zh, "综述第 2 版");
  assert.equal(event.digest_revision, 2);
  assert.match(editor.calls.digest[1], /^上一版综述：综述第 1 版\n/, "the previous version goes with the rewrite, so contradictions are marked");
  assert.equal(event.title_zh, "事件第 2 版");
});

test("two milestones of one trial are one story: a follows link from the older to the newer, never a merge; the model reads the milestones", options, async () => {
  const editor = stubEditor({ decide: always("SAME_STORY") });
  const events = layer({ editor, embedder: null });
  const registered = await insertComposedItem(database, { sourceId: "ctgov", title: "Trial registered", identityKey: "reg:NCT01234567:registered:2020-01-01",
    registryIds: ["NCT01234567"], visibleAt: hoursAgo(6), timelineAt: hoursAgo(6) });
  await events.clusterPending();
  const terminated = await insertComposedItem(database, { sourceId: "ctgov", title: "Trial terminated", identityKey: "reg:NCT01234567:terminated:2026-09-22",
    registryIds: ["NCT01234567"], visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  await events.clusterPending();
  const [older, newer] = [await eventOf(database, registered.id), await eventOf(database, terminated.id)];
  assert.notEqual(older.id, newer.id);
  assert.equal(editor.calls.group.length, 1);
  assert.equal(editor.calls.group[0].report.milestone, "NCT01234567 · terminated · 2026-09-22");
  assert.equal(editor.calls.group[0].candidates[0].milestone, "NCT01234567 · registered · 2020-01-01");
  assert.deepEqual((await database.query("SELECT from_event_id, to_event_id, relation, asserted_by FROM evimed_frontier.event_links")).rows
    .map((row) => [String(row.from_event_id), String(row.to_event_id), row.relation, row.asserted_by]), [[String(older.id), String(newer.id), "follows", "model"]]);
  assert.equal(events.counters.followsLinks, 1);
  assert.equal(events.counters.relatedLinks, 0);
});

test("a story grows around its root: a development of a development links to the root, and every event of it reads the rest", options, async () => {
  const editor = stubEditor({ decide: (report, candidate) => (candidate.title.startsWith("Signal") || candidate.title.startsWith("Label") ? "SAME_STORY" : "UNRELATED") });
  const events = layer({ editor, embedder: null });
  const signal = await insertComposedItem(database, { sourceId: "fda", sourceType: "regulator", evidenceType: "safety-notice", title: "Signal: drug Z and pancreatitis",
    registryIds: ["NCT-Z"], visibleAt: hoursAgo(30), timelineAt: hoursAgo(30) });
  await events.clusterPending();
  const label = await insertComposedItem(database, { sourceId: "ema", sourceType: "regulator", evidenceType: "regulatory-decision", title: "Label change: drug Z pancreatitis",
    registryIds: ["NCT-Z"], clusterKeys: [], visibleAt: hoursAgo(20), timelineAt: hoursAgo(20) });
  await events.clusterPending();
  // Its best development candidate is the label change, itself a development: the link still goes to the story's root.
  const coverage = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Label change for drug Z after pancreatitis",
    visibleAt: hoursAgo(5), timelineAt: hoursAgo(5) });
  await events.clusterPending();
  const [root, second, third] = await Promise.all([signal, label, coverage].map((item) => eventOf(database, item.id)));
  assert.equal(new Set([root.id, second.id, third.id]).size, 3, "three occurrences, no merge");
  const links = (await database.query("SELECT from_event_id, to_event_id FROM evimed_frontier.event_links WHERE relation = 'follows' ORDER BY to_event_id")).rows
    .map((row) => [String(row.from_event_id), String(row.to_event_id)]);
  assert.deepEqual(links, [[String(root.id), String(second.id)], [String(root.id), String(third.id)]], "a star around the root, not a chain");

  // The event page: its developments in time order, each by its representative, with where it stands.
  const page = await events.read(second.public_id, { order: "asc" });
  assert.deepEqual(page.developments.map((row) => [row.eventId, row.position, row.relation]),
    [[root.public_id, "earlier", "follows"], [third.public_id, "later", "follows"]]);
  assert.equal(page.developments[0].itemId, signal.publicId);
  assert.equal(page.developments[0].sourceName, "FDA");
  assert.deepEqual((await events.read(second.public_id, { order: "desc" })).developments.map((row) => row.eventId), [third.public_id, root.public_id]);
  assert.deepEqual((await events.read(third.public_id)).developments.map((row) => row.eventId), [second.public_id, root.public_id],
    "a sibling reads the other developments through the root; newest first by default");
  await assert.rejects(events.read(second.public_id, { order: "sideways" }), { code: "frontier_query_invalid" });

  // 事件后续 of an item: the story's other events by their representative, newest first.
  const followups = await frontierItemFollowups(database, signal.id);
  assert.deepEqual(followups, { eventId: root.public_id, more: false, rows: [
    { itemId: coverage.publicId, title: "Label change for drug Z after pancreatitis", sourceName: "STAT", at: hoursAgo(5), relation: "follows" },
    { itemId: label.publicId, title: "Label change: drug Z pancreatitis", sourceName: "EMA", at: hoursAgo(20), relation: "follows" },
  ] });
  assert.equal((await frontierItemFollowups(database, coverage.id)).rows.length, 2, "the root and the sibling");
});

test("follow-ups: other reports of the event, one per institution, the item never among them; at most the limit, with `more`", options, async () => {
  const events = layer({ embedder: null });
  const paper = await insertComposedItem(database, { sourceId: "nejm", title: "Paper", registryIds: ["NCT44"], visibleAt: hoursAgo(10), timelineAt: hoursAgo(10) });
  const early = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Reuters early", registryIds: ["NCT44"], clusterKeys: [],
    visibleAt: hoursAgo(9), timelineAt: hoursAgo(9) });
  const late = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Reuters late", registryIds: ["NCT44"], clusterKeys: [],
    visibleAt: hoursAgo(3), timelineAt: hoursAgo(3) });
  const stat = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "STAT take", registryIds: ["NCT44"], clusterKeys: [],
    visibleAt: hoursAgo(2), timelineAt: hoursAgo(2) });
  await events.clusterPending();
  const event = await eventOf(database, paper.id);
  assert.equal((await eventOf(database, stat.id)).id, event.id);
  const followups = await frontierItemFollowups(database, paper.id);
  assert.deepEqual(followups?.rows.map((row) => [row.itemId, row.relation]), [[stat.publicId, "same-event"], [late.publicId, "same-event"]],
    "Reuters once, by its newest report");
  assert.equal(followups?.eventId, event.public_id);
  assert.deepEqual((await frontierItemFollowups(database, late.id))?.rows.map((row) => row.itemId), [stat.publicId, early.publicId, paper.publicId],
    "the item's own institution's other report is a report too");
  assert.deepEqual(await frontierItemFollowups(database, paper.id, { limit: 1 }).then((value) => [value?.rows.length, value?.more]), [1, true]);
  const lone = await insertComposedItem(database, { sourceId: "ema", sourceType: "regulator", title: "Unrelated notice", visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  await events.clusterPending();
  assert.equal(await frontierItemFollowups(database, lone.id), null, "nothing to show: no block");
  assert.equal(await frontierItemFollowups(database, "999999999"), null);
  await assert.rejects(frontierItemFollowups(database, paper.id, { limit: 0 }), TypeError);
});

test("one selected item per event: a report that adds nothing to the selected one leaves the selected feed and names it; a safety alert stays", options, async () => {
  const quiet = stubEditor({ selection: { addsValue: false, reason: "已入选报道已写出主要结果" } });
  const events = layer({ editor: quiet, embedder: null });
  const paper = await insertComposedItem(database, { sourceId: "nejm", title: "Paper", registryIds: ["NCT55"], selected: true, selectedRule: "threshold",
    scoreTotal: 88, visibleAt: hoursAgo(10), timelineAt: hoursAgo(10) });
  await events.clusterPending();
  const echo = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Echo of the paper", registryIds: ["NCT55"], clusterKeys: [],
    selected: true, selectedRule: "threshold", visibleAt: hoursAgo(5), timelineAt: hoursAgo(5) });
  const before = await metaValue(database, "content_version");
  await events.clusterPending();
  assert.match(quiet.calls.group[0].input, /【已入选】/, "the selected report is shown beside its event");
  const row = (await database.query("SELECT selected, selected_rule, same_event_item_id, event_selection FROM evimed_frontier.items WHERE id = $1", [echo.id])).rows[0];
  assert.deepEqual([row.selected, row.selected_rule, String(row.same_event_item_id)], [false, null, paper.id]);
  assert.equal(row.event_selection.addsValue, false);
  assert.equal(row.event_selection.reason, "已入选报道已写出主要结果");
  assert.equal(row.event_selection.decidedAt, NOW.toISOString());
  assert.deepEqual((await database.query("SELECT reason FROM evimed_frontier.item_changes WHERE item_id = $1", [echo.id])).rows.map((change) => change.reason), ["same-event"]);
  assert.ok(await metaValue(database, "content_version") > before);
  assert.equal(events.counters.sameEventUnselected, 1);
  assert.equal((await database.query("SELECT selected FROM evimed_frontier.items WHERE id = $1", [paper.id])).rows[0].selected, true, "the selected one stays");

  const alert = await insertComposedItem(database, { sourceId: "fda", sourceType: "regulator", evidenceType: "safety-notice", title: "FDA safety alert on the drug",
    registryIds: ["NCT55"], clusterKeys: [], selected: true, selectedRule: "safety-bypass", safetyAlert: true, visibleAt: hoursAgo(4), timelineAt: hoursAgo(4) });
  await events.clusterPending();
  const kept = (await database.query("SELECT selected, selected_rule, same_event_item_id FROM evimed_frontier.items WHERE id = $1", [alert.id])).rows[0];
  assert.deepEqual([kept.selected, kept.selected_rule, String(kept.same_event_item_id)], [true, "safety-bypass", paper.id],
    "a safety alert keeps its place, and still names the selected report");

  const valuable = layer({ editor: stubEditor({ selection: { addsValue: true, reason: "给出了亚组数据" } }), embedder: null });
  const subgroup = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Subgroup data", registryIds: ["NCT55"], clusterKeys: [],
    selected: true, selectedRule: "threshold", visibleAt: hoursAgo(3), timelineAt: hoursAgo(3) });
  await valuable.clusterPending();
  const added = (await database.query("SELECT selected, same_event_item_id, event_selection FROM evimed_frontier.items WHERE id = $1", [subgroup.id])).rows[0];
  assert.deepEqual([added.selected, added.same_event_item_id, added.event_selection.addsValue], [true, null, true], "new information stays selected");

  // With nothing selected to compare against there is no reading value to judge: nothing is recorded.
  const fresh = await insertComposedItem(database, { sourceId: "ema", sourceType: "regulator", title: "EMA opinion", registryIds: ["NCT66"], visibleAt: hoursAgo(2), timelineAt: hoursAgo(2) });
  const second = await insertComposedItem(database, { sourceId: "yimaitong", sourceType: "media", title: "Opinion coverage", registryIds: ["NCT66"], clusterKeys: [],
    selected: true, selectedRule: "threshold", visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  await events.clusterPending();
  assert.equal((await eventOf(database, second.id)).id, (await eventOf(database, fresh.id)).id);
  const untouched = (await database.query("SELECT selected, event_selection FROM evimed_frontier.items WHERE id = $1", [second.id])).rows[0];
  assert.deepEqual([untouched.selected, untouched.event_selection], [true, null]);
});

test("an item without a vector is recalled by its words: the same policy from two outlets meets, a stranger does not", options, async () => {
  const editor = stubEditor({ decide: always("SAME_OCCURRENCE") });
  const events = layer({ editor });
  await insertSource(database, "pharmnet", { name: "中国医药网", source_type: "media", owner_entity: "pharmnet" });
  await insertSource(database, "ithome", { name: "IT之家", source_type: "media", owner_entity: "ithome" });
  // Production, 2026-10-20: the two reports were 0.96 apart and in two events, for want of a shared drug or organisation.
  const first = await insertComposedItem(database, { sourceId: "pharmnet", lang: "zh", title: "医保钱包升级2.0版 职工个账跨省共济全国落地",
    titleZh: "医保钱包升级2.0版 职工个账跨省共济全国落地", visibleAt: hoursAgo(10), timelineAt: hoursAgo(10) });
  const stranger = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Hospitals sue over a rebate pilot",
    visibleAt: hoursAgo(9), timelineAt: hoursAgo(9) });
  const second = await insertComposedItem(database, { sourceId: "ithome", lang: "zh", title: "医保钱包 2.0 版上线，个人账户跨省共济落地全国",
    titleZh: "医保钱包 2.0 版上线，个人账户跨省共济落地全国", visibleAt: hoursAgo(8), timelineAt: hoursAgo(8) });
  await events.clusterPending();
  assert.equal((await eventOf(database, second.id)).id, (await eventOf(database, first.id)).id);
  assert.notEqual((await eventOf(database, stranger.id)).id, (await eventOf(database, first.id)).id);
  assert.equal(events.counters.lexicalRecalls, 3, "every item without a vector after its grace");
  assert.equal(editor.calls.pair.length, 1, "words give no cosine: a join by them is looked at again");
});

test("the backfill: the report asks nothing and writes nothing; the run places the old items again, and their old events answer 308", options, async () => {
  // Clustered by the old rule: one event each, though two are one occurrence and a third develops it.
  const bare = layer({ editor: null });
  const a = await insertComposedItem(database, { sourceId: "nejm", title: "Trial A results", vector: vectorAt(1), visibleAt: hoursAgo(30), timelineAt: hoursAgo(30) });
  const b = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Coverage of A", vector: vectorAt(0.9, 1),
    selected: true, selectedRule: "threshold", visibleAt: hoursAgo(29), timelineAt: hoursAgo(29) });
  const c = await insertComposedItem(database, { sourceId: "fda", sourceType: "regulator", title: "FDA approves A", vector: vectorAt(0.7, 2),
    visibleAt: hoursAgo(5), timelineAt: hoursAgo(5) });
  await database.query("UPDATE evimed_frontier.items SET selected = true, selected_rule = 'threshold' WHERE id = $1", [a.id]);
  await bare.clusterPending();
  const [ea, eb, ec] = await Promise.all([a, b, c].map((item) => eventOf(database, item.id)));
  assert.equal(new Set([ea.id, eb.id, ec.id]).size, 3);

  const editor = stubEditor({ decide: (report) => (report.title === "FDA approves A" ? "SAME_STORY" : "SAME_OCCURRENCE"),
    selection: { addsValue: false, reason: "重复" } });
  const events = layer({ editor });
  const window = { since: new Date(NOW.getTime() - 14 * 24 * 3_600_000), until: NOW };
  const report = await events.regroupRecent({ ...window });
  assert.deepEqual([report.items, report.withCandidates, report.candidateEvents, report.apply], [3, 2, 3, false],
    "B recalls A; C recalls A and B (0.7, 0.63); A has nothing before it");
  assert.equal(editor.calls.group.length, 0, "the report asks nothing");
  assert.equal((await eventOf(database, b.id)).id, eb.id, "…and writes nothing");

  const run = await events.regroupRecent({ ...window, apply: true, concurrency: 1 });
  assert.deepEqual([run.scanned, run.merged, run.joined, run.kept, run.failed, run.stopped], [3, 1, 1, 1, 0, null]);
  assert.equal((await eventOf(database, b.id)).id, ea.id, "B moved to A's event");
  assert.deepEqual(await events.read(eb.public_id), { redirect: ea.public_id }, "B's old event answers 308 for good");
  assert.equal(new Date((await database.query("SELECT merged_at FROM evimed_frontier.events WHERE id = $1", [eb.id])).rows[0].merged_at).toISOString(),
    NOW.toISOString(), "the recall reads the days before the item; what is written is written now");
  const moved = (await database.query("SELECT selected, same_event_item_id FROM evimed_frontier.items WHERE id = $1", [b.id])).rows[0];
  assert.deepEqual([moved.selected, String(moved.same_event_item_id)], [false, a.id], "the gate as for a new item");
  assert.deepEqual((await database.query("SELECT from_event_id, to_event_id, relation FROM evimed_frontier.event_links")).rows
    .map((row) => [String(row.from_event_id), String(row.to_event_id), row.relation]), [[String(ea.id), String(ec.id), "follows"]]);
  assert.equal((await eventOf(database, a.id)).report_count, 2);
  const again = await events.regroupRecent({ ...window, apply: true });
  assert.deepEqual([again.merged, again.joined], [0, 0], "a second run changes nothing");
  await assert.rejects(events.regroupRecent({ since: NOW, until: NOW }), TypeError);
  const spent = await layer({ editor, budget: async () => ({ state: "exhausted" }) }).regroupRecent({ ...window, apply: true });
  assert.equal(spent.stopped, "budget");
});

test("shared trial without an adjudicator keeps distinct events", options, async () => {
  const events = layer({ editor: null, embedder: null });
  const first = await insertComposedItem(database, { sourceId: "ctgov", title: "Registry update", registryIds: ["NCT09999999"], visibleAt: hoursAgo(4), timelineAt: hoursAgo(4) });
  await events.clusterPending();
  const second = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Trial delayed", registryIds: ["NCT09999999"], visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  await events.clusterPending();
  assert.notEqual((await eventOf(database, first.id)).id, (await eventOf(database, second.id)).id);
  assert.equal(events.counters.adjudicationSkipped, 1);
});

test("exact paper and press coverage join after the judge sees work context", options, async () => {
  const editor = stubEditor();
  const events = layer({ editor, embedder: null });
  const first = await insertComposedItem(database, { sourceId: "nejm", title: "Primary trial paper", doi: "10.1000/exact-paper", registryIds: ["NCT07777777"], visibleAt: hoursAgo(4), timelineAt: hoursAgo(4) });
  await events.clusterPending();
  const second = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Press coverage of the paper", registryIds: ["NCT07777777"], visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  await events.clusterPending();
  assert.equal((await eventOf(database, first.id)).id, (await eventOf(database, second.id)).id);
  assert.equal(events.counters.adjudicated, 1);
  assert.equal(editor.calls.group[0].candidates[0].doi, "10.1000/exact-paper");
});

test("failed semantic adjudication preserves separate usable events", options, async () => {
  const editor = { available: true, callJson: async () => { throw new Error("model unavailable"); } };
  const events = layer({ editor, embedder: null });
  const first = await insertComposedItem(database, { sourceId: "ctgov", title: "Milestone one", registryIds: ["NCT06666666"], visibleAt: hoursAgo(4), timelineAt: hoursAgo(4) });
  await events.clusterPending();
  const second = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Milestone two", registryIds: ["NCT06666666"], visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  const summary = await events.clusterPending();
  assert.equal(summary.created, 1);
  assert.equal(summary.skipped, 0);
  assert.notEqual((await eventOf(database, first.id)).id, (await eventOf(database, second.id)).id);
  assert.equal(events.counters.adjudicationFailures, 1);
});
