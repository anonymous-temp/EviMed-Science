"""Board A architecture search from saved per-pair signals: which ranker, cascade or fusion orders a patient's judged candidates best.

Every signal is a saved answer for one (patient, trial) pair, so a cascade is computed exactly as a live run would order it (the
expensive stage answers the shortlist the cheap stage chose; its answers for the other pairs are never read). The choice is made on the
dev topics only and written to <out>/CHOICE.json before any test topic is scored; `--confirm` then scores the written choice on test and
on all topics, with paired bootstrap intervals against the single-ranker baselines. Gold labels are read only to score.

    python3 -I -B arch_search.py search  --signals <signals.json> --out <dir>
    python3 -I -B arch_search.py confirm --signals <signals.json> --out <dir>

<signals.json> names where each saved signal is:
  {"boards": <Board A dir>, "qrels": <TrialGPT 2.0 data dir>,
   "deepseek": {"sigir": <judgments.jsonl>, "trec_2021": ..., "trec_2022": ...},
   "jev": {"jev113": <pairs.jsonl>, "jev114": <pairs.jsonl>}, "qwen": {"qwen": <pairs.jsonl>}}

Metrics follow the official TrialGPT 2.0 evaluator: nDCG@10 with gains 2/1/0 and the ideal list from all judged trials; graded P@10 =
sum(grade/2)/10; eligible P@10; MRR on the first eligible trial; plus the share of excluded trials in the top ten. Cohort means, then the
mean of the three cohorts.
"""
import argparse
import itertools
import json
import math
import random
import statistics as st
from pathlib import Path

COHORTS = {"sigir": "A-sigir", "trec_2021": "A-trec2021", "trec_2022": "A-trec2022"}
METRICS = ("ndcg", "gp10", "ep10", "mrr", "ex10")


def jsonl(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def dcg(gains):
    return sum(g / math.log2(i + 2) for i, g in enumerate(gains[:10]))


def metrics(order, truth):
    ideal = dcg(sorted(truth.values(), reverse=True))
    if not ideal:
        return None
    g = [truth.get(t, 0) for t in order]
    return {"ndcg": dcg(g) / ideal, "gp10": sum(x / 2 for x in g[:10]) / 10, "ep10": sum(x == 2 for x in g[:10]) / 10,
            "mrr": next((1 / (i + 1) for i, x in enumerate(g) if x == 2), 0.0), "ex10": sum(x == 1 for x in g[:10]) / 10}


class Data:
    def __init__(self, spec):
        self.cases, self.qrels, self.split = {}, {}, {}
        for cohort, directory in COHORTS.items():
            for case in jsonl(Path(spec["boards"]) / directory / "cases.jsonl"):
                self.cases[case["patientId"]] = (cohort, case["candidateIds"])
                self.split[case["patientId"]] = case["split"]
            for line in (Path(spec["qrels"]) / cohort / "qrels" / "test.tsv").read_text().splitlines()[1:]:
                p, t, g = line.split("\t")
                self.qrels.setdefault(p, {})[t] = int(g)
        self.signals = {}  # name -> {patient: {trial: value}}
        ds, dsc = {}, {}
        for cohort, path in spec["deepseek"].items():
            for record in jsonl(path):
                for entry in record["ranking"]:
                    ds.setdefault(record["patientId"], {})[entry["registryId"]] = float(entry["fit"])
                    dsc.setdefault(record["patientId"], {})[entry["registryId"]] = float(entry["fit"]) + float(entry.get("confidence") or 0)
        self.signals["ds"] = ds
        self.signals["ds_fc"] = dsc  # TrialGPT 2.0's final score: fit plus confidence
        for name, path in spec.get("jev", {}).items():
            for row in jsonl(path):
                if "error" in row:
                    continue
                for key in ("fit", "graded", "rel"):
                    if key in row and row[key] is not None:
                        self.signals.setdefault(f"{name}.{key}", {}).setdefault(row["p"], {})[row["t"]] = float(row[key])
                        probs = row.get(key + "P")
                        if probs:  # probability of the top two levels, a second view of the same answer
                            top = sorted(probs, key=int)[-2:]
                            self.signals.setdefault(f"{name}.{key}.top2", {}).setdefault(row["p"], {})[row["t"]] = sum(float(probs[k]) for k in top)
        for name, path in spec.get("qwen", {}).items():
            for row in jsonl(path):
                if "error" not in row:
                    self.signals.setdefault(name, {}).setdefault(row["p"], {}).update(row["scores"])

    def derive_rrf(self, names, k=60):
        """A signal per pair: the reciprocal-rank-fusion score of the named signals' orders (a cheap fused ranker)."""
        name = "rrf(" + "+".join(names) + ")"
        if name in self.signals:
            return name
        out = {}
        for p, (_, ids) in self.cases.items():
            if not all(p in self.signals.get(n, {}) and len(self.signals[n][p]) >= len(ids) for n in names):
                continue
            total = {t: 0.0 for t in ids}
            for n in names:
                for rank, t in enumerate(sorted(ids, key=lambda t: (-self.signals[n][p][t], t))):
                    total[t] += 1 / (k + rank + 1)
            out[p] = total
        self.signals[name] = out
        return name

    def complete(self, names):
        """Patients for whom every named signal answered every candidate."""
        keep = []
        for p, (_, ids) in self.cases.items():
            if p in self.qrels and all(p in self.signals.get(n, {}) and len(self.signals[n][p]) >= len(ids) for n in names):
                keep.append(p)
        return keep


def by(signal, patient, ids, tie=None):
    values = signal[patient]
    tie_values = tie[patient] if tie else {}
    return sorted(ids, key=lambda t: (-values[t], -tie_values.get(t, 0.0), t))


def zscores(signal, patient, ids):
    values = [signal[patient][t] for t in ids]
    mean, sd = st.fmean(values), (st.pstdev(values) or 1.0)
    return {t: (signal[patient][t] - mean) / sd for t in ids}


def strategy(data, spec, patient):
    """One ordering of the patient's candidates for a strategy spec (a dict)."""
    ids = data.cases[patient][1]
    s = data.signals
    kind = spec["kind"]
    if kind == "single":
        return by(s[spec["a"]], patient, ids, s.get(spec.get("tie")))
    if kind == "cascade":  # cheap ranker a orders everything; expensive ranker b reorders a's top k
        first = by(s[spec["a"]], patient, ids, s.get(spec.get("tie")))
        head = sorted(first[:spec["k"]], key=lambda t: (-s[spec["b"]][patient][t], first.index(t)))
        return head + first[spec["k"]:]
    if kind == "cascade_fuse":  # a orders all; a's top k reordered by the fusion of b's order and a's order inside the head
        first = by(s[spec["a"]], patient, ids)
        head = first[:spec["k"]]
        b_rank = {t: i for i, t in enumerate(sorted(head, key=lambda t: (-s[spec["b"]][patient][t], first.index(t))))}
        fused = {t: spec.get("wb", 1.0) / (spec.get("rk", 60) + b_rank[t] + 1) + 1.0 / (spec.get("rk", 60) + i + 1) for i, t in enumerate(head)}
        return sorted(head, key=lambda t: (-fused[t], first.index(t))) + first[spec["k"]:]
    if kind == "cascade3":  # a orders all, b reorders a's top n, c reorders b's top k
        first = by(s[spec["a"]], patient, ids)
        second = sorted(first[:spec["n"]], key=lambda t: (-s[spec["b"]][patient][t], first.index(t))) + first[spec["n"]:]
        head = sorted(second[:spec["k"]], key=lambda t: (-s[spec["c"]][patient][t], second.index(t)))
        return head + second[spec["k"]:]
    if kind == "zfuse":  # weighted sum of per-patient standardised scores
        parts = [(w, zscores(s[name], patient, ids)) for name, w in spec["w"].items() if w]
        total = {t: sum(w * z[t] for w, z in parts) for t in ids}
        return sorted(ids, key=lambda t: (-total[t], t))
    if kind == "rrf":
        total = {t: 0.0 for t in ids}
        for name in spec["names"]:
            for rank, t in enumerate(by(s[name], patient, ids)):
                total[t] += 1 / (spec.get("k", 60) + rank + 1)
        return sorted(ids, key=lambda t: (-total[t], t))
    raise ValueError(kind)


def needs(spec):
    return [spec[k] for k in ("a", "b", "c") if k in spec] + list(spec.get("w", {})) + list(spec.get("names", [])) + ([spec["tie"]] if spec.get("tie") else [])


def evaluate(data, spec, patients):
    per = {}
    for p in patients:
        m = metrics(strategy(data, spec, p), data.qrels[p])
        if m:
            per[p] = m
    return per


def macro(data, per, key):
    groups = {}
    for p, m in per.items():
        groups.setdefault(data.cases[p][0], []).append(m[key])
    return st.fmean(st.fmean(v) for v in groups.values()), {c: st.fmean(v) for c, v in groups.items()}


def paired(data, a, b, key, n=10000, seed=20261107):
    rng = random.Random(seed)
    diffs = {}
    for p in a:
        if p in b:
            diffs.setdefault(data.cases[p][0], []).append(a[p][key] - b[p][key])
    observed = st.fmean(st.fmean(v) for v in diffs.values())
    samples = sorted(st.fmean(st.fmean(rng.choices(v, k=len(v))) for v in diffs.values()) for _ in range(n))
    return observed, samples[int(0.025 * n)], samples[int(0.975 * n)]


def candidates(data):
    """The strategy family searched on dev."""
    singles = [n for n in data.signals]
    out = [{"kind": "single", "a": n} for n in singles]
    cheap = [n for n in singles if n.startswith(("jev", "qwen"))]
    plain = [n for n in cheap if not n.endswith("top2")]
    for a, b in itertools.combinations(plain, 2):
        cheap.append(data.derive_rrf([a, b]))
    for name in [n for n in cheap if n.startswith("rrf(")]:
        out.append({"kind": "single", "a": name})
    for a in cheap:
        for k in (20, 30):
            out.append({"kind": "cascade_fuse", "a": a, "b": "ds", "k": k})
            out.append({"kind": "cascade_fuse", "a": a, "b": "ds", "k": k, "wb": 2.0})
    for a in cheap:
        for k in (10, 15, 20, 30, 50):
            out.append({"kind": "cascade", "a": a, "b": "ds", "k": k})
            out.append({"kind": "cascade", "a": a, "b": "ds_fc", "k": k})
    for a, b in itertools.permutations([n for n in cheap if not n.endswith("top2")], 2):
        for n in (50, 100):
            for k in (20, 30):
                out.append({"kind": "cascade3", "a": a, "b": b, "c": "ds", "n": n, "k": k})
    for combo in itertools.combinations([n for n in singles if not n.endswith("top2")], 2):
        out.append({"kind": "rrf", "names": list(combo)})
    base = [n for n in ("qwen", "jev114.fit", "jev114.graded", "ds") if n in data.signals]
    grid = (0, 0.5, 1, 2)
    for weights in itertools.product(grid, repeat=len(base)):
        if sum(1 for w in weights if w) >= 2:
            out.append({"kind": "zfuse", "w": dict(zip(base, weights))})
    return out


def cost(spec, data, patients):
    """Pairs each paid stage answers per patient on average: the expensive Flash stage is what a cascade saves."""
    n = st.fmean(len(data.cases[p][1]) for p in patients)
    flash = spec["k"] if spec["kind"] in ("cascade", "cascade3", "cascade_fuse") else (n if "ds" in needs(spec) or "ds_fc" in needs(spec) else 0)
    return {"flashPairsPerPatient": round(min(flash, n), 1), "poolPerPatient": round(n, 1)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("search", "confirm", "export"))
    parser.add_argument("--signals", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    spec = json.loads(Path(args.signals).read_text())
    data = Data(spec)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    choice_file = out / "CHOICE.json"
    if args.command == "search":
        rows = []
        for cand in candidates(data):
            pats = [p for p in data.complete(needs(cand)) if data.split[p] == "dev"]
            if not pats:
                continue
            per = evaluate(data, cand, pats)
            row = {"spec": cand, "patients": len(per), **{k: macro(data, per, k)[0] for k in METRICS}, **cost(cand, data, pats)}
            rows.append(row)
        rows.sort(key=lambda r: -r["ndcg"])
        (out / "dev-search.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
        for r in rows[:25]:
            print(f"{r['ndcg']:.4f} gp {r['gp10']:.3f} ep {r['ep10']:.3f} mrr {r['mrr']:.3f} ex {r['ex10']:.3f} n={r['patients']} flash/pt {r['flashPairsPerPatient']} {json.dumps(r['spec'])}")
        return 0
    choice = json.loads(choice_file.read_text())
    if args.command == "export":  # every arm of the choice as judgments.jsonl per cohort, for the official evaluator
        arms = {"chosen": choice["spec"], **{name: {"kind": "single", "a": name} for name in choice.get("baselines", [])}, **choice.get("alternatives", {})}
        for s in arms.values():
            for n in needs(s):
                if n.startswith("rrf(") and n not in data.signals:
                    data.derive_rrf(n[4:-1].split("+"))
        for name, s in arms.items():
            pats = data.complete(needs(s))
            for cohort in COHORTS:
                target = out / "export" / name.replace(" ", "_").replace("/", "-") / cohort / "judgments.jsonl"
                target.parent.mkdir(parents=True, exist_ok=True)
                lines = []
                for p in pats:
                    if data.cases[p][0] != cohort:
                        continue
                    order = strategy(data, s, p)
                    lines.append(json.dumps({"patientId": p, "status": "complete", "ranking": [{"registryId": t, "rank": i + 1} for i, t in enumerate(order)], "failed": []}))
                target.write_text("\n".join(lines) + "\n")
        print("exported", len(arms), "arms")
        return 0
    report = {"choice": choice, "rows": []}
    arms = {"chosen": choice["spec"], **{name: {"kind": "single", "a": name} for name in choice.get("baselines", [])},
            **{name: s for name, s in choice.get("alternatives", {}).items()}}
    for s in arms.values():  # derived fused signals named in the choice are rebuilt the same way
        for n in needs(s):
            if n.startswith("rrf(") and n not in data.signals:
                data.derive_rrf(n[4:-1].split("+"))
    names = sorted({n for s in arms.values() for n in needs(s)})
    for split in ("dev", "test", "all"):
        pats = [p for p in data.complete(names) if split == "all" or data.split[p] == split]
        results = {name: evaluate(data, s, pats) for name, s in arms.items()}
        for name, per in results.items():
            row = {"split": split, "arm": name, "patients": len(per)}
            for k in METRICS:
                row[k], row[k + "ByCohort"] = macro(data, per, k)
            for base in choice.get("baselines", []):
                if base != name:
                    row[f"vs_{base}"] = {k: paired(data, per, results[base], k) for k in ("ndcg", "gp10", "ep10")}
            report["rows"].append(row)
    (out / "confirm.json").write_text(json.dumps(report, indent=1))
    for r in report["rows"]:
        print(f"{r['split']:5} {r['arm']:28} n={r['patients']:3} nDCG {r['ndcg']:.4f} gP {r['gp10']:.4f} eP {r['ep10']:.4f} MRR {r['mrr']:.4f} ex {r['ex10']:.3f}"
              + "".join(f" | vs {b}: {v['ndcg'][0]:+.4f} [{v['ndcg'][1]:+.4f},{v['ndcg'][2]:+.4f}]" for b, v in ((k[3:], r[k]) for k in r if k.startswith("vs_"))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
