from __future__ import annotations

import json
from pathlib import Path

from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.method_delivery import run_method_delivery
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.method_release import build_method_release_review
from new_meta.core.project import Project
from new_meta.schemas.method_certainty import MethodCertaintyStatus
from new_meta.schemas.method_policy import CapabilityStatus
from new_meta.schemas.phase_result import ExecutionStatus
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.risk_of_bias import (
    ResultRoBAssessment,
    RoBAssessmentStatus,
    RoBDomain,
    RoBTargetEffect,
)
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


CORPUS = (
    Path(__file__).resolve().parents[1]
    / "validation"
    / "corpora"
    / "metafor_calibration_slope_reml.json"
)


def _slope_project(tmp_path: Path):
    project = Project("calibration slope delivery", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(
        research_question="Is Model X calibrated for 30-day mortality?",
        pico=PICO(
            population="Adults undergoing major surgery",
            intervention="Model X",
            comparator="Observed 30-day mortality",
            outcome_primary="30-day mortality calibration",
        ),
        review_family="prediction_model",
        study_designs=["external validation"],
        primary_outcome_type="calibration",
        effect_measure="CALIBRATION_SLOPE",
        databases=["PubMed", "Embase"],
    )
    fixture = json.loads(CORPUS.read_text(encoding="utf-8"))
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id=row["study_id"],
                title=f"Model X external validation {row['study_id']}",
                authors=[f"Author{index} Jane"],
                year=2015 + index,
                study_design="external validation",
                total_sample_size=1000 + index * 100,
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="30-day mortality calibration",
                    outcome_type="calibration",
                    timepoint="30 days",
                    accepted_timepoint="30 days",
                    prediction_model_id="Model X",
                    prediction_model_version="1.0",
                    prediction_validation_type="external",
                    prediction_performance_measure="CALIBRATION_SLOPE",
                    prediction_performance_estimate=row["calibration_slope"],
                    prediction_performance_se=row["standard_error"],
                    prediction_sample_size=1000 + index * 100,
                    prediction_events=80 + index,
                    source_quote=(
                        f"The calibration slope was {row['calibration_slope']} "
                        f"(SE {row['standard_error']})."
                    ),
                    source_quote_verified=True,
                    source_location="Results, calibration analysis",
                    source_page=index,
                )
            ],
        )
        for index, row in enumerate(fixture["records"], start=1)
    ]
    migration = migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies)
    assessments = [
        ResultRoBAssessment(
            assessment_id=f"rob:{result_id}:complete",
            result_id=result_id,
            study_id=study.characteristics.study_id,
            outcome_name="30-day mortality calibration",
            tool_used="PROBAST",
            tool_version="PROBAST (2019)",
            target_effect=RoBTargetEffect.PREDICTION_MODEL,
            assessment_status=RoBAssessmentStatus.COMPLETE,
            assessed_by="reviewer@example.org",
            domains=[
                RoBDomain(
                    domain="Analysis",
                    judgment="Low risk",
                    support="The original model was applied unchanged and slope precision was reported.",
                    source_page=3,
                    source_section="Methods",
                    source_quote="The model linear predictor was evaluated without refitting.",
                )
            ],
            overall_judgment="Low risk",
            requires_adjudication=False,
        )
        for result_id, study in zip(migration.result_ids, studies)
    ]
    project.save_json("rob_result_assessments.json", assessments, subdir="risk_of_bias")
    return project, protocol, studies, assessments, migration


def _deliver(tmp_path: Path, *, auto: bool, lang: str = "en"):
    project, protocol, studies, assessments, migration = _slope_project(tmp_path)
    plan = compile_project_method_plan(project, protocol, enforce=True)
    delivery = run_method_delivery(
        project=project,
        protocol=protocol,
        extracted_studies=studies,
        rob_results=assessments,
        prisma_data={
            "identification": {"records_identified": 60, "records_after_dedup": 45},
            "eligibility": {"full_text_assessed": 12},
            "included": {"studies_included": 8},
        },
        search_query='"Model X" AND external validation AND calibration',
        lang=lang,
        auto_resolve_uncertainty=auto,
    )
    return project, migration, plan, delivery


def test_external_calibration_slope_compiles_to_production_capability(tmp_path: Path) -> None:
    project, protocol, _, _, _ = _slope_project(tmp_path)

    plan = compile_project_method_plan(project, protocol, enforce=True)

    assert plan.capability_id == "prediction_model.external_calibration_slope_reml"
    assert plan.capability_status is CapabilityStatus.PRODUCTION
    assert plan.primary_estimator == "CALIBRATION_SLOPE_REML_HKSJ"
    assert len(plan.validation_evidence_ids) == 3


def test_full_auto_calibration_slope_delivery_writes_fact_locked_article(tmp_path: Path) -> None:
    project, migration, _, delivery = _deliver(tmp_path, auto=True)

    assert delivery.phase.status is ExecutionStatus.SUCCEEDED
    assert delivery.decisions == []
    assert "calibration slope" in delivery.manuscript.lower()
    assert "0.897" in delivery.manuscript
    assert "0.773 to 1.021" in delivery.manuscript
    assert "0.598 to 1.196" in delivery.manuscript
    assert "predictions that are too extreme" in delivery.manuscript
    assert "does not establish calibration-in-the-large, discrimination, or clinical utility" in delivery.manuscript
    assert "pooled c-statistic" not in delivery.manuscript.lower()
    envelope = project.load_json("synthesis_result.json", subdir="analysis")
    assert envelope["primary_estimates"][0]["measure"] == "CALIBRATION_SLOPE"
    assert envelope["primary_estimates"][0]["scale"] == "calibration_slope"
    assert set(envelope["input_result_ids"]) == set(migration.result_ids)
    assert envelope["heterogeneity"]["scale"] == "original_calibration_slope"
    certainty = project.load_json("method_certainty.json", subdir="analysis")
    assert certainty["status"] == MethodCertaintyStatus.COMPLETED.value
    assert build_method_release_review(project)["passed"] is True


def test_calibration_slope_normal_mode_returns_certainty_options(tmp_path: Path) -> None:
    _, _, _, delivery = _deliver(tmp_path, auto=False)

    assert delivery.phase.status is ExecutionStatus.SUCCEEDED
    assert delivery.decisions[0]["decision_type"] == "method_certainty"
    assert delivery.decisions[0]["recommended_option_id"] == "conservative"


def test_calibration_slope_chinese_article_is_metric_specific(tmp_path: Path) -> None:
    _, _, _, delivery = _deliver(tmp_path, auto=True, lang="zh")

    assert "校准斜率" in delivery.manuscript
    assert "预测过于极端" in delivery.manuscript
    assert "总体校准" in delivery.manuscript
    assert "合并C统计量" not in delivery.manuscript
