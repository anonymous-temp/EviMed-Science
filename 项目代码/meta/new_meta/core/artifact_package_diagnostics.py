"""Diagnostic review helpers for artifact packages."""
from __future__ import annotations

from html import escape
import math
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

# The calculation audit is a bare grid/table page that never used the shared
# header/panel skeleton, so it keeps its own stylesheet (rendered with
# ``include_base_css=False``).
_CALCULATION_AUDIT_CSS = """    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #172033; }
    table { border-collapse: collapse; width: 100%; margin-top: 16px; }
    th, td { border: 1px solid #d9e0ea; padding: 8px; vertical-align: top; font-size: 13px; }
    th { background: #f5f7fb; text-align: left; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
    .stat { border: 1px solid #d9e0ea; border-radius: 8px; padding: 10px; background: #fbfcfe; }
    code { background: #f5f7fb; padding: 2px 4px; border-radius: 4px; }"""

_LLM_RELIABILITY_EXTRA_CSS = """    body { line-height: 1.5; }
    th, td { padding: 8px 6px; }
    .badge { border-radius: 999px; padding: 3px 9px; font-size: 12px; white-space: nowrap; border: 1px solid var(--warn-line); background: var(--warn-bg); color: var(--warn); }"""

_ROB_COMPLETENESS_EXTRA_CSS = """    body { line-height: 1.5; }
    th, td { padding: 8px 6px; }
    .badge { border-radius: 999px; padding: 3px 9px; font-size: 12px; white-space: nowrap; border: 1px solid var(--line); background: var(--badge-bg); }
    .formal { color: var(--ok); border-color: var(--ok-line); background: var(--ok-bg); }
    .missing, .synthetic, .incomplete { color: var(--bad); border-color: var(--bad-line); background: var(--bad-bg); }"""

_BENCHMARK_EXTRA_CSS = """    body { line-height: 1.5; }
    th, td { padding: 8px 6px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(280px, 1fr)); gap: 16px; }
    .bad { color: var(--bad); font-weight: 650; }
    .ok { color: var(--ok); font-weight: 650; }
    @media (max-width: 760px) {
      .grid { grid-template-columns: 1fr; }
    }"""


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


def _attach_benchmark_alignment(benchmark_review: dict, calculation_audit: dict | None) -> dict:
    review = dict(benchmark_review)
    anchor = review.get("published_anchor") if isinstance(review.get("published_anchor"), dict) else {}
    observed = review.get("observed_primary") if isinstance(review.get("observed_primary"), dict) else {}
    calculation_summary = (calculation_audit or {}).get("summary") if isinstance(calculation_audit, dict) else {}
    calculation_summary = calculation_summary if isinstance(calculation_summary, dict) else {}
    pooled_effect = review.get("pooled_effect") if isinstance(review.get("pooled_effect"), dict) else {}

    alignment = {
        "published": _benchmark_alignment_side(anchor, count_key="n_trials", participant_key="n_participants"),
        "observed": _benchmark_alignment_side(observed, count_key="n_studies", participant_key="total_participants"),
        "calculation_audit": {
            "included": bool(calculation_audit),
            "row_count": int(calculation_summary.get("row_count") or 0),
            "n_studies": calculation_summary.get("n_studies"),
            "source_rows_matched": int(calculation_summary.get("source_rows_matched") or 0),
            "source_quote_verified_rows": int(calculation_summary.get("source_quote_verified_rows") or 0),
            "formula_inputs_complete_rows": int(calculation_summary.get("formula_inputs_complete_rows") or 0),
            "effect_measure": calculation_summary.get("effect_measure") or "",
            "model": calculation_summary.get("model") or "",
            "pooled_effect": _rounded(_number_or_none(calculation_summary.get("pooled_effect"))),
            "ci_lower": _rounded(_number_or_none(calculation_summary.get("ci_lower"))),
            "ci_upper": _rounded(_number_or_none(calculation_summary.get("ci_upper"))),
            "aggregate_events_intervention": calculation_summary.get("aggregate_events_intervention"),
            "aggregate_total_intervention": calculation_summary.get("aggregate_total_intervention"),
            "aggregate_events_control": calculation_summary.get("aggregate_events_control"),
            "aggregate_total_control": calculation_summary.get("aggregate_total_control"),
        },
        "differences": _benchmark_alignment_differences(anchor, observed, calculation_summary, pooled_effect),
        "model_compatibility_notes": _benchmark_model_compatibility_notes(anchor, observed, calculation_summary, pooled_effect),
        "passed": (
            review.get("passed") is True
            and _calculation_audit_summary_complete_for_alignment(calculation_summary)
        ),
    }
    review["benchmark_alignment"] = alignment
    return review


def _benchmark_alignment_side(
    source: dict[str, Any],
    *,
    count_key: str,
    participant_key: str,
) -> dict[str, Any]:
    return _compact_empty({
        "effect_measure": source.get("effect_measure") or "",
        "model_preference": source.get("model_preference") or "",
        "effect": _rounded(_number_or_none(source.get("effect"))),
        "ci_lower": _rounded(_number_or_none(source.get("ci_lower"))),
        "ci_upper": _rounded(_number_or_none(source.get("ci_upper"))),
        count_key: _integer_or_none(source.get(count_key)),
        participant_key: _integer_or_none(source.get(participant_key)),
        "participant_difference": _integer_or_none(source.get("participant_difference")),
        "aggregate_events_intervention": _integer_or_none(source.get("aggregate_events_intervention")),
        "aggregate_total_intervention": _integer_or_none(source.get("aggregate_total_intervention")),
        "aggregate_events_control": _integer_or_none(source.get("aggregate_events_control")),
        "aggregate_total_control": _integer_or_none(source.get("aggregate_total_control")),
    })


def _benchmark_alignment_differences(
    anchor: dict[str, Any],
    observed: dict[str, Any],
    calculation_summary: dict[str, Any],
    pooled_effect: dict[str, Any],
) -> dict[str, Any]:
    effect_difference = pooled_effect.get("effect_difference")
    ci_lower_difference = pooled_effect.get("ci_lower_difference")
    ci_upper_difference = pooled_effect.get("ci_upper_difference")
    if effect_difference is None:
        effect_difference = _number_diff(observed.get("effect"), anchor.get("effect"))
    if ci_lower_difference is None:
        ci_lower_difference = _number_diff(observed.get("ci_lower"), anchor.get("ci_lower"))
    if ci_upper_difference is None:
        ci_upper_difference = _number_diff(observed.get("ci_upper"), anchor.get("ci_upper"))

    return _compact_empty({
        "effect": _rounded(_number_or_none(effect_difference)),
        "ci_lower": _rounded(_number_or_none(ci_lower_difference)),
        "ci_upper": _rounded(_number_or_none(ci_upper_difference)),
        "participants": _number_diff(
            observed.get("total_participants"),
            anchor.get("n_participants"),
            integer=True,
        ),
        "calculation_vs_published_effect": _rounded(_number_diff(
            calculation_summary.get("pooled_effect"),
            anchor.get("effect"),
        )),
        "calculation_vs_published_ci_lower": _rounded(_number_diff(
            calculation_summary.get("ci_lower"),
            anchor.get("ci_lower"),
        )),
        "calculation_vs_published_ci_upper": _rounded(_number_diff(
            calculation_summary.get("ci_upper"),
            anchor.get("ci_upper"),
        )),
        "model_preference": _benchmark_model_difference(anchor, observed, calculation_summary),
        "events_intervention": _number_diff(
            calculation_summary.get("aggregate_events_intervention"),
            anchor.get("aggregate_events_intervention"),
            integer=True,
        ),
        "total_intervention": _number_diff(
            calculation_summary.get("aggregate_total_intervention"),
            anchor.get("aggregate_total_intervention"),
            integer=True,
        ),
        "events_control": _number_diff(
            calculation_summary.get("aggregate_events_control"),
            anchor.get("aggregate_events_control"),
            integer=True,
        ),
        "total_control": _number_diff(
            calculation_summary.get("aggregate_total_control"),
            anchor.get("aggregate_total_control"),
            integer=True,
        ),
    })


def _benchmark_model_compatibility_notes(
    anchor: dict[str, Any],
    observed: dict[str, Any],
    calculation_summary: dict[str, Any],
    pooled_effect: dict[str, Any],
) -> list[str]:
    notes = [
        str(note)
        for note in (pooled_effect.get("compatibility_notes") or [])
        if str(note).strip()
    ]
    expected_model = str(anchor.get("model_preference") or "").strip().lower()
    observed_model = str(observed.get("model_preference") or calculation_summary.get("model") or "").strip().lower()
    tau_squared = _number_or_none(calculation_summary.get("tau_squared"))
    if (
        expected_model == "fixed"
        and observed_model == "random"
        and tau_squared is not None
        and abs(tau_squared) <= 1e-12
    ):
        notes.append("random_model_equivalent_to_fixed_tau_zero")
    return list(dict.fromkeys(notes))


def _benchmark_model_difference(
    anchor: dict[str, Any],
    observed: dict[str, Any],
    calculation_summary: dict[str, Any],
) -> str:
    expected_model = str(anchor.get("model_preference") or "").strip().lower()
    observed_model = str(observed.get("model_preference") or calculation_summary.get("model") or "").strip().lower()
    if not expected_model and not observed_model:
        return ""
    tau_squared = _number_or_none(calculation_summary.get("tau_squared"))
    parts = [
        f"published={expected_model or 'not reported'}",
        f"observed={observed_model or 'not reported'}",
    ]
    if tau_squared is not None:
        parts.append(f"tau_squared={tau_squared}")
    return "; ".join(parts)


def _number_diff(left: Any, right: Any, *, integer: bool = False) -> float | int | None:
    left_number = _number_or_none(left)
    right_number = _number_or_none(right)
    if left_number is None or right_number is None:
        return None
    value = left_number - right_number
    if integer:
        return int(value)
    return value


def _compact_empty(data: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in data.items() if value not in ("", None, [], {})}


def _calculation_audit_summary_complete_for_alignment(summary: dict[str, Any]) -> bool:
    row_count = int(summary.get("row_count") or 0)
    if row_count <= 0:
        return False
    return (
        int(summary.get("source_rows_matched") or 0) == row_count
        and int(summary.get("source_quote_verified_rows") or 0) == row_count
        and int(summary.get("formula_inputs_complete_rows") or 0) == row_count
    )


def _render_calculation_audit_html(audit: dict) -> str:
    summary = audit.get("summary") or {}
    formulas = audit.get("formulas") or {}
    selected_formula = formulas.get("selected") or {}
    rows = audit.get("rows") or []
    row_html = "\n".join(
        "<tr>"
        f"<td>{escape(str(row.get('study_label') or row.get('study_id') or ''))}</td>"
        f"<td>{escape(_format_review_number(row.get('effect_original')))}</td>"
        f"<td>{escape(_format_review_number(row.get('effect_log')))}</td>"
        f"<td>{escape(_format_review_number(row.get('standard_error')))}</td>"
        f"<td>{escape(_format_review_number(row.get('weight_percent')))}</td>"
        f"<td>{escape(_format_count_pair(row))}</td>"
        f"<td>{escape(str(row.get('source_location') or ''))}</td>"
        f"<td>{escape(str(row.get('source_quote') or ''))}</td>"
        "</tr>"
        for row in rows
    )
    body = f"""  <h1>Meta-Analysis Calculation Audit</h1>
  <div class="grid">
    <div class="stat"><strong>Outcome</strong><br>{escape(str(summary.get('outcome_name') or ''))}</div>
    <div class="stat"><strong>Measure</strong><br>{escape(str(summary.get('effect_measure') or ''))}</div>
    <div class="stat"><strong>Model</strong><br>{escape(str(summary.get('model') or ''))}</div>
    <div class="stat"><strong>Pooled effect</strong><br>{escape(_format_review_number(summary.get('pooled_effect')))} ({escape(_format_review_number(summary.get('ci_lower')))} to {escape(_format_review_number(summary.get('ci_upper')))})</div>
    <div class="stat"><strong>Rows matched to sources</strong><br>{escape(str(summary.get('source_rows_matched') or 0))}/{escape(str(summary.get('row_count') or 0))}</div>
  </div>
  <h2>Calculation Formula</h2>
  <p><strong>Effect:</strong> <code>{escape(str(selected_formula.get('effect') or ''))}</code></p>
  <p><strong>Variance:</strong> <code>{escape(str(selected_formula.get('variance') or ''))}</code></p>
  <p><strong>Reporting:</strong> {escape(str(selected_formula.get('reporting') or ''))}</p>
  <h2>Trial-Level Rows</h2>
  <table>
    <thead>
      <tr>
        <th>Study</th><th>Effect</th><th>Log effect</th><th>SE</th><th>Weight (%)</th><th>Counts</th><th>Source</th><th>Quote</th>
      </tr>
    </thead>
    <tbody>{row_html}</tbody>
  </table>"""
    return _render_page(
        title="Meta-Analysis Calculation Audit",
        body=body,
        extra_css=_CALCULATION_AUDIT_CSS,
        include_base_css=False,
    )


def _format_count_pair(row: dict[str, Any]) -> str:
    ei = row.get("events_intervention")
    ti = row.get("total_intervention")
    ec = row.get("events_control")
    tc = row.get("total_control")
    if None in (ei, ti, ec, tc):
        return ""
    return f"{ei}/{ti} vs {ec}/{tc}"


def _format_review_number(value: Any) -> str:
    number = _number_or_none(value)
    if number is None:
        return ""
    if abs(number) < 0.001 and number != 0:
        return f"{number:.2e}"
    return f"{number:.3f}".rstrip("0").rstrip(".")


def _render_llm_reliability_audit_html(audit: dict) -> str:
    summary = audit.get("summary") or {}
    issue_rows = "\n".join(_render_llm_reliability_issue_row(issue) for issue in audit.get("issues") or [])
    if not issue_rows:
        issue_rows = '<tr><td colspan="5">No LLM reliability issues were recorded.</td></tr>'
    event_rows = "\n".join(_render_llm_reliability_event_row(event) for event in audit.get("events") or [])
    if not event_rows:
        event_rows = '<tr><td colspan="9">No LLM usage events were recorded.</td></tr>'
    title = "LLM Reliability Audit"
    subtitle = "Token, retry, truncation, and fallback signals recorded during generation."
    chips = [
        _stat_chip("Status", audit.get("status") or "unknown"),
        _stat_chip("Calls", summary.get("total_events", 0)),
        _stat_chip("Retryable output issues", summary.get("retryable_output_issues", 0)),
        _stat_chip("Near truncation", summary.get("near_truncation_events", 0)),
        _stat_chip("Warnings", summary.get("warning_issues", 0)),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
{_panel("Issues", _data_table(["Severity", "Code", "Event", "Endpoint", "Message"], issue_rows))}
{_panel("Events", _data_table(["#", "Model", "Endpoint", "Finish", "Issue", "Near limit", "Prompt", "Completion", "Max"], event_rows))}
  </main>"""
    return _render_page(title=title, body=body, extra_css=_LLM_RELIABILITY_EXTRA_CSS)


def _render_llm_reliability_issue_row(issue: dict) -> str:
    return (
        "<tr>"
        f"<td><span class=\"badge\">{escape(str(issue.get('severity') or ''))}</span></td>"
        f"<td>{escape(str(issue.get('code') or ''))}</td>"
        f"<td>{escape(str(issue.get('event_index') or ''))}</td>"
        f"<td>{escape(str(issue.get('endpoint') or ''))}</td>"
        f"<td>{escape(str(issue.get('message') or ''))}</td>"
        "</tr>"
    )


def _render_llm_reliability_event_row(event: dict) -> str:
    return (
        "<tr>"
        f"<td>{escape(str(event.get('index') or ''))}</td>"
        f"<td>{escape(str(event.get('model') or ''))}</td>"
        f"<td>{escape(str(event.get('endpoint') or ''))}</td>"
        f"<td>{escape(str(event.get('finish_reason') or ''))}</td>"
        f"<td>{escape(str(event.get('retryable_output_issue') or ''))}</td>"
        f"<td>{escape(str(bool(event.get('near_truncation'))))}</td>"
        f"<td>{escape(str(event.get('prompt_tokens') or 0))}</td>"
        f"<td>{escape(str(event.get('completion_tokens') or 0))}</td>"
        f"<td>{escape(str(event.get('max_tokens') or 0))}</td>"
        "</tr>"
    )


def _render_risk_of_bias_completeness_html(review: dict) -> str:
    summary = review.get("summary") or {}
    studies = review.get("studies") or []
    issues = review.get("issues") or []
    study_rows = "\n".join(_render_risk_of_bias_completeness_study_row(row) for row in studies)
    if not study_rows:
        study_rows = '<tr><td colspan="7">No primary-analysis studies were recorded.</td></tr>'
    issue_rows = "\n".join(_render_risk_of_bias_completeness_issue_row(issue) for issue in issues)
    if not issue_rows:
        issue_rows = '<tr><td colspan="4">No risk-of-bias completeness issues were detected.</td></tr>'
    title = "Risk-of-Bias Completeness Review"
    subtitle = "Formal RoB coverage for primary meta-analysis contributors."
    chips = [
        _stat_chip("Status", review.get("status") or "unknown"),
        _stat_chip("Primary studies", summary.get("primary_contributing_studies", 0)),
        _stat_chip("Formal RoB", summary.get("formal_rob", 0)),
        _stat_chip("Missing", summary.get("missing_formal_rob", 0)),
        _stat_chip("Synthetic", summary.get("synthetic_rob", 0)),
        _stat_chip("Incomplete", summary.get("incomplete_rob", 0)),
    ]
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
{_panel("Primary Studies", _data_table(["Study", "Study ID", "Status", "Tool", "Overall", "Domains", "Matched RoB ID"], study_rows))}
{_panel("Issues", _data_table(["Severity", "Code", "Study", "Message"], issue_rows))}
  </main>"""
    return _render_page(title=title, body=body, extra_css=_ROB_COMPLETENESS_EXTRA_CSS)


def _render_risk_of_bias_completeness_study_row(row: dict) -> str:
    status = str(row.get("status") or "unknown")
    css_class = status if status in {"formal", "missing", "synthetic", "incomplete"} else ""
    return (
        "<tr>"
        f"<td>{escape(str(row.get('study_label') or ''))}</td>"
        f"<td>{escape(str(row.get('study_id') or ''))}</td>"
        f"<td><span class=\"badge {css_class}\">{escape(status)}</span></td>"
        f"<td>{escape(str(row.get('tool_used') or ''))}</td>"
        f"<td>{escape(str(row.get('overall_judgment') or ''))}</td>"
        f"<td>{escape(str(row.get('domain_count') or 0))}</td>"
        f"<td>{escape(str(row.get('matched_rob_study_id') or ''))}</td>"
        "</tr>"
    )


def _render_risk_of_bias_completeness_issue_row(issue: dict) -> str:
    return (
        "<tr>"
        f"<td>{escape(str(issue.get('severity') or ''))}</td>"
        f"<td>{escape(str(issue.get('code') or ''))}</td>"
        f"<td>{escape(str(issue.get('study_label') or issue.get('study_id') or ''))}</td>"
        f"<td>{escape(str(issue.get('message') or ''))}</td>"
        "</tr>"
    )


def _render_benchmark_review_html(review: dict) -> str:
    summary = review.get("summary") or {}
    anchor = review.get("published_anchor") or {}
    observed = review.get("observed_primary") or {}
    alignment = review.get("benchmark_alignment") or {}
    failing_gates = review.get("failing_gates") or []
    missing_full_texts = review.get("missing_primary_full_texts") or []
    next_actions = review.get("next_actions") or []
    source_tasks = review.get("source_acquisition_tasks") or []
    language = _normalize_review_language(review.get("language") or "")
    zh = _is_zh_review_language(language)

    alignment_rows = _render_benchmark_alignment_rows(alignment, language)
    failing_rows = "\n".join(_render_benchmark_gate_row(gate, language) for gate in failing_gates)
    if not failing_rows:
        empty_gates = "未记录未通过的基准质量门。" if zh else "No failing benchmark gates."
        failing_rows = f'<tr><td colspan="4">{empty_gates}</td></tr>'
    missing_rows = "\n".join(_render_missing_full_text_row(item) for item in missing_full_texts)
    if not missing_rows:
        empty_missing = "未记录缺失的主要全文。" if zh else "No missing primary full texts."
        missing_rows = f'<tr><td colspan="4">{empty_missing}</td></tr>'
    action_rows = "\n".join(
        f"<li><strong>{escape(_localized_benchmark_action_type(str(action.get('type') or 'action'), language))}</strong>: "
        f"{escape(_localized_benchmark_action_message(action, language))}</li>"
        for action in next_actions
    )
    if not action_rows:
        action_rows = "<li>未记录下一步动作。</li>" if zh else "<li>No next actions recorded.</li>"
    task_rows = "\n".join(_render_source_acquisition_task_row(task, language) for task in source_tasks)
    if not task_rows:
        empty_tasks = "未记录来源获取任务。" if zh else "No source acquisition tasks."
        task_rows = f'<tr><td colspan="5">{empty_tasks}</td></tr>'
    title = "MetaAgent 基准复现复核" if zh else "MetaAgent Benchmark Review"
    subtitle = (
        "将本项目结果与已发表基准锚点逐项比较，定位复现偏差、缺失全文和需要人工裁决的任务。"
        if zh
        else "Published-anchor comparison for this project package."
    )
    stat_labels = {
        "benchmark": "基准" if zh else "Benchmark",
        "status": "状态" if zh else "Status",
        "passed": "通过" if zh else "Passed",
        "failing_gates": "未通过质量门" if zh else "Failing gates",
        "missing_full_texts": "缺失全文" if zh else "Missing full texts",
        "source_tasks": "来源任务" if zh else "Source tasks",
    }
    section_titles = {
        "published_anchor": "发表锚点" if zh else "Published Anchor",
        "observed_primary": "复现主要结果" if zh else "Observed Primary",
        "alignment": "发表与复现对齐" if zh else "Published vs Reproduced Alignment",
        "failing_gates": "未通过质量门" if zh else "Failing Gates",
        "missing_full_texts": "缺失主要全文" if zh else "Missing Primary Full Texts",
        "source_tasks": "来源获取任务" if zh else "Source Acquisition Tasks",
        "next_actions": "下一步动作" if zh else "Next Actions",
    }
    side_labels = {
        "measure": "效应量类型" if zh else "Measure",
        "effect": "效应量" if zh else "Effect",
        "ci": "95% CI" if zh else "95% CI",
        "trials": "试验数" if zh else "Trials",
        "participants": "参与者数" if zh else "Participants",
        "studies": "研究数" if zh else "Studies",
        "participant_difference": "参与者差异" if zh else "Participant difference",
    }
    alignment_headers = (
        ["检查项", "发表锚点", "复现/审计", "差异"]
        if zh else
        ["Check", "Published anchor", "Reproduced / audit", "Difference"]
    )
    failing_headers = (
        ["质量门", "标签", "观测值", "原因"]
        if zh else
        ["Gate", "Label", "Observed", "Reasons"]
    )
    missing_headers = (
        ["试验", "PMID", "DOI", "注册号"]
        if zh else
        ["Trial", "PMID", "DOI", "Registration"]
    )
    task_headers = (
        ["任务", "试验", "优先级", "状态", "提示"]
        if zh else
        ["Task", "Trial", "Priority", "Status", "Hints"]
    )

    chips = [
        _stat_chip(stat_labels["benchmark"], review.get("benchmark_id") or ""),
        _stat_chip(stat_labels["status"], _localized_benchmark_status(str(review.get("status") or "unknown"), language)),
        _stat_chip(stat_labels["passed"], _localized_benchmark_bool(bool(review.get("passed")), language)),
        _stat_chip(stat_labels["failing_gates"], summary.get("failing_gates", 0)),
        _stat_chip(stat_labels["missing_full_texts"], summary.get("missing_primary_full_texts", 0)),
        _stat_chip(stat_labels["source_tasks"], summary.get("source_acquisition_tasks", 0)),
    ]
    anchor_panel = f"""      <div class="panel">
        <h2>{escape(section_titles["published_anchor"])}</h2>
        <table>
          <tr><th>{escape(side_labels["measure"])}</th><td>{escape(str(anchor.get("effect_measure") or ""))}</td></tr>
          <tr><th>{escape(side_labels["effect"])}</th><td>{escape(str(anchor.get("effect") or ""))}</td></tr>
          <tr><th>{escape(side_labels["ci"])}</th><td>{escape(str(anchor.get("ci_lower") or ""))} to {escape(str(anchor.get("ci_upper") or ""))}</td></tr>
          <tr><th>{escape(side_labels["trials"])}</th><td>{escape(str(anchor.get("n_trials") or ""))}</td></tr>
          <tr><th>{escape(side_labels["participants"])}</th><td>{escape(str(anchor.get("n_participants") or ""))}</td></tr>
        </table>
      </div>"""
    observed_panel = f"""      <div class="panel">
        <h2>{escape(section_titles["observed_primary"])}</h2>
        <table>
          <tr><th>{escape(side_labels["measure"])}</th><td>{escape(str(observed.get("effect_measure") or ""))}</td></tr>
          <tr><th>{escape(side_labels["effect"])}</th><td>{escape(str(observed.get("effect") or ""))}</td></tr>
          <tr><th>{escape(side_labels["ci"])}</th><td>{escape(str(observed.get("ci_lower") or ""))} to {escape(str(observed.get("ci_upper") or ""))}</td></tr>
          <tr><th>{escape(side_labels["studies"])}</th><td>{escape(str(observed.get("n_studies") or ""))}</td></tr>
          <tr><th>{escape(side_labels["participant_difference"])}</th><td>{escape(str(observed.get("participant_difference") or ""))}</td></tr>
        </table>
      </div>"""
    actions_panel = f"""    <section class="panel">
      <h2>{escape(section_titles["next_actions"])}</h2>
      <ul>{action_rows}</ul>
    </section>"""
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
    <section class="grid">
{anchor_panel}
{observed_panel}
    </section>
{_panel(section_titles["alignment"], _data_table(alignment_headers, alignment_rows))}
{_panel(section_titles["failing_gates"], _data_table(failing_headers, failing_rows))}
{_panel(section_titles["missing_full_texts"], _data_table(missing_headers, missing_rows))}
{_panel(section_titles["source_tasks"], _data_table(task_headers, task_rows))}
{actions_panel}
  </main>"""
    return _render_page(title=title, body=body, lang=_html_lang(language), extra_css=_BENCHMARK_EXTRA_CSS)


def _render_benchmark_alignment_rows(alignment: dict, language: str = "en") -> str:
    zh = _is_zh_review_language(language)
    if not isinstance(alignment, dict) or not alignment:
        empty = "未生成基准对齐明细。" if zh else "No benchmark alignment details were generated."
        return f'<tr><td colspan="4">{empty}</td></tr>'
    published = alignment.get("published") if isinstance(alignment.get("published"), dict) else {}
    observed = alignment.get("observed") if isinstance(alignment.get("observed"), dict) else {}
    calculation = alignment.get("calculation_audit") if isinstance(alignment.get("calculation_audit"), dict) else {}
    differences = alignment.get("differences") if isinstance(alignment.get("differences"), dict) else {}
    model_notes = alignment.get("model_compatibility_notes") if isinstance(alignment.get("model_compatibility_notes"), list) else []
    row_count = int(calculation.get("row_count") or 0)
    source_trace = (
        f"source_rows_matched={int(calculation.get('source_rows_matched') or 0)}/{row_count}; "
        f"source_quote_verified={int(calculation.get('source_quote_verified_rows') or 0)}/{row_count}; "
        f"formula_inputs_complete={int(calculation.get('formula_inputs_complete_rows') or 0)}/{row_count}"
    )
    rows = [
        (
            "汇总效应" if zh else "Pooled effect",
            _format_effect_ci(published),
            _format_effect_ci(observed),
            _format_review_number(differences.get("effect")),
        ),
        (
            "计算审计效应" if zh else "Calculation audit effect",
            _format_effect_ci(published),
            _format_effect_ci({
                "effect": calculation.get("pooled_effect"),
                "ci_lower": calculation.get("ci_lower"),
                "ci_upper": calculation.get("ci_upper"),
                "effect_measure": calculation.get("effect_measure"),
            }),
            _format_effect_ci_difference(differences),
        ),
        (
            "模型" if zh else "Model",
            str(published.get("model_preference") or ""),
            str(observed.get("model_preference") or calculation.get("model") or ""),
            _format_model_compatibility(differences.get("model_preference"), model_notes, language),
        ),
        (
            "参与者/研究" if zh else "Participants / studies",
            (
                f"{published.get('n_trials', '')}项试验，{published.get('n_participants', '')}名参与者"
                if zh else
                f"{published.get('n_trials', '')} trial(s), {published.get('n_participants', '')} participant(s)"
            ),
            (
                f"{observed.get('n_studies', '')}项研究，{observed.get('total_participants', '')}名参与者"
                if zh else
                f"{observed.get('n_studies', '')} study/studies, {observed.get('total_participants', '')} participant(s)"
            ),
            _format_review_number(differences.get("participants")),
        ),
        (
            "合并计数" if zh else "Aggregate counts",
            _format_alignment_counts(published),
            _format_alignment_counts(calculation),
            _format_alignment_count_differences(differences, language),
        ),
        (
            "来源可追溯性" if zh else "Source traceability",
            "",
            source_trace,
            ("通过" if alignment.get("passed") else "需复核") if zh else ("passed" if alignment.get("passed") else "review needed"),
        ),
    ]
    return "\n".join(
        "<tr>"
        f"<td>{escape(label)}</td>"
        f"<td>{escape(str(published_value))}</td>"
        f"<td>{escape(str(observed_value))}</td>"
        f"<td>{escape(str(difference))}</td>"
        "</tr>"
        for label, published_value, observed_value, difference in rows
    )


def _format_model_compatibility(model_difference: Any, notes: list[Any], language: str = "en") -> str:
    zh = _is_zh_review_language(language)
    note_text = []
    for note in notes:
        if str(note) == "random_model_equivalent_to_fixed_tau_zero":
            note_text.append(
                "随机效应模型与固定效应锚点数值等价，因为tau平方为0。"
                if zh else
                "Random-effects model is numerically equivalent to the fixed-effect anchor because tau-squared is 0."
            )
        else:
            note_text.append(str(note))
    prefix = str(model_difference or "")
    if note_text and prefix:
        return prefix + " | " + " ".join(note_text)
    if note_text:
        return " ".join(note_text)
    return prefix


def _format_effect_ci(data: dict[str, Any]) -> str:
    effect = _format_review_number(data.get("effect"))
    lower = _format_review_number(data.get("ci_lower"))
    upper = _format_review_number(data.get("ci_upper"))
    measure = str(data.get("effect_measure") or "").strip()
    if not effect:
        return ""
    prefix = f"{measure} " if measure else ""
    if lower and upper:
        return f"{prefix}{effect} ({lower} to {upper})"
    return f"{prefix}{effect}"


def _format_effect_ci_difference(differences: dict[str, Any]) -> str:
    effect = _format_review_number(differences.get("calculation_vs_published_effect"))
    lower = _format_review_number(differences.get("calculation_vs_published_ci_lower"))
    upper = _format_review_number(differences.get("calculation_vs_published_ci_upper"))
    if not effect:
        return ""
    if lower and upper:
        return f"{effect} ({lower} to {upper})"
    return effect


def _format_alignment_counts(data: dict[str, Any]) -> str:
    events_intervention = data.get("aggregate_events_intervention")
    total_intervention = data.get("aggregate_total_intervention")
    events_control = data.get("aggregate_events_control")
    total_control = data.get("aggregate_total_control")
    if None in (events_intervention, total_intervention, events_control, total_control):
        return ""
    return f"{events_intervention}/{total_intervention} vs {events_control}/{total_control}"


def _format_alignment_count_differences(differences: dict[str, Any], language: str = "en") -> str:
    keys = [
        ("events_intervention", "干预组事件" if _is_zh_review_language(language) else "events I"),
        ("total_intervention", "干预组总数" if _is_zh_review_language(language) else "total I"),
        ("events_control", "对照组事件" if _is_zh_review_language(language) else "events C"),
        ("total_control", "对照组总数" if _is_zh_review_language(language) else "total C"),
    ]
    bits = [
        f"{label} {differences[key]:+d}"
        for key, label in keys
        if isinstance(differences.get(key), int)
    ]
    return "; ".join(bits)


def _render_benchmark_gate_row(gate: dict, language: str = "en") -> str:
    observed = []
    for key in ("matched", "total", "recall", "participant_difference"):
        if key in gate:
            observed.append(f"{_localized_benchmark_observed_key(key, language)}={gate.get(key)}")
    reasons = ", ".join(_localized_benchmark_failure_reason(str(item), language) for item in gate.get("failure_reasons") or [])
    return (
        "<tr>"
        f"<td>{escape(_localized_benchmark_gate(str(gate.get('gate') or ''), language))}</td>"
        f"<td>{escape(_localized_benchmark_gate_label(str(gate.get('label') or ''), language))}</td>"
        f"<td>{escape(', '.join(observed))}</td>"
        f"<td class=\"bad\">{escape(reasons)}</td>"
        "</tr>"
    )


def _render_missing_full_text_row(item: dict) -> str:
    return (
        "<tr>"
        f"<td>{escape(str(item.get('trial_name') or item.get('trial_id') or ''))}</td>"
        f"<td>{escape(', '.join(str(pmid) for pmid in item.get('publication_pmids') or []))}</td>"
        f"<td>{escape(', '.join(str(doi) for doi in item.get('publication_dois') or []))}</td>"
        f"<td>{escape(str(item.get('registration_id') or ''))}</td>"
        "</tr>"
    )


def _render_source_acquisition_task_row(task: dict, language: str = "en") -> str:
    hints = ", ".join(str(item) for item in task.get("accepted_file_hints") or [])
    uploaded = task.get("uploaded_sources") or []
    if uploaded:
        upload_bits = []
        for source in uploaded:
            quote_candidates = source.get("quote_candidates") or []
            candidate_note = ""
            if quote_candidates:
                first_candidate = quote_candidates[0]
                matched = ", ".join(str(value) for value in first_candidate.get("matched_values") or [])
                decision = first_candidate.get("review_decision") or {}
                label = "quote candidate" if len(quote_candidates) == 1 else "quote candidates"
                if _is_zh_review_language(language):
                    label = "条引用候选"
                candidate_note = f", {len(quote_candidates)} {label}"
                if matched:
                    candidate_note = (
                        f"{candidate_note}, 匹配 {matched}"
                        if _is_zh_review_language(language) else
                        f"{candidate_note}, matched {matched}"
                    )
                if decision.get("decision"):
                    by = (
                        f" 由 {decision.get('updated_by')}" if _is_zh_review_language(language) and decision.get("updated_by")
                        else f" by {decision.get('updated_by')}" if decision.get("updated_by")
                        else ""
                    )
                    candidate_note = f"{candidate_note}, {_localized_benchmark_decision(str(decision.get('decision')), language)}{by}"
            upload_bits.append(
                f"{source.get('filename', '')} "
                f"({source.get('parse_status', 'unknown')}, "
                f"{source.get('text_chars', 0)} {'字符' if _is_zh_review_language(language) else 'chars'}, "
                f"{source.get('table_count', 0)} {'张表' if _is_zh_review_language(language) else 'tables'}"
                f"{candidate_note})"
            )
        upload_label = "已上传" if _is_zh_review_language(language) else "Uploaded"
        hints = f"{hints} | {upload_label}: {'; '.join(upload_bits)}"
    return (
        "<tr>"
        f"<td>{escape(_localized_benchmark_task_type(str(task.get('task_type') or ''), language))}</td>"
        f"<td>{escape(str(task.get('trial_name') or task.get('trial_id') or ''))}</td>"
        f"<td>{escape(_localized_benchmark_priority(str(task.get('priority') or ''), language))}</td>"
        f"<td>{escape(_localized_benchmark_task_status(str(task.get('status') or ''), language))}</td>"
        f"<td>{escape(hints)}</td>"
        "</tr>"
    )


def _localized_benchmark_status(status: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return status
    return {"passed": "已通过", "blocked": "阻断", "warning": "警告", "unknown": "未知"}.get(status, status)


def _localized_benchmark_bool(value: bool, language: str) -> str:
    if _is_zh_review_language(language):
        return "是" if value else "否"
    return str(value)


def _localized_benchmark_action_type(action_type: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return action_type
    return {
        "upload_full_text": "上传主要全文",
        "action": "动作",
    }.get(action_type, action_type)


def _localized_benchmark_action_message(action: dict, language: str) -> str:
    message = str(action.get("message") or "")
    if not _is_zh_review_language(language):
        return message
    if str(action.get("type") or "") == "upload_full_text":
        return "上传缺失的主要全文并重新运行来源复核。"
    return {
        "Upload the missing primary full text before submission.": "上传缺失的主要全文并重新运行来源复核。",
    }.get(message, message)


def _localized_benchmark_failure_reason(reason: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return reason
    return {
        "pooled_effect_mismatch": "汇总效应不匹配",
        "pooled_ci_mismatch": "置信区间不匹配",
        "effect_measure_mismatch": "效应量类型不匹配",
        "model_preference_mismatch": "模型偏好不匹配",
        "missing_primary_full_text": "缺失主要全文",
    }.get(reason, reason)


def _localized_benchmark_gate(gate: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return gate
    return {
        "pooled_effect": "汇总效应",
        "primary_full_texts": "主要全文",
        "trial_recall": "试验召回",
    }.get(gate, gate)


def _localized_benchmark_gate_label(label: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return label
    return {
        "Pooled effect": "汇总效应",
    }.get(label, label)


def _localized_benchmark_observed_key(key: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return key
    return {
        "matched": "匹配数",
        "total": "总数",
        "recall": "召回率",
        "participant_difference": "参与者差异",
    }.get(key, key)


def _localized_benchmark_task_type(task_type: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return task_type
    return {
        "full_text_upload": "全文上传",
        "primary_count_source": "主要计数来源",
        "primary_count_discrepancy_source": "主要计数差异来源",
        "primary_source_request": "主要来源请求",
        "timepoint_adjudication_source": "时间点裁决来源",
    }.get(task_type, task_type)


def _localized_benchmark_priority(priority: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return priority
    return {"high": "高", "medium": "中", "low": "低"}.get(priority, priority)


def _localized_benchmark_task_status(status: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return status
    return {
        "needs_full_text_upload": "需要上传全文",
        "needs_primary_source": "需要主要来源",
        "needs_protocol_decision": "需要方案裁决",
        "needs_timepoint_adjudication": "需要时间点裁决",
        "source_candidate_accepted_needs_override": "来源候选已接受，需写入覆盖",
        "uploaded_needs_review": "已上传，需复核",
    }.get(status, status)


def _localized_benchmark_decision(decision: str, language: str) -> str:
    if not _is_zh_review_language(language):
        return decision
    return {"accepted": "已接受", "rejected": "已拒绝"}.get(decision, decision)
