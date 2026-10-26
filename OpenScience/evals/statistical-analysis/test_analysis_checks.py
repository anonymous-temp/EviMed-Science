"""Prediction diagnostics and exact report bindings; no fitting or platform gate."""
from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys

import pytest

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parents[1] / "capabilities" / "statistical-analysis" / "scripts"


def checks():
    path = SCRIPTS / "analysis_checks.py"
    assert path.is_file(), "The prediction and reported-number audit helper is not implemented."
    spec = importlib.util.spec_from_file_location("analysis_checks", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rows():
    # Code 0 is malignant: the event must never be inferred from numeric order.
    return [
        {"patient": "private-training-1", "visit": "v1", "split": "train", "diagnosis": 0, "p": None},
        {"patient": "private-training-2", "visit": "v1", "split": "train", "diagnosis": 1, "p": None},
        *[{"patient": f"private-test-{i}", "visit": "v1", "split": "test", "diagnosis": outcome, "p": p}
          for i, (outcome, p) in enumerate([(0, .9), (1, .8), (0, .7), (1, .2), (0, .4), (1, .1)])],
    ]


def audit(data=None, **changes):
    options = {
        "outcome_column": "diagnosis", "positive_label": 0, "negative_label": 1,
        "probability_column": "p", "probability_label": 0, "split_column": "split",
        "patient_id_column": "patient", "observation_id_column": "visit", "threshold": .5,
        "calibration_bins": 5, "withheld_rows": 0, "predictor_columns": ["age"],
        "fit_stages": [{"name": "model", "fitIds": ["private-training-1", "private-training-2"]}],
    }
    options.update(changes)
    return checks().audit_predictions(rows() if data is None else data, **options)


def codes(result):
    return {item["code"] for item in result["findings"]}


def test_zero_is_positive_and_arithmetic_references_do_not_depend_on_sklearn():
    result = audit()
    assert result["status"] == "complete"
    assert result["classMapping"]["positiveLabel"] == 0
    metrics = result["metrics"]
    positives, negatives = [.9, .7, .4], [.8, .2, .1]
    auc = sum((p > n) + .5 * (p == n) for p in positives for n in negatives) / 9
    brier = sum((p - 1) ** 2 for p in positives) / 6 + sum(p * p for p in negatives) / 6
    assert metrics["rocAuc"]["value"] == pytest.approx(auc)
    assert metrics["brier"]["value"] == pytest.approx(brier)
    # Positive ranks 1, 3, 4 among six descending scores: mean precision at their ranks.
    assert metrics["averagePrecision"]["value"] == pytest.approx((1 + 2 / 3 + 3 / 4) / 3)
    assert metrics["threshold"]["confusion"] == {"truePositive": 2, "falsePositive": 1, "trueNegative": 2, "falseNegative": 1}
    assert metrics["threshold"]["positiveLabel"] == 0
    assert "not a pure calibration measure" in metrics["brier"]["interpretation"]
    bins = metrics["calibrationBins"]
    assert sum(item["count"] for item in bins) == 6
    assert sum(item["events"] for item in bins) == 3
    assert sum(item["meanProbability"] * item["count"] for item in bins if item["count"]) == pytest.approx(3.1)
    assert result["validation"]["status"] == "supported_by_declared_checks"
    assert "private-" not in json.dumps(result)


def test_probability_for_other_class_is_not_silently_inverted():
    result = audit(probability_label=1)
    assert "probability_label_mismatch" in codes(result)
    assert result["metrics"]["status"] == "unsupported"
    assert "rocAuc" not in result["metrics"]
    assert result["counts"]["validTestRows"] == 6


def test_missingness_unknown_codes_and_invalid_probabilities_remain_visible():
    data = rows()
    data += [{"patient": f"private-bad-{i}", "visit": "v1", "split": "test", **values} for i, values in enumerate([
        {"diagnosis": None, "p": .2}, {"diagnosis": 0}, {"diagnosis": 2, "p": .4},
        {"diagnosis": 1, "p": 1.1}, {"diagnosis": 1, "p": float("nan")},
        {"diagnosis": 0, "p": "not-a-probability"}, {"diagnosis": False, "p": .5},
    ])]
    result = audit(data)
    assert {"missing_outcome", "missing_probability", "unknown_outcome_code", "invalid_probability"} <= codes(result)
    assert result["missingness"]["test"]["outcome"] == 1
    assert result["missingness"]["test"]["probability"] == 2
    assert result["counts"]["unknownOutcomeRows"] == 2
    assert result["counts"]["invalidProbabilityRows"] == 2
    assert result["counts"]["validTestRows"] == 6
    assert result["counts"]["excludedTestRows"] == 7
    assert result["metrics"]["scope"] == "valid_test_rows_descriptive"
    assert result["status"] == "partial"
    json.dumps(result, allow_nan=False)


def test_split_overlap_fit_contamination_and_target_predictor_are_independent_findings():
    data = rows()
    data[2]["patient"] = "private-training-1"
    result = audit(data, fit_stages=[
        {"name": "imputer", "fitIds": ["private-training-1", "private-test-1"]},
        {"name": "selection", "fitIds": ["private-training-2"], "predictors": ["diagnosis", "age"]},
        {"name": "model", "fitIds": ["private-training-2"]},
    ])
    assert {"patient_split_overlap", "fit_test_contamination", "target_in_predictors", "duplicate_conflicting"} <= codes(result)
    assert result["checks"]["splitOverlap"]["overlapPatients"] == 1
    assert result["checks"]["fitScope"][0]["testIds"] == 2
    assert result["validation"]["status"] == "compromised"
    assert result["metrics"]["scope"] == "valid_test_rows_descriptive"
    assert "private-" not in json.dumps(result)


def test_unknown_fit_scope_never_reads_as_clean_and_ids_outside_train_are_named():
    missing = audit(fit_stages=None)
    assert any(x["reason"] == "fit_scope_undeclared" for x in missing["notChecked"])
    assert missing["validation"]["status"] == "not_established"
    unknown = audit(fit_stages=[{"name": "model", "fitIds": ["private-unknown"]}])
    assert "fit_ids_outside_train" in codes(unknown)
    assert unknown["validation"]["status"] == "not_established"


def test_duplicate_exact_conflicting_and_distinct_visits_are_not_conflated():
    data = rows()
    data += [dict(data[2]), {**data[3], "p": .6}, {**data[4], "visit": "v2"}]
    result = audit(data)
    assert {"duplicate_exact", "duplicate_conflicting", "repeated_measurements"} <= codes(result)
    assert result["duplicates"]["exactExtraRows"] == 1
    assert result["duplicates"]["conflictingGroups"] == 1
    assert result["duplicates"]["repeatedMeasurementPatients"] == 1
    assert result["counts"]["validTestRows"] == 9  # No duplicate was silently deleted.
    assert result["validation"]["status"] == "compromised"
    unresolved = audit(data, observation_id_column=None)
    assert "repeated_patient_unresolved" in codes(unresolved)
    assert unresolved["duplicates"]["conflictingGroups"] == 0


def test_missing_identifiers_unknown_split_and_withheld_rows_cannot_certify_independence():
    data = rows()
    del data[2]["patient"]
    del data[3]["visit"]
    data += [{"diagnosis": 0, "p": .9, "split": "validation", "patient": "private-other", "visit": "v1"}]
    result = audit(data, withheld_rows=None)
    assert {"missing_patient_id", "missing_observation_id", "unknown_split"} <= codes(result)
    assert any(x["reason"] == "withheld_rows_undeclared" for x in result["notChecked"])
    assert result["validation"]["status"] == "not_established"
    assert result["counts"]["unknownSplitRows"] == 1
    assert result["counts"]["withheldRows"] is None


def test_fit_observation_ids_require_complete_declared_observation_keys():
    data = rows()
    for index, row in enumerate(data):
        row["visit"] = f"observation-{index}"
    good = audit(data, fit_stages=[{"name": "model", "idLevel": "observation", "fitIds": ["observation-0"]}])
    assert good["checks"]["fitScope"][0]["status"] == "checked"
    contaminated = audit(data, fit_stages=[{"name": "scale", "idLevel": "observation", "fitIds": ["observation-2"]}])
    assert "fit_test_contamination" in codes(contaminated)
    unknown = audit(data, observation_id_column=None, fit_stages=[{"name": "model", "idLevel": "observation", "fitIds": ["observation-0"]}])
    assert any(x["reason"] == "observation_key_undeclared" for x in unknown["notChecked"])


def test_single_class_has_brier_and_bins_but_named_unavailable_discrimination_and_calibration():
    data = rows()
    for row in data:
        row["diagnosis"] = 0
    result = audit(data)
    assert result["metrics"]["rocAuc"] == {"status": "unavailable", "value": None, "reason": "single_class"}
    assert result["metrics"]["averagePrecision"]["reason"] == "single_class"
    assert result["metrics"]["calibrationRegression"]["reason"] == "single_class"
    assert result["metrics"]["brier"]["value"] is not None


@pytest.mark.parametrize("probabilities,reason", [
    ([.5] * 6, "constant_probabilities"),
    ([.9, .2, .8, .1, .7, .3], "separation"),
    ([1., .8, .7, .2, .4, 0.], "boundary_probabilities"),
])
def test_calibration_nonestimability_keeps_other_metrics(probabilities, reason):
    data = rows()
    for row, p in zip(data[2:], probabilities):
        row["p"] = p
    result = audit(data)
    assert result["metrics"]["calibrationRegression"]["status"] == "unavailable"
    assert result["metrics"]["calibrationRegression"]["reason"] == reason
    assert result["metrics"]["rocAuc"]["value"] is not None
    assert sum(x["count"] for x in result["metrics"]["calibrationBins"]) == 6


def test_calibration_regression_recovers_known_group_event_odds():
    # Each score level has both outcomes; logit(event rate)=log(2)+2*logit(p).
    data = rows()[:2]
    for group, p, events, n in [(0, 1 / 3, 2, 6), (1, 2 / 3, 8, 9)]:
        for i in range(n):
            data.append({"patient": f"private-{group}-{i}", "visit": "v1", "split": "test", "diagnosis": 0 if i < events else 1, "p": p})
    regression = audit(data)["metrics"]["calibrationRegression"]
    assert regression["status"] == "complete"
    assert regression["intercept"] == pytest.approx(math.log(2), abs=1e-7)
    assert regression["slope"] == pytest.approx(2, abs=1e-7)


@pytest.mark.parametrize("options", [
    {"threshold": -.1}, {"threshold": 1.1}, {"threshold": True}, {"calibration_bins": 0},
    {"calibration_bins": 2.5}, {"calibration_bins": 1001}, {"positive_label": None},
    {"negative_label": 0}, {"withheld_rows": -1}, {"withheld_rows": False},
    {"fit_stages": [{"name": "model", "fitIds": "not-list"}]}, {"predictor_columns": "age"},
    {"outcome_column": ""}, {"patient_id_column": "diagnosis"},
])
def test_invalid_configuration_is_structured_and_never_returns_metrics(options):
    result = audit(**options)
    assert result["status"] == "invalid"
    assert "invalid_configuration" in codes(result)
    assert result["metrics"]["status"] == "unsupported"
    json.dumps(result, allow_nan=False)


def test_invalid_rows_empty_test_and_absent_predictor_scope_are_named():
    assert audit([None])["status"] == "invalid"
    assert audit([])["metrics"]["reason"] == "no_valid_test_rows"
    result = audit(predictor_columns=None)
    assert any(x["reason"] == "predictors_undeclared" for x in result["notChecked"])


def test_bound_report_values_compare_counts_and_tolerated_rounding_only():
    source = {"counts": {"test": 121}, "analyses": [{"auc": .923456789}]}
    result = checks().compare_reported_numbers(source, [
        {"id": "test-size", "source": ["counts", "test"], "reported": 120},
        {"id": "auc-rounded", "source": ["analyses", 0, "auc"], "reported": .923, "absoluteTolerance": .0005},
        {"id": "auc-wrong", "source": ["analyses", 0, "auc"], "reported": .91, "absoluteTolerance": .0005},
        {"id": "test-relative", "source": ["counts", "test"], "reported": 120, "relativeTolerance": .01},
    ])
    assert [x["status"] for x in result["comparisons"]] == ["mismatch", "match", "mismatch", "match"]
    assert result["counts"] == {"requested": 4, "matched": 2, "mismatched": 2, "notChecked": 0}
    assert result["scope"] == "explicit_numeric_bindings_only"
    assert result["proseChecked"] is False


def test_unknown_null_nonfinite_and_non_numeric_report_values_are_not_checked():
    result = checks().compare_reported_numbers({"null": None, "bad": float("inf"), "text": "120", "bool": True}, [
        {"id": "missing", "source": ["missing"], "reported": 1},
        {"id": "null", "source": ["null"], "reported": 1},
        {"id": "bad", "source": ["bad"], "reported": 1},
        {"id": "text", "source": ["text"], "reported": 120},
        {"id": "bool", "source": ["bool"], "reported": 1},
        {"id": "unreported", "source": ["bad"], "reported": None},
        {"id": "tolerance", "source": ["null"], "reported": 1, "absoluteTolerance": -.1},
    ])
    assert result["counts"]["notChecked"] == 7
    assert all(x["status"] == "not_checked" for x in result["comparisons"])
    json.dumps(result, allow_nan=False)


def test_report_bindings_do_not_coerce_paths_or_use_natural_language_numbers():
    result = checks().compare_reported_numbers({"a.b": 3, "a": [4]}, [
        {"id": "literal-key", "source": ["a.b"], "reported": 3},
        {"id": "not-path", "source": "a.0", "reported": 4},
        {"id": "negative-index", "source": ["a", -1], "reported": 4},
        {"id": "prose", "source": ["a", 0], "reported": "There were 4 patients."},
    ])
    assert [x["status"] for x in result["comparisons"]] == ["match", "not_checked", "not_checked", "not_checked"]


def test_cli_is_json_and_skill_copy_is_identical(tmp_path):
    module = checks()
    source = SCRIPTS / "analysis_checks.py"
    copy = SCRIPTS.parents[2] / "capability-skills/statistical-analysis/scripts/analysis_checks.py"
    assert source.read_bytes() == copy.read_bytes()
    request = tmp_path / "check.json"
    request.write_text(json.dumps({"operation": "reported_numbers", "results": {"n": 10}, "comparisons": [{"id": "n", "source": ["n"], "reported": 9}]}))
    completed = subprocess.run([sys.executable, str(source), str(request)], capture_output=True, text=True, check=True)
    assert json.loads(completed.stdout)["counts"]["mismatched"] == 1
    assert completed.stderr == ""
    request.write_text('{"operation": "unknown"}')
    failed = subprocess.run([sys.executable, str(source), str(request)], capture_output=True, text=True)
    assert failed.returncode == 2
    assert json.loads(failed.stdout)["status"] == "invalid"


def test_exact_numeric_bindings_do_not_round_distinct_large_integer_counts_to_equal():
    big = 2 ** 53 + 1
    result = checks().compare_reported_numbers({"n": big}, [
        {"source": ["n"], "reported": big - 1},
        {"source": ["n"], "reported": float(big - 1)},
    ])
    assert [item["status"] for item in result["comparisons"]] == ["mismatch", "mismatch"]
    assert all(item["absoluteDifference"] == 1 for item in result["comparisons"])


def test_exact_uniform_bin_boundaries_are_left_inclusive():
    data = rows()
    data[2]["p"] = .58
    result = audit(data, calibration_bins=100)
    assert result["metrics"]["calibrationBins"][58]["count"] == 1
    assert result["metrics"]["calibrationBins"][57]["count"] == 0


def test_huge_invalid_probability_is_counted_without_overflow():
    data = rows()
    data[2]["p"] = 10 ** 500
    result = audit(data)
    assert result["counts"]["invalidProbabilityRows"] == 1
    assert result["counts"]["validTestRows"] == 5
    json.dumps(result, allow_nan=False)
