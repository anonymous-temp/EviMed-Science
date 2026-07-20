"""Aggregate categorical dose-response meta-analysis with multivariate REML."""
from __future__ import annotations

from collections import defaultdict
import math
from typing import Any

import numpy as np
from pydantic import BaseModel, Field, model_validator
from scipy import optimize, stats

from new_meta.engines.meta_engine import random_effects_reml
from new_meta.schemas.meta_result import StudyEffect


_RATIO_MEASURES = {"OR", "RR", "HR"}
_Z_975 = 1.959963984540054


class DoseResponseRecord(BaseModel):
    result_id: str = Field(min_length=1)
    study_id: str = Field(min_length=1)
    contrast_id: str = Field(min_length=1)
    dose: float = Field(ge=0)
    reference_dose: float = Field(ge=0)
    dose_unit: str = Field(min_length=1)
    measure: str = Field(min_length=1)
    estimate: float
    standard_error: float | None = Field(default=None, gt=0)
    variance: float | None = Field(default=None, gt=0)
    ci_lower: float | None = None
    ci_upper: float | None = None
    scale: str = "original"
    covariance_with: dict[str, float] = Field(default_factory=dict)
    design: str = "parallel_rct"
    adjusted: bool = False
    adjusted_covariates: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_contrast(self):
        if math.isclose(self.dose, self.reference_dose, rel_tol=0, abs_tol=1e-15):
            raise ValueError("dose-response contrast dose must differ from reference dose")
        if self.standard_error is None and self.variance is None and (
            self.ci_lower is None or self.ci_upper is None
        ):
            raise ValueError("dose-response contrast requires SE, variance, or confidence interval")
        return self


class DoseResponseResult(BaseModel):
    schema_version: int = 1
    estimator: str = "TWO_STAGE_MULTIVARIATE_REML_RCS"
    measure: str
    n_studies: int
    n_contrasts: int
    dose_unit: str
    knots: list[float]
    reference_dose: float
    coefficients: list[float]
    coefficient_covariance: list[list[float]]
    between_study_covariance: list[list[float]]
    curve: list[dict[str, float]]
    nonlinearity: dict[str, float | int]
    linear_sensitivity: dict[str, Any]
    converged: bool
    diagnostics: dict[str, Any] = Field(default_factory=dict)


def run_dose_response(
    records: list[DoseResponseRecord | dict],
    *,
    knots: list[float] | None = None,
) -> DoseResponseResult:
    """Fit a two-stage restricted cubic spline dose-response model.

    Each study must contribute at least two non-reference categories and an
    explicit positive-definite covariance matrix for its dependent log effects.
    Study-specific spline coefficients are pooled with bivariate REML.
    """
    rows = [
        item if isinstance(item, DoseResponseRecord) else DoseResponseRecord.model_validate(item)
        for item in records
    ]
    if len(rows) < 6:
        raise ValueError("dose-response synthesis requires at least three studies with two contrasts each")
    measures = {item.measure.upper() for item in rows}
    if len(measures) != 1:
        raise ValueError("all dose-response contrasts must use one effect measure")
    measure = next(iter(measures))
    if measure not in _RATIO_MEASURES | {"MD"}:
        raise ValueError(f"unsupported dose-response effect measure: {measure}")
    observational = [item for item in rows if item.design in {"cohort", "case_control"}]
    adjustment_set: list[str] = []
    if observational:
        if any(not item.adjusted or not item.adjusted_covariates for item in observational):
            raise ValueError("observational dose-response synthesis requires adjusted effects")
        sets = {
            tuple(sorted({_normalize_covariate(value) for value in item.adjusted_covariates}))
            for item in observational
        }
        if len(sets) != 1:
            raise ValueError("observational dose-response adjustment sets must match exactly")
        adjustment_set = list(next(iter(sets)))

    normalized, canonical_unit = _harmonize_doses(rows)
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in normalized:
        grouped[item["record"].study_id].append(item)
    if len(grouped) < 3:
        raise ValueError("dose-response synthesis requires at least three independent studies")
    if any(len(group) < 2 for group in grouped.values()):
        raise ValueError("each study requires at least two non-reference dose contrasts for spline rank")

    all_doses = np.array(
        [value for item in normalized for value in (item["dose"], item["reference_dose"])],
        dtype=float,
    )
    chosen_knots = np.array(
        knots
        if knots is not None
        else np.quantile(np.unique(all_doses), [0.10, 0.50, 0.90], method="nearest"),
        dtype=float,
    )
    if chosen_knots.shape != (3,) or not np.all(np.diff(chosen_knots) > 0):
        raise ValueError("restricted cubic spline requires three strictly increasing knots")

    study_betas: list[np.ndarray] = []
    study_covariances: list[np.ndarray] = []
    linear_effects: list[StudyEffect] = []
    for study_id, group in sorted(grouped.items()):
        y = np.array([item["yi"] for item in group], dtype=float)
        covariance = _within_study_covariance(study_id, group)
        X = np.vstack([
            _rcs_basis(item["dose"], chosen_knots)
            - _rcs_basis(item["reference_dose"], chosen_knots)
            for item in group
        ])
        if np.linalg.matrix_rank(X) < 2:
            raise ValueError(
                f"study {study_id} does not contain at least two non-reference dose contrasts with spline rank"
            )
        precision = np.linalg.inv(covariance)
        coefficient_covariance = np.linalg.inv(X.T @ precision @ X)
        beta = coefficient_covariance @ X.T @ precision @ y
        study_betas.append(beta)
        study_covariances.append(coefficient_covariance)

        x_linear = np.array(
            [item["dose"] - item["reference_dose"] for item in group], dtype=float
        )[:, None]
        linear_variance = float(1.0 / (x_linear.T @ precision @ x_linear)[0, 0])
        linear_beta = float(
            linear_variance * (x_linear.T @ precision @ y[:, None])[0, 0]
        )
        linear_effects.append(
            StudyEffect(
                study_id=study_id,
                study_label=study_id,
                yi=linear_beta,
                vi=linear_variance,
                se=math.sqrt(linear_variance),
            )
        )

    pooled_beta, pooled_covariance, between_covariance, converged = _multivariate_reml(
        study_betas, study_covariances
    )
    nonlinear_se = math.sqrt(max(float(pooled_covariance[1, 1]), 0.0))
    nonlinear_z = float(pooled_beta[1] / nonlinear_se) if nonlinear_se > 0 else 0.0
    nonlinear_p = float(2 * stats.norm.sf(abs(nonlinear_z)))

    reference_dose = float(min(all_doses))
    grid = np.linspace(float(min(all_doses)), float(max(all_doses)), 41)
    grid = np.unique(np.concatenate([grid, np.unique(all_doses)]))
    reference_basis = _rcs_basis(reference_dose, chosen_knots)
    curve = []
    for dose in grid:
        contrast = _rcs_basis(float(dose), chosen_knots) - reference_basis
        fitted = float(contrast @ pooled_beta)
        variance = max(float(contrast @ pooled_covariance @ contrast), 0.0)
        se = math.sqrt(variance)
        lower, upper = fitted - _Z_975 * se, fitted + _Z_975 * se
        if measure in _RATIO_MEASURES:
            effect, ci_lower, ci_upper = math.exp(fitted), math.exp(lower), math.exp(upper)
        else:
            effect, ci_lower, ci_upper = fitted, lower, upper
        curve.append({
            "dose": float(dose),
            "effect": float(effect),
            "ci_lower": float(ci_lower),
            "ci_upper": float(ci_upper),
        })

    linear = random_effects_reml(linear_effects, "MD", "Linear dose coefficient")
    return DoseResponseResult(
        measure=measure,
        n_studies=len(grouped),
        n_contrasts=len(rows),
        dose_unit=canonical_unit,
        knots=[float(value) for value in chosen_knots],
        reference_dose=reference_dose,
        coefficients=[float(value) for value in pooled_beta],
        coefficient_covariance=pooled_covariance.tolist(),
        between_study_covariance=between_covariance.tolist(),
        curve=curve,
        nonlinearity={
            "wald_z": nonlinear_z,
            "df": 1,
            "p_value": nonlinear_p,
        },
        linear_sensitivity={
            "coefficient": linear.pooled_effect,
            "ci_lower": linear.ci_lower,
            "ci_upper": linear.ci_upper,
            "tau_squared": linear.tau_squared,
        },
        converged=converged,
        diagnostics={
            "model": "two_stage_multivariate_reml_rcs",
            "analysis_scale": "log" if measure in _RATIO_MEASURES else "original",
            "within_study_covariance": "explicit",
            "dose_harmonization": canonical_unit,
            "reference_category": reference_dose,
            "knot_percentiles": [10, 50, 90] if knots is None else "user_supplied",
            "observational_adjustment_set": adjustment_set,
        },
    )


def _harmonize_doses(rows: list[DoseResponseRecord]) -> tuple[list[dict[str, Any]], str]:
    parsed = [_dose_unit(item.dose_unit) for item in rows]
    dimensions = {item[0] for item in parsed}
    if len(dimensions) != 1:
        raise ValueError("dose units have incompatible dimensions and cannot be harmonized")
    canonical = parsed[0][2]
    normalized = []
    for record, (_, factor, _) in zip(rows, parsed):
        yi, vi = _effect_and_variance(record)
        normalized.append({
            "record": record,
            "dose": float(record.dose) * factor,
            "reference_dose": float(record.reference_dose) * factor,
            "yi": yi,
            "vi": vi,
        })
    return normalized, canonical


def _dose_unit(value: str) -> tuple[str, float, str]:
    text = str(value).strip().lower().replace("μ", "u").replace("µ", "u").replace(" ", "")
    mappings = {
        "mg/day": ("mass_per_day", 1.0, "mg/day"),
        "mg/d": ("mass_per_day", 1.0, "mg/day"),
        "g/day": ("mass_per_day", 1000.0, "mg/day"),
        "g/d": ("mass_per_day", 1000.0, "mg/day"),
        "ug/day": ("mass_per_day", 0.001, "mg/day"),
        "mcg/day": ("mass_per_day", 0.001, "mg/day"),
        "mg/kg/day": ("mass_per_kg_day", 1.0, "mg/kg/day"),
        "mg/kg/d": ("mass_per_kg_day", 1.0, "mg/kg/day"),
        "g/kg/day": ("mass_per_kg_day", 1000.0, "mg/kg/day"),
        "ug/kg/day": ("mass_per_kg_day", 0.001, "mg/kg/day"),
    }
    if text in mappings:
        return mappings[text]
    return (f"exact:{text}", 1.0, str(value).strip())


def _effect_and_variance(record: DoseResponseRecord) -> tuple[float, float]:
    measure = record.measure.upper()
    estimate = float(record.estimate)
    lower, upper = record.ci_lower, record.ci_upper
    if measure in _RATIO_MEASURES and record.scale.strip().lower() == "original":
        if estimate <= 0 or (lower is not None and lower <= 0) or (upper is not None and upper <= 0):
            raise ValueError(f"{measure} dose-response estimates must be positive")
        yi = math.log(estimate)
        ci_se = (
            (math.log(float(upper)) - math.log(float(lower))) / (2 * _Z_975)
            if lower is not None and upper is not None
            else None
        )
    else:
        yi = estimate
        ci_se = (
            (float(upper) - float(lower)) / (2 * _Z_975)
            if lower is not None and upper is not None
            else None
        )
    if ci_se is not None:
        vi = ci_se * ci_se
    elif record.standard_error is not None:
        vi = float(record.standard_error) ** 2
    else:
        vi = float(record.variance)
    return yi, vi


def _within_study_covariance(study_id: str, group: list[dict[str, Any]]) -> np.ndarray:
    n = len(group)
    covariance = np.diag([float(item["vi"]) for item in group])
    for left in range(n):
        for right in range(left + 1, n):
            left_row = group[left]["record"]
            right_row = group[right]["record"]
            value = left_row.covariance_with.get(right_row.contrast_id)
            reverse = right_row.covariance_with.get(left_row.contrast_id)
            if value is None and reverse is None:
                raise ValueError(
                    f"dose-response study {study_id} requires explicit covariance between dependent contrasts"
                )
            if value is not None and reverse is not None and not math.isclose(
                float(value), float(reverse), rel_tol=1e-8, abs_tol=1e-12
            ):
                raise ValueError(f"dose-response study {study_id} covariance entries disagree")
            covariance[left, right] = covariance[right, left] = float(
                value if value is not None else reverse
            )
    if np.any(np.linalg.eigvalsh(covariance) <= 0):
        raise ValueError(f"dose-response study {study_id} covariance matrix must be positive-definite")
    return covariance


def _rcs_basis(dose: float, knots: np.ndarray) -> np.ndarray:
    k1, k2, k3 = [float(value) for value in knots]
    positive = lambda value: max(value, 0.0) ** 3
    nonlinear = (
        positive(dose - k1)
        - ((k3 - k1) / (k3 - k2)) * positive(dose - k2)
        + ((k2 - k1) / (k3 - k2)) * positive(dose - k3)
    ) / ((k3 - k1) ** 2)
    return np.array([dose, nonlinear], dtype=float)


def _multivariate_reml(
    estimates: list[np.ndarray],
    sampling_covariances: list[np.ndarray],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, bool]:
    p = 2

    def between(parameters: np.ndarray) -> np.ndarray:
        lower = np.array(
            [[math.exp(parameters[0]), 0.0], [parameters[1], math.exp(parameters[2])]],
            dtype=float,
        )
        return lower @ lower.T

    def fit_given(T: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
        precisions = [np.linalg.inv(covariance + T) for covariance in sampling_covariances]
        total_precision = sum(precisions, np.zeros((p, p), dtype=float))
        pooled_covariance = np.linalg.inv(total_precision)
        pooled = pooled_covariance @ sum(
            (precision @ estimate for precision, estimate in zip(precisions, estimates)),
            np.zeros(p, dtype=float),
        )
        residual = 0.0
        logdet = 0.0
        for estimate, covariance, precision in zip(estimates, sampling_covariances, precisions):
            sign, value = np.linalg.slogdet(covariance + T)
            if sign <= 0:
                return pooled, pooled_covariance, math.inf
            difference = estimate - pooled
            logdet += value
            residual += float(difference @ precision @ difference)
        sign_precision, logdet_precision = np.linalg.slogdet(total_precision)
        if sign_precision <= 0:
            return pooled, pooled_covariance, math.inf
        return pooled, pooled_covariance, 0.5 * (logdet + logdet_precision + residual)

    def objective(parameters: np.ndarray) -> float:
        try:
            return fit_given(between(parameters))[2]
        except (np.linalg.LinAlgError, OverflowError, ValueError):
            return math.inf

    starts = [
        np.array([-6.0, 0.0, -6.0]),
        np.array([-2.0, 0.0, -2.0]),
        np.array([-4.0, 0.05, -4.0]),
    ]
    results = [
        optimize.minimize(
            objective,
            start,
            method="L-BFGS-B",
            bounds=[(-12.0, 3.0), (-5.0, 5.0), (-12.0, 3.0)],
            options={"maxiter": 2000, "ftol": 1e-12},
        )
        for start in starts
    ]
    optimum = min(results, key=lambda item: float(item.fun) if math.isfinite(item.fun) else math.inf)
    T = between(optimum.x)
    pooled, pooled_covariance, _ = fit_given(T)
    return pooled, pooled_covariance, T, bool(optimum.success and np.all(np.isfinite(pooled)))


def _normalize_covariate(value: str) -> str:
    return " ".join(str(value).strip().casefold().replace("_", " ").split())
