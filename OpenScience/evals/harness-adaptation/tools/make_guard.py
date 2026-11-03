#!/usr/bin/env python3
"""Lane requests for the guard of round 1: the general-task baseline's plain requests on one image (principle 12: a plain task must not get slower or dearer).

  make_guard.py --out DIR --image KEY --prefix P [--repeats 2]

Only the first message of each case in evals/general-tasks/cases.json with no input file; this is a measure of time, cost, tools and shape, not of the judged suite.
"""
import argparse
import json
import pathlib

CASES = pathlib.Path(__file__).resolve().parents[2] / "general-tasks" / "cases.json"


def first_message(case):
    for key in ("prompt", "request", "message", "text"):
        if isinstance(case.get(key), str):
            return case[key]
    turns = case.get("turns") or case.get("messages")
    if turns:
        turn = turns[0]
        return turn if isinstance(turn, str) else turn.get("text") or turn.get("prompt")
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--repeats", type=int, default=2)
    args = parser.parse_args()
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    requests = []
    for case in json.loads(CASES.read_text(encoding="utf-8"))["cases"]:
        if case.get("fixtures") or case.get("files") or case.get("inputs"):
            continue
        text = first_message(case)
        if not text:
            continue
        for repeat in range(args.repeats):
            line = {"key": f"general/{case['id']}#r{repeat}", "bench": "general", "id": case["id"], "group": "general-main", "prompt": text, "line": None,
                    "timeoutMin": 15, "files": [], "deleteGroupAfter": False, "collect": True}
            requests.append({"rid": f"{args.prefix}.general.{case['id']}.r{repeat}", "image": args.image, "item": line, "probe": {"preamble": None, "line": None}})
    (out / "requests.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in requests), encoding="utf-8")
    print(len(requests), "requests")


if __name__ == "__main__":
    main()
