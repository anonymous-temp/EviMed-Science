from pathlib import Path

import pytest
from pydantic import ValidationError

from new_meta.core.evidence_ledger import (
    EvidenceLedger,
    LedgerConflictError,
    LedgerIntegrityError,
)
from new_meta.schemas.evidence_ledger import (
    ActorType,
    ArmEntity,
    DichotomousData,
    EvidenceActor,
    EvidenceState,
    OutcomeEntity,
    ReportEntity,
    ResultEntity,
    SourceLocator,
    StudyEntity,
)


def _actor() -> EvidenceActor:
    return EvidenceActor(actor_id="reviewer-1", actor_type=ActorType.HUMAN)


def _source() -> SourceLocator:
    return SourceLocator(
        document_id="report:R1",
        file_sha256="a" * 64,
        page=4,
        table="Table 2",
        quote="Mortality was 10/100 versus 20/100.",
        quote_verified=True,
    )


def _append_result_graph(ledger: EvidenceLedger) -> ResultEntity:
    actor = _actor()
    ledger.create(
        ReportEntity(
            entity_id="report:R1",
            review_id=ledger.review_id,
            title="Primary trial report",
            doi="10.1000/trial",
            file_sha256="a" * 64,
        ),
        actor=actor,
    )
    ledger.create(
        StudyEntity(
            entity_id="study:S1",
            review_id=ledger.review_id,
            title="Trial S1",
            design="parallel_rct",
            report_ids=["report:R1"],
        ),
        actor=actor,
    )
    for entity in (
        ArmEntity(
            entity_id="arm:S1:I",
            review_id=ledger.review_id,
            study_id="study:S1",
            name="Treatment",
            role="intervention",
            sample_size=100,
        ),
        ArmEntity(
            entity_id="arm:S1:C",
            review_id=ledger.review_id,
            study_id="study:S1",
            name="Control",
            role="comparator",
            sample_size=100,
        ),
        OutcomeEntity(
            entity_id="outcome:mortality",
            review_id=ledger.review_id,
            name="28-day all-cause mortality",
            outcome_type="dichotomous",
            direction="lower_is_better",
        ),
    ):
        ledger.create(entity, actor=actor)

    result = ResultEntity(
        entity_id="result:S1:mortality:28d",
        review_id=ledger.review_id,
        study_id="study:S1",
        report_id="report:R1",
        outcome_id="outcome:mortality",
        arm_ids=["arm:S1:I", "arm:S1:C"],
        timepoint="28 days",
        analysis_population="intention_to_treat",
        effect_measure="RR",
        raw_data=DichotomousData(
            events_intervention=10,
            total_intervention=100,
            events_control=20,
            total_control=100,
        ),
        source_locators=[_source()],
        evidence_state=EvidenceState.VERIFIED,
    )
    ledger.create(result, actor=actor)
    return result


def test_result_level_ledger_is_append_only_and_hash_chained(tmp_path: Path) -> None:
    ledger = EvidenceLedger(tmp_path / "ledger.jsonl", review_id="review:1")
    result = _append_result_graph(ledger)

    verification = ledger.verify()
    current = ledger.current(result.entity_id, model=ResultEntity)

    assert verification.valid is True
    assert verification.event_count == 6
    assert current.raw_data.events_intervention == 10
    assert current.source_locators[0].page == 4
    assert ledger.events()[0].previous_hash == ""
    assert ledger.events()[-1].previous_hash == ledger.events()[-2].event_hash


def test_result_supersession_requires_expected_version(tmp_path: Path) -> None:
    ledger = EvidenceLedger(tmp_path / "ledger.jsonl", review_id="review:1")
    result = _append_result_graph(ledger)
    corrected = result.model_copy(
        update={
            "raw_data": DichotomousData(
                events_intervention=11,
                total_intervention=100,
                events_control=20,
                total_control=100,
            )
        }
    )

    event = ledger.supersede(corrected, actor=_actor(), expected_version=1, reason="table correction")

    assert event.entity_version == 2
    assert ledger.current(result.entity_id, model=ResultEntity).raw_data.events_intervention == 11
    with pytest.raises(LedgerConflictError):
        ledger.supersede(result, actor=_actor(), expected_version=1, reason="stale edit")


def test_ledger_detects_payload_tampering(tmp_path: Path) -> None:
    path = tmp_path / "ledger.jsonl"
    ledger = EvidenceLedger(path, review_id="review:1")
    _append_result_graph(ledger)
    path.write_text(
        path.read_text(encoding="utf-8").replace("Primary trial report", "Altered report"),
        encoding="utf-8",
    )

    verification = ledger.verify()

    assert verification.valid is False
    assert verification.errors
    with pytest.raises(LedgerIntegrityError):
        ledger.assert_valid()


def test_verified_result_requires_verified_source_quote() -> None:
    with pytest.raises(ValidationError, match="verified source locator"):
        ResultEntity(
            entity_id="result:S1:mortality",
            review_id="review:1",
            study_id="study:S1",
            report_id="report:R1",
            outcome_id="outcome:mortality",
            arm_ids=["arm:S1:I", "arm:S1:C"],
            effect_measure="RR",
            raw_data=DichotomousData(
                events_intervention=1,
                total_intervention=10,
                events_control=2,
                total_control=10,
            ),
            source_locators=[
                SourceLocator(
                    document_id="report:R1",
                    quote="1/10 vs 2/10",
                    quote_verified=False,
                )
            ],
            evidence_state=EvidenceState.VERIFIED,
        )


def test_result_rejects_references_missing_from_ledger(tmp_path: Path) -> None:
    ledger = EvidenceLedger(tmp_path / "ledger.jsonl", review_id="review:1")
    orphan = ResultEntity(
        entity_id="result:orphan",
        review_id="review:1",
        study_id="study:missing",
        report_id="report:missing",
        outcome_id="outcome:missing",
        arm_ids=["arm:missing:I", "arm:missing:C"],
        effect_measure="RR",
        raw_data=DichotomousData(
            events_intervention=1,
            total_intervention=10,
            events_control=2,
            total_control=10,
        ),
        source_locators=[_source()],
        evidence_state=EvidenceState.VERIFIED,
    )

    with pytest.raises(LedgerIntegrityError, match="missing referenced entities"):
        ledger.create(orphan, actor=_actor())

