// The pharmacist-editable safety rules travel with this module as data, not as
// a path: `@evimed/domain` must stay importable from a browser bundle and from
// a plugin sandbox, so it may not reach for `node:fs` (§14 rule 3). The import
// attribute is the ESM way to say "this file is data", and it keeps the rules
// exactly one file rather than one file plus a loader.
import clinicalSafetyRulesData from "./clinical-safety-rules.json" with { type: "json" };
import { claimAppraisalFindings } from "./appraisalStructure.mjs";

const claimFields = Object.freeze([
  "claimId",
  "claim",
  "sourceUrl",
  "sourceTitle",
  "artifactPath",
  "identifier",
  "accessLevel",
  "supportQuote",
  "applicability",
  "uncertainty",
]);
const accessLevels = new Set(["full_text", "official_page", "abstract", "structured_record"]);
// A "synthesized" claim states a cross-source conclusion (e.g. "the evidence
// leans toward X") that no single source phrases verbatim. It trades the
// single-source verbatim bond for a stricter package: at least two distinct
// preserved sources, each with its own verbatim quote, plus an explicit
// confidence label and machine-verifiable numeric limits.
// A "derived" claim is the analyst's own result: an estimate, a bound, an
// extrapolation, a mechanistic inference. By construction no source states it,
// so demanding a verbatim quote for it made original analysis unpublishable —
// a report that had found borneol's vapour pressure and a sealed-system loss
// curve could not put the two together and estimate an opened-container loss,
// because the estimate's numbers appear in no source. Every run therefore
// learned the one safe move: restate sources, declare the gap, stop.
//
// It is not exempt from scrutiny, it is scrutinised differently. It must name
// the quote-anchored claims it reasons from, state the method that takes those
// inputs to this result, state the assumptions it rests on, and say what the
// result is sensitive to. The audit then checks the derivation is complete and
// grounded rather than checking the number against a source that cannot have
// it. The report must mark it as derived, and it may never carry the practical
// safety advice — that section stays measured evidence only.
const claimTypes = new Set(["direct", "synthesized", "derived"]);
const synthesizedConfidenceLevels = new Set(["high", "moderate", "low"]);
const synthesizedBaseFields = Object.freeze(["claimId", "claim", "applicability", "uncertainty"]);
const derivedBaseFields = Object.freeze([
  "claimId",
  "claim",
  "method",
  "assumptions",
  "sensitivity",
  "applicability",
  "uncertainty",
]);
// How a derived result is marked in the report so a reader can never take it
// for a measurement.
const derivedReportLabelPattern = /[〔［【(（[]\s*(?:推导|推算|估算|derived|estimated)\s*[〕］】)）\]]/i;
const synthesizedSourceFields = Object.freeze(["sourceUrl", "sourceTitle", "artifactPath", "accessLevel", "supportQuote"]);
const sourceCountWordPattern = /(?:研究|试验|项|篇|文献|stud(?:y|ies)|trials?|sources?|records?)/i;
const claimIdPattern = /^CLM-[0-9]{3,6}$/;
const operationalFailurePattern = /(?:Transport error|Runtime configuration bootstrap|网页访问失败|工具调用失败|public[_ -]source[_ -]gateway.*(?:failed|error))/i;
// Runtime/retrieval-process leakage — banned anywhere in the report. Tool and
// gateway names, artifact paths, and first-person retrieval diaries are never
// scientific analysis.
//
// 工件 / 访问层级 / 本环境 / 本轮检索 / 检索环境 are the runtime's own nouns for
// a preserved artifact, an accessLevel field, the container, and one retrieval
// pass. They were the most common Chinese wording of this leak and none of them
// was matched: nine of fifteen production reports carried one (工件 19 times,
// 本环境 13, 访问层级 12) and every one of them was delivered.
// The MCP server is mounted as `evimed`, so DSH shows its tools to the model
// as `mcp__evimed__<tool>`. Both spellings are banned: a run that has read an
// older skill file will reproduce the legacy one.
// 基本环境/日本环境/样本环境 and 加工件 are ordinary words that contain these,
// so each is anchored away from its innocent compounds.
const runtimeLeakagePattern = /(?:clinical-evidence-synthesis|\bmcp__evimed__[a-z_]+\b|\bevimed_[a-z_]+\b|EviMed.{0,24}(?:引擎|网关|工具)|证据追溯契约|\.evimed-sources\/|(?:抓取|落盘).{0,16}(?:核验|来源|文件|原文)|白名单抓取|工具调用|(?<!加)工件|访问层级|(?<![基日样标根成])本环境|本轮检索|检索环境|(?:未触及|未读取|未检索).{0,16}(?:完整|全文|文件|页面))/i;
// A material limit on evidence accessibility (e.g. a guideline whose full text
// is not openly available) is a legitimate property of the evidence base. It is
// banned in the analysis body but permitted inside the Limitations section.
const evidenceAccessLimitationPattern = /(?:全文|页面|文件).{0,12}(?:不可及|无法获取|无法获得|未能获取|未能获得|不可得)/i;
const emergencyCallClaimPattern = /(?:(?:呼叫|拨打).{0,16}(?:急救|120|999)|(?:急救|120|999).{0,16}(?:呼叫|拨打))/i;
const emergencyCallSupportPattern = /(?:call.{0,16}(?:999|emergency|ambulance)|(?:999|emergency|ambulance).{0,16}call|呼叫|拨打|急救)/i;
// Generic (non-drug-specific) safety rule. Drug- and scenario-specific rules
// live in clinical-safety-rules.json so pharmacists can maintain them as data.
const exclusiveSafetyPattern = /(?:(?:唯一(?:的)?(?:(?:(?:且|并且|同时)?(?:安全|可靠|正确|推荐|可行|适当|合理)(?:的)?|的、(?:安全|可靠|正确|推荐|可行|适当|合理)(?:的)?))?(?:(?:(?:应当|应该|应|可以|需要|必须)(?:采取|使用|选择|采用)?(?:的)?|(?:采取|使用|选择|采用)(?:的)?))?|(?:安全|可靠|正确)(?:的)?唯一(?:的)?(?:(?:(?:应当|应该|应|可以|需要|必须)(?:采取|使用|选择|采用)?(?:的)?|(?:采取|使用|选择|采用)(?:的)?))?)(?:处置|治疗|用药|剂量|停药|换药|诊疗|急救|就医|转诊|救治|预防|检查|诊断|筛查|监测)(?:的)?(?:策略|方法|途径|方案|选择|建议)|(?:处置|治疗|用药|剂量|停药|换药|诊疗|急救|就医|转诊|救治|预防|检查|诊断|筛查|监测)(?:是|为)唯一(?:的)?(?:(?:(?:且|并且|同时)?(?:安全|可靠|正确|推荐|可行|适当|合理)(?:的)?|的、(?:安全|可靠|正确|推荐|可行|适当|合理)(?:的)?))?(?:(?:(?:应当|应该|应|可以|需要|必须)(?:采取|使用|选择|采用)?(?:的)?|(?:采取|使用|选择|采用)(?:的)?))?(?:的)?(?:策略|方法|途径|方案|选择|建议))/i;
// The heading the safety-first practical answer sits under. It was
// 安全优先的实际处置; the manuscript rewrite renames it 临床实践要点. Every
// safety check on that section finds it by name, so a rename that stopped
// matching would take those checks with it silently — the section would simply
// be "not present" and nothing in it would be audited. Both names, and the
// shapes runs have used in between, resolve to the same section.
const practicalSectionHeading = "安全优先的实际处置|实际处置|实用回答|临床实践要点|临床要点|实用|怎么办|Practical";
const practicalHeadingLinePattern = new RegExp(`(?:^|\\n)##\\s+[^\\n]*(?:${practicalSectionHeading})[^\\n]*$`, "im");
// --- Emergency dispatch is never conditioned on a medicine's effect --------
// Inside the practical section an emergency-call instruction states its trigger
// in symptoms and signs. A trigger phrased as "the drug did not work" —
// 含药不缓解, 服药后无效, 含服 20 分钟不缓解 — cancels the unconditional rule the
// same section always also carries (服药不是等待的理由，应在服药的同时呼叫急救),
// and a reader cannot execute both. It is forbidden even when a guideline says
// exactly that: the guideline's conditional wording is restated in 结果, where
// this check does not run, and the practice point stays unconditional.
//
// The existing safety rules cannot see it. `medication-response-not-diagnostic`
// needs the drug response tied to a triage verdict, and this sends the reader
// TO care; `suxiao-must-not-delay-emergency` checks the required sentence is
// present and never that a contradicting one is absent — every offending report
// carries the required sentence too, which is why they read as compliant.
const emergencyDrugWords = "含服|含化|含药|服药|服用|用药|口服|舌下|给药|服下|吃药|嚼服|吞服|喷服";
// Non-relief is a morphology, not a phrase list. Listing the phrases meant that
// 未见效 (the list held 不见效), 无好转, 未获缓解, 未能奏效, 症状持续存在 and
// 疼痛不减轻 all walked past a rule that already rejected 不见效 and 不缓解 —
// same instruction, one character different. What the rule is about is a
// negator scoping over a relief predicate, so that is what it matches.
//
// The relief predicates split in two, and the split is what lets one of the two
// stand without a medication word in front of it:
//   RELIEF   — 缓解 / 好转 / 减轻: predicated of a *symptom*. 胸痛持续 20 分钟
//              不缓解 is a legitimate, symptom-stated trigger, so this half
//              means nothing until a medication word anchors it.
//   EFFICACY — 见效 / 奏效 / 起效 / 疗效 / 无效: only a treatment can be their
//              subject. 「若硝酸甘油未能奏效，应立即拨打 120」 names the drug
//              instead of the act of taking it and so carries no medication
//              *word* at all, yet the predicate presupposes one. This half
//              therefore needs no anchor — and in exchange a rejection anywhere
//              earlier in the sentence licenses it, since 而非服药后观察无效再呼叫
//              writes the forbidden sequence out in order to forbid it.
const emergencyReliefWords = "缓解|好转|改善|减轻|缓和|消失|消退|平息|减退|控制";
const emergencyEfficacyWords = "见效|奏效|起效|生效|有效|效果|疗效|效";
const emergencyNegators = "[不未无没莫]";
// A closed set of light verbs and degree adverbs, not a wildcard: 无论是否缓解
// must not read as a negated relief predicate.
const emergencyNegationHelpers = "(?:能|可|见|获|得|予|会|再|有|够|完全|明显|充分|显著|彻底){0,2}";
const emergencyDegreeWords = "明显|佳|好|全|够|理想|满意|充分";
const emergencyPersistWords = "持续存在|持续不退|持续不解|仍(?:然|旧)?存在|依然存在|依旧存在|症状持续|疼痛持续|胸痛持续";
const emergencyEfficacyFailure = [
  `${emergencyNegators}${emergencyNegationHelpers}(?:${emergencyEfficacyWords})`,
  `(?:疗效|药效|效果)${emergencyNegators}(?:${emergencyDegreeWords})`,
].join("|");
const emergencyFailureWords = [
  `${emergencyNegators}${emergencyNegationHelpers}(?:${emergencyReliefWords})`,
  `(?:${emergencyReliefWords})${emergencyNegators}(?:${emergencyDegreeWords})`,
  emergencyPersistWords,
  emergencyEfficacyFailure,
].join("|");
// Writing the forbidden order in order to forbid it is the compliant shape, so
// the negation is what separates the two. 不等同/不代表/不意味 belong to the same
// family as 不构成: they deny that the medicine's response settles anything,
// which is the inference this rule exists to ban.
const emergencyRejectWords = "不宜|而非|而不是|不是|并非|不得|不应|不能|不可|不要|勿|无论|不论|均不|都不|不因|不以|不作为|不构成|不等同|不代表|不意味";
const emergencyDispatchPattern = /(?:呼叫|拨打|呼救|叫)[^。！？\n]{0,8}(?:120|999|急救|救护)|(?:急救|120|999)[^。！？\n]{0,8}(?:呼叫|拨打|呼救)/;
// One notion of a clause, shared by both halves of this check. It used to read
// the span with one boundary set (。！？：\n) and look for the licensing
// rejection with another (；：;:), so 「症状经首次含服明显改善后，方可每间隔 5
// 分钟重复给药；未完全缓解即呼叫 120」 was read as a single condition spanning
// 「给药；未完全缓解」 — while the clause after the semicolon contains no
// medication word at all and points at calling 120 *sooner*.
//
// A comma is a clause boundary here with one exception, and the exception is
// grammatical rather than convenient: a comma that closes a temporal or
// conditional clause (…后，/…时，) does not end the condition, it hands it on.
// 「若含服硝酸甘油后，症状仍不缓解，应立即拨打 120」 is one trigger written across
// that comma, and inserting it was the cheapest way past this rule there was.
// 「已服药者，出现新发晕厥…」 keeps its boundary: 者 closes a population
// qualifier, not a condition.
//
// The gap stays tempered against rejection words on top of that: without it
// 用药 reaches across 而非 to 无效 and the compliant sentence
// 而非服药后观察无效再呼叫 is read as the violation it rejects.
const emergencyClauseBoundary = /[。！？；：、，;:,\n]/g;
const emergencyClauseGap = `(?:(?!${emergencyRejectWords}|[。！？；：、，;:,\\n]).|(?<=[后时])[，,])`;
const medicationConditionedTrigger = new RegExp(`(?:${emergencyDrugWords})${emergencyClauseGap}{0,20}(?:${emergencyFailureWords})`, "g");
const timedObservationTrigger = new RegExp(
  `(?:观察|等待|等)\\s*[0-9０-９一二三四五六七八九十]{1,3}\\s*(?:分钟|分|小时|min)`
  + `${emergencyClauseGap}{0,10}(?:${emergencyFailureWords})`,
  "g",
);
// The medication act and the trigger it conditions need not share a sentence:
// 「含服硝酸甘油一片后观察。仍不缓解者拨打 120。」 splits them with a full stop and
// resumes with an anaphor whose antecedent is the medication act. An elided
// subject picked up by 仍 / 依然 / 若仍 is that antecedent; this branch runs only
// where a medication word has already been stated on the same line.
const emergencyAnaphora = "仍|依然|依旧|仍旧|如仍|若仍|经上述处理|上述处理后";
const anaphoricFailureTrigger = new RegExp(`(?:${emergencyAnaphora})${emergencyClauseGap}{0,10}(?:${emergencyFailureWords})`, "g");
const efficacyFailureTrigger = new RegExp(`(?:${emergencyEfficacyFailure})`, "g");
const emergencyRejectClause = new RegExp(emergencyRejectWords);
const emergencyDrugClause = new RegExp(emergencyDrugWords);
const emergencyReliefClause = new RegExp(emergencyReliefWords);
// A sentence that names the dispatch and then states when to make it puts the
// call before its own trigger, so trigger-then-dispatch order does not hold.
const emergencyConditionFrame = /(?:条件|前提|标准|指征|时机|情形|情况下)/;
// Things other than the medicine whose working or not working this section
// legitimately discusses. The unanchored efficacy branch has no medication
// word to check, so it has to be told what it is not looking at.
const emergencyNonTreatmentSubject = /(?:判断|鉴别|识别|区分|呼救|呼叫|求救|送医|就医|驾车|自驾|等待|观察|评估|筛查)/;

/**
 * One gate finding, and the identity of the check that raised it.
 *
 * The text is the product and is never rewritten here: the repair loop hands it
 * back to the run verbatim, so a changed word is a changed behaviour. `check`
 * is the half that was missing. The gate ledger recorded what the gate said and
 * never which rule said it, so no rule's false-positive rate could be computed
 * for any of the 129 findings this module raises — and principle #4 wants an
 * observed distribution before a blocking decision changes.
 *
 * `check` is null only where nothing claimed the finding. That is a hole and it
 * is left visible as one, rather than filled with "unknown": an attribution
 * that defaults looks like coverage while measuring nothing.
 * @typedef {{ check: string | null, text: string, rule?: string, line?: number }} AttributedIssue
 */

/**
 * Names the check that a finding function is, at the function itself.
 *
 * At the function boundary rather than at each `push`: a name written once per
 * rule cannot drift from the rule, and 129 hand-written names would. The id is
 * carried by the function object, so `IssueLog#from` reads it from the very
 * thing that raised the findings instead of being told twice.
 * @template {Function} F
 * @param {F} fn
 * @param {string} id
 * @returns {F}
 */
function checkedBy(fn, id) {
  return Object.defineProperty(fn, "checkId", { value: id });
}

/**
 * The check a finding function declared, for a caller that raises the findings
 * itself rather than pushing them through an `IssueLog`.
 *
 * It throws rather than returning undefined. A caller that got `undefined` here
 * would attach no attribution and say nothing about it, which is the shape of
 * failure this module keeps meeting: a measurement that quietly stops
 * measuring.
 * @param {Function} fn
 * @returns {string}
 */
export function checkIdOf(fn) {
  const id = /** @type {any} */ (fn).checkId;
  if (typeof id !== "string" || !id) {
    throw new TypeError(
      `${fn?.name || "an anonymous finding function"} raises gate issues without naming its check; `
      + 'declare it at the function with checkedBy(fn, "<check-id>").',
    );
  }
  return id;
}

/**
 * The gate's findings as they accumulate, each carrying its check.
 *
 * It stands in for the plain array the validator used to push into, so every
 * existing `issues.push(...)` site is unchanged and no call site can disagree
 * with its own attribution. An inline rule declares its region once; a finding
 * function supplies its own id through `from()`, which refuses to run one that
 * has not declared it — a finding function whose id was dropped fails loudly
 * instead of inheriting whatever region happened to be current.
 */
class IssueLog {
  constructor() {
    /** @type {AttributedIssue[]} */
    this.found = [];
    /** @type {string | null} */
    this.current = null;
  }

  /** The check that raised everything pushed until the next declaration.
   *  @param {string} id @returns {void} */
  region(id) {
    this.current = id;
  }

  /** Runs a finding function under its own declared check. The findings keep
   *  their own type: this is a pass-through, and a caller that reads
   *  `finding.leg` must still be told when that field is gone.
   *  @template {(...args: any[]) => any} F
   *  @param {F} fn @param {Parameters<F>} args @returns {ReturnType<F>} */
  from(fn, ...args) {
    this.current = checkIdOf(fn);
    return fn(...args);
  }

  /** @param {...any} texts @returns {number} */
  push(...texts) {
    for (const text of texts) this.found.push({ check: this.current, text: String(text) });
    return this.found.length;
  }

  /** A finding that knows more than its check: which rule inside that check
   *  fired, and which line it fired on. Both stay optional and neither
   *  defaults — a finding without a rule is one finding's worth of
   *  unattributed, not a bucket named "unknown", for the same reason `check`
   *  is left null rather than filled in (see the typedef).
   *  @param {{ text: string, rule?: string, line?: number | null }} finding
   *  @returns {number} */
  pushAttributed(finding) {
    this.found.push({
      check: this.current,
      text: String(finding.text),
      ...(finding.rule ? { rule: String(finding.rule) } : {}),
      ...(Number.isInteger(finding.line) && Number(finding.line) > 0 ? { line: Number(finding.line) } : {}),
    });
    return this.found.length;
  }

  /** @returns {AttributedIssue[]} */
  all() {
    return [...this.found];
  }

  /** @returns {string[]} */
  texts() {
    return this.found.map((entry) => entry.text);
  }
}

/**
 * Every check this module can attribute a finding to.
 *
 * Not decoration: it is the axis a false-positive distribution is computed
 * along, and it is what lets a test say "this id is not one of ours" instead of
 * discovering a typo months later as a bucket nobody looked at. The ids are
 * declared where the check is — `issues.region(...)` for an inline rule,
 * `checkedBy(fn, ...)` at a finding function — and a test in this package reads
 * both out of the source and refuses any that is missing from this list.
 *
 * Two of them are raised by the contract registry rather than here:
 * `citation-integrity` and `advisory-notes` name functions this module exports
 * for that caller to run.
 * @type {readonly string[]}
 */
export const clinicalEvidenceCheckIds = Object.freeze([
  "emergency-trigger-conditioned",
  "appraisal-declaration",
  "citation-closure",
  "attributed-stance",
  "regulatory-article",
  "clinical-safety-rules",
  "citation-integrity",
  "manuscript-register",
  "synthesized-claim",
  "report-present",
  "report-sections",
  "practical-section",
  "deep-research-sections",
  "reference-list-order",
  "visible-claim-marker",
  "operational-failure-prose",
  "runtime-leakage",
  "claim-marker-format",
  "internal-api-citation",
  "exclusive-safety",
  "matrix-present",
  "matrix-schema",
  "claim-schema",
  "derived-claim-inputs",
  "claim-access-level",
  "claim-reference-number",
  "claim-support-quote",
  "claim-emergency-support",
  "claim-numeric-support",
  "claim-artifact-path",
  "claim-quote-verbatim",
  "claim-source-url",
  "report-claim-unresolved",
  "matrix-claim-uncited",
  "derived-claim-grounding",
  "derived-report-label",
  "report-number-unanchored",
  "report-number-unsupported",
  "record-identifier-leak",
  "practical-derived-claim",
  "practical-claim-anchor",
  "reference-list-duplication",
  "reference-number-unresolved",
  "claim-inline-citation",
  "advisory-notes",
  // The structured appraisal a claim may carry (`appraisalStructure.mjs`):
  // PICO parts and their quotes, a GRADE certainty in parts, a risk-of-bias
  // record by a named tool. Advisory, every one — none is named in
  // CLINICAL_CHECK_TIERS, and owner decision 5 (2026-09-18) is that medical
  // assets add information, never interception.
  "claim-pico-schema",
  "claim-pico-quote",
  "claim-certainty-schema",
  "claim-certainty-arithmetic",
  "claim-certainty-design",
  "claim-rob-schema",
  "claim-rob-overall",
]);

/**
 * What a finding of each check does to a package (2026-09-17).
 *
 * Until now the rule was "everything blocks unless its sentence is on a
 * degradable list", and what that blocked was measured on twelve live runs
 * (memory-ablation v9): of the 52 `required` findings still open at the last
 * submission, 65% were the package's own bookkeeping — `question-coverage`
 * line numbers, run-receipt statistics, self-declared quality checks — which no
 * reader ever sees; 15% were prose patterns with visible false positives
 * (`comparative-structure` fired on 「替代终点」, a surrogate endpoint, as "one
 * arm can take the other's place"); and about 10% were the one thing this
 * product exists to catch, a quotation that is not in the source it names.
 * 63% of all run time went to that loop and 0 of 12 packages passed it clean.
 *
 * So the default is inverted. A check blocks only when it is named here:
 *
 *   - `blocking` — the package cannot be read at all, or the defect is one a
 *     reader cannot see for themselves (a quote absent from its source, a claim
 *     bound to nothing, an estimate passed off as a measurement). The run is
 *     told it must fix these while it still can; a package delivered with one
 *     open is labelled unverified. It is never withheld for it.
 *   - `safety` — clinical framing that could hurt somebody. Same treatment in
 *     the run, and named to the reader first. Not withheld either: these rules
 *     are patterns over prose whose false-positive rate nobody has measured,
 *     and principle 4 asks for that distribution before a rule may block.
 *
 * Anything not named is `advisory`: said to the run as a suggestion and to the
 * reader as a notice.
 *
 * The bookkeeping itself is gone. For one batch it was a third tier, `silent`
 * (run and counted, reported to nobody), while memory-ablation v10 ran the same
 * twelve cells without it; then the checks were deleted together with the six
 * files they read — the search log, the run receipt, the question ledger, the
 * citation ledger, the citation audit and references.bib. A package is the
 * report and the matrix. What the run searched and preserved is the platform's
 * own record (the evidence ledger), not a file the model types.
 * @type {Readonly<Record<string, 'blocking' | 'safety'>>}
 */
export const CLINICAL_CHECK_TIERS = Object.freeze({
  "report-present": "blocking",
  "matrix-present": "blocking",
  "matrix-schema": "blocking",
  "claim-schema": "blocking",
  "claim-support-quote": "blocking",
  "claim-artifact-path": "blocking",
  "claim-quote-verbatim": "blocking",
  "synthesized-claim": "blocking",
  "derived-claim-inputs": "blocking",
  "derived-claim-grounding": "blocking",
  "derived-report-label": "blocking",
  "report-claim-unresolved": "blocking",
  "clinical-safety-rules": "safety",
  "emergency-trigger-conditioned": "safety",
  "exclusive-safety": "safety",
  "claim-emergency-support": "safety",
  "practical-derived-claim": "safety",
  "practical-claim-anchor": "safety",
});

/** @param {string | null | undefined} check @returns {'blocking' | 'safety' | 'advisory'} */
export function clinicalCheckTier(check) {
  return CLINICAL_CHECK_TIERS[String(check ?? "")] ?? "advisory";
}

/** The practical section with claim markers, emphasis and numbered citations
 *  taken out, so neither can inflate the gap between a medication word and a
 *  non-relief word. Line count is preserved: the notice names a line.
 *  @param {any} practical
 */
function normalizedPracticalText(practical) {
  return String(practical ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\[\s*\d+(?:\s*[,\-–]\s*\d+)*\s*\]/g, " ")
    .replace(/[ \t\u3000]+/g, " ");
}

/** The index of the last clause boundary in a passage, or -1.
 *  @param {string} passage
 */
function lastClauseBoundary(passage) {
  let index = -1;
  emergencyClauseBoundary.lastIndex = 0;
  for (const match of passage.matchAll(emergencyClauseBoundary)) index = match.index;
  return index;
}

/** Every emergency-call sentence in the practical section whose trigger is how
 *  a self-administered medicine performed.
 *  @param {any} practical
 *  @returns {{ line: number, span: string, sentence: string }[]}
 */
function medicationConditionedEmergencyTriggers(practical) {
  const found = [];
  for (const [lineIndex, rawLine] of normalizedPracticalText(practical).split("\n").entries()) {
    let medicationStated = false;
    for (const sentence of rawLine.split(/[。！？]/)) {
      const carriesMedication = emergencyDrugClause.test(sentence);
      if (!emergencyDispatchPattern.test(sentence)) {
        medicationStated ||= carriesMedication;
        continue;
      }
      const patterns = [medicationConditionedTrigger, timedObservationTrigger, efficacyFailureTrigger];
      if (medicationStated || carriesMedication) patterns.push(anaphoricFailureTrigger);
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        for (const match of sentence.matchAll(pattern)) {
          // A trigger conditions what follows it. When the call for help is
          // already stated before the phrase, the phrase governs the waiting
          // instruction instead: 已含服硝酸甘油并拨打 120 后，若疼痛仍未缓解，保持
          // 静卧 is the order this rule wants, and reading it as a conditioned
          // dispatch pushed authors away from writing it.
          // ...unless the sentence names the dispatch and then defines when to
          // make it, which puts the call first and the trigger after it:
          // 急救呼叫的启动条件为含服后 5 分钟症状未获缓解.
          const governsDispatch = emergencyDispatchPattern.test(sentence.slice(match.index + match[0].length))
            || emergencyConditionFrame.test(sentence);
          if (!governsDispatch) continue;
          // The unanchored branch presupposes that what did not work is the
          // medicine. When the clause says outright that it is something else —
          // 自我判断不能有效区分…, 延迟呼救则效果不佳 — the sentence is the section
          // doing its job, and reading it as a trigger forbade the advice.
          if (pattern === efficacyFailureTrigger
            && emergencyNonTreatmentSubject.test(sentence.slice(lastClauseBoundary(sentence.slice(0, match.index)) + 1, match.index))) {
            continue;
          }
          const before = sentence.slice(0, match.index);
          // The clause boundary, not a character count: the rejection that
          // licenses RQ-06 sits 35 characters back, in the preceding clause.
          // The unanchored efficacy branch reads the whole preceding sentence
          // instead, because there is no medication word for a clause to hold.
          const preceding = pattern === efficacyFailureTrigger
            ? before
            : before.slice(lastClauseBoundary(before) + 1);
          if (emergencyRejectClause.test(preceding)) continue;
          // Chinese puts the rejection after the instruction as often as before
          // it: 「若含服后心绞痛持续不缓解或性质改变，应立即呼叫急救，不得因已服药
          // 而推迟」 rejects the delay in its last clause, and reading only what
          // precedes the phrase called that sentence the very thing it forbids.
          //
          // A rejection past the trigger's own clause licenses only if it is
          // about this trigger — its clause names the medication or the relief.
          // Without that test, 「…应立即拨打 120，不要自行驾车前往医院」 cleared
          // itself with a negation about driving, and adding a sentence that is
          // safer still was the cheapest exemption in the file. Anything past
          // 。！？ is a different instruction and licenses nothing.
          const after = sentence.slice(match.index + match[0].length).split(emergencyClauseBoundary);
          const licensed = after.some((clause, index) => emergencyRejectClause.test(clause)
            && (index === 0 || emergencyDrugClause.test(clause) || emergencyReliefClause.test(clause)));
          if (licensed) continue;
          found.push({ line: lineIndex + 1, span: match[0], sentence: excerpt(sentence) });
        }
      }
      medicationStated ||= carriesMedication;
    }
  }
  return found;
}
// Attribution: the check every finding of this function is recorded under.
checkedBy(medicationConditionedEmergencyTriggers, "emergency-trigger-conditioned");

// --- A named appraisal instrument is a promise, not a qualification --------
// The closed vocabulary already exists on both sides, and it is used only as an
// *exemption*: selfGradedVerdict skips any sentence naming an instrument,
// because applying someone else's scale and reporting its level is what the
// method requires. Nothing ever verified that the named instrument was in fact
// applied, so today the vocabulary only ever licenses text. This is the other
// half: an instrument named in 资料与方法 and never used again is a gap worth
// showing the reader.
//
// It is a NOTICE, not a gate, and the reason is that the question it asks is
// not decidable from the prose. Pre-specifying an instrument per design stratum
// ("RCT 用 RoB 2、非随机干预用 ROBINS-I、诊断准确性研究用 QUADAS-2") is the
// method section PRISMA asks for, and a stratum that this round's search
// returned nothing for carries no obligation to write a sentence retiring its
// instrument. Distinguishing "promised and skipped" from "stratum came back
// empty" needs the design of every included study, which the report states in
// prose and not in a field. Run blocking over thirty delivered packages and it
// rejects twenty-nine of them, of which the read-through confirmed three
// (RQ-07 AMSTAR 2, RQ-21 five bias tools, RQ-29 QUADAS-2/RoB 2/GRADE) — and
// the cheapest way past it is to delete the instrument names from 资料与方法,
// i.e. to buy delivery with methodological transparency. A check that pays that
// price is wrong even when its underlying rule is right.
//
// namedAppraisalInstrumentPattern is deliberately left alone. Widening it would
// widen the exemption it guards, which would relax an existing check.
/** @type {readonly [string, RegExp][]} */
const appraisalInstruments = Object.freeze([
  ["RoB 2", /RoB\s?[-‑]?\s?2/i],
  ["ROBINS-I", /ROBINS[-‑\s]?I(?![A-Za-z])/i],
  ["ROBINS-E", /ROBINS[-‑\s]?E(?![A-Za-z])/i],
  ["QUADAS-2", /QUADAS[-‑\s]?2/i],
  ["AMSTAR 2", /AMSTAR\s?[-‑]?\s?2/i],
  ["AGREE II", /AGREE\s?(?:II|2|Ⅱ)/i],
  // Bare NOS is nitric oxide synthase — eNOS-NO 通路 appears in two delivered
  // reports — so it is an instrument only when a scale noun follows it.
  ["Newcastle-Ottawa", /Newcastle[-‑\s]?Ottawa|纽卡斯尔[-‑\s]?渥太华|(?<![A-Za-z])NOS(?=\s*(?:量表|评分|评价|清单))/i],
  ["Naranjo", /Naranjo|诺氏(?=\s*(?:量表|评分))/i],
  ["WHO-UMC", /WHO[-‑\s]?UMC/i],
  ["Jadad", /Jadad/i],
  ["GRADE", /(?<![A-Za-z])GRADE(?![A-Za-z])/i],
]);
// Bare Cochrane is not in the vocabulary: 2008 年 Cochrane 系统评价 is a
// publication, and Cochrane 偏倚风险评价工具 does not say which version.
const appraisalHedgePattern = /思路|精神|理念|大意|(?:参照|参考)[^，。；\n]{0,20}要点/;
const appraisalDeclinedPattern = /未(?:使用|采用|执行|做|作)|不(?:适用|使用|采用)|无从(?:评定|评价)/;
// An instrument the literature never applied, or that could not be scored, is
// executed by saying so.
const appraisalNotAppliedPattern = /未(?:检索到|获得|见|能|报告|提供|开展|进行|作|做|给出)|无法(?:完整)?(?:获得|检索|评定|评价|评估|应用|实施)|不适用|无从(?:评定|评价|判断)|(?:资料|信息)不(?:足|全|完整)/;
const appraisalCitationPattern = /\[\d+/;
// A rating of a *body* of evidence is by construction a summary of studies that
// were cited before it, and it is routinely written as its own paragraph — the
// individual [n]s sit in the paragraphs above. Reading "applied" as "a bracket
// stands in the same paragraph" therefore called RQ-10's 结果 rating,
// 「综合而言，机制层面……按 GRADE 属低确定性，降级理由为间接性」, an unexecuted
// instrument over a single newline, and said so in the notice. A sentence that
// hands down a level is the instrument being used; it only needs the section it
// stands in to cite anything at all.
const appraisalVerdictPattern = /(?:为|评为|定为|判为|属|记为|评定为)\s*["“”'‘’]?(?:极|很|较)?(?:高|中等?|低|严重|不明确|high|moderate|low|serious|critical|some\s+concerns)/i;
// A GRADE verdict written either way round. 「评为高确定性」 puts the level before
// its noun; 「GRADE 确定性高」 and 「证据确定性评为高」 put it after, and matching
// only the first order meant the same verdict passed by word order alone. 属 and
// 级别 join the vocabulary for the same reason — 「按 GRADE 属高级别证据」 is the
// verdict spelled with the nouns GRADE's Chinese translations actually use.
const gradeCertaintyNoun = "确定性|证据质量|证据等级|证据级别|质量|等级|级别|certainty";
const gradeLevelWord = "(?:极|很|较)?(?:高|中等?|低|high|moderate|low)(?:\\s*(?:至|到|~|～|-|–)\\s*(?:极|很|较)?(?:高|中等?|低|high|moderate|low))?";
const gradeLevelPattern = new RegExp(
  `(?:为|评为|评定为|定为|判为|属于|属|记为|确定性为|在)\\s*["“”'‘’「『]?(${gradeLevelWord})["“”'‘’」』]?\\s*(?:${gradeCertaintyNoun}|之间)`
  + `|(?:${gradeCertaintyNoun})\\s*(?:评定为|评为|定为|判为|记为|属于|属|为|是)?\\s*["“”'‘’「『]?(${gradeLevelWord})(?![于过])`,
  "i",
);
// A downgrade reason is an assertion that something is *wrong* with the
// evidence, and the five GRADE domains are neutral nouns. 偏倚风险 / 不一致 /
// 间接性 / 不精确 / 发表偏倚 appear in the sentence that justifies a HIGH rating
// at least as often as in one that justifies a downgrade — 「两项大型随机对照试验
// 偏倚风险低、结果一致、估计精确、无发表偏倚证据，按 GRADE 评为高确定性」 is the
// textbook wording — so matching the bare noun made 高 unwritable. What counts
// is a stated deficiency, or a downgrade actually performed, and it has to be
// in the clause that states it: 未对任何领域降级 is not a downgrade.
//
// A downgrade performed is 降级 or 下调 or 扣 followed by a step; a deficiency
// stated is an evidence-quality noun under a negative evaluation. Both used to
// be spelled out phrase by phrase, and 下调一级 / 质量欠佳 / 证据强度不足 walked
// past a rule that already rejected 降一级 / 质量偏低 — the same assertion, a
// synonym apart.
//
// The English branch used to read (?:偏倚风险|risk of bias)(?:较|很)?(?:高|严重),
// which demands a Chinese intensifier after an English noun and so could not
// match any text in either language. It is written out here instead of deleted,
// because an English-language evidence table is a real shape.
const gradeDowngradeStep = "(?:一|两|二|1|2)?\\s*(?:个)?\\s*(?:级|等级|档)";
const gradeQualityNoun = "方法学质量|证据质量|研究质量|证据强度|证据级别|方法学|质量";
const gradeQualityDeficient = "偏低|较低|低|差|不高|欠佳|不佳|欠缺|不足|有限|堪忧|参差不齐";
const gradeDowngradePattern = new RegExp([
  `(?:降|下调|下降|扣)\\s*${gradeDowngradeStep}`,
  "降级",
  "偏倚风险(?:较|很)?(?:高|严重|不明确|不清楚)",
  "存在(?:严重|明显|较大|一定)?(?:偏倚风险|不一致性?|间接性|不精确性?|发表偏倚)",
  "(?:不一致性?|间接性|不精确性?|发表偏倚)(?:明显|严重|突出|较大)",
  "(?:估计|效应量?|结果)(?:很|较|明显)?不(?:精确|一致)",
  `(?:${gradeQualityNoun})\\s*(?:普遍|整体|多数|大多|总体|均|尚)?\\s*(?:${gradeQualityDeficient})`,
  "(?:downgrad|rated down)",
  "risk of bias\\s*(?:(?:is|was|were|are)\\s*)?(?:high|serious|critical|unclear)",
  "(?:methodological|study|evidence)\\s+quality\\s*(?:(?:is|was|were|are)\\s*)?(?:low|poor|limited)",
  "serious\\s+(?:limitations?|risk of bias|imprecision|inconsistency|indirectness)",
].join("|"), "i");
// 未对任何领域降级 / 无需降级 / 不因不一致性降级: the deficiency word is present
// because it is being ruled out.
//
// Two of GRADE's five domains are spelled with a negator — 不一致性, 不精确 — so
// the negator inside the domain noun read as a negation of the downgrade next
// to it, and 「因偏倚风险与不一致性下调一级」 was scored as a downgrade ruled out.
// The domain nouns are masked to the same width before the negation is looked
// for, which leaves 不因不一致性降级 negated and this one asserted.
const gradeDowngradeNegationPattern = /[不未无没][^，。；\n]{0,6}$/;
const gradeDomainNegatorNouns = /不一致性?|不精确性?/g;
// 从"高"起步 names GRADE's starting point, not the verdict. Tested against the
// level match and the few characters in front of it rather than against the
// whole passage: a blanket skip would let one baseline sentence license every
// verdict in the paragraph.
const gradeBaselinePattern = /(?:从|自|起[点始]|基线|起步)\s*(?:为|于)?\s*["“”'‘’「『]?(?:极|很|较)?(?:高|中)/;
const appraisalSentenceSplit = /(?<=[。！？；;])/;
const appraisalClauseSplit = /[，,；;：:、\n]/;
// The GRADE self-consistency branch reads a whole paragraph, so its clause
// split has to end clauses at full stops too — otherwise a negation six
// characters back reaches over one.
const gradeClauseSplit = /[，,；;：:、。！？\n]/;

/** METHODS / BODY / TAIL as the check reads them: every matching level-two
 *  section concatenated (reportSection returns only the first, and one report
 *  writes `## 2 资料与方法`), plus the abstract's 方法 field, with emphasis
 *  markers stripped — one delivery writes 评为**低确定性**, and the markers
 *  would break level parsing.
 *  @param {any} reportText
 */
function appraisalSections(reportText) {
  const text = String(reportText ?? "");
  const abstractMethods = /\*\*方法\*\*(.*?)(?=\n?\*\*(?:结果|结论)|$)/s.exec(reportSection(text, "摘要|Abstract"))?.[1] ?? "";
  /** @type {Record<'methods'|'body'|'tail', string[]>} */
  const buckets = { methods: [abstractMethods.replace(/\*\*|__/g, "")], body: [], tail: [] };
  /** @type {'methods'|'body'|'tail'|null} */
  let current = null;
  for (const line of text.replace(/\*\*|__/g, "").split("\n")) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      const name = heading[1];
      if (/参考文献|参考来源|References?/i.test(name)) current = null;
      else if (/资料|材料|方法|Methods/i.test(name)) current = "methods";
      else if (/结果|讨论|Results?|Discussion/i.test(name)) current = "body";
      else if (/局限|结论|临床实践要点|Limitations?|Conclusion/i.test(name)) current = "tail";
      else current = null;
      continue;
    }
    if (current) buckets[current].push(line);
  }
  return { methods: buckets.methods.join("\n"), body: buckets.body.join("\n"), tail: buckets.tail.join("\n") };
}

/** Whether a sentence asserts a GRADE downgrade — a deficiency in the evidence,
 *  or a downgrade performed — rather than ruling one out. Clause-scoped,
 *  because a sentence that grades a body says both things: 偏倚风险低、结果一致、
 *  估计精确 names three domains and downgrades for none of them.
 *  @param {string} sentence
 */
function assertedGradeDeficiency(sentence) {
  for (const clause of sentence.split(gradeClauseSplit)) {
    const match = gradeDowngradePattern.exec(clause);
    if (!match) continue;
    const preceding = clause.slice(0, match.index).replace(gradeDomainNegatorNouns, (noun) => "·".repeat(noun.length));
    if (gradeDowngradeNegationPattern.test(preceding)) continue;
    return true;
  }
  return false;
}

/** The 1-indexed line of the unmodified report that carries a passage.
 *  @param {any} reportText @param {string} passage
 */
function reportLineCarrying(reportText, passage) {
  const needle = passage.trim();
  if (!needle) return 0;
  for (const [index, line] of String(reportText ?? "").split("\n").entries()) {
    if (line.replace(/\*\*|__/g, "").includes(needle)) return index + 1;
  }
  return 0;
}

/** Instruments declared in 资料与方法 and never executed in 结果 or 讨论, and
 *  GRADE levels that reach 高 beside a downgrade reason.
 *  @param {any} reportText
 *  @returns {{ branch: string, instrument?: string, line: number, text: string }[]}
 */
function declaredAppraisalIssues(reportText) {
  const { methods, body, tail } = appraisalSections(reportText);
  const findings = [];
  for (const [instrument, pattern] of appraisalInstruments) {
    const declarations = methods.split(appraisalClauseSplit).filter((clause) => pattern.test(clause));
    if (!declarations.length) continue;
    // Declared as *not* used: nothing has to land.
    if (declarations.every((clause) => appraisalDeclinedPattern.test(clause))) continue;
    const first = declarations[0].trim();
    const line = reportLineCarrying(reportText, first);
    if (declarations.every((clause) => appraisalHedgePattern.test(clause))) {
      findings.push({ branch: "hedged-declaration", instrument, line, text: excerpt(first) });
      continue;
    }
    // Three ways a declaration lands, widest scope last: on a study cited in
    // the same paragraph; as an explicit statement that nothing could be
    // scored; or as a verdict on a body of evidence, which summarises studies
    // cited in the paragraphs before it and needs only that 结果/讨论 cite
    // something.
    const bodyCites = appraisalCitationPattern.test(body);
    const landed = body.split("\n").some((paragraph) => {
      if (!pattern.test(paragraph)) return false;
      return paragraph.split(appraisalSentenceSplit).some((sentence) => {
        if (!pattern.test(sentence)) return false;
        const carrying = sentence.split(appraisalClauseSplit).filter((clause) => pattern.test(clause));
        if (!carrying.length || carrying.every((clause) => appraisalHedgePattern.test(clause))) return false;
        return appraisalCitationPattern.test(paragraph)
          || appraisalNotAppliedPattern.test(sentence)
          || (bodyCites && appraisalVerdictPattern.test(sentence));
      });
    });
    if (landed) continue;
    findings.push({
      branch: pattern.test(tail) ? "appraisal-tail-only" : "appraisal-declared-not-executed",
      instrument,
      line,
      text: excerpt(first),
    });
  }
  // Any downgrade at all excludes 高, so only that case is decidable. GRADE
  // legitimately reaches 中 after one downgrade, and observational bodies start
  // at 低, so counting downgrade domains from prose is not reliable.
  // The unit is the paragraph, not the sentence. A verdict and the deficiency
  // that contradicts it are one judgement however they are punctuated, and a
  // sentence-scoped check was cleared by a full stop:
  // 「纳入研究方法学质量普遍偏低。按 GRADE 评为高确定性。」 and the same two
  // sentences in the other order both passed while saying exactly what the
  // one-sentence form says.
  //
  // The verdict noun is not required to be the string GRADE either. 「证据确定性
  // 评为高」 is a GRADE verdict with the instrument's name left out, and reading
  // only sentences containing GRADE made deleting the word an exemption.
  const gradedPassages = `${body}\n${tail}`.split("\n");
  for (const passage of gradedPassages) {
    if (!/(?<![A-Za-z])GRADE(?![A-Za-z])|证据(?:确定性|质量|等级|级别)|确定性/i.test(passage)) continue;
    if (!assertedGradeDeficiency(passage)) continue;
    gradeLevelPattern.lastIndex = 0;
    const highVerdict = [...passage.matchAll(new RegExp(gradeLevelPattern.source, "gi"))].find((level) => {
      const stated = level[1] ?? level[2] ?? "";
      if (!/高|high/i.test(stated)) return false;
      // 从「高」起步 / 起点为高: the baseline GRADE starts from, not the verdict.
      return !gradeBaselinePattern.test(passage.slice(Math.max(0, level.index - 8), level.index + level[0].length));
    });
    if (!highVerdict) continue;
    findings.push({
      branch: "grade-level-contradicts-downgrade",
      line: reportLineCarrying(reportText, passage.trim()),
      text: excerpt(passage),
    });
  }
  return findings;
}
// Attribution: the check every finding of this function is recorded under.
checkedBy(declaredAppraisalIssues, "appraisal-declaration");

// --- Reference-table closure: nothing floats, no number is an orphan -------
// citationIntegrityIssues() already computes the orphan and dangling
// directions, and it is dead code for this product line: it runs only when an
// agent lists citationIntegrity in completionChecks, and the
// clinical-evidence-synthesis agent lists requiredOutputsExist /
// citationsResolvable / evidenceClaimsTraceable / skillsLoaded. The gate itself
// checks only matrix→reference and duplicate padding, and preflight compared
// counts, which rewards padding. These clauses close the loop in both
// directions.
const citationNumberListPattern = /\[(\d{1,3}(?:\s*[,，、\-–—]\s*\d{1,3})*)\]/g;
const bareCitationNumberList = /^\s*\d{1,3}(?:\s*[,，、\-–—]\s*\d{1,3})*\s*$/;
const bracketSpanPattern = /\[([^[\]\n]{1,200})\]/g;
// Every reference heading. One literal for the closure check and for
// `referenceListBounds`, so the two cut the list at the same line.
const referenceHeadingPattern = /(?:^|\n)##\s+[^\n]*(?:参考文献|参考来源|References?)[^\n]*/gi;
// A bibliographic identifier occupying the citation slot resolves to nothing a
// reader can follow and to no claim. Identifiers in running prose or in
// （full-width parens） are untouched — a trial registration named in a sentence
// is not a citation.
const bibliographicIdentifierPattern = /(?:(?<![A-Za-z0-9_])10\.\d{4,9}\/[^\s\]，。；、]+|(?<![A-Za-z0-9_])PMID:?\s*\d{5,9}(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])PMC\d{5,9}(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])NCT\d{8}(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])ChiCTR[-A-Za-z0-9]+(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])ISRCTN\d{8}(?![A-Za-z0-9_]))/i;

/** Citation numbers in a passage, with the full-width separators a Chinese
 *  manuscript uses. "[2.2.1]" is a von Baeyer ring descriptor, not citation 2:
 *  the dot breaks the pattern, which is why the bracket must be numbers only.
 *  @param {any} text
 */
function closureCitationNumbers(text) {
  const numbers = new Set();
  for (const match of String(text ?? "").matchAll(citationNumberListPattern)) {
    for (const part of match[1].split(/[,，、]/)) {
      const range = part.trim().match(/^(\d+)\s*[-–—]\s*(\d+)$/);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (end >= start && end - start <= 100) {
          for (let number = start; number <= end; number += 1) numbers.add(number);
        }
      } else if (part.trim()) {
        numbers.add(Number(part.trim()));
      }
    }
  }
  return numbers;
}

/** The prose with fenced blocks and inline code spans blanked, line count
 *  preserved so a reported line is the line the author will find.
 *  @param {string} prose
 */
function proseWithoutCode(prose) {
  let insideFence = false;
  return String(prose ?? "").split("\n").map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      insideFence = !insideFence;
      return "";
    }
    return insideFence ? "" : line.replace(/`[^`\n]*`/g, "");
  }).join("\n");
}

/** The reference numbers a claim is allowed to carry on a line: its own, plus
 *  every number a synthesized claim lists.
 *  @param {any} claim
 */
function allowedReferenceNumbers(claim) {
  const numbers = new Set();
  if (Number.isInteger(claim?.referenceNumber)) numbers.add(claim.referenceNumber);
  for (const number of Array.isArray(claim?.referenceNumbers) ? claim.referenceNumbers : []) {
    if (Number.isInteger(number)) numbers.add(number);
  }
  return numbers;
}

/** Reference-table closure in both directions, identifiers standing in for
 *  citations, and per-line anchor/number pairing.
 *  @param {any} reportText @param {Map<any, any>} claimsById
 *  @returns {({ clause: 'A', number: number, body: string }
 *    | { clause: 'B', number: number }
 *    | { clause: 'C', line: number, bracket: string }
 *    | { clause: 'D', line: number, claimId: string, cited: number[], allowed: number[] })[]}
 *
 *  A discriminated union: the consumer branches on `clause`, and with every
 *  field optional that branch narrowed nothing.
 */
function citationClosureFindings(reportText, claimsById) {
  const text = String(reportText ?? "");
  // The LAST reference heading, as preflight already does: reportSection uses
  // the first, and a report naming its reference list twice would be cut in
  // the wrong place.
  const headings = [...text.matchAll(referenceHeadingPattern)];
  const referencesStart = headings.at(-1)?.index ?? text.length;
  const prose = text.slice(0, referencesStart);
  const entries = new Map();
  for (const line of text.slice(referencesStart).split("\n")) {
    const match = referenceEntryPattern.exec(line);
    if (!match) continue;
    const number = Number(match[1] ?? match[2]);
    if (!Number.isInteger(number) || entries.has(number)) continue;
    entries.set(number, match[3].trim());
  }
  const proseForCitations = proseWithoutCode(prose);
  const lines = proseForCitations.split("\n");
  const cited = new Set();
  for (const line of lines) for (const number of closureCitationNumbers(line)) cited.add(number);
  /** @type {ReturnType<typeof citationClosureFindings>} */
  const findings = [];
  if (entries.size) {
    for (const number of [...entries.keys()].sort((a, b) => a - b)) {
      if (!cited.has(number)) findings.push({ clause: "A", number, body: excerpt(entries.get(number)) });
    }
    for (const number of [...cited].sort((a, b) => a - b)) {
      if (!entries.has(number)) findings.push({ clause: "B", number });
    }
  }
  const firstMarkerLine = new Map();
  for (const [index, line] of lines.entries()) {
    for (const id of reportClaimIds(line)) {
      if (!firstMarkerLine.has(id)) firstMarkerLine.set(id, index);
    }
  }
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(bracketSpanPattern)) {
      const inner = match[1];
      if (bareCitationNumberList.test(inner) || /^\s*claim:/.test(inner)) continue;
      if (bibliographicIdentifierPattern.test(inner)) {
        findings.push({ clause: "C", line: index + 1, bracket: excerpt(match[0]) });
      }
    }
    const onLine = closureCitationNumbers(line);
    for (const id of new Set(reportClaimIds(line))) {
      const claim = claimsById.get(id);
      // A derived result carries no reference number of its own; its inputs do.
      if (!claim || (claim.claimType ?? "direct") === "derived") continue;
      // The claim that is paired nowhere is already reported once, per claim,
      // by the matrix-side pairing check. This clause adds the later lines it
      // never looked at — which is where a repeated marker goes wrong.
      if (firstMarkerLine.get(id) === index) continue;
      const allowed = allowedReferenceNumbers(claim);
      if (!allowed.size) continue;
      if ([...allowed].some((number) => onLine.has(number))) continue;
      findings.push({
        clause: "D",
        line: index + 1,
        claimId: id,
        cited: [...onLine].sort((a, b) => a - b),
        allowed: [...allowed].sort((a, b) => a - b),
      });
    }
  }
  return findings;
}
// Attribution: the check every finding of this function is recorded under.
checkedBy(citationClosureFindings, "citation-closure");

/* --- The report grammar, for a caller that rewrites a report --------------
 * `evimed_render_report` renumbers citations, rebuilds the reference list and
 * hides visible claim markers. It reads the report with these, the functions
 * the checks above read it with, because a renderer with a reading of its own
 * would rewrite a report into a shape the gate then reads differently — the
 * two-implementations failure this module exists to end.
 */

/**
 * Every bracketed citation list in a report, with its offsets: fenced blocks
 * and inline code spans skipped as `proseWithoutCode` skips them, full-width
 * separators and ranges read as `closureCitationNumbers` reads them.
 * @param {string} text
 * @returns {{ start: number, end: number, raw: string, numbers: number[] }[]}
 */
export function citationSpans(text) {
  /** @type {{ start: number, end: number, raw: string, numbers: number[] }[]} */
  const spans = [];
  let insideFence = false;
  let offset = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      insideFence = !insideFence;
    } else if (!insideFence) {
      const code = [...line.matchAll(/`[^`\n]*`/g)].map((match) => [match.index, match.index + match[0].length]);
      for (const match of line.matchAll(citationNumberListPattern)) {
        const at = match.index;
        if (code.some(([from, to]) => at >= from && at < to)) continue;
        spans.push({ start: offset + at, end: offset + at + match[0].length, raw: match[0], numbers: [...closureCitationNumbers(match[0])] });
      }
    }
    offset += line.length + 1;
  }
  return spans;
}

/**
 * Where the numbered reference list is: from the last reference heading — the
 * one the closure check cuts at — to the next level-two heading. Null when the
 * report has no reference heading.
 * @param {string} text
 * @returns {{ headingStart: number, headingEnd: number, end: number } | null}
 */
export function referenceListBounds(text) {
  const source = String(text ?? "");
  const last = [...source.matchAll(referenceHeadingPattern)].at(-1);
  if (!last) return null;
  const headingStart = last.index + (last[0].startsWith("\n") ? 1 : 0);
  const headingEnd = last.index + last[0].length;
  const next = source.slice(headingEnd).search(/\n##\s/);
  return { headingStart, headingEnd, end: next < 0 ? source.length : headingEnd + next + 1 };
}

/**
 * One numbered reference-list entry (`1. …`, `1、…` or `[1] …`), or null.
 * @param {string} line @returns {{ number: number, text: string } | null}
 */
export function parseReferenceEntry(line) {
  const match = referenceEntryPattern.exec(String(line ?? ""));
  return match ? { number: Number(match[1] ?? match[2]), text: match[3].trim() } : null;
}

/**
 * The claim ids a passage marks, visible or hidden, in order.
 * @param {string} text @returns {string[]}
 */
export function markedClaimIds(text) {
  return reportClaimIds(text);
}

/**
 * The report with every visible `[claim:CLM-NNN]` marker turned into the
 * hidden `<!-- claim:CLM-NNN -->` form the `visible-claim-marker` check asks
 * for, and how many were turned.
 * @param {string} text @returns {{ text: string, hidden: number }}
 */
export function hideVisibleClaimMarkers(text) {
  let hidden = 0;
  const result = String(text ?? "").replace(new RegExp(visibleClaimMarkerPattern.source, "g"), (_match, id) => {
    hidden += 1;
    return `<!-- claim:${id} -->`;
  });
  return { text: result, hidden };
}

// --- An attributed position must be quoted, not inferred from data ---------
// 作者指出 / 作者认为 / 该研究强调 attributes a position to a source. The
// report-line numeric audit already walks every line and resolves its claims —
// and compares numbers only, so a fabricated authorial position is invisible to
// it: on every real case the figures on the line ARE in the cited quotes, and
// the delivered citation-audit could truthfully write 「声明中的阿拉伯数字均出现
// 于引文」. Worse, claimEvidenceText includes the agent-authored `claim` field,
// so a stance written there counts as its own support. That is the laundering
// path this reads around: only supportQuote is consulted.
//
// sourceTitle used to be read alongside it, which reopened the laundering path
// one field over — a title is metadata the run types in, not text the source
// was quoted as saying, and the notice below already told the author the gate
// reads supportQuote alone. Retitling one source
// 「Selection bias in emergency chest pain cohorts」 put `bias` in the stance
// text and cleared the line with the prose untouched.
//
// The subject→verb window is one clause and at most 25 characters — the longest
// real gap in the corpus is 11 (作者将血管舒缩症状视为) — and 报告/报道/说明/描述
// are deliberately not stance verbs: they are ordinary reporting verbs.
//
// A comma ends the window, because a subject and its predicate stand in one
// clause: 「其结论引自摘要原文、未据标题推断」 says where the conclusions came
// from, and 「作者对心肌梗死估计的 E 值为 1.79，提示…」 predicates 提示 of the
// E value, not of the authors.
//
// The subject is built rather than listed. 该研究 used to be a listed string, so
// 「这项研究认为」 and 「该项研究指出」 — one measure word inserted — were not the
// same subject, and 「上述研究认为」 was not either. A source-denoting subject is a
// demonstrative plus a research-entity noun, with the measure word Chinese puts
// between them optional; 本 is excluded because 本研究/本文 is the report's own
// voice and not an attribution to anybody.
//
// The predicate list gains the stance verbs the corpus reached for next —
// 提出 / 断言 / 归结 / 论断 / 推断 / 写道 / 提示 and the polemic ones — plus the two
// non-verbal frames that say the same thing without a verb at all:
// 「在原作者看来，…」 and 「作者的核心观点是…」.
const attributedStanceDeterminer = "该|这|此|上述|前述|前文|原";
const attributedStanceEntity = "研究|综述|试验|队列|分析|文献|论文|报告|文章|指南|共识|荟萃分析|meta\\s*分析";
const attributedStanceAuthor = "作者|笔者|研究者|研究人员|研究团队|课题组|原作者|综述作者|作者们|原文|该文|文中";
const attributedStanceSubject = `(?:(?:${attributedStanceDeterminer})\\s*(?:一)?\\s*(?:项|篇|个|份|部)?\\s*(?:${attributedStanceEntity})|${attributedStanceAuthor})`;
const attributedStanceVerb = "认为|指出|强调|视为|归因|归结|主张|推测|承认|坦承|警告|提醒|解释为|理解为|注意到|倾向|提出|断言|论断|推断|质疑|反驳|否认|声称|宣称|写道|提示";
const attributedStancePattern = new RegExp([
  `(?<!本)${attributedStanceSubject}[^。！？；；，、;,\\n]{0,25}?(?:${attributedStanceVerb})`,
  `在\\s*(?<!本)${attributedStanceSubject}[^。！？；；，、;,\\n]{0,12}?看来`,
  `(?<!本)${attributedStanceSubject}[^。！？；；，、;,\\n]{0,8}?的\\s*(?:核心|主要|基本)?\\s*(?:观点|看法|立场|主张|判断|解释|论点)\\s*(?:是|为|在于)`,
].join("|"));
// The exemption: the quote itself carries a position, so attributing one to it
// is a faithful restatement. It stays a permit-list — matching can only silence
// a trigger, never create one — but what it permits is a *stance predication*,
// not a token.
//
// It used to be a flat vocabulary tested anywhere in the quote, and on the
// thirty delivered packages that cleared 183 of 578 claims (31.7%) outright.
// The words doing the clearing were carrying no stance at all: `could` in
// 「You could be having a heart attack. Call 999」 (patient instruction), `our`
// and `we` in 「included in our analysis」 / 「we included 417 patients」 (methods),
// `however` in 「However, there was significant heterogeneity」 (a measurement
// with a connective in front of it). A word is not a position; a predication is.
//
// So each branch below requires the stance-bearing element to stand in a
// governing configuration — a subject it predicates of, or a complement it
// takes — which is what makes it a claim about a proposition rather than a
// token inside a result sentence:
//
//   A authorial predication  we / our results / the authors + a judgement verb,
//                            within one clause. Kills 「our analysis included」;
//                            keeps 「Our results do not support the findings of…」.
//   B complemented judgement a judgement verb taking a propositional complement
//                            (that / to-infinitive / whether). Kills 「were
//                            considered as low quality studies」 (a methods
//                            definition); keeps 「considered to be the most
//                            common cause」, 「concluded that…」.
//   C hedged interpretation  a hedge governing an interpretive predicate. Kills
//                            「could be having a heart attack」 and 「differences
//                            may exist」; keeps 「was likely due to volatilization
//                            losses」, 「may lead to a longer decision delay」.
//   D deontic position       the source telling someone what to do — should /
//                            must / the need to / (not) recommended. A guideline
//                            recommendation is a position its authors hold.
//   E causal attribution     a causal frame whose explanandum is a stated result.
//                            Kills 「tolerance due to the accumulation of…」;
//                            keeps 「received low Jadad scores due to the lack of
//                            a double-blind design」, 「accounts for the observed
//                            decline」.
//   F epistemic state        remains unclear / cannot be excluded.
//   G/H Chinese              stance verbs, and a hedge governing an interpretive
//                            predicate. The bare nouns and adverbs that used to
//                            sit here — 局限 / 偏倚 / 混杂 / 可能 / 或许 — are
//                            words a result sentence contains, not positions.
//
// After: 60 of 578 (10.4%). Every attribution line the corpus clears through
// this exemption still clears it, and each does so on a quote that genuinely
// states a position (RQ-08 CLM-004, RQ-16 CLM-010, RQ-16 CLM-013, RQ-24
// CLM-012/013, RQ-28 CLM-009); the two confirmed violations still fire.
const stanceAuthorialSubject = "(?:we|our|us|the authors?|this (?:study|review|analysis|paper|report|trial|cohort|meta-analysis)|the present (?:study|review|analysis))";
const stanceJudgementVerb = "(?:suggest|conclud|conclusion|propos|argu|hypothesi[sz]|speculat|acknowledg|caution|recommend|advocat|interpret|consider|believ|assum|attribut|postulat|contend|support|emphasi[sz]|warn)";
const stanceHedge = "(?:may|might|could|would|likely|unlikely|probably|possibly|presumably|appears? to|seems? to|tends? to)";
const stanceInterpretivePredicate = "(?:due to|attribut|explain|accounts? for|accounted for|reflect|indicat|impl(?:y|ies|ied)|results? from|resulted from|leads? to|lead to|contribut|underl(?:ie|ying|ies)|represent|mediat|responsible for|caused? by|associated with|related to|arise|stem)";
const stanceResultNoun = "(?:results?|findings?|outcomes?|observations?|declines?|increases?|reductions?|differences?|associations?|effects?|scores?|delays?|heterogeneity|discrepanc|variation|trends?|improvements?|changes?|estimates?|rates?)";
const stanceCausalFrame = "(?:due to|owing to|because of|because|attributable to|attributed to|explained by|accounts? for|accounted for|resulted from|arises? from|stems? from|reflects?)";
const stanceDeonticPredicate = "(?:the need to|needs? to|should|must|ought to|is\\s+(?:not\\s+)?(?:recommended|advised|warranted|justified|essential|necessary|indicated|contraindicated)|are\\s+(?:not\\s+)?(?:recommended|advised|warranted|justified)|(?:do(?:es)? not\\s+)?recommends?|not recommended)";
const quotedStancePattern = new RegExp([
  `(?<![A-Za-z])${stanceAuthorialSubject}(?![A-Za-z])[^.;\\n]{0,40}?(?<![A-Za-z])${stanceJudgementVerb}`,
  `(?<![A-Za-z])${stanceJudgementVerb}[a-z]*(?![A-Za-z])[^.;\\n]{0,24}?(?:that(?![A-Za-z])|to\\s+[a-z]|whether(?![A-Za-z]))`,
  `(?<![A-Za-z])${stanceHedge}(?![A-Za-z])[^.;\\n]{0,20}?(?<![A-Za-z])${stanceInterpretivePredicate}`,
  `(?<![A-Za-z])${stanceDeonticPredicate}(?![A-Za-z])`,
  `(?<![A-Za-z])${stanceResultNoun}(?![A-Za-z])[^.;\\n]{0,30}?(?<![A-Za-z])${stanceCausalFrame}(?![A-Za-z])`,
  `(?<![A-Za-z])${stanceCausalFrame}(?![A-Za-z])[^.;\\n]{0,30}?(?<![A-Za-z])${stanceResultNoun}(?![A-Za-z])`,
  "(?<![A-Za-z])(?:remains? (?:to be|unclear|unknown|uncertain|controversial|debated)|(?:is|are|was|were) (?:unclear|uncertain|controversial|questionable|debatable)|cannot be (?:excluded|ruled out|determined))",
  "认为|指出|主张|推测|归因|建议|强调|提示|警告|坦承|承认|解释为|视为",
  "(?:可能|或许|大概|似乎|倾向于)[^。；\\n]{0,12}(?:由于|因为|归因|源于|导致|引起|反映|解释|提示|相关|有关)",
].join("|"), "i");

/** The quote-side text of a claim: what the source itself says, never what the
 *  agent wrote about it. `claim`, `applicability`, `uncertainty` and
 *  `sourceTitle` are the agent's own words and are excluded on purpose.
 *  @param {any} claim
 */
function claimQuoteText(claim) {
  /** @type {(Record<string, any> | null | undefined)[]} */
  const sources = claim?.claimType === "synthesized" && Array.isArray(claim?.supportingSources)
    ? claim.supportingSources
    : [claim];
  return sources
    .map((source) => source?.supportQuote)
    .filter((value) => typeof value === "string")
    .join(" ");
}

/** Lines that attribute a position to a source while every claim they cite
 *  states only measurements.
 *  @param {any} body @param {Map<any, any>} claimsById
 *  @returns {{ line: number, attribution: string, claimIds: string[], anchored: boolean }[]}
 */
function attributedStanceIssues(body, claimsById) {
  const found = [];
  for (const [index, line] of String(body ?? "").split("\n").entries()) {
    if (/^\s*#{1,6}\s+/.test(line)) continue;
    const attribution = attributedStancePattern.exec(line);
    if (!attribution) continue;
    // Line-level, not sentence-level: the corpus uses both marker conventions —
    // trailing and paragraph-leading — and a sentence splitter attributes a
    // trailing marker to the preceding claim and manufactures a false positive.
    const ids = [...new Set(reportClaimIds(line))];
    const claims = ids.map((id) => claimsById.get(id)).filter((claim) => claim && claim.claimType !== "derived");
    if (!ids.length) {
      found.push({ line: index + 1, attribution: excerpt(attribution[0]), claimIds: [], anchored: false });
      continue;
    }
    if (!claims.length) continue;
    if (claims.some((claim) => quotedStancePattern.test(claimQuoteText(claim)))) continue;
    // The "every" conjunct is load-bearing: an attribution anchored to a claim
    // whose quote is a plain non-numeric sentence is a faithful restatement,
    // and a line that mixes a stance claim with a data claim is ordinary
    // writing. Only a position resting entirely on measurements is the defect.
    if (!claims.every((claim) => conclusoryQuantities(claimQuoteText(claim)).size > 0)) continue;
    found.push({
      line: index + 1,
      attribution: excerpt(attribution[0]),
      claimIds: claims.map((claim) => claim.claimId),
      anchored: true,
    });
  }
  return found;
}
// Attribution: the check every finding of this function is recorded under.
checkedBy(attributedStanceIssues, "attributed-stance");

// --- An article-level regulatory citation needs the regulator's own text ----
// 《XX法/条例/办法…》第 N 条 asserts what a normative text says at clause
// granularity, and only the issuing authority's published text can carry that.
// Nothing in this file models the *class* of a source: accessLevel records how
// much of an artifact was read, never what kind of document it is, and the one
// place regulatory attribution is reasoned about —
// attributedRecommendationPattern — uses it as an *exemption*, so today the
// string 《医师法》 makes the gate more permissive and never more demanding.
const statuteTitlePattern = "《[^》\\n]{2,40}(?:法|条例|办法|规定|细则|准则|规范|决定|命令|公告|通知|药典)(?:[（(][^）)\\n]{0,20}[）)])?》";
const statuteArticleNumber = "[一二三四五六七八九十百廿卅零〇0-9]{1,6}";
// An article-level assertion is a statute reference and an article number in one
// sentence, and the assertion is the same however the two are ordered and
// however the statute is named. Requiring 《》 before 第 N 条 meant three
// rewritings of one sentence walked past it: dropping the book-title marks
// (「医师法第 29 条第 2 款…」), putting the number first (「第 29 条第 2 款是
// 《医师法》为…设定的合法条件」), and referring back to a statute named in an
// earlier clause (「…；该法第 29 条第 2 款将其规定为四点」).
//
// The bare and anaphoric forms are recognised by the shape Chinese legal
// citation actually uses — a statute name written immediately against its
// article locator, 医师法第 29 条 / 该法第 29 条 / 本办法第 5 条. Adjacency is what
// makes that safe: 法 also ends 方法, 用法, 疗法 and 合法, and those compounds are
// filtered by name rather than by a lookbehind, so the same rule can be written
// in Python, whose lookbehind must be fixed-width.
// One character before the statute suffix, not two: 该法 / 本法 is how a second
// clause refers back to the statute the first one named, and that anaphor is
// two characters long in total.
const statuteBareName = "[\\u4e00-\\u9fa5]{1,20}(?:法|条例|办法|规定|细则|准则|规范|决定|命令|公告|药典)";
const statuteBareNameTrap = /(?:方法|用法|疗法|说法|看法|做法|想法|手法|写法|算法|语法|文法|合法|依法|司法|立法|执法|违法|非法|无法|书法|针法|制法|色谱法|滴定法|分析法|测定法|检查法|鉴别法|检验法)$/;
const statuteArticleLocators = Object.freeze([
  new RegExp(
    `${statuteTitlePattern}(?:[（(][^）)\\n]{0,24}[）)])?[^。；！？\\n]{0,24}?第\\s*(?<article>${statuteArticleNumber})\\s*条`,
    "g",
  ),
  new RegExp(
    `第\\s*(?<article>${statuteArticleNumber})\\s*条[^。；！？\\n]{0,24}?${statuteTitlePattern}`,
    "g",
  ),
  new RegExp(
    `(?:^|[^\\u4e00-\\u9fa5])(?<name>${statuteBareName})\\s*第\\s*(?<article>${statuteArticleNumber})\\s*条`,
    "g",
  ),
]);

/** Every article-level statute locator on one line, one per article number:
 *  the three orderings above can match the same assertion twice.
 *  @param {string} line
 *  @returns {{ text: string, article: string }[]}
 */
function statuteArticleLocatorsOn(line) {
  const byArticle = new Map();
  for (const pattern of statuteArticleLocators) {
    pattern.lastIndex = 0;
    for (const match of line.matchAll(pattern)) {
      const name = match.groups?.name;
      if (name && statuteBareNameTrap.test(name)) continue;
      const article = canonicalArticleNumber(match.groups?.article ?? "");
      if (!byArticle.has(article)) byArticle.set(article, { text: match[0], article });
    }
  }
  return [...byArticle.values()];
}
// A registry fact, not a tuned list: these namespaces are restricted by their
// registries to government entities, .int to intergovernmental treaty
// organisations, and .europa.eu to EU institutions. It covers npc.gov.cn,
// nmpa.gov.cn, legislation.gov.uk, accessdata.fda.gov, ema.europa.eu, who.int
// without a hand-curated allowlist and without a network call.
const governmentHostPattern = /(?:\.gov|\.gov\.[a-z]{2}|\.go\.[a-z]{2}|\.gouv\.fr|\.europa\.eu|\.int)$/;

/** @param {string} run */
function canonicalArticleNumber(run) {
  const text = String(run ?? "").trim();
  if (/^[0-9]+$/.test(text)) return String(Number(text));
  const value = cjkNumberValue(text);
  return value == null ? text : String(value);
}

/** Every article number a passage names, in both the Chinese and the English
 *  wording — a statute preserved from npc.gov.cn carries 第二十九条, its
 *  English rendering carries "Article 29", and both are the same article.
 *  @param {any} text
 */
function articleNumbersNamed(text) {
  const found = new Set();
  const source = String(text ?? "");
  for (const match of source.matchAll(new RegExp(`第\\s*(${statuteArticleNumber})\\s*条`, "g"))) {
    found.add(canonicalArticleNumber(match[1]));
  }
  for (const match of source.matchAll(/article\s+(\d{1,4})/gi)) found.add(String(Number(match[1])));
  return found;
}

/** The (sourceUrl, artifactPath, supportQuote, claim) tuples a claim offers. A
 *  synthesized claim offers one per supporting source; a derived result offers
 *  none, since it has no source of its own.
 *  @param {any} claim
 */
function claimSourceTuples(claim) {
  if (!claim || typeof claim !== "object") return [];
  if (claim.claimType === "derived") return [];
  if (claim.claimType === "synthesized" && Array.isArray(claim.supportingSources)) {
    return claim.supportingSources.map((/** @type {Record<string, any>} */ source) => ({
      sourceUrl: source?.sourceUrl,
      artifactPath: source?.artifactPath,
      supportQuote: source?.supportQuote,
      claim: claim.claim,
    }));
  }
  return [{
    sourceUrl: claim.sourceUrl,
    artifactPath: claim.artifactPath,
    supportQuote: claim.supportQuote,
    claim: claim.claim,
  }];
}

/** Article-level regulatory citations resting on something other than the
 *  issuing authority's own preserved text.
 *  @param {any} reportText @param {any[]} claims @param {Set<string>} successfulArtifacts
 *  @returns {{ line: number, locator: string, article: string, refs: number[], hosts: (string | null)[] }[]}
 */
function regulatoryArticleIssues(reportText, claims, successfulArtifacts) {
  const text = String(reportText ?? "");
  const referencesAt = text.search(/(?:^|\n)##\s+[^\n]*(?:参考文献|参考来源|References?)[^\n]*$/im);
  const body = referencesAt < 0 ? text : text.slice(0, referencesAt);
  const byReference = new Map();
  const byId = new Map();
  for (const claim of claims) {
    if (Number.isInteger(claim?.referenceNumber) && !byReference.has(claim.referenceNumber)) {
      byReference.set(claim.referenceNumber, claim);
    }
    if (typeof claim?.claimId === "string") byId.set(claim.claimId, claim);
  }
  const found = [];
  for (const [index, line] of body.split("\n").entries()) {
    if (/^\s*#{1,6}\s/.test(line)) continue;
    const locators = statuteArticleLocatorsOn(line);
    if (!locators.length) continue;
    const refs = [...standardCitationNumbers(line)].filter((number) => Number.isInteger(number)).sort((a, b) => a - b);
    const candidates = [
      ...refs.map((number) => byReference.get(number)),
      ...reportClaimIds(line).map((id) => byId.get(id)),
    ].filter(Boolean);
    const tuples = candidates.flatMap(claimSourceTuples);
    const hosts = [...new Set(tuples.map((tuple) => sourceDomain(tuple.sourceUrl)).filter(Boolean))];
    for (const { text: locatorText, article } of locators) {
      const licensed = tuples.some((tuple) => {
        const host = sourceDomain(tuple.sourceUrl);
        if (!host || !governmentHostPattern.test(host.replace(/\.$/, ""))) return false;
        if (typeof tuple.artifactPath !== "string" || !successfulArtifacts.has(tuple.artifactPath)) return false;
        return articleNumbersNamed(`${tuple.supportQuote ?? ""} ${tuple.claim ?? ""}`).has(article);
      });
      if (licensed) continue;
      found.push({ line: index + 1, locator: excerpt(locatorText), article, refs, hosts });
    }
  }
  return found;
}
// Attribution: the check every finding of this function is recorded under.
checkedBy(regulatoryArticleIssues, "regulatory-article");

// The manuscript register. The report is a scientific paper about a clinical
// question; it is never a paper about the task that produced it. Two
// vocabularies give that away, and both arrive the same way — copied out of a
// request that was written as an acceptance specification.
//
// The first is the commissioning party's: the item bank, its metrics, the
// answer the run was scored against. A paper never says who asked for it.
const commissioningVocabulary = Object.freeze([
  "题库",
  "语义群",
  "语义问题",
  "KPI",
  "达标率",
  "提及率",
  "强调率",
  "交付判据",
  "派发题面",
  "目标答案",
  "任务书",
]);
// The second is the acceptance form itself, printed inside the manuscript: a
// section named after a pass/fail condition, a lettered list of propositions
// with the conditions that would settle each, and a verdict verb applied to the
// report's own proposition. Fifteen delivered production reports were written in
// this register and read as a work record rather than as analysis.
const acceptanceConditionHeadingPattern = /^#{2,4}\s*[^\n]*判定条件/;
// `命题 A（发生率可定量）：……`. A single line like this can be a genuine
// reference to someone else's numbered proposition, so one is allowed and a
// list is not: the list is the acceptance form.
const letteredPropositionPattern = /^\s*(?:[-*+·•]\s*|\d+[.、)]\s*)?命题\s*[A-Za-z\d一二三四五六七八九十]{1,3}\s*[（(]/;
// 判为/判定为 delivering a verdict. 判定 by itself is ordinary clinical
// vocabulary (因果关系判定, 偏倚风险判定) and 误判为/错判为/研判为 are ordinary
// prose, so the verb alone proves nothing. What is rejected is the verb used to
// score the report's own proposition: a quoted verdict string, or a sentence
// whose subject is one of this report's propositions/angles/criteria — and even
// then only when no published grading instrument is named in the same sentence,
// because applying someone else's scale and reporting its level is exactly what
// the method requires.
const gradingVerbPattern = /(?<![误错研])判定?为/;
const quotedVerdictPattern = /(?<![误错研])判定?为\s*[「『“”"'‘’]/;
const selfGradedSubjectPattern = /命题|该角度|本角度|各角度|逐条判定|本报告|判定条件|交付判据|达标判据/;
const namedAppraisalInstrumentPattern = /GRADE|WHO[-‑\s]?UMC|Naranjo|诺氏|RoB\s?2|ROBINS[-‑]?I|QUADAS[-‑]?2|AMSTAR|Newcastle[-‑\s]?Ottawa|纽卡斯尔|Jadad|Cochrane|CONSORT|PRISMA|STROBE|CTCAE/i;
// Self-referential meta-narration: the paper talking about itself as the thing
// being delivered and checked, rather than about the evidence.
//
// Declaring the readership belongs to the same class and was the one shape no
// pattern here covered: 本文以临床医师与药师为读者 stood in the opening line of a
// delivered report. A paper does not announce whom it is written for — who its
// conclusions apply to is the applicability of 资料与方法 and the extrapolation
// of 讨论, which is what a reader actually needs.
//
// Every reader branch is anchored to the paper as its subject (本文/本报告/…),
// because the same words describe studied material: 以急性胸痛患者为研究对象 is a
// population, 该科普材料的受众对象为老年人 is a finding, and 本文以结构化临床问题
// 为起点 (in the repository fixture) is ordinary methods prose.
const selfReferentialNarrationPattern = /学术化版本|作为被评价对象|(?:本报告|本文)[^。；\n]{0,16}(?:判定条件|交付判据|达标判据|验收依据|任务书|评分口径)|(?:本报告|本文)[^。；\n]{0,10}拒绝[^。；\n]{0,24}(?:判据|验收|达标|指标)|(?:本文|本报告|本研究|本综述|全文)[^。；\n]{0,16}(?:以[^。；\n]{0,16}为(?:读者|受众|阅读对象)|面向[^。；\n]{0,14}(?:读者|受众|医师|医生|药师|同行|从业者)|写给[^。；\n]{0,14}(?:读者|受众|医师|医生|药师|同行|参考|阅读)|(?:目标)?(?:读者|受众)(?:群体?|对象)?\s*(?:为|是|包括))/;
// A verbatim support quote is a traceability device. Its home is supportQuote in
// the evidence matrix, where it is machine-checked
// against the preserved artifact; pasted into the body behind a 原文： label it
// is checked by nobody and reads as a matrix copied into a manuscript. One
// delivered report carried nine of them, three in a single paragraph.
const pastedSourceQuotePattern = /(?:原文|原句)\s*[:：]/;
// Latin-script function words stay lowercase inside a proper name, so a title is
// not read as a sentence merely because it contains them.
const properNameFunctionWords = new Set([
  "a", "an", "and", "at", "de", "for", "from", "in", "of", "on", "or", "the", "to", "van", "versus", "vs", "with",
]);
// English sentences are held together by closed-class words; enumerations of
// technical terms have none. A pharmacology manuscript legitimately lists drugs
// by INN, a mechanism paragraph names a signalling cascade, and an outcome
// definition lists its endpoints — all in lowercase Latin, all comma-separated,
// none of it a sentence: 硝酸酯类包括 isosorbide dinitrate, isosorbide
// mononitrate, nitroglycerin, glyceryl trinitrate, pentaerythritol tetranitrate,
// erythrityl tetranitrate, amyl nitrite, sodium nitroprusside 等 runs to fifteen
// words without one. Title Case exempts the named entities; this exempts the
// unnamed ones, and it costs no real detection — every pasted source sentence
// this rule exists for is ordinary prose and carries several of these.
const proseFunctionWords = new Set([
  "a", "an", "the", "and", "or", "but", "not", "no", "of", "in", "on", "at", "to", "for", "from", "with", "without",
  "by", "as", "into", "than", "that", "which", "who", "whom", "whose", "this", "these", "those", "it", "its", "they",
  "their", "we", "our", "is", "are", "was", "were", "be", "been", "being", "has", "have", "had", "do", "does", "did",
  "can", "could", "should", "would", "may", "might", "must", "will", "shall", "if", "when", "while", "because",
  "although", "however", "therefore", "between", "among", "during", "after", "before", "over", "under", "per", "via",
  "such", "both", "either", "neither", "all", "any", "each", "more", "most", "less", "least", "only", "also", "other",
  "same", "then", "there", "up", "out", "about",
]);
// A database search strategy is Boolean syntax, not prose, and PRISMA asks for
// it verbatim. Two or more uppercase operators, or a field tag, identify one.
const databaseFieldTagPattern = /\[(?:mesh|majr|tiab|ti|ab|tw|all fields|title\/abstract|pt|la|dp)[^\]]*\]/i;
const booleanOperatorPattern = /(?<![A-Za-z])(?:AND|OR|NOT)(?![A-Za-z])/g;
// Everything a Latin sentence may contain without interruption. Any other
// character — a CJK glyph, CJK punctuation, a table pipe — ends the run, so
// English words threaded through a Chinese sentence never accumulate.
const runInterruptPattern = /[^A-Za-z0-9\s.,;:'’()[\]%/&+\-–—<>="*#]/g;
const latinWordPattern = /[A-Za-z][A-Za-z'’]*(?:-[A-Za-z][A-Za-z'’]*)*/g;
const shortQuotedSpanPattern = /[“"「『]([^”"」』]{0,600})[”"」』]/g;
// A quotation the body is allowed to carry: a short phrase or a single sentence,
// inside quotation marks, grammatically inside the Chinese sentence around it.
// Twenty words is a generous sentence; past it the "quotation" is a paragraph.
const permittedQuotedWords = 20;
// The run length that separates a name from a sentence. The longest strings a
// Chinese manuscript legitimately carries untranslated are proper names and
// their expansions — PRISMA (Preferred Reporting Items for Systematic Reviews
// and Meta-Analyses) and STROBE at 8 words, the 2021 chest-pain guideline title
// at 9 — and those are exempt as Title Case anyway. Every one of the nine
// pasted source sentences in the report that prompted this rule ran 15 words or
// longer, so 12 clears the names with margin and catches the prose.
const untranslatedProseWords = 12;
// Absent evidence is a gap, not a counter-finding. "No directly applicable study
// was retrieved" is insufficient evidence to judge; it may never be summarised
// into evidence of no effect. The three parts are required in this order and in
// one sentence — the failed search, an inference connective, and a verdict on
// the intervention — because the gap stated on its own is the correct writing:
// 未检索到支持其用于该场景的直接证据 is exactly what the run is asked to write,
// and 未检索到直接证据，故该药无效 is the error.
//
// Only causal connectives count. 表明/提示/说明 would put the verdict inside the
// scope of the search instead of after it, and 未检索到证据表明其无效 reports a
// search that came back empty, which is the opposite of the error.
const absentEvidencePattern = /(?:未检索到|未能检索到|未检索出|未发现|未找到|未见|尚未检索到|缺乏|缺少|尚无|没有)[^。；\n]{0,24}(?:直接证据|随机对照(?:试验)?证据|随机对照试验|头对头(?:比较|研究|试验)?|对照研究|临床证据|循证证据|RCT)/;
const evidenceInferenceMarkerPattern = /(?:因此|因而|所以|故|可见|由此|据此|从而|于是)/;
// A verdict on the intervention, not on the evidence. 不足以支持 / 不足以判断 are
// the wordings the skill prescribes for a gap and must never be caught here, so
// every recommendation verb requires its object (使用/应用/将…).
const negativeVerdictPattern = /(?:无效|无疗效|没有疗效|无临床(?:价值|获益)|不(?:推荐|建议)(?:使用|应用|采用|服用|将)|不(?:应|宜|得)(?:使用|应用|服用)|应(?:避免|停止)使用|不支持(?:使用|将))/;
// Reporting the recommendation somebody else made is not inferring one: a body
// that names its own evidence bar and recommends against use has made a
// recommendation, and the paper is citing it.
const attributedRecommendationPattern = /(?:指南|共识|说明书|标签|药监|监管|批准|建议书|WHO|FDA|EMA|NMPA|NICE)/;
// --- Substitution conclusions ----------------------------------------------
// A sentence concluding that one compared arm may take the other's place.
// Which nouns are the compared arms is not decidable from the text, so this is
// read only by clinicalEvidenceAdvisoryNotes, as advice. It used to back a
// withholding check as well (`comparative-structure`), which fired on
// 「替代终点」, a surrogate endpoint, and was deleted on 2026-09-17.
// Swapping one arm for the other is stated by the verb alone, and 优于 is
// relational by itself. A bare comparative adjective is not: 该人群的依从性更好
// compares a property of one population against nothing in particular, and
// reading it as a conclusion about the arms rejected ordinary prose. It counts
// only where the sentence says what is being compared (前者/后者/两者/相比) or
// the clause makes it a choice between arms (更合适的选择).
const substitutionVerbPattern = /(?:替代|代替|取代|改用|换用|优于)/;
const comparativeQualityPattern = /更(?:为|加)?(?:优|佳|好|可靠|安全|有效|适合|合适)/;
const comparisonAnchorPattern = /前者|后者|两者|二者|相比|相较|较之/;
const choiceNounPattern = /选择|方案|之选|首选/;
// What is not a substitution claim, read in the clause that carries the verb so
// a neighbouring clause can neither license nor condemn this one: a negation
// (不能替代, 尚无……优于, 仍需直接研究验证), the comparator a trial uses inside
// itself (安慰剂, 对照组), and the thing a medicine may never replace —
// 任何药物都不能替代及时就医 is a safety instruction, not a comparison.
const substitutionNegationPattern = /[不无未非勿]|尚(?:待|需)|缺乏|缺少|难以|有待|仍需|避免|除外|排除/;
// Asking is not answering. 低反应者是否应改用另一药 is the open question this
// whole rule exists to keep open, and it carries the verb while concluding
// nothing. Read in the clause, like the negation, so an interrogative frame
// cannot license a conclusion standing beside it.
const openQuestionPattern = /是否|能否|可否|有无|[?？]/;
// Which evidence base is stronger is a statement about the literature, not
// about the medicines, and stating it is what a fixed-axis comparison is for:
// an axis may hold measured evidence on one arm and nothing on the other
// without any head-to-head study existing anywhere. It counts only where the
// comparative attaches to the evidence itself — 资料显示该制剂优于… is a claim
// about the medicines that happens to open with a source noun.
const evidenceBaseComparisonPattern = /(?:证据|研究|数据|文献|资料|报道|记录)(?:强度|质量|基础|数量|完整性|一致性|等级|确定性)?(?:[比较][^，。；\n]{0,12})?(?:更(?:为|加)?(?:充分|完整|可靠|一致|丰富|扎实)|优于)/;
// The repair this rule asks for is the bridge written out one link per line,
// each marked 已建立 or 未建立 — and the unestablished links are word for word
// the sentences it would otherwise read as conclusions (低反应者改用 B 后结局
// 更好). The mark licenses the link it marks: it may sit in a neighbouring
// clause (……后结局更好，该环未建立) or in a following sentence that is nothing
// but the mark (……后结局更好。该环未建立。). Only the unestablished mark
// licenses anything — a link asserted 已建立 without the study behind it is the
// conclusion itself.
const unestablishedLinkPattern = /(?:尚)?未(?:能|被|获)?(?:建立|证实|验证|确证)/;
const bareLinkMarkCharacters = 20;
const internalComparatorPattern = /安慰剂|placebo|空白|对照组|基线|常规治疗|标准治疗|假(?:手术|针刺)|治疗前/i;
const nonMedicineObjectPattern = /专业评估|规范评估|医疗评估|临床评估|系统评估|就医|就诊|急救|急诊|120|心电图|肌钙蛋白|检查|诊断|问诊|随访/;
// Reporting the comparison somebody else made is citation, not inference: a
// guideline that prefers one arm, or a trial that measured one against the
// other, is evidence the paper is passing on, and the citation checks hold it
// to its source.
const attributedComparisonPattern = /指南|共识|说明书|标签|药监|监管|批准|建议书|WHO|FDA|EMA|NMPA|NICE|该(?:研究|试验|综述|分析|队列|荟萃)|一项[^。；\n]{0,12}(?:研究|试验)|荟萃分析|Meta\s?分析|系统评价|系统综述/i;
// What separates a package that must be withheld from one that may be delivered
// with its gaps declared is whether a reader could tell.
//
// A quotation that is not in the source it names, a source that was never
// retrieved, a link that goes somewhere else, a claim that cites a paper
// published after it: none of these are visible from the document, so a reader
// has no way to discount them. Those stay blocking however inconvenient.
//
// A number that is not wired to its claim marker, a bibliography entry that is
// missing, a section that is thin: these are bookkeeping between the report and
// its apparatus. Withholding the whole analysis over them delivers nothing,
// which is the worse outcome for a reader who can see exactly what is flagged.
// Those are delivered with the run marked "unverified" and every gap named.
//
// The exact-string set below is the original allowlist. Interpolated messages
// carry claim indices and line numbers, so they can never appear in it; they are
// classified by shape in degradableIssue().
const degradableQualityIssues = new Set([
  "Deep-research reports must hide internal claim IDs in HTML comments and show standard numbered citations to readers.",
]);
// Gaps a reader can see, or that sit between the report and its apparatus rather
// than between a claim and its evidence. Everything else blocks.
const bookkeepingIssuePatterns = Object.freeze([
  // A figure in the prose that is not wired to the claim carrying it. The claim
  // and its quote are validated on their own; this is the cross-reference.
  /^Report line \d+ numeric facts .+ have no evidence-matrix claim reference\./,
  // A figure whose claim exists and whose quote was found in the real source,
  // but which does not appear inside that particular quoted span. It is named
  // in the delivered notice so a reader knows exactly which number to check.
  /^Report line \d+ numeric facts .+ are not present in the cited claim evidence\./,
  /^claims\[\d+\]\.claim numeric fact .+ is not present in its direct support/,
  /^claims\[\d+\]\.claim numeric fact .+ is not present in any supporting source/,
  // Report-to-matrix pairing and presentation.
  /^claims\[\d+\] is not paired with its standard numbered in-text citation\.$/,
  // A later line repeating a marker whose number it does not carry. Same
  // bookkeeping as the line above, one line further on — except inside the
  // practical section, where it carries a different prefix and blocks, because
  // that section is read as instruction.
  /^Report line \d+ anchors claim /,
  /^The academic report is missing a required section matching /,
  /^The academic report contains (?:runtime or retrieval-process|operational failure) prose/,
  // An appraisal instrument promised in 资料与方法 that never rated anything in
  // 结果 or 讨论. Named for the reader because it is worth knowing, degradable
  // because "the stratum this instrument covers came back empty" and "the
  // appraisal was skipped" are the same sentence in prose — see the note above
  // appraisalInstruments.
  /^资料与方法声明了 /,
]);

// Which run-level error code a rejected package earns. Every one of these is a
// finished package with an actionable defect inside it, so every one of them is
// a member of repairableEvidencePackageErrorCodes in agentRuns.mjs and goes
// back through the repair loop rather than being thrown away. The default —
// specialist_evidence_traceability_failed — is what the whole gate returned
// before, so a check that grows a message of its own without an entry here
// keeps exactly the behaviour it had.
//
// The order is the order of specificity, and the first match wins.
const clinicalEvidenceIssueCodes = Object.freeze([
  { pattern: /^临床实践要点第 \d+ 行把/, code: "practical_emergency_trigger_conditioned_on_medication_response" },
  { pattern: /^报告正文第 \d+ 行以条款级方式引用/, code: "regulatory_article_without_official_source" },
  // 资料与方法声明了… is degradable and never reaches this list.
  { pattern: /^GRADE 等级与降级理由不自洽/, code: "declared-appraisal-must-execute" },
]);

/** The run-level error code for a package's blocking issues.
 *  @param {readonly any[]} issues
 */
export function clinicalEvidencePackageErrorCode(issues) {
  for (const { pattern, code } of clinicalEvidenceIssueCodes) {
    if (issues.some((issue) => pattern.test(String(issue ?? "")))) return code;
  }
  return "specialist_evidence_traceability_failed";
}

/** @param {any} issue */
function degradableIssue(issue) {
  const text = String(issue ?? "");
  if (degradableQualityIssues.has(text)) return true;
  return bookkeepingIssuePatterns.some((pattern) => pattern.test(text));
}

const visibleClaimMarkerPattern = /\[claim:(CLM-[0-9]{3,6})\]/g;
const hiddenClaimMarkerPattern = /<!--\s*claim:(CLM-[0-9]{3,6})\s*-->/g;

// Drug- and scenario-specific clinical safety rules are maintained as data in
// clinical-safety-rules.json (pharmacist-owned), compiled once at module load.
// A missing or malformed ruleset fails closed: the server will not start rather
// than run the clinical gate without its safety rules.
/** @param {Record<string, any>} rule
 *  Nullable here because that is what the JSON may literally contain;
 *  `loadClinicalSafetyRules` is what refuses a rule that leaves a required one
 *  out, so everything downstream of the load may treat them as present.
 *  @returns {{ id: string, kind: string, message: string, pattern: RegExp | null,
 *    triggerPattern: RegExp | null, substitutions: { find: RegExp, replace: string }[] }} */
export function compileClinicalSafetyRule(rule) {
  return {
    id: rule.id,
    kind: rule.kind,
    message: rule.message,
    pattern: rule.pattern != null ? new RegExp(rule.pattern, rule.flags ?? "") : null,
    triggerPattern: rule.triggerPattern != null ? new RegExp(rule.triggerPattern, rule.triggerFlags ?? "") : null,
    substitutions: Array.isArray(rule.reportSubstitutions)
      ? rule.reportSubstitutions.map((entry) => ({ find: new RegExp(entry.find, entry.flags ?? "g"), replace: String(entry.replace ?? "") }))
      : [],
  };
}

function loadClinicalSafetyRules() {
  const parsed = clinicalSafetyRulesData;
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.rules) || parsed.rules.length === 0) {
    throw new Error("clinical-safety-rules.json is missing or malformed.");
  }
  const compiled = parsed.rules.map(compileClinicalSafetyRule);
  validateLoadedSafetyRules(compiled);
  return Object.freeze(compiled);
}

/**
 * Refuses a rule that leaves out what its kind needs — at load, not where the
 * rule is applied.
 *
 * This file is data precisely so a pharmacist can edit it without touching
 * server code, which is also what makes a rule missing its `pattern` a
 * realistic mistake rather than a hypothetical one. Every branch of
 * `evaluateClinicalSafetyRules` calls `.test()` unconditionally, so such a rule
 * threw — not at startup, but the first time a finished package was graded
 * against it. A deployment that cannot enforce what it promises must refuse to
 * start, not fail inside a delivery decision.
 *
 * Exported so the refusal itself is testable without a malformed file on disk.
 * @param {readonly Record<string, any>[] | null} rules null means "this build's own"
 * @returns {void}
 */
export function validateLoadedSafetyRules(rules) {
  for (const rule of rules ?? clinicalSafetyRules) {
    const missing = [
      !rule.id && "id",
      !rule.message && "message",
      !rule.pattern && "pattern",
      rule.kind === "practical_required_when_report_matches" && !rule.triggerPattern && "triggerPattern",
    ].filter(Boolean);
    if (missing.length) {
      throw new Error(`clinical-safety-rules.json: rule "${rule.id || "(unnamed)"}" is missing ${missing.join(", ")}.`);
    }
  }
}

/** @type {readonly { id: string, kind: string, message: string, pattern: RegExp, triggerPattern: RegExp | null, substitutions: { find: RegExp, replace: string }[] }[]} */
const clinicalSafetyRules = /** @type {any} */ (loadClinicalSafetyRules());

/**
 * @param {{ reportText?: unknown, practical?: unknown, question?: unknown }} input
 * @returns {string[]} the `message` of each rule that fired
 *
 * Exported so a second clinical deliverable can be graded by these rules
 * instead of by a copy of them. The GEO content pack is the second: it carries
 * medicine advice written to be quoted by a machine that will not add the
 * caveat back, so it is under the clinical contract and has to satisfy the
 * same rules — and writing a "GEO version" of them is how the pair that drifted
 * three times got started.
 *
 * Which rules apply is decided by what a caller passes, not by a flag. A pack
 * has no practical section and no originating question, so it passes its prose
 * as both `reportText` and `practical` and omits `question`:
 * `entity_requires_question_mention` then does not fire, which is correct — it
 * asks whether a medicine was dragged into an answer that was not about it, and
 * a brand's content block is legitimately about that brand.
 */
export function evaluateClinicalSafetyRules({ reportText, practical, question }) {
  return clinicalSafetyRuleHits({ reportText, practical, question }).map((hit) => hit.message);
}
// Attribution: the check every finding of this function is recorded under.
checkedBy(evaluateClinicalSafetyRules, "clinical-safety-rules");

/**
 * The same rules, plus which one fired and where it fired.
 *
 * A message is the one thing a false-positive distribution cannot be computed
 * over. All four rules arrive under one check id, so today the ledger can say
 * "a safety rule fired" and nothing further — while the rules are already data
 * carrying ids of their own. This returns them, so a finding can be attributed
 * to the rule that produced it rather than to the file that holds all four.
 * That is the input the blocking budget asks for before a rule is widened,
 * narrowed, or moved to the model-judge path, and it does not exist until the
 * id survives the call.
 *
 * `line` indexes the text named by `where`, never "the deliverable". A rule of
 * kind `practical_required_when_report_matches` fires on an *absence* in the
 * practical section: the only line it can point at is where its trigger matched
 * the report, and `where: "trigger"` says so rather than letting the number be
 * read as the offending line.
 * @param {{ reportText?: unknown, practical?: unknown, question?: unknown }} input
 * @returns {{ ruleId: string, message: string, line: number | null, where: string, match: string | null }[]}
 */
export function clinicalSafetyRuleHits({ reportText, practical, question }) {
  const report = String(reportText ?? "");
  const practicalText = String(practical ?? "");
  /** @type {{ ruleId: string, message: string, line: number | null, where: string, match: string | null }[]} */
  const found = [];
  /** A rule's pattern may carry `g`, and `.test()` on a global regex advances
   *  `lastIndex` — scanning line by line with the rule's own object would skip
   *  lines and report the wrong one. Locate with a stateless copy. The matched
   *  text rides along: a rule's message says what must not be claimed, and a
   *  run that cannot see which sentence made the claim rewrites the wrong
   *  ones — a geo-content run spent all three submissions that way.
   *  @param {string} text @param {RegExp} pattern @param {string} where
   *  @returns {{ line: number | null, where: string, match: string | null }} */
  const locate = (text, pattern, where) => {
    const located = firstMatchingLine(text, new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")));
    return { line: located?.line ?? null, where, match: located?.match ?? null };
  };
  for (const rule of clinicalSafetyRules) {
    if (rule.kind === "report_forbidden") {
      let text = report;
      for (const substitution of rule.substitutions) text = text.replace(substitution.find, substitution.replace);
      // Located in the substituted text because that is the text that was
      // tested. The substitutions replace in place and introduce no newlines,
      // so the number still indexes the report as the author wrote it.
      if (rule.pattern.test(text)) found.push({ ruleId: rule.id, message: rule.message, ...locate(text, rule.pattern, "report") });
    } else if (rule.kind === "practical_forbidden") {
      if (rule.pattern.test(practicalText)) found.push({ ruleId: rule.id, message: rule.message, ...locate(practicalText, rule.pattern, "practical") });
    } else if (rule.kind === "entity_requires_question_mention") {
      if (nonEmpty(question) && !rule.pattern.test(String(question)) && rule.pattern.test(report)) {
        found.push({ ruleId: rule.id, message: rule.message, ...locate(report, rule.pattern, "report") });
      }
    } else if (rule.kind === "practical_required_when_report_matches") {
      // `triggerPattern` is required for this kind and checked at load.
      const trigger = /** @type {RegExp} */ (rule.triggerPattern);
      if (trigger.test(report) && !rule.pattern.test(practicalText)) {
        found.push({ ruleId: rule.id, message: rule.message, ...locate(report, trigger, "trigger") });
      }
    }
  }
  return found;
}
checkedBy(clinicalSafetyRuleHits, "clinical-safety-rules");

/** @param {unknown} value @param {number} [minimum] @returns {boolean} */
function nonEmpty(value, minimum = 1) {
  return typeof value === "string" && value.trim().length >= minimum;
}

// The same standard the report's citations are held to: an address a reader can
// open, carrying no credentials. Requiring https here while the report-side
// check accepts http left one rule for a citation and another for the very same
// URL in the matrix behind it — and a fragment, which is how a citation points
// at the passage it means, disqualified the source outright.
/** @param {string} value @returns {string | null} */
function sourceDomain(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Differences that do not bear on whether a quotation is genuine: smart quotes,
// dash width, line wrapping, and the case of a letter. Quoting from mid-sentence
// and lowercasing the leading article is ordinary scholarly practice, and it was
// being reported as a quotation absent from its source — one letter cost a whole
// package, on a passage that was verbatim in every other respect.
/** @param {unknown} value @returns {string} */
function normalizedPassage(value) {
  return String(value ?? "")
    // NFKC alone turns 10³ into 103, changing the scientific value. Preserve
    // exponent notation before normalizing compatible typography.
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+/gu, (exponent) => `^${exponent.normalize("NFKC").replace(/−/g, "-")}`)
    .normalize("NFKC")
    // Soft hyphens and zero-width joiners survive NFKC and are invisible in the
    // artifact, so a faithfully retyped quote silently fails to match.
    .replace(/\u00AD|\u200B|\u200C|\u200D|\uFEFF/g, "")
    // Quotes after numbers can denote measurement units (5'3"). Retain those
    // boundaries, including NFKC's double-prime decomposition, before stripping
    // ordinary typographic quotation marks.
    .replace(/(?<=\d)[‘’'′“”"″]+/gu, (marks) => marks.replace(/[“”"″]/gu, "′′").replace(/[‘’']/gu, "′"))
    .replace(/[‘’“”"'＂＇]/g, "")
    .replace(/[⁄∕]/gu, "/")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    // PDF extraction routinely spaces out CJK runs ("速 效 救 心 丸"). The
    // spacing is an artefact of the extractor, not of the source, so it must
    // not decide whether a quote is found.
    .replace(/(?<=[\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF])\s+(?=[\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF])/g, "")
    .trim()
    .toLowerCase();
}

/** @param {unknown} value @returns {boolean} */
function validSupportingPassage(value) {
  return normalizedPassage(value).replace(/\s+/g, "").length > 0;
}

// A coarse projection used only to diagnose an unmarked gap after quotation
// validation fails. It must never authorize a quote: removing separators can
// turn a decimal into an integer or join words with different meanings.
/** @param {unknown} value @returns {string} */
function passageSkeleton(value) {
  return normalizedPassage(value).replace(/[^\p{L}\p{N}<>=≥≤±%]+/gu, "");
}

// Scholarly elision. A quote may skip a passage it does not need, marking the
// gap: each segment must still be verbatim, and the segments must appear in the
// source in the order written, without overlapping.
const quoteElision = /\s*(?:\.{3,}|…)+\s*/;

// A superscript citation rendered inline by the extractor — "...coronary spasm
// patients.23 Li Jin et al found..." — belongs to the document's apparatus, not
// to the sentence, and no one quoting the sentence would copy it. The preceding
// character must not be a digit, or the 25 of "0.25" would be read as a marker.
const inlineReferenceMarker = /(?<=[^\d\s][.。!?])\d{1,3}(?=\s|$)/gu;

const passageNumberAtom = "(?:(?:[<>]=?|!=|[≤≥≠≈≃≅~])\\s*)?(?:(?:\\+\\s*/\\s*[-−]|[+\\-−±])\\s*)?(?:\\d+(?:[.,]\\d+)*|[.,]\\d+)(?:e[+\\-−]?\\d+)?(?:\\s*(?:\\^|\\*\\*)\\s*[+\\-−]?\\d+)?(?:\\s*[%‰])?(?:[′″]+(?:\\s*\\d+(?:[.,]\\d+)?[′″]+)?)?";
const passageNumberToken = new RegExp(`${passageNumberAtom}(?:\\s*(?:\\+\\s*/\\s*[-−]|[/–—−:×·*±-]|x(?=\\s*\\d))\\s*${passageNumberAtom})*`, "gu");
const passageWordCharacter = /[\p{L}\p{M}\p{N}_]/u;
const continuousWritingCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** CJK quotations do not use spaces as word separators; numeric edges below
 * remain checked regardless of script. @param {string} character */
function joinedWordCharacter(character) {
  return passageWordCharacter.test(character) && !continuousWritingCharacter.test(character);
}

/** @param {string} source @param {string} needle @param {number} start @param {number[][]} numericSpans */
function completePassageMatch(source, needle, start, numericSpans) {
  const end = start + needle.length;
  if (start > 0 && joinedWordCharacter(needle[0]) && (
    joinedWordCharacter(source[start - 1])
    || (start > 1 && source[start - 1] === "-" && joinedWordCharacter(source[start - 2]))
  )) return false;
  if (end < source.length && joinedWordCharacter(needle.at(-1) ?? "") && (
    joinedWordCharacter(source[end])
    || (end + 1 < source.length && source[end] === "-" && joinedWordCharacter(source[end + 1]))
  )) return false;
  for (const boundary of [start, end]) {
    let low = 0;
    let high = numericSpans.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (numericSpans[middle][0] <= boundary) low = middle + 1;
      else high = middle;
    }
    if (low > 0 && numericSpans[low - 1][0] < boundary && boundary < numericSpans[low - 1][1]) return false;
  }
  return true;
}

/** Repair recognized extraction layout while retaining word boundaries and
 * numeric punctuation. @param {unknown} value @returns {string} */
function normalizedExtractionPassage(value) {
  return normalizedPassage(String(value ?? "")
    .replace(/(?<=\p{L})-\r?\n\s*(?=\p{L})/gu, "")
    .replace(/(?<=\p{L})[ \t]+-[ \t]+(?=\p{L})/gu, "")
    // A marker before a number can be its sign; only remove a textual bullet.
    .replace(/(^|\r?\n)[ \t]*[-*+][ \t]+(?=\p{L})/gu, "$1"))
    .replace(/\s+([.,;:!?。！？])/gu, "$1");
}

/** @param {string} haystack @param {readonly string[]} segments @param {(segment: string) => string} project @returns {boolean} */
function segmentsPresentInOrder(haystack, segments, project) {
  if (!haystack) return false;
  const numericSpans = [...haystack.matchAll(passageNumberToken)].map((match) => [match.index, match.index + match[0].length]);
  let from = 0;
  for (const segment of segments) {
    const needle = project(segment);
    if (!needle) return false;
    let at = haystack.indexOf(needle, from);
    while (at >= 0 && !completePassageMatch(haystack, needle, at, numericSpans)) {
      at = haystack.indexOf(needle, at + 1);
    }
    if (at < 0) return false;
    from = at + needle.length;
  }
  return true;
}

// A preserved artifact carries extraction noise inside its sentences: a PDF
// line break splits a word ("coronary artery dis - ease"), a markdown list
// marker lands mid-sentence ("call 999 if: - you get sudden pain"), an
// extractor leaves a space before punctuation ("activity 37 ."). A quote copied
// the way a human reads the sentence can then fail literal containment. The
// bounded layout normalization above repairs those forms without deleting
// ordinary word separators, decimal points, signs or comparison operators.
//
// A quote may also elide — mark a skipped passage with … — the way any scholarly
// quotation does. Each segment is then verified on its own, in order and without
// overlapping, so an elision cannot join two passages that do not occur in that
// sequence.
// A quote that joins two passages without marking the gap fails the same check
// as one the source never contained, but the two need opposite repairs — mark
// the elision, versus find the passage that actually says it. Telling them
// apart is worth the scan: both halves are in the document, just not adjacent.
/** @param {unknown} artifact @param {unknown} quote @returns {boolean} */
function quoteJoinsUnmarkedPassages(artifact, quote) {
  const haystack = passageSkeleton(artifact);
  const needle = passageSkeleton(quote);
  if (!haystack || needle.length < 60) return false;
  let matched = 0;
  for (let length = needle.length - 1; length >= 30; length -= 1) {
    if (haystack.includes(needle.slice(0, length))) {
      matched = length;
      break;
    }
  }
  if (!matched) return false;
  const rest = needle.slice(matched);
  if (rest.length < 30) return false;
  const resumesAfter = haystack.indexOf(needle.slice(0, matched)) + matched;
  return haystack.indexOf(rest, resumesAfter) >= 0;
}

// One field is one problem, and the same complaint about forty claims is one
// decision.
//
// Grouped by the message itself, with the claim index removed — not by any
// pattern of what the message says. I wrote this twice too narrowly first. The
// version keyed on `is ""` missed twenty claims that all named the run's own
// notes file; the version keyed on `is "<value>"` then missed
// `claims[1].artifactPath is not listed as a successful source artifact for
// this run.`, which carries no value at all, and a gate came back with 119
// required issues that were a handful of decisions. Identical text about
// different claims is one finding; different text stays separate on its own,
// with no list of shapes to keep up to date.
//
// The generic `must be a non-empty string.` still gives way wherever the same
// field already has a specific finding: two messages for one empty value is a
// different duplication, and the specific one says what to do.
/** The collapse reads and returns attributed findings: a finding that is
 *  dropped or folded into another must take its check with it, or the ledger
 *  would end up counting a rule that raised nothing and losing one that did.
 *  @param {AttributedIssue[]} issues @returns {AttributedIssue[]} */
function collapseClaimFieldIssues(issues) {
  const shape = /^(claims\[\d+\])\.([A-Za-z]+) must be a non-empty string\.$/;
  const specific = new Set();
  for (const issue of issues) {
    const found = /^(claims\[\d+\])\.([A-Za-z]+) /.exec(issue.text);
    if (found && !shape.test(issue.text)) specific.add(`${found[1]}.${found[2]}`);
  }
  const deduped = issues.filter((issue) => {
    const found = shape.exec(issue.text);
    return !found || !specific.has(`${found[1]}.${found[2]}`);
  });

  // Which prefixes carry a position rather than a fact. A claim index and a
  // report line number are both "where", and the sentence after them is the
  // "what" that decides whether two findings are one.
  //
  // Only `claims[N]` was listed here at first. Replaying five real packages
  // through the gate then showed `Report line N numeric facts 24 have no
  // evidence-matrix claim reference.` four and five times in single packages —
  // one unbound figure, reported once per line it appears on. Same family,
  // seventh location, and found in three seconds by replay rather than by
  // spending another run on it.
  const positional = /^(claims\[\d+\]|supportingSources\[\d+\]|Report line \d+)/;
  /** One function, used to build the group and to find its members again.
   *  @param {string} text @returns {string} */
  const keyOf = (text) => text.replace(positional, (found) => found.replace(/\d+/, ""));
  /** @type {Map<string, AttributedIssue[]>} */
  const groups = new Map();
  for (const issue of deduped) {
    if (!positional.test(issue.text)) continue;
    groups.set(keyOf(issue.text), [...(groups.get(keyOf(issue.text)) ?? []), issue]);
  }
  let collapsed = deduped;
  for (const [key, members] of groups) {
    if (members.length < 3) continue;
    // The first one verbatim, and then the scope. Rewriting the sentence around
    // a count produced 「……不是 20 个错误。, which is not a preserved artifact.」 —
    // a fragment stitched onto a full stop. The rule's own words are the half
    // that says what to do.
    const labels = members.slice(1).map((member) => positional.exec(member.text)?.[0] ?? "");
    const listed = labels.length > 5 ? `${labels.slice(0, 5).join("、")} 等` : labels.join("、");
    collapsed = [
      // The same key the group was built with. This kept the old
      // `claims[\d+]`-only replacement after the grouping learned about report
      // lines, so a report-line group matched nothing here: the collapsed
      // sentence was appended and not one of its members removed, and the
      // package came back with MORE findings than before the collapse ran.
      ...collapsed.filter((issue) => keyOf(issue.text) !== key),
      // A group is one rule's sentence about several claims, so its members
      // share a check by construction; the first member's is the group's.
      {
        check: members[0].check,
        text: `${members[0].text} 另有 ${labels.length} 处是同一条（${listed}）：这是一处决定，改一次就能全部修好。`,
      },
    ];
  }
  return collapsed;
}

/** @param {unknown} artifact @param {unknown} quote @returns {string} */
function quoteFailure(artifact, quote) {
  return quoteJoinsUnmarkedPassages(artifact, quote)
    ? "joins two passages that are not adjacent in the source. Mark the gap with … if the elision is intended, or quote the one passage that carries the claim"
    : "was not found in its preserved source artifact";
}

/** @param {unknown} artifact @param {unknown} quote @returns {boolean} */
function quoteIsPresent(artifact, quote) {
  const source = String(artifact ?? "");
  const segments = String(quote ?? "").split(quoteElision).map((part) => part.trim()).filter(Boolean);
  if (!source || !segments.length) return false;
  // The artifact as preserved, then with inline citation markers taken out.
  for (const text of [source, source.replace(inlineReferenceMarker, "")]) {
    if (segmentsPresentInOrder(normalizedPassage(text), segments, normalizedPassage)) return true;
    if (segmentsPresentInOrder(normalizedExtractionPassage(text), segments, normalizedExtractionPassage)) return true;
  }
  return false;
}

// A verdict about a quote needs the text the quote is supposed to be in.
//
// With no entry for a path, `quoteIsPresent` compares against "" and returns
// false, and the caller then reports `was not found in its preserved source
// artifact` — the same words as a genuinely misquoted passage, for a cause no
// rewrite can reach. RQ-03 spent its last two repair rounds retyping ten quotes
// that were already verbatim correct, and ran out of attempts: its evidence rows
// were stamped with a session id, so the join that fills this map matched no
// rows and handed over nothing at all.
//
// Both readings of an absent entry — never preserved on disk, or preserved and
// not carried here — are beyond editing the quote, and both are answered by
// citing a source whose file exists. Say that. Never report a document we did
// not read as one the passage is missing from.
/**
 * @param {Map<string, string>} artifactText @param {string} label
 * @param {string} artifactPath @param {unknown} quote @returns {string | null}
 */
function supportQuoteIssue(artifactText, label, artifactPath, quote) {
  const artifact = artifactText.get(artifactPath);
  if (!artifact) {
    return `${label}.supportQuote could not be checked: no preserved text for ${JSON.stringify(artifactPath)} reached this check, so the quote was neither confirmed nor refuted — rewriting it cannot help. Either the source was never written under .evimed-sources, or this run's evidence ledger did not carry it here. Cite a source whose preserved file exists, or preserve this one first.`;
  }
  if (!quoteIsPresent(artifact, quote)) return `${label}.supportQuote ${quoteFailure(artifact, quote)}.`;
  return null;
}

/**
 * Whether each claim's quotation is in the source it names, per claim, for a
 * reader (2026-09-17).
 *
 * The gate used to answer this for the whole package and withhold it; a reader
 * is better served by the report with each claim marked. Uses `quoteIsPresent`,
 * the comparison the gate itself makes, so the mark and the verdict cannot
 * disagree. Statuses, per quoted source and per claim:
 *
 *   - `verified` — the quotation is in the preserved file;
 *   - `quote_not_found` — the file was read and the quotation is not in it;
 *   - `source_unavailable` — no preserved text for the path reached this check,
 *     so the quotation was neither confirmed nor refuted;
 *   - `no_quote` — the claim names no quotation or no preserved path;
 *   - `derived` — the analyst's own estimate: it has inputs, not a quotation.
 *
 * A synthesized claim is `verified` only when every source it lists is.
 *
 * @param {{ matrix?: any, sourceArtifacts?: Map<string, string> | Record<string, string> }} input
 * @returns {{ claims: { claimId: string, claimType: string, status: string, sources: { artifactPath: string | null, status: string }[] }[], counts: Record<string, number> }}
 */
export function claimVerification({ matrix, sourceArtifacts = {} } = {}) {
  const artifactText = sourceArtifacts instanceof Map
    ? sourceArtifacts
    : new Map(Object.entries(sourceArtifacts && typeof sourceArtifacts === "object" ? sourceArtifacts : {}));
  /** @param {any} source */
  const sourceStatus = (source) => {
    const artifactPath = validSourceArtifactPath(source?.artifactPath) ? source.artifactPath : null;
    if (!artifactPath || !validSupportingPassage(source?.supportQuote)) return { artifactPath, status: "no_quote" };
    const artifact = artifactText.get(artifactPath);
    if (!artifact) return { artifactPath, status: "source_unavailable" };
    return { artifactPath, status: quoteIsPresent(artifact, source.supportQuote) ? "verified" : "quote_not_found" };
  };
  const worst = ["quote_not_found", "source_unavailable", "no_quote", "verified"];
  /** @type {Record<string, number>} */
  const counts = {};
  const claims = (Array.isArray(matrix?.claims) ? matrix.claims : [])
    .filter((/** @type {any} */ claim) => claim && typeof claim === "object" && nonEmpty(claim.claimId))
    .map((/** @type {any} */ claim) => {
      const claimType = String(claim.claimType ?? "direct");
      /** @type {{ artifactPath: string | null, status: string }[]} */
      let sources = [];
      let status = "derived";
      if (claimType !== "derived") {
        sources = claimType === "synthesized"
          ? (Array.isArray(claim.supportingSources) ? claim.supportingSources : []).map(sourceStatus)
          : [sourceStatus(claim)];
        status = worst.find((candidate) => sources.some((source) => source.status === candidate)) ?? "no_quote";
      }
      counts[status] = (counts[status] ?? 0) + 1;
      return { claimId: String(claim.claimId), claimType, status, sources };
    });
  return { claims, counts };
}

// The text a claim's numeric and quotational support is drawn from. Direct
// claims draw on their own single source; synthesized claims draw on every
// supporting source plus the claim statement itself.
/** @param {Record<string, any> | null | undefined} claim @returns {string} */
function claimEvidenceText(claim) {
  if (claim?.claimType === "synthesized" && Array.isArray(claim?.supportingSources)) {
    return [
      claim?.claim,
      ...claim.supportingSources.flatMap((source) => [source?.supportQuote, source?.sourceTitle, source?.identifier]),
    ].join(" ");
  }
  // A derived result's numbers cannot be in a source — that is what makes it
  // derived. They must be in the derivation: the method that produced them, the
  // assumptions they rest on, and the sensitivity that bounds them. So an
  // estimate quoted in the prose has to be an estimate the working shows.
  if (claim?.claimType === "derived") {
    return [claim?.claim, claim?.method, claim?.assumptions, claim?.sensitivity, claim?.uncertainty].join(" ");
  }
  return [claim?.claim, claim?.supportQuote, claim?.sourceTitle, claim?.identifier].join(" ");
}

/** @param {unknown} value @returns {string[]} */
function numericTokens(value) {
  return String(value ?? "")
    .replace(/\]\(https?:\/\/[^)\s]+\)/gi, "]")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\[claim:CLM-[0-9]{3,6}\]/g, "")
    .replace(/<!--\s*claim:CLM-[0-9]{3,6}\s*-->/g, "")
    .replace(/\[(?:\d+(?:\s*[-,]\s*\d+)*)\]/g, "")
    .replace(/\b(?=[A-Za-z0-9-]*[0-9])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*\b/g, "")
    .replace(/[（(]\s*[1-9]\d?\s*[)）]/g, "")
    .replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, "")
    .replace(/%(\s*[–—-]\s*)(?=\d)/g, "$1")
    .match(/[0-9]+(?:\.[0-9]+)?(?:\s*[–—-]\s*[0-9]+(?:\.[0-9]+)?)?/g)
    ?.map((token) => token
      .replace(/\s+/g, "")
      .replace(/[–—]/g, "-")
      .split("-")
      .map((part) => part
        .replace(/^0+(?=\d)/, "")
        .replace(/(\.\d*?)0+$/, "$1")
        .replace(/\.$/, ""))
      .join("-")) ?? [];
}

// --- Conclusory quantity extraction (item 8) -------------------------------
// The report-wide audit checks only *conclusory* quantitative statements — a
// number (Arabic or Chinese) carrying a unit or statistical marker — instead of
// every integer on every line. This stops false positives on structural numbers
// (list positions, "3 databases", "2 groups") while still requiring that any
// stated effect size, rate, sample size, dose, or study count trace to cited
// evidence. Chinese numerals are supported and MUST be gated the same way, since
// 一/十/百 also occur inside ordinary words (一致, 十分, 百般).
/** @type {Record<string, number>} */
const cjkDigit = { "〇": 0, "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
/** @type {Record<string, number>} */
const cjkUnitSmall = { "十": 10, "百": 100, "千": 1000 };
/** @type {Record<string, number>} */
const cjkUnitBig = { "万": 10000, "亿": 100000000 };

/** @param {string} run @returns {number | null} */
function cjkNumberValue(run) {
  let total = 0;
  let section = 0;
  let current = 0;
  let consumed = false;
  for (const character of run) {
    if (character in cjkDigit) {
      current = cjkDigit[character];
      consumed = true;
    } else if (character in cjkUnitSmall) {
      section += (current || 1) * cjkUnitSmall[character];
      current = 0;
      consumed = true;
    } else if (character in cjkUnitBig) {
      section = (section + current) * cjkUnitBig[character];
      total += section;
      section = 0;
      current = 0;
      consumed = true;
    } else {
      return null;
    }
  }
  return consumed ? total + section + current : null;
}

// Spelled-out English cardinals ("fifteen trials") are recognized on BOTH the
// report and support sides and only when conclusory (unit/statistic adjacent),
// exactly like Arabic and Chinese numerals, so 15 / 十五 / "fifteen" agree
// without an asymmetric support-only widening that could mask a fabrication.
/** @type {Record<string, number>} */
const enOnes = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
/** @type {Record<string, number>} */
const enTens = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/** @type {Record<string, number>} */
const enScales = { hundred: 100, thousand: 1000, million: 1000000, billion: 1000000000 };
const enWordsAlt = [...Object.keys(enOnes), ...Object.keys(enTens), ...Object.keys(enScales)].join("|");

/** @param {readonly string[]} words @returns {number | null} */
function englishNumberRunValue(words) {
  let total = 0;
  let current = 0;
  let any = false;
  for (const word of words) {
    if (word in enOnes) { current += enOnes[word]; any = true; }
    else if (word in enTens) { current += enTens[word]; any = true; }
    else if (word in enScales) {
      const scale = enScales[word];
      if (scale === 100) current = (current || 1) * 100;
      else { total += (current || 1) * scale; current = 0; }
      any = true;
    } else return null;
  }
  return any ? total + current : null;
}

const conclusoryNumber = `(?:[0-9]+(?:\\.[0-9]+)?(?:\\s*[–—-]\\s*[0-9]+(?:\\.[0-9]+)?)?|[〇零一二两三四五六七八九十百千万亿]+|\\b(?:${enWordsAlt})(?:[\\s-]+(?:${enWordsAlt}))*\\b)`;
// A unit or statistic marks the number as a measured quantity. The trailing
// (?![A-Za-z]) keeps a bare letter unit (g, L) from matching the start of an
// ordinary word (groups, guideline). Chinese dose units are included so a dose
// like 100毫克 is audited.
const conclusoryUnit = "(?:%|‰|倍|percent|fold|times|mg|µg|μg|ug|mcg|ng|kg|g|mmol\\/?L?|mol|mmHg|mL|ml|L|IU|毫克|微克|纳克|千克|克|毫升|微升|升|毫摩尔|摩尔|国际单位|片|粒|支|滴|例次|人次|例患者|例|名|人|患者|项|次|周|月|年|天|日|岁|weeks?|months?|years?|days?|participants|patients|subjects|trials|studies|cases)(?![A-Za-z])";
// Effect-size / rate labels. The separator before the number may be "=", ":", a
// comparison operator, or a Chinese connective (为/是/约); a bare space also
// works. Without this an "OR=4.2" or "风险比为3.8" would escape the audit.
const ratioPrefix = "(?<![A-Za-z])(?:HR|aHR|OR|aOR|RR|aRR|风险比|比值比|危险比|相对危险度|CI|置信区间|发生率|有效率|敏感度|特异度|阳性率|死亡率|发病率|中位数|中位|平均|均值|百分之)";
// Sample-size / p-value labels keep their required operator, so nodal staging
// like N1/N2 or a token like P2 is not mistaken for a conclusory quantity.
const statPrefix = "(?<![A-Za-z])(?:n|N|p|P)\\s*[<>=]";
const conclusoryConnector = "[\\s=:：<>≈~〜约为是]*";
const conclusorySuffixPattern = new RegExp(`(${conclusoryNumber})\\s*${conclusoryUnit}`, "gi");
const conclusoryPrefixPattern = new RegExp(`(?:${ratioPrefix}${conclusoryConnector}|${statPrefix}\\s*)(${conclusoryNumber})`, "gi");

/** @param {string} text @returns {string[]} */
function canonicalNumbers(text) {
  if (/[0-9]/.test(text)) return numericTokens(text);
  if (/[a-z]/i.test(text)) {
    const value = englishNumberRunValue(text.toLowerCase().split(/[\s-]+/).filter(Boolean));
    return value == null || value <= 0 ? [] : [String(value)];
  }
  const value = cjkNumberValue(text);
  return value == null ? [] : [String(value)];
}

/** @param {unknown} text @returns {Set<string>} */
function conclusoryQuantities(text) {
  // A confidence interval is one quantity however its endpoints are punctuated.
  // numericTokens already drops the percent sign that sits inside a range, so
  // "98.5%-99.7%" and "98.5–99.7%" are the same interval to it; without the
  // same normalisation here the two extractors disagreed about the same figure,
  // and a claim quoting an interval faithfully was reported as unsupported.
  const source = String(text ?? "")
    .replace(/%(\s*[–—-]\s*)(?=\d)/g, "$1")
    // "一次10丸、一日3次" says ten pills, three times a day. The 一 in 一次 and
    // 一日 is the Chinese for "per", not a quantity, but it reads as the CJK
    // numeral one against the units 次 and 日 — so a faithfully quoted dosing
    // line reported the unsupported numeric fact 1, three times in one report.
    // Only where the real quantity follows immediately, which is the idiom.
    .replace(/一(?:次|日|天)(?=\s*[0-9〇零一二两三四五六七八九十])/g, "");
  const numbers = new Set();
  for (const pattern of [conclusorySuffixPattern, conclusoryPrefixPattern]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      for (const token of canonicalNumbers(match[1])) numbers.add(token);
    }
  }
  // Standalone calendar years are publication metadata, not a conclusory finding.
  for (const token of [...numbers]) {
    if (/^\d+$/.test(token)) {
      const single = Number(token);
      if (single >= 1900 && single <= 2099) numbers.delete(token);
    }
  }
  return numbers;
}

/** @param {unknown} value @returns {string[]} */
function reportClaimIds(value) {
  const text = String(value ?? "");
  return [
    ...[...text.matchAll(visibleClaimMarkerPattern)].map((match) => match[1]),
    ...[...text.matchAll(hiddenClaimMarkerPattern)].map((match) => match[1]),
  ];
}

/** @param {unknown} value @returns {boolean} */
function hasClaimMarker(value) {
  return reportClaimIds(value).length > 0;
}

const referenceEntryPattern = /^\s*(?:\[(\d{1,3})\]|(\d{1,3})[.、])\s+(\S.*)$/;

/** Every identifier an entry carries, normalised so the same work matches
 *  itself across schemes. A DOI, a PMID and a Europe PMC URL are three names
 *  for one article, and a bibliography that lists it under two of them is
 *  citing it twice.
 *
 *  Exported because a second reader appeared: `toolExecutionEdges.mjs` asks
 *  whether a value one tool produced is the value a later tool consumed, and
 *  that is the same question under a different name. A private copy there would
 *  be a second answer to "are these two strings the same article", and the two
 *  would drift on the first scheme either side learned about.
 *  @param {string} text @returns {Set<string>} */
export function referenceIdentifiers(text) {
  const found = new Set();
  for (const [, doi] of text.matchAll(/\b(10\.\d{4,9}\/[^\s)\],;"']+)/gi)) {
    found.add(`doi:${doi.toLowerCase().replace(/[.,;)]+$/, "")}`);
  }
  for (const [, pmid] of text.matchAll(/\bpmid:?\s*(\d{5,9})\b/gi)) found.add(`pmid:${pmid}`);
  for (const [, pmid] of text.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{5,9})/gi)) found.add(`pmid:${pmid}`);
  for (const [, pmid] of text.matchAll(/europepmc\.org\/(?:article|abstract)\/[a-z]+\/(\d{5,9})/gi)) found.add(`pmid:${pmid}`);
  for (const [, pmcid] of text.matchAll(/\b(PMC\d{5,9})\b/gi)) found.add(`pmcid:${pmcid.toUpperCase()}`);
  for (const [, nct] of text.matchAll(/\b(NCT\d{8})\b/gi)) found.add(`nct:${nct.toUpperCase()}`);
  return found;
}

/** A four-digit number is only a year if it could be one. Bibliographies are
 *  full of look-alikes — "J Clin Oncol. 2018;36(15_suppl):2035" carries a page
 *  number that outranks the real year on a plain maximum.
 *  @param {string} text @returns {number[]} */
function plausibleYears(text) {
  const ceiling = new Date().getUTCFullYear() + 1;
  return [...text.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)]
    .map((match) => Number(match[1]))
    .filter((year) => year >= 1800 && year <= ceiling);
}

/** @param {string} text @returns {number | null} */
function referenceYear(text) {
  const years = plausibleYears(text);
  return years.length ? Math.max(...years) : null;
}

/** Deterministic integrity checks over a reply's own citations.
 *
 * These are the failures a URL-hygiene check cannot see: a marker pointing at
 * no entry, an entry nobody cites, one article listed twice under two
 * identifier schemes, an entry that declares itself a copy of another, and a
 * sentence resting a dated claim on a source that predates it.
 *  @param {unknown} reportText @returns {string[]} */
export function citationIntegrityIssues(reportText) {
  const text = String(reportText ?? "");
  const section = reportSection(text, "参考文献|参考来源|References?");
  const prose = section ? text.slice(0, text.indexOf(section)) : text;

  const entries = new Map();
  for (const line of section.split("\n")) {
    const match = referenceEntryPattern.exec(line);
    if (!match) continue;
    const number = Number(match[1] ?? match[2]);
    if (!Number.isInteger(number) || entries.has(number)) continue;
    entries.set(number, { number, body: match[3].trim() });
  }
  if (entries.size === 0) return [];

  const issues = [];
  const cited = new Set();
  for (const [, group] of prose.matchAll(/\[((?:\d{1,3})(?:\s*[,，、]\s*\d{1,3})*)\]/g)) {
    for (const part of group.split(/[,，、]/)) {
      const number = Number(part.trim());
      if (Number.isInteger(number)) cited.add(number);
    }
  }
  for (const number of [...cited].sort((left, right) => left - right)) {
    if (!entries.has(number)) issues.push(`Citation [${number}] has no matching entry in the reference list.`);
  }
  for (const number of [...entries.keys()].sort((left, right) => left - right)) {
    if (!cited.has(number)) issues.push(`Reference [${number}] is listed but never cited in the text.`);
  }

  const owner = new Map();
  for (const entry of entries.values()) {
    if (backReferenceOpener.test(`${entry.number}. ${entry.body}`) && pointsAtAnotherEntry.test(entry.body)) {
      issues.push(
        `Reference [${entry.number}] states that it is the same as another entry; give it its own source or remove it.`,
      );
    }
    for (const identifier of referenceIdentifiers(entry.body)) {
      const first = owner.get(identifier);
      if (first !== undefined && first !== entry.number) {
        issues.push(
          `References [${first}] and [${entry.number}] are the same work under different identifiers (${identifier}).`,
        );
      } else if (first === undefined) {
        owner.set(identifier, entry.number);
      }
    }
  }

  // A source cannot support a claim about something that came after it.
  for (const sentence of prose.split(/(?<=[。.!?！？\n])/)) {
    const markers = [...sentence.matchAll(/\[(\d{1,3})\]/g)].map((match) => Number(match[1]));
    if (markers.length === 0) continue;
    const claimed = plausibleYears(sentence);
    if (claimed.length === 0) continue;
    const latestClaim = Math.max(...claimed);
    // Only complain when no cited source is recent enough. A sentence citing
    // several sources may well name the year of one of them, and blaming the
    // older one for that would flag ordinary correct prose.
    const years = markers.map((number) => referenceYear(entries.get(number)?.body ?? "")).filter((year) => year !== null);
    if (years.length !== markers.length || years.some((year) => year >= latestClaim)) continue;
    issues.push(
      `A claim dated ${latestClaim} cites only ${markers.map((number) => `[${number}]`).join(", ")}, `
      + `dated ${years.join(", ")}; a source cannot describe something that came after it.`,
    );
  }
  return [...new Set(issues)];
}
// Attribution: read by the contract registry, which raises these findings for prose files.
checkedBy(citationIntegrityIssues, "citation-integrity");

// "5. 同 [1]", "12. See [3]", "7. Ibid. 3" point at another entry instead of
// naming a source, and counting them lets a bibliography clear a reference
// floor it does not meet. What separates a cross-reference from a real entry is
// that it carries no identifier of its own, so an entry opening with a
// back-reference marker that still gives a DOI, PMID or URL keeps its place: it
// is a distinct source that happens to be labelled sloppily.
// No \b after the Chinese markers — CJK characters are not word characters, so
// a word boundary never matches beside them.
const backReferenceOpener = /^\s*\d+[.、]\s*(?:同上|参见|同|见|(?:ibid|idem|see|as|cf)\b\.?)/i;
const pointsAtAnotherEntry = /\[\s*\d+\s*\]|\b\d{1,3}\b/;
const sourceIdentifier = /\b(?:10\.\d{4,9}\/\S+|pmid:?\s*\d+|https?:\/\/\S+)/i;

// Which numbers the reference list actually offers. Resolution and padding are
// different questions, and using the de-duplicated count as the denominator for
// both answered the wrong one: a report listing 29 numbered entries, two of
// which cite the same DOI, was told its reference 29 "must resolve to a
// numbered report reference" while entry 29 sat in the list where the reader
// would find it. Two production reports were marked unverified for that.
/** @param {unknown} reportText @returns {Set<number>} */
export function numberedReferenceNumbers(reportText) {
  const references = reportSection(reportText, "参考文献|参考来源|References?");
  const numbers = new Set();
  for (const line of references.split("\n")) {
    const match = /^\s*(\d+)[.、]\s+\S/.exec(line);
    if (match) numbers.add(Number(match[1]));
  }
  return numbers;
}

/** @param {unknown} reportText @returns {number} */
export function numberedReferenceCount(reportText) {
  const references = reportSection(reportText, "参考文献|参考来源|References?");
  const entries = references.split("\n").filter((line) => /^\s*\d+[.、]\s+\S/.test(line));
  const distinct = new Set();
  let counted = 0;
  for (const entry of entries) {
    const body = entry.replace(/^\s*\d+[.、]\s*/, "");
    const identity = entry.match(sourceIdentifier)?.[0]?.toLowerCase().replace(/[.,;)]+$/, "");
    if (!identity && backReferenceOpener.test(entry) && pointsAtAnotherEntry.test(body)) continue;
    // Two entries carrying the same DOI, PMID or URL are one source listed
    // twice, however differently the rest of the line is written.
    if (identity) {
      if (distinct.has(identity)) continue;
      distinct.add(identity);
    }
    counted += 1;
  }
  return counted;
}

// Bibliographic identifiers are letters-then-digits too, and they belong in a
// report. These are the schemes that do.
const bibliographicIdentifierScheme = /^(?:PMC|PMID|NCT|ISRCTN|EudraCT|ChiCTR|CTRI|JPRN|UMIN|DOI|ISBN|ISSN|CLM|CD|MR|e|S)$/i;

// A subject label carrying six or more digits is a record number, not a
// pseudonym. A production analysis of an uploaded hospital extract wrote
// P90000001, P90000002 and P9000003 through its report and evidence matrix —
// real PATIENT_IDs from the source file with a P stuck on the front, which
// reads like a pseudonym and is not one. Nobody reading the report can tell,
// and the person exposed is not the reader.
/** @param {unknown} reportText @returns {string[]} */
function recordIdentifiersInReport(reportText) {
  const found = new Set();
  // Only the analysis body. Article numbers like BMJ's e004216 are letters and
  // digits too, and the reference list is exactly where they belong.
  const text = withoutReportSections(String(reportText ?? ""), "参考文献|参考来源|References?");
  for (const match of text.matchAll(/([A-Za-z]{1,6})[-_]?(\d{6,})/g)) {
    const [whole, scheme] = match;
    if (bibliographicIdentifierScheme.test(scheme)) continue;
    const before = text.slice(Math.max(0, match.index - 60), match.index);
    // Inside a URL, a DOI, or after an identifier label it is a citation.
    if (/https?:\/\/\S*$|10\.\d{4,}\/\S*$|(?:PMID|PMC|DOI|NCT)\s*[:：]?\s*$/i.test(before)) continue;
    // Second guard, so the scheme list above does not have to be complete: a
    // line that cites something is a line about a source, not about a subject.
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const lineEnd = text.indexOf("\n", match.index);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    if (/\[\d+\]|https?:\/\/|10\.\d{4,}\/|doi|PMID/i.test(line)) continue;
    found.add(whole);
  }
  return [...found];
}

/** @param {unknown} reportText @param {string} headingPattern @returns {string} */
function reportSection(reportText, headingPattern) {
  const match = String(reportText ?? "").match(
    new RegExp(`(?:^|\\n)##\\s+[^\\n]*(?:${headingPattern})[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i"),
  );
  return match?.[1] ?? "";
}

// Blanked, not deleted. The numeric audit reports the line it is unhappy with,
// and it counts lines in this copy — so collapsing a section to one newline
// moved every later line up and the number named a different line of the report
// than the author would find. One production report ran to 125 lines while the
// audited copy was 99: "Report line 68" pointed at a blank line, and a repair
// asked to fix it had nowhere to go. Keeping the line count identical costs
// nothing, since every check here reads content rather than position.
/** @param {unknown} reportText @param {string} headingPattern @returns {string} */
function withoutReportSections(reportText, headingPattern) {
  return String(reportText ?? "").replace(
    new RegExp(`(?:^|\\n)##\\s+[^\\n]*(?:${headingPattern})[^\\n]*\\n[\\s\\S]*?(?=\\n##\\s+|$)`, "gi"),
    (match) => "\n".repeat(match.split("\n").length - 1),
  );
}

/** The offending line, so the notice names the sentence to fix rather than the
 *  document. "There is retrieval prose somewhere in your report" is not a
 *  repairable instruction.
 *  @param {string} text @param {RegExp} pattern
 *  @returns {{ line: number, text: string, match: string } | null}
 */
function firstMatchingLine(text, pattern) {
  const lines = String(text ?? "").split("\n");
  for (const [index, line] of lines.entries()) {
    const found = pattern.exec(line);
    if (found) return { line: index + 1, text: excerpt(line), match: excerpt(found[0]) };
  }
  return null;
}

/** @param {string} line */
function excerpt(line) {
  const trimmed = String(line ?? "").trim();
  return trimmed.length > 96 ? `${trimmed.slice(0, 96)}…` : trimmed;
}

/** A verdict verb used to score this report's own proposition, or "" when the
 *  sentence is ordinary clinical prose or the report of a named instrument.
 *  @param {string} line
 */
function selfGradedVerdict(line) {
  for (const sentence of String(line ?? "").split(/(?<=[。！？；;])/)) {
    if (!gradingVerbPattern.test(sentence)) continue;
    if (namedAppraisalInstrumentPattern.test(sentence)) continue;
    if (!quotedVerdictPattern.test(sentence) && !selfGradedSubjectPattern.test(sentence)) continue;
    return excerpt(sentence);
  }
  return "";
}

/** Is this run of Latin words a name rather than a sentence? Every word that is
 *  not a lowercase connective carries a capital in a journal, organisation,
 *  instrument, guideline, or trial name; prose does not.
 *  @param {string[]} words
 */
function readsAsProperName(words) {
  const carried = words.filter((word) => !properNameFunctionWords.has(word.toLowerCase()));
  return carried.length > 0 && carried.every((word) => /^[A-Z]/.test(word));
}

/** Is this run an enumeration of technical terms rather than a sentence? Prose
 *  is held together by closed-class words; a list of drug INNs, pathway
 *  molecules, or endpoint definitions carries none.
 *  @param {string[]} words
 */
function readsAsTermList(words) {
  return !words.some((word) => proseFunctionWords.has(word.toLowerCase()));
}

/** @param {string} segment */
function readsAsDatabaseQuery(segment) {
  return databaseFieldTagPattern.test(segment) || (segment.match(booleanOperatorPattern)?.length ?? 0) >= 2;
}

/** A run of untranslated source prose on one line of the body, or "" when the
 *  line's Latin script is names, identifiers, units, statistics, or a short
 *  quoted phrase carried inside a Chinese sentence.
 *
 *  The report states its findings in Chinese with numbered citations; a reader
 *  who wants the original wording follows the citation and an auditor reads the
 *  matrix. A paragraph of source sentences in the body is the traceability
 *  device pasted where nothing checks it.
 *  @param {string} line
 *  @returns {{ words: number, text: string } | null}
 */
function untranslatedProseRun(line) {
  // Anything removed rather than measured leaves a break behind it, so two
  // separate Latin fragments never merge into one run.
  const cut = "\u0000";
  const text = String(line ?? "")
    .replace(/<!--[\s\S]*?-->/g, cut)
    .replace(/`[^`]*`/g, cut)
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, `$1${cut}`)
    .replace(/https?:\/\/\S+|www\.[A-Za-z0-9.-]+\S*/gi, cut)
    .replace(/\b10\.\d{4,9}\/\S+/g, cut)
    // A short direct quotation is allowed: the exact wording is sometimes itself
    // the object of analysis — an indication clause, a recommendation class, a
    // contested definition. Past a sentence it is no longer a short quotation,
    // so the span stays in and is measured with everything else.
    .replace(shortQuotedSpanPattern, (whole, inner) => (
      (String(inner).match(latinWordPattern)?.length ?? 0) <= permittedQuotedWords ? cut : whole
    ))
    .replace(runInterruptPattern, cut);
  for (const segment of text.split(cut)) {
    const words = segment.match(latinWordPattern);
    if (!words || words.length < untranslatedProseWords) continue;
    if (readsAsProperName(words) || readsAsTermList(words) || readsAsDatabaseQuery(segment)) continue;
    return { words: words.length, text: excerpt(segment) };
  }
  return null;
}

/** A sentence that answers the question with the failure of its own search, or
 *  "" when the sentence states the gap and stops there.
 *  @param {string} line
 */
function absentEvidenceAsCounterFinding(line) {
  for (const sentence of String(line ?? "").split(/(?<=[。！？；;])/)) {
    const absent = absentEvidencePattern.exec(sentence);
    if (!absent) continue;
    const after = sentence.slice(absent.index + absent[0].length);
    const marker = evidenceInferenceMarkerPattern.exec(after);
    if (!marker) continue;
    const conclusion = after.slice(marker.index + marker[0].length);
    if (!negativeVerdictPattern.test(conclusion)) continue;
    // Reporting the recommendation somebody else made is citation, not
    // inference: a sentence that names the guideline, consensus or label it is
    // reporting is doing that, and the citation checks hold it to the source.
    // The split is per clause, so naming a body in a neighbouring clause does
    // not license the inference in this one.
    if (attributedRecommendationPattern.test(sentence)) continue;
    return excerpt(sentence);
  }
  return "";
}

/** Commissioning vocabulary, acceptance-specification structure,
 *  self-referential narration, pasted source quotations, and a gap written as a
 *  counter-finding — the ways a manuscript stops reading like one. Read outside
 *  the reference list, where a cited title may legitimately carry any of these
 *  words and is untranslated by definition.
 *  @param {any} reportText
 */
function manuscriptRegisterIssues(reportText) {
  const issues = [];
  const body = withoutReportSections(reportText, "参考文献|参考来源|References?");
  // A database search strategy is written in the source language by design and
  // belongs in 资料与方法, so the untranslated-prose rule alone reads a copy with
  // that section blanked. Line numbers survive the blanking, as everywhere else.
  const proseLines = withoutReportSections(body, "检索|方法|Methods?").split("\n");
  const namedTerms = new Set();
  const propositionLines = [];
  let propositionSample = "";
  let headings = 0;
  let verdicts = 0;
  let narrations = 0;
  let quotations = 0;
  let untranslated = 0;
  let counterFindings = 0;
  let insideCodeFence = false;
  for (const [index, line] of body.split("\n").entries()) {
    const lineNumber = index + 1;
    const fence = /^\s*(?:```|~~~)/.test(line);
    if (fence) insideCodeFence = !insideCodeFence;
    for (const term of commissioningVocabulary) {
      if (!line.includes(term) || namedTerms.has(term)) continue;
      namedTerms.add(term);
      issues.push(
        `The academic report line ${lineNumber} uses commissioning vocabulary ${JSON.stringify(term)}: ${excerpt(line)}. `
        + "A paper never names the brief it was written for, the item bank the question came from, the metrics it was scored against, or the answer that was expected. "
        + "Restate the underlying clinical proposition in the literature's own words and evaluate that instead — "
        + '例如把"题库目标答案X无证据支持"改写为"对于X这一说法，未检索到以临床结局为终点的研究"。',
      );
    }
    if (headings < 4 && acceptanceConditionHeadingPattern.test(line)) {
      headings += 1;
      issues.push(
        `The academic report line ${lineNumber} names a section after an acceptance condition: ${excerpt(line)}. `
        + "A reader judges what kind of document this is from the section names, and 判定条件 announces a reviewer's checklist. "
        + "Use the manuscript sections (摘要 / 引言 / 资料与方法 / 结果 / 讨论 / 局限性 / 结论 / 临床实践要点 / 参考文献): "
        + "state the question and the objective in 引言, and write the evidence bar as the evidence-appraisal criteria in 资料与方法.",
      );
    }
    if (letteredPropositionPattern.test(line)) {
      propositionLines.push(lineNumber);
      if (!propositionSample) propositionSample = excerpt(line);
    }
    const verdict = verdicts < 4 ? selfGradedVerdict(line) : "";
    if (verdict) {
      verdicts += 1;
      issues.push(
        `The academic report line ${lineNumber} delivers a verdict on its own proposition with 判为/判定为: ${verdict}. `
        + "Grading your own conclusions against a scale you invented prints the acceptance form into the paper. "
        + "Use the verbs of evidence — 提示、支持、不足以支持、未检索到……的证据 — or, when you are applying a published instrument, "
        + 'name it and report its own level (按 WHO-UMC 评定为"可能有关"、按 GRADE 为低确定性).',
      );
    }
    if (narrations < 4 && selfReferentialNarrationPattern.test(line)) {
      narrations += 1;
      issues.push(
        `The academic report line ${lineNumber} writes about itself rather than about the evidence: ${excerpt(line)}. `
        + "The paper describes evidence and reasoning, never what this report is, what it refuses to do, or what it was checked against. "
        + "State the objective plainly in 引言 (本文旨在评价……) and delete the rest; if a scientific question is buried in the sentence, ask it scientifically. "
        + "A paper never announces whom it is written for: state in 资料与方法 which population and care setting the evidence applies to, and discuss extrapolation in 讨论.",
      );
    }
    if (quotations < 4 && pastedSourceQuotePattern.test(line)) {
      quotations += 1;
      issues.push(
        `The academic report line ${lineNumber} pastes a source quotation into the body behind a 原文： label: ${excerpt(line)}. `
        + "A verbatim quote is a traceability device: it lives in the evidence matrix's supportQuote field, "
        + "where it is checked against the preserved artifact — in the body it is checked by nobody and adds no verifiability. "
        + "State the finding in Chinese in the paper's own voice with its numbered citation, and where the exact wording is itself the object of analysis, "
        + 'quote a short phrase inside quotation marks, grammatically inside the Chinese sentence (该说明书将适应症限定为"气滞血瘀型冠心病心绞痛"[7]).',
      );
    }
    const foreign = untranslated < 4 && !insideCodeFence && !fence && !/^\s*\|/.test(line)
      ? untranslatedProseRun(proseLines[index] ?? "")
      : null;
    if (foreign) {
      untranslated += 1;
      issues.push(
        `The academic report line ${lineNumber} carries ${foreign.words} consecutive words of untranslated source prose: ${foreign.text}. `
        + "The body states each finding in Chinese with its numbered citation; a reader who wants the original wording follows the citation and an auditor reads the matrix. "
        + "Restate the passage in Chinese with its citation, and keep any genuinely necessary quotation to a short phrase inside quotation marks — "
        + "names, identifiers, units and statistics (ALDH2、rs671、GRADE、Naranjo、P < 0.01、RR 0.82) are unaffected.",
      );
    }
    const counterFinding = counterFindings < 4 ? absentEvidenceAsCounterFinding(line) : "";
    if (counterFinding) {
      counterFindings += 1;
      issues.push(
        `The academic report line ${lineNumber} turns absent evidence into a counter-finding: ${counterFinding}. `
        + "A search that returned nothing is insufficient evidence to judge, never evidence of no effect, so it cannot carry 无效／不推荐使用／不支持使用. "
        + "Write the gap as a gap and name the study that would close it — design, population, comparator, outcome, order of magnitude of sample "
        + "(未检索到在该场景中以临床结局为终点的随机对照研究，现有证据不足以判断其在该场景的效能). "
        + "If a body actually recommended against use, name the body and cite it.",
      );
    }
  }
  if (propositionLines.length >= 2) {
    issues.push(
      `The academic report states lettered propositions with their own pass/fail conditions at lines ${propositionLines.slice(0, 8).join(", ")}: ${propositionSample}. `
      + "That is the reviewer's acceptance form printed inside the manuscript. Dissolve it: what evidence a conclusion of each kind must rest on belongs in "
      + "资料与方法 as continuous methods prose, and what each line of evidence established belongs in 结果 and 讨论 as a finding — never carried forward as a per-proposition verdict.",
    );
  }
  return issues;
}
// Attribution: the check every finding of this function is recorded under.
checkedBy(manuscriptRegisterIssues, "manuscript-register");

/** A sentence concluding that one arm may take the other's place or beats it,
 *  or "" when the sentence writes a bridge link that is marked unestablished,
 *  or the clause carrying the verb is negated, asks rather than answers,
 *  compares the evidence bases, compares against a trial's own control, names
 *  something a medicine may never replace, or reports the comparison somebody
 *  else made.
 *  @param {string} line
 */
function substitutionConclusion(line) {
  const sentences = String(line ?? "").split(/(?<=[。！？；;])/);
  for (const [index, sentence] of sentences.entries()) {
    if (attributedComparisonPattern.test(sentence)) continue;
    const next = sentences[index + 1] ?? "";
    if (
      unestablishedLinkPattern.test(sentence)
      || (next.trim().length <= bareLinkMarkCharacters && unestablishedLinkPattern.test(next))
    ) continue;
    // What is being compared may be named a clause away (两者相比，该制剂更安全),
    // but the negation that would license the clause may not: it has to sit in
    // the clause that carries the claim.
    const anchored = comparisonAnchorPattern.test(sentence);
    for (const clause of sentence.split(/[，,、]/)) {
      const claimed = substitutionVerbPattern.test(clause)
        || (comparativeQualityPattern.test(clause) && (anchored || choiceNounPattern.test(clause)));
      if (!claimed) continue;
      if (substitutionNegationPattern.test(clause) || openQuestionPattern.test(clause)) continue;
      if (evidenceBaseComparisonPattern.test(clause)) continue;
      if (internalComparatorPattern.test(clause) || nonMedicineObjectPattern.test(clause)) continue;
      return excerpt(sentence);
    }
  }
  return "";
}

/** @param {unknown} value @returns {Set<number>} */
function standardCitationNumbers(value) {
  const numbers = new Set();
  for (const match of String(value ?? "").matchAll(/\[(\d+(?:\s*[-,]\s*\d+)*)\]/g)) {
    for (const part of match[1].split(",")) {
      const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (end >= start && end - start <= 100) {
          for (let number = start; number <= end; number += 1) numbers.add(number);
        }
      } else {
        numbers.add(Number(part.trim()));
      }
    }
  }
  return numbers;
}

/** A type predicate, not a plain boolean: every caller uses it as the guard
 *  before treating the value as a path, and saying so is what lets the
 *  narrowing hold without a cast at each of those call sites.
 *  @param {unknown} value @returns {value is string} */
function validSourceArtifactPath(value) {
  return typeof value === "string"
    && value.startsWith(".evimed-sources/")
    && !value.includes("\\")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

// Validates a cross-source ("synthesized") claim: the conclusion itself has no
// single verbatim home, so every supporting source must independently satisfy
// the same artifact/quote/URL checks a direct claim gets, and claim numbers
// must trace to a supporting quote or be machine-verifiable source counts.
/**
 * @param {Record<string, any>} value
 * @param {{
 *   label: string,
 *   reportReferenceNumbers: Set<number> | null,
 *   successfulArtifacts: Set<string>,
 *   artifactText: Map<string, string>,
 *   sourceDomains: Set<string>,
 *   issues: IssueLog,
 * }} context
 * @returns {void}
 */
function validateSynthesizedClaim(
  value,
  { label, reportReferenceNumbers, successfulArtifacts, artifactText, sourceDomains, issues },
) {
  if (!synthesizedConfidenceLevels.has(value.confidence)) {
    issues.push(`${label}.confidence must be one of high, moderate, low for a synthesized claim.`);
  }
  if (!Number.isInteger(value.referenceNumber) || (reportReferenceNumbers && !reportReferenceNumbers.has(value.referenceNumber))) {
    issues.push(`${label}.referenceNumber must resolve to a numbered report reference.`);
  }
  const referenceNumbers = Array.isArray(value.referenceNumbers) ? value.referenceNumbers : [];
  if (
    referenceNumbers.length < 2
    || referenceNumbers.some((entry) => !Number.isInteger(entry) || (reportReferenceNumbers && !reportReferenceNumbers.has(entry)))
  ) {
    issues.push(`${label}.referenceNumbers must list at least two numbered report references.`);
  } else if (Number.isInteger(value.referenceNumber) && !referenceNumbers.includes(value.referenceNumber)) {
    issues.push(`${label}.referenceNumber must be one of its referenceNumbers.`);
  }
  const sources = Array.isArray(value.supportingSources) ? value.supportingSources : [];
  if (sources.length < 2) {
    issues.push(`${label}.supportingSources must name at least two distinct sources.`);
  }
  const supportNumbers = new Set();
  const seenArtifacts = new Set();
  // The same paper fetched twice — once by DOI, once by PMCID — lands in two
  // different artifact directories, so path identity alone would let one study
  // pose as two. Its landing URL is the same either way.
  const seenSourceUrls = new Set();
  for (const [sourceIndex, source] of sources.entries()) {
    const sourceLabel = `${label}.supportingSources[${sourceIndex}]`;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      issues.push(`${sourceLabel} must be an object.`);
      continue;
    }
    for (const field of synthesizedSourceFields) {
      if (!nonEmpty(source[field])) issues.push(`${sourceLabel}.${field} must be a non-empty string.`);
    }
    if (!accessLevels.has(source.accessLevel)) {
      issues.push(`${sourceLabel}.accessLevel is ${JSON.stringify(source.accessLevel)}; use exactly one of ${[...accessLevels].join(", ")} to record how much of the preserved artifact you read.`);
    }
    const sourceIdentity = nonEmpty(source.sourceUrl)
      ? source.sourceUrl.trim().toLowerCase().replace(/\/+$/, "")
      : "";
    if (sourceIdentity) {
      if (seenSourceUrls.has(sourceIdentity)) {
        issues.push(`${sourceLabel}.sourceUrl duplicates another supporting source. One document supports one source, however many times it is listed — drop the repeat and restate any count that assumed independent studies.`);
      }
      seenSourceUrls.add(sourceIdentity);
    }
    if (!validSupportingPassage(source.supportQuote)) {
      issues.push(`${sourceLabel}.supportQuote must contain a direct supporting passage.`);
    }
    if (!validSourceArtifactPath(source.artifactPath)) {
      issues.push(`${sourceLabel}.artifactPath is ${JSON.stringify(source.artifactPath)}, which is not a preserved artifact. Preserve the source first — evimed_open_access_full_text by DOI/PMCID, or evimed_official_page_fetch by URL — and cite the .evimed-sources path it returns. If neither can preserve it, cite a source you did preserve instead.`);
    } else {
      if (seenArtifacts.has(source.artifactPath)) {
        issues.push(`${sourceLabel}.artifactPath duplicates another supporting source. One document supports one source, however many times it is listed — drop the repeat and restate any count that assumed independent studies.`);
      }
      seenArtifacts.add(source.artifactPath);
      if (!successfulArtifacts.has(source.artifactPath)) {
        issues.push(`${sourceLabel}.artifactPath is not listed as a successful source artifact for this run: no evidence tool in this run reported preserving that file, or its text could not be read back. Cite the exact .evimed-sources/ path a preserving tool returned, or preserve the source first.`);
      } else {
        const quoteProblem = supportQuoteIssue(artifactText, sourceLabel, source.artifactPath, source.supportQuote);
        if (quoteProblem) issues.push(quoteProblem);
      }
    }
    const domain = sourceDomain(source.sourceUrl);
    if (!domain) issues.push(`${sourceLabel}.sourceUrl must be a valid credential-free HTTPS URL.`);
    else {
      sourceDomains.add(domain);
      if (domain === "www.evimed.com" && String(source.sourceUrl ?? "").includes("/api-evimed/")) {
        issues.push(`${sourceLabel}.sourceUrl is an internal API route, not a public evidence citation.`);
      }
    }
    for (const token of numericTokens([source.supportQuote, source.sourceTitle, source.identifier].join(" "))) {
      supportNumbers.add(token);
    }
  }
  for (const token of new Set(numericTokens(value.claim))) {
    if (supportNumbers.has(token)) continue;
    const asCount = Number(token);
    const verifiableCount = sourceCountWordPattern.test(value.claim ?? "")
      && Number.isInteger(asCount)
      && asCount >= 1
      && asCount <= sources.length;
    if (!verifiableCount) {
      issues.push(`${label}.claim numeric fact ${token} is not present in any supporting source and is not a verifiable source count. Add the source that states it, or record it as unverifiable.`);
    }
  }
  if (
    emergencyCallClaimPattern.test(value.claim ?? "")
    && !sources.some((source) => emergencyCallSupportPattern.test(source?.supportQuote ?? ""))
  ) {
    issues.push(`${label}.emergency-call action is not present in its direct support.`);
  }
}
// Attribution: the check every finding this function pushes is recorded under.
checkedBy(validateSynthesizedClaim, "synthesized-claim");

/**
 * One claim's findings about itself: its schema, its sources and the
 * quotation bond — everything a matrix row can be judged on without the rest
 * of the package.
 *
 * Lifted out of the package validator's loop unchanged, so the gate and
 * `validateEvidenceClaim` (what `evimed_claim_upsert` answers with) are one
 * implementation and cannot disagree about a claim. `reportReferenceNumbers`
 * is null when there is no report to resolve against yet — a claim written
 * before its report — and then only the reference number's shape is checked;
 * the package gate always passes the report's own list.
 *
 * Two halves, in this order: the evidence bond, which the tiers can make a
 * must-fix, and then the structured appraisal the claim may carry, which is
 * advice by construction. The order is the order a run should fix them in.
 *
 * @param {any} value
 * @param {string} label
 * @param {ClaimAuditContext} context
 * @returns {void}
 */
function auditClaim(value, label, context) {
  auditClaimEvidence(value, label, context);
  auditClaimAppraisal(value, label, context);
}

/**
 * @typedef {{
 *   issues: IssueLog,
 *   reportReferenceNumbers: Set<number> | null,
 *   successfulArtifacts: Set<string>,
 *   artifactText: Map<string, string>,
 *   sourceTypes: Map<string, string>,
 *   sourceDomains: Set<string>,
 *   seen: Set<string>,
 *   claimIds: string[],
 *   derivedClaims: { label: string, claim: Record<string, any> }[],
 * }} ClaimAuditContext
 */

/**
 * A PICO part's quote, judged by the comparison every quotation in the matrix
 * gets (`quoteIsPresent`), in the source the part names or, for a direct
 * claim, the claim's own. A part whose source is the claim's own and was never
 * preserved says nothing: the claim's artifact-path finding already names that
 * source, and one unreadable document is one finding.
 * @param {{ where: string, quote: string, artifactPath: string | null, ownSource: boolean }} part
 * @param {{ artifactText: Map<string, string>, successfulArtifacts: Set<string> }} context
 * @returns {string | null}
 */
function picoQuoteIssue(part, { artifactText, successfulArtifacts }) {
  const { where, quote, artifactPath, ownSource } = part;
  if (!artifactPath) {
    return `${where}.quote names no source: give the part an artifactPath — the preserved .evimed-sources/ file whose wording it quotes.`;
  }
  if (!validSourceArtifactPath(artifactPath) || !successfulArtifacts.has(artifactPath)) {
    if (ownSource) return null;
    return `${where}.quote could not be checked: ${JSON.stringify(artifactPath)} is not a source this run preserved. Name the preserved .evimed-sources/ path a preserving tool returned.`;
  }
  const artifact = artifactText.get(artifactPath);
  if (!artifact) {
    return `${where}.quote could not be checked: no preserved text for ${JSON.stringify(artifactPath)} reached this check.`;
  }
  return quoteIsPresent(artifact, quote) ? null : `${where}.quote ${quoteFailure(artifact, quote)}.`;
}

/**
 * The structured appraisal half of a claim's audit: PICO, GRADE certainty and
 * risk of bias (`appraisalStructure.mjs`). Every id it records under is
 * advisory — none is named in CLINICAL_CHECK_TIERS — so nothing here can make
 * a claim unverified or hold a package back. A claim that carries none of the
 * three fields raises nothing at all.
 * @param {any} value @param {string} label @param {ClaimAuditContext} context
 * @returns {void}
 */
function auditClaimAppraisal(value, label, { issues, artifactText, successfulArtifacts, sourceTypes }) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !claimTypes.has(value.claimType ?? "direct")) return;
  const found = claimAppraisalFindings(value, { label, sourceTypes });
  issues.region("claim-pico-schema");
  issues.push(...found.picoSchema);
  issues.region("claim-pico-quote");
  for (const part of found.picoQuotes) {
    const problem = picoQuoteIssue(part, { artifactText, successfulArtifacts });
    if (problem) issues.push(problem);
  }
  issues.region("claim-certainty-schema");
  issues.push(...found.certaintySchema);
  issues.region("claim-certainty-arithmetic");
  issues.push(...found.certaintyArithmetic);
  issues.region("claim-certainty-design");
  issues.push(...found.certaintyDesign);
  issues.region("claim-rob-schema");
  issues.push(...found.robSchema);
  issues.region("claim-rob-overall");
  issues.push(...found.robOverall);
}

/**
 * The evidence half of a claim's audit: its schema, its sources and the
 * quotation bond.
 * @param {any} value @param {string} label @param {ClaimAuditContext} context
 * @returns {void}
 */
function auditClaimEvidence(value, label, context) {
  const { issues, reportReferenceNumbers, successfulArtifacts, artifactText, sourceDomains, seen, claimIds, derivedClaims } = context;
  issues.region("claim-schema");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${label} must be an object.`);
    return;
  }
  const claimType = value.claimType ?? "direct";
  if (!claimTypes.has(claimType)) {
    issues.push(`${label}.claimType must be "direct" or "synthesized" when present.`);
    return;
  }
  const requiredFields = claimType === "synthesized"
    ? synthesizedBaseFields
    : claimType === "derived" ? derivedBaseFields : claimFields;
  for (const field of requiredFields) {
    if (!nonEmpty(value[field])) issues.push(`${label}.${field} must be a non-empty string.`);
  }
  if (!claimIdPattern.test(value.claimId ?? "")) issues.push(`${label}.claimId must match CLM-NNN.`);
  if (seen.has(value.claimId)) issues.push(`${label}.claimId is duplicated.`);
  else if (typeof value.claimId === "string") {
    seen.add(value.claimId);
    claimIds.push(value.claimId);
  }
  if (claimType === "synthesized") {
    issues.from(validateSynthesizedClaim, value, {
      label,
      reportReferenceNumbers,
      successfulArtifacts,
      artifactText,
      sourceDomains,
      issues,
    });
    return;
  }
  if (claimType === "derived") {
    // Grounding is checked after the loop, once every claimId is known.
    issues.region("derived-claim-inputs");
    const inputs = value.derivedFrom;
    if (!Array.isArray(inputs) || inputs.length === 0) {
      issues.push(`${label}.derivedFrom must list the claim ids this result is reasoned from.`);
    } else if (inputs.some((id) => typeof id !== "string" || !claimIdPattern.test(id))) {
      issues.push(`${label}.derivedFrom entries must each match CLM-NNN.`);
    } else if (inputs.includes(value.claimId)) {
      issues.push(`${label}.derivedFrom must not include the claim itself.`);
    }
    // The method is the audit trail that replaces the missing quote, so it
    // has to actually show the step rather than gesture at one. A result with
    // a number in it must show that number's arithmetic or its bound.
    if (nonEmpty(value.method) && String(value.method).trim().length < 40) {
      issues.push(`${label}.method must state the reasoning or calculation that takes the inputs to this result, not name it.`);
    }
    derivedClaims.push({ label, claim: value });
    return;
  }
  issues.region("claim-access-level");
  if (!accessLevels.has(value.accessLevel)) {
    issues.push(`${label}.accessLevel is ${JSON.stringify(value.accessLevel)}; use exactly one of ${[...accessLevels].join(", ")} to record how much of the preserved artifact you read.`);
  }
  issues.region("claim-reference-number");
  if (!Number.isInteger(value.referenceNumber) || (reportReferenceNumbers && !reportReferenceNumbers.has(value.referenceNumber))) {
    issues.push(`${label}.referenceNumber must resolve to a numbered report reference.`);
  }
  issues.region("claim-support-quote");
  if (!validSupportingPassage(value.supportQuote)) issues.push(`${label}.supportQuote must contain a direct supporting passage.`);
  issues.region("claim-emergency-support");
  if (emergencyCallClaimPattern.test(value.claim ?? "")
    && !emergencyCallSupportPattern.test(value.supportQuote ?? "")) {
    issues.push(`${label}.emergency-call action is not present in its direct support.`);
  }
  // Support counts under either reading, as the report-line audit already
  // does: the two extractors split ranges differently, so a quote saying
  // "98.5–99.7%" offers the atomic range under one and the endpoints under
  // the other. Narrow what is demanded, never what is accepted as support.
  issues.region("claim-numeric-support");
  const directSupport = [value.supportQuote, value.sourceTitle, value.identifier].join(" ");
  const directSupportNumbers = new Set([
    ...numericTokens(directSupport),
    ...conclusoryQuantities(directSupport),
  ]);
  // The same standard the report lines are held to: a figure that carries a
  // unit or a statistic, with publication years excluded. This audited every
  // integer in the claim instead, so "2022年发表的网络meta分析" was reported
  // as the unsupported numeric fact 2022 — a year the citation already
  // carries, and one the report-line audit deliberately ignores. Two
  // standards for the same number is not strictness, it is inconsistency.
  for (const token of conclusoryQuantities(value.claim)) {
    if (!directSupportNumbers.has(token)) {
      issues.push(`${label}.claim numeric fact ${token} is not present in its direct support. Quote the passage that states it, or if the source does not state it, say so in the claim's uncertainty rather than dropping the figure.`);
    }
  }
  issues.region("claim-artifact-path");
  if (!validSourceArtifactPath(value.artifactPath)) {
    issues.push(`${label}.artifactPath is ${JSON.stringify(value.artifactPath)}, which is not a preserved artifact. Preserve the source first — evimed_open_access_full_text by DOI/PMCID, or evimed_official_page_fetch by URL — and cite the .evimed-sources path it returns. If neither can preserve it, cite a source you did preserve instead.`);
  } else if (!successfulArtifacts.has(value.artifactPath)) {
    issues.push(`${label}.artifactPath is not listed as a successful source artifact for this run: no evidence tool in this run reported preserving that file, or its text could not be read back. Cite the exact .evimed-sources/ path a preserving tool returned, or preserve the source first.`);
  } else {
    issues.region("claim-quote-verbatim");
    const quoteProblem = supportQuoteIssue(artifactText, label, value.artifactPath, value.supportQuote);
    if (quoteProblem) issues.push(quoteProblem);
  }
  issues.region("claim-source-url");
  const domain = sourceDomain(value.sourceUrl);
  if (!domain) issues.push(`${label}.sourceUrl must be a valid credential-free HTTPS URL.`);
  else {
    sourceDomains.add(domain);
    if (domain === "www.evimed.com" && value.sourceUrl.includes("/api-evimed/")) {
      issues.push(`${label}.sourceUrl is an internal API route, not a public evidence citation.`);
    }
  }
}

/**
 * Whether a derived claim's inputs resolve and reach measured evidence, or the
 * sentence that says why not. One implementation for the package gate and for
 * a single claim.
 * @param {string} label @param {Record<string, any>} claim @param {Map<any, any>} claimsById
 * @returns {string | null}
 */
function derivedGroundingIssue(label, claim, claimsById) {
  const inputs = Array.isArray(claim?.derivedFrom) ? claim.derivedFrom : [];
  const unresolved = inputs.filter((/** @type {any} */ id) => !claimsById.has(id));
  if (unresolved.length) {
    return `${label}.derivedFrom names ${unresolved.join(", ")}, which ${unresolved.length > 1 ? "are" : "is"} not in the evidence matrix.`;
  }
  const grounded = new Set();
  const pending = [...inputs];
  let reachesEvidence = false;
  while (pending.length) {
    const id = pending.pop();
    if (grounded.has(id)) continue;
    grounded.add(id);
    const input = claimsById.get(id);
    if ((input?.claimType ?? "direct") !== "derived") { reachesEvidence = true; continue; }
    for (const next of Array.isArray(input?.derivedFrom) ? input.derivedFrom : []) pending.push(next);
  }
  return reachesEvidence ? null : `${label} is derived only from other derived claims; a derivation must reach measured evidence.`;
}

/**
 * Stamped evidence types by preserved path, however the caller holds them.
 * Only string values are kept: a type is a word from `source-types.json`,
 * and anything else is a caller's mistake that must not reach the design rule.
 * @param {unknown} value @returns {Map<string, string>}
 */
function typeMap(value) {
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value && typeof value === "object" ? value : {});
  return new Map(entries.filter(([path, type]) => typeof path === "string" && typeof type === "string" && type));
}

/**
 * One claim, judged by the gate's own rules, for a caller writing claims one
 * at a time (`evimed_claim_upsert`).
 *
 * `verified` means what it means to a reader: nothing the gate would require
 * of this claim is open, and its quotation is in the preserved source it names
 * (or, for a derived result, its inputs resolve and reach measured evidence).
 * Advisory findings travel in `issues` and do not unverify a claim — the same
 * line the package gate draws between "must fix" and "advice". The report is
 * optional: without it the claim's reference number is checked for shape only,
 * because the report is usually written after the claims it cites.
 *
 * Never throws and never refuses: a claim that fails comes back `unverified`
 * with the reasons, which is what lets the caller write it anyway.
 *
 * `sourceTypes` is the evidence type stamped on each preserved source
 * (`source.json` beside it, contract C8), by path; the structured GRADE
 * certainty reads it to tell randomized evidence from observational. Absent,
 * the certainty falls back to the instrument and the stated start.
 *
 * @param {{ claim?: any, claims?: readonly any[], sourceArtifacts?: Map<string, string> | Record<string, string>, sourceTypes?: Map<string, string> | Record<string, string>, reportText?: string | null }} input
 * @returns {{ claimId: string, status: 'verified' | 'unverified', verification: string, issues: { code: string, message: string, tier: 'blocking' | 'safety' | 'advisory' }[] }}
 */
export function validateEvidenceClaim({ claim, claims = [], sourceArtifacts = {}, sourceTypes = {}, reportText = null } = {}) {
  const artifactText = sourceArtifacts instanceof Map
    ? sourceArtifacts
    : new Map(Object.entries(sourceArtifacts && typeof sourceArtifacts === "object" ? sourceArtifacts : {}));
  const issues = new IssueLog();
  /** @type {{ label: string, claim: Record<string, any> }[]} */
  const derivedClaims = [];
  const claimId = typeof claim?.claimId === "string" ? claim.claimId : "";
  const label = claimIdPattern.test(claimId) ? claimId : "claim";
  auditClaim(claim, label, {
    issues,
    reportReferenceNumbers: reportText == null ? null : numberedReferenceNumbers(reportText),
    successfulArtifacts: new Set([...artifactText.keys()].filter((path) => typeof path === "string" && path)),
    artifactText,
    sourceTypes: typeMap(sourceTypes),
    sourceDomains: new Set(),
    seen: new Set(),
    claimIds: [],
    derivedClaims,
  });
  if (derivedClaims.length) {
    issues.region("derived-claim-grounding");
    const claimsById = new Map([...claims, claim].map((entry) => [entry?.claimId, entry]));
    const grounding = derivedGroundingIssue(label, claim, claimsById);
    if (grounding) issues.push(grounding);
  }
  const findings = issues.all().map((entry) => ({ code: String(entry.check ?? ""), message: entry.text, tier: clinicalCheckTier(entry.check) }));
  // The reader's mark for the claim, from the comparison the gate itself
  // makes; a derived result has inputs instead of a quotation, and the
  // grounding above is what vouches for it.
  const verification = claimVerification({ matrix: { claims: [claim] }, sourceArtifacts: artifactText }).claims[0]?.status ?? "no_quote";
  const bonded = verification === "verified" || verification === "derived";
  const status = bonded && findings.every((finding) => finding.tier === "advisory") ? "verified" : "unverified";
  return { claimId, status, verification, issues: findings };
}

/** TypeScript infers a destructured parameter as exactly the shape its
 *  defaults name, which rejects every other property a caller passes.
 *  @param {Record<string, any>} options0
 */
export function validateClinicalEvidencePackage({
  reportText,
  matrix,
  // Preserved source texts by workspace path, joined from the evidence ledger by
  // the platform: an entry means a tool preserved the file in this run and it
  // was read back.
  sourceArtifacts = {},
  // The brief this run was dispatched with, as the dispatcher holds it — never
  // the workspace copy the run can edit. The question-scoped safety rules read
  // it; null means it is not available (an in-flight run whose server
  // restarted), and those rules then do not run.
  briefText = null,
  // The evidence type stamped on each preserved source (`source.json` beside
  // it, C8), by path. Read only by the structured GRADE certainty, to tell a
  // randomized body from an observational one; absent, it falls back to the
  // instrument and the stated start, and nothing else in the gate changes.
  sourceTypes = {},
} = {}) {
  const issues = new IssueLog();
  /** @type {string[]} */
  const claimIds = [];
  /** @type {Set<string>} */
  const sourceDomains = new Set();

  // An absent report is one problem, not nine.
  //
  // A run wrote `临床证据综述.md` where the contract asks for
  // `clinical-evidence-report.md`. Every rule below then ran over an empty
  // string and the verdict came back as nine content findings -- no abstract,
  // no conclusion, no safety section, "must contain academic analysis" -- each
  // one true of a file that does not exist, and none of them saying so. A child
  // reading that goes and edits the file it did write.
  //
  // Here rather than in the contract registry, because the registry is
  // forbidden from adding a second list on top of this one: there is a single
  // implementation and both the run side and the delivery gate reach it, which
  // is what keeps the two from drifting apart.
  if (!String(reportText ?? "").trim()) {
    const absent = "clinical-evidence-report.md is not in the deliverable, or is empty. Write it at exactly that name"
      + " inside this deliverable's directory before submitting; the checks below cannot read a file that is not there.";
    return {
      valid: false,
      issues: [absent],
      blockingIssues: [absent],
      safetyIssues: [],
      findings: [{ check: "report-present", text: absent, tier: "blocking", degradable: false }],
      issueChecks: [{ check: "report-present", text: absent }],
      claimIds: [],
      sourceDomains: [],
    };
  }
  // Annotated rather than inferred: `matrix` arrives as `any` from the caller,
  // so the ternary's two branches union to something TypeScript will not treat
  // as an array of records, and every callback over it downstream then reads as
  // an implicit any. One annotation here is what types the forty-odd of them.
  /** @type {Record<string, any>[]} */
  const claims = matrix && typeof matrix === "object" && !Array.isArray(matrix) && Array.isArray(matrix.claims)
    ? matrix.claims
    : [];
  const artifactText = sourceArtifacts instanceof Map
    ? sourceArtifacts
    : new Map(Object.entries(sourceArtifacts && typeof sourceArtifacts === "object" ? sourceArtifacts : {}));
  // What was preserved is the platform's record, not the run's account of it.
  // The run used to list its sources in a receipt of its own, and trusting that
  // list rejected claims citing genuinely preserved sources the run had not yet
  // copied into it; the receipt is gone, and this set is what the evidence
  // ledger says.
  const successfulArtifacts = new Set(
    [...artifactText.keys()].filter((path) => typeof path === "string" && path),
  );
  const reportReferenceCount = numberedReferenceCount(reportText);
  const reportReferenceNumbers = numberedReferenceNumbers(reportText);

  issues.region("report-sections");
  if (!nonEmpty(reportText)) issues.push("clinical-evidence-report.md must contain academic analysis.");
  const title = typeof reportText === "string" ? reportText.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "" : "";
  if (!title) issues.push("The academic title must be present.");
  for (const section of [/(?:^|\n)##\s+(?:摘要|Abstract)/i, /(?:^|\n)##\s+.*(?:临床|证据|Evidence|Clinical)/i, /(?:^|\n)##\s+.*(?:局限|Limitations?)/i, /(?:^|\n)##\s+.*(?:结论|Conclusion)/i]) {
    if (!section.test(reportText ?? "")) issues.push(`The academic report is missing a required section matching ${section}.`);
  }
  // The practical section is required by the same expression that finds it, and
  // by that expression alone. It used to be admitted by a second, wider
  // vocabulary — 结论|处置|Conclusion|Practical — so a report headed
  // 「## 结论与处置建议」 or 「## 患者须知」 satisfied the requirement while
  // reportSection(practicalSectionHeading) returned nothing, and every check
  // that reads this section (急救触发条件、derived 禁令、每条要点须挂 claim、
  // 药物安全规则) passed on an empty string. Requiring and locating the section
  // through one expression makes "the section that satisfies the requirement"
  // and "the section that gets audited" the same section by construction.
  // 结论 and 临床实践要点 stay two sections: the conclusion requirement above no
  // longer accepts a practical heading in its place, and this one does not
  // accept a conclusion heading.
  issues.region("practical-section");
  const practicalSection = reportSection(reportText, practicalSectionHeading);
  if (!practicalHeadingLinePattern.test(reportText ?? "")) {
    issues.push(
      "The academic report is missing the safety-first practical-answer section. "
      + `Head it with one of: ${practicalSectionHeading.split("|").join(" / ")} — `
      + "every safety check on practical advice locates that section by its heading, "
      + "so a heading outside this set means the section is never audited.",
    );
  } else if (!nonEmpty(practicalSection)) {
    issues.push(
      "The safety-first practical-answer section is empty. "
      + "Write the reader's actions under that heading; an empty section is audited as no section at all.",
    );
  }
  // Every package of this contract is a deep-research report. That used to be
  // switched by a `reportProfile` the run typed into its own receipt, so a run
  // that skipped the receipt skipped these checks too.
  issues.region("deep-research-sections");
  for (const section of [
    /(?:^|\n)##\s+.*(?:检索|方法|Methods?)/i,
    /(?:^|\n)##\s+.*(?:结果|Results?)/i,
    /(?:^|\n)##\s+.*(?:讨论|Discussion)/i,
  ]) {
    if (!section.test(reportText ?? "")) {
      issues.push(`The deep-research report is missing a required academic section matching ${section}.`);
    }
  }
  // Presence is required of every report above; here only the order matters.
  issues.region("reference-list-order");
  const practicalHeading = String(reportText ?? "").search(practicalHeadingLinePattern);
  const referencesHeading = String(reportText ?? "").search(/(?:^|\n)##\s+[^\n]*(?:参考文献|参考来源|References?)[^\n]*$/im);
  if (referencesHeading < 0 || (practicalHeading >= 0 && referencesHeading < practicalHeading)) {
    issues.push("The numbered reference list must follow the safety-first practical-answer section.");
  }
  issues.region("visible-claim-marker");
  if (visibleClaimMarkerPattern.test(reportText ?? "")) {
    issues.push("Deep-research reports must hide internal claim IDs in HTML comments and show standard numbered citations to readers.");
  }
  visibleClaimMarkerPattern.lastIndex = 0;
  issues.region("operational-failure-prose");
  if (operationalFailurePattern.test(reportText ?? "")) {
    issues.push("The academic report contains operational failure prose. A tool or source that failed is not a finding: leave it out of the report, and state a missing source as a limitation of the evidence in 局限性 if it matters.");
  }
  issues.region("runtime-leakage");
  const leakageLine = firstMatchingLine(reportText, runtimeLeakagePattern)
    ?? firstMatchingLine(withoutReportSections(reportText, "局限|Limitations?"), evidenceAccessLimitationPattern);
  if (leakageLine) {
    issues.push(
      "The academic report contains runtime or retrieval-process prose instead of scientific analysis: "
      + `line ${leakageLine.line} reads ${leakageLine.text}. `
      + "Write what the evidence shows, not how it was obtained — the run's tools, gateways, preserved artifacts (工件), "
      + "access levels (访问层级), environment (本环境), and retrieval passes (本轮检索) stay out of the report; the platform records them. "
      + "A source you could not obtain is stated as a limitation of the evidence base inside 局限性, in the reader's terms.",
    );
  }
  for (const finding of issues.from(declaredAppraisalIssues, reportText)) {
    if (finding.branch === "grade-level-contradicts-downgrade") {
      issues.push(
        `GRADE 等级与降级理由不自洽——第 ${finding.line} 行「${finding.text}」同句断言了证据缺陷`
        + "（如方法学质量偏低、偏倚风险高、存在不一致或间接性），却给出含「高」的确定性等级。"
        + "任何一项降级都排除「高」，请改等级或删除该缺陷断言。"
        + "（只写出五个降级领域的名称并说明未因其降级——如「偏倚风险低、结果一致、估计精确、无发表偏倚证据」——不触发本条。）",
      );
      continue;
    }
    const opening = `资料与方法声明了 ${finding.instrument}，但结果与讨论中没有一处用它给出评级：`
      + `第 ${finding.line} 行写「${finding.text}」。`;
    if (finding.branch === "hedged-declaration") {
      issues.push(
        `${opening}该行以「思路/精神/理念/参照…要点」提及 ${finding.instrument}，等同于未使用。`
        + "删除工具名并直接写你实际做了什么，或在结果或讨论里对具体一篇文献用它评一次。",
      );
    } else if (finding.branch === "appraisal-tail-only") {
      issues.push(
        `${opening}${finding.instrument} 只在局限性或结论里出现。`
        + "确定性等级必须写在对应证据体处，局限性不得为正文中不存在的方法学步骤申辩。",
      );
    } else {
      issues.push(
        `${opening}工具名是承诺，不是资格声明——要么在结果或讨论里对具体一篇文献用它评一次`
        + "（与该文献的编号同段，例如「按 QUADAS-2，该研究排除了…存在选择偏倚风险 [6]」），"
        + `要么在结果里写明「未检索到可用该工具评定的研究」，要么把 ${finding.instrument} 从方法里删掉。`,
      );
    }
  }
  issues.push(...issues.from(manuscriptRegisterIssues, reportText));
  issues.region("claim-marker-format");
  if (/\[claim:CLM-[0-9]{3,6}[^\]]+\]/.test(reportText ?? "")) {
    issues.push("Each claim marker must contain exactly one claim ID.");
  }
  issues.region("internal-api-citation");
  if (/https:\/\/www\.evimed\.com\/api-evimed\//i.test(reportText ?? "")) {
    issues.push("EviMed API endpoints cannot be used as public evidence citations.");
  }
  issues.region("exclusive-safety");
  if (exclusiveSafetyPattern.test(reportText ?? "")) {
    issues.push("The report must not turn a bounded recommendation into an unsupported exclusive safety claim.");
  }

  issues.region("matrix-present");
  if (!claims.length) issues.push("The evidence matrix must contain the report's material claims.");
  // A matrix written to a different schema is one problem, not one per field
  // per claim.
  //
  // Fourth appearance of this family today. A real run (rq03d) wrote 25 claims
  // shaped `{id, claim, evidence, certainty}` instead of the contract's, and
  // the verdict came back with 386 required issues -- roughly fifteen field
  // errors for each of twenty-five claims, none of which says "you used the
  // wrong shape". The run has to infer the schema from the wreckage.
  //
  // The test is deliberately narrow: EVERY claim missing `claimId` is a schema
  // mismatch, and one claim missing it is a bad claim. A single malformed
  // entry is still reported per field, because there the field list IS the
  // useful answer.
  const objectClaims = claims.filter((claim) => claim && typeof claim === "object" && !Array.isArray(claim));
  if (objectClaims.length && objectClaims.every((claim) => !nonEmpty(claim.claimId))) {
    const found = [...new Set(objectClaims.flatMap((claim) => Object.keys(claim)))].slice(0, 8);
    const absent = "clinical-evidence-matrix.json uses a different claim shape from the contract's."
      + ` Every one of its ${objectClaims.length} claims is missing \`claimId\`; the keys present are: ${found.join(", ")}.`
      + ` Each claim needs ${claimFields.join(", ")} — \`claimId\` matching CLM-NNN, \`supportQuote\` quoted verbatim`
      + " from the file named by `artifactPath`. Rewrite the matrix to that shape and resubmit."
      + " Nothing below the schema has been checked yet: every content rule reads the matrix, so the next"
      + " submission will be the first that can report on the work itself, and it will report on all of it"
      + " at once. A long list then is the checks running for the first time, not the package getting worse."
      + " This submission is charged against a separate allowance and does not spend a content repair attempt.";
    return {
      valid: false,
      issues: [...issues.texts(), absent],
      blockingIssues: [absent],
      safetyIssues: [],
      findings: [...issues.all(), { check: "matrix-schema", text: absent }].map((entry) => ({ ...entry, tier: clinicalCheckTier(entry.check), degradable: false })),
      issueChecks: [...issues.all(), { check: "matrix-schema", text: absent }],
      claimIds: [],
      sourceDomains: [],
    };
  }
  const seen = new Set();
  /** @type {{ label: string, claim: Record<string, any> }[]} */
  const derivedClaims = [];
  const claimContext = { issues, reportReferenceNumbers, successfulArtifacts, artifactText, sourceTypes: typeMap(sourceTypes), sourceDomains, seen, claimIds, derivedClaims };
  for (const [index, value] of claims.entries()) auditClaim(value, `claims[${index}]`, claimContext);
  const reportClaims = reportClaimIds(reportText);
  const reportSet = new Set(reportClaims);
  // With no matrix at all, every marker in the report is unresolvable, and
  // saying so once per marker buries the one fact that explains all of them.
  //
  // Observed on a real run (rq01, 2026-08-26): the run wrote the report and no
  // `clinical-evidence-matrix.json`, and the verdict came back with 23 blocking
  // issues, 14 of them "CLM-0NN does not resolve to the evidence matrix" — a
  // list of claim ids to chase, none of which is the problem. The rule above
  // already states the problem once. This is the same defect the absent-report
  // early return was written for, one file over.
  //
  // Only when the matrix is absent or empty: a matrix that *has* claims and is
  // missing the cited one is a genuine per-claim finding, and still reported.
  issues.region("report-claim-unresolved");
  for (const claimId of claims.length ? reportSet : []) {
    if (!seen.has(claimId)) issues.push(`Report claim reference ${claimId} does not resolve to the evidence matrix.`);
  }
  issues.region("matrix-claim-uncited");
  for (const claimId of seen) {
    if (!reportSet.has(claimId)) issues.push(`Evidence matrix claim ${claimId} is not cited by the report.`);
  }

  const claimsById = new Map(claims.map((claim) => [claim?.claimId, claim]));

  for (const finding of issues.from(regulatoryArticleIssues, reportText, claims, successfulArtifacts)) {
    issues.push(
      `报告正文第 ${finding.line} 行以条款级方式引用「${finding.locator}」，`
      + "但该行引用的来源中没有一件来自发文机关自有渠道的已留存监管文本工件"
      + "（要求：sourceUrl 主机名位于 .gov/.gov.<国别>/.go.<国别>/.europa.eu/.int 政府域，"
      + `artifactPath 是本次运行保存过的来源，且其 supportQuote 或 claim 含同一条号 第${finding.article}条 / Article ${finding.article}）；`
      + `该行现有引用为 [${finding.refs.join(", ") || "无"}]，指向 ${finding.hosts.join(", ") || "无可解析来源"}。`
      + "条号级陈述只能由法条原文承载：要么先取得并留存发文机关公布的该法条文本再引用，"
      + "要么删去条号，只写所引来源本身是什么——例如把「《医师法》第 29 条第 2 款将超说明书用药的合法条件规定为四点」"
      + "改写为「一篇法学综述归纳《医师法》为超说明书用药设定四项前提」。",
    );
  }

  // A derived result is only as good as what it stands on. Every input must
  // resolve, and following the inputs must reach measured evidence: a chain of
  // derivations resting on nothing is the fabrication this whole gate exists to
  // stop, wearing the vocabulary of analysis.
  issues.region("derived-claim-grounding");
  for (const { label, claim } of derivedClaims) {
    const grounding = derivedGroundingIssue(label, claim, claimsById);
    if (grounding) issues.push(grounding);
  }

  // Marked wherever it is asserted, so a reader meets the estimate as an
  // estimate. The claim marker alone is invisible in rendered prose.
  const derivedIds = new Set(derivedClaims.map(({ claim }) => claim?.claimId));
  issues.region("derived-report-label");
  if (derivedIds.size) {
    for (const [lineIndex, rawLine] of String(reportText ?? "").split("\n").entries()) {
      const cited = reportClaimIds(rawLine).filter((id) => derivedIds.has(id));
      if (cited.length && !derivedReportLabelPattern.test(rawLine)) {
        issues.push(
          `Report line ${lineIndex + 1} states derived result ${cited.join(", ")} without marking it as derived. Label it 〔推导〕 so it is not read as a measurement.`,
        );
      }
    }
  }

  const reportForNumericAudit = withoutReportSections(
    withoutReportSections(reportText, "参考文献|参考来源|References?"),
    "检索|方法|Methods?",
  );
  for (const [lineIndex, rawLine] of reportForNumericAudit.split("\n").entries()) {
    if (/^\s*#{1,6}\s+/.test(rawLine)) continue;
    const line = rawLine
      .replace(/^\s*[0-9]+\.\s*/, "")
      .replace(/^\s*\|\s*[0-9]+\s*\|/, "| |");
    // Only conclusory quantities (a number carrying a unit or statistic) are
    // audited, not every integer on the line.
    const reportNumbers = conclusoryQuantities(line);
    if (!reportNumbers.size) continue;
    const referencedIds = reportClaimIds(rawLine);
    issues.region("report-number-unanchored");
    if (!referencedIds.length) {
      issues.push(
        `Report line ${lineIndex + 1} numeric facts ${[...reportNumbers].join(", ")} have no evidence-matrix claim reference. Attach the numbered citation and claim marker that carry them.`,
      );
      continue;
    }
    issues.region("report-number-unsupported");
    const supportedNumbers = new Set(referencedIds.flatMap((claimId) => {
      const claim = claimsById.get(claimId);
      // Arabic numbers in support match by value; conclusoryQuantities resolves
      // conclusory Chinese and English numerals in the support to the same
      // canonical value symmetrically, so 15 / 十五 / "fifteen trials" agree.
      return [...numericTokens(claimEvidenceText(claim)), ...conclusoryQuantities(claimEvidenceText(claim))];
    }));
    const unsupportedNumbers = [...reportNumbers].filter((token) => !supportedNumbers.has(token));
    if (unsupportedNumbers.length) {
      issues.push(
        `Report line ${lineIndex + 1} numeric facts ${unsupportedNumbers.join(", ")} are not present in the cited claim evidence. Cite the claim that carries them, or attach the source passage that states them.`,
      );
    }
  }

  for (const finding of issues.from(attributedStanceIssues, reportForNumericAudit, claimsById)) {
    issues.push(finding.anchored
      ? `报告第 ${finding.line} 行以「${finding.attribution}」把立场归属给来源，但该行引用的 ${finding.claimIds.join("、")}，`
        + "其 supportQuote 都只陈述数值，没有一条载有这个立场。"
        + "立场归属句必须由某条 claim 的 supportQuote 逐字承载：请改引原文确实说过这句话的 claim；"
        + "若来源没说过，删去归属句，或改写为本报告自己的判断。"
        + "把这句话写进 claim / applicability / uncertainty 字段再当成来源立场引出来，不算数——门禁只读 supportQuote。"
      : `报告第 ${finding.line} 行以「${finding.attribution}」把立场归属给来源，却没有挂任何 claim 标记。`
        + "立场归属句必须由某条 claim 的 supportQuote 逐字承载：挂上原文确实说过这句话的 claim，"
        + "或删去归属句，改写为本报告自己的判断。");
  }

  // Pseudonyms are assigned by the analysis; record numbers come from the data
  // and must not leave it. Blocking, because a reader cannot tell P90000001
  // from a pseudonym, and the person it exposes is not the reader.
  issues.region("record-identifier-leak");
  const leakedInReport = recordIdentifiersInReport(reportText);
  const leakedInMatrix = recordIdentifiersInReport(JSON.stringify(matrix ?? {}));
  const leaked = [...new Set([...leakedInReport, ...leakedInMatrix])].sort();
  if (leaked.length) {
    issues.push(
      `The deliverables carry subject labels containing record numbers (${leaked.slice(0, 6).join(", ")}${leaked.length > 6 ? `, +${leaked.length - 6}` : ""}). Assign your own sequential pseudonyms and never reproduce an identifier from the source data.`,
    );
  }

  const practical = practicalSection;
  // The analysis may reason as far as the evidence allows. What a reader is
  // told to actually do may not rest on the analyst's own estimate: this
  // section is read as instruction, and an estimate read as instruction is the
  // one place a derivation could hurt someone.
  issues.region("practical-derived-claim");
  const derivedInPractical = [...new Set(reportClaimIds(practical).filter((id) => derivedIds.has(id)))];
  if (derivedInPractical.length) {
    issues.push(
      `The practical section cites derived result ${derivedInPractical.join(", ")}; practical advice must rest on measured evidence. Move the reasoning to the analysis and give the action a directly supported claim.`,
    );
  }
  for (const hit of issues.from(clinicalSafetyRuleHits, { reportText, practical, question: briefText })) {
    issues.pushAttributed({ text: hit.message, rule: hit.ruleId, line: hit.line });
  }
  issues.region("practical-claim-anchor");
  const numberedItems = practical.split(/\n(?=\s*[0-9]+\.\s+)/).filter((item) => /^\s*[0-9]+\.\s+/.test(item));
  if (numberedItems.some((item) => !hasClaimMarker(item))) {
    issues.push("Every numbered practical-action item must cite at least one evidence-matrix claim.");
  }
  const practicalActionLines = practical
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:(?:\*\*)?第[一二三四五六七八九十]+步|(?:\*\*)?[0-9]+[.、]|[-*+]\s+)/.test(line));
  if (practicalActionLines.some((line) => !hasClaimMarker(line))) {
    issues.push("Every practical-action step or bullet must cite at least one evidence-matrix claim.");
  }
  // The practical section's first line inside the report, so the notice names
  // the line the author will find rather than an offset into a section.
  const practicalOffset = practical ? String(reportText ?? "").indexOf(practical) : -1;
  const practicalFirstLine = practicalOffset >= 0
    ? String(reportText ?? "").slice(0, practicalOffset).split("\n").length
    : 1;
  for (const trigger of issues.from(medicationConditionedEmergencyTriggers, practical)) {
    issues.push(
      `临床实践要点第 ${practicalFirstLine + trigger.line - 1} 行把「${trigger.span}」写成了呼叫急救的触发条件：「${trigger.sentence}」。`
      + "急救的触发条件不得以自救用药的疗效为条件（含药不缓解、服药后无效、观察 N 分钟无效均不可）——"
      + "本节唯一允许的口径是「无论服药与否、无论是否缓解，出现上述征象即刻呼叫 120」。"
      + "同一节里已经写着「服药不是等待的理由，应在服药的同时呼叫急救」，这一条与它互斥，读者无法同时执行。"
      + "若来源（指南原文）确实给出了这一条件，把它留在「结果」一节按原文复述并保留出处，实践要点只写无条件的那一句。",
    );
  }

  // Padding stays a finding, but its own: the de-duplicated count used to be
  // the denominator for resolution, so listing one source twice silently made
  // the last reference "not resolve". Say what is actually true instead.
  issues.region("reference-list-duplication");
  if (reportReferenceNumbers.size > reportReferenceCount) {
    issues.push(
      `The numbered reference list gives ${reportReferenceNumbers.size} entries for ${reportReferenceCount} distinct sources; the same source is listed under more than one number.`,
    );
  }
  issues.region("reference-number-unresolved");
  const unresolved = [...new Set(claims
    .map((claim) => claim?.referenceNumber)
    .filter((number) => Number.isInteger(number) && !reportReferenceNumbers.has(number)))].sort((a, b) => a - b);
  if (unresolved.length) {
    issues.push(`The numbered reference list has no entry for reference ${unresolved.join(", ")}.`);
  }
  // The practical section's line range, so a mispaired anchor there is
  // blocking: that section is already the one place the gate refuses derived
  // claims and requires a marker on every action line.
  const practicalLastLine = practical ? practicalFirstLine + practical.split("\n").length - 1 : 0;
  for (const finding of issues.from(citationClosureFindings, reportText, claimsById)) {
    if (finding.clause === "A") {
      issues.push(
        `参考文献 [${finding.number}] 在正文中从未被引用：「${finding.body}」。`
        + "已检索但未纳入的来源不进编号表——要么在正文中真正引用它，要么把它从编号表中移除并重新编号。",
      );
    } else if (finding.clause === "B") {
      issues.push(
        `正文引用 [${finding.number}] 在参考文献表中没有对应条目：补上该条目，或改引真正支持这句话的编号。`,
      );
    } else if (finding.clause === "C") {
      issues.push(
        `报告第 ${finding.line} 行把书目标识符放进了引用位：「${finding.bracket}」。`
        + "行内 PMID/DOI 不能代替编号引用——为该来源分配参考文献编号与 claim，或把它从这句话里删去。",
      );
    } else if (finding.clause === "D") {
      const detail = `${finding.claimId}，但该行只引用了 [${finding.cited.join(", ") || "无"}]，`
        + `而 ${finding.claimId} 的 referenceNumber 是 ${finding.allowed.join(", ")}。`
        + "把该行改引正确的编号，或换成真正支持这句话的 claim；同一 claim 在别处已正确配对不豁免这一行。";
      issues.push(finding.line >= practicalFirstLine && finding.line <= practicalLastLine
        ? `The practical section's report line ${finding.line} anchors claim ${detail}`
        : `Report line ${finding.line} anchors claim ${detail}`);
    }
  }
  issues.region("claim-inline-citation");
  for (const [index, claim] of claims.entries()) {
    // A derived result is not a source and has no reference number of its
    // own; its inputs carry the citations, and it carries the derived label.
    if ((claim?.claimType ?? "direct") === "derived") continue;
    const marker = `<!-- claim:${claim?.claimId} -->`;
    const claimLine = String(reportText).split("\n").find((line) => line.includes(marker)) ?? "";
    if (!standardCitationNumbers(claimLine).has(claim?.referenceNumber)) {
      issues.push(`claims[${index}] is not paired with its standard numbered in-text citation.`);
    }
  }

  const detected = collapseClaimFieldIssues(issues.all());
  /** @param {AttributedIssue} entry */
  const withholds = (entry) => {
    const tier = clinicalCheckTier(entry.check);
    return (tier === "blocking" || tier === "safety") && !degradableIssue(entry.text);
  };

  return Object.freeze({
    valid: detected.length === 0,
    issues: Object.freeze(detected.map((entry) => entry.text)),
    blockingIssues: Object.freeze(detected.filter(withholds).map((entry) => entry.text)),
    // The subset a reader is shown first: clinical framing.
    safetyIssues: Object.freeze(detected.filter((entry) => clinicalCheckTier(entry.check) === "safety" && withholds(entry)).map((entry) => entry.text)),
    // Every finding with the tier that decided what became of it. What a
    // false-positive distribution is computed over, and what a test of a
    // check's own logic reads.
    findings: Object.freeze(detected.map((entry) => Object.freeze({
      check: entry.check, text: entry.text, tier: clinicalCheckTier(entry.check), degradable: degradableIssue(entry.text),
    }))),
    // The same findings in the same order, each naming the check that raised
    // it. `issues` stays the strings the repair loop is fed, byte for byte;
    // this is what makes a per-check false-positive rate computable at all.
    issueChecks: Object.freeze(detected.map((entry) => Object.freeze({ check: entry.check, text: entry.text }))),
    claimIds: Object.freeze(claimIds),
    sourceDomains: Object.freeze([...sourceDomains].sort()),
  });
}

/**
 * Runtime-leakage findings in arbitrary prose, for the contract kinds that are
 * not a clinical evidence package but are still report prose. The clinical
 * validator applies the same pattern inline; this export is what lets the
 * generic validators reuse the rule rather than restate it (§14 rule 4).
 * @param {string} text
 * @returns {{ line: number, text: string, match: string } | null}
 */
export function runtimeLeakageLine(text) {
  return firstMatchingLine(text, runtimeLeakagePattern);
}
// Attribution: the same rule the clinical validator applies inline, so the
// finding carries the same check id wherever it is raised.
checkedBy(runtimeLeakageLine, "runtime-leakage");

/**
 * The four Apodex verification-gate metrics (§8.1), computed mechanically from
 * the evidence matrix and, for a contract that has one, the citation ledger.
 * They are notices, not blocks: the thresholds that would make them blocking do
 * not exist yet, and a metric whose threshold nobody has calibrated is a coin
 * toss dressed as a gate.
 * @param {{ matrix?: any, citationLedgerText?: string, staleEvidenceCount?: number }} input
 * @returns {{ citationCoverage: number, confidenceMix: Record<string, number>, disputedShare: number, unresolved: number }}
 */
export function verificationGateMetrics({ matrix, citationLedgerText = "", staleEvidenceCount = 0 } = {}) {
  /** @type {Record<string, any>[]} */
  const claims = Array.isArray(matrix?.claims) ? matrix.claims : [];
  const total = claims.length;
  const supported = claims.filter((claim) => {
    if (!claim || typeof claim !== "object") return false;
    if (nonEmpty(claim.sourceUrl) || nonEmpty(claim.identifier) || nonEmpty(claim.artifactPath)) return true;
    return Array.isArray(claim.supportingSources) && claim.supportingSources.length > 0;
  }).length;
  /** @type {Record<string, number>} */
  const confidenceMix = { high: 0, moderate: 0, low: 0, unlabelled: 0 };
  let disputed = 0;
  for (const claim of claims) {
    if (!claim || typeof claim !== "object") continue;
    if (claim.claimType === "synthesized") {
      const level = String(claim.confidence ?? "").toLowerCase();
      if (level === "high" || level === "moderate" || level === "low") confidenceMix[level] += 1;
      else confidenceMix.unlabelled += 1;
    }
    if (Array.isArray(claim.contradictedBy) && claim.contradictedBy.length) disputed += 1;
  }
  const ledgerRows = String(citationLedgerText ?? "").split(/\r?\n/).filter((line) => line.trim()).length;
  const unresolvedRows = total > 0 && ledgerRows > 0 ? Math.max(0, total - (ledgerRows - 1)) : 0;
  return {
    citationCoverage: total ? Number((supported / total).toFixed(4)) : 0,
    confidenceMix,
    disputedShare: total ? Number((disputed / total).toFixed(4)) : 0,
    unresolved: unresolvedRows + Math.max(0, Number(staleEvidenceCount) || 0),
  };
}

// --- Advice, never a block --------------------------------------------------
//
// These three rules used to live only in the run-side Python checker, where
// they were reported as `notes`. When the second implementation was deleted
// they moved here rather than being dropped: each reads a real defect the
// commissioning reviewers named, and each rests on a judgement no pattern can
// make — which nouns are the compared arms, whether a question in 目的 was
// answered in prose, whether this question's population has strata at all.
//
// A rule that cannot be decided must never be able to withhold a finished
// package, so they are advisory on both sides. That is the same verdict the
// preflight reached; what changed is that there is now one computation of it,
// and the run and the server say the same words.

const abstractPurposePattern = /目的[:：]?\s*([\s\S]*?)(?=(?:方法|资料|材料|结果|结论)\s*[:：]|$)/;
const cjkOrdinals = "一二三四五六七八九十";
const circledDigits = "①②③④⑤⑥⑦⑧⑨⑩";
// A cross-arm blanket negation ("两药……均缺乏证据") is the shape a merged PICO
// takes in a sentence; the fallback test for the merge is that the report never
// names a stratum anywhere. Both halves are heuristics — a question whose
// population genuinely has no strata writes the same sentence correctly.
const crossArmBlanketNegationPattern = /(?:两(?:药|者|种药物?|类药物?|型)|二者|双方|各药)[^。；\n]{0,40}(?:均|都)[^。；\n]{0,20}(?:缺乏|缺少|尚无|没有|无|未检索到|未见|未发现)[^。；\n]{0,20}(?:证据|研究|数据|试验)/;
// A stratum is named by what is already established about the patient. 分层 on
// its own is not one of these: 危险分层 is ordinary triage prose, and reading it
// as a named stratum silenced this rule entirely.
const populationStratumPattern = /已确诊|确诊|初发|首发|首次(?:发生|发作)|既往|病史|未分化|未确诊|病因(?:未明|不明)|稳定型|不稳定型|新发|亚组|按[^。；\n]{0,10}分层|分层[^。；\n]{0,2}人群|人群分层/;
const directComparisonMentionPattern = /头对头|直接比较|直接对比|head[-\s]?to[-\s]?head/i;
const comparisonQuestionPattern = /比较|对比|头对头|优劣|孰优|versus|(?<![A-Za-z])vs\.?(?![A-Za-z])/i;
const certaintyAppraisalPattern = /GRADE|确定性|证据等级|证据质量|证据体质量/;
const traditionAppraisalPattern = /长期(?:临床)?(?:使用|应用|实践|经验)|广泛(?:使用|应用|采用)|指南(?:推荐|支持|建议)|久经(?:临床)?(?:使用|考验)|临床经验支持|沿用已久|一线(?:用药|药物)地位/;

/** @param {string} text @returns {string[]} */
function splitSentences(text) {
  return String(text ?? "").split(/(?<=[。！？；;])/);
}

/**
 * How many items an enumeration lists, counting only markers that run 1, 2, 3 …
 * from the start. A lone 「（3）」 inside a sentence is a cross-reference to
 * somebody else's third item, not a list of three.
 * @param {string} text @returns {number}
 */
function enumeratedCount(text) {
  const value = String(text ?? "");
  let best = 0;
  /** @type {((n: number) => string[])[]} */
  const families = [
    (n) => [`（${n}）`, `(${n})`],
    (n) => (n <= cjkOrdinals.length ? [`${cjkOrdinals[n - 1]}、`, `（${cjkOrdinals[n - 1]}）`, `(${cjkOrdinals[n - 1]})`] : []),
    (n) => (n <= circledDigits.length ? [circledDigits[n - 1]] : []),
  ];
  for (const markers of families) {
    let count = 0;
    while (count < 12 && markers(count + 1).some((marker) => value.includes(marker))) count += 1;
    best = Math.max(best, count);
  }
  let numbered = 0;
  while (numbered < 12 && new RegExp(`^\\s*${numbered + 1}[.、)]\\s*\\S`, "m").test(value)) numbered += 1;
  return Math.max(best, numbered);
}

/**
 * Advisory findings on a clinical evidence report.
 * @param {string} reportText
 * @returns {string[]}
 */
export function clinicalEvidenceAdvisoryNotes(reportText) {
  const report = String(reportText ?? "");
  if (!report.trim()) return [];
  /** @type {string[]} */
  const notes = [];
  const body = withoutReportSections(
    withoutReportSections(report, "参考文献|参考来源|References?"),
    "检索|方法|Methods?",
  );

  // 摘要 目的 lists the research questions and 结论 answers them one for one;
  // when both are enumerated the counts are comparable. Only then — a prose
  // 结论 may answer three questions in three sentences, and no count can say
  // whether it did.
  const purpose = abstractPurposePattern.exec(reportSection(report, "摘要"));
  const questions = purpose ? enumeratedCount(purpose[1]) : 0;
  const answers = enumeratedCount(reportSection(report, "结论"));
  if (questions >= 2 && answers >= 2 && questions !== answers) {
    notes.push(
      `clinical-evidence-report.md: 摘要 目的 lists ${questions} research questions and 结论 gives ${answers} numbered answers. `
      + "结论 answers the questions of 目的 in the same order, one answer per question. A question with no answer was either "
      + "unanswerable — write it as a gap, with the study that would close it — or was dropped, which is a restatement and is "
      + "declared: say which question was asked, what in it does not survive contact with the evidence, what replaces it, and "
      + "what the replacement can settle. An answer matching no question in 目的 is the object of study drifting toward an easier question.",
    );
  }

  // A verdict given for every arm at once, in a report that names no stratum
  // anywhere. A setting named in the question is not a population.
  const stratified = populationStratumPattern.test(body);
  if (!stratified) {
    for (const [index, line] of body.split("\n").entries()) {
      if (!crossArmBlanketNegationPattern.test(line) || directComparisonMentionPattern.test(line)) continue;
      notes.push(
        `clinical-evidence-report.md line ${index + 1}: one verdict is given for every arm at once (${excerpt(line)}) `
        + "and no stratum is named anywhere in the report. A setting named in the question (院外自救, 基层首诊, 居家用药) is not a "
        + "population: inside it sit groups whose evidentiary position differs — 已确诊冠心病或心绞痛按既往医嘱处置 / 既往有类似症状"
        + "但本次性质或程度改变 / 首次发生、病因不明 — and merging them produces a judgment true of none of them, because the stratum "
        + "with the least evidence sets the verdict for all of them and the uses that do have an established basis disappear. "
        + "Name the stratum wherever the judgment appears.",
      );
      break;
    }
  }

  // A substitution conclusion in a report that never says whether a direct
  // comparison exists at all: the axis was simply never filled.
  if (!directComparisonMentionPattern.test(body)) {
    for (const [index, line] of body.split("\n").entries()) {
      const conclusion = substitutionConclusion(line);
      if (!conclusion) continue;
      notes.push(
        `clinical-evidence-report.md line ${index + 1}: one arm is concluded to take the other's place or to beat it `
        + `(${conclusion}), and the report never says whether a direct comparison between them exists. Fill the 是否存在直接比较研究 `
        + "axis either way — head-to-head evidence with its citation, or 未检索到 with what was searched — and if there is none, "
        + "list the links the chain needs one per line in 讨论 marked 已建立 or 未建立, and stop the conclusion at the last "
        + "established link. 可能 does not close an open link: a speculative recommendation still reads to the reader as a "
        + "substitution conclusion.",
      );
      break;
    }
  }

  notes.push(...appraisalSymmetryNotes(report));
  return notes;
}
// Attribution: read by the contract registry, which raises these as advisory notices.
checkedBy(clinicalEvidenceAdvisoryNotes, "advisory-notes");

/**
 * When the question compares two interventions, the first thing a reviewer
 * checks is whether they were appraised the same way. The asymmetry is almost
 * never deliberate: the familiar arm attracts the language of clinical
 * tradition and the less studied arm attracts the language of grading, and a
 * conclusion ends up reporting one as supported and the other as uncertain when
 * both stand in the same evidentiary position for the question actually asked.
 *
 * Which nouns in a sentence are the compared arms is not decidable from the
 * text — the two vocabularies can also belong to one arm across two indications,
 * which is correct writing. So this is advice.
 * @param {string} report @returns {string[]}
 */
function appraisalSymmetryNotes(report) {
  const title = /^#\s+(.+)$/m.exec(report)?.[1] ?? "";
  const abstract = reportSection(report, "摘要");
  const conclusion = reportSection(report, "结论");
  if (!comparisonQuestionPattern.test([title, abstract, conclusion].join("\n"))) return [];
  /** @type {string[]} */
  const notes = [];
  for (const [name, text] of [["摘要", abstract], ["结论", conclusion]]) {
    const sentences = splitSentences(text);
    const graded = sentences.filter((line) => certaintyAppraisalPattern.test(line));
    const vouched = sentences.filter((line) => traditionAppraisalPattern.test(line) && !certaintyAppraisalPattern.test(line));
    if (!graded.length || !vouched.length) continue;
    notes.push(
      `clinical-evidence-report.md ${name}: one arm is vouched for by clinical tradition (${excerpt(vouched[0])}) while `
      + `another's certainty is graded (${excerpt(graded[0])}). Check that every compared arm is appraised with the same `
      + "instrument, for the same indication, population, care setting and outcome, and that a gap the arms share is stated for "
      + "both — 长期使用、指南推荐与批准上市各自是某件事的证据，都不是确定性等级。If one arm's evidence really is stronger for the "
      + "question asked, say so in the same vocabulary you used for the other.",
    );
  }
  return notes;
}

/**
 * Each level-two section's share of the body, in percent of non-blank
 * characters, with the reference list left out.
 *
 * Length is a claim about importance, and the shares that fit a comparison
 * question are roughly 50% for the comparison between arms, 25–30% for
 * population heterogeneity and 10–15% for the safety boundary — magnitudes to
 * check against, never a quota to write toward. Which section serves which
 * question is not decidable here, so this hands the run the measurement and the
 * run applies the rule.
 *
 * @param {string} reportText
 * @returns {Record<string, number>}
 */
export function reportSectionShares(reportText) {
  const body = withoutReportSections(String(reportText ?? ""), "参考文献|参考来源|References?");
  /** @type {[string, number][]} */
  const sections = [];
  let heading = "";
  let size = 0;
  for (const line of body.split("\n")) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (heading) sections.push([heading, size]);
      heading = match[1];
      size = 0;
      continue;
    }
    if (heading) size += line.replace(/\s+/g, "").length;
  }
  if (heading) sections.push([heading, size]);
  const total = sections.reduce((sum, [, value]) => sum + value, 0);
  if (!total) return {};
  return Object.fromEntries(sections.map(([name, value]) => [name, Math.round((value * 100) / total)]));
}
