"""Deterministic registry and compiler for review-family method policies."""
from __future__ import annotations

import hashlib
import json
from typing import Iterable

from new_meta.schemas.method_policy import (
    CapabilityStatus,
    MethodPlan,
    MethodPlugin,
    ReviewDesignSpec,
    ReviewFamily,
)


class MethodCompilationError(ValueError):
    pass


class MethodRegistry:
    def __init__(self, plugins: Iterable[MethodPlugin] | None = None, *, validation_manifest=None):
        self._plugins: dict[tuple[ReviewFamily, str], MethodPlugin] = {}
        self._active_versions: dict[ReviewFamily, str] = {}
        self._validation_manifest = validation_manifest
        for plugin in plugins or []:
            self.register(plugin)

    def register(self, plugin: MethodPlugin, *, activate: bool = True) -> None:
        key = (plugin.family, plugin.policy_version)
        if key in self._plugins:
            raise ValueError(
                f"method plugin {plugin.family.value}@{plugin.policy_version} is already registered"
            )
        self._plugins[key] = plugin
        if activate:
            self._active_versions[plugin.family] = plugin.policy_version

    def families(self) -> list[ReviewFamily]:
        return sorted(self._active_versions, key=lambda family: family.value)

    def plugin(
        self,
        family: ReviewFamily,
        *,
        policy_version: str | None = None,
    ) -> MethodPlugin:
        version = policy_version or self._active_versions.get(family)
        if not version or (family, version) not in self._plugins:
            raise MethodCompilationError(f"no method plugin registered for {family.value}")
        return self._plugins[(family, version)]

    def compile(
        self,
        spec: ReviewDesignSpec,
        *,
        policy_version: str | None = None,
        allow_validating: bool = False,
    ) -> MethodPlan:
        plugin = self.plugin(spec.family, policy_version=policy_version)
        unsupported_designs = sorted(
            set(spec.study_designs) - set(plugin.supported_designs)
        ) if "any" not in plugin.supported_designs else []
        if unsupported_designs:
            raise MethodCompilationError(
                f"study design(s) not supported by {spec.family.value}: "
                + ", ".join(unsupported_designs)
            )
        if (
            "any" not in plugin.supported_outcome_types
            and spec.outcome_type not in plugin.supported_outcome_types
        ):
            raise MethodCompilationError(
                f"outcome type {spec.outcome_type!r} is not supported by {spec.family.value}"
            )
        if spec.requested_effect_measure not in plugin.supported_effect_measures:
            raise MethodCompilationError(
                f"effect measure {spec.requested_effect_measure!r} is not supported by "
                f"{spec.family.value}"
            )

        estimator_key = spec.requested_model or spec.outcome_type
        primary_estimator = (
            plugin.primary_estimators.get(estimator_key)
            or plugin.primary_estimators.get(spec.requested_effect_measure)
            or plugin.primary_estimators.get(spec.outcome_type)
            or plugin.primary_estimators.get("default")
        )
        if not primary_estimator:
            raise MethodCompilationError(
                f"no primary estimator for model/outcome {estimator_key!r} in {spec.family.value}"
            )

        capability = self._validation_manifest.resolve(spec) if self._validation_manifest else None
        capability_status = capability.release_status if capability else plugin.capability_status
        blocking_reasons: list[str] = []
        if capability_status is CapabilityStatus.BLOCKED:
            blocking_reasons.append(
                plugin.blocking_reason
                or f"{spec.family.value} has not passed production validation"
            )
        elif capability_status is CapabilityStatus.VALIDATING and not allow_validating:
            blocking_reasons.append(
                f"{(capability.capability_id if capability else spec.family.value)} is still "
                "validating; enable only in a controlled validation run"
            )

        fingerprint_payload = {
            "spec": spec.model_dump(mode="json"),
            "plugin": plugin.model_dump(mode="json"),
            "primary_estimator": primary_estimator,
        }
        fingerprint = hashlib.sha256(
            json.dumps(
                fingerprint_payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        return MethodPlan(
            review_id=spec.review_id,
            family=spec.family,
            policy_version=plugin.policy_version,
            capability_status=capability_status,
            plan_fingerprint=fingerprint,
            protocol_version=spec.protocol_version,
            study_designs=spec.study_designs,
            outcome_type=spec.outcome_type,
            effect_measure=spec.requested_effect_measure,
            primary_estimator=primary_estimator,
            sensitivity_estimators=plugin.sensitivity_estimators,
            required_diagnostics=plugin.required_diagnostics,
            hard_gates=plugin.hard_gates,
            risk_of_bias_tool=plugin.risk_of_bias_tool,
            certainty_framework=plugin.certainty_framework,
            reporting_guidelines=plugin.reporting_guidelines,
            engine_entrypoint=plugin.engine_entrypoint,
            validation_reference=plugin.validation_reference,
            capability_id=capability.capability_id if capability else spec.family.value,
            validation_manifest_fingerprint=(
                self._validation_manifest.manifest_fingerprint
                if self._validation_manifest and capability
                else ""
            ),
            validation_evidence_ids=(
                [item.evidence_id for item in capability.evidence] if capability else []
            ),
            execution_allowed=not blocking_reasons,
            blocking_reasons=blocking_reasons,
        )


def default_method_registry() -> MethodRegistry:
    """Return the complete target policy catalog with honest validation states."""
    from new_meta.core.method_validation import load_default_validation_manifest

    return MethodRegistry([
        MethodPlugin(
            family=ReviewFamily.INTERVENTION_RCT,
            policy_version="2026.1",
            capability_status=CapabilityStatus.VALIDATING,
            supported_designs=["parallel_rct", "cluster_rct", "crossover_rct", "multi_arm_rct"],
            supported_outcome_types=["dichotomous", "continuous", "time_to_event", "count"],
            supported_effect_measures=["OR", "RR", "RD", "MD", "SMD", "HR", "IRR"],
            primary_estimators={"fixed": "INVERSE_VARIANCE_FIXED", "random": "REML", "default": "REML"},
            sensitivity_estimators=["HKSJ", "PAULE_MANDEL", "FIXED_EFFECT"],
            required_diagnostics=[
                "heterogeneity", "prediction_interval", "leave_one_out",
                "cluster_design_adjustment", "crossover_correlation",
                "multi_arm_covariance", "small_study_effects_when_k_ge_10",
            ],
            hard_gates=["verified_result_sources", "result_specific_rob2", "design_adjustment_complete"],
            risk_of_bias_tool="RoB 2",
            certainty_framework="GRADE",
            reporting_guidelines=["PRISMA 2020", "PRISMA-S", "PRISMA-Harms"],
            engine_entrypoint="new_meta.engines.complex_rct:run_complex_rct",
            validation_reference="metafor REML and design-dependency policy fixtures",
            blocking_reason="The requested RCT design has not passed design-specific launch validation.",
        ),
        MethodPlugin(
            family=ReviewFamily.INTERVENTION_NRSI,
            policy_version="2026.1",
            capability_status=CapabilityStatus.VALIDATING,
            supported_designs=[
                "cohort", "case_control", "controlled_before_after",
                "interrupted_time_series", "regression_discontinuity", "instrumental_variable",
            ],
            supported_outcome_types=["dichotomous", "continuous", "time_to_event", "count"],
            supported_effect_measures=["OR", "RR", "RD", "MD", "SMD", "HR", "IRR"],
            primary_estimators={"default": "REML_ADJUSTED_EFFECTS"},
            sensitivity_estimators=["HKSJ", "ROBUST_VARIANCE", "DESIGN_STRATIFIED"],
            required_diagnostics=["confounding_domains", "adjustment_set_compatibility", "design_heterogeneity"],
            hard_gates=["adjusted_estimates", "robins_i_result_level", "no_rct_nrsi_pooling"],
            risk_of_bias_tool="ROBINS-I",
            certainty_framework="GRADE",
            reporting_guidelines=["PRISMA 2020", "PRISMA-S", "MOOSE"],
            engine_entrypoint="new_meta.engines.adjusted_effects:run_adjusted_effects",
            validation_reference="ROBINS-I adjudicated NRSI corpus and metafor fixtures",
            blocking_reason=(
                "Adjusted-estimate REML is implemented; external NRSI launch validation and "
                "design-specific confounding benchmarks remain incomplete."
            ),
        ),
        MethodPlugin(
            family=ReviewFamily.PREVALENCE_INCIDENCE,
            policy_version="2026.1",
            capability_status=CapabilityStatus.VALIDATING,
            supported_designs=["cross_sectional", "cohort", "registry", "surveillance"],
            supported_outcome_types=["proportion", "incidence_rate"],
            supported_effect_measures=["PROP", "IR"],
            primary_estimators={"proportion": "GLMM_LOGIT", "incidence_rate": "GLMM_POISSON", "default": "GLMM_LOGIT"},
            sensitivity_estimators=["BETA_BINOMIAL", "FREEMAN_TUKEY_SENSITIVITY_ONLY"],
            required_diagnostics=["zero_all_event_handling", "sampling_frame", "time_unit_harmonization"],
            hard_gates=["valid_denominators", "population_sampling_assessment"],
            risk_of_bias_tool="JBI prevalence/incidence appraisal",
            certainty_framework="GRADE adapted for prevalence",
            reporting_guidelines=["PRISMA 2020", "PRISMA-S"],
            engine_entrypoint="new_meta.engines.prevalence:run_prevalence",
            validation_reference="metafor PLO/IRLN GLMM reference fixtures",
            blocking_reason=(
                "Only separately validated binomial-normal prevalence and Poisson-normal "
                "incidence capabilities may execute."
            ),
        ),
        MethodPlugin(
            family=ReviewFamily.DIAGNOSTIC_ACCURACY,
            policy_version="2026.1",
            capability_status=CapabilityStatus.BLOCKED,
            supported_designs=["diagnostic_cross_sectional", "diagnostic_cohort", "two_gate"],
            supported_outcome_types=["diagnostic_accuracy"],
            supported_effect_measures=["SENS_SPEC", "DOR", "LR_POS", "LR_NEG"],
            primary_estimators={"default": "REITSMA_BIVARIATE_REML"},
            sensitivity_estimators=["COMMON_THRESHOLD_LOW_RISK_ONLY"],
            required_diagnostics=["threshold_effect", "reference_standard", "paired_test_comparison"],
            hard_gates=[
                "two_by_two_data",
                "quadas2_complete",
                "common_threshold_recorded",
            ],
            risk_of_bias_tool="QUADAS-2",
            certainty_framework="GRADE for diagnostic tests",
            reporting_guidelines=["PRISMA-DTA", "PRISMA-S"],
            engine_entrypoint="new_meta.engines.dta:run_diagnostic_accuracy",
            validation_reference="mada AuditC Reitsma REML and threshold fail-closed fixtures",
            blocking_reason=(
                "Only the common-threshold aggregate-2x2 Reitsma REML capability has passed "
                "launch validation; two-gate and multiple-threshold designs remain blocked."
            ),
        ),
        MethodPlugin(
            family=ReviewFamily.PROGNOSTIC_FACTOR,
            policy_version="2026.1",
            capability_status=CapabilityStatus.BLOCKED,
            supported_designs=["prognostic_cohort", "case_cohort"],
            supported_outcome_types=["dichotomous", "continuous", "time_to_event"],
            supported_effect_measures=["OR", "RR", "HR", "MD", "SMD"],
            primary_estimators={"default": "REML_ADJUSTED_ASSOCIATIONS"},
            sensitivity_estimators=["HKSJ", "ADJUSTMENT_SET_STRATIFIED"],
            required_diagnostics=["adjustment_set_compatibility", "nonlinearity", "time_horizon"],
            hard_gates=["adjusted_estimates", "quips_complete"],
            risk_of_bias_tool="QUIPS",
            certainty_framework="GRADE for prognostic factors",
            reporting_guidelines=["PRISMA 2020", "PRISMA-S"],
            engine_entrypoint="new_meta.engines.adjusted_effects:run_adjusted_effects",
            validation_reference="metafor reported-effect REML and adjusted-estimand policy fixtures",
            blocking_reason=(
                "Only adjusted ratio estimates from prognostic cohorts at one recorded horizon "
                "have passed launch validation."
            ),
        ),
        MethodPlugin(
            family=ReviewFamily.PREDICTION_MODEL,
            policy_version="2026.1",
            capability_status=CapabilityStatus.BLOCKED,
            supported_designs=["prediction_development", "prediction_validation", "prediction_update"],
            supported_outcome_types=["discrimination", "calibration", "overall_performance"],
            supported_effect_measures=["C_STATISTIC", "OE_RATIO", "CALIBRATION_SLOPE", "BRIER"],
            primary_estimators={
                "C_STATISTIC": "VALMETA_CSTAT_REML_HKSJ",
                "OE_RATIO": "VALMETA_OE_REML_HKSJ",
                "CALIBRATION_SLOPE": "CALIBRATION_SLOPE_REML_HKSJ",
                "discrimination": "VALMETA_CSTAT_REML_HKSJ",
                "calibration": "VALMETA_OE_REML_HKSJ",
                "default": "METRIC_SPECIFIC_RANDOM_EFFECTS",
            },
            sensitivity_estimators=["LOW_RISK_ONLY", "REPORTED_PRECISION_ONLY"],
            required_diagnostics=["calibration_discrimination_joint", "case_mix", "model_version_linkage"],
            hard_gates=[
                "probast_complete", "model_identity_and_version_verified",
                "external_validation_only", "common_outcome_and_horizon",
            ],
            risk_of_bias_tool="PROBAST",
            certainty_framework="GRADE adapted for prediction models",
            reporting_guidelines=["PRISMA 2020", "TRIPOD-SRMA"],
            engine_entrypoint="new_meta.engines.prediction_performance:run_prediction_performance",
            validation_reference="metamisc EuroSCORE valmeta and model-identity fixtures",
            blocking_reason=(
                "Only external-validation c-statistic, O:E, and calibration-slope synthesis "
                "for one exact model version have passed launch validation."
            ),
        ),
        MethodPlugin(
            family=ReviewFamily.NETWORK_META,
            policy_version="2026.1",
            capability_status=CapabilityStatus.BLOCKED,
            supported_designs=["parallel_rct", "multi_arm_rct", "cluster_rct"],
            supported_outcome_types=["dichotomous", "continuous", "time_to_event"],
            supported_effect_measures=["OR", "RR", "MD", "SMD", "HR"],
            primary_estimators={"default": "RANDOM_EFFECTS_NMA"},
            sensitivity_estimators=["FIXED_EFFECT_NMA", "BIAS_ADJUSTED_NMA"],
            required_diagnostics=[
                "network_connectivity", "multi_arm_covariance", "transitivity",
                "design_by_treatment_inconsistency", "node_splitting",
                "ranking_uncertainty", "outcome_direction",
            ],
            hard_gates=["connected_network", "transitivity_assessed", "multi_arm_handled"],
            risk_of_bias_tool="RoB 2 / ROBINS-I by result",
            certainty_framework="GRADE/CINeMA",
            reporting_guidelines=["PRISMA-NMA", "PRISMA-S"],
            engine_entrypoint="new_meta.engines.nma:run_network_meta",
            validation_reference="netmeta REML, design-by-treatment, and multi-arm covariance oracles",
            blocking_reason="The requested network structure has not passed production validation.",
        ),
        MethodPlugin(
            family=ReviewFamily.IPD_META,
            policy_version="2026.1",
            capability_status=CapabilityStatus.VALIDATING,
            supported_designs=["parallel_rct"],
            supported_outcome_types=["dichotomous", "binary", "continuous", "time_to_event"],
            supported_effect_measures=["OR", "MD", "HR"],
            primary_estimators={"default": "TWO_STAGE_IPD_REML_HKSJ"},
            sensitivity_estimators=["ONE_STAGE_COMMON_EFFECT", "HKSJ"],
            required_diagnostics=[
                "participant_clustering", "missing_data", "treatment_covariate_interaction",
                "one_stage_sensitivity",
            ],
            hard_gates=[
                "typed_participant_rows", "complete_required_model_data",
                "both_randomized_arms_per_study", "within_study_modifier_centering",
            ],
            risk_of_bias_tool="RoB 2",
            certainty_framework="GRADE",
            reporting_guidelines=["PRISMA-IPD", "PRISMA-S"],
            engine_entrypoint="new_meta.engines.ipd:run_ipd_meta",
            validation_reference="R glm/lm/coxph plus metafor REML deterministic IPD oracles",
            blocking_reason="The requested participant-level design has not passed production validation.",
        ),
        MethodPlugin(
            family=ReviewFamily.DOSE_RESPONSE,
            policy_version="2026.1",
            capability_status=CapabilityStatus.BLOCKED,
            supported_designs=["cohort", "case_control", "parallel_rct"],
            supported_outcome_types=["dichotomous", "continuous", "time_to_event"],
            supported_effect_measures=["OR", "RR", "HR", "MD"],
            primary_estimators={"default": "TWO_STAGE_RESTRICTED_CUBIC_SPLINE"},
            sensitivity_estimators=["ONE_STAGE", "LINEAR_TREND"],
            required_diagnostics=["dose_harmonization", "reference_category", "within_study_covariance"],
            hard_gates=["dose_units_harmonized", "category_counts_complete"],
            risk_of_bias_tool="design-specific RoB",
            certainty_framework="GRADE",
            reporting_guidelines=["PRISMA 2020", "PRISMA-S"],
            engine_entrypoint="new_meta.engines.dose_response:run_dose_response",
            validation_reference="dosresmeta multivariate REML and dose-policy fixtures",
            blocking_reason="The requested dose-response structure has not passed production validation.",
        ),
        MethodPlugin(
            family=ReviewFamily.NARRATIVE_SYNTHESIS,
            policy_version="2026.1",
            capability_status=CapabilityStatus.VALIDATING,
            supported_designs=["any"],
            supported_outcome_types=["any"],
            supported_effect_measures=["NONE"],
            primary_estimators={"default": "SWiM"},
            sensitivity_estimators=[],
            required_diagnostics=["grouping_logic", "effect_direction", "certainty_without_pooling"],
            hard_gates=["no_inappropriate_pooling", "structured_synthesis_groups"],
            risk_of_bias_tool="design-specific",
            certainty_framework="GRADE",
            reporting_guidelines=["PRISMA 2020", "SWiM", "PRISMA-S"],
            engine_entrypoint="new_meta.engines.narrative:run",
            validation_reference="SWiM reporting fixtures",
            blocking_reason="Narrative synthesis templates require external reporting validation.",
        ),
    ], validation_manifest=load_default_validation_manifest())
