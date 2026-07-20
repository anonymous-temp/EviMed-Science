from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from new_meta.engines.incidence import IncidenceStudy, run_incidence


ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT / "validation" / "corpora" / "metafor_nielweise_incidence_glmm.json"
POLICY_CASES = ROOT / "validation" / "corpora" / "incidence_policy_cases.json"


def test_poisson_normal_glmm_matches_metafor_irln_reference() -> None:
    fixture = json.loads(REFERENCE.read_text(encoding="utf-8"))

    result = run_incidence(fixture["studies"])
    expected = fixture["expected"]
    tolerance = expected["tolerance"]

    assert result.estimator == "POISSON_NORMAL_INCIDENCE_GLMM"
    assert result.pooled_log_rate == pytest.approx(expected["pooled_log_rate"], abs=tolerance)
    assert result.standard_error_log_rate == pytest.approx(
        expected["standard_error_log_rate"], abs=tolerance
    )
    assert result.tau_squared == pytest.approx(expected["tau_squared"], abs=tolerance)
    # metafor/lme4 reports a likelihood with a different additive normalization
    # constant. Cross-engine validation therefore compares all inferential
    # quantities, while the native engine still exposes its full Poisson log-L.
    assert math.isfinite(result.log_likelihood)
    assert result.pooled_rate == pytest.approx(expected["pooled_rate"], abs=tolerance)
    assert result.ci_lower == pytest.approx(expected["ci_lower"], abs=tolerance)
    assert result.ci_upper == pytest.approx(expected["ci_upper"], abs=tolerance)
    assert result.prediction_interval[0] == pytest.approx(
        expected["prediction_lower"], abs=tolerance
    )
    assert result.prediction_interval[1] == pytest.approx(
        expected["prediction_upper"], abs=tolerance
    )
    assert result.quadrature_points >= 100
    assert result.time_unit == "catheter_days"
    assert fixture["oracle"]["package"] == "metafor"
    assert fixture["oracle"]["measure"] == "IRLN"


def test_fixed_incidence_uses_aggregate_poisson_likelihood() -> None:
    result = run_incidence(
        [
            IncidenceStudy(study_id="A", events=4, person_time=500, time_unit="person_years"),
            IncidenceStudy(study_id="B", events=6, person_time=1000, time_unit="person_years"),
        ],
        model="fixed",
    )

    assert result.estimator == "POISSON_FIXED_INTERCEPT"
    assert result.pooled_rate == pytest.approx(10 / 1500, abs=1e-12)
    assert 0 < result.ci_lower < result.pooled_rate < result.ci_upper
    assert result.tau_squared == 0


def test_all_zero_incidence_has_finite_exact_boundary_result() -> None:
    fixture = json.loads(POLICY_CASES.read_text(encoding="utf-8"))["zero_count_case"]

    result = run_incidence(fixture["studies"])

    assert result.pooled_rate == 0
    assert result.ci_lower == 0
    assert result.ci_upper > 0
    assert math.isfinite(result.pooled_log_rate)
    assert result.diagnostics["boundary_fallback"] == "exact aggregate Poisson interval"


def test_incidence_rejects_unharmonized_time_units() -> None:
    fixture = json.loads(POLICY_CASES.read_text(encoding="utf-8"))["mixed_time_unit_case"]

    with pytest.raises(ValueError, match=fixture["expected_error"]):
        run_incidence(fixture["studies"])


def test_incidence_requires_positive_person_time() -> None:
    with pytest.raises(ValueError):
        IncidenceStudy(study_id="bad", events=1, person_time=0, time_unit="person_years")
