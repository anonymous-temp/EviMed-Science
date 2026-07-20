"""Deterministic draft plus human adjudication for method-specific certainty."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import threading

from new_meta.core.result_rob import load_effective_rob_assessments
from new_meta.schemas.method_certainty import (
    CertaintyDomainRating,
    MethodCertaintyAssessment,
    MethodCertaintyDomain,
    MethodCertaintyOutcome,
    MethodCertaintyStatus,
)
from new_meta.schemas.method_policy import MethodPlan, ReviewFamily
from new_meta.schemas.phase_result import NextAction
from new_meta.schemas.risk_of_bias import RoBAssessmentStatus
from new_meta.schemas.synthesis_result import SynthesisResultEnvelope


class MethodCertaintyConflictError(RuntimeError):
    pass


_LOCK = threading.RLock()


def build_method_certainty_draft(project) -> MethodCertaintyAssessment:
    plan = MethodPlan.model_validate(project.load_json("method_plan.json", subdir="analysis"))
    synthesis_payload = project.load_json("synthesis_result.json", subdir="analysis")
    synthesis = SynthesisResultEnvelope.model_validate(synthesis_payload)
    synthesis_fingerprint = synthesis_result_fingerprint(synthesis_payload)
    method_result = project.load_json("method_result.json", subdir="analysis") or {}
    ledger_head_hash = str(method_result.get("input_ledger_head_hash") or "")
    assessments = load_effective_rob_assessments(project, [])
    completed = {
        item.result_id: item
        for item in assessments
        if getattr(item, "is_result_specific", False)
        and getattr(item, "assessment_status", None) in {
            RoBAssessmentStatus.COMPLETE,
            RoBAssessmentStatus.ADJUDICATED,
        }
    }
    risk_of_bias_fingerprint = _risk_of_bias_fingerprint(
        completed,
        synthesis.input_result_ids,
    )
    existing_payload = project.load_json("method_certainty.json", subdir="analysis")
    if existing_payload:
        existing = MethodCertaintyAssessment.model_validate(existing_payload)
        if (
            existing.status is MethodCertaintyStatus.COMPLETED
            and existing.plan_fingerprint == plan.plan_fingerprint
            and existing.input_result_ids == synthesis.input_result_ids
            and existing.synthesis_fingerprint == synthesis_fingerprint
            and existing.input_ledger_head_hash == ledger_head_hash
            and existing.risk_of_bias_fingerprint == risk_of_bias_fingerprint
        ):
            return existing
    judgments = [
        str(completed[result_id].overall_judgment or "")
        for result_id in synthesis.input_result_ids
        if result_id in completed
    ]
    risk_rating = _risk_of_bias_rating(judgments, required=len(synthesis.input_result_ids))
    if plan.family is ReviewFamily.INTERVENTION_RCT:
        draft = _build_rct_certainty(
            plan=plan,
            synthesis=synthesis,
            completed=completed,
            judgments=judgments,
            risk_rating=risk_rating,
        )
    elif plan.family is ReviewFamily.NETWORK_META:
        draft = _build_network_certainty(
            plan=plan,
            synthesis=synthesis,
            completed=completed,
            judgments=judgments,
            risk_rating=risk_rating,
        )
    elif plan.family is ReviewFamily.DOSE_RESPONSE:
        draft = _build_dose_response_certainty(
            plan=plan,
            synthesis=synthesis,
            completed=completed,
            judgments=judgments,
            risk_rating=risk_rating,
        )
    elif plan.family is ReviewFamily.IPD_META:
        draft = _build_ipd_certainty(
            plan=plan,
            synthesis=synthesis,
            completed=completed,
            judgments=judgments,
            risk_rating=risk_rating,
        )
    elif plan.family is ReviewFamily.PREVALENCE_INCIDENCE:
        draft = _build_prevalence_certainty(
            plan=plan,
            synthesis=synthesis,
            completed=completed,
            judgments=judgments,
            risk_rating=risk_rating,
        )
    elif plan.family is ReviewFamily.DIAGNOSTIC_ACCURACY:
        draft = _build_dta_certainty(
            plan=plan,
            synthesis=synthesis,
            completed=completed,
            judgments=judgments,
            risk_rating=risk_rating,
        )
    elif plan.family is ReviewFamily.INTERVENTION_NRSI:
        draft = _build_nrsi_certainty(
            plan=plan,
            synthesis=synthesis,
            completed=completed,
            judgments=judgments,
            risk_rating=risk_rating,
        )
    elif plan.family is ReviewFamily.PROGNOSTIC_FACTOR:
        draft = _build_prognostic_certainty(
            plan=plan,
            synthesis=synthesis,
            completed=completed,
            judgments=judgments,
            risk_rating=risk_rating,
        )
    elif plan.family is ReviewFamily.PREDICTION_MODEL:
        draft = _build_prediction_certainty(
            plan=plan,
            synthesis=synthesis,
            completed=completed,
            judgments=judgments,
            risk_rating=risk_rating,
        )
    else:
        raise ValueError(f"certainty compiler is not implemented for {plan.family.value}")
    draft = draft.model_copy(update={
        "revision": 0,
        "synthesis_fingerprint": synthesis_fingerprint,
        "input_ledger_head_hash": ledger_head_hash,
        "risk_of_bias_fingerprint": risk_of_bias_fingerprint,
        "adjudicated_by": "",
        "adjudication_reason": "",
    })
    project.save_json("method_certainty.json", draft, subdir="analysis")
    return draft


def synthesis_result_fingerprint(payload: dict) -> str:
    """Return a stable content identity for the exact synthesis being graded."""
    return hashlib.sha256(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def _risk_of_bias_fingerprint(completed: dict, input_result_ids: list[str]) -> str:
    payload = [
        (
            completed[result_id].model_dump(mode="json")
            if result_id in completed
            else {"result_id": result_id, "status": "missing"}
        )
        for result_id in input_result_ids
    ]
    return hashlib.sha256(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def current_result_risk_of_bias_fingerprint(project, input_result_ids: list[str]) -> str:
    """Return the identity of the currently effective result-level RoB set."""
    assessments = load_effective_rob_assessments(project, [])
    completed = {
        item.result_id: item
        for item in assessments
        if getattr(item, "is_result_specific", False)
        and getattr(item, "assessment_status", None) in {
            RoBAssessmentStatus.COMPLETE,
            RoBAssessmentStatus.ADJUDICATED,
        }
    }
    return _risk_of_bias_fingerprint(completed, input_result_ids)


def complete_method_certainty_conservatively(
    project,
    assessment: MethodCertaintyAssessment | None = None,
) -> MethodCertaintyAssessment:
    """Apply explicit conservative defaults only for requested full-auto runs.

    Interactive runs still expose the existing domain choices.  This fallback
    keeps ``--skip-confirm`` non-blocking without silently treating an unknown
    applicability or reporting-bias domain as having no concern.
    """
    current = assessment or build_method_certainty_draft(project)
    if current.status is MethodCertaintyStatus.COMPLETED:
        return current
    outcomes = []
    for outcome in current.outcomes:
        domains = []
        for domain in outcome.domains:
            if (
                domain.rating is CertaintyDomainRating.NOT_ASSESSED
                or domain.requires_human_judgment
            ):
                rating = (
                    CertaintyDomainRating.VERY_SERIOUS
                    if domain.domain == "risk_of_bias"
                    else CertaintyDomainRating.SERIOUS
                )
                domains.append(domain.model_copy(update={
                    "rating": rating,
                    "rationale": (
                        "Full-automatic mode used the conservative recommended option because "
                        "no user confirmation was requested. " + domain.rationale
                    ),
                    "requires_human_judgment": False,
                }))
            else:
                domains.append(domain)
        outcomes.append(outcome.model_copy(update={
            "certainty": _final_certainty(
                domains,
                starting_certainty=outcome.starting_certainty,
            ),
            "domains": domains,
        }))
    completed = current.model_copy(update={
        "status": MethodCertaintyStatus.COMPLETED,
        "outcomes": outcomes,
        "next_actions": [],
        "adjudicated_by": "automatic:conservative-default",
        "adjudication_reason": (
            "Full-automatic execution accepted the documented conservative recommendation."
        ),
    })
    project.save_json("method_certainty.json", completed, subdir="analysis")
    return completed


def build_method_certainty_option_payload(
    assessment: MethodCertaintyAssessment,
) -> dict:
    """Present uncertainty as three understandable choices, not a raw form."""
    unresolved = [
        (outcome, domain)
        for outcome in assessment.outcomes
        for domain in outcome.domains
        if domain.requires_human_judgment
        or domain.rating is CertaintyDomainRating.NOT_ASSESSED
    ]
    multiple_outcomes = len(assessment.outcomes) > 1
    return {
        "decision_type": "method_certainty",
        "question": (
            "How should the context-dependent certainty domains be handled for this article?"
        ),
        "recommended_option_id": "conservative",
        "unresolved_domain_ids": [
            _certainty_override_key(outcome.outcome_id, domain.domain, multiple_outcomes)
            for outcome, domain in unresolved
        ],
        "unresolved_domains": [
            {
                "outcome_id": outcome.outcome_id,
                "outcome_label": outcome.outcome_label,
                "domain": domain.domain,
                "why_uncertain": domain.rationale,
            }
            for outcome, domain in unresolved
        ],
        "options": [
            {
                "option_id": "conservative",
                "label": "Conservative (recommended)",
                "description": (
                    "Rate unresolved domains as serious and continue; the article will state "
                    "that a conservative assumption was used."
                ),
            },
            {
                "option_id": "very_conservative",
                "label": "Very conservative",
                "description": (
                    "Rate unresolved domains as very serious, yielding the lowest defensible certainty."
                ),
            },
            {
                "option_id": "custom",
                "label": "Review each domain",
                "description": "Choose and explain a rating for every unresolved domain.",
            },
        ],
    }


def apply_method_certainty_option(
    project,
    *,
    option_id: str,
    selected_by: str,
    custom_overrides: dict | None = None,
) -> MethodCertaintyAssessment:
    """Apply one presented certainty option through the versioned adjudication path."""
    current_payload = project.load_json("method_certainty.json", subdir="analysis")
    current = (
        MethodCertaintyAssessment.model_validate(current_payload)
        if current_payload
        else build_method_certainty_draft(project)
    )
    multiple_outcomes = len(current.outcomes) > 1
    unresolved = {
        _certainty_override_key(outcome.outcome_id, item.domain, multiple_outcomes): item
        for outcome in current.outcomes
        for item in outcome.domains
        if item.requires_human_judgment
        or item.rating is CertaintyDomainRating.NOT_ASSESSED
    }
    option_id = str(option_id or "").strip().lower()
    if option_id not in {"conservative", "very_conservative", "custom"}:
        raise ValueError("unknown method certainty option")
    if option_id == "custom":
        overrides = dict(custom_overrides or {})
        reason = "User reviewed each unresolved certainty domain."
    else:
        rating = (
            CertaintyDomainRating.SERIOUS
            if option_id == "conservative"
            else CertaintyDomainRating.VERY_SERIOUS
        )
        overrides = {
            name: {
                "rating": rating.value,
                "rationale": (
                    f"User selected the {option_id.replace('_', ' ')} option because "
                    f"the decision context was not otherwise specified. {domain.rationale}"
                ),
            }
            for name, domain in unresolved.items()
        }
        reason = f"User selected the {option_id.replace('_', ' ')} certainty option."
    return save_method_certainty_adjudication(
        project,
        expected_revision=current.revision,
        adjudicated_by=str(selected_by or "user").strip() or "user",
        reason=reason,
        domain_overrides=overrides,
    )


def _build_rct_certainty(
    *, plan, synthesis, completed, judgments, risk_rating
) -> MethodCertaintyAssessment:
    estimate = synthesis.primary_estimates[0]
    if estimate.measure not in {"OR", "RR", "RD", "MD", "SMD", "HR", "IRR"}:
        raise ValueError("randomized-intervention certainty received an unsupported effect measure")
    inconsistency = _comparative_inconsistency_domain(synthesis)
    domains = [
        _risk_domain(
            risk_rating=risk_rating,
            judgments=judgments,
            required=len(synthesis.input_result_ids),
            completed=completed,
            tool="RoB 2",
        ),
        inconsistency,
        MethodCertaintyDomain(
            domain="indirectness",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Population, intervention variant and dose, comparator, outcome definition, and "
                "follow-up must be compared with the prespecified review question."
            ),
            requires_human_judgment=True,
        ),
        _comparative_imprecision_domain(estimate),
        _publication_bias_domain(
            "Trial registration, unavailable results, selective outcome reporting, and small-study "
            "patterns require contextual assessment."
        ),
    ]
    return _certainty_assessment(
        plan=plan,
        synthesis=synthesis,
        framework="GRADE certainty for randomized intervention evidence",
        framework_note=(
            "Randomized evidence starts at high certainty. Design-aware cluster, crossover, and "
            "multi-arm handling changes the valid precision calculation but does not bypass the "
            "standard GRADE domains."
        ),
        outcomes=[_certainty_outcome(estimate, domains, starting_certainty="high")],
        action_prefix="randomized evidence",
    )


def _build_network_certainty(
    *, plan, synthesis, completed, judgments, risk_rating
) -> MethodCertaintyAssessment:
    if not synthesis.primary_estimates:
        raise ValueError("network certainty requires at least one network comparison")
    risk = _risk_domain(
        risk_rating=risk_rating,
        judgments=judgments,
        required=len(synthesis.input_result_ids),
        completed=completed,
        tool="RoB 2",
    )
    transitivity = synthesis.engine_payload.get("transitivity_assessment") or {}
    status = str(transitivity.get("status") or "").lower()
    if status == "adequate":
        indirectness = MethodCertaintyDomain(
            domain="indirectness_transitivity",
            rating=CertaintyDomainRating.NO_CONCERN,
            rationale=(
                "The prespecified transitivity assessment was adequate for the recorded effect "
                "modifiers; comparison-specific applicability still follows the recorded network."
            ),
            evidence=transitivity,
        )
    else:
        indirectness = MethodCertaintyDomain(
            domain="indirectness_transitivity",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale="Transitivity and comparison-specific applicability were not established.",
            evidence=transitivity,
            requires_human_judgment=True,
        )
    incoherence = _network_incoherence_domain(synthesis)
    heterogeneity = MethodCertaintyDomain(
        domain="heterogeneity",
        rating=CertaintyDomainRating.NOT_ASSESSED,
        rationale=(
            "The common between-study variance must be interpreted against clinically important "
            "effect differences for each network comparison."
        ),
        evidence=synthesis.heterogeneity,
        requires_human_judgment=True,
    )
    outcomes = []
    for estimate in synthesis.primary_estimates:
        domains = [
            risk.model_copy(deep=True),
            heterogeneity.model_copy(deep=True),
            indirectness.model_copy(deep=True),
            _comparative_imprecision_domain(estimate),
            incoherence.model_copy(deep=True),
            _publication_bias_domain(
                "Across-network reporting bias and unavailable treatment comparisons require "
                "registry, missing-study, and small-study assessment."
            ),
        ]
        outcomes.append(_certainty_outcome(estimate, domains, starting_certainty="high"))
    return _certainty_assessment(
        plan=plan,
        synthesis=synthesis,
        framework="GRADE/CINeMA certainty for network meta-analysis",
        framework_note=(
            "Certainty is assessed separately for every network comparison using within-study "
            "bias, heterogeneity, indirectness/transitivity, imprecision, incoherence, and "
            "reporting-bias domains. Rankings are not certainty ratings."
        ),
        outcomes=outcomes,
        action_prefix="network evidence",
    )


def _build_dose_response_certainty(
    *, plan, synthesis, completed, judgments, risk_rating
) -> MethodCertaintyAssessment:
    estimate = synthesis.primary_estimates[0]
    randomized = bool(plan.study_designs) and all(
        "rct" in str(design).lower() or "random" in str(design).lower()
        for design in plan.study_designs
    )
    starting = "high" if randomized else "low"
    diagnostics = synthesis.engine_payload.get("diagnostics") or {}
    model_valid = bool(
        synthesis.execution_converged is not False
        and diagnostics.get("within_study_covariance") == "explicit"
        and diagnostics.get("dose_harmonization")
    )
    domains = [
        _risk_domain(
            risk_rating=risk_rating,
            judgments=judgments,
            required=len(synthesis.input_result_ids),
            completed=completed,
            tool=("RoB 2" if randomized else "design-specific risk-of-bias tool"),
        ),
        MethodCertaintyDomain(
            domain="inconsistency",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Between-study differences across the fitted dose-response curves require "
                "clinical interpretation on the harmonized dose scale."
            ),
            evidence={"between_study_covariance": synthesis.engine_payload.get("between_study_covariance")},
            requires_human_judgment=True,
        ),
        MethodCertaintyDomain(
            domain="indirectness",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Exposure definition, dose unit, reference category, population, outcome, and "
                "follow-up applicability require comparison with the protocol."
            ),
            requires_human_judgment=True,
        ),
        _comparative_imprecision_domain(estimate),
        _publication_bias_domain(
            "Selective publication of dose categories, curve shapes, or adjusted models requires "
            "registry and missing-result assessment."
        ),
        MethodCertaintyDomain(
            domain="dose_model",
            rating=(
                CertaintyDomainRating.NO_CONCERN
                if model_valid
                else CertaintyDomainRating.VERY_SERIOUS
            ),
            rationale=(
                "Dose units were harmonized, within-study covariance was explicit, and the "
                "multivariate model converged."
                if model_valid
                else "The dose model lacked convergence, harmonized units, or explicit covariance."
            ),
            evidence=diagnostics,
        ),
    ]
    return _certainty_assessment(
        plan=plan,
        synthesis=synthesis,
        framework="GRADE certainty for dose-response evidence",
        framework_note=(
            f"Evidence starts at {starting} certainty according to the underlying study designs. "
            "The curve-specific appraisal adds an explicit dose-model domain without treating "
            "model fit as proof of causal certainty."
        ),
        outcomes=[_certainty_outcome(estimate, domains, starting_certainty=starting)],
        action_prefix="dose-response evidence",
    )


def _build_ipd_certainty(
    *, plan, synthesis, completed, judgments, risk_rating
) -> MethodCertaintyAssessment:
    estimate = synthesis.primary_estimates[0]
    domains = [
        _risk_domain(
            risk_rating=risk_rating,
            judgments=judgments,
            required=len(synthesis.input_result_ids),
            completed=completed,
            tool="RoB 2",
        ),
        _comparative_inconsistency_domain(synthesis),
        MethodCertaintyDomain(
            domain="indirectness",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Participant eligibility, treatment implementation, outcome definition, follow-up, "
                "and covariate availability require comparison with the review question."
            ),
            requires_human_judgment=True,
        ),
        _comparative_imprecision_domain(estimate),
        _publication_bias_domain(
            "Unavailable trials, unavailable participant datasets, and selective provision of IPD "
            "require assessment across all eligible studies."
        ),
        MethodCertaintyDomain(
            domain="ipd_availability",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "The analysis verifies the supplied participant rows but cannot determine whether "
                "IPD were unavailable for otherwise eligible studies."
            ),
            evidence={"n_participants": synthesis.engine_payload.get("n_participants")},
            requires_human_judgment=True,
        ),
    ]
    return _certainty_assessment(
        plan=plan,
        synthesis=synthesis,
        framework="GRADE certainty for randomized IPD meta-analysis",
        framework_note=(
            "Randomized IPD evidence starts at high certainty. Participant-level modeling can "
            "improve adjustment and interaction assessment but does not remove study bias, "
            "missing-IPD bias, indirectness, or imprecision."
        ),
        outcomes=[_certainty_outcome(estimate, domains, starting_certainty="high")],
        action_prefix="IPD evidence",
    )


def _certainty_override_key(outcome_id: str, domain: str, multiple_outcomes: bool) -> str:
    return f"{outcome_id}::{domain}" if multiple_outcomes else domain


def _risk_domain(
    *, risk_rating, judgments, required: int, completed: dict, tool: str
) -> MethodCertaintyDomain:
    unresolved = risk_rating is CertaintyDomainRating.NOT_ASSESSED
    return MethodCertaintyDomain(
        domain="risk_of_bias",
        rating=risk_rating,
        rationale=(
            f"Completed result-level {tool} assessments={len(judgments)}/{required}; "
            f"judgments={judgments or ['missing']}."
        ),
        evidence={
            "completed_result_ids": sorted(completed),
            "required_result_count": required,
            "judgments": list(judgments),
            "tool": tool,
        },
        requires_human_judgment=unresolved,
    )


def _comparative_inconsistency_domain(synthesis) -> MethodCertaintyDomain:
    i_squared = synthesis.heterogeneity.get("i_squared")
    if i_squared is None or synthesis.n_studies < 2:
        return MethodCertaintyDomain(
            domain="inconsistency",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale="Between-study inconsistency was not estimable from fewer than two studies.",
            evidence=synthesis.heterogeneity,
            requires_human_judgment=True,
        )
    value = float(i_squared)
    rating = (
        CertaintyDomainRating.NO_CONCERN
        if value <= 40.0
        else CertaintyDomainRating.SERIOUS
        if value <= 75.0
        else CertaintyDomainRating.VERY_SERIOUS
    )
    return MethodCertaintyDomain(
        domain="inconsistency",
        rating=rating,
        rationale=(
            f"I-squared was {value:.1f}% across {synthesis.n_studies} independent study units; "
            "the rating reflects statistical inconsistency, with clinical sources described separately."
        ),
        evidence={**synthesis.heterogeneity, "n_studies": synthesis.n_studies},
    )


def _comparative_imprecision_domain(estimate) -> MethodCertaintyDomain:
    return MethodCertaintyDomain(
        domain="imprecision",
        rating=CertaintyDomainRating.NOT_ASSESSED,
        rationale=(
            "The confidence and prediction intervals must be compared with a prespecified minimal "
            "important effect or decision threshold; exclusion of the null alone is insufficient."
        ),
        evidence={
            "measure": estimate.measure,
            "ci": [estimate.ci_lower, estimate.ci_upper],
            "prediction_interval": [estimate.prediction_lower, estimate.prediction_upper],
        },
        requires_human_judgment=True,
    )


def _publication_bias_domain(rationale: str) -> MethodCertaintyDomain:
    return MethodCertaintyDomain(
        domain="publication_bias",
        rating=CertaintyDomainRating.NOT_ASSESSED,
        rationale=rationale,
        requires_human_judgment=True,
    )


def _network_incoherence_domain(synthesis) -> MethodCertaintyDomain:
    payload = synthesis.engine_payload
    global_test = (payload.get("diagnostics") or {}).get("design_by_treatment") or {}
    global_p = global_test.get("p_value")
    splits = payload.get("node_splitting") or {}
    split_p = [
        float(item["p_value"])
        for item in splits.values()
        if isinstance(item, dict) and item.get("p_value") is not None
    ]
    evidence = {"design_by_treatment": global_test, "node_splitting": splits}
    if (global_p is not None and float(global_p) < 0.05) or any(p < 0.05 for p in split_p):
        return MethodCertaintyDomain(
            domain="incoherence",
            rating=CertaintyDomainRating.SERIOUS,
            rationale="A global or local direct-versus-indirect inconsistency test was below 0.05.",
            evidence=evidence,
        )
    if global_p is not None or split_p:
        return MethodCertaintyDomain(
            domain="incoherence",
            rating=CertaintyDomainRating.NO_CONCERN,
            rationale=(
                "No global or estimable local inconsistency test was below 0.05; sparse networks "
                "may still have low power, which remains visible in the diagnostics."
            ),
            evidence=evidence,
        )
    return MethodCertaintyDomain(
        domain="incoherence",
        rating=CertaintyDomainRating.NOT_ASSESSED,
        rationale="Direct-versus-indirect incoherence was not estimable for this network geometry.",
        evidence=evidence,
        requires_human_judgment=True,
    )


def _certainty_outcome(estimate, domains, *, starting_certainty: str):
    return MethodCertaintyOutcome(
        outcome_id=estimate.estimate_id,
        outcome_label=estimate.label,
        starting_certainty=starting_certainty,
        certainty="not_assessed",
        domains=domains,
    )


def _certainty_assessment(
    *, plan, synthesis, framework: str, framework_note: str, outcomes, action_prefix: str
) -> MethodCertaintyAssessment:
    unresolved = [
        (outcome, domain)
        for outcome in outcomes
        for domain in outcome.domains
        if domain.requires_human_judgment
        or domain.rating is CertaintyDomainRating.NOT_ASSESSED
    ]
    return MethodCertaintyAssessment(
        status=(
            MethodCertaintyStatus.NEEDS_INPUT
            if unresolved
            else MethodCertaintyStatus.COMPLETED
        ),
        family=plan.family,
        framework=framework,
        framework_note=framework_note,
        plan_fingerprint=plan.plan_fingerprint,
        input_result_ids=synthesis.input_result_ids,
        outcomes=outcomes,
        next_actions=[
            NextAction(
                action_id=(
                    f"adjudicate_{outcome.outcome_id}_{domain.domain}"
                    .replace(":", "_")
                    .replace(" ", "_")
                    .lower()
                ),
                title=f"Resolve {action_prefix} {domain.domain.replace('_', ' ')}",
                description=(
                    f"{outcome.outcome_label}: {domain.rationale}"
                    if len(outcomes) > 1
                    else domain.rationale
                ),
            )
            for outcome, domain in unresolved
        ],
    )


def _build_prevalence_certainty(
    *, plan, synthesis, completed, judgments, risk_rating
) -> MethodCertaintyAssessment:
    measure = synthesis.primary_estimates[0].measure
    if measure not in {"PROP", "IR"}:
        raise ValueError("prevalence/incidence certainty requires a PROP or IR result")
    is_incidence = measure == "IR"
    estimate = synthesis.primary_estimates[0]
    if is_incidence:
        inconsistency_rating = CertaintyDomainRating.NOT_ASSESSED
        inconsistency_rationale = (
            "Clinical meaning of between-study variation in incidence rates depends on the "
            "common time unit, follow-up process, competing events, and target setting."
        )
        imprecision_rating = CertaintyDomainRating.NOT_ASSESSED
        imprecision_rationale = (
            "Confidence and prediction limits for an incidence rate require a prespecified "
            "decision context; no context-free rate-width threshold is valid."
        )
    else:
        inconsistency_rating, inconsistency_rationale = _inconsistency_rating(synthesis)
        imprecision_rating, imprecision_rationale = _imprecision_rating(synthesis)
    domains = [
        MethodCertaintyDomain(
            domain="risk_of_bias",
            rating=risk_rating,
            rationale=(
                f"Completed result-level assessments={len(judgments)}/{len(synthesis.input_result_ids)}; "
                f"judgments={judgments or ['missing']}."
            ),
            evidence={"completed_result_ids": sorted(completed)},
        ),
        MethodCertaintyDomain(
            domain="inconsistency",
            rating=inconsistency_rating,
            rationale=inconsistency_rationale,
            evidence=synthesis.heterogeneity,
            requires_human_judgment=is_incidence,
        ),
        MethodCertaintyDomain(
            domain="indirectness",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Applicability of populations, sampling frames, settings, outcome definitions, "
                "time periods, and person-time ascertainment requires protocol-level human judgment."
            ),
            requires_human_judgment=True,
        ),
        MethodCertaintyDomain(
            domain="imprecision",
            rating=imprecision_rating,
            rationale=imprecision_rationale,
            evidence={
                "ci_lower": estimate.ci_lower,
                "ci_upper": estimate.ci_upper,
                "total_participants": synthesis.engine_payload.get("total_participants"),
                "total_person_time": synthesis.engine_payload.get("total_person_time"),
                "time_unit": synthesis.engine_payload.get("time_unit"),
            },
            requires_human_judgment=is_incidence,
        ),
        MethodCertaintyDomain(
            domain="publication_bias",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Selective non-publication and missing prevalence or incidence estimates cannot be resolved "
                "from statistical asymmetry tests alone."
            ),
            requires_human_judgment=True,
        ),
    ]
    return MethodCertaintyAssessment(
        status=MethodCertaintyStatus.NEEDS_INPUT,
        family=plan.family,
        framework=(
            "GRADE-adapted certainty for incidence-rate estimates"
            if is_incidence
            else "GRADE-adapted certainty for prevalence estimates"
        ),
        framework_note=(
            "Transparent adaptation for prevalence/incidence questions; this is not intervention GRADE. "
            "Context-dependent domains remain human-adjudicated."
        ),
        plan_fingerprint=plan.plan_fingerprint,
        input_result_ids=synthesis.input_result_ids,
        outcomes=[
            MethodCertaintyOutcome(
                outcome_id=estimate.estimate_id,
                outcome_label=estimate.label,
                certainty="not_assessed",
                domains=domains,
            )
        ],
        next_actions=(
            [
                NextAction(
                    action_id=f"adjudicate_{domain.domain}",
                    title=f"Adjudicate incidence {domain.domain.replace('_', ' ')}",
                    description=domain.rationale,
                )
                for domain in domains
                if domain.requires_human_judgment
            ]
            if is_incidence
            else [
                NextAction(
                    action_id="adjudicate_indirectness",
                    title="Adjudicate prevalence indirectness",
                    description="Compare population, setting, sampling frame, definition, and time period with the protocol.",
                ),
                NextAction(
                    action_id="adjudicate_publication_bias",
                    title="Adjudicate publication bias",
                    description="Review registries, missing estimates, small studies, and selective reporting evidence.",
                ),
            ]
        ),
    )


def _build_dta_certainty(
    *, plan, synthesis, completed, judgments, risk_rating
) -> MethodCertaintyAssessment:
    estimates = {item.measure: item for item in synthesis.primary_estimates}
    if not {"SENS", "SPEC"} <= set(estimates):
        raise ValueError("diagnostic certainty requires joint SENS and SPEC results")
    sensitivity = estimates["SENS"]
    specificity = estimates["SPEC"]
    human_domains = [
        MethodCertaintyDomain(
            domain="inconsistency",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Joint heterogeneity in sensitivity and false-positive rate must be judged "
                "against clinically meaningful consequences; no universal numerical cutoff applies."
            ),
            evidence=synthesis.heterogeneity,
            requires_human_judgment=True,
        ),
        MethodCertaintyDomain(
            domain="indirectness",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Applicability of patient spectrum, index-test conduct, reference standard, "
                "setting, and the common threshold requires protocol-level human judgment."
            ),
            evidence={
                "threshold": synthesis.engine_payload.get("diagnostics", {}).get("common_threshold"),
            },
            requires_human_judgment=True,
        ),
        MethodCertaintyDomain(
            domain="imprecision",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Sensitivity and specificity confidence limits must be compared jointly with "
                "clinical decision thresholds and the consequences of false results."
            ),
            evidence={
                "sensitivity_ci": [sensitivity.ci_lower, sensitivity.ci_upper],
                "specificity_ci": [specificity.ci_lower, specificity.ci_upper],
            },
            requires_human_judgment=True,
        ),
        MethodCertaintyDomain(
            domain="publication_bias",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Selective publication, threshold reporting, and omission of unusable 2x2 data "
                "cannot be resolved from an asymmetry test alone."
            ),
            requires_human_judgment=True,
        ),
    ]
    domains = [
        MethodCertaintyDomain(
            domain="risk_of_bias",
            rating=risk_rating,
            rationale=(
                f"Completed result-level QUADAS-2 assessments={len(judgments)}/"
                f"{len(synthesis.input_result_ids)}; judgments={judgments or ['missing']}."
            ),
            evidence={"completed_result_ids": sorted(completed)},
        ),
        *human_domains,
    ]
    actions = [
        NextAction(
            action_id=f"adjudicate_{domain.domain}",
            title=f"Adjudicate diagnostic-accuracy {domain.domain.replace('_', ' ')}",
            description=domain.rationale,
        )
        for domain in human_domains
    ]
    return MethodCertaintyAssessment(
        status=MethodCertaintyStatus.NEEDS_INPUT,
        family=plan.family,
        framework="GRADE certainty for diagnostic test accuracy",
        framework_note=(
            "Sensitivity and specificity are interpreted jointly. Applicability, heterogeneity, "
            "precision, and reporting-bias judgments are decision-context dependent and cannot "
            "be replaced by fixed automated thresholds."
        ),
        plan_fingerprint=plan.plan_fingerprint,
        input_result_ids=synthesis.input_result_ids,
        outcomes=[
            MethodCertaintyOutcome(
                outcome_id="summary_diagnostic_accuracy",
                outcome_label="Summary sensitivity and specificity",
                certainty="not_assessed",
                domains=domains,
            )
        ],
        next_actions=actions,
    )


def _build_nrsi_certainty(
    *, plan, synthesis, completed, judgments, risk_rating
) -> MethodCertaintyAssessment:
    estimate = synthesis.primary_estimates[0]
    if estimate.measure not in {"OR", "RR", "HR", "IRR"}:
        raise ValueError("released NRSI certainty requires an adjusted ratio measure")
    human_domains = [
        MethodCertaintyDomain(
            domain="inconsistency",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Statistical heterogeneity, design context, exposure definitions, and residual "
                "confounding patterns require joint human interpretation."
            ),
            evidence=synthesis.heterogeneity,
            requires_human_judgment=True,
        ),
        MethodCertaintyDomain(
            domain="indirectness",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Population, exposure, comparator, outcome, follow-up horizon, and adjusted "
                "estimand applicability require protocol-level human judgment."
            ),
            requires_human_judgment=True,
        ),
        MethodCertaintyDomain(
            domain="imprecision",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "The confidence and prediction intervals must be compared with a prespecified "
                "decision threshold; no context-free ratio-width cutoff is valid."
            ),
            evidence={
                "ci": [estimate.ci_lower, estimate.ci_upper],
                "prediction_interval": [estimate.prediction_lower, estimate.prediction_upper],
            },
            requires_human_judgment=True,
        ),
        MethodCertaintyDomain(
            domain="publication_bias",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Selective publication and selective choice among adjusted models require review "
                "of protocols, analysis plans, registries, and missing estimates."
            ),
            requires_human_judgment=True,
        ),
    ]
    domains = [
        MethodCertaintyDomain(
            domain="risk_of_bias",
            rating=risk_rating,
            rationale=(
                f"Completed result-level ROBINS-I assessments={len(judgments)}/"
                f"{len(synthesis.input_result_ids)}; judgments={judgments or ['missing']}."
            ),
            evidence={"completed_result_ids": sorted(completed)},
        ),
        *human_domains,
    ]
    return MethodCertaintyAssessment(
        status=MethodCertaintyStatus.NEEDS_INPUT,
        family=plan.family,
        framework="GRADE certainty for adjusted non-randomized intervention evidence",
        framework_note=(
            "The draft starts at low certainty for observational evidence. ROBINS-I and GRADE "
            "address different judgments; pooling adjusted estimates does not eliminate residual confounding."
        ),
        plan_fingerprint=plan.plan_fingerprint,
        input_result_ids=synthesis.input_result_ids,
        outcomes=[
            MethodCertaintyOutcome(
                outcome_id=estimate.estimate_id,
                outcome_label=estimate.label,
                starting_certainty="low",
                certainty="not_assessed",
                domains=domains,
            )
        ],
        next_actions=[
            NextAction(
                action_id=f"adjudicate_{domain.domain}",
                title=f"Adjudicate adjusted-evidence {domain.domain.replace('_', ' ')}",
                description=domain.rationale,
            )
            for domain in human_domains
        ],
    )


def _build_prognostic_certainty(
    *, plan, synthesis, completed, judgments, risk_rating
) -> MethodCertaintyAssessment:
    estimate = synthesis.primary_estimates[0]
    if estimate.measure not in {"OR", "RR", "HR"}:
        raise ValueError("released prognostic certainty requires an adjusted ratio measure")
    human_domains = [
        MethodCertaintyDomain(
            domain="inconsistency",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Heterogeneity in factor measurement, clinical case mix, model specification, "
                "and association magnitude requires human interpretation at the common horizon."
            ),
            evidence=synthesis.heterogeneity,
            requires_human_judgment=True,
        ),
        MethodCertaintyDomain(
            domain="indirectness",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Population, prognostic-factor definition, outcome, treatment context, and time "
                "horizon must be compared with the protocol."
            ),
            requires_human_judgment=True,
        ),
        MethodCertaintyDomain(
            domain="imprecision",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Confidence and prediction limits require a prespecified prognostic decision "
                "context; a context-free ratio-width cutoff is not valid."
            ),
            evidence={
                "ci": [estimate.ci_lower, estimate.ci_upper],
                "prediction_interval": [estimate.prediction_lower, estimate.prediction_upper],
            },
            requires_human_judgment=True,
        ),
        MethodCertaintyDomain(
            domain="publication_bias",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Selective publication and selective reporting among prognostic models require "
                "protocol, registry, and missing-estimate review."
            ),
            requires_human_judgment=True,
        ),
    ]
    domains = [
        MethodCertaintyDomain(
            domain="risk_of_bias",
            rating=risk_rating,
            rationale=(
                f"Completed result-level QUIPS assessments={len(judgments)}/"
                f"{len(synthesis.input_result_ids)}; judgments={judgments or ['missing']}."
            ),
            evidence={"completed_result_ids": sorted(completed)},
        ),
        *human_domains,
    ]
    return MethodCertaintyAssessment(
        status=MethodCertaintyStatus.NEEDS_INPUT,
        family=plan.family,
        framework="GRADE certainty for prognostic-factor evidence",
        framework_note=(
            "The draft starts at low certainty and complements, but does not replace, QUIPS. "
            "The pooled association is not a prediction model and not a randomized treatment effect."
        ),
        plan_fingerprint=plan.plan_fingerprint,
        input_result_ids=synthesis.input_result_ids,
        outcomes=[
            MethodCertaintyOutcome(
                outcome_id=estimate.estimate_id,
                outcome_label=estimate.label,
                starting_certainty="low",
                certainty="not_assessed",
                domains=domains,
            )
        ],
        next_actions=[
            NextAction(
                action_id=f"adjudicate_{domain.domain}",
                title=f"Adjudicate prognostic {domain.domain.replace('_', ' ')}",
                description=domain.rationale,
            )
            for domain in human_domains
        ],
    )


def _build_prediction_certainty(
    *, plan, synthesis, completed, judgments, risk_rating
) -> MethodCertaintyAssessment:
    estimate = synthesis.primary_estimates[0]
    if estimate.measure not in {"C_STATISTIC", "OE_RATIO", "CALIBRATION_SLOPE"}:
        raise ValueError(
            "released prediction certainty requires a C_STATISTIC, OE_RATIO, or "
            "CALIBRATION_SLOPE result"
        )
    is_oe = estimate.measure == "OE_RATIO"
    is_slope = estimate.measure == "CALIBRATION_SLOPE"
    human_domains = [
        MethodCertaintyDomain(
            domain="inconsistency",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                (
                    "Variation in calibration-in-the-large, baseline outcome risk, case mix, "
                    "and validation conduct must be interpreted for transportability."
                )
                if is_oe
                else (
                    "Variation in calibration slope, case mix, predictor effects, and validation "
                    "conduct must be interpreted for transportability."
                )
                if is_slope
                else (
                    "Variation in discrimination, case mix, outcome incidence, and validation "
                    "conduct must be interpreted for transportability."
                )
            ),
            evidence=synthesis.heterogeneity,
            requires_human_judgment=True,
        ),
        MethodCertaintyDomain(
            domain="indirectness",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Population, setting, exact model version, predictor measurement, outcome, and "
                "time horizon require applicability judgment."
            ),
            requires_human_judgment=True,
        ),
        MethodCertaintyDomain(
            domain="imprecision",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Confidence and prediction intervals must be judged against a prespecified "
                + (
                    "clinically acceptable departure from the ideal O:E ratio of 1 and intended use."
                    if is_oe
                    else (
                        "clinically acceptable departure from the ideal calibration slope of 1 "
                        "and intended use."
                    )
                    if is_slope
                    else "discrimination threshold and intended use."
                )
            ),
            evidence={
                "ci": [estimate.ci_lower, estimate.ci_upper],
                "prediction_interval": [estimate.prediction_lower, estimate.prediction_upper],
            },
            requires_human_judgment=True,
        ),
        MethodCertaintyDomain(
            domain="publication_bias",
            rating=CertaintyDomainRating.NOT_ASSESSED,
            rationale=(
                "Unpublished validations and selective reporting of favorable performance metrics "
                "require registry and missing-study review."
            ),
            requires_human_judgment=True,
        ),
    ]
    domains = [
        MethodCertaintyDomain(
            domain="risk_of_bias",
            rating=risk_rating,
            rationale=(
                f"Completed result-level PROBAST assessments={len(judgments)}/"
                f"{len(synthesis.input_result_ids)}; judgments={judgments or ['missing']}."
            ),
            evidence={"completed_result_ids": sorted(completed)},
        ),
        *human_domains,
        MethodCertaintyDomain(
            domain="performance_completeness",
            rating=CertaintyDomainRating.VERY_SERIOUS,
            rationale=(
                (
                    "Only calibration-in-the-large was synthesized. Calibration slope or curves, "
                    "discrimination, and clinical utility were not synthesized, so the result "
                    "cannot support a deployment recommendation."
                )
                if is_oe
                else (
                    "Only calibration slope was synthesized. Calibration-in-the-large, "
                    "discrimination, and clinical utility were not synthesized, so the result "
                    "cannot support a deployment recommendation."
                )
                if is_slope
                else (
                    "Only discrimination was synthesized. Calibration and clinical utility were "
                    "not synthesized, so the result cannot support a deployment recommendation."
                )
            ),
            evidence={"synthesized_metrics": [estimate.measure]},
        ),
    ]
    return MethodCertaintyAssessment(
        status=MethodCertaintyStatus.NEEDS_INPUT,
        family=plan.family,
        framework="PROBAST-informed certainty appraisal for prediction performance",
        framework_note=(
            "This transparent appraisal is not GRADE and is not a validated replacement for a "
            "prediction-model-specific certainty instrument. It separates bias, applicability, "
            "uncertainty, reporting bias, and performance completeness."
        ),
        plan_fingerprint=plan.plan_fingerprint,
        input_result_ids=synthesis.input_result_ids,
        outcomes=[
            MethodCertaintyOutcome(
                outcome_id=estimate.estimate_id,
                outcome_label=estimate.label,
                starting_certainty="low",
                certainty="not_assessed",
                domains=domains,
            )
        ],
        next_actions=[
            NextAction(
                action_id=f"adjudicate_{domain.domain}",
                title=f"Adjudicate prediction {domain.domain.replace('_', ' ')}",
                description=domain.rationale,
            )
            for domain in human_domains
        ],
    )


def save_method_certainty_adjudication(
    project,
    *,
    expected_revision: int,
    adjudicated_by: str,
    reason: str,
    domain_overrides: dict,
) -> MethodCertaintyAssessment:
    if not str(adjudicated_by or "").strip():
        raise ValueError("adjudicated_by is required")
    if not str(reason or "").strip():
        raise ValueError("adjudication reason is required")
    lock_path = project.get_path("method_certainty_adjudications.json.lock", subdir="analysis")
    with _locked(lock_path):
        current_payload = project.load_json("method_certainty.json", subdir="analysis")
        current = (
            MethodCertaintyAssessment.model_validate(current_payload)
            if current_payload
            else build_method_certainty_draft(project)
        )
        if current.revision != int(expected_revision):
            raise MethodCertaintyConflictError(
                f"stale method certainty revision: expected {expected_revision}, current {current.revision}"
            )
        multiple_outcomes = len(current.outcomes) > 1
        normalized_overrides = {}
        required = set()
        for outcome in current.outcomes:
            for domain in outcome.domains:
                key = _certainty_override_key(
                    outcome.outcome_id,
                    domain.domain,
                    multiple_outcomes,
                )
                if (
                    domain.requires_human_judgment
                    or domain.rating is CertaintyDomainRating.NOT_ASSESSED
                ):
                    required.add(key)
                override = domain_overrides.get(key)
                if override is None:
                    # A plain domain key intentionally applies the same decision to
                    # every network comparison; comparison-specific keys take priority.
                    override = domain_overrides.get(domain.domain)
                if override is not None:
                    normalized_overrides[key] = override
        if not required <= set(normalized_overrides):
            missing = sorted(required - set(normalized_overrides))
            raise ValueError(
                "certainty decisions are required for: " + ", ".join(missing)
            )
        outcomes = []
        for outcome in current.outcomes:
            domains = []
            for domain in outcome.domains:
                key = _certainty_override_key(
                    outcome.outcome_id,
                    domain.domain,
                    multiple_outcomes,
                )
                override = normalized_overrides.get(key)
                if not override:
                    domains.append(domain)
                    continue
                rating = CertaintyDomainRating(str(override.get("rating") or ""))
                rationale = str(override.get("rationale") or "").strip()
                if rating is CertaintyDomainRating.NOT_ASSESSED or not rationale:
                    raise ValueError(
                        f"completed {key} decision requires rating and rationale"
                    )
                domains.append(domain.model_copy(update={
                    "rating": rating,
                    "rationale": rationale,
                    "requires_human_judgment": False,
                }))
            if any(item.rating is CertaintyDomainRating.NOT_ASSESSED for item in domains):
                raise ValueError("all certainty domains must be assessed before completion")
            outcomes.append(outcome.model_copy(update={
                "certainty": _final_certainty(
                    domains,
                    starting_certainty=outcome.starting_certainty,
                ),
                "domains": domains,
            }))
        completed = current.model_copy(update={
            "revision": current.revision + 1,
            "status": MethodCertaintyStatus.COMPLETED,
            "outcomes": outcomes,
            "next_actions": [],
            "adjudicated_by": str(adjudicated_by).strip(),
            "adjudication_reason": str(reason).strip(),
        })
        manifest = project.load_json("method_certainty_adjudications.json", subdir="analysis") or {
            "schema_version": 1,
            "current_revision": 0,
            "history": [],
        }
        manifest["current_revision"] = completed.revision
        manifest.setdefault("history", []).append({
            "revision": completed.revision,
            "adjudicated_by": completed.adjudicated_by,
            "reason": completed.adjudication_reason,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "assessment": completed.model_dump(mode="json"),
        })
        project.save_json("method_certainty.json", completed, subdir="analysis")
        project.save_json("method_certainty_adjudications.json", manifest, subdir="analysis")
        return completed


def _risk_of_bias_rating(judgments: list[str], *, required: int) -> CertaintyDomainRating:
    if len(judgments) != required:
        return CertaintyDomainRating.NOT_ASSESSED
    lowered = " ".join(judgments).lower()
    if "high" in lowered:
        return CertaintyDomainRating.VERY_SERIOUS
    if "some concern" in lowered or "moderate" in lowered:
        return CertaintyDomainRating.SERIOUS
    return CertaintyDomainRating.NO_CONCERN


def _inconsistency_rating(synthesis) -> tuple[CertaintyDomainRating, str]:
    estimate = synthesis.primary_estimates[0]
    if estimate.prediction_lower is None or estimate.prediction_upper is None:
        return CertaintyDomainRating.NOT_ASSESSED, "A prediction interval was not estimable."
    width = estimate.prediction_upper - estimate.prediction_lower
    rating = (
        CertaintyDomainRating.VERY_SERIOUS if width > 0.75
        else CertaintyDomainRating.SERIOUS if width > 0.40
        else CertaintyDomainRating.NO_CONCERN
    )
    return rating, f"Prediction-interval width on the proportion scale={width:.4f}."


def _imprecision_rating(synthesis) -> tuple[CertaintyDomainRating, str]:
    estimate = synthesis.primary_estimates[0]
    if estimate.ci_lower is None or estimate.ci_upper is None:
        return CertaintyDomainRating.NOT_ASSESSED, "The confidence interval was not estimable."
    width = estimate.ci_upper - estimate.ci_lower
    total = int(synthesis.engine_payload.get("total_participants") or 0)
    rating = (
        CertaintyDomainRating.VERY_SERIOUS if width > 0.30 or total < 100
        else CertaintyDomainRating.SERIOUS if width > 0.15 or total < 300
        else CertaintyDomainRating.NO_CONCERN
    )
    return rating, f"Confidence-interval width={width:.4f}; total participants={total}."


def _final_certainty(
    domains: list[MethodCertaintyDomain], *, starting_certainty: str = "high"
) -> str:
    penalty = sum(
        2 if item.rating is CertaintyDomainRating.VERY_SERIOUS
        else 1 if item.rating is CertaintyDomainRating.SERIOUS
        else 0
        for item in domains
    )
    levels = {4: "high", 3: "moderate", 2: "low", 1: "very_low"}
    start = {value: key for key, value in levels.items()}.get(starting_certainty, 4)
    return levels[max(1, start - penalty)]


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
