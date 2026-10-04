"""Publication bias tests — Egger's, Begg's, Trim-and-fill, Fail-safe N.

All deterministic computations, no LLM.
"""
from __future__ import annotations

import logging
import math
import numpy as np
from scipy import stats as sp_stats

from new_meta.schemas.meta_result import StudyEffect, PublicationBiasResult

logger = logging.getLogger("metaagent.publication_bias")


def egger_regression(studies: list[StudyEffect]) -> dict:
    """Egger's regression test for funnel plot asymmetry, with its working.

    Regresses the standardized effect (yi/SEi) on precision (1/SEi) by ordinary
    least squares, unweighted: the standardization already is the weighting, so
    weighting again by 1/vi would count the precision twice. The intercept is the
    bias coefficient and its t test (n - 2 df) is the test of asymmetry (Egger et
    al. 1997). It equals the t test of the slope of ``yi ~ sei`` weighted by 1/vi
    (metafor ``regtest(model="lm")``), which is how it is checked.

    Returns ``intercept``, ``se``, ``t``, ``df``, ``p`` and the regression ``slope``
    (an effect estimate corrected for small-study asymmetry); everything is NaN
    for fewer than three studies.
    """
    yi = np.array([s.yi for s in studies])
    se = np.array([s.se for s in studies])
    n = len(studies)
    nan = float("nan")
    if n < 3:
        return {"intercept": nan, "se": nan, "t": nan, "df": n - 2, "p": nan, "slope": nan}

    precision = 1.0 / se
    std_effect = yi / se
    x_mean = float(np.mean(precision))
    ss_x = float(np.sum((precision - x_mean) ** 2))
    if ss_x == 0.0:
        # All standard errors equal: precision does not vary, so there is no regression to run.
        return {"intercept": nan, "se": nan, "t": nan, "df": n - 2, "p": nan, "slope": nan}
    slope = float(np.sum((precision - x_mean) * (std_effect - np.mean(std_effect))) / ss_x)
    intercept = float(np.mean(std_effect) - slope * x_mean)
    residuals = std_effect - (slope * precision + intercept)
    mse = float(np.sum(residuals ** 2) / (n - 2))
    se_intercept = math.sqrt(mse * (1.0 / n + x_mean ** 2 / ss_x))
    if se_intercept == 0.0:
        return {"intercept": intercept, "se": 0.0, "t": nan, "df": n - 2, "p": nan, "slope": slope}
    t_stat = intercept / se_intercept
    p_intercept = float(2 * sp_stats.t.sf(abs(t_stat), n - 2))
    return {"intercept": intercept, "se": se_intercept, "t": float(t_stat), "df": n - 2, "p": p_intercept, "slope": slope}


def egger_test(studies: list[StudyEffect]) -> tuple[float, float, float]:
    """Egger's test: (intercept, SE of the intercept, two-sided p). See :func:`egger_regression`."""
    fit = egger_regression(studies)
    return float(fit["intercept"]), float(fit["se"]), float(fit["p"])


def begg_test(studies: list[StudyEffect]) -> tuple[float, float]:
    """Begg and Mazumdar's rank correlation test (1994).

    Kendall's tau between the *standardized* effects
    ``(yi - theta_FE) / sqrt(vi - 1/sum(1/vj))`` and the variances ``vi``. The
    standardization is what makes the effects comparable: this function once
    correlated the raw ``yi`` with ``vi``, which is not Begg's test (on the 16
    magnesium trials of Egger et al. 2001 it gave tau -0.233, p 0.228, against
    the published 0.150, p 0.450). The p value is exact for fewer than 50 studies
    without ties and the tie-corrected normal approximation otherwise, as R's
    ``cor.test(method="kendall")`` does (metafor ``ranktest``).
    Returns (tau, p_value); NaN for fewer than three studies.
    """
    if len(studies) < 3:
        return float("nan"), float("nan")
    yi = np.array([s.yi for s in studies])
    vi = np.array([s.vi for s in studies])
    weights = 1.0 / vi
    theta = float(np.sum(weights * yi) / np.sum(weights))
    adjusted = vi - 1.0 / np.sum(weights)
    if np.any(adjusted <= 0):
        return float("nan"), float("nan")
    standardized = (yi - theta) / np.sqrt(adjusted)
    ties = len(np.unique(standardized)) < len(standardized) or len(np.unique(vi)) < len(vi)
    method = "exact" if len(studies) < 50 and not ties else "asymptotic"
    tau, p = sp_stats.kendalltau(standardized, vi, method=method)
    return float(tau), float(p)


def _trim_fill_side_from_asymmetry(studies: list[StudyEffect]) -> str:
    """Choose trim-and-fill side from the observed Egger intercept direction."""
    try:
        intercept, _se, _p = egger_test(studies)
    except Exception:
        intercept = float("nan")
    if math.isfinite(intercept) and intercept < 0:
        return "left"
    return "right"


def trim_and_fill(
    studies: list[StudyEffect],
    effect_measure: str,
    side: str = "auto",
    tau_estimator: str = "DL",
) -> tuple[int, float, float, float]:
    """Duval and Tweedie's trim-and-fill method (the L0 estimator).

    Estimates the number of studies missing from one side of the funnel and the
    pooled effect after imputing their mirror images.
    Returns (n_missing, adjusted_pooled, adj_ci_lower, adj_ci_upper), all on the
    original scale.

    ``side`` names the side holding the *excess* studies that are trimmed
    ("left" or "right"; "auto" picks it from the direction of the Egger
    intercept); the imputed studies appear on the opposite side. ``tau_estimator``
    is the pooling model used throughout ("DL", "REML" or "FIXED").

    Duval & Tweedie (2000b): the deviations of all k studies from the current
    pooled estimate are ranked by absolute size, and with T the sum of the ranks
    of the deviations on the excess side, ``k0 = (4T - k(k+1)) / (2k - 1)``
    (rounded, floored at 0). The excess studies with the k0 largest deviations are
    trimmed, the pooled estimate is refitted to the rest, and the two steps repeat
    until k0 stops changing. The estimator used to read ``(4S - k) / 2``, which is
    not the L0 statistic: on the BCG trials it "found" 13 missing studies among
    13 (metafor: 1 with a random-effects model, 4 with an equal-effects one).
    """
    from new_meta.engines.meta_engine import fixed_effect, random_effects_dl, random_effects_reml

    if tau_estimator not in {"DL", "REML", "FIXED"}:
        raise ValueError("trim-and-fill tau estimator must be 'DL', 'REML' or 'FIXED'")
    pool = {"DL": random_effects_dl, "REML": random_effects_reml, "FIXED": fixed_effect}[tau_estimator]

    yi = np.array([s.yi for s in studies])
    vi = np.array([s.vi for s in studies])
    k = len(studies)
    if side == "auto":
        side = _trim_fill_side_from_asymmetry(studies)
    if side not in {"left", "right"}:
        raise ValueError("trim-and-fill side must be 'left', 'right', or 'auto'")
    if k < 3:
        raise ValueError("trim-and-fill requires >= 3 studies")

    def estimate(subset):
        result = pool(subset, effect_measure, "_trim_fill")
        return result.pooled_log if result.pooled_log is not None else result.pooled_effect

    # Work on the axis where the excess is on the right: negate for an excess on the left.
    sign = 1.0 if side == "right" else -1.0
    order = np.argsort(sign * yi, kind="stable")

    theta = estimate(studies)
    initial = pool(studies, effect_measure, "_trim_fill")
    k0 = 0
    for _iteration in range(100):
        deviation = sign * (yi - theta)
        ranks = sp_stats.rankdata(np.abs(deviation), method="ordinal")
        t_n = float(np.sum(ranks[deviation > 0]))
        k0_new = max(0, int(round((4.0 * t_n - k * (k + 1)) / (2.0 * k - 1.0))))
        k0_new = min(k0_new, k - 2)  # at least two studies stay to estimate the centre from
        if k0_new == k0 and _iteration > 0:
            break
        k0 = k0_new
        if k0 == 0:
            theta = estimate(studies)
            break
        keep = order[: k - k0]
        theta = estimate([studies[i] for i in keep])

    if k0 == 0:
        return 0, initial.pooled_effect, initial.ci_lower, initial.ci_upper

    # Mirror the k0 most extreme excess studies about the trimmed estimate.
    extreme = order[-k0:]
    filled = list(studies)
    for rank, idx in enumerate(extreme):
        filled.append(StudyEffect(
            study_id=f"_filled_{rank}",
            study_label=f"Filled {rank + 1}",
            yi=float(2.0 * theta - yi[idx]),
            vi=float(vi[idx]),
            se=float(np.sqrt(vi[idx])),
        ))
    adjusted = pool(filled, effect_measure, "_trim_fill_adj")
    return k0, adjusted.pooled_effect, adjusted.ci_lower, adjusted.ci_upper


def failsafe_n(studies: list[StudyEffect], alpha: float = 0.05) -> int:
    """Rosenthal's (1979) fail-safe N.

    The number of unpublished null-result studies needed to bring the combined
    one-tailed p value above ``alpha``: ``N = (sum Z)^2 / Z_alpha^2 - k`` with
    ``Z_alpha`` the one-tailed critical value (1.645 for 0.05), rounded up
    (metafor ``fsn()``). It used the two-sided critical value 1.96, which is a
    different (smaller) number: 12 for the Raudenbush (1985) trials where Rosenthal's
    formula gives 26 (Becker 2005).
    """
    yi = np.array([s.yi for s in studies])
    se = np.array([s.se for s in studies])
    k = len(studies)

    z_sum = float(np.sum(yi / se))
    z_crit = float(sp_stats.norm.isf(alpha))

    return max(0, int(math.ceil((z_sum / z_crit) ** 2 - k)))


def pet_peese(studies: list[StudyEffect]) -> dict:
    """PET-PEESE conditional estimator for publication bias adjustment.

    PET (Precision-Effect Test): regress effect on SE → intercept = bias-adjusted effect.
    PEESE (Precision-Effect Estimate with Standard Error): regress effect on SE² → better
    when PET suggests a genuine effect (p < 0.05).

    Reference: Stanley & Doucouliagos (2014).
    Returns dict with pet_intercept, pet_p, peese_intercept, peese_p.
    """
    if len(studies) < 10:
        return {}

    yi = np.array([s.yi for s in studies])
    se = np.array([s.se for s in studies])
    vi = se ** 2

    n = len(studies)

    # PET: OLS regression of yi on se.
    X_pet = np.column_stack([np.ones(n), se])
    try:
        XtX_inv = np.linalg.inv(X_pet.T @ X_pet)
        beta_pet = XtX_inv @ X_pet.T @ yi
        resid = yi - X_pet @ beta_pet
        mse = float(np.sum(resid ** 2) / (n - 2))
        var_beta = XtX_inv * mse
        se_b0 = math.sqrt(var_beta[0, 0]) if var_beta[0, 0] > 0 else float("nan")
        t_pet = beta_pet[0] / se_b0 if se_b0 > 0 else 0
        p_pet = 2 * sp_stats.t.sf(abs(t_pet), n - 2)
    except (np.linalg.LinAlgError, ValueError):
        return {}

    # PEESE: OLS regression of yi on vi.
    X_peese = np.column_stack([np.ones(n), vi])
    try:
        XtX2_inv = np.linalg.inv(X_peese.T @ X_peese)
        beta_peese = XtX2_inv @ X_peese.T @ yi
        resid2 = yi - X_peese @ beta_peese
        mse2 = float(np.sum(resid2 ** 2) / (n - 2))
        var_beta2 = XtX2_inv * mse2
        se_b0_2 = math.sqrt(var_beta2[0, 0]) if var_beta2[0, 0] > 0 else float("nan")
        t_peese = beta_peese[0] / se_b0_2 if se_b0_2 > 0 else 0
        p_peese = 2 * sp_stats.t.sf(abs(t_peese), n - 2)
    except (np.linalg.LinAlgError, ValueError):
        return {"pet_intercept": float(beta_pet[0]), "pet_p": float(p_pet)}

    return {
        "pet_intercept": float(beta_pet[0]),
        "pet_p": float(p_pet),
        "peese_intercept": float(beta_peese[0]),
        "peese_p": float(p_peese),
    }


def run_all_tests(studies: list[StudyEffect], effect_measure: str) -> PublicationBiasResult:
    """Run all publication bias tests and return combined results."""
    result = PublicationBiasResult()

    if len(studies) >= 10:
        try:
            result.egger_intercept, result.egger_se, result.egger_p_value = egger_test(studies)
        except Exception as e:
            logger.warning(f"Egger test failed: {e}")
        try:
            result.begg_tau, result.begg_p_value = begg_test(studies)
        except Exception as e:
            logger.warning(f"Begg test failed: {e}")
        try:
            pp = pet_peese(studies)
            result.pet_intercept = pp.get("pet_intercept")
            result.pet_p_value = pp.get("pet_p")
            result.peese_intercept = pp.get("peese_intercept")
            result.peese_p_value = pp.get("peese_p")
        except Exception as e:
            logger.warning(f"PET-PEESE failed: {e}")

    if len(studies) >= 10:
        try:
            n_miss, adj_eff, adj_lo, adj_hi = trim_and_fill(studies, effect_measure)
            result.trim_fill_missing = n_miss
            result.trim_fill_adjusted_effect = adj_eff
            result.trim_fill_adjusted_ci_lower = adj_lo
            result.trim_fill_adjusted_ci_upper = adj_hi
        except Exception as e:
            logger.warning(f"Trim-and-fill failed: {e}")

    try:
        result.failsafe_n = failsafe_n(studies)
    except Exception as e:
        logger.warning(f"Fail-safe N failed: {e}")

    return result
