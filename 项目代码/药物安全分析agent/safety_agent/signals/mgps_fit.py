"""Maximum-likelihood fitting and validated artifacts for the GPS prior.

Fitting is an offline operation over a complete frozen drug-event matrix.
Per-pair scoring remains a deterministic function of one table and the
validated prior produced here.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.optimize import minimize
from scipy.special import expit, gammaln, logsumexp

from .disproportionality import MGPSPrior

_ARTIFACT_SCHEMA_VERSION = 1
_OPTIMIZER_VERSION = "gps-mle-lbfgsb-multistart-v2"
_DEFAULT_MAX_ITERATIONS = 2_000


@dataclass(frozen=True)
class MGPSFitResult:
    prior: MGPSPrior
    negative_log_likelihood: float
    converged: bool
    iterations: int
    observations: int
    data_fingerprint: str
    message: str
    optimizer_version: str = _OPTIMIZER_VERSION
    max_iterations: int = _DEFAULT_MAX_ITERATIONS
    successful_starts: int = 0
    near_optimal_starts: int = 0
    parameter_agreement_starts: int = 0
    boundary_parameters: tuple[str, ...] = ()


def gps_scope_fingerprint(
    *,
    date_from: str | None,
    date_to: str | None,
    role_codes: tuple[str, ...] = ("PS",),
    deduplication: str = "latest_case_version",
    drug_universe: str = "all_snapshot_normalized_drugs",
    event_universe: str = "all_snapshot_reactions",
    zero_policy: str = "retain_complete_matrix",
    matrix_generation_version: str = "gps-matrix-v1",
    routes: tuple[str, ...] = (),
    background_date_from: str | None = None,
    background_date_to: str | None = None,
) -> str:
    """Fingerprint every analysis-universe choice that changes a GPS fit."""
    payload = {
        "date_from": date_from,
        "date_to": date_to,
        "role_codes": sorted(set(role_codes)),
        "deduplication": deduplication,
        "drug_universe": drug_universe,
        "event_universe": event_universe,
        "zero_policy": zero_policy,
        "matrix_generation_version": matrix_generation_version,
    }
    # Preserve existing artifact identities for the historical default scope;
    # only scope extensions that materially change the matrix add fields.
    if routes:
        payload["routes"] = sorted(set(routes))
    if background_date_from is not None:
        payload["background_date_from"] = background_date_from
    if background_date_to is not None:
        payload["background_date_to"] = background_date_to
    return hashlib.sha256(_canonical_json(payload)).hexdigest()


def gps_prior_fit_id(
    *,
    data_fingerprint: str,
    alpha1: float,
    beta1: float,
    alpha2: float,
    beta2: float,
    weight: float,
    optimizer_version: str = _OPTIMIZER_VERSION,
    max_iterations: int = _DEFAULT_MAX_ITERATIONS,
) -> str:
    """Identify the resulting parameters, source data, and fit configuration."""
    payload = {
        "data_fingerprint": data_fingerprint,
        "parameters": [alpha1, beta1, alpha2, beta2, weight],
        "optimizer_version": optimizer_version,
        "max_iterations": max_iterations,
    }
    return hashlib.sha256(_canonical_json(payload)).hexdigest()[:16]


def write_gps_fit_artifact(
    result: MGPSFitResult,
    path: str | Path,
    *,
    snapshot_id: str,
    snapshot_sha256: str,
    scope_fingerprint: str,
) -> Path:
    """Persist a paper-grade fit bound to one snapshot and matrix scope."""
    _validate_paper_grade_fit(result)
    target = Path(path)
    payload = {
        "schema_version": _ARTIFACT_SCHEMA_VERSION,
        "statistics_version": "gps-v2",
        "snapshot_id": snapshot_id,
        "snapshot_sha256": snapshot_sha256,
        "scope_fingerprint": scope_fingerprint,
        "data_fingerprint": result.data_fingerprint,
        "prior": {
            "alpha1": result.prior.alpha1,
            "beta1": result.prior.beta1,
            "alpha2": result.prior.alpha2,
            "beta2": result.prior.beta2,
            "weight": result.prior.weight,
            "fit_id": result.prior.fit_id,
        },
        "fit": {
            "negative_log_likelihood": result.negative_log_likelihood,
            "converged": result.converged,
            "iterations": result.iterations,
            "observations": result.observations,
            "message": result.message,
            "optimizer_version": result.optimizer_version,
            "max_iterations": result.max_iterations,
            "successful_starts": result.successful_starts,
            "near_optimal_starts": result.near_optimal_starts,
            "parameter_agreement_starts": result.parameter_agreement_starts,
            "boundary_parameters": list(result.boundary_parameters),
        },
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return target


def load_gps_prior_artifact(
    path: str | Path,
    *,
    expected_snapshot_id: str,
    expected_snapshot_sha256: str,
    expected_scope_fingerprint: str,
) -> MGPSPrior:
    """Load a fit only when its snapshot, scope, and diagnostics all match."""
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if payload.get("schema_version") != _ARTIFACT_SCHEMA_VERSION:
        raise ValueError("unsupported GPS prior artifact schema")
    if payload.get("statistics_version") != "gps-v2":
        raise ValueError("GPS prior artifact statistics version mismatch")
    if payload.get("snapshot_id") != expected_snapshot_id:
        raise ValueError("GPS prior artifact snapshot does not match the FAERS snapshot")
    if payload.get("snapshot_sha256") != expected_snapshot_sha256:
        raise ValueError("GPS prior artifact content hash does not match the FAERS snapshot")
    if payload.get("scope_fingerprint") != expected_scope_fingerprint:
        raise ValueError("GPS prior artifact analysis scope does not match the active scope")

    prior_payload = payload.get("prior")
    fit_payload = payload.get("fit")
    fingerprint = payload.get("data_fingerprint")
    if not isinstance(prior_payload, dict) or not isinstance(fit_payload, dict):
        raise ValueError("GPS prior artifact is missing parameters or fit diagnostics")
    if not isinstance(fingerprint, str):
        raise ValueError("GPS prior artifact is missing fit provenance")
    try:
        fit_id = str(prior_payload["fit_id"])
        prior = MGPSPrior(
            alpha1=float(prior_payload["alpha1"]),
            beta1=float(prior_payload["beta1"]),
            alpha2=float(prior_payload["alpha2"]),
            beta2=float(prior_payload["beta2"]),
            weight=float(prior_payload["weight"]),
            fitted=True,
            fit_id=fit_id,
        )
        result = MGPSFitResult(
            prior=prior,
            negative_log_likelihood=float(fit_payload["negative_log_likelihood"]),
            converged=fit_payload.get("converged") is True,
            iterations=int(fit_payload["iterations"]),
            observations=int(fit_payload["observations"]),
            data_fingerprint=fingerprint,
            message=str(fit_payload.get("message", "")),
            optimizer_version=str(fit_payload["optimizer_version"]),
            max_iterations=int(fit_payload["max_iterations"]),
            successful_starts=int(fit_payload["successful_starts"]),
            near_optimal_starts=int(fit_payload["near_optimal_starts"]),
            parameter_agreement_starts=int(
                fit_payload["parameter_agreement_starts"]
            ),
            boundary_parameters=tuple(str(v) for v in fit_payload["boundary_parameters"]),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("GPS prior artifact fit metadata is invalid") from error
    _validate_paper_grade_fit(result)
    expected_fit_id = gps_prior_fit_id(
        data_fingerprint=fingerprint,
        alpha1=prior.alpha1,
        beta1=prior.beta1,
        alpha2=prior.alpha2,
        beta2=prior.beta2,
        weight=prior.weight,
        optimizer_version=result.optimizer_version,
        max_iterations=result.max_iterations,
    )
    if fit_id != expected_fit_id:
        raise ValueError("GPS prior artifact fit identifier is inconsistent")
    return prior


def fit_mgps_prior(
    observed: np.ndarray | list[float],
    expected: np.ndarray | list[float],
    *,
    initial: MGPSPrior | None = None,
    max_iterations: int = _DEFAULT_MAX_ITERATIONS,
) -> MGPSFitResult:
    """Fit GPS hyperparameters by marginal mixture likelihood.

    Zero-count rows must be retained: dropping them changes the likelihood
    and would require an explicitly truncated model.
    """
    counts = np.asarray(observed, dtype=float)
    expected_counts = np.asarray(expected, dtype=float)
    if counts.ndim != 1 or expected_counts.ndim != 1 or counts.shape != expected_counts.shape:
        raise ValueError("observed and expected must be one-dimensional arrays of equal length")
    if counts.size < 5:
        raise ValueError("GPS fitting needs at least five drug-event pairs")
    if not isinstance(max_iterations, int) or max_iterations < 1:
        raise ValueError("max_iterations must be a positive integer")
    if not np.all(np.isfinite(counts)) or np.any(counts < 0):
        raise ValueError("observed counts must be finite and non-negative")
    if not np.all(counts == np.floor(counts)):
        raise ValueError("observed counts must be whole non-negative report counts")
    if not np.all(np.isfinite(expected_counts)) or np.any(expected_counts <= 0):
        raise ValueError("expected counts must be finite and positive")

    seed_prior = initial or MGPSPrior()
    starts = (
        _encode(seed_prior),
        _encode(MGPSPrior(0.1, 0.1, 1.0, 1.0, 0.5)),
        _encode(MGPSPrior(1.0, 1.0, 4.0, 2.0, 0.5)),
        _encode(MGPSPrior(0.3, 0.2, 2.5, 3.0, 0.1)),
        _encode(MGPSPrior(0.3, 0.2, 2.5, 3.0, 0.3)),
        _encode(MGPSPrior(0.3, 0.2, 2.5, 3.0, 0.7)),
        _encode(MGPSPrior(0.5, 0.2, 4.0, 0.7, 0.1)),
        _encode(MGPSPrior(0.2, 0.05, 1.0, 1.0, 0.1)),
        _encode(MGPSPrior(2.0, 0.5, 0.8, 1.0, 0.9)),
    )
    bounds = [(-8.0, 8.0)] * 5

    def objective(vector: np.ndarray) -> float:
        alpha1, beta1, alpha2, beta2, weight = _decode(vector)
        component1 = _log_negative_binomial(counts, expected_counts, alpha1, beta1)
        component2 = _log_negative_binomial(counts, expected_counts, alpha2, beta2)
        mixed = logsumexp(
            np.vstack((np.log(weight) + component1, np.log1p(-weight) + component2)),
            axis=0,
        )
        value = -float(np.sum(mixed))
        return value if np.isfinite(value) else float("inf")

    results = [
        minimize(
            objective,
            start,
            method="L-BFGS-B",
            bounds=bounds,
            options={"maxiter": max_iterations, "ftol": 1e-12, "gtol": 1e-7},
        )
        for start in starts
    ]
    converged = [
        result for result in results if bool(result.success) and np.isfinite(result.fun)
    ]
    if not converged:
        raise ArithmeticError("GPS fitting did not converge to a finite likelihood")
    best = min(converged, key=lambda result: float(result.fun))
    alpha1, beta1, alpha2, beta2, weight = _decode(best.x)
    if alpha1 / beta1 > alpha2 / beta2:
        alpha1, beta1, alpha2, beta2, weight = alpha2, beta2, alpha1, beta1, 1.0 - weight
    fingerprint = _fingerprint(counts, expected_counts)
    fit_id = gps_prior_fit_id(
        data_fingerprint=fingerprint,
        alpha1=alpha1,
        beta1=beta1,
        alpha2=alpha2,
        beta2=beta2,
        weight=weight,
        max_iterations=max_iterations,
    )
    prior = MGPSPrior(
        alpha1=alpha1,
        beta1=beta1,
        alpha2=alpha2,
        beta2=beta2,
        weight=weight,
        fitted=True,
        fit_id=fit_id,
    )
    tolerance = max(1e-6, abs(float(best.fun)) * 1e-7)
    best_parameters = np.asarray(
        (alpha1, beta1, alpha2, beta2, weight), dtype=float
    )
    near_optimal = [
        result
        for result in converged
        if float(result.fun) <= float(best.fun) + tolerance
    ]
    parameter_agreement_starts = sum(
        np.allclose(
            np.asarray(_canonical_parameters(result.x)),
            best_parameters,
            rtol=0.02,
            atol=0.01,
        )
        for result in near_optimal
    )
    return MGPSFitResult(
        prior=prior,
        negative_log_likelihood=float(best.fun),
        converged=True,
        iterations=int(best.nit),
        observations=int(counts.size),
        data_fingerprint=fingerprint,
        message=str(best.message),
        max_iterations=max_iterations,
        successful_starts=len(converged),
        near_optimal_starts=len(near_optimal),
        parameter_agreement_starts=parameter_agreement_starts,
        boundary_parameters=_boundary_parameters(best.x, bounds),
    )


def _validate_paper_grade_fit(result: MGPSFitResult) -> None:
    if not result.prior.fitted or not result.prior.fit_id:
        raise ValueError("only a fitted GPS prior can be written as an artifact")
    if not result.converged or not math.isfinite(result.negative_log_likelihood):
        raise ValueError("GPS fit must converge to a finite likelihood")
    if result.observations < 5 or result.iterations < 0:
        raise ValueError("GPS fit diagnostics are inconsistent")
    if result.optimizer_version != _OPTIMIZER_VERSION or result.max_iterations < 1:
        raise ValueError("GPS fit optimizer provenance is unsupported")
    if result.successful_starts < 2 or result.near_optimal_starts < 2:
        raise ValueError("GPS fit needs agreement from at least two optimizer starts")
    if not 2 <= result.parameter_agreement_starts <= result.near_optimal_starts:
        raise ValueError("GPS fit parameters need agreement from at least two starts")
    if result.near_optimal_starts > result.successful_starts:
        raise ValueError("GPS fit start diagnostics are inconsistent")
    if result.boundary_parameters:
        raise ValueError("GPS fit reached an optimizer boundary")
    if len(result.data_fingerprint) != 64:
        raise ValueError("GPS fit data fingerprint must be SHA-256")


def _boundary_parameters(
    vector: np.ndarray, bounds: list[tuple[float, float]], *, tolerance: float = 1e-5
) -> tuple[str, ...]:
    names = ("alpha1", "beta1", "alpha2", "beta2", "weight")
    return tuple(
        name
        for name, value, (lower, upper) in zip(names, vector, bounds)
        if value - lower <= tolerance or upper - value <= tolerance
    )


def _log_negative_binomial(
    observed: np.ndarray, expected: np.ndarray, alpha: float, beta: float
) -> np.ndarray:
    return (
        gammaln(alpha + observed)
        - gammaln(alpha)
        - gammaln(observed + 1.0)
        + alpha * np.log(beta)
        + observed * np.log(expected)
        - (alpha + observed) * np.log(beta + expected)
    )


def _encode(prior: MGPSPrior) -> np.ndarray:
    logit = np.log(prior.weight / (1.0 - prior.weight))
    return np.array(
        [
            np.log(prior.alpha1),
            np.log(prior.beta1),
            np.log(prior.alpha2),
            np.log(prior.beta2),
            logit,
        ],
        dtype=float,
    )


def _decode(vector: np.ndarray) -> tuple[float, float, float, float, float]:
    alpha1, beta1, alpha2, beta2 = (float(np.exp(value)) for value in vector[:4])
    weight = float(expit(vector[4]))
    return alpha1, beta1, alpha2, beta2, weight


def _canonical_parameters(
    vector: np.ndarray,
) -> tuple[float, float, float, float, float]:
    alpha1, beta1, alpha2, beta2, weight = _decode(vector)
    if alpha1 / beta1 > alpha2 / beta2:
        return alpha2, beta2, alpha1, beta1, 1.0 - weight
    return alpha1, beta1, alpha2, beta2, weight


def _fingerprint(observed: np.ndarray, expected: np.ndarray) -> str:
    digest = hashlib.sha256()
    digest.update(np.asarray(observed, dtype="<f8").tobytes())
    digest.update(np.asarray(expected, dtype="<f8").tobytes())
    return digest.hexdigest()


def _canonical_json(payload: object) -> bytes:
    return json.dumps(
        payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
