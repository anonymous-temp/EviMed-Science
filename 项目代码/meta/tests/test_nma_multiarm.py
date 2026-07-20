import numpy as np
import pytest

from new_meta.engines.nma import MultiArmCovarianceError, NMAEngine


def _multiarm_contrasts(with_covariance: bool = True):
    shared = {"shared_comparator_variance": 0.04} if with_covariance else {}
    return [
        {
            "contrast_id": "M:B-A",
            "study_id": "M",
            "treatment": "B",
            "comparator": "A",
            "yi": 0.20,
            "vi": 0.10,
            **shared,
        },
        {
            "contrast_id": "M:C-A",
            "study_id": "M",
            "treatment": "C",
            "comparator": "A",
            "yi": 0.40,
            "vi": 0.12,
            **shared,
        },
        {"study_id": "S2", "treatment": "B", "comparator": "A", "yi": 0.25, "vi": 0.08},
        {"study_id": "S3", "treatment": "C", "comparator": "B", "yi": 0.15, "vi": 0.09},
    ]


def test_multiarm_study_requires_explicit_within_study_covariance() -> None:
    with pytest.raises(MultiArmCovarianceError, match="multi-arm study M"):
        NMAEngine(_multiarm_contrasts(with_covariance=False), ["A", "B", "C"], reference="A")


def test_multiarm_sampling_covariance_is_used_in_gls_oracle() -> None:
    engine = NMAEngine(_multiarm_contrasts(), ["A", "B", "C"], reference="A")

    assert engine._V[0, 1] == pytest.approx(0.04)
    assert engine._V[1, 0] == pytest.approx(0.04)
    assert np.allclose(engine._W, np.linalg.inv(engine._V))

    expected = np.linalg.inv(engine._X.T @ engine._W @ engine._X) @ (
        engine._X.T @ engine._W @ engine._y
    )
    engine.fit()
    assert np.allclose(engine._beta, expected, atol=1e-12)


def test_random_effect_covariance_preserves_multiarm_correlation_structure() -> None:
    engine = NMAEngine(_multiarm_contrasts(), ["A", "B", "C"], reference="A")

    covariance = engine._random_effect_covariance(0.20)

    assert covariance[0, 0] == pytest.approx(0.10 + 0.20)
    assert covariance[1, 1] == pytest.approx(0.12 + 0.20)
    assert covariance[0, 1] == pytest.approx(0.04 + 0.10)
    assert covariance[1, 0] == pytest.approx(0.04 + 0.10)
    assert covariance[2, 2] == pytest.approx(0.08 + 0.20)
    assert covariance[2, 3] == 0.0


def test_outcome_direction_controls_treatment_ranking() -> None:
    contrasts = [
        {"study_id": "S1", "treatment": "B", "comparator": "A", "yi": 1.0, "vi": 0.05},
        {"study_id": "S2", "treatment": "C", "comparator": "A", "yi": -1.0, "vi": 0.05},
        {"study_id": "S3", "treatment": "B", "comparator": "C", "yi": 2.0, "vi": 0.05},
    ]

    lower = NMAEngine(contrasts, ["A", "B", "C"], reference="A", outcome_direction="lower").fit()
    higher = NMAEngine(contrasts, ["A", "B", "C"], reference="A", outcome_direction="higher").fit()

    assert max(lower.sucra_rankings, key=lower.sucra_rankings.get) == "C"
    assert max(higher.sucra_rankings, key=higher.sucra_rankings.get) == "B"


def test_random_effects_nma_uses_reml_with_multiarm_covariance() -> None:
    contrasts = _multiarm_contrasts() + [
        {"study_id": "S4", "treatment": "B", "comparator": "A", "yi": 1.10, "vi": 0.07},
        {"study_id": "S5", "treatment": "C", "comparator": "A", "yi": -0.20, "vi": 0.08},
        {"study_id": "S6", "treatment": "C", "comparator": "B", "yi": 0.80, "vi": 0.06},
    ]
    engine = NMAEngine(contrasts, ["A", "B", "C"], reference="A")

    result = engine.fit_random_effects()

    assert result.model == "random"
    assert result.tau_squared >= 0
    assert result.tau_estimator == "REML"
    assert np.allclose(engine._W, np.linalg.inv(engine._random_effect_covariance(result.tau_squared)))
    assert result.diagnostics["multiarm_covariance"] is True
    assert result.diagnostics["global_q_df"] == len(contrasts) - 2
