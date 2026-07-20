import json
from pathlib import Path

import pytest

from new_meta.engines.prediction_performance import run_prediction_performance


def _corpus_records():
    corpus = json.loads(
        (
            Path(__file__).parents[1]
            / "validation"
            / "corpora"
            / "metamisc_euroscore_cstat_reml.json"
        ).read_text(encoding="utf-8")
    )
    records = [
        {
            **row,
            "model_id": "EuroSCORE II",
            "model_version": "2012",
            "validation_type": "external",
            "metric": "C_STATISTIC",
            "time_horizon": "30 days",
        }
        for row in corpus["records"]
    ]
    return corpus, records


def test_cstat_reml_hksj_matches_official_metamisc_euroscore_corpus() -> None:
    corpus, records = _corpus_records()

    result = run_prediction_performance(records)
    expected = corpus["expected"]
    tolerance = expected["tolerance"]

    assert result.estimator == "VALMETA_CSTAT_REML_HKSJ"
    assert result.metric == "C_STATISTIC"
    assert result.n_studies == 23
    assert result.pooled_analysis_scale == pytest.approx(expected["pooled_logit"], abs=tolerance)
    assert result.pooled_performance == pytest.approx(expected["pooled_c_statistic"], abs=tolerance)
    assert result.ci_lower == pytest.approx(expected["ci_lower"], abs=tolerance)
    assert result.ci_upper == pytest.approx(expected["ci_upper"], abs=tolerance)
    assert result.prediction_interval[0] == pytest.approx(expected["prediction_lower"], abs=tolerance)
    assert result.prediction_interval[1] == pytest.approx(expected["prediction_upper"], abs=tolerance)
    assert result.tau_squared == pytest.approx(expected["tau_squared"], abs=tolerance)
    assert result.model_id == "EuroSCORE II"
    assert result.validation_type == "external"
    assert set(result.diagnostics["precision_sources"].values()) == {
        "reported_standard_error",
        "reported_confidence_interval",
        "newcombe_method_4",
    }


def test_prediction_performance_rejects_model_mixing_and_non_external_apparent_results() -> None:
    _corpus, records = _corpus_records()
    mixed = [dict(row) for row in records[:3]]
    mixed[1]["model_version"] = "2025-update"
    with pytest.raises(ValueError, match="one model identity and version"):
        run_prediction_performance(mixed)

    apparent = [dict(row) for row in records[:3]]
    apparent[1]["validation_type"] = "development_apparent"
    with pytest.raises(ValueError, match="external validation"):
        run_prediction_performance(apparent)

    mixed_horizon = [dict(row) for row in records[:3]]
    mixed_horizon[2]["time_horizon"] = "1 year"
    with pytest.raises(ValueError, match="one time horizon"):
        run_prediction_performance(mixed_horizon)
