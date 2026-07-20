import json
from pathlib import Path

import pytest

from new_meta.engines.prediction_performance import run_prediction_performance


CORPUS = (
    Path(__file__).resolve().parents[1]
    / "validation"
    / "corpora"
    / "metafor_calibration_slope_reml.json"
)


def _records() -> tuple[list[dict], dict]:
    fixture = json.loads(CORPUS.read_text(encoding="utf-8"))
    records = [
        {
            **item,
            "model_id": "Model X",
            "model_version": "1.0",
            "validation_type": "external",
            "metric": "CALIBRATION_SLOPE",
            "time_horizon": "30 days",
        }
        for item in fixture["records"]
    ]
    return records, fixture


def test_calibration_slope_reml_hksj_matches_metafor_reference() -> None:
    records, fixture = _records()

    result = run_prediction_performance(records)
    expected = fixture["expected"]
    tolerance = expected["tolerance"]

    assert result.estimator == "CALIBRATION_SLOPE_REML_HKSJ"
    assert result.metric == "CALIBRATION_SLOPE"
    assert result.pooled_performance == pytest.approx(expected["pooled_slope"], abs=tolerance)
    assert result.standard_error_analysis_scale == pytest.approx(expected["standard_error"], abs=tolerance)
    assert result.ci_lower == pytest.approx(expected["ci_lower"], abs=tolerance)
    assert result.ci_upper == pytest.approx(expected["ci_upper"], abs=tolerance)
    assert result.prediction_interval[0] == pytest.approx(expected["prediction_lower"], abs=tolerance)
    assert result.prediction_interval[1] == pytest.approx(expected["prediction_upper"], abs=tolerance)
    assert result.tau_squared == pytest.approx(expected["tau_squared"], abs=tolerance)
    assert result.q == pytest.approx(expected["q"], abs=tolerance)
    assert result.i_squared == pytest.approx(
        expected["i_squared"], abs=expected["i_squared_tolerance"]
    )
    assert result.diagnostics["analysis_scale"] == "original_calibration_slope"
    assert result.diagnostics["ideal_value"] == 1.0


def test_calibration_slope_requires_reported_precision() -> None:
    records, _ = _records()
    records[0] = {**records[0], "standard_error": None}

    with pytest.raises(ValueError, match="SE or CI"):
        run_prediction_performance(records)


def test_calibration_slope_rejects_mixed_horizons() -> None:
    records, _ = _records()
    records[0] = {**records[0], "time_horizon": "1 year"}

    with pytest.raises(ValueError, match="one time horizon"):
        run_prediction_performance(records)
