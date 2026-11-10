#!/usr/bin/env python3
"""Plan R37a: does the agent organize an experiment from natural language.

  organize_live.py run   <label> [--only O01,O02] [--samples N] [--budget-cny X]   drive the frozen set through a running live harness
  organize_live.py grade <results-dir> [--prefix <label>]                          grade what a run recorded (no model call)

`requests.json` is frozen before its first paid run (a new set is a new file). Grading is code over the tool-call arguments the kernel
recorded, never over the reply and before any result number is read: see `grading` in the request file. One sample = one throwaway
account and one conversation typed into the kernel's own composer by the harness driver (`LIVE-digest/drive.py`).
"""
import argparse, glob, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REQUESTS = os.path.join(HERE, "requests.json")
MODEL_TOOLS = ("vcr_simulate", "vcr_write", "vcr_read", "virtual_trial_search", "research_calculate")


def short(name):
    return (name or "").split("__")[-1]


def text_of(parts):
    return "".join(p.get("text", "") for p in parts or [] if isinstance(p, dict) and p.get("type") == "text")


def calls_of(rows):
    calls, order = {}, []
    for r in rows:
        t, d = r.get("type"), r.get("data") or {}
        if t == "tool/call":
            try:
                args = json.loads(d.get("arguments") or "{}")
            except Exception:
                args = {}
            calls[d.get("callId")] = {"name": short(d.get("name")), "args": args if isinstance(args, dict) else {}, "result": ""}
            order.append(d.get("callId"))
        elif t == "tool/result":
            m = d.get("message") or {}
            c = calls.get(d.get("callId") or m.get("toolCallId") or (m.get("source") or {}).get("callId"))
            if c is not None:
                c["result"] = text_of(m.get("content", []))
    return [calls[i] for i in order]


def norm(kind):
    return str(kind or "").replace(".", "_")


def numbers(x, out=None):
    """Every numeric leaf of a JSON value (booleans are not numbers)."""
    out = [] if out is None else out
    if isinstance(x, bool):
        return out
    if isinstance(x, (int, float)):
        out.append(float(x))
    elif isinstance(x, dict):
        for v in x.values():
            numbers(v, out)
    elif isinstance(x, list):
        for v in x:
            numbers(v, out)
    elif isinstance(x, str):
        pass
    return out


def close(a, b):
    return abs(a - b) <= 1e-9 * max(1.0, abs(b))


def call_kinds(c):
    a = c["args"]
    kinds = {norm(a.get("kind"))} if a.get("kind") else set()
    if c["name"] == "vcr_write" and a.get("what"):
        kinds.add(norm(a.get("what")))
    if c["name"] == "vcr_read" and a.get("what"):
        kinds.add("read_" + norm(a.get("what")))
    # grader bug fix 2026-11-10 (as F2's): the platform's other calculation route, research_calculate, names the engine method in `method`
    if c["name"] == "research_calculate" and isinstance(a.get("method"), str):
        kinds.add(norm(a["method"]))
    # a lab/search/compare call names its method inside the payload
    for key in ("method", "design"):
        v = a.get(key)
        if isinstance(v, str):
            kinds.add(norm(v))
    return kinds


def written_question_fields(calls):
    got = set()
    for c in calls:
        if c["name"] == "vcr_write" and norm(c["args"].get("what")) == "research_question":
            # grader bug fix 2026-11-10: a write is `items` or one `data` object (the calls of the conversations used `data`)
            one = c["args"].get("data")
            for it in (c["args"].get("items") or []) + ([{"data": one}] if isinstance(one, dict) else []):
                if isinstance(it, dict):
                    got |= {k for k, v in it.items() if v not in (None, "", [], {})}
                    if isinstance(it.get("data"), dict):
                        for k, v in it["data"].items():
                            if v not in (None, "", [], {}):
                                got.add(k)
    return got


def grade_request(req, rows):
    calls = [c for c in calls_of(rows) if c["name"] in MODEL_TOOLS]
    want = {norm(m) for m in req["methods"]}
    matching = [c for c in calls if call_kinds(c) & want]
    nums = []
    for c in matching:
        numbers(c["args"], nums)
    found = []
    for f in req["fixed"]:
        vals = [f["value"], *f.get("alt", [])]
        found.append(any(close(n, float(v)) for n in nums for v in vals))
    qf = req.get("questionFields") or []
    got = written_question_fields(calls)
    qfound = [f in got for f in qf]
    method_ok = bool(matching)
    fixed_ok = all(found)
    q_ok = all(qfound)
    return {"methodOk": method_ok, "fixedFound": sum(found), "fixedN": len(found), "fixedOk": fixed_ok,
            "questionFound": sum(qfound), "questionN": len(qf), "questionOk": q_ok,
            "sampleOk": method_ok and fixed_ok and q_ok,
            "kindsCalled": sorted({k for c in calls for k in call_kinds(c)}), "missingFixed": [f["label"] for f, ok in zip(req["fixed"], found) if not ok],
            "missingQuestion": [f for f, ok in zip(qf, qfound) if not ok]}


def load_rows(path):
    out = []
    for line in open(path, encoding="utf8"):
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def grade_sample(req, dirpath):
    files = sorted(glob.glob(os.path.join(dirpath, "sessions", "*.jsonl")))
    try:
        res = json.load(open(os.path.join(dirpath, "result.json")))
    except Exception:
        res = {}
    rows = [r for f in files for r in load_rows(f)]
    turns = res.get("turns") or []
    ran = bool(rows) and bool(turns) and "error" not in res
    g = grade_request(req, rows) if rows else {"methodOk": False, "fixedFound": 0, "fixedN": len(req["fixed"]), "fixedOk": False, "questionOk": False, "sampleOk": False, "questionFound": 0, "questionN": len(req.get("questionFields") or [])}
    g.update({"ran": ran, "finished": bool(turns) and all(t.get("finished") for t in turns), "costCNY": (res.get("costCNY") or {}).get("cny")})
    return g


def summarize(graded):
    ran = {k: v for k, v in graded.items() if v["ran"]}
    n = len(ran)
    fixed_items = sum(v["fixedN"] for v in ran.values())
    per = {}
    for v in ran.values():
        per.setdefault(v["id"], []).append(v)
    return {"samples": len(graded), "ran": n, "excluded": sorted(k for k, v in graded.items() if not v["ran"]),
            "methodOk": sum(v["methodOk"] for v in ran.values()), "fixedOk": sum(v["fixedOk"] for v in ran.values()), "sampleOk": sum(v["sampleOk"] for v in ran.values()),
            "fixedItemsFound": sum(v["fixedFound"] for v in ran.values()), "fixedItems": fixed_items,
            "perRequest": {i: {"n": len(vs), "methodOk": sum(g["methodOk"] for g in vs), "sampleOk": sum(g["sampleOk"] for g in vs)} for i, vs in sorted(per.items())},
            "costCNY": round(sum(v.get("costCNY") or 0 for v in graded.values()), 4)}


def cmd_run(a):
    d = json.load(open(REQUESTS))
    kit = os.environ.get("KIT") or "/home/coder/evimed-wt/vcrfix-handoff/isl2/LIVE-digest"
    out = os.environ.get("R") or "/home/coder/evimed-wt/isl2live-state/results"
    only = set(a.only.split(",")) if a.only else None
    spent = 0.0
    scen = os.path.join(os.environ.get("TMPDIR", "/tmp"), f"organize-live-{a.label}.json")
    for s in range(1, (a.samples or d["samplesPerRequest"]) + 1):
        for q in d["requests"]:
            if only and q["id"] not in only:
                continue
            label = f"{a.label}-{q['id']}-s{s}"
            if os.path.exists(os.path.join(out, label, "result.json")):
                continue
            if a.budget_cny and spent >= a.budget_cny:
                print("budget reached", spent); return
            json.dump({"turns": [{"text": q["text"]}], "timeout": d["turnTimeoutSeconds"], "settle": 20}, open(scen, "w"), ensure_ascii=False)
            subprocess.run([sys.executable, os.path.join(kit, "drive.py"), label, scen, "--out", out], check=False)
            g = grade_sample(q, os.path.join(out, label))
            spent += g.get("costCNY") or 0
            print(label, json.dumps({k: g[k] for k in ("methodOk", "fixedFound", "fixedN", "sampleOk", "costCNY")}), "spent", round(spent, 4), flush=True)


def cmd_grade(a):
    d = json.load(open(REQUESTS))
    by = {q["id"]: q for q in d["requests"]}
    graded = {}
    for p in sorted(glob.glob(os.path.join(a.dir, a.prefix + "-*-s*"))):
        label = os.path.basename(p)
        qid = label.split("-")[-2]
        if qid in by:
            graded[label] = {"id": qid, **grade_sample(by[qid], p)}
    print(json.dumps({"summary": summarize(graded), "samples": graded}, ensure_ascii=False, indent=1))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run"); r.add_argument("label"); r.add_argument("--only"); r.add_argument("--samples", type=int); r.add_argument("--budget-cny", type=float)
    g = sub.add_parser("grade"); g.add_argument("dir"); g.add_argument("--prefix", default="r37a")
    a = ap.parse_args()
    {"run": cmd_run, "grade": cmd_grade}[a.cmd](a)


if __name__ == "__main__":
    main()
