"""Submission artifact packaging helpers."""
from __future__ import annotations

from html import escape
import json
import math
import re
import zipfile
from pathlib import Path
from typing import Any, Iterable

from new_meta.core.benchmark_review import build_benchmark_review_payload
from new_meta.core.document_export import export_manuscript_docx, export_manuscript_pdf
from new_meta.core.extraction_review import (
    build_extraction_source_cards,
    summarize_selected_primary_source_context,
    summarize_source_context_cards,
)
from new_meta.core.artifact_package_extraction_review import (
    _render_extraction_review_html,
    _rows_for_primary_count_verification,
    _rows_for_timepoint_adjudication,
)
from new_meta.core.artifact_package_entries import (
    PACKAGE_SUBDIR_FILES as SUBDIR_FILES,
    ROOT_PACKAGE_FILES as ROOT_FILES,
    entry_if_exists as _entry_if_exists,
    iter_existing_package_files as _iter_package_entries,
)
from new_meta.core.artifact_package_method_entries import iter_method_package_files
from new_meta.core.method_release import attach_method_release_gate, build_method_release_review
from new_meta.core.artifact_package_language import (
    html_lang as _html_lang,
    is_zh_review_language as _is_zh_review_language,
    normalize_review_language as _normalize_review_language,
)
from new_meta.core.artifact_package_citation_review import (
    render_citation_audit_html as _render_citation_audit_html,
    render_manuscript_citation_fix_html as _render_manuscript_citation_fix_html,
)
from new_meta.core.artifact_package_citation_audit import (
    build_citation_audit_review as _build_citation_audit_review,
    _citation_numbers_from_text,
    _paragraph_is_nonprose_block,
)
from new_meta.core.artifact_package_polish_review import (
    build_manuscript_polish_audit_review as _build_manuscript_polish_audit_review,
    manuscript_polish_manifest_summary as _manuscript_polish_manifest_summary,
    render_manuscript_polish_audit_html as _render_manuscript_polish_audit_html,
)
from new_meta.core.artifact_package_publication_similarity import (
    build_publication_similarity_review as _build_publication_similarity_review,
    render_publication_similarity_html as _render_publication_similarity_html,
)
from new_meta.core.artifact_package_source_review import (
    build_pdf_intake_review as _build_pdf_intake_review,
    build_text_source_coverage_review as _build_text_source_coverage_review,
    render_pdf_intake_review_html as _render_pdf_intake_review_html,
    render_text_source_coverage_review_html as _render_text_source_coverage_review_html,
)
from new_meta.core.artifact_package_submission import (
    build_submission_readiness_review as _build_submission_readiness_review_impl,
    render_submission_readiness_html as _render_submission_readiness_html,
)
from new_meta.core.artifact_package_diagnostics import (
    _attach_benchmark_alignment,
    _format_count_pair,
    _format_review_number,
    _render_benchmark_review_html,
    _render_calculation_audit_html,
    _render_llm_reliability_audit_html,
    _render_risk_of_bias_completeness_html,
)
from new_meta.core.artifact_package_manifest import (
    _ascii_numeric_citation_marker_number_count_outside_code,
    _citation_fix_human_review_required,
    _citation_fix_quality_delta_summary,
    _coerce_int,
    _count_bib_entries,
    _expected_manuscript_language,
    _has_calculation_detail,
    _has_publication_section_shape,
    _has_search_query_in_manuscript,
    _infer_project_review_language,
    _main_article_text_before_supplement,
    _main_manuscript_word_count,
    _main_text_before_reference_section,
    _numbered_heading_refs,
    _numbered_heading_pattern,
    _numbered_text_refs,
    _manuscript_content_summary,
    _markdown_first_section_text,
    _markdown_h2_sections,
    _markdown_section_text,
    _numbered_figure_count,
    _publication_min_main_words,
    _reference_entry_count,
    _reference_heading_match,
    _references_section_text,
    _requires_publication_length_gate,
    _requires_publication_reference_depth_gate,
    _review_language_from_text,
    _should_use_chinese_citation_style,
    _strip_markdown_code_fences,
    _text_unit_count,
    llm_usage_manifest_summary as _llm_usage_manifest_summary,
    manuscript_citation_fix_manifest_summary as _manuscript_citation_fix_manifest_summary,
    manuscript_manifest_summary as _manuscript_manifest_summary,
    review_manifest_summary as _review_manifest_summary,
    submission_manifest_summary as _submission_manifest_summary,
)
from new_meta.core.artifact_package_html import (
    _render_abstract_audit_html,
    _render_claim_support_audit_html,
    _render_clinical_interpretation_audit_html,
    _render_cross_reference_audit_html,
    _render_figure_audit_html,
    _render_figure_legend_audit_html,
    _render_prisma_audit_html,
    _render_primary_result_audit_html,
    _render_primary_source_trace_html,
    _render_publication_tone_audit_html,
    _render_readability_audit_html,
    _render_reference_audit_html,
    _render_search_strategy_audit_html,
    _render_table_footnote_audit_html,
)
from new_meta.core.manuscript_text_metrics import (
    main_publication_word_count,
    publication_min_main_words,
)
from new_meta.core.project import Project
from new_meta.core.release_contract import build_release_decision, persist_release_decision
from new_meta.core.reference_classification import (
    reference_entry_looks_like_numeric_effect_source as _shared_reference_entry_looks_like_numeric_effect_source,
    reference_entry_source_types,
)


CITATION_AUDIT_FORMAL_MIN_WORDS = 500
CITATION_AUDIT_MIN_REFERENCES = 12
CITATION_AUDIT_PUBLICATION_MIN_REFERENCES = 20
CITATION_AUDIT_MIN_UNIQUE_CITED_REFERENCES = 6
CITATION_AUDIT_MIN_DENSITY_PER_1000_WORDS = 6.0
CITATION_AUDIT_MIN_SUBSTANTIAL_PARAGRAPH_WORDS = 35
CITATION_AUDIT_MIN_INTERPRETIVE_SECTION_CITED_PARAGRAPH_RATE = 0.67
CITATION_AUDIT_MIN_SECTION_CONTEXT_CITATIONS = 2
CITATION_AUDIT_MAX_INLINE_CLUSTER_SIZE = 5
CITATION_AUDIT_MECHANICAL_DENSITY_SECTIONS = {"Discussion", "Conclusion"}
CITATION_AUDIT_MECHANICAL_DENSITY_MIN_MARKERS = 3
CITATION_AUDIT_MECHANICAL_DENSITY_MIN_TEXT_UNITS = 35
CITATION_AUDIT_MECHANICAL_DENSITY_MAX_MARKERS_PER_35_UNITS = 1.5
CITATION_AUDIT_REPEATED_CLUSTER_MIN_SIZE = 4
CITATION_AUDIT_REPEATED_CLUSTER_MIN_OCCURRENCES = 2
CITATION_AUDIT_BACKGROUND_SOURCE_TYPES = {
    "guide",
    "paper",
    "guideline",
    "clinical_guideline",
    "prior_review",
    "systematic_review",
    "pubmed_background",
}
CITATION_AUDIT_BACKGROUND_SOURCE_TYPES_BY_CLAIM = {
    "disease_burden": ["pubmed_background", "prior_review", "systematic_review"],
    "guideline_context": ["clinical_guideline", "guideline"],
    "prior_evidence": ["prior_review", "systematic_review", "pubmed_background"],
}
CITATION_AUDIT_METHODOLOGY_SOURCE_TYPES = {
    "reporting_guideline",
    "methods_handbook",
    "risk_of_bias_tool",
    "certainty_framework",
    "statistical_method",
    "publication_bias_method",
}
CITATION_AUDIT_DISCUSSION_METHODOLOGY_SOURCE_TYPES = {
    "certainty_framework",
    "publication_bias_method",
}
CITATION_AUDIT_NUMERIC_EFFECT_SOURCE_TYPES = {
    "included_trial",
    "trial_report",
    "registry_results",
    "clinical_trial",
}
CITATION_AUDIT_SECTION_HEADINGS = {
    "Introduction": ["Introduction", "Intro", "Background", "引言", "绪论", "前言", "背景"],
    "Methods": ["Methods", "Method", "Materials and Methods", "方法", "材料与方法", "研究方法"],
    "Results": ["Results", "Findings", "结果", "研究结果"],
    "Discussion": ["Discussion", "讨论"],
    "Conclusion": ["Conclusion", "Conclusions", "结论", "结语"],
}
SGLT2_TEXT_PATTERN = (
    r"\b(?:sglt2|sglt-2|gliflozin|empagliflozin|dapagliflozin|canagliflozin|"
    r"ertugliflozin|sotagliflozin)\b|"
    r"\bsodium[- ]glucose\s+(?:co-?transporter|cotransporter)[- ]?2\b|"
    r"\bsodium[- ]glucose\s+(?:co-?transporter|cotransporter)[- ]two\b"
)


def create_artifact_package(project: Project, package_name: str = "metaagent_export.zip") -> Path:
    """Create a compact handoff zip with manuscript, figures, and audit trail."""
    package_dir = project.base_dir / "package"
    package_dir.mkdir(exist_ok=True)
    package_path = package_dir / package_name

    export_manuscript_docx(project)
    export_manuscript_pdf(project)
    entries = list(_iter_package_entries(project))
    existing_arcnames = {arcname for _, arcname in entries}
    entries.extend(
        (path, arcname)
        for path, arcname in iter_method_package_files(project)
        if arcname not in existing_arcnames
    )
    generated_entries = _generated_review_entries(project)
    submission_readiness = next(
        (
            payload
            for arcname, payload in generated_entries
            if arcname == "review/submission_readiness_review.json" and isinstance(payload, dict)
        ),
        None,
    )
    release_decision = build_release_decision(
        submission_readiness,
        package_path=package_path,
    )
    generated_entries.append(("review/release_decision.json", release_decision))
    manifest_entries = [arcname for _, arcname in entries] + [arcname for arcname, _ in generated_entries]
    manifest_entries.append("package_manifest.json")
    manifest = {
        "package_name": package_name,
        "entries": manifest_entries,
        "entry_count": len(manifest_entries),
        "manuscript": _manuscript_manifest_summary(project),
        "submission": _submission_manifest_summary(generated_entries),
        "release": release_decision,
        "review": _review_manifest_summary(project, generated_entries),
        "llm_usage": _llm_usage_manifest_summary(project),
    }

    with zipfile.ZipFile(package_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path, arcname in entries:
            zf.write(path, arcname)
        for arcname, payload in generated_entries:
            if isinstance(payload, str):
                zf.writestr(arcname, payload)
            else:
                zf.writestr(arcname, json.dumps(payload, indent=2, ensure_ascii=False))
        zf.writestr("package_manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))

    if submission_readiness:
        project.save_json(
            "submission_readiness_review.json",
            submission_readiness,
            subdir="package",
        )
    persist_release_decision(project, release_decision)
    project.save_json("package_manifest.json", manifest, subdir="package")

    return package_path


def _generated_review_entries(project: Project) -> list[tuple[str, Any]]:
    entries: list[tuple[str, Any]] = []
    review_language = _infer_project_review_language(project)
    pdf_intake_review = _build_pdf_intake_review(project, language=review_language)
    if pdf_intake_review:
        entries.extend([
            ("review/pdf_intake_review.json", pdf_intake_review),
            ("review/pdf_intake_review.html", _render_pdf_intake_review_html(pdf_intake_review)),
        ])
    text_source_coverage = _build_text_source_coverage_review(project, language=review_language)
    if text_source_coverage:
        entries.extend([
            ("review/text_source_coverage_audit.json", text_source_coverage),
            ("review/text_source_coverage_audit.html", _render_text_source_coverage_review_html(text_source_coverage)),
        ])
    review = _build_evidence_readiness_review(project)
    if review:
        entries.extend([
            ("review/evidence_readiness_review.json", review),
            ("review/extraction_review.html", _render_extraction_review_html(review)),
        ])
    abstract_audit = _build_abstract_audit_review(project)
    if abstract_audit:
        entries.extend([
            ("review/abstract_audit.json", abstract_audit),
            ("review/abstract_audit.html", _render_abstract_audit_html(abstract_audit)),
        ])
    publication_tone_audit = _build_publication_tone_audit_review(project)
    if publication_tone_audit:
        entries.extend([
            ("review/publication_tone_audit.json", publication_tone_audit),
            ("review/publication_tone_audit.html", _render_publication_tone_audit_html(publication_tone_audit)),
        ])
    readability_audit = _build_readability_audit_review(project)
    if readability_audit:
        entries.extend([
            ("review/readability_audit.json", readability_audit),
            ("review/readability_audit.html", _render_readability_audit_html(readability_audit)),
        ])
    clinical_interpretation_audit = _build_clinical_interpretation_audit_review(project)
    if clinical_interpretation_audit:
        entries.extend([
            ("review/clinical_interpretation_audit.json", clinical_interpretation_audit),
            (
                "review/clinical_interpretation_audit.html",
                _render_clinical_interpretation_audit_html(clinical_interpretation_audit),
            ),
        ])
    reference_audit = _build_reference_audit_review(project)
    if reference_audit:
        entries.extend([
            ("review/reference_audit.json", reference_audit),
            ("review/reference_audit.html", _render_reference_audit_html(reference_audit)),
        ])
    citation_audit = _build_citation_audit_review(project)
    if citation_audit:
        entries.extend([
            ("review/citation_audit.json", citation_audit),
            ("review/citation_audit.html", _render_citation_audit_html(citation_audit)),
        ])
    citation_fix_review = _build_manuscript_citation_fix_review(project)
    if citation_fix_review:
        entries.extend([
            ("review/manuscript_citation_fixes.json", citation_fix_review),
            ("review/manuscript_citation_fixes.html", _render_manuscript_citation_fix_html(citation_fix_review)),
        ])
    manuscript_polish_audit = _build_manuscript_polish_audit_review(project)
    if manuscript_polish_audit:
        entries.extend([
            ("review/manuscript_polish_audit.json", manuscript_polish_audit),
            ("review/manuscript_polish_audit.html", _render_manuscript_polish_audit_html(manuscript_polish_audit)),
        ])
    prisma_audit = _build_prisma_audit_review(project)
    if prisma_audit:
        entries.extend([
            ("review/prisma_audit.json", prisma_audit),
            ("review/prisma_audit.html", _render_prisma_audit_html(prisma_audit)),
        ])
    search_strategy_audit = _build_search_strategy_audit_review(project)
    if search_strategy_audit:
        entries.extend([
            ("review/search_strategy_audit.json", search_strategy_audit),
            ("review/search_strategy_audit.html", _render_search_strategy_audit_html(search_strategy_audit)),
        ])
    figure_audit = _build_figure_audit_review(project)
    if figure_audit:
        entries.extend([
            ("review/figure_audit.json", figure_audit),
            ("review/figure_audit.html", _render_figure_audit_html(figure_audit)),
        ])
    figure_legend_audit = _build_figure_legend_audit_review(project)
    if figure_legend_audit:
        entries.extend([
            ("review/figure_legend_audit.json", figure_legend_audit),
            ("review/figure_legend_audit.html", _render_figure_legend_audit_html(figure_legend_audit)),
        ])
    cross_reference_audit = _build_cross_reference_audit_review(project)
    if cross_reference_audit:
        entries.extend([
            ("review/cross_reference_audit.json", cross_reference_audit),
            ("review/cross_reference_audit.html", _render_cross_reference_audit_html(cross_reference_audit)),
        ])
    table_footnote_audit = _build_table_footnote_audit_review(project)
    if table_footnote_audit:
        entries.extend([
            ("review/table_footnote_audit.json", table_footnote_audit),
            ("review/table_footnote_audit.html", _render_table_footnote_audit_html(table_footnote_audit)),
        ])
    llm_reliability_audit = _build_llm_reliability_audit_review(project)
    if llm_reliability_audit:
        entries.extend([
            ("review/llm_reliability_audit.json", llm_reliability_audit),
            ("review/llm_reliability_audit.html", _render_llm_reliability_audit_html(llm_reliability_audit)),
        ])
    risk_of_bias_completeness = _build_risk_of_bias_completeness_review(project)
    if risk_of_bias_completeness:
        entries.extend([
            ("review/risk_of_bias_completeness.json", risk_of_bias_completeness),
            ("review/risk_of_bias_completeness.html", _render_risk_of_bias_completeness_html(risk_of_bias_completeness)),
        ])
    calculation_audit = _build_calculation_audit_review(project)
    if calculation_audit:
        entries.extend([
            ("review/calculation_audit.json", calculation_audit),
            ("review/calculation_audit.html", _render_calculation_audit_html(calculation_audit)),
        ])
    trace_facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    trace_language = _expected_manuscript_language(project, trace_facts if isinstance(trace_facts, dict) else {})
    primary_source_trace = _build_primary_source_trace_review(calculation_audit, language=trace_language)
    if primary_source_trace:
        entries.extend([
            ("review/primary_source_trace.json", primary_source_trace),
            ("review/primary_source_trace.html", _render_primary_source_trace_html(primary_source_trace)),
        ])
    primary_result_audit = _build_primary_result_audit_review(project, calculation_audit)
    if primary_result_audit:
        entries.extend([
            ("review/primary_result_audit.json", primary_result_audit),
            ("review/primary_result_audit.html", _render_primary_result_audit_html(primary_result_audit)),
        ])
    claim_support_audit = _build_claim_support_audit_review(project)
    if claim_support_audit:
        entries.extend([
            ("review/claim_support_audit.json", claim_support_audit),
            ("review/claim_support_audit.html", _render_claim_support_audit_html(claim_support_audit)),
        ])
    benchmark_review = _build_benchmark_review(project)
    if benchmark_review:
        benchmark_review = _attach_benchmark_alignment(benchmark_review, calculation_audit)
        entries.extend([
            ("review/benchmark_review.json", benchmark_review),
            ("review/benchmark_review.html", _render_benchmark_review_html(benchmark_review)),
        ])
    publication_similarity = _build_publication_similarity_review(
        project,
        abstract_audit=abstract_audit,
        publication_tone_audit=publication_tone_audit,
        readability_audit=readability_audit,
        clinical_interpretation_audit=clinical_interpretation_audit,
        citation_audit=citation_audit,
        prisma_audit=prisma_audit,
        figure_audit=figure_audit,
        figure_legend_audit=figure_legend_audit,
        cross_reference_audit=cross_reference_audit,
        table_footnote_audit=table_footnote_audit,
        calculation_audit=calculation_audit,
        primary_source_trace=primary_source_trace,
        benchmark_review=benchmark_review,
        search_strategy_audit=search_strategy_audit,
    )
    if publication_similarity:
        entries.extend([
            ("review/publication_similarity_review.json", publication_similarity),
            ("review/publication_similarity_review.html", _render_publication_similarity_html(publication_similarity)),
        ])
    method_release_review = build_method_release_review(project)
    if method_release_review:
        entries.append(("review/method_release_review.json", method_release_review))
    submission_readiness = _build_submission_readiness_review(
        project,
        pdf_intake_review=pdf_intake_review,
        text_source_coverage=text_source_coverage,
        evidence_review=review,
        abstract_audit=abstract_audit,
        publication_tone_audit=publication_tone_audit,
        readability_audit=readability_audit,
        clinical_interpretation_audit=clinical_interpretation_audit,
        reference_audit=reference_audit,
        citation_audit=citation_audit,
        prisma_audit=prisma_audit,
        search_strategy_audit=search_strategy_audit,
        figure_audit=figure_audit,
        figure_legend_audit=figure_legend_audit,
        cross_reference_audit=cross_reference_audit,
        table_footnote_audit=table_footnote_audit,
        llm_reliability_audit=llm_reliability_audit,
        risk_of_bias_completeness=risk_of_bias_completeness,
        calculation_audit=calculation_audit,
        primary_source_trace=primary_source_trace,
        primary_result_audit=primary_result_audit,
        claim_support_audit=claim_support_audit,
        benchmark_review=benchmark_review,
        publication_similarity=publication_similarity,
    )
    submission_readiness = attach_method_release_gate(
        submission_readiness,
        method_release_review,
    )
    if submission_readiness:
        entries.extend([
            ("review/submission_readiness_review.json", submission_readiness),
            ("review/submission_readiness_review.html", _render_submission_readiness_html(submission_readiness)),
        ])
    return entries


def _build_evidence_readiness_review(project: Project) -> dict | None:
    facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    if not isinstance(facts, dict):
        return None
    readiness = facts.get("evidence_readiness") or {}
    if not readiness:
        return None
    draft_path = project.base_dir / "manuscript" / "draft.md"
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace") if draft_path.exists() else ""
    language = _expected_manuscript_language(project, facts) or _review_language_from_text(draft_text)
    timepoint_rows = _rows_for_timepoint_adjudication(readiness)
    count_rows = _rows_for_primary_count_verification(readiness)
    extraction_source_cards = build_extraction_source_cards(project)
    selected_rows = readiness.get("selected_primary_rows") or []
    if facts.get("method_family") and selected_rows:
        # Compiled methods use result-entity row ids, while the legacy
        # extraction audit may use outcome-index ids.  Merge source cards built
        # from the exact rows that entered synthesis so the review audits the
        # same evidence units as the method ledger.
        method_cards = build_extraction_source_cards(project, rows=selected_rows)
        cards_by_row = {
            str(card.get("row_id") or ""): card
            for card in extraction_source_cards
            if isinstance(card, dict) and card.get("row_id")
        }
        for card in method_cards:
            if isinstance(card, dict) and card.get("row_id"):
                cards_by_row[str(card.get("row_id"))] = card
        extraction_source_cards = list(cards_by_row.values())
    source_context_summary = summarize_source_context_cards(extraction_source_cards)
    selected_primary_source_context = summarize_selected_primary_source_context(
        extraction_source_cards,
        readiness.get("selected_primary_rows") or [],
    )
    grade_review = _build_grade_review(facts)
    blockers = readiness.get("blockers") or []
    warnings = readiness.get("warnings") or []
    return {
        "language": language,
        "report_type": facts.get("report_type"),
        "status": readiness.get("status"),
        "blocker_codes": readiness.get("blocker_codes") or [],
        "summary": {
            "blockers": len(blockers),
            "warnings": len(warnings),
            "timepoint_adjudication_rows": len(timepoint_rows),
            "primary_count_verification_rows": len(count_rows),
            "selected_primary_rows": len(readiness.get("selected_primary_rows") or []),
            "extraction_source_cards": len(extraction_source_cards),
            "extraction_review_cards": sum(1 for card in extraction_source_cards if card.get("requires_review")),
            "source_context_available_cards": source_context_summary["source_context_available_cards"],
            "source_context_missing_cards": source_context_summary["source_context_missing_cards"],
            "source_context_coverage": source_context_summary["source_context_coverage"],
            "source_context_missing_review_cards": source_context_summary["source_context_missing_review_cards"],
            "selected_primary_source_cards": selected_primary_source_context["selected_primary_source_cards"],
            "selected_primary_source_context_available_cards": selected_primary_source_context["selected_primary_source_context_available_cards"],
            "selected_primary_source_context_missing_cards": selected_primary_source_context["selected_primary_source_context_missing_cards"],
            "selected_primary_source_context_coverage": selected_primary_source_context["selected_primary_source_context_coverage"],
            "grade_review_outcomes": (grade_review.get("summary") or {}).get("outcomes", 0),
            "grade_review_domains": (grade_review.get("summary") or {}).get("domains", 0),
            "grade_review_domains_with_details": (grade_review.get("summary") or {}).get("domains_with_details", 0),
        },
        "blockers": blockers,
        "warnings": warnings,
        "selected_primary_rows": readiness.get("selected_primary_rows") or [],
        "timepoint_adjudication_rows": timepoint_rows,
        "primary_count_verification_rows": count_rows,
        "extraction_source_cards": extraction_source_cards,
        "missing_source_context_cards": source_context_summary["missing_source_context_cards"],
        "missing_selected_primary_source_context_cards": selected_primary_source_context["missing_selected_primary_source_context_cards"],
        "selected_primary_source_context": selected_primary_source_context,
        "grade_review": grade_review,
        "extraction_audit_summary": readiness.get("extraction_audit_summary") or {},
    }


def _build_grade_review(facts: dict[str, Any]) -> dict[str, Any]:
    grade = facts.get("grade") or {}
    raw_outcomes = grade.get("outcomes") or []
    outcomes: list[dict[str, Any]] = []
    domain_count = 0
    detailed_count = 0

    for raw_outcome in raw_outcomes:
        if not isinstance(raw_outcome, dict):
            continue
        domains: list[dict[str, Any]] = []
        for raw_domain in raw_outcome.get("domains") or []:
            if not isinstance(raw_domain, dict):
                continue
            details = raw_domain.get("details") if isinstance(raw_domain.get("details"), dict) else {}
            if details:
                detailed_count += 1
            domains.append({
                "domain": raw_domain.get("domain") or "",
                "rating": raw_domain.get("rating") or "",
                "rationale": raw_domain.get("rationale") or "",
                "details": details,
            })
        if not domains:
            continue
        domain_count += len(domains)
        outcomes.append({
            "outcome_name": raw_outcome.get("outcome_name") or "",
            "n_studies": raw_outcome.get("n_studies"),
            "effect_summary": raw_outcome.get("effect_summary") or "",
            "certainty": raw_outcome.get("certainty") or "",
            "domains": domains,
        })

    if not outcomes:
        return {"summary": {"outcomes": 0, "domains": 0, "domains_with_details": 0}, "outcomes": []}
    return {
        "summary": {
            "outcomes": len(outcomes),
            "domains": domain_count,
            "domains_with_details": detailed_count,
        },
        "outcomes": outcomes,
    }


def _build_risk_of_bias_completeness_review(project: Project) -> dict | None:
    """Verify every primary meta-analysis contributor has a formal RoB assessment."""
    meta_results = project.load_json("meta_results.json", subdir="analysis")
    if not isinstance(meta_results, dict):
        return None
    primary = meta_results.get("primary_outcome")
    if not isinstance(primary, dict):
        return None
    primary_studies = primary.get("studies") or []
    if not isinstance(primary_studies, list) or not primary_studies:
        return None

    result_rob_path = project.get_path("rob_result_assessments.json", subdir="risk_of_bias")
    if result_rob_path.exists():
        return _build_result_level_risk_of_bias_completeness_review(
            project,
            primary=primary,
            primary_studies=primary_studies,
        )

    rob_results = project.load_json("rob_results.json", subdir="risk_of_bias")
    rob_results = rob_results if isinstance(rob_results, list) else []
    alias_sets = _risk_of_bias_alias_sets(project)
    rob_records = []
    for raw_rob in rob_results:
        if not isinstance(raw_rob, dict):
            continue
        rob_id = _normalize_study_key(raw_rob.get("study_id"))
        if not rob_id:
            continue
        rob_records.append({
            "raw": raw_rob,
            "aliases": _expanded_risk_of_bias_aliases(rob_id, alias_sets),
        })

    rows: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    for raw_study in primary_studies:
        if not isinstance(raw_study, dict):
            continue
        study_id = str(raw_study.get("study_id") or "").strip()
        if not study_id:
            continue
        label = str(raw_study.get("study_label") or study_id).strip()
        aliases = _expanded_risk_of_bias_aliases(_normalize_study_key(study_id), alias_sets)
        matching = [record["raw"] for record in rob_records if record["aliases"] & aliases]

        if not matching:
            row = {
                "study_id": study_id,
                "study_label": label,
                "status": "missing",
                "formal": False,
                "tool_used": "",
                "overall_judgment": "",
                "domain_count": 0,
                "issue_code": "primary_study_missing_formal_rob",
            }
            issues.append({
                "code": "primary_study_missing_formal_rob",
                "severity": "fail",
                "study_id": study_id,
                "study_label": label,
                "message": "Primary-analysis contributing study lacks a formal risk-of-bias assessment.",
            })
            rows.append(row)
            continue

        selected = _best_risk_of_bias_record(matching)
        status = _risk_of_bias_record_status(selected)
        formal = status == "formal"
        row = {
            "study_id": study_id,
            "study_label": label,
            "matched_rob_study_id": selected.get("study_id") or "",
            "status": status,
            "formal": formal,
            "tool_used": selected.get("tool_used") or "",
            "overall_judgment": selected.get("overall_judgment") or "",
            "domain_count": len(selected.get("domains") or []),
            "issue_code": "" if formal else f"primary_study_{status}_rob",
        }
        if not formal:
            issues.append({
                "code": row["issue_code"],
                "severity": "fail",
                "study_id": study_id,
                "study_label": label,
                "message": _risk_of_bias_status_message(status),
            })
        rows.append(row)

    summary = {
        "primary_outcome": primary.get("outcome_name") or "",
        "primary_contributing_studies": len(rows),
        "formal_rob": sum(1 for row in rows if row.get("status") == "formal"),
        "missing_formal_rob": sum(1 for row in rows if row.get("status") == "missing"),
        "synthetic_rob": sum(1 for row in rows if row.get("status") == "synthetic"),
        "incomplete_rob": sum(1 for row in rows if row.get("status") == "incomplete"),
        "failed_issues": sum(1 for issue in issues if issue.get("severity") == "fail"),
    }
    return {
        "schema_version": 1,
        "status": "ready" if summary["failed_issues"] == 0 else "blocked",
        "passed": summary["failed_issues"] == 0,
        "summary": summary,
        "studies": rows,
        "issues": issues,
    }


def _build_result_level_risk_of_bias_completeness_review(
    project: Project,
    *,
    primary: dict[str, Any],
    primary_studies: list[dict[str, Any]],
) -> dict[str, Any]:
    """Require a completed assessment for each exact result entering pooling."""
    assessments = project.load_json("rob_result_assessments.json", subdir="risk_of_bias") or []
    assessments_by_result = {
        str(item.get("result_id") or ""): item
        for item in assessments
        if isinstance(item, dict) and item.get("result_id")
    }
    selection_rows = project.load_json("effect_selection_audit.json", subdir="analysis") or []
    selected_rows = [
        row for row in selection_rows
        if isinstance(row, dict) and row.get("in_final_primary_analysis") is True
    ]
    alias_sets = _risk_of_bias_alias_sets(project)
    rows: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []

    for raw_study in primary_studies:
        if not isinstance(raw_study, dict):
            continue
        study_id = str(raw_study.get("study_id") or "").strip()
        if not study_id:
            continue
        label = str(raw_study.get("study_label") or study_id).strip()
        aliases = _expanded_risk_of_bias_aliases(_normalize_study_key(study_id), alias_sets)
        selected = next(
            (
                row for row in selected_rows
                if _normalize_study_key(row.get("study_id")) in aliases
            ),
            None,
        )
        result_id = str((selected or {}).get("result_id") or "")
        assessment = assessments_by_result.get(result_id)
        status = _result_risk_of_bias_record_status(assessment)
        formal = status == "formal"
        issue_code = "" if formal else {
            "missing": "primary_result_missing_formal_rob",
            "pending": "primary_result_rob_pending_adjudication",
            "synthetic": "primary_result_synthetic_rob",
            "incomplete": "primary_result_incomplete_rob",
        }.get(status, "primary_result_incomplete_rob")
        row = {
            "study_id": study_id,
            "study_label": label,
            "result_id": result_id,
            "row_id": str((selected or {}).get("row_id") or ""),
            "outcome_name": str((selected or {}).get("outcome_name") or primary.get("outcome_name") or ""),
            "status": status,
            "formal": formal,
            "tool_used": str((assessment or {}).get("tool_used") or ""),
            "tool_version": str((assessment or {}).get("tool_version") or ""),
            "overall_judgment": str((assessment or {}).get("overall_judgment") or ""),
            "domain_count": len((assessment or {}).get("domains") or []),
            "assessment_status": str((assessment or {}).get("assessment_status") or ""),
            "issue_code": issue_code,
        }
        if not formal:
            issues.append({
                "code": issue_code,
                "severity": "fail",
                "study_id": study_id,
                "result_id": result_id,
                "study_label": label,
                "message": _result_risk_of_bias_status_message(status),
            })
        rows.append(row)

    formal_count = sum(1 for row in rows if row.get("status") == "formal")
    pending_count = sum(1 for row in rows if row.get("status") == "pending")
    summary = {
        "scope": "result",
        "primary_outcome": primary.get("outcome_name") or "",
        "primary_contributing_studies": len(rows),
        "primary_contributing_results": len(rows),
        "formal_rob": formal_count,
        "result_specific_rob": formal_count,
        "legacy_study_level_rob": 0,
        "pending_result_rob": pending_count,
        "missing_formal_rob": sum(1 for row in rows if row.get("status") == "missing"),
        "synthetic_rob": sum(1 for row in rows if row.get("status") == "synthetic"),
        "incomplete_rob": sum(1 for row in rows if row.get("status") in {"incomplete", "pending"}),
        "failed_issues": len(issues),
    }
    return {
        "schema_version": 2,
        "status": "ready" if not issues and bool(rows) else "blocked",
        "passed": not issues and bool(rows),
        "summary": summary,
        "studies": rows,
        "results": rows,
        "issues": issues,
    }


def _result_risk_of_bias_record_status(record: dict[str, Any] | None) -> str:
    if not isinstance(record, dict):
        return "missing"
    if _risk_of_bias_record_is_synthetic(record):
        return "synthetic"
    status = str(record.get("assessment_status") or "").strip().lower()
    if bool(record.get("requires_adjudication")) or status == "draft":
        return "pending"
    if status not in {"complete", "adjudicated"}:
        return "incomplete"
    if _risk_of_bias_record_status(record) != "formal":
        return "incomplete"
    for domain in record.get("domains") or []:
        if not str(domain.get("source_quote") or "").strip():
            return "incomplete"
        if domain.get("source_page") is None and not str(domain.get("source_section") or "").strip():
            return "incomplete"
    return "formal"


def _result_risk_of_bias_status_message(status: str) -> str:
    if status == "pending":
        return "Primary-analysis result has only a draft RoB assessment pending result-level adjudication."
    if status == "synthetic":
        return "Primary-analysis result has only a synthetic or insufficient-information RoB assessment."
    if status == "incomplete":
        return "Primary-analysis result RoB assessment lacks complete domains or source evidence."
    return "Primary-analysis result lacks a matching formal result-level risk-of-bias assessment."


def _risk_of_bias_alias_sets(project: Project) -> list[set[str]]:
    extractions = project.load_json("all_extractions.json", subdir="extraction")
    if not isinstance(extractions, list):
        return []
    alias_sets: list[set[str]] = []
    for study in extractions:
        if not isinstance(study, dict):
            continue
        characteristics = study.get("characteristics") or {}
        if not isinstance(characteristics, dict):
            continue
        aliases = {
            _normalize_study_key(characteristics.get("study_id")),
            _normalize_study_key(characteristics.get("pmid")),
            _normalize_study_key(characteristics.get("doi")),
        }
        aliases = {alias for alias in aliases if alias}
        if aliases:
            alias_sets.append(aliases)
    return alias_sets


def _expanded_risk_of_bias_aliases(study_id: str, alias_sets: list[set[str]]) -> set[str]:
    aliases = {_normalize_study_key(study_id)} if _normalize_study_key(study_id) else set()
    changed = True
    while changed:
        changed = False
        for alias_set in alias_sets:
            if aliases & alias_set and not alias_set <= aliases:
                aliases |= alias_set
                changed = True
    return aliases


def _best_risk_of_bias_record(records: list[dict[str, Any]]) -> dict[str, Any]:
    return sorted(records, key=_risk_of_bias_record_score, reverse=True)[0]


def _risk_of_bias_record_score(record: dict[str, Any]) -> int:
    status = _risk_of_bias_record_status(record)
    status_score = {"formal": 3, "incomplete": 2, "synthetic": 1}.get(status, 0)
    return status_score * 100 + len(record.get("domains") or [])


def _risk_of_bias_record_status(record: dict[str, Any]) -> str:
    if _risk_of_bias_record_is_synthetic(record):
        return "synthetic"
    domains = record.get("domains") or []
    if not isinstance(domains, list):
        return "incomplete"
    expected_domains = _expected_risk_of_bias_domain_count(record.get("tool_used") or "")
    if len(domains) < expected_domains:
        return "incomplete"
    for domain in domains:
        if not isinstance(domain, dict):
            return "incomplete"
        if not str(domain.get("judgment") or "").strip():
            return "incomplete"
        if not str(domain.get("support") or "").strip():
            return "incomplete"
    return "formal"


def _risk_of_bias_record_is_synthetic(record: dict[str, Any]) -> bool:
    judgment = str(record.get("overall_judgment") or "").lower()
    return (
        bool(record.get("is_synthetic"))
        or "not assessed" in judgment
        or "insufficient information" in judgment
    )


def _expected_risk_of_bias_domain_count(tool_used: str) -> int:
    tool = (tool_used or "").lower()
    if "rob 2" in tool or "risk of bias 2" in tool:
        return 5
    if "newcastle" in tool or "nos" in tool:
        return 3
    return 1


def _risk_of_bias_status_message(status: str) -> str:
    if status == "synthetic":
        return "Primary-analysis contributing study has only a synthetic or not-assessed RoB entry."
    if status == "incomplete":
        return "Primary-analysis contributing study RoB entry is incomplete or lacks domain support."
    return "Primary-analysis contributing study lacks a formal risk-of-bias assessment."


def _normalize_study_key(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    text = re.sub(r"^https?://(dx\.)?doi\.org/", "", text)
    text = re.sub(r"\s+", " ", text)
    return text


_ABSTRACT_REQUIRED_LABELS = [
    "Importance",
    "Objective",
    "Data sources",
    "Study selection",
    "Data extraction and synthesis",
    "Main outcome and measures",
    "Results",
    "Conclusions and relevance",
]

_ABSTRACT_REQUIRED_LABELS_ZH = [
    "重要性",
    "目的",
    "资料来源",
    "研究选择",
    "数据提取与合成",
    "主要结局和指标",
    "结果",
    "结论和意义",
]

_ABSTRACT_FORBIDDEN_PATTERNS = [
    (r"\bsupplementary source context\b", "Supplementary source context"),
    (r"\bevidence[- ]readiness\b", "Evidence-readiness status"),
    (r"\babstract[- ]only\b", "Abstract-only source status"),
    (r"\bmetadata[- ]only\b", "Metadata-only source status"),
    (r"\bpipeline\b", "Pipeline wording"),
    (r"\bmanuscript_validation\b", "Validation-file wording"),
    (r"\bartifact package\b", "Artifact-package wording"),
]


_PUBLICATION_TONE_FORBIDDEN_PATTERNS = [
    (r"\bevidence[- ]readiness\b", "Evidence-readiness status"),
    (r"\baudit trail\b", "Audit-trail wording"),
    (r"\bstructured data files?\b", "Structured-data-file wording"),
    (r"\binternal\s+(?:literature\s+)?database\b", "Internal database source label"),
    (r"\binternally consistent\b", "Internal-consistency self-description"),
    (r"\bautomated systematic-review pipeline\b", "Automated-pipeline wording"),
    (r"\bgenerated manuscript\b", "Generated-manuscript wording"),
    (r"\bhard validation\b", "Hard-validation wording"),
    (r"\bsource of truth\b", "Source-of-truth wording"),
    (r"\bfact[- ]locked\b", "Fact-locked wording"),
    (r"\breview UI\b", "Review-UI wording"),
    (r"\bretrieval warnings?\b", "Retrieval-warning wording"),
    (r"\bextraction record\b", "Extraction-record wording"),
    (r"\bcandidate primary row\b", "Candidate-row wording"),
    (r"\bPDF parser\b", "PDF-parser wording"),
    (r"\bsource checking\b", "Source-checking wording"),
    (r"\bdocumentation status\b", "Documentation-status wording"),
    (r"\beffect-size layers?\b", "Effect-size-layer wording"),
    (r"\bthe manuscript therefore\b|\bsafer for a manuscript\b|\bmanuscript tables\b", "Manuscript-self-reference wording"),
    (r"\bdebug(?:ging)?\b", "Debug wording"),
    (r"\bfirst[- ]pass manuscript\b", "First-pass wording"),
    (r"事实锁定(?:写作|稿件|文本)?", "Chinese fact-locked wording"),
    (r"内部文献库", "Chinese internal database source label"),
    (r"结构化数据文件|结构化分析数据", "Chinese structured-data-file wording"),
    (r"同一套事实|事实表", "Chinese single-source-of-truth wording"),
    (r"可审计性|可审计|审计意见|审稿意见能定位至具体数据行", "Chinese auditability wording"),
    (r"来源附录|来源审计|来源摘录", "Chinese source-audit wording"),
    (r"具体数据行|选定主要行", "Chinese data-row wording"),
    (
        r"来源核验字段|结构化证据表|结构化覆盖文件|提取复核界面|"
        r"写作模块|只改正文|数据重新生成|重新生成效应量和稿件|"
        r"全文都应随数据重新生成|逐节生成|参考对照报告",
        "Chinese workflow wording",
    ),
    (r"可核查性|证据链|人工修正", "Chinese internal review wording"),
]

_READABILITY_VERBOSE_PICO_PATTERNS = [
    (r"\bat any approved dose\b", "Detailed intervention dose phrase"),
    (r"\bstandard background (?:heart failure )?therapy\b", "Detailed background-therapy phrase"),
    (r"\bconfirmed by echocardiography\b", "Detailed diagnostic-confirmation phrase"),
    (r"\bradionuclide ventriculography\b", "Detailed diagnostic-modality phrase"),
    (r"\bHFA-PEFF\b", "Detailed diagnostic-score phrase"),
    (r"\bH2FPEF\b", "Detailed diagnostic-score phrase"),
    (r"\bPlacebo, no pharmacological treatment, sham intervention\b", "Detailed comparator phrase"),
    (r"\bincluding background therapy with beta-blockers\b", "Detailed comparator-background phrase"),
    (r"任何获批剂量", "Detailed Chinese intervention dose phrase"),
    (r"(?:标准|常规)背景(?:心衰|心力衰竭)?治疗", "Detailed Chinese background-therapy phrase"),
    (r"经\s*超声心动图.{0,40}确认", "Detailed Chinese diagnostic-confirmation phrase"),
    (r"心脏磁共振(?:或|、|和)核素心室造影", "Detailed Chinese diagnostic-modality phrase"),
    (r"安慰剂(?:、|，|,)\s*无药物治疗(?:或|、|和)假干预", "Detailed Chinese comparator phrase"),
    (r"包括.{0,12}β受体阻滞剂.{0,12}背景治疗", "Detailed Chinese comparator-background phrase"),
]

_READABILITY_INTERPRETIVE_SECTIONS = {
    "abstract",
    "introduction",
    "methods",
    "results",
    "discussion",
    "conclusion",
    "conclusions",
    "摘要",
    "引言",
    "方法",
    "结果",
    "讨论",
    "结论",
}

_READABILITY_OVERLONG_SENTENCE_SECTIONS = {
    "discussion",
    "conclusion",
    "conclusions",
    "讨论",
    "结论",
}

_READABILITY_OVERLONG_SENTENCE_THRESHOLDS = {
    "en": 55,
    "zh": 100,
}

_CLINICAL_INTERPRETATION_MIN_DOMAINS = 5
_CLINICAL_DISCUSSION_MAX_UNITS_BY_LANGUAGE = {
    "en": 1800,
    "zh": 4500,
}
_CLINICAL_DISCUSSION_MAX_PARAGRAPHS = 24
_CLINICAL_DISCUSSION_REDUNDANT_DOMAIN_MAX_PARAGRAPHS = 6
_CLINICAL_DISCUSSION_REDUNDANCY_MIN_PARAGRAPHS = 25
_CLINICAL_DISCUSSION_PROCESS_FRAMING_MIN_PARAGRAPHS = 2
_CLINICAL_DISCUSSION_PROCESS_FRAMING_MAX_UNITS = 80
_CLINICAL_DISCUSSION_PROCESS_FRAMING_PATTERNS = [
    r"\b(?:main|primary|direct)\s+value\s+of\s+this\s+review\b.{0,100}\b(?:transparen|traceab|audit|source)\b",
    r"\b(?:transparent\s+traceability|source\s+audit|source\s+coverage|extraction\s+rows?|calculation\s+files?|generated\s+tables?|export\s+package)\b",
    r"\b(?:how\s+the\s+manuscript\s+was\s+produced|manuscript\s+production|generated\s+manuscript|AI[- ]generated|pipeline)\b",
    r"\b(?:reviewers?\s+can\s+directly\s+check|submission\s+preparation|whether\s+sentences\s+are\s+fluent)\b",
    r"(?:最直接的价值|主要价值).{0,60}(?:透明|可追溯|溯源|核对)",
    r"(?:来源提示|来源审查|来源覆盖|提取记录|提取行|效应量计算|导出包|补充证据文件|审稿人可以直接检查)",
    r"(?:投稿准备|语句是否流畅|证据依据是否完整|互相解释|自动全文解析|自动生成|生成稿件)",
]
_CLINICAL_INTERPRETATION_DOMAIN_PATTERNS = {
    "result_context": [
        r"\b(?:pooled|summary|combined)\s+(?:HR|hazard ratio|OR|RR|estimate|effect)\b",
        r"\b95%\s*(?:CI|confidence interval)\b",
        r"\b(?:fewer|lower|reduced|reduction|benefit|favou?red)\b.{0,80}\b(?:events?|outcomes?|risk|hospitali[sz]ation|mortality|death)\b",
        r"(?:合并|汇总).{0,12}(?:HR|OR|RR|效应|估计)",
        r"95%\s*(?:CI|置信区间)",
        r"(?:降低|减少|获益|更少).{0,40}(?:事件|风险|住院|死亡|结局)",
    ],
    "absolute_risk_translation": [
        r"\b(?:baseline risk|absolute benefit|absolute risk|risk difference|NNT|number needed to treat|per 1000)\b",
        r"\b(?:higher|lower)[- ]risk (?:patients?|population|setting)\b",
        r"(?:基线风险|基础风险|绝对获益|绝对风险|风险差|需治数|获益需治数|每1000人)",
    ],
    "endpoint_meaning": [
        r"\b(?:composite endpoint|component outcomes?|endpoint components?|endpoint definition|outcome definition|outcome assessment|assessment tools?|measurement instruments?|diagnostic criteria|time window|hospitali[sz]ation|mortality|cardiovascular death|delirium assessment)\b",
        r"(?:复合终点|组成事件|终点组成|终点定义|结局定义|结局评估|评估工具|测量工具|诊断标准|时间窗|心衰住院|心力衰竭住院|心血管死亡|死亡|谵妄评估)",
    ],
    "benefit_harm_safety": [
        r"\b(?:safety|harms?|adverse events?|tolerability|volume depletion|renal function|kidney function|ketoacidosis|infection|discontinuation)\b",
        r"(?:安全性|不良事件|耐受性|容量不足|肾功能|酮症酸中毒|感染|停药|低血压)",
    ],
    "applicability_subgroups": [
        r"\b(?:applicability|patient selection|subgroup|ejection fraction|kidney function|diabetes|comorbid(?:ity|ities)|frailty|phenotype)\b",
        r"(?:适用性|患者选择|亚组|射血分数|肾功能|糖尿病|合并症|虚弱|表型)",
    ],
    "implementation_followup": [
        r"\b(?:implementation|monitoring|follow-up|adherence|persistence|cost|affordability|patient preference|shared decision|counseling)\b",
        r"(?:实施|监测|随访|依从性|持续用药|费用|可及性|患者偏好|共同决策|宣教)",
    ],
    "certainty_limitations": [
        r"\b(?:certainty|GRADE|heterogeneity|publication bias|limitations?|funnel|small[- ]study|confidence in the evidence)\b",
        r"(?:证据确定性|GRADE|异质性|发表偏倚|局限性|漏斗图|小样本|证据质量)",
    ],
}

_CLINICAL_INTERPRETATION_DOMAIN_LABELS = {
    "result_context": ("Result magnitude and direction", "结果大小和方向"),
    "absolute_risk_translation": ("Absolute risk translation", "绝对风险转换"),
    "endpoint_meaning": ("Endpoint meaning and components", "终点含义和组成"),
    "benefit_harm_safety": ("Benefit-harm and safety", "获益风险和安全性"),
    "applicability_subgroups": ("Applicability and subgroups", "适用性和亚组"),
    "implementation_followup": ("Implementation and follow-up", "实施和随访"),
    "certainty_limitations": ("Certainty and limitations", "证据确定性和局限性"),
}


def _build_abstract_audit_review(project: Project) -> dict | None:
    draft_path = project.base_dir / "manuscript" / "draft.md"
    if not draft_path.exists():
        return None
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace")
    facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    expected_language = _expected_manuscript_language(project, facts if isinstance(facts, dict) else {})
    abstract_headings = ["摘要", "Abstract"] if _is_zh_review_language(expected_language) else ["Abstract", "摘要"]
    abstract_text = _markdown_first_section_text(draft_text, abstract_headings)
    required_labels = _ABSTRACT_REQUIRED_LABELS_ZH if _is_zh_review_language(expected_language) else _ABSTRACT_REQUIRED_LABELS
    label_fields = [
        {
            "label": label,
            "present": _abstract_label_present(abstract_text, label),
        }
        for label in required_labels
    ]
    issues: list[dict[str, Any]] = []
    if not abstract_text.strip():
        issues.append({
            "code": "abstract_missing",
            "severity": "fail",
            "message": "The manuscript does not contain a Markdown Abstract section.",
        })
    for pattern, label in _ABSTRACT_FORBIDDEN_PATTERNS:
        match = re.search(pattern, abstract_text, flags=re.I)
        if match:
            issues.append({
                "code": "abstract_internal_note",
                "severity": "fail",
                "label": label,
                "matched_text": match.group(0),
                "excerpt": _excerpt_around_match(abstract_text, match.start(), match.end()),
                "message": f"The abstract contains internal review or source-status wording: {label}.",
            })
    failed_issues = sum(1 for issue in issues if issue.get("severity") == "fail")
    language = _infer_project_review_language(project)
    return {
        "schema_version": 1,
        "passed": failed_issues == 0,
        "language": language,
        "summary": {
            "abstract_present": bool(abstract_text.strip()),
            "word_count": _text_unit_count(abstract_text),
            "required_labels": len(label_fields),
            "present_labels": sum(1 for field in label_fields if field.get("present")),
            "missing_labels": sum(1 for field in label_fields if not field.get("present")),
            "forbidden_phrase_count": sum(1 for issue in issues if issue.get("code") == "abstract_internal_note"),
            "issues": len(issues),
            "failed_issues": failed_issues,
        },
        "label_fields": label_fields,
        "issues": issues,
    }


def _build_publication_tone_audit_review(project: Project) -> dict | None:
    draft_path = project.base_dir / "manuscript" / "draft.md"
    if not draft_path.exists():
        return None
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace")
    scan_text = _main_article_text_before_supplement(draft_text)
    issues: list[dict[str, Any]] = []
    for pattern, label in _PUBLICATION_TONE_FORBIDDEN_PATTERNS:
        for match in re.finditer(pattern, scan_text, flags=re.I):
            issues.append({
                "code": "publication_internal_tone",
                "severity": "fail",
                "label": label,
                "matched_text": match.group(0),
                "excerpt": _excerpt_around_match(scan_text, match.start(), match.end()),
                "message": f"The main manuscript body contains internal or engineering-style wording: {label}.",
            })
    failed_issues = sum(1 for issue in issues if issue.get("severity") == "fail")
    language = _infer_project_review_language(project)
    return {
        "schema_version": 1,
        "passed": failed_issues == 0,
        "language": language,
        "summary": {
            "scanned_word_count": len(re.findall(r"\b[\w%./+-]+\b", scan_text)),
            "forbidden_phrase_count": len(issues),
            "issues": len(issues),
            "failed_issues": failed_issues,
        },
        "issues": issues,
    }


def _build_readability_audit_review(project: Project) -> dict | None:
    draft_path = project.base_dir / "manuscript" / "draft.md"
    if not draft_path.exists():
        return None
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace")
    sections = _markdown_h2_sections(_main_article_text_before_supplement(draft_text))
    issues: list[dict[str, Any]] = []
    scanned_sections = 0
    scanned_words = 0
    verbose_pico_fragments = 0
    overlong_sentences = 0
    for section_name, section_text in sections:
        section_key = section_name.strip().lower()
        if section_key not in _READABILITY_INTERPRETIVE_SECTIONS:
            continue
        scanned_sections += 1
        text_without_code = _strip_markdown_code_fences(section_text)
        scanned_words += _text_unit_count(text_without_code)
        for pattern, label in _READABILITY_VERBOSE_PICO_PATTERNS:
            for match in re.finditer(pattern, text_without_code, flags=re.I):
                verbose_pico_fragments += 1
                issues.append({
                    "code": "verbose_pico_fragment",
                    "severity": "fail",
                    "section": section_name,
                    "label": label,
                    "matched_text": match.group(0),
                    "excerpt": _excerpt_around_match(text_without_code, match.start(), match.end()),
                    "message": (
                        "Interpretive manuscript sections should use concise PICO labels; "
                        f"detailed eligibility wording belongs in Methods: {label}."
                    ),
                })
        if section_key in _READABILITY_OVERLONG_SENTENCE_SECTIONS:
            language = _readability_language_for_text(text_without_code)
            threshold = _READABILITY_OVERLONG_SENTENCE_THRESHOLDS.get(language, _READABILITY_OVERLONG_SENTENCE_THRESHOLDS["en"])
            for sentence in _readability_sentence_segments(text_without_code):
                sentence_units = _text_unit_count(sentence)
                if sentence_units <= threshold:
                    continue
                overlong_sentences += 1
                issues.append({
                    "code": "overlong_sentence",
                    "severity": "fail",
                    "section": section_name,
                    "label": "Overlong sentence" if language != "zh" else "中文超长句",
                    "matched_text": _readability_sentence_excerpt(sentence),
                    "excerpt": _readability_sentence_excerpt(sentence, radius=180),
                    "sentence_units": sentence_units,
                    "threshold": threshold,
                    "message": (
                        "Split or tighten this interpretive sentence so clinical reasoning is easier to review."
                        if language != "zh" else
                        "请拆分或压缩该解释性长句，便于读者核对临床推理。"
                    ),
                })
    failed_issues = sum(1 for issue in issues if issue.get("severity") == "fail")
    return {
        "schema_version": 1,
        "passed": failed_issues == 0,
        "summary": {
            "scanned_sections": scanned_sections,
            "scanned_word_count": scanned_words,
            "verbose_pico_fragments": verbose_pico_fragments,
            "overlong_sentences": overlong_sentences,
            "issues": len(issues),
            "failed_issues": failed_issues,
        },
        "issues": issues,
    }


def _build_clinical_interpretation_audit_review(project: Project) -> dict | None:
    draft_path = project.base_dir / "manuscript" / "draft.md"
    if not draft_path.exists():
        return None
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace")
    facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    facts = facts if isinstance(facts, dict) else {}
    language = _expected_manuscript_language(project, facts) or _review_language_from_text(draft_text)
    discussion_text = _markdown_first_section_text(draft_text, CITATION_AUDIT_SECTION_HEADINGS["Discussion"])
    conclusion_text = _markdown_first_section_text(draft_text, CITATION_AUDIT_SECTION_HEADINGS["Conclusion"])
    scan_text = _strip_markdown_code_fences(f"{discussion_text}\n\n{conclusion_text}")
    discussion_paragraphs = _clinical_discussion_prose_paragraphs(discussion_text)
    discussion_units = _text_unit_count(discussion_text)
    max_discussion_units = _CLINICAL_DISCUSSION_MAX_UNITS_BY_LANGUAGE["zh" if _is_zh_review_language(language) else "en"]
    process_framing_paragraphs = _clinical_discussion_process_framing_paragraphs(scan_text)
    redundant_domain_rows = _clinical_discussion_redundant_domain_rows(
        discussion_paragraphs,
        language=language,
    )
    domain_rows = _clinical_interpretation_domain_rows(scan_text, language=language)
    covered = [row["domain"] for row in domain_rows if row.get("covered")]
    missing = [row["domain"] for row in domain_rows if not row.get("covered")]
    issues: list[dict[str, Any]] = []
    if not discussion_text.strip():
        issues.append({
            "code": "clinical_discussion_missing",
            "severity": "fail",
            "section": "Discussion" if not _is_zh_review_language(language) else "讨论",
            "message": "The manuscript lacks a Discussion section with clinical interpretation.",
        })
    elif len(covered) < _CLINICAL_INTERPRETATION_MIN_DOMAINS:
        issues.append({
            "code": "clinical_interpretation_depth_low",
            "severity": "fail",
            "section": "Discussion" if not _is_zh_review_language(language) else "讨论",
            "covered_domains": covered,
            "missing_domains": missing,
            "minimum_domains": _CLINICAL_INTERPRETATION_MIN_DOMAINS,
            "message": (
                "Discussion and Conclusion cover too few clinical interpretation domains; "
                "add result interpretation, absolute-risk translation, endpoint meaning, safety, "
                "applicability, implementation, and certainty/limitations as relevant."
            ),
        })
    elif "result_context" not in covered:
        issues.append({
            "code": "clinical_result_context_missing",
            "severity": "fail",
            "section": "Discussion" if not _is_zh_review_language(language) else "讨论",
            "message": (
                "Discussion or Conclusion does not interpret the direction, magnitude, or uncertainty "
                "of the main result."
            ),
        })
    if discussion_text.strip() and (
        discussion_units > max_discussion_units
        or len(discussion_paragraphs) > _CLINICAL_DISCUSSION_MAX_PARAGRAPHS
    ):
        issues.append({
            "code": "clinical_discussion_too_long",
            "severity": "fail",
            "section": "Discussion" if not _is_zh_review_language(language) else "讨论",
            "discussion_word_count": discussion_units,
            "maximum_discussion_word_count": max_discussion_units,
            "discussion_paragraph_count": len(discussion_paragraphs),
            "maximum_discussion_paragraphs": _CLINICAL_DISCUSSION_MAX_PARAGRAPHS,
            "message": (
                "Discussion is too long for a clinical interpretation section; consolidate repeated "
                "themes into a smaller number of clinically focused paragraphs."
            ),
        })
    if redundant_domain_rows:
        issues.append({
            "code": "clinical_discussion_redundant_domains",
            "severity": "fail",
            "section": "Discussion" if not _is_zh_review_language(language) else "讨论",
            "redundant_domains": [row["domain"] for row in redundant_domain_rows],
            "redundant_domain_rows": redundant_domain_rows,
            "maximum_paragraphs_per_domain": _CLINICAL_DISCUSSION_REDUNDANT_DOMAIN_MAX_PARAGRAPHS,
            "message": (
                "Discussion revisits the same clinical interpretation themes across too many paragraphs; "
                "merge overlapping baseline-risk, endpoint, safety, applicability, implementation, and certainty points."
            ),
        })
    if _clinical_discussion_has_dominant_process_framing(process_framing_paragraphs):
        issues.append({
            "code": "clinical_discussion_process_framing",
            "severity": "fail",
            "section": "Discussion" if not _is_zh_review_language(language) else "讨论",
            "process_framing_paragraphs": process_framing_paragraphs,
            "message": (
                "Discussion or Conclusion frames the manuscript around traceability, source audits, "
                "generated files, or review workflow rather than clinical interpretation."
            ),
        })
    failed_issues = sum(1 for issue in issues if issue.get("severity") == "fail")
    return {
        "schema_version": 1,
        "passed": failed_issues == 0,
        "language": language,
        "summary": {
            "minimum_domains": _CLINICAL_INTERPRETATION_MIN_DOMAINS,
            "domain_count": len(domain_rows),
            "covered_domains": len(covered),
            "missing_domains": missing,
            "result_context_present": "result_context" in covered,
            "discussion_word_count": discussion_units,
            "maximum_discussion_word_count": max_discussion_units,
            "discussion_paragraph_count": len(discussion_paragraphs),
            "maximum_discussion_paragraphs": _CLINICAL_DISCUSSION_MAX_PARAGRAPHS,
            "conclusion_word_count": _text_unit_count(conclusion_text),
            "process_framing_paragraphs": len(process_framing_paragraphs),
            "redundant_domain_count": len(redundant_domain_rows),
            "issues": len(issues),
            "failed_issues": failed_issues,
        },
        "domain_rows": domain_rows,
        "issues": issues,
    }


def _clinical_interpretation_domain_rows(text: str, *, language: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for domain, patterns in _CLINICAL_INTERPRETATION_DOMAIN_PATTERNS.items():
        matches: list[dict[str, str]] = []
        for pattern in patterns:
            match = re.search(pattern, text, flags=re.I)
            if not match:
                continue
            matches.append({
                "pattern": pattern,
                "matched_text": match.group(0),
                "excerpt": _excerpt_around_match(text, match.start(), match.end()),
            })
            break
        en_label, zh_label = _CLINICAL_INTERPRETATION_DOMAIN_LABELS.get(domain, (domain, domain))
        rows.append({
            "domain": domain,
            "label": zh_label if _is_zh_review_language(language) else en_label,
            "covered": bool(matches),
            "matches": matches,
        })
    return rows


def _clinical_discussion_prose_paragraphs(section_text: str) -> list[str]:
    paragraphs: list[str] = []
    for item in re.split(r"\n\s*\n+", _strip_markdown_code_fences(str(section_text or ""))):
        paragraph = item.strip()
        if not paragraph:
            continue
        first_line = paragraph.splitlines()[0].strip()
        if first_line.startswith(("#", "|", "![", "<")):
            continue
        if _paragraph_is_nonprose_block(paragraph):
            continue
        paragraphs.append(paragraph)
    return paragraphs


def _clinical_discussion_process_framing_paragraphs(text: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, paragraph in enumerate(_clinical_discussion_prose_paragraphs(text), start=1):
        normalized = re.sub(r"\s+", " ", paragraph).strip()
        for pattern in _CLINICAL_DISCUSSION_PROCESS_FRAMING_PATTERNS:
            match = re.search(pattern, normalized, flags=re.I)
            if not match:
                continue
            rows.append({
                "paragraph_index": index,
                "matched_text": match.group(0),
                "text_units": _text_unit_count(normalized),
                "excerpt": _readability_sentence_excerpt(normalized, radius=240),
            })
            break
    return rows


def _clinical_discussion_has_dominant_process_framing(rows: list[dict[str, Any]]) -> bool:
    if not rows:
        return False
    if len(rows) >= _CLINICAL_DISCUSSION_PROCESS_FRAMING_MIN_PARAGRAPHS:
        return True
    return sum(_coerce_int(row.get("text_units")) for row in rows) >= _CLINICAL_DISCUSSION_PROCESS_FRAMING_MAX_UNITS


def _clinical_discussion_redundant_domain_rows(
    paragraphs: list[str],
    *,
    language: str,
) -> list[dict[str, Any]]:
    if len(paragraphs) < _CLINICAL_DISCUSSION_REDUNDANCY_MIN_PARAGRAPHS:
        return []
    rows: list[dict[str, Any]] = []
    zh = _is_zh_review_language(language)
    for domain, patterns in _CLINICAL_INTERPRETATION_DOMAIN_PATTERNS.items():
        paragraph_indices: list[int] = []
        for index, paragraph in enumerate(paragraphs, start=1):
            if any(re.search(pattern, paragraph, flags=re.I) for pattern in patterns):
                paragraph_indices.append(index)
        if len(paragraph_indices) <= _CLINICAL_DISCUSSION_REDUNDANT_DOMAIN_MAX_PARAGRAPHS:
            continue
        label = _CLINICAL_INTERPRETATION_DOMAIN_LABELS.get(domain, (domain, domain))[1 if zh else 0]
        rows.append({
            "domain": domain,
            "label": label,
            "paragraph_count": len(paragraph_indices),
            "paragraph_indices": paragraph_indices[:20],
        })
    rows.sort(key=lambda row: (-int(row.get("paragraph_count") or 0), str(row.get("domain") or "")))
    return rows


def _readability_language_for_text(text: str) -> str:
    raw = str(text or "")
    cjk_chars = len(re.findall(r"[\u4e00-\u9fff]", raw))
    latin_words = len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", raw))
    return "zh" if cjk_chars >= max(1, latin_words * 2) else "en"


def _readability_sentence_segments(text: str) -> list[str]:
    raw = str(text or "")
    kept_lines: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if (
            not stripped
            or stripped.startswith("#")
            or stripped.startswith("|")
            or stripped.startswith("![")
            or re.match(r"^[-*]\s+", stripped)
        ):
            continue
        kept_lines.append(stripped)
    plain = " ".join(kept_lines)
    if not plain:
        return []
    parts = re.split(r"(?<=[。！？])|(?<=[!?])\s+|(?<=[.])\s+(?=[A-Z0-9])", plain)
    return [re.sub(r"\s+", " ", part).strip() for part in parts if part and part.strip()]


def _readability_sentence_excerpt(sentence: str, *, radius: int = 140) -> str:
    compact = re.sub(r"\s+", " ", str(sentence or "")).strip()
    if len(compact) <= radius:
        return compact
    return compact[: max(0, radius - 3)].rstrip() + "..."


def _abstract_label_present(abstract_text: str, label: str) -> bool:
    escaped = re.escape(label)
    return bool(
        re.search(rf"(^|\n)\s*(?:\*\*)?{escaped}[:：]?(?:\*\*)?\s*[:：]", abstract_text, flags=re.I)
        or re.search(rf"(^|\n)\s*\*\*{escaped}[:：]\*\*", abstract_text, flags=re.I)
    )


def _excerpt_around_match(text: str, start: int, end: int, radius: int = 90) -> str:
    raw = str(text or "")
    left = max(0, start - radius)
    right = min(len(raw), end + radius)
    prefix = "..." if left > 0 else ""
    suffix = "..." if right < len(raw) else ""
    return prefix + re.sub(r"\s+", " ", raw[left:right]).strip() + suffix


def _build_calculation_audit_review(project: Project) -> dict | None:
    facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    facts = facts if isinstance(facts, dict) else {}
    meta_results = project.load_json("meta_results.json", subdir="analysis")
    if not isinstance(meta_results, dict):
        return _build_compiled_calculation_audit_review(project, facts)
    primary = meta_results.get("primary_outcome")
    if not isinstance(primary, dict):
        return _build_compiled_calculation_audit_review(project, facts)
    studies = primary.get("studies") or []
    if not isinstance(studies, list) or not studies:
        return None

    source_rows = _calculation_source_rows(project, facts)
    effect_measure = str(primary.get("effect_measure") or "").strip().upper()
    rows: list[dict[str, Any]] = []

    for study in studies:
        if not isinstance(study, dict):
            continue
        source = _match_calculation_source_row(study, source_rows)
        yi = _number_or_none(study.get("yi"))
        row = {
            "study_id": str(study.get("study_id") or ""),
            "study_label": str(study.get("study_label") or ""),
            "effect_measure": effect_measure,
            "effect_log": _rounded(yi),
            "effect_original": _rounded(_effect_to_original(yi, effect_measure)),
            "variance": _rounded(_number_or_none(study.get("vi"))),
            "standard_error": _rounded(_number_or_none(study.get("se"))),
            "weight_percent": _rounded(_number_or_none(study.get("weight"))),
            "row_id": source.get("row_id") or "",
            "outcome_name": source.get("outcome_name") or "",
            "events_intervention": _integer_or_none(source.get("events_intervention")),
            "total_intervention": _integer_or_none(source.get("total_intervention")),
            "events_control": _integer_or_none(source.get("events_control")),
            "total_control": _integer_or_none(source.get("total_control")),
            "source_location": source.get("source_location") or "",
            "source_page": source.get("source_page"),
            "source_section": source.get("source_section") or "",
            "source_quote": source.get("source_quote") or "",
            "source_quote_verified": source.get("source_quote_verified"),
            "source_row_matched": bool(source),
        }
        row["formula_inputs_complete"] = all(
            row.get(key) is not None
            for key in ("events_intervention", "total_intervention", "events_control", "total_control")
        )
        rows.append(row)

    totals = _calculation_aggregate_counts(rows)
    return {
        "summary": {
            "outcome_name": primary.get("outcome_name") or "",
            "effect_measure": effect_measure,
            "model": primary.get("model") or "",
            "n_studies": primary.get("n_studies"),
            "row_count": len(rows),
            "source_rows_matched": sum(1 for row in rows if row.get("source_row_matched")),
            "source_quote_verified_rows": sum(1 for row in rows if row.get("source_quote_verified") is True),
            "formula_inputs_complete_rows": sum(1 for row in rows if row.get("formula_inputs_complete") is True),
            "pooled_effect": _rounded(_number_or_none(primary.get("pooled_effect"))),
            "ci_lower": _rounded(_number_or_none(primary.get("ci_lower"))),
            "ci_upper": _rounded(_number_or_none(primary.get("ci_upper"))),
            "p_value": _rounded(_number_or_none(primary.get("p_value"))),
            "pooled_log": _rounded(_number_or_none(primary.get("pooled_log"))),
            "ci_lower_log": _rounded(_number_or_none(primary.get("ci_lower_log"))),
            "ci_upper_log": _rounded(_number_or_none(primary.get("ci_upper_log"))),
            "i_squared": _rounded(_number_or_none(primary.get("i_squared"))),
            "q_statistic": _rounded(_number_or_none(primary.get("q_statistic"))),
            "q_p_value": _rounded(_number_or_none(primary.get("q_p_value"))),
            "tau_squared": _rounded(_number_or_none(primary.get("tau_squared"))),
            **totals,
        },
        "formulas": _calculation_formulas(effect_measure),
        "rows": rows,
    }


def _build_compiled_calculation_audit_review(project: Project, facts: dict[str, Any]) -> dict | None:
    """Audit the exact independent units used by a compiled synthesis method."""
    synthesis = project.load_json("synthesis_result.json", subdir="analysis")
    method_audit = project.load_json("method_input_audit.json", subdir="analysis")
    route = project.load_json("synthesis_route.json", subdir="analysis")
    if not isinstance(synthesis, dict) or not isinstance(method_audit, dict):
        return None
    if not isinstance(route, dict) or route.get("route") != "method_plugin":
        return None
    estimates = [item for item in synthesis.get("primary_estimates") or [] if isinstance(item, dict)]
    if not estimates:
        return None
    primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
    effect_measure = str(primary.get("effect_measure") or estimates[0].get("measure") or "").strip().upper()
    source_rows = _calculation_source_rows(project, facts)
    payload = synthesis.get("engine_payload") if isinstance(synthesis.get("engine_payload"), dict) else {}
    study_units = [item for item in payload.get("study_effects") or [] if isinstance(item, dict)]
    if not study_units:
        seen: set[str] = set()
        for item in method_audit.get("inputs") or []:
            if not isinstance(item, dict):
                continue
            study_id = str(item.get("study_id") or "")
            if study_id and study_id not in seen:
                study_units.append({"study_id": study_id})
                seen.add(study_id)

    fact_studies = [item for item in primary.get("studies") or [] if isinstance(item, dict)]
    fact_by_study = {
        _normalized_study_key(item.get("study_id")): item
        for item in fact_studies
        if _normalized_study_key(item.get("study_id"))
    }
    rows: list[dict[str, Any]] = []
    for unit in study_units:
        study_id = str(unit.get("study_id") or "")
        source = _match_calculation_source_row(unit, source_rows)
        fact_study = fact_by_study.get(_normalized_study_key(study_id), {})
        analysis_effect = _number_or_none(
            unit.get("analysis_effect")
            if unit.get("analysis_effect") is not None
            else unit.get("yi")
        )
        variance = _number_or_none(
            unit.get("variance")
            if unit.get("variance") is not None
            else unit.get("vi")
        )
        standard_error = _number_or_none(unit.get("standard_error") or unit.get("se"))
        if standard_error is None and variance is not None and variance >= 0:
            standard_error = math.sqrt(variance)
        original = _number_or_none(fact_study.get("effect"))
        if original is None:
            original = _effect_to_original(analysis_effect, effect_measure)
        row = {
            "study_id": study_id,
            "study_label": str(fact_study.get("study_label") or source.get("study_label") or study_id),
            "design": unit.get("design") or ((source.get("raw_data") or {}).get("design") if isinstance(source.get("raw_data"), dict) else ""),
            "n_contrasts": unit.get("n_contrasts"),
            "effect_measure": effect_measure,
            "effect_log": _rounded(analysis_effect),
            "effect_original": _rounded(original),
            "variance": _rounded(variance),
            "standard_error": _rounded(standard_error),
            "weight_percent": _rounded(_number_or_none(fact_study.get("weight"))),
            "row_id": source.get("row_id") or "",
            "outcome_name": source.get("outcome_name") or primary.get("outcome_name") or "",
            "events_intervention": _integer_or_none(source.get("events_intervention")),
            "total_intervention": _integer_or_none(source.get("total_intervention")),
            "events_control": _integer_or_none(source.get("events_control")),
            "total_control": _integer_or_none(source.get("total_control")),
            "source_location": source.get("source_location") or "",
            "source_page": source.get("source_page"),
            "source_section": source.get("source_section") or "",
            "source_quote": source.get("source_quote") or "",
            "source_quote_verified": source.get("source_quote_verified"),
            "source_row_matched": bool(source),
        }
        row["formula_inputs_complete"] = all(
            row.get(key) is not None
            for key in ("events_intervention", "total_intervention", "events_control", "total_control")
        )
        rows.append(row)

    audit_inputs = [item for item in method_audit.get("inputs") or [] if isinstance(item, dict)]
    audit_ids = [str(item.get("result_id") or "") for item in audit_inputs]
    synthesis_ids = [str(item) for item in synthesis.get("input_result_ids") or []]
    source_inputs_valid = bool(audit_inputs) and all(
        item.get("evidence_state") in {"verified", "adjudicated"}
        and any(locator.get("quote_verified") is True for locator in item.get("source_locators") or [])
        for item in audit_inputs
    )
    n_studies = _integer_or_none(synthesis.get("n_studies")) or len(rows)
    compiled_integrity = bool(
        audit_ids
        and audit_ids == synthesis_ids
        and len(audit_ids) == len(set(audit_ids))
        and source_inputs_valid
        and synthesis.get("execution_converged") is not False
        and len(rows) == n_studies
    )
    estimate = estimates[0]
    totals = _calculation_aggregate_counts(rows)
    heterogeneity = synthesis.get("heterogeneity") if isinstance(synthesis.get("heterogeneity"), dict) else {}
    return {
        "summary": {
            "compiled_method": True,
            "compiled_method_integrity": compiled_integrity,
            "method_family": synthesis.get("family") or facts.get("method_family") or "",
            "dependency_handling": payload.get("design_counts") or (payload.get("diagnostics") or {}),
            "execution_converged": synthesis.get("execution_converged"),
            "outcome_name": primary.get("outcome_name") or estimate.get("label") or "",
            "effect_measure": effect_measure,
            "model": synthesis.get("estimator") or primary.get("model") or "",
            "n_studies": n_studies,
            "row_count": len(rows),
            "source_rows_matched": sum(1 for row in rows if row.get("source_row_matched")),
            "source_quote_verified_rows": sum(1 for row in rows if row.get("source_quote_verified") is True),
            "formula_inputs_complete_rows": sum(1 for row in rows if row.get("formula_inputs_complete") is True),
            "pooled_effect": _rounded(_number_or_none(estimate.get("estimate"))),
            "ci_lower": _rounded(_number_or_none(estimate.get("ci_lower"))),
            "ci_upper": _rounded(_number_or_none(estimate.get("ci_upper"))),
            "prediction_lower": _rounded(_number_or_none(estimate.get("prediction_lower"))),
            "prediction_upper": _rounded(_number_or_none(estimate.get("prediction_upper"))),
            "p_value": _rounded(_number_or_none(primary.get("p_value"))),
            "i_squared": _rounded(_number_or_none(heterogeneity.get("i_squared") or payload.get("i_squared"))),
            "q_statistic": _rounded(_number_or_none(heterogeneity.get("q") or payload.get("q"))),
            "tau_squared": _rounded(_number_or_none(heterogeneity.get("tau_squared") or payload.get("tau_squared"))),
            **totals,
        },
        "formulas": {
            **_calculation_formulas(effect_measure),
            "compiled_method": {
                "unit": "independent study unit after design-specific dependence handling",
                "integrity": "method ledger inputs, source locators, convergence, and study-unit count must agree",
            },
        },
        "rows": rows,
    }


def _build_primary_source_trace_review(calculation_audit: dict | None, *, language: str = "en") -> dict | None:
    if not isinstance(calculation_audit, dict):
        return None
    summary = calculation_audit.get("summary") if isinstance(calculation_audit.get("summary"), dict) else {}
    audit_rows = calculation_audit.get("rows") if isinstance(calculation_audit.get("rows"), list) else []
    if not audit_rows:
        return None

    rows: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    for index, audit_row in enumerate(audit_rows):
        if not isinstance(audit_row, dict):
            continue
        row_issues: list[dict[str, Any]] = []
        row_id = str(audit_row.get("row_id") or "")
        study_id = str(audit_row.get("study_id") or "")
        study_label = str(audit_row.get("study_label") or study_id or "")
        source_quote = str(audit_row.get("source_quote") or "").strip()
        source_location = str(audit_row.get("source_location") or "").strip()
        source_section = str(audit_row.get("source_section") or "").strip()
        source_page = audit_row.get("source_page")
        location_available = bool(source_location or source_section or source_page is not None)
        quote_verified = audit_row.get("source_quote_verified") is True

        if not audit_row.get("source_row_matched"):
            row_issues.append(_primary_source_trace_issue(
                "primary_source_row_unmatched",
                "Primary-analysis row was not matched to an extraction/source row.",
                audit_row,
                index,
            ))
        if not source_quote:
            row_issues.append(_primary_source_trace_issue(
                "primary_source_quote_missing",
                "Missing source quote for a primary-analysis numeric row.",
                audit_row,
                index,
            ))
        if not location_available:
            row_issues.append(_primary_source_trace_issue(
                "primary_source_location_missing",
                "Missing source location, page, or section for a primary-analysis numeric row.",
                audit_row,
                index,
            ))
        if not quote_verified:
            row_issues.append(_primary_source_trace_issue(
                "primary_source_quote_unverified",
                "Source quote was not verified against parsed full text.",
                audit_row,
                index,
            ))

        issues.extend(row_issues)
        rows.append({
            "row_id": row_id,
            "study_id": study_id,
            "study_label": study_label,
            "outcome_name": audit_row.get("outcome_name") or summary.get("outcome_name") or "",
            "effect_measure": audit_row.get("effect_measure") or summary.get("effect_measure") or "",
            "trace_status": "traceable" if not row_issues else "needs_review",
            "values": {
                "effect_original": audit_row.get("effect_original"),
                "effect_log": audit_row.get("effect_log"),
                "variance": audit_row.get("variance"),
                "standard_error": audit_row.get("standard_error"),
                "weight_percent": audit_row.get("weight_percent"),
                "events_intervention": audit_row.get("events_intervention"),
                "total_intervention": audit_row.get("total_intervention"),
                "events_control": audit_row.get("events_control"),
                "total_control": audit_row.get("total_control"),
            },
            "source": {
                "location": source_location,
                "page": source_page,
                "section": source_section,
                "quote": source_quote,
                "quote_verified": quote_verified,
                "row_matched": bool(audit_row.get("source_row_matched")),
            },
            "issues": [issue["code"] for issue in row_issues],
        })

    failed_issues = sum(1 for issue in issues if issue.get("severity") == "fail")
    return {
        "schema_version": 1,
        "language": _normalize_review_language(language) or "en",
        "passed": failed_issues == 0,
        "summary": {
            "outcome_name": summary.get("outcome_name") or "",
            "effect_measure": summary.get("effect_measure") or "",
            "row_count": len(rows),
            "source_traceable_rows": sum(1 for row in rows if row.get("trace_status") == "traceable"),
            "source_rows_unmatched": sum(1 for row in rows if "primary_source_row_unmatched" in (row.get("issues") or [])),
            "missing_source_quote_rows": sum(1 for row in rows if "primary_source_quote_missing" in (row.get("issues") or [])),
            "missing_source_location_rows": sum(1 for row in rows if "primary_source_location_missing" in (row.get("issues") or [])),
            "unverified_source_quote_rows": sum(1 for row in rows if "primary_source_quote_unverified" in (row.get("issues") or [])),
            "issues": len(issues),
            "failed_issues": failed_issues,
        },
        "rows": rows,
        "issues": issues,
    }


def _primary_source_trace_issue(code: str, message: str, row: dict[str, Any], index: int) -> dict[str, Any]:
    return {
        "code": code,
        "severity": "fail",
        "row_index": index,
        "row_id": row.get("row_id") or "",
        "study_id": row.get("study_id") or "",
        "study_label": row.get("study_label") or "",
        "message": message,
    }


def _build_reference_audit_review(project: Project) -> dict | None:
    draft_path = project.base_dir / "manuscript" / "draft.md"
    references_path = project.base_dir / "references.bib"
    if not draft_path.exists() and not references_path.exists():
        return None
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace") if draft_path.exists() else ""
    bib_text = references_path.read_text(encoding="utf-8", errors="replace") if references_path.exists() else ""
    manuscript_references = _reference_entry_count(_references_section_text(draft_text))
    entries = _parse_bibtex_entries(bib_text)
    count_mismatch = bool(manuscript_references or entries) and manuscript_references != len(entries)
    missing_identifier_entries = [
        entry for entry in entries
        if not (entry.get("doi") or entry.get("pmid") or entry.get("url"))
    ]
    long_author_entries = [
        entry for entry in entries
        if int(entry.get("author_count") or 0) > 50
    ]
    missing_journal_entries = [
        entry for entry in entries
        if entry.get("source_type") == "journal_article" and not str(entry.get("journal") or "").strip()
    ]
    missing_volume_or_pages_entries = [
        entry for entry in entries
        if (
            entry.get("source_type") == "journal_article"
            and str(entry.get("journal") or "").strip()
            and (not str(entry.get("volume") or "").strip() or not str(entry.get("pages") or "").strip())
        )
    ]
    registry_entries = [
        entry for entry in entries
        if entry.get("source_type") in {"trial_registry", "evidence_registry"}
    ]
    issues: list[dict[str, Any]] = []
    if count_mismatch:
        issues.append({
            "code": "reference_count_mismatch",
            "severity": "fail",
            "message": (
                "The numbered manuscript reference list and references.bib contain "
                "different numbers of entries."
            ),
            "manuscript_references": manuscript_references,
            "bib_entries": len(entries),
        })
    for entry in missing_identifier_entries:
        issues.append({
            "code": "reference_missing_identifier",
            "severity": "warn",
            "key": entry.get("key"),
            "message": "Reference entry has no DOI, PMID, or URL.",
        })
    for entry in missing_journal_entries:
        issues.append({
            "code": "reference_missing_journal",
            "severity": "fail",
            "key": entry.get("key"),
            "message": "Journal article reference has DOI/PMID metadata but no journal title.",
        })
    for entry in missing_volume_or_pages_entries:
        issues.append({
            "code": "reference_missing_volume_or_pages",
            "severity": "warn",
            "key": entry.get("key"),
            "message": "Journal article reference is missing volume and/or page range metadata.",
        })
    for entry in long_author_entries:
        issues.append({
            "code": "reference_long_author_list",
            "severity": "warn",
            "key": entry.get("key"),
            "author_count": entry.get("author_count"),
            "message": "Reference entry has a very long author list; check journal-specific bibliography limits.",
        })
    language = _infer_project_review_language(project)
    return {
        "schema_version": 1,
        "passed": not any(issue.get("severity") == "fail" for issue in issues),
        "language": language,
        "summary": {
            "manuscript_references": manuscript_references,
            "bib_entries": len(entries),
            "count_mismatch": count_mismatch,
            "entries_with_identifier": len(entries) - len(missing_identifier_entries),
            "entries_missing_identifier": len(missing_identifier_entries),
            "entries_missing_journal": len(missing_journal_entries),
            "entries_missing_volume_or_pages": len(missing_volume_or_pages_entries),
            "very_long_author_entries": len(long_author_entries),
            "registry_entries": len(registry_entries),
            "issues": len(issues),
            "failed_issues": sum(1 for issue in issues if issue.get("severity") == "fail"),
            "warning_issues": sum(1 for issue in issues if issue.get("severity") == "warn"),
        },
        "issues": issues,
        "entries": entries,
    }


def _build_manuscript_citation_fix_review(project: Project) -> dict | None:
    log = project.load_json("manuscript_citation_fixes.json", subdir="manuscript")
    if not isinstance(log, dict) or not log:
        return None
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
        "schema_version": 1,
        "language": _infer_project_review_language(project),
        "summary": {
            "current_revision": int(log.get("current_revision") or 0),
            "entries": len(entries),
            "citation_patch_actions": citation_patch_actions,
            "reference_add_actions": len(reference_add_entries),
            "reference_reuse_actions": len(reference_reuse_entries),
            "reference_add_human_review_required": reference_add_human_review_required,
            "reference_fix_human_review_required": reference_fix_human_review_required,
            **quality_delta_summary,
        },
        "entries": entries,
    }


_PRISMA_AUDIT_FIELDS = [
    {
        "field": "records_identified",
        "label": "Records identified",
        "path": ("identification", "records_identified"),
        "patterns": [
            r"search\s+identified\s+([0-9,]+)\s+records",
            r"identified\s+([0-9,]+)\s+records",
            r"检索识别\s*([0-9,，]+)\s*条记录",
            r"识别\s*([0-9,，]+)\s*条记录",
        ],
    },
    {
        "field": "duplicates_removed",
        "label": "Duplicates removed",
        "path": ("identification", "duplicates_removed"),
        "patterns": [
            r"([0-9,]+)\s+duplicates?\s+(?:were\s+)?removed",
            r"removing\s+([0-9,]+)\s+duplicates?",
            r"删除\s*([0-9,，]+)\s*条重复记录",
            r"([0-9,，]+)\s*条重复记录\s*(?:被)?(?:删除|移除)",
        ],
    },
    {
        "field": "records_after_dedup",
        "label": "Records after deduplication",
        "path": ("identification", "records_after_dedup"),
        "patterns": [
            r"(?:leaving|left)\s+([0-9,]+)\s+(?:unique\s+)?records(?:\s+(?:after|for\s+screening))?",
            r"([0-9,]+)\s+(?:unique\s+)?records\s+(?:remained|remaining)\s+(?:after|for\s+screening)",
            r"after\s+(?:cross[- ]source\s+)?deduplication,?\s+([0-9,]+)\s+(?:unique\s+)?records",
            r"([0-9,]+)\s+(?:unique\s+)?records\s+after\s+(?:cross[- ]source\s+)?deduplication",
            r"去重后\s*([0-9,，]+)\s*条(?:记录)?",
            r"剩余\s*([0-9,，]+)\s*条(?:记录)?",
        ],
    },
    {
        "field": "title_abstract_screened",
        "label": "Title/abstract records screened",
        "path": ("screening", "title_abstract_screened"),
        "patterns": [
            r"screened\s+([0-9,]+)\s+title/?abstract\s+records",
            r"screened\s+([0-9,]+)\s+titles?\s+and\s+abstracts?",
            r"([0-9,]+)\s+title/?abstract\s+records\s+were\s+screened",
            r"([0-9,]+)\s+titles?\s+and\s+abstracts?\s+(?:were\s+)?screened",
            r"题名/摘要筛选\s*([0-9,，]+)\s*条(?:记录)?",
            r"([0-9,，]+)\s*条(?:记录)?进入题名/摘要筛选",
        ],
    },
    {
        "field": "full_text_assessed",
        "label": "Full-text records assessed",
        "path": ("eligibility", "full_text_assessed"),
        "patterns": [
            r"assessed\s+([0-9,]+)\s+full[- ]text\s+(?:records|articles|reports)",
            r"([0-9,]+)\s+underwent\s+full[- ]text\s+assessment",
            r"([0-9,]+)\s+full[- ]text\s+(?:records|articles|reports)\s+were\s+assessed",
            r"全文评估\s*([0-9,，]+)\s*(?:篇|条|项)(?:记录|研究|文献)?",
        ],
    },
    {
        "field": "studies_included",
        "label": "Studies included",
        "path": ("included", "studies_included"),
        "patterns": [
            r"(?:meta-analysis|synthesis|review)\s+included\s+([0-9,]+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:studies|trials|rcts?)",
            r"included\s+([0-9,]+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:studies|trials|rcts?)",
            r"([0-9,]+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:studies|trials|rcts?)\s+(?:were\s+)?(?:included|identified\s+as\s+eligible)",
            r"纳入\s*([0-9,，]+)\s*项研究",
            r"最终纳入\s*([0-9,，]+)\s*项研究",
        ],
    },
]


def _build_prisma_audit_review(project: Project) -> dict | None:
    flow = project.load_json("prisma_flow.json")
    if not isinstance(flow, dict):
        return None
    draft_path = project.base_dir / "manuscript" / "draft.md"
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace") if draft_path.exists() else ""
    fields: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    for spec in _PRISMA_AUDIT_FIELDS:
        expected = _nested_int(flow, spec["path"])
        if expected is None:
            continue
        reported_values = _extract_prisma_reported_values(draft_text, spec["patterns"])
        matched = expected in reported_values
        field = {
            "field": spec["field"],
            "label": spec["label"],
            "expected": expected,
            "reported_values": reported_values,
            "matched": matched,
        }
        fields.append(field)
        if not reported_values:
            issues.append({
                "code": "prisma_field_missing",
                "severity": "fail",
                "field": spec["field"],
                "label": spec["label"],
                "expected": expected,
                "message": f"Manuscript does not report the PRISMA value for {spec['label']}.",
            })
        elif not matched:
            issues.append({
                "code": "prisma_field_mismatch",
                "severity": "fail",
                "field": spec["field"],
                "label": spec["label"],
                "expected": expected,
                "reported_values": reported_values,
                "message": f"Manuscript PRISMA value for {spec['label']} does not match prisma_flow.json.",
            })

    logical_issues = _prisma_logical_issues(flow)
    issues.extend(logical_issues)
    failed_issues = sum(1 for issue in issues if issue.get("severity") == "fail")
    return {
        "schema_version": 1,
        "passed": failed_issues == 0,
        "summary": {
            "expected_fields": len(fields),
            "matched_fields": sum(1 for field in fields if field.get("matched")),
            "mismatched_fields": sum(
                1 for field in fields
                if field.get("reported_values") and not field.get("matched")
            ),
            "missing_fields": sum(1 for field in fields if not field.get("reported_values")),
            "logical_issues": len(logical_issues),
            "issues": len(issues),
            "failed_issues": failed_issues,
        },
        "fields": fields,
        "issues": issues,
    }


def _nested_int(data: dict[str, Any], path: tuple[str, str]) -> int | None:
    parent = data.get(path[0])
    if not isinstance(parent, dict):
        return None
    value = parent.get(path[1])
    if value is None:
        return None
    return _integer_or_none(value)


def _extract_prisma_reported_values(text: str, patterns: list[str]) -> list[int]:
    values: list[int] = []
    for pattern in patterns:
        for match in re.finditer(pattern, str(text or ""), flags=re.I):
            token = str(match.group(1)).replace(",", "").replace("，", "").casefold()
            word_numbers = {
                "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4,
                "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
                "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
                "fourteen": 14, "fifteen": 15, "sixteen": 16,
                "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20,
            }
            value = word_numbers.get(token)
            if value is None:
                value = _integer_or_none(token)
            if value is not None and value not in values:
                values.append(value)
    return values


def _prisma_logical_issues(flow: dict[str, Any]) -> list[dict[str, Any]]:
    values = {
        spec["field"]: _nested_int(flow, spec["path"])
        for spec in _PRISMA_AUDIT_FIELDS
    }
    issues: list[dict[str, Any]] = []
    identified = values.get("records_identified")
    after_dedup = values.get("records_after_dedup")
    duplicates = values.get("duplicates_removed")
    screened = values.get("title_abstract_screened")
    assessed = values.get("full_text_assessed")
    included = values.get("studies_included")
    if None not in (identified, after_dedup, duplicates) and identified - duplicates != after_dedup:
        issues.append({
            "code": "prisma_arithmetic_mismatch",
            "severity": "fail",
            "message": "records_identified - duplicates_removed does not equal records_after_dedup.",
        })
    monotonic = [
        ("records_identified", identified),
        ("records_after_dedup", after_dedup),
        ("title_abstract_screened", screened),
        ("full_text_assessed", assessed),
        ("studies_included", included),
    ]
    previous_name = ""
    previous_value = None
    for name, value in monotonic:
        if value is None:
            continue
        if previous_value is not None and value > previous_value:
            issues.append({
                "code": "prisma_monotonicity_violation",
                "severity": "fail",
                "field": name,
                "message": f"{name} exceeds {previous_name}.",
            })
        previous_name = name
        previous_value = value
    return issues


def _build_search_strategy_audit_review(project: Project) -> dict | None:
    query_path = project.base_dir / "search_query.txt"
    report_path = project.base_dir / "search_strategy_report.txt"
    draft_path = project.base_dir / "manuscript" / "draft.md"
    if not query_path.exists() and not report_path.exists():
        return None
    query_text = query_path.read_text(encoding="utf-8", errors="replace").strip() if query_path.exists() else ""
    report_text = report_path.read_text(encoding="utf-8", errors="replace") if report_path.exists() else ""
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace") if draft_path.exists() else ""
    normalized_query = _normalize_search_query_for_audit(query_text)
    normalized_manuscript = _normalize_search_query_for_audit(draft_text)
    exact_query_reproduced = bool(normalized_query) and normalized_query in normalized_manuscript
    has_search_label = _has_search_query_in_manuscript(draft_text)
    issues: list[dict[str, Any]] = []
    if not query_text:
        issues.append({
            "code": "search_query_missing",
            "severity": "fail",
            "message": "search_query.txt is missing or empty.",
        })
    elif not exact_query_reproduced:
        issues.append({
            "code": "search_query_not_reproduced",
            "severity": "fail",
            "message": "The manuscript does not reproduce the exact query stored in search_query.txt.",
        })
    if query_text and not has_search_label:
        issues.append({
            "code": "search_query_not_labeled",
            "severity": "warn",
            "message": "The manuscript does not clearly label the full search query/search strategy.",
        })
    return {
        "schema_version": 1,
        "passed": not any(issue.get("severity") == "fail" for issue in issues),
        "summary": {
            "query_file_present": query_path.exists(),
            "query_chars": len(query_text),
            "query_terms": _search_query_term_count(query_text),
            "search_report_present": report_path.exists() and bool(report_text.strip()),
            "search_report_chars": len(report_text.strip()),
            "exact_query_reproduced": exact_query_reproduced,
            "has_search_label": has_search_label,
            "issues": len(issues),
            "failed_issues": sum(1 for issue in issues if issue.get("severity") == "fail"),
            "warning_issues": sum(1 for issue in issues if issue.get("severity") == "warn"),
        },
        "issues": issues,
        "query_excerpt": query_text[:2000],
    }


def _normalize_search_query_for_audit(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


def _search_query_term_count(query: str) -> int:
    if not query:
        return 0
    return len(re.findall(r"[A-Za-z0-9][A-Za-z0-9*%./+-]*", query))


def _build_figure_audit_review(project: Project) -> dict | None:
    draft_path = project.base_dir / "manuscript" / "draft.md"
    figures_dir = project.base_dir / "figures"
    if not draft_path.exists() and not figures_dir.exists():
        return None
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace") if draft_path.exists() else ""
    packaged_pngs = sorted(figures_dir.glob("*.png")) if figures_dir.exists() else []
    image_refs = _markdown_image_refs(draft_text, draft_path.parent)
    headings = _figure_heading_refs(draft_text)
    referenced_existing_paths = {
        ref["resolved_path"]
        for ref in image_refs
        if ref.get("exists") and ref.get("resolved_path")
    }
    missing_refs = [ref for ref in image_refs if not ref.get("exists") and not ref.get("is_external")]
    external_refs = [ref for ref in image_refs if ref.get("is_external")]
    unused_pngs = [
        str(path.relative_to(project.base_dir))
        for path in packaged_pngs
        if str(path.resolve()) not in referenced_existing_paths
    ]
    issues: list[dict[str, Any]] = []
    for ref in missing_refs:
        issues.append({
            "code": "figure_image_missing",
            "severity": "fail",
            "target": ref.get("target"),
            "alt": ref.get("alt"),
            "message": "A manuscript figure image reference does not resolve to a packaged local file.",
        })
    for ref in external_refs:
        issues.append({
            "code": "figure_image_external",
            "severity": "warn",
            "target": ref.get("target"),
            "alt": ref.get("alt"),
            "message": "A manuscript figure image uses an external URL and will not be bundled as a package asset.",
        })
    if headings and len(image_refs) < len(headings):
        issues.append({
            "code": "figure_heading_without_image",
            "severity": "fail",
            "message": "At least one numbered Figure heading has no corresponding markdown image reference.",
            "figure_headings": len(headings),
            "referenced_images": len(image_refs),
        })
    return {
        "schema_version": 1,
        "passed": not any(issue.get("severity") == "fail" for issue in issues),
        "summary": {
            "figure_headings": len(headings),
            "referenced_images": len(image_refs),
            "packaged_png_files": len(packaged_pngs),
            "existing_referenced_images": sum(1 for ref in image_refs if ref.get("exists")),
            "missing_referenced_images": len(missing_refs),
            "external_referenced_images": len(external_refs),
            "unused_png_files": len(unused_pngs),
            "issues": len(issues),
            "failed_issues": sum(1 for issue in issues if issue.get("severity") == "fail"),
            "warning_issues": sum(1 for issue in issues if issue.get("severity") == "warn"),
        },
        "image_refs": image_refs,
        "figure_headings": headings,
        "unused_png_files": unused_pngs,
        "issues": issues,
    }


def _build_cross_reference_audit_review(project: Project) -> dict | None:
    draft_path = project.base_dir / "manuscript" / "draft.md"
    if not draft_path.exists():
        return None
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace")
    defined_tables = _numbered_heading_refs(draft_text, "Table")
    defined_figures = _numbered_heading_refs(draft_text, "Figure")
    if not defined_tables and not defined_figures:
        return None
    main_text = _main_text_before_tables_and_figures(draft_text)
    table_refs = set(_numbered_text_refs(main_text, "Table"))
    figure_refs = set(_numbered_text_refs(main_text, "Figure"))
    table_numbers = {int(item["number"]) for item in defined_tables if item.get("number") is not None}
    figure_numbers = {int(item["number"]) for item in defined_figures if item.get("number") is not None}
    unreferenced_tables = sorted(table_numbers - table_refs)
    unreferenced_figures = sorted(figure_numbers - figure_refs)
    undefined_tables = sorted(table_refs - table_numbers)
    undefined_figures = sorted(figure_refs - figure_numbers)
    issues: list[dict[str, Any]] = []
    for number in unreferenced_tables:
        issues.append({
            "code": "table_unreferenced_in_main_text",
            "severity": "fail",
            "target": f"Table {number}",
            "message": f"Table {number} is defined but not referenced in the main text before the Tables section.",
        })
    for number in unreferenced_figures:
        issues.append({
            "code": "figure_unreferenced_in_main_text",
            "severity": "fail",
            "target": f"Figure {number}",
            "message": f"Figure {number} is defined but not referenced in the main text before the Figures section.",
        })
    for number in undefined_tables:
        issues.append({
            "code": "table_reference_undefined",
            "severity": "fail",
            "target": f"Table {number}",
            "message": f"The main text references Table {number}, but no matching table heading is defined.",
        })
    for number in undefined_figures:
        issues.append({
            "code": "figure_reference_undefined",
            "severity": "fail",
            "target": f"Figure {number}",
            "message": f"The main text references Figure {number}, but no matching figure heading is defined.",
        })
    failed_issues = sum(1 for issue in issues if issue.get("severity") == "fail")
    return {
        "schema_version": 1,
        "passed": failed_issues == 0,
        "summary": {
            "defined_tables": len(table_numbers),
            "defined_figures": len(figure_numbers),
            "main_text_referenced_tables": len(table_refs & table_numbers),
            "main_text_referenced_figures": len(figure_refs & figure_numbers),
            "unreferenced_tables": len(unreferenced_tables),
            "unreferenced_figures": len(unreferenced_figures),
            "undefined_table_references": len(undefined_tables),
            "undefined_figure_references": len(undefined_figures),
            "issues": len(issues),
            "failed_issues": failed_issues,
        },
        "defined_tables": defined_tables,
        "defined_figures": defined_figures,
        "referenced_tables": sorted(table_refs),
        "referenced_figures": sorted(figure_refs),
        "unreferenced_tables": unreferenced_tables,
        "unreferenced_figures": unreferenced_figures,
        "undefined_table_references": undefined_tables,
        "undefined_figure_references": undefined_figures,
        "issues": issues,
    }


def _build_figure_legend_audit_review(project: Project) -> dict | None:
    draft_path = project.base_dir / "manuscript" / "draft.md"
    if not draft_path.exists():
        return None
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace")
    figures = _figure_heading_blocks(draft_text)
    if not figures:
        return None
    issues: list[dict[str, Any]] = []
    rows: list[dict[str, Any]] = []
    for figure in figures:
        has_legend = _figure_block_has_legend(figure["body"])
        row = {
            "number": figure["number"],
            "title": figure["title"],
            "has_legend": has_legend,
        }
        rows.append(row)
        if not has_legend:
            issues.append({
                "code": "figure_legend_missing",
                "severity": "fail",
                "target": f"Figure {figure['number']}",
                "message": (
                    f"Figure {figure['number']} has an image reference but no explanatory legend. "
                    "Formal manuscripts should explain what the figure displays and define key statistical labels."
                ),
            })
    failed_issues = sum(1 for issue in issues if issue.get("severity") == "fail")
    figures_with_legends = sum(1 for row in rows if row.get("has_legend"))
    return {
        "schema_version": 1,
        "passed": failed_issues == 0,
        "summary": {
            "figure_count": len(rows),
            "figures_with_legends": figures_with_legends,
            "missing_legends": len(rows) - figures_with_legends,
            "issues": len(issues),
            "failed_issues": failed_issues,
        },
        "figures": rows,
        "issues": issues,
    }


def _figure_heading_blocks(text: str) -> list[dict[str, Any]]:
    raw = str(text or "")
    matches = list(re.finditer(_numbered_heading_pattern("Figure"), raw, flags=re.I | re.M))
    blocks: list[dict[str, Any]] = []
    for index, match in enumerate(matches):
        next_start = len(raw)
        if index + 1 < len(matches):
            next_start = matches[index + 1].start()
        section_match = re.search(
            _section_boundary_pattern(exclude=("Figures", "图表", "图")),
            raw[match.end():next_start],
            flags=re.I | re.M,
        )
        if section_match:
            next_start = match.end() + section_match.start()
        blocks.append({
            "number": _integer_or_none(match.group(1)),
            "title": match.group(2).strip(),
            "body": raw[match.end():next_start],
        })
    return blocks


def _figure_block_has_legend(block: str) -> bool:
    return bool(
        re.search(
            r"(^|\n)\s*(?:\*\*)?(?:Legend|Caption|Note|图注|说明|注释)(?:\*\*)?\s*[:：.]",
            str(block or ""),
            flags=re.I,
        )
    )


def _build_table_footnote_audit_review(project: Project) -> dict | None:
    draft_path = project.base_dir / "manuscript" / "draft.md"
    if not draft_path.exists():
        return None
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace")
    tables = _table_heading_blocks(draft_text)
    if not tables:
        return None
    issues: list[dict[str, Any]] = []
    rows: list[dict[str, Any]] = []
    for table in tables:
        has_note = _table_block_has_note(table["body"])
        abbreviations = _table_block_abbreviations(table["body"])
        row = {
            "number": table["number"],
            "title": table["title"],
            "has_note": has_note,
            "detected_abbreviations": abbreviations,
        }
        rows.append(row)
        if not has_note:
            issues.append({
                "code": "table_footnote_missing",
                "severity": "fail",
                "target": f"Table {table['number']}",
                "message": (
                    f"Table {table['number']} does not include a Note or abbreviations footnote. "
                    "Formal manuscripts should define statistical labels and extraction conventions below each table."
                ),
            })
    failed_issues = sum(1 for issue in issues if issue.get("severity") == "fail")
    tables_with_notes = sum(1 for row in rows if row.get("has_note"))
    return {
        "schema_version": 1,
        "passed": failed_issues == 0,
        "summary": {
            "table_count": len(rows),
            "tables_with_notes": tables_with_notes,
            "missing_notes": len(rows) - tables_with_notes,
            "issues": len(issues),
            "failed_issues": failed_issues,
        },
        "tables": rows,
        "issues": issues,
    }


def _table_heading_blocks(text: str) -> list[dict[str, Any]]:
    raw = str(text or "")
    matches = list(re.finditer(_numbered_heading_pattern("Table"), raw, flags=re.I | re.M))
    blocks: list[dict[str, Any]] = []
    for index, match in enumerate(matches):
        next_start = len(raw)
        if index + 1 < len(matches):
            next_start = matches[index + 1].start()
        section_match = re.search(
            _section_boundary_pattern(exclude=("Tables", "表格", "表")),
            raw[match.end():next_start],
            flags=re.I | re.M,
        )
        if section_match:
            next_start = match.end() + section_match.start()
        blocks.append({
            "number": _integer_or_none(match.group(1)),
            "title": match.group(2).strip(),
            "body": raw[match.end():next_start],
        })
    return blocks


def _table_block_has_note(block: str) -> bool:
    return bool(
        re.search(
            r"(^|\n)\s*(?:\*\*)?(?:Note|Notes|Abbreviation|Abbreviations|Footnote|Footnotes|注|注释|缩写|说明)(?:\*\*)?\s*[:：.]",
            str(block or ""),
            flags=re.I,
        )
    )


def _table_block_abbreviations(block: str) -> list[str]:
    known = ["CI", "GRADE", "HR", "I²", "MD", "NR", "OR", "RoB", "RR", "SD", "SE", "SMD"]
    detected: list[str] = []
    text = str(block or "")
    for label in known:
        if label == "I²":
            pattern = r"\bI\s*(?:²|\^2|2)\b"
        elif label == "RoB":
            pattern = r"\bRoB\b"
        else:
            pattern = rf"\b{re.escape(label)}\b"
        if re.search(pattern, text, flags=re.I):
            detected.append(label)
    return detected


def _main_text_before_tables_and_figures(text: str) -> str:
    raw = str(text or "")
    positions = [
        match.start()
        for match in re.finditer(_section_boundary_pattern(), raw, flags=re.I | re.M)
    ]
    reference_match = _reference_heading_match(raw)
    if reference_match:
        positions.append(reference_match.start())
    if not positions:
        return raw
    return raw[:min(positions)]


def _section_boundary_pattern(exclude: tuple[str, ...] = ()) -> str:
    headings = [
        "Tables?",
        "Figures?",
        "Supplementary\\s+Materials",
        "Supplementary",
        "Declarations?",
        "References?",
        "Bibliography",
        "Literature\\s+Cited",
        "Works\\s+Cited",
        "表格",
        "图表",
        "表",
        "图",
        "补充材料",
        "声明",
        "参考文献",
        "参考资料",
        "引用文献",
        "文献",
    ]
    excluded = {item.lower() for item in exclude}
    active = [heading for heading in headings if heading.lower() not in excluded]
    return rf"^##\s+(?:{'|'.join(active)})\s*[:：]?\s*$"


def _markdown_image_refs(text: str, manuscript_dir: Path) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for match in re.finditer(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)", str(text or "")):
        alt = match.group(1).strip()
        target = match.group(2).strip()
        is_external = bool(re.match(r"^(?:https?:|data:)", target, flags=re.I))
        resolved = None
        exists = False
        if not is_external:
            resolved_path = (manuscript_dir / target).resolve()
            resolved = str(resolved_path)
            exists = resolved_path.exists() and resolved_path.is_file()
        refs.append({
            "alt": alt,
            "target": target,
            "is_external": is_external,
            "resolved_path": resolved,
            "exists": exists,
        })
    return refs


def _figure_heading_refs(text: str) -> list[dict[str, Any]]:
    return _numbered_heading_refs(text, "Figure")


def _build_primary_result_audit_review(project: Project, calculation_audit: dict | None) -> dict | None:
    summary = (calculation_audit or {}).get("summary") if isinstance(calculation_audit, dict) else {}
    if not isinstance(summary, dict) or not summary:
        return None
    draft_path = project.base_dir / "manuscript" / "draft.md"
    if not draft_path.exists():
        return None
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace")
    fields = _primary_result_expected_fields(summary)
    issues: list[dict[str, Any]] = []
    for field in fields:
        matched = _primary_result_field_present(draft_text, field)
        field["matched"] = matched
        if not matched:
            issues.append({
                "code": "primary_result_field_missing",
                "severity": "fail",
                "field": field.get("field"),
                "label": field.get("label"),
                "expected": field.get("expected"),
                "message": f"The manuscript does not report the expected primary result value for {field.get('label')}.",
            })
    return {
        "schema_version": 1,
        "passed": not issues,
        "summary": {
            "expected_fields": len(fields),
            "matched_fields": sum(1 for field in fields if field.get("matched")),
            "mismatched_fields": sum(1 for field in fields if not field.get("matched")),
            "issues": len(issues),
            "failed_issues": len(issues),
            "effect_measure": summary.get("effect_measure") or "",
            "outcome_name": summary.get("outcome_name") or "",
        },
        "fields": fields,
        "issues": issues,
    }


def _build_claim_support_audit_review(project: Project) -> dict | None:
    """Check major manuscript result/certainty claims against manuscript_facts.json."""
    draft_path = project.base_dir / "manuscript" / "draft.md"
    facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    if not draft_path.exists() or not isinstance(facts, dict):
        return None
    text = draft_path.read_text(encoding="utf-8", errors="replace")
    primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
    grade = facts.get("grade") if isinstance(facts.get("grade"), dict) else {}
    claims: list[dict[str, Any]] = []
    for sentence in _claim_support_candidate_sentences(text):
        primary_claim = _claim_support_primary_effect_claim(sentence, primary)
        if primary_claim:
            claims.append(primary_claim)
        grade_claim = _claim_support_grade_certainty_claim(sentence, grade)
        if grade_claim:
            claims.append(grade_claim)
    if not claims:
        return None
    issues = [
        {
            "code": "unsupported_manuscript_claim",
            "severity": "fail",
            "claim_type": claim.get("claim_type"),
            "sentence": claim.get("sentence"),
            "message": claim.get("reason"),
        }
        for claim in claims
        if claim.get("status") == "unsupported"
    ]
    supported = sum(1 for claim in claims if claim.get("status") == "supported")
    unsupported = len(claims) - supported
    language = _infer_project_review_language(project, facts)
    return {
        "schema_version": 1,
        "passed": unsupported == 0,
        "language": language,
        "manuscript_title": _claim_support_manuscript_title(text),
        "summary": {
            "checked_claims": len(claims),
            "supported_claims": supported,
            "unsupported_claims": unsupported,
            "failed_issues": len(issues),
        },
        "claims": claims,
        "issues": issues,
    }


def _claim_support_manuscript_title(text: str) -> str:
    match = re.search(r"^\s*#\s+(.+?)\s*$", str(text or ""), flags=re.M)
    return match.group(1).strip() if match else ""


def _claim_support_candidate_sentences(text: str) -> list[str]:
    body = re.sub(r"```.*?```", " ", str(text or ""), flags=re.S)
    body = re.sub(r"!\[[^\]]*\]\([^)]+\)", " ", body)
    raw_parts = re.split(r"(?<=[.!?。！？])\s+|\n+", body)
    sentences: list[str] = []
    for raw in raw_parts:
        sentence = re.sub(r"^\s*#+\s*", "", raw).strip()
        sentence = re.sub(r"\s+", " ", sentence)
        if len(sentence) >= 20:
            sentences.append(sentence)
    return sentences


def _claim_support_primary_effect_claim(sentence: str, primary: dict[str, Any]) -> dict[str, Any] | None:
    measure = str(primary.get("effect_measure") or "").upper()
    effect = _number_or_none(primary.get("pooled_effect"))
    ci_lower = _number_or_none(primary.get("ci_lower"))
    ci_upper = _number_or_none(primary.get("ci_upper"))
    if not measure or effect is None:
        return None
    if not _sentence_contains_effect_measure(sentence, measure):
        return None
    if not _claim_sentence_is_primary_effect_context(sentence):
        return None
    if not _sentence_contains_measure_value(sentence, measure):
        return None
    has_effect = _float_present_in_text(sentence, effect)
    expects_ci = "CI" in sentence or "置信区间" in sentence or "95%" in sentence
    has_ci = True
    if expects_ci and ci_lower is not None and ci_upper is not None:
        has_ci = _float_present_in_text(sentence, ci_lower) and _float_present_in_text(sentence, ci_upper)
    supported = has_effect and has_ci
    expected = _claim_support_expected_effect_label(measure, effect, ci_lower, ci_upper)
    return {
        "claim_type": "primary_effect",
        "status": "supported" if supported else "unsupported",
        "sentence": sentence,
        "support_source": "manuscript_facts.primary_effect",
        "expected": expected,
        "reason": (
            f"matches expected {expected}"
            if supported else
            f"unsupported primary-effect claim; expected {expected}"
        ),
    }


def _claim_support_grade_certainty_claim(sentence: str, grade: dict[str, Any]) -> dict[str, Any] | None:
    lowered = sentence.lower()
    if "robis" in lowered and "certainty" not in lowered and "确定性" not in sentence:
        return None
    if not _claim_sentence_mentions_certainty(sentence):
        return None
    if not _sentence_contains_any_certainty_rating(sentence):
        return None
    outcomes = grade.get("outcomes") if isinstance(grade.get("outcomes"), list) else []
    certainty = ""
    for outcome in outcomes:
        if isinstance(outcome, dict) and outcome.get("certainty"):
            certainty = str(outcome.get("certainty") or "").strip()
            break
    if not certainty:
        return None
    supported = _sentence_contains_certainty(sentence, certainty) or _sentence_contains_compatible_certainty_floor(sentence, certainty)
    return {
        "claim_type": "grade_certainty",
        "status": "supported" if supported else "unsupported",
        "sentence": sentence,
        "support_source": "manuscript_facts.grade",
        "expected": certainty,
        "reason": (
            f"matches expected GRADE certainty {certainty}"
            if supported else
            f"unsupported GRADE certainty claim; expected {certainty}"
        ),
    }


def _claim_support_expected_effect_label(measure: str, effect: float, ci_lower: float | None, ci_upper: float | None) -> str:
    label = f"{measure} {_format_claim_number(effect)}"
    if ci_lower is not None and ci_upper is not None:
        label += f" (95% CI {_format_claim_number(ci_lower)} to {_format_claim_number(ci_upper)})"
    return label


def _sentence_contains_effect_measure(sentence: str, measure: str) -> bool:
    if not measure:
        return False
    return bool(re.search(rf"(?<![A-Za-z]){re.escape(measure)}(?![A-Za-z])", sentence, flags=re.I))


def _sentence_contains_measure_value(sentence: str, measure: str) -> bool:
    if not measure:
        return False
    return bool(
        re.search(
            rf"(?<![A-Za-z]){re.escape(measure)}(?![A-Za-z])[^0-9]{{0,20}}\d+\.\d+",
            sentence,
            flags=re.I,
        )
    )


def _claim_sentence_is_primary_effect_context(sentence: str) -> bool:
    lowered = sentence.lower()
    return _contains_any(lowered, ["pooled", "primary", "meta-analysis", "metaanalysis"]) or _contains_any(
        sentence,
        ["合并", "主要", "Meta分析", "荟萃分析"],
    )


def _format_claim_number(value: float) -> str:
    return f"{float(value):.2f}".rstrip("0").rstrip(".") if value is not None else ""


def _contains_any(text: str, needles: list[str]) -> bool:
    return any(needle in text for needle in needles)


def _claim_sentence_mentions_certainty(sentence: str) -> bool:
    lowered = sentence.lower()
    if "certainty" in lowered or "确定性" in sentence or "证据质量" in sentence:
        return True
    # ``GRADE domain`` and ``downgrade`` describe domain-level judgments; they
    # are not statements of the overall certainty rating. Requiring a bounded
    # GRADE token plus explicit certainty/evidence language prevents RoB labels
    # such as "two studies at low risk" from being misread as low certainty.
    return bool(
        re.search(r"\bGRADE\b", sentence, flags=re.I)
        and re.search(r"\b(?:certainty|quality\s+of\s+evidence|evidence\s+(?:is|was|rated))\b", sentence, flags=re.I)
    )


def _sentence_contains_any_certainty_rating(sentence: str) -> bool:
    lowered = sentence.lower()
    if re.search(r"\b(?:very low|low|moderate|high)\b", lowered):
        return True
    rating_phrases = [
        "确定性为高",
        "确定性评为高",
        "高确定性",
        "高质量",
        "确定性为中等",
        "确定性评为中等",
        "中等确定性",
        "中等质量",
        "确定性为低",
        "确定性评为低",
        "低确定性",
        "低质量",
        "确定性为极低",
        "确定性评为极低",
        "极低确定性",
        "极低质量",
        "很低确定性",
    ]
    return any(phrase in sentence for phrase in rating_phrases)


def _sentence_contains_certainty(sentence: str, certainty: str) -> bool:
    lowered = sentence.lower()
    normalized = certainty.strip().lower()
    if normalized and normalized in lowered:
        return True
    zh_terms = {
        "high": ["高确定性", "确定性为高", "确定性评为高", "高质量"],
        "moderate": ["中等确定性", "确定性为中等", "确定性评为中等", "中等质量"],
        "low": ["低确定性", "确定性为低", "确定性评为低", "低质量"],
        "very low": ["极低确定性", "很低确定性", "确定性为极低", "确定性评为极低", "极低质量"],
    }
    return any(term in sentence for term in zh_terms.get(normalized, []))


def _sentence_contains_compatible_certainty_floor(sentence: str, certainty: str) -> bool:
    """Accept cautious non-high certainty wording when the actual GRADE rating is below high."""
    normalized = certainty.strip().lower()
    if normalized not in {"moderate", "low", "very low"}:
        return False
    lowered = sentence.lower()
    english_non_high = re.search(r"\b(?:less|lower)\s+than\s+high\b|\bbelow\s+high\b|\bnot\s+high\b", lowered)
    chinese_non_high = any(
        phrase in sentence
        for phrase in (
            "低于高确定性",
            "不是高确定性",
            "未达到高确定性",
            "低于高质量",
            "未达到高质量",
        )
    )
    return bool(english_non_high or chinese_non_high)


def _primary_result_expected_fields(summary: dict[str, Any]) -> list[dict[str, Any]]:
    fields: list[dict[str, Any]] = []
    for key, label, kind in (
        ("pooled_effect", "Pooled effect", "float"),
        ("ci_lower", "Lower confidence limit", "float"),
        ("ci_upper", "Upper confidence limit", "float"),
        ("n_studies", "Primary-analysis study count", "int"),
        ("aggregate_events_intervention", "Intervention events", "int"),
        ("aggregate_total_intervention", "Intervention total", "int"),
        ("aggregate_events_control", "Control events", "int"),
        ("aggregate_total_control", "Control total", "int"),
    ):
        value = summary.get(key)
        if value is None:
            continue
        fields.append({
            "field": key,
            "label": label,
            "expected": value,
            "kind": kind,
        })
    total_i = _integer_or_none(summary.get("aggregate_total_intervention"))
    total_c = _integer_or_none(summary.get("aggregate_total_control"))
    if total_i is not None and total_c is not None:
        fields.append({
            "field": "total_participants",
            "label": "Total participants",
            "expected": total_i + total_c,
            "kind": "int",
        })
    return fields


def _primary_result_field_present(text: str, field: dict[str, Any]) -> bool:
    value = field.get("expected")
    if field.get("kind") == "int":
        expected = _integer_or_none(value)
        return expected is not None and _integer_present_in_text(text, expected)
    expected_number = _number_or_none(value)
    return expected_number is not None and _float_present_in_text(text, expected_number)


def _integer_present_in_text(text: str, expected: int) -> bool:
    raw = str(text or "")
    plain = str(expected)
    comma = f"{expected:,}"
    return bool(re.search(rf"(?<![\d.])(?:{re.escape(plain)}|{re.escape(comma)})(?![\d.])", raw))


def _float_present_in_text(text: str, expected: float) -> bool:
    numbers = _numbers_from_text(text)
    tolerances = [0.005, 0.0005, 0.000001]
    for number in numbers:
        if any(abs(number - round(expected, digits)) <= tolerance for digits, tolerance in ((2, tolerances[0]), (3, tolerances[1]), (6, tolerances[2]))):
            return True
    return False


def _numbers_from_text(text: str) -> list[float]:
    values: list[float] = []
    for match in re.finditer(r"(?<![A-Za-z])[-+]?\d[\d,]*(?:\.\d+)?", str(text or "")):
        try:
            values.append(float(match.group(0).replace(",", "")))
        except ValueError:
            continue
    return values


def _parse_bibtex_entries(text: str) -> list[dict[str, Any]]:
    matches = list(re.finditer(r"@(?P<type>\w+)\s*\{\s*(?P<key>[^,\s]+)\s*,", str(text or "")))
    entries: list[dict[str, Any]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        raw = text[match.end():end]
        fields = {
            field_match.group(1).lower(): " ".join(field_match.group(2).split())
            for field_match in re.finditer(r"(\w+)\s*=\s*\{(.*?)\}\s*,?", raw, flags=re.S)
        }
        authors = _bibtex_author_list(fields.get("author") or "")
        entry = {
            "key": match.group("key"),
            "entry_type": match.group("type").lower(),
            "title": fields.get("title") or "",
            "journal": fields.get("journal") or "",
            "year": fields.get("year") or "",
            "doi": fields.get("doi") or "",
            "pmid": fields.get("pmid") or "",
            "url": fields.get("url") or "",
            "volume": fields.get("volume") or "",
            "issue": fields.get("issue") or "",
            "pages": fields.get("pages") or fields.get("page") or "",
            "author_count": len(authors),
            "source_type": _reference_source_type(fields),
        }
        entries.append(entry)
    return entries


def _bibtex_author_list(author_field: str) -> list[str]:
    if not author_field:
        return []
    return [
        author.strip()
        for author in re.split(r"\s+and\s+", author_field)
        if author.strip()
    ]


def _reference_source_type(fields: dict[str, str]) -> str:
    haystack = " ".join(
        str(fields.get(key) or "").lower()
        for key in ("title", "journal", "url", "author")
    )
    if (
        "clinicaltrials.gov" in haystack
        or "clinical trials register" in haystack
        or "eudract" in haystack
        or "smartpatients.com/trials" in haystack
        or "registry mirror" in haystack
    ):
        return "trial_registry"
    if "covid-nma" in haystack or "living_data" in haystack:
        return "evidence_registry"
    if "medrxiv" in haystack or "biorxiv" in haystack:
        return "preprint"
    if (
        fields.get("url")
        and not (fields.get("doi") or fields.get("pmid"))
        and re.search(r"\b(?:handbook|manual|guidance|guideline)\b", haystack, flags=re.I)
    ):
        return "methods_handbook"
    if fields.get("journal") or fields.get("doi") or fields.get("pmid"):
        return "journal_article"
    if fields.get("url"):
        return "web_source"
    return "unknown"


def _calculation_source_rows(project: Project, facts: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    readiness = facts.get("evidence_readiness") if isinstance(facts, dict) else {}
    selected = (readiness or {}).get("selected_primary_rows") if isinstance(readiness, dict) else []
    if isinstance(selected, list):
        rows.extend(row for row in selected if isinstance(row, dict))

    extraction = project.load_json("extraction_audit.json", subdir="extraction")
    extraction_rows = extraction.get("rows") if isinstance(extraction, dict) else []
    if isinstance(extraction_rows, list):
        known_ids = {str(row.get("row_id") or "") for row in rows}
        for row in extraction_rows:
            if not isinstance(row, dict):
                continue
            row_id = str(row.get("row_id") or "")
            if row_id and row_id in known_ids:
                continue
            rows.append(row)

    method_audit = project.load_json("method_input_audit.json", subdir="analysis")
    method_inputs = method_audit.get("inputs") if isinstance(method_audit, dict) else []
    known_ids = {str(row.get("row_id") or "") for row in rows}
    for item in method_inputs or []:
        if not isinstance(item, dict):
            continue
        row_id = str(item.get("result_id") or "")
        if not row_id or row_id in known_ids:
            continue
        derivation = item.get("derivation") if isinstance(item.get("derivation"), dict) else {}
        locators = [loc for loc in item.get("source_locators") or [] if isinstance(loc, dict)]
        locator = next((loc for loc in locators if loc.get("quote_verified") is True), locators[0] if locators else {})
        rows.append({
            "row_id": row_id,
            "study_id": item.get("study_id") or "",
            "study_label": item.get("study_label") or item.get("study_id") or "",
            "outcome_name": item.get("outcome_id") or "",
            "raw_data": item.get("raw_data") or {},
            "events_intervention": derivation.get("events_intervention"),
            "total_intervention": derivation.get("total_intervention"),
            "events_control": derivation.get("events_control"),
            "total_control": derivation.get("total_control"),
            "source_location": locator.get("table") or locator.get("section") or "",
            "source_page": locator.get("page"),
            "source_section": locator.get("section") or "",
            "source_quote": locator.get("quote") or "",
            "source_quote_verified": locator.get("quote_verified"),
        })
        known_ids.add(row_id)
    return rows


def _normalized_study_key(value: Any) -> str:
    return str(value or "").strip().lower().split(":", 1)[-1]


def _match_calculation_source_row(study: dict[str, Any], source_rows: list[dict[str, Any]]) -> dict[str, Any]:
    study_id = _normalized_study_key(study.get("study_id"))
    study_label = str(study.get("study_label") or "").lower()
    for row in source_rows:
        if study_id and _normalized_study_key(row.get("study_id")) == study_id:
            return row
    for row in source_rows:
        label = str(row.get("study_label") or "").lower()
        if study_label and label and study_label == label:
            return row
    return {}


def _calculation_aggregate_counts(rows: list[dict[str, Any]]) -> dict[str, int | None]:
    fields = ("events_intervention", "total_intervention", "events_control", "total_control")
    if not rows or not all(row.get(field) is not None for row in rows for field in fields):
        return {
            "aggregate_events_intervention": None,
            "aggregate_total_intervention": None,
            "aggregate_events_control": None,
            "aggregate_total_control": None,
        }
    return {
        "aggregate_events_intervention": sum(int(row["events_intervention"]) for row in rows),
        "aggregate_total_intervention": sum(int(row["total_intervention"]) for row in rows),
        "aggregate_events_control": sum(int(row["events_control"]) for row in rows),
        "aggregate_total_control": sum(int(row["total_control"]) for row in rows),
    }


def _calculation_formulas(effect_measure: str) -> dict[str, dict[str, str]]:
    formulas = {
        "OR": {
            "effect": "log((events_intervention / survivors_intervention) / (events_control / survivors_control))",
            "variance": "1/events_intervention + 1/survivors_intervention + 1/events_control + 1/survivors_control",
            "reporting": "exp(log OR) for the displayed odds ratio and confidence interval",
        },
        "RR": {
            "effect": "log((events_intervention / total_intervention) / (events_control / total_control))",
            "variance": "1/events_intervention - 1/total_intervention + 1/events_control - 1/total_control",
            "reporting": "exp(log RR) for the displayed risk ratio and confidence interval",
        },
        "HR": {
            "effect": "log(reported hazard ratio)",
            "variance": "((log(upper_ci) - log(lower_ci)) / (2 * 1.96))^2 when reconstructed from a 95% CI",
            "reporting": "exp(log HR) for the displayed hazard ratio and confidence interval",
        },
    }
    return {
        "selected": formulas.get(effect_measure, {
            "effect": "study-level effect estimate on the analysis scale",
            "variance": "study-level variance from extracted standard error",
            "reporting": "reported on the protocol-specified effect scale",
        }),
        **formulas,
    }


def _effect_to_original(value: float | None, effect_measure: str) -> float | None:
    if value is None:
        return None
    if effect_measure in {"OR", "RR", "HR", "IRR"}:
        return math.exp(value)
    return value


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


def _rounded(value: float | None, digits: int = 6) -> float | None:
    return round(value, digits) if value is not None else None


def _build_submission_readiness_review(
    project: Project,
    *,
    pdf_intake_review: dict | None,
    text_source_coverage: dict | None,
    evidence_review: dict | None,
    abstract_audit: dict | None,
    publication_tone_audit: dict | None,
    readability_audit: dict | None,
    clinical_interpretation_audit: dict | None,
    reference_audit: dict | None,
    citation_audit: dict | None,
    prisma_audit: dict | None,
    search_strategy_audit: dict | None,
    figure_audit: dict | None,
    figure_legend_audit: dict | None,
    cross_reference_audit: dict | None,
    table_footnote_audit: dict | None,
    llm_reliability_audit: dict | None,
    risk_of_bias_completeness: dict | None,
    calculation_audit: dict | None,
    primary_source_trace: dict | None,
    primary_result_audit: dict | None,
    claim_support_audit: dict | None,
    benchmark_review: dict | None,
    publication_similarity: dict | None = None,
) -> dict | None:
    return _build_submission_readiness_review_impl(
        project,
        manuscript=_manuscript_manifest_summary(project),
        manuscript_polish_audit=_build_manuscript_polish_audit_review(project),
        pdf_intake_review=pdf_intake_review,
        text_source_coverage=text_source_coverage,
        evidence_review=evidence_review,
        abstract_audit=abstract_audit,
        publication_tone_audit=publication_tone_audit,
        readability_audit=readability_audit,
        clinical_interpretation_audit=clinical_interpretation_audit,
        reference_audit=reference_audit,
        citation_audit=citation_audit,
        prisma_audit=prisma_audit,
        search_strategy_audit=search_strategy_audit,
        figure_audit=figure_audit,
        figure_legend_audit=figure_legend_audit,
        cross_reference_audit=cross_reference_audit,
        table_footnote_audit=table_footnote_audit,
        llm_reliability_audit=llm_reliability_audit,
        risk_of_bias_completeness=risk_of_bias_completeness,
        calculation_audit=calculation_audit,
        primary_source_trace=primary_source_trace,
        primary_result_audit=primary_result_audit,
        claim_support_audit=claim_support_audit,
        benchmark_review=benchmark_review,
        publication_similarity=publication_similarity,
    )



def _build_llm_reliability_audit_review(project: Project) -> dict | None:
    usage = project.load_json("llm_usage_manifest.json")
    if not isinstance(usage, dict):
        return None
    events = [event for event in usage.get("events") or [] if isinstance(event, dict)]
    if not events:
        return {
            "schema_version": 1,
            "status": "ready",
            "passed": True,
            "summary": {
                "total_events": 0,
                "retryable_output_issues": 0,
                "near_truncation_events": 0,
                "warning_issues": 0,
                "failed_issues": 0,
            },
            "events": [],
            "issues": [],
        }

    issues: list[dict[str, Any]] = []
    reviewed_events: list[dict[str, Any]] = []
    for index, event in enumerate(events, start=1):
        retryable = str(event.get("retryable_output_issue") or "").strip()
        near_truncation = bool(event.get("near_truncation"))
        reviewed = {
            "index": index,
            "timestamp": event.get("timestamp") or "",
            "model": event.get("model") or "",
            "endpoint": event.get("endpoint") or "",
            "finish_reason": event.get("finish_reason") or "",
            "retryable_output_issue": retryable,
            "near_truncation": near_truncation,
            "prompt_tokens": event.get("prompt_tokens", 0),
            "completion_tokens": event.get("completion_tokens", 0),
            "total_tokens": event.get("total_tokens", 0),
            "max_tokens": event.get("max_tokens", 0),
            "error_type": event.get("error_type") or "",
            "error_message": event.get("error_message") or "",
        }
        reviewed_events.append(reviewed)
        if retryable:
            issues.append({
                "code": "llm_retryable_output_issue",
                "severity": "warning",
                "event_index": index,
                "model": reviewed["model"],
                "endpoint": reviewed["endpoint"],
                "message": _llm_retryable_issue_message(retryable),
            })
        if near_truncation:
            issues.append({
                "code": "llm_near_truncation",
                "severity": "warning",
                "event_index": index,
                "model": reviewed["model"],
                "endpoint": reviewed["endpoint"],
                "message": (
                    "LLM completion used at least 95% of the requested token budget; "
                    "review the generated section for possible truncation."
                ),
            })

    warning_issues = sum(1 for issue in issues if issue.get("severity") == "warning")
    failed_issues = sum(1 for issue in issues if issue.get("severity") == "fail")
    return {
        "schema_version": 1,
        "status": "ready_with_warnings" if warning_issues else "ready",
        "passed": failed_issues == 0,
        "summary": {
            "total_events": len(reviewed_events),
            "retryable_output_issues": sum(1 for event in reviewed_events if event.get("retryable_output_issue")),
            "near_truncation_events": sum(1 for event in reviewed_events if event.get("near_truncation")),
            "warning_issues": warning_issues,
            "failed_issues": failed_issues,
        },
        "events": reviewed_events,
        "issues": issues,
    }


def _llm_retryable_issue_message(issue: str) -> str:
    normalized = str(issue or "").strip().lower()
    if normalized == "truncated":
        return "LLM output was truncated and required retry or continuation."
    if normalized == "empty_response":
        return "LLM returned an empty response and required retry or fallback."
    if normalized == "status:incomplete":
        return "Responses incomplete status was returned and required retry with a larger token budget."
    if normalized.startswith("status:"):
        return f"Responses API returned {issue} and required retry or fallback."
    if normalized == "api_error":
        return "LLM provider/API call failed and required retry or fallback."
    return f"LLM returned retryable output issue '{issue}'."


def _build_benchmark_review(project: Project) -> dict | None:
    review = build_benchmark_review_payload(project)
    if not isinstance(review, dict):
        return None
    review = dict(review)
    review["language"] = _infer_project_review_language(project)
    return review
