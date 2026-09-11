"""Compile and persist immutable project method plans from review protocols."""
from __future__ import annotations

import re

from new_meta.core.extraction_ledger import ensure_project_review_id
from new_meta.core.method_registry import MethodCompilationError, MethodInputError, MethodRegistry, default_method_registry
from new_meta.core.project import Project
from new_meta.schemas.method_policy import MethodPlan, ReviewDesignSpec, ReviewFamily
from new_meta.schemas.protocol import ResearchProtocol


class ProtocolInputRequired(MethodCompilationError):
    """A preserved proposal that cannot become an executable review protocol."""

    def __init__(self, message, *, code="protocol_method_input_required", context=None,
                 protocol=None, project=None):
        from new_meta.schemas.phase_result import ExecutionStatus, NextAction, PhaseIssue, PhaseName, PhaseResult
        super().__init__(message)
        self.project = project
        self.phase = PhaseResult(
            run_id=project.base_dir.name if project else "protocol-planning",
            phase=PhaseName.PROTOCOL, status=ExecutionStatus.NEEDS_INPUT,
            summary=message, error_code=code,
            issues=[PhaseIssue(code=code, message=message, blocking=True, context=context or {})],
            next_actions=[NextAction(action_id="restart_with_supported_protocol",
                title="Clarify the research question and restart with supported, scope-faithful inputs.",
                description="Preserve the original population, intervention, comparator, outcome and eligibility intent; do not silently remove unsupported requirements.")],
            data={"proposal": protocol.model_dump(mode="json") if protocol else {}},
        )
        if project:
            self.persist(project)

    def persist(self, project):
        self.project = project
        self.phase.run_id = project.base_dir.name
        self.phase.data["original_question_path"] = project.TOPIC_FILE
        original_present = False
        try:
            import json
            from new_meta.core.primary_analysis_alignment import _read_scoped
            original = json.loads(_read_scoped(project, project.TOPIC_FILE, max_bytes=1024 * 1024))
            if isinstance(original.get("topic"), str):
                self.phase.data["original_question"] = original["topic"]
                original_present = True
        except (OSError, ValueError, TypeError, AttributeError):
            pass  # Preserve the explicit original-missing diagnostic without inventing a topic.
        from new_meta.core.primary_analysis_alignment import _write_scoped_atomic
        _write_scoped_atomic(project, "analysis/protocol_input_status.json", self.phase.model_dump_json(indent=2).encode())
        _write_scoped_atomic(project, "analysis/protocol_rejected_proposal.json", json.dumps(self.phase.data, ensure_ascii=False, indent=2).encode())
        if original_present:
            project.clear_downstream("protocol", include_self=True)
        return self


def method_catalogue(registry=None) -> dict:
    """Expose compiler-owned vocabulary; this is not a production capability promise."""
    registry = registry or default_method_registry()
    return {family.value: {
        "study_designs": registry.plugin(family).supported_designs,
        "outcome_types": registry.plugin(family).supported_outcome_types,
        "effect_measures": registry.plugin(family).supported_effect_measures,
    } for family in registry.families()}


def protocol_design_spec(protocol, review_id="protocol-planning"):
    family = infer_review_family(protocol)
    return ReviewDesignSpec(
        review_id=review_id, family=family,
        study_designs=_method_designs(protocol, family),
        outcome_type=_primary_outcome_type(protocol, family),
        requested_effect_measure=_effect_measure(protocol),
        requested_model=_model_preference(protocol),
        treatment_count=(len(protocol.interventions) or None),
        adjusted_estimates_required=family in {ReviewFamily.INTERVENTION_NRSI, ReviewFamily.PROGNOSTIC_FACTOR},
        individual_participant_data=family is ReviewFamily.IPD_META,
        protocol_version=str(getattr(protocol, "protocol_version", "") or ""),
    )


def validate_protocol_method(protocol, registry=None):
    registry = registry or default_method_registry()
    try:
        return registry.compile(protocol_design_spec(protocol))
    except MethodInputError as exc:
        raise ProtocolInputRequired(str(exc), context=exc.context, protocol=protocol) from exc


class MethodCapabilityBlockedError(RuntimeError):
    """The requested method scope is outside the validated capability set.

    This is a release decision — "the narrower production scope is X" — not a
    crash. It carries the project so the entry point can write
    release_decision.json and exit 2 the way ReleaseBlockedError does; before
    that, it exited 1 and the narrower scope was lost in a 2 kB log tail.
    """

    def __init__(self, plan: MethodPlan, project: "Project | None" = None):
        self.plan = plan
        self.project = project
        reasons = "; ".join(plan.blocking_reasons) or "method capability is blocked"
        super().__init__(f"{plan.family.value} cannot execute: {reasons}")

    def release_decision(self) -> dict:
        """The terminal decision this blocked scope amounts to."""
        return {
            "status": "blocked",
            "blocker_codes": list(self.plan.blocking_reasons) or ["method_capability_blocked"],
            "blocking_reasons": list(self.plan.blocking_reasons),
            "narrower_capability": {
                "family": self.plan.family.value,
                "capability_id": self.plan.capability_id,
                "capability_status": self.plan.capability_status.value,
                "study_designs": list(self.plan.study_designs),
                "outcome_type": self.plan.outcome_type,
                "effect_measure": self.plan.effect_measure,
            },
            "next_actions": [
                "Narrow the review to a capability marked production in "
                "validation/capability_manifest.json, or run it as an explicitly "
                "labelled validation run.",
            ],
        }


def infer_review_family(protocol: ResearchProtocol) -> ReviewFamily:
    explicit = str(getattr(protocol, "review_family", "") or "").strip().lower()
    if _is_generic_review_label(explicit):
        # Some planners populate review_family with the umbrella deliverable
        # ("systematic review with meta-analysis") rather than a method family.
        # Infer the validated family from design/outcome fields below instead.
        explicit = ""
    if explicit:
        aliases = {
            "therapeutic": ReviewFamily.INTERVENTION_RCT,
            "therapy": ReviewFamily.INTERVENTION_RCT,
            "treatment": ReviewFamily.INTERVENTION_RCT,
            "intervention": ReviewFamily.INTERVENTION_RCT,
            "rct": ReviewFamily.INTERVENTION_RCT,
            "randomized": ReviewFamily.INTERVENTION_RCT,
            "randomised": ReviewFamily.INTERVENTION_RCT,
            "observational": ReviewFamily.INTERVENTION_NRSI,
            "nrsi": ReviewFamily.INTERVENTION_NRSI,
            "diagnostic": ReviewFamily.DIAGNOSTIC_ACCURACY,
            "prevalence": ReviewFamily.PREVALENCE_INCIDENCE,
            "incidence": ReviewFamily.PREVALENCE_INCIDENCE,
            "prognostic": ReviewFamily.PROGNOSTIC_FACTOR,
            "prediction": ReviewFamily.PREDICTION_MODEL,
            "network": ReviewFamily.NETWORK_META,
            "nma": ReviewFamily.NETWORK_META,
            "dose-response": ReviewFamily.DOSE_RESPONSE,
            "narrative": ReviewFamily.NARRATIVE_SYNTHESIS,
        }
        if explicit in aliases:
            return aliases[explicit]
        normalized = re.sub(r"[^a-z0-9]+", "_", explicit).strip("_")
        semantic_aliases = (
            (("network", "nma"), ReviewFamily.NETWORK_META),
            (("individual_participant", "ipd"), ReviewFamily.IPD_META),
            (("diagnostic",), ReviewFamily.DIAGNOSTIC_ACCURACY),
            (("prevalence", "incidence"), ReviewFamily.PREVALENCE_INCIDENCE),
            (("prognostic", "prognosis"), ReviewFamily.PROGNOSTIC_FACTOR),
            (("prediction", "predictive"), ReviewFamily.PREDICTION_MODEL),
            (("dose_response",), ReviewFamily.DOSE_RESPONSE),
            (("narrative",), ReviewFamily.NARRATIVE_SYNTHESIS),
            (("observational", "non_random", "nrsi"), ReviewFamily.INTERVENTION_NRSI),
            (
                (
                    "therapeutic",
                    "therapy",
                    "treatment",
                    "intervention",
                    "efficacy",
                    "effectiveness",
                    "clinical_trial",
                    "controlled_trial",
                    "randomized",
                    "randomised",
                    "rct",
                ),
                ReviewFamily.INTERVENTION_RCT,
            ),
        )
        for markers, family in semantic_aliases:
            if any(marker in normalized for marker in markers):
                return family
        try:
            return ReviewFamily(explicit)
        except ValueError as exc:
            raise MethodInputError(f"Unknown review_family {explicit!r}", field="review_family", requested=explicit, supported=[item.value for item in ReviewFamily]) from exc

    analysis_type = str(getattr(protocol, "analysis_type", "") or "").strip().lower()
    effect_measure = str(getattr(protocol, "effect_measure", "") or "").strip().upper()
    design_text = " ".join(
        [str(getattr(protocol, "study_design", "") or ""), *getattr(protocol, "study_designs", [])]
    ).lower()
    question = str(getattr(protocol, "research_question", "") or "").lower()
    if analysis_type == "network":
        return ReviewFamily.NETWORK_META
    if effect_measure in {"SENS_SPEC", "DOR", "LR_POS", "LR_NEG"} or "diagnostic accuracy" in question:
        return ReviewFamily.DIAGNOSTIC_ACCURACY
    if effect_measure in {"PROP", "IR"}:
        return ReviewFamily.PREVALENCE_INCIDENCE
    if effect_measure in {"C_STATISTIC", "OE_RATIO", "CALIBRATION_SLOPE", "BRIER"}:
        return ReviewFamily.PREDICTION_MODEL
    if "dose response" in question or "dose-response" in question:
        return ReviewFamily.DOSE_RESPONSE
    if "prognos" in question or "prognostic" in design_text:
        return ReviewFamily.PROGNOSTIC_FACTOR
    if re.search(r"cohort|case[- ]?control|observational|non[- ]?random|cross[- ]?sectional|registry", design_text):
        return ReviewFamily.INTERVENTION_NRSI
    return ReviewFamily.INTERVENTION_RCT


def _is_generic_review_label(value: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]+", "_", str(value or "").lower()).strip("_")
    tokens = {token for token in normalized.split("_") if token}
    umbrella_tokens = {
        "and",
        "conventional",
        "evidence",
        "literature",
        "meta",
        "analysis",
        "pairwise",
        "quantitative",
        "review",
        "synthesis",
        "systematic",
        "traditional",
        "with",
    }
    return bool(tokens) and tokens <= umbrella_tokens and bool(
        tokens & {"review", "meta", "synthesis"}
    )


def compile_project_method_plan(
    project: Project,
    protocol: ResearchProtocol,
    *,
    registry: MethodRegistry | None = None,
    allow_validating: bool = False,
    enforce: bool = False,
) -> MethodPlan:
    registry = registry or default_method_registry()
    review_id = ensure_project_review_id(project)
    try:
        design_spec = protocol_design_spec(protocol, review_id)
        plan = registry.compile(design_spec, allow_validating=allow_validating)
    except MethodInputError as exc:
        raise ProtocolInputRequired(str(exc), context=exc.context, protocol=protocol, project=project) from exc
    family = design_spec.family
    plugin = registry.plugin(family, policy_version=plan.policy_version)
    project.save_json("method_plan.json", plan, subdir="analysis")
    project.save_json(
        "method_policy_snapshot.json",
        {
            "schema_version": 1,
            "plan_fingerprint": plan.plan_fingerprint,
            "design_spec": design_spec.model_dump(mode="json"),
            "plugin": plugin.model_dump(mode="json"),
        },
        subdir="analysis",
    )
    if plan.validation_manifest_fingerprint:
        from new_meta.core.method_validation import load_default_validation_manifest

        validation_manifest = load_default_validation_manifest()
        capability = validation_manifest.capability(plan.capability_id)
        project.save_json(
            "method_validation_snapshot.json",
            {
                "schema_version": 1,
                "manifest_version": validation_manifest.manifest_version,
                "manifest_fingerprint": validation_manifest.manifest_fingerprint,
                "capability": capability.model_dump(mode="json"),
            },
            subdir="analysis",
        )
    from new_meta.core.synthesis_routing import persist_synthesis_route

    persist_synthesis_route(project, plan)
    if enforce and not plan.execution_allowed:
        raise MethodCapabilityBlockedError(plan, project)
    return plan


def admit_project_protocol(project, protocol, **kwargs):
    """Application boundary: validate vocabulary and original scope before persistence."""
    from new_meta.core.protocol_scope import ensure_project_protocol_scope
    try:
        validate_protocol_method(protocol, registry=kwargs.get("registry"))
        ensure_project_protocol_scope(project, protocol)
    except ProtocolInputRequired as exc:
        raise exc.persist(project)
    plan = compile_project_method_plan(project, protocol, **kwargs)
    # Resolve this phase only; retain the rejected proposal and other phase issues.
    from new_meta.core.primary_analysis_alignment import _read_scoped, _write_scoped_atomic
    try:
        import json
        previous = json.loads(_read_scoped(project, "analysis/protocol_input_status.json", max_bytes=4 * 1024 * 1024))
    except (OSError, ValueError):
        previous = None
    if isinstance(previous, dict) and previous.get("status") == "needs_input":
        from new_meta.schemas.phase_result import ExecutionStatus, PhaseName, PhaseResult
        resolved = PhaseResult(run_id=project.base_dir.name, phase=PhaseName.PROTOCOL,
            status=ExecutionStatus.SUCCEEDED, summary="The corrected protocol passed method and original-scope admission.")
        _write_scoped_atomic(project, "analysis/protocol_input_status.json", resolved.model_dump_json(indent=2).encode())
    return plan


def normalize_protocol_method_fields(protocol: ResearchProtocol) -> ResearchProtocol:
    """Canonicalize planner-authored method fields before persistence/execution."""
    family = infer_review_family(protocol)
    protocol.review_family = family.value
    protocol.effect_measure = _effect_measure(protocol)
    protocol.model_preference = _model_preference(protocol)
    protocol.primary_outcome_type = _primary_outcome_type(protocol, family)
    return protocol


def _method_designs(protocol: ResearchProtocol, family: ReviewFamily) -> list[str]:
    raw_designs = list(protocol.study_designs or []) or [protocol.study_design or ""]
    mapped = {_map_design(value, family) for value in raw_designs if str(value).strip()}
    if not mapped:
        mapped = {_default_design(family)}
    return sorted(mapped)


def _map_design(value: str, family: ReviewFamily) -> str:
    """Normalize exact legacy aliases, never infer a design from a substring."""
    normalized = re.sub(r"[^a-z0-9]+", "_", str(value).strip().lower()).strip("_")
    aliases = {
        "rct": "parallel_rct", "rcts": "parallel_rct",
        "randomized_controlled_trial": "parallel_rct", "randomized_controlled_trials": "parallel_rct",
        "randomised_controlled_trial": "parallel_rct", "randomised_controlled_trials": "parallel_rct",
        "randomized_controlled_trial_rct": "parallel_rct", "randomized_controlled_trials_rcts": "parallel_rct",
        "randomised_controlled_trial_rct": "parallel_rct", "randomised_controlled_trials_rcts": "parallel_rct",
        "parallel_group_rct": "parallel_rct", "parallel_randomized_controlled_trial": "parallel_rct",
        "cluster_randomized_trial": "cluster_rct", "cluster_randomised_trial": "cluster_rct",
        "cluster_randomized_controlled_trial": "cluster_rct", "cluster_randomised_controlled_trial": "cluster_rct",
        "crossover_randomized_trial": "crossover_rct", "cross_over_rct": "crossover_rct",
        "multiarm_rct": "multi_arm_rct", "multi_arm_randomized_trial": "multi_arm_rct",
        "cohort_study": "cohort", "cohort_studies": "cohort",
        "case_control_study": "case_control", "cross_sectional_study": "cross_sectional",
    }
    family_aliases = {
        ReviewFamily.DIAGNOSTIC_ACCURACY: {"cohort": "diagnostic_cohort", "cross_sectional": "diagnostic_cross_sectional", "case_control": "two_gate"},
        ReviewFamily.PREDICTION_MODEL: {"external_validation": "prediction_validation", "validation": "prediction_validation", "development": "prediction_development", "model_update": "prediction_update"},
        ReviewFamily.PROGNOSTIC_FACTOR: {"cohort": "prognostic_cohort"},
    }
    normalized = aliases.get(normalized, normalized)
    return family_aliases.get(family, {}).get(normalized, normalized)


def _default_design(family: ReviewFamily) -> str:
    return {
        ReviewFamily.INTERVENTION_RCT: "parallel_rct",
        ReviewFamily.INTERVENTION_NRSI: "cohort",
        ReviewFamily.PREVALENCE_INCIDENCE: "cross_sectional",
        ReviewFamily.DIAGNOSTIC_ACCURACY: "diagnostic_cross_sectional",
        ReviewFamily.PROGNOSTIC_FACTOR: "prognostic_cohort",
        ReviewFamily.PREDICTION_MODEL: "prediction_validation",
        ReviewFamily.NETWORK_META: "parallel_rct",
        ReviewFamily.IPD_META: "parallel_rct",
        ReviewFamily.DOSE_RESPONSE: "cohort",
        ReviewFamily.NARRATIVE_SYNTHESIS: "any",
    }[family]


def _primary_outcome_type(protocol: ResearchProtocol, family: ReviewFamily) -> str:
    explicit = str(getattr(protocol, "primary_outcome_type", "") or "").strip().lower()
    if explicit:
        normalized = re.sub(r"[^a-z0-9]+", "_", explicit).strip("_")
        aliases = {
            "binary": "dichotomous",
            "categorical": "dichotomous",
            "survival": "time_to_event",
            "time_event": "time_to_event",
            "incidence": "incidence_rate",
            "overall": "overall_performance",
        }
        return aliases.get(normalized, normalized)
    measure = _effect_measure(protocol)
    if family is ReviewFamily.DIAGNOSTIC_ACCURACY:
        return "diagnostic_accuracy"
    if family is ReviewFamily.PREDICTION_MODEL:
        return {
            "C_STATISTIC": "discrimination",
            "OE_RATIO": "calibration",
            "CALIBRATION_SLOPE": "calibration",
            "BRIER": "overall_performance",
        }.get(measure, "discrimination")
    return {
        "OR": "dichotomous",
        "RR": "dichotomous",
        "RD": "dichotomous",
        "MD": "continuous",
        "SMD": "continuous",
        "HR": "time_to_event",
        "IRR": "count",
        "PROP": "proportion",
        "IR": "incidence_rate",
        "NONE": "any",
    }.get(measure, "dichotomous")


def _effect_measure(protocol: ResearchProtocol) -> str:
    raw = str(protocol.effect_measure or "NONE").strip().upper()
    normalized = re.sub(r"[^A-Z0-9]+", "_", raw).strip("_")
    aliases = {
        "ODDS_RATIO": "OR",
        "RISK_RATIO": "RR",
        "RELATIVE_RISK": "RR",
        "RISK_DIFFERENCE": "RD",
        "MEAN_DIFFERENCE": "MD",
        "STANDARDIZED_MEAN_DIFFERENCE": "SMD",
        "STANDARDISED_MEAN_DIFFERENCE": "SMD",
        "HAZARD_RATIO": "HR",
        "INCIDENCE_RATE_RATIO": "IRR",
        "PROPORTION": "PROP",
        "CORRELATION": "COR",
    }
    return aliases.get(normalized, normalized)


def _model_preference(protocol: ResearchProtocol) -> str:
    raw = re.sub(r"[^a-z0-9]+", "_", str(protocol.model_preference or "").strip().lower())
    if "random" in raw:
        return "random"
    if "fixed" in raw:
        return "fixed"
    return raw.strip("_")
