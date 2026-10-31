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
import { FRONTIER_POST_LIMITS } from "../src/frontierPostText.mjs";
import { FRONTIER_EDITOR_VERSION, buildModelInput, sha256 } from "../src/frontierEditor.mjs";
import { FrontierGlossary } from "../src/frontierGlossary.mjs";
import { FRONTIER_META_KEYS, bumpFrontierVersion, migrateFrontier } from "../src/frontierPersistence.mjs";
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
    leadInputs: /** @type {string[]} */ ([]), editInputs: /** @type {any[]} */ ([]), askInputs: /** @type {string[]} */ ([]), tidyCalls: 0,
    async writeJson(/** @type {string} */ instructions, /** @type {string} */ input, /** @type {number} */ _max, /** @type {any} */ opts) {
      if (!instructions.includes("「AI 导读」")) return { verification: "passed", output: {}, error: null };
      this.leadInputs.push(input);
      const checked = opts.verify(behaviour.lead ? behaviour.lead(input) : { lead_zh: "" });
      return { verification: checked.issues.length ? "dropped" : "passed", output: checked.output, error: null };
    },
    async callJson(/** @type {any[]} */ messages) {
      if (messages[0].content === FRONTIER_ASK_INSTRUCTIONS) { this.askInputs.push(String(messages[1]?.content ?? "")); return { questions: [] }; }
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
  const edited = async (/** @type {{ id: string }} */ item) => (await database.query("SELECT editor_version FROM evimed_frontier.items WHERE id = $1", [item.id])).rows[0].editor_version;
  assert.equal(await edited(withWords), null, "a crawl post's card summary owes one edit under the new rule");
  assert.notEqual(await edited(xPost), null);
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


// ───────────────────────── rd-fix (2026-10-31): the review's findings ─────────────────────────

const PICTURE_ID_3 = "c".repeat(64);
const PICTURE_ID_4 = "d".repeat(64);
const pictureRef = (/** @type {string} */ id) => ({ id, kind: "image", original_url: `https://example.org/${id.slice(0, 4)}.jpg` });
const WORDS_A = "司美格鲁肽减重须遵医嘱：每周一次，起始剂量0.25毫克";
const WORDS_B = "不可自行加量，出现严重恶心呕吐应及时就医复诊";
const markSwept = () => database.query("INSERT INTO evimed_frontier.meta (key, value, updated_at) VALUES ($1, '1'::jsonb, clock_timestamp()) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [FRONTIER_META_KEYS.postSweep]);
const rowOf = async (/** @type {{ id: string }} */ item) => (await database.query("SELECT * FROM evimed_frontier.items WHERE id = $1", [item.id])).rows[0];
/** A parser that reads the words of a picture by the first letter of its file name (a/b/c/d), as the pipeline names them. */
const parserByLetter = (/** @type {Record<string, string | Error>} */ words) => parserWith(async (input) => {
  const answer = words[input.filename[0]];
  if (answer instanceof Error) throw answer;
  return { text: answer ?? "" };
});
const refused = (/** @type {string} */ code) => Object.assign(new Error(code), { code });

test("F1: a post the pipeline withdrew, or gave up on, whose pictures arrive later is read through them and comes back with its 导读 and an edit", options, async () => {
  await markSwept();
  const texts = new Map();
  // Withdrawn by us while it had no pictures; the plugin delivered them since (items.media is the entry's latest).
  const withdrawn = await storedPost(XHS_TAGS);
  await database.query("UPDATE evimed_frontier.items SET state = 'withdrawn', withdrawn_reason = $2, withdrawn_at = clock_timestamp(), media = $3::jsonb WHERE id = $1",
    [withdrawn.id, POST_WITHDRAWN, JSON.stringify([pictureRef(PICTURE_ID), pictureRef(PICTURE_ID_2)])]);
  // Gave up for having no text, with pictures stored: the same.
  const gaveUp = await storedPost({ ...XHS_TAGS, title: "另一条只有标签的笔记", text: "另一条只有标签的笔记 #罕见病[话题]#" }, { media: [pictureRef(PICTURE_ID)] });
  await database.query("UPDATE evimed_frontier.items SET state = 'failed', editor_diagnostics = '{\"giveUp\":\"no-text\"}'::jsonb WHERE id = $1", [gaveUp.id]);
  // Pulled by an operator: never read, never brought back.
  const pulled = await storedPost({ ...XHS_TAGS, title: "运营撤下的笔记", text: "运营撤下的笔记 #新药[话题]#" }, { media: [pictureRef(PICTURE_ID)] });
  await database.query("UPDATE evimed_frontier.items SET state = 'withdrawn', withdrawn_reason = 'operator', withdrawn_at = clock_timestamp() WHERE id = $1", [pulled.id]);
  // Withdrawn by us and its pictures hold no words: it stays out, and is not asked about again.
  const bare = await storedPost({ ...XHS_TAGS, title: "图里没有字的笔记", text: "图里没有字的笔记 #新药[话题]#" }, { media: [pictureRef(PICTURE_ID_3)] });
  await database.query("UPDATE evimed_frontier.items SET state = 'withdrawn', withdrawn_reason = $2, withdrawn_at = clock_timestamp() WHERE id = $1", [bare.id, POST_WITHDRAWN]);

  const editor = editorWith({ lead: (input) => (input.includes("图片中的文字") ? { lead_zh: "司美格鲁肽减重须遵医嘱，每周一次，起始剂量0.25毫克。" } : { lead_zh: "" }) });
  const parser = parserByLetter({ a: WORDS_A, b: WORDS_B, c: "" });
  const media = mediaFor({ pictures: new Set([PICTURE_ID, PICTURE_ID_2, PICTURE_ID_3]) });
  const pipeline = pipelineFor(editor, { plugin: pluginFor(texts), parser, media });
  await pipeline.processBatch();

  const back = await rowOf(withdrawn);
  assert.equal(back.state, "published");
  assert.equal(back.withdrawn_reason, null);
  assert.equal(pipeline.counters.postsReinstated, 1);
  assert.ok((await database.query("SELECT op, reason FROM evimed_frontier.item_changes WHERE item_id = $1 ORDER BY seq", [withdrawn.id])).rows.some((row) => row.op === "upsert" && row.reason === "published"));
  assert.equal(back.lead_zh, "司美格鲁肽减重须遵医嘱，每周一次，起始剂量0.25毫克。", "its 导读 is written from the words in the pictures");
  assert.ok(editor.editInputs.some((input) => /图片中的文字：/.test(input.bodyExcerpt ?? "")), "and it owed one edit, made from them");
  assert.ok(back.text_arrived_at, "the edit is claimed by the window it is in");
  const queued = await rowOf(gaveUp);
  assert.equal(queued.state, "published", "a post that gave up for having no text is queued again and published in the same round");
  assert.equal((await rowOf(pulled)).state, "withdrawn");
  assert.equal((await rowOf(pulled)).withdrawn_reason, "operator");
  assert.equal((await textsOf(pulled.id)).picture_tried_at, null, "an operator's withdrawal is not looked at");
  const stayed = await rowOf(bare);
  assert.equal(stayed.state, "withdrawn");
  assert.ok((await textsOf(bare.id)).picture_tried_at, "tried once");
  const calls = parser.calls.length;
  await pipelineFor(editor, { plugin: pluginFor(texts), parser, media, now: new Date(NOW.getTime() + 3_600_000) }).processBatch();
  assert.equal(parser.calls.length, calls, "not asked again");
});

test("F1: a revision that brings a picture the post did not have makes a post whose pictures held no words claimable again", options, async () => {
  const texts = new Map();
  const first = await deliver(XHS_TAGS, texts, { media: [pictureRef(PICTURE_ID)] });
  const editor = editorWith({ lead: () => ({ lead_zh: "" }) });
  const parser = parserByLetter({ a: "", d: WORDS_A });
  const media = mediaFor({ pictures: new Set([PICTURE_ID, PICTURE_ID_4]) });
  await pipelineFor(editor, { plugin: pluginFor(texts), parser, media }).processBatch();
  assert.equal((await itemOfEntry(first.entryId)).state, "failed", "its only picture held no words");
  assert.ok((await textsOf((await itemOfEntry(first.entryId)).id)).picture_tried_at);

  await deliver(XHS_TAGS, texts, { pluginEntryId: first.pluginEntryId, revision: 2, media: [pictureRef(PICTURE_ID), pictureRef(PICTURE_ID_4)], answer: { status: "unavailable" } });
  await pipelineFor(editor, { plugin: pluginFor(texts), parser, media, now: new Date(NOW.getTime() + 3_600_000) }).processBatch();
  const item = await itemOfEntry(first.entryId);
  assert.equal(item.state, "published", "the new picture was read");
  assert.equal((await textsOf(item.id)).picture_text, WORDS_A);
});

test("F2: a picture that always fails is that picture's failure — the other pictures' words are kept, the post counts as tried, and nothing is parsed twice", options, async () => {
  for (const code of ["source_parser_internal_error", "source_parser_upstream_error", "source_parser_timeout", "source_parser_canceled"]) {
    await database.query("DELETE FROM evimed_frontier.items");
    await database.query("DELETE FROM evimed_frontier.entries");
    const texts = new Map();
    const post = await deliver(XHS_TAGS, texts, { media: [pictureRef(PICTURE_ID), pictureRef(PICTURE_ID_2), pictureRef(PICTURE_ID_3)] });
    const parser = parserByLetter({ a: WORDS_A, b: WORDS_B, c: refused(code) });
    const media = mediaFor({ pictures: new Set([PICTURE_ID, PICTURE_ID_2, PICTURE_ID_3]) });
    const editor = editorWith({ lead: () => ({ lead_zh: "" }) });
    const pipeline = pipelineFor(editor, { plugin: pluginFor(texts), parser, media });
    await pipeline.processBatch();
    const item = await itemOfEntry(post.entryId);
    const stored = await textsOf(item.id);
    assert.equal(item.state, "published", code);
    assert.equal(stored.picture_text, `${WORDS_A}\n${WORDS_B}`, code);
    assert.ok(stored.picture_tried_at, `${code}: tried`);
    assert.equal(pipeline.counters.postPicturesDeferred, 0, code);
    assert.equal(parser.calls.length, 3, code);
    await pipelineFor(editor, { plugin: pluginFor(texts), parser, media, now: new Date(NOW.getTime() + 3_600_000) }).processBatch();
    assert.equal(parser.calls.length, 3, `${code}: the good pictures are not parsed again`);
  }
});

test("F2: a service-level refusal after the first picture parsed only delays the post, and the picture that parsed is not parsed again", options, async () => {
  const texts = new Map();
  const post = await deliver(XHS_TAGS, texts, { media: [pictureRef(PICTURE_ID), pictureRef(PICTURE_ID_2)] });
  let limited = true;
  const parser = parserWith(async (input) => {
    if (input.filename[0] === "b" && limited) throw refused("source_parser_rate_limited");
    return { text: input.filename[0] === "a" ? WORDS_A : WORDS_B };
  });
  const media = mediaFor();
  const editor = editorWith({ lead: () => ({ lead_zh: "" }) });
  const first = pipelineFor(editor, { plugin: pluginFor(texts), parser, media });
  await first.processBatch();
  assert.equal(first.counters.postPicturesDeferred, 1);
  assert.equal((await textsOf((await itemOfEntry(post.entryId)).id)).picture_tried_at, null, "not a try");
  limited = false;
  // The same worker, a later round: the limit is lifted.
  first.now = () => new Date(NOW.getTime() + 3_600_000);
  await first.processBatch();
  assert.equal((await textsOf((await itemOfEntry(post.entryId)).id)).picture_text, `${WORDS_A}\n${WORDS_B}`, "in order");
  assert.equal(parser.calls.filter((call) => call.filename[0] === "a").length, 1, "the first picture was parsed once");
});

test("F2/F9: a plugin that cannot be reached costs no parse, and a post not reached in a round keeps the wait it sat in", options, async () => {
  const texts = new Map();
  const media = [pictureRef(PICTURE_ID)];
  const posts = [];
  for (let i = 0; i < 6; i += 1) posts.push(await deliver({ ...XHS_TAGS, title: `只有标签的第${i}条笔记`, text: `只有标签的第${i}条笔记 #罕见病[话题]#` }, texts, { media }));
  const editor = editorWith({ lead: () => ({ lead_zh: "" }) });
  // Round one: the parser is down; every post waits twelve hours.
  const down = parserWith(async () => { throw refused("source_parser_unavailable"); });
  await pipelineFor(editor, { plugin: pluginFor(texts), parser: down }).processBatch();
  const waits = new Map();
  for (const post of posts) {
    const item = await itemOfEntry(post.entryId);
    assert.ok(item.lease_until && new Date(item.lease_until) > NOW, "waiting");
    waits.set(post.entryId, new Date(item.lease_until).getTime());
  }
  // Round two, half an hour later: the parser works, four posts are read, the other two are not reached and keep their wait.
  const parser = parserByLetter({ a: WORDS_A });
  const later = new Date(NOW.getTime() + 30 * 60_000);
  const pipeline = pipelineFor(editor, { plugin: pluginFor(texts), parser, now: later });
  await pipeline.processBatch();
  assert.equal(parser.calls.length, FRONTIER_POST_LIMITS.postsPerRound);
  let kept = 0;
  for (const post of posts) {
    const item = await itemOfEntry(post.entryId);
    if (item.state === "published") continue;
    kept += 1;
    assert.equal(new Date(item.lease_until).getTime(), waits.get(post.entryId), "the wait it sat in, not twelve hours from this round");
    assert.equal((await textsOf(item.id)).picture_tried_at, null);
  }
  assert.equal(kept, posts.length - FRONTIER_POST_LIMITS.postsPerRound);
});

test("F5: the sweep's owed edit really reaches a post older than the owed-edit window; a post already re-scored keeps its card summary", options, async () => {
  const old = await storedPost(XHS_WORDS, { visibleAt: "2026-10-21T02:00:00Z" });
  const rescored = await storedPost({ ...XHS_WORDS, title: "另一条已经重新打分的笔记", text: XHS_WORDS.text.replace(XHS_WORDS.title, "另一条已经重新打分的笔记") }, { visibleAt: "2026-10-21T03:00:00Z" });
  await database.query("UPDATE evimed_frontier.items SET rescored_at = '2026-10-22T00:00:00Z' WHERE id = $1", [rescored.id]);
  const editor = editorWith({ lead: () => ({ lead_zh: "一名200斤男子联用两种减重药物后突发脑梗。" }) });
  const pipeline = pipelineFor(editor, { plugin: pluginFor(new Map()) });
  await pipeline.processBatch();
  assert.equal(editor.editInputs.length, 1, "one edit: the old post's");
  assert.match(editor.editInputs[0].bodyExcerpt, /^200斤男子使用/);
  const edited = await rowOf(old);
  assert.equal(edited.editor_version, FRONTIER_EDITOR_VERSION);
  assert.ok(edited.rescored_at, "the edit is a re-score of the post");
  assert.ok(edited.text_arrived_at);
  assert.equal((await rowOf(rescored)).text_arrived_at, null);
  assert.equal((await rowOf(rescored)).summary_zh, "卡片摘要。", "what its re-score wrote stays");
});

test("F5: pictures read for a post that was edited before it had anything to read owe it a second edit; a post shown while waiting is not edited from nothing", options, async () => {
  await markSwept();
  const texts = new Map();
  const media = [pictureRef(PICTURE_ID)];
  const waiting = await storedPost(XHS_TAGS, { media });
  await database.query("UPDATE evimed_frontier.items SET rescored_at = '2026-10-30T03:00:00Z' WHERE id = $1", [waiting.id]);
  const editor = editorWith({ lead: () => ({ lead_zh: "" }) });
  // The parser is down: the post waits, owes an edit (a late text moved it), and is not edited from the title alone.
  await database.query("UPDATE evimed_frontier.items SET editor_version = NULL, text_arrived_at = clock_timestamp() WHERE id = $1", [waiting.id]);
  const down = parserWith(async () => { throw refused("source_parser_unavailable"); });
  await pipelineFor(editor, { plugin: pluginFor(texts), parser: down }).processBatch();
  assert.equal(editor.editInputs.length, 0, "no edit from nothing");
  const parked = await rowOf(waiting);
  assert.equal(parked.editor_version, null);
  assert.ok(new Date(parked.lease_until) > NOW, "it waits for its pictures");
  // The pictures are read: it owes the edit, rescored or not, and gets it from the words.
  const parser = parserByLetter({ a: WORDS_A });
  await pipelineFor(editor, { plugin: pluginFor(texts), parser, now: new Date(NOW.getTime() + 13 * 3_600_000) }).processBatch();
  assert.equal(editor.editInputs.length, 1);
  assert.match(editor.editInputs[0].bodyExcerpt, /图片中的文字：\n司美格鲁肽/);
  assert.equal((await rowOf(waiting)).editor_version, FRONTIER_EDITOR_VERSION);
});

test("F8: a post with nothing to read is recorded as having no 要点, as it is for the 导读, and leaves the queue", options, async () => {
  await markSwept();
  const thin = await storedPost(XHS_TAGS, { media: [pictureRef(PICTURE_ID)] });
  await database.query("UPDATE evimed_frontier.items SET selected = true, selected_rule = 'threshold', selected_at = visible_at WHERE id = $1", [thin.id]);
  const editor = editorWith();
  await pipelineFor(editor, { plugin: pluginFor(new Map()), parser: null }).processBatch();
  const row = await rowOf(thin);
  assert.equal(row.brief, null);
  assert.equal(row.brief_basis, `${(await textsOf(thin.id)).reader_tidy.sha}:social`, "asked once for this text and genre");
  assert.equal(row.lead_zh, null);
});

test("F10: a title-only post whose pictures held words gets its 导读 and its questions, with no text column at all", options, async () => {
  const texts = new Map();
  const TITLE_ONLY = { platform: "xiaohongshu", title: "笔记", text: "笔记 #罕见病[话题]#" };
  const post = await deliver(TITLE_ONLY, texts, { media: [pictureRef(PICTURE_ID)], answer: { status: "unavailable" } });
  const editor = editorWith({ lead: (input) => (input.includes("图片中的文字") ? { lead_zh: "司美格鲁肽减重须遵医嘱，每周一次，起始剂量0.25毫克。" } : { lead_zh: "" }) });
  const parser = parserByLetter({ a: WORDS_A });
  const pipeline = pipelineFor(editor, { plugin: pluginFor(texts), parser });
  await pipeline.processBatch();
  const item = await itemOfEntry(post.entryId);
  const stored = await textsOf(item.id);
  assert.equal(item.state, "published");
  assert.equal(stored.body_text ?? stored.body_excerpt ?? null, null, "no text column of the post's own");
  assert.equal(stored.reader_summary, `图片中的文字：\n${WORDS_A}`);
  assert.ok(stored.reader_tidy?.sha, "its reader text is settled");
  assert.equal(editor.leadInputs.length, 1);
  assert.match(editor.leadInputs[0], /\n图片中的文字：\n司美格鲁肽/);
  assert.equal((editor.leadInputs[0].match(/图片中的文字/g) ?? []).length, 1, "the words are given once");
  assert.equal(item.lead_zh, "司美格鲁肽减重须遵医嘱，每周一次，起始剂量0.25毫克。");
  assert.equal(editor.askInputs.length, 1, "the questions are asked for it too");
  assert.match(editor.askInputs[0], /图片中的文字/);
  assert.equal(item.ask_basis, stored.reader_tidy.sha);
  // A revision of the post that changes nothing of its text keeps the words as its reader text.
  await deliver(TITLE_ONLY, texts, { pluginEntryId: post.pluginEntryId, revision: 2, media: [pictureRef(PICTURE_ID)], answer: { status: "unavailable" } });
  await pipelineFor(editor, { plugin: pluginFor(texts), parser, now: new Date(NOW.getTime() + 3_600_000) }).processBatch();
  assert.equal((await textsOf(item.id)).reader_summary, `图片中的文字：\n${WORDS_A}`);
  // The reader's page does not carry them.
  const page = (await serviceFor().getItem(reader, item.public_id)).body.item;
  assert.equal(page.body.original, null);
});

test("F11: the sweep takes the content version last — a transaction holding a later item and wanting the version is not deadlocked with it", options, async () => {
  const tagsOnly = await storedPost(XHS_TAGS);
  const twice = await storedPost(CHANNELS_TWICE);
  const thinSummary = await insertItem(database, { title: "A record", visibleAt: "2026-10-30T03:00:00Z" });
  await database.query("UPDATE evimed_frontier.items SET lead_zh = '消息仅提供标题。', lead_basis = 'basis-old' WHERE id = $1", [thinSummary.id]);
  await database.query("UPDATE evimed_frontier.item_texts SET reader_summary = 'Sponsor: X.', reader_tidy = $2::jsonb WHERE item_id = $1", [thinSummary.id, JSON.stringify({ source: "summary", sha: "s", drop: [] })]);
  const client = await database.pool.connect();
  const editor = { ...editorWith(), available: false };
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM evimed_frontier.items WHERE id = $1 FOR UPDATE", [thinSummary.id]);
    const sweep = pipelineFor(editor, { plugin: pluginFor(new Map()) }).processBatch();
    // The sweep has withdrawn its posts and waits for the item this transaction holds.
    for (let waited = 0; waited < 50; waited += 1) {
      const blocked = (await database.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%SET lead_basis = NULL%'")).rows[0].n;
      if (blocked) break;
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    // This transaction now wants the version: with the sweep holding it, the two would wait for each other.
    await bumpFrontierVersion(client);
    await client.query("COMMIT");
    await sweep;
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
  assert.equal(Number((await database.query("SELECT value FROM evimed_frontier.meta WHERE key = $1", [FRONTIER_META_KEYS.postSweep])).rows[0]?.value), 1, "the sweep finished its first try");
  for (const gone of [tagsOnly, twice]) assert.equal((await rowOf(gone)).state, "withdrawn");
  assert.equal((await rowOf(thinSummary)).lead_basis, null);
});

test("F13: an operator's withdrawal of a post the pipeline already withdrew replaces the reason, so a revision with words does not bring it back", options, async () => {
  const texts = new Map();
  const bare = await storedPost(XHS_TAGS);
  const editor = editorWith({ lead: () => ({ lead_zh: "我国拟对目录外罕见病新药设置市场独占期保护。" }) });
  await pipelineFor(editor, { plugin: pluginFor(texts) }).processBatch();
  assert.equal((await rowOf(bare)).withdrawn_reason, POST_WITHDRAWN);
  const done = await serviceFor().operateItem(bare.publicId, "withdraw", { reason: "operator: duplicate of another" });
  assert.equal(done.item.withdrawnReason, "operator: duplicate of another");
  assert.equal((await rowOf(bare)).withdrawn_reason, "operator: duplicate of another");

  const entry = (await database.query("SELECT * FROM evimed_frontier.entries WHERE item_id = $1", [bare.id])).rows[0];
  const whole = `${XHS_TAGS.title} 我国拟对目录外的罕见病新药设置市场独占期保护，保护期内不批准同类仿制药上市。#罕见病[话题]# #新药[话题]#`;
  seq += 1;
  await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, revision, source_id, identity_key, url, canonical_url, title_raw, summary_raw, first_seen_at,
      content_sha256, state, platform, channel, media)
    VALUES ($1,$2,2,'social-monitor',$3,$4,$4,$5,$6,$7,$8,'received','xiaohongshu','social','[]'::jsonb)`,
  [entry.plugin_entry_id, 740_000 + seq, entry.identity_key, entry.url, entry.title_raw, whole.slice(0, 299), entry.first_seen_at, sha256(`rev${seq}`)]);
  texts.set(entry.plugin_entry_id, { status: "available", body_text: whole.replace(`${XHS_TAGS.title} `, ""), text_kind: "full", enrichment: {} });
  await pipelineFor(editor, { plugin: pluginFor(texts), now: new Date(NOW.getTime() + 3_600_000) }).processBatch();
  assert.equal((await rowOf(bare)).state, "withdrawn", "the operator's withdrawal stands");
});
