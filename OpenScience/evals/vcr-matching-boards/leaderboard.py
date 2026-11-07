"""Leaderboard tables in the Arena style from saved rankings: point score, 95% percentile-bootstrap interval over patients (the same
resamples for every system, so paired differences are exact), rank and rank spread, and reported systems listed beside them.

    python3 -B leaderboard.py --config <leaderboard.json> --out <dir>

<leaderboard.json>:
  {"board": "A" | "E", "title": "...", "primary": "ndcg",
   "qrels": {"kind": "tg2", "dir": <TrialGPT 2.0 data dir>} | {"kind": "trec", "dir": <dir with qrels2021.txt ...>},
   "cohorts": ["sigir", "trec_2021", "trec_2022"],   # Board A; Board E: ["2021", "2022", "2023"]
   "patients": {"all": [...ids...]} optional restriction,
   "arms": [{"name", "type", "backbone", "orders": <judgments.jsonl | run.jsonl>, "cost": "...", "note": "..."}],
   "reported": [{"name", "type", "backbone", "scores": {"ndcg": .., "gp10": .., ...}, "source": "..."}]}

Rank spread follows Arena's rule: best = 1 + #{systems whose lower bound is above this system's upper bound}; worst = N - #{systems whose upper
bound is below this system's lower bound}; reported systems without per-patient outputs have no interval and do not bound others.
"""
import argparse
import json
import math
import random
import statistics as st
from pathlib import Path

METRIC_NAMES = {"ndcg": "nDCG@10", "gp10": "P@10 (graded)", "ep10": "P@10 (eligible)", "mrr": "MRR", "ex10": "Excluded in top 10"}


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
            "mrr": next((1 / (i + 1) for i, x in enumerate(g) if x == 2), 0.0), "ex10": sum(x == 1 for x in g[:10]) / 10,
            "j10": sum(t in truth for t in order[:10]) / 10}


def qrels(spec):
    q = {}
    if spec["kind"] == "tg2":
        for cohort in ("sigir", "trec_2021", "trec_2022"):
            for line in (Path(spec["dir"]) / cohort / "qrels" / "test.tsv").read_text().splitlines()[1:]:
                p, t, g = line.split("\t")
                q.setdefault(p, {})[t] = int(g)
    else:
        for year in (2021, 2022, 2023):
            for line in (Path(spec["dir"]) / f"qrels{year}.txt").read_text().splitlines():
                p = line.split()
                if len(p) >= 4:
                    topic = f"trec-2023-{p[0]}" if year == 2023 else f"trec-{year}{p[0]}"
                    q.setdefault(topic, {})[p[2]] = int(p[3])
    return q


def orders(path):
    out = {}
    for row in jsonl(path):
        if "ranking" in row:
            out[row["patientId"]] = [e["registryId"] for e in row["ranking"]]
        else:
            out[row["topic"]] = row["ids"]
    return out


def macro(per, keys, metric, board):
    groups = {}
    for p in keys:
        groups.setdefault(group(p, board), []).append(per[p][metric])
    return st.fmean(st.fmean(v) for v in groups.values())


def group(patient, board):
    if board == "A":
        return "sigir" if patient.startswith("sigir") else ("trec_2021" if patient.startswith("trec-2021") else "trec_2022")
    return "2023" if patient.startswith("trec-2023-") else patient[5:9]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--resamples", type=int, default=10000)
    a = ap.parse_args()
    cfg = json.loads(Path(a.config).read_text())
    board, primary = cfg["board"], cfg.get("primary", "ndcg")
    truth = qrels(cfg["qrels"])
    allowed = set(cfg["patients"]) if cfg.get("patients") else None
    arms = []
    for arm in cfg["arms"]:
        o = orders(arm["orders"])
        per = {p: m for p, ids in o.items() if p in truth and (allowed is None or p in allowed) for m in [metrics(ids, truth[p])] if m}
        arms.append({**arm, "per": per})
    common = sorted(set.intersection(*(set(arm["per"]) for arm in arms))) if arms else []
    by_group = {}
    for p in common:
        by_group.setdefault(group(p, board), []).append(p)
    rng = random.Random(20261107)
    resamples = [{g: [rng.randrange(len(v)) for _ in v] for g, v in by_group.items()} for _ in range(a.resamples)]
    metric_keys = ["ndcg", "gp10", "ep10", "mrr", "ex10"] + (["j10"] if board == "E" else [])
    for arm in arms:
        arm["point"] = {k: macro(arm["per"], common, k, board) for k in metric_keys}
        arm["byGroup"] = {g: {k: st.fmean(arm["per"][p][k] for p in v) for k in metric_keys} for g, v in by_group.items()}
        samples = []
        for draw in resamples:
            samples.append(st.fmean(st.fmean(arm["per"][by_group[g][i]][primary] for i in idx) for g, idx in draw.items()))
        arm["samples"] = samples  # in resample order, so two systems pair draw by draw
        ordered = sorted(samples)
        arm["ci"] = (ordered[int(0.025 * len(ordered))], ordered[int(0.975 * len(ordered)) - 1])
    n = len(arms)
    for arm in arms:
        lo, hi = arm["ci"]
        arm["best"] = 1 + sum(1 for b in arms if b is not arm and b["ci"][0] > hi)
        arm["worst"] = n - sum(1 for b in arms if b is not arm and b["ci"][1] < lo)
    arms.sort(key=lambda r: -r["point"][primary])
    lines = [f"### {cfg['title']}", "", f"Patients/topics scored: {len(common)} ({', '.join(f'{g} {len(v)}' for g, v in sorted(by_group.items()))}). "
             f"Primary metric {METRIC_NAMES[primary]}; 95% CI: percentile bootstrap over patients within each cohort, {a.resamples:,} resamples, macro over cohorts.", ""]
    head = ["Rank", "Rank spread", "System", "Type", "Backbone", METRIC_NAMES[primary], "95% CI"] + [METRIC_NAMES.get(k, "J@10") for k in metric_keys if k != primary] + ["Cost", "Source"]
    lines.append("| " + " | ".join(head) + " |")
    lines.append("|" + "---|" * len(head))
    for rank, arm in enumerate(arms, 1):
        spread = f"{arm['best']}" if arm["best"] == arm["worst"] else f"{arm['best']}–{arm['worst']}"
        cells = [str(rank), spread, arm["name"], arm.get("type", ""), arm.get("backbone", ""), f"**{arm['point'][primary]:.3f}**", f"[{arm['ci'][0]:.3f}, {arm['ci'][1]:.3f}]"]
        cells += [f"{arm['point'][k]:.3f}" for k in metric_keys if k != primary]
        cells += [arm.get("cost", ""), "this run (saved outputs)"]
        lines.append("| " + " | ".join(cells) + " |")
    for rep in cfg.get("reported", []):
        cells = ["–", "–", rep["name"], rep.get("type", ""), rep.get("backbone", ""), f"{rep['scores'].get(primary, float('nan')):.3f}" if primary in rep["scores"] else "n/r", "n/r"]
        cells += [f"{rep['scores'][k]:.3f}" if k in rep["scores"] else "n/r" for k in metric_keys if k != primary]
        cells += [rep.get("cost", ""), rep.get("source", "reported")]
        lines.append("| " + " | ".join(cells) + " |")
    lines += ["", "Per cohort (" + METRIC_NAMES[primary] + "):", "", "| System | " + " | ".join(sorted(by_group)) + " |", "|---|" + "---|" * len(by_group)]
    for arm in arms:
        lines.append(f"| {arm['name']} | " + " | ".join(f"{arm['byGroup'][g][primary]:.3f}" for g in sorted(by_group)) + " |")
    references = [arms[0]] + [arm for arm in arms if arm["name"] in cfg.get("pairAgainst", []) and arm is not arms[0]]
    for ref in references if len(arms) > 1 else []:
        lines += ["", f"Paired differences, each system minus {ref['name']} (same resamples):", "", "| System | Δ " + METRIC_NAMES[primary] + " | 95% CI | P(system > reference) |", "|---|---|---|---|"]
        for arm in arms:
            if arm is ref:
                continue
            d = sorted(y - x for x, y in zip(ref["samples"], arm["samples"]))
            point = arm["point"][primary] - ref["point"][primary]
            lines.append(f"| {arm['name']} | {point:+.3f} | [{d[int(0.025 * len(d))]:+.3f}, {d[int(0.975 * len(d)) - 1]:+.3f}] | {sum(x > 0 for x in d) / len(d):.3f} |")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    stem = cfg.get("stem", f"board-{board.lower()}")
    (out / f"{stem}.md").write_text("\n".join(lines) + "\n")
    (out / f"{stem}.json").write_text(json.dumps({"title": cfg["title"], "patients": len(common), "groups": {g: len(v) for g, v in by_group.items()},
        "arms": [{k: v for k, v in arm.items() if k not in ("per", "samples")} for arm in arms], "reported": cfg.get("reported", [])}, indent=1))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
