from __future__ import annotations

from pathlib import Path

from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.method_delivery import run_method_delivery
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.project import Project
from new_meta.schemas.method_certainty import MethodCertaintyStatus
from new_meta.schemas.method_policy import CapabilityStatus
from new_meta.schemas.phase_result import ExecutionStatus
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _incidence_project(tmp_path: Path):
    project = Project("incidence delivery", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(
        research_question="What is the incidence of bloodstream infection in adults?",
        pico=PICO(
            population="Adults with central venous catheters",
            intervention="Not applicable",
            comparator="Not applicable",
            outcome_primary="Bloodstream infection incidence",
        ),
        effect_measure="IR",
        review_family="prevalence_incidence",
        primary_outcome_type="incidence_rate",
        study_designs=["cohort"],
        databases=["PubMed", "Embase"],
    )
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id=study_id,
                title=f"Cohort {study_id}",
                authors=[f"Author{index} Jane"],
                year=2020 + index,
                study_design="cohort",
                country="Country",
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="Bloodstream infection incidence",
                    outcome_type="incidence_rate",
                    events=events,
                    person_time=person_time,
                    person_time_unit="person_years",
                    source_quote=(
                        f"There were {events} infections during {person_time} person-years."
                    ),
                    source_quote_verified=True,
                    source_location="Results, Table 2",
                    source_page=index,
                )
            ],
        )
        for index, (study_id, events, person_time) in enumerate(
            (("S1", 10, 1000), ("S2", 20, 2000), ("S3", 5, 500)),
            start=1,
        )
    ]
    migration = migrate_extractions_to_ledger(
        project,
        protocol=protocol,
        extracted_studies=studies,
    )
    return project, protocol, studies, migration


def test_incidence_compiles_to_production_poisson_capability(tmp_path: Path) -> None:
    project, protocol, _, _ = _incidence_project(tmp_path)

    plan = compile_project_method_plan(project, protocol, enforce=True)

    assert plan.capability_id == "incidence.poisson.glmm"
    assert plan.capability_status is CapabilityStatus.PRODUCTION
    assert plan.primary_estimator == "GLMM_POISSON"
    assert plan.execution_allowed is True
    assert len(plan.validation_evidence_ids) == 3


def test_full_auto_incidence_delivery_produces_fact_locked_article(tmp_path: Path) -> None:
    project, protocol, studies, migration = _incidence_project(tmp_path)
    compile_project_method_plan(project, protocol, enforce=True)

    delivery = run_method_delivery(
        project=project,
        protocol=protocol,
        extracted_studies=studies,
        rob_results=[],
        prisma_data={
            "identification": {"records_identified": 80, "records_after_dedup": 70},
            "eligibility": {"full_text_assessed": 6},
            "included": {"studies_included": 3},
        },
        search_query='"bloodstream infection"[tiab] AND incidence[tiab]',
        lang="en",
        auto_resolve_uncertainty=True,
    )

    assert delivery.phase.status is ExecutionStatus.SUCCEEDED
    assert delivery.decisions == []
    assert "Incidence of Bloodstream infection" in delivery.manuscript
    assert "Poisson-normal generalized linear mixed model" in delivery.manuscript
    assert "10.0 per 1,000 person-years" in delivery.manuscript
    assert "binomial-normal" not in delivery.manuscript
    assert project.load_text("draft.md", subdir="manuscript") == delivery.manuscript

    envelope = project.load_json("synthesis_result.json", subdir="analysis")
    assert envelope["primary_estimates"][0]["measure"] == "IR"
    assert envelope["input_result_ids"] == migration.result_ids
    assert envelope["engine_payload"]["time_unit"] == "person_years"
    certainty = project.load_json("method_certainty.json", subdir="analysis")
    assert certainty["status"] == MethodCertaintyStatus.COMPLETED.value
    validation = project.load_json("manuscript_validation.json", subdir="manuscript")
    assert validation["passed"] is True
    assert validation["exact_result_values_present"] is True


def test_incidence_normal_mode_returns_concise_certainty_options(tmp_path: Path) -> None:
    project, protocol, studies, _ = _incidence_project(tmp_path)
    compile_project_method_plan(project, protocol, enforce=True)

    delivery = run_method_delivery(
        project=project,
        protocol=protocol,
        extracted_studies=studies,
        rob_results=[],
        prisma_data={},
        search_query="incidence",
        lang="en",
        auto_resolve_uncertainty=False,
    )

    assert delivery.phase.status is ExecutionStatus.SUCCEEDED
    assert delivery.decisions[0]["decision_type"] == "method_certainty"
    assert delivery.decisions[0]["recommended_option_id"] == "conservative"
