import math

import numpy as np

from new_meta.engines.effect_size import odds_ratio
from new_meta.engines.meta_engine import random_effects_dl, random_effects_hksj, random_effects_reml
from new_meta.engines.publication_bias import pet_peese, run_all_tests, trim_and_fill
from new_meta.schemas.meta_result import StudyEffect


def _studies(n: int) -> list[StudyEffect]:
    return [
        StudyEffect(
            study_id=f"s{i}",
            study_label=f"Study {i}",
            yi=float(0.1 * i),
            vi=float(0.04 + 0.005 * i),
            se=math.sqrt(0.04 + 0.005 * i),
        )
        for i in range(1, n + 1)
    ]


def test_continuity_correction_only_changes_zero_cells() -> None:
    log_or, variance = odds_ratio(0, 10, 5, 20, correction=0.5)

    assert math.isclose(log_or, math.log((0.5 * 20) / (10 * 5)), rel_tol=1e-12)
    assert math.isclose(variance, 1 / 0.5 + 1 / 10 + 1 / 5 + 1 / 20, rel_tol=1e-12)


def test_random_effects_low_k_downgrades_to_fixed_without_prediction_interval() -> None:
    for fn in (random_effects_dl, random_effects_reml, random_effects_hksj):
        result = fn(_studies(2), "MD", "mortality")

        assert result.model == "fixed"
        assert result.tau_squared == 0
        assert result.prediction_interval is None


def test_publication_bias_tests_are_not_reported_for_sparse_meta_analyses() -> None:
    sparse = run_all_tests(_studies(7), "MD")

    assert sparse.egger_intercept is None
    assert sparse.begg_tau is None
    assert sparse.pet_intercept is None
    assert sparse.trim_fill_missing is None
    assert sparse.failsafe_n is not None


def test_pet_peese_uses_ordinary_least_squares_intercept_for_pet() -> None:
    studies = _studies(10)
    result = pet_peese(studies)
    yi = np.array([s.yi for s in studies])
    se = np.array([s.se for s in studies])
    expected_intercept = np.linalg.lstsq(
        np.column_stack([np.ones(len(studies)), se]),
        yi,
        rcond=None,
    )[0][0]

    assert math.isclose(result["pet_intercept"], float(expected_intercept), rel_tol=1e-12)


def test_trim_and_fill_accepts_auto_side() -> None:
    n_missing, adjusted, lower, upper = trim_and_fill(_studies(10), "MD", side="auto")

    assert n_missing >= 0
    assert math.isfinite(adjusted)
    assert lower <= adjusted <= upper
