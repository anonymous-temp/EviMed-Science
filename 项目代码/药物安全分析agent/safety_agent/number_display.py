"""Display strings for the numbers a report states: the EviMed display convention.

A result keeps its raw value for machines and carries the string a report
writes. The report-writing model copies these strings and never rounds a raw
float itself; given raw floats it copied all fifteen digits into prose
(OR 1.53311316166586). The same file ships in every specialist engine whose
numbers reach a report, so one convention holds across them:

- Ratio measures (OR, RR, HR, ROR, PRR, EBGM, their interval bounds): two
  decimal places (AMA Manual of Style, 11th ed., 19.4.1; Assel et al., Eur Urol
  2019;75:358-367, guideline 4.1), two significant figures below 0.1 so a small
  ratio never reads 0.00.
- P values: two decimals from 0.01, three below 0.01, "<0.001" below 0.001,
  ">0.99" above 0.99 (AMA 19.4.2; NEJM statistical reporting guidelines,
  2019). A value that would round onto 0.05 keeps the decimals that show it is
  below (0.046, not 0.05; AMA 19.4.2). Genetic studies write p below 0.001 in
  scientific notation with two significant figures, 3.5×10⁻¹¹ (AMA 19.4.2 names
  genome-wide association and other genetics studies as the exception).
- Other estimates (beta, SE, intercepts, Q, F, chi-square, IC, r²): three
  significant figures, integer digits never rounded away (Assel 2019, 4.1);
  scientific notation below 10⁻⁴.
- Percentages: two significant figures, integer digits kept (Assel 2019, 4.1).
- Counts: integers with thousands separators.
- An interval shares its estimate's decimals, and gains one (up to four) when
  rounding would move a bound onto the null value it does not include (AMA
  19.4.2: an interval significant before rounding stays so after).
- Rounding is half-to-even on the decimal form of the value (AMA 19.4.2). The
  leading zero is kept (0.13), as Vancouver-style journals print it.

Every function returns None for a missing or non-finite value, so a display
field is absent exactly when there is nothing to state.
"""

from __future__ import annotations

import math
from decimal import ROUND_HALF_EVEN, Decimal
from typing import Any

CONVENTION = "evimed-display-v1"

_SUPERSCRIPT = str.maketrans("-0123456789", "⁻⁰¹²³⁴⁵⁶⁷⁸⁹")
_MAX_EXTRA_DECIMALS = 4


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _fixed(value: float, decimals: int) -> str:
    quantum = Decimal(1).scaleb(-decimals)
    text = format(Decimal(repr(value)).quantize(quantum, rounding=ROUND_HALF_EVEN), "f")
    # "-0.00" says a sign the rounded value does not have.
    return text[1:] if text.startswith("-") and not text.strip("-0.") else text


def _significant_decimals(value: float, digits: int) -> int:
    """Decimals that show `digits` significant figures, never fewer than zero."""
    if value == 0:
        return 0
    return max(0, digits - 1 - math.floor(math.log10(abs(value))))


def ratio_decimals(*values: float) -> int:
    """Two decimals, or two significant figures for the smallest value below 0.1."""
    small = [abs(value) for value in values if value is not None and 0 < abs(value) < 0.1]
    return max([2, *(_significant_decimals(value, 2) for value in small)])


def ratio(value: Any) -> str | None:
    number = _number(value)
    return None if number is None else _fixed(number, ratio_decimals(number))


def estimate_decimals(value: float) -> int:
    return _significant_decimals(value, 3)


def estimate(value: Any) -> str | None:
    number = _number(value)
    if number is None:
        return None
    if 0 < abs(number) < 1e-4:
        return scientific(number, 3)
    return _fixed(number, estimate_decimals(number))


def count(value: Any) -> str | None:
    number = _number(value)
    if number is None or number != int(number):
        return None
    return f"{int(number):,}"


def percent(value: Any) -> str | None:
    """A value already in percent units (12.5 for 12.5%), with its % sign."""
    number = _number(value)
    return None if number is None else f"{_fixed(number, _significant_decimals(number, 2))}%"


def scientific(value: float, digits: int = 2) -> str:
    mantissa, exponent = format(Decimal(repr(value)), f".{digits - 1}e").split("e")
    return f"{mantissa}×10{str(int(exponent)).translate(_SUPERSCRIPT)}"


def p_value(value: Any, *, genetic: bool = False) -> str | None:
    number = _number(value)
    if number is None or not 0 <= number <= 1:
        return None
    if number < 0.001:
        if not genetic:
            return "<0.001"
        # R reports an underflowed probability as 0; TwoSampleMR floors at 1e-300.
        return "<1×10⁻³⁰⁰" if number < 1e-300 else scientific(number)
    if number > 0.99:
        return ">0.99"
    decimals = 3 if number < 0.01 else 2
    text = _fixed(number, decimals)
    while number < 0.05 <= float(text) and decimals < 2 + _MAX_EXTRA_DECIMALS:
        decimals += 1
        text = _fixed(number, decimals)
    return text


def bounded_p_value(text: Any, *, genetic: bool = False) -> str | None:
    """A p value as software reports it: a number, or a strict bound such as "<0.001".

    A permutation test reports "<1/draws" when no draw exceeded the observed
    statistic. The bound is kept as stated, except that one at or below 0.001
    is written "<0.001": a strict upper bound stays true when raised.
    """
    if isinstance(text, str) and text.strip().startswith("<"):
        stated = text.strip()[1:].strip()
        bound = _number(stated)
        if bound is None or not 0 < bound <= 1:
            return None
        return "<0.001" if bound <= 0.001 else f"<{stated}"
    return p_value(text, genetic=genetic)


def interval(estimate_value: Any, lower: Any, upper: Any, *, kind: str) -> dict[str, str | None]:
    """An estimate and its interval at one precision.

    `kind` is "ratio" (null 1) or "estimate" (null 0). The bounds take the
    estimate's decimals; a bound that excludes the null but would round onto it
    gains decimals until it no longer does.
    """
    point, low, high = _number(estimate_value), _number(lower), _number(upper)
    if kind == "ratio":
        null = 1.0
        decimals = ratio_decimals(*(value for value in (point, low, high) if value is not None))
    elif kind == "estimate":
        null = 0.0
        decimals = estimate_decimals(point) if point is not None else 3
    else:
        raise ValueError(f"unknown interval kind: {kind}")

    def crosses(places: int) -> bool:
        return bool(
            (low is not None and low > null and float(_fixed(low, places)) <= null)
            or (high is not None and high < null and float(_fixed(high, places)) >= null)
        )

    extra = 0
    while crosses(decimals) and extra < _MAX_EXTRA_DECIMALS:
        decimals += 1
        extra += 1
    shown = {
        "estimate": None if point is None else _fixed(point, decimals),
        "lower": None if low is None else _fixed(low, decimals),
        "upper": None if high is None else _fixed(high, decimals),
    }
    if shown["lower"] is None or shown["upper"] is None:
        shown["interval"] = None
    elif low is not None and low < 0:
        shown["interval"] = f"{shown['lower']} to {shown['upper']}"
    else:
        shown["interval"] = f"{shown['lower']}–{shown['upper']}"
    return shown
