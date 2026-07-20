from pathlib import Path

import pytest

from new_meta.agents.data_extraction_agent import DataExtractionAgent
from new_meta.core.evidence_ledger import EvidenceLedger
from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.project import Project
from new_meta.schemas.evidence_ledger import ResultEntity
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="28-day all-cause mortality",
        ),
        effect_measure="RR",
    )


def _study(pdf_path: Path, *, events: int = 10) -> ExtractedStudy:
    return ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="S1",
            pmid="12345",
            title="Primary randomized trial",
            authors=["Smith John"],
            year=2024,
            study_design="randomized controlled trial",
            sample_size_intervention=100,
            sample_size_control=100,
            population_description="Adults",
            intervention_description="Treatment",
            control_description="Control",
            pdf_path=str(pdf_path),
        ),
        outcomes=[
            OutcomeData(
                outcome_name="28-day all-cause mortality",
                outcome_type="dichotomous",
                events_intervention=events,
                total_intervention=100,
                events_control=20,
                total_control=100,
                source_page=4,
                source_section="Results",
                source_location="Table 2",
                source_quote=f"Mortality was {events}/100 versus 20/100.",
                source_quote_verified=True,
                extraction_confidence="high",
            )
        ],
    )


def test_legacy_extractions_migrate_to_stable_result_graph(tmp_path: Path) -> None:
    project = Project("ledger migration", output_dir=tmp_path / "project")
    pdf = tmp_path / "trial.pdf"
    pdf.write_bytes(b"primary report bytes")

    report = migrate_extractions_to_ledger(
        project,
        protocol=_protocol(),
        extracted_studies=[_study(pdf)],
    )
    ledger = EvidenceLedger(report.ledger_path, review_id=report.review_id)
    result = ledger.current(report.result_ids[0], model=ResultEntity)

    assert report.created_entities == 6
    assert report.superseded_entities == 0
    assert ledger.verify().valid is True
    assert result.raw_data.events_intervention == 10
    assert result.source_locators[0].page == 4
    assert result.source_locators[0].file_sha256
    assert result.source_locators[0].quote_verified is True
    manifest = project.load_json("ledger_migration.json", subdir="evidence")
    assert manifest["review_id"] == report.review_id
    assert manifest["result_ids"] == report.result_ids


def test_migration_is_idempotent_and_versions_changed_results(tmp_path: Path) -> None:
    project = Project("ledger migration", output_dir=tmp_path / "project")
    pdf = tmp_path / "trial.pdf"
    pdf.write_bytes(b"primary report bytes")

    first = migrate_extractions_to_ledger(
        project,
        protocol=_protocol(),
        extracted_studies=[_study(pdf)],
    )
    unchanged = migrate_extractions_to_ledger(
        project,
        protocol=_protocol(),
        extracted_studies=[_study(pdf)],
    )
    corrected = migrate_extractions_to_ledger(
        project,
        protocol=_protocol(),
        extracted_studies=[_study(pdf, events=11)],
    )
    ledger = EvidenceLedger(corrected.ledger_path, review_id=corrected.review_id)

    assert unchanged.created_entities == 0
    assert unchanged.superseded_entities == 0
    assert unchanged.unchanged_entities == 6
    assert corrected.superseded_entities == 1
    assert ledger.current(first.result_ids[0], model=ResultEntity).raw_data.events_intervention == 11
    result_events = [event for event in ledger.events() if event.entity_id == first.result_ids[0]]
    assert [event.entity_version for event in result_events] == [1, 2]


def test_generic_rct_label_without_dependency_metadata_keeps_aggregate_data(tmp_path: Path) -> None:
    project = Project("generic RCT migration", output_dir=tmp_path / "project")
    study = _study(tmp_path / "trial.pdf")
    study.outcomes[0].comparative_design = "RCT"
    study.outcomes[0].treatment_arm = "Treatment"
    study.outcomes[0].reference_arm = "Control"

    report = migrate_extractions_to_ledger(
        project,
        protocol=_protocol(),
        extracted_studies=[study],
    )
    ledger = EvidenceLedger(report.ledger_path, review_id=report.review_id)
    result = ledger.current(report.result_ids[0], model=ResultEntity)

    assert result.raw_data.data_type == "dichotomous"
    assert result.raw_data.events_intervention == 10
    assert len(report.warnings) == 1
    assert "preserved as an ordinary aggregate result" in report.warnings[0]


def test_complex_rct_label_without_dependency_metadata_fails_closed(tmp_path: Path) -> None:
    project = Project("incomplete cluster RCT", output_dir=tmp_path / "project")
    study = _study(tmp_path / "trial.pdf")
    study.outcomes[0].comparative_design = "cluster_rct"
    study.outcomes[0].treatment_arm = "Treatment"
    study.outcomes[0].reference_arm = "Control"

    with pytest.raises(ValueError, match="incomplete cluster_rct dependency metadata"):
        migrate_extractions_to_ledger(
            project,
            protocol=_protocol(),
            extracted_studies=[study],
        )


def test_comparative_result_without_computable_effect_is_preserved_but_not_synthesized(
    tmp_path: Path,
) -> None:
    project = Project("incomplete comparative result", output_dir=tmp_path / "project")
    study = _study(tmp_path / "trial.pdf")
    outcome = study.outcomes[0]
    outcome.comparative_design = "parallel_rct"
    outcome.treatment_arm = "Treatment"
    outcome.reference_arm = "Control"
    outcome.contrast_id = "treatment-v-control"
    outcome.estimand_id = "primary-md"
    outcome.precision_basis = "reported aggregate"
    outcome.events_intervention = None
    outcome.total_intervention = None
    outcome.events_control = None
    outcome.total_control = None

    protocol = _protocol().model_copy(update={"effect_measure": "MD"})
    report = migrate_extractions_to_ledger(
        project,
        protocol=protocol,
        extracted_studies=[study],
    )
    ledger = EvidenceLedger(report.ledger_path, review_id=report.review_id)
    result = ledger.current(report.result_ids[0], model=ResultEntity)

    assert result.raw_data.data_type == "comparative_effect"
    assert result.estimate is None
    assert len(report.warnings) == 1
    assert "excluded from synthesis pending source data" in report.warnings[0]


def test_data_extraction_persists_legacy_and_ledger_views(
    tmp_path: Path,
    monkeypatch,
) -> None:
    project = Project("extraction dual write", output_dir=tmp_path / "project")
    pdf = tmp_path / "trial.pdf"
    pdf.write_bytes(b"primary report bytes")
    study = _study(pdf)
    agent = DataExtractionAgent()
    monkeypatch.setattr(
        agent,
        "_extract_single",
        lambda paper, parsed, protocol, project: study,
    )

    results = agent.run(
        [{"pmid": "12345", "title": "Primary randomized trial"}],
        {"12345": {"full_text": "Mortality was 10/100 versus 20/100."}},
        _protocol(),
        project,
    )

    assert results == [study]
    assert project.get_path("all_extractions.json", subdir="extraction").exists()
    assert project.get_path("ledger.jsonl", subdir="evidence").exists()
    assert project.get_path("ledger_migration.json", subdir="evidence").exists()
