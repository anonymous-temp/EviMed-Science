"""Manifest summary helpers for artifact packages."""
from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

from new_meta.core.artifact_package_citation_audit import _citation_numbers_from_text
from new_meta.core.artifact_package_language import (
    is_zh_review_language as _is_zh_review_language,
    normalize_review_language as _normalize_review_language,
)
from new_meta.core.artifact_package_polish_review import (
    manuscript_polish_manifest_summary as _manuscript_polish_manifest_summary,
)
from new_meta.core.manuscript_text_metrics import (
    main_publication_word_count,
    publication_min_main_words,
)
from new_meta.core.project import Project

def manuscript_manifest_summary(project: Project) -> dict[str, Any]:
    draft_path = project.base_dir / "manuscript" / "draft.md"
    docx_path = project.base_dir / "manuscript" / "draft.docx"
    pdf_path = project.base_dir / "manuscript" / "draft.pdf"
    facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    text = draft_path.read_text(encoding="utf-8", errors="replace") if draft_path.exists() else ""
    expected_language = _expected_manuscript_language(project, facts if isinstance(facts, dict) else {})
    detected_language = _review_language_from_text(text)
    minimum_main_words = _publication_min_main_words(facts if isinstance(facts, dict) else {})
    content_summary = _manuscript_content_summary(text)
    validation_main_word_count = _validation_main_word_count(text, facts if isinstance(facts, dict) else {})
    return {
        "included": draft_path.exists() and draft_path.stat().st_size > 0,
        "markdown": draft_path.exists() and draft_path.stat().st_size > 0,
        "docx": docx_path.exists() and docx_path.stat().st_size > 0,
        "pdf": pdf_path.exists() and pdf_path.stat().st_size > 0,
        "word_count": _text_unit_count(text),
        "main_word_count": validation_main_word_count,
        "minimum_main_words": minimum_main_words,
        "expected_language": expected_language,
        "language": detected_language,
        "language_matches_expected": not expected_language or expected_language == detected_language,
        "has_publication_section_shape": _has_publication_section_shape(text),
        "requires_publication_length_gate": _requires_publication_length_gate(
            facts if isinstance(facts, dict) else {}
        ),
        **content_summary,
        "report_type": (facts or {}).get("report_type") if isinstance(facts, dict) else None,
        "evidence_status": ((facts or {}).get("evidence_readiness") or {}).get("status") if isinstance(facts, dict) else None,
    }


def _validation_main_word_count(text: str, facts: dict[str, Any]) -> int:
    try:
        from new_meta.core.manuscript_facts import validate_and_repair_manuscript

        _, validation = validate_and_repair_manuscript(text, facts)
        return int((validation.get("facts_summary") or {}).get("main_word_count") or _main_manuscript_word_count(text))
    except Exception:
        return _main_manuscript_word_count(text)



def _citation_fix_quality_delta_summary(entries: list[dict[str, Any]]) -> dict[str, Any]:
    deltas = _unique_citation_fix_quality_deltas(entries)
    resolved_issue_ids: set[str] = set()
    primary_result_issue_ids: set[str] = set()
    claim_support_issue_ids: set[str] = set()
    reference_entries_added = 0
    primary_result_mismatches_resolved = 0
    primary_result_failed_issues_resolved = 0
    claim_support_unsupported_claims_resolved = 0
    claim_support_failed_issues_resolved = 0
    for delta in deltas:
        resolved_issue_ids.update(str(item) for item in (delta.get("resolved_issue_ids") or []) if str(item).strip())
        primary_result_issue_ids.update(
            str(item) for item in (delta.get("resolved_primary_result_issue_ids") or []) if str(item).strip()
        )
        claim_support_issue_ids.update(
            str(item) for item in (delta.get("resolved_claim_support_issue_ids") or []) if str(item).strip()
        )
        try:
            reference_entries_added += int(delta.get("reference_entries_added") or 0)
        except (TypeError, ValueError):
            pass
        primary_result_mismatches_resolved += _quality_delta_int(delta, "primary_result_mismatched_fields_resolved")
        primary_result_failed_issues_resolved += _quality_delta_int(delta, "primary_result_failed_issues_resolved")
        claim_support_unsupported_claims_resolved += _quality_delta_int(delta, "claim_support_unsupported_claims_resolved")
        claim_support_failed_issues_resolved += _quality_delta_int(delta, "claim_support_failed_issues_resolved")
    return {
        "quality_delta_entries": len(deltas),
        "quality_resolved_issues": len(resolved_issue_ids),
        "quality_reference_entries_added": reference_entries_added,
        "quality_primary_result_mismatches_resolved": primary_result_mismatches_resolved,
        "quality_primary_result_issues_resolved": len(primary_result_issue_ids) or primary_result_failed_issues_resolved,
        "quality_claim_support_unsupported_claims_resolved": claim_support_unsupported_claims_resolved,
        "quality_claim_support_issues_resolved": len(claim_support_issue_ids) or claim_support_failed_issues_resolved,
    }


def _quality_delta_int(delta: dict[str, Any], key: str) -> int:
    try:
        return int(delta.get(key) or 0)
    except (TypeError, ValueError):
        return 0


def _unique_citation_fix_quality_deltas(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deltas_by_revision: dict[str, dict[str, Any]] = {}
    for index, entry in enumerate(entries):
        delta = entry.get("quality_delta") if isinstance(entry, dict) else None
        if not isinstance(delta, dict) or not delta:
            continue
        revision_key = str(entry.get("revision") or f"entry-{index}")
        deltas_by_revision.setdefault(revision_key, delta)
    return list(deltas_by_revision.values())


def _citation_fix_human_review_required(entries: list[dict[str, Any]]) -> int:
    return sum(
        1
        for item in entries
        if bool((item.get("trust") or {}).get("requires_human_review"))
        or str((item.get("trust") or {}).get("status") or "") == "needs_review"
    )



def _requires_publication_length_gate(facts: dict[str, Any]) -> bool:
    if not isinstance(facts, dict) or facts.get("report_type") != "meta":
        return False
    readiness = facts.get("evidence_readiness") or {}
    if readiness.get("blockers"):
        return False
    primary = facts.get("primary_effect") or {}
    selected_rows = readiness.get("selected_primary_rows") or []
    primary_n = _coerce_int(primary.get("n_studies")) or len(selected_rows)
    return primary_n >= 2


def _requires_publication_reference_depth_gate(
    facts: dict[str, Any],
    draft_text: str,
    main_word_count: int,
) -> bool:
    if _requires_publication_length_gate(facts):
        return True
    if isinstance(facts, dict) and facts.get("report_type") and facts.get("report_type") != "meta":
        return False
    minimum_words = _publication_min_main_words(facts if isinstance(facts, dict) else {})
    return main_word_count >= minimum_words and _has_publication_section_shape(draft_text)


def _publication_min_main_words(facts: dict[str, Any]) -> int:
    return publication_min_main_words(facts)


def _has_publication_section_shape(text: str) -> bool:
    headings = {_canonical_publication_heading(match.group(1)) for match in re.finditer(r"^#{1,3}\s+(.+?)\s*$", str(text or ""), flags=re.M)}
    required = {"abstract", "introduction", "methods", "results", "discussion"}
    return required.issubset(headings)


def _canonical_publication_heading(heading: str) -> str:
    raw = str(heading or "").strip().lower()
    compact = re.sub(r"[\s\-_/·:：,，、;；()（）]+", "", raw)
    zh_map = {
        "摘要": "abstract",
        "引言": "introduction",
        "绪论": "introduction",
        "前言": "introduction",
        "背景": "introduction",
        "背景目的": "introduction",
        "背景与目的": "introduction",
        "目的": "introduction",
        "研究背景": "introduction",
        "研究目的": "introduction",
        "方法": "methods",
        "材料与方法": "methods",
        "资料与方法": "methods",
        "对象与方法": "methods",
        "研究方法": "methods",
        "结果": "results",
        "研究结果": "results",
        "讨论": "discussion",
        "结论": "conclusion",
        "结论与意义": "conclusion",
        "结语": "conclusion",
    }
    if compact in zh_map:
        return zh_map[compact]
    if re.search(r"[\u4e00-\u9fff]", raw):
        if "方法" in compact:
            return "methods"
        if "结果" in compact:
            return "results"
        if "讨论" in compact:
            return "discussion"
        if "结论" in compact:
            return "conclusion"
        if "引言" in compact or "绪论" in compact or "前言" in compact or "背景" in compact:
            return "introduction"
    if re.search(r"\b(?:abstract|summary)\b", raw):
        return "abstract"
    if re.search(r"\b(?:introduction|intro|background|rationale|objectives?|aims?)\b", raw):
        return "introduction"
    if re.search(r"\b(?:methods?|materials\s+and\s+methods|methodology|statistical\s+analysis)\b", raw):
        return "methods"
    if re.search(r"\b(?:results?|findings)\b", raw):
        return "results"
    if re.search(r"\bdiscussion\b", raw):
        return "discussion"
    if re.search(r"\b(?:conclusions?|conclusions\s+and\s+relevance)\b", raw):
        return "conclusion"
    return raw


def _markdown_section_text(text: str, heading: str) -> str:
    raw = str(text or "")
    match = re.search(rf"^##\s+{re.escape(heading)}\s*$", raw, flags=re.I | re.M)
    if not match:
        return ""
    remainder = raw[match.end():]
    next_heading = re.search(r"^##\s+", remainder, flags=re.M)
    return remainder[: next_heading.start()] if next_heading else remainder


def _markdown_first_section_text(text: str, headings: list[str]) -> str:
    for heading in headings:
        section = _markdown_section_text(text, heading)
        if section:
            return section
    wanted = {_canonical_publication_heading(heading) for heading in headings}
    for section_heading, section_text in _markdown_h2_sections(text):
        if _canonical_publication_heading(section_heading) in wanted:
            return section_text
    return ""


def _markdown_h2_sections(text: str) -> list[tuple[str, str]]:
    raw = str(text or "")
    matches = list(re.finditer(r"^##\s+(.+?)\s*$", raw, flags=re.M))
    sections: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(raw)
        sections.append((match.group(1).strip(), raw[start:end]))
    return sections


def _strip_markdown_code_fences(text: str) -> str:
    return re.sub(r"```.*?```", "", str(text or ""), flags=re.S)


def _main_article_text_before_supplement(text: str) -> str:
    raw = str(text or "")
    cut_points = []
    for heading in (
        "## Supplementary Materials",
        "## Supplementary material",
        "## Supplementary",
        "## 补充材料",
    ):
        index = raw.find(heading)
        if index >= 0:
            cut_points.append(index)
    reference_match = _reference_heading_match(raw)
    if reference_match:
        cut_points.append(reference_match.start())
    return raw[: min(cut_points)] if cut_points else raw


def _main_manuscript_word_count(text: str) -> int:
    return main_publication_word_count(text)


def _text_unit_count(text: str) -> int:
    raw = str(text or "")
    return len(re.findall(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?|[\u4e00-\u9fff]|[%./+-]+", raw))


def _manuscript_content_summary(text: str) -> dict[str, Any]:
    raw = str(text or "")
    lower = raw.lower()
    references = _references_section_text(raw)
    return {
        "has_search_query_in_manuscript": _has_search_query_in_manuscript(raw),
        "has_calculation_detail": _has_calculation_detail(raw),
        "table_count": len(_numbered_heading_refs(raw, "Table")),
        "figure_count": _numbered_figure_count(raw),
        "reference_count": _reference_entry_count(references),
        "has_references_section": bool(_reference_heading_match(raw)),
    }


def _numbered_heading_refs(text: str, label: str) -> list[dict[str, Any]]:
    refs = []
    for match in re.finditer(_numbered_heading_pattern(label), str(text or ""), flags=re.I | re.M):
        refs.append({
            "number": _integer_or_none(match.group(1)),
            "title": match.group(2).strip(),
        })
    return refs


def _numbered_text_refs(text: str, label: str) -> list[int]:
    numbers: list[int] = []
    raw = str(text or "")
    english_raw = re.sub(
        rf"(?<=\d)\s*(,|and|[-–])\s*{re.escape(label)}s?\s*(?=\d)",
        lambda match: f" {match.group(1)} ",
        raw,
        flags=re.I,
    )
    for match in re.finditer(rf"\b{re.escape(label)}s?\s+(\d+(?:\s*(?:,|and|[-–])\s*\d+)*)", english_raw, flags=re.I):
        token = match.group(1)
        for part in re.split(r"\s*,\s*|\s+and\s+", token):
            if re.search(r"[-–]", part):
                bounds = [item.strip() for item in re.split(r"[-–]", part, maxsplit=1)]
                if len(bounds) != 2:
                    continue
                start = _integer_or_none(bounds[0])
                end = _integer_or_none(bounds[1])
                if start is None or end is None or end < start:
                    continue
                numbers.extend(range(start, end + 1))
            else:
                value = _integer_or_none(part)
                if value is not None:
                    numbers.append(value)
    chinese_label = _chinese_numbered_label(label)
    if chinese_label:
        chinese_raw = re.sub(
            rf"(?<=\d)\s*(,|，|、|和|及|与|至|[-–])\s*{chinese_label}\s*(?=\d)",
            lambda match: match.group(1),
            raw,
        )
        chinese_token = rf"\d+(?:\s*(?:,|，|、|和|及|与|至|[-–])\s*\d+)*"
        for match in re.finditer(rf"{chinese_label}\s*({chinese_token})", chinese_raw, flags=re.I):
            token = match.group(1)
            for part in re.split(r"\s*(?:,|，|、|和|及|与)\s*", token):
                if re.search(r"[-–]|至", part):
                    bounds = [item.strip() for item in re.split(r"[-–]|至", part, maxsplit=1)]
                    if len(bounds) != 2:
                        continue
                    start = _integer_or_none(bounds[0])
                    end = _integer_or_none(bounds[1])
                    if start is None or end is None or end < start:
                        continue
                    numbers.extend(range(start, end + 1))
                else:
                    value = _integer_or_none(part)
                    if value is not None:
                        numbers.append(value)
    return numbers


def _numbered_heading_pattern(label: str) -> str:
    chinese_label = _chinese_numbered_label(label)
    if chinese_label:
        return rf"^#{{1,4}}\s+(?:{re.escape(label)}\s+|{chinese_label}\s*)(\d+)[.．:：]?\s*(.*)$"
    return rf"^#{{1,4}}\s+{re.escape(label)}\s+(\d+)[.．:：]?\s*(.*)$"


def _chinese_numbered_label(label: str) -> str:
    normalized = str(label or "").strip().lower()
    if normalized == "table":
        return "表"
    if normalized == "figure":
        return "图"
    return ""



def _numbered_figure_count(text: str) -> int:
    figure_numbers: set[int] = set()
    for ref in _numbered_heading_refs(text, "Figure"):
        number = ref.get("number")
        if isinstance(number, int):
            figure_numbers.add(number)
    for match in re.finditer(
        r"!\[[^\]]*(?:Figure\s+|图\s*)(\d+)[^\]]*\]",
        str(text or ""),
        flags=re.I | re.M,
    ):
        number_text = match.group(1)
        if number_text:
            figure_numbers.add(int(number_text))
    return len(figure_numbers)


def _has_search_query_in_manuscript(text: str) -> bool:
    lower = str(text or "").lower()
    has_label = any(
        phrase in lower
        for phrase in (
            "full search query",
            "search query",
            "search strategy",
            "boolean strategy",
            "检索式",
            "检索策略",
        )
    )
    has_query_syntax = (
        "```text" in lower
        or "[tiab]" in lower
        or "[mh]" in lower
        or bool(re.search(r"\b(?:and|or|not)\b.*\(", lower, flags=re.I | re.S))
    )
    return has_label and has_query_syntax


def _has_calculation_detail(text: str) -> bool:
    lower = str(text or "").lower()
    has_effect = bool(re.search(r"\b(?:or|rr|hr|md|smd)\s+\d", lower))
    has_ci = "95% ci" in lower or "95% confidence interval" in lower
    has_model_or_heterogeneity = any(term in lower for term in ("heterogeneity", "i²", "i2", "tau", "cochran", "inverse-variance"))
    has_calculation_label = any(term in lower for term in ("calculation notes", "pooled estimate", "meta-analysis", "统计模型", "合并效应"))
    return has_effect and has_ci and has_model_or_heterogeneity and has_calculation_label


def _references_section_text(text: str) -> str:
    raw = str(text or "")
    match = _reference_heading_match(raw)
    if not match:
        return ""
    remainder = raw[match.end():]
    next_heading = re.search(r"^#{1,6}\s+", remainder, flags=re.M)
    return remainder[: next_heading.start()] if next_heading else remainder


def _main_text_before_reference_section(text: str) -> str:
    raw = str(text or "")
    match = _reference_heading_match(raw)
    return raw[: match.start()] if match else raw


def _reference_heading_match(text: str) -> re.Match[str] | None:
    reference_heading = (
        r"(?:"
        r"References?|Bibliography|Literature\s+Cited|Works\s+Cited|"
        r"参考文献|参考资料|引用文献|文献"
        r")"
    )
    return re.search(rf"^#{{1,6}}\s+{reference_heading}\s*[:：]?\s*$", str(text or ""), flags=re.I | re.M)


def _review_language_from_text(text: str) -> str:
    raw = _language_detection_text(str(text or ""))
    cjk_chars = len(re.findall(r"[\u4e00-\u9fff]", raw))
    latin_letters = len(re.findall(r"[A-Za-z]", raw))
    if cjk_chars >= 10 and latin_letters >= 200:
        cjk_share = cjk_chars / max(1, cjk_chars + latin_letters)
        if 0.01 <= cjk_share <= 0.80:
            return "mixed"
    latin_words = len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", raw))
    return "zh" if cjk_chars and cjk_chars >= latin_words else "en"


def _should_use_chinese_citation_style(text: str, language: str) -> bool:
    if _is_zh_review_language(language):
        return True
    raw = str(text or "")
    return bool(re.search(r"^#*\s*参考文献\s*$", raw, flags=re.M)) or bool(
        re.search(r"[\u4e00-\u9fff]", _main_text_before_reference_section(raw))
    )


def _ascii_numeric_citation_marker_number_count_outside_code(text: str) -> int:
    outside_code = re.sub(r"```[\s\S]*?```", " ", str(text or ""))
    count = 0
    for match in re.finditer(r"\[([0-9][0-9,\s;；、，\-–—]*)\]", outside_code):
        count += len(_citation_numbers_from_text(match.group(0)))
    return count


def _language_detection_text(text: str) -> str:
    raw = _main_text_before_reference_section(str(text or ""))
    raw = re.sub(r"```[\s\S]*?```", " ", raw)
    kept_lines: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            kept_lines.append(line)
            continue
        if stripped.startswith("|") or stripped.startswith("!["):
            continue
        kept_lines.append(line)
    return "\n".join(kept_lines)


def _expected_manuscript_language(project: Project, facts: dict[str, Any] | None = None) -> str:
    facts = facts if isinstance(facts, dict) else {}
    candidates = [
        facts.get("output_language"),
        facts.get("manuscript_language"),
        facts.get("language"),
    ]
    try:
        language_record = project.load_json("manuscript_output_language.json", subdir="manuscript")
    except Exception:
        language_record = None
    if isinstance(language_record, dict):
        candidates.extend([
            language_record.get("expected_language"),
            language_record.get("output_language"),
            language_record.get("language"),
        ])
    for candidate in candidates:
        normalized = _normalize_review_language(candidate)
        if normalized:
            return normalized
    return ""


def _infer_project_review_language(project: Project, facts: dict[str, Any] | None = None) -> str:
    facts = facts if isinstance(facts, dict) else project.load_json("manuscript_facts.json", subdir="manuscript")
    if not isinstance(facts, dict):
        facts = {}
    draft_path = project.base_dir / "manuscript" / "draft.md"
    draft_text = ""
    if draft_path.exists():
        try:
            draft_text = draft_path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            draft_text = ""
    return _expected_manuscript_language(project, facts) or _review_language_from_text(draft_text)


def _reference_entry_count(references_text: str) -> int:
    text = str(references_text or "")
    numbered = re.findall(r"^\s*(?:\[\d+\]|［\d+］)\s+\S", text, flags=re.M)
    bullets = re.findall(r"^\s*[-*]\s+\S", text, flags=re.M)
    bib = re.findall(r"@\w+\s*\{", text)
    return len(numbered) + len(bullets) + len(bib)


def _coerce_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _number_or_none(value: Any) -> float | None:
    try:
        if value is None:
            return None
        number = float(value)
        if math.isnan(number) or math.isinf(number):
            return None
        return number
    except (TypeError, ValueError):
        return None


def _integer_or_none(value: Any) -> int | None:
    number = _number_or_none(value)
    return int(number) if number is not None else None


def _count_bib_entries(path: Path) -> int:
    if not path.exists() or not path.is_file():
        return 0
    try:
        return len(re.findall(r"@\w+\s*\{", path.read_text(encoding="utf-8", errors="replace")))
    except OSError:
        return 0


def submission_manifest_summary(generated_entries: list[tuple[str, Any]]) -> dict[str, Any]:
    submission = next((payload for arcname, payload in generated_entries if arcname == "review/submission_readiness_review.json"), None)
    if not isinstance(submission, dict):
        return {
            "included": False,
            "passed": False,
            "status": "",
            "failed_gates": 0,
            "warning_gates": 0,
            "html_review": False,
        }
    summary = submission.get("summary") or {}
    return {
        "included": True,
        "passed": bool(submission.get("passed")),
        "status": submission.get("status") or "",
        "failed_gates": summary.get("failed_gates", 0),
        "warning_gates": summary.get("warning_gates", 0),
        "html_review": any(arcname == "review/submission_readiness_review.html" for arcname, _ in generated_entries),
    }


def review_manifest_summary(project: Project, generated_entries: list[tuple[str, Any]]) -> dict:
    pdf_intake = next((payload for arcname, payload in generated_entries if arcname == "review/pdf_intake_review.json"), None)
    text_source_coverage = next((payload for arcname, payload in generated_entries if arcname == "review/text_source_coverage_audit.json"), None)
    review = next((payload for arcname, payload in generated_entries if arcname == "review/evidence_readiness_review.json"), None)
    abstract = next((payload for arcname, payload in generated_entries if arcname == "review/abstract_audit.json"), None)
    publication_tone = next((payload for arcname, payload in generated_entries if arcname == "review/publication_tone_audit.json"), None)
    readability = next((payload for arcname, payload in generated_entries if arcname == "review/readability_audit.json"), None)
    clinical_interpretation = next((payload for arcname, payload in generated_entries if arcname == "review/clinical_interpretation_audit.json"), None)
    reference = next((payload for arcname, payload in generated_entries if arcname == "review/reference_audit.json"), None)
    citation = next((payload for arcname, payload in generated_entries if arcname == "review/citation_audit.json"), None)
    prisma = next((payload for arcname, payload in generated_entries if arcname == "review/prisma_audit.json"), None)
    search_strategy = next((payload for arcname, payload in generated_entries if arcname == "review/search_strategy_audit.json"), None)
    figure = next((payload for arcname, payload in generated_entries if arcname == "review/figure_audit.json"), None)
    figure_legend = next((payload for arcname, payload in generated_entries if arcname == "review/figure_legend_audit.json"), None)
    cross_reference = next((payload for arcname, payload in generated_entries if arcname == "review/cross_reference_audit.json"), None)
    table_footnote = next((payload for arcname, payload in generated_entries if arcname == "review/table_footnote_audit.json"), None)
    llm_reliability = next((payload for arcname, payload in generated_entries if arcname == "review/llm_reliability_audit.json"), None)
    risk_of_bias_completeness = next((payload for arcname, payload in generated_entries if arcname == "review/risk_of_bias_completeness.json"), None)
    primary_result = next((payload for arcname, payload in generated_entries if arcname == "review/primary_result_audit.json"), None)
    claim_support = next((payload for arcname, payload in generated_entries if arcname == "review/claim_support_audit.json"), None)
    primary_source_trace = next((payload for arcname, payload in generated_entries if arcname == "review/primary_source_trace.json"), None)
    benchmark = next((payload for arcname, payload in generated_entries if arcname == "review/benchmark_review.json"), None)
    publication_similarity = next((payload for arcname, payload in generated_entries if arcname == "review/publication_similarity_review.json"), None)
    calculation = next((payload for arcname, payload in generated_entries if arcname == "review/calculation_audit.json"), None)
    manuscript_polish = _manuscript_polish_manifest_summary(project, generated_entries)
    citation_fixes = manuscript_citation_fix_manifest_summary(project, generated_entries)
    if (
        not isinstance(pdf_intake, dict)
        and not isinstance(text_source_coverage, dict)
        and not isinstance(review, dict)
        and not isinstance(abstract, dict)
        and not isinstance(publication_tone, dict)
        and not isinstance(readability, dict)
        and not isinstance(clinical_interpretation, dict)
        and not isinstance(reference, dict)
        and not isinstance(citation, dict)
        and not isinstance(prisma, dict)
        and not isinstance(search_strategy, dict)
        and not isinstance(figure, dict)
        and not isinstance(figure_legend, dict)
        and not isinstance(cross_reference, dict)
        and not isinstance(table_footnote, dict)
        and not isinstance(llm_reliability, dict)
        and not isinstance(risk_of_bias_completeness, dict)
        and not isinstance(primary_result, dict)
        and not isinstance(claim_support, dict)
        and not isinstance(primary_source_trace, dict)
        and not isinstance(benchmark, dict)
        and not isinstance(publication_similarity, dict)
        and not isinstance(calculation, dict)
        and not manuscript_polish.get("manuscript_polish_included")
        and not citation_fixes.get("manuscript_citation_fixes_included")
    ):
        return {"included": False}
    summary = {
        "included": True,
    }
    summary.update(manuscript_polish)
    summary.update(citation_fixes)
    if isinstance(pdf_intake, dict):
        pdf_summary = pdf_intake.get("summary") or {}
        summary.update({
            "pdf_intake_included": True,
            "pdf_intake_total_files": pdf_summary.get("total_files", 0),
            "pdf_intake_ok": pdf_summary.get("ok", 0),
            "pdf_intake_empty_text": pdf_summary.get("empty_text", 0),
            "pdf_intake_failed": pdf_summary.get("failed", 0),
            "pdf_intake_requires_review": pdf_summary.get("requires_user_review", 0),
            "pdf_intake_cache_hits": pdf_summary.get("cache_hits", 0),
            "pdf_intake_html_review": any(arcname == "review/pdf_intake_review.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "pdf_intake_included": False,
            "pdf_intake_total_files": 0,
            "pdf_intake_ok": 0,
            "pdf_intake_empty_text": 0,
            "pdf_intake_failed": 0,
            "pdf_intake_requires_review": 0,
            "pdf_intake_cache_hits": 0,
            "pdf_intake_html_review": False,
        })
    if isinstance(text_source_coverage, dict):
        text_source_summary = text_source_coverage.get("summary") or {}
        summary.update({
            "text_source_coverage_included": True,
            "text_source_coverage_status": text_source_coverage.get("status") or "",
            "text_source_coverage_total_records": text_source_summary.get("total_records", 0),
            "text_source_coverage_full_text_records": text_source_summary.get("full_text_records", 0),
            "text_source_coverage_abstract_only_records": text_source_summary.get("abstract_only_records", 0),
            "text_source_coverage_metadata_only_records": text_source_summary.get("metadata_only_records", 0),
            "text_source_coverage_registry_only_records": text_source_summary.get("registry_only_records", 0),
            "text_source_coverage_unknown_records": text_source_summary.get("unknown_records", 0),
            "text_source_coverage_limited_records": text_source_summary.get("limited_source_records", 0),
            "text_source_coverage_action_required_records": text_source_summary.get("action_required_limited_records", 0),
            "text_source_coverage_screening_only_limited_records": text_source_summary.get("screening_only_limited_records", 0),
            "text_source_coverage_records_requiring_review": text_source_summary.get("records_requiring_review", 0),
            "text_source_coverage_html_review": any(
                arcname == "review/text_source_coverage_audit.html" for arcname, _ in generated_entries
            ),
        })
    else:
        summary.update({
            "text_source_coverage_included": False,
            "text_source_coverage_status": "",
            "text_source_coverage_total_records": 0,
            "text_source_coverage_full_text_records": 0,
            "text_source_coverage_abstract_only_records": 0,
            "text_source_coverage_metadata_only_records": 0,
            "text_source_coverage_registry_only_records": 0,
            "text_source_coverage_unknown_records": 0,
            "text_source_coverage_limited_records": 0,
            "text_source_coverage_action_required_records": 0,
            "text_source_coverage_screening_only_limited_records": 0,
            "text_source_coverage_records_requiring_review": 0,
            "text_source_coverage_html_review": False,
        })
    if isinstance(review, dict):
        summary.update({
            "status": review.get("status"),
            "blocker_count": (review.get("summary") or {}).get("blockers", 0),
            "warning_count": (review.get("summary") or {}).get("warnings", 0),
            "timepoint_adjudication_rows": (review.get("summary") or {}).get("timepoint_adjudication_rows", 0),
            "primary_count_verification_rows": (review.get("summary") or {}).get("primary_count_verification_rows", 0),
            "extraction_source_cards": (review.get("summary") or {}).get("extraction_source_cards", 0),
            "extraction_review_cards": (review.get("summary") or {}).get("extraction_review_cards", 0),
            "source_context_available_cards": (review.get("summary") or {}).get("source_context_available_cards", 0),
            "source_context_missing_cards": (review.get("summary") or {}).get("source_context_missing_cards", 0),
            "source_context_coverage": (review.get("summary") or {}).get("source_context_coverage", 1.0),
            "source_context_missing_review_cards": (review.get("summary") or {}).get("source_context_missing_review_cards", 0),
            "selected_primary_source_cards": (review.get("summary") or {}).get("selected_primary_source_cards", 0),
            "selected_primary_source_context_available_cards": (review.get("summary") or {}).get("selected_primary_source_context_available_cards", 0),
            "selected_primary_source_context_missing_cards": (review.get("summary") or {}).get("selected_primary_source_context_missing_cards", 0),
            "selected_primary_source_context_coverage": (review.get("summary") or {}).get("selected_primary_source_context_coverage", 1.0),
            "grade_review_outcomes": (review.get("summary") or {}).get("grade_review_outcomes", 0),
            "grade_review_domains": (review.get("summary") or {}).get("grade_review_domains", 0),
            "grade_review_domains_with_details": (review.get("summary") or {}).get("grade_review_domains_with_details", 0),
            "html_review": any(arcname == "review/extraction_review.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "status": None,
            "blocker_count": 0,
            "warning_count": 0,
            "timepoint_adjudication_rows": 0,
            "primary_count_verification_rows": 0,
            "extraction_source_cards": 0,
            "extraction_review_cards": 0,
            "source_context_available_cards": 0,
            "source_context_missing_cards": 0,
            "source_context_coverage": 1.0,
            "source_context_missing_review_cards": 0,
            "selected_primary_source_cards": 0,
            "selected_primary_source_context_available_cards": 0,
            "selected_primary_source_context_missing_cards": 0,
            "selected_primary_source_context_coverage": 1.0,
            "grade_review_outcomes": 0,
            "grade_review_domains": 0,
            "grade_review_domains_with_details": 0,
            "html_review": False,
        })
    if isinstance(abstract, dict):
        abstract_summary = abstract.get("summary") or {}
        summary.update({
            "abstract_audit_included": True,
            "abstract_audit_passed": abstract.get("passed"),
            "abstract_audit_word_count": abstract_summary.get("word_count", 0),
            "abstract_audit_present_labels": abstract_summary.get("present_labels", 0),
            "abstract_audit_required_labels": abstract_summary.get("required_labels", 0),
            "abstract_audit_missing_labels": abstract_summary.get("missing_labels", 0),
            "abstract_audit_forbidden_phrase_count": abstract_summary.get("forbidden_phrase_count", 0),
            "abstract_audit_failed_issues": abstract_summary.get("failed_issues", 0),
            "abstract_audit_html_review": any(arcname == "review/abstract_audit.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "abstract_audit_included": False,
            "abstract_audit_passed": None,
            "abstract_audit_word_count": 0,
            "abstract_audit_present_labels": 0,
            "abstract_audit_required_labels": 0,
            "abstract_audit_missing_labels": 0,
            "abstract_audit_forbidden_phrase_count": 0,
            "abstract_audit_failed_issues": 0,
            "abstract_audit_html_review": False,
        })
    if isinstance(publication_tone, dict):
        publication_tone_summary = publication_tone.get("summary") or {}
        summary.update({
            "publication_tone_audit_included": True,
            "publication_tone_audit_passed": publication_tone.get("passed"),
            "publication_tone_audit_scanned_word_count": publication_tone_summary.get("scanned_word_count", 0),
            "publication_tone_audit_forbidden_phrase_count": publication_tone_summary.get("forbidden_phrase_count", 0),
            "publication_tone_audit_failed_issues": publication_tone_summary.get("failed_issues", 0),
            "publication_tone_audit_html_review": any(arcname == "review/publication_tone_audit.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "publication_tone_audit_included": False,
            "publication_tone_audit_passed": None,
            "publication_tone_audit_scanned_word_count": 0,
            "publication_tone_audit_forbidden_phrase_count": 0,
            "publication_tone_audit_failed_issues": 0,
            "publication_tone_audit_html_review": False,
        })
    if isinstance(readability, dict):
        readability_summary = readability.get("summary") or {}
        summary.update({
            "readability_audit_included": True,
            "readability_audit_passed": readability.get("passed"),
            "readability_audit_scanned_sections": readability_summary.get("scanned_sections", 0),
            "readability_audit_scanned_word_count": readability_summary.get("scanned_word_count", 0),
            "readability_audit_verbose_pico_fragments": readability_summary.get("verbose_pico_fragments", 0),
            "readability_audit_overlong_sentences": readability_summary.get("overlong_sentences", 0),
            "readability_audit_failed_issues": readability_summary.get("failed_issues", 0),
            "readability_audit_html_review": any(arcname == "review/readability_audit.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "readability_audit_included": False,
            "readability_audit_passed": None,
            "readability_audit_scanned_sections": 0,
            "readability_audit_scanned_word_count": 0,
            "readability_audit_verbose_pico_fragments": 0,
            "readability_audit_overlong_sentences": 0,
            "readability_audit_failed_issues": 0,
            "readability_audit_html_review": False,
        })
    if isinstance(clinical_interpretation, dict):
        clinical_summary = clinical_interpretation.get("summary") or {}
        summary.update({
            "clinical_interpretation_audit_included": True,
            "clinical_interpretation_audit_passed": clinical_interpretation.get("passed"),
            "clinical_interpretation_audit_covered_domains": clinical_summary.get("covered_domains", 0),
            "clinical_interpretation_audit_domain_count": clinical_summary.get("domain_count", 0),
            "clinical_interpretation_audit_minimum_domains": clinical_summary.get("minimum_domains", 0),
            "clinical_interpretation_audit_result_context_present": bool(clinical_summary.get("result_context_present")),
            "clinical_interpretation_audit_failed_issues": clinical_summary.get("failed_issues", 0),
            "clinical_interpretation_audit_html_review": any(arcname == "review/clinical_interpretation_audit.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "clinical_interpretation_audit_included": False,
            "clinical_interpretation_audit_passed": None,
            "clinical_interpretation_audit_covered_domains": 0,
            "clinical_interpretation_audit_domain_count": 0,
            "clinical_interpretation_audit_minimum_domains": 0,
            "clinical_interpretation_audit_result_context_present": False,
            "clinical_interpretation_audit_failed_issues": 0,
            "clinical_interpretation_audit_html_review": False,
        })
    if isinstance(publication_similarity, dict):
        similarity_summary = publication_similarity.get("summary") or {}
        summary.update({
            "publication_similarity_included": True,
            "publication_similarity_passed": publication_similarity.get("passed"),
            "publication_similarity_score": publication_similarity.get("similarity_score", 0),
            "publication_similarity_threshold": publication_similarity.get("threshold", 0),
            "publication_similarity_components_passing": similarity_summary.get("components_passing", 0),
            "publication_similarity_component_count": similarity_summary.get("component_count", 0),
            "publication_similarity_components_below_target": similarity_summary.get("components_below_target", 0),
            "publication_similarity_html_review": any(
                arcname == "review/publication_similarity_review.html" for arcname, _ in generated_entries
            ),
        })
    else:
        summary.update({
            "publication_similarity_included": False,
            "publication_similarity_passed": None,
            "publication_similarity_score": 0,
            "publication_similarity_threshold": 0,
            "publication_similarity_components_passing": 0,
            "publication_similarity_component_count": 0,
            "publication_similarity_components_below_target": 0,
            "publication_similarity_html_review": False,
        })
    if isinstance(reference, dict):
        reference_summary = reference.get("summary") or {}
        summary.update({
            "reference_audit_included": True,
            "reference_audit_passed": reference.get("passed"),
            "reference_audit_manuscript_references": reference_summary.get("manuscript_references", 0),
            "reference_audit_bib_entries": reference_summary.get("bib_entries", 0),
            "reference_audit_count_mismatch": bool(reference_summary.get("count_mismatch")),
            "reference_audit_missing_identifiers": reference_summary.get("entries_missing_identifier", 0),
            "reference_audit_missing_journal": reference_summary.get("entries_missing_journal", 0),
            "reference_audit_missing_volume_or_pages": reference_summary.get("entries_missing_volume_or_pages", 0),
            "reference_audit_long_author_entries": reference_summary.get("very_long_author_entries", 0),
            "reference_audit_registry_entries": reference_summary.get("registry_entries", 0),
            "reference_audit_html_review": any(arcname == "review/reference_audit.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "reference_audit_included": False,
            "reference_audit_passed": None,
            "reference_audit_manuscript_references": 0,
            "reference_audit_bib_entries": 0,
            "reference_audit_count_mismatch": False,
            "reference_audit_missing_identifiers": 0,
            "reference_audit_missing_journal": 0,
            "reference_audit_missing_volume_or_pages": 0,
            "reference_audit_long_author_entries": 0,
            "reference_audit_registry_entries": 0,
            "reference_audit_html_review": False,
        })
    if isinstance(citation, dict):
        citation_summary = citation.get("summary") or {}
        summary.update({
            "citation_audit_included": True,
            "citation_audit_passed": citation.get("passed"),
            "citation_audit_reference_entries": citation_summary.get("reference_entries", 0),
            "citation_audit_publication_minimum_reference_entries": citation_summary.get("publication_minimum_reference_entries", 0),
            "citation_audit_main_text_inline_citations": citation_summary.get("main_text_inline_citations", 0),
            "citation_audit_introduction_inline_citations": citation_summary.get("introduction_inline_citations", 0),
            "citation_audit_introduction_paragraph_coverage": citation_summary.get("introduction_cited_paragraph_rate", 0),
            "citation_audit_results_inline_citations": citation_summary.get("results_inline_citations", 0),
            "citation_audit_discussion_inline_citations": citation_summary.get("discussion_inline_citations", 0),
            "citation_audit_conclusion_inline_citations": citation_summary.get("conclusion_inline_citations", 0),
            "citation_audit_discussion_paragraph_coverage": citation_summary.get("discussion_cited_paragraph_rate", 0),
            "citation_audit_overloaded_citation_clusters": citation_summary.get("overloaded_citation_clusters", 0),
            "citation_audit_repeated_large_citation_clusters": citation_summary.get("repeated_large_citation_clusters", 0),
            "citation_audit_mechanical_citation_density_paragraphs": citation_summary.get(
                "mechanical_citation_density_paragraphs", 0
            ),
            "citation_audit_uncited_numeric_effect_claims": citation_summary.get("uncited_numeric_effect_claims", 0),
            "citation_audit_numeric_effect_claims_without_source_citations": citation_summary.get("numeric_effect_claims_without_source_citations", 0),
            "citation_audit_uncited_results_study_data_claims": citation_summary.get("uncited_results_study_data_claims", 0),
            "citation_audit_uncited_introduction_background_claims": citation_summary.get("uncited_introduction_background_claims", 0),
            "citation_audit_uncited_methods_methodology_claims": citation_summary.get("uncited_methods_methodology_claims", 0),
            "citation_audit_uncited_discussion_context_claims": citation_summary.get("uncited_discussion_context_claims", 0),
            "citation_audit_uncited_discussion_result_claims": citation_summary.get("uncited_discussion_result_claims", 0),
            "citation_audit_uncited_discussion_mechanism_claims": citation_summary.get("uncited_discussion_mechanism_claims", 0),
            "citation_audit_uncited_conclusion_result_claims": citation_summary.get("uncited_conclusion_result_claims", 0),
            "citation_audit_undefined_citation_numbers": citation_summary.get("undefined_citation_numbers", 0),
            "citation_audit_failed_issues": citation_summary.get("failed_issues", 0),
            "citation_audit_warning_issues": citation_summary.get("warning_issues", 0),
            "citation_audit_density_per_1000_words": citation_summary.get("citation_density_per_1000_words", 0),
            "citation_audit_html_review": any(arcname == "review/citation_audit.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "citation_audit_included": False,
            "citation_audit_passed": None,
            "citation_audit_reference_entries": 0,
            "citation_audit_publication_minimum_reference_entries": 0,
            "citation_audit_main_text_inline_citations": 0,
            "citation_audit_introduction_inline_citations": 0,
            "citation_audit_introduction_paragraph_coverage": 0,
            "citation_audit_results_inline_citations": 0,
            "citation_audit_discussion_inline_citations": 0,
            "citation_audit_conclusion_inline_citations": 0,
            "citation_audit_discussion_paragraph_coverage": 0,
            "citation_audit_overloaded_citation_clusters": 0,
            "citation_audit_repeated_large_citation_clusters": 0,
            "citation_audit_mechanical_citation_density_paragraphs": 0,
            "citation_audit_uncited_numeric_effect_claims": 0,
            "citation_audit_numeric_effect_claims_without_source_citations": 0,
            "citation_audit_uncited_results_study_data_claims": 0,
            "citation_audit_uncited_introduction_background_claims": 0,
            "citation_audit_uncited_methods_methodology_claims": 0,
            "citation_audit_uncited_discussion_context_claims": 0,
            "citation_audit_uncited_discussion_result_claims": 0,
            "citation_audit_uncited_discussion_mechanism_claims": 0,
            "citation_audit_uncited_conclusion_result_claims": 0,
            "citation_audit_undefined_citation_numbers": 0,
            "citation_audit_failed_issues": 0,
            "citation_audit_warning_issues": 0,
            "citation_audit_density_per_1000_words": 0,
            "citation_audit_html_review": False,
        })
    if isinstance(prisma, dict):
        prisma_summary = prisma.get("summary") or {}
        summary.update({
            "prisma_audit_included": True,
            "prisma_audit_passed": prisma.get("passed"),
            "prisma_audit_expected_fields": prisma_summary.get("expected_fields", 0),
            "prisma_audit_matched_fields": prisma_summary.get("matched_fields", 0),
            "prisma_audit_mismatched_fields": prisma_summary.get("mismatched_fields", 0),
            "prisma_audit_missing_fields": prisma_summary.get("missing_fields", 0),
            "prisma_audit_logical_issues": prisma_summary.get("logical_issues", 0),
            "prisma_audit_html_review": any(arcname == "review/prisma_audit.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "prisma_audit_included": False,
            "prisma_audit_passed": None,
            "prisma_audit_expected_fields": 0,
            "prisma_audit_matched_fields": 0,
            "prisma_audit_mismatched_fields": 0,
            "prisma_audit_missing_fields": 0,
            "prisma_audit_logical_issues": 0,
            "prisma_audit_html_review": False,
        })
    if isinstance(search_strategy, dict):
        search_summary = search_strategy.get("summary") or {}
        summary.update({
            "search_strategy_audit_included": True,
            "search_strategy_audit_passed": search_strategy.get("passed"),
            "search_strategy_audit_exact_query_reproduced": bool(search_summary.get("exact_query_reproduced")),
            "search_strategy_audit_query_chars": search_summary.get("query_chars", 0),
            "search_strategy_audit_failed_issues": search_summary.get("failed_issues", 0),
            "search_strategy_audit_html_review": any(arcname == "review/search_strategy_audit.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "search_strategy_audit_included": False,
            "search_strategy_audit_passed": None,
            "search_strategy_audit_exact_query_reproduced": False,
            "search_strategy_audit_query_chars": 0,
            "search_strategy_audit_failed_issues": 0,
            "search_strategy_audit_html_review": False,
        })
    if isinstance(figure, dict):
        figure_summary = figure.get("summary") or {}
        summary.update({
            "figure_audit_included": True,
            "figure_audit_passed": figure.get("passed"),
            "figure_audit_referenced_images": figure_summary.get("referenced_images", 0),
            "figure_audit_packaged_png_files": figure_summary.get("packaged_png_files", 0),
            "figure_audit_missing_referenced_images": figure_summary.get("missing_referenced_images", 0),
            "figure_audit_external_referenced_images": figure_summary.get("external_referenced_images", 0),
            "figure_audit_unused_png_files": figure_summary.get("unused_png_files", 0),
            "figure_audit_html_review": any(arcname == "review/figure_audit.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "figure_audit_included": False,
            "figure_audit_passed": None,
            "figure_audit_referenced_images": 0,
            "figure_audit_packaged_png_files": 0,
            "figure_audit_missing_referenced_images": 0,
            "figure_audit_external_referenced_images": 0,
            "figure_audit_unused_png_files": 0,
            "figure_audit_html_review": False,
        })
    if isinstance(figure_legend, dict):
        figure_legend_summary = figure_legend.get("summary") or {}
        summary.update({
            "figure_legend_audit_included": True,
            "figure_legend_audit_passed": figure_legend.get("passed"),
            "figure_legend_audit_figure_count": figure_legend_summary.get("figure_count", 0),
            "figure_legend_audit_figures_with_legends": figure_legend_summary.get("figures_with_legends", 0),
            "figure_legend_audit_missing_legends": figure_legend_summary.get("missing_legends", 0),
            "figure_legend_audit_failed_issues": figure_legend_summary.get("failed_issues", 0),
            "figure_legend_audit_html_review": any(arcname == "review/figure_legend_audit.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "figure_legend_audit_included": False,
            "figure_legend_audit_passed": None,
            "figure_legend_audit_figure_count": 0,
            "figure_legend_audit_figures_with_legends": 0,
            "figure_legend_audit_missing_legends": 0,
            "figure_legend_audit_failed_issues": 0,
            "figure_legend_audit_html_review": False,
        })
    if isinstance(cross_reference, dict):
        cross_summary = cross_reference.get("summary") or {}
        summary.update({
            "cross_reference_audit_included": True,
            "cross_reference_audit_passed": cross_reference.get("passed"),
            "cross_reference_audit_defined_tables": cross_summary.get("defined_tables", 0),
            "cross_reference_audit_defined_figures": cross_summary.get("defined_figures", 0),
            "cross_reference_audit_main_text_referenced_tables": cross_summary.get("main_text_referenced_tables", 0),
            "cross_reference_audit_main_text_referenced_figures": cross_summary.get("main_text_referenced_figures", 0),
            "cross_reference_audit_unreferenced_tables": cross_summary.get("unreferenced_tables", 0),
            "cross_reference_audit_unreferenced_figures": cross_summary.get("unreferenced_figures", 0),
            "cross_reference_audit_failed_issues": cross_summary.get("failed_issues", 0),
            "cross_reference_audit_html_review": any(arcname == "review/cross_reference_audit.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "cross_reference_audit_included": False,
            "cross_reference_audit_passed": None,
            "cross_reference_audit_defined_tables": 0,
            "cross_reference_audit_defined_figures": 0,
            "cross_reference_audit_main_text_referenced_tables": 0,
            "cross_reference_audit_main_text_referenced_figures": 0,
            "cross_reference_audit_unreferenced_tables": 0,
            "cross_reference_audit_unreferenced_figures": 0,
            "cross_reference_audit_failed_issues": 0,
            "cross_reference_audit_html_review": False,
        })
    if isinstance(table_footnote, dict):
        table_footnote_summary = table_footnote.get("summary") or {}
        summary.update({
            "table_footnote_audit_included": True,
            "table_footnote_audit_passed": table_footnote.get("passed"),
            "table_footnote_audit_table_count": table_footnote_summary.get("table_count", 0),
            "table_footnote_audit_tables_with_notes": table_footnote_summary.get("tables_with_notes", 0),
            "table_footnote_audit_missing_notes": table_footnote_summary.get("missing_notes", 0),
            "table_footnote_audit_failed_issues": table_footnote_summary.get("failed_issues", 0),
            "table_footnote_audit_html_review": any(arcname == "review/table_footnote_audit.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "table_footnote_audit_included": False,
            "table_footnote_audit_passed": None,
            "table_footnote_audit_table_count": 0,
            "table_footnote_audit_tables_with_notes": 0,
            "table_footnote_audit_missing_notes": 0,
            "table_footnote_audit_failed_issues": 0,
            "table_footnote_audit_html_review": False,
        })
    if isinstance(llm_reliability, dict):
        llm_summary = llm_reliability.get("summary") or {}
        summary.update({
            "llm_reliability_audit_included": True,
            "llm_reliability_audit_passed": llm_reliability.get("passed"),
            "llm_reliability_total_events": llm_summary.get("total_events", 0),
            "llm_reliability_retryable_output_issues": llm_summary.get("retryable_output_issues", 0),
            "llm_reliability_near_truncation_events": llm_summary.get("near_truncation_events", 0),
            "llm_reliability_warning_issues": llm_summary.get("warning_issues", 0),
            "llm_reliability_failed_issues": llm_summary.get("failed_issues", 0),
            "llm_reliability_html_review": any(
                arcname == "review/llm_reliability_audit.html"
                for arcname, _ in generated_entries
            ),
        })
    else:
        summary.update({
            "llm_reliability_audit_included": False,
            "llm_reliability_audit_passed": None,
            "llm_reliability_total_events": 0,
            "llm_reliability_retryable_output_issues": 0,
            "llm_reliability_near_truncation_events": 0,
            "llm_reliability_warning_issues": 0,
            "llm_reliability_failed_issues": 0,
            "llm_reliability_html_review": False,
        })
    if isinstance(risk_of_bias_completeness, dict):
        rob_summary = risk_of_bias_completeness.get("summary") or {}
        summary.update({
            "risk_of_bias_completeness_included": True,
            "risk_of_bias_completeness_passed": risk_of_bias_completeness.get("passed"),
            "risk_of_bias_completeness_primary_studies": rob_summary.get("primary_contributing_studies", 0),
            "risk_of_bias_completeness_formal_rob": rob_summary.get("formal_rob", 0),
            "risk_of_bias_completeness_missing_formal_rob": rob_summary.get("missing_formal_rob", 0),
            "risk_of_bias_completeness_synthetic_rob": rob_summary.get("synthetic_rob", 0),
            "risk_of_bias_completeness_incomplete_rob": rob_summary.get("incomplete_rob", 0),
            "risk_of_bias_completeness_failed_issues": rob_summary.get("failed_issues", 0),
            "risk_of_bias_completeness_html_review": any(
                arcname == "review/risk_of_bias_completeness.html"
                for arcname, _ in generated_entries
            ),
        })
    else:
        summary.update({
            "risk_of_bias_completeness_included": False,
            "risk_of_bias_completeness_passed": None,
            "risk_of_bias_completeness_primary_studies": 0,
            "risk_of_bias_completeness_formal_rob": 0,
            "risk_of_bias_completeness_missing_formal_rob": 0,
            "risk_of_bias_completeness_synthetic_rob": 0,
            "risk_of_bias_completeness_incomplete_rob": 0,
            "risk_of_bias_completeness_failed_issues": 0,
            "risk_of_bias_completeness_html_review": False,
        })
    if isinstance(primary_result, dict):
        primary_summary = primary_result.get("summary") or {}
        summary.update({
            "primary_result_audit_included": True,
            "primary_result_audit_passed": primary_result.get("passed"),
            "primary_result_audit_expected_fields": primary_summary.get("expected_fields", 0),
            "primary_result_audit_matched_fields": primary_summary.get("matched_fields", 0),
            "primary_result_audit_mismatched_fields": primary_summary.get("mismatched_fields", 0),
            "primary_result_audit_failed_issues": primary_summary.get("failed_issues", 0),
            "primary_result_audit_effect_measure": primary_summary.get("effect_measure") or "",
            "primary_result_audit_html_review": any(arcname == "review/primary_result_audit.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "primary_result_audit_included": False,
            "primary_result_audit_passed": None,
            "primary_result_audit_expected_fields": 0,
            "primary_result_audit_matched_fields": 0,
            "primary_result_audit_mismatched_fields": 0,
            "primary_result_audit_failed_issues": 0,
            "primary_result_audit_effect_measure": "",
            "primary_result_audit_html_review": False,
        })
    if isinstance(claim_support, dict):
        claim_support_summary = claim_support.get("summary") or {}
        summary.update({
            "claim_support_audit_included": True,
            "claim_support_audit_passed": claim_support.get("passed"),
            "claim_support_checked_claims": claim_support_summary.get("checked_claims", 0),
            "claim_support_supported_claims": claim_support_summary.get("supported_claims", 0),
            "claim_support_unsupported_claims": claim_support_summary.get("unsupported_claims", 0),
            "claim_support_failed_issues": claim_support_summary.get("failed_issues", 0),
            "claim_support_html_review": any(arcname == "review/claim_support_audit.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "claim_support_audit_included": False,
            "claim_support_audit_passed": None,
            "claim_support_checked_claims": 0,
            "claim_support_supported_claims": 0,
            "claim_support_unsupported_claims": 0,
            "claim_support_failed_issues": 0,
            "claim_support_html_review": False,
        })
    if isinstance(primary_source_trace, dict):
        source_trace_summary = primary_source_trace.get("summary") or {}
        summary.update({
            "primary_source_trace_included": True,
            "primary_source_trace_passed": primary_source_trace.get("passed"),
            "primary_source_trace_rows": source_trace_summary.get("row_count", 0),
            "primary_source_trace_traceable_rows": source_trace_summary.get("source_traceable_rows", 0),
            "primary_source_trace_missing_source_quote_rows": source_trace_summary.get("missing_source_quote_rows", 0),
            "primary_source_trace_missing_source_location_rows": source_trace_summary.get("missing_source_location_rows", 0),
            "primary_source_trace_unverified_source_quote_rows": source_trace_summary.get("unverified_source_quote_rows", 0),
            "primary_source_trace_failed_issues": source_trace_summary.get("failed_issues", 0),
            "primary_source_trace_html_review": any(arcname == "review/primary_source_trace.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "primary_source_trace_included": False,
            "primary_source_trace_passed": None,
            "primary_source_trace_rows": 0,
            "primary_source_trace_traceable_rows": 0,
            "primary_source_trace_missing_source_quote_rows": 0,
            "primary_source_trace_missing_source_location_rows": 0,
            "primary_source_trace_unverified_source_quote_rows": 0,
            "primary_source_trace_failed_issues": 0,
            "primary_source_trace_html_review": False,
        })
    if isinstance(benchmark, dict):
        benchmark_summary = benchmark.get("summary") or {}
        benchmark_alignment = benchmark.get("benchmark_alignment") if isinstance(benchmark.get("benchmark_alignment"), dict) else {}
        benchmark_alignment_differences = (
            benchmark_alignment.get("differences")
            if isinstance(benchmark_alignment.get("differences"), dict)
            else {}
        )
        benchmark_applications_data = project.load_json("benchmark_source_applications.json", subdir="benchmark")
        benchmark_applications = len((benchmark_applications_data or {}).get("applications") or [])
        summary.update({
            "benchmark_included": True,
            "benchmark_id": benchmark.get("benchmark_id") or "",
            "benchmark_status": benchmark.get("status") or "",
            "benchmark_passed": benchmark.get("passed"),
            "benchmark_failing_gates": benchmark_summary.get("failing_gates", 0),
            "benchmark_missing_primary_full_texts": benchmark_summary.get("missing_primary_full_texts", 0),
            "benchmark_source_acquisition_tasks": benchmark_summary.get("source_acquisition_tasks", 0),
            "benchmark_protocol_adjudication_tasks": benchmark_summary.get("protocol_adjudication_tasks", 0),
            "benchmark_attached_source_tasks": benchmark_summary.get("attached_source_tasks", 0),
            "benchmark_accepted_source_candidates": benchmark_summary.get("accepted_source_candidates", 0),
            "benchmark_rejected_source_candidates": benchmark_summary.get("rejected_source_candidates", 0),
            "benchmark_source_applications": benchmark_applications,
            "benchmark_html_review": any(arcname == "review/benchmark_review.html" for arcname, _ in generated_entries),
            "benchmark_alignment_included": bool(benchmark_alignment),
            "benchmark_alignment_passed": benchmark_alignment.get("passed") if benchmark_alignment else None,
            "benchmark_alignment_effect_difference": benchmark_alignment_differences.get("effect"),
            "benchmark_alignment_model_compatibility_notes": len(benchmark_alignment.get("model_compatibility_notes") or []),
        })
    else:
        summary.update({
            "benchmark_included": False,
            "benchmark_status": "",
            "benchmark_failing_gates": 0,
            "benchmark_missing_primary_full_texts": 0,
            "benchmark_source_acquisition_tasks": 0,
            "benchmark_protocol_adjudication_tasks": 0,
            "benchmark_attached_source_tasks": 0,
            "benchmark_accepted_source_candidates": 0,
            "benchmark_rejected_source_candidates": 0,
            "benchmark_source_applications": 0,
            "benchmark_html_review": False,
            "benchmark_alignment_included": False,
            "benchmark_alignment_passed": None,
            "benchmark_alignment_effect_difference": None,
            "benchmark_alignment_model_compatibility_notes": 0,
        })
    if isinstance(calculation, dict):
        calculation_summary = calculation.get("summary") or {}
        summary.update({
            "calculation_audit_included": True,
            "calculation_audit_rows": calculation_summary.get("row_count", 0),
            "calculation_audit_source_rows_matched": calculation_summary.get("source_rows_matched", 0),
            "calculation_audit_effect_measure": calculation_summary.get("effect_measure") or "",
            "calculation_audit_html_review": any(arcname == "review/calculation_audit.html" for arcname, _ in generated_entries),
        })
    else:
        summary.update({
            "calculation_audit_included": False,
            "calculation_audit_rows": 0,
            "calculation_audit_source_rows_matched": 0,
            "calculation_audit_effect_measure": "",
            "calculation_audit_html_review": False,
        })
    return summary


def manuscript_citation_fix_manifest_summary(project: Project, generated_entries: list[tuple[str, Any]] | None = None) -> dict[str, Any]:
    generated_entries = generated_entries or []
    log = project.load_json("manuscript_citation_fixes.json", subdir="manuscript")
    if not isinstance(log, dict) or not log:
        return {
            "manuscript_citation_fixes_included": False,
            "manuscript_citation_fixes_html_review": False,
            "manuscript_citation_fixes_current_revision": 0,
            "manuscript_citation_fix_entries": 0,
            "manuscript_citation_patch_actions": 0,
            "manuscript_reference_add_actions": 0,
            "manuscript_reference_reuse_actions": 0,
            "manuscript_reference_add_human_review_required": 0,
            "manuscript_reference_fix_human_review_required": 0,
            "manuscript_citation_fix_quality_delta_entries": 0,
            "manuscript_citation_fix_quality_resolved_issues": 0,
            "manuscript_citation_fix_quality_reference_entries_added": 0,
            "manuscript_citation_fix_quality_primary_result_mismatches_resolved": 0,
            "manuscript_citation_fix_quality_primary_result_issues_resolved": 0,
            "manuscript_citation_fix_quality_claim_support_unsupported_claims_resolved": 0,
            "manuscript_citation_fix_quality_claim_support_issues_resolved": 0,
        }
    entries = [item for item in (log.get("entries") or []) if isinstance(item, dict)]
    citation_patch_actions = sum(1 for item in entries if str(item.get("action") or "") == "citation_patch")
    reference_add_entries = [item for item in entries if str(item.get("action") or "") == "add_reference"]
    reference_reuse_entries = [
        item for item in entries if str(item.get("action") or "") == "reuse_reference_citation"
    ]
    reference_add_human_review_required = _citation_fix_human_review_required(reference_add_entries)
    reference_fix_human_review_required = _citation_fix_human_review_required(
        reference_add_entries + reference_reuse_entries
    )
    quality_delta_summary = _citation_fix_quality_delta_summary(entries)
    return {
        "manuscript_citation_fixes_included": True,
        "manuscript_citation_fixes_html_review": any(arcname == "review/manuscript_citation_fixes.html" for arcname, _ in generated_entries),
        "manuscript_citation_fixes_current_revision": int(log.get("current_revision") or 0),
        "manuscript_citation_fix_entries": len(entries),
        "manuscript_citation_patch_actions": citation_patch_actions,
        "manuscript_reference_add_actions": len(reference_add_entries),
        "manuscript_reference_reuse_actions": len(reference_reuse_entries),
        "manuscript_reference_add_human_review_required": reference_add_human_review_required,
        "manuscript_reference_fix_human_review_required": reference_fix_human_review_required,
        "manuscript_citation_fix_quality_delta_entries": quality_delta_summary["quality_delta_entries"],
        "manuscript_citation_fix_quality_resolved_issues": quality_delta_summary["quality_resolved_issues"],
        "manuscript_citation_fix_quality_reference_entries_added": quality_delta_summary["quality_reference_entries_added"],
        "manuscript_citation_fix_quality_primary_result_mismatches_resolved": quality_delta_summary[
            "quality_primary_result_mismatches_resolved"
        ],
        "manuscript_citation_fix_quality_primary_result_issues_resolved": quality_delta_summary[
            "quality_primary_result_issues_resolved"
        ],
        "manuscript_citation_fix_quality_claim_support_unsupported_claims_resolved": quality_delta_summary[
            "quality_claim_support_unsupported_claims_resolved"
        ],
        "manuscript_citation_fix_quality_claim_support_issues_resolved": quality_delta_summary[
            "quality_claim_support_issues_resolved"
        ],
    }


def llm_usage_manifest_summary(project: Project) -> dict:
    usage = project.load_json("llm_usage_manifest.json")
    if not isinstance(usage, dict):
        return {
            "included": False,
            "total_calls": 0,
            "total_tokens": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "estimated_cost_usd": 0.0,
        }
    summary = usage.get("summary") or {}
    return {
        "included": True,
        "total_calls": summary.get("total_calls", 0),
        "total_tokens": summary.get("total_tokens", 0),
        "prompt_tokens": summary.get("prompt_tokens", 0),
        "completion_tokens": summary.get("completion_tokens", 0),
        "estimated_cost_usd": summary.get("estimated_cost_usd", 0.0),
        "cost_is_estimate": summary.get("cost_is_estimate", True),
    }
