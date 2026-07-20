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
    / "metamisc_euroscore_oe_reml.json"
)


def _oe_project(tmp_path: Path):
    project = Project("prediction calibration delivery", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(
        research_question="How well calibrated is additive EuroSCORE for in-hospital mortality?",
        pico=PICO(
            population="Adults undergoing cardiac surgery",
            intervention="additive EuroSCORE",
            comparator="Observed in-hospital mortality",
            outcome_primary="in-hospital mortality calibration",
        ),
        review_family="prediction_model",
        study_designs=["external validation"],
        primary_outcome_type="calibration",
        effect_measure="OE_RATIO",
        databases=["PubMed", "Embase"],
    )
    fixture = json.loads(CORPUS.read_text(encoding="utf-8"))
    studies = []
    for index, row in enumerate(fixture["records"], start=1):
        observed = int(row["observed_events"])
        expected = float(row["expected_events"])
        sample_size = int(row["sample_size"])
        studies.append(
            ExtractedStudy(
                characteristics=StudyCharacteristics(
                    study_id=row["study_id"],
                    title=f"EuroSCORE external validation {row['study_id']}",
                    authors=[f"Author{index} Jane"],
                    year=2000 + index,
                    study_design="external validation",
                    country="Country",
                    total_sample_size=sample_size,
                ),
                outcomes=[
                    OutcomeData(
                        outcome_name="in-hospital mortality calibration",
                        outcome_type="calibration",
                        timepoint="in-hospital mortality",
                        accepted_timepoint="in-hospital mortality",
                        prediction_model_id="EuroSCORE",
                        prediction_model_version="additive",
                        prediction_validation_type="external",
                        prediction_performance_measure="OE_RATIO",
                        prediction_performance_estimate=observed / expected,
                        prediction_sample_size=sample_size,
                        prediction_events=observed,
                        prediction_expected_events=expected,
                        source_quote=(
                            f"There were {observed} observed deaths and {expected:g} deaths "
                            "expected by additive EuroSCORE."
                        ),
                        source_quote_verified=True,
                        source_location="Results, calibration table",
                        source_page=index,
                    )
                ],
            )
        )
    migration = migrate_extractions_to_ledger(
        project,
        protocol=protocol,
        extracted_studies=studies,
    )
    assessments = [
        ResultRoBAssessment(
            assessment_id=f"rob:{result_id}:complete",
            result_id=result_id,
            study_id=study_id,
            outcome_name="in-hospital mortality calibration",
            tool_used="PROBAST",
            tool_version="PROBAST (2019)",
            target_effect=RoBTargetEffect.PREDICTION_MODEL,
            assessment_status=RoBAssessmentStatus.COMPLETE,
            assessed_by="reviewer@example.org",
            domains=[
                RoBDomain(
                    domain="Analysis",
                    judgment="Low risk",
                    support="The published model was evaluated unchanged and O:E inputs were reported.",
                    source_page=3,
                    source_section="Methods",
                    source_quote="The additive EuroSCORE was applied without recalibration.",
                )
            ],
            overall_judgment="Low risk",
            requires_adjudication=False,
        )
        for result_id, study_id in zip(
            migration.result_ids,
            [row["study_id"] for row in fixture["records"]],
        )
    ]
    project.save_json("rob_result_assessments.json", assessments, subdir="risk_of_bias")
    return project, protocol, studies, assessments, migration


def _deliver(tmp_path: Path, *, auto: bool, lang: str = "en"):
    project, protocol, studies, assessments, migration = _oe_project(tmp_path)
    plan = compile_project_method_plan(project, protocol, enforce=True)
    delivery = run_method_delivery(
        project=project,
        protocol=protocol,
        extracted_studies=studies,
        rob_results=assessments,
        prisma_data={
            "identification": {"records_identified": 120, "records_after_dedup": 90},
            "eligibility": {"full_text_assessed": 30},
            "included": {"studies_included": 23},
        },
        search_query='"EuroSCORE" AND (calibration OR observed expected)',
        lang=lang,
        auto_resolve_uncertainty=auto,
    )
    return project, protocol, studies, assessments, migration, plan, delivery


def test_external_oe_calibration_compiles_to_narrow_production_capability(tmp_path: Path) -> None:
    project, protocol, _, _, _, = _oe_project(tmp_path)

    plan = compile_project_method_plan(project, protocol, enforce=True)

    assert plan.capability_id == "prediction_model.external_oe_reml"
    assert plan.capability_status is CapabilityStatus.PRODUCTION
    assert plan.primary_estimator == "VALMETA_OE_REML_HKSJ"
    assert plan.execution_allowed is True
    assert len(plan.validation_evidence_ids) == 3


def test_full_auto_oe_delivery_produces_fact_locked_calibration_article(tmp_path: Path) -> None:
    project, _, _, _, migration, _, delivery = _deliver(tmp_path, auto=True)

    assert delivery.phase.status is ExecutionStatus.SUCCEEDED
    assert delivery.decisions == []
    assert "observed-to-expected ratio" in delivery.manuscript.lower()
    assert "1.108" in delivery.manuscript
    assert "0.900 to 1.363" in delivery.manuscript
    assert "0.430 to 2.856" in delivery.manuscript
    assert "calibration-in-the-large" in delivery.manuscript
    assert "does not establish a calibration slope, individual-risk calibration, or clinical utility" in delivery.manuscript
    assert "pooled c-statistic" not in delivery.manuscript.lower()
    assert project.load_text("draft.md", subdir="manuscript") == delivery.manuscript

    envelope = project.load_json("synthesis_result.json", subdir="analysis")
    assert envelope["primary_estimates"][0]["measure"] == "OE_RATIO"
    assert envelope["primary_estimates"][0]["scale"] == "ratio"
    assert set(envelope["input_result_ids"]) == set(migration.result_ids)
    assert envelope["heterogeneity"]["scale"] == "log_observed_expected_ratio"
    certainty = project.load_json("method_certainty.json", subdir="analysis")
    assert certainty["status"] == MethodCertaintyStatus.COMPLETED.value
    assert build_method_release_review(project)["passed"] is True


def test_oe_normal_mode_returns_method_certainty_options(tmp_path: Path) -> None:
    _, _, _, _, _, _, delivery = _deliver(tmp_path, auto=False)

    assert delivery.phase.status is ExecutionStatus.SUCCEEDED
    assert delivery.decisions[0]["decision_type"] == "method_certainty"
    assert delivery.decisions[0]["recommended_option_id"] == "conservative"
    assert set(delivery.decisions[0]["unresolved_domain_ids"]) == {
        "inconsistency",
        "indirectness",
        "imprecision",
        "publication_bias",
    }


def test_oe_chinese_article_uses_calibration_not_discrimination_language(tmp_path: Path) -> None:
    _, _, _, _, _, _, delivery = _deliver(tmp_path, auto=True, lang="zh")

    assert "观察/预期事件比" in delivery.manuscript
    assert "总体校准" in delivery.manuscript
    assert "校准斜率" in delivery.manuscript
    assert "合并C统计量" not in delivery.manuscript
