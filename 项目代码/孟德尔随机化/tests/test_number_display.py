"""The EviMed display convention, one golden table shared by every engine that ships it.

The helper file is the same in each specialist engine; so is this table. The
first rows are production run mr-001's headline numbers, which its report
printed at fifteen significant digits.
"""

import pytest

from mr_agent import number_display as shown

GOLDEN = [
    # ratios: two decimals (AMA 19.4.1)
    (shown.ratio, (1.53311316166586,), {}, "1.53"),
    (shown.ratio, (10.444444444444445,), {}, "10.44"),
    (shown.ratio, (0.0043,), {}, "0.0043"),
    # p values (AMA 19.4.2), genetic studies in scientific notation below 0.001
    (shown.p_value, (3.54262863158619e-11,), {"genetic": True}, "3.5×10⁻¹¹"),
    (shown.p_value, (3.54262863158619e-11,), {}, "<0.001"),
    (shown.p_value, (0.000287453890108776,), {"genetic": True}, "2.9×10⁻⁴"),
    (shown.p_value, (0.00107165723490656,), {"genetic": True}, "0.001"),
    (shown.p_value, (0.487614712674696,), {}, "0.49"),
    (shown.p_value, (0.046,), {}, "0.046"),
    (shown.p_value, (0.0496,), {}, "0.0496"),
    (shown.p_value, (0.995,), {}, ">0.99"),
    (shown.p_value, (0.0,), {"genetic": True}, "<1×10⁻³⁰⁰"),
    (shown.p_value, (1.5,), {}, None),
    (shown.bounded_p_value, ("<0.00078125",), {}, "<0.001"),
    (shown.bounded_p_value, ("<0.064",), {}, "<0.064"),
    (shown.bounded_p_value, (0.2,), {}, "0.20"),
    # other estimates: three significant figures, integer digits kept
    (shown.estimate, (0.427300414298957,), {}, "0.427"),
    (shown.estimate, (0.0645269559752301,), {}, "0.0645"),
    (shown.estimate, (-0.00309020421407606,), {}, "-0.00309"),
    (shown.estimate, (122.738513258264,), {}, "123"),
    (shown.estimate, (70.6173,), {}, "70.6"),
    (shown.estimate, (1e-7,), {}, "1.00×10⁻⁷"),
    (shown.estimate, (-0.0001,), {}, "-0.000100"),
    (shown.estimate, (float("nan"),), {}, None),
    (shown.estimate, (None,), {}, None),
    # counts and percentages
    (shown.count, (2555085,), {}, "2,555,085"),
    (shown.count, (333087.0,), {}, "333,087"),
    (shown.count, (1.5,), {}, None),
    (shown.percent, (25.210084033613445,), {}, "25%"),
    (shown.percent, (3.43,), {}, "3.4%"),
    (shown.percent, (0.134,), {}, "0.13%"),
]


@pytest.mark.parametrize("function, args, kwargs, expected", GOLDEN)
def test_the_convention(function, args, kwargs, expected):
    assert function(*args, **kwargs) == expected


def test_an_interval_shares_its_estimates_decimals():
    assert shown.interval(1.53311316166586, 1.35097638690072, 1.73980536541073, kind="ratio") == {
        "estimate": "1.53", "lower": "1.35", "upper": "1.74", "interval": "1.35–1.74",
    }
    assert shown.interval(0.427300414298957, 0.3008, 0.5538, kind="estimate")["interval"] == "0.301–0.554"
    assert shown.interval(-0.12, -0.25, 0.01, kind="estimate")["interval"] == "-0.250 to 0.010"


def test_a_bound_that_excludes_the_null_never_rounds_onto_it():
    # AMA 19.4.2: an interval significant before rounding stays so after.
    ratio = shown.interval(1.004, 1.0004, 1.008, kind="ratio")
    assert ratio["lower"] == "1.0004" and ratio["estimate"] == "1.0040"
    ic = shown.interval(3.1234, 0.0021, None, kind="estimate")
    assert ic["estimate"] == "3.123" and ic["lower"] == "0.002" and ic["interval"] is None


def test_rounding_is_half_to_even_on_the_decimal_form():
    assert shown.estimate(0.12345) == "0.123"
    assert shown.ratio(2.675) == "2.68"  # the binary float 2.675 is below 2.675; its decimal form is not
    assert shown.ratio(2.665) == "2.66"
