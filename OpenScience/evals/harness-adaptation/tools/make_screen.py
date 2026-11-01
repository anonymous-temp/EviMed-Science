#!/usr/bin/env python3
"""Requests for the development screen of round 1: the unmodified image on development rows the task-level recursion never read.

  make_screen.py --out DIR [--image base] [--prefix s1] [--repeats 1] [--rows domain=N ...]

Rows come in ascending sha256("rsi1-screen|<id>") order, from the registered pool's development role, minus the ids of ppc-tasks.json.
Writes DIR/requests.jsonl, DIR/fetch.json (public data entries for brokerctl --fetch) and DIR/rows.json. No gold is read here.
"""
import argparse
import hashlib
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from evimed_h2 import families  # noqa: E402

DEFAULT = {"medcalc": 60, "arb-deep": 40, "arb-wide": 20, "mbc": 60, "bixbench": 15, "drb": 12, "rcb": 6}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--image", default="base")
    parser.add_argument("--prefix", default="s1")
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--rows", action="append", default=[])
    args = parser.parse_args()
    counts = dict(DEFAULT)
    if args.rows:
        counts = {}
        for item in args.rows:
            name, value = item.split("=")
            counts[name] = int(value)
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ppc = families.read_ppc()
    requests, fetches, rows = [], [], {}
    for domain, count in counts.items():
        family = families.Family(domain)
        used = set(ppc.get(domain, []))
        ids = sorted((i for i in family.development_ids() if i not in used),
                     key=lambda i: hashlib.sha256(f"rsi1-screen|{i}".encode()).hexdigest())
        tasks, chosen, unavailable = {}, [], []
        for task_id in ids:
            if len(chosen) == count:
                break
            try:
                task = family.tasks([task_id])[task_id]
            except families.DataUnavailable:
                unavailable.append(task_id)
                continue
            tasks[task_id] = task
            if families.feasible(task):
                chosen.append(task_id)
        if unavailable:
            print(f"{domain}: no raw data, skipped {unavailable}", file=sys.stderr)
        rows[domain] = chosen
        fetches += families.fetch_entries(domain, chosen)
        for task_id in chosen:
            for repeat in range(args.repeats):
                line = tasks[task_id].queue_line()
                rid = f"{args.prefix}.{domain}.{task_id}.r{repeat}".replace("/", "_")
                requests.append({"rid": rid, "image": args.image, "item": line, "probe": {"preamble": None, "line": None}})
    (out / "requests.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in requests), encoding="utf-8")
    (out / "fetch.json").write_text(json.dumps(fetches), encoding="utf-8")
    (out / "rows.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    print({k: len(v) for k, v in rows.items()}, "requests", len(requests), "fetch", len(fetches))


if __name__ == "__main__":
    main()
