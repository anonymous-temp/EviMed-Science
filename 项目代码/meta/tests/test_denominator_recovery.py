"""Tests for deterministic arm-denominator recovery from reported percentages."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from new_meta.core.denominator_recovery import (
    integer_evidenced_in_text,
    recover_denominators_from_percentages,
    total_consistent_with_quoted_percentage,
)


def test_integer_evidenced_accepts_digits_and_english_words():
    # Spelled-out counts ("Eight out of 56 ... died") must verify like digits.
    assert integer_evidenced_in_text(8, "Eight out of 56 patients in the group died") is True
    assert integer_evidenced_in_text(8, "8 of 56 patients died") is True
    assert integer_evidenced_in_text(14, "There were 14/133 (11%) deaths") is True
    assert integer_evidenced_in_text(137, "137 patients allocated to placebo") is True
    assert integer_evidenced_in_text(21, "twenty-one events were recorded") is True
    assert integer_evidenced_in_text(999, "no matching number present") is False
    # Must not match a substring of a larger number.
    assert integer_evidenced_in_text(33, "the cohort had 337 patients") is False


def _crash3_row() -> dict:
    return {
        "outcome_name": "Head injury-related death (primary, <3h subgroup)",
        "outcome_type": "dichotomous",
        "events_intervention": 855,
        "total_intervention": None,
        "events_control": 892,
        "total_control": None,
        "effect_size": 0.94,
        "source_quote": (
            "Among patients treated within 3 h of injury, the risk of head injury-related "
            "death was 18·5% in the tranexamic acid group versus 19·8% in the placebo group "
            "(855 vs 892 events; risk ratio [RR] 0·94 [95% CI 0·86–1·02])."
        ),
    }


def test_recovers_subgroup_denominators_from_percentages():
    row = _crash3_row()
    assert recover_denominators_from_percentages(row) is True
    assert row["total_intervention"] == 4622   # 855 / 0.185
    assert row["total_control"] == 4505        # 892 / 0.198
    assert row["denominator_source"] == "derived_from_reported_percentage"
    # Recovered 2x2 reproduces the reported RR.
    rr = (row["events_intervention"] / row["total_intervention"]) / (
        row["events_control"] / row["total_control"]
    )
    assert abs(rr - 0.94) < 0.02


def test_no_recovery_when_totals_already_present():
    row = _crash3_row()
    row["total_intervention"] = 4622
    row["total_control"] = 4505
    assert recover_denominators_from_percentages(row) is False


def test_no_recovery_without_two_percentages():
    row = _crash3_row()
    row["source_quote"] = "head injury-related death occurred in 855 vs 892 patients"
    assert recover_denominators_from_percentages(row) is False
    assert row["total_intervention"] is None


def test_rejects_when_reported_effect_contradicts_recovery():
    # Percentages imply RR ~0.93 but a contradictory reported effect (2.0) blocks it.
    row = _crash3_row()
    row["effect_size"] = 2.0
    assert recover_denominators_from_percentages(row) is False
    assert row["total_intervention"] is None


def test_gate_accepts_percentage_consistent_denominator():
    quote = "18·5% in the tranexamic acid group versus 19·8% in the placebo group (855 vs 892 events)"
    assert total_consistent_with_quoted_percentage(quote, 855, 4622) is True
    assert total_consistent_with_quoted_percentage(quote, 892, 4505) is True
    # A denominator inconsistent with any quoted percentage is rejected.
    assert total_consistent_with_quoted_percentage(quote, 855, 9999) is False


def test_continuous_outcome_is_left_untouched():
    row = {
        "outcome_type": "continuous",
        "events_intervention": 10, "events_control": 12,
        "total_intervention": None, "total_control": None,
        "source_quote": "change was 18% vs 20%",
    }
    assert recover_denominators_from_percentages(row) is False
