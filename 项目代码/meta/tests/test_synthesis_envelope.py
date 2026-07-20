from pathlib import Path

import pytest

from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.manuscript_facts import build_manuscript_facts
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.project import Project
from new_meta.schemas.method_policy import MethodExecutionResult, ReviewFamily
from new_meta.schemas.phase_result import ExecutionStatus, PhaseName
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics
from new_meta.schemas.synthesis_result import SynthesisResultEnvelope


def _protocol() -> ResearchProtocol:
    return ResearchProtocol(
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


def _studies(*, verified: bool = True) -> list[ExtractedStudy]:
    return [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id=study_id,
                title=f"Survey {study_id}",
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
                    source_quote=f"Disease affected {events} of {total} participants.",
                    source_quote_verified=verified,
                    source_location="Results, Table 1",
                )
            ],
        )
        for study_id, events, total in (("S1", 10, 100), ("S2", 20, 200), ("S3", 5, 50))
    ]


def test_method_execution_maps_to_review_family_neutral_synthesis_envelope() -> None:
    execution = MethodExecutionResult(
        family=ReviewFamily.PREVALENCE_INCIDENCE,
        policy_version="2026.1",
        plan_fingerprint="abc",
        estimator="LOGISTIC_NORMAL_BINOMIAL_GLMM",
        input_result_ids=["result:1", "result:2"],
        payload={
            "pooled_proportion": 0.23,
            "ci_lower": 0.18,
            "ci_upper": 0.29,
            "prediction_interval": [0.08, 0.51],
            "n_studies": 2,
            "tau_squared": 0.12,
            "converged": True,
        },
        diagnostics={"primary_scale": "logit"},
    )

    envelope = SynthesisResultEnvelope.from_method_execution(execution)

    assert envelope.family is ReviewFamily.PREVALENCE_INCIDENCE
    assert envelope.primary_estimates[0].estimate == pytest.approx(0.23)
    assert envelope.primary_estimates[0].scale == "proportion"
    assert envelope.primary_estimates[0].ci_lower == pytest.approx(0.18)
    assert envelope.input_result_ids == ["result:1", "result:2"]
    assert envelope.execution_converged is True


def test_pipeline_runner_executes_compiled_method_from_verified_ledger(tmp_path: Path) -> None:
    project = Project("prevalence synthesis", output_dir=tmp_path / "project")
    protocol = _protocol()
    migration = migrate_extractions_to_ledger(
        project,
        protocol=protocol,
        extracted_studies=_studies(),
    )
    compile_project_method_plan(project, protocol, allow_validating=True, enforce=True)

    result = PipelineRunner(project).run_compiled_method_synthesis(options={"model": "random"})

    assert result.phase is PhaseName.SYNTHESIS
    assert result.status is ExecutionStatus.SUCCEEDED
    assert result.data["synthesis"].input_result_ids == migration.result_ids
    persisted = SynthesisResultEnvelope.model_validate(
        project.load_json("synthesis_result.json", subdir="analysis")
    )
    assert persisted.primary_estimates[0].estimate == pytest.approx(0.1, abs=0.01)
    assert persisted.method_plan_fingerprint

    facts = build_manuscript_facts(
        protocol=protocol,
        extracted_studies=_studies(),
        project=project,
    )
    assert facts["report_type"] == "meta"
    assert facts["method_family"] == "prevalence_incidence"
    assert facts["primary_effect"]["pooled_effect"] == pytest.approx(0.1, abs=0.01)
    assert facts["studies"]["primary_analysis_count"] == 3
    assert facts["evidence_readiness"]["blockers"] == []
    assert len(facts["evidence_readiness"]["selected_primary_rows"]) == 3


def test_method_synthesis_requests_adjudication_when_no_result_is_verified(tmp_path: Path) -> None:
    project = Project("unverified prevalence", output_dir=tmp_path / "project")
    protocol = _protocol()
    migrate_extractions_to_ledger(
        project,
        protocol=protocol,
        extracted_studies=_studies(verified=False),
    )
    compile_project_method_plan(project, protocol, allow_validating=True, enforce=True)

    result = PipelineRunner(project).run_compiled_method_synthesis()

    assert result.status is ExecutionStatus.NEEDS_INPUT
    assert result.issues[0].code == "verified_method_inputs_required"
    assert result.next_actions[0].action_id == "adjudicate_extraction_results"
