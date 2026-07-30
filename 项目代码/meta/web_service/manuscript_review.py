"""Manuscript quality payloads, citation review and manuscript patching."""
from __future__ import annotations

import difflib
import logging
import re
from typing import Any

from web_service.context import (
    META_STEPS,
    REFERENCE_ADD_METHODOLOGY_SOURCE_TYPES,
    _resolve_project_dir,
    _make_ts,
)


logger = logging.getLogger(__name__)


def _load_manuscript_quality_payload(project, ctx: dict | None = None) -> dict | None:
    """Build a compact user-facing manuscript quality payload for Web clients."""
    from new_meta.core.artifact_package import (
        _build_citation_audit_review,
        _build_calculation_audit_review,
        _build_claim_support_audit_review,
        _build_clinical_interpretation_audit_review,
        _build_llm_reliability_audit_review,
        _build_primary_result_audit_review,
        _build_readability_audit_review,
    )

    ctx = ctx if isinstance(ctx, dict) else {}
    draft_path = project.get_path("draft.md", subdir="manuscript")
    if not draft_path.exists():
        return None
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace")

    references_bib = project.load_text("references.bib") or ""
    bib_reference_entries = len(re.findall(r"@\w+\s*\{", references_bib))
    citation_audit = None
    citation_error = ""
    try:
        citation_audit = _build_citation_audit_review(project)
    except Exception as exc:
        citation_error = str(exc)
        logger.warning("Citation audit payload generation failed: %s", exc, exc_info=True)
    readability_audit = None
    readability_error = ""
    try:
        readability_audit = _build_readability_audit_review(project)
    except Exception as exc:
        readability_error = str(exc)
        logger.warning("Readability audit payload generation failed: %s", exc, exc_info=True)
    clinical_interpretation_audit = None
    clinical_interpretation_error = ""
    try:
        clinical_interpretation_audit = _build_clinical_interpretation_audit_review(project)
    except Exception as exc:
        clinical_interpretation_error = str(exc)
        logger.warning("Clinical interpretation audit payload generation failed: %s", exc, exc_info=True)
    llm_reliability = None
    llm_reliability_error = ""
    try:
        llm_reliability = _build_llm_reliability_audit_review(project)
    except Exception as exc:
        llm_reliability_error = str(exc)
        logger.warning("LLM reliability payload generation failed: %s", exc, exc_info=True)
    primary_result_audit = None
    primary_result_error = ""
    try:
        calculation_audit_for_primary = _build_calculation_audit_review(project)
        primary_result_audit = _build_primary_result_audit_review(project, calculation_audit_for_primary)
    except Exception as exc:
        primary_result_error = str(exc)
        logger.warning("Primary result audit payload generation failed: %s", exc, exc_info=True)
    claim_support_audit = None
    claim_support_error = ""
    try:
        claim_support_audit = _build_claim_support_audit_review(project)
    except Exception as exc:
        claim_support_error = str(exc)
        logger.warning("Claim support audit payload generation failed: %s", exc, exc_info=True)

    citation_summary = (citation_audit or {}).get("summary") or {}
    readability_summary = (readability_audit or {}).get("summary") or {}
    clinical_interpretation_summary = (clinical_interpretation_audit or {}).get("summary") or {}
    llm_reliability_summary = (llm_reliability or {}).get("summary") or {}
    primary_result_summary = (primary_result_audit or {}).get("summary") or {}
    claim_support_summary = (claim_support_audit or {}).get("summary") or {}
    citation_reference_entries = int(citation_summary.get("reference_entries") or 0)
    reference_entries = max(bib_reference_entries, citation_reference_entries)
    polish = project.load_json("manuscript_polish_audit.json", subdir="manuscript") or {}
    polish_language = _manuscript_quality_language(draft_text, polish)
    compact_polish = _compact_polish_audit(polish, language=polish_language)
    language_gate = _manuscript_quality_language_gate(project, draft_text, polish)
    methodology_context = project.load_json("methodology_context.json", subdir="search") or {}
    evidence_context = project.load_json("evidence_context.json", subdir="search") or {}
    actionable_issues = _build_manuscript_quality_actionable_issues(
        draft_text,
        citation_audit,
        polish,
        methodology_context=methodology_context,
        evidence_context=evidence_context,
        readability_audit=readability_audit,
        clinical_interpretation_audit=clinical_interpretation_audit,
        llm_reliability=llm_reliability,
        primary_result_audit=primary_result_audit,
        claim_support_audit=claim_support_audit,
    )
    if language_gate.get("status") == "fail":
        actionable_issues.insert(
            0,
            _actionable_manuscript_language_issue(draft_text, language_gate, polish_language),
        )
    reference_add_batch = _build_reference_add_batch_suggestion(project, actionable_issues)

    warnings: list[dict[str, Any]] = []
    if language_gate.get("status") == "fail":
        warnings.append({
            "code": "manuscript_language_mismatch",
            "message": _manuscript_language_mismatch_warning_message(language_gate, polish_language),
            "expected_language": language_gate.get("expected_language") or "",
            "detected_language": language_gate.get("detected_language") or "",
        })
    primary_result_failed_issues = int(primary_result_summary.get("failed_issues") or 0)
    primary_result_mismatched_fields = int(primary_result_summary.get("mismatched_fields") or 0)
    if primary_result_error:
        warnings.append({"code": "primary_result_audit_failed", "message": primary_result_error})
    elif primary_result_failed_issues or primary_result_mismatched_fields:
        warnings.append({
            "code": "primary_result_mismatch",
            "message": _primary_result_mismatch_warning_message(primary_result_mismatched_fields, polish_language),
            "mismatched_fields": primary_result_mismatched_fields,
            "failed_issues": primary_result_failed_issues,
            "actionable_issue_count": sum(1 for issue in actionable_issues if issue.get("source") == "primary_result"),
        })
    claim_support_failed_issues = int(claim_support_summary.get("failed_issues") or 0)
    claim_support_unsupported_claims = int(claim_support_summary.get("unsupported_claims") or 0)
    if claim_support_error:
        warnings.append({"code": "claim_support_audit_failed", "message": claim_support_error})
    elif claim_support_failed_issues or claim_support_unsupported_claims:
        warnings.append({
            "code": "claim_support_issues",
            "message": _claim_support_warning_message(claim_support_unsupported_claims, polish_language),
            "unsupported_claims": claim_support_unsupported_claims,
            "failed_issues": claim_support_failed_issues,
            "actionable_issue_count": sum(1 for issue in actionable_issues if issue.get("source") == "claim_support"),
        })
    failed_citation_issues = int(citation_summary.get("failed_issues") or 0)
    warning_citation_issues = int(citation_summary.get("warning_issues") or 0)
    if citation_error:
        warnings.append({"code": "citation_audit_failed", "message": citation_error})
    elif reference_entries > 0 and not citation_audit:
        warnings.append({
            "code": "citation_audit_missing",
            "message": _citation_audit_missing_warning_message(polish_language),
        })
    if failed_citation_issues:
        warnings.append({
            "code": "citation_coverage_issues",
            "message": _citation_coverage_warning_message(failed_citation_issues, polish_language),
            "actionable_issue_count": sum(1 for issue in actionable_issues if issue.get("source") == "citation_audit"),
        })
    if warning_citation_issues:
        warnings.append({
            "code": "citation_quality_warnings",
            "message": _citation_quality_warning_message(warning_citation_issues, polish_language),
            "actionable_issue_count": sum(
                1
                for issue in actionable_issues
                if issue.get("source") == "citation_audit" and issue.get("severity") == "warn"
            ),
        })
    failed_readability_issues = int(readability_summary.get("failed_issues") or 0)
    if readability_error:
        warnings.append({"code": "readability_audit_failed", "message": readability_error})
    elif failed_readability_issues:
        warnings.append({
            "code": "readability_issues",
            "message": _readability_warning_message(failed_readability_issues, polish_language),
            "failed_issues": failed_readability_issues,
            "actionable_issue_count": sum(1 for issue in actionable_issues if issue.get("source") == "readability"),
        })
    failed_clinical_interpretation_issues = int(clinical_interpretation_summary.get("failed_issues") or 0)
    if clinical_interpretation_error:
        warnings.append({"code": "clinical_interpretation_audit_failed", "message": clinical_interpretation_error})
    elif failed_clinical_interpretation_issues:
        warnings.append({
            "code": "clinical_interpretation_issues",
            "message": _clinical_interpretation_warning_message(
                failed_clinical_interpretation_issues,
                polish_language,
            ),
            "failed_issues": failed_clinical_interpretation_issues,
            "covered_domains": int(clinical_interpretation_summary.get("covered_domains") or 0),
            "minimum_domains": int(clinical_interpretation_summary.get("minimum_domains") or 0),
            "missing_domains": [
                str(domain)
                for domain in (clinical_interpretation_summary.get("missing_domains") or [])
                if str(domain).strip()
            ],
            "actionable_issue_count": sum(
                1 for issue in actionable_issues if issue.get("source") == "clinical_interpretation"
            ),
        })
    rejected_polish_chunks = int(polish.get("rejected_chunks") or 0)
    rejected_polish_sections = int(polish.get("rejected_sections") or 0)
    skipped_polish_chunks = int(polish.get("skipped_chunks") or 0)
    if rejected_polish_chunks or rejected_polish_sections:
        warnings.append({
            "code": "polish_rejections",
            "message": _polish_rejections_warning_message(
                rejected_polish_sections,
                rejected_polish_chunks,
                polish_language,
            ),
            "actionable_issue_count": sum(1 for issue in actionable_issues if issue.get("source") == "polish_guard"),
        })
    if bool(polish.get("polish_budget_exhausted")) or skipped_polish_chunks:
        warnings.append({
            "code": "polish_budget_exhausted",
            "message": _polish_budget_warning_message(skipped_polish_chunks, polish_language),
        })
    polish_review_queue = compact_polish.get("review_queue") if isinstance(compact_polish.get("review_queue"), dict) else {}
    polish_manual_review_items = int(polish_review_queue.get("manual_review_items") or 0)
    polish_proofreading_failed = bool(polish_review_queue.get("proofreading_failed"))
    if polish_manual_review_items:
        warnings.append({
            "code": "polish_review_required",
            "message": _polish_review_required_warning_message(polish_manual_review_items, polish_language),
            "review_queue_status": polish_review_queue.get("status") or "",
            "manual_review_items": polish_manual_review_items,
            "rejected_candidates": int(polish_review_queue.get("rejected_candidates") or 0),
            "remaining_style_issues": int(polish_review_queue.get("remaining_style_issues") or 0),
            "proofreading_issues": int(polish_review_queue.get("proofreading_issues") or 0),
            "next_actions": [
                str(action)
                for action in (polish_review_queue.get("next_actions") or [])
                if str(action).strip()
            ],
        })
    if polish_proofreading_failed:
        warnings.append({
            "code": "polish_proofreading_failed",
            "message": _polish_proofreading_failed_warning_message(polish_language),
            "error": polish_review_queue.get("proofreading_error") or compact_polish.get("proofreading", {}).get("error") or "",
            "next_actions": [
                _polish_proofreading_failed_next_action(polish_language),
            ],
        })
    llm_reliability_warning_issues = int(llm_reliability_summary.get("warning_issues") or 0)
    llm_retryable_output_issues = int(llm_reliability_summary.get("retryable_output_issues") or 0)
    llm_near_truncation_events = int(llm_reliability_summary.get("near_truncation_events") or 0)
    if llm_reliability_error:
        warnings.append({"code": "llm_reliability_audit_failed", "message": llm_reliability_error})
    elif llm_reliability_warning_issues or llm_retryable_output_issues or llm_near_truncation_events:
        warnings.append({
            "code": "llm_reliability_warnings",
            "message": _llm_reliability_warning_message(
                llm_retryable_output_issues,
                llm_near_truncation_events,
                polish_language,
            ),
            "warning_issues": llm_reliability_warning_issues,
            "retryable_output_issues": llm_retryable_output_issues,
            "near_truncation_events": llm_near_truncation_events,
            "actionable_issue_count": sum(1 for issue in actionable_issues if issue.get("source") == "llm_reliability"),
        })

    action_required = any(
        item["code"] in {
            "citation_audit_failed",
            "citation_audit_missing",
            "citation_coverage_issues",
            "readability_audit_failed",
            "readability_issues",
            "clinical_interpretation_audit_failed",
            "clinical_interpretation_issues",
            "llm_reliability_audit_failed",
            "manuscript_language_mismatch",
            "primary_result_audit_failed",
            "primary_result_mismatch",
            "claim_support_audit_failed",
            "claim_support_issues",
        }
        for item in warnings
    )
    review_required = action_required or any(
        item["code"] in {
            "citation_quality_warnings",
            "polish_rejections",
            "polish_budget_exhausted",
            "polish_review_required",
            "polish_proofreading_failed",
            "llm_reliability_warnings",
        }
        for item in warnings
    )
    quality_status = "blocked" if action_required else "needs_review" if review_required else "ready"
    ctx["n_reference_entries"] = reference_entries
    ctx["citation_audit_passed"] = bool((citation_audit or {}).get("passed")) if citation_audit else False
    ctx["n_citation_audit_failed_issues"] = failed_citation_issues
    ctx["n_citation_audit_warning_issues"] = warning_citation_issues
    ctx["n_readability_failed_issues"] = failed_readability_issues
    ctx["n_clinical_interpretation_failed_issues"] = failed_clinical_interpretation_issues
    ctx["n_clinical_interpretation_covered_domains"] = int(clinical_interpretation_summary.get("covered_domains") or 0)
    ctx["n_clinical_interpretation_minimum_domains"] = int(clinical_interpretation_summary.get("minimum_domains") or 0)
    ctx["polish_enabled"] = bool(polish.get("enabled"))
    ctx["n_polish_rejected_chunks"] = rejected_polish_chunks
    ctx["n_polish_rejected_sections"] = rejected_polish_sections
    ctx["n_polish_skipped_chunks"] = skipped_polish_chunks
    ctx["polish_budget_exhausted"] = bool(polish.get("polish_budget_exhausted"))
    ctx["n_polish_manual_review_items"] = polish_manual_review_items
    ctx["polish_review_queue_status"] = polish_review_queue.get("status") or ""
    ctx["n_llm_reliability_warning_issues"] = llm_reliability_warning_issues
    ctx["n_llm_retryable_output_issues"] = llm_retryable_output_issues
    ctx["n_llm_near_truncation_events"] = llm_near_truncation_events
    ctx["n_primary_result_mismatched_fields"] = primary_result_mismatched_fields
    ctx["n_primary_result_failed_issues"] = primary_result_failed_issues
    ctx["n_claim_support_unsupported_claims"] = claim_support_unsupported_claims
    ctx["n_claim_support_failed_issues"] = claim_support_failed_issues
    ctx["manuscript_expected_language"] = language_gate.get("expected_language") or ""
    ctx["manuscript_detected_language"] = language_gate.get("detected_language") or ""
    ctx["manuscript_language_matches_expected"] = bool(language_gate.get("matched"))

    return {
        "type": "manuscript_quality",
        "project_dir": str(project.base_dir),
        "draft_path": str(draft_path),
        "action_required": action_required,
        "review_required": review_required,
        "quality_status": quality_status,
        "warnings": warnings,
        "actionable_issues": actionable_issues,
        "reference_add_batch": reference_add_batch,
        "review_contract": _manuscript_quality_review_contract(),
        "reference_entries": reference_entries,
        "bibtex_reference_entries": bib_reference_entries,
        "citation_audit": citation_audit,
        "readability_audit": readability_audit,
        "clinical_interpretation_audit": clinical_interpretation_audit,
        "llm_reliability": llm_reliability,
        "primary_result_audit": primary_result_audit,
        "claim_support_audit": claim_support_audit,
        "language_gate": language_gate,
        "polish": compact_polish,
        "methodology_context": _compact_reference_context(methodology_context),
        "evidence_context": _compact_reference_context(evidence_context),
    }


def _build_reference_add_batch_suggestion(project, actionable_issues: list[dict[str, Any]], *, max_count: int = 5) -> dict[str, Any]:
    """Build a ready-to-preview batch request from citation-quality reference candidates."""
    log = _load_manuscript_citation_fix_log(project)
    current_revision = int(log.get("current_revision") or 0)
    items: list[dict[str, Any]] = []
    seen_candidates: set[str] = set()
    max_items = max(0, int(max_count))
    issue_candidates: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []

    for issue in actionable_issues:
        if not isinstance(issue, dict) or issue.get("source") != "citation_audit":
            continue
        candidates = [
            candidate
            for candidate in (issue.get("reference_add_candidates") or [])
            if isinstance(candidate, dict)
        ]
        if candidates:
            issue_candidates.append((issue, candidates))

    consumed: list[set[int]] = [set() for _issue, _candidates in issue_candidates]

    def add_candidate(issue: dict, candidate: dict) -> bool:
        candidate_id = str(candidate.get("candidate_id") or "").strip()
        candidate_key = candidate_id or str(candidate.get("title") or candidate.get("reference_text") or "").strip()
        recommended_sections = [str(item) for item in candidate.get("recommended_sections") or [] if str(item).strip()]
        target_section = _reference_add_target_section(issue, recommended_sections)
        dedupe_key = _reference_add_batch_dedupe_key(issue, candidate_key, target_section)
        if not candidate_key or dedupe_key in seen_candidates:
            return False
        seen_candidates.add(dedupe_key)
        items.append({
            "issue_id": issue.get("id") or "",
            "issue_code": issue.get("code") or "",
            "issue_section": issue.get("section") or "",
            "candidate_id": candidate_id,
            "target_section": target_section,
            "proposed_citation": candidate.get("proposed_citation") or "",
            "reference_number": candidate.get("reference_number"),
            "title": candidate.get("title") or "",
            "source_type": candidate.get("source_type") or "",
            "reason": candidate.get("reason") or "",
            "recommended_sections": recommended_sections,
            "reference_text": candidate.get("reference_text") or "",
            "source": candidate.get("source") if isinstance(candidate.get("source"), dict) else {},
            "trust": candidate.get("trust") if isinstance(candidate.get("trust"), dict) else _reference_add_candidate_trust_payload(),
        })
        return True

    for issue_index, (issue, candidates) in enumerate(issue_candidates):
        for candidate_index, candidate in enumerate(candidates):
            consumed[issue_index].add(candidate_index)
            if add_candidate(issue, candidate):
                break
        if len(items) >= max_items:
            break

    if len(items) < max_items:
        max_candidates = max((len(candidates) for _issue, candidates in issue_candidates), default=0)
        for candidate_index in range(max_candidates):
            for issue_index, (issue, candidates) in enumerate(issue_candidates):
                if candidate_index in consumed[issue_index] or candidate_index >= len(candidates):
                    continue
                consumed[issue_index].add(candidate_index)
                candidate = candidates[candidate_index]
                add_candidate(issue, candidate)
                if len(items) >= max_items:
                    break
            if len(items) >= max_items:
                break

    request_items = [
        {
            "issue_id": item["issue_id"],
            "candidate_id": item["candidate_id"],
            "target_section": item["target_section"],
        }
        for item in items
    ]
    base_payload = {
        "project_dir": str(project.base_dir),
        "expected_revision": current_revision,
        "items": request_items,
        "max_count": len(request_items),
    }
    return {
        "schema_version": 1,
        "available": bool(items),
        "requires_human_review": bool(items),
        "can_auto_apply": False,
        "review_action": "preview_reference_add_batch_before_apply" if items else "none",
        "preview_request_type": "manuscript_reference_add_batch_preview",
        "apply_request_type": "manuscript_reference_add_batch_apply",
        "expected_revision": current_revision,
        "item_count": len(items),
        "items": items,
        "preview_payload": dict(base_payload),
        "apply_payload": dict(base_payload),
    }


def _reference_add_batch_dedupe_key(issue: dict, candidate_key: str, target_section: str) -> str:
    return f"{candidate_key}:{_canonical_quality_section(target_section)}"


def _reference_add_target_section(issue: dict, recommended_sections: list[str]) -> str:
    issue_section = str(issue.get("section") or "").strip()
    canonical_issue_section = _canonical_quality_section(issue_section)
    recommended_by_canonical = {
        _canonical_quality_section(section): str(section)
        for section in recommended_sections
        if str(section).strip()
    }
    if canonical_issue_section and canonical_issue_section in recommended_by_canonical:
        return canonical_issue_section
    if recommended_sections:
        return str(recommended_sections[0])
    return canonical_issue_section or issue_section or "Main text"


def _manuscript_quality_review_contract() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "citation_patch": {
            "preview_request_type": "manuscript_citation_patch_preview",
            "apply_request_type": "manuscript_citation_patch_apply",
            "requires_expected_revision": True,
            "required_fields": ["project_dir", "issue_id", "citation"],
            "optional_fields": ["target_section", "expected_revision"],
            "apply_response_fields": ["manuscript_quality", "quality_delta"],
        },
        "reference_add": {
            "preview_request_type": "manuscript_reference_add_preview",
            "apply_request_type": "manuscript_reference_add_apply",
            "requires_human_review": True,
            "requires_expected_revision": True,
            "required_fields": ["project_dir", "issue_id", "candidate_id"],
            "optional_fields": ["target_section", "expected_revision"],
            "apply_response_fields": ["manuscript_quality", "quality_delta"],
        },
        "reference_add_batch": {
            "preview_request_type": "manuscript_reference_add_batch_preview",
            "apply_request_type": "manuscript_reference_add_batch_apply",
            "requires_human_review": True,
            "requires_expected_revision": True,
            "required_fields": ["project_dir", "items"],
            "item_fields": ["issue_id", "candidate_id", "target_section"],
            "optional_fields": ["target_section", "expected_revision", "max_count"],
            "apply_response_fields": ["manuscript_quality", "quality_delta"],
        },
        "polish_guard": {
            "can_auto_apply_rejected_edits": False,
            "review_action": "manual_review_required",
            "review_type": "fact_preservation_guard",
        },
        "llm_reliability": {
            "can_auto_apply": False,
            "review_action": "manual_review_required",
            "review_type": "output_reliability_audit",
            "required_fields": ["event_index", "code"],
            "remediation_kind": "rerun_generation_stage",
            "remediation_fields": [
                "kind",
                "current_max_tokens",
                "recommended_max_tokens",
                "can_auto_apply",
                "requires_human_review",
            ],
        },
        "manuscript_language": {
            "can_auto_apply": False,
            "review_action": "rerun_generation_or_polish",
            "review_type": "requested_output_language_gate",
            "required_fields": ["expected_language", "detected_language"],
        },
        "primary_result": {
            "can_auto_apply": False,
            "review_action": "regenerate_results_from_manuscript_facts",
            "review_type": "primary_result_consistency_audit",
            "required_fields": ["field", "expected"],
        },
        "claim_support": {
            "can_auto_apply": False,
            "review_action": "manual_fact_review_required",
            "review_type": "manuscript_claim_support_audit",
            "required_fields": ["claim_type", "sentence", "expected"],
        },
        "clinical_interpretation": {
            "can_auto_apply": False,
            "review_action": "rewrite_discussion_and_conclusion",
            "review_type": "clinical_interpretation_depth_audit",
            "required_fields": ["section", "missing_domains"],
        },
    }


def _build_manuscript_quality_actionable_issues(
    draft_text: str,
    citation_audit: dict | None,
    polish_audit: dict | None,
    *,
    methodology_context: dict | None = None,
    evidence_context: dict | None = None,
    readability_audit: dict | None = None,
    clinical_interpretation_audit: dict | None = None,
    llm_reliability: dict | None = None,
    primary_result_audit: dict | None = None,
    claim_support_audit: dict | None = None,
) -> list[dict[str, Any]]:
    actionables: list[dict[str, Any]] = []
    language = _manuscript_quality_language(draft_text, polish_audit)
    for index, issue in enumerate((citation_audit or {}).get("issues") or []):
        if not isinstance(issue, dict):
            continue
        actionables.append(
            _actionable_citation_issue(
                draft_text,
                issue,
                index=index,
                methodology_context=methodology_context or {},
                evidence_context=evidence_context or {},
                language=language,
            )
        )

    for index, issue in enumerate((readability_audit or {}).get("issues") or []):
        if not isinstance(issue, dict):
            continue
        actionables.append(_actionable_readability_issue(draft_text, issue, index=index, language=language))

    for index, issue in enumerate((clinical_interpretation_audit or {}).get("issues") or []):
        if not isinstance(issue, dict):
            continue
        actionables.append(_actionable_clinical_interpretation_issue(draft_text, issue, index=index, language=language))

    for index, issue in enumerate((polish_audit or {}).get("issues") or []):
        if not isinstance(issue, dict):
            continue
        section = str(issue.get("heading") or issue.get("section") or "Manuscript").strip() or "Manuscript"
        actionables.append({
            "id": f"polish_guard:{index}:{issue.get('code', 'issue')}",
            "source": "polish_guard",
            "code": issue.get("code") or "polish_guard_issue",
            "severity": "warn",
            "section": section,
            "target": _markdown_section_target(draft_text, section),
            "snippet": _section_snippet(draft_text, section),
            "suggested_action": _polish_guard_suggested_action(issue, language),
            "review": _polish_rejection_review_payload(issue, language=language, index=index),
            "message": _polish_guard_message(issue, language),
            "raw_issue": issue,
        })

    llm_events = {
        int(event.get("index") or 0): event
        for event in (llm_reliability or {}).get("events") or []
        if isinstance(event, dict)
    }
    for index, issue in enumerate((llm_reliability or {}).get("issues") or []):
        if not isinstance(issue, dict):
            continue
        actionables.append(
            _actionable_llm_reliability_issue(
                issue,
                event=llm_events.get(int(issue.get("event_index") or 0), {}),
                index=index,
                language=language,
            )
        )

    for index, issue in enumerate((primary_result_audit or {}).get("issues") or []):
        if not isinstance(issue, dict):
            continue
        actionables.append(_actionable_primary_result_issue(draft_text, issue, index=index, language=language))

    for index, issue in enumerate((claim_support_audit or {}).get("issues") or []):
        if not isinstance(issue, dict):
            continue
        actionables.append(_actionable_claim_support_issue(issue, index=index, language=language))
    return actionables[:50]


def _actionable_clinical_interpretation_issue(
    draft_text: str,
    issue: dict,
    *,
    index: int,
    language: str,
) -> dict[str, Any]:
    section = str(issue.get("section") or ("讨论" if language == "zh" else "Discussion")).strip()
    missing_domains = [
        str(domain)
        for domain in (issue.get("missing_domains") or [])
        if str(domain).strip()
    ]
    return {
        "id": f"clinical_interpretation:{index}:{issue.get('code', 'issue')}",
        "source": "clinical_interpretation",
        "code": issue.get("code") or "clinical_interpretation_issue",
        "severity": issue.get("severity") or "fail",
        "section": section,
        "target": _markdown_section_target(draft_text, section),
        "snippet": _section_snippet(draft_text, section),
        "suggested_action": _clinical_interpretation_issue_suggested_action(issue, language),
        "message": issue.get("message") or _clinical_interpretation_issue_message(language),
        "raw_issue": issue,
        "remediation": {
            "kind": "rewrite_discussion_clinical_interpretation",
            "can_auto_apply": False,
            "requires_human_review": True,
            "missing_domains": missing_domains,
            "minimum_domains": int(issue.get("minimum_domains") or 0),
        },
    }


def _actionable_primary_result_issue(
    draft_text: str,
    issue: dict,
    *,
    index: int,
    language: str,
) -> dict[str, Any]:
    field = str(issue.get("field") or "primary_result").strip() or "primary_result"
    expected = issue.get("expected")
    label = str(issue.get("label") or field).strip() or field
    return {
        "id": f"primary_result:{index}:{field}",
        "source": "primary_result",
        "code": issue.get("code") or "primary_result_field_missing",
        "severity": issue.get("severity") or "fail",
        "section": "Results",
        "target": {
            "type": "primary_result_field",
            "field": field,
            "expected": expected,
            "label": label,
        },
        "snippet": _section_snippet(draft_text, "Results"),
        "suggested_action": _primary_result_issue_suggested_action(label, expected, language),
        "message": _primary_result_issue_message(label, expected, language),
        "raw_issue": issue,
        "remediation": {
            "kind": "regenerate_results_from_manuscript_facts",
            "can_auto_apply": False,
            "requires_human_review": True,
            "field": field,
            "expected": expected,
        },
    }


def _actionable_claim_support_issue(issue: dict, *, index: int, language: str) -> dict[str, Any]:
    sentence = str(issue.get("sentence") or "").strip()
    claim_type = str(issue.get("claim_type") or "").strip() or "claim"
    expected = _expected_value_from_claim_support_message(str(issue.get("message") or ""))
    return {
        "id": f"claim_support:{index}:{claim_type}",
        "source": "claim_support",
        "code": issue.get("code") or "unsupported_manuscript_claim",
        "severity": issue.get("severity") or "fail",
        "section": "Manuscript",
        "target": {
            "type": "manuscript_claim",
            "claim_type": claim_type,
            "expected": expected,
        },
        "snippet": sentence,
        "suggested_action": _claim_support_issue_suggested_action(language),
        "message": issue.get("message") or _claim_support_issue_message(language),
        "raw_issue": issue,
        "remediation": {
            "kind": "manual_fact_review_required",
            "can_auto_apply": False,
            "requires_human_review": True,
            "claim_type": claim_type,
            "expected": expected,
        },
    }


def _actionable_llm_reliability_issue(
    issue: dict,
    *,
    event: dict | None,
    index: int,
    language: str,
) -> dict[str, Any]:
    event = event if isinstance(event, dict) else {}
    code = str(issue.get("code") or "llm_reliability_issue")
    event_index = int(issue.get("event_index") or event.get("index") or index + 1)
    review = {
        "event_index": event_index,
        "model": issue.get("model") or event.get("model") or "",
        "endpoint": issue.get("endpoint") or event.get("endpoint") or "",
        "finish_reason": event.get("finish_reason") or "",
        "retryable_output_issue": event.get("retryable_output_issue") or "",
        "near_truncation": bool(event.get("near_truncation")),
        "prompt_tokens": event.get("prompt_tokens", 0),
        "completion_tokens": event.get("completion_tokens", 0),
        "total_tokens": event.get("total_tokens", 0),
        "max_tokens": event.get("max_tokens", 0),
        "error_type": event.get("error_type") or "",
        "error_message": event.get("error_message") or "",
    }
    return {
        "id": f"llm_reliability:{index}:{code}:event-{event_index}",
        "source": "llm_reliability",
        "code": code,
        "severity": issue.get("severity") or "warn",
        "section": "Manuscript",
        "target": {"type": "llm_usage_event", "event_index": event_index},
        "snippet": _llm_reliability_issue_snippet(review, language),
        "suggested_action": _llm_reliability_issue_suggested_action(issue, review, language),
        "message": issue.get("message") or _llm_reliability_issue_message(code, language),
        "event_index": event_index,
        "model": review["model"],
        "endpoint": review["endpoint"],
        "review": review,
        "remediation": _llm_reliability_remediation_payload(issue, review, language),
        "raw_issue": issue,
    }


def _llm_reliability_remediation_payload(issue: dict, review: dict, language: str) -> dict[str, Any]:
    current_max_tokens = _quality_integer_or_none(review.get("max_tokens")) or 0
    recommended_max_tokens = _recommended_llm_max_tokens(current_max_tokens)
    return {
        "kind": "rerun_generation_stage",
        "current_max_tokens": current_max_tokens,
        "recommended_max_tokens": recommended_max_tokens,
        "can_auto_apply": False,
        "requires_human_review": True,
        "review_action": "manual_review_required",
        "reason": str((issue or {}).get("code") or "llm_reliability_issue"),
        "message": _llm_reliability_remediation_message(recommended_max_tokens, language),
    }


def _recommended_llm_max_tokens(current_max_tokens: int) -> int:
    current = max(0, int(current_max_tokens or 0))
    if current <= 0:
        return 0
    return max(current * 2, current + 1024)


def _quality_integer_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _actionable_readability_issue(
    draft_text: str,
    issue: dict,
    *,
    index: int,
    language: str,
) -> dict[str, Any]:
    section = str(issue.get("section") or "Manuscript").strip() or "Manuscript"
    snippet = str(issue.get("excerpt") or "").strip() or _section_snippet(draft_text, section)
    return {
        "id": f"readability:{index}:{issue.get('code', 'issue')}",
        "source": "readability",
        "code": issue.get("code") or "readability_issue",
        "severity": issue.get("severity") or "warn",
        "section": section,
        "target": _markdown_section_target(draft_text, section),
        "snippet": snippet,
        "suggested_action": _readability_issue_suggested_action(issue, language),
        "message": issue.get("message") or _readability_issue_message(language),
        "raw_issue": issue,
    }


def _manuscript_quality_language(draft_text: str, polish_audit: dict | None = None) -> str:
    detected_language = _detect_manuscript_quality_language_from_text(draft_text)
    if detected_language == "mixed":
        return "mixed"
    audit_language = str((polish_audit or {}).get("language") or "").strip().lower()
    if audit_language in {"zh", "cn", "chinese"}:
        return "zh"
    if audit_language in {"en", "english"}:
        return "en"
    return detected_language


def _detect_manuscript_quality_language_from_text(draft_text: str) -> str:
    raw = str(draft_text or "")
    analysis_text = _manuscript_quality_language_detection_text(raw)
    cjk_chars = len(re.findall(r"[\u4e00-\u9fff]", analysis_text))
    latin_letters = len(re.findall(r"[A-Za-z]", analysis_text))
    if cjk_chars >= 10 and latin_letters >= 200:
        cjk_share = cjk_chars / max(1, cjk_chars + latin_letters)
        if 0.01 <= cjk_share <= 0.80:
            return "mixed"
    zh_headings = len(
        re.findall(r"^#{1,6}\s*(?:引言|背景|方法|结果|讨论|结论|摘要|参考文献)(?:\s|$|[:：])", raw, flags=re.M)
    )
    if zh_headings >= 2:
        return "zh"
    latin_words = len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", analysis_text))
    return "zh" if cjk_chars and cjk_chars >= latin_words else "en"


def _manuscript_quality_language_detection_text(draft_text: str) -> str:
    raw = _strip_manuscript_quality_references(str(draft_text or "")) or str(draft_text or "")
    raw = re.sub(r"```[\s\S]*?```", " ", raw)
    kept_lines: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if stripped.startswith("|") or stripped.startswith("!["):
            continue
        kept_lines.append(line)
    return "\n".join(kept_lines)


def _strip_manuscript_quality_references(draft_text: str) -> str:
    raw = str(draft_text or "")
    match = re.search(r"^#{1,6}\s*(?:References|参考文献)\b.*$", raw, flags=re.I | re.M)
    if not match:
        return raw
    return raw[: match.start()]


def _manuscript_quality_language_gate(project, draft_text: str, polish_audit: dict | None = None) -> dict[str, Any]:
    expected = _expected_manuscript_quality_language(project)
    detected = _detect_manuscript_quality_language_from_text(draft_text)
    if not expected:
        return {
            "available": False,
            "status": "not_recorded",
            "expected_language": "",
            "detected_language": detected,
            "matched": True,
        }
    matched = expected == detected
    return {
        "available": True,
        "status": "pass" if matched else "fail",
        "expected_language": expected,
        "detected_language": detected,
        "matched": matched,
    }


def _expected_manuscript_quality_language(project) -> str:
    candidates: list[Any] = []
    try:
        facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    except Exception:
        facts = None
    if isinstance(facts, dict):
        candidates.extend([
            facts.get("output_language"),
            facts.get("outputLanguage"),
            facts.get("manuscript_language"),
            facts.get("manuscriptLanguage"),
            facts.get("language"),
            facts.get("lang"),
        ])
    try:
        language_record = project.load_json("manuscript_output_language.json", subdir="manuscript")
    except Exception:
        language_record = None
    if isinstance(language_record, dict):
        candidates.extend([
            language_record.get("expected_language"),
            language_record.get("expectedLanguage"),
            language_record.get("output_language"),
            language_record.get("outputLanguage"),
            language_record.get("manuscript_language"),
            language_record.get("manuscriptLanguage"),
            language_record.get("language"),
            language_record.get("lang"),
        ])
    for candidate in candidates:
        normalized = _normalize_manuscript_quality_language(candidate)
        if normalized:
            return normalized
    return ""


def _normalize_manuscript_quality_language(value: Any) -> str:
    raw = str(value or "").strip()
    lowered = raw.lower()
    if raw in {"中文", "汉语", "简体中文", "繁体中文"} or re.fullmatch(
        r"(zh|zh[-_](?:cn|hans|hant)|cn|chinese)",
        lowered,
    ):
        return "zh"
    if raw in {"英文", "英语"} or re.fullmatch(r"(en|eng|en[-_][a-z]+|english)", lowered):
        return "en"
    return ""


def _actionable_manuscript_language_issue(
    draft_text: str,
    language_gate: dict[str, Any],
    language: str,
) -> dict[str, Any]:
    expected = str(language_gate.get("expected_language") or "")
    detected = str(language_gate.get("detected_language") or "")
    return {
        "id": "manuscript_language:requested_language_mismatch",
        "source": "manuscript_language",
        "code": "requested_language_mismatch",
        "severity": "fail",
        "section": "Manuscript",
        "target": {
            "type": "manuscript",
            "expected_language": expected,
            "detected_language": detected,
        },
        "snippet": _section_snippet(draft_text, "Main text"),
        "suggested_action": _manuscript_language_mismatch_suggested_action(language_gate, language),
        "message": _manuscript_language_mismatch_issue_message(language_gate, language),
        "remediation": {
            "kind": "rerun_manuscript_generation_or_polish",
            "can_auto_apply": False,
            "requires_human_review": True,
            "expected_language": expected,
            "detected_language": detected,
        },
    }


def _manuscript_language_label(language: str, ui_language: str) -> str:
    normalized = _normalize_manuscript_quality_language(language)
    if str(language or "").strip().lower() == "mixed":
        return "混合语言（mixed）" if _is_zh_quality_language(ui_language) else "mixed-language text"
    if _is_zh_quality_language(ui_language):
        return {"zh": "中文", "en": "英文"}.get(normalized, "未记录语言")
    return {"zh": "Chinese", "en": "English"}.get(normalized, "an unrecorded language")


def _manuscript_language_mismatch_warning_message(language_gate: dict[str, Any], language: str) -> str:
    expected = _manuscript_language_label(str(language_gate.get("expected_language") or ""), language)
    detected = _manuscript_language_label(str(language_gate.get("detected_language") or ""), language)
    if _is_zh_quality_language(language):
        return f"用户选择输出{expected}，但当前稿件看起来是{detected}；请先重生成或重新润色到目标语言后再交付。"
    return (
        f"The requested manuscript language is {expected}, but the current draft appears to be {detected}. "
        "Regenerate or rerun polish in the requested language before handoff."
    )


def _manuscript_language_mismatch_issue_message(language_gate: dict[str, Any], language: str) -> str:
    expected = _manuscript_language_label(str(language_gate.get("expected_language") or ""), language)
    detected = _manuscript_language_label(str(language_gate.get("detected_language") or ""), language)
    if _is_zh_quality_language(language):
        return f"稿件语言与用户选择不一致：预期{expected}，检测为{detected}。"
    return f"Manuscript language does not match the user request: expected {expected}, detected {detected}."


def _manuscript_language_mismatch_suggested_action(language_gate: dict[str, Any], language: str) -> str:
    expected = _manuscript_language_label(str(language_gate.get("expected_language") or ""), language)
    detected = _manuscript_language_label(str(language_gate.get("detected_language") or ""), language)
    if _is_zh_quality_language(language):
        return (
            f"请按用户选择重新生成或重新润色为{expected}稿件；不要只翻译标题（do not only translate headings），"
            "需整篇正文、摘要、图表说明和参考文献前后文一致。"
            f"当前检测为{detected}。"
        )
    return (
        f"Regenerate or rerun manuscript polish as {expected}; do not only translate headings. "
        f"The abstract, main text, figure/table legends, and citation context should all use {expected}. "
        f"The current draft was detected as {detected}."
    )


def _polish_guard_suggested_action(issue: dict | None, language: str) -> str:
    code = str((issue or {}).get("code") or "").strip()
    if _is_zh_quality_language(language):
        by_code = {
            "numeric_tokens_changed": "请打开人工复核；逐项核对数值、P值、CI、正负号和不等号，不要改变数字、引用、研究名称或结论，除非确认所有事实均未改变，否则保留原文。",
            "citations_changed": "请打开人工复核；核对文内引用编号、方括号和全半角格式，不要改变数字、引用、研究名称或结论，除非确认引用完全一致，否则保留原文。",
            "citation_sentence_binding_changed": "请打开人工复核；核对每个文内引用是否仍贴在原来的同一句事实声明后面。引用编号虽然存在，但不能从结果句、机制句或安全性句移动到另一句。",
            "cross_references_changed": "请打开人工复核；核对表格和图的交叉引用，例如表1、图2或Table 1，不要改变数字、引用、研究名称或结论，除非确认指向完全一致，否则保留原文。",
            "protected_terms_changed": "请打开人工复核；核对研究名称、药物名称、结局名称和OR/RR/HR/CI等统计缩写，不要改变数字、引用、研究名称或结论，除非确认术语完全等价，否则保留原文。",
            "clinical_entities_changed": "请打开人工复核；重点核对人群、疾病、干预、比较组和结局名称，例如住院、死亡、心衰、糖尿病等。除非人工确认临床实体完全一致，否则保留原文。",
            "directional_terms_changed": "请打开人工复核；重点核对结论方向和否定关系，例如降低/未降低、增加/未增加，不要改变数字、引用、研究名称或结论，除非确认方向完全一致，否则保留原文。",
            "clinical_claim_terms_changed": "请打开人工复核；重点核对是否新增或删除临床获益、伤害、有效性或因果语气。除非人工确认这些 clinical claim 完全等价，否则保留原文。",
            "certainty_rating_changed": "请打开人工复核；重点核对GRADE证据确定性等级，例如高、中等、低、极低。除非人工确认 certainty rating 完全一致，否则保留原文。",
            "risk_of_bias_rating_changed": "请打开人工复核；重点核对偏倚风险等级，例如低偏倚风险、高偏倚风险或 some concerns。除非人工确认 risk of bias rating 完全一致，否则保留原文。",
            "statistical_model_changed": "请打开人工复核；重点核对统计模型和τ²估计方法，例如 random-effects、fixed-effect、DL、REML、HKSJ。除非人工确认 statistical model 完全一致，否则保留原文。",
            "statistical_significance_changed": "请打开人工复核；重点核对统计显著性结论，例如显著、不显著、未达到统计学显著或P值解释。除非人工确认 statistical significance 完全一致，否则保留原文。",
            "study_design_changed": "请打开人工复核；重点核对研究设计术语，例如随机试验、观察性研究、队列、病例对照、盲法、开放标签、平行组或交叉设计。除非人工确认 study design 完全一致，否则保留原文。",
            "language_changed": "请打开人工复核；重点核对稿件输出语言，润色不得把英文稿改成中文、或把中文稿改成英文。除非人工确认 output language 与用户选择完全一致，否则保留原文。",
            "interpretive_certainty_changed": "请打开人工复核；重点核对 may/可能、提示、相关、证实等解释强度和不确定性措辞。除非人工确认语气强度完全一致，否则保留原文。",
            "detector_evasion_language": "请打开人工复核；删除面向AI检测器的规避性措辞，只做学术润色，不要改变数字、引用、研究名称或结论。",
        }
        return by_code.get(
            code,
            "请打开人工复核；不要改变数字、引用、研究名称或结论，除非确认所有事实均未改变，否则保留原文。",
        )
    by_code = {
        "numeric_tokens_changed": (
            "Open manual review for the rejected polish edit; compare numeric values, P values, "
            "confidence intervals, signs, and inequality operators. Keep the original wording unless "
            "a human confirms every value is unchanged."
        ),
        "citations_changed": (
            "Open manual review for the rejected polish edit; compare citation markers, citation "
            "numbers, and bracket style. Keep the original wording unless the citations are identical."
        ),
        "citation_sentence_binding_changed": (
            "Open manual review for the rejected polish edit; confirm every citation remains attached "
            "to the same sentence and factual claim. Keep the original wording if a citation moved to "
            "a different result, mechanism, or safety statement."
        ),
        "cross_references_changed": (
            "Open manual review for the rejected polish edit; compare all table and figure cross-references. "
            "Keep the original wording unless each reference points to the same item."
        ),
        "protected_terms_changed": (
            "Open manual review for the rejected polish edit; compare study names, drug names, outcome "
            "names, and statistical abbreviations such as OR, RR, HR, and CI. Keep the original wording "
            "unless the terms are factually equivalent."
        ),
        "clinical_entities_changed": (
            "Open manual review for the rejected polish edit; compare population, condition, intervention, "
            "comparator, and outcome terms such as hospitalization, mortality, heart failure, or diabetes. "
            "Keep the original wording unless the clinical entities are identical."
        ),
        "directional_terms_changed": (
            "Open manual review for the rejected polish edit; compare conclusion direction and negation "
            "terms such as reduced versus increased, or did not reduce versus reduced. Keep the original "
            "wording unless the direction is identical."
        ),
        "clinical_claim_terms_changed": (
            "Open manual review for the rejected polish edit; compare clinical benefit, harm, efficacy, "
            "and causal claim terms. Keep the original wording unless a human confirms the benefit or "
            "causal language is factually identical."
        ),
        "certainty_rating_changed": (
            "Open manual review for the rejected polish edit; compare GRADE certainty rating terms "
            "such as high, moderate, low, or very low. Keep the original wording unless the certainty "
            "rating is identical."
        ),
        "risk_of_bias_rating_changed": (
            "Open manual review for the rejected polish edit; compare risk of bias rating terms "
            "such as low risk of bias, high risk of bias, some concerns, or unclear risk. Keep the "
            "original wording unless the risk of bias rating is identical."
        ),
        "statistical_model_changed": (
            "Open manual review for the rejected polish edit; compare statistical model and tau-squared "
            "estimator terms such as random-effects, fixed-effect, DL, REML, HKSJ, or Paule-Mandel. "
            "Keep the original wording unless the statistical model is identical."
        ),
        "statistical_significance_changed": (
            "Open manual review for the rejected polish edit; compare statistical significance terms "
            "such as significant, not significant, non-significant, subgroup interaction, and P-value "
            "interpretation. Keep the original wording unless the significance interpretation is identical."
        ),
        "study_design_changed": (
            "Open manual review for the rejected polish edit; compare study design terms such as randomized "
            "trial, observational study, cohort, case-control, blinded, open-label, parallel-group, or "
            "crossover. Keep the original wording unless the study design is identical."
        ),
        "language_changed": (
            "Open manual review for the rejected polish edit; compare the manuscript output language. "
            "Polish must not translate an English manuscript into Chinese or a Chinese manuscript into English. "
            "Keep the original wording unless the output language matches the user's choice."
        ),
        "interpretive_certainty_changed": (
            "Open manual review for the rejected polish edit; compare interpretive certainty, hedging, "
            "association, and evidential-strength terms such as may, might, associated with, demonstrate, "
            "or prove. Keep the original wording unless the certainty and hedging are identical."
        ),
        "detector_evasion_language": (
            "Open manual review for the rejected polish edit; remove detector-evasion language and keep "
            "the edit to academic proofreading only."
        ),
    }
    return by_code.get(
        code,
        "Open manual review for the rejected polish edit; keep the original wording unless a human "
        "confirms that all facts, numbers, and citations are unchanged.",
    )


def _polish_guard_message(issue: dict | None, language: str) -> str:
    data = issue if isinstance(issue, dict) else {}
    message = str(data.get("message") or "")
    if not _is_zh_quality_language(language):
        return message or "A polish edit was rejected by the fact-preservation guard."
    code = str(data.get("code") or "").strip()
    by_code = {
        "numeric_tokens_changed": "润色候选修改了数字，需人工复核。",
        "citations_changed": "润色候选修改了引用标记，需人工复核。",
        "citation_sentence_binding_changed": "润色候选把引用标记移动到了不同句子或声明，需人工复核。",
        "cross_references_changed": "润色候选修改了表格或图形交叉引用，需人工复核。",
        "protected_terms_changed": "润色候选修改了受保护术语，需人工复核。",
        "clinical_entities_changed": "润色候选修改了人群、疾病、干预、比较组或结局名称，需人工复核。",
        "directional_terms_changed": "润色候选修改了结论方向或否定关系，需人工复核。",
        "clinical_claim_terms_changed": "润色候选修改了临床获益、伤害、有效性或因果语气，需人工复核。",
        "certainty_rating_changed": "润色候选修改了GRADE证据确定性等级，需人工复核。",
        "risk_of_bias_rating_changed": "润色候选修改了偏倚风险等级，需人工复核。",
        "statistical_model_changed": "润色候选修改了统计模型或τ²估计方法，需人工复核。",
        "statistical_significance_changed": "润色候选修改了统计显著性解释，需人工复核。",
        "study_design_changed": "润色候选修改了研究设计术语，需人工复核。",
        "language_changed": "润色候选修改了稿件输出语言，需人工复核。",
        "interpretive_certainty_changed": "润色候选修改了解释强度、相关性或不确定性措辞，需人工复核。",
        "detector_evasion_language": "润色候选包含面向检测器规避的措辞，需改为普通学术审校。",
    }
    return by_code.get(code, "润色候选触发事实保护闸，需人工复核。")


def _polish_rejections_warning_message(sections: int, chunks: int, language: str) -> str:
    if _is_zh_quality_language(language):
        return f"润色事实保护闸拒绝了 {sections} 个章节和 {chunks} 个片段，以避免改变事实、数字或引用。"
    return f"Polish guard rejected {sections} section(s) and {chunks} chunk(s) to preserve facts/citations."


def _polish_budget_warning_message(skipped_chunks: int, language: str) -> str:
    if _is_zh_quality_language(language):
        return (
            f"润色片段预算已耗尽；{skipped_chunks} 个片段保持原文。"
            "如需更深润色，请提高 MANUSCRIPT_POLISH_MAX_LLM_CHUNKS 后重跑。"
        )
    return (
        f"Polish chunk budget was exhausted; {skipped_chunks} chunk(s) were kept unchanged. "
        "Increase MANUSCRIPT_POLISH_MAX_LLM_CHUNKS or rerun deep polish if needed."
    )


def _polish_review_required_warning_message(items: int, language: str) -> str:
    if _is_zh_quality_language(language):
        return f"{items} 个稿件润色项需人工复核后再交付。"
    return f"{items} manuscript polish item(s) need human review before handoff."


def _polish_proofreading_failed_warning_message(language: str) -> str:
    if _is_zh_quality_language(language):
        return "外部审校器未成功完成，不能把 0 条审校建议理解为已通过。"
    return "The external proofreader did not complete, so zero proofreading issues cannot be treated as a pass."


def _polish_proofreading_failed_next_action(language: str) -> str:
    if _is_zh_quality_language(language):
        return "检查审校服务配置或稍后重跑；如跳过外部审校，请保留人工通读记录。"
    return "Check the proofreader service configuration or rerun proofreading; if skipped, record a human proofreading pass."


def _readability_warning_message(failed_issues: int, language: str) -> str:
    if _is_zh_quality_language(language):
        return f"可读性审计发现 {failed_issues} 处解释性章节问题，需先处理后再交付投稿稿。"
    return f"Readability audit found {failed_issues} issue(s) in interpretive manuscript sections before handoff."


def _clinical_interpretation_warning_message(failed_issues: int, language: str) -> str:
    if _is_zh_quality_language(language):
        return f"临床解释深度审计发现 {failed_issues} 处问题；讨论/结论需要围绕合并结果给出临床解读。"
    return (
        f"Clinical-interpretation audit found {failed_issues} issue(s); Discussion and Conclusion need "
        "clinical interpretation of the pooled result rather than process commentary."
    )


def _primary_result_mismatch_warning_message(mismatched_fields: int, language: str) -> str:
    if _is_zh_quality_language(language):
        return f"主要结果一致性审计发现 {mismatched_fields} 个字段未按 manuscript_facts.json 报告，需先复核。"
    return (
        f"Primary-result consistency audit found {mismatched_fields} field(s) that do not match "
        "manuscript_facts.json."
    )


def _claim_support_warning_message(unsupported_claims: int, language: str) -> str:
    if _is_zh_quality_language(language):
        return f"正文主张支持审计发现 {unsupported_claims} 条主效应或GRADE主张与结构化事实不一致。"
    return f"Claim-support audit found {unsupported_claims} unsupported primary-effect or GRADE claim(s)."


def _primary_result_issue_message(label: str, expected: Any, language: str) -> str:
    if _is_zh_quality_language(language):
        return f"稿件未报告主要结果字段 {label} 的预期值 {expected}。"
    return f"The manuscript does not report the expected primary-result value for {label}: {expected}."


def _primary_result_issue_suggested_action(label: str, expected: Any, language: str) -> str:
    if _is_zh_quality_language(language):
        return (
            f"请从 manuscript_facts.json 和计算审计重新核对 Results、Abstract 和 Discussion 中的 {label}，"
            f"确保报告值为 {expected}，再重新运行投稿包质量门。"
        )
    return (
        f"Regenerate or manually correct the Results, Abstract, and Discussion from manuscript_facts.json "
        f"and the calculation audit so {label} is reported as {expected}; then rerun the submission quality gate."
    )


def _claim_support_issue_message(language: str) -> str:
    if _is_zh_quality_language(language):
        return "稿件包含未被 manuscript_facts.json 支持的主效应或GRADE主张。"
    return "The manuscript contains a primary-effect or GRADE claim that is not supported by manuscript_facts.json."


def _claim_support_issue_suggested_action(language: str) -> str:
    if _is_zh_quality_language(language):
        return (
            "请逐句核对该主张；若 manuscript_facts.json 为准，请改写该句以匹配结构化主效应/GRADE事实，"
            "不要只做风格润色。"
        )
    return (
        "Review the sentence against manuscript_facts.json; if the structured fact table is correct, "
        "rewrite the claim to match the primary-effect or GRADE values before handoff."
    )


def _clinical_interpretation_issue_message(language: str) -> str:
    if _is_zh_quality_language(language):
        return "讨论或结论没有充分解释主要合并结果的临床含义。"
    return "Discussion or Conclusion does not sufficiently interpret the clinical meaning of the pooled result."


def _clinical_interpretation_issue_suggested_action(issue: dict | None, language: str) -> str:
    code = str((issue or {}).get("code") or "")
    missing = [
        str(domain)
        for domain in ((issue or {}).get("missing_domains") or [])
        if str(domain).strip()
    ]
    missing_text = ", ".join(missing[:5])
    if _is_zh_quality_language(language):
        if code == "clinical_discussion_process_framing":
            return "请删去以溯源、审计文件、生成流程或投稿准备为中心的讨论段落，改写为对合并结果、适用人群、安全性和临床决策的解释。"
        if code == "clinical_discussion_too_long":
            return "请把讨论压缩为8-14个临床主题段落，每段只解决一个问题，避免把同一基线风险、安全性或实施观点反复展开。"
        if code == "clinical_discussion_redundant_domains":
            return "请合并重复的临床主题段落；基线风险、复合终点、安全性、适用性、实施和证据确定性各保留最有信息量的解释。"
        suffix = f" 当前缺失域：{missing_text}。" if missing_text else ""
        return (
            "请重写讨论和结论，使其围绕合并效应大小/方向、绝对风险转化、复合终点含义、"
            "安全性、适用人群、临床实施和证据确定性展开。"
            f"{suffix}"
        )
    if code == "clinical_discussion_process_framing":
        return (
            "Remove Discussion/Conclusion paragraphs centered on traceability, audit files, generated outputs, "
            "or workflow, and replace them with clinical interpretation of the pooled result."
        )
    if code == "clinical_discussion_too_long":
        return (
            "Compress Discussion to 8-14 clinical-theme paragraphs, with one theme per paragraph and no repeated "
            "baseline-risk, safety, implementation, endpoint, or certainty loops."
        )
    if code == "clinical_discussion_redundant_domains":
        return (
            "Merge repeated clinical-theme paragraphs so baseline risk, endpoint meaning, safety, applicability, "
            "implementation, and certainty each appear as a focused interpretation rather than repeated commentary."
        )
    suffix = f" Missing domains: {missing_text}." if missing_text else ""
    return (
        "Rewrite Discussion and Conclusion around the pooled effect magnitude/direction, absolute-risk "
        "translation, endpoint meaning, safety, applicability, implementation, and certainty."
        f"{suffix}"
    )


def _expected_value_from_claim_support_message(message: str) -> str:
    match = re.search(r"expected\s+(.+)$", str(message or ""), flags=re.I)
    return match.group(1).strip() if match else ""


def _readability_issue_message(language: str) -> str:
    if _is_zh_quality_language(language):
        return "解释性章节包含过长或过细的 PICO 资格条件。"
    return "An interpretive section contains overly detailed PICO eligibility wording."


def _readability_issue_suggested_action(issue: dict | None, language: str) -> str:
    code = str((issue or {}).get("code") or "")
    if _is_zh_quality_language(language):
        if code == "verbose_pico_fragment":
            return (
                "请把详细纳排标准、诊断确认、剂量或对照条件移回方法部分；"
                "讨论、结论和摘要只保留简洁的人群、干预或结局标签。"
            )
        return "请人工精简解释性章节，避免把方法部分的详细资格条件重复到讨论或结论中。"
    if code == "verbose_pico_fragment":
        return (
            "Move detailed eligibility, diagnostic-confirmation, dose, or comparator wording back to Methods; "
            "keep interpretive sections to concise population, intervention, or outcome labels."
        )
    return "Manually tighten interpretive sections so detailed eligibility wording stays in Methods."


def _citation_audit_missing_warning_message(language: str) -> str:
    if _is_zh_quality_language(language):
        return "参考文献列表已存在，但未能生成引用覆盖审计。"
    return "Reference list exists, but citation coverage audit could not be generated."


def _citation_coverage_warning_message(issues: int, language: str) -> str:
    if _is_zh_quality_language(language):
        return f"{issues} 个引用覆盖问题需要复核。"
    return f"{issues} citation coverage issue(s) need review."


def _citation_quality_warning_message(issues: int, language: str) -> str:
    if _is_zh_quality_language(language):
        return f"{issues} 个引用质量警告建议在投稿前复核。"
    return f"{issues} citation quality warning(s) should be reviewed before submission."


def _llm_reliability_warning_message(retryable_issues: int, near_truncation_events: int, language: str) -> str:
    if _is_zh_quality_language(language):
        return (
            f"LLM 输出可靠性审计发现 {retryable_issues} 次可恢复输出问题和 "
            f"{near_truncation_events} 次接近 token 上限事件；请复核对应生成段落是否完整。"
        )
    return (
        f"LLM output reliability audit found {retryable_issues} recovered output issue(s) and "
        f"{near_truncation_events} near-token-limit event(s); review the affected generated sections "
        "for completeness before handoff."
    )


def _llm_reliability_issue_message(code: str, language: str) -> str:
    normalized = str(code or "").strip()
    if _is_zh_quality_language(language):
        by_code = {
            "llm_retryable_output_issue": "LLM 输出曾触发重试或续写，需复核对应生成段落是否完整。",
            "llm_near_truncation": "LLM 输出接近 token 上限，需复核对应生成段落是否被截断。",
        }
        return by_code.get(normalized, "LLM 输出可靠性审计发现需人工复核的问题。")
    by_code = {
        "llm_retryable_output_issue": "LLM output required retry or continuation; review the affected generated section for completeness.",
        "llm_near_truncation": "LLM output used most of the token budget; review the affected generated section for possible truncation.",
    }
    return by_code.get(normalized, "LLM output reliability audit found an item that needs review.")


def _llm_reliability_issue_suggested_action(issue: dict, review: dict, language: str) -> str:
    code = str((issue or {}).get("code") or "")
    if _is_zh_quality_language(language):
        if code == "llm_near_truncation":
            return (
                "请复核该 LLM 调用对应的生成段落是否突然中断、缺少参考文献或缺少结论；"
                "如不完整，请提高 max_tokens 或缩短输入后重新生成该章节。"
            )
        return (
            "请复核该 LLM 调用对应的生成段落是否完整，尤其是 JSON、表格、参考文献和章节结尾；"
            "如存在截断痕迹，请提高 max_tokens 或重新运行该生成阶段。"
        )
    if code == "llm_near_truncation":
        return (
            "Review the affected generated section for abrupt endings, missing references, or incomplete "
            "conclusions; rerun that stage with a larger max_tokens budget or shorter input if needed."
        )
    return (
        "Review the affected generated section for completeness, especially JSON, tables, references, "
        "and section endings; rerun the generation stage with a larger max_tokens budget if truncation remains."
    )


def _llm_reliability_remediation_message(recommended_max_tokens: int, language: str) -> str:
    if recommended_max_tokens <= 0:
        if _is_zh_quality_language(language):
            return "请人工复核对应生成段落；如存在截断，请重新运行该生成阶段并提高输出 token 预算。"
        return "Manually review the affected generated section; rerun that stage with a larger output token budget if truncated."
    if _is_zh_quality_language(language):
        return f"如确认存在截断或缺失内容，建议将该阶段 max_tokens 提高到至少 {recommended_max_tokens} 后重跑。"
    return f"If truncation or missing content is confirmed, rerun that stage with max_tokens of at least {recommended_max_tokens}."


def _llm_reliability_issue_snippet(review: dict, language: str) -> str:
    event_index = review.get("event_index")
    model = str(review.get("model") or "unknown model")
    endpoint = str(review.get("endpoint") or "unknown endpoint")
    finish_reason = str(review.get("finish_reason") or "")
    retryable = str(review.get("retryable_output_issue") or "")
    completion_tokens = review.get("completion_tokens", 0)
    max_tokens = review.get("max_tokens", 0)
    if _is_zh_quality_language(language):
        return (
            f"事件 {event_index}: {model} / {endpoint}; finish_reason={finish_reason}; "
            f"retryable_output_issue={retryable}; completion_tokens={completion_tokens}; max_tokens={max_tokens}."
        )
    return (
        f"Event {event_index}: {model} / {endpoint}; finish_reason={finish_reason}; "
        f"retryable_output_issue={retryable}; completion_tokens={completion_tokens}; max_tokens={max_tokens}."
    )


def _polish_rejection_review_payload(issue: dict, *, language: str = "en", index: int | None = None) -> dict[str, Any]:
    code = str(issue.get("code") or "polish_guard_issue")
    original_text = str(issue.get("original_text") or "")
    candidate_text = str(issue.get("candidate_text") or "")
    candidate_id = f"rejected:{index}:{code}" if index is not None else f"rejected:{code}"
    payload = {
        "candidate_id": candidate_id,
        "original_text": original_text,
        "candidate_text": candidate_text,
        "diff": issue.get("diff") or _polish_edit_diff(original_text, candidate_text),
        "review_action": issue.get("review_action") or "manual_review_required",
        "chunk_index": issue.get("chunk_index"),
        "chunk_count": issue.get("chunk_count"),
        "preservation_code": code,
        "message": _polish_guard_message(issue, language),
        "can_auto_apply": False,
        "manual_accept_allowed": True,
        "manual_accept_condition": _polish_manual_accept_condition(language),
    }
    for key in (
        "original_directional_terms",
        "candidate_directional_terms",
        "original_clinical_claim_terms",
        "candidate_clinical_claim_terms",
        "original_clinical_entities",
        "candidate_clinical_entities",
        "original_certainty_ratings",
        "candidate_certainty_ratings",
        "original_risk_of_bias_ratings",
        "candidate_risk_of_bias_ratings",
        "original_statistical_models",
        "candidate_statistical_models",
        "original_statistical_significance",
        "candidate_statistical_significance",
        "original_study_design_terms",
        "candidate_study_design_terms",
        "original_language",
        "candidate_language",
        "original_language_counts",
        "candidate_language_counts",
        "original_interpretive_certainty_terms",
        "candidate_interpretive_certainty_terms",
        "original_terms",
        "candidate_terms",
        "original_numeric_tokens",
        "candidate_numeric_tokens",
        "original_citations",
        "candidate_citations",
        "original_citation_bindings",
        "candidate_citation_bindings",
        "original_cross_references",
        "candidate_cross_references",
    ):
        if key in issue:
            payload[key] = issue.get(key)
    return payload


def _polish_rejected_edits_from_issues(issues: list[dict[str, Any]], *, language: str = "en") -> list[dict[str, Any]]:
    rejected: list[dict[str, Any]] = []
    for index, issue in enumerate(issues):
        if not isinstance(issue, dict) or issue.get("code") == "polish_budget_exhausted":
            continue
        original_text = str(issue.get("original_text") or "")
        candidate_text = str(issue.get("candidate_text") or "")
        if not original_text and not candidate_text:
            continue
        code = str(issue.get("code") or "polish_guard_issue")
        candidate_id = f"rejected:{index}:{code}"
        rejected.append({
            "candidate_id": candidate_id,
            "issue_id": candidate_id,
            "code": code,
            "heading": str(issue.get("heading") or issue.get("section") or ""),
            "message": _polish_guard_message(issue, language),
            "original_text": original_text,
            "candidate_text": candidate_text,
            "diff": issue.get("diff") or _polish_edit_diff(original_text, candidate_text),
            "review_action": issue.get("review_action") or "manual_review_required",
            "can_auto_apply": False,
            "manual_accept_allowed": True,
            "manual_accept_condition": _polish_manual_accept_condition(language),
            "chunk_index": issue.get("chunk_index"),
            "chunk_count": issue.get("chunk_count"),
        })
        for key in (
            "original_directional_terms",
            "candidate_directional_terms",
            "original_clinical_claim_terms",
            "candidate_clinical_claim_terms",
            "original_clinical_entities",
            "candidate_clinical_entities",
            "original_certainty_ratings",
            "candidate_certainty_ratings",
            "original_risk_of_bias_ratings",
            "candidate_risk_of_bias_ratings",
            "original_statistical_models",
            "candidate_statistical_models",
            "original_statistical_significance",
            "candidate_statistical_significance",
            "original_study_design_terms",
            "candidate_study_design_terms",
            "original_language",
            "candidate_language",
            "original_language_counts",
            "candidate_language_counts",
            "original_interpretive_certainty_terms",
            "candidate_interpretive_certainty_terms",
            "original_terms",
            "candidate_terms",
            "original_citation_bindings",
            "candidate_citation_bindings",
        ):
            if key in issue:
                rejected[-1][key] = issue.get(key)
    return rejected


def _polish_edit_diff(original_text: str, candidate_text: str) -> str:
    return "\n".join(
        difflib.unified_diff(
            str(original_text or "").splitlines(),
            str(candidate_text or "").splitlines(),
            fromfile="original",
            tofile="candidate",
            lineterm="",
        )
    )


def _polish_manual_accept_condition(language: str) -> str:
    if _is_zh_quality_language(language):
        return "仅在人工确认数字、引用、受保护术语和结论方向均未改变后，才可局部接受。"
    return (
        "May be manually accepted only after a human confirms that numbers, citations, "
        "protected terms, and conclusion direction are unchanged."
    )


def _actionable_citation_issue(
    draft_text: str,
    issue: dict,
    *,
    index: int,
    methodology_context: dict | None = None,
    evidence_context: dict | None = None,
    language: str = "en",
) -> dict[str, Any]:
    section = str(issue.get("section") or "Main text").strip() or "Main text"
    reference_entries = _manuscript_reference_count(draft_text)
    recommended = _recommended_citations_for_issue(
        issue,
        methodology_context=methodology_context or {},
        evidence_context=evidence_context or {},
        draft_text=draft_text,
    )
    recommended = _localized_citation_recommendations(recommended, language, draft_text=draft_text)
    add_candidates = _reference_add_candidates_for_issue(
        draft_text,
        issue,
        methodology_context=methodology_context or {},
        evidence_context=evidence_context or {},
        reference_entries=reference_entries,
    )
    add_candidates = _localized_reference_add_candidates(add_candidates, language, draft_text=draft_text)
    payload = {
        "id": f"citation_audit:{index}:{issue.get('code', 'issue')}:{_slugify_anchor(section)}",
        "source": "citation_audit",
        "code": issue.get("code") or "citation_issue",
        "severity": issue.get("severity") or "warn",
        "section": section,
        "target": _markdown_section_target(draft_text, section),
        "snippet": _citation_issue_snippet(draft_text, issue),
        "suggested_action": _citation_issue_suggested_action(issue, recommended, add_candidates, language=language),
        "recommended_citations": recommended,
        "reference_add_candidates": add_candidates,
        "message": issue.get("message") or "",
        "raw_issue": issue,
    }
    existing_citations = _citation_issue_existing_citations(issue)
    if existing_citations:
        payload["existing_citations"] = existing_citations
    return payload


def _citation_issue_existing_citations(issue: dict) -> list[str]:
    citations: list[str] = []
    for value in issue.get("existing_citations") or []:
        if isinstance(value, int):
            citation = f"[{value}]"
        else:
            citation = _canonical_inline_citation(value)
        if citation and citation not in citations:
            citations.append(citation)
    return citations


def _citation_issue_suggested_action(
    issue: dict,
    recommended: list[dict[str, Any]] | None = None,
    add_candidates: list[dict[str, Any]] | None = None,
    *,
    language: str = "en",
) -> str:
    code = str(issue.get("code") or "")
    section = str(issue.get("section") or "the affected section")
    recommended = recommended or []
    add_candidates = add_candidates or []
    insertion = ""
    zh = _is_zh_quality_language(language)
    if recommended:
        primary = str(recommended[0].get("citation") or "").strip()
        primary_display = str(recommended[0].get("display_citation") or primary).strip()
        alternates = [
            str(item.get("display_citation") or item.get("citation") or "").strip()
            for item in recommended[1:3]
            if item.get("citation")
        ]
        sections = [str(item) for item in recommended[0].get("recommended_sections") or [] if item]
        if zh:
            section_hint = f" 建议位置：{', '.join(_zh_quality_section_label(item) for item in sections)}。" if sections else ""
            if primary_display and alternates:
                insertion = f" 建议插入：{primary_display}。其他候选：{', '.join(alternates)}。{section_hint}"
            elif primary_display:
                insertion = f" 建议插入：{primary_display}。{section_hint}"
        elif primary and alternates:
            section_hint = f" Good target section(s): {', '.join(sections)}." if sections else ""
            insertion = f" Suggested insertion: {primary}. Additional candidates: {', '.join(alternates)}.{section_hint}"
        elif primary:
            section_hint = f" Good target section(s): {', '.join(sections)}." if sections else ""
            insertion = f" Suggested insertion: {primary}.{section_hint}"
    if add_candidates:
        primary_candidate = str(add_candidates[0].get("title") or add_candidates[0].get("reference_text") or "").strip()
        proposed = str(
            add_candidates[0].get("display_proposed_citation") or add_candidates[0].get("proposed_citation") or ""
        ).strip()
        if zh:
            candidate_hint = f" 可新增参考文献候选 {proposed}：{primary_candidate}。" if proposed and primary_candidate else ""
        else:
            candidate_hint = f" Add reference candidate {proposed}: {primary_candidate}." if proposed and primary_candidate else ""
        insertion = f"{insertion}{candidate_hint}"
    if code == "section_citations_missing":
        if zh:
            return f"请在{_zh_quality_section_label(section)}至少加入一处文内引用，可使用参考文献列表中的来源或新核验来源。{insertion}"
        return (
            f"Add at least one inline citation to {section}, using a source already present in References "
            f"or a newly verified source.{insertion}"
        )
    if code == "insufficient_reference_count":
        if zh:
            return f"投稿前请补充更多已核验参考文献，优先纳入研究、既往系统综述、临床指南和方法学标准。{insertion}"
        return (
            "Add more verified references before submission, prioritizing included trials, prior systematic reviews, "
            f"clinical guidelines, and methodology standards.{insertion}"
        )
    if code == "low_unique_cited_references":
        if zh:
            return f"请增加正文中被引用来源的多样性，避免引言、结果和讨论反复依赖同一小组参考文献。{insertion}"
        return (
            "Diversify the main-text citations so the Introduction, Results, and Discussion do not rely on the same "
            f"small set of references.{insertion}"
        )
    if code == "low_citation_density":
        if zh:
            return f"请在背景论述、方法学标准、主要结果陈述以及与既往证据比较处补充文内引用。{insertion}"
        return (
            "Add inline citations to background claims, methods standards, primary result statements, and comparison "
            f"with prior evidence.{insertion}"
        )
    if code == "introduction_background_citations_missing":
        if zh:
            return f"请在引言部分补充背景、指南或既往综述来源，而不是只引用纳入研究或方法学来源。{insertion}"
        return (
            "Add background, guideline, or prior-review citations to the Introduction instead of relying only on "
            f"included-study or methods references.{insertion}"
        )
    if code == "introduction_background_citation_count_low":
        if zh:
            return f"请在引言部分再补充背景、指南或既往综述来源，使背景论述不依赖单一上下文来源。{insertion}"
        return (
            "Add additional background, guideline, or prior-review citations to the Introduction so the background "
            f"does not rely on a single context source.{insertion}"
        )
    if code == "uncited_introduction_background_claim":
        if zh:
            return f"请把相关背景引用直接加到引言背景声明同一句后面，例如疾病负担、指南建议或既往证据声明。{insertion}"
        return (
            "Add the relevant background citation to the same sentence as the background claim, such as disease "
            f"burden, guideline recommendation, or prior-evidence statements.{insertion}"
        )
    if code == "methods_methodology_citations_missing":
        if zh:
            return f"请在方法部分补充报告规范、方法学手册、GRADE、偏倚风险或统计方法来源。{insertion}"
        return (
            "Add reporting-guideline, handbook, GRADE, risk-of-bias, or statistical-method citations to the "
            f"Methods section.{insertion}"
        )
    if code == "methods_methodology_citation_count_low":
        if zh:
            return f"请在方法部分再补充方法学来源，覆盖报告规范、手册、GRADE或统计方法，而不只依赖单一方法来源。{insertion}"
        return (
            "Add additional methods citations to cover reporting guidance, handbooks, GRADE, or statistical methods "
            f"instead of relying on a single methods source.{insertion}"
        )
    if code == "uncited_methods_methodology_claim":
        if zh:
            return f"请把相关方法学引用直接加到方法学声明同一句后面，例如报告规范、RoB、GRADE或统计模型声明。{insertion}"
        return (
            "Add the relevant methodology citation to the same sentence as the methodology claim, such as reporting "
            f"guidance, RoB, GRADE, or statistical-model statements.{insertion}"
        )
    if code == "uncited_discussion_context_claim":
        if zh:
            return f"请把相关语境引用直接加到讨论声明同一句后面，例如指南、既往证据、GRADE或发表偏倚解释。{insertion}"
        return (
            "Add the relevant context citation to the same sentence as the discussion claim, such as guideline, "
            f"prior-evidence, GRADE, or publication-bias interpretation.{insertion}"
        )
    if code == "uncited_discussion_result_claim":
        if zh:
            return f"请把支持来源报告引用直接加到讨论中的主要结果、安全性或临床解释声明同一句后面。{insertion}"
        return (
            "Add supporting source-report citations to the same sentence as the Discussion result claim, such as "
            f"primary-result, safety, or clinical-interpretation statements.{insertion}"
        )
    if code == "uncited_discussion_mechanism_claim":
        if zh:
            return f"请把支持背景或既往综述引用直接加到讨论中的机制解释声明同一句后面。{insertion}"
        return (
            "Add supporting background or prior-review citations to the same sentence as the Discussion mechanism "
            f"claim, such as biological, pathophysiologic, or treatment-mechanism explanations.{insertion}"
        )
    if code == "uncited_results_study_data_claim":
        if zh:
            return f"请把来源报告引用直接加到结果中的研究、受试者或结局数据来源声明同一句后面。{insertion}"
        return (
            "Add source-report citations to the same sentence as the Results study data claim, such as included "
            f"studies, participants, or outcome-data contribution statements.{insertion}"
        )
    if code == "uncited_conclusion_result_claim":
        if zh:
            return f"请把支持来源引用直接加到结论中的主要结果、安全性、临床解释或证据确定性声明同一句后面。{insertion}"
        return (
            "Add supporting citations to the same sentence as the Conclusion result claim, such as primary-result, "
            f"safety, clinical-interpretation, or certainty statements.{insertion}"
        )
    if code == "discussion_context_citations_missing":
        if zh:
            return f"请在讨论部分补充指南、既往综述、背景证据、GRADE确定性或发表偏倚语境来源。{insertion}"
        return (
            "Add guideline, prior-review, background-evidence, GRADE-certainty, or publication-bias context "
            f"citations to the Discussion section.{insertion}"
        )
    if code == "discussion_context_citation_count_low":
        if zh:
            return f"请在讨论部分再补充指南、既往综述、GRADE确定性或发表偏倚语境来源，使解释不依赖单一上下文来源。{insertion}"
        return (
            "Add additional guideline, prior-review, GRADE-certainty, or publication-bias context citations to the "
            f"Discussion section so interpretation does not rely on a single context source.{insertion}"
        )
    if code == "overloaded_citation_cluster":
        if zh:
            return "请把过长的引用簇拆开，将每个来源放到它实际支持的具体声明或相邻句子后面，而不是把所有编号堆在同一句。"
        return (
            "Split the long citation cluster and attach each source to the specific claim or nearby sentence it "
            "supports instead of stacking all reference numbers on one statement."
        )
    if code == "uncited_numeric_effect_claim":
        if zh:
            return "请把文内引用直接加到数值效应声明、置信区间、异质性或P值所在句子后面，确保具体结果可追溯。"
        return (
            "Add an inline citation directly after the effect estimate, confidence interval, heterogeneity, "
            "or P-value sentence so the specific quantitative claim is traceable."
        )
    if code == "numeric_effect_claim_lacks_source_citation":
        if zh:
            return f"该数值效应句已有引用，但缺少试验、注册或来源报告引用；请把来源报告引用直接补到同一句数值声明后面。{insertion}"
        return (
            "This numeric effect sentence is cited, but not to a trial, registry, or source-report reference. "
            f"Add the source-report citation directly after the quantitative claim.{insertion}"
        )
    if code == "main_text_citations_missing":
        if zh:
            return "请在参考文献部分之前的正文中加入文内引用。"
        return "Add inline citations in the main manuscript text before the References section."
    if code == "undefined_citation_number":
        nums = ", ".join(str(num) for num in issue.get("citation_numbers") or [])
        suffix = f" ({nums})" if nums else ""
        if zh:
            return f"请替换或移除未定义的引用编号{suffix}，或补齐缺失的参考文献条目。"
        return f"Replace or remove undefined citation number(s){suffix}, or add the missing reference entries."
    if zh:
        return "请复核该引用审计问题，并在最终导出前补充或修正文内引用。"
    return "Review the citation audit issue and add or correct inline references before final export."


def _localized_citation_recommendations(
    recommended: list[dict[str, Any]] | None,
    language: str,
    *,
    draft_text: str = "",
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in recommended or []:
        if not isinstance(item, dict):
            continue
        row = dict(item)
        row["display_citation"] = _display_citation_for_quality_context(row.get("citation"), language, draft_text)
        rows.append(row)
    return rows


def _localized_reference_add_candidates(
    candidates: list[dict[str, Any]] | None,
    language: str,
    *,
    draft_text: str = "",
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in candidates or []:
        if not isinstance(item, dict):
            continue
        row = dict(item)
        row["display_proposed_citation"] = _display_citation_for_quality_context(
            row.get("proposed_citation"),
            language,
            draft_text,
        )
        rows.append(row)
    return rows


def _display_citation_for_quality_context(citation: Any, language: str, draft_text: str = "") -> str:
    if _is_zh_quality_language(language) or _prefers_full_width_citations(draft_text):
        return _display_citation_for_language(citation, "zh")
    return _display_citation_for_language(citation, language)


def _display_citation_for_language(citation: Any, language: str) -> str:
    canonical = _canonical_inline_citation(citation) or str(citation or "").strip()
    if not canonical:
        return ""
    if not _is_zh_quality_language(language):
        return canonical
    match = re.fullmatch(r"\[([0-9,\-]+)\]", canonical)
    if not match:
        return canonical
    return "［" + match.group(1).replace(",", "，") + "］"


def _is_zh_quality_language(language: str) -> bool:
    return str(language or "").strip().lower() in {"zh", "cn", "chinese", "mixed"}


def _zh_quality_section_label(section: str) -> str:
    mapping = {
        "Introduction": "引言部分",
        "Methods": "方法部分",
        "Results": "结果部分",
        "Discussion": "讨论部分",
        "Conclusion": "结论部分",
        "References": "参考文献部分",
        "Main text": "正文",
    }
    raw = str(section or "").strip()
    return mapping.get(raw, raw if raw.endswith(("部分", "正文")) else f"{raw}部分")


def _recommended_citations_for_issue(
    issue: dict,
    *,
    methodology_context: dict,
    evidence_context: dict,
    draft_text: str = "",
) -> list[dict[str, Any]]:
    code = str(issue.get("code") or "")
    if code not in {
        "section_citations_missing",
        "main_text_citations_missing",
        "insufficient_reference_count",
        "low_unique_cited_references",
        "low_citation_density",
        "introduction_background_citations_missing",
        "introduction_background_citation_count_low",
        "uncited_introduction_background_claim",
        "methods_methodology_citations_missing",
        "methods_methodology_citation_count_low",
        "uncited_methods_methodology_claim",
        "numeric_effect_claim_lacks_source_citation",
        "uncited_results_study_data_claim",
        "uncited_conclusion_result_claim",
        "discussion_context_citations_missing",
        "discussion_context_citation_count_low",
        "uncited_discussion_context_claim",
        "uncited_discussion_result_claim",
        "uncited_discussion_mechanism_claim",
    }:
        return []
    section = str(issue.get("section") or "").strip().lower()
    methodology_refs = _context_reference_candidates(methodology_context)
    evidence_refs = _context_reference_candidates(evidence_context)
    explicit_numbers = _explicit_recommended_citation_numbers(issue)
    if code in {"introduction_background_citations_missing", "introduction_background_citation_count_low"}:
        ordered = _rank_reference_candidates(
            evidence_refs,
            preferred_types=["guideline", "clinical_guideline", "prior_review", "systematic_review", "pubmed_background"],
        )
    elif code == "uncited_introduction_background_claim":
        claim_types = {
            str(item).strip().lower()
            for item in (issue.get("background_claim_types") or [])
            if str(item).strip()
        }
        preferred_by_claim = {
            "disease_burden": ["pubmed_background", "prior_review", "systematic_review"],
            "guideline_context": ["clinical_guideline", "guideline"],
            "prior_evidence": ["prior_review", "systematic_review", "pubmed_background"],
        }
        preferred_types: list[str] = []
        for claim_type in claim_types:
            for source_type in preferred_by_claim.get(claim_type, []):
                if source_type not in preferred_types:
                    preferred_types.append(source_type)
        ordered = _rank_reference_candidates(
            [
                item for item in evidence_refs
                if str(item.get("source_type") or "").strip().lower() in set(preferred_types)
            ],
            preferred_types=preferred_types or ["pubmed_background", "clinical_guideline", "guideline", "prior_review", "systematic_review"],
        )
    elif code in {"methods_methodology_citations_missing", "methods_methodology_citation_count_low"}:
        ordered = _rank_reference_candidates(
            methodology_refs,
            preferred_types=[
                "reporting_guideline",
                "methods_handbook",
                "risk_of_bias_tool",
                "certainty_framework",
                "statistical_method",
                "publication_bias_method",
            ],
        )
    elif code == "uncited_methods_methodology_claim":
        claim_types = {
            str(item).strip().lower()
            for item in (issue.get("methodology_claim_types") or [])
            if str(item).strip()
        }
        ordered = _rank_reference_candidates(
            [
                item for item in methodology_refs
                if str(item.get("source_type") or "").strip().lower() in claim_types
            ],
            preferred_types=[
                "reporting_guideline",
                "methods_handbook",
                "risk_of_bias_tool",
                "certainty_framework",
                "statistical_method",
                "publication_bias_method",
            ],
        )
    elif code in {"discussion_context_citations_missing", "discussion_context_citation_count_low"}:
        ordered = (
            _rank_reference_candidates(
                evidence_refs,
                preferred_types=["guideline", "clinical_guideline", "prior_review", "systematic_review", "pubmed_background"],
            )
            + _rank_reference_candidates(
                methodology_refs,
                preferred_types=["certainty_framework", "publication_bias_method"],
            )
        )
    elif code == "uncited_discussion_context_claim":
        claim_types = {
            str(item).strip().lower()
            for item in (issue.get("discussion_context_claim_types") or [])
            if str(item).strip()
        }
        preferred_by_claim = {
            "prior_evidence": ["prior_review", "systematic_review", "pubmed_background"],
            "guideline_context": ["clinical_guideline", "guideline"],
            "certainty_context": ["certainty_framework"],
            "publication_bias_context": ["publication_bias_method"],
        }
        preferred_types: list[str] = []
        for claim_type in claim_types:
            for source_type in preferred_by_claim.get(claim_type, []):
                if source_type not in preferred_types:
                    preferred_types.append(source_type)
        combined_refs = evidence_refs + methodology_refs
        ordered = _rank_reference_candidates(
            [
                item for item in combined_refs
                if str(item.get("source_type") or "").strip().lower() in set(preferred_types)
            ],
            preferred_types=preferred_types or ["prior_review", "systematic_review", "clinical_guideline", "guideline", "certainty_framework", "publication_bias_method"],
        )
    elif code == "uncited_discussion_result_claim":
        claim_types = {
            str(item).strip().lower()
            for item in (issue.get("discussion_result_claim_types") or [])
            if str(item).strip()
        }
        preferred_by_claim = {
            "safety_result": ["included_trial", "trial_report", "registry_results", "clinical_trial"],
            "primary_result": ["included_trial", "trial_report", "registry_results", "clinical_trial", "prior_review", "systematic_review"],
        }
        preferred_types: list[str] = []
        for claim_type in claim_types:
            for source_type in preferred_by_claim.get(claim_type, []):
                if source_type not in preferred_types:
                    preferred_types.append(source_type)
        ordered = _rank_reference_candidates(
            [
                item for item in evidence_refs
                if str(item.get("source_type") or "").strip().lower() in set(preferred_types)
            ],
            preferred_types=preferred_types or ["included_trial", "trial_report", "registry_results", "clinical_trial"],
        )
    elif code == "uncited_discussion_mechanism_claim":
        claim_types = {
            str(item).strip().lower()
            for item in (issue.get("discussion_mechanism_claim_types") or [])
            if str(item).strip()
        }
        preferred_by_claim = {
            "mechanistic_explanation": ["pubmed_background", "prior_review", "systematic_review", "clinical_guideline", "guideline"],
        }
        preferred_types: list[str] = []
        for claim_type in claim_types:
            for source_type in preferred_by_claim.get(claim_type, []):
                if source_type not in preferred_types:
                    preferred_types.append(source_type)
        ordered = _rank_reference_candidates(
            [
                item for item in evidence_refs
                if str(item.get("source_type") or "").strip().lower() in set(preferred_types)
            ],
            preferred_types=preferred_types or ["pubmed_background", "prior_review", "systematic_review"],
        )
    elif code == "uncited_results_study_data_claim":
        ordered = _rank_reference_candidates(
            evidence_refs,
            preferred_types=["included_trial", "trial_report", "registry_results", "clinical_trial"],
        )
    elif code == "numeric_effect_claim_lacks_source_citation":
        ordered = _rank_reference_candidates(
            evidence_refs,
            preferred_types=["included_trial", "trial_report", "registry_results", "clinical_trial"],
        )
        if not ordered and explicit_numbers:
            ordered = _rank_reference_candidates(
                [
                    item for item in _bibliography_reference_candidates(draft_text)
                    if (
                        _citation_number(item.get("citation")) in explicit_numbers
                        and str(item.get("source_type") or "") in {
                            "included_trial",
                            "trial_report",
                            "registry_results",
                            "clinical_trial",
                        }
                    )
                ],
                preferred_types=["included_trial", "trial_report", "registry_results", "clinical_trial"],
            )
    elif code == "uncited_conclusion_result_claim":
        claim_types = {
            str(item).strip().lower()
            for item in (issue.get("conclusion_claim_types") or [])
            if str(item).strip()
        }
        preferred_by_claim = {
            "safety_result": ["included_trial", "trial_report", "registry_results", "clinical_trial"],
            "primary_result": ["included_trial", "trial_report", "registry_results", "clinical_trial", "prior_review", "systematic_review"],
            "certainty_context": ["certainty_framework"],
        }
        preferred_types: list[str] = []
        for claim_type in claim_types:
            for source_type in preferred_by_claim.get(claim_type, []):
                if source_type not in preferred_types:
                    preferred_types.append(source_type)
        ordered = _rank_reference_candidates(
            [
                item for item in (evidence_refs + methodology_refs)
                if str(item.get("source_type") or "").strip().lower() in set(preferred_types)
            ],
            preferred_types=preferred_types or ["included_trial", "trial_report", "registry_results", "clinical_trial", "certainty_framework"],
        )
    elif code in {"insufficient_reference_count", "low_unique_cited_references", "low_citation_density"}:
        cited_numbers = {int(num) for num in issue.get("cited_reference_numbers") or [] if str(num).isdigit()}
        ordered = _prioritize_uncited_reference_candidates(
            (
                _rank_reference_candidates(evidence_refs, preferred_types=["prior_review", "guideline", "pubmed_background", "registry_results", "included_trial"])
                + _rank_reference_candidates(
                    methodology_refs,
                    preferred_types=["reporting_guideline", "methods_handbook", "certainty_framework", "statistical_method"],
                )
            ),
            cited_numbers,
        )
    elif section in {"methods", "方法"}:
        ordered = _rank_reference_candidates(
            methodology_refs,
            preferred_types=[
                "reporting_guideline",
                "methods_handbook",
                "risk_of_bias_tool",
                "certainty_framework",
                "statistical_method",
                "publication_bias_method",
            ],
        )
    elif section in {"results", "结果"}:
        ordered = _rank_reference_candidates(
            evidence_refs,
            preferred_types=["included_trial", "registry_results", "trial_report", "pubmed_background"],
        )
    elif section in {"discussion", "讨论"}:
        ordered = (
            _rank_reference_candidates(evidence_refs, preferred_types=["guideline", "prior_review", "pubmed_background", "included_trial"])
            + _rank_reference_candidates(methodology_refs, preferred_types=["certainty_framework", "publication_bias_method"])
        )
    else:
        ordered = (
            _rank_reference_candidates(evidence_refs, preferred_types=["guideline", "prior_review", "pubmed_background", "included_trial"])
            + _rank_reference_candidates(methodology_refs, preferred_types=["reporting_guideline"])
        )
    if explicit_numbers:
        ordered = [
            item for item in ordered
            if _citation_number(item.get("citation")) in explicit_numbers
        ]
    seen: set[str] = set()
    recommendations: list[dict[str, Any]] = []
    for item in ordered:
        citation = str(item.get("citation") or "").strip()
        if not citation or citation in seen:
            continue
        seen.add(citation)
        recommendations.append(item)
        if len(recommendations) >= 3:
            break
    return recommendations


def _reference_add_candidates_for_issue(
    draft_text: str,
    issue: dict,
    *,
    methodology_context: dict,
    evidence_context: dict,
    reference_entries: int,
) -> list[dict[str, Any]]:
    code = str(issue.get("code") or "")
    if code not in {
        "section_citations_missing",
        "main_text_citations_missing",
        "insufficient_reference_count",
        "low_unique_cited_references",
        "low_citation_density",
        "introduction_background_citations_missing",
        "introduction_background_citation_count_low",
        "uncited_introduction_background_claim",
        "methods_methodology_citations_missing",
        "methods_methodology_citation_count_low",
        "uncited_methods_methodology_claim",
        "uncited_results_study_data_claim",
        "uncited_conclusion_result_claim",
        "discussion_context_citations_missing",
        "discussion_context_citation_count_low",
        "uncited_discussion_context_claim",
        "uncited_discussion_result_claim",
        "uncited_discussion_mechanism_claim",
    }:
        return []
    existing_numbers = set(range(1, max(0, int(reference_entries)) + 1))
    existing_titles = _manuscript_reference_title_tokens(draft_text)
    candidates: list[dict[str, Any]] = []
    for item in _reference_add_candidate_rows_for_issue(
        issue,
        methodology_context=methodology_context,
        evidence_context=evidence_context,
    ):
        citation_number = _citation_number(item.get("citation"))
        if citation_number is not None and citation_number in existing_numbers:
            continue
        title = str(item.get("title") or (item.get("paper") or {}).get("title") or "").strip()
        if not title or _reference_title_token(title) in existing_titles:
            continue
        proposed_number = reference_entries + len(candidates) + 1
        paper = item.get("paper") if isinstance(item.get("paper"), dict) else {"title": title}
        candidates.append({
            "candidate_id": str(item.get("study_id") or item.get("candidate_id") or f"reference_candidate_{proposed_number}"),
            "source_type": item.get("source_type") or "",
            "title": title,
            "study_id": item.get("study_id") or "",
            "proposed_citation": f"[{proposed_number}]",
            "reference_number": proposed_number,
            "reference_text": _format_numbered_reference_from_paper(paper, proposed_number),
            "bibtex_entry": _format_bibtex_entry_from_paper(paper, proposed_number),
            "recommended_sections": _recommended_sections_for_reference_add_candidate(item, issue),
            "paper": paper,
            "reason": item.get("source_type") or "reference_context",
            "source": _reference_add_candidate_source_payload(item, paper),
            "trust": _reference_add_candidate_trust_payload(),
            "can_auto_apply": False,
        })
        if len(candidates) >= 5:
            break
    return candidates


def _reference_add_candidate_rows_for_issue(
    issue: dict,
    *,
    methodology_context: dict,
    evidence_context: dict,
) -> list[dict[str, Any]]:
    code = str(issue.get("code") or "")
    section = _canonical_quality_section(issue.get("section"))
    evidence_rows = _context_reference_add_candidate_rows(evidence_context)
    methodology_rows = _context_reference_add_candidate_rows(methodology_context)
    preferred_types = _preferred_reference_source_types_for_issue(issue)
    if preferred_types:
        combined_rows = evidence_rows + methodology_rows
        preferred_set = set(preferred_types)
        return _rank_reference_candidates(
            [
                item for item in combined_rows
                if str(item.get("source_type") or "").strip().lower() in preferred_set
            ],
            preferred_types=preferred_types,
        )
    if code in {"methods_methodology_citations_missing", "methods_methodology_citation_count_low"} or section == "Methods":
        rows = methodology_rows + evidence_rows
        return [item for item in rows if _reference_candidate_matches_section(item, "Methods")]
    if code in {"introduction_background_citations_missing", "introduction_background_citation_count_low"} or section == "Introduction":
        rows = evidence_rows + methodology_rows
        return [item for item in rows if _reference_candidate_matches_section(item, "Introduction")]
    if code in {"discussion_context_citations_missing", "discussion_context_citation_count_low"} or section == "Discussion":
        rows = evidence_rows + methodology_rows
        return [item for item in rows if _reference_candidate_matches_section(item, "Discussion")]
    if section == "Results":
        rows = evidence_rows + methodology_rows
        return [item for item in rows if _reference_candidate_matches_section(item, "Results")]
    return evidence_rows + methodology_rows


def _reference_candidate_matches_section(item: dict, section: str) -> bool:
    recommended = _recommended_sections_for_reference(str(item.get("source_type") or ""))
    return str(section or "") in recommended


def _preferred_reference_source_types_for_issue(issue: dict) -> list[str]:
    code = str(issue.get("code") or "")
    if code in {"introduction_background_citations_missing", "introduction_background_citation_count_low"}:
        return ["guideline", "clinical_guideline", "prior_review", "systematic_review", "pubmed_background"]
    if code == "uncited_introduction_background_claim":
        return _claim_preferred_source_types(
            issue.get("background_claim_types"),
            {
                "disease_burden": ["pubmed_background", "prior_review", "systematic_review"],
                "guideline_context": ["clinical_guideline", "guideline"],
                "prior_evidence": ["prior_review", "systematic_review", "pubmed_background"],
            },
            ["pubmed_background", "clinical_guideline", "guideline", "prior_review", "systematic_review"],
        )
    if code in {"methods_methodology_citations_missing", "methods_methodology_citation_count_low"}:
        return [
            "reporting_guideline",
            "methods_handbook",
            "risk_of_bias_tool",
            "certainty_framework",
            "statistical_method",
            "publication_bias_method",
        ]
    if code == "uncited_methods_methodology_claim":
        return _claim_preferred_source_types(
            issue.get("methodology_claim_types"),
            {
                "reporting_guideline": ["reporting_guideline"],
                "methods_handbook": ["methods_handbook"],
                "risk_of_bias_tool": ["risk_of_bias_tool"],
                "certainty_framework": ["certainty_framework"],
                "statistical_method": ["statistical_method"],
                "publication_bias_method": ["publication_bias_method"],
            },
            [
                "reporting_guideline",
                "methods_handbook",
                "risk_of_bias_tool",
                "certainty_framework",
                "statistical_method",
                "publication_bias_method",
            ],
        )
    if code in {"discussion_context_citations_missing", "discussion_context_citation_count_low"}:
        return [
            "guideline",
            "clinical_guideline",
            "prior_review",
            "systematic_review",
            "pubmed_background",
            "certainty_framework",
            "publication_bias_method",
        ]
    if code == "uncited_discussion_context_claim":
        return _claim_preferred_source_types(
            issue.get("discussion_context_claim_types"),
            {
                "prior_evidence": ["prior_review", "systematic_review", "pubmed_background"],
                "guideline_context": ["clinical_guideline", "guideline"],
                "certainty_context": ["certainty_framework"],
                "publication_bias_context": ["publication_bias_method"],
            },
            [
                "prior_review",
                "systematic_review",
                "clinical_guideline",
                "guideline",
                "certainty_framework",
                "publication_bias_method",
            ],
        )
    if code == "uncited_discussion_result_claim":
        return _claim_preferred_source_types(
            issue.get("discussion_result_claim_types"),
            {
                "safety_result": ["included_trial", "trial_report", "registry_results", "clinical_trial"],
                "primary_result": [
                    "included_trial",
                    "trial_report",
                    "registry_results",
                    "clinical_trial",
                    "prior_review",
                    "systematic_review",
                ],
            },
            ["included_trial", "trial_report", "registry_results", "clinical_trial"],
        )
    if code == "uncited_discussion_mechanism_claim":
        return _claim_preferred_source_types(
            issue.get("discussion_mechanism_claim_types"),
            {
                "mechanistic_explanation": [
                    "pubmed_background",
                    "prior_review",
                    "systematic_review",
                    "clinical_guideline",
                    "guideline",
                ],
            },
            ["pubmed_background", "prior_review", "systematic_review"],
        )
    if code == "uncited_results_study_data_claim":
        return ["included_trial", "trial_report", "registry_results", "clinical_trial"]
    if code == "uncited_conclusion_result_claim":
        return _claim_preferred_source_types(
            issue.get("conclusion_claim_types"),
            {
                "safety_result": ["included_trial", "trial_report", "registry_results", "clinical_trial"],
                "primary_result": [
                    "included_trial",
                    "trial_report",
                    "registry_results",
                    "clinical_trial",
                    "prior_review",
                    "systematic_review",
                ],
                "certainty_context": ["certainty_framework"],
            },
            ["included_trial", "trial_report", "registry_results", "clinical_trial", "certainty_framework"],
        )
    return []


def _claim_preferred_source_types(
    claim_types: Any,
    preferred_by_claim: dict[str, list[str]],
    fallback: list[str],
) -> list[str]:
    preferred: list[str] = []
    for claim_type in [str(item).strip().lower() for item in (claim_types or []) if str(item).strip()]:
        for source_type in preferred_by_claim.get(claim_type, []):
            if source_type not in preferred:
                preferred.append(source_type)
    return preferred or list(fallback)


def _recommended_sections_for_reference_add_candidate(item: dict, issue: dict) -> list[str]:
    source_type = str(item.get("source_type") or "")
    sections = _recommended_sections_for_reference(source_type)
    issue_section = _canonical_quality_section(issue.get("section"))
    preferred_types = set(_preferred_reference_source_types_for_issue(issue))
    if (
        issue_section in {"Introduction", "Methods", "Results", "Discussion", "Conclusion"}
        and source_type.strip().lower() in preferred_types
        and issue_section not in sections
    ):
        return [issue_section] + sections
    return sections


def _canonical_quality_section(section: Any) -> str:
    raw = str(section or "").strip().lower()
    mapping = {
        "introduction": "Introduction",
        "引言": "Introduction",
        "背景": "Introduction",
        "methods": "Methods",
        "方法": "Methods",
        "results": "Results",
        "结果": "Results",
        "discussion": "Discussion",
        "讨论": "Discussion",
        "conclusion": "Conclusion",
        "结论": "Conclusion",
    }
    return mapping.get(raw, str(section or "").strip())


def _reference_add_candidate_source_payload(item: dict, paper: dict) -> dict[str, Any]:
    source_type = str(item.get("source_type") or "").strip()
    study_id = str(item.get("study_id") or item.get("candidate_id") or "").strip()
    return {
        "source_type": source_type,
        "study_id": study_id,
        "source": str(paper.get("source") or item.get("source") or "reference_context").strip(),
        "title": str(paper.get("title") or item.get("title") or "").strip(),
        "url": str(paper.get("url") or item.get("url") or "").strip(),
        "doi": str(paper.get("doi") or item.get("doi") or "").strip(),
        "pmid": str(paper.get("pmid") or item.get("pmid") or "").strip(),
        "registry_id": str(paper.get("registry_id") or item.get("registry_id") or "").strip(),
    }


def _reference_add_candidate_trust_payload() -> dict[str, Any]:
    return {
        "status": "needs_review",
        "requires_human_review": True,
        "review_action": "verify_reference_before_adding",
        "message": "Verify this external reference before adding it to the manuscript.",
    }


def _context_reference_add_candidate_rows(context: dict) -> list[dict[str, Any]]:
    refs = context.get("references") if isinstance(context, dict) else []
    return [item for item in refs if isinstance(item, dict)] if isinstance(refs, list) else []


def _prioritize_uncited_reference_candidates(candidates: list[dict[str, Any]], cited_numbers: set[int]) -> list[dict[str, Any]]:
    uncited: list[dict[str, Any]] = []
    already_cited: list[dict[str, Any]] = []
    for item in candidates:
        citation_number = _citation_number(item.get("citation"))
        if citation_number is not None and citation_number in cited_numbers:
            already_cited.append(item)
        else:
            uncited.append(item)
    return uncited + already_cited


def _context_reference_candidates(context: dict) -> list[dict[str, Any]]:
    refs = context.get("references") if isinstance(context, dict) else []
    candidates: list[dict[str, Any]] = []
    for item in refs if isinstance(refs, list) else []:
        if not isinstance(item, dict):
            continue
        citation = str(item.get("citation") or "").strip()
        title = item.get("title") or (item.get("paper") or {}).get("title") or ""
        if not citation or citation == "[?]" or not title:
            continue
        candidates.append({
            "citation": citation,
            "title": title,
            "source_type": item.get("source_type") or "",
            "study_id": item.get("study_id") or "",
            "reason": item.get("source_type") or "reference_context",
            "recommended_sections": _recommended_sections_for_reference(item.get("source_type") or ""),
        })
    return candidates


def _bibliography_reference_candidates(draft_text: str) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for match in re.finditer(
        r"(?ms)^\s*[\[［](\d+)[\]］]\s*(.*?)(?=^\s*[\[［]\d+[\]］]\s+|\Z)",
        _references_section_body(draft_text),
    ):
        number = int(match.group(1))
        reference_text = re.sub(r"\s+", " ", match.group(2).strip())
        if not reference_text:
            continue
        source_type = _bibliography_reference_source_type(reference_text)
        if not source_type:
            continue
        candidates.append({
            "citation": f"[{number}]",
            "title": reference_text,
            "source_type": source_type,
            "study_id": f"bibliography:{number}",
            "reason": "manuscript_reference_list",
            "recommended_sections": _recommended_sections_for_reference(source_type),
        })
    return candidates


def _bibliography_reference_source_type(reference_text: str) -> str:
    lower = str(reference_text or "").lower()
    if any(
        term in lower
        for term in (
            "clinicaltrials.gov",
            "eudract",
            "clinical trials register",
            "trial registry",
            "registry results",
        )
    ):
        return "registry_results"
    if any(
        re.search(pattern, lower, flags=re.I)
        for pattern in (
            r"\bnct\d{8}\b",
            r"\brandomi[sz]ed(?:\s+\w+){0,4}\s+trial\b",
            r"\brandomi[sz]ed(?:\s+\w+){0,4}\s+clinical\s+trial\b",
            r"\bclinical\s+trial\b",
            r"\bcontrolled\s+trial\b",
            r"\bplacebo-controlled\s+trial\b",
            r"\btrial\s+report\b",
            r"\bphase\s+(?:ii|iii|2|3)(?:\s+\w+){0,4}\s+trial\b",
        )
    ):
        return "trial_report"
    return ""


def _citation_number(citation: Any) -> int | None:
    match = re.fullmatch(r"(?:\[(\d+)\]|［(\d+)］)", str(citation or "").strip())
    if not match:
        return None
    number = match.group(1) or match.group(2)
    return int(number) if number else None


def _explicit_recommended_citation_numbers(issue: dict) -> set[int]:
    numbers: set[int] = set()
    for value in (issue.get("recommended_citations") or []):
        if isinstance(value, int):
            numbers.add(value)
        else:
            citation_number = _citation_number(value)
            if citation_number is not None:
                numbers.add(citation_number)
    return numbers


def _recommended_sections_for_reference(source_type: str) -> list[str]:
    source = str(source_type or "").strip()
    if source in {"guideline", "clinical_guideline", "prior_review", "systematic_review", "pubmed_background"}:
        return ["Introduction", "Discussion"]
    if source in {"included_trial", "registry_results", "trial_report", "clinical_trial"}:
        return ["Results", "Discussion"]
    if source in {"reporting_guideline", "methods_handbook", "risk_of_bias_tool", "statistical_method", "certainty_framework", "publication_bias_method"}:
        return ["Methods"]
    return ["Introduction", "Discussion"]


def _manuscript_reference_count(draft_text: str) -> int:
    return len(re.findall(r"^\s*(?:\[\d+\]|［\d+］)\s+", _references_section_body(draft_text), flags=re.M))


def _references_section_body(draft_text: str) -> str:
    raw = str(draft_text or "")
    match = _reference_heading_match(raw)
    if not match:
        return ""
    remainder = raw[match.end():]
    next_heading = re.search(r"^#{1,6}\s+", remainder, flags=re.M)
    return remainder[: next_heading.start()] if next_heading else remainder


def _manuscript_reference_title_tokens(draft_text: str) -> set[str]:
    tokens: set[str] = set()
    for line in _references_section_body(draft_text).splitlines():
        line = line.strip()
        if not (line.startswith("[") or line.startswith("［")):
            continue
        parts = re.split(r"\.\s+", re.sub(r"^(?:\[\d+\]|［\d+］)\s*", "", line), maxsplit=2)
        if len(parts) >= 2:
            tokens.add(_reference_title_token(parts[1]))
    return {token for token in tokens if token}


def _reference_title_token(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(title or "").lower()).strip()


def _format_numbered_reference_from_paper(paper: dict, number: int) -> str:
    authors = [str(author).strip() for author in (paper.get("authors") or []) if str(author).strip()]
    author_str = ", ".join(authors[:6]) + (", et al." if len(authors) > 6 else "")
    if not author_str:
        author_str = "Unknown"
    title = str(paper.get("title") or "").strip()
    journal = str(paper.get("journal") or "").strip()
    year = str(paper.get("year") or "").strip()
    volume = str(paper.get("volume") or "").strip()
    issue = str(paper.get("issue") or "").strip()
    pages = str(paper.get("pages") or paper.get("page") or "").strip()
    doi = str(paper.get("doi") or "").strip()
    url = str(paper.get("url") or "").strip()
    journal_part = f"*{journal}*. " if journal else ""
    citation_detail = year
    if volume:
        citation_detail += f";{volume}"
        if issue:
            citation_detail += f"({issue})"
        if pages:
            citation_detail += f":{pages}"
    elif pages:
        citation_detail += f":{pages}"
    ref = f"[{number}] {author_str}. {title}. {journal_part}{citation_detail}."
    if doi:
        ref += f" doi: {doi}"
    if url:
        ref += f" {url}"
    return ref


def _format_bibtex_entry_from_paper(paper: dict, number: int) -> str:
    def field(name: str) -> str:
        return str(paper.get(name) or "").strip()

    authors = [str(author).strip() for author in (paper.get("authors") or []) if str(author).strip()] or ["Unknown"]
    key_base = re.sub(r"[^a-z0-9]+", "", authors[0].split()[0].lower()) or "reference"
    year = re.sub(r"[^0-9A-Za-z]+", "", field("year")) or "0000"
    return (
        f"@article{{{key_base}{year}_{number},\n"
        f"  title = {{{field('title')}}},\n"
        f"  author = {{{' and '.join(authors)}}},\n"
        f"  journal = {{{field('journal')}}},\n"
        f"  year = {{{field('year')}}},\n"
        f"  volume = {{{field('volume')}}},\n"
        f"  issue = {{{field('issue')}}},\n"
        f"  pages = {{{field('pages') or field('page')}}},\n"
        f"  doi = {{{field('doi')}}},\n"
        f"  pmid = {{{field('pmid')}}},\n"
        f"  url = {{{field('url')}}},\n"
        f"}}"
    )


def _rank_reference_candidates(candidates: list[dict[str, Any]], *, preferred_types: list[str]) -> list[dict[str, Any]]:
    rank = {source_type: index for index, source_type in enumerate(preferred_types)}
    return sorted(
        candidates,
        key=lambda item: (
            rank.get(str(item.get("source_type") or ""), len(rank) + 1),
            str(item.get("citation") or ""),
        ),
    )


def _citation_issue_snippet(draft_text: str, issue: dict) -> str:
    code = str(issue.get("code") or "")
    if code == "undefined_citation_number":
        numbers = [str(num) for num in issue.get("citation_numbers") or []]
        for num in numbers:
            snippet = _snippet_around_pattern(draft_text, rf"(?:\[{re.escape(num)}\]|［{re.escape(num)}］)")
            if snippet:
                return snippet
    if code == "overloaded_citation_cluster":
        marker = str(issue.get("citation_marker") or "").strip()
        if marker:
            snippet = _snippet_around_pattern(draft_text, re.escape(marker))
            if snippet:
                return snippet
    if code in {
        "uncited_numeric_effect_claim",
        "uncited_methods_methodology_claim",
        "uncited_introduction_background_claim",
        "uncited_discussion_context_claim",
        "uncited_discussion_result_claim",
        "uncited_discussion_mechanism_claim",
        "uncited_results_study_data_claim",
        "uncited_conclusion_result_claim",
    }:
        excerpt = str(issue.get("evidence_excerpt") or "").strip()
        if excerpt:
            return excerpt
    return _section_snippet(draft_text, str(issue.get("section") or "Main text"))


def _markdown_section_target(draft_text: str, section: str) -> dict[str, Any]:
    heading = str(section or "Main text").strip() or "Main text"
    line = _markdown_section_start_line(draft_text, heading)
    return {
        "type": "markdown_section",
        "heading": heading,
        "anchor": _slugify_anchor(heading),
        "line": line,
    }


def _section_snippet(draft_text: str, section: str, *, max_chars: int = 240) -> str:
    text = _markdown_section_text_for_quality(draft_text, section)
    clean = _compact_markdown_snippet(text)
    if len(clean) <= max_chars:
        return clean
    return clean[: max_chars - 1].rstrip() + "..."


def _snippet_around_pattern(draft_text: str, pattern: str, *, max_chars: int = 240) -> str:
    match = re.search(pattern, str(draft_text or ""))
    if not match:
        return ""
    start = max(0, match.start() - max_chars // 2)
    end = min(len(draft_text), match.end() + max_chars // 2)
    return _compact_markdown_snippet(draft_text[start:end])


def _markdown_section_text_for_quality(draft_text: str, section: str) -> str:
    raw = str(draft_text or "")
    heading = str(section or "").strip()
    if not raw:
        return ""
    if heading.lower() in {"main text", "manuscript"}:
        return _main_text_before_reference_section(raw)
    aliases = {
        "Introduction": ["Introduction", "引言"],
        "Methods": ["Methods", "方法"],
        "Results": ["Results", "结果"],
        "Discussion": ["Discussion", "讨论"],
        "Conclusion": ["Conclusion", "结论"],
    }.get(heading, [heading])
    for alias in aliases:
        match = re.search(rf"^##\s+{re.escape(alias)}\s*$", raw, flags=re.I | re.M)
        if not match:
            continue
        remainder = raw[match.end():]
        next_heading = re.search(r"^##\s+", remainder, flags=re.M)
        return remainder[: next_heading.start()] if next_heading else remainder
    return _main_text_before_reference_section(raw)


def _markdown_section_start_line(draft_text: str, section: str) -> int | None:
    raw = str(draft_text or "")
    heading = str(section or "").strip()
    if not raw or heading.lower() in {"main text", "manuscript"}:
        return 1 if raw else None
    aliases = {
        "Introduction": ["Introduction", "引言"],
        "Methods": ["Methods", "方法"],
        "Results": ["Results", "结果"],
        "Discussion": ["Discussion", "讨论"],
        "Conclusion": ["Conclusion", "结论"],
    }.get(heading, [heading])
    for alias in aliases:
        match = re.search(rf"^##\s+{re.escape(alias)}\s*$", raw, flags=re.I | re.M)
        if match:
            return raw[: match.start()].count("\n") + 1
    return None


def _compact_markdown_snippet(text: str) -> str:
    clean = re.sub(r"```.*?```", " ", str(text or ""), flags=re.S)
    clean = re.sub(r"^#+\s*", "", clean, flags=re.M)
    clean = re.sub(r"\s+", " ", clean)
    return clean.strip()


def _slugify_anchor(value: str) -> str:
    slug = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "-", str(value or "").strip().lower()).strip("-")
    return slug or "manuscript"


def _compact_polish_audit(audit: dict, *, language: str = "en") -> dict:
    if not isinstance(audit, dict) or not audit:
        return {
            "available": False,
            "enabled": False,
            "language": "",
            "rewrite_scope": "",
            "accepted_chunks": 0,
            "rejected_chunks": 0,
            "unchanged_chunks": 0,
            "attempted_chunks": 0,
            "skipped_chunks": 0,
            "skipped_chunk_details": [],
            "total_rewrite_chunks": 0,
            "targeted_chunks": 0,
            "non_target_chunks": 0,
            "rewrite_retries": 0,
            "retry_recovered_chunks": 0,
            "polish_budget_exhausted": False,
            "accepted_sections": 0,
            "rejected_sections": 0,
            "unchanged_sections": 0,
            "accepted_edit_count": 0,
            "accepted_edits": [],
            "rejected_edit_count": 0,
            "rejected_edits": [],
            "issue_count": 0,
            "issues": [],
            "review_queue": _polish_review_queue(
                {},
                accepted_edits=[],
                rejected_edits=[],
                remaining_style_issues=[],
                proofreading_issues=[],
                language=language,
            ),
            "style_review": _polish_style_review_payload({}),
        }
    issues = audit.get("issues") or []
    accepted_edits = [item for item in (audit.get("accepted_edits") or []) if isinstance(item, dict)]
    rejected_edits = _polish_rejected_edits_from_issues(
        [item for item in issues if isinstance(item, dict)] if isinstance(issues, list) else [],
        language=language,
    )
    proofreading = _polish_proofreading_payload(audit.get("proofreading") if isinstance(audit, dict) else {})
    style_review = _polish_style_review_payload(audit)
    summary = {
        "accepted_edit_count": int(
            audit.get("accepted_edit_count") if audit.get("accepted_edit_count") is not None else len(accepted_edits)
        ),
        "fact_guard_issues": sum(
            1
            for item in (issues if isinstance(issues, list) else [])
            if isinstance(item, dict) and item.get("code") != "polish_budget_exhausted"
        ),
        "polish_budget_exhausted": bool(audit.get("polish_budget_exhausted")),
        "skipped_chunks": int(audit.get("skipped_chunks") or 0),
        "proofreading_issues": int(proofreading.get("issue_count") or 0),
        "proofreading_failed": bool(proofreading.get("failed")),
        "proofreading_error": proofreading.get("error") or "",
        "rewrite_retries": int(audit.get("rewrite_retries") or 0),
        "retry_recovered_chunks": int(audit.get("retry_recovered_chunks") or 0),
    }
    return {
        "available": True,
        "enabled": bool(audit.get("enabled")),
        "language": audit.get("language") or "",
        "rewrite_scope": audit.get("rewrite_scope") or "",
        "accepted_chunks": int(audit.get("accepted_chunks") or 0),
        "rejected_chunks": int(audit.get("rejected_chunks") or 0),
        "unchanged_chunks": int(audit.get("unchanged_chunks") or 0),
        "attempted_chunks": int(audit.get("attempted_chunks") or 0),
        "skipped_chunks": int(audit.get("skipped_chunks") or 0),
        "skipped_chunk_details": [
            item for item in (audit.get("skipped_chunk_details") or [])[:20]
            if isinstance(item, dict)
        ],
        "total_rewrite_chunks": int(audit.get("total_rewrite_chunks") or 0),
        "targeted_chunks": int(audit.get("targeted_chunks") or 0),
        "non_target_chunks": int(audit.get("non_target_chunks") or 0),
        "rewrite_retries": int(audit.get("rewrite_retries") or 0),
        "retry_recovered_chunks": int(audit.get("retry_recovered_chunks") or 0),
        "polish_budget_exhausted": bool(audit.get("polish_budget_exhausted")),
        "accepted_sections": int(audit.get("accepted_sections") or 0),
        "rejected_sections": int(audit.get("rejected_sections") or 0),
        "unchanged_sections": int(audit.get("unchanged_sections") or 0),
        "accepted_edit_count": summary["accepted_edit_count"],
        "accepted_edits": accepted_edits[:20],
        "rejected_edit_count": len(rejected_edits),
        "rejected_edits": rejected_edits[:20],
        "issue_count": len(issues) if isinstance(issues, list) else 0,
        "issues": issues[:20] if isinstance(issues, list) else [],
        "style_policy": audit.get("style_policy") if isinstance(audit.get("style_policy"), dict) else {},
        "proofreading": proofreading,
        "review_queue": _polish_review_queue(
            summary,
            accepted_edits=accepted_edits,
            rejected_edits=rejected_edits,
            remaining_style_issues=style_review.get("remaining_issues") or [],
            proofreading_issues=proofreading.get("issues") or [],
            language=language,
        ),
        "style_review": style_review,
    }


def _polish_proofreading_payload(proofreading: dict | None) -> dict[str, Any]:
    data = proofreading if isinstance(proofreading, dict) else {}
    issues = [item for item in (data.get("issues") or []) if isinstance(item, dict)]
    status = str(data.get("status") or ("disabled" if not data.get("enabled") else ""))
    return {
        "enabled": bool(data.get("enabled")),
        "status": status,
        "provider": data.get("provider") or "none",
        "language_code": data.get("language_code") or "",
        "issue_count": int(data.get("issue_count") if data.get("issue_count") is not None else len(issues)),
        "issues": issues[:20],
        "review_only": True,
        "failed": status == "failed",
        "error": str(data.get("error") or ""),
    }


def _polish_review_queue(
    summary: dict[str, Any],
    *,
    accepted_edits: list[dict[str, Any]],
    rejected_edits: list[dict[str, Any]],
    remaining_style_issues: list[dict[str, Any]],
    proofreading_issues: list[dict[str, Any]],
    language: str = "en",
) -> dict[str, Any]:
    zh = _is_zh_quality_language(language)
    rejected_count = max(len(rejected_edits), int(summary.get("fact_guard_issues") or 0))
    style_count = len(remaining_style_issues)
    proofreading_count = int(summary.get("proofreading_issues") or len(proofreading_issues))
    proofreading_failed = bool(summary.get("proofreading_failed"))
    proofreading_error = str(summary.get("proofreading_error") or "")
    budget_exhausted = bool(summary.get("polish_budget_exhausted"))
    skipped_chunks = int(summary.get("skipped_chunks") or 0)
    rewrite_retries = int(summary.get("rewrite_retries") or 0)
    retry_recovered_chunks = int(summary.get("retry_recovered_chunks") or 0)
    manual_items = rejected_count + style_count + proofreading_count
    if proofreading_failed:
        manual_items += 1
    if manual_items == 0 and (budget_exhausted or skipped_chunks):
        manual_items = 1
    if rejected_count or style_count or proofreading_count or proofreading_failed:
        status = "human_review_required"
    elif budget_exhausted or skipped_chunks:
        status = "budget_review_required"
    elif accepted_edits:
        status = "polish_applied_no_review_required"
    else:
        status = "no_polish_review_needed"

    next_actions: list[str] = []
    if rejected_count:
        next_actions.append(
            "逐条复核被拒绝的润色候选；仅在人工确认数字、引用、受保护术语和结论方向未改变后才可接受。"
            if zh else
            "Review rejected polish candidates; manually accept only after a human confirms that numbers, citations, protected terms, and conclusion direction are unchanged."
        )
    if style_count:
        next_actions.append(
            "人工处理剩余风格信号；不要自动重写含有事实、数值或引用的句子。"
            if zh else
            "Review remaining style signals manually; do not auto-rewrite sentences that contain facts, numbers, or citations."
        )
    if proofreading_count:
        next_actions.append(
            "逐条审阅外部审校建议；不要批量自动应用。"
            if zh else
            "Review external proofreading suggestions one by one; do not batch auto-apply them."
        )
    if proofreading_failed:
        next_actions.append(_polish_proofreading_failed_next_action(language))
    if budget_exhausted or skipped_chunks:
        next_actions.append(
            "润色片段预算已触发；如需更深润色，请提高片段预算后重跑，并重新检查事实保护闸。"
            if zh else
            "Review unchanged chunks caused by the polish chunk budget; rerun with a higher chunk budget only if deeper polish is needed, then re-check fact guards."
        )
    if not next_actions:
        next_actions.append("暂无润色复核动作。" if zh else "No polish review action is required.")

    return {
        "status": status,
        "accepted_auto_edits": int(summary.get("accepted_edit_count") or len(accepted_edits)),
        "rejected_candidates": rejected_count,
        "remaining_style_issues": style_count,
        "proofreading_issues": proofreading_count,
        "proofreading_failed": proofreading_failed,
        "proofreading_error": proofreading_error,
        "manual_review_items": manual_items,
        "budget_exhausted": budget_exhausted,
        "skipped_chunks": skipped_chunks,
        "rewrite_retries": rewrite_retries,
        "retry_recovered_chunks": retry_recovered_chunks,
        "can_auto_apply_rejected_edits": False,
        "next_actions": next_actions,
    }


def _polish_style_review_payload(audit: dict) -> dict[str, Any]:
    before_data = audit.get("before") if isinstance(audit, dict) else {}
    after_data = audit.get("after") if isinstance(audit, dict) else {}
    before = before_data if isinstance(before_data, dict) else {}
    after = after_data if isinstance(after_data, dict) else {}
    language = str(audit.get("language") or before.get("language") or after.get("language") or "").strip().lower()
    before_signal = before.get("ai_style_signal") if isinstance(before, dict) else {}
    after_signal = after.get("ai_style_signal") if isinstance(after, dict) else {}
    before_score = int((before_signal or {}).get("score") or 0)
    after_score = int((after_signal or {}).get("score") or 0)
    before_codes = _polish_style_issue_codes(before_signal)
    remaining_codes = _polish_style_issue_codes(after_signal)
    remaining_issues = _polish_style_issue_details(
        after_signal,
        language,
        template_phrase_hits=after.get("template_phrase_hits") if isinstance(after, dict) else {},
    )
    resolved_codes = [code for code in before_codes if code not in set(remaining_codes)]
    resolved_issues = _polish_resolved_style_issue_details(
        before_signal,
        resolved_codes,
        language,
        template_phrase_hits=before.get("template_phrase_hits") if isinstance(before, dict) else {},
    )
    available = bool(before_signal or after_signal)
    status = _polish_style_status(
        available=available,
        before_score=before_score,
        after_score=after_score,
        remaining_codes=remaining_codes,
    )
    return {
        "available": available,
        "before_score": before_score,
        "after_score": after_score,
        "delta": after_score - before_score,
        "improved": after_score < before_score,
        "status": status,
        "resolved_issue_codes": resolved_codes,
        "resolved_issue_count": len(resolved_codes),
        "resolved_issues": resolved_issues,
        "remaining_issue_codes": remaining_codes,
        "remaining_issue_count": len(remaining_codes),
        "remaining_issues": remaining_issues,
        "before": before_signal or {},
        "after": after_signal or {},
        "can_auto_apply": False,
        "suggested_action": _polish_style_suggested_action(language, status),
    }


def _polish_style_issue_codes(signal: dict | None) -> list[str]:
    codes: list[str] = []
    data = signal if isinstance(signal, dict) else {}
    for item in data.get("issues") or []:
        if not isinstance(item, dict):
            continue
        code = str(item.get("code") or "").strip()
        if code and code not in codes:
            codes.append(code)
    return codes


def _polish_resolved_style_issue_details(
    before_signal: dict | None,
    resolved_codes: list[str],
    language: str,
    *,
    template_phrase_hits: dict | None = None,
) -> list[dict[str, Any]]:
    data = before_signal if isinstance(before_signal, dict) else {}
    before_issues = [item for item in (data.get("issues") or []) if isinstance(item, dict)]
    details: list[dict[str, Any]] = []
    for code in resolved_codes:
        original = next((item for item in before_issues if str(item.get("code") or "").strip() == code), {})
        issue = dict(original)
        issue["code"] = code
        _enrich_polish_style_issue(issue, template_phrase_hits=template_phrase_hits)
        issue["status"] = "resolved_after_polish"
        issue.setdefault("message", _polish_style_issue_message(code, language))
        issue.setdefault(
            "suggested_action",
            "Keep the accepted polish for this issue unless a later fact-preservation review fails."
            if not _is_zh_quality_language(language)
            else "保留已接受的润色结果；如后续事实保护复核失败，再回退该处修改。",
        )
        details.append(issue)
    return details


def _polish_style_issue_details(
    signal: dict | None,
    language: str,
    *,
    template_phrase_hits: dict | None = None,
) -> list[dict[str, Any]]:
    details: list[dict[str, Any]] = []
    data = signal if isinstance(signal, dict) else {}
    for item in data.get("issues") or []:
        if not isinstance(item, dict):
            continue
        issue = dict(item)
        code = str(issue.get("code") or "").strip()
        _enrich_polish_style_issue(issue, template_phrase_hits=template_phrase_hits)
        issue.setdefault("message", _polish_style_issue_message(code, language))
        issue.setdefault("suggested_action", _polish_style_issue_action(code, language))
        details.append(issue)
    return details


def _enrich_polish_style_issue(issue: dict[str, Any], *, template_phrase_hits: dict | None = None) -> None:
    code = str(issue.get("code") or "").strip()
    if code != "template_phrase_hits":
        return
    if issue.get("phrases"):
        return
    hits = template_phrase_hits if isinstance(template_phrase_hits, dict) else {}
    phrases = sorted(str(phrase) for phrase in hits if str(phrase).strip())
    if phrases:
        issue["phrases"] = phrases


def _polish_style_issue_message(code: str, language: str) -> str:
    zh = _is_zh_quality_language(language)
    messages = {
        "template_phrase_hits": "检测到模板化过渡短语，可能让稿件显得机械。" if zh else "Template-like transition phrases remain after polish.",
        "repeated_sentence_starts": "多个句子使用相同开头，段落节奏偏重复。" if zh else "Several sentences still start the same way, making the passage sound repetitive.",
        "low_sentence_length_variation": "句长变化过低，段落节奏可能显得过于均匀。" if zh else "Sentence lengths are too uniform, which can make the passage sound mechanical.",
        "low_lexical_diversity": "词汇变化偏低，建议人工检查是否重复使用相同表达。" if zh else "Lexical diversity is low; repeated wording may need human review.",
    }
    return messages.get(code, "仍有风格信号需要人工复核。" if zh else "A remaining style signal needs human review.")


def _polish_style_issue_action(code: str, language: str) -> str:
    zh = _is_zh_quality_language(language)
    if code == "template_phrase_hits":
        return "人工删改模板短语，保留数字、引用、研究名称和结论方向不变。" if zh else "Manually remove formulaic phrases while preserving numbers, citations, study names, and conclusion direction."
    if code == "repeated_sentence_starts":
        return "人工改写相邻句子的开头和连接方式；不要重写事实句中的数值或引用。" if zh else "Manually vary adjacent sentence openings and transitions without changing factual sentences, numbers, or citations."
    if code == "low_sentence_length_variation":
        return "人工拆分或合并少量相邻句，增加句长节奏变化；不要为了风格改写效应量句。" if zh else "Manually split or combine a few adjacent sentences to vary rhythm; do not rewrite effect-estimate sentences just for style."
    if code == "low_lexical_diversity":
        return "人工替换重复的非技术性表达；保留术语、结局名称和方法学标签。" if zh else "Manually vary repeated non-technical wording while preserving terms, outcome names, and methods labels."
    return "人工复核该风格信号；事实保护优先于继续自动改写。" if zh else "Review this style signal manually; fact preservation takes priority over further automatic rewriting."


def _polish_style_status(
    *,
    available: bool,
    before_score: int,
    after_score: int,
    remaining_codes: list[str],
) -> str:
    if not available:
        return "not_available"
    if after_score < before_score:
        return "improved_with_remaining_issues" if remaining_codes else "improved_no_obvious_remaining_issue"
    if after_score > before_score:
        return "regressed"
    return "unchanged_with_remaining_issues" if remaining_codes else "unchanged_no_obvious_issue"


def _polish_style_suggested_action(language: str, status: str = "") -> str:
    if _is_zh_quality_language(language):
        if status == "improved_no_obvious_remaining_issue":
            return "当前未见明显AI写作风格信号；建议保留已审计版本，只做人工通读和术语一致性检查，不要为了风格继续改写事实句。"
        if status == "regressed":
            return "润色后风格信号增加；请回退到原文或打开人工复核，在不改变数字、引用、研究名称和结论的前提下重写问题句。"
        return "请复核剩余的风格信号，并重新运行事实保护润色，或在不改变数字、引用、研究名称和结论的前提下手动编辑。"
    if status == "improved_no_obvious_remaining_issue":
        return (
            "No obvious AI-style signal remains; keep the audited version and do only human proofreading "
            "for clarity, terminology, and journal style."
        )
    if status == "regressed":
        return (
            "Style signals increased after polish; revert to the original wording or open manual review, "
            "then rewrite only the affected sentences without changing numbers, citations, study names, or conclusions."
        )
    return (
        "Review remaining style signals and rerun fact-preserving polish or edit manually without changing "
        "numbers, citations, study names, or conclusions."
    )


def _compact_reference_context(context: dict) -> dict:
    refs = context.get("references") if isinstance(context, dict) else []
    refs = refs if isinstance(refs, list) else []
    return {
        "available": bool(refs),
        "status": context.get("status") if isinstance(context, dict) else None,
        "query": context.get("query") if isinstance(context, dict) else "",
        "reference_count": len(refs),
        "added_references": int(context.get("added_references") or 0) if isinstance(context, dict) else 0,
        "references": [
            {
                "citation": item.get("citation"),
                "title": item.get("title") or (item.get("paper") or {}).get("title"),
                "source_type": item.get("source_type"),
                "study_id": item.get("study_id"),
            }
            for item in refs[:12]
            if isinstance(item, dict)
        ],
    }


def _push_manuscript_quality(project, ctx: dict, push) -> dict | None:
    payload = _load_manuscript_quality_payload(project, ctx)
    if payload and push:
        push("manuscript_quality", payload)
    return payload


def _make_manuscript_polish_progress_cb(push):
    """Bridge core polish progress events to the WebSocket event stream."""
    if not push:
        return None

    def progress_cb(event: dict):
        payload = dict(event or {})
        payload.setdefault("schema_version", 1)
        payload.setdefault("stage", "manuscript_polish")
        payload["step_index"] = 9
        payload["step_name"] = META_STEPS[9] if len(META_STEPS) > 9 else "Manuscript"
        push("manuscript_polish_progress", payload)

    return progress_cb


def _manuscript_quality_delta(before: dict | None, after: dict | None) -> dict[str, Any]:
    """Summarize user-visible quality movement after a manuscript edit."""
    before = before if isinstance(before, dict) else {}
    after = after if isinstance(after, dict) else {}

    def issue_ids(payload: dict, *, source: str | None = None) -> set[str]:
        ids: set[str] = set()
        for issue in payload.get("actionable_issues") or []:
            if not isinstance(issue, dict):
                continue
            if source and issue.get("source") != source:
                continue
            issue_id = str(issue.get("id") or "").strip()
            if issue_id:
                ids.add(issue_id)
        return ids

    def citation_summary_int(payload: dict, key: str) -> int:
        citation_audit = payload.get("citation_audit") if isinstance(payload, dict) else {}
        summary = (citation_audit or {}).get("summary") if isinstance(citation_audit, dict) else {}
        try:
            return int((summary or {}).get(key) or 0)
        except (TypeError, ValueError):
            return 0

    def int_field(payload: dict, key: str) -> int:
        try:
            return int(payload.get(key) or 0)
        except (TypeError, ValueError):
            return 0

    before_ids = issue_ids(before)
    after_ids = issue_ids(after)
    before_citation_ids = issue_ids(before, source="citation_audit")
    after_citation_ids = issue_ids(after, source="citation_audit")
    before_primary_result_ids = issue_ids(before, source="primary_result")
    after_primary_result_ids = issue_ids(after, source="primary_result")
    before_claim_support_ids = issue_ids(before, source="claim_support")
    after_claim_support_ids = issue_ids(after, source="claim_support")
    reference_entries_before = int_field(before, "reference_entries")
    reference_entries_after = int_field(after, "reference_entries")

    def audit_summary_int(payload: dict, audit_key: str, summary_key: str) -> int:
        audit = payload.get(audit_key) if isinstance(payload, dict) else {}
        summary = (audit or {}).get("summary") if isinstance(audit, dict) else {}
        try:
            return int((summary or {}).get(summary_key) or 0)
        except (TypeError, ValueError):
            return 0

    primary_mismatches_before = audit_summary_int(before, "primary_result_audit", "mismatched_fields")
    primary_mismatches_after = audit_summary_int(after, "primary_result_audit", "mismatched_fields")
    primary_failed_before = audit_summary_int(before, "primary_result_audit", "failed_issues")
    primary_failed_after = audit_summary_int(after, "primary_result_audit", "failed_issues")
    claim_unsupported_before = audit_summary_int(before, "claim_support_audit", "unsupported_claims")
    claim_unsupported_after = audit_summary_int(after, "claim_support_audit", "unsupported_claims")
    claim_failed_before = audit_summary_int(before, "claim_support_audit", "failed_issues")
    claim_failed_after = audit_summary_int(after, "claim_support_audit", "failed_issues")

    return {
        "schema_version": 1,
        "quality_status_before": before.get("quality_status") or "unknown",
        "quality_status_after": after.get("quality_status") or "unknown",
        "action_required_before": bool(before.get("action_required")),
        "action_required_after": bool(after.get("action_required")),
        "review_required_before": bool(before.get("review_required")),
        "review_required_after": bool(after.get("review_required")),
        "reference_entries_before": reference_entries_before,
        "reference_entries_after": reference_entries_after,
        "reference_entries_added": max(0, reference_entries_after - reference_entries_before),
        "actionable_issue_count_before": len(before_ids),
        "actionable_issue_count_after": len(after_ids),
        "resolved_issue_ids": sorted(before_ids - after_ids),
        "remaining_issue_ids": sorted(before_ids & after_ids),
        "new_issue_ids": sorted(after_ids - before_ids),
        "citation_failed_issues_before": citation_summary_int(before, "failed_issues"),
        "citation_failed_issues_after": citation_summary_int(after, "failed_issues"),
        "citation_warning_issues_before": citation_summary_int(before, "warning_issues"),
        "citation_warning_issues_after": citation_summary_int(after, "warning_issues"),
        "citation_audit_passed_before": bool((before.get("citation_audit") or {}).get("passed")),
        "citation_audit_passed_after": bool((after.get("citation_audit") or {}).get("passed")),
        "resolved_citation_issue_ids": sorted(before_citation_ids - after_citation_ids),
        "remaining_citation_issue_ids": sorted(before_citation_ids & after_citation_ids),
        "new_citation_issue_ids": sorted(after_citation_ids - before_citation_ids),
        "primary_result_mismatched_fields_before": primary_mismatches_before,
        "primary_result_mismatched_fields_after": primary_mismatches_after,
        "primary_result_mismatched_fields_resolved": max(0, primary_mismatches_before - primary_mismatches_after),
        "primary_result_failed_issues_before": primary_failed_before,
        "primary_result_failed_issues_after": primary_failed_after,
        "primary_result_failed_issues_resolved": max(0, primary_failed_before - primary_failed_after),
        "primary_result_audit_passed_before": bool((before.get("primary_result_audit") or {}).get("passed")),
        "primary_result_audit_passed_after": bool((after.get("primary_result_audit") or {}).get("passed")),
        "resolved_primary_result_issue_ids": sorted(before_primary_result_ids - after_primary_result_ids),
        "remaining_primary_result_issue_ids": sorted(before_primary_result_ids & after_primary_result_ids),
        "new_primary_result_issue_ids": sorted(after_primary_result_ids - before_primary_result_ids),
        "claim_support_unsupported_claims_before": claim_unsupported_before,
        "claim_support_unsupported_claims_after": claim_unsupported_after,
        "claim_support_unsupported_claims_resolved": max(0, claim_unsupported_before - claim_unsupported_after),
        "claim_support_failed_issues_before": claim_failed_before,
        "claim_support_failed_issues_after": claim_failed_after,
        "claim_support_failed_issues_resolved": max(0, claim_failed_before - claim_failed_after),
        "claim_support_audit_passed_before": bool((before.get("claim_support_audit") or {}).get("passed")),
        "claim_support_audit_passed_after": bool((after.get("claim_support_audit") or {}).get("passed")),
        "resolved_claim_support_issue_ids": sorted(before_claim_support_ids - after_claim_support_ids),
        "remaining_claim_support_issue_ids": sorted(before_claim_support_ids & after_claim_support_ids),
        "new_claim_support_issue_ids": sorted(after_claim_support_ids - before_claim_support_ids),
    }


def _preview_manuscript_citation_patch_payload(payload: dict, *, parent_id: str = "", user_id: str = "") -> dict:
    project_dir = _resolve_project_dir(payload.get("project_dir"), parent_id=parent_id)
    from new_meta.core.project import Project

    project = Project("manuscript citation patch", resume_dir=project_dir)
    patch = _build_manuscript_citation_patch(project, payload)
    return {
        **patch,
        "ok": True,
        "applied": False,
        "project_dir": str(project.base_dir),
    }


def _apply_manuscript_citation_patch_payload(payload: dict, *, parent_id: str = "", user_id: str = "") -> dict:
    project_dir = _resolve_project_dir(payload.get("project_dir"), parent_id=parent_id)
    from new_meta.core.project import Project

    project = Project("manuscript citation patch", resume_dir=project_dir)
    log = _load_manuscript_citation_fix_log(project)
    expected_revision = payload.get("expected_revision")
    if expected_revision is not None and int(expected_revision) != int(log.get("current_revision") or 0):
        return {
            "ok": False,
            "error": "revision_conflict",
            "current_revision": int(log.get("current_revision") or 0),
            "message": "Manuscript citation fix revision has changed; reload manuscript quality before applying.",
        }

    before_quality = _load_manuscript_quality_payload(project, {})
    patch = _build_manuscript_citation_patch(project, payload)
    project.save_text("draft.before_citation_fix.md", patch["original_text"], subdir="manuscript")
    project.save_text("draft.md", patch["updated_text"], subdir="manuscript")

    new_revision = int(log.get("current_revision") or 0) + 1
    entry = {
        "revision": new_revision,
        "issue_id": patch["issue"]["id"],
        "section": patch["issue"]["section"],
        "citation": patch["citation"],
        "display_citation": patch.get("display_citation") or patch["citation"],
        "user_id": user_id or payload.get("user_id") or "",
        "created_at": _make_ts(),
        "before": patch["before"],
        "after": patch["after"],
        "diff": patch["diff"],
    }
    entries = list(log.get("entries") or [])
    entries.append(entry)
    project.save_json(
        "manuscript_citation_fixes.json",
        {"schema_version": 1, "current_revision": new_revision, "entries": entries},
        subdir="manuscript",
    )
    project.clear_checkpoint("manuscript")
    project.save_checkpoint("manuscript")
    quality = _load_manuscript_quality_payload(project, {})
    quality_delta = _manuscript_quality_delta(before_quality, quality)
    entry["quality_delta"] = quality_delta
    project.save_json(
        "manuscript_citation_fixes.json",
        {"schema_version": 1, "current_revision": new_revision, "entries": entries},
        subdir="manuscript",
    )
    return {
        **{key: value for key, value in patch.items() if key != "original_text" and key != "updated_text"},
        "ok": True,
        "applied": True,
        "project_dir": str(project.base_dir),
        "current_revision": new_revision,
        "manuscript_quality": quality,
        "quality_delta": quality_delta,
    }


def _preview_manuscript_reference_add_payload(payload: dict, *, parent_id: str = "", user_id: str = "") -> dict:
    project_dir = _resolve_project_dir(payload.get("project_dir"), parent_id=parent_id)
    from new_meta.core.project import Project

    project = Project("manuscript reference add", resume_dir=project_dir)
    patch = _build_manuscript_reference_add_patch(project, payload)
    return {
        **patch,
        "ok": True,
        "applied": False,
        "project_dir": str(project.base_dir),
    }


def _apply_manuscript_reference_add_payload(payload: dict, *, parent_id: str = "", user_id: str = "") -> dict:
    project_dir = _resolve_project_dir(payload.get("project_dir"), parent_id=parent_id)
    from new_meta.core.project import Project

    project = Project("manuscript reference add", resume_dir=project_dir)
    log = _load_manuscript_citation_fix_log(project)
    expected_revision = payload.get("expected_revision")
    if expected_revision is not None and int(expected_revision) != int(log.get("current_revision") or 0):
        return {
            "ok": False,
            "error": "revision_conflict",
            "current_revision": int(log.get("current_revision") or 0),
            "message": "Manuscript citation fix revision has changed; reload manuscript quality before applying.",
        }

    before_quality = _load_manuscript_quality_payload(project, {})
    patch = _build_manuscript_reference_add_patch(project, payload)
    project.save_text("draft.before_reference_add.md", patch["original_text"], subdir="manuscript")
    project.save_text("draft.md", patch["updated_text"], subdir="manuscript")
    current_bib = project.load_text("references.bib") or ""
    bib_joiner = "\n\n" if current_bib.strip() else ""
    project.save_text("references.bib", current_bib.rstrip() + bib_joiner + patch["bibtex_entry"], subdir=None)
    _sync_reference_add_context_citations(project, [patch])

    new_revision = int(log.get("current_revision") or 0) + 1
    entry = {
        "revision": new_revision,
        "action": "add_reference",
        "issue_id": patch["issue"]["id"],
        "candidate_id": patch["candidate"]["candidate_id"],
        "candidate_source": patch["candidate"].get("source") or {},
        "trust": patch["candidate"].get("trust") or {},
        "section": patch["target_section"],
        "citation": patch["citation"],
        "display_citation": patch.get("display_citation") or patch["citation"],
        "reference_text": patch["reference_text"],
        "user_id": user_id or payload.get("user_id") or "",
        "created_at": _make_ts(),
        "before": patch["before"],
        "after": patch["after"],
        "diff": patch["diff"],
    }
    entries = list(log.get("entries") or [])
    entries.append(entry)
    project.save_json(
        "manuscript_citation_fixes.json",
        {"schema_version": 1, "current_revision": new_revision, "entries": entries},
        subdir="manuscript",
    )
    project.clear_checkpoint("manuscript")
    project.save_checkpoint("manuscript")
    quality = _load_manuscript_quality_payload(project, {})
    quality_delta = _manuscript_quality_delta(before_quality, quality)
    entry["quality_delta"] = quality_delta
    project.save_json(
        "manuscript_citation_fixes.json",
        {"schema_version": 1, "current_revision": new_revision, "entries": entries},
        subdir="manuscript",
    )
    return {
        **{key: value for key, value in patch.items() if key != "original_text" and key != "updated_text"},
        "ok": True,
        "applied": True,
        "project_dir": str(project.base_dir),
        "current_revision": new_revision,
        "manuscript_quality": quality,
        "quality_delta": quality_delta,
    }


def _preview_manuscript_reference_add_batch_payload(payload: dict, *, parent_id: str = "", user_id: str = "") -> dict:
    project_dir = _resolve_project_dir(payload.get("project_dir"), parent_id=parent_id)
    from new_meta.core.project import Project

    project = Project("manuscript reference add batch", resume_dir=project_dir)
    patch = _build_manuscript_reference_add_batch_patch(project, payload)
    return {
        **patch,
        "ok": True,
        "applied": False,
        "project_dir": str(project.base_dir),
    }


def _apply_manuscript_reference_add_batch_payload(payload: dict, *, parent_id: str = "", user_id: str = "") -> dict:
    project_dir = _resolve_project_dir(payload.get("project_dir"), parent_id=parent_id)
    from new_meta.core.project import Project

    project = Project("manuscript reference add batch", resume_dir=project_dir)
    log = _load_manuscript_citation_fix_log(project)
    expected_revision = payload.get("expected_revision")
    if expected_revision is not None and int(expected_revision) != int(log.get("current_revision") or 0):
        return {
            "ok": False,
            "error": "revision_conflict",
            "current_revision": int(log.get("current_revision") or 0),
            "message": "Manuscript citation fix revision has changed; reload manuscript quality before applying.",
        }

    before_quality = _load_manuscript_quality_payload(project, {})
    patch = _build_manuscript_reference_add_batch_patch(project, payload)
    project.save_text("draft.before_reference_add_batch.md", patch["original_text"], subdir="manuscript")
    project.save_text("draft.md", patch["updated_text"], subdir="manuscript")
    current_bib = project.load_text("references.bib") or ""
    bib_joiner = "\n\n" if current_bib.strip() and patch["bibtex_entries"] else ""
    project.save_text("references.bib", current_bib.rstrip() + bib_joiner + "\n\n".join(patch["bibtex_entries"]), subdir=None)
    _sync_reference_add_context_citations(project, patch["items"])

    new_revision = int(log.get("current_revision") or 0) + 1
    batch_id = payload.get("batch_id") or f"reference_add_batch_{new_revision}"
    entries = list(log.get("entries") or [])
    batch_entries: list[dict[str, Any]] = []
    for item in patch["items"]:
        reference_added = bool(item.get("reference_added"))
        entry = {
            "revision": new_revision,
            "batch_id": batch_id,
            "action": "add_reference" if reference_added else "reuse_reference_citation",
            "issue_id": item["issue"]["id"],
            "candidate_id": item["candidate"]["candidate_id"],
            "candidate_source": item["candidate"].get("source") or {},
            "trust": item["candidate"].get("trust") or {},
            "section": item["target_section"],
            "citation": item["citation"],
            "display_citation": item.get("display_citation") or item["citation"],
            "reference_added": reference_added,
            "reference_text": item["reference_text"],
            "user_id": user_id or payload.get("user_id") or "",
            "created_at": _make_ts(),
            "before": item["before"],
            "after": item["after"],
            "diff": item["diff"],
        }
        batch_entries.append(entry)
        entries.append(entry)
    project.save_json(
        "manuscript_citation_fixes.json",
        {"schema_version": 1, "current_revision": new_revision, "entries": entries},
        subdir="manuscript",
    )
    project.clear_checkpoint("manuscript")
    project.save_checkpoint("manuscript")
    quality = _load_manuscript_quality_payload(project, {})
    quality_delta = _manuscript_quality_delta(before_quality, quality)
    for entry in batch_entries:
        entry["quality_delta"] = quality_delta
    project.save_json(
        "manuscript_citation_fixes.json",
        {"schema_version": 1, "current_revision": new_revision, "entries": entries},
        subdir="manuscript",
    )
    return {
        **{key: value for key, value in patch.items() if key not in {"original_text", "updated_text"}},
        "ok": True,
        "applied": True,
        "project_dir": str(project.base_dir),
        "current_revision": new_revision,
        "manuscript_quality": quality,
        "quality_delta": quality_delta,
    }


def _build_manuscript_citation_patch(project, payload: dict) -> dict:
    draft_path = project.get_path("draft.md", subdir="manuscript")
    if not draft_path.exists():
        raise ValueError("manuscript/draft.md is required")
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace")
    quality = _load_manuscript_quality_payload(project, {})
    if not quality:
        raise ValueError("manuscript quality payload could not be generated")
    issue = _find_manuscript_quality_issue(quality, payload)
    citation = _select_manuscript_patch_citation(issue, payload)
    selected_candidate = _selected_manuscript_patch_candidate(issue, citation)
    target_section = _select_manuscript_patch_target_section(issue, payload, selected_candidate)
    updated_text, before, after = _insert_citation_for_issue(draft_text, issue, citation, target_section=target_section)
    if updated_text == draft_text:
        raise ValueError("citation patch did not change the manuscript")
    display_citation = _inserted_display_citation(before, after, citation)
    diff = "\n".join(
        difflib.unified_diff(
            before.splitlines(),
            after.splitlines(),
            fromfile="before",
            tofile="after",
            lineterm="",
        )
    )
    return {
        "issue": issue,
        "citation": citation,
        "display_citation": display_citation,
        "target_section": target_section,
        "before": before,
        "after": after,
        "diff": diff,
        "original_text": draft_text,
        "updated_text": updated_text,
    }


def _build_manuscript_reference_add_patch(project, payload: dict) -> dict:
    draft_path = project.get_path("draft.md", subdir="manuscript")
    if not draft_path.exists():
        raise ValueError("manuscript/draft.md is required")
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace")
    quality = _load_manuscript_quality_payload(project, {})
    if not quality:
        raise ValueError("manuscript quality payload could not be generated")
    issue = _find_manuscript_quality_issue(quality, payload)
    candidate = _select_reference_add_candidate(issue, payload)
    citation = str(candidate.get("proposed_citation") or "").strip()
    if not re.fullmatch(r"\[\d+\]", citation):
        raise ValueError("reference candidate has no valid proposed citation")
    target_section = _select_manuscript_patch_target_section(issue, payload, candidate)
    cited_text, before, after = _insert_citation_for_issue(draft_text, issue, citation, target_section=target_section)
    updated_text = _append_reference_to_manuscript(cited_text, str(candidate.get("reference_text") or ""))
    if updated_text == draft_text:
        raise ValueError("reference add patch did not change the manuscript")
    display_citation = _inserted_display_citation(before, after, citation)
    diff = "\n".join(
        difflib.unified_diff(
            draft_text.splitlines(),
            updated_text.splitlines(),
            fromfile="before",
            tofile="after",
            lineterm="",
        )
    )
    return {
        "issue": issue,
        "candidate": candidate,
        "citation": citation,
        "display_citation": display_citation,
        "target_section": target_section,
        "reference_text": candidate.get("reference_text") or "",
        "bibtex_entry": candidate.get("bibtex_entry") or "",
        "before": before,
        "after": after,
        "diff": diff,
        "original_text": draft_text,
        "updated_text": updated_text,
    }


def _build_manuscript_reference_add_batch_patch(project, payload: dict) -> dict:
    draft_path = project.get_path("draft.md", subdir="manuscript")
    if not draft_path.exists():
        raise ValueError("manuscript/draft.md is required")
    original_text = draft_path.read_text(encoding="utf-8", errors="replace")
    quality = _load_manuscript_quality_payload(project, {})
    if not quality:
        raise ValueError("manuscript quality payload could not be generated")

    requests = _reference_add_batch_requests(payload, quality)
    if not requests:
        raise ValueError("reference add batch has no candidates")

    current_text = original_text
    existing_reference_count = _manuscript_reference_count(original_text)
    items: list[dict[str, Any]] = []
    bibtex_entries: list[str] = []
    candidate_reference_numbers: dict[str, int] = {}
    added_reference_keys: set[str] = set()
    for request in requests:
        issue = _find_manuscript_quality_issue(quality, request)
        candidate = _select_reference_add_candidate(issue, request)
        candidate_key = str(candidate.get("candidate_id") or candidate.get("title") or candidate.get("reference_text") or "")
        if candidate_key and candidate_key in candidate_reference_numbers:
            reference_number = candidate_reference_numbers[candidate_key]
            append_reference = False
        else:
            reference_number = existing_reference_count + len(added_reference_keys) + 1
            append_reference = True
            if candidate_key:
                candidate_reference_numbers[candidate_key] = reference_number
        candidate = _renumber_reference_add_candidate(candidate, reference_number)
        citation = str(candidate.get("proposed_citation") or "").strip()
        if not re.fullmatch(r"\[\d+\]", citation):
            raise ValueError("reference candidate has no valid proposed citation")
        target_section = _select_manuscript_patch_target_section(issue, request, candidate)
        updated_text, before, after = _insert_citation_for_issue(
            current_text,
            issue,
            citation,
            target_section=target_section,
        )
        display_citation = _inserted_display_citation(before, after, citation)
        reference_text = str(candidate.get("reference_text") or "")
        if append_reference:
            updated_text = _append_reference_to_manuscript(updated_text, reference_text)
            added_reference_keys.add(candidate_key or f"reference_{reference_number}")
        item_diff = "\n".join(
            difflib.unified_diff(
                current_text.splitlines(),
                updated_text.splitlines(),
                fromfile="before",
                tofile="after",
                lineterm="",
            )
        )
        items.append({
            "issue": issue,
            "candidate": candidate,
            "citation": citation,
            "display_citation": display_citation,
            "target_section": target_section,
            "reference_added": append_reference,
            "reference_text": reference_text,
            "bibtex_entry": candidate.get("bibtex_entry") or "",
            "before": before,
            "after": after,
            "diff": item_diff,
        })
        if candidate.get("bibtex_entry"):
            if append_reference:
                bibtex_entries.append(str(candidate.get("bibtex_entry")))
        current_text = updated_text

    if not items or current_text == original_text:
        raise ValueError("reference add batch patch did not change the manuscript")
    diff = "\n".join(
        difflib.unified_diff(
            original_text.splitlines(),
            current_text.splitlines(),
            fromfile="before",
            tofile="after",
            lineterm="",
        )
    )
    return {
        "items": items,
        "added_references": len(added_reference_keys),
        "bibtex_entries": bibtex_entries,
        "diff": diff,
        "original_text": original_text,
        "updated_text": current_text,
    }


def _sync_reference_add_context_citations(project, items: list[dict[str, Any]]) -> None:
    grouped: dict[str, list[dict[str, Any]]] = {"evidence_context.json": [], "methodology_context.json": []}
    for item in items or []:
        if not isinstance(item, dict):
            continue
        candidate = item.get("candidate") if isinstance(item.get("candidate"), dict) else {}
        citation = str(item.get("citation") or candidate.get("proposed_citation") or "").strip()
        if not citation:
            continue
        filename = _reference_add_context_filename(candidate)
        grouped.setdefault(filename, []).append({"candidate": candidate, "citation": citation})

    for filename, rows in grouped.items():
        if not rows:
            continue
        context = project.load_json(filename, subdir="search") or {}
        if not isinstance(context, dict):
            context = {}
        references = context.get("references")
        if not isinstance(references, list):
            references = []
        updated_references = [dict(item) if isinstance(item, dict) else item for item in references]
        changed = False
        for row in rows:
            candidate = row["candidate"]
            citation = row["citation"]
            reference_number = _citation_number(citation)
            match_index = _reference_add_context_match_index(updated_references, candidate)
            if match_index is None:
                updated = _reference_add_context_row(candidate)
                updated_references.append(updated)
                match_index = len(updated_references) - 1
                changed = True
            existing = updated_references[match_index]
            if not isinstance(existing, dict):
                continue
            if existing.get("citation") != citation:
                existing["citation"] = citation
                changed = True
            if reference_number is not None and existing.get("reference_number") != reference_number:
                existing["reference_number"] = reference_number
                changed = True
        if changed:
            context["references"] = updated_references
            project.save_json(filename, context, subdir="search")


def _reference_add_context_filename(candidate: dict[str, Any]) -> str:
    source_type = str(candidate.get("source_type") or "").strip().lower()
    if source_type in REFERENCE_ADD_METHODOLOGY_SOURCE_TYPES:
        return "methodology_context.json"
    return "evidence_context.json"


def _reference_add_context_match_index(references: list[Any], candidate: dict[str, Any]) -> int | None:
    candidate_ids = {
        str(value).strip()
        for value in (
            candidate.get("candidate_id"),
            candidate.get("study_id"),
            (candidate.get("source") or {}).get("study_id") if isinstance(candidate.get("source"), dict) else "",
        )
        if str(value).strip()
    }
    paper = candidate.get("paper") if isinstance(candidate.get("paper"), dict) else {}
    source = candidate.get("source") if isinstance(candidate.get("source"), dict) else {}
    title = _reference_title_token(candidate.get("title") or paper.get("title") or "")
    doi = str(paper.get("doi") or source.get("doi") or "").strip().lower()
    pmid = str(paper.get("pmid") or source.get("pmid") or "").strip()
    for index, item in enumerate(references):
        if not isinstance(item, dict):
            continue
        item_ids = {
            str(value).strip()
            for value in (item.get("candidate_id"), item.get("study_id"))
            if str(value).strip()
        }
        if candidate_ids and item_ids & candidate_ids:
            return index
        item_paper = item.get("paper") if isinstance(item.get("paper"), dict) else {}
        item_doi = str(item.get("doi") or item_paper.get("doi") or "").strip().lower()
        if doi and item_doi and doi == item_doi:
            return index
        item_pmid = str(item.get("pmid") or item_paper.get("pmid") or "").strip()
        if pmid and item_pmid and pmid == item_pmid:
            return index
        item_title = _reference_title_token(item.get("title") or item_paper.get("title") or "")
        if title and item_title == title:
            return index
    return None


def _reference_add_context_row(candidate: dict[str, Any]) -> dict[str, Any]:
    paper = candidate.get("paper") if isinstance(candidate.get("paper"), dict) else {}
    row = {
        "study_id": candidate.get("study_id") or candidate.get("candidate_id") or "",
        "title": candidate.get("title") or paper.get("title") or "",
        "source_type": candidate.get("source_type") or "",
        "paper": paper,
    }
    source = candidate.get("source") if isinstance(candidate.get("source"), dict) else {}
    for key in ("doi", "pmid", "url", "registry_id"):
        value = paper.get(key) or source.get(key)
        if value:
            row[key] = value
    return row


def _reference_add_batch_requests(payload: dict, quality: dict) -> list[dict[str, Any]]:
    raw_items = payload.get("items") or payload.get("candidates") or []
    if isinstance(raw_items, dict):
        raw_items = [raw_items]
    if isinstance(raw_items, list) and raw_items:
        return [item for item in raw_items if isinstance(item, dict)]

    max_count = int(payload.get("max_count") or 3)
    requests: list[dict[str, Any]] = []
    seen_candidates: set[str] = set()
    for issue in quality.get("actionable_issues") or []:
        if not isinstance(issue, dict):
            continue
        for candidate in issue.get("reference_add_candidates") or []:
            if not isinstance(candidate, dict):
                continue
            candidate_id = str(candidate.get("candidate_id") or "")
            if candidate_id and candidate_id in seen_candidates:
                continue
            if candidate_id:
                seen_candidates.add(candidate_id)
            request: dict[str, Any] = {
                "issue_id": issue.get("id"),
                "candidate_id": candidate_id,
            }
            recommended_sections = candidate.get("recommended_sections") or []
            if recommended_sections:
                request["target_section"] = recommended_sections[0]
            requests.append(request)
            if len(requests) >= max_count:
                return requests
    return requests


def _renumber_reference_add_candidate(candidate: dict, reference_number: int) -> dict:
    updated = dict(candidate)
    updated["reference_number"] = reference_number
    updated["proposed_citation"] = f"[{reference_number}]"
    if "display_proposed_citation" in updated:
        updated["display_proposed_citation"] = _display_citation_for_language(
            updated["proposed_citation"],
            "zh" if str(updated.get("display_proposed_citation") or "").startswith("［") else "en",
        )
    paper = updated.get("paper") if isinstance(updated.get("paper"), dict) else {}
    if paper:
        updated["reference_text"] = _format_numbered_reference_from_paper(paper, reference_number)
        updated["bibtex_entry"] = _format_bibtex_entry_from_paper(paper, reference_number)
    else:
        updated["reference_text"] = re.sub(
            r"^\s*(?:\[\d+\]|［\d+］)",
            f"[{reference_number}]",
            str(updated.get("reference_text") or "").strip(),
            count=1,
        )
        updated["bibtex_entry"] = str(updated.get("bibtex_entry") or "")
    return updated


def _find_manuscript_quality_issue(quality: dict, payload: dict) -> dict:
    issue_id = str(payload.get("issue_id") or "").strip()
    section = str(payload.get("section") or "").strip()
    code = str(payload.get("code") or "section_citations_missing").strip()
    issues = quality.get("actionable_issues") or []
    for issue in issues:
        if issue_id and issue.get("id") == issue_id:
            return issue
    if section:
        for issue in issues:
            if issue.get("section") == section and (not code or issue.get("code") == code):
                return issue
    raise ValueError("matching manuscript quality issue was not found")


def _select_reference_add_candidate(issue: dict, payload: dict) -> dict:
    candidate_id = str(payload.get("candidate_id") or "").strip()
    candidates = [item for item in issue.get("reference_add_candidates") or [] if isinstance(item, dict)]
    if not candidates:
        raise ValueError("matching manuscript quality issue has no reference add candidates")
    if candidate_id:
        for candidate in candidates:
            if str(candidate.get("candidate_id") or "") == candidate_id:
                return candidate
        raise ValueError("matching reference add candidate was not found")
    return candidates[0]


def _select_manuscript_patch_citation(issue: dict, payload: dict) -> str:
    citation = _canonical_inline_citation(payload.get("citation"))
    allowed = [
        _canonical_inline_citation(item.get("citation"))
        for item in issue.get("recommended_citations") or []
        if item.get("citation")
    ]
    allowed = [item for item in allowed if item]
    if not citation and allowed:
        citation = allowed[0]
    if not citation:
        raise ValueError("citation must be a numbered inline citation like [2]")
    if allowed and citation not in set(allowed):
        raise ValueError("citation is not one of the recommended citations for this issue")
    return citation


def _selected_manuscript_patch_candidate(issue: dict, citation: str) -> dict:
    canonical = _canonical_inline_citation(citation)
    for item in issue.get("recommended_citations") or []:
        if _canonical_inline_citation(item.get("citation")) == canonical:
            return item if isinstance(item, dict) else {}
    return {}


def _canonical_inline_citation(citation: Any) -> str:
    raw = str(citation or "").strip()
    match = re.fullmatch(r"[\[［]([0-9\s,，、;；\-–—至]+)[\]］]", raw)
    if not match:
        return ""
    token = re.sub(r"\s+", "", match.group(1))
    token = (
        token.replace("，", ",")
        .replace("、", ",")
        .replace("；", ",")
        .replace(";", ",")
        .replace("–", "-")
        .replace("—", "-")
        .replace("至", "-")
    )
    if not re.fullmatch(r"\d+(?:(?:,|-)\d+)*", token):
        return ""
    return f"[{token}]"


def _select_manuscript_patch_target_section(issue: dict, payload: dict, candidate: dict) -> str:
    requested = str(payload.get("target_section") or payload.get("section_target") or "").strip()
    if requested:
        return requested
    issue_section = str(issue.get("section") or "").strip()
    recommended_sections = [str(section or "").strip() for section in candidate.get("recommended_sections") or []]
    if issue_section and issue_section in recommended_sections:
        return issue_section
    for section in recommended_sections:
        if section:
            return section
    return issue_section or "Main text"


def _insert_citation_for_issue(draft_text: str, issue: dict, citation: str, *, target_section: str | None = None) -> tuple[str, str, str]:
    section = str(issue.get("section") or "Main text")
    target = issue.get("target") if isinstance(issue.get("target"), dict) else {}
    heading = str(target_section or target.get("heading") or section)
    section_match = _markdown_section_match_for_quality(draft_text, heading)
    if section_match is None:
        raise ValueError(f"section not found: {heading}")
    body_start, body_end = section_match
    body = draft_text[body_start:body_end]
    display_citation = _display_citation_for_manuscript(draft_text, citation, section_text=body)
    updated_body, before, after = _insert_citation_into_section_body(body, display_citation, issue=issue)
    return draft_text[:body_start] + updated_body + draft_text[body_end:], before, after


def _inserted_display_citation(before: str, after: str, citation: str) -> str:
    canonical = _canonical_inline_citation(citation) or str(citation or "").strip()
    if canonical and canonical in str(after or "") and canonical not in str(before or ""):
        return canonical
    for match in re.finditer(r"［[0-9\s,，、;；\-–—至]+］", str(after or "")):
        if match.group(0) not in str(before or ""):
            return match.group(0)
    return canonical


def _append_reference_to_manuscript(draft_text: str, reference_text: str) -> str:
    reference = str(reference_text or "").strip()
    if not reference:
        raise ValueError("reference candidate has no formatted reference text")
    raw = str(draft_text or "").rstrip()
    reference = _display_reference_for_manuscript(raw, reference)
    match = _reference_heading_match(raw)
    if not match:
        return raw + "\n\n## References\n\n" + reference + "\n"
    remainder = raw[match.end():]
    next_heading = re.search(r"^#{1,6}\s+", remainder, flags=re.M)
    if not next_heading:
        return raw + "\n\n" + reference + "\n"
    insert_at = match.end() + next_heading.start()
    before = raw[:insert_at].rstrip()
    after = raw[insert_at:].lstrip("\n")
    return before + "\n\n" + reference + "\n\n" + after + "\n"


def _insert_citation_into_section_body(body: str, citation: str, *, issue: dict | None = None) -> tuple[str, str, str]:
    targeted = _insert_citation_after_issue_excerpt(body, citation, issue)
    if targeted is not None:
        return targeted
    paragraphs = list(re.finditer(r"(?ms)(^|\n\n)([^\n].*?)(?=\n\n|\Z)", body))
    for match in paragraphs:
        prefix = match.group(1) or ""
        paragraph = match.group(2)
        if not paragraph.strip() or _has_inline_citation_marker(paragraph):
            continue
        updated_paragraph = _append_citation_to_paragraph(paragraph, citation)
        return (
            body[: match.start()] + prefix + updated_paragraph + body[match.end():],
            paragraph,
            updated_paragraph,
        )
    clean_body = body.strip()
    if not clean_body:
        raise ValueError("target section has no paragraph to cite")
    updated = _append_citation_to_paragraph(clean_body, citation)
    return body.replace(clean_body, updated, 1), clean_body, updated


def _insert_citation_after_issue_excerpt(
    body: str,
    citation: str,
    issue: dict | None,
) -> tuple[str, str, str] | None:
    excerpt = _citation_patch_issue_excerpt(issue)
    if not excerpt:
        return None
    start = str(body or "").find(excerpt)
    if start < 0:
        return None
    end = start + len(excerpt)
    updated_excerpt = _append_citation_to_paragraph(excerpt, citation)
    if updated_excerpt == excerpt:
        return None
    return body[:start] + updated_excerpt + body[end:], excerpt, updated_excerpt


def _citation_patch_issue_excerpt(issue: dict | None) -> str:
    if not isinstance(issue, dict):
        return ""
    raw_issue = issue.get("raw_issue") if isinstance(issue.get("raw_issue"), dict) else {}
    for value in (raw_issue.get("evidence_excerpt"), issue.get("evidence_excerpt")):
        excerpt = str(value or "").strip()
        if excerpt and "\n\n" not in excerpt:
            return excerpt
    return ""


def _append_citation_to_paragraph(paragraph: str, citation: str) -> str:
    spacer = "" if str(citation or "").lstrip().startswith("［") else " "
    trailing = re.search(r"([.!?。！？])(\s*)$", paragraph)
    if trailing:
        return paragraph[: trailing.start()].rstrip() + f"{spacer}{citation}" + trailing.group(1) + trailing.group(2)
    return paragraph.rstrip() + f"{spacer}{citation}"


def _has_inline_citation_marker(text: str) -> bool:
    return bool(re.search(r"[\[［]\d+(?:\s*(?:,|，|、|;|；|[-–—]|至)\s*\d+)*[\]］]", str(text or "")))


def _display_citation_for_manuscript(draft_text: str, citation: str, *, section_text: str = "") -> str:
    raw_citation = str(citation or "").strip()
    if not raw_citation:
        return raw_citation
    source_text = str(section_text or "") or str(draft_text or "")
    if not _prefers_full_width_citations(source_text) and not _prefers_full_width_citations(_references_section_body(draft_text)):
        return raw_citation
    match = re.fullmatch(r"\[(\d+(?:\s*(?:,|[-–—])\s*\d+)*)\]", raw_citation)
    if not match:
        return raw_citation
    token = re.sub(r"\s+", "", match.group(1)).replace(",", "，").replace("–", "-").replace("—", "-")
    return f"［{token}］"


def _display_reference_for_manuscript(draft_text: str, reference_text: str) -> str:
    reference = str(reference_text or "").strip()
    if not _prefers_full_width_citations(_references_section_body(draft_text)):
        return reference
    return re.sub(r"^\[(\d+)\]", r"［\1］", reference, count=1)


def _prefers_full_width_citations(text: str) -> bool:
    raw = str(text or "")
    full_width = len(re.findall(r"［\d+", raw))
    half_width = len(re.findall(r"\[\d+", raw))
    return full_width > 0 and full_width >= half_width


def _markdown_section_match_for_quality(draft_text: str, section: str) -> tuple[int, int] | None:
    raw = str(draft_text or "")
    heading = str(section or "").strip()
    if heading.lower() in {"main text", "manuscript"}:
        match = _reference_heading_match(raw)
        return (0, match.start() if match else len(raw))
    aliases = {
        "Introduction": ["Introduction", "引言"],
        "Methods": ["Methods", "方法"],
        "Results": ["Results", "结果"],
        "Discussion": ["Discussion", "讨论"],
        "Conclusion": ["Conclusion", "结论"],
    }.get(heading, [heading])
    for alias in aliases:
        match = re.search(rf"^##\s+{re.escape(alias)}\s*$", raw, flags=re.I | re.M)
        if not match:
            continue
        start = match.end()
        next_heading = re.search(r"^##\s+", raw[start:], flags=re.M)
        end = start + next_heading.start() if next_heading else len(raw)
        return (start, end)
    return None


def _main_text_before_reference_section(draft_text: str) -> str:
    raw = str(draft_text or "")
    match = _reference_heading_match(raw)
    return raw[: match.start()] if match else raw


def _reference_heading_match(draft_text: str) -> re.Match[str] | None:
    reference_heading = (
        r"(?:"
        r"References?|Bibliography|Literature\s+Cited|Works\s+Cited|"
        r"参考文献|参考资料|引用文献|文献"
        r")"
    )
    return re.search(rf"^#{{1,6}}\s+{reference_heading}\s*[:：]?\s*$", str(draft_text or ""), flags=re.I | re.M)


def _load_manuscript_citation_fix_log(project) -> dict:
    data = project.load_json("manuscript_citation_fixes.json", subdir="manuscript") or {}
    if not isinstance(data, dict):
        data = {}
    return {
        "schema_version": 1,
        "current_revision": int(data.get("current_revision") or 0),
        "entries": data.get("entries") if isinstance(data.get("entries"), list) else [],
    }
