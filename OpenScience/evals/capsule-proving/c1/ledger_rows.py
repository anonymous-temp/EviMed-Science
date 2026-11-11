"""C1 ledger rows from a combined summary (summarize.py): one external row per arm and fold, in the shape `run/ledger.mjs add` validates.

    python ledger_rows.py --summary /srv/evimed/runs/c1-summary-2.json --commit <sha> --out /srv/evimed/runs/c1-ledger-2.json
    cd /srv/evimed/repo/OpenScience && node evals/capsule-proving/run/ledger.mjs add --json /srv/evimed/runs/c1-ledger-2.json \
        --ledger /srv/evimed/results/ledger.jsonl

Sets are `c1-<env>-<fold>`, split `dev`. ALFWorld's metric is `accuracy` (success rate) and ScienceWorld's `mean_score` (a -100 ending counted
as 0), both as fractions of 1 with their 95% interval; only complete cells (every task of the fold) are written. The game's checker is the
scorer (code), so `judged.code` is n and `judged.error` the episodes that ended in an error. Tokens are the episodes' own (no extraction).
"""
import argparse
import json
from pathlib import Path



def library_of(source, arm, env):
    """Which library export an arm's cell selected from: round 2 (c1-arm2-*) reads c1-lib-2, F2's round c1-lib-1."""
    if arm == "no-skill":
        return None
    variant = "from-scratch" if arm == "from-scratch" else "add-only" if arm == "add-only" else "pyramid"
    if source.startswith("c1c-"):
        return f"c1c-lib/{env}-{variant}.json"
    return f"c1-lib-2/{env}-{variant}.json" if source.startswith("c1-arm2-") else f"c1-lib-1/{env}-{variant}.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--runs", default="/srv/evimed/runs")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    summary = json.loads(Path(args.summary).read_text())
    rows = []
    for cell in summary["cells"]:
        if cell.get("fold") == "both" or not cell.get("complete"):
            continue
        env, fold, arm = cell["env"], cell["fold"], cell["arm"]
        source = (cell.get("sources") or ["unknown"])[0]
        concise = source.startswith("c1c-") and arm != "no-skill"
        mode = "flat" if arm == "flat" else None if arm == "no-skill" else "pyramid"
        removed = {"no-abstract": ["abstract"], "no-atomic": ["atomic"]}.get(arm, [])
        rows.append({
            "runId": source, "commit": args.commit, "arm": arm, "set": f"c1-{env}-{fold}", "split": "dev",
            "metric": "accuracy" if env == "alfworld" else "mean_score",
            "scorer": "c1-game-checker", "engine": {"version": "n/a (C1 text games, direct DeepSeek loop)", "templatesDigest": "n/a"},
            "flags": {"model": "deepseek-flash", "thinking": "disabled", "library": library_of(source, arm, env), "selection": mode, "removeRoles": removed,
                      "lessons": "camp+two-stage" if source.startswith("c1-arm2-") or concise else None,
                      "cardBodyBudgetBytes": 32768 if source.startswith("c1-arm2-") or concise else None,
                      **({"conciseDistillation": True, "learningTransport": "system-skill-section"} if concise else {}),
                      "scale": "fraction of 1" if env == "alfworld" else "mean score / 100 (a -100 ending counted as 0)",
                      **({"rawMeanScore": cell.get("rawMeanScore"), "successRate": cell.get("successRate")} if env == "scienceworld" else {})},
            "n": cell["n"], "value": round(cell["value"] / 100, 4),
            "ci95": [round(cell["ci95"][0] / 100, 4), round(cell["ci95"][1] / 100, 4)] if cell.get("ci95") else None,
            "judged": {"code": cell["n"], "judge": 0, "unknown": 0, "error": cell.get("errors", 0)},
            "tokens": {"prompt": cell["promptTokens"], "completion": cell["completionTokens"], "cached": cell.get("cachedPromptTokens", 0),
                       "extractionPrompt": 0, "extractionCompletion": 0},
            "costCny": None, "wallSeconds": cell.get("episodeSeconds", 0),
            "rawPath": str(Path(args.runs) / source / "episodes.jsonl"),
        })
    Path(args.out).write_text(json.dumps(rows, indent=1) + "\n")
    print(json.dumps({"rows": len(rows), "cells": [f"{r['set']}/{r['arm']}" for r in rows]}))


if __name__ == "__main__":
    main()
