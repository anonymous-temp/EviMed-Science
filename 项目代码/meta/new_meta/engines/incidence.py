"""Poisson fixed-effect and Poisson-normal GLMM incidence-rate synthesis."""
from __future__ import annotations

import math
import re

import numpy as np
from pydantic import BaseModel, Field, field_validator
from scipy import optimize, stats
from scipy.special import gammaln, logsumexp


class IncidenceStudy(BaseModel):
    study_id: str = Field(min_length=1)
    events: int = Field(ge=0)
    person_time: float = Field(gt=0)
    time_unit: str = Field(min_length=1)

    @field_validator("time_unit")
    @classmethod
    def normalize_time_unit(cls, value: str) -> str:
        normalized = re.sub(r"[^a-z0-9]+", "_", str(value).strip().lower()).strip("_")
        if not normalized:
            raise ValueError("time_unit is required")
        return normalized


class IncidenceResult(BaseModel):
    schema_version: int = 1
    estimator: str
    model: str
    n_studies: int
    total_events: int
    total_person_time: float = Field(gt=0)
    time_unit: str = Field(min_length=1)
    pooled_rate: float = Field(ge=0)
    ci_lower: float = Field(ge=0)
    ci_upper: float = Field(ge=0)
    pooled_log_rate: float
    standard_error_log_rate: float = Field(gt=0)
    tau_squared: float = Field(ge=0)
    i_squared_log_rate: float = Field(ge=0, le=100)
    prediction_interval: tuple[float, float] | None = None
    converged: bool
    quadrature_points: int = 0
    log_likelihood: float | None = None
    diagnostics: dict = Field(default_factory=dict)


def run_incidence(
    studies: list[IncidenceStudy],
    *,
    model: str = "random",
    quadrature_points: int = 150,
) -> IncidenceResult:
    """Synthesize one incidence-rate stratum on one harmonized time scale."""
    studies = [
        item if isinstance(item, IncidenceStudy) else IncidenceStudy.model_validate(item)
        for item in studies
    ]
    if len(studies) < 2:
        raise ValueError("incidence synthesis requires at least two studies")
    units = {item.time_unit for item in studies}
    if len(units) != 1:
        raise ValueError(
            "incidence synthesis requires the same canonical time unit for every study"
        )
    if model == "fixed":
        return _fixed_poisson(studies)
    if model != "random":
        raise ValueError("model must be 'fixed' or 'random'")
    if quadrature_points < 20:
        raise ValueError("Poisson-normal GLMM requires at least 20 quadrature points")
    if sum(item.events for item in studies) == 0:
        fixed = _fixed_poisson(studies)
        return fixed.model_copy(update={
            "estimator": "POISSON_NORMAL_INCIDENCE_GLMM",
            "model": "random",
            "quadrature_points": quadrature_points,
            "diagnostics": {
                **fixed.diagnostics,
                "boundary_fallback": "exact aggregate Poisson interval",
            },
        })
    return _poisson_normal_glmm(studies, quadrature_points=quadrature_points)


def _fixed_poisson(studies: list[IncidenceStudy]) -> IncidenceResult:
    events = sum(item.events for item in studies)
    person_time = float(sum(item.person_time for item in studies))
    pooled = events / person_time
    lower, upper = _exact_poisson_interval(events, person_time)
    effective_events = max(float(events), 0.5)
    log_rate = math.log(max(pooled, 0.5 / person_time))
    se = math.sqrt(1.0 / effective_events)
    return IncidenceResult(
        estimator="POISSON_FIXED_INTERCEPT",
        model="fixed",
        n_studies=len(studies),
        total_events=events,
        total_person_time=person_time,
        time_unit=studies[0].time_unit,
        pooled_rate=pooled,
        ci_lower=lower,
        ci_upper=upper,
        pooled_log_rate=log_rate,
        standard_error_log_rate=se,
        tau_squared=0.0,
        i_squared_log_rate=0.0,
        converged=True,
        log_likelihood=(
            events * math.log(person_time * max(pooled, 1e-300))
            - person_time * pooled
            - float(gammaln(events + 1))
            if events > 0
            else 0.0
        ),
        diagnostics={
            "primary_scale": "log incidence rate",
            "boundary_case": events == 0,
            "time_unit_harmonized": True,
        },
    )


def _poisson_normal_glmm(
    studies: list[IncidenceStudy],
    *,
    quadrature_points: int,
) -> IncidenceResult:
    events = np.asarray([item.events for item in studies], dtype=float)
    person_time = np.asarray([item.person_time for item in studies], dtype=float)
    log_person_time = np.log(person_time)
    log_factorial = gammaln(events + 1.0)
    nodes, weights = np.polynomial.hermite.hermgauss(quadrature_points)
    log_weights = np.log(weights) - 0.5 * math.log(math.pi)

    def negative_log_likelihood(params: np.ndarray) -> float:
        mu = float(params[0])
        tau = float(math.exp(params[1]))
        eta = mu + math.sqrt(2.0) * tau * nodes[None, :]
        log_lambda = log_person_time[:, None] + eta
        log_poisson = (
            events[:, None] * log_lambda
            - np.exp(np.clip(log_lambda, -745.0, 700.0))
            - log_factorial[:, None]
        )
        value = -float(np.sum(logsumexp(log_poisson + log_weights[None, :], axis=1)))
        return value if math.isfinite(value) else 1e100

    aggregate_rate = float(events.sum() / person_time.sum())
    mu0 = math.log(max(aggregate_rate, 1e-12))
    starts = [
        np.array([mu0, math.log(tau)], dtype=float)
        for tau in (1e-4, 0.1, 0.5, 1.0)
    ]
    fits = [
        optimize.minimize(
            negative_log_likelihood,
            start,
            method="L-BFGS-B",
            bounds=[(-30.0, 20.0), (-9.210340371976184, 2.0)],
            options={"maxiter": 3000, "ftol": 1e-13, "gtol": 1e-9},
        )
        for start in starts
    ]
    fit = min(fits, key=lambda item: float(item.fun) if math.isfinite(item.fun) else math.inf)
    mu = float(fit.x[0])
    log_tau = float(fit.x[1])
    tau = float(math.exp(log_tau))
    tau2 = tau * tau
    se_mu = _joint_standard_error(negative_log_likelihood, mu=mu, log_tau=log_tau)
    z = 1.959963984540054
    pooled = math.exp(mu)
    lower = math.exp(mu - z * se_mu)
    upper = math.exp(mu + z * se_mu)
    prediction_sd = math.sqrt(tau2 + se_mu * se_mu)
    prediction = (
        math.exp(mu - z * prediction_sd),
        math.exp(mu + z * prediction_sd),
    )
    positive_events = events[events > 0]
    typical_sampling_variance = (
        float(np.median(1.0 / positive_events)) if positive_events.size else 0.0
    )
    i_squared = (
        100.0 * tau2 / (tau2 + typical_sampling_variance)
        if tau2 > 0 and typical_sampling_variance > 0
        else 0.0
    )
    return IncidenceResult(
        estimator="POISSON_NORMAL_INCIDENCE_GLMM",
        model="random",
        n_studies=len(studies),
        total_events=int(events.sum()),
        total_person_time=float(person_time.sum()),
        time_unit=studies[0].time_unit,
        pooled_rate=pooled,
        ci_lower=min(lower, pooled),
        ci_upper=max(upper, pooled),
        pooled_log_rate=mu,
        standard_error_log_rate=se_mu,
        tau_squared=tau2,
        i_squared_log_rate=min(max(i_squared, 0.0), 100.0),
        prediction_interval=(min(prediction[0], pooled), max(prediction[1], pooled)),
        converged=bool(fit.success),
        quadrature_points=quadrature_points,
        log_likelihood=-float(fit.fun),
        diagnostics={
            "optimizer": "L-BFGS-B multi-start",
            "optimizer_message": str(fit.message),
            "quadrature": "high-order Gauss-Hermite marginal likelihood",
            "primary_scale": "log incidence rate",
            "time_unit_harmonized": True,
        },
    )


def _joint_standard_error(nll, *, mu: float, log_tau: float) -> float:
    point = np.array([mu, log_tau], dtype=float)
    steps = np.array([
        1e-4 * max(1.0, abs(mu)),
        1e-4 * max(1.0, abs(log_tau)),
    ])
    center = nll(point)
    hessian = np.zeros((2, 2), dtype=float)
    for index in range(2):
        delta = np.zeros(2)
        delta[index] = steps[index]
        hessian[index, index] = (
            nll(point + delta) - 2.0 * center + nll(point - delta)
        ) / (steps[index] ** 2)
    first = np.array([steps[0], 0.0])
    second = np.array([0.0, steps[1]])
    cross = (
        nll(point + first + second)
        - nll(point + first - second)
        - nll(point - first + second)
        + nll(point - first - second)
    ) / (4.0 * steps[0] * steps[1])
    hessian[0, 1] = hessian[1, 0] = cross
    try:
        covariance = np.linalg.inv(hessian)
        variance = float(covariance[0, 0])
    except np.linalg.LinAlgError:
        variance = math.nan
    if not math.isfinite(variance) or variance <= 0:
        curvature = hessian[0, 0]
        variance = 1.0 / curvature if curvature > 0 else 1.0
    return math.sqrt(variance)


def _exact_poisson_interval(
    events: int,
    person_time: float,
    alpha: float = 0.05,
) -> tuple[float, float]:
    lower = (
        0.0
        if events == 0
        else 0.5 * float(stats.chi2.ppf(alpha / 2.0, 2 * events)) / person_time
    )
    upper = (
        0.5
        * float(stats.chi2.ppf(1.0 - alpha / 2.0, 2 * (events + 1)))
        / person_time
    )
    return lower, upper
