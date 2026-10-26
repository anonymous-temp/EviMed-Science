#!/usr/bin/env python3
"""Optional arithmetic checks for a model-authored analysis; never a delivery gate.

Import ``audit_predictions(rows, **options)`` to audit flat row dictionaries. The
model supplies outcome_column, positive_label, negative_label, probability_column,
probability_label, split_column and patient_id_column. Labels are exact typed
scalars (CSV labels therefore stay strings); 0 is an event only if explicitly
named. Optional observation_id_column identifies a visit within a patient.
Distinct visits are repeated measurements, not duplicate observations. Nothing is
deduplicated or silently recoded; metrics retain every numerically usable test row.

``fit_stages=[{"name": "imputer", "fitIds": [...], "idLevel": "patient",
"predictors": ["age"]}, ...]`` describes ALL fitting stages, including imputation,
scaling, feature selection, tuning and the final model. idLevel defaults to
patient; observation IDs must be globally unambiguous when used as fitIds. Omit
fitIds to say scope is unknown, not clean. predictor_columns names the final
predictors. withheld_rows is the count excluded upstream (None means unknown).
The caller owns these declarations: no check certifies their completeness,
temporal availability, external validity or the appropriateness of a model.

Returns aggregate counts, findings, notChecked and metrics. Identifiers and raw
rows never appear in output. Missing/invalid outcomes or probabilities are excluded
from metric arithmetic and counted; missing IDs still permit descriptive metrics.
A probability_label mismatch disables metrics instead of silently inverting scores.
Calibration uses uniform bins and joint binomial-GLM recalibration
logit(event) = intercept + slope * logit(probability), without clipping 0 or 1.
Brier is overall probability error, not a pure calibration measure.

``compare_reported_numbers(results, comparisons)`` accepts explicit bindings such
as [{"id": "auc", "source": ["analyses", 0, "auc"], "reported": 0.923,
"absoluteTolerance": 0.0005, "relativeTolerance": 0}]. Paths are typed key/index
lists, never dotted strings or prose. A comparison passes when absolute difference
<= max(absoluteTolerance, relativeTolerance * abs(source)); both tolerances default
to zero. Unknown, null, nonfinite and nonnumeric values are not_checked. This is
only a check of the supplied bindings; research_calculate still owns rendering.

Optional local JSON CLI (reads a file or stdin, emits aggregate JSON to stdout):
    python analysis_checks.py request.json
    python analysis_checks.py - < request.json
Requests: {"operation": "predictions", "rows": [...], "options": {...}} or
{"operation": "reported_numbers", "results": {...}, "comparisons": [...]}.
Read CSV locally in the model's script (csv.DictReader or a dataframe); there is
no table registry, source upload, network call, method selection or model fitting
here beyond the explicitly named calibration diagnostic. Findings exit 0; malformed
requests exit 2. NumPy, sklearn and statsmodels are imported only for metrics.
"""
from __future__ import annotations

import argparse
from bisect import bisect_right
from collections import Counter, defaultdict
from fractions import Fraction
import json
import math
from numbers import Integral, Real
from pathlib import Path
import sys
import warnings


def _missing(value):
    return value is None or (isinstance(value, str) and not value.strip()) or (
        isinstance(value, Real) and not isinstance(value, Integral) and math.isnan(value))


def _key(value):
    if _missing(value):
        return None
    if isinstance(value, bool):
        return ("boolean", value)
    if isinstance(value, str):
        return ("string", value)
    if isinstance(value, Integral) or (isinstance(value, Real) and math.isfinite(value)):
        return ("number", value)
    return None


def _number(value, *, strings=False):
    if isinstance(value, bool) or not isinstance(value, (Real, str) if strings else Real):
        return None
    if isinstance(value, Integral):
        return int(value)
    try:
        number = float(value)
    except (ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _scalar(value):
    if isinstance(value, (str, bool)):
        return value
    return int(value) if isinstance(value, Integral) else float(value)


def _note(check, reason, **detail):
    return {"check": check, "status": "not_checked", "reason": reason, **detail}


def _finding(code, count=None, **detail):
    return {"code": code, "status": "attention", **({"count": count} if count is not None else {}), **detail}


def _unsupported(reason):
    return {"status": "unsupported", "reason": reason}


def _unavailable(reason):
    return {"status": "unavailable", "value": None, "reason": reason}


def _invalid(reason):
    return {"schemaVersion": 1, "kind": "prediction_audit", "status": "invalid",
            "findings": [_finding("invalid_configuration", reason=reason)], "notChecked": [],
            "metrics": _unsupported("invalid_configuration"),
            "validation": {"status": "not_established", "scope": "declared_checks_only"}}


def _names(value):
    return isinstance(value, list) and all(isinstance(item, str) and item.strip() for item in value)


def _config_error(rows, columns, labels, threshold, bins, withheld, stages, predictors):
    if not isinstance(rows, list) or any(not isinstance(row, dict) or any(
        not isinstance(key, str) or not (value is None or isinstance(value, (str, bool, Real)))
        for key, value in row.items()) for row in rows):
        return "rows_must_be_flat_dictionaries"
    if any(not isinstance(column, str) or not column.strip() for column in columns):
        return "column_names_required"
    if len(set(columns)) != len(columns):
        return "column_roles_must_be_distinct"
    if any(_key(value) is None for value in labels):
        return "finite_explicit_labels_required"
    positive, negative, _probability, train, test = map(_key, labels)
    if positive == negative or train == test:
        return "labels_must_be_distinct"
    if threshold is not None and (_number(threshold) is None or not 0 <= threshold <= 1):
        return "threshold_must_be_between_zero_and_one"
    if isinstance(bins, bool) or not isinstance(bins, Integral) or not 1 <= bins <= 1000:
        return "calibration_bins_must_be_an_integer_from_one_to_1000"
    if withheld is not None and (isinstance(withheld, bool) or not isinstance(withheld, Integral) or withheld < 0):
        return "withheld_rows_must_be_a_nonnegative_integer"
    if predictors is not None and not _names(predictors):
        return "predictor_columns_must_be_a_list_of_names"
    if stages is not None:
        if not isinstance(stages, list):
            return "fit_stages_must_be_a_list"
        names = set()
        for stage in stages:
            if not isinstance(stage, dict) or not isinstance(stage.get("name"), str) or not stage["name"].strip():
                return "fit_stage_name_required"
            if stage["name"] in names:
                return "fit_stage_names_must_be_unique"
            names.add(stage["name"])
            if stage.get("idLevel", "patient") not in ("patient", "observation"):
                return "fit_id_level_must_be_patient_or_observation"
            fit_ids = stage.get("fitIds")
            if fit_ids is not None and (not isinstance(fit_ids, list) or any(_key(item) is None for item in fit_ids)):
                return "fit_ids_must_be_a_list_of_nonmissing_scalar_identifiers"
            if stage.get("predictors") is not None and not _names(stage["predictors"]):
                return "stage_predictors_must_be_a_list_of_names"
    return None


def _duplicate_summary(rows, patient_column, observation_column, findings, notes):
    patients, observations = defaultdict(list), defaultdict(list)
    exact_extra = conflicting_groups = repeated = unresolved = 0
    for row in rows:
        patient = _key(row.get(patient_column))
        observation = _key(row.get(observation_column)) if observation_column else None
        if patient is not None:
            patients[patient].append(row)
            if observation is not None:
                observations[(patient, observation)].append(row)
    # Same contract as data_semantics_checks: exact rows and conflicting values
    # share a declared observation key; a subject alone does not establish one.
    groups = observations.values() if observation_column else patients.values()
    for group in groups:
        if len(group) < 2:
            continue
        signatures = Counter(tuple(sorted((name, repr(value)) for name, value in row.items())) for row in group)
        exact_extra += sum(count - 1 for count in signatures.values())
        if observation_column and len(signatures) > 1:
            conflicting_groups += 1
    for group in patients.values():
        if len(group) < 2:
            continue
        visits = {_key(row.get(observation_column)) for row in group} if observation_column else set()
        if len(visits - {None}) > 1:
            repeated += 1
        if not observation_column or None in visits:
            unresolved += 1
    if exact_extra:
        findings.append(_finding("duplicate_exact", exact_extra))
    if conflicting_groups:
        findings.append(_finding("duplicate_conflicting", conflicting_groups))
    if repeated:
        findings.append(_finding("repeated_measurements", repeated,
                                 interpretation="Distinct visits are retained; row independence is not established."))
    if unresolved:
        findings.append(_finding("repeated_patient_unresolved", unresolved))
    if not observation_column:
        notes.append(_note("duplicates", "observation_key_undeclared"))
    return {"uniquePatients": len(patients), "patientsWithMultipleRows": sum(len(group) > 1 for group in patients.values()),
            "exactExtraRows": exact_extra, "conflictingGroups": conflicting_groups,
            "repeatedMeasurementPatients": repeated, "unresolvedRepeatedPatients": unresolved}


def _fit_scope(rows, stages, patient_column, observation_column, split_column, train_key, test_key, findings, notes):
    if not stages:
        notes.append(_note("fit_scope", "fit_scope_undeclared"))
        return []
    checked = []
    for stage in stages:
        item = {"stage": stage["name"], "idLevel": stage.get("idLevel", "patient")}
        column = observation_column if item["idLevel"] == "observation" else patient_column
        if column is None or stage.get("fitIds") is None:
            reason = "observation_key_undeclared" if column is None else "fit_scope_undeclared"
            notes.append(_note("fit_scope", reason, stage=stage["name"]))
            checked.append({**item, "status": "not_checked", "reason": reason})
            continue
        # Observation IDs used without patient IDs must have one global owner.
        owners = defaultdict(set)
        train, test = set(), set()
        missing_ids = 0
        for row in rows:
            key, patient = _key(row.get(column)), _key(row.get(patient_column))
            split = _key(row.get(split_column))
            if key is not None:
                owners[key].add(patient)
                if split == train_key:
                    train.add(key)
                elif split == test_key:
                    test.add(key)
            elif split in (train_key, test_key):
                missing_ids += 1
        fit_ids = {_key(value) for value in stage["fitIds"]}
        ambiguous = item["idLevel"] == "observation" and any(len(owners[key]) > 1 or None in owners[key] for key in fit_ids)
        leaked, outside = len(fit_ids & test), len(fit_ids - train - test)
        if leaked:
            findings.append(_finding("fit_test_contamination", leaked, stage=stage["name"]))
        if outside:
            findings.append(_finding("fit_ids_outside_train", outside, stage=stage["name"]))
        reason = "ambiguous_observation_ids" if ambiguous else "incomplete_identifiers" if missing_ids else "fit_ids_outside_train" if outside else None
        if reason:
            notes.append(_note("fit_scope", reason, stage=stage["name"]))
        checked.append({**item, "status": "not_checked" if reason else "attention" if leaked else "checked",
                        "fitIds": len(fit_ids), "testIds": leaked, "unknownIds": outside,
                        **({"reason": reason} if reason else {})})
    return checked


def _calibration_regression(y, probabilities):
    if len(set(y)) < 2:
        return _unavailable("single_class")
    if len(set(probabilities)) < 2:
        return _unavailable("constant_probabilities")
    if any(p in (0, 1) for p in probabilities):
        return _unavailable("boundary_probabilities")
    positive = [p for p, event in zip(probabilities, y) if event]
    negative = [p for p, event in zip(probabilities, y) if not event]
    if min(positive) >= max(negative) or max(positive) <= min(negative):
        return _unavailable("separation")
    try:
        import numpy as np
        import statsmodels.api as sm
        from statsmodels.tools.sm_exceptions import PerfectSeparationError, PerfectSeparationWarning
    except ImportError:
        return _unavailable("statsmodels_unavailable")
    p = np.asarray(probabilities, dtype=float)
    design = sm.add_constant(np.log(p) - np.log1p(-p), has_constant="add")
    try:
        with warnings.catch_warnings(record=True) as observed:
            warnings.simplefilter("always")
            fitted = sm.GLM(np.asarray(y), design, family=sm.families.Binomial()).fit()
        if any(issubclass(item.category, PerfectSeparationWarning) for item in observed):
            return _unavailable("separation")
        if not fitted.converged or observed or not np.isfinite(fitted.params).all() or not np.isfinite(fitted.bse).all():
            return _unavailable("calibration_fit_unstable")
        return {"status": "complete", "intercept": float(fitted.params[0]), "slope": float(fitted.params[1]),
                "method": "binomial_glm_joint_intercept_and_logit_probability_slope", "probabilitiesClipped": False}
    except PerfectSeparationError:
        return _unavailable("separation")
    except (ValueError, FloatingPointError, np.linalg.LinAlgError):
        return _unavailable("calibration_fit_unstable")


def _metrics(y, probabilities, bins, threshold, positive_label, negative_label, descriptive):
    if not y:
        return _unsupported("no_valid_test_rows")
    try:
        from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score
    except ImportError:
        return _unsupported("sklearn_unavailable")
    single = len(set(y)) < 2
    calibration_bins = []
    boundaries = [index / bins for index in range(bins + 1)]
    sums = [[0, 0.0, 0] for _ in range(bins)]
    for event, probability in zip(y, probabilities):
        index = min(bisect_right(boundaries, probability) - 1, bins - 1)
        sums[index][0] += 1
        sums[index][1] += probability
        sums[index][2] += event
    for index, (count, probability_sum, events) in enumerate(sums):
        calibration_bins.append({"lower": index / bins, "upper": (index + 1) / bins,
                                 "upperInclusive": index == bins - 1, "count": count, "events": events,
                                 "meanProbability": probability_sum / count if count else None,
                                 "eventRate": events / count if count else None})
    result = {"status": "complete", "scope": "valid_test_rows_descriptive" if descriptive else "declared_heldout_rows",
              "n": len(y), "rocAuc": _unavailable("single_class") if single else {"status": "complete", "value": float(roc_auc_score(y, probabilities))},
              "averagePrecision": _unavailable("single_class") if single else {"status": "complete", "value": float(average_precision_score(y, probabilities, pos_label=1))},
              "brier": {"status": "complete", "value": float(brier_score_loss(y, y_proba=probabilities, pos_label=1)),
                        "interpretation": "Overall probability prediction error; not a pure calibration measure."},
              "calibrationBins": calibration_bins, "calibrationRegression": _calibration_regression(y, probabilities)}
    if threshold is None:
        result["threshold"] = {"status": "not_checked", "reason": "threshold_undeclared"}
    else:
        tp = sum(event == 1 and probability >= threshold for event, probability in zip(y, probabilities))
        fp = sum(event == 0 and probability >= threshold for event, probability in zip(y, probabilities))
        fn, tn = sum(y) - tp, len(y) - sum(y) - fp
        result["threshold"] = {"status": "complete", "value": float(threshold), "rule": "probability >= threshold",
                               "positiveLabel": _scalar(positive_label), "negativeLabel": _scalar(negative_label),
                               "confusion": {"truePositive": tp, "falsePositive": fp, "trueNegative": tn, "falseNegative": fn},
                               "sensitivity": tp / (tp + fn) if tp + fn else None,
                               "specificity": tn / (tn + fp) if tn + fp else None,
                               "positivePredictiveValue": tp / (tp + fp) if tp + fp else None,
                               "negativePredictiveValue": tn / (tn + fn) if tn + fn else None}
    return result


def audit_predictions(rows, *, outcome_column, positive_label, negative_label, probability_column,
                      probability_label, split_column, patient_id_column, observation_id_column=None,
                      train_label="train", test_label="test", fit_stages=None, predictor_columns=None,
                      threshold=None, calibration_bins=10, withheld_rows=None):
    """Audit declared prediction rows, returning aggregate diagnostics and valid-test-subset metrics."""
    columns = [outcome_column, probability_column, split_column, patient_id_column]
    if observation_id_column is not None:
        columns.append(observation_id_column)
    error = _config_error(rows, columns, [positive_label, negative_label, probability_label, train_label, test_label],
                          threshold, calibration_bins, withheld_rows, fit_stages, predictor_columns)
    if error:
        return _invalid(error)
    findings, notes = [], []
    positive, negative, train, test = map(_key, [positive_label, negative_label, train_label, test_label])
    counts = {"inputRows": len(rows), "trainRows": 0, "testRows": 0, "unknownSplitRows": 0,
              "validTestRows": 0, "excludedTestRows": 0, "unknownOutcomeRows": 0, "invalidProbabilityRows": 0,
              "withheldRows": int(withheld_rows) if withheld_rows is not None else None}
    fields = {"outcome": outcome_column, "probability": probability_column, "split": split_column, "patientId": patient_id_column}
    if observation_id_column:
        fields["observationId"] = observation_id_column
    missingness = {scope: {field: 0 for field in fields} for scope in ("all", "train", "test")}
    y, probabilities, train_patients, test_patients = [], [], set(), set()
    for row in rows:
        split = _key(row.get(split_column))
        scope = "train" if split == train else "test" if split == test else None
        counts["trainRows" if scope == "train" else "testRows" if scope == "test" else "unknownSplitRows"] += 1
        for name, column in fields.items():
            missing = _key(row.get(column)) is None if name in ("patientId", "observationId") else _missing(row.get(column))
            missingness["all"][name] += int(missing)
            if scope:
                missingness[scope][name] += int(missing)
        patient = _key(row.get(patient_id_column))
        if scope and patient is not None:
            (train_patients if scope == "train" else test_patients).add(patient)
        outcome, probability = _key(row.get(outcome_column)), _number(row.get(probability_column), strings=True)
        if not _missing(row.get(outcome_column)) and outcome not in (positive, negative):
            counts["unknownOutcomeRows"] += 1
        if not _missing(row.get(probability_column)) and (probability is None or not 0 <= probability <= 1):
            counts["invalidProbabilityRows"] += 1
        if scope == "test" and outcome in (positive, negative) and probability is not None and 0 <= probability <= 1:
            y.append(int(outcome == positive))
            probabilities.append(probability)
    counts.update(validTestRows=len(y), excludedTestRows=counts["testRows"] - len(y), testEvents=sum(y),
                  testNonevents=len(y) - sum(y), uniquePatients=len(train_patients | test_patients))
    for field, code in (("outcome", "missing_outcome"), ("probability", "missing_probability")):
        if missingness["test"][field]:
            findings.append(_finding(code, missingness["test"][field], scope="test"))
    for field, code in (("patientId", "missing_patient_id"), ("observationId", "missing_observation_id"), ("split", "missing_split")):
        if missingness["all"].get(field):
            findings.append(_finding(code, missingness["all"][field]))
            notes.append(_note("independence", "incomplete_identifiers" if field != "split" else "incomplete_split"))
    for field, code in (("unknownOutcomeRows", "unknown_outcome_code"), ("invalidProbabilityRows", "invalid_probability"), ("unknownSplitRows", "unknown_split")):
        if counts[field]:
            findings.append(_finding(code, counts[field]))
    if counts["unknownSplitRows"]:
        notes.append(_note("split_overlap", "unknown_split_rows"))
    if not counts["trainRows"]:
        notes.append(_note("split_overlap", "training_rows_unavailable"))
    if withheld_rows is None:
        notes.append(_note("completeness", "withheld_rows_undeclared"))
    elif withheld_rows:
        findings.append(_finding("rows_withheld_upstream", int(withheld_rows)))
    mismatch = _key(probability_label) != positive
    if mismatch:
        findings.append(_finding("probability_label_mismatch", interpretation="Metrics require probabilities for the explicitly declared positive label; no inversion applied."))
    if predictor_columns is None:
        notes.append(_note("predictors", "predictors_undeclared"))
    if outcome_column in (predictor_columns or []):
        findings.append(_finding("target_in_predictors", stage="final_predictors"))
    for stage in fit_stages or []:
        if outcome_column in (stage.get("predictors") or []):
            findings.append(_finding("target_in_predictors", stage=stage["name"]))
    duplicates = _duplicate_summary(rows, patient_id_column, observation_id_column, findings, notes)
    overlap = len(train_patients & test_patients)
    if overlap:
        findings.append(_finding("patient_split_overlap", overlap))
    fit_scope = _fit_scope(rows, fit_stages, patient_id_column, observation_id_column, split_column, train, test, findings, notes)
    compromise_codes = {"patient_split_overlap", "fit_test_contamination", "target_in_predictors", "duplicate_exact", "duplicate_conflicting", "repeated_measurements", "repeated_patient_unresolved"}
    compromised = bool(compromise_codes & {item["code"] for item in findings})
    validation = "compromised" if compromised else "not_established" if notes or findings or not y else "supported_by_declared_checks"
    metrics = _unsupported("probability_label_mismatch") if mismatch else _metrics(y, probabilities, int(calibration_bins), threshold, positive_label, negative_label, validation != "supported_by_declared_checks")
    split_complete = not missingness["all"]["patientId"] and not counts["unknownSplitRows"] and bool(counts["trainRows"] and counts["testRows"])
    return {"schemaVersion": 1, "kind": "prediction_audit", "status": "partial" if findings or notes or metrics["status"] != "complete" else "complete",
            "classMapping": {"outcomeColumn": outcome_column, "positiveLabel": _scalar(positive_label), "negativeLabel": _scalar(negative_label),
                             "probabilityColumn": probability_column, "probabilityLabel": _scalar(probability_label)},
            "counts": counts, "missingness": missingness, "duplicates": duplicates, "findings": findings, "notChecked": notes,
            "checks": {"splitOverlap": {"status": "attention" if overlap else "checked" if split_complete else "not_checked", "overlapPatients": overlap}, "fitScope": fit_scope},
            "validation": {"status": validation, "scope": "declared_checks_only",
                           "limitations": "Caller declarations are not verified; temporal leakage, stage completeness and external validity are not checked."},
            "metrics": metrics}


def _bound_number(results, path):
    if not isinstance(path, list) or not path:
        return None
    current = results
    for part in path:
        if isinstance(part, str) and isinstance(current, dict) and part in current:
            current = current[part]
        elif type(part) is int and isinstance(current, list) and 0 <= part < len(current):
            current = current[part]
        else:
            return None
    return _number(current)


def compare_reported_numbers(results, comparisons):
    """Compare only explicitly bound numeric values; never extract or certify prose."""
    if not isinstance(comparisons, list):
        return {"schemaVersion": 1, "kind": "reported_number_audit", "status": "invalid",
                "reason": "comparisons_must_be_a_list", "scope": "explicit_numeric_bindings_only", "proseChecked": False}
    checked = []
    for index, binding in enumerate(comparisons):
        item = {"index": index, "status": "not_checked"}
        if not isinstance(binding, dict):
            checked.append({**item, "reason": "invalid_binding"})
            continue
        if isinstance(binding.get("id"), str):
            item["id"] = binding["id"]
        expected = _bound_number(results, binding.get("source"))
        reported = _number(binding.get("reported"))
        absolute = _number(binding.get("absoluteTolerance", 0))
        relative = _number(binding.get("relativeTolerance", 0))
        if absolute is None or relative is None or min(absolute, relative) < 0:
            checked.append({**item, "reason": "invalid_tolerance"})
        elif expected is None or reported is None:
            checked.append({**item, "reason": "source_or_reported_value_unknown_or_nonfinite"})
        else:
            # Rational arithmetic preserves exact integer counts and declared
            # decimal rounding tolerances, including mixed int/float bindings.
            tolerance_exact = max(Fraction(str(absolute)), Fraction(str(relative)) * abs(Fraction(str(expected))))
            difference_exact = abs(Fraction(str(reported)) - Fraction(str(expected)))
            try:
                tolerance = int(tolerance_exact) if tolerance_exact.denominator == 1 else float(tolerance_exact)
                difference = int(difference_exact) if difference_exact.denominator == 1 else float(difference_exact)
            except OverflowError:
                checked.append({**item, "reason": "comparison_arithmetic_nonfinite"})
                continue
            checked.append({**item, "status": "match" if difference_exact <= tolerance_exact else "mismatch", "source": binding["source"],
                            "expected": expected, "reported": reported, "absoluteDifference": difference, "tolerance": tolerance})
    counts = Counter(item["status"] for item in checked)
    return {"schemaVersion": 1, "kind": "reported_number_audit", "status": "partial" if counts["not_checked"] else "complete",
            "scope": "explicit_numeric_bindings_only", "proseChecked": False, "comparisons": checked,
            "counts": {"requested": len(checked), "matched": counts["match"], "mismatched": counts["mismatch"], "notChecked": counts["not_checked"]}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", help="Local JSON request file, or - for stdin.")
    args = parser.parse_args()
    try:
        request = json.load(sys.stdin) if args.request == "-" else json.loads(Path(args.request).read_text(encoding="utf-8"))
        if not isinstance(request, dict):
            raise ValueError("request_must_be_an_object")
        operation = request.get("operation")
        if operation == "predictions":
            result = audit_predictions(request["rows"], **request["options"])
        elif operation == "reported_numbers":
            result = compare_reported_numbers(request["results"], request["comparisons"])
        else:
            raise ValueError("unknown_operation")
    except (OSError, UnicodeError, ValueError, TypeError, KeyError):
        # Never echo a malformed row, an ID, file contents or exception payloads.
        result = {"schemaVersion": 1, "status": "invalid", "reason": "invalid_request"}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 2 if result["status"] == "invalid" else 0


if __name__ == "__main__":
    sys.exit(main())
