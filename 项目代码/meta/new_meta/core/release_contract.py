"""Terminal release-state contract shared by CLI, Web, API and packages."""
from __future__ import annotations

import copy
from enum import Enum
from pathlib import Path
from typing import Any

from new_meta.core.project import Project
from new_meta.core.release_tiers import BLOCKING_GATES, NO_MANUSCRIPT_CODE, apply_release_tiers


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
    """Normalize package readiness into one terminal, harness-friendly decision.

    Every written manuscript is delivered; the status says how it may be
    presented. The gates are re-tiered here (``core.release_tiers``), so a
    readiness review from any source - including one saved before the table -
    is decided by the same few blocking checks. ``blocked`` is reserved for
    those checks and for a run with no manuscript at all; nothing in a
    decision asks for the job to be run again.
    """
    readiness = copy.deepcopy(submission_readiness) if isinstance(submission_readiness, dict) else {}
    if readiness.get("gates"):
        apply_release_tiers(readiness)
    raw_status = str(readiness.get("status") or "").strip().lower()
    failed_gates = _gate_rows(readiness, "fail")
    warning_gates = _gate_rows(readiness, "warn")

    if not readiness:
        status = ReleaseStatus.BLOCKED
        blocker_codes = [NO_MANUSCRIPT_CODE]
    elif failed_gates:
        status = ReleaseStatus.BLOCKED
        blocker_codes = _gate_codes(failed_gates, fallback="submission_readiness_blocked")
    elif warning_gates or raw_status == ReleaseStatus.READY_WITH_WARNINGS.value:
        status = ReleaseStatus.READY_WITH_WARNINGS
        blocker_codes = []
    elif raw_status == ReleaseStatus.READY.value:
        status = ReleaseStatus.READY
        blocker_codes = []
    else:
        # A readiness without gates whose status is not a release status.
        status = ReleaseStatus.BLOCKED
        blocker_codes = ["submission_readiness_blocked"]

    warning_codes = _gate_codes(warning_gates, fallback="submission_warning") if warning_gates else []
    package = str(package_path or "")
    ready_for_submission = status is not ReleaseStatus.BLOCKED
    requires_review = status is not ReleaseStatus.READY
    if not readiness:
        summary = "No manuscript was written, so there is no article to release."
        next_actions = [
            "Report why the run stopped before its manuscript; do not present partial files as a review.",
        ]
    elif status is ReleaseStatus.READY:
        summary = "The generated article passed every release check."
        next_actions = ["Use or edit the generated article and its supporting files."]
    elif status is ReleaseStatus.READY_WITH_WARNINGS:
        summary = (
            "The generated article is delivered with advisory findings; none of them makes it "
            "unreadable or hides a defect from its reader."
        )
        next_actions = [
            "State each listed finding in plain words when handing the article over.",
            "A finding is not a reason to run the job again; the same request reproduces it.",
        ]
    else:
        reasons = "; ".join(
            dict.fromkeys(BLOCKING_GATES.get(code, code) for code in blocker_codes)
        )
        summary = (
            "The generated article is delivered, but a check that protects its reader failed: "
            f"{reasons}. Present it as unverified, with these findings."
        )
        next_actions = [
            "Deliver the article as unverified and state each blocking finding in plain words.",
            "Do not run the job again for the same request; the same inputs reproduce the same result.",
        ]

    return {
        "schema_version": 1,
        "status": status.value,
        "ready_for_submission": ready_for_submission,
        "requires_review": requires_review,
        # A written manuscript is delivered whatever its status (the platform
        # delivers everything, 2026-09-17); False only when none was written.
        "deliverable": bool(readiness),
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
