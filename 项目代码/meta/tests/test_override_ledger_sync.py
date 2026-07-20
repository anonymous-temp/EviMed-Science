from pathlib import Path

from start import _apply_overrides_to_existing_extractions
from new_meta.core.evidence_ledger import EvidenceLedger
from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.extraction_review import ExtractionOverride, save_extraction_override
from new_meta.core.project import Project
from new_meta.schemas.evidence_ledger import ActorType, LedgerAction, ResultEntity
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="mortality",
        ),
        effect_measure="RR",
    )


def _study() -> ExtractedStudy:
    return ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="S1",
            title="Trial one",
            authors=["Smith John"],
            year=2024,
            study_design="randomized controlled trial",
            sample_size_intervention=100,
            sample_size_control=100,
            population_description="Adults",
            intervention_description="Treatment",
            control_description="Control",
        ),
        outcomes=[
            OutcomeData(
                outcome_name="mortality",
                outcome_type="dichotomous",
                events_intervention=10,
                total_intervention=100,
                events_control=20,
                total_control=100,
                source_page=4,
                source_section="Results",
                source_location="Table 2",
                source_quote="Mortality was 10/100 versus 20/100.",
                source_quote_verified=True,
                extraction_confidence="high",
            )
        ],
    )


def test_human_override_adjudicates_the_canonical_result_entity(tmp_path: Path) -> None:
    project = Project("override ledger", output_dir=tmp_path / "project")
    protocol = _protocol()
    study = _study()
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", [study], subdir="extraction")
    initial = migrate_extractions_to_ledger(
        project,
        protocol=protocol,
        extracted_studies=[study],
    )
    save_extraction_override(
        project,
        ExtractionOverride(
            study_id="S1",
            outcome_index=0,
            outcome_name="mortality",
            field="events_intervention",
            value=11,
            reason="Checked against Table 2",
            updated_by="reviewer-7",
        ),
        expected_revision=0,
    )

    result = _apply_overrides_to_existing_extractions(project)
    ledger = EvidenceLedger(initial.ledger_path, review_id=initial.review_id)
    entity = ledger.current(initial.result_ids[0], model=ResultEntity)
    events = [event for event in ledger.events() if event.entity_id == initial.result_ids[0]]

    assert result["ledger"]["superseded_entities"] == 1
    assert entity.raw_data.events_intervention == 11
    assert entity.evidence_state.value == "adjudicated"
    assert [event.entity_version for event in events] == [1, 2]
    assert events[-1].action is LedgerAction.ADJUDICATE
    assert events[-1].actor.actor_type is ActorType.HUMAN
    assert events[-1].actor.actor_id == "reviewer-7"
    assert events[-1].reason == "extraction override revision 1"
