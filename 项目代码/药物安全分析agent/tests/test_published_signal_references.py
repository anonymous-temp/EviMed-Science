"""Disproportionality statistics against a published 2x2 table and the limits of the IC approximation.

The Physicians' Health Study table is data a textbook prints with its results, so the expected
numbers do not come from this code:

    Steering Committee of the Physicians' Health Study Research Group (1989), New England Journal
    of Medicine 321:129-135: myocardial infarction in 189 of 11,034 men on placebo and 104 of 11,037
    on aspirin. Agresti, Categorical Data Analysis (3rd ed.), prints the sample odds ratio 1.832
    with 95% interval (1.440, 2.331) and the Pearson chi-square 25.01. Read as a signal table
    (the placebo arm standing in for "the drug"), the same four cells give the ROR and PRR.

The Yates value is the output of R 4.3.3 ``chisq.test(matrix(c(189, 104, 10845, 10933), 2))``
(``X-squared = 24.429``), another implementation's documented result; so is the Pearson 25.014.
"""
from __future__ import annotations

import math

import numpy as np
import pytest
from scipy.special import digamma

from safety_agent.signals import ContingencyTable2x2, analyze, chi_square
from safety_agent.signals.disproportionality import information_component

PHS = ContingencyTable2x2(a=189, b=10845, c=104, d=10933)


def test_published_odds_ratio_interval_and_pearson_chi_square():
    metrics = analyze(PHS)
    assert metrics.ror.value == pytest.approx(1.832, abs=5e-4)
    assert (metrics.ror.ci95_lower, metrics.ror.ci95_upper) == pytest.approx((1.440, 2.331), abs=5e-4)
    assert metrics.chi2.value == pytest.approx(25.01, abs=5e-3)
    assert metrics.haldane_anscombe_applied is False


def test_proportional_reporting_ratio_is_the_relative_risk_of_the_same_table():
    # 189/11034 over 104/11037: 1.8178 (Agresti prints the relative risk 1.82).
    metrics = analyze(PHS)
    assert metrics.prr.value == pytest.approx(1.82, abs=5e-3)
    # Katz's log-scale interval, computed by hand from the cells: exp(ln 1.8178 +/- 1.96 * 0.12135).
    se = math.sqrt(1 / 189 - 1 / 11034 + 1 / 104 - 1 / 11037)
    assert se == pytest.approx(0.12135, abs=5e-5)
    assert metrics.prr.ci95_lower == pytest.approx(math.exp(math.log(1.8178018) - 1.96 * se), rel=1e-6)
    assert metrics.prr.ci95_upper == pytest.approx(math.exp(math.log(1.8178018) + 1.96 * se), rel=1e-6)


def test_yates_corrected_chi_square_matches_r():
    assert chi_square(PHS).value == pytest.approx(25.014, abs=5e-4)
    assert chi_square(PHS, yates=True).value == pytest.approx(24.429, abs=5e-4)


def test_a_table_with_a_zero_cell_is_corrected_everywhere_and_says_so():
    # Haldane-Anscombe: 0.5 on all four cells. The odds ratio of the corrected table is the published
    # (0.5 * 940.5) / (50.5 * 10.5) = 0.88685; the flag tells a reader the cells are not the counts.
    metrics = analyze(ContingencyTable2x2(a=0, b=50, c=10, d=940))
    assert metrics.haldane_anscombe_applied is True
    assert metrics.ror.value == pytest.approx((0.5 * 940.5) / (50.5 * 10.5), rel=1e-12)


@pytest.mark.parametrize("cells", [(10, 90, 20, 1880), (189, 10845, 104, 10933), (50, 1000, 200, 50000)])
def test_ic_expectation_departs_from_the_exact_posterior_mean_by_a_known_small_amount(cells):
    """Under a uniform Dirichlet(1,1,1,1) prior the exact posterior mean of log2(p11/(p1. p.1)) is
    (psi(a+1) - psi(a+b+2) - psi(a+c+2) + psi(N+4)) / ln 2. The engine reports the log of the ratio of
    posterior means, which is higher by a Jensen term that shrinks with the counts."""
    a, b, c, d = cells
    n = a + b + c + d
    exact = (digamma(a + 1) - digamma(a + b + 2) - digamma(a + c + 2) + digamma(n + 4)) / math.log(2)
    reported = information_component(ContingencyTable2x2(*map(float, cells))).expectation
    assert 0 < reported - exact < 0.05
    assert reported - exact == pytest.approx(0.5 * (1 / (a + 1) - 1 / (a + b + 2) - 1 / (a + c + 2) + 1 / (n + 4)) / math.log(2), abs=0.01)


def test_ic025_is_a_normal_approximation_that_reads_below_the_exact_limit():
    """The 2.5th percentile of the exact posterior of IC, by seeded Monte Carlo (two million Dirichlet
    draws; the standard error of the quantile is about 0.001), is higher than the engine's IC025 for
    a=10 of N=2000: the skewed posterior is not normal. The gap is a property of the approximation,
    stated in the method record; this pins it so a change to the formula is a deliberate one."""
    cells = (10, 90, 20, 1880)
    draws = np.random.default_rng(20261004).dirichlet([cell + 1 for cell in cells], size=2_000_000)
    ic = np.log2(draws[:, 0] / ((draws[:, 0] + draws[:, 1]) * (draws[:, 0] + draws[:, 2])))
    exact_limit = float(np.quantile(ic, 0.025))
    reported = information_component(ContingencyTable2x2(*map(float, cells))).ic025
    assert exact_limit == pytest.approx(1.9526, abs=0.01)
    assert 0.15 < exact_limit - reported < 0.30
