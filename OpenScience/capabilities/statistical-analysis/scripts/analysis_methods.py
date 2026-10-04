#!/usr/bin/env python3
"""Reference-checked implementations of the methods an ordinary clinical data analysis meets most.

Two-group comparison, contingency tables, linear and logistic regression, Kaplan-Meier, the log-rank
test, Cox regression, multiplicity adjustment and covariate balance. They are an option, not a registry:
a run may use them, or its own code with the same care. What they add is what a script written in a hurry
leaves out:

- every result carries the method record it ran (`analysis_method_records.json`: assumptions, inputs,
  refusals, diagnostics, references), the digest of that record and of this file, no seed (nothing here
  draws a random number) and the versions of the libraries it ran on;
- the data are looked at before the model is fitted. Missing values are counted, repeated measurements
  are not treated as independent, censoring is read as censoring, a table with a zero cell is not given
  a ratio, a model the data cannot identify (collinear predictors, perfect separation, no events in a
  group) is declined, and covariate imbalance and unadjusted multiplicity are named;
- a computation the data cannot support is declined as `status: "unsupported"` with a named reason and
  returns normally. It never raises on data, never returns zero or NaN as an estimate, and never takes
  another analysis down: the caller keeps every other result.

Each function returns one entry shaped for `analysis-results.json`
(`{id, status, method, estimand, n, estimate, interval, pValue, warnings}` plus `values`, `diagnostics`,
`methodRecord`, `seeded`, `seed`, `environment`). Diagnostics are labels: they never change a number and
never withhold a result. The statistics come from scipy and statsmodels where those implement them and
from short, tested code where they do not (Kaplan-Meier, the log-rank test, the proportional-hazards score test).

Used from a run's own script:

    from analysis_methods import compare_groups, cox_regression
    results = {"schemaVersion": 1, "analyses": [compare_groups(df["bp"], df["arm"], contrast=("drug", "placebo")),
                                                 cox_regression(df["days"], df["died"], df[["age", "arm_drug"]])]}
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import math
import platform
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from scipy import optimize, stats

RECORDS_FILE = "analysis_method_records.json"
MODULE_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
_RECORDS: dict[str, Any] | None = None

NOTICE, WARNING = "notice", "warning"
Z_975 = 1.959963984540054


# -- records, identity, environment -----------------------------------------------------------------------

def method_records() -> dict[str, Any]:
    """The method records shipped beside this module (read once)."""
    global _RECORDS
    if _RECORDS is None:
        loaded = json.loads(Path(__file__).with_name(RECORDS_FILE).read_text(encoding="utf-8"))
        if not isinstance(loaded, dict) or loaded.get("schemaVersion") != 1 or not isinstance(loaded.get("methods"), dict):
            raise ValueError("The analysis method records are unreadable.")
        _RECORDS = loaded["methods"]
    return _RECORDS


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def method_identity(method: str) -> dict[str, str]:
    """The record's id, version and digest, and the digest of this file: what a result says it ran."""
    record = method_records()[method]
    return {"id": method, "version": record["version"], "digest": hashlib.sha256(_canonical(record)).hexdigest(),
            "codeSha256": MODULE_SHA256}


def environment() -> dict[str, Any]:
    """The interpreter and library versions this result was computed on."""
    versions = {}
    for name in ("numpy", "scipy", "pandas", "statsmodels"):
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    return {"python": platform.python_version(), "implementation": platform.python_implementation(),
            "platform": sys.platform, "machine": platform.machine(), "packages": versions}


def _diagnostic(code: str, severity: str, **detail: Any) -> dict[str, Any]:
    return {"code": code, "severity": severity, **({"detail": detail} if detail else {})}


def _finite(value: Any) -> float | None:
    """A float, or None for anything that is not finite: a non-finite estimate is never reported."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _entry(method: str, label: str | None, *, status: str = "complete", estimand: str, n: dict[str, Any],
           estimate: float | None = None, interval: tuple[float, float] | None = None, level: float = 0.95,
           p_value: float | None = None, values: dict[str, Any] | None = None, diagnostics: list[dict[str, Any]] | None = None,
           reason: str | None = None) -> dict[str, Any]:
    diagnostics = diagnostics or []
    low, high = (None, None) if interval is None else (_finite(interval[0]), _finite(interval[1]))
    return {"id": label or method, "status": status, "method": method, "estimand": estimand, "n": n,
            "estimate": _finite(estimate), "interval": None if low is None and high is None else {"lower": low, "upper": high, "level": level},
            "pValue": _finite(p_value), "values": values or {},
            "warnings": [item["code"] for item in diagnostics if item["severity"] == WARNING],
            "diagnostics": diagnostics, **({"reason": reason} if reason else {}),
            "methodRecord": method_identity(method), "seeded": False, "seed": None, "environment": environment()}


def _declined(method: str, label: str | None, code: str, *, estimand: str | None = None, n: dict[str, Any] | None = None,
              diagnostics: list[dict[str, Any]] | None = None, **detail: Any) -> dict[str, Any]:
    """This one computation declined, under the record's name for why. The caller keeps every other result."""
    record = method_records()[method]
    refusal = next((item for item in record["refusals"] if item["code"] == code), None)
    if refusal is None:
        raise ValueError(f"{code} is not a refusal of {method}")
    entry = _entry(method, label, status="unsupported", estimand=estimand or record["estimand"], n=n or {},
                   diagnostics=[*(diagnostics or []), _diagnostic(code, WARNING, **detail)], reason=code)
    entry["message"] = refusal["when"]
    return entry


# -- reading the data -----------------------------------------------------------------------------------------

def _series(value: Any, name: str) -> pd.Series:
    if isinstance(value, pd.Series):
        return value.reset_index(drop=True).rename(name)
    return pd.Series(list(value) if not isinstance(value, np.ndarray) else value.tolist(), name=name)


def _frame(columns: dict[str, Any]) -> pd.DataFrame:
    frame = pd.DataFrame({name: _series(value, name) for name, value in columns.items()})
    if len({len(_series(value, name)) for name, value in columns.items()}) != 1:
        raise ValueError("every column must have the same number of rows")
    return frame


def _design(X: Any, names: list[str] | None) -> pd.DataFrame:
    if isinstance(X, pd.Series):
        X = X.to_frame()
    if isinstance(X, pd.DataFrame):
        frame = X.reset_index(drop=True).copy()
    else:
        array = np.asarray(X, dtype=object)
        if array.ndim == 1:
            array = array.reshape(-1, 1)
        frame = pd.DataFrame(array, columns=names or [f"x{index + 1}" for index in range(array.shape[1])])
    if names and len(names) == frame.shape[1]:
        frame.columns = names
    frame.columns = [str(column) for column in frame.columns]
    return frame.apply(pd.to_numeric, errors="coerce")


def _missing_diagnostics(before: int, after: int, groups_before: pd.Series | None = None, groups_after: pd.Series | None = None) -> list[dict[str, Any]]:
    found = []
    if after < before:
        found.append(_diagnostic("missing_values_dropped", NOTICE, rowsDropped=before - after, rowsKept=after, rowsRead=before))
        if groups_before is not None and groups_after is not None and len(groups_before.dropna().unique()) >= 2:
            read = groups_before.value_counts()
            kept = groups_after.value_counts()
            share = {level: 1 - kept.get(level, 0) / read[level] for level in read.index}
            if max(share.values()) - min(share.values()) > 0.10:
                found.append(_diagnostic("missingness_differs_by_group", WARNING,
                                         share={str(level): round(float(value), 4) for level, value in share.items()}))
    return found


def _family(family_size: int) -> list[dict[str, Any]]:
    return [_diagnostic("multiplicity_unadjusted", NOTICE, tests=int(family_size))] if family_size and family_size > 1 else []


def _balance(groups: pd.Series, covariates: pd.DataFrame | None, levels: list) -> list[dict[str, Any]]:
    """`covariate_imbalance`, when the groups compared differ on a covariate by more than a tenth of a standard deviation."""
    if covariates is None:
        return []
    result = covariate_balance(groups.reset_index(drop=True), covariates.reset_index(drop=True), contrast=(levels[0], levels[1]))
    imbalanced = [row for row in result["values"].get("covariates", []) if row["standardizedDifference"] is not None and abs(row["standardizedDifference"]) > 0.1]
    return [_diagnostic("covariate_imbalance", WARNING, covariates={row["name"]: round(row["standardizedDifference"], 4) for row in imbalanced},
                        threshold=0.1)] if imbalanced else []


# -- two groups ---------------------------------------------------------------------------------------------------

def compare_groups(values: Any, groups: Any, *, contrast: tuple[Any, Any] | None = None, test: str = "welch",
                   subject: Any = None, aggregate_subjects: bool = False, covariates: Any = None,
                   family_size: int = 1, level: float = 0.95, label: str | None = None) -> dict[str, Any]:
    """Compare a continuous outcome between two groups: mean(first) - mean(second).

    `test` is "welch" (default), "student", "paired" or "mann_whitney". A `subject` column names the
    person each row belongs to: a person in both groups is a pairing, and a person with several rows in
    one group is repeated measurement, which an independent-groups test cannot take; pass
    `aggregate_subjects=True` to compare each person's mean instead.
    """
    method = "compare_groups"
    data = {"value": values, "group": groups, **({"subject": subject} if subject is not None else {})}
    frame = _frame(data)
    frame["value"] = pd.to_numeric(frame["value"], errors="coerce")
    rows = len(frame)
    kept = frame.dropna(subset=["value", "group"] + (["subject"] if subject is not None else []))
    diagnostics = _missing_diagnostics(rows, len(kept), frame["group"], kept["group"])
    levels = sorted(kept["group"].unique(), key=str)
    if len(levels) != 2:
        return _declined(method, label, "not_two_groups", n={"rows": len(kept)}, diagnostics=diagnostics, groups=len(levels))
    first, second = contrast if contrast is not None else (levels[0], levels[1])
    if {first, second} != set(levels):
        return _declined(method, label, "not_two_groups", n={"rows": len(kept)}, diagnostics=diagnostics, groups=len(levels))
    if contrast is None:
        diagnostics.append(_diagnostic("contrast_direction_inferred", NOTICE, difference=f"{first} - {second}"))
    estimand = f"mean({first}) - mean({second}) of the outcome"
    diagnostics += _balance(kept["group"], _design(covariates, None).iloc[kept.index.to_numpy()] if covariates is not None else None, [first, second])

    if subject is not None:
        per = kept.groupby("subject")["group"].nunique()
        if test != "paired" and (per > 1).any():
            return _declined(method, label, "crossed_subjects", estimand=estimand, n={"rows": len(kept)}, diagnostics=diagnostics, subjects=int((per > 1).sum()))
        within = kept.groupby(["subject", "group"]).size()
        if test != "paired" and (within > 1).any():
            if not aggregate_subjects:
                return _declined(method, label, "repeated_measurements", estimand=estimand, n={"rows": len(kept)}, diagnostics=diagnostics,
                                 subjectsWithRepeats=int((within > 1).groupby(level="subject").any().sum()))
            kept = kept.groupby(["subject", "group"], as_index=False)["value"].mean()
            diagnostics.append(_diagnostic("subject_means_used", NOTICE, subjects=int(kept["subject"].nunique())))
        if test == "paired":
            wide = kept.pivot_table(index="subject", columns="group", values="value", aggfunc="mean")
            if not {first, second} <= set(wide.columns) or wide[[first, second]].isna().any().any() or (kept.groupby(["subject", "group"]).size() > 1).any():
                return _declined(method, label, "unpaired_subjects", estimand=estimand, n={"rows": len(kept)}, diagnostics=diagnostics)
    elif test == "paired":
        return _declined(method, label, "unpaired_subjects", estimand=estimand, n={"rows": len(kept)}, diagnostics=diagnostics)

    sample = {value: kept.loc[kept["group"] == value, "value"].to_numpy(dtype=float) for value in (first, second)}
    n = {str(first): len(sample[first]), str(second): len(sample[second])}
    if min(n.values()) < 2:
        return _declined(method, label, "group_too_small", estimand=estimand, n=n, diagnostics=diagnostics)
    if test != "paired" and np.var(sample[first], ddof=1) == 0 and np.var(sample[second], ddof=1) == 0:
        return _declined(method, label, "zero_variance", estimand=estimand, n=n, diagnostics=diagnostics)
    if min(n.values()) < 10:
        diagnostics.append(_diagnostic("small_group", NOTICE, smallest=min(n.values())))
    if max(n.values()) > 3 * min(n.values()):
        diagnostics.append(_diagnostic("unequal_group_sizes", NOTICE, sizes=n))
    diagnostics += _family(family_size)

    means = {str(key): float(np.mean(sample[key])) for key in sample}
    sds = {str(key): float(np.std(sample[key], ddof=1)) for key in sample}
    difference = float(np.mean(sample[first]) - np.mean(sample[second]))
    values_out: dict[str, Any] = {"means": means, "sds": sds, "difference": difference, "test": test}
    interval = None
    if test in {"welch", "student"}:
        result = stats.ttest_ind(sample[first], sample[second], equal_var=test == "student")
        ci = result.confidence_interval(confidence_level=level)
        interval, statistic, p_value = (float(ci.low), float(ci.high)), float(result.statistic), float(result.pvalue)
        values_out["t"], values_out["df"] = statistic, float(result.df)
        pooled = math.sqrt(((n[str(first)] - 1) * sds[str(first)] ** 2 + (n[str(second)] - 1) * sds[str(second)] ** 2) / (sum(n.values()) - 2))
        if pooled > 0:
            df = sum(n.values()) - 2
            correction = math.exp(math.lgamma(df / 2) - 0.5 * math.log(df / 2) - math.lgamma((df - 1) / 2))
            values_out["hedgesG"] = difference / pooled * correction
    elif test == "paired":
        wide = kept.pivot_table(index="subject", columns="group", values="value", aggfunc="mean")
        pairs = wide[first].to_numpy(dtype=float) - wide[second].to_numpy(dtype=float)
        if len(pairs) < 2 or np.var(pairs, ddof=1) == 0:
            return _declined(method, label, "zero_variance" if len(pairs) >= 2 else "group_too_small", estimand=estimand, n=n, diagnostics=diagnostics)
        result = stats.ttest_1samp(pairs, 0.0)
        ci = result.confidence_interval(confidence_level=level)
        interval, statistic, p_value = (float(ci.low), float(ci.high)), float(result.statistic), float(result.pvalue)
        values_out.update(t=statistic, df=float(len(pairs) - 1), pairs=len(pairs))
        n = {"pairs": len(pairs), **n}
    elif test == "mann_whitney":
        result = stats.mannwhitneyu(sample[first], sample[second], use_continuity=True, alternative="two-sided", method="auto")
        statistic, p_value = float(result.statistic), float(result.pvalue)
        values_out["U"] = statistic
        diagnostics.append(_diagnostic("mean_difference_is_descriptive", NOTICE))
    else:
        raise ValueError("test must be welch, student, paired or mann_whitney")
    return _entry(method, label, estimand=estimand, n=n, estimate=difference, interval=interval, level=level, p_value=p_value,
                  values=values_out, diagnostics=diagnostics)


def covariate_balance(groups: Any, covariates: Any, *, contrast: tuple[Any, Any] | None = None, label: str | None = None) -> dict[str, Any]:
    """Standardized mean difference of each covariate between two groups (Austin 2009: |d| above 0.1 is imbalance).

    d = (mean1 - mean0) / sqrt((s1^2 + s0^2) / 2). A comparison between groups that differ this much on
    something that also drives the outcome is confounded, whatever its p value says.
    """
    method = "covariate_balance"
    grouping = _series(groups, "group")
    design = _design(covariates, None)
    levels = sorted(grouping.dropna().unique(), key=str)
    if len(levels) != 2 or (contrast is not None and set(contrast) != set(levels)):
        return _declined(method, label, "not_two_groups", n={"rows": len(grouping)}, groups=len(levels))
    first, second = contrast if contrast is not None else (levels[0], levels[1])
    rows = []
    for name in design.columns:
        a = design.loc[grouping == first, name].dropna().to_numpy(dtype=float)
        b = design.loc[grouping == second, name].dropna().to_numpy(dtype=float)
        if len(a) < 2 or len(b) < 2:
            rows.append({"name": name, "standardizedDifference": None, "reason": "too_few_observations"})
            continue
        pooled = math.sqrt((np.var(a, ddof=1) + np.var(b, ddof=1)) / 2)
        rows.append({"name": name, "meanFirst": float(np.mean(a)), "meanSecond": float(np.mean(b)),
                     "standardizedDifference": float((np.mean(a) - np.mean(b)) / pooled) if pooled > 0 else None})
    worst = max((abs(row["standardizedDifference"]) for row in rows if row["standardizedDifference"] is not None), default=None)
    diagnostics = []
    if worst is not None and worst > 0.1:
        diagnostics.append(_diagnostic("covariate_imbalance", WARNING, largest=worst, threshold=0.1))
    return _entry(method, label, estimand=f"standardized difference {first} - {second}, per covariate", n={"rows": int(grouping.notna().sum())},
                  estimate=worst, values={"covariates": rows, "contrast": [str(first), str(second)]}, diagnostics=diagnostics)


# -- contingency tables ---------------------------------------------------------------------------------------

def contingency_test(table: Any, *, correct_zero_cells: bool = False, family_size: int = 1, level: float = 0.95,
                     label: str | None = None) -> dict[str, Any]:
    """Association in a table of counts; rows are groups, columns outcomes (the event is the first column).

    A 2 x 2 table also gets the odds ratio (Woolf interval and the conditional estimate with its exact
    interval), the risk ratio (Katz interval), the risk difference (Wald interval), Pearson's chi-square
    (and Yates'), and Fisher's exact p value. A table with a zero cell is given no ratio unless
    `correct_zero_cells=True` adds 0.5 to every cell (and says so); the tests that do not need a ratio still run.
    """
    method = "contingency_test"
    try:
        counts = np.asarray(table, dtype=float)
    except (TypeError, ValueError):
        return _declined(method, label, "invalid_counts")
    if counts.ndim != 2 or min(counts.shape) < 2 or not np.isfinite(counts).all() or (counts < 0).any() or (counts != np.round(counts)).any():
        return _declined(method, label, "invalid_counts", shape=list(counts.shape) if counts.ndim else [])
    n = {"total": int(counts.sum()), "rows": int(counts.shape[0]), "columns": int(counts.shape[1])}
    if (counts.sum(axis=0) == 0).any() or (counts.sum(axis=1) == 0).any():
        return _declined(method, label, "empty_margin", n=n)
    diagnostics = _family(family_size)
    expected = counts.sum(axis=1)[:, None] * counts.sum(axis=0)[None, :] / counts.sum()
    smallest = float(expected.min())
    if smallest < 5:
        diagnostics.append(_diagnostic("expected_count_below_5", WARNING, smallestExpected=smallest, cellsBelow5=int((expected < 5).sum())))
    if counts.sum() < 20:
        diagnostics.append(_diagnostic("small_total", NOTICE, total=int(counts.sum())))
    pearson = stats.chi2_contingency(counts, correction=False)
    values: dict[str, Any] = {"pearsonChi2": float(pearson.statistic), "pearsonDf": int(pearson.dof), "pearsonP": float(pearson.pvalue),
                              "expected": expected.tolist(), "primaryTest": "pearson" if smallest >= 5 else ("fisher_exact" if counts.shape == (2, 2) else "pearson")}
    cramers = math.sqrt(pearson.statistic / (counts.sum() * (min(counts.shape) - 1)))
    values["cramersV"] = cramers
    if counts.shape != (2, 2):
        return _entry(method, label, estimand="association between row group and outcome category (no single effect size)", n=n,
                      estimate=cramers, p_value=float(pearson.pvalue), values=values, diagnostics=diagnostics)
    a, b, c, d = (float(counts[0, 0]), float(counts[0, 1]), float(counts[1, 0]), float(counts[1, 1]))
    values["yatesChi2"] = float(stats.chi2_contingency(counts, correction=True).statistic)
    fisher = stats.fisher_exact(counts, alternative="two-sided")
    values["fisherP"] = float(fisher.pvalue)
    try:
        conditional = stats.contingency.odds_ratio(counts.astype(int), kind="conditional")
        ci = conditional.confidence_interval(confidence_level=level)
        values["conditionalOddsRatio"] = _finite(conditional.statistic)
        values["conditionalOddsRatioInterval"] = [_finite(ci.low), _finite(ci.high)]
    except (ValueError, RuntimeError):  # no conditional estimate (a zero margin cell): the other results stand
        values["conditionalOddsRatio"], values["conditionalOddsRatioInterval"] = None, [None, None]
    cells = (a, b, c, d)
    estimable = all(cell > 0 for cell in cells)
    if not estimable:
        if correct_zero_cells:
            a, b, c, d = (cell + 0.5 for cell in cells)
            diagnostics.append(_diagnostic("zero_cell_corrected", NOTICE, increment=0.5))
        else:
            diagnostics.append(_diagnostic("zero_cell_ratio_not_estimable", WARNING))
    z = stats.norm.ppf(1 - (1 - level) / 2)
    if estimable or correct_zero_cells:
        odds = (a * d) / (b * c)
        se_log_or = math.sqrt(1 / a + 1 / b + 1 / c + 1 / d)
        risk_ratio = (a / (a + b)) / (c / (c + d))
        se_log_rr = math.sqrt(1 / a - 1 / (a + b) + 1 / c - 1 / (c + d))
        values.update(oddsRatio=odds, oddsRatioInterval=[math.exp(math.log(odds) - z * se_log_or), math.exp(math.log(odds) + z * se_log_or)],
                      riskRatio=risk_ratio, riskRatioInterval=[math.exp(math.log(risk_ratio) - z * se_log_rr), math.exp(math.log(risk_ratio) + z * se_log_rr)])
    else:
        values.update(oddsRatio=None, oddsRatioInterval=None, riskRatio=None, riskRatioInterval=None)
    p1, p2 = counts[0, 0] / counts[0].sum(), counts[1, 0] / counts[1].sum()
    se_rd = math.sqrt(p1 * (1 - p1) / counts[0].sum() + p2 * (1 - p2) / counts[1].sum())
    values.update(riskDifference=float(p1 - p2), riskDifferenceInterval=[float(p1 - p2 - z * se_rd), float(p1 - p2 + z * se_rd)])
    p_value = values["fisherP"] if values["primaryTest"] == "fisher_exact" else values["pearsonP"]
    return _entry(method, label, status="complete" if values["oddsRatio"] is not None else "partial",
                  estimand="odds ratio of the event, first row against second (rows are groups, the event is the first column)", n=n,
                  estimate=values["oddsRatio"], interval=tuple(values["oddsRatioInterval"]) if values["oddsRatioInterval"] else None, level=level,
                  p_value=p_value, values=values, diagnostics=diagnostics, reason=None if values["oddsRatio"] is not None else "zero_cell_ratio_not_estimable")


# -- regression ---------------------------------------------------------------------------------------------------

def _regression_inputs(y, X, names, subject, cluster):
    """Outcome and predictors with complete rows only, the cluster of each kept row, and what was dropped."""
    outcome = _series(y, "y")
    design = _design(X, names)
    if len(outcome) != len(design):
        raise ValueError("y and X must have the same number of rows")
    frame = pd.concat([pd.to_numeric(outcome, errors="coerce").rename("y"), design], axis=1)
    group = cluster if cluster is not None else subject
    group_series = _series(group, "cluster") if group is not None else None
    if group_series is not None and len(group_series) != len(frame):
        raise ValueError("the subject or cluster column must have the same number of rows as y")
    drop = frame.isna().any(axis=1) | (group_series.isna() if group_series is not None else False)
    kept = frame[~drop]
    diagnostics = _missing_diagnostics(len(frame), len(kept))
    clusters = group_series[~drop].reset_index(drop=True) if group_series is not None else None
    return kept.reset_index(drop=True), clusters, diagnostics


def _coefficient_table(names, beta, se, df, level, *, normal: bool):
    critical = stats.norm.ppf(1 - (1 - level) / 2) if normal else stats.t.ppf(1 - (1 - level) / 2, df)
    rows = []
    for name, b, s in zip(names, beta, se):
        statistic = b / s if s > 0 else float("nan")
        p = 2 * (stats.norm.sf(abs(statistic)) if normal else stats.t.sf(abs(statistic), df)) if math.isfinite(statistic) else float("nan")
        rows.append({"name": name, "estimate": float(b), "se": float(s), "statistic": _finite(statistic), "pValue": _finite(p),
                     "lower": float(b - critical * s), "upper": float(b + critical * s)})
    return rows


def linear_regression(y: Any, X: Any, *, names: list[str] | None = None, subject: Any = None, cluster: Any = None,
                      treat_rows_as_independent: bool = False, family_size: int = 1, level: float = 0.95,
                      label: str | None = None) -> dict[str, Any]:
    """Ordinary least squares with an intercept. `subject` names the person each row belongs to.

    A person with several rows is repeated measurement: unless `treat_rows_as_independent=True` the standard
    errors are cluster-robust (CR1, one cluster per subject, t with clusters - 1 degrees of freedom) rather than
    those of independent rows. Predictors that are collinear, or fewer observations than parameters, are declined.
    """
    import statsmodels.api as sm
    from statsmodels.stats.diagnostic import het_breuschpagan
    method = "linear_regression"
    frame, clusters, diagnostics = _regression_inputs(y, X, names, subject, cluster)
    predictors = [column for column in frame.columns if column != "y"]
    n_obs, parameters = len(frame), len(predictors) + 1
    n = {"observations": n_obs, "parameters": parameters}
    estimand = "change in the mean of y per unit of each predictor, holding the others fixed"
    if n_obs <= parameters:
        return _declined(method, label, "too_few_observations", estimand=estimand, n=n, diagnostics=diagnostics)
    exog = sm.add_constant(frame[predictors], has_constant="add")
    if np.linalg.matrix_rank(exog.to_numpy(dtype=float)) < parameters:
        return _declined(method, label, "collinear_predictors", estimand=estimand, n=n, diagnostics=diagnostics)
    use_cluster = clusters is not None and clusters.nunique() < len(clusters) and not treat_rows_as_independent
    if clusters is not None and clusters.nunique() < len(clusters) and treat_rows_as_independent:
        diagnostics.append(_diagnostic("repeated_measurements_ignored", WARNING, subjects=int(clusters.nunique()), rows=int(len(clusters))))
    if use_cluster and clusters.nunique() < 2:
        return _declined(method, label, "too_few_observations", estimand=estimand, n={**n, "clusters": int(clusters.nunique())}, diagnostics=diagnostics)
    fit = sm.OLS(frame["y"].to_numpy(dtype=float), exog.to_numpy(dtype=float)).fit()
    if use_cluster:
        robust = sm.OLS(frame["y"].to_numpy(dtype=float), exog.to_numpy(dtype=float)).fit(cov_type="cluster", cov_kwds={"groups": pd.factorize(clusters)[0]})
        se, df = np.asarray(robust.bse), int(clusters.nunique()) - 1
        diagnostics.append(_diagnostic("cluster_robust_se_used", NOTICE, clusters=int(clusters.nunique()), rows=n_obs))
        n["clusters"] = int(clusters.nunique())
    else:
        se, df = np.asarray(fit.bse), int(fit.df_resid)
    if n_obs / parameters < 10:
        diagnostics.append(_diagnostic("few_observations_per_parameter", WARNING, perParameter=round(n_obs / parameters, 2)))
    vifs = {}
    matrix = exog.to_numpy(dtype=float)
    for index, name in enumerate(["const", *predictors]):
        if index == 0 or parameters < 3:
            continue
        others = np.delete(matrix, index, axis=1)
        r2 = 1 - np.sum((matrix[:, index] - others @ np.linalg.lstsq(others, matrix[:, index], rcond=None)[0]) ** 2) / np.sum((matrix[:, index] - matrix[:, index].mean()) ** 2)
        vifs[name] = float(1 / (1 - r2)) if r2 < 1 else float("inf")
    high = {name: round(value, 2) for name, value in vifs.items() if value > 10}
    if high:
        diagnostics.append(_diagnostic("high_collinearity", WARNING, varianceInflation=high))
    try:
        breusch = het_breuschpagan(fit.resid, matrix)
        if breusch[1] < 0.05:
            diagnostics.append(_diagnostic("heteroscedasticity", NOTICE, breuschPaganP=float(breusch[1])))
    except Exception:  # a diagnostic that cannot run says nothing; the fit stands
        pass
    cooks = fit.get_influence().cooks_distance[0]
    influential = int((cooks > 4 / n_obs).sum())
    if influential:
        diagnostics.append(_diagnostic("influential_observations", NOTICE, count=influential, rule="Cook's distance above 4/n"))
    diagnostics += _family(family_size)
    table = _coefficient_table(["const", *predictors], fit.params, se, df, level, normal=False)
    primary = table[1] if len(table) > 1 else table[0]
    values = {"coefficients": table, "rSquared": float(fit.rsquared), "adjustedRSquared": float(fit.rsquared_adj),
              "residualStandardError": float(math.sqrt(fit.scale)), "residualDf": int(fit.df_resid),
              "fStatistic": _finite(fit.fvalue), "fPValue": _finite(fit.f_pvalue), "varianceInflation": vifs}
    return _entry(method, label, estimand=estimand, n=n, estimate=primary["estimate"], interval=(primary["lower"], primary["upper"]), level=level,
                  p_value=primary["pValue"], values=values, diagnostics=diagnostics)


def _separates(outcome: np.ndarray, matrix: np.ndarray) -> bool:
    """Whether some linear combination of the predictors puts every event on one side and every non-event on the other
    (complete, or quasi-complete, separation): then the maximum likelihood estimate does not exist (Konis 2007)."""
    signs = np.where(outcome > 0, 1.0, -1.0)
    margins = signs[:, None] * matrix
    columns = matrix.shape[1]
    result = optimize.linprog(c=-margins.sum(axis=0), A_ub=-margins, b_ub=np.zeros(len(outcome)), bounds=[(-1, 1)] * columns, method="highs")
    return bool(result.success and -result.fun > 1e-8)


def logistic_regression(y: Any, X: Any, *, names: list[str] | None = None, subject: Any = None, cluster: Any = None,
                        treat_rows_as_independent: bool = False, family_size: int = 1, level: float = 0.95,
                        label: str | None = None) -> dict[str, Any]:
    """Logistic regression of a 0/1 outcome (1 = event) with an intercept, by maximum likelihood.

    A model whose maximum likelihood estimate does not exist (perfect or quasi-perfect separation, collinear
    predictors, an outcome with a single value) is declined, not fitted to a coefficient of 20 and reported.
    Repeated measurements by `subject` get cluster-robust standard errors, as in `linear_regression`.
    """
    import statsmodels.api as sm
    method = "logistic_regression"
    frame, clusters, diagnostics = _regression_inputs(y, X, names, subject, cluster)
    predictors = [column for column in frame.columns if column != "y"]
    n = {"observations": len(frame), "parameters": len(predictors) + 1}
    estimand = "log odds ratio of the event per unit of each predictor, holding the others fixed (reported as odds ratios)"
    outcome = frame["y"].to_numpy(dtype=float)
    if not set(np.unique(outcome)) <= {0.0, 1.0}:
        return _declined(method, label, "outcome_not_binary", estimand=estimand, n=n, diagnostics=diagnostics)
    events = int(outcome.sum())
    n.update(events=events, nonEvents=int(len(outcome) - events))
    if events == 0 or events == len(outcome):
        return _declined(method, label, "outcome_has_one_value", estimand=estimand, n=n, diagnostics=diagnostics)
    exog = sm.add_constant(frame[predictors], has_constant="add")
    matrix = exog.to_numpy(dtype=float)
    if len(frame) <= matrix.shape[1] or np.linalg.matrix_rank(matrix) < matrix.shape[1]:
        return _declined(method, label, "collinear_predictors", estimand=estimand, n=n, diagnostics=diagnostics)
    if _separates(outcome, matrix):
        return _declined(method, label, "separation", estimand=estimand, n=n, diagnostics=diagnostics)
    per_variable = min(events, len(outcome) - events) / max(1, len(predictors))
    if per_variable < 10:
        diagnostics.append(_diagnostic("few_events_per_variable", WARNING, eventsPerVariable=round(per_variable, 2)))
    use_cluster = clusters is not None and clusters.nunique() < len(clusters) and not treat_rows_as_independent
    if clusters is not None and clusters.nunique() < len(clusters) and treat_rows_as_independent:
        diagnostics.append(_diagnostic("repeated_measurements_ignored", WARNING, subjects=int(clusters.nunique()), rows=int(len(clusters))))
    model = sm.Logit(outcome, matrix)
    fit = model.fit(method="newton", maxiter=100, disp=0, tol=1e-12) if not use_cluster else model.fit(
        method="newton", maxiter=100, disp=0, tol=1e-12, cov_type="cluster", cov_kwds={"groups": pd.factorize(clusters)[0]})
    if not bool(fit.mle_retvals.get("converged", False)):
        return _declined(method, label, "did_not_converge", estimand=estimand, n=n, diagnostics=diagnostics)
    if use_cluster:
        diagnostics.append(_diagnostic("cluster_robust_se_used", NOTICE, clusters=int(clusters.nunique()), rows=len(frame)))
        n["clusters"] = int(clusters.nunique())
    diagnostics += _family(family_size)
    table = _coefficient_table(["const", *predictors], fit.params, np.asarray(fit.bse), None, level, normal=True)
    for row in table:
        row["oddsRatio"], row["oddsRatioLower"], row["oddsRatioUpper"] = math.exp(row["estimate"]), math.exp(row["lower"]), math.exp(row["upper"])
    primary = table[1] if len(table) > 1 else table[0]
    values = {"coefficients": table, "logLikelihood": float(fit.llf), "nullLogLikelihood": float(fit.llnull), "aic": float(fit.aic),
              "likelihoodRatioChi2": float(2 * (fit.llf - fit.llnull)), "likelihoodRatioP": float(stats.chi2.sf(2 * (fit.llf - fit.llnull), len(predictors))) if predictors else None}
    return _entry(method, label, estimand=estimand, n=n, estimate=primary["estimate"], interval=(primary["lower"], primary["upper"]), level=level,
                  p_value=primary["pValue"], values=values, diagnostics=diagnostics)


# -- survival -------------------------------------------------------------------------------------------------------

def _survival_inputs(method, label, time, event, group=None, covariates=None, names=None, cluster=None):
    data = {"time": time, "event": event, **({"group": group} if group is not None else {}), **({"cluster": cluster} if cluster is not None else {})}
    frame = _frame(data)
    frame["time"] = pd.to_numeric(frame["time"], errors="coerce")
    frame["event"] = pd.to_numeric(frame["event"], errors="coerce")
    design = _design(covariates, names) if covariates is not None else None
    if design is not None:
        if len(design) != len(frame):
            raise ValueError("covariates must have the same number of rows as time")
        frame = pd.concat([frame, design], axis=1)
    subset = ["time", "event"] + (["group"] if group is not None else []) + (list(design.columns) if design is not None else []) + (["cluster"] if cluster is not None else [])
    kept = frame.dropna(subset=subset).reset_index(drop=True)
    diagnostics = _missing_diagnostics(len(frame), len(kept), frame["group"] if group is not None else None, kept["group"] if group is not None else None)
    return kept, diagnostics


def _check_survival(method, label, kept, diagnostics, estimand, n):
    """The refusals every time-to-event method shares."""
    if len(kept) == 0:
        return _declined(method, label, "no_complete_rows", estimand=estimand, n=n, diagnostics=diagnostics)
    if not set(kept["event"].unique()) <= {0.0, 1.0}:
        return _declined(method, label, "event_not_binary", estimand=estimand, n=n, diagnostics=diagnostics,
                         values=sorted(str(value) for value in kept["event"].unique())[:5])
    if (kept["time"] < 0).any():
        return _declined(method, label, "negative_time", estimand=estimand, n=n, diagnostics=diagnostics)
    return None


def _survival_notes(kept: pd.DataFrame) -> list[dict[str, Any]]:
    found = []
    events = int(kept["event"].sum())
    censored = int(len(kept) - events)
    if len(kept) and censored / len(kept) > 0.5:
        found.append(_diagnostic("heavy_censoring", NOTICE, censoredShare=round(censored / len(kept), 4)))
    if events < 10:
        found.append(_diagnostic("few_events", WARNING, events=events))
    event_times = kept.loc[kept["event"] == 1, "time"]
    if event_times.duplicated().any():
        found.append(_diagnostic("tied_event_times", NOTICE, tiedTimes=int(event_times.duplicated().sum())))
    if (kept["time"] == 0).any():
        found.append(_diagnostic("zero_follow_up", NOTICE, rows=int((kept["time"] == 0).sum())))
    return found


def _km_curve(time: np.ndarray, event: np.ndarray, level: float, conf_type: str) -> dict[str, Any]:
    order = np.argsort(time, kind="stable")
    time, event = time[order], event[order]
    distinct = np.unique(time[event == 1])
    survival, rows, at_risk_total = 1.0, [], len(time)
    greenwood = 0.0
    z = stats.norm.ppf(1 - (1 - level) / 2)
    for point in distinct:
        at_risk = int((time >= point).sum())
        deaths = int(((time == point) & (event == 1)).sum())
        censored = int(((time == point) & (event == 0)).sum())
        survival *= 1 - deaths / at_risk
        greenwood += deaths / (at_risk * (at_risk - deaths)) if at_risk > deaths else float("inf")
        se_log = math.sqrt(greenwood) if math.isfinite(greenwood) else float("nan")
        se = survival * se_log if math.isfinite(se_log) else float("nan")
        if survival <= 0 or not math.isfinite(se_log):
            lower = upper = None
        elif conf_type == "log":
            lower, upper = survival * math.exp(-z * se_log), min(1.0, survival * math.exp(z * se_log))
        elif conf_type == "log-log":
            se_cll = se_log / abs(math.log(survival)) if survival < 1 else float("nan")
            lower = survival ** math.exp(z * se_cll) if math.isfinite(se_cll) else None
            upper = survival ** math.exp(-z * se_cll) if math.isfinite(se_cll) else None
        else:
            lower, upper = max(0.0, survival - z * se), min(1.0, survival + z * se)
        rows.append({"time": float(point), "atRisk": at_risk, "events": deaths, "censoredAtTime": censored, "survival": float(survival),
                     "se": _finite(se), "lower": lower, "upper": upper})
    return {"table": rows, "median": _km_quantile(rows, "survival"), "medianLower": _km_quantile(rows, "lower"), "medianUpper": _km_quantile(rows, "upper"),
            "n": int(at_risk_total), "events": int(event.sum()), "maxTime": float(time.max()) if len(time) else None}


def _km_quantile(rows: list[dict[str, Any]], key: str, p: float = 0.5) -> float | None:
    """The first time the curve is at or below p; where it sits exactly on p, the midpoint to the next event time (R's survfit)."""
    for index, row in enumerate(rows):
        value = row[key]
        if value is not None and value <= p + 1e-12:
            if abs(value - p) <= 1e-12 and index + 1 < len(rows):
                return (row["time"] + rows[index + 1]["time"]) / 2.0
            return row["time"]
    return None


def kaplan_meier(time: Any, event: Any, group: Any = None, *, conf_type: str = "log", level: float = 0.95,
                 label: str | None = None) -> dict[str, Any]:
    """Kaplan-Meier survival with Greenwood standard errors, the confidence band of `conf_type` ("log", "log-log" or
    "plain"; "log" is R's survfit default) and the median with its interval, per group.

    `event` is 1 for the event and 0 for censored; any other coding is declined (read an unrecognised "2" as
    an event and the curve answers a different question). The median is the first time the curve reaches 0.5
    or below, or None when it never does.
    """
    method = "kaplan_meier"
    kept, diagnostics = _survival_inputs(method, label, time, event, group)
    estimand = "survival function P(T > t), the median survival time, and the survival at each event time"
    n = {"rows": len(kept)}
    refused = _check_survival(method, label, kept, diagnostics, estimand, n)
    if refused:
        return refused
    diagnostics += _survival_notes(kept)
    keys = [None] if group is None else sorted(kept["group"].unique(), key=str)
    curves = {}
    for key in keys:
        part = kept if key is None else kept[kept["group"] == key]
        curve = _km_curve(part["time"].to_numpy(dtype=float), part["event"].to_numpy(dtype=float), level, conf_type)
        if curve["events"] == 0:
            diagnostics.append(_diagnostic("no_events_in_group", WARNING, group=None if key is None else str(key)))
        tail = curve["table"][-1]["atRisk"] if curve["table"] else None
        if tail is not None and tail < 10 and len(curve["table"]) > 1:
            diagnostics.append(_diagnostic("small_final_risk_set", NOTICE, group=None if key is None else str(key), atRisk=tail))
        curves["all" if key is None else str(key)] = curve
    first = next(iter(curves.values()))
    interval = None if first["medianLower"] is None or first["medianUpper"] is None else (first["medianLower"], first["medianUpper"])
    n = {"rows": len(kept), "events": int(kept["event"].sum()), "censored": int(len(kept) - kept["event"].sum())}
    reached = first["median"] is not None
    if not reached:
        diagnostics.append(_diagnostic("median_not_reached", NOTICE, group=next(iter(curves))))
    return _entry(method, label, status="complete" if reached else "partial", estimand=estimand, n=n, estimate=first["median"], interval=interval,
                  level=level, reason=None if reached else "median_not_reached",
                  values={"curves": curves, "confType": conf_type, "medianNote": "the first group's median is the headline; see curves for every group"},
                  diagnostics=diagnostics)


def log_rank(time: Any, event: Any, group: Any, *, strata: Any = None, label: str | None = None) -> dict[str, Any]:
    """The log-rank test (Mantel-Haenszel form, with the hypergeometric variance that handles tied event times)
    of equal hazards across two or more groups, optionally stratified.

    The statistic is (O - E)' V^-1 (O - E) on all but one group, chi-square on groups - 1 degrees of freedom, as
    R's survdiff. It tests whether the curves differ over follow-up and is most powerful when hazards are
    proportional; it is not an effect size.
    """
    method = "log_rank"
    data = {"time": time, "event": event, "group": group, **({"strata": strata} if strata is not None else {})}
    frame = _frame(data)
    frame["time"] = pd.to_numeric(frame["time"], errors="coerce")
    frame["event"] = pd.to_numeric(frame["event"], errors="coerce")
    kept = frame.dropna().reset_index(drop=True)
    diagnostics = _missing_diagnostics(len(frame), len(kept), frame["group"], kept["group"])
    estimand = "equality of the hazard functions of the groups over follow-up"
    n = {"rows": len(kept)}
    refused = _check_survival(method, label, kept, diagnostics, estimand, n)
    if refused:
        return refused
    levels = sorted(kept["group"].unique(), key=str)
    if len(levels) < 2:
        return _declined(method, label, "one_group", estimand=estimand, n=n, diagnostics=diagnostics)
    diagnostics += _survival_notes(kept)
    k = len(levels)
    observed, expected, variance = np.zeros(k), np.zeros(k), np.zeros((k, k))
    layers = [kept] if strata is None else [part for _, part in kept.groupby("strata")]
    for part in layers:
        times = part["time"].to_numpy(dtype=float)
        events = part["event"].to_numpy(dtype=float)
        membership = np.array([[value == level for level in levels] for value in part["group"]])
        for point in np.unique(times[events == 1]):
            at_risk = membership[times >= point].sum(axis=0).astype(float)
            died = membership[(times == point) & (events == 1)].sum(axis=0).astype(float)
            total, deaths = at_risk.sum(), died.sum()
            observed += died
            expected += deaths * at_risk / total
            if total > 1:
                factor = deaths * (total - deaths) / (total - 1)
                variance += factor * (np.diag(at_risk) / total - np.outer(at_risk, at_risk) / total ** 2)
    if observed.sum() == 0:
        return _declined(method, label, "no_events", estimand=estimand, n=n, diagnostics=diagnostics)
    difference = (observed - expected)[:-1]
    reduced = variance[:-1, :-1]
    if np.linalg.matrix_rank(reduced) < k - 1:
        return _declined(method, label, "singular_variance", estimand=estimand, n=n, diagnostics=diagnostics)
    statistic = float(difference @ np.linalg.solve(reduced, difference))
    p_value = float(stats.chi2.sf(statistic, k - 1))
    per_group = [{"group": str(level), "n": int((kept["group"] == level).sum()), "observed": float(observed[i]), "expected": float(expected[i])}
                 for i, level in enumerate(levels)]
    n = {"rows": len(kept), "events": int(kept["event"].sum()), "groups": k}
    return _entry(method, label, estimand=estimand, n=n, estimate=statistic, p_value=p_value,
                  values={"chiSquare": statistic, "df": k - 1, "groups": per_group, "stratified": strata is not None}, diagnostics=diagnostics)


def cox_regression(time: Any, event: Any, X: Any, *, names: list[str] | None = None, ties: str = "efron", cluster: Any = None,
                   strata: Any = None, family_size: int = 1, level: float = 0.95, label: str | None = None) -> dict[str, Any]:
    """Cox proportional hazards regression: hazard ratios with Wald intervals, the likelihood-ratio test, and a test of
    the proportional-hazards assumption for each covariate.

    `ties` is "efron" (R's default) or "breslow". `cluster` gives cluster-robust standard errors for repeated or
    clustered subjects. The assumption test is the score test of a time-varying coefficient on 1 - Kaplan-Meier
    (R's cox.zph(transform="km"), which replaced the Schoenfeld-residual form): a small p value says a hazard ratio is an average over a period in
    which it changed, and a large one does not show that it did not. A covariate with no events at one of its two
    levels has no finite hazard ratio and the model is declined; so are collinear covariates and fewer events than
    covariates.
    """
    from statsmodels.duration.hazard_regression import PHReg
    method = "cox_regression"
    kept, diagnostics = _survival_inputs(method, label, time, event, None, X, names, cluster)
    estimand = "log hazard ratio of the event per unit of each covariate, holding the others fixed (reported as hazard ratios)"
    n = {"rows": len(kept)}
    refused = _check_survival(method, label, kept, diagnostics, estimand, n)
    if refused:
        return refused
    covariates = [column for column in kept.columns if column not in {"time", "event", "cluster"}]
    events = int(kept["event"].sum())
    n.update(events=events, censored=int(len(kept) - events), covariates=len(covariates))
    if events == 0:
        return _declined(method, label, "no_events", estimand=estimand, n=n, diagnostics=diagnostics)
    if events <= len(covariates):
        return _declined(method, label, "more_covariates_than_events", estimand=estimand, n=n, diagnostics=diagnostics)
    matrix = kept[covariates].to_numpy(dtype=float)
    if np.linalg.matrix_rank(matrix - matrix.mean(axis=0)) < len(covariates):
        return _declined(method, label, "collinear_covariates", estimand=estimand, n=n, diagnostics=diagnostics)
    stratum = None if strata is None else pd.factorize(_series(strata, "strata").reindex(range(len(kept))))[0]
    for column in covariates:
        levels = np.unique(matrix[:, covariates.index(column)])
        if len(levels) == 2:
            with_events = [int(kept.loc[matrix[:, covariates.index(column)] == value, "event"].sum()) for value in levels]
            if min(with_events) == 0:
                return _declined(method, label, "no_events_in_a_level", estimand=estimand, n=n, diagnostics=diagnostics, covariate=column)
    if events / max(1, len(covariates)) < 10:
        diagnostics.append(_diagnostic("few_events_per_variable", WARNING, eventsPerVariable=round(events / len(covariates), 2)))
    diagnostics += _survival_notes(kept)
    diagnostics += _family(family_size)
    model = PHReg(kept["time"].to_numpy(dtype=float), matrix, status=kept["event"].to_numpy(dtype=float), ties=ties, strata=stratum)
    use_cluster = cluster is not None and kept["cluster"].nunique() < len(kept)
    fit = model.fit(disp=0, groups=pd.factorize(kept["cluster"])[0]) if use_cluster else model.fit(disp=0)
    if use_cluster:
        diagnostics.append(_diagnostic("cluster_robust_se_used", NOTICE, clusters=int(kept["cluster"].nunique()), rows=len(kept)))
        n["clusters"] = int(kept["cluster"].nunique())
    if not np.isfinite(fit.params).all() or not np.isfinite(fit.bse).all():
        return _declined(method, label, "did_not_converge", estimand=estimand, n=n, diagnostics=diagnostics)
    table = _coefficient_table(covariates, fit.params, np.asarray(fit.bse), None, level, normal=True)
    for row in table:
        row["hazardRatio"], row["hazardRatioLower"], row["hazardRatioUpper"] = math.exp(row["estimate"]), math.exp(row["lower"]), math.exp(row["upper"])
    null = PHReg(kept["time"].to_numpy(dtype=float), np.zeros((len(kept), 1)), status=kept["event"].to_numpy(dtype=float), ties=ties, strata=stratum).loglike(np.zeros(1))
    likelihood_ratio = float(2 * (fit.llf - null))
    values: dict[str, Any] = {"coefficients": table, "logLikelihood": float(fit.llf), "nullLogLikelihood": float(null), "ties": ties,
                              "likelihoodRatioChi2": likelihood_ratio, "likelihoodRatioDf": len(covariates),
                              "likelihoodRatioP": float(stats.chi2.sf(likelihood_ratio, len(covariates)))}
    if stratum is None and not use_cluster:
        zph = _proportional_hazards_test(kept["time"].to_numpy(dtype=float), kept["event"].to_numpy(dtype=float), matrix, np.asarray(fit.params), ties, covariates)
        values["proportionalHazards"] = zph
        offending = {row["name"]: round(row["pValue"], 6) for row in zph if row["name"] != "GLOBAL" and row["pValue"] < 0.05}
        if offending:
            diagnostics.append(_diagnostic("proportional_hazards_questioned", WARNING, covariates=offending))
    else:
        diagnostics.append(_diagnostic("proportional_hazards_not_tested", NOTICE, reason="stratified or cluster-robust fit"))
    primary = table[0]
    return _entry(method, label, estimand=estimand, n=n, estimate=primary["estimate"], interval=(primary["lower"], primary["upper"]), level=level,
                  p_value=primary["pValue"], values=values, diagnostics=diagnostics)


def _proportional_hazards_test(time: np.ndarray, status: np.ndarray, X: np.ndarray, beta: np.ndarray, ties: str, names: list[str]) -> list[dict[str, Any]]:
    """The score test of a time-varying coefficient, per covariate and for all of them, as R's `cox.zph(transform="km")`.

    At the fitted coefficients, the hazard exp(x'b) is widened to exp(x'b + c x_j g(t)) with g(t) = 1 - KM(t-) centred on
    its mean over the events, and the score test of c = 0 is u' I^-1 u on the partial likelihood's score u and information
    I, with the tie handling (Efron or Breslow) the model used. A small p value says the hazard ratio of that covariate
    changes over follow-up; a large one does not show that it does not.
    """
    n, p = X.shape
    events = np.unique(time[status == 1])
    survival, running = [], 1.0
    for point in events:
        running *= 1 - ((time == point) & (status == 1)).sum() / (time >= point).sum()
        survival.append(running)
    survival = np.array(survival)
    position = np.searchsorted(events, time, side="left")
    before = np.where(position > 0, survival[np.maximum(position - 1, 0)], 1.0)
    transformed = 1 - before
    centred = transformed - transformed[status == 1].mean()
    weight = np.exp(X @ beta)
    order = np.argsort(time, kind="stable")
    ts, ws, xs, ss, gs = time[order], weight[order], X[order], status[order], centred[order]
    outer = xs[:, :, None] * xs[:, None, :]
    risk0 = np.cumsum(ws[::-1])[::-1]
    risk1 = np.cumsum((ws[:, None] * xs)[::-1], axis=0)[::-1]
    risk2 = np.cumsum((ws[:, None, None] * outer)[::-1], axis=0)[::-1]
    rows = []
    for label, cols in [*((name, [j]) for j, name in enumerate(names)), ("GLOBAL", list(range(p)))]:
        k = len(cols)
        score, information = np.zeros(p + k), np.zeros((p + k, p + k))
        for point in events:
            start, stop = np.searchsorted(ts, point, side="left"), np.searchsorted(ts, point, side="right")
            died = ss[start:stop] == 1
            d = int(died.sum())
            g = gs[start]
            wd, xd = ws[start:stop][died], xs[start:stop][died]
            tied0, tied1 = wd.sum(), (wd[:, None] * xd).sum(axis=0)
            tied2 = (wd[:, None, None] * xd[:, :, None] * xd[:, None, :]).sum(axis=0)
            sum_x = xd.sum(axis=0)
            score += np.concatenate([sum_x, g * sum_x[cols]])
            for step in range(d if ties == "efron" else 1):
                fraction = step / d if ties == "efron" else 0.0
                repeat = 1 if ties == "efron" else d
                s0, s1, s2 = risk0[start] - fraction * tied0, risk1[start] - fraction * tied1, risk2[start] - fraction * tied2
                mean = np.concatenate([s1, g * s1[cols]]) / s0
                block = np.zeros((p + k, p + k))
                block[:p, :p] = s2
                block[:p, p:] = g * s2[:, cols]
                block[p:, :p] = g * s2[cols, :]
                block[p:, p:] = g * g * s2[np.ix_(cols, cols)]
                score -= repeat * mean
                information += repeat * (block / s0 - np.outer(mean, mean))
        statistic = float(score @ np.linalg.solve(information, score))
        rows.append({"name": label, "chiSquare": statistic, "df": k, "pValue": float(stats.chi2.sf(statistic, k))})
    return rows


# -- many tests -------------------------------------------------------------------------------------------------------

def adjust_pvalues(pvalues: Any, *, method: str = "holm", label: str | None = None) -> dict[str, Any]:
    """Adjust p values for the number of tests made: "bonferroni", "holm" (step-down, controls the family-wise error rate)
    or "bh" (Benjamini-Hochberg, controls the false discovery rate). The adjusted values come back in the order given."""
    record = "adjust_pvalues"
    p = pd.to_numeric(_series(pvalues, "p"), errors="coerce")
    if len(p) == 0 or p.isna().any() or ((p < 0) | (p > 1)).any():
        return _declined(record, label, "invalid_pvalues", n={"tests": len(p)})
    if method not in {"bonferroni", "holm", "bh"}:
        raise ValueError("method must be bonferroni, holm or bh")
    values = p.to_numpy(dtype=float)
    m = len(values)
    order = np.argsort(values, kind="stable")
    ranked = values[order]
    if method == "bonferroni":
        adjusted = np.minimum(1.0, ranked * m)
    elif method == "holm":
        adjusted = np.minimum(1.0, np.maximum.accumulate(ranked * (m - np.arange(m))))
    else:
        adjusted = np.minimum(1.0, np.minimum.accumulate((ranked * m / (np.arange(m) + 1))[::-1])[::-1])
    result = np.empty(m)
    result[order] = adjusted
    return _entry(record, label, estimand=f"{method} adjusted p values for {m} tests", n={"tests": m}, estimate=None,
                  values={"method": method, "adjusted": result.tolist(), "rejectedAt05": int((result <= 0.05).sum())})
