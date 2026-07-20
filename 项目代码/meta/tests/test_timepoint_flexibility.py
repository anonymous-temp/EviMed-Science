"""Tests for flexible primary-outcome timepoint acceptance in the evidence gate."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from new_meta.core.manuscript_facts import (
    _outcome_timepoint_is_flexible,
    _row_source_mentions_compatible_timepoint,
    _target_day,
)


def test_flexible_outcome_detected():
    assert _outcome_timepoint_is_flexible(
        "All-cause mortality (at longest follow-up available, in-hospital, 30-day, etc.)"
    ) is True
    # Two distinct day-values also signals flexibility.
    assert _outcome_timepoint_is_flexible("28-day or 90-day all-cause mortality") is True


def test_specific_single_timepoint_stays_strict():
    # A single named timepoint must NOT be treated as flexible (keeps strict matching).
    assert _outcome_timepoint_is_flexible("28-day all-cause mortality") is False
    assert _outcome_timepoint_is_flexible("All-cause mortality at 28 days post-randomization") is False


def test_compatible_timepoint_within_window():
    # CRASH-3 reports 28-day death; target parsed as 30 -> within ±7 window.
    assert _row_source_mentions_compatible_timepoint(
        {"source_quote": "risk of head injury-related death within 28 days"}, "30"
    ) is True


def test_in_hospital_is_compatible_with_flexible_mortality():
    assert _row_source_mentions_compatible_timepoint(
        {"source_quote": "in-hospital mortality was 14 of 133"}, "30"
    ) is True


def test_distant_timepoint_not_compatible():
    assert _row_source_mentions_compatible_timepoint(
        {"source_quote": "mortality at 10 days after injury"}, "30"
    ) is False


def test_target_day_parses_first_day_value():
    assert _target_day("in-hospital, 30-day, etc.") == "30"
    assert _target_day("all-cause mortality, no day given") == ""
