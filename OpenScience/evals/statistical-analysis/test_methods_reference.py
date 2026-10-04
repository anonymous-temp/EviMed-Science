"""Reference cases and data-shape checks for capabilities/statistical-analysis/scripts/analysis_methods.py (N05).

Each method is run on a published dataset and compared with the numbers its source prints (or, where a
source prints only a few digits, with R 4.3.3's documented output for the same data); the expected values
are never produced by this module. The second half gives each method the kind of data that breaks a
careless analysis (missing values, repeated measurements, censoring, many comparisons, an unbalanced
comparison, zero cells, separation) and asks for the named diagnostic or the named refusal.

Run with the interpreter the runtime image uses (numpy 2.2.6, scipy 1.15.3, pandas 2.2.3, statsmodels 0.14.6):

    python3 -m pytest -q OpenScience/evals/statistical-analysis/test_methods_reference.py
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parents[1] / "capabilities" / "statistical-analysis" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import analysis_methods as am  # noqa: E402

LUNG = pd.read_csv(HERE / "fixtures" / "lung.csv")
LUNG_EVENT = (LUNG["status"] == 2).astype(int)


def codes(entry):
    return {item["code"] for item in entry["diagnostics"]}


def severity(entry, code):
    return next(item["severity"] for item in entry["diagnostics"] if item["code"] == code)


# -- the records and what a result says about itself -------------------------------------------------------------

METHODS = ["compare_groups", "covariate_balance", "contingency_test", "linear_regression", "logistic_regression",
           "kaplan_meier", "log_rank", "cox_regression", "adjust_pvalues"]


def scalars(value):
    if isinstance(value, dict):
        for item in value.values():
            yield from scalars(item)
    elif isinstance(value, list):
        for item in value:
            yield from scalars(item)
    else:
        yield value


@pytest.mark.parametrize("method", METHODS)
def test_every_method_has_a_record_in_the_shape_of_the_calculators(method):
    record = am.method_records()[method]
    assert record["id"] == method and re.fullmatch(r"\d+\.\d+\.\d+", record["version"])
    for field in ("title", "estimand", "assumptions", "inputs", "refusals", "dependencies", "references"):
        assert record[field], (method, field)
    assert record["seeded"] is False
    named = {item["code"] for item in record["refusals"]} | {item["code"] for item in record["diagnostics"]}
    for assumption in record["assumptions"]:
        for check in (part.strip() for part in assumption["checkedBy"].split(",")):
            if check != "none":
                assert check.split(":", 1)[1] in named, (method, assumption["id"], check)
    for reference in record["references"]:
        assert reference["kind"] in {"published", "other-implementation", "analytic"}
        assert (SCRIPTS.parents[2] / reference["test"].replace("OpenScience/", "", 1)).is_file(), reference["test"]
    # Strings, integers and booleans only, as in the domain's records: the digest is the same in every language.
    assert all(type(item) in (str, int, bool) for item in scalars(record)), method
    # The dependencies a record names are the libraries the result will report.
    assert set(record["dependencies"]) <= set(am.environment()["packages"])


def test_a_result_names_its_record_its_module_no_seed_and_the_libraries_it_ran_on():
    entry = am.adjust_pvalues([0.01, 0.02])
    identity = entry["methodRecord"]
    record = am.method_records()["adjust_pvalues"]
    assert identity == {"id": "adjust_pvalues", "version": record["version"], "codeSha256": hashlib.sha256((SCRIPTS / "analysis_methods.py").read_bytes()).hexdigest(),
                        "digest": hashlib.sha256(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()}
    assert entry["seeded"] is False and entry["seed"] is None
    for name in ("numpy", "scipy", "pandas", "statsmodels"):
        assert entry["environment"]["packages"][name] == importlib.metadata.version(name)
    assert entry["environment"]["python"] and entry["method"] == "adjust_pvalues"


def test_the_records_ship_beside_the_module_in_both_skill_trees():
    for tree in ("capabilities", "capability-skills"):
        directory = SCRIPTS.parents[2] / tree / "statistical-analysis" / "scripts"
        for name in ("analysis_methods.py", "analysis_method_records.json"):
            assert (directory / name).read_bytes() == (SCRIPTS / name).read_bytes(), f"{tree}/{name} drifted"


# -- two groups: Student (1908) sleep data as R's ?t.test prints them ------------------------------------------------

SLEEP_1 = [0.7, -1.6, -0.2, -1.2, -0.1, 3.4, 3.7, 0.8, 0.0, 2.0]
SLEEP_2 = [1.9, 0.8, 1.1, 0.1, -0.1, 4.4, 5.5, 1.6, 4.6, 3.4]


def sleep_frame():
    return pd.DataFrame({"extra": SLEEP_1 + SLEEP_2, "group": ["1"] * 10 + ["2"] * 10, "subject": list(range(10)) * 2})


def test_welch_comparison_matches_the_printed_t_test():
    frame = sleep_frame()
    entry = am.compare_groups(frame["extra"], frame["group"], contrast=("1", "2"))
    assert entry["status"] == "complete"
    assert entry["values"]["t"] == pytest.approx(-1.8608, abs=5e-5)
    assert entry["values"]["df"] == pytest.approx(17.776, abs=5e-4)
    assert entry["pValue"] == pytest.approx(0.07939, abs=5e-6)
    assert entry["estimate"] == pytest.approx(-1.58, abs=1e-12)  # mean(1) - mean(2) = 0.75 - 2.33
    assert (entry["interval"]["lower"], entry["interval"]["upper"]) == pytest.approx((-3.3655, 0.2055), abs=5e-5)
    assert entry["estimand"] == "mean(1) - mean(2) of the outcome"
    assert entry["n"] == {"1": 10, "2": 10}


def test_the_direction_of_a_difference_is_named_or_inferred_and_said_so():
    frame = sleep_frame()
    named = am.compare_groups(frame["extra"], frame["group"], contrast=("2", "1"))
    assert named["estimate"] == pytest.approx(1.58, abs=1e-12) and "contrast_direction_inferred" not in codes(named)
    inferred = am.compare_groups(frame["extra"], frame["group"])
    assert inferred["estimate"] == pytest.approx(-1.58, abs=1e-12) and "contrast_direction_inferred" in codes(inferred)
    # A reversed target coding is the incident this guards: the same data, labels 0/1 swapped, gives the opposite sign.
    swapped = am.compare_groups(frame["extra"], frame["group"].map({"1": "2", "2": "1"}), contrast=("1", "2"))
    assert swapped["estimate"] == pytest.approx(1.58, abs=1e-12)


def test_paired_comparison_uses_the_pairs_not_the_groups():
    frame = sleep_frame()
    entry = am.compare_groups(frame["extra"], frame["group"], contrast=("1", "2"), test="paired", subject=frame["subject"])
    assert entry["values"]["t"] == pytest.approx(-4.0621, abs=5e-5)
    assert entry["values"]["df"] == 9
    assert entry["pValue"] == pytest.approx(0.002833, abs=5e-7)
    assert (entry["interval"]["lower"], entry["interval"]["upper"]) == pytest.approx((-2.4599, -0.7001), abs=5e-5)
    assert entry["n"]["pairs"] == 10


def test_mann_whitney_matches_the_printed_wilcoxon():
    frame = sleep_frame()
    entry = am.compare_groups(frame["extra"], frame["group"], contrast=("1", "2"), test="mann_whitney")
    assert entry["values"]["U"] == 25.5
    assert entry["pValue"] == pytest.approx(0.06933, abs=5e-6)
    assert entry["interval"] is None and "mean_difference_is_descriptive" in codes(entry)


def test_student_t_uses_the_pooled_variance():
    frame = sleep_frame()
    entry = am.compare_groups(frame["extra"], frame["group"], contrast=("1", "2"), test="student")
    assert entry["values"]["df"] == 18 and entry["values"]["t"] == pytest.approx(-1.8608, abs=5e-5)  # equal n: the same t as Welch
    pooled = math.sqrt((np.var(SLEEP_1, ddof=1) + np.var(SLEEP_2, ddof=1)) / 2)
    df = 18
    correction = math.exp(math.lgamma(df / 2) - 0.5 * math.log(df / 2) - math.lgamma((df - 1) / 2))
    assert entry["values"]["hedgesG"] == pytest.approx(-1.58 / pooled * correction, rel=1e-12)


# -- contingency tables ------------------------------------------------------------------------------------------------

def test_fishers_tea_tasting_table_matches_the_printed_exact_test():
    entry = am.contingency_test([[3, 1], [1, 3]])
    assert entry["values"]["fisherP"] == pytest.approx(34 / 70, abs=1e-12)  # (1 + 16 + 16 + 1) / 70, by hand
    assert entry["values"]["conditionalOddsRatio"] == pytest.approx(6.408309, rel=1e-5)  # R's fisher.test
    assert entry["values"]["primaryTest"] == "fisher_exact" and entry["pValue"] == pytest.approx(34 / 70, abs=1e-12)
    assert "expected_count_below_5" in codes(entry) and "small_total" in codes(entry)


def test_the_physicians_health_study_table_matches_the_printed_statistics():
    entry = am.contingency_test([[189, 10845], [104, 10933]])
    assert entry["values"]["pearsonChi2"] == pytest.approx(25.014, abs=5e-4)  # Agresti prints 25.01; R 25.014
    assert entry["values"]["yatesChi2"] == pytest.approx(24.429, abs=5e-4)  # R chisq.test
    assert entry["estimate"] == pytest.approx(1.832, abs=5e-4)
    assert (entry["interval"]["lower"], entry["interval"]["upper"]) == pytest.approx((1.440, 2.331), abs=5e-4)
    assert entry["values"]["riskRatio"] == pytest.approx(1.8178, abs=5e-5)
    assert entry["values"]["riskDifference"] == pytest.approx(189 / 11034 - 104 / 11037, abs=1e-15)
    assert codes(entry) == set() and entry["values"]["primaryTest"] == "pearson"


def test_a_larger_table_gets_pearsons_chi_square_and_no_invented_effect_size():
    entry = am.contingency_test([[762, 327, 468], [484, 239, 477]])  # Agresti: party identification by gender
    assert entry["values"]["pearsonChi2"] == pytest.approx(30.1, abs=0.05) and entry["values"]["pearsonDf"] == 2
    assert entry["values"]["cramersV"] == pytest.approx(math.sqrt(entry["values"]["pearsonChi2"] / 2757), rel=1e-12)
    assert "oddsRatio" not in entry["values"]


def test_a_table_with_a_zero_cell_is_given_no_ratio_unless_a_correction_is_asked_for_and_said():
    zero = [[0, 20], [3, 17]]
    refused = am.contingency_test(zero)
    assert refused["status"] == "partial" and refused["reason"] == "zero_cell_ratio_not_estimable"
    assert refused["estimate"] is None and refused["values"]["oddsRatio"] is None and refused["values"]["riskRatio"] is None
    assert "zero_cell_ratio_not_estimable" in refused["warnings"]
    assert refused["values"]["fisherP"] == pytest.approx(0.2308, abs=5e-5)  # the exact test needs no ratio (hypergeometric, by hand: 0.1220 + 0.1088)
    corrected = am.contingency_test(zero, correct_zero_cells=True)
    assert corrected["status"] == "complete" and "zero_cell_corrected" in codes(corrected)
    assert corrected["estimate"] == pytest.approx((0.5 * 17.5) / (20.5 * 3.5), rel=1e-12)


@pytest.mark.parametrize("table,code", [([[1, 2], [3, "x"]], "invalid_counts"), ([[1, -2], [3, 4]], "invalid_counts"), ([[1.5, 2], [3, 4]], "invalid_counts"),
                                         ([[1, 2, 3]], "invalid_counts"), ([[0, 0], [3, 4]], "empty_margin"), ([[0, 3], [0, 4]], "empty_margin")])
def test_a_table_that_is_not_a_table_of_counts_is_declined_under_its_name(table, code):
    entry = am.contingency_test(table)
    assert entry["status"] == "unsupported" and entry["reason"] == code and entry["estimate"] is None and entry["pValue"] is None


# -- linear regression: NIST StRD Longley, certified to 15 digits ------------------------------------------------------------

LONGLEY = np.array([
    [60323, 83.0, 234289, 2356, 1590, 107608, 1947], [61122, 88.5, 259426, 2325, 1456, 108632, 1948], [60171, 88.2, 258054, 3682, 1616, 109773, 1949],
    [61187, 89.5, 284599, 3351, 1650, 110929, 1950], [63221, 96.2, 328975, 2099, 3099, 112075, 1951], [63639, 98.1, 346999, 1932, 3594, 113270, 1952],
    [64989, 99.0, 365385, 1870, 3547, 115094, 1953], [63761, 100.0, 363112, 3578, 3350, 116219, 1954], [66019, 101.2, 397469, 2904, 3048, 117388, 1955],
    [67857, 104.6, 419180, 2822, 2857, 118734, 1956], [68169, 108.4, 442769, 2936, 2798, 120445, 1957], [66513, 110.8, 444546, 4681, 2637, 121950, 1958],
    [68655, 112.6, 482704, 3813, 2552, 123366, 1959], [69564, 114.2, 502601, 3931, 2514, 125368, 1960], [69331, 115.7, 518173, 4806, 2572, 127852, 1961],
    [70551, 116.9, 554894, 4007, 2827, 130081, 1962]])
LONGLEY_CERTIFIED = [(-3482258.63459582, 890420.383607373), (15.0618722713733, 84.9149257747669), (-0.358191792925910e-01, 0.334910077722432e-01),
                     (-2.02022980381683, 0.488399681651699), (-1.03322686717359, 0.214274163161675), (-0.511041056535807e-01, 0.226073200069370),
                     (1829.15146461355, 455.478499142212)]


def test_longley_matches_the_nist_certified_values():
    entry = am.linear_regression(LONGLEY[:, 0], LONGLEY[:, 1:], names=["x1", "x2", "x3", "x4", "x5", "x6"])
    assert entry["status"] == "complete"
    table = entry["values"]["coefficients"]
    for row, (estimate, se) in zip(table, LONGLEY_CERTIFIED):
        assert row["estimate"] == pytest.approx(estimate, rel=1e-9), row["name"]
        assert row["se"] == pytest.approx(se, rel=1e-9), row["name"]
    assert entry["values"]["residualStandardError"] == pytest.approx(304.854073561965, rel=1e-9)
    assert entry["values"]["rSquared"] == pytest.approx(0.995479004577296, rel=1e-12)
    assert entry["values"]["fStatistic"] == pytest.approx(330.285339234588, rel=1e-9)
    assert entry["values"]["residualDf"] == 9
    # Longley is the textbook case of near-collinearity and the diagnostics say so, while the fit stands.
    assert "high_collinearity" in codes(entry) and "few_observations_per_parameter" in codes(entry)
    t = table[1]["estimate"] / table[1]["se"]
    assert table[1]["pValue"] == pytest.approx(2 * __import__("scipy").stats.t.sf(abs(t), 9), rel=1e-12)


def test_collinear_predictors_and_too_few_observations_are_declined_not_fitted():
    x = np.arange(10, dtype=float)
    perfect = am.linear_regression(x * 2 + 1, np.column_stack([x, 3 * x]), names=["a", "b"])
    assert perfect["status"] == "unsupported" and perfect["reason"] == "collinear_predictors" and perfect["estimate"] is None
    few = am.linear_regression([1, 2, 3], np.array([[1, 2], [2, 1], [3, 5]]), names=["a", "b"])
    assert few["status"] == "unsupported" and few["reason"] == "too_few_observations"
    one_row_each = am.linear_regression([1.0, 2.0, 4.0, 3.0], [1, 2, 3, 4])
    assert one_row_each["status"] == "complete"


def test_missing_rows_are_counted_and_the_fit_uses_the_complete_ones():
    x = np.arange(12, dtype=float)
    y = 2 * x + np.array([0.3, -0.2, 0.1, 0.4, -0.3, 0.2, -0.1, 0.0, 0.3, -0.4, 0.2, -0.1])
    y_missing = y.copy(); y_missing[3] = np.nan
    entry = am.linear_regression(y_missing, x)
    assert entry["n"]["observations"] == 11
    assert next(item for item in entry["diagnostics"] if item["code"] == "missing_values_dropped")["detail"] == {"rowsDropped": 1, "rowsKept": 11, "rowsRead": 12}
    complete = am.linear_regression(np.delete(y, 3), np.delete(x, 3))
    assert entry["estimate"] == pytest.approx(complete["estimate"], rel=1e-12)


def test_repeated_measurements_get_cluster_robust_errors_unless_independence_is_insisted_on():
    import statsmodels.api as sm
    rng = np.random.default_rng(7)
    subjects = np.repeat(np.arange(20), 4)
    shift = np.repeat(rng.normal(0, 2, 20), 4)  # a persistent per-person level: rows of one person are not independent
    x = rng.normal(size=80)
    y = 1.5 * x + shift + rng.normal(0, .5, 80)
    robust = am.linear_regression(y, x, subject=subjects)
    assert "cluster_robust_se_used" in codes(robust) and robust["n"]["clusters"] == 20
    reference = sm.OLS(y, sm.add_constant(x)).fit(cov_type="cluster", cov_kwds={"groups": subjects})
    assert robust["values"]["coefficients"][1]["se"] == pytest.approx(reference.bse[1], rel=1e-10)
    independent = am.linear_regression(y, x, subject=subjects, treat_rows_as_independent=True)
    assert "repeated_measurements_ignored" in independent["warnings"]
    assert independent["values"]["coefficients"][1]["se"] == pytest.approx(sm.OLS(y, sm.add_constant(x)).fit().bse[1], rel=1e-10)
    # What the label guards: with persistent person-level shifts the independent-rows standard error of the person-level
    # intercept is not the cluster-robust one.
    assert robust["values"]["coefficients"][0]["se"] != pytest.approx(independent["values"]["coefficients"][0]["se"], rel=0.05)


# -- logistic regression ----------------------------------------------------------------------------------------------------

def snoring():
    rows = []
    for score, (yes, no) in zip((0, 2, 4, 5), ((24, 1355), (35, 603), (21, 192), (30, 224))):
        rows += [(score, 1)] * yes + [(score, 0)] * no
    return pd.DataFrame(rows, columns=["snoring", "heart_disease"])


def test_the_snoring_and_heart_disease_fit_matches_agresti():
    data = snoring()
    entry = am.logistic_regression(data["heart_disease"], data[["snoring"]])
    const, slope = entry["values"]["coefficients"]
    assert (const["estimate"], slope["estimate"]) == pytest.approx((-3.866, 0.397), abs=5e-4)
    assert (const["se"], slope["se"]) == pytest.approx((0.166, 0.050), abs=5e-4)
    assert slope["oddsRatio"] == pytest.approx(math.exp(0.39733662), rel=1e-6)
    assert entry["n"]["observations"] == 2484 and entry["n"]["events"] == 110
    assert entry["values"]["likelihoodRatioChi2"] > 0 and codes(entry) == set()


def test_logistic_regression_on_the_lung_data_matches_rs_glm():
    complete = LUNG.dropna(subset=["age", "sex", "status"])
    entry = am.logistic_regression((complete["status"] == 2).astype(int), complete[["age", "sex"]])
    const, age, sex = entry["values"]["coefficients"]
    assert (const["estimate"], age["estimate"], sex["estimate"]) == pytest.approx((0.5150680756053, 0.0318883552759, -1.0483878500805), rel=1e-6)
    assert (const["se"], age["se"], sex["se"]) == pytest.approx((1.1742153803069, 0.0170111393533, 0.3084449996753), rel=1e-6)
    assert (age["pValue"], sex["pValue"]) == pytest.approx((0.06085365363845, 0.00067646109185), rel=1e-5)
    assert entry["values"]["logLikelihood"] == pytest.approx(-125.964828369, rel=1e-9)


def test_perfect_and_quasi_perfect_separation_are_declined_not_reported_as_a_coefficient():
    x = np.arange(20, dtype=float)
    complete = am.logistic_regression((x > 9.5).astype(int), x)
    assert complete["status"] == "unsupported" and complete["reason"] == "separation" and complete["estimate"] is None
    # Quasi-complete: the groups overlap only at x = 10, where both outcomes occur.
    y = np.array([0] * 10 + [1, 0] + [1] * 8)
    quasi = am.logistic_regression(y, np.array([*range(10), 10, 10, *range(11, 19)], dtype=float))
    assert quasi["status"] == "unsupported" and quasi["reason"] == "separation"
    overlapping = am.logistic_regression(np.array([0, 0, 1, 0, 1, 1, 0, 1]), np.array([1, 2, 3, 3.5, 4, 5, 5.5, 6.0]))
    assert overlapping["status"] == "complete"


def test_a_binary_outcome_with_one_value_or_another_coding_is_declined():
    assert am.logistic_regression([1, 1, 1, 1], [1, 2, 3, 4])["reason"] == "outcome_has_one_value"
    assert am.logistic_regression([0, 1, 2, 1], [1, 2, 3, 4])["reason"] == "outcome_not_binary"
    assert am.logistic_regression([0, 1, 0, 1, 1], np.array([[1, 2], [2, 4], [3, 6], [4, 8], [5, 10]]), names=["a", "b"])["reason"] == "collinear_predictors"


def test_few_events_per_variable_is_a_warning_and_the_fit_still_stands():
    rng = np.random.default_rng(3)
    X = rng.normal(size=(40, 4))
    y = np.zeros(40, dtype=int); y[[1, 7, 13, 21, 30]] = 1
    entry = am.logistic_regression(y, X, names=list("abcd"))
    if entry["status"] == "complete":
        assert "few_events_per_variable" in entry["warnings"]
    else:
        assert entry["reason"] == "separation"


# -- Kaplan-Meier and the log-rank test -----------------------------------------------------------------------------------

AML = pd.DataFrame({
    "time": [9, 13, 13, 18, 23, 28, 31, 34, 45, 48, 161, 5, 5, 8, 8, 12, 16, 23, 27, 30, 33, 43, 45],
    "status": [1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1],
    "x": ["Maintained"] * 11 + ["Nonmaintained"] * 12})


def test_aml_medians_match_the_survival_package():
    entry = am.kaplan_meier(AML["time"], AML["status"], AML["x"])
    maintained, nonmaintained = entry["values"]["curves"]["Maintained"], entry["values"]["curves"]["Nonmaintained"]
    assert (maintained["median"], maintained["medianLower"], maintained["medianUpper"]) == (31.0, 18.0, None)
    assert (nonmaintained["median"], nonmaintained["medianLower"], nonmaintained["medianUpper"]) == (23.0, 8.0, None)
    assert (maintained["n"], maintained["events"], nonmaintained["n"], nonmaintained["events"]) == (11, 7, 12, 11)
    # Miller (1981): the maintained curve falls 1, .909, .818, .716 ... at 9, 13, 18.
    assert [round(row["survival"], 3) for row in maintained["table"][:3]] == [0.909, 0.818, 0.716]
    assert "tied_event_times" in codes(entry)


def test_aml_log_rank_matches_survdiff():
    entry = am.log_rank(AML["time"], AML["status"], AML["x"])
    assert entry["values"]["chiSquare"] == pytest.approx(3.39638869898, rel=1e-9)  # R: 3.4 on 1 df, p = 0.0653
    assert entry["pValue"] == pytest.approx(0.0653, abs=5e-5) and entry["values"]["df"] == 1
    assert [row["observed"] for row in entry["values"]["groups"]] == [7, 11]
    assert entry["values"]["groups"][0]["expected"] == pytest.approx(10.689, abs=5e-4)


def test_lung_median_and_curve_match_the_survival_package():
    entry = am.kaplan_meier(LUNG["time"], LUNG_EVENT)
    curve = entry["values"]["curves"]["all"]
    assert (curve["median"], curve["medianLower"], curve["medianUpper"]) == (310.0, 285.0, 363.0)
    assert (curve["n"], curve["events"]) == (228, 165)
    at = {row["time"]: row for row in curve["table"]}
    # R: summary(survfit(Surv(time, status == 2) ~ 1, lung), times = 100) has surv 0.863968967645, std.err 0.0227102304342, lower 0.820584892081.
    # 100 is not an event time: the curve's value at 100 is the last event time at or before it.
    last = max(time for time in at if time <= 100)
    assert at[last]["survival"] == pytest.approx(0.863968967645, abs=1e-12)
    assert at[last]["se"] == pytest.approx(0.0227102304342, abs=1e-12)
    assert at[last]["lower"] == pytest.approx(0.820584892081, abs=1e-12)


def test_lung_log_rank_by_sex_matches_survdiff():
    entry = am.log_rank(LUNG["time"], LUNG_EVENT, LUNG["sex"])
    assert entry["values"]["chiSquare"] == pytest.approx(10.3267419549, rel=1e-9)
    assert entry["pValue"] == pytest.approx(0.00131, abs=5e-6)
    groups = entry["values"]["groups"]
    assert [row["observed"] for row in groups] == [112, 53]
    assert [row["expected"] for row in groups] == pytest.approx([91.5817390296, 73.4182609704], rel=1e-9)


def test_the_log_rank_test_is_stratified_when_asked():
    stratified = am.log_rank(LUNG["time"], LUNG_EVENT, LUNG["sex"], strata=pd.cut(LUNG["age"].fillna(LUNG["age"].median()), [0, 60, 70, 100]).astype(str))
    plain = am.log_rank(LUNG["time"], LUNG_EVENT, LUNG["sex"])
    assert stratified["values"]["stratified"] is True
    assert stratified["values"]["chiSquare"] != pytest.approx(plain["values"]["chiSquare"], rel=1e-3)


@pytest.mark.parametrize("conf_type", ["log", "log-log", "plain"])
def test_confidence_bands_are_the_three_survfit_types(conf_type):
    entry = am.kaplan_meier(AML["time"][:11], AML["status"][:11], conf_type=conf_type)
    row = entry["values"]["curves"]["all"]["table"][1]  # t = 13: S = 0.818, 2 deaths in 11 -> 9 at risk after the first
    survival, greenwood = row["survival"], 1 / (11 * 10) + 1 / (10 * 9)
    z = 1.959963984540054
    if conf_type == "log":
        assert (row["lower"], row["upper"]) == pytest.approx((survival * math.exp(-z * math.sqrt(greenwood)), min(1, survival * math.exp(z * math.sqrt(greenwood)))), rel=1e-12)
    elif conf_type == "plain":
        assert (row["lower"], row["upper"]) == pytest.approx((survival - z * survival * math.sqrt(greenwood), min(1, survival + z * survival * math.sqrt(greenwood))), rel=1e-12)
    else:
        se = math.sqrt(greenwood) / abs(math.log(survival))
        assert (row["lower"], row["upper"]) == pytest.approx((survival ** math.exp(z * se), survival ** math.exp(-z * se)), rel=1e-12)


def test_censoring_is_read_as_censoring_and_an_unknown_event_coding_is_declined():
    # The aml data with the censored rows read as events is a different curve: the helper does not guess the coding.
    coded = AML.assign(status=AML["status"].replace({0: 2}))
    refused = am.kaplan_meier(coded["time"], coded["status"], coded["x"])
    assert refused["status"] == "unsupported" and refused["reason"] == "event_not_binary" and refused["estimate"] is None
    assert am.log_rank(coded["time"], coded["status"], coded["x"])["reason"] == "event_not_binary"
    assert am.cox_regression(coded["time"], coded["status"], coded[["time"]])["reason"] == "event_not_binary"
    everything_an_event = am.kaplan_meier(AML["time"], np.ones(len(AML)), AML["x"])
    right = am.kaplan_meier(AML["time"], AML["status"], AML["x"])
    assert everything_an_event["values"]["curves"]["Maintained"]["median"] != right["values"]["curves"]["Maintained"]["median"]
    assert am.kaplan_meier([5, -1, 3], [1, 0, 1])["reason"] == "negative_time"
    assert am.kaplan_meier([np.nan], [1])["reason"] == "no_complete_rows"


def test_censoring_diagnostics_name_what_the_follow_up_looks_like():
    heavy = am.kaplan_meier([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])
    assert {"heavy_censoring", "few_events"} <= codes(heavy)
    never = am.kaplan_meier([1, 2, 3, 4], [0, 0, 0, 0])
    assert never["status"] == "partial" and never["reason"] == "median_not_reached" and "no_events_in_group" in codes(never)
    assert am.log_rank([1, 2, 3, 4], [0, 0, 0, 0], ["a", "a", "b", "b"])["reason"] == "no_events"
    assert am.log_rank([1, 2, 3, 4], [1, 1, 1, 1], ["a", "a", "a", "a"])["reason"] == "one_group"
    assert am.log_rank([1, 1], [1, 1], ["a", "b"])["reason"] == "singular_variance"
    # A group with no events is not a refusal: the test is defined (R's survdiff gives chi-square 2.9 here).
    one_sided = am.log_rank([1, 2, 3, 4], [1, 1, 0, 0], ["a", "a", "b", "b"])
    assert one_sided["status"] == "complete" and one_sided["values"]["chiSquare"] == pytest.approx(2.882352941176471, rel=1e-12)


# -- Cox regression -----------------------------------------------------------------------------------------------------------

def test_cox_on_the_lung_data_matches_the_documented_coxph():
    complete = LUNG.dropna(subset=["age", "sex", "time", "status"])
    entry = am.cox_regression(complete["time"], (complete["status"] == 2).astype(int), complete[["age", "sex"]])
    age, sex = entry["values"]["coefficients"]
    # survival::coxph(Surv(time, status) ~ age + sex, lung), as printed.
    # Printed to six decimals (coefficient, SE), three (z) and five (p): half a unit of the last printed digit.
    assert (age["estimate"], age["se"]) == pytest.approx((0.017045, 0.009223), abs=5e-7 * 10)  # coef 6 d.p., se 6 d.p. (se printed 0.009223)
    assert (age["statistic"], age["pValue"]) == pytest.approx((1.848, 0.06459), abs=5e-4)
    assert (sex["estimate"], sex["se"]) == pytest.approx((-0.513219, 0.167458), abs=5e-7 * 10)
    assert (sex["statistic"], sex["pValue"]) == pytest.approx((-3.065, 0.00218), abs=5e-4)
    assert age["hazardRatio"] == pytest.approx(1.017191, abs=5e-6) and sex["hazardRatio"] == pytest.approx(0.598566, abs=5e-6)
    assert (sex["hazardRatioLower"], sex["hazardRatioUpper"]) == pytest.approx((0.4311, 0.8311), abs=5e-5)
    assert entry["values"]["likelihoodRatioChi2"] == pytest.approx(14.1231112132, rel=1e-9) and entry["values"]["likelihoodRatioP"] == pytest.approx(9e-4, abs=5e-5)
    assert entry["n"]["events"] == 165 and entry["n"]["rows"] == 228 and entry["values"]["ties"] == "efron"
    # R at full precision.
    assert (age["estimate"], sex["estimate"]) == pytest.approx((0.0170453318454, -0.5132185171084), rel=1e-7)
    assert (age["se"], sex["se"]) == pytest.approx((0.00922327347697, 0.16745796235577), rel=1e-6)


def test_breslow_ties_give_rs_breslow_coefficients():
    entry = am.cox_regression(LUNG["time"], LUNG_EVENT, LUNG[["age", "sex"]], ties="breslow")
    assert [row["estimate"] for row in entry["values"]["coefficients"]] == pytest.approx([0.0170128891984, -0.5125647915187], rel=1e-7)
    assert [row["se"] for row in entry["values"]["coefficients"]] == pytest.approx([0.0092219536849, 0.1674620631424], rel=1e-6)


def test_the_proportional_hazards_test_matches_cox_zph():
    entry = am.cox_regression(LUNG["time"], LUNG_EVENT, LUNG[["age", "sex"]])
    age, sex, overall = entry["values"]["proportionalHazards"]
    # R 4.3.3 survival 3.5-8: cox.zph(coxph(Surv(time, status == 2) ~ age + sex, lung)) with the default transform "km".
    assert (age["chiSquare"], sex["chiSquare"], overall["chiSquare"]) == pytest.approx((0.209202826364, 2.607671703537, 2.770785375938), rel=1e-6)
    assert (age["pValue"], sex["pValue"], overall["pValue"]) == pytest.approx((0.647392939198, 0.106347797928, 0.250225519945), rel=1e-6)
    assert [row["name"] for row in entry["values"]["proportionalHazards"]] == ["age", "sex", "GLOBAL"] and overall["df"] == 2
    assert "proportional_hazards_questioned" not in codes(entry)
    breslow = am.cox_regression(LUNG["time"], LUNG_EVENT, LUNG[["age", "sex"]], ties="breslow")
    assert [row["chiSquare"] for row in breslow["values"]["proportionalHazards"]] == pytest.approx([0.207956689885, 2.599452688876, 2.760990772355], rel=1e-6)


def test_a_covariate_that_breaks_proportional_hazards_is_questioned():
    rng = np.random.default_rng(11)
    n = 400
    group = rng.integers(0, 2, n)
    # Hazard ratio 0.3 early, 3 late: crossing curves, the case a single hazard ratio misdescribes.
    early = rng.exponential(1 / np.where(group == 1, 0.3, 1.0))
    late = 1.5 + rng.exponential(1 / np.where(group == 1, 3.0, 1.0))
    time = np.where(early < 1.5, early, late)
    entry = am.cox_regression(time, np.ones(n, dtype=int), pd.DataFrame({"group": group}))
    assert "proportional_hazards_questioned" in entry["warnings"]


def test_cox_declines_what_the_data_cannot_identify_and_keeps_going():
    time = np.array([5, 8, 12, 3, 9, 15, 20, 7, 11, 4], dtype=float)
    event = np.array([1, 1, 0, 1, 1, 0, 1, 1, 0, 1])
    # The covariate marks only subjects with no event: an infinite hazard ratio, not a large one.
    no_events = am.cox_regression(time, event, pd.DataFrame({"treated": (event == 0).astype(int) * 1}))
    assert no_events["status"] == "unsupported" and no_events["reason"] == "no_events_in_a_level" and no_events["estimate"] is None
    many = am.cox_regression(time, event, pd.DataFrame(np.random.default_rng(1).normal(size=(10, 7)), columns=list("abcdefg")))
    assert many["reason"] == "more_covariates_than_events"
    x = np.arange(10, dtype=float)
    assert am.cox_regression(time, event, np.column_stack([x, 2 * x]), names=["a", "b"])["reason"] == "collinear_covariates"
    assert am.cox_regression(time, np.zeros(10, dtype=int), x)["reason"] == "no_events"
    ok = am.cox_regression(time, event, x)
    assert ok["status"] == "complete" and {"few_events", "few_events_per_variable"} <= set(ok["warnings"])


def test_clustered_subjects_get_robust_errors_and_the_assumption_test_is_not_claimed():
    complete = LUNG.dropna(subset=["age", "sex", "inst"])
    entry = am.cox_regression(complete["time"], (complete["status"] == 2).astype(int), complete[["age", "sex"]], cluster=complete["inst"])
    assert "cluster_robust_se_used" in codes(entry) and "proportional_hazards_not_tested" in codes(entry)
    assert "proportionalHazards" not in entry["values"]
    plain = am.cox_regression(complete["time"], (complete["status"] == 2).astype(int), complete[["age", "sex"]])
    assert entry["values"]["coefficients"][0]["estimate"] == pytest.approx(plain["values"]["coefficients"][0]["estimate"], rel=1e-12)
    assert entry["values"]["coefficients"][0]["se"] != pytest.approx(plain["values"]["coefficients"][0]["se"], rel=1e-3)


# -- many tests and unbalanced comparisons -------------------------------------------------------------------------------------

BH_1995 = [0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459, 0.3240, 0.4262, 0.5719, 0.6528, 0.7590, 1.000]


def test_the_benjamini_hochberg_example_rejects_the_four_smallest_and_holm_matches_r():
    bh = am.adjust_pvalues(BH_1995, method="bh")
    assert bh["values"]["rejectedAt05"] == 4  # Benjamini & Hochberg (1995): the procedure at q = 0.05 rejects the first four
    assert bh["values"]["adjusted"][:5] == pytest.approx([0.0015, 0.003, 0.0095, 0.035625, 0.0603], abs=1e-12)
    assert bh["values"]["adjusted"][5:8] == pytest.approx([0.063857142857143] * 2 + [0.0645], abs=1e-12)
    holm = am.adjust_pvalues(BH_1995, method="holm")
    assert holm["values"]["adjusted"][:9] == pytest.approx([0.0015, 0.0056, 0.0247, 0.114, 0.2211, 0.278, 0.278, 0.278, 0.3213], abs=1e-12)
    assert holm["values"]["rejectedAt05"] == 3
    bonferroni = am.adjust_pvalues(BH_1995, method="bonferroni")
    assert bonferroni["values"]["adjusted"][:4] == pytest.approx([0.0015, 0.006, 0.0285, 0.1425], abs=1e-12)


def test_adjustment_comes_back_in_the_order_given():
    shuffled = [0.3240, 0.0001, 0.0459, 0.0004]
    adjusted = am.adjust_pvalues(shuffled, method="holm")["values"]["adjusted"]
    assert adjusted == pytest.approx([0.3240, 0.0004, 0.0918, 0.0012], abs=1e-12)  # Holm, by hand: 4*.0001, 3*.0004, 2*.0459, 1*.3240


@pytest.mark.parametrize("bad", [[], [0.5, float("nan")], [0.5, 1.5], [-0.1, 0.5]])
def test_p_values_that_are_not_p_values_are_declined(bad):
    entry = am.adjust_pvalues(bad)
    assert entry["status"] == "unsupported" and entry["reason"] == "invalid_pvalues"


def test_a_comparison_is_labelled_when_it_is_one_of_many():
    frame = sleep_frame()
    assert "multiplicity_unadjusted" not in codes(am.compare_groups(frame["extra"], frame["group"], contrast=("1", "2")))
    one_of_ten = am.compare_groups(frame["extra"], frame["group"], contrast=("1", "2"), family_size=10)
    assert next(item for item in one_of_ten["diagnostics"] if item["code"] == "multiplicity_unadjusted")["detail"] == {"tests": 10}
    assert one_of_ten["pValue"] == pytest.approx(0.07939, abs=5e-6), "a label never changes a number"
    assert "multiplicity_unadjusted" in codes(am.cox_regression(LUNG["time"], LUNG_EVENT, LUNG[["age"]], family_size=3))


def test_standardized_differences_match_their_definition_and_an_unbalanced_comparison_is_named():
    treated = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]
    age = [40, 45, 50, 55, 60, 52, 58, 61, 66, 70]
    sex = [1, 0, 1, 0, 1, 1, 1, 1, 0, 1]
    balance = am.covariate_balance(treated, pd.DataFrame({"age": age, "male": sex}), contrast=(1, 0))
    rows = {row["name"]: row for row in balance["values"]["covariates"]}
    a, b = np.array(age[5:], float), np.array(age[:5], float)
    assert rows["age"]["standardizedDifference"] == pytest.approx((a.mean() - b.mean()) / math.sqrt((a.var(ddof=1) + b.var(ddof=1)) / 2), rel=1e-12)
    assert "covariate_imbalance" in balance["warnings"]
    outcome = [3.1, 2.9, 3.4, 3.0, 3.3, 4.0, 4.2, 3.9, 4.4, 4.1]
    entry = am.compare_groups(outcome, treated, contrast=(1, 0), covariates=pd.DataFrame({"age": age, "male": sex}))
    detail = next(item for item in entry["diagnostics"] if item["code"] == "covariate_imbalance")["detail"]
    assert set(detail["covariates"]) >= {"age"} and detail["threshold"] == 0.1
    balanced = am.compare_groups(outcome, treated, contrast=(1, 0), covariates=pd.DataFrame({"x": [1, 2, 3, 4, 5, 1, 2, 3, 4, 5]}))
    assert "covariate_imbalance" not in codes(balanced)


# -- the data that breaks a careless two-group test -----------------------------------------------------------------------------

def test_missing_values_are_counted_by_group_and_unequal_missingness_is_a_warning():
    value = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, np.nan, np.nan, np.nan, 12.0, 13.0, 14.0, 15.0, 16.0]
    group = ["a"] * 8 + ["b"] * 8
    entry = am.compare_groups(value, group, contrast=("a", "b"))
    dropped = next(item for item in entry["diagnostics"] if item["code"] == "missing_values_dropped")["detail"]
    assert dropped == {"rowsDropped": 3, "rowsKept": 13, "rowsRead": 16}
    assert "missingness_differs_by_group" in entry["warnings"]
    assert entry["n"] == {"a": 8, "b": 5}


def test_repeated_measurements_are_not_analysed_as_independent():
    subject = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]
    group = ["a"] * 6 + ["b"] * 6
    value = [1.0, 1.2, 2.0, 2.1, 3.0, 3.3, 4.0, 4.4, 5.0, 5.1, 6.0, 6.2]
    refused = am.compare_groups(value, group, contrast=("a", "b"), subject=subject)
    assert refused["status"] == "unsupported" and refused["reason"] == "repeated_measurements" and refused["estimate"] is None and refused["pValue"] is None
    assert refused["message"] and "repeated measurements are not independent" in refused["message"]
    # The valid alternative on request: each person's mean, then the test on persons.
    means = am.compare_groups(value, group, contrast=("a", "b"), subject=subject, aggregate_subjects=True)
    assert means["status"] == "complete" and "subject_means_used" in codes(means) and means["n"] == {"a": 3, "b": 3}
    person_means = [np.mean(value[i:i + 2]) for i in range(0, 12, 2)]
    from scipy import stats
    assert means["values"]["t"] == pytest.approx(stats.ttest_ind(person_means[:3], person_means[3:], equal_var=False).statistic, rel=1e-12)


def test_a_person_in_both_groups_is_a_pairing_not_two_independent_samples():
    frame = sleep_frame()
    crossed = am.compare_groups(frame["extra"], frame["group"], contrast=("1", "2"), subject=frame["subject"])
    assert crossed["status"] == "unsupported" and crossed["reason"] == "crossed_subjects"
    incomplete = frame.drop(index=[3])
    assert am.compare_groups(incomplete["extra"], incomplete["group"], contrast=("1", "2"), test="paired", subject=incomplete["subject"])["reason"] == "unpaired_subjects"
    assert am.compare_groups(frame["extra"], frame["group"], contrast=("1", "2"), test="paired")["reason"] == "unpaired_subjects"


@pytest.mark.parametrize("value,group,code", [
    ([1.0, 2.0, 3.0], ["a", "a", "a"], "not_two_groups"), ([1.0, 2.0, 3.0, 4.0], ["a", "b", "c", "a"], "not_two_groups"),
    ([1.0, 2.0, 3.0], ["a", "b", "b"], "group_too_small"), ([5.0, 5.0, 5.0, 5.0], ["a", "a", "b", "b"], "zero_variance")])
def test_two_group_comparisons_the_data_cannot_support_are_declined_under_a_name(value, group, code):
    entry = am.compare_groups(value, group)
    assert entry["status"] == "unsupported" and entry["reason"] == code and entry["estimate"] is None and entry["pValue"] is None


def test_a_contrast_that_names_a_missing_group_is_declined():
    assert am.compare_groups([1.0, 2.0, 3.0, 4.0], ["a", "a", "b", "b"], contrast=("a", "z"))["reason"] == "not_two_groups"


# -- a refusal takes nothing else down ----------------------------------------------------------------------------------------------

def test_a_refusal_returns_normally_and_every_other_analysis_in_the_batch_is_unaffected():
    frame = sleep_frame()
    analyses = [am.compare_groups(frame["extra"], frame["group"], contrast=("1", "2"), label="welch"),
                am.logistic_regression((np.arange(20) > 9).astype(int), np.arange(20.0), label="separated"),
                am.kaplan_meier(LUNG["time"], LUNG_EVENT, label="km"),
                am.contingency_test([[0, 0], [3, 4]], label="empty"),
                am.cox_regression(LUNG["time"], LUNG_EVENT, LUNG[["age", "sex"]], label="cox")]
    assert [entry["status"] for entry in analyses] == ["complete", "unsupported", "complete", "unsupported", "complete"]
    assert [entry["id"] for entry in analyses] == ["welch", "separated", "km", "empty", "cox"]
    # Nothing is ever reported as a zero or a NaN: a declined analysis has no number, and all of it is valid JSON.
    for entry in analyses:
        json.dumps(entry, allow_nan=False)
        if entry["status"] == "unsupported":
            assert entry["estimate"] is None and entry["interval"] is None and entry["pValue"] is None and entry["reason"]
    # The batch is exactly the shape analysis-results.json takes.
    document = {"schemaVersion": 1, "analyses": analyses}
    assert all({"id", "status", "method", "estimand", "n", "estimate", "interval", "pValue", "warnings"} <= set(entry) for entry in document["analyses"])


def test_every_refusal_a_record_promises_is_one_the_module_can_give_and_no_unlisted_one_is():
    source = (SCRIPTS / "analysis_methods.py").read_text(encoding="utf-8")
    used = {}
    for match in re.finditer(r'_declined\((?:method|record), label, "([a-z_0-9]+)"', source):
        used.setdefault(match.group(1), 0)
    promised = {item["code"] for record in am.method_records().values() for item in record["refusals"]}
    assert set(used) == promised, (set(used) ^ promised)
    # The module's own guard: a refusal that is not in the method's record cannot be made.
    with pytest.raises(ValueError):
        am._declined("adjust_pvalues", None, "separation")
