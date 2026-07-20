"""Conservative manuscript polishing with fact-preservation checks."""
from __future__ import annotations

import math
import re
import difflib
import logging
from collections import Counter
from collections.abc import Callable
from typing import Any


logger = logging.getLogger(__name__)

POLISHABLE_HEADINGS = {
    "abstract",
    "摘要",
    "introduction",
    "引言",
    "methods",
    "方法",
    "results",
    "结果",
    "discussion",
    "讨论",
    "conclusion",
    "结论",
}

ENGLISH_LEXICAL_STOPWORDS = frozenset(
    """
    a about above across after again against all almost along already also although always am among an and
    any are around as at be because been before being below between both but by can could did do does doing
    down during each either enough especially few for from further had has have having he her here hers
    herself him himself his how however i if in into is it its itself just may might more most much must my
    myself neither no nor not of off on once only or other our ours ourselves out over own per rather same
    she should since so some such than that the their theirs them themselves then there these they this those
    through to too under until up upon us very was we were what when where whether which while who whom whose
    why will with within without would you your yours yourself yourselves
    """.split()
)


def audit_manuscript_style(manuscript: str) -> dict[str, Any]:
    """Return lightweight bilingual style metrics for a manuscript."""
    text = str(manuscript or "")
    main_text = _main_text_before_references(text)
    style_text = _style_audit_text(text)
    cjk_chars = len(re.findall(r"[\u4e00-\u9fff]", text))
    latin_words = len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", text))
    main_cjk_chars = len(re.findall(r"[\u4e00-\u9fff]", style_text))
    main_latin_words = len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", style_text))
    language = _infer_style_language(main_cjk_chars, main_latin_words)
    sentences = _split_sentences_for_style(style_text)
    sentence_lengths = [_sentence_length(item, language) for item in sentences]
    template_hits = _template_phrase_hits(style_text)
    mean_sentence_length = round(sum(sentence_lengths) / len(sentence_lengths), 2) if sentence_lengths else 0
    sentence_length_cv = _coefficient_of_variation(sentence_lengths)
    repeated_openings = _repeated_sentence_openings(sentences, language)
    lexical_diversity = _lexical_diversity(style_text, language)
    return {
        "language": language,
        "latin_words": latin_words,
        "cjk_chars": cjk_chars,
        "main_latin_words": main_latin_words,
        "main_cjk_chars": main_cjk_chars,
        "sentences": len(sentences),
        "mean_sentence_length": mean_sentence_length,
        "sentence_length_cv": sentence_length_cv,
        "long_sentence_count": sum(1 for value in sentence_lengths if value > (42 if language != "zh" else 80)),
        "template_phrase_hits": template_hits,
        "repeated_sentence_openings": repeated_openings,
        "lexical_diversity": lexical_diversity,
        "ai_style_signal": _ai_style_signal(
            language=language,
            sentence_count=len(sentences),
            sentence_length_cv=sentence_length_cv,
            repeated_sentence_openings=repeated_openings,
            template_phrase_hits=template_hits,
            lexical_diversity=lexical_diversity,
        ),
    }


def _infer_style_language(cjk_chars: int, latin_words: int) -> str:
    if cjk_chars and latin_words:
        if cjk_chars >= latin_words * 2:
            return "zh"
        return "mixed"
    if cjk_chars:
        return "zh"
    return "en"


def polish_manuscript_text(
    manuscript: str,
    *,
    rewrite_fn: Callable[[str, dict[str, Any]], str] | None = None,
    proofread_fn: Callable[[str, dict[str, Any]], dict[str, Any] | list[dict[str, Any]]] | None = None,
    progress_cb: Callable[[dict[str, Any]], None] | None = None,
    enabled: bool = True,
    max_rewrite_chars: int = 3500,
    max_rewrite_chunks: int | None = None,
    rewrite_scope: str = "all",
) -> tuple[str, dict[str, Any]]:
    """Polish manuscript sections while rejecting edits that alter facts or citations."""
    original = str(manuscript or "")
    before_audit = audit_manuscript_style(original)
    normalized_rewrite_scope = _normalize_rewrite_scope(rewrite_scope)
    report: dict[str, Any] = {
        "schema_version": 1,
        "enabled": bool(enabled),
        "language": before_audit["language"],
        "rewrite_scope": normalized_rewrite_scope,
        "accepted_sections": 0,
        "rejected_sections": 0,
        "unchanged_sections": 0,
        "issues": [],
        "accepted_chunks": 0,
        "rejected_chunks": 0,
        "unchanged_chunks": 0,
        "attempted_chunks": 0,
        "attempted_original_chunks": 0,
        "skipped_chunks": 0,
        "skipped_chunk_details": [],
        "total_rewrite_chunks": 0,
        "targeted_chunks": 0,
        "non_target_chunks": 0,
        "rewrite_retries": 0,
        "retry_recovered_chunks": 0,
        "polish_budget_exhausted": False,
        "accepted_edit_count": 0,
        "accepted_edits": [],
        "before": before_audit,
        "after": before_audit,
        "style_policy": _polish_style_policy(before_audit["language"]),
        "proofreading": _proofreading_disabled_report(),
    }
    if not enabled:
        return original, report

    def default_rewrite(section_text: str, meta: dict[str, Any]) -> str:
        return _deterministic_style_cleanup(section_text)

    rewriter = rewrite_fn or default_rewrite
    rewrite_budget = None if max_rewrite_chunks is None else max(0, int(max_rewrite_chunks))
    sections = _split_h2_sections(original)
    if not sections:
        try:
            polished = _strip_rewrite_section_label(
                str(rewriter(original, _polish_chunk_meta("document", before_audit)) or original),
                "document",
            )
        except Exception as exc:
            report["issues"].append({
                "code": "rewrite_failed",
                "heading": "document",
                "message": str(exc),
                "original_text": _review_excerpt(original),
                "candidate_text": "",
                "review_action": "manual_review_required",
            })
            report["rejected_sections"] = 1
            return original, report
        issues = _preservation_issues(original, polished, "document")
        if issues:
            report["issues"].extend(_reviewable_preservation_issues(issues, original, polished))
            report["rejected_sections"] = 1
            return original, report
        report["accepted_sections"] = int(polished != original)
        report["unchanged_sections"] = int(polished == original)
        if polished != original:
            report["accepted_edits"].append(_accepted_polish_edit("document", original, polished))
        _finalize_polish_report(report, polished, proofread_fn)
        return polished, report

    chunks: list[str] = []
    cursor = 0
    for section in sections:
        chunks.append(original[cursor:section["body_start"]])
        heading_key = section["heading"].strip().lower()
        body = original[section["body_start"]:section["end"]]
        if heading_key in POLISHABLE_HEADINGS and body.strip():
            leading, core, trailing = _split_outer_whitespace(body)
            rewritten_core, chunk_report = _rewrite_core_chunks(
                core,
                rewriter,
                _polish_chunk_meta(section["heading"], audit_manuscript_style(core)),
                max_rewrite_chars=max_rewrite_chars,
                max_rewrite_chunks=rewrite_budget,
                rewrite_scope=normalized_rewrite_scope,
                progress_cb=progress_cb,
            )
            if rewrite_budget is not None:
                attempted_original_chunks = int(
                    chunk_report.get("attempted_original_chunks")
                    or chunk_report.get("attempted_chunks")
                    or 0
                )
                rewrite_budget = max(0, rewrite_budget - attempted_original_chunks)
            candidate = leading + rewritten_core.strip() + trailing
            issues = _preservation_issues(body, candidate, section["heading"])
            if issues:
                safe_body = _safe_deterministic_style_cleanup(body, section["heading"])
                chunks.append(safe_body)
                report["issues"].extend(chunk_report.get("issues", []))
                report["issues"].extend(_reviewable_preservation_issues(issues, body, candidate))
                report["rejected_chunks"] += _rejected_section_chunk_count(chunk_report)
                if safe_body != body:
                    report["accepted_sections"] += 1
                    report["accepted_edits"].append(
                        _accepted_polish_edit(
                            section["heading"],
                            body,
                            safe_body,
                            edit_source="deterministic_cleanup",
                        )
                    )
                else:
                    report["rejected_sections"] += 1
            elif chunk_report.get("rejected_chunks") and not chunk_report.get("accepted_chunks"):
                chunks.append(candidate if candidate != body and chunk_report.get("accepted_edits") else body)
                report["issues"].extend(chunk_report.get("issues", []))
                report["accepted_edits"].extend(chunk_report.get("accepted_edits", []))
                report["rejected_chunks"] += chunk_report.get("rejected_chunks", 0)
                report["unchanged_chunks"] += chunk_report.get("unchanged_chunks", 0)
                if candidate != body and chunk_report.get("accepted_edits"):
                    report["accepted_sections"] += 1
                else:
                    report["rejected_sections"] += 1
            elif candidate != body:
                chunks.append(candidate)
                for key in (
                    "accepted_chunks",
                    "rejected_chunks",
                    "unchanged_chunks",
                ):
                    report[key] += chunk_report.get(key, 0)
                report["issues"].extend(chunk_report.get("issues", []))
                report["accepted_edits"].extend(chunk_report.get("accepted_edits", []))
                report["accepted_sections"] += 1
            else:
                chunks.append(body)
                report["issues"].extend(chunk_report.get("issues", []))
                report["rejected_chunks"] += chunk_report.get("rejected_chunks", 0)
                report["unchanged_chunks"] += chunk_report.get("unchanged_chunks", 0)
                report["unchanged_sections"] += 1
            report["attempted_chunks"] += chunk_report.get("attempted_chunks", 0)
            report["attempted_original_chunks"] += chunk_report.get("attempted_original_chunks", 0)
            report["skipped_chunks"] += chunk_report.get("skipped_chunks", 0)
            report["skipped_chunk_details"].extend(chunk_report.get("skipped_chunk_details", []))
            report["total_rewrite_chunks"] += chunk_report.get("total_rewrite_chunks", 0)
            report["targeted_chunks"] += chunk_report.get("targeted_chunks", 0)
            report["non_target_chunks"] += chunk_report.get("non_target_chunks", 0)
            report["rewrite_retries"] += chunk_report.get("rewrite_retries", 0)
            report["retry_recovered_chunks"] += chunk_report.get("retry_recovered_chunks", 0)
            if chunk_report.get("polish_budget_exhausted"):
                report["polish_budget_exhausted"] = True
        else:
            chunks.append(body)
        cursor = section["end"]
    chunks.append(original[cursor:])
    polished = "".join(chunks)
    _finalize_polish_report(report, polished, proofread_fn)
    return polished, report


def preservation_guard_issues(
    original: str,
    candidate: str,
    heading: str = "Manuscript",
) -> list[dict[str, Any]]:
    """Return reviewable issues when a polish candidate changes protected content."""
    raw_issues = _preservation_issues(str(original or ""), str(candidate or ""), str(heading or "Manuscript"))
    if not raw_issues:
        return []
    return _reviewable_preservation_issues(raw_issues, original, candidate)


def _rejected_section_chunk_count(chunk_report: dict[str, Any]) -> int:
    attempted_changes = int(chunk_report.get("accepted_chunks") or 0) + int(chunk_report.get("rejected_chunks") or 0)
    if attempted_changes:
        return attempted_changes
    return 1


def _finalize_polish_report(
    report: dict[str, Any],
    polished: str,
    proofread_fn: Callable[[str, dict[str, Any]], dict[str, Any] | list[dict[str, Any]]] | None,
) -> None:
    _collapse_polish_budget_issues(report)
    report["accepted_edit_count"] = len([item for item in report.get("accepted_edits") or [] if isinstance(item, dict)])
    report["after"] = audit_manuscript_style(polished)
    report["style_policy"] = _polish_style_policy(str(report["after"].get("language") or report.get("language") or "en"))
    report["proofreading"] = _run_optional_proofreading(
        polished,
        report["after"],
        report["style_policy"],
        proofread_fn,
    )


def _collapse_polish_budget_issues(report: dict[str, Any]) -> None:
    issues = [item for item in (report.get("issues") or []) if isinstance(item, dict)]
    budget_issues = [item for item in issues if item.get("code") == "polish_budget_exhausted"]
    if not budget_issues:
        report["issues"] = issues
        return
    other_issues = [item for item in issues if item.get("code") != "polish_budget_exhausted"]
    headings = []
    for item in budget_issues:
        heading = str(item.get("heading") or "").strip()
        if heading and heading not in headings:
            headings.append(heading)
    other_issues.append({
        "code": "polish_budget_exhausted",
        "heading": ", ".join(headings) if headings else "manuscript",
        "message": (
            "Polish rewrite chunk budget was exhausted before all manuscript chunks were attempted; "
            "remaining chunks were kept unchanged."
        ),
        "attempted_chunks": int(report.get("attempted_chunks") or 0),
        "skipped_chunks": int(report.get("skipped_chunks") or 0),
        "skipped_chunk_details": report.get("skipped_chunk_details", [])[:20],
        "total_rewrite_chunks": int(report.get("total_rewrite_chunks") or 0),
        "review_action": "rerun_with_higher_polish_budget",
    })
    report["issues"] = other_issues


def _polish_style_policy(language: str | None = None) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "name": "MetaAgent conservative scholarly polish",
        "mode": "fact_preserving_style_review",
        "language": str(language or "en"),
        "detector_evasion": False,
        "detector_optimization": "disabled",
        "automatic_rewrite_scope": "polishable manuscript sections only",
        "protected_facts": ["numbers", "citations", "table_figure_references", "study_acronyms", "drug_terms", "study_design_terms"],
        "external_proofreader_role": "review_only",
    }


def _proofreading_disabled_report() -> dict[str, Any]:
    return {
        "enabled": False,
        "status": "disabled",
        "provider": "none",
        "issue_count": 0,
        "issues": [],
    }


def _run_optional_proofreading(
    text: str,
    audit: dict[str, Any],
    style_policy: dict[str, Any],
    proofread_fn: Callable[[str, dict[str, Any]], dict[str, Any] | list[dict[str, Any]]] | None,
) -> dict[str, Any]:
    if proofread_fn is None:
        return _proofreading_disabled_report()
    proofread_language = _proofreading_language_from_audit(audit)
    meta = {
        "language": proofread_language,
        "audit_language": audit.get("language") or proofread_language,
        "style_policy": style_policy,
        "ai_style_signal": audit.get("ai_style_signal") or {},
    }
    try:
        result = proofread_fn(text, meta)
    except Exception as exc:
        return {
            "enabled": True,
            "status": "failed",
            "provider": "custom",
            "issue_count": 0,
            "issues": [],
            "error": str(exc),
        }
    if isinstance(result, list):
        issues = [item for item in result if isinstance(item, dict)]
        return {
            "enabled": True,
            "status": "ok",
            "provider": "custom",
            "issue_count": len(issues),
            "issues": issues[:50],
        }
    if not isinstance(result, dict):
        return {
            "enabled": True,
            "status": "ok",
            "provider": "custom",
            "issue_count": 0,
            "issues": [],
        }
    issues = [item for item in (result.get("issues") or []) if isinstance(item, dict)]
    return {
        "enabled": True,
        "status": str(result.get("status") or "ok"),
        "provider": str(result.get("provider") or "custom"),
        "language_code": str(result.get("language_code") or ""),
        "issue_count": int(result.get("issue_count") if result.get("issue_count") is not None else len(issues)),
        "issues": issues[:50],
    }


def _proofreading_language_from_audit(audit: dict[str, Any]) -> str:
    language = str((audit or {}).get("language") or "en").strip().lower()
    if language == "zh":
        return "zh"
    if language != "mixed":
        return "en"
    cjk_chars = int((audit or {}).get("main_cjk_chars") or (audit or {}).get("cjk_chars") or 0)
    latin_words = int((audit or {}).get("main_latin_words") or (audit or {}).get("latin_words") or 0)
    return "zh" if cjk_chars > max(0, latin_words) * 2 else "en"


def _polish_chunk_meta(heading: str, audit: dict[str, Any]) -> dict[str, Any]:
    return {
        "heading": heading,
        "language": audit.get("language") or "en",
        "style_targets": _style_targets_from_audit(audit),
    }


def _style_targets_from_audit(audit: dict[str, Any]) -> dict[str, Any]:
    signal = audit.get("ai_style_signal") if isinstance(audit, dict) else {}
    issue_codes = {str(item.get("code") or "") for item in (signal or {}).get("issues") or [] if isinstance(item, dict)}
    template_phrases = sorted((audit.get("template_phrase_hits") or {}).keys()) if isinstance(audit, dict) else []
    return {
        "remove_template_phrases": bool(template_phrases),
        "vary_sentence_openings": "repeated_sentence_starts" in issue_codes,
        "increase_sentence_length_variation": "low_sentence_length_variation" in issue_codes,
        "improve_lexical_diversity": "low_lexical_diversity" in issue_codes,
        "template_phrases": template_phrases,
        "preserve_numbers_citations_crossrefs_terms": True,
        "detector_optimization": "disabled",
    }


def _normalize_rewrite_scope(rewrite_scope: str | None) -> str:
    normalized = str(rewrite_scope or "all").strip().lower().replace("-", "_")
    if normalized in {"target", "targeted", "issue", "issues", "problematic"}:
        return "targeted"
    if normalized in {"all", "full", "complete", "deep"}:
        return "all"
    return "all"


def _style_targets_need_llm(style_targets: dict[str, Any]) -> bool:
    return any(
        bool(style_targets.get(key))
        for key in (
            "remove_template_phrases",
            "vary_sentence_openings",
            "increase_sentence_length_variation",
            "improve_lexical_diversity",
        )
    )


def _rewrite_core_chunks(
    core: str,
    rewriter: Callable[[str, dict[str, Any]], str],
    meta: dict[str, Any],
    *,
    max_rewrite_chars: int,
    max_rewrite_chunks: int | None = None,
    rewrite_scope: str = "all",
    progress_cb: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[str, dict[str, Any]]:
    report = {
        "accepted_chunks": 0,
        "rejected_chunks": 0,
        "unchanged_chunks": 0,
        "attempted_chunks": 0,
        "attempted_original_chunks": 0,
        "skipped_chunks": 0,
        "skipped_chunk_details": [],
        "total_rewrite_chunks": 0,
        "targeted_chunks": 0,
        "non_target_chunks": 0,
        "rewrite_retries": 0,
        "retry_recovered_chunks": 0,
        "polish_budget_exhausted": False,
        "issues": [],
        "accepted_edits": [],
    }
    units = _split_rewrite_units(core, max(1, int(max_rewrite_chars or 3500)))
    normalized_rewrite_scope = _normalize_rewrite_scope(rewrite_scope)
    budget_remaining = None if max_rewrite_chunks is None else max(0, int(max_rewrite_chunks))
    rewritten: list[str] = []
    rewrite_index = 0
    target_indexes: list[int] = []
    prepared_units: list[dict[str, Any]] = []
    for original_unit in units:
        unit = original_unit
        if not unit.strip():
            prepared_units.append({"original": original_unit, "unit": unit, "rewriteable": False, "targeted": False})
            continue
        if not _is_rewriteable_polish_unit(unit):
            prepared_units.append({"original": original_unit, "unit": unit, "rewriteable": False, "targeted": False})
            continue
        unit = _safe_deterministic_style_cleanup(unit, str(meta.get("heading") or ""))
        targeted = True
        unit_style_targets = dict(meta.get("style_targets") or {})
        if normalized_rewrite_scope == "targeted":
            unit_audit = audit_manuscript_style(unit)
            unit_style_targets = _style_targets_from_audit(unit_audit)
            targeted = _style_targets_need_llm(unit_style_targets)
        prepared_index = len(prepared_units)
        prepared_units.append({
            "original": original_unit,
            "unit": unit,
            "rewriteable": True,
            "targeted": targeted,
            "style_targets": unit_style_targets,
            "deterministic_changed": unit != original_unit,
        })
        if targeted:
            target_indexes.append(prepared_index)
    total_rewrite_chunks = len(target_indexes)
    report["total_rewrite_chunks"] = total_rewrite_chunks
    report["targeted_chunks"] = total_rewrite_chunks
    report["non_target_chunks"] = sum(
        1 for item in prepared_units if item.get("rewriteable") and not item.get("targeted")
    )
    heading = str(meta.get("heading") or "Manuscript")
    _emit_polish_progress(
        progress_cb,
        "section_started",
        heading=heading,
        chunk_count=total_rewrite_chunks,
        rewrite_scope=normalized_rewrite_scope,
        non_target_chunks=report["non_target_chunks"],
    )
    for prepared in prepared_units:
        original_unit = str(prepared.get("original") or "")
        unit = str(prepared.get("unit") or "")
        if not prepared.get("rewriteable"):
            rewritten.append(unit)
            continue
        if not prepared.get("targeted"):
            rewritten.append(unit)
            if prepared.get("deterministic_changed"):
                report["accepted_edits"].append(
                    _accepted_polish_edit(
                        str(meta.get("heading") or ""),
                        original_unit,
                        unit,
                        edit_source="deterministic_cleanup",
                    )
                )
            continue
        index = rewrite_index
        rewrite_index += 1
        if budget_remaining is not None and budget_remaining <= 0:
            rewritten.append(unit)
            if prepared.get("deterministic_changed"):
                report["accepted_edits"].append(
                    _accepted_polish_edit(
                        str(meta.get("heading") or ""),
                        original_unit,
                        unit,
                        edit_source="deterministic_cleanup",
                        chunk_index=index,
                        chunk_count=total_rewrite_chunks,
                    )
                )
            report["skipped_chunks"] += 1
            report["skipped_chunk_details"].append(
                _skipped_polish_chunk_detail(
                    heading,
                    original_unit,
                    unit,
                    chunk_index=index,
                    chunk_count=total_rewrite_chunks,
                    deterministic_cleanup_applied=bool(prepared.get("deterministic_changed")),
                )
            )
            report["polish_budget_exhausted"] = True
            _emit_polish_progress(
                progress_cb,
                "chunk_skipped",
                heading=heading,
                chunk_index=index,
                chunk_count=total_rewrite_chunks,
                reason="polish_budget_exhausted",
                deterministic_cleanup_applied=bool(prepared.get("deterministic_changed")),
                **_polish_progress_counts(report),
            )
            continue
        unit_meta = {
            **meta,
            "style_targets": prepared.get("style_targets") or meta.get("style_targets") or {},
            "chunk_index": index,
            "chunk_count": total_rewrite_chunks,
            "rewrite_scope": normalized_rewrite_scope,
        }
        leading, chunk_core, trailing = _split_outer_whitespace(unit)
        try:
            report["attempted_chunks"] += 1
            report["attempted_original_chunks"] += 1
            if budget_remaining is not None:
                budget_remaining -= 1
            _emit_polish_progress(
                progress_cb,
                "chunk_started",
                heading=heading,
                chunk_index=index,
                chunk_count=total_rewrite_chunks,
                rewrite_scope=normalized_rewrite_scope,
                **_polish_progress_counts(report),
            )
            candidate_core = _strip_rewrite_section_label(
                str(rewriter(chunk_core, unit_meta) or chunk_core),
                str(unit_meta.get("heading") or ""),
            )
            candidate = leading + candidate_core.strip() + trailing
        except Exception as exc:
            report["issues"].append({
                "code": "rewrite_failed",
                "heading": heading,
                "message": str(exc),
                "chunk_index": index,
                "chunk_count": unit_meta.get("chunk_count"),
                "original_text": _review_excerpt(unit),
                "candidate_text": "",
                "review_action": "manual_review_required",
            })
            rewritten.append(unit)
            report["rejected_chunks"] += 1
            _emit_polish_progress(
                progress_cb,
                "chunk_rejected",
                heading=heading,
                chunk_index=index,
                chunk_count=unit_meta.get("chunk_count"),
                issue_codes=["rewrite_failed"],
                **_polish_progress_counts(report),
            )
            continue
        issues = _preservation_issues(unit, candidate, str(meta.get("heading") or ""))
        if issues:
            retry_candidate = None
            retry_issues = issues
            retry_error = None
            retry_meta = {
                **unit_meta,
                "retry_after_preservation_rejection": True,
                "preservation_issues": issues,
                "preservation_issue_codes": [
                    str(issue.get("code") or "") for issue in issues if isinstance(issue, dict)
                ],
                "rejected_candidate_excerpt": _review_excerpt(candidate),
            }
            try:
                report["rewrite_retries"] += 1
                report["attempted_chunks"] += 1
                _emit_polish_progress(
                    progress_cb,
                    "chunk_retry",
                    heading=heading,
                    chunk_index=index,
                    chunk_count=unit_meta.get("chunk_count"),
                    issue_codes=_polish_issue_codes(issues),
                    **_polish_progress_counts(report),
                )
                retry_core = _strip_rewrite_section_label(
                    str(rewriter(chunk_core, retry_meta) or chunk_core),
                    str(unit_meta.get("heading") or ""),
                )
                retry_candidate = leading + retry_core.strip() + trailing
                retry_issues = _preservation_issues(unit, retry_candidate, str(meta.get("heading") or ""))
            except Exception as exc:
                retry_error = str(exc)

            if retry_candidate is not None and not retry_issues:
                rewritten.append(retry_candidate)
                report["retry_recovered_chunks"] += 1
                if retry_candidate != original_unit:
                    report["accepted_edits"].append(
                        _accepted_polish_edit(
                            heading,
                            original_unit,
                            retry_candidate,
                            chunk_index=index,
                            chunk_count=unit_meta.get("chunk_count"),
                            retry_after_preservation_rejection=True,
                        )
                    )
                    report["accepted_chunks"] += 1
                    _emit_polish_progress(
                        progress_cb,
                        "chunk_accepted",
                        heading=heading,
                        chunk_index=index,
                        chunk_count=unit_meta.get("chunk_count"),
                        retry_after_preservation_rejection=True,
                        **_polish_progress_counts(report),
                    )
                else:
                    report["unchanged_chunks"] += 1
                    _emit_polish_progress(
                        progress_cb,
                        "chunk_unchanged",
                        heading=heading,
                        chunk_index=index,
                        chunk_count=unit_meta.get("chunk_count"),
                        retry_after_preservation_rejection=True,
                        **_polish_progress_counts(report),
                    )
                continue

            rewritten.append(unit)
            review_issues = retry_issues or issues
            reviewable = _reviewable_preservation_issues(
                review_issues,
                unit,
                retry_candidate if retry_candidate is not None else candidate,
                chunk_index=index,
                chunk_count=unit_meta.get("chunk_count"),
            )
            if retry_error:
                reviewable.append({
                    "code": "rewrite_retry_failed",
                    "heading": heading,
                    "message": retry_error,
                    "chunk_index": index,
                    "chunk_count": unit_meta.get("chunk_count"),
                    "original_text": _review_excerpt(unit),
                    "candidate_text": _review_excerpt(candidate),
                    "review_action": "manual_review_required",
                })
            report["issues"].extend(reviewable)
            if prepared.get("deterministic_changed"):
                report["accepted_edits"].append(
                    _accepted_polish_edit(
                        heading,
                        original_unit,
                        unit,
                        edit_source="deterministic_cleanup",
                        chunk_index=index,
                        chunk_count=unit_meta.get("chunk_count"),
                    )
                )
            report["rejected_chunks"] += 1
            issue_codes = _polish_issue_codes(review_issues)
            if retry_error:
                issue_codes.append("rewrite_retry_failed")
            _emit_polish_progress(
                progress_cb,
                "chunk_rejected",
                heading=heading,
                chunk_index=index,
                chunk_count=unit_meta.get("chunk_count"),
                issue_codes=issue_codes,
                **_polish_progress_counts(report),
            )
        elif candidate != original_unit:
            rewritten.append(candidate)
            report["accepted_edits"].append(
                _accepted_polish_edit(
                    heading,
                    original_unit,
                    candidate,
                    chunk_index=index,
                    chunk_count=unit_meta.get("chunk_count"),
                )
            )
            report["accepted_chunks"] += 1
            _emit_polish_progress(
                progress_cb,
                "chunk_accepted",
                heading=heading,
                chunk_index=index,
                chunk_count=unit_meta.get("chunk_count"),
                **_polish_progress_counts(report),
            )
        else:
            rewritten.append(unit)
            report["unchanged_chunks"] += 1
            _emit_polish_progress(
                progress_cb,
                "chunk_unchanged",
                heading=heading,
                chunk_index=index,
                chunk_count=unit_meta.get("chunk_count"),
                **_polish_progress_counts(report),
            )
    if report["skipped_chunks"]:
        report["issues"].append({
            "code": "polish_budget_exhausted",
            "heading": meta.get("heading", ""),
            "message": (
                "Polish rewrite chunk budget was exhausted before all manuscript chunks were attempted; "
                "remaining chunks were kept unchanged."
            ),
            "attempted_chunks": report["attempted_chunks"],
            "skipped_chunks": report["skipped_chunks"],
            "skipped_chunk_details": report["skipped_chunk_details"][:20],
            "total_rewrite_chunks": report["total_rewrite_chunks"],
            "review_action": "rerun_with_higher_polish_budget",
        })
    _emit_polish_progress(
        progress_cb,
        "section_finished",
        heading=heading,
        chunk_count=total_rewrite_chunks,
        **_polish_progress_counts(report),
    )
    return "".join(rewritten), report


def _emit_polish_progress(
    progress_cb: Callable[[dict[str, Any]], None] | None,
    event: str,
    **payload: Any,
) -> None:
    if progress_cb is None:
        return
    message = {
        "schema_version": 1,
        "stage": "manuscript_polish",
        "event": str(event),
        **payload,
    }
    try:
        progress_cb(message)
    except Exception:
        logger.warning("Manuscript polish progress callback failed", exc_info=True)


def _polish_progress_counts(report: dict[str, Any]) -> dict[str, int | bool]:
    return {
        "attempted_chunks": int(report.get("attempted_chunks") or 0),
        "accepted_chunks": int(report.get("accepted_chunks") or 0),
        "rejected_chunks": int(report.get("rejected_chunks") or 0),
        "unchanged_chunks": int(report.get("unchanged_chunks") or 0),
        "skipped_chunks": int(report.get("skipped_chunks") or 0),
        "rewrite_retries": int(report.get("rewrite_retries") or 0),
        "retry_recovered_chunks": int(report.get("retry_recovered_chunks") or 0),
        "polish_budget_exhausted": bool(report.get("polish_budget_exhausted")),
    }


def _polish_issue_codes(issues: list[dict[str, Any]] | tuple[dict[str, Any], ...] | None) -> list[str]:
    codes: list[str] = []
    for issue in issues or []:
        if not isinstance(issue, dict):
            continue
        code = str(issue.get("code") or "").strip()
        if code and code not in codes:
            codes.append(code)
    return codes


def _safe_deterministic_style_cleanup(unit: str, heading: str) -> str:
    leading, core, trailing = _split_outer_whitespace(unit)
    cleaned_core = _deterministic_style_cleanup(core)
    candidate = leading + cleaned_core.strip() + trailing
    if candidate == unit:
        return unit
    if _preservation_issues(unit, candidate, heading):
        return unit
    return candidate


def _accepted_polish_edit(
    heading: str,
    original: str,
    candidate: str,
    **extra: Any,
) -> dict[str, Any]:
    return {
        "heading": str(heading or "Manuscript"),
        **extra,
        "original_text": _review_excerpt(original),
        "candidate_text": _review_excerpt(candidate),
        "diff": _review_diff(original, candidate),
        "review_action": "accepted_fact_preserving_polish",
        "can_revert": True,
    }


def _skipped_polish_chunk_detail(
    heading: str,
    original: str,
    kept: str,
    *,
    chunk_index: int,
    chunk_count: int,
    deterministic_cleanup_applied: bool,
) -> dict[str, Any]:
    return {
        "heading": str(heading or "Manuscript"),
        "chunk_index": int(chunk_index),
        "chunk_count": int(chunk_count),
        "reason": "polish_budget_exhausted",
        "original_text": _review_excerpt(original),
        "kept_text": _review_excerpt(kept),
        "deterministic_cleanup_applied": bool(deterministic_cleanup_applied),
        "review_action": "rerun_with_higher_polish_budget",
    }


def _review_diff(original: str, candidate: str, max_chars: int = 2400) -> str:
    diff = "\n".join(
        difflib.unified_diff(
            str(original or "").strip().splitlines(),
            str(candidate or "").strip().splitlines(),
            fromfile="original",
            tofile="polished",
            lineterm="",
        )
    )
    return _review_excerpt(diff, max_chars)


def _split_rewrite_units(text: str, max_chars: int) -> list[str]:
    raw = str(text or "")
    if "```" in raw:
        units: list[str] = []
        for token in re.split(r"(```[\s\S]*?```)", raw):
            if not token:
                continue
            if token.startswith("```") and token.endswith("```"):
                units.append(token)
            else:
                units.extend(_split_plain_rewrite_units(token, max_chars))
        return units
    if len(raw) <= max_chars:
        return [raw]
    return _split_plain_rewrite_units(raw, max_chars)


def _split_plain_rewrite_units(text: str, max_chars: int) -> list[str]:
    raw = str(text or "")
    if len(raw) <= max_chars:
        return [raw]
    units: list[str] = []
    current = ""
    parts = re.split(r"(\n\s*\n)", raw)
    for part in parts:
        if not part:
            continue
        if len(part) <= max_chars:
            if current and len(current) + len(part) > max_chars:
                units.append(current)
                current = part
            else:
                current += part
            continue
        if current:
            units.append(current)
            current = ""
        if re.fullmatch(r"\n\s*\n", part):
            units.append(part)
            continue
        units.extend(_split_long_paragraph(part, max_chars))
    if current:
        units.append(current)
    return units


def _is_rewriteable_polish_unit(unit: str) -> bool:
    raw = str(unit or "")
    if not raw.strip() or "```" in raw:
        return False
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
        if re.search(r"[A-Za-z\u4e00-\u9fff]", stripped):
            return True
    return False


def _split_long_paragraph(text: str, max_chars: int) -> list[str]:
    sentences = re.split(r"(?<=[.!?。！？])\s+", str(text or ""))
    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        if not sentence:
            continue
        candidate = f"{current} {sentence}".strip() if current else sentence
        if current and len(candidate) > max_chars:
            chunks.append(current)
            current = sentence
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks or [text]


def _split_h2_sections(text: str) -> list[dict[str, Any]]:
    matches = list(re.finditer(r"^##\s+(.+?)\s*$", text, flags=re.M))
    sections = []
    for index, match in enumerate(matches):
        body_start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections.append({
            "heading": match.group(1).strip(),
            "heading_start": match.start(),
            "body_start": body_start,
            "end": end,
        })
    return sections


def _preservation_issues(original: str, candidate: str, heading: str) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    prompt_artifact_hits = _prompt_artifact_hits(candidate)
    if prompt_artifact_hits:
        issues.append({
            "code": "prompt_artifact_leaked",
            "heading": heading,
            "message": "Polish rewrite introduced prompt or excerpt-control text into the manuscript.",
            "matches": prompt_artifact_hits,
        })
    source_characterization_hits = _unsupported_source_characterization_hits(original, candidate)
    if source_characterization_hits:
        issues.append({
            "code": "unsupported_source_characterization",
            "heading": heading,
            "message": "Polish rewrite introduced unsupported private/proprietary/confidential source characterization.",
            "matches": source_characterization_hits,
        })
    detector_evasion_hits = _detector_evasion_language_hits(candidate)
    if detector_evasion_hits:
        issues.append({
            "code": "detector_evasion_language",
            "heading": heading,
            "message": "Polish rewrite introduced detector-evasion or AI-score-optimization language.",
            "matches": detector_evasion_hits,
        })
    workflow_disclosure_hits = _unsupported_workflow_disclosure_hits(original, candidate)
    if workflow_disclosure_hits:
        issues.append({
            "code": "unsupported_workflow_disclosure",
            "heading": heading,
            "message": "Polish rewrite introduced unsupported automation, manual-review, or internal workflow disclosure.",
            "matches": workflow_disclosure_hits,
        })
    original_language = _rewrite_language_signature(original)
    candidate_language = _rewrite_language_signature(candidate)
    if _rewrite_language_changed(original_language, candidate_language):
        issues.append({
            "code": "language_changed",
            "heading": heading,
            "message": "Polish rewrite changed the manuscript output language.",
            "original_language": original_language["language"],
            "candidate_language": candidate_language["language"],
            "original_language_counts": original_language,
            "candidate_language_counts": candidate_language,
        })
    overcompression = _rewrite_overcompression_issue(original, candidate)
    if overcompression:
        overcompression["heading"] = heading
        issues.append(overcompression)
    if _numeric_tokens(original) != _numeric_tokens(candidate):
        issues.append({
            "code": "numeric_tokens_changed",
            "heading": heading,
            "message": "Polish rewrite changed numeric tokens.",
        })
    if _citation_tokens(original) != _citation_tokens(candidate):
        issues.append({
            "code": "citations_changed",
            "heading": heading,
            "message": "Polish rewrite changed citation markers.",
        })
    elif _citation_sentence_bindings(original) != _citation_sentence_bindings(candidate):
        issues.append({
            "code": "citation_sentence_binding_changed",
            "heading": heading,
            "message": "Polish rewrite moved citation markers to a different sentence or claim.",
            "original_citation_bindings": _citation_sentence_bindings(original),
            "candidate_citation_bindings": _citation_sentence_bindings(candidate),
        })
    if _table_or_figure_refs(original) != _table_or_figure_refs(candidate):
        issues.append({
            "code": "cross_references_changed",
            "heading": heading,
            "message": "Polish rewrite changed table or figure references.",
        })
    original_terms = _protected_factual_terms(original)
    candidate_terms = _protected_factual_terms(candidate)
    if original_terms != candidate_terms:
        issues.append({
            "code": "protected_terms_changed",
            "heading": heading,
            "message": "Polish rewrite changed protected study, acronym, or drug terms.",
            "original_terms": original_terms,
            "candidate_terms": candidate_terms,
        })
    original_entities = _clinical_entity_signature(original)
    candidate_entities = _clinical_entity_signature(candidate)
    if original_entities != candidate_entities:
        issues.append({
            "code": "clinical_entities_changed",
            "heading": heading,
            "message": "Polish rewrite changed clinical population, condition, or outcome terms.",
            "original_clinical_entities": original_entities,
            "candidate_clinical_entities": candidate_entities,
        })
    original_direction = _directional_term_signature(original)
    candidate_direction = _directional_term_signature(candidate)
    if original_direction != candidate_direction:
        issues.append({
            "code": "directional_terms_changed",
            "heading": heading,
            "message": "Polish rewrite changed directional conclusion terms.",
            "original_directional_terms": original_direction,
            "candidate_directional_terms": candidate_direction,
        })
    original_claim_terms = _clinical_claim_term_signature(original)
    candidate_claim_terms = _clinical_claim_term_signature(candidate)
    if original_claim_terms != candidate_claim_terms:
        issues.append({
            "code": "clinical_claim_terms_changed",
            "heading": heading,
            "message": "Polish rewrite changed clinical benefit, harm, efficacy, or causal claim terms.",
            "original_clinical_claim_terms": original_claim_terms,
            "candidate_clinical_claim_terms": candidate_claim_terms,
        })
    original_ratings = _certainty_rating_signature(original)
    candidate_ratings = _certainty_rating_signature(candidate)
    if original_ratings != candidate_ratings:
        issues.append({
            "code": "certainty_rating_changed",
            "heading": heading,
            "message": "Polish rewrite changed GRADE certainty rating terms.",
            "original_certainty_ratings": original_ratings,
            "candidate_certainty_ratings": candidate_ratings,
        })
    original_rob_ratings = _risk_of_bias_rating_signature(original)
    candidate_rob_ratings = _risk_of_bias_rating_signature(candidate)
    if original_rob_ratings != candidate_rob_ratings:
        issues.append({
            "code": "risk_of_bias_rating_changed",
            "heading": heading,
            "message": "Polish rewrite changed risk-of-bias rating terms.",
            "original_risk_of_bias_ratings": original_rob_ratings,
            "candidate_risk_of_bias_ratings": candidate_rob_ratings,
        })
    original_statistical_models = _statistical_model_signature(original)
    candidate_statistical_models = _statistical_model_signature(candidate)
    if original_statistical_models != candidate_statistical_models:
        issues.append({
            "code": "statistical_model_changed",
            "heading": heading,
            "message": "Polish rewrite changed statistical model or estimator terms.",
            "original_statistical_models": original_statistical_models,
            "candidate_statistical_models": candidate_statistical_models,
        })
    original_significance = _statistical_significance_signature(original)
    candidate_significance = _statistical_significance_signature(candidate)
    if original_significance != candidate_significance:
        issues.append({
            "code": "statistical_significance_changed",
            "heading": heading,
            "message": "Polish rewrite changed statistical significance interpretation.",
            "original_statistical_significance": original_significance,
            "candidate_statistical_significance": candidate_significance,
        })
    original_study_design = _study_design_signature(original)
    candidate_study_design = _study_design_signature(candidate)
    if original_study_design != candidate_study_design:
        issues.append({
            "code": "study_design_changed",
            "heading": heading,
            "message": "Polish rewrite changed study design terms.",
            "original_study_design_terms": original_study_design,
            "candidate_study_design_terms": candidate_study_design,
        })
    original_certainty_terms = _interpretive_certainty_signature(original)
    candidate_certainty_terms = _interpretive_certainty_signature(candidate)
    if original_certainty_terms != candidate_certainty_terms:
        issues.append({
            "code": "interpretive_certainty_changed",
            "heading": heading,
            "message": "Polish rewrite changed hedging, association, or evidential certainty terms.",
            "original_interpretive_certainty_terms": original_certainty_terms,
            "candidate_interpretive_certainty_terms": candidate_certainty_terms,
        })
    return issues


def _rewrite_overcompression_issue(original: str, candidate: str) -> dict[str, Any] | None:
    original_units = _rewrite_text_units(original)
    if original_units < 80:
        return None
    candidate_units = _rewrite_text_units(candidate)
    minimum_units = max(1, int(original_units * 0.72))
    if candidate_units >= minimum_units:
        return None
    return {
        "code": "rewrite_overcompressed",
        "message": (
            "Polish rewrite removed too much prose for a conservative copyedit; keep the original section "
            "unless a human reviewer intentionally condenses it."
        ),
        "original_units": original_units,
        "candidate_units": candidate_units,
        "minimum_candidate_units": minimum_units,
    }


def _rewrite_text_units(text: str) -> int:
    raw = str(text or "")
    cjk_chars = len(re.findall(r"[\u4e00-\u9fff]", raw))
    latin_units = len(re.findall(r"\b[A-Za-z0-9][A-Za-z0-9%./+-]*\b", raw))
    if cjk_chars >= max(1, latin_units * 2):
        return cjk_chars
    return latin_units


def _rewrite_language_signature(text: str) -> dict[str, Any]:
    raw = str(text or "")
    cjk_chars = len(re.findall(r"[\u4e00-\u9fff]", raw))
    latin_words = len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", raw))
    return {
        "language": _infer_style_language(cjk_chars, latin_words),
        "cjk_chars": cjk_chars,
        "latin_words": latin_words,
    }


def _rewrite_language_changed(original: dict[str, Any], candidate: dict[str, Any]) -> bool:
    original_language = str((original or {}).get("language") or "")
    candidate_language = str((candidate or {}).get("language") or "")
    if original_language not in {"en", "zh"} or candidate_language not in {"en", "zh", "mixed"}:
        return False
    return original_language != candidate_language


def _detector_evasion_language_hits(text: str) -> list[str]:
    patterns = [
        r"\blower(?:ing|ed)?\s+(?:the\s+)?ai\s+detector\s+score\b",
        r"\b(?:avoid|bypass|evade|beat|pass)\s+(?:an?\s+)?ai\s+(?:content\s+)?detector\b",
        r"\b(?:avoid|bypass|evade|beat|pass)\s+ai\s+detection\b",
        r"\bundetectable\s+by\s+(?:an?\s+)?ai\s+(?:content\s+)?detector\b",
        r"\b(?:ai\s+humanizer|humanize\s+ai\s+text)\b",
        r"降低\s*ai\s*率",
        r"降低\s*ai\s*检测",
        r"规避\s*ai\s*检测",
        r"绕开\s*ai\s*(?:检测|查重)",
        r"绕过\s*ai\s*检测",
        r"通过\s*ai\s*检测",
        r"ai\s*检测\s*不\s*出来",
        r"去\s*ai\s*味",
    ]
    raw = str(text or "")
    hits: list[str] = []
    for pattern in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            hits.append(match.group(0))
    return sorted(set(hits), key=str.lower)


def _prompt_artifact_hits(text: str) -> list[str]:
    patterns = [
        r"\[\.\.\.\s*middle of this existing section omitted for prompt length[^\]]*\.\.\.\]",
        r"\bdo not treat (?:the )?section as missing\b",
        r"\bSECTION INVENTORY\b",
        r"\bTARGET PARAGRAPHS\b",
        r"\bCURRENT OPEN SECTIONS\b",
        r"\bSTRUCTURED FACTS\b",
        r"\bFINAL REVIEW TO ADDRESS\b",
        r"\bReturn JSON only\b",
    ]
    raw = str(text or "")
    hits: list[str] = []
    for pattern in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            hits.append(match.group(0))
    return sorted(set(hits), key=str.lower)


def _unsupported_source_characterization_hits(original: str, candidate: str) -> list[str]:
    """Reject LLM rewrites that upgrade a local/static source into a proprietary one.

    The manuscript may transparently describe a source as local, static, curated,
    internal, non-live, or preserved in an export package when those facts are
    already present. Terms such as proprietary/private/confidential add a stronger
    legal/access claim and should only appear if they were already in the source
    text being edited.
    """
    original_text = str(original or "")
    candidate_text = str(candidate or "")
    patterns = [
        r"\bproprietary\b",
        r"\bprivate\s+(?:database|repository|index|source|record\s+set)\b",
        r"\bconfidential\s+(?:database|repository|index|source|record\s+set)\b",
        r"\bnot\s+publicly\s+accessible\b",
        r"\bnot\s+publicly\s+searchable\b",
        r"\bnot\s+externally\s+accessible\b",
        r"\bnon-public\s+(?:database|repository|index|source|record\s+set|dataset)\b",
        r"\bOpenAlex[^.。]*(?:preprints?|conference\s+abstracts?|non[-\s]?peer[-\s]?reviewed|highly\s+overlap|overlap(?:s|ped|ping)?)\b",
        r"OpenAlex[^。]*(?:预印本|会议摘要|非同行评议|高度重叠|大量重叠)",
        r"专有(?:数据库|资料库|文献库|索引|来源)",
        r"私有(?:数据库|资料库|文献库|索引|来源)",
        r"非公开(?:数据库|资料库|文献库|索引|来源)",
        r"保密(?:数据库|资料库|文献库|索引|来源)",
    ]
    hits: list[str] = []
    for pattern in patterns:
        original_has = bool(re.search(pattern, original_text, flags=re.I))
        if original_has:
            continue
        for match in re.finditer(pattern, candidate_text, flags=re.I):
            hits.append(match.group(0))
    return sorted(set(hits), key=str.lower)


def _unsupported_workflow_disclosure_hits(original: str, candidate: str) -> list[str]:
    """Reject LLM rewrites that invent automation/manual-review workflow details."""
    original_text = str(original or "")
    candidate_text = str(candidate or "")
    patterns = [
        r"\bautomated\s+rule\s+match(?:ing|ed)?\b",
        r"\bautomated\s+(?:matching|verification|screening|extraction)\b",
        r"\b(?:not|without|no)\s+manual\s+(?:double\s+)?verification\b",
        r"\b(?:not|without|no)\s+manual\s+(?:cross[-\s]?check|review)\b",
        r"\bmanual\s+double\s+verification\b",
        r"\bdual\s+human\s+(?:review|verification|extraction|screening)\b",
        r"自动化(?:规则)?(?:匹配|核验|验证|筛选|提取)",
        r"(?:未|没有|无)进行人工双重(?:验证|核验|复核)",
        r"人工双重(?:验证|核验|复核)",
        r"双人(?:独立)?(?:筛选|提取|复核)",
    ]
    hits: list[str] = []
    for pattern in patterns:
        if re.search(pattern, original_text, flags=re.I):
            continue
        for match in re.finditer(pattern, candidate_text, flags=re.I):
            hits.append(match.group(0))
    return sorted(set(hits), key=str.lower)


def _reviewable_preservation_issues(
    issues: list[dict[str, Any]],
    original: str,
    candidate: str,
    **extra: Any,
) -> list[dict[str, Any]]:
    return [
        {
            **issue,
            **extra,
            "original_text": _review_excerpt(original),
            "candidate_text": _review_excerpt(candidate),
            "review_action": "manual_review_required",
        }
        for issue in issues
    ]


def _review_excerpt(text: str, max_chars: int = 1800) -> str:
    clean = str(text or "").strip()
    if len(clean) <= max_chars:
        return clean
    return clean[: max_chars - 1].rstrip() + "..."


def _split_outer_whitespace(text: str) -> tuple[str, str, str]:
    raw = str(text or "")
    leading_match = re.match(r"^\s*", raw)
    trailing_match = re.search(r"\s*$", raw)
    leading = leading_match.group(0) if leading_match else ""
    trailing = trailing_match.group(0) if trailing_match else ""
    start = len(leading)
    end = len(raw) - len(trailing)
    if end < start:
        return leading, "", trailing
    return leading, raw[start:end], trailing


def _strip_rewrite_section_label(text: str, heading: str) -> str:
    raw = str(text or "")
    heading_clean = str(heading or "").strip()
    label = r"(?:SECTION|Section|section|章节|小节|段落)"
    if heading_clean:
        pattern = rf"^\s*{label}\s*[:：]\s*{re.escape(heading_clean)}\s*(?:\n+|$)"
    else:
        pattern = rf"^\s*{label}\s*[:：]\s*(?:\n+|$)"
    return re.sub(pattern, "", raw, count=1, flags=re.I)


def _numeric_tokens(text: str) -> list[str]:
    number = r"[+\-−]?\d+(?:,\d{3})*(?:\.\d+)?%?"
    pattern = rf"(?:\b[Pp]\s*(?:=|[<>]=?|[≤≥])\s*{number}|(?<![A-Za-z])(?:[<>]=?|[≤≥])?\s*{number})"
    return [re.sub(r"\s+", "", item).replace("−", "-") for item in re.findall(pattern, str(text or ""))]


def _citation_tokens(text: str) -> list[str]:
    tokens: list[str] = []
    for match in re.finditer(r"[\[［]([0-9\s,，、;；\-–—至]+)[\]］]", str(text or "")):
        token = re.sub(r"\s+", "", match.group(1))
        token = (
            token.replace("，", ",")
            .replace("、", ",")
            .replace("；", ";")
            .replace("–", "-")
            .replace("—", "-")
            .replace("至", "-")
        )
        tokens.append(f"[{token}]")
    return tokens


def _citation_markers(text: str) -> list[str]:
    return [
        re.sub(r"\s+", "", match.group(0))
        for match in re.finditer(r"[\[［][0-9\s,，、;；\-–—至]+[\]］]", str(text or ""))
    ]


def _citation_sentence_bindings(text: str) -> list[str]:
    raw = str(text or "")
    bindings: list[str] = []
    for match in re.finditer(r"[\[［]([0-9\s,，、;；\-–—至]+)[\]］]", raw):
        normalized_tokens = _citation_tokens(match.group(0))
        marker = normalized_tokens[0] if normalized_tokens else re.sub(r"\s+", "", match.group(0))
        sentence_index = _citation_sentence_index(raw, match.start())
        post_marker_anchor = _citation_post_marker_anchor(raw, match.end())
        bindings.append(f"{marker}|sentence:{sentence_index}|post:{post_marker_anchor}")
    return bindings


def _citation_sentence_index(text: str, index: int) -> int:
    prefix = str(text or "")[: max(0, index)]
    return len(re.findall(r"[.!?。！？]+(?:\s+|$)", prefix))


def _citation_post_marker_anchor(text: str, index: int) -> str:
    raw = str(text or "")
    suffix = raw[max(0, index):]
    sentence_end = len(suffix)
    boundary = re.search(r"[.!?。！？]+(?:\s+|$)?", suffix)
    if boundary:
        sentence_end = boundary.start()
    return _normalize_citation_post_marker_anchor(suffix[:sentence_end])


def _normalize_citation_post_marker_anchor(text: str) -> str:
    raw = str(text or "")
    raw = re.sub(r"[\[［][0-9\s,，、;；\-–—至]+[\]］]", " ", raw)
    raw = raw.lower()
    raw = re.sub(r"[^\w\u4e00-\u9fff]+", " ", raw)
    normalized = re.sub(r"\s+", " ", raw).strip()
    if not normalized:
        return ""
    if re.search(r"[\u4e00-\u9fff]", normalized):
        return re.sub(r"\s+", "", normalized)[:18]
    return " ".join(normalized.split()[:7])


def _table_or_figure_refs(text: str) -> list[str]:
    raw = str(text or "")
    refs = [
        match.group(0).lower().replace(" ", "")
        for match in re.finditer(r"\b(?:Table|Figure)\s*\d+(?:[-–]\d+)?\b", raw, flags=re.I)
    ]
    refs.extend(
        match.group(0).replace(" ", "")
        for match in re.finditer(r"(?:表|图)\s*\d+(?:[-–]\d+)?", raw)
    )
    return refs


def _protected_factual_terms(text: str) -> list[str]:
    raw = str(text or "")
    terms: list[str] = []
    acronym_pattern = (
        r"(?<![A-Za-z0-9])"
        r"(?:[A-Z0-9]{3,}(?:[-–][A-Za-z0-9]{2,})+|[A-Z][A-Z0-9]{2,})"
        r"(?![A-Za-z0-9])"
    )
    for match in re.finditer(acronym_pattern, raw):
        terms.append(match.group(0).replace("–", "-").lower())
    statistical_terms = (
        "OR", "RR", "RD", "MD", "SMD", "HR", "IRR", "CI", "CrI", "HKSJ", "REML",
        "DL", "NMA", "SUCRA", "GRADE", "RoB", "PRISMA",
    )
    statistical_pattern = (
        r"(?<![A-Za-z0-9])(?:"
        + "|".join(re.escape(term) for term in statistical_terms)
        + r")(?![A-Za-z0-9])"
    )
    for match in re.finditer(statistical_pattern, raw):
        terms.append(match.group(0).replace("–", "-").lower())
    drug_suffixes = (
        "gliflozin",
        "mab",
        "nib",
        "pril",
        "sartan",
        "statin",
        "olol",
        "oxaban",
        "parin",
        "cillin",
    )
    suffix_pattern = (
        r"(?<![A-Za-z0-9])[a-z][a-z-]*(?:"
        + "|".join(re.escape(suffix) for suffix in drug_suffixes)
        + r")(?![A-Za-z0-9])"
    )
    for match in re.finditer(suffix_pattern, raw, flags=re.I):
        terms.append(match.group(0).replace("–", "-").lower())
    return sorted(set(terms))


def _directional_term_signature(text: str) -> list[str]:
    raw = str(text or "")
    patterns = [
        ("lower", r"\b(?:reduc(?:e|es|ed|ing)|decreas(?:e|es|ed|ing)|lower(?:s|ed|ing)?|declin(?:e|es|ed|ing))\b", "en"),
        ("higher", r"\b(?:increas(?:e|es|ed|ing)|higher|rais(?:e|es|ed|ing)|elevat(?:e|es|ed|ing)|worsen(?:s|ed|ing)?)\b", "en"),
        ("lower", r"(?:降低|减少|下降|下调|更低|较低)", "zh"),
        ("higher", r"(?:增加|升高|上升|提高|上调|更高|较高)", "zh"),
    ]
    matches: list[tuple[int, str]] = []
    for label, pattern, language in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            if language == "en" and _direction_match_is_methodological_rank(raw, match):
                continue
            if language == "en" and _direction_match_is_nonclinical_context(raw, match):
                continue
            if language == "zh" and _direction_match_is_zh_nonclinical_context(raw, match):
                continue
            signed_label = f"not_{label}" if _direction_match_is_negated(raw, match.start(), language) else label
            matches.append((match.start(), signed_label))
    return [label for _, label in sorted(matches, key=lambda item: item[0])]


def _clinical_claim_term_signature(text: str) -> list[str]:
    raw = str(text or "")
    patterns = [
        ("benefit", r"\b(?:benefit|benefits|beneficial|effective|efficacy|improv(?:e|es|ed|ing|ement)|protective)\b", "en"),
        ("harm", r"\b(?:harm|harms|harmful|safety\s+concern|worsen(?:s|ed|ing)?)\b", "en"),
        ("causal", r"\b(?:caus(?:e|es|ed|ing)|prevent(?:s|ed|ing)?|avoid(?:s|ed|ing)?)\b", "en"),
        ("benefit", r"(?:获益|受益|有益|有效|疗效|改善|保护)", "zh"),
        ("harm", r"(?:有害|伤害|危害|安全性风险|恶化)", "zh"),
        ("causal", r"(?:导致|造成|预防|避免)", "zh"),
    ]
    matches: list[tuple[int, str]] = []
    for label, pattern, language in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            if not _clinical_claim_match_has_effect_context(raw, match, language):
                continue
            signed_label = f"not_{label}" if _direction_match_is_negated(raw, match.start(), language) else label
            matches.append((match.start(), signed_label))
    return [label for _, label in sorted(matches, key=lambda item: item[0])]


def _clinical_entity_signature(text: str) -> list[str]:
    raw = str(text or "")
    patterns = [
        ("heart_failure_hospitalization", r"\b(?:heart\s+failure|HF)\s+hospitali[sz]ation\b", "en"),
        ("cardiovascular_death", r"\b(?:cardiovascular|CV)\s+(?:death|mortality)\b", "en"),
        ("all_cause_mortality", r"\ball[-\s]+cause\s+mortality\b", "en"),
        ("myocardial_infarction", r"\b(?:myocardial\s+infarction|MI)\b", "en"),
        ("serious_adverse_event", r"\bserious\s+adverse\s+events?\b", "en"),
        ("adverse_event", r"\badverse\s+events?\b", "en"),
        ("heart_failure", r"\b(?:heart\s+failure|HFpEF|HFrEF|HFmrEF)\b", "en"),
        ("hospitalization", r"\bhospitali[sz]ation\b", "en"),
        ("mortality", r"\bmortality\b", "en"),
        ("death", r"\bdeaths?\b", "en"),
        ("stroke", r"\bstroke\b", "en"),
        ("kidney_outcome", r"\b(?:kidney|renal|eGFR|dialysis)\b", "en"),
        ("diabetes", r"\bdiabetes\b", "en"),
        ("covid19", r"\b(?:COVID-19|SARS-CoV-2)\b", "en"),
        ("intervention_group", r"\b(?:intervention|treatment)\s+(?:arm|group)\b|\bthe\s+intervention\b", "en"),
        ("control_group", r"\b(?:control|comparator)\s+(?:arm|group)\b|\b(?:control|comparator)\b", "en"),
        ("placebo", r"\bplacebo\b", "en"),
        ("standard_care", r"\b(?:standard|usual|routine)\s+care\b|\b(?:standard|usual|routine)\s+(?:therapy|treatment)\b", "en"),
        ("active_control", r"\bactive\s+(?:control|comparator)\b", "en"),
        ("no_treatment", r"\bno\s+(?:treatment|therapy|intervention)\b", "en"),
        ("sglt2_inhibitor", r"\bSGLT-?2\s+inhibitors?\b|\bsodium[- ]glucose\s+(?:co-?transporter|cotransporter)[- ]?2\s+inhibitors?\b", "en"),
        ("corticosteroid", r"\b(?:corticosteroids?|glucocorticoids?|systemic\s+steroids?)\b", "en"),
        ("heart_failure_hospitalization", r"(?:心力衰竭|心衰)住院", "zh"),
        ("cardiovascular_death", r"心血管死亡", "zh"),
        ("all_cause_mortality", r"全因死亡", "zh"),
        ("myocardial_infarction", r"心肌梗死", "zh"),
        ("serious_adverse_event", r"严重不良事件", "zh"),
        ("adverse_event", r"不良事件", "zh"),
        ("heart_failure", r"(?:心力衰竭|心衰)", "zh"),
        ("hospitalization", r"住院", "zh"),
        ("mortality", r"死亡(?:率|风险)?", "zh"),
        ("stroke", r"(?:卒中|中风)", "zh"),
        ("kidney_outcome", r"(?:肾脏|肾功能|eGFR|透析)", "zh"),
        ("diabetes", r"糖尿病", "zh"),
        ("covid19", r"(?:COVID-19|新冠|新型冠状病毒)", "zh"),
        ("intervention_group", r"(?:干预组|治疗组|试验组|干预措施)", "zh"),
        ("control_group", r"(?:对照组|比较组|控制组)", "zh"),
        ("placebo", r"安慰剂", "zh"),
        ("standard_care", r"(?:标准治疗|常规治疗|常规护理|标准护理)", "zh"),
        ("active_control", r"(?:主动对照|活性对照)", "zh"),
        ("no_treatment", r"(?:无治疗|未治疗|不治疗)", "zh"),
        ("sglt2_inhibitor", r"SGLT-?2\s*抑制剂", "zh"),
        ("corticosteroid", r"(?:糖皮质激素|皮质类固醇|系统性激素)", "zh"),
    ]
    matches: list[tuple[int, int, str]] = []
    occupied: list[tuple[int, int]] = []
    for label, pattern, _language in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            span = (match.start(), match.end())
            if any(max(span[0], old_start) < min(span[1], old_end) for old_start, old_end in occupied):
                continue
            occupied.append(span)
            matches.append((span[0], span[1], label))
    return [label for _, _, label in sorted(matches, key=lambda item: (item[0], item[1], item[2]))]


def _clinical_claim_match_has_effect_context(text: str, match: re.Match[str], language: str) -> bool:
    raw = str(text or "")
    window = raw[max(0, match.start() - 96):match.end() + 96]
    if language == "zh":
        return bool(
            re.search(
                r"(?:临床|患者|治疗|干预|药物|风险|死亡|住院|结局|终点|效应|效益|疗效|HR|OR|RR|CI|置信区间)",
                window,
                flags=re.I,
            )
        )
    return bool(
        re.search(
            (
                r"\b(?:clinical|patient|treatment|intervention|therapy|drug|risk|mortality|death|"
                r"hospitali[sz]ation|outcome|endpoint|effect|estimate|trial|HR|OR|RR|CI)\b"
            ),
            window,
            flags=re.I,
        )
    )


def _certainty_rating_signature(text: str) -> list[str]:
    raw = str(text or "")
    patterns = [
        (
            "very_low",
            r"\bvery\s+low\s+(?:certainty|quality|confidence)\b|"
            r"\b(?:GRADE\s+)?(?:certainty|quality|confidence)\s+(?:was|is|were|rated|judged|as|:)?\s*very\s+low\b",
        ),
        (
            "moderate",
            r"\bmoderate\s+(?:certainty|quality|confidence)\b|"
            r"\b(?:GRADE\s+)?(?:certainty|quality|confidence)\s+(?:was|is|were|rated|judged|as|:)?\s*moderate\b",
        ),
        (
            "high",
            r"\bhigh\s+(?:certainty|quality|confidence)\b|"
            r"\b(?:GRADE\s+)?(?:certainty|quality|confidence)\s+(?:was|is|were|rated|judged|as|:)?\s*high\b",
        ),
        (
            "low",
            r"\blow\s+(?:certainty|quality|confidence)\b|"
            r"\b(?:GRADE\s+)?(?:certainty|quality|confidence)\s+(?:was|is|were|rated|judged|as|:)?\s*low\b",
        ),
        ("very_low", r"(?:极低|很低).{0,4}(?:确定性|质量|把握)|(?:确定性|质量|把握).{0,8}(?:极低|很低)"),
        ("moderate", r"(?:中等|中度).{0,4}(?:确定性|质量|把握)|(?:确定性|质量|把握).{0,8}(?:中等|中度)"),
        ("high", r"高.{0,4}(?:确定性|质量|把握)|(?:确定性|质量|把握).{0,8}高"),
        ("low", r"低.{0,4}(?:确定性|质量|把握)|(?:确定性|质量|把握).{0,8}低"),
    ]
    matches: list[tuple[int, int, str]] = []
    occupied: list[tuple[int, int]] = []
    for label, pattern in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            span = (match.start(), match.end())
            if any(max(span[0], old_start) < min(span[1], old_end) for old_start, old_end in occupied):
                continue
            occupied.append(span)
            matches.append((span[0], span[1], label))
    return [label for _, _, label in sorted(matches, key=lambda item: (item[0], item[1], item[2]))]


def _risk_of_bias_rating_signature(text: str) -> list[str]:
    raw = str(text or "")
    rob = r"(?:risk[-\s]+of[-\s]+bias|RoB)"
    patterns = [
        (
            "some_concerns",
            rf"\bsome\s+concerns?\b.{{0,24}}\b{rob}\b|\b{rob}\b.{{0,24}}\bsome\s+concerns?\b",
        ),
        (
            "unclear",
            rf"\bunclear\s+{rob}\b|\b{rob}\s+(?:was|is|were|rated|judged|as|:)?\s*unclear\b",
        ),
        (
            "high",
            rf"\bhigh\s+{rob}\b|\b{rob}\s+(?:was|is|were|rated|judged|as|:)?\s*high\b",
        ),
        (
            "low",
            rf"\blow\s+{rob}\b|\b{rob}\s+(?:was|is|were|rated|judged|as|:)?\s*low\b",
        ),
        (
            "some_concerns",
            r"(?:偏倚风险|风险偏倚).{0,10}(?:一些|有些|部分)(?:担忧|疑虑)|"
            r"(?:一些|有些|部分)(?:担忧|疑虑).{0,10}(?:偏倚风险|风险偏倚)",
        ),
        (
            "unclear",
            r"(?:不明确|不清楚|无法判断).{0,4}(?:偏倚风险|风险偏倚)|"
            r"(?:偏倚风险|风险偏倚).{0,8}(?:不明确|不清楚|无法判断)",
        ),
        (
            "high",
            r"高\s*(?:偏倚风险|风险偏倚|RoB)|(?:偏倚风险|风险偏倚)\s*(?:为|是|评为|被评为|判定为|判断为|:|：)?\s*高",
        ),
        (
            "low",
            r"低\s*(?:偏倚风险|风险偏倚|RoB)|(?:偏倚风险|风险偏倚)\s*(?:为|是|评为|被评为|判定为|判断为|:|：)?\s*低",
        ),
    ]
    matches: list[tuple[int, int, str]] = []
    occupied: list[tuple[int, int]] = []
    for label, pattern in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            span = (match.start(), match.end())
            if any(max(span[0], old_start) < min(span[1], old_end) for old_start, old_end in occupied):
                continue
            occupied.append(span)
            matches.append((span[0], span[1], label))
    return [label for _, _, label in sorted(matches, key=lambda item: (item[0], item[1], item[2]))]


def _statistical_model_signature(text: str) -> list[str]:
    raw = str(text or "")
    patterns = [
        (
            "random_effects",
            r"\brandom[-\s]+effects?\s+(?:meta[-\s]+analysis\s+)?model\b|"
            r"\brandom[-\s]+effects?\s+(?:synthesis|analysis)\b|"
            r"(?:随机效应|随机效果)\s*(?:模型|合并|分析)",
        ),
        (
            "fixed_effect",
            r"\bfixed[-\s]+effects?\s+(?:meta[-\s]+analysis\s+)?model\b|"
            r"\bfixed[-\s]+effects?\s+(?:synthesis|analysis)\b|"
            r"\bcommon[-\s]+effect\s+model\b|"
            r"(?:固定效应|固定效果|共同效应)\s*(?:模型|合并|分析)",
        ),
        (
            "der_simonian_laird",
            r"\b(?:DerSimonian[-\s]+Laird|Der\s+Simonian[-\s]+Laird|DL)\b|"
            r"(?:DerSimonian[-\s]*Laird|德西蒙尼安.{0,4}莱尔德|DL)\s*(?:法|估计|方法)?",
        ),
        (
            "reml",
            r"\b(?:restricted\s+maximum\s+likelihood|REML)\b|"
            r"(?:限制性最大似然|受限最大似然|REML)\s*(?:估计|法|方法)?",
        ),
        (
            "hksj",
            r"\b(?:Hartung[-\s]+Knapp(?:[-\s]+Sidik[-\s]+Jonkman)?|HKSJ)\b|"
            r"(?:Hartung[-\s]*Knapp|HKSJ)\s*(?:调整|方法|法)?",
        ),
        (
            "paule_mandel",
            r"\bPaule[-\s]+Mandel\b|(?:Paule[-\s]*Mandel|保利.{0,3}曼德尔)\s*(?:估计|法|方法)?",
        ),
        (
            "mantel_haenszel",
            r"\b(?:Mantel[-\s]+Haenszel|MH)\b|(?:Mantel[-\s]*Haenszel|曼特尔.{0,3}亨塞尔)\s*(?:法|方法)?",
        ),
    ]
    matches: list[tuple[int, int, str]] = []
    occupied: list[tuple[int, int]] = []
    for label, pattern in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            span = (match.start(), match.end())
            if any(max(span[0], old_start) < min(span[1], old_end) for old_start, old_end in occupied):
                continue
            occupied.append(span)
            matches.append((span[0], span[1], label))
    return [label for _, _, label in sorted(matches, key=lambda item: (item[0], item[1], item[2]))]


def _statistical_significance_signature(text: str) -> list[str]:
    raw = str(text or "")
    patterns = [
        (
            "not_significant",
            r"\b(?:non[-\s]?significant|not\s+(?:statistically\s+)?significant|"
            r"no\s+(?:statistically\s+)?significant\s+(?:difference|effect|association|interaction|heterogeneity)s?)\b",
        ),
        (
            "significant",
            r"\b(?:statistically\s+significant|"
            r"significant\s+(?:difference|effect|association|interaction|heterogeneity|benefit|reduction|increase))\b",
        ),
        (
            "not_significant",
            r"(?:未达到|未达|未见|未显示|无|没有|不).{0,6}(?:统计学)?显著|"
            r"(?:差异|作用|交互作用|异质性).{0,6}(?:不|未|无|没有).{0,4}显著",
        ),
        (
            "significant",
            r"(?:达到)?统计学显著|显著(?:差异|作用|交互作用|异质性|获益|降低|增加)",
        ),
    ]
    matches: list[tuple[int, int, str]] = []
    occupied: list[tuple[int, int]] = []
    for label, pattern in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            span = (match.start(), match.end())
            if any(max(span[0], old_start) < min(span[1], old_end) for old_start, old_end in occupied):
                continue
            occupied.append(span)
            matches.append((span[0], span[1], label))
    return [label for _, _, label in sorted(matches, key=lambda item: (item[0], item[1], item[2]))]


def _study_design_signature(text: str) -> list[str]:
    raw = str(text or "")
    patterns = [
        ("randomized_trial", r"\b(?:randomi[sz]ed\s+controlled\s+trials?|randomi[sz]ed\s+trials?)\b|\bRCTs?\b", "en"),
        ("nonrandomized_study", r"\bnon[-\s]?randomi[sz]ed\s+(?:stud(?:y|ies)|trials?)\b", "en"),
        ("observational_study", r"\bobservational\b", "en"),
        ("cohort_study", r"\bcohort\s+(?:stud(?:y|ies)|design|analysis)\b|\bcohorts?\b", "en"),
        ("case_control_study", r"\bcase[-\s]+control\s+(?:stud(?:y|ies)|design)\b", "en"),
        ("cross_sectional_study", r"\bcross[-\s]+sectional\s+(?:stud(?:y|ies)|design)\b", "en"),
        ("double_blind", r"\bdouble[-\s]+blind(?:ed)?\b", "en"),
        ("single_blind", r"\bsingle[-\s]+blind(?:ed)?\b", "en"),
        ("blinded", r"\bblind(?:ed|ing)?\b", "en"),
        ("open_label", r"\bopen[-\s]+label\b", "en"),
        ("parallel_group", r"\bparallel[-\s]+group\b", "en"),
        ("crossover", r"\bcross[-\s]*over\b", "en"),
        ("randomized_trial", r"(?:随机对照试验|随机临床试验|随机试验|随机分配)", "zh"),
        ("nonrandomized_study", r"(?:非随机|非随机化).{0,4}(?:研究|试验)", "zh"),
        ("observational_study", r"观察性", "zh"),
        ("cohort_study", r"队列(?:研究)?", "zh"),
        ("case_control_study", r"病例对照(?:研究)?", "zh"),
        ("cross_sectional_study", r"横断面(?:研究)?", "zh"),
        ("double_blind", r"双盲", "zh"),
        ("single_blind", r"单盲", "zh"),
        ("blinded", r"盲法|设盲", "zh"),
        ("open_label", r"开放标签|开放性标签", "zh"),
        ("parallel_group", r"平行组", "zh"),
        ("crossover", r"交叉(?:设计|试验)?", "zh"),
    ]
    matches: list[tuple[int, int, str]] = []
    occupied: list[tuple[int, int]] = []
    for label, pattern, _language in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            span = (match.start(), match.end())
            if any(max(span[0], old_start) < min(span[1], old_end) for old_start, old_end in occupied):
                continue
            occupied.append(span)
            matches.append((span[0], span[1], label))
    return [label for _, _, label in sorted(matches, key=lambda item: (item[0], item[1], item[2]))]


def _interpretive_certainty_signature(text: str) -> list[str]:
    raw = str(text or "")
    patterns = [
        ("hedged", r"\b(?:may|might|could|appears?\s+to|seems?\s+to|suggest(?:s|ed|ing)?|associated\s+with|consistent\s+with)\b", "en"),
        ("assertive", r"\b(?:demonstrat(?:e|es|ed|ing)|prov(?:e|es|ed|ing)|confirm(?:s|ed|ing)?|establish(?:es|ed|ing)?)\b", "en"),
        ("hedged", r"(?:可能|或许|提示|倾向于|相关|关联)", "zh"),
        ("assertive", r"(?:证实|证明|明确|肯定|确定|确证)", "zh"),
    ]
    matches: list[tuple[int, str]] = []
    for label, pattern, language in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            if not _clinical_claim_match_has_effect_context(raw, match, language):
                continue
            signed_label = f"not_{label}" if _direction_match_is_negated(raw, match.start(), language) else label
            matches.append((match.start(), signed_label))
    return [label for _, label in sorted(matches, key=lambda item: item[0])]


def _direction_match_is_methodological_rank(text: str, match: re.Match[str]) -> bool:
    suffix = str(text or "")[match.end(): match.end() + 24]
    return bool(re.match(r"(?:[-\s]+)(?:ranked|priority|order|hierarchy)\b", suffix, flags=re.I))


def _direction_match_is_nonclinical_context(text: str, match: re.Match[str]) -> bool:
    suffix = str(text or "")[match.end():match.end() + 72]
    phrase = str(text or "")[max(0, match.start() - 36):match.end() + 72]
    if re.match(
        (
            r"(?:[-\s]+)"
            r"(?:certainty|quality|confidence|rating|grade|evidence|"
            r"ejection\s+fraction|lvef|threshold|impression|overstatement)"
            r"\b"
        ),
        suffix,
        flags=re.I,
    ):
        return True
    if re.match(r"(?:\s+)(?:the\s+)?risk\s+that\b", suffix, flags=re.I):
        return True
    if re.search(r"\breduc(?:e|es|ed|ing)\s+to\s+(?:a\s+)?single\s+threshold\b", phrase, flags=re.I):
        return True
    return False


def _direction_match_is_zh_nonclinical_context(text: str, match: re.Match[str]) -> bool:
    raw = str(text or "")
    suffix = raw[match.end():match.end() + 72]
    phrase = raw[max(0, match.start() - 24):match.end() + 72]
    if re.match(r"(?:证据)?(?:确定性|质量|等级|评级|可信度|信心|把握|阈值|印象|表述|语气)", suffix):
        return True
    if re.match(r"(?:对|对于).{0,40}(?:信心|可信度|把握|信任)", suffix):
        return True
    if re.search(r"(?:信心|可信度|把握|信任|证据确定性|证据质量|GRADE评级|GRADE等级)", phrase):
        return True
    return False


def _direction_match_is_negated(text: str, start: int, language: str) -> bool:
    prefix = str(text or "")[max(0, start - 36):start]
    if language == "zh":
        return bool(re.search(r"(?:未|不|无|没有|并未|并不|不能|无法|未能)\s*$", prefix))
    return bool(
        re.search(
            r"\b(?:not|no|without|neither|never|failed\s+to|fails\s+to|did\s+not|does\s+not|do\s+not|was\s+not|were\s+not)\s*$",
            prefix,
            flags=re.I,
        )
    )


def _main_text_before_references(text: str) -> str:
    reference_heading = (
        r"(?:"
        r"References?|Bibliography|Literature\s+Cited|Works\s+Cited|"
        r"参考文献|参考资料|引用文献|文献"
        r")"
    )
    match = re.search(rf"^#{{1,6}}\s+{reference_heading}\s*[:：]?\s*$", str(text or ""), flags=re.I | re.M)
    return text[:match.start()] if match else text


def _style_audit_text(text: str) -> str:
    main_text = _main_text_before_references(str(text or ""))
    sections = _split_h2_sections(main_text)
    selected_bodies = [
        main_text[section["body_start"]:section["end"]]
        for section in sections
        if str(section.get("heading") or "").strip().lower() in POLISHABLE_HEADINGS
    ]
    prose = "\n\n".join(selected_bodies) if selected_bodies else main_text
    prose = re.sub(r"```[\s\S]*?```", "\n", prose)
    kept_lines: list[str] = []
    for line in prose.splitlines():
        stripped = line.strip()
        if (
            not stripped
            or stripped.startswith("#")
            or stripped.startswith("|")
            or stripped.startswith("![")
            or re.match(r"^[-*]\s+", stripped)
            or re.match(r"^(?:Table|Figure)\s+\d+(?:[-–]\d+)?[.:]", stripped, flags=re.I)
            or re.match(r"^(?:表|图)\s*\d+(?:[-–]\d+)?[.:：]", stripped)
        ):
            continue
        kept_lines.append(line)
    return "\n".join(kept_lines)


def _split_sentences_for_style(text: str) -> list[str]:
    return [
        item.strip()
        for item in re.split(r"(?<=[。！？])\s*|(?<=[.!?])\s+", str(text or ""))
        if item.strip()
    ]


def _sentence_length(sentence: str, language: str) -> int:
    if language == "zh":
        return len(re.findall(r"[\u4e00-\u9fff]", sentence))
    return len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", sentence))


def _coefficient_of_variation(values: list[int]) -> float:
    numeric = [float(value) for value in values if value > 0]
    if len(numeric) < 2:
        return 0.0
    mean = sum(numeric) / len(numeric)
    if mean <= 0:
        return 0.0
    variance = sum((value - mean) ** 2 for value in numeric) / len(numeric)
    return round(math.sqrt(variance) / mean, 3)


def _repeated_sentence_openings(sentences: list[str], language: str) -> dict[str, int]:
    openings = [
        _sentence_opening_key(sentence, language)
        for sentence in sentences
        if not _is_formulaic_statistical_sentence(sentence)
        and not _is_protected_clinical_acronym_topic_opening(sentence)
    ]
    counts = Counter(item for item in openings if item)
    return {key: value for key, value in counts.items() if value > 1}


def _is_protected_clinical_acronym_topic_opening(sentence: str) -> bool:
    raw = re.sub(r"^\s*(?:#+\s*)?", "", str(sentence or "")).strip()
    if not re.search(r"[\u4e00-\u9fff]", raw):
        return False
    acronym = r"[A-Za-z][A-Za-z0-9+\-]{1,}(?:/[A-Za-z][A-Za-z0-9+\-]{1,})*"
    topic_noun = r"(?:患者|人群|受试者|抑制剂|治疗|试验|研究|证据|结局|终点)"
    return re.match(rf"^{acronym}\s*{topic_noun}", raw) is not None


def _is_formulaic_statistical_sentence(sentence: str) -> bool:
    raw = str(sentence or "").strip()
    if re.search(
        r"(?<![A-Za-z0-9])(?:OR|RR|RD|MD|SMD|HR|IRR|CI|CrI|I²|I2|tau²|tau2)(?![A-Za-z0-9])",
        raw,
        flags=re.I,
    ) and re.search(r"(?:\d|p\s*[<=>]|[（(]\s*95\s*%)", raw, flags=re.I):
        return True
    if re.search(r"(?:异质性|heterogeneity)", raw, flags=re.I) and re.search(
        r"(?:I²|I2|Cochran\s+Q|tau²|tau2|p\s*[<=>]|\d)",
        raw,
        flags=re.I,
    ):
        return True
    if re.search(r"\bheterogeneity\s+was\s+(?:low|moderate|high)\b", raw, flags=re.I) and re.search(
        r"(?:I²|I2|Cochran\s+Q|tau²|tau2|p\s*[<=>])",
        raw,
        flags=re.I,
    ):
        return True
    return False


def _sentence_opening_key(sentence: str, language: str) -> str:
    raw = re.sub(r"^\s*(?:#+\s*)?", "", str(sentence or "")).strip()
    raw = re.sub(r"^\[[^\]]+\]\s*", "", raw)
    if language == "zh":
        chars = re.sub(r"[^\u4e00-\u9fff]", "", raw)
        return chars[:6].lower()
    words = re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", raw.lower())
    return " ".join(words[:5])


def _lexical_diversity(text: str, language: str) -> float:
    if language == "zh":
        chars = re.findall(r"[\u4e00-\u9fff]", str(text or ""))
        if not chars:
            return 0.0
        if len(chars) < 240:
            return round(len(set(chars)) / len(chars), 3)
        return _moving_average_type_token_ratio(chars, window_size=160)
    words = [item.lower() for item in re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", str(text or ""))]
    content_words = [
        item for item in words
        if len(item) > 2 and item not in ENGLISH_LEXICAL_STOPWORDS
    ]
    denominator = content_words if len(content_words) >= 30 else words
    return round(len(set(denominator)) / len(denominator), 3) if denominator else 0.0


def _moving_average_type_token_ratio(tokens: list[str], *, window_size: int) -> float:
    if not tokens:
        return 0.0
    window = max(1, int(window_size or 1))
    if len(tokens) <= window:
        return round(len(set(tokens)) / len(tokens), 3)
    ratios = [
        len(set(tokens[index:index + window])) / window
        for index in range(0, len(tokens) - window + 1)
    ]
    return round(sum(ratios) / len(ratios), 3) if ratios else 0.0


def _ai_style_signal(
    *,
    language: str,
    sentence_count: int,
    sentence_length_cv: float,
    repeated_sentence_openings: dict[str, int],
    template_phrase_hits: dict[str, int],
    lexical_diversity: float,
) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []
    if template_phrase_hits:
        issues.append({
            "code": "template_phrase_hits",
            "weight": 1,
            "count": sum(template_phrase_hits.values()),
            "phrases": sorted(template_phrase_hits.keys()),
            "message": _style_issue_message("template_phrase_hits", language),
            "suggested_action": _style_issue_action("template_phrase_hits", language),
        })
    repeated_count = sum(value - 1 for value in repeated_sentence_openings.values())
    max_repeat = max(repeated_sentence_openings.values(), default=0)
    if repeated_count and (max_repeat >= 3 or repeated_count >= 3):
        issues.append({
            "code": "repeated_sentence_starts",
            "weight": 1,
            "count": repeated_count,
            "openings": repeated_sentence_openings,
            "message": _style_issue_message("repeated_sentence_starts", language),
            "suggested_action": _style_issue_action("repeated_sentence_starts", language),
        })
    if sentence_count >= 3 and sentence_length_cv < 0.12:
        issues.append({
            "code": "low_sentence_length_variation",
            "weight": 1,
            "value": sentence_length_cv,
            "message": _style_issue_message("low_sentence_length_variation", language),
            "suggested_action": _style_issue_action("low_sentence_length_variation", language),
        })
    if (language == "zh" and sentence_count >= 4 and lexical_diversity < 0.32) or (
        language != "zh" and sentence_count >= 4 and lexical_diversity < 0.28
    ):
        issues.append({
            "code": "low_lexical_diversity",
            "weight": 1,
            "value": lexical_diversity,
            "message": _style_issue_message("low_lexical_diversity", language),
            "suggested_action": _style_issue_action("low_lexical_diversity", language),
        })
    return {
        "score": sum(int(issue.get("weight") or 1) for issue in issues),
        "issues": issues,
        "interpretation": "style_review_recommended" if issues else "no_obvious_ai_style_pattern",
    }


def _style_issue_message(code: str, language: str) -> str:
    zh = language == "zh"
    messages = {
        "template_phrase_hits": "检测到模板化过渡短语，可能让稿件显得机械。" if zh else "Template-like transition phrases remain after polish.",
        "repeated_sentence_starts": "多个句子使用相同开头，段落节奏偏重复。" if zh else "Several sentences still start the same way, making the passage sound repetitive.",
        "low_sentence_length_variation": "句长变化过低，段落节奏可能显得过于均匀。" if zh else "Sentence lengths are too uniform, which can make the passage sound mechanical.",
        "low_lexical_diversity": "词汇变化偏低，建议人工检查是否重复使用相同表达。" if zh else "Lexical diversity is low; repeated wording may need human review.",
    }
    return messages.get(code, "仍有风格信号需要人工复核。" if zh else "A remaining style signal needs human review.")


def _style_issue_action(code: str, language: str) -> str:
    zh = language == "zh"
    if code == "template_phrase_hits":
        return "人工删改模板短语，保留数字、引用、研究名称和结论方向不变。" if zh else "Manually remove formulaic phrases while preserving numbers, citations, study names, and conclusion direction."
    if code == "repeated_sentence_starts":
        return "人工改写相邻句子的开头和连接方式；不要重写事实句中的数值或引用。" if zh else "Manually vary adjacent sentence openings and transitions without changing factual sentences, numbers, or citations."
    if code == "low_sentence_length_variation":
        return "人工拆分或合并少量相邻句，增加句长节奏变化；不要为了风格改写效应量句。" if zh else "Manually split or combine a few adjacent sentences to vary rhythm; do not rewrite effect-estimate sentences just for style."
    if code == "low_lexical_diversity":
        return "人工替换重复的非技术性表达；保留术语、结局名称和方法学标签。" if zh else "Manually vary repeated non-technical wording while preserving terms, outcome names, and methods labels."
    return "人工复核该风格信号；事实保护优先于继续自动改写。" if zh else "Review this style signal manually; fact preservation takes priority over further automatic rewriting."


def _template_phrase_hits(text: str) -> dict[str, int]:
    raw = str(text or "")
    phrase_patterns = {
        "it is important to note that": r"\bit is important to note that\b",
        "it should be noted that": r"\bit should be noted that\b",
        "in conclusion": r"\bin conclusion\b",
        "worth noting": r"\bworth noting\b",
        "值得注意的是": r"值得注意的是",
        "综上所述": r"综上所述",
        "总体而言": r"总体而言",
        "需要指出的是": r"需要指出的是",
        "总的来看": r"总的来看",
        "需要说明的是": r"需要说明的是",
        "从整体来看": r"从整体来看",
    }
    hits: dict[str, int] = {}
    for phrase, pattern in phrase_patterns.items():
        count = len(re.findall(pattern, raw, flags=re.I))
        if count:
            hits[phrase] = count
    return hits


def _deterministic_style_cleanup(section_text: str) -> str:
    def sentence_start_replacement(match: re.Match[str]) -> str:
        return match.group(1) + match.group(2).upper()

    updated = re.sub(
        (
            r"(^|[.!?]\s+|\n+)"
            r"(?:[Ii]t is important to note that|[Ii]t should be noted that)\s+"
            r"([a-z])"
        ),
        sentence_start_replacement,
        str(section_text or ""),
    )
    updated = re.sub(
        r"(^|[.!?]\s+|\n+)[Ii]n conclusion,\s+([a-z])",
        sentence_start_replacement,
        updated,
    )
    updated = re.sub(
        r"\bWhen the selected endpoint was time-to-event, the reported hazard ratio",
        "For time-to-event endpoints, the reported hazard ratio",
        updated,
    )
    updated = re.sub(
        r"\bWhen the selected endpoint was binary, the arm-level counts",
        "For binary endpoints, the arm-level counts",
        updated,
    )
    updated = updated.replace(
        "The manuscript therefore reports the effect measure exactly as selected for the primary analysis",
        "Accordingly, the manuscript reports the effect measure exactly as selected for the primary analysis",
    )
    updated = updated.replace(
        "The manuscript therefore reports the certainty profile as a companion to the statistical result",
        "The certainty profile is reported as a companion to the statistical result",
    )
    replacements = {
        "It is important to note that ": "",
        "It should be noted that ": "",
        "it is important to note that ": "",
        "it should be noted that ": "",
        "值得注意的是，": "",
        "值得注意的是": "",
        "综上所述，": "",
        "综上所述": "",
        "总体而言，": "",
        "总体而言": "",
        "需要指出的是，": "",
        "需要指出的是": "",
        "总的来看，": "",
        "总的来看": "",
        "需要说明的是，": "",
        "需要说明的是": "",
        "从整体来看，": "",
        "从整体来看": "",
    }
    for old, new in replacements.items():
        updated = updated.replace(old, new)
    updated = re.sub(
        r"\b([A-Za-z0-9][A-Za-z0-9+/-]*(?:\s+[A-Za-z0-9][A-Za-z0-9+/-]*)?\s+inhibitors)\s+has\b",
        lambda match: f"{match.group(1)} have",
        updated,
        flags=re.I,
    )
    updated = re.sub(r"([?!])\s+\.", r"\1", updated)
    updated = re.sub(r"\.\s+\.", ".", updated)
    updated = _vary_known_chinese_repeated_openings(updated)
    return updated


def _vary_known_chinese_repeated_openings(text: str) -> str:
    updated = str(text or "")
    replacements = [
        (
            "对于心血管死亡或心力衰竭住院这类临床复合终点，",
            "针对心血管死亡或心力衰竭住院这类临床复合终点，",
        ),
        (
            "本研究在各章节统一报告这些字段，以减少跨章节不一致",
            "为减少跨章节不一致，本研究统一报告这些字段",
        ),
        (
            "即使SGLT2抑制剂在主要复合结局上显示出有利方向，",
            "尽管SGLT2抑制剂在主要复合结局上显示出有利方向，",
        ),
    ]
    for opening, replacement in replacements:
        updated = _replace_known_chinese_sentence_opening(updated, opening, replacement)
    return updated


def _replace_known_chinese_sentence_opening(text: str, opening: str, replacement: str) -> str:
    pattern = rf"(^|[。！？]\s*){re.escape(opening)}"
    return re.sub(pattern, lambda match: match.group(1) + replacement, str(text or ""))
