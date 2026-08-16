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
# --- Emergency dispatch is never conditioned on a medicine's effect ----------
# Mirrored from clinicalEvidenceQuality.mjs. Inside 临床实践要点 an
# emergency-call instruction states its trigger in symptoms and signs; a trigger
# phrased as "the drug did not work" cancels the unconditional rule the same
# section always also carries, and a reader cannot execute both. Writing the
# forbidden order in order to forbid it is the compliant shape, so the rejection
# licenses the phrase when it stands in the clause carrying it or anywhere later
# in the same sentence.
EMERGENCY_DRUG_WORDS = "含服|含化|含药|服药|服用|用药|口服|舌下|给药|服下|吃药|嚼服|吞服|喷服"
# Non-relief is a morphology, not a phrase list: a negator scoping over a relief
# predicate. Listing the phrases let 未见效 (the list held 不见效), 无好转,
# 未获缓解, 未能奏效, 症状持续存在 and 疼痛不减轻 past a rule that already rejected
# 不见效 and 不缓解 — the same instruction, one character different.
#
# The relief predicates split in two, and the split is what lets one half stand
# without a medication word in front of it:
#   RELIEF   — 缓解/好转/减轻, predicated of a *symptom*. 胸痛持续 20 分钟不缓解 is
#              a legitimate symptom-stated trigger, so this half means nothing
#              until a medication word anchors it.
#   EFFICACY — 见效/奏效/起效/疗效/无效: only a treatment can be their subject.
#              「若硝酸甘油未能奏效，应立即拨打 120」 names the drug instead of the
#              act of taking it, so it carries no medication word at all while
#              the predicate presupposes one. This half needs no anchor — and in
#              exchange a rejection anywhere earlier in the sentence licenses it.
EMERGENCY_RELIEF_WORDS = "缓解|好转|改善|减轻|缓和|消失|消退|平息|减退|控制"
EMERGENCY_EFFICACY_WORDS = "见效|奏效|起效|生效|有效|效果|疗效|效"
EMERGENCY_NEGATORS = "[不未无没莫]"
# A closed set of light verbs and degree adverbs, not a wildcard: 无论是否缓解
# must not read as a negated relief predicate.
EMERGENCY_NEGATION_HELPERS = "(?:能|可|见|获|得|予|会|再|有|够|完全|明显|充分|显著|彻底){0,2}"
EMERGENCY_DEGREE_WORDS = "明显|佳|好|全|够|理想|满意|充分"
EMERGENCY_PERSIST_WORDS = "持续存在|持续不退|持续不解|仍(?:然|旧)?存在|依然存在|依旧存在|症状持续|疼痛持续|胸痛持续"
EMERGENCY_EFFICACY_FAILURE = (
    rf"{EMERGENCY_NEGATORS}{EMERGENCY_NEGATION_HELPERS}(?:{EMERGENCY_EFFICACY_WORDS})"
    rf"|(?:疗效|药效|效果){EMERGENCY_NEGATORS}(?:{EMERGENCY_DEGREE_WORDS})"
)
EMERGENCY_FAILURE_WORDS = (
    rf"{EMERGENCY_NEGATORS}{EMERGENCY_NEGATION_HELPERS}(?:{EMERGENCY_RELIEF_WORDS})"
    rf"|(?:{EMERGENCY_RELIEF_WORDS}){EMERGENCY_NEGATORS}(?:{EMERGENCY_DEGREE_WORDS})"
    rf"|{EMERGENCY_PERSIST_WORDS}"
    rf"|{EMERGENCY_EFFICACY_FAILURE}"
)
# 不等同/不代表/不意味 belong to the same family as 不构成: they deny that the
# medicine's response settles anything, which is the inference this rule bans.
EMERGENCY_REJECT_WORDS = (
    "不宜|而非|而不是|不是|并非|不得|不应|不能|不可|不要|勿|无论|不论|均不|都不|不因|不以|不作为|不构成"
    "|不等同|不代表|不意味"
)
EMERGENCY_NON_TREATMENT_SUBJECT = re.compile(r"(?:判断|鉴别|识别|区分|呼救|呼叫|求救|送医|就医|驾车|自驾|等待|观察|评估|筛查)")
EMERGENCY_CONDITION_FRAME = re.compile(r"(?:条件|前提|标准|指征|时机|情形|情况下)")
EMERGENCY_DISPATCH = re.compile(
    r"(?:呼叫|拨打|呼救|叫)[^。！？\n]{0,8}(?:120|999|急救|救护)"
    r"|(?:急救|120|999)[^。！？\n]{0,8}(?:呼叫|拨打|呼救)"
)
# One notion of a clause, shared by both halves of this check: a medication word
# and a non-relief word state one trigger only when they stand in one clause.
# Reading the span with one boundary set and the licensing rejection with
# another made 「重复给药；未完全缓解即呼叫 120」 a single condition, while the
# clause after the semicolon holds no medication word and calls 120 sooner.
# The gap stays tempered against rejection words: without it 用药 reaches across
# 而非 to 无效.
# A comma is a clause boundary here with one exception, and the exception is
# grammatical rather than convenient: a comma closing a temporal or conditional
# clause (…后，/…时，) does not end the condition, it hands it on.
# 「若含服硝酸甘油后，症状仍不缓解，应立即拨打 120」 is one trigger written across
# that comma. 「已服药者，出现新发晕厥…」 keeps its boundary: 者 closes a
# population qualifier, not a condition.
EMERGENCY_CLAUSE_BOUNDARY = re.compile(r"[。！？；：、，;:,\n]")
EMERGENCY_CLAUSE_GAP_UNIT = rf"(?:(?!{EMERGENCY_REJECT_WORDS}|[。！？；：、，;:,\n]).|(?<=[后时])[，,])"
MEDICATION_CONDITIONED_TRIGGER = re.compile(
    rf"(?:{EMERGENCY_DRUG_WORDS}){EMERGENCY_CLAUSE_GAP_UNIT}{{0,20}}(?:{EMERGENCY_FAILURE_WORDS})"
)
TIMED_OBSERVATION_TRIGGER = re.compile(
    r"(?:观察|等待|等)\s*[0-9０-９一二三四五六七八九十]{1,3}\s*(?:分钟|分|小时|min)"
    rf"{EMERGENCY_CLAUSE_GAP_UNIT}{{0,10}}(?:{EMERGENCY_FAILURE_WORDS})"
)
# The medication act and the trigger it conditions need not share a sentence:
# 「含服硝酸甘油一片后观察。仍不缓解者拨打 120。」 splits them with a full stop and
# resumes with an anaphor whose antecedent is the medication act. This branch
# runs only where a medication word has already been stated on the same line.
EMERGENCY_ANAPHORA = "仍|依然|依旧|仍旧|如仍|若仍|经上述处理|上述处理后"
ANAPHORIC_FAILURE_TRIGGER = re.compile(
    rf"(?:{EMERGENCY_ANAPHORA}){EMERGENCY_CLAUSE_GAP_UNIT}{{0,10}}(?:{EMERGENCY_FAILURE_WORDS})"
)
EFFICACY_FAILURE_TRIGGER = re.compile(rf"(?:{EMERGENCY_EFFICACY_FAILURE})")
EMERGENCY_REJECT_CLAUSE = re.compile(EMERGENCY_REJECT_WORDS)
EMERGENCY_DRUG_CLAUSE = re.compile(EMERGENCY_DRUG_WORDS)
EMERGENCY_RELIEF_CLAUSE = re.compile(EMERGENCY_RELIEF_WORDS)
PRACTICAL_CLAIM_MARKER = re.compile(r"<!--.*?-->", re.S)
PRACTICAL_EMPHASIS = re.compile(r"\*\*|__|`")
PRACTICAL_CITATION = re.compile(r"\[\s*\d+(?:\s*[,\-–]\s*\d+)*\s*\]")
PRACTICAL_SPACING = re.compile(r"[ \t　]+")
# --- An article-level regulatory citation needs the regulator's own text -----
# Mirrored from clinicalEvidenceQuality.mjs. 《XX法/条例/办法…》第 N 条 asserts
# what a normative text says at clause granularity; only the issuing authority's
# published text can carry that. A journal article, a review, a portal reprint
# or a bare reference-list entry cannot, however accurately it paraphrases.
STATUTE_TITLE = r"《[^》\n]{2,40}(?:法|条例|办法|规定|细则|准则|规范|决定|命令|公告|通知|药典)(?:[（(][^）)\n]{0,20}[）)])?》"
STATUTE_ARTICLE_NUMBER = r"[一二三四五六七八九十百廿卅零〇0-9]{1,6}"
# An article-level assertion is a statute reference and an article number in one
# sentence, and the assertion is the same however the two are ordered and however
# the statute is named. Requiring 《》 before 第 N 条 let three rewritings of one
# sentence past it: dropping the book-title marks (「医师法第 29 条第 2 款…」),
# putting the number first (「第 29 条第 2 款是《医师法》为…设定的合法条件」), and
# referring back to a statute named in an earlier clause (「…；该法第 29 条…」).
#
# The bare and anaphoric forms are recognised by the shape Chinese legal citation
# actually uses — a statute name written immediately against its article locator.
# Adjacency is what makes that safe: 法 also ends 方法, 用法, 疗法 and 合法, and
# those compounds are filtered by name rather than by a lookbehind, which here
# would have to be variable-width.
STATUTE_BARE_NAME = r"[\u4e00-\u9fa5]{1,20}(?:法|条例|办法|规定|细则|准则|规范|决定|命令|公告|药典)"
STATUTE_BARE_NAME_TRAP = re.compile(
    r"(?:方法|用法|疗法|说法|看法|做法|想法|手法|写法|算法|语法|文法|合法|依法|司法|立法|执法|违法|非法"
    r"|无法|书法|针法|制法|色谱法|滴定法|分析法|测定法|检查法|鉴别法|检验法)$"
)
STATUTE_ARTICLE_LOCATORS = (
    re.compile(
        rf"{STATUTE_TITLE}(?:[（(][^）)\n]{{0,24}}[）)])?[^。；！？\n]{{0,24}}?"
        rf"第\s*(?P<article>{STATUTE_ARTICLE_NUMBER})\s*条"
    ),
    re.compile(
        rf"第\s*(?P<article>{STATUTE_ARTICLE_NUMBER})\s*条[^。；！？\n]{{0,24}}?{STATUTE_TITLE}"
    ),
    re.compile(
        rf"(?:^|[^\u4e00-\u9fa5])(?P<name>{STATUTE_BARE_NAME})\s*第\s*(?P<article>{STATUTE_ARTICLE_NUMBER})\s*条"
    ),
)


def statute_article_locators_on(line: str) -> list[tuple[str, str]]:
    """Every article-level statute locator on one line, one per article number:
    the three orderings above can match the same assertion twice."""
    by_article: dict[str, tuple[str, str]] = {}
    for pattern in STATUTE_ARTICLE_LOCATORS:
        for match in pattern.finditer(line):
            name = match.groupdict().get("name")
            if name and STATUTE_BARE_NAME_TRAP.search(name):
                continue
            article = canonical_article_number(match.group("article"))
            by_article.setdefault(article, (match.group(0), article))
    return list(by_article.values())
ARTICLE_NUMBER_CN = re.compile(rf"第\s*({STATUTE_ARTICLE_NUMBER})\s*条")
ARTICLE_NUMBER_EN = re.compile(r"article\s+(\d{1,4})", re.I)
# A registry fact, not a tuned list: these namespaces are restricted by their
# registries to government entities, .int to intergovernmental treaty
# organisations, and .europa.eu to EU institutions.
GOVERNMENT_HOST = re.compile(r"(?:\.gov|\.gov\.[a-z]{2}|\.go\.[a-z]{2}|\.gouv\.fr|\.europa\.eu|\.int)$")
REFERENCES_HEADING_LINE = re.compile(r"(?:^|\n)##\s+[^\n]*(?:参考文献|参考来源|References?)[^\n]*$", re.I | re.M)
HEADING_LINE = re.compile(r"^\s*#{1,6}\s")
CLAIM_MARKER_ID = re.compile(r"<!--\s*claim:(CLM-[0-9]{3,6})\s*-->|\[claim:(CLM-[0-9]{3,6})\]")
CJK_DIGIT = {"〇": 0, "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
CJK_UNIT_SMALL = {"十": 10, "百": 100, "千": 1000}
CJK_UNIT_BIG = {"万": 10000, "亿": 100000000}
# --- Conclusory quantity extraction, mirrored from clinicalEvidenceQuality.mjs
# A number carrying a unit or a statistical marker is a measured quantity;
# a bare integer is a list position or a section number. Every \b of the
# original is written out as an explicit ASCII lookaround, because Python's \b
# is unicode-aware and would not fall between a CJK glyph and a Latin letter
# where JavaScript's does.
NUMERIC_MARKDOWN_LINK = re.compile(r"\]\(https?://[^)\s]+\)", re.I)
NUMERIC_WEB_ADDRESS = re.compile(r"https?://\S+", re.I)
NUMERIC_VISIBLE_MARKER = re.compile(r"\[claim:CLM-[0-9]{3,6}\]")
NUMERIC_HIDDEN_MARKER = re.compile(r"<!--\s*claim:CLM-[0-9]{3,6}\s*-->")
NUMERIC_CITATION = re.compile(r"\[(?:[0-9]+(?:\s*[-,]\s*[0-9]+)*)\]")
NUMERIC_ALNUM_TOKEN = re.compile(
    r"(?<![A-Za-z0-9_])(?=[A-Za-z0-9-]*[0-9])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*(?![A-Za-z0-9_])"
)
NUMERIC_LIST_MARKER = re.compile(r"[（(]\s*[1-9][0-9]?\s*[)）]")
NUMERIC_THOUSANDS = re.compile(r"(?<=[0-9]),(?=[0-9]{3}(?:[^0-9]|$))")
NUMERIC_INTERVAL_PERCENT = re.compile(r"%(\s*[–—-]\s*)(?=[0-9])")
NUMERIC_RUN = re.compile(r"[0-9]+(?:\.[0-9]+)?(?:\s*[–—-]\s*[0-9]+(?:\.[0-9]+)?)?")
EN_ONES = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
EN_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
EN_SCALES = {"hundred": 100, "thousand": 1000, "million": 1000000, "billion": 1000000000}
EN_WORDS_ALT = "|".join([*EN_ONES, *EN_TENS, *EN_SCALES])
CONCLUSORY_NUMBER = (
    r"(?:[0-9]+(?:\.[0-9]+)?(?:\s*[–—-]\s*[0-9]+(?:\.[0-9]+)?)?"
    r"|[〇零一二两三四五六七八九十百千万亿]+"
    rf"|(?<![A-Za-z])(?:{EN_WORDS_ALT})(?:[\s-]+(?:{EN_WORDS_ALT}))*(?![A-Za-z]))"
)
CONCLUSORY_UNIT = (
    r"(?:%|‰|倍|percent|fold|times|mg|µg|μg|ug|mcg|ng|kg|g|mmol/?L?|mol|mmHg|mL|ml|L|IU"
    r"|毫克|微克|纳克|千克|克|毫升|微升|升|毫摩尔|摩尔|国际单位|片|粒|支|滴|例次|人次|例患者|例|名|人|患者|项|次|周|月|年|天|日|岁"
    r"|weeks?|months?|years?|days?|participants|patients|subjects|trials|studies|cases)(?![A-Za-z])"
)
RATIO_PREFIX = (
    r"(?<![A-Za-z])(?:HR|aHR|OR|aOR|RR|aRR|风险比|比值比|危险比|相对危险度|CI|置信区间|发生率|有效率|敏感度|特异度"
    r"|阳性率|死亡率|发病率|中位数|中位|平均|均值|百分之)"
)
STAT_PREFIX = r"(?<![A-Za-z])(?:n|N|p|P)\s*[<>=]"
CONCLUSORY_CONNECTOR = r"[\s=:：<>≈~〜约为是]*"
CONCLUSORY_SUFFIX = re.compile(rf"({CONCLUSORY_NUMBER})\s*{CONCLUSORY_UNIT}", re.I)
CONCLUSORY_PREFIX = re.compile(rf"(?:{RATIO_PREFIX}{CONCLUSORY_CONNECTOR}|{STAT_PREFIX}\s*)({CONCLUSORY_NUMBER})", re.I)
CONCLUSORY_PER_UNIT = re.compile(r"一(?:次|日|天)(?=\s*[0-9〇零一二两三四五六七八九十])")
# --- A named appraisal instrument is a promise, not a qualification ---------
# Mirrored from clinicalEvidenceQuality.mjs. NAMED_APPRAISAL_INSTRUMENT above is
# used only as an exemption and is deliberately left alone; this is the other
# half. Bare Cochrane is not in the vocabulary — 2008 年 Cochrane 系统评价 is a
# publication — and bare NOS is nitric oxide synthase unless a scale noun
# follows it.
APPRAISAL_INSTRUMENTS = (
    ("RoB 2", re.compile(r"RoB\s?[-‑]?\s?2", re.I)),
    ("ROBINS-I", re.compile(r"ROBINS[-‑\s]?I(?![A-Za-z])", re.I)),
    ("ROBINS-E", re.compile(r"ROBINS[-‑\s]?E(?![A-Za-z])", re.I)),
    ("QUADAS-2", re.compile(r"QUADAS[-‑\s]?2", re.I)),
    ("AMSTAR 2", re.compile(r"AMSTAR\s?[-‑]?\s?2", re.I)),
    ("AGREE II", re.compile(r"AGREE\s?(?:II|2|Ⅱ)", re.I)),
    ("Newcastle-Ottawa", re.compile(r"Newcastle[-‑\s]?Ottawa|纽卡斯尔[-‑\s]?渥太华|(?<![A-Za-z])NOS(?=\s*(?:量表|评分|评价|清单))", re.I)),
    ("Naranjo", re.compile(r"Naranjo|诺氏(?=\s*(?:量表|评分))", re.I)),
    ("WHO-UMC", re.compile(r"WHO[-‑\s]?UMC", re.I)),
    ("Jadad", re.compile(r"Jadad", re.I)),
    ("GRADE", re.compile(r"(?<![A-Za-z])GRADE(?![A-Za-z])", re.I)),
)
APPRAISAL_HEDGE = re.compile(r"思路|精神|理念|大意|(?:参照|参考)[^，。；\n]{0,20}要点")
APPRAISAL_DECLINED = re.compile(r"未(?:使用|采用|执行|做|作)|不(?:适用|使用|采用)|无从(?:评定|评价)")
APPRAISAL_NOT_APPLIED = re.compile(
    r"未(?:检索到|获得|见|能|报告|提供|开展|进行|作|做|给出)"
    r"|无法(?:完整)?(?:获得|检索|评定|评价|评估|应用|实施)|不适用|无从(?:评定|评价|判断)|(?:资料|信息)不(?:足|全|完整)"
)
APPRAISAL_CITATION = re.compile(r"\[\d+")
# A rating of a *body* of evidence summarises studies cited before it and is
# routinely its own paragraph, so a bracket in the same paragraph is the wrong
# test for "was the instrument used".
APPRAISAL_VERDICT = re.compile(
    r"(?:为|评为|定为|判为|属|记为|评定为)\s*[\"“”'‘’]?"
    r"(?:极|很|较)?(?:高|中等?|低|严重|不明确|high|moderate|low|serious|critical|some\s+concerns)",
    re.I,
)
# A GRADE verdict written either way round. 「评为高确定性」 puts the level before
# its noun; 「GRADE 确定性高」 and 「证据确定性评为高」 put it after, and matching only
# the first order meant the same verdict passed by word order alone. 属 and 级别
# join the vocabulary for the same reason: 「按 GRADE 属高级别证据」 is the verdict
# spelled with the nouns GRADE's Chinese translations actually use.
GRADE_CERTAINTY_NOUN = r"确定性|证据质量|证据等级|证据级别|质量|等级|级别|certainty"
GRADE_LEVEL_WORD = (
    r"(?:极|很|较)?(?:高|中等?|低|high|moderate|low)"
    r"(?:\s*(?:至|到|~|～|-|–)\s*(?:极|很|较)?(?:高|中等?|低|high|moderate|low))?"
)
GRADE_LEVEL = re.compile(
    rf"(?:为|评为|评定为|定为|判为|属于|属|记为|确定性为|在)\s*[\"“”'‘’「『]?({GRADE_LEVEL_WORD})[\"“”'‘’」』]?"
    rf"\s*(?:{GRADE_CERTAINTY_NOUN}|之间)"
    rf"|(?:{GRADE_CERTAINTY_NOUN})\s*(?:评定为|评为|定为|判为|记为|属于|属|为|是)?\s*[\"“”'‘’「『]?({GRADE_LEVEL_WORD})(?![于过])",
    re.I,
)
# A downgrade reason is an assertion that something is *wrong* with the
# evidence; the five GRADE domains are neutral nouns and appear just as often in
# the sentence justifying a HIGH rating (偏倚风险低、结果一致、估计精确、无发表偏
# 倚证据). Matching the bare noun made 高 unwritable.
# A downgrade performed is 降级 or 下调 or 扣 followed by a step; a deficiency
# stated is an evidence-quality noun under a negative evaluation. Spelling both
# out phrase by phrase let 下调一级 / 质量欠佳 / 证据强度不足 past a rule that
# already rejected 降一级 / 质量偏低 — the same assertion, a synonym apart. The
# English branch used to read (?:偏倚风险|risk of bias)(?:较|很)?(?:高|严重), which
# demands a Chinese intensifier after an English noun and matched no text in
# either language; it is written out rather than deleted.
GRADE_DOWNGRADE_STEP = r"(?:一|两|二|1|2)?\s*(?:个)?\s*(?:级|等级|档)"
GRADE_QUALITY_NOUN = r"方法学质量|证据质量|研究质量|证据强度|证据级别|方法学|质量"
GRADE_QUALITY_DEFICIENT = r"偏低|较低|低|差|不高|欠佳|不佳|欠缺|不足|有限|堪忧|参差不齐"
GRADE_DOWNGRADE = re.compile(
    "|".join(
        (
            rf"(?:降|下调|下降|扣)\s*{GRADE_DOWNGRADE_STEP}",
            r"降级",
            r"偏倚风险(?:较|很)?(?:高|严重|不明确|不清楚)",
            r"存在(?:严重|明显|较大|一定)?(?:偏倚风险|不一致性?|间接性|不精确性?|发表偏倚)",
            r"(?:不一致性?|间接性|不精确性?|发表偏倚)(?:明显|严重|突出|较大)",
            r"(?:估计|效应量?|结果)(?:很|较|明显)?不(?:精确|一致)",
            rf"(?:{GRADE_QUALITY_NOUN})\s*(?:普遍|整体|多数|大多|总体|均|尚)?\s*(?:{GRADE_QUALITY_DEFICIENT})",
            r"(?:downgrad|rated down)",
            r"risk of bias\s*(?:(?:is|was|were|are)\s*)?(?:high|serious|critical|unclear)",
            r"(?:methodological|study|evidence)\s+quality\s*(?:(?:is|was|were|are)\s*)?(?:low|poor|limited)",
            r"serious\s+(?:limitations?|risk of bias|imprecision|inconsistency|indirectness)",
        )
    ),
    re.I,
)
# 未对任何领域降级 / 无需降级: the deficiency word is there because it is being
# ruled out.
# Two of GRADE's five domains are spelled with a negator — 不一致性, 不精确 — so
# the negator inside the domain noun read as a negation of the downgrade next to
# it, and 「因偏倚风险与不一致性下调一级」 scored as a downgrade ruled out. The
# domain nouns are masked to the same width before the negation is looked for.
GRADE_DOWNGRADE_NEGATION = re.compile(r"[不未无没][^，。；\n]{0,6}$")
GRADE_DOMAIN_NEGATOR_NOUNS = re.compile(r"不一致性?|不精确性?")
GRADE_BASELINE = re.compile(r"(?:从|自|起[点始]|基线|起步)\s*(?:为|于)?\s*[\"“”'‘’「『]?(?:极|很|较)?(?:高|中)")
GRADE_WORD = re.compile(r"(?<![A-Za-z])GRADE(?![A-Za-z])|证据(?:确定性|质量|等级|级别)|确定性", re.I)
APPRAISAL_CLAUSE_SPLIT = re.compile(r"[，,；;：:、\n]")
# The GRADE self-consistency branch reads a whole paragraph, so its clause split
# has to end clauses at full stops too — otherwise a negation six characters
# back reaches over one.
GRADE_CLAUSE_SPLIT = re.compile(r"[，,；;：:、。！？\n]")
APPRAISAL_EMPHASIS = re.compile(r"\*\*|__")
ABSTRACT_METHOD_FIELD = re.compile(r"\*\*方法\*\*(.*?)(?=\n?\*\*(?:结果|结论)|$)", re.S)
LEVEL_TWO_HEADING = re.compile(r"^##\s+(.+)$")
# --- Screening numbers and the source set are rendered, never restated ------
# Mirrored from clinicalEvidenceQuality.mjs. Four quantities live in
# clinical-evidence-search.json and nowhere else, together with the identity of
# every included record; when the report states one, it renders it. A flow term
# counts as a run-flow number only when the clause anchors it — two or more flow
# terms together, or a term carrying its noun — so a per-query hit count
# (「注册临床试验命中 0 条」) and a cited review's own study count
# (「纳入 46 篇系统评价」) are never read as the run's screening totals.
SCREENING_FLOW_PATTERNS = (
    ("totalSearches", True,
     re.compile(r"(?:共|合计|总计)?\s*(?:完成|执行|进行)\s*(?P<n>\d+)\s*(?:次|条|组)\s*(?P<noun>检索式?|查询)")),
    ("recordsIdentified", False,
     re.compile(r"(?:命中|获得|检出|检索到|识别)\s*(?P<n>\d+)\s*条\s*(?P<noun>记录|题录|文献)?")),
    ("recordsAfterDeduplication", True,
     re.compile(r"去重(?:[^，。；\n]{0,14})?后(?:余|剩余|保留|得到)?\s*(?P<n>\d+)\s*(?P<noun>条|篇|个)")),
    ("sourcesIncluded", False,
     re.compile(r"纳入\s*(?P<n>\d+)\s*(?:条|个|篇|份)\s*(?P<noun>来源|证据来源)?")),
)
SCREENING_FLOW_NAMES = {
    "totalSearches": "检索式条数",
    "recordsIdentified": "命中记录数",
    "recordsAfterDeduplication": "去重后记录数",
    "sourcesIncluded": "纳入来源数",
}
SCREENING_CLAUSE_SPLIT = re.compile(r"[。；;!?\n]")
NUMBERED_REFERENCE_ENTRY = re.compile(r"^\s*(\d+)[.、]\s+\S")
# --- Reference-table closure: nothing floats, no number is an orphan --------
# Mirrored from clinicalEvidenceQuality.mjs. The numbered list and the body must
# close on each other in both directions; a bibliographic identifier may not
# stand in for a citation; every line repeating a claim marker carries that
# claim's own number; and a source the run retrieved but did not use is recorded
# as excluded, with a reason, and leaves the numbered list.
REFERENCE_ENTRY = re.compile(r"^\s*(?:\[(\d{1,3})\]|(\d{1,3})[.、])\s+(\S.*)$")
CITATION_NUMBER_LIST = re.compile(r"\[(\d{1,3}(?:\s*[,，、\-–—]\s*\d{1,3})*)\]")
BARE_CITATION_NUMBER_LIST = re.compile(r"^\s*\d{1,3}(?:\s*[,，、\-–—]\s*\d{1,3})*\s*$")
BRACKET_SPAN = re.compile(r"\[([^\[\]\n]{1,200})\]")
CITATION_RANGE = re.compile(r"^(\d+)\s*[-–—]\s*(\d+)$")
# \b written out as ASCII lookarounds: Python's \b is unicode-aware and would
# not fall between a CJK glyph and a Latin letter where JavaScript's does.
BIBLIOGRAPHIC_IDENTIFIER = re.compile(
    r"(?:(?<![A-Za-z0-9_])10\.\d{4,9}/[^\s\]，。；、]+"
    r"|(?<![A-Za-z0-9_])PMID:?\s*\d{5,9}(?![A-Za-z0-9_])"
    r"|(?<![A-Za-z0-9_])PMC\d{5,9}(?![A-Za-z0-9_])"
    r"|(?<![A-Za-z0-9_])NCT\d{8}(?![A-Za-z0-9_])"
    r"|(?<![A-Za-z0-9_])ChiCTR[-A-Za-z0-9]+(?![A-Za-z0-9_])"
    r"|(?<![A-Za-z0-9_])ISRCTN\d{8}(?![A-Za-z0-9_]))",
    re.I,
)
CODE_SPAN = re.compile(r"`[^`\n]*`")
# The LAST reference heading, as the section cut already does: a report naming
# its reference list twice would otherwise be cut in the wrong place.
REFERENCES_HEADING_ANY = re.compile(r"(?:^|\n)##\s+[^\n]*(?:参考文献|参考来源|References?)[^\n]*", re.I)
# --- An attributed position must be quoted, not inferred from data ----------
# Mirrored from clinicalEvidenceQuality.mjs. 作者指出 / 该研究强调 attributes a
# position to a source; a quote that only reports measurements cannot carry one.
# Only supportQuote is consulted — a position written into the claim's own
# `claim`/`applicability`/`uncertainty` field is the agent's words, and so is
# `sourceTitle`, which the run types in rather than quoting: reading it here
# reopened the same laundering path one field over.
# The subject is built rather than listed. 该研究 used to be a listed string, so
# 「这项研究认为」 and 「该项研究指出」 — one measure word inserted — were not the same
# subject, and 「上述研究认为」 was not either. A source-denoting subject is a
# demonstrative plus a research-entity noun, with the measure word Chinese puts
# between them optional; 本 is excluded because 本研究/本文 is the report's own
# voice. A comma ends the subject→verb window: a subject and its predicate stand
# in one clause, and 「作者对心肌梗死估计的 E 值为 1.79，提示…」 predicates 提示 of
# the E value. 报告/报道/说明/描述 stay out — they are reporting verbs.
ATTRIBUTED_STANCE_DETERMINER = r"该|这|此|上述|前述|前文|原"
ATTRIBUTED_STANCE_ENTITY = r"研究|综述|试验|队列|分析|文献|论文|报告|文章|指南|共识|荟萃分析|meta\s*分析"
ATTRIBUTED_STANCE_AUTHOR = r"作者|笔者|研究者|研究人员|研究团队|课题组|原作者|综述作者|作者们|原文|该文|文中"
ATTRIBUTED_STANCE_SUBJECT = (
    rf"(?:(?:{ATTRIBUTED_STANCE_DETERMINER})\s*(?:一)?\s*(?:项|篇|个|份|部)?\s*(?:{ATTRIBUTED_STANCE_ENTITY})"
    rf"|{ATTRIBUTED_STANCE_AUTHOR})"
)
ATTRIBUTED_STANCE_VERB = (
    r"认为|指出|强调|视为|归因|归结|主张|推测|承认|坦承|警告|提醒|解释为|理解为|注意到|倾向"
    r"|提出|断言|论断|推断|质疑|反驳|否认|声称|宣称|写道|提示"
)
ATTRIBUTED_STANCE_GAP = r"[^。！？；；，、;,\n]"
ATTRIBUTED_STANCE = re.compile(
    rf"(?<!本){ATTRIBUTED_STANCE_SUBJECT}{ATTRIBUTED_STANCE_GAP}{{0,25}}?(?:{ATTRIBUTED_STANCE_VERB})"
    rf"|在\s*(?<!本){ATTRIBUTED_STANCE_SUBJECT}{ATTRIBUTED_STANCE_GAP}{{0,12}}?看来"
    rf"|(?<!本){ATTRIBUTED_STANCE_SUBJECT}{ATTRIBUTED_STANCE_GAP}{{0,8}}?的\s*(?:核心|主要|基本)?\s*"
    rf"(?:观点|看法|立场|主张|判断|解释|论点)\s*(?:是|为|在于)"
)
# The exemption, mirrored from clinicalEvidenceQuality.mjs: the quote itself
# carries a position, so attributing one to it is a faithful restatement. Still
# a permit-list — matching can only silence a trigger, never create one — but
# what it permits is a *stance predication*, not a token.
#
# A flat vocabulary tested anywhere in the quote cleared 183 of 578 claims
# (31.7%) on the thirty delivered packages, on words carrying no stance at all:
# `could` in "You could be having a heart attack. Call 999", `our`/`we` in
# "included in our analysis" / "we included 417 patients", `however` in
# "However, there was significant heterogeneity". Each branch below therefore
# requires the stance-bearing element to stand in a governing configuration — a
# subject it predicates of, or a complement it takes:
#   A authorial predication  we / our results / the authors + a judgement verb
#   B complemented judgement a judgement verb + that / to-infinitive / whether
#   C hedged interpretation  a hedge governing an interpretive predicate
#   D deontic position       should / must / the need to / (not) recommended
#   E causal attribution     a causal frame whose explanandum is a stated result
#   F epistemic state        remains unclear / cannot be excluded
#   G/H Chinese              stance verbs, and a hedge governing an interpretive
#                            predicate; the bare nouns and adverbs that used to
#                            sit here (局限/偏倚/混杂/可能/或许) are words a result
#                            sentence contains, not positions
# After: 60 of 578 (10.4%).
STANCE_AUTHORIAL_SUBJECT = (
    r"(?:we|our|us|the authors?|this (?:study|review|analysis|paper|report|trial|cohort|meta-analysis)"
    r"|the present (?:study|review|analysis))"
)
STANCE_JUDGEMENT_VERB = (
    r"(?:suggest|conclud|conclusion|propos|argu|hypothesi[sz]|speculat|acknowledg|caution|recommend"
    r"|advocat|interpret|consider|believ|assum|attribut|postulat|contend|support|emphasi[sz]|warn)"
)
STANCE_HEDGE = (
    r"(?:may|might|could|would|likely|unlikely|probably|possibly|presumably|appears? to|seems? to|tends? to)"
)
STANCE_INTERPRETIVE_PREDICATE = (
    r"(?:due to|attribut|explain|accounts? for|accounted for|reflect|indicat|impl(?:y|ies|ied)|results? from"
    r"|resulted from|leads? to|lead to|contribut|underl(?:ie|ying|ies)|represent|mediat|responsible for"
    r"|caused? by|associated with|related to|arise|stem)"
)
STANCE_RESULT_NOUN = (
    r"(?:results?|findings?|outcomes?|observations?|declines?|increases?|reductions?|differences?|associations?"
    r"|effects?|scores?|delays?|heterogeneity|discrepanc|variation|trends?|improvements?|changes?|estimates?"
    r"|rates?)"
)
STANCE_CAUSAL_FRAME = (
    r"(?:due to|owing to|because of|because|attributable to|attributed to|explained by|accounts? for"
    r"|accounted for|resulted from|arises? from|stems? from|reflects?)"
)
STANCE_DEONTIC_PREDICATE = (
    r"(?:the need to|needs? to|should|must|ought to"
    r"|is\s+(?:not\s+)?(?:recommended|advised|warranted|justified|essential|necessary|indicated|contraindicated)"
    r"|are\s+(?:not\s+)?(?:recommended|advised|warranted|justified)|(?:do(?:es)? not\s+)?recommends?"
    r"|not recommended)"
)
QUOTED_STANCE = re.compile(
    rf"(?<![A-Za-z]){STANCE_AUTHORIAL_SUBJECT}(?![A-Za-z])[^.;\n]{{0,40}}?(?<![A-Za-z]){STANCE_JUDGEMENT_VERB}"
    rf"|(?<![A-Za-z]){STANCE_JUDGEMENT_VERB}[a-z]*(?![A-Za-z])[^.;\n]{{0,24}}?(?:that(?![A-Za-z])|to\s+[a-z]|whether(?![A-Za-z]))"
    rf"|(?<![A-Za-z]){STANCE_HEDGE}(?![A-Za-z])[^.;\n]{{0,20}}?(?<![A-Za-z]){STANCE_INTERPRETIVE_PREDICATE}"
    rf"|(?<![A-Za-z]){STANCE_DEONTIC_PREDICATE}(?![A-Za-z])"
    rf"|(?<![A-Za-z]){STANCE_RESULT_NOUN}(?![A-Za-z])[^.;\n]{{0,30}}?(?<![A-Za-z]){STANCE_CAUSAL_FRAME}(?![A-Za-z])"
    rf"|(?<![A-Za-z]){STANCE_CAUSAL_FRAME}(?![A-Za-z])[^.;\n]{{0,30}}?(?<![A-Za-z]){STANCE_RESULT_NOUN}(?![A-Za-z])"
    r"|(?<![A-Za-z])(?:remains? (?:to be|unclear|unknown|uncertain|controversial|debated)"
    r"|(?:is|are|was|were) (?:unclear|uncertain|controversial|questionable|debatable)"
    r"|cannot be (?:excluded|ruled out|determined))"
    r"|认为|指出|主张|推测|归因|建议|强调|提示|警告|坦承|承认|解释为|视为"
    r"|(?:可能|或许|大概|似乎|倾向于)[^。；\n]{0,12}(?:由于|因为|归因|源于|导致|引起|反映|解释|提示|相关|有关)",
    re.I,
)


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


def medication_conditioned_emergency_triggers(practical: str) -> list[tuple[int, str, str]]:
    """Every emergency-call sentence in the practical section whose trigger is
    how a self-administered medicine performed, as (line, span, sentence).

    Claim markers, emphasis and numbered citations are taken out first so
    neither can inflate the gap between a medication word and a non-relief
    word; the line count is preserved, because the notice names a line."""
    text = PRACTICAL_CLAIM_MARKER.sub(" ", practical)
    text = PRACTICAL_EMPHASIS.sub("", text)
    text = PRACTICAL_CITATION.sub(" ", text)
    text = PRACTICAL_SPACING.sub(" ", text)
    found: list[tuple[int, str, str]] = []
    for line_number, line in enumerate(text.split("\n"), 1):
        medication_stated = False
        for sentence in re.split(r"[。！？]", line):
            carries_medication = bool(EMERGENCY_DRUG_CLAUSE.search(sentence))
            if not EMERGENCY_DISPATCH.search(sentence):
                medication_stated = medication_stated or carries_medication
                continue
            patterns = [MEDICATION_CONDITIONED_TRIGGER, TIMED_OBSERVATION_TRIGGER, EFFICACY_FAILURE_TRIGGER]
            if medication_stated or carries_medication:
                patterns.append(ANAPHORIC_FAILURE_TRIGGER)
            for pattern in patterns:
                for match in pattern.finditer(sentence):
                    # A trigger conditions what follows it. With the call for
                    # help already stated before the phrase, the phrase governs
                    # the waiting instruction instead.
                    # ...unless the sentence names the dispatch and then
                    # defines when to make it, which puts the call first.
                    if not (
                        EMERGENCY_DISPATCH.search(sentence[match.end():])
                        or EMERGENCY_CONDITION_FRAME.search(sentence)
                    ):
                        continue
                    # Mirrors the gate: the unanchored branch presupposes the
                    # medicine is what did not work.
                    if pattern is EFFICACY_FAILURE_TRIGGER:
                        head = sentence[: match.start()]
                        edges = [m.start() for m in EMERGENCY_CLAUSE_BOUNDARY.finditer(head)]
                        if EMERGENCY_NON_TREATMENT_SUBJECT.search(head[(edges[-1] if edges else -1) + 1:]):
                            continue
                    before = sentence[: match.start()]
                    # The clause boundary, not a character count: the rejection
                    # that licenses a compliant sentence can sit 35 characters
                    # back, in the preceding clause. The unanchored efficacy
                    # branch reads the whole preceding sentence instead, because
                    # there is no medication word for a clause to hold.
                    if pattern is EFFICACY_FAILURE_TRIGGER:
                        preceding = before
                    else:
                        boundaries = [m.start() for m in EMERGENCY_CLAUSE_BOUNDARY.finditer(before)]
                        preceding = before[(boundaries[-1] if boundaries else -1) + 1:]
                    if EMERGENCY_REJECT_CLAUSE.search(preceding):
                        continue
                    # Chinese puts the rejection after the instruction as often
                    # as before it (「…应立即呼叫急救，不得因已服药而推迟」). Past
                    # the trigger's own clause it licenses only if it is about
                    # this trigger — its clause names the medication or the
                    # relief — or 「…应立即拨打 120，不要自行驾车前往医院」 clears
                    # itself with a negation about driving. Anything past 。！？
                    # is a different instruction and licenses nothing.
                    after = EMERGENCY_CLAUSE_BOUNDARY.split(sentence[match.end():])
                    licensed = any(
                        EMERGENCY_REJECT_CLAUSE.search(clause)
                        and (
                            index == 0
                            or EMERGENCY_DRUG_CLAUSE.search(clause)
                            or EMERGENCY_RELIEF_CLAUSE.search(clause)
                        )
                        for index, clause in enumerate(after)
                    )
                    if licensed:
                        continue
                    found.append((line_number, match.group(0), excerpt(sentence)))
            medication_stated = medication_stated or carries_medication
    return found


def cjk_number_value(run: str) -> int | None:
    """The value of a Chinese numeral run, or None when it is not one. The same
    eight-line loop as cjkNumberValue in clinicalEvidenceQuality.mjs."""
    total = 0
    section_total = 0
    current = 0
    consumed = False
    for character in run:
        if character in CJK_DIGIT:
            current = CJK_DIGIT[character]
            consumed = True
        elif character in CJK_UNIT_SMALL:
            section_total += (current or 1) * CJK_UNIT_SMALL[character]
            current = 0
            consumed = True
        elif character in CJK_UNIT_BIG:
            section_total = (section_total + current) * CJK_UNIT_BIG[character]
            total += section_total
            section_total = 0
            current = 0
            consumed = True
        else:
            return None
    return total + section_total + current if consumed else None


def closure_citation_numbers(text: str) -> set[int]:
    """Citation numbers in a passage, with the full-width separators a Chinese
    manuscript uses. "[2.2.1]" is a von Baeyer ring descriptor, not citation 2:
    the dot breaks the pattern, which is why the bracket must be numbers only."""
    numbers: set[int] = set()
    for match in CITATION_NUMBER_LIST.finditer(text):
        for part in re.split(r"[,，、]", match.group(1)):
            value = part.strip()
            span = CITATION_RANGE.match(value)
            if span:
                start, end = int(span.group(1)), int(span.group(2))
                if start <= end and end - start <= 100:
                    numbers.update(range(start, end + 1))
            elif value:
                numbers.add(int(value))
    return numbers


def prose_without_code(prose: str) -> str:
    """The prose with fenced blocks and inline code spans blanked, line count
    preserved so a reported line is the line the author will find."""
    inside_fence = False
    kept: list[str] = []
    for line in prose.split("\n"):
        if CODE_FENCE.match(line):
            inside_fence = not inside_fence
            kept.append("")
            continue
        kept.append("" if inside_fence else CODE_SPAN.sub("", line))
    return "\n".join(kept)


def allowed_reference_numbers(claim: dict) -> set[int]:
    numbers: set[int] = set()
    number = claim.get("referenceNumber")
    if isinstance(number, int) and not isinstance(number, bool):
        numbers.add(number)
    for entry in claim.get("referenceNumbers") or []:
        if isinstance(entry, int) and not isinstance(entry, bool):
            numbers.add(entry)
    return numbers


def appraisal_sections(report: str) -> tuple[str, str, str]:
    """METHODS / BODY / TAIL as the check reads them: every matching level-two
    section concatenated (one report writes `## 2 资料与方法`), plus the
    abstract's 方法 field, with emphasis markers stripped — one delivery writes
    评为**低确定性**, and the markers would break level parsing."""
    abstract = ABSTRACT_METHOD_FIELD.search(section(report, "摘要|Abstract"))
    buckets = {
        "methods": [APPRAISAL_EMPHASIS.sub("", abstract.group(1)) if abstract else ""],
        "body": [],
        "tail": [],
    }
    current = None
    for line in APPRAISAL_EMPHASIS.sub("", report).split("\n"):
        heading = LEVEL_TWO_HEADING.match(line)
        if heading:
            name = heading.group(1)
            if re.search(r"参考文献|参考来源|References?", name, re.I):
                current = None
            elif re.search(r"资料|材料|方法|Methods", name, re.I):
                current = "methods"
            elif re.search(r"结果|讨论|Results?|Discussion", name, re.I):
                current = "body"
            elif re.search(r"局限|结论|临床实践要点|Limitations?|Conclusion", name, re.I):
                current = "tail"
            else:
                current = None
            continue
        if current:
            buckets[current].append(line)
    return "\n".join(buckets["methods"]), "\n".join(buckets["body"]), "\n".join(buckets["tail"])


def asserted_grade_deficiency(sentence: str) -> bool:
    """Whether a sentence asserts a GRADE downgrade — a deficiency in the
    evidence, or a downgrade performed — rather than ruling one out.
    Clause-scoped: a sentence grading a body says both things."""
    for clause in GRADE_CLAUSE_SPLIT.split(sentence):
        match = GRADE_DOWNGRADE.search(clause)
        if not match:
            continue
        preceding = GRADE_DOMAIN_NEGATOR_NOUNS.sub(lambda m: "·" * len(m.group(0)), clause[: match.start()])
        if GRADE_DOWNGRADE_NEGATION.search(preceding):
            continue
        return True
    return False


def report_line_carrying(report: str, passage: str) -> int:
    """The 1-indexed line of the unmodified report that carries a passage."""
    needle = passage.strip()
    if not needle:
        return 0
    for index, line in enumerate(report.split("\n"), 1):
        if needle in APPRAISAL_EMPHASIS.sub("", line):
            return index
    return 0


def declared_appraisal_issues(report: str) -> list[tuple[str, str, int, str]]:
    """Instruments declared in 资料与方法 and never executed in 结果 or 讨论
    (advisory), and GRADE levels that reach 高 beside a downgrade reason
    (blocking), as (branch, instrument, line, excerpt)."""
    methods, body, tail = appraisal_sections(report)
    findings: list[tuple[str, str, int, str]] = []
    for instrument, pattern in APPRAISAL_INSTRUMENTS:
        declarations = [clause for clause in APPRAISAL_CLAUSE_SPLIT.split(methods) if pattern.search(clause)]
        if not declarations:
            continue
        # Declared as *not* used: nothing has to land.
        if all(APPRAISAL_DECLINED.search(clause) for clause in declarations):
            continue
        first = declarations[0].strip()
        line = report_line_carrying(report, first)
        if all(APPRAISAL_HEDGE.search(clause) for clause in declarations):
            findings.append(("hedged-declaration", instrument, line, excerpt(first)))
            continue
        # Three ways a declaration lands, widest scope last: on a study cited in
        # the same paragraph; as an explicit statement that nothing could be
        # scored; or as a verdict on a body of evidence, which summarises
        # studies cited in the paragraphs before it and needs only that
        # 结果/讨论 cite something.
        body_cites = bool(APPRAISAL_CITATION.search(body))
        landed = False
        for paragraph in body.split("\n"):
            if not pattern.search(paragraph):
                continue
            for sentence in SENTENCE_SPLIT.split(paragraph):
                if not pattern.search(sentence):
                    continue
                carrying = [clause for clause in APPRAISAL_CLAUSE_SPLIT.split(sentence) if pattern.search(clause)]
                if not carrying or all(APPRAISAL_HEDGE.search(clause) for clause in carrying):
                    continue
                if (
                    APPRAISAL_CITATION.search(paragraph)
                    or APPRAISAL_NOT_APPLIED.search(sentence)
                    or (body_cites and APPRAISAL_VERDICT.search(sentence))
                ):
                    landed = True
                    break
            if landed:
                break
        if landed:
            continue
        branch = "appraisal-tail-only" if pattern.search(tail) else "appraisal-declared-not-executed"
        findings.append((branch, instrument, line, excerpt(first)))
    # Any downgrade at all excludes 高, so only that case is decidable.
    # The unit is the paragraph, not the sentence. A verdict and the deficiency
    # that contradicts it are one judgement however they are punctuated, and a
    # sentence-scoped check was cleared by a full stop: 「纳入研究方法学质量普遍
    # 偏低。按 GRADE 评为高确定性。」 passed, and so did the two sentences the other
    # way round. The verdict noun need not be the string GRADE either —
    # 「证据确定性评为高」 is a GRADE verdict with the instrument's name left out.
    for passage in f"{body}\n{tail}".split("\n"):
        if not GRADE_WORD.search(passage):
            continue
        if not asserted_grade_deficiency(passage):
            continue
        high_verdict = None
        for level in GRADE_LEVEL.finditer(passage):
            stated = level.group(1) or level.group(2) or ""
            if not re.search(r"高|high", stated, re.I):
                continue
            # 从「高」起步 / 起点为高: the baseline GRADE starts from, not the verdict.
            window = passage[max(0, level.start() - 8): level.end()]
            if GRADE_BASELINE.search(window):
                continue
            high_verdict = level
            break
        if high_verdict is None:
            continue
        findings.append((
            "grade-level-contradicts-downgrade", "GRADE", report_line_carrying(report, passage.strip()), excerpt(passage),
        ))
    return findings


def screening_ledger_findings(report: str, search_log: dict) -> list[dict]:
    """A stated flow quantity that disagrees with the ledger, and the source set
    the numbered reference list does not match."""
    headings = list(REFERENCES_HEADING_ANY.finditer(report))
    references_start = headings[-1].start() if headings else len(report)
    body = report[:references_start]
    reference_block = (
        re.split(r"\n##\s+", report[references_start + len(headings[-1].group(0)):])[0] if headings else ""
    )
    screening = search_log.get("screening") if isinstance(search_log.get("screening"), dict) else {}

    def integer(value: object) -> int | None:
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    queries = search_log.get("queries")
    held = {
        "totalSearches": len(queries) if isinstance(queries, list) else None,
        "recordsIdentified": integer(screening.get("recordsIdentified")),
        "recordsAfterDeduplication": integer(screening.get("recordsAfterDeduplication")),
        "sourcesIncluded": integer(screening.get("sourcesIncluded")),
    }
    findings: list[dict] = []
    prose = prose_without_code(body)
    for clause in SCREENING_CLAUSE_SPLIT.split(prose):
        matches = [
            (key, int(match.group("n")), anchored or bool(match.group("noun")))
            for key, anchored, pattern in SCREENING_FLOW_PATTERNS
            for match in pattern.finditer(clause)
        ]
        if len(matches) < 2 and not any(anchored for _, _, anchored in matches):
            continue
        for key, value, _ in matches:
            if held[key] is None or held[key] == value:
                continue
            # Only the disagreeing quantity is named: a report whose other
            # numbers are right must not be sent back to rewrite a correct
            # sentence.
            findings.append({"leg": "A", "key": key, "stated": value, "held": held[key], "clause": excerpt(clause)})
    included_refs = {
        record["referenceNumber"]
        for record in (search_log.get("sourceRecords") or [])
        if isinstance(record, dict)
        and record.get("included") is True
        and isinstance(record.get("referenceNumber"), int)
        and not isinstance(record.get("referenceNumber"), bool)
    }
    listed = {
        int(match.group(1))
        for match in (NUMBERED_REFERENCE_ENTRY.match(line) for line in reference_block.split("\n"))
        if match
    }
    if not listed or not included_refs:
        return findings
    cited: set[int] = set()
    for line in prose.split("\n"):
        cited |= closure_citation_numbers(line)
    uncovered = sorted((listed | cited) - included_refs)
    if uncovered:
        findings.append({"leg": "B1", "numbers": uncovered})
    # The raw listed set, not a de-duplicated count: padding is already its own
    # finding, and de-duplicating here would let a padded list satisfy both.
    if held["sourcesIncluded"] is not None and len(listed) != held["sourcesIncluded"]:
        findings.append({"leg": "B2", "listed": len(listed), "included": held["sourcesIncluded"]})
    return findings


def citation_closure_findings(report: str, claims_by_id: dict[str, dict], search_log: dict) -> list[dict]:
    """Reference-table closure in both directions, identifiers standing in for
    citations, per-line anchor/number pairing, and the excluded set's own
    bookkeeping."""
    headings = list(REFERENCES_HEADING_ANY.finditer(report))
    references_start = headings[-1].start() if headings else len(report)
    prose = report[:references_start]
    entries: dict[int, str] = {}
    for line in report[references_start:].split("\n"):
        match = REFERENCE_ENTRY.match(line)
        if not match:
            continue
        number = int(match.group(1) or match.group(2))
        entries.setdefault(number, match.group(3).strip())
    lines = prose_without_code(prose).split("\n")
    cited: set[int] = set()
    for line in lines:
        cited |= closure_citation_numbers(line)
    findings: list[dict] = []
    if entries:
        for number in sorted(entries):
            if number not in cited:
                findings.append({"clause": "A", "number": number, "body": excerpt(entries[number])})
        for number in sorted(cited):
            if number not in entries:
                findings.append({"clause": "B", "number": number})
    first_marker_line: dict[str, int] = {}
    for index, line in enumerate(lines):
        for match in CLAIM_MARKER_ID.finditer(line):
            first_marker_line.setdefault(match.group(1) or match.group(2), index)
    for index, line in enumerate(lines):
        for match in BRACKET_SPAN.finditer(line):
            inner = match.group(1)
            if BARE_CITATION_NUMBER_LIST.match(inner) or re.match(r"^\s*claim:", inner):
                continue
            if BIBLIOGRAPHIC_IDENTIFIER.search(inner):
                findings.append({"clause": "C", "line": index + 1, "bracket": excerpt(match.group(0))})
        on_line = closure_citation_numbers(line)
        seen: set[str] = set()
        for match in CLAIM_MARKER_ID.finditer(line):
            claim_id = match.group(1) or match.group(2)
            if claim_id in seen:
                continue
            seen.add(claim_id)
            claim = claims_by_id.get(claim_id)
            # A derived result carries no reference number of its own.
            if not claim or claim.get("claimType", "direct") == "derived":
                continue
            # The claim that is paired nowhere is already reported once, per
            # claim, by the marker-pairing check above. This adds the later
            # lines it never looked at.
            if first_marker_line.get(claim_id) == index:
                continue
            allowed = allowed_reference_numbers(claim)
            if not allowed or allowed & on_line:
                continue
            findings.append({
                "clause": "D",
                "line": index + 1,
                "claimId": claim_id,
                "cited": sorted(on_line),
                "allowed": sorted(allowed),
            })
    records = search_log.get("sourceRecords")
    for index, record in enumerate(records if isinstance(records, list) else []):
        if not isinstance(record, dict) or record.get("included") is True:
            continue
        reason = record.get("exclusionReason")
        if not isinstance(reason, str) or not reason.strip():
            findings.append({"clause": "E1", "index": index})
        number = record.get("referenceNumber")
        if isinstance(number, int) and not isinstance(number, bool) and number in entries:
            findings.append({"clause": "E2", "index": index, "number": number})
    return findings


def english_number_run_value(words: list[str]) -> int | None:
    total = 0
    current = 0
    any_word = False
    for word in words:
        if word in EN_ONES:
            current += EN_ONES[word]
            any_word = True
        elif word in EN_TENS:
            current += EN_TENS[word]
            any_word = True
        elif word in EN_SCALES:
            scale = EN_SCALES[word]
            if scale == 100:
                current = (current or 1) * 100
            else:
                total += (current or 1) * scale
                current = 0
            any_word = True
        else:
            return None
    return total + current if any_word else None


def numeric_tokens(value: object) -> list[str]:
    """Every figure a passage states, normalised the way numericTokens does in
    clinicalEvidenceQuality.mjs: addresses, claim markers, numbered citations,
    alphanumeric identifiers and list markers are removed first, thousands
    separators and trailing zeroes are folded, and a range stays one token."""
    text = "" if value is None else str(value)
    text = NUMERIC_MARKDOWN_LINK.sub("]", text)
    text = NUMERIC_WEB_ADDRESS.sub("", text)
    text = NUMERIC_VISIBLE_MARKER.sub("", text)
    text = NUMERIC_HIDDEN_MARKER.sub("", text)
    text = NUMERIC_CITATION.sub("", text)
    text = NUMERIC_ALNUM_TOKEN.sub("", text)
    text = NUMERIC_LIST_MARKER.sub("", text)
    text = NUMERIC_THOUSANDS.sub("", text)
    text = NUMERIC_INTERVAL_PERCENT.sub(r"\1", text)
    tokens = []
    for run in NUMERIC_RUN.findall(text):
        parts = re.sub(r"\s+", "", run).replace("–", "-").replace("—", "-").split("-")
        cleaned = []
        for part in parts:
            part = re.sub(r"^0+(?=[0-9])", "", part)
            part = re.sub(r"(\.[0-9]*?)0+$", r"\1", part)
            cleaned.append(re.sub(r"\.$", "", part))
        tokens.append("-".join(cleaned))
    return tokens


def canonical_numbers(text: str) -> list[str]:
    if re.search(r"[0-9]", text):
        return numeric_tokens(text)
    if re.search(r"[a-z]", text, re.I):
        value = english_number_run_value([word for word in re.split(r"[\s-]+", text.lower()) if word])
        return [] if value is None or value <= 0 else [str(value)]
    value = cjk_number_value(text)
    return [] if value is None else [str(value)]


def conclusory_quantities(text: object) -> set[str]:
    """The measured quantities a passage states. A confidence interval is one
    quantity however its endpoints are punctuated, and 一次10丸 says ten pills:
    the 一 is the Chinese for "per", not a quantity."""
    source = NUMERIC_INTERVAL_PERCENT.sub(r"\1", "" if text is None else str(text))
    source = CONCLUSORY_PER_UNIT.sub("", source)
    numbers: set[str] = set()
    for pattern in (CONCLUSORY_SUFFIX, CONCLUSORY_PREFIX):
        for match in pattern.finditer(source):
            numbers.update(canonical_numbers(match.group(1)))
    # A standalone calendar year is publication metadata, not a finding.
    for token in list(numbers):
        if re.fullmatch(r"[0-9]+", token) and 1900 <= int(token) <= 2099:
            numbers.discard(token)
    return numbers


def claim_quote_text(claim: dict) -> str:
    """What the source itself says, never what the agent wrote about it: the
    `claim`, `applicability`, `uncertainty` and `sourceTitle` fields are
    excluded on purpose, because writing a position into them and citing the
    claim is the laundering path this check exists to close."""
    sources = (
        claim["supportingSources"]
        if claim.get("claimType") == "synthesized" and isinstance(claim.get("supportingSources"), list)
        else [claim]
    )
    pieces: list[str] = []
    for source in sources:
        if not isinstance(source, dict):
            continue
        if isinstance(source.get("supportQuote"), str):
            pieces.append(source["supportQuote"])
    return " ".join(pieces)


def attributed_stance_issues(body: str, claims_by_id: dict[str, dict]) -> list[tuple[int, str, list[str], bool]]:
    """Lines that attribute a position to a source while every claim they cite
    states only measurements, as (line, attribution, claimIds, anchored)."""
    found: list[tuple[int, str, list[str], bool]] = []
    for line_number, line in enumerate(body.split("\n"), 1):
        if HEADING_LINE.match(line):
            continue
        attribution = ATTRIBUTED_STANCE.search(line)
        if not attribution:
            continue
        # Line-level, not sentence-level: the corpus uses both marker
        # conventions, and a sentence splitter attributes a trailing marker to
        # the preceding claim and manufactures a false positive.
        ids: list[str] = []
        for match in CLAIM_MARKER_ID.finditer(line):
            claim_id = match.group(1) or match.group(2)
            if claim_id not in ids:
                ids.append(claim_id)
        if not ids:
            found.append((line_number, excerpt(attribution.group(0)), [], False))
            continue
        claims = [
            claims_by_id[claim_id] for claim_id in ids
            if claim_id in claims_by_id and claims_by_id[claim_id].get("claimType") != "derived"
        ]
        if not claims:
            continue
        if any(QUOTED_STANCE.search(claim_quote_text(claim)) for claim in claims):
            continue
        # The "every" conjunct is load-bearing: an attribution anchored to a
        # non-numeric quote is a faithful restatement, and a line mixing a
        # stance claim with a data claim is ordinary writing.
        if not all(conclusory_quantities(claim_quote_text(claim)) for claim in claims):
            continue
        found.append((line_number, excerpt(attribution.group(0)), [claim["claimId"] for claim in claims], True))
    return found


def canonical_article_number(run: str) -> str:
    text = run.strip()
    if re.fullmatch(r"[0-9]+", text):
        return str(int(text))
    value = cjk_number_value(text)
    return text if value is None else str(value)


def article_numbers_named(text: str) -> set[str]:
    """Every article number a passage names, in both wordings — a statute
    preserved from npc.gov.cn carries 第二十九条 and its English rendering
    carries "Article 29", and both are the same article."""
    found = {canonical_article_number(match.group(1)) for match in ARTICLE_NUMBER_CN.finditer(text)}
    found.update(str(int(match.group(1))) for match in ARTICLE_NUMBER_EN.finditer(text))
    return found


def source_host(value: object) -> str:
    """The lowercased hostname of a credential-free http(s) URL, or ""."""
    if not isinstance(value, str):
        return ""
    match = re.match(r"^https?://(?:[^/@\s]*@)?([^/:?#\s]+)", value.strip(), re.I)
    if not match or "@" in value.split("//", 1)[-1].split("/", 1)[0]:
        return ""
    return match.group(1).lower().rstrip(".")


def claim_source_tuples(claim: dict) -> list[tuple[str, object, str, str]]:
    """The (sourceUrl, artifactPath, supportQuote, claim) tuples a claim offers.
    A synthesized claim offers one per supporting source; a derived result
    offers none, since it has no source of its own."""
    if claim.get("claimType") == "derived":
        return []
    if claim.get("claimType") == "synthesized" and isinstance(claim.get("supportingSources"), list):
        return [
            (
                source.get("sourceUrl") if isinstance(source, dict) else None,
                source.get("artifactPath") if isinstance(source, dict) else None,
                source.get("supportQuote") if isinstance(source, dict) else "",
                claim.get("claim") or "",
            )
            for source in claim["supportingSources"]
        ]
    return [(claim.get("sourceUrl"), claim.get("artifactPath"), claim.get("supportQuote") or "", claim.get("claim") or "")]


def regulatory_article_issues(report: str, claims: list, preserved: set[str]) -> list[tuple[int, str, str, list[int], list[str]]]:
    """Article-level regulatory citations resting on something other than the
    issuing authority's own preserved text."""
    heading = REFERENCES_HEADING_LINE.search(report)
    body = report[: heading.start()] if heading else report
    by_reference: dict[int, dict] = {}
    by_id: dict[str, dict] = {}
    for claim in claims:
        if not isinstance(claim, dict):
            continue
        number = claim.get("referenceNumber")
        if isinstance(number, int) and not isinstance(number, bool) and number not in by_reference:
            by_reference[number] = claim
        if isinstance(claim.get("claimId"), str):
            by_id[claim["claimId"]] = claim
    found: list[tuple[int, str, str, list[int], list[str]]] = []
    for line_number, line in enumerate(body.split("\n"), 1):
        if HEADING_LINE.match(line):
            continue
        locators = statute_article_locators_on(line)
        if not locators:
            continue
        refs = sorted(citation_numbers(line))
        marked = [match.group(1) or match.group(2) for match in CLAIM_MARKER_ID.finditer(line)]
        candidates = [by_reference[number] for number in refs if number in by_reference]
        candidates += [by_id[claim_id] for claim_id in marked if claim_id in by_id]
        tuples = [entry for candidate in candidates for entry in claim_source_tuples(candidate)]
        hosts = sorted({host for host in (source_host(entry[0]) for entry in tuples) if host})
        for locator_text, article in locators:
            licensed = False
            for source_url, artifact_path, quote, claim_text in tuples:
                host = source_host(source_url)
                if not host or not GOVERNMENT_HOST.search(host):
                    continue
                if not isinstance(artifact_path, str) or artifact_path not in preserved:
                    continue
                if article in article_numbers_named(f"{quote or ''} {claim_text or ''}"):
                    licensed = True
                    break
            if licensed:
                continue
            found.append((line_number, excerpt(locator_text), article, refs, hosts))
    return found


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


# --- The question-coverage ledger, mirrored from clinicalEvidenceQuality.mjs --
#
# The server gate cannot see the brief — the run ledger keeps a 160-character
# preview of the question and nothing more — so it checks the run's own account
# of the brief's questions against the artifacts it does hold: the report's
# lines, the claim anchors in them, and this package's search log. Every rule
# below is the same rule the gate applies, so a run that clears this file is not
# failed for coverage after the fact.
COVERAGE_STATUSES = ("answered", "gap")
# Mirrors the gate: a sentence stating an objective is not a finding.
COVERAGE_OBJECTIVE_SENTENCE = re.compile(
    r"(?:^|[|\s])(?:\*\*)?目的(?:\*\*)?|本文(?:旨在|拟|试图|将)|本研究(?:旨在|拟|试图)|(?:旨在|意在)(?:清点|量化|评价|回答|梳理|核查)"
)
COVERAGE_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
COVERAGE_ANCHOR = re.compile(r"<!--\s*claim:CLM-[0-9]{3,6}\s*-->|\[claim:CLM-[0-9]{3,6}\]")
COVERAGE_EXCLUDED_SECTION = re.compile(r"参考文献|参考来源|References?|局限|Limitations?", re.I)
COVERAGE_VERDICT_SECTIONS = (
    ("摘要", "摘要|Abstract"),
    ("结论", "结论|Conclusions?"),
    ("临床实践要点", PRACTICAL_SECTION_HEADING),
)
COVERAGE_RANKING = re.compile(r"最常见|首位|占比|构成比|居首|多数|约半数|大多数")
COVERAGE_THRESHOLD = re.compile(
    r"\d+(?:\.\d+)?\s*[%％]"
    r"|[≥≤><]\s*\d"
    r"|(?:大于|小于|超过|不超过|不少于|至少|不足|上限|下限)\s*\d"
    r"|\d+(?:\.\d+)?\s*(?:[-–—~～至]|到)\s*\d"
    r"|\d+(?:\.\d+)?\s*(?:mg|µg|μg|g|ml|mmHg|分钟|小时|天|周|个月|年|次|例|丸|片|倍|杯)",
    re.I,
)
COVERAGE_DIRECTIVE = re.compile(r"推荐|建议|应当|应予|应立即|必须|首选|优先(?:选择|使用)|可给予|适用于|可用于")
COVERAGE_LITERATURE_FACT = re.compile(
    r"(?:证据|结果|研究|数据)\s*(?:为|是|均为|呈)[^，。；\n]{0,8}阴性"
    r"|(?<![尚暂])无(?:此类|该类|相关|任何|已发表)(?:的)?(?:证据|研究|报道|文献)"
    r"|不存在(?:相关|此类|该类|任何)(?:的)?(?:证据|研究)"
    r"|文献(?:中|里)(?:并)?(?:没有|无|未见)"
    r"|(?<![不非未])(?:已|均)(?:证实|表明|显示)(?:其)?无效"
)
COVERAGE_ACK = re.compile(
    r"未(?:能)?检索到|未检索出|尚未检索|检索(?:结果)?为空"
    r"|未(?:能)?获(?:得|取)|未(?:能)?(?:获|经)(?:得)?(?:核验|核实|证实|确认)"
    r"|证据空(?:白|缺)|证据缺口|未见(?:相关|直接|任何|以|有)"
    r"|尚无(?:直接|已发表|公开|相应)?(?:的)?(?:证据|研究|数据|报道)"
    r"|证据不足|不足以支持|无法(?:判定|评定|确定)|未(?:能)?(?:追溯|定位)到"
    r"|未述及|未载|缺乏(?:直接)?(?:证据|研究|数据)|无直接(?:证据|研究)"
)
COVERAGE_RETRIEVAL_RESTATEMENT = re.compile(
    r"检索(?:日期|时间|截至|策略)"
    r"|检索[^。；\n]{0,60}(?:数据库|索引|注册库|PubMed|Europe\s*PMC|Crossref|ClinicalTrials|CNKI)",
    re.I,
)
COVERAGE_SCOPE_CUE = re.compile(
    r"(?:本文|本研究|本综述|本报告|本篇)[^。；\n]{0,24}"
    r"(?:评价|评估|回答|讨论|考察|梳理|分析|围绕|聚焦|检索)[^。；\n]{0,12}(?:问题|方面)"
)
COVERAGE_SCOPE_COUNT_WORD = re.compile(r"(\d{1,2}|[一二三四五六七八九十]{1,3})\s*(?:个|项|类|方面)?\s*(?:核心|主要)?问题")
COVERAGE_CIRCLED_DIGITS = "①②③④⑤⑥⑦⑧⑨⑩"
COVERAGE_CONTENT_RUN = re.compile(r"[㐀-鿿豈-﫿A-Za-z0-9]+")
COVERAGE_TOPIC_CHARACTERS = 8


def normalized_search_query(value: object) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[‘’“”\"'＂＇]", "", str(value or ""))).strip().lower()


def coverage_shared_topic(left: str, right: str) -> str:
    """The longest run of letters, digits and Han characters two strings share,
    or "" when it is shorter than a topic. Eight characters, not five: shorter
    spans matched field vocabulary (随机对照试验, 安慰剂对照, GRADE) that every
    section of every report in this corpus uses."""
    best = ""
    for a in COVERAGE_CONTENT_RUN.findall(left):
        for b in COVERAGE_CONTENT_RUN.findall(right):
            previous = [0] * (len(b) + 1)
            for i in range(1, len(a) + 1):
                current = [0] * (len(b) + 1)
                for j in range(1, len(b) + 1):
                    if a[i - 1] != b[j - 1]:
                        continue
                    current[j] = previous[j - 1] + 1
                    if current[j] > len(best):
                        best = a[i - current[j]:i]
                previous = current
    return best if len(best) >= COVERAGE_TOPIC_CHARACTERS else ""


def coverage_number_value(run: str) -> int | None:
    if run.isdigit():
        return int(run)
    digits = "零一二三四五六七八九"
    if run == "十":
        return 10
    if re.fullmatch(r"十[一二三四五六七八九]", run):
        return 10 + digits.index(run[1])
    if re.fullmatch(r"[一二三四五六七八九]十", run):
        return digits.index(run[0]) * 10
    if re.fullmatch(r"[一二三四五六七八九]十[一二三四五六七八九]", run):
        return digits.index(run[0]) * 10 + digits.index(run[2])
    return digits.index(run) if re.fullmatch(r"[零一二三四五六七八九]", run) else None


def coverage_enumerated_marker(paragraph: str, index: int) -> bool:
    if f"（{index}）" in paragraph or f"({index})" in paragraph:
        return True
    if index <= len(COVERAGE_CIRCLED_DIGITS) and COVERAGE_CIRCLED_DIGITS[index - 1] in paragraph:
        return True
    ordinals = "一二三四五六七八九十"
    return index <= len(ordinals) and re.search(rf"第{ordinals[index - 1]}[，,、]", paragraph) is not None


def coverage_declared_scope_count(section_text: str) -> int:
    claimed = 0
    for paragraph in re.split(r"\n\s*\n", section_text or ""):
        if not COVERAGE_SCOPE_CUE.search(paragraph):
            continue
        enumerated = 0
        while coverage_enumerated_marker(paragraph, enumerated + 1):
            enumerated += 1
        claimed = max(claimed, enumerated)
        for match in COVERAGE_SCOPE_COUNT_WORD.finditer(paragraph):
            value = coverage_number_value(match.group(1))
            if value is not None and 0 < value <= 30:
                claimed = max(claimed, value)
    return claimed


def coverage_section_of_line(report: str) -> list[str]:
    heading = ""
    headings: list[str] = []
    for line in report.split("\n"):
        match = re.match(r"^##\s+(.*)$", line)
        if match:
            heading = match.group(1)
        headings.append(heading)
    return headings


def coverage_paragraph_at(lines: list[str], index: int) -> str:
    start = index
    end = index
    while start > 0 and lines[start - 1].strip():
        start -= 1
    while end < len(lines) - 1 and lines[end + 1].strip():
        end += 1
    return "\n".join(lines[start:end + 1])


def coverage_line_substance(line: str) -> str:
    text = re.sub(r"<!--.*?-->", "", line or "", flags=re.S)
    text = re.sub(r"\[[^\]\n]*\]\([^)\s]*\)", "", text)
    text = re.sub(r"\[\s*\d+(?:\s*[,，、\-–]\s*\d+)*\s*\]", "", text)
    return re.sub(r"[#>*_`|\-–—\s]", "", text).strip()


def check_question_coverage(
    root: Path,
    report: str,
    search_log: dict,
    claim_ids: set[str],
    issues: list[str],
) -> None:
    name = "question-coverage.json"
    path = root / name
    if not path.is_file():
        issues.append(
            f"{name}: missing. Write one entry per atomic sub-question of the brief — "
            "split the numbered questions on 、, ——, 或 and coordinate clauses — as "
            '{"schemaVersion":1,"entries":[{"id":"2.3","question":"<the sub-question, transcribed>",'
            '"status":"answered","reportLines":[64],"claimIds":["CLM-005"]}]}; a "gap" entry carries '
            'searches:[{"query":"<a search this run really ran>","database":"PubMed","searchedAt":"YYYY-MM-DD"}] instead'
        )
        return
    try:
        ledger = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        issues.append(f"{name}: unreadable or invalid JSON: {exc}")
        return
    if not isinstance(ledger, dict):
        issues.append(f"{name}: top level must be an object")
        return
    if ledger.get("schemaVersion") != 1:
        issues.append(f'{name}: must declare "schemaVersion": 1')
    entries = ledger.get("entries")
    if not isinstance(entries, list) or not entries:
        issues.append(f"{name}: entries must be a non-empty array, one atomic sub-question per entry")
        return

    lines = report.split("\n")
    section_of_line = coverage_section_of_line(report)
    logged = [
        (
            normalized_search_query(entry.get("query")),
            str(entry.get("database") or "").strip().lower(),
        )
        for entry in (search_log.get("queries") or [])
        if isinstance(entry, dict)
    ]
    logged_date = str(search_log.get("searchedAt") or "")[:10]
    seen: set[str] = set()
    groups: set[str] = set()
    gap_entries: list[dict] = []
    for index, entry in enumerate(entries):
        label = f"entries[{index}]"
        if not isinstance(entry, dict):
            issues.append(f"{name}: {label} must be an object")
            continue
        entry_id = entry.get("id").strip() if isinstance(entry.get("id"), str) else ""
        question = entry.get("question").strip() if isinstance(entry.get("question"), str) else ""
        if not entry_id:
            issues.append(f'{name}: {label}.id must be the brief\'s number plus a sub-item index (for example "2.3")')
            continue
        if entry_id in seen:
            issues.append(f"{name}: entry id {entry_id} appears twice; one sub-question, one id")
            continue
        seen.add(entry_id)
        group = re.search(r"\d+", entry_id)
        groups.add(group.group(0) if group else entry_id)
        if len(re.sub(r"\s+", "", question)) < 8:
            issues.append(f"{name}: {entry_id}.question must transcribe the sub-question (at least 8 characters)")
            continue
        if entry.get("status") not in COVERAGE_STATUSES:
            issues.append(f'{name}: {entry_id}.status must be "answered" or "gap"')
            continue
        if isinstance(entry.get("claimIds"), list):
            for claim_id in entry["claimIds"]:
                if claim_id not in claim_ids:
                    issues.append(f"{name}: {entry_id}.claimIds names {claim_id!r}, which is not in the evidence matrix")
        if entry.get("status") == "answered":
            report_lines = entry.get("reportLines")
            if (
                not isinstance(report_lines, list)
                or not report_lines
                or any(not isinstance(value, int) or isinstance(value, bool) or value < 1 for value in report_lines)
            ):
                issues.append(
                    f"{name}: {entry_id} is answered, so reportLines must give the body line numbers "
                    "(a non-empty array of positive integers)"
                )
                continue
            anchored = False
            for line_number in report_lines:
                if line_number > len(lines):
                    issues.append(
                        f"{name}: {entry_id} points at report line {line_number}, "
                        f"but the report has {len(lines)} lines"
                    )
                    continue
                heading = section_of_line[line_number - 1]
                if COVERAGE_EXCLUDED_SECTION.search(heading):
                    issues.append(
                        f"{name}: {entry_id} points at report line {line_number}, which is inside "
                        f"「{heading.strip()}」; the reference list and the limitations answer no question"
                    )
                    continue
                if not coverage_line_substance(lines[line_number - 1]):
                    issues.append(
                        f"{name}: {entry_id} points at report line {line_number}, which is blank or markup only"
                    )
                    continue
                if COVERAGE_ANCHOR.search(coverage_paragraph_at(lines, line_number - 1)):
                    anchored = True
            if not anchored:
                issues.append(
                    f"{name}: {entry_id} is answered, but no paragraph around lines "
                    f"{'、'.join(str(value) for value in report_lines)} carries a claim anchor "
                    "(<!-- claim:CLM-… -->); an answer must hang on evidence"
                )
            continue
        gap_entries.append(entry)
        searches = entry.get("searches")
        if not isinstance(searches, list) or not searches:
            issues.append(
                f"{name}: {entry_id} is a gap, so searches must give the searches this run really ran "
                "(query, database and searchedAt, at least one)"
            )
            continue
        for position, search in enumerate(searches):
            query = search.get("query").strip() if isinstance(search, dict) and isinstance(search.get("query"), str) else ""
            database = search.get("database").strip() if isinstance(search, dict) and isinstance(search.get("database"), str) else ""
            searched_at = search.get("searchedAt").strip() if isinstance(search, dict) and isinstance(search.get("searchedAt"), str) else ""
            if not query or not database or not COVERAGE_ISO_DATE.match(searched_at):
                issues.append(
                    f"{name}: {entry_id}.searches[{position}] must give query, database and searchedAt (YYYY-MM-DD)"
                )
                continue
            matches = [record for record in logged if record[0] == normalized_search_query(query)]
            if not matches:
                issues.append(
                    f"{name}: {entry_id} declares the search 「{query}」, which has no record in "
                    "clinical-evidence-search.json; the search log is written by the retrieval tools, "
                    "so a gap must name a search that actually ran"
                )
                continue
            if not any(record[1] == database.lower() for record in matches):
                issues.append(
                    f"{name}: {entry_id} declares the search 「{query}」 under database 「{database}」, "
                    f"but the log records it under 「{'、'.join(sorted({record[1] for record in matches}))}」"
                )
                continue
            if logged_date and searched_at != logged_date:
                issues.append(
                    f"{name}: {entry_id} declares the search 「{query}」 on {searched_at}, "
                    f"but clinical-evidence-search.json was searched on {logged_date}"
                )

    for section_name, heading in COVERAGE_VERDICT_SECTIONS:
        section_text = section(report, heading)
        if not section_text.strip():
            continue
        section_offset = report.find(section_text)
        section_first_line = report[:section_offset].count("\n") + 1 if section_offset >= 0 else 1
        for line_index, line in enumerate(section_text.split("\n")):
            for sentence in re.split(r"(?<=[。！？；;])", line):
                if not sentence.strip() or COVERAGE_RETRIEVAL_RESTATEMENT.search(sentence):
                    continue
                if COVERAGE_OBJECTIVE_SENTENCE.search(sentence):
                    continue
                if COVERAGE_LITERATURE_FACT.search(sentence):
                    family = "把这一次检索的空手写成了文献世界的事实"
                elif COVERAGE_ACK.search(sentence):
                    continue
                elif COVERAGE_RANKING.search(sentence):
                    family = "给出了排序或构成比"
                elif COVERAGE_THRESHOLD.search(sentence):
                    family = "给出了阈值或数值区间"
                elif COVERAGE_DIRECTIVE.search(sentence):
                    family = "给出了推荐或处置祈使"
                else:
                    continue
                for entry in gap_entries:
                    topic = coverage_shared_topic(str(entry.get("question") or ""), sentence)
                    if not topic:
                        continue
                    issues.append(
                        f"{name}: entry {entry.get('id')} is registered as a gap, but "
                        f"{section_name} line {section_first_line + line_index} {family} "
                        f"on the same topic 「{topic}」: 「{sentence.strip()[:120]}」. "
                        "摘要、结论与临床实践要点是读者取走答案的地方，缺口不能在那里变成结论"
                        "（「未检索到该终点的直接证据，这是一处证据空白」是允许的，也是应当写的）"
                    )
                    break

    if groups:
        for heading in ("摘要|Abstract", "引言|临床问题|Introduction"):
            claimed = coverage_declared_scope_count(section(report, heading))
            # Either direction; see the note in the gate.
            if claimed > 0 and claimed != len(groups):
                issues.append(
                    f"{name}: {heading.split('|')[0]} restates the study as {claimed} questions while the ledger "
                    f"registers {len(groups)} of the brief's numbers; a question that went unanswered is still a "
                    "question — register it as a gap and state the gap in the body"
                )


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
    # An empty practical section is audited exactly like a missing one: every
    # check that reads it — 急救触发条件、derived 禁令、每条要点须挂 claim — runs
    # over "" and passes. The heading must carry the reader's actions.
    if practical_position >= 0 and not section(report, PRACTICAL_SECTION_HEADING).strip():
        issues.append(
            "clinical-evidence-report.md: the practical section is empty; "
            "write the reader's actions under that heading"
        )
    check_register(report, issues)
    check_comparative_structure(report, issues)
    # The instrument branches are advice, not a gate — the same split the server
    # makes, and for the same reason: a pre-specified instrument whose design
    # stratum this search returned nothing for owes no retirement sentence, and
    # prose does not say which of the two happened. Only the GRADE
    # self-consistency branch decides ok.
    appraisal_notes: list[str] = []
    for branch, instrument, line_number, sample in declared_appraisal_issues(report):
        if branch == "grade-level-contradicts-downgrade":
            issues.append(
                f"clinical-evidence-report.md line {line_number}: GRADE 等级与降级理由不自洽——「{sample}」"
                "同句断言了证据缺陷（如方法学质量偏低、偏倚风险高、存在不一致或间接性），却给出含「高」的确定性等级；"
                "任何一项降级都排除「高」，请改等级或删除该缺陷断言"
                "（只写出五个降级领域的名称并说明未因其降级，不触发本条）"
            )
            continue
        opening = (
            f"clinical-evidence-report.md line {line_number}: 资料与方法声明了 {instrument}，"
            f"但结果与讨论中没有一处用它给出评级（{sample}）。"
        )
        if branch == "hedged-declaration":
            appraisal_notes.append(
                opening + f"该行以「思路/精神/理念/参照…要点」提及 {instrument}，等同于未使用。"
                "删除工具名并直接写你实际做了什么，或在结果或讨论里对具体一篇文献用它评一次"
            )
        elif branch == "appraisal-tail-only":
            appraisal_notes.append(
                opening + f"{instrument} 只在局限性或结论里出现。确定性等级宜写在对应证据体处，"
                "局限性不应为正文中不存在的方法学步骤申辩"
            )
        else:
            appraisal_notes.append(
                opening + "工具名是承诺，不是资格声明——若该设计层本轮确有纳入研究，"
                "就在结果或讨论里对具体一篇文献用它评一次（与该文献的编号同段）；"
                f"若该层本轮无纳入研究，{instrument} 可以留在方法里不必补写退场句"
            )

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

    claims_by_id = {
        claim["claimId"]: claim
        for claim in claims
        if isinstance(claim, dict) and isinstance(claim.get("claimId"), str)
    }
    check_question_coverage(root, report, search_log, set(claims_by_id), issues)
    numeric_body = without_sections(without_sections(report, "参考文献|参考来源|References?"), "检索|方法|Methods?")
    for line_number, attribution, claim_ids, anchored in attributed_stance_issues(numeric_body, claims_by_id):
        issues.append(
            f"clinical-evidence-report.md line {line_number}: 以「{attribution}」把立场归属给来源，"
            + (
                f"但该行引用的 {'、'.join(claim_ids)}，其 supportQuote 都只陈述数值，没有一条载有这个立场。"
                if anchored else "却没有挂任何 claim 标记。"
            )
            + "立场归属句必须由某条 claim 的 supportQuote 逐字承载：请改引原文确实说过这句话的 claim；"
            "若来源没说过，删去归属句，或改写为本报告自己的判断。"
            "把这句话写进 claim / applicability / uncertainty 字段再当成来源立场引出来，不算数——门禁只读 supportQuote"
        )

    for finding in screening_ledger_findings(report, search_log):
        if finding["leg"] == "A":
            issues.append(
                "clinical-evidence-report.md: 检索流程数与纳入来源集合由 clinical-evidence-search.json 持有，"
                f"正文只能渲染、不得复述。本次不一致：正文写「{finding['clause']}」中的"
                f"{SCREENING_FLOW_NAMES[finding['key']]} {finding['stated']}，检索记录 {finding['key']} = {finding['held']}。"
                "请改正持有事实的一侧或正文，使两侧逐字相等；只改正文措辞不算修好"
            )
        elif finding["leg"] == "B1":
            listed = "、".join(f"[{number}]" for number in finding["numbers"])
            issues.append(
                f"clinical-evidence-report.md: 参考文献 {listed} 在正文中被引用或列入参考文献表，"
                "但在 clinical-evidence-search.json 的 sourceRecords 中 included=false（或该条记录根本不存在）。"
                "要么读到可核验层级并置 included=true、同步更新 screening 计数，"
                "要么删除这条引用——题录层级的记录支撑不了任何陈述"
            )
        else:
            issues.append(
                f"clinical-evidence-report.md: 参考文献表共 {finding['listed']} 条编号条目，"
                f"screening.sourcesIncluded = {finding['included']}。"
                "编号表必须恰好是 included=true 的来源集合：同数量、同编号"
            )

    # Line span of 临床实践要点, so clause D can block there and degrade
    # elsewhere exactly as the gate does.
    if practical_position >= 0:
        practical_first_line = report.count("\n", 0, practical_position) + 1
        practical_last_line = (
            report.count("\n", 0, references_position) + 1
            if references_position > practical_position
            else report.count("\n") + 1
        )
    else:
        practical_first_line = 0
        practical_last_line = 0

    for finding in citation_closure_findings(report, claims_by_id, search_log):
        clause = finding["clause"]
        if clause == "A":
            issues.append(
                f"clinical-evidence-report.md: 参考文献 [{finding['number']}] 在正文中从未被引用（{finding['body']}）。"
                "已检索但未纳入的来源不进编号表——要么在正文中真正引用它，"
                '要么把它写入 clinical-evidence-search.json 的 sourceRecords（"included": false 并给出 exclusionReason）'
                "后从编号表中移除并重新编号"
            )
        elif clause == "B":
            issues.append(
                f"clinical-evidence-report.md: 正文引用 [{finding['number']}] 在参考文献表中没有对应条目："
                "补上该条目，或改引真正支持这句话的编号"
            )
        elif clause == "C":
            issues.append(
                f"clinical-evidence-report.md line {finding['line']}: 把书目标识符放进了引用位（{finding['bracket']}）。"
                "行内 PMID/DOI 不能代替编号引用——为该来源分配参考文献编号与 claim，或按未纳入来源记入检索日志"
            )
        elif clause == "D":
            listed = ", ".join(str(number) for number in finding["cited"]) or "无"
            allowed = ", ".join(str(number) for number in finding["allowed"])
            message = (
                f"clinical-evidence-report.md line {finding['line']}: 标注了 {finding['claimId']}，"
                f"但该行只引用了 [{listed}]，而 {finding['claimId']} 的 referenceNumber 是 {allowed}。"
                "把该行改引正确的编号，或换成真正支持这句话的 claim；同一 claim 在别处已正确配对不豁免这一行"
            )
            # The gate blocks this only inside 临床实践要点, where the section is
            # read as instruction, and degrades it everywhere else. Emitting it
            # as a hard issue here held a run on something the gate would have
            # shipped -- drift in the safe direction, but drift.
            if practical_first_line and practical_first_line <= finding["line"] <= practical_last_line:
                issues.append(message)
            else:
                appraisal_notes.append(message)
        else:
            # The exclusion ledger is the search apparatus describing itself.
            # The gate degrades it; so does this.
            if clause == "E1":
                appraisal_notes.append(
                    f'clinical-evidence-search.json: sourceRecords[{finding["index"]}] 标记为 "included": false '
                    "却没有 exclusionReason：未纳入的来源必须写明排除理由"
                )
            else:
                appraisal_notes.append(
                    f'clinical-evidence-search.json: sourceRecords[{finding["index"]}] 标记为 "included": false，'
                    f"却仍以编号 [{finding['number']}] 留在参考文献表中：读到可核验层级并置 included=true，"
                    "或从编号表中移除并重新编号"
                )

    preserved_artifacts = {
        entry for entry in (receipt.get("successfulSourceArtifacts") or []) if isinstance(entry, str)
    }
    for line_number, locator, article, refs, hosts in regulatory_article_issues(report, claims, preserved_artifacts):
        listed = ", ".join(str(number) for number in refs) or "无"
        pointing = ", ".join(hosts) or "无可解析来源"
        issues.append(
            f"clinical-evidence-report.md line {line_number}: 以条款级方式引用「{locator}」，"
            "但该行引用的来源中没有一件来自发文机关自有渠道的已留存监管文本工件"
            "（要求：sourceUrl 主机名位于 .gov/.gov.<国别>/.go.<国别>/.europa.eu/.int 政府域，"
            f"artifactPath 在本次运行的 successfulSourceArtifacts 中，且其 supportQuote 或 claim 含同一条号 第{article}条 / Article {article}）；"
            f"该行现有引用为 [{listed}]，指向 {pointing}。"
            "条号级陈述只能由法条原文承载：要么先取得并留存发文机关公布的该法条文本再引用，"
            "要么删去条号，只写所引来源本身是什么——例如把「《医师法》第 29 条第 2 款将超说明书用药的合法条件规定为四点」"
            "改写为「一篇法学综述归纳《医师法》为超说明书用药设定四项前提」"
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
    for line_number, span, sentence in medication_conditioned_emergency_triggers(practical):
        issues.append(
            f"practical line {line_number}: 「{span}」写成了呼叫急救的触发条件（{sentence}）。"
            "急救的触发条件不得以自救用药的疗效为条件（含药不缓解、服药后无效、观察 N 分钟无效均不可）——"
            "本节唯一允许的口径是「无论服药与否、无论是否缓解，出现上述征象即刻呼叫 120」。"
            "同一节里已经写着「服药不是等待的理由，应在服药的同时呼叫急救」，这一条与它互斥，读者无法同时执行。"
            "若来源（指南原文）确实给出了这一条件，把它留在「结果」一节按原文复述并保留出处，实践要点只写无条件的那一句"
        )

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
        "notes": appraisal_symmetry_notes(report) + comparative_structure_notes(report) + appraisal_notes,
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
