"""A correct landmark estimate must not conceal missing censor-only plot rows."""
import importlib.util
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parents[2] / "capabilities/statistical-analysis/scripts/analysis_checks.py"
spec = importlib.util.spec_from_file_location("survival_checks", SOURCE)
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


def curve():
    return [
        {"time": 1, "atRisk": 4, "events": 1, "censored": 0, "survival": .75},
        {"time": 2, "atRisk": 3, "events": 0, "censored": 1, "survival": .75},
        {"time": 3, "atRisk": 2, "events": 1, "censored": 0, "survival": .375},
        {"time": 4, "atRisk": 1, "events": 0, "censored": 1, "survival": .375},
    ]


def audit(rows):
    return checks.audit_survival_curve(rows, n=4, events=2, censored=2, max_time=4)


def test_complete_event_and_censor_timeline_is_supported():
    assert audit(curve())["status"] == "supported_by_declared_checks"


def test_event_only_curve_fails_even_though_landmark_survival_is_correct():
    result = audit([curve()[0], curve()[2]])
    assert result["status"] == "findings"
    codes = {item["code"] for item in result["findings"]}
    assert {"censor_total_mismatch", "timeline_ends_early", "risk_set_mismatch"} <= codes


@pytest.mark.parametrize("mutation,code", [
    (lambda rows: rows[2].update(survival=.9), "survival_recursion_mismatch"),
    (lambda rows: rows[1].update(events=-1), "invalid_count"),
    (lambda rows: rows[1].update(time=1), "time_not_increasing"),
    (lambda rows: rows[1].update(survival=float('nan')), "invalid_survival"),
])
def test_plot_invariants_are_explicit(mutation, code):
    rows = curve()
    mutation(rows)
    assert code in {item["code"] for item in audit(rows)["findings"]}


def test_missing_timeline_and_unknown_totals_are_not_a_pass():
    assert audit([])["status"] != "supported_by_declared_checks"
    assert checks.audit_survival_curve(curve(), n=None, events=2, censored=2, max_time=4)["status"] == "unavailable"
