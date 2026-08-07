#!/usr/bin/env python3
"""Phase 6 - precision planning for the feasible questions.

Not post-hoc power: the dataset exists and n is fixed. These are the precision
statements a reader can pre-register (Bland 2009; Hoenig & Heisey 2001):
expected 95% CI width for each estimand at the available n, and the minimum
detectable effect sizes that n can and cannot support.

Recomputable: `python3 scripts/design_precision.py` in /workspace.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from scipy import stats

WORK = Path(__file__).resolve().parent.parent

# --- observed aripiprazole parent C/D ratios (ng/mL per mg/day) from
# scripts/domain_quantities.py output, pseudonym-labelled ---
CD_STEADY = np.array([23.6, 20.0, 15.85, 10.0])          # days on drug 9..27
CD_ALL = np.array([23.6, 20.0, 15.85, 10.0, 7.99])        # incl. P1 pre-steady-state
N_PARENT_OUT_OF_RANGE, N_PARENT = 4, 6                     # 2 above, 2 below (ref 100-350)
N_TOTAL_OUT_OF_RANGE, N_TOTAL = 5, 6                       # 1 above, 3 below (ref 150-500)

METAB_RATIOS = np.array([0.174, 0.492, 0.258, 0.223, 0.343, 0.266])  # DHP/ARI, n=6


def clopper_pearson(k: int, n: int, alpha: float = 0.05) -> tuple[float, float]:
    lo = stats.beta.ppf(alpha / 2, k, n - k + 1) if k > 0 else 0.0
    hi = stats.beta.ppf(1 - alpha / 2, k + 1, n - k) if k < n else 1.0
    return lo, hi


def t_interval(x: np.ndarray, alpha: float = 0.05) -> tuple[float, float, float]:
    n = len(x)
    m = float(np.mean(x))
    s = float(np.std(x, ddof=1))
    t = stats.t.ppf(1 - alpha / 2, n - 1)
    return m, s, t * s / math.sqrt(n)


def median_ci_bootstrap(x: np.ndarray, n_boot: int = 20000, seed: int = 42) -> tuple[float, float]:
    rng = np.random.default_rng(seed)
    meds = np.median(rng.choice(x, size=(n_boot, len(x)), replace=True), axis=1)
    return float(np.percentile(meds, 2.5)), float(np.percentile(meds, 97.5))


out = {}

# Q1: proportion of aripiprazole parent samples outside the lab reference range
cp_lo, cp_hi = clopper_pearson(N_PARENT_OUT_OF_RANGE, N_PARENT)
out["q1_outOfRangeProportion"] = {
    "k": N_PARENT_OUT_OF_RANGE, "n": N_PARENT,
    "p": N_PARENT_OUT_OF_RANGE / N_PARENT,
    "clopperPearson95CI": [round(cp_lo, 3), round(cp_hi, 3)],
    "expectedWidth": round(cp_hi - cp_lo, 3),
}

# Q1b: median C/D (all and steady-state subset), bootstrap CI width
for label, arr in (("all", CD_ALL), ("steadyState", CD_STEADY)):
    m, s, se = t_interval(np.log(arr))
    lo, hi = median_ci_bootstrap(arr)
    out[f"q1_cd_{label}"] = {
        "n": int(len(arr)), "median": round(float(np.median(arr)), 2),
        "min": round(float(arr.min()), 2), "max": round(float(arr.max()), 2),
        "foldSpread": round(float(arr.max() / arr.min()), 2),
        "medianBootstrap95CI": [round(lo, 2), round(hi, 2)],
        "medianCIWidth": round(hi - lo, 2),
        "logMean": round(m, 3), "logSD": round(s, 3),
        "logMeanSE": round(se, 3),
    }

# Q2: metabolic ratio - precision of a single-ratio estimate at analytical CV 15%
cv = 0.15
ratio = 0.27  # example mid value
se_ratio = ratio * cv / math.sqrt(1)  # single measurement, assay imprecision
out["q2_singleRatioPrecision"] = {
    "assumedAnalyticalCV": cv,
    "exampleRatio": ratio, "assaySE": round(se_ratio, 3),
    "ratios": METAB_RATIOS.tolist(),
    "ratioSpread": round(float(METAB_RATIOS.max() / METAB_RATIOS.min()), 2),
}

# Q3: reference-standard reclassification, n=6 parent samples
# lab 100-350: within = 2/6; Hart 2022 (120-270): within = 0/6 -> 2 samples reclassify
rec = 2
lo3, hi3 = clopper_pearson(rec, N_PARENT)
out["q3_reclassification"] = {
    "reclassified": rec, "n": N_PARENT,
    "p": rec / N_PARENT, "clopperPearson95CI": [round(lo3, 3), round(hi3, 3)],
    "expectedWidth": round(hi3 - lo3, 3),
}

# MDE statements: what an n=6 sample cannot separate (two-group comparison)
# A two-sample t-test with n1=n2=3 (the most balanced split available) would
# need a huge standardized difference; report the MDE curve instead.
for n_grp, alpha, power in ((3, 0.05, 0.8), (5, 0.05, 0.8), (25, 0.05, 0.8)):
    # two-sided two-sample t-test, equal n per arm
    df = 2 * n_grp - 2
    tcrit = stats.t.ppf(1 - alpha / 2, df)
    tpow = stats.t.ppf(power, df)
    ncp = (tcrit + tpow) ** 2
    d = math.sqrt(ncp * 2 / n_grp)
    out.setdefault("twoGroupMDE", {})[f"nPerGroup_{n_grp}"] = {
        "standardizedMeanDifference_d": round(d, 2),
        "note": "Cohen's d detectable at alpha=0.05, power=0.80, equal groups. "
                "n=3/group is the best this dataset could split into; n=25 shown as the field's typical scale.",
    }

# what the field actually publishes at: comparators' n
out["fieldComparatorsN"] = {
    "Molden2006_ariC/D_n_samples": 155, "Jukic2019_aripiprazole_n": 1334,
    "Ferchichi2026_clozapine_n_samples": 755, "Hendset2007_n": 62,
    "thisDataset_n_samples": 6, "thisDataset_n_patients": 5,
}

(WORK / "scoping-run-phase6-precision.json").write_text(
    json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
print(json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True))
