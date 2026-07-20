"""Citation audit and citation-fix review renderers."""
from __future__ import annotations

from html import escape
import json
import re
from typing import Any

from new_meta.core.artifact_package_language import (
    html_lang as _html_lang,
    is_zh_review_language as _is_zh_review_language,
    normalize_review_language as _normalize_review_language,
)
from new_meta.core.report_style import (
    data_table as _data_table,
    page_header as _page_header,
    panel as _panel,
    render_page as _render_page,
    stat_chip as _stat_chip,
)

_CODE_PRE_WRAP_CSS = "code { white-space: pre-wrap; }"


def render_manuscript_citation_fix_html(review: dict) -> str:
    summary = review.get("summary") or {}
    entries = [item for item in (review.get("entries") or []) if isinstance(item, dict)]
    language = _normalize_review_language(review.get("language") or "")
    zh = _is_zh_review_language(language)
    rows = "\n".join(_render_manuscript_citation_fix_row(item, language=language) for item in entries)
    if not rows:
        empty_text = "未记录稿件引用修复条目。" if zh else "No manuscript citation fix entries were recorded."
        rows = f'<tr><td colspan="9">{escape(empty_text)}</td></tr>'
    title = "MetaAgent 稿件引用修复记录" if zh else "MetaAgent Manuscript Citation Fixes"
    subtitle = (
        "记录系统补充文内引用和人工复核参考文献候选的过程。"
        if zh else
        "Audit trail for citation patches and manually reviewed reference additions."
    )
    labels = {
        "current_revision": "当前修订" if zh else "Current revision",
        "entries": "修复记录" if zh else "Entries",
        "citation_patches": "引用补丁" if zh else "Citation patches",
        "reference_additions": "新增参考文献" if zh else "Reference additions",
        "reference_reuse": "引用复用" if zh else "Reference reuse",
        "human_review_required": "需要人工复核" if zh else "Human review required",
        "quality_resolved": "质量问题已解决" if zh else "Quality issues resolved",
        "quality_references_added": "质量记录新增参考文献" if zh else "Quality references added",
        "revision_entries": "修订记录" if zh else "Revision Entries",
    }
    headers = (
        ["修订", "动作", "章节", "引用", "问题", "质量影响", "候选", "信任状态", "来源"]
        if zh else
        ["Revision", "Action", "Section", "Citation", "Issue", "Quality impact", "Candidate", "Trust", "Source"]
    )
    chips = [
        _stat_chip(labels["current_revision"], summary.get("current_revision", 0)),
        _stat_chip(labels["entries"], summary.get("entries", 0)),
        _stat_chip(labels["citation_patches"], summary.get("citation_patch_actions", 0)),
        _stat_chip(labels["reference_additions"], summary.get("reference_add_actions", 0)),
        _stat_chip(labels["reference_reuse"], summary.get("reference_reuse_actions", 0)),
        _stat_chip(labels["human_review_required"], summary.get("reference_fix_human_review_required", 0)),
        _stat_chip(labels["quality_resolved"], summary.get("quality_resolved_issues", 0)),
        _stat_chip(labels["quality_references_added"], summary.get("quality_reference_entries_added", 0)),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
{_panel(labels["revision_entries"], _data_table(headers, rows))}
  </main>"""
    return _render_page(title=title, body=body, lang=_html_lang(language), extra_css=_CODE_PRE_WRAP_CSS)


def render_citation_audit_html(audit: dict) -> str:
    summary = audit.get("summary") or {}
    language = str(audit.get("language") or "").strip().lower()
    zh = _is_zh_review_language(language)
    issues = audit.get("issues") or []
    section_counts = audit.get("section_counts") or {}
    issue_rows = "\n".join(_render_citation_issue_row(issue, language=language) for issue in issues)
    if not issue_rows:
        issue_rows = (
            '<tr><td colspan="4">未记录引用覆盖问题。</td></tr>'
            if zh else
            '<tr><td colspan="4">No citation coverage issues were recorded.</td></tr>'
        )
    section_rows = "\n".join(
        "<tr>"
        f"<td>{escape(_localized_review_section_label(str(section), language))}</td>"
        f"<td>{escape(str(count))}</td>"
        "</tr>"
        for section, count in section_counts.items()
    )
    if not section_rows:
        section_rows = (
            '<tr><td colspan="2">未记录各章节引用计数。</td></tr>'
            if zh else
            '<tr><td colspan="2">No section citation counts were available.</td></tr>'
        )
    if int(summary.get("failed_issues") or 0) or int(summary.get("warning_issues") or 0):
        if zh:
            issue_title = (
                "<h2>引用覆盖问题</h2>"
                "<p>正式稿正文应引用来源报告，不能只在表格或参考文献列表中出现。</p>"
            )
        else:
            issue_title = (
                "<h2>Citation Coverage Issue</h2>"
                "<p>Formal manuscripts should cite source reports in the interpretive main text, not only in tables or the bibliography.</p>"
            )
    else:
        issue_title = ""
    title = "MetaAgent 引用覆盖审计" if zh else "MetaAgent Citation Audit"
    subtitle = "检查正文是否引用编号参考文献列表。" if zh else "Checks whether the main manuscript text cites the numbered reference list."
    labels = {
        "references": "参考文献" if zh else "References",
        "main_text": "正文引用" if zh else "Main-text citations",
        "unique": "不同被引来源" if zh else "Unique cited refs",
        "density": "引用密度" if zh else "Citation density",
        "topic_mismatch": "背景引用跑题" if zh else "Background topic mismatches",
        "overloaded": "过载引用簇" if zh else "Overloaded citation clusters",
        "repeated_clusters": "重复大引用簇" if zh else "Repeated large citation clusters",
        "mechanical_density": "机械引用密度段落" if zh else "Mechanical citation-density paragraphs",
        "uncited_effects": "未引用数值效应句" if zh else "Uncited numeric effect claims",
        "wrong_source_effects": "数值效应来源引用不匹配" if zh else "Numeric effect claims lacking source refs",
        "uncited_results": "未引用结果数据来源声明" if zh else "Uncited results data claims",
        "uncited_intro": "未引用引言背景声明" if zh else "Uncited intro background claims",
        "uncited_methods": "未引用方法学声明" if zh else "Uncited methods claims",
        "uncited_discussion": "未引用讨论语境声明" if zh else "Uncited discussion context claims",
        "uncited_discussion_results": "未引用讨论结果声明" if zh else "Uncited discussion result claims",
        "uncited_discussion_mechanisms": "未引用讨论机制解释" if zh else "Uncited discussion mechanism claims",
        "uncited_conclusion": "未引用结论结果声明" if zh else "Uncited conclusion result claims",
        "undefined": "未定义引用编号" if zh else "Undefined citation numbers",
        "failed": "失败问题" if zh else "Failed issues",
        "warnings": "警告" if zh else "Warnings",
        "section_counts": "章节引用计数" if zh else "Section Citation Counts",
        "section": "章节" if zh else "Section",
        "inline": "文内引用" if zh else "Inline citations",
        "issues": "问题" if zh else "Issues",
        "severity": "严重程度" if zh else "Severity",
        "code": "代码" if zh else "Code",
        "message": "信息" if zh else "Message",
    }
    chips = [
        _stat_chip(labels["references"], summary.get("reference_entries", 0)),
        _stat_chip(labels["main_text"], summary.get("main_text_inline_citations", 0)),
        _stat_chip(labels["unique"], summary.get("unique_cited_reference_numbers", 0)),
        _stat_chip(labels["density"], f"{summary.get('citation_density_per_1000_words', 0)} / 1000 words"),
        _stat_chip(labels["topic_mismatch"], summary.get("background_reference_topic_mismatch_count", 0)),
        _stat_chip(labels["overloaded"], summary.get("overloaded_citation_clusters", 0)),
        _stat_chip(labels["repeated_clusters"], summary.get("repeated_large_citation_clusters", 0)),
        _stat_chip(labels["mechanical_density"], summary.get("mechanical_citation_density_paragraphs", 0)),
        _stat_chip(labels["uncited_effects"], summary.get("uncited_numeric_effect_claims", 0)),
        _stat_chip(labels["wrong_source_effects"], summary.get("numeric_effect_claims_without_source_citations", 0)),
        _stat_chip(labels["uncited_results"], summary.get("uncited_results_study_data_claims", 0)),
        _stat_chip(labels["uncited_intro"], summary.get("uncited_introduction_background_claims", 0)),
        _stat_chip(labels["uncited_methods"], summary.get("uncited_methods_methodology_claims", 0)),
        _stat_chip(labels["uncited_discussion"], summary.get("uncited_discussion_context_claims", 0)),
        _stat_chip(labels["uncited_discussion_results"], summary.get("uncited_discussion_result_claims", 0)),
        _stat_chip(labels["uncited_discussion_mechanisms"], summary.get("uncited_discussion_mechanism_claims", 0)),
        _stat_chip(labels["uncited_conclusion"], summary.get("uncited_conclusion_result_claims", 0)),
        _stat_chip(labels["undefined"], summary.get("undefined_citation_numbers", 0)),
        _stat_chip(labels["failed"], summary.get("failed_issues", 0)),
        _stat_chip(labels["warnings"], summary.get("warning_issues", 0)),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
    {issue_title}
{_panel(labels["section_counts"], _data_table([labels["section"], labels["inline"]], section_rows))}
{_panel(labels["issues"], _data_table([labels["severity"], labels["code"], labels["section"], labels["message"]], issue_rows))}
  </main>"""
    return _render_page(title=title, body=body, lang=_html_lang(language))


def _render_manuscript_citation_fix_row(entry: dict[str, Any], *, language: str = "en") -> str:
    source = entry.get("candidate_source") if isinstance(entry.get("candidate_source"), dict) else {}
    trust = entry.get("trust") if isinstance(entry.get("trust"), dict) else {}
    return (
        "<tr>"
        f"<td>{escape(str(entry.get('revision') or ''))}</td>"
        f"<td>{escape(_localized_citation_fix_action(str(entry.get('action') or ''), language))}</td>"
        f"<td>{escape(str(entry.get('section') or ''))}</td>"
        f"<td>{escape(str(entry.get('citation') or ''))}</td>"
        f"<td>{escape(str(entry.get('issue_id') or ''))}</td>"
        f"<td>{escape(_citation_fix_quality_impact_text(entry.get('quality_delta'), language))}</td>"
        f"<td>{escape(str(entry.get('candidate_id') or ''))}</td>"
        f"<td><code>{escape(json.dumps(trust, ensure_ascii=False, sort_keys=True))}</code></td>"
        f"<td><code>{escape(json.dumps(source, ensure_ascii=False, sort_keys=True))}</code></td>"
        "</tr>"
    )


def _citation_fix_quality_impact_text(delta: Any, language: str = "en") -> str:
    if not isinstance(delta, dict) or not delta:
        return ""
    zh = _is_zh_review_language(language)
    before = str(delta.get("quality_status_before") or "").strip()
    after = str(delta.get("quality_status_after") or "").strip()
    resolved = len([item for item in (delta.get("resolved_issue_ids") or []) if str(item).strip()])
    try:
        references_added = int(delta.get("reference_entries_added") or 0)
    except (TypeError, ValueError):
        references_added = 0
    primary_mismatches = _quality_delta_int(delta, "primary_result_mismatched_fields_resolved")
    unsupported_claims = _quality_delta_int(delta, "claim_support_unsupported_claims_resolved")
    parts: list[str] = []
    if before or after:
        if zh:
            parts.append(f"{before or 'unknown'} 到 {after or 'unknown'}")
        else:
            parts.append(f"{before or 'unknown'} to {after or 'unknown'}")
    if resolved:
        parts.append(f"解决 {resolved} 个问题" if zh else f"resolved {resolved} issue(s)")
    if references_added:
        parts.append(f"参考文献 +{references_added}" if zh else f"references +{references_added}")
    if primary_mismatches:
        parts.append(
            f"主结果错配 -{primary_mismatches}"
            if zh else
            f"primary result mismatches -{primary_mismatches}"
        )
    if unsupported_claims:
        parts.append(
            f"不支持主张 -{unsupported_claims}"
            if zh else
            f"unsupported claims -{unsupported_claims}"
        )
    return "; ".join(parts)


def _localized_citation_fix_action(action: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return action
    return {
        "citation_patch": "引用补丁",
        "add_reference": "新增参考文献",
        "reuse_reference_citation": "复用既有引用",
    }.get(action, action)


def _render_citation_issue_row(issue: dict[str, Any], *, language: str = "en") -> str:
    severity = str(issue.get("severity") or "")
    severity_class = "warn" if severity in {"warn", "warning"} else "fail"
    code = str(issue.get("code") or "")
    message = _localized_citation_issue_message(issue, language)
    message = f"{message}{_citation_issue_recommendation_suffix(issue, language)}"
    return (
        "<tr>"
        f"<td class=\"{severity_class}\">{escape(_localized_citation_issue_severity(severity, language))}</td>"
        f"<td>{escape(_localized_citation_issue_code(code, language))}</td>"
        f"<td>{escape(_localized_review_section_label(str(issue.get('section') or ''), language))}</td>"
        f"<td>{escape(message)}</td>"
        "</tr>"
    )


def _localized_review_section_label(section: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return str(section or "")
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
    return mapping.get(raw, raw)


def _localized_citation_issue_message(issue: dict[str, Any], language: str) -> str:
    message = str(issue.get("message") or "")
    if not _is_zh_review_language(language):
        return message
    code = str(issue.get("code") or "")
    section = _localized_review_section_label(str(issue.get("section") or ""), language)
    if code == "section_citations_missing":
        return f"{section}没有文内引用，但参考文献列表已存在。"
    if code == "main_text_citations_missing":
        return "参考文献列表之前的正文没有文内引用。"
    if code == "undefined_citation_number":
        nums = ", ".join(str(num) for num in issue.get("citation_numbers") or [])
        suffix = f"（{nums}）" if nums else ""
        return f"正文引用了参考文献列表中不存在的编号{suffix}。"
    if code == "insufficient_reference_count":
        return "稿件长度已接近正式投稿稿，但参考文献数量偏少。"
    if code == "low_unique_cited_references":
        return "正文依赖的不同被引参考文献数量偏少。"
    if code == "low_citation_density":
        return "正式稿的正文引用密度偏低。"
    if code == "publication_reference_count_below_target":
        return "这是可投稿式Meta分析稿件，但参考文献总量仍偏少。"
    if code == "introduction_paragraph_citation_coverage_low":
        return "引言部分有较多实质段落没有文内引用。"
    if code == "discussion_paragraph_citation_coverage_low":
        return "讨论部分有较多实质段落没有文内引用。"
    if code == "introduction_background_citations_missing":
        return "引言部分尚未引用可用的背景、指南或既往综述来源。"
    if code == "introduction_background_citation_count_low":
        return "引言部分引用的背景、指南或既往综述来源数量偏少。"
    if code == "uncited_introduction_background_claim":
        return "引言部分一处疾病负担、指南建议或既往证据背景声明缺少同句文内引用。"
    if code == "methods_methodology_citations_missing":
        return "方法部分尚未引用可用的报告规范、方法学手册、GRADE、偏倚风险或统计方法来源。"
    if code == "methods_methodology_citation_count_low":
        return "方法部分引用的方法学来源数量偏少。"
    if code == "uncited_methods_methodology_claim":
        return "方法部分一处报告规范、偏倚风险、GRADE或统计方法声明缺少同句文内引用。"
    if code == "discussion_context_citations_missing":
        return "讨论部分尚未引用可用的指南、既往综述、GRADE或发表偏倚背景来源。"
    if code == "discussion_context_citation_count_low":
        return "讨论部分引用的指南、既往综述、GRADE或发表偏倚语境来源数量偏少。"
    if code == "uncited_discussion_context_claim":
        return "讨论部分一处指南、既往证据、GRADE或发表偏倚语境声明缺少同句文内引用。"
    if code == "uncited_discussion_result_claim":
        return "讨论部分一处主要结果、安全性或临床解释声明缺少同句文内引用。"
    if code == "uncited_discussion_mechanism_claim":
        return "讨论部分一处机制或生物学解释声明缺少同句文内引用。"
    if code == "background_reference_topic_mismatch":
        return "一个或多个背景参考文献可能与综述问题不匹配，请核对证据检索上下文和最终参考文献表。"
    if code == "chinese_ascii_numeric_citation_marker_style":
        return "中文稿件在代码块外混用了半角数字引用角标；请统一使用全角中文引用角标。"
    if code == "overloaded_citation_cluster":
        return "一处文内引用簇包含过多参考文献编号，请把来源拆分到各自支持的具体声明。"
    if code == "repeated_large_citation_cluster":
        return "同一组较大的引用簇在多个段落中重复出现，请按具体声明重新分配引用。"
    if code == "mechanical_citation_density":
        return "一处解释性段落的文内引用过于密集机械，请把引用贴近真正支持的具体声明。"
    if code == "uncited_numeric_effect_claim":
        return "一处数值效应、置信区间、异质性或P值声明缺少同句文内引用。"
    if code == "numeric_effect_claim_lacks_source_citation":
        return "一处数值效应声明已有文内引用，但未引用可用的试验、注册或来源报告。"
    if code == "uncited_results_study_data_claim":
        return "结果部分一处研究、受试者或结局数据来源声明缺少同句文内引用。"
    if code == "uncited_conclusion_result_claim":
        return "结论部分一处主要结果、安全性、临床解释或证据确定性声明缺少同句文内引用。"
    return message


def _localized_citation_issue_severity(severity: str, language: str) -> str:
    severity = str(severity or "")
    if not _is_zh_review_language(language):
        return severity
    return {
        "fail": "失败",
        "warn": "警告",
        "warning": "警告",
    }.get(severity, severity)


def _localized_citation_issue_code(code: str, language: str) -> str:
    code = str(code or "")
    if not _is_zh_review_language(language):
        return code
    return {
        "section_citations_missing": "缺少章节引用",
        "main_text_citations_missing": "正文缺少引用",
        "undefined_citation_number": "未定义引用编号",
        "insufficient_reference_count": "参考文献数量偏少",
        "low_unique_cited_references": "不同被引来源偏少",
        "low_citation_density": "引用密度偏低",
        "publication_reference_count_below_target": "投稿稿参考文献深度不足",
        "introduction_paragraph_citation_coverage_low": "引言段落引用覆盖偏低",
        "discussion_paragraph_citation_coverage_low": "讨论段落引用覆盖偏低",
        "introduction_background_citations_missing": "引言缺少背景引用",
        "introduction_background_citation_count_low": "引言背景引用偏少",
        "uncited_introduction_background_claim": "引言背景声明缺少引用",
        "methods_methodology_citations_missing": "方法缺少方法学引用",
        "methods_methodology_citation_count_low": "方法学引用偏少",
        "uncited_methods_methodology_claim": "方法学声明缺少引用",
        "discussion_context_citations_missing": "讨论缺少背景引用",
        "discussion_context_citation_count_low": "讨论语境引用偏少",
        "uncited_discussion_context_claim": "讨论语境声明缺少引用",
        "uncited_discussion_result_claim": "讨论结果声明缺少引用",
        "uncited_discussion_mechanism_claim": "讨论机制解释缺少引用",
        "background_reference_topic_mismatch": "背景参考文献可能跑题",
        "chinese_ascii_numeric_citation_marker_style": "中文引用角标格式不一致",
        "overloaded_citation_cluster": "引用簇过载",
        "repeated_large_citation_cluster": "大引用簇重复出现",
        "mechanical_citation_density": "机械引用密度过高",
        "uncited_numeric_effect_claim": "数值效应声明缺少引用",
        "numeric_effect_claim_lacks_source_citation": "数值效应来源引用不匹配",
        "uncited_results_study_data_claim": "结果数据来源声明缺少引用",
        "uncited_conclusion_result_claim": "结论结果声明缺少引用",
    }.get(code, code)


def _citation_issue_recommendation_suffix(issue: dict[str, Any], language: str) -> str:
    recommended = issue.get("recommended_citations") or []
    if not isinstance(recommended, list):
        recommended = [recommended]
    citations = [
        _format_recommended_citation_token(item)
        for item in recommended
        if str(item).strip()
    ]
    if not citations:
        return ""
    joined = ", ".join(citations)
    if _is_zh_review_language(language):
        return f" 建议补充引用：{joined}。"
    return f" Recommended citations: {joined}."


def _format_recommended_citation_token(value: Any) -> str:
    text = str(value).strip()
    if not text:
        return ""
    match = re.search(r"\d+", text)
    return f"[{match.group(0)}]" if match else text


def _quality_delta_int(delta: dict[str, Any], key: str) -> int:
    try:
        return int(delta.get(key) or 0)
    except (TypeError, ValueError):
        return 0
