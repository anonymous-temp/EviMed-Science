"""Offline P33 measurements, with no model calls or semantic label guessing.

Section byte counts describe Markdown structure, not semantic classification: examples
inside Workflow remain Workflow. First target acquisition is a reproducible interaction
milestone, not the first relevant search/navigation step and not a causal attribution to
a card. Censored episodes are kept separately. Manual trace annotations belong beside
this output when interpreting method-following delay.
"""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import statistics


def distribution(values):
    values = sorted(values)
    if not values:
        return {"n": 0}
    return {"n": len(values), "min": values[0], "median": statistics.median(values),
            "mean": round(statistics.mean(values), 2), "p90": values[int(.9 * (len(values) - 1))], "max": values[-1]}


def library_stats(file):
    saved = json.loads(file.read_text())
    stored = [m["payload"] for m in saved["methods"]]
    methods = [m for m in stored if m["status"] == "approved"]
    sections = collections.Counter()
    per_method = []
    for method in methods:
        section = "preamble"
        own_sections = collections.Counter()
        fenced_bytes = 0
        fenced = False
        for line in method["body"].splitlines(keepends=True):
            if line.startswith("## "):
                section = line[3:].strip()
            sections[section] += len(line.encode())
            own_sections[section] += len(line.encode())
            if line.startswith("```"):
                fenced = not fenced
            elif fenced:
                fenced_bytes += len(line.encode())
        per_method.append({"name": method["frontmatter"]["name"], "bodyBytes": len(method["body"].encode()),
                           "sectionBytes": dict(own_sections), "fencedExampleOrCodeBytes": fenced_bytes,
                           "note": "Inline examples and caveats may overlap Workflow; heading counts are syntactic, not semantic labels."})
    bodies = [len(m["body"].encode()) for m in methods]
    cards = [len((m["frontmatter"].get("description", "") + "\n" + m["frontmatter"].get("whenToUse", "") + "\n" + m["body"]).encode()) for m in methods]
    total = sum(bodies)
    return {"path": str(file), "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "policy": saved.get("policy"),
            "cardAccounting": "C1 budgets description + newline + trigger + newline + body; renderedCardBytes excludes prompt labels and headings. Native runtime budgets metadata/path entries and reads bodies on demand.",
            "statusCounts": dict(collections.Counter(m["status"] for m in stored)),
            "allStoredBodyBytes": distribution([len(m["body"].encode()) for m in stored]),
            "population": "Remaining statistics use approved methods, the only status eligible for mounting; stored includes current candidate/retired records, not historical revisions.",
            "bodyBytes": distribution(bodies), "renderedCardBytes": distribution(cards),
            "attachedBytes": distribution([sum(len(v.encode()) for v in m.get("files", {}).values()) for m in methods]),
            "roles": dict(collections.Counter(m["frontmatter"].get("metadata", {}).get("role") for m in methods)),
            "sectionBytes": dict(sections), "sectionPercent": {k: round(100*v/total, 2) for k,v in sections.items()} if total else {},
            "perMethod": per_method,
            "medianCardsIn32KiB": int(32768 // statistics.median(cards)) if cards else 0,
            "allCardsFit32KiB": sum(cards) <= 32768}


def episode_stats(folder):
    cells = collections.defaultdict(list)
    # Committed episode rows, not possibly unfinished checkpoints.
    for line in (folder / "episodes.jsonl").read_text().splitlines():
        row = json.loads(line)
        key = hashlib.sha256(row["taskId"].encode()).hexdigest()[:20]
        trace = folder / "trajectories" / f'{row["env"]}-{row["fold"]}-{row["arm"]}-{key}.json'
        record = json.loads(trace.read_text())
        cells[(row["env"], row["fold"], row["arm"], row["success"])].append(record)
    output = []
    for (env, fold, arm, success), records in sorted(cells.items()):
        acquired, censored, informative_prefixes = [], [], []
        initial_inventory = 0
        for record in records:
            if env != "alfworld":
                continue
            # ALFWorld's task-directory schema supplies the target object type.
            target = record["taskId"].split("/")[1].split("-")[1].lower()
            hit = None
            first_informative = None
            for i, step in enumerate(record["steps"]):
                action = str(step.get("action") or "").lower().split()
                # Closed game-command vocabulary and exact environment refusal, not prose judging.
                if first_informative is None and action and action[0] in ("go", "take", "open", "close", "clean", "heat", "cool", "use", "move", "put") and step.get("observation") != "Nothing happens.":
                    first_informative = i
                if len(action) >= 2 and action[0] == "take" and action[1] == target and str(step.get("observation", "")).startswith("You pick up "):
                    hit = i
                    break
            (acquired if hit is not None else censored).append(hit if hit is not None else len(record["steps"]))
            if first_informative is not None:
                informative_prefixes.append(first_informative)
            initial_inventory += bool(record["steps"] and record["steps"][0].get("action") == "inventory")
        budgeted = [r["selection"]["budget"]["spent"] for r in records if r.get("selection", {}).get("budget")]
        output.append({"env": env, "fold": fold, "arm": arm, "success": success, "n": len(records),
                       "steps": distribution([len(r["steps"]) for r in records]),
                       "mountedCards": distribution([len(r.get("cards", [])) for r in records]),
                       "mountedBytes": distribution(budgeted),
                       "callsBeforeFirstSuccessfulTargetTake": distribution(acquired),
                       "callsBeforeFirstInformativeGameAction": distribution(informative_prefixes),
                       "neverTookTargetSteps": distribution(censored), "firstActionInventory": initial_inventory,
                       "detailReads": sum(bool(step.get("detailRead")) for r in records for step in r["steps"])})
    return {"path": str(folder), "cells": output}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--libraries", nargs="*", default=[])
    parser.add_argument("--runs", nargs="*", default=[])
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    result = {"schema": "c1c-measurements/1", "libraries": [library_stats(Path(p)) for p in args.libraries],
              "runs": [episode_stats(Path(p)) for p in args.runs]}
    Path(args.out).write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
