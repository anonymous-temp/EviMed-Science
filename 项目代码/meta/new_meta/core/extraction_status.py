"""Fail-closed extraction lifecycle shared by execution and resume routes."""
from __future__ import annotations

from new_meta.schemas.phase_result import ArtifactRef, NextAction, PhaseIssue, PhaseResult
from new_meta.tools.utils import paper_identity


class IncompletePhaseError(RuntimeError):
    """A persisted incomplete phase must stop downstream publication work."""

    def __init__(self, phase: PhaseResult, project):
        self.phase = phase
        self.project = project
        super().__init__(phase.summary)


class ExtractionIncomplete(IncompletePhaseError):
    """At least one required source did not produce a usable extraction."""


def persist_incomplete_phase(project, phase, *, step, status_path):
    """Invalidate completion without presenting unexecuted quality gates as failures."""
    from new_meta.core.release_contract import persist_release_decision

    project.clear_downstream(step, include_self=True)
    project.save_json(status_path, phase)
    project.save_step_manifest(
        step, status="incomplete", artifacts=[status_path],
        metadata={"phase_status": phase.status.value, "error_code": phase.error_code,
                  "retryable": phase.retryable},
    )
    persist_release_decision(project, {
        "schema_version": 1, "status": "blocked", "ready_for_submission": False,
        "requires_review": True, "summary": phase.summary,
        "blocker_codes": [issue.code for issue in phase.issues if issue.blocking],
        "next_actions": [action.title for action in phase.next_actions],
        "artifacts": [], "phase": phase.phase.value, "phaseStatus": phase.status.value,
        "retryable": phase.retryable,
    })
    return phase


def extraction_failure(study_id, code, *, retryable=False, **context):
    return {"study_id": study_id, "code": code, "retryable": retryable, **context}


#: Failures that are a property of the retrieved document, not of the run: its
#: text is too long to extract whole (on 2026-09-28 the "full text" retrieved
#: for a TKA trial was a 77-page doctoral thesis), or there is no usable full
#: text at all. Retrying cannot change them; only another document can.
UNUSABLE_SOURCE_CODES = frozenset({"extraction_source_context_unavailable", "extraction_source_unavailable"})
UNUSABLE_SOURCE_CRITERION = "Full text unusable for extraction"


def exclude_unusable_sources(project, failures):
    """Record unusable-source failures as full-text exclusions; return their study ids.

    For an unattended run only (``--skip-confirm``), the same place its other
    documented fallbacks live. Interactively the phase still pauses so a person
    can supply the article. A review cannot report data it could not read, so
    these studies leave the included set the way a study whose full text was
    never retrieved does: named, with the reason, in the full-text screening
    record, the PRISMA exclusion reasons and the pipeline warnings. A failure
    of the run itself (a model call, a schema) is never excluded this way.
    """
    unusable = {
        row["study_id"]: row for row in failures
        if row.get("code") in UNUSABLE_SOURCE_CODES and not row.get("retryable")
    }
    if not unusable:
        return set()

    def detail(failure):
        if failure.get("code") == "extraction_source_context_unavailable" and failure.get("source_chars"):
            return (f"retrieved text is {failure['source_chars']} characters, over the "
                    f"{failure['source_char_limit']}-character extraction limit (likely not the article itself)")
        return "no usable full text"

    _record_unattended_exclusions(
        project, {study_id: (detail(failure), failure) for study_id, failure in unusable.items()},
        criterion=UNUSABLE_SOURCE_CRITERION, remedy="Supply the article to include it.",
    )
    project.add_warning(
        # A named full-text exclusion, not a failed extraction: the EviMed
        # adapter reads an "extraction" warning as a failed module.
        "screening",
        f"{len(unusable)} included stud{'y was' if len(unusable) == 1 else 'ies were'} excluded because the "
        "retrieved full text could not be extracted; the review reports them as full-text exclusions.",
        code="unusable_full_text_excluded",
        context={"studies": list(unusable.values())},
    )
    return set(unusable)


UNRESOLVED_DESIGN_CRITERION = "Randomized design could not be resolved from the full text"


def exclude_unresolved_design_studies(project, studies):
    """Leave out a study whose randomized design the extraction could not name.

    Unattended runs only (``--skip-confirm``). The design rules keep an
    unresolved design as "unknown" rather than guess one, and method admission
    then refuses the whole review: on 2026-09-28 one six-arm TXA trial did
    that to a brief with seven other resolved trials. Pooling a study whose
    dependencies are unknown would overstate its precision, so it is not
    pooled; it is named, with the reason, in the full-text screening record,
    PRISMA and the pipeline warnings, and the remaining studies go on. Returns
    the excluded study ids and removes them from ``all_extractions.json``.
    """
    from new_meta.core.method_planning import unresolved_design_study_ids

    unresolved = unresolved_design_study_ids(studies)
    if not unresolved or len(unresolved) == len(studies):
        # All of them unresolved is the review's own finding, not one study's.
        return set()
    _record_unattended_exclusions(
        project, {study_id: ("comparative design recorded as unknown", {"study_id": study_id})
                  for study_id in unresolved},
        criterion=UNRESOLVED_DESIGN_CRITERION,
        remedy="Adjudicate its design to include it.",
    )
    remaining = [study for study in studies if _extracted_study_id(study) not in unresolved]
    project.save_json("all_extractions.json", remaining, subdir="extraction")
    status = project.load_json("extraction_status.json", subdir="extraction") or {}
    data = status.get("data") if isinstance(status.get("data"), dict) else None
    if data is not None and isinstance(data.get("required_study_ids"), list):
        data["required_study_ids"] = [item for item in data["required_study_ids"] if item not in unresolved]
        data["excluded_unresolved_design"] = sorted(unresolved)
        project.save_json("extraction_status.json", status, subdir="extraction")
    project.add_warning(
        # A named full-text exclusion, not a failed extraction: the EviMed
        # adapter reads an "extraction" warning as a failed module.
        "screening",
        f"{len(unresolved)} included stud{'y was' if len(unresolved) == 1 else 'ies were'} left out of the "
        "synthesis because the randomized design could not be resolved from the full text.",
        code="unresolved_design_excluded",
        context={"studies": sorted(unresolved)},
    )
    return set(unresolved)


def _extracted_study_id(study):
    characteristics = study.characteristics
    return str(characteristics.pmid or characteristics.study_id or "")


def _record_unattended_exclusions(project, excluded, *, criterion, remedy):
    """Move included studies to the full-text exclusions, with the reason."""
    records = project.load_json("full_text_screening.json", subdir="screening") or []
    moved = 0
    for record in records:
        paper = record.get("paper")
        if not isinstance(paper, dict) or record.get("decision") != "include":
            continue
        entry = excluded.get(paper_identity(paper))
        if entry is None:
            continue
        detail, context = entry
        record.update({
            "decision": "exclude",
            "exclusion_criterion": criterion,
            "reason": f"{criterion}: {detail}. {remedy}",
            "unattended_exclusion": {"phase": "extraction", **context},
        })
        moved += 1
    if moved:
        project.save_json("full_text_screening.json", records, subdir="screening")
        prisma = project.prisma
        prisma.full_text_excluded += moved
        prisma.studies_included = max(0, prisma.studies_included - moved)
        prisma.full_text_exclusion_reasons[criterion] = prisma.full_text_exclusion_reasons.get(criterion, 0) + moved
        project.save_json("prisma_flow.json", prisma.to_dict())
    return moved


def extraction_incomplete(project, failures, *, completed_ids=(), required_ids=()):
    """Preserve machine-readable source-level failures and block delivery."""
    system_failed = any(row["code"] in {"structured_extraction_failed", "study_extraction_failed", "extraction_failed"}
                        for row in failures)
    phase = PhaseResult(
        run_id=project.base_dir.name, phase="extraction", status="failed" if system_failed else "needs_input",
        summary="Extraction is incomplete for one or more required studies; downstream analysis and report generation are paused.",
        error_code="extraction_incomplete", retryable=any(row.get("retryable") for row in failures),
        metrics={"required_studies": len(required_ids), "completed_studies": len(completed_ids),
                 "incomplete_studies": len(failures)},
        issues=[PhaseIssue(
            code=row["code"], message="Required study extraction did not complete.", blocking=True,
            retryable=bool(row.get("retryable")), entity_ids=[row["study_id"]], context=row,
        ) for row in failures],
        next_actions=[NextAction(action_id="resume_extraction", title="Resolve the extraction diagnostics and resume extraction")],
        artifacts=[ArtifactRef(artifact_id="extraction_status", kind="diagnostic",
                               path="extraction/extraction_status.json", media_type="application/json"),
                   ArtifactRef(artifact_id="partial_extractions", kind="dataset",
                               path="extraction/all_extractions.json", media_type="application/json")],
        data={"failures": failures, "completed_study_ids": list(completed_ids),
              "required_study_ids": list(required_ids)},
    )
    persist_incomplete_phase(project, phase, step="extraction", status_path="extraction/extraction_status.json")
    return ExtractionIncomplete(phase, project)


def require_complete_screening(project):
    """A new unresolved screening decision also blocks reuse of older effects."""
    status = project.load_json("full_text_screening_status.json", subdir="screening")
    records = project.load_json("full_text_screening.json", subdir="screening") or []
    if any(row.get("decision") == "review_required" for row in records):
        from new_meta.agents.screening_agent import ScreeningReviewRequired
        error = ScreeningReviewRequired(records, project)
    elif status and status.get("status") != "succeeded":
        error = IncompletePhaseError(PhaseResult.model_validate(status), project)
    else:
        return
    persist_incomplete_phase(project, error.phase, step="ft_screening",
                             status_path="screening/full_text_screening_status.json")
    raise error


def require_complete_extraction(project, studies=None, included_papers=None):
    """Recheck cached extractions, including legacy empty records and partial lists.

    Ledger-only/direct-IPD projects without an extraction phase are unaffected.
    A persisted incomplete phase can only be cleared by a successful extraction
    run, not by supplying a smaller in-memory study list to a downstream route.
    """
    require_complete_screening(project)
    status = project.load_json("extraction_status.json", subdir="extraction")
    if status and status.get("status") != "succeeded":
        phase = PhaseResult.model_validate(status)
        persist_incomplete_phase(project, phase, step="extraction", status_path="extraction/extraction_status.json")
        raise ExtractionIncomplete(phase, project)
    cached = project.load_json("all_extractions.json", subdir="extraction")
    if studies is not None and cached is not None:
        # Supplying a successful subset cannot hide a legacy failed/empty record.
        studies = list(studies) + list(cached)
    if studies is None:
        studies = cached
    if studies is None:
        if status and status.get("data", {}).get("required_study_ids"):
            studies = []
        else:
            return
    if included_papers is None and cached is not None:
        screening = project.load_json("full_text_screening.json", subdir="screening") or []
        included_papers = [row["paper"] for row in screening
                           if row.get("decision") == "include" and isinstance(row.get("paper"), dict)]
    required_ids = {
        paper_identity(paper["paper"] if isinstance(paper.get("paper"), dict) else paper)
        for paper in (included_papers or [])
        if paper.get("decision") not in {"exclude", "review_required"}
    }
    if status:
        required_ids.update(status.get("data", {}).get("required_study_ids", []))
    failures = []
    observed = set()
    completed = []
    for study in studies:
        row = study.model_dump(mode="json") if hasattr(study, "model_dump") else study
        characteristics = row.get("characteristics") or {}
        ids = {str(characteristics.get(key) or "") for key in ("study_id", "pmid")} - {""}
        study_id = str(characteristics.get("study_id") or characteristics.get("pmid") or "unknown")
        observed.update(ids)
        if "EXTRACTION_FAILED" in str(row.get("quality_notes") or ""):
            failures.append(extraction_failure(study_id, "extraction_failed", retryable=True))
        elif not row.get("outcomes"):
            failures.append(extraction_failure(study_id, "extraction_outcomes_empty"))
        else:
            completed.append(study_id)
    for study_id in sorted(required_ids - observed):
        failures.append(extraction_failure(study_id, "required_study_extraction_missing"))
    if cached == [] and not studies and not failures:
        failures.append(extraction_failure("unknown", "extraction_outcomes_empty"))
    if failures:
        unique_failures = {row["study_id"]: row for row in failures}
        raise extraction_incomplete(project, list(unique_failures.values()),
                                    completed_ids=sorted(set(completed)), required_ids=sorted(required_ids))
