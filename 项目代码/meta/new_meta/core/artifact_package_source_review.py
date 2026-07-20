"""Source coverage and PDF intake review renderers."""
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

_BADGE_TONE_CSS = """    .badge { border-radius: 999px; padding: 3px 9px; font-size: 12px; white-space: nowrap; border: 1px solid var(--line); background: var(--badge-bg); font-weight: 400; }
    .ok { color: var(--ok); border-color: var(--ok-line); background: var(--ok-bg); }
    .warn { color: var(--warn); border-color: var(--warn-line); background: var(--warn-bg); font-weight: 400; }
    .bad { color: var(--bad); border-color: var(--bad-line); background: var(--bad-bg); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; }"""

_TEXT_SOURCE_COVERAGE_EXTRA_CSS = """    h2 { margin-top: 0; margin-bottom: 0.83em; }
    .panel { margin: 0 0 18px; }
""" + _BADGE_TONE_CSS

_PDF_INTAKE_EXTRA_CSS = """    h2 { margin: 0 0 12px; }
    table { border: 1px solid var(--line); }
""" + _BADGE_TONE_CSS


def build_pdf_intake_review(project: Project, *, language: str = "") -> dict | None:
    manifest = project.load_json("pdf_intake_manifest.json")
    if not isinstance(manifest, dict):
        return None
    files = [item for item in manifest.get("files") or [] if isinstance(item, dict)]
    if not files:
        return None
    language = _normalize_review_language(language) or "en"
    summary = {
        "total_files": len(files),
        "ok": sum(1 for item in files if item.get("parse_status") == "ok"),
        "empty_text": sum(1 for item in files if item.get("parse_status") == "empty_text"),
        "failed": sum(1 for item in files if item.get("parse_status") == "failed"),
        "requires_user_review": sum(1 for item in files if item.get("requires_user_review")),
        "matched": sum(1 for item in files if item.get("matched_pmid") or item.get("matched_title")),
        "unmatched": sum(1 for item in files if not (item.get("matched_pmid") or item.get("matched_title"))),
        "cache_hits": sum(1 for item in files if item.get("cache_hit")),
        "total_text_chars": sum(int(item.get("text_chars") or 0) for item in files),
        "total_tables": sum(int(item.get("table_count") or 0) for item in files),
    }
    return {
        "session_id": manifest.get("session_id"),
        "created_at": manifest.get("created_at"),
        "language": language,
        "summary": summary,
        "files": files,
    }


def build_text_source_coverage_review(project: Project, *, language: str = "") -> dict | None:
    """Summarize which screened/retrieved records rely on limited text sources."""
    records_by_key: dict[str, dict[str, Any]] = {}

    def add_record(raw: Any, *, list_name: str, warning_text: str = "") -> None:
        if not isinstance(raw, dict):
            return
        paper = raw.get("paper") if isinstance(raw.get("paper"), dict) else raw
        title = str(paper.get("title") or raw.get("title") or "").strip()
        pmid = str(paper.get("pmid") or raw.get("pmid") or "").strip()
        doi = str(paper.get("doi") or raw.get("doi") or "").strip()
        trial_registration = str(
            paper.get("trial_registration")
            or paper.get("nct_id")
            or paper.get("clinicaltrials_id")
            or raw.get("trial_registration")
            or raw.get("nct_id")
            or raw.get("clinicaltrials_id")
            or ""
        ).strip()
        source_level = _normalize_text_source_level(
            paper.get("text_availability")
            or raw.get("text_availability")
            or paper.get("source_warning")
            or raw.get("source_warning")
            or paper.get("fulltext_source")
            or raw.get("fulltext_source")
            or ("full_text" if paper.get("pdf_path") or paper.get("fulltext_path") else "")
        )
        if not source_level and not any([title, pmid, doi, trial_registration]):
            return
        key = _text_source_record_key(pmid=pmid, doi=doi, trial_registration=trial_registration, title=title)
        if not key:
            return
        match_keys = _text_source_alias_keys(
            pmid=pmid,
            doi=doi,
            trial_registration=trial_registration,
            title=title,
            study_id=str(paper.get("study_id") or raw.get("study_id") or "").strip(),
        )
        warning = (
            warning_text
            or str(raw.get("warning") or paper.get("warning") or paper.get("source_warning") or raw.get("source_warning") or "").strip()
        )
        existing = records_by_key.get(key)
        if existing is None:
            records_by_key[key] = {
                "id": key,
                "title": title,
                "pmid": pmid,
                "doi": doi,
                "trial_registration": trial_registration,
                "source_level": source_level or "unknown",
                "fulltext_source": str(paper.get("fulltext_source") or raw.get("fulltext_source") or "").strip(),
                "source_lists": [list_name],
                "match_keys": sorted(match_keys),
                "warning": warning,
                "requires_review": _text_source_level_requires_review(source_level) or bool(warning),
            }
            return
        if list_name not in existing["source_lists"]:
            existing["source_lists"].append(list_name)
        existing["match_keys"] = sorted(set(existing.get("match_keys") or []) | match_keys)
        existing_level = str(existing.get("source_level") or "unknown")
        merged_level = _stronger_text_source_level(existing_level, source_level)
        existing["source_level"] = merged_level
        existing["requires_review"] = (
            bool(existing.get("requires_review"))
            or _text_source_level_requires_review(merged_level)
            or bool(warning)
        )
        if not existing.get("warning") and warning:
            existing["warning"] = warning
        if not existing.get("fulltext_source") and (paper.get("fulltext_source") or raw.get("fulltext_source")):
            existing["fulltext_source"] = str(paper.get("fulltext_source") or raw.get("fulltext_source"))

    warnings = project.load_json("text_source_warnings.json")
    if isinstance(warnings, list):
        for item in warnings:
            add_record(item, list_name="text_source_warnings")

    downloaded = project.load_json("pdf_download_results.json")
    if isinstance(downloaded, list):
        for item in downloaded:
            add_record(item, list_name="pdf_download_results")

    ft_screening = project.load_json("full_text_screening.json", subdir="screening")
    if isinstance(ft_screening, list):
        for item in ft_screening:
            add_record(item, list_name="full_text_screening")

    _apply_text_source_downstream_uses(project, records_by_key)

    records = sorted(records_by_key.values(), key=lambda item: (
        0 if item.get("requires_review") else 1,
        _text_source_level_sort_rank(item.get("source_level")),
        str(item.get("title") or "").lower(),
    ))
    if not records:
        return None

    issues = []
    for record in records:
        if _text_source_level_requires_review(record.get("source_level")) and record.get("requires_review"):
            issues.append({
                "code": "limited_text_source_used_downstream",
                "severity": "warning",
                "record_id": record.get("id"),
                "source_level": record.get("source_level"),
                "impact_scope": record.get("impact_scope"),
                "title": record.get("title"),
                "message": (
                    "This limited-text record contributes to extraction, primary analysis, GRADE, "
                    "or manuscript references; verify it against a full-text PDF/HTML source before submission."
                ),
            })

    counts = {level: sum(1 for record in records if record.get("source_level") == level) for level in [
        "full_text",
        "abstract_only",
        "metadata_only",
        "registry_only",
        "unknown",
    ]}
    limited_source_records = sum(
        counts[level] for level in ("abstract_only", "metadata_only", "registry_only", "unknown")
    )
    action_required_limited_records = sum(
        1 for record in records
        if _text_source_level_requires_review(record.get("source_level")) and record.get("requires_review")
    )
    screening_only_limited_records = sum(
        1 for record in records
        if _text_source_level_requires_review(record.get("source_level"))
        and record.get("impact_scope") == "screening_only"
    )
    warning_issues = sum(1 for issue in issues if issue.get("severity") == "warning")
    language = _normalize_review_language(language) or "en"
    return {
        "schema_version": 1,
        "status": "ready_with_warnings" if action_required_limited_records else "ready",
        "passed": True,
        "language": language,
        "summary": {
            "total_records": len(records),
            "full_text_records": counts["full_text"],
            "abstract_only_records": counts["abstract_only"],
            "metadata_only_records": counts["metadata_only"],
            "registry_only_records": counts["registry_only"],
            "unknown_records": counts["unknown"],
            "limited_source_records": limited_source_records,
            "action_required_limited_records": action_required_limited_records,
            "screening_only_limited_records": screening_only_limited_records,
            "records_requiring_review": action_required_limited_records,
            "warning_issues": warning_issues,
            "failed_issues": 0,
        },
        "records": records,
        "issues": issues,
    }


def _apply_text_source_downstream_uses(project: Project, records_by_key: dict[str, dict[str, Any]]) -> None:
    scope_by_key: dict[str, set[str]] = {}

    def add_scope(raw: Any, scope: str) -> None:
        for key in _text_source_alias_keys_from_any(raw):
            scope_by_key.setdefault(key, set()).add(scope)

    extractions = project.load_json("all_extractions.json", subdir="extraction")
    if isinstance(extractions, list):
        for study in extractions:
            if not isinstance(study, dict):
                continue
            characteristics = study.get("characteristics") if isinstance(study.get("characteristics"), dict) else {}
            has_outcomes = bool(study.get("outcomes"))
            if has_outcomes:
                add_scope(characteristics, "extracted_outcome")

    meta_results = project.load_json("meta_results.json", subdir="analysis")
    primary = meta_results.get("primary_outcome") if isinstance(meta_results, dict) else None
    if isinstance(primary, dict):
        for study in primary.get("studies") or []:
            if not isinstance(study, dict):
                continue
            add_scope({"study_id": study.get("study_id")}, "primary_meta_analysis")
            add_scope({"study_id": study.get("study_id")}, "grade_contributor")

    references_text = ""
    references_path = project.base_dir / "references.bib"
    if references_path.exists() and references_path.is_file():
        references_text = references_path.read_text(encoding="utf-8", errors="replace")
    for entry in _iter_bib_reference_identity_records(references_text):
        add_scope(entry, "cited_reference")

    for record in records_by_key.values():
        aliases = set(record.get("match_keys") or [])
        downstream_uses = sorted(set().union(*(scope_by_key.get(alias, set()) for alias in aliases)))
        if not downstream_uses:
            downstream_uses = ["screened_record"]
        impact_scope = _text_source_impact_scope(downstream_uses)
        record["downstream_uses"] = downstream_uses
        record["impact_scope"] = impact_scope
        record["requires_review"] = (
            _text_source_level_requires_review(record.get("source_level"))
            and impact_scope != "screening_only"
        )


def _text_source_impact_scope(scopes: list[str]) -> str:
    scope_set = set(scopes)
    if "primary_meta_analysis" in scope_set:
        return "primary_analysis"
    if "extracted_outcome" in scope_set:
        return "extraction"
    if "grade_contributor" in scope_set:
        return "grade"
    if "cited_reference" in scope_set:
        return "manuscript_reference"
    return "screening_only"


def _text_source_alias_keys_from_any(raw: Any) -> set[str]:
    if not isinstance(raw, dict):
        return set()
    return _text_source_alias_keys(
        pmid=str(raw.get("pmid") or "").strip(),
        doi=str(raw.get("doi") or "").strip(),
        trial_registration=str(
            raw.get("trial_registration")
            or raw.get("nct_id")
            or raw.get("clinicaltrials_id")
            or ""
        ).strip(),
        title=str(raw.get("title") or "").strip(),
        study_id=str(raw.get("study_id") or raw.get("id") or "").strip(),
    )


def _iter_bib_reference_identity_records(text: str) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    for match in re.finditer(r"@\w+\s*\{[^@]*?(?=\n\s*@|\Z)", text or "", flags=re.S):
        entry = match.group(0)
        records.append({
            "pmid": _bib_field(entry, "pmid"),
            "doi": _bib_field(entry, "doi"),
            "title": _bib_field(entry, "title"),
        })
    return records


def _bib_field(entry: str, field: str) -> str:
    match = re.search(
        rf"^\s*{re.escape(field)}\s*=\s*[\{{\"](.+?)[\}}\"]\s*,?\s*$",
        entry,
        flags=re.I | re.M,
    )
    return match.group(1).strip() if match else ""


def _normalize_text_source_level(value: Any) -> str:
    normalized = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if not normalized:
        return ""
    if normalized in {"full_text", "fulltext", "pdf", "html", "user_upload", "primary_full_text", "primary_publication_full_text"}:
        return "full_text"
    if "abstract" in normalized:
        return "abstract_only"
    if "registry" in normalized and ("metadata" in normalized or "only" in normalized):
        return "metadata_only"
    if normalized in {"metadata_only", "metadata", "record_metadata_only"}:
        return "metadata_only"
    if "registry" in normalized:
        return "registry_only"
    if "pdf" in normalized or "fulltext" in normalized or "full_text" in normalized or "pmc" in normalized:
        return "full_text"
    return "unknown"


def _text_source_level_requires_review(level: Any) -> bool:
    return str(level or "unknown") in {"abstract_only", "metadata_only", "registry_only", "unknown"}


def _text_source_level_sort_rank(level: Any) -> int:
    return {
        "metadata_only": 0,
        "registry_only": 1,
        "abstract_only": 2,
        "unknown": 3,
        "full_text": 4,
    }.get(str(level or "unknown"), 5)


def _stronger_text_source_level(current: str, candidate: str) -> str:
    current = current or "unknown"
    candidate = candidate or ""
    if not candidate:
        return current
    rank = {"unknown": 0, "metadata_only": 1, "registry_only": 1, "abstract_only": 2, "full_text": 3}
    return candidate if rank.get(candidate, 0) > rank.get(current, 0) else current


def _text_source_record_key(*, pmid: str, doi: str, trial_registration: str, title: str) -> str:
    if pmid:
        return f"pmid:{pmid.lower()}"
    if doi:
        return f"doi:{doi.lower()}"
    if trial_registration:
        return f"trial:{trial_registration.lower()}"
    title_key = re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()
    if title_key:
        return "title:" + re.sub(r"\s+", " ", title_key)[:160]
    return ""


def _text_source_alias_keys(
    *,
    pmid: str = "",
    doi: str = "",
    trial_registration: str = "",
    title: str = "",
    study_id: str = "",
) -> set[str]:
    keys: set[str] = set()
    pmid = str(pmid or "").strip()
    doi = str(doi or "").strip().lower()
    trial_registration = str(trial_registration or "").strip().lower()
    study_id = str(study_id or "").strip().lower()
    title_key = re.sub(r"[^a-z0-9]+", " ", str(title or "").lower()).strip()
    title_key = re.sub(r"\s+", " ", title_key)[:160] if title_key else ""
    if pmid:
        keys.add(f"pmid:{pmid.lower()}")
        keys.add(f"id:{pmid.lower()}")
    if doi:
        keys.add(f"doi:{doi}")
        keys.add(f"id:{doi}")
    if trial_registration:
        keys.add(f"trial:{trial_registration}")
        keys.add(f"id:{trial_registration}")
    if title_key:
        keys.add(f"title:{title_key}")
    if study_id:
        keys.add(f"id:{study_id}")
        if study_id.isdigit():
            keys.add(f"pmid:{study_id}")
    return keys


def render_text_source_coverage_review_html(review: dict) -> str:
    summary = review.get("summary") or {}
    language = _normalize_review_language(review.get("language") or "")
    zh = _is_zh_review_language(language)
    rows = "\n".join(_render_text_source_coverage_row(item, language) for item in review.get("records") or [])
    if not rows:
        empty_records = "未记录文本来源记录。" if zh else "No source records were available."
        rows = f'<tr><td colspan="10">{empty_records}</td></tr>'
    issue_rows = "\n".join(
        _render_text_source_coverage_issue_row(issue, language) for issue in review.get("issues") or []
    )
    if not issue_rows:
        empty_issues = "未记录有限文本来源复核问题。" if zh else "No limited-source review issues were recorded."
        issue_rows = f'<tr><td colspan="4">{empty_issues}</td></tr>'
    title = "MetaAgent 文本来源覆盖复核" if zh else "MetaAgent Text Source Coverage"
    subtitle = (
        "复核仅有摘要、元数据、注册记录或未知文本来源的记录，确认它们是否进入提取、分析、GRADE 或正文引用。"
        if zh
        else "Review records that rely on abstract-only, metadata-only, registry-only, or unknown source text before submission."
    )
    stat_labels = {
        "status": "状态" if zh else "Status",
        "total_records": "记录总数" if zh else "Records",
        "full_text_records": "全文" if zh else "Full text",
        "abstract_only_records": "仅摘要" if zh else "Abstract only",
        "metadata_only_records": "仅元数据" if zh else "Metadata only",
        "registry_only_records": "仅注册记录" if zh else "Registry only",
        "unknown_records": "未知来源" if zh else "Unknown",
        "action_required_limited_records": "需处理的有限来源" if zh else "Action required",
        "screening_only_limited_records": "仅筛选阶段有限来源" if zh else "Screening only limited",
        "records_requiring_review": "需人工复核" if zh else "Needs review",
    }
    record_heading = "来源记录" if zh else "Source Records"
    issue_heading = "复核问题" if zh else "Review Issues"
    record_headers = (
        ["题名", "来源级别", "影响范围", "复核", "PMID", "DOI", "注册号", "全文来源", "清单", "警告"]
        if zh
        else ["Title", "Source level", "Impact scope", "Review", "PMID", "DOI", "Registration", "Full-text source", "Lists", "Warning"]
    )
    issue_headers = (
        ["严重性", "代码", "来源级别", "说明"]
        if zh
        else ["Severity", "Code", "Source level", "Message"]
    )
    record_header_html = "".join(f"<th>{escape(label)}</th>" for label in record_headers)
    issue_header_html = "".join(f"<th>{escape(label)}</th>" for label in issue_headers)
    chips = [
        _stat_chip(stat_labels["status"], _localized_text_source_status(str(review.get("status") or "unknown"), language)),
        _stat_chip(stat_labels["total_records"], summary.get("total_records", 0)),
        _stat_chip(stat_labels["full_text_records"], summary.get("full_text_records", 0)),
        _stat_chip(stat_labels["abstract_only_records"], summary.get("abstract_only_records", 0)),
        _stat_chip(stat_labels["metadata_only_records"], summary.get("metadata_only_records", 0)),
        _stat_chip(stat_labels["registry_only_records"], summary.get("registry_only_records", 0)),
        _stat_chip(stat_labels["unknown_records"], summary.get("unknown_records", 0)),
        _stat_chip(stat_labels["action_required_limited_records"], summary.get("action_required_limited_records", 0)),
        _stat_chip(stat_labels["screening_only_limited_records"], summary.get("screening_only_limited_records", 0)),
        _stat_chip(stat_labels["records_requiring_review"], summary.get("records_requiring_review", 0)),
    ]
    record_table = f"""      <table>
        <thead>
          <tr>{record_header_html}</tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>"""
    issue_table = f"""      <table>
        <thead><tr>{issue_header_html}</tr></thead>
        <tbody>{issue_rows}</tbody>
      </table>"""
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
{_panel(record_heading, record_table)}
{_panel(issue_heading, issue_table)}
  </main>"""
    return _render_page(title=title, body=body, lang=_html_lang(language), extra_css=_TEXT_SOURCE_COVERAGE_EXTRA_CSS)


def _render_text_source_coverage_row(item: dict, language: str = "en") -> str:
    source_level = str(item.get("source_level") or "unknown")
    badge_class = "ok" if source_level == "full_text" else "warn" if source_level in {"abstract_only", "metadata_only", "registry_only"} else "bad"
    impact_scope = str(item.get("impact_scope") or "screening_only")
    review_required = bool(item.get("requires_review"))
    review_class = "warn" if review_required else "ok"
    downstream = ", ".join(
        _localized_text_source_downstream_use(str(scope), language) for scope in item.get("downstream_uses") or []
    )
    return (
        "<tr>"
        f"<td>{escape(str(item.get('title') or ''))}</td>"
        f"<td><span class=\"badge {badge_class}\">{escape(_localized_text_source_level(source_level, language))}</span></td>"
        f"<td>{escape(_localized_text_source_impact_scope(impact_scope, language))}<br><span class=\"mono\">{escape(downstream)}</span></td>"
        f"<td><span class=\"badge {review_class}\">{escape(_localized_text_source_bool(review_required, language))}</span></td>"
        f"<td class=\"mono\">{escape(str(item.get('pmid') or ''))}</td>"
        f"<td class=\"mono\">{escape(str(item.get('doi') or ''))}</td>"
        f"<td class=\"mono\">{escape(str(item.get('trial_registration') or ''))}</td>"
        f"<td>{escape(str(item.get('fulltext_source') or ''))}</td>"
        f"<td>{escape(', '.join(str(source) for source in item.get('source_lists') or []))}</td>"
        f"<td>{escape(str(item.get('warning') or ''))}</td>"
        "</tr>"
    )


def _render_text_source_coverage_issue_row(issue: dict, language: str = "en") -> str:
    return (
        "<tr>"
        f"<td>{escape(_localized_text_source_severity(str(issue.get('severity') or ''), language))}</td>"
        f"<td>{escape(_localized_text_source_issue_code(str(issue.get('code') or ''), language))}</td>"
        f"<td>{escape(_localized_text_source_level(str(issue.get('source_level') or ''), language))}</td>"
        f"<td>{escape(_localized_text_source_issue_message(issue, language))}</td>"
        "</tr>"
    )


def _localized_text_source_status(status: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return status
    return {
        "ready": "就绪",
        "ready_with_warnings": "就绪但有警告",
        "unknown": "未知",
    }.get(status, status)


def _localized_text_source_level(source_level: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return source_level
    return {
        "full_text": "全文",
        "abstract_only": "仅摘要",
        "metadata_only": "仅元数据",
        "registry_only": "仅注册记录",
        "unknown": "未知来源",
    }.get(source_level, source_level)


def _localized_text_source_impact_scope(scope: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return scope
    return {
        "primary_analysis": "主要分析",
        "evidence_synthesis": "证据综合",
        "manuscript_reference": "正文引用",
        "screening_only": "仅筛选阶段",
    }.get(scope, scope)


def _localized_text_source_downstream_use(scope: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return scope
    return {
        "extracted_outcome": "已提取结局",
        "primary_meta_analysis": "主要Meta分析",
        "grade_contributor": "GRADE证据贡献",
        "cited_reference": "正文引用",
        "screened_record": "筛选记录",
    }.get(scope, scope)


def _localized_text_source_bool(value: bool, language: str) -> str:
    if _is_zh_review_language(language):
        return "是" if bool(value) else "否"
    return "yes" if bool(value) else "no"


def _localized_text_source_severity(severity: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return severity
    return {
        "warning": "警告",
        "error": "错误",
        "fail": "失败",
        "info": "信息",
    }.get(severity, severity)


def _localized_text_source_issue_code(code: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return code
    return {
        "limited_text_source_used_downstream": "有限文本来源进入下游分析",
    }.get(code, code)


def _localized_text_source_issue_message(issue: dict, language: str) -> str:
    if not _is_zh_review_language(language):
        return str(issue.get("message") or "")
    code = str(issue.get("code") or "")
    if code == "limited_text_source_used_downstream":
        return "该记录只有有限文本来源，但已进入提取、主要分析、GRADE 或正文引用；投稿前需用全文 PDF/HTML 或可核验来源人工确认。"
    return str(issue.get("message") or "")


def render_pdf_intake_review_html(review: dict) -> str:
    summary = review.get("summary") or {}
    files = review.get("files") or []
    language = _normalize_review_language(review.get("language") or "")
    zh = _is_zh_review_language(language)
    rows = "\n".join(_render_pdf_intake_row(item, language) for item in files)
    if not rows:
        empty = "未记录用户上传的全文 PDF。" if zh else "No uploaded full-text files were recorded."
        rows = f'<tr><td colspan="10">{empty}</td></tr>'
    title = "MetaAgent PDF 原文接收复核" if zh else "MetaAgent PDF Intake Review"
    subtitle = (
        "展示用户上传 PDF 的下载、解析、OCR、缓存和人工复核状态。"
        if zh
        else "Check uploaded full-text parsing status before trusting extracted evidence."
    )
    detail_heading = "文件明细" if zh else "File Details"
    stat_labels = {
        "total_files": "文件总数" if zh else "Files",
        "ok": "解析成功" if zh else "OK",
        "empty_text": "空文本" if zh else "Empty text",
        "failed": "解析失败" if zh else "Failed",
        "requires_user_review": "需人工复核" if zh else "Needs review",
        "cache_hits": "缓存命中" if zh else "Cache hits",
        "total_text_chars": "文本字符数" if zh else "Text chars",
        "total_tables": "表格总数" if zh else "Tables",
    }
    headers = (
        ["文件", "下载", "解析", "页数", "字符数", "表格", "OCR", "缓存", "匹配标题", "错误"]
        if zh
        else ["File", "Download", "Parse", "Pages", "Text", "Tables", "OCR", "Cache", "Match", "Error / Path"]
    )
    header_html = "".join(f"<th>{escape(label)}</th>" for label in headers)
    chips = [
        _stat_chip(stat_labels["total_files"], summary.get("total_files", 0)),
        _stat_chip(stat_labels["ok"], summary.get("ok", 0)),
        _stat_chip(stat_labels["empty_text"], summary.get("empty_text", 0)),
        _stat_chip(stat_labels["failed"], summary.get("failed", 0)),
        _stat_chip(stat_labels["requires_user_review"], summary.get("requires_user_review", 0)),
        _stat_chip(stat_labels["cache_hits"], summary.get("cache_hits", 0)),
        _stat_chip(stat_labels["total_text_chars"], summary.get("total_text_chars", 0)),
        _stat_chip(stat_labels["total_tables"], summary.get("total_tables", 0)),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
    <h2>{escape(detail_heading)}</h2>
    <table>
      <thead>
        <tr>{header_html}</tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
  </main>"""
    return _render_page(title=title, body=body, lang=_html_lang(language), extra_css=_PDF_INTAKE_EXTRA_CSS)


def _render_pdf_intake_row(item: dict, language: str = "en") -> str:
    zh = _is_zh_review_language(language)
    download_status = str(item.get("download_status") or "unknown")
    download_class = _pdf_intake_status_class(download_status)
    status = str(item.get("parse_status") or "unknown")
    status_class = _pdf_intake_status_class(status)
    match = item.get("matched_title") or item.get("matched_pmid") or ""
    if item.get("match_score") is not None:
        match = f"{match} ({item.get('match_score')}, {item.get('match_method') or 'match'})"
    if item.get("requires_user_review"):
        match = f"{match} | {'需人工复核' if zh else 'needs review'}" if match else ("需人工复核" if zh else "needs review")
    error_bits = []
    if item.get("parse_error"):
        error_bits.append(str(item.get("parse_error")))
    if item.get("download_error"):
        error_bits.append(str(item.get("download_error")))
    if item.get("local_path"):
        error_bits.append(str(item.get("local_path")))
    return (
        "<tr>"
        f"<td>{escape(str(item.get('filename') or ''))}</td>"
        f"<td><span class=\"badge {download_class}\">{escape(_localized_pdf_intake_status(download_status, language))}</span></td>"
        f"<td><span class=\"badge {status_class}\">{escape(_localized_pdf_intake_status(status, language))}</span></td>"
        f"<td>{escape(str(item.get('page_count') or 0))}</td>"
        f"<td>{escape(str(item.get('text_chars') or 0))}</td>"
        f"<td>{escape(str(item.get('table_count') or 0))}</td>"
        f"<td>{escape(_localized_pdf_bool(item.get('ocr_used'), language))}</td>"
        f"<td>{escape(_localized_pdf_bool(item.get('cache_hit'), language))}</td>"
        f"<td>{escape(str(match))}</td>"
        f"<td class=\"mono\">{escape(' | '.join(error_bits))}</td>"
        "</tr>"
    )


def _pdf_intake_status_class(status: str) -> str:
    if status == "ok":
        return "ok"
    if status == "empty_text":
        return "warn"
    if status == "failed":
        return "bad"
    return ""


def _localized_pdf_intake_status(status: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return status
    return {
        "ok": "成功",
        "empty_text": "空文本",
        "failed": "失败",
        "unknown": "未知",
    }.get(status, status)


def _localized_pdf_bool(value: Any, language: str) -> str:
    if _is_zh_review_language(language):
        return "是" if bool(value) else "否"
    return "yes" if bool(value) else "no"


