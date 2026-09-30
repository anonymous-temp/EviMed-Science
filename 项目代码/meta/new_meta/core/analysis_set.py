"""Discover and adjudicate clinically coherent result strata before synthesis."""
from __future__ import annotations

from datetime import datetime, timezone
from contextlib import contextmanager
from difflib import SequenceMatcher
import hashlib
import json
import re
import threading

from new_meta.core.evidence_ledger import EvidenceLedger
from new_meta.schemas.analysis_set import (
    AnalysisSetCandidate,
    AnalysisSetCandidates,
    AnalysisSetDecision,
)
from new_meta.schemas.evidence_ledger import (
    ComparativeEffectData,
    DiagnosticAccuracyData,
    DoseResponseData,
    EntityKind,
    EvidenceState,
    EffectEstimate,
    IncidenceRateData,
    IPDStudyData,
    OutcomeEntity,
    PredictionPerformanceData,
    ResultEntity,
    SingleArmProportionData,
)
from new_meta.schemas.method_policy import MethodPlan, ReviewFamily


class AnalysisSetAdjudicationRequired(RuntimeError):
    def __init__(self, message: str, *, candidates: AnalysisSetCandidates):
        self.candidates = candidates
        super().__init__(message)


class AnalysisSetConflictError(RuntimeError):
    pass


_LOCK = threading.RLock()


def discover_analysis_set_candidates(project, plan: MethodPlan) -> AnalysisSetCandidates:
    identity = project.load_json("review_identity.json", subdir="evidence") or {}
    review_id = str(identity.get("review_id") or "")
    if not review_id or review_id != plan.review_id:
        raise AnalysisSetAdjudicationRequired(
            "method plan review_id does not match the evidence ledger",
            candidates=AnalysisSetCandidates(
                plan_fingerprint=plan.plan_fingerprint,
                ledger_head_hash="0" * 64,
                candidates=[],
            ),
        )
    ledger = EvidenceLedger(
        project.get_path("ledger.jsonl", subdir="evidence"),
        review_id=review_id,
    )
    verification = ledger.assert_valid()
    outcomes = {
        item["entity_id"]: OutcomeEntity.model_validate(item)
        for item in ledger.current_entities(kind=EntityKind.OUTCOME)
    }
    groups: dict[tuple[str, str, str, str], list[ResultEntity]] = {}
    entities = [ResultEntity.model_validate(payload) for payload in ledger.current_entities(kind=EntityKind.RESULT)]
    from new_meta.core.autonomous_analysis import admitted_result_ids
    model_selected = admitted_result_ids(project)
    entities = [entity for entity in entities
                if (entity.evidence_state in {EvidenceState.VERIFIED, EvidenceState.ADJUDICATED}
                    or entity.entity_id in model_selected)
                and _entity_matches_plan(entity, plan)]
    left_out = _unattended_left_out(project, plan, [entity.entity_id for entity in entities])
    # Unattended, every result still here has a verified match to the protocol's
    # primary outcome, and that verdict covers its time horizon (the checker
    # assesses outcome, thresholds, units, time horizon and estimand). Their
    # reported windows ("24 hours after surgery", "to postoperative day 3") are
    # then one stratum under the protocol's outcome, named with every window;
    # on 2026-09-28 three verified ma-001 trials were three one-study strata
    # and nothing could be pooled. Interactively a person still chooses.
    merge_windows = _unattended(project) and plan.family is not ReviewFamily.IPD_META
    # Unattended, the results of the review's own estimand (protocol primary
    # outcome, protocol measure, intervention versus comparator) are also one
    # stratum across their "subgroup" labels. On production run
    # meta-20260928172536 the extractor put the arms of three multi-arm TXA
    # trials there ("route of administration: intravenous", "txa dose level:
    # 250 mg"), each label became a one-study stratum, and four trials that
    # report the primary outcome gave "1 contrast from 1 study". Which rows are
    # one trial's distinct contrasts is decided by their own arm metadata, not
    # by reading the labels; the moderators are each result's closed subgroup
    # values (core/subgroup_vocabulary.py), never the labels.
    # Every other stratum is still keyed by its timepoint and subgroup text,
    # on purpose: a wording difference there can only split a stratum (offered
    # to a person interactively, ranked unattended), never pool unlike
    # results, and no closed field says whether a subgroup label restricts
    # the participants - the closed values describe the contrast, not that.
    review_estimand = _review_estimand(project) if merge_windows and plan.family is ReviewFamily.INTERVENTION_RCT else ""
    windows: dict[tuple[str, str, str, str], set[str]] = {}
    joined_keys: set[tuple[str, str, str, str]] = set()
    for entity in entities:
        if entity.entity_id in left_out:
            continue
        timepoint = " ".join(entity.timepoint.split())
        joined = bool(review_estimand) and isinstance(entity.raw_data, ComparativeEffectData) \
            and entity.raw_data.estimand_id == review_estimand
        key = (
            entity.outcome_id,
            "" if merge_windows else timepoint.casefold(),
            "" if joined else " ".join(entity.subgroup.split()).casefold(),
            entity.effect_measure.upper(),
        )
        groups.setdefault(key, []).append(entity)
        windows.setdefault(key, set()).add(timepoint)
        if joined:
            joined_keys.add(key)

    candidates = []
    merged = {}
    joined_report: dict[str, dict] = {}
    primary_left_out: dict[str, str] = {}
    for key, entities in sorted(groups.items()):
        outcome_id, timepoint, subgroup, effect_measure = key
        if key in joined_keys:
            entities, not_joined = _one_contribution_per_trial(entities)
            primary_left_out.update(not_joined)
            if not entities:
                continue
            windows[key] = {" ".join(item.timepoint.split()) for item in entities}
            for item in entities:
                study = joined_report.setdefault(item.study_id, {"timepoints": [], "contrasts": []})
                study["timepoints"] = sorted({*study["timepoints"], " ".join(item.timepoint.split())})
                study["contrasts"].append({
                    "result_id": item.entity_id,
                    "treatment": item.raw_data.treatment,
                    "comparator": item.raw_data.comparator,
                    "label": " ".join(item.subgroup.split()),
                    "subgroup_values": dict((item.derivation or {}).get("subgroup_values") or {}),
                })
        if merge_windows:
            timepoint = "; ".join(sorted(window for window in windows[key] if window)).casefold()
            if len(windows[key]) > 1:
                merged[outcome_id] = sorted(windows[key])
        entities = sorted(entities, key=lambda item: (item.study_id, item.entity_id))
        study_ids = [item.study_id for item in entities]
        issues = []
        if len(study_ids) != len(set(study_ids)) and not _dependent_rows_resolved(entities, plan):
            issues.append("multiple result rows from one study require an explicit covariance model")
        outcome = outcomes.get(outcome_id)
        outcome_name = outcome.name if outcome else outcome_id
        outcome_type = outcome.outcome_type if outcome else plan.outcome_type
        result_ids = [item.entity_id for item in entities]
        candidate_id = _candidate_id({
            "plan_fingerprint": plan.plan_fingerprint,
            "outcome_id": outcome_id,
            "timepoint": timepoint,
            "subgroup": subgroup,
            "effect_measure": effect_measure,
            "result_ids": result_ids,
        })
        candidates.append(AnalysisSetCandidate(
            candidate_id=candidate_id,
            outcome_id=outcome_id,
            outcome_name=outcome_name,
            outcome_type=outcome_type,
            timepoint=timepoint,
            subgroup=subgroup,
            effect_measure=effect_measure,
            result_ids=result_ids,
            study_ids=study_ids,
            eligible=not issues,
            issues=issues,
        ))
    if merge_windows:
        project.clear_warnings(code="primary_timepoints_merged")
        project.clear_warnings(code="primary_results_left_out")
        if merged or joined_report:
            project.add_warning(
                "synthesis",
                "Results reported at different time windows were analysed as one outcome, because the independent "
                "source verification judged each to match the protocol's primary outcome, time horizon included. "
                "Each trial contributes once; a multi-arm trial's contrasts enter together with their shared-control "
                "covariance, and their closed protocol subgroup values are kept as moderators.",
                code="primary_timepoints_merged",
                context={"windows": merged, "studies": joined_report},
            )
        if primary_left_out:
            project.add_warning(
                "synthesis",
                f"{len(primary_left_out)} verified primary-outcome result(s) were not entered into the primary "
                "analysis, so that no trial is counted twice: a trial reporting the same comparison more than "
                "once (several windows or population subgroups), or contrasts whose covariance is not known.",
                code="primary_results_left_out",
                context={"results": primary_left_out},
            )
    artifact = AnalysisSetCandidates(
        plan_fingerprint=plan.plan_fingerprint,
        ledger_head_hash=verification.head_hash or "0" * 64,
        candidates=candidates,
    )
    project.save_json("analysis_set_candidates.json", artifact, subdir="analysis")
    return artifact


def resolve_project_analysis_set(
    project,
    plan: MethodPlan,
    *,
    auto_select_ambiguous: bool = False,
) -> AnalysisSetDecision:
    candidates = discover_analysis_set_candidates(project, plan)
    eligible = [item for item in candidates.candidates if item.eligible]
    existing_payload = project.load_json("analysis_set.json", subdir="analysis")
    if existing_payload:
        existing = AnalysisSetDecision.model_validate(existing_payload)
        match = next(
            (item for item in eligible if item.candidate_id == existing.candidate_id),
            None,
        )
        if (
            existing.plan_fingerprint == plan.plan_fingerprint
            and existing.ledger_head_hash == candidates.ledger_head_hash
            and match is not None
            and existing.result_ids == match.result_ids
        ):
            return existing
    if not eligible:
        raise AnalysisSetAdjudicationRequired(
            "no eligible source-verified result stratum is available for synthesis",
            candidates=candidates,
        )
    if len(eligible) != 1 and not auto_select_ambiguous:
        raise AnalysisSetAdjudicationRequired(
            f"{len(eligible)} clinically distinct result strata are available; "
            "select one versioned analysis set before synthesis",
            candidates=candidates,
        )
    selected = (
        recommend_analysis_set_candidate(project, eligible)
        if len(eligible) > 1
        else eligible[0]
    )
    automatically_ranked = len(eligible) > 1
    decision = _decision_from_candidate(
        selected,
        candidates=candidates,
        revision=0,
        status="automatic",
        selected_by=(
            "deterministic:protocol-primary-ranking"
            if automatically_ranked
            else "deterministic:unambiguous-stratum"
        ),
        reason=(
            "Full-automatic mode selected the stratum ranked closest to the "
            "protocol-defined primary outcome, preferring the prespecified outcome, "
            "an unrestricted subgroup, and the largest independent study set."
            if automatically_ranked
            else "Exactly one eligible outcome/timepoint/subgroup/effect-measure stratum was present."
        ),
    )
    project.save_json("analysis_set.json", decision, subdir="analysis")
    return decision


def recommend_analysis_set_candidate(
    project,
    candidates: list[AnalysisSetCandidate],
) -> AnalysisSetCandidate:
    """Rank ambiguous strata for explicit recommendation or full-auto fallback."""
    if not candidates:
        raise ValueError("at least one analysis-set candidate is required")
    protocol = project.load_json("protocol.json") or {}
    pico = protocol.get("pico") if isinstance(protocol, dict) else {}
    primary = str((pico or {}).get("outcome_primary") or "")
    primary_norm = _normalise_label(primary)

    def score(candidate: AnalysisSetCandidate) -> tuple[float, int, int, int, str]:
        label_norm = _normalise_label(candidate.outcome_name)
        exact = int(bool(primary_norm) and label_norm == primary_norm)
        contains = int(
            bool(primary_norm)
            and (primary_norm in label_norm or label_norm in primary_norm)
        )
        similarity = SequenceMatcher(None, primary_norm, label_norm).ratio() if primary_norm else 0.0
        unrestricted = int(not candidate.subgroup.strip())
        return (
            float(exact * 10 + contains * 3 + similarity),
            unrestricted,
            len(set(candidate.study_ids)),
            len(candidate.result_ids),
            candidate.candidate_id,
        )

    return max(candidates, key=score)


def analysis_set_option_payload(project, candidates: AnalysisSetCandidates) -> dict:
    """Return concise user-facing choices with one deterministic recommendation."""
    eligible = [item for item in candidates.candidates if item.eligible]
    recommended = recommend_analysis_set_candidate(project, eligible) if eligible else None
    return {
        "decision_type": "analysis_set",
        "question": "Which clinically distinct result set should define the primary synthesis?",
        "recommended_candidate_id": recommended.candidate_id if recommended else "",
        "options": [
            {
                "candidate_id": item.candidate_id,
                "label": item.outcome_name,
                "description": "; ".join(
                    value
                    for value in (
                        f"{len(set(item.study_ids))} studies",
                        f"timepoint: {item.timepoint}" if item.timepoint else "",
                        f"subgroup: {item.subgroup}" if item.subgroup else "all eligible participants",
                        item.effect_measure,
                    )
                    if value
                ),
                "recommended": bool(recommended and item.candidate_id == recommended.candidate_id),
            }
            for item in eligible
        ],
    }


def _normalise_label(value: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", str(value).casefold()).split())


def save_analysis_set_adjudication(
    project,
    *,
    candidate_id: str,
    expected_revision: int,
    selected_by: str,
    reason: str,
) -> AnalysisSetDecision:
    if not str(selected_by or "").strip() or not str(reason or "").strip():
        raise ValueError("selected_by and reason are required")
    lock_path = project.get_path("analysis_set_adjudications.json.lock", subdir="analysis")
    with _locked(lock_path):
        plan = MethodPlan.model_validate(project.load_json("method_plan.json", subdir="analysis"))
        candidates = discover_analysis_set_candidates(project, plan)
        current_payload = project.load_json("analysis_set.json", subdir="analysis")
        current_revision = int((current_payload or {}).get("revision") or 0)
        if int(expected_revision) != current_revision:
            raise AnalysisSetConflictError(
                f"stale analysis set revision: expected {expected_revision}, current {current_revision}"
            )
        selected = next(
            (
                item for item in candidates.candidates
                if item.candidate_id == candidate_id and item.eligible
            ),
            None,
        )
        if selected is None:
            raise ValueError("candidate_id is not a current eligible analysis-set candidate")
        decision = _decision_from_candidate(
            selected,
            candidates=candidates,
            revision=current_revision + 1,
            status="adjudicated",
            selected_by=str(selected_by).strip(),
            reason=str(reason).strip(),
        )
        history = project.load_json("analysis_set_adjudications.json", subdir="analysis") or {
            "schema_version": 1,
            "current_revision": 0,
            "history": [],
        }
        history["current_revision"] = decision.revision
        history.setdefault("history", []).append({
            "revision": decision.revision,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "decision": decision.model_dump(mode="json"),
        })
        project.save_json("analysis_set.json", decision, subdir="analysis")
        project.save_json("analysis_set_adjudications.json", history, subdir="analysis")
        project.clear_downstream("meta_analysis", include_self=True)
        return decision


def _unattended(project) -> bool:
    from new_meta.core.primary_analysis_alignment import project_is_unattended
    return project_is_unattended(project)


def _unattended_left_out(project, plan: MethodPlan, result_ids: list[str]) -> dict[str, str]:
    """Unattended only: results whose source rows are not verified matches (see
    primary_analysis_alignment.unattended_unverified_results), reported as a warning."""
    from new_meta.core.primary_analysis_alignment import (
        project_is_unattended, report_unverified_results_left_out, unattended_unverified_results,
    )
    if plan.family is ReviewFamily.IPD_META or not project_is_unattended(project):
        return {}
    from new_meta.schemas.protocol import ResearchProtocol
    protocol = ResearchProtocol.model_validate(project.load_json("protocol.json"))
    left_out = unattended_unverified_results(project, protocol, result_ids)
    report_unverified_results_left_out(project, left_out)
    return left_out


def _review_estimand(project) -> str:
    """The estimand reconciliation gives the protocol's own primary comparison."""
    from new_meta.core.rct_design_reconciliation import _estimand_id
    from new_meta.schemas.protocol import ResearchProtocol
    payload = project.load_json("protocol.json")
    if not payload:
        return ""
    return _estimand_id(ResearchProtocol.model_validate(payload))


def _one_contribution_per_trial(entities: list[ResultEntity]) -> tuple[list[ResultEntity], dict[str, str]]:
    """Keep, per trial, one result per comparison; several only as covariance-linked contrasts.

    Decided from each result's own arm metadata (its treatment and comparator
    arms, exactly as typed), never from its labels: a trial's distinct
    comparisons enter together when every pair has its covariance (the
    design-aware engine consolidates them, so the trial counts once). A
    comparison a trial reports more than once - at several windows, or for
    population subgroups - keeps its whole-population result if exactly one
    exists; otherwise, like a trial whose contrasts lack a covariance, the
    trial is left out and named, never entered twice.
    """
    by_study: dict[str, list[ResultEntity]] = {}
    for entity in entities:
        by_study.setdefault(entity.study_id, []).append(entity)
    kept: list[ResultEntity] = []
    left_out: dict[str, str] = {}
    for study_rows in by_study.values():
        by_contrast: dict[tuple[str, str], list[ResultEntity]] = {}
        for entity in sorted(study_rows, key=lambda item: item.entity_id):
            by_contrast.setdefault((entity.raw_data.treatment, entity.raw_data.comparator), []).append(entity)
        chosen, reason = [], ""
        for rows in by_contrast.values():
            if len(rows) > 1:
                # An empty subgroup is the whole randomized population: the
                # extraction prompt keeps an arm's route or dose out of
                # `subgroup` (it goes to subgroup_values), so a label left
                # here restricts the participants.
                whole = [item for item in rows if not item.subgroup.strip()]
                if len(whole) != 1:
                    reason = "same_comparison_reported_more_than_once"
                    break
                left_out.update({item.entity_id: "population_subgroup_of_an_included_comparison"
                                 for item in rows if item is not whole[0]})
                rows = whole
            chosen.append(rows[0])
        if not reason and len(chosen) > 1 and not _comparative_rows_linked(chosen):
            reason = "multi_arm_covariance_unresolved"
        if reason:
            left_out.update({item.entity_id: reason for item in study_rows})
            continue
        kept.extend(chosen)
    return kept, left_out


def _comparative_rows_linked(rows: list[ResultEntity]) -> bool:
    """One trial's contrasts: all multi-arm, distinct, and every pair with a covariance."""
    if any(item.raw_data.design != "multi_arm_rct" for item in rows):
        return False
    if len({item.raw_data.contrast_id for item in rows}) != len(rows):
        return False
    return all(
        right.raw_data.contrast_id in left.raw_data.covariance_with
        or left.raw_data.contrast_id in right.raw_data.covariance_with
        for position, left in enumerate(rows) for right in rows[position + 1:]
    )


def _entity_matches_plan(entity: ResultEntity, plan: MethodPlan) -> bool:
    if entity.effect_measure.upper() != plan.effect_measure.upper():
        return False
    if plan.family is ReviewFamily.PREVALENCE_INCIDENCE:
        if plan.effect_measure.upper() == "IR":
            return isinstance(entity.raw_data, IncidenceRateData)
        return isinstance(entity.raw_data, SingleArmProportionData)
    if plan.family is ReviewFamily.DIAGNOSTIC_ACCURACY:
        return isinstance(entity.raw_data, DiagnosticAccuracyData)
    if plan.family in {ReviewFamily.INTERVENTION_NRSI, ReviewFamily.PROGNOSTIC_FACTOR}:
        return (
            isinstance(entity.estimate, EffectEstimate)
            and entity.estimate.adjusted
            and bool(entity.estimate.adjusted_covariates)
        )
    if plan.family is ReviewFamily.PREDICTION_MODEL:
        return isinstance(entity.raw_data, PredictionPerformanceData)
    if plan.family in {ReviewFamily.INTERVENTION_RCT, ReviewFamily.NETWORK_META}:
        return isinstance(entity.raw_data, ComparativeEffectData) and isinstance(
            entity.estimate, EffectEstimate
        )
    if plan.family is ReviewFamily.DOSE_RESPONSE:
        return isinstance(entity.raw_data, DoseResponseData) and isinstance(
            entity.estimate, EffectEstimate
        )
    if plan.family is ReviewFamily.IPD_META:
        return isinstance(entity.raw_data, IPDStudyData)
    return False


def _dependent_rows_resolved(entities: list[ResultEntity], plan: MethodPlan) -> bool:
    if plan.family is ReviewFamily.DOSE_RESPONSE:
        by_study: dict[str, list[ResultEntity]] = {}
        for entity in entities:
            by_study.setdefault(entity.study_id, []).append(entity)
        for group in by_study.values():
            if len(group) < 2:
                return False
            if any(not isinstance(item.raw_data, DoseResponseData) for item in group):
                return False
            for left_index, left in enumerate(group):
                for right in group[left_index + 1:]:
                    if (
                        right.raw_data.contrast_id not in left.raw_data.covariance_with
                        and left.raw_data.contrast_id not in right.raw_data.covariance_with
                    ):
                        return False
        return True
    if plan.family not in {ReviewFamily.INTERVENTION_RCT, ReviewFamily.NETWORK_META}:
        return False
    by_study: dict[str, list[ResultEntity]] = {}
    for entity in entities:
        by_study.setdefault(entity.study_id, []).append(entity)
    for group in by_study.values():
        if len(group) < 2:
            continue
        if any(
            not isinstance(item.raw_data, ComparativeEffectData)
            or item.raw_data.design != "multi_arm_rct"
            for item in group
        ):
            return False
        for left_index, left in enumerate(group):
            for right in group[left_index + 1:]:
                left_data = left.raw_data
                right_data = right.raw_data
                if (
                    right_data.contrast_id not in left_data.covariance_with
                    and left_data.contrast_id not in right_data.covariance_with
                ):
                    return False
    return True


def _decision_from_candidate(
    candidate: AnalysisSetCandidate,
    *, candidates: AnalysisSetCandidates,
    revision: int,
    status: str,
    selected_by: str,
    reason: str,
) -> AnalysisSetDecision:
    return AnalysisSetDecision(
        revision=revision,
        status=status,
        plan_fingerprint=candidates.plan_fingerprint,
        ledger_head_hash=candidates.ledger_head_hash,
        candidate_id=candidate.candidate_id,
        outcome_id=candidate.outcome_id,
        outcome_name=candidate.outcome_name,
        outcome_type=candidate.outcome_type,
        timepoint=candidate.timepoint,
        subgroup=candidate.subgroup,
        effect_measure=candidate.effect_measure,
        result_ids=candidate.result_ids,
        selected_by=selected_by,
        reason=reason,
    )


def _candidate_id(payload: dict) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


@contextmanager
def _locked(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with _LOCK:
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
