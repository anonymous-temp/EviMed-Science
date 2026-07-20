import math

import pytest

from new_meta.engines.prevalence import PrevalenceStudy, run_prevalence


def test_fixed_binomial_prevalence_matches_aggregate_likelihood_oracle() -> None:
    result = run_prevalence(
        [
            PrevalenceStudy(study_id="A", events=10, total=100),
            PrevalenceStudy(study_id="B", events=20, total=100),
        ],
        model="fixed",
    )

    assert result.estimator == "BINOMIAL_FIXED_INTERCEPT"
    assert result.pooled_proportion == pytest.approx(30 / 200, abs=1e-10)
    assert result.tau_squared == 0.0
    assert 0 < result.ci_lower < result.pooled_proportion < result.ci_upper < 1


def test_logistic_normal_glmm_recovers_identical_study_prevalence() -> None:
    result = run_prevalence(
        [
            PrevalenceStudy(study_id="A", events=10, total=100),
            PrevalenceStudy(study_id="B", events=20, total=200),
            PrevalenceStudy(study_id="C", events=5, total=50),
            PrevalenceStudy(study_id="D", events=15, total=150),
        ],
        model="random",
    )

    assert result.estimator == "LOGISTIC_NORMAL_BINOMIAL_GLMM"
    assert result.pooled_proportion == pytest.approx(0.10, abs=0.01)
    assert result.tau_squared < 1e-3
    assert result.converged is True
    assert result.quadrature_points >= 20


@pytest.mark.parametrize(
    "studies",
    [
        [PrevalenceStudy(study_id="A", events=0, total=50), PrevalenceStudy(study_id="B", events=0, total=100)],
        [PrevalenceStudy(study_id="A", events=50, total=50), PrevalenceStudy(study_id="B", events=100, total=100)],
    ],
)
def test_glmm_handles_all_zero_and_all_event_boundaries_without_nan(studies) -> None:
    result = run_prevalence(studies, model="random")

    assert math.isfinite(result.pooled_proportion)
    assert math.isfinite(result.ci_lower)
    assert math.isfinite(result.ci_upper)
    assert 0 <= result.ci_lower <= result.pooled_proportion <= result.ci_upper <= 1


def test_prevalence_input_rejects_events_above_denominator() -> None:
    with pytest.raises(ValueError, match="events cannot exceed total"):
        PrevalenceStudy(study_id="bad", events=11, total=10)
