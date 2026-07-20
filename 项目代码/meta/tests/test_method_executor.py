from pathlib import Path

import pytest

from new_meta.core.method_executor import MethodExecutionBlocked, MethodExecutor
from new_meta.core.method_registry import default_method_registry
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.project import Project
from new_meta.schemas.method_policy import ReviewDesignSpec, ReviewFamily
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def test_method_executor_runs_compiled_prevalence_plan_and_persists_result(tmp_path: Path) -> None:
    plan = default_method_registry().compile(
        ReviewDesignSpec(
            review_id="review:prevalence",
            family=ReviewFamily.PREVALENCE_INCIDENCE,
            study_designs=["cross_sectional"],
            outcome_type="proportion",
            requested_effect_measure="PROP",
        ),
        allow_validating=True,
    )
    output = tmp_path / "prevalence_result.json"

    result = MethodExecutor().execute(
        plan,
        records=[
            {"study_id": "A", "events": 10, "total": 100},
            {"study_id": "B", "events": 20, "total": 200},
            {"study_id": "C", "events": 5, "total": 50},
        ],
        options={"model": "random"},
        output_path=output,
    )

    assert result.family is ReviewFamily.PREVALENCE_INCIDENCE
    assert result.plan_fingerprint == plan.plan_fingerprint
    assert result.estimator == "LOGISTIC_NORMAL_BINOMIAL_GLMM"
    assert result.payload["pooled_proportion"] == pytest.approx(0.1, abs=0.01)
    assert output.exists()


def test_method_executor_refuses_a_blocked_two_gate_diagnostic_plan() -> None:
    plan = default_method_registry().compile(
        ReviewDesignSpec(
            review_id="review:dta",
            family=ReviewFamily.DIAGNOSTIC_ACCURACY,
            study_designs=["two_gate"],
            outcome_type="diagnostic_accuracy",
            requested_effect_measure="SENS_SPEC",
        )
    )

    with pytest.raises(MethodExecutionBlocked, match="execution is blocked"):
        MethodExecutor().execute(plan, records=[])


def test_method_executor_does_not_allow_bypassing_dta_threshold_gate() -> None:
    plan = default_method_registry().compile(
        ReviewDesignSpec(
            review_id="review:dta",
            family=ReviewFamily.DIAGNOSTIC_ACCURACY,
            study_designs=["diagnostic_cross_sectional"],
            outcome_type="diagnostic_accuracy",
            requested_effect_measure="SENS_SPEC",
        )
    )
    records = [
        {"study_id": "A", "true_positive": 40, "false_negative": 10, "false_positive": 8, "true_negative": 42, "threshold": ""},
        {"study_id": "B", "true_positive": 70, "false_negative": 30, "false_positive": 12, "true_negative": 88, "threshold": ""},
        {"study_id": "C", "true_positive": 25, "false_negative": 5, "false_positive": 15, "true_negative": 55, "threshold": ""},
    ]

    with pytest.raises(MethodExecutionBlocked, match="not permitted"):
        MethodExecutor().execute(
            plan,
            records=records,
            options={"threshold_policy": "unchecked_validation_fixture"},
        )


def test_implemented_registry_entrypoints_resolve_to_callables() -> None:
    registry = default_method_registry()
    executor = MethodExecutor()

    for family in (ReviewFamily.PREVALENCE_INCIDENCE, ReviewFamily.DIAGNOSTIC_ACCURACY):
        plugin = registry.plugin(family)
        assert callable(executor.resolve_entrypoint(plugin.engine_entrypoint))


def test_method_executor_materializes_verified_records_from_evidence_ledger(tmp_path: Path) -> None:
    project = Project("ledger method execution", output_dir=tmp_path / "project")
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
                    source_quote_verified=True,
                )
            ],
        )
        for study_id, events, total in (("S1", 10, 100), ("S2", 20, 200), ("S3", 5, 50))
    ]
    migration = migrate_extractions_to_ledger(
        project,
        protocol=protocol,
        extracted_studies=studies,
    )
    plan = compile_project_method_plan(project, protocol, allow_validating=True, enforce=True)

    result = MethodExecutor().execute_project(
        plan,
        project=project,
        result_ids=migration.result_ids,
        options={"model": "random"},
    )

    assert result.input_result_ids == migration.result_ids
    assert result.payload["pooled_proportion"] == pytest.approx(0.1, abs=0.01)
    assert len(result.input_ledger_head_hash) == 64
    assert project.get_path("method_result.json", subdir="analysis").exists()
    audit = project.load_json("method_input_audit.json", subdir="analysis")
    assert [row["result_id"] for row in audit["inputs"]] == migration.result_ids
    assert all(row["evidence_state"] == "verified" for row in audit["inputs"])
    assert all(row["source_locators"][0]["quote_verified"] is True for row in audit["inputs"])
    assert audit["ledger_head_hash"] == result.input_ledger_head_hash
    assert audit["plan_fingerprint"] == plan.plan_fingerprint
