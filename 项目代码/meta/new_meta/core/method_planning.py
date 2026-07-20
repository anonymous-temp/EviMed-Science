"""Compile and persist immutable project method plans from review protocols."""
from __future__ import annotations

import re

from new_meta.core.extraction_ledger import ensure_project_review_id
from new_meta.core.method_registry import MethodRegistry, default_method_registry
from new_meta.core.project import Project
from new_meta.schemas.method_policy import MethodPlan, ReviewDesignSpec, ReviewFamily
from new_meta.schemas.protocol import ResearchProtocol


class MethodCapabilityBlockedError(RuntimeError):
    def __init__(self, plan: MethodPlan):
        self.plan = plan
        reasons = "; ".join(plan.blocking_reasons) or "method capability is blocked"
        super().__init__(f"{plan.family.value} cannot execute: {reasons}")


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
            raise ValueError(f"Unknown review_family {explicit!r}") from exc

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
    family = infer_review_family(protocol)
    design_spec = ReviewDesignSpec(
        review_id=review_id,
        family=family,
        study_designs=_method_designs(protocol, family),
        outcome_type=_primary_outcome_type(protocol, family),
        requested_effect_measure=_effect_measure(protocol),
        requested_model=_model_preference(protocol),
        treatment_count=(len(protocol.interventions) or None),
        adjusted_estimates_required=family in {
            ReviewFamily.INTERVENTION_NRSI,
            ReviewFamily.PROGNOSTIC_FACTOR,
        },
        individual_participant_data=family is ReviewFamily.IPD_META,
        protocol_version=str(getattr(protocol, "protocol_version", "") or ""),
    )
    plan = registry.compile(design_spec, allow_validating=allow_validating)
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
        raise MethodCapabilityBlockedError(plan)
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
    normalized = re.sub(r"[^a-z0-9]+", "_", str(value).strip().lower()).strip("_")
    if family is ReviewFamily.DIAGNOSTIC_ACCURACY:
        if "cohort" in normalized:
            return "diagnostic_cohort"
        if "two_gate" in normalized or "case_control" in normalized:
            return "two_gate"
        return "diagnostic_cross_sectional"
    if family is ReviewFamily.PREDICTION_MODEL:
        if "validation" in normalized:
            return "prediction_validation"
        if "update" in normalized:
            return "prediction_update"
        return "prediction_development"
    if family is ReviewFamily.PROGNOSTIC_FACTOR:
        return "case_cohort" if "case" in normalized else "prognostic_cohort"
    if "cluster" in normalized:
        return "cluster_rct"
    if "cross" in normalized and "section" not in normalized:
        return "crossover_rct"
    if "multi" in normalized and "arm" in normalized:
        return "multi_arm_rct"
    if normalized == "rct" or any(
        marker in normalized
        for marker in ("randomized_controlled_trial", "randomised_controlled_trial")
    ):
        return "parallel_rct"
    mappings = {
        "case_control": "case_control",
        "cohort": "cohort",
        "cross_sectional": "cross_sectional",
        "registry": "registry",
        "surveillance": "surveillance",
        "controlled_before_after": "controlled_before_after",
        "interrupted_time_series": "interrupted_time_series",
        "regression_discontinuity": "regression_discontinuity",
        "instrumental_variable": "instrumental_variable",
    }
    for marker, mapped in mappings.items():
        if marker in normalized:
            return mapped
    return normalized or _default_design(family)


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
