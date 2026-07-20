import json
import math
from pathlib import Path

import pytest

from new_meta.engines.dta import DiagnosticStudy, run_diagnostic_accuracy


def test_bivariate_model_recovers_identical_sensitivity_and_specificity() -> None:
    studies = [
        DiagnosticStudy(
            study_id=f"S{i}",
            true_positive=80,
            false_negative=20,
            false_positive=10,
            true_negative=90,
            threshold="10 ng/mL",
        )
        for i in range(1, 6)
    ]

    result = run_diagnostic_accuracy(studies)

    assert result.estimator == "REITSMA_BIVARIATE_REML"
    assert result.summary_sensitivity == pytest.approx(0.80, abs=0.01)
    assert result.summary_specificity == pytest.approx(0.90, abs=0.01)
    assert result.between_variance_sensitivity < 1e-3
    assert result.between_variance_specificity < 1e-3
    assert result.converged is True
    assert result.diagnostic_odds_ratio == pytest.approx(36.0, rel=0.08)


def test_bivariate_model_returns_finite_correlated_heterogeneity() -> None:
    studies = [
        DiagnosticStudy(study_id="A", true_positive=45, false_negative=5, false_positive=20, true_negative=80, threshold="common"),
        DiagnosticStudy(study_id="B", true_positive=70, false_negative=30, false_positive=5, true_negative=95, threshold="common"),
        DiagnosticStudy(study_id="C", true_positive=30, false_negative=20, false_positive=30, true_negative=70, threshold="common"),
        DiagnosticStudy(study_id="D", true_positive=90, false_negative=10, false_positive=15, true_negative=85, threshold="common"),
        DiagnosticStudy(study_id="E", true_positive=50, false_negative=50, false_positive=2, true_negative=98, threshold="common"),
    ]

    result = run_diagnostic_accuracy(studies)

    assert 0 < result.summary_sensitivity < 1
    assert 0 < result.summary_specificity < 1
    assert result.between_variance_sensitivity >= 0
    assert result.between_variance_specificity >= 0
    assert -1 <= result.between_correlation <= 1
    assert all(math.isfinite(value) for value in result.model_parameters.values())


def test_diagnostic_cells_must_be_nonnegative_and_have_both_disease_strata() -> None:
    with pytest.raises(ValueError):
        DiagnosticStudy(study_id="bad", true_positive=-1, false_negative=2, false_positive=3, true_negative=4)
    with pytest.raises(ValueError, match="diseased denominator"):
        DiagnosticStudy(study_id="bad", true_positive=0, false_negative=0, false_positive=3, true_negative=4)


def test_reitsma_reml_matches_official_mada_auditc_corpus() -> None:
    corpus_path = (
        Path(__file__).parents[1]
        / "validation"
        / "corpora"
        / "mada_auditc_reitsma_reml.json"
    )
    corpus = json.loads(corpus_path.read_text(encoding="utf-8"))

    result = run_diagnostic_accuracy(
        corpus["studies"],
        threshold_policy="unchecked_validation_fixture",
    )
    expected = corpus["expected"]
    tolerance = expected["tolerance"]

    assert result.estimator == "REITSMA_BIVARIATE_REML"
    assert result.summary_sensitivity == pytest.approx(expected["summary_sensitivity"], abs=tolerance)
    assert 1 - result.summary_specificity == pytest.approx(
        expected["summary_false_positive_rate"], abs=tolerance
    )
    assert result.model_parameters["logit_sensitivity"] == pytest.approx(
        expected["logit_sensitivity"], abs=tolerance
    )
    assert result.model_parameters["logit_false_positive_rate"] == pytest.approx(
        expected["logit_false_positive_rate"], abs=tolerance
    )
    assert result.model_parameters["se_logit_sensitivity"] == pytest.approx(
        expected["se_logit_sensitivity"], abs=tolerance
    )
    assert result.model_parameters["se_logit_false_positive_rate"] == pytest.approx(
        expected["se_logit_false_positive_rate"], abs=tolerance
    )
    assert result.model_parameters["tau_sensitivity"] == pytest.approx(
        expected["tau_sensitivity"], abs=tolerance
    )
    assert result.model_parameters["tau_false_positive_rate"] == pytest.approx(
        expected["tau_false_positive_rate"], abs=tolerance
    )
    assert result.between_correlation == pytest.approx(expected["rho"], abs=tolerance)
    assert result.log_likelihood == pytest.approx(expected["log_likelihood"], abs=tolerance)
    assert result.sroc_auc == pytest.approx(expected["auc"], abs=tolerance)
    assert result.diagnostics["continuity_corrected_studies"] == len(corpus["studies"])
    assert result.diagnostics["continuity_correction_scope"] == "all"


def test_bivariate_production_execution_requires_one_recorded_common_threshold() -> None:
    base = [
        {"study_id": "A", "true_positive": 40, "false_negative": 10, "false_positive": 8, "true_negative": 42},
        {"study_id": "B", "true_positive": 70, "false_negative": 30, "false_positive": 12, "true_negative": 88},
        {"study_id": "C", "true_positive": 25, "false_negative": 5, "false_positive": 15, "true_negative": 55},
    ]

    with pytest.raises(ValueError, match="recorded threshold"):
        run_diagnostic_accuracy([{**row, "threshold": ""} for row in base])
    with pytest.raises(ValueError, match="common threshold"):
        run_diagnostic_accuracy([
            {**base[0], "threshold": "10 ng/mL"},
            {**base[1], "threshold": "20 ng/mL"},
            {**base[2], "threshold": "10 ng/mL"},
        ])
