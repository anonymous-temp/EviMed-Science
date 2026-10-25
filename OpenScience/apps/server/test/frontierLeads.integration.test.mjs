// The frontier feed's lead triggers (ct-mix 2026-10-24) against a real PostgreSQL: a fake web-search gateway and a fake
// plugin, everything else real — what is planned from the tables, the module's purpose and budget on every search, the
// dedupe by day and by address, the daily cap and its shares, the identifiers handed over as addresses, the records.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FrontierLeads, frontierLeadUrl, migrateFrontierLeads } from "../src/frontierLeads.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { insertSource } from "./helpers/frontierFixtures.mjs";
import { insertComposedItem, resetFrontier } from "./helpers/frontierComposeFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
/** 2026-10-24 10:00 in Shanghai: after the watch hour, during ESMO 2026. */
const NOW = new Date("2026-10-24T02:00:00Z");
/** 2026-10-24 07:00 in Shanghai: before it. */
const EARLY = new Date("2026-10-23T23:00:00Z");
const hoursAgo = (/** @type {number} */ hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const owner = { userId: "frontier-operator", projectId: "evimed-frontier" };

/** @type {any} */
let database;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
  await migrateFrontierLeads(database);
});

after(async () => {
  if (database) await database.close();
});

beforeEach(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.lead_urls");
  await database.query("DELETE FROM evimed_frontier.leads");
  await database.query("DELETE FROM evimed_frontier.hot_snapshots");
  await database.query("DELETE FROM evimed_frontier.item_keys");
  await resetFrontier(database);
  await insertSource(database, "nejm", { authority: 5 });
  await insertSource(database, "reuters", { name: "Reuters", source_type: "media", authority: 3, homepage: "https://www.reuters.com/" });
  await insertSource(database, "pharma", { name: "Pharma newsroom", source_type: "company", lane: "pipeline", authority: 2 });
});

/** A gateway that answers every query with the pages it is given, recording what it was asked and for whom. */
function fakeSearch(pages = (/** @type {any} */ body) => [
  { url: `https://news.example.cn/${encodeURIComponent(body.query)}/1`, title: `${body.query} 一`, snippet: "s", engine: "deepseek", publishedDate: "2026-10-24T01:00:00.000Z" },
  { url: `https://news.example.cn/${encodeURIComponent(body.query)}/2`, title: `${body.query} 二`, snippet: "s", engine: "searxng", publishedDate: null },
]) {
  /** @type {Array<{ body: any, caller: any }>} */
  const calls = [];
  return {
    calls,
    async search(/** @type {any} */ body, /** @type {{ caller: any }} */ { caller }) {
      calls.push({ body, caller });
      if (body.query.includes("失败")) throw Object.assign(new Error("down"), { code: "web_search_unavailable" });
      const results = pages(body);
      return { data: { query: body.query, results, engines: [...new Set(results.map((row) => row.engine))] }, warnings: [] };
    },
  };
}

/** A plugin that accepts what it has not seen and calls the rest duplicates, as `/v1/leads` does. */
function fakePlugin({ fail = false } = {}) {
  const seen = new Set();
  /** @type {any[][]} */
  const posts = [];
  return {
    posts, configured: true,
    async submitLeads(/** @type {any[]} */ leads) {
      posts.push(leads);
      if (fail) throw Object.assign(new Error("down"), { code: "knowledge_plugin_unreachable" });
      const results = leads.map((lead) => {
        const status = seen.has(lead.url) ? "duplicate" : "accepted";
        seen.add(lead.url);
        return { url: lead.url, status, reason: null };
      });
      return { accepted: results.filter((r) => r.status === "accepted").length, duplicate: results.filter((r) => r.status === "duplicate").length, refused: 0, capped: 0, results };
    },
  };
}

/** @param {{ search?: any, plugin?: any, now?: Date, budget?: any, config?: Record<string, any> }} [input] */
function leadsWith({ search = fakeSearch(), plugin = fakePlugin(), now = NOW, budget = async () => ({ state: "ok" }), config = {} } = {}) {
  const leads = new FrontierLeads({ database, plugin, webSearch: search, owner: () => owner, budget,
    config: { frontierTimeZone: "Asia/Shanghai", frontierDailyBudgetCny: 300, ...config }, now: () => now });
  return { leads, search, plugin };
}

/** A selected English report and its feed: the item a Chinese report is looked for. */
async function seedSelected() {
  const paper = await insertComposedItem(database, { sourceId: "nejm", title: "Semaglutide and kidney outcomes", titleZh: "司美格鲁肽改善肾脏结局",
    selected: true, selectedRule: "threshold", scoreTotal: 90, visibleAt: hoursAgo(5), timelineAt: hoursAgo(5) });
  await database.query("UPDATE evimed_frontier.items SET tags = ARRAY['GLP-1受体激动剂', '肾脏病'], specialties = ARRAY['nephrology'], entities = $2::jsonb WHERE id = $1",
    [paper.id, JSON.stringify({ drugs: ["司美格鲁肽"], diseases: ["慢性肾病"], trials: [], orgs: [] })]);
  return paper;
}

test("the plan: identifiers as addresses first, then the follow-ups, then — from the watch hour — the watches; nothing twice a day", options, async () => {
  await seedSelected();
  // A selected news report naming a paper the feed does not have (DOI in its text) and a trial it does have.
  const story = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Drug cuts heart attacks", titleZh: "新药减少心梗",
    selected: true, selectedRule: "threshold", scoreTotal: 88, registryIds: ["NCT01234567"], visibleAt: hoursAgo(3), timelineAt: hoursAgo(3) });
  await database.query("UPDATE evimed_frontier.item_texts SET abstract_raw = 'Published in NEJM (doi:10.1056/NEJMoa2599999).' WHERE item_id = $1", [story.id]);
  const registry = await insertComposedItem(database, { sourceId: "nejm", title: "NCT01234567 results posted", clusterKeys: [], visibleAt: hoursAgo(30), timelineAt: hoursAgo(30) });
  await database.query("DELETE FROM evimed_frontier.item_keys WHERE key = 'reg:NCT01234567'");
  await database.query("INSERT INTO evimed_frontier.item_keys (key, item_id) VALUES ('reg:NCT01234567', $1)", [registry.id]);
  // A newsroom release with no identifier: its own words are searched, its own site left out.
  const release = await insertComposedItem(database, { sourceId: "pharma", sourceType: "company", evidenceType: "press-release", title: "Acme announces phase 3 results",
    titleZh: "Acme 公布三期结果", selected: true, selectedRule: "genre-floor", scoreTotal: 70, visibleAt: hoursAgo(2), timelineAt: hoursAgo(2) });
  await database.query("INSERT INTO evimed_frontier.events (public_id, title_zh, lane, first_at, last_at) VALUES ('hotevent00000001', '新冠疫苗加强针接种建议更新', 'evidence', now(), now())");
  await database.query(`INSERT INTO evimed_frontier.hot_snapshots (taken_at, ranking) VALUES ($1, $2::jsonb)`,
    [NOW, JSON.stringify([{ rank: 1, eventId: "hotevent00000001", delta: null }, { rank: 2, eventId: "staying00000000", delta: 0 }])]);

  const early = await leadsWith({ now: EARLY }).leads.plan();
  assert.deepEqual([...new Set(early.map((plan) => plan.trigger))].sort(), ["event-hot", "primary-source", "zh-report"], "before the watch hour: follow-ups only");
  const plans = await leadsWith().leads.plan();
  const address = plans.filter((plan) => plan.kind === "address");
  assert.deepEqual(address.map((plan) => /** @type {any} */ (plan).url), ["https://doi.org/10.1056/nejmoa2599999"], "the DOI it names and the feed lacks; the trial it has");
  assert.equal(plans.indexOf(address[0]), 0, "an address costs no search and goes first");
  const releaseSearch = plans.find((plan) => plan.trigger === "primary-source" && plan.kind === "search");
  assert.deepEqual([/** @type {any} */ (releaseSearch).query, /** @type {any} */ (releaseSearch).subject.item], ["Acme announces phase 3 results press release", release.publicId]);
  assert.ok(plans.some((plan) => plan.trigger === "event-hot" && /** @type {any} */ (plan).query === "新冠疫苗加强针接种建议更新"), "the event that entered the list");
  assert.equal(plans.filter((plan) => plan.trigger === "event-hot").length, 1, "one that stayed is not new");
  assert.ok(plans.some((plan) => plan.trigger === "zh-report" && /** @type {any} */ (plan).query === "司美格鲁肽改善肾脏结局"));
  assert.ok(plans.some((plan) => plan.trigger === "regulatory-watch" && /** @type {any} */ (plan).query === "国家药监局 批准 上市"));
  assert.ok(plans.some((plan) => plan.trigger === "congress" && /** @type {any} */ (plan).query === "ESMO 2026"), "ESMO 2026 is on");
  assert.ok(plans.some((plan) => plan.trigger === "hot-tag" && /** @type {any} */ (plan).query === "GLP-1受体激动剂 最新进展"));
  assert.ok(plans.some((plan) => plan.trigger === "specialty" && /^(司美格鲁肽|慢性肾病) 最新$/.test(/** @type {any} */ (plan).query)));
  assert.ok(plans.some((plan) => plan.trigger === "genre-gap"), "yesterday selected nothing: every gap group searches");
  const keys = plans.map((plan) => `${plan.trigger}|${plan.kind === "search" ? plan.query : plan.url}`);
  assert.equal(new Set(keys).size, keys.length, "nothing planned twice");
});

test("a tick: each search booked under the module's purpose and budget, results the feed has left out, the rest handed over and recorded; the next tick repeats nothing", options, async () => {
  const paper = await seedSelected();
  const known = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Already here", visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  const knownUrl = (await database.query("SELECT canonical_url FROM evimed_frontier.items WHERE id = $1", [known.id])).rows[0].canonical_url;
  const search = fakeSearch((body) => [
    { url: knownUrl, title: "already", engine: "deepseek" },
    { url: `https://news.example.cn/${encodeURIComponent(body.query)}/new#top`, title: "新的报道", snippet: "s", engine: "deepseek", publishedDate: "2026-10-24T01:00:00.000Z" },
    { url: "ftp://not.a.page/x", title: "bad", engine: "searxng" },
  ]);
  const { leads, plugin } = leadsWith({ search, config: { frontierLeadsDailyQueries: 16 } });
  const first = await leads.tick();
  assert.ok(first.searched > 0 && first.searched <= 12, `at most a tick's share: ${first.searched}`);
  for (const { caller } of search.calls) assert.deepEqual(caller, { ...owner, runId: null, purpose: "frontier", moduleLimit: 300 });
  const handed = plugin.posts.flat();
  assert.ok(handed.every((lead) => lead.url !== knownUrl), "a page the feed has is not handed over");
  assert.ok(handed.every((lead) => lead.url.startsWith("https://news.example.cn/") && !lead.url.includes("#")), "an address without its fragment");
  assert.ok(handed.every((lead) => typeof lead.trigger === "string" && lead.published_hint === "2026-10-24T01:00:00.000Z"));
  const rows = (await database.query("SELECT trigger, kind, status, sent, accepted, cost_cny, results FROM evimed_frontier.leads ORDER BY id")).rows;
  assert.equal(rows.length, first.searched);
  assert.ok(rows.every((row) => row.status === "sent" && row.sent === 1 && row.accepted === 1 && Number(row.cost_cny) === 0.005));
  assert.ok(rows.every((row) => row.results.some((result) => result.known === true)), "what the feed had is recorded as known");
  const zh = rows.find((row) => row.trigger === "zh-report");
  assert.ok(zh, "the selected English paper is looked for in Chinese");
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.lead_urls WHERE outcome = 'accepted'")).rows[0].n, first.searched);
  // The next ticks: nothing is searched twice in a day, so with every trigger's candidates searched there is nothing left.
  const calls = search.calls.length;
  await leads.tick();
  await leads.tick();
  const queries = search.calls.map((call) => call.body.query);
  assert.equal(new Set(queries).size, queries.length, "a query once a day");
  assert.equal(search.calls.length, calls, "nothing left to search today");
  // A day's cap and its shares bound a trigger: with 8 searches a day, one place each.
  await database.query("DELETE FROM evimed_frontier.leads");
  const tight = leadsWith({ config: { frontierLeadsDailyQueries: 8 } });
  await tight.leads.tick();
  const byTrigger = (await database.query("SELECT trigger, count(*)::integer AS n FROM evimed_frontier.leads WHERE kind = 'search' GROUP BY trigger")).rows;
  assert.ok(byTrigger.every((row) => row.n === 1), JSON.stringify(byTrigger));
  assert.equal(leads.status().counters.plugin.accepted, search.calls.length);
  assert.ok(paper.id);
});

test("a budget that is not ok searches nothing and still hands over an address; a failed search and a plugin that does not answer are recorded and the rest goes on", options, async () => {
  const story = await insertComposedItem(database, { sourceId: "reuters", sourceType: "media", title: "Trial result reported", selected: true, selectedRule: "threshold",
    scoreTotal: 88, registryIds: ["NCT07654321"], visibleAt: hoursAgo(3), timelineAt: hoursAgo(3) });
  assert.ok(story.id);
  const throttled = leadsWith({ budget: async () => ({ state: "throttled" }) });
  const result = await throttled.leads.tick();
  assert.deepEqual([result.searched, result.addresses], [0, 1]);
  assert.equal(throttled.search.calls.length, 0);
  assert.deepEqual(throttled.plugin.posts.flat().map((lead) => [lead.url, lead.trigger]), [["https://clinicaltrials.gov/study/NCT07654321", "primary-source"]]);
  assert.equal(throttled.leads.status().counters.skipped.budget_throttled, 1);

  await database.query("DELETE FROM evimed_frontier.lead_urls");
  await database.query("DELETE FROM evimed_frontier.leads");
  const down = leadsWith({ plugin: fakePlugin({ fail: true }), search: fakeSearch((body) => (body.query.includes("批准 上市")
    ? [{ url: "https://nmpa.example.cn/a", title: "a", engine: "searxng" }] : [])) });
  await down.leads.tick();
  const unsent = (await database.query("SELECT url, outcome FROM evimed_frontier.lead_urls ORDER BY url")).rows;
  assert.deepEqual(unsent.map((row) => row.outcome).filter((outcome) => outcome !== "unsent"), []);
  assert.ok(unsent.some((row) => row.url === "https://nmpa.example.cn/a"));
  const failed = (await database.query("SELECT status, status_code FROM evimed_frontier.leads WHERE status = 'failed'")).rows;
  assert.ok(failed.length >= 1 && failed.every((row) => row.status_code === "knowledge_plugin_unreachable"));
  assert.ok((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.leads WHERE status = 'empty'")).rows[0].n >= 1, "a search with nothing new is empty, not failed");
  assert.equal(down.leads.status().counters.failures.knowledge_plugin_unreachable >= 1, true);
});

test("switched off, without a search, a plugin or an owner the module does nothing, and says why", options, async () => {
  const off = new FrontierLeads({ database, plugin: fakePlugin(), webSearch: fakeSearch(), owner: () => owner, config: { frontierLeadsEnabled: false } });
  assert.deepEqual(await off.tick(), { searched: 0, addresses: 0, sent: 0, skipped: "disabled" });
  const blind = new FrontierLeads({ database, plugin: fakePlugin(), webSearch: null, owner: () => owner });
  assert.equal((await blind.tick()).skipped, "unconfigured");
  const orphan = new FrontierLeads({ database, plugin: fakePlugin(), webSearch: fakeSearch(), owner: () => null });
  assert.equal((await orphan.tick()).skipped, "no_owner");
  assert.equal(frontierLeadUrl("javascript:alert(1)"), null);
  assert.equal(frontierLeadUrl("https://fake:fake@example.org/x"), null);
  assert.equal(frontierLeadUrl("https://example.org/a?b=1#c"), "https://example.org/a?b=1");
  assert.equal(createHash("sha256").update("x").digest("hex").length, 64);
});

test("a Chinese report is looked for in Chinese: only results with a Chinese title are handed over; a social network's page never is", options, async () => {
  await seedSelected();
  const search = fakeSearch((body) => [
    { url: "https://www.medpagetoday.com/a", title: "Semaglutide and the kidney", engine: "deepseek" },
    { url: "https://www.linkedin.com/posts/x", title: "司美格鲁肽 肾脏 帖子", engine: "deepseek" },
    { url: `https://www.familydoctor.cn/${encodeURIComponent(body.query)}`, title: "司美格鲁肽改善肾脏结局：解读", engine: "deepseek" },
  ]);
  const { leads, plugin } = leadsWith({ search, now: EARLY });
  await leads.tick();
  const zh = plugin.posts.flat().filter((lead) => lead.trigger === "zh-report");
  assert.deepEqual(zh.map((lead) => new URL(lead.url).hostname), ["www.familydoctor.cn"]);
  assert.ok(plugin.posts.flat().every((lead) => !lead.url.includes("linkedin.com")));
});

// c2-leads 2026-10-25 (review §R): the plugin's day cap ends the day's searching, results older than the plugin reads are
// not handed over, a host it keeps refusing gets no more addresses, and a capped address may go another day.
test("once the plugin answers capped, nothing more is searched that day — a restart included; a capped address goes again the next day", options, async () => {
  await seedSelected();
  /** A plugin whose day is spent after `room` addresses. */
  const capping = (/** @type {number} */ room) => {
    let accepted = 0;
    /** @type {any[][]} */
    const posts = [];
    return { posts, configured: true, async submitLeads(/** @type {any[]} */ leads) {
      posts.push(leads);
      const results = leads.map((lead) => ({ url: lead.url, status: accepted < room ? (accepted += 1, "accepted") : "capped", reason: null }));
      return { accepted: results.filter((r) => r.status === "accepted").length, duplicate: 0, refused: 0, capped: results.filter((r) => r.status === "capped").length, results };
    } };
  };
  const first = leadsWith({ plugin: capping(1) });
  const result = await first.leads.tick();
  assert.equal(result.skipped, "plugin_capped");
  assert.equal(first.search.calls.length, 1, "the search whose results were capped is the day's last");
  assert.equal(first.leads.status().counters.skipped.plugin_capped, 1);
  // A restart: a new module reads the mark from the table and searches nothing.
  const restarted = leadsWith({ plugin: capping(10) });
  assert.deepEqual(await restarted.leads.tick(), { searched: 0, addresses: 0, sent: 0, skipped: "plugin_capped" });
  assert.equal(restarted.search.calls.length, 0);
  // The next day the capped address is handed over again, and recorded as what the plugin answered then.
  const capped = (await database.query("SELECT url FROM evimed_frontier.lead_urls WHERE outcome = 'capped' LIMIT 1")).rows[0].url;
  const tomorrow = new Date(NOW.getTime() + 24 * 3_600_000);
  const next = leadsWith({ now: tomorrow, plugin: capping(100), search: fakeSearch(() => [{ url: capped, title: "又一次", engine: "deepseek", publishedDate: "2026-10-25T01:00:00.000Z" }]) });
  await next.leads.tick();
  assert.ok(next.plugin.posts.flat().some((lead) => lead.url === capped), "a capped address is not known to the plugin");
  assert.equal((await database.query("SELECT outcome FROM evimed_frontier.lead_urls WHERE url = $1", [capped])).rows[0].outcome, "accepted");
});

test("a result dated before the plugin's freshness window is held as stale; an undated one is handed over; a host refused twice in 7 days is held", options, async () => {
  await seedSelected();
  for (const [index, url] of ["https://blocked.example.cn/a", "https://www.blocked.example.cn/b"].entries()) {
    await database.query("INSERT INTO evimed_frontier.lead_urls (url_sha256, url, trigger, outcome, sent_at) VALUES ($1, $2, 'zh-report', 'refused', $3)",
      [createHash("sha256").update(url).digest("hex"), url, new Date(NOW.getTime() - (index + 1) * 86_400_000)]);
  }
  await database.query("INSERT INTO evimed_frontier.lead_urls (url_sha256, url, trigger, outcome, sent_at) VALUES ($1, $2, 'zh-report', 'refused', $3)",
    [createHash("sha256").update("https://once.example.cn/a").digest("hex"), "https://once.example.cn/a", new Date(NOW.getTime() - 86_400_000)]);
  const search = fakeSearch((body) => [
    { url: `https://news.example.cn/${encodeURIComponent(body.query)}/old`, title: "旧闻", engine: "deepseek", publishedDate: "2026-08-01T00:00:00.000Z" },
    { url: `https://news.example.cn/${encodeURIComponent(body.query)}/undated`, title: "无日期", engine: "searxng", publishedDate: null },
    { url: `https://blocked.example.cn/${encodeURIComponent(body.query)}`, title: "被拒的站", engine: "deepseek", publishedDate: "2026-10-24T01:00:00.000Z" },
    { url: `https://once.example.cn/${encodeURIComponent(body.query)}`, title: "拒过一次", engine: "deepseek", publishedDate: "2026-10-24T01:00:00.000Z" },
  ]);
  const { leads, plugin } = leadsWith({ search, now: EARLY });
  await leads.tick();
  const handed = plugin.posts.flat().map((lead) => lead.url);
  assert.ok(handed.length > 0);
  assert.ok(handed.every((url) => !url.endsWith("/old")), "older than 30 days: the plugin would answer stale");
  assert.ok(handed.some((url) => url.endsWith("/undated")), "no date: the page may carry one");
  assert.ok(handed.every((url) => !url.startsWith("https://blocked.example.cn/")), "refused twice in 7 days, www. or not");
  assert.ok(handed.some((url) => url.startsWith("https://once.example.cn/")), "refused once is not yet a pattern");
  const results = (await database.query("SELECT results FROM evimed_frontier.leads WHERE status = 'sent' LIMIT 1")).rows[0].results;
  assert.deepEqual(results.filter((/** @type {any} */ row) => row.skipped).map((/** @type {any} */ row) => row.skipped).sort(), ["refused-host", "stale"]);
  assert.ok(leads.status().counters.held.stale >= 1 && leads.status().counters.held["refused-host"] >= 1);
});

test("the platform's freshness window is the plugin's own FRESH_DAYS", async () => {
  const { readFile } = await import("node:fs/promises");
  const { FRONTIER_LEAD_FRESH_DAYS } = await import("@evimed/domain");
  const source = await readFile(new URL("../../../../项目代码/knowledge-plugin/knowledge_plugin/leads.py", import.meta.url), "utf8").catch(() => null);
  if (source === null) return;
  assert.equal(Number(/^FRESH_DAYS = (\d+)/m.exec(source)?.[1]), FRONTIER_LEAD_FRESH_DAYS);
});
