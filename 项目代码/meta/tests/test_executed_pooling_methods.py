"""Executed methods stay bound to their actual numeric branches, including fallbacks."""
import math
from types import SimpleNamespace

import pytest

from new_meta.engines import meta_engine
from new_meta.engines.adjusted_effects import run_adjusted_effects
from new_meta.engines.complex_rct import run_complex_rct
from new_meta.engines.dose_response import run_dose_response
from new_meta.engines.ipd import run_ipd_meta
from new_meta.engines.prediction_performance import run_prediction_performance
from new_meta.schemas.meta_result import PooledEffect, StudyEffect
from test_adjusted_effects_engine import _records as adjusted_records
from test_complex_rct_engine import _records as complex_records
from test_dose_response_engine import _records as dose_records
from test_ipd_engine import _continuous_studies
from test_prediction_performance_engine import _corpus_records


def effects(n=3):
    return [StudyEffect(study_id=str(i), study_label=str(i), yi=y, vi=0.1, se=math.sqrt(0.1))
            for i, y in enumerate([0.0, 1.0, 3.0][:n])]


@pytest.mark.parametrize("method", ["DL", "REML", "HKSJ"])
def test_sparse_execution_retains_fixed_numeric_golden_and_requested_method(method):
    fn = getattr(meta_engine, f"random_effects_{method.lower()}")
    with pytest.raises(ValueError, match=">= 2"):
        fn(effects(1), "MD", "outcome")
    result = fn(effects(2), "MD", "outcome")
    assert (result.pooled_effect, result.ci_lower, result.ci_upper) == pytest.approx(
        (0.5, 0.06173067641004121, 0.9382693235899588), abs=1e-12)
    assert result.model == "fixed"
    assert result.tau_squared == 0
    assert result.prediction_interval is None
    assert result.tau_estimator == "none"
    assert result.ci_method == "normal_wald"
    assert result.requested_method == method
    assert result.fallback_reason == "fewer_than_three_studies"


@pytest.mark.parametrize("failure", ["refused", "exception"])
def test_optimizer_failure_keeps_dl_numbers_and_discloses_actual_estimation(monkeypatch, failure):
    def fail(*args, **kwargs):
        if failure == "exception":
            raise RuntimeError("optimizer stopped")
        return SimpleNamespace(success=False, fun=0.0, x=100.0)
    monkeypatch.setattr(meta_engine.optimize, "minimize_scalar", fail)
    result = meta_engine.random_effects_reml(effects(), "MD", "outcome")
    # Independent closed-form equal-variance DL reference; no production call supplies the expected values.
    tau2 = 67 / 30
    se = math.sqrt((0.1 + tau2) / 3)
    assert result.tau_squared == pytest.approx(tau2, abs=1e-12)
    assert (result.pooled_effect, result.ci_lower, result.ci_upper) == pytest.approx(
        (4 / 3, 4 / 3 - 1.96 * se, 4 / 3 + 1.96 * se), abs=1e-12)
    assert result.model == "random"
    assert result.tau_estimator == "DL"
    assert result.ci_method == "normal_wald"
    assert result.requested_method == "REML"
    assert result.fallback_reason == "reml_optimizer_failed"
    assert result.tau_estimation_converged is False


def test_zero_tau_reml_is_still_random_and_hksj_names_interval_separately(monkeypatch):
    monkeypatch.setattr(meta_engine.optimize, "minimize_scalar", lambda *a, **k: SimpleNamespace(success=True, fun=0.0, x=0.0))
    result = meta_engine.random_effects_reml(effects(), "MD", "outcome")
    assert result.tau_squared == 0
    assert (result.model, result.tau_estimator, result.ci_method) == ("random", "REML", "normal_wald")
    assert result.fallback_reason is None
    assert result.tau_estimation_converged is True
    hk = meta_engine.random_effects_hksj(effects(), "MD", "outcome")
    assert hk.tau_estimator == "DL"
    assert hk.ci_method == "modified_hksj_t"
    assert hk.requested_method == "HKSJ"


def test_old_serialized_results_remain_readable_without_inventing_interval_provenance():
    result = PooledEffect(outcome_name="old", n_studies=3, effect_measure="MD", pooled_effect=1,
                          ci_lower=0, ci_upper=2, p_value=0.05, model="random", tau_estimator="HKSJ")
    assert result.tau_estimator == "HKSJ"  # Preserve the original historical field, not infer a new execution.
    assert result.ci_method == "unknown"
    assert result.requested_method is None


@pytest.mark.parametrize("engine,rows,label,golden", [
    (run_complex_rct, complex_records, "DESIGN_AWARE_FIXED", (0.7767392707588571, 0.6673533122537364, 0.9040546943589746)),
    (run_adjusted_effects, adjusted_records, "FIXED_ADJUSTED_EFFECTS", (0.7768270819204934, 0.6676230457986447, 0.9038937750916296)),
])
def test_sparse_wrappers_carry_the_fixed_execution_in_primary_and_sensitivity(engine, rows, label, golden):
    result = engine(rows()[:2])
    assert (result.pooled_effect, result.ci_lower, result.ci_upper) == pytest.approx(golden, abs=1e-12)
    assert result.estimator == label
    assert result.executed_method.model == "fixed"
    assert result.executed_method.ci_method == "normal_wald"
    assert result.sensitivity["HKSJ"]["executed_method"]["ci_method"] == "normal_wald"
    assert result.sensitivity["HKSJ"]["executed_method"]["fallback_reason"] == "fewer_than_three_studies"
    assert result.prediction_interval is None


def test_ipd_primary_is_wald_and_real_hksj_sensitivity_retains_distinct_interval():
    result = run_ipd_meta(_continuous_studies(), outcome_type="continuous", effect_measure="MD", covariates=["baseline"])
    assert (result.ci_lower, result.ci_upper) == pytest.approx((-2.1190500721410186, -1.3796806490480074), abs=1e-10)
    assert (result.hksj_sensitivity["ci_lower"], result.hksj_sensitivity["ci_upper"]) == pytest.approx(
        (-2.363292475395774, -1.1361755955931268), abs=1e-10)
    assert result.estimator == "TWO_STAGE_IPD_REML"
    assert result.executed_method.ci_method == "normal_wald"
    assert result.hksj_sensitivity["executed_method"]["ci_method"] == "modified_hksj_t"


def test_prediction_really_uses_hk_and_dose_primary_keeps_multivariate_identity(monkeypatch):
    corpus, rows = _corpus_records()
    prediction = run_prediction_performance(rows)
    assert prediction.estimator == "VALMETA_CSTAT_REML_HKSJ"
    assert prediction.ci_lower == pytest.approx(corpus["expected"]["ci_lower"], abs=corpus["expected"]["tolerance"])
    assert prediction.executed_method.ci_method == "hksj_t"
    monkeypatch.setattr(meta_engine.optimize, "minimize_scalar", lambda *a, **k: SimpleNamespace(success=False))
    fallback = run_prediction_performance(rows)
    assert fallback.estimator == "VALMETA_CSTAT_DL_HKSJ"
    assert fallback.executed_method.ci_method == "hksj_t"
    assert fallback.executed_method.fallback_reason == "reml_optimizer_failed"
    dose = run_dose_response(dose_records())
    assert dose.estimator == "TWO_STAGE_MULTIVARIATE_REML_RCS"
    assert dose.linear_sensitivity["executed_method"]["tau_estimator"] == "DL"
    assert dose.linear_sensitivity["executed_method"]["fallback_reason"] == "reml_optimizer_failed"
