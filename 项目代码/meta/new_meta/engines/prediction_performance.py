"""Meta-analysis of external prediction-model discrimination or overall calibration."""
from __future__ import annotations

import math

import numpy as np
from pydantic import BaseModel, Field, model_validator
from scipy.special import expit, logit
from scipy.stats import t

from new_meta.engines.meta_engine import random_effects_reml
from new_meta.schemas.meta_result import StudyEffect


class PredictionPerformanceRecord(BaseModel):
    study_id: str = Field(min_length=1)
    model_id: str = Field(min_length=1)
    model_version: str = Field(min_length=1)
    validation_type: str = Field(min_length=1)
    metric: str = Field(min_length=1)
    time_horizon: str = Field(min_length=1)
    c_statistic: float | None = Field(default=None, gt=0, lt=1)
    performance_estimate: float | None = None
    calibration_slope: float | None = None
    standard_error: float | None = Field(default=None, gt=0)
    ci_lower: float | None = None
    ci_upper: float | None = None
    sample_size: int | None = Field(default=None, gt=1)
    events: int | None = Field(default=None, ge=0)
    observed_events: int | None = Field(default=None, ge=0)
    expected_events: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def validate_precision(self):
        metric = self.metric.strip().upper()
        if self.ci_lower is not None and self.ci_upper is not None:
            if self.ci_upper <= self.ci_lower:
                raise ValueError("prediction-performance confidence interval must be ordered")
        if metric == "C_STATISTIC":
            if self.c_statistic is None:
                raise ValueError("C_STATISTIC requires c_statistic")
            if self.ci_lower is not None and not 0 < self.ci_lower < 1:
                raise ValueError("c-statistic lower confidence limit must be in (0, 1)")
            if self.ci_upper is not None and not 0 < self.ci_upper < 1:
                raise ValueError("c-statistic upper confidence limit must be in (0, 1)")
            if self.standard_error is None and (
                self.ci_lower is None or self.ci_upper is None
            ):
                if self.sample_size is None or self.events is None:
                    raise ValueError(
                        "c-statistic precision requires SE, CI, or sample size and event count"
                    )
                if not 0 < self.events < self.sample_size:
                    raise ValueError("c-statistic event count must be between zero and sample size")
        elif metric == "OE_RATIO":
            if self.performance_estimate is not None and self.performance_estimate <= 0:
                raise ValueError("O:E ratio must be positive")
            if self.ci_lower is not None and self.ci_lower <= 0:
                raise ValueError("O:E lower confidence limit must be positive")
            if self.ci_upper is not None and self.ci_upper <= 0:
                raise ValueError("O:E upper confidence limit must be positive")
            observed = self.observed_events if self.observed_events is not None else self.events
            has_raw = observed is not None and self.expected_events is not None and self.sample_size is not None
            has_reported = self.performance_estimate is not None and (
                self.standard_error is not None
                or (self.ci_lower is not None and self.ci_upper is not None)
            )
            if not has_raw and not has_reported:
                raise ValueError(
                    "OE_RATIO requires observed/expected events with sample size, or a reported ratio with SE/CI"
                )
            if has_raw:
                if observed == 0 and not has_reported:
                    raise ValueError(
                        "zero observed events require a reported O:E estimate with source-backed precision"
                    )
                if observed is not None and self.sample_size is not None and observed > self.sample_size:
                    raise ValueError("observed events cannot exceed sample size")
        elif metric == "CALIBRATION_SLOPE":
            slope = (
                self.calibration_slope
                if self.calibration_slope is not None
                else self.performance_estimate
            )
            if slope is None:
                raise ValueError("CALIBRATION_SLOPE requires a reported calibration slope")
            if self.standard_error is None and (
                self.ci_lower is None or self.ci_upper is None
            ):
                raise ValueError("calibration slope requires a source-reported SE or CI")
        else:
            raise ValueError(f"unsupported prediction-performance metric: {metric}")
        return self


class PredictionPerformanceResult(BaseModel):
    schema_version: int = 1
    estimator: str = "VALMETA_CSTAT_REML_HKSJ"
    metric: str
    model_id: str
    model_version: str
    validation_type: str
    time_horizon: str
    n_studies: int = Field(ge=3)
    total_participants: int | None = Field(default=None, gt=0)
    total_events: int | None = Field(default=None, gt=0)
    pooled_performance: float
    ci_lower: float
    ci_upper: float
    prediction_interval: tuple[float, float]
    pooled_analysis_scale: float
    standard_error_analysis_scale: float = Field(gt=0)
    tau_squared: float = Field(ge=0)
    i_squared: float = Field(ge=0, le=100)
    q: float = Field(ge=0)
    converged: bool = True
    diagnostics: dict = Field(default_factory=dict)


def run_prediction_performance(
    records: list[PredictionPerformanceRecord],
) -> PredictionPerformanceResult:
    """Fit a c-statistic, O:E, or calibration-slope REML-HKSJ model."""
    rows = [
        item
        if isinstance(item, PredictionPerformanceRecord)
        else PredictionPerformanceRecord.model_validate(item)
        for item in records
    ]
    if len(rows) < 3:
        raise ValueError("prediction-performance synthesis requires at least three studies")
    if len({item.study_id for item in rows}) != len(rows):
        raise ValueError("one independent validation estimate per study is required")
    identities = {(item.model_id, item.model_version) for item in rows}
    if len(identities) != 1:
        raise ValueError("prediction synthesis requires one model identity and version")
    if {item.validation_type.strip().lower() for item in rows} != {"external"}:
        raise ValueError("released prediction synthesis accepts external validation estimates only")
    metrics = {item.metric.strip().upper() for item in rows}
    if len(metrics) != 1:
        raise ValueError("prediction synthesis requires one performance metric")
    horizons = {" ".join(item.time_horizon.split()).casefold() for item in rows}
    if len(horizons) != 1:
        raise ValueError("prediction synthesis requires one time horizon")
    if metrics == {"OE_RATIO"}:
        return _run_oe_ratio(rows, identities)
    if metrics == {"CALIBRATION_SLOPE"}:
        return _run_calibration_slope(rows, identities)
    if metrics != {"C_STATISTIC"}:
        raise ValueError(
            "this capability synthesizes C_STATISTIC, OE_RATIO, or CALIBRATION_SLOPE results only"
        )

    effects = []
    precision_sources: dict[str, str] = {}
    for item in rows:
        variance, source = _logit_cstat_variance(item)
        yi = float(logit(item.c_statistic))
        effects.append(StudyEffect(
            study_id=item.study_id,
            study_label=item.study_id,
            yi=yi,
            vi=variance,
            se=math.sqrt(variance),
        ))
        precision_sources[item.study_id] = source

    reml = random_effects_reml(effects, "MD", "C-statistic")
    yi = np.asarray([item.yi for item in effects], dtype=float)
    vi = np.asarray([item.vi for item in effects], dtype=float)
    weights = 1.0 / (vi + reml.tau_squared)
    pooled = float(np.sum(weights * yi) / np.sum(weights))
    residual_q = float(np.sum(weights * (yi - pooled) ** 2))
    k = len(effects)
    scale = residual_q / (k - 1)
    se_hksj = math.sqrt(max(scale, 1e-30) / float(np.sum(weights)))
    critical = float(t.ppf(0.975, k - 1))
    ci_lower_logit = pooled - critical * se_hksj
    ci_upper_logit = pooled + critical * se_hksj
    prediction_critical = float(t.ppf(0.975, k - 2))
    prediction_se = math.sqrt(reml.tau_squared + se_hksj**2)
    prediction_lower = pooled - prediction_critical * prediction_se
    prediction_upper = pooled + prediction_critical * prediction_se
    model_id, model_version = next(iter(identities))
    return PredictionPerformanceResult(
        metric="C_STATISTIC",
        model_id=model_id,
        model_version=model_version,
        validation_type="external",
        time_horizon=" ".join(rows[0].time_horizon.split()),
        n_studies=k,
        total_participants=(
            sum(item.sample_size for item in rows)
            if all(item.sample_size is not None for item in rows)
            else None
        ),
        total_events=(
            sum(item.events for item in rows)
            if all(item.events is not None for item in rows)
            else None
        ),
        pooled_performance=float(expit(pooled)),
        ci_lower=float(expit(ci_lower_logit)),
        ci_upper=float(expit(ci_upper_logit)),
        prediction_interval=(
            float(expit(prediction_lower)),
            float(expit(prediction_upper)),
        ),
        pooled_analysis_scale=pooled,
        standard_error_analysis_scale=se_hksj,
        tau_squared=reml.tau_squared,
        i_squared=reml.i_squared,
        q=reml.q_statistic,
        diagnostics={
            "analysis_scale": "logit_c_statistic",
            "random_effects_estimator": "REML",
            "inference": "Hartung-Knapp with t(k-1)",
            "prediction_interval": "t(k-2)",
            "precision_sources": precision_sources,
            "model_identity_locked": True,
            "external_validation_only": True,
        },
    )


def _logit_cstat_variance(item: PredictionPerformanceRecord) -> tuple[float, str]:
    cstat = item.c_statistic
    derivative = 1.0 / (cstat * (1.0 - cstat))
    if item.standard_error is not None:
        return (float(item.standard_error) * derivative) ** 2, "reported_standard_error"
    if item.ci_lower is not None and item.ci_upper is not None:
        se = (
            float(logit(item.ci_upper)) - float(logit(item.ci_lower))
        ) / (2 * 1.959963984540054)
        return se**2, "reported_confidence_interval"
    n = float(item.sample_size)
    events = float(item.events)
    non_events = n - events
    # metamisc::ccalc default: modified Hanley-Newcombe method 4.
    m_star = n_star = n / 2 - 1
    raw_variance = (
        cstat
        * (1 - cstat)
        * (
            1
            + n_star * (1 - cstat) / (2 - cstat)
            + m_star * cstat / (1 + cstat)
        )
        / (non_events * events)
    )
    return raw_variance * derivative**2, "newcombe_method_4"


def _run_oe_ratio(
    rows: list[PredictionPerformanceRecord],
    identities: set[tuple[str, str]],
) -> PredictionPerformanceResult:
    effects = []
    precision_sources: dict[str, str] = {}
    observed_values: list[int | None] = []
    for item in rows:
        observed = item.observed_events if item.observed_events is not None else item.events
        if (
            observed is not None
            and item.expected_events is not None
            and item.sample_size is not None
            and observed > 0
        ):
            oe_ratio = float(observed / item.expected_events)
            variance = float((1.0 - observed / item.sample_size) / observed)
            if variance <= 0:
                raise ValueError("O:E log variance must be positive")
            source = "observed_expected_sample_size"
        else:
            oe_ratio = float(item.performance_estimate)
            if item.standard_error is not None:
                variance = float((item.standard_error / oe_ratio) ** 2)
                source = "reported_standard_error"
            else:
                variance = float(
                    (
                        math.log(float(item.ci_upper))
                        - math.log(float(item.ci_lower))
                    )
                    / (2.0 * 1.959963984540054)
                ) ** 2
                source = "reported_confidence_interval"
        effects.append(StudyEffect(
            study_id=item.study_id,
            study_label=item.study_id,
            yi=math.log(oe_ratio),
            vi=variance,
            se=math.sqrt(variance),
        ))
        precision_sources[item.study_id] = source
        observed_values.append(observed)

    reml = random_effects_reml(effects, "MD", "Observed-to-expected ratio")
    yi = np.asarray([item.yi for item in effects], dtype=float)
    vi = np.asarray([item.vi for item in effects], dtype=float)
    weights = 1.0 / (vi + reml.tau_squared)
    pooled = float(np.sum(weights * yi) / np.sum(weights))
    residual_q = float(np.sum(weights * (yi - pooled) ** 2))
    k = len(effects)
    scale = residual_q / (k - 1)
    se_hksj = math.sqrt(max(scale, 1e-30) / float(np.sum(weights)))
    critical = float(t.ppf(0.975, k - 1))
    ci_lower = pooled - critical * se_hksj
    ci_upper = pooled + critical * se_hksj
    prediction_critical = float(t.ppf(0.975, k - 2))
    prediction_se = math.sqrt(reml.tau_squared + se_hksj**2)
    prediction_lower = pooled - prediction_critical * prediction_se
    prediction_upper = pooled + prediction_critical * prediction_se
    model_id, model_version = next(iter(identities))
    return PredictionPerformanceResult(
        estimator="VALMETA_OE_REML_HKSJ",
        metric="OE_RATIO",
        model_id=model_id,
        model_version=model_version,
        validation_type="external",
        time_horizon=" ".join(rows[0].time_horizon.split()),
        n_studies=k,
        total_participants=(
            sum(item.sample_size for item in rows)
            if all(item.sample_size is not None for item in rows)
            else None
        ),
        total_events=(
            sum(int(value) for value in observed_values if value is not None)
            if all(value is not None for value in observed_values)
            else None
        ),
        pooled_performance=math.exp(pooled),
        ci_lower=math.exp(ci_lower),
        ci_upper=math.exp(ci_upper),
        prediction_interval=(math.exp(prediction_lower), math.exp(prediction_upper)),
        pooled_analysis_scale=pooled,
        standard_error_analysis_scale=se_hksj,
        tau_squared=reml.tau_squared,
        i_squared=reml.i_squared,
        q=reml.q_statistic,
        diagnostics={
            "analysis_scale": "log_observed_expected_ratio",
            "random_effects_estimator": "REML",
            "inference": "Hartung-Knapp with t(k-1)",
            "prediction_interval": "t(k-2)",
            "precision_sources": precision_sources,
            "model_identity_locked": True,
            "external_validation_only": True,
            "ideal_value": 1.0,
        },
    )


def _run_calibration_slope(
    rows: list[PredictionPerformanceRecord],
    identities: set[tuple[str, str]],
) -> PredictionPerformanceResult:
    effects: list[StudyEffect] = []
    precision_sources: dict[str, str] = {}
    for item in rows:
        slope = (
            item.calibration_slope
            if item.calibration_slope is not None
            else item.performance_estimate
        )
        if item.standard_error is not None:
            variance = float(item.standard_error**2)
            source = "reported_standard_error"
        else:
            variance = float(
                (
                    (float(item.ci_upper) - float(item.ci_lower))
                    / (2.0 * 1.959963984540054)
                )
                ** 2
            )
            source = "reported_confidence_interval"
        effects.append(
            StudyEffect(
                study_id=item.study_id,
                study_label=item.study_id,
                yi=float(slope),
                vi=variance,
                se=math.sqrt(variance),
            )
        )
        precision_sources[item.study_id] = source

    reml = random_effects_reml(
        effects,
        "MD",
        "Calibration slope",
    )
    yi = np.asarray([item.yi for item in effects], dtype=float)
    vi = np.asarray([item.vi for item in effects], dtype=float)
    weights = 1.0 / (vi + reml.tau_squared)
    pooled = float(np.sum(weights * yi) / np.sum(weights))
    residual_q = float(np.sum(weights * (yi - pooled) ** 2))
    k = len(effects)
    scale = residual_q / (k - 1)
    se_hksj = math.sqrt(max(scale, 1e-30) / float(np.sum(weights)))
    critical = float(t.ppf(0.975, k - 1))
    ci_lower = pooled - critical * se_hksj
    ci_upper = pooled + critical * se_hksj
    prediction_critical = float(t.ppf(0.975, k - 1))
    prediction_se = math.sqrt(reml.tau_squared + se_hksj**2)
    prediction_lower = pooled - prediction_critical * prediction_se
    prediction_upper = pooled + prediction_critical * prediction_se
    fixed_weights = 1.0 / vi
    typical_variance = float(
        (k - 1)
        * np.sum(fixed_weights)
        / (np.sum(fixed_weights) ** 2 - np.sum(fixed_weights**2))
    )
    i_squared = float(
        100.0 * reml.tau_squared / (reml.tau_squared + typical_variance)
    )
    model_id, model_version = next(iter(identities))
    return PredictionPerformanceResult(
        estimator="CALIBRATION_SLOPE_REML_HKSJ",
        metric="CALIBRATION_SLOPE",
        model_id=model_id,
        model_version=model_version,
        validation_type="external",
        time_horizon=" ".join(rows[0].time_horizon.split()),
        n_studies=k,
        total_participants=(
            sum(item.sample_size for item in rows)
            if all(item.sample_size is not None for item in rows)
            else None
        ),
        total_events=(
            sum(item.events for item in rows)
            if all(item.events is not None for item in rows)
            else None
        ),
        pooled_performance=pooled,
        ci_lower=ci_lower,
        ci_upper=ci_upper,
        prediction_interval=(prediction_lower, prediction_upper),
        pooled_analysis_scale=pooled,
        standard_error_analysis_scale=se_hksj,
        tau_squared=reml.tau_squared,
        i_squared=i_squared,
        q=reml.q_statistic,
        diagnostics={
            "analysis_scale": "original_calibration_slope",
            "random_effects_estimator": "REML",
            "inference": "Hartung-Knapp with t(k-1)",
            "prediction_interval": "metafor predict, t(k-1)",
            "precision_sources": precision_sources,
            "model_identity_locked": True,
            "external_validation_only": True,
            "ideal_value": 1.0,
        },
    )
