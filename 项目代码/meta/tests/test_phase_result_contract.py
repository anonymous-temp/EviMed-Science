from pathlib import Path
import inspect

import pytest
from pydantic import ValidationError

from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.phase_results import build_downstream_phase_result
from new_meta.core.project import Project
from new_meta.schemas.phase_result import (
    ArtifactRef,
    ExecutionStatus,
    PhaseIssue,
    PhaseName,
    PhaseResult,
)
from new_meta.schemas.protocol import PICO, ResearchProtocol


def test_blocked_phase_result_requires_an_actionable_blocker() -> None:
    with pytest.raises(ValidationError, match="blocked result requires"):
        PhaseResult(
            run_id="run-1",
            phase=PhaseName.RELEASE,
            status=ExecutionStatus.BLOCKED,
            summary="Release is blocked",
        )

    result = PhaseResult(
        run_id="run-1",
        phase=PhaseName.RELEASE,
        status=ExecutionStatus.BLOCKED,
        summary="Release is blocked",
        issues=[
            PhaseIssue(
                code="missing_adjudication",
                message="A primary result still requires adjudication.",
                blocking=True,
            )
        ],
    )

    assert result.status is ExecutionStatus.BLOCKED
    assert result.issues[0].blocking is True


def test_successful_phase_result_cannot_contain_blocking_issues() -> None:
    with pytest.raises(ValidationError, match="successful result cannot contain blocking issues"):
        PhaseResult(
            run_id="run-1",
            phase=PhaseName.EXTRACTION,
            status=ExecutionStatus.SUCCEEDED,
            summary="Extraction complete",
            issues=[PhaseIssue(code="bad_row", message="Bad row", blocking=True)],
        )


def test_runner_exposes_typed_primary_effect_selection_result(
    tmp_path: Path,
    monkeypatch,
) -> None:
    project = Project("typed runner", output_dir=tmp_path / "project")
    runner = PipelineRunner(project)
    effects = [type("Effect", (), {"study_id": "S1"})()]
    audit = [
        {"row_id": "S1:0", "decision": "selected_within_study", "reason": "selected"},
        {"row_id": "S2:0", "decision": "excluded", "reason": "missing_risk_of_bias_assessment"},
    ]
    monkeypatch.setattr(
        runner,
        "compute_primary_effect_selection",
        lambda **kwargs: (effects, audit),
    )

    protocol = ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="mortality",
        ),
        study_designs=["RCT"],
        effect_measure="RR",
    )
    result = runner.run_primary_effect_selection(
        protocol=protocol,
        extracted_studies=[object()],
        rob_results=[object()],
        included_papers=[{}],
    )

    assert isinstance(result, PhaseResult)
    assert result.phase is PhaseName.EFFECT_SELECTION
    assert result.status is ExecutionStatus.SUCCEEDED
    assert result.metrics == {
        "selected_effects": 1,
        "audit_rows": 2,
        "excluded_rows": 1,
    }
    assert result.data["effects"] is effects
    assert result.data["selection_audit"] is audit
    assert result.artifacts == [
        ArtifactRef(
            artifact_id="effect_selection_audit",
            kind="audit",
            path=str(project.get_path("effect_selection_audit.json", subdir="analysis")),
            media_type="application/json",
        ),
        ArtifactRef(
            artifact_id="effect_sizes",
            kind="dataset",
            path=str(project.get_path("effect_sizes.json", subdir="analysis")),
            media_type="application/json",
        ),
    ]


def test_downstream_builder_maps_readiness_blockers_to_typed_result(tmp_path: Path) -> None:
    project = Project("typed downstream", output_dir=tmp_path / "project")
    manuscript = project.get_path("draft.md", subdir="manuscript")
    package = project.get_path("metaagent_export.zip", subdir="package")

    result = build_downstream_phase_result(
        project,
        evidence_readiness={
            "action_required": True,
            "blockers": [
                {
                    "code": "missing_adjudication",
                    "message": "A primary result requires adjudication.",
                    "row_id": "S1:0",
                }
            ],
            "next_actions": ["Review S1:0 against the source report."],
        },
        manuscript_path=manuscript,
        package_path=package,
        metrics={"selected_effects": 1},
        warnings=["A figure could not be regenerated."],
    )

    assert result.phase is PhaseName.PACKAGE
    assert result.status is ExecutionStatus.BLOCKED
    assert result.issues[0].code == "missing_adjudication"
    assert result.issues[0].entity_ids == ["S1:0"]
    assert result.issues[-1].blocking is False
    assert result.next_actions[0].description == "Review S1:0 against the source report."
    assert [artifact.artifact_id for artifact in result.artifacts] == ["manuscript", "artifact_package"]


def test_web_downstream_response_embeds_typed_execution_envelope() -> None:
    import start

    source = inspect.getsource(start._run_downstream_after_overrides_payload)

    assert "build_downstream_phase_result(" in source
    assert '"execution": phase_result.model_dump(mode="json")' in source
