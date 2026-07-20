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


def _prepared_prognosis_project(tmp_path: Path):
    project = Project("prognosis delivery", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(
        research_question="Is high biomarker X associated with 5-year recurrence?",
        pico=PICO(
            population="Adults treated for cancer Y",
            intervention="High biomarker X",
            comparator="Low biomarker X",
            outcome_primary="5-year recurrence",
        ),
        review_family="prognostic_factor",
        study_designs=["prognostic cohort"],
        primary_outcome_type="time_to_event",
        effect_measure="HR",
        databases=["PubMed", "Embase"],
    )
    rows = (
        ("P1", 1.45, 1.12, 1.88),
        ("P2", 1.62, 1.20, 2.19),
        ("P3", 1.31, 1.01, 1.70),
        ("P4", 1.55, 1.15, 2.09),
    )
    covariates = ["age", "tumor stage", "treatment"]
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id=study_id,
                title=f"Prognostic cohort {study_id}",
                authors=[f"Author{index} Jane"],
                year=2020 + index,
                study_design="prognostic cohort",
                country="Country",
                total_sample_size=400 + index * 50,
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="5-year recurrence",
                    outcome_type="time-to-event",
                    timepoint="5 years",
                    accepted_timepoint="5 years",
                    effect_size=estimate,
                    ci_lower=lower,
                    ci_upper=upper,
                    reported_effect_measure="HR",
                    reported_effect_scale="original",
                    reported_effect_adjusted=True,
                    adjustment_covariates=covariates,
                    source_quote=(
                        f"At 5 years, adjusted HR {estimate} (95% CI {lower} to {upper}) "
                        "after adjustment for age, tumor stage, and treatment."
                    ),
                    source_quote_verified=True,
                    source_location="Results, Table 4",
                    source_page=index,
                )
            ],
        )
        for index, (study_id, estimate, lower, upper) in enumerate(rows, start=1)
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
            outcome_name="5-year recurrence",
            tool_used="QUIPS",
            tool_version="QUIPS",
            target_effect=RoBTargetEffect.PROGNOSTIC_ASSOCIATION,
            assessment_status=RoBAssessmentStatus.COMPLETE,
            assessed_by="reviewer@example.org",
            domains=[
                RoBDomain(
                    domain="Study confounding",
                    judgment="Moderate risk",
                    support="Key clinical covariates were included, but residual confounding remains possible.",
                    source_page=3,
                    source_section="Methods",
                    source_quote="The model adjusted for age, tumor stage, and treatment.",
                )
            ],
            overall_judgment="Moderate risk",
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
            "identification": {"records_identified": 120, "records_after_dedup": 95},
            "eligibility": {"full_text_assessed": 14},
            "included": {"studies_included": 4},
        },
        search_query='"biomarker X" AND recurrence AND prognosis',
        lang=lang,
    )


def test_adjusted_prognostic_factor_has_complete_validated_delivery_chain(
    tmp_path: Path,
) -> None:
    project, protocol, studies, assessments, plan = _prepared_prognosis_project(tmp_path)

    assert plan.capability_id == "prognostic_factor.adjusted_cohort_reml"
    assert plan.capability_status.value == "production"
    analysis_set = project.load_json("analysis_set.json", subdir="analysis")
    assert analysis_set["timepoint"] == "5 years"

    draft = build_method_certainty_draft(project)
    assert draft.status is MethodCertaintyStatus.NEEDS_INPUT
    assert draft.outcomes[0].starting_certainty == "low"
    domains = {item.domain: item for item in draft.outcomes[0].domains}
    assert domains["risk_of_bias"].rating is CertaintyDomainRating.SERIOUS
    assert "QUIPS" in domains["risk_of_bias"].rationale

    completed = save_method_certainty_adjudication(
        project,
        expected_revision=0,
        adjudicated_by="reviewer@example.org",
        reason="Clinical review of prognostic applicability and uncertainty.",
        domain_overrides={
            "inconsistency": {
                "rating": "no_concern",
                "rationale": "Associations were sufficiently consistent at the common horizon.",
            },
            "indirectness": {
                "rating": "no_concern",
                "rationale": "Population, prognostic factor, outcome, and horizon match the protocol.",
            },
            "imprecision": {
                "rating": "serious",
                "rationale": "The confidence interval spans materially different prognostic effects.",
            },
            "publication_bias": {
                "rating": "serious",
                "rationale": "Selective reporting of prognostic models cannot be excluded.",
            },
        },
    )
    assert completed.status is MethodCertaintyStatus.COMPLETED

    manuscript = _render(project, protocol, studies, assessments)
    envelope = project.load_json("synthesis_result.json", subdir="analysis")
    estimate = envelope["primary_estimates"][0]
    assert "# Prognostic association of High biomarker X" in manuscript
    assert "source-verified adjusted hazard ratios" in manuscript
    assert "5 years" in manuscript
    assert "QUIPS" in manuscript
    assert "restricted maximum likelihood" in manuscript
    assert f"{estimate['estimate']:.2f}" in manuscript
    assert "treatment effect" not in manuscript.lower()
    assert build_method_release_review(project)["passed"] is True

    chinese = _render(project, protocol, studies, assessments, lang="zh")
    assert "预后因素" in chinese
    assert "调整后风险比" in chinese
    assert "5年" in chinese or "5 years" in chinese
