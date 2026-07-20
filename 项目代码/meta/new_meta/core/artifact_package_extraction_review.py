"""Extraction-review and GRADE-review HTML helpers for artifact packages."""
from __future__ import annotations

import json
import re
from html import escape
from typing import Any

from new_meta.core.artifact_package_language import (
    html_lang as _html_lang,
    is_zh_review_language as _is_zh_review_language,
    normalize_review_language as _normalize_review_language,
)
from new_meta.core.report_style import (
    page_header as _page_header,
    render_page as _render_page,
    stat_chip as _stat_chip,
)

# Supplementary CSS for the extraction review's card layout, appended after
# the shared report style. Quote/mark/context/pre colours are page-local
# custom properties so dark mode can restyle them too.
_EXTRACTION_REVIEW_EXTRA_CSS = """    :root {
      --quote-bg: #f8fbff;
      --mark-bg: #fff3bf;
      --context-bg: #fcfcfd;
      --pre-bg: #0f172a;
      --pre-text: #e2e8f0;
    }
    body { line-height: 1.5; }
    th, td { padding: 8px 6px; }
    details.card {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      margin: 14px 0;
      overflow: hidden;
    }
    details.card[open] { box-shadow: 0 10px 24px rgba(16, 24, 40, 0.08); }
    summary {
      cursor: pointer;
      padding: 14px 16px;
      display: grid;
      grid-template-columns: 42px minmax(220px, 1.3fr) minmax(180px, 1fr) auto;
      gap: 14px;
      align-items: center;
    }
    .idx { color: var(--muted); font-variant-numeric: tabular-nums; }
    .title { font-weight: 650; }
    .meta { color: var(--muted); font-size: 13px; }
    .badge {
      border-radius: 999px;
      padding: 3px 9px;
      font-size: 12px;
      white-space: nowrap;
      border: 1px solid var(--line);
      background: var(--badge-bg);
      font-weight: 400;
    }
    .badge.ok { color: var(--ok); border-color: var(--ok-line); background: var(--ok-bg); }
    .badge.warn { color: var(--warn); border-color: var(--warn-line); background: var(--warn-bg); }
    .badge.bad { color: var(--bad); border-color: var(--bad-line); background: var(--bad-bg); }
    .body { padding: 0 16px 16px; }
    .grid { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(280px, 1fr); gap: 16px; }
    .panel { margin: 0 0 18px; }
    .panel h2 { margin: 0 0 8px; font-size: 18px; }
    .outcome-panel {
      border-top: 1px solid var(--line);
      margin-top: 14px;
      padding-top: 12px;
    }
    blockquote {
      margin: 8px 0 0;
      padding: 12px;
      border-left: 4px solid var(--accent);
      background: var(--quote-bg);
      white-space: pre-wrap;
    }
    mark {
      background: var(--mark-bg);
      color: inherit;
      padding: 0 2px;
      border-radius: 3px;
    }
    .source-context {
      margin: 8px 0 0;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--context-bg);
      white-space: pre-wrap;
    }
    pre {
      margin: 8px 0 0;
      padding: 10px;
      overflow: auto;
      background: var(--pre-bg);
      color: var(--pre-text);
      border-radius: 6px;
      font-size: 12px;
    }
    .section-title { margin: 14px 0 6px; font-size: 14px; font-weight: 700; }
    .empty { color: var(--muted); }
    @media (max-width: 760px) {
      summary { grid-template-columns: 34px 1fr; }
      summary .meta, summary .status { grid-column: 2; }
      .grid { grid-template-columns: 1fr; }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --quote-bg: #14213a;
        --mark-bg: #5c4a12;
        --context-bg: #131b2a;
      }
    }"""


def _localized_extraction_report_type(value: Any, language: str) -> str:
    text = str(value or "")
    if not _is_zh_review_language(language):
        return text
    return {
        "meta": "Meta分析",
        "narrative": "叙事综合",
        "evidence_gap": "证据缺口",
        "failed": "生成失败",
        "unknown": "未知",
    }.get(text, text)


def _localized_extraction_status(value: Any, language: str) -> str:
    text = str(value or "")
    if not _is_zh_review_language(language):
        return text
    return {
        "ready": "就绪",
        "ready_with_warnings": "带警告就绪",
        "needs_review": "需人工复核",
        "human_review_required": "需人工复核",
        "blocked": "阻断",
        "failed": "失败",
        "unknown": "未知",
        "verified": "已核验",
        "unverified": "未核验",
        "check": "需核对",
        "needs source check": "需核对来源",
    }.get(text, text)


def _localized_extraction_confidence(value: Any, language: str) -> str:
    text = str(value or "")
    if not _is_zh_review_language(language):
        return text
    return {"high": "高", "medium": "中等", "low": "低"}.get(text.lower(), text)


def _localized_extraction_bool(value: Any, language: str) -> str:
    if value is None:
        return ""
    if value is True:
        return "是" if _is_zh_review_language(language) else "yes"
    if value is False:
        return "否" if _is_zh_review_language(language) else "no"
    text = str(value or "").strip()
    if not _is_zh_review_language(language):
        return text
    if text.lower() in {"true", "yes"}:
        return "是"
    if text.lower() in {"false", "no"}:
        return "否"
    return text


def _localized_extraction_field_label(value: Any, language: str) -> str:
    text = str(value or "")
    if not _is_zh_review_language(language):
        return text
    key = re.sub(r"[\s\-]+", "_", text.strip().lower())
    return {
        "events_intervention": "干预组事件数",
        "total_intervention": "干预组总数",
        "events_control": "对照组事件数",
        "total_control": "对照组总数",
        "mean_intervention": "干预组均值",
        "sd_intervention": "干预组标准差",
        "n_intervention": "干预组样本量",
        "mean_control": "对照组均值",
        "sd_control": "对照组标准差",
        "n_control": "对照组样本量",
        "median_intervention": "干预组中位数",
        "q1_intervention": "干预组Q1",
        "q3_intervention": "干预组Q3",
        "median_control": "对照组中位数",
        "q1_control": "对照组Q1",
        "q3_control": "对照组Q3",
        "effect_size": "效应量",
        "ci_lower": "置信区间下限",
        "ci_upper": "置信区间上限",
        "p_value": "P值",
        "hazard_ratio": "风险比HR",
        "hr_ci_lower": "HR置信区间下限",
        "hr_ci_upper": "HR置信区间上限",
        "hr_se": "HR标准误",
        "events": "事件数",
        "total_n": "总样本量",
        "correlation_r": "相关系数r",
        "correlation_n": "相关分析样本量",
        "pyears_intervention": "干预组人年",
        "pyears_control": "对照组人年",
        "timepoint": "时间点",
        "accepted_timepoint": "已接受时间点",
        "timepoint_adjudication_note": "时间点裁决说明",
        "source_location": "原文位置",
        "source_page": "原文页码",
        "source_section": "原文章节",
        "source_quote": "原文引用",
        "source_quote_match": "原文匹配片段",
        "source_quote_verified": "引用已核验",
        "extraction_confidence": "提取置信度",
        "row_id": "行ID",
        "study_id": "研究ID",
        "outcome_index": "结局序号",
        "outcome_name": "结局名称",
    }.get(key, text)


def _localized_extraction_field_value(field: Any, value: Any, language: str) -> str:
    text = str(value or "")
    if not _is_zh_review_language(language):
        return text
    key = re.sub(r"[\s\-]+", "_", str(field or "").strip().lower())
    if key == "extraction_confidence":
        return _localized_extraction_confidence(value, language)
    if key == "source_quote_verified":
        return _localized_extraction_bool(value, language)
    return text


def _localized_extraction_source_anchor_kind(value: Any, language: str) -> str:
    text = str(value or "")
    if not _is_zh_review_language(language):
        return text
    return {
        "pdf_text_quote": "PDF原文引用",
        "pdf_location": "PDF位置",
        "text_quote": "文本引用",
        "missing_source": "缺失来源",
    }.get(text, text)


def _localized_extraction_review_reason(value: Any, language: str) -> str:
    text = str(value or "")
    if not _is_zh_review_language(language):
        return text
    return {
        "source_quote_unverified": "原文引用未核验",
        "missing_source_quote": "缺少原文引用",
        "low_confidence": "低置信度",
        "conflicts_present": "存在冲突",
        "count_conflict": "计数冲突",
    }.get(text, text)


def _localized_grade_domain(value: Any, language: str) -> str:
    text = str(value or "")
    if not _is_zh_review_language(language):
        return text
    return {
        "risk_of_bias": "偏倚风险",
        "inconsistency": "不一致性",
        "indirectness": "间接性",
        "imprecision": "不精确性",
        "publication_bias": "发表偏倚",
        "overall": "总体",
    }.get(text.strip().lower(), text)


def _localized_grade_rating(value: Any, language: str) -> str:
    text = str(value or "")
    if not _is_zh_review_language(language):
        return text
    return {
        "none": "无",
        "no concern": "无明显问题",
        "no_concern": "无明显问题",
        "some concern": "有一定疑虑",
        "some_concern": "有一定疑虑",
        "some_concerns": "有一定疑虑",
        "major concern": "重大疑虑",
        "major_concern": "重大疑虑",
        "not_serious": "不严重",
        "no_serious": "不严重",
        "not serious": "不严重",
        "serious": "严重",
        "very_serious": "非常严重",
        "very serious": "非常严重",
        "detected": "已检出",
        "not_detected": "未检出",
        "unclear": "不明确",
        "high": "高",
        "moderate": "中等",
        "low": "低",
        "very_low": "极低",
        "very low": "极低",
    }.get(text.strip().lower(), text)


def _localized_grade_detail_key(value: Any, language: str) -> str:
    text = str(value or "")
    if not _is_zh_review_language(language):
        return text
    return {
        "method": "方法",
        "n_contributing": "贡献研究数",
        "target_outcome": "目标结局",
        "protocol_primary_outcome": "方案主要结局",
        "source_verified_direct_rows": "来源已核验直接证据行数",
        "surrogate_outcome": "替代结局",
    }.get(text.strip().lower(), text)


def _localized_grade_detail_value(key: Any, value: Any, language: str) -> str:
    if isinstance(value, bool):
        return _localized_extraction_bool(value, language)
    text = "" if value is None else str(value)
    if not _is_zh_review_language(language):
        return text
    if str(key or "").strip().lower() == "method":
        return {
            "rule_based_pico_directness_v1": "规则PICO直接性检查",
        }.get(text, text)
    return text


def _localized_grade_dimension_name(value: Any, language: str) -> str:
    text = str(value or "")
    if not _is_zh_review_language(language):
        return text
    return {
        "population": "人群",
        "intervention": "干预",
        "comparator": "比较组",
        "outcome": "结局",
        "design": "研究设计",
        "source": "来源",
    }.get(text.strip().lower(), text)


def _localized_grade_dimension_key(value: Any, language: str) -> str:
    text = str(value or "")
    if not _is_zh_review_language(language):
        return text
    return {
        "mismatch": "不匹配",
        "unverified": "未核验",
        "non_randomized": "非随机研究",
        "total": "总数",
    }.get(text.strip().lower(), text)


def _render_extraction_review_html(review: dict) -> str:
    cards = review.get("extraction_source_cards") or []
    grade_review = review.get("grade_review") or {}
    summary = review.get("summary") or {}
    status = review.get("status") or "unknown"
    report_type = review.get("report_type") or "unknown"
    language = _normalize_review_language(review.get("language") or "")
    zh = _is_zh_review_language(language)
    review_count = sum(1 for card in cards if card.get("requires_review"))

    grade_html = _render_grade_review_html(grade_review, language=language)
    rows_html = "\n".join(_render_source_card_html(card, idx + 1, language=language) for idx, card in enumerate(cards))
    if not rows_html:
        rows_html = (
            '<p class="empty">本项目未生成数据提取来源卡片。</p>'
            if zh else
            '<p class="empty">No extraction source cards were generated for this project.</p>'
        )
    title = "MetaAgent 数据提取复核" if zh else "MetaAgent Extraction Review"
    subtitle = (
        "请在外部使用前，将每个提取值与原文引用和来源上下文逐项核对。"
        if zh else
        "Open this file to review extracted values against source quotes before external use."
    )
    labels = {
        "report_type": "报告类型" if zh else "Report type",
        "readiness": "就绪性" if zh else "Readiness",
        "source_cards": "来源卡片" if zh else "Source cards",
        "review_cards": "需要复核" if zh else "Review cards",
        "source_context": "来源上下文" if zh else "Source context",
        "missing_context": "缺失上下文" if zh else "Missing context",
        "primary_context": "主要结局上下文" if zh else "Primary context",
        "blockers": "阻断项" if zh else "Blockers",
        "warnings": "警告" if zh else "Warnings",
    }

    chips = [
        _stat_chip(labels["report_type"], _localized_extraction_report_type(report_type, language)),
        _stat_chip(labels["readiness"], _localized_extraction_status(status, language)),
        _stat_chip(labels["source_cards"], len(cards)),
        _stat_chip(labels["review_cards"], review_count),
        _stat_chip(labels["source_context"], f"{summary.get('source_context_available_cards', 0)}/{summary.get('extraction_source_cards', len(cards))}"),
        _stat_chip(labels["missing_context"], summary.get("source_context_missing_cards", 0)),
        _stat_chip(labels["primary_context"], f"{summary.get('selected_primary_source_context_available_cards', 0)}/{summary.get('selected_primary_source_cards', 0)}"),
        _stat_chip(labels["blockers"], summary.get("blockers", 0)),
        _stat_chip(labels["warnings"], summary.get("warnings", 0)),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
    {grade_html}
    {rows_html}
  </main>"""
    return _render_page(title=title, body=body, lang=_html_lang(language), extra_css=_EXTRACTION_REVIEW_EXTRA_CSS)


def _render_grade_review_html(grade_review: dict, *, language: str = "en") -> str:
    outcomes = grade_review.get("outcomes") or []
    if not outcomes:
        return ""
    summary = grade_review.get("summary") or {}
    zh = _is_zh_review_language(language)
    outcome_html = "\n".join(_render_grade_outcome_html(outcome, language=language) for outcome in outcomes)
    title = "GRADE质量复核" if zh else "GRADE Quality Review"
    desc = (
        "这里展示结局证据确定性和各GRADE域判断，便于复核稿件为何上调或下调证据质量。"
        if zh else
        "Outcome certainty and domain-level quality judgments are shown here so reviewers can inspect why the manuscript rated evidence up or down."
    )
    outcome_label = "GRADE结局" if zh else "GRADE outcomes"
    domain_label = "GRADE域" if zh else "GRADE domains"
    detailed_label = "有细节的域" if zh else "Domains with details"
    return f"""
<section class="panel">
  <h2>{escape(title)}</h2>
  <p class="meta">{escape(desc)}</p>
  <div class="stats">
    <span class="stat">{outcome_label}: {escape(str(summary.get("outcomes", len(outcomes))))}</span>
    <span class="stat">{domain_label}: {escape(str(summary.get("domains", 0)))}</span>
    <span class="stat">{detailed_label}: {escape(str(summary.get("domains_with_details", 0)))}</span>
  </div>
  {outcome_html}
</section>
"""


def _render_grade_outcome_html(outcome: dict, *, language: str = "en") -> str:
    zh = _is_zh_review_language(language)
    domain_rows = "\n".join(_render_grade_domain_row(domain, language=language) for domain in outcome.get("domains") or [])
    if not domain_rows:
        domain_rows = (
            '<tr><td colspan="5" class="empty">未记录GRADE域。</td></tr>'
            if zh else
            '<tr><td colspan="5" class="empty">No GRADE domains were recorded.</td></tr>'
        )
    certainty_label = "证据确定性" if zh else "Certainty"
    studies_label = "研究数" if zh else "Studies"
    effect_label = "效应" if zh else "Effect"
    headers = ["域", "评级", "理由", "规则细节", "维度"] if zh else ["Domain", "Rating", "Rationale", "Rule details", "Dimensions"]
    return f"""
  <div class="outcome-panel">
    <div class="section-title">{escape(str(outcome.get("outcome_name") or "Untitled outcome"))}</div>
    <div class="meta">{certainty_label}: {escape(str(outcome.get("certainty") or ""))} | {studies_label}: {escape(str(outcome.get("n_studies") or ""))} | {effect_label}: {escape(str(outcome.get("effect_summary") or ""))}</div>
    <table>
      <thead><tr><th>{headers[0]}</th><th>{headers[1]}</th><th>{headers[2]}</th><th>{headers[3]}</th><th>{headers[4]}</th></tr></thead>
      <tbody>{domain_rows}</tbody>
    </table>
  </div>
"""


def _render_grade_domain_row(domain: dict, *, language: str = "en") -> str:
    details = domain.get("details") if isinstance(domain.get("details"), dict) else {}
    detail_bits = []
    for key in ("method", "n_contributing", "target_outcome", "protocol_primary_outcome", "source_verified_direct_rows", "surrogate_outcome"):
        if key in details:
            detail_bits.append(
                f"{_localized_grade_detail_key(key, language)}: "
                f"{_localized_grade_detail_value(key, details.get(key), language)}"
            )
    dimensions = details.get("dimensions") if isinstance(details.get("dimensions"), dict) else {}
    dimension_html = _render_grade_dimensions(dimensions, language=language)
    return (
        "<tr>"
        f"<td>{escape(_localized_grade_domain(domain.get('domain') or '', language))}</td>"
        f"<td>{escape(_localized_grade_rating(domain.get('rating') or '', language))}</td>"
        f"<td>{escape(str(domain.get('rationale') or ''))}</td>"
        f"<td>{escape('; '.join(str(item) for item in detail_bits))}</td>"
        f"<td>{dimension_html}</td>"
        "</tr>"
    )


def _render_grade_dimensions(dimensions: dict, *, language: str = "en") -> str:
    empty = "无维度细节" if _is_zh_review_language(language) else "No dimension details"
    if not dimensions:
        return f'<span class="empty">{empty}</span>'
    rows = []
    for name, values in dimensions.items():
        if not isinstance(values, dict):
            continue
        bits = []
        for key in ("mismatch", "unverified", "non_randomized", "total"):
            if key in values:
                bits.append(
                    f"{_localized_grade_dimension_key(key, language)}: "
                    f"{_localized_grade_detail_value(key, values.get(key), language)}"
                )
        rows.append(
            f"<div><strong>{escape(_localized_grade_dimension_name(name, language))}</strong>"
            f" &mdash; {escape(', '.join(str(bit) for bit in bits))}</div>"
        )
    return "".join(rows) if rows else f'<span class="empty">{empty}</span>'


def _render_source_card_html(card: dict, idx: int, *, language: str = "en") -> str:
    study = card.get("study") or {}
    outcome = card.get("outcome") or {}
    source = card.get("source") or {}
    source_anchor = card.get("source_anchor") or {}
    trust = card.get("trust") or {}
    title = study.get("title") or study.get("label") or card.get("study_id") or "Untitled study"
    outcome_name = outcome.get("name") or "Untitled outcome"
    verified = source.get("quote_verified")
    trust_status = str(trust.get("status") or "")
    status_class = "ok" if trust_status == "verified" or (verified is True and not card.get("requires_review")) else "warn"
    if trust_status == "needs_review" or verified is False:
        status_class = "bad"
    status_label = trust_status or ("verified" if verified is True else "unverified" if verified is False else "needs source check")
    status_label = _localized_extraction_status(status_label, language)
    if card.get("requires_review"):
        status_label = f"{status_label}；需复核" if _is_zh_review_language(language) else f"{status_label}; review"
    values_html = _render_values_table(card.get("values") or [], language=language)
    conflicts_html = _render_conflicts(card.get("conflicts") or [], language=language)
    source_context_html = _render_source_context_html(card.get("source_context") or {}, language=language)
    zh = _is_zh_review_language(language)
    labels = {
        "values": "提取值" if zh else "Extracted Values",
        "source": "来源" if zh else "Source",
        "location": "位置" if zh else "Location",
        "page": "页码" if zh else "Page",
        "section": "章节" if zh else "Section",
        "trust": "信任状态" if zh else "Trust status",
        "confidence": "置信度" if zh else "Confidence",
        "quote_verified": "引用已核验" if zh else "Quote verified",
        "source_anchor": "来源定位" if zh else "Source anchor",
        "open_pdf": "打开PDF" if zh else "Open PDF",
        "highlight": "高亮" if zh else "Highlight",
        "review_reasons": "复核原因" if zh else "Review Reasons",
        "decision_payload": "复核决定载荷种子" if zh else "Review Decision Payload Seed",
        "confirm": "确认该行前，请逐项核对每个提取值与展示的原文引用是否一致。" if zh else "Confirm this row after checking every extracted value against the displayed source quote.",
        "override_payload": "修正载荷种子" if zh else "Override Payload Seed",
        "pdf_path": "PDF路径" if zh else "PDF path",
    }
    review_action = card.get("review_action") or {}
    review_payload = {
        "type": review_action.get("save_message_type", "extraction_review_decision"),
        "expected_revision": review_action.get("current_revision"),
        "project_dir": "<project_dir>",
        "decision": review_action.get("suggested_decision") or {
            "row_id": card.get("row_id"),
            "study_id": card.get("study_id"),
            "outcome_index": card.get("outcome_index"),
            "outcome_name": outcome_name,
            "decision": "accepted",
            "note": "Reviewer confirmed extracted values against the displayed source quote.",
            "resolves_review": True,
            "resolves_conflicts": True,
        },
    }
    override_payload = {
        "type": (card.get("override") or {}).get("save_message_type", "extraction_override"),
        "expected_revision": (card.get("override") or {}).get("current_revision"),
        "project_dir": "<project_dir>",
        "overrides": [
            value.get("suggested_override")
            for value in card.get("values") or []
            if value.get("suggested_override")
        ],
    }
    return f"""
<details class="card" {"open" if card.get("requires_review") else ""}>
  <summary>
    <span class="idx">#{idx}</span>
    <span>
      <span class="title">{escape(str(title))}</span><br>
      <span class="meta">PMID {escape(str(study.get("pmid") or card.get("study_id") or ""))} | DOI {escape(str(study.get("doi") or ""))}</span>
    </span>
    <span>
      <span class="title">{escape(str(outcome_name))}</span><br>
      <span class="meta">{escape(str(outcome.get("type") or ""))} {escape(str(outcome.get("accepted_timepoint") or outcome.get("timepoint") or ""))}</span>
    </span>
    <span class="status badge {status_class}">{escape(status_label)}</span>
  </summary>
  <div class="body">
    <div class="grid">
      <section>
        <div class="section-title">{labels["values"]}</div>
        {values_html}
      </section>
      <section>
        <div class="section-title">{labels["source"]}</div>
        <div class="meta">{labels["location"]}: {escape(str(source.get("location") or ""))} | {labels["page"]}: {escape(str(source.get("page") or ""))} | {labels["section"]}: {escape(str(source.get("section") or ""))}</div>
        <div class="meta">{labels["trust"]}: {escape(_localized_extraction_status(trust.get("status") or "", language))} | {labels["confidence"]}: {escape(_localized_extraction_confidence(trust.get("confidence") or card.get("confidence") or "", language))} | {labels["quote_verified"]}: {escape(_localized_extraction_bool(trust.get("quote_verified") if "quote_verified" in trust else source.get("quote_verified"), language))}</div>
        <div class="meta">{labels["source_anchor"]}: {escape(_localized_extraction_source_anchor_kind(source_anchor.get("kind") or "", language))} | {labels["open_pdf"]}: {escape(str(source_anchor.get("pdf_path") or study.get("pdf_path") or ""))}</div>
        <div class="meta">{labels["highlight"]}: {escape(str(source_anchor.get("highlight_text") or source.get("quote_match") or source.get("quote") or ""))}</div>
        <blockquote>{escape(str(source.get("quote") or ""))}</blockquote>
        {source_context_html}
        <div class="section-title">{labels["review_reasons"]}</div>
        <div>{_render_badges(card.get("review_reasons") or [], language=language)}</div>
      </section>
    </div>
    {conflicts_html}
    <div class="section-title">{labels["decision_payload"]}</div>
    <div class="meta">{labels["confirm"]}</div>
    <pre>{escape(json.dumps(review_payload, indent=2, ensure_ascii=False, default=str))}</pre>
    <div class="section-title">{labels["override_payload"]}</div>
    <pre>{escape(json.dumps(override_payload, indent=2, ensure_ascii=False, default=str))}</pre>
    <div class="meta">{labels["pdf_path"]}: {escape(str(study.get("pdf_path") or ""))}</div>
  </div>
</details>
"""


def _render_source_context_html(context: dict, *, language: str = "en") -> str:
    if not context or not context.get("available"):
        return ""
    zh = _is_zh_review_language(language)
    source_file = context.get("source_file") or ""
    page = context.get("page") or ""
    prefix = escape(str(context.get("prefix") or ""))
    match = escape(str(context.get("match_text") or ""))
    suffix = escape(str(context.get("suffix") or ""))
    title = "来源上下文" if zh else "Source Context"
    source_file_label = "来源文件" if zh else "Source file"
    page_label = "页码" if zh else "Page"
    return f"""
        <div class="section-title">{title}</div>
        <div class="meta">{source_file_label}: {escape(str(source_file))} | {page_label}: {escape(str(page))}</div>
        <div class="source-context">{prefix}<mark>{match}</mark>{suffix}</div>
"""


def _render_values_table(values: list[dict], *, language: str = "en") -> str:
    zh = _is_zh_review_language(language)
    if not values:
        return '<p class="empty">该行未记录结构化提取值。</p>' if zh else '<p class="empty">No structured values were recorded for this row.</p>'
    rows = []
    for value in values:
        conflicts = value.get("conflicts") or []
        field = value.get("field") or value.get("label") or ""
        rows.append(
            "<tr>"
            f"<td>{escape(_localized_extraction_field_label(value.get('label') or field, language))}</td>"
            f"<td>{escape(_localized_extraction_field_value(field, value.get('value'), language))}</td>"
            f"<td>{escape(_localized_extraction_confidence(value.get('extraction_confidence') or '', language))}</td>"
            f"<td>{escape(_localized_extraction_bool(value.get('source_quote_verified'), language))}</td>"
            f"<td>{escape('; '.join(str(item.get('message') or '') for item in conflicts))}</td>"
            "</tr>"
        )
    return (
        (
            "<table><thead><tr><th>字段</th><th>值</th><th>置信度</th>"
            "<th>引用</th><th>冲突</th></tr></thead><tbody>"
            if zh else
            "<table><thead><tr><th>Field</th><th>Value</th><th>Confidence</th>"
            "<th>Quote</th><th>Conflict</th></tr></thead><tbody>"
        )
        + "".join(rows)
        + "</tbody></table>"
    )


def _render_conflicts(conflicts: list[dict], *, language: str = "en") -> str:
    if not conflicts:
        return ""
    items = "".join(
        f"<li><strong>{escape(_localized_extraction_field_label(item.get('field') or 'row', language))}</strong>: {escape(str(item.get('message') or ''))}</li>"
        for item in conflicts
    )
    title = "冲突" if _is_zh_review_language(language) else "Conflicts"
    return f'<div class="section-title">{title}</div><ul>{items}</ul>'


def _render_badges(items: list[str], *, language: str = "en") -> str:
    if not items:
        empty = "无" if _is_zh_review_language(language) else "none"
        return f'<span class="badge ok">{empty}</span>'
    return " ".join(
        f'<span class="badge warn">{escape(_localized_extraction_review_reason(item, language))}</span>'
        for item in items
    )


def _selected_rows_by_id(readiness: dict) -> dict[str, dict]:
    return {
        str(row.get("row_id") or ""): row
        for row in readiness.get("selected_primary_rows") or []
        if row.get("row_id")
    }


def _rows_for_timepoint_adjudication(readiness: dict) -> list[dict]:
    selected_by_id = _selected_rows_by_id(readiness)
    issues_by_row: dict[str, list[dict]] = {}
    for issue in list(readiness.get("blockers") or []) + list(readiness.get("warnings") or []):
        if issue.get("code") not in {"primary_timepoint_not_source_verified", "primary_timepoint_adjudicated"}:
            continue
        row_id = str(issue.get("row_id") or "")
        if row_id:
            issues_by_row.setdefault(row_id, []).append(issue)
    rows = []
    for row_id, issues in issues_by_row.items():
        selected = selected_by_id.get(row_id, {})
        blocking = any(issue.get("code") == "primary_timepoint_not_source_verified" for issue in issues)
        rows.append({
            "row_id": row_id,
            "study_id": selected.get("study_id") or "",
            "outcome_name": selected.get("outcome_name") or "",
            "source_location": selected.get("source_location") or "",
            "source_quote": selected.get("source_quote") or "",
            "accepted_timepoint": selected.get("accepted_timepoint") or "",
            "timepoint_adjudication_note": selected.get("timepoint_adjudication_note") or "",
            "requires_user_adjudication": blocking,
            "status": "blocked" if blocking else "adjudicated",
            "issues": issues,
            "suggested_overrides": [
                {
                    "field": "timepoint_adjudication_note",
                    "value": "Accepted closest available primary timepoint after user/protocol review.",
                },
                {
                    "field": "accepted_timepoint",
                    "value": selected.get("timepoint") or selected.get("outcome_name") or "",
                },
            ],
        })
    return rows


def _rows_for_primary_count_verification(readiness: dict) -> list[dict]:
    selected_by_id = _selected_rows_by_id(readiness)
    rows = []
    for issue in readiness.get("blockers") or []:
        if issue.get("code") != "primary_counts_not_source_verified":
            continue
        row_id = str(issue.get("row_id") or "")
        if not row_id:
            continue
        selected = selected_by_id.get(row_id, {})
        rows.append({
            "row_id": row_id,
            "study_id": selected.get("study_id") or "",
            "outcome_name": selected.get("outcome_name") or "",
            "source_location": selected.get("source_location") or "",
            "source_quote": selected.get("source_quote") or "",
            "events_intervention": selected.get("events_intervention"),
            "total_intervention": selected.get("total_intervention"),
            "events_control": selected.get("events_control"),
            "total_control": selected.get("total_control"),
            "missing_values": issue.get("missing_values") or [],
            "requires_user_count_source_verification": True,
            "issue": issue,
            "suggested_overrides": [
                {
                    "field": "source_quote",
                    "value": selected.get("source_quote") or "",
                    "instruction": "Replace with the exact table/text quote containing all four arm-level counts.",
                },
                {
                    "field": "source_location",
                    "value": selected.get("source_location") or "",
                    "instruction": "Point to the table, figure, page, or paragraph containing all four counts.",
                },
            ],
        })
    return rows
