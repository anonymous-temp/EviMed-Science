// A crawl post's reading text (rd-server 2026-10-31): the strings are real posts from the six crawl platforms as the feed stored them on
// 2026-10-31 (the plugin's `title content` excerpt, cut at 300 characters), asserted on what the reader and the model are shown of each.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FRONTIER_CRAWL_PLATFORMS } from "@evimed/domain";
import { loadConfig } from "../src/config.mjs";
import { buildLeadInput, frontierLeadInstructions } from "../src/frontierLead.mjs";
import { frontierItemReadable, frontierReaderText, frontierTextDecision } from "../src/frontierPipeline.mjs";
import {
  FRONTIER_POST_LIMITS, frontierCrawlPost, frontierPostBody, frontierPostClean, frontierPostMaterial, frontierPostOf, frontierPostReading, frontierPostSaysSomething,
  frontierPostText, frontierPostWeight,
} from "../src/frontierPostText.mjs";

const XHS_TAGS = { platform: "xiaohongshu", title: "目录外罕见病新药拟纳入市场独占期保护", text: "目录外罕见病新药拟纳入市场独占期保护 #罕见病[话题]# #新药[话题]#" };
const CHANNELS_TWICE = { platform: "channels", title: "林榕波教授：PD-1/IL-15 双功能融合蛋白 JMT108：晚期实体瘤免疫治疗新探索#2026ESMO#中国之声",
  text: "林榕波教授：PD-1/IL-15 双功能融合蛋白 JMT108：晚期实体瘤免疫治疗新探索#2026ESMO#中国之声 林榕波教授：PD-1/IL-15 双功能融合蛋白 JMT108：晚期实体瘤免疫治疗新探索#2026ESMO#中国之声" };
const DOUYIN_TWICE = { platform: "douyin", title: "这2种降压药被查出致癌，快看看家里的药箱！ #降压药 #高血压 #神经内科 #抖出健康知识宝藏 #降压药的副作用",
  text: "这2种降压药被查出致癌，快看看家里的药箱！ #降压药 #高血压 #神经内科 #抖出健康知识宝藏 #降压药的副作用 这2种降压药被查出致癌，快看看家里的药箱！ #降压药 #高血压 #神经内科 #抖出健康知识宝藏 #降压药的副作用" };
const WEIBO_CUT_TWICE = { platform: "weibo", title: "#原创# #健康有料到# 警惕！诺如病毒进入高发期，儿童易感染且无特效药！医生提醒：吃水果前记得充分洗净，双手保持清洁卫生。 http://t.cn/AXj80",
  text: "#原创# #健康有料到# 警惕！诺如病毒进入高发期，儿童易感染且无特效药！医生提醒：吃水果前记得充分洗净，双手保持清洁卫生。 http://t.cn/AXj80 #原创# #健康有料到# 警惕！诺如病毒进入高发期，儿童易感染且无特效药！医生提醒：吃水果前记得充分洗净，双手保持清洁卫生。 http://t.cn/AXj80QC3" };
const HEADLINE_TWICE = { platform: "channels", title: "慢性阻塞性肺疾病诊治指南2026", text: "慢性阻塞性肺疾病诊治指南2026 慢性阻塞性肺疾病诊治指南2026" };
const XHS_WORDS = { platform: "xiaohongshu", title: "男子用两种减肥药两个月减重40斤后突发脑梗",
  text: "男子用两种减肥药两个月减重40斤后突发脑梗 200斤男子使用“减肥神针”司美格鲁肽和达格列净两种药物 ，两个月减重40斤后突发脑梗，医生表示：两种药物不当联用或诱发卒中，须遵医嘱用药。#健康科普howto[话题]# #医疗健康howto[话题]# #减肥药[话题]# #减肥方法[话题]# #健康科普[话题]#" };
const ZHIHU_SHORT = { platform: "zhihu", title: "FDA 将波士顿科学 enroute 产品召回划为最高级别，这对患者和医疗行业有何影响？",
  text: "FDA 将波士顿科学 enroute 产品召回划为最高级别，这对患者和医疗行业有何影响？ 最近几年医疗行业有很多的试验是在小范围的进行药物试验，数据本身提供了某种反馈吧" };
const WEIBO_WORDS = { platform: "weibo", title: "【#小城良方治鼻炎的偏方对吗# [思考]】#甲硝唑磨粉吸进鼻子到底行不行# 近日，医疗剧《小城良方》热播。其中一幕显示，由肖战饰演的刘铮亮回到东北基层医院上班",
  text: "【#小城良方治鼻炎的偏方对吗# [思考]】#甲硝唑磨粉吸进鼻子到底行不行# 近日，医疗剧《小城良方》热播。其中一幕显示，由肖战饰演的刘铮亮回到东北基层医院上班 【#小城良方治鼻炎的偏方对吗# [思考]】#甲硝唑磨粉吸进鼻子到底行不行# 近日，医疗剧《小城良方》热播。其中一幕显示，由肖战饰演的刘铮亮回到东北基层医院上班，撞见科室主任正照着会计给的偏方，把甲硝唑磨粉吸进鼻子治鼻炎，顿时震惊不已。" };

test("the crawl platforms are the contract's platforms that are posts a crawler reads", () => {
  assert.deepEqual([...FRONTIER_CRAWL_PLATFORMS], ["xiaohongshu", "douyin", "zhihu", "weibo", "bilibili", "channels"]);
  assert.equal(frontierCrawlPost("weibo"), true);
  for (const other of ["x", "wechat", "web", "", null, undefined]) assert.equal(frontierCrawlPost(other), false);
});

test("the platforms' markers go and the words stay: topic marks, emoticons, zero-width characters, tab-only lines", () => {
  assert.equal(frontierPostClean("第一行‌​ \n\t\t\n\n\n第二行￼的字[笑哭R][赞R] ok\n\t \n"), "第一行\n\n第二行的字 ok");
  assert.equal(frontierPostClean("【#话题# [思考]】正文"), "【#话题#】正文");
  // A citation number and a bracketed range are the text's own and stay.
  assert.equal(frontierPostClean("结果显示[1] 与[2]相符 [图片] 末尾 [21-46]"), "结果显示[1] 与[2]相符 末尾 [21-46]");
  assert.equal(frontierPostClean("#抑郁症[话题]# #焦虑[话题]#"), "#抑郁症 #焦虑");
  assert.equal(frontierPostClean(null), "");
});

test("a post that is its title and its hashtags says nothing of its own — the title twice, or the title and its tags, or a cut title repeated", () => {
  for (const [name, post] of [["xhs tags only", XHS_TAGS], ["channels title twice", CHANNELS_TWICE], ["douyin title twice", DOUYIN_TWICE], ["weibo cut title twice", WEIBO_CUT_TWICE]]) {
    const read = frontierPostText({ ...post, layout: "titled" });
    assert.ok(read.own < FRONTIER_POST_LIMITS.own, `${name}: ${read.own} characters of its own`);
    assert.equal(frontierPostSaysSomething(read), false, name);
    assert.equal(frontierPostBody(frontierPostOf({ body_excerpt: post.text }, post.title)), null, name);
  }
  // The new layout: the post's own text is the title and nothing else.
  assert.equal(frontierPostText({ title: CHANNELS_TWICE.title, text: CHANNELS_TWICE.title, layout: "own" }).own, 0);
  // Its tags are tags, in order, and the xhs marker is not part of one.
  assert.deepEqual(frontierPostText({ ...XHS_TAGS }).tags, ["#罕见病", "#新药"]);
  assert.deepEqual(frontierPostText({ ...DOUYIN_TWICE }).tags.length, 5);
});

test("a post with words keeps them: the title copy the old layout put in front is gone, the tags are told apart, the markers are removed", () => {
  const read = frontierPostText({ ...XHS_WORDS, layout: "titled" });
  assert.ok(frontierPostSaysSomething(read));
  assert.equal(read.words, "200斤男子使用“减肥神针”司美格鲁肽和达格列净两种药物 ，两个月减重40斤后突发脑梗，医生表示：两种药物不当联用或诱发卒中，须遵医嘱用药");
  assert.deepEqual(read.tags, ["#健康科普howto", "#医疗健康howto", "#减肥药", "#减肥方法", "#健康科普"]);
  assert.doesNotMatch(read.text, /\[话题\]/);
  assert.equal(frontierPostBody(frontierPostOf({ body_excerpt: XHS_WORDS.text }, XHS_WORDS.title)), read.words);
  // A short answer under a question is a text (a Zhihu comment of one sentence).
  const short = frontierPostText({ ...ZHIHU_SHORT, layout: "titled" });
  assert.ok(frontierPostSaysSomething(short));
  assert.match(short.words, /^最近几年医疗行业/);
});

test("a first line that is the title's own cut stays in the body once: the copy the layout adds is removed, the post is read whole", () => {
  const titled = frontierPostText({ ...WEIBO_WORDS, layout: "titled" });
  assert.match(titled.words, /^【#小城良方治鼻炎的偏方对吗#】#甲硝唑磨粉吸进鼻子到底行不行# 近日，医疗剧《小城良方》热播/);
  assert.match(titled.words, /顿时震惊不已。$/);
  assert.equal(titled.words.split("近日，医疗剧").length, 2, "the cut title appears once");
  // The same post as its plugin text arrives now: the whole text, the title not added in front of it.
  const own = frontierPostText({ title: WEIBO_WORDS.title, text: titled.words, layout: "own" });
  assert.equal(own.words, titled.words);
  assert.equal(own.own, titled.own);
});

test("what a post says of its own is counted in the unit of frontierLeadLimit and not by its links, mentions, tags or punctuation", () => {
  assert.equal(frontierPostWeight("abc！？。 #tag"), 0.3 * 6);
  assert.equal(frontierPostWeight("三个字"), 3);
  const read = frontierPostText({ title: "标题", text: "标题 @某账号 http://t.cn/AXj80QC3 #话题 ！！！", layout: "titled" });
  assert.equal(read.own, 0);
  // The measure's constant: the thinnest post that says something in the day's 45 real posts counted 38, the ones that say nothing 0 to 0.9.
  assert.ok(FRONTIER_POST_LIMITS.own > 1 && FRONTIER_POST_LIMITS.own < 38);
});

test("the model reads a post's words, its tags on a line of their own and — only when read — the words in its pictures under their own label", () => {
  const post = frontierPostOf({ body_excerpt: XHS_WORDS.text }, XHS_WORDS.title);
  assert.ok(post);
  const material = frontierPostMaterial(post, "  图上写着：每周一次  ");
  assert.match(material, /^200斤男子使用/);
  assert.match(material, /\n\n#健康科普howto #医疗健康howto/);
  assert.match(material, /\n\n图片中的文字：\n图上写着：每周一次$/);
  assert.doesNotMatch(frontierPostMaterial(post, null), /图片中的文字/);
  assert.equal(frontierPostMaterial(null, "只有图里的字"), "图片中的文字：\n只有图里的字");
});

test("a row's own text is read before its excerpt, and the excerpt before the entry's summary", () => {
  assert.equal(frontierPostOf({ body_text: "正文一", body_excerpt: "标题 正文二" }, "标题")?.layout, "own");
  assert.equal(frontierPostOf({ body_text: " ", body_excerpt: "标题 正文二" }, "标题")?.layout, "titled");
  assert.equal(frontierPostOf({}, "标题", "标题 正文三")?.words, "正文三");
  assert.equal(frontierPostOf(null, "标题", null), null);
});

test("a crawl post is shown when it says something or its pictures were read, waits while its stored pictures are untried, and is out otherwise", () => {
  const media = [{ id: "a".repeat(64), kind: "image" }];
  const thin = { body_excerpt: XHS_TAGS.text };
  assert.deepEqual(frontierPostReading({ title: XHS_TAGS.title, texts: thin, media: [] }), { readable: false, waiting: false, says: false, pictures: "none", own: 0 });
  assert.deepEqual(frontierPostReading({ title: XHS_TAGS.title, texts: thin, media }), { readable: false, waiting: true, says: false, pictures: "pending", own: 0 });
  // A try that found nothing ends the wait; one that found words makes the post readable (the reader's body is still empty).
  assert.equal(frontierPostReading({ title: XHS_TAGS.title, texts: { ...thin, picture_tried_at: new Date(), picture_text: "" }, media }).waiting, false);
  const read = frontierPostReading({ title: XHS_TAGS.title, texts: { ...thin, picture_tried_at: new Date(), picture_text: "服药方法：每周一次，每次一支" }, media });
  assert.equal(read.readable, true);
  assert.equal(read.pictures, "read");
  assert.equal(frontierPostBody(frontierPostOf(thin, XHS_TAGS.title)), null);
  // Words in the post's own text are enough, whatever the pictures; an id that is not a stored picture's is no picture.
  assert.equal(frontierPostReading({ title: XHS_WORDS.title, texts: { body_excerpt: XHS_WORDS.text } }).readable, true);
  assert.equal(frontierPostReading({ title: XHS_TAGS.title, texts: thin, media: [{ id: "x" }] }).waiting, false);
  // The entry's summary stands in for a text not stored yet.
  assert.equal(frontierPostReading({ title: XHS_WORDS.title, texts: null, summary: XHS_WORDS.text }).readable, true);
});

const NOW = new Date("2026-10-31T04:00:00Z");
const entryOf = (/** @type {typeof XHS_WORDS} */ post, /** @type {Record<string, any>} */ more = {}) => ({ first_seen_at: "2026-10-31T03:00:00Z", platform: post.platform, title_raw: post.title,
  summary_raw: post.text.slice(0, 299), media: [], defects: [], ...more });

test("the text decision: a post that says nothing and has nothing to wait for is dropped as such, however long its feed summary is", () => {
  const source = { access: "rss", safety_feed: false };
  const decide = (/** @type {typeof XHS_WORDS} */ post, /** @type {any} */ status, /** @type {Record<string, any>} */ more = {}) => {
    const entry = entryOf(post, more.entry);
    const texts = status === "available" ? { body_excerpt: post.text, ...more.texts } : more.texts ?? null;
    const reading = frontierPostReading({ title: post.title, texts, summary: entry.summary_raw, media: entry.media });
    return frontierTextDecision({ status, entry, source, promoted: Boolean(more.promoted), now: NOW, post: reading });
  };
  // The feed summary of the title and its hashtags is more than 80 characters: the ordinary rule would have called it usable.
  assert.ok(entryOf(XHS_TAGS).summary_raw.length >= 30);
  assert.deepEqual(decide(HEADLINE_TWICE, "available"), { action: "drop", holdMs: 0, reason: "post-no-text" });
  assert.deepEqual(decide(XHS_TAGS, "available"), { action: "drop", holdMs: 0, reason: "post-no-text" });
  assert.equal(decide(XHS_WORDS, "available").action, "promote");
  // Pictures to wait for: promoted, not dropped; and a post already an item is kept whatever its text now says (the revision decides afterwards).
  const media = [{ id: "c".repeat(64), kind: "image" }];
  assert.equal(decide(XHS_TAGS, "available", { entry: { media } }).action, "promote");
  assert.equal(decide(HEADLINE_TWICE, "available", { promoted: true }).action, "promote");
  // A text still to come is waited for, a post whose summary already says something is shown meanwhile; once nothing comes it is dropped.
  assert.equal(decide(XHS_TAGS, "pending").action, "hold");
  assert.equal(decide(XHS_WORDS, "pending").action, "promote-hold");
  assert.deepEqual(decide(XHS_TAGS, "unavailable"), { action: "drop", holdMs: 0, reason: "post-no-text" });
  // Every other item keeps its answer exactly as it was: no `reason` on a drop.
  assert.deepEqual(frontierTextDecision({ status: "unavailable", entry: { first_seen_at: "2026-10-31T03:00:00Z", summary_raw: "x", defects: [] }, source, promoted: false, now: NOW }), { action: "drop", holdMs: 0 });
});

test("an item is readable by its post's words, not by a feed summary that holds only the title and its tags", () => {
  const source = { access: "rss" };
  for (const [post, readable] of [[XHS_WORDS, true], [XHS_TAGS, false], [HEADLINE_TWICE, false], [DOUYIN_TWICE, false], [CHANNELS_TWICE, true]]) {
    const entry = entryOf(post);
    assert.equal(frontierItemReadable({ texts: { body_excerpt: post.text }, entry, source }), readable, post.title);
  }
  // Pictures read, or the post's own text arrived whole, make a thin excerpt readable.
  assert.equal(frontierItemReadable({ texts: { body_excerpt: XHS_TAGS.text, picture_text: POSTER_WORDS_FOR_TEST, picture_tried_at: NOW }, entry: entryOf(XHS_TAGS), source }), true);
  assert.equal(frontierItemReadable({ texts: { body_text: "我国拟对目录外的罕见病新药设置市场独占期保护，保护期内不批准同类仿制药上市。" }, entry: entryOf(XHS_TAGS), source }), true);
  // A non-crawl item is judged as before: a feed summary of 80 characters is enough.
  assert.equal(frontierItemReadable({ texts: null, entry: { platform: "x", title_raw: "t", summary_raw: "s".repeat(90), defects: [] }, source }), true);
});
const POSTER_WORDS_FOR_TEST = "司美格鲁肽减重须遵医嘱：每周一次，起始剂量0.25毫克";

test("the reader text of a crawl post is the model's material for the post; an article's is what it was, and a post that says nothing has none", () => {
  const post = { platform: XHS_WORDS.platform, title: XHS_WORDS.title };
  const texts = { body_excerpt: XHS_WORDS.text, reader_tidy: null };
  const material = frontierReaderText(texts, null, post);
  assert.equal(material?.source, "excerpt");
  assert.doesNotMatch(String(material?.text), /\[话题\]|^男子用两种减肥药/);
  // Without the item, the same row reads as it always did (a translation, a tidy check and the other readers pass no post).
  assert.match(String(frontierReaderText(texts)?.text), /^男子用两种减肥药两个月减重40斤后突发脑梗 200斤男子/);
  assert.equal(frontierReaderText({ body_excerpt: XHS_TAGS.text }, null, { platform: "xiaohongshu", title: XHS_TAGS.title }), null);
  const pictured = frontierReaderText({ body_excerpt: XHS_TAGS.text, picture_text: POSTER_WORDS_FOR_TEST }, null, { platform: "xiaohongshu", title: XHS_TAGS.title });
  assert.equal(pictured?.source, "excerpt");
  assert.match(String(pictured?.text), /图片中的文字：\n司美格鲁肽/);
  // A platform that is not a crawl platform is not read as a post, even with a post-shaped text.
  assert.match(String(frontierReaderText({ body_excerpt: XHS_TAGS.text }, null, { platform: "wechat", title: XHS_TAGS.title })?.text), /^目录外罕见病新药拟纳入市场独占期保护 #罕见病\[话题\]#/);
});

test("the writer is shown a post as a post, with its words and the words of its pictures; its rules say the matter, never the message", () => {
  const input = buildLeadInput({ sourceName: "小红书（社媒监测）", titleRaw: XHS_WORDS.title, text: "正文。\n\n图片中的文字：\n每周一次", kind: "excerpt", post: true, genre: "social" });
  assert.match(input, /\n正文（帖子）：\n正文。/);
  for (const genre of ["social", "paper", null]) {
    const rules = frontierLeadInstructions(genre);
    assert.match(rules, /写这件事本身，不写这条消息本身/);
    assert.match(rules, /图片中的文字/);
    assert.match(rules, /\{"lead_zh":""\}/);
  }
  assert.match(frontierLeadInstructions("social"), /发帖者称/);
});

test("the pictures lever is read, forwarded to the container and written in the example environment", async () => {
  /** @param {Record<string, string>} env */
  const configUnder = (env) => {
    const saved = process.env;
    process.env = { ...env };
    try { return loadConfig({ rootDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..") }); } finally { process.env = saved; }
  };
  assert.equal(configUnder({}).frontierPostPicturesEnabled, true);
  assert.equal(configUnder({ OPEN_SCIENCE_FRONTIER_POST_PICTURES_ENABLED: "false" }).frontierPostPicturesEnabled, false);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  assert.match(compose, /\n\s+OPEN_SCIENCE_FRONTIER_POST_PICTURES_ENABLED:\n/);
  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  assert.match(example, /\nOPEN_SCIENCE_FRONTIER_POST_PICTURES_ENABLED=true\n/);
});

test("a long caption is information and a short headline is not: the post whose title says something by itself is shown, with no body", () => {
  const statement = "钟南山：国际主流认可的“慢阻肺无症状就不用管” 是错误的，用证据让全世界服气！";
  const shown = frontierPostReading({ title: statement, texts: { body_excerpt: `${statement} ${statement}` } });
  assert.deepEqual([shown.readable, shown.waiting, shown.says], [true, false, false]);
  const headline = "慢性阻塞性肺疾病诊治指南2026";
  assert.deepEqual(Object.values((({ readable, waiting }) => ({ readable, waiting }))(frontierPostReading({ title: headline, texts: { body_excerpt: `${headline} ${headline}` } }))), [false, false]);
  const tagged = "这2种降压药被查出致癌，快看看家里的药箱！ #降压药 #高血压 #神经内科 #抖出健康知识宝藏 #降压药的副作用";
  assert.equal(frontierPostReading({ title: tagged, texts: { body_excerpt: tagged } }).readable, false, "its tags do not count towards a caption");
});
