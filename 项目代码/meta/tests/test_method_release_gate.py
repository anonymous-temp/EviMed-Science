from pathlib import Path

from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.method_release import build_method_release_review
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def test_method_release_fails_closed_without_result_rob_and_certainty(tmp_path: Path) -> None:
    project = Project("method release", output_dir=tmp_path / "project")
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
    migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies)
    compile_project_method_plan(project, protocol, enforce=True)
    synthesis = PipelineRunner(project).run_compiled_method_synthesis()
    assert synthesis.status.value == "succeeded"

    review = build_method_release_review(project)

    assert review["passed"] is False
    assert review["status"] == "blocked"
    checks = {item["id"]: item for item in review["checks"]}
    assert checks["capability_validation"]["passed"] is True
    assert checks["ledger_snapshot_integrity"]["passed"] is True
    assert checks["exact_method_inputs"]["passed"] is True
    assert checks["result_level_risk_of_bias"]["passed"] is False
    assert checks["method_specific_certainty"]["passed"] is False
    assert set(review["blocker_codes"]) >= {
        "result_level_risk_of_bias_incomplete",
        "method_specific_certainty_missing",
    }
