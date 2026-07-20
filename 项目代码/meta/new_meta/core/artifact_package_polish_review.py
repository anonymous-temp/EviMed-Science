"""Manuscript polish audit review helpers."""
from __future__ import annotations

import difflib
from html import escape
import json
import re
from typing import Any

from new_meta.core.artifact_package_language import (
    html_lang as _html_lang,
    is_zh_review_language as _is_zh_review_language,
    normalize_review_language as _normalize_review_language,
)
from new_meta.core.manuscript_polish import audit_manuscript_style
from new_meta.core.project import Project
from new_meta.core.report_style import (
    data_table as _data_table,
    page_header as _page_header,
    panel as _panel,
    render_page as _render_page,
    stat_chip as _stat_chip,
)

_POLISH_EXTRA_CSS = """    main { max-width: 1100px; }
    code { white-space: pre-wrap; }"""


def build_manuscript_polish_audit_review(project: Project) -> dict | None:
    audit = project.load_json("manuscript_polish_audit.json", subdir="manuscript")
    if not isinstance(audit, dict) or not audit:
        return None
    before_signal = ((audit.get("before") or {}).get("ai_style_signal") or {}) if isinstance(audit.get("before"), dict) else {}
    stored_after_signal = ((audit.get("after") or {}).get("ai_style_signal") or {}) if isinstance(audit.get("after"), dict) else {}
    before_score = int(before_signal.get("score") or 0)
    stored_after_score = int(stored_after_signal.get("score") or 0)
    issues = [item for item in (audit.get("issues") or []) if isinstance(item, dict)]
    fact_guard_issues = _manuscript_polish_fact_guard_issues(issues)
    accepted_edits = [item for item in (audit.get("accepted_edits") or []) if isinstance(item, dict)]
    skipped_chunk_details = [item for item in (audit.get("skipped_chunk_details") or []) if isinstance(item, dict)]
    language = str(audit.get("language") or "").strip().lower()
    draft_text = project.load_text("draft.md", subdir="manuscript") or ""
    review_language = _polish_review_language(language, draft_text)
    current_draft_signal = _current_draft_ai_style_signal(draft_text)
    review_after_signal = current_draft_signal or stored_after_signal
    after_score = int(review_after_signal.get("score") or 0)
    current_draft_score = int(current_draft_signal.get("score") or after_score)
    polish_audit_stale = bool(current_draft_signal) and _ai_style_signal_signature(
        current_draft_signal
    ) != _ai_style_signal_signature(stored_after_signal)
    rejected_edits = _manuscript_polish_rejected_edits(issues, language=review_language)
    remaining_style_issues = _enrich_manuscript_polish_style_issues(
        [item for item in (review_after_signal.get("issues") or []) if isinstance(item, dict)],
        draft_text=draft_text,
        language=review_language,
    )
    resolved_style_issues = _manuscript_polish_resolved_style_issues(
        before_signal,
        review_after_signal,
        language=review_language,
    )
    proofreading = audit.get("proofreading") if isinstance(audit.get("proofreading"), dict) else {}
    proofreading_issues = [item for item in (proofreading.get("issues") or []) if isinstance(item, dict)]
    proofreading_status = str(proofreading.get("status") or ("disabled" if not proofreading.get("enabled") else "")).strip()
    proofreading_failed = proofreading_status == "failed"
    proofreading_error = str(proofreading.get("error") or "").strip()
    style_policy = audit.get("style_policy") if isinstance(audit.get("style_policy"), dict) else {}
    summary = {
        "enabled": bool(audit.get("enabled")),
        "language": language,
        "rewrite_scope": audit.get("rewrite_scope") or "",
        "accepted_chunks": int(audit.get("accepted_chunks") or 0),
        "rejected_chunks": int(audit.get("rejected_chunks") or 0),
        "unchanged_chunks": int(audit.get("unchanged_chunks") or 0),
        "attempted_chunks": int(audit.get("attempted_chunks") or 0),
        "skipped_chunks": int(audit.get("skipped_chunks") or 0),
        "skipped_chunk_detail_count": len(skipped_chunk_details),
        "total_rewrite_chunks": int(audit.get("total_rewrite_chunks") or 0),
        "targeted_chunks": int(audit.get("targeted_chunks") or 0),
        "non_target_chunks": int(audit.get("non_target_chunks") or 0),
        "rewrite_retries": int(audit.get("rewrite_retries") or 0),
        "retry_recovered_chunks": int(audit.get("retry_recovered_chunks") or 0),
        "polish_budget_exhausted": bool(audit.get("polish_budget_exhausted")),
        "accepted_sections": int(audit.get("accepted_sections") or 0),
        "rejected_sections": int(audit.get("rejected_sections") or 0),
        "accepted_edit_count": int(
            audit.get("accepted_edit_count") if audit.get("accepted_edit_count") is not None else len(accepted_edits)
        ),
        "rejected_edit_count": len(rejected_edits),
        "fact_guard_issues": len(fact_guard_issues),
        "before_ai_style_score": before_score,
        "after_ai_style_score": after_score,
        "stored_after_ai_style_score": stored_after_score,
        "current_draft_ai_style_score": current_draft_score,
        "ai_style_delta": after_score - before_score,
        "stored_ai_style_delta": stored_after_score - before_score,
        "polish_audit_stale": polish_audit_stale,
        "resolved_ai_style_issues": len(resolved_style_issues),
        "remaining_ai_style_issues": len(remaining_style_issues),
        "proofreading_enabled": bool(proofreading.get("enabled")),
        "proofreading_provider": proofreading.get("provider") or "none",
        "proofreading_status": proofreading_status,
        "proofreading_failed": proofreading_failed,
        "proofreading_error": proofreading_error,
        "proofreading_issues": int(
            proofreading.get("issue_count")
            if proofreading.get("issue_count") is not None else len(proofreading_issues)
        ),
        "detector_evasion": bool(style_policy.get("detector_evasion")),
    }
    passed = (
        len(remaining_style_issues) == 0
        and int(summary.get("proofreading_issues") or 0) == 0
        and not proofreading_failed
        and not bool(style_policy.get("detector_evasion"))
    )
    return {
        "schema_version": 1,
        "language": language,
        "review_language": review_language,
        "passed": passed,
        "summary": summary,
        "review_queue": _manuscript_polish_review_queue(
            summary,
            accepted_edits=accepted_edits,
            rejected_edits=rejected_edits,
            remaining_style_issues=remaining_style_issues,
            proofreading_issues=proofreading_issues,
            language=review_language,
        ),
        "style_policy": style_policy,
        "proofreading": {
            **proofreading,
            "issues": proofreading_issues[:50],
            "issue_count": int(
                proofreading.get("issue_count")
                if proofreading.get("issue_count") is not None else len(proofreading_issues)
            ),
        } if proofreading else {},
        "before_ai_style_signal": before_signal or {},
        "after_ai_style_signal": review_after_signal or {},
        "stored_after_ai_style_signal": stored_after_signal or {},
        "current_draft_ai_style_signal": current_draft_signal or {},
        "polish_audit_stale": polish_audit_stale,
        "accepted_edits": accepted_edits[:50],
        "skipped_chunk_details": skipped_chunk_details[:50],
        "rejected_edits": rejected_edits[:50],
        "issues": issues,
        "resolved_style_issues": resolved_style_issues,
        "remaining_style_issues": remaining_style_issues,
    }


def _current_draft_ai_style_signal(draft_text: str) -> dict[str, Any]:
    if not str(draft_text or "").strip():
        return {}
    signal = audit_manuscript_style(draft_text).get("ai_style_signal")
    return dict(signal) if isinstance(signal, dict) else {}


def _ai_style_signal_signature(signal: dict[str, Any]) -> tuple[int, tuple[tuple[Any, ...], ...]]:
    if not isinstance(signal, dict):
        return (0, ())
    issue_signatures: list[tuple[Any, ...]] = []
    for issue in signal.get("issues") or []:
        if not isinstance(issue, dict):
            continue
        issue_signatures.append((
            str(issue.get("code") or ""),
            issue.get("weight"),
            issue.get("value"),
            issue.get("count"),
            tuple(sorted(str(item) for item in (issue.get("terms") or []))) if isinstance(issue.get("terms"), list) else "",
            tuple(sorted((str(key), value) for key, value in (issue.get("openings") or {}).items()))
            if isinstance(issue.get("openings"), dict)
            else "",
        ))
    return (int(signal.get("score") or 0), tuple(issue_signatures))


def _manuscript_polish_resolved_style_issues(
    before_signal: dict[str, Any],
    after_signal: dict[str, Any],
    *,
    language: str,
) -> list[dict[str, Any]]:
    before_issues = [item for item in (before_signal or {}).get("issues") or [] if isinstance(item, dict)]
    after_codes = {
        str(item.get("code") or "").strip()
        for item in (after_signal or {}).get("issues") or []
        if isinstance(item, dict) and str(item.get("code") or "").strip()
    }
    resolved: list[dict[str, Any]] = []
    seen: set[str] = set()
    for issue in before_issues:
        code = str(issue.get("code") or "").strip()
        if not code or code in seen or code in after_codes:
            continue
        seen.add(code)
        item = dict(issue)
        item["code"] = code
        item["status"] = "resolved_after_polish"
        item["message"] = _polish_resolved_style_issue_message(code, language)
        item["suggested_action"] = _polish_resolved_style_issue_action(language)
        resolved.append(item)
    return resolved


def _manuscript_polish_rejected_edits(issues: list[dict[str, Any]], *, language: str = "en") -> list[dict[str, Any]]:
    rejected: list[dict[str, Any]] = []
    for index, issue in enumerate(_manuscript_polish_fact_guard_issues(issues)):
        if not isinstance(issue, dict):
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
            "message": _localized_polish_issue_message(issue, language),
            "original_text": original_text,
            "candidate_text": candidate_text,
            "diff": str(issue.get("diff") or _manuscript_polish_edit_diff(original_text, candidate_text)),
            "review_action": str(issue.get("review_action") or "manual_review_required"),
            "can_auto_apply": False,
            "manual_accept_allowed": True,
            "manual_accept_condition": _manuscript_polish_manual_accept_condition(language),
            "blocking_reason": _localized_polish_issue_message(issue, language),
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


def _manuscript_polish_edit_diff(original_text: str, candidate_text: str) -> str:
    return "\n".join(
        difflib.unified_diff(
            str(original_text or "").splitlines(),
            str(candidate_text or "").splitlines(),
            fromfile="original",
            tofile="candidate",
            lineterm="",
        )
    )


def _manuscript_polish_manual_accept_condition(language: str) -> str:
    if _is_zh_review_language(language):
        return "仅在人工确认数字、引用、受保护术语和结论方向均未改变后，才可局部接受。"
    return (
        "May be manually accepted only after a human confirms that numbers, citations, "
        "protected terms, and conclusion direction are unchanged."
    )


def _manuscript_polish_review_queue(
    summary: dict[str, Any],
    *,
    accepted_edits: list[dict[str, Any]],
    rejected_edits: list[dict[str, Any]],
    remaining_style_issues: list[dict[str, Any]],
    proofreading_issues: list[dict[str, Any]],
    language: str = "en",
) -> dict[str, Any]:
    zh = _is_zh_review_language(language)
    rejected_count = max(len(rejected_edits), int(summary.get("fact_guard_issues") or 0))
    style_count = len(remaining_style_issues)
    proofreading_count = int(summary.get("proofreading_issues") or len(proofreading_issues))
    proofreading_failed = bool(summary.get("proofreading_failed"))
    proofreading_error = str(summary.get("proofreading_error") or "")
    budget_exhausted = bool(summary.get("polish_budget_exhausted"))
    skipped_chunks = int(summary.get("skipped_chunks") or 0)
    rewrite_retries = int(summary.get("rewrite_retries") or 0)
    retry_recovered_chunks = int(summary.get("retry_recovered_chunks") or 0)
    if not bool(summary.get("enabled")):
        return {
            "status": "no_polish_review_needed",
            "accepted_auto_edits": int(summary.get("accepted_edit_count") or len(accepted_edits)),
            "rejected_candidates": rejected_count,
            "remaining_style_issues": style_count,
            "proofreading_issues": proofreading_count,
            "proofreading_failed": proofreading_failed,
            "proofreading_error": proofreading_error,
            "manual_review_items": 0,
            "budget_exhausted": False,
            "skipped_chunks": 0,
            "rewrite_retries": rewrite_retries,
            "retry_recovered_chunks": retry_recovered_chunks,
            "can_auto_apply_rejected_edits": False,
            "next_actions": [],
        }
    unresolved_final_issues = style_count > 0 or proofreading_count > 0 or proofreading_failed
    budget_or_skipped = budget_exhausted or skipped_chunks > 0
    manual_items = style_count + proofreading_count
    if unresolved_final_issues or budget_or_skipped:
        manual_items += rejected_count
    if proofreading_failed:
        manual_items += 1
    if manual_items == 0 and (budget_exhausted or skipped_chunks):
        manual_items = 1
    if unresolved_final_issues:
        status = "human_review_required"
    elif budget_or_skipped:
        status = "budget_review_required"
    elif rejected_count:
        status = "polish_guard_discarded_candidates_no_review_required"
    elif accepted_edits:
        status = "polish_applied_no_review_required"
    else:
        status = "no_polish_review_needed"

    next_actions: list[str] = []
    if rejected_count and (unresolved_final_issues or budget_or_skipped):
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
        next_actions.append(_manuscript_polish_proofreading_failed_next_action(language))
    if budget_exhausted or skipped_chunks:
        next_actions.append(
            "润色片段预算已触发；如需更深润色，请提高片段预算后重跑，并重新检查事实保护闸。"
            if zh else
            "Review unchanged chunks caused by the polish chunk budget; rerun with a higher chunk budget only if deeper polish is needed, then re-check fact guards."
        )
    if not next_actions and status != "polish_guard_discarded_candidates_no_review_required":
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


def _manuscript_polish_proofreading_failed_next_action(language: str) -> str:
    if _is_zh_review_language(language):
        return "检查审校服务配置或稍后重跑；如跳过外部审校，请保留人工通读记录。"
    return "Check the proofreader service configuration or rerun proofreading; if skipped, record a human proofreading pass."


def _manuscript_polish_fact_guard_issues(issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [item for item in issues if item.get("code") != "polish_budget_exhausted"]


def _polish_review_language(language: str, draft_text: str) -> str:
    normalized = _normalize_review_language(language)
    if normalized:
        return normalized
    if str(language or "").strip().lower() == "mixed" and re.search(r"[\u4e00-\u9fff]", str(draft_text or "")):
        return "zh"
    return str(language or "").strip().lower() or "en"


def _enrich_manuscript_polish_style_issues(
    issues: list[dict[str, Any]],
    *,
    draft_text: str,
    language: str,
) -> list[dict[str, Any]]:
    enriched: list[dict[str, Any]] = []
    for issue in issues:
        item = dict(issue)
        code = str(item.get("code") or "").strip()
        if code in _POLISH_STYLE_KNOWN_ISSUES or not item.get("message"):
            item["message"] = _polish_style_issue_message(code, language)
        if code in _POLISH_STYLE_KNOWN_ISSUES or not item.get("suggested_action"):
            item["suggested_action"] = _polish_style_issue_action(code, language)
        excerpt = _polish_style_issue_excerpt(item, draft_text)
        if excerpt:
            item.setdefault("evidence_excerpt", excerpt)
        enriched.append(item)
    return enriched


_POLISH_STYLE_KNOWN_ISSUES = {
    "template_phrase_hits",
    "repeated_sentence_starts",
    "low_sentence_length_variation",
    "low_lexical_diversity",
}


def _polish_style_issue_message(code: str, language: str) -> str:
    zh = _is_zh_review_language(language)
    messages = {
        "template_phrase_hits": (
            "检测到模板化过渡短语，可能让稿件显得机械。"
            if zh else
            "Template-like transition phrases remain after polish."
        ),
        "repeated_sentence_starts": (
            "多个句子使用相同开头，段落节奏偏重复。"
            if zh else
            "Several sentences still start the same way, making the passage sound repetitive."
        ),
        "low_sentence_length_variation": (
            "句长变化过低，段落节奏可能显得过于均匀。"
            if zh else
            "Sentence lengths are too uniform, which can make the passage sound mechanical."
        ),
        "low_lexical_diversity": (
            "词汇变化偏低，建议人工检查是否重复使用相同表达。"
            if zh else
            "Lexical diversity is low; repeated wording may need human review."
        ),
    }
    return messages.get(code, "仍有风格信号需要人工复核。" if zh else "A remaining style signal needs human review.")


def _polish_resolved_style_issue_message(code: str, language: str) -> str:
    zh = _is_zh_review_language(language)
    messages = {
        "template_phrase_hits": "模板化过渡短语已在润色后消失。" if zh else "Template-like transition phrases were resolved after polish.",
        "repeated_sentence_starts": "重复句首问题已在润色后消失。" if zh else "Repeated sentence openings were resolved after polish.",
        "low_sentence_length_variation": "句长变化问题已在润色后消失。" if zh else "Low sentence-length variation was resolved after polish.",
        "low_lexical_diversity": "词汇变化问题已在润色后消失。" if zh else "Low lexical diversity was resolved after polish.",
    }
    return messages.get(code, "该风格信号已在润色后消失。" if zh else "This style signal was resolved after polish.")


def _polish_resolved_style_issue_action(language: str) -> str:
    if _is_zh_review_language(language):
        return "保留已接受润色；如后续事实保护复核失败，再回退相关修改。"
    return "Keep the accepted polish unless a later fact-preservation review fails."


def _polish_style_issue_action(code: str, language: str) -> str:
    zh = _is_zh_review_language(language)
    if code == "template_phrase_hits":
        return (
            "人工删改模板短语，保留数字、引用、研究名称和结论方向不变。"
            if zh else
            "Manually remove formulaic phrases while preserving numbers, citations, study names, and conclusion direction."
        )
    if code == "repeated_sentence_starts":
        return (
            "人工改写相邻句子的开头和连接方式；不要重写事实句中的数值或引用。"
            if zh else
            "Manually vary adjacent sentence openings and transitions without changing factual sentences, numbers, or citations."
        )
    if code == "low_sentence_length_variation":
        return (
            "人工拆分或合并少量相邻句，增加句长节奏变化；不要为了风格改写效应量句。"
            if zh else
            "Manually split or combine a few adjacent sentences to vary rhythm; do not rewrite effect-estimate sentences just for style."
        )
    if code == "low_lexical_diversity":
        return (
            "人工替换重复的非技术性表达；保留术语、结局名称和方法学标签。"
            if zh else
            "Manually vary repeated non-technical wording while preserving terms, outcome names, and methods labels."
        )
    return (
        "人工复核该风格信号；事实保护优先于继续自动改写。"
        if zh else
        "Review this style signal manually; fact preservation takes priority over further automatic rewriting."
    )


def _polish_style_issue_excerpt(issue: dict[str, Any], draft_text: str) -> str:
    text = str(draft_text or "")
    if not text.strip():
        return ""
    phrases = issue.get("phrases") if isinstance(issue.get("phrases"), list) else []
    openings = issue.get("openings") if isinstance(issue.get("openings"), dict) else {}
    needles = [str(item) for item in phrases if str(item).strip()]
    needles.extend(str(item) for item in openings.keys() if str(item).strip())
    for needle in needles:
        match = re.search(re.escape(needle), text, flags=re.IGNORECASE)
        if match:
            return _excerpt_around_match(text, match.start(), match.end())
    return _first_substantive_manuscript_excerpt(text)


def _excerpt_around_match(text: str, start: int, end: int, *, radius: int = 180) -> str:
    begin = max(0, start - radius)
    finish = min(len(text), end + radius)
    excerpt = re.sub(r"\s+", " ", text[begin:finish]).strip()
    if begin > 0:
        excerpt = "..." + excerpt
    if finish < len(text):
        excerpt = excerpt + "..."
    return excerpt


def _first_substantive_manuscript_excerpt(text: str) -> str:
    without_refs = re.split(r"^##\s+(?:References|参考文献)\b", str(text or ""), maxsplit=1, flags=re.M)[0]
    paragraphs = [
        re.sub(r"\s+", " ", paragraph).strip()
        for paragraph in re.split(r"\n\s*\n", without_refs)
        if paragraph.strip() and not paragraph.lstrip().startswith("#") and not paragraph.lstrip().startswith("!")
    ]
    for paragraph in paragraphs:
        if re.search(r"\bpooled\b|\bmeta-analysis\b|合并|Meta分析", paragraph, flags=re.I):
            return _truncate_review_cell(paragraph, max_chars=360)
    return _truncate_review_cell(paragraphs[0], max_chars=360) if paragraphs else ""


def manuscript_polish_manifest_summary(project: Project, generated_entries: list[tuple[str, Any]] | None = None) -> dict[str, Any]:
    generated_entries = generated_entries or []
    audit = project.load_json("manuscript_polish_audit.json", subdir="manuscript")
    if not isinstance(audit, dict) or not audit:
        return {
            "manuscript_polish_included": False,
            "manuscript_polish_enabled": False,
            "manuscript_polish_language": "",
            "manuscript_polish_rewrite_scope": "",
            "manuscript_polish_accepted_chunks": 0,
            "manuscript_polish_rejected_chunks": 0,
            "manuscript_polish_attempted_chunks": 0,
            "manuscript_polish_skipped_chunks": 0,
            "manuscript_polish_skipped_chunk_detail_count": 0,
            "manuscript_polish_total_rewrite_chunks": 0,
            "manuscript_polish_targeted_chunks": 0,
            "manuscript_polish_non_target_chunks": 0,
            "manuscript_polish_rewrite_retries": 0,
            "manuscript_polish_retry_recovered_chunks": 0,
            "manuscript_polish_budget_exhausted": False,
            "manuscript_polish_accepted_sections": 0,
            "manuscript_polish_rejected_sections": 0,
            "manuscript_polish_accepted_edit_count": 0,
            "manuscript_polish_review_queue_status": "",
            "manuscript_polish_manual_review_items": 0,
            "manuscript_polish_rejected_candidates": 0,
            "manuscript_polish_next_actions": [],
            "manuscript_polish_fact_guard_issues": 0,
            "manuscript_polish_before_ai_style_score": 0,
            "manuscript_polish_after_ai_style_score": 0,
            "manuscript_polish_stored_after_ai_style_score": 0,
            "manuscript_polish_current_draft_ai_style_score": 0,
            "manuscript_polish_ai_style_delta": 0,
            "manuscript_polish_stored_ai_style_delta": 0,
            "manuscript_polish_audit_stale": False,
            "manuscript_polish_resolved_ai_style_issues": 0,
            "manuscript_polish_remaining_ai_style_issues": 0,
            "manuscript_polish_proofreading_issues": 0,
            "manuscript_polish_proofreading_failed": False,
            "manuscript_polish_proofreading_error": "",
            "manuscript_polish_detector_evasion": False,
            "manuscript_polish_html_review": False,
        }
    before_signal = ((audit.get("before") or {}).get("ai_style_signal") or {}) if isinstance(audit.get("before"), dict) else {}
    after_signal = ((audit.get("after") or {}).get("ai_style_signal") or {}) if isinstance(audit.get("after"), dict) else {}
    before_score = int(before_signal.get("score") or 0)
    after_score = int(after_signal.get("score") or 0)
    issues = [item for item in (audit.get("issues") or []) if isinstance(item, dict)]
    fact_guard_issues = _manuscript_polish_fact_guard_issues(issues)
    proofreading = audit.get("proofreading") if isinstance(audit.get("proofreading"), dict) else {}
    style_policy = audit.get("style_policy") if isinstance(audit.get("style_policy"), dict) else {}
    review = build_manuscript_polish_audit_review(project) or {}
    review_summary = review.get("summary") if isinstance(review.get("summary"), dict) else {}
    review_queue = review.get("review_queue") if isinstance(review.get("review_queue"), dict) else {}
    return {
        "manuscript_polish_included": True,
        "manuscript_polish_enabled": bool(audit.get("enabled")),
        "manuscript_polish_language": audit.get("language") or "",
        "manuscript_polish_rewrite_scope": audit.get("rewrite_scope") or "",
        "manuscript_polish_accepted_chunks": int(audit.get("accepted_chunks") or 0),
        "manuscript_polish_rejected_chunks": int(audit.get("rejected_chunks") or 0),
        "manuscript_polish_attempted_chunks": int(audit.get("attempted_chunks") or 0),
        "manuscript_polish_skipped_chunks": int(audit.get("skipped_chunks") or 0),
        "manuscript_polish_skipped_chunk_detail_count": int(
            review_summary.get("skipped_chunk_detail_count", len(audit.get("skipped_chunk_details") or [])) or 0
        ),
        "manuscript_polish_total_rewrite_chunks": int(audit.get("total_rewrite_chunks") or 0),
        "manuscript_polish_targeted_chunks": int(audit.get("targeted_chunks") or 0),
        "manuscript_polish_non_target_chunks": int(audit.get("non_target_chunks") or 0),
        "manuscript_polish_rewrite_retries": int(audit.get("rewrite_retries") or 0),
        "manuscript_polish_retry_recovered_chunks": int(audit.get("retry_recovered_chunks") or 0),
        "manuscript_polish_budget_exhausted": bool(audit.get("polish_budget_exhausted")),
        "manuscript_polish_accepted_sections": int(audit.get("accepted_sections") or 0),
        "manuscript_polish_rejected_sections": int(audit.get("rejected_sections") or 0),
        "manuscript_polish_accepted_edit_count": int(
            audit.get("accepted_edit_count") if audit.get("accepted_edit_count") is not None else len(audit.get("accepted_edits") or [])
        ),
        "manuscript_polish_review_queue_status": review_queue.get("status") or "",
        "manuscript_polish_manual_review_items": int(review_queue.get("manual_review_items") or 0),
        "manuscript_polish_rejected_candidates": int(review_queue.get("rejected_candidates") or 0),
        "manuscript_polish_next_actions": [
            str(action)
            for action in (review_queue.get("next_actions") or [])
            if str(action).strip()
        ],
        "manuscript_polish_fact_guard_issues": len(fact_guard_issues),
        "manuscript_polish_before_ai_style_score": before_score,
        "manuscript_polish_after_ai_style_score": int(review_summary.get("after_ai_style_score", after_score) or 0),
        "manuscript_polish_stored_after_ai_style_score": int(
            review_summary.get("stored_after_ai_style_score", after_score) or 0
        ),
        "manuscript_polish_current_draft_ai_style_score": int(
            review_summary.get("current_draft_ai_style_score", review_summary.get("after_ai_style_score", after_score)) or 0
        ),
        "manuscript_polish_ai_style_delta": int(review_summary.get("ai_style_delta", after_score - before_score) or 0),
        "manuscript_polish_stored_ai_style_delta": int(
            review_summary.get("stored_ai_style_delta", after_score - before_score) or 0
        ),
        "manuscript_polish_audit_stale": bool(review_summary.get("polish_audit_stale")),
        "manuscript_polish_resolved_ai_style_issues": int(review_summary.get("resolved_ai_style_issues") or 0),
        "manuscript_polish_remaining_ai_style_issues": int(
            review_summary.get(
                "remaining_ai_style_issues",
                len(after_signal.get("issues") or []) if isinstance(after_signal, dict) else 0,
            ) or 0
        ),
        "manuscript_polish_proofreading_issues": int(
            proofreading.get("issue_count") if proofreading.get("issue_count") is not None else 0
        ),
        "manuscript_polish_proofreading_failed": bool(review_summary.get("proofreading_failed")),
        "manuscript_polish_proofreading_error": str(review_summary.get("proofreading_error") or ""),
        "manuscript_polish_detector_evasion": bool(style_policy.get("detector_evasion")),
        "manuscript_polish_html_review": any(arcname == "review/manuscript_polish_audit.html" for arcname, _ in generated_entries),
    }


def render_manuscript_polish_audit_html(audit: dict) -> str:
    summary = audit.get("summary") or {}
    language = str(audit.get("review_language") or audit.get("language") or summary.get("language") or "").strip().lower()
    zh = _is_zh_review_language(language)
    display_language = _localized_polish_language_label(language, language)
    issues = audit.get("issues") or []
    accepted_edits = [item for item in (audit.get("accepted_edits") or []) if isinstance(item, dict)]
    rejected_edits = [item for item in (audit.get("rejected_edits") or []) if isinstance(item, dict)]
    skipped_chunk_details = [item for item in (audit.get("skipped_chunk_details") or []) if isinstance(item, dict)]
    review_queue = audit.get("review_queue") if isinstance(audit.get("review_queue"), dict) else {}
    resolved_style_issues = audit.get("resolved_style_issues") or []
    remaining_style_issues = audit.get("remaining_style_issues") or []
    style_policy = audit.get("style_policy") if isinstance(audit.get("style_policy"), dict) else {}
    proofreading = audit.get("proofreading") if isinstance(audit.get("proofreading"), dict) else {}
    proofreading_issues = [item for item in (proofreading.get("issues") or []) if isinstance(item, dict)]
    proofreading_failed = bool(summary.get("proofreading_failed") or review_queue.get("proofreading_failed"))
    proofreading_error = str(summary.get("proofreading_error") or review_queue.get("proofreading_error") or proofreading.get("error") or "")
    issue_rows = "\n".join(_render_manuscript_polish_issue_row(issue, language=language) for issue in issues)
    if not issue_rows:
        issue_rows = (
            '<tr><td colspan="4">未记录事实保护闸问题。</td></tr>'
            if zh else
            '<tr><td colspan="4">No fact-preservation guard issues were recorded.</td></tr>'
        )
    accepted_edit_rows = "\n".join(
        _render_manuscript_polish_accepted_edit_row(edit, language=language)
        for edit in accepted_edits
    )
    if not accepted_edit_rows:
        accepted_edit_rows = (
            '<tr><td colspan="5">未记录已接受的自动润色修改。</td></tr>'
            if zh else
            '<tr><td colspan="5">No accepted automatic polish edits were recorded.</td></tr>'
        )
    rejected_edit_rows = "\n".join(
        _render_manuscript_polish_rejected_edit_row(edit, language=language)
        for edit in rejected_edits
    )
    if not rejected_edit_rows:
        rejected_edit_rows = (
            '<tr><td colspan="7">未记录被事实保护闸拒绝的润色候选。</td></tr>'
            if zh else
            '<tr><td colspan="7">No rejected polish candidates were recorded.</td></tr>'
        )
    skipped_chunk_rows = "\n".join(
        _render_manuscript_polish_skipped_chunk_row(item, language=language)
        for item in skipped_chunk_details
    )
    if not skipped_chunk_rows:
        skipped_chunk_rows = (
            '<tr><td colspan="6">未记录因预算跳过的润色片段。</td></tr>'
            if zh else
            '<tr><td colspan="6">No polish chunks were skipped because of the rewrite budget.</td></tr>'
        )
    resolved_style_rows = "\n".join(
        _render_manuscript_polish_style_issue_row(issue, language=language)
        for issue in resolved_style_issues
        if isinstance(issue, dict)
    )
    if not resolved_style_rows:
        resolved_style_rows = (
            '<tr><td colspan="3">未记录已解决的 AI 风格信号。</td></tr>'
            if zh else
            '<tr><td colspan="3">No resolved AI-like style signals were recorded.</td></tr>'
        )
    style_rows = "\n".join(_render_manuscript_polish_style_issue_row(issue, language=language) for issue in remaining_style_issues)
    if not style_rows:
        style_rows = (
            '<tr><td colspan="3">润色后未记录剩余 AI 风格信号。</td></tr>'
            if zh else
            '<tr><td colspan="3">No remaining AI-like style signals were recorded after polish.</td></tr>'
        )
    proofreading_rows = "\n".join(_render_manuscript_polish_proofreading_row(issue) for issue in proofreading_issues)
    if not proofreading_rows:
        if proofreading_failed:
            proofreading_rows = (
                f'<tr><td colspan="4" class="fail">审校器失败：{escape(proofreading_error or "unknown error")}</td></tr>'
                if zh else
                f'<tr><td colspan="4" class="fail">Proofreader failed: {escape(proofreading_error or "unknown error")}</td></tr>'
            )
        else:
            proofreading_rows = (
                '<tr><td colspan="4">未记录外部审校问题。</td></tr>'
                if zh else
                '<tr><td colspan="4">No external proofreading issues were recorded.</td></tr>'
            )
    proofreading_provider = str(proofreading.get("provider") or summary.get("proofreading_provider") or "none")
    proofreading_provider_label = _localized_polish_provider_label(proofreading_provider, language)
    queue_action_items = [str(item) for item in (review_queue.get("next_actions") or []) if str(item).strip()]
    queue_actions = "".join(f"<li>{escape(item)}</li>" for item in queue_action_items)
    if not queue_actions:
        queue_actions = "<li>暂无润色复核动作。</li>" if zh else "<li>No polish review action is required.</li>"
    detector_policy_label = _localized_polish_detector_policy_label(
        bool(style_policy.get("detector_evasion")),
        language,
    )
    policy_name_label = _localized_polish_policy_name(
        str(style_policy.get("name") or "MetaAgent conservative scholarly polish"),
        language,
    )
    proofreader_role_label = _localized_polish_external_proofreader_role(
        str(style_policy.get("external_proofreader_role") or "review_only"),
        language,
    )
    title = "MetaAgent 稿件润色审计" if zh else "MetaAgent Manuscript Polish Audit"
    subtitle = (
        "事实保护的双语润色审查，并追踪 AI 风格信号。"
        if zh else
        "Fact-preserving bilingual polish review with AI-like style signal tracking."
    )
    labels = {
        "enabled": "已启用" if zh else "Enabled",
        "language": "审查语言" if zh else "Review language",
        "rewrite_scope": "润色范围" if zh else "Rewrite scope",
        "accepted_chunks": "接受片段" if zh else "Accepted chunks",
        "rejected_chunks": "拒绝片段" if zh else "Rejected chunks",
        "attempted_chunks": "已尝试片段" if zh else "Attempted chunks",
        "skipped_chunks": "跳过片段" if zh else "Skipped chunks",
        "total_rewrite_chunks": "总润色片段" if zh else "Total polish chunks",
        "targeted_chunks": "目标片段" if zh else "Targeted chunks",
        "non_target_chunks": "非目标片段" if zh else "Non-target chunks",
        "rewrite_retries": "事实保护重试" if zh else "Rewrite retries",
        "retry_recovered_chunks": "重试救回片段" if zh else "Recovered chunks",
        "budget_exhausted": "预算耗尽" if zh else "Budget exhausted",
        "before_score": "润色前风格分" if zh else "Before style score",
        "after_score": "当前稿件风格分" if zh else "Current draft style score",
        "stored_after_score": "旧审计风格分" if zh else "Stored audit style score",
        "style_delta": "风格变化" if zh else "Style delta",
        "audit_stale": "旧审计状态" if zh else "Stored audit status",
        "fact_issues": "事实保护问题" if zh else "Fact guard issues",
        "review_queue": "审查队列" if zh else "Review Queue",
        "fact_guard": "事实保护闸" if zh else "Fact Preservation Guard",
        "style_signals": "剩余风格信号" if zh else "Remaining Style Signals",
        "resolved_style_signals": "已解决风格信号" if zh else "Resolved Style Signals",
        "accepted_edits": "已接受润色修改" if zh else "Accepted Polish Edits",
        "rejected_edits": "被拒绝的润色候选" if zh else "Rejected Polish Candidates",
        "skipped_edit_chunks": "跳过的润色片段" if zh else "Skipped Polish Chunks",
        "policy": "润色策略" if zh else "Polish Policy",
        "proofreading": "外部审校" if zh else "Proofreading Review",
        "provider": "审校器" if zh else "Provider",
        "proofreading_issues": "审校问题" if zh else "Proofreading issues",
        "proofreading_failed": "审校器失败" if zh else "Proofreader failed",
        "proofreading_rule": "规则" if zh else "Rule",
        "proofreading_category": "类别" if zh else "Category",
        "proofreading_message": "审校信息" if zh else "Message",
        "proofreading_suggestion": "建议" if zh else "Suggestion",
        "code": "代码" if zh else "Code",
        "heading": "章节" if zh else "Heading",
        "review_action": "复核动作" if zh else "Review action",
        "manual_condition": "人工接受条件" if zh else "Manual accept condition",
        "message": "信息" if zh else "Message",
        "original": "原文" if zh else "Original",
        "candidate": "润色后" if zh else "Polished",
        "kept": "保留文本" if zh else "Kept text",
        "reason": "原因" if zh else "Reason",
        "chunk": "片段" if zh else "Chunk",
        "deterministic_cleanup": "确定性清理" if zh else "Deterministic cleanup",
        "diff": "差异" if zh else "Diff",
        "count_value": "计数/值" if zh else "Count/value",
        "details": "详情" if zh else "Details",
        "status": "状态" if zh else "Status",
        "manual_review_items": "需人工复核项" if zh else "Manual review items",
        "next_actions": "后续动作" if zh else "Next actions",
    }
    chips = [
        _stat_chip(labels["enabled"], _localized_polish_bool(bool(summary.get("enabled")), language)),
        _stat_chip(labels["language"], display_language),
        _stat_chip(labels["rewrite_scope"], _localized_polish_rewrite_scope(str(summary.get("rewrite_scope") or ""), language)),
        _stat_chip(labels["accepted_chunks"], summary.get("accepted_chunks", 0)),
        _stat_chip(labels["accepted_edits"], summary.get("accepted_edit_count", 0)),
        _stat_chip(labels["rejected_chunks"], summary.get("rejected_chunks", 0)),
        _stat_chip(labels["attempted_chunks"], summary.get("attempted_chunks", 0)),
        _stat_chip(labels["skipped_chunks"], summary.get("skipped_chunks", 0)),
        _stat_chip(labels["total_rewrite_chunks"], summary.get("total_rewrite_chunks", 0)),
        _stat_chip(labels["targeted_chunks"], summary.get("targeted_chunks", 0)),
        _stat_chip(labels["non_target_chunks"], summary.get("non_target_chunks", 0)),
        _stat_chip(labels["rewrite_retries"], summary.get("rewrite_retries", 0)),
        _stat_chip(labels["retry_recovered_chunks"], summary.get("retry_recovered_chunks", 0)),
        _stat_chip(labels["budget_exhausted"], _localized_polish_bool(bool(summary.get("polish_budget_exhausted")), language)),
        _stat_chip(labels["before_score"], summary.get("before_ai_style_score", 0)),
        _stat_chip(labels["after_score"], summary.get("after_ai_style_score", 0)),
        _stat_chip(labels["stored_after_score"], summary.get("stored_after_ai_style_score", summary.get("after_ai_style_score", 0))),
        _stat_chip(labels["style_delta"], summary.get("ai_style_delta", 0)),
        _stat_chip(labels["audit_stale"], _localized_polish_audit_stale(bool(summary.get("polish_audit_stale")), language)),
        _stat_chip(labels["fact_issues"], summary.get("fact_guard_issues", 0)),
        _stat_chip(labels["provider"], proofreading_provider_label),
        _stat_chip(labels["proofreading_issues"], summary.get("proofreading_issues", 0)),
        _stat_chip(labels["proofreading_failed"], _localized_polish_bool(proofreading_failed, language)),
    ]
    policy_panel = f"""    <section class="panel">
      <h2>{labels["policy"]}</h2>
      <p>{escape(policy_name_label)}; {escape(detector_policy_label)}; {escape(proofreader_role_label)}.</p>
    </section>"""
    review_queue_panel = f"""    <section class="panel">
      <h2>{labels["review_queue"]}</h2>
      <p>{labels["status"]}: <strong>{escape(_localized_polish_review_queue_status(str(review_queue.get("status") or ""), language))}</strong>; {labels["manual_review_items"]}: {escape(str(review_queue.get("manual_review_items", 0)))}; {labels["accepted_edits"]}: {escape(str(review_queue.get("accepted_auto_edits", 0)))}; {labels["rejected_edits"]}: {escape(str(review_queue.get("rejected_candidates", 0)))}; {labels["rewrite_retries"]}: {escape(str(review_queue.get("rewrite_retries", 0)))}; {labels["retry_recovered_chunks"]}: {escape(str(review_queue.get("retry_recovered_chunks", 0)))}.</p>
      <p>{labels["next_actions"]}:</p>
      <ul>{queue_actions}</ul>
    </section>"""
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
{policy_panel}
{review_queue_panel}
{_panel(labels["fact_guard"], _data_table([labels["code"], labels["heading"], labels["review_action"], labels["message"]], issue_rows))}
{_panel(labels["accepted_edits"], _data_table([labels["heading"], labels["review_action"], labels["original"], labels["candidate"], labels["diff"]], accepted_edit_rows))}
{_panel(labels["rejected_edits"], _data_table(["ID", labels["code"], labels["heading"], labels["manual_condition"], labels["original"], labels["candidate"], labels["diff"]], rejected_edit_rows))}
{_panel(labels["skipped_edit_chunks"], _data_table([labels["heading"], labels["chunk"], labels["reason"], labels["deterministic_cleanup"], labels["original"], labels["kept"]], skipped_chunk_rows))}
{_panel(labels["resolved_style_signals"], _data_table([labels["code"], labels["count_value"], labels["details"]], resolved_style_rows))}
{_panel(labels["style_signals"], _data_table([labels["code"], labels["count_value"], labels["details"]], style_rows))}
{_panel(labels["proofreading"], _data_table([labels["proofreading_rule"], labels["proofreading_category"], labels["proofreading_message"], labels["proofreading_suggestion"]], proofreading_rows))}
  </main>"""
    return _render_page(title=title, body=body, lang=_html_lang(language), extra_css=_POLISH_EXTRA_CSS)


def _render_manuscript_polish_issue_row(issue: dict[str, Any], *, language: str = "en") -> str:
    code = str(issue.get("code") or "")
    return (
        "<tr>"
        f"<td class=\"fail\">{escape(_localized_polish_issue_code(code, language))}</td>"
        f"<td>{escape(str(issue.get('heading') or issue.get('section') or ''))}</td>"
        f"<td>{escape(_localized_polish_review_action(str(issue.get('review_action') or 'manual_review_required'), language))}</td>"
        f"<td>{escape(_localized_polish_issue_message(issue, language))}</td>"
        "</tr>"
    )


def _render_manuscript_polish_accepted_edit_row(edit: dict[str, Any], *, language: str = "en") -> str:
    return (
        "<tr>"
        f"<td>{escape(str(edit.get('heading') or ''))}</td>"
        f"<td>{escape(_localized_polish_review_action(str(edit.get('review_action') or 'accepted_fact_preserving_polish'), language))}</td>"
        f"<td><code>{escape(_truncate_review_cell(str(edit.get('original_text') or '')))}</code></td>"
        f"<td><code>{escape(_truncate_review_cell(str(edit.get('candidate_text') or '')))}</code></td>"
        f"<td><code>{escape(_truncate_review_cell(str(edit.get('diff') or ''), max_chars=900))}</code></td>"
        "</tr>"
    )


def _localized_polish_review_action(action: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return action
    return {
        "accepted_fact_preserving_polish": "已接受事实保护润色",
        "manual_review_required": "需人工复核",
        "rerun_with_higher_polish_budget": "提高润色预算后重跑",
    }.get(action, action)


def _localized_polish_review_queue_status(status: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return status
    return {
        "human_review_required": "需人工复核",
        "budget_review_required": "需复核润色预算",
        "polish_guard_discarded_candidates_no_review_required": "事实保护闸已拒绝候选，无需人工复核",
        "polish_applied_no_review_required": "已润色，无需额外复核",
        "no_polish_review_needed": "无需润色复核",
    }.get(status, status)


def _localized_polish_rewrite_scope(scope: str, language: str) -> str:
    raw = str(scope or "").strip().lower()
    if not _is_zh_review_language(language):
        return raw
    return {
        "targeted": "定向润色",
        "target": "定向润色",
        "all": "全文润色",
        "full": "全文润色",
        "": "未指定",
    }.get(raw, raw)


def _localized_polish_provider_label(provider: str, language: str) -> str:
    raw = str(provider or "").strip()
    lower = raw.lower()
    if not _is_zh_review_language(language):
        return "LanguageTool" if lower == "languagetool" else raw
    return {
        "none": "未启用",
        "": "未启用",
        "languagetool": "LanguageTool",
        "custom": "自定义审校器",
    }.get(lower, raw)


def _localized_polish_detector_policy_label(detector_evasion: bool, language: str) -> str:
    if _is_zh_review_language(language):
        return "检测器规避：启用" if detector_evasion else "检测器规避：禁用"
    return "detector evasion enabled" if detector_evasion else "detector evasion disabled"


def _localized_polish_audit_stale(is_stale: bool, language: str) -> str:
    if _is_zh_review_language(language):
        return "需以当前稿件重算为准" if is_stale else "与当前稿件一致"
    return "superseded by current draft rescore" if is_stale else "matches current draft"


def _localized_polish_policy_name(name: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return name
    if name == "MetaAgent conservative scholarly polish":
        return "MetaAgent 保守学术润色策略"
    return name


def _localized_polish_external_proofreader_role(role: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return role
    return {
        "review_only": "外部审校角色：仅复核",
        "disabled": "外部审校角色：未启用",
    }.get(role, f"外部审校角色：{role}")


def _localized_polish_language_label(value: str, language: str) -> str:
    raw = str(value or "").strip().lower()
    if not _is_zh_review_language(language):
        return raw
    return {
        "zh": "中文",
        "en": "英文",
        "mixed": "中英混合",
    }.get(raw, raw)


def _localized_polish_issue_code(code: str, language: str) -> str:
    raw = str(code or "").strip()
    if not _is_zh_review_language(language):
        return raw
    return {
        "citations_changed": "引用标记变更",
        "citation_sentence_binding_changed": "引用同句绑定变更",
        "numeric_tokens_changed": "数字变更",
        "cross_references_changed": "表图引用变更",
        "protected_terms_changed": "受保护术语变更",
        "clinical_entities_changed": "临床实体变更",
        "directional_terms_changed": "方向性术语变更",
        "clinical_claim_terms_changed": "临床声明语气变更",
        "certainty_rating_changed": "证据确定性等级变更",
        "risk_of_bias_rating_changed": "偏倚风险等级变更",
        "statistical_model_changed": "统计模型变更",
        "statistical_significance_changed": "统计显著性解释变更",
        "study_design_changed": "研究设计术语变更",
        "language_changed": "稿件输出语言变更",
        "interpretive_certainty_changed": "解释强度变更",
        "detector_evasion_language": "检测器规避措辞",
        "polish_budget_exhausted": "润色预算耗尽",
        "template_phrase_hits": "模板化短语",
        "repeated_sentence_starts": "重复句首",
        "low_sentence_length_variation": "句长变化过低",
        "low_lexical_diversity": "词汇变化偏低",
    }.get(raw, raw)


def _localized_polish_bool(value: bool, language: str) -> str:
    if _is_zh_review_language(language):
        return "是" if value else "否"
    return str(value)


def _localized_polish_candidate_label(edit: dict[str, Any], language: str) -> str:
    raw = str(edit.get("candidate_id") or "")
    if not _is_zh_review_language(language):
        return raw
    code_label = _localized_polish_issue_code(str(edit.get("code") or ""), language)
    chunk_index = _integer_or_none(edit.get("chunk_index"))
    if chunk_index is not None:
        return f"候选 {chunk_index + 1}（{code_label}）"
    return f"候选（{code_label}）"


def _render_manuscript_polish_rejected_edit_row(edit: dict[str, Any], *, language: str = "en") -> str:
    code = str(edit.get("code") or "")
    return (
        "<tr>"
        f"<td>{escape(_localized_polish_candidate_label(edit, language))}</td>"
        f"<td class=\"fail\">{escape(_localized_polish_issue_code(code, language))}</td>"
        f"<td>{escape(str(edit.get('heading') or ''))}</td>"
        f"<td>{escape(str(edit.get('manual_accept_condition') or _manuscript_polish_manual_accept_condition(language)))}</td>"
        f"<td><code>{escape(_truncate_review_cell(str(edit.get('original_text') or '')))}</code></td>"
        f"<td><code>{escape(_truncate_review_cell(str(edit.get('candidate_text') or '')))}</code></td>"
        f"<td><code>{escape(_truncate_review_cell(str(edit.get('diff') or ''), max_chars=900))}</code></td>"
        "</tr>"
    )


def _render_manuscript_polish_skipped_chunk_row(item: dict[str, Any], *, language: str = "en") -> str:
    chunk_index = _integer_or_none(item.get("chunk_index"))
    chunk_count = _integer_or_none(item.get("chunk_count"))
    if chunk_index is not None and chunk_count is not None:
        chunk_label = f"{chunk_index + 1}/{chunk_count}"
    elif chunk_index is not None:
        chunk_label = str(chunk_index + 1)
    else:
        chunk_label = ""
    return (
        "<tr>"
        f"<td>{escape(str(item.get('heading') or ''))}</td>"
        f"<td>{escape(chunk_label)}</td>"
        f"<td>{escape(_localized_polish_skip_reason(str(item.get('reason') or ''), language))}</td>"
        f"<td>{escape(_localized_polish_bool(bool(item.get('deterministic_cleanup_applied')), language))}</td>"
        f"<td><code>{escape(_truncate_review_cell(str(item.get('original_text') or '')))}</code></td>"
        f"<td><code>{escape(_truncate_review_cell(str(item.get('kept_text') or '')))}</code></td>"
        "</tr>"
    )


def _localized_polish_skip_reason(reason: str, language: str) -> str:
    raw = str(reason or "").strip()
    if not _is_zh_review_language(language):
        return raw
    return {
        "polish_budget_exhausted": "润色预算耗尽",
    }.get(raw, raw)


def _truncate_review_cell(text: str, max_chars: int = 420) -> str:
    clean = str(text or "").strip()
    if len(clean) <= max_chars:
        return clean
    return clean[: max_chars - 1].rstrip() + "..."


def _render_manuscript_polish_style_issue_row(issue: dict[str, Any], *, language: str = "en") -> str:
    code = str(issue.get("code") or "")
    count_or_value = issue.get("count", issue.get("value", ""))
    details = {
        key: value
        for key, value in issue.items()
        if key not in {"code", "count", "value", "weight", "message", "suggested_action", "evidence_excerpt"}
    }
    message = str(issue.get("message") or _polish_style_issue_message(str(issue.get("code") or ""), language))
    action = str(issue.get("suggested_action") or _polish_style_issue_action(str(issue.get("code") or ""), language))
    excerpt = str(issue.get("evidence_excerpt") or "")
    detail_payload = _localized_polish_style_detail_payload(
        message=message,
        suggested_action=action,
        evidence_excerpt=excerpt,
        details=details,
        language=language,
    )
    return (
        "<tr>"
        f"<td class=\"warn\">{escape(_localized_polish_issue_code(code, language))}</td>"
        f"<td>{escape(str(count_or_value))}</td>"
        f"<td><code>{escape(json.dumps(detail_payload, ensure_ascii=False, sort_keys=True))}</code></td>"
        "</tr>"
    )


def _localized_polish_style_detail_payload(
    *,
    message: str,
    suggested_action: str,
    evidence_excerpt: str,
    details: dict[str, Any],
    language: str,
) -> dict[str, Any]:
    if not _is_zh_review_language(language):
        return {
            "message": message,
            "suggested_action": suggested_action,
            "evidence_excerpt": evidence_excerpt,
            "details": details,
        }
    return {
        "信息": message,
        "处理建议": suggested_action,
        "证据摘录": evidence_excerpt,
        "详情": details,
    }


def _render_manuscript_polish_proofreading_row(issue: dict[str, Any]) -> str:
    replacements = issue.get("replacements") if isinstance(issue.get("replacements"), list) else []
    suggestion = ", ".join(str(item) for item in replacements[:3])
    return (
        "<tr>"
        f"<td>{escape(str(issue.get('rule_id') or ''))}</td>"
        f"<td>{escape(str(issue.get('category') or issue.get('category_id') or issue.get('issue_type') or ''))}</td>"
        f"<td>{escape(str(issue.get('message') or ''))}</td>"
        f"<td>{escape(suggestion)}</td>"
        "</tr>"
    )


def _localized_polish_issue_message(issue: dict[str, Any], language: str) -> str:
    message = str(issue.get("message") or "")
    if not _is_zh_review_language(language):
        return message
    code = str(issue.get("code") or "")
    if code == "citations_changed":
        return "润色候选修改了引用标记，需人工复核。"
    if code == "citation_sentence_binding_changed":
        return "润色候选把引用标记移动到了不同句子或声明，需人工复核。"
    if code == "numeric_tokens_changed":
        return "润色候选修改了数字，需人工复核。"
    if code == "cross_references_changed":
        return "润色候选修改了表格或图形交叉引用，需人工复核。"
    if code == "protected_terms_changed":
        return "润色候选修改了受保护术语，需人工复核。"
    if code == "clinical_entities_changed":
        return "润色候选修改了人群、疾病、干预、比较组或结局名称，需人工复核。"
    if code == "directional_terms_changed":
        return "润色候选修改了结论方向或否定关系，需人工复核。"
    if code == "clinical_claim_terms_changed":
        return "润色候选修改了临床获益、伤害、有效性或因果语气，需人工复核。"
    if code == "certainty_rating_changed":
        return "润色候选修改了GRADE证据确定性等级，需人工复核。"
    if code == "risk_of_bias_rating_changed":
        return "润色候选修改了偏倚风险等级，需人工复核。"
    if code == "statistical_model_changed":
        return "润色候选修改了统计模型或τ²估计方法，需人工复核。"
    if code == "statistical_significance_changed":
        return "润色候选修改了统计显著性解释，需人工复核。"
    if code == "study_design_changed":
        return "润色候选修改了研究设计术语，需人工复核。"
    if code == "language_changed":
        return "润色候选修改了稿件输出语言，需人工复核。"
    if code == "interpretive_certainty_changed":
        return "润色候选修改了解释强度、相关性或不确定性措辞，需人工复核。"
    if code == "detector_evasion_language":
        return "润色候选包含面向检测器规避的措辞，需改为普通学术审校。"
    return message or "润色候选触发事实保护闸，需人工复核。"




def _integer_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
