"""Submission readiness gates and rendering for artifact packages."""
from __future__ import annotations

from html import escape
import re
from typing import Any

from new_meta.core.artifact_package_language import (
    html_lang as _html_lang,
    is_zh_review_language as _is_zh_review_language,
    normalize_review_language as _normalize_review_language,
)
from new_meta.core.project import Project
from new_meta.core.report_style import (
    data_table as _data_table,
    page_header as _page_header,
    panel as _panel,
    render_page as _render_page,
    stat_chip as _stat_chip,
)

_SUBMISSION_EXTRA_CSS = """    body { line-height: 1.5; }
    th, td { padding: 8px 6px; }
    .badge { border-radius: 999px; padding: 3px 9px; font-size: 12px; white-space: nowrap; border: 1px solid var(--line); background: var(--badge-bg); font-weight: 400; }
    .pass { color: var(--ok); border-color: var(--ok-line); background: var(--ok-bg); font-weight: 400; }
    .warn { color: var(--warn); border-color: var(--warn-line); background: var(--warn-bg); font-weight: 400; }
    .fail { color: var(--bad); border-color: var(--bad-line); background: var(--bad-bg); font-weight: 400; }"""


def _coerce_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _count_bib_entries(path) -> int:
    if not path.exists() or not path.is_file():
        return 0
    try:
        return len(re.findall(r"@\w+\s*\{", path.read_text(encoding="utf-8", errors="replace")))
    except OSError:
        return 0


def _review_language_from_text(text: str) -> str:
    raw = re.sub(r"```[\s\S]*?```", " ", str(text or ""))
    cjk_chars = len(re.findall(r"[\u4e00-\u9fff]", raw))
    latin_words = len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", raw))
    return "zh" if cjk_chars and cjk_chars >= latin_words else "en"


def build_submission_readiness_review(
    project: Project,
    *,
    manuscript: dict[str, Any],
    manuscript_polish_audit: dict | None,
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
    if not manuscript.get("included"):
        return None

    validation = project.load_json("manuscript_validation.json", subdir="manuscript")
    validation = validation if isinstance(validation, dict) else {}
    project_submission_gate = _project_submission_quality_gate(project)
    project_submission_status = str(project_submission_gate.get("status") or "").strip().lower()
    project_submission_failed = [
        item for item in (project_submission_gate.get("checks") or [])
        if isinstance(item, dict) and str(item.get("status") or "").strip().lower() == "fail"
    ]
    project_submission_warned = [
        item for item in (project_submission_gate.get("checks") or [])
        if isinstance(item, dict) and str(item.get("status") or "").strip().lower() == "warn"
    ]
    references_path = project.base_dir / "references.bib"
    search_query_path = project.base_dir / "search_query.txt"
    search_report_path = project.base_dir / "search_strategy_report.txt"
    figures_dir = project.base_dir / "figures"
    figure_files = sorted(figures_dir.glob("*.png")) if figures_dir.exists() else []
    draft_text = (project.base_dir / "manuscript" / "draft.md").read_text(
        encoding="utf-8",
        errors="replace",
    )
    readiness_language = _submission_readiness_language(manuscript, draft_text)

    evidence_summary = (evidence_review or {}).get("summary") or {}
    abstract_summary = (abstract_audit or {}).get("summary") or {}
    publication_tone_summary = (publication_tone_audit or {}).get("summary") or {}
    readability_summary = (readability_audit or {}).get("summary") or {}
    clinical_interpretation_summary = (clinical_interpretation_audit or {}).get("summary") or {}
    reference_summary = (reference_audit or {}).get("summary") or {}
    citation_summary = (citation_audit or {}).get("summary") or {}
    prisma_summary = (prisma_audit or {}).get("summary") or {}
    search_strategy_summary = (search_strategy_audit or {}).get("summary") or {}
    figure_summary = (figure_audit or {}).get("summary") or {}
    figure_legend_summary = (figure_legend_audit or {}).get("summary") or {}
    cross_reference_summary = (cross_reference_audit or {}).get("summary") or {}
    table_footnote_summary = (table_footnote_audit or {}).get("summary") or {}
    llm_reliability_summary = (llm_reliability_audit or {}).get("summary") or {}
    rob_completeness_summary = (risk_of_bias_completeness or {}).get("summary") or {}
    calculation_summary = (calculation_audit or {}).get("summary") or {}
    primary_source_trace_summary = (primary_source_trace or {}).get("summary") or {}
    primary_result_summary = (primary_result_audit or {}).get("summary") or {}
    claim_support_summary = (claim_support_audit or {}).get("summary") or {}
    benchmark_summary = (benchmark_review or {}).get("summary") or {}
    publication_similarity_summary = (publication_similarity or {}).get("summary") or {}
    text_source_summary = (text_source_coverage or {}).get("summary") or {}
    manuscript_polish_summary = (manuscript_polish_audit or {}).get("summary") or {}
    manuscript_polish_enabled = bool(manuscript_polish_summary.get("enabled"))
    manuscript_polish_fact_issues = int(manuscript_polish_summary.get("fact_guard_issues", 0) or 0)
    manuscript_polish_resolved_style_issues = int(manuscript_polish_summary.get("resolved_ai_style_issues", 0) or 0)
    manuscript_polish_remaining_style_issues = int(manuscript_polish_summary.get("remaining_ai_style_issues", 0) or 0)
    manuscript_polish_after_style_score = int(manuscript_polish_summary.get("after_ai_style_score", 0) or 0)
    manuscript_polish_proofreading_issues = int(manuscript_polish_summary.get("proofreading_issues", 0) or 0)
    manuscript_polish_proofreading_failed = bool(manuscript_polish_summary.get("proofreading_failed"))
    manuscript_polish_budget_exhausted = bool(manuscript_polish_summary.get("polish_budget_exhausted"))
    manuscript_polish_review_queue = (manuscript_polish_audit or {}).get("review_queue") or {}
    manuscript_polish_manual_review_items = int(manuscript_polish_review_queue.get("manual_review_items") or 0)
    manuscript_polish_next_actions = [] if not manuscript_polish_enabled else [
        str(action)
        for action in (manuscript_polish_review_queue.get("next_actions") or [])
        if str(action).strip()
    ]
    citation_required = bool(manuscript.get("requires_publication_length_gate"))
    citation_complete = (
        not citation_required
        or _citation_audit_is_complete(citation_summary)
    )
    citation_warning_issues = int(citation_summary.get("warning_issues", 0) or 0)
    evidence_warnings = (evidence_review or {}).get("warnings") or []
    submission_relevant_evidence_warnings = sum(
        1 for warning in evidence_warnings
        if _is_submission_relevant_evidence_warning(warning)
    )
    validation_counts = _manuscript_validation_issue_counts(validation)
    gates = [
        _submission_gate(
            "manuscript_formats",
            "Manuscript formats",
            all(manuscript.get(key) for key in ("markdown", "docx", "pdf")),
            f"Markdown={bool(manuscript.get('markdown'))}, DOCX={bool(manuscript.get('docx'))}, PDF={bool(manuscript.get('pdf'))}.",
        ),
        _submission_gate(
            "manuscript_validation",
            "Hard manuscript validation",
            validation.get("passed") is True,
            _manuscript_validation_gate_detail(validation, validation_counts),
        ),
        _submission_gate(
            "project_submission_quality_gate",
            "Project-level submission quality gate",
            project_submission_status == "pass",
            (
                f"status={project_submission_status or 'missing'}; "
                f"failed={len(project_submission_failed)}; "
                f"warnings={len(project_submission_warned)}; "
                f"failed_checks={', '.join(str(item.get('name') or '') for item in project_submission_failed[:8]) or 'none'}."
            ),
            warning=project_submission_status == "warn",
        ),
        _submission_gate(
            "manuscript_language",
            "Requested output language",
            bool(manuscript.get("language_matches_expected")),
            (
                f"expected={manuscript.get('expected_language') or 'not_recorded'}; "
                f"detected={manuscript.get('language') or 'unknown'}."
            ),
        ),
        _submission_gate(
            "manuscript_length",
            "Full-length manuscript",
            (
                not manuscript.get("requires_publication_length_gate")
                or bool(manuscript.get("has_publication_section_shape"))
            ),
            (
                f"Main text={manuscript.get('main_word_count', 0)} words; "
                f"minimum={manuscript.get('minimum_main_words', 0)}; "
                f"required={bool(manuscript.get('requires_publication_length_gate'))}; "
                f"section_shape={bool(manuscript.get('has_publication_section_shape'))}."
            ),
            warning=(
                bool(manuscript.get("requires_publication_length_gate"))
                and bool(manuscript.get("has_publication_section_shape"))
                and int(manuscript.get("main_word_count", 0) or 0) < int(manuscript.get("minimum_main_words", 0) or 0)
            ),
        ),
        _submission_gate(
            "abstract_polish",
            "Abstract polish",
            _abstract_audit_is_complete(abstract_summary),
            (
                f"abstract_present={bool(abstract_summary.get('abstract_present'))}; "
                f"word_count={abstract_summary.get('word_count', 0)}; "
                f"present_labels={abstract_summary.get('present_labels', 0)}/"
                f"{abstract_summary.get('required_labels', 0)}; "
                f"forbidden_phrases={abstract_summary.get('forbidden_phrase_count', 0)}; "
                f"failed_issues={abstract_summary.get('failed_issues', 0)}."
            ),
        ),
        _submission_gate(
            "publication_tone",
            "Publication tone",
            _publication_tone_audit_is_complete(publication_tone_summary),
            (
                f"scanned_words={publication_tone_summary.get('scanned_word_count', 0)}; "
                f"forbidden_phrases={publication_tone_summary.get('forbidden_phrase_count', 0)}; "
                f"failed_issues={publication_tone_summary.get('failed_issues', 0)}."
            ),
        ),
        _submission_gate(
            "readability",
            "Readability",
            _readability_audit_is_complete(readability_summary),
            (
                f"scanned_sections={readability_summary.get('scanned_sections', 0)}; "
                f"scanned_words={readability_summary.get('scanned_word_count', 0)}; "
                f"verbose_pico_fragments={readability_summary.get('verbose_pico_fragments', 0)}; "
                f"overlong_sentences={readability_summary.get('overlong_sentences', 0)}; "
                f"failed_issues={readability_summary.get('failed_issues', 0)}."
            ),
        ),
        _submission_gate(
            "clinical_interpretation",
            "Clinical interpretation depth",
            _clinical_interpretation_audit_is_complete(clinical_interpretation_summary),
            (
                f"covered_domains={clinical_interpretation_summary.get('covered_domains', 0)}/"
                f"{clinical_interpretation_summary.get('domain_count', 0)}; "
                f"minimum={clinical_interpretation_summary.get('minimum_domains', 0)}; "
                f"result_context={bool(clinical_interpretation_summary.get('result_context_present'))}; "
                f"discussion_paragraphs={clinical_interpretation_summary.get('discussion_paragraph_count', 0)}/"
                f"{clinical_interpretation_summary.get('maximum_discussion_paragraphs', 0)}; "
                f"process_framing={clinical_interpretation_summary.get('process_framing_paragraphs', 0)}; "
                f"redundant_domains={clinical_interpretation_summary.get('redundant_domain_count', 0)}; "
                f"missing_domains={','.join(clinical_interpretation_summary.get('missing_domains', []) or [])}; "
                f"failed_issues={clinical_interpretation_summary.get('failed_issues', 0)}."
            ),
        ),
        _submission_gate(
            "manuscript_polish",
            "Manuscript polish guard",
            True,
            (
                "No manuscript polish audit was available."
                if manuscript_polish_audit is None else
                f"enabled={manuscript_polish_enabled}; "
                f"accepted_chunks={manuscript_polish_summary.get('accepted_chunks', 0)}; "
                f"rejected_chunks={manuscript_polish_summary.get('rejected_chunks', 0)}; "
                f"accepted_edits={manuscript_polish_summary.get('accepted_edit_count', 0)}; "
                f"scope={manuscript_polish_summary.get('rewrite_scope') or ''}; "
                f"targeted_chunks={manuscript_polish_summary.get('targeted_chunks', 0)}; "
                f"non_target_chunks={manuscript_polish_summary.get('non_target_chunks', 0)}; "
                f"rewrite_retries={manuscript_polish_summary.get('rewrite_retries', 0)}; "
                f"retry_recovered_chunks={manuscript_polish_summary.get('retry_recovered_chunks', 0)}; "
                f"fact_guard_issues={manuscript_polish_summary.get('fact_guard_issues', 0)}; "
                f"budget_exhausted={bool(manuscript_polish_summary.get('polish_budget_exhausted'))}; "
                f"before_style_score={manuscript_polish_summary.get('before_ai_style_score', 0)}; "
                f"after_style_score={manuscript_polish_summary.get('after_ai_style_score', 0)}; "
                f"resolved_style_issues={manuscript_polish_summary.get('resolved_ai_style_issues', 0)}; "
                f"remaining_style_issues={manuscript_polish_summary.get('remaining_ai_style_issues', 0)}; "
                f"proofreading_issues={manuscript_polish_summary.get('proofreading_issues', 0)}; "
                f"proofreading_failed={bool(manuscript_polish_summary.get('proofreading_failed'))}; "
                f"review_queue_status={manuscript_polish_review_queue.get('status') or ''}; "
                f"manual_review_items={manuscript_polish_manual_review_items}."
            ),
            warning=(
                manuscript_polish_audit is not None
                and manuscript_polish_enabled
                and (
                    manuscript_polish_manual_review_items > 0
                    or
                    manuscript_polish_budget_exhausted
                    or (
                        manuscript_polish_remaining_style_issues > 0
                        and manuscript_polish_after_style_score >= 2
                    )
                    or manuscript_polish_proofreading_issues > 0
                    or manuscript_polish_proofreading_failed
                )
            ),
            next_actions=manuscript_polish_next_actions,
        ),
        _submission_gate(
            "manuscript_content",
            "Core article content",
            (
                not manuscript.get("requires_publication_length_gate")
                or (
                    bool(manuscript.get("has_search_query_in_manuscript"))
                    and bool(manuscript.get("has_calculation_detail"))
                    and int(manuscript.get("table_count", 0) or 0) >= 1
                    and int(manuscript.get("figure_count", 0) or 0) >= 1
                    and int(manuscript.get("reference_count", 0) or 0) >= 1
                )
            ),
            (
                f"search_query={bool(manuscript.get('has_search_query_in_manuscript'))}; "
                f"calculation_detail={bool(manuscript.get('has_calculation_detail'))}; "
                f"tables={manuscript.get('table_count', 0)}; "
                f"figures={manuscript.get('figure_count', 0)}; "
                f"references={manuscript.get('reference_count', 0)}; "
                f"required={bool(manuscript.get('requires_publication_length_gate'))}."
            ),
        ),
        _submission_gate(
            "evidence_readiness",
            "Evidence readiness",
            (
                str((evidence_review or {}).get("status") or "").strip().lower() in {"ready", "needs_review"}
                and int(evidence_summary.get("blockers", 0) or 0) == 0
                and submission_relevant_evidence_warnings == 0
            ),
            (
                f"Status={(evidence_review or {}).get('status')}; blockers={evidence_summary.get('blockers', 0)}; "
                f"warnings={evidence_summary.get('warnings', 0)}; "
                f"submission-relevant warnings={submission_relevant_evidence_warnings}."
            ),
            warning=submission_relevant_evidence_warnings > 0,
        ),
        _submission_gate(
            "primary_source_context",
            "Primary-analysis source context",
            float(evidence_summary.get("selected_primary_source_context_coverage", 0) or 0) >= 1.0
            and int(evidence_summary.get("selected_primary_source_cards", 0) or 0) > 0,
            (
                f"{evidence_summary.get('selected_primary_source_context_available_cards', 0)}/"
                f"{evidence_summary.get('selected_primary_source_cards', 0)} primary source card(s) have source context."
            ),
        ),
        _submission_gate(
            "source_coverage",
            "Text-source coverage",
            True,
            (
                "No text-source coverage audit was available."
                if text_source_coverage is None else
                f"total source records={text_source_summary.get('total_records', 0)}; "
                f"full-text={text_source_summary.get('full_text_records', 0)}; "
                f"abstract-only={text_source_summary.get('abstract_only_records', 0)}; "
                f"metadata-only={text_source_summary.get('metadata_only_records', 0)}; "
                f"registry-only={text_source_summary.get('registry_only_records', 0)}; "
                f"unknown={text_source_summary.get('unknown_records', 0)}; "
                f"limited source record(s)={text_source_summary.get('limited_source_records', 0)}; "
                f"action-required limited source record(s)={text_source_summary.get('action_required_limited_records', 0)}; "
                f"screening-only limited source record(s)={text_source_summary.get('screening_only_limited_records', 0)}; "
                f"records requiring review={text_source_summary.get('records_requiring_review', 0)}."
            ),
            warning=(
                text_source_coverage is not None
                and int(text_source_summary.get("action_required_limited_records", 0) or 0) > 0
            ),
        ),
        _submission_gate(
            "calculation_audit",
            "Trial-level calculation audit",
            (
                not manuscript.get("requires_publication_length_gate")
                or _calculation_audit_is_complete(calculation_summary)
            ),
            (
                f"required={bool(manuscript.get('requires_publication_length_gate'))}; "
                f"rows={calculation_summary.get('row_count', 0)}; "
                f"n_studies={calculation_summary.get('n_studies', 0)}; "
                f"source_rows_matched={calculation_summary.get('source_rows_matched', 0)}; "
                f"source_quote_verified={calculation_summary.get('source_quote_verified_rows', 0)}/"
                f"{calculation_summary.get('row_count', 0)}; "
                f"formula_inputs_complete={calculation_summary.get('formula_inputs_complete_rows', 0)}/"
                f"{calculation_summary.get('row_count', 0)}."
            ),
        ),
        _submission_gate(
            "primary_source_trace",
            "Primary result source trace",
            (
                not manuscript.get("requires_publication_length_gate")
                or _primary_source_trace_is_complete(primary_source_trace_summary)
            ),
            (
                f"required={bool(manuscript.get('requires_publication_length_gate'))}; "
                f"traceable={primary_source_trace_summary.get('source_traceable_rows', 0)}/"
                f"{primary_source_trace_summary.get('row_count', 0)}; "
                f"missing_quote={primary_source_trace_summary.get('missing_source_quote_rows', 0)}; "
                f"missing_location={primary_source_trace_summary.get('missing_source_location_rows', 0)}; "
                f"unverified_quote={primary_source_trace_summary.get('unverified_source_quote_rows', 0)}; "
                f"failed_issues={primary_source_trace_summary.get('failed_issues', 0)}."
            ),
        ),
        _submission_gate(
            "primary_result",
            "Primary result consistency",
            (
                not manuscript.get("requires_publication_length_gate")
                or _primary_result_audit_is_complete(primary_result_summary)
            ),
            (
                f"expected_fields={primary_result_summary.get('expected_fields', 0)}; "
                f"matched_fields={primary_result_summary.get('matched_fields', 0)}; "
                f"mismatched_fields={primary_result_summary.get('mismatched_fields', 0)}; "
                f"failed_issues={primary_result_summary.get('failed_issues', 0)}."
            ),
        ),
        _submission_gate(
            "claim_support",
            "Manuscript claim support",
            (
                claim_support_audit is None
                or _claim_support_audit_is_complete(claim_support_summary)
            ),
            (
                "No manuscript claim support audit was available."
                if claim_support_audit is None else
                f"checked={claim_support_summary.get('checked_claims', 0)}; "
                f"supported={claim_support_summary.get('supported_claims', 0)}; "
                f"unsupported={claim_support_summary.get('unsupported_claims', 0)}; "
                f"failed_issues={claim_support_summary.get('failed_issues', 0)}."
            ),
        ),
        _submission_gate(
            "references",
            "References",
            (
                references_path.exists()
                and references_path.stat().st_size > 0
                and (
                    not manuscript.get("requires_publication_length_gate")
                    or _reference_audit_is_complete(reference_summary)
                )
            ),
            (
                f"{_count_bib_entries(references_path)} BibTeX reference entr"
                f"{'y' if _count_bib_entries(references_path) == 1 else 'ies'}; "
                f"manuscript references={reference_summary.get('manuscript_references', 0)}; "
                f"count_mismatch={bool(reference_summary.get('count_mismatch'))}; "
                f"missing_identifiers={reference_summary.get('entries_missing_identifier', 0)}; "
                f"missing_journal={reference_summary.get('entries_missing_journal', 0)}; "
                f"missing_volume_or_pages={reference_summary.get('entries_missing_volume_or_pages', 0)}."
            ),
        ),
        _submission_gate(
            "citation_coverage",
            "Main-text citation coverage",
            citation_complete,
            (
                f"required={citation_required}; "
                f"references={citation_summary.get('reference_entries', 0)}; "
                f"publication_min_references={citation_summary.get('publication_minimum_reference_entries', 0)}; "
                f"main_text_citations={citation_summary.get('main_text_inline_citations', 0)}; "
                f"Introduction={citation_summary.get('introduction_inline_citations', 0)}; "
                f"Introduction_background={citation_summary.get('introduction_background_inline_citations', 0)}/"
                f"{citation_summary.get('minimum_introduction_background_citations', 0)}; "
                f"Introduction_paragraphs={citation_summary.get('introduction_cited_substantial_paragraphs', 0)}/"
                f"{citation_summary.get('introduction_substantial_paragraphs', 0)}; "
                f"Methods={citation_summary.get('methods_inline_citations', 0)}; "
                f"Methods_methodology={citation_summary.get('methods_methodology_inline_citations', 0)}/"
                f"{citation_summary.get('minimum_methods_methodology_citations', 0)}; "
                f"Results={citation_summary.get('results_inline_citations', 0)}; "
                f"Discussion={citation_summary.get('discussion_inline_citations', 0)}; "
                f"Discussion_context={citation_summary.get('discussion_context_inline_citations', 0)}/"
                f"{citation_summary.get('minimum_discussion_context_citations', 0)}; "
                f"Discussion_paragraphs={citation_summary.get('discussion_cited_substantial_paragraphs', 0)}/"
                f"{citation_summary.get('discussion_substantial_paragraphs', 0)}; "
                f"uncited_discussion_results={citation_summary.get('uncited_discussion_result_claims', 0)}; "
                f"uncited_discussion_mechanisms={citation_summary.get('uncited_discussion_mechanism_claims', 0)}; "
                f"undefined={citation_summary.get('undefined_citation_numbers', 0)}; "
                f"failed_issues={citation_summary.get('failed_issues', 0)}; "
                f"warning_issues={citation_summary.get('warning_issues', 0)}; "
                f"density={citation_summary.get('citation_density_per_1000_words', 0)} per 1000 words."
            ),
            warning=citation_complete and citation_warning_issues > 0,
        ),
        _submission_gate(
            "search_strategy",
            "Search strategy",
            (
                (
                    search_query_path.exists()
                    and search_query_path.stat().st_size > 0
                )
                or (search_report_path.exists() and search_report_path.stat().st_size > 0)
            )
            and (
                not manuscript.get("requires_publication_length_gate")
                or _search_strategy_audit_is_complete(search_strategy_summary)
            ),
            (
                "search_query.txt and/or search_strategy_report.txt included; "
                f"exact_query_reproduced={bool(search_strategy_summary.get('exact_query_reproduced'))}; "
                f"query_chars={search_strategy_summary.get('query_chars', 0)}; "
                f"failed_issues={search_strategy_summary.get('failed_issues', 0)}."
            ),
        ),
        _submission_gate(
            "prisma_flow",
            "PRISMA flow consistency",
            (
                not manuscript.get("requires_publication_length_gate")
                or _prisma_audit_is_complete(prisma_summary)
            ),
            (
                f"expected_fields={prisma_summary.get('expected_fields', 0)}; "
                f"matched_fields={prisma_summary.get('matched_fields', 0)}; "
                f"mismatched_fields={prisma_summary.get('mismatched_fields', 0)}; "
                f"missing_fields={prisma_summary.get('missing_fields', 0)}; "
                f"logical_issues={prisma_summary.get('logical_issues', 0)}."
            ),
        ),
        _submission_gate(
            "declarations",
            "Declarations",
            _has_submission_declarations(draft_text),
            "Ethics, data/code availability, funding, and competing-interest statements are present.",
        ),
        _submission_gate(
            "figures",
            "Figures",
            bool(figure_files)
            and (
                not manuscript.get("requires_publication_length_gate")
                or _figure_audit_is_complete(figure_summary)
            ),
            (
                f"{len(figure_files)} PNG figure file(s) included; "
                f"referenced_images={figure_summary.get('referenced_images', 0)}; "
                f"missing_referenced_images={figure_summary.get('missing_referenced_images', 0)}; "
                f"failed_issues={figure_summary.get('failed_issues', 0)}."
            ),
        ),
        _submission_gate(
            "figure_legends",
            "Figure legends",
            (
                not manuscript.get("requires_publication_length_gate")
                or _figure_legend_audit_is_complete(figure_legend_summary)
            ),
            (
                f"required={bool(manuscript.get('requires_publication_length_gate'))}; "
                f"legends={figure_legend_summary.get('figures_with_legends', 0)}/"
                f"{figure_legend_summary.get('figure_count', 0)}; "
                f"missing_legends={figure_legend_summary.get('missing_legends', 0)}; "
                f"failed_issues={figure_legend_summary.get('failed_issues', 0)}."
            ),
        ),
        _submission_gate(
            "cross_references",
            "Table and figure cross-references",
            (
                not manuscript.get("requires_publication_length_gate")
                or _cross_reference_audit_is_complete(cross_reference_summary)
            ),
            (
                f"required={bool(manuscript.get('requires_publication_length_gate'))}; "
                f"tables={cross_reference_summary.get('main_text_referenced_tables', 0)}/"
                f"{cross_reference_summary.get('defined_tables', 0)}; "
                f"figures={cross_reference_summary.get('main_text_referenced_figures', 0)}/"
                f"{cross_reference_summary.get('defined_figures', 0)}; "
                f"unreferenced_tables={cross_reference_summary.get('unreferenced_tables', 0)}; "
                f"unreferenced_figures={cross_reference_summary.get('unreferenced_figures', 0)}; "
                f"undefined_refs={cross_reference_summary.get('undefined_table_references', 0) + cross_reference_summary.get('undefined_figure_references', 0)}; "
                f"failed_issues={cross_reference_summary.get('failed_issues', 0)}."
            ),
        ),
        _submission_gate(
            "table_footnotes",
            "Table footnotes",
            (
                not manuscript.get("requires_publication_length_gate")
                or _table_footnote_audit_is_complete(table_footnote_summary)
            ),
            (
                f"required={bool(manuscript.get('requires_publication_length_gate'))}; "
                f"notes={table_footnote_summary.get('tables_with_notes', 0)}/"
                f"{table_footnote_summary.get('table_count', 0)}; "
                f"missing_notes={table_footnote_summary.get('missing_notes', 0)}; "
                f"failed_issues={table_footnote_summary.get('failed_issues', 0)}."
            ),
        ),
        _submission_gate(
            "risk_of_bias_completeness",
            "Primary-study risk-of-bias completeness",
            (
                risk_of_bias_completeness is None
                or _risk_of_bias_completeness_is_complete(rob_completeness_summary)
            ),
            (
                "No primary meta-analysis RoB completeness audit was available."
                if risk_of_bias_completeness is None else
                f"primary_studies={rob_completeness_summary.get('primary_contributing_studies', 0)}; "
                f"formal_rob={rob_completeness_summary.get('formal_rob', 0)}; "
                f"missing_formal_rob={rob_completeness_summary.get('missing_formal_rob', 0)}; "
                f"synthetic_rob={rob_completeness_summary.get('synthetic_rob', 0)}; "
                f"incomplete_rob={rob_completeness_summary.get('incomplete_rob', 0)}; "
                f"failed_issues={rob_completeness_summary.get('failed_issues', 0)}. "
                "Every primary-analysis contributing study needs a formal risk-of-bias assessment."
            ),
        ),
        _submission_gate(
            "llm_reliability",
            "LLM output reliability",
            True,
            (
                "No LLM usage manifest was available."
                if llm_reliability_audit is None else
                f"calls={llm_reliability_summary.get('total_events', 0)}; "
                f"retryable_output_issues={llm_reliability_summary.get('retryable_output_issues', 0)}; "
                f"near_truncation_events={llm_reliability_summary.get('near_truncation_events', 0)}; "
                f"failed_issues={llm_reliability_summary.get('failed_issues', 0)}."
            ),
            warning=(
                llm_reliability_audit is not None
                and (
                    int(llm_reliability_summary.get("failed_issues", 0) or 0) > 0
                    or int(llm_reliability_summary.get("near_truncation_events", 0) or 0) > 0
                )
            ),
        ),
        _submission_gate(
            "benchmark",
            "Published benchmark comparison",
            benchmark_review is None or benchmark_review.get("passed") is True,
            (
                "No benchmark attached."
                if benchmark_review is None else
                f"Benchmark {benchmark_review.get('benchmark_id') or ''} status={benchmark_review.get('status')}; "
                f"failing gates={benchmark_summary.get('failing_gates', 0)}."
            ),
            warning=benchmark_review is None,
        ),
        _submission_gate(
            "publication_similarity",
            "Publication similarity",
            publication_similarity is None or publication_similarity.get("passed") is True,
            (
                "No publication similarity review was required."
                if publication_similarity is None else
                f"score={publication_similarity.get('similarity_score', 0)}%; "
                f"threshold={publication_similarity.get('threshold', 0)}%; "
                f"components={publication_similarity_summary.get('components_passing', 0)}/"
                f"{publication_similarity_summary.get('component_count', 0)}; "
                f"main_text={publication_similarity_summary.get('main_word_count', 0)} units."
            ),
            warning=publication_similarity is not None and publication_similarity.get("passed") is not True,
        ),
    ]

    failed = sum(1 for gate in gates if gate["status"] == "fail")
    warnings = sum(1 for gate in gates if gate["status"] == "warn")
    _localize_submission_gates(gates, readiness_language)
    if failed:
        status = "blocked"
    elif warnings:
        status = "ready_with_warnings"
    else:
        status = "ready"
    return {
        "schema_version": 1,
        "language": readiness_language,
        "status": status,
        "passed": failed == 0,
        "summary": {
            "total_gates": len(gates),
            "passed_gates": sum(1 for gate in gates if gate["status"] == "pass"),
            "warning_gates": warnings,
            "failed_gates": failed,
        },
        "manuscript": manuscript,
        "gates": gates,
    }


def _calculation_audit_is_complete(summary: dict[str, Any]) -> bool:
    if not isinstance(summary, dict) or not summary:
        return False
    row_count = _coerce_int(summary.get("row_count")) or 0
    n_studies = _coerce_int(summary.get("n_studies")) or 0
    matched = _coerce_int(summary.get("source_rows_matched")) or 0
    verified = _coerce_int(summary.get("source_quote_verified_rows")) or 0
    formula_complete = _coerce_int(summary.get("formula_inputs_complete_rows")) or 0
    if row_count <= 0 or matched != row_count:
        return False
    if verified != row_count:
        return False
    if summary.get("compiled_method") is True:
        if summary.get("compiled_method_integrity") is not True:
            return False
        if summary.get("execution_converged") is False:
            return False
    elif str(summary.get("effect_measure") or "").upper() in {"OR", "RR", "RD"} and formula_complete != row_count:
        return False
    if n_studies > 0 and row_count != n_studies:
        return False
    return True


def _primary_source_trace_is_complete(summary: dict[str, Any]) -> bool:
    if not isinstance(summary, dict) or not summary:
        return False
    row_count = _coerce_int(summary.get("row_count")) or 0
    traceable = _coerce_int(summary.get("source_traceable_rows")) or 0
    return row_count > 0 and traceable == row_count and _coerce_int(summary.get("failed_issues")) == 0


def _primary_result_audit_is_complete(summary: dict[str, Any]) -> bool:
    if not isinstance(summary, dict) or not summary:
        return False
    expected_fields = _coerce_int(summary.get("expected_fields"))
    matched_fields = _coerce_int(summary.get("matched_fields"))
    return expected_fields > 0 and matched_fields == expected_fields and _coerce_int(summary.get("failed_issues")) == 0


def _claim_support_audit_is_complete(summary: dict[str, Any]) -> bool:
    if not isinstance(summary, dict) or not summary:
        return True
    return _coerce_int(summary.get("unsupported_claims")) == 0 and _coerce_int(summary.get("failed_issues")) == 0


def _abstract_audit_is_complete(summary: dict[str, Any]) -> bool:
    if not isinstance(summary, dict) or not summary:
        return False
    return bool(summary.get("abstract_present")) and _coerce_int(summary.get("failed_issues")) == 0


def _publication_tone_audit_is_complete(summary: dict[str, Any]) -> bool:
    if not isinstance(summary, dict) or not summary:
        return False
    return _coerce_int(summary.get("failed_issues")) == 0


def _readability_audit_is_complete(summary: dict[str, Any]) -> bool:
    if not isinstance(summary, dict) or not summary:
        return False
    return _coerce_int(summary.get("failed_issues")) == 0


def _clinical_interpretation_audit_is_complete(summary: dict[str, Any]) -> bool:
    if not isinstance(summary, dict) or not summary:
        return False
    return (
        _coerce_int(summary.get("failed_issues")) == 0
        and bool(summary.get("result_context_present"))
        and _coerce_int(summary.get("covered_domains")) >= _coerce_int(summary.get("minimum_domains"))
    )


def _reference_audit_is_complete(summary: dict[str, Any]) -> bool:
    if not isinstance(summary, dict) or not summary:
        return False
    bib_entries = _coerce_int(summary.get("bib_entries"))
    manuscript_references = _coerce_int(summary.get("manuscript_references"))
    if bib_entries <= 0 or manuscript_references <= 0:
        return False
    return not bool(summary.get("count_mismatch")) and _coerce_int(summary.get("failed_issues")) == 0


def _citation_audit_is_complete(summary: dict[str, Any]) -> bool:
    if not isinstance(summary, dict) or not summary:
        return False
    if _coerce_int(summary.get("reference_entries")) <= 0:
        return False
    if _coerce_int(summary.get("main_text_inline_citations")) <= 0:
        return False
    if _coerce_int(summary.get("introduction_inline_citations")) <= 0:
        return False
    if _coerce_int(summary.get("methods_inline_citations")) <= 0:
        return False
    if _coerce_int(summary.get("results_inline_citations")) <= 0:
        return False
    if _coerce_int(summary.get("discussion_inline_citations")) <= 0:
        return False
    return _coerce_int(summary.get("failed_issues")) == 0


def _prisma_audit_is_complete(summary: dict[str, Any]) -> bool:
    if not isinstance(summary, dict) or not summary:
        return False
    expected_fields = _coerce_int(summary.get("expected_fields"))
    matched_fields = _coerce_int(summary.get("matched_fields"))
    if expected_fields <= 0 or matched_fields != expected_fields:
        return False
    return _coerce_int(summary.get("failed_issues")) == 0


def _search_strategy_audit_is_complete(summary: dict[str, Any]) -> bool:
    if not isinstance(summary, dict) or not summary:
        return False
    return (
        bool(summary.get("query_file_present"))
        and _coerce_int(summary.get("query_chars")) > 0
        and bool(summary.get("exact_query_reproduced"))
        and _coerce_int(summary.get("failed_issues")) == 0
    )


def _figure_audit_is_complete(summary: dict[str, Any]) -> bool:
    if not isinstance(summary, dict) or not summary:
        return False
    return (
        _coerce_int(summary.get("referenced_images")) > 0
        and _coerce_int(summary.get("packaged_png_files")) > 0
        and _coerce_int(summary.get("missing_referenced_images")) == 0
        and _coerce_int(summary.get("failed_issues")) == 0
    )


def _cross_reference_audit_is_complete(summary: dict[str, Any]) -> bool:
    if not isinstance(summary, dict) or not summary:
        return False
    defined_tables = _coerce_int(summary.get("defined_tables"))
    defined_figures = _coerce_int(summary.get("defined_figures"))
    referenced_tables = _coerce_int(summary.get("main_text_referenced_tables"))
    referenced_figures = _coerce_int(summary.get("main_text_referenced_figures"))
    if defined_tables > 0 and referenced_tables < defined_tables:
        return False
    if defined_figures > 0 and referenced_figures < defined_figures:
        return False
    return _coerce_int(summary.get("failed_issues")) == 0


def _figure_legend_audit_is_complete(summary: dict[str, Any]) -> bool:
    if not isinstance(summary, dict) or not summary:
        return False
    figure_count = _coerce_int(summary.get("figure_count"))
    if figure_count <= 0:
        return False
    return (
        _coerce_int(summary.get("figures_with_legends")) == figure_count
        and _coerce_int(summary.get("missing_legends")) == 0
        and _coerce_int(summary.get("failed_issues")) == 0
    )


def _table_footnote_audit_is_complete(summary: dict[str, Any]) -> bool:
    if not isinstance(summary, dict) or not summary:
        return False
    table_count = _coerce_int(summary.get("table_count"))
    if table_count <= 0:
        return False
    return (
        _coerce_int(summary.get("tables_with_notes")) == table_count
        and _coerce_int(summary.get("missing_notes")) == 0
        and _coerce_int(summary.get("failed_issues")) == 0
    )


def _risk_of_bias_completeness_is_complete(summary: dict[str, Any]) -> bool:
    if not isinstance(summary, dict) or not summary:
        return False
    primary_studies = _coerce_int(summary.get("primary_contributing_studies"))
    if primary_studies <= 0:
        return False
    return (
        _coerce_int(summary.get("formal_rob")) == primary_studies
        and _coerce_int(summary.get("missing_formal_rob")) == 0
        and _coerce_int(summary.get("synthetic_rob")) == 0
        and _coerce_int(summary.get("incomplete_rob")) == 0
        and _coerce_int(summary.get("failed_issues")) == 0
    )


def _manuscript_validation_issue_counts(validation: dict[str, Any]) -> dict[str, int]:
    issues = [issue for issue in (validation.get("issues") or []) if isinstance(issue, dict)]
    counts = {
        "total": len(issues),
        "blocking": 0,
        "warnings": 0,
        "fixed": 0,
        "info": 0,
    }
    for issue in issues:
        severity = str(issue.get("severity") or "").strip().lower()
        if severity in {"fixed", "resolved"}:
            counts["fixed"] += 1
        elif severity in {"warning", "warn"}:
            counts["warnings"] += 1
        elif severity in {"info", "note"}:
            counts["info"] += 1
        elif severity in {"fail", "failed", "error", "blocker"} or issue.get("action_required"):
            counts["blocking"] += 1
        elif severity:
            counts["warnings"] += 1
        else:
            counts["info"] += 1
    return counts


def _project_submission_quality_gate(project: Project) -> dict[str, Any]:
    gate = project.load_json("submission_quality_gate.json", subdir="manuscript")
    if not isinstance(gate, dict) or not gate:
        gate = project.load_json("quality_gate.json", subdir="manuscript")
    if isinstance(gate, dict) and gate:
        return gate
    return {
        "status": "fail",
        "failed_count": 1,
        "warning_count": 0,
        "checks": [
            {
                "name": "project_submission_quality_gate",
                "status": "fail",
                "message": "submission_quality_gate.json is missing.",
            }
        ],
    }


def _manuscript_validation_gate_detail(validation: dict[str, Any], counts: dict[str, int]) -> str:
    return (
        f"passed={bool(validation.get('passed') is True)}; "
        f"blocking={counts.get('blocking', 0)}; "
        f"warnings={counts.get('warnings', 0)}; "
        f"fixed={counts.get('fixed', 0)}; "
        f"info={counts.get('info', 0)}; "
        f"total={counts.get('total', 0)}."
    )


def _submission_gate(
    gate_id: str,
    label: str,
    passed: bool,
    detail: str,
    *,
    warning: bool = False,
    next_actions: list[str] | None = None,
) -> dict[str, Any]:
    status = "warn" if warning else "pass" if passed else "fail"
    gate = {
        "id": gate_id,
        "label": label,
        "status": status,
        "passed": status != "fail",
        "detail": detail,
    }
    if next_actions:
        gate["next_actions"] = [str(action) for action in next_actions if str(action).strip()]
    return gate


def _submission_readiness_language(manuscript: dict[str, Any], draft_text: str) -> str:
    for value in (
        manuscript.get("expected_language"),
        manuscript.get("language"),
        _review_language_from_text(draft_text),
    ):
        normalized = _normalize_review_language(value)
        if normalized:
            return normalized
    return "en"


def _localize_submission_gates(gates: list[dict[str, Any]], language: str) -> None:
    for gate in gates:
        gate["label_localized"] = _localized_submission_gate_label(
            str(gate.get("id") or ""),
            str(gate.get("label") or ""),
            language,
        )


def _localized_submission_gate_label(gate_id: str, fallback: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return fallback
    labels = {
        "manuscript_formats": "稿件格式",
        "manuscript_validation": "稿件硬校验",
        "project_submission_quality_gate": "项目级投稿质量闸",
        "manuscript_language": "输出语言",
        "manuscript_length": "正式稿长度",
        "abstract_polish": "摘要质量",
        "publication_tone": "投稿语气",
        "readability": "可读性",
        "manuscript_polish": "稿件润色保护闸",
        "manuscript_content": "核心正文内容",
        "evidence_readiness": "证据就绪性",
        "primary_source_context": "主要分析来源语境",
        "source_coverage": "文本来源覆盖",
        "calculation_audit": "研究层计算审计",
        "primary_source_trace": "主要结果溯源",
        "primary_result": "主要结果一致性",
        "claim_support": "正文结论支持",
        "references": "参考文献",
        "citation_coverage": "正文引用覆盖",
        "search_strategy": "检索策略",
        "prisma_flow": "PRISMA流程",
        "declarations": "声明",
        "figures": "图形文件",
        "figure_legends": "图注",
        "cross_references": "表图交叉引用",
        "table_footnotes": "表格脚注",
        "risk_of_bias_completeness": "主要研究偏倚风险完整性",
        "llm_reliability": "LLM输出可靠性",
        "benchmark": "已发表基准对照",
    }
    return labels.get(gate_id, fallback)


def _is_submission_relevant_evidence_warning(warning: Any) -> bool:
    if not isinstance(warning, dict):
        return True
    if warning.get("action_required") is False:
        return False
    scope = str(warning.get("scope") or "").strip()
    if scope in {"non_primary_records", "non_primary_rows", "background_records", "context_records"}:
        return False
    return True


def _has_submission_declarations(text: str) -> bool:
    lowered = text.lower()
    if "## declarations" in lowered:
        required = ["ethics", "data", "funding", "competing"]
        return all(item in lowered for item in required)
    if "## 声明" in text:
        required = ["伦理", "数据", "资助", "利益冲突"]
        return all(item in text for item in required)
    return False


def render_submission_readiness_html(review: dict) -> str:
    summary = review.get("summary") or {}
    manuscript = review.get("manuscript") or {}
    gates = review.get("gates") or []
    language = _normalize_review_language(review.get("language") or "")
    zh = _is_zh_review_language(language)
    gate_rows = "\n".join(_render_submission_gate_row(gate, language=language) for gate in gates)
    if not gate_rows:
        gate_rows = (
            '<tr><td colspan="5">未记录提交就绪性质量门。</td></tr>'
            if zh else
            '<tr><td colspan="5">No submission readiness gates were recorded.</td></tr>'
        )
    title = "MetaAgent 提交就绪性" if zh else "MetaAgent Submission Readiness"
    subtitle = "稿件交付前的包级质量门。" if zh else "Package-level quality gates for manuscript handoff."
    labels = {
        "status": "状态" if zh else "Status",
        "passed": "通过" if zh else "Passed",
        "passed_gates": "通过门" if zh else "Passed gates",
        "warnings": "警告" if zh else "Warnings",
        "failed": "失败" if zh else "Failed",
        "word_count": "词数" if zh else "Word count",
        "report_type": "报告类型" if zh else "Report type",
        "readiness_gates": "就绪性质量门" if zh else "Readiness Gates",
        "gate": "质量门" if zh else "Gate",
        "gate_status": "状态" if zh else "Status",
        "gate_passed": "是否通过" if zh else "Passed",
        "detail": "详情" if zh else "Detail",
        "next_actions": "下一步动作" if zh else "Next actions",
    }
    chips = [
        _stat_chip(labels["status"], _localized_submission_status(str(review.get("status") or "unknown"), language)),
        _stat_chip(labels["passed"], _localized_submission_bool(bool(review.get("passed")), language)),
        _stat_chip(labels["passed_gates"], summary.get("passed_gates", 0)),
        _stat_chip(labels["warnings"], summary.get("warning_gates", 0)),
        _stat_chip(labels["failed"], summary.get("failed_gates", 0)),
        _stat_chip(labels["word_count"], manuscript.get("word_count", 0)),
        _stat_chip(labels["report_type"], manuscript.get("report_type") or ""),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
{_panel(labels["readiness_gates"], _data_table([labels["gate"], labels["gate_status"], labels["gate_passed"], labels["detail"], labels["next_actions"]], gate_rows))}
  </main>"""
    return _render_page(title=title, body=body, lang=_html_lang(language), extra_css=_SUBMISSION_EXTRA_CSS)


def _render_submission_gate_row(gate: dict, *, language: str = "en") -> str:
    status = str(gate.get("status") or "unknown")
    css_class = status if status in {"pass", "warn", "fail"} else ""
    actions = [str(action) for action in (gate.get("next_actions") or []) if str(action).strip()]
    action_html = "".join(f"<li>{escape(action)}</li>" for action in actions)
    if not action_html:
        action_html = "<li>无</li>" if _is_zh_review_language(language) else "<li></li>"
    label = str(
        gate.get("label_localized")
        if _is_zh_review_language(language) and gate.get("label_localized")
        else gate.get("label")
        or gate.get("id")
        or ""
    )
    return (
        "<tr>"
        f"<td>{escape(label)}</td>"
        f"<td><span class=\"badge {css_class}\">{escape(_localized_submission_status(status, language))}</span></td>"
        f"<td>{escape(_localized_submission_bool(bool(gate.get('passed')), language))}</td>"
        f"<td>{escape(_localized_submission_gate_detail(gate, language))}</td>"
        f"<td><ul>{action_html}</ul></td>"
        "</tr>"
    )


def _localized_submission_bool(value: bool, language: str) -> str:
    if _is_zh_review_language(language):
        return "是" if value else "否"
    return str(value)


def _localized_submission_status(status: str, language: str) -> str:
    raw = str(status or "").strip()
    if not _is_zh_review_language(language):
        return raw
    return {
        "pass": "通过",
        "warn": "警告",
        "fail": "失败",
        "ready": "就绪",
        "ready_with_warnings": "有警告但可交付",
        "blocked": "阻断",
        "unknown": "未知",
        "human_review_required": "需人工复核",
        "budget_review_required": "需复核润色预算",
        "polish_applied_no_review_required": "已润色，无需额外复核",
        "no_polish_review_needed": "无需润色复核",
    }.get(raw, raw)


def _localized_submission_gate_detail(gate: dict, language: str) -> str:
    detail = str(gate.get("detail") or "")
    if not _is_zh_review_language(language):
        return detail
    if not detail.strip():
        return detail
    common_messages = {
        "No manuscript polish audit was available.": "未找到稿件润色审计。",
        "No external benchmark attached.": "未附加外部基准。",
    }
    if detail.strip() in common_messages:
        return common_messages[detail.strip()]
    if "=" not in detail:
        return detail
    parts: list[str] = []
    for segment in detail.rstrip(".").split(";"):
        segment = segment.strip()
        if not segment:
            continue
        if "=" not in segment:
            parts.append(segment)
            continue
        key, value = segment.split("=", 1)
        key = key.strip()
        value = value.strip()
        label = _localized_submission_detail_key(key, language)
        display_value = _localized_submission_detail_value(key, value, language)
        parts.append(f"{label}={display_value}")
    return "；".join(parts)


def _localized_submission_detail_key(key: str, language: str) -> str:
    raw = str(key or "").strip()
    if not _is_zh_review_language(language):
        return raw
    return {
        "enabled": "已启用",
        "accepted_chunks": "接受片段",
        "rejected_chunks": "拒绝片段",
        "accepted_edits": "接受修改",
        "scope": "润色范围",
        "targeted_chunks": "目标片段",
        "non_target_chunks": "非目标片段",
        "fact_guard_issues": "事实保护问题",
        "budget_exhausted": "预算耗尽",
        "before_style_score": "润色前风格分",
        "after_style_score": "润色后风格分",
        "remaining_style_issues": "剩余风格信号",
        "proofreading_issues": "审校问题",
        "review_queue_status": "复核队列状态",
        "manual_review_items": "人工复核项",
        "required": "是否要求",
        "references": "参考文献数",
        "publication_min_references": "投稿最低参考文献数",
        "main_text_citations": "正文引用数",
        "Introduction": "引言引用数",
        "Introduction_background": "引言背景引用",
        "Introduction_paragraphs": "引言段落覆盖",
        "Methods": "方法引用数",
        "Methods_methodology": "方法学引用",
        "Results": "结果引用数",
        "Discussion": "讨论引用数",
        "Discussion_context": "讨论语境引用",
        "Discussion_paragraphs": "讨论段落覆盖",
        "undefined": "未定义引用",
        "failed_issues": "失败问题",
        "warning_issues": "警告问题",
        "density": "引用密度",
    }.get(raw, raw)


def _localized_submission_detail_value(key: str, value: str, language: str) -> str:
    raw = str(value or "").strip()
    if not _is_zh_review_language(language):
        return raw
    if raw in {"True", "true"}:
        return "是"
    if raw in {"False", "false"}:
        return "否"
    status = _localized_submission_status(raw, language)
    if status != raw:
        return status
    if key == "density" and raw.endswith(" per 1000 words"):
        return raw.replace(" per 1000 words", "/1000词")
    return raw
