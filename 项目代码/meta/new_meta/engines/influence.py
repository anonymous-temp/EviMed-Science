"""Influence diagnostics and advanced sensitivity analysis.

Provides Cook's distance, DFBETAS, hat values, and Baujat plot data
for identifying influential studies in meta-analysis.
All computations are deterministic (numpy/scipy), no LLM involved.
"""
from __future__ import annotations

import numpy as np
from scipy import stats

from new_meta.schemas.meta_result import StudyEffect


def influence_diagnostics(
    studies: list[StudyEffect],
    model: str = "random",
) -> list[dict]:
    """Compute influence diagnostics for each study.

    Returns list of dicts with: study_id, study_label,
    cooks_distance, hat_value, dfbetas, externally_standardized_residual,
    contribution_to_q (for Baujat plot).

    Reference: Viechtbauer & Cheung (2010).
    """
    if len(studies) < 3:
        return []

    k = len(studies)
    yi = np.array([s.yi for s in studies])
    vi = np.array([s.vi for s in studies])

    # Estimate tau2
    wi_fe = 1.0 / vi
    pooled_fe = np.sum(wi_fe * yi) / np.sum(wi_fe)
    Q = float(np.sum(wi_fe * (yi - pooled_fe) ** 2))

    if model == "random":
        c = np.sum(wi_fe) - np.sum(wi_fe ** 2) / np.sum(wi_fe)
        tau2 = max(0.0, (Q - (k - 1)) / c) if c > 0 else 0.0
    else:
        tau2 = 0.0

    wi = 1.0 / (vi + tau2)
    W = np.diag(wi)
    X = np.ones((k, 1))

    # Hat matrix: H = W^{1/2} X (X'WX)^{-1} X' W^{1/2}
    XtWX_inv = 1.0 / np.sum(wi)
    pooled = np.sum(wi * yi) / np.sum(wi)
    h = wi * XtWX_inv  # diagonal of hat matrix for intercept-only model

    # Residuals
    resid = yi - pooled
    # Standardized residuals
    sigma2 = 1.0  # working variance = 1 for WLS
    e_std = resid * np.sqrt(wi)  # internally standardized

    # Externally standardized residual (leave-one-out)
    e_ext = np.zeros(k)
    for i in range(k):
        if (1 - h[i]) > 1e-10:
            e_ext[i] = e_std[i] / np.sqrt(1 - h[i])

    # Cook's distance
    # D_i = (e_std_i^2 * h_i) / (p * (1 - h_i)^2) for p=1 parameter
    cooks_d = np.zeros(k)
    for i in range(k):
        if (1 - h[i]) > 1e-10:
            cooks_d[i] = e_std[i] ** 2 * h[i] / (1.0 * (1 - h[i]) ** 2)

    # DFBETAS: change in pooled estimate when study i is removed
    dfbetas = np.zeros(k)
    for i in range(k):
        if (1 - h[i]) > 1e-10:
            dfbetas[i] = (wi[i] * resid[i]) / (np.sum(wi) * (1 - h[i]))

    # Contribution to Q (Baujat x-axis) and influence on pooled (Baujat y-axis)
    contrib_q = wi * resid ** 2  # study contribution to Q statistic

    # Leave-one-out influence on pooled
    loo_influence = np.zeros(k)
    for i in range(k):
        mask = np.ones(k, dtype=bool)
        mask[i] = False
        wi_sub = wi[mask]
        yi_sub = yi[mask]
        if np.sum(wi_sub) > 0:
            pooled_loo = np.sum(wi_sub * yi_sub) / np.sum(wi_sub)
            loo_influence[i] = abs(pooled - pooled_loo)

    results = []
    for i, s in enumerate(studies):
        results.append({
            "study_id": s.study_id,
            "study_label": s.study_label,
            "hat_value": float(h[i]),
            "cooks_distance": float(cooks_d[i]),
            "dfbetas": float(dfbetas[i]),
            "ext_std_residual": float(e_ext[i]),
            "contribution_to_q": float(contrib_q[i]),
            "loo_influence": float(loo_influence[i]),
        })
    return results


def p_curve_analysis(
    studies: list[StudyEffect],
) -> dict:
    """P-curve analysis for detecting p-hacking and evidential value.

    Tests whether the distribution of significant p-values (<0.05)
    is right-skewed (evidential value) or flat/left-skewed (p-hacking).

    Reference: Simonsohn, Nelson & Simmons (2014).
    Returns dict with: n_significant, pp_values, binomial_right_skew_p,
    binomial_flat_p, conclusion.
    """
    if len(studies) < 3:
        return {"n_significant": 0, "conclusion": "insufficient_studies"}

    yi = np.array([s.yi for s in studies])
    se = np.array([s.se for s in studies])

    # Compute two-tailed p-values
    z_scores = yi / se
    p_values = 2 * (1 - stats.norm.cdf(np.abs(z_scores)))

    # Select significant p-values (p < 0.05)
    sig_mask = p_values < 0.05
    sig_p = p_values[sig_mask]
    n_sig = len(sig_p)

    if n_sig < 3:
        return {
            "n_significant": n_sig,
            "conclusion": "too_few_significant",
            "total_studies": len(studies),
        }

    # PP-values: probability of observing p_i or smaller under the null
    # Under H0: p-values are uniform(0, 0.05), so PP = p_i / 0.05
    pp_values = sig_p / 0.05

    # Test 1: Right-skew test (evidential value)
    # Under H0 (no effect), PP-values are uniform(0,1)
    # Under H1 (real effect), PP-values are right-skewed (concentrated near 0)
    n_below_half = np.sum(pp_values < 0.5)
    # Binomial test: more than half should be < 0.5 under right skew
    right_skew_p = float(stats.binomtest(int(n_below_half), n_sig, 0.5, alternative="greater").pvalue)

    # Test 2: Flatness test (33% power test)
    # If p-curve is flatter than expected with 33% power, suggests p-hacking
    n_below_quarter = np.sum(pp_values < 0.25)
    flat_p = float(stats.binomtest(int(n_below_quarter), n_sig, 0.25, alternative="less").pvalue)

    # Conclusion
    if right_skew_p < 0.05:
        conclusion = "evidential_value"
    elif flat_p < 0.05:
        conclusion = "p_hacking_suspected"
    else:
        conclusion = "inconclusive"

    return {
        "n_significant": n_sig,
        "total_studies": len(studies),
        "pp_values": pp_values.tolist(),
        "right_skew_p": right_skew_p,
        "flat_p": flat_p,
        "conclusion": conclusion,
    }


def paule_mandel_tau2(
    studies: list[StudyEffect],
    max_iter: int = 100,
    tol: float = 1e-8,
) -> float:
    """Estimate τ² using the Paule-Mandel (empirical Bayes) estimator.

    Iterative estimator that solves Q(τ²) = k-1 where Q is computed
    with random-effects weights.

    Reference: Paule & Mandel (1982), Veroniki et al. (2016).
    """
    k = len(studies)
    if k < 2:
        return 0.0

    yi = np.array([s.yi for s in studies])
    vi = np.array([s.vi for s in studies])

    # Initialize with DL
    wi_fe = 1.0 / vi
    pooled_fe = np.sum(wi_fe * yi) / np.sum(wi_fe)
    Q_fe = np.sum(wi_fe * (yi - pooled_fe) ** 2)
    c = np.sum(wi_fe) - np.sum(wi_fe ** 2) / np.sum(wi_fe)
    tau2 = max(0.0, (Q_fe - (k - 1)) / c) if c > 0 else 0.0

    for _ in range(max_iter):
        wi = 1.0 / (vi + tau2)
        pooled = np.sum(wi * yi) / np.sum(wi)
        Q = np.sum(wi * (yi - pooled) ** 2)

        # We want to solve Q(tau2) = k - 1
        # Gradient: dQ/dtau2 = -sum(wi^2 * (yi - pooled)^2) + ...
        # Use secant-like update
        target = k - 1
        if abs(Q - target) < tol:
            break

        # Derivative approximation
        dQ = -np.sum(wi ** 2 * (yi - pooled) ** 2) + np.sum(wi ** 2) * pooled ** 2 / np.sum(wi) ** 2
        if abs(dQ) < 1e-12:
            break

        step = (Q - target) / (-dQ)
        tau2_new = max(0.0, tau2 + step)

        if abs(tau2_new - tau2) < tol:
            tau2 = tau2_new
            break
        tau2 = tau2_new

    return tau2
