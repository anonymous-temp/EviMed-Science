"""Snapshot and repair helpers for deterministic GRADE inputs."""
from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any

from new_meta.agents.grade_agent import GRADEAgent
from new_meta.core.project import Project
from new_meta.schemas.grade import GRADEDomain, GRADEOutcome, GRADEProfile
from new_meta.schemas.meta_result import MetaAnalysisResults
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.schemas.risk_of_bias import StudyRoB
from new_meta.schemas.study import ExtractedStudy


def build_grade_input_snapshot(
    *,
    project: Project | None,
    protocol: ResearchProtocol,
    meta_results: MetaAnalysisResults,
    rob_results: list[StudyRoB] | None = None,
    extracted_studies: list[ExtractedStudy] | None = None,
) -> dict[str, Any]:
    """Return a stable snapshot of the evidence that GRADE is allowed to use."""
    rob_results = rob_results or []
    extracted_studies = extracted_studies or []
    primary = meta_results.primary_outcome
    primary_ids = [str(study.study_id) for study in primary.studies]
    selected_rows = _selected_effect_rows(project, primary_ids, primary.outcome_name)
    selected_total_n = _selected_total_n_from_rows(selected_rows)
    selected_verified_count = sum(1 for row in selected_rows if row.get("source_quote_verified") is True)
    if selected_total_n <= 0:
        selected_total_n = _selected_total_n_from_extracted(extracted_studies, set(primary_ids), primary.outcome_name)

    selected_result_ids = {
        str(row.get("result_id") or "")
        for row in selected_rows
        if row.get("result_id")
    }
    rob_counts = _rob_counts(
        rob_results,
        set(primary_ids),
        selected_result_ids=selected_result_ids,
    )
    payload = {
        "schema_version": 1,
        "primary_outcome": primary.outcome_name,
        "effect_measure": primary.effect_measure,
        "primary_study_ids": primary_ids,
        "primary_study_count": len(primary_ids),
        "selected_total_n": int(selected_total_n),
        "selected_source_verified_count": int(selected_verified_count),
        "selected_row_ids": [str(row.get("row_id") or "") for row in selected_rows if row.get("row_id")],
        "rob_counts": rob_counts,
        "protocol_effect_measure": protocol.effect_measure,
        "protocol_model_preference": protocol.model_preference,
        "protocol_tau_estimator": protocol.tau_estimator,
    }
    payload["snapshot_hash"] = _stable_hash({k: v for k, v in payload.items() if k != "snapshot_hash"})
    return payload


def save_grade_input_snapshot(
    *,
    project: Project | None,
    protocol: ResearchProtocol,
    meta_results: MetaAnalysisResults,
    rob_results: list[StudyRoB] | None = None,
    extracted_studies: list[ExtractedStudy] | None = None,
) -> dict[str, Any]:
    snapshot = build_grade_input_snapshot(
        project=project,
        protocol=protocol,
        meta_results=meta_results,
        rob_results=rob_results,
        extracted_studies=extracted_studies,
    )
    if project is not None:
        project.save_json("grade_inputs_snapshot.json", snapshot, subdir="analysis")
    return snapshot


def cached_grade_snapshot_matches(project: Project | None, snapshot: dict[str, Any]) -> bool:
    if project is None:
        return False
    cached = project.load_json("grade_inputs_snapshot.json", subdir="analysis")
    if not isinstance(cached, dict):
        return False
    return str(cached.get("snapshot_hash") or "") == str(snapshot.get("snapshot_hash") or "")


def repair_grade_profile_with_snapshot(
    grade_profile: GRADEProfile | None,
    snapshot: dict[str, Any] | None,
) -> GRADEProfile | None:
    """Force GRADE profile text/details to use the frozen selected-row inputs."""
    if grade_profile is None or not isinstance(snapshot, dict):
        return grade_profile
    selected_total_n = int(snapshot.get("selected_total_n") or 0)
    primary_study_count = int(snapshot.get("primary_study_count") or 0)
    if selected_total_n <= 0:
        return grade_profile

    repaired_outcomes: list[GRADEOutcome] = []
    for outcome in grade_profile.outcomes:
        repaired_domains: list[GRADEDomain] = []
        for domain in outcome.domains:
            if domain.domain != "imprecision":
                repaired_domains.append(domain)
                continue
            details = dict(domain.details or {})
            details["total_n"] = selected_total_n
            details["n_studies"] = int(details.get("n_studies") or primary_study_count or outcome.n_studies)
            details["matched_count"] = int(details.get("matched_count") or primary_study_count or outcome.n_studies)
            details["total_source"] = "selected_pooled_rows"
            rating = _imprecision_rating_from_details(details)
            repaired_domains.append(
                domain.model_copy(
                    update={
                        "rating": rating,
                        "rationale": GRADEAgent._grade_rationale("imprecision", rating, details),
                        "details": details,
                    }
                )
            )
        repaired_outcomes.append(outcome.model_copy(update={"domains": repaired_domains}))
    return grade_profile.model_copy(update={"outcomes": repaired_outcomes})


def _selected_effect_rows(project: Project | None, primary_ids: list[str], outcome_name: str) -> list[dict[str, Any]]:
    if project is None:
        return []
    rows = project.load_json("effect_selection_audit.json", subdir="analysis") or []
    if not isinstance(rows, list):
        return []
    id_set = {str(value) for value in primary_ids if value}
    target = _norm(outcome_name)
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        if row.get("in_final_primary_analysis") is False:
            continue
        study_id = str(row.get("study_id") or "").strip()
        if id_set and study_id not in id_set:
            continue
        row_outcome = _norm(str(row.get("outcome_name") or ""))
        if target and row_outcome and not _compatible(target, row_outcome):
            continue
        key = str(row.get("row_id") or study_id or len(selected))
        if key in seen:
            continue
        seen.add(key)
        selected.append(row)
    return selected


def _selected_total_n_from_rows(rows: list[dict[str, Any]]) -> int:
    total = 0
    for row in rows:
        for left, right in (("total_intervention", "total_control"), ("n_intervention", "n_control")):
            a = _int_or_none(row.get(left))
            b = _int_or_none(row.get(right))
            if a is not None and b is not None:
                total += a + b
                break
    return int(total)


def _selected_total_n_from_extracted(studies: list[ExtractedStudy], primary_ids: set[str], outcome_name: str) -> int:
    target = _norm(outcome_name)
    by_id: dict[str, int] = {}
    for study in studies:
        sid = _study_id(study)
        if primary_ids and sid not in primary_ids:
            continue
        best_total = 0
        best_score = -1
        for outcome in getattr(study, "outcomes", []) or []:
            row_name = _norm(getattr(outcome, "outcome_name", "") or "")
            if target and row_name and not _compatible(target, row_name):
                continue
            total = _outcome_total(outcome)
            if total <= 0:
                continue
            score = 0
            if row_name == target:
                score += 3
            if getattr(outcome, "source_quote_verified", False):
                score += 2
            if score > best_score:
                best_score = score
                best_total = total
        if sid and best_total > 0:
            by_id[sid] = best_total
    return int(sum(by_id.values()))


def _rob_counts(
    rob_results: list[StudyRoB],
    primary_ids: set[str],
    *,
    selected_result_ids: set[str] | None = None,
) -> dict[str, int]:
    from new_meta.schemas.risk_of_bias import ResultRoBAssessment

    selected_result_ids = selected_result_ids or set()
    result_specific_study_ids = {
        str(item.study_id)
        for item in rob_results
        if isinstance(item, ResultRoBAssessment)
        and (not selected_result_ids or item.result_id in selected_result_ids)
    }
    counts = {
        "high": 0,
        "some_concerns": 0,
        "low": 0,
        "unknown": 0,
        "not_formally_assessed": 0,
        "result_specific": 0,
        "legacy_study_level": 0,
    }
    for item in rob_results:
        sid = str(getattr(item, "study_id", "") or "")
        if primary_ids and sid not in primary_ids:
            continue
        if isinstance(item, ResultRoBAssessment):
            if selected_result_ids and item.result_id not in selected_result_ids:
                continue
            counts["result_specific"] += 1
        else:
            if sid in result_specific_study_ids:
                continue
            counts["legacy_study_level"] += 1
        judgment = str(getattr(item, "overall_judgment", "") or "").lower()
        if getattr(item, "is_synthetic", False) or "not assessed" in judgment or "insufficient information" in judgment:
            counts["not_formally_assessed"] += 1
        elif judgment.startswith("high"):
            counts["high"] += 1
        elif "some" in judgment:
            counts["some_concerns"] += 1
        elif "low" in judgment:
            counts["low"] += 1
        else:
            counts["unknown"] += 1
    counts["assessed"] = sum(
        counts[key]
        for key in ("high", "some_concerns", "low", "unknown", "not_formally_assessed")
    )
    return counts


def _imprecision_rating_from_details(details: dict[str, Any]) -> str:
    total_n = int(details.get("total_n") or 0)
    ois = int(details.get("ois") or 0)
    n_studies = int(details.get("n_studies") or 0)
    crosses_null = bool(details.get("crosses_null"))
    ci_width = _float_or_none(details.get("ci_width"))
    measure = str(details.get("effect_measure") or "").upper()
    is_ratio = measure in {"OR", "RR", "HR", "IRR"}
    concerns = 0
    if ois and total_n < ois:
        concerns += 1
    if crosses_null:
        concerns += 1
    if ci_width is not None and n_studies < 3 and ci_width > (1.0 if is_ratio else 0.5):
        concerns += 1
    if concerns >= 2:
        return "very serious"
    if concerns == 1:
        return "serious"
    return "no concern"


def _stable_hash(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _study_id(study: ExtractedStudy) -> str:
    c = getattr(study, "characteristics", None)
    for attr in ("pmid", "study_id", "doi"):
        value = str(getattr(c, attr, "") or "").strip()
        if value:
            return value
    return ""


def _outcome_total(outcome: Any) -> int:
    for left, right in (("total_intervention", "total_control"), ("n_intervention", "n_control")):
        a = _int_or_none(getattr(outcome, left, None))
        b = _int_or_none(getattr(outcome, right, None))
        if a is not None and b is not None:
            return a + b
    total_n = _int_or_none(getattr(outcome, "total_n", None))
    return total_n or 0


def _int_or_none(value: Any) -> int | None:
    try:
        if value is None:
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _float_or_none(value: Any) -> float | None:
    try:
        if value is None:
            return None
        value = float(value)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def _norm(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def _compatible(target: str, candidate: str) -> bool:
    return target == candidate or target in candidate or candidate in target
