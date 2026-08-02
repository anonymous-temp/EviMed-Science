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
const claimTypes = new Set(["direct", "synthesized"]);
const synthesizedConfidenceLevels = new Set(["high", "moderate", "low"]);
const synthesizedBaseFields = Object.freeze(["claimId", "claim", "applicability", "uncertainty"]);
const synthesizedSourceFields = Object.freeze(["sourceUrl", "sourceTitle", "artifactPath", "accessLevel", "supportQuote"]);
const sourceCountWordPattern = /(?:研究|试验|项|篇|文献|stud(?:y|ies)|trials?|sources?|records?)/i;
const claimIdPattern = /^CLM-[0-9]{3,6}$/;
const operationalFailurePattern = /(?:Transport error|Runtime configuration bootstrap|网页访问失败|工具调用失败|public[_ -]source[_ -]gateway.*(?:failed|error))/i;
// Runtime/retrieval-process leakage — banned anywhere in the report. Tool and
// gateway names, artifact paths, and first-person retrieval diaries are never
// scientific analysis.
const runtimeLeakagePattern = /(?:clinical-evidence-synthesis|\bevimed_[a-z_]+\b|EviMed.{0,24}(?:引擎|网关|工具)|证据追溯契约|\.evimed-sources\/|(?:抓取|落盘).{0,16}(?:核验|来源|文件|原文)|白名单抓取|工具调用|(?:未触及|未读取|未检索).{0,16}(?:完整|全文|文件|页面))/i;
// A material limit on evidence accessibility (e.g. a guideline whose full text
// is not openly available) is a legitimate property of the evidence base. It is
// banned in the analysis body but permitted inside the Limitations section.
const evidenceAccessLimitationPattern = /(?:全文|页面|文件).{0,12}(?:不可及|无法获取|无法获得|未能获取|未能获得|不可得)/i;
const emergencyCallClaimPattern = /(?:(?:呼叫|拨打).{0,16}(?:急救|120|999)|(?:急救|120|999).{0,16}(?:呼叫|拨打))/i;
const emergencyCallSupportPattern = /(?:call.{0,16}(?:999|emergency|ambulance)|(?:999|emergency|ambulance).{0,16}call|呼叫|拨打|急救)/i;
// Generic (non-drug-specific) safety rule. Drug- and scenario-specific rules
// live in clinical-safety-rules.json so pharmacists can maintain them as data.
const exclusiveSafetyPattern = /(?:唯一.{0,24}(?:安全|可靠|正确|一致|策略|方法|途径)|(?:安全|可靠|正确).{0,24}唯一)/i;
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
  "citation-ledger.csv must contain a traceability header and one row per evidence-matrix claim.",
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

function sourceDomain(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
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
    .replace(/[­​‌‍﻿]/g, "")
    .replace(/[‘’“”"'＂＇]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    // PDF extraction routinely spaces out CJK runs ("速 效 救 心 丸"). The
    // spacing is an artefact of the extractor, not of the source, so it must
    // not decide whether a quote is found.
    .replace(/(?<=[　-〿一-鿿＀-￯])\s+(?=[　-〿一-鿿＀-￯])/g, "")
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
  const source = String(text ?? "");
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

function reportSection(reportText, headingPattern) {
  const match = String(reportText ?? "").match(
    new RegExp(`(?:^|\\n)##\\s+[^\\n]*(?:${headingPattern})[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i"),
  );
  return match?.[1] ?? "";
}

function withoutReportSections(reportText, headingPattern) {
  return String(reportText ?? "").replace(
    new RegExp(`(?:^|\\n)##\\s+[^\\n]*(?:${headingPattern})[^\\n]*\\n[\\s\\S]*?(?=\\n##\\s+|$)`, "gi"),
    "\n",
  );
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
  { label, deepResearch, reportReferenceCount, successfulArtifacts, artifactText, sourceDomains, issues },
) {
  if (!synthesizedConfidenceLevels.has(value.confidence)) {
    issues.push(`${label}.confidence must be one of high, moderate, low for a synthesized claim.`);
  }
  if (deepResearch) {
    if (
      !Number.isInteger(value.referenceNumber)
      || value.referenceNumber < 1
      || value.referenceNumber > reportReferenceCount
    ) {
      issues.push(`${label}.referenceNumber must resolve to a numbered report reference.`);
    }
    const referenceNumbers = Array.isArray(value.referenceNumbers) ? value.referenceNumbers : [];
    if (
      referenceNumbers.length < 2
      || referenceNumbers.some((entry) => !Number.isInteger(entry) || entry < 1 || entry > reportReferenceCount)
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
          issues.push(`${sourceLabel}.supportQuote was not found in its preserved source artifact.`);
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
    const practicalHeading = String(reportText ?? "").search(/(?:^|\n)##\s+[^\n]*(?:安全优先的实际处置|实际处置|实用回答|Practical)[^\n]*$/im);
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
  if (
    runtimeLeakagePattern.test(reportText ?? "")
    || evidenceAccessLimitationPattern.test(withoutReportSections(reportText, "局限|Limitations?"))
  ) {
    issues.push("The academic report contains runtime or retrieval-process prose instead of scientific analysis.");
  }
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
    for (const field of claimType === "synthesized" ? synthesizedBaseFields : claimFields) {
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
        reportReferenceCount,
        successfulArtifacts,
        artifactText,
        sourceDomains,
        issues,
      });
      continue;
    }
    if (!accessLevels.has(value.accessLevel)) {
      issues.push(`${label}.accessLevel is ${JSON.stringify(value.accessLevel)}; use exactly one of ${[...accessLevels].join(", ")} to record how much of the preserved artifact you read.`);
    }
    if (
      deepResearch
      && (
        !Number.isInteger(value.referenceNumber)
        || value.referenceNumber < 1
        || value.referenceNumber > reportReferenceCount
      )
    ) {
      issues.push(`${label}.referenceNumber must resolve to a numbered report reference.`);
    }
    if (!validSupportingPassage(value.supportQuote)) issues.push(`${label}.supportQuote must contain a direct supporting passage.`);
    if (emergencyCallClaimPattern.test(value.claim ?? "")
      && !emergencyCallSupportPattern.test(value.supportQuote ?? "")) {
      issues.push(`${label}.emergency-call action is not present in its direct support.`);
    }
    const directSupportNumbers = new Set(numericTokens([
      value.supportQuote,
      value.sourceTitle,
      value.identifier,
    ].join(" ")));
    for (const token of new Set(numericTokens(value.claim))) {
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
        issues.push(`${label}.supportQuote was not found in its preserved source artifact.`);
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

  const practical = reportSection(reportText, "实际处置|实用|怎么办|Practical");
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
    const largestReferenceNumber = claims.reduce(
      (maximum, claim) => Number.isInteger(claim?.referenceNumber)
        ? Math.max(maximum, claim.referenceNumber)
        : maximum,
      0,
    );
    if (reportReferenceCount < largestReferenceNumber) {
      issues.push("The numbered reference list must resolve every evidence-matrix reference.");
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
    const ledgerLines = String(citationLedgerText).trim().split(/\r?\n/).filter(Boolean);
    if (
      ledgerLines.length < claims.length + 1
      // Positional header: the first three columns must be exactly claimId,
      // referenceNumber, supportQuote — matching how each row is parsed below.
      || !/^\s*"?(?:claimId|claim_id)"?\s*,\s*"?(?:referenceNumber|reference_number)"?\s*,\s*"?(?:supportQuote|support_quote)"?/i.test(ledgerLines[0] ?? "")
    ) {
      issues.push("citation-ledger.csv must contain a traceability header and one row per evidence-matrix claim.");
    } else {
      const ledgerRef = new Map();
      for (const line of ledgerLines.slice(1)) {
        const match = line.match(/^\s*"?([^",]+)"?\s*,\s*"?([^",]+)"?\s*,/);
        if (match) ledgerRef.set(match[1].trim(), match[2].trim());
      }
      const matrixIds = new Set(claims.map((claim) => claim?.claimId));
      const ledgerMismatch = ledgerRef.size !== matrixIds.size
        || [...matrixIds].some((id) => !ledgerRef.has(id))
        || claims.some((claim) => ledgerRef.get(claim?.claimId) !== String(claim?.referenceNumber));
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
