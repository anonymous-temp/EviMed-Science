#!/usr/bin/env python3
"""Turn bench-driver queue lines into lane requests (the broker's request schema), one JSON line each on stdout.

  make_requests.py --queue QUEUE.jsonl [--key bench/id ...] [--limit N] [--image base] [--rid-prefix P]
                   [--preamble-file F] [--line L] [--repeat K] > requests.jsonl

The rid is `<prefix>.<key with / and # made safe>[.r<k>]`. A queue line is copied as it is (a queue line never carries a gold answer: the
driver would send it to the model); `--preamble-file` and `--line` fill the request's `probe`. Nothing here reads gold, rubrics or scores.
"""
import argparse
import json
import re
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue", required=True)
    parser.add_argument("--key", action="append", default=[])
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--image", default="base")
    parser.add_argument("--rid-prefix", default="req")
    parser.add_argument("--preamble-file")
    parser.add_argument("--line")
    parser.add_argument("--repeat", type=int, default=1)
    args = parser.parse_args()
    preamble = open(args.preamble_file, encoding="utf-8").read().strip() if args.preamble_file else None
    count = 0
    for raw in open(args.queue, encoding="utf-8"):
        if not raw.strip():
            continue
        item = json.loads(raw)
        if args.key and item["key"] not in args.key:
            continue
        for repeat in range(1, args.repeat + 1):
            safe = re.sub(r"[^A-Za-z0-9._-]", "-", item["key"])
            rid = f"{args.rid_prefix}.{safe}" + (f".r{repeat}" if args.repeat > 1 else "")
            request = {"rid": rid, "image": args.image, "item": {**item, "key": item["key"] if args.repeat == 1 else f"{item['key']}#r{repeat}"},
                       "probe": {"preamble": preamble, "line": args.line}}
            sys.stdout.write(json.dumps(request, ensure_ascii=False) + "\n")
        count += 1
        if args.limit and count >= args.limit:
            break


if __name__ == "__main__":
    main()
