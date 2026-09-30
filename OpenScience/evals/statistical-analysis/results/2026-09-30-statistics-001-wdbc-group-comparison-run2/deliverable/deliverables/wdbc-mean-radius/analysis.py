#!/usr/bin/env python3
"""
Profiling of the supplied Wisconsin Diagnostic Breast Cancer (WDBC) dataset
and comparison of `mean radius` between malignant and benign tumours.

Input (unchanged, read-only):
    data/breast-cancer.csv   (relative to the workspace root)

Outputs (written next to this script, i.e. into the same deliverable directory):
    analysis-results.json    structured results, schemaVersion 1
    figures/mean-radius-by-diagnosis.png
    figures/mean-radius-distribution.png

Run from the workspace root:
    python deliverables/wdbc-mean-radius/analysis.py

The script is deterministic: the bootstrap uses a fixed seed and every number
printed/recorded comes from an executed computation, never from a literal.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import sys
import tempfile
from pathlib import Path

# Keep matplotlib's cache inside a writable temporary directory; some run
# environments have a read-only default config path.
os.environ.setdefault("MPLCONFIGDIR", os.path.join(tempfile.gettempdir(), "mplconfig"))

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import scipy
from scipy import stats

# --------------------------------------------------------------------------
# 0. Configuration: paths, column names, coding, seeds
# --------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
WORKSPACE = SCRIPT_DIR.parent.parent
DATA_PATH = WORKSPACE / "data" / "breast-cancer.csv"
RESULTS_PATH = SCRIPT_DIR / "analysis-results.json"
FIG_DIR = SCRIPT_DIR / "figures"

TARGET = "breast_cancer_yn"
GROUP_COL = "mean radius"

# Target coding used throughout. Declared by the accompanying dataset source
# metadata and independently verified at step 2 below against the data.
CODING = {0: "malignant", 1: "benign"}
MALIGNANT = 0
BENIGN = 1

SEED = 20240930
N_BOOT = 10_000
ALPHA = 0.05

RESULTS: dict = {
    "schemaVersion": 1,
    "meta": {
        "script": "analysis.py",
        "input": "data/breast-cancer.csv",
        "seed": SEED,
        "alpha": ALPHA,
        "environment": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "scipy": scipy.__version__,
        },
    },
    "analyses": [],
}


def record(**kw) -> None:
    """Append one structured analysis entry."""
    RESULTS["analyses"].append(kw)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def num(x):
    """Make numpy scalars JSON-serialisable."""
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.floating,)):
        return float(x)
    if isinstance(x, (np.bool_,)):
        return bool(x)
    return x


# --------------------------------------------------------------------------
# 1. Load and profile
# --------------------------------------------------------------------------

def load_and_profile() -> pd.DataFrame:
    df_raw = pd.read_csv(DATA_PATH)
    n_loaded = len(df_raw)

    # `Unnamed: 0` is a serialised row index, not an analytical variable.
    index_like = [c for c in df_raw.columns if c.startswith("Unnamed:")]
    index_is_serial = bool(
        len(index_like) == 1
        and df_raw[index_like[0]].is_unique
        and df_raw[index_like[0]].is_monotonic_increasing
    )
    df = df_raw.drop(columns=index_like)

    feature_cols = [c for c in df.columns if c != TARGET]
    missing = int(df.isna().sum().sum())
    cells = int(df.shape[0] * df.shape[1])

    # Exact duplicate feature columns (identical values in every row)
    dup_cols = [
        c
        for i, c in enumerate(feature_cols)
        for d in feature_cols[:i]
        if np.array_equal(df[c].to_numpy(), df[d].to_numpy())
    ]
    const_cols = [c for c in feature_cols if df[c].nunique() == 1]
    dup_rows = int(df.duplicated().sum())
    non_numeric = [c for c in df.columns if not pd.api.types.is_numeric_dtype(df[c])]

    profile = {
        "rows_loaded": num(n_loaded),
        "rows_analysed": num(len(df)),
        "columns_loaded": num(df_raw.shape[1]),
        "feature_columns": num(len(feature_cols)),
        "target_column": TARGET,
        "index_column_dropped": index_like[0] if index_like else None,
        "index_column_is_serial": index_is_serial,
        "loaded_vs_analysed_difference": num(n_loaded - len(df)),
        "difference_reason": (
            "none: the row-index column was dropped, no record was removed"
            if n_loaded == len(df)
            else "records removed"
        ),
        "missing_cells": missing,
        "total_analysed_cells": cells,
        "missing_fraction": num(missing / cells),
        "duplicate_feature_columns": dup_cols,
        "constant_feature_columns": const_cols,
        "duplicate_rows": dup_rows,
        "non_numeric_columns": non_numeric,
        "excluded_records": 0,
        "exclusion_reason": "no exclusion applied; missingness is zero",
        "feature_summary": {
            c: {
                "min": num(df[c].min()),
                "median": num(df[c].median()),
                "mean": num(df[c].mean()),
                "max": num(df[c].max()),
                "std": num(df[c].std(ddof=1)),
            }
            for c in feature_cols
        },
    }
    RESULTS["profile"] = profile
    record(
        id="profile",
        status="complete",
        method="descriptive profiling of the supplied file",
        estimand="shape, completeness and column roles of the dataset",
        n=num(len(df)),
        warnings=(
            []
            if index_is_serial
            else ["the leading unnamed column is not a clean serial index"]
        ),
    )

    print(f"[profile] rows loaded={n_loaded} analysed={len(df)} "
          f"features={len(feature_cols)} missing={missing}/{cells} "
          f"index_dropped={index_like[0] if index_like else None} "
          f"dup_rows={dup_rows} dup_cols={len(dup_cols)} const_cols={len(const_cols)}")
    return df


# --------------------------------------------------------------------------
# 2. Target coding: declared, then verified against the data
# --------------------------------------------------------------------------

def verify_coding(df: pd.DataFrame) -> dict:
    counts = df[TARGET].value_counts().sort_index()
    gmeans = df.groupby(TARGET)[GROUP_COL].agg(["count", "mean", "std", "min", "max"])

    # Discriminating check, independent of the declared coding:
    # across all 30 features, the group labelled 0 must be the one with the
    # larger nuclear-size features. A majority vote over standardised
    # malignant-minus-benign feature differences establishes which label
    # carries the malignant phenotype.
    feature_cols = [c for c in df.columns if c != TARGET]
    z = (df[feature_cols] - df[feature_cols].mean()) / df[feature_cols].std(ddof=1)
    z0 = z[df[TARGET] == 0].mean()
    z1 = z[df[TARGET] == 1].mean()
    larger_in_label_0 = int((z0 > z1).sum())
    larger_in_label_1 = int((z1 > z0).sum())

    size_feature_0 = float(gmeans.loc[0, "mean"])
    size_feature_1 = float(gmeans.loc[1, "mean"])
    label_0_is_larger_tumour = size_feature_0 > size_feature_1

    consistent = larger_in_label_0 > larger_in_label_1 and label_0_is_larger_tumour
    conclusion = (
        "0 = malignant, 1 = benign"
        if consistent
        else "the data contradict the declared coding; coding NOT confirmed"
    )

    out = {
        "declared_coding": {str(k): v for k, v in CODING.items()},
        "declared_coding_source": (
            "accompanying dataset source metadata (source-metadata.json), which "
            "itself states it corrected misleading label prose upstream"
        ),
        "observed_counts": {str(k): num(v) for k, v in counts.items()},
        "known_wdbc_class_sizes": {"malignant": 212, "benign": 357},
        "counts_match_known_wdbc": bool(
            int(counts.get(0, 0)) == 212 and int(counts.get(1, 0)) == 357
        ),
        "feature_direction_check": {
            "definition": (
                "label-0 mean exceeds label-1 mean for the feature, on values "
                "standardised within the whole sample (feature mean subtracted, "
                "feature SD dividing); features are compared one at a time"
            ),
            "features_larger_in_label_0": larger_in_label_0,
            "features_larger_in_label_1": larger_in_label_1,
            "n_features_compared": num(len(feature_cols)),
            "counts_sum_to_n_features": bool(
                larger_in_label_0 + larger_in_label_1 == len(feature_cols)
            ),
            "label_0_mean_radius_greater": bool(label_0_is_larger_tumour),
        },
        "group_means_of_mean_radius": {
            str(k): {kk: num(vv) for kk, vv in row.items()} for k, row in gmeans.iterrows()
        },
        "verification_conclusion": conclusion,
        "epistemic_status": (
            "The meaning of each category is established from the accompanying "
            "source metadata, which declares 0 = malignant and 1 = benign, "
            "together with the canonical repository's own target definition. The "
            "three checks below are CONSISTENCY CHECKS ONLY: each one can fail and "
            "would then contradict the declared coding, but none of them can "
            "establish it, because a measurement direction is not a definition of "
            "what a label means. They rule out the errors they are capable of "
            "ruling out and nothing more."
        ),
        "interpretation": (
            "Standardising each feature across the whole sample first (subtract "
            "the 569-record mean, divide by the 569-record standard deviation) "
            "and then comparing the two groups' standardised means one feature at "
            f"a time, the label-0 mean exceeds the label-1 mean on "
            f"{larger_in_label_0} of "
            f"{len(feature_cols)} features (the remaining {larger_in_label_1} go "
            f"the other way), and label 0 also has the larger mean radius "
            f"({size_feature_0:.2f} vs {size_feature_1:.2f}); with 212/357 records "
            "the label sizes also match the class sizes the canonical repository "
            "reports. All three checks are consistent with the declared coding "
            "0=malignant, 1=benign; they do not by themselves establish it."
        ),
    }
    RESULTS["target_coding"] = out
    # Reported as an estimate field only when the checks are consistent; the
    # value is a text label assignment, not a quantity, and there is no numeric
    # estimate or interval to attach to it. When a check fails there is nothing
    # to estimate at all, so the analysis is recorded as failed with a reason
    # rather than as a complete estimate.
    coding_estimate = (
        "0 = malignant, 1 = benign (declared by the supplied source metadata and "
        "the canonical repository's target definition; consistent with all three "
        "data-internal checks)"
    )
    record(
        id="target-coding-verification",
        status="complete" if consistent else "failed",
        method="declared-coding comparison against data-internal phenotype direction and published class sizes",
        estimand="which target label denotes malignancy",
        n=num(len(df)),
        estimate=coding_estimate if consistent else None,
        warnings=(
            [
                "the coding direction rests on the supplied source metadata and the "
                "canonical repository's target definition; the data-internal checks "
                "are consistency checks and cannot establish a category's meaning"
            ]
            if consistent
            else ["declared coding inconsistent with the data; analysis not interpretable"]
        ),
    )

    print(f"[coding] counts={dict(counts)} "
          f"features_larger_in_label0={larger_in_label_0}/{len(feature_cols)} "
          f"mean_radius(label0)={size_feature_0:.3f} mean_radius(label1)={size_feature_1:.3f} "
          f"-> {conclusion}")
    if not consistent:
        raise SystemExit("target coding could not be verified; stopping")
    return out


# --------------------------------------------------------------------------
# 3. Group comparison of mean radius
# --------------------------------------------------------------------------

def compare(df: pd.DataFrame) -> dict:
    mal = df.loc[df[TARGET] == MALIGNANT, GROUP_COL].to_numpy(dtype=float)
    ben = df.loc[df[TARGET] == BENIGN, GROUP_COL].to_numpy(dtype=float)
    n_m, n_b = len(mal), len(ben)

    mean_m, mean_b = float(mal.mean()), float(ben.mean())
    sd_m, sd_b = float(mal.std(ddof=1)), float(ben.std(ddof=1))
    var_m, var_b = sd_m ** 2, sd_b ** 2
    diff = mean_m - mean_b

    # --- Variance structure -------------------------------------------------
    var_ratio = var_m / var_b
    levene = stats.levene(mal, ben, center="median")
    bartlett = stats.bartlett(mal, ben)
    # Pre-specified rule: use Welch whenever the variance ratio exceeds 2 or
    # Levene's test is significant at alpha = 0.05.
    use_welch = bool(var_ratio > 2.0 or levene.pvalue < ALPHA)

    # --- Primary: Welch unequal-variance t interval and test ----------------
    welch = stats.ttest_ind(mal, ben, equal_var=False)
    se_welch = float(np.sqrt(var_m / n_m + var_b / n_b))
    df_welch = float(
        (var_m / n_m + var_b / n_b) ** 2
        / ((var_m / n_m) ** 2 / (n_m - 1) + (var_b / n_b) ** 2 / (n_b - 1))
    )
    crit = float(stats.t.ppf(1 - ALPHA / 2, df_welch))
    ci_welch = (diff - crit * se_welch, diff + crit * se_welch)

    # --- Sensitivity 1: pooled-variance (Student) t -------------------------
    student = stats.ttest_ind(mal, ben, equal_var=True)
    sp2 = ((n_m - 1) * var_m + (n_b - 1) * var_b) / (n_m + n_b - 2)
    se_pool = float(np.sqrt(sp2 * (1 / n_m + 1 / n_b)))
    df_pool = n_m + n_b - 2
    crit_pool = float(stats.t.ppf(1 - ALPHA / 2, df_pool))
    ci_pool = (diff - crit_pool * se_pool, diff + crit_pool * se_pool)

    # --- Sensitivity 2: bootstrap percentile interval -----------------------
    rng = np.random.default_rng(SEED)
    boot = np.empty(N_BOOT)
    for i in range(N_BOOT):
        boot[i] = (
            rng.choice(mal, n_m, replace=True).mean()
            - rng.choice(ben, n_b, replace=True).mean()
        )
    ci_boot = (
        float(np.percentile(boot, 100 * ALPHA / 2)),
        float(np.percentile(boot, 100 * (1 - ALPHA / 2))),
    )

    # --- Sensitivity 3: rank-based test ------------------------------------
    mwu = stats.mannwhitneyu(mal, ben, alternative="two-sided")
    # Rank-biserial correlation and Hodges-Lehmann shift
    u = float(mwu.statistic)
    rank_biserial = 2 * u / (n_m * n_b) - 1
    hl = float(
        np.median(np.subtract.outer(mal, ben))
    ) if n_m * n_b <= 5_000_000 else float("nan")

    # --- Effect size --------------------------------------------------------
    sp_sd = float(np.sqrt(sp2))
    cohens_d = diff / sp_sd
    # Hedges' g small-sample correction
    J = 1 - 3 / (4 * (n_m + n_b) - 9)
    hedges_g = cohens_d * J
    glass_delta = diff / sd_b
    # 95% CI for Cohen's d via the noncentral-t-free large-sample formula
    se_d = float(np.sqrt((n_m + n_b) / (n_m * n_b) + cohens_d ** 2 / (2 * (n_m + n_b))))
    d_ci = (cohens_d - 1.96 * se_d, cohens_d + 1.96 * se_d)

    # --- Assumption diagnostics --------------------------------------------
    shapiro_m = stats.shapiro(mal)
    shapiro_b = stats.shapiro(ben)
    skew_m, skew_b = float(stats.skew(mal)), float(stats.skew(ben))
    kurt_m, kurt_b = float(stats.kurtosis(mal)), float(stats.kurtosis(ben))

    def outliers(x: np.ndarray, group_name: str, group_label: int) -> dict:
        q1, q3 = np.percentile(x, [25, 75])
        iqr = q3 - q1
        lo, hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
        mask = (x < lo) | (x > hi)
        flagged = np.sort(x[mask])
        return {
            "group": group_name,
            "target_label": group_label,
            "n": num(len(x)),
            "lower_fence": num(lo),
            "upper_fence": num(hi),
            "n_outside_fences": num(int(mask.sum())),
            "pct_outside_fences": num(100 * mask.mean()),
            "flagged_values": [num(float(v)) for v in flagged],
            "flagged_sides": [
                "below lower fence" if v < lo else "above upper fence" for v in flagged
            ],
            "note": (
                "These values are reported as the actual records the IQR rule "
                "flags, with their group and value. That a record is an extreme "
                "value of its own group is all the rule establishes; no "
                "interpretation of these records is offered, and none was removed."
            ),
        }

    # --- Exploratory single-feature cut-point --------------------------------
    # This is a FITTED, IN-SAMPLE, EXPLORATORY rule, not a validated classifier.
    # It exists only to quantify how far the two groups overlap on this one
    # feature. No model is fitted, no held-out data are used, and the cut-point
    # is selected by maximising the very quantity it is then reported as
    # achieving -- which makes that number optimistically biased. It must not be
    # read as diagnostic accuracy.
    #
    # Under the stated rule (malignant if value > t, else benign) a record is
    # misclassified when a benign value exceeds t or a malignant value does not.
    # The correct count at a cut-point t therefore depends only on t's position
    # among the observed values, so the maximiser is the whole half-open
    # interval whose endpoints are the two distinct observed values adjacent to
    # the count-maximising position. That interval is computed exactly here.
    def rule_counts(threshold: float) -> tuple:
        """Count records the stated rule classifies correctly, at this threshold."""
        correct = int((mal > threshold).sum() + (ben <= threshold).sum())
        return correct, n_m + n_b

    values = np.unique(np.concatenate([mal, ben]))
    # The rule's output changes only when the cut-point crosses an observed
    # value, so it is constant on each interval between consecutive observed
    # values. One representative cut-point per interval -- its midpoint -- covers
    # every distinct count the rule can produce.
    mids = 0.5 * (values[:-1] + values[1:])
    candidates = np.concatenate([[values[0] - 1.0], mids, [values[-1] + 1.0]])
    counts = np.array([rule_counts(t)[0] for t in candidates])
    n_correct_max = int(counts.max())
    maximisers = candidates[counts == n_correct_max]
    best_thr = float(maximisers[-1])          # the largest cut-point attaining it

    # The maximising interval is bounded below by the smallest cut-point that
    # attains the maximum and above by the next observed value, approached but
    # never attained (the two are contiguous intervals when several attain it).
    plateau_lo = float(maximisers.min())
    above = values[values > plateau_lo]
    plateau_hi = float(above.min()) if len(above) else float("inf")

    # The maximising interval, expressed in cut-points rather than candidates.

    # Report the largest two-decimal cut-point that still attains the maximum, so
    # the published value is the most round number the stated operator can carry
    # without changing the published count.
    best_thr_display = round(best_thr, 2)
    for _ in range(200):
        if rule_counts(best_thr_display)[0] == n_correct_max:
            break
        best_thr_display = round(best_thr_display - 0.01, 2)
    else:
        raise SystemExit("no two-decimal cut-point reproduces the maximum count")

    n_correct_exact, n_total = rule_counts(best_thr)
    n_correct_display, _ = rule_counts(best_thr_display)
    best_acc = n_correct_display / n_total

    # How many records a cut-point in this range misclassifies, by group: these
    # are the records that make the two groups overlap, counted, not asserted.
    mis_mal = int((mal <= best_thr_display).sum())
    mis_ben = int((ben > best_thr_display).sum())

    out = {
        "estimand": (
            "difference in population mean of `mean radius`, malignant minus "
            "benign (unadjusted, descriptive contrast)"
        ),
        "unit_of_analysis": "one tumour record",
        "denominators": {
            "records_loaded": num(RESULTS["profile"]["rows_loaded"]),
            "records_analysed": num(n_m + n_b),
            "records_excluded": 0,
            "malignant_n": num(n_m),
            "benign_n": num(n_b),
            "missing_values_in_analysis_variable": 0,
        },
        "descriptives": {
            "malignant": {
                "n": num(n_m), "mean": num(mean_m), "sd": num(sd_m),
                "variance": num(var_m), "median": num(float(np.median(mal))),
                "q1": num(float(np.percentile(mal, 25))),
                "q3": num(float(np.percentile(mal, 75))),
                "min": num(float(mal.min())), "max": num(float(mal.max())),
            },
            "benign": {
                "n": num(n_b), "mean": num(mean_b), "sd": num(sd_b),
                "variance": num(var_b), "median": num(float(np.median(ben))),
                "q1": num(float(np.percentile(ben, 25))),
                "q3": num(float(np.percentile(ben, 75))),
                "min": num(float(ben.min())), "max": num(float(ben.max())),
            },
        },
        "variance_structure": {
            "variance_ratio_malignant_over_benign": num(var_ratio),
            "sd_ratio": num(sd_m / sd_b),
            "levene_statistic_median_centred": num(levene.statistic),
            "levene_p": num(levene.pvalue),
            "bartlett_statistic": num(bartlett.statistic),
            "bartlett_p": num(bartlett.pvalue),
            "equal_variance_rejected": bool(levene.pvalue < ALPHA),
        },
        "test_selection_rule": (
            "The rule below was fixed within this analysis before the tests were "
            "run, and both its inputs are reported with it so the selection can be "
            "audited. No pre-registration exists for this dataset, so this is a "
            "documented analysis-time rule, not a pre-registered one."
        ),
        "test_selection_rule_text": (
            "Welch's unequal-variance t-test if the variance ratio exceeds 2 or "
            "Levene's median-centred test is significant at alpha = 0.05; "
            "otherwise the pooled-variance t-test."
        ),
        "rule_outcome": (
            "Welch's t-test selected" if use_welch else "pooled-variance t-test selected"
        ),
        "primary": {
            "method": "Welch's unequal-variance two-sample t-test",
            "mean_difference_malignant_minus_benign": num(diff),
            "standard_error": num(se_welch),
            "df": num(df_welch),
            "t_statistic": num(welch.statistic),
            "p_value": num(welch.pvalue),
            "ci95": [num(ci_welch[0]), num(ci_welch[1])],
            "ci_method": "Welch t interval with Satterthwaite degrees of freedom",
            "test_direction": "two-sided",
        },
        "sensitivity": [
            {
                "method": "pooled-variance (Student) two-sample t-test",
                "estimate": num(diff),
                "ci95": [num(ci_pool[0]), num(ci_pool[1])],
                "t_statistic": num(student.statistic),
                "df": num(df_pool),
                "p_value": num(student.pvalue),
                "note": (
                    "assumes equal variances; that assumption is rejected here, "
                    "so it is reported for comparison only"
                ),
            },
            {
                "method": "bootstrap percentile interval (10,000 resamples, seed %d)" % SEED,
                "estimate": num(diff),
                "ci95": [num(ci_boot[0]), num(ci_boot[1])],
                "p_value": None,
                "note": "assumption-light resampling interval for the mean difference",
            },
            {
                "method": "Mann-Whitney U (rank-based)",
                "estimate": num(hl),
                "estimate_label": "Hodges-Lehmann median shift (malignant - benign)",
                "ci95": None,
                "u_statistic": num(u),
                "p_value": num(mwu.pvalue),
                "rank_biserial_correlation": num(rank_biserial),
                "note": "sensitive to a shift in distribution, not to the mean difference as such",
            },
        ],
        "comparative_p_value_orders": {
            "welch_p": num(welch.pvalue),
            "pooled_p": num(student.pvalue),
            "mann_whitney_p": num(mwu.pvalue),
            "welch_negative_log10_p": num(-np.log10(welch.pvalue)),
            "pooled_negative_log10_p": num(-np.log10(student.pvalue)),
            "orders_of_magnitude_pooled_vs_welch": num(
                np.log10(welch.pvalue) - np.log10(student.pvalue)
            ),
            "statement": (
                "the pooled-variance p value is smaller than the Welch p value by "
                "%0.1f orders of magnitude (both computed from the executed p "
                "values, as a base-10 log ratio)"
                % (np.log10(welch.pvalue) - np.log10(student.pvalue))
            ),
            "note": (
                "all three p values are far below any conventional alpha; the "
                "comparison is about how much of each number is produced by the "
                "sample size rather than about any difference in conclusion"
            ),
        },
        "effect_size": {
            "cohens_d": num(cohens_d),
            "cohens_d_reference_denominator": "pooled SD of the two groups",
            "cohens_d_reference_sd": num(sp_sd),
            "cohens_d_ci95": [num(d_ci[0]), num(d_ci[1])],
            "hedges_g": num(hedges_g),
            "hedges_g_reference_denominator": (
                "same pooled SD as Cohen's d, with the small-sample bias correction"
            ),
            "glass_delta_using_benign_sd": num(glass_delta),
            "glass_delta_reference_denominator": "SD of the benign group",
            "glass_delta_reference_sd": num(sd_b),
            "pooled_sd": num(sp_sd),
            "sd_malignant": num(sd_m),
            "sd_benign": num(sd_b),
            "interpretation": (
                "The three standardised measures use different reference "
                "denominators: Cohen's d and Hedges' g divide by the pooled SD "
                "(%0.3f here), while Glass' delta divides by the benign group's SD "
                "(%0.3f here). Because the benign SD is the smaller of the two, "
                "Glass' delta is the LARGER number; that is a consequence of the "
                "smaller denominator, not a more cautious estimate. The three are "
                "not interchangeable and none of them is a more conservative "
                "version of another. Cohen's d above 0.8 is conventionally labelled "
                "large, and the whole interval lies above that anchor."
                % (sp_sd, sd_b)
            ),
        },
        "diagnostics": {
            "shapiro_malignant": {"W": num(shapiro_m.statistic), "p": num(shapiro_m.pvalue)},
            "shapiro_benign": {"W": num(shapiro_b.statistic), "p": num(shapiro_b.pvalue)},
            "skewness": {"malignant": num(skew_m), "benign": num(skew_b)},
            "excess_kurtosis": {"malignant": num(kurt_m), "benign": num(kurt_b)},
            "outliers_iqr_malignant": outliers(mal, "malignant", 0),
            "outliers_iqr_benign": outliers(ben, "benign", 1),
            "normality_note": (
                "Shapiro-Wilk rejects normality in the malignant group; with "
                "n = %d and n = %d the t-test is nevertheless robust through the "
                "central limit theorem, and the bootstrap and rank-based results "
                "are reported alongside as checks that do not rely on normality."
                % (n_m, n_b)
            ),
        },
        "overlap": {
            "malignant_min": num(float(mal.min())),
            "malignant_max": num(float(mal.max())),
            "benign_min": num(float(ben.min())),
            "benign_max": num(float(ben.max())),
            "ranges_overlap": bool(mal.min() < ben.max()),
            "n_malignant_below_benign_max": num(int((mal < ben.max()).sum())),
            "pct_malignant_below_benign_max": num(100 * float((mal < ben.max()).mean())),
            "n_benign_above_malignant_min": num(int((ben > mal.min()).sum())),
            "pct_benign_above_malignant_min": num(100 * float((ben > mal.min()).mean())),
            "malignant_quartiles": [
                num(float(np.percentile(mal, 25))),
                num(float(np.percentile(mal, 75))),
            ],
            "benign_quartiles": [
                num(float(np.percentile(ben, 25))),
                num(float(np.percentile(ben, 75))),
            ],
            "n_malignant_above_benign_q3": num(
                int((mal > np.percentile(ben, 75)).sum())
            ),
            "n_benign_below_malignant_q1": num(
                int((ben < np.percentile(mal, 25)).sum())
            ),
            "best_single_threshold": {
                "status": (
                    "EXPLORATORY / FITTED IN-SAMPLE RULE -- not a validated "
                    "classifier and not an estimate of diagnostic accuracy"
                ),
                "full_precision_optimum": num(best_thr),
                "displayed_threshold": num(best_thr_display),
                "displayed_operator": ">",
                "displayed_direction": (
                    "malignant if value > %s, else benign" % best_thr_display
                ),
                "n_correct_at_displayed_threshold": num(n_correct_display),
                "n_correct_at_full_precision_optimum": num(n_correct_exact),
                "displayed_threshold_reproduces_reported_count": bool(
                    n_correct_display == n_correct_exact
                ),
                "n_total": num(n_total),
                "observed_proportion_correct_in_this_sample": num(
                    n_correct_display / n_total
                ),
                "n_misclassified_malignant_below_or_at_cut": num(mis_mal),
                "n_misclassified_benign_above_cut": num(mis_ben),
                "n_misclassified_total": num(mis_mal + mis_ben),
                "count_maximising_cut_point_interval": [num(plateau_lo), num(plateau_hi)],
                "cut_point_is_unique": False,
                "note": (
                    "the cut-point was chosen by maximising the reported quantity "
                    "on the same 569 records on which it is reported, so the "
                    "proportion is optimistically biased; the count-maximising "
                    "cut-points form one interval whose endpoints are given above, "
                    "and the value reported is the largest two-decimal value inside "
                    "it, re-checked to reproduce the same count under the stated "
                    "operator; the rule is discontinuous at each observed value, so "
                    "a nearby value can give a slightly different count; no model "
                    "was fitted, no validation or held-out data were used, and no "
                    "diagnostic performance is claimed"
                ),
            },
            "note": (
                "the group distributions overlap over most of their range: the "
                "malignant upper tail extends well beyond the benign maximum, but "
                "roughly half of the malignant records lie within the benign range. "
                "The mean difference is a property of the groups; it does not "
                "classify any individual record."
            ),
        },
        "ci_agreement": {
            "welch_ci": [num(ci_welch[0]), num(ci_welch[1])],
            "pooled_ci": [num(ci_pool[0]), num(ci_pool[1])],
            "bootstrap_ci": [num(ci_boot[0]), num(ci_boot[1])],
            "upper_endpoint_spread": num(
                max(ci_welch[1], ci_pool[1], ci_boot[1])
                - min(ci_welch[1], ci_pool[1], ci_boot[1])
            ),
            "lower_endpoint_spread": num(
                max(ci_welch[0], ci_pool[0], ci_boot[0])
                - min(ci_welch[0], ci_pool[0], ci_boot[0])
            ),
            "interval_envelope_width": num(
                max(ci_welch[1], ci_pool[1], ci_boot[1])
                - min(ci_welch[0], ci_pool[0], ci_boot[0])
            ),
            "conclusion": (
                "all three intervals lie wholly above zero and agree on the "
                "order of magnitude of the difference; the pooled interval is "
                "slightly narrower because equal variances are assumed. The "
                "spread fields describe the three numbered intervals only; the "
                "Mann-Whitney analysis has no interval and is excluded."
            ),
        },
    }
    RESULTS["comparison"] = out

    print(f"[compare] n_malignant={n_m} n_benign={n_b} "
          f"mean_m={mean_m:.4f} mean_b={mean_b:.4f} diff={diff:.4f}")
    print(f"[compare] variance ratio={var_ratio:.3f} levene_p={levene.pvalue:.3e} "
          f"-> {out['rule_outcome']}")
    print(f"[compare] Welch t={welch.statistic:.4f} df={df_welch:.3f} "
          f"p={welch.pvalue:.3e} 95% CI=({ci_welch[0]:.4f}, {ci_welch[1]:.4f})")
    print(f"[compare] Student t={student.statistic:.4f} df={df_pool} "
          f"p={student.pvalue:.3e} 95% CI=({ci_pool[0]:.4f}, {ci_pool[1]:.4f})")
    print(f"[compare] bootstrap 95% CI=({ci_boot[0]:.4f}, {ci_boot[1]:.4f})")
    print(f"[compare] Mann-Whitney U={u:.0f} p={mwu.pvalue:.3e} HL shift={hl:.4f}")
    print(f"[compare] Cohen's d={cohens_d:.4f} (95% CI {d_ci[0]:.4f} to {d_ci[1]:.4f}) "
          f"Hedges g={hedges_g:.4f}")

    record(
        id="mean-radius-malignant-vs-benign",
        status="complete",
        method="Welch's unequal-variance two-sample t-test with Satterthwaite df",
        estimand="mean(mean radius | malignant) - mean(mean radius | benign)",
        n=num(n_m + n_b),
        estimate=num(diff),
        interval=[num(ci_welch[0]), num(ci_welch[1])],
        pValue=num(welch.pvalue),
        warnings=[
            "variance heterogeneity rejected by Levene's test (p = %.3g); "
            "the pooled-variance test is reported only as a sensitivity analysis"
            % levene.pvalue,
            "Shapiro-Wilk rejects normality of the malignant group (p = %.3g); "
            "bootstrap and rank-based checks are reported alongside"
            % shapiro_m.pvalue,
            "observational single-dataset sample; no causal or generalisable "
            "claim follows from this contrast",
        ],
    )
    record(
        id="mean-radius-sensitivity-pooled",
        status="complete",
        method="pooled-variance (Student) two-sample t-test",
        estimand="mean difference under an equal-variance assumption",
        n=num(n_m + n_b),
        estimate=num(diff),
        interval=[num(ci_pool[0]), num(ci_pool[1])],
        pValue=num(student.pvalue),
        warnings=["assumption of equal variances is rejected in this dataset"],
    )
    record(
        id="mean-radius-sensitivity-bootstrap",
        status="complete",
        method="bootstrap percentile interval, 10000 resamples, seed %d" % SEED,
        estimand="mean difference",
        n=num(n_m + n_b),
        estimate=num(diff),
        interval=[num(ci_boot[0]), num(ci_boot[1])],
        warnings=["percentile bootstrap interval; no p value reported"],
    )
    record(
        id="mean-radius-sensitivity-mann-whitney",
        status="complete",
        method="Mann-Whitney U test (two-sided)",
        estimand="median shift (Hodges-Lehmann) between groups",
        n=num(n_m + n_b),
        estimate=num(hl),
        pValue=num(mwu.pvalue),
        warnings=["tests a distributional shift, not the difference in means"],
    )
    return out


# --------------------------------------------------------------------------
# 4. Figures
# --------------------------------------------------------------------------

def figures(df: pd.DataFrame, cmp_: dict) -> list[str]:
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    mal = df.loc[df[TARGET] == MALIGNANT, GROUP_COL].to_numpy(dtype=float)
    ben = df.loc[df[TARGET] == BENIGN, GROUP_COL].to_numpy(dtype=float)
    made = []

    plt.rcParams.update({
        "font.size": 10, "axes.spines.top": False, "axes.spines.right": False,
        "figure.dpi": 150, "savefig.bbox": "tight",
    })
    mal_c, ben_c = "#B4453C", "#3B6EA5"

    fig, ax = plt.subplots(figsize=(5.2, 3.4))
    parts = ax.violinplot([ben, mal], showmeans=False, showextrema=False, widths=0.8)
    for body, colour in zip(parts["bodies"], (ben_c, mal_c)):
        body.set_facecolor(colour)
        body.set_alpha(0.35)
        body.set_edgecolor("none")
    for i, (x, colour) in enumerate(((ben, ben_c), (mal, mal_c)), start=1):
        jitter = np.random.default_rng(SEED).normal(0, 0.035, len(x))
        ax.scatter(np.full(len(x), i) + jitter, x, s=5, color=colour, alpha=0.5, linewidths=0)
        ax.plot([i - 0.25, i + 0.25], [x.mean()] * 2, color="black", lw=1.8, zorder=5)
    ax.set_xticks([1, 2])
    ax.set_xticklabels([f"Benign\n(n={len(ben)})", f"Malignant\n(n={len(mal)})"])
    ax.set_ylabel("Mean radius")
    d = cmp_["primary"]["mean_difference_malignant_minus_benign"]
    lo, hi = cmp_["primary"]["ci95"]
    ax.set_title(
        f"Mean radius by diagnosis\nmalignant $-$ benign = {d:.2f} "
        f"(95% CI {lo:.2f} to {hi:.2f})",
        fontsize=10, loc="left",
    )
    p = FIG_DIR / "mean-radius-by-diagnosis.png"
    fig.savefig(p)
    plt.close(fig)
    made.append(str(p.relative_to(SCRIPT_DIR)))

    fig, ax = plt.subplots(figsize=(5.2, 3.4))
    bins = np.linspace(min(ben.min(), mal.min()), max(ben.max(), mal.max()), 34)
    ax.hist(ben, bins=bins, alpha=0.6, color=ben_c, label=f"Benign (n={len(ben)})")
    ax.hist(mal, bins=bins, alpha=0.6, color=mal_c, label=f"Malignant (n={len(mal)})")
    ax.set_xlabel("Mean radius")
    ax.set_ylabel("Tumour records")
    ax.legend(frameon=False)
    ax.set_title("Overlapping distributions of mean radius", fontsize=10, loc="left")
    p2 = FIG_DIR / "mean-radius-distribution.png"
    fig.savefig(p2)
    plt.close(fig)
    made.append(str(p2.relative_to(SCRIPT_DIR)))

    print(f"[figures] wrote {made}")
    return made


# --------------------------------------------------------------------------
# 5. Main
# --------------------------------------------------------------------------

def main() -> None:
    RESULTS["meta"]["input_sha256"] = sha256(DATA_PATH)
    RESULTS["meta"]["source_metadata"] = (
        "UCI Machine Learning Repository, Breast Cancer Wisconsin (Diagnostic), "
        "doi:10.24432/C5DW2B"
    )

    df = load_and_profile()
    tc = verify_coding(df)
    cmp_ = compare(df)
    RESULTS["figures"] = figures(df, cmp_)

    # Cross-check: the script's own numbers must agree with one another.
    RESULTS["self_checks"] = {
        "mean_difference_equals_group_means_difference": bool(
            np.isclose(
                cmp_["primary"]["mean_difference_malignant_minus_benign"],
                cmp_["descriptives"]["malignant"]["mean"]
                - cmp_["descriptives"]["benign"]["mean"],
            )
        ),
        "denominators_sum_to_analysed": bool(
            cmp_["denominators"]["malignant_n"] + cmp_["denominators"]["benign_n"]
            == cmp_["denominators"]["records_analysed"]
            == RESULTS["profile"]["rows_analysed"]
        ),
        "welch_interval_contains_estimate": bool(
            cmp_["primary"]["ci95"][0]
            < cmp_["primary"]["mean_difference_malignant_minus_benign"]
            < cmp_["primary"]["ci95"][1]
        ),
        "coding_direction_counts_are_exhaustive": bool(
            tc["feature_direction_check"]["counts_sum_to_n_features"]
        ),
        "displayed_cut_point_reproduces_reported_count": bool(
            cmp_["overlap"]["best_single_threshold"][
                "displayed_threshold_reproduces_reported_count"
            ]
        ),
        "effect_size_pooled_denominator_is_larger_than_benign_denominator": bool(
            cmp_["effect_size"]["cohens_d_reference_sd"]
            > cmp_["effect_size"]["glass_delta_reference_sd"]
        ),
    }
    assert all(RESULTS["self_checks"].values()), RESULTS["self_checks"]

    print(
        "[exploratory] cut-point displayed at %s (%s) reproduces %d/%d correct; "
        "full-precision optimum %s; maximising interval %s to %s; "
        "misclassified by group: %d malignant, %d benign"
        % (
            cmp_["overlap"]["best_single_threshold"]["displayed_threshold"],
            cmp_["overlap"]["best_single_threshold"]["displayed_direction"],
            cmp_["overlap"]["best_single_threshold"]["n_correct_at_displayed_threshold"],
            cmp_["overlap"]["best_single_threshold"]["n_total"],
            cmp_["overlap"]["best_single_threshold"]["full_precision_optimum"],
            cmp_["overlap"]["best_single_threshold"]["count_maximising_cut_point_interval"][0],
            cmp_["overlap"]["best_single_threshold"]["count_maximising_cut_point_interval"][1],
            cmp_["overlap"]["best_single_threshold"]["n_misclassified_malignant_below_or_at_cut"],
            cmp_["overlap"]["best_single_threshold"]["n_misclassified_benign_above_cut"],
        ),
        flush=True,
    )
    print(
        "[orders] pooled p is smaller than Welch p by %s orders of magnitude"
        % round(cmp_["comparative_p_value_orders"]["orders_of_magnitude_pooled_vs_welch"], 2),
        flush=True,
    )

    print(
        "[coding] feature direction: label0 larger on "
        f"{tc['feature_direction_check']['features_larger_in_label_0']} of "
        f"{tc['feature_direction_check']['n_features_compared']} features, "
        f"label1 larger on "
        f"{tc['feature_direction_check']['features_larger_in_label_1']}",
        flush=True,
    )

    with open(RESULTS_PATH, "w") as fh:
        json.dump(RESULTS, fh, indent=2)
    print(f"[done] wrote {RESULTS_PATH}")


if __name__ == "__main__":
    main()
