"""Pooling, heterogeneity, small-study tests and effect sizes against published worked examples.

Every expected number is one a publication or an independent implementation's documentation
prints (``validation/corpora/published_worked_examples.json`` cites each one); none was
produced by this code, and the inputs are the sources' own data.

The tolerance is the sources' printed precision, stated per case in the corpus: half a unit in
the last printed digit (5e-5 for four decimals), plus, where the source prints its *inputs* to
four decimals too (Raudenbush, Normand, Hine print yi and vi rounded), the first-order effect
that rounding has on the statistic. A pooled value computed from rounded inputs cannot be
expected to equal the one the source computed from unrounded data to more than that.

Run from the engine directory: ``python -m pytest tests/test_published_reference_cases.py``.
"""
from __future__ import annotations

import copy
import json
import math
from pathlib import Path

import pytest

from new_meta.engines.effect_size import odds_ratio, risk_difference, risk_ratio, standardized_mean_difference
from new_meta.engines.meta_engine import (
    fixed_effect,
    meta_regression,
    random_effects_dl,
    random_effects_hksj,
    random_effects_reml,
)
from new_meta.engines.publication_bias import begg_test, egger_regression, failsafe_n, trim_and_fill
from new_meta.schemas.meta_result import StudyEffect

ENGINE_ROOT = Path(__file__).resolve().parents[1]
CORPUS = json.loads((ENGINE_ROOT / "validation" / "corpora" / "published_worked_examples.json").read_text(encoding="utf-8"))
CASES = {case["case_id"]: case for case in CORPUS["cases"]}
Z_975 = 1.959963984540054  # the 97.5th percentile of the standard normal, as tables print it
T_975_DF18 = 2.100922  # t distribution, 18 df (tables)
HALF_UNIT = 0.5e-4  # half a unit in the fourth decimal


def study_effects(rows):
    return [StudyEffect(study_id=str(row.get("study", index)), study_label=str(row.get("label", index)),
                        yi=row["yi"], vi=row["vi"], se=math.sqrt(row["vi"])) for index, row in enumerate(rows)]


def binary_effects(trials, measure="OR"):
    function = {"OR": odds_ratio, "RR": risk_ratio}[measure]
    out = []
    for index, trial in enumerate(trials):
        yi, vi = function(trial["ai"], trial["n1i"] - trial["ai"], trial["ci"], trial["n2i"] - trial["ci"])
        out.append(StudyEffect(study_id=str(index), study_label=str(trial.get("study", index)), yi=yi, vi=vi, se=math.sqrt(vi)))
    return out


def printed_tolerance(statistic, rows):
    """Half a printed unit, plus the first-order effect of rounding every printed input by half a unit."""
    base = statistic(rows)
    bound = HALF_UNIT
    for index in range(len(rows)):
        for field in ("yi", "vi"):
            moved = copy.deepcopy(rows)
            moved[index][field] += HALF_UNIT
            bound += abs(statistic(moved) - base)
    return bound


def check(expected, statistic, rows):
    tolerance = printed_tolerance(statistic, rows)
    obtained = statistic(rows)
    assert abs(obtained - expected) <= tolerance + 1e-9, f"obtained {obtained!r}, published {expected!r}, tolerance {tolerance!r}"


def se_of(result):
    return (result.ci_upper_log - result.ci_lower_log) / (2 * Z_975)


# -- Raudenbush (2009), Tables 16.2 and 16.3: 19 teacher-expectancy trials ---------------------

RAUDENBUSH = CASES["raudenbush1985_expectancy"]
RAUD_ROWS = RAUDENBUSH["studies"]


@pytest.mark.parametrize("name,fit", [("fixed", fixed_effect), ("reml", random_effects_reml), ("dl", random_effects_dl)])
def test_raudenbush_pooled_estimate_interval_se_and_z(name, fit):
    expected = RAUDENBUSH["expected"][name]
    run = lambda rows: fit(study_effects(rows), "MD", "iq")  # noqa: E731
    check(expected["estimate"], lambda rows: run(rows).pooled_log, RAUD_ROWS)
    check(expected["se"], lambda rows: se_of(run(rows)), RAUD_ROWS)
    check(expected["z"], lambda rows: run(rows).pooled_log / se_of(run(rows)), RAUD_ROWS)
    check(expected["ci"][0], lambda rows: run(rows).ci_lower_log, RAUD_ROWS)
    check(expected["ci"][1], lambda rows: run(rows).ci_upper_log, RAUD_ROWS)


@pytest.mark.parametrize("name,fit", [("reml", random_effects_reml), ("dl", random_effects_dl)])
def test_raudenbush_between_study_variance(name, fit):
    check(RAUDENBUSH["expected"][name]["tau2"], lambda rows: fit(study_effects(rows), "MD", "iq").tau_squared, RAUD_ROWS)


def test_raudenbush_cochran_q():
    check(RAUDENBUSH["expected"]["fixed"]["q"], lambda rows: fixed_effect(study_effects(rows), "MD", "iq").q_statistic, RAUD_ROWS)


@pytest.mark.parametrize("name,tau_estimator", [("hksj_dl", "DL"), ("hksj_reml", "REML")])
def test_raudenbush_hartung_knapp_interval(name, tau_estimator):
    expected = RAUDENBUSH["expected"][name]
    run = lambda rows: random_effects_hksj(study_effects(rows), "MD", "iq", tau_estimator=tau_estimator)  # noqa: E731
    assert run(RAUD_ROWS).tau_estimator == tau_estimator
    check(expected["ci"][0], lambda rows: run(rows).ci_lower_log, RAUD_ROWS)
    check(expected["ci"][1], lambda rows: run(rows).ci_upper_log, RAUD_ROWS)
    # The interval is estimate +/- t(.975, 18) * SE_HK; q > 1 here, so the floor at 1 is inactive and
    # metafor's unfloored test="knha" prints the same standard error.
    check(expected["se"], lambda rows: (run(rows).ci_upper_log - run(rows).ci_lower_log) / (2 * T_975_DF18), RAUD_ROWS)


def test_raudenbush_mixed_effects_meta_regression_on_weeks_of_prior_contact():
    expected = RAUDENBUSH["expected"]["meta_regression_weeks_capped_at_3"]
    run = lambda rows: meta_regression(study_effects(rows), [min(row["weeks"], 3) for row in RAUD_ROWS], "weeks")  # noqa: E731
    check(expected["tau2_residual"], lambda rows: run(rows).tau_squared_residual, RAUD_ROWS)
    check(expected["intercept"], lambda rows: run(rows).intercept, RAUD_ROWS)
    check(expected["slope"], lambda rows: run(rows).coefficient, RAUD_ROWS)
    check(expected["z"][0], lambda rows: run(rows).intercept / run(rows).intercept_se, RAUD_ROWS)
    check(expected["z"][1], lambda rows: run(rows).coefficient / run(rows).se, RAUD_ROWS)
    check(expected["q_residual"], lambda rows: run(rows).q_residual, RAUD_ROWS)


def test_raudenbush_failsafe_n_is_rosenthals_one_tailed_number():
    # Becker (2005) / metafor fsn(): 26 (Becker's own t-based p values give about 23).
    assert failsafe_n(study_effects(RAUD_ROWS)) == RAUDENBUSH["expected"]["failsafe_n_rosenthal"]


# -- Normand (1999), Tables VII-IX ----------------------------------------------------------------

NORMAND = CASES["normand1999_length_of_stay"]


@pytest.mark.parametrize("name,fit", [("fixed", fixed_effect), ("dl", random_effects_dl), ("reml", random_effects_reml)])
def test_normand_length_of_stay_pooling(name, fit):
    expected = NORMAND["expected"][name]
    run = lambda rows: fit(study_effects(rows), "MD", "days")  # noqa: E731
    check(expected["estimate"], lambda rows: run(rows).pooled_log, NORMAND["studies"])
    check(expected["ci"][0], lambda rows: run(rows).ci_lower_log, NORMAND["studies"])
    check(expected["ci"][1], lambda rows: run(rows).ci_upper_log, NORMAND["studies"])
    if "tau2" in expected:
        check(expected["tau2"], lambda rows: run(rows).tau_squared, NORMAND["studies"])


# -- Hine (1989) trials: no between-study variance -----------------------------------------------

HINE = CASES["hine1989_homogeneous_boundary"]


@pytest.mark.parametrize("fit", [fixed_effect, random_effects_dl, random_effects_reml])
def test_hine_homogeneous_trials_put_tau_squared_on_the_boundary_exactly(fit):
    run = lambda rows: fit(study_effects(rows), "RD", "pct")  # noqa: E731
    check(HINE["expected"]["estimate"], lambda rows: run(rows).pooled_log, HINE["studies"])
    check(HINE["expected"]["ci"][0], lambda rows: run(rows).ci_lower_log, HINE["studies"])
    check(HINE["expected"]["ci"][1], lambda rows: run(rows).ci_upper_log, HINE["studies"])
    # Exactly zero, not 5.7e-9: the old bounded minimiser stopped short of the boundary.
    assert run(HINE["studies"]).tau_squared == HINE["expected"]["tau2"]
    if fit is random_effects_reml:
        assert run(HINE["studies"]).tau_estimator == "REML"
        assert run(HINE["studies"]).tau_estimation_converged is True


# -- DerSimonian & Laird (2007), CLASP trials, log odds ratios ---------------------------------------

CLASP = CASES["clasp_derSimonian_laird2007"]


@pytest.mark.parametrize("name,fit", [("dl", random_effects_dl), ("reml", random_effects_reml)])
def test_clasp_trials_log_odds_ratio_pooling(name, fit):
    expected = CLASP["expected"][name]
    trials = CLASP["trials"]
    rows = [{"ai": a, "n1i": n1, "ci": c, "n2i": n2} for a, n1, c, n2 in zip(trials["ai"], trials["n1i"], trials["ci"], trials["n2i"])]
    result = fit(binary_effects(rows), "OR", "outcome")
    assert math.sqrt(result.tau_squared) == pytest.approx(expected["tau"], abs=HALF_UNIT)
    assert result.pooled_log == pytest.approx(expected["estimate"], abs=HALF_UNIT)
    assert se_of(result) == pytest.approx(expected["se"], abs=HALF_UNIT)


# -- Colditz et al. (1994) BCG trials against Stata's metan ---------------------------------------------

BCG = CASES["bcg_colditz1994_stata_metan"]
BCG_TRIALS = json.loads((ENGINE_ROOT / BCG["data"]).read_text(encoding="utf-8"))["studies"]


def bcg_effects(measure):
    out = []
    for row in BCG_TRIALS:
        a, b, c, d = row["tpos"], row["tneg"], row["cpos"], row["cneg"]
        yi, vi = {"RR": risk_ratio, "OR": odds_ratio, "RD": risk_difference}[measure](a, b, c, d)
        out.append(StudyEffect(study_id=str(row["trial"]), study_label=row["author"], yi=yi, vi=vi, se=math.sqrt(vi)))
    return out


def on_analysis_scale(result, measure):
    """Estimate and interval on the scale Stata printed: the log for ratios, the raw difference for RD."""
    if measure == "RD":
        return result.pooled_effect, (result.ci_lower, result.ci_upper)
    return result.pooled_log, (result.ci_lower_log, result.ci_upper_log)


@pytest.mark.parametrize("measure", ["RR", "OR", "RD"])
def test_bcg_fixed_effect_matches_metan(measure):
    expected = BCG["expected"][measure]["fixed"]
    result = fixed_effect(bcg_effects(measure), measure, "tb")
    estimate, interval = on_analysis_scale(result, measure)
    assert estimate == pytest.approx(expected["estimate"], abs=HALF_UNIT)
    assert interval == pytest.approx(expected["ci"], abs=HALF_UNIT)
    assert result.q_statistic == pytest.approx(expected["q"], abs=HALF_UNIT)
    assert estimate / ((interval[1] - interval[0]) / (2 * Z_975)) == pytest.approx(expected["z"], abs=HALF_UNIT * 20)  # Stata prints z to two decimals


@pytest.mark.parametrize("measure", ["RR", "OR", "RD"])
def test_bcg_dersimonian_laird_matches_metan(measure):
    expected = BCG["expected"][measure]["dl"]
    result = random_effects_dl(bcg_effects(measure), measure, "tb")
    estimate, interval = on_analysis_scale(result, measure)
    assert estimate == pytest.approx(expected["estimate"], abs=HALF_UNIT)
    assert interval == pytest.approx(expected["ci"], abs=HALF_UNIT)
    assert result.tau_squared == pytest.approx(expected["tau2"], abs=HALF_UNIT)
    assert result.i_squared == pytest.approx(expected["i2"], abs=HALF_UNIT)


def test_bcg_trim_and_fill_matches_metafors_documented_output():
    # Missing studies on the right (the excess is on the left), as in metafor's examples.
    for key, tau_estimator in (("trim_fill_fixed", "FIXED"), ("trim_fill_reml", "REML")):
        expected = BCG["expected"]["RR"][key]
        k0, estimate, lower, upper = trim_and_fill(bcg_effects("RR"), "RR", side="left", tau_estimator=tau_estimator)
        assert k0 == expected["k0"]
        assert math.log(estimate) == pytest.approx(expected["estimate"], abs=HALF_UNIT)
        assert (math.log(lower), math.log(upper)) == pytest.approx(expected["ci"], abs=HALF_UNIT)


# -- Egger et al. (2001) magnesium trials: small-study tests --------------------------------------------

MAGNESIUM = CASES["egger2001_magnesium"]


def test_magnesium_log_odds_ratios_include_the_zero_cell_trial_as_published():
    expected = MAGNESIUM["expected"]
    out = binary_effects(MAGNESIUM["trials"][:15])
    assert [item.yi for item in out[:5]] == pytest.approx(expected["log_or_first_five"], abs=1e-8)
    # Trial 8 has a zero cell: the correction goes on all four cells of that trial (-1.1917, not -0.7885).
    assert [item.yi for item in out[5:9]] == pytest.approx(expected["log_or_sixth_to_ninth"], abs=1e-8)


def test_magnesium_random_effects_fit_without_isis4():
    expected = MAGNESIUM["expected"]["reml_15"]
    result = random_effects_reml(binary_effects(MAGNESIUM["trials"][:15]), "OR", "death")
    assert result.pooled_log == pytest.approx(expected["estimate"], abs=HALF_UNIT)
    assert result.tau_squared == pytest.approx(expected["tau2"], abs=HALF_UNIT)
    assert result.q_statistic == pytest.approx(expected["q"], abs=HALF_UNIT)


def test_magnesium_classical_egger_test_equals_metafors_lm_regtest():
    expected = MAGNESIUM["expected"]["egger_15"]
    fit = egger_regression(binary_effects(MAGNESIUM["trials"][:15]))
    assert fit["t"] == pytest.approx(expected["t"], abs=HALF_UNIT)
    assert fit["df"] == expected["df"]
    assert fit["p"] == pytest.approx(expected["p"], abs=HALF_UNIT)
    # The slope of the regression of the standardized effect on precision is the bias-corrected effect.
    assert fit["slope"] == pytest.approx(expected["limit_estimate"], abs=HALF_UNIT)


def test_magnesium_begg_rank_correlation_uses_standardized_effects():
    expected = MAGNESIUM["expected"]["begg_16"]
    tau, p = begg_test(binary_effects(MAGNESIUM["trials"]))
    assert tau == pytest.approx(expected["tau"], abs=HALF_UNIT)
    assert p == pytest.approx(expected["p"], abs=HALF_UNIT)


# -- Hedges' g against metafor's documented escalc() output -----------------------------------------------

SMD = CASES["normand1999_standardized_mean_difference"]


def test_hedges_g_and_its_variance_match_metafor_for_the_normand_trials():
    for trial, g, vi in zip(SMD["trials"], SMD["expected"]["g"], SMD["expected"]["vi"]):
        got_g, got_vi = standardized_mean_difference(trial["m1i"], trial["sd1i"], trial["n1i"], trial["m2i"], trial["sd2i"], trial["n2i"])
        assert got_g == pytest.approx(g, abs=HALF_UNIT)
        assert got_vi == pytest.approx(vi, abs=HALF_UNIT)
