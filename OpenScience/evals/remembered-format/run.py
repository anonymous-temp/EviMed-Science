#!/usr/bin/env python3
"""Remembered format, paired: run the thirty pairs against DeepSeek and score them (see remembered_format.py and README.md).

    python3 evals/remembered-format/run.py --key-file <path> [--arms current,v2 --variant-file variants.json] [--samples 3]
        [--model deepseek-flash] [--only weekly-report,cover-letter] [--workers 6] [--out results/<date>-<arms>.json]
    python3 evals/remembered-format/run.py --dry-run [--only weekly-report]      # prints the first request, calls nothing

The key is read from --key-file (or DEEPSEEK_API_KEY) and is never printed or written.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import remembered_format as rf  # noqa: E402


def read_key(key_file: str | None) -> str:
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not key and key_file:
        key = Path(key_file).read_text(encoding="utf-8").strip()
    if not key:
        raise SystemExit("no key: pass --key-file <path> (or set DEEPSEEK_API_KEY)")
    return key


def run_cell(case: dict, variant: str, arm: dict, sample: int, model: str, judge_model: str, key: str, post=rf.post) -> dict:
    """One reply and its judgement. A model failure is recorded as such, never as a pass."""
    cell = {"arm": arm["name"], "case": case["id"], "variant": variant, "sample": sample}
    try:
        reply = rf.reply_of(post(rf.request_body(case, variant, arm, model), key))
    except Exception as error:  # noqa: BLE001
        return {**cell, "error": str(error)[:120], "noText": True, "pass": None, "replyChars": 0}
    verdict = None
    if reply.strip():
        try:
            verdict = rf.parse_judge(rf.reply_of(post(rf.judge_request(case, variant, reply, judge_model), key)), case, variant, reply)
        except Exception:  # noqa: BLE001
            verdict = {"readable": False, "added": [], "places": {}, "dropped": 0}
    return {**cell, **rf.score_cell(case, variant, reply, verdict), "reply": reply}


def table(summary: dict) -> str:
    lines = [f"{'arm':14} {'full all-given':>14} {'given rate':>10} {'partial invented':>16} {'by number':>9} {'filled':>6} {'pairs right':>11}  handling"]
    for arm, s in summary.items():
        lines.append(f"{arm:14} {s['full']['allGiven']:>6}/{s['full']['n']:<7} {s['full']['givenRate']:>10} {s['partial']['inventedRuns']:>8}/{s['partial']['n']:<7} {s['partial']['numberRuns']:>9} "
                     f"{s['partial']['filledPlaces']:>6} {s['pairs']['bothRight']:>5}/{s['pairs']['n']:<5}  {s['partial']['handling']}")
    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cases", default=str(HERE / "cases.json"))
    parser.add_argument("--only", help="comma-separated case ids")
    parser.add_argument("--arms", default="current", help="current, and/or names defined in --variant-file")
    parser.add_argument("--variant-file", help="JSON: one arm {name, guidanceReplace, ...} or {arms: [...]}; see README")
    parser.add_argument("--texts-file", help="JSON {persona, guidance} instead of reading the checkout (offline)")
    parser.add_argument("--tree", help="the OpenScience checkout under test (default: this one)")
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--model", default=rf.DEFAULT_MODEL)
    parser.add_argument("--judge-model", default=None, help="default: --model")
    parser.add_argument("--key-file")
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--out")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    cases = rf.load_cases(args.cases)
    problems = [issue for case in cases for issue in rf.case_issues(case)]
    if problems:
        raise SystemExit("case file is malformed:\n  " + "\n  ".join(problems))
    if args.only:
        wanted = set(args.only.split(","))
        cases = [c for c in cases if c["id"] in wanted]
        if not cases:
            raise SystemExit("no case matches --only")
    texts = rf.load_texts(args.tree, args.texts_file, args.model)
    arms = rf.arms_from(texts, cases, args.arms.split(","), args.variant_file)

    if args.dry_run:
        first = next(iter(arms.values()))
        body = rf.request_body(cases[0], "partial", first, args.model)
        print(json.dumps({"arm": first["name"], "case": cases[0]["id"], "variant": "partial", "request": body}, ensure_ascii=False, indent=1))
        return 0

    key = read_key(args.key_file)
    judge_model = args.judge_model or args.model
    jobs = [(case, variant, arm, i) for arm in arms.values() for case in cases for variant in ("full", "partial") for i in range(args.samples)]
    with cf.ThreadPoolExecutor(max(1, args.workers)) as pool:
        cells = list(pool.map(lambda j: run_cell(j[0], j[1], j[2], j[3], args.model, judge_model, key), jobs))
    summary = rf.summarize(cells)
    print(table(summary))
    out = Path(args.out) if args.out else HERE / "results" / f"{datetime.now(timezone.utc):%Y-%m-%d}-{'+'.join(arms)}-{args.model}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"model": args.model, "judgeModel": judge_model, "samples": args.samples, "arms": list(arms), "summary": summary, "cells": cells},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print("wrote", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
