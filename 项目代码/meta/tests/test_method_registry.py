from pathlib import Path

import pytest

from new_meta.core.method_registry import (
    MethodCompilationError,
    MethodRegistry,
    default_method_registry,
)
from new_meta.schemas.method_policy import (
    CapabilityStatus,
    MethodPlugin,
    ReviewDesignSpec,
    ReviewFamily,
)


def test_default_registry_declares_every_target_review_family() -> None:
    registry = default_method_registry()

    assert set(registry.families()) == {
        ReviewFamily.INTERVENTION_RCT,
        ReviewFamily.INTERVENTION_NRSI,
        ReviewFamily.PREVALENCE_INCIDENCE,
        ReviewFamily.DIAGNOSTIC_ACCURACY,
        ReviewFamily.PROGNOSTIC_FACTOR,
        ReviewFamily.PREDICTION_MODEL,
        ReviewFamily.NETWORK_META,
        ReviewFamily.IPD_META,
        ReviewFamily.DOSE_RESPONSE,
        ReviewFamily.NARRATIVE_SYNTHESIS,
    }


def test_method_compiler_emits_versioned_deterministic_rct_plan() -> None:
    registry = default_method_registry()
    spec = ReviewDesignSpec(
        review_id="review:1",
        family=ReviewFamily.INTERVENTION_RCT,
        study_designs=["parallel_rct", "cluster_rct"],
        outcome_type="dichotomous",
        requested_effect_measure="RR",
        requested_model="random",
    )

    plan = registry.compile(spec, allow_validating=True)
    repeated = registry.compile(spec, allow_validating=True)

    assert plan.execution_allowed is True
    assert plan.plan_fingerprint == repeated.plan_fingerprint
    assert plan.primary_estimator == "REML"
    assert "HKSJ" in plan.sensitivity_estimators
    assert "cluster_design_adjustment" in plan.required_diagnostics
    assert plan.risk_of_bias_tool == "RoB 2"
    assert "PRISMA 2020" in plan.reporting_guidelines
    assert plan.effect_measure == "RR"


def test_method_compiler_rejects_design_and_effect_measure_mismatch() -> None:
    registry = default_method_registry()

    with pytest.raises(MethodCompilationError, match="not supported"):
        registry.compile(
            ReviewDesignSpec(
                review_id="review:1",
                family=ReviewFamily.DIAGNOSTIC_ACCURACY,
                study_designs=["diagnostic_cross_sectional"],
                outcome_type="diagnostic_accuracy",
                requested_effect_measure="SMD",
            ),
            allow_validating=True,
        )


def test_validated_nma_policy_compiles_to_explicit_production_plan() -> None:
    registry = default_method_registry()
    plan = registry.compile(
        ReviewDesignSpec(
            review_id="review:network",
            family=ReviewFamily.NETWORK_META,
            study_designs=["parallel_rct", "multi_arm_rct"],
            outcome_type="dichotomous",
            requested_effect_measure="OR",
            treatment_count=4,
        )
    )

    assert plan.execution_allowed is True
    assert plan.capability_status is CapabilityStatus.PRODUCTION
    assert "multi_arm_covariance" in plan.required_diagnostics
    assert "transitivity" in plan.required_diagnostics
    assert "design_by_treatment_inconsistency" in plan.required_diagnostics
    assert plan.blocking_reasons == []
    assert len(plan.validation_evidence_ids) == 3


def test_registry_rejects_duplicate_plugin_versions() -> None:
    plugin = MethodPlugin(
        family=ReviewFamily.NARRATIVE_SYNTHESIS,
        policy_version="2026.1",
        capability_status=CapabilityStatus.PRODUCTION,
        supported_designs=["any"],
        supported_outcome_types=["any"],
        supported_effect_measures=["NONE"],
        primary_estimators={"default": "SWiM"},
        risk_of_bias_tool="design_specific",
        certainty_framework="GRADE",
        reporting_guidelines=["PRISMA 2020", "SWiM"],
        engine_entrypoint="new_meta.engines.narrative:run",
        validation_reference="SWiM fixtures",
    )
    registry = MethodRegistry([plugin])

    with pytest.raises(ValueError, match="already registered"):
        registry.register(plugin)


def test_compiled_plan_is_persistable(tmp_path: Path) -> None:
    registry = default_method_registry()
    plan = registry.compile(
        ReviewDesignSpec(
            review_id="review:prevalence",
            family=ReviewFamily.PREVALENCE_INCIDENCE,
            study_designs=["cross_sectional"],
            outcome_type="proportion",
            requested_effect_measure="PROP",
        ),
        allow_validating=True,
    )
    path = tmp_path / "method_plan.json"
    path.write_text(plan.model_dump_json(indent=2), encoding="utf-8")

    assert '"family": "prevalence_incidence"' in path.read_text(encoding="utf-8")
    assert plan.primary_estimator == "GLMM_LOGIT"
    assert "FREEMAN_TUKEY_SENSITIVITY_ONLY" in plan.sensitivity_estimators
