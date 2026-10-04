"""Effect size computation engine — deterministic, no LLM.

Supports:
- Dichotomous: OR, RR, RD (from 2x2 table)
- Continuous: MD, SMD/Hedges' g (from means, SDs, Ns)
- Time-to-event: HR (from hazard ratio + CI/SE)
- Proportion: Freeman-Tukey double arcsine transformation (single-arm)
- Correlation: Fisher's z transformation
- Incidence rate: IRR (from events + person-years)
- Conversions: CI→SE, p→SE, median/IQR→mean/SD, OR↔RR
"""

import math
import numpy as np
from scipy import stats

from new_meta.schemas.outcome_types import PAIRWISE_EFFECT_MEASURES_BY_OUTCOME_TYPE


# =============================================================================
# Dichotomous outcomes — from 2x2 table (a, b, c, d)
#   Intervention:  events=a, non-events=b, total=a+b
#   Control:       events=c, non-events=d, total=c+d
# =============================================================================

def odds_ratio(a: int, b: int, c: int, d: int, correction: float = 0.5):
    """Compute log(OR) and its variance from a 2x2 table.

    Returns (log_OR, variance) on the log scale.
    """
    a, b, c, d = _apply_zero_correction(a, b, c, d, correction)
    log_or = math.log(a * d) - math.log(b * c)
    var = 1.0 / a + 1.0 / b + 1.0 / c + 1.0 / d
    return log_or, var


def risk_ratio(a: int, b: int, c: int, d: int, correction: float = 0.5):
    """Compute log(RR) and its variance from a 2x2 table.

    Returns (log_RR, variance) on the log scale.
    """
    a, b, c, d = _apply_zero_correction(a, b, c, d, correction)
    n1, n2 = a + b, c + d
    log_rr = math.log(a / n1) - math.log(c / n2)
    var = 1.0 / a - 1.0 / n1 + 1.0 / c - 1.0 / n2
    return log_rr, var


def risk_difference(a: int, b: int, c: int, d: int):
    """Compute RD and its variance from a 2x2 table.

    Returns (RD, variance) on the original scale.
    """
    n1, n2 = a + b, c + d
    p1, p2 = a / n1, c / n2
    rd = p1 - p2
    var = p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2
    return rd, var


def _apply_zero_correction(a, b, c, d, correction=0.5):
    """Haldane-Anscombe continuity correction at the study level.

    When any cell of a study's 2 x 2 table is zero the correction is added to
    all four cells of that table, and to no other study's table. This is what
    metafor's ``escalc(add=1/2, to="only0")``, RevMan, the Cochrane Handbook
    (10.4.4.1) and the sibling DTA engine (mada ``correction.control="all"``)
    do. Correcting only the zero cell, as this function once did, gave a
    different log OR than every one of them for the same table (Egger 2001
    magnesium trial 8, 0/22 vs 1/21: -0.79 against the published -1.19).
    """
    if a == 0 or b == 0 or c == 0 or d == 0:
        return (float(a + correction), float(b + correction), float(c + correction), float(d + correction))
    return float(a), float(b), float(c), float(d)


# =============================================================================
# Continuous outcomes — from means, SDs, sample sizes
# =============================================================================

def mean_difference(mean1: float, sd1: float, n1: int, mean2: float, sd2: float, n2: int):
    """Compute MD and its variance.

    Returns (MD, variance).
    """
    md = mean1 - mean2
    var = sd1**2 / n1 + sd2**2 / n2
    return md, var


def standardized_mean_difference(mean1: float, sd1: float, n1: int, mean2: float, sd2: float, n2: int):
    """Compute Hedges' g (bias-corrected SMD) and its variance.

    Returns (g, variance).
    Reference: Hedges (1981); Hedges & Olkin (1985) eq. 8 (the large-sample
    variance, written in terms of the corrected g); the same estimator and
    variance as metafor's ``escalc(measure="SMD")``.

    The correction factor is the exact ratio of gamma functions, not the
    ``1 - 3/(4*df - 1)`` approximation. The variance is
    ``(n1+n2)/(n1*n2) + g^2/(2*(n1+n2))``: it once read ``d^2/(2*df)`` times
    J squared, which is neither this nor the Borenstein et al. (2009) form
    ``J^2 * ((n1+n2)/(n1*n2) + d^2/(2*(n1+n2)))`` it cited, and was 1-3% too small
    for the Normand (1999) trials (0.0629 against metafor's 0.0645).
    """
    df = n1 + n2 - 2
    if df <= 0:
        raise ValueError(f"Insufficient sample sizes: n1={n1}, n2={n2}")

    # Pooled SD
    s_pooled = math.sqrt(((n1 - 1) * sd1**2 + (n2 - 1) * sd2**2) / df)
    if s_pooled == 0:
        raise ValueError("Pooled SD is zero — cannot compute SMD")

    # Cohen's d
    d = (mean1 - mean2) / s_pooled

    # Hedges' correction factor J = Gamma(df/2) / (sqrt(df/2) * Gamma((df-1)/2))
    j = math.exp(math.lgamma(df / 2.0) - 0.5 * math.log(df / 2.0) - math.lgamma((df - 1) / 2.0))

    # Hedges' g
    g = d * j

    var_g = (n1 + n2) / (n1 * n2) + g**2 / (2.0 * (n1 + n2))

    return g, var_g


# =============================================================================
# Conversions & helpers
# =============================================================================

def ci_to_se(ci_lower: float, ci_upper: float, log_scale: bool = False) -> float:
    """Convert 95% CI to SE.

    For ratio measures (OR, RR), set log_scale=True — CIs are on original scale,
    conversion happens on log scale.
    """
    if log_scale:
        se = (math.log(ci_upper) - math.log(ci_lower)) / 3.92
    else:
        se = (ci_upper - ci_lower) / 3.92
    return se


def p_to_se(effect: float, p_value: float, log_scale: bool = False) -> float:
    """Convert p-value and effect size to SE using the normal approximation.

    z = effect / SE  =>  SE = effect / z
    """
    if p_value <= 0 or p_value >= 1:
        return float("nan")
    z = abs(stats.norm.ppf(p_value / 2))
    if z == 0:
        return float("nan")
    if log_scale:
        se = abs(math.log(effect)) / z
    else:
        se = abs(effect) / z
    return se


def median_iqr_to_mean_sd(median: float, q1: float, q3: float, n: int) -> tuple[float, float]:
    """Estimate mean and SD from median, Q1, Q3, and n.

    Uses Wan et al. (2014) method for the scenario with Q1, median, Q3.
    """
    if n < 3:
        raise ValueError(f"Wan et al. method requires n >= 3, got n={n}")
    mean = (q1 + median + q3) / 3.0
    denom = 2 * stats.norm.ppf((0.75 * n - 0.125) / (n + 0.25))
    if abs(denom) < 1e-10:
        raise ValueError("Denominator too small in median/IQR conversion")
    sd = (q3 - q1) / denom
    return mean, max(abs(sd), 0.001)


def median_range_to_mean_sd(median: float, a: float, b: float, n: int) -> tuple[float, float]:
    """Estimate mean and SD from median, min (a), max (b), and n.

    Uses Hozo et al. (2005) / Wan et al. (2014) method.
    """
    if n < 3:
        raise ValueError(f"Wan et al. method requires n >= 3, got n={n}")
    mean = (a + 2 * median + b) / 4.0
    denom = 2 * stats.norm.ppf((n - 0.375) / (n + 0.25))
    if abs(denom) < 1e-10:
        raise ValueError("Denominator too small in median/range conversion")
    sd = (b - a) / denom
    return mean, max(abs(sd), 0.001)


def or_to_rr(log_or: float, p0: float) -> float:
    """Convert log(OR) to log(RR) given baseline risk p0.

    RR = OR / (1 - p0 + p0 * OR)   =>   log(RR) computed from that.
    """
    or_val = math.exp(log_or)
    rr = or_val / (1 - p0 + p0 * or_val)
    return math.log(rr)


# =============================================================================
# Time-to-event outcomes — Hazard Ratio
# =============================================================================

def hazard_ratio(hr: float, ci_lower: float = None, ci_upper: float = None,
                 se: float = None, p_value: float = None) -> tuple[float, float]:
    """Compute log(HR) and its variance from reported hazard ratio.

    Accepts HR + CI, HR + SE, or HR + p-value.
    Returns (log_HR, variance) on the log scale.
    """
    if hr <= 0:
        raise ValueError(f"Hazard ratio must be positive, got {hr}")

    log_hr = math.log(hr)

    if se is not None and se > 0:
        return log_hr, se ** 2
    if ci_lower is not None and ci_upper is not None and ci_lower > 0 and ci_upper > 0:
        se_calc = (math.log(ci_upper) - math.log(ci_lower)) / 3.92
        return log_hr, se_calc ** 2
    if p_value is not None and 0 < p_value < 1:
        z = abs(stats.norm.ppf(p_value / 2))
        if z > 0:
            se_calc = abs(log_hr) / z
            return log_hr, se_calc ** 2

    raise ValueError("Insufficient data for HR: need CI, SE, or p-value")


# =============================================================================
# Proportion outcomes — Freeman-Tukey double arcsine transformation
# =============================================================================

def proportion_freeman_tukey(events: int, total: int) -> tuple[float, float]:
    """Freeman-Tukey double arcsine transformation for single-arm proportions.

    Reference: Freeman & Tukey (1950), Miller (1978).
    Returns (yi, vi) where yi is the transformed proportion.
    """
    if total <= 0:
        raise ValueError(f"Total must be positive, got {total}")
    if events < 0 or events > total:
        raise ValueError(f"Events ({events}) must be between 0 and {total}")

    yi = math.asin(math.sqrt(events / (total + 1))) + math.asin(math.sqrt((events + 1) / (total + 1)))
    vi = 1.0 / (total + 0.5)
    return yi, vi


def proportion_back_transform(yi: float, vi: float, n: float) -> float:
    """Back-transform Freeman-Tukey double arcsine to proportion.

    Uses Miller (1978) inverse: p = (1 - sign(cos(yi)) * sqrt(1 - (sin(yi) + (sin(yi)-1/sin(yi))/(n+0.5))^2 )) / 2
    Simplified approximation: p = 0.5 * (1 - sign * sqrt(1 - (sin(yi) + (sin(yi) - 1/sin(yi))/n_tilde)^2))
    """
    # Simplified back-transformation
    sin_yi = math.sin(yi)
    n_tilde = n + 0.5
    inner = sin_yi + (sin_yi - 1.0 / sin_yi) / n_tilde if abs(sin_yi) > 1e-10 else 0
    val = max(-1, min(1, inner))
    p = 0.5 * (1 - math.copysign(1, math.cos(yi)) * math.sqrt(max(0, 1 - val ** 2)))
    return max(0.0, min(1.0, p))


# =============================================================================
# Correlation outcomes — Fisher's z transformation
# =============================================================================

def correlation_fisher_z(r: float, n: int) -> tuple[float, float]:
    """Fisher's z transformation for correlation coefficients.

    z = 0.5 * ln((1+r)/(1-r)), var = 1/(n-3)
    Reference: Fisher (1921).
    Returns (z, variance).
    """
    if not -1 < r < 1:
        raise ValueError(f"Correlation must be strictly between -1 and 1, got {r}")
    if n < 4:
        raise ValueError(f"Fisher z requires n >= 4, got {n}")

    z = 0.5 * math.log((1 + r) / (1 - r))
    vi = 1.0 / (n - 3)
    return z, vi


def fisher_z_back_transform(z: float) -> float:
    """Back-transform Fisher's z to correlation r.

    r = (exp(2z) - 1) / (exp(2z) + 1) = tanh(z)
    """
    return math.tanh(z)


# =============================================================================
# Incidence rate ratio
# =============================================================================

def incidence_rate_ratio(events_i: int, pyears_i: float, events_c: int, pyears_c: float,
                         correction: float = 0.5) -> tuple[float, float]:
    """Compute log(IRR) and its variance from events and person-years.

    Returns (log_IRR, variance) on the log scale. When either arm has no
    events the correction is added to both event counts (metafor
    ``escalc(measure="IRR", add=1/2, to="only0")``), so a single-zero study is
    not tilted by correcting one arm alone.
    """
    if pyears_i <= 0 or pyears_c <= 0:
        raise ValueError("Person-years must be positive")
    if events_i == 0 or events_c == 0:
        e_i, e_c = events_i + correction, events_c + correction
    else:
        e_i, e_c = events_i, events_c
    if e_i <= 0 or e_c <= 0:
        raise ValueError("Events (after correction) must be positive")

    rate_i = e_i / pyears_i
    rate_c = e_c / pyears_c
    log_irr = math.log(rate_i / rate_c)
    vi = 1.0 / e_i + 1.0 / e_c
    return log_irr, vi


class EffectInputMismatch(ValueError):
    """A typed source value cannot be used for the requested effect measure."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message + " Adjudicate the source effect type and measure before pooling.")


def _require_reported_measure(reported: str, requested: str, scale: str) -> None:
    if not reported:
        raise EffectInputMismatch(
            "reported_effect_measure_required",
            "The generic reported effect has no declared measure.",
        )
    if reported != requested:
        raise EffectInputMismatch(
            "reported_effect_measure_mismatch",
            f"The reported effect measure {reported!r} does not match requested {requested!r}.",
        )
    if scale != "original":
        raise EffectInputMismatch(
            "reported_effect_scale_requires_adjudication",
            f"The generic reported effect scale {scale!r} is not supported by this original-scale conversion.",
        )


def compute_effect_size(
    outcome_type: str,
    effect_measure: str,
    # Continuous
    mean_i: float = None, sd_i: float = None, n_i: int = None,
    mean_c: float = None, sd_c: float = None, n_c: int = None,
    median_i: float = None, q1_i: float = None, q3_i: float = None,
    min_i: float = None, max_i: float = None,
    median_c: float = None, q1_c: float = None, q3_c: float = None,
    min_c: float = None, max_c: float = None,
    # Dichotomous
    events_i: int = None, total_i: int = None,
    events_c: int = None, total_c: int = None,
    # Pre-computed
    effect: float = None, ci_lower: float = None, ci_upper: float = None,
    p_value: float = None,
    # Time-to-event
    hr: float = None, hr_ci_lower: float = None, hr_ci_upper: float = None, hr_se: float = None,
    # Proportion (single-arm)
    events_single: int = None, total_n: int = None,
    # Correlation
    correlation_r: float = None, correlation_n: int = None,
    # Incidence rate
    pyears_i: float = None, pyears_c: float = None,
    reported_effect_measure: str = "",
    reported_effect_scale: str = "original",
) -> tuple[float, float]:
    """Unified interface to compute (yi, vi) for a study.

    yi: point estimate (log scale for OR/RR/HR/IRR; transformed for PROP/COR)
    vi: variance

    Tries raw data first; falls back to pre-computed effect + CI/p-value.
    """
    log_measures = {"OR", "RR", "HR", "IRR"}
    outcome_type = str(outcome_type or "").strip().lower().replace("-", "_")
    effect_measure = str(effect_measure or "").strip().upper()
    reported_effect_measure = str(reported_effect_measure or "").strip().upper()
    if outcome_type not in PAIRWISE_EFFECT_MEASURES_BY_OUTCOME_TYPE:
        raise EffectInputMismatch(
            "outcome_type_requires_adjudication",
            f"Outcome type {outcome_type!r} is not a supported typed input.",
        )
    if effect_measure not in PAIRWISE_EFFECT_MEASURES_BY_OUTCOME_TYPE[outcome_type]:
        raise EffectInputMismatch(
            "outcome_type_measure_mismatch",
            f"Outcome type {outcome_type!r} is incompatible with requested measure {effect_measure!r}.",
        )

    # Time-to-event: Hazard Ratio
    if effect_measure == "HR":
        if hr is not None:
            return hazard_ratio(hr, hr_ci_lower, hr_ci_upper, hr_se, p_value)
        if effect is not None and effect > 0:
            _require_reported_measure(reported_effect_measure, effect_measure, reported_effect_scale)
            return hazard_ratio(effect, ci_lower, ci_upper, None, p_value)

    # Proportion (single-arm, Freeman-Tukey)
    if outcome_type == "proportion" or effect_measure == "PROP":
        if events_single is not None and total_n is not None:
            return proportion_freeman_tukey(events_single, total_n)
        if events_i is not None and total_i is not None and events_c is None:
            return proportion_freeman_tukey(events_i, total_i)

    # Correlation (Fisher z)
    if outcome_type == "correlation" or effect_measure == "COR":
        if correlation_r is not None and correlation_n is not None:
            return correlation_fisher_z(correlation_r, correlation_n)

    # Incidence rate ratio
    if effect_measure == "IRR":
        if all(v is not None for v in [events_i, pyears_i, events_c, pyears_c]):
            return incidence_rate_ratio(events_i, pyears_i, events_c, pyears_c)

    # Try computation from raw data
    if outcome_type in {"dichotomous", "binary"} and all(v is not None for v in [events_i, total_i, events_c, total_c]):
        a, b = events_i, total_i - events_i
        c, d = events_c, total_c - events_c
        try:
            if effect_measure == "OR":
                return odds_ratio(a, b, c, d)
            elif effect_measure == "RR":
                return risk_ratio(a, b, c, d)
            elif effect_measure == "RD":
                return risk_difference(a, b, c, d)
        except (ValueError, ZeroDivisionError):
            pass  # Fall through to pre-computed fallback

    if outcome_type == "continuous" or effect_measure in ("MD", "SMD"):
        if (mean_i is None or sd_i is None) and n_i is not None and median_i is not None:
            try:
                if q1_i is not None and q3_i is not None:
                    mean_i, sd_i = median_iqr_to_mean_sd(median_i, q1_i, q3_i, n_i)
                elif min_i is not None and max_i is not None:
                    mean_i, sd_i = median_range_to_mean_sd(median_i, min_i, max_i, n_i)
            except (ValueError, ZeroDivisionError):
                pass
        if (mean_c is None or sd_c is None) and n_c is not None and median_c is not None:
            try:
                if q1_c is not None and q3_c is not None:
                    mean_c, sd_c = median_iqr_to_mean_sd(median_c, q1_c, q3_c, n_c)
                elif min_c is not None and max_c is not None:
                    mean_c, sd_c = median_range_to_mean_sd(median_c, min_c, max_c, n_c)
            except (ValueError, ZeroDivisionError):
                pass

    if outcome_type == "continuous" and all(v is not None for v in [mean_i, sd_i, n_i, mean_c, sd_c, n_c]):
        try:
            if effect_measure == "MD":
                return mean_difference(mean_i, sd_i, n_i, mean_c, sd_c, n_c)
            elif effect_measure == "SMD":
                return standardized_mean_difference(mean_i, sd_i, n_i, mean_c, sd_c, n_c)
        except (ValueError, ZeroDivisionError):
            pass  # Fall through to pre-computed fallback

    # Fallback: use pre-computed effect size + CI or p-value
    if effect is not None:
        _require_reported_measure(reported_effect_measure, effect_measure, reported_effect_scale)
        is_log = effect_measure in log_measures
        if is_log and effect <= 0:
            raise ValueError(f"Effect size must be positive for {effect_measure}, got {effect}")
        yi = math.log(effect) if is_log else effect

        if ci_lower is not None and ci_upper is not None:
            se = ci_to_se(ci_lower, ci_upper, log_scale=is_log)
            return yi, se**2
        elif p_value is not None:
            se = p_to_se(effect, p_value, log_scale=is_log)
            return yi, se**2

    raise ValueError(f"Insufficient data to compute effect size for {effect_measure}")
