"""Deterministic import of participant-level study records into the evidence ledger."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

from pydantic import BaseModel, Field

from new_meta.core.evidence_ledger import EvidenceLedger
from new_meta.core.extraction_ledger import ensure_project_review_id
from new_meta.engines.ipd import IPDStudyRecord
from new_meta.schemas.evidence_ledger import (
    ActorType,
    ArmEntity,
    EvidenceActor,
    EvidenceState,
    IPDParticipantData,
    IPDStudyData,
    OutcomeEntity,
    ReportEntity,
    ResultEntity,
    SourceLocator,
    StudyEntity,
)


class IPDIngestionReport(BaseModel):
    schema_version: int = 1
    review_id: str
    ledger_path: str
    dataset_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    result_ids: list[str] = Field(default_factory=list)
    created_entities: int = 0
    superseded_entities: int = 0
    unchanged_entities: int = 0


def load_ipd_json(path: str | Path) -> tuple[list[dict], str | None, dict]:
    """Load the documented JSON interchange shape used by ``--ipd-data``."""
    source = Path(path)
    if not source.is_file():
        raise FileNotFoundError(f"IPD source file not found: {source}")
    payload = json.loads(source.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        records = payload
        outcome_type = None
        options: dict = {}
    elif isinstance(payload, dict):
        records = payload.get("studies")
        outcome_type = payload.get("outcome_type")
        options = {
            key: payload[key]
            for key in ("covariates", "effect_modifier")
            if payload.get(key) is not None and payload.get(key) != ""
        }
    else:
        raise ValueError("IPD JSON must be a study list or an object containing studies")
    if not isinstance(records, list) or not records:
        raise ValueError("IPD JSON must contain a non-empty studies list")
    if "covariates" in options and not isinstance(options["covariates"], list):
        raise ValueError("IPD JSON covariates must be a list of column names")
    return records, (str(outcome_type) if outcome_type else None), options


def ingest_ipd_json_file(
    project,
    *,
    protocol,
    path: str | Path,
    actor: EvidenceActor | None = None,
) -> tuple[IPDIngestionReport, dict]:
    """Load a JSON participant dataset and import it into the project ledger."""
    records, outcome_type, options = load_ipd_json(path)
    report = ingest_ipd_studies_to_ledger(
        project,
        protocol=protocol,
        records=records,
        outcome_type=outcome_type,
        source_path=path,
        actor=actor,
    )
    return report, options


def ingest_ipd_studies_to_ledger(
    project,
    *,
    protocol,
    records: list[IPDStudyRecord | dict],
    outcome_type: str | None = None,
    source_path: str | Path | None = None,
    actor: EvidenceActor | None = None,
) -> IPDIngestionReport:
    """Import one participant dataset per trial as a verified typed result.

    The dataset itself is the source. A canonical SHA-256 digest is recorded even
    when callers provide records in memory, so the exact analysis input remains
    traceable without introducing a separate approval or permission workflow.
    """
    studies = [
        item if isinstance(item, IPDStudyRecord) else IPDStudyRecord.model_validate(item)
        for item in records
    ]
    if not studies:
        raise ValueError("at least one IPD study dataset is required")
    resolved_outcome_type = _normalize_outcome_type(
        outcome_type or getattr(protocol, "primary_outcome_type", "")
    )
    expected_measure = {"binary": "OR", "continuous": "MD", "time_to_event": "HR"}
    measure = str(getattr(protocol, "effect_measure", "") or "").strip().upper()
    if measure != expected_measure[resolved_outcome_type]:
        raise ValueError(
            f"{resolved_outcome_type} IPD requires effect measure "
            f"{expected_measure[resolved_outcome_type]}"
        )

    canonical = [study.model_dump(mode="json") for study in studies]
    dataset_sha256 = hashlib.sha256(
        json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
    ).hexdigest()
    path_text = str(source_path or "")
    if source_path:
        path = Path(source_path)
        if not path.is_file():
            raise FileNotFoundError(f"IPD source file not found: {path}")
        source_digest = hashlib.sha256(path.read_bytes()).hexdigest()
    else:
        source_digest = dataset_sha256

    review_id = ensure_project_review_id(project)
    ledger_path = project.get_path("ledger.jsonl", subdir="evidence")
    ledger = EvidenceLedger(ledger_path, review_id=review_id)
    actor = actor or EvidenceActor(
        actor_id="ipd_dataset_import",
        actor_type=ActorType.IMPORT,
        code_version="ipd-ledger-v1",
    )
    report = IPDIngestionReport(
        review_id=review_id,
        ledger_path=str(ledger_path),
        dataset_sha256=dataset_sha256,
    )
    outcome_name = str(protocol.pico.outcome_primary or "Primary outcome")
    outcome_key = _slug(outcome_name)
    outcome_id = "outcome:ipd:" + outcome_key
    _upsert(
        ledger,
        OutcomeEntity(
            entity_id=outcome_id,
            review_id=review_id,
            name=outcome_name,
            outcome_type=resolved_outcome_type,
            direction=_outcome_direction(outcome_name),
            evidence_state=EvidenceState.EXTRACTED,
        ),
        actor,
        report,
    )

    for study in studies:
        key = _slug(study.study_id)
        report_id = f"report:ipd:{key}"
        study_entity_id = f"study:ipd:{key}"
        intervention_arm_id = f"arm:ipd:{key}:intervention"
        comparator_arm_id = f"arm:ipd:{key}:comparator"
        result_id = f"result:ipd:{key}:{outcome_key}"
        participants = [
            IPDParticipantData(
                participant_id=(item.participant_id.strip() or f"{study.study_id}:{index + 1}"),
                treatment=item.treatment,
                outcome=item.outcome,
                time=item.time,
                event=item.event,
                covariates={
                    name: value
                    for name, value in item.covariates.items()
                    if value is not None
                },
            )
            for index, item in enumerate(study.participants)
        ]
        raw_data = IPDStudyData(
            design=study.design,
            outcome_type=resolved_outcome_type,
            participants=participants,
        )
        source_description = (
            f"Participant-level dataset for {study.study_id}; "
            f"{len(participants)} rows; SHA-256 {source_digest}."
        )
        entities = [
            ReportEntity(
                entity_id=report_id,
                review_id=review_id,
                title=f"Participant-level dataset for {study.study_id}",
                file_sha256=source_digest,
                evidence_state=EvidenceState.EXTRACTED,
                tags=["individual_participant_data"],
            ),
            StudyEntity(
                entity_id=study_entity_id,
                review_id=review_id,
                title=str(study.study_id),
                design=study.design,
                report_ids=[report_id],
                evidence_state=EvidenceState.EXTRACTED,
            ),
            ArmEntity(
                entity_id=intervention_arm_id,
                review_id=review_id,
                study_id=study_entity_id,
                name=str(protocol.pico.intervention or "Intervention"),
                role="intervention",
                sample_size=sum(item.treatment == 1 for item in participants),
                evidence_state=EvidenceState.EXTRACTED,
            ),
            ArmEntity(
                entity_id=comparator_arm_id,
                review_id=review_id,
                study_id=study_entity_id,
                name=str(protocol.pico.comparator or "Comparator"),
                role="comparator",
                sample_size=sum(item.treatment == 0 for item in participants),
                evidence_state=EvidenceState.EXTRACTED,
            ),
        ]
        for entity in entities:
            _upsert(ledger, entity, actor, report)
        _upsert(
            ledger,
            ResultEntity(
                entity_id=result_id,
                review_id=review_id,
                study_id=study_entity_id,
                report_id=report_id,
                outcome_id=outcome_id,
                arm_ids=[intervention_arm_id, comparator_arm_id],
                effect_measure=measure,
                raw_data=raw_data,
                source_locators=[
                    SourceLocator(
                        document_id=report_id,
                        file_path=path_text,
                        file_sha256=source_digest,
                        section="participant_dataset",
                        row=f"1-{len(participants)}",
                        quote=source_description,
                        quote_verified=True,
                    )
                ],
                evidence_state=EvidenceState.VERIFIED,
                derivation={
                    "dataset_sha256": dataset_sha256,
                    "source_sha256": source_digest,
                    "participant_rows": len(participants),
                },
            ),
            actor,
            report,
        )
        report.result_ids.append(result_id)

    ledger.assert_valid()
    project.save_json("ipd_ingestion.json", report, subdir="evidence")
    return report


def _upsert(ledger, entity, actor, report: IPDIngestionReport) -> None:
    version = ledger.entity_version(entity.entity_id)
    payload = entity.model_dump(mode="json")
    if version == 0:
        ledger.create(entity, actor=actor, reason="participant dataset import")
        report.created_entities += 1
    elif ledger.current(entity.entity_id) == payload:
        report.unchanged_entities += 1
    else:
        ledger.supersede(
            entity,
            actor=actor,
            expected_version=version,
            reason="participant dataset changed after import",
        )
        report.superseded_entities += 1


def _normalize_outcome_type(value: str) -> str:
    normalized = str(value or "").strip().lower().replace("-", "_")
    aliases = {"dichotomous": "binary", "time_to_event": "time_to_event"}
    normalized = aliases.get(normalized, normalized)
    if normalized not in {"binary", "continuous", "time_to_event"}:
        raise ValueError(f"unsupported IPD outcome type: {value!r}")
    return normalized


def _slug(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", str(value).strip().lower()).strip("-")
    if normalized:
        return normalized[:80]
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:16]


def _outcome_direction(name: str) -> str:
    lowered = str(name or "").lower()
    if any(term in lowered for term in ("mortality", "death", "harm", "adverse", "hospital")):
        return "lower_is_better"
    if any(term in lowered for term in ("response", "recovery", "survival", "quality of life")):
        return "higher_is_better"
    return "context_dependent"
