"""Aggregate 2x2 Reitsma bivariate random-effects diagnostic meta-analysis.

The primary model follows the normal-normal REML formulation used by ``mada``:
logit sensitivity and logit false-positive rate are modeled jointly, with an
unstructured between-study covariance matrix.  The public production path is
restricted to one explicitly recorded common threshold.
"""
from __future__ import annotations

import math

import numpy as np
from pydantic import BaseModel, Field, model_validator
from scipy import optimize
from scipy.special import expit


class DiagnosticStudy(BaseModel):
    study_id: str = Field(min_length=1)
    true_positive: int = Field(ge=0)
    false_negative: int = Field(ge=0)
    false_positive: int = Field(ge=0)
    true_negative: int = Field(ge=0)
    threshold: str = ""

    @model_validator(mode="after")
    def validate_strata(self):
        if self.true_positive + self.false_negative <= 0:
            raise ValueError("diseased denominator must be positive")
        if self.false_positive + self.true_negative <= 0:
            raise ValueError("non-diseased denominator must be positive")
        return self


class DiagnosticAccuracyResult(BaseModel):
    schema_version: int = 1
    estimator: str
    n_studies: int
    summary_sensitivity: float = Field(ge=0, le=1)
    sensitivity_ci: tuple[float, float]
    summary_specificity: float = Field(ge=0, le=1)
    specificity_ci: tuple[float, float]
    summary_false_positive_rate: float = Field(ge=0, le=1)
    false_positive_rate_ci: tuple[float, float]
    diagnostic_odds_ratio: float = Field(gt=0)
    sroc_auc: float = Field(ge=0, le=1)
    between_variance_sensitivity: float = Field(ge=0)
    between_variance_specificity: float = Field(ge=0)
    between_variance_false_positive_rate: float = Field(ge=0)
    between_correlation: float = Field(ge=-1, le=1)
    converged: bool
    log_likelihood: float
    model_parameters: dict[str, float]
    diagnostics: dict = Field(default_factory=dict)


def run_diagnostic_accuracy(
    studies: list[DiagnosticStudy],
    *,
    threshold_policy: str = "common_required",
) -> DiagnosticAccuracyResult:
    """Fit a common-threshold Reitsma normal-normal bivariate REML model.

    ``unchecked_validation_fixture`` exists solely so a published statistical
    corpus without threshold metadata can test numerical parity.  The compiled
    method executor does not allow callers to select this validation-only mode.
    """
    studies = [
        item if isinstance(item, DiagnosticStudy) else DiagnosticStudy.model_validate(item)
        for item in studies
    ]
    if len(studies) < 3:
        raise ValueError("bivariate diagnostic meta-analysis requires at least three studies")
    if threshold_policy not in {"common_required", "unchecked_validation_fixture"}:
        raise ValueError(f"unknown diagnostic threshold policy: {threshold_policy}")
    if threshold_policy == "common_required":
        thresholds = [" ".join(item.threshold.split()).casefold() for item in studies]
        if any(not item for item in thresholds):
            raise ValueError(
                "each diagnostic study requires a recorded threshold before synthesis"
            )
        if len(set(thresholds)) != 1:
            raise ValueError(
                "common-threshold synthesis requires one common threshold across studies"
            )

    # mada's default correction.control='all': if any cell is zero, add 0.5
    # to every cell in every study. This is intentionally not a per-study rule.
    raw_cells = np.asarray([
        [
            study.true_positive,
            study.false_negative,
            study.false_positive,
            study.true_negative,
        ]
        for study in studies
    ], dtype=float)
    correction_applied = bool(np.any(raw_cells == 0))
    analysis_cells = raw_cells + 0.5 if correction_applied else raw_cells.copy()
    y_rows = []
    within = []
    sensitivities = []
    false_positive_rates = []
    for tp, fn, fp, tn in analysis_cells:
        sensitivity = tp / (tp + fn)
        false_positive_rate = fp / (fp + tn)
        sensitivities.append(sensitivity)
        false_positive_rates.append(false_positive_rate)
        y_rows.append([math.log(tp / fn), math.log(fp / tn)])
        within.append(np.diag([1 / tp + 1 / fn, 1 / fp + 1 / tn]))
    y = np.asarray(y_rows, dtype=float)
    within_cov = np.asarray(within, dtype=float)

    def covariance(params: np.ndarray) -> np.ndarray:
        sd_sens = math.exp(float(params[0]))
        sd_spec = math.exp(float(params[1]))
        rho = math.tanh(float(params[2]))
        return np.array([
            [sd_sens**2, rho * sd_sens * sd_spec],
            [rho * sd_sens * sd_spec, sd_spec**2],
        ])

    def profile(params: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
        between = covariance(params)
        precisions = []
        for matrix in within_cov:
            precisions.append(np.linalg.inv(matrix + between))
        precision_sum = np.sum(precisions, axis=0)
        covariance_mu = np.linalg.inv(precision_sum)
        score = sum((precision @ row for precision, row in zip(precisions, y)), np.zeros(2))
        mu = covariance_mu @ score
        log_determinant_sum = 0.0
        quadratic = 0.0
        for row, matrix in zip(y, within_cov):
            total_cov = matrix + between
            sign, logdet = np.linalg.slogdet(total_cov)
            if sign <= 0:
                return 1e100, mu, covariance_mu
            residual = row - mu
            log_determinant_sum += float(logdet)
            quadratic += float(residual.T @ np.linalg.solve(total_cov, residual))
        precision_sign, precision_logdet = np.linalg.slogdet(precision_sum)
        if precision_sign <= 0:
            return 1e100, mu, covariance_mu
        # Restricted log-likelihood for the stacked bivariate intercept model.
        n_observations = int(y.size)
        n_fixed_effects = int(y.shape[1])
        nll = 0.5 * (
            (n_observations - n_fixed_effects) * math.log(2 * math.pi)
            + log_determinant_sum
            + float(precision_logdet)
            + quadratic
        )
        return float(nll), mu, covariance_mu

    def objective(params: np.ndarray) -> float:
        value, _, _ = profile(params)
        return value

    starts = [
        np.array([math.log(sd1), math.log(sd2), rho_z])
        for sd1, sd2, rho_z in (
            (1e-4, 1e-4, 0.0),
            (0.2, 0.2, 0.0),
            (0.5, 0.5, -0.5),
            (1.0, 1.0, 0.5),
        )
    ]
    bounds = [(-9.210340371976184, 3.0), (-9.210340371976184, 3.0), (-3.8, 3.8)]
    fits = [
        optimize.minimize(
            objective,
            start,
            method="L-BFGS-B",
            bounds=bounds,
            options={"maxiter": 3000, "ftol": 1e-12, "gtol": 1e-8},
        )
        for start in starts
    ]
    fit = min(fits, key=lambda item: float(item.fun) if math.isfinite(item.fun) else math.inf)
    nll, mu, covariance_mu = profile(fit.x)
    between = covariance(fit.x)
    se = np.sqrt(np.maximum(np.diag(covariance_mu), 0))
    sensitivity = float(expit(mu[0]))
    false_positive_rate = float(expit(mu[1]))
    specificity = 1.0 - false_positive_rate
    sens_ci = (
        float(expit(mu[0] - 1.959963984540054 * se[0])),
        float(expit(mu[0] + 1.959963984540054 * se[0])),
    )
    fpr_ci = (
        float(expit(mu[1] - 1.959963984540054 * se[1])),
        float(expit(mu[1] + 1.959963984540054 * se[1])),
    )
    spec_ci = (1.0 - fpr_ci[1], 1.0 - fpr_ci[0])
    rho = float(between[0, 1] / math.sqrt(max(between[0, 0] * between[1, 1], 1e-30)))
    tau_sensitivity = float(math.sqrt(between[0, 0]))
    tau_false_positive_rate = float(math.sqrt(between[1, 1]))
    beta = math.log(max(tau_false_positive_rate, 1e-30) / max(tau_sensitivity, 1e-30))
    lambda_value = (
        math.sqrt(max(tau_false_positive_rate, 1e-30) / max(tau_sensitivity, 1e-30))
        * float(mu[0])
        - math.sqrt(max(tau_sensitivity, 1e-30) / max(tau_false_positive_rate, 1e-30))
        * float(mu[1])
    )
    fpr_grid = np.arange(1, 100, dtype=float) / 100.0
    sroc_values = expit(
        lambda_value * math.exp(-beta / 2)
        + math.exp(-beta) * np.log(fpr_grid / (1 - fpr_grid))
    )
    # Match mada::AUC.default's documented 99-point trapezoidal calculation.
    sroc_auc = float(
        (sroc_values[0] / 2 + np.sum(sroc_values[1:-1]) + sroc_values[-1] / 2)
        / len(fpr_grid)
    )
    jacobian_log = float(np.sum(
        np.log(1 / (np.asarray(sensitivities) * (1 - np.asarray(sensitivities))))
        + np.log(
            1
            / (
                np.asarray(false_positive_rates)
                * (1 - np.asarray(false_positive_rates))
            )
        )
    ))
    return DiagnosticAccuracyResult(
        estimator="REITSMA_BIVARIATE_REML",
        n_studies=len(studies),
        summary_sensitivity=sensitivity,
        sensitivity_ci=sens_ci,
        summary_specificity=specificity,
        specificity_ci=spec_ci,
        summary_false_positive_rate=false_positive_rate,
        false_positive_rate_ci=fpr_ci,
        diagnostic_odds_ratio=float(math.exp(mu[0] - mu[1])),
        sroc_auc=sroc_auc,
        between_variance_sensitivity=float(between[0, 0]),
        between_variance_specificity=float(between[1, 1]),
        between_variance_false_positive_rate=float(between[1, 1]),
        between_correlation=max(-1.0, min(1.0, rho)),
        converged=bool(fit.success),
        log_likelihood=-nll + jacobian_log,
        model_parameters={
            "logit_sensitivity": float(mu[0]),
            "logit_false_positive_rate": float(mu[1]),
            "se_logit_sensitivity": float(se[0]),
            "se_logit_false_positive_rate": float(se[1]),
            "tau_sensitivity": tau_sensitivity,
            "tau_false_positive_rate": tau_false_positive_rate,
            "rho": max(-1.0, min(1.0, rho)),
        },
        diagnostics={
            "continuity_corrected_studies": len(studies) if correction_applied else 0,
            "continuity_correction_scope": "all",
            "continuity_correction": 0.5,
            "threshold_policy": threshold_policy,
            "common_threshold": (
                " ".join(studies[0].threshold.split())
                if threshold_policy == "common_required"
                else None
            ),
            "optimizer": "profiled REML L-BFGS-B multi-start",
            "optimizer_message": str(fit.message),
            "restricted_log_likelihood_transformed": -nll,
            "jacobian_log_adjustment": jacobian_log,
            "primary_scales": ["logit_sensitivity", "logit_false_positive_rate"],
            "sroc_parameterization": "Rutter-Gatsonis derived from Reitsma",
        },
    )
