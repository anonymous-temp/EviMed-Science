"""Participant-level two-stage IPD meta-analysis with one-stage sensitivities."""
from __future__ import annotations

import math
from typing import Any

import numpy as np
from pydantic import BaseModel, Field
from scipy import optimize

from new_meta.engines.meta_engine import random_effects_hksj, random_effects_reml
from new_meta.schemas.meta_result import StudyEffect


_Z_975 = 1.959963984540054
_RATIO_MEASURES = {"OR", "HR"}


class IPDParticipant(BaseModel):
    participant_id: str = ""
    treatment: int | None = None
    outcome: float | None = None
    time: float | None = None
    event: int | None = None
    covariates: dict[str, float | None] = Field(default_factory=dict)


class IPDStudyRecord(BaseModel):
    study_id: str = Field(min_length=1)
    design: str = "parallel_rct"
    participants: list[IPDParticipant] = Field(min_length=4)


class IPDMetaResult(BaseModel):
    schema_version: int = 1
    estimator: str = "TWO_STAGE_IPD_REML_HKSJ"
    outcome_type: str
    effect_measure: str
    n_studies: int
    n_participants: int
    pooled_effect: float
    ci_lower: float
    ci_upper: float
    tau_squared: float = Field(ge=0)
    i_squared: float = Field(ge=0, le=100)
    prediction_interval: tuple[float, float] | None = None
    study_effects: list[dict[str, Any]]
    effect_modification: dict[str, Any] | None = None
    one_stage_sensitivity: dict[str, Any]
    hksj_sensitivity: dict[str, float]
    converged: bool = True
    diagnostics: dict[str, Any] = Field(default_factory=dict)


def run_ipd_meta(
    records: list[IPDStudyRecord | dict],
    *,
    outcome_type: str,
    effect_measure: str,
    covariates: list[str] | None = None,
    effect_modifier: str | None = None,
) -> IPDMetaResult:
    """Fit study-specific participant-level models and pool their coefficients."""
    studies = [
        item if isinstance(item, IPDStudyRecord) else IPDStudyRecord.model_validate(item)
        for item in records
    ]
    if len(studies) < 3:
        raise ValueError("IPD meta-analysis requires at least three studies")
    if any(study.design != "parallel_rct" for study in studies):
        raise ValueError("production IPD meta-analysis currently requires parallel_rct studies")
    outcome_type = str(outcome_type).strip().lower()
    measure = str(effect_measure).strip().upper()
    expected_measure = {"binary": "OR", "continuous": "MD", "time_to_event": "HR"}
    if outcome_type not in expected_measure or measure != expected_measure[outcome_type]:
        raise ValueError(
            f"{outcome_type or 'unknown'} IPD outcome requires {expected_measure.get(outcome_type, 'a supported measure')}"
        )
    covariates = list(dict.fromkeys(str(value).strip() for value in covariates or [] if str(value).strip()))
    modifier = str(effect_modifier or "").strip() or None
    if modifier and modifier not in covariates:
        covariates.append(modifier)

    effects: list[StudyEffect] = []
    interactions: list[StudyEffect] = []
    study_rows: list[dict[str, Any]] = []
    prepared_for_one_stage: list[dict[str, Any]] = []
    for study in studies:
        prepared = _prepare_study(study, outcome_type, covariates, modifier)
        prepared_for_one_stage.append(prepared)
        if outcome_type == "binary":
            beta, covariance = _fit_logistic(prepared["X"], prepared["outcome"])
            study_model = "logistic_regression"
        elif outcome_type == "continuous":
            beta, covariance = _fit_linear(prepared["X"], prepared["outcome"])
            study_model = "linear_regression"
        else:
            beta, covariance = _fit_cox(
                prepared["X_no_intercept"], prepared["time"], prepared["event"]
            )
            study_model = "cox_partial_likelihood"
        treatment_index = 1 if outcome_type != "time_to_event" else 0
        yi = float(beta[treatment_index])
        vi = float(covariance[treatment_index, treatment_index])
        if not math.isfinite(vi) or vi <= 0:
            raise ValueError(f"study {study.study_id} treatment precision is not identifiable")
        effects.append(
            StudyEffect(
                study_id=study.study_id,
                study_label=study.study_id,
                yi=yi,
                vi=vi,
                se=math.sqrt(vi),
            )
        )
        lower, upper = yi - _Z_975 * math.sqrt(vi), yi + _Z_975 * math.sqrt(vi)
        study_rows.append({
            "study_id": study.study_id,
            "n_participants": len(study.participants),
            "events": int(np.sum(prepared.get("event", prepared.get("outcome", []))))
            if outcome_type != "continuous"
            else None,
            "analysis_effect": yi,
            "standard_error": math.sqrt(vi),
            "effect": math.exp(yi) if measure in _RATIO_MEASURES else yi,
            "ci_lower": math.exp(lower) if measure in _RATIO_MEASURES else lower,
            "ci_upper": math.exp(upper) if measure in _RATIO_MEASURES else upper,
            "model": study_model,
        })
        if modifier:
            interaction_index = len(beta) - 1
            interaction_vi = float(covariance[interaction_index, interaction_index])
            interactions.append(
                StudyEffect(
                    study_id=study.study_id,
                    study_label=study.study_id,
                    yi=float(beta[interaction_index]),
                    vi=interaction_vi,
                    se=math.sqrt(interaction_vi),
                )
            )

    reml = random_effects_reml(effects, measure, "Participant-level treatment effect")
    hksj = random_effects_hksj(effects, measure, "Participant-level treatment effect")
    interaction_result = None
    if interactions:
        interaction = random_effects_reml(interactions, "MD", "Treatment-covariate interaction")
        interaction_result = {
            "modifier": modifier,
            "coefficient": interaction.pooled_effect,
            "ci_lower": interaction.ci_lower,
            "ci_upper": interaction.ci_upper,
            "tau_squared": interaction.tau_squared,
            "scale": "log_ratio_per_unit" if measure in _RATIO_MEASURES else "difference_per_unit",
        }
    one_stage = _one_stage_sensitivity(
        prepared_for_one_stage,
        outcome_type=outcome_type,
        measure=measure,
        covariates=covariates,
        modifier=modifier,
    )
    return IPDMetaResult(
        outcome_type=outcome_type,
        effect_measure=measure,
        n_studies=len(studies),
        n_participants=sum(len(study.participants) for study in studies),
        pooled_effect=reml.pooled_effect,
        ci_lower=reml.ci_lower,
        ci_upper=reml.ci_upper,
        tau_squared=reml.tau_squared,
        i_squared=reml.i_squared,
        prediction_interval=reml.prediction_interval,
        study_effects=study_rows,
        effect_modification=interaction_result,
        one_stage_sensitivity=one_stage,
        hksj_sensitivity={
            "effect": hksj.pooled_effect,
            "ci_lower": hksj.ci_lower,
            "ci_upper": hksj.ci_upper,
        },
        diagnostics={
            "study_model": {
                "binary": "logistic_regression",
                "continuous": "linear_regression",
                "time_to_event": "cox_partial_likelihood",
            }[outcome_type],
            "participant_clustering": "study_stratified_two_stage",
            "missing_data": "complete_required_no_silent_deletion",
            "modifier_centering": "within_study" if modifier else "not_applicable",
            "covariates": covariates,
            "effect_modifier": modifier,
        },
    )


def _prepare_study(
    study: IPDStudyRecord,
    outcome_type: str,
    covariates: list[str],
    modifier: str | None,
) -> dict[str, Any]:
    participants = study.participants
    treatments = np.array([item.treatment for item in participants], dtype=object)
    if any(value is None or value not in {0, 1} for value in treatments):
        raise ValueError("IPD synthesis requires complete participant data with treatment coded 0/1")
    treatment = treatments.astype(float)
    if set(treatment.tolist()) != {0.0, 1.0}:
        raise ValueError(f"study {study.study_id} must contain both randomized arms")
    covariate_columns = []
    for name in covariates:
        values = [item.covariates.get(name) for item in participants]
        if any(value is None or not math.isfinite(float(value)) for value in values):
            raise ValueError("IPD synthesis requires complete participant data for all model covariates")
        column = np.asarray(values, dtype=float)
        covariate_columns.append(column - float(np.mean(column)))
    base = [np.ones(len(participants), dtype=float), treatment, *covariate_columns]
    if modifier:
        modifier_index = covariates.index(modifier)
        base.append(treatment * covariate_columns[modifier_index])
    X = np.column_stack(base)
    X_no_intercept = X[:, 1:]
    prepared = {
        "study_id": study.study_id,
        "X": X,
        "X_no_intercept": X_no_intercept,
        "treatment": treatment,
    }
    if outcome_type in {"binary", "continuous"}:
        values = [item.outcome for item in participants]
        if any(value is None or not math.isfinite(float(value)) for value in values):
            raise ValueError("IPD synthesis requires complete participant data for the outcome")
        outcome = np.asarray(values, dtype=float)
        if outcome_type == "binary" and not set(outcome.tolist()) <= {0.0, 1.0}:
            raise ValueError("binary IPD outcome must be coded 0/1")
        prepared["outcome"] = outcome
    else:
        times = [item.time for item in participants]
        events = [item.event for item in participants]
        if any(
            time is None or not math.isfinite(float(time)) or float(time) <= 0
            for time in times
        ) or any(event is None or event not in {0, 1} for event in events):
            raise ValueError("IPD synthesis requires complete participant data for time and event")
        prepared["time"] = np.asarray(times, dtype=float)
        prepared["event"] = np.asarray(events, dtype=float)
        if np.sum(prepared["event"]) == 0:
            raise ValueError(f"study {study.study_id} has no observed events")
    return prepared


def _fit_logistic(X: np.ndarray, outcome: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    def objective(beta: np.ndarray) -> tuple[float, np.ndarray]:
        with np.errstate(over="ignore", divide="ignore", invalid="ignore"):
            eta = X @ beta
            value = float(np.sum(np.logaddexp(0.0, eta) - outcome * eta))
            probability = 1.0 / (1.0 + np.exp(-np.clip(eta, -40, 40)))
            gradient = X.T @ (probability - outcome)
        if not math.isfinite(value) or not np.all(np.isfinite(gradient)):
            return math.inf, np.zeros_like(beta)
        return value, gradient

    optimum = optimize.minimize(
        lambda beta: objective(beta)[0],
        np.zeros(X.shape[1], dtype=float),
        jac=lambda beta: objective(beta)[1],
        method="BFGS",
        options={"maxiter": 2000, "gtol": 1e-9},
    )
    if not optimum.success and np.linalg.norm(objective(optimum.x)[1]) > 1e-5:
        raise ValueError(f"participant-level logistic model did not converge: {optimum.message}")
    with np.errstate(over="ignore", divide="ignore", invalid="ignore"):
        eta = X @ optimum.x
        probability = 1.0 / (1.0 + np.exp(-np.clip(eta, -40, 40)))
        weights = probability * (1.0 - probability)
        information = X.T @ (X * weights[:, None])
    if np.linalg.matrix_rank(information) < X.shape[1]:
        raise ValueError("participant-level logistic effect is not identifiable")
    return optimum.x, np.linalg.inv(information)


def _fit_linear(X: np.ndarray, outcome: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if np.linalg.matrix_rank(X) < X.shape[1]:
        raise ValueError("participant-level linear model is rank deficient")
    beta = np.linalg.lstsq(X, outcome, rcond=None)[0]
    with np.errstate(over="ignore", divide="ignore", invalid="ignore"):
        residual = outcome - X @ beta
    df = len(outcome) - X.shape[1]
    if df <= 0:
        raise ValueError("participant-level linear model has no residual degrees of freedom")
    sigma_squared = float(residual @ residual / df)
    covariance = sigma_squared * np.linalg.inv(X.T @ X)
    return beta, covariance


def _cox_components(
    beta: np.ndarray,
    X: np.ndarray,
    time: np.ndarray,
    event: np.ndarray,
) -> tuple[float, np.ndarray, np.ndarray]:
    eta = X @ beta
    exp_eta = np.exp(np.clip(eta, -40, 40))
    loglik = 0.0
    score = np.zeros(X.shape[1], dtype=float)
    information = np.zeros((X.shape[1], X.shape[1]), dtype=float)
    for event_time in np.unique(time[event == 1]):
        event_mask = (time == event_time) & (event == 1)
        risk_mask = time >= event_time
        d = int(np.sum(event_mask))
        risk_weight = exp_eta[risk_mask]
        risk_X = X[risk_mask]
        denominator = float(np.sum(risk_weight))
        mean = np.sum(risk_X * risk_weight[:, None], axis=0) / denominator
        second = (risk_X.T * risk_weight) @ risk_X / denominator
        loglik += float(np.sum(eta[event_mask])) - d * math.log(denominator)
        score += np.sum(X[event_mask], axis=0) - d * mean
        information += d * (second - np.outer(mean, mean))
    return -loglik, -score, information


def _fit_cox(X: np.ndarray, time: np.ndarray, event: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    optimum = optimize.minimize(
        lambda beta: _cox_components(beta, X, time, event)[0],
        np.zeros(X.shape[1], dtype=float),
        jac=lambda beta: _cox_components(beta, X, time, event)[1],
        method="BFGS",
        options={"maxiter": 2000, "gtol": 1e-8},
    )
    information = _cox_components(optimum.x, X, time, event)[2]
    if (not optimum.success and np.linalg.norm(_cox_components(optimum.x, X, time, event)[1]) > 1e-5) or np.linalg.matrix_rank(information) < X.shape[1]:
        raise ValueError("participant-level Cox model did not converge or is not identifiable")
    return optimum.x, np.linalg.inv(information)


def _one_stage_sensitivity(
    prepared: list[dict[str, Any]],
    *,
    outcome_type: str,
    measure: str,
    covariates: list[str],
    modifier: str | None,
) -> dict[str, Any]:
    if outcome_type == "time_to_event":
        dimension = prepared[0]["X_no_intercept"].shape[1]

        def components(beta: np.ndarray):
            values = [
                _cox_components(beta, item["X_no_intercept"], item["time"], item["event"])
                for item in prepared
            ]
            return (
                sum(item[0] for item in values),
                sum((item[1] for item in values), np.zeros(dimension)),
                sum((item[2] for item in values), np.zeros((dimension, dimension))),
            )

        optimum = optimize.minimize(
            lambda beta: components(beta)[0],
            np.zeros(dimension),
            jac=lambda beta: components(beta)[1],
            method="BFGS",
            options={"maxiter": 2000, "gtol": 1e-8},
        )
        information = components(optimum.x)[2]
        covariance = np.linalg.inv(information)
        beta, variance = float(optimum.x[0]), float(covariance[0, 0])
        model = "stratified_cox_common_effect"
    else:
        blocks = []
        outcomes = []
        n_studies = len(prepared)
        for index, item in enumerate(prepared):
            n = len(item["treatment"])
            study_columns = np.zeros((n, n_studies), dtype=float)
            study_columns[:, index] = 1.0
            blocks.append(np.column_stack([study_columns, item["X"][:, 1:]]))
            outcomes.append(item["outcome"])
        X = np.vstack(blocks)
        y = np.concatenate(outcomes)
        if outcome_type == "binary":
            fitted, covariance = _fit_logistic(X, y)
        else:
            fitted, covariance = _fit_linear(X, y)
        beta = float(fitted[n_studies])
        variance = float(covariance[n_studies, n_studies])
        model = "fixed_study_intercepts"
    se = math.sqrt(variance)
    lower, upper = beta - _Z_975 * se, beta + _Z_975 * se
    return {
        "model": model,
        "effect": math.exp(beta) if measure in _RATIO_MEASURES else beta,
        "ci_lower": math.exp(lower) if measure in _RATIO_MEASURES else lower,
        "ci_upper": math.exp(upper) if measure in _RATIO_MEASURES else upper,
        "analysis_coefficient": beta,
        "standard_error": se,
    }
