"""Deterministic recovery of missing arm denominators from reported percentages.

A common reason a fully-readable trial still fails 2x2 pooling is that the arm
event counts and the arm percentages are reported together in prose (e.g.
"head injury-related death was 18.5% in the tranexamic acid group versus 19.8%
in the placebo group (855 vs 892 events)") while the per-arm denominator lives in
a table or refers to a subgroup, so the extractor captures the events but not the
totals. Without a denominator the row cannot be pooled and the whole analysis is
blocked.

When events and a reported percentage are both present, the denominator is fully
determined: ``total = round(events / (percent / 100))``. This is not a guess —
the percentage is quoted in the source, the recomputed percentage must reproduce
the quoted one, and when the row also carries a reported effect estimate (RR/OR)
the recovered 2x2 is cross-checked against it. Recovery is rejected unless every
guard passes, so it never invents an inconsistent denominator.
"""
from __future__ import annotations

import re

_PERCENT = re.compile(r"(\d{1,3}(?:[.·]\d+)?)\s*%")


def _percentages(text: str) -> list[float]:
    values: list[float] = []
    for match in _PERCENT.finditer(str(text or "")):
        try:
            value = float(match.group(1).replace("·", "."))
        except ValueError:
            continue
        if 0.0 < value <= 100.0:
            values.append(value)
    return values


def _get(outcome, key):
    if isinstance(outcome, dict):
        return outcome.get(key)
    return getattr(outcome, key, None)


def _set(outcome, key, value):
    if isinstance(outcome, dict):
        outcome[key] = value
    else:
        setattr(outcome, key, value)


def _derive_total(events: int, percent: float) -> int | None:
    if events is None or percent <= 0 or percent > 100:
        return None
    total = round(events / (percent / 100.0))
    if total <= events or total > 2_000_000:
        return None
    # The recomputed percentage must reproduce the quoted one.
    if abs(events / total * 100.0 - percent) > 0.3:
        return None
    return int(total)


def _effect_cross_check_ok(events_i, total_i, events_c, total_c, reported_effect) -> bool:
    """When a reported RR/OR exists, the recovered 2x2 must reproduce it (±10%)."""
    try:
        reported = float(reported_effect)
    except (TypeError, ValueError):
        return True  # nothing to cross-check against
    if reported <= 0:
        return True
    risk_i = events_i / total_i if total_i else None
    risk_c = events_c / total_c if total_c else None
    candidates: list[float] = []
    if risk_i and risk_c:
        candidates.append(risk_i / risk_c)  # risk ratio
    if (total_i - events_i) > 0 and (total_c - events_c) > 0 and events_c > 0:
        odds_i = events_i / (total_i - events_i)
        odds_c = events_c / (total_c - events_c)
        if odds_c:
            candidates.append(odds_i / odds_c)  # odds ratio
    tol = max(0.1, 0.1 * reported)
    return any(abs(value - reported) <= tol for value in candidates)


def recover_denominators_from_percentages(outcome) -> bool:
    """Fill missing arm totals from reported percentages. Mutates in place.

    Returns True only when a denominator was recovered and all guards passed.
    """
    outcome_type = str(_get(outcome, "outcome_type") or "").lower()
    if outcome_type and outcome_type not in {"dichotomous", "binary", "proportion"}:
        return False

    events_i = _get(outcome, "events_intervention")
    events_c = _get(outcome, "events_control")
    total_i = _get(outcome, "total_intervention")
    total_c = _get(outcome, "total_control")
    if events_i is None or events_c is None:
        return False
    if total_i is not None and total_c is not None:
        return False  # nothing missing

    quote = " ".join(
        str(_get(outcome, key) or "")
        for key in ("source_quote", "outcome_name", "source_section", "source_quote_match")
    )
    percents = _percentages(quote)
    if len(percents) < 2:
        return False
    percent_i, percent_c = percents[0], percents[1]

    new_total_i = total_i if total_i is not None else _derive_total(int(events_i), percent_i)
    new_total_c = total_c if total_c is not None else _derive_total(int(events_c), percent_c)
    if new_total_i is None or new_total_c is None:
        return False

    if not _effect_cross_check_ok(
        int(events_i), int(new_total_i), int(events_c), int(new_total_c),
        _get(outcome, "effect_size"),
    ):
        return False

    _set(outcome, "total_intervention", int(new_total_i))
    _set(outcome, "total_control", int(new_total_c))
    _set(outcome, "denominator_source", "derived_from_reported_percentage")
    note = (
        f"arm denominators recovered from reported percentages "
        f"({percent_i:g}% and {percent_c:g}%) applied to source-verified event counts"
    )
    existing = str(_get(outcome, "source_quote_match") or "").strip()
    _set(outcome, "source_quote_match", f"{existing} | {note}" if existing else note)
    return True


_ONES = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
    "eighteen": 18, "nineteen": 19,
}
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60,
         "seventy": 70, "eighty": 80, "ninety": 90}


def _english_number_words(n: int) -> set[str]:
    """English word forms for a small non-negative integer (0-99)."""
    if n < 0 or n > 99:
        return set()
    inverse_ones = {v: k for k, v in _ONES.items()}
    inverse_tens = {v: k for k, v in _TENS.items()}
    if n in inverse_ones:
        return {inverse_ones[n]}
    tens, ones = divmod(n, 10)
    base = tens * 10
    if base in inverse_tens:
        if ones == 0:
            return {inverse_tens[base]}
        word = f"{inverse_tens[base]}-{inverse_ones[ones]}"
        return {word, word.replace("-", " ")}
    return set()


def integer_evidenced_in_text(value, text: str) -> bool:
    """True if `value` appears in `text` as a digit OR its English number word.

    Source text frequently spells out small counts ("Eight out of 56 ... died"),
    so a digit-only check produces false 'unverified' flags for data that is
    plainly stated. Word matching is limited to 0-99 to stay conservative.
    """
    try:
        number = int(value)
    except (TypeError, ValueError):
        return False
    body = str(text or "")
    escaped = re.escape(f"{number:,}")
    plain = re.escape(str(number))
    if re.search(rf"(?<![\d.])(?:{escaped}|{plain})(?!\d|[.]\d)", body):
        return True
    for word in _english_number_words(number):
        if re.search(rf"\b{re.escape(word)}\b", body, flags=re.IGNORECASE):
            return True
    return False


def total_consistent_with_quoted_percentage(source_text: str, events, total) -> bool:
    """Gate-side check: is `total` reproducible from `events` and a quoted percentage?

    Lets the evidence gate treat a denominator that does not appear verbatim as
    source-backed when it is consistent (±1) with the event count and a percentage
    quoted in the same source text.
    """
    try:
        events_i = int(events)
        total_i = int(total)
    except (TypeError, ValueError):
        return False
    if total_i <= 0:
        return False
    for percent in _percentages(source_text):
        derived = round(events_i / (percent / 100.0)) if percent > 0 else None
        if derived is not None and abs(derived - total_i) <= 1:
            return True
    return False
