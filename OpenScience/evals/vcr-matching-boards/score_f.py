"""Board F: n2c2 2018 Track 1 cohort selection, scored from what the feature saved.

The feature answers each of the thirteen criteria with one of its six labels. The official scorer takes met or not met, so a label is read
into one of them, and the way a label with no yes or no in it (`not enough information`, `not applicable`, or no answer at all) is read is the
reading. The model's own `included` and `not included` are kept as it gave them, whether or not a sentence stands behind them.

  (a) such a label is wrong, and stays in the denominator. Accuracy only: there is no met/not-met file for it.
  (b) it is read as not met. This is the unfavourable reading and the annotators' convention for a criterion the record does not mention.
  (c) as (b), except ENGLISH and MAKES-DECISIONS, where the annotation guide (section 4) says an unmentioned criterion is probably met.
  (d) it is read as met, for every criterion. This is the favourable reading.

The primary reading is (c), named on 2026-11-05 before the official test split was scored and with its judgments already fixed: the plan's line of 0.8293 is that reading of
the earlier pipeline. The reading alone moves a score across the majority baseline, so (b) and the unknown share are always printed beside it.

(b), (c) and (d) are written as the official scorer's input and the unchanged `track1_eval.py` is run on each; the scorer's micro and macro
overall F1 must equal this module's own computation, or no table is written. Intervals are from a patient-level bootstrap, 2,000 resamples.
Also reported: the share of pairs with no yes or no (the unknown share), how the model's yes and no split by whether a sentence stands behind
them, and a baseline that answers every patient with the majority class of the other patients (the 162 for the development split, the 40 for
the held-out one). Aggregates only: per-patient values stay under --work, and no note is read here.
"""
from collections import Counter
import argparse
import hashlib
import json
from pathlib import Path
import random
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))  # python -I does not add the script directory

from common import read_json, read_jsonl

TAGS = ("ABDOMINAL", "ADVANCED-CAD", "ALCOHOL-ABUSE", "ASP-FOR-MI", "CREATININE", "DIETSUPP-2MOS", "DRUG-ABUSE",
        "ENGLISH", "HBA1C", "KETO-1YR", "MAJOR-DIABETES", "MAKES-DECISIONS", "MI-6MOS")
ABSENT_MEANS_MET = ("ENGLISH", "MAKES-DECISIONS")
READINGS = ("b", "c", "d")
SCORER_SHA256 = "f453505c44af2eb0fd807c5f031e72f2041299a5244c05b8d4c598de84fe3a2a"
SPLITS = ("train-dev", "train-heldout")
PRIMARY_READING = "c"
RESAMPLES = 2000
SEED = 20261104


class SelfCheckError(RuntimeError):
    """A reproduction the scorer promised did not hold; no table is written."""


def state_of(entry):
    """met, not met, or None (no yes or no) for one tag's saved answer, and the kind of the None."""
    label = re.sub(r"[\s_\-]+", " ", str((entry or {}).get("label") or "").strip().lower())
    if label == "included":
        return "met", None
    if label == "not included":
        return "not met", None
    if not entry:
        return None, "no answer"
    return None, label if label in ("not enough information", "not applicable") else "unrecognised"


def read_as(state, tag, reading):
    """Reading (b), (c) or (d) of a state: always met or not met."""
    if state is not None:
        return state
    if reading == "d":
        return "met"
    if reading == "c" and tag in ABSENT_MEANS_MET:
        return "met"
    return "not met"


def cell(predicted, gold):
    """Which of tp, fp, fn, tn a (predicted, gold) pair of met/not met falls in."""
    if predicted == "met":
        return "tp" if gold == "met" else "fp"
    return "fn" if gold == "met" else "tn"


def f1(tp, fp, fn):
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    return 2 * precision * recall / (precision + recall) if precision + recall else 0.0


def overall_f1(counts):
    """The scorer's overall F1 for one 2x2 table: the mean of the F1 of "met" and the F1 of "not met"."""
    return (f1(counts["tp"], counts["fp"], counts["fn"]) + f1(counts["tn"], counts["fn"], counts["fp"])) / 2


def empty():
    return {"tp": 0, "fp": 0, "fn": 0, "tn": 0}


def patient_tables(states, gold, reading):
    """Per tag 2x2 counts of one patient under a reading (b, c or d)."""
    tables = {}
    for tag in TAGS:
        table = empty()
        table[cell(read_as(states[tag], tag, reading), gold[tag])] += 1
        tables[tag] = table
    return tables


def pool(patients):
    """Sum per-patient per-tag tables: (per tag, all)."""
    per_tag = {tag: empty() for tag in TAGS}
    for tables in patients:
        for tag in TAGS:
            for key in per_tag[tag]:
                per_tag[tag][key] += tables[tag][key]
    total = empty()
    for tag in TAGS:
        for key in total:
            total[key] += per_tag[tag][key]
    return per_tag, total


def summarize_reading(patients):
    per_tag, total = pool(patients)
    n = sum(total.values())
    return {"accuracy": (total["tp"] + total["tn"]) / n if n else None, "microF1": overall_f1(total),
            "macroF1": sum(overall_f1(per_tag[tag]) for tag in TAGS) / len(TAGS), "perTag": {tag: {"accuracy": (t["tp"] + t["tn"]) / max(1, sum(t.values())), "f1": overall_f1(t), "predictedMet": t["tp"] + t["fp"], "goldMet": t["tp"] + t["fn"]} for tag, t in per_tag.items()}}


def accuracy_a(states_list, golds):
    """Reading (a): a pair is right only when the saved answer is the gold; no yes or no is wrong and stays in the count."""
    right = sum(states[tag] == gold[tag] for states, gold in zip(states_list, golds) for tag in TAGS)
    return right / (len(golds) * len(TAGS)) if golds else None


def interval(draws, level=0.95):
    ordered = sorted(draws)
    tail = (1 - level) / 2
    return [ordered[int(tail * (len(ordered) - 1))], ordered[min(len(ordered) - 1, int((1 - tail) * (len(ordered) - 1) + 0.999999))]]


def bootstrap(states_list, golds, resamples=RESAMPLES, seed=SEED):
    """Patient-level bootstrap of the pooled statistics: a patient's thirteen criteria move together."""
    rng = random.Random(f"{seed}|f")
    pooled = {reading: [pool([patient_tables(states, gold, reading)])[1] for states, gold in zip(states_list, golds)] for reading in READINGS}
    a_right = [sum(states[tag] == gold[tag] for tag in TAGS) for states, gold in zip(states_list, golds)]
    unknown = [sum(states[tag] is None for tag in TAGS) for states in states_list]
    n = len(golds)
    draws = {name: [] for name in ("a", "unknown", *[f"acc_{r}" for r in READINGS], *[f"f1_{r}" for r in READINGS])}
    for _ in range(resamples):
        picks = rng.choices(range(n), k=n)
        draws["a"].append(sum(a_right[i] for i in picks) / (n * len(TAGS)))
        draws["unknown"].append(sum(unknown[i] for i in picks) / (n * len(TAGS)))
        for reading in READINGS:
            total = empty()
            for i in picks:
                for key in total:
                    total[key] += pooled[reading][i][key]
            draws[f"acc_{reading}"].append((total["tp"] + total["tn"]) / (n * len(TAGS)))
            draws[f"f1_{reading}"].append(overall_f1(total))
    return {name: interval(values) for name, values in draws.items()}


def xml(labels):
    body = "\n".join(f'<{tag} met="{labels[tag]}" />' for tag in TAGS)
    return f'<?xml version="1.0" encoding="UTF-8" ?>\n<PatientMatching>\n<TAGS>\n{body}\n</TAGS>\n</PatientMatching>\n'


def parse_scorer(output):
    rows = {}
    for line in output.split("\n"):
        match = re.match(r"^\s*(Overall \((?:micro|macro)\)|[A-Za-z0-9-]+)\s+((?:\d\.\d{4}\s*){9})$", line)
        if match:
            rows[match.group(1)] = [float(value) for value in match.group(2).split()]
    return {"micro": rows["Overall (micro)"][7], "macro": rows["Overall (macro)"][7],
            "perTag": {name.upper(): numbers[7] for name, numbers in rows.items() if not name.startswith("Overall")}}


def run_official(python, wrapper, scorer, gold_dir, system_dir):
    ran = subprocess.run([python, "-I", str(wrapper), str(scorer), str(gold_dir), str(system_dir)], capture_output=True, text=True)
    if ran.returncode != 0:
        raise SelfCheckError(f"The official scorer failed: {ran.stderr[:300]}")
    return parse_scorer(ran.stdout)


def majority_states(golds):
    return {tag: ("met" if sum(g[tag] == "met" for g in golds) * 2 > len(golds) else "not met") for tag in TAGS}


def score(records, labels, split, scorer, wrapper, python, work, resamples=RESAMPLES, official=True):
    """Aggregates for one split. `records` are the feature's saved answers by patient, `labels` the gold by patient (all 202 training patients)."""
    members = [row for row in labels if row["split"] == split]
    others = [row for row in labels if row["split"] != split]
    if not members:
        raise SelfCheckError(f"No labelled patients in the split {split}.")
    scored = [row for row in members if row["patientId"] in records]
    if not scored:
        raise SelfCheckError("The judgments hold no patient of this split.")
    golds = [row["tags"] for row in scored]
    answers = [{tag: state_of(records[row["patientId"]].get("labels", {}).get(tag)) for tag in TAGS} for row in scored]
    states = [{tag: pair[0] for tag, pair in answer.items()} for answer in answers]
    kinds = Counter(pair[1] for answer in answers for pair in answer.values() if pair[0] is None)
    basis = Counter()
    for row in scored:
        for tag, entry in records[row["patientId"]].get("labels", {}).items():
            if state_of(entry)[0] is not None:
                basis[str((entry or {}).get("basis") or "(none)")] += 1
    n_pairs = len(scored) * len(TAGS)
    readings = {}
    for reading in READINGS:
        tables = [patient_tables(s, g, reading) for s, g in zip(states, golds)]
        readings[reading] = summarize_reading(tables)
    if official:
        work = Path(work)
        gold_dir = work / "gold"
        gold_dir.mkdir(parents=True, exist_ok=True)
        for row in scored:
            (gold_dir / f"{row['patientId']}.xml").write_text(xml(row["tags"]), encoding="utf-8")
        for reading in READINGS:
            system_dir = work / f"system-{reading}"
            system_dir.mkdir(parents=True, exist_ok=True)
            for row, state in zip(scored, states):
                (system_dir / f"{row['patientId']}.xml").write_text(xml({tag: read_as(state[tag], tag, reading) for tag in TAGS}), encoding="utf-8")
            result = run_official(python, wrapper, scorer, gold_dir, system_dir)
            mine = readings[reading]
            if abs(result["micro"] - mine["microF1"]) > 5.1e-5 or abs(result["macro"] - mine["macroF1"]) > 5.1e-5:
                raise SelfCheckError(f"Reading ({reading}): the official scorer says {result['micro']}/{result['macro']}, this module {mine['microF1']:.4f}/{mine['macroF1']:.4f}")
            mine["official"] = {"microF1": result["micro"], "macroF1": result["macro"]}
    base = majority_states([row["tags"] for row in others]) if others else None
    baseline = None
    if base:
        tables = [patient_tables({tag: base[tag] for tag in TAGS}, g, "b") for g in golds]
        baseline = summarize_reading(tables)
        baseline["learntFrom"] = f"the {len(others)} training patients outside the split"
    intervals = bootstrap(states, golds, resamples)
    unknown = sum(kinds.values())
    return {
        "split": split, "patientsInSplit": len(members), "patientsScored": len(scored), "pairs": n_pairs,
        "accuracyA": {"point": accuracy_a(states, golds), "interval": intervals["a"]},
        "unknownShare": {"point": unknown / n_pairs, "interval": intervals["unknown"], "byKind": dict(kinds)},
        "readings": {reading: {**{k: v for k, v in readings[reading].items() if k != "perTag"}, "accuracyInterval": intervals[f"acc_{reading}"], "microF1Interval": intervals[f"f1_{reading}"]} for reading in READINGS},
        "perCriterion": {tag: {"goldMet": sum(g[tag] == "met" for g in golds), "unknownShare": sum(s[tag] is None for s in states) / len(states),
                               "accuracyA": sum(s[tag] == g[tag] for s, g in zip(states, golds)) / len(states),
                               **{f"accuracy{r.upper()}": readings[r]["perTag"][tag]["accuracy"] for r in READINGS}, **{f"f1{r.upper()}": readings[r]["perTag"][tag]["f1"] for r in READINGS}} for tag in TAGS},
        "yesNoBasis": dict(basis), "baseline": baseline,
    }


def completion(records, labels, split):
    members = [row["patientId"] for row in labels if row["split"] == split]
    held = [records[pid] for pid in members if pid in records]
    return {"patients": len(members), "patientsWithRecord": len(held), "patientsComplete": sum(r.get("status") == "complete" for r in held),
            "statusCounts": dict(Counter(str(r.get("status")) for r in held)),
            "pairsFailedByCode": dict(Counter(str(item.get("code")) for r in held for item in r.get("failed") or [])),
            "usage": {"inputTokens": sum((r.get("usage") or {}).get("inputTokens", 0) for r in held), "outputTokens": sum((r.get("usage") or {}).get("outputTokens", 0) for r in held),
                      "costCny": sum((r.get("usage") or {}).get("costCny", 0) for r in held)}}


def pct(value, interval_=None):
    text = "n/a" if value is None else f"{value:.3f}"
    return text if not interval_ else f"{text} [{interval_[0]:.3f}, {interval_[1]:.3f}]"


def markdown(result):
    s = result["score"]
    lines = [f"# Board F: n2c2 2018 Track 1, split {s['split']}", "",
             "Real de-identified notes; aggregates only. Readings: (a) no yes or no is wrong; (b) it is not met; (c) as (b) but ENGLISH and MAKES-DECISIONS met; (d) it is met.",
             f"Patient bootstrap, {RESAMPLES} resamples, 95% percentile intervals. Patients scored: {s['patientsScored']} of {s['patientsInSplit']} in the split ({s['pairs']} pairs).", "",
             f"Accuracy (a): {pct(s['accuracyA']['point'], s['accuracyA']['interval'])}. Unknown share: {pct(s['unknownShare']['point'], s['unknownShare']['interval'])} {s['unknownShare']['byKind']}.", "",
             "| reading | accuracy | micro F1 (official) | macro F1 (official) |", "|---|---|---|---|"]
    for reading, row in s["readings"].items():
        lines.append(f"| ({reading}){' primary' if reading == PRIMARY_READING else ''} | {pct(row['accuracy'], row['accuracyInterval'])} | {pct(row['microF1'], row['microF1Interval'])} ({pct(row.get('official', {}).get('microF1'))}) | {pct(row['macroF1'])} ({pct(row.get('official', {}).get('macroF1'))}) |")
    if s["baseline"]:
        lines.append(f"| majority baseline | {pct(s['baseline']['accuracy'])} | {pct(s['baseline']['microF1'])} | {pct(s['baseline']['macroF1'])} |")
    lines += ["", "| criterion | gold met | unknown | acc (a) | acc (b) | acc (c) | acc (d) | F1 (b) | F1 (c) | F1 (d) |", "|---|---|---|---|---|---|---|---|---|---|"]
    for tag, row in s["perCriterion"].items():
        lines.append(f"| {tag} | {row['goldMet']} | {row['unknownShare']:.2f} | {row['accuracyA']:.2f} | {row['accuracyB']:.2f} | {row['accuracyC']:.2f} | {row['accuracyD']:.2f} | {row['f1B']:.2f} | {row['f1C']:.2f} | {row['f1D']:.2f} |")
    c = result["completion"]
    lines += ["", f"The model's yes and no by basis: {s['yesNoBasis']} (`stated` has a sentence behind it, `silent` has none).",
              f"Completion: {c['patientsWithRecord']} of {c['patients']} patients have a record, {c['patientsComplete']} complete; failed by code {c['pairsFailedByCode']}; tokens in {c['usage']['inputTokens']:.0f}, out {c['usage']['outputTokens']:.0f}, cost CNY {c['usage']['costCny']:.2f}.", ""]
    return "\n".join(lines)


def main_f(args):
    """`score.py f`: read the judgments and the labels, check the official scorer's bytes, write board-f.json and .md."""
    root = Path(args.n2c2_root)
    scorer = root / "work" / "eval" / "track1_eval.py"
    digest = hashlib.sha256(scorer.read_bytes()).hexdigest()
    if digest != SCORER_SHA256:
        raise SelfCheckError("The official track1_eval.py differs from the reviewed bytes")
    if args.split not in SPLITS and not (args.split == "test" and args.unseal):
        raise SelfCheckError(f"Board F is scored on {', '.join(SPLITS)}; the test split is scored once, with --unseal, after the prompts are frozen.")
    labels = read_jsonl(Path(args.labels) / "F-n2c2" / "labels.jsonl")
    records = {}
    for record in read_jsonl(args.judgments):
        records[record.get("patientId")] = record
    wrapper = Path(__file__).resolve().parent.parent / "vcr-matching" / "n2c2" / "run_official_scorer.py"
    work = Path(args.work) / "board-f" / args.split
    result = {"score": score(records, labels, args.split, scorer, wrapper, args.python, work, args.resamples), "completion": completion(records, labels, args.split)}
    manifest = read_json(Path(args.n2c2_boards) / "F-n2c2" / "manifest.json")
    result["provenance"] = {"casesSha256": manifest["casesSha256"], "devDigest": manifest["devDigest"], "heldoutDigest": manifest["heldoutDigest"], "scorerSha256": digest, "testSealed": args.split != "test"}
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "board-f.json").write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    text = markdown(result)
    (out / "board-f.md").write_text(text, encoding="utf-8")
    print(text)


def cli(argv):
    parser = argparse.ArgumentParser(prog="score.py f", description="Board F: n2c2 2018 Track 1, scored with the official evaluator under stated readings.")
    parser.add_argument("--n2c2-boards", type=Path, required=True, help="board F's prepared directory (prepare_f.mjs)")
    parser.add_argument("--labels", type=Path, required=True, help="board F's labels directory")
    parser.add_argument("--n2c2-root", type=Path, required=True, help="the unpacked n2c2 files (work/eval/track1_eval.py)")
    parser.add_argument("--split", required=True, choices=(*SPLITS, "test"))
    parser.add_argument("--unseal", action="store_true", help="read the official test split: run once, after the prompts are frozen")
    parser.add_argument("--judgments", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--resamples", type=int, default=RESAMPLES)
    main_f(parser.parse_args(argv))
