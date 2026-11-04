"""Score the feature's saved judgments with the official evaluators, unchanged.

  score.py a  ranking boards (SIGIR, TREC 2021, TREC 2022): the official
              eval_trialgpt_rankings_qrels.py as a subprocess, plus the dev/test
              and TrialGPT 1.0 paper-subset variants and patient-bootstrap intervals
  score.py b  NIH-TrialBench: the official target-recall script as a subprocess
  score.py c  criterion board: label agreement, paired against the GPT-4 column

Aggregates go to --out (no patient-level value ever does); per-patient and
per-row files, and the converted official inputs, stay under --work, which must
live outside the repository.
"""
import argparse
from collections import Counter, defaultdict
import csv
import importlib.util
import json
import math
from pathlib import Path
import random
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))  # python -I does not add the script directory

from common import (
    COHORTS, CRITERION, DECISIVE, DISQUALIFYING, EVALUATORS, FAVOURABLE, LABELS, NIH, TG1_COMMIT, TG2_COMMIT,
    canonical_trial_id, check_evaluator, normalize_label, read_json, read_jsonl,
)
from to_official import FINISHED_STATUSES, convert, usage_of

METRICS = {"gNDCG": "ndcg@10", "gP": "p@10", "MRR": "mrr", "gAP": "map"}
OFFICIAL_LINES = {"MRR": "MRR", "GradedAP": "gAP", "GradedPrecision@10": "gP", "GradednDCG@10": "gNDCG"}
DEFAULT_SEED = 20261104
DEFAULT_RESAMPLES = 10_000


class SelfCheckError(RuntimeError):
    """A reproduction the scorer promised did not hold; no table is written."""


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

def interval(draws, level=0.95):
    """Percentile interval, rounded outward so it is never narrower than the nominal level."""
    ordered = sorted(draws)
    tail = (1 - level) / 2
    return [ordered[math.floor(tail * (len(ordered) - 1))], ordered[math.ceil((1 - tail) * (len(ordered) - 1))]]


def bootstrap_groups(groups, resamples=DEFAULT_RESAMPLES, seed=DEFAULT_SEED, label=""):
    """Patient bootstrap. groups: {cohort: {metric: [one value per patient]}}.

    Returns {cohort: {metric: {point, ci}}, "macro": {...}}; macro is the mean of the cohort means over the
    cohorts that have patients. Cohorts are resampled independently, patients with replacement.
    """
    groups = {name: metrics for name, metrics in groups.items() if metrics and next(iter(metrics.values()))}
    rng = random.Random(f"{seed}|{label}")
    names = sorted(groups)
    metrics = sorted({metric for group in groups.values() for metric in group})
    draws = {name: {metric: [] for metric in metrics} for name in names}
    macro = {metric: [] for metric in metrics}
    for _ in range(resamples):
        means = {}
        for name in names:
            size = len(groups[name][metrics[0]])
            picks = rng.choices(range(size), k=size)
            for metric in metrics:
                values = groups[name][metric]
                mean = sum(map(values.__getitem__, picks)) / size
                draws[name][metric].append(mean)
                means.setdefault(metric, []).append(mean)
        for metric in metrics:
            macro[metric].append(sum(means[metric]) / len(names))
    result = {}
    for name in names:
        result[name] = {metric: {"point": sum(groups[name][metric]) / len(groups[name][metric]),
                                 "ci": interval(draws[name][metric])} for metric in metrics}
    result["macro"] = {metric: {"point": sum(result[name][metric]["point"] for name in names) / len(names),
                                "ci": interval(macro[metric]), "cohorts": names} for metric in metrics}
    return result


def paired_rate_bootstrap(per_patient, resamples=DEFAULT_RESAMPLES, seed=DEFAULT_SEED, label=""):
    """per_patient: [(rows, ours_correct, other_correct)]. Patients resampled; rates are over the drawn rows."""
    rng = random.Random(f"{seed}|{label}")
    size = len(per_patient)
    rows = [item[0] for item in per_patient]
    ours = [item[1] for item in per_patient]
    other = [item[2] for item in per_patient]
    out = {"ours": [], "other": [], "difference": []}
    for _ in range(resamples):
        picks = rng.choices(range(size), k=size)
        n = sum(map(rows.__getitem__, picks))
        a = sum(map(ours.__getitem__, picks)) / n
        b = sum(map(other.__getitem__, picks)) / n
        out["ours"].append(a), out["other"].append(b), out["difference"].append(a - b)
    return {key: interval(value) for key, value in out.items()}


# ---------------------------------------------------------------------------
# Running the official evaluators
# ---------------------------------------------------------------------------

def run_official(python, script, args, cwd):
    """The unchanged evaluator as an isolated subprocess; returns its stdout."""
    cwd = Path(cwd)
    cwd.mkdir(parents=True, exist_ok=True)
    done = subprocess.run([python, "-I", "-B", str(script), *map(str, args)], cwd=cwd, capture_output=True, text=True,
                          env={"PATH": "/usr/bin:/bin"})
    if done.returncode != 0:
        raise RuntimeError(f"Official evaluator failed ({done.returncode}): {done.stderr.strip()[-600:]}")
    return done.stdout


def parse_rankings_output(stdout):
    found = {}
    for name, key in OFFICIAL_LINES.items():
        match = re.search(rf"^\s*{re.escape(name)}:\s+([0-9.]+)\s*$", stdout, re.M)
        if not match:
            raise RuntimeError(f"Official output has no {name} line")
        found[key] = float(match.group(1))
    patients = re.search(r"\(patients=(\d+),", stdout)
    if not patients:
        raise RuntimeError("Official output has no patient count")
    return int(patients.group(1)), found


def load_official(path):
    """Import the reviewed evaluator for its per-patient metric functions; its bytes were checked first."""
    spec = importlib.util.spec_from_file_location("official_rankings_eval", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # the evaluator defines a dataclass, which looks its module up here
    spec.loader.exec_module(module)
    return module


def per_patient_metrics(official, queries, qrels, results_dir, trial_dir):
    """The evaluator's own loop (same inputs, pad-to-pool, K=10, max_rel=2, MRR threshold 2), per patient."""
    wanted = set(official.load_patient_ids_from_queries_jsonl(Path(queries)))
    qrel = official.load_qrels(Path(qrels))
    ranked = official.load_all_results_rankings(Path(results_dir), agg="first")
    candidates = set(official.extract_candidate_base_ids_from_trial_dir(Path(trial_dir)))
    values = {}
    for pid in sorted(pid for pid in qrel.pool if pid in wanted and pid in ranked):
        pool = [trial for trial in qrel.pool[pid] if trial in candidates]
        members = set(pool)
        truth = {trial: qrel.labels.get(pid, {}).get(trial, 0) for trial in pool}
        rank = [trial for trial in ranked[pid] if trial in members]
        seen = set(rank)
        rank += [trial for trial in pool if trial not in seen]
        values[pid] = {"gP": official.graded_precision_at_k(rank, truth, 10, 2),
                       "gNDCG": official.ndcg_graded_at_k(rank, truth, 10),
                       "gAP": official.graded_average_precision(rank, truth, 2),
                       "MRR": official.mrr(rank, truth, 2)}
    return values


def write_queries(path, pids):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text("".join(json.dumps({"_id": pid}) + "\n" for pid in sorted(pids)), encoding="utf-8")


def paper_subset_qrels(tg1, tg2, cohort, path):
    """TG2 qrels restricted to the pairs TrialGPT 1.0 judged in its own top retrieval (its retrieved_trials.json)."""
    keep = set()
    for entry in read_json(Path(tg1) / "dataset" / cohort / "retrieved_trials.json"):
        for bucket in ("0", "1", "2"):
            keep.update((entry["patient_id"], trial["NCTID"]) for trial in entry[bucket])
    lines = ["query-id\tcorpus-id\tscore"]
    for line in (Path(tg2) / "data" / cohort / "qrels" / "test.tsv").read_text(encoding="utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) >= 3 and (parts[0], parts[1]) in keep:
            lines.append(line)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")
    return len(lines) - 1


def score_cohort(name, ctx, cases_path, judgments, split):
    """All variants of one ranking cohort; returns (aggregates, per-patient values by variant)."""
    work = Path(ctx["work"]) / "board-a" / name
    results = work / "official"
    completion = convert(cases_path, judgments, results)
    cases = read_jsonl(cases_path)
    pids = [case["patientId"] for case in cases]
    finished = []
    for record in (read_jsonl(judgments) if judgments else []):
        if str(record.get("status") or "").lower() in FINISHED_STATUSES and record.get("patientId") in pids:
            finished.append(record["patientId"])
    base = Path(ctx["tg2"]) / "data" / name
    qrels = base / "qrels" / "test.tsv"
    variants = {"all": (pids, qrels), "dev": ([p for p in pids if p in split["dev"].get(name, ())], qrels),
                "test": ([p for p in pids if p in split["test"].get(name, ())], qrels),
                "finished": (sorted(set(finished)), qrels)}
    subset_pairs = paper_subset_qrels(ctx["tg1"], ctx["tg2"], name, work / "tg1-subset-qrels.tsv")
    variants["tg1_subset"] = (pids, work / "tg1-subset-qrels.tsv")

    aggregates, values = {}, {}
    for variant, (selected, qrels_path) in variants.items():
        if not selected:
            continue
        queries = work / f"queries-{variant}.jsonl"
        write_queries(queries, selected)
        stdout = run_official(ctx["python"], ctx["rankings_script"],
                              ["--queries-jsonl", queries, "--qrels", qrels_path, "--results-dir", results,
                               "--trial-dir", base / "trials", "--k", 10, "--max-rel", 2,
                               "--mrr-relevance-threshold", 2, "--subtrial-agg", "first", "--pad-to-pool"], work)
        patients, official_numbers = parse_rankings_output(stdout)
        patient_values = per_patient_metrics(ctx["official"], queries, qrels_path, results, base / "trials")
        means = {key: sum(row[key] for row in patient_values.values()) / len(patient_values) for key in METRICS}
        if patients != len(patient_values) or any(abs(means[k] - official_numbers[k]) > 5.1e-5 for k in METRICS):
            raise SelfCheckError(f"{name}/{variant}: per-patient values do not reproduce the official means")
        values[variant] = patient_values
        aggregates[variant] = {"patients": patients, "official": {METRICS[k]: v for k, v in official_numbers.items()},
                               **({"judgedPairsInSubset": subset_pairs} if variant == "tg1_subset" else {})}
    return {"completion": completion, "variants": aggregates}, values


# ---------------------------------------------------------------------------
# Board A
# ---------------------------------------------------------------------------

def score_a(ctx, judgments_by_cohort, resamples, seed):
    split = read_json(Path(ctx["boards"]) / "split.json")
    cohorts, values = {}, {}
    for name in COHORTS:
        folder = Path(ctx["boards"]) / f"A-{name.replace('_', '')}"
        if name not in judgments_by_cohort:
            continue
        cohorts[name], values[name] = score_cohort(name, ctx, folder / "cases.jsonl", judgments_by_cohort[name], split)

    bootstrapped = {}
    for variant in ("all", "dev", "test", "finished", "tg1_subset"):
        groups = {}
        for name, by_variant in values.items():
            rows = by_variant.get(variant)
            if rows:
                groups[name] = {METRICS[key]: [row[key] for row in rows.values()] for key in METRICS}
        if groups:
            bootstrapped[variant] = bootstrap_groups(groups, resamples, seed, f"A|{variant}")
    for name, entry in cohorts.items():
        for variant, record in entry["variants"].items():
            record["bootstrap"] = bootstrapped[variant][name]
    if values:
        per_patient_dir = Path(ctx["work"]) / "board-a"
        per_patient_dir.mkdir(parents=True, exist_ok=True)
        (per_patient_dir / "per-patient.json").write_text(json.dumps(values, sort_keys=True), encoding="utf-8")

    completion = Counter()
    for entry in cohorts.values():
        for key, value in entry["completion"].items():
            if isinstance(value, (int, float)):
                completion[key] += value
    return {
        "board": "A", "protocol": ("every judged candidate of each patient, no retrieval; official "
                                   "eval_trialgpt_rankings_qrels.py with K=10, max-rel 2, MRR threshold 2, subtrial-agg first, pad-to-pool"),
        "bootstrap": {"unit": "patient", "resamples": resamples, "seed": seed, "interval": "95% percentile"},
        "cohorts": cohorts,
        "macro": {variant: result["macro"] for variant, result in bootstrapped.items()},
        "completion": dict(completion),
        "complete": sorted(cohorts) == sorted(COHORTS),
    }


# ---------------------------------------------------------------------------
# Board B
# ---------------------------------------------------------------------------

def score_b(ctx, judgments, resamples, seed):
    folder = Path(ctx["boards"]) / "B-nih"
    work = Path(ctx["work"]) / "board-b"
    results = work / "official"
    completion = convert(folder / "cases.jsonl", judgments, results)
    summary_dir = work / "summary"
    run_official(ctx["python"], ctx["nih_script"],
                 ["--cases-path", Path(ctx["tg2"]) / "data" / NIH["dir"] / "benchmark_cases.jsonl",
                  "--results-dir", results, "--k", 10, "--out-dir", summary_dir], work)
    summary = read_json(summary_dir / "target_recall_at10_summary.json")
    with (summary_dir / "target_recall_at10_per_case.csv").open(encoding="utf-8", newline="") as stream:
        cases = list(csv.DictReader(stream))
    hits = [float(row["hit_at_10"]) for row in cases]
    mrrs = [float(row["mrr"]) for row in cases]
    if len(cases) != NIH["cases"] or sum(hits) != summary["overall"]["hit_count_at_10"]:
        raise SelfCheckError("NIH per-case rows do not reproduce the official summary")
    boot = bootstrap_groups({"nih": {"recall@10": hits, "mrr": mrrs}}, resamples, seed, "B")["nih"]
    below_k = completion.get("patientsBelowK", 0)
    return {
        "board": "B", "protocol": "official eval_nih_trialbench_target_recall_at10.py, K=10; missing output and unranked target count as misses",
        "bootstrap": {"unit": "case", "resamples": resamples, "seed": seed, "interval": "95% percentile"},
        "official": {key: summary["overall"][key] for key in
                     ("n_cases", "n_ranked_targets", "n_missing_output", "n_target_not_ranked", "hit_count_at_10",
                      "hit_rate_at_10", "target_trial_recall_at_10_pct", "mrr", "rank_mean", "rank_median") if key in summary["overall"]},
        "intervals": boot, "byIc": summary["by_ic"], "byStudyType": summary["by_study_type"],
        "completion": completion, "casesWithFewerThanTenJudged": below_k,
    }


# ---------------------------------------------------------------------------
# Board C
# ---------------------------------------------------------------------------

def _whole(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return int(value) if isinstance(value, str) and value.strip().isdigit() else None


def index_predictions(cases, records):
    """(patient, trial, kind, number) -> criterion as saved; also counts of rows that match no annotated clause."""
    clauses = {}
    for case in cases:
        for trial in case["trials"]:
            for clause in trial["clauses"]:
                clauses[(case["patientId"], trial["registryId"], clause["kind"], clause["number"])] = clause
    predictions, extra, repeated, text_differs = {}, 0, 0, 0
    for record in records.values():
        for entry in record.get("ranking") or []:
            trial = canonical_trial_id(entry.get("registryId"))
            for item in entry.get("criteria") or []:
                kind = str(item.get("kind") or "").strip().lower()
                key = (record.get("patientId"), trial, kind, _whole(item.get("number")))
                if key not in clauses:
                    extra += 1
                elif key in predictions:
                    repeated += 1
                else:
                    predictions[key] = item
                    given, own = item.get("text"), clauses[key].get("text")
                    if isinstance(given, str) and own is not None and " ".join(given.split()) != " ".join(own.split()):
                        text_differs += 1
    return predictions, {"criteriaMatchingNoClause": extra, "criteriaRepeated": repeated, "criteriaTextDiffers": text_differs}


def _rate(num, den):
    return None if not den else num / den


def score_criterion(cases, labels, records, resamples=DEFAULT_RESAMPLES, seed=DEFAULT_SEED, expected=None):
    """Aggregate tables for board C plus the private per-row list."""
    expected = expected or CRITERION
    if len(labels) != expected["rows"]:
        raise SelfCheckError(f"The criterion labels are not the {expected['rows']} published rows")
    gpt4_correct = sum(row["gpt4"] == row["expert"] for row in labels)
    if gpt4_correct != expected["gpt4_agree"]:
        raise SelfCheckError(f"GPT-4 agreement is {gpt4_correct}/{len(labels)}, not the published {expected['gpt4_agree']}")

    predictions, diagnostics = index_predictions(cases, records)
    rows, by_patient = [], defaultdict(lambda: [0, 0, 0])
    for row in labels:
        item = predictions.get((row["patientId"], row["registryId"], row["kind"], row["number"]))
        label = normalize_label(item.get("label")) if item else None
        basis = str(item.get("basis") or "(none)") if item else "(missing)"
        rows.append({"annotationId": row["annotationId"], "expert": row["expert"], "gpt4": row["gpt4"], "pred": label,
                     "state": "missing" if item is None else ("ok" if label else "unrecognised"), "basis": basis,
                     "silent": not row["expertSentences"], "predictedSentences": (item or {}).get("sentenceIds")})
        counts = by_patient[row["patientId"]]
        counts[0] += 1
        counts[1] += label == row["expert"]
        counts[2] += row["gpt4"] == row["expert"]

    n = len(rows)
    ours = sum(row["pred"] == row["expert"] for row in rows)
    interval_95 = paired_rate_bootstrap(list(by_patient.values()), resamples, seed, "C")
    per_label = {}
    for label in LABELS:
        entry = {"decisive": label in DECISIVE}
        for who, key in (("ours", "pred"), ("gpt4", "gpt4")):
            predicted = sum(row[key] == label for row in rows)
            expert = sum(row["expert"] == label for row in rows)
            true = sum(row[key] == label and row["expert"] == label for row in rows)
            entry[who] = {"predicted": predicted, "expert": expert, "truePositive": true,
                          "precision": _rate(true, predicted), "recall": _rate(true, expert)}
        per_label[label] = entry
    decisive_rows = [row for row in rows if row["expert"] in DECISIVE]
    columns = [*LABELS, "(missing)", "(unrecognised)"]

    def cell(row, key):
        if key == "gpt4":
            return row["gpt4"]
        return row["pred"] if row["state"] == "ok" else f"({row['state']})"

    confusion = {who: {expert: {column: sum(1 for row in rows if row["expert"] == expert and cell(row, key) == column)
                                for column in columns} for expert in LABELS} for who, key in (("ours", "pred"), ("gpt4", "gpt4"))}

    def favourable_wrong(key, broad):
        wrong = Counter()
        for row in rows:
            if (row["pred"] if key == "pred" else row["gpt4"]) in FAVOURABLE:
                if row["expert"] == "not enough information" or row["expert"] in DISQUALIFYING or (broad and row["expert"] not in FAVOURABLE):
                    wrong[row["expert"]] += 1
        return {"count": sum(wrong.values()), "byExpertLabel": dict(wrong)}

    def split_by_basis(selected):
        table = {}
        for basis in sorted({row["basis"] for row in selected}):
            members = [row for row in selected if row["basis"] == basis]
            table[basis] = {"rows": len(members), "agreement": _rate(sum(r["pred"] == r["expert"] for r in members), len(members)),
                            "correct": sum(r["pred"] == r["expert"] for r in members),
                            "predictedLabels": dict(Counter(r["pred"] or f"({r['state']})" for r in members)),
                            "falseFavourable": sum(1 for r in members if r["pred"] in FAVOURABLE and (
                                r["expert"] == "not enough information" or r["expert"] in DISQUALIFYING))}
        return table

    silent = [row for row in rows if row["silent"]]
    evidenced = [row for row in rows if not row["silent"]]
    return {
        "board": "C",
        "protocol": "six-label agreement with the expert column over all 1,015 annotated rows; a row with no usable answer is wrong",
        "bootstrap": {"unit": "patient", "resamples": resamples, "seed": seed, "interval": "95% percentile", "pairedWith": "gpt4_eligibility, same rows"},
        "rows": n, "patients": len(by_patient),
        "agreement": {"ours": {"correct": ours, "rate": ours / n, "ci": interval_95["ours"]},
                      "gpt4": {"correct": gpt4_correct, "rate": gpt4_correct / n, "ci": interval_95["other"]},
                      "difference": {"value": (ours - gpt4_correct) / n, "ci": interval_95["difference"]},
                      "selfCheck": f"GPT-4 reproduced at {gpt4_correct}/{n}"},
        "answers": {"usable": sum(row["state"] == "ok" for row in rows), "missing": sum(row["state"] == "missing" for row in rows),
                    "unrecognised": sum(row["state"] == "unrecognised" for row in rows), **diagnostics},
        "perLabel": per_label,
        "decisiveRows": {"labels": list(DECISIVE), "rows": len(decisive_rows),
                         "oursCorrect": sum(r["pred"] == r["expert"] for r in decisive_rows),
                         "gpt4Correct": sum(r["gpt4"] == r["expert"] for r in decisive_rows)},
        "confusion": confusion,
        "falseFavourable": {
            "definition": "expert not enough information or disqualifying (not included, excluded) with a favourable answer (included, not excluded)",
            "ours": favourable_wrong("pred", False), "gpt4": favourable_wrong("gpt4", False),
            "broadDefinition": "any expert label other than included or not excluded with a favourable answer (the plan's wider count)",
            "oursBroad": favourable_wrong("pred", True), "gpt4Broad": favourable_wrong("gpt4", True)},
        "silentRows": {
            "definition": "rows whose expert annotation cites no note sentence",
            "rows": len(silent), "expertLabels": dict(Counter(r["expert"] for r in silent)),
            "oursCorrect": sum(r["pred"] == r["expert"] for r in silent), "gpt4Correct": sum(r["gpt4"] == r["expert"] for r in silent),
            "byBasis": split_by_basis(silent)},
        "evidencedRows": {"rows": len(evidenced), "oursCorrect": sum(r["pred"] == r["expert"] for r in evidenced),
                          "gpt4Correct": sum(r["gpt4"] == r["expert"] for r in evidenced), "byBasis": split_by_basis(evidenced)},
    }, rows


def score_c(ctx, judgments, resamples, seed):
    cases = read_jsonl(Path(ctx["boards"]) / "C-criterion" / "cases.jsonl")
    labels = read_jsonl(Path(ctx["labels"]) / "C-criterion" / "labels.jsonl")
    records = {}
    duplicate = 0
    for record in read_jsonl(judgments):
        duplicate += record.get("patientId") in records
        records[record.get("patientId")] = record
    known = {case["patientId"] for case in cases}
    result, rows = score_criterion(cases, labels, {pid: rec for pid, rec in records.items() if pid in known}, resamples, seed)
    statuses = Counter(str(rec.get("status") or "(none)") for rec in records.values() if rec.get("patientId") in known)
    usage = Counter()
    for pid, record in records.items():
        if pid in known:
            for key, value in usage_of(record).items():
                usage[key] += value
    failed = Counter(str(item.get("code") or "unknown") for pid, rec in records.items() if pid in known for item in rec.get("failed") or [])
    pairs_with_rows = {(key[0], key[1]) for key in index_predictions(cases, {p: r for p, r in records.items() if p in known})[0]}
    result["completion"] = {
        "patients": len(cases), "patientsWithRecord": len(known & set(records)),
        "patientsFinished": sum(1 for pid, rec in records.items() if pid in known and str(rec.get("status") or "").lower() in FINISHED_STATUSES),
        "pairs": sum(len(case["trials"]) for case in cases), "pairsWithAnswers": len(pairs_with_rows),
        "pairsFailedByCode": dict(failed), "statusCounts": dict(statuses), "duplicateRecords": duplicate,
        "usage": {"inputTokens": usage["inputTokens"], "outputTokens": usage["outputTokens"], "costCny": usage["costCny"],
                  "patientsReporting": usage["reported"]}}
    work = Path(ctx["work"]) / "board-c"
    work.mkdir(parents=True, exist_ok=True)
    (work / "rows.jsonl").write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows), encoding="utf-8")
    return result


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def pct(value, digits=1):
    return "n/a" if value is None else f"{100 * value:.{digits}f}%"


def fmt(point, ci=None):
    return f"{point:.4f}" if ci is None else f"{point:.4f} [{ci[0]:.4f}, {ci[1]:.4f}]"


def markdown_a(result):
    lines = ["# Board A: ranking against the qrels pools", "",
             f"Patient bootstrap, {result['bootstrap']['resamples']} resamples, seed {result['bootstrap']['seed']}, 95% percentile intervals.",
             "Official script means are shown; the intervals come from per-patient values that reproduce them.", ""]
    for variant, title in (("all", "All patients"), ("dev", "Dev topics"), ("test", "Test topics"),
                           ("tg1_subset", "TrialGPT 1.0 paper subset (pairs its own retrieval judged)"), ("finished", "Finished patients only")):
        rows = [(name, entry["variants"][variant]) for name, entry in result["cohorts"].items() if variant in entry["variants"]]
        if not rows:
            continue
        lines += [f"## {title}", "", "| cohort | patients | nDCG@10 | P@10 | MRR | MAP |", "|---|---|---|---|---|---|"]
        for name, record in rows:
            boot = record["bootstrap"]
            cells = [fmt(boot[m]["point"], boot[m]["ci"]) for m in ("ndcg@10", "p@10", "mrr", "map")]
            lines.append(f"| {name} | {record['patients']} | " + " | ".join(cells) + " |")
        macro = result["macro"].get(variant)
        if macro:
            cells = [fmt(macro[m]["point"], macro[m]["ci"]) for m in ("ndcg@10", "p@10", "mrr", "map")]
            lines.append(f"| macro ({', '.join(macro['ndcg@10']['cohorts'])}) | | " + " | ".join(cells) + " |")
        lines.append("")
    lines += ["## Completion", "", "| cohort | patients | with a record | finished | pairs | judged | unjudged | failed by code |", "|---|---|---|---|---|---|---|---|"]
    for name, entry in result["cohorts"].items():
        c = entry["completion"]
        lines.append(f"| {name} | {c['patients']} | {c.get('patientsWithRecord', 0)} | {c.get('patientsFinished', 0)} | {c['pairs']} | "
                     f"{c.get('pairsJudged', 0)} | {c.get('pairsUnjudged', 0)} | {c['pairsFailedByCode'] or '-'} |")
    return "\n".join(lines) + "\n"


def markdown_b(result):
    o, boot = result["official"], result["intervals"]
    c = result["completion"]
    return "\n".join([
        "# Board B: NIH-TrialBench target recall@10", "",
        f"Recall@10: {o['hit_count_at_10']}/{o['n_cases']} = {fmt(boot['recall@10']['point'], boot['recall@10']['ci'])} (case bootstrap, 95%).",
        f"MRR: {fmt(boot['mrr']['point'], boot['mrr']['ci'])}.  Missing output: {o['n_missing_output']}.  Target not ranked: {o['n_target_not_ranked']}.", "",
        f"Completion: {c['patientsWithRecord']} of {c['patients']} cases have a record, {c['patientsFinished']} finished; "
        f"{c['pairsJudged']} of {c['pairs']} pairs judged, {c['pairsUnjudged']} listed unjudged; failed by code {c['pairsFailedByCode'] or '-'}.",
        f"Cases with fewer than ten judged pairs (the rest are placed by shuffled input order): {result['casesWithFewerThanTenJudged']}.", ""])


def markdown_c(result):
    a = result["agreement"]
    lines = ["# Board C: criterion-level label agreement", "",
             f"Agreement over all {result['rows']} rows (missing counted wrong): ours {a['ours']['correct']}/{result['rows']} = {pct(a['ours']['rate'])} "
             f"[{pct(a['ours']['ci'][0])}, {pct(a['ours']['ci'][1])}]; GPT-4 {a['gpt4']['correct']}/{result['rows']} = {pct(a['gpt4']['rate'])}.",
             f"Paired difference (ours minus GPT-4): {100 * a['difference']['value']:+.1f} points [{100 * a['difference']['ci'][0]:+.1f}, {100 * a['difference']['ci'][1]:+.1f}] (patient bootstrap).",
             f"Answers: {result['answers']['usable']} usable, {result['answers']['missing']} missing, {result['answers']['unrecognised']} unrecognised.", "",
             "| label | decisive | expert rows | ours predicted | ours precision | ours recall | GPT-4 precision | GPT-4 recall |", "|---|---|---|---|---|---|---|---|"]
    for label, e in result["perLabel"].items():
        lines.append(f"| {label} | {'yes' if e['decisive'] else ''} | {e['ours']['expert']} | {e['ours']['predicted']} | {pct(e['ours']['precision'])} | "
                     f"{pct(e['ours']['recall'])} | {pct(e['gpt4']['precision'])} | {pct(e['gpt4']['recall'])} |")
    f = result["falseFavourable"]
    lines += ["", f"False favourable (ours / GPT-4): {f['ours']['count']} / {f['gpt4']['count']}; wider definition {f['oursBroad']['count']} / {f['gpt4Broad']['count']}.", "",
              f"Silent rows ({result['silentRows']['rows']}; ours correct {result['silentRows']['oursCorrect']}, GPT-4 {result['silentRows']['gpt4Correct']}):", "",
              "| basis | rows | correct | false favourable |", "|---|---|---|---|"]
    for basis, e in result["silentRows"]["byBasis"].items():
        lines.append(f"| {basis} | {e['rows']} | {e['correct']} | {e['falseFavourable']} |")
    c = result["completion"]
    lines += ["", f"Completion: {c['patientsWithRecord']} of {c['patients']} patients have a record, {c['patientsFinished']} finished; "
                 f"{c['pairsWithAnswers']} of {c['pairs']} pairs have answers; failed by code {c['pairsFailedByCode'] or '-'}.", ""]
    return "\n".join(lines) + "\n"


def write_results(out, name, result, renderer):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{name}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (out / f"{name}.md").write_text(renderer(result), encoding="utf-8")


def provenance(boards):
    manifest = read_json(Path(boards) / "manifest.json")
    return {"trialgpt2Commit": TG2_COMMIT, "trialgpt1Commit": TG1_COMMIT, "boardsInputsDigest": manifest["inputsDigest"],
            "evaluatorSha256": {name: digest for name, (_, digest) in EVALUATORS.items()}}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="board", required=True)
    for name in ("a", "b", "c"):
        p = sub.add_parser(name)
        p.add_argument("--boards", type=Path, required=True, help="the prepared inputs directory")
        p.add_argument("--work", type=Path, required=True, help="private directory for converted files and per-patient values")
        p.add_argument("--out", type=Path, required=True, help="aggregate results directory")
        p.add_argument("--resamples", type=int, default=DEFAULT_RESAMPLES)
        p.add_argument("--seed", type=int, default=DEFAULT_SEED)
        if name != "c":
            p.add_argument("--tg2", type=Path, required=True, help="TrialGPT 2.0 clone at the pinned commit")
            p.add_argument("--python", default=sys.executable, help="interpreter for the official evaluators (needs tqdm)")
        if name == "a":
            p.add_argument("--tg1", type=Path, required=True, help="TrialGPT 1.0 clone at the pinned commit")
            p.add_argument("--judgments", nargs="+", required=True, metavar="COHORT=FILE", help="e.g. sigir=judgments.jsonl")
        else:
            p.add_argument("--judgments", type=Path, required=True)
        if name == "c":
            p.add_argument("--labels", type=Path, required=True, help="the prepared labels directory")
    args = parser.parse_args()

    ctx = {"boards": args.boards, "work": args.work}
    if args.board in ("a", "b"):
        ctx.update(tg2=args.tg2, python=args.python)
        ctx["rankings_script"] = check_evaluator(args.tg2, "rankings")
        ctx["nih_script"] = check_evaluator(args.tg2, "nih_recall")
    if args.board == "a":
        ctx["tg1"] = args.tg1
        ctx["official"] = load_official(ctx["rankings_script"])
        given = dict(item.split("=", 1) for item in args.judgments)
        unknown = set(given) - set(COHORTS)
        if unknown:
            parser.error(f"unknown cohort {sorted(unknown)}")
        result = score_a(ctx, {name: Path(path) for name, path in given.items()}, args.resamples, args.seed)
        renderer = markdown_a
    elif args.board == "b":
        result = score_b(ctx, args.judgments, args.resamples, args.seed)
        renderer = markdown_b
    else:
        ctx["labels"] = args.labels
        result = score_c(ctx, args.judgments, args.resamples, args.seed)
        renderer = markdown_c
    result["provenance"] = provenance(args.boards)
    write_results(args.out, f"board-{args.board}", result, renderer)
    print(renderer(result))


if __name__ == "__main__":
    main()
