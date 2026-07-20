from pathlib import Path

from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.method_certainty import (
    build_method_certainty_option_payload,
    complete_method_certainty_conservatively,
    build_method_certainty_draft,
    save_method_certainty_adjudication,
)
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


def _prepared_project(tmp_path: Path):
    project = Project("certainty", output_dir=tmp_path / "project")
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
        study_designs=["cross-sectional"],
    )
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id=study_id,
                title=f"Survey {study_id}",
                authors=["Smith John"],
                year=2024,
                study_design="cross-sectional",
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="Disease prevalence",
                    outcome_type="proportion",
                    events=events,
                    total_n=total,
                    source_quote=f"Results Table 1: {events} of {total} participants.",
                    source_quote_verified=True,
                    source_location="Results, Table 1",
                )
            ],
        )
        for study_id, events, total in (("S1", 10, 100), ("S2", 20, 200), ("S3", 5, 50))
    ]
    migration = migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies)
    compile_project_method_plan(project, protocol, enforce=True)
    PipelineRunner(project).run_compiled_method_synthesis()
    assessments = [
        ResultRoBAssessment(
            assessment_id=f"rob:{result_id}:complete",
            result_id=result_id,
            study_id=study_id,
            outcome_name="Disease prevalence",
            tool_used="JBI Critical Appraisal Checklist for Prevalence Studies",
            tool_version="JBI Prevalence Checklist (2020)",
            target_effect=RoBTargetEffect.PREVALENCE,
            assessment_status=RoBAssessmentStatus.COMPLETE,
            assessed_by="reviewer@example.org",
            domains=[
                RoBDomain(
                    domain="Sample frame",
                    judgment="Low risk",
                    support="Representative frame",
                    source_page=2,
                    source_section="Methods",
                    source_quote="The sampling frame included all eligible adults.",
                )
            ],
            overall_judgment="Low risk",
            requires_adjudication=False,
        )
        for result_id, study_id in zip(migration.result_ids, ("S1", "S2", "S3"))
    ]
    project.save_json("rob_result_assessments.json", assessments, subdir="risk_of_bias")
    return project


def test_prevalence_certainty_requires_explicit_context_adjudication(tmp_path: Path) -> None:
    project = _prepared_project(tmp_path)

    draft = build_method_certainty_draft(project)

    assert draft.status is MethodCertaintyStatus.NEEDS_INPUT
    domains = {item.domain: item for item in draft.outcomes[0].domains}
    assert domains["risk_of_bias"].rating is CertaintyDomainRating.NO_CONCERN
    assert domains["indirectness"].rating is CertaintyDomainRating.NOT_ASSESSED
    assert domains["publication_bias"].rating is CertaintyDomainRating.NOT_ASSESSED
    assert {item.action_id for item in draft.next_actions} == {
        "adjudicate_indirectness",
        "adjudicate_publication_bias",
    }
    payload = build_method_certainty_option_payload(draft)
    assert payload["question"]
    assert payload["recommended_option_id"] == "conservative"
    assert [item["option_id"] for item in payload["options"]] == [
        "conservative",
        "very_conservative",
        "custom",
    ]


def test_full_automatic_mode_uses_explicit_conservative_certainty_defaults(tmp_path: Path) -> None:
    project = _prepared_project(tmp_path)
    draft = build_method_certainty_draft(project)

    completed = complete_method_certainty_conservatively(project, draft)

    assert completed.status is MethodCertaintyStatus.COMPLETED
    assert completed.adjudicated_by == "automatic:conservative-default"
    assert completed.next_actions == []
    domains = {item.domain: item for item in completed.outcomes[0].domains}
    assert domains["indirectness"].rating is CertaintyDomainRating.SERIOUS
    assert domains["publication_bias"].rating is CertaintyDomainRating.SERIOUS
    assert all(item.requires_human_judgment is False for item in domains.values())


def test_human_certainty_adjudication_completes_release_artifact(tmp_path: Path) -> None:
    project = _prepared_project(tmp_path)
    draft = build_method_certainty_draft(project)

    completed = save_method_certainty_adjudication(
        project,
        expected_revision=0,
        adjudicated_by="reviewer@example.org",
        reason="Population and reporting-bias applicability reviewed against protocol.",
        domain_overrides={
            "indirectness": {
                "rating": "no_concern",
                "rationale": "Study populations and settings match the prespecified target population.",
            },
            "publication_bias": {
                "rating": "serious",
                "rationale": "Only three studies were available and selective non-publication cannot be excluded.",
            },
        },
    )

    assert completed.status is MethodCertaintyStatus.COMPLETED
    assert completed.revision == 1
    assert completed.adjudicated_by == "reviewer@example.org"
    assert completed.outcomes[0].certainty in {"moderate", "low", "very_low"}
    review = build_method_release_review(project)
    checks = {item["id"]: item for item in review["checks"]}
    assert checks["result_level_risk_of_bias"]["passed"] is True
    assert checks["method_specific_certainty"]["passed"] is True


def test_completed_certainty_is_invalidated_when_same_result_ids_are_resynthesized(
    tmp_path: Path,
) -> None:
    project = _prepared_project(tmp_path)
    build_method_certainty_draft(project)
    completed = save_method_certainty_adjudication(
        project,
        expected_revision=0,
        adjudicated_by="reviewer@example.org",
        reason="Initial certainty review.",
        domain_overrides={
            "indirectness": {
                "rating": "no_concern",
                "rationale": "Population and setting match the protocol.",
            },
            "publication_bias": {
                "rating": "serious",
                "rationale": "Selective non-publication cannot be excluded.",
            },
        },
    )
    assert len(completed.synthesis_fingerprint) == 64

    synthesis = project.load_json("synthesis_result.json", subdir="analysis")
    synthesis["primary_estimates"][0]["estimate"] += 0.01
    project.save_json("synthesis_result.json", synthesis, subdir="analysis")

    refreshed = build_method_certainty_draft(project)

    assert refreshed.status is MethodCertaintyStatus.NEEDS_INPUT
    assert refreshed.revision == 0
    assert refreshed.synthesis_fingerprint != completed.synthesis_fingerprint
    assert refreshed.adjudicated_by == ""
