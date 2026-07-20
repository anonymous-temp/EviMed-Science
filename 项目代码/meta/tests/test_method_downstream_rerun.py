"""Regression coverage for route-aware Web downstream reruns."""

from uuid import uuid4

import start
from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _project_under_output() -> Project:
    root = start.META_ROOT / "output" / "pytest_method_downstream" / uuid4().hex
    return Project("method downstream rerun", output_dir=root)


def test_downstream_rerun_uses_compiled_method_route_not_pairwise_selector(monkeypatch) -> None:
    """A Web correction must re-run prevalence from ledger rows, never RR/OR selection."""
    project = _project_under_output()
    protocol = ResearchProtocol(
        research_question="What is the prevalence of condition X in adults?",
        pico=PICO(
            population="Adults",
            intervention="Not applicable",
            comparator="Not applicable",
            outcome_primary="Condition X prevalence",
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
                authors=[f"Author{index} Jane"],
                year=2020 + index,
                study_design="cross-sectional",
                total_sample_size=total,
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="Condition X prevalence",
                    outcome_type="proportion",
                    events=events,
                    total_n=total,
                    source_quote=f"Condition X was present in {events} of {total} adults.",
                    source_quote_verified=True,
                    source_location="Results, Table 1",
                    source_page=index,
                )
            ],
        )
        for index, (study_id, events, total) in enumerate(
            (("S1", 10, 100), ("S2", 20, 200), ("S3", 5, 50)), start=1
        )
    ]
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", studies, subdir="extraction")
    migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies)
    compile_project_method_plan(project, protocol, enforce=True)

    def pairwise_selector_must_not_run(*args, **kwargs):
        raise AssertionError("method-plugin reruns must not call the pairwise effect selector")

    monkeypatch.setattr(start, "_compute_primary_effect_selection", pairwise_selector_must_not_run)
    result = start._run_downstream_after_overrides_payload(
        {"project_dir": str(project.base_dir), "output_language": "en"}
    )

    assert result["ok"] is True
    assert result["synthesis_route"] == "method_plugin"
    assert result["n_method_inputs"] == 3
    assert result["execution"]["status"] == "blocked"  # certainty adjudication blocks release
    assert project.get_path("method_result.json", subdir="analysis").exists()
    assert project.get_path("synthesis_result.json", subdir="analysis").exists()
    assert project.get_path("method_certainty.json", subdir="analysis").exists()
    assert "binomial-normal generalized linear mixed model" in project.load_text(
        "draft.md", subdir="manuscript"
    )
