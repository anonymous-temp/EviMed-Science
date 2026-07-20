"""Binomial fixed-effect and logistic-normal GLMM prevalence synthesis."""
from __future__ import annotations

import math

import numpy as np
from pydantic import BaseModel, Field, model_validator
from scipy import optimize, stats
from scipy.special import expit, gammaln, logsumexp


class PrevalenceStudy(BaseModel):
    study_id: str = Field(min_length=1)
    events: int = Field(ge=0)
    total: int = Field(gt=0)

    @model_validator(mode="after")
    def validate_counts(self):
        if self.events > self.total:
            raise ValueError("events cannot exceed total")
        return self


class PrevalenceResult(BaseModel):
    schema_version: int = 1
    estimator: str
    model: str
    n_studies: int
    total_events: int
    total_participants: int
    pooled_proportion: float = Field(ge=0, le=1)
    ci_lower: float = Field(ge=0, le=1)
    ci_upper: float = Field(ge=0, le=1)
    pooled_logit: float
    standard_error_logit: float
    tau_squared: float = Field(ge=0)
    i_squared_logit: float = Field(ge=0, le=100)
    prediction_interval: tuple[float, float] | None = None
    converged: bool
    quadrature_points: int = 0
    log_likelihood: float | None = None
    diagnostics: dict = Field(default_factory=dict)


def run_prevalence(
    studies: list[PrevalenceStudy],
    *,
    model: str = "random",
    quadrature_points: int = 150,
) -> PrevalenceResult:
    """Synthesize proportions without double-arcsine primary inference."""
    studies = [
        item if isinstance(item, PrevalenceStudy) else PrevalenceStudy.model_validate(item)
        for item in studies
    ]
    if len(studies) < 2:
        raise ValueError("prevalence synthesis requires at least two studies")
    if model == "fixed":
        return _fixed_binomial(studies)
    if model != "random":
        raise ValueError("model must be 'fixed' or 'random'")
    if quadrature_points < 20:
        raise ValueError("logistic-normal GLMM requires at least 20 quadrature points")
    return _logistic_normal_glmm(studies, quadrature_points=quadrature_points)


def _fixed_binomial(studies: list[PrevalenceStudy]) -> PrevalenceResult:
    events = sum(item.events for item in studies)
    total = sum(item.total for item in studies)
    proportion = events / total
    lower, upper = _clopper_pearson(events, total)
    bounded = min(max(proportion, 1e-12), 1 - 1e-12)
    mu = float(math.log(bounded / (1 - bounded)))
    se = float(math.sqrt(1 / max(total * bounded * (1 - bounded), 1e-12)))
    return PrevalenceResult(
        estimator="BINOMIAL_FIXED_INTERCEPT",
        model="fixed",
        n_studies=len(studies),
        total_events=events,
        total_participants=total,
        pooled_proportion=proportion,
        ci_lower=lower,
        ci_upper=upper,
        pooled_logit=mu,
        standard_error_logit=se,
        tau_squared=0.0,
        i_squared_logit=0.0,
        converged=True,
        diagnostics={"boundary_case": events in {0, total}},
    )


def _logistic_normal_glmm(
    studies: list[PrevalenceStudy],
    *,
    quadrature_points: int,
) -> PrevalenceResult:
    events = np.asarray([item.events for item in studies], dtype=float)
    totals = np.asarray([item.total for item in studies], dtype=float)
    total_events = int(events.sum())
    total_participants = int(totals.sum())
    if total_events in {0, total_participants}:
        fixed = _fixed_binomial(studies)
        fixed.estimator = "LOGISTIC_NORMAL_BINOMIAL_GLMM"
        fixed.model = "random"
        fixed.quadrature_points = quadrature_points
        fixed.diagnostics = {
            **fixed.diagnostics,
            "boundary_fallback": "exact aggregate binomial interval",
        }
        return fixed

    nodes, weights = np.polynomial.hermite.hermgauss(quadrature_points)
    log_weights = np.log(weights) - 0.5 * math.log(math.pi)
    log_choose = gammaln(totals + 1) - gammaln(events + 1) - gammaln(totals - events + 1)

    def negative_log_likelihood(params: np.ndarray) -> float:
        mu = float(params[0])
        tau = float(math.exp(params[1]))
        eta = mu + math.sqrt(2.0) * tau * nodes[None, :]
        log_p = -np.logaddexp(0.0, -eta)
        log_one_minus_p = -np.logaddexp(0.0, eta)
        log_binomial = (
            log_choose[:, None]
            + events[:, None] * log_p
            + (totals - events)[:, None] * log_one_minus_p
        )
        value = -float(np.sum(logsumexp(log_binomial + log_weights[None, :], axis=1)))
        return value if math.isfinite(value) else 1e100

    aggregate = total_events / total_participants
    mu0 = math.log(aggregate / (1 - aggregate))
    starts = [
        np.array([mu0, math.log(tau)])
        for tau in (1e-4, 0.1, 0.5, 1.0)
    ]
    fits = [
        optimize.minimize(
            negative_log_likelihood,
            start,
            method="L-BFGS-B",
            bounds=[(-20.0, 20.0), (-9.210340371976184, 3.0)],
            options={"maxiter": 2000, "ftol": 1e-12, "gtol": 1e-8},
        )
        for start in starts
    ]
    fit = min(fits, key=lambda item: float(item.fun) if math.isfinite(item.fun) else math.inf)
    mu = float(fit.x[0])
    tau = float(math.exp(fit.x[1]))
    tau2 = tau * tau
    se_mu = _profile_mu_standard_error(
        negative_log_likelihood,
        mu=mu,
        log_tau=float(fit.x[1]),
        total_information=total_participants * expit(mu) * (1 - expit(mu)),
        tau=tau,
    )
    pooled = float(expit(mu))
    lower = float(expit(mu - 1.959963984540054 * se_mu))
    upper = float(expit(mu + 1.959963984540054 * se_mu))
    pred_lower = float(expit(mu - 1.959963984540054 * math.sqrt(tau2 + se_mu**2)))
    pred_upper = float(expit(mu + 1.959963984540054 * math.sqrt(tau2 + se_mu**2)))
    latent_i2 = float(100 * tau2 / (tau2 + math.pi**2 / 3)) if tau2 > 0 else 0.0
    return PrevalenceResult(
        estimator="LOGISTIC_NORMAL_BINOMIAL_GLMM",
        model="random",
        n_studies=len(studies),
        total_events=total_events,
        total_participants=total_participants,
        pooled_proportion=pooled,
        ci_lower=min(lower, pooled),
        ci_upper=max(upper, pooled),
        pooled_logit=mu,
        standard_error_logit=se_mu,
        tau_squared=tau2,
        i_squared_logit=latent_i2,
        prediction_interval=(min(pred_lower, pooled), max(pred_upper, pooled)),
        converged=bool(fit.success),
        quadrature_points=quadrature_points,
        log_likelihood=-float(fit.fun),
        diagnostics={
            "optimizer": "L-BFGS-B multi-start",
            "optimizer_message": str(fit.message),
            "quadrature": "high-order Gauss-Hermite marginal likelihood",
            "primary_scale": "logit",
        },
    )


def _profile_mu_standard_error(nll, *, mu: float, log_tau: float, total_information: float, tau: float) -> float:
    if tau < 1e-3:
        return float(math.sqrt(1 / max(total_information, 1e-12)))
    step = 1e-4 * max(1.0, abs(mu))
    center = nll(np.array([mu, log_tau]))
    curvature = (
        nll(np.array([mu + step, log_tau]))
        - 2 * center
        + nll(np.array([mu - step, log_tau]))
    ) / step**2
    if not math.isfinite(curvature) or curvature <= 0:
        return float(math.sqrt(1 / max(total_information, 1e-12) + tau * tau / 2))
    return float(math.sqrt(1 / curvature))


def _clopper_pearson(events: int, total: int, alpha: float = 0.05) -> tuple[float, float]:
    lower = 0.0 if events == 0 else float(stats.beta.ppf(alpha / 2, events, total - events + 1))
    upper = 1.0 if events == total else float(stats.beta.ppf(1 - alpha / 2, events + 1, total - events))
    return lower, upper
