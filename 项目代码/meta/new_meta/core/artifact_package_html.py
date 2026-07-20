"""HTML renderers for artifact-package review reports."""
from __future__ import annotations

from html import escape
from typing import Any

from new_meta.core.artifact_package_diagnostics import (
    _format_count_pair,
    _format_review_number,
)
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


_CLINICAL_INTERPRETATION_DOMAIN_LABELS = {
    "result_context": ("Result magnitude and direction", "结果大小和方向"),
    "absolute_risk_translation": ("Absolute risk translation", "绝对风险转换"),
    "endpoint_meaning": ("Endpoint meaning and components", "终点含义和组成"),
    "benefit_harm_safety": ("Benefit-harm and safety", "获益风险和安全性"),
    "applicability_subgroups": ("Applicability and subgroups", "适用性和亚组"),
    "implementation_followup": ("Implementation and follow-up", "实施和随访"),
    "certainty_limitations": ("Certainty and limitations", "证据确定性和局限性"),
}

# Per-renderer supplementary CSS blocks, appended after the shared report style.
_OVERFLOW_WRAP_CSS = "th, td { overflow-wrap: anywhere; }"
_CODE_PRE_WRAP_CSS = "code { white-space: pre-wrap; overflow-wrap: anywhere; }"
_LEGACY_PASS_GREEN_CSS = ":root { --ok: #027a48; }"
_SOURCE_TRACE_CSS = """
    main { max-width: 1240px; }
    th, td { overflow-wrap: anywhere; }
    .quote { max-width: 420px; }"""


def _render_abstract_audit_html(audit: dict) -> str:
    summary = audit.get("summary") or {}
    label_rows = "\n".join(_render_abstract_label_row(field) for field in audit.get("label_fields") or [])
    if not label_rows:
        label_rows = '<tr><td colspan="2">No structured abstract labels were checked.</td></tr>'
    issue_rows = "\n".join(_render_abstract_issue_row(issue) for issue in audit.get("issues") or [])
    if not issue_rows:
        issue_rows = '<tr><td colspan="4">No abstract polish issues were recorded.</td></tr>'
    issue_title = (
        "<h2>Abstract Polish Issue</h2>"
        "<p>The abstract contains internal review wording that should stay in supplementary audit files, not the manuscript abstract.</p>"
        if int(summary.get("failed_issues") or 0)
        else ""
    )
    title = "MetaAgent Abstract Audit"
    subtitle = "Checks whether the manuscript abstract is publication-facing and free of internal review notes."
    chips = [
        _stat_chip("Present", bool(summary.get("abstract_present"))),
        _stat_chip("Words", summary.get("word_count", 0)),
        _stat_chip("Labels", f"{summary.get('present_labels', 0)}/{summary.get('required_labels', 0)}"),
        _stat_chip("Forbidden phrases", summary.get("forbidden_phrase_count", 0)),
        _stat_chip("Failed issues", summary.get("failed_issues", 0)),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
    {issue_title}
{_panel("Structured Labels", _data_table(["Label", "Present"], label_rows))}
{_panel("Issues", _data_table(["Severity", "Code", "Matched text", "Excerpt"], issue_rows))}
  </main>"""
    return _render_page(title=title, body=body)


def _render_abstract_label_row(field: dict[str, Any]) -> str:
    present = bool(field.get("present"))
    return (
        "<tr>"
        f"<td>{escape(str(field.get('label') or ''))}</td>"
        f"<td class=\"{'pass' if present else 'fail'}\">{escape(str(present))}</td>"
        "</tr>"
    )


def _render_abstract_issue_row(issue: dict[str, Any]) -> str:
    return (
        "<tr>"
        f"<td class=\"fail\">{escape(str(issue.get('severity') or ''))}</td>"
        f"<td>{escape(str(issue.get('code') or ''))}</td>"
        f"<td>{escape(str(issue.get('matched_text') or issue.get('label') or ''))}</td>"
        f"<td>{escape(str(issue.get('excerpt') or issue.get('message') or ''))}</td>"
        "</tr>"
    )


def _render_publication_tone_audit_html(audit: dict) -> str:
    summary = audit.get("summary") or {}
    language = _normalize_review_language(audit.get("language") or "")
    zh = _is_zh_review_language(language)
    issue_rows = "\n".join(_render_publication_tone_issue_row(issue, language) for issue in audit.get("issues") or [])
    if not issue_rows:
        empty_issues = "未记录投稿语气问题。" if zh else "No publication-tone issues were recorded."
        issue_rows = f'<tr><td colspan="4">{empty_issues}</td></tr>'
    if int(summary.get("failed_issues") or 0):
        issue_title = (
            "<h2>投稿语气问题</h2>"
            "<p>主稿正文包含内部或工程化措辞，外部使用前应改写为正式投稿语言。</p>"
        ) if zh else (
            "<h2>Publication Tone Issue</h2>"
            "<p>The main manuscript body contains internal review or engineering wording that should be rewritten before external use.</p>"
        )
    else:
        issue_title = ""
    title = "MetaAgent 投稿语气审计" if zh else "MetaAgent Publication Tone Audit"
    subtitle = (
        "检查主稿正文中是否残留内部系统、工程或复核流程用语。"
        if zh else
        "Checks the main manuscript body for internal system wording before supplementary appendices."
    )
    stat_labels = {
        "scanned_words": "扫描词数" if zh else "Scanned words",
        "forbidden_phrases": "禁用短语" if zh else "Forbidden phrases",
        "failed_issues": "失败问题" if zh else "Failed issues",
    }
    issue_heading = "问题" if zh else "Issues"
    issue_headers = (
        ["严重性", "标签", "命中文本", "上下文"]
        if zh else
        ["Severity", "Label", "Matched text", "Excerpt"]
    )
    chips = [
        _stat_chip(stat_labels["scanned_words"], summary.get("scanned_word_count", 0)),
        _stat_chip(stat_labels["forbidden_phrases"], summary.get("forbidden_phrase_count", 0)),
        _stat_chip(stat_labels["failed_issues"], summary.get("failed_issues", 0)),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
    {issue_title}
{_panel(issue_heading, _data_table(issue_headers, issue_rows))}
  </main>"""
    return _render_page(title=title, body=body, lang=_html_lang(language))


def _render_publication_tone_issue_row(issue: dict[str, Any], language: str = "en") -> str:
    return (
        "<tr>"
        f"<td class=\"fail\">{escape(_localized_publication_tone_severity(str(issue.get('severity') or ''), language))}</td>"
        f"<td>{escape(_localized_publication_tone_label(str(issue.get('label') or issue.get('code') or ''), language))}</td>"
        f"<td>{escape(str(issue.get('matched_text') or ''))}</td>"
        f"<td>{escape(str(issue.get('excerpt') or issue.get('message') or ''))}</td>"
        "</tr>"
    )


def _localized_publication_tone_severity(severity: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return severity
    return {"fail": "失败", "warn": "警告"}.get(severity, severity)


def _localized_publication_tone_label(label: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return label
    return {
        "English evidence-readiness heading": "英文证据就绪标题",
        "English audit trail wording": "英文审计轨迹措辞",
        "English structured-data-file wording": "英文结构化数据文件措辞",
        "English internal-consistency wording": "英文内部一致性措辞",
        "Chinese fact-locked wording": "中文事实锁定措辞",
        "Chinese structured-data-file wording": "中文结构化数据文件措辞",
        "Chinese auditability wording": "中文可审计性措辞",
        "Chinese workflow wording": "中文工作流措辞",
        "publication_internal_tone": "内部投稿语气问题",
    }.get(label, label)


def _render_clinical_interpretation_audit_html(audit: dict) -> str:
    summary = audit.get("summary") or {}
    language = _normalize_review_language(audit.get("language") or "")
    zh = _is_zh_review_language(language)
    domain_rows = "\n".join(_render_clinical_interpretation_domain_row(row, language) for row in audit.get("domain_rows") or [])
    if not domain_rows:
        domain_rows = '<tr><td colspan="4">未检查临床解释维度。</td></tr>' if zh else '<tr><td colspan="4">No clinical interpretation domains were checked.</td></tr>'
    issue_rows = "\n".join(_render_clinical_interpretation_issue_row(issue, language) for issue in audit.get("issues") or [])
    if not issue_rows:
        issue_rows = '<tr><td colspan="4">未记录临床解释问题。</td></tr>' if zh else '<tr><td colspan="4">No clinical interpretation issues were recorded.</td></tr>'
    issue_title = (
        "<h2>临床解释问题</h2><p>讨论或结论没有覆盖足够的临床解释维度，容易退化为过程说明或结果复述。</p>"
        if zh else
        "<h2>Clinical Interpretation Issue</h2><p>Discussion or Conclusion does not cover enough clinical interpretation domains for a submission-facing manuscript.</p>"
    ) if int(summary.get("failed_issues") or 0) else ""
    title = "MetaAgent 临床解释审计" if zh else "MetaAgent Clinical Interpretation Audit"
    subtitle = (
        "检查讨论和结论是否解释结果大小、绝对获益、终点含义、安全性、适用性、实施和证据确定性。"
        if zh else
        "Checks whether Discussion and Conclusion interpret the result through clinical decision-making domains."
    )
    labels = {
        "covered": "已覆盖维度" if zh else "Covered domains",
        "minimum": "最低要求" if zh else "Minimum",
        "result_context": "结果解释" if zh else "Result context",
        "failed": "失败问题" if zh else "Failed issues",
        "domains": "临床解释维度" if zh else "Clinical Interpretation Domains",
        "domain": "维度" if zh else "Domain",
        "status": "状态" if zh else "Status",
        "matched": "命中文本" if zh else "Matched text",
        "excerpt": "上下文" if zh else "Excerpt",
        "issues": "问题" if zh else "Issues",
        "severity": "严重性" if zh else "Severity",
        "code": "代码" if zh else "Code",
        "message": "信息" if zh else "Message",
    }
    chips = [
        _stat_chip(labels["covered"], f"{summary.get('covered_domains', 0)}/{summary.get('domain_count', 0)}"),
        _stat_chip(labels["minimum"], summary.get("minimum_domains", 0)),
        _stat_chip(labels["result_context"], bool(summary.get("result_context_present"))),
        _stat_chip(
            "讨论段落" if zh else "Discussion paragraphs",
            f"{summary.get('discussion_paragraph_count', 0)}/{summary.get('maximum_discussion_paragraphs', 0)}",
        ),
        _stat_chip("流程化段落" if zh else "Process-framed paragraphs", summary.get("process_framing_paragraphs", 0)),
        _stat_chip("重复主题" if zh else "Redundant domains", summary.get("redundant_domain_count", 0)),
        _stat_chip(labels["failed"], summary.get("failed_issues", 0)),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
    {issue_title}
{_panel(labels["domains"], _data_table([labels["domain"], labels["status"], labels["matched"], labels["excerpt"]], domain_rows))}
{_panel(labels["issues"], _data_table([labels["severity"], labels["code"], labels["domain"], labels["message"]], issue_rows))}
  </main>"""
    return _render_page(title=title, body=body, lang=_html_lang(language))


def _render_clinical_interpretation_domain_row(row: dict[str, Any], language: str = "en") -> str:
    covered = bool(row.get("covered"))
    first_match = (row.get("matches") or [{}])[0] if row.get("matches") else {}
    status = "已覆盖" if _is_zh_review_language(language) and covered else "缺失" if _is_zh_review_language(language) else str(covered)
    return (
        "<tr>"
        f"<td>{escape(str(row.get('label') or row.get('domain') or ''))}</td>"
        f"<td class=\"{'pass' if covered else 'fail'}\">{escape(status)}</td>"
        f"<td>{escape(str(first_match.get('matched_text') or ''))}</td>"
        f"<td>{escape(str(first_match.get('excerpt') or ''))}</td>"
        "</tr>"
    )


def _render_clinical_interpretation_issue_row(issue: dict[str, Any], language: str = "en") -> str:
    missing = issue.get("missing_domains") or []
    if missing:
        labels = [
            (_CLINICAL_INTERPRETATION_DOMAIN_LABELS.get(str(domain), (str(domain), str(domain)))[1 if _is_zh_review_language(language) else 0])
            for domain in missing
        ]
        message = f"{issue.get('message') or ''} Missing: {', '.join(labels)}"
    else:
        message = str(issue.get("message") or "")
    return (
        "<tr>"
        f"<td class=\"fail\">{escape(str(issue.get('severity') or ''))}</td>"
        f"<td>{escape(str(issue.get('code') or ''))}</td>"
        f"<td>{escape(str(issue.get('section') or ''))}</td>"
        f"<td>{escape(message)}</td>"
        "</tr>"
    )


def _render_readability_audit_html(audit: dict) -> str:
    summary = audit.get("summary") or {}
    issue_rows = "\n".join(_render_readability_issue_row(issue) for issue in audit.get("issues") or [])
    if not issue_rows:
        issue_rows = '<tr><td colspan="5">No readability issues were recorded.</td></tr>'
    issue_title = (
        "<h2>Readability Issue</h2>"
        "<p>Interpretive sections contain verbose eligibility fragments or overlong clinical-reasoning sentences that should be shortened outside Methods.</p>"
        if int(summary.get("failed_issues") or 0)
        else ""
    )
    title = "MetaAgent Readability Audit"
    subtitle = "Checks interpretive manuscript sections for verbose protocol fragments and overlong clinical-reasoning sentences."
    chips = [
        _stat_chip("Scanned sections", summary.get("scanned_sections", 0)),
        _stat_chip("Scanned words", summary.get("scanned_word_count", 0)),
        _stat_chip("Verbose PICO fragments", summary.get("verbose_pico_fragments", 0)),
        _stat_chip("Overlong sentences", summary.get("overlong_sentences", 0)),
        _stat_chip("Failed issues", summary.get("failed_issues", 0)),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
    {issue_title}
{_panel("Issues", _data_table(["Severity", "Section", "Label", "Matched text", "Excerpt"], issue_rows))}
  </main>"""
    return _render_page(title=title, body=body)


def _render_readability_issue_row(issue: dict[str, Any]) -> str:
    return (
        "<tr>"
        f"<td class=\"fail\">{escape(str(issue.get('severity') or ''))}</td>"
        f"<td>{escape(str(issue.get('section') or ''))}</td>"
        f"<td>{escape(str(issue.get('label') or issue.get('code') or ''))}</td>"
        f"<td>{escape(str(issue.get('matched_text') or ''))}</td>"
        f"<td>{escape(str(issue.get('excerpt') or issue.get('message') or ''))}</td>"
        "</tr>"
    )


def _render_reference_audit_html(audit: dict) -> str:
    summary = audit.get("summary") or {}
    entries = audit.get("entries") or []
    issues = audit.get("issues") or []
    language = _normalize_review_language(audit.get("language") or "")
    zh = _is_zh_review_language(language)
    issue_rows = "\n".join(_render_reference_issue_row(issue, language) for issue in issues)
    if not issue_rows:
        empty_issues = "未记录参考文献审计问题。" if zh else "No reference audit issues were recorded."
        issue_rows = f'<tr><td colspan="4">{empty_issues}</td></tr>'
    entry_rows = "\n".join(_render_reference_entry_row(entry, language=language) for entry in entries)
    if not entry_rows:
        empty_entries = "未解析到 BibTeX 参考文献条目。" if zh else "No BibTeX reference entries were parsed."
        entry_rows = f'<tr><td colspan="9">{empty_entries}</td></tr>'
    if summary.get("count_mismatch"):
        mismatch_title = (
            "<h2>参考文献数量不一致</h2>"
            "<p>稿件编号参考文献清单与 references.bib 的条目数不同，投稿前必须先对齐。</p>"
        ) if zh else (
            "<h2>Reference Count Mismatch</h2>"
            "<p>The numbered manuscript reference list and references.bib must be reconciled before submission.</p>"
        )
    else:
        mismatch_title = ""
    title = "MetaAgent 参考文献审计" if zh else "MetaAgent Reference Audit"
    subtitle = (
        "核对稿件参考文献清单与打包的 BibTeX 文献库是否一致。"
        if zh else
        "Checks manuscript references against the packaged BibTeX bibliography."
    )
    stat_labels = {
        "manuscript_references": "稿件参考文献" if zh else "Manuscript references",
        "bib_entries": "BibTeX条目" if zh else "BibTeX entries",
        "count_mismatch": "数量不一致" if zh else "Count mismatch",
        "entries_missing_identifier": "缺失标识符" if zh else "Missing identifiers",
        "entries_missing_journal": "缺失期刊" if zh else "Missing journals",
        "entries_missing_volume_or_pages": "缺失卷/页码" if zh else "Missing volume/pages",
        "very_long_author_entries": "超长作者列表" if zh else "Long author lists",
        "registry_entries": "注册来源" if zh else "Registry sources",
    }
    issue_heading = "问题" if zh else "Issues"
    entry_heading = "参考文献条目" if zh else "BibTeX Entries"
    issue_headers = (
        ["严重性", "代码", "参考文献", "说明"]
        if zh else
        ["Severity", "Code", "Reference", "Message"]
    )
    entry_headers = (
        ["键", "类型", "题名", "期刊", "卷/页码", "来源类型", "DOI", "PMID", "URL"]
        if zh else
        ["Key", "Type", "Title", "Journal", "Volume/pages", "Source type", "DOI", "PMID", "URL"]
    )
    chips = [
        _stat_chip(stat_labels["manuscript_references"], summary.get("manuscript_references", 0)),
        _stat_chip(stat_labels["bib_entries"], summary.get("bib_entries", 0)),
        _stat_chip(stat_labels["count_mismatch"], _localized_reference_bool(bool(summary.get("count_mismatch")), language)),
        _stat_chip(stat_labels["entries_missing_identifier"], summary.get("entries_missing_identifier", 0)),
        _stat_chip(stat_labels["entries_missing_journal"], summary.get("entries_missing_journal", 0)),
        _stat_chip(stat_labels["entries_missing_volume_or_pages"], summary.get("entries_missing_volume_or_pages", 0)),
        _stat_chip(stat_labels["very_long_author_entries"], summary.get("very_long_author_entries", 0)),
        _stat_chip(stat_labels["registry_entries"], summary.get("registry_entries", 0)),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
    {mismatch_title}
{_panel(issue_heading, _data_table(issue_headers, issue_rows))}
{_panel(entry_heading, _data_table(entry_headers, entry_rows))}
  </main>"""
    return _render_page(title=title, body=body, lang=_html_lang(language))


def _truncate_review_cell(text: str, max_chars: int = 420) -> str:
    clean = str(text or "").strip()
    if len(clean) <= max_chars:
        return clean
    return clean[: max_chars - 1].rstrip() + "..."


def _render_prisma_audit_html(audit: dict) -> str:
    summary = audit.get("summary") or {}
    fields = audit.get("fields") or []
    issues = audit.get("issues") or []
    field_rows = "\n".join(_render_prisma_field_row(field) for field in fields)
    if not field_rows:
        field_rows = '<tr><td colspan="5">No PRISMA fields were available for audit.</td></tr>'
    issue_rows = "\n".join(_render_prisma_issue_row(issue) for issue in issues)
    if not issue_rows:
        issue_rows = '<tr><td colspan="4">No PRISMA flow issues were recorded.</td></tr>'
    mismatch_title = (
        "<h2>PRISMA Flow Mismatch</h2>"
        "<p>The manuscript PRISMA narrative does not match prisma_flow.json.</p>"
        if int(summary.get("mismatched_fields") or 0) or int(summary.get("missing_fields") or 0) or int(summary.get("logical_issues") or 0)
        else ""
    )
    title = "MetaAgent PRISMA Audit"
    subtitle = "Checks manuscript PRISMA flow numbers against prisma_flow.json."
    chips = [
        _stat_chip("Expected fields", summary.get("expected_fields", 0)),
        _stat_chip("Matched", summary.get("matched_fields", 0)),
        _stat_chip("Mismatched", summary.get("mismatched_fields", 0)),
        _stat_chip("Missing", summary.get("missing_fields", 0)),
        _stat_chip("Logical issues", summary.get("logical_issues", 0)),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
    {mismatch_title}
{_panel("Fields", _data_table(["Field", "Expected", "Reported values", "Matched", "Status"], field_rows))}
{_panel("Issues", _data_table(["Severity", "Code", "Field", "Message"], issue_rows))}
  </main>"""
    return _render_page(title=title, body=body)


def _render_search_strategy_audit_html(audit: dict) -> str:
    summary = audit.get("summary") or {}
    issues = audit.get("issues") or []
    issue_rows = "\n".join(_render_search_strategy_issue_row(issue) for issue in issues)
    if not issue_rows:
        issue_rows = '<tr><td colspan="3">No search strategy issues were recorded.</td></tr>'
    mismatch_title = (
        "<h2>Search Query Mismatch</h2>"
        "<p>The manuscript does not reproduce the exact query stored in search_query.txt.</p>"
        if summary.get("exact_query_reproduced") is not True
        else ""
    )
    title = "MetaAgent Search Strategy Audit"
    subtitle = "Checks whether the manuscript reproduces the actual search_query.txt query."
    chips = [
        _stat_chip("Query chars", summary.get("query_chars", 0)),
        _stat_chip("Query terms", summary.get("query_terms", 0)),
        _stat_chip("Exact query reproduced", bool(summary.get("exact_query_reproduced"))),
        _stat_chip("Search report", bool(summary.get("search_report_present"))),
        _stat_chip("Failed issues", summary.get("failed_issues", 0)),
    ]
    query_panel = f"""    <section class="panel">
      <h2>Query Excerpt</h2>
      <code>{escape(str(audit.get("query_excerpt") or ""))}</code>
    </section>"""
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
    {mismatch_title}
{_panel("Issues", _data_table(["Severity", "Code", "Message"], issue_rows))}
{query_panel}
  </main>"""
    return _render_page(title=title, body=body, extra_css=_CODE_PRE_WRAP_CSS)


def _render_figure_audit_html(audit: dict) -> str:
    summary = audit.get("summary") or {}
    image_refs = audit.get("image_refs") or []
    issues = audit.get("issues") or []
    issue_rows = "\n".join(_render_figure_issue_row(issue) for issue in issues)
    if not issue_rows:
        issue_rows = '<tr><td colspan="4">No figure asset issues were recorded.</td></tr>'
    image_rows = "\n".join(_render_figure_image_row(ref) for ref in image_refs)
    if not image_rows:
        image_rows = '<tr><td colspan="5">No markdown image references were found.</td></tr>'
    mismatch_title = (
        "<h2>Missing Figure Asset</h2>"
        "<p>At least one manuscript figure image reference does not resolve to a packaged local file.</p>"
        if int(summary.get("missing_referenced_images") or 0)
        else ""
    )
    title = "MetaAgent Figure Audit"
    subtitle = "Checks whether manuscript figure image links resolve to packaged PNG assets."
    chips = [
        _stat_chip("Headings", summary.get("figure_headings", 0)),
        _stat_chip("Referenced images", summary.get("referenced_images", 0)),
        _stat_chip("Packaged PNG files", summary.get("packaged_png_files", 0)),
        _stat_chip("Missing images", summary.get("missing_referenced_images", 0)),
        _stat_chip("External images", summary.get("external_referenced_images", 0)),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
    {mismatch_title}
{_panel("Issues", _data_table(["Severity", "Code", "Target", "Message"], issue_rows))}
{_panel("Image References", _data_table(["Alt text", "Target", "Exists", "External", "Resolved path"], image_rows))}
  </main>"""
    return _render_page(title=title, body=body, extra_css=_OVERFLOW_WRAP_CSS)


def _render_cross_reference_audit_html(audit: dict) -> str:
    summary = audit.get("summary") or {}
    issues = audit.get("issues") or []
    issue_rows = "\n".join(_render_cross_reference_issue_row(issue) for issue in issues)
    if not issue_rows:
        issue_rows = '<tr><td colspan="4">No cross-reference issues were recorded.</td></tr>'
    issue_title = (
        "<h2>Cross-Reference Issue</h2>"
        "<p>Formal manuscripts should mention each numbered table and figure in the main text.</p>"
        if int(summary.get("failed_issues") or 0)
        else ""
    )
    title = "MetaAgent Cross-Reference Audit"
    subtitle = "Checks whether numbered tables and figures are cited in the main text."
    chips = [
        _stat_chip("Tables", f"{summary.get('main_text_referenced_tables', 0)}/{summary.get('defined_tables', 0)}"),
        _stat_chip("Figures", f"{summary.get('main_text_referenced_figures', 0)}/{summary.get('defined_figures', 0)}"),
        _stat_chip("Unreferenced tables", summary.get("unreferenced_tables", 0)),
        _stat_chip("Unreferenced figures", summary.get("unreferenced_figures", 0)),
        _stat_chip("Failed issues", summary.get("failed_issues", 0)),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
    {issue_title}
{_panel("Issues", _data_table(["Severity", "Code", "Target", "Message"], issue_rows))}
  </main>"""
    return _render_page(title=title, body=body)


def _render_figure_legend_audit_html(audit: dict) -> str:
    summary = audit.get("summary") or {}
    figures = audit.get("figures") or []
    issues = audit.get("issues") or []
    figure_rows = "\n".join(_render_figure_legend_figure_row(row) for row in figures)
    if not figure_rows:
        figure_rows = '<tr><td colspan="3">No numbered figures were detected.</td></tr>'
    issue_rows = "\n".join(_render_figure_legend_issue_row(issue) for issue in issues)
    if not issue_rows:
        issue_rows = '<tr><td colspan="4">No figure legend issues were recorded.</td></tr>'
    issue_title = (
        "<h2>Figure Legend Issue</h2>"
        "<p>Formal manuscripts should include explanatory legends after each numbered figure.</p>"
        if int(summary.get("failed_issues") or 0)
        else ""
    )
    title = "MetaAgent Figure Legend Audit"
    subtitle = "Checks whether each numbered figure has an explanatory legend."
    chips = [
        _stat_chip("Figures with legends", f"{summary.get('figures_with_legends', 0)}/{summary.get('figure_count', 0)}"),
        _stat_chip("Missing legends", summary.get("missing_legends", 0)),
        _stat_chip("Failed issues", summary.get("failed_issues", 0)),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
    {issue_title}
{_panel("Figures", _data_table(["Figure", "Title", "Legend"], figure_rows))}
{_panel("Issues", _data_table(["Severity", "Code", "Target", "Message"], issue_rows))}
  </main>"""
    return _render_page(title=title, body=body, extra_css=_LEGACY_PASS_GREEN_CSS)


def _render_figure_legend_figure_row(row: dict[str, Any]) -> str:
    legend_class = "pass" if row.get("has_legend") else "fail"
    legend_text = "present" if row.get("has_legend") else "missing"
    return (
        "<tr>"
        f"<td>Figure {escape(str(row.get('number') or ''))}</td>"
        f"<td>{escape(str(row.get('title') or ''))}</td>"
        f"<td class=\"{legend_class}\">{escape(legend_text)}</td>"
        "</tr>"
    )


def _render_figure_legend_issue_row(issue: dict[str, Any]) -> str:
    return (
        "<tr>"
        f"<td class=\"fail\">{escape(str(issue.get('severity') or ''))}</td>"
        f"<td>{escape(str(issue.get('code') or ''))}</td>"
        f"<td>{escape(str(issue.get('target') or ''))}</td>"
        f"<td>{escape(str(issue.get('message') or ''))}</td>"
        "</tr>"
    )


def _render_cross_reference_issue_row(issue: dict[str, Any]) -> str:
    return (
        "<tr>"
        f"<td class=\"fail\">{escape(str(issue.get('severity') or ''))}</td>"
        f"<td>{escape(str(issue.get('code') or ''))}</td>"
        f"<td>{escape(str(issue.get('target') or ''))}</td>"
        f"<td>{escape(str(issue.get('message') or ''))}</td>"
        "</tr>"
    )


def _render_table_footnote_audit_html(audit: dict) -> str:
    summary = audit.get("summary") or {}
    tables = audit.get("tables") or []
    issues = audit.get("issues") or []
    table_rows = "\n".join(_render_table_footnote_table_row(row) for row in tables)
    if not table_rows:
        table_rows = '<tr><td colspan="4">No numbered tables were detected.</td></tr>'
    issue_rows = "\n".join(_render_table_footnote_issue_row(issue) for issue in issues)
    if not issue_rows:
        issue_rows = '<tr><td colspan="4">No table footnote issues were recorded.</td></tr>'
    issue_title = (
        "<h2>Table Footnote Issue</h2>"
        "<p>Formal manuscripts should define abbreviations, effect measures, and reporting conventions below each numbered table.</p>"
        if int(summary.get("failed_issues") or 0)
        else ""
    )
    title = "MetaAgent Table Footnote Audit"
    subtitle = "Checks whether numbered manuscript tables include explanatory notes."
    chips = [
        _stat_chip("Tables with notes", f"{summary.get('tables_with_notes', 0)}/{summary.get('table_count', 0)}"),
        _stat_chip("Missing notes", summary.get("missing_notes", 0)),
        _stat_chip("Failed issues", summary.get("failed_issues", 0)),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
    {issue_title}
{_panel("Tables", _data_table(["Table", "Title", "Note", "Detected abbreviations"], table_rows))}
{_panel("Issues", _data_table(["Severity", "Code", "Target", "Message"], issue_rows))}
  </main>"""
    return _render_page(title=title, body=body, extra_css=_LEGACY_PASS_GREEN_CSS)


def _render_table_footnote_table_row(row: dict[str, Any]) -> str:
    note_class = "pass" if row.get("has_note") else "fail"
    note_text = "present" if row.get("has_note") else "missing"
    abbreviations = ", ".join(str(item) for item in (row.get("detected_abbreviations") or []))
    return (
        "<tr>"
        f"<td>Table {escape(str(row.get('number') or ''))}</td>"
        f"<td>{escape(str(row.get('title') or ''))}</td>"
        f"<td class=\"{note_class}\">{escape(note_text)}</td>"
        f"<td>{escape(abbreviations)}</td>"
        "</tr>"
    )


def _render_table_footnote_issue_row(issue: dict[str, Any]) -> str:
    return (
        "<tr>"
        f"<td class=\"fail\">{escape(str(issue.get('severity') or ''))}</td>"
        f"<td>{escape(str(issue.get('code') or ''))}</td>"
        f"<td>{escape(str(issue.get('target') or ''))}</td>"
        f"<td>{escape(str(issue.get('message') or ''))}</td>"
        "</tr>"
    )


def _render_primary_result_audit_html(audit: dict) -> str:
    summary = audit.get("summary") or {}
    fields = audit.get("fields") or []
    issues = audit.get("issues") or []
    field_rows = "\n".join(_render_primary_result_field_row(field) for field in fields)
    if not field_rows:
        field_rows = '<tr><td colspan="4">No primary result fields were available for audit.</td></tr>'
    issue_rows = "\n".join(_render_primary_result_issue_row(issue) for issue in issues)
    if not issue_rows:
        issue_rows = '<tr><td colspan="4">No primary result issues were recorded.</td></tr>'
    mismatch_title = (
        "<h2>Primary Result Mismatch</h2>"
        "<p>The manuscript does not report one or more primary-analysis values from the structured analysis output.</p>"
        if int(summary.get("mismatched_fields") or 0)
        else ""
    )
    title = "MetaAgent Primary Result Audit"
    subtitle = "Checks manuscript primary-result numbers against the structured analysis output."
    chips = [
        _stat_chip("Outcome", summary.get("outcome_name") or ""),
        _stat_chip("Measure", summary.get("effect_measure") or ""),
        _stat_chip("Expected fields", summary.get("expected_fields", 0)),
        _stat_chip("Matched", summary.get("matched_fields", 0)),
        _stat_chip("Mismatched", summary.get("mismatched_fields", 0)),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
    {mismatch_title}
{_panel("Fields", _data_table(["Field", "Expected", "Kind", "Matched"], field_rows))}
{_panel("Issues", _data_table(["Severity", "Code", "Field", "Message"], issue_rows))}
  </main>"""
    return _render_page(title=title, body=body)


def _render_claim_support_audit_html(audit: dict) -> str:
    summary = audit.get("summary") or {}
    claims = audit.get("claims") or []
    issues = audit.get("issues") or []
    language = _normalize_review_language(audit.get("language") or "")
    zh = _is_zh_review_language(language)
    claim_rows = "\n".join(_render_claim_support_claim_row(claim, language) for claim in claims)
    if not claim_rows:
        empty_claims = "未检查到正文主张。" if zh else "No manuscript claims were checked."
        claim_rows = f'<tr><td colspan="5">{empty_claims}</td></tr>'
    issue_rows = "\n".join(_render_claim_support_issue_row(issue, language) for issue in issues)
    if not issue_rows:
        empty_issues = "未记录不受支持的正文主张。" if zh else "No unsupported manuscript claims were recorded."
        issue_rows = f'<tr><td colspan="4">{empty_issues}</td></tr>'
    if int(summary.get("unsupported_claims") or 0):
        warning_title = (
            "<h2>不受支持的正文主张</h2>"
            "<p>稿件中的一个或多个效应量或证据确定性主张与结构化事实源不一致。</p>"
        ) if zh else (
            "<h2>Unsupported Manuscript Claim</h2>"
            "<p>One or more effect or certainty claims in the manuscript do not match the structured fact source.</p>"
        )
    else:
        warning_title = ""
    manuscript_title = str(audit.get("manuscript_title") or "")
    title = "MetaAgent 正文主张支持审计" if zh else "MetaAgent Claim Support Audit"
    subtitle = (
        "核对主要效应和GRADE确定性主张是否与结构化事实源一致。"
        if zh else
        "Checks primary effect and GRADE certainty claims against the structured manuscript fact source."
    )
    stat_labels = {
        "checked": "已检查" if zh else "Checked",
        "supported": "已支持" if zh else "Supported",
        "unsupported": "未支持" if zh else "Unsupported",
        "failed": "失败问题" if zh else "Failed issues",
        "manuscript": "稿件" if zh else "Manuscript",
    }
    claim_heading = "已检查主张" if zh else "Checked Claims"
    issue_heading = "问题" if zh else "Issues"
    claim_headers = (
        ["状态", "类型", "预期", "支持来源", "句子"]
        if zh else
        ["Status", "Type", "Expected", "Support source", "Sentence"]
    )
    issue_headers = (
        ["严重性", "代码", "类型", "说明"]
        if zh else
        ["Severity", "Code", "Type", "Message"]
    )
    chips = [
        _stat_chip(stat_labels["checked"], summary.get("checked_claims", 0)),
        _stat_chip(stat_labels["supported"], summary.get("supported_claims", 0)),
        _stat_chip(stat_labels["unsupported"], summary.get("unsupported_claims", 0)),
        _stat_chip(stat_labels["failed"], summary.get("failed_issues", 0)),
        _stat_chip(stat_labels["manuscript"], manuscript_title),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
    {warning_title}
{_panel(claim_heading, _data_table(claim_headers, claim_rows))}
{_panel(issue_heading, _data_table(issue_headers, issue_rows))}
  </main>"""
    return _render_page(title=title, body=body, lang=_html_lang(language), extra_css=_OVERFLOW_WRAP_CSS)


def _render_primary_source_trace_html(trace: dict) -> str:
    summary = trace.get("summary") or {}
    rows = trace.get("rows") or []
    issues = trace.get("issues") or []
    language = _normalize_review_language(trace.get("language") or "")
    zh = _is_zh_review_language(language)
    row_html = "\n".join(_render_primary_source_trace_row(row, language=language) for row in rows)
    if not row_html:
        row_html = (
            '<tr><td colspan="9">没有可用的主要分析来源行。</td></tr>'
            if zh else
            '<tr><td colspan="9">No primary-analysis source rows were available.</td></tr>'
        )
    issue_html = "\n".join(_render_primary_source_trace_issue_row(issue, language=language) for issue in issues)
    if not issue_html:
        issue_html = (
            '<tr><td colspan="5">未记录主要结果溯源问题。</td></tr>'
            if zh else
            '<tr><td colspan="5">No primary source trace issues were recorded.</td></tr>'
        )
    title = "MetaAgent 主要结果溯源" if zh else "MetaAgent Primary Source Trace"
    subtitle = (
        "展示主要分析的每个数字行及其来源位置、页码、原文引用和核验状态。"
        if zh else
        "Shows each primary-analysis numeric row with its source location, page, quote, and verification status."
    )
    labels = {
        "outcome": "结局" if zh else "Outcome",
        "measure": "效应量" if zh else "Measure",
        "rows": "行数" if zh else "Rows",
        "traceable": "可溯源" if zh else "Traceable",
        "missing_quote": "缺失原文引用" if zh else "Missing quote",
        "missing_location": "缺失来源位置" if zh else "Missing location",
        "unverified_quote": "未核验引用" if zh else "Unverified quote",
        "primary_rows": "主要分析行" if zh else "Primary Rows",
        "issues": "问题" if zh else "Issues",
        "study": "研究" if zh else "Study",
        "status": "状态" if zh else "Status",
        "effect": "效应" if zh else "Effect",
        "counts": "计数" if zh else "Counts",
        "source": "来源" if zh else "Source",
        "page": "页码" if zh else "Page",
        "verified": "已核验" if zh else "Verified",
        "quote": "原文引用" if zh else "Quote",
        "severity": "严重性" if zh else "Severity",
        "issue": "问题" if zh else "Issue",
        "row": "行" if zh else "Row",
        "message": "消息" if zh else "Message",
    }
    chips = [
        _stat_chip(labels["outcome"], summary.get("outcome_name") or ""),
        _stat_chip(labels["measure"], summary.get("effect_measure") or ""),
        _stat_chip(labels["rows"], summary.get("row_count", 0)),
        _stat_chip(labels["traceable"], summary.get("source_traceable_rows", 0)),
        _stat_chip(labels["missing_quote"], summary.get("missing_source_quote_rows", 0)),
        _stat_chip(labels["missing_location"], summary.get("missing_source_location_rows", 0)),
        _stat_chip(labels["unverified_quote"], summary.get("unverified_source_quote_rows", 0)),
    ]
    primary_table = f"""      <table>
        <thead>
          <tr><th>{labels["study"]}</th><th>{labels["status"]}</th><th>{labels["outcome"]}</th><th>{labels["effect"]}</th><th>{labels["counts"]}</th><th>{labels["source"]}</th><th>{labels["page"]}</th><th>{labels["verified"]}</th><th>{labels["quote"]}</th></tr>
        </thead>
        <tbody>{row_html}</tbody>
      </table>"""
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
{_panel(labels["primary_rows"], primary_table)}
{_panel(labels["issues"], _data_table([labels["severity"], labels["issue"], labels["study"], labels["row"], labels["message"]], issue_html))}
  </main>"""
    return _render_page(title=title, body=body, lang=_html_lang(language), extra_css=_SOURCE_TRACE_CSS)


def _render_primary_source_trace_row(row: dict[str, Any], *, language: str = "en") -> str:
    values = row.get("values") if isinstance(row.get("values"), dict) else {}
    source = row.get("source") if isinstance(row.get("source"), dict) else {}
    status = str(row.get("trace_status") or "")
    status_class = "pass" if status == "traceable" else "fail"
    source_label = " / ".join(
        part for part in (
            str(source.get("location") or "").strip(),
            str(source.get("section") or "").strip(),
        )
        if part
    )
    return (
        "<tr>"
        f"<td>{escape(str(row.get('study_label') or row.get('study_id') or ''))}</td>"
        f"<td class=\"{status_class}\">{escape(status)}</td>"
        f"<td>{escape(str(row.get('outcome_name') or ''))}</td>"
        f"<td>{escape(_format_review_number(values.get('effect_original')))}</td>"
        f"<td>{escape(_format_source_trace_counts(values))}</td>"
        f"<td>{escape(source_label)}</td>"
        f"<td>{escape(str(source.get('page') or ''))}</td>"
        f"<td>{escape(str(source.get('quote_verified')))}</td>"
        f"<td class=\"quote\">{escape(str(source.get('quote') or ''))}</td>"
        "</tr>"
    )


def _format_source_trace_counts(values: dict[str, Any]) -> str:
    row = {
        "events_intervention": values.get("events_intervention"),
        "total_intervention": values.get("total_intervention"),
        "events_control": values.get("events_control"),
        "total_control": values.get("total_control"),
    }
    return _format_count_pair(row)


def _render_primary_source_trace_issue_row(issue: dict[str, Any], *, language: str = "en") -> str:
    return (
        "<tr>"
        f"<td class=\"fail\">{escape(str(issue.get('severity') or ''))}</td>"
        f"<td>{escape(_primary_source_trace_issue_label(str(issue.get('code') or ''), language=language))}</td>"
        f"<td>{escape(str(issue.get('study_label') or issue.get('study_id') or ''))}</td>"
        f"<td>{escape(str(issue.get('row_id') or ''))}</td>"
        f"<td>{escape(str(issue.get('message') or ''))}</td>"
        "</tr>"
    )


def _primary_source_trace_issue_label(code: str, *, language: str = "en") -> str:
    if _is_zh_review_language(language):
        return {
            "primary_source_row_unmatched": "来源行未匹配",
            "primary_source_quote_missing": "缺失原文引用",
            "primary_source_location_missing": "缺失来源位置",
            "primary_source_quote_unverified": "原文引用未核验",
        }.get(code, code)
    return {
        "primary_source_row_unmatched": "Source row unmatched",
        "primary_source_quote_missing": "Missing source quote",
        "primary_source_location_missing": "Missing source location",
        "primary_source_quote_unverified": "Unverified source quote",
    }.get(code, code)


def _render_primary_result_field_row(field: dict[str, Any]) -> str:
    matched = bool(field.get("matched"))
    return (
        "<tr>"
        f"<td>{escape(str(field.get('label') or field.get('field') or ''))}</td>"
        f"<td>{escape(str(field.get('expected') or ''))}</td>"
        f"<td>{escape(str(field.get('kind') or ''))}</td>"
        f"<td class=\"{'pass' if matched else 'fail'}\">{escape(str(matched))}</td>"
        "</tr>"
    )


def _render_primary_result_issue_row(issue: dict[str, Any]) -> str:
    return (
        "<tr>"
        f"<td class=\"fail\">{escape(str(issue.get('severity') or ''))}</td>"
        f"<td>{escape(str(issue.get('code') or ''))}</td>"
        f"<td>{escape(str(issue.get('field') or ''))}</td>"
        f"<td>{escape(str(issue.get('message') or ''))}</td>"
        "</tr>"
    )


def _render_claim_support_claim_row(claim: dict[str, Any], language: str = "en") -> str:
    status = str(claim.get("status") or "")
    css_class = "pass" if status == "supported" else "fail"
    return (
        "<tr>"
        f"<td class=\"{css_class}\">{escape(_localized_claim_support_status(status, language))}</td>"
        f"<td>{escape(_localized_claim_support_type(str(claim.get('claim_type') or ''), language))}</td>"
        f"<td>{escape(str(claim.get('expected') or ''))}</td>"
        f"<td>{escape(_localized_claim_support_source(str(claim.get('support_source') or ''), language))}</td>"
        f"<td>{escape(str(claim.get('sentence') or ''))}</td>"
        "</tr>"
    )


def _render_claim_support_issue_row(issue: dict[str, Any], language: str = "en") -> str:
    return (
        "<tr>"
        f"<td class=\"fail\">{escape(_localized_claim_support_severity(str(issue.get('severity') or ''), language))}</td>"
        f"<td>{escape(_localized_claim_support_issue_code(str(issue.get('code') or ''), language))}</td>"
        f"<td>{escape(_localized_claim_support_type(str(issue.get('claim_type') or ''), language))}</td>"
        f"<td>{escape(_localized_claim_support_message(str(issue.get('message') or ''), language))}</td>"
        "</tr>"
    )


def _localized_claim_support_status(status: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return status
    return {
        "supported": "已支持",
        "unsupported": "不支持",
    }.get(status, status)


def _localized_claim_support_type(claim_type: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return claim_type
    return {
        "primary_effect": "主效应主张",
        "grade_certainty": "证据确定性主张",
    }.get(claim_type, claim_type)


def _localized_claim_support_source(source: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return source
    return {
        "manuscript_facts.primary_effect": "结构化主效应事实",
        "manuscript_facts.grade": "结构化GRADE事实",
    }.get(source, source)


def _localized_claim_support_severity(severity: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return severity
    return {"fail": "失败", "warn": "警告"}.get(severity, severity)


def _localized_claim_support_issue_code(code: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return code
    return {
        "unsupported_manuscript_claim": "正文主张不受支持",
    }.get(code, code)


def _localized_claim_support_message(message: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return message
    text = str(message or "")
    text = text.replace("unsupported primary-effect claim; expected", "主效应主张不受支持；预期")
    text = text.replace("unsupported GRADE certainty claim; expected", "证据确定性主张不受支持；预期")
    text = text.replace("matches expected", "匹配预期")
    text = text.replace("GRADE certainty", "GRADE证据确定性")
    return text


def _render_figure_issue_row(issue: dict[str, Any]) -> str:
    severity = str(issue.get("severity") or "")
    css_class = "fail" if severity == "fail" else "warn" if severity == "warn" else ""
    return (
        "<tr>"
        f"<td class=\"{css_class}\">{escape(severity)}</td>"
        f"<td>{escape(str(issue.get('code') or ''))}</td>"
        f"<td>{escape(str(issue.get('target') or ''))}</td>"
        f"<td>{escape(str(issue.get('message') or ''))}</td>"
        "</tr>"
    )


def _render_figure_image_row(ref: dict[str, Any]) -> str:
    css_class = "pass" if ref.get("exists") else "warn" if ref.get("is_external") else "fail"
    return (
        "<tr>"
        f"<td>{escape(str(ref.get('alt') or ''))}</td>"
        f"<td>{escape(str(ref.get('target') or ''))}</td>"
        f"<td class=\"{css_class}\">{escape(str(bool(ref.get('exists'))))}</td>"
        f"<td>{escape(str(bool(ref.get('is_external'))))}</td>"
        f"<td>{escape(str(ref.get('resolved_path') or ''))}</td>"
        "</tr>"
    )


def _render_search_strategy_issue_row(issue: dict[str, Any]) -> str:
    severity = str(issue.get("severity") or "")
    css_class = "fail" if severity == "fail" else "warn" if severity == "warn" else ""
    return (
        "<tr>"
        f"<td class=\"{css_class}\">{escape(severity)}</td>"
        f"<td>{escape(str(issue.get('code') or ''))}</td>"
        f"<td>{escape(str(issue.get('message') or ''))}</td>"
        "</tr>"
    )


def _render_prisma_field_row(field: dict[str, Any]) -> str:
    matched = bool(field.get("matched"))
    css_class = "pass" if matched else "fail"
    values = ", ".join(str(value) for value in field.get("reported_values") or [])
    return (
        "<tr>"
        f"<td>{escape(str(field.get('label') or field.get('field') or ''))}</td>"
        f"<td>{escape(str(field.get('expected') or ''))}</td>"
        f"<td>{escape(values)}</td>"
        f"<td>{escape(str(matched))}</td>"
        f"<td class=\"{css_class}\">{'pass' if matched else 'fail'}</td>"
        "</tr>"
    )


def _render_prisma_issue_row(issue: dict[str, Any]) -> str:
    return (
        "<tr>"
        f"<td class=\"fail\">{escape(str(issue.get('severity') or ''))}</td>"
        f"<td>{escape(str(issue.get('code') or ''))}</td>"
        f"<td>{escape(str(issue.get('label') or issue.get('field') or ''))}</td>"
        f"<td>{escape(str(issue.get('message') or ''))}</td>"
        "</tr>"
    )


def _render_reference_issue_row(issue: dict[str, Any], language: str = "en") -> str:
    severity = str(issue.get("severity") or "")
    css_class = "fail" if severity == "fail" else "warn" if severity == "warn" else ""
    return (
        "<tr>"
        f"<td class=\"{css_class}\">{escape(_localized_reference_severity(severity, language))}</td>"
        f"<td>{escape(_localized_reference_issue_code(str(issue.get('code') or ''), language))}</td>"
        f"<td>{escape(str(issue.get('key') or ''))}</td>"
        f"<td>{escape(_localized_reference_issue_message(issue, language))}</td>"
        "</tr>"
    )


def _localized_reference_bool(value: bool, language: str) -> str:
    if _is_zh_review_language(language):
        return "是" if value else "否"
    return str(value)


def _localized_reference_severity(severity: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return severity
    return {"fail": "失败", "warn": "警告", "warning": "警告"}.get(severity, severity)


def _localized_reference_issue_code(code: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return code
    return {
        "reference_count_mismatch": "参考文献数量不一致",
        "reference_missing_identifier": "缺失DOI/PMID/URL",
        "reference_missing_journal": "缺失期刊名",
        "reference_missing_volume_or_pages": "缺失卷/页码",
        "reference_long_author_list": "作者列表过长",
    }.get(code, code)


def _localized_reference_issue_message(issue: dict[str, Any], language: str) -> str:
    if not _is_zh_review_language(language):
        return str(issue.get("message") or "")
    code = str(issue.get("code") or "")
    return {
        "reference_count_mismatch": "稿件编号参考文献清单与 references.bib 的条目数不同。",
        "reference_missing_identifier": "参考文献条目缺少 DOI、PMID 或 URL。",
        "reference_missing_journal": "期刊论文条目有 DOI/PMID 元数据，但缺少期刊名。",
        "reference_missing_volume_or_pages": "期刊论文条目缺少卷号或页码范围元数据。",
        "reference_long_author_list": "参考文献作者列表很长，请按目标期刊格式限制核对。",
    }.get(code, str(issue.get("message") or ""))


def _render_reference_entry_row(entry: dict[str, Any], *, language: str = "en") -> str:
    volume_pages = str(entry.get("volume") or "")
    if entry.get("issue"):
        volume_pages += f"({entry.get('issue')})"
    if entry.get("pages"):
        volume_pages += f":{entry.get('pages')}"
    return (
        "<tr>"
        f"<td>{escape(str(entry.get('key') or ''))}</td>"
        f"<td>{escape(str(entry.get('entry_type') or ''))}</td>"
        f"<td>{escape(str(entry.get('title') or ''))}</td>"
        f"<td>{escape(str(entry.get('journal') or ''))}</td>"
        f"<td>{escape(volume_pages)}</td>"
        f"<td>{escape(_localized_reference_source_type(str(entry.get('source_type') or ''), language))}</td>"
        f"<td>{escape(str(entry.get('doi') or ''))}</td>"
        f"<td>{escape(str(entry.get('pmid') or ''))}</td>"
        f"<td>{escape(str(entry.get('url') or ''))}</td>"
        "</tr>"
    )


def _localized_reference_source_type(source_type: str, language: str) -> str:
    raw = str(source_type or "").strip()
    if not _is_zh_review_language(language):
        return raw
    return {
        "journal_article": "期刊论文",
        "trial_registry": "临床试验注册",
        "evidence_registry": "证据注册来源",
        "web_source": "网页来源",
        "unknown": "未知来源",
    }.get(raw, raw)
