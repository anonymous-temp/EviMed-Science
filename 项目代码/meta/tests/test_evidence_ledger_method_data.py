from pathlib import Path

import pytest
from pydantic import ValidationError

from new_meta.core.evidence_ledger import EvidenceLedger
from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.project import Project
from new_meta.schemas.evidence_ledger import (
    DiagnosticAccuracyData,
    IncidenceRateData,
    PredictionPerformanceData,
    ResultEntity,
    SingleArmProportionData,
)
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def test_method_family_raw_data_models_enforce_denominators() -> None:
    assert SingleArmProportionData(events=10, total=100).data_type == "single_arm_proportion"
    assert IncidenceRateData(events=8, person_time=120.5, time_unit="person_years").person_time == 120.5
    with pytest.raises(ValidationError, match="events cannot exceed total"):
        SingleArmProportionData(events=101, total=100)
    with pytest.raises(ValidationError, match="diseased denominator"):
        DiagnosticAccuracyData(
            true_positive=0,
            false_negative=0,
            false_positive=5,
            true_negative=95,
        )


def test_legacy_proportion_migrates_to_typed_ledger_data(tmp_path: Path) -> None:
    project = Project("proportion ledger", output_dir=tmp_path / "project")
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
    )
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="S1",
            title="Prevalence survey",
            authors=["Smith John"],
            year=2024,
            study_design="cross-sectional",
        ),
        outcomes=[
            OutcomeData(
                outcome_name="Disease prevalence",
                outcome_type="proportion",
                events=25,
                total_n=200,
                source_quote="Disease was present in 25 of 200 participants.",
                source_quote_verified=True,
            )
        ],
    )

    report = migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=[study])
    ledger = EvidenceLedger(report.ledger_path, review_id=report.review_id)
    result = ledger.current(report.result_ids[0], model=ResultEntity)

    assert isinstance(result.raw_data, SingleArmProportionData)
    assert result.raw_data.events == 25
    assert result.raw_data.total == 200
    assert result.effect_measure == "PROP"


def test_diagnostic_outcome_schema_accepts_two_by_two_cells() -> None:
    outcome = OutcomeData(
        outcome_name="Index test accuracy",
        outcome_type="diagnostic_accuracy",
        true_positive=80,
        false_negative=20,
        false_positive=10,
        true_negative=90,
    )

    assert outcome.true_positive == 80
    assert outcome.true_negative == 90


def test_external_prediction_performance_migrates_to_model_versioned_ledger_data(
    tmp_path: Path,
) -> None:
    project = Project("prediction ledger", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(
        research_question="How well does Model X discriminate 30-day mortality?",
        pico=PICO(
            population="Adults undergoing surgery",
            intervention="Model X",
            comparator="Observed outcomes",
            outcome_primary="30-day mortality discrimination",
        ),
        effect_measure="C_STATISTIC",
        review_family="prediction_model",
        primary_outcome_type="discrimination",
        study_designs=["external validation"],
    )
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="V1",
            title="External validation",
            authors=["Smith John"],
            year=2024,
            study_design="external validation",
        ),
        outcomes=[
            OutcomeData(
                outcome_name="30-day mortality discrimination",
                outcome_type="discrimination",
                timepoint="30 days",
                prediction_model_id="Model X",
                prediction_model_version="2.1",
                prediction_validation_type="external",
                prediction_performance_measure="C_STATISTIC",
                prediction_performance_estimate=0.81,
                prediction_performance_se=0.02,
                prediction_sample_size=1200,
                prediction_events=80,
                source_quote="Model X version 2.1 had a c-statistic of 0.81 (SE 0.02).",
                source_quote_verified=True,
            )
        ],
    )

    migration = migrate_extractions_to_ledger(
        project,
        protocol=protocol,
        extracted_studies=[study],
    )
    ledger = EvidenceLedger(migration.ledger_path, review_id=migration.review_id)
    result = ledger.current(migration.result_ids[0], model=ResultEntity)

    assert isinstance(result.raw_data, PredictionPerformanceData)
    assert result.raw_data.model_id == "Model X"
    assert result.raw_data.model_version == "2.1"
    assert result.raw_data.validation_type == "external"
    assert result.raw_data.metric == "C_STATISTIC"
    assert result.raw_data.estimate == 0.81
    assert result.raw_data.time_horizon == "30 days"
    assert result.effect_measure == "C_STATISTIC"
