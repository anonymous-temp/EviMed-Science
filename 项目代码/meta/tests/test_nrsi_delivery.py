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


def _prepared_nrsi_project(tmp_path: Path):
    project = Project("NRSI delivery", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(
        research_question="Is exposure A associated with 1-year mortality?",
        pico=PICO(
            population="Adults with condition X",
            intervention="Exposure A",
            comparator="No exposure A",
            outcome_primary="1-year all-cause mortality",
        ),
        review_family="intervention_nrsi",
        study_designs=["cohort"],
        primary_outcome_type="time_to_event",
        effect_measure="HR",
        databases=["PubMed", "Embase"],
    )
    rows = (
        ("N1", 0.80, 0.65, 0.98),
        ("N2", 0.75, 0.60, 0.94),
        ("N3", 0.92, 0.72, 1.18),
        ("N4", 0.84, 0.70, 1.01),
    )
    covariates = ["age", "sex", "disease severity"]
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id=study_id,
                title=f"Cohort {study_id}",
                authors=[f"Author{index} Jane"],
                year=2020 + index,
                study_design="cohort",
                country="Country",
                total_sample_size=500 + index * 100,
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="1-year all-cause mortality",
                    outcome_type="time-to-event",
                    effect_size=estimate,
                    ci_lower=lower,
                    ci_upper=upper,
                    reported_effect_measure="HR",
                    reported_effect_scale="original",
                    reported_effect_adjusted=True,
                    adjustment_covariates=covariates,
                    source_quote=(
                        f"Adjusted HR {estimate} (95% CI {lower} to {upper}) after adjustment "
                        "for age, sex, and disease severity."
                    ),
                    source_quote_verified=True,
                    source_location="Results, Table 3",
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
            outcome_name="1-year all-cause mortality",
            tool_used="ROBINS-I",
            tool_version="ROBINS-I (2016)",
            target_effect=RoBTargetEffect.EXPOSURE,
            assessment_status=RoBAssessmentStatus.COMPLETE,
            assessed_by="reviewer@example.org",
            domains=[
                RoBDomain(
                    domain="Confounding",
                    judgment="Moderate risk",
                    support="Prespecified key confounders were adjusted, but residual confounding remains possible.",
                    source_page=3,
                    source_section="Methods",
                    source_quote="Models adjusted for age, sex, and baseline disease severity.",
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
            "identification": {"records_identified": 140, "records_after_dedup": 110},
            "eligibility": {"full_text_assessed": 15},
            "included": {"studies_included": 4},
        },
        search_query='"Exposure A" AND mortality AND cohort',
        lang=lang,
    )


def test_adjusted_cohort_nrsi_has_complete_validated_delivery_chain(tmp_path: Path) -> None:
    project, protocol, studies, assessments, plan = _prepared_nrsi_project(tmp_path)

    assert plan.capability_id == "intervention_nrsi.adjusted_cohort_reml"
    assert plan.capability_status.value == "production"
    envelope = project.load_json("synthesis_result.json", subdir="analysis")
    assert envelope["family"] == "intervention_nrsi"
    assert envelope["primary_estimates"][0]["measure"] == "HR"
    assert envelope["engine_payload"]["adjustment_sets"] == [
        ["age", "disease severity", "sex"]
    ]

    draft = build_method_certainty_draft(project)
    assert draft.status is MethodCertaintyStatus.NEEDS_INPUT
    assert draft.outcomes[0].starting_certainty == "low"
    domains = {item.domain: item for item in draft.outcomes[0].domains}
    assert domains["risk_of_bias"].rating is CertaintyDomainRating.SERIOUS
    assert {
        name for name, domain in domains.items() if domain.requires_human_judgment
    } == {"inconsistency", "indirectness", "imprecision", "publication_bias"}

    completed = save_method_certainty_adjudication(
        project,
        expected_revision=0,
        adjudicated_by="reviewer@example.org",
        reason="Clinical and methods review of the adjusted observational evidence.",
        domain_overrides={
            "inconsistency": {
                "rating": "no_concern",
                "rationale": "Direction and magnitude were sufficiently consistent for the target decision.",
            },
            "indirectness": {
                "rating": "no_concern",
                "rationale": "Population, exposure, comparator, outcome, and time horizon match the protocol.",
            },
            "imprecision": {
                "rating": "serious",
                "rationale": "The interval includes effects too small to alter practice.",
            },
            "publication_bias": {
                "rating": "serious",
                "rationale": "Selective reporting of adjusted models cannot be excluded.",
            },
        },
    )
    assert completed.status is MethodCertaintyStatus.COMPLETED

    manuscript = _render(project, protocol, studies, assessments)
    estimate = envelope["primary_estimates"][0]
    assert "# Adjusted association of Exposure A" in manuscript
    assert "source-verified adjusted hazard ratios" in manuscript
    assert "restricted maximum likelihood" in manuscript
    assert "Hartung-Knapp" in manuscript
    assert "age, disease severity, and sex" in manuscript
    assert f"{estimate['estimate']:.2f}" in manuscript
    assert "unadjusted estimates were not pooled" in manuscript.lower()
    assert "randomized controlled trial" not in manuscript.lower()

    validation = project.load_json("manuscript_validation.json", subdir="manuscript")
    assert validation["passed"] is True
    release = build_method_release_review(project)
    assert release["passed"] is True

    chinese = _render(project, protocol, studies, assessments, lang="zh")
    assert "## 摘要" in chinese
    assert "调整后风险比" in chinese
    assert "ROBINS-I" in chinese
