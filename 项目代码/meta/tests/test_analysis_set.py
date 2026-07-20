from pathlib import Path

import pytest

from new_meta.core.analysis_set import (
    AnalysisSetConflictError,
    save_analysis_set_adjudication,
)
from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.method_executor import MethodExecutionBlocked, MethodExecutor
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.project import Project
from new_meta.schemas.phase_result import ExecutionStatus
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _multiple_outcome_project(tmp_path: Path):
    project = Project("analysis set", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(
        research_question="What is the prevalence of disease X?",
        pico=PICO(
            population="Adults",
            intervention="None",
            comparator="None",
            outcome_primary="Disease X prevalence",
        ),
        effect_measure="PROP",
        review_family="prevalence_incidence",
        primary_outcome_type="proportion",
        study_designs=["cross-sectional"],
    )
    studies = []
    for index, (study_id, disease, obesity, total) in enumerate(
        (("S1", 10, 30, 100), ("S2", 20, 50, 200), ("S3", 5, 12, 50)),
        start=1,
    ):
        studies.append(
            ExtractedStudy(
                characteristics=StudyCharacteristics(
                    study_id=study_id,
                    title=f"Survey {study_id}",
                    authors=[f"Author{index} Jane"],
                    year=2020 + index,
                    study_design="cross-sectional",
                ),
                outcomes=[
                    OutcomeData(
                        outcome_name="Disease X prevalence",
                        outcome_type="proportion",
                        events=disease,
                        total_n=total,
                        source_quote=f"Disease X occurred in {disease} of {total} adults.",
                        source_quote_verified=True,
                        source_location="Results, Table 1",
                    ),
                    OutcomeData(
                        outcome_name="Obesity prevalence",
                        outcome_type="proportion",
                        events=obesity,
                        total_n=total,
                        source_quote=f"Obesity occurred in {obesity} of {total} adults.",
                        source_quote_verified=True,
                        source_location="Results, Table 2",
                    ),
                ],
            )
        )
    project.save_json("protocol.json", protocol)
    migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies)
    plan = compile_project_method_plan(project, protocol, enforce=True)
    return project, plan


def test_multiple_result_strata_require_versioned_analysis_set_adjudication(
    tmp_path: Path,
) -> None:
    project, plan = _multiple_outcome_project(tmp_path)

    blocked = PipelineRunner(project).run_compiled_method_synthesis()

    assert blocked.status is ExecutionStatus.NEEDS_INPUT
    assert blocked.error_code == "analysis_set_adjudication_required"
    assert {item["label"] for item in blocked.data["options"]} == {
        "Disease X prevalence",
        "Obesity prevalence",
    }
    assert blocked.data["recommended_candidate_id"]
    candidates = project.load_json("analysis_set_candidates.json", subdir="analysis")
    assert len(candidates["candidates"]) == 2
    assert {item["outcome_name"] for item in candidates["candidates"]} == {
        "Disease X prevalence",
        "Obesity prevalence",
    }
    assert not project.get_path("method_result.json", subdir="analysis").exists()

    selected = next(
        item for item in candidates["candidates"]
        if item["outcome_name"] == "Disease X prevalence"
    )
    decision = save_analysis_set_adjudication(
        project,
        candidate_id=selected["candidate_id"],
        expected_revision=0,
        selected_by="reviewer@example.org",
        reason="This is the protocol-defined primary outcome.",
    )

    assert decision.status == "adjudicated"
    assert decision.revision == 1
    assert decision.plan_fingerprint == plan.plan_fingerprint
    assert decision.result_ids == selected["result_ids"]
    succeeded = PipelineRunner(project).run_compiled_method_synthesis()
    assert succeeded.status is ExecutionStatus.SUCCEEDED
    result = project.load_json("method_result.json", subdir="analysis")
    assert result["input_result_ids"] == selected["result_ids"]

    other = next(
        item for item in candidates["candidates"]
        if item["candidate_id"] != selected["candidate_id"]
    )
    with pytest.raises(MethodExecutionBlocked, match="adjudicated analysis set"):
        MethodExecutor().execute_project(
            plan,
            project=project,
            result_ids=other["result_ids"],
        )
    with pytest.raises(AnalysisSetConflictError, match="stale analysis set revision"):
        save_analysis_set_adjudication(
            project,
            candidate_id=other["candidate_id"],
            expected_revision=0,
            selected_by="reviewer@example.org",
            reason="Attempted stale update.",
        )


def test_full_automatic_mode_selects_the_protocol_primary_stratum(tmp_path: Path) -> None:
    project, _ = _multiple_outcome_project(tmp_path)

    phase = PipelineRunner(project).run_compiled_method_synthesis(
        auto_select_ambiguous=True,
    )

    assert phase.status is ExecutionStatus.SUCCEEDED
    decision = project.load_json("analysis_set.json", subdir="analysis")
    assert decision["status"] == "automatic"
    assert decision["outcome_name"] == "Disease X prevalence"
    assert decision["selected_by"] == "deterministic:protocol-primary-ranking"
    assert "protocol-defined primary outcome" in decision["reason"]


def test_one_unambiguous_stratum_is_locked_automatically(tmp_path: Path) -> None:
    project = Project("unambiguous analysis set", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(
        research_question="What is the prevalence?",
        pico=PICO(
            population="Adults",
            intervention="None",
            comparator="None",
            outcome_primary="Disease prevalence",
        ),
        effect_measure="PROP",
        review_family="prevalence_incidence",
        primary_outcome_type="proportion",
        study_designs=["cross-sectional"],
    )
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id=study_id,
                title=study_id,
                authors=["Smith John"],
                year=2024,
                study_design="cross-sectional",
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="Disease prevalence",
                    outcome_type="proportion",
                    events=events,
                    total_n=total,
                    source_quote=f"Disease occurred in {events} of {total} adults.",
                    source_quote_verified=True,
                )
            ],
        )
        for study_id, events, total in (("S1", 10, 100), ("S2", 20, 200), ("S3", 5, 50))
    ]
    migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies)
    compile_project_method_plan(project, protocol, enforce=True)

    phase = PipelineRunner(project).run_compiled_method_synthesis()

    assert phase.status is ExecutionStatus.SUCCEEDED
    decision = project.load_json("analysis_set.json", subdir="analysis")
    assert decision["status"] == "automatic"
    assert decision["revision"] == 0
    assert len(decision["result_ids"]) == 3
