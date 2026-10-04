#!/usr/bin/env python3
"""Check a gene-expression analysis without the platform: identities, hashes and every statistic, recomputed a second way.

    python3 verify_result.py DIRECTORY [--workspace ROOT] [--tolerance 1e-8]

DIRECTORY is a directory `gene_expression_differential` wrote (it holds gene-expression-results.json and its
companions). The check needs Python, numpy and scipy and nothing of EviMed:

1. every file the receipt names (the code, the inputs) hashes to the sha-256 the receipt gives, and the results file
   is the one the receipt's last execution wrote (inputs outside DIRECTORY are looked for under ROOT, which is the
   workspace and defaults to the directory above `deliverables/`; an input that is not there is reported as missing,
   never as matching);
2. the analysed matrix is read back and, probe by probe, Welch's t-test is recomputed with `scipy.stats.ttest_ind`
   (`equal_var=False`) and the Benjamini-Hochberg adjustment with `statsmodels` when it is installed (otherwise with
   an independent step-up written here), and compared with the table within the tolerance;
3. the group sizes, the number of probes tested and the counts at FDR 0.05 and 0.01 agree with the results file.

It is the second implementation the first one is checked against; it is not limma and it says so. Exit status 0 when
everything it could check agrees, 1 when something differs, 2 when it could not run.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import math
import sys
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def close(a: float, b: float, tolerance: float) -> bool:
    if math.isnan(a) and math.isnan(b):
        return True
    return abs(a - b) <= tolerance * max(abs(a), abs(b), 1e-300)


def bh(p_values):
    import numpy as np

    try:
        from statsmodels.stats.multitest import multipletests

        return np.asarray(multipletests(p_values, method="fdr_bh")[1]), "statsmodels.multipletests(fdr_bh)"
    except ImportError:
        order = sorted(range(len(p_values)), key=lambda i: p_values[i])
        adjusted = [0.0] * len(p_values)
        running = 1.0
        for rank in range(len(order), 0, -1):
            index = order[rank - 1]
            running = min(running, p_values[index] * len(p_values) / rank)
            adjusted[index] = running
        return np.asarray(adjusted), "step-up written in this file"


def verify(directory: Path, workspace: Path, tolerance: float) -> dict:
    import numpy as np
    from scipy import stats

    report = {"directory": str(directory), "tolerance": tolerance, "findings": [], "checked": {}}

    def finding(message):
        report["findings"].append(message)

    results = json.loads((directory / "gene-expression-results.json").read_text(encoding="utf-8"))
    receipt_path = directory / "gene-expression-receipt.json"
    hashes = {"matching": 0, "differing": 0, "missing": 0}
    if receipt_path.exists():
        execution = json.loads(receipt_path.read_text(encoding="utf-8"))["executions"][-1]
        for entry in [execution["script"], *execution["inputs"], execution["output"]["after"]]:
            candidates = [workspace / entry["path"], directory / Path(entry["path"]).name]
            found = next((path for path in candidates if path.is_file()), None)
            if found is None:
                hashes["missing"] += 1
                finding("not found, so not compared: %s" % entry["path"])
            elif sha256(found) == entry["sha256"]:
                hashes["matching"] += 1
            else:
                hashes["differing"] += 1
                finding("hash differs from the receipt: %s" % entry["path"])
        if execution["output"]["after"]["sha256"] != sha256(directory / "gene-expression-results.json"):
            finding("gene-expression-results.json is not the file the receipt's execution wrote")
    else:
        finding("there is no gene-expression-receipt.json beside the results")
    report["checked"]["receiptHashes"] = hashes

    with gzip.open(directory / "gene-expression-analysed-matrix.tsv.gz", "rt", encoding="utf-8") as stream:
        rows = list(csv.reader(stream, delimiter="\t"))
    header, body = rows[0], rows[1:]
    labels = [column.split("|", 1)[1] for column in header[2:]]
    design = results["design"]
    reference, comparison = design["reference"], design["comparison"]
    left = [i for i, label in enumerate(labels) if label == reference]
    right = [i for i, label in enumerate(labels) if label == comparison]
    if (len(left), len(right)) != tuple(group["n"] for group in design["groups"]):
        finding("the analysed matrix's group sizes differ from the design")
    values = {row[0]: np.array([float(cell) if cell else math.nan for cell in row[2:]]) for row in body}

    table = list(csv.DictReader((directory / "gene-expression-de-table.tsv").open(encoding="utf-8"), delimiter="\t"))
    ours = []
    for row in table:
        data = values.get(row["probe_id"])
        if data is None:
            finding("probe %s is in the table and not in the analysed matrix" % row["probe_id"])
            continue
        a, b = data[left], data[right]
        a, b = a[~np.isnan(a)], b[~np.isnan(b)]
        fit = stats.ttest_ind(b, a, equal_var=False)
        ours.append((row, float(fit.statistic), float(fit.pvalue), float(fit.df), float(b.mean() - a.mean())))
    differing = 0
    worst = 0.0
    for row, t, p, df, diff in ours:
        for name, mine, theirs in (("t", t, float(row["t"])), ("p_value", p, float(row["p_value"])), ("df", df, float(row["df"])), ("log2_fold_change", diff, float(row["log2_fold_change"]))):
            if not close(mine, theirs, tolerance):
                differing += 1
                if differing <= 5:
                    finding("probe %s %s: table %r, recomputed %r" % (row["probe_id"], name, theirs, mine))
            worst = max(worst, abs(mine - theirs) / max(abs(mine), abs(theirs), 1e-300))
    adjusted, how = bh(np.array([p for _, _, p, _, _ in ours]))
    for (row, *_rest), value in zip(ours, adjusted):
        if not close(float(row["adj_p_value"]), float(value), tolerance):
            differing += 1
            if differing <= 5:
                finding("probe %s adj_p_value: table %r, recomputed %r" % (row["probe_id"], float(row["adj_p_value"]), float(value)))
    report["checked"].update({
        "probes": len(ours), "statisticsDiffering": differing, "largestRelativeDifference": worst, "adjustment": how,
    })
    diagnostics = results["diagnostics"]
    if diagnostics["probesTested"] != len(table):
        finding("probesTested (%s) is not the number of rows in the table (%d)" % (diagnostics["probesTested"], len(table)))
    for key, bound in (("probesSignificantAtFdr05", 0.05), ("probesSignificantAtFdr01", 0.01)):
        count = int((adjusted < bound).sum())
        if diagnostics[key] != count:
            finding("%s is %s in the results and %d when recomputed" % (key, diagnostics[key], count))
    report["ok"] = not report["findings"]
    report["method"] = "Welch t-test per probe on log2 values with Benjamini-Hochberg adjustment; not limma (no empirical-Bayes variance moderation)"
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("directory")
    parser.add_argument("--workspace")
    parser.add_argument("--tolerance", type=float, default=1e-8)
    args = parser.parse_args()
    directory = Path(args.directory).resolve()
    workspace = Path(args.workspace).resolve() if args.workspace else next((p.parent for p in [directory, *directory.parents] if p.name == "deliverables"), directory)
    try:
        report = verify(directory, workspace, args.tolerance)
    except (OSError, ValueError, KeyError, ImportError) as error:
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(error).__name__, error)}))
        return 2
    print(json.dumps(report, indent=1))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
