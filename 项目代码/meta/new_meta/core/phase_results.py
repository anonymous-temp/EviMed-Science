"""Adapters from pipeline artifacts to the stable phase-result envelope."""
from __future__ import annotations

from pathlib import Path

from new_meta.core.project import Project
from new_meta.schemas.phase_result import (
    ArtifactRef,
    ExecutionStatus,
    NextAction,
    PhaseIssue,
    PhaseName,
    PhaseResult,
)


def build_downstream_phase_result(
    project: Project,
    *,
    evidence_readiness: dict | None,
    manuscript_path: str | Path,
    package_path: str | Path,
    metrics: dict[str, int | float | str | bool | None] | None = None,
    warnings: list[str] | None = None,
) -> PhaseResult:
    """Map downstream manuscript/package readiness to one truthful status."""
    readiness = evidence_readiness or {}
    blocker_rows = readiness.get("blockers") or []
    issues = [
        PhaseIssue(
            code=str(row.get("code") or "release_blocker"),
            message=str(row.get("message") or "Release requires review."),
            blocking=True,
            entity_ids=[
                str(entity_id)
                for entity_id in (row.get("entity_ids") or [row.get("row_id")])
                if entity_id
            ],
            context={
                key: value
                for key, value in row.items()
                if key not in {"code", "message", "entity_ids", "row_id"}
            },
        )
        for row in blocker_rows
        if isinstance(row, dict)
    ]
    action_required = bool(readiness.get("action_required") or issues)
    if action_required and not issues:
        issues.append(
            PhaseIssue(
                code="manual_review_required",
                message="The downstream package requires manual review before release.",
                blocking=True,
            )
        )
    for index, warning in enumerate(warnings or [], start=1):
        issues.append(
            PhaseIssue(
                code=f"downstream_warning_{index}",
                message=str(warning),
                blocking=False,
            )
        )

    next_actions = [
        NextAction(
            action_id=f"downstream_action_{index}",
            title="Resolve downstream review item",
            description=str(action),
        )
        for index, action in enumerate(readiness.get("next_actions") or [], start=1)
        if str(action).strip()
    ]
    status = ExecutionStatus.BLOCKED if action_required else ExecutionStatus.SUCCEEDED
    return PhaseResult(
        run_id=project.base_dir.name,
        phase=PhaseName.PACKAGE,
        status=status,
        summary=(
            "Downstream package built but release is blocked pending review."
            if status is ExecutionStatus.BLOCKED
            else "Downstream analysis and package generation completed."
        ),
        checkpoint="manuscript",
        metrics=metrics or {},
        artifacts=[
            ArtifactRef(
                artifact_id="manuscript",
                kind="manuscript",
                path=str(manuscript_path),
                media_type="text/markdown",
            ),
            ArtifactRef(
                artifact_id="artifact_package",
                kind="package",
                path=str(package_path),
                media_type="application/zip",
            ),
        ],
        issues=issues,
        next_actions=next_actions,
    )
