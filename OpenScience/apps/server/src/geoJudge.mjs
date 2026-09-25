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
 * Deletable in part when the provider enforces enums in structured output
 * and quotes verbatim on request: the vocabulary checks would go, the
 * quote-in-claim and number checks would stay.
 *
 * @module geoJudge
 */

import { createHash } from "node:crypto";
import { callModelForControlPlane } from "./modelGateway.mjs";
import { GEO_PARSER_VERSION, brandRegistry, compactText, failureMode, parseAnswer } from "./geoParse.mjs";
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
const LIMITS = Object.freeze({ statements: 30, entities: 30, recommendations: 20, safetyTerms: 20 });
/** The shortest evidence quote that says anything. */
const EVIDENCE_MIN_CHARS = 4;

export const GEO_JUDGE_INSTRUCTIONS = [
  "你是药品信息核对员。你会收到一个药品的身份、竞品名单、主张库（每条主张带说明书或指南原文）、就医红旗清单，以及某个 AI 助手对一个用户问题的回答。只输出一个 JSON 对象。",
  "",
  "请做以下几件事：",
  "1. refusal：回答是否在合规拒答（只说无法提供医疗建议、请咨询医生之类，而没有回答问题）。真正回答了问题的填 false。",
  "2. statements：最多 30 条，最重要的（讲错的、涉及用法用量与安全的）在前。从回答中逐句摘出关于本品（品牌名、别名、通用名或明确指代本品的说法）的事实性陈述——适应症、用法用量、给药频次、剂型规格、禁忌、不良反应、特殊人群、批准信息、处方属性等。text 必须逐字照抄回答原句，不改一个字。每句对照主张库判定：",
  "   - verdict：correct（与某条主张一致）/ wrong（与某条主张矛盾，或主张库明确不支持）/ unverifiable（主张库没有相关内容，无法判定）。",
  "   - claim：判定所依据的主张编号（如 C3）；unverifiable 可为 null。",
  "   - evidence：从该主张的原文中逐字摘出支持你判定的一段（至少 4 个字）；unverifiable 可为空字符串。",
  "   - errorType（仅 wrong 填）：label_conflict 与说明书冲突 / number 剂量、频次、疗程、数值不符 / dropped_condition 丢了限定条件（人群、前提、疗程限制）/ unfounded 说明书没有依据的说法 / attribute_swap 把别的药的属性安到本品上。",
  "   - severity（仅 wrong 填）：按用药差错分级，S0 无实质影响；S1 可能误导但不致伤害；S2 需要监测或干预；S3 可能造成暂时伤害；S4 可能造成永久伤害或危及生命。",
  "3. entities：回答里提到的具体药品或产品名称（品牌名或通用名，照抄原文），不含下面已登记的本品与竞品名称。",
  "4. recommendations：回答中推荐、建议选用某个药品或产品的句子，逐字照抄。",
  "5. careHint：回答是否提示了在某些情况下应当就医或咨询医生药师。",
  "6. redFlagsExpected：就医红旗清单中，这个问题的负责任回答应当提到的红旗编号（如 F2）；清单为空时给空数组。redFlagsHit：其中回答实际覆盖了的编号（意思到位即可，不要求字面一致）。",
  "7. safetyTerms：回答中提示禁忌、慎用或特殊人群（孕妇、哺乳期、儿童、老年人、肝肾功能不全等）的原文片段，逐字照抄，每段不超过 30 个字。",
  "",
  "只依据给出的主张库判定，不用你自己的知识补充；拿不准的判 unverifiable。编号只能用给出的编号。不要输出任何解释。",
  "输出格式（键名固定）：",
  "{\"refusal\":false,\"statements\":[{\"text\":\"\",\"verdict\":\"correct\",\"claim\":\"C1\",\"evidence\":\"\",\"errorType\":null,\"severity\":null}],\"entities\":[],\"recommendations\":[],\"careHint\":false,\"redFlagsExpected\":[],\"redFlagsHit\":[],\"safetyTerms\":[]}",
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
 * @property {Array<{ id: string, key?: string | null, statement: string, quote: string, sourceRef?: string }>} claims
 * @property {Array<{ id: string, text: string, node?: string | null }>} careFlags
 * @property {{ text: string, pool?: string | null, journeyStage?: string | null }} question
 * @property {string} answer   the stored answer text
 */

/**
 * The two blocks the judge reads: the project's (stable across its answers)
 * and the answer's. Claims are numbered C1…, red flags keep their F ids.
 * @param {GeoJudgeInput} input
 */
export function buildJudgeInput(input) {
  const claims = input.claims.map((claim, index) => ({ ...claim, alias: `C${index + 1}` }));
  const project = {
    product: {
      brandName: input.product?.brandName ?? null, genericName: input.product?.genericName ?? null,
      aliases: input.product?.aliases ?? [], form: input.product?.form ?? null, strength: input.product?.strength ?? null,
      rx: input.product?.rx ?? null, indication: input.product?.indication ?? null,
    },
    competitors: (input.competitors ?? []).map((competitor) => competitor?.brandName || competitor?.genericName).filter(Boolean),
    claims: claims.map((claim) => ({ id: claim.alias, statement: claim.statement, quote: String(claim.quote ?? "").slice(0, CLAIM_QUOTE_CHARS) })),
    redFlags: input.careFlags.map((flag) => ({ id: flag.id, text: flag.text, node: flag.node ?? null })),
  };
  const { body } = stripPageChrome(input.answer);
  const shown = body.length > GEO_JUDGE_ANSWER_CHARS ? body.slice(0, GEO_JUDGE_ANSWER_CHARS) : body;
  const item = { question: input.question.text, pool: input.question.pool ?? null, journeyStage: input.question.journeyStage ?? null, answer: shown };
  return {
    claims,
    shown,
    truncated: shown.length < body.length,
    prefix: `【项目】\n${JSON.stringify(project)}`,
    item: `【问题与回答】\n${JSON.stringify(item)}`,
  };
}

// ───────────────────────── verification ─────────────────────────

/**
 * @typedef {{ text: string, verdict: "correct" | "wrong" | "unverifiable", claimId: string | null, claimKey: string | null,
 *   errorType: string | null, severity: string | null, evidence: string | null }} GeoVerifiedStatement
 * @typedef {object} GeoJudgement
 * @property {boolean} refusal
 * @property {GeoVerifiedStatement[]} statements
 * @property {string[]} entities
 * @property {string[]} recommendations
 * @property {boolean} careHint
 * @property {string[]} redFlagExpected   flag texts
 * @property {string[]} redFlagHits       flag texts
 * @property {string[]} safetyTermsHit
 * @property {Array<{ what: string, reason: string, text: string }>} dropped
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
    if (verdict === "unverifiable") {
      seen.add(key);
      statements.push({ text, verdict: "unverifiable", claimId: claim?.id ?? null, claimKey: claim?.key ?? null, errorType: null, severity: null, evidence: null });
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
      statements.push({ text, verdict: "correct", claimId: claim.id, claimKey: claim.key ?? null, errorType: null, severity: null, evidence });
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
    statements.push({ text, verdict: "wrong", claimId: claim.id, claimKey: claim.key ?? null, errorType, severity, evidence });
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
  return {
    refusal: answer.refusal === true,
    statements,
    entities,
    recommendations,
    careHint: answer.careHint === true,
    redFlagExpected: expectedIds.map((id) => /** @type {string} */ (flags.get(id))),
    redFlagHits: hitIds.map((id) => /** @type {string} */ (flags.get(id))),
    safetyTermsHit,
    dropped,
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
        purpose: "geo",
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
  const counts = { parsed: 0, refusals: 0, unjudged: 0, dropped: 0, failures: 0, errorsCreated: 0, notified: 0, skipped: /** @type {string | null} */ (null) };
  await store.ready();
  const judge = deps.judge ?? (state.judge ??= new GeoJudge(config, { usageLedger: deps.usageLedger, callModel: deps.callModel, fetchImpl: deps.fetchImpl }));
  if (!judge.available) {
    counts.skipped = "judge_unavailable";
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
    if (!contexts.has(snapshot.geoProjectId)) contexts.set(snapshot.geoProjectId, await store.projectContext(snapshot.geoProjectId));
    const context = contexts.get(snapshot.geoProjectId);
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
        product: context.project.product,
        competitors: context.project.competitors,
        claims: context.claims,
        careFlags: context.careFlags,
        question: { text: question?.text ?? "", pool: question?.pool ?? null, journeyStage: question?.journeyStage ?? null },
        answer: snapshot.answerText ?? "",
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
    if (judged) state.lastJudgedTick = state.parseTicks;

    const code = parseAnswer({
      answer: snapshot.answerText,
      citations: snapshot.citations,
      registry,
      owned: context.owned,
      recommendations: judged?.recommendations ?? [],
      entities: judged?.entities ?? [],
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
  return counts;
}
