from pathlib import Path

from new_meta.core.artifact_package_method_entries import iter_method_package_files
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol


def test_method_and_ledger_artifacts_are_included_in_reproducibility_package(tmp_path: Path) -> None:
    project = Project("method package", output_dir=tmp_path / "project")
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
    compile_project_method_plan(project, protocol, enforce=True)
    project.save_text("ledger.jsonl", '{"event":"one"}\n', subdir="evidence")
    for filename in (
        "analysis_set_candidates.json",
        "analysis_set.json",
        "analysis_set_adjudications.json",
        "method_result.json",
        "method_input_audit.json",
        "synthesis_result.json",
    ):
        project.save_json(filename, {"schema_version": 1}, subdir="analysis")

    entries = {arcname for _, arcname in iter_method_package_files(project)}

    assert {
        "analysis/method_plan.json",
        "analysis/method_policy_snapshot.json",
        "analysis/method_validation_snapshot.json",
        "analysis/synthesis_route.json",
        "analysis/analysis_set_candidates.json",
        "analysis/analysis_set.json",
        "analysis/analysis_set_adjudications.json",
        "analysis/method_result.json",
        "analysis/method_input_audit.json",
        "analysis/synthesis_result.json",
        "evidence/review_identity.json",
        "evidence/ledger.jsonl",
    } <= entries
