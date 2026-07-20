"""Disproportionality statistics for spontaneous-report signal detection.

Deterministic numpy/pandas only — no LLM is involved in any computation.

Formulas (2x2 cells a, b, c, d; N = a+b+c+d):

- ROR  = (a*d) / (b*c),  95% CI = exp(ln ROR +/- 1.96 * SE),
  SE = sqrt(1/a + 1/b + 1/c + 1/d).
  Same construction as the OpenScience evimed-research connector
  (public_sources.py ``adr_signal``); cross-checked in tests.
- PRR  = (a/(a+b)) / (c/(c+d)),  95% CI = exp(ln PRR +/- 1.96 * SE),
  SE = sqrt(1/a - 1/(a+b) + 1/c - 1/(c+d))  (Evans et al. 2001).
- chi2 = N*(a*d - b*c)^2 / ((a+b)(c+d)(a+c)(b+d)), optionally with Yates'
  continuity correction: N*(|a*d - b*c| - N/2)^2 / same denominator.
- IC (crude) = log2(a*N / ((a+b)*(a+c))) — identical to OpenScience.
- IC025: WHO-UMC BCPNN lower 95% credibility limit (Bate et al. 1998),
  Jeffreys prior (1 per cell -> marginal priors 2, total 4):
    E[IC]   = log2( (a+1)(N+4) / ((a+b+2)(a+c+2)) )
    var(IC) = (1/ln 2)^2 * [ (N+4-a-1)     / ((a+1)(N+5))
                           + (N+4-(a+b)-2) / ((a+b+2)(N+5))
                           + (N+4-(a+c)-2) / ((a+c+2)(N+5)) ]
    IC025   = E[IC] - 1.96 * sqrt(var(IC))
- EBGM/EB05: DuMouchel (1999) GPS. The OpenScience connector deliberately
  does NOT implement EBGM ("requires a validated empirical-Bayes
  implementation"), so this module implements the standard two-gamma
  mixture-prior method:
    E = (a+b)(a+c)/N;  prior lambda ~ w*Gamma(a1,b1) + (1-w)*Gamma(a2,b2)
    posterior component i: Gamma(a_i + a, b_i + E) with weight updated by
    the negative-binomial predictive density of a under component i.
    EBGM = exp(E[log(lambda) | n]); EB05 is the posterior 5th percentile
    (bisection over the mixture CDF built on the regularized incomplete
    gamma, _gamma.py).
  The default alpha1=0.2, beta1=0.1, alpha2=2.0, beta2=4.0, w=1/3 values
  are optimization starting values, not a fitted production prior. Use
  ``fit_mgps_prior`` on the complete snapshot analysis matrix and pass the
  returned fitted prior for paper-grade empirical-Bayes GPS results.

When any cell is 0 the ratio statistics are undefined; ``analyze`` applies
the Haldane-Anscombe correction (+0.5 to every cell) and flags it, rather
than refusing to estimate (OpenScience's behavior) or crashing.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy.special import digamma

from ._gamma import regularized_gamma_p
from .tables import ContingencyTable2x2

Z_95 = 1.96
_LN2_SQ = float(np.log(2.0) ** 2)


@dataclass(frozen=True)
class RatioMetric:
    value: float
    ci95_lower: float
    ci95_upper: float


@dataclass(frozen=True)
class ChiSquareResult:
    value: float
    yates_corrected: bool


@dataclass(frozen=True)
class ICResult:
    value: float  # crude IC, OpenScience-compatible
    ic025: float  # BCPNN lower 95% credibility limit
    expectation: float  # BCPNN posterior expectation (shrunk IC)


@dataclass(frozen=True)
class MGPSPrior:
    """Two-gamma GPS prior (historical class name kept for API compatibility)."""

    alpha1: float = 0.2
    beta1: float = 0.1
    alpha2: float = 2.0
    beta2: float = 4.0
    weight: float = 1.0 / 3.0  # documented MGPS optimization starting value
    fitted: bool = False
    fit_id: str | None = None

    def __post_init__(self) -> None:
        values = (self.alpha1, self.beta1, self.alpha2, self.beta2, self.weight)
        if not all(math.isfinite(value) for value in values):
            raise ValueError("GPS hyperparameters must be finite")
        if min(self.alpha1, self.beta1, self.alpha2, self.beta2) <= 0:
            raise ValueError("gamma hyperparameters must be positive")
        if not 0.0 < self.weight < 1.0:
            raise ValueError("mixture weight must be in (0, 1)")


DEFAULT_MGPS_PRIOR = MGPSPrior()


@dataclass(frozen=True)
class EBGMResult:
    value: float  # exp(E[log(lambda) | n]), the empirical-Bayes geometric mean
    eb05: float  # posterior 5th percentile
    expected: float  # expected count E under independence
    posterior_weight1: float  # posterior mixing weight of component 1
    prior: MGPSPrior = field(default_factory=lambda: DEFAULT_MGPS_PRIOR)


@dataclass(frozen=True)
class SignalMetrics:
    table: ContingencyTable2x2  # as analyzed (post-correction if applied)
    haldane_anscombe_applied: bool
    ror: RatioMetric
    prr: RatioMetric
    chi2: ChiSquareResult
    ic: ICResult
    ebgm: EBGMResult


def _estimable(t: ContingencyTable2x2) -> bool:
    return t.a > 0 and t.b > 0 and t.c > 0 and t.d > 0


def ror(t: ContingencyTable2x2) -> RatioMetric:
    """Reporting Odds Ratio with 95% confidence interval."""
    if not _estimable(t):
        raise ValueError("ROR is undefined with a zero cell; apply Haldane-Anscombe first")
    value = (t.a * t.d) / (t.b * t.c)
    se = float(np.sqrt(1.0 / t.a + 1.0 / t.b + 1.0 / t.c + 1.0 / t.d))
    log_v = float(np.log(value))
    return RatioMetric(
        value=float(value),
        ci95_lower=float(np.exp(log_v - Z_95 * se)),
        ci95_upper=float(np.exp(log_v + Z_95 * se)),
    )


def prr(t: ContingencyTable2x2) -> RatioMetric:
    """Proportional Reporting Ratio with 95% confidence interval."""
    if not _estimable(t):
        raise ValueError("PRR is undefined with a zero cell; apply Haldane-Anscombe first")
    value = (t.a / (t.a + t.b)) / (t.c / (t.c + t.d))
    se = float(np.sqrt(1.0 / t.a - 1.0 / (t.a + t.b) + 1.0 / t.c - 1.0 / (t.c + t.d)))
    log_v = float(np.log(value))
    return RatioMetric(
        value=float(value),
        ci95_lower=float(np.exp(log_v - Z_95 * se)),
        ci95_upper=float(np.exp(log_v + Z_95 * se)),
    )


def chi_square(t: ContingencyTable2x2, *, yates: bool = False) -> ChiSquareResult:
    """Pearson chi-square (1 df), optionally Yates continuity-corrected."""
    denom = (t.a + t.b) * (t.c + t.d) * (t.a + t.c) * (t.b + t.d)
    if denom == 0:
        raise ValueError("chi-square is undefined with an empty margin")
    n = t.n
    cross = t.a * t.d - t.b * t.c
    if yates:
        cross = max(abs(cross) - n / 2.0, 0.0)
        value = n * cross * cross / denom
    else:
        value = n * cross * cross / denom
    return ChiSquareResult(value=float(value), yates_corrected=yates)


def information_component(t: ContingencyTable2x2) -> ICResult:
    """Crude IC (OpenScience-compatible) plus BCPNN IC025."""
    if not _estimable(t):
        raise ValueError("IC is undefined with a zero cell; apply Haldane-Anscombe first")
    n = t.n
    crude = float(np.log2((t.a * n) / ((t.a + t.b) * (t.a + t.c))))
    # BCPNN with Jeffreys prior: gamma11 = 1, gamma1. = gamma.1 = 2, gamma = 4.
    n_shrunk = n + 4.0
    a_shrunk = t.a + 1.0
    row_shrunk = t.a + t.b + 2.0
    col_shrunk = t.a + t.c + 2.0
    expectation = float(np.log2((a_shrunk * n_shrunk) / (row_shrunk * col_shrunk)))
    var = (1.0 / _LN2_SQ) * (
        (n_shrunk - a_shrunk) / (a_shrunk * (1.0 + n_shrunk))
        + (n_shrunk - row_shrunk) / (row_shrunk * (1.0 + n_shrunk))
        + (n_shrunk - col_shrunk) / (col_shrunk * (1.0 + n_shrunk))
    )
    ic025 = expectation - Z_95 * float(np.sqrt(var))
    return ICResult(value=crude, ic025=float(ic025), expectation=expectation)


def ebgm(t: ContingencyTable2x2, prior: MGPSPrior = DEFAULT_MGPS_PRIOR) -> EBGMResult:
    """DuMouchel GPS empirical-Bayes geometric mean and EB05."""
    n = t.n
    expected = (t.a + t.b) * (t.a + t.c) / n if n > 0 else 0.0
    if expected < 0:
        raise ValueError("EBGM requires a non-negative expected count E")
    a = t.a
    components = (
        (prior.alpha1, prior.beta1, prior.weight),
        (prior.alpha2, prior.beta2, 1.0 - prior.weight),
    )
    if expected == 0.0:
        if a != 0.0:
            raise ValueError("positive observed count is inconsistent with E=0")
        shapes = [alpha for alpha, _, _ in components]
        rates = [beta for _, beta, _ in components]
        post_weights = [prior.weight, 1.0 - prior.weight]
        expected_log_lambda = sum(
            weight * (float(digamma(shape)) - float(np.log(rate)))
            for weight, shape, rate in zip(post_weights, shapes, rates, strict=True)
        )
        return EBGMResult(
            value=float(np.exp(expected_log_lambda)),
            eb05=float(_mixture_quantile(0.05, shapes, rates, post_weights)),
            expected=0.0,
            posterior_weight1=prior.weight,
            prior=prior,
        )
    # Negative-binomial predictive density of ``a`` under each prior
    # component, computed in log space for numerical stability.
    log_preds = []
    for alpha, beta, _w in components:
        log_p = (
            _log_gamma(alpha + a)
            - _log_gamma(alpha)
            - _log_gamma(a + 1.0)
            + alpha * float(np.log(beta))
            + a * float(np.log(expected))
            - (alpha + a) * float(np.log(beta + expected))
        )
        log_preds.append(log_p)
    log_weights = [
        float(np.log(w)) + lp for (_, _, w), lp in zip(components, log_preds, strict=True)
    ]
    norm = _log_sum_exp(log_weights)
    post_weights = [float(np.exp(lw - norm)) for lw in log_weights]

    shapes = [alpha + a for alpha, _, _ in components]
    rates = [beta + expected for _, beta, _ in components]
    expected_log_lambda = sum(
        w * (float(digamma(shape)) - float(np.log(rate)))
        for w, shape, rate in zip(post_weights, shapes, rates, strict=True)
    )
    value = float(np.exp(expected_log_lambda))
    eb05 = _mixture_quantile(0.05, shapes, rates, post_weights)
    return EBGMResult(
        value=float(value),
        eb05=float(eb05),
        expected=float(expected),
        posterior_weight1=post_weights[0],
        prior=prior,
    )


def analyze(
    table: ContingencyTable2x2,
    *,
    yates: bool = False,
    prior: MGPSPrior = DEFAULT_MGPS_PRIOR,
    correct_zero_cells: bool = True,
) -> SignalMetrics:
    """Full disproportionality panel for one 2x2 table.

    Zero cells trigger the Haldane-Anscombe correction (+0.5 everywhere)
    unless ``correct_zero_cells`` is False — in which case an explicit
    ValueError is raised (mirroring OpenScience's "not estimable" outcome,
    but as a typed failure instead of a silent omission).
    """
    corrected = False
    t = table
    if table.needs_correction:
        if not correct_zero_cells:
            raise ValueError(
                "2x2 table has a zero cell and correction is disabled; "
                "statistics are not estimable"
            )
        t = table.corrected()
        corrected = True
    return SignalMetrics(
        table=t,
        haldane_anscombe_applied=corrected,
        ror=ror(t),
        prr=prr(t),
        chi2=chi_square(t, yates=yates),
        ic=information_component(t),
        # GPS models the observed count directly and must not receive
        # Haldane-Anscombe pseudo-counts used by ratio estimators.
        ebgm=ebgm(table, prior),
    )


def analyze_dataframe(
    counts: pd.DataFrame,
    *,
    yates: bool = False,
    prior: MGPSPrior = DEFAULT_MGPS_PRIOR,
) -> pd.DataFrame:
    """Batch panel: one row per drug-ADR pair with columns a, b, c, d.

    Extra columns (e.g. drug, reaction) are carried through; metric columns
    are appended. This is the signal-table workhorse for the P4 analysis
    chain and the CSV export.
    """
    required = {"a", "b", "c", "d"}
    missing = required - set(counts.columns)
    if missing:
        raise ValueError(f"counts frame misses columns: {sorted(missing)}")
    rows = []
    for _, row in counts.iterrows():
        table = ContingencyTable2x2(
            a=float(row["a"]), b=float(row["b"]), c=float(row["c"]), d=float(row["d"])
        )
        metrics = analyze(table, yates=yates, prior=prior)
        rows.append(
            {
                **{k: row[k] for k in counts.columns if k not in ("a", "b", "c", "d")},
                "a": table.a,
                "b": table.b,
                "c": table.c,
                "d": table.d,
                "N": table.n,
                "haldane_anscombe_applied": metrics.haldane_anscombe_applied,
                "ror": metrics.ror.value,
                "ror_ci95_lower": metrics.ror.ci95_lower,
                "ror_ci95_upper": metrics.ror.ci95_upper,
                "prr": metrics.prr.value,
                "prr_ci95_lower": metrics.prr.ci95_lower,
                "prr_ci95_upper": metrics.prr.ci95_upper,
                "chi2": metrics.chi2.value,
                "ic": metrics.ic.value,
                "ic025": metrics.ic.ic025,
                "ebgm": metrics.ebgm.value,
                "eb05": metrics.ebgm.eb05,
            }
        )
    return pd.DataFrame(rows)


# -- internal helpers ------------------------------------------------------


def _log_gamma(x: float) -> float:
    return math.lgamma(x)


def _log_sum_exp(values: list[float]) -> float:
    peak = max(values)
    return peak + float(np.log(sum(np.exp(v - peak) for v in values)))


def _mixture_cdf(x: float, shapes: list[float], rates: list[float], weights: list[float]) -> float:
    return sum(
        w * regularized_gamma_p(s, r * x)
        for w, s, r in zip(weights, shapes, rates, strict=True)
    )


# z-score of the posterior percentiles we invert (currently only EB05).
_Z_05 = -1.6448536269514729


def _wilson_hilferty_quantile(shape: float, rate: float, z: float) -> float:
    """Approximate Gamma(shape, rate) quantile (Wilson-Hilferty transform).

    Accurate to ~1e-4 relative for large shapes; used only as the *initial
    guess* for the exact bisection, which matters because evaluating the
    gamma CDF right at the mean (x ~= shape) makes the power series in
    _gamma.py converge extremely slowly for large observed counts a.
    """
    if shape <= 0 or rate <= 0:
        return 0.0
    cube = 1.0 - 1.0 / (9.0 * shape) + z / (3.0 * math.sqrt(shape))
    if cube <= 0.0:
        return shape / rate * 0.5
    return (shape / rate) * cube * cube * cube


def _mixture_quantile(
    p: float,
    shapes: list[float],
    rates: list[float],
    weights: list[float],
) -> float:
    """Inversion of the monotone mixture posterior CDF.

    The bracket starts from a Wilson-Hilferty guess of the dominant
    component (away from the slow series diagonal), then bisection refines
    to machine precision with an early relative-convergence exit.
    """
    z = _Z_05 if p == 0.05 else _normal_quantile_approx(p)
    dominant = max(range(len(weights)), key=weights.__getitem__)
    start = _wilson_hilferty_quantile(shapes[dominant], rates[dominant], z)
    if start <= 0.0:
        start = shapes[dominant] / rates[dominant]
    lo, hi = 0.0, start
    while _mixture_cdf(hi, shapes, rates, weights) < p:
        lo, hi = hi, hi * 2.0 if hi > 0 else 1e-6
        if hi > 1e12:
            raise ArithmeticError("could not bracket the EB quantile")
    if lo > 0.0 and _mixture_cdf(lo, shapes, rates, weights) >= p:
        lo = 0.0
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if _mixture_cdf(mid, shapes, rates, weights) < p:
            lo = mid
        else:
            hi = mid
        if hi - lo <= 1e-12 * max(1.0, hi):
            break
    return 0.5 * (lo + hi)


def _normal_quantile_approx(p: float) -> float:
    """Acklam's rational approximation of the standard normal quantile."""
    if not 0.0 < p < 1.0:
        raise ValueError(f"p must be in (0, 1), got {p!r}")
    a = [-3.969683028665376e01, 2.209460984245205e02, -2.759285104469687e02,
         1.383577518672690e02, -3.066479806614716e01, 2.506628277459239e00]
    b = [-5.447609879822406e01, 1.615858368580409e02, -1.556989798598866e02,
         6.680131188771972e01, -1.328068155288572e01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e00,
         -2.549732539343734e00, 4.374664141464968e00, 2.938163982698783e00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e00,
         3.754408661907416e00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2.0 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0
        )
    if p > phigh:
        return -_normal_quantile_approx(1.0 - p)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (
        ((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0
    )
