"""Review-family-neutral result contract for reporting, APIs, and packages."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from new_meta.schemas.method_policy import MethodExecutionResult, MethodPlan, ReviewFamily


class SynthesisEstimate(BaseModel):
    estimate_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    measure: str = Field(min_length=1)
    scale: str = Field(min_length=1)
    estimate: float
    ci_lower: float | None = None
    ci_upper: float | None = None
    prediction_lower: float | None = None
    prediction_upper: float | None = None


class SynthesisResultEnvelope(BaseModel):
    schema_version: int = 1
    family: ReviewFamily
    policy_version: str
    method_plan_fingerprint: str = Field(min_length=1)
    route: str
    estimator: str
    n_studies: int = Field(ge=0)
    input_result_ids: list[str] = Field(default_factory=list)
    primary_estimates: list[SynthesisEstimate] = Field(min_length=1)
    heterogeneity: dict[str, Any] = Field(default_factory=dict)
    diagnostics: dict[str, Any] = Field(default_factory=dict)
    execution_converged: bool | None = None
    engine_payload: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def from_pairwise_meta(
        cls,
        *,
        plan: MethodPlan,
        results,
        input_result_ids: list[str],
    ) -> "SynthesisResultEnvelope":
        primary = results.primary_outcome
        prediction = primary.prediction_interval or (None, None)
        ratio_measures = {"OR", "RR", "HR", "IRR"}
        scale = (
            "ratio"
            if primary.effect_measure in ratio_measures
            else "correlation"
            if primary.effect_measure == "COR"
            else "difference"
        )
        return cls(
            family=plan.family,
            policy_version=plan.policy_version,
            method_plan_fingerprint=plan.plan_fingerprint,
            route="pairwise_aggregate",
            estimator=(primary.tau_estimator if primary.model == "random" else "INVERSE_VARIANCE_FIXED"),
            n_studies=primary.n_studies,
            input_result_ids=input_result_ids,
            primary_estimates=[
                SynthesisEstimate(
                    estimate_id="primary_pooled_effect",
                    label=primary.outcome_name,
                    measure=primary.effect_measure,
                    scale=scale,
                    estimate=primary.pooled_effect,
                    ci_lower=primary.ci_lower,
                    ci_upper=primary.ci_upper,
                    prediction_lower=prediction[0],
                    prediction_upper=prediction[1],
                )
            ],
            heterogeneity={
                "q": primary.q_statistic,
                "q_p_value": primary.q_p_value,
                "i_squared": primary.i_squared,
                "tau_squared": primary.tau_squared,
                "h_squared": primary.h_squared,
            },
            diagnostics={
                "model": primary.model,
                "model_decision": results.model_decision,
                "sensitivity": results.model_sensitivity,
            },
            execution_converged=True,
            engine_payload=results.model_dump(mode="json"),
        )

    @classmethod
    def from_method_execution(cls, result: MethodExecutionResult) -> "SynthesisResultEnvelope":
        payload = dict(result.payload)
        if result.family is ReviewFamily.PREVALENCE_INCIDENCE:
            prediction = payload.get("prediction_interval") or [None, None]
            if "pooled_rate" in payload:
                estimates = [
                    SynthesisEstimate(
                        estimate_id="pooled_incidence_rate",
                        label="Pooled incidence rate",
                        measure="IR",
                        scale="incidence_rate",
                        estimate=float(payload["pooled_rate"]),
                        ci_lower=float(payload["ci_lower"]),
                        ci_upper=float(payload["ci_upper"]),
                        prediction_lower=(float(prediction[0]) if prediction[0] is not None else None),
                        prediction_upper=(float(prediction[1]) if prediction[1] is not None else None),
                    )
                ]
                heterogeneity = {
                    "tau_squared": payload.get("tau_squared"),
                    "i_squared": payload.get("i_squared_log_rate"),
                    "scale": "log incidence rate",
                    "time_unit": payload.get("time_unit"),
                }
            else:
                estimates = [
                    SynthesisEstimate(
                        estimate_id="pooled_prevalence",
                        label="Pooled prevalence",
                        measure="PROP",
                        scale="proportion",
                        estimate=float(payload["pooled_proportion"]),
                        ci_lower=float(payload["ci_lower"]),
                        ci_upper=float(payload["ci_upper"]),
                        prediction_lower=(float(prediction[0]) if prediction[0] is not None else None),
                        prediction_upper=(float(prediction[1]) if prediction[1] is not None else None),
                    )
                ]
                heterogeneity = {
                    "tau_squared": payload.get("tau_squared"),
                    "i_squared": payload.get("i_squared_logit"),
                    "scale": "logit",
                }
        elif result.family is ReviewFamily.DIAGNOSTIC_ACCURACY:
            sens_ci = payload.get("sensitivity_ci") or [None, None]
            spec_ci = payload.get("specificity_ci") or [None, None]
            estimates = [
                SynthesisEstimate(
                    estimate_id="summary_sensitivity",
                    label="Summary sensitivity",
                    measure="SENS",
                    scale="proportion",
                    estimate=float(payload["summary_sensitivity"]),
                    ci_lower=float(sens_ci[0]),
                    ci_upper=float(sens_ci[1]),
                ),
                SynthesisEstimate(
                    estimate_id="summary_specificity",
                    label="Summary specificity",
                    measure="SPEC",
                    scale="proportion",
                    estimate=float(payload["summary_specificity"]),
                    ci_lower=float(spec_ci[0]),
                    ci_upper=float(spec_ci[1]),
                ),
            ]
            heterogeneity = {
                "between_variance_sensitivity": payload.get("between_variance_sensitivity"),
                "between_variance_specificity": payload.get("between_variance_specificity"),
                "between_correlation": payload.get("between_correlation"),
                "scale": "logit",
            }
        elif result.family is ReviewFamily.DOSE_RESPONSE:
            curve = list(payload["curve"])
            target = max(curve, key=lambda item: float(item["dose"]))
            measure = str(payload["measure"])
            estimates = [
                SynthesisEstimate(
                    estimate_id="dose_response_at_maximum_observed_dose",
                    label=(
                        f"Effect at {target['dose']:g} {payload['dose_unit']} versus "
                        f"{payload['reference_dose']:g} {payload['dose_unit']}"
                    ),
                    measure=measure,
                    scale=("ratio" if measure in {"OR", "RR", "HR"} else "difference"),
                    estimate=float(target["effect"]),
                    ci_lower=float(target["ci_lower"]),
                    ci_upper=float(target["ci_upper"]),
                )
            ]
            heterogeneity = {
                "between_study_covariance": payload.get("between_study_covariance"),
                "scale": payload.get("diagnostics", {}).get("analysis_scale"),
            }
        elif result.family is ReviewFamily.NETWORK_META:
            measure = str(payload["measure"])
            estimates = [
                SynthesisEstimate(
                    estimate_id=(
                        "network_" + str(item["treatment"]).lower().replace(" ", "_")
                        + "_vs_" + str(item["comparator"]).lower().replace(" ", "_")
                    ),
                    label=f"{item['treatment']} versus {item['comparator']}",
                    measure=measure,
                    scale=("ratio" if measure in {"OR", "RR", "HR"} else "difference"),
                    estimate=float(item["effect"]),
                    ci_lower=float(item["ci_lower"]),
                    ci_upper=float(item["ci_upper"]),
                )
                for item in payload["league_table"]
            ]
            heterogeneity = {
                "tau_squared": payload.get("tau_squared"),
                "inconsistency_p": payload.get("inconsistency_p"),
                "scale": payload.get("diagnostics", {}).get("analysis_scale"),
            }
        elif result.family is ReviewFamily.IPD_META:
            prediction = payload.get("prediction_interval") or [None, None]
            measure = str(payload["effect_measure"])
            estimates = [
                SynthesisEstimate(
                    estimate_id="pooled_participant_level_treatment_effect",
                    label="Pooled participant-level treatment effect",
                    measure=measure,
                    scale=("ratio" if measure in {"OR", "HR"} else "difference"),
                    estimate=float(payload["pooled_effect"]),
                    ci_lower=float(payload["ci_lower"]),
                    ci_upper=float(payload["ci_upper"]),
                    prediction_lower=(
                        float(prediction[0]) if prediction[0] is not None else None
                    ),
                    prediction_upper=(
                        float(prediction[1]) if prediction[1] is not None else None
                    ),
                )
            ]
            heterogeneity = {
                "tau_squared": payload.get("tau_squared"),
                "i_squared": payload.get("i_squared"),
                "scale": (
                    "log ratio" if measure in {"OR", "HR"} else "mean difference"
                ),
            }
        elif result.family is ReviewFamily.INTERVENTION_RCT:
            prediction = payload.get("prediction_interval") or [None, None]
            measure = str(payload["measure"])
            estimates = [
                SynthesisEstimate(
                    estimate_id="pooled_design_aware_effect",
                    label="Pooled design-aware treatment effect",
                    measure=measure,
                    scale=("ratio" if measure in {"OR", "RR", "HR", "IRR"} else "difference"),
                    estimate=float(payload["pooled_effect"]),
                    ci_lower=float(payload["ci_lower"]),
                    ci_upper=float(payload["ci_upper"]),
                    prediction_lower=(float(prediction[0]) if prediction[0] is not None else None),
                    prediction_upper=(float(prediction[1]) if prediction[1] is not None else None),
                )
            ]
            heterogeneity = {
                "tau_squared": payload.get("tau_squared"),
                "i_squared": payload.get("i_squared"),
                "q": payload.get("q"),
                "scale": payload.get("diagnostics", {}).get("analysis_scale"),
            }
        elif result.family in {
            ReviewFamily.INTERVENTION_NRSI,
            ReviewFamily.PROGNOSTIC_FACTOR,
        }:
            prediction = payload.get("prediction_interval") or [None, None]
            measure = str(payload["measure"])
            estimates = [
                SynthesisEstimate(
                    estimate_id="pooled_adjusted_effect",
                    label="Pooled adjusted association",
                    measure=measure,
                    scale=("ratio" if measure in {"OR", "RR", "HR", "IRR"} else "difference"),
                    estimate=float(payload["pooled_effect"]),
                    ci_lower=float(payload["ci_lower"]),
                    ci_upper=float(payload["ci_upper"]),
                    prediction_lower=(float(prediction[0]) if prediction[0] is not None else None),
                    prediction_upper=(float(prediction[1]) if prediction[1] is not None else None),
                )
            ]
            heterogeneity = {
                "tau_squared": payload.get("tau_squared"),
                "i_squared": payload.get("i_squared"),
                "q": payload.get("q"),
                "scale": payload.get("diagnostics", {}).get("analysis_scale"),
            }
        elif result.family is ReviewFamily.PREDICTION_MODEL:
            prediction = payload.get("prediction_interval") or [None, None]
            metric = str(payload.get("metric") or "C_STATISTIC").upper()
            is_oe = metric == "OE_RATIO"
            is_slope = metric == "CALIBRATION_SLOPE"
            estimates = [
                SynthesisEstimate(
                    estimate_id=(
                        "pooled_observed_expected_ratio"
                        if is_oe
                        else "pooled_calibration_slope"
                        if is_slope
                        else "pooled_external_c_statistic"
                    ),
                    label=(
                        "Pooled observed-to-expected ratio"
                        if is_oe
                        else "Pooled calibration slope"
                        if is_slope
                        else "Pooled external-validation c-statistic"
                    ),
                    measure=metric,
                    scale=(
                        "ratio"
                        if is_oe
                        else "calibration_slope"
                        if is_slope
                        else "c_statistic"
                    ),
                    estimate=float(payload["pooled_performance"]),
                    ci_lower=float(payload["ci_lower"]),
                    ci_upper=float(payload["ci_upper"]),
                    prediction_lower=float(prediction[0]),
                    prediction_upper=float(prediction[1]),
                )
            ]
            heterogeneity = {
                "tau_squared": payload.get("tau_squared"),
                "i_squared": payload.get("i_squared"),
                "q": payload.get("q"),
                "scale": (
                    "log_observed_expected_ratio"
                    if is_oe
                    else "original_calibration_slope"
                    if is_slope
                    else "logit_c_statistic"
                ),
            }
        else:
            raise ValueError(
                f"method result family {result.family.value} has no synthesis-envelope mapper"
            )
        return cls(
            family=result.family,
            policy_version=result.policy_version,
            method_plan_fingerprint=result.plan_fingerprint,
            route="method_plugin",
            estimator=result.estimator,
            n_studies=int(payload.get("n_studies") or len(result.input_result_ids)),
            input_result_ids=result.input_result_ids,
            primary_estimates=estimates,
            heterogeneity=heterogeneity,
            diagnostics=result.diagnostics,
            execution_converged=payload.get("converged"),
            engine_payload=payload,
        )
