// The feed's second wave in the real hosted app over HTTP, against a real
// PostgreSQL (build spec D.7): what /status offers, the safety rail's filter,
// the hot list and an event page with its permanent redirect, the daily, the
// two reader actions through the upload's own path, and the upload route
// itself after it gave that path up to a shared helper.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { insertSource, memoryPlugin, pluginSource } from "./helpers/frontierFixtures.mjs";
import { insertComposedItem } from "./helpers/frontierComposeFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const suffix = randomUUID().slice(0, 8);
const accounts = { operator: `ops2${suffix}`, reader: `reader2${suffix}` };
const PASSWORD = "test-only-frontier-password";
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(128, 7)]);
let context = null;

before(async () => {
  if (!databaseUrl) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-frontier-wave2-"));
  const tokenFile = path.join(dataDir, "knowledge-plugin.token");
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [] });
  const pdfRequests = [];
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl, operatorMetricsToken: "test-only-metrics-token",
    operatorUsers: [accounts.operator], frontierEnabled: true, frontierAudience: "all",
    knowledgePluginUrl: "http://plugin.test:8080", knowledgePluginTokenFile: tokenFile, knowledgePluginFetch: plugin.fetchImpl,
    frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} },
    frontierPdfTransport: async (request) => {
      pdfRequests.push(String(request.url));
      return { status: 200, headers: { "content-type": "application/pdf" }, body: PDF };
    } });
  for (const id of Object.values(accounts)) await app.store.createUser(id, PASSWORD, id);
  const address = await app.listen(0, "127.0.0.1");
  await app.frontierWorker.tick();
  await app.frontierWorker.close();
  const base = `http://127.0.0.1:${address.port}`;
  /** @type {Record<string, Record<string, string>>} */
  const sessions = {};
  for (const [role, id] of Object.entries(accounts)) {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: id, password: PASSWORD }) });
    const body = await login.json();
    sessions[role] = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0],
      "x-open-science-csrf": body.data.csrfToken };
  }
  const database = app.store.database;
  await insertSource(database, "nejm", { authority: 5 });
  await insertSource(database, "fda", { name: "FDA", lane: "regulatory", source_type: "regulator", authority: 5, owner_entity: "us-fda" });
  await insertSource(database, "stat", { name: "STAT", source_type: "media", authority: 3, owner_entity: "stat" });
  context = { app, base, sessions, database, dataDir, pdfRequests };
});

after(async () => {
  if (!context) return;
  await context.database.query("DELETE FROM evimed_control.users WHERE id = ANY($1::text[])", [Object.values(accounts)]);
  await context.app.close();
  await rm(context.dataDir, { recursive: true, force: true });
});

const now = () => new Date();
const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();

test("/status offers what this deployment has, says personalization is off without a model, and reading it marks the reader seen", options, async () => {
  const { base, sessions, database } = context;
  const answer = await fetch(`${base}/api/frontier/status`, { headers: sessions.reader });
  assert.equal(answer.status, 200);
  const status = (await answer.json()).data;
  assert.equal(status.personalization, "off", "a memory store without a model to read it with cannot personalize");
  assert.deepEqual(status.capabilities, { saveToLibrary: true, abstractZh: false, forYou: false, hot: true, daily: true });
  const seen = (await database.query("SELECT last_seen_at FROM evimed_frontier.user_prefs WHERE user_id = $1", [accounts.reader])).rows[0];
  assert.ok(seen?.last_seen_at, "the page read marks the reader for the daily's audience");
  const forYou = await (await fetch(`${base}/api/frontier/for-you`, { headers: sessions.reader })).json();
  assert.deepEqual(forYou.data, { state: "off", basis: null, items: [] });
});

test("safety=1 lists safety alerts from every lane; a bad value is refused", options, async () => {
  const { base, sessions, database } = context;
  const inSafety = await insertComposedItem(database, { sourceId: "fda", lane: "safety", sourceType: "regulator", safetyAlert: true, selected: true,
    title: "Safety lane alert", visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  const inRegulatory = await insertComposedItem(database, { sourceId: "fda", lane: "regulatory", sourceType: "regulator", safetyAlert: true, selected: true,
    title: "Regulatory lane alert", visibleAt: hoursAgo(2), timelineAt: hoursAgo(2) });
  await insertComposedItem(database, { sourceId: "nejm", selected: true, title: "Not an alert", visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  const answer = await (await fetch(`${base}/api/frontier/items?view=all&safety=1&window=7d&limit=50`, { headers: sessions.reader })).json();
  assert.deepEqual(answer.data.items.map((item) => item.id), [inSafety.publicId, inRegulatory.publicId]);
  assert.ok(answer.data.items.every((item) => item.safetyAlert));
  assert.equal((await fetch(`${base}/api/frontier/items?safety=yes`, { headers: sessions.reader })).status, 400);
});

test("the hot list and an event page; a merged event's old id answers 308 to the survivor, which fetch follows", options, async () => {
  const { app, base, sessions, database } = context;
  const paper = await insertComposedItem(database, { sourceId: "nejm", title: "Hot trial", titleZh: "热门试验", registryIds: ["NCT55555555"],
    visibleAt: hoursAgo(5), timelineAt: hoursAgo(5) });
  const coverage = await insertComposedItem(database, { sourceId: "stat", sourceType: "media", title: "Hot trial coverage", registryIds: ["NCT55555555"], clusterKeys: [],
    visibleAt: hoursAgo(3), timelineAt: hoursAgo(3) });
  const events = app.frontier.composer.events;
  await events.clusterPending();
  await events.computeHot();
  const hot = (await (await fetch(`${base}/api/frontier/hot`, { headers: sessions.reader })).json()).data;
  const event = (await database.query("SELECT e.public_id, e.heat FROM evimed_frontier.items i JOIN evimed_frontier.events e ON e.id = i.event_id WHERE i.id = $1", [paper.id])).rows[0];
  assert.equal(hot.window, "current");
  assert.equal(Date.parse(hot.takenAt) - Date.parse(hot.since), 72 * 3_600_000, "the list covers the 72 hours before its own time");
  assert.equal(hot.events[0].id, event.public_id);
  assert.deepEqual({ ...hot.events[0], lastAt: undefined, firstAt: undefined }, { rank: 1, id: event.public_id, title: "热门试验", latest: "Hot trial coverage",
    sourceCount72h: 2, reportCount: 2, primary: "paper", hasPrimary: true, lastAt: undefined, firstAt: undefined, status: "developing",
    heat: Math.round(event.heat * 10), rankChange: null, badge: "new", trend: null, period: null });
  const week = (await (await fetch(`${base}/api/frontier/hot?window=week`, { headers: sessions.reader })).json()).data;
  assert.equal(week.window, "week");
  assert.deepEqual(week.events.map((row) => [row.id, row.period]), [[event.public_id, { institutions: 2, reports: 2, hoursOnList: 0, bestRank: 1 }]],
    "listed once, just now: on the list for less than half an hour, first");
  const refused = await fetch(`${base}/api/frontier/hot?window=year`, { headers: sessions.reader });
  assert.deepEqual([refused.status, (await refused.json()).code], [400, "frontier_query_invalid"]);

  const page = (await (await fetch(`${base}/api/frontier/events/${event.public_id}`, { headers: sessions.reader })).json()).data.event;
  assert.equal(page.id, event.public_id);
  assert.equal(page.title, "热门试验");
  assert.equal(page.digest, null, "no digest without a model: 「暂无综述」");
  assert.deepEqual(page.items.map((item) => [item.id, item.role]), [[paper.publicId, "primary"], [coverage.publicId, "report"]]);
  assert.equal(page.items[1].event.id, event.public_id, "a card of a two-report event names its event");
  assert.equal(page.sourceCount72h, 2);
  assert.deepEqual(page.institutions72h, { total: 2, byType: [{ type: "journal", count: 1, label: "期刊" }, { type: "media", count: 1, label: "媒体" }] });
  assert.deepEqual([page.hasPrimary, page.primary], [true, "paper"]);
  assert.ok(Number.isInteger(page.heat) && page.heat > 0);
  assert.equal(page.trend, null, "five hours of history: 「暂无走势」");

  // Fold this event into an older one by hand, as a bridge would.
  const older = (await database.query(`INSERT INTO evimed_frontier.events (public_id, title_zh, lane, first_at, last_at, report_count)
    VALUES ('0123456789abcdef', '更早的事件', 'evidence', $1, $1, 1) RETURNING id`, [hoursAgo(50)])).rows[0];
  await database.query("UPDATE evimed_frontier.events SET merged_into = $1 WHERE public_id = $2", [older.id, event.public_id]);
  await database.query("UPDATE evimed_frontier.event_items SET event_id = $1 WHERE event_id = (SELECT id FROM evimed_frontier.events WHERE public_id = $2)", [older.id, event.public_id]);
  const redirect = await fetch(`${base}/api/frontier/events/${event.public_id}`, { headers: sessions.reader, redirect: "manual" });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "0123456789abcdef", "relative: it resolves under whatever prefix serves the API");
  assert.deepEqual((await redirect.json()).data, { redirect: "0123456789abcdef" });
  const followed = await fetch(`${base}/api/frontier/events/${event.public_id}`, { headers: sessions.reader });
  assert.equal(followed.status, 200);
  assert.equal((await followed.json()).data.event.id, "0123456789abcdef");
  const missing = await fetch(`${base}/api/frontier/events/fedcba9876543210`, { headers: sessions.reader });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "frontier_event_not_found");
});

test("the daily over the wire: the archive and one issue, its items read now; a day without an issue is a 404", options, async () => {
  const { base, sessions, database } = context;
  const lead = await insertComposedItem(database, { sourceId: "nejm", selected: true, summaryZh: "导读", title: "Daily lead", titleZh: "日报头条", visibleAt: hoursAgo(30), timelineAt: hoursAgo(30) });
  const gone = await insertComposedItem(database, { sourceId: "nejm", selected: true, summaryZh: "导读", title: "Withdrawn since", visibleAt: hoursAgo(30), timelineAt: hoursAgo(30) });
  await database.query(`INSERT INTO evimed_frontier.dailies (day, window_start, window_end, lead, sections, safety, ai_minute, markdown, item_ids, model)
    VALUES ('2026-09-21', '2026-09-19T23:00:00Z', '2026-09-20T23:00:00Z', $1::jsonb, $2::jsonb, '[]'::jsonb, 'AI 一分钟。', '# 日报', $3::bigint[], 'deepseek-flash')`,
  [JSON.stringify({ itemId: lead.publicId, title: "日报头条", text: "头条导读", eventId: null, eventTitle: null }),
    JSON.stringify([{ lane: "evidence", itemIds: [gone.publicId] }]), [lead.id, gone.id]]);
  await database.query("UPDATE evimed_frontier.items SET state = 'withdrawn' WHERE id = $1", [gone.id]);
  const archive = (await (await fetch(`${base}/api/frontier/dailies?limit=5`, { headers: sessions.reader })).json()).data;
  assert.deepEqual(archive.dailies.map((entry) => [entry.day, entry.title, entry.itemCount]), [["2026-09-21", "日报头条", 2]]);
  const issue = (await (await fetch(`${base}/api/frontier/dailies/2026-09-21`, { headers: sessions.reader })).json()).data.daily;
  assert.equal(issue.lead.item.id, lead.publicId);
  assert.equal(issue.lead.text, "头条导读");
  assert.deepEqual(issue.sections, [], "a withdrawn item leaves the issue, and an emptied section with it");
  assert.equal(issue.aiMinute, "AI 一分钟。");
  // The copy is the issue as it reads now: the withdrawn item left it too, and
  // the count in its header is the count shown (the archive keeps the frozen 2).
  assert.match(issue.markdown, /^# EviMed 医学前沿日报 · 2026年9月21日\n\n覆盖 9月20日 07:00 至 9月21日 07:00（北京时间），共 1 条。/);
  assert.match(issue.markdown, /## 头条\n\n\*\*日报头条\*\*（NEJM Journal）\n\n头条导读/);
  assert.doesNotMatch(issue.markdown, /Withdrawn since/);
  assert.match(issue.markdown, /来源：EviMed 前沿动态\n$/);
  assert.deepEqual([issue.itemCount, issue.readingMinutes, issue.previousDay, issue.nextDay], [1, 1, null, null]);
  assert.equal(issue.windowStart, "2026-09-19T23:00:00.000Z");
  assert.equal((await fetch(`${base}/api/frontier/dailies/2026-09-20`, { headers: sessions.reader })).status, 404);
  assert.equal((await fetch(`${base}/api/frontier/dailies?limit=0`, { headers: sessions.reader })).status, 400);
});

test("存入知识库 through the upload's own path: the open-access PDF, or a record; registered as a source; CSRF required", options, async () => {
  const { app, base, sessions, database, pdfRequests } = context;
  const open = await insertComposedItem(database, { sourceId: "nejm", title: "Open access paper", openAccess: "gold", oaPdfUrl: "https://journals.example.org/oa.pdf",
    summaryZh: "导读", visibleAt: hoursAgo(2), timelineAt: hoursAgo(2), publishedAt: "2026-09-21T08:00:00Z" });
  // From a feed whose registry name is an interface's: the record names the institution.
  await insertSource(database, "openfda-drug-enforcement-api", { name: "openFDA 药品召回（enforcement）API", lane: "safety", source_type: "regulator",
    owner_entity: "U.S. Food and Drug Administration" });
  const closed = await insertComposedItem(database, { sourceId: "openfda-drug-enforcement-api", sourceType: "regulator", title: "Closed paper",
    summaryZh: "闭源论文导读", visibleAt: hoursAgo(2), timelineAt: hoursAgo(2), publishedAt: "2026-09-21T08:00:00Z" });
  const { "x-open-science-csrf": _csrf, ...withoutCsrf } = sessions.reader;
  const forged = await fetch(`${base}/api/frontier/items/${open.publicId}/save-to-library`, { method: "POST", headers: withoutCsrf, body: JSON.stringify({ projectId: "default" }) });
  assert.equal(forged.status, 403);

  const pdf = await fetch(`${base}/api/frontier/items/${open.publicId}/save-to-library`, { method: "POST", headers: sessions.reader, body: JSON.stringify({ projectId: "default" }) });
  assert.equal(pdf.status, 200);
  const saved = (await pdf.json()).data.saved;
  assert.equal(saved.kind, "pdf");
  assert.match(saved.path, /^knowledge-base\/frontier\/2026-09-21-open-access-paper-[a-z0-9]{6}\.pdf$/);
  assert.deepEqual(pdfRequests, ["https://journals.example.org/oa.pdf"]);
  const user = await app.store.userById(accounts.reader);
  const project = await app.store.requireProject(user, "default");
  assert.ok((await readFile(path.join(project.baseDir, saved.path))).equals(PDF), "the bytes are in the project's knowledge base");
  assert.equal(((await stat(path.join(project.baseDir, saved.path))).mode & 0o777), 0o600);

  const record = (await (await fetch(`${base}/api/frontier/items/${closed.publicId}/save-to-library`, { method: "POST", headers: sessions.reader,
    body: JSON.stringify({ projectId: "default" }) })).json()).data.saved;
  assert.equal(record.kind, "md");
  const kept = await readFile(path.join(project.baseDir, record.path), "utf8");
  assert.match(kept, /闭源论文导读/);
  assert.match(kept, /^来源：FDA（监管）$/m, "the institution, never 「openFDA 药品召回（enforcement）API」");
  const sources = (await database.query(`SELECT payload->'paths'->>0 AS path FROM evimed_product.documents WHERE user_id = $1 AND kind = 'source' AND deleted_at IS NULL`,
    [accounts.reader])).rows.map((row) => row.path).sort();
  assert.deepEqual(sources, [record.path, saved.path].sort(), "both saves became knowledge-base sources, as an upload does");

  const internal = await fetch(`${base}/api/frontier/items/${closed.publicId}/save-to-library`, { method: "POST", headers: sessions.reader,
    body: JSON.stringify({ projectId: "evimed-frontier" }) });
  assert.equal(internal.status, 404);
  const extra = await fetch(`${base}/api/frontier/items/${closed.publicId}/save-to-library`, { method: "POST", headers: sessions.reader,
    body: JSON.stringify({ projectId: "default", path: "../x" }) });
  assert.equal(extra.status, 400);
});

test("中文摘要 without a model answers the original with a sentence, and the upload route still registers what it writes", options, async () => {
  const { base, sessions, database } = context;
  const item = await insertComposedItem(database, { sourceId: "nejm", title: "Abstract paper", abstract: "The primary outcome occurred in 12.1% vs 15.4%.",
    visibleAt: hoursAgo(1), timelineAt: hoursAgo(1) });
  const answer = await fetch(`${base}/api/frontier/items/${item.publicId}/abstract-zh`, { method: "POST", headers: sessions.reader, body: "{}" });
  assert.equal(answer.status, 200);
  assert.deepEqual((await answer.json()).data, { abstractZh: null, abstract: "The primary outcome occurred in 12.1% vs 15.4%.", note: "中文摘要暂时不可用，下面是原文摘要。" });

  const upload = await fetch(`${base}/api/files/upload`, { method: "POST", headers: sessions.reader,
    body: JSON.stringify({ root: "base", path: "knowledge-base/notes/upload-check.md", data: "# 上传检查\n\n正文。", encoding: "utf8" }) });
  assert.equal(upload.status, 200);
  const body = (await upload.json()).data;
  assert.equal(body.path, "knowledge-base/notes/upload-check.md");
  assert.ok(body.source?.id, "an upload into the knowledge base is registered, as before the helper");
  const refused = await fetch(`${base}/api/files/upload`, { method: "POST", headers: sessions.reader,
    body: JSON.stringify({ root: "base", path: "knowledge-base/clip.mp4", data: "AAAA", encoding: "base64" }) });
  assert.equal(refused.status, 415, "the format admission still runs before a byte is written");
  void now;
});

test("the metrics carry the second wave's families: the daily's alert gauge, the actions, the events, personalization", options, async () => {
  const { base } = context;
  const text = await (await fetch(`${base}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
  for (const family of ["open_science_frontier_daily_missing", "open_science_frontier_daily_total{outcome=\"issued\"}",
    "open_science_frontier_push_total{outcome=\"pushed\"}", "open_science_frontier_events_total{kind=\"clustered\"}",
    "open_science_frontier_personalization_state{state=\"off\"} 1", "open_science_frontier_actions_total{kind=\"savedPdf\"} 1",
    "open_science_frontier_actions_total{kind=\"savedRecord\"} 1", "open_science_frontier_composer_loop_failures_total",
    "open_science_frontier_seen_marks_total{outcome=\"written\"}"]) {
    assert.ok(text.includes(family), `${family} is missing from the metrics`);
  }
});
