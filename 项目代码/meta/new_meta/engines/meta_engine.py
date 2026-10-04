"""Meta-analysis core engine — fixed/random effects, heterogeneity, subgroup, sensitivity.

All computations are deterministic (numpy/scipy), no LLM involved.
"""
from __future__ import annotations

import numpy as np
from typing import NamedTuple
from scipy import optimize, stats

from new_meta.schemas.meta_result import (
    StudyEffect, PooledEffect, LeaveOneOutResult,
    MetaRegressionResult, CumulativeResult,
)

# The 97.5th percentile of the standard normal, in full. Every 95% Wald interval
# here uses it: a truncated 1.96 made this engine disagree with metafor, with the
# other engines of this package and with itself (adjusted_effects.py recovered a
# standard error from an interval built with 1.96 by dividing with the full value).
Z_975 = 1.959963984540054


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
    p = 2 * stats.norm.sf(abs(z))
    ci_lower = pooled - Z_975 * se_pooled
    ci_upper = pooled + Z_975 * se_pooled

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
        tau_estimator="none", requested_method="FIXED",
    )


def _sparse_random_effects_fallback(
    studies: list[StudyEffect],
    effect_measure: str,
    outcome_name: str,
    requested_method: str,
) -> PooledEffect:
    """Use fixed-effect pooling when k<3 makes tau² and prediction intervals unstable."""
    result = fixed_effect(studies, effect_measure, outcome_name)
    result.model = "fixed"
    result.tau_squared = 0.0
    result.prediction_interval = None
    result.requested_method = requested_method
    result.fallback_reason = "fewer_than_three_studies"
    return result


def random_effects_dl(studies: list[StudyEffect], effect_measure: str, outcome_name: str) -> PooledEffect:
    """DerSimonian-Laird random-effects meta-analysis."""
    if len(studies) < 2:
        raise ValueError(f"Random-effects meta-analysis requires >= 2 studies, got {len(studies)}")
    if len(studies) < 3:
        return _sparse_random_effects_fallback(studies, effect_measure, outcome_name, "DL")

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
    p = 2 * stats.norm.sf(abs(z))
    q_p = stats.chi2.sf(q, k - 1) if k > 1 else 1.0
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
        requested_method="DL",
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

    Groups are the caller's ``StudyEffect.subgroup`` values, compared exactly:
    the caller passes closed protocol subgroup values (main.py,
    core/subgroup_vocabulary.py), because grouping free-text labels split one
    route into one-study groups (ma-001, 2026-09-28). A study without a value
    is left out rather than lumped into an "Overall" group, which is no value
    of the variable and would be tested against the others. Each subgroup with
    at least two studies is pooled; with two or more pooled subgroups every
    result carries the Q-between test in subgroup_q_between(_p).
    """
    groups: dict[str, list[StudyEffect]] = {}
    for s in studies:
        if s.subgroup:
            groups.setdefault(s.subgroup, []).append(s)

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
                p_between = stats.chi2.sf(max(0, q_between), df_between) if df_between > 0 else 1.0

                for pooled in results:
                    pooled.subgroup_q_between = float(q_between)
                    pooled.subgroup_q_between_p = float(p_between)
            except Exception:
                pass

    return results


# =============================================================================
# REML estimator for τ²
# =============================================================================

class _TauEstimate(NamedTuple):
    value: float
    estimator: str
    converged: bool


def _reml_score(tau2: float, yi: np.ndarray, vi: np.ndarray) -> float:
    """REML estimating function ``y'P^2 y - tr(P)`` for the intercept-only model.

    Positive while the restricted likelihood is still rising in tau^2, negative
    once it falls; its root is the REML estimate (Viechtbauer 2005, eq. 9).
    """
    w = 1.0 / (vi + tau2)
    sw = np.sum(w)
    mu = np.sum(w * yi) / sw
    return float(np.sum(w ** 2 * (yi - mu) ** 2) - (sw - np.sum(w ** 2) / sw))


def _estimate_reml_tau2(yi: np.ndarray, vi: np.ndarray, max_iter: int = 200, tol: float = 1e-12) -> _TauEstimate:
    """Estimate tau^2 by REML (restricted maximum likelihood).

    Reference: Viechtbauer (2005), Thompson & Sharp (1999).
    The estimate is the root of the REML estimating function, found by Brent's
    method to ``tol`` (the earlier bounded minimiser stopped about 1e-8 short
    of the optimum, and returned 5.7e-9 instead of the exact boundary 0 for
    the homogeneous Hine (1989) trials). When the function is not positive at
    tau^2 = 0 the restricted likelihood only falls from there and the estimate
    is the boundary, 0.
    """
    k = len(yi)
    wi = 1.0 / vi
    pooled_fixed = np.sum(wi * yi) / np.sum(wi)
    q = float(np.sum(wi * (yi - pooled_fixed) ** 2))
    c = np.sum(wi) - np.sum(wi ** 2) / np.sum(wi)
    tau2_dl = max(0.0, (q - (k - 1)) / c) if c > 0 else 0.0

    try:
        if _reml_score(0.0, yi, vi) <= 0.0:
            return _TauEstimate(0.0, "REML", True)
        upper = max(tau2_dl * 10.0, float(np.var(yi, ddof=1)) * 10.0 + float(np.max(vi)), 1.0)
        for _ in range(60):
            if _reml_score(upper, yi, vi) < 0.0:
                break
            upper *= 2.0
        else:
            raise RuntimeError("no upper bracket for the REML estimating function")
        root = optimize.brentq(lambda t: _reml_score(t, yi, vi), 0.0, upper, xtol=tol, rtol=4 * np.finfo(float).eps,
                               maxiter=max_iter)
        if np.isfinite(root):
            return _TauEstimate(max(0.0, float(root)), "REML", True)
    except (RuntimeError, ValueError, FloatingPointError):
        pass

    return _TauEstimate(tau2_dl, "DL", False)


def _reml_tau2(yi: np.ndarray, vi: np.ndarray, max_iter: int = 100, tol: float = 1e-8) -> float:
    """Compatibility scalar entry; pooling also retains the estimation provenance."""
    return _estimate_reml_tau2(yi, vi, max_iter, tol).value


def random_effects_reml(studies: list[StudyEffect], effect_measure: str, outcome_name: str) -> PooledEffect:
    """REML random-effects meta-analysis.

    Uses REML estimation for τ² instead of DerSimonian-Laird.
    Reference: Viechtbauer (2005).
    """
    if len(studies) < 2:
        raise ValueError(f"Random-effects meta-analysis requires >= 2 studies, got {len(studies)}")
    if len(studies) < 3:
        return _sparse_random_effects_fallback(studies, effect_measure, outcome_name, "REML")

    yi = np.array([s.yi for s in studies])
    vi = np.array([s.vi for s in studies])
    k = len(studies)

    if np.any(vi <= 0):
        raise ValueError("All study variances must be positive")
    if np.any(~np.isfinite(yi)) or np.any(~np.isfinite(vi)):
        raise ValueError("Study effect sizes and variances must be finite")

    tau_fit = _estimate_reml_tau2(yi, vi)
    tau2 = tau_fit.value

    # Random-effects weights with REML tau2
    wi_star = 1.0 / (vi + tau2)
    pooled = float(np.sum(wi_star * yi) / np.sum(wi_star))
    se_pooled = float(np.sqrt(1.0 / np.sum(wi_star)))

    z = pooled / se_pooled
    p = 2 * stats.norm.sf(abs(z))

    # Heterogeneity stats (Q based on fixed weights for consistency)
    wi_fixed = 1.0 / vi
    q = float(np.sum(wi_fixed * (yi - np.sum(wi_fixed * yi) / np.sum(wi_fixed)) ** 2))
    q_p = stats.chi2.sf(q, k - 1) if k > 1 else 1.0
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
        tau_estimator=tau_fit.estimator,
        requested_method="REML",
        fallback_reason=None if tau_fit.converged else "reml_optimizer_failed",
        tau_estimation_converged=tau_fit.converged,
    )
    result.prediction_interval = (_to_original(pred_lower, effect_measure), _to_original(pred_upper, effect_measure))
    return result


# =============================================================================
# Hartung-Knapp-Sidik-Jonkman (HKSJ) adjustment
# =============================================================================

def random_effects_hksj(
    studies: list[StudyEffect],
    effect_measure: str,
    outcome_name: str,
    tau_estimator: str = "DL",
) -> PooledEffect:
    """Random-effects with the Hartung-Knapp-Sidik-Jonkman (HKSJ) adjustment.

    tau^2 comes from ``tau_estimator`` ("DL", the default, or "REML"). The
    pooled-effect variance is rescaled by ``q = sum(w*(y - mu)^2)/(k - 1)`` and
    the interval and p value use the t distribution with k - 1 degrees of
    freedom. The rescaling is floored at 1 (``max(1, q)``: Knapp & Hartung 2003;
    IntHout, Ioannidis & Borm 2014), so the adjusted interval is never narrower
    than the ordinary random-effects one; metafor's ``test="knha"`` has no floor,
    and the two agree whenever q >= 1 (Raudenbush 2009, Table 16.3).
    The prediction interval uses the adjusted standard error and t(k - 1), as
    metafor's ``predict()`` does under ``test="knha"``.
    References: Hartung & Knapp (2001), Sidik & Jonkman (2002).
    """
    if tau_estimator not in {"DL", "REML"}:
        raise ValueError("HKSJ tau^2 estimator must be 'DL' or 'REML'")
    if len(studies) < 2:
        raise ValueError(f"HKSJ requires >= 2 studies, got {len(studies)}")
    if len(studies) < 3:
        return _sparse_random_effects_fallback(studies, effect_measure, outcome_name, "HKSJ")

    yi = np.array([s.yi for s in studies])
    vi = np.array([s.vi for s in studies])
    k = len(studies)

    if np.any(vi <= 0):
        raise ValueError("All study variances must be positive")
    if np.any(~np.isfinite(yi)) or np.any(~np.isfinite(vi)):
        raise ValueError("Study effect sizes and variances must be finite")

    wi_fixed = 1.0 / vi
    pooled_fixed = np.sum(wi_fixed * yi) / np.sum(wi_fixed)
    q = float(np.sum(wi_fixed * (yi - pooled_fixed) ** 2))
    if tau_estimator == "REML":
        tau_fit = _estimate_reml_tau2(yi, vi)
        tau2, estimator, converged = tau_fit.value, tau_fit.estimator, tau_fit.converged
    else:
        c = np.sum(wi_fixed) - np.sum(wi_fixed ** 2) / np.sum(wi_fixed)
        tau2, estimator, converged = (max(0.0, (q - (k - 1)) / c) if c > 0 else 0.0), "DL", None

    # Random-effects weights
    wi_star = 1.0 / (vi + tau2)
    pooled = float(np.sum(wi_star * yi) / np.sum(wi_star))
    se_pooled_re = float(np.sqrt(1.0 / np.sum(wi_star)))

    # HKSJ variance correction, floored at 1.
    q_hksj = float(np.sum(wi_star * (yi - pooled) ** 2) / (k - 1))
    se_hksj = se_pooled_re * np.sqrt(max(1.0, q_hksj))

    t_crit = stats.t.ppf(0.975, k - 1)
    ci_lower = pooled - t_crit * se_hksj
    ci_upper = pooled + t_crit * se_hksj
    t_stat = pooled / se_hksj if se_hksj > 0 else 0
    p = 2 * stats.t.sf(abs(t_stat), k - 1)

    # Heterogeneity
    q_p = stats.chi2.sf(q, k - 1) if k > 1 else 1.0
    i2 = max(0.0, (q - (k - 1)) / q * 100) if q > 0 else 0.0
    h2 = q / (k - 1) if k > 1 else 1.0

    pred_se = np.sqrt(se_hksj ** 2 + tau2)
    pred_lower = pooled - t_crit * pred_se
    pred_upper = pooled + t_crit * pred_se

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
        tau_estimator=estimator, requested_method="HKSJ", ci_method="modified_hksj_t",
        fallback_reason=None if converged is not False else "reml_optimizer_failed",
        tau_estimation_converged=converged,
    )
    # _build_pooled makes a normal interval; the adjusted one is t-based.
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
    """Mixed-effects meta-regression on one study-level covariate (method of moments).

    Tests if a study-level covariate explains heterogeneity.
    Reference: Thompson & Sharp (1999), Raudenbush (2009), Borenstein et al. (2009) Ch. 20.

    tau^2 is the DerSimonian-Laird *residual* between-study variance, estimated
    from the weighted-least-squares fit with fixed-effect weights
    (``(Q_E - (k - p)) / (tr(W) - tr((X'WX)^-1 X'W^2 X))``, floored at 0), and the
    coefficients are then refitted with weights ``1/(v + tau^2_residual)``. An
    earlier version weighted the fit with the *unconditional* tau^2, so a
    moderator that explained the heterogeneity still faced weights inflated by
    the heterogeneity it explained; on Raudenbush's (1985) teacher-expectancy
    trials it returned slope -0.1701 (SE 0.0490) where the published mixed-effects
    slope is -0.1572 (SE 0.0358). The R^2 analogue compares the residual with the unconditional DL
    tau^2. The test of the slope is the Wald z test (metafor's default).
    """
    if len(studies) != len(covariate_values):
        raise ValueError("Number of studies must match number of covariate values")
    if len(studies) < 3:
        raise ValueError("Meta-regression requires >= 3 studies")

    yi = np.array([s.yi for s in studies])
    vi = np.array([s.vi for s in studies])
    x = np.array(covariate_values, dtype=float)
    k = len(studies)
    if np.any(vi <= 0) or np.any(~np.isfinite(yi)) or np.any(~np.isfinite(vi)) or np.any(~np.isfinite(x)):
        raise ValueError("Study effects, variances and covariate values must be finite, with positive variances")
    if np.ptp(x) == 0:
        raise ValueError("Singular matrix in meta-regression — covariate may be constant")

    # Unconditional DL tau^2, the reference for the R^2 analogue.
    wi_fixed = 1.0 / vi
    pooled_fixed = np.sum(wi_fixed * yi) / np.sum(wi_fixed)
    q_total = float(np.sum(wi_fixed * (yi - pooled_fixed) ** 2))
    c_total = np.sum(wi_fixed) - np.sum(wi_fixed ** 2) / np.sum(wi_fixed)
    tau2_total = max(0.0, (q_total - (k - 1)) / c_total) if c_total > 0 else 0.0

    X = np.column_stack([np.ones(k), x])

    def wls(weights: np.ndarray):
        xtwx = X.T @ (weights[:, None] * X)
        try:
            inverse = np.linalg.inv(xtwx)
        except np.linalg.LinAlgError:
            raise ValueError("Singular matrix in meta-regression — covariate may be constant") from None
        return inverse, inverse @ (X.T @ (weights * yi))

    # Residual DL tau^2 from the fixed-weight fit.
    inverse0, beta0 = wls(wi_fixed)
    q_resid = float(np.sum(wi_fixed * (yi - X @ beta0) ** 2))
    c_resid = float(np.sum(wi_fixed) - np.trace(inverse0 @ (X.T @ ((wi_fixed ** 2)[:, None] * X))))
    tau2_resid = max(0.0, (q_resid - (k - 2)) / c_resid) if c_resid > 0 else 0.0

    wi_star = 1.0 / (vi + tau2_resid)
    xtwx_inv, beta = wls(wi_star)

    # Omnibus test of the moderator
    b1 = float(beta[1])
    var_b1 = float(xtwx_inv[1, 1])
    q_model = float(b1 ** 2 / var_b1) if var_b1 > 0 else 0.0
    q_model_p = float(stats.chi2.sf(q_model, 1)) if q_model > 0 else 1.0

    r2 = max(0.0, 1 - tau2_resid / tau2_total) if tau2_total > 0 else 0.0

    se_b1 = float(np.sqrt(var_b1))
    z = b1 / se_b1 if se_b1 > 0 else 0
    p_b1 = 2 * stats.norm.sf(abs(z))

    return MetaRegressionResult(
        covariate_name=covariate_name,
        coefficient=b1,
        se=se_b1,
        ci_lower=b1 - Z_975 * se_b1,
        ci_upper=b1 + Z_975 * se_b1,
        p_value=float(p_b1),
        r_squared_analog=float(r2),
        tau_squared_residual=float(tau2_resid),
        q_model=float(q_model),
        q_model_p=float(q_model_p),
        intercept=float(beta[0]),
        intercept_se=float(np.sqrt(xtwx_inv[0, 0])),
        q_residual=q_resid,
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
    q_p = stats.chi2.sf(q, k - 1) if k > 1 else 1.0
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
    ci_method: str = "normal_wald",
    requested_method: str | None = None,
    fallback_reason: str | None = None,
    tau_estimation_converged: bool | None = None,
) -> PooledEffect:
    """Construct a PooledEffect with both log and original scale values."""
    ci_lower_log = pooled_log - Z_975 * se
    ci_upper_log = pooled_log + Z_975 * se

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
        ci_method=ci_method,
        requested_method=requested_method,
        fallback_reason=fallback_reason,
        tau_estimation_converged=tau_estimation_converged,
        q_statistic=q,
        q_p_value=q_p,
        i_squared=i2,
        tau_squared=tau2,
        h_squared=h2,
        prediction_interval=None,
        studies=studies,
    )
