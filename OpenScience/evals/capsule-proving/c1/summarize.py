"""C1 combined summary: every arm and fold with intervals, and the comparison with the SkillPyramid paper's numbers and order.

    python summarize.py --runs /srv/evimed/runs --out /srv/evimed/runs/c1-summary.json
    python summarize.py --dirs c1-noskill-1,c1-arm2-* --out /srv/evimed/runs/c1-summary-2.json   # the camp libraries' arms (F3)

Reads every `<runs>/c1-*/episodes.jsonl` (the runner's per-episode rows; smoke and training directories are skipped), keeps the last row
per (env, fold, arm, task), and reports ALFWorld success rate with a Wilson 95% interval and ScienceWorld mean score with a bootstrap 95%
interval (and its success rate). The ScienceWorld score counts an episode the game ended at -100 as 0, the usual convention; the raw mean
is reported beside it. Differences between arms are paired by task (the same tasks in every arm) with a paired bootstrap interval.
Plan 2026-11-04 §5.5: the model differs from the paper's, so absolute numbers are not comparable; only the order is read, and only
differences of 5 points or more count — a smaller one is "no difference seen".
"""
import argparse
import json
import math
from pathlib import Path
import random

EXPECTED = {("alfworld", "seen"): 140, ("alfworld", "unseen"): 134, ("scienceworld", "seen"): 60, ("scienceworld", "unseen"): 60}
# DeepSeek-V3.2 numbers the plan quotes (§5.5 C1). The paper's "pyramid" is its full system, which keeps evolving; "frozen" stops after training.
PAPER = {"alfworld": {"no-skill": 66.4, "flat": 75.7, "pyramid": 81.4, "frozen": 76.4, "from-scratch": 64.3, "no-atomic": 78.6, "no-abstract": 80.0},
         "scienceworld": {"no-skill": 69.9, "flat": 71.6, "pyramid": 76.3, "frozen": 73.7, "from-scratch": 70.1, "no-atomic": 75.3, "no-abstract": 71.1}}
# Which of our arms stands for which paper row. Our ablations run on the frozen pyramid library; the paper's on its evolving system.
CLAIMS = [
    ("pyramid beats flat (selection by levels)", "pyramid", "flat", "pyramid", "flat"),
    ("pyramid beats from-scratch (build on the library)", "pyramid", "from-scratch", "pyramid", "from-scratch"),
    ("pyramid beats no skills", "pyramid", "no-skill", "pyramid", "no-skill"),
    ("flat beats no skills", "flat", "no-skill", "flat", "no-skill"),
    ("evolving beats frozen", "evolving", "pyramid", "pyramid", "frozen"),
    ("pyramid beats no-atomic", "pyramid", "no-atomic", "pyramid", "no-atomic"),
    ("pyramid beats no-abstract", "pyramid", "no-abstract", "pyramid", "no-abstract"),
    ("pyramid beats add-only (consolidation)", "pyramid", "add-only", None, None),
]
THRESHOLD = 5.0


def wilson(successes, n, z=1.96):
    if not n:
        return None
    p = successes / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return [round(100 * (centre - half), 1), round(100 * (centre + half), 1)]


def bootstrap(values, rounds=10000, seed=20261110):
    if not values:
        return None
    rng = random.Random(seed)
    n = len(values)
    means = sorted(sum(values[rng.randrange(n)] for _ in range(n)) / n for _ in range(rounds))
    return [round(means[int(0.025 * rounds)], 1), round(means[int(0.975 * rounds) - 1], 1)]


def value_of(env, row):
    # ScienceWorld ends an episode at -100 on a wrong focus; as usual a failed episode counts 0 (the raw mean is reported beside it).
    return 100.0 * bool(row["success"]) if env == "alfworld" else max(0.0, float(row["score"]))


def load(runs, dirs=None):
    """`dirs`: directory name patterns to read (the arms of one round and the no-skill baseline); absent, every c1 run directory."""
    rows = {}
    sources = {}
    paths = sorted({p for pattern in (dirs or ["c1-*"]) for p in Path(runs).glob(f"{pattern}/episodes.jsonl")})
    for path in paths:
        if any(part in path.parent.name for part in ("smoke", "train", "infra", "lib")):
            continue
        for line in path.read_text().splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if (row["env"], row["fold"]) not in EXPECTED:
                continue
            rows[(row["env"], row["fold"], row["arm"], row["taskId"])] = row
            sources.setdefault((row["env"], row["arm"]), set()).add(path.parent.name)
    return rows, sources


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", default="/srv/evimed/runs")
    parser.add_argument("--out", default="/srv/evimed/runs/c1-summary.json")
    parser.add_argument("--dirs", help="comma list of run directory patterns to read (default: every c1-* directory)")
    args = parser.parse_args()
    rows, sources = load(args.runs, [d for d in (args.dirs or "").split(",") if d] or None)
    arms = sorted({key[2] for key in rows})
    cells = []
    by = {}
    for (env, fold), expected in EXPECTED.items():
        for arm in arms:
            selected = {key[3]: row for key, row in rows.items() if key[:3] == (env, fold, arm)}
            if not selected:
                continue
            by[(env, fold, arm)] = selected
            values = [value_of(env, row) for row in selected.values()]
            wins = sum(bool(row["success"]) for row in selected.values())
            cell = {"env": env, "fold": fold, "arm": arm, "n": len(selected), "expected": expected, "complete": len(selected) == expected,
                    "metric": "successRate" if env == "alfworld" else "meanScore",
                    "value": round(sum(values) / len(values), 1),
                    "ci95": wilson(wins, len(selected)) if env == "alfworld" else bootstrap(values),
                    "successRate": round(100 * wins / len(selected), 1), "successCi95": wilson(wins, len(selected)),
                    **({"rawMeanScore": round(sum(float(r["score"]) for r in selected.values()) / len(selected), 1),
                        "endedAtMinus100": sum(float(r["score"]) < 0 for r in selected.values())} if env == "scienceworld" else {}),
                    "errors": sum(row.get("error") is not None for row in selected.values()),
                    "promptTokens": sum(row["promptTokens"] for row in selected.values()),
                    "cachedPromptTokens": sum(row.get("cachedPromptTokens", 0) for row in selected.values()),
                    "completionTokens": sum(row["completionTokens"] for row in selected.values()),
                    "meanCards": round(sum(row.get("cards", 0) for row in selected.values()) / len(selected), 2),
                    "episodeSeconds": round(sum(row["seconds"] for row in selected.values())),
                    "sources": sorted(sources.get((env, arm), []))}
            cells.append(cell)
    # Per environment, both folds pooled — only when an arm has both folds complete.
    pooled = {}
    for env in ("alfworld", "scienceworld"):
        for arm in arms:
            folds = [by.get((env, fold, arm)) for fold in ("seen", "unseen")]
            if not all(folds) or any(len(f) != EXPECTED[(env, fold)] for f, fold in zip(folds, ("seen", "unseen"))):
                continue
            merged = {(fold, task): row for f, fold in zip(folds, ("seen", "unseen")) for task, row in f.items()}
            values = [value_of(env, row) for row in merged.values()]
            pooled[(env, arm)] = merged
            cells.append({"env": env, "fold": "both", "arm": arm, "n": len(merged), "value": round(sum(values) / len(values), 1),
                          "ci95": wilson(sum(bool(r["success"]) for r in merged.values()), len(merged)) if env == "alfworld" else bootstrap(values)})
    comparisons = []
    for env in ("alfworld", "scienceworld"):
        for label, ours_a, ours_b, paper_a, paper_b in CLAIMS:
            if (env, ours_a) not in pooled or (env, ours_b) not in pooled:
                comparisons.append({"env": env, "claim": label, "arms": [ours_a, ours_b], "status": "not run"})
                continue
            a, b = pooled[(env, ours_a)], pooled[(env, ours_b)]
            tasks = sorted(set(a) & set(b))
            diffs = [value_of(env, a[t]) - value_of(env, b[t]) for t in tasks]
            ours = round(sum(diffs) / len(diffs), 1)
            paper = round(PAPER[env][paper_a] - PAPER[env][paper_b], 1) if paper_a else None
            if abs(ours) < THRESHOLD:
                reading = "no difference seen (< 5 points)"
            else:
                reading = f"{ours_a} {'higher' if ours > 0 else 'lower'} by {abs(ours)} points"
            if paper is None:
                verdict = "no paper number"
            elif abs(paper) < THRESHOLD:
                verdict = "paper difference below 5 points: not readable either way" if abs(ours) < THRESHOLD else "paper < 5 points; ours differs"
            elif abs(ours) < THRESHOLD:
                verdict = "does not reproduce (no difference seen)"
            else:
                verdict = "reproduces (same direction)" if (ours > 0) == (paper > 0) else "reverses"
            comparisons.append({"env": env, "claim": label, "arms": [ours_a, ours_b], "ours": ours, "pairedCi95": bootstrap(diffs),
                                "paper": paper, "paperRows": [paper_a, paper_b] if paper_a else None, "reading": reading, "verdict": verdict,
                                "pairedTasks": len(tasks)})
    order = {}
    for env in ("alfworld", "scienceworld"):
        ours = {arm: round(sum(value_of(env, r) for r in m.values()) / len(m), 1) for (e, arm), m in pooled.items() if e == env}
        shared = [arm for arm in ("no-skill", "flat", "pyramid", "from-scratch", "no-atomic", "no-abstract") if arm in ours]
        # Every arm we ran, ranked, beside the paper's ranking of the arms it has (add-only and evolving have no paper number).
        order[env] = {"ours": sorted(shared, key=lambda arm: -ours[arm]), "paper": sorted(shared, key=lambda arm: -PAPER[env][arm]),
                      "oursAll": sorted(ours, key=lambda arm: -ours[arm]),
                      "oursValues": {arm: ours[arm] for arm in ours}, "paperValues": {arm: PAPER[env][arm] for arm in shared}}
    summary = {"schema": "c1-summary/1", "threshold": THRESHOLD, "paper": PAPER,
               "note": "Our pyramid/flat/no-atomic/no-abstract/from-scratch/add-only arms use libraries frozen after training; the paper's "
                       "ablations ran on its evolving system, so the paper's 'pyramid' row is compared with our pyramid arm and, for "
                       "evolving vs frozen, our evolving arm with our pyramid arm against the paper's pyramid vs frozen rows.",
               "cells": cells, "comparisons": comparisons, "order": order}
    Path(args.out).write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"cells": len(cells), "comparisons": [c for c in comparisons if c.get("status") != "not run"]}, indent=1))


if __name__ == "__main__":
    main()
