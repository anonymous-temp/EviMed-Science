"""Apply reviewed benchmark source candidates into the auditable extraction layer."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field

from new_meta.core.benchmark_review import build_benchmark_review_payload
from new_meta.core.benchmark_source_decisions import load_benchmark_source_decisions
from new_meta.core.project import Project
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics
from new_meta.tools.utils import safe_identifier


COUNT_FIELDS = (
    "events_intervention",
    "total_intervention",
    "events_control",
    "total_control",
)


class BenchmarkSourceApplicationConflictError(RuntimeError):
    """Raised when benchmark source application is written against a stale revision."""


class BenchmarkSourceApplication(BaseModel):
    """One accepted benchmark source candidate applied to extraction data."""

    candidate_id: str
    task_id: str = ""
    trial_id: str = ""
    action: str
    study_id: str
    outcome_index: int
    source_sha256: str = ""
    source_filename: str = ""
    matched_values: list[str] = Field(default_factory=list)
    applied_fields: list[str] = Field(default_factory=list)
    values_applied: dict[str, Any] = Field(default_factory=dict)
    previous_values: dict[str, Any] = Field(default_factory=dict)
    reason: str = ""
    updated_by: str = "unknown"
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    revision: int = 0


class BenchmarkSourceApplicationsFile(BaseModel):
    """Append-only ledger for benchmark source candidates applied to extractions."""

    schema_version: int = 1
    current_revision: int = 0
    applications: list[BenchmarkSourceApplication] = Field(default_factory=list)


def load_benchmark_source_applications(project: Project) -> BenchmarkSourceApplicationsFile:
    data = project.load_json("benchmark_source_applications.json", subdir="benchmark")
    if not data:
        return BenchmarkSourceApplicationsFile()
    return BenchmarkSourceApplicationsFile.model_validate(data)


def apply_accepted_benchmark_source_candidates(
    project: Project,
    *,
    candidate_ids: list[str] | None = None,
    updated_by: str = "unknown",
    expected_revision: int | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """Apply accepted primary-count source candidates to extraction data.

    This is an explicit reviewer action. Saving a benchmark source decision alone
    remains review-only; this function creates an audit ledger entry and marks
    any inserted/updated outcomes as manual adjudications.
    """
    applications = load_benchmark_source_applications(project)
    if expected_revision is not None and expected_revision != applications.current_revision:
        raise BenchmarkSourceApplicationConflictError(
            f"stale benchmark source application revision: expected {expected_revision}, "
            f"current {applications.current_revision}"
        )

    selected_ids = {str(item) for item in candidate_ids or [] if str(item).strip()}
    already_applied = {item.candidate_id for item in applications.applications}
    review = build_benchmark_review_payload(project) or {}
    context_by_candidate = _candidate_contexts(review)
    protocol = _load_protocol(project)
    raw_studies = project.load_json("all_extractions.json", subdir="extraction") or []
    studies = [ExtractedStudy.model_validate(item) for item in raw_studies if isinstance(item, dict)]
    decisions = load_benchmark_source_decisions(project)
    next_revision = applications.current_revision + 1

    new_applications: list[BenchmarkSourceApplication] = []
    skipped_already_applied = 0
    skipped_not_found = 0
    skipped_invalid = 0
    created_studies = 0
    updated_outcomes = 0

    for decision in decisions.decisions:
        if decision.decision != "accepted":
            continue
        if selected_ids and decision.candidate_id not in selected_ids:
            continue
        if decision.candidate_id in already_applied and not force:
            skipped_already_applied += 1
            continue

        context = _context_for_decision(decision.model_dump(), context_by_candidate)
        if not context:
            skipped_not_found += 1
            continue
        task = context["task"]
        source = context["source"]
        candidate = context["candidate"]
        if candidate.get("candidate_type") != "primary_counts":
            skipped_invalid += 1
            continue

        values = _candidate_values(decision.model_dump(), candidate, source)
        if not _has_all_counts(values):
            skipped_invalid += 1
            continue

        target = _find_existing_target(studies, task, protocol)
        if target is None:
            study = _new_manual_study(task, values, protocol, next_revision)
            studies.append(study)
            study_index = len(studies) - 1
            outcome_index = 0
            action = "created_manual_study"
            previous_values: dict[str, Any] = {}
            created_studies += 1
        else:
            study_index, outcome_index = target
            previous_values = _apply_values_to_existing_outcome(
                studies[study_index],
                outcome_index,
                values,
                protocol,
                next_revision,
            )
            action = "updated_existing_outcome"
            updated_outcomes += 1

        study_id = _study_id(studies[study_index])
        new_applications.append(
            BenchmarkSourceApplication(
                candidate_id=decision.candidate_id,
                task_id=decision.task_id,
                trial_id=decision.trial_id or str(task.get("trial_id") or ""),
                action=action,
                study_id=study_id,
                outcome_index=outcome_index,
                source_sha256=decision.source_sha256 or str(source.get("sha256") or ""),
                source_filename=decision.source_filename or str(source.get("filename") or ""),
                matched_values=list(decision.matched_values),
                applied_fields=list(values.keys()),
                values_applied=values,
                previous_values=previous_values,
                reason=decision.reason,
                updated_by=updated_by or decision.updated_by or "unknown",
                revision=next_revision,
            )
        )

    if new_applications:
        applications.current_revision = next_revision
        applications.applications.extend(new_applications)
        project.save_json("benchmark_source_applications.json", applications, subdir="benchmark")
        _save_extractions(project, studies)

    return {
        "ok": True,
        "project_dir": str(project.base_dir),
        "current_revision": applications.current_revision,
        "applied": len(new_applications),
        "created_studies": created_studies,
        "updated_outcomes": updated_outcomes,
        "skipped_already_applied": skipped_already_applied,
        "skipped_not_found": skipped_not_found,
        "skipped_invalid": skipped_invalid,
        "applications": [item.model_dump() for item in new_applications],
    }


def _candidate_contexts(review: dict[str, Any]) -> dict[str, dict[str, Any]]:
    contexts: dict[str, dict[str, Any]] = {}
    for task in review.get("source_acquisition_tasks") or []:
        if not isinstance(task, dict):
            continue
        for source in task.get("uploaded_sources") or []:
            if not isinstance(source, dict):
                continue
            for candidate in source.get("quote_candidates") or []:
                if not isinstance(candidate, dict):
                    continue
                candidate_id = str(candidate.get("candidate_id") or "")
                if candidate_id:
                    contexts[candidate_id] = {
                        "task": task,
                        "source": source,
                        "candidate": candidate,
                    }
    return contexts


def _context_for_decision(
    decision: dict[str, Any],
    context_by_candidate: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    candidate_id = str(decision.get("candidate_id") or "")
    if candidate_id in context_by_candidate:
        return context_by_candidate[candidate_id]
    decision_values = [str(item) for item in decision.get("matched_values") or []]
    for context in context_by_candidate.values():
        candidate = context.get("candidate") or {}
        source = context.get("source") or {}
        task = context.get("task") or {}
        if str(task.get("task_id") or "") != str(decision.get("task_id") or ""):
            continue
        if str(source.get("sha256") or "") != str(decision.get("source_sha256") or ""):
            continue
        if str(candidate.get("candidate_type") or "") != str(decision.get("candidate_type") or ""):
            continue
        if [str(item) for item in candidate.get("matched_values") or []] != decision_values:
            continue
        return context
    return None


def _candidate_values(
    decision: dict[str, Any],
    candidate: dict[str, Any],
    source: dict[str, Any],
) -> dict[str, Any]:
    suggested = candidate.get("suggested_override") or decision.get("suggested_override") or {}
    values = dict(suggested.get("values") or {})
    quote = candidate.get("quote") or decision.get("quote") or values.get("source_quote") or ""
    filename = source.get("filename") or decision.get("source_filename") or ""
    if quote:
        values["source_quote"] = quote
    values["source_location"] = (
        f"uploaded benchmark source: {filename}" if filename else "uploaded benchmark source"
    )
    values["source_section"] = "Benchmark source review"
    values["source_quote_verified"] = True
    values["extraction_confidence"] = "high"
    values["manual_adjudication"] = True
    values["user_override_applied"] = True
    return values


def _has_all_counts(values: dict[str, Any]) -> bool:
    for field in COUNT_FIELDS:
        try:
            if values.get(field) is None:
                return False
            int(values[field])
        except (TypeError, ValueError):
            return False
    return True


def _load_protocol(project: Project) -> ResearchProtocol | None:
    data = project.load_json("protocol.json")
    if not data:
        return None
    return ResearchProtocol.model_validate(data)


def _find_existing_target(
    studies: list[ExtractedStudy],
    task: dict[str, Any],
    protocol: ResearchProtocol | None,
) -> tuple[int, int] | None:
    explicit = _target_from_row_id(studies, str(task.get("row_id") or ""))
    if explicit is not None:
        return explicit

    pmids = {str(item).strip() for item in task.get("publication_pmids") or [] if str(item).strip()}
    dois = {_normalise_doi(item) for item in task.get("publication_dois") or [] if _normalise_doi(item)}
    aliases = _task_aliases(task)

    for study_index, study in enumerate(studies):
        c = study.characteristics
        if c.pmid and c.pmid in pmids:
            return study_index, _best_outcome_index(study, protocol)
        if c.doi and _normalise_doi(c.doi) in dois:
            return study_index, _best_outcome_index(study, protocol)

    for study_index, study in enumerate(studies):
        title = _norm(study.characteristics.title)
        if title and any(alias and alias in title for alias in aliases):
            return study_index, _best_outcome_index(study, protocol)
    return None


def _target_from_row_id(studies: list[ExtractedStudy], row_id: str) -> tuple[int, int] | None:
    if ":" not in row_id:
        return None
    study_part, index_part = row_id.rsplit(":", 1)
    try:
        outcome_index = int(index_part)
    except ValueError:
        return None
    for study_index, study in enumerate(studies):
        c = study.characteristics
        identifiers = {item for item in (c.pmid, c.study_id, c.doi) if item}
        if study_part in identifiers and 0 <= outcome_index < len(study.outcomes):
            return study_index, outcome_index
    return None


def _task_aliases(task: dict[str, Any]) -> list[str]:
    items = [
        task.get("trial_id"),
        task.get("trial_name"),
        task.get("registration_id"),
        *(task.get("aliases") or []),
    ]
    aliases = []
    seen = set()
    for item in items:
        alias = _norm(item)
        if alias and alias not in seen:
            aliases.append(alias)
            seen.add(alias)
    return aliases


def _best_outcome_index(study: ExtractedStudy, protocol: ResearchProtocol | None) -> int:
    if not study.outcomes:
        study.outcomes.append(OutcomeData(outcome_name=_primary_outcome_name(protocol), outcome_type="dichotomous"))
        return 0
    target = _norm(_primary_outcome_name(protocol))
    best_index = 0
    best_score = (-1, -1, -1, 0)
    for idx, outcome in enumerate(study.outcomes):
        name = _norm(outcome.outcome_name)
        has_count_shape = int(any(getattr(outcome, field, None) is not None for field in COUNT_FIELDS))
        score = (
            int(bool(target) and name == target),
            int(bool(target) and (target in name or name in target)),
            int("mortality" in name),
            has_count_shape,
            -idx,
        )
        if score > best_score:
            best_score = score
            best_index = idx
    return best_index


def _new_manual_study(
    task: dict[str, Any],
    values: dict[str, Any],
    protocol: ResearchProtocol | None,
    revision: int,
) -> ExtractedStudy:
    trial_id = str(task.get("trial_id") or "unknown_trial")
    trial_name = str(task.get("trial_name") or trial_id)
    registration = str(task.get("registration_id") or "")
    title = trial_name if not registration else f"{trial_name} ({registration})"
    pmids = [str(item) for item in task.get("publication_pmids") or [] if str(item).strip()]
    dois = [str(item) for item in task.get("publication_dois") or [] if str(item).strip()]
    outcome_values = dict(values)
    outcome_values.setdefault("outcome_name", _primary_outcome_name(protocol))
    outcome_values.setdefault("outcome_type", "dichotomous")
    outcome_values.setdefault("timepoint", _primary_outcome_name(protocol))
    outcome_values.setdefault("accepted_timepoint", _primary_outcome_name(protocol))
    outcome_values["override_revision"] = revision
    return ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id=f"benchmark_source:{trial_id}",
            title=title,
            authors=[trial_name],
            year=0,
            doi=dois[0] if dois else "",
            pmid=pmids[0] if pmids else "",
            study_design="Randomized Controlled Trial",
            population_description=_protocol_population(protocol),
            intervention_description=_protocol_intervention(protocol),
            control_description=_protocol_comparator(protocol),
            source_type="benchmark_source_review",
            metadata_source="benchmark_source_decision",
        ),
        outcomes=[OutcomeData.model_validate(outcome_values)],
        quality_notes="Created from an accepted benchmark source candidate; requires manuscript disclosure as manual adjudication.",
    )


def _apply_values_to_existing_outcome(
    study: ExtractedStudy,
    outcome_index: int,
    values: dict[str, Any],
    protocol: ResearchProtocol | None,
    revision: int,
) -> dict[str, Any]:
    if outcome_index >= len(study.outcomes):
        study.outcomes.append(OutcomeData(outcome_name=_primary_outcome_name(protocol), outcome_type="dichotomous"))
        outcome_index = len(study.outcomes) - 1
    outcome = study.outcomes[outcome_index]
    data = outcome.model_dump()
    previous_values = {field: data.get(field) for field in values}
    data.update(values)
    data["outcome_type"] = data.get("outcome_type") or "dichotomous"
    data["outcome_name"] = data.get("outcome_name") or _primary_outcome_name(protocol)
    data["timepoint"] = data.get("timepoint") or _primary_outcome_name(protocol)
    data["accepted_timepoint"] = data.get("accepted_timepoint") or _primary_outcome_name(protocol)
    data["override_revision"] = revision
    study.outcomes[outcome_index] = OutcomeData.model_validate(data)
    return previous_values


def _save_extractions(project: Project, studies: list[ExtractedStudy]) -> None:
    project.save_json("all_extractions.json", studies, subdir="extraction")
    for study in studies:
        sid = _study_id(study)
        if sid:
            project.save_json(f"{safe_identifier(sid)}.json", study, subdir="extraction")


def _study_id(study: ExtractedStudy) -> str:
    c = study.characteristics
    return c.pmid or c.study_id or c.doi


def _primary_outcome_name(protocol: ResearchProtocol | None) -> str:
    if protocol and protocol.pico and protocol.pico.outcome_primary:
        return protocol.pico.outcome_primary
    return "Primary outcome"


def _protocol_population(protocol: ResearchProtocol | None) -> str:
    return protocol.pico.population if protocol and protocol.pico else ""


def _protocol_intervention(protocol: ResearchProtocol | None) -> str:
    return protocol.pico.intervention if protocol and protocol.pico else ""


def _protocol_comparator(protocol: ResearchProtocol | None) -> str:
    return protocol.pico.comparator if protocol and protocol.pico else ""


def _normalise_doi(value: Any) -> str:
    text = str(value or "").strip().lower()
    if text.startswith("https://doi.org/"):
        text = text[len("https://doi.org/"):]
    if text.startswith("doi:"):
        text = text[4:]
    return text


def _norm(value: Any) -> str:
    return " ".join(str(value or "").strip().lower().split())
