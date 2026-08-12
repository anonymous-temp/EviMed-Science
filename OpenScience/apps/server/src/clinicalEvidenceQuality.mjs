import { readFileSync } from "node:fs";

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
// 基本环境/日本环境/样本环境 and 加工件 are ordinary words that contain these,
// so each is anchored away from its innocent compounds.
const runtimeLeakagePattern = /(?:clinical-evidence-synthesis|\bevimed_[a-z_]+\b|EviMed.{0,24}(?:引擎|网关|工具)|证据追溯契约|\.evimed-sources\/|(?:抓取|落盘).{0,16}(?:核验|来源|文件|原文)|白名单抓取|工具调用|(?<!加)工件|访问层级|(?<![基日样标根成])本环境|本轮检索|检索环境|(?:未触及|未读取|未检索).{0,16}(?:完整|全文|文件|页面))/i;
// A material limit on evidence accessibility (e.g. a guideline whose full text
// is not openly available) is a legitimate property of the evidence base. It is
// banned in the analysis body but permitted inside the Limitations section.
const evidenceAccessLimitationPattern = /(?:全文|页面|文件).{0,12}(?:不可及|无法获取|无法获得|未能获取|未能获得|不可得)/i;
const emergencyCallClaimPattern = /(?:(?:呼叫|拨打).{0,16}(?:急救|120|999)|(?:急救|120|999).{0,16}(?:呼叫|拨打))/i;
const emergencyCallSupportPattern = /(?:call.{0,16}(?:999|emergency|ambulance)|(?:999|emergency|ambulance).{0,16}call|呼叫|拨打|急救)/i;
// Generic (non-drug-specific) safety rule. Drug- and scenario-specific rules
// live in clinical-safety-rules.json so pharmacists can maintain them as data.
const exclusiveSafetyPattern = /(?:唯一.{0,24}(?:安全|可靠|正确|一致|策略|方法|途径)|(?:安全|可靠|正确).{0,24}唯一)/i;
// The heading the safety-first practical answer sits under. It was
// 安全优先的实际处置; the manuscript rewrite renames it 临床实践要点. Every
// safety check on that section finds it by name, so a rename that stopped
// matching would take those checks with it silently — the section would simply
// be "not present" and nothing in it would be audited. Both names, and the
// shapes runs have used in between, resolve to the same section.
const practicalSectionHeading = "安全优先的实际处置|实际处置|实用回答|临床实践要点|临床要点|实用|怎么办|Practical";
const practicalHeadingLinePattern = new RegExp(`(?:^|\\n)##\\s+[^\\n]*(?:${practicalSectionHeading})[^\\n]*$`, "im");
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
const selfReferentialNarrationPattern = /学术化版本|作为被评价对象|(?:本报告|本文)[^。；\n]{0,16}(?:判定条件|交付判据|达标判据|验收依据|任务书|评分口径)|(?:本报告|本文)[^。；\n]{0,10}拒绝[^。；\n]{0,24}(?:判据|验收|达标|指标)/;
const deepResearchProfile = "academic_deep_research_v1";
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
  "references.bib must contain a bibliography entry for every numbered report reference.",
  "references.bib must contain a bibliography entry for every cited source URL.",
  "citation-ledger.csv must have a header naming claimId, referenceNumber and supportQuote columns (any order, extra columns allowed) and one row per evidence-matrix claim.",
  "citation-ledger.csv rows must match each evidence-matrix claim's id and reference number.",
  "citation-audit.md must document unresolved, duplicate, correction/retraction, metadata-only, and claim-mismatch checks.",
  "citation-audit.md must reference at least one real audited source identifier from the evidence matrix.",
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
  /^The academic report is missing a required section matching /,
  /^The academic report contains (?:runtime or retrieval-process|operational failure) prose/,
]);

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
function compileClinicalSafetyRule(rule) {
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
  const parsed = JSON.parse(readFileSync(new URL("./clinical-safety-rules.json", import.meta.url), "utf8"));
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.rules) || parsed.rules.length === 0) {
    throw new Error("clinical-safety-rules.json is missing or malformed.");
  }
  return Object.freeze(parsed.rules.map(compileClinicalSafetyRule));
}

const clinicalSafetyRules = loadClinicalSafetyRules();

function evaluateClinicalSafetyRules({ reportText, practical, question }) {
  const report = String(reportText ?? "");
  const practicalText = String(practical ?? "");
  const found = [];
  for (const rule of clinicalSafetyRules) {
    if (rule.kind === "report_forbidden") {
      let text = report;
      for (const substitution of rule.substitutions) text = text.replace(substitution.find, substitution.replace);
      if (rule.pattern.test(text)) found.push(rule.message);
    } else if (rule.kind === "practical_forbidden") {
      if (rule.pattern.test(practicalText)) found.push(rule.message);
    } else if (rule.kind === "entity_requires_question_mention") {
      if (nonEmpty(question) && !rule.pattern.test(question) && rule.pattern.test(report)) found.push(rule.message);
    } else if (rule.kind === "practical_required_when_report_matches") {
      if (rule.triggerPattern.test(report) && !rule.pattern.test(practicalText)) found.push(rule.message);
    }
  }
  return found;
}

function nonEmpty(value, minimum = 1) {
  return typeof value === "string" && value.trim().length >= minimum;
}

// The same standard the report's citations are held to: an address a reader can
// open, carrying no credentials. Requiring https here while the report-side
// check accepts http left one rule for a citation and another for the very same
// URL in the matrix behind it — and a fragment, which is how a citation points
// at the passage it means, disqualified the source outright.
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
function normalizedPassage(value) {
  return String(value ?? "")
    .normalize("NFKC")
    // Soft hyphens and zero-width joiners survive NFKC and are invisible in the
    // artifact, so a faithfully retyped quote silently fails to match.
    .replace(/\u00AD|\u200B|\u200C|\u200D|\uFEFF/g, "")
    .replace(/[‘’“”"'＂＇]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    // PDF extraction routinely spaces out CJK runs ("速 效 救 心 丸"). The
    // spacing is an artefact of the extractor, not of the source, so it must
    // not decide whether a quote is found.
    .replace(/(?<=[\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF])\s+(?=[\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF])/g, "")
    .trim()
    .toLowerCase();
}

function validSupportingPassage(value) {
  return normalizedPassage(value).replace(/\s+/g, "").length > 0;
}

// A search is identified by its terms. Retyping the same search into the log
// without its phrase quotes, or with different spacing, is a transcription
// difference — treating it as a search that never ran would accuse the agent of
// inventing provenance it did not invent. The terms themselves must still match.
function normalizedSearchQuery(value) {
  return String(value ?? "")
    .replace(/[‘’“”"'＂＇]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// What survives when every separator is dropped: the letters, the digits, and
// the symbols that change what a figure means. Two passages with the same
// skeleton say the same thing. Comparison operators stay in — ">50%" and "50%"
// are different findings and must not compare equal.
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

function segmentsPresentInOrder(haystack, segments, project) {
  if (!haystack) return false;
  let from = 0;
  for (const segment of segments) {
    const needle = project(segment);
    if (!needle) return false;
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    from = at + needle.length;
  }
  return true;
}

// A preserved artifact carries extraction noise inside its sentences: a PDF
// line break splits a word ("coronary artery dis - ease"), a markdown list
// marker lands mid-sentence ("call 999 if: - you get sudden pain"), an
// extractor leaves a space before punctuation ("activity 37 ."). A quote copied
// the way a human reads the sentence then fails literal containment even though
// every word of it is there. Falling back to the skeleton accepts the
// formatting difference and nothing else: the words, figures and comparison
// operators must still appear in order, so a quote the source does not contain
// still fails.
//
// A quote may also elide — mark a skipped passage with … — the way any scholarly
// quotation does. Each segment is then verified on its own, in order and without
// overlapping, so an elision cannot join two passages that do not occur in that
// sequence.
// A quote that joins two passages without marking the gap fails the same check
// as one the source never contained, but the two need opposite repairs — mark
// the elision, versus find the passage that actually says it. Telling them
// apart is worth the scan: both halves are in the document, just not adjacent.
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

function quoteFailure(artifact, quote) {
  return quoteJoinsUnmarkedPassages(artifact, quote)
    ? "joins two passages that are not adjacent in the source. Mark the gap with … if the elision is intended, or quote the one passage that carries the claim"
    : "was not found in its preserved source artifact";
}

function quoteIsPresent(artifact, quote) {
  const source = String(artifact ?? "");
  const segments = String(quote ?? "").split(quoteElision).map((part) => part.trim()).filter(Boolean);
  if (!source || !segments.length) return false;
  // The artifact as preserved, then with inline citation markers taken out.
  for (const text of [source, source.replace(inlineReferenceMarker, "")]) {
    if (segmentsPresentInOrder(normalizedPassage(text), segments, normalizedPassage)) return true;
    if (segmentsPresentInOrder(passageSkeleton(text), segments, passageSkeleton)) return true;
  }
  return false;
}

// The text a claim's numeric and quotational support is drawn from. Direct
// claims draw on their own single source; synthesized claims draw on every
// supporting source plus the claim statement itself.
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
const cjkDigit = { "〇": 0, "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
const cjkUnitSmall = { "十": 10, "百": 100, "千": 1000 };
const cjkUnitBig = { "万": 10000, "亿": 100000000 };

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
const enOnes = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const enTens = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const enScales = { hundred: 100, thousand: 1000, million: 1000000, billion: 1000000000 };
const enWordsAlt = [...Object.keys(enOnes), ...Object.keys(enTens), ...Object.keys(enScales)].join("|");

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

function canonicalNumbers(text) {
  if (/[0-9]/.test(text)) return numericTokens(text);
  if (/[a-z]/i.test(text)) {
    const value = englishNumberRunValue(text.toLowerCase().split(/[\s-]+/).filter(Boolean));
    return value == null || value <= 0 ? [] : [String(value)];
  }
  const value = cjkNumberValue(text);
  return value == null ? [] : [String(value)];
}

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

function reportClaimIds(value) {
  const text = String(value ?? "");
  return [
    ...[...text.matchAll(visibleClaimMarkerPattern)].map((match) => match[1]),
    ...[...text.matchAll(hiddenClaimMarkerPattern)].map((match) => match[1]),
  ];
}

function hasClaimMarker(value) {
  return reportClaimIds(value).length > 0;
}

function bibliographyEntryCount(value) {
  return [...String(value ?? "").matchAll(/^@[A-Za-z]+\s*\{/gm)].length;
}

const referenceEntryPattern = /^\s*(?:\[(\d{1,3})\]|(\d{1,3})[.、])\s+(\S.*)$/;

/** Every identifier an entry carries, normalised so the same work matches
 *  itself across schemes. A DOI, a PMID and a Europe PMC URL are three names
 *  for one article, and a bibliography that lists it under two of them is
 *  citing it twice. */
function referenceIdentifiers(text) {
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
 *  number that outranks the real year on a plain maximum. */
function plausibleYears(text) {
  const ceiling = new Date().getUTCFullYear() + 1;
  return [...text.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)]
    .map((match) => Number(match[1]))
    .filter((year) => year >= 1800 && year <= ceiling);
}

function referenceYear(text) {
  const years = plausibleYears(text);
  return years.length ? Math.max(...years) : null;
}

/** Deterministic integrity checks over a reply's own citations.
 *
 * These are the failures a URL-hygiene check cannot see: a marker pointing at
 * no entry, an entry nobody cites, one article listed twice under two
 * identifier schemes, an entry that declares itself a copy of another, and a
 * sentence resting a dated claim on a source that predates it. */
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
export function numberedReferenceNumbers(reportText) {
  const references = reportSection(reportText, "参考文献|参考来源|References?");
  const numbers = new Set();
  for (const line of references.split("\n")) {
    const match = /^\s*(\d+)[.、]\s+\S/.exec(line);
    if (match) numbers.add(Number(match[1]));
  }
  return numbers;
}

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

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
 *  @returns {{ line: number, text: string } | null}
 */
function firstMatchingLine(text, pattern) {
  const lines = String(text ?? "").split("\n");
  for (const [index, line] of lines.entries()) {
    if (pattern.test(line)) return { line: index + 1, text: excerpt(line) };
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

/** Commissioning vocabulary, acceptance-specification structure, and
 *  self-referential narration — the three ways the request's own register
 *  survives into the manuscript. Read outside the reference list, where a cited
 *  title may legitimately carry any of these words.
 *  @param {any} reportText
 */
function manuscriptRegisterIssues(reportText) {
  const issues = [];
  const body = withoutReportSections(reportText, "参考文献|参考来源|References?");
  const namedTerms = new Set();
  const propositionLines = [];
  let propositionSample = "";
  let headings = 0;
  let verdicts = 0;
  let narrations = 0;
  for (const [index, line] of body.split("\n").entries()) {
    const lineNumber = index + 1;
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
        + "State the objective plainly in 引言 (本文旨在评价……) and delete the rest; if a scientific question is buried in the sentence, ask it scientifically.",
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

// A CSV record is not a line: a quoted support quote may hold commas, doubled
// quotes, and newlines, and the ledger is written by a csv writer that quotes
// exactly that way. Counting lines therefore counted the wrong thing.
function parseCsvRecords(text) {
  const source = String(text ?? "").replace(/\r\n?/g, "\n");
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (source[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") { record.push(field); field = ""; }
    else if (char === "\n") { record.push(field); records.push(record); record = []; field = ""; }
    else field += char;
  }
  if (field || record.length) { record.push(field); records.push(record); }
  return records.filter((row) => row.some((cell) => cell.trim()));
}

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

function validSourceArtifactPath(value) {
  return typeof value === "string"
    && value.startsWith(".evimed-sources/")
    && !value.includes("\\")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function sourceArtifactIdentity(value) {
  if (!validSourceArtifactPath(value)) return null;
  const parts = value.split("/");
  const fileName = parts.at(-1)?.toLowerCase();
  if (["fulltext.md", "fulltext.xml", "page.md", "page.html"].includes(fileName)) {
    return parts.slice(0, -1).join("/");
  }
  return value;
}

// Validates a cross-source ("synthesized") claim: the conclusion itself has no
// single verbatim home, so every supporting source must independently satisfy
// the same artifact/quote/URL checks a direct claim gets, and claim numbers
// must trace to a supporting quote or be machine-verifiable source counts.
function validateSynthesizedClaim(
  value,
  { label, deepResearch, reportReferenceNumbers, successfulArtifacts, artifactText, sourceDomains, issues },
) {
  if (!synthesizedConfidenceLevels.has(value.confidence)) {
    issues.push(`${label}.confidence must be one of high, moderate, low for a synthesized claim.`);
  }
  if (deepResearch) {
    if (!Number.isInteger(value.referenceNumber) || !reportReferenceNumbers.has(value.referenceNumber)) {
      issues.push(`${label}.referenceNumber must resolve to a numbered report reference.`);
    }
    const referenceNumbers = Array.isArray(value.referenceNumbers) ? value.referenceNumbers : [];
    if (
      referenceNumbers.length < 2
      || referenceNumbers.some((entry) => !Number.isInteger(entry) || !reportReferenceNumbers.has(entry))
    ) {
      issues.push(`${label}.referenceNumbers must list at least two numbered report references.`);
    } else if (Number.isInteger(value.referenceNumber) && !referenceNumbers.includes(value.referenceNumber)) {
      issues.push(`${label}.referenceNumber must be one of its referenceNumbers.`);
    }
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
        issues.push(`${sourceLabel}.artifactPath is not listed as a successful source artifact for this run.`);
      } else {
        if (!quoteIsPresent(artifactText.get(source.artifactPath), source.supportQuote)) {
          issues.push(`${sourceLabel}.supportQuote ${quoteFailure(artifactText.get(source.artifactPath), source.supportQuote)}.`);
        }
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

/** TypeScript infers a destructured parameter as exactly the shape its
 *  defaults name, which rejects every other property a caller passes.
 *  @param {Record<string, any>} options0
 */
export function validateClinicalEvidencePackage({
  reportText,
  matrix,
  runReceipt,
  sourceArtifacts = {},
  executedSearchQueries = null,
  searchLogText = "",
  referencesText = "",
  citationLedgerText = "",
  citationAuditText = "",
} = {}) {
  const issues = [];
  const claimIds = [];
  const sourceDomains = new Set();
  const claims = matrix && typeof matrix === "object" && !Array.isArray(matrix) && Array.isArray(matrix.claims)
    ? matrix.claims
    : [];
  const successfulArtifacts = new Set(
    Array.isArray(runReceipt?.successfulSourceArtifacts)
      ? runReceipt.successfulSourceArtifacts.filter((value) => typeof value === "string")
      : [],
  );
  const distinctSuccessfulSources = new Set(
    [...successfulArtifacts].map(sourceArtifactIdentity).filter(Boolean),
  );
  const artifactText = sourceArtifacts instanceof Map
    ? sourceArtifacts
    : new Map(Object.entries(sourceArtifacts && typeof sourceArtifacts === "object" ? sourceArtifacts : {}));
  const deepResearch = runReceipt?.reportProfile === deepResearchProfile;
  const reportReferenceCount = numberedReferenceCount(reportText);
  const reportReferenceNumbers = numberedReferenceNumbers(reportText);

  if (!nonEmpty(reportText)) issues.push("clinical-evidence-report.md must contain academic analysis.");
  const title = typeof reportText === "string" ? reportText.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "" : "";
  if (!title) issues.push("The academic title must be present.");
  for (const section of [/(?:^|\n)##\s+(?:摘要|Abstract)/i, /(?:^|\n)##\s+.*(?:临床|证据|Evidence|Clinical)/i, /(?:^|\n)##\s+.*(?:局限|Limitations?)/i, /(?:^|\n)##\s+.*(?:结论|处置|Conclusion|Practical)/i]) {
    if (!section.test(reportText ?? "")) issues.push(`The academic report is missing a required section matching ${section}.`);
  }
  if (deepResearch) {
    for (const section of [
      /(?:^|\n)##\s+.*(?:检索|方法|Methods?)/i,
      /(?:^|\n)##\s+.*(?:结果|Results?)/i,
      /(?:^|\n)##\s+.*(?:讨论|Discussion)/i,
    ]) {
      if (!section.test(reportText ?? "")) {
        issues.push(`The deep-research report is missing a required academic section matching ${section}.`);
      }
    }
    const practicalHeading = String(reportText ?? "").search(practicalHeadingLinePattern);
    const referencesHeading = String(reportText ?? "").search(/(?:^|\n)##\s+[^\n]*(?:参考文献|参考来源|References?)[^\n]*$/im);
    if (practicalHeading < 0) {
      issues.push("The deep-research report must contain a dedicated safety-first practical-answer section.");
    }
    if (referencesHeading < 0 || (practicalHeading >= 0 && referencesHeading < practicalHeading)) {
      issues.push("The numbered reference list must follow the safety-first practical-answer section.");
    }
    if (visibleClaimMarkerPattern.test(reportText ?? "")) {
      issues.push("Deep-research reports must hide internal claim IDs in HTML comments and show standard numbered citations to readers.");
    }
    visibleClaimMarkerPattern.lastIndex = 0;
  }
  if (operationalFailurePattern.test(reportText ?? "")) {
    issues.push("The academic report contains operational failure prose that belongs only in the run receipt.");
  }
  const leakageLine = firstMatchingLine(reportText, runtimeLeakagePattern)
    ?? firstMatchingLine(withoutReportSections(reportText, "局限|Limitations?"), evidenceAccessLimitationPattern);
  if (leakageLine) {
    issues.push(
      "The academic report contains runtime or retrieval-process prose instead of scientific analysis: "
      + `line ${leakageLine.line} reads ${leakageLine.text}. `
      + "Write what the evidence shows, not how it was obtained — the run's tools, gateways, preserved artifacts (工件), "
      + "access levels (访问层级), environment (本环境), and retrieval passes (本轮检索) belong in the run receipt. "
      + "A source you could not obtain is stated as a limitation of the evidence base inside 局限性, in the reader's terms.",
    );
  }
  issues.push(...manuscriptRegisterIssues(reportText));
  if (/\[claim:CLM-[0-9]{3,6}[^\]]+\]/.test(reportText ?? "")) {
    issues.push("Each claim marker must contain exactly one claim ID.");
  }
  if (/https:\/\/www\.evimed\.com\/api-evimed\//i.test(reportText ?? "")) {
    issues.push("EviMed API endpoints cannot be used as public evidence citations.");
  }
  if (exclusiveSafetyPattern.test(reportText ?? "")) {
    issues.push("The report must not turn a bounded recommendation into an unsupported exclusive safety claim.");
  }

  if (!claims.length) issues.push("The evidence matrix must contain the report's material claims.");
  const seen = new Set();
  const derivedClaims = [];
  for (const [index, value] of claims.entries()) {
    const label = `claims[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push(`${label} must be an object.`);
      continue;
    }
    const claimType = value.claimType ?? "direct";
    if (!claimTypes.has(claimType)) {
      issues.push(`${label}.claimType must be "direct" or "synthesized" when present.`);
      continue;
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
      validateSynthesizedClaim(value, {
        label,
        deepResearch,
        reportReferenceNumbers,
        successfulArtifacts,
        artifactText,
        sourceDomains,
        issues,
      });
      continue;
    }
    if (claimType === "derived") {
      // Grounding is checked after the loop, once every claimId is known.
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
      continue;
    }
    if (!accessLevels.has(value.accessLevel)) {
      issues.push(`${label}.accessLevel is ${JSON.stringify(value.accessLevel)}; use exactly one of ${[...accessLevels].join(", ")} to record how much of the preserved artifact you read.`);
    }
    if (deepResearch && (!Number.isInteger(value.referenceNumber) || !reportReferenceNumbers.has(value.referenceNumber))) {
      issues.push(`${label}.referenceNumber must resolve to a numbered report reference.`);
    }
    if (!validSupportingPassage(value.supportQuote)) issues.push(`${label}.supportQuote must contain a direct supporting passage.`);
    if (emergencyCallClaimPattern.test(value.claim ?? "")
      && !emergencyCallSupportPattern.test(value.supportQuote ?? "")) {
      issues.push(`${label}.emergency-call action is not present in its direct support.`);
    }
    // Support counts under either reading, as the report-line audit already
    // does: the two extractors split ranges differently, so a quote saying
    // "98.5–99.7%" offers the atomic range under one and the endpoints under
    // the other. Narrow what is demanded, never what is accepted as support.
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
    if (!validSourceArtifactPath(value.artifactPath)) {
      issues.push(`${label}.artifactPath is ${JSON.stringify(value.artifactPath)}, which is not a preserved artifact. Preserve the source first — evimed_open_access_full_text by DOI/PMCID, or evimed_official_page_fetch by URL — and cite the .evimed-sources path it returns. If neither can preserve it, cite a source you did preserve instead.`);
    } else if (!successfulArtifacts.has(value.artifactPath)) {
      issues.push(`${label}.artifactPath is not listed as a successful source artifact for this run.`);
    } else {
      if (!quoteIsPresent(artifactText.get(value.artifactPath), value.supportQuote)) {
        issues.push(`${label}.supportQuote ${quoteFailure(artifactText.get(value.artifactPath), value.supportQuote)}.`);
      }
    }
    const domain = sourceDomain(value.sourceUrl);
    if (!domain) issues.push(`${label}.sourceUrl must be a valid credential-free HTTPS URL.`);
    else {
      sourceDomains.add(domain);
      if (domain === "www.evimed.com" && value.sourceUrl.includes("/api-evimed/")) {
        issues.push(`${label}.sourceUrl is an internal API route, not a public evidence citation.`);
      }
    }
  }
  const reportClaims = reportClaimIds(reportText);
  const reportSet = new Set(reportClaims);
  for (const claimId of reportSet) {
    if (!seen.has(claimId)) issues.push(`Report claim reference ${claimId} does not resolve to the evidence matrix.`);
  }
  for (const claimId of seen) {
    if (!reportSet.has(claimId)) issues.push(`Evidence matrix claim ${claimId} is not cited by the report.`);
  }

  const claimsById = new Map(claims.map((claim) => [claim?.claimId, claim]));

  // A derived result is only as good as what it stands on. Every input must
  // resolve, and following the inputs must reach measured evidence: a chain of
  // derivations resting on nothing is the fabrication this whole gate exists to
  // stop, wearing the vocabulary of analysis.
  for (const { label, claim } of derivedClaims) {
    const inputs = Array.isArray(claim?.derivedFrom) ? claim.derivedFrom : [];
    const unresolved = inputs.filter((id) => !claimsById.has(id));
    if (unresolved.length) {
      issues.push(`${label}.derivedFrom names ${unresolved.join(", ")}, which ${unresolved.length > 1 ? "are" : "is"} not in the evidence matrix.`);
      continue;
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
    if (!reachesEvidence) {
      issues.push(`${label} is derived only from other derived claims; a derivation must reach measured evidence.`);
    }
  }

  // Marked wherever it is asserted, so a reader meets the estimate as an
  // estimate. The claim marker alone is invisible in rendered prose.
  const derivedIds = new Set(derivedClaims.map(({ claim }) => claim?.claimId));
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
    if (!referencedIds.length) {
      issues.push(
        `Report line ${lineIndex + 1} numeric facts ${[...reportNumbers].join(", ")} have no evidence-matrix claim reference. Attach the numbered citation and claim marker that carry them.`,
      );
      continue;
    }
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

  // Pseudonyms are assigned by the analysis; record numbers come from the data
  // and must not leave it. Blocking, because a reader cannot tell P90000001
  // from a pseudonym, and the person it exposes is not the reader.
  const leakedInReport = recordIdentifiersInReport(reportText);
  const leakedInMatrix = recordIdentifiersInReport(JSON.stringify(matrix ?? {}));
  const leaked = [...new Set([...leakedInReport, ...leakedInMatrix])].sort();
  if (leaked.length) {
    issues.push(
      `The deliverables carry subject labels containing record numbers (${leaked.slice(0, 6).join(", ")}${leaked.length > 6 ? `, +${leaked.length - 6}` : ""}). Assign your own sequential pseudonyms and never reproduce an identifier from the source data.`,
    );
  }

  const practical = reportSection(reportText, practicalSectionHeading);
  // The analysis may reason as far as the evidence allows. What a reader is
  // told to actually do may not rest on the analyst's own estimate: this
  // section is read as instruction, and an estimate read as instruction is the
  // one place a derivation could hurt someone.
  const derivedInPractical = [...new Set(reportClaimIds(practical).filter((id) => derivedIds.has(id)))];
  if (derivedInPractical.length) {
    issues.push(
      `The practical section cites derived result ${derivedInPractical.join(", ")}; practical advice must rest on measured evidence. Move the reasoning to the analysis and give the action a directly supported claim.`,
    );
  }
  for (const message of evaluateClinicalSafetyRules({ reportText, practical, question: runReceipt?.question })) {
    issues.push(message);
  }
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

  if (deepResearch) {
    const searchLog = parseJsonObject(searchLogText);
    const queries = Array.isArray(searchLog?.queries) ? searchLog.queries : [];
    const sourceRecords = Array.isArray(searchLog?.sourceRecords) ? searchLog.sourceRecords : [];
    const normalizedQueryEntries = queries.map((entry) => ({
      database: typeof entry?.database === "string" ? entry.database.trim().toLowerCase() : "",
      query: normalizedSearchQuery(entry?.query),
    }));
    const normalizedQueries = new Set(
      normalizedQueryEntries.map((entry) => entry.query).filter(Boolean),
    );
    const searchedDatabases = new Set(
      normalizedQueryEntries.map((entry) => entry.database).filter(Boolean),
    );
    const documentedSearches = new Set(
      normalizedQueryEntries
        .filter((entry) => entry.database && entry.query)
        .map((entry) => `${entry.database}\u0000${entry.query}`),
    );
    const includedRecords = sourceRecords.filter((entry) => entry?.included === true);
    const inspectedRecords = includedRecords.filter((entry) => (
      ["full_text", "abstract", "official_page", "structured_record"].includes(entry?.accessLevel)
      && entry.accessLevel !== "bibliographic_only"
    ));
    const screening = searchLog?.screening;

    if (searchLog?.schemaVersion !== 1) {
      issues.push("clinical-evidence-search.json must use schemaVersion 1.");
    }
    if (!queries.length || documentedSearches.size !== queries.length) {
      issues.push("The search log must contain completed, non-empty, non-duplicate search queries.");
    }
    if (Array.isArray(executedSearchQueries)) {
      const executed = new Set(
        executedSearchQueries
          .map((value) => normalizedSearchQuery(value))
          .filter(Boolean),
      );
      const undocumented = [...normalizedQueries].filter((query) => !executed.has(query));
      const unlogged = [...executed].filter((query) => !normalizedQueries.has(query));
      if (undocumented.length || unlogged.length) {
        // The run already knows which searches succeeded, so telling the agent
        // only that the log "must match" leaves it to guess which of eighteen
        // entries is wrong. Name them.
        const detail = [
          unlogged.length ? `missing from the log: ${unlogged.slice(0, 4).map((q) => `"${q.slice(0, 60)}"`).join(", ")}` : "",
          undocumented.length ? `logged but never executed: ${undocumented.slice(0, 4).map((q) => `"${q.slice(0, 60)}"`).join(", ")}` : "",
        ].filter(Boolean).join("; ");
        issues.push(`The search log must exactly match successful evidence-search calls from the same run — ${detail}.`);
      }
    }
    if (searchedDatabases.size < 2) {
      issues.push("Deep research must search at least two distinct evidence databases or source classes.");
    }
    if (
      !screening
      || !Number.isInteger(screening.recordsIdentified)
      || screening.recordsIdentified < 1
      || !Number.isInteger(screening.recordsAfterDeduplication)
      || screening.recordsAfterDeduplication < 1
      || screening.recordsAfterDeduplication > screening.recordsIdentified
      || !Number.isInteger(screening.sourcesIncluded)
      || screening.sourcesIncluded < 1
      || screening.sourcesIncluded > screening.recordsAfterDeduplication
      || screening.sourcesIncluded !== includedRecords.length
    ) {
      issues.push("The search log must preserve a coherent, internally consistent screening flow.");
    }
    if (inspectedRecords.length !== includedRecords.length) {
      // Name the record. A title-only source carried into the included set is a
      // specific reference the agent can drop or go and read, not a property of
      // the log as a whole.
      const uninspected = includedRecords
        .filter((entry) => !inspectedRecords.includes(entry))
        .map((entry) => `[${entry?.referenceNumber ?? "?"}] ${entry?.accessLevel ?? "no access level"}`)
        .slice(0, 5);
      issues.push(
        `Every included source record must have an inspected evidence access level; ${uninspected.join(", ")} `
        + "was carried into the included set without one. Read it, or exclude it — a title-only record supports nothing.",
      );
    }
    const stats = runReceipt?.stats;
    if (
      !stats
      || !Number.isInteger(stats.totalSearches)
      || stats.totalSearches !== queries.length
      || !Number.isInteger(stats.recordsIdentified)
      || stats.recordsIdentified !== screening?.recordsIdentified
      || !Number.isInteger(stats.recordsAfterDeduplication)
      || stats.recordsAfterDeduplication !== screening?.recordsAfterDeduplication
      || !Number.isInteger(stats.sourcesIncluded)
      || stats.sourcesIncluded !== screening?.sourcesIncluded
      || !Number.isInteger(stats.distinctPreservedSources)
      || stats.distinctPreservedSources !== distinctSuccessfulSources.size
    ) {
      issues.push("The run-receipt statistics must exactly match the search log and distinct preserved-source count.");
    }
    // Padding stays a finding, but its own: the de-duplicated count used to be
    // the denominator for resolution, so listing one source twice silently made
    // the last reference "not resolve". Say what is actually true instead.
    if (reportReferenceNumbers.size > reportReferenceCount) {
      issues.push(
        `The numbered reference list gives ${reportReferenceNumbers.size} entries for ${reportReferenceCount} distinct sources; the same source is listed under more than one number.`,
      );
    }
    const unresolved = [...new Set(claims
      .map((claim) => claim?.referenceNumber)
      .filter((number) => Number.isInteger(number) && !reportReferenceNumbers.has(number)))].sort((a, b) => a - b);
    if (unresolved.length) {
      issues.push(`The numbered reference list has no entry for reference ${unresolved.join(", ")}.`);
    }
    // references.bib: a real cross-check — it must actually contain every cited
    // source, not merely enough @entries to hit a count.
    const bibText = String(referencesText ?? "");
    if (bibliographyEntryCount(bibText) < reportReferenceCount) {
      issues.push("references.bib must contain a bibliography entry for every numbered report reference.");
    }
    const citedSourceUrls = [...new Set(claims.flatMap((claim) => (
      claim?.claimType === "synthesized" && Array.isArray(claim?.supportingSources)
        ? claim.supportingSources.map((source) => source?.sourceUrl)
        : [claim?.sourceUrl]
    )).filter((url) => typeof url === "string" && url))];
    // Exact URL membership, not substring — otherwise .../source-1 would falsely
    // match inside .../source-10.
    const bibUrls = new Set([...bibText.matchAll(/https?:\/\/[^\s{}<>"'`)\]]+/g)].map((match) => match[0]));
    if (citedSourceUrls.some((url) => !bibUrls.has(url))) {
      issues.push("references.bib must contain a bibliography entry for every cited source URL.");
    }
    // citation-ledger.csv: a real cross-check — every matrix claim appears exactly
    // once and each row's reference number matches the claim it names.
    //
    // Matched by column name, in any order. The header used to be positional —
    // exactly claimId, referenceNumber, supportQuote in the first three columns
    // — which no instruction stated and the preflight the agent is told to run
    // until it passes never checked. Four consecutive production runs failed it;
    // one rewrote its header three times, got the first two columns right, and
    // could not guess that the third had to be the quote. A schema that is
    // enforced but never written down is not a schema the run can satisfy, and
    // column order carries no meaning here anyway.
    // The ledger maps cited claims to the sources that carry them. A derived
    // result cites no source of its own, so it is not a row here; its inputs
    // are, and they are what a reader traces.
    const citedClaims = claims.filter((claim) => (claim?.claimType ?? "direct") !== "derived");
    const ledgerRecords = parseCsvRecords(citationLedgerText);
    const ledgerHeader = (ledgerRecords[0] ?? []).map((cell) => cell.trim().toLowerCase().replace(/[_\s]/g, ""));
    const claimIdColumn = ledgerHeader.indexOf("claimid");
    const referenceColumn = ledgerHeader.indexOf("referencenumber");
    // A run that records the quote as supportQuoteVerified has recorded the
    // quote; the prefix is the requirement.
    const quoteColumn = ledgerHeader.findIndex((name) => name.startsWith("supportquote"));
    if (claimIdColumn < 0 || referenceColumn < 0 || quoteColumn < 0 || ledgerRecords.length < citedClaims.length + 1) {
      issues.push(
        "citation-ledger.csv must have a header naming claimId, referenceNumber and supportQuote columns (any order, extra columns allowed) and one row per evidence-matrix claim.",
      );
    } else {
      const ledgerRef = new Map();
      for (const row of ledgerRecords.slice(1)) {
        const claimId = String(row[claimIdColumn] ?? "").trim();
        if (claimId) ledgerRef.set(claimId, String(row[referenceColumn] ?? "").trim());
      }
      const matrixIds = new Set(citedClaims.map((claim) => claim?.claimId));
      const ledgerMismatch = ledgerRef.size !== matrixIds.size
        || [...matrixIds].some((id) => !ledgerRef.has(id))
        || citedClaims.some((claim) => ledgerRef.get(claim?.claimId) !== String(claim?.referenceNumber));
      if (ledgerMismatch) {
        issues.push("citation-ledger.csv rows must match each evidence-matrix claim's id and reference number.");
      }
    }
    // citation-audit.md: keep the required-dimension check, and make it real by
    // requiring the audit to name at least one source identifier it actually
    // examined, so it cannot pass as run-independent boilerplate.
    if (
      !nonEmpty(citationAuditText)
      || !/(?:unresolved|未解析)/i.test(citationAuditText)
      || !/(?:duplicate|重复)/i.test(citationAuditText)
      || !/(?:retract|撤稿|更正|correction)/i.test(citationAuditText)
      || !/(?:metadata|元数据)/i.test(citationAuditText)
      || !/(?:claim mismatch|claim-source|claims?.{0,60}(?:verified|checked|audited)|主张不匹配|引文不匹配|主张.{0,20}(?:核对|验证|审计)|逐条.{0,20}(?:核对|验证|审计))/i.test(citationAuditText)
    ) {
      issues.push("citation-audit.md must document unresolved, duplicate, correction/retraction, metadata-only, and claim-mismatch checks.");
    }
    const auditIdentifiers = claims.flatMap((claim) => (
      claim?.claimType === "synthesized" && Array.isArray(claim?.supportingSources)
        ? claim.supportingSources.map((source) => source?.identifier)
        : [claim?.identifier]
    )).filter((id) => typeof id === "string" && id.trim());
    if (nonEmpty(citationAuditText) && auditIdentifiers.length && !auditIdentifiers.some((id) => String(citationAuditText).includes(id))) {
      issues.push("citation-audit.md must reference at least one real audited source identifier from the evidence matrix.");
    }
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
  }

  if (!runReceipt || typeof runReceipt !== "object" || Array.isArray(runReceipt)) {
    issues.push("clinical-evidence-run.json must be an object.");
  } else {
    if (runReceipt.status !== "succeeded") issues.push("The clinical evidence run receipt is not succeeded.");
    if (!Array.isArray(runReceipt.successfulSourceArtifacts)) {
      issues.push("The run receipt must name the distinct successful source artifacts.");
    } else {
      if (runReceipt.successfulSourceArtifacts.some((value) => !validSourceArtifactPath(value))) {
        issues.push("Every successful source artifact must be a safe .evimed-sources workspace path.");
      }
      if (!distinctSuccessfulSources.size) {
        issues.push("The run receipt must name the distinct successful source artifacts.");
      }
    }
    if (deepResearch && successfulArtifacts.size !== distinctSuccessfulSources.size) {
      issues.push("Deep-research source counts must use one canonical text artifact per distinct document; companion XML and Markdown files cannot be counted twice.");
    }
    const checks = runReceipt.qualityChecks;
    if (!checks || typeof checks !== "object" || Array.isArray(checks) || !Object.values(checks).length || Object.values(checks).some((value) => value !== true)) {
      issues.push("All declared run-receipt quality checks must pass.");
    }
  }

  return Object.freeze({
    valid: issues.length === 0,
    issues: Object.freeze(issues),
    blockingIssues: Object.freeze(issues.filter((issue) => !degradableIssue(issue))),
    claimIds: Object.freeze(claimIds),
    sourceDomains: Object.freeze([...sourceDomains].sort()),
  });
}
