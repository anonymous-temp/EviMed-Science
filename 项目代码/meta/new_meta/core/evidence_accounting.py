"""Every count a report quotes about the evidence, taken from the engine's own records.

The delivered ma-001 report (2026-09-28) contradicted itself - "七类计数相加为
165" in one section, "类别之和等于 141" in another - because the run added up
counts itself. The totals are the engine's: PRISMA counts from prisma_flow.json,
what was pooled from the synthesis result, what was left out and why from the
synthesis warning. Arithmetic identities are checked here, in code, and their
outcome is recorded next to the numbers; nothing in this file is estimated.
"""
from __future__ import annotations

import json
from typing import Any

ACCOUNTING_FILE = "evidence_accounting.json"
ACCOUNTING_SUBDIR = "package"


def _int(value) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _pooled(project) -> dict[str, Any]:
    synthesis = project.load_json("synthesis_result.json", subdir="analysis")
    if isinstance(synthesis, dict) and synthesis.get("input_result_ids"):
        results = [str(item) for item in synthesis["input_result_ids"]]
        studies = sorted({item.removeprefix("result:").rsplit(":", 1)[0] for item in results})
        return {"source": "analysis/synthesis_result.json", "results_pooled": len(results),
                "studies_pooled": len(studies), "pooled_study_ids": studies}
    meta = project.load_json("meta_results.json", subdir="analysis")
    primary = meta.get("primary_outcome") if isinstance(meta, dict) else None
    if isinstance(primary, dict):
        studies = sorted({str(item.get("study_id") or "") for item in primary.get("studies") or []
                          if isinstance(item, dict)} - {""})
        return {"source": "analysis/meta_results.json", "results_pooled": len(studies),
                "studies_pooled": len(studies), "pooled_study_ids": studies}
    return {"source": None, "results_pooled": 0, "studies_pooled": 0, "pooled_study_ids": []}


def _left_out(project) -> dict[str, Any]:
    try:
        warnings = json.loads((project.base_dir / "pipeline_warnings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        warnings = []
    for warning in warnings if isinstance(warnings, list) else []:
        if isinstance(warning, dict) and warning.get("code") == "unverified_results_left_out":
            results = (warning.get("context") or {}).get("results") or {}
            reasons: dict[str, int] = {}
            for reason in results.values():
                reasons[str(reason)] = reasons.get(str(reason), 0) + 1
            return {"results_left_out": len(results), "reasons": reasons, "results": dict(results)}
    return {"results_left_out": 0, "reasons": {}, "results": {}}


def build_evidence_accounting(project) -> dict[str, Any]:
    flow = project.load_json("prisma_flow.json") or {}
    identification = flow.get("identification") or {}
    screening = flow.get("screening") or {}
    eligibility = flow.get("eligibility") or {}
    included = flow.get("included") or {}
    counts = {
        "records_identified": _int(identification.get("records_identified")),
        "identified_by_source": identification.get("identified_by_source") or {},
        "database_hits": identification.get("database_hits") or {},
        "duplicates_removed": _int(identification.get("duplicates_removed")),
        "removed_by_automation_tools": _int(identification.get("automation_excluded")),
        "removed_for_other_reasons": _int(identification.get("records_removed_other")),
        "removed_before_screening_reasons": identification.get("records_not_screened_reasons") or {},
        "screening_cap": identification.get("screening_cap") or {},
        "records_screened": _int(screening.get("title_abstract_screened")),
        "records_excluded_at_screening": _int(screening.get("title_abstract_excluded")),
        "reports_sought": _int(eligibility.get("full_text_sought")),
        "reports_not_retrieved": _int(eligibility.get("not_retrieved")),
        "reports_not_retrieved_reasons": eligibility.get("not_retrieved_reasons") or {},
        "reports_assessed": _int(eligibility.get("full_text_assessed")),
        "reports_excluded": _int(eligibility.get("full_text_excluded")),
        "studies_included": _int(included.get("studies_included")),
    }
    if counts["removed_for_other_reasons"] is None and counts["removed_by_automation_tools"] is not None:
        # A flow written before automation and other removals were separated.
        counts["removed_for_other_reasons"] = max(
            0, (_int(identification.get("records_not_screened")) or 0) - counts["removed_by_automation_tools"])
    pooled, left_out = _pooled(project), _left_out(project)

    checks = []

    def identity(name: str, left: list[str], right: str) -> None:
        values = [counts.get(key) for key in left] + [counts.get(right)]
        if any(value is None for value in values):
            checks.append({"identity": name, "holds": None, "reason": "a count was not recorded"})
            return
        lhs = values[0] - sum(values[1:-1])
        checks.append({"identity": name, "holds": lhs == values[-1], "computed": lhs, "recorded": values[-1]})

    identity("identified - duplicates - automation - other = screened",
             ["records_identified", "duplicates_removed", "removed_by_automation_tools",
              "removed_for_other_reasons"], "records_screened")
    identity("screened - excluded = sought", ["records_screened", "records_excluded_at_screening"],
             "reports_sought")
    identity("sought - not retrieved = assessed", ["reports_sought", "reports_not_retrieved"], "reports_assessed")
    identity("assessed - excluded = included", ["reports_assessed", "reports_excluded"], "studies_included")
    return {"schema_version": 1, "source": "prisma_flow.json", "counts": counts,
            "synthesis": {**pooled, **left_out}, "arithmetic": checks}


def write_evidence_accounting(project) -> dict[str, Any]:
    accounting = build_evidence_accounting(project)
    project.save_json(ACCOUNTING_FILE, accounting, subdir=ACCOUNTING_SUBDIR)
    return accounting
