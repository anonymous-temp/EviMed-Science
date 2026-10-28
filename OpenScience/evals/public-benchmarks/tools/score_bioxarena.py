#!/usr/bin/env python3
"""BioXArena local scorer: computes a task's metric from a prediction CSV and the held-out labels.

Pure standard library (no numpy/scipy), so it runs anywhere.  The held-out labels come from
tools/bioxarena_prepare.py (labels.csv: `id`, the target column(s), and `__group` for grouped metrics).

Metrics (names as in the per-task spec, data/host-fetch/bioxarena.json -> tasks[].metric):
  pearson, spearman                       regression correlation (average ranks for ties)
  roc_auc                                 binary, prediction = probability / score of class 1 (rank statistic, ties = 0.5)
  macro_f1, accuracy                      classification, prediction = class name (exact string)
  mean_within_group_spearman              Spearman per `__group` (e.g. drug), averaged over groups with >= 3 rows and variance

Missing / unparsable predictions are never dropped silently: they are filled with a neutral value
(regression: mean of the supplied predictions; roc_auc: 0.5; classification: a class that cannot be correct) and
`coverage` (= predicted ids / held-out ids) is returned next to the score.  Extra ids are ignored and counted.

CLI
  score_bioxarena.py --selftest
  score_bioxarena.py --spec data/host-fetch/bioxarena.json --task <task> --pred submission.csv --labels labels.csv
"""
import argparse
import csv
import json
import math
import sys
from collections import defaultdict


# ----------------------------------------------------------------------------- metrics
def _rank(values):
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def pearson(x, y):
    n = len(x)
    if n < 2:
        return float("nan")
    mx, my = sum(x) / n, sum(y) / n
    sxx = sum((a - mx) ** 2 for a in x)
    syy = sum((b - my) ** 2 for b in y)
    if sxx == 0 or syy == 0:
        return float("nan")
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / math.sqrt(sxx * syy)


def spearman(x, y):
    return pearson(_rank(x), _rank(y))


def roc_auc(y_true, score):
    pos = [s for t, s in zip(y_true, score) if t == 1]
    neg = [s for t, s in zip(y_true, score) if t == 0]
    if not pos or not neg:
        return float("nan")
    ranks = _rank(list(score))
    r_pos = sum(r for t, r in zip(y_true, ranks) if t == 1)
    return (r_pos - len(pos) * (len(pos) + 1) / 2.0) / (len(pos) * len(neg))


def accuracy(y_true, y_pred):
    return sum(a == b for a, b in zip(y_true, y_pred)) / len(y_true) if y_true else float("nan")


def macro_f1(y_true, y_pred):
    classes = sorted(set(y_true))
    f1s = []
    for c in classes:
        tp = sum(1 for a, b in zip(y_true, y_pred) if a == c and b == c)
        fp = sum(1 for a, b in zip(y_true, y_pred) if a != c and b == c)
        fn = sum(1 for a, b in zip(y_true, y_pred) if a == c and b != c)
        f1s.append(0.0 if tp == 0 else 2 * tp / (2 * tp + fp + fn))
    return sum(f1s) / len(f1s) if f1s else float("nan")


def mean_within_group_spearman(groups, y_true, y_pred):
    by = defaultdict(list)
    for g, a, b in zip(groups, y_true, y_pred):
        by[g].append((a, b))
    vals = []
    for rows in by.values():
        if len(rows) >= 3:
            r = spearman([a for a, _ in rows], [b for _, b in rows])
            if not math.isnan(r):
                vals.append(r)
    return sum(vals) / len(vals) if vals else float("nan")


# ----------------------------------------------------------------------------- scoring
def _read_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def score_files(spec: dict, pred_path: str, labels_path: str) -> dict:
    metric, target = spec["metric"], spec["target_cols"][0]
    idc = spec.get("id_col", "id")
    labels = _read_csv(labels_path)
    preds = {}
    for r in _read_csv(pred_path):
        preds[r[idc]] = r.get(target)
    ids = [r[idc] for r in labels]
    covered = [i for i in ids if i in preds and preds[i] not in (None, "")]
    out = {"metric": metric, "n_heldout": len(ids), "coverage": round(len(covered) / len(ids), 4) if ids else 0.0,
           "extra_ids": len(set(preds) - set(ids))}
    if metric in ("pearson", "spearman", "mean_within_group_spearman"):
        yt = [float(r[target]) for r in labels]
        sup = []
        for i in covered:
            try:
                sup.append(float(preds[i]))
            except ValueError:
                pass
        fill = sum(sup) / len(sup) if sup else 0.0
        yp = []
        for r in labels:
            try:
                v = float(preds.get(r[idc], ""))
                yp.append(v if not math.isnan(v) else fill)
            except ValueError:
                yp.append(fill)
        if metric == "pearson":
            out["score"] = pearson(yt, yp)
        elif metric == "spearman":
            out["score"] = spearman(yt, yp)
        else:
            out["score"] = mean_within_group_spearman([r["__group"] for r in labels], yt, yp)
    elif metric == "roc_auc":
        yt = [int(float(r[target])) for r in labels]
        yp = []
        for r in labels:
            try:
                yp.append(float(preds.get(r[idc], "")))
            except ValueError:
                yp.append(0.5)
        out["score"] = roc_auc(yt, yp)
    elif metric in ("accuracy", "macro_f1"):
        yt = [r[target] for r in labels]
        yp = [preds.get(r[idc]) if preds.get(r[idc]) not in (None, "") else "__missing__" for r in labels]
        out["score"] = accuracy(yt, yp) if metric == "accuracy" else macro_f1(yt, yp)
    else:
        raise ValueError(f"unknown metric {metric}")
    if isinstance(out["score"], float) and math.isnan(out["score"]):
        out["score"] = None
        out["note"] = "metric undefined (constant predictions or labels)"
    return out


# ----------------------------------------------------------------------------- self-test
def selftest():
    fails = []

    def near(name, got, want, tol=1e-9):
        if got is None or abs(got - want) > tol:
            fails.append((name, got, want))

    near("pearson-perfect", pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1.0)
    near("pearson-anti", pearson([1, 2, 3, 4], [8, 6, 4, 2]), -1.0)
    near("spearman-monotone", spearman([1, 2, 3, 4, 5], [1, 4, 9, 16, 100]), 1.0)
    near("spearman-ties", spearman([1, 1, 2, 3], [1, 2, 2, 3]), 0.8333333333333334, 1e-9)
    near("auc-textbook", roc_auc([0, 0, 1, 1], [0.1, 0.4, 0.35, 0.8]), 0.75)
    near("auc-ties", roc_auc([0, 1], [0.5, 0.5]), 0.5)
    near("auc-perfect", roc_auc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]), 1.0)
    near("acc", accuracy(["a", "b", "a"], ["a", "a", "a"]), 2 / 3)
    near("macro-f1", macro_f1(["a", "a", "b", "b"], ["a", "b", "b", "b"]), (2 * 1 / (2 * 1 + 0 + 1) + 2 * 2 / (2 * 2 + 1 + 0)) / 2)
    near("within-group", mean_within_group_spearman(["x"] * 3 + ["y"] * 3, [1, 2, 3, 3, 2, 1], [1, 2, 3, 1, 2, 3]), 0.0)
    # file-level: missing ids are neutral, not dropped
    import os, tempfile
    d = tempfile.mkdtemp()
    lab = os.path.join(d, "labels.csv")
    pr = os.path.join(d, "pred.csv")
    with open(lab, "w") as f:
        f.write("id,y\n1,1\n2,2\n3,3\n4,4\n")
    with open(pr, "w") as f:
        f.write("id,y\n1,1\n2,2\n3,3\n99,5\n")
    res = score_files({"metric": "pearson", "target_cols": ["y"]}, pr, lab)
    near("file-pearson-with-missing", res["score"], pearson([1, 2, 3, 4], [1, 2, 3, 2.0]))
    if res["coverage"] != 0.75 or res["extra_ids"] != 1:
        fails.append(("coverage", res))
    with open(lab, "w") as f:
        f.write("id,c\n1,a\n2,b\n3,a\n4,b\n")
    with open(pr, "w") as f:
        f.write("id,c\n1,a\n2,b\n3,b\n")
    near("file-acc-missing-counts-wrong", score_files({"metric": "accuracy", "target_cols": ["c"]}, pr, lab)["score"], 0.5)
    print(f"selftest: {len(fails)} failures")
    for f in fails:
        print("  FAIL", f)
    return 1 if fails else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--spec")
    ap.add_argument("--task")
    ap.add_argument("--pred")
    ap.add_argument("--labels")
    a = ap.parse_args()
    if a.selftest:
        sys.exit(selftest())
    spec = next(t for t in json.load(open(a.spec))["tasks"] if t["task"] == a.task)
    print(json.dumps(score_files(spec, a.pred, a.labels), indent=1))


if __name__ == "__main__":
    main()
