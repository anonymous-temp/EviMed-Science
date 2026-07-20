"""Known-answer tests for the disproportionality formulas.

Every expected literal below was hand-computed from the formula definitions
(ROR/PRR/chi2/IC as documented in safety_agent.signals.disproportionality)
with high-precision arithmetic — they do not come from the implementation
under test.

The OpenScience cross-check re-encodes the reference formulas verbatim from
OpenScience/runtime/mcp/evimed-research/public_sources.py ``adr_signal``
(lines ~897-915):

    b = drug_total - a;  c = event_total - a;  d = total - a - b - c
    ror = (a * d) / (b * c)
    se  = sqrt(1/a + 1/b + 1/c + 1/d)
    ror95CI = exp(ln(ror) +/- 1.96 * se)
    prr = (a / (a + b)) / (c / (c + d))
    ic  = log2((a * N) / ((a + b) * (a + c)))

and asserts our implementation agrees with it to 1e-12 relative error.
"""

from __future__ import annotations

import math

import pytest

from safety_agent.signals import (
    ContingencyTable2x2,
    SignalCriteria,
    analyze,
    analyze_dataframe,
    build_table_from_counts,
    chi_square,
    evaluate,
)

# -- hand-computed reference panels -------------------------------------------
# T1: strong signal (statin-myalgia-like shape)
T1 = dict(a=10, b=90, c=20, d=1880)
T1_EXPECTED = dict(
    ror=10.4444444444, ror_lo=4.74957467843, ror_hi=22.9676186056,
    prr=9.5, prr_lo=4.56905661757, prr_hi=19.752436346,
    chi2=51.4738623208, yates_chi2=45.5962240627,
    ic=2.73696559417, ic_exp=2.75567306986, ic025=1.73456674814,
)
# T2: boundary a=0 -> Haldane-Anscombe 0.5 correction on all cells
T2 = dict(a=0, b=50, c=10, d=940)
T2C_EXPECTED = dict(  # computed on a=0.5, b=50.5, c=10.5, d=940.5
    ror=0.88684582744, ror_lo=0.0512385406509, ror_hi=15.3496862256,
    prr=0.887955182073, prr_lo=0.0527653788104, prr_hi=14.9428360631,
    chi2=0.00682265152308, yates_chi2=0.0,
    ic=-0.163190167414, ic_exp=1.13101691782, ic025=-1.33202479564,
)
# T3: boundary b=0 -> correction
T3 = dict(a=5, b=0, c=100, d=895)
T3C_EXPECTED = dict(  # computed on a=5.5, b=0.5, c=100.5, d=895.5
    ror=98.0149253731, ror_lo=5.37992631202, ror_hi=1785.69836067,
    prr=9.08457711443, prr_lo=6.70141398487, prr_hi=12.3152429524,
    chi2=41.9558474696, yates_chi2=33.7754244319,
    ic=3.11521545655, ic_exp=2.91996680578, ic025=1.41082091956,
)
# T4: exact null table — ROR=PRR=1, chi2=IC=0 by construction
T4 = dict(a=3, b=97, c=3, d=97)
# T5: weak table, no signal anywhere
T5 = dict(a=2, b=48, c=5, d=145)
T5_EXPECTED = dict(
    ror=1.20833333333, ror_lo=0.227006443197, ror_hi=6.43184142214,
    prr=1.2, prr_lo=0.240269635854, prr_hi=5.99326666844,
    chi2=0.0493461633358, yates_chi2=0.0,
    ic=0.192645077942, ic_exp=0.387023123109, ic025=-1.50304344975,
)
# T6: extreme disproportionality but only 2 cases -> rule must reject
T6 = dict(a=2, b=4, c=1, d=193)
T6_EXPECTED = dict(
    ror=96.5, ror_lo=7.19129426642, prr=64.6666666667,
    chi2=42.4244538641, ic=4.47393118833,
)

REL = 1e-6


def _panel(cells):
    return analyze(ContingencyTable2x2(**cells))


@pytest.mark.parametrize(
    "cells,expected",
    [(T1, T1_EXPECTED), (T2, T2C_EXPECTED), (T3, T3C_EXPECTED), (T5, T5_EXPECTED)],
    ids=["T1-strong", "T2-a0-corrected", "T3-b0-corrected", "T5-weak"],
)
def test_known_answer_panels(cells, expected):
    metrics = _panel(cells)
    assert metrics.ror.value == pytest.approx(expected["ror"], rel=REL)
    assert metrics.ror.ci95_lower == pytest.approx(expected["ror_lo"], rel=REL)
    assert metrics.ror.ci95_upper == pytest.approx(expected["ror_hi"], rel=REL)
    assert metrics.prr.value == pytest.approx(expected["prr"], rel=REL)
    assert metrics.prr.ci95_lower == pytest.approx(expected["prr_lo"], rel=REL)
    assert metrics.prr.ci95_upper == pytest.approx(expected["prr_hi"], rel=REL)
    assert metrics.chi2.value == pytest.approx(expected["chi2"], rel=REL)
    yates = chi_square(metrics.table, yates=True)
    assert yates.value == pytest.approx(expected["yates_chi2"], rel=REL, abs=1e-9)
    assert yates.yates_corrected is True
    assert metrics.ic.value == pytest.approx(expected["ic"], rel=REL)
    assert metrics.ic.expectation == pytest.approx(expected["ic_exp"], rel=REL)
    assert metrics.ic.ic025 == pytest.approx(expected["ic025"], rel=REL)


def test_null_table_is_exact():
    """T4: ad = bc by construction, so ROR=PRR=1 and chi2=IC=0 exactly."""
    metrics = _panel(T4)
    assert metrics.ror.value == 1.0
    assert metrics.prr.value == 1.0
    assert metrics.chi2.value == 0.0
    assert metrics.ic.value == 0.0
    # The shrunk BCPNN expectation is also exactly 0 for this table:
    # (a+1)(N+4) = (a+b+2)(a+c+2) = 816.
    assert metrics.ic.expectation == 0.0
    assert metrics.ic.ic025 < 0.0  # wide interval, no signal


def test_haldane_anscombe_flags_and_cells():
    for cells in (T2, T3):
        metrics = _panel(cells)
        assert metrics.haldane_anscombe_applied is True
        assert metrics.table.a == cells["a"] + 0.5
        assert metrics.table.b == cells["b"] + 0.5
        assert metrics.table.c == cells["c"] + 0.5
        assert metrics.table.d == cells["d"] + 0.5
    assert _panel(T1).haldane_anscombe_applied is False


def test_zero_cell_without_correction_raises():
    with pytest.raises(ValueError, match="not estimable"):
        analyze(ContingencyTable2x2(**T2), correct_zero_cells=False)


# -- OpenScience reference cross-check ----------------------------------------


def _openscience_reference(a, b, c, d):
    """Verbatim re-encoding of public_sources.py adr_signal (lines ~897-915)."""
    ror_value = (a * d) / (b * c)
    se = math.sqrt(sum(1 / value for value in (a, b, c, d)))
    prr_value = (a / (a + b)) / (c / (c + d))
    ic_value = math.log2((a * (a + b + c + d)) / ((a + b) * (a + c)))
    return (
        ror_value,
        (math.exp(math.log(ror_value) - 1.96 * se), math.exp(math.log(ror_value) + 1.96 * se)),
        prr_value,
        ic_value,
    )


@pytest.mark.parametrize(
    "a,b,c,d",
    [
        (10, 90, 20, 1880),
        (3, 97, 3, 97),
        (2, 48, 5, 145),
        (0.5, 50.5, 10.5, 940.5),  # T2 after correction
        (5.5, 0.5, 100.5, 895.5),  # T3 after correction
    ],
)
def test_matches_openscience_formulas(a, b, c, d):
    metrics = analyze(ContingencyTable2x2(a=a, b=b, c=c, d=d))
    ref_ror, (ref_lo, ref_hi), ref_prr, ref_ic = _openscience_reference(a, b, c, d)
    assert metrics.ror.value == pytest.approx(ref_ror, rel=1e-12)
    assert metrics.ror.ci95_lower == pytest.approx(ref_lo, rel=1e-12)
    assert metrics.ror.ci95_upper == pytest.approx(ref_hi, rel=1e-12)
    assert metrics.prr.value == pytest.approx(ref_prr, rel=1e-12)
    assert metrics.ic.value == pytest.approx(ref_ic, rel=1e-12)


# -- 2x2 construction from count queries --------------------------------------


def test_build_table_from_counts():
    table = build_table_from_counts(joint=10, drug_total=100, event_total=30, grand_total=2000)
    assert (table.a, table.b, table.c, table.d) == (10, 90, 20, 1880)
    assert table.n == 2000


@pytest.mark.parametrize(
    "joint,drug,event,total",
    [
        (11, 10, 30, 2000),  # joint > drug_total
        (31, 100, 30, 2000),  # joint > event_total
        (10, 100, 30, 100),  # grand_total < a+b+c
    ],
)
def test_build_table_rejects_inconsistent_counts(joint, drug, event, total):
    with pytest.raises(ValueError, match="inconsistent"):
        build_table_from_counts(joint, drug, event, total)


def test_contingency_table_rejects_non_finite_cells():
    with pytest.raises(ValueError, match="finite"):
        ContingencyTable2x2(a=float("nan"), b=1, c=1, d=1)


# -- signal decision rules ------------------------------------------------------


def test_rule_strong_table_is_signal():
    decision = evaluate(_panel(T1))
    assert decision.is_signal is True
    assert decision.checks["a>=min_cases"] is True
    assert decision.checks["ror_ci95_lower>threshold"] is True


def test_rule_null_table_is_not_signal():
    decision = evaluate(_panel(T4))
    assert decision.is_signal is False


def test_rule_rejects_extreme_ratio_with_too_few_cases():
    """T6: ROR lower CI > 1, PRR >= 2 and chi2 >= 4 — but a = 2 < 3."""
    metrics = _panel(T6)
    assert metrics.ror.value == pytest.approx(T6_EXPECTED["ror"], rel=REL)
    assert metrics.ror.ci95_lower == pytest.approx(T6_EXPECTED["ror_lo"], rel=REL)
    assert metrics.prr.value == pytest.approx(T6_EXPECTED["prr"], rel=REL)
    assert metrics.chi2.value == pytest.approx(T6_EXPECTED["chi2"], rel=REL)
    assert metrics.ic.value == pytest.approx(T6_EXPECTED["ic"], rel=REL)
    decision = evaluate(metrics)
    assert decision.checks["a>=min_cases"] is False
    assert decision.is_signal is False
    relaxed = evaluate(metrics, SignalCriteria(min_cases=2))
    assert relaxed.is_signal is True


def test_rule_thresholds_are_configurable():
    metrics = _panel(T1)
    strict = evaluate(metrics, SignalCriteria(ror_ci_lower_gt=100.0, prr_gte=1000.0))
    assert strict.is_signal is False


def test_corrected_zero_case_does_not_count_as_observed():
    """a=0 corrected to 0.5 must not satisfy min_cases=1."""
    metrics = _panel(T2)
    assert evaluate(metrics, SignalCriteria(min_cases=1)).checks["a>=min_cases"] is False


# -- batch pandas API -----------------------------------------------------------


def test_analyze_dataframe_carries_columns_and_metrics():
    import pandas as pd

    frame = pd.DataFrame(
        [
            {"drug": "atorvastatin", "reaction": "myalgia", **T1},
            {"drug": "atorvastatin", "reaction": "nausea", **T5},
        ]
    )
    result = analyze_dataframe(frame)
    assert list(result["drug"]) == ["atorvastatin", "atorvastatin"]
    assert result.loc[0, "ror"] == pytest.approx(T1_EXPECTED["ror"], rel=REL)
    assert result.loc[0, "N"] == 2000
    assert result.loc[1, "ror"] == pytest.approx(T5_EXPECTED["ror"], rel=REL)
    assert {"ror_ci95_lower", "prr", "chi2", "ic", "ic025", "ebgm", "eb05"} <= set(
        result.columns
    )


def test_analyze_dataframe_requires_cells():
    import pandas as pd

    with pytest.raises(ValueError, match="misses columns"):
        analyze_dataframe(pd.DataFrame([{"a": 1, "b": 2}]))
