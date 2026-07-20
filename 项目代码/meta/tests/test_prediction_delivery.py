from pathlib import Path

from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.method_certainty import (
    build_method_certainty_draft,
    save_method_certainty_adjudication,
)
from new_meta.core.method_manuscript import build_method_manuscript
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.method_release import build_method_release_review
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.project import Project
from new_meta.schemas.method_certainty import CertaintyDomainRating, MethodCertaintyStatus
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.risk_of_bias import (
    ResultRoBAssessment,
    RoBAssessmentStatus,
    RoBDomain,
    RoBTargetEffect,
)
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _prepared_prediction_project(tmp_path: Path):
    project = Project("prediction delivery", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(
        research_question="How well does Model X discriminate 30-day mortality?",
        pico=PICO(
            population="Adults undergoing cardiac surgery",
            intervention="Model X",
            comparator="Observed 30-day mortality",
            outcome_primary="30-day mortality discrimination",
        ),
        review_family="prediction_model",
        study_designs=["external validation"],
        primary_outcome_type="discrimination",
        effect_measure="C_STATISTIC",
        databases=["PubMed", "Embase"],
    )
    rows = (
        ("V1", 0.78, 0.020, 1200, 90),
        ("V2", 0.82, 0.018, 1800, 130),
        ("V3", 0.75, 0.025, 900, 70),
        ("V4", 0.80, 0.015, 2500, 160),
        ("V5", 0.77, 0.022, 1100, 85),
    )
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id=study_id,
                title=f"External validation {study_id}",
                authors=[f"Author{index} Jane"],
                year=2020 + index,
                study_design="external validation",
                country="Country",
                total_sample_size=sample_size,
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="30-day mortality discrimination",
                    outcome_type="discrimination",
                    timepoint="30 days",
                    accepted_timepoint="30 days",
                    prediction_model_id="Model X",
                    prediction_model_version="2.1",
                    prediction_validation_type="external",
                    prediction_performance_measure="C_STATISTIC",
                    prediction_performance_estimate=cstat,
                    prediction_performance_se=se,
                    prediction_sample_size=sample_size,
                    prediction_events=events,
                    source_quote=(
                        f"External validation of Model X version 2.1 at 30 days yielded "
                        f"a c-statistic of {cstat} (SE {se})."
                    ),
                    source_quote_verified=True,
                    source_location="Results, Table 2",
                    source_page=index,
                )
            ],
        )
        for index, (study_id, cstat, se, sample_size, events) in enumerate(rows, start=1)
    ]
    migration = migrate_extractions_to_ledger(
        project,
        protocol=protocol,
        extracted_studies=studies,
    )
    plan = compile_project_method_plan(project, protocol, enforce=True)
    phase = PipelineRunner(project).run_compiled_method_synthesis()
    assert phase.status.value == "succeeded"
    assessments = [
        ResultRoBAssessment(
            assessment_id=f"rob:{result_id}:complete",
            result_id=result_id,
            study_id=study_id,
            outcome_name="30-day mortality discrimination",
            tool_used="PROBAST",
            tool_version="PROBAST (2019)",
            target_effect=RoBTargetEffect.PREDICTION_MODEL,
            assessment_status=RoBAssessmentStatus.COMPLETE,
            assessed_by="reviewer@example.org",
            domains=[
                RoBDomain(
                    domain="Analysis",
                    judgment="Low risk",
                    support="The original model was applied without refitting and performance was estimated appropriately.",
                    source_page=3,
                    source_section="Methods",
                    source_quote="The published model coefficients and intercept were applied unchanged.",
                )
            ],
            overall_judgment="Low risk",
            requires_adjudication=False,
        )
        for result_id, (study_id, *_values) in zip(migration.result_ids, rows)
    ]
    project.save_json("rob_result_assessments.json", assessments, subdir="risk_of_bias")
    return project, protocol, studies, assessments, plan


def _render(project, protocol, studies, assessments, *, lang="en"):
    return build_method_manuscript(
        project=project,
        protocol=protocol,
        extracted_studies=studies,
        rob_results=assessments,
        prisma_data={
            "identification": {"records_identified": 90, "records_after_dedup": 70},
            "eligibility": {"full_text_assessed": 10},
            "included": {"studies_included": 5},
        },
        search_query='"Model X" AND external validation AND mortality',
        lang=lang,
    )


def test_external_cstat_prediction_review_has_complete_scoped_delivery_chain(
    tmp_path: Path,
) -> None:
    project, protocol, studies, assessments, plan = _prepared_prediction_project(tmp_path)

    assert plan.capability_id == "prediction_model.external_cstat_reml"
    assert plan.capability_status.value == "production"
    envelope = project.load_json("synthesis_result.json", subdir="analysis")
    assert envelope["family"] == "prediction_model"
    assert envelope["primary_estimates"][0]["measure"] == "C_STATISTIC"
    assert envelope["engine_payload"]["model_id"] == "Model X"
    assert envelope["engine_payload"]["model_version"] == "2.1"

    draft = build_method_certainty_draft(project)
    assert draft.status is MethodCertaintyStatus.NEEDS_INPUT
    assert "not GRADE" in draft.framework_note
    domains = {item.domain: item for item in draft.outcomes[0].domains}
    assert domains["risk_of_bias"].rating is CertaintyDomainRating.NO_CONCERN
    assert domains["performance_completeness"].rating is CertaintyDomainRating.VERY_SERIOUS

    completed = save_method_certainty_adjudication(
        project,
        expected_revision=0,
        adjudicated_by="reviewer@example.org",
        reason="Clinical review of validation applicability and uncertainty.",
        domain_overrides={
            "inconsistency": {
                "rating": "serious",
                "rationale": "Discrimination varied enough to affect transportability.",
            },
            "indirectness": {
                "rating": "no_concern",
                "rationale": "Population, model version, outcome, and horizon match the review target.",
            },
            "imprecision": {
                "rating": "no_concern",
                "rationale": "The interval is sufficiently narrow for discrimination appraisal.",
            },
            "publication_bias": {
                "rating": "serious",
                "rationale": "Unpublished external validations cannot be excluded.",
            },
        },
    )
    assert completed.status is MethodCertaintyStatus.COMPLETED

    manuscript = _render(project, protocol, studies, assessments)
    estimate = envelope["primary_estimates"][0]
    assert "# External validation performance of Model X version 2.1" in manuscript
    assert "logit c-statistic" in manuscript
    assert "restricted maximum likelihood" in manuscript
    assert "Hartung-Knapp" in manuscript
    assert "PROBAST" in manuscript
    assert f"{estimate['estimate']:.3f}" in manuscript
    assert "Calibration was not synthesized" in manuscript
    assert "must not be used to recommend clinical deployment" in manuscript
    assert build_method_release_review(project)["passed"] is True

    chinese = _render(project, protocol, studies, assessments, lang="zh")
    assert "外部验证" in chinese
    assert "C统计量" in chinese
    assert "未合并校准" in chinese
