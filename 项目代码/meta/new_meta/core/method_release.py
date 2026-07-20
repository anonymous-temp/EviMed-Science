"""Fail-closed release checks for compiled non-pairwise synthesis methods."""
from __future__ import annotations

from typing import Any

from new_meta.core.evidence_ledger import EvidenceLedger
from new_meta.core.method_certainty import (
    current_result_risk_of_bias_fingerprint,
    synthesis_result_fingerprint,
)
from new_meta.core.result_rob import load_effective_rob_assessments


def build_method_release_review(project) -> dict[str, Any] | None:
    plan = project.load_json("method_plan.json", subdir="analysis")
    route = project.load_json("synthesis_route.json", subdir="analysis")
    if not isinstance(plan, dict) or not isinstance(route, dict):
        return None
    if route.get("route") != "method_plugin":
        return None

    validation = project.load_json("method_validation_snapshot.json", subdir="analysis") or {}
    method_result = project.load_json("method_result.json", subdir="analysis") or {}
    input_audit = project.load_json("method_input_audit.json", subdir="analysis") or {}
    analysis_set = project.load_json("analysis_set.json", subdir="analysis") or {}
    synthesis = project.load_json("synthesis_result.json", subdir="analysis") or {}
    manuscript_validation = project.load_json("manuscript_validation.json", subdir="manuscript") or {}
    identity = project.load_json("review_identity.json", subdir="evidence") or {}
    review_id = str(identity.get("review_id") or "")
    ledger_head = ""
    ledger_valid = False
    ledger_errors: list[str] = []
    if review_id:
        verification = EvidenceLedger(
            project.get_path("ledger.jsonl", subdir="evidence"),
            review_id=review_id,
        ).verify()
        ledger_head = verification.head_hash
        ledger_valid = verification.valid
        ledger_errors = verification.errors

    fingerprint = str(plan.get("plan_fingerprint") or "")
    capability = validation.get("capability") or {}
    validation_ok = bool(
        fingerprint
        and plan.get("capability_status") == "production"
        and capability.get("release_status") == "production"
        and validation.get("manifest_fingerprint") == plan.get("validation_manifest_fingerprint")
        and capability.get("capability_id") == plan.get("capability_id")
        and capability.get("evidence")
    )
    checks: list[dict[str, Any]] = []
    _add_check(
        checks,
        "capability_validation",
        validation_ok,
        (
            f"capability={plan.get('capability_id')}; status={plan.get('capability_status')}; "
            f"evidence={len(capability.get('evidence') or [])}"
        ),
        "method_capability_not_production_validated",
    )
    snapshot_ok = bool(
        ledger_valid
        and ledger_head
        and input_audit.get("ledger_head_hash") == ledger_head
        and method_result.get("input_ledger_head_hash") == ledger_head
    )
    _add_check(
        checks,
        "ledger_snapshot_integrity",
        snapshot_ok,
        (
            f"ledger_valid={ledger_valid}; current_head={ledger_head}; "
            f"snapshot_head={input_audit.get('ledger_head_hash')}; errors={ledger_errors[:3]}"
        ),
        "method_ledger_snapshot_mismatch",
    )
    audit_ids = [str(item.get("result_id") or "") for item in input_audit.get("inputs") or []]
    method_ids = [str(item) for item in method_result.get("input_result_ids") or []]
    synthesis_ids = [str(item) for item in synthesis.get("input_result_ids") or []]
    fingerprints_ok = all(
        payload.get(key) == fingerprint
        for payload, key in (
            (route, "plan_fingerprint"),
            (method_result, "plan_fingerprint"),
            (input_audit, "plan_fingerprint"),
            (synthesis, "method_plan_fingerprint"),
        )
    )
    source_inputs_valid = bool(audit_ids) and all(
        item.get("evidence_state") in {"verified", "adjudicated"}
        and any(locator.get("quote_verified") is True for locator in item.get("source_locators") or [])
        for item in input_audit.get("inputs") or []
    )
    exact_inputs_ok = bool(
        fingerprints_ok
        and audit_ids == method_ids == synthesis_ids
        and len(audit_ids) == len(set(audit_ids))
        and source_inputs_valid
        and synthesis.get("execution_converged") is not False
    )
    _add_check(
        checks,
        "exact_method_inputs",
        exact_inputs_ok,
        (
            f"audit_inputs={len(audit_ids)}; method_inputs={len(method_ids)}; "
            f"synthesis_inputs={len(synthesis_ids)}; source_verified={source_inputs_valid}; "
            f"fingerprints_match={fingerprints_ok}; converged={synthesis.get('execution_converged')}"
        ),
        "method_inputs_or_execution_invalid",
    )
    analysis_set_ok = bool(
        analysis_set.get("status") in {"automatic", "adjudicated"}
        and analysis_set.get("plan_fingerprint") == fingerprint
        and analysis_set.get("ledger_head_hash") == ledger_head
        and [str(item) for item in analysis_set.get("result_ids") or []] == audit_ids
        and analysis_set.get("candidate_id") == input_audit.get("analysis_set_candidate_id")
        and int(analysis_set.get("revision") or 0)
        == int(input_audit.get("analysis_set_revision") or 0)
    )
    _add_check(
        checks,
        "versioned_analysis_set",
        analysis_set_ok,
        (
            f"status={analysis_set.get('status') or 'missing'}; "
            f"revision={analysis_set.get('revision')}; "
            f"results={len(analysis_set.get('result_ids') or [])}; "
            f"ledger_current={analysis_set.get('ledger_head_hash') == ledger_head}"
        ),
        "analysis_set_missing_or_stale",
    )

    assessments = load_effective_rob_assessments(project, [])
    completed_result_ids = {
        str(getattr(item, "result_id", "") or "")
        for item in assessments
        if str(getattr(getattr(item, "assessment_status", None), "value", "")).lower()
        in {"complete", "adjudicated"}
        and getattr(item, "is_result_specific", False)
    }
    missing_rob = [result_id for result_id in audit_ids if result_id not in completed_result_ids]
    rob_ok = bool(audit_ids) and not missing_rob
    _add_check(
        checks,
        "result_level_risk_of_bias",
        rob_ok,
        f"completed={len(completed_result_ids)}; required={len(audit_ids)}; missing={missing_rob}",
        "result_level_risk_of_bias_incomplete",
    )

    certainty = project.load_json("method_certainty.json", subdir="analysis") or {}
    current_synthesis_fingerprint = (
        synthesis_result_fingerprint(synthesis) if synthesis else ""
    )
    current_rob_fingerprint = current_result_risk_of_bias_fingerprint(project, audit_ids)
    certainty_ok = bool(
        certainty.get("status") == "completed"
        and certainty.get("plan_fingerprint") == fingerprint
        and [str(item) for item in certainty.get("input_result_ids") or []] == audit_ids
        and certainty.get("synthesis_fingerprint") == current_synthesis_fingerprint
        and certainty.get("input_ledger_head_hash") == ledger_head
        and certainty.get("risk_of_bias_fingerprint") == current_rob_fingerprint
        and certainty.get("outcomes")
    )
    _add_check(
        checks,
        "method_specific_certainty",
        certainty_ok,
        (
            f"status={certainty.get('status') or 'missing'}; "
            f"outcomes={len(certainty.get('outcomes') or [])}; "
            f"synthesis_current={certainty.get('synthesis_fingerprint') == current_synthesis_fingerprint}; "
            f"ledger_current={certainty.get('input_ledger_head_hash') == ledger_head}; "
            f"risk_of_bias_current={certainty.get('risk_of_bias_fingerprint') == current_rob_fingerprint}"
        ),
        "method_specific_certainty_missing",
    )

    manuscript_certainty_current = bool(
        certainty_ok
        and manuscript_validation.get("method_certainty_status") == certainty.get("status")
        and int(manuscript_validation.get("method_certainty_revision") or 0)
        == int(certainty.get("revision") or 0)
        and manuscript_validation.get("method_certainty_synthesis_fingerprint")
        == current_synthesis_fingerprint
        and manuscript_validation.get("method_certainty_ledger_head_hash") == ledger_head
    )
    _add_check(
        checks,
        "method_manuscript_current_certainty",
        manuscript_certainty_current,
        (
            f"certainty_status={certainty.get('status') or 'missing'}; "
            f"certainty_revision={int(certainty.get('revision') or 0)}; "
            f"manuscript_status={manuscript_validation.get('method_certainty_status') or 'missing'}; "
            f"manuscript_revision={int(manuscript_validation.get('method_certainty_revision') or 0)}"
        ),
        "method_manuscript_certainty_stale",
    )

    manuscript_ok = bool(
        manuscript_validation.get("passed") is True
        and manuscript_validation.get("method_family") == plan.get("family")
        and manuscript_validation.get("method_plan_fingerprint") == fingerprint
        and manuscript_validation.get("exact_result_values_present") is True
    )
    _add_check(
        checks,
        "method_manuscript_fact_lock",
        manuscript_ok,
        (
            f"validation_passed={manuscript_validation.get('passed')}; "
            f"family={manuscript_validation.get('method_family')}"
        ),
        "method_manuscript_not_fact_locked",
    )
    blockers = [item["blocker_code"] for item in checks if not item["passed"]]
    return {
        "schema_version": 1,
        "status": "ready" if not blockers else "blocked",
        "passed": not blockers,
        "family": plan.get("family"),
        "capability_id": plan.get("capability_id"),
        "plan_fingerprint": fingerprint,
        "blocker_codes": blockers,
        "checks": checks,
    }


def attach_method_release_gate(readiness: dict | None, method_review: dict | None) -> dict | None:
    if readiness is None or method_review is None:
        return readiness
    gates = readiness.setdefault("gates", [])
    gates.append({
        "id": "compiled_method_release",
        "name": "Compiled method release",
        "passed": method_review.get("passed") is True,
        "status": "pass" if method_review.get("passed") is True else "fail",
        "warning": False,
        "detail": (
            f"capability={method_review.get('capability_id')}; "
            f"failed_checks={', '.join(method_review.get('blocker_codes') or []) or 'none'}"
        ),
    })
    failed = sum(1 for gate in gates if gate.get("status") == "fail")
    warnings = sum(1 for gate in gates if gate.get("status") == "warn")
    readiness["passed"] = failed == 0
    readiness["status"] = "blocked" if failed else "ready_with_warnings" if warnings else "ready"
    readiness["summary"] = {
        "total_gates": len(gates),
        "passed_gates": sum(1 for gate in gates if gate.get("status") == "pass"),
        "warning_gates": warnings,
        "failed_gates": failed,
    }
    return readiness


def _add_check(
    checks: list[dict[str, Any]],
    check_id: str,
    passed: bool,
    detail: str,
    blocker_code: str,
) -> None:
    checks.append({
        "id": check_id,
        "passed": bool(passed),
        "status": "pass" if passed else "fail",
        "detail": detail,
        "blocker_code": blocker_code,
    })
