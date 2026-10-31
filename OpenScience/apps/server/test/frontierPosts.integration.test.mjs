// A crawl post that says nothing of its own is not shown, and one that has pictures is read through them (rd-server 2026-10-31), against a
// real PostgreSQL: the strings are real Xiaohongshu, Weibo, Douyin and channels posts as the feed stored them. A post with words is published
// and written up from its words with the platforms' markers gone; a title with its hashtags (or the title twice) is dropped before it is an
// item anyone sees, and one already shown is withdrawn once at start; a thin post with pictures waits for them, is read once, and a parser
// outage only delays it; a revision that brings words brings a withdrawn post back; the reader's page serves the cleaned words or none.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FRONTIER_ASK_INSTRUCTIONS } from "../src/frontierAsk.mjs";
import { FRONTIER_EDITOR_VERSION, buildModelInput, sha256 } from "../src/frontierEditor.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import { FRONTIER_META_KEYS, migrateFrontier } from "../src/frontierPersistence.mjs";
import { FRONTIER_LEAD_WINDOW_MS, FrontierPipeline, POST_WITHDRAWN } from "../src/frontierPipeline.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { TEST_VOCABULARY, insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const DAY = 86_400_000;
const NOW = new Date("2026-10-31T04:00:00Z");
const operator = `frontier_op_${randomUUID().slice(0, 8)}`;
const reader = { id: `reader_${randomUUID().slice(0, 8)}` };
const owner = { userId: operator, projectId: "evimed-frontier" };
/** @type {any} */
let database;
let seq = 0;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await migrateFrontier(database, { dimension: 1024 });
  await migrateUsageLedger(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Reader','development'),($2,'Operator','development')", [reader.id, operator]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'evimed-frontier','EviMed 前沿动态',1048576)", [operator]);
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
  await database.query("DELETE FROM evimed_frontier.meta WHERE key = $1", [FRONTIER_META_KEYS.postSweep]);
  await insertSource(database, "social-monitor", { name: "小红书（社媒监测）", lane: "mixed", source_type: "media", access: "rss", egress: "direct", authority: 1 });
  await insertSource(database, "nejm", { access: "crossref-issn" });
});

// Real posts, as the plugin's first layout stored them: `title content`, the markers of the platform in it.
const XHS_WORDS = { platform: "xiaohongshu", title: "男子用两种减肥药两个月减重40斤后突发脑梗",
  text: "男子用两种减肥药两个月减重40斤后突发脑梗 200斤男子使用“减肥神针”司美格鲁肽和达格列净两种药物 ，两个月减重40斤后突发脑梗，医生表示：两种药物不当联用或诱发卒中，须遵医嘱用药。#健康科普howto[话题]# #医疗健康howto[话题]# #减肥药[话题]#" };
const XHS_TAGS = { platform: "xiaohongshu", title: "目录外罕见病新药拟纳入市场独占期保护", text: "目录外罕见病新药拟纳入市场独占期保护 #罕见病[话题]# #新药[话题]#" };
const CHANNELS_TWICE = { platform: "channels", title: "科伦创新药获FDA优先审评", text: "科伦创新药获FDA优先审评 科伦创新药获FDA优先审评" };
const DOUYIN_TWICE = { platform: "douyin", title: "这2种降压药被查出致癌，快看看家里的药箱！ #降压药 #高血压",
  text: "这2种降压药被查出致癌，快看看家里的药箱！ #降压药 #高血压 这2种降压药被查出致癌，快看看家里的药箱！ #降压药 #高血压" };
const PICTURE_ID = "a".repeat(64);
const PICTURE_ID_2 = "b".repeat(64);
const POSTER_WORDS = "司美格鲁肽减重须遵医嘱：每周一次，起始剂量0.25毫克，不可自行加量";

/**
 * One delivered crawl entry, state `received`, with the platform's columns; the plugin answers its text from `texts`.
 * @param {typeof XHS_WORDS} post @param {Map<string, any>} texts @param {{ media?: any[], answer?: Record<string, any>, revision?: number, pluginEntryId?: string, firstSeen?: Date }} [more]
 */
async function deliver(post, texts, more = {}) {
  seq += 1;
  const pluginEntryId = more.pluginEntryId ?? `social-monitor:${createHash("sha256").update(`${post.title}:${seq}`).digest("hex").slice(0, 32)}`;
  const url = `https://www.example.org/post/${seq}`;
  const media = more.media ?? [];
  const result = await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, revision, source_id, identity_key, url, canonical_url,
      title_raw, summary_raw, first_seen_at, received_at, content_sha256, state, channel, platform, media, lang)
    VALUES ($1,$2,$3,'social-monitor',$4,$5,$5,$6,$7,$8,$8,$9,'received','social',$10,$11::jsonb,'zh') RETURNING id`,
  [pluginEntryId, 700_000 + seq, more.revision ?? 1, `url:${sha256(url)}`, url, post.title, post.text.slice(0, 299), more.firstSeen ?? new Date(NOW.getTime() - 3_600_000),
    sha256(`${seq}`), post.platform, JSON.stringify(media)]);
  texts.set(pluginEntryId, more.answer ?? { status: "available", body_excerpt: post.text.slice(0, 300), text_kind: "excerpt", enrichment: {} });
  return { entryId: String(result.rows[0].id), pluginEntryId };
}

/** @param {{ lead?: (input: string) => any }} [behaviour] */
function editorWith(behaviour = {}) {
  return {
    owner, available: true, timeZone: "Asia/Shanghai", model: "deepseek-flash",
    leadInputs: /** @type {string[]} */ ([]), editInputs: /** @type {any[]} */ ([]), tidyCalls: 0,
    async writeJson(/** @type {string} */ instructions, /** @type {string} */ input, /** @type {number} */ _max, /** @type {any} */ opts) {
      if (!instructions.includes("「AI 导读」")) return { verification: "passed", output: {}, error: null };
      this.leadInputs.push(input);
      const checked = opts.verify(behaviour.lead ? behaviour.lead(input) : { lead_zh: "" });
      return { verification: checked.issues.length ? "dropped" : "passed", output: checked.output, error: null };
    },
    async callJson(/** @type {any[]} */ messages) {
      if (messages[0].content === FRONTIER_ASK_INSTRUCTIONS) return { questions: [] };
      this.tidyCalls += 1;
      return { drop: [] };
    },
    async screen(/** @type {any[]} */ batch) {
      const verdicts = new Map(batch.map((input) => [input.key, { medical: true, news: true, lane: input.allowedLanes[0], specialties: [], language: "zh", digest: false }]));
      return { verdicts, errors: new Map(), calls: 1 };
    },
    async edit(/** @type {any} */ item) {
      this.editInputs.push(item);
      const modelInput = buildModelInput(item);
      return { verification: "passed", modelInput, modelInputSha256: sha256(modelInput), attempts: 1, issues: [], numbers: null, error: null, model: "deepseek-flash",
        editorVersion: FRONTIER_EDITOR_VERSION, fieldDiagnostics: { title_zh: ["passed"], summary_zh: ["passed"] },
        output: { genre: null, titleZh: `中文：${item.titleRaw.slice(0, 20)}`, summaryZh: "导读：有内容。", reasonZh: "值得一看。", lane: item.allowedLanes[0], specialties: [],
          evidenceType: item.evidenceFixed?.type ?? "observational", entities: { drugs: [], trials: [], orgs: [], diseases: [] },
          scores: { impact: 20, novelty: 10, relevance: 10 }, flags: [] } };
    },
    async translateBody() { return { paragraphs: [], complete: false, calls: 1, error: null }; },
  };
}

/**
 * A plugin that answers texts from a map, and the stored pictures as JPEG bytes through the same call the server wires (`fetchFrontierMedia`,
 * over a stubbed fetch with a token file of its own).
 */
function pluginFor(/** @type {Map<string, any>} */ texts) {
  return { text: async (/** @type {string} */ id) => texts.get(id) ?? { status: "unavailable" } };
}

/** The pictures the plugin stores, as the pipeline asks for them: `media(id)`; `down` makes the plugin unreachable. */
function mediaFor({ pictures = new Set([PICTURE_ID, PICTURE_ID_2]), down = false } = {}) {
  const fetched = /** @type {string[]} */ ([]);
  const media = async (/** @type {string} */ id) => {
    if (down) throw Object.assign(new Error("unreachable"), { code: "knowledge_plugin_unreachable" });
    fetched.push(id);
    if (!pictures.has(id)) throw Object.assign(new Error("gone"), { code: "frontier_media_not_found" });
    return { bytes: Buffer.from(`jpeg-bytes-of-${id.slice(0, 4)}`), contentType: "image/jpeg" };
  };
  return Object.assign(media, { fetched });
}

/** @param {(input: any) => Promise<{ text: string }>} read */
function parserWith(read) {
  const calls = /** @type {any[]} */ ([]);
  return { configured: true, calls, async parseBytes(/** @type {any} */ input) { calls.push(input); return read(input); } };
}

/** @param {any} editor @param {{ now?: Date, plugin: any, parser?: any, media?: any, config?: Record<string, any> }} input */
function pipelineFor(editor, { now = NOW, plugin, parser = null, media = mediaFor(), config = {} }) {
  return new FrontierPipeline({ database, editor, plugin, parser, media, embedder: null, now: () => now, workerId: `test-${randomUUID()}`, glossary: new FrontierGlossary([]),
    config: { kbEmbeddingDimension: 1024, frontierTimeZone: "Asia/Shanghai", frontierDailyBudgetCny: 300, frontierSelectThreshold: 80, ...config } });
}

const itemOfEntry = async (/** @type {string} */ entryId) => (await database.query(`SELECT i.* FROM evimed_frontier.items i JOIN evimed_frontier.entries e ON e.item_id = i.id WHERE e.id = $1`, [entryId])).rows[0];
const entryOf = async (/** @type {string} */ entryId) => (await database.query("SELECT * FROM evimed_frontier.entries WHERE id = $1", [entryId])).rows[0];
const textsOf = async (/** @type {string} */ id) => (await database.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id = $1", [id])).rows[0];
const serviceFor = () => new FrontierService({ database, vocabulary: frontierVocabularyView(TEST_VOCABULARY), now: () => NOW, config: { frontierEnabled: true, frontierAudience: "all",
  operatorUsers: [], frontierPreviewUsers: [], frontierDailyBudgetCny: 300, frontierTimeZone: "Asia/Shanghai", frontierSelectThreshold: 80 } });

test("a post with words is published and written up from its words; a title with its hashtags, or the title twice, is dropped and never an item anyone sees", options, async () => {
  const texts = new Map();
  const words = await deliver(XHS_WORDS, texts);
  const tags = await deliver(XHS_TAGS, texts);
  const twice = await deliver(CHANNELS_TWICE, texts);
  const douyin = await deliver(DOUYIN_TWICE, texts);
  const editor = editorWith({ lead: () => ({ lead_zh: "一名200斤男子联用两种减重药物，2个月减重40斤后突发脑梗，医生提醒须遵医嘱用药。" }) });
  const pipeline = pipelineFor(editor, { plugin: pluginFor(texts) });
  await pipeline.processBatch();

  const shown = await itemOfEntry(words.entryId);
  assert.equal(shown.state, "published");
  // The edit and the 导读 are written from the post's words: the title is not said twice and no marker of the platform is in what the model reads.
  assert.equal(editor.editInputs.length, 1, "only the post with words is edited");
  const edit = editor.editInputs[0];
  assert.equal(edit.summary, null, "the entry's `title content` summary is not sent beside the text");
  assert.match(edit.bodyExcerpt, /^200斤男子使用“减肥神针”司美格鲁肽/);
  assert.match(edit.bodyExcerpt, /\n\n#健康科普howto #医疗健康howto #减肥药$/);
  assert.doesNotMatch(edit.bodyExcerpt, /\[话题\]|男子用两种减肥药两个月减重40斤后突发脑梗/);
  assert.equal(editor.leadInputs.length, 1, "no 导读 call for a post with nothing of its own");
  assert.match(editor.leadInputs[0], /\n正文（帖子）：\n200斤男子使用/);
  assert.doesNotMatch(editor.leadInputs[0], /\[话题\]/);
  assert.equal((await database.query("SELECT lead_zh FROM evimed_frontier.items WHERE id = $1", [shown.id])).rows[0].lead_zh.slice(0, 6), "一名200斤");
  assert.equal(editor.tidyCalls, 0, "a post is settled without the model");

  // The three that say nothing of their own: the entry is dropped for it, the item stays unpublished and has no text row.
  for (const thin of [tags, twice, douyin]) {
    const entry = await entryOf(thin.entryId);
    assert.deepEqual([entry.state, entry.state_reason], ["dropped", "post-no-text"]);
    const item = await itemOfEntry(thin.entryId);
    assert.notEqual(item.state, "published");
    assert.equal(await textsOf(item.id), undefined);
  }
  assert.equal(pipeline.counters.postsNoText, 3);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_frontier.items WHERE state = 'published'")).rows[0].n, 1);

  // The reader's page: the words without the title copy, the markers and the trailing tags.
  const page = (await serviceFor().getItem(reader, shown.public_id)).body.item;
  assert.equal(page.body.original, "200斤男子使用“减肥神针”司美格鲁肽和达格列净两种药物 ，两个月减重40斤后突发脑梗，医生表示：两种药物不当联用或诱发卒中，须遵医嘱用药");
  assert.equal(page.body.zh, page.body.original);
  assert.equal(page.body.zhKind, "original-zh");
  assert.match(page.lead, /^一名200斤男子/);
});

test("a revision that brings words takes a dropped post through the ordinary path", options, async () => {
  const texts = new Map();
  const first = await deliver(XHS_TAGS, texts);
  const editor = editorWith({ lead: () => ({ lead_zh: "" }) });
  await pipelineFor(editor, { plugin: pluginFor(texts) }).processBatch();
  assert.equal((await entryOf(first.entryId)).state, "dropped");
  // The plugin reads the post whole: revision 2 of the same entry, now with its text.
  const whole = { ...XHS_TAGS, text: `${XHS_TAGS.title} 我国拟对目录外的罕见病新药设置市场独占期保护，保护期内不批准同类仿制药上市。#罕见病[话题]# #新药[话题]#` };
  await deliver(whole, texts, { pluginEntryId: first.pluginEntryId, revision: 2 });
  await pipelineFor(editor, { plugin: pluginFor(texts), now: new Date(NOW.getTime() + 3_600_000) }).processBatch();
  const item = await itemOfEntry(first.entryId);
  assert.equal(item.state, "published");
});

test("a thin post with pictures waits for them, is read once through the parser, and is shown with a 导读 from what the pictures say, never in its reader body", options, async () => {
  const texts = new Map();
  const post = await deliver(XHS_TAGS, texts, { media: [{ id: PICTURE_ID, kind: "image", original_url: "https://example.org/1.jpg" }, { id: PICTURE_ID_2, kind: "image", original_url: "https://example.org/2.jpg" }] });
  const plugin = pluginFor(texts);
  const media = mediaFor();
  const parser = parserWith(async () => ({ text: `${POSTER_WORDS}\n[笑哭R]` }));
  const editor = editorWith({ lead: (input) => (input.includes("图片中的文字") ? { lead_zh: "司美格鲁肽减重须遵医嘱，每周一次，起始剂量0.25毫克。" } : { lead_zh: "" }) });
  const pipeline = pipelineFor(editor, { plugin, parser, media });
  const summary = await pipeline.processBatch();

  assert.equal(summary.postPictures, 1);
  assert.deepEqual([...media.fetched], [PICTURE_ID, PICTURE_ID_2], "the pictures in order");
  assert.equal(parser.calls.length, 2);
  assert.match(parser.calls[0].filename, /^aaaaaaaaaaaaaaaa\.jpg$/);
  assert.equal(parser.calls[0].mediaType, "image/jpeg");
  const item = await itemOfEntry(post.entryId);
  assert.equal(item.state, "published", "pictures with words are something to show");
  const stored = await textsOf(item.id);
  assert.equal(stored.picture_text, `${POSTER_WORDS}\n${POSTER_WORDS}`, "the markers are gone and each picture's words follow in order");
  assert.ok(stored.picture_tried_at);
  assert.equal(pipeline.counters.postPicturesRead, 1);
  // The model reads the words of the pictures under their label; the 导读 and the card are written from them.
  assert.equal(editor.leadInputs.length, 1);
  assert.match(editor.leadInputs[0], /\n图片中的文字：\n司美格鲁肽减重须遵医嘱/);
  assert.equal(item.lead_zh, "司美格鲁肽减重须遵医嘱，每周一次，起始剂量0.25毫克。");
  assert.match(editor.editInputs[0].bodyExcerpt, /图片中的文字：/);
  // Tried once: the next round reads nothing again, and the page's body does not carry the pictures' words.
  await pipelineFor(editor, { plugin, parser, media, now: new Date(NOW.getTime() + 3_600_000) }).processBatch();
  assert.equal(parser.calls.length, 2);
  const page = (await serviceFor().getItem(reader, item.public_id)).body.item;
  assert.equal(page.body.original, null);
  assert.equal(page.body.zh, null);
  assert.equal(page.media.length, 2, "the pictures are shown even though the post has no body");
  assert.equal(page.lead, item.lead_zh);
});

test("a parser outage only delays a thin post; pictures with no words keep it out; a post with words is never read through its pictures", options, async () => {
  const texts = new Map();
  const media = [{ id: PICTURE_ID, kind: "image", original_url: "https://example.org/1.jpg" }];
  const thin = await deliver(XHS_TAGS, texts, { media });
  const withWords = await deliver(XHS_WORDS, texts, { media });
  const editor = editorWith({ lead: () => ({ lead_zh: "" }) });
  const plugin = pluginFor(texts);

  // The parser is unreachable: nothing is decided, the post is not tried, and the post with words is shown without waiting.
  const down = parserWith(async () => { throw Object.assign(new Error("down"), { code: "source_parser_unavailable" }); });
  const first = pipelineFor(editor, { plugin, parser: down });
  await first.processBatch();
  assert.equal(first.counters.postPicturesDeferred, 1);
  assert.equal(down.calls.length, 1, "the step stops for the round at the first outage");
  assert.equal((await textsOf((await itemOfEntry(thin.entryId)).id)).picture_tried_at, null, "an outage is not a try");
  assert.notEqual((await itemOfEntry(thin.entryId)).state, "published");
  assert.equal((await itemOfEntry(withWords.entryId)).state, "published");
  assert.equal((await textsOf((await itemOfEntry(withWords.entryId)).id)).picture_text, null, "a post with words has no use for its pictures");

  // The parser is back and the pictures hold no words: tried once, and the post stays out.
  const empty = parserWith(async () => ({ text: "  " }));
  const later = pipelineFor(editor, { plugin, parser: empty, now: new Date(NOW.getTime() + 3_600_000) });
  await later.processBatch();
  assert.equal(later.counters.postPicturesEmpty, 1);
  const item = await itemOfEntry(thin.entryId);
  assert.notEqual(item.state, "published");
  assert.ok((await textsOf(item.id)).picture_tried_at);
  assert.equal(item.state, "failed", "nothing is waited for any more: the item leaves the queue, as one with no text does");
  assert.deepEqual(item.editor_diagnostics, { giveUp: "no-text" });
  assert.equal((await entryOf(thin.entryId)).state_reason, "post-no-text");
  assert.equal(empty.calls.length, 1, "the post with words was never read through its pictures");
  assert.ok((await textsOf((await itemOfEntry(withWords.entryId)).id)).picture_tried_at, "it is marked as not needing them");
  const calls = empty.calls.length;
  await pipelineFor(editor, { plugin, parser: empty, now: new Date(NOW.getTime() + 2 * 3_600_000) }).processBatch();
  assert.equal(empty.calls.length, calls, "tried once");
});

test("the lever and a missing parser leave the pictures unread, and such a post is not shown", options, async () => {
  const texts = new Map();
  const media = [{ id: PICTURE_ID, kind: "image", original_url: "https://example.org/1.jpg" }];
  const thin = await deliver(XHS_TAGS, texts, { media });
  const parser = parserWith(async () => ({ text: POSTER_WORDS }));
  const editor = editorWith();
  await pipelineFor(editor, { plugin: pluginFor(texts), parser, config: { frontierPostPicturesEnabled: false } }).processBatch();
  await pipelineFor(editor, { plugin: pluginFor(texts), parser: null }).processBatch();
  assert.equal(parser.calls.length, 0);
  assert.notEqual((await itemOfEntry(thin.entryId)).state, "published");
});

/** A published crawl item as the store holds the posts of before today: the excerpt layout, the entry beside it. */
async function storedPost(post, { media = [], visibleAt = "2026-10-30T02:00:00Z", leadBasis = "basis-old", platform = post.platform } = {}) {
  const item = await insertItem(database, { sourceId: "social-monitor", title: post.title, titleZh: null, summaryZh: "卡片摘要。", visibleAt, timelineAt: visibleAt, sourceType: "media" });
  await database.query(`UPDATE evimed_frontier.items SET platform = $2, channel = 'social', media = $3::jsonb, lead_zh = '旧导读。', lead_basis = $4, editor_version = $5, genre = 'social',
      genre_basis = 'code' WHERE id = $1`, [item.id, platform, JSON.stringify(media), leadBasis, FRONTIER_EDITOR_VERSION]);
  await database.query("UPDATE evimed_frontier.item_texts SET abstract_raw = NULL, body_excerpt = $2 WHERE item_id = $1", [item.id, post.text]);
  seq += 1;
  await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, source_id, identity_key, url, canonical_url, title_raw, summary_raw, first_seen_at,
      content_sha256, state, item_id, platform, channel, media)
    VALUES ($1,$2,'social-monitor',$3,$4,$4,$5,$6,$7,$8,'promoted',$9,$10,'social',$11::jsonb)`,
  [`social-monitor:${seq}`, 710_000 + seq, `url:${sha256(item.publicId)}`, `https://www.example.org/p/${seq}`, post.title, post.text.slice(0, 299),
    new Date(NOW.getTime() - DAY), sha256(`s${seq}`), item.id, platform, JSON.stringify(media)]);
  return item;
}

test("once at start: the published posts with nothing of their own are withdrawn without a notice, the 导读 of posts and thin texts is written again, and the next start does nothing", options, async () => {
  const withWords = await storedPost(XHS_WORDS);
  const tagsOnly = await storedPost(XHS_TAGS);
  const twice = await storedPost(CHANNELS_TWICE);
  const waiting = await storedPost(DOUYIN_TWICE, { media: [{ id: PICTURE_ID, kind: "image", original_url: "https://example.org/1.jpg" }] });
  // A post of a platform that is not a crawl platform keeps its place however short it is; a thin summary text of any platform has its 导读 cleared.
  const xPost = await storedPost({ ...CHANNELS_TWICE, title: "Phase 3 data at ESMO" }, { platform: "x" });
  const thinSummary = await insertItem(database, { title: "A record", visibleAt: "2026-10-30T03:00:00Z" });
  await database.query("UPDATE evimed_frontier.items SET lead_zh = '消息仅提供标题。', lead_basis = 'basis-old' WHERE id = $1", [thinSummary.id]);
  await database.query("UPDATE evimed_frontier.item_texts SET reader_summary = 'Sponsor: X.', reader_tidy = $2::jsonb WHERE item_id = $1", [thinSummary.id, JSON.stringify({ source: "summary", sha: "s", drop: [] })]);
  const longAbstract = await insertItem(database, { title: "A paper", abstract: "Background ".repeat(60), visibleAt: "2026-10-30T03:00:00Z" });
  await database.query("UPDATE evimed_frontier.items SET lead_zh = '一篇论文。', lead_basis = 'basis-old' WHERE id = $1", [longAbstract.id]);
  await database.query("UPDATE evimed_frontier.item_texts SET reader_tidy = $2::jsonb WHERE item_id = $1", [longAbstract.id, JSON.stringify({ source: "abstract", sha: "a", drop: [] })]);
  const operatorPulled = await storedPost(CHANNELS_TWICE, {});
  await database.query("UPDATE evimed_frontier.items SET state = 'withdrawn', withdrawn_reason = 'duplicate of another' WHERE id = $1", [operatorPulled.id]);
  await database.query("UPDATE evimed_frontier.meta SET value = '0'::jsonb WHERE key = 'content_version'");

  // No model this round: the 导读 step must not write the cleared bases again before they are read.
  const editor = { ...editorWith(), available: false };
  const pipeline = pipelineFor(editor, { plugin: pluginFor(new Map()) });
  await pipeline.processBatch();
  const state = async (/** @type {{ id: string }} */ item) => (await database.query("SELECT state, withdrawn_reason, lead_zh, lead_basis FROM evimed_frontier.items WHERE id = $1", [item.id])).rows[0];
  assert.equal((await state(withWords)).state, "published");
  for (const gone of [tagsOnly, twice]) {
    assert.deepEqual([(await state(gone)).state, (await state(gone)).withdrawn_reason], ["withdrawn", POST_WITHDRAWN]);
    assert.deepEqual((await database.query("SELECT op, reason FROM evimed_frontier.item_changes WHERE item_id = $1 ORDER BY seq", [gone.id])).rows, [{ op: "remove", reason: "withdrawn" }]);
  }
  assert.equal((await state(waiting)).state, "published", "a post whose pictures are still to be read stays until they are");
  assert.equal((await state(xPost)).state, "published");
  assert.equal((await state(operatorPulled)).withdrawn_reason, "duplicate of another", "an operator's withdrawal is left as it was");
  assert.equal(pipeline.counters.postSweepWithdrawn, 2);
  assert.ok(Number((await database.query("SELECT value FROM evimed_frontier.meta WHERE key = 'content_version'")).rows[0].value) >= 1, "the readers' version moved");
  // The bases of the six platforms' posts and of the thin summary are cleared; the paper's long abstract is left alone.
  for (const item of [withWords, waiting, thinSummary]) assert.equal((await state(item)).lead_basis, null);
  assert.equal((await state(xPost)).lead_basis, "basis-old", "an X post is not a crawl platform's");
  assert.equal((await state(longAbstract)).lead_basis, "basis-old");
  assert.equal(pipeline.counters.postSweepLeadsReset >= 3, true);
  assert.equal(Number((await database.query("SELECT value FROM evimed_frontier.meta WHERE key = $1", [FRONTIER_META_KEYS.postSweep])).rows[0].value), 1);

  // The next start finds the marker and does nothing, whatever stands in the store now.
  await database.query("UPDATE evimed_frontier.items SET state = 'published', withdrawn_reason = NULL, withdrawn_at = NULL WHERE id = $1", [tagsOnly.id]);
  const again = pipelineFor(editor, { plugin: pluginFor(new Map()) });
  await again.processBatch();
  assert.equal(again.counters.postSweepWithdrawn, 0);
  assert.equal((await state(tagsOnly)).state, "published");
});

test("a post withdrawn for having no text comes back when a revision brings words; an operator's withdrawal does not", options, async () => {
  const texts = new Map();
  const bare = await storedPost(XHS_TAGS);
  const entry = (await database.query("SELECT * FROM evimed_frontier.entries WHERE item_id = $1", [bare.id])).rows[0];
  const editor = editorWith({ lead: () => ({ lead_zh: "我国拟对目录外罕见病新药设置市场独占期保护。" }) });
  await pipelineFor(editor, { plugin: pluginFor(texts) }).processBatch();
  assert.equal((await database.query("SELECT state FROM evimed_frontier.items WHERE id = $1", [bare.id])).rows[0].state, "withdrawn");

  const whole = `${XHS_TAGS.title} 我国拟对目录外的罕见病新药设置市场独占期保护，保护期内不批准同类仿制药上市。#罕见病[话题]# #新药[话题]#`;
  seq += 1;
  await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, revision, source_id, identity_key, url, canonical_url, title_raw, summary_raw, first_seen_at,
      content_sha256, state, platform, channel, media)
    VALUES ($1,$2,2,'social-monitor',$3,$4,$4,$5,$6,$7,$8,'received','xiaohongshu','social','[]'::jsonb)`,
  [entry.plugin_entry_id, 720_000 + seq, entry.identity_key, entry.url, entry.title_raw, whole.slice(0, 299), entry.first_seen_at, sha256(`rev${seq}`)]);
  texts.set(entry.plugin_entry_id, { status: "available", body_text: whole.replace(`${XHS_TAGS.title} `, ""), text_kind: "full", enrichment: {} });
  const later = pipelineFor(editor, { plugin: pluginFor(texts), now: new Date(NOW.getTime() + 3_600_000) });
  await later.processBatch();
  const back = (await database.query("SELECT state, withdrawn_reason, lead_zh FROM evimed_frontier.items WHERE id = $1", [bare.id])).rows[0];
  assert.equal(back.state, "published");
  assert.equal(back.withdrawn_reason, null);
  assert.equal(later.counters.postsReinstated, 1);
  assert.equal(back.lead_zh, "我国拟对目录外罕见病新药设置市场独占期保护。", "its 导读 is written from the words it has now");

  // An operator's withdrawal stays however the text changes.
  await database.query("UPDATE evimed_frontier.items SET state = 'withdrawn', withdrawn_reason = 'operator' WHERE id = $1", [bare.id]);
  seq += 1;
  await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, revision, source_id, identity_key, url, canonical_url, title_raw, summary_raw, first_seen_at,
      content_sha256, state, platform, channel, media)
    VALUES ($1,$2,3,'social-monitor',$3,$4,$4,$5,$6,$7,$8,'received','xiaohongshu','social','[]'::jsonb)`,
  [entry.plugin_entry_id, 730_000 + seq, entry.identity_key, entry.url, entry.title_raw, whole.slice(0, 299), entry.first_seen_at, sha256(`rev${seq}`)]);
  await pipelineFor(editor, { plugin: pluginFor(texts), now: new Date(NOW.getTime() + 2 * 3_600_000) }).processBatch();
  assert.equal((await database.query("SELECT state FROM evimed_frontier.items WHERE id = $1", [bare.id])).rows[0].state, "withdrawn");
});

test("a lead the writer answers empty for a stored post becomes none; a post with nothing to read is not sent to the writer at all", options, async () => {
  const empty = await storedPost(XHS_WORDS);
  const editor = editorWith({ lead: () => ({ lead_zh: "" }) });
  const pipeline = pipelineFor(editor, { plugin: pluginFor(new Map()) });
  await pipeline.processBatch();
  const row = (await database.query("SELECT lead_zh, lead_basis FROM evimed_frontier.items WHERE id = $1", [empty.id])).rows[0];
  assert.equal(row.lead_zh, null, "the page then shows no paragraph of its own");
  assert.equal(row.lead_basis, (await textsOf(empty.id)).reader_tidy.sha, "asked once for this text");
  assert.equal(editor.leadInputs.length, 1);

  // A published post whose text is only its title and tags and whose pictures are not read yet: no call, recorded as none.
  const thin = await storedPost(XHS_TAGS, { media: [{ id: PICTURE_ID, kind: "image", original_url: "https://example.org/1.jpg" }] });
  await database.query("UPDATE evimed_frontier.meta SET value = '1'::jsonb WHERE key = $1", [FRONTIER_META_KEYS.postSweep]);
  const quiet = editorWith();
  await pipelineFor(quiet, { plugin: pluginFor(new Map()) }).processBatch();
  assert.equal(quiet.leadInputs.length, 0);
  assert.equal((await database.query("SELECT lead_zh FROM evimed_frontier.items WHERE id = $1", [thin.id])).rows[0].lead_zh, null);
});

test("the window the sweep and the lead step share is the lead window", () => {
  assert.equal(FRONTIER_LEAD_WINDOW_MS, 30 * DAY);
});
