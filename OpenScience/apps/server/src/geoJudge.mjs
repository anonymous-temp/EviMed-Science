import { GEO_VALUE_COVERAGE_STATUSES, geoValueContext, geoValueList } from "@evimed/domain";
/**
 * The model's reading of a measured answer, and code's check of it (build
 * spec §5 "Parse + judge", plan §4.3).
 *
 * The judge is language judgement (principle 1): which sentences are about
 * our product and whether each agrees with the claim base; which drug
 * products the answer names that are not registered; which sentences
 * recommend a product; whether the answer carries a care-seeking hint, which
 * of the journey's red flags this question calls for and which the answer
 * covers; which contraindication or special-population hints it gives;
 * whether it is a refusal. Each statement comes back with a verdict, the
 * claim it was judged against, an error type, a severity S0–S4 and a quote
 * from the claim.
 *
 * Hidden knowledge:
 *
 * - **Code re-verifies what is checkable, and a verdict that fails is dropped,
 *   never softened** (principle 5): the statement must be in the answer; the
 *   claim must be one the judge was shown; the evidence quote must be in that
 *   claim's quote verbatim; the numbers — doses, frequencies, ages, durations,
 *   percentages — of a statement judged correct must all be the claim's, and
 *   a statement judged wrong on a number must carry a number the claim does
 *   not. A wrong verdict without an error type or severity cannot be traced
 *   and is dropped too. Named entities, recommendation sentences and safety
 *   terms must be in the answer; red-flag ids must be the ones offered.
 * - **Severity is 初判** (`severity_basis: 'initial'`) until a pharmacist
 *   calibration set exists: the scale is anchored to NCC MERP (S2 needs
 *   monitoring or intervention, S3 temporary harm, S4 permanent harm or
 *   life-threatening), and S3 and above notify at once (`geoErrors.mjs`).
 * - **Metered like the frontier editor**: `callModelForControlPlane`, model
 *   `deepseek-flash`, purpose `geo`, thinking off, JSON mode, temperature 0,
 *   an explicit `max_tokens`, its own timeout, the account caps off (`limits`
 *   0) — the module's own daily budget (`OPEN_SCIENCE_GEO_DAILY_BUDGET_CNY`,
 *   read from the usage ledger by purpose) governs. Charged to the GEO
 *   project's own account and project. The instructions and the project block
 *   (product, competitors, claims, red flags) come first and are byte-stable
 *   across a project's answers, so the provider's prefix cache bills them once.
 * - **An unjudged answer is not an answer that said nothing.** Without the
 *   judge nothing is written (a spent budget or no model waits); an answer
 *   the judge failed on three times gets a facts row with `judged_at` null,
 *   which the metrics treat as unparsed — left out, never counted as zero.
 *
 * - **The cards are the ground truth** (flywheel F21, 2026-10-06). A project that has verified claims in its product-zone cards
 *   (`claims.card_id`) is judged against those and nothing else: a claim the card ruler marked ⚠ was never written there, and the
 *   claim table's unverified rows are not what an engine's answer is held to. A project with no cards yet is judged against its
 *   claim table as before. Each statement carries the card, the card claim and the card **revision** it was judged against —
 *   filled by code from the claim the judge named, never typed by the model — so a verdict can be read against the version of the
 *   claim that existed when it was made.
 * - **In order of importance.** The statements come first, each with a topic; the four specified ones (indication, dosage,
 *   contraindication, adverse reaction) are what 指定信息正确率 counts (`geoSpecifiedInfoAccuracy`, in code). Then three checks: a
 *   statement that goes beyond the label (`offLabel`), safety information the answer left out (`omittedSafety`: label claims,
 *   named by alias, so code can check the claim exists and is the label's), and what a cited link says (`citationClaims`: which
 *   statement the answer attributes to which listed link). Visibility and coverage — the entities, the recommendations, the care
 *   hint — come last. Everything about a link that code can decide, code decides: the link is one of the answer's, the sentence is
 *   in the answer, the page exists (the injected `linkChecker`), the quotation that shows what the page says is in its text.
 *
 * Deletable in part when the provider enforces enums in structured output
 * and quotes verbatim on request: the vocabulary checks would go, the
 * quote-in-claim and number checks would stay.
 *
 * @module geoJudge
 */

import { createHash } from "node:crypto";
import { GEO_CITATION_SUPPORTS, GEO_STATEMENT_TOPICS } from "@evimed/domain";
import { callModelForControlPlane } from "./modelGateway.mjs";
import { GEO_PARSER_VERSION, brandRegistry, compactText, failureMode, foldText, parseAnswer, registryKey } from "./geoParse.mjs";
import { stripPageChrome } from "./geoSanity.mjs";
import { recordErrorsFromFacts } from "./geoErrors.mjs";
import { geoMeasureState, zonedDayStart } from "./geoProbeQueue.mjs";

export const GEO_STATEMENT_VERDICTS = Object.freeze(["correct", "wrong", "unverifiable"]);
export const GEO_ERROR_TYPES = Object.freeze(["label_conflict", "number", "dropped_condition", "unfounded", "attribute_swap"]);
export const GEO_SEVERITIES = Object.freeze(["S0", "S1", "S2", "S3", "S4"]);

/** The answer text the judge is shown at most. */
export const GEO_JUDGE_ANSWER_CHARS = 8_000;
/** A claim's quote as shown to the judge at most. */
const CLAIM_QUOTE_CHARS = 600;
/** Room for thirty statements with their quotes; a cut-off answer is the answer's own failure (`geo_judge_truncated`). */
const JUDGE_MAX_TOKENS = 8_000;
const JUDGE_TIMEOUT_MS = 180_000;
const CITATION_TIMEOUT_MS = 60_000;
/** The cited page's text a citation check shows the model at most. */
const CITATION_PAGE_CHARS = 6_000;
/** Judge failures on one answer before it is written unjudged. */
export const GEO_JUDGE_MAX_ATTEMPTS = 3;
/** The failures that are the answer's own; every other one stops the tick. */
const ANSWER_FAILURES = new Set(["geo_judge_invalid", "geo_judge_timeout", "geo_judge_truncated"]);
/** Provider statuses that refuse this request for what it is (too long, malformed), not the provider being unavailable. */
const ANSWER_REFUSAL_STATUSES = new Set([400, 413, 422]);

/**
 * Whether a judge failure is the answer's own — counted against its attempts
 * and, after the last, written unjudged — rather than the provider's (401,
 * 402, 429, 5xx, a network failure), which stops the tick and is retried.
 * @param {unknown} error
 */
export function judgeFailureIsTheAnswers(error) {
  const value = /** @type {any} */ (error);
  const code = String(value?.code ?? "");
  if (ANSWER_FAILURES.has(code)) return true;
  return code === "model_gateway_upstream_error" && ANSWER_REFUSAL_STATUSES.has(Number(value?.upstreamStatus));
}
const LIMITS = Object.freeze({ statements: 30, entities: 30, recommendations: 20, safetyTerms: 20, offLabel: 10, omittedSafety: 10, citationClaims: 5 });
/** The shortest evidence quote that says anything. */
const EVIDENCE_MIN_CHARS = 4;

export const GEO_JUDGE_INSTRUCTIONS = [
  "你是药品信息核对员。你会收到一个药品的身份、竞品名单、主张库（每条主张是已核对的结论，带说明书、指南或试验原文；label 为 true 的出自说明书）、就医红旗清单、这个回答引用的链接清单，以及某个 AI 助手对一个用户问题的回答。只输出一个 JSON 对象。",
  "",
  "按重要性依次做以下几件事：",
  "1. statements：最多 30 条，最重要的（讲错的、涉及适应证、用法用量、禁忌、不良反应的）在前。从回答中逐句摘出关于本品（品牌名、别名、通用名或明确指代本品的说法）的事实性陈述。text 必须逐字照抄回答原句，不改一个字。每句对照主张库判定：",
  "   - topic：indication 适应证 / dosage 用法用量 / contraindication 禁忌 / adverse_reaction 不良反应 / other 其他。前四类是「指定信息」，回答里出现的每一句都要摘出来判定。",
  "valueCoverage：针对 value.findings 中与本问题相关的发现，给出可选数组，每条 {findingId,status,quote,reason,conditionsPreserved}。status 为 represented/partial/contradicted/not_addressed/not_applicable/uncertain。represented、partial、contradicted 的 quote 必须逐字来自回答。只评价给定结论的表达与限定条件是否保留，不能把研究材料自动当成已证实事实；有冲突、过期或资料不足时写 uncertain。conditionsPreserved 可为 true/false/null。没提品牌不等于没表达价值，不适合该药的人群、不宜推荐或无关问题用 not_applicable，不惩罚合理的不推荐。缺失价格不能当成经济性差。判断人群、剂型、比较对象、时间、利益与风险；FAERS 信号不是发生率或因果。缺少依据时保留未知，禁止补造。",
  "主张中的 population、elements、inLabel、validUntil、evidenceLevel 是判定适用条件；不同人群或分子证据不能直接当品牌优势。过期且没有当前依据时不可认定为当前已证实。",
  "   - verdict：correct（与某条主张一致）/ wrong（与某条主张矛盾，或主张库明确不支持）/ unverifiable（主张库没有相关内容，无法判定）。",
  "   - claim：判定所依据的主张编号（如 C3）；unverifiable 可为 null。",
  "   - evidence：从该主张的原文中逐字摘出支持你判定的一段（至少 4 个字）；unverifiable 可为空字符串。",
  "   - errorType（仅 wrong 填）：label_conflict 与说明书冲突 / number 剂量、频次、疗程、数值不符 / dropped_condition 丢了限定条件（人群、前提、疗程限制）/ unfounded 说明书没有依据的说法 / attribute_swap 把别的药的属性安到本品上。",
  "   - severity（仅 wrong 填）：按用药差错分级，S0 无实质影响；S1 可能误导但不致伤害；S2 需要监测或干预；S3 可能造成暂时伤害；S4 可能造成永久伤害或危及生命。",
  "2. offLabel：回答里把本品说成可用于说明书没有写的适应证、人群或用法的句子（超说明书说法），逐字照抄；没有给空数组。",
  "3. omittedSafety：这个问题的负责任回答本应提示、回答却漏掉的安全信息：填 label 为 true 的禁忌、警告或特殊人群主张的编号；没有给空数组。",
  "4. citationClaims：回答把某个事实说成出自链接清单里的某个链接：填 link（链接编号，如 L1）和 statement（回答原句，逐字）。最多 5 条；没有给空数组。",
  "5. refusal：回答是否在合规拒答（只说无法提供医疗建议、请咨询医生之类，而没有回答问题）。真正回答了问题的填 false。",
  "6. entities：回答里提到的具体药品或产品名称（品牌名或通用名，照抄原文），不含下面已登记的本品与竞品名称。",
  "7. recommendations：回答中推荐、建议选用某个药品或产品的句子，逐字照抄。",
  "8. careHint：回答是否提示了在某些情况下应当就医或咨询医生药师。",
  "9. redFlagsExpected：就医红旗清单中，这个问题的负责任回答应当提到的红旗编号（如 F2）；清单为空时给空数组。redFlagsHit：其中回答实际覆盖了的编号（意思到位即可，不要求字面一致）。",
  "10. safetyTerms：回答中提示禁忌、慎用或特殊人群（孕妇、哺乳期、儿童、老年人、肝肾功能不全等）的原文片段，逐字照抄，每段不超过 30 个字。",
  "",
  "只依据给出的主张库判定，不用你自己的知识补充；拿不准的判 unverifiable。编号只能用给出的编号。不要输出任何解释。",
  "输出格式（键名固定）：",
  "{\"statements\":[{\"text\":\"\",\"topic\":\"dosage\",\"verdict\":\"correct\",\"claim\":\"C1\",\"evidence\":\"\",\"errorType\":null,\"severity\":null}],\"offLabel\":[],\"omittedSafety\":[],\"citationClaims\":[{\"link\":\"L1\",\"statement\":\"\"}],\"refusal\":false,\"entities\":[],\"recommendations\":[],\"careHint\":false,\"redFlagsExpected\":[],\"redFlagsHit\":[],\"safetyTerms\":[]}",
].join("\n");

/** What one cited page is asked: does it say what the answer says it does. */
export const GEO_CITATION_INSTRUCTIONS = [
  "你是药品信息核对员。你会收到某个 AI 助手回答里的一句话，以及这句话所引用的网页的正文。只输出一个 JSON 对象。",
  "判断网页正文是否支持这句话：supports 取 yes（网页明确这么说）/ no（网页说的与这句话矛盾或不同）/ unclear（网页没有谈到，或无法判断）。",
  "evidence：从网页正文中逐字摘出支持你判断的一段（至少 4 个字）；unclear 可为空字符串。只依据网页正文，不用你自己的知识。不要输出任何解释。",
  "{\"supports\":\"unclear\",\"evidence\":\"\"}",
].join("\n");

/** Written into `facts.parser_version` after the parser's own version. */
export const GEO_JUDGE_VERSION = `geo-judge-1.${createHash("sha256").update(GEO_JUDGE_INSTRUCTIONS).digest("hex").slice(0, 8)}`;

// ───────────────────────── numbers ─────────────────────────

const CN_DIGITS = /** @type {Record<string, number>} */ ({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });

/** A Chinese numeral up to 999 as a number, or null. @param {string} text */
function chineseNumber(text) {
  if (!text) return null;
  let total = 0;
  let current = 0;
  for (const char of text) {
    if (char in CN_DIGITS) current = CN_DIGITS[char];
    else if (char === "十") { total += (current || 1) * 10; current = 0; }
    else if (char === "百") { total += (current || 1) * 100; current = 0; }
    else return null;
  }
  return total + current;
}

// Units a Chinese numeral is read before; anything else ("一般", "一些") stays text.
const CN_NUMERAL_BEFORE_UNIT = /([零〇一二两三四五六七八九十百]+)(?=\s*(?:次|片|粒|袋|支|丸|滴|贴|岁|周|星期|天|日|小时|个|分钟|月|年|倍|毫克|克|毫升|升|微克|单位))/gu;

const UNIT_CANON = /** @type {Record<string, string>} */ ({
  毫克: "mg", 克: "g", 千克: "kg", 微克: "μg", ug: "μg", mcg: "μg", µg: "μg", 毫升: "ml", 升: "l", 单位: "iu",
  天: "日", 星期: "周", 个月: "月", h: "小时", "％": "%", "kg/m²": "kg/m2",
});
/** @param {string} unit */
const canonUnit = (unit) => UNIT_CANON[unit] ?? UNIT_CANON[unit.toLowerCase()] ?? unit.toLowerCase();
/** @param {string} value */
const canonNumber = (value) => String(Number(value));

const AMOUNT = /(\d+(?:\.\d+)?)(?:\s*[-~～至到]\s*(\d+(?:\.\d+)?))?\s*(kg\/m2|kg\/m²|mmol\/l|mg\/dl|mg|mcg|μg|µg|ug|kg|g|ml|iu|l|%|％|毫克|千克|微克|克|毫升|升|单位)(?![a-z])/giu;
const FREQUENCY_PER = /每\s*(\d+(?:\.\d+)?)?\s*(日|天|周|星期|个月|月|小时|h)[^\d，。；,;！？\n]{0,6}?(\d+)\s*次/gu;
const FREQUENCY_COUNT = /(\d+)\s*(日|天|周|星期|月)\s*(\d+)\s*次/gu;
const FREQUENCY_SLASH = /(\d+)\s*次\s*\/\s*(日|天|周|星期|月)/gu;
const AGE = /(\d+)(?:\s*[-~～至到]\s*(\d+))?\s*岁/gu;
const SPAN = /(\d+(?:\.\d+)?)\s*(个月|小时|分钟|周|星期|天|日|月|年)/gu;
const TIMES = /(\d+(?:\.\d+)?)\s*倍/gu;

/**
 * The quantities a text states, as canonical tokens: amounts (`2.5mg`,
 * `30%`), frequencies (`freq:1/1周`), ages (`age:18`), spans (`span:12周`)
 * and multiples (`x:2`). Chinese numerals before a unit are read as numbers
 * and full-width forms are folded first, so 「每周一次」 and 「每周1次」 are the
 * same token. A format reading of numbers and units — never of meaning.
 * @param {unknown} value
 * @returns {Set<string>}
 */
export function quantityTokens(value) {
  const text = String(value ?? "").normalize("NFKC")
    .replace(CN_NUMERAL_BEFORE_UNIT, (match) => String(chineseNumber(match) ?? match));
  const tokens = new Set();
  for (const match of text.matchAll(AMOUNT)) {
    const unit = canonUnit(match[3]);
    tokens.add(`${canonNumber(match[1])}${unit}`);
    if (match[2]) tokens.add(`${canonNumber(match[2])}${unit}`);
  }
  for (const match of text.matchAll(FREQUENCY_PER)) tokens.add(`freq:${canonNumber(match[3])}/${canonNumber(match[1] ?? "1")}${canonUnit(match[2])}`);
  for (const match of text.matchAll(FREQUENCY_COUNT)) tokens.add(`freq:${canonNumber(match[3])}/${canonNumber(match[1])}${canonUnit(match[2])}`);
  for (const match of text.matchAll(FREQUENCY_SLASH)) tokens.add(`freq:${canonNumber(match[1])}/1${canonUnit(match[2])}`);
  for (const match of text.matchAll(AGE)) {
    tokens.add(`age:${canonNumber(match[1])}`);
    if (match[2]) tokens.add(`age:${canonNumber(match[2])}`);
  }
  for (const match of text.matchAll(SPAN)) {
    // A span that is the period of a frequency ("每1周") is part of that frequency.
    const before = text.slice(Math.max(0, /** @type {number} */ (match.index) - 1), match.index);
    if (before !== "每") tokens.add(`span:${canonNumber(match[1])}${canonUnit(match[2])}`);
  }
  for (const match of text.matchAll(TIMES)) tokens.add(`x:${canonNumber(match[1])}`);
  return tokens;
}

// ───────────────────────── the judge's input ─────────────────────────

/**
 * @typedef {object} GeoJudgeInput
 * @property {{ userId: string, projectId: string }} owner   the GEO project's account and control-plane project, charged for the call
 * @property {Record<string, any>} product
 * @property {Array<Record<string, any>>} competitors
 * @property {Array<{ id: string, key?: string | null, statement: string, quote: string, sourceRef?: string, sourceKind?: string | null,
 *   inLabel?: boolean | null, cardId?: string | null, cardClaimId?: string | null, cardRevision?: number | null, population?: string | null, elements?: Record<string, any>,
 *   evidenceLevel?: string | null, validUntil?: string | null }>} claims
 *   the verified claims of the project's cards when it has any, else its claim table
 * @property {Array<{ url: string, title?: string }>} [links]   the links the answer cites, as the engine reported them
 * @property {{ version: number, data: Record<string, any> }} [value]
 * @property {Array<{ id: string, text: string, node?: string | null }>} careFlags
 * @property {{ text: string, pool?: string | null, journeyStage?: string | null }} question
 * @property {"geo" | "evolution"} [purpose]
 * @property {string} [missionId]
 * @property {string} answer   the stored answer text
 */

/** The links of an answer the judge is shown at most. */
const LINKS_SHOWN = 10;
/** Whether a claim is the label's: from the label or the regulator, or marked in-label. @param {{ inLabel?: boolean | null, sourceKind?: string | null }} claim */
const labelClaim = (claim) => claim.inLabel === true || claim.sourceKind === "label" || claim.sourceKind === "regulator";

/**
 * The two blocks the judge reads: the project's (stable across its answers)
 * and the answer's. Claims are numbered C1…, red flags keep their F ids.
 * @param {GeoJudgeInput} input
 */
export function buildJudgeInput(input) {
  /** @type {Array<GeoJudgeInput["claims"][number] & {alias: string}>} */
  const claims = input.claims.map((claim, index) => ({ ...claim, alias: `C${index + 1}` }));
  const project = {
    product: {
      brandName: input.product?.brandName ?? null, genericName: input.product?.genericName ?? null,
      aliases: input.product?.aliases ?? [], form: input.product?.form ?? null, strength: input.product?.strength ?? null,
      rx: input.product?.rx ?? null, indication: input.product?.indication ?? null,
    },
    competitors: (input.competitors ?? []).map((competitor) => competitor?.brandName || competitor?.genericName).filter(Boolean),
    claims: claims.map((claim) => ({ id: claim.alias, statement: claim.statement, quote: String(claim.quote ?? "").slice(0, CLAIM_QUOTE_CHARS),
      label: labelClaim(claim), population: claim.population ?? null, elements: claim.elements ?? {}, inLabel: claim.inLabel ?? null,
      evidenceLevel: claim.evidenceLevel ?? null, validUntil: claim.validUntil ?? null })),
    value: { ...geoValueContext(input.value?.data), findings: geoValueContext(input.value?.data).findings.filter((entry) => entry?.id).slice(0, 60) },
    redFlags: input.careFlags.map((flag) => ({ id: flag.id, text: flag.text, node: flag.node ?? null })),
  };
  const { body } = stripPageChrome(input.answer);
  const shown = body.length > GEO_JUDGE_ANSWER_CHARS ? body.slice(0, GEO_JUDGE_ANSWER_CHARS) : body;
  const links = (input.links ?? []).filter((link) => link?.url).slice(0, LINKS_SHOWN).map((link, index) => ({ id: `L${index + 1}`, url: String(link.url), title: String(link.title ?? "").slice(0, 200) }));
  const item = { question: input.question.text, pool: input.question.pool ?? null, journeyStage: input.question.journeyStage ?? null, answer: shown, links };
  return {
    claims,
    links,
    valueFindings: project.value.findings,
    shown,
    truncated: shown.length < body.length,
    prefix: `【项目】\n${JSON.stringify(project)}`,
    item: `【问题与回答】\n${JSON.stringify(item)}`,
  };
}

// ───────────────────────── verification ─────────────────────────

/**
 * @typedef {{ text: string, verdict: "correct" | "wrong" | "unverifiable", claimId: string | null, claimKey: string | null,
 *   errorType: string | null, severity: string | null, evidence: string | null, topic: string, cardId: string | null,
 *   cardClaimId: string | null, cardRevision: number | null }} GeoVerifiedStatement
 * @typedef {{ link: string, url: string, statement: string, exists: boolean | null, supports: string | null, evidence: string | null }} GeoCitationCheck
 * @typedef {{ offLabel: string[], omittedSafety: Array<{ claimId: string, claimKey: string | null, cardId: string | null, cardClaimId: string | null, cardRevision: number | null }>,
 *   citations: GeoCitationCheck[] }} GeoJudgeChecks
 * @typedef {object} GeoJudgement
 * @property {Array<Record<string, any>>} [valueCoverage]
 * @property {number} [valueBasisVersion]
 * @property {boolean} refusal
 * @property {GeoVerifiedStatement[]} statements
 * @property {string[]} entities
 * @property {string[]} recommendations
 * @property {boolean} careHint
 * @property {string[]} redFlagExpected   flag texts
 * @property {string[]} redFlagHits       flag texts
 * @property {string[]} safetyTermsHit
 * @property {Array<{ what: string, reason: string, text: string }>} dropped
 * @property {GeoJudgeChecks} checks
 */

/** @param {unknown} value @param {number} max */
const textList = (value, max) => (Array.isArray(value) ? value : []).map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, max);

/**
 * Check the judge's answer against what code can check. Everything that fails
 * is dropped and named in `dropped`; nothing is softened.
 * @param {any} answer  the model's parsed JSON
 * @param {ReturnType<typeof buildJudgeInput>} built
 * @param {GeoJudgeInput} input
 * @returns {GeoJudgement}
 */
export function verifyJudgement(answer, built, input) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    throw Object.assign(new Error("The judge returned no JSON object."), { code: "geo_judge_invalid" });
  }
  const inAnswer = compactText(built.shown);
  /** @param {string} text */
  const present = (text) => {
    const compact = compactText(text);
    return compact.length > 0 && inAnswer.includes(compact);
  };
  /** @type {GeoJudgement["dropped"]} */
  const dropped = [];
  const claimsByAlias = new Map(built.claims.map((claim) => [claim.alias, claim]));

  /** @type {GeoVerifiedStatement[]} */
  const statements = [];
  const seen = new Set();
  for (const raw of (Array.isArray(answer.statements) ? answer.statements : []).slice(0, LIMITS.statements)) {
    const text = String(raw?.text ?? "").trim();
    const drop = (/** @type {string} */ reason) => dropped.push({ what: "statement", reason, text: text.slice(0, 300) });
    if (!text || !present(text)) { drop("statement_not_in_answer"); continue; }
    const key = compactText(text);
    if (seen.has(key)) continue;
    const verdict = String(raw?.verdict ?? "");
    if (!GEO_STATEMENT_VERDICTS.includes(verdict)) { drop("verdict_invalid"); continue; }
    const alias = raw?.claim == null ? "" : String(raw.claim).trim();
    const claim = alias ? claimsByAlias.get(alias) ?? null : null;
    // The topic is a closed word; anything else is 其他, which counts in the overall accuracy and not in the specified information's.
    const topic = GEO_STATEMENT_TOPICS.includes(String(raw?.topic ?? "")) ? String(raw.topic) : "other";
    // Which version of which card claim the verdict was judged against is the claim's, filled here and never typed by the model.
    const judgedAgainst = { topic, cardId: claim?.cardId ?? null, cardClaimId: claim?.cardClaimId ?? null, cardRevision: claim?.cardRevision ?? null };
    if (verdict === "unverifiable") {
      seen.add(key);
      statements.push({ text, verdict: "unverifiable", claimId: claim?.id ?? null, claimKey: claim?.key ?? null, errorType: null, severity: null, evidence: null, ...judgedAgainst });
      continue;
    }
    if (!claim) { drop("claim_unknown"); continue; }
    const evidence = String(raw?.evidence ?? "").trim();
    const quote = compactText(claim.quote);
    if (compactText(evidence).length < EVIDENCE_MIN_CHARS || !quote.includes(compactText(evidence))) { drop("evidence_not_in_claim"); continue; }
    const stated = quantityTokens(text);
    const claimed = quantityTokens(claim.quote);
    if (verdict === "correct") {
      const unsupported = [...stated].filter((token) => !claimed.has(token));
      if (unsupported.length) { drop("number_not_in_claim"); continue; }
      seen.add(key);
      statements.push({ text, verdict: "correct", claimId: claim.id, claimKey: claim.key ?? null, errorType: null, severity: null, evidence, ...judgedAgainst });
      continue;
    }
    const errorType = String(raw?.errorType ?? "");
    const severity = String(raw?.severity ?? "").toUpperCase();
    if (!GEO_ERROR_TYPES.includes(errorType)) { drop("error_type_invalid"); continue; }
    if (!GEO_SEVERITIES.includes(severity)) { drop("severity_invalid"); continue; }
    if (errorType === "number") {
      const differs = [...stated].some((token) => !claimed.has(token));
      if (!claimed.size || !differs) { drop("number_matches_claim"); continue; }
    }
    seen.add(key);
    statements.push({ text, verdict: "wrong", claimId: claim.id, claimKey: claim.key ?? null, errorType, severity, evidence, ...judgedAgainst });
  }

  // The three checks after the statements. Each is re-verified by what code can decide; one that fails is dropped, never softened.
  /** @type {string[]} */
  const offLabel = [];
  for (const sentence of textList(answer.offLabel, LIMITS.offLabel)) {
    if (present(sentence)) offLabel.push(sentence);
    else dropped.push({ what: "off_label", reason: "not_in_answer", text: sentence.slice(0, 300) });
  }
  /** @type {GeoJudgeChecks["omittedSafety"]} */
  const omittedSafety = [];
  for (const alias of [...new Set(textList(answer.omittedSafety, LIMITS.omittedSafety))]) {
    const claim = claimsByAlias.get(alias);
    // Safety information the answer left out is the label's: a claim that is not shown, or not the label's, is not one.
    if (!claim) { dropped.push({ what: "omitted_safety", reason: "claim_unknown", text: alias.slice(0, 100) }); continue; }
    if (!labelClaim(claim)) { dropped.push({ what: "omitted_safety", reason: "claim_not_label", text: alias.slice(0, 100) }); continue; }
    omittedSafety.push({ claimId: claim.id, claimKey: claim.key ?? null, cardId: claim.cardId ?? null, cardClaimId: claim.cardClaimId ?? null, cardRevision: claim.cardRevision ?? null });
  }
  const linksById = new Map(built.links.map((link) => [link.id, link]));
  /** @type {GeoCitationCheck[]} */
  const citations = [];
  for (const raw of (Array.isArray(answer.citationClaims) ? answer.citationClaims : []).slice(0, LIMITS.citationClaims)) {
    const statement = String(raw?.statement ?? "").trim();
    const drop = (/** @type {string} */ reason) => dropped.push({ what: "citation_claim", reason, text: statement.slice(0, 300) });
    const link = linksById.get(String(raw?.link ?? "").trim());
    if (!link) { drop("link_unknown"); continue; }
    if (!statement || !present(statement)) { drop("statement_not_in_answer"); continue; }
    citations.push({ link: link.id, url: link.url, statement, exists: null, supports: null, evidence: null });
  }

  const entities = [];
  for (const name of textList(answer.entities, LIMITS.entities)) {
    if (present(name)) entities.push(name);
    else dropped.push({ what: "entity", reason: "not_in_answer", text: name.slice(0, 100) });
  }
  const recommendations = [];
  for (const sentence of textList(answer.recommendations, LIMITS.recommendations)) {
    if (present(sentence)) recommendations.push(sentence);
    else dropped.push({ what: "recommendation", reason: "not_in_answer", text: sentence.slice(0, 300) });
  }
  const safetyTermsHit = [];
  for (const term of textList(answer.safetyTerms, LIMITS.safetyTerms)) {
    if (present(term)) safetyTermsHit.push(term);
    else dropped.push({ what: "safety_term", reason: "not_in_answer", text: term.slice(0, 100) });
  }
  const flags = new Map(input.careFlags.map((flag) => [flag.id, flag.text]));
  const expectedIds = [...new Set(textList(answer.redFlagsExpected, flags.size))].filter((id) => flags.has(id));
  const hitIds = [...new Set(textList(answer.redFlagsHit, flags.size))].filter((id) => expectedIds.includes(id));
  const knownFindings = new Set(built.valueFindings.map((entry) => entry.id));
  const valueCoverage = [];
  const observed = new Set();
  for (const row of geoValueList(answer.valueCoverage).slice(0, 60)) {
    if (!row || !knownFindings.has(row.findingId) || observed.has(row.findingId) || !GEO_VALUE_COVERAGE_STATUSES.includes(row.status)) continue;
    const quote = typeof row.quote === "string" ? row.quote : "";
    if (quote && !present(quote)) continue;
    if (["represented", "partial", "contradicted"].includes(row.status) && !present(quote)) continue;
    observed.add(row.findingId);
    valueCoverage.push({ findingId: row.findingId, status: row.status, quote, reason: String(row.reason ?? "").slice(0, 1200),
      conditionsPreserved: typeof row.conditionsPreserved === "boolean" ? row.conditionsPreserved : null });
  }
  return {
    valueCoverage, valueBasisVersion: input.value?.version ?? 0,
    refusal: answer.refusal === true,
    statements,
    entities,
    recommendations,
    careHint: answer.careHint === true,
    redFlagExpected: expectedIds.map((id) => /** @type {string} */ (flags.get(id))),
    redFlagHits: hitIds.map((id) => /** @type {string} */ (flags.get(id))),
    safetyTermsHit,
    dropped,
    checks: { offLabel, omittedSafety, citations },
  };
}

/** The model's JSON wherever it put it. @param {unknown} content */
function parseJson(content) {
  if (typeof content !== "string" || !content.trim()) return null;
  const raw = content.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  for (const candidate of [raw, raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* the next reading */ }
  }
  return null;
}

// ───────────────────────── the judge ─────────────────────────

export class GeoJudge {
  /**
   * @param {Record<string, any>} config
   * @param {{ usageLedger?: any, callModel?: typeof callModelForControlPlane, fetchImpl?: typeof fetch }} [options]
   */
  constructor(config, { usageLedger = null, callModel = callModelForControlPlane, fetchImpl = globalThis.fetch } = {}) {
    this.config = config ?? {};
    this.usageLedger = usageLedger;
    this.callModel = callModel;
    this.fetchImpl = fetchImpl;
    this.model = String(this.config.geoJudgeModel || "deepseek-flash");
    this.counters = { calls: 0, failures: 0, dropped: 0 };
  }

  /** Whether a model call can be made at all. */
  get available() {
    return this.config.deepseekProviderEnabled === true && Boolean(this.config.deepseekApiKey);
  }

  /**
   * Judge one answer. Throws with a code when the call failed or the answer
   * held no JSON object; the caller counts attempts.
   * @param {GeoJudgeInput} input
   * @returns {Promise<GeoJudgement & { truncated: boolean }>}
   */
  async judge(input) {
    if (!this.available) throw Object.assign(new Error("The GEO judge has no model configured."), { code: "geo_judge_unavailable" });
    const built = buildJudgeInput(input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
    timer.unref?.();
    this.counters.calls += 1;
    try {
      const body = await this.callModel({ config: this.config, usageLedger: this.usageLedger, fetchImpl: this.fetchImpl }, {
        userId: input.owner.userId,
        projectId: input.owner.projectId,
        purpose: input.purpose ?? "geo",
        runId: input.missionId,
        // The module's daily budget governs, read by purpose from the ledger;
        // a researcher's personal caps must not stop measurement, nor
        // measurement spend their allowance.
        limits: { daily: 0, weekly: 0 },
        signal: controller.signal,
        body: {
          model: this.model,
          temperature: 0,
          thinking: { type: "disabled" },
          max_tokens: JUDGE_MAX_TOKENS,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: GEO_JUDGE_INSTRUCTIONS },
            { role: "user", content: `${built.prefix}\n\n${built.item}` },
          ],
        },
      });
      const choice = body?.choices?.[0];
      if (choice?.finish_reason === "length") {
        throw Object.assign(new Error("The judge's answer was cut off at its token limit."), { code: "geo_judge_truncated" });
      }
      const message = choice?.message;
      const parsed = parseJson(message?.content) ?? parseJson(message?.reasoning_content);
      const verified = verifyJudgement(parsed, built, input);
      this.counters.dropped += verified.dropped.length;
      return { ...verified, truncated: built.truncated };
    } catch (error) {
      this.counters.failures += 1;
      const value = /** @type {any} */ (error);
      const code = value?.name === "AbortError" ? "geo_judge_timeout" : typeof value?.code === "string" ? value.code : "geo_judge_failed";
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Whether a cited page says what the answer says it does: one small call with the sentence and the page's text. The quotation the
   * model gives for `yes` or `no` must be in the page's text; a verdict whose quotation is not there is dropped to `unclear`, never
   * kept. Throws with a code when the call failed, as `judge` does.
   * @param {{ owner: { userId: string, projectId: string }, statement: string, pageText: string }} input
   * @returns {Promise<{ supports: string, evidence: string | null, dropped: string | null }>}
   */
  async judgeCitation(input) {
    if (!this.available) throw Object.assign(new Error("The GEO judge has no model configured."), { code: "geo_judge_unavailable" });
    const page = input.pageText.slice(0, CITATION_PAGE_CHARS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CITATION_TIMEOUT_MS);
    timer.unref?.();
    this.counters.calls += 1;
    try {
      const body = await this.callModel({ config: this.config, usageLedger: this.usageLedger, fetchImpl: this.fetchImpl }, {
        userId: input.owner.userId, projectId: input.owner.projectId, purpose: "geo", limits: { daily: 0, weekly: 0 }, signal: controller.signal,
        body: {
          model: this.model, temperature: 0, thinking: { type: "disabled" }, max_tokens: 600, response_format: { type: "json_object" },
          messages: [
            { role: "system", content: GEO_CITATION_INSTRUCTIONS },
            { role: "user", content: JSON.stringify({ statement: input.statement, page }) },
          ],
        },
      });
      const message = body?.choices?.[0]?.message;
      const parsed = parseJson(message?.content) ?? parseJson(message?.reasoning_content);
      if (!parsed) throw Object.assign(new Error("The citation check returned no JSON object."), { code: "geo_judge_invalid" });
      const supports = GEO_CITATION_SUPPORTS.includes(String(parsed.supports)) ? String(parsed.supports) : "unclear";
      const evidence = String(parsed.evidence ?? "").trim();
      if (supports === "unclear") return { supports, evidence: null, dropped: null };
      if (compactText(evidence).length < EVIDENCE_MIN_CHARS || !compactText(page).includes(compactText(evidence))) {
        return { supports: "unclear", evidence: null, dropped: "evidence_not_in_page" };
      }
      return { supports, evidence, dropped: null };
    } catch (error) {
      this.counters.failures += 1;
      const value = /** @type {any} */ (error);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: value?.name === "AbortError" ? "geo_judge_timeout" : typeof value?.code === "string" ? value.code : "geo_judge_failed" });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Links one answer's citation check follows at most: each is a page read and a model call, under the module's daily budget. */
export const GEO_LINK_CHECKS_PER_ANSWER = 3;

/**
 * What the answer's cited links are: whether each exists (the injected `linkChecker`) and what the page says about the sentence the
 * answer attributes to it. A link nobody could read stays `exists: null`; a failed call leaves the citation unchecked. Nothing here
 * changes a verdict about the product: it is a second finding beside them.
 * @param {{ checks: GeoJudgeChecks, judge: { judgeCitation?: Function }, linkChecker: ((url: string) => Promise<{ exists: boolean, text?: string | null }>) | null,
 *   owner: { userId: string, projectId: string }, counts: Record<string, any> }} input
 */
export async function checkCitationLinks({ checks, judge, linkChecker, owner, counts }) {
  if (!linkChecker) return;
  for (const citation of checks.citations.slice(0, GEO_LINK_CHECKS_PER_ANSWER)) {
    let page;
    try { page = await linkChecker(citation.url); } catch { counts.linkUnreadable += 1; continue; }
    citation.exists = Boolean(page?.exists);
    if (!citation.exists) { counts.linkMissing += 1; continue; }
    counts.linkExists += 1;
    if (!page?.text || typeof judge.judgeCitation !== "function") continue;
    try {
      const verdict = await judge.judgeCitation({ owner, statement: citation.statement, pageText: String(page.text) });
      citation.supports = verdict.supports;
      citation.evidence = verdict.evidence;
      if (verdict.supports === "yes") counts.linkSupports += 1;
      else if (verdict.supports === "no") counts.linkContradicts += 1;
      else counts.linkUnclear += 1;
    } catch { counts.linkJudgeFailed += 1; }
  }
}

/**
 * The day's `geo` spend against the module's budget. A budget of 0 is no cap.
 * @param {import("./geoMeasureStore.mjs").GeoMeasureStore} store @param {Record<string, any>} config @param {Date} now
 */
export async function geoJudgeBudget(store, config, now) {
  const budgetCny = Number.isFinite(Number(config.geoDailyBudgetCny)) ? Number(config.geoDailyBudgetCny) : 20;
  const spentCny = await store.geoSpendSince(zonedDayStart(now, String(config.geoTimeZone || "Asia/Shanghai")));
  const exhausted = budgetCny > 0 && spentCny !== null && spentCny >= budgetCny;
  return { spentCny, budgetCny, exhausted };
}

// ───────────────────────── the parse loop ─────────────────────────

/**
 * @typedef {object} GeoParseDeps
 * @property {import("./geoMeasureStore.mjs").GeoMeasureStore} store
 * @property {Record<string, any>} config           geoDailyBudgetCny, geoTimeZone, deepseek* (the judge), geoJudgeModel
 * @property {() => Date} [now]
 * @property {{ available: boolean, judge: (input: GeoJudgeInput) => Promise<GeoJudgement & { truncated?: boolean }> }} [judge]
 * @property {any} [usageLedger]                    for the default judge
 * @property {typeof callModelForControlPlane} [callModel]
 * @property {typeof fetch} [fetchImpl]
 * @property {(event: Record<string, any>) => Promise<void> | void} [notify]   S3+ 讲错我方 (geoErrors)
 * @property {(event: Record<string, any>) => Promise<void> | void} [alertOperator]
 * @property {ReturnType<typeof geoMeasureState>} [state]
 * @property {number} [maxParse]                    answers per tick (default 10)
 * @property {((url: string) => Promise<{ exists: boolean, text?: string | null }>) | null} [linkChecker]
 *   whether a link the answer cites exists and its page's text (`OPEN_SCIENCE_GEO_LINK_CHECK_ENABLED`); without it a citation is recorded unchecked
 */

/**
 * Parse and judge the answers that have not been: code counts, the model
 * judges, code re-verifies, one facts row per answer, then the 讲错我方 of it
 * are recorded (`geoErrors.recordErrorsFromFacts`).
 * @param {GeoParseDeps} deps
 */
export async function tickParse(deps) {
  const { store, config } = deps;
  const now = deps.now ?? (() => new Date());
  const state = deps.state ?? geoMeasureState(store);
  const counts = { parsed: 0, refusals: 0, unjudged: 0, dropped: 0, failures: 0, errorsCreated: 0, notified: 0, recounted: 0,
    offLabel: 0, omittedSafety: 0, linkExists: 0, linkMissing: 0, linkUnreadable: 0, linkSupports: 0, linkContradicts: 0, linkUnclear: 0, linkJudgeFailed: 0,
    skipped: /** @type {string | null} */ (null) };
  await store.ready();
  const judge = deps.judge ?? (state.judge ??= new GeoJudge(config, { usageLedger: deps.usageLedger, callModel: deps.callModel, fetchImpl: deps.fetchImpl }));
  if (!judge.available) {
    counts.skipped = "judge_unavailable";
    // Counting again asks no model.
    counts.recounted = (await recountRegistryFacts(deps)).facts;
    return counts;
  }
  // A wider window than one tick handles, least-failed first: an answer that
  // keeps failing goes behind the others instead of blocking every later one.
  const limit = Math.max(1, deps.maxParse ?? 10);
  state.parseTicks += 1;
  const failuresOf = (/** @type {string} */ id) => (state.judgeAttempts.get(id) ?? 0) + (state.judgeStops.get(id)?.count ?? 0);
  const pending = (await store.snapshotsToParse(Math.min(500, limit * 5)))
    .map((snapshot, index) => ({ snapshot, index }))
    .sort((left, right) => failuresOf(left.snapshot.id) - failuresOf(right.snapshot.id) || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.snapshot);
  /** @type {Map<string, Awaited<ReturnType<typeof store.projectContext>>>} */
  const contexts = new Map();
  /** @type {Map<string, Map<string, any>>} */
  const questionsByProject = new Map();
  for (const snapshot of pending) {
    const budget = await geoJudgeBudget(store, config, now());
    if (budget.exhausted) {
      counts.skipped = "budget_exhausted";
      break;
    }
    const contextKey = `${snapshot.geoProjectId}:${snapshot.roundId ?? "live"}`;
    if (!contexts.has(contextKey)) contexts.set(contextKey, await store.projectContext(snapshot.geoProjectId, snapshot.roundId));
    const context = contexts.get(contextKey);
    if (!context) continue;
    if (!questionsByProject.has(snapshot.geoProjectId)) {
      const questions = await store.questions(snapshot.geoProjectId);
      questionsByProject.set(snapshot.geoProjectId, new Map(questions.map((question) => [question.id, question])));
    }
    const question = questionsByProject.get(snapshot.geoProjectId)?.get(String(snapshot.questionId)) ?? null;
    const registry = brandRegistry(context.project.product, context.project.competitors);
    /** @type {(GeoJudgement & { truncated?: boolean }) | null} */
    let judged = null;
    const stops = state.judgeStops.get(snapshot.id);
    // It stopped the judge again and again while another answer was judged in
    // the tick it first failed or since: the provider works and this answer
    // does not. Written unjudged. (In an outage only the one answer that
    // stopped the tick right after the last success can be taken for stuck.)
    const stuck = Boolean(stops && stops.count >= GEO_JUDGE_MAX_ATTEMPTS && state.lastJudgedTick >= stops.firstTick);
    if (!stuck) try {
      judged = await judge.judge({
        owner: { userId: context.project.userId, projectId: context.project.projectId },
        product: context.judgeProduct ?? context.project.product,
        competitors: context.judgeCompetitors ?? context.project.competitors,
        claims: context.claims,
        value: context.value,
        careFlags: context.careFlags,
        question: { text: question?.text ?? "", pool: question?.pool ?? null, journeyStage: question?.journeyStage ?? null },
        answer: snapshot.answerText ?? "",
        links: (Array.isArray(snapshot.citations) ? snapshot.citations : []).map((/** @type {any} */ citation) => ({ url: String(citation?.url ?? ""), title: String(citation?.title ?? "") })),
      });
    } catch (error) {
      const code = String(/** @type {any} */ (error)?.code ?? "geo_judge_failed");
      counts.failures += 1;
      // Only a failure of this answer (no usable JSON, cut off, out of time,
      // or refused by the provider as too long or malformed) counts against
      // the answer. A provider that is down, out of balance or rate-limiting
      // is not the answer's fault and will not differ on the next one: stop,
      // and try again next tick (this answer then goes behind the others).
      if (!judgeFailureIsTheAnswers(error)) {
        const previous = state.judgeStops.get(snapshot.id);
        state.judgeStops.set(snapshot.id, { count: (previous?.count ?? 0) + 1, firstTick: previous?.firstTick ?? state.parseTicks });
        counts.skipped = code;
        break;
      }
      const attempts = (state.judgeAttempts.get(snapshot.id) ?? 0) + 1;
      state.judgeAttempts.set(snapshot.id, attempts);
      if (attempts < GEO_JUDGE_MAX_ATTEMPTS) continue;
      state.judgeAttempts.delete(snapshot.id);
      judged = null;
    }
    state.judgeStops.delete(snapshot.id);
    if (judged) {
      state.lastJudgedTick = state.parseTicks;
      counts.offLabel += judged.checks.offLabel.length;
      counts.omittedSafety += judged.checks.omittedSafety.length;
      await checkCitationLinks({ checks: judged.checks, judge: /** @type {any} */ (judge), linkChecker: deps.linkChecker ?? null,
        owner: { userId: context.project.userId, projectId: context.project.projectId }, counts });
    }

    const extract = { recommendations: judged?.recommendations ?? [], entities: judged?.entities ?? [],
      valueCoverage: judged?.valueCoverage ?? [], valueBasisVersion: judged?.valueBasisVersion ?? 0, rubricVersion: GEO_JUDGE_VERSION };
    const code = parseAnswer({
      answer: snapshot.answerText,
      citations: snapshot.citations,
      registry,
      owned: context.owned,
      ...extract,
    });
    const status = snapshot.status === "valid" && judged?.refusal ? "refusal" : snapshot.status;
    const statements = judged?.statements ?? [];
    const facts = {
      ...code,
      careHint: judged ? judged.careHint : null,
      statements,
      failureMode: failureMode({ status, mentionsOurs: code.mentionsOurs, statements }),
      parserVersion: `${GEO_PARSER_VERSION}+${judged ? GEO_JUDGE_VERSION : "unjudged"}`,
      judgedAt: judged ? now().toISOString() : null,
      redFlagExpected: judged?.redFlagExpected ?? [],
      redFlagHits: judged?.redFlagHits ?? [],
      safetyTermsHit: judged?.safetyTermsHit ?? [],
      // The three checks beside the statements: a claim beyond the label, safety information left out, what the cited links say.
      checks: judged?.checks ?? {},
      // What it was counted under, and the judge's two lists it was counted
      // with: a later registry change counts it again from these, asking no model.
      registryKey: registryKey(registry, context.owned),
      judgeExtract: judged ? extract : null,
    };
    const written = await store.writeFacts(snapshot, facts, { status: status !== snapshot.status ? status : null, at: now() });
    if (!written) continue;
    counts.parsed += 1;
    if (!judged) counts.unjudged += 1;
    if (status === "refusal") counts.refusals += 1;
    if (judged?.dropped.length) {
      counts.dropped += judged.dropped.length;
      await store.appendSnapshotWarnings(snapshot.id, judged.dropped.map((entry) => `judge_dropped:${entry.what}:${entry.reason}`));
    }
    if (judged?.truncated) await store.appendSnapshotWarnings(snapshot.id, ["judge_answer_truncated"]);
    if (!judged) await store.appendSnapshotWarnings(snapshot.id, ["judge_failed"]);
    const recorded = await recordErrorsFromFacts(deps, { snapshot: { ...snapshot, status }, statements, context, question });
    counts.errorsCreated += recorded.created;
    counts.notified += recorded.notified;
  }
  // The three checks and the link checks, counted since this process started: `open_science_geo_checks_total{check}`.
  for (const key of ["offLabel", "omittedSafety", "linkExists", "linkMissing", "linkUnreadable", "linkSupports", "linkContradicts", "linkUnclear", "linkJudgeFailed"]) {
    if (counts[/** @type {keyof typeof counts} */ (key)]) state.checkTotals[key] = (state.checkTotals[key] ?? 0) + Number(counts[/** @type {keyof typeof counts} */ (key)]);
  }
  const recounted = await recountRegistryFacts(deps);
  counts.recounted = recounted.facts;
  return counts;
}

/** How often the parse loop looks for facts counted under an older registry. */
export const GEO_RECOUNT_EVERY_MS = 60_000;
/** Facts one pass counts again at most (a baseline is a few hundred). */
export const GEO_RECOUNT_PER_PASS = 2_000;

/**
 * Count again, in code, the answers a project's registry no longer matches
 * (G2, 2026-09-26: our owned domains and the rivals' names were registered
 * after the baseline was parsed and measured, and the baseline stayed on the
 * old count — a GVI of 43.89 against 38.93 under the current one, and no
 * rival in it at all, so the first weekly re-measure would read as a fall).
 *
 * A row counted under another `registry_key` has its brand and citation
 * segment recomputed from the stored answer — names, positions, list items,
 * which citations are ours — and its failure mode from its own judged
 * statements; nothing is asked of the judge. `reparsed_at` is stamped, and
 * the metrics loop measures every round whose facts are newer than its
 * numbers, so the round's cells follow on the next tick. History is not
 * rewritten otherwise: the snapshots, the judge's verdicts and the errors
 * stay as they are.
 *
 * A row parsed before the judge's lists were kept has only its stored brands
 * to go by: the judge's unregistered entities are the stored names that were
 * neither ours nor a rival, and a brand stored as in a recommendation keeps
 * that — the recommendation sentences themselves were not kept, so a name
 * newly counted is in a recommendation only when it sits in a list item.
 * @param {GeoParseDeps & { force?: boolean, geoProjectIds?: string[] | null }} deps
 * @returns {Promise<{ projects: number, facts: number, skipped: string | null }>}
 */
export async function recountRegistryFacts(deps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const state = deps.state ?? geoMeasureState(store);
  const at = now();
  if (!deps.force && state.recountAt && at.getTime() - state.recountAt < GEO_RECOUNT_EVERY_MS) return { projects: 0, facts: 0, skipped: "not_due" };
  state.recountAt = at.getTime();
  let facts = 0;
  let projects = 0;
  for (const geoProjectId of deps.geoProjectIds ?? await store.projectsWithFacts()) {
    const context = await store.projectContext(geoProjectId);
    if (!context) continue;
    const registry = brandRegistry(context.project.product, context.project.competitors);
    const key = registryKey(registry, context.owned);
    const rows = await store.factsCountedUnder(geoProjectId, key, GEO_RECOUNT_PER_PASS);
    if (!rows.length) continue;
    projects += 1;
    for (const row of rows) {
      // The inclusion channel said only whether the brand words were found,
      // under the keywords it was sent; there is no text to count again.
      if (row.surface?.mode === "inclusion" || !row.answerText) {
        await store.recountFacts(row.snapshotId, null, { key, at });
        continue;
      }
      await store.recountFacts(row.snapshotId, recountedFacts(row, registry, context.owned), { key, at });
      facts += 1;
    }
  }
  return { projects, facts, skipped: null };
}

/**
 * One stored answer counted under a registry, with its own judged statements.
 * @param {{ brands: any[], statements: any[], judgeExtract: { recommendations?: string[], entities?: string[] } | null, status: string,
 *   answerText: string | null, citations: any[] }} row
 * @param {ReturnType<typeof brandRegistry>} registry @param {{ domains?: string[], urls?: string[] }} owned
 */
export function recountedFacts(row, registry, owned) {
  const stored = Array.isArray(row.brands) ? row.brands : [];
  const extract = row.judgeExtract;
  const entities = Array.isArray(extract?.entities) ? extract.entities
    : stored.filter((brand) => brand && !brand.ours).map((brand) => String(brand.name ?? "")).filter(Boolean);
  const code = parseAnswer({
    answer: row.answerText, citations: row.citations, registry, owned,
    recommendations: Array.isArray(extract?.recommendations) ? extract.recommendations : [], entities,
  });
  if (!extract) {
    const recommended = new Set(stored.filter((brand) => brand?.inRecommendation === true).map((brand) => foldText(brand.name)));
    for (const brand of code.brands) if (recommended.has(foldText(brand.name))) brand.inRecommendation = true;
    code.recommendedOurs = code.brands.some((brand) => brand.ours && brand.inRecommendation);
  }
  const statements = Array.isArray(row.statements) ? row.statements : [];
  return { ...code, failureMode: failureMode({ status: row.status, mentionsOurs: code.mentionsOurs, statements }) };
}
