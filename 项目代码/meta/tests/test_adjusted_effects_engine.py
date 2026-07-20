import json
from pathlib import Path

import pytest

from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.method_executor import MethodExecutionBlocked, MethodExecutor
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.project import Project
from new_meta.engines.adjusted_effects import run_adjusted_effects
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _records():
    return [
        {
            "result_id": "r1",
            "study_id": "S1",
            "measure": "HR",
            "estimate": 0.80,
            "ci_lower": 0.65,
            "ci_upper": 0.98,
            "adjusted": True,
            "adjusted_covariates": ["age", "sex", "disease severity"],
        },
        {
            "result_id": "r2",
            "study_id": "S2",
            "measure": "HR",
            "estimate": 0.75,
            "ci_lower": 0.60,
            "ci_upper": 0.94,
            "adjusted": True,
            "adjusted_covariates": ["sex", "age", "disease severity"],
        },
        {
            "result_id": "r3",
            "study_id": "S3",
            "measure": "HR",
            "estimate": 0.92,
            "ci_lower": 0.72,
            "ci_upper": 1.18,
            "adjusted": True,
            "adjusted_covariates": ["age", "sex", "disease severity"],
        },
    ]


def test_adjusted_effect_engine_pools_only_compatible_adjusted_estimates() -> None:
    result = run_adjusted_effects(_records())

    assert result.estimator == "REML_ADJUSTED_EFFECTS"
    assert result.measure == "HR"
    assert result.n_studies == 3
    assert 0.70 < result.pooled_effect < 0.95
    assert result.ci_lower < result.pooled_effect < result.ci_upper
    assert result.adjustment_sets == [["age", "disease severity", "sex"]]
    assert result.sensitivity["HKSJ"]["estimate"] > 0


def test_adjusted_effect_reml_matches_external_metafor_reported_effect_corpus() -> None:
    corpus = json.loads(
        (
            Path(__file__).parents[1]
            / "validation"
            / "corpora"
            / "metafor_bcg_reported_effect_reml.json"
        ).read_text(encoding="utf-8")
    )
    records = [
        {
            "result_id": f"result:{row['study_id']}",
            "study_id": row["study_id"],
            "measure": "RR",
            "estimate": row["estimate"],
            "variance": row["variance"],
            "scale": "log",
            "adjusted": True,
            "adjusted_covariates": ["age", "sex"],
        }
        for row in corpus["records"]
    ]

    result = run_adjusted_effects(records)
    expected = corpus["expected"]
    tolerance = expected["tolerance"]

    assert result.pooled_analysis_scale == pytest.approx(
        expected["pooled_analysis_scale"], abs=tolerance
    )
    assert result.pooled_effect == pytest.approx(expected["pooled_effect"], abs=tolerance)
    assert result.ci_lower == pytest.approx(expected["ci_lower"], abs=tolerance)
    assert result.ci_upper == pytest.approx(expected["ci_upper"], abs=tolerance)
    assert result.tau_squared == pytest.approx(expected["tau_squared"], abs=tolerance)
    assert result.q == pytest.approx(expected["q"], abs=tolerance)


def test_adjusted_effect_engine_rejects_unadjusted_or_incompatible_rows() -> None:
    unadjusted = _records()
    unadjusted[1]["adjusted"] = False
    with pytest.raises(ValueError, match="adjusted estimates"):
        run_adjusted_effects(unadjusted)

    incompatible = _records()
    incompatible[2]["adjusted_covariates"] = ["hospital size"]
    with pytest.raises(ValueError, match="adjustment sets"):
        run_adjusted_effects(incompatible)


def test_nrsi_method_executor_materializes_adjusted_ledger_estimates(tmp_path: Path) -> None:
    project = Project("NRSI adjusted", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(
        research_question="Is exposure associated with mortality?",
        pico=PICO(
            population="Adults",
            intervention="Exposure",
            comparator="No exposure",
            outcome_primary="mortality",
        ),
        review_family="intervention_nrsi",
        study_designs=["cohort"],
        primary_outcome_type="time_to_event",
        effect_measure="HR",
    )
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id=row["study_id"],
                title=f"Cohort {row['study_id']}",
                authors=["Smith John"],
                year=2024,
                study_design="cohort",
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="mortality",
                    outcome_type="time-to-event",
                    effect_size=row["estimate"],
                    ci_lower=row["ci_lower"],
                    ci_upper=row["ci_upper"],
                    reported_effect_measure="HR",
                    reported_effect_adjusted=True,
                    adjustment_covariates=row["adjusted_covariates"],
                    source_quote=(
                        f"Adjusted HR {row['estimate']} (95% CI {row['ci_lower']} to {row['ci_upper']}) "
                        "after adjustment for age, sex, and disease severity."
                    ),
                    source_quote_verified=True,
                    source_location="Results, Table 2",
                )
            ],
        )
        for row in _records()
    ]
    migration = migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies)
    plan = compile_project_method_plan(project, protocol, allow_validating=True, enforce=True)

    result = MethodExecutor().execute_project(
        plan,
        project=project,
        result_ids=migration.result_ids,
    )

    assert result.estimator == "REML_ADJUSTED_EFFECTS"
    assert result.payload["measure"] == "HR"
    assert result.input_result_ids == migration.result_ids


def test_nrsi_executor_rejects_unadjusted_ledger_estimate(tmp_path: Path) -> None:
    project = Project("NRSI unadjusted", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(
        research_question="Is exposure associated with mortality?",
        pico=PICO(population="Adults", intervention="Exposure", comparator="None", outcome_primary="mortality"),
        review_family="intervention_nrsi",
        study_designs=["cohort"],
        primary_outcome_type="time_to_event",
        effect_measure="HR",
    )
    row = _records()[0]
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(study_id="S1", title="Cohort", authors=["Smith John"], year=2024, study_design="cohort"),
        outcomes=[
            OutcomeData(
                outcome_name="mortality",
                outcome_type="time-to-event",
                effect_size=row["estimate"],
                ci_lower=row["ci_lower"],
                ci_upper=row["ci_upper"],
                reported_effect_measure="HR",
                reported_effect_adjusted=False,
                source_quote="Unadjusted HR 0.80 (95% CI 0.65 to 0.98).",
                source_quote_verified=True,
                source_location="Results, Table 2",
            )
        ],
    )
    migration = migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=[study])
    plan = compile_project_method_plan(project, protocol, allow_validating=True, enforce=True)

    with pytest.raises(MethodExecutionBlocked, match="adjusted"):
        MethodExecutor().execute_project(plan, project=project, result_ids=migration.result_ids)
