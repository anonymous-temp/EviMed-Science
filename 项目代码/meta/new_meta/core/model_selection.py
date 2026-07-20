"""Deterministic meta-analysis model selection and sensitivity metadata."""
from __future__ import annotations

import math
from typing import Any

from new_meta.engines import meta_engine
from new_meta.schemas.meta_result import PooledEffect, StudyEffect
from new_meta.schemas.protocol import ResearchProtocol


def build_model_decision_and_sensitivity(
    *,
    study_effects: list[StudyEffect],
    protocol: ResearchProtocol,
    known_source_preferences: dict[str, Any] | None = None,
) -> tuple[PooledEffect, dict[str, Any], dict[str, Any]]:
    """Return primary pooled result plus auditable model-selection metadata.

    Generic reviews default to random-effects REML (with the existing k<3
    deterministic fixed-effect fallback inside the engine). A fixed-effect
    primary model is honored only when explicitly requested by the protocol or
    by a benchmark comparator, and fixed/random estimates are always persisted
    side by side for sensitivity review.
    """
    if len(study_effects) < 2:
        raise ValueError("Model selection requires at least two study effects.")

    prefs = known_source_preferences if isinstance(known_source_preferences, dict) else {}
    benchmark_reason = str(prefs.get("source_label") or prefs.get("source_id") or "").strip()
    protocol_model = str(getattr(protocol, "model_preference", "") or "").strip().lower()
    protocol_tau = str(getattr(protocol, "tau_estimator", "") or "REML").strip().upper()
    if protocol_tau not in {"DL", "REML", "HKSJ"}:
        protocol_tau = "REML"
    if protocol_model != "fixed" and protocol_tau == "DL" and not str(prefs.get("tau_estimator") or "").strip():
        protocol_tau = "REML"

    fixed = meta_engine.fixed_effect(
        study_effects,
        protocol.effect_measure,
        protocol.pico.outcome_primary,
    )
    random = _random_effect_result(
        study_effects,
        protocol.effect_measure,
        protocol.pico.outcome_primary,
        protocol_tau if protocol_tau in {"DL", "REML", "HKSJ"} else "REML",
    )

    requested_model = "fixed" if protocol_model == "fixed" else "random"
    if protocol_model == "fixed":
        primary = fixed
        primary_kind = "fixed"
        reason = (
            "fixed model selected by known-source benchmark comparator"
            if benchmark_reason
            else "fixed model selected by protocol"
        )
    else:
        primary = random
        primary_kind = primary.model
        reason = "random-effects REML selected for the primary generic synthesis"
        if random.model == "fixed" and len(study_effects) < 3:
            reason = (
                "generic random-effects synthesis was requested, but fewer than three studies contributed; "
                "the primary engine used a fixed-effect inverse-variance estimate as the recorded low-k safeguard"
            )

    decision = {
        "schema_version": 1,
        "primary_model": primary_kind,
        "primary_engine_model": primary.model,
        "requested_model": requested_model,
        "tau_estimator": primary.tau_estimator,
        "reason": reason,
        "k": len(study_effects),
        "benchmark_mode": bool(benchmark_reason),
        "benchmark_source": benchmark_reason,
        "generic_default": "random_REML",
        "low_k_random_fallback": bool(requested_model == "random" and primary.model == "fixed" and len(study_effects) < 3),
    }
    sensitivity = {
        "schema_version": 1,
        "fixed": _pooled_summary(fixed),
        "random": _pooled_summary(random),
        "direction_agreement": _direction_agreement(fixed, random),
        "absolute_log_difference": _abs_log_difference(fixed, random),
        "notes": _sensitivity_notes(fixed, random, decision),
    }
    return primary, decision, sensitivity


def _random_effect_result(
    study_effects: list[StudyEffect],
    effect_measure: str,
    outcome_name: str,
    tau_estimator: str,
) -> PooledEffect:
    if tau_estimator == "HKSJ":
        return meta_engine.random_effects_hksj(study_effects, effect_measure, outcome_name)
    if tau_estimator == "DL":
        return meta_engine.random_effects_dl(study_effects, effect_measure, outcome_name)
    return meta_engine.random_effects_reml(study_effects, effect_measure, outcome_name)


def _pooled_summary(result: PooledEffect) -> dict[str, Any]:
    return {
        "model": result.model,
        "tau_estimator": result.tau_estimator,
        "n_studies": result.n_studies,
        "effect_measure": result.effect_measure,
        "pooled_effect": result.pooled_effect,
        "ci_lower": result.ci_lower,
        "ci_upper": result.ci_upper,
        "p_value": result.p_value,
        "pooled_log": result.pooled_log,
        "ci_lower_log": result.ci_lower_log,
        "ci_upper_log": result.ci_upper_log,
        "i_squared": result.i_squared,
        "tau_squared": result.tau_squared,
        "prediction_interval": list(result.prediction_interval) if result.prediction_interval else None,
    }


def _direction_agreement(left: PooledEffect, right: PooledEffect) -> bool:
    if left.pooled_log is not None and right.pooled_log is not None:
        return _sign(left.pooled_log) == _sign(right.pooled_log)
    return _sign(left.pooled_effect - 1.0) == _sign(right.pooled_effect - 1.0)


def _abs_log_difference(left: PooledEffect, right: PooledEffect) -> float | None:
    if left.pooled_log is None or right.pooled_log is None:
        return None
    diff = abs(float(left.pooled_log) - float(right.pooled_log))
    return diff if math.isfinite(diff) else None


def _sign(value: float | None) -> int:
    if value is None or not math.isfinite(float(value)):
        return 0
    value = float(value)
    if value > 0:
        return 1
    if value < 0:
        return -1
    return 0


def _sensitivity_notes(
    fixed: PooledEffect,
    random: PooledEffect,
    decision: dict[str, Any],
) -> list[str]:
    notes: list[str] = []
    if decision.get("benchmark_mode"):
        notes.append("Fixed-effect primary model was retained to reproduce a declared benchmark comparator.")
    if fixed.n_studies < 3:
        notes.append("With fewer than three studies, random-effects tau-squared and prediction intervals are not stable.")
    if not _direction_agreement(fixed, random):
        notes.append("Fixed-effect and random-effects point estimates differ in direction; clinical interpretation requires review.")
    elif fixed.pooled_effect and random.pooled_effect:
        notes.append("Fixed-effect and random-effects point estimates are directionally consistent.")
    return notes
