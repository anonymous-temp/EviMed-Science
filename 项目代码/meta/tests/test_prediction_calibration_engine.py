from __future__ import annotations

import json
from pathlib import Path

import pytest

from new_meta.engines.prediction_performance import run_prediction_performance


CORPUS = (
    Path(__file__).resolve().parents[1]
    / "validation"
    / "corpora"
    / "metamisc_euroscore_oe_reml.json"
)


def _records() -> tuple[list[dict], dict]:
    fixture = json.loads(CORPUS.read_text(encoding="utf-8"))
    records = [
        {
            **item,
            "model_id": "EuroSCORE",
            "model_version": "additive",
            "validation_type": "external",
            "metric": "OE_RATIO",
            "time_horizon": "in-hospital mortality",
        }
        for item in fixture["records"]
    ]
    return records, fixture


def test_oe_reml_hksj_matches_metamisc_euroscore_reference() -> None:
    records, fixture = _records()

    result = run_prediction_performance(records)
    expected = fixture["expected"]
    tolerance = expected["tolerance"]

    assert result.estimator == "VALMETA_OE_REML_HKSJ"
    assert result.metric == "OE_RATIO"
    assert result.pooled_analysis_scale == pytest.approx(expected["pooled_log_oe"], abs=tolerance)
    assert result.standard_error_analysis_scale == pytest.approx(
        expected["standard_error_log_oe"], abs=tolerance
    )
    assert result.pooled_performance == pytest.approx(expected["pooled_oe_ratio"], abs=tolerance)
    assert result.ci_lower == pytest.approx(expected["ci_lower"], abs=tolerance)
    assert result.ci_upper == pytest.approx(expected["ci_upper"], abs=tolerance)
    assert result.prediction_interval[0] == pytest.approx(
        expected["prediction_lower"], abs=tolerance
    )
    assert result.prediction_interval[1] == pytest.approx(
        expected["prediction_upper"], abs=tolerance
    )
    assert result.tau_squared == pytest.approx(expected["tau_squared"], abs=tolerance)
    assert result.q == pytest.approx(expected["q"], abs=tolerance)
    assert result.diagnostics["analysis_scale"] == "log_observed_expected_ratio"
    assert result.diagnostics["precision_sources"]["Nashef"] == "observed_expected_sample_size"
    assert fixture["oracle"]["package"] == "metamisc"


def test_oe_synthesis_rejects_zero_observed_events_without_reported_precision() -> None:
    records, _ = _records()
    records[0] = {**records[0], "observed_events": 0}

    with pytest.raises(ValueError, match="zero observed events"):
        run_prediction_performance(records)


def test_oe_synthesis_rejects_model_version_mixing() -> None:
    records, _ = _records()
    records[0] = {**records[0], "model_version": "logistic"}

    with pytest.raises(ValueError, match="one model identity and version"):
        run_prediction_performance(records)


def test_oe_synthesis_requires_external_validation_only() -> None:
    records, _ = _records()
    records[0] = {**records[0], "validation_type": "development"}

    with pytest.raises(ValueError, match="external validation"):
        run_prediction_performance(records)
