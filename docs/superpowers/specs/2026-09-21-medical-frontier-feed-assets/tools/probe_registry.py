#!/usr/bin/env python3
"""Probe every registry endpoint from one vantage point and write JSONL keyed by source id.
Usage: probe_registry.py local  out.jsonl            (this machine, 8 workers)
       probe_registry.py ssh:<host> out.jsonl        (runs verify_feed.py on <host> over ssh from stdin; nothing is written there)
Resumable: ids already present in out.jsonl are skipped."""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
where, out = sys.argv[1], sys.argv[2]
only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else ""          # id prefix, e.g. j- for journals
workers = sys.argv[sys.argv.index("--workers") + 1] if "--workers" in sys.argv else None  # Crossref answers 429 under concurrency: probe journals with 1
rows = [r for r in json.load(open(os.path.join(HERE, "..", "sources.json"), encoding="utf-8")) if str(r.get("endpoint", "")).startswith("http")]
egress = sys.argv[sys.argv.index("--egress") + 1].split(",") if "--egress" in sys.argv else []  # e.g. relay,browser: the batch an overseas node is bought for
retry = "--retry" in sys.argv  # re-probe, one at a time, whatever answered 429 (rate limit under concurrency) or not at all (flaky hosts)
if retry and os.path.exists(out):
    kept = []
    for line in open(out, encoding="utf-8"):
        v = json.loads(line)
        if v.get("http") in (0, 429): continue
        kept.append(line)
    open(out, "w", encoding="utf-8").writelines(kept)
    workers = workers or "1"
done = set()
if os.path.exists(out):
    for line in open(out, encoding="utf-8"):
        try: done.add(json.loads(line)["id"])
        except Exception: pass
todo = [r for r in rows if r["id"] not in done and r["id"].startswith(only) and (not egress or r.get("egress") in egress)]
print("to probe", len(todo), "of", len(rows), flush=True)
CHUNK = 40
for i in range(0, len(todo), CHUNK):
    part = todo[i:i + CHUNK]; urls = "\n".join(r["endpoint"] for r in part) + "\n"
    script = open(os.path.join(HERE, "verify_feed.py"), encoding="utf-8").read()
    if where == "local":
        cmd = [sys.executable, os.path.join(HERE, "verify_feed.py"), "--workers", workers or "8", "-"]; stdin = urls
    else:
        host = where.split(":", 1)[1]
        # the script travels as stdin ("python3 -"), the urls as shell-quoted arguments
        import shlex
        cmd = ["ssh", "-o", "BatchMode=yes", host, (("VERIFY_UA=" + shlex.quote(os.environ["VERIFY_UA"]) + " ") if os.environ.get("VERIFY_UA") else "") + "python3 - --workers " + (workers or "4") + " " + " ".join(shlex.quote(r["endpoint"]) for r in part)]; stdin = script
    p = subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=3000)
    got = {}
    for line in p.stdout.splitlines():
        try: v = json.loads(line); got[v["url"]] = v
        except Exception: pass
    with open(out, "a", encoding="utf-8") as handle:
        for r in part:
            v = got.get(r["endpoint"])
            if v: handle.write(json.dumps({"id": r["id"], **{k: v[k] for k in v if k != "url"}}, ensure_ascii=False) + "\n")
    print(f"chunk {i // CHUNK + 1}: {len(got)}/{len(part)}", (p.stderr or "")[-200:].replace("\n", " "), flush=True)
