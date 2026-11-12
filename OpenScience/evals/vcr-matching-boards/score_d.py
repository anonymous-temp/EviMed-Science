"""Board D: patient-level eligibility, in the form VERDICT (stanford-oval/clinical-trial-matching, Apache-2.0, commit a56e3ed09f10) scores it.

What the published scorer does (`scripts/tables/table2_trec2021_f1.py`, read at the pinned commit): a pair is a patient and a trial, keyed
`<patient>__<NCT>` (or a two-item list); the frozen file holds `{pair, gold}` with gold `eligible` or `ineligible`; a system's answer is
`eligible` or not; "eligible" is the positive class; P = tp/(tp+fp), R = tp/(tp+fn), F1 = 2PR/(P+R), accuracy = (tp+tn)/n over the pairs the
file holds. A pair the system did not answer cannot be scored by that script (it reads a verdict for every record); here it is not dropped
silently: it is counted, and reported both as left out and as not eligible.

Our verdict (`trialVerdict`: eligible, possible, insufficient, ineligible) is mapped to their binary answer like this, and `possible` is
reported both ways because it is the one the mapping cannot settle:

    eligible      -> eligible
    ineligible    -> ineligible
    insufficient  -> ineligible    (the evidence did not support calling the patient eligible)
    possible      -> eligible in reading "possible = eligible", ineligible in reading "possible = ineligible"

The pair files are not released: the SIGIR 539/552 pairs and their gold (the majority of five LM judges) and the TREC 2021 363 pairs
(`svpo-rl`, a private repository) are not in the repository at the pinned commit, so this scorer waits for files in their shape from the owner.
No data of theirs is read or written here.
"""
import argparse
import json
from pathlib import Path
import random
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))  # python -I does not add the script directory

from common import read_jsonl

PINNED = {"repo": "stanford-oval/clinical-trial-matching", "commit": "a56e3ed09f10928dd033baefb1b78856943aa99f", "license": "Apache-2.0"}
READINGS = ("possible_is_eligible", "possible_is_ineligible")
RESAMPLES = 2000
SEED = 20261104


def pair_key(pair):
    """Their key: a two-item list or `<patient>__<NCT>`."""
    if isinstance(pair, (list, tuple)):
        return (str(pair[0]), str(pair[1]).upper())
    patient, _, trial = str(pair).partition("__")
    return (patient, trial.upper())


def binary(verdict, reading):
    """Our verdict as their answer: True is eligible. None when there is no verdict."""
    verdict = str(verdict or "").strip().lower()
    if verdict == "eligible":
        return True
    if verdict in ("ineligible", "insufficient"):
        return False
    if verdict == "possible":
        return reading == "possible_is_eligible"
    return None


def prf(tp, fp, fn, tn):
    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)
    f1 = 2 * precision * recall / max(1e-9, precision + recall)
    n = tp + fp + fn + tn
    return {"n": n, "precision": precision, "recall": recall, "f1": f1, "accuracy": (tp + tn) / max(1, n)}


def tally(rows, reading, unanswered):
    """tp/fp/fn/tn over (patient, gold_eligible, verdict) rows; `unanswered` is 'left_out' or 'ineligible'."""
    tp = fp = fn = tn = 0
    for _, gold_eligible, verdict in rows:
        predicted = binary(verdict, reading)
        if predicted is None:
            if unanswered == "left_out":
                continue
            predicted = False
        if predicted and gold_eligible:
            tp += 1
        elif predicted:
            fp += 1
        elif gold_eligible:
            fn += 1
        else:
            tn += 1
    return tp, fp, fn, tn


def interval(values):
    ordered = sorted(values)
    return [ordered[int(0.025 * (len(ordered) - 1))], ordered[min(len(ordered) - 1, int(0.975 * (len(ordered) - 1) + 0.999999))]]


def score(judgments, pairs, resamples=RESAMPLES):
    """Aggregates for owner-supplied pairs: P/R/F1/accuracy for `possible` both ways, with a patient bootstrap for the F1."""
    verdicts = {}
    for record in judgments:
        for entry in record.get("ranking") or []:
            verdicts[(str(record.get("patientId")), str(entry.get("registryId")).upper())] = entry.get("verdict")
    rows = []
    for item in pairs:
        key = pair_key(item["pair"])
        rows.append((key[0], str(item.get("gold", "")).lower() == "eligible", verdicts.get(key)))
    answered = sum(verdict is not None for _, _, verdict in rows)
    by_patient = {}
    for row in rows:
        by_patient.setdefault(row[0], []).append(row)
    patients = sorted(by_patient)
    result = {"pairs": len(rows), "pairsAnswered": answered, "goldEligible": sum(gold for _, gold, _ in rows), "pairsPerVerdict": {}, "readings": {}}
    for _, _, verdict in rows:
        name = str(verdict) if verdict is not None else "(none)"
        result["pairsPerVerdict"][name] = result["pairsPerVerdict"].get(name, 0) + 1
    rng = random.Random(f"{SEED}|d")
    for reading in READINGS:
        for unanswered in ("left_out", "ineligible"):
            point = prf(*tally(rows, reading, unanswered))
            draws = []
            for _ in range(resamples if patients else 0):
                picked = [r for p in rng.choices(patients, k=len(patients)) for r in by_patient[p]]
                draws.append(prf(*tally(picked, reading, unanswered))["f1"])
            result["readings"][f"{reading}|unanswered_{unanswered}"] = {**point, "f1Interval": interval(draws) if draws else None}
    return result


def main_d(args):
    pairs = read_jsonl(args.pairs)
    result = {"pinned": PINNED, "score": score(read_jsonl(args.judgments), pairs, args.resamples)}
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "board-d.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    s = result["score"]
    lines = [f"# Board D: patient-level eligibility (their pair file, our verdicts)", "", f"Pairs {s['pairs']}, answered {s['pairsAnswered']}, gold eligible {s['goldEligible']}; verdicts {s['pairsPerVerdict']}.", "",
             "| reading | P | R | F1 | accuracy | n |", "|---|---|---|---|---|---|"]
    for name, row in s["readings"].items():
        ci = f" [{row['f1Interval'][0]:.3f}, {row['f1Interval'][1]:.3f}]" if row["f1Interval"] else ""
        lines.append(f"| {name} | {row['precision']:.3f} | {row['recall']:.3f} | {row['f1']:.3f}{ci} | {row['accuracy']:.3f} | {row['n']} |")
    text = "\n".join(lines) + "\n"
    (out / "board-d.md").write_text(text, encoding="utf-8")
    print(text)


def cli(argv):
    parser = argparse.ArgumentParser(prog="score.py d", description="Board D: F1 on owner-supplied pairs in the shape of the VERDICT repository's frozen test files.")
    parser.add_argument("--pairs", type=Path, required=True, help='jsonl of {"pair": "<patient>__<NCT>" or [patient, NCT], "gold": "eligible" | "ineligible"}')
    parser.add_argument("--judgments", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--resamples", type=int, default=RESAMPLES)
    main_d(parser.parse_args(argv))
