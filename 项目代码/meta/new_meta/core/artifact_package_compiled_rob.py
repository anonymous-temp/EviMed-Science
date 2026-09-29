"""Risk-of-bias completeness of the results a compiled-method synthesis pooled.

The compiled-method route never writes analysis/meta_results.json (and
clears a stale one); its pooled inputs are synthesis_result.json's
input_result_ids. The package's completeness review read only
meta_results.json and returned nothing on that route, so the release gate
passed unchecked on every compiled run - production ma-001 (2026-09-28)
included.
"""
from __future__ import annotations

from typing import Any


def build_compiled_risk_of_bias_completeness_review(project) -> dict | None:
    """Require a completed result-level assessment for each result the compiled synthesis pooled."""
    from new_meta.core.artifact_package import (
        _result_risk_of_bias_record_status, _result_risk_of_bias_status_message,
    )
    synthesis = project.load_json("synthesis_result.json", subdir="analysis")
    if not isinstance(synthesis, dict):
        return None
    result_ids = [str(item) for item in synthesis.get("input_result_ids") or [] if str(item or "").strip()]
    if not result_ids:
        return None
    assessments = project.load_json("rob_result_assessments.json", subdir="risk_of_bias") or []
    by_result = {str(item.get("result_id") or ""): item for item in assessments
                 if isinstance(item, dict) and item.get("result_id")}
    rows: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    for result_id in result_ids:
        assessment = by_result.get(result_id)
        status = _result_risk_of_bias_record_status(assessment)
        formal = status == "formal"
        study_id = result_id.removeprefix("result:").rsplit(":", 1)[0]
        issue_code = "" if formal else {
            "missing": "primary_result_missing_formal_rob",
            "pending": "primary_result_rob_pending_adjudication",
            "synthetic": "primary_result_synthetic_rob",
            "incomplete": "primary_result_incomplete_rob",
        }.get(status, "primary_result_incomplete_rob")
        rows.append({
            "study_id": study_id, "study_label": study_id, "result_id": result_id, "row_id": "",
            "outcome_name": str((assessment or {}).get("outcome_name") or ""),
            "status": status, "formal": formal,
            "tool_used": str((assessment or {}).get("tool_used") or ""),
            "tool_version": str((assessment or {}).get("tool_version") or ""),
            "overall_judgment": str((assessment or {}).get("overall_judgment") or ""),
            "domain_count": len((assessment or {}).get("domains") or []),
            "assessment_status": str((assessment or {}).get("assessment_status") or ""),
            "issue_code": issue_code,
        })
        if not formal:
            issues.append({"code": issue_code, "severity": "fail", "study_id": study_id, "result_id": result_id,
                           "study_label": study_id, "message": _result_risk_of_bias_status_message(status)})
    formal_count = sum(1 for row in rows if row["status"] == "formal")
    summary = {
        "scope": "result",
        "route": "compiled_method",
        "primary_outcome": rows[0]["outcome_name"] if rows else "",
        "primary_contributing_studies": len({row["study_id"] for row in rows}),
        "primary_contributing_results": len(rows),
        "formal_rob": formal_count,
        "result_specific_rob": formal_count,
        "legacy_study_level_rob": 0,
        "pending_result_rob": sum(1 for row in rows if row["status"] == "pending"),
        "missing_formal_rob": sum(1 for row in rows if row["status"] == "missing"),
        "synthetic_rob": sum(1 for row in rows if row["status"] == "synthetic"),
        "incomplete_rob": sum(1 for row in rows if row["status"] in {"incomplete", "pending"}),
        "failed_issues": len(issues),
    }
    return {"schema_version": 2, "status": "ready" if not issues else "blocked", "passed": not issues,
            "summary": summary, "studies": rows, "results": rows, "issues": issues}
