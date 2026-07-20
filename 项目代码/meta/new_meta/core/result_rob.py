"""Result-level risk-of-bias targeting and human-review preparation."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import re
import threading

from new_meta.core.extraction_ledger import result_entity_id
from new_meta.schemas.risk_of_bias import (
    ResultRoBAssessment,
    RoBAssessmentStatus,
    RoBTargetEffect,
    StudyRoB,
)
from new_meta.schemas.study import ExtractedStudy


class RoBAdjudicationConflictError(RuntimeError):
    pass


_ADJUDICATION_LOCK = threading.RLock()


def build_result_rob_drafts(
    extracted_studies: list[ExtractedStudy],
    study_assessments: list[StudyRoB],
    *,
    method_plan=None,
) -> list[ResultRoBAssessment]:
    """Project legacy study judgments into explicit, non-releasable review tasks.

    A projection is never mislabeled as a completed result-specific assessment:
    selection/measurement/missing-data judgments can differ by outcome, timepoint,
    estimand and analysis population, so every projected row requires adjudication.
    """
    by_study: dict[str, list[StudyRoB]] = {}
    for assessment in study_assessments or []:
        token = _token(getattr(assessment, "study_id", ""))
        if token:
            by_study.setdefault(token, []).append(assessment)

    drafts: list[ResultRoBAssessment] = []
    for study in extracted_studies or []:
        study_id = _study_id(study)
        candidates = by_study.get(_token(study_id), [])
        policy = None
        if method_plan is not None:
            from new_meta.core.rob_policy import resolve_rob_policy

            family = getattr(method_plan, "family", None) or method_plan.get("family")
            policy = resolve_rob_policy(
                family=family,
                study_design=study.characteristics.study_design,
            )
        matching_candidates = [
            item for item in candidates
            if policy is None or _token(item.tool_used) == _token(policy.tool_name)
        ]
        assessment = matching_candidates[0] if matching_candidates else StudyRoB(
            study_id=study_id,
            tool_used=(policy.tool_name if policy else _tool_for_design(study.characteristics.study_design)),
            overall_judgment="Not assessed (result-specific assessment required)",
            is_synthetic=True,
        )
        for outcome_index, outcome in enumerate(study.outcomes):
            result_id = result_entity_id(study, outcome_index)
            drafts.append(
                ResultRoBAssessment(
                    assessment_id=f"rob:{result_id}:draft",
                    result_id=result_id,
                    study_id=study_id,
                    outcome_name=outcome.outcome_name or f"Outcome {outcome_index + 1}",
                    timepoint=str(outcome.accepted_timepoint or outcome.timepoint or ""),
                    subgroup=str(outcome.subgroup or ""),
                    analysis_population=(
                        "adjudicated_population"
                        if outcome.manual_adjudication or outcome.user_override_applied
                        else ""
                    ),
                    tool_used=(policy.tool_name if policy else assessment.tool_used or _tool_for_design(study.characteristics.study_design)),
                    tool_version=(policy.tool_version if policy else _tool_version(assessment.tool_used)),
                    target_effect=(policy.target_effect if policy else _target_effect(assessment.tool_used)),
                    assessment_status=RoBAssessmentStatus.DRAFT,
                    domains=list(assessment.domains),
                    overall_judgment=assessment.overall_judgment,
                    is_synthetic=assessment.is_synthetic,
                    assessment_origin=("method_policy_projection" if policy else "study_level_projection"),
                    requires_adjudication=True,
                )
            )
    return drafts


def result_rob_readiness(
    assessments: list[ResultRoBAssessment],
    *,
    required_result_ids: list[str] | None = None,
) -> dict:
    if required_result_ids is not None:
        required = set(str(item) for item in required_result_ids)
        assessments = [item for item in assessments if item.result_id in required]
    complete_statuses = {RoBAssessmentStatus.COMPLETE, RoBAssessmentStatus.ADJUDICATED}
    complete = [item for item in assessments if item.assessment_status in complete_statuses]
    pending = [item for item in assessments if item.assessment_status not in complete_statuses]
    return {
        "schema_version": 1,
        "status": "ready" if assessments and not pending else "blocked",
        "total_result_assessments": len(assessments),
        "complete_result_assessments": len(complete),
        "pending_result_assessments": len(pending),
        "pending_result_ids": [item.result_id for item in pending],
        "blocker_codes": ([] if assessments and not pending else ["result_specific_rob_incomplete"]),
    }


def load_effective_rob_assessments(project, legacy_assessments: list[StudyRoB]) -> list[StudyRoB]:
    """Overlay completed result-level judgments while retaining legacy fallback."""
    raw = project.load_json("rob_result_assessments.json", subdir="risk_of_bias") or []
    completed: list[ResultRoBAssessment] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            assessment = ResultRoBAssessment.model_validate(item)
        except Exception:
            continue
        if assessment.assessment_status in {
            RoBAssessmentStatus.COMPLETE,
            RoBAssessmentStatus.ADJUDICATED,
        } and not assessment.requires_adjudication:
            completed.append(assessment)
    if not completed:
        return legacy_assessments
    return [*completed, *legacy_assessments]


def save_result_rob_adjudication(
    project,
    assessment: ResultRoBAssessment,
    *,
    expected_revision: int,
    reason: str,
) -> dict:
    """Persist one human result-level judgment with optimistic concurrency."""
    if assessment.assessment_status is not RoBAssessmentStatus.ADJUDICATED:
        raise ValueError("saved RoB adjudication must have assessment_status=adjudicated")
    if not assessment.adjudicated_by.strip():
        raise ValueError("saved RoB adjudication requires adjudicated_by")
    if not str(reason or "").strip():
        raise ValueError("RoB adjudication reason is required")

    lock_path = project.get_path("rob_adjudications.json.lock", subdir="risk_of_bias")
    with _locked(lock_path):
        manifest = project.load_json("rob_adjudications.json", subdir="risk_of_bias") or {
            "schema_version": 1,
            "current_revision": 0,
            "history": [],
        }
        current_revision = int(manifest.get("current_revision") or 0)
        if current_revision != int(expected_revision):
            raise RoBAdjudicationConflictError(
                f"stale RoB adjudication revision: expected {expected_revision}, current {current_revision}"
            )

        next_revision = current_revision + 1
        history = manifest.setdefault("history", [])
        history.append({
            "revision": next_revision,
            "result_id": assessment.result_id,
            "assessment_id": assessment.assessment_id,
            "adjudicated_by": assessment.adjudicated_by,
            "reason": str(reason).strip(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "assessment": assessment.model_dump(mode="json"),
        })
        manifest["current_revision"] = next_revision

        raw_assessments = project.load_json(
            "rob_result_assessments.json",
            subdir="risk_of_bias",
        ) or []
        assessments = [
            ResultRoBAssessment.model_validate(item)
            for item in raw_assessments
            if isinstance(item, dict)
        ]
        replaced = False
        for index, current in enumerate(assessments):
            if current.result_id == assessment.result_id:
                assessments[index] = assessment
                replaced = True
                break
        if not replaced:
            assessments.append(assessment)

        project.save_json("rob_adjudications.json", manifest, subdir="risk_of_bias")
        project.save_json("rob_result_assessments.json", assessments, subdir="risk_of_bias")
        project.save_json(
            "rob_result_readiness.json",
            result_rob_readiness(assessments),
            subdir="risk_of_bias",
        )
        return manifest


@contextmanager
def _locked(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with _ADJUDICATION_LOCK:
        with path.open("a+") as handle:
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


def _study_id(study: ExtractedStudy) -> str:
    characteristics = study.characteristics
    return str(
        characteristics.pmid
        or characteristics.study_id
        or characteristics.doi
        or characteristics.title
        or "unknown"
    )


def _token(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _tool_for_design(design: str) -> str:
    lowered = str(design or "").lower()
    if any(marker in lowered for marker in ("random", "rct", "随机")):
        return "RoB 2"
    return "ROBINS-I"


def _tool_version(tool: str) -> str:
    lowered = str(tool or "").lower()
    if "rob 2" in lowered:
        return "RoB 2 v2 (2019)"
    if "robins" in lowered:
        return "ROBINS-I (2016)"
    if "quadas" in lowered:
        return "QUADAS-2 (2011)"
    if "probast" in lowered:
        return "PROBAST (2019)"
    if "quips" in lowered:
        return "QUIPS"
    return str(tool or "design-specific tool")


def _target_effect(tool: str) -> RoBTargetEffect:
    lowered = str(tool or "").lower()
    if "quadas" in lowered:
        return RoBTargetEffect.DIAGNOSTIC_ACCURACY
    if "probast" in lowered:
        return RoBTargetEffect.PREDICTION_MODEL
    if "quips" in lowered:
        return RoBTargetEffect.PROGNOSTIC_ASSOCIATION
    if "robins" in lowered or "newcastle" in lowered:
        return RoBTargetEffect.EXPOSURE
    return RoBTargetEffect.ASSIGNMENT
