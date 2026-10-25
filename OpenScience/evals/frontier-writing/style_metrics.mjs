/**
 * The style metrics of the frontier-writing eval (c2-style, 2026-10-25; research note §4.7). Every list here is closed and every
 * count is a metric: nothing in this file is a check a written text must pass (principles 5 and 13). What each measures, and why:
 *
 * - **Sentence architecture** (`proseStyle`): the moves the c2-style contrast measured our model making far more often than the
 *   human openings of the same items (100 items, 2026-10-25): sentences over 120 characters (38% vs 6%), sentences carrying four
 *   or more numbers (45% vs 10%), sentences with four or more commas (27% vs 9%), 「分别」 parallel lists (0.71 vs 0.24 per 1,000
 *   characters). The lieflat-less-ai-tone tells (MIT, larashero3-dotcom/lieflat-less-ai-tone: the dash, 「不是…而是」, colon
 *   set-ups) are counted too: the current prompts already keep them below the human rate, and a change must not bring them back.
 * - **Titles** (`titleFeatures`): the c2-style title corpus (913 posts of 25 HCP and industry accounts, reads measured ≥ 7 days
 *   after posting, relative to the account's median at the same push position): question titles drew 0.74× the reads, 栏目 tags
 *   (【】丨｜) 0.83×, a named organisation 1.18× and a result verb 1.2×; held-out pairs kept "names the organisation, regulator or
 *   company" (68% of 140 pairs), "names the drug or regimen" (65% of 96) and "no question" / "no exclamation" (64% / 65%). The
 *   policy rules (NHC 2025 negative list item 8) add the hype words and a site's name after the title.
 * - **Absolute numbers and harms** (`givenUsed`): when the source gives event counts or an absolute risk, or reports harms, does
 *   what the reader sees (导读 and 要点) carry one (HealthNewsReview criteria 2–3; Schwartz et al., BMJ 2012).
 * - **Exemplar leakage** (`leakage`): an eight-character run of a style card's exemplar (four Chinese characters at least, the
 *   phrase a preprint's 导读 is asked for masked) in an output that the item's own source does not contain.
 * - **Scores** (`scoreDistribution`): the edit's three sub-scores per genre, and how many sit at the top of every scale (the
 *   2026-10-25 review: 258 of 510 精选 items had impact 30, novelty 20 and relevance 20).
 */

/** Sentences of Chinese prose: a run up to 。！？ or a line end. @param {string} text */
export function sentencesOf(text) {
  return String(text ?? "").match(/[^。！？!?\n]+[。！？!?]?/gu)?.map((s) => s.trim()).filter((s) => [...s].length >= 4) ?? [];
}
const NUMBER = /\d+(?:[.,·]\d+)?/g;
/** @param {string} text */
const chars = (text) => [...String(text ?? "")].length;

/**
 * Sentence architecture and the lieflat tells of a text, as counts (so several texts sum) and rates.
 * @param {string} text
 */
export function proseStyle(text) {
  const value = String(text ?? "");
  const sentences = sentencesOf(value);
  // 「95% CI」 is a label, not a number of the result (the prompt's rule counts an effect and its interval as one result).
  const numbersIn = (/** @type {string} */ s) => s.replace(/95\s*%\s*(?:CI|置信区间)/g, "").match(NUMBER)?.length ?? 0;
  return {
    chars: chars(value),
    sentences: sentences.length,
    sentenceChars: sentences.reduce((sum, s) => sum + chars(s), 0),
    over80: sentences.filter((s) => chars(s) > 80).length,
    over120: sentences.filter((s) => chars(s) > 120).length,
    numbers4: sentences.filter((s) => numbersIn(s) >= 4).length,
    commas4: sentences.filter((s) => (s.match(/，/g)?.length ?? 0) >= 4).length,
    fenbie: value.match(/分别/g)?.length ?? 0,
    dash: value.match(/(?<!\d)—{1,2}(?!\d)/g)?.length ?? 0,
    reversal: value.match(/(不是|并非|并不是|不只是|不仅仅是)[^。！？；]{1,40}(而是|更是)/g)?.length ?? 0,
    colonSetup: value.match(/(?:^|[。；，！？\n])[^。；，！？\n：:]{2,12}[：:](?!\d)/g)?.length ?? 0,
  };
}

/** Sum of `proseStyle` counts, and the rates the report shows. @param {ReturnType<typeof proseStyle>[]} rows */
export function styleRates(rows) {
  const sum = rows.reduce((acc, row) => { for (const [key, value] of Object.entries(row)) acc[key] = (acc[key] ?? 0) + value; return acc; }, /** @type {Record<string, number>} */ ({}));
  const per = (/** @type {number} */ count, /** @type {number} */ base) => (base ? Math.round((count / base) * 1000) / 1000 : 0);
  return {
    chars: sum.chars ?? 0, sentences: sum.sentences ?? 0,
    meanSentenceChars: sum.sentences ? Math.round((sum.sentenceChars / sum.sentences) * 10) / 10 : 0,
    shareOver80: per(sum.over80, sum.sentences), shareOver120: per(sum.over120, sum.sentences),
    shareNumbers4: per(sum.numbers4, sum.sentences), shareCommas4: per(sum.commas4, sum.sentences),
    fenbiePer1k: per(sum.fenbie * 1000, sum.chars), dashPer1k: per(sum.dash * 1000, sum.chars),
    reversalPer1k: per(sum.reversal * 1000, sum.chars), colonSetupPer1k: per(sum.colonSetup * 1000, sum.chars),
  };
}

const QUESTION = /[？?]|吗|如何|怎么|为何|为什么|哪些|是否|能否|会不会|要不要/;
const EXCLAMATION = /[！!]/;
/** Hype and hook words of a title (`REASON_RULES`' list and the title corpus's): a closed list, a metric. */
export const TITLE_HYPE = Object.freeze(["重磅", "刚刚", "突发", "竟", "千万", "颠覆", "震撼", "炸裂", "王炸", "全球首个", "首个", "史上", "神药", "必看",
  "收藏", "刷屏", "惊人", "里程碑", "改写", "登顶", "大结果", "火了", "全网", "狂飙", "揭秘", "真相", "注意了", "警惕"]);
const COLUMN_TAG = /[【】丨｜|]/;
// A site's or a channel's name after the title, the way a fetched page's <title> carries it (「…_新华网」「… - 丁香园」).
const SITE_SUFFIX = /(?:\s[-–—|｜]\s|_|｜)[^-–—|｜_]{1,16}(?:网|报|新闻|频道|官网|客户端|在线|资讯|时报|周刊|日报|健康|医学|医药)?\s*$/u;
/** Organisations, regulators, companies, journals and drug stems a title may name: a closed list, a metric. */
const NAMED = /FDA|NMPA|EMA|CDE|WHO|CDC|NIH|NICE|MHRA|PMDA|HSA|国家|医保局|卫健委|药监|国务院|疾控|学会|协会|医院|大学|公司|集团|药业|生物|制药|辉瑞|默沙东|阿斯利康|罗氏|诺华|礼来|恒瑞|百济|信达|诺和|赛诺菲|强生|吉利德|安进|武田|拜耳|复星|NEJM|柳叶刀|Lancet|JAMA|BMJ|Nature|自然|Cell|Science|单抗|替尼|帕利|沙坦|他汀|格列|肽|霉素|沙星|疫苗|CAR-T|[A-Z][A-Za-z]*-?\d+[A-Za-z]?\b|\b[A-Z]{3,}\b/u;
const RESULT_VERB = /降低|延长|提高|改善|获批|批准|达到|减少|增加|升高|优于|不劣于|获益|下降|缓解|失败|未达|未能|相关|召回|警示|暂停|撤市|发布|更新|启动|完成|收购|授权|合作|融资/;

/** A title's features (closed lists, metrics only). @param {string | null | undefined} title */
export function titleFeatures(title) {
  const value = String(title ?? "").trim();
  return {
    chars: chars(value), question: QUESTION.test(value), exclamation: EXCLAMATION.test(value),
    hype: TITLE_HYPE.some((word) => value.includes(word)), columnTag: COLUMN_TAG.test(value), siteSuffix: SITE_SUFFIX.test(value),
    named: NAMED.test(value), resultVerb: RESULT_VERB.test(value), numeral: /\d/.test(value),
  };
}
/** Whether a title is a hook by the features the policy forbids. @param {ReturnType<typeof titleFeatures>} f */
export const titleHook = (f) => f.question || f.exclamation || f.hype || f.siteSuffix;

const ABSOLUTE_GIVEN = /\b\d+\s*\/\s*\d+\b|\b\d+\s+of\s+\d+\b|absolute (?:risk|difference|reduction)|risk difference|number needed to|\bNNT\b|绝对风险|风险差|需治疗人数|\d+\s*例[^，。；]{0,12}(?:发生|出现|死亡|事件)|events? (?:occurred|in \d)/i;
const ABSOLUTE_USED = /\d+\s*\/\s*\d+|绝对风险|风险差|需治疗|\d+\s*例[^，。；]{0,14}(?:发生|出现|死亡|事件|患者中)/;
const HARM_GIVEN = /adverse event|adverse reaction|serious adverse|toxicit|side effect|treatment-related death|bleeding|hemorrhage|haemorrhage|不良事件|不良反应|毒性|严重不良|出血|副作用|治疗相关死亡/i;
const HARM_USED = /不良|毒性|安全性|出血|副作用|死亡|耐受/;
/** The genres whose sources report results with absolute numbers and harms. */
export const RESULT_GENRES = Object.freeze(["paper", "preprint", "conference", "news", "approval"]);

/**
 * Given → used: whether the source gives absolute numbers / harms, and whether what the reader sees carries one.
 * @param {string} source @param {string} seen the 导读 and the 要点's words
 */
export function givenUsed(source, seen) {
  return { absoluteGiven: ABSOLUTE_GIVEN.test(source), absoluteUsed: ABSOLUTE_USED.test(seen), harmGiven: HARM_GIVEN.test(source), harmUsed: HARM_USED.test(seen) };
}

/**
 * Eight-character runs of the exemplars found in an output and not in the item's own source.
 * @param {string} output @param {string} source @param {readonly string[]} exemplars
 */
export function leakage(output, source, exemplars) {
  const found = new Set();
  const mask = (/** @type {string} */ text) => MANDATED_PHRASES.reduce((t, phrase) => t.split(phrase).join("\u0000"), text);
  const text = mask(String(output ?? ""));
  for (const exemplar of exemplars) {
    const points = [...mask(String(exemplar))];
    for (let i = 0; i + 8 <= points.length; i += 1) {
      const run = points.slice(i, i + 8).join("");
      // Expression, not a name or a figure: four Chinese characters at least, and none of a phrase every such text is asked for.
      if (run.includes("\u0000") || (run.match(/[\u3400-\u9fff]/gu)?.length ?? 0) < 4) continue;
      if (text.includes(run) && !source.includes(run)) found.add(run);
    }
  }
  return [...found];
}

/** Phrases the prompts ask every text of a kind to carry (a preprint's 导读 says what it is), not taken from an exemplar. */
const MANDATED_PHRASES = Object.freeze(["这项尚未经同行评议的预印本", "尚未经同行评议的预印本"]);

/** The three sub-scores per genre, and how many sit at the scale's top. @param {Array<{ genre: string, scores: any }>} rows */
export function scoreDistribution(rows) {
  /** @type {Record<string, { n: number, impact: number[], novelty: number[], relevance: number[], allMax: number, impactMax: number }>} */
  const byGenre = {};
  for (const { genre, scores } of rows) {
    if (!scores || !Number.isInteger(scores.impact)) continue;
    const entry = (byGenre[genre] ??= { n: 0, impact: [], novelty: [], relevance: [], allMax: 0, impactMax: 0 });
    entry.n += 1;
    entry.impact.push(scores.impact); entry.novelty.push(scores.novelty); entry.relevance.push(scores.relevance);
    if (scores.impact >= 30 && scores.novelty >= 20 && scores.relevance >= 20) entry.allMax += 1;
    if (scores.impact >= 30) entry.impactMax += 1;
  }
  const mean = (/** @type {number[]} */ list) => (list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 : null);
  const out = /** @type {Record<string, any>} */ ({});
  let n = 0, allMax = 0, impactMax = 0;
  for (const [genre, entry] of Object.entries(byGenre)) {
    out[genre] = { n: entry.n, impact: mean(entry.impact), novelty: mean(entry.novelty), relevance: mean(entry.relevance), allMax: entry.allMax, impactMax: entry.impactMax };
    n += entry.n; allMax += entry.allMax; impactMax += entry.impactMax;
  }
  const all = rows.filter((row) => row.scores && Number.isInteger(row.scores.impact));
  return { all: { n, allMax, impactMax, impact: mean(all.map((row) => row.scores.impact)), novelty: mean(all.map((row) => row.scores.novelty)),
    relevance: mean(all.map((row) => row.scores.relevance)) }, byGenre: out };
}
