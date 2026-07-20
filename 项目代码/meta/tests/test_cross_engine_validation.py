import json
from pathlib import Path

import pytest

from new_meta.engines.effect_size import risk_ratio
from new_meta.engines.meta_engine import random_effects_reml
from new_meta.engines.prevalence import run_prevalence
from new_meta.schemas.meta_result import StudyEffect


CORPUS = Path(__file__).resolve().parents[1] / "validation" / "corpora" / "metafor_bcg_rr_reml.json"
PREVALENCE_CORPUS = (
    Path(__file__).resolve().parents[1]
    / "validation"
    / "corpora"
    / "metafor_debruin_prevalence_glmm.json"
)
PREVALENCE_BOUNDARY_CORPUS = (
    Path(__file__).resolve().parents[1]
    / "validation"
    / "corpora"
    / "prevalence_boundary_cases.json"
)


def test_reml_matches_versioned_metafor_bcg_reference_corpus() -> None:
    fixture = json.loads(CORPUS.read_text(encoding="utf-8"))
    effects = []
    for row in fixture["studies"]:
        yi, vi = risk_ratio(row["tpos"], row["tneg"], row["cpos"], row["cneg"])
        effects.append(
            StudyEffect(
                study_id=str(row["trial"]),
                study_label=str(row["author"]),
                yi=yi,
                vi=vi,
                se=vi**0.5,
            )
        )

    result = random_effects_reml(effects, "RR", "BCG tuberculosis prevention")
    expected = fixture["expected"]

    assert result.pooled_log == pytest.approx(expected["estimate"], abs=expected["tolerance"])
    assert result.tau_squared == pytest.approx(expected["tau_squared"], abs=expected["tolerance"])
    assert result.q_statistic == pytest.approx(expected["q"], abs=expected["tolerance"])
    assert result.ci_lower_log == pytest.approx(expected["ci_lower"], abs=expected["tolerance"])
    assert result.ci_upper_log == pytest.approx(expected["ci_upper"], abs=expected["tolerance"])
    assert fixture["oracle"]["package"] == "metafor"
    assert fixture["oracle"]["function"] == "rma"


def test_prevalence_glmm_matches_versioned_metafor_reference_corpus() -> None:
    fixture = json.loads(PREVALENCE_CORPUS.read_text(encoding="utf-8"))

    result = run_prevalence(fixture["studies"])
    expected = fixture["expected"]
    tolerance = expected["tolerance"]

    assert result.pooled_proportion == pytest.approx(expected["pooled_proportion"], abs=tolerance)
    assert result.ci_lower == pytest.approx(expected["ci_lower"], abs=tolerance)
    assert result.ci_upper == pytest.approx(expected["ci_upper"], abs=tolerance)
    assert result.prediction_interval[0] == pytest.approx(expected["prediction_lower"], abs=tolerance)
    assert result.prediction_interval[1] == pytest.approx(expected["prediction_upper"], abs=tolerance)
    assert result.quadrature_points >= 100
    assert fixture["oracle"]["package"] == "metafor"
    assert fixture["oracle"]["function"] == "rma.glmm"


def test_prevalence_glmm_matches_exact_boundary_reference_corpus() -> None:
    fixture = json.loads(PREVALENCE_BOUNDARY_CORPUS.read_text(encoding="utf-8"))

    for case in fixture["cases"]:
        result = run_prevalence(case["studies"])
        expected = case["expected"]
        assert result.pooled_proportion == pytest.approx(
            expected["pooled_proportion"], abs=fixture["tolerance"]
        )
        assert result.ci_lower == pytest.approx(expected["ci_lower"], abs=fixture["tolerance"])
        assert result.ci_upper == pytest.approx(expected["ci_upper"], abs=fixture["tolerance"])
        assert result.diagnostics["boundary_fallback"] == "exact aggregate binomial interval"
