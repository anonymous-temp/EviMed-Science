"""Append-only, hash-chained persistence for result-level evidence entities."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import threading
from typing import TypeVar
from uuid import uuid4

from pydantic import BaseModel

from new_meta.schemas.evidence_ledger import (
    ActorType,
    ArmEntity,
    EvidenceActor,
    EvidenceEntity,
    EvidenceState,
    LedgerAction,
    LedgerEntity,
    LedgerEvent,
    LedgerVerification,
    ResultEntity,
    StudyEntity,
    EntityKind,
)


class LedgerError(RuntimeError):
    pass


class LedgerConflictError(LedgerError):
    pass


class LedgerIntegrityError(LedgerError):
    pass


EntityModel = TypeVar("EntityModel", bound=LedgerEntity)


class EvidenceLedger:
    """File-backed event ledger with optimistic concurrency and chain verification."""

    _thread_lock = threading.RLock()

    def __init__(self, path: str | Path, *, review_id: str):
        self.path = Path(path)
        self.review_id = str(review_id).strip()
        if not self.review_id:
            raise ValueError("review_id is required")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock_path = self.path.with_suffix(self.path.suffix + ".lock")

    def events(self) -> list[LedgerEvent]:
        return self._read_events(strict=True)

    def verify(self) -> LedgerVerification:
        errors: list[str] = []
        events = self._read_events(strict=False, errors=errors)
        previous_hash = ""
        versions: dict[str, int] = {}
        for index, event in enumerate(events, start=1):
            if event.sequence != index:
                errors.append(f"event {index}: sequence={event.sequence}")
            if event.review_id != self.review_id:
                errors.append(f"event {index}: review_id mismatch")
            if event.previous_hash != previous_hash:
                errors.append(f"event {index}: previous_hash mismatch")
            expected_hash = self._event_hash(event)
            if event.event_hash != expected_hash:
                errors.append(f"event {index}: event_hash mismatch")
            expected_version = versions.get(event.entity_id, 0) + 1
            if event.entity_version != expected_version:
                errors.append(
                    f"event {index}: entity version {event.entity_version} != {expected_version}"
                )
            versions[event.entity_id] = event.entity_version
            previous_hash = event.event_hash
        return LedgerVerification(
            valid=not errors,
            event_count=len(events),
            head_hash=previous_hash,
            errors=errors,
        )

    def assert_valid(self) -> LedgerVerification:
        result = self.verify()
        if not result.valid:
            raise LedgerIntegrityError("; ".join(result.errors))
        return result

    def current(
        self,
        entity_id: str,
        *,
        model: type[EntityModel] | None = None,
    ) -> EntityModel | dict | None:
        latest = self._current_payloads().get(entity_id)
        if latest is None:
            return None
        payload = latest[1]
        return model.model_validate(payload) if model is not None else payload

    def entity_version(self, entity_id: str) -> int:
        latest = self._current_payloads().get(entity_id)
        return latest[0] if latest is not None else 0

    def current_entities(
        self,
        *,
        kind: EntityKind | None = None,
    ) -> list[dict]:
        """Return the current materialized view without discarding event history."""
        payloads = [payload for _, payload in self._current_payloads().values()]
        if kind is not None:
            payloads = [payload for payload in payloads if payload.get("kind") == kind.value]
        return sorted(payloads, key=lambda payload: str(payload.get("entity_id") or ""))

    def create(
        self,
        entity: EvidenceEntity,
        *,
        actor: EvidenceActor,
        reason: str = "",
    ) -> LedgerEvent:
        return self._append(
            entity,
            actor=actor,
            action=LedgerAction.CREATE,
            expected_version=0,
            reason=reason,
        )

    def supersede(
        self,
        entity: EvidenceEntity,
        *,
        actor: EvidenceActor,
        expected_version: int,
        reason: str,
    ) -> LedgerEvent:
        if not str(reason or "").strip():
            raise ValueError("supersession reason is required")
        return self._append(
            entity,
            actor=actor,
            action=LedgerAction.SUPERSEDE,
            expected_version=expected_version,
            reason=reason,
        )

    def adjudicate(
        self,
        entity: EvidenceEntity,
        *,
        actor: EvidenceActor,
        expected_version: int,
        reason: str,
    ) -> LedgerEvent:
        """Append a human adjudication without rewriting prior evidence history."""
        if actor.actor_type != ActorType.HUMAN:
            raise ValueError("adjudication requires a human actor")
        if entity.evidence_state != EvidenceState.ADJUDICATED:
            raise ValueError("adjudicated entity must have evidence_state=adjudicated")
        if not str(reason or "").strip():
            raise ValueError("adjudication reason is required")
        return self._append(
            entity,
            actor=actor,
            action=LedgerAction.ADJUDICATE,
            expected_version=expected_version,
            reason=reason,
        )

    def _append(
        self,
        entity: EvidenceEntity,
        *,
        actor: EvidenceActor,
        action: LedgerAction,
        expected_version: int,
        reason: str,
    ) -> LedgerEvent:
        if entity.review_id != self.review_id:
            raise LedgerIntegrityError(
                f"entity review_id {entity.review_id!r} does not match ledger {self.review_id!r}"
            )
        with self._locked():
            verification = self.verify()
            if not verification.valid:
                raise LedgerIntegrityError("cannot append to invalid ledger: " + "; ".join(verification.errors))
            events = self._read_events(strict=True)
            current = self._current_payloads(events)
            current_version = current.get(entity.entity_id, (0, None))[0]
            if current_version != expected_version:
                raise LedgerConflictError(
                    f"entity {entity.entity_id!r} expected version {expected_version}, "
                    f"current version is {current_version}"
                )
            self._validate_references(entity, current)
            previous_hash = events[-1].event_hash if events else ""
            event = LedgerEvent(
                event_id=str(uuid4()),
                sequence=len(events) + 1,
                review_id=self.review_id,
                entity_id=entity.entity_id,
                entity_kind=entity.kind,
                entity_version=current_version + 1,
                action=action,
                actor=actor,
                reason=str(reason or "").strip(),
                occurred_at=datetime.now(timezone.utc),
                previous_hash=previous_hash,
                payload=entity.model_dump(mode="json"),
                event_hash="",
            )
            event.event_hash = self._event_hash(event)
            self._write_event(event)
            return event

    def _validate_references(
        self,
        entity: EvidenceEntity,
        current: dict[str, tuple[int, dict]],
    ) -> None:
        referenced: list[str] = []
        if isinstance(entity, StudyEntity):
            referenced.extend(entity.report_ids)
        elif isinstance(entity, ArmEntity):
            referenced.append(entity.study_id)
        elif isinstance(entity, ResultEntity):
            referenced.extend(
                [entity.study_id, entity.report_id, entity.outcome_id, *entity.arm_ids]
            )
        missing = sorted({entity_id for entity_id in referenced if entity_id not in current})
        if missing:
            raise LedgerIntegrityError(
                "missing referenced entities: " + ", ".join(missing)
            )

    def _current_payloads(
        self,
        events: list[LedgerEvent] | None = None,
    ) -> dict[str, tuple[int, dict]]:
        latest: dict[str, tuple[int, dict]] = {}
        for event in events if events is not None else self._read_events(strict=True):
            latest[event.entity_id] = (event.entity_version, event.payload)
        return latest

    def _read_events(
        self,
        *,
        strict: bool,
        errors: list[str] | None = None,
    ) -> list[LedgerEvent]:
        if not self.path.exists():
            return []
        parsed: list[LedgerEvent] = []
        for line_number, line in enumerate(self.path.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            try:
                parsed.append(LedgerEvent.model_validate_json(line))
            except Exception as exc:
                message = f"line {line_number}: invalid event: {exc}"
                if strict:
                    raise LedgerIntegrityError(message) from exc
                if errors is not None:
                    errors.append(message)
        return parsed

    @staticmethod
    def _event_hash(event: LedgerEvent) -> str:
        payload = event.model_dump(mode="json", exclude={"event_hash"})
        canonical = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(canonical).hexdigest()

    def _write_event(self, event: LedgerEvent) -> None:
        line = event.model_dump_json() + "\n"
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(line)
            handle.flush()
            os.fsync(handle.fileno())

    @contextmanager
    def _locked(self):
        with self._thread_lock:
            self.lock_path.parent.mkdir(parents=True, exist_ok=True)
            with self.lock_path.open("a+") as handle:
                try:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                except (ImportError, OSError):
                    fcntl = None
                try:
                    yield
                finally:
                    if fcntl is not None:
                        try:
                            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                        except OSError:
                            pass
