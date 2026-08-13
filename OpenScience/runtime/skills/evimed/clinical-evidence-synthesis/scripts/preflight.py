#!/usr/bin/env python3
"""Deterministic structural preflight for clinical evidence deliverables."""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
from pathlib import Path


REQUIRED_CLAIM_FIELDS = (
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
)

# Cross-source "synthesized" claims trade the single-source verbatim bond for
# at least two independently verified supporting sources plus a confidence
# label; see clinicalEvidenceQuality.mjs for the authoritative gate.
SYNTHESIZED_BASE_FIELDS = ("claimId", "claim", "applicability", "uncertainty")
SYNTHESIZED_SOURCE_FIELDS = ("sourceUrl", "sourceTitle", "artifactPath", "accessLevel", "supportQuote")
CONFIDENCE_LEVELS = ("high", "moderate", "low")
# A "derived" claim is the analyst's own estimate, bound, or inference. No
# source states it, so it is bonded to its working instead of to a quote.
DERIVED_BASE_FIELDS = ("claimId", "claim", "method", "assumptions", "sensitivity", "applicability", "uncertainty")
CLAIM_ID_PATTERN = re.compile(r"^CLM-[0-9]{3,6}$")
DERIVED_REPORT_LABEL = re.compile(r"[〔［【(（\[]\s*(?:推导|推算|估算|derived|estimated)\s*[〕］】)）\]]", re.I)

# The heading the safety-first practical answer sits under. It was
# 安全优先的实际处置 and the manuscript rewrite renames it 临床实践要点; both
# names resolve to the same section on both sides, so a rename cannot silently
# turn every check on that section into "section not present".
PRACTICAL_SECTION_HEADING = "安全优先的实际处置|实际处置|实用回答|临床实践要点|临床要点|实用|怎么办|Practical"

# Register checks, mirrored field for field from clinicalEvidenceQuality.mjs.
# The server rejects a report written in the runtime's vocabulary, in the
# commissioning party's vocabulary, or as an acceptance specification; all three
# have to be catchable here, while the run can still edit the report.
OPERATIONAL_FAILURE = re.compile(
    r"(?:Transport error|Runtime configuration bootstrap|网页访问失败|工具调用失败"
    r"|public[_ -]source[_ -]gateway.*(?:failed|error))",
    re.I,
)
# 工件 / 访问层级 / 本环境 / 本轮检索 / 检索环境 are the runtime's own nouns for a
# preserved artifact, an accessLevel field, the container, and one retrieval
# pass; 加工件 and 基本环境/日本环境/样本环境 are ordinary words that contain
# them, so each is anchored away from its innocent compounds.
RUNTIME_LEAKAGE = re.compile(
    r"(?:clinical-evidence-synthesis|\bevimed_[a-z_]+\b|EviMed.{0,24}(?:引擎|网关|工具)|证据追溯契约"
    r"|\.evimed-sources/|(?:抓取|落盘).{0,16}(?:核验|来源|文件|原文)|白名单抓取|工具调用"
    r"|(?<!加)工件|访问层级|(?<![基日样标根成])本环境|本轮检索|检索环境"
    r"|(?:未触及|未读取|未检索).{0,16}(?:完整|全文|文件|页面))",
    re.I,
)
# A material limit on evidence accessibility is a legitimate property of the
# evidence base inside 局限性, and retrieval-process prose everywhere else.
EVIDENCE_ACCESS_LIMITATION = re.compile(
    r"(?:全文|页面|文件).{0,12}(?:不可及|无法获取|无法获得|未能获取|未能获得|不可得)",
    re.I,
)
# The commissioning party's vocabulary: the brief, the item bank, its metrics,
# the answer the run was scored against. A paper never says who asked for it.
COMMISSIONING_VOCABULARY = (
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
)
ACCEPTANCE_CONDITION_HEADING = re.compile(r"^#{2,4}\s*[^\n]*判定条件")
# `命题 A（发生率可定量）：……`. One such line can be a genuine reference to
# someone else's numbered proposition; a list of them is the acceptance form.
LETTERED_PROPOSITION = re.compile(r"^\s*(?:[-*+·•]\s*|\d+[.、)]\s*)?命题\s*[A-Za-z\d一二三四五六七八九十]{1,3}\s*[（(]")
# 判为/判定为 delivering a verdict. 判定 alone is ordinary clinical vocabulary
# (因果关系判定, 偏倚风险判定) and 误判为/错判为/研判为 are ordinary prose, so the
# verb alone proves nothing: what is rejected is a quoted verdict string, or a
# sentence scoring one of this report's own propositions — and even then only
# when no published grading instrument is named in the same sentence.
GRADING_VERB = re.compile(r"(?<![误错研])判定?为")
QUOTED_VERDICT = re.compile(r"(?<![误错研])判定?为\s*[「『“”\"'‘’]")
SELF_GRADED_SUBJECT = re.compile(r"命题|该角度|本角度|各角度|逐条判定|本报告|判定条件|交付判据|达标判据")
NAMED_APPRAISAL_INSTRUMENT = re.compile(
    r"GRADE|WHO[-‑\s]?UMC|Naranjo|诺氏|RoB\s?2|ROBINS[-‑]?I|QUADAS[-‑]?2|AMSTAR"
    r"|Newcastle[-‑\s]?Ottawa|纽卡斯尔|Jadad|Cochrane|CONSORT|PRISMA|STROBE|CTCAE",
    re.I,
)
# The paper talking about itself as the thing being delivered and checked,
# rather than about the evidence. Declaring the readership is the same class and
# was the shape no pattern covered: 本文以临床医师与药师为读者 opened a delivered
# report. Every reader branch is anchored to the paper as its subject, because
# the same words describe studied material — 以急性胸痛患者为研究对象 is a
# population and 该科普材料的受众对象为老年人 is a finding.
SELF_REFERENTIAL_NARRATION = re.compile(
    r"学术化版本|作为被评价对象"
    r"|(?:本报告|本文)[^。；\n]{0,16}(?:判定条件|交付判据|达标判据|验收依据|任务书|评分口径)"
    r"|(?:本报告|本文)[^。；\n]{0,10}拒绝[^。；\n]{0,24}(?:判据|验收|达标|指标)"
    r"|(?:本文|本报告|本研究|本综述|全文)[^。；\n]{0,16}"
    r"(?:以[^。；\n]{0,16}为(?:读者|受众|阅读对象)"
    r"|面向[^。；\n]{0,14}(?:读者|受众|医师|医生|药师|同行|从业者)"
    r"|写给[^。；\n]{0,14}(?:读者|受众|医师|医生|药师|同行|参考|阅读)"
    r"|(?:目标)?(?:读者|受众)(?:群体?|对象)?\s*(?:为|是|包括))"
)
# A verbatim support quote is a traceability device: its home is supportQuote in
# clinical-evidence-matrix.json and citation-ledger.csv, where it is checked
# against the preserved artifact. Behind a 原文： label in the body it is checked
# by nobody; one delivered report carried nine, three in a single paragraph.
PASTED_SOURCE_QUOTE = re.compile(r"(?:原文|原句)\s*[:：]")
# Latin-script function words stay lowercase inside a proper name, so a title is
# not read as a sentence merely because it contains them.
PROPER_NAME_FUNCTION_WORDS = frozenset(
    {"a", "an", "and", "at", "de", "for", "from", "in", "of", "on", "or", "the", "to", "van", "versus", "vs", "with"}
)
# English sentences are held together by closed-class words; enumerations of
# technical terms have none. A pharmacology manuscript legitimately lists drugs by
# INN, a mechanism paragraph names a signalling cascade, and an outcome definition
# lists its endpoints — all in lowercase Latin, all comma-separated, none of it a
# sentence: 硝酸酯类包括 isosorbide dinitrate, isosorbide mononitrate,
# nitroglycerin, glyceryl trinitrate, pentaerythritol tetranitrate, erythrityl
# tetranitrate, amyl nitrite, sodium nitroprusside 等 runs to fifteen words
# without one. Title Case exempts the named entities; this exempts the unnamed
# ones, and it costs no real detection — every pasted source sentence this rule
# exists for is ordinary prose and carries several of these.
PROSE_FUNCTION_WORDS = frozenset(
    {
        "a", "an", "the", "and", "or", "but", "not", "no", "of", "in", "on", "at", "to", "for", "from", "with",
        "without", "by", "as", "into", "than", "that", "which", "who", "whom", "whose", "this", "these", "those",
        "it", "its", "they", "their", "we", "our", "is", "are", "was", "were", "be", "been", "being", "has", "have",
        "had", "do", "does", "did", "can", "could", "should", "would", "may", "might", "must", "will", "shall", "if",
        "when", "while", "because", "although", "however", "therefore", "between", "among", "during", "after",
        "before", "over", "under", "per", "via", "such", "both", "either", "neither", "all", "any", "each", "more",
        "most", "less", "least", "only", "also", "other", "same", "then", "there", "up", "out", "about",
    }
)
# A database search strategy is Boolean syntax, not prose, and PRISMA asks for it
# verbatim. Two or more uppercase operators, or a field tag, identify one.
DATABASE_FIELD_TAG = re.compile(r"\[(?:mesh|majr|tiab|ti|ab|tw|all fields|title/abstract|pt|la|dp)[^\]]*\]", re.I)
BOOLEAN_OPERATOR = re.compile(r"(?<![A-Za-z])(?:AND|OR|NOT)(?![A-Za-z])")
# Everything a Latin sentence may contain without interruption. Any other
# character — a CJK glyph, CJK punctuation, a table pipe — ends the run, so
# English words threaded through a Chinese sentence never accumulate.
RUN_INTERRUPT = re.compile(r"[^A-Za-z0-9\s.,;:'’()\[\]%/&+\-–—<>=\"*#]")
LATIN_WORD = re.compile(r"[A-Za-z][A-Za-z'’]*(?:-[A-Za-z][A-Za-z'’]*)*")
SHORT_QUOTED_SPAN = re.compile(r"[“\"「『]([^”\"」』]{0,600})[”\"」』]")
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
INLINE_CODE = re.compile(r"`[^`]*`")
MARKDOWN_LINK = re.compile(r"!?\[([^\]\n]*)\]\([^)\s]*\)")
WEB_ADDRESS = re.compile(r"https?://\S+|www\.[A-Za-z0-9.-]+\S*", re.I)
DOI_ADDRESS = re.compile(r"\b10\.\d{4,9}/\S+")
CODE_FENCE = re.compile(r"^\s*(?:```|~~~)")
TABLE_ROW = re.compile(r"^\s*\|")
# A quotation the body may carry: a short phrase or a single sentence, inside
# quotation marks, grammatically inside the Chinese sentence around it. Twenty
# words is a generous sentence; past it the "quotation" is a paragraph.
PERMITTED_QUOTED_WORDS = 20
# The run length that separates a name from a sentence. The longest strings a
# Chinese manuscript legitimately carries untranslated are proper names and their
# expansions — PRISMA and STROBE at 8 words, the 2021 chest-pain guideline title
# at 9 — and those are exempt as Title Case anyway. Every pasted source sentence
# in the report that prompted this rule ran 15 words or longer.
UNTRANSLATED_PROSE_WORDS = 12
# Absent evidence is a gap, not a counter-finding. The three parts are required
# in this order and in one sentence — the failed search, a causal connective, and
# a verdict on the intervention — because the gap stated on its own is the
# correct writing: 未检索到支持其用于该场景的直接证据 is what the run is asked to
# write, and 未检索到直接证据，故该药无效 is the error. Only causal connectives
# count: 未检索到证据表明其无效 puts the verdict inside the scope of the search.
ABSENT_EVIDENCE = re.compile(
    r"(?:未检索到|未能检索到|未检索出|未发现|未找到|未见|尚未检索到|缺乏|缺少|尚无|没有)"
    r"[^。；\n]{0,24}(?:直接证据|随机对照(?:试验)?证据|随机对照试验|头对头(?:比较|研究|试验)?|对照研究|临床证据|循证证据|RCT)"
)
EVIDENCE_INFERENCE_MARKER = re.compile(r"(?:因此|因而|所以|故|可见|由此|据此|从而|于是)")
# A verdict on the intervention, not on the evidence. 不足以支持 / 不足以判断 are
# the wordings the skill prescribes for a gap, so every recommendation verb here
# requires its object (使用/应用/将…).
NEGATIVE_VERDICT = re.compile(
    r"(?:无效|无疗效|没有疗效|无临床(?:价值|获益)|不(?:推荐|建议)(?:使用|应用|采用|服用|将)"
    r"|不(?:应|宜|得)(?:使用|应用|服用)|应(?:避免|停止)使用|不支持(?:使用|将))"
)
# Reporting the recommendation somebody else made is citation, not inference.
ATTRIBUTED_RECOMMENDATION = re.compile(r"(?:指南|共识|说明书|标签|药监|监管|批准|建议书|WHO|FDA|EMA|NMPA|NICE)")
# --- Comparative structure, mirrored from clinicalEvidenceQuality.mjs --------
# Two defects of a comparison are decidable from the document alone and the
# server rejects both, so both have to be catchable here.
#
# A title announcing a comparison over a body that never puts the arms side by
# side: 对比剂 is an ordinary pharmacology noun containing 对比, so it is
# anchored away from it.
COMPARATIVE_TITLE = re.compile(
    r"比较|对比(?!剂)|优劣|孰优|头对头|head[-\s]?to[-\s]?head|versus|(?<![A-Za-z])vs\.?(?![A-Za-z])",
    re.I,
)
# A report that states no direct comparison was found and then concludes that
# one arm may take the other's place has contradicted itself: the licence a
# substitution claim needs is the comparison the report says does not exist.
DIRECT_COMPARISON_ABSENT = re.compile(
    r"(?:未检索到|未能检索到|未检索出|未发现|未找到|未见|尚未检索到|缺乏|缺少|尚无|没有|不存在)"
    r"[^。；\n]{0,30}(?:头对头|直接比较|直接对比|head[-\s]?to[-\s]?head)"
    r"|(?:头对头|直接比较|直接对比|head[-\s]?to[-\s]?head)"
    r"[^。；\n]{0,30}(?:未检索到|未能检索到|缺乏|缺少|尚无|没有|不存在|空缺|阙如)",
    re.I,
)
# Swapping one arm for the other is stated by the verb alone, and 优于 is
# relational by itself. A bare comparative adjective is not: 该人群的依从性更好
# compares a property of one population against nothing in particular. It counts
# only where the sentence says what is being compared (前者/后者/两者/相比) or the
# clause makes it a choice between arms (更合适的选择).
SUBSTITUTION_VERB = re.compile(r"(?:替代|代替|取代|改用|换用|优于)")
COMPARATIVE_QUALITY = re.compile(r"更(?:为|加)?(?:优|佳|好|可靠|安全|有效|适合|合适)")
COMPARISON_ANCHOR = re.compile(r"前者|后者|两者|二者|相比|相较|较之")
CHOICE_NOUN = re.compile(r"选择|方案|之选|首选")
# What is not a substitution claim, read in the clause carrying the verb: a
# negation, the comparator a trial uses inside itself, and the thing a medicine
# may never replace — 任何药物都不能替代及时就医 is a safety instruction.
SUBSTITUTION_NEGATION = re.compile(r"[不无未非勿]|尚(?:待|需)|缺乏|缺少|难以|有待|仍需|避免|除外|排除")
# Asking is not answering. 低反应者是否应改用另一药 is the open question this
# whole rule exists to keep open, and it carries the verb while concluding
# nothing. Read in the clause, like the negation, so an interrogative frame
# cannot license a conclusion standing beside it.
OPEN_QUESTION = re.compile(r"是否|能否|可否|有无|[?？]")
# Which evidence base is stronger is a statement about the literature, not about
# the medicines, and stating it is what a fixed-axis comparison is for: an axis
# may hold measured evidence on one arm and nothing on the other without any
# head-to-head study existing anywhere. It counts only where the comparative
# attaches to the evidence itself — 资料显示该制剂优于… is a claim about the
# medicines that happens to open with a source noun.
EVIDENCE_BASE_COMPARISON = re.compile(
    r"(?:证据|研究|数据|文献|资料|报道|记录)(?:强度|质量|基础|数量|完整性|一致性|等级|确定性)?"
    r"(?:[比较][^，。；\n]{0,12})?(?:更(?:为|加)?(?:充分|完整|可靠|一致|丰富|扎实)|优于)"
)
# The repair this rule asks for is the bridge written out one link per line,
# each marked 已建立 or 未建立 — and the unestablished links are word for word
# the sentences it would otherwise read as conclusions (低反应者改用 B 后结局更
# 好). The mark licenses the link it marks: it may sit in a neighbouring clause
# (……后结局更好，该环未建立) or in a following sentence that is nothing but the
# mark (……后结局更好。该环未建立。). Only the unestablished mark licenses
# anything — a link asserted 已建立 without the study behind it is the
# conclusion itself.
UNESTABLISHED_LINK = re.compile(r"(?:尚)?未(?:能|被|获)?(?:建立|证实|验证|确证)")
BARE_LINK_MARK_CHARACTERS = 20
INTERNAL_COMPARATOR = re.compile(r"安慰剂|placebo|空白|对照组|基线|常规治疗|标准治疗|假(?:手术|针刺)|治疗前", re.I)
NON_MEDICINE_OBJECT = re.compile(
    r"专业评估|规范评估|医疗评估|临床评估|系统评估|就医|就诊|急救|急诊|120|心电图|肌钙蛋白|检查|诊断|问诊|随访"
)
# Reporting the comparison somebody else made is citation, not inference.
ATTRIBUTED_COMPARISON = re.compile(
    r"指南|共识|说明书|标签|药监|监管|批准|建议书|WHO|FDA|EMA|NMPA|NICE"
    r"|该(?:研究|试验|综述|分析|队列|荟萃)|一项[^。；\n]{0,12}(?:研究|试验)|荟萃分析|Meta\s?分析|系统评价|系统综述",
    re.I,
)
CLAUSE_SPLIT = re.compile(r"[，,、]")
TABLE_PIPE = re.compile(r"\|")
TABLE_DELIMITER_ROW = re.compile(r"^[\s:|-]+$")
# Advisory only (see notes in main): one arm graded, another vouched for by
# tradition, is the asymmetry "One ruler for every arm" exists to prevent — but
# which nouns are the compared arms is not decidable from the text, so this is
# reported to the run and never blocks.
COMPARISON_QUESTION = re.compile(r"比较|对比|头对头|优劣|孰优|versus|\bvs\.?\b", re.I)
# Advisory only. A cross-arm blanket negation ("两药……均缺乏证据") is the shape a
# merged PICO takes in a sentence, and the fallback test for the merge is that
# the report never names a stratum anywhere. Both halves are heuristics — a
# question whose population genuinely has no strata writes the same sentence
# correctly — so this is reported and never blocks. A shared absence of
# head-to-head evidence is excluded: that one is true of every stratum at once.
CROSS_ARM_BLANKET_NEGATION = re.compile(
    r"(?:两(?:药|者|种药物?|类药物?|型)|二者|双方|各药)[^。；\n]{0,40}(?:均|都)[^。；\n]{0,20}"
    r"(?:缺乏|缺少|尚无|没有|无|未检索到|未见|未发现)[^。；\n]{0,20}(?:证据|研究|数据|试验)"
)
# A stratum is named by what is already established about the patient. 分层 on
# its own is not one of these words: 分层评估的分析路径 and 危险分层 are ordinary
# clinical prose about triage, and reading them as a named stratum silenced this
# note on a report that had named none.
POPULATION_STRATUM = re.compile(
    r"已确诊|确诊|初发|首发|首次(?:发生|发作)|既往|病史|未分化|未确诊|病因(?:未明|不明)"
    r"|稳定型|不稳定型|新发|亚组|按[^。；\n]{0,10}分层|分层[^。；\n]{0,2}人群|人群分层"
)
DIRECT_COMPARISON_MENTION = re.compile(r"头对头|直接比较|直接对比|head[-\s]?to[-\s]?head", re.I)
# Advisory only. 摘要 目的 lists the research questions and 结论 answers them one
# for one; when both are enumerated, the counts are comparable. Only then — a
# prose 结论 may answer three questions in three sentences, and no count can say
# whether it did.
ABSTRACT_PURPOSE = re.compile(r"目的[:：]?\s*(.*?)(?=(?:方法|资料|材料|结果|结论)\s*[:：]|$)", re.S)
CJK_ORDINALS = "一二三四五六七八九十"
CIRCLED_DIGITS = "①②③④⑤⑥⑦⑧⑨⑩"
CERTAINTY_APPRAISAL = re.compile(r"GRADE|确定性|证据等级|证据质量|证据体质量")
TRADITION_APPRAISAL = re.compile(
    r"长期(?:临床)?(?:使用|应用|实践|经验)|广泛(?:使用|应用|采用)|指南(?:推荐|支持|建议)"
    r"|久经(?:临床)?(?:使用|考验)|临床经验支持|沿用已久|一线(?:用药|药物)地位"
)
SENTENCE_SPLIT = re.compile(r"(?<=[。！？；;])")


def check_claim(index: int, claim: dict, issues: list[str]) -> None:
    if claim.get("claimType", "direct") == "synthesized":
        for field in SYNTHESIZED_BASE_FIELDS:
            if not isinstance(claim.get(field), str) or not claim[field].strip():
                issues.append(f"clinical-evidence-matrix.json: claims[{index}].{field} is empty")
        if claim.get("confidence") not in CONFIDENCE_LEVELS:
            issues.append(f"clinical-evidence-matrix.json: claims[{index}].confidence is invalid")
        sources = claim.get("supportingSources")
        if not isinstance(sources, list) or len(sources) < 2:
            issues.append(f"clinical-evidence-matrix.json: claims[{index}].supportingSources needs two sources")
            sources = sources if isinstance(sources, list) else []
        for source_index, source in enumerate(sources):
            if not isinstance(source, dict):
                issues.append(
                    f"clinical-evidence-matrix.json: claims[{index}].supportingSources[{source_index}] must be an object"
                )
                continue
            for field in SYNTHESIZED_SOURCE_FIELDS:
                if not isinstance(source.get(field), str) or not source[field].strip():
                    issues.append(
                        f"clinical-evidence-matrix.json: claims[{index}].supportingSources[{source_index}].{field} is empty"
                    )
        reference_numbers = claim.get("referenceNumbers")
        reference_number = claim.get("referenceNumber")
        if (
            not isinstance(reference_numbers, list)
            or len(reference_numbers) < 2
            or any(not isinstance(entry, int) or entry < 1 for entry in reference_numbers)
        ):
            issues.append(f"clinical-evidence-matrix.json: claims[{index}].referenceNumbers is invalid")
        elif reference_number not in reference_numbers:
            issues.append(
                f"clinical-evidence-matrix.json: claims[{index}].referenceNumber must be one of its referenceNumbers"
            )
        return
    if claim.get("claimType", "direct") == "derived":
        for field in DERIVED_BASE_FIELDS:
            if not isinstance(claim.get(field), str) or not claim[field].strip():
                issues.append(f"clinical-evidence-matrix.json: claims[{index}].{field} is empty")
        inputs = claim.get("derivedFrom")
        if not isinstance(inputs, list) or not inputs:
            issues.append(f"clinical-evidence-matrix.json: claims[{index}].derivedFrom must list the claims it reasons from")
        elif any(not isinstance(entry, str) or not CLAIM_ID_PATTERN.match(entry) for entry in inputs):
            issues.append(f"clinical-evidence-matrix.json: claims[{index}].derivedFrom entries must match CLM-NNN")
        elif claim.get("claimId") in inputs:
            issues.append(f"clinical-evidence-matrix.json: claims[{index}].derivedFrom must not include the claim itself")
        # The method is the audit trail that replaces the missing quote, so it
        # has to show the step rather than name it.
        method = claim.get("method")
        if isinstance(method, str) and method.strip() and len(method.strip()) < 40:
            issues.append(f"clinical-evidence-matrix.json: claims[{index}].method must show the working, not name it")
        return
    if claim.get("claimType", "direct") != "direct":
        issues.append(
            f'clinical-evidence-matrix.json: claims[{index}].claimType must be "direct", "synthesized" or "derived"'
        )
        return
    for field in REQUIRED_CLAIM_FIELDS:
        if not isinstance(claim.get(field), str) or not claim[field].strip():
            issues.append(f"clinical-evidence-matrix.json: claims[{index}].{field} is empty")


def load_text(root: Path, name: str, issues: list[str]) -> str:
    path = root / name
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        issues.append(f"{name}: unreadable: {exc}")
        return ""
    if not text.strip():
        issues.append(f"{name}: empty")
    return text


def load_json(root: Path, name: str, issues: list[str]) -> dict:
    text = load_text(root, name, issues)
    if not text:
        return {}
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        issues.append(f"{name}: invalid JSON at line {exc.lineno} column {exc.colno}")
        return {}
    if not isinstance(value, dict):
        issues.append(f"{name}: top level must be an object")
        return {}
    return value


def section(report: str, heading: str) -> str:
    match = re.search(
        rf"(?:^|\n)##\s+[^\n]*(?:{heading})[^\n]*\n([\s\S]*?)(?=\n##\s+|$)",
        report,
        re.IGNORECASE,
    )
    return match.group(1) if match else ""


def without_sections(report: str, heading: str) -> str:
    """Blank the named sections, keeping the line count so reported line numbers
    still point at the line the author will find in the file."""
    return re.sub(
        rf"(?:^|\n)##\s+[^\n]*(?:{heading})[^\n]*\n[\s\S]*?(?=\n##\s+|$)",
        lambda match: "\n" * match.group(0).count("\n"),
        report,
        flags=re.I,
    )


def excerpt(line: str) -> str:
    trimmed = line.strip()
    return trimmed if len(trimmed) <= 96 else trimmed[:96] + "…"


def self_graded_verdict(line: str) -> str:
    """A verdict verb used to score this report's own proposition, or "" when
    the sentence is ordinary clinical prose or the report of a named instrument."""
    for sentence in SENTENCE_SPLIT.split(line):
        if not GRADING_VERB.search(sentence):
            continue
        if NAMED_APPRAISAL_INSTRUMENT.search(sentence):
            continue
        if not QUOTED_VERDICT.search(sentence) and not SELF_GRADED_SUBJECT.search(sentence):
            continue
        return excerpt(sentence)
    return ""


def reads_as_proper_name(words: list[str]) -> bool:
    """A run of Latin words is a name rather than a sentence when every word that
    is not a lowercase connective carries a capital, as journal, organisation,
    instrument, guideline and trial names do and prose does not."""
    carried = [word for word in words if word.lower() not in PROPER_NAME_FUNCTION_WORDS]
    return bool(carried) and all(word[:1].isupper() for word in carried)


def reads_as_term_list(words: list[str]) -> bool:
    """A run of Latin words is an enumeration of technical terms rather than a
    sentence when it carries no closed-class word: prose is held together by
    them, a list of drug INNs, pathway molecules or endpoints is not."""
    return not any(word.lower() in PROSE_FUNCTION_WORDS for word in words)


def reads_as_database_query(segment: str) -> bool:
    return bool(DATABASE_FIELD_TAG.search(segment)) or len(BOOLEAN_OPERATOR.findall(segment)) >= 2


def untranslated_prose_run(line: str) -> tuple[int, str] | None:
    """A run of untranslated source prose on one line of the body, or None when
    the line's Latin script is names, identifiers, units, statistics, or a short
    quoted phrase carried inside a Chinese sentence.

    The body states each finding in Chinese with its numbered citation; a reader
    who wants the original wording follows the citation and an auditor reads the
    matrix. A paragraph of source sentences in the body is the traceability
    device pasted where nothing checks it."""
    # Anything removed rather than measured leaves a break behind it, so two
    # separate Latin fragments never merge into one run.
    cut = "\x00"
    text = HTML_COMMENT.sub(cut, line)
    text = INLINE_CODE.sub(cut, text)
    text = MARKDOWN_LINK.sub(lambda match: match.group(1) + cut, text)
    text = WEB_ADDRESS.sub(cut, text)
    text = DOI_ADDRESS.sub(cut, text)
    # A short direct quotation is allowed: the exact wording is sometimes itself
    # the object of analysis — an indication clause, a recommendation class, a
    # contested definition. Past a sentence it is no longer a short quotation, so
    # the span stays in and is measured with everything else.
    text = SHORT_QUOTED_SPAN.sub(
        lambda match: cut if len(LATIN_WORD.findall(match.group(1))) <= PERMITTED_QUOTED_WORDS else match.group(0),
        text,
    )
    for segment in RUN_INTERRUPT.sub(cut, text).split(cut):
        words = LATIN_WORD.findall(segment)
        if len(words) < UNTRANSLATED_PROSE_WORDS:
            continue
        if reads_as_proper_name(words) or reads_as_term_list(words) or reads_as_database_query(segment):
            continue
        return len(words), excerpt(segment)
    return None


def absent_evidence_as_counter_finding(line: str) -> str:
    """A sentence that answers the question with the failure of its own search,
    or "" when the sentence states the gap and stops there."""
    for sentence in SENTENCE_SPLIT.split(line):
        absent = ABSENT_EVIDENCE.search(sentence)
        if not absent:
            continue
        after = sentence[absent.end():]
        marker = EVIDENCE_INFERENCE_MARKER.search(after)
        if not marker:
            continue
        if not NEGATIVE_VERDICT.search(after[marker.end():]):
            continue
        # Reporting the recommendation somebody else made is citation, not
        # inference. The split is per clause, so naming a body in a neighbouring
        # clause does not license the inference in this one.
        if ATTRIBUTED_RECOMMENDATION.search(sentence):
            continue
        return excerpt(sentence)
    return ""


def check_register(report: str, issues: list[str]) -> None:
    """The report is a scientific paper about a clinical question, never a paper
    about the task that produced it. Three registers give that away — the
    runtime's, the commissioning party's, and an acceptance specification's —
    and the server rejects all three, so they are caught here first."""
    lines = report.split("\n")
    for line_number, line in enumerate(lines, 1):
        if OPERATIONAL_FAILURE.search(line):
            issues.append(
                f"clinical-evidence-report.md line {line_number}: operational failure prose "
                f"({excerpt(line)}) belongs only in the run receipt, not in the academic report"
            )
            break
    outside_limitations = without_sections(report, "局限|Limitations?").split("\n")
    for line_number, (line, outside) in enumerate(zip(lines, outside_limitations), 1):
        if not RUNTIME_LEAKAGE.search(line) and not EVIDENCE_ACCESS_LIMITATION.search(outside):
            continue
        issues.append(
            f"clinical-evidence-report.md line {line_number}: runtime or retrieval-process prose "
            f"({excerpt(line)}). Write what the evidence shows, not how it was obtained — the run's tools, "
            "gateways, preserved artifacts (工件), access levels (访问层级), environment (本环境) and "
            "retrieval passes (本轮检索) belong in the run receipt; a source you could not obtain is stated "
            "as a limitation of the evidence base inside 局限性, in the reader's terms"
        )
        break

    body_text = without_sections(report, "参考文献|参考来源|References?")
    body = body_text.split("\n")
    # A database search strategy is written in the source language by design and
    # belongs in 资料与方法, so the untranslated-prose rule alone reads a copy with
    # that section blanked. Line numbers survive the blanking, as everywhere else.
    prose = without_sections(body_text, "检索|方法|Methods?").split("\n")
    named_terms: set[str] = set()
    proposition_lines: list[int] = []
    proposition_sample = ""
    headings = 0
    verdicts = 0
    narrations = 0
    quotations = 0
    untranslated = 0
    counter_findings = 0
    inside_code_fence = False
    for line_number, line in enumerate(body, 1):
        fence = bool(CODE_FENCE.match(line))
        if fence:
            inside_code_fence = not inside_code_fence
        for term in COMMISSIONING_VOCABULARY:
            if term not in line or term in named_terms:
                continue
            named_terms.add(term)
            issues.append(
                f"clinical-evidence-report.md line {line_number}: commissioning vocabulary {term!r} "
                f"({excerpt(line)}). A paper never names the brief it was written for, the item bank the "
                "question came from, the metrics it was scored against, or the answer that was expected. "
                "Restate the underlying clinical proposition in the literature's own words and evaluate that "
                'instead — 例如把"题库目标答案X无证据支持"改写为"对于X这一说法，未检索到以临床结局为终点的研究"'
            )
        if headings < 4 and ACCEPTANCE_CONDITION_HEADING.search(line):
            headings += 1
            issues.append(
                f"clinical-evidence-report.md line {line_number}: section named after an acceptance condition "
                f"({excerpt(line)}). A reader judges what kind of document this is from the section names, and "
                "判定条件 announces a reviewer's checklist. Use the manuscript sections (摘要 / 引言 / 资料与方法 / "
                "结果 / 讨论 / 局限性 / 结论 / 临床实践要点 / 参考文献): state the question and the objective in "
                "引言, and write the evidence bar as the evidence-appraisal criteria in 资料与方法"
            )
        if LETTERED_PROPOSITION.search(line):
            proposition_lines.append(line_number)
            if not proposition_sample:
                proposition_sample = excerpt(line)
        verdict = self_graded_verdict(line) if verdicts < 4 else ""
        if verdict:
            verdicts += 1
            issues.append(
                f"clinical-evidence-report.md line {line_number}: 判为/判定为 delivers a verdict on the report's "
                f"own proposition ({verdict}). Grading your own conclusions against a scale you invented prints "
                "the acceptance form into the paper. Use the verbs of evidence — 提示、支持、不足以支持、"
                "未检索到……的证据 — or, when you are applying a published instrument, name it and report its own "
                'level (按 WHO-UMC 评定为"可能有关"、按 GRADE 为低确定性)'
            )
        if narrations < 4 and SELF_REFERENTIAL_NARRATION.search(line):
            narrations += 1
            issues.append(
                f"clinical-evidence-report.md line {line_number}: the report writes about itself rather than "
                f"about the evidence ({excerpt(line)}). The paper describes evidence and reasoning, never what "
                "this report is, what it refuses to do, or what it was checked against. State the objective "
                "plainly in 引言 (本文旨在评价……) and delete the rest; if a scientific question is buried in the "
                "sentence, ask it scientifically. A paper never announces whom it is written for: state in "
                "资料与方法 which population and care setting the evidence applies to, and discuss extrapolation in 讨论"
            )
        if quotations < 4 and PASTED_SOURCE_QUOTE.search(line):
            quotations += 1
            issues.append(
                f"clinical-evidence-report.md line {line_number}: a source quotation is pasted into the body "
                f"behind a 原文： label ({excerpt(line)}). A verbatim quote is a traceability device: it lives in "
                "the supportQuote field of clinical-evidence-matrix.json and the supportQuote column of "
                "citation-ledger.csv, where it is checked against the preserved artifact — in the body it is "
                "checked by nobody and adds no verifiability. State the finding in Chinese in the paper's own "
                "voice with its numbered citation, and where the exact wording is itself the object of analysis, "
                'quote a short phrase inside quotation marks, grammatically inside the Chinese sentence '
                '(该说明书将适应症限定为"气滞血瘀型冠心病心绞痛"[7])'
            )
        foreign = (
            untranslated_prose_run(prose[line_number - 1] if line_number <= len(prose) else "")
            if untranslated < 4 and not inside_code_fence and not fence and not TABLE_ROW.match(line)
            else None
        )
        if foreign:
            untranslated += 1
            words, sample = foreign
            issues.append(
                f"clinical-evidence-report.md line {line_number}: {words} consecutive words of untranslated "
                f"source prose ({sample}). The body states each finding in Chinese with its numbered citation; a "
                "reader who wants the original wording follows the citation and an auditor reads the matrix. "
                "Restate the passage in Chinese with its citation, and keep any genuinely necessary quotation to "
                "a short phrase inside quotation marks — names, identifiers, units and statistics (ALDH2、rs671、"
                "GRADE、Naranjo、P < 0.01、RR 0.82) are unaffected"
            )
        counter_finding = absent_evidence_as_counter_finding(line) if counter_findings < 4 else ""
        if counter_finding:
            counter_findings += 1
            issues.append(
                f"clinical-evidence-report.md line {line_number}: absent evidence is turned into a "
                f"counter-finding ({counter_finding}). A search that returned nothing is insufficient evidence to "
                "judge, never evidence of no effect, so it cannot carry 无效／不推荐使用／不支持使用. Write the gap "
                "as a gap and name the study that would close it — design, population, comparator, outcome, order "
                "of magnitude of sample (未检索到在该场景中以临床结局为终点的随机对照研究，现有证据不足以判断其在"
                "该场景的效能). If a body actually recommended against use, name the body and cite it"
            )
    if len(proposition_lines) >= 2:
        listed = ", ".join(str(number) for number in proposition_lines[:8])
        issues.append(
            f"clinical-evidence-report.md lines {listed}: lettered propositions with their own pass/fail "
            f"conditions ({proposition_sample}). That is the reviewer's acceptance form printed inside the "
            "manuscript. Dissolve it: what evidence a conclusion of each kind must rest on belongs in 资料与方法 "
            "as continuous methods prose, and what each line of evidence established belongs in 结果 and 讨论 as "
            "a finding — never carried forward as a per-proposition verdict"
        )


def table_cells(line: str) -> list[str]:
    """The cells of a markdown table row, or [] when the line is not one."""
    if len(TABLE_PIPE.findall(line)) < 2:
        return []
    text = line.strip()
    if text.startswith("|"):
        text = text[1:]
    if text.endswith("|"):
        text = text[:-1]
    return [cell.strip() for cell in text.split("|")]


def table_delimiter_row(line: str) -> bool:
    text = line.strip()
    return bool(TABLE_DELIMITER_ROW.match(text)) and "-" in text and len(TABLE_PIPE.findall(text)) >= 2


def has_comparison_matrix(text: str) -> bool:
    """Does the body carry a table that could be the comparison matrix — an axis
    column plus one column per arm, filled for more than one row?

    Three columns and two rows is the smallest such table, and it accepts the
    transposed layout (arms as rows, axes as columns) as readily as the usual
    one. A table of something else satisfies it too; that is the intended
    direction of the error, since the alternative is guessing which columns are
    the arms and withholding a package on the guess."""
    lines = text.split("\n")
    for index, line in enumerate(lines):
        if index == 0 or not table_delimiter_row(line):
            continue
        if len(table_cells(lines[index - 1])) < 3:
            continue
        rows = 0
        following = index + 1
        while following < len(lines) and len(table_cells(lines[following])) >= 2:
            rows += 1
            following += 1
        if rows >= 2:
            return True
    return False


def substitution_conclusion(line: str) -> str:
    """A sentence concluding that one arm may take the other's place or beats
    it, or "" when the sentence writes a bridge link that is marked
    unestablished, or the clause carrying the verb is negated, asks rather than
    answers, compares the evidence bases, compares against a trial's own
    control, names something a medicine may never replace, or reports the
    comparison somebody else made."""
    sentences = SENTENCE_SPLIT.split(line)
    for index, sentence in enumerate(sentences):
        if ATTRIBUTED_COMPARISON.search(sentence):
            continue
        following = sentences[index + 1] if index + 1 < len(sentences) else ""
        if UNESTABLISHED_LINK.search(sentence) or (
            len(following.strip()) <= BARE_LINK_MARK_CHARACTERS and UNESTABLISHED_LINK.search(following)
        ):
            continue
        # What is being compared may be named a clause away (两者相比，该制剂更安全),
        # but the negation that would license the clause may not: it has to sit
        # in the clause that carries the claim.
        anchored = bool(COMPARISON_ANCHOR.search(sentence))
        for clause in CLAUSE_SPLIT.split(sentence):
            claimed = bool(SUBSTITUTION_VERB.search(clause)) or (
                bool(COMPARATIVE_QUALITY.search(clause)) and (anchored or bool(CHOICE_NOUN.search(clause)))
            )
            if not claimed:
                continue
            if SUBSTITUTION_NEGATION.search(clause) or OPEN_QUESTION.search(clause):
                continue
            if EVIDENCE_BASE_COMPARISON.search(clause):
                continue
            if INTERNAL_COMPARATOR.search(clause) or NON_MEDICINE_OBJECT.search(clause):
                continue
            return excerpt(sentence)
    return ""


def comparative_body(report: str) -> str:
    """The report with the reference list and 检索与方法 blanked: a cited title
    may announce anybody's comparison, and a search strategy names comparators
    it searched for while concluding nothing. Line counts survive the blanking,
    so a reported line number is the line the author will find in the file."""
    return without_sections(without_sections(report, "参考文献|参考来源|References?"), "检索|方法|Methods?")


def check_comparative_structure(report: str, issues: list[str]) -> None:
    """The two defects of a comparison the server rejects: a comparison the
    title announces and the body never carries out, and a substitution claim the
    report has already said it has no evidence for."""
    title_match = re.search(r"^#\s+(.+)$", report, re.M)
    title = title_match.group(1).strip() if title_match else ""
    body = comparative_body(report)
    if title and COMPARATIVE_TITLE.search(title) and not has_comparison_matrix(body):
        issues.append(
            f"clinical-evidence-report.md: the title announces a comparison ({excerpt(title)}) but no table in the "
            "analysis body sets the arms side by side. Reviewing one arm's literature, then the other's, and closing "
            "with a shared verdict is not a comparison: the two accounts never meet, and the verdict comes from "
            "whichever arm had the thinner file. Fix the axes first, then fill every arm on every axis — 核准适用场景 / "
            "急性按需使用证据（研究对象、结局、起效时间）/ 长期治疗证据 / 人群反应差异 / 安全性与禁忌 / 是否存在直接比较研究 / "
            "该维度可支持的结论边界 — as a table with one column per arm and the boundary as its last column. An axis with "
            "nothing behind it is a result, written 未检索到 with what was searched; it stays inside its row and never "
            "becomes the verdict of the table, and each factual cell carries its numbered citation and hidden claim marker"
        )
    absent_line = 0
    absent_text = ""
    for line_number, line in enumerate(body.split("\n"), 1):
        if DIRECT_COMPARISON_ABSENT.search(line):
            absent_line, absent_text = line_number, excerpt(line)
            break
    if not absent_line:
        return
    for line_number, line in enumerate(body.split("\n"), 1):
        conclusion = substitution_conclusion(line)
        if not conclusion:
            continue
        issues.append(
            f"clinical-evidence-report.md line {line_number}: the report concludes that one arm can take the other's "
            f"place ({conclusion}), while line {absent_line} states that the direct comparison behind such a "
            f"conclusion was not found ({absent_text}). A mechanism that acts on one arm is not evidence about the "
            "other, and an arm never tested for it is untested rather than immune. Write the chain out one link per "
            "line in 讨论, each marked 已建立 or 未建立 with the evidence or the missing study behind the mark "
            "(该变异在目标人群中常见 / 携带者对 A 的反应降低 / B 不经该通路 / 低反应者改用 B 后结局更好 / "
            "B 可在该场景替代 A), and stop the conclusion at the last established link: 该差异提示院外用药效果可能存在"
            "显著个体差异，另一药具有不同的组成与证据路径，其在该亚群中的相对价值仍需直接临床研究验证"
        )
        return


def enumerated_count(text: str) -> int:
    """How many items an enumeration lists, counting only markers that run 1, 2,
    3 … from the start. A lone 「（3）」 inside a sentence is a cross-reference to
    somebody else's third item, not a list of three."""
    best = 0
    for markers in (
        lambda n: (f"（{n}）", f"({n})"),
        lambda n: ((f"{CJK_ORDINALS[n - 1]}、", f"（{CJK_ORDINALS[n - 1]}）", f"({CJK_ORDINALS[n - 1]})")
                   if n <= len(CJK_ORDINALS) else ()),
        lambda n: (CIRCLED_DIGITS[n - 1],) if n <= len(CIRCLED_DIGITS) else (),
    ):
        count = 0
        while count < 12 and any(marker in text for marker in markers(count + 1)):
            count += 1
        best = max(best, count)
    count = 0
    while count < 12 and re.search(rf"^\s*{count + 1}[.、)]\s*\S", text, re.M):
        count += 1
    return max(best, count)


def section_shares(report: str) -> dict[str, int]:
    """Each level-two section's share of the body, in percent of non-blank
    characters, with the reference list left out. Length is a claim about
    importance, and the shares that fit a comparison question are roughly 50%
    for the comparison between arms, 25% to 30% for population heterogeneity and
    10% to 15% for the safety boundary — magnitudes to check against, never a
    quota to write toward. Which section serves which question is not decidable
    here, so the run is given the measurement and applies the rule itself."""
    body = without_sections(report, "参考文献|参考来源|References?")
    sections: list[tuple[str, int]] = []
    heading = ""
    size = 0
    for line in body.split("\n"):
        match = re.match(r"^##\s+(.+?)\s*$", line)
        if match:
            if heading:
                sections.append((heading, size))
            heading, size = match.group(1), 0
            continue
        if heading:
            size += len("".join(line.split()))
    if heading:
        sections.append((heading, size))
    total = sum(size for _, size in sections)
    if not total:
        return {}
    return {name: round(size * 100 / total) for name, size in sections}


def comparative_structure_notes(report: str) -> list[str]:
    """Advice, never a blocking issue.

    Each of these reads a real defect the commissioning reviewers named, and
    each rests on a judgement no pattern can make: which nouns are the compared
    arms, whether a question in 目的 was answered in prose, whether the
    population of this question has strata at all. A rule that cannot be decided
    must not be able to withhold a finished package, so these are reported to
    the run while it can still act, and the server has no counterpart."""
    notes: list[str] = []
    body = comparative_body(report)
    purpose = ABSTRACT_PURPOSE.search(section(report, "摘要"))
    questions = enumerated_count(purpose.group(1)) if purpose else 0
    answers = enumerated_count(section(report, "结论"))
    if questions >= 2 and answers >= 2 and questions != answers:
        notes.append(
            f"clinical-evidence-report.md: 摘要 目的 lists {questions} research questions and 结论 gives {answers} "
            "numbered answers. 结论 answers the questions of 目的 in the same order, one answer per question. A "
            "question with no answer was either unanswerable — write it as a gap, with the study that would close "
            "it — or was dropped, which is a restatement and is declared: say which question was asked, what in it "
            "does not survive contact with the evidence, what replaces it, and what the replacement can settle. An "
            "answer matching no question in 目的 is the object of study drifting toward an easier question"
        )
    stratified = bool(POPULATION_STRATUM.search(body))
    for line_number, line in enumerate(body.split("\n"), 1):
        if stratified or not CROSS_ARM_BLANKET_NEGATION.search(line) or DIRECT_COMPARISON_MENTION.search(line):
            continue
        notes.append(
            f"clinical-evidence-report.md line {line_number}: one verdict is given for every arm at once "
            f"({excerpt(line)}) and no stratum is named anywhere in the report. A setting named in the question "
            "(院外自救, 基层首诊, 居家用药) is not a population: inside it sit groups whose evidentiary position "
            "differs — 已确诊冠心病或心绞痛按既往医嘱处置 / 既往有类似症状但本次性质或程度改变 / 首次发生、病因不明 — "
            "and merging them produces a judgment true of none of them, because the stratum with the least evidence "
            "sets the verdict for all of them and the uses that do have an established basis disappear. Name the "
            "stratum wherever the judgment appears: 两药在已确诊冠心病心绞痛患者中均有相应应用依据，但在首次发生或"
            "病因未明的院外急性胸痛中，现有证据不能支持患者自行选择药物替代专业评估"
        )
        break
    if not DIRECT_COMPARISON_MENTION.search(body):
        for line_number, line in enumerate(body.split("\n"), 1):
            conclusion = substitution_conclusion(line)
            if not conclusion:
                continue
            notes.append(
                f"clinical-evidence-report.md line {line_number}: one arm is concluded to take the other's place or "
                f"to beat it ({conclusion}), and the report never says whether a direct comparison between them "
                "exists. Fill the 是否存在直接比较研究 axis either way — head-to-head evidence with its citation, or "
                "未检索到 with what was searched — and if there is none, list the links the chain needs one per line "
                "in 讨论 marked 已建立 or 未建立, and stop the conclusion at the last established link. 可能 does not "
                "close an open link: a speculative recommendation still reads to the reader as a substitution conclusion"
            )
            break
    return notes


def appraisal_symmetry_notes(report: str) -> list[str]:
    """Advice, never a blocking issue.

    When the question compares two interventions, the first thing a reviewer
    checks is whether they were appraised the same way. The asymmetry is almost
    never deliberate: the familiar arm attracts the language of clinical
    tradition (长期临床使用, 指南推荐) and the less studied arm attracts the
    language of grading (按 GRADE 为低确定性), and a conclusion ends up reporting
    one as supported and the other as uncertain when both stand in the same
    evidentiary position for the question actually asked.

    Which nouns in a sentence are the compared arms is not decidable from the
    text — the two vocabularies can also belong to one arm across two
    indications, which is correct writing. So this is reported to the run and
    never fails the preflight; the server has no counterpart, because a rule
    that cannot be decided must not be able to withhold a finished package."""
    title = re.search(r"^#\s+(.+)$", report, re.M)
    abstract = section(report, "摘要")
    conclusion = section(report, "结论")
    if not COMPARISON_QUESTION.search("\n".join([title.group(1) if title else "", abstract, conclusion])):
        return []
    notes: list[str] = []
    for name, text in (("摘要", abstract), ("结论", conclusion)):
        graded = [line for line in SENTENCE_SPLIT.split(text) if CERTAINTY_APPRAISAL.search(line)]
        vouched = [
            line for line in SENTENCE_SPLIT.split(text)
            if TRADITION_APPRAISAL.search(line) and not CERTAINTY_APPRAISAL.search(line)
        ]
        if not graded or not vouched:
            continue
        notes.append(
            f"clinical-evidence-report.md {name}: one arm is vouched for by clinical tradition "
            f"({excerpt(vouched[0])}) while another's certainty is graded ({excerpt(graded[0])}). Check that every "
            "compared arm is appraised with the same instrument, for the same indication, population, care setting "
            "and outcome, and that a gap the arms share is stated for both — 长期使用、指南推荐与批准上市各自是某件"
            "事的证据，都不是确定性等级。If one arm's evidence really is stronger for the question asked, say so in "
            "the same vocabulary you used for the other"
        )
    return notes


def citation_numbers(line: str) -> set[int]:
    numbers: set[int] = set()
    for match in re.finditer(r"\[(\d+(?:\s*[-,]\s*\d+)*)\]", line):
        for part in match.group(1).split(","):
            value = part.strip()
            range_match = re.fullmatch(r"(\d+)\s*-\s*(\d+)", value)
            if range_match:
                start, end = (int(item) for item in range_match.groups())
                if start <= end and end - start <= 100:
                    numbers.update(range(start, end + 1))
            else:
                numbers.add(int(value))
    return numbers


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", default=".")
    args = parser.parse_args()
    root = Path(args.workspace).resolve()
    issues: list[str] = []

    report = load_text(root, "clinical-evidence-report.md", issues)
    matrix = load_json(root, "clinical-evidence-matrix.json", issues)
    search_log = load_json(root, "clinical-evidence-search.json", issues)
    receipt = load_json(root, "clinical-evidence-run.json", issues)
    bibliography = load_text(root, "references.bib", issues)
    ledger = load_text(root, "citation-ledger.csv", issues)
    audit = load_text(root, "citation-audit.md", issues)

    title_match = re.search(r"^#\s+(.+)$", report, re.MULTILINE)
    title = title_match.group(1).strip() if title_match else ""
    if not title:
        issues.append("clinical-evidence-report.md: title is missing")
    for heading in (
        "摘要",
        # The manuscript states the clinical question in 引言; earlier reports
        # headed that section 临床问题. Either name carries the same content.
        "临床问题|引言|Introduction",
        "检索|方法",
        "结果",
        "讨论",
        "局限",
        "结论",
        PRACTICAL_SECTION_HEADING,
        "参考文献",
    ):
        if not re.search(rf"(?:^|\n)##\s+[^\n]*(?:{heading})", report, re.I):
            issues.append(f"clinical-evidence-report.md: missing level-two section {heading}")
    practical_matches = list(
        re.finditer(rf"(?:^|\n)##\s+[^\n]*(?:{PRACTICAL_SECTION_HEADING})[^\n]*", report, re.I)
    )
    references_matches = list(
        re.finditer(r"(?:^|\n)##\s+[^\n]*(?:参考文献|References)[^\n]*", report, re.I)
    )
    practical_position = practical_matches[-1].start() if practical_matches else -1
    references_position = references_matches[-1].start() if references_matches else -1
    if practical_position < 0 or references_position < practical_position:
        issues.append("clinical-evidence-report.md: practical section must precede final references")
    check_register(report, issues)
    check_comparative_structure(report, issues)

    queries = search_log.get("queries")
    query_values = [
        entry.get("query", "").strip().lower()
        for entry in queries
        if isinstance(entry, dict) and isinstance(entry.get("query"), str)
    ] if isinstance(queries, list) else []
    documented_searches = {
        (
            entry.get("database", "").strip().lower(),
            entry.get("query", "").strip().lower(),
        )
        for entry in queries
        if isinstance(entry, dict)
        and isinstance(entry.get("database"), str)
        and isinstance(entry.get("query"), str)
        and entry.get("database", "").strip()
        and entry.get("query", "").strip()
    } if isinstance(queries, list) else set()
    if not query_values or len(documented_searches) != len(query_values):
        issues.append(
            "clinical-evidence-search.json: queries must be completed, non-empty, and non-duplicate"
        )
    query_databases = {
        entry.get("database", "").strip().lower()
        for entry in queries
        if isinstance(entry, dict) and isinstance(entry.get("database"), str)
        and entry.get("database", "").strip()
    } if isinstance(queries, list) else set()
    if len(query_databases) < 2:
        issues.append("clinical-evidence-search.json: search at least two relevant source classes")

    claims = matrix.get("claims")
    if not isinstance(claims, list) or not claims:
        issues.append("clinical-evidence-matrix.json: material claims are missing")
        claims = claims if isinstance(claims, list) else []
    for index, claim in enumerate(claims):
        if not isinstance(claim, dict):
            issues.append(f"clinical-evidence-matrix.json: claims[{index}] must be an object")
            continue
        check_claim(index, claim, issues)
        claim_id = claim.get("claimId")
        # A derived result is not a source: it takes no numbered citation of its
        # own, its inputs carry them, and it is marked 〔推导〕 instead.
        if claim.get("claimType") == "derived":
            marker = f"<!-- claim:{claim_id} -->"
            if marker not in report:
                issues.append(f"clinical-evidence-report.md: missing marker {marker}")
            continue
        reference_number = claim.get("referenceNumber")
        if not isinstance(reference_number, int) or reference_number < 1:
            issues.append(
                f"clinical-evidence-matrix.json: claims[{index}].referenceNumber is invalid"
            )
            continue
        marker = f"<!-- claim:{claim_id} -->"
        matching_lines = [line for line in report.splitlines() if marker in line]
        if not matching_lines:
            issues.append(f"clinical-evidence-report.md: missing marker {marker}")
        elif not any(reference_number in citation_numbers(line) for line in matching_lines):
            issues.append(
                f"clinical-evidence-report.md: {marker} is not paired with [{reference_number}]"
            )

    # The two rules a derived result lives under, checked here as well as on the
    # server so the run learns while it can still act.
    derived_ids = {
        claim.get("claimId")
        for claim in claims
        if isinstance(claim, dict) and claim.get("claimType") == "derived" and claim.get("claimId")
    }
    if derived_ids:
        for line_number, line in enumerate(report.splitlines(), 1):
            cited = {claim_id for claim_id in derived_ids if f"claim:{claim_id}" in line}
            if cited and not DERIVED_REPORT_LABEL.search(line):
                issues.append(
                    f"clinical-evidence-report.md line {line_number}: derived result "
                    f"{', '.join(sorted(cited))} must be marked 〔推导〕"
                )

    practical = section(report, PRACTICAL_SECTION_HEADING)
    practical_derived = sorted(claim_id for claim_id in derived_ids if f"claim:{claim_id}" in practical)
    if practical_derived:
        issues.append(
            "clinical-evidence-report.md: practical section cites derived result "
            f"{', '.join(practical_derived)}; practical advice must rest on measured evidence"
        )
    for line_number, line in enumerate(practical.splitlines(), 1):
        if not re.match(r"\s*(?:\d+[.、]|[-*+]\s+)", line):
            continue
        if not re.search(r"\[\d+(?:\s*[-,]\s*\d+)*\]", line):
            issues.append(f"practical line {line_number}: missing numbered citation")
        if "<!-- claim:CLM-" not in line:
            issues.append(f"practical line {line_number}: missing hidden claim marker")

    reference_count = len(
        re.findall(r"^\s*\d+\.\s+\S", section(report, "参考文献|References"), re.M)
    )
    largest_reference_number = max(
        (
            claim.get("referenceNumber", 0)
            for claim in claims
            if isinstance(claim, dict) and isinstance(claim.get("referenceNumber"), int)
        ),
        default=0,
    )
    if reference_count < largest_reference_number:
        issues.append("clinical-evidence-report.md: a matrix reference does not resolve")
    bibliography_count = len(re.findall(r"^@[A-Za-z]+\s*\{", bibliography, re.M))
    if bibliography_count < reference_count:
        issues.append("references.bib: missing entries for numbered report references")
    # Check the header the server checks. This counted rows only, so a ledger
    # with the wrong columns passed here and was rejected there — the run was
    # told to fix something it had already been told was fine, with no way to
    # learn what the columns had to be.
    ledger_rows = [row for row in csv.reader(io.StringIO(ledger)) if any(cell.strip() for cell in row)]
    ledger_header = [cell.strip().lower().replace("_", "").replace(" ", "") for cell in (ledger_rows[0] if ledger_rows else [])]
    missing_columns = [
        name for name, present in (
            ("claimId", "claimid" in ledger_header),
            ("referenceNumber", "referencenumber" in ledger_header),
            ("supportQuote", any(cell.startswith("supportquote") for cell in ledger_header)),
        ) if not present
    ]
    if missing_columns:
        issues.append(
            "citation-ledger.csv: header must name " + ", ".join(missing_columns) + " (any column order)"
        )
    # The ledger maps cited claims to their sources. A derived result cites no
    # source of its own, so it is not a row here — its inputs are.
    cited_claims = [claim for claim in claims if not (isinstance(claim, dict) and claim.get("claimType") == "derived")]
    if len(ledger_rows) < len(cited_claims) + 1:
        issues.append("citation-ledger.csv: require a header and one row per cited matrix claim")

    for label, pattern in {
        "unresolved": r"unresolved|未解析",
        "duplicate": r"duplicate|重复",
        "correction/retraction": r"correction|retract|更正|撤稿",
        "metadata-only": r"metadata[- ]only|元数据",
        "claim mismatch": r"claim[- ]source|claim mismatch|主张不匹配|引文不匹配",
    }.items():
        if not re.search(pattern, audit, re.I):
            issues.append(f"citation-audit.md: missing explicit {label} audit")

    screening = search_log.get("screening") if isinstance(search_log.get("screening"), dict) else {}
    source_records = (
        search_log.get("sourceRecords")
        if isinstance(search_log.get("sourceRecords"), list)
        else []
    )
    included_records = [
        entry for entry in source_records
        if isinstance(entry, dict) and entry.get("included") is True
    ]
    identified = screening.get("recordsIdentified")
    deduplicated = screening.get("recordsAfterDeduplication")
    included = screening.get("sourcesIncluded")
    if not (
        isinstance(identified, int)
        and isinstance(deduplicated, int)
        and isinstance(included, int)
        and identified >= deduplicated >= included >= 1
        and included == len(included_records)
    ):
        issues.append("clinical-evidence-search.json: screening flow is inconsistent")
    stats = receipt.get("stats") if isinstance(receipt.get("stats"), dict) else {}
    expected_stats = {
        "totalSearches": len(queries) if isinstance(queries, list) else 0,
        "recordsIdentified": screening.get("recordsIdentified"),
        "recordsAfterDeduplication": screening.get("recordsAfterDeduplication"),
        "sourcesIncluded": screening.get("sourcesIncluded"),
    }
    for key, expected in expected_stats.items():
        if stats.get(key) != expected:
            issues.append(f"clinical-evidence-run.json: stats.{key} must equal {expected!r}")
    if receipt.get("status") != "succeeded":
        issues.append("clinical-evidence-run.json: status must be succeeded")

    # The field the server reads to know which sources this run preserved. It
    # was documented in the skill and checked nowhere here, so a run could omit
    # it, be told ok=true, and be failed 45 minutes later by a server message
    # that named no field. Every source path is checked exactly as the server
    # checks it: inside .evimed-sources, present on disk, one per document.
    source_paths = receipt.get("successfulSourceArtifacts")
    if not isinstance(source_paths, list) or not source_paths:
        issues.append(
            "clinical-evidence-run.json: successfulSourceArtifacts must list the .evimed-sources paths this run preserved"
        )
    else:
        if len(source_paths) > 48:
            issues.append("clinical-evidence-run.json: successfulSourceArtifacts lists more than 48 artifacts")
        for entry in source_paths:
            if not isinstance(entry, str) or not entry.startswith(".evimed-sources/") or ".." in entry:
                issues.append(
                    f"clinical-evidence-run.json: successfulSourceArtifacts entry {entry!r} must be a .evimed-sources workspace path"
                )
            elif not (root / entry).is_file():
                issues.append(f"clinical-evidence-run.json: successfulSourceArtifacts entry {entry!r} does not exist")

    payload = {
        "ok": not issues,
        "workspace": str(root),
        # Advice the run should read and act on where it applies. It never
        # decides "ok", because it cannot be decided mechanically.
        "notes": appraisal_symmetry_notes(report) + comparative_structure_notes(report),
        "metrics": {
            "reportCharacters": len(report.strip()),
            "queries": len(query_values),
            "uniqueQueries": len(set(filter(None, query_values))),
            "claims": len(claims),
            "references": reference_count,
            # Length is a claim about importance; these are the shares to check
            # the rank of each section's question against.
            "sectionShares": section_shares(report),
        },
        "issues": issues,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if not issues else 1


if __name__ == "__main__":
    sys.exit(main())
