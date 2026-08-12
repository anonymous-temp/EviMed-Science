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
# rather than about the evidence.
SELF_REFERENTIAL_NARRATION = re.compile(
    r"学术化版本|作为被评价对象"
    r"|(?:本报告|本文)[^。；\n]{0,16}(?:判定条件|交付判据|达标判据|验收依据|任务书|评分口径)"
    r"|(?:本报告|本文)[^。；\n]{0,10}拒绝[^。；\n]{0,24}(?:判据|验收|达标|指标)"
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

    body = without_sections(report, "参考文献|参考来源|References?").split("\n")
    named_terms: set[str] = set()
    proposition_lines: list[int] = []
    proposition_sample = ""
    headings = 0
    verdicts = 0
    narrations = 0
    for line_number, line in enumerate(body, 1):
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
                "sentence, ask it scientifically"
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
        "metrics": {
            "reportCharacters": len(report.strip()),
            "queries": len(query_values),
            "uniqueQueries": len(set(filter(None, query_values))),
            "claims": len(claims),
            "references": reference_count,
        },
        "issues": issues,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if not issues else 1


if __name__ == "__main__":
    sys.exit(main())
