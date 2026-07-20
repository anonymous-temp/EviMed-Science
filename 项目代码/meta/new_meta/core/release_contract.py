"""Terminal release-state contract shared by CLI, Web, API and packages."""
from __future__ import annotations

from enum import Enum
from pathlib import Path
from typing import Any

from new_meta.core.project import Project


class ReleaseStatus(str, Enum):
    READY = "ready"
    READY_WITH_WARNINGS = "ready_with_warnings"
    BLOCKED = "blocked"


RELEASE_DECISION_FILE = "release_decision.json"


class ReleaseBlockedError(RuntimeError):
    """Raised when an entry point attempts to finish a blocked submission."""

    def __init__(self, decision: dict[str, Any]):
        self.decision = decision
        codes = ", ".join(decision.get("blocker_codes") or []) or "unknown_release_blocker"
        super().__init__(f"Submission release is blocked: {codes}")


def _gate_rows(readiness: dict[str, Any], status: str) -> list[dict[str, Any]]:
    return [
        gate
        for gate in (readiness.get("gates") or [])
        if isinstance(gate, dict) and str(gate.get("status") or "").strip().lower() == status
    ]


def _gate_codes(gates: list[dict[str, Any]], *, fallback: str) -> list[str]:
    codes = [str(gate.get("id") or gate.get("name") or "").strip() for gate in gates]
    return [code for code in codes if code] or [fallback]


def build_release_decision(
    submission_readiness: dict[str, Any] | None,
    *,
    package_path: str | Path | None = None,
) -> dict[str, Any]:
    """Normalize package readiness into one terminal, harness-friendly decision."""
    readiness = submission_readiness if isinstance(submission_readiness, dict) else {}
    raw_status = str(readiness.get("status") or "").strip().lower()
    failed_gates = _gate_rows(readiness, "fail")
    warning_gates = _gate_rows(readiness, "warn")

    if not readiness:
        status = ReleaseStatus.BLOCKED
        blocker_codes = ["missing_submission_readiness_review"]
    elif raw_status == ReleaseStatus.READY.value and not failed_gates:
        status = ReleaseStatus.READY
        blocker_codes = []
    elif raw_status == ReleaseStatus.READY_WITH_WARNINGS.value and not failed_gates:
        status = ReleaseStatus.READY_WITH_WARNINGS
        blocker_codes = []
    else:
        status = ReleaseStatus.BLOCKED
        blocker_codes = _gate_codes(failed_gates, fallback="submission_readiness_blocked")

    warning_codes = _gate_codes(warning_gates, fallback="submission_warning") if warning_gates else []
    package = str(package_path or "")
    ready_for_submission = status is not ReleaseStatus.BLOCKED
    requires_review = status is not ReleaseStatus.READY
    if status is ReleaseStatus.READY:
        summary = "Generated article passed all hard quality gates."
        next_actions = ["Use or edit the generated article and supporting files."]
    elif status is ReleaseStatus.READY_WITH_WARNINGS:
        summary = "Generated article passed hard gates with non-blocking quality warnings."
        next_actions = ["Review the listed warnings while editing the article."]
    else:
        summary = "Generated article failed one or more required evidence or statistical quality gates."
        next_actions = [
            "Resolve the blocking issues and rerun article generation.",
            "Keep the current draft only as a diagnostic artifact.",
        ]

    return {
        "schema_version": 1,
        "status": status.value,
        "ready_for_submission": ready_for_submission,
        "requires_review": requires_review,
        "summary": summary,
        "next_actions": next_actions,
        "artifacts": ([{"kind": "review_package", "path": package}] if package else []),
        "blocker_codes": blocker_codes,
        "warning_codes": warning_codes,
        "failed_gates": failed_gates,
        "warning_gates": warning_gates,
    }


def persist_release_decision(project: Project, decision: dict[str, Any]) -> dict[str, Any]:
    project.save_json(RELEASE_DECISION_FILE, decision, subdir="package")
    return decision


def load_release_decision(project: Project) -> dict[str, Any] | None:
    payload = project.load_json(RELEASE_DECISION_FILE, subdir="package") or None
    return payload if isinstance(payload, dict) else None


def require_releasable(project: Project) -> dict[str, Any]:
    decision = load_release_decision(project)
    if decision is None:
        decision = persist_release_decision(project, build_release_decision(None))
    if str(decision.get("status") or "").strip().lower() == ReleaseStatus.BLOCKED.value:
        raise ReleaseBlockedError(decision)
    return decision
