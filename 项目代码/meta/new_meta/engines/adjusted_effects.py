"""Pooling of source-verified adjusted associations for NRSI/prognosis reviews."""
from __future__ import annotations

import math

from pydantic import BaseModel, Field, model_validator

from new_meta.engines.meta_engine import random_effects_hksj, random_effects_reml
from new_meta.schemas.meta_result import StudyEffect


_RATIO_MEASURES = {"OR", "RR", "HR", "IRR"}


class AdjustedEffectRecord(BaseModel):
    result_id: str = Field(min_length=1)
    study_id: str = Field(min_length=1)
    measure: str = Field(min_length=1)
    estimate: float
    standard_error: float | None = Field(default=None, gt=0)
    variance: float | None = Field(default=None, gt=0)
    ci_lower: float | None = None
    ci_upper: float | None = None
    scale: str = "original"
    adjusted: bool = False
    adjusted_covariates: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_precision(self):
        if self.standard_error is None and self.variance is None and (
            self.ci_lower is None or self.ci_upper is None
        ):
            raise ValueError("standard error, variance, or confidence interval is required")
        return self


class AdjustedEffectsResult(BaseModel):
    schema_version: int = 1
    estimator: str = "REML_ADJUSTED_EFFECTS"
    measure: str
    n_studies: int
    pooled_effect: float
    ci_lower: float
    ci_upper: float
    pooled_analysis_scale: float
    standard_error_analysis_scale: float
    tau_squared: float = Field(ge=0)
    i_squared: float = Field(ge=0, le=100)
    q: float = Field(ge=0)
    prediction_interval: tuple[float, float] | None = None
    adjustment_sets: list[list[str]]
    sensitivity: dict = Field(default_factory=dict)
    converged: bool = True
    diagnostics: dict = Field(default_factory=dict)


def run_adjusted_effects(records: list[AdjustedEffectRecord]) -> AdjustedEffectsResult:
    rows = [
        item if isinstance(item, AdjustedEffectRecord) else AdjustedEffectRecord.model_validate(item)
        for item in records
    ]
    if len(rows) < 2:
        raise ValueError("adjusted-effects synthesis requires at least two studies")
    if any(not item.adjusted for item in rows):
        raise ValueError("NRSI/prognostic synthesis accepts adjusted estimates only")
    if any(not item.adjusted_covariates for item in rows):
        raise ValueError("adjusted estimates require a reported adjustment set")
    measures = {item.measure.upper() for item in rows}
    if len(measures) != 1:
        raise ValueError("all adjusted estimates must use the same effect measure")
    if len({item.study_id for item in rows}) != len(rows):
        raise ValueError("multiple correlated estimates from one study require an explicit covariance model")
    adjustment_sets = sorted({
        tuple(sorted({_normalize_covariate(value) for value in item.adjusted_covariates if value.strip()}))
        for item in rows
    })
    if len(adjustment_sets) != 1:
        raise ValueError(
            "adjustment sets are incompatible; stratify or adjudicate a common estimand before pooling"
        )
    measure = next(iter(measures))
    effects = [_study_effect(item, measure) for item in rows]
    reml = random_effects_reml(effects, measure, "Adjusted association")
    hksj = random_effects_hksj(effects, measure, "Adjusted association")
    return AdjustedEffectsResult(
        measure=measure,
        n_studies=len(rows),
        pooled_effect=reml.pooled_effect,
        ci_lower=reml.ci_lower,
        ci_upper=reml.ci_upper,
        pooled_analysis_scale=float(reml.pooled_log if reml.pooled_log is not None else reml.pooled_effect),
        standard_error_analysis_scale=float(
            (reml.ci_upper_log - reml.ci_lower_log) / (2 * 1.959963984540054)
            if reml.ci_upper_log is not None and reml.ci_lower_log is not None
            else (reml.ci_upper - reml.ci_lower) / (2 * 1.959963984540054)
        ),
        tau_squared=reml.tau_squared,
        i_squared=reml.i_squared,
        q=reml.q_statistic,
        prediction_interval=reml.prediction_interval,
        adjustment_sets=[list(item) for item in adjustment_sets],
        sensitivity={
            "HKSJ": {
                "estimate": hksj.pooled_effect,
                "ci_lower": hksj.ci_lower,
                "ci_upper": hksj.ci_upper,
            }
        },
        diagnostics={
            "analysis_scale": "log" if measure in _RATIO_MEASURES else "original",
            "adjusted_only": True,
            "one_estimate_per_study": True,
            "adjustment_set_compatibility": "exact canonical match",
        },
    )


def _study_effect(record: AdjustedEffectRecord, measure: str) -> StudyEffect:
    estimate = float(record.estimate)
    lower, upper = record.ci_lower, record.ci_upper
    ratio = measure in _RATIO_MEASURES
    if ratio and record.scale == "original":
        if estimate <= 0 or (lower is not None and lower <= 0) or (upper is not None and upper <= 0):
            raise ValueError(f"{measure} estimates and confidence bounds must be positive")
        yi = math.log(estimate)
        if lower is not None and upper is not None:
            se = (math.log(upper) - math.log(lower)) / (2 * 1.959963984540054)
        elif record.standard_error is not None:
            se = record.standard_error
        else:
            se = math.sqrt(record.variance)
    else:
        yi = estimate
        if lower is not None and upper is not None:
            se = (upper - lower) / (2 * 1.959963984540054)
        elif record.standard_error is not None:
            se = record.standard_error
        else:
            se = math.sqrt(record.variance)
    if not math.isfinite(se) or se <= 0:
        raise ValueError("adjusted effect precision must be finite and positive")
    return StudyEffect(
        study_id=record.study_id,
        study_label=record.study_id,
        yi=yi,
        vi=se * se,
        se=se,
    )


def _normalize_covariate(value: str) -> str:
    return " ".join(str(value).strip().lower().replace("_", " ").split())
