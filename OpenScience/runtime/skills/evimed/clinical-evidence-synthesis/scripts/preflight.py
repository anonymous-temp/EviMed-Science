#!/usr/bin/env python3
"""Deterministic structural preflight for clinical evidence deliverables."""

from __future__ import annotations

import argparse
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
        "临床问题",
        "检索|方法",
        "结果",
        "讨论",
        "局限",
        "结论",
        "实际处置|实用回答",
        "参考文献",
    ):
        if not re.search(rf"(?:^|\n)##\s+[^\n]*(?:{heading})", report, re.I):
            issues.append(f"clinical-evidence-report.md: missing level-two section {heading}")
    practical_matches = list(
        re.finditer(r"(?:^|\n)##\s+[^\n]*(?:实际处置|实用回答|Practical)[^\n]*", report, re.I)
    )
    references_matches = list(
        re.finditer(r"(?:^|\n)##\s+[^\n]*(?:参考文献|References)[^\n]*", report, re.I)
    )
    practical_position = practical_matches[-1].start() if practical_matches else -1
    references_position = references_matches[-1].start() if references_matches else -1
    if practical_position < 0 or references_position < practical_position:
        issues.append("clinical-evidence-report.md: practical section must precede final references")

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
        for field in REQUIRED_CLAIM_FIELDS:
            if not isinstance(claim.get(field), str) or not claim[field].strip():
                issues.append(f"clinical-evidence-matrix.json: claims[{index}].{field} is empty")
        claim_id = claim.get("claimId")
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

    practical = section(report, "实际处置|实用回答|Practical")
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
    if len([line for line in ledger.splitlines() if line.strip()]) < len(claims) + 1:
        issues.append("citation-ledger.csv: require a header and one row per matrix claim")

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
