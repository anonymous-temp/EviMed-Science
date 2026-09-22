/**
 * The frontier feed's editor (「前沿动态」 初筛与导读, plan §6.3, §10.3.5–10.3.7).
 *
 * Two model steps, both language judgement (principle 1), and one check that
 * is not:
 *
 * - `screen(batch)` — up to twenty entries in one call: is it medical (or
 *   medical AI), is it news, which lane, which specialties, which language.
 * - `edit(item)` — one call per item: the Chinese title, a two-to-three
 *   sentence summary, why it is worth reading, lane, specialties, evidence
 *   type, entities, three scores.
 * - the verification of what `edit` wrote — numbers (`frontierNumbers.mjs`),
 *   vocabularies, lengths, links, Chinese prose, entity caps — is code. A
 *   failed verification is sent back once with the specific issues; a second
 *   failure keeps the title (if it passed on its own) and drops the summary
 *   and the reason. Nothing is softened (principle 5).
 *
 * Hidden knowledge:
 *
 * - **A long, byte-stable prefix and the item last.** The provider bills a
 *   cached prompt prefix at a fiftieth of an uncached one; the instructions and
 *   the four vocabularies come first and never change between calls, the item
 *   (with only the glossary entries its own text contains) comes last, so each
 *   call pays full price only for the item (plan §10.3.6).
 * - **Every call is metered** through `callModelForControlPlane` under the
 *   purpose `frontier`, charged to the operator's internal `evimed-frontier`
 *   project, thinking off, JSON mode, temperature 0, an explicit `max_tokens`
 *   (without it the gateway reserves 65,536 output tokens — about ¥0.52 for a
 *   call that costs ¥0.004), and its own timeout (the gateway has none). The
 *   per-account spend caps do not apply (`limits` 0): the module's own daily
 *   budget governs, in the pipeline.
 * - **What the model was shown is kept.** `edit` returns the exact item text
 *   it sent (`modelInput`) with its SHA-256; the pipeline stores both in
 *   `item_texts`, so any published summary can be checked again later against
 *   the text it was written from.
 * - **The editor holds no state about items.** It never reads or writes the
 *   database; the pipeline decides what is edited, when, and what a result
 *   means for the item.
 *
 * Deletable when the provider offers a structured-output mode with enforced
 * enums and a quotation mode for numbers; the verification would then shrink
 * to the length and prose checks.
 *
 * @module frontierEditor
 */

import { createHash } from "node:crypto";
import {
  FRONTIER_EVIDENCE_TYPES,
  FRONTIER_EVIDENCE_TYPE_LABELS_ZH,
  FRONTIER_ITEM_FLAGS,
  FRONTIER_LANES,
  FRONTIER_LANE_LABELS_ZH,
  FRONTIER_MAX_SPECIALTIES,
  FRONTIER_MODEL_FLAGS,
  FRONTIER_SCORE_MAXIMA,
  FRONTIER_SPECIALTIES,
  FRONTIER_SPECIALTY_LABELS_ZH,
} from "@evimed/domain";
import { checkNumbers } from "./frontierNumbers.mjs";
import { callModelForControlPlane } from "./modelGateway.mjs";

/** Entries per screening call (plan §10.3.5). */
export const FRONTIER_SCREEN_BATCH = 20;
/** Characters of an entry's text a screening call sees. */
export const FRONTIER_SCREEN_EXCERPT_CHARS = 300;
/** The most characters of source text one edit call carries (plan §10.3.2: about 6,000). */
export const FRONTIER_MODEL_INPUT_CHARS = 6_000;

/**
 * What a verified field may be, in code points. The prompt asks for less
 * (title 40, summary 140, reason 50) so an answer near the request passes;
 * the database allows more (200 / 600 / 200).
 */
export const FRONTIER_TEXT_LIMITS = Object.freeze({ title: 60, summary: 160, reason: 80, entitiesPerKind: 5, entityChars: 60 });

const SCREEN_TIMEOUT_MS = 60_000;
const EDIT_TIMEOUT_MS = 45_000;
// Twenty verdicts of about sixty tokens each, with room for a fence or a
// stray sentence; one edit answer is about 350 tokens.
const SCREEN_MAX_TOKENS = 3_000;
const EDIT_MAX_TOKENS = 1_500;

const LANE_LINE = FRONTIER_LANES.map((lane) => `${lane} ${FRONTIER_LANE_LABELS_ZH[lane]}`).join("；");
const SPECIALTY_LINE = FRONTIER_SPECIALTIES.map((key) => `${key} ${FRONTIER_SPECIALTY_LABELS_ZH[key]}`).join("；");
const EVIDENCE_LINE = FRONTIER_EVIDENCE_TYPES.map((key) => `${key} ${FRONTIER_EVIDENCE_TYPE_LABELS_ZH[key]}`).join("；");

/** The screening instructions: the stable prefix of every screening call. */
export const FRONTIER_SCREEN_INSTRUCTIONS = [
  "你是 EviMed「前沿动态」的初筛编辑。读者是国内的临床医生、药师和医学研究者。",
  "你会收到一批条目，每条只有标题、来源名和开头的一段文字。请逐条判断下面五件事，只输出 JSON。",
  "",
  "1. medical：这条是否与医学、药学、公共卫生、医学科研或医学相关的 AI 有关。与健康无关的商业、科技、体育、娱乐和一般时政填 false。",
  "2. news：这条是否是一条值得读者知道的新消息：新研究、新证据、新指南或共识、监管决定、安全警示、研发与产业进展、公共卫生动态、科研政策与基金、医学 AI 进展。以下一律填 false：勘误与更正声明、读者来信与回复、封面、目录、编委会、本期导读、招聘、广告、会议通知、征稿启事、讣告、活动预告、网站公告。",
  "3. lane：从该条目的 lanes 里选一个最合适的栏目；lanes 只有一个值时就填这个值。",
  "4. specialties：从专科词表里选 0 到 3 个最相关的专科，按相关程度排列；没有明确的专科就给空数组。",
  "5. language：条目文字的语言，中文填 \"zh\"，英文填 \"en\"，其他语言填 ISO 639-1 的两字母代码。",
  "",
  `栏目词表：${LANE_LINE}。`,
  `专科词表：${SPECIALTY_LINE}。`,
  "",
  "输出格式：{\"items\":[{\"id\":\"1\",\"medical\":true,\"news\":true,\"lane\":\"evidence\",\"specialties\":[\"cardiology\"],\"language\":\"en\"}]}",
  "items 的条数必须与收到的条目数相同；id 原样照抄，每个 id 恰好出现一次；只能使用词表里的英文键；不要输出任何解释。",
].join("\n");

/** The edit instructions: the stable prefix of every edit call. */
export const FRONTIER_EDIT_INSTRUCTIONS = [
  "你是 EviMed「前沿动态」的编辑。读者是国内的临床医生、药师和医学研究者。",
  "每次你会收到一条来自医学信源的新消息：来源、标题，以及原文摘要或正文节选。请用中文把这条消息讲清楚，给出分类和评分，只输出一个 JSON 对象。",
  "",
  "写作原则：",
  "1. 只写原文里有的事实，不补充原文没有的背景、结论和推测。",
  "2. 一切数量都用阿拉伯数字书写（例如 30%、2 倍、3.2 万、1,234 例），并且必须与原文的数字完全一致：不四舍五入，不换算，不自行计算差值、比例或合计；原文没有的数字，包括年份和日期，一个也不要写。",
  "3. 药物写中国通用名；「术语表」给出的译名必须照用；标为「保留原文」的名称、试验名称缩写、基因和蛋白符号保留原文。",
  "4. 写给医生看：说清楚这是什么、结果如何、意味着什么。AI 相关的消息说清它对临床或科研意味着什么，不写参数量、基准分数和接口价格。",
  "5. 企业新闻稿只有顶线结果、没有论文的，导读里说明数据尚未发表；预印本说明尚未经同行评议。",
  "6. 不出现链接或网址；不用感叹号和营销用语；不写「本文」「据悉」之类的套话。",
  "",
  "字段要求：",
  "- title_zh：中文标题，不超过 40 个字，陈述事实，不用问句。条目注明「中文信源：是」时，原样照抄标题。",
  "- summary_zh：两三句导读，不超过 140 个字，只写标题之外的内容。条目注明「正文：无」时给空字符串，不要复述标题。",
  "- reason_zh：一句话说明为什么值得看，不超过 50 个字。",
  "- lane：从条目的「允许的栏目」里选一个。",
  "- specialties：0 到 3 个专科键，按相关程度排列。",
  "- evidence_type：证据类型键。条目已注明证据类型的，照填。",
  "- entities：drugs（药物，中文通用名）、trials（试验名称，保留原文）、orgs（机构，中文简称）、diseases（疾病，中文规范名），每类最多 5 个，没有就给空数组。",
  "- scores：impact 实践或科研影响（0–30：会不会改变处方、指南、课题设计或必须执行的政策）；novelty 新颖性（0–20：首次报告或重要更新，还是重复已知）；relevance 与国内读者的相关性（0–20：药物在国内已上市或在审、国内疾病负担、国内政策与指南、国内研究者常用的方法）。都给整数。",
  "- flags：这是一篇只有顶线结果、没有论文的企业新闻稿时给 [\"press-release\"]，否则给 []。",
  "",
  `栏目词表：${LANE_LINE}。`,
  `证据类型词表：${EVIDENCE_LINE}。`,
  `专科词表：${SPECIALTY_LINE}。`,
  "",
  "输出格式（键名固定）：",
  "{\"title_zh\":\"\",\"summary_zh\":\"\",\"reason_zh\":\"\",\"lane\":\"\",\"specialties\":[],\"evidence_type\":\"\",\"entities\":{\"drugs\":[],\"trials\":[],\"orgs\":[],\"diseases\":[]},\"scores\":{\"impact\":0,\"novelty\":0,\"relevance\":0},\"flags\":[]}",
].join("\n");

/** The event digest's instructions (plan §6.4: 「先了解这件事」 and 「最新进展」). */
export const FRONTIER_DIGEST_INSTRUCTIONS = [
  "你是 EviMed「前沿动态」的事件编辑。读者是国内的临床医生、药师和医学研究者。",
  "你会收到同一件事的若干条报道（一手来源在前：论文、监管公告、说明书、指南原文），以及这件事上一版的综述（可能没有）。只输出一个 JSON 对象。",
  "",
  "写作原则：",
  "1. 只写报道里有的事实，不补充报道没有的背景、结论和推测。",
  "2. 一切数量都用阿拉伯数字书写，并且必须与报道里的数字完全一致：不四舍五入，不换算，不自行计算；报道没有的数字，包括年份和日期，一个也不要写。",
  "3. 一手来源与媒体报道说法不同时，以一手来源为准，并写明媒体报道的不同说法。",
  "4. 与上一版综述矛盾的地方，写成「（与此前说法不同：……）」。",
  "5. 不出现链接或网址；不用感叹号和营销用语。",
  "",
  "字段要求：",
  "- digest_zh：「先了解这件事」，三到五句的事实说明，不超过 280 个字。",
  "- latest_zh：「最新进展」，一句话说明最新一条报道带来了什么，不超过 60 个字。",
  "",
  "输出格式（键名固定）：{\"digest_zh\":\"\",\"latest_zh\":\"\"}",
].join("\n");

/** The daily issue's 「AI 一分钟」 instructions (plan §4.5, §6.4). */
export const FRONTIER_AI_MINUTE_INSTRUCTIONS = [
  "你是 EviMed「前沿动态」日报的编辑。读者是国内的临床医生、药师和医学研究者。",
  "你会收到过去一天「AI 与医学」栏目里已经写好导读的条目。请写「AI 一分钟」：用两到四句话告诉医生，这一天与医学相关的 AI 有什么值得知道的进展、对临床或科研意味着什么。只输出一个 JSON 对象。",
  "",
  "写作原则：",
  "1. 只写条目里有的事实；不写参数量、基准分数和接口价格。",
  "2. 一切数量都用阿拉伯数字书写，并且必须与条目里的数字完全一致；条目没有的数字一个也不要写。",
  "3. 不出现链接或网址；不用感叹号和营销用语。",
  "",
  "字段要求：ai_minute_zh，不超过 200 个字。",
  "输出格式（键名固定）：{\"ai_minute_zh\":\"\"}",
].join("\n");

/**
 * The same-event instructions (plan §6.4 clustering, step 3): the pairs the
 * vectors could not decide — cosine between 0.72 and 0.82 — are asked here.
 */
export const FRONTIER_SAME_EVENT_INSTRUCTIONS = [
  "你是 EviMed「前沿动态」的事件编辑。读者是国内的临床医生、药师和医学研究者。",
  "你会收到一条新报道和至多三条较早的报道。请逐条判断：较早的那条和新报道说的是不是同一件事。只输出 JSON。",
  "",
  "判断标准：",
  "1. yes：同一件事——同一项研究或试验的结果、同一个监管决定或安全警示、同一份指南、同一次发布。对同一件事的原始论文、官方公告和媒体报道都算同一件事，报道的角度和语言不同不影响判断。",
  "2. related：不是同一件事，但有直接的先后或因果关系——同一药物的安全信号与后来的说明书修订、预印本与正式发表的论文、试验结果与据此作出的监管审批、一项研究与专门评论它的文章。",
  "3. no：只是话题相近（同一种药、同一种病、同一个机构）而说的是不同的事，或者无法确定是同一件事。",
  "拿不准时填 no：把两件不同的事并在一起，比把一件事分成两处更糟。",
  "",
  "输出格式：{\"items\":[{\"id\":\"1\",\"verdict\":\"yes\"}]}",
  "items 的条数必须与较早报道的条数相同；id 原样照抄，每个 id 恰好出现一次；verdict 只能是 yes、related、no；不要输出任何解释。",
].join("\n");

/**
 * The profile instructions (plan §6.5, §10.5.3): a researcher's own stated or
 * confirmed memories become specialties and interest phrases, each phrase
 * naming the memory it came from — the 「因为你在做……」 a reader sees.
 */
export const FRONTIER_PROFILE_INSTRUCTIONS = [
  "你是 EviMed「前沿动态」的个性化编辑。你会收到一位医学研究者自己说过或确认过的记忆，每条有一个 id。",
  "请从中提取两样东西，用来从每天的医学新消息里挑出和这位研究者相关的条目。只输出 JSON。",
  "",
  "1. specialties：这位研究者从事或关注的专科，从专科词表里选，按相关程度排列；记忆里看不出来就给空数组，不要猜。",
  "2. phrases：至多 10 条兴趣短语。每条是一个具体的研究方向、在做的课题、关注的药物或疾病，写成 4 到 30 个字的名词短语，例如「SGLT2 抑制剂与心衰的 Meta 分析」「GLP-1 受体激动剂的减重研究」。每条都必须用 memory_id 注明它来自哪一条记忆。",
  "",
  "原则：",
  "1. 只写记忆里明确写着的内容，不补充、不推测、不合并两条记忆。",
  "2. 工作习惯、写作偏好、格式要求这类与研究内容无关的记忆不产生短语。",
  "3. 不写人名、联系方式等个人信息。",
  "4. 数字照记忆原文写；记忆里没有的数字一个也不要写。",
  "",
  `专科词表：${SPECIALTY_LINE}。`,
  "",
  "输出格式：{\"specialties\":[\"cardiology\"],\"phrases\":[{\"text\":\"\",\"memory_id\":\"\"}]}",
  "只能使用专科词表里的英文键；memory_id 原样照抄收到的 id；不要输出任何解释。",
].join("\n");

/**
 * The on-demand Chinese abstract (plan §10.3.6): the one model call on the
 * read path, made the first time a reader opens 「中文摘要」 and then shared.
 */
export const FRONTIER_ABSTRACT_INSTRUCTIONS = [
  "你是 EviMed「前沿动态」的医学编辑。读者是国内的临床医生、药师和医学研究者。",
  "你会收到一篇文献的标题和英文摘要。请把摘要完整、忠实地译成中文，只输出一个 JSON 对象。",
  "",
  "翻译原则：",
  "1. 逐句忠实：不增加原文没有的内容，不删减原文的方法、结果和结论，不加评论。",
  "2. 一切数量都用阿拉伯数字书写；数字、单位和统计量（HR、OR、95% CI、P 值）照原文写，不四舍五入，不换算，不自行计算。",
  "3. 药物写中国通用名；「术语表」给出的译名必须照用；标为「保留原文」的名称、试验名称缩写、基因和蛋白符号保留原文。",
  "4. 原文分段（背景、方法、结果、结论）的，译文照样分段，段与段之间换行。",
  "5. 不出现链接或网址。",
  "",
  "输出格式（键名固定）：{\"abstract_zh\":\"\"}",
].join("\n");

/** Which prompts and vocabularies wrote an item's Chinese fields (`items.editor_version`). */
export const FRONTIER_EDITOR_VERSION = `frontier-editor-1.${createHash("sha256")
  .update(`${FRONTIER_SCREEN_INSTRUCTIONS}\n${FRONTIER_EDIT_INSTRUCTIONS}\n${FRONTIER_DIGEST_INSTRUCTIONS}\n${FRONTIER_AI_MINUTE_INSTRUCTIONS}`)
  .digest("hex").slice(0, 12)}`;

/** What the event digest and the AI minute may be, in code points. */
export const FRONTIER_WRITING_LIMITS = Object.freeze({ digest: 320, latest: 80, aiMinute: 240 });
const DIGEST_MAX_TOKENS = 1_500;
const AI_MINUTE_MAX_TOKENS = 1_000;
const WRITING_TIMEOUT_MS = 60_000;
const WRITING_INPUT_CHARS = 9_000;

// The wave-two calls (plan §6.4, §6.5, §10.3.6). The three prompts above write
// no field `FRONTIER_EDITOR_VERSION` names, so they are not part of it: a
// change to them re-keys no item.
/** Earlier reports one same-event call weighs against a new one. */
export const FRONTIER_SAME_EVENT_CANDIDATES = 3;
/** One interest phrase, in code points; the prompt asks for 4 to 30. */
export const FRONTIER_PHRASE_LIMITS = Object.freeze({ min: 2, max: 40, phrases: 10, memories: 40, memoryChars: 300 });
/** The Chinese abstract, in code points; the source text it may be written from. */
export const FRONTIER_ABSTRACT_LIMITS = Object.freeze({ output: 1_600, input: 6_000 });
// Three verdicts of a dozen tokens; ten phrases of thirty characters; an
// abstract of about 1,600 Chinese characters.
const SAME_EVENT_MAX_TOKENS = 300;
const PROFILE_MAX_TOKENS = 1_000;
const ABSTRACT_MAX_TOKENS = 3_000;
const SAME_EVENT_TIMEOUT_MS = 45_000;
const PROFILE_TIMEOUT_MS = 45_000;
const ABSTRACT_TIMEOUT_MS = 90_000;
const SAME_EVENT_VERDICTS = Object.freeze(["yes", "related", "no"]);

// ───────────────────────── helpers ─────────────────────────

/** @param {string} text */
export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** @param {unknown} text */
function codePoints(text) {
  return [...String(text ?? "")].length;
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/gu;
const LATIN = /[A-Za-z]/g;

/**
 * Whether a text reads as Chinese: at least two Han characters, and Han
 * characters at least three tenths of its letters (a title full of drug
 * codes and trial names is still Chinese prose).
 * @param {unknown} text
 */
export function isChineseProse(text) {
  const value = String(text ?? "");
  const han = value.match(CJK)?.length ?? 0;
  const latin = value.match(LATIN)?.length ?? 0;
  return han >= 2 && han >= 0.3 * (han + latin);
}

/** Whether a title is a Chinese source's own (and so is not translated): Han
 *  characters, no kana, and Han at least half of its letters. @param {unknown} text */
export function isChineseTitle(text) {
  const value = String(text ?? "");
  if (/[\u3040-\u30ff]/u.test(value)) return false;
  const han = value.match(CJK)?.length ?? 0;
  const latin = value.match(LATIN)?.length ?? 0;
  return han >= 2 && han >= 0.5 * (han + latin);
}

const LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|org|net|gov|edu|cn|io|ai|int|info|co)\b/i;

/**
 * The model's JSON, wherever it put it: the whole content, a fenced block, or
 * the outermost object inside prose (a model that reasons anyway writes its
 * answer after its thoughts).
 * @param {unknown} content @returns {any}
 */
export function parseModelJson(content) {
  if (typeof content !== "string" || !content.trim()) return null;
  const raw = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  for (const candidate of [raw, raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* try the next reading */ }
  }
  return null;
}

/** @param {unknown} error */
function errorCode(error) {
  const value = /** @type {any} */ (error);
  if (value?.name === "AbortError") return "frontier_model_timeout";
  return typeof value?.code === "string" ? value.code : "frontier_model_failed";
}

/** An ISO date (UTC) for the prompt, or null. @param {unknown} value */
function isoDay(value) {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

/** @param {unknown} value @param {number} max */
function clip(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ───────────────────────── the item text ─────────────────────────

/**
 * @typedef {object} FrontierEditItem
 * @property {string} titleRaw
 * @property {string} sourceName
 * @property {string} [sourceTypeLabel]
 * @property {string | null} [publishedAt]
 * @property {string} [datePrecision]
 * @property {boolean} isChinese         a Chinese source's own title: not translated
 * @property {string[]} allowedLanes      the lanes the source allows (all eight for a mixed source)
 * @property {{ type: string, basis: string } | null} [evidenceFixed]  decided by code (PubMed types, the registry)
 * @property {string | null} [abstract]
 * @property {string | null} [summary]    the feed's own summary when there is no abstract
 * @property {string | null} [bodyExcerpt]
 * @property {string | null} [journal]
 * @property {string[]} [publicationTypes]
 * @property {{ phase?: string, status?: string, enrollment?: number, sponsor?: string } | null} [trialFacts]
 * @property {Array<{ kind: string, termEn: string, termZh: string, keepOriginal: boolean }>} [glossary]
 * @property {{ lane?: string | null, specialties?: string[] }} [defaults]  the screening verdict
 */

/**
 * Exactly what one edit call shows the model after the stable prefix, and so
 * exactly what its numbers are checked against. Plain labelled lines; the
 * source text last and bounded to about 6,000 characters.
 * @param {FrontierEditItem} item
 * @returns {string}
 */
export function buildModelInput(item) {
  const lanes = (item.allowedLanes?.length ? item.allowedLanes : FRONTIER_LANES)
    .map((lane) => `${lane}（${FRONTIER_LANE_LABELS_ZH[/** @type {keyof typeof FRONTIER_LANE_LABELS_ZH} */ (lane)] ?? lane}）`).join("、");
  const lines = [`允许的栏目：${lanes}`];
  if (item.evidenceFixed?.type) {
    lines.push(`证据类型：${item.evidenceFixed.type}（已由程序确定，照填）`);
  }
  lines.push(`中文信源：${item.isChinese ? "是（title_zh 原样照抄标题）" : "否"}`);
  const glossary = (item.glossary ?? []).map((entry) => (entry.keepOriginal
    ? `- ${entry.termEn}：保留原文`
    : `- ${entry.termEn} → ${entry.termZh}`));
  if (glossary.length) lines.push("术语表（本条原文里出现的词，译名必须照用）：", ...glossary);
  lines.push(`来源：${clip(item.sourceName, 120)}${item.sourceTypeLabel ? `（${item.sourceTypeLabel}）` : ""}`);
  const day = item.datePrecision === "inferred" ? null : isoDay(item.publishedAt);
  if (day) lines.push(`发布日期：${day}`);
  if (item.journal) lines.push(`期刊：${clip(item.journal, 200)}`);
  if (item.publicationTypes?.length) lines.push(`文献类型：${clip(item.publicationTypes.join("; "), 300)}`);
  const trial = item.trialFacts;
  if (trial && typeof trial === "object") {
    const facts = [
      trial.phase ? `分期 ${clip(trial.phase, 40)}` : "",
      trial.status ? `状态 ${clip(trial.status, 40)}` : "",
      Number.isSafeInteger(trial.enrollment) ? `入组 ${trial.enrollment}` : "",
      trial.sponsor ? `申办方 ${clip(trial.sponsor, 120)}` : "",
    ].filter(Boolean);
    if (facts.length) lines.push(`试验信息：${facts.join("；")}`);
  }
  lines.push(`标题：${clip(item.titleRaw, 1000)}`);
  const head = lines.join("\n");
  let room = Math.max(0, FRONTIER_MODEL_INPUT_CHARS - head.length);
  const body = [];
  const main = item.abstract || item.summary;
  if (main) {
    const text = clip(main, Math.min(room, 4_500));
    body.push(`${item.abstract ? "摘要" : "原文摘要"}：${text}`);
    room -= text.length;
  }
  if (item.bodyExcerpt && room > 200) body.push(`正文节选：${clip(item.bodyExcerpt, room)}`);
  // Said outright, so a title is not restated as a summary: on the first live
  // run (2026-09-22) every text-less notice came back with a summary that was
  // its own title again.
  if (!body.length) body.push("正文：无");
  return [head, ...body].join("\n");
}

// ───────────────────────── verification ─────────────────────────

/**
 * @typedef {{ titleZh: string | null, summaryZh: string | null, reasonZh: string | null, lane: string | null,
 *             specialties: string[], evidenceType: string | null,
 *             entities: { drugs: string[], trials: string[], orgs: string[], diseases: string[] },
 *             scores: { impact: number, novelty: number, relevance: number } | null, flags: string[] }} FrontierEditOutput
 */

/**
 * What one edit answer says, checked field by field. `issues` are the
 * specific problems in Chinese, for the rewrite and the log; `failed` names
 * the fields that failed, so a second failure can keep what passed.
 * @param {any} answer the model's parsed JSON (or null)
 * @param {FrontierEditItem} item
 * @param {string} modelInput
 * @returns {{ output: FrontierEditOutput, issues: string[], failed: Set<string>,
 *             numbers: { checked: number, missing: Array<{ field: string, raw: string }>, unitMismatches: Array<{ field: string, raw: string }> } }}
 */
export function verifyEdit(answer, item, modelInput) {
  /** @type {string[]} */
  const issues = [];
  /** @type {Set<string>} */
  const failed = new Set();
  /** @param {string} field @param {string} issue */
  const fail = (field, issue) => { failed.add(field); issues.push(issue); };
  const value = answer && typeof answer === "object" ? answer : {};
  if (!answer) fail("answer", "没有读到 JSON 对象，请只输出一个 JSON 对象。");

  /** @param {"title_zh" | "summary_zh" | "reason_zh"} field @param {number} limit @param {boolean} [optional] */
  const prose = (field, limit, optional = false) => {
    const text = typeof value[field] === "string" ? value[field].replace(/\s+/g, " ").trim() : "";
    if (!text) { if (!optional) fail(field, `${field} 不能为空。`); return null; }
    if (codePoints(text) > limit) fail(field, `${field} 太长：不能超过 ${limit} 个字。`);
    if (LINK.test(text)) fail(field, `${field} 里不能出现链接或网址。`);
    if (!isChineseProse(text)) fail(field, `${field} 要用中文写。`);
    return text;
  };
  const titleZh = item.isChinese ? String(item.titleRaw ?? "").trim().slice(0, 200) : prose("title_zh", FRONTIER_TEXT_LIMITS.title);
  // An item with nothing but its title has nothing to summarise (「正文：无」).
  const summaryZh = prose("summary_zh", FRONTIER_TEXT_LIMITS.summary, !(item.abstract || item.summary || item.bodyExcerpt));
  const reasonZh = prose("reason_zh", FRONTIER_TEXT_LIMITS.reason);

  const numbers = checkNumbers({
    ...(item.isChinese ? {} : { title_zh: titleZh ?? "" }),
    summary_zh: summaryZh ?? "",
    reason_zh: reasonZh ?? "",
  }, modelInput);
  for (const { field, raw } of numbers.missing) {
    fail(field, `${field} 里的数字「${raw}」在原文里找不到相等的数字：只能使用原文出现过的数字，找不到就删去这个数字。`);
  }

  const allowed = item.allowedLanes?.length ? item.allowedLanes : [...FRONTIER_LANES];
  const lane = typeof value.lane === "string" && allowed.includes(value.lane) ? value.lane : null;
  if (!lane) fail("lane", `lane 必须是以下之一：${allowed.join("、")}。`);

  /** @type {string[]} */
  let specialties = [];
  if (!Array.isArray(value.specialties) || value.specialties.some((key) => !FRONTIER_SPECIALTIES.includes(key))) {
    fail("specialties", "specialties 只能使用专科词表里的键。");
  } else {
    // Ordered by relevance; a fourth is a format slip, not a claim — the three
    // most relevant are kept.
    specialties = [...new Set(/** @type {string[]} */ (value.specialties))].slice(0, FRONTIER_MAX_SPECIALTIES);
  }

  let evidenceType = item.evidenceFixed?.type ?? null;
  if (!evidenceType) {
    if (typeof value.evidence_type === "string" && FRONTIER_EVIDENCE_TYPES.includes(/** @type {any} */ (value.evidence_type))) {
      evidenceType = value.evidence_type;
    } else fail("evidence_type", "evidence_type 只能使用证据类型词表里的键。");
  }

  const entities = { drugs: /** @type {string[]} */ ([]), trials: /** @type {string[]} */ ([]), orgs: /** @type {string[]} */ ([]), diseases: /** @type {string[]} */ ([]) };
  const rawEntities = value.entities && typeof value.entities === "object" ? value.entities : null;
  if (!rawEntities) fail("entities", "entities 必须是含 drugs、trials、orgs、diseases 四个数组的对象。");
  for (const kind of /** @type {Array<keyof typeof entities>} */ (["drugs", "trials", "orgs", "diseases"])) {
    const list = rawEntities?.[kind] ?? [];
    if (!Array.isArray(list) || list.some((name) => typeof name !== "string" || !name.trim() || codePoints(name) > FRONTIER_TEXT_LIMITS.entityChars)) {
      fail("entities", `entities.${kind} 必须是不超过 ${FRONTIER_TEXT_LIMITS.entityChars} 个字的名称数组。`);
      continue;
    }
    if (list.length > FRONTIER_TEXT_LIMITS.entitiesPerKind) {
      fail("entities", `entities.${kind} 最多 ${FRONTIER_TEXT_LIMITS.entitiesPerKind} 个。`);
      continue;
    }
    entities[kind] = [...new Set(list.map((name) => name.replace(/\s+/g, " ").trim()))];
  }

  /** @type {{ impact: number, novelty: number, relevance: number } | null} */
  let scores = null;
  const rawScores = value.scores && typeof value.scores === "object" ? value.scores : {};
  const score = (/** @type {"impact" | "novelty" | "relevance"} */ dimension) => {
    const number = rawScores[dimension];
    const max = FRONTIER_SCORE_MAXIMA[dimension];
    if (!Number.isInteger(number) || number < 0 || number > max) {
      fail("scores", `scores.${dimension} 必须是 0 到 ${max} 的整数。`);
      return null;
    }
    return number;
  };
  const impact = score("impact");
  const novelty = score("novelty");
  const relevance = score("relevance");
  if (impact !== null && novelty !== null && relevance !== null) scores = { impact, novelty, relevance };

  /** @type {string[]} */
  let flags = [];
  if (value.flags !== undefined && (!Array.isArray(value.flags) || value.flags.some((flag) => !FRONTIER_ITEM_FLAGS.includes(flag)))) {
    fail("flags", "flags 只能是 [] 或 [\"press-release\"]。");
  } else {
    // A flag code decides (preprint, no-abstract, …) proposed by the model is
    // not the model's to set; it is dropped, not failed.
    flags = [...new Set(/** @type {string[]} */ (value.flags ?? []))].filter((flag) => FRONTIER_MODEL_FLAGS.includes(/** @type {any} */ (flag)));
  }

  return {
    output: { titleZh, summaryZh, reasonZh, lane, specialties, evidenceType, entities, scores, flags },
    issues,
    failed,
    numbers,
  };
}

// ───────────────────────── the editor ─────────────────────────

/**
 * @typedef {{ key: string, title: string, sourceName: string, excerpt?: string | null, allowedLanes: string[] }} ScreenInput
 * @typedef {{ medical: boolean, news: boolean, lane: string, specialties: string[], language: string }} ScreenVerdict
 * @typedef {{ verification: "passed" | "repaired" | "title-only" | "pending", output: FrontierEditOutput | null,
 *             modelInput: string, modelInputSha256: string, attempts: number, issues: string[],
 *             numbers: { checked: number, missing: Array<{ field: string, raw: string }>, unitMismatches: Array<{ field: string, raw: string }> } | null,
 *             error: string | null, model: string, editorVersion: string }} FrontierEditResult
 */

/**
 * Screening verdicts from one answer, or null when the answer is not one
 * verdict per entry sent, each in the vocabularies.
 * @param {ScreenInput[]} batch @param {any} answer
 * @returns {Map<string, ScreenVerdict> | null}
 */
export function validateScreen(batch, answer) {
  const items = Array.isArray(answer?.items) ? answer.items : null;
  if (!items || items.length !== batch.length) return null;
  /** @type {Map<string, ScreenVerdict>} */
  const verdicts = new Map();
  for (const entry of items) {
    const id = typeof entry?.id === "number" ? String(entry.id) : entry?.id;
    const index = typeof id === "string" && /^\d{1,3}$/.test(id) ? Number(id) - 1 : -1;
    const input = batch[index];
    if (!input || verdicts.has(input.key)) return null;
    if (typeof entry.medical !== "boolean" || typeof entry.news !== "boolean") return null;
    if (typeof entry.lane !== "string" || !input.allowedLanes.includes(entry.lane)) return null;
    if (!Array.isArray(entry.specialties) || entry.specialties.some((/** @type {unknown} */ key) => !FRONTIER_SPECIALTIES.includes(/** @type {any} */ (key)))) return null;
    const language = typeof entry.language === "string" ? entry.language.trim().toLowerCase() : "";
    if (!/^([a-z]{2,3}|und)$/.test(language)) return null;
    verdicts.set(input.key, {
      medical: entry.medical, news: entry.news, lane: entry.lane,
      specialties: [...new Set(/** @type {string[]} */ (entry.specialties))].slice(0, FRONTIER_MAX_SPECIALTIES),
      language,
    });
  }
  return verdicts.size === batch.length ? verdicts : null;
}

/**
 * @typedef {{ role?: "primary" | "report" | "background", sourceName: string, sourceTypeLabel?: string | null,
 *             publishedAt?: string | null, titleRaw: string, titleZh?: string | null, summaryZh?: string | null,
 *             text?: string | null }} FrontierEventReport
 */

/**
 * Exactly what the digest call shows the model: the previous digest, then the
 * reports, primary sources first, each bounded; about 9,000 characters.
 * @param {{ reports: FrontierEventReport[], previousDigest?: string | null }} event
 */
export function buildDigestInput({ reports, previousDigest = null }) {
  const ordered = [...reports].sort((left, right) => Number(right.role === "primary") - Number(left.role === "primary")
    || String(left.publishedAt ?? "").localeCompare(String(right.publishedAt ?? "")));
  const lines = [`上一版综述：${previousDigest ? clip(previousDigest, 600) : "无"}`, "报道（一手来源在前）："];
  let room = WRITING_INPUT_CHARS - lines.join("\n").length;
  for (const [index, report] of ordered.slice(0, 12).entries()) {
    const block = [
      `[${index + 1}] ${report.role === "primary" ? "一手来源" : "报道"}｜${clip(report.sourceName, 80)}${report.sourceTypeLabel ? `（${report.sourceTypeLabel}）` : ""}${isoDay(report.publishedAt) ? `｜${isoDay(report.publishedAt)}` : ""}`,
      `标题：${clip(report.titleRaw, 300)}`,
      report.titleZh ? `中文标题：${clip(report.titleZh, 120)}` : "",
      report.summaryZh ? `导读：${clip(report.summaryZh, 300)}` : "",
      report.text ? `原文：${clip(report.text, 1_500)}` : "",
    ].filter(Boolean).join("\n");
    if (block.length > room) break;
    lines.push(block);
    room -= block.length + 1;
  }
  return lines.join("\n");
}

/**
 * Exactly what the AI-minute call shows the model: the day's AI-lane items
 * with their verified Chinese fields.
 * @param {{ day: string, items: Array<{ titleRaw: string, titleZh?: string | null, summaryZh?: string | null, sourceName: string }> }} input
 */
export function buildAiMinuteInput({ day, items }) {
  const lines = [`日期：${String(day ?? "").slice(0, 10)}`, "条目："];
  let room = WRITING_INPUT_CHARS - lines.join("\n").length;
  for (const [index, item] of items.slice(0, 20).entries()) {
    const block = [`[${index + 1}] ${clip(item.sourceName, 80)}｜${clip(item.titleZh || item.titleRaw, 160)}`, item.summaryZh ? `导读：${clip(item.summaryZh, 300)}` : ""]
      .filter(Boolean).join("\n");
    if (block.length > room) break;
    lines.push(block);
    room -= block.length + 1;
  }
  return lines.join("\n");
}

/**
 * The prose checks an event digest or an AI minute gets: present, bounded,
 * Chinese, no links, every number in its input.
 * @param {any} answer @param {Record<string, number>} fields field → limit @param {string} input
 */
export function verifyWriting(answer, fields, input) {
  /** @type {string[]} */
  const issues = [];
  /** @type {Record<string, string | null>} */
  const output = {};
  if (!answer) issues.push("没有读到 JSON 对象，请只输出一个 JSON 对象。");
  for (const [field, limit] of Object.entries(fields)) {
    const text = typeof answer?.[field] === "string" ? answer[field].replace(/\s+/g, " ").trim() : "";
    output[field] = text || null;
    if (!text) { issues.push(`${field} 不能为空。`); continue; }
    if (codePoints(text) > limit) issues.push(`${field} 太长：不能超过 ${limit} 个字。`);
    if (LINK.test(text)) issues.push(`${field} 里不能出现链接或网址。`);
    if (!isChineseProse(text)) issues.push(`${field} 要用中文写。`);
  }
  const numbers = checkNumbers(Object.fromEntries(Object.entries(output).map(([field, text]) => [field, text ?? ""])), input);
  for (const { field, raw } of numbers.missing) {
    issues.push(`${field} 里的数字「${raw}」在报道里找不到相等的数字：只能使用报道里出现过的数字，找不到就删去这个数字。`);
  }
  return { output, issues, numbers };
}

// ───────────────────────── wave two: events, profiles, abstracts ─────────────────────────

/**
 * @typedef {{ sourceName: string, titleRaw: string, titleZh?: string | null, summaryZh?: string | null,
 *             publishedAt?: string | null }} FrontierSameEventReport
 */

/** @param {FrontierSameEventReport} report */
function reportForModel(report) {
  const day = isoDay(report?.publishedAt);
  return {
    source: clip(report?.sourceName, 120),
    ...(day ? { date: day } : {}),
    title: clip(report?.titleRaw, 300),
    ...(report?.titleZh && report.titleZh !== report.titleRaw ? { title_zh: clip(report.titleZh, 120) } : {}),
    ...(report?.summaryZh ? { summary: clip(report.summaryZh, 300) } : {}),
  };
}

/**
 * Exactly what one same-event call shows the model after the stable prefix:
 * the new report, then the earlier ones numbered from 1.
 * @param {{ report: FrontierSameEventReport, candidates: FrontierSameEventReport[] }} input
 */
export function buildSameEventInput({ report, candidates }) {
  return JSON.stringify({
    new: reportForModel(report),
    earlier: candidates.slice(0, FRONTIER_SAME_EVENT_CANDIDATES).map((candidate, index) => ({ id: String(index + 1), ...reportForModel(candidate) })),
  });
}

/**
 * One verdict per earlier report, or null when the answer is not exactly that.
 * @param {number} count how many earlier reports were sent @param {any} answer
 * @returns {Array<"yes" | "related" | "no"> | null} in the order they were sent
 */
export function validateSameEvent(count, answer) {
  const items = Array.isArray(answer?.items) ? answer.items : null;
  if (!items || items.length !== count) return null;
  /** @type {Array<"yes" | "related" | "no">} */
  const verdicts = new Array(count);
  for (const entry of items) {
    const id = typeof entry?.id === "number" ? String(entry.id) : entry?.id;
    const index = typeof id === "string" && /^\d{1,2}$/.test(id) ? Number(id) - 1 : -1;
    const verdict = typeof entry?.verdict === "string" ? entry.verdict.trim().toLowerCase() : "";
    if (index < 0 || index >= count || verdicts[index] || !SAME_EVENT_VERDICTS.includes(verdict)) return null;
    verdicts[index] = /** @type {"yes" | "related" | "no"} */ (verdict);
  }
  return verdicts.every(Boolean) ? verdicts : null;
}

/**
 * @typedef {{ id: string, kind: string, text: string }} FrontierProfileMemory
 * @typedef {{ text: string, memoryId: string }} FrontierProfilePhrase
 */

/**
 * Exactly what one profile call shows the model: the memories, each with its
 * id, kind and at most 300 characters of its own words.
 * @param {{ memories: FrontierProfileMemory[] }} input
 */
export function buildProfileInput({ memories }) {
  return JSON.stringify({
    memories: memories.slice(0, FRONTIER_PHRASE_LIMITS.memories)
      .map((memory) => ({ id: memory.id, kind: memory.kind, text: clip(memory.text, FRONTIER_PHRASE_LIMITS.memoryChars) })),
  });
}

/**
 * What one profile answer says, checked piece by piece. A specialty outside
 * the vocabulary and a phrase that fails its checks — no memory it names, a
 * link, a length out of bounds, a number its memory does not state — are
 * dropped one by one and listed in `dropped`; the rest stands. Null when the
 * answer is not the shape at all (the caller asks once more).
 * @param {any} answer @param {FrontierProfileMemory[]} memories
 * @returns {{ specialties: string[], phrases: FrontierProfilePhrase[], dropped: Array<{ text: string, reason: string }> } | null}
 */
export function verifyProfile(answer, memories) {
  if (!answer || typeof answer !== "object" || !Array.isArray(answer.specialties) || !Array.isArray(answer.phrases)) return null;
  const known = new Map(memories.map((memory) => [memory.id, memory]));
  const specialties = [...new Set(answer.specialties.filter((key) => FRONTIER_SPECIALTIES.includes(key)))];
  /** @type {FrontierProfilePhrase[]} */
  const phrases = [];
  /** @type {Array<{ text: string, reason: string }>} */
  const dropped = [];
  const seen = new Set();
  for (const entry of answer.phrases) {
    const text = typeof entry?.text === "string" ? entry.text.replace(/\s+/g, " ").trim() : "";
    const memoryId = typeof entry?.memory_id === "string" ? entry.memory_id.trim() : typeof entry?.memoryId === "string" ? entry.memoryId.trim() : "";
    const memory = known.get(memoryId);
    const reason = !text ? "empty"
      : codePoints(text) < FRONTIER_PHRASE_LIMITS.min || codePoints(text) > FRONTIER_PHRASE_LIMITS.max ? "length"
        : LINK.test(text) ? "link"
          : !memory ? "unknown-memory"
            : checkNumbers({ text }, memory.text).missing.length ? "number"
              : seen.has(text.toLowerCase()) ? "duplicate" : null;
    if (reason) { dropped.push({ text: clip(text, 60), reason }); continue; }
    seen.add(text.toLowerCase());
    phrases.push({ text, memoryId });
    if (phrases.length >= FRONTIER_PHRASE_LIMITS.phrases) break;
  }
  return { specialties, phrases, dropped };
}

/**
 * Exactly what the abstract call shows the model: the title, the glossary
 * entries its own text contains, the abstract last, bounded to 6,000
 * characters — and so exactly what its numbers are checked against.
 * @param {{ titleRaw: string, abstract: string, glossary?: Array<{ termEn: string, termZh: string, keepOriginal: boolean }> }} input
 */
export function buildAbstractInput({ titleRaw, abstract, glossary = [] }) {
  const lines = [`标题：${clip(titleRaw, 600)}`];
  const terms = glossary.map((entry) => (entry.keepOriginal ? `- ${entry.termEn}：保留原文` : `- ${entry.termEn} → ${entry.termZh}`));
  if (terms.length) lines.push("术语表（本篇原文里出现的词，译名必须照用）：", ...terms);
  const head = lines.join("\n");
  // Paragraph breaks are the abstract's structure; only runs of spaces fold.
  const body = String(abstract ?? "").replace(/[ \t\f\v]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const room = Math.max(500, FRONTIER_ABSTRACT_LIMITS.input - head.length);
  return `${head}\n摘要：${body.length > room ? `${body.slice(0, room)}…` : body}`;
}

/**
 * The checks a Chinese abstract gets — those of every other piece of prose
 * (present, bounded, Chinese, no links, every number in its input) — with its
 * paragraph breaks kept, because they are the abstract's structure.
 * @param {any} answer @param {string} input
 */
export function verifyAbstract(answer, input) {
  /** @type {string[]} */
  const issues = [];
  if (!answer) issues.push("没有读到 JSON 对象，请只输出一个 JSON 对象。");
  const raw = typeof answer?.abstract_zh === "string" ? answer.abstract_zh : "";
  const text = raw.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  if (!text) issues.push("abstract_zh 不能为空。");
  else {
    if (codePoints(text) > FRONTIER_ABSTRACT_LIMITS.output) issues.push(`abstract_zh 太长：不能超过 ${FRONTIER_ABSTRACT_LIMITS.output} 个字。`);
    if (LINK.test(text)) issues.push("abstract_zh 里不能出现链接或网址。");
    if (!isChineseProse(text)) issues.push("abstract_zh 要用中文写。");
  }
  const numbers = checkNumbers({ abstract_zh: text }, input);
  for (const { raw: number } of numbers.missing) {
    issues.push(`abstract_zh 里的数字「${number}」在原文里找不到相等的数字：数字只能照原文写，找不到就删去这个数字。`);
  }
  return { output: { abstract_zh: text || null }, issues, numbers };
}

export class FrontierEditor {
  /**
   * @param {Record<string, any>} config
   * @param {{ usageLedger?: any, owner?: { userId: string, projectId: string } | null,
   *           callModel?: typeof callModelForControlPlane, fetchImpl?: typeof fetch }} [options]
   *   `owner` is the operator account's internal `evimed-frontier` project;
   *   it may be assigned later (`editor.owner = …`), once the worker has
   *   created the project.
   */
  constructor(config, { usageLedger = null, owner = null, callModel = callModelForControlPlane, fetchImpl = globalThis.fetch } = {}) {
    this.config = config ?? {};
    this.usageLedger = usageLedger;
    /** @type {{ userId: string, projectId: string } | null} */
    this.owner = owner;
    this.callModel = callModel;
    this.fetchImpl = fetchImpl;
    this.model = String(this.config.frontierModel || "deepseek-flash");
    /** Observable counters (principle 15). */
    this.counters = {
      screenCalls: 0, screenRetries: 0, screenSingles: 0, screenFailures: 0,
      editCalls: 0, rewrites: 0, callFailures: 0,
      // Which checks a first answer failed, by field (plan §6.8: the first-pass
      // rate of the number check is a launch metric, and a rewrite is a second
      // paid call — the fields say which instruction to sharpen).
      firstPassFailures: /** @type {Record<string, number>} */ ({}),
      verification: { passed: 0, repaired: 0, "title-only": 0, pending: 0 },
      numbersChecked: 0, numberFailures: 0, unitMismatches: 0,
      // The wave-two calls: clustering's adjudication, profiles, abstracts.
      sameEventCalls: 0, sameEventFailures: 0, profileCalls: 0, profileFailures: 0, profilePhrasesDropped: 0, abstractCalls: 0,
    };
    /** @type {string | null} */
    this.lastError = null;
  }

  /** Whether a model call can be made at all: provider configured and an owner to charge. */
  get available() {
    return this.config.deepseekProviderEnabled === true && Boolean(this.config.deepseekApiKey)
      && Boolean(this.owner?.userId) && Boolean(this.owner?.projectId);
  }

  /**
   * One metered model call; the parsed JSON answer, or null when the answer
   * held none. Throws with a named code when the call itself failed.
   * @param {Array<{ role: string, content: string }>} messages @param {number} maxTokens @param {number} timeoutMs
   */
  async #call(messages, maxTokens, timeoutMs) {
    if (!this.available || !this.owner) throw Object.assign(new Error("The frontier editor is not configured."), { code: "frontier_editor_unavailable" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = await this.callModel({ config: this.config, usageLedger: this.usageLedger, fetchImpl: this.fetchImpl }, {
        userId: this.owner.userId,
        projectId: this.owner.projectId,
        purpose: "frontier",
        // The module's own daily budget governs (the pipeline reads it from the
        // ledger); an operator's personal caps must not stop the feed.
        limits: { daily: 0, weekly: 0 },
        signal: controller.signal,
        body: {
          model: this.model,
          temperature: 0,
          thinking: { type: "disabled" },
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages,
        },
      });
      const message = body?.choices?.[0]?.message;
      return parseModelJson(message?.content) ?? parseModelJson(message?.reasoning_content);
    } catch (error) {
      this.counters.callFailures += 1;
      this.lastError = errorCode(error);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: errorCode(error) });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Screen up to `FRONTIER_SCREEN_BATCH` entries. An answer that is not one
   * verdict per entry in the vocabularies is asked again once for the whole
   * batch, then entry by entry; an entry that still has no verdict comes back
   * with the error's code and is retried by the pipeline later.
   * @param {ScreenInput[]} batch
   * @returns {Promise<{ verdicts: Map<string, ScreenVerdict>, errors: Map<string, string>, calls: number }>}
   */
  async screen(batch) {
    /** @type {Map<string, ScreenVerdict>} */
    const verdicts = new Map();
    /** @type {Map<string, string>} */
    const errors = new Map();
    let calls = 0;
    const items = batch.slice(0, FRONTIER_SCREEN_BATCH);
    for (const entry of batch.slice(FRONTIER_SCREEN_BATCH)) errors.set(entry.key, "frontier_screen_batch_too_large");
    if (!items.length) return { verdicts, errors, calls };
    /** @param {ScreenInput[]} group @returns {Promise<Map<string, ScreenVerdict> | null>} */
    const ask = async (group) => {
      calls += 1;
      this.counters.screenCalls += 1;
      const payload = {
        items: group.map((entry, index) => ({
          id: String(index + 1),
          title: clip(entry.title, 400),
          source: clip(entry.sourceName, 120),
          excerpt: clip(entry.excerpt ?? "", FRONTIER_SCREEN_EXCERPT_CHARS),
          lanes: entry.allowedLanes,
        })),
      };
      const answer = await this.#call([
        { role: "system", content: FRONTIER_SCREEN_INSTRUCTIONS },
        { role: "user", content: JSON.stringify(payload) },
      ], SCREEN_MAX_TOKENS, SCREEN_TIMEOUT_MS);
      return validateScreen(group, answer);
    };
    /** @param {ScreenInput[]} group */
    const attempt = async (group) => {
      try { return { verdicts: await ask(group), error: null }; }
      catch (error) { return { verdicts: null, error: errorCode(error) }; }
    };
    let whole = await attempt(items);
    // A spent budget or a missing owner will not be different a second later.
    const final = (/** @type {string | null} */ code) => code === "usage_budget_exceeded" || code === "frontier_editor_unavailable";
    if (!whole.verdicts && !final(whole.error)) {
      this.counters.screenRetries += 1;
      whole = await attempt(items);
    }
    if (whole.verdicts) {
      for (const [key, verdict] of whole.verdicts) verdicts.set(key, verdict);
      return { verdicts, errors, calls };
    }
    if (final(whole.error) || items.length === 1) {
      for (const entry of items) errors.set(entry.key, whole.error ?? "frontier_screen_invalid");
      this.counters.screenFailures += items.length;
      return { verdicts, errors, calls };
    }
    for (const entry of items) {
      this.counters.screenSingles += 1;
      const single = await attempt([entry]);
      const verdict = single.verdicts?.get(entry.key);
      if (verdict) verdicts.set(entry.key, verdict);
      else {
        errors.set(entry.key, single.error ?? "frontier_screen_invalid");
        this.counters.screenFailures += 1;
      }
    }
    return { verdicts, errors, calls };
  }

  /**
   * Edit one item: one call, verified; one rewrite with the specific issues
   * when the verification fails; title-only when the rewrite fails too.
   * `pending` means no answer could be had (the call failed twice, the budget
   * is spent, the editor is unconfigured): the pipeline publishes the item
   * title-only and edits it later.
   * @param {FrontierEditItem} item
   * @returns {Promise<FrontierEditResult>}
   */
  async edit(item) {
    const modelInput = buildModelInput(item);
    /** @type {FrontierEditResult} */
    const result = {
      verification: "pending", output: null, modelInput, modelInputSha256: sha256(modelInput), attempts: 0,
      issues: [], numbers: null, error: null, model: this.model, editorVersion: FRONTIER_EDITOR_VERSION,
    };
    const messages = [
      { role: "system", content: FRONTIER_EDIT_INSTRUCTIONS },
      { role: "user", content: modelInput },
    ];
    /** @param {Array<{ role: string, content: string }>} conversation */
    const ask = async (conversation) => {
      result.attempts += 1;
      this.counters.editCalls += 1;
      return this.#call(conversation, EDIT_MAX_TOKENS, EDIT_TIMEOUT_MS);
    };
    let answer;
    try {
      answer = await ask(messages);
    } catch (error) {
      const code = errorCode(error);
      if (code === "usage_budget_exceeded" || code === "frontier_editor_unavailable") return this.#finish(result, code);
      try { answer = await ask(messages); } catch (second) { return this.#finish(result, errorCode(second)); }
    }
    const first = verifyEdit(answer, item, modelInput);
    this.#countNumbers(first.numbers);
    if (!first.issues.length) {
      result.verification = "passed";
      result.output = first.output;
      result.numbers = first.numbers;
      this.counters.verification.passed += 1;
      return result;
    }
    this.counters.rewrites += 1;
    for (const field of first.failed) this.counters.firstPassFailures[field] = (this.counters.firstPassFailures[field] ?? 0) + 1;
    let second = null;
    try {
      const again = await ask([
        ...messages,
        { role: "assistant", content: JSON.stringify(answer ?? {}) },
        { role: "user", content: [
          "你上面的输出没有通过复核，问题如下：",
          ...first.issues.map((issue) => `- ${issue}`),
          "请修正这些问题，重新输出完整的 JSON 对象，键名不变。数字只能使用原文里出现过的；找不到对应数字时，删去这个数字，不要改写成别的数字。",
        ].join("\n") },
      ]);
      second = verifyEdit(again, item, modelInput);
      this.#countNumbers(second.numbers);
    } catch (error) {
      result.error = errorCode(error);
    }
    if (second && !second.issues.length) {
      result.verification = "repaired";
      result.output = second.output;
      result.numbers = second.numbers;
      this.counters.verification.repaired += 1;
      return result;
    }
    // Title-only: the summary and the reason are dropped; what passed its own
    // checks is kept — the title only if it passed on its own, structure from
    // the latest answer where it passed, else the screening verdict.
    const last = second ?? first;
    const defaults = item.defaults ?? {};
    const keep = (/** @type {string} */ field) => !last.failed.has(field) && !last.failed.has("answer");
    const titleZh = item.isChinese ? last.output.titleZh
      : keep("title_zh") ? last.output.titleZh
        : !first.failed.has("title_zh") && !first.failed.has("answer") ? first.output.titleZh : null;
    result.verification = "title-only";
    result.issues = last.issues;
    result.numbers = last.numbers;
    result.output = {
      titleZh,
      summaryZh: null,
      reasonZh: null,
      lane: keep("lane") ? last.output.lane : (defaults.lane ?? null),
      specialties: keep("specialties") ? last.output.specialties : [...(defaults.specialties ?? [])],
      evidenceType: item.evidenceFixed?.type ?? (keep("evidence_type") ? last.output.evidenceType : null),
      entities: keep("entities") ? last.output.entities : { drugs: [], trials: [], orgs: [], diseases: [] },
      scores: null,
      flags: keep("flags") ? last.output.flags : [],
    };
    this.counters.verification["title-only"] += 1;
    return result;
  }

  /** @param {FrontierEditResult} result @param {string} code */
  #finish(result, code) {
    result.error = code;
    this.counters.verification.pending += 1;
    return result;
  }

  /** @param {{ checked: number, missing: unknown[], unitMismatches: unknown[] }} numbers */
  #countNumbers(numbers) {
    this.counters.numbersChecked += numbers.checked;
    this.counters.numberFailures += numbers.missing.length;
    this.counters.unitMismatches += numbers.unitMismatches.length;
  }

  /**
   * One verified piece of prose: a call, the checks, one rewrite with the
   * issues named, and nothing if the rewrite fails too — the caller keeps what
   * it had (the previous digest, no AI minute). Never softened.
   * @param {string} instructions @param {string} input @param {Record<string, number>} fields @param {number} maxTokens
   * @param {{ verify?: (answer: any) => { output: Record<string, string | null>, issues: string[], numbers: any }, timeoutMs?: number }} [options]
   *   `verify` replaces `verifyWriting` for prose with its own shape (the abstract keeps its paragraphs).
   * @returns {Promise<{ verification: "passed" | "repaired" | "dropped" | "pending", output: Record<string, string | null> | null,
   *                     modelInput: string, modelInputSha256: string, attempts: number, issues: string[], error: string | null,
   *                     model: string, editorVersion: string }>}
   */
  async #write(instructions, input, fields, maxTokens, { verify = (answer) => verifyWriting(answer, fields, input), timeoutMs = WRITING_TIMEOUT_MS } = {}) {
    const result = { verification: /** @type {"passed" | "repaired" | "dropped" | "pending"} */ ("pending"), output: null,
      modelInput: input, modelInputSha256: sha256(input), attempts: 0, issues: /** @type {string[]} */ ([]),
      error: /** @type {string | null} */ (null), model: this.model, editorVersion: FRONTIER_EDITOR_VERSION };
    const messages = [{ role: "system", content: instructions }, { role: "user", content: input }];
    let answer;
    try {
      result.attempts += 1;
      answer = await this.#call(messages, maxTokens, timeoutMs);
    } catch (error) {
      result.error = errorCode(error);
      return result;
    }
    const first = verify(answer);
    this.#countNumbers(first.numbers);
    if (!first.issues.length) return { ...result, verification: "passed", output: first.output };
    try {
      result.attempts += 1;
      const again = await this.#call([
        ...messages,
        { role: "assistant", content: JSON.stringify(answer ?? {}) },
        { role: "user", content: ["你上面的输出没有通过复核，问题如下：", ...first.issues.map((issue) => `- ${issue}`),
          "请修正这些问题，重新输出完整的 JSON 对象，键名不变。"].join("\n") },
      ], maxTokens, timeoutMs);
      const second = verify(again);
      this.#countNumbers(second.numbers);
      if (!second.issues.length) return { ...result, verification: "repaired", output: second.output };
      return { ...result, verification: "dropped", issues: second.issues };
    } catch (error) {
      return { ...result, verification: "dropped", issues: first.issues, error: errorCode(error) };
    }
  }

  /**
   * An event's 「先了解这件事」 and 「最新进展」 (plan §6.4; wave 2 decides
   * when an event gets one: on the hot list or holding a primary source).
   * `dropped` or `pending` leaves the caller's previous digest in place.
   * @param {{ reports: FrontierEventReport[], previousDigest?: string | null }} event
   */
  async writeEventDigest(event) {
    const input = buildDigestInput(event);
    const result = await this.#write(FRONTIER_DIGEST_INSTRUCTIONS, input, { digest_zh: FRONTIER_WRITING_LIMITS.digest, latest_zh: FRONTIER_WRITING_LIMITS.latest }, DIGEST_MAX_TOKENS);
    return { ...result, digestZh: result.output?.digest_zh ?? null, latestZh: result.output?.latest_zh ?? null };
  }

  /**
   * The daily issue's 「AI 一分钟」 from the day's verified AI-lane items (plan
   * §4.5). The issue's structure — lead, sections, safety, Markdown — is
   * assembled by code from the items; this writes the one paragraph a model
   * writes. No AI items, no call: `skipped`.
   * @param {{ day: string, items: Array<{ titleRaw: string, titleZh?: string | null, summaryZh?: string | null, sourceName: string }> }} input
   */
  async writeDaily({ day, items }) {
    const usable = (items ?? []).filter((item) => item?.summaryZh);
    if (!usable.length) {
      const empty = buildAiMinuteInput({ day, items: [] });
      return { verification: /** @type {const} */ ("skipped"), output: null, modelInput: empty, modelInputSha256: sha256(empty), attempts: 0,
        issues: [], error: null, model: this.model, editorVersion: FRONTIER_EDITOR_VERSION, aiMinuteZh: null };
    }
    const input = buildAiMinuteInput({ day, items: usable });
    const result = await this.#write(FRONTIER_AI_MINUTE_INSTRUCTIONS, input, { ai_minute_zh: FRONTIER_WRITING_LIMITS.aiMinute }, AI_MINUTE_MAX_TOKENS);
    return { ...result, aiMinuteZh: result.output?.ai_minute_zh ?? null };
  }

  /**
   * 「是不是同一件事」 for the pairs the vectors could not decide (plan §6.4,
   * step 3): one call for a new report and up to three earlier ones. An
   * answer that is not one verdict per earlier report is asked for once more;
   * a second failure — or a call that could not be made — comes back as an
   * error code, and the caller treats every pair as not the same (a wrong
   * merge costs more than a missed one).
   * @param {{ report: FrontierSameEventReport, candidates: FrontierSameEventReport[] }} input
   * @returns {Promise<{ verdicts: Array<"yes" | "related" | "no"> | null, error: string | null, attempts: number }>}
   */
  async judgeSameEvent({ report, candidates }) {
    const earlier = (candidates ?? []).slice(0, FRONTIER_SAME_EVENT_CANDIDATES);
    if (!earlier.length) return { verdicts: [], error: null, attempts: 0 };
    const messages = [
      { role: "system", content: FRONTIER_SAME_EVENT_INSTRUCTIONS },
      { role: "user", content: buildSameEventInput({ report, candidates: earlier }) },
    ];
    let attempts = 0;
    /** @type {string | null} */
    let error = null;
    for (let round = 0; round < 2; round += 1) {
      attempts += 1;
      this.counters.sameEventCalls += 1;
      try {
        const verdicts = validateSameEvent(earlier.length, await this.#call(messages, SAME_EVENT_MAX_TOKENS, SAME_EVENT_TIMEOUT_MS));
        if (verdicts) return { verdicts, error: null, attempts };
        error = "frontier_same_event_invalid";
      } catch (failure) {
        error = errorCode(failure);
        // A spent budget or a missing owner will not be different a second later.
        if (error === "usage_budget_exceeded" || error === "frontier_editor_unavailable") break;
      }
    }
    this.counters.sameEventFailures += 1;
    return { verdicts: null, error, attempts };
  }

  /**
   * A researcher's interest profile from their own stated or confirmed
   * memories (plan §6.5, §10.5.3): specialties from the vocabulary and at most
   * ten phrases, each naming the memory it came from. A piece that fails its
   * check is dropped, never repaired; an answer without the shape is asked for
   * once more. `phrases` empty is an answer, not a failure.
   * @param {{ memories: FrontierProfileMemory[] }} input
   * @returns {Promise<{ specialties: string[], phrases: FrontierProfilePhrase[], dropped: Array<{ text: string, reason: string }>,
   *                     error: string | null, attempts: number, modelInputSha256: string }>}
   */
  async extractProfile({ memories }) {
    const usable = (memories ?? []).filter((memory) => memory?.id && memory?.text).slice(0, FRONTIER_PHRASE_LIMITS.memories);
    const input = buildProfileInput({ memories: usable });
    const empty = { specialties: [], phrases: [], dropped: [], error: null, attempts: 0, modelInputSha256: sha256(input) };
    if (!usable.length) return empty;
    const messages = [{ role: "system", content: FRONTIER_PROFILE_INSTRUCTIONS }, { role: "user", content: input }];
    let attempts = 0;
    /** @type {string | null} */
    let error = null;
    for (let round = 0; round < 2; round += 1) {
      attempts += 1;
      this.counters.profileCalls += 1;
      try {
        const verified = verifyProfile(await this.#call(messages, PROFILE_MAX_TOKENS, PROFILE_TIMEOUT_MS), usable);
        if (verified) {
          this.counters.profilePhrasesDropped += verified.dropped.length;
          return { ...verified, error: null, attempts, modelInputSha256: empty.modelInputSha256 };
        }
        error = "frontier_profile_invalid";
      } catch (failure) {
        error = errorCode(failure);
        if (error === "usage_budget_exceeded" || error === "frontier_editor_unavailable") break;
      }
    }
    this.counters.profileFailures += 1;
    return { ...empty, error, attempts };
  }

  /**
   * The Chinese abstract a reader asked for (plan §10.3.6): one call, the
   * checks every piece of prose gets, one rewrite with the issues named, and
   * nothing if the rewrite fails too — the reader is shown the original.
   * @param {{ titleRaw: string, abstract: string, glossary?: Array<{ termEn: string, termZh: string, keepOriginal: boolean }> }} input
   */
  async writeAbstractZh({ titleRaw, abstract, glossary = [] }) {
    const input = buildAbstractInput({ titleRaw, abstract, glossary });
    this.counters.abstractCalls += 1;
    const result = await this.#write(FRONTIER_ABSTRACT_INSTRUCTIONS, input, { abstract_zh: FRONTIER_ABSTRACT_LIMITS.output }, ABSTRACT_MAX_TOKENS,
      { verify: (answer) => verifyAbstract(answer, input), timeoutMs: ABSTRACT_TIMEOUT_MS });
    return { ...result, abstractZh: result.output?.abstract_zh ?? null };
  }

  status() {
    return { available: this.available, model: this.model, editorVersion: FRONTIER_EDITOR_VERSION, lastError: this.lastError,
      counters: structuredClone(this.counters) };
  }
}
