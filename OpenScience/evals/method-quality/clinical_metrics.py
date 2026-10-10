"""Clinical task scorers used by run_paired; no inference, network or model weights.

Metrics remain separate. Missing predictions are in the denominator and unknown
is not a negative label. Span offsets are UTF-16 on the VCR boundary. DrugProt
source offsets are converted by its importer before these scorers see them.
"""
from __future__ import annotations
import argparse
import collections
import hashlib
import json
import math
import random
from pathlib import Path

VERSION = "evimed-clinical-metrics-1"


def ratio(n, d):
    return n / d if d else None


def prf(tp, fp, fn):
    return {"tp": tp, "fp": fp, "fn": fn, "precision": ratio(tp, tp + fp),
            "recall": ratio(tp, tp + fn), "f1": ratio(2 * tp, 2 * tp + fp + fn)}


def spans(reference, prediction, overlap=False):
    """Maximum one-to-one matching; duplicates can never earn extra recall."""
    gold, pred = reference.get("entities", []), prediction.get("entities", [])
    for row in gold + pred:
        if not isinstance(row.get("start"), int) or not isinstance(row.get("end"), int) or row["start"] < 0 or row["end"] <= row["start"]:
            raise ValueError("invalid_entity_span")
    def matches(a, b):
        return a.get("type") == b.get("type") and a.get("documentId") == b.get("documentId") and (
            max(a["start"], b["start"]) < min(a["end"], b["end"]) if overlap
            else (a["start"], a["end"]) == (b["start"], b["end"]))
    assigned = {}
    def augment(i, seen):
        for j, target in enumerate(gold):
            if j in seen or not matches(pred[i], target):
                continue
            seen.add(j)
            if j not in assigned or augment(assigned[j], seen):
                assigned[j] = i
                return True
        return False
    tp = sum(augment(i, set()) for i in range(len(pred)))
    return prf(tp, len(pred) - tp, len(gold) - tp)


def relations(reference, prediction):
    """Arguments are resolved to mention spans, not model-generated entity ids."""
    def keys(payload, side):
        mentions = {r["id"]: (r.get("documentId"), r["start"], r["end"], r["type"]) for r in payload.get("entities", [])}
        rows = []
        for index, r in enumerate(payload.get("relations", [])):
            a, b = mentions.get(r.get("arg1")), mentions.get(r.get("arg2"))
            if side == "reference" and not (a and b):
                raise ValueError("invalid_reference_relation")
            rows.append((r.get("type"), a, b) if a and b else ("unresolved_prediction", index, json.dumps(r, sort_keys=True)))
        return collections.Counter(rows)
    gold, pred = keys(reference, "reference"), keys(prediction, "prediction")
    tp = sum((gold & pred).values())
    return prf(tp, sum(pred.values()) - tp, sum(gold.values()) - tp)


def labels(reference, prediction, key="labels"):
    gold, pred = reference.get(key, {}), prediction.get(key, {})
    allowed = set(reference.get("states", []))
    confusion = collections.Counter()
    for name, target in gold.items():
        actual = pred.get(name, "missing")
        if name in pred and allowed and actual not in allowed:
            actual = "invalid"
        confusion[(str(target), str(actual))] += 1
    correct = sum(n for (a, b), n in confusion.items() if a == b)
    states = sorted(allowed or set(gold.values()))
    by_state = {}
    for state in states:
        tp = confusion[(state, state)]
        fp = sum(n for (a, b), n in confusion.items() if b == state and a != state)
        fn = sum(n for (a, b), n in confusion.items() if a == state and b != state)
        by_state[state] = prf(tp, fp, fn)
    f1s = [entry["f1"] for entry in by_state.values() if entry["f1"] is not None]
    return {"byState": by_state, "macroF1": sum(f1s) / len(f1s) if f1s else None,
            "n": len(gold), "correct": correct, "accuracy": ratio(correct, len(gold)),
            "unknown": sum(n for (_, b), n in confusion.items() if b in ("unknown", "insufficient_evidence", "pending_recheck", "pending")),
            "missing": len(set(gold) - set(pred)), "extra": len(set(pred) - set(gold)),
            "confusion": [{"reference": a, "prediction": b, "n": n} for (a, b), n in sorted(confusion.items())]}


def eligibility(reference, prediction):
    result = labels(reference, prediction)
    gold, pred = reference.get("labels", {}), prediction.get("labels", {})
    eligible = [key for key, value in gold.items() if value == "eligible"]
    result.update({"eligibleReference": len(eligible),
        "trueEligible": sum(pred.get(k) == "eligible" for k in eligible),
        "falseExclusions": sum(pred.get(k) == "ineligible" for k in eligible),
        "falseExclusionRate": ratio(sum(pred.get(k) == "ineligible" for k in eligible), len(eligible)),
        "eligibleRecall": ratio(sum(pred.get(k) == "eligible" for k in eligible), len(eligible)),
        "falseInclusions": sum(value != "eligible" and pred.get(k) == "eligible" for k, value in gold.items())})
    return result


def retrieval(reference, prediction):
    gold = set(reference.get("eligibleTrials", []))
    ranked = list(dict.fromkeys(prediction.get("candidates", [])))
    k = reference.get("k", 10)
    if not isinstance(k, int) or k < 1:
        raise ValueError("invalid_retrieval_k")
    return {"eligibleUniverse": len(gold), "returned": len(ranked), "k": k,
            "candidateRecall": ratio(len(gold & set(ranked)), len(gold)),
            "recallAtK": ratio(len(gold & set(ranked[:k])), len(gold)),
            "precisionAtK": ratio(len(gold & set(ranked[:k])), k)}


def privacy(reference, prediction):
    text = str(prediction.get("text", ""))
    by_type = {}
    for kind in sorted({x["type"] for x in reference.get("identifiers", [])}):
        values = {x["value"] for x in reference["identifiers"] if x["type"] == kind}
        by_type[kind] = {"tested": len(values), "residual": sum(v in text for v in values if v)}
    anchors = reference.get("utilityAnchors", [])
    return {"identifierTypes": by_type, "utilityAnchors": len(anchors), "retainedAnchors": sum(a in text for a in anchors),
            "scope": "Observed exact canaries only; this is not a proof of universal de-identification."}


def score(task, reference, prediction):
    if not isinstance(reference, dict) or not isinstance(prediction, dict):
        raise ValueError("clinical_payload_not_object")
    methods = {"ner": lambda: {"strict": spans(reference, prediction), "overlap": spans(reference, prediction, True)},
               "relation": lambda: relations(reference, prediction), "assertion": lambda: labels(reference, prediction),
               "coding": lambda: labels(reference, prediction), "temporal": lambda: labels(reference, prediction),
               "criterion": lambda: labels(reference, prediction), "eligibility": lambda: eligibility(reference, prediction),
               "retrieval": lambda: retrieval(reference, prediction), "privacy": lambda: privacy(reference, prediction)}
    if task not in methods:
        raise ValueError("unsupported_clinical_task")
    return {"task": task, "scorer": VERSION, "metrics": methods[task]()}


def cluster_interval(rows, numerator, denominator, seed=20261009, repeats=2000):
    """Resample source/patient groups; repeated prompts are never independent cases."""
    groups = collections.defaultdict(list)
    for row in rows:
        groups[row["sourceGroup"]].append(row)
    if len(groups) < 2:
        return {"low": None, "high": None, "groups": len(groups), "reason": "fewer_than_two_source_groups"}
    rng, names, samples = random.Random(seed), list(groups), []
    for _ in range(repeats):
        drawn = [r for name in rng.choices(names, k=len(names)) for r in groups[name]]
        value = ratio(sum(r[numerator] for r in drawn), sum(r[denominator] for r in drawn))
        if value is not None and math.isfinite(value):
            samples.append(value)
    samples.sort()
    return {"low": samples[int(len(samples) * .025)] if samples else None,
            "high": samples[min(len(samples) - 1, int(len(samples) * .975))] if samples else None,
            "groups": len(groups), "seed": seed, "repeats": repeats}


def verify_groups(splits):
    seen = {}
    owners = {}
    for group in splits.get("sourceGroups", []):
        for brief in group["briefs"]:
            if brief in owners and owners[brief] != group["id"]:
                raise ValueError("ambiguous_source_group")
            owners[brief] = group["id"]
            destinations = [name for name in ("dev", "holdout") if brief in splits[name]["briefs"]]
            if len(destinations) != 1:
                raise ValueError("clinical_split_missing_or_overlapping")
            previous = seen.setdefault(group["id"], destinations[0])
            if previous != destinations[0]:
                raise ValueError("related_records_cross_splits")


def scorecard(rows):
    """Independent rows by task and data class; no all-task quality number."""
    groups = collections.defaultdict(list)
    for row in rows:
        groups[(row["task"], row["dataClass"])].append(row)
    result = []
    for (task, data_class), cases in sorted(groups.items()):
        row = {"task": task, "dataClass": data_class, "cases": len(cases),
               "sourceGroups": len({c["sourceGroup"] for c in cases}),
               "missing": sum(c["status"] == "missing" for c in cases),
               "invalid": sum(c["status"] == "invalid" for c in cases)}
        metrics = [{"sourceGroup": c["sourceGroup"], **c["metrics"]} for c in cases]
        if task == "ner":
            for mode in ("strict", "overlap"):
                row[mode] = prf(*(sum(m[mode][key] for m in metrics) for key in ("tp", "fp", "fn")))
        elif task == "relation":
            row["relations"] = prf(*(sum(m[key] for m in metrics) for key in ("tp", "fp", "fn")))
        elif task in ("assertion", "coding", "temporal", "criterion", "eligibility"):
            row.update(n=sum(m["n"] for m in metrics), correct=sum(m["correct"] for m in metrics), unknown=sum(m["unknown"] for m in metrics))
            row["accuracy"] = ratio(row["correct"], row["n"])
            states = sorted({state for m in metrics for state in m['byState']})
            row['byState'] = {state: prf(*(sum(m['byState'].get(state, {}).get(key, 0) for m in metrics) for key in ('tp','fp','fn'))) for state in states}
            f1s = [value['f1'] for value in row['byState'].values() if value['f1'] is not None]
            row['macroF1'] = sum(f1s)/len(f1s) if f1s else None
            row["accuracyInterval"] = cluster_interval(metrics, "correct", "n")
            if task == "eligibility":
                row.update(eligibleReference=sum(m["eligibleReference"] for m in metrics), falseExclusions=sum(m["falseExclusions"] for m in metrics))
                row["falseExclusionRate"] = ratio(row["falseExclusions"], row["eligibleReference"])
                row["falseExclusionInterval"] = cluster_interval(metrics, "falseExclusions", "eligibleReference")
                row['eligibleRecall'] = ratio(sum(m['trueEligible'] for m in metrics), row['eligibleReference'])
                row['falseInclusions'] = sum(m['falseInclusions'] for m in metrics)
                eligible_groups = {m['sourceGroup'] for m in metrics if m['eligibleReference']}
                failed_groups = {m['sourceGroup'] for m in metrics if m['falseExclusions']}
                n = len(eligible_groups)
                if n:
                    p, z = len(failed_groups)/n, 1.96
                    center = (p+z*z/(2*n))/(1+z*z/n)
                    width = z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/(1+z*z/n)
                    row['anyFalseExclusionPerGroupWilson95'] = {'groups': n, 'observed': len(failed_groups), 'low': max(0,center-width), 'high': min(1,center+width)}
                row['intervalScope'] = 'Repeated prompts are clustered; zero observed events are not proof of zero error. Synthetic cases are not a population sample.'
        result.append(row)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument('--also-ner', action='store_true', help='Also score mention spans of a relation corpus, separately')
    args = parser.parse_args()
    reference = json.loads(args.reference.read_text())
    predictions = json.loads(args.predictions.read_text())
    rows = []
    for case in reference["cases"]:
        prediction = predictions.get(case["id"], {})
        status = "predicted" if case["id"] in predictions else "missing"
        if isinstance(prediction, dict) and prediction.get('parseError'):
            status = 'invalid'
        try:
            scored = score(case["task"], case["reference"], prediction)
        except (ValueError, TypeError, KeyError):
            # Invalid model output is a measured failure; an invalid reference still raises.
            scored = score(case["task"], case["reference"], {})
            status = "invalid"
        rows.append({"id": case["id"], "sourceGroup": case["sourceGroup"], "dataClass": case["dataClass"],
                     "status": status, **scored})
        if args.also_ner and case['task'] == 'relation':
            try:
                mention_score = score('ner', case['reference'], prediction)
            except (ValueError, TypeError, KeyError):
                mention_score, status = score('ner', case['reference'], {}), 'invalid'
            rows.append({'id': case['id']+':ner', 'sourceGroup':case['sourceGroup'], 'dataClass':case['dataClass'], 'status':status, **mention_score})
    report = {"scorer": VERSION, "referenceHash": hashlib.sha256(args.reference.read_bytes()).hexdigest(),
              "predictionHash": hashlib.sha256(args.predictions.read_bytes()).hexdigest(), "cases": rows, "scorecard": scorecard(rows),
              "note": "Task scores are separate; no blended clinical accuracy or clinical qualification."}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
