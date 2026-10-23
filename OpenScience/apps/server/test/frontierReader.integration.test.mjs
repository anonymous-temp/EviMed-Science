// The reader's content (contract B, 2026-10-22) against a real PostgreSQL: the detail's 导读, 推荐理由, full text and its
// Chinese, pictures, quoted post, counts, topics, tags, same-event pointer and follow-ups; the list's channel filter and card
// fields; the media proxy; and the pipeline's translation stage — with a fake editor and a fake plugin, everything else real.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_EDITOR_VERSION } from "../src/frontierEditor.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { FrontierPipeline } from "../src/frontierPipeline.mjs";
import { FrontierTagStore } from "../src/frontierTags.mjs";
import { createFrontierRoutes } from "../src/frontierRoutes.mjs";
import { FRONTIER_CHANNEL_FILTERS, FrontierService, frontierItemChannel, frontierVocabularyView } from "../src/frontierService.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { TEST_VOCABULARY, insertItem, insertSource } from "./helpers/frontierFixtures.mjs";
import { frontierTextless } from "../../../scripts/ops/frontier-textless.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const reader = { id: `reader_${randomUUID().slice(0, 8)}` };
const operator = `frontier_op_${randomUUID().slice(0, 8)}`;
const owner = { userId: operator, projectId: "evimed-frontier" };
const vocabulary = frontierVocabularyView(TEST_VOCABULARY);
const NOW = new Date("2026-10-22T04:00:00Z");
const IMAGE = createHash("sha256").update("png-bytes").digest("hex");
const PNG = Buffer.from("png-bytes");

/** @type {any} */
let database;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
  await migrateUsageLedger(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Reader','development'),($2,'Operator','development')", [reader.id, operator]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'evimed-frontier','EviMed 前沿动态',1048576)", [operator]);
  // fr-events' verdict column, as cc/briefs/fr-contract.md names it: the reader reads it whether or not it exists.
  await database.query("ALTER TABLE evimed_frontier.items ADD COLUMN IF NOT EXISTS same_event_item_id bigint");
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_control.users WHERE id = ANY($1::text[])", [[reader.id, operator]]);
  await database.close();
});

beforeEach(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_frontier.events");
  await database.query("DELETE FROM evimed_frontier.items");
  await database.query("DELETE FROM evimed_frontier.entries");
  await database.query("DELETE FROM evimed_frontier.sources");
  await database.query("UPDATE evimed_frontier.meta SET value='0'::jsonb WHERE key IN ('content_version')");
  await database.query("DELETE FROM evimed_usage.model_requests WHERE user_id=$1", [operator]);
  await insertSource(database, "nejm");
  await insertSource(database, "fda", { name: "FDA News", lane: "regulatory", source_type: "regulator" });
  await insertSource(database, "stat", { name: "STAT", lane: "mixed", source_type: "media" });
  await insertSource(database, "xfeed", { name: "X 医学账号", lane: "mixed", source_type: "media" });
  await insertSource(database, "ctgov", { name: "ClinicalTrials.gov", lane: "pipeline", source_type: "evidence-body" });
});

/** @param {Record<string, any>} [overrides] */
function serviceFor(overrides = {}) {
  const config = { frontierEnabled: true, frontierAudience: "all", operatorUsers: [], frontierPreviewUsers: [], frontierDailyBudgetCny: 300,
    frontierTimeZone: "Asia/Shanghai", frontierSelectThreshold: 80 };
  return new FrontierService({ database, vocabulary, now: () => NOW, config, ...overrides });
}

/** @param {string} id @param {Record<string, any>} columns item columns @param {Record<string, any>} [texts] item_texts columns */
async function set(id, columns, texts = {}) {
  for (const [table, values, key] of [["items", columns, "id"], ["item_texts", texts, "item_id"]]) {
    const names = Object.keys(values);
    if (!names.length) continue;
    await database.query(`UPDATE evimed_frontier.${table} SET ${names.map((name, index) => `${name} = $${index + 2}`).join(", ")} WHERE ${key} = $1`,
      [id, ...names.map((name) => (values[name] !== null && typeof values[name] === "object" && !Array.isArray(values[name]) ? JSON.stringify(values[name])
        : Array.isArray(values[name]) && values[name].some((entry) => typeof entry === "object") ? JSON.stringify(values[name]) : values[name]))]);
  }
}

test("the detail is contract B: 导读, gated 推荐理由, AI 评分, full text and its Chinese, pictures, quoted post, counts, the tree's tags", options, async () => {
  const paper = await insertItem(database, { title: "Semaglutide in obesity", titleZh: "司美格鲁肽用于肥胖", summaryZh: "导读第一句。导读第二句。",
    reasonZh: "肥胖但无糖尿病的心血管高危患者，可据此评估加用司美格鲁肽的获益与胃肠道耐受。", selected: true, selectedRule: "threshold",
    specialties: ["cardiology"], entities: { drugs: ["司美格鲁肽"], trials: ["SELECT"], orgs: [], diseases: ["肥胖"] }, evidenceType: "rct" });
  await set(paper.id, { score_total: 86, tags: ["GLP-1 受体激动剂", "心血管预防"] },
    { abstract_raw: "Background one.\n\nResults: 20% fewer events.", body_zh: "背景一。\n\n结果：事件减少 20%。", body_zh_kind: "translation",
      body_zh_source: "abstract", body_complete: true });
  // The tags a reader sees are the tree's (frontierTags.mjs): a name the seed knows is shown, one it does not is a hidden candidate.
  const tags = new FrontierTagStore({ database });
  await database.transaction((client) => tags.link(client, paper.id, ["GLP-1 受体激动剂", "心血管预防", "肥胖"], { origin: "edit", specialties: ["cardiology"] }));
  const service = serviceFor();
  const { item } = (await service.getItem(reader, paper.publicId)).body;
  assert.equal(item.lead, "导读第一句。导读第二句。");
  assert.equal(item.summary, item.lead, "the 导读 is the summary, under its reader name");
  assert.match(item.reason, /^肥胖但无糖尿病/);
  assert.equal(item.score, 86);
  assert.deepEqual(item.body, { zh: "背景一。\n\n结果：事件减少 20%。", original: "Background one.\n\nResults: 20% fewer events.", zhKind: "translation", complete: true,
    source: "abstract" });
  assert.deepEqual(item.tags.map((tag) => tag.name), ["GLP-1 受体激动剂", "肥胖"], "the candidate 心血管预防 is not shown");
  assert.ok(item.tags.every((tag) => /^[a-z0-9][a-z0-9-]+$/.test(tag.slug)));
  assert.equal(item.topics, undefined, "「主题」 is gone: 专科 and 标签 are the two layers");
  assert.equal(item.channel, "journal", "an item before contract 1.4.0 has its source type's channel");
  assert.deepEqual([item.platform, item.author, item.media, item.quoted, item.metrics, item.sameEvent, item.followups, item.thumb],
    [null, null, [], null, null, null, null, null], "what was never stored is null or empty, never made up");

  // An item well under the line keeps its reason in the table, and the reader does not show it.
  const low = await insertItem(database, { title: "A small study", reasonZh: "可参考这项研究的设计用于类似人群的回顾性分析。", selected: false });
  await set(low.id, { score_total: 55 });
  assert.equal((await service.getItem(reader, low.publicId)).body.item.reason, null);
  await set(low.id, { score_total: 70 });
  assert.match((await serviceFor().getItem(reader, low.publicId)).body.item.reason, /^可参考/, "within ten of the line it shows");

  // A post: its author, pictures, the post it quotes with its translation, its counts; a Chinese text is its own Chinese.
  const post = await insertItem(database, { sourceId: "xfeed", sourceType: "media", title: "FDA approves a new drug", evidenceType: "regulatory-decision" });
  await set(post.id, { channel: "x", platform: "x", author: { name: "U.S. FDA", handle: "US_FDA", url: "https://x.com/US_FDA", role: "organisation" },
    media: [{ id: IMAGE, kind: "image", width: 1200, height: 675, alt: "Label", original_url: "https://pbs.twimg.com/a.png" }, { id: "not-a-hash", kind: "image" }],
    quoted: { author: { name: "NEJM", handle: "NEJM" }, text: "Trial results in 3 lines.", url: "https://x.com/NEJM/status/1" },
    metrics: { likes: 12, reposts: 3, replies: null, views: 900, observed_at: "2026-10-22T03:00:00Z" } },
  { body_text: "FDA approves drug X.\nLine two.", body_zh: "FDA 批准药物 X。\n第二行。", body_zh_kind: "translation", body_zh_source: "body",
    body_complete: true, quoted_zh: "试验结果，共 3 行。" });
  const detail = (await service.getItem(reader, post.publicId)).body.item;
  assert.deepEqual(detail.author, { name: "U.S. FDA", handle: "US_FDA", url: "https://x.com/US_FDA", role: "organisation" });
  assert.deepEqual(detail.media, [{ id: IMAGE, url: `/api/frontier/media/${IMAGE}`, width: 1200, height: 675, alt: "Label" }]);
  assert.deepEqual(detail.thumb, detail.media[0]);
  assert.deepEqual(detail.quoted, { author: { name: "NEJM", handle: "NEJM" }, text: "Trial results in 3 lines.", translation: "试验结果，共 3 行。", url: "https://x.com/NEJM/status/1" });
  assert.deepEqual(detail.metrics, { likes: 12, reposts: 3, replies: null, views: 900 });
  assert.deepEqual(detail.body, { zh: "FDA 批准药物 X。\n第二行。", original: "FDA approves drug X.\nLine two.", zhKind: "translation", complete: true, source: "body" });
  assert.deepEqual([detail.channel, detail.platform], ["x", "x"]);
  assert.deepEqual(detail.tags, [], "nothing tagged, nothing made up from the item's lane or flags");

  const chinese = await insertItem(database, { sourceId: "stat", sourceType: "media", title: "国家药监局批准一款新药" });
  await set(chinese.id, {}, { body_excerpt: "国家药监局今日批准一款新药上市。\n\n适应证为成人 2 型糖尿病。" });
  assert.deepEqual((await service.getItem(reader, chinese.publicId)).body.item.body,
    { zh: "国家药监局今日批准一款新药上市。\n\n适应证为成人 2 型糖尿病。", original: "国家药监局今日批准一款新药上市。\n\n适应证为成人 2 型糖尿病。", zhKind: "original-zh", complete: true, source: "excerpt" });
  // No text at all: no body to show.
  const bare = await insertItem(database, { title: "Title only" });
  assert.deepEqual((await service.getItem(reader, bare.publicId)).body.item.body, { zh: null, original: null, zhKind: null, complete: false, source: null });
  // A translation refused by its checks is no Chinese: the original stands alone.
  const refused = await insertItem(database, { title: "Refused" });
  await set(refused.id, {}, { abstract_raw: "Results were mixed.", body_zh: null, body_zh_kind: "translation", body_zh_source: "abstract", body_complete: false });
  assert.deepEqual((await service.getItem(reader, refused.publicId)).body.item.body, { zh: null, original: "Results were mixed.", zhKind: null, complete: false, source: "abstract" });
});

test("sameEvent names the selected item fr-events' verdict points at; follow-ups are the event's other published reports, one per institution, newest first", options, async () => {
  const selected = await insertItem(database, { title: "NEJM paper", titleZh: "NEJM 论文", selected: true, timelineAt: "2026-10-21T01:00:00Z" });
  const second = await insertItem(database, { sourceId: "stat", sourceType: "media", title: "STAT story", timelineAt: "2026-10-21T05:00:00Z" });
  const olderStat = await insertItem(database, { sourceId: "stat", sourceType: "media", title: "STAT earlier", timelineAt: "2026-10-21T02:00:00Z" });
  const newerStat = await insertItem(database, { sourceId: "stat", sourceType: "media", title: "STAT later", timelineAt: "2026-10-21T08:00:00Z" });
  const fda = await insertItem(database, { sourceId: "fda", sourceType: "regulator", lane: "regulatory", title: "FDA notice", timelineAt: "2026-10-21T06:00:00Z" });
  const ctgov = await insertItem(database, { sourceId: "ctgov", sourceType: "evidence-body", title: "Trial update", timelineAt: "2026-10-21T07:00:00Z" });
  const withdrawn = await insertItem(database, { title: "Withdrawn report", state: "withdrawn", timelineAt: "2026-10-21T09:59:00Z" });
  await set(second.id, { same_event_item_id: selected.id });
  const event = (await database.query(`INSERT INTO evimed_frontier.events (public_id, title_zh, lane, first_at, last_at)
    VALUES ('evtreader0001', '一件事', 'evidence', $1, $1) RETURNING id`, [NOW])).rows[0].id;
  for (const member of [selected, second, olderStat, newerStat, fda, ctgov, withdrawn]) {
    await database.query("INSERT INTO evimed_frontier.event_items (event_id, item_id, role, joined_by) VALUES ($1, $2, 'report', 'vector')", [event, member.id]);
    await database.query("UPDATE evimed_frontier.items SET event_id = $2 WHERE id = $1", [member.id, event]);
  }
  const service = serviceFor();
  const detail = (await service.getItem(reader, second.publicId)).body.item;
  assert.deepEqual(detail.sameEvent, { itemId: selected.publicId, title: "NEJM 论文" });
  assert.equal(detail.followups.eventId, "evtreader0001");
  // fr-events' frontierItemFollowups: one row per institution (its newest report), the item itself and unpublished reports never.
  assert.deepEqual(detail.followups.rows.map((row) => row.itemId), [newerStat.publicId, ctgov.publicId, fda.publicId, selected.publicId]);
  assert.equal(detail.followups.more, false);
  assert.ok(detail.followups.rows.every((row) => row.relation === "same-event"));
  assert.equal(detail.followups.rows[0].sourceName, "STAT");
  // The selected item itself points at nothing; a verdict naming an unpublished item is no pointer.
  assert.equal((await service.getItem(reader, selected.publicId)).body.item.sameEvent, null);
  await set(second.id, { same_event_item_id: withdrawn.id });
  assert.equal((await serviceFor().getItem(reader, second.publicId)).body.item.sameEvent, null);
});

test("the list's channel filter: 文献, 新闻, 社交, 官方 — a contract 1.4.0 channel or, before it, the source type's", options, async () => {
  const journal = await insertItem(database, { title: "Journal paper", timelineAt: "2026-10-22T01:00:00Z" });
  const regulator = await insertItem(database, { sourceId: "fda", sourceType: "regulator", lane: "regulatory", title: "FDA notice", timelineAt: "2026-10-22T01:10:00Z" });
  const news = await insertItem(database, { sourceId: "stat", sourceType: "media", title: "News story", timelineAt: "2026-10-22T01:20:00Z" });
  const registry = await insertItem(database, { sourceId: "ctgov", sourceType: "evidence-body", lane: "pipeline", title: "Trial registered", timelineAt: "2026-10-22T01:30:00Z" });
  await database.query("UPDATE evimed_frontier.items SET identity_key = 'reg:NCT07000001:registered:2026-10-21' WHERE id = $1", [registry.id]);
  const orgPost = await insertItem(database, { sourceId: "xfeed", sourceType: "media", title: "An agency's post", timelineAt: "2026-10-22T01:40:00Z" });
  await set(orgPost.id, { channel: "x", platform: "x", author: { name: "WHO", role: "organisation" }, media: [{ id: IMAGE, kind: "image" }] });
  const personPost = await insertItem(database, { sourceId: "xfeed", sourceType: "media", title: "A doctor's post", timelineAt: "2026-10-22T01:50:00Z" });
  await set(personPost.id, { channel: "wechat", platform: "wechat", author: { name: "某医生", role: "person" } });
  const service = serviceFor();
  const titles = async (/** @type {string} */ channel) => (await service.listItems(reader, new URLSearchParams({ view: "all", channel }))).body.items.map((item) => item.titleRaw);
  assert.deepEqual(await titles("literature"), ["Trial registered", "Journal paper"]);
  assert.deepEqual(await titles("news"), ["News story"]);
  assert.deepEqual(await titles("social"), ["A doctor's post", "An agency's post"]);
  assert.deepEqual(await titles("official"), ["An agency's post", "FDA notice"]);
  assert.equal((await titles("all")).length, 6);
  await assert.rejects(service.listItems(reader, new URLSearchParams({ channel: "rumours" })), { code: "frontier_query_invalid" });
  // The card fields: channel, platform, author, the first picture — and the filter is part of the cursor's fingerprint.
  const page = await service.listItems(reader, new URLSearchParams({ view: "all", channel: "social", limit: "1" }));
  assert.deepEqual([page.body.items[0].channel, page.body.items[0].platform, page.body.items[0].author], ["wechat", "wechat", { name: "某医生", handle: null, url: null, role: "person" }]);
  await assert.rejects(service.listItems(reader, new URLSearchParams({ view: "all", channel: "news", limit: "1", cursor: page.body.nextCursor })), { code: "invalid_cursor" });
  const agency = (await service.listItems(reader, new URLSearchParams({ view: "all", channel: "official" }))).body.items[0];
  assert.deepEqual(agency.thumb, { id: IMAGE, url: `/api/frontier/media/${IMAGE}`, width: null, height: null, alt: null });
  void journal; void regulator; void news;
  // The JS and SQL readings of a channel agree for every source type.
  for (const sourceType of ["journal", "preprint", "regulator", "evidence-body", "company", "media"]) {
    const sql = (await database.query(`SELECT (SELECT ${(await import("../src/frontierService.mjs")).frontierChannelSql}) AS channel
      FROM (SELECT NULL::text AS channel, $1::text AS source_type, 'doi:x'::text AS identity_key) i`, [sourceType])).rows[0].channel;
    assert.equal(sql, frontierItemChannel({ source_type: sourceType, identity_key: "doi:x" }), sourceType);
  }
  assert.ok(Object.values(FRONTIER_CHANNEL_FILTERS).flat().length >= 9);
});

/** A plugin that serves one stored image. */
function mediaPlugin(/** @type {Record<string, any>} */ answer = {}) {
  /** @type {string[]} */
  const asked = [];
  return {
    asked,
    plugin: {
      baseUrl: "http://plugin.test", tokenFile: "/tmp/fr-edit-t/plugin-token", timeoutMs: 2_000,
      fetch: async (/** @type {URL} */ url, /** @type {any} */ init) => {
        asked.push(`${url.pathname} ${init.headers.authorization ? "bearer" : "none"}`);
        if (answer.status === 404) return new Response("{}", { status: 404 });
        return new Response(answer.body ?? PNG, { status: 200, headers: { "content-type": answer.type ?? "image/png" } });
      },
    },
  };
}

test("the media proxy serves a published item's picture, cached by its hash, and nothing else", options, async () => {
  await mkdir("/tmp/fr-edit-t", { recursive: true, mode: 0o700 });
  await writeFile("/tmp/fr-edit-t/plugin-token", "test-token-only\n", { mode: 0o600 });
  const item = await insertItem(database, { title: "With a picture" });
  await set(item.id, { media: [{ id: IMAGE, kind: "image" }] });
  const { asked, plugin } = mediaPlugin();
  const service = serviceFor({ ingest: { plugin } });
  const answer = await service.media(reader, IMAGE);
  assert.equal(answer.status, 200);
  assert.deepEqual([answer.contentType, answer.etag, String(/** @type {any} */ (answer).bytes)], ["image/png", `"${IMAGE}"`, "png-bytes"]);
  assert.deepEqual(asked, [`/v1/media/${IMAGE} bearer`]);
  assert.equal((await service.media(reader, IMAGE, `"${IMAGE}"`)).status, 304, "the browser's copy is the same bytes");
  assert.equal(asked.length, 1, "a 304 asks the plugin nothing");
  await assert.rejects(service.media(reader, "a".repeat(64)), { code: "frontier_media_not_found" }, "an id no published item names");
  await assert.rejects(service.media(reader, "../etc/passwd"), { code: "frontier_media_not_found" });
  await database.query("UPDATE evimed_frontier.items SET state = 'withdrawn' WHERE id = $1", [item.id]);
  await assert.rejects(service.media(reader, IMAGE), { code: "frontier_media_not_found" }, "a withdrawn item's picture is gone with it");
  await database.query("UPDATE evimed_frontier.items SET state = 'published' WHERE id = $1", [item.id]);
  await assert.rejects(serviceFor({ ingest: { plugin: mediaPlugin({ status: 404 }).plugin } }).media(reader, IMAGE), { code: "frontier_media_not_found" }, "evicted");
  await assert.rejects(serviceFor({ ingest: { plugin: mediaPlugin({ type: "text/html", body: "<script>" }).plugin } }).media(reader, IMAGE), { code: "frontier_media_invalid" });
  await assert.rejects(serviceFor({ ingest: null }).media(reader, IMAGE), { code: "knowledge_plugin_unconfigured" });

  // Through the route: the image's own headers, never JSON, never a shared cache.
  const store = { async ensureSessionUser() { return { user: reader }; }, async assertCsrf() {} };
  const routes = createFrontierRoutes({ store, service, config: { frontierEnabled: true, frontierAudience: "all" }, maxJsonBytes: 1024 });
  const res = { status: 0, headers: /** @type {Record<string, any>} */ ({}), body: Buffer.alloc(0),
    writeHead(/** @type {number} */ status, /** @type {any} */ headers) { this.status = status; this.headers = headers; }, end(/** @type {any} */ chunk) { this.body = chunk ?? Buffer.alloc(0); } };
  const req = Object.assign(Readable.from([]), { method: "GET", url: `/api/frontier/media/${IMAGE}`, headers: {} });
  assert.equal(await routes(req, res), true);
  assert.equal(res.status, 200);
  assert.deepEqual([res.headers["Content-Type"], res.headers["Cache-Control"], res.headers.ETag, res.headers["X-Content-Type-Options"], res.headers["Content-Length"]],
    ["image/png", "private, max-age=86400", `"${IMAGE}"`, "nosniff", 9]);
  assert.equal(String(res.body), "png-bytes");
});

/**
 * An editor that translates by rule: every paragraph to 「译：<paragraph>」 with its numbers kept, unless told otherwise.
 * @param {{ fail?: string | null, bad?: boolean }} [behaviour]
 */
function translatingEditor(behaviour = {}) {
  /** @type {any[]} */
  const asked = [];
  /** @type {any[]} */
  const tidied = [];
  return {
    owner, available: true, asked, tidied, timeZone: "Asia/Shanghai", model: "deepseek-flash",
    // The 导读 and the 解读 (frontierLead.mjs, frontierInsight.mjs): `behaviour.lead(input)` / `behaviour.insight(input)` answer, checked
    // by the caller's own verify as the editor's #write does; nothing given, the answer is empty.
    leads: /** @type {string[]} */ ([]), insights: /** @type {string[]} */ ([]),
    async writeJson(/** @type {string} */ instructions, /** @type {string} */ input, /** @type {number} */ _maxTokens, /** @type {any} */ options) {
      const kind = instructions.includes("「AI 导读」") ? "lead" : instructions.includes("「AI 解读」") ? "insight" : "other";
      if (kind === "lead") this.leads.push(input);
      if (kind === "insight") this.insights.push(input);
      if (behaviour.writeFail) return { verification: "pending", output: null, error: behaviour.writeFail };
      const answer = kind === "lead" ? (behaviour.lead ? behaviour.lead(input) : { lead_zh: "" })
        : kind === "insight" ? (behaviour.insight ? behaviour.insight(input) : { insight_zh: "" }) : {};
      const checked = options.verify(answer);
      return { verification: checked.issues.length ? "dropped" : "passed", output: checked.output, error: null };
    },
    // The reader-text verdict (frontierReaderTidy.mjs): `behaviour.drop(input)` names the paragraphs to take out.
    async callJson(/** @type {any[]} */ messages) {
      const input = JSON.parse(messages[1].content);
      tidied.push(input);
      if (behaviour.tidyFail) throw Object.assign(new Error(behaviour.tidyFail), { code: behaviour.tidyFail });
      return behaviour.drop ? behaviour.drop(input) : { drop: [] };
    },
    async screen() { return { verdicts: new Map(), errors: new Map(), calls: 0 }; },
    async edit() { throw new Error("not in this test"); },
    async translateBody(/** @type {any} */ input) {
      asked.push(input);
      if (behaviour.fail) return { paragraphs: input.paragraphs.map(() => null), complete: false, calls: 1, error: behaviour.fail };
      if (behaviour.bad) return { paragraphs: input.paragraphs.map((paragraph, index) => (index === 0 ? null : `译：${paragraph}`)), complete: false, calls: 2, error: null };
      return { paragraphs: input.paragraphs.map((paragraph) => `译：${paragraph}`), complete: true, calls: 1, error: null };
    },
  };
}

/** @param {any} editor @param {any} [webReader] */
function pipelineFor(editor, webReader = null) {
  return new FrontierPipeline({ database, editor, plugin: { text: async () => ({ status: "pending" }) }, embedder: null, now: () => NOW, webReader,
    workerId: `test-${randomUUID()}`, glossary: new FrontierGlossary([{ kind: "drug", termEn: "semaglutide", termZh: "司美格鲁肽", keepOriginal: false }]),
    config: { kbEmbeddingDimension: 1024, frontierTimeZone: "Asia/Shanghai", frontierDailyBudgetCny: 300, frontierSelectThreshold: 80 } });
}

/** @param {string} id */
const texts = async (id) => (await database.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id = $1", [id])).rows[0];

test("the translation stage: selected and near-line items, on the edit; Chinese is its own; a better text is translated again", options, async () => {
  const selected = await insertItem(database, { title: "Semaglutide trial", selected: true, visibleAt: "2026-10-21T00:00:00Z" });
  const near = await insertItem(database, { title: "Near the line", visibleAt: "2026-10-21T00:00:00Z" });
  const low = await insertItem(database, { title: "Far below", visibleAt: "2026-10-21T00:00:00Z" });
  const old = await insertItem(database, { title: "A month old", selected: true, visibleAt: "2026-09-01T00:00:00Z" });
  const chinese = await insertItem(database, { sourceId: "stat", title: "中文新闻", selected: true, visibleAt: "2026-10-21T00:00:00Z" });
  const unedited = await insertItem(database, { title: "Owed an edit", selected: true, visibleAt: "2026-10-21T00:00:00Z" });
  for (const [row, score] of [[selected, 90], [near, 72], [low, 50], [old, 90], [chinese, 85], [unedited, 90]]) {
    await set(row.id, { score_total: score, editor_version: row === unedited ? null : FRONTIER_EDITOR_VERSION },
      { abstract_raw: `${row === chinese ? "国家药监局批准了一款新药。" : "Semaglutide cut events by 20%."}\n\nSecond paragraph.` });
  }
  const before = Number((await database.query("SELECT value FROM evimed_frontier.meta WHERE key='content_version'")).rows[0].value);
  const editor = translatingEditor();
  const pipeline = pipelineFor(editor);
  const summary = await pipeline.processBatch();
  assert.equal(summary.translated, 3);
  assert.deepEqual(editor.asked.map((input) => input.paragraphs), [["Semaglutide cut events by 20%.", "Second paragraph."], ["Semaglutide cut events by 20%.", "Second paragraph."]],
    "the selected and the near-line item; never the far one, the month-old one, the unedited one or the Chinese one");
  assert.ok(editor.asked[0].glossary.some((entry) => entry.termEn === "semaglutide"), "the glossary entries the text names");
  const translated = await texts(selected.id);
  assert.deepEqual([translated.body_zh, translated.body_zh_kind, translated.body_zh_source, translated.body_complete],
    ["译：Semaglutide cut events by 20%.\n\n译：Second paragraph.", "translation", "abstract", true]);
  const own = await texts(chinese.id);
  assert.deepEqual([own.body_zh, own.body_zh_kind, own.body_complete], [null, "original-zh", true]);
  for (const row of [low, old, unedited]) assert.equal((await texts(row.id)).body_zh_at, null);
  assert.ok(Number((await database.query("SELECT value FROM evimed_frontier.meta WHERE key='content_version'")).rows[0].value) > before, "the reader's tag moves");
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.items WHERE lease_owner IS NOT NULL")).rows[0].n, 0, "every lease released");

  // Nothing more to do: the same round translates nothing again.
  assert.equal((await pipeline.processBatch()).translated, 0);
  // (The unedited item's owed edit fails in this test's editor; on its third failure it is left title-only — edited — and would
  // be translated like any other: out of the way.)
  await database.query("DELETE FROM evimed_frontier.items WHERE id = $1", [unedited.id]);
  // The full text arrives after the abstract was translated (ingest settles it again): it is the better text, and it is translated.
  await set(selected.id, {}, { body_text: "Full text paragraph one, long enough to be worth a look by the editor.\n\nFull text paragraph two, with "
    + "its own sentence about the trial, the population and the outcome the investigators measured.\n\nAnd a third one to read.", reader_tidy: null });
  assert.equal((await pipeline.processBatch()).translated, 1);
  const full = await texts(selected.id);
  assert.equal(full.body_zh_source, "body");
  assert.equal(full.body_zh.split("\n\n").length, 3);
  assert.equal(full.reader_tidy.source, "body", "the full text was settled before it was translated");
});

test("the reader's text is settled before it is shown or translated: furniture out by the model, an abstract by section in code", options, async () => {
  const page = await insertItem(database, { sourceId: "stat", title: "Workers pay 9% more for family coverage", selected: true, visibleAt: "2026-10-21T00:00:00Z" });
  const structured = await insertItem(database, { title: "CKM staging and hearing", selected: true, visibleAt: "2026-10-21T00:00:00Z" });
  const greedy = await insertItem(database, { sourceId: "stat", title: "A page the model would empty", selected: true, visibleAt: "2026-10-21T00:00:00Z" });
  const body = ["By Tara Bannow", "Tara covers the business of health care. You can reach Tara on Signal.",
    "The amount that workers pay in premiums for a family plan jumped 9% in 2026, to $7,471 on average, KFF's survey found.",
    "Advertisement", "Workers at small businesses faced even larger increases than those at large firms, the survey said."].join("\n\n");
  await set(page.id, { score_total: 90, editor_version: FRONTIER_EDITOR_VERSION }, { body_text: body });
  await set(structured.id, { score_total: 90, editor_version: FRONTIER_EDITOR_VERSION },
    { abstract_raw: "Background: Hearing loss is common. Methods: We analyzed NHANES 2017-2020. Results: CKM stage tracked thresholds. Conclusions: Screen hearing." });
  await set(greedy.id, { score_total: 90, editor_version: FRONTIER_EDITOR_VERSION }, { body_text: body });
  const editor = translatingEditor({ drop: (/** @type {any} */ input) => (input.title === "A page the model would empty" ? { drop: [1, 2, 3, 5] } : { drop: [1, 2, 4] }) });
  const pipeline = pipelineFor(editor);
  const summary = await pipeline.processBatch();
  assert.equal(summary.tidied, 3);
  assert.equal(summary.tidyDropped, 3, "three paragraphs out of the page, none out of the others");
  assert.deepEqual(editor.tidied.map((input) => input.title).sort(), ["A page the model would empty", "Workers pay 9% more for family coverage"],
    "the two page texts were judged by the model; the abstract was laid out in code without a call");
  assert.equal(editor.tidied[0].p.length, 5);
  const settled = await texts(page.id);
  assert.deepEqual([settled.reader_tidy.source, settled.reader_tidy.drop, settled.reader_tidy.model], ["body", [0, 1, 3], "deepseek-flash"]);
  assert.equal(settled.reader_tidy.sha, createHash("sha256").update(body).digest("hex"), "the verdict names the text it was made for");
  assert.deepEqual((await texts(greedy.id)).reader_tidy.refused, "too_much", "an answer that would empty the text is refused by code");
  assert.deepEqual((await texts(greedy.id)).reader_tidy.drop, []);
  // The translation was made of what the reader is shown.
  const asked = editor.asked.map((input) => input.paragraphs);
  assert.ok(asked.some((paragraphs) => paragraphs.length === 2 && paragraphs[0].startsWith("The amount that workers pay")), "the page without its furniture");
  assert.ok(asked.some((paragraphs) => paragraphs.length === 4 && paragraphs[1] === "Methods: We analyzed NHANES 2017-2020."), "the abstract by section");
  const { item } = (await serviceFor().getItem(reader, page.publicId)).body;
  assert.equal(item.body.original.split("\n\n").length, 2);
  assert.ok(!item.body.original.includes("Tara covers") && !item.body.original.includes("Advertisement"));
  assert.equal((await serviceFor().getItem(reader, structured.publicId)).body.item.body.original.split("\n\n")[2], "Results: CKM stage tracked thresholds.");
  assert.equal(pipeline.status().counters.tidyRefused, 1);

  // A text that changes (the plugin read it again) is settled again, and the translation made from the old text is cleared
  // by ingest; here, as ingest leaves it: the verdict gone, the old translation in place but made of five paragraphs.
  await set(page.id, {}, { reader_tidy: null, body_zh: "译1\n\n译2\n\n译3\n\n译4\n\n译5", body_zh_kind: "translation", body_zh_source: "body", body_complete: true });
  const again = await pipelineFor(translatingEditor({ drop: () => ({ drop: [1, 2, 4] }) })).processBatch();
  assert.equal(again.tidied, 1);
  const redone = await texts(page.id);
  assert.equal(redone.body_zh.split("\n\n").length, 2, "the stale translation was cleared and made again of the settled text");
});

test("the 导读 is one paragraph written from the settled reader text, served as the reader's lead, and written again when the text changes", options, async () => {
  const paper = await insertItem(database, { title: "Semaglutide in obesity", summaryZh: "卡片摘要。", selected: true, visibleAt: "2026-10-21T00:00:00Z" });
  const quiet = await insertItem(database, { title: "A quiet note", summaryZh: "另一条卡片摘要。", visibleAt: "2026-10-21T00:00:00Z" });
  const abstract = "Background: Obesity raises cardiovascular risk. Methods: 17,604 adults were randomised. Results: Events fell by 20% (HR 0.80). Conclusions: Semaglutide reduced events.";
  await set(paper.id, { score_total: 90, editor_version: FRONTIER_EDITOR_VERSION }, { abstract_raw: abstract });
  await set(quiet.id, { score_total: 40, editor_version: FRONTIER_EDITOR_VERSION }, { abstract_raw: "A note with nothing to say." });
  const lead = "司美格鲁肽在 17,604 名肥胖成人中使心血管事件减少 20%（HR 0.80）。";
  const editor = translatingEditor({ lead: (/** @type {string} */ input) => ({ lead_zh: input.includes("Semaglutide in obesity") ? lead : "" }) });
  const summary = await pipelineFor(editor).processBatch();
  assert.equal(summary.leads, 1, "one written; the quiet note's source supported none");
  assert.match(editor.leads.find((input) => input.includes("Semaglutide in obesity")) ?? "", /正文（摘要）：\nBackground: Obesity raises cardiovascular risk\.\n\nMethods: 17,604/,
    "written from the settled text: the abstract by section");
  const row = (await database.query("SELECT i.lead_zh, i.lead_basis, t.reader_tidy FROM evimed_frontier.items i JOIN evimed_frontier.item_texts t ON t.item_id = i.id WHERE i.id = $1", [paper.id])).rows[0];
  assert.deepEqual([row.lead_zh, row.lead_basis], [lead, row.reader_tidy.sha]);
  assert.equal((await serviceFor().getItem(reader, paper.publicId)).body.item.lead, lead);
  assert.equal((await serviceFor().getItem(reader, quiet.publicId)).body.item.lead, "另一条卡片摘要。", "no 导读: the card's summary");
  assert.equal((await database.query("SELECT lead_basis FROM evimed_frontier.items WHERE id = $1", [quiet.id])).rows[0].lead_basis !== null, true, "not asked again for that text");
  // Nothing changed: nothing is asked again. The text changes (ingest settles it again): written again.
  const again = translatingEditor({ lead: () => ({ lead_zh: lead }) });
  await pipelineFor(again).processBatch();
  assert.equal(again.leads.length, 0);
  await set(paper.id, {}, { abstract_raw: `${abstract} Funding: Novo Nordisk.`, reader_tidy: null });
  await pipelineFor(again).processBatch();
  assert.equal(again.leads.length, 1);
});

test("the 「AI 解读」 of a 精选 item cites the related reports it was shown; without material it is not asked", options, async () => {
  const earlier = await insertItem(database, { title: "B-Well trials report functional cure", titleZh: "B-Well 试验报告功能性治愈", summaryZh: "两项 III 期试验功能性治愈率 19%。",
    visibleAt: "2026-09-01T00:00:00Z", timelineAt: "2026-09-01T00:00:00Z" });
  const approval = await insertItem(database, { title: "FDA approves bepirovirsen", summaryZh: "FDA 批准。", selected: true, visibleAt: "2026-10-21T00:00:00Z",
    timelineAt: "2026-10-21T00:00:00Z" });
  const alone = await insertItem(database, { title: "A short selected note", summaryZh: "短讯。", selected: true, visibleAt: "2026-10-21T00:00:00Z" });
  // Related by a drug and a disease both (a shared drug alone is not enough).
  await set(earlier.id, { entity_keys: ["drug:bepirovirsen", "disease:chb", "trial:b-well 1"] }, {});
  await set(approval.id, { score_total: 90, editor_version: FRONTIER_EDITOR_VERSION, entity_keys: ["drug:bepirovirsen", "disease:chb"] },
    { abstract_raw: "The FDA approved bepirovirsen with nucleos(t)ide analogues for chronic hepatitis B; functional cure was 19% in the trials." });
  await set(alone.id, { score_total: 90, editor_version: FRONTIER_EDITOR_VERSION }, { abstract_raw: "A short note." });
  const insight = "这次获批所依据的正是此前报道的 B-Well 两项 III 期试验，功能性治愈率同为 19% [1]。两者口径一致，国内仍在审评，上市时间尚无消息，长期停药后的持久性还要更长随访来回答。";
  const editor = translatingEditor({ lead: () => ({ lead_zh: "FDA 批准 bepirovirsen 联合核苷（酸）类似物治疗慢性乙肝，试验中功能性治愈率 19%。" }), insight: () => ({ insight_zh: insight }) });
  const pipeline = pipelineFor(editor);
  await pipeline.processBatch();
  assert.equal(pipeline.status().lastError, null);
  assert.equal(editor.insights.length, 1, "asked once: the approval has a related report; the short note alone has no material");
  assert.match(editor.insights[0], /\[1\] 同一药物或试验｜2026-09-01｜.*｜B-Well 试验报告功能性治愈\n {4}导读：两项 III 期试验功能性治愈率 19%。/);
  const { item } = (await serviceFor().getItem(reader, approval.publicId)).body;
  assert.deepEqual(item.insight, { text: insight, refs: [{ n: 1, publicId: earlier.publicId, title: "B-Well 试验报告功能性治愈", source: item.insight.refs[0].source,
    at: "2026-09-01T00:00:00.000Z" }] });
  assert.equal((await serviceFor().getItem(reader, alone.publicId)).body.item.insight, null);
  const looked = (await database.query("SELECT insight_basis, insight_at FROM evimed_frontier.items WHERE id = $1", [alone.id])).rows[0];
  assert.ok(looked.insight_basis && looked.insight_at, "recorded as none for this basis, without a call");
  // The cited report is withdrawn: the reader keeps the text and drops the ref (its mark reads as plain text).
  await database.query("UPDATE evimed_frontier.items SET state = 'withdrawn' WHERE id = $1", [earlier.id]);
  assert.deepEqual((await serviceFor().getItem(reader, approval.publicId)).body.item.insight.refs, []);
});

test("an open-access PDF the plugin could not read becomes the item's full text, once, and the reader text is settled again", options, async () => {
  const paper = await insertItem(database, { title: "An open paper", selected: true, visibleAt: "2026-10-21T00:00:00Z" });
  const closed = await insertItem(database, { title: "A closed paper", selected: true, visibleAt: "2026-10-21T00:00:00Z" });
  await set(paper.id, { score_total: 90, editor_version: FRONTIER_EDITOR_VERSION },
    { abstract_raw: "An abstract.", enrichment: { oa_pdf_url: "https://journals.example.org/open.pdf" } });
  await set(closed.id, { score_total: 90, editor_version: FRONTIER_EDITOR_VERSION }, { abstract_raw: "Another abstract." });
  /** @type {string[]} */
  const read = [];
  const webReader = { async read(/** @type {string} */ url) {
    read.push(url);
    return { text: ["# An open paper", "", "## Methods", "", "We enrolled 1,220 adults. ".repeat(100), "", "## References", "", "1. Ref."].join("\n"),
      receipt: { contentType: "document" } };
  } };
  await pipelineFor(translatingEditor(), webReader).processBatch();
  assert.deepEqual(read, ["https://journals.example.org/open.pdf"], "only the item with an open-access PDF, once");
  const texts = (await database.query("SELECT body_text, body_text_origin, body_text_complete, oa_pdf_tried_at FROM evimed_frontier.item_texts WHERE item_id = $1", [paper.id])).rows[0];
  assert.equal(texts.body_text_origin, "oa-pdf");
  assert.equal(texts.body_text_complete, true, "the whole paper up to its references");
  assert.match(texts.body_text, /^## An open paper\n\n## Methods\n\nWe enrolled 1,220 adults\./);
  assert.ok(!texts.body_text.includes("1. Ref."));
  assert.equal((await serviceFor().getItem(reader, paper.publicId)).body.item.body.source, "body");
  await pipelineFor(translatingEditor(), webReader).processBatch();
  assert.equal(read.length, 1, "tried once");
});

test("a paper over 40,000 characters is stored whole, on a database migrated before the columns were widened (production, 2026-10-22)", options, async () => {
  // The shape production had: the full-text column as contract 1.5.0 first declared it.
  await database.query(`ALTER TABLE evimed_frontier.item_texts DROP CONSTRAINT item_texts_body_text_check,
    ADD CONSTRAINT item_texts_body_text_check CHECK (char_length(body_text) <= 40000)`);
  const again = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
  try { await migrateFrontier(again, { dimension: 1024 }); } finally { await again.close(); }
  const checks = (await database.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = 'evimed_frontier.item_texts'::regclass AND conname IN ('item_texts_body_text_check', 'item_texts_body_zh_check') ORDER BY conname`)).rows;
  assert.deepEqual(checks.map((row) => row.def), ["CHECK ((char_length(body_text) <= 100000))", "CHECK ((char_length(body_zh) <= 150000))"]);
  const paper = await insertItem(database, { title: "A long open paper", selected: true, visibleAt: "2026-10-21T00:00:00Z" });
  await set(paper.id, { score_total: 90, editor_version: FRONTIER_EDITOR_VERSION },
    { abstract_raw: "An abstract.", enrichment: { oa_pdf_url: "https://journals.example.org/long.pdf" } });
  const results = Array.from({ length: 60 }, (_, index) => `Paragraph ${index} reports the cohort's outcomes at length. ${"Patients improved steadily over follow-up. ".repeat(24)}`);
  const webReader = { async read() { return { text: ["# A long open paper", "", ...results.flatMap((paragraph) => [paragraph, ""]), "References", "", "1. Ref."].join("\n"),
    receipt: { contentType: "document" } }; } };
  await pipelineFor(translatingEditor(), webReader).processBatch();
  const texts = (await database.query("SELECT length(body_text) AS chars, body_text_complete, oa_pdf_tried_at FROM evimed_frontier.item_texts WHERE item_id = $1", [paper.id])).rows[0];
  assert.ok(texts.chars > 40_000, `stored ${texts.chars} characters`);
  assert.equal(texts.body_text_complete, true);
  assert.ok(texts.oa_pdf_tried_at);
});

test("an item with nothing a reader could use is not published, and is published when its text arrives", options, async () => {
  const waiting = await insertItem(database, { title: "A paper with no text yet", state: "scored", visibleAt: "2026-10-21T00:00:00Z" });
  await set(waiting.id, { score_total: 70, editor_version: FRONTIER_EDITOR_VERSION }, {});
  await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, source_id, identity_key, url, canonical_url, title_raw,
      first_seen_at, content_sha256, state, item_id, defects)
    VALUES ('j-x:1', 1, 'nejm', 'url:x', 'https://x.example.org/1', 'https://x.example.org/1', 'A paper with no text yet', '2026-10-20T00:00:00Z', $2, 'promoted', $1, '{no-summary}')`,
  [waiting.id, createHash("sha256").update("waiting").digest("hex")]);
  await pipelineFor(translatingEditor()).processBatch();
  assert.equal((await database.query("SELECT state FROM evimed_frontier.items WHERE id = $1", [waiting.id])).rows[0].state, "scored", "not shown");
  await set(waiting.id, { lease_until: null }, { abstract_raw: "Background: it arrived." });
  await pipelineFor(translatingEditor()).processBatch();
  assert.equal((await database.query("SELECT state FROM evimed_frontier.items WHERE id = $1", [waiting.id])).rows[0].state, "published");
});

test("the one-off take-back: published items with nothing to read are unpublished (reported first), records and safety alerts stay", options, async () => {
  await insertSource(database, "ctgov-api", { name: "ClinicalTrials.gov", lane: "pipeline", source_type: "evidence-body", access: "json-api" });
  const empty = await insertItem(database, { title: "A paper with nothing to read", visibleAt: "2026-10-21T00:00:00Z" });
  const withAbstract = await insertItem(database, { title: "A paper with its abstract", abstract: "Background: x.", visibleAt: "2026-10-21T00:00:00Z" });
  const record = await insertItem(database, { sourceId: "ctgov-api", title: "A trial registration", visibleAt: "2026-10-21T00:00:00Z" });
  const alert = await insertItem(database, { sourceId: "fda", title: "A recall", safetyAlert: true, visibleAt: "2026-10-21T00:00:00Z" });
  const before = Number((await database.query("SELECT value FROM evimed_frontier.meta WHERE key='content_version'")).rows[0].value);
  const report = await frontierTextless({ database });
  assert.deepEqual([report.applied, report.count, report.ids], [false, 1, [empty.publicId]]);
  assert.equal((await database.query("SELECT state FROM evimed_frontier.items WHERE id = $1", [empty.id])).rows[0].state, "published", "the report writes nothing");
  const applied = await frontierTextless({ database, apply: true });
  assert.deepEqual([applied.applied, applied.count, applied.bySourceType], [true, 1, { journal: 1 }]);
  const states = (await database.query("SELECT id, state FROM evimed_frontier.items WHERE id = ANY($1::bigint[])", [[empty.id, withAbstract.id, record.id, alert.id]])).rows;
  assert.deepEqual(Object.fromEntries(states.map((row) => [String(row.id), row.state])),
    { [empty.id]: "scored", [withAbstract.id]: "published", [record.id]: "published", [alert.id]: "published" });
  assert.deepEqual((await database.query("SELECT op, reason FROM evimed_frontier.item_changes WHERE item_id = $1", [empty.id])).rows, [{ op: "remove", reason: "textless" }]);
  assert.ok(Number((await database.query("SELECT value FROM evimed_frontier.meta WHERE key='content_version'")).rows[0].value) > before);
  await assert.rejects(serviceFor().getItem(reader, empty.publicId), /No such item/);
  assert.equal((await frontierTextless({ database })).count, 0, "idempotent");
});

test("a provider outage while judging records nothing and pauses; the translation waits for the verdict", options, async () => {
  const page = await insertItem(database, { sourceId: "stat", title: "A page", selected: true, visibleAt: "2026-10-21T00:00:00Z" });
  await set(page.id, { score_total: 90, editor_version: FRONTIER_EDITOR_VERSION },
    { body_text: "Paragraph one of a page, long enough to be judged by the editor this morning, with a sentence about a trial and "
      + "its result.\n\nParagraph two of the page, also long enough to count: the second sentence says who ran the trial and when." });
  const down = translatingEditor({ tidyFail: "model_gateway_upstream_unavailable" });
  const pipeline = pipelineFor(down);
  const summary = await pipeline.processBatch();
  assert.deepEqual([summary.tidied, summary.translated], [0, 0]);
  assert.equal((await texts(page.id)).reader_tidy, null, "not recorded: it is judged again");
  assert.equal(down.asked.length, 0, "nothing is translated before its text is settled");
  assert.ok(pipeline.status().providerPausedUntil);
});

test("a provider outage records nothing and waits; a refused paragraph keeps its original in place and the translation is not complete", options, async () => {
  const item = await insertItem(database, { title: "Selected", selected: true, visibleAt: "2026-10-21T00:00:00Z" });
  await set(item.id, { score_total: 90, editor_version: FRONTIER_EDITOR_VERSION }, { abstract_raw: "First 12%.\n\nSecond 3%." });
  const down = pipelineFor(translatingEditor({ fail: "model_gateway_upstream_unavailable" }));
  assert.equal((await down.processBatch()).translated, 0);
  assert.equal((await texts(item.id)).body_zh_at, null, "not recorded: it is tried again");
  assert.ok(down.status().providerPausedUntil, "and the provider pause holds the next calls");

  const partial = pipelineFor(translatingEditor({ bad: true }));
  assert.equal((await partial.processBatch()).translated, 1);
  const row = await texts(item.id);
  assert.deepEqual([row.body_zh, row.body_complete], ["First 12%.\n\n译：Second 3%.", false]);
  assert.equal(partial.status().counters.translateIncomplete, 1);
  // Recorded for that text: not asked again until a better one arrives.
  assert.equal((await partial.processBatch()).translated, 0);
});

test("the backfill script: last week's 精选 and near-line items owe one edit with the shipped prompts; a journal item without its abstract leaves 精选", options, async () => {
  const { frontierReaderBackfill, parseArguments } = await import("../../../scripts/ops/frontier-reader-backfill.mjs");
  assert.deepEqual(parseArguments(["--apply", "--days", "3"]), { apply: true, days: 3 });
  assert.throws(() => parseArguments(["--days", "9"]), /1 to 7/);
  const old = await insertItem(database, { title: "Old prompt, selected", selected: true, selectedRule: "threshold", visibleAt: "2026-10-21T00:00:00Z" });
  const near = await insertItem(database, { title: "Old prompt, near the line", visibleAt: "2026-10-21T00:00:00Z" });
  const low = await insertItem(database, { title: "Old prompt, far below", visibleAt: "2026-10-21T00:00:00Z" });
  const shipped = await insertItem(database, { title: "Shipped prompt", selected: true, visibleAt: "2026-10-21T00:00:00Z" });
  const stale = await insertItem(database, { title: "A month ago", selected: true, visibleAt: "2026-09-01T00:00:00Z" });
  const bare = await insertItem(database, { title: "Journal, no abstract", selected: true, selectedRule: "threshold", flags: ["no-abstract"], visibleAt: "2026-10-21T00:00:00Z" });
  const pinned = await insertItem(database, { title: "Pinned, no abstract", selected: true, selectedRule: "operator-pin", flags: ["no-abstract"], visibleAt: "2026-10-21T00:00:00Z" });
  for (const [row, version, score] of [[old, "frontier-editor-1.old", 90], [near, "frontier-editor-1.old", 72], [low, "frontier-editor-1.old", 50],
    [shipped, FRONTIER_EDITOR_VERSION, 90], [stale, "frontier-editor-1.old", 90], [bare, FRONTIER_EDITOR_VERSION, 85], [pinned, FRONTIER_EDITOR_VERSION, 85]]) {
    await set(row.id, { editor_version: version, score_total: score });
  }
  const report = await frontierReaderBackfill({ database, threshold: 80, now: NOW });
  assert.deepEqual([report.applied, report.reedit.ids.sort(), report.unselect.ids], [false, [old.publicId, near.publicId].sort(), [bare.publicId]]);
  assert.equal((await database.query("SELECT editor_version FROM evimed_frontier.items WHERE id = $1", [old.id])).rows[0].editor_version, "frontier-editor-1.old", "a report changes nothing");
  const applied = await frontierReaderBackfill({ database, threshold: 80, apply: true, now: NOW });
  assert.equal(applied.reedit.count, 2);
  const row = async (/** @type {string} */ id) => (await database.query("SELECT editor_version, selected, selected_rule FROM evimed_frontier.items WHERE id = $1", [id])).rows[0];
  assert.equal((await row(old.id)).editor_version, null, "owed one edit");
  assert.equal((await row(low.id)).editor_version, "frontier-editor-1.old");
  assert.deepEqual([(await row(bare.id)).selected, (await row(pinned.id)).selected], [false, true], "an operator's pin stays");
  assert.deepEqual((await frontierReaderBackfill({ database, threshold: 80, apply: true, now: NOW })).reedit.count, 0, "a second run finds nothing");
});

test("fr-events' verdict holds in the later selections: the lane floor passes over an item standing beside its event's selected report", options, async () => {
  const report = await insertItem(database, { title: "The selected report", selected: true, selectedRule: "threshold", timelineAt: "2026-10-21T02:00:00Z" });
  const beside = await insertItem(database, { sourceId: "stat", sourceType: "media", title: "A second report of it", timelineAt: "2026-10-22T02:00:00Z" });
  const other = await insertItem(database, { sourceId: "stat", sourceType: "media", title: "Another story", timelineAt: "2026-10-22T02:30:00Z" });
  const trigger = await insertItem(database, { title: "Published this round", state: "scored", timelineAt: "2026-10-22T03:00:00Z" });
  await set(report.id, { score_total: 90, editor_version: FRONTIER_EDITOR_VERSION });
  await set(beside.id, { score_total: 78, editor_version: FRONTIER_EDITOR_VERSION, same_event_item_id: report.id });
  await set(other.id, { score_total: 65, editor_version: FRONTIER_EDITOR_VERSION });
  // (A text to read: an item with none is not published, 2026-10-22.)
  await set(trigger.id, { score_total: 20, editor_version: FRONTIER_EDITOR_VERSION }, { abstract_raw: "An abstract of the trigger." });
  const pipeline = pipelineFor(translatingEditor());
  const summary = await pipeline.processBatch();
  assert.equal(summary.published, 1);
  const selected = async (/** @type {string} */ id) => (await database.query("SELECT selected, selected_rule FROM evimed_frontier.items WHERE id = $1", [id])).rows[0];
  assert.deepEqual(await selected(beside.id), { selected: false, selected_rule: null }, "it adds nothing to the report that stands for the event");
  assert.deepEqual(await selected(other.id), { selected: true, selected_rule: "lane-floor" }, "the lane's next best is taken instead");
});
