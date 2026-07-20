"""Configurable signal-decision rules on top of the metrics panel.

Default rule (documented in the rewrite plan):
    signal  <=>  a >= min_cases
                 AND ( ROR 95% CI lower bound > ror_ci_lower_gt
                       OR ( PRR >= prr_gte AND chi2 >= chi2_gte ) )

Defaults: min_cases=3, ror_ci_lower_gt=1.0, prr_gte=2.0, chi2_gte=4.0
(the PRR part matches the classic Evans et al. 2001 criteria).
All thresholds are injectable; rules never mutate the metrics.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .disproportionality import SignalMetrics


@dataclass(frozen=True)
class SignalCriteria:
    min_cases: int = 3
    ror_ci_lower_gt: float = 1.0
    prr_gte: float = 2.0
    chi2_gte: float = 4.0

    def __post_init__(self) -> None:
        if self.min_cases < 1:
            raise ValueError("min_cases must be >= 1")


@dataclass(frozen=True)
class SignalDecision:
    is_signal: bool
    checks: dict[str, bool] = field(default_factory=dict)
    criteria: SignalCriteria = field(default_factory=SignalCriteria)


DEFAULT_CRITERIA = SignalCriteria()


def evaluate(metrics: SignalMetrics, criteria: SignalCriteria = DEFAULT_CRITERIA) -> SignalDecision:
    """Apply the configurable decision rule to one metrics panel."""
    a = metrics.table.a
    # Haldane-Anscombe bumps a zero cell to 0.5; case counts are compared
    # against the *uncorrected* notion of >= min_cases reports, so use the
    # floor value for the check (a corrected 0.5 must not count as a case).
    observed_cases = int(a) if a == int(a) else int(a - 0.5)
    checks = {
        "a>=min_cases": observed_cases >= criteria.min_cases,
        "ror_ci95_lower>threshold": metrics.ror.ci95_lower > criteria.ror_ci_lower_gt,
        "prr>=threshold": metrics.prr.value >= criteria.prr_gte,
        "chi2>=threshold": metrics.chi2.value >= criteria.chi2_gte,
    }
    is_signal = checks["a>=min_cases"] and (
        checks["ror_ci95_lower>threshold"]
        or (checks["prr>=threshold"] and checks["chi2>=threshold"])
    )
    return SignalDecision(is_signal=is_signal, checks=checks, criteria=criteria)
