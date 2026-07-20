from pathlib import Path

from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.method_certainty import (
    build_method_certainty_draft,
    complete_method_certainty_conservatively,
)
from new_meta.core.method_manuscript import build_method_manuscript
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.method_certainty import MethodCertaintyStatus
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _prepared_dose_project(tmp_path: Path):
    project = Project("Dose response delivery", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(
        research_question="What is the dose-response association between Drug exposure and mortality?",
        pico=PICO(
            population="Adults with condition X",
            intervention="Drug exposure",
            comparator="No exposure",
            outcome_primary="All-cause mortality",
        ),
        review_family="dose_response",
        study_designs=["cohort"],
        primary_outcome_type="dichotomous",
        effect_measure="RR",
        databases=["PubMed", "Embase"],
    )
    effects = {
        "D1": (-0.21, -1.01),
        "D2": (-0.18, -0.98),
        "D3": (-0.22, -1.02),
        "D4": (-0.19, -0.99),
    }
    studies = []
    for study_id, (first, second) in effects.items():
        rows = []
        for dose, estimate, se, other in (
            (1.0, first, 0.20, f"{study_id}:2"),
            (2.0, second, 0.22, f"{study_id}:1"),
        ):
            contrast_id = f"{study_id}:{int(dose)}"
            rows.append(
                OutcomeData(
                    outcome_name="All-cause mortality",
                    outcome_type="dichotomous",
                    effect_size=estimate,
                    reported_effect_standard_error=se,
                    reported_effect_measure="RR",
                    reported_effect_scale="log",
                    reported_effect_adjusted=True,
                    adjustment_covariates=["age", "sex", "baseline severity"],
                    dose_response_design="cohort",
                    dose_value=dose,
                    reference_dose_value=0.0,
                    dose_unit="mg/day",
                    contrast_id=contrast_id,
                    covariance_with={other: 0.015},
                    source_quote=(
                        f"For {dose} mg/day versus no exposure, the adjusted log risk ratio "
                        f"was {estimate} with SE {se}."
                    ),
                    source_quote_verified=True,
                    source_location="Results, Table 3",
                    source_page=5,
                )
            )
        studies.append(
            ExtractedStudy(
                characteristics=StudyCharacteristics(
                    study_id=study_id,
                    title=f"Dose cohort {study_id}",
                    study_design="cohort",
                    total_sample_size=500,
                ),
                outcomes=rows,
            )
        )
    migration = migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies)
    plan = compile_project_method_plan(project, protocol, enforce=True)
    phase = PipelineRunner(project).run_compiled_method_synthesis()
    return project, protocol, studies, migration, plan, phase


def test_dose_response_has_complete_article_delivery(tmp_path: Path) -> None:
    project, protocol, studies, migration, plan, phase = _prepared_dose_project(tmp_path)

    assert plan.capability_id == "dose_response.aggregate_rcs_reml"
    assert plan.capability_status.value == "production"
    assert phase.status.value == "succeeded"
    assert len(migration.result_ids) == 8

    certainty_draft = build_method_certainty_draft(project)
    assert certainty_draft.status is MethodCertaintyStatus.NEEDS_INPUT
    assert certainty_draft.outcomes[0].starting_certainty == "low"
    certainty = complete_method_certainty_conservatively(project, certainty_draft)
    assert certainty.status is MethodCertaintyStatus.COMPLETED

    envelope = project.load_json("synthesis_result.json", subdir="analysis")
    assert envelope["family"] == "dose_response"
    assert envelope["engine_payload"]["dose_unit"] == "mg/day"
    assert envelope["engine_payload"]["knots"] == [0.0, 1.0, 2.0]
    assert envelope["engine_payload"]["nonlinearity"]["p_value"] < 0.05
    assert envelope["engine_payload"]["diagnostics"]["observational_adjustment_set"] == [
        "age",
        "baseline severity",
        "sex",
    ]

    manuscript = build_method_manuscript(
        project=project,
        protocol=protocol,
        extracted_studies=studies,
        rob_results=[],
        prisma_data={
            "identification": {"records_identified": 180, "records_after_dedup": 140},
            "eligibility": {"full_text_assessed": 20},
            "included": {"studies_included": 4},
        },
        search_query='"Drug" AND dose response AND mortality',
        lang="en",
    )
    assert "dose-response" in manuscript.lower()
    assert "restricted cubic spline" in manuscript.lower()
    assert "multivariate restricted maximum likelihood" in manuscript.lower()
    assert "within-study covariance" in manuscript.lower()
    assert "nonlinearity" in manuscript.lower()
    assert "mg/day" in manuscript
    assert "permission" not in manuscript.lower()
    assert "approval" not in manuscript.lower()

    chinese = build_method_manuscript(
        project=project,
        protocol=protocol,
        extracted_studies=studies,
        rob_results=[],
        prisma_data={"included": {"studies_included": 4}},
        search_query='"Drug" AND dose response AND mortality',
        lang="zh",
    )
    assert "剂量-反应" in chinese
    assert "限制性立方样条" in chinese
    assert "多变量限制性最大似然" in chinese
