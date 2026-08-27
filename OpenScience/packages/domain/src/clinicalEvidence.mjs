// The pharmacist-editable safety rules travel with this module as data, not as
// a path: `@evimed/domain` must stay importable from a browser bundle and from
// a plugin sandbox, so it may not reach for `node:fs` (§14 rule 3). The import
// attribute is the ESM way to say "this file is data", and it keeps the rules
// exactly one file rather than one file plus a loader.
import clinicalSafetyRulesData from "./clinical-safety-rules.json" with { type: "json" };

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
const exclusiveSafetyPattern = /(?:唯一.{0,24}(?:安全|可靠|正确|一致|策略|方法|途径)|(?:安全|可靠|正确).{0,24}唯一)/i;
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

// --- Screening numbers and the source set are rendered, never restated -----
// clinical-evidence-search.json is checked against itself and against the run
// receipt — two machine-written files — and never against the two things a
// reader actually sees: the sentence stating the flow, and the numbered
// reference list. One delivered report wrote 191/116/25 while its own log said
// 203/125/24 and its own citation audit said 24; every existing check passed,
// because nobody read the prose. Six others kept a record at included:false
// while numbering it in 参考文献 and citing it in the body, which
// sourcesIncluded === includedRecords.length still satisfies.
//
// A flow term is a run-flow number only when the clause anchors it: two or more
// flow terms together, or a term carrying its noun (记录/题录/文献, 来源), or a
// verb with no per-study reading (完成 N 次检索, 去重后 N 条). Without that,
// 「注册临床试验命中 0 条」 (a per-query hit count) and 「纳入 46 篇系统评价」 (a
// cited review's own count) are read as the run's screening totals.
/** @typedef {'totalSearches'|'recordsIdentified'|'recordsAfterDeduplication'|'sourcesIncluded'} ScreeningFlowKey */

/** @type {readonly { key: ScreeningFlowKey, anchored: boolean, pattern: RegExp }[]} */
const screeningFlowPatterns = Object.freeze([
  { key: "totalSearches", anchored: true, pattern: /(?:共|合计|总计)?\s*(?:完成|执行|进行)\s*(?<n>\d+)\s*(?:次|条|组)\s*(?<noun>检索式?|查询)/g },
  { key: "recordsIdentified", anchored: false, pattern: /(?:命中|获得|检出|检索到|识别)\s*(?<n>\d+)\s*条\s*(?<noun>记录|题录|文献)?/g },
  { key: "recordsAfterDeduplication", anchored: true, pattern: /去重(?:[^，。；\n]{0,14})?后(?:余|剩余|保留|得到)?\s*(?<n>\d+)\s*(?<noun>条|篇|个)/g },
  { key: "sourcesIncluded", anchored: false, pattern: /纳入\s*(?<n>\d+)\s*(?:条|个|篇|份)\s*(?<noun>来源|证据来源)?/g },
]);
/** @type {Readonly<Record<ScreeningFlowKey, string>>} */
const screeningFlowNames = Object.freeze({
  totalSearches: "检索式条数",
  recordsIdentified: "命中记录数",
  recordsAfterDeduplication: "去重后记录数",
  sourcesIncluded: "纳入来源数",
});

/** A stated flow quantity that disagrees with the ledger, and the source set
 *  the numbered reference list does not match.
 *  @param {any} reportText @param {any} searchLog
 *  @returns {({ leg: 'A', key: ScreeningFlowKey, stated: number, held: number, clause: string }
 *    | { leg: 'B1', numbers: number[] }
 *    | { leg: 'B2', listed: number, included: number })[]}
 *
 *  A discriminated union rather than one shape with eight optional fields: the
 *  consumer already branches on `leg`, and with optionals that branch narrowed
 *  nothing, so every read of `finding.key` was a possibly-undefined the code
 *  then had to pretend about.
 */
function screeningLedgerFindings(reportText, searchLog) {
  const text = String(reportText ?? "");
  const headings = [...text.matchAll(/(?:^|\n)##\s+[^\n]*(?:参考文献|参考来源|References?)[^\n]*/gi)];
  // Bound once: `headings.length` does not narrow `headings.at(-1)`, and a
  // match's own `index` is optional in the type even though the engine always
  // sets it.
  const lastHeading = headings.at(-1);
  const referencesStart = lastHeading?.index ?? text.length;
  const body = text.slice(0, referencesStart);
  // From just past the heading line to the next level-two heading: the entries
  // themselves, never the heading and never whatever follows the list.
  const referenceBlock = lastHeading
    ? text.slice(referencesStart + lastHeading[0].length).split(/\n##\s+/)[0]
    : "";
  /** @type {Record<ScreeningFlowKey, number | null>} */
  const held = {
    totalSearches: Array.isArray(searchLog?.queries) ? searchLog.queries.length : null,
    recordsIdentified: Number.isInteger(searchLog?.screening?.recordsIdentified) ? searchLog.screening.recordsIdentified : null,
    recordsAfterDeduplication: Number.isInteger(searchLog?.screening?.recordsAfterDeduplication) ? searchLog.screening.recordsAfterDeduplication : null,
    sourcesIncluded: Number.isInteger(searchLog?.screening?.sourcesIncluded) ? searchLog.screening.sourcesIncluded : null,
  };
  /** @type {ReturnType<typeof screeningLedgerFindings>} */
  const findings = [];
  for (const clause of proseWithoutCode(body).split(/[。；;!?\n]/)) {
    /** @type {{ key: ScreeningFlowKey, value: number, anchored: boolean }[]} */
    const matches = [];
    for (const { key, anchored, pattern } of screeningFlowPatterns) {
      for (const match of clause.matchAll(pattern)) {
        matches.push({ key, value: Number(match.groups?.n), anchored: anchored || Boolean(match.groups?.noun) });
      }
    }
    if (matches.length < 2 && !matches.some((match) => match.anchored)) continue;
    for (const match of matches) {
      if (held[match.key] == null || held[match.key] === match.value) continue;
      // Only the disagreeing quantity is named: a report whose other three
      // numbers are right must not be sent back to rewrite a correct sentence.
      // The `== null` guard on the line above is what rules out null here;
      // TypeScript does not carry that narrowing across the `continue`.
      findings.push({ leg: "A", key: match.key, stated: match.value, held: /** @type {number} */ (held[match.key]), clause: excerpt(clause) });
    }
  }
  const includedRefs = new Set();
  for (const record of Array.isArray(searchLog?.sourceRecords) ? searchLog.sourceRecords : []) {
    if (record?.included === true && Number.isInteger(record?.referenceNumber)) includedRefs.add(record.referenceNumber);
  }
  const listed = new Set();
  for (const line of referenceBlock.split("\n")) {
    const match = /^\s*(\d+)[.、]\s+\S/.exec(line);
    if (match) listed.add(Number(match[1]));
  }
  if (!listed.size || !includedRefs.size) return findings;
  const cited = new Set();
  for (const line of proseWithoutCode(body).split("\n")) {
    for (const number of closureCitationNumbers(line)) cited.add(number);
  }
  const uncovered = [...new Set([...listed, ...cited])].filter((number) => !includedRefs.has(number)).sort((a, b) => a - b);
  if (uncovered.length) findings.push({ leg: "B1", numbers: uncovered });
  // The raw listed set, not the de-duplicated count: padding is already its own
  // finding, and de-duplicating here would let a padded list satisfy both.
  if (held.sourcesIncluded != null && listed.size !== held.sourcesIncluded) {
    findings.push({ leg: "B2", listed: listed.size, included: held.sourcesIncluded });
  }
  return findings;
}

// --- Reference-table closure: nothing floats, no number is an orphan -------
// citationIntegrityIssues() already computes the orphan and dangling
// directions, and it is dead code for this product line: it runs only when an
// agent lists citationIntegrity in completionChecks, and the
// clinical-evidence-synthesis agent lists requiredOutputsExist /
// citationsResolvable / evidenceClaimsTraceable / skillsLoaded. The gate itself
// checks only matrix→reference and duplicate padding, and preflight compared
// counts, which rewards padding. These clauses close the loop in both
// directions and hold the excluded set to its own bookkeeping.
const citationNumberListPattern = /\[(\d{1,3}(?:\s*[,，、\-–—]\s*\d{1,3})*)\]/g;
const bareCitationNumberList = /^\s*\d{1,3}(?:\s*[,，、\-–—]\s*\d{1,3})*\s*$/;
const bracketSpanPattern = /\[([^[\]\n]{1,200})\]/g;
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
 *  citations, per-line anchor/number pairing, and the excluded set's own
 *  bookkeeping.
 *  @param {any} reportText @param {Map<any, any>} claimsById @param {any} searchLog
 *  @returns {({ clause: 'A', number: number, body: string }
 *    | { clause: 'B', number: number }
 *    | { clause: 'C', line: number, bracket: string }
 *    | { clause: 'D', line: number, claimId: string, cited: number[], allowed: number[] }
 *    | { clause: 'E1', index: number }
 *    | { clause: 'E2', index: number, number: number })[]}
 *
 *  A discriminated union, for the reason the screening findings are one: the
 *  consumer branches on `clause`, and with every field optional that branch
 *  narrowed nothing.
 */
function citationClosureFindings(reportText, claimsById, searchLog) {
  const text = String(reportText ?? "");
  // The LAST reference heading, as preflight already does: reportSection uses
  // the first, and a report naming its reference list twice would be cut in
  // the wrong place.
  const headings = [...text.matchAll(/(?:^|\n)##\s+[^\n]*(?:参考文献|参考来源|References?)[^\n]*/gi)];
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
  const sourceRecords = Array.isArray(searchLog?.sourceRecords) ? searchLog.sourceRecords : [];
  for (const [index, record] of sourceRecords.entries()) {
    if (record?.included === true) continue;
    if (typeof record?.exclusionReason !== "string" || !record.exclusionReason.trim()) {
      findings.push({ clause: "E1", index });
    }
    if (Number.isInteger(record?.referenceNumber) && entries.has(record.referenceNumber)) {
      findings.push({ clause: "E2", index, number: record.referenceNumber });
    }
  }
  return findings;
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
// the evidence matrix and in the citation ledger, where it is machine-checked
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
// --- Comparative structure -------------------------------------------------
// A comparison fails in ways no sentence-level rule can see, because the defect
// is the shape of the document. Two of those are decidable from the document
// alone; the rest — whether the arms were merged into one PICO, whether the
// axes are commensurable, whether a section outweighs its rank — need to know
// which nouns are the compared arms, which no pattern can read off the text.
// They are reported to the run as preflight advice instead.
//
// The first decidable one: the title announces a comparison and the body never
// puts the arms side by side. Reviewing arm A's literature, then arm B's, then
// closing with a shared verdict is not a comparison — the two accounts never
// meet, and the verdict is supplied by whichever arm had the thinner file. Only
// the absence of the matrix is asserted here: a table with an axis column and
// one column per arm. Nothing is claimed about its rows, since an axis's
// wording belongs to the domain.
//
// 对比剂 (contrast agent) is an ordinary pharmacology noun that contains 对比,
// so it is anchored away from it.
const comparativeTitlePattern = /比较|对比(?!剂)|优劣|孰优|头对头|head[-\s]?to[-\s]?head|versus|(?<![A-Za-z])vs\.?(?![A-Za-z])/i;
// The second: the report states that no direct comparison was found and then
// concludes that one arm may take the other's place. That is not a judgement
// about how strong evidence has to be — it is the report contradicting itself,
// and the licence a substitution claim needs is exactly the comparison the
// report has just said does not exist.
const directComparisonAbsentPattern = /(?:未检索到|未能检索到|未检索出|未发现|未找到|未见|尚未检索到|缺乏|缺少|尚无|没有|不存在)[^。；\n]{0,30}(?:头对头|直接比较|直接对比|head[-\s]?to[-\s]?head)|(?:头对头|直接比较|直接对比|head[-\s]?to[-\s]?head)[^。；\n]{0,30}(?:未检索到|未能检索到|缺乏|缺少|尚无|没有|不存在|空缺|阙如)/i;
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
  // A later line repeating a marker whose number it does not carry. Same
  // bookkeeping as the line above, one line further on — except inside the
  // practical section, where it carries a different prefix and blocks, because
  // that section is read as instruction.
  /^Report line \d+ anchors claim /,
  // The exclusion ledger inside clinical-evidence-search.json. This is the
  // search apparatus describing itself, not a claim about medicine, and it is
  // the same report-to-apparatus bookkeeping as the entries above. Blocking on
  // it also judged 22 delivered packages by a field the spec did not have when
  // they were written, which is a way of failing work for not predicting a
  // later rule.
  /^clinical-evidence-search\.json 的 sourceRecords\[\d+\] 标记为 "included": false/,
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
  { pattern: /^检索流程数与纳入来源集合由|^参考文献表共 \d+ 条编号条目/, code: "specialist_screening_ledger_mismatch" },
  // 资料与方法声明了… is degradable and never reaches this list.
  { pattern: /^GRADE 等级与降级理由不自洽/, code: "declared-appraisal-must-execute" },
  // The question-coverage ledger. Four codes, because the four defects are
  // repaired in four different places: the ledger's own shape, an entry that
  // points nowhere, a sentence that contradicts a registered gap, and a brief
  // question the ledger does not account for at all.
  { pattern: /^question-coverage\.json 台账格式无效|^工作区里的题面只读副本/, code: "specialist_question_coverage_invalid" },
  // An entry that does not transcribe the question its id names is a defect in
  // the ledger, not in the report the entry points at.
  { pattern: /^question-coverage\.json 条目 .*的 question 不是题面第 \d+ 问的原文/, code: "specialist_question_coverage_invalid" },
  // Anchored on this family's own sentence shape, not on the words 「登记为
  // gap」 anywhere in the message: another coverage notice whose *advice* said
  // to register something as a gap was classified as this defect.
  { pattern: /^question-coverage\.json 条目 [^\n]{0,120}）登记为 gap，/, code: "specialist_question_coverage_gap_overstated" },
  { pattern: /^question-coverage\.json 条目 /, code: "specialist_question_coverage_unsupported" },
  // Was 「摘要重述研究范围时把问题数…」, a comparison between two numbers the run
  // wrote itself. Same code, now earned by a comparison against the brief.
  { pattern: /^题面第 \d+ 问在 question-coverage\.json 中没有任何条目/, code: "specialist_question_coverage_understated" },
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
 */
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
      if (nonEmpty(question) && !rule.pattern.test(String(question)) && rule.pattern.test(report)) found.push(rule.message);
    } else if (rule.kind === "practical_required_when_report_matches") {
      // `triggerPattern` is required for this kind and checked at load.
      if (/** @type {RegExp} */ (rule.triggerPattern).test(report) && !rule.pattern.test(practicalText)) found.push(rule.message);
    }
  }
  return found;
}

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

/** @param {unknown} value @returns {boolean} */
function validSupportingPassage(value) {
  return normalizedPassage(value).replace(/\s+/g, "").length > 0;
}

// A search is identified by its terms. Retyping the same search into the log
// without its phrase quotes, or with different spacing, is a transcription
// difference — treating it as a search that never ran would accuse the agent of
// inventing provenance it did not invent. The terms themselves must still match.
/** @param {unknown} value @returns {string} */
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

/** @param {string} haystack @param {readonly string[]} segments @param {(segment: string) => string} project @returns {boolean} */
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
    if (segmentsPresentInOrder(passageSkeleton(text), segments, passageSkeleton)) return true;
  }
  return false;
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

/** @param {unknown} value @returns {number} */
function bibliographyEntryCount(value) {
  return [...String(value ?? "").matchAll(/^@[A-Za-z]+\s*\{/gm)].length;
}

const referenceEntryPattern = /^\s*(?:\[(\d{1,3})\]|(\d{1,3})[.、])\s+(\S.*)$/;

/** Every identifier an entry carries, normalised so the same work matches
 *  itself across schemes. A DOI, a PMID and a Europe PMC URL are three names
 *  for one article, and a bibliography that lists it under two of them is
 *  citing it twice.
 *  @param {string} text @returns {Set<string>} */
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

/** @param {string} value @returns {Record<string, any> | null} */
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
        + "A verbatim quote is a traceability device: it lives in the evidence matrix's supportQuote field and the citation ledger's supportQuote column, "
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

/** The cells of a markdown table row, or [] when the line is not one.
 *  @param {string} line
 */
function tableCells(line) {
  const text = String(line ?? "");
  if ((text.match(/\|/g)?.length ?? 0) < 2) return [];
  return text.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

/** @param {string} line */
function tableDelimiterRow(line) {
  const text = String(line ?? "").trim();
  return /^[\s:|-]+$/.test(text) && text.includes("-") && (text.match(/\|/g)?.length ?? 0) >= 2;
}

/** Does the body carry a table that could be the comparison matrix — an axis
 *  column plus one column per arm, filled for more than one row?
 *
 *  Three columns and two rows is the smallest such table, and it accepts the
 *  transposed layout (arms as rows, axes as columns) as readily as the usual
 *  one. A table of something else entirely satisfies this too; that is the
 *  intended direction of the error, since the alternative is guessing which
 *  columns are the arms and withholding a package on the guess.
 *  @param {string} text
 */
function hasComparisonMatrix(text) {
  const lines = String(text ?? "").split("\n");
  for (const [index, line] of lines.entries()) {
    if (index === 0 || !tableDelimiterRow(line)) continue;
    if (tableCells(lines[index - 1]).length < 3) continue;
    let rows = 0;
    for (let next = index + 1; next < lines.length && tableCells(lines[next]).length >= 2; next += 1) rows += 1;
    if (rows >= 2) return true;
  }
  return false;
}

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

/** The two defects of a comparison that are decidable from the document alone:
 *  a comparison the title announces and the body never carries out, and a
 *  substitution claim the report has already said it has no evidence for.
 *
 *  Read outside the reference list (a cited title may announce anybody's
 *  comparison) and outside 检索与方法 (a search strategy names comparators it
 *  searched for, and a methods sentence concludes nothing). Both sections are
 *  blanked rather than removed, so a reported line number is the line the
 *  author will find in the file.
 *  @param {any} reportText
 */
function comparativeStructureIssues(reportText) {
  const text = String(reportText ?? "");
  const issues = [];
  const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  const body = withoutReportSections(
    withoutReportSections(text, "参考文献|参考来源|References?"),
    "检索|方法|Methods?",
  );
  if (title && comparativeTitlePattern.test(title) && !hasComparisonMatrix(body)) {
    issues.push(
      `The academic report is titled as a comparison (${excerpt(title)}) but no table in the analysis body sets the arms side by side. `
      + "Reviewing one arm's literature, then the other's, and closing with a shared verdict is not a comparison: the two accounts never meet, "
      + "and the verdict comes from whichever arm had the thinner file. Fix the axes first, then fill every arm on every axis — "
      + "核准适用场景 / 急性按需使用证据（研究对象、结局、起效时间）/ 长期治疗证据 / 人群反应差异 / 安全性与禁忌 / 是否存在直接比较研究 / 该维度可支持的结论边界 — "
      + "as a table with one column per arm and the boundary as its last column. An axis with nothing behind it is a result, written 未检索到 with what was searched; "
      + "it stays inside its row and never becomes the verdict of the table, and each factual cell carries its numbered citation and hidden claim marker.",
    );
  }
  const absent = firstMatchingLine(body, directComparisonAbsentPattern);
  if (absent) {
    for (const [index, line] of body.split("\n").entries()) {
      const conclusion = substitutionConclusion(line);
      if (!conclusion) continue;
      issues.push(
        `The academic report line ${index + 1} concludes that one arm can take the other's place (${conclusion}), `
        + `while line ${absent.line} states that the direct comparison behind such a conclusion was not found (${absent.text}). `
        + "A mechanism that acts on one arm is not evidence about the other, and an arm never tested for it is untested rather than immune. "
        + "Write the chain out one link per line in 讨论, each marked 已建立 or 未建立 with the evidence or the missing study behind the mark "
        + "(该变异在目标人群中常见 / 携带者对 A 的反应降低 / B 不经该通路 / 低反应者改用 B 后结局更好 / B 可在该场景替代 A), "
        + "and stop the conclusion at the last established link: 该差异提示院外用药效果可能存在显著个体差异，另一药具有不同的组成与证据路径，"
        + "其在该亚群中的相对价值仍需直接临床研究验证。",
      );
      break;
    }
  }
  return issues;
}

// A CSV record is not a line: a quoted support quote may hold commas, doubled
// quotes, and newlines, and the ledger is written by a csv writer that quotes
// exactly that way. Counting lines therefore counted the wrong thing.
/** @param {unknown} text @returns {string[][]} */
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

/** @param {unknown} value @returns {string | null} */
function sourceArtifactIdentity(value) {
  if (!validSourceArtifactPath(value)) return null;
  const parts = value.split("/");
  const fileName = parts.at(-1)?.toLowerCase() ?? "";
  if (["fulltext.md", "fulltext.xml", "page.md", "page.html"].includes(fileName)) {
    return parts.slice(0, -1).join("/");
  }
  return value;
}

// Validates a cross-source ("synthesized") claim: the conclusion itself has no
// single verbatim home, so every supporting source must independently satisfy
// the same artifact/quote/URL checks a direct claim gets, and claim numbers
// must trace to a supporting quote or be machine-verifiable source counts.
/**
 * @param {Record<string, any>} value
 * @param {{
 *   label: string,
 *   deepResearch: boolean,
 *   reportReferenceNumbers: Set<number>,
 *   successfulArtifacts: Set<string>,
 *   artifactText: Map<string, string>,
 *   sourceDomains: Set<string>,
 *   issues: string[],
 * }} context
 * @returns {void}
 */
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

// --- The question-coverage ledger -------------------------------------------
//
// The commonest confirmed defect in delivered work is a sub-question that
// disappears from the body without a word: of the 47 findings a coverage
// re-audit of thirty packages could not attribute to any existing check, 38
// were that one shape. A brief names five questions; the report answers three
// and the abstract rewrites the scope as three.
//
// The gate used to be unable to check that, because it never saw the brief, and
// every rule here had to be a self-consistency rule instead: does the run's own
// account contradict the run's own report. Measured over 30 delivered packages
// against 55 hand-verified coverage defects, that cost almost everything — 2 of
// 55 caught, and one of the three notices it did raise was a false one. Of the
// 53 it missed, 36 needed nothing but the brief.
//
// So the brief now arrives here (briefText). It comes from the server's own
// copy, held in memory on the run record from the moment of dispatch — never
// from the workspace, because a run that supplies its own brief is setting its
// own exam. It is deliberately not written to the run ledger: that file has a
// byte ceiling a burst of progress events has already burst once, at 1048462 of
// 1048576, and the run after it could not start.
//
// Two things follow from holding it only in memory:
//
//   * After a server restart the brief for an in-flight run is gone. The
//     brief-derived rules then do not run at all and the self-consistency rules
//     below carry the check on their own, with coverageDegradedNotice saying so
//     in words. Degrading silently would be the one outcome worse than either:
//     a package delivered as if it had been checked against the brief.
//   * The run gets its own read-only copy in the workspace so it can act on the
//     brief while it works, and preflight.py reads that one. The gate never
//     does. If the two differ, the gate says so — the copy the run can edit is
//     not evidence about anything except the run.
//
// The run still declares its own account — question-coverage.json, one entry per
// atomic sub-question — and the self-consistency rules still check that account
// against the report's own lines, the claim anchors in them, and the search log
// the retrieval tools wrote. A run cannot write "answered" without a report line
// that carries evidence, and cannot write "gap" without a search that actually
// ran: "I looked and found nothing" is falsifiable, because the log is written
// by the tools rather than by the model. What the brief adds is the other half:
// whether that account is an account of the questions that were actually asked.
const coverageStatuses = new Set(["answered", "gap"]);
// A sentence saying what this paper set out to do. Naming a quantity as an
// objective is not reporting one: RQ-11's 目的 sentence says it will count the
// aetiological proportions, and reading that as a proportion told the author
// to rewrite a statement of intent as a gap declaration.
const coverageObjectiveSentence = /(?:^|[|\s])(?:\*\*)?目的(?:\*\*)?|本文(?:旨在|拟|试图|将)|本研究(?:旨在|拟|试图)|(?:旨在|意在)(?:清点|量化|评价|回答|梳理|核查)/;
const coverageIsoDate = /^\d{4}-\d{2}-\d{2}$/;
const coverageAnchorPattern = /<!--\s*claim:CLM-[0-9]{3,6}\s*-->|\[claim:CLM-[0-9]{3,6}\]/;
const coverageExcludedSection = /参考文献|参考来源|References?|局限|Limitations?/i;
// The three places a reader takes away an answer. A gap written as a finding
// anywhere else is at least surrounded by its own qualifications; here it is
// the takeaway.
const coverageVerdictSections = Object.freeze([
  { name: "摘要", pattern: "摘要|Abstract" },
  { name: "结论", pattern: "结论|Conclusions?" },
  { name: "临床实践要点", pattern: practicalSectionHeading },
]);
// The four ways a registered gap gets written as an answer, from the audit.
const coverageRankingAssertion = /最常见|首位|占比|构成比|居首|多数|约半数|大多数/;
const coverageThresholdAssertion = new RegExp([
  "\\d+(?:\\.\\d+)?\\s*[%％]",
  "[≥≤><]\\s*\\d",
  "(?:大于|小于|超过|不超过|不少于|至少|不足|上限|下限)\\s*\\d",
  "\\d+(?:\\.\\d+)?\\s*(?:[-–—~～至]|到)\\s*\\d",
  "\\d+(?:\\.\\d+)?\\s*(?:mg|µg|μg|g|ml|mmHg|分钟|小时|天|周|个月|年|次|例|丸|片|倍|杯)",
].join("|"), "i");
const coverageDirectiveAssertion = /推荐|建议|应当|应予|应立即|必须|首选|优先(?:选择|使用)|可给予|适用于|可用于/;
// The retrieval came back empty; the sentence reports it as a property of the
// literature. This family carries no acknowledgement exemption — a sentence that
// says both "we did not find it" and "the literature does not contain it" still
// says the second one.
const coverageLiteratureFactAssertion = new RegExp([
  "(?:证据|结果|研究|数据)\\s*(?:为|是|均为|呈)[^，。；\\n]{0,8}阴性",
  // 尚无 and 暂无 are hedges about what has been published so far; 无相关证据 is
  // a statement about the literature. Only the second one is this family.
  "(?<![尚暂])无(?:此类|该类|相关|任何|已发表)(?:的)?(?:证据|研究|报道|文献)",
  "不存在(?:相关|此类|该类|任何)(?:的)?(?:证据|研究)",
  "文献(?:中|里)(?:并)?(?:没有|无|未见)",
  // 「此为证据空缺，非已证实无效」 is the sentence this rule exists to protect,
  // so the negation in front of it has to be read.
  "(?<![不非未])(?:已|均)(?:证实|表明|显示)(?:其)?无效",
].join("|"));
// "未检索到直接证据，这是一处证据空白" is the sentence this whole ledger exists
// to encourage. A sentence that says so is not asserting an answer, whatever
// else it carries, so the first three families never read it.
const coverageGapAcknowledgement = new RegExp([
  "未(?:能)?检索到",
  "未检索出",
  "尚未检索",
  "检索(?:结果)?为空",
  "未(?:能)?获(?:得|取)",
  "未(?:能)?(?:获|经)(?:得)?(?:核验|核实|证实|确认)",
  "证据空(?:白|缺)",
  "证据缺口",
  "未见(?:相关|直接|任何|以|有)",
  "尚无(?:直接|已发表|公开|相应)?(?:的)?(?:证据|研究|数据|报道)",
  "证据不足",
  "不足以支持",
  "无法(?:判定|评定|确定)",
  "未(?:能)?(?:追溯|定位)到",
  "未述及",
  "未载",
  "缺乏(?:直接)?(?:证据|研究|数据)",
  "无直接(?:证据|研究)",
].join("|"));
// The half of the family above that says THE SEARCH CAME BACK EMPTY, as opposed
// to the half that says a document already in hand does not mention the thing
// (未载, 未述及, 未能追溯到). The distinction decides one thing only, in
// coverageJudge.mjs: a ledger entry registered `gap` means "I could not answer
// this because retrieval found nothing", so a report line that says retrieval
// found nothing AGREES with that entry and cannot be evidence that the run
// answered the question anyway. A line saying an obtained guideline or label
// does not mention the thing is the opposite — the document was read, and its
// silence is the answer the entry should have carried.
//
// Measured on 109 live judgements of the 29-package corpus: 16 verdicts quoted
// a line that was itself an admission of absence, and 12 of them were of the
// first kind — the model reporting a run for writing exactly the honest gap
// sentence this whole ledger exists to encourage. The remaining 4 are of the
// second kind and are kept.
const coverageRetrievalAbsence = new RegExp([
  "未(?:能)?检索到",
  "未检索出",
  "尚未检索",
  "检索(?:结果)?为空",
  "未(?:能)?获(?:得|取)(?![^，。；\\n]{0,6}(?:核验|核实))",
  "证据空(?:白|缺)",
  "证据缺口",
  "未见(?:相关|直接|任何)[^，。；\\n]{0,8}(?:证据|研究|报道|文献|数据|记录)",
  "尚无(?:直接|已发表|公开|相应)?(?:的)?(?:证据|研究|数据|报道)",
  "缺乏(?:直接)?(?:证据|研究|数据)",
  "无直接(?:证据|研究)",
  "证据不足",
].join("|"));
// The abstract's methods sentence names the databases and the search date, and
// a brief that names the same databases shares a long span with it. It states
// how the evidence was looked for, never what was found, so it cannot be a gap
// written as an answer and is not read as one.
const coverageRetrievalRestatement = /检索(?:日期|时间|截至|策略)|检索[^。；\n]{0,60}(?:数据库|索引|注册库|PubMed|Europe\s*PMC|Crossref|ClinicalTrials|CNKI)/i;
const coverageSentenceSplit = /(?<=[。！？；;])/;

// --- Reading the brief -------------------------------------------------------
//
// A research brief is a Markdown document whose 「需要回答的问题」 section is a
// numbered list. That structure is the contract the whole coverage check now
// rests on, so it is read strictly: a document without that section, or with
// fewer than two numbered questions under it, is not a brief this check can
// use, and every brief-derived rule stands down rather than guessing. Requests
// that are not commissioned this way — the open-domain line, a bare question —
// land in that branch by design.
const briefQuestionsHeading = "需要回答的问题";
const briefQuestionNumberLine = /^\s*(\d{1,2})[.、)）]\s*(.*)$/;

/** The body of one level-two section of a brief.
 *  @param {string} briefText @param {string} heading */
function briefSectionText(briefText, heading) {
  const collected = [];
  let inside = false;
  // Normalise line endings first. A brief pasted out of Word arrives CRLF, and
  // the heading pattern below anchors with $, which in JS matches only at end
  // of input -- a trailing \r made every heading fail to match, so the whole
  // brief-derived family silently stopped running on exactly the briefs a
  // person is most likely to paste.
  for (const line of String(briefText ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const match = /^##\s+(.*)$/.exec(line);
    if (match) {
      inside = match[1].trim() === heading;
      continue;
    }
    if (inside) collected.push(line);
  }
  return collected.join("\n");
}

/** The brief's numbered questions, or null when this request is not a brief of
 *  that shape.
 *  @param {any} briefText
 *  @returns {{ number: number, text: string }[]|null} */
function parseBriefQuestions(briefText) {
  const section = briefSectionText(briefText, briefQuestionsHeading);
  if (!section.trim()) return null;
  /** @type {{ number: number, text: string }[]} */
  const questions = [];
  let current = null;
  for (const line of section.split("\n")) {
    const match = briefQuestionNumberLine.exec(line);
    if (match) {
      current = { number: Number(match[1]), text: match[2] };
      questions.push(current);
      continue;
    }
    // A question that wraps onto its own continuation lines is one question.
    if (current && line.trim()) current.text += line.trim();
  }
  if (questions.length < 2) return null;
  // Numbered 1..n with no repeats, or the numbering is not what it looks like.
  if (questions.some((question, index) => question.number !== index + 1)) return null;
  return questions;
}

// Whitespace is not content: the brief writes 「12 导联心电图」 and 「SAQ 评分」,
// the report writes them closed up, and comparing them raw reported four items
// as absent that were on the page.
/** @param {any} value */
export function briefCollapse(value) {
  // Whitespace, and the variant characters Chinese medical prose uses
  // interchangeably. A report writing 适应症 twenty-three times was told the
  // brief's 适应证 never appears, which is a difference of orthography and not
  // of content.
  return String(value ?? "").replace(/\s+/g, "").replace(/[證证]/g, "症").replace(/徵/g, "征");
}

// The shortest run of a brief term that still says which concept it is. Below
// this the claim "this never appears" is about a phrase, not about a subject:
// the report says 心绞痛发作 where the brief said 心绞痛终点, and 硝酸酯 where the
// brief said 硝酸酯类, and neither is a dropped item.
const briefTermCoreLength = 3;

/** Whether a brief's term is discussed at all, as opposed to quoted exactly.
 *  @param {string} term @param {string} collapsedReport */
export function briefTermPresent(term, collapsedReport) {
  const collapsed = briefCollapse(term);
  if (!collapsed) return true;
  if (collapsedReport.includes(collapsed)) return true;
  if (collapsed.length <= briefTermCoreLength) return false;
  for (let start = 0; start + briefTermCoreLength <= collapsed.length; start += 1) {
    if (collapsedReport.includes(collapsed.slice(start, start + briefTermCoreLength))) return true;
  }
  return false;
}

/** The longest run of characters two strings share once punctuation and
 *  whitespace are removed.
 *
 *  Deliberately not coverageSharedTopic, which stops at punctuation because it
 *  compares a registered question to a report sentence and must not stitch a
 *  match across a comma. Here the two strings are a brief question and the
 *  ledger's transcription of part of it, and a transcribed sub-question is
 *  mostly punctuation: 「各研究的设计、样本量、给药方案…」 has no punctuation-free
 *  run longer than seven characters, so that rule called 32 honest entries
 *  inventions. Contiguity across the punctuation is the whole signal.
 *  @param {string} left @param {string} right */
function briefTranscriptionOverlap(left, right) {
  const a = briefContentOnly(left);
  const b = briefContentOnly(right);
  let best = 0;
  let previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] !== b[j - 1]) continue;
      current[j] = previous[j - 1] + 1;
      if (current[j] > best) best = current[j];
    }
    previous = current;
  }
  return best;
}

/** @param {any} value */
function briefContentOnly(value) {
  return String(value ?? "").replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, "");
}

// Where a transcription stops being one. Over the 611 ledger entries of the
// 29-package corpus, 579 are an exact substring of the brief question their id
// names and the other 32 — sub-questions split off a shared stem — share
// between 14 and 39 characters with it. Nothing honest lands under 14; an entry
// invented or copied from a different question does.
const briefTranscriptionCharacters = 12;

// A span carrying one of these is a clause the splitter mis-cut, not an item the
// brief names. They are grammatical function words, and unlike a topic word list
// there is nothing to evade by rewording: the evasion this whole check exists to
// stop is a run dropping an item, and a dropped item cannot be dropped harder by
// choosing a synonym for 是否.
const briefItemFunctionWord = /是否|何种|可否|为何|还是|如何|能否|多少|哪些|分别|各自|有无/;
const briefItemFragmentPrefix = /^[其以在缺仅这那该此]/;
const briefItemMaxLength = 10;

/** One item of a brief enumeration, or "" when the span is not one.
 *  @param {string} raw */
function briefItemTerm(raw) {
  const trimmed = String(raw).replace(/^[^\p{Script=Han}A-Za-z0-9]+|[^\p{Script=Han}A-Za-z0-9]+$/gu, "");
  if (!trimmed || trimmed.length < 2 || trimmed.length > briefItemMaxLength) return "";
  if (/[，,。？；;：:—…]/.test(trimmed)) return "";
  // 「…等」 is an open list; 「…的」 is a modifier waiting for its head.
  if (/等$/.test(trimmed) || /的$/.test(trimmed)) return "";
  if (briefItemFunctionWord.test(trimmed) || briefItemFragmentPrefix.test(trimmed)) return "";
  return trimmed;
}

/** The enumerations inside one brief question: each is the list of items the
 *  question spells out with 、.
 *
 *  Only interior items are taken. The first and last item of a run need the
 *  clause boundary to be guessed, and guessing it produced spans like
 *  「这些定义是否可复现」 — sentence tails, not items. Parentheses and ／ are
 *  read as item separators, because 「主要终点（心绞痛发作频率、硝酸甘油消耗量）」
 *  is a list whichever bracket it wears.
 *  @param {string} questionText */
function briefEnumerations(questionText) {
  const runs = [];
  const normalized = String(questionText).replace(/[（）()]/g, "、").replace(/[／/]/g, "、");
  for (const clause of normalized.split(/[。？；]/)) {
    const parts = clause.split("、");
    if (parts.length < 3) continue;
    const items = [];
    for (let index = 1; index < parts.length - 1; index += 1) {
      for (const piece of parts[index].split(/[与及和或]|以及/)) {
        const term = briefItemTerm(piece);
        if (term) items.push(term);
      }
    }
    const distinct = [...new Set(items)];
    if (distinct.length >= 3) runs.push(distinct);
  }
  return runs;
}

// How much of an enumeration must be on the page before its absent items are
// read as dropped. Two present items and a third of the run is the point where
// the check stops describing the report and starts describing the run: below it,
// an absent item usually means the whole enumeration is off this report's topic
// (or that the splitter cut badly), and above it the report is demonstrably
// working through the list and left some of it out. Measured over the 29
// delivered clinical packages, this bar takes the flagged items from 244 to 151
// and removes the runs where nothing matched at all.
const briefEnumerationPresentFloor = 2;
const briefDroppedItemsNamed = 8;

/** Items the brief's question spells out that the report never uses, for an
 *  enumeration the report is otherwise working through.
 *  @param {string} questionText @param {string} collapsedReport */
function briefDroppedItems(questionText, collapsedReport) {
  const dropped = [];
  const vanished = [];
  for (const run of briefEnumerations(questionText)) {
    // Finding a term is reliable; not finding a short one is not. 终点 is
    // "missing" from a report that says 结局 throughout, and a two-character
    // run turns up inside other words often enough that the claim is not worth
    // making -- so a short term can show that the report is working through
    // the list, but can never be one of the items reported as dropped.
    const present = run.filter((term) => briefTermPresent(term, collapsedReport));
    const reportable = run.filter((term) => briefCollapse(term).length > briefTermCoreLength);
    const absent = reportable.filter((term) => !briefTermPresent(term, collapsedReport));
    if (!absent.length) continue;
    // Nothing from the list appears anywhere. Two things look like this: the
    // extraction picked the wrong spans, or the question was dropped whole --
    // and the second is the worst case this check exists for. Requiring some
    // items to be present kept the noise down and blinded it to exactly that:
    // RQ-16's second question names eight measured effects, none of which
    // occurs in the report, and the family went quiet. Report it once, at the
    // question, rather than as eight separate item claims whose extraction is
    // the thing in doubt.
    // Whether the question was addressed at all is judged on the reportable
    // terms only: a two-character term turning up somewhere says nothing about
    // whether this question was answered, and letting it count here hid the
    // most severe case in the corpus -- eight measured effects named, none of
    // them in the report.
    const presentReportable = reportable.filter((term) => briefTermPresent(term, collapsedReport));
    if (!presentReportable.length) {
      if (reportable.length >= briefEnumerationPresentFloor + 1) vanished.push(reportable);
      continue;
    }
    // Two of the list on the page is what says the list is this report's
    // subject, and once that is settled the absence of the others is the
    // finding. A ratio gate used to sit here as well, requiring a third of the
    // list to be present; it read the strongest case backwards -- six of
    // RQ-16's eight measured effects missing scored 0.25 and was discarded
    // whole. Removing it cost four extra items across the corpus.
    if (present.length < briefEnumerationPresentFloor) continue;

    dropped.push(...absent);
  }
  return { dropped: [...new Set(dropped)], vanished };
}

/** The letter/digit/Han runs of a string, so a shared span cannot be stitched
 *  across a comma.
 *  @param {any} value */
function coverageContentRuns(value) {
  return String(value ?? "").match(/[\p{Script=Han}A-Za-z0-9]+/gu) ?? [];
}

/** The longest run of letters, digits and Han characters two strings share.
 *  No stopword list decides what a topic is, and the span itself is what the
 *  notice names, so a reader can see at once whether the match is real.
 *
 *  Eight characters, not five. A shorter bar was measured over the thirty
 *  delivered packages and matched on spans like 随机对照试验, 安慰剂对照,
 *  性冠脉综合征 and GRADE — vocabulary every report in this field uses in every
 *  section, which made the check fire on sentences that had nothing to do with
 *  the registered gap. The two matches that were real carried spans of eleven
 *  characters (以本品为干预的临床研究, 青年人为预防猝死而常备). Missing a real one
 *  costs a defect that other checks may still catch; a false one sends a run
 *  back to break a correct sentence, so the bar sits where the evidence puts it.
 *  @param {any} left @param {any} right */
function coverageSharedTopic(left, right) {
  const first = coverageContentRuns(left);
  const second = coverageContentRuns(right);
  let best = "";
  for (const a of first) {
    for (const b of second) {
      let previous = new Array(b.length + 1).fill(0);
      for (let i = 1; i <= a.length; i += 1) {
        const current = new Array(b.length + 1).fill(0);
        for (let j = 1; j <= b.length; j += 1) {
          if (a[i - 1] !== b[j - 1]) continue;
          current[j] = previous[j - 1] + 1;
          if (current[j] > best.length) best = a.slice(i - current[j], i);
        }
        previous = current;
      }
    }
  }
  return best.length >= 8 ? best : "";
}

/** The level-two heading in force on each report line, indexed from 0.
 *  @param {any} reportText */
function coverageSectionOfLine(reportText) {
  let heading = "";
  return String(reportText ?? "").split("\n").map((line) => {
    const match = /^##\s+(.*)$/.exec(line);
    if (match) heading = match[1];
    return heading;
  });
}

/** The contiguous non-blank block a line belongs to.
 *  @param {string[]} lines @param {number} index */
function coverageParagraphAt(lines, index) {
  const numbers = coverageParagraphLines(lines, index);
  return numbers.map((line) => lines[line - 1]).join("\n");
}

/** The 1-based line numbers of that block. Same span as coverageParagraphAt,
 *  kept as numbers so an excerpt can be assembled without losing which line of
 *  the report each piece of text is.
 *  @param {string[]} lines @param {number} index */
function coverageParagraphLines(lines, index) {
  let start = index;
  let end = index;
  while (start > 0 && lines[start - 1].trim()) start -= 1;
  while (end < lines.length - 1 && lines[end + 1].trim()) end += 1;
  const numbers = [];
  for (let line = start + 1; line <= end + 1; line += 1) numbers.push(line);
  return numbers;
}

/** @param {string} line */
function coverageLineSubstance(line) {
  return String(line ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\[[^\]\n]*\]\([^)\s]*\)/g, "")
    .replace(/\[\s*\d+(?:\s*[,，、\-–]\s*\d+)*\s*\]/g, "")
    .replace(/[#>*_`|\-–—\s]/g, "")
    .trim();
}

/** Everything the coverage ledger claims, checked against the brief the run was
 *  given and against the report lines, claim anchors and search log this gate
 *  already holds.
 *  @param {any} questionCoverageText @param {any} reportText @param {any} searchLogText
 *  @param {Set<string>} claimIds
 *  @param {{ number: number, text: string }[]|null} briefQuestions
 *  @returns {({ kind: 'shape', detail: string }
 *    | { kind: 'answered', id: string, question: string, detail: string, claim?: any }
 *    | { kind: 'gap-search', id: string, question: string, detail: string }
 *    | { kind: 'gap-asserted', id: string, question: string, section: string, line: number, topic: any, family: any, sentence: string }
 *    | { kind: 'brief-missing', number: number, question: string, total: number }
 *    | { kind: 'brief-mismatch', id: string, number: number, question: string, elsewhere: number | null }
 *    | { kind: 'brief-question-absent', number: number, ids: string[], terms: string[], more: number, total: number }
 *    | { kind: 'brief-item', number: number, ids: string[], terms: string[], more: number }
 *    | { kind: 'brief-extra', number: number, ids: string[], total: number })[]}
 *
 *  A discriminated union on `kind`, like the other two finding producers: the
 *  consumer is one long `else if` chain over exactly these values, and without
 *  the union each branch read fields the checker could only call
 *  possibly-undefined.
 */
function questionCoverageFindings(questionCoverageText, reportText, searchLogText, claimIds, briefQuestions) {
  /** @type {ReturnType<typeof questionCoverageFindings>} */
  const findings = [];
  const text = String(questionCoverageText ?? "");
  if (!text.trim()) {
    findings.push({ kind: "shape", detail: "文件缺失或为空。它必须是一个 JSON 对象，逐条列出题面「需要回答的问题」拆出的原子子问。" });
    return findings;
  }
  let ledger = null;
  try {
    ledger = JSON.parse(text);
  } catch (error) {
    findings.push({ kind: "shape", detail: `不是合法 JSON（${String(/** @type {Error} */ (error)?.message ?? error).slice(0, 120)}）。` });
    return findings;
  }
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    findings.push({ kind: "shape", detail: "顶层必须是对象，不能是数组或标量。" });
    return findings;
  }
  if (ledger.schemaVersion !== 1) {
    findings.push({ kind: "shape", detail: "必须写 \"schemaVersion\": 1。" });
  }
  const entries = Array.isArray(ledger.entries) ? ledger.entries : null;
  if (!entries || !entries.length) {
    findings.push({ kind: "shape", detail: "entries 必须是非空数组，一条原子子问一个条目。" });
    return findings;
  }
  const lines = String(reportText ?? "").split("\n");
  const sectionOfLine = coverageSectionOfLine(reportText);
  const searchLog = parseJsonObject(searchLogText);
  const loggedQueries = (Array.isArray(searchLog?.queries) ? searchLog.queries : []).map((entry) => ({
    query: normalizedSearchQuery(entry?.query),
    database: String(entry?.database ?? "").trim().toLowerCase(),
  }));
  const loggedDate = String(searchLog?.searchedAt ?? "").slice(0, 10);
  const seenIds = new Set();
  const groups = new Set();
  // Which ledger entries claim to cover each numbered brief question, keyed by
  // the number their id leads with. "2.3" is the third sub-question of the
  // brief's second question, and that convention is what makes the ledger
  // comparable to the brief at all.
  /** @type {Map<number, { id: string, question: string, status: any }[]>} */
  const briefGroupEntries = new Map();
  for (const [index, entry] of entries.entries()) {
    const label = `entries[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      findings.push({ kind: "shape", detail: `${label} 必须是对象。` });
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const question = typeof entry.question === "string" ? entry.question.trim() : "";
    if (!id) {
      findings.push({ kind: "shape", detail: `${label}.id 必须是题面编号加子项序号（如 "2.3"）。` });
      continue;
    }
    if (seenIds.has(id)) {
      findings.push({ kind: "shape", detail: `条目编号 ${id} 出现了两次；一条子问一个编号。` });
      continue;
    }
    seenIds.add(id);
    const groupMatch = /\d+/.exec(id);
    groups.add(groupMatch ? groupMatch[0] : id);
    if (groupMatch) {
      const number = Number(groupMatch[0]);
      briefGroupEntries.set(number, [...(briefGroupEntries.get(number) ?? []), { id, question, status: entry.status }]);
    }
    if (question.replace(/\s+/g, "").length < 8) {
      findings.push({ kind: "shape", detail: `${id}.question 必须转录子问原文（至少 8 个字符），当前为 ${JSON.stringify(question)}。` });
      continue;
    }
    if (!coverageStatuses.has(entry.status)) {
      findings.push({ kind: "shape", detail: `${id}.status 必须是 "answered" 或 "gap"，当前为 ${JSON.stringify(entry.status)}。` });
      continue;
    }
    // With no matrix at all, every id the ledger names is unresolvable, and
    // saying so once per id buries the one fact that explains all of them.
    //
    // Third location of this defect. The report-side version was fixed on
    // 2026-08-26 (23 blocking issues, 14 of them one absent file); this one
    // then cost a real run its last repair attempt: the matrix was momentarily
    // empty at the third gate, the coverage ledger still named its claims, and
    // the verdict came back with 114 issues of which ~78 were this sentence
    // with a different id in it. The run had three real problems and no way to
    // see them.
    //
    // A matrix that HAS claims and is missing a named one is still reported per
    // id -- that is a genuine per-claim finding, and its control pins it.
    if (Array.isArray(entry.claimIds) && claimIds.size) {
      for (const claimId of entry.claimIds) {
        if (!claimIds.has(claimId)) {
          findings.push({ kind: "shape", detail: `${id}.claimIds 提到 ${JSON.stringify(claimId)}，证据矩阵里没有这个 claim。` });
        }
      }
    }
    if (entry.status === "answered") {
      const reportLines = Array.isArray(entry.reportLines) ? entry.reportLines : null;
      if (!reportLines || !reportLines.length || reportLines.some((/** @type {number} */ value) => !Number.isInteger(value) || value < 1)) {
        findings.push({ kind: "shape", detail: `${id} 声明 answered，就必须在 reportLines 里给出正文行号（正整数数组，至少一条）。` });
        continue;
      }
      let anchored = false;
      for (const line of reportLines) {
        if (line > lines.length) {
          findings.push({ kind: "answered", id, question, detail: `指向报告第 ${line} 行，而报告只有 ${lines.length} 行。` });
          continue;
        }
        const heading = sectionOfLine[line - 1] ?? "";
        if (coverageExcludedSection.test(heading)) {
          findings.push({
            kind: "answered",
            id,
            question,
            detail: `指向报告第 ${line} 行，那一行在「${heading.trim()}」一节里。参考文献表与局限性都不回答问题——把行号改到正文中真正给出答案的那一行。`,
          });
          continue;
        }
        if (!coverageLineSubstance(lines[line - 1])) {
          findings.push({ kind: "answered", id, question, detail: `指向报告第 ${line} 行，那一行是空行或只有标记，没有正文。` });
          continue;
        }
        if (coverageAnchorPattern.test(coverageParagraphAt(lines, line - 1))) anchored = true;
      }
      if (anchored) continue;
      findings.push({
        kind: "answered",
        id,
        question,
        detail: `声明的行 ${reportLines.join("、")} 所在段落都没有 claim 锚点（<!-- claim:CLM-… -->）。`
          + "被当作已回答的子问，其答案必须挂在证据上；没有锚点的一段散文不是答案。",
      });
      continue;
    }
    const searches = Array.isArray(entry.searches) ? entry.searches : null;
    if (!searches || !searches.length) {
      findings.push({ kind: "shape", detail: `${id} 声明 gap，就必须在 searches 里给出实际执行过的检索式、数据源与检索日期（至少一条）。` });
      continue;
    }
    for (const [position, search] of searches.entries()) {
      const query = typeof search?.query === "string" ? search.query.trim() : "";
      const database = typeof search?.database === "string" ? search.database.trim() : "";
      const searchedAt = typeof search?.searchedAt === "string" ? search.searchedAt.trim() : "";
      if (!query || !database || !coverageIsoDate.test(searchedAt)) {
        findings.push({
          kind: "shape",
          detail: `${id}.searches[${position}] 必须同时给出 query、database 与 searchedAt（YYYY-MM-DD）。`,
        });
        continue;
      }
      const normalized = normalizedSearchQuery(query);
      const matches = loggedQueries.filter((logged) => logged.query === normalized);
      if (!matches.length) {
        findings.push({
          kind: "gap-search",
          id,
          question,
          detail: `其检索式「${query}」在 clinical-evidence-search.json 的 queries 中没有对应记录。`
            + "检索日志由取数工具写入，「查过但没查到」必须能在日志里找到那一次检索——"
            + "把真正跑过的检索式抄进来，或者去跑这一次检索。",
        });
        continue;
      }
      if (!matches.some((logged) => logged.database === database.toLowerCase())) {
        findings.push({
          kind: "gap-search",
          id,
          question,
          detail: `其检索式「${query}」声明的数据源是「${database}」，`
            + `检索日志里这条检索记在「${[...new Set(matches.map((logged) => logged.database))].join("、")}」下。`,
        });
        continue;
      }
      if (loggedDate && searchedAt !== loggedDate) {
        findings.push({
          kind: "gap-search",
          id,
          question,
          detail: `其检索式「${query}」声明的检索日期是 ${searchedAt}，clinical-evidence-search.json 的 searchedAt 是 ${loggedDate}。`,
        });
      }
    }
  }
  // A registered gap written as an answer where the reader takes the answer
  // away. The span the two strings share is what the notice names, so a reader
  // can see at once whether the match is real.
  const gapEntries = entries.filter((/** @type {Record<string, any> | null} */ entry) => (
    entry && typeof entry === "object" && entry.status === "gap" && typeof entry.question === "string"
  ));
  for (const { name, pattern } of coverageVerdictSections) {
    const sectionText = reportSection(reportText, pattern);
    if (!sectionText.trim()) continue;
    const sectionOffset = String(reportText ?? "").indexOf(sectionText);
    const sectionFirstLine = sectionOffset >= 0
      ? String(reportText ?? "").slice(0, sectionOffset).split("\n").length
      : 1;
    for (const [lineIndex, line] of sectionText.split("\n").entries()) {
      for (const sentence of line.split(coverageSentenceSplit)) {
        if (!sentence.trim()) continue;
        if (coverageRetrievalRestatement.test(sentence)) continue;
        // Naming a quantity as an objective is not reporting one.
        if (coverageObjectiveSentence.test(sentence)) continue;
        const literatureFact = coverageLiteratureFactAssertion.test(sentence);
        const acknowledged = coverageGapAcknowledgement.test(sentence);
        const family = literatureFact
          ? "把这一次检索的空手写成了文献世界的事实"
          : acknowledged
            ? ""
            : coverageRankingAssertion.test(sentence)
              ? "给出了排序或构成比"
              : coverageThresholdAssertion.test(sentence)
                ? "给出了阈值或数值区间"
                : coverageDirectiveAssertion.test(sentence)
                  ? "给出了推荐或处置祈使"
                  : "";
        if (!family) continue;
        for (const entry of gapEntries) {
          const topic = coverageSharedTopic(entry.question, sentence);
          if (!topic) continue;
          findings.push({
            kind: "gap-asserted",
            id: String(entry.id ?? "").trim(),
            question: entry.question.trim(),
            section: name,
            line: sectionFirstLine + lineIndex,
            topic,
            family,
            sentence: sentence.trim().slice(0, 120),
          });
          break;
        }
      }
    }
  }
  // --- Against the brief ----------------------------------------------------
  //
  // What replaced the old scope-count heuristic. That one read the abstract for
  // a sentence restating the study's scope, counted the questions it named, and
  // compared that number to the ledger's — two numbers both written by the run,
  // so the only thing it could catch was the run disagreeing with itself. Here
  // the question count is not inferred from anything: the brief has five
  // numbered questions, and either the ledger accounts for all five or it does
  // not.
  if (briefQuestions) {
    const collapsedReport = briefCollapse(reportText);
    const briefNumbers = new Set(briefQuestions.map((question) => question.number));
    for (const question of briefQuestions) {
      const covered = briefGroupEntries.get(question.number) ?? [];
      if (!covered.length) {
        findings.push({ kind: "brief-missing", number: question.number, question: question.text, total: briefQuestions.length });
        continue;
      }
      // The entry must be a transcription of the question it claims to cover.
      // Without the brief the only available rule was "at least eight
      // characters of something", which a run satisfies by typing anything —
      // and which is exactly how one entry comes to stand for two questions:
      // register 1.1 and 2.1 with the same text and the count comes out right.
      for (const item of covered) {
        const bar = Math.min(briefTranscriptionCharacters, briefContentOnly(item.question).length);
        if (briefTranscriptionOverlap(question.text, item.question) >= bar) continue;
        const elsewhere = briefQuestions.find((other) => (
          other.number !== question.number && briefTranscriptionOverlap(other.text, item.question) >= bar
        ));
        findings.push({
          kind: "brief-mismatch",
          id: item.id,
          number: question.number,
          question: question.text,
          elsewhere: elsewhere ? elsewhere.number : null,
        });
      }
      // An item the brief spells out that the report never uses, in an
      // enumeration the report is otherwise working through. Only for a
      // question the ledger claims is answered: a question registered wholly as
      // a gap is already held to a search that really ran.
      if (!covered.some((item) => item.status === "answered")) continue;
      const { dropped, vanished } = briefDroppedItems(question.text, collapsedReport);
      for (const run of vanished) {
        findings.push({
          kind: "brief-question-absent",
          number: question.number,
          ids: covered.map((item) => item.id),
          terms: run.slice(0, briefDroppedItemsNamed),
          more: Math.max(0, run.length - briefDroppedItemsNamed),
          total: run.length,
        });
      }
      if (dropped.length) {
        findings.push({
          kind: "brief-item",
          number: question.number,
          ids: covered.map((item) => item.id),
          terms: dropped.slice(0, briefDroppedItemsNamed),
          more: Math.max(0, dropped.length - briefDroppedItemsNamed),
        });
      }
    }
    for (const number of [...briefGroupEntries.keys()].sort((left, right) => left - right)) {
      if (briefNumbers.has(number)) continue;
      findings.push({
        kind: "brief-extra",
        number,
        ids: (briefGroupEntries.get(number) ?? []).map((item) => item.id),
        total: briefQuestions.length,
      });
    }
  }
  return findings;
}

// --- What a semantic judge is allowed to look at ----------------------------
//
// Everything above decides whether the run's account is INTERNALLY consistent
// and whether it accounts for the brief's questions by name. Two defects
// survive that by construction, and both were measured on the 30-package
// corpus rather than imagined:
//
//   * A ledger entry says "answered" and points at a report line that really
//     exists, really carries a claim anchor, and really is in the body — and
//     answers a different question, population or endpoint than the
//     sub-question it is registered against. Every deterministic predicate
//     above passes. (4 labelled cases, reason R2.)
//   * A registered gap whose answer is handed to the reader anyway in the
//     abstract, the conclusion or the practical section, worded so that no
//     eight-character span is shared with the registered question — synonym,
//     nominalisation, a different clause order. coverageSharedTopic returns
//     nothing and the gap-asserted rule stands down. (13 labelled cases,
//     reason R3.) The reverse — material in hand registered as a gap — is the
//     same shape. (3 labelled cases.)
//
// Both are judgements about MEANING, and no vocabulary list decides meaning.
// What this function does is assemble exactly what a judge needs and nothing
// else: the brief's questions, the ledger's entries, and a bounded excerpt of
// the report. It decides nothing itself; coverageJudge.mjs takes it to a model
// and then checks every checkable part of what comes back against the same
// data. The excerpt is also the answer sheet: a verdict that names a line
// outside it is discarded, so the model cannot cite a line it never saw.
const coverageJudgeExcerptCharacters = 16_000;

/** One report line as a judge sees it: its 1-based number, the section heading
 *  in force, and its text.
 *  @typedef {{ line: number, section: string, text: string }} CoverageJudgeLine */

/** Everything a semantic coverage judge may read, or null when this delivery is
 *  not one it can judge (no parsable brief questions, no usable ledger entries,
 *  or no report).
 *  @param {Record<string, any>} options0 */
export function coverageJudgeContext({ briefText, questionCoverageText, reportText } = {}) {
  const briefQuestions = parseBriefQuestions(briefText);
  if (!briefQuestions) return null;
  const lines = String(reportText ?? "").split("\n");
  if (!String(reportText ?? "").trim()) return null;
  const ledger = parseJsonObject(questionCoverageText);
  const rawEntries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  /** @type {{ id: string, question: string, status: string, declaredLines: number[], declaredParagraph: number[] }[]} */
  const entries = [];
  for (const entry of rawEntries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const question = typeof entry.question === "string" ? entry.question.trim() : "";
    if (!id || !question || !coverageStatuses.has(entry.status)) continue;
    const declaredLines = (Array.isArray(entry.reportLines) ? entry.reportLines : [])
      .filter((/** @type {number} */ value) => Number.isInteger(value) && value >= 1 && value <= lines.length);
    entries.push({ id, question, status: entry.status, declaredLines, declaredParagraph: [] });
  }
  if (!entries.length) return null;

  const sectionOfLine = coverageSectionOfLine(reportText);
  // The three places a reader takes an answer away, in full. A gap that becomes
  // a conclusion becomes one here.
  /** @type {Map<number, string>} */
  const verdictLines = new Map();
  for (const { name, pattern } of coverageVerdictSections) {
    const sectionText = reportSection(reportText, pattern);
    if (!sectionText.trim()) continue;
    const offset = String(reportText ?? "").indexOf(sectionText);
    if (offset < 0) continue;
    const firstLine = String(reportText ?? "").slice(0, offset).split("\n").length;
    for (let index = 0; index < sectionText.split("\n").length; index += 1) {
      const line = firstLine + index;
      if (line >= 1 && line <= lines.length) verdictLines.set(line, name);
    }
  }
  // Plus the paragraphs the ledger itself points at. Nothing else: a judge that
  // needs the whole 30 kB report to decide whether entry 2.1's own cited line
  // answers entry 2.1's own question is not being asked the right question, and
  // the cost of asking it that way is paid on every delivery.
  /** @type {Map<number, number[]>} */
  const declaredParagraphs = new Map();
  for (const entry of entries) {
    for (const line of entry.declaredLines) {
      if (declaredParagraphs.has(line)) continue;
      declaredParagraphs.set(line, coverageParagraphLines(lines, line - 1));
    }
    // The paragraph, not the line. A ledger entry cites the line its answer
    // starts on and the answer runs to the end of the block — measured on the
    // corpus, three of the labelled unresponsive answers are worded two or
    // three lines below the cited one, so pinning a verdict to the cited line
    // exactly would have thrown out three true findings to no benefit. The
    // block is still the entry's OWN citation, which is the property that makes
    // the charge falsifiable.
    entry.declaredParagraph = [...new Set(entry.declaredLines.flatMap((line) => declaredParagraphs.get(line) ?? []))];
  }

  // Verdict sections first, then declared paragraphs in ledger order, so a
  // truncation drops the least load-bearing lines rather than an arbitrary tail.
  const ordered = [...verdictLines.keys()];
  for (const entry of entries) {
    for (const line of entry.declaredLines) ordered.push(...(declaredParagraphs.get(line) ?? []));
  }
  const excerptLines = new Set();
  let budget = coverageJudgeExcerptCharacters;
  let truncated = false;
  for (const line of ordered) {
    if (excerptLines.has(line)) continue;
    const text = lines[line - 1] ?? "";
    if (budget - text.length < 0) {
      truncated = true;
      continue;
    }
    budget -= text.length;
    excerptLines.add(line);
  }
  /** @type {CoverageJudgeLine[]} */
  const excerptLineViews = [...excerptLines]
    .sort((left, right) => left - right)
    .map((line) => ({ line, section: String(sectionOfLine[line - 1] ?? "").trim(), text: lines[line - 1] ?? "" }));

  return {
    briefQuestions,
    entries,
    totalLines: lines.length,
    excerpt: excerptLineViews,
    excerptLines,
    verdictLines,
    truncated,
    /** The line carries readable prose rather than markup or a blank.
     *  @param {number} line */
    hasSubstance: (line) => Boolean(coverageLineSubstance(lines[line - 1] ?? "")),
    /** The line sits in a section that does not answer questions.
     *  @param {number} line */
    inExcludedSection: (line) => coverageExcludedSection.test(String(sectionOfLine[line - 1] ?? "")),
    /** The line's paragraph carries a claim anchor, i.e. an answer bonded to
     *  evidence rather than a sentence of prose.
     *  @param {number} line */
    isAnchored: (line) => coverageAnchorPattern.test(coverageParagraphAt(lines, line - 1)),
    /** The line's text, for verbatim-quote verification.
     *  @param {number} line */
    lineText: (line) => lines[line - 1] ?? "",
    /** The span says the search came back empty, and says nothing else that
     *  would make it an answer — the report agreeing with a `gap` entry rather
     *  than contradicting it.
     *  @param {string} text */
    statesRetrievalGap: (text) => coverageRetrievalAbsence.test(String(text ?? ""))
      && !coverageLiteratureFactAssertion.test(String(text ?? ""))
      && !coverageDirectiveAssertion.test(String(text ?? "")),
  };
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
  questionCoverageText = "",
  // The server's own copy of the brief this run was dispatched with, held in
  // memory on the run record. Null means it is not available — an in-flight run
  // whose server restarted, or a request that never had one.
  briefText = null,
  // The copy the run could read in its workspace. Never used to decide
  // anything; compared to the one above so a rewritten exam paper is visible.
  workspaceBriefText = null,
} = {}) {
  const issues = [];
  const claimIds = [];
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
      claimIds: [],
      sourceDomains: [],
      coverageDegradedNotice: null,
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
  const successfulArtifacts = new Set(
    Array.isArray(runReceipt?.successfulSourceArtifacts)
      ? runReceipt.successfulSourceArtifacts.filter((/** @type {unknown} */ value) => typeof value === "string")
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
    // Presence is required of every report above; here only the order matters.
    const practicalHeading = String(reportText ?? "").search(practicalHeadingLinePattern);
    const referencesHeading = String(reportText ?? "").search(/(?:^|\n)##\s+[^\n]*(?:参考文献|参考来源|References?)[^\n]*$/im);
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
  for (const finding of declaredAppraisalIssues(reportText)) {
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
  issues.push(...manuscriptRegisterIssues(reportText));
  issues.push(...comparativeStructureIssues(reportText));
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
  for (const claimId of claims.length ? reportSet : []) {
    if (!seen.has(claimId)) issues.push(`Report claim reference ${claimId} does not resolve to the evidence matrix.`);
  }
  for (const claimId of seen) {
    if (!reportSet.has(claimId)) issues.push(`Evidence matrix claim ${claimId} is not cited by the report.`);
  }

  const claimsById = new Map(claims.map((claim) => [claim?.claimId, claim]));

  for (const finding of regulatoryArticleIssues(reportText, claims, successfulArtifacts)) {
    issues.push(
      `报告正文第 ${finding.line} 行以条款级方式引用「${finding.locator}」，`
      + "但该行引用的来源中没有一件来自发文机关自有渠道的已留存监管文本工件"
      + "（要求：sourceUrl 主机名位于 .gov/.gov.<国别>/.go.<国别>/.europa.eu/.int 政府域，"
      + `artifactPath 在本次运行的 successfulSourceArtifacts 中，且其 supportQuote 或 claim 含同一条号 第${finding.article}条 / Article ${finding.article}）；`
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

  for (const finding of attributedStanceIssues(reportForNumericAudit, claimsById)) {
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
  // The practical section's first line inside the report, so the notice names
  // the line the author will find rather than an offset into a section.
  const practicalOffset = practical ? String(reportText ?? "").indexOf(practical) : -1;
  const practicalFirstLine = practicalOffset >= 0
    ? String(reportText ?? "").slice(0, practicalOffset).split("\n").length
    : 1;
  for (const trigger of medicationConditionedEmergencyTriggers(practical)) {
    issues.push(
      `临床实践要点第 ${practicalFirstLine + trigger.line - 1} 行把「${trigger.span}」写成了呼叫急救的触发条件：「${trigger.sentence}」。`
      + "急救的触发条件不得以自救用药的疗效为条件（含药不缓解、服药后无效、观察 N 分钟无效均不可）——"
      + "本节唯一允许的口径是「无论服药与否、无论是否缓解，出现上述征象即刻呼叫 120」。"
      + "同一节里已经写着「服药不是等待的理由，应在服药的同时呼叫急救」，这一条与它互斥，读者无法同时执行。"
      + "若来源（指南原文）确实给出了这一条件，把它留在「结果」一节按原文复述并保留出处，实践要点只写无条件的那一句。",
    );
  }

  // The brief-derived rules run only on a brief the server itself holds. A run
  // that supplies its own brief supplies its own exam, so the workspace copy is
  // never read here — only compared, below.
  const briefQuestions = parseBriefQuestions(briefText);
  const coverageDegradedNotice = briefQuestions
    ? null
    : briefText == null
      ? "本次交付未按题面逐问核对覆盖：服务端持有的题面副本不可用（题面只存在于内存中的运行记录上，"
        + "服务进程重启后即丢失），question-coverage.json 只做了自洽核对——它登记了哪几问、"
        + "登记的答案是否落在正文并挂着 claim 锚点、登记的空缺是否有真跑过的检索。"
        + "「题面有几问、台账是不是这几问」这一层本次没有检查过。"
      : "本次交付未按题面逐问核对覆盖：服务端持有的题面里没有可解析的「需要回答的问题」编号列表，"
        + "无法逐问比对。question-coverage.json 只做了自洽核对。";
  if (briefQuestions && typeof workspaceBriefText === "string" && workspaceBriefText.trim()) {
    if (briefCollapse(workspaceBriefText) !== briefCollapse(briefText)) {
      issues.push(
        "工作区里的题面只读副本 .evimed-brief/research-brief.md 与服务端派发时持有的题面不一致。"
        + "门禁判定用的始终是服务端那一份，改动工作区副本不会改变判定，但被检查方改写考题本身就是可疑信号——"
        + "把该文件恢复为派发时的原样，不要编辑它；需要记录自己的理解时另写一个文件。",
      );
    }
  }
  for (const finding of questionCoverageFindings(
    questionCoverageText,
    reportText,
    searchLogText,
    new Set(claimIds),
    briefQuestions,
  )) {
    if (finding.kind === "shape") {
      issues.push(
        `question-coverage.json 台账格式无效：${finding.detail} `
        + "台账把题面「需要回答的问题」拆成原子子问，一条一个条目："
        + '{"schemaVersion":1,"entries":[{"id":"2.3","question":"<子问原文>","status":"answered","reportLines":[64],"claimIds":["CLM-005"]}]}；'
        + 'status 为 "gap" 的条目改为给出 searches:[{"query":"<实际执行过的检索式>","database":"PubMed","searchedAt":"YYYY-MM-DD"}]。',
      );
    } else if (finding.kind === "answered") {
      issues.push(
        `question-coverage.json 条目 ${finding.id}（「${finding.question.slice(0, 60)}」）声明 answered，但${finding.detail}`,
      );
    } else if (finding.kind === "gap-search") {
      issues.push(
        `question-coverage.json 条目 ${finding.id}（「${finding.question.slice(0, 60)}」）声明 gap，${finding.detail}`,
      );
    } else if (finding.kind === "gap-asserted") {
      issues.push(
        `question-coverage.json 条目 ${finding.id}（「${finding.question.slice(0, 60)}」）登记为 gap，`
        + `${finding.section}第 ${finding.line} 行却就同一主题「${finding.topic}」${finding.family}：「${finding.sentence}」。`
        + "摘要、结论与临床实践要点是读者取走答案的地方，缺口不能在那里变成结论。"
        + "要么把这一句改写成如实的缺口陈述（「未检索到该终点的直接证据，这是一处证据空白」是允许的，也是应当写的），"
        + "要么这条子问其实有答案，把台账改成 answered 并给出正文行号。",
      );
    } else if (finding.kind === "brief-missing") {
      issues.push(
        `题面第 ${finding.number} 问在 question-coverage.json 中没有任何条目：「${String(finding.question).slice(0, 80)}」。`
        + `题面共 ${finding.total} 问，台账必须逐问登记——不得合并、不得重新编号、不得少列。`
        + "若这一问全篇未答，它仍然是一问：登记为 gap，给出真跑过的检索式，并在正文中如实写出这处空白。",
      );
    } else if (finding.kind === "brief-extra") {
      issues.push(
        `question-coverage.json 台账格式无效：条目 ${finding.ids.join("、")} 的编号指向题面第 ${finding.number} 问，`
        + `而题面只有 ${finding.total} 问。条目编号的首位数字必须是它所覆盖的题面问号。`,
      );
    } else if (finding.kind === "brief-mismatch") {
      issues.push(
        `question-coverage.json 条目 ${finding.id} 的 question 不是题面第 ${finding.number} 问的原文：`
        + `题面第 ${finding.number} 问是「${String(finding.question).slice(0, 60)}」。`
        + (finding.elsewhere
          ? `这一条转录的是题面第 ${finding.elsewhere} 问——一条条目只能覆盖一问，两问就是两条条目。`
          : "台账条目必须逐字转录它所覆盖的那一问（或其中一项子问），自拟的概括无法核对。"),
      );
    } else if (finding.kind === "brief-question-absent") {
      issues.push(
        `question-coverage.json 条目 ${finding.ids.join("、")} 把题面第 ${finding.number} 问登记为 answered，`
        + `但这一问点名的 ${finding.total} 项——「${finding.terms.join("」「")}」`
        + (finding.more ? `等` : "")
        + "——在报告全篇一项都没有出现。"
        + "一项不落地全部缺席，通常意味着这一问整个没有作答：把它答出来并挂上证据，"
        + "或者为它单列 status 为空缺的台账条目并在正文写明未检索到直接证据。",
      );
    } else if (finding.kind === "brief-item") {
      issues.push(
        `question-coverage.json 条目 ${finding.ids.join("、")} 把题面第 ${finding.number} 问登记为 answered，`
        + `但这一问点名的「${finding.terms.join("」「")}」`
        + (finding.more ? `等 ${finding.terms.length + finding.more} 项` : "")
        + "在报告全篇一次未出现，同一列举中的其余项则都在正文里。"
        + "题面逐项点名的东西，要么答它并挂上证据，要么为它单列一条 status 为空缺的台账条目，"
        + "并在正文中写明未检索到该项的直接证据——整项无声消失不是这两者中的任何一种。",
      );
    }
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
    for (const finding of screeningLedgerFindings(reportText, searchLog)) {
      if (finding.leg === "A") {
        issues.push(
          `检索流程数与纳入来源集合由 clinical-evidence-search.json 持有，正文只能渲染、不得复述。`
          + `本次不一致：正文写「${finding.clause}」中的${screeningFlowNames[finding.key]} ${finding.stated}，`
          + `检索记录 ${finding.key} = ${finding.held}。`
          + "请改正持有事实的一侧或正文，使两侧逐字相等；只改正文措辞不算修好。",
        );
      } else if (finding.leg === "B1") {
        issues.push(
          `参考文献 ${finding.numbers.map((number) => `[${number}]`).join("、")} 在正文中被引用或列入参考文献表，`
          + "但在 clinical-evidence-search.json 的 sourceRecords 中 included=false（或该条记录根本不存在）。"
          + "要么读到可核验层级并置 included=true、同步更新 screening 计数，"
          + "要么删除这条引用——题录层级的记录支撑不了任何陈述。",
        );
      } else {
        issues.push(
          `参考文献表共 ${finding.listed} 条编号条目，screening.sourcesIncluded = ${finding.included}。`
          + "编号表必须恰好是 included=true 的来源集合：同数量、同编号。",
        );
      }
    }
    // The practical section's line range, so a mispaired anchor there is
    // blocking: that section is already the one place the gate refuses derived
    // claims and requires a marker on every action line.
    const practicalLastLine = practical ? practicalFirstLine + practical.split("\n").length - 1 : 0;
    for (const finding of citationClosureFindings(reportText, claimsById, searchLog)) {
      if (finding.clause === "A") {
        issues.push(
          `参考文献 [${finding.number}] 在正文中从未被引用：「${finding.body}」。`
          + "已检索但未纳入的来源不进编号表——要么在正文中真正引用它，"
          + "要么把它写入 clinical-evidence-search.json 的 sourceRecords（\"included\": false 并给出 exclusionReason）后从编号表中移除并重新编号。",
        );
      } else if (finding.clause === "B") {
        issues.push(
          `正文引用 [${finding.number}] 在参考文献表中没有对应条目：补上该条目，或改引真正支持这句话的编号。`,
        );
      } else if (finding.clause === "C") {
        issues.push(
          `报告第 ${finding.line} 行把书目标识符放进了引用位：「${finding.bracket}」。`
          + "行内 PMID/DOI 不能代替编号引用——为该来源分配参考文献编号与 claim，或按未纳入来源记入检索日志。",
        );
      } else if (finding.clause === "D") {
        const detail = `${finding.claimId}，但该行只引用了 [${finding.cited.join(", ") || "无"}]，`
          + `而 ${finding.claimId} 的 referenceNumber 是 ${finding.allowed.join(", ")}。`
          + "把该行改引正确的编号，或换成真正支持这句话的 claim；同一 claim 在别处已正确配对不豁免这一行。";
        issues.push(finding.line >= practicalFirstLine && finding.line <= practicalLastLine
          ? `The practical section's report line ${finding.line} anchors claim ${detail}`
          : `Report line ${finding.line} anchors claim ${detail}`);
      } else if (finding.clause === "E1") {
        issues.push(
          `clinical-evidence-search.json 的 sourceRecords[${finding.index}] 标记为 "included": false 却没有 exclusionReason：`
          + "未纳入的来源必须写明排除理由。",
        );
      } else {
        issues.push(
          `clinical-evidence-search.json 的 sourceRecords[${finding.index}] 标记为 "included": false，`
          + `却仍以编号 [${finding.number}] 留在参考文献表中：读到可核验层级并置 included=true，或从编号表中移除并重新编号。`,
        );
      }
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
      if (runReceipt.successfulSourceArtifacts.some((/** @type {unknown} */ value) => !validSourceArtifactPath(value))) {
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
    // Not an issue: nothing here is the run's fault and nothing here is
    // repairable by it, so it must not send a finished package back round the
    // repair loop. It rides on the delivery as a notice instead — the one thing
    // that must never happen is a package delivered as though the brief had
    // been checked when it was not.
    coverageDegradedNotice,
  });
}

/**
 * Runtime-leakage findings in arbitrary prose, for the contract kinds that are
 * not a clinical evidence package but are still report prose. The clinical
 * validator applies the same pattern inline; this export is what lets the
 * generic validators reuse the rule rather than restate it (§14 rule 4).
 * @param {string} text
 * @returns {{ line: number, text: string } | null}
 */
export function runtimeLeakageLine(text) {
  return firstMatchingLine(text, runtimeLeakagePattern);
}

/**
 * The four Apodex verification-gate metrics (§8.1), computed mechanically from
 * the evidence matrix and the citation ledger. They are notices, not blocks:
 * the thresholds that would make them blocking do not exist yet, and a metric
 * whose threshold nobody has calibrated is a coin toss dressed as a gate.
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
  // comparison exists at all. (When it says one does not, the gate blocks; this
  // is the case where the axis was simply never filled.)
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
