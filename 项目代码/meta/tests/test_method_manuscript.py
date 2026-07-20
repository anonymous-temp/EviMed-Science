from pathlib import Path

from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.method_manuscript import build_method_manuscript
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def test_prevalence_method_manuscript_is_family_specific_and_fact_locked(tmp_path: Path) -> None:
    project = Project("prevalence manuscript", output_dir=tmp_path / "project")
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
        databases=["PubMed", "Embase"],
    )
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id=study_id,
                title=f"Survey {study_id}",
                authors=[f"Author{index} Jane"],
                year=2020 + index,
                study_design="cross-sectional",
                country="Country",
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
    migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies)
    compile_project_method_plan(project, protocol, enforce=True)
    synthesis = PipelineRunner(project).run_compiled_method_synthesis()
    assert synthesis.status.value == "succeeded"

    manuscript = build_method_manuscript(
        project=project,
        protocol=protocol,
        extracted_studies=studies,
        rob_results=[],
        prisma_data={
            "identification": {"records_identified": 120, "records_after_dedup": 100},
            "eligibility": {"full_text_assessed": 8},
            "included": {"studies_included": 3},
        },
        search_query='"Condition X"[tiab] AND prevalence[tiab]',
        lang="en",
    )

    for heading in (
        "# Prevalence of Condition X",
        "## Abstract",
        "## Introduction",
        "## Methods",
        "## Results",
        "## Discussion",
        "## Conclusions",
        "## Declarations",
    ):
        assert heading in manuscript
    assert "binomial-normal generalized linear mixed model" in manuscript
    assert "logit link" in manuscript
    assert "10.0%" in manuscript
    assert "DerSimonian-Laird" not in manuscript
    assert "risk ratio" not in manuscript.lower()
    assert "Freeman-Tukey" not in manuscript
    assert project.load_text("draft.md", subdir="manuscript") == manuscript
    facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    validation = project.load_json("manuscript_validation.json", subdir="manuscript")
    assert facts["method_family"] == "prevalence_incidence"
    assert validation["passed"] is True
    assert validation["method_family"] == "prevalence_incidence"
    assert validation["exact_result_values_present"] is True
