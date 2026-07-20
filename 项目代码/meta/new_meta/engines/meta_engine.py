"""Meta-analysis core engine — fixed/random effects, heterogeneity, subgroup, sensitivity.

All computations are deterministic (numpy/scipy), no LLM involved.
"""
from __future__ import annotations

import numpy as np
from scipy import optimize, stats

from new_meta.schemas.meta_result import (
    StudyEffect, PooledEffect, LeaveOneOutResult,
    MetaRegressionResult, CumulativeResult,
)


def fixed_effect(studies: list[StudyEffect], effect_measure: str, outcome_name: str) -> PooledEffect:
    """Inverse-variance fixed-effect meta-analysis."""
    if len(studies) < 2:
        raise ValueError(f"Fixed-effect meta-analysis requires >= 2 studies, got {len(studies)}")

    yi = np.array([s.yi for s in studies])
    vi = np.array([s.vi for s in studies])

    if np.any(vi <= 0):
        raise ValueError("All study variances must be positive")
    if np.any(~np.isfinite(yi)) or np.any(~np.isfinite(vi)):
        raise ValueError("Study effect sizes and variances must be finite")

    wi = 1.0 / vi

    pooled = np.sum(wi * yi) / np.sum(wi)
    se_pooled = np.sqrt(1.0 / np.sum(wi))

    z = pooled / se_pooled
    p = 2 * (1 - stats.norm.cdf(abs(z)))
    ci_lower = pooled - 1.96 * se_pooled
    ci_upper = pooled + 1.96 * se_pooled

    q, q_p, i2, tau2, h2 = _heterogeneity(yi, vi, wi)

    # Assign weights (percentage)
    w_total = np.sum(wi)
    updated = []
    for s, w in zip(studies, wi):
        sc = s.model_copy()
        sc.weight = float(w / w_total * 100)
        updated.append(sc)

    return _build_pooled(
        outcome_name=outcome_name,
        n_studies=len(studies),
        effect_measure=effect_measure,
        model="fixed",
        pooled_log=float(pooled),
        se=se_pooled,
        p_value=float(p),
        q=float(q), q_p=float(q_p), i2=float(i2), tau2=float(tau2), h2=float(h2),
        studies=updated,
    )


def _sparse_random_effects_fallback(
    studies: list[StudyEffect],
    effect_measure: str,
    outcome_name: str,
) -> PooledEffect:
    """Use fixed-effect pooling when k<3 makes tau² and prediction intervals unstable."""
    result = fixed_effect(studies, effect_measure, outcome_name)
    result.model = "fixed"
    result.tau_squared = 0.0
    result.prediction_interval = None
    return result


def random_effects_dl(studies: list[StudyEffect], effect_measure: str, outcome_name: str) -> PooledEffect:
    """DerSimonian-Laird random-effects meta-analysis."""
    if len(studies) < 2:
        raise ValueError(f"Random-effects meta-analysis requires >= 2 studies, got {len(studies)}")
    if len(studies) < 3:
        return _sparse_random_effects_fallback(studies, effect_measure, outcome_name)

    yi = np.array([s.yi for s in studies])
    vi = np.array([s.vi for s in studies])
    k = len(studies)

    if np.any(vi <= 0):
        raise ValueError("All study variances must be positive")
    if np.any(~np.isfinite(yi)) or np.any(~np.isfinite(vi)):
        raise ValueError("Study effect sizes and variances must be finite")

    # Fixed-effect weights for Q calculation
    wi_fixed = 1.0 / vi
    pooled_fixed = np.sum(wi_fixed * yi) / np.sum(wi_fixed)

    q = float(np.sum(wi_fixed * (yi - pooled_fixed) ** 2))
    c = np.sum(wi_fixed) - np.sum(wi_fixed**2) / np.sum(wi_fixed)
    tau2 = max(0.0, (q - (k - 1)) / c)

    # Random-effects weights
    wi_star = 1.0 / (vi + tau2)
    pooled = float(np.sum(wi_star * yi) / np.sum(wi_star))
    se_pooled = float(np.sqrt(1.0 / np.sum(wi_star)))

    z = pooled / se_pooled
    p = 2 * (1 - stats.norm.cdf(abs(z)))
    q_p = 1 - stats.chi2.cdf(q, k - 1) if k > 1 else 1.0
    i2 = max(0.0, (q - (k - 1)) / q * 100) if q > 0 else 0.0
    h2 = q / (k - 1) if k > 1 else 1.0

    # Prediction interval
    pred_se = np.sqrt(se_pooled**2 + tau2)
    t_crit = stats.t.ppf(0.975, max(k - 2, 1))
    pred_lower = pooled - t_crit * pred_se
    pred_upper = pooled + t_crit * pred_se

    # Assign weights
    w_total = np.sum(wi_star)
    updated = []
    for s, w in zip(studies, wi_star):
        sc = s.model_copy()
        sc.weight = float(w / w_total * 100)
        updated.append(sc)

    result = _build_pooled(
        outcome_name=outcome_name,
        n_studies=k,
        effect_measure=effect_measure,
        model="random",
        pooled_log=pooled,
        se=se_pooled,
        p_value=float(p),
        q=q, q_p=float(q_p), i2=i2, tau2=tau2, h2=h2,
        studies=updated,
    )
    result.prediction_interval = (_to_original(pred_lower, effect_measure), _to_original(pred_upper, effect_measure))
    return result


def leave_one_out(studies: list[StudyEffect], effect_measure: str, outcome_name: str, model: str = "random") -> list[LeaveOneOutResult]:
    """Leave-one-out sensitivity analysis."""
    results = []
    meta_fn = random_effects_dl if model == "random" else fixed_effect
    for i in range(len(studies)):
        subset = studies[:i] + studies[i + 1:]
        if len(subset) < 2:
            continue
        pooled = meta_fn(subset, effect_measure, outcome_name)
        results.append(LeaveOneOutResult(
            excluded_study_id=studies[i].study_id,
            excluded_study_label=studies[i].study_label,
            pooled_effect=pooled.pooled_effect,
            ci_lower=pooled.ci_lower,
            ci_upper=pooled.ci_upper,
            i_squared=pooled.i_squared,
        ))
    return results


def subgroup_analysis(
    studies: list[StudyEffect],
    effect_measure: str,
    outcome_name: str,
    model: str = "random",
) -> list[PooledEffect]:
    """Subgroup analysis: pool within each subgroup, plus Q-between test.

    Returns list of PooledEffect. The last element (if there are >=2 subgroups)
    is a synthetic PooledEffect representing the Q-between test result, with
    outcome_name = "Subgroup difference test" and q_statistic = Q_between.
    """
    groups: dict[str, list[StudyEffect]] = {}
    for s in studies:
        key = s.subgroup or "Overall"
        groups.setdefault(key, []).append(s)

    meta_fn = random_effects_dl if model == "random" else fixed_effect
    results = []
    for group_name, group_studies in groups.items():
        if len(group_studies) < 2:
            continue
        pooled = meta_fn(group_studies, effect_measure, f"{outcome_name} — {group_name}")
        results.append(pooled)

    # Q-between test (test for subgroup differences)
    if len(results) >= 2:
        # Q_between = Q_total - sum(Q_within)
        # Use fixed-effect pooled for each subgroup
        all_effects_flat = [s for g in groups.values() for s in g if len(g) >= 2]
        if len(all_effects_flat) >= 2:
            try:
                overall_fe = fixed_effect(all_effects_flat, effect_measure, outcome_name)
                q_total = overall_fe.q_statistic
                q_within = sum(r.q_statistic for r in results)
                q_between = q_total - q_within
                df_between = len(results) - 1
                p_between = 1 - stats.chi2.cdf(max(0, q_between), df_between) if df_between > 0 else 1.0

                for pooled in results:
                    pooled.subgroup_q_between = float(q_between)
                    pooled.subgroup_q_between_p = float(p_between)
            except Exception:
                pass

    return results


# =============================================================================
# REML estimator for τ²
# =============================================================================

def _reml_tau2(yi: np.ndarray, vi: np.ndarray, max_iter: int = 100, tol: float = 1e-8) -> float:
    """Estimate τ² using REML (Restricted Maximum Likelihood).

    Reference: Viechtbauer (2005), Thompson & Sharp (1999).
    Uses direct one-dimensional optimization of the intercept-only restricted
    log-likelihood, which is more stable than hand-rolled Fisher scoring for
    small k and near-zero heterogeneity.
    """
    k = len(yi)
    # Initialize with DL estimate
    wi = 1.0 / vi
    pooled_fixed = np.sum(wi * yi) / np.sum(wi)
    q = float(np.sum(wi * (yi - pooled_fixed) ** 2))
    c = np.sum(wi) - np.sum(wi ** 2) / np.sum(wi)
    tau2_dl = max(0.0, (q - (k - 1)) / c) if c > 0 else 0.0

    def restricted_neg_loglik(tau2: float) -> float:
        v = vi + tau2
        if np.any(v <= 0):
            return np.inf
        w = 1.0 / v
        sw = np.sum(w)
        if sw <= 0:
            return np.inf
        pooled = np.sum(w * yi) / sw
        resid = yi - pooled
        return 0.5 * (np.sum(np.log(v)) + np.log(sw) + np.sum(w * resid ** 2))

    upper = max(float(np.var(yi, ddof=1) * 10 + np.max(vi)), tau2_dl * 10, 1.0)
    try:
        opt = optimize.minimize_scalar(
            restricted_neg_loglik,
            bounds=(0.0, upper),
            method="bounded",
            options={"xatol": tol, "maxiter": max_iter},
        )
        if opt.success and np.isfinite(opt.fun):
            return max(0.0, float(opt.x))
    except Exception:
        pass

    return tau2_dl


def random_effects_reml(studies: list[StudyEffect], effect_measure: str, outcome_name: str) -> PooledEffect:
    """REML random-effects meta-analysis.

    Uses REML estimation for τ² instead of DerSimonian-Laird.
    Reference: Viechtbauer (2005).
    """
    if len(studies) < 2:
        raise ValueError(f"Random-effects meta-analysis requires >= 2 studies, got {len(studies)}")
    if len(studies) < 3:
        return _sparse_random_effects_fallback(studies, effect_measure, outcome_name)

    yi = np.array([s.yi for s in studies])
    vi = np.array([s.vi for s in studies])
    k = len(studies)

    if np.any(vi <= 0):
        raise ValueError("All study variances must be positive")

    tau2 = _reml_tau2(yi, vi)

    # Random-effects weights with REML tau2
    wi_star = 1.0 / (vi + tau2)
    pooled = float(np.sum(wi_star * yi) / np.sum(wi_star))
    se_pooled = float(np.sqrt(1.0 / np.sum(wi_star)))

    z = pooled / se_pooled
    p = 2 * (1 - stats.norm.cdf(abs(z)))

    # Heterogeneity stats (Q based on fixed weights for consistency)
    wi_fixed = 1.0 / vi
    q = float(np.sum(wi_fixed * (yi - np.sum(wi_fixed * yi) / np.sum(wi_fixed)) ** 2))
    q_p = 1 - stats.chi2.cdf(q, k - 1) if k > 1 else 1.0
    i2 = max(0.0, (q - (k - 1)) / q * 100) if q > 0 else 0.0
    h2 = q / (k - 1) if k > 1 else 1.0

    # Prediction interval
    pred_se = np.sqrt(se_pooled ** 2 + tau2)
    t_crit = stats.t.ppf(0.975, max(k - 2, 1))
    pred_lower = pooled - t_crit * pred_se
    pred_upper = pooled + t_crit * pred_se

    # Assign weights
    w_total = np.sum(wi_star)
    updated = []
    for s, w in zip(studies, wi_star):
        sc = s.model_copy()
        sc.weight = float(w / w_total * 100)
        updated.append(sc)

    result = _build_pooled(
        outcome_name=outcome_name,
        n_studies=k,
        effect_measure=effect_measure,
        model="random",
        pooled_log=pooled,
        se=se_pooled,
        p_value=float(p),
        q=q, q_p=float(q_p), i2=i2, tau2=tau2, h2=h2,
        studies=updated,
        tau_estimator="REML",
    )
    result.prediction_interval = (_to_original(pred_lower, effect_measure), _to_original(pred_upper, effect_measure))
    return result


# =============================================================================
# Hartung-Knapp-Sidik-Jonkman (HKSJ) adjustment
# =============================================================================

def random_effects_hksj(studies: list[StudyEffect], effect_measure: str, outcome_name: str) -> PooledEffect:
    """Random-effects with HKSJ adjustment (t-distribution instead of normal).

    Uses DL for τ² estimation, then applies HKSJ variance correction.
    More conservative CI when number of studies is small.
    Reference: Hartung & Knapp (2001), Sidik & Jonkman (2002).
    """
    if len(studies) < 2:
        raise ValueError(f"HKSJ requires >= 2 studies, got {len(studies)}")
    if len(studies) < 3:
        return _sparse_random_effects_fallback(studies, effect_measure, outcome_name)

    yi = np.array([s.yi for s in studies])
    vi = np.array([s.vi for s in studies])
    k = len(studies)

    # DL estimate of tau2
    wi_fixed = 1.0 / vi
    pooled_fixed = np.sum(wi_fixed * yi) / np.sum(wi_fixed)
    q = float(np.sum(wi_fixed * (yi - pooled_fixed) ** 2))
    c = np.sum(wi_fixed) - np.sum(wi_fixed ** 2) / np.sum(wi_fixed)
    tau2 = max(0.0, (q - (k - 1)) / c) if c > 0 else 0.0

    # Random-effects weights
    wi_star = 1.0 / (vi + tau2)
    pooled = float(np.sum(wi_star * yi) / np.sum(wi_star))
    se_pooled_re = float(np.sqrt(1.0 / np.sum(wi_star)))

    # HKSJ variance correction: q_hksj = sum(wi*(yi-pooled)^2) / (k-1) where wi = wi_star
    q_hksj = float(np.sum(wi_star * (yi - pooled) ** 2) / (k - 1))
    # HKSJ SE = se_pooled * sqrt(q_hksj)
    se_hksj = se_pooled_re * np.sqrt(max(1.0, q_hksj))  # Apply max(1, q_hksj) per recommendation

    # Use t-distribution
    t_crit = stats.t.ppf(0.975, k - 1)
    ci_lower = pooled - t_crit * se_hksj
    ci_upper = pooled + t_crit * se_hksj
    t_stat = pooled / se_hksj if se_hksj > 0 else 0
    p = 2 * (1 - stats.t.cdf(abs(t_stat), k - 1))

    # Heterogeneity
    q_p = 1 - stats.chi2.cdf(q, k - 1) if k > 1 else 1.0
    i2 = max(0.0, (q - (k - 1)) / q * 100) if q > 0 else 0.0
    h2 = q / (k - 1) if k > 1 else 1.0

    # Prediction interval
    pred_se = np.sqrt(se_hksj ** 2 + tau2)
    pred_lower = pooled - t_crit * pred_se
    pred_upper = pooled + t_crit * pred_se

    # Assign weights
    w_total = np.sum(wi_star)
    updated = []
    for s, w in zip(studies, wi_star):
        sc = s.model_copy()
        sc.weight = float(w / w_total * 100)
        updated.append(sc)

    result = _build_pooled(
        outcome_name=outcome_name,
        n_studies=k,
        effect_measure=effect_measure,
        model="random",
        pooled_log=pooled,
        se=se_hksj,
        p_value=float(p),
        q=q, q_p=float(q_p), i2=i2, tau2=tau2, h2=h2,
        studies=updated,
        tau_estimator="HKSJ",
    )
    # Override CI (built with normal, we need t-based)
    result.ci_lower = _to_original(ci_lower, effect_measure)
    result.ci_upper = _to_original(ci_upper, effect_measure)
    result.ci_lower_log = ci_lower
    result.ci_upper_log = ci_upper
    result.prediction_interval = (_to_original(pred_lower, effect_measure), _to_original(pred_upper, effect_measure))
    return result


# =============================================================================
# Meta-Regression
# =============================================================================

def meta_regression(
    studies: list[StudyEffect],
    covariate_values: list[float],
    covariate_name: str = "covariate",
    effect_measure: str = "MD",
) -> MetaRegressionResult:
    """Weighted least squares meta-regression (method of moments).

    Tests if a study-level covariate explains heterogeneity.
    Reference: Thompson & Higgins (2002), Borenstein et al. (2009) Ch. 20.
    """
    if len(studies) != len(covariate_values):
        raise ValueError("Number of studies must match number of covariate values")
    if len(studies) < 3:
        raise ValueError("Meta-regression requires >= 3 studies")

    yi = np.array([s.yi for s in studies])
    vi = np.array([s.vi for s in studies])
    x = np.array(covariate_values)
    k = len(studies)

    # Estimate tau2 using DL (unrestricted model)
    wi_fixed = 1.0 / vi
    pooled_fixed = np.sum(wi_fixed * yi) / np.sum(wi_fixed)
    q_total = float(np.sum(wi_fixed * (yi - pooled_fixed) ** 2))
    c = np.sum(wi_fixed) - np.sum(wi_fixed ** 2) / np.sum(wi_fixed)
    tau2_total = max(0.0, (q_total - (k - 1)) / c) if c > 0 else 0.0

    # Weighted regression: yi = b0 + b1*xi + ei
    wi_star = 1.0 / (vi + tau2_total)
    W = np.diag(wi_star)
    X = np.column_stack([np.ones(k), x])

    try:
        XtWX = X.T @ W @ X
        XtWX_inv = np.linalg.inv(XtWX)
        beta = XtWX_inv @ X.T @ W @ yi
    except np.linalg.LinAlgError:
        raise ValueError("Singular matrix in meta-regression — covariate may be constant")

    # Residuals and model Q
    y_pred = X @ beta
    resid = yi - y_pred
    q_model = float(beta[1] ** 2 / XtWX_inv[1, 1]) if XtWX_inv[1, 1] > 0 else 0
    q_model_p = 1 - stats.chi2.cdf(q_model, 1) if q_model > 0 else 1.0

    # Residual tau2
    q_resid = float(np.sum(wi_star * resid ** 2))
    c_resid = np.sum(wi_star) - np.trace(XtWX_inv @ X.T @ np.diag(wi_star ** 2) @ X)
    tau2_resid = max(0.0, (q_resid - (k - 2)) / c_resid) if c_resid > 0 else 0.0

    # R² analog
    r2 = max(0.0, 1 - tau2_resid / tau2_total) if tau2_total > 0 else 0.0

    # Coefficient stats
    b1 = float(beta[1])
    se_b1 = float(np.sqrt(XtWX_inv[1, 1]))
    z = b1 / se_b1 if se_b1 > 0 else 0
    p_b1 = 2 * (1 - stats.norm.cdf(abs(z)))

    return MetaRegressionResult(
        covariate_name=covariate_name,
        coefficient=b1,
        se=se_b1,
        ci_lower=b1 - 1.96 * se_b1,
        ci_upper=b1 + 1.96 * se_b1,
        p_value=float(p_b1),
        r_squared_analog=float(r2),
        tau_squared_residual=float(tau2_resid),
        q_model=float(q_model),
        q_model_p=float(q_model_p),
    )


# =============================================================================
# Cumulative Meta-Analysis
# =============================================================================

def cumulative_meta_analysis(
    studies: list[StudyEffect],
    effect_measure: str,
    outcome_name: str,
    sort_by: str = "year",
    model: str = "random",
) -> list[CumulativeResult]:
    """Cumulative meta-analysis: add studies one at a time in order.

    sort_by: "year" sorts by study label (expects 'Author YYYY' format),
             "effect" sorts by effect size, "precision" sorts by 1/vi.
    """
    if len(studies) < 2:
        return []

    # Sort studies
    if sort_by == "year":
        sorted_studies = sorted(studies, key=lambda s: s.study_label)
    elif sort_by == "effect":
        sorted_studies = sorted(studies, key=lambda s: s.yi)
    elif sort_by == "precision":
        sorted_studies = sorted(studies, key=lambda s: 1.0 / s.vi, reverse=True)
    else:
        sorted_studies = list(studies)

    meta_fn = random_effects_dl if model == "random" else fixed_effect
    results = []

    for i in range(1, len(sorted_studies)):
        subset = sorted_studies[:i + 1]
        if len(subset) < 2:
            continue
        try:
            pooled = meta_fn(subset, effect_measure, outcome_name)
            results.append(CumulativeResult(
                study_label=sorted_studies[i].study_label,
                n_studies=len(subset),
                pooled_effect=pooled.pooled_effect,
                ci_lower=pooled.ci_lower,
                ci_upper=pooled.ci_upper,
            ))
        except Exception:
            continue

    return results


# =============================================================================
# Internal helpers
# =============================================================================

def _heterogeneity(yi, vi, wi):
    """Compute heterogeneity statistics."""
    k = len(yi)
    pooled = np.sum(wi * yi) / np.sum(wi)
    q = float(np.sum(wi * (yi - pooled) ** 2))
    q_p = 1 - stats.chi2.cdf(q, k - 1) if k > 1 else 1.0
    i2 = max(0.0, (q - (k - 1)) / q * 100) if q > 0 else 0.0
    c = np.sum(wi) - np.sum(wi**2) / np.sum(wi)
    tau2 = max(0.0, (q - (k - 1)) / c) if c > 0 else 0.0
    h2 = q / (k - 1) if k > 1 else 1.0
    return q, q_p, i2, tau2, h2


def _is_log_measure(effect_measure: str) -> bool:
    return effect_measure.upper() in {"OR", "RR", "HR", "IRR"}


def _to_original(val: float, effect_measure: str, vi: float | None = None) -> float:
    """Convert an analysis-scale effect to its reporting scale."""
    measure = (effect_measure or "").upper()
    if not np.isfinite(val):
        return float(val)
    if _is_log_measure(measure):
        return float(np.exp(val))
    if measure == "COR":
        return float(np.tanh(val))
    if measure == "PROP":
        if vi is not None and np.isfinite(vi) and vi > 0:
            n = max(1.0, (1.0 / vi) - 0.5)
            sin_yi = float(np.sin(val))
            n_tilde = n + 0.5
            inner = sin_yi + (sin_yi - 1.0 / sin_yi) / n_tilde if abs(sin_yi) > 1e-10 else 0.0
            bounded = max(-1.0, min(1.0, inner))
            p = 0.5 * (
                1.0 - np.copysign(1.0, np.cos(val)) * np.sqrt(max(0.0, 1.0 - bounded ** 2))
            )
            return float(max(0.0, min(1.0, p)))
        approx = np.sin(val / 2.0) ** 2
        return float(max(0.0, min(1.0, approx)))
    return float(val)


def _build_pooled(
    outcome_name, n_studies, effect_measure, model,
    pooled_log, se, p_value,
    q, q_p, i2, tau2, h2,
    studies,
    tau_estimator: str = "DL",
) -> PooledEffect:
    """Construct a PooledEffect with both log and original scale values."""
    ci_lower_log = pooled_log - 1.96 * se
    ci_upper_log = pooled_log + 1.96 * se

    return PooledEffect(
        outcome_name=outcome_name,
        n_studies=n_studies,
        effect_measure=effect_measure,
        pooled_effect=_to_original(pooled_log, effect_measure, se ** 2),
        ci_lower=_to_original(ci_lower_log, effect_measure, se ** 2),
        ci_upper=_to_original(ci_upper_log, effect_measure, se ** 2),
        p_value=p_value,
        pooled_log=pooled_log,
        ci_lower_log=ci_lower_log,
        ci_upper_log=ci_upper_log,
        model=model,
        tau_estimator=tau_estimator,
        q_statistic=q,
        q_p_value=q_p,
        i_squared=i2,
        tau_squared=tau2,
        h_squared=h2,
        prediction_interval=None,
        studies=studies,
    )
