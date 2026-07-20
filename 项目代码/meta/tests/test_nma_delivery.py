from pathlib import Path

from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.method_certainty import (
    apply_method_certainty_option,
    build_method_certainty_draft,
    build_method_certainty_option_payload,
)
from new_meta.core.method_manuscript import build_method_manuscript
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.method_certainty import MethodCertaintyStatus
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _prepared_nma_project(tmp_path: Path):
    project = Project("NMA delivery", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(
        research_question="What are the comparative effects of A, B, and C on response?",
        pico=PICO(
            population="Adults with condition X",
            intervention="A, B, and C",
            comparator="A",
            outcome_primary="Response at 12 weeks",
        ),
        review_family="network_meta",
        analysis_type="network",
        interventions=["A", "B", "C"],
        study_designs=["RCT"],
        primary_outcome_type="dichotomous",
        effect_measure="RR",
        databases=["PubMed", "Embase"],
    )
    comparisons = [
        ("AB1", "B", "A", 0.82, 0.69, 0.98),
        ("AB2", "B", "A", 0.86, 0.72, 1.03),
        ("AC1", "C", "A", 0.70, 0.56, 0.88),
        ("AC2", "C", "A", 0.76, 0.61, 0.95),
        ("BC1", "C", "B", 0.88, 0.72, 1.08),
        ("BC2", "C", "B", 0.84, 0.68, 1.04),
    ]
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id=study_id,
                title=f"Trial {study_id}",
                study_design="parallel RCT",
                total_sample_size=200,
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="Response at 12 weeks",
                    outcome_type="dichotomous",
                    effect_size=effect,
                    ci_lower=lower,
                    ci_upper=upper,
                    reported_effect_measure="RR",
                    reported_effect_scale="original",
                    comparative_design="parallel_rct",
                    treatment_arm=treatment,
                    reference_arm=comparator,
                    contrast_id=f"{study_id}:{treatment}-{comparator}",
                    estimand_id="response-12-weeks",
                    precision_basis="reported_effect",
                    source_quote=f"The risk ratio was {effect} (95% CI {lower} to {upper}).",
                    source_quote_verified=True,
                    source_location="Results, Table 2",
                    source_page=4,
                    timepoint="12 weeks",
                )
            ],
        )
        for study_id, treatment, comparator, effect, lower, upper in comparisons
    ]
    migration = migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies)
    plan = compile_project_method_plan(project, protocol, enforce=True)
    transitivity = {
        "transitivity_assessment": {
            "status": "adequate",
            "effect_modifiers": ["baseline severity", "follow-up duration"],
            "rationale": "Severity and follow-up distributions were sufficiently comparable across comparisons.",
        },
        "reference": "A",
        "outcome_direction": "higher",
    }
    phase = PipelineRunner(project).run_compiled_method_synthesis(options=transitivity)
    return project, protocol, studies, migration, plan, phase


def test_network_meta_analysis_has_complete_article_delivery(tmp_path: Path) -> None:
    project, protocol, studies, migration, plan, phase = _prepared_nma_project(tmp_path)

    assert plan.capability_id == "network_meta.aggregate"
    assert plan.capability_status.value == "production"
    assert plan.execution_allowed is True
    assert phase.status.value == "succeeded"
    assert len(migration.result_ids) == 6

    certainty_draft = build_method_certainty_draft(project)
    assert certainty_draft.status is MethodCertaintyStatus.NEEDS_INPUT
    assert len(certainty_draft.outcomes) == 3
    option_payload = build_method_certainty_option_payload(certainty_draft)
    assert len(option_payload["unresolved_domain_ids"]) == len(
        set(option_payload["unresolved_domain_ids"])
    )
    certainty = apply_method_certainty_option(
        project,
        option_id="conservative",
        selected_by="user",
    )
    assert certainty.status is MethodCertaintyStatus.COMPLETED
    assert certainty.revision == 1
    assert len(certainty.outcomes) == 3

    envelope = project.load_json("synthesis_result.json", subdir="analysis")
    assert envelope["family"] == "network_meta"
    assert len(envelope["primary_estimates"]) == 3
    assert envelope["engine_payload"]["network_geometry"]["is_connected"] is True
    assert envelope["engine_payload"]["transitivity_assessment"]["status"] == "adequate"
    assert envelope["engine_payload"]["diagnostics"]["design_by_treatment"]["method"] == (
        "design_by_treatment_interaction"
    )
    assert envelope["engine_payload"]["node_splitting"]

    manuscript = build_method_manuscript(
        project=project,
        protocol=protocol,
        extracted_studies=studies,
        rob_results=[],
        prisma_data={
            "identification": {"records_identified": 150, "records_after_dedup": 120},
            "eligibility": {"full_text_assessed": 18},
            "included": {"studies_included": 6},
        },
        search_query='("A" OR "B" OR "C") AND randomized',
        lang="en",
    )
    assert "network meta-analysis" in manuscript.lower()
    assert "transitivity" in manuscript.lower()
    assert "design-by-treatment" in manuscript.lower()
    assert "node-splitting" in manuscript.lower()
    assert "league table" in manuscript.lower()
    assert "ranking" in manuscript.lower()
    assert "permission" not in manuscript.lower()
    assert "approval" not in manuscript.lower()

    chinese = build_method_manuscript(
        project=project,
        protocol=protocol,
        extracted_studies=studies,
        rob_results=[],
        prisma_data={"included": {"studies_included": 6}},
        search_query='("A" OR "B" OR "C") AND randomized',
        lang="zh",
    )
    assert "网络Meta分析" in chinese
    assert "传递性" in chinese
    assert "设计-治疗交互" in chinese


def test_nma_pauses_with_options_when_transitivity_is_not_yet_adjudicated(tmp_path: Path) -> None:
    project, _protocol, _studies, _migration, _plan, _phase = _prepared_nma_project(tmp_path)
    project.clear_downstream("meta_analysis", include_self=True)

    phase = PipelineRunner(project).run_compiled_method_synthesis(options={"reference": "A"})

    assert phase.status.value == "needs_input"
    assert phase.error_code == "transitivity_assessment_required"
    assert phase.data["decision_type"] == "transitivity_assessment"
    assert phase.data["recommended_option_id"] == "confirm_adequate"
    assert {item["option_id"] for item in phase.data["options"]} == {
        "confirm_adequate",
        "revise_network",
    }
