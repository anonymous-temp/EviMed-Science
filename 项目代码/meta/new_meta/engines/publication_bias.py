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


def egger_test(studies: list[StudyEffect]) -> tuple[float, float, float]:
    """Egger's regression test for funnel plot asymmetry.

    Regresses standardized effect (yi/SEi) on precision (1/SEi).
    Returns (intercept, SE_of_intercept, p_value).
    """
    yi = np.array([s.yi for s in studies])
    se = np.array([s.se for s in studies])

    precision = 1.0 / se
    std_effect = yi / se

    # Weighted linear regression: std_effect = a + b * precision
    n = len(studies)
    if n < 3:
        return float("nan"), float("nan"), float("nan")

    slope, intercept, r, p, se_slope = sp_stats.linregress(precision, std_effect)

    # P-value for intercept (test if intercept = 0)
    x = precision
    x_mean = np.mean(x)
    ss_x = np.sum((x - x_mean) ** 2)
    y_pred = slope * x + intercept
    residuals = std_effect - y_pred
    mse = np.sum(residuals**2) / (n - 2)
    se_intercept = math.sqrt(mse * (1.0 / n + x_mean**2 / ss_x))
    t_stat = intercept / se_intercept
    p_intercept = 2 * (1 - sp_stats.t.cdf(abs(t_stat), n - 2))

    return float(intercept), float(se_intercept), float(p_intercept)


def begg_test(studies: list[StudyEffect]) -> tuple[float, float]:
    """Begg and Mazumdar's rank correlation test.

    Kendall's tau between effect sizes and their variances.
    Returns (tau, p_value).
    """
    yi = np.array([s.yi for s in studies])
    vi = np.array([s.vi for s in studies])

    if len(studies) < 3:
        return float("nan"), float("nan")

    tau, p = sp_stats.kendalltau(yi, vi)
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


def trim_and_fill(studies: list[StudyEffect], effect_measure: str, side: str = "auto") -> tuple[int, float, float, float]:
    """Duval and Tweedie's trim-and-fill method.

    Estimates number of missing studies and adjusted pooled effect.
    Returns (n_missing, adjusted_pooled, adj_ci_lower, adj_ci_upper).
    All on original scale.
    """
    from new_meta.engines.meta_engine import random_effects_dl, _to_original

    yi = np.array([s.yi for s in studies])
    vi = np.array([s.vi for s in studies])
    k = len(studies)
    if side == "auto":
        side = _trim_fill_side_from_asymmetry(studies)
    if side not in {"left", "right"}:
        raise ValueError("trim-and-fill side must be 'left', 'right', or 'auto'")

    # Get initial pooled estimate
    initial = random_effects_dl(studies, effect_measure, "_trim_fill")
    theta = initial.pooled_log if initial.pooled_log is not None else initial.pooled_effect

    # Iterative trim-and-fill (Duval & Tweedie 2000, R0 estimator)
    k0 = 0
    for _iteration in range(10):
        di = yi - theta
        abs_di = np.abs(di)
        ranks = sp_stats.rankdata(abs_di)

        if side == "right":
            sign_indicator = (di > 0).astype(float)
        else:
            sign_indicator = (di < 0).astype(float)

        # R0 estimator: k0 = (4*S - k) / 2, where S = sum of ranks for positive/negative di
        s_val = np.sum(sign_indicator * ranks)
        k0_new = max(0, int(round((4 * s_val - k) / 2)))
        k0_new = min(k0_new, k)  # Cannot impute more studies than observed

        if k0_new == 0:
            return 0, initial.pooled_effect, initial.ci_lower, initial.ci_upper

        # Convergence check
        if k0_new == k0 and _iteration > 0:
            break
        k0 = k0_new

        # Trim the k0 most extreme studies on the specified side and re-estimate theta
        sorted_idx = np.argsort(di) if side == "right" else np.argsort(-di)
        keep_idx = sorted_idx[:k - k0]
        trimmed_studies = [studies[i] for i in keep_idx]
        if len(trimmed_studies) < 2:
            break
        trimmed_result = random_effects_dl(trimmed_studies, effect_measure, "_trim_fill_iter")
        theta = trimmed_result.pooled_log if trimmed_result.pooled_log is not None else trimmed_result.pooled_effect

    # Fill in imputed studies (mirror the k0 most extreme studies about theta)
    di = yi - theta
    abs_di = np.abs(di)
    sorted_idx = np.argsort(abs_di)
    filled_studies = list(studies)
    for i in range(k0):
        idx = sorted_idx[-(i + 1)]
        mirror_yi = 2 * theta - yi[idx]
        filled_studies.append(StudyEffect(
            study_id=f"_filled_{i}",
            study_label=f"Filled {i + 1}",
            yi=float(mirror_yi),
            vi=float(vi[idx]),
            se=float(np.sqrt(vi[idx])),
        ))

    adjusted = random_effects_dl(filled_studies, effect_measure, "_trim_fill_adj")

    return k0, adjusted.pooled_effect, adjusted.ci_lower, adjusted.ci_upper


def failsafe_n(studies: list[StudyEffect], alpha: float = 0.05) -> int:
    """Rosenthal's fail-safe N.

    Number of null-result studies needed to make the combined p > alpha.
    """
    yi = np.array([s.yi for s in studies])
    se = np.array([s.se for s in studies])
    k = len(studies)

    z_scores = yi / se
    z_sum = np.sum(z_scores)
    z_crit = sp_stats.norm.ppf(1 - alpha / 2)

    n_fs = max(0, int((z_sum / z_crit) ** 2 - k))
    return n_fs


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
        p_pet = 2 * (1 - sp_stats.t.cdf(abs(t_pet), n - 2))
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
        p_peese = 2 * (1 - sp_stats.t.cdf(abs(t_peese), n - 2))
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
