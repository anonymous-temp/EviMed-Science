#!/usr/bin/env python3
"""Plan R10: does the root conversation start a design-search campaign when asked, and not when it is not asked.

  search_live.py run  <label> [--only S01,Q03] [--samples N] [--budget-cny X]   drive the frozen set through a running live harness
  search_live.py grade <results-dir>                                            grade what a run recorded (no model call)

The request set is `search-requests.json` (frozen before its first paid run; never edited afterwards, a new set is a new file). Each
sample is one throwaway account and one conversation typed into the kernel's own composer by the harness driver
(`LIVE-digest/drive.py`, which also reads the account's spend and deletes the account through the product). The grader is code over the
kernel's recorded tool calls of that conversation, never a reading of the reply:

  started    a `vcr_simulate action=search` call (or the trial plugin's `virtual_trial_search` with a manifest) whose result is a campaign
             that was accepted -- the result names a design search and is not an error;
  attempted  such a call was made at all (an invalid manifest counts as attempted, not started);
  designs    calls that run one design (`design_analytic`, `design_simulation`, `design_grid`, `simulate`...): the ordinary route to a
             single design, listed so a run of standalone designs is visible as such and is never counted as a search.

Rates: explicit/implicit search requests -> share with started; single-design questions -> share with started (the plan wants the
first at or above 80% and the second at or below 10%). Denominators are samples that finished a turn; a sample that never ran
(harness error) is listed and excluded, never counted as a miss.
"""
import argparse, glob, json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
REQUESTS = os.path.join(HERE, "search-requests.json")
SEARCH_TOOLS = ("vcr_simulate", "virtual_trial_search")


def short(name):
    return (name or "").split("__")[-1]


def text_of(parts):
    return "".join(p.get("text", "") for p in parts or [] if isinstance(p, dict) and p.get("type") == "text")


def calls_of(rows):
    """[(name, arguments dict, result text)] in the order the kernel recorded them (a result is matched by call id)."""
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
                c["result"] = text_of((d.get("message") or {}).get("content", []))
    return [calls[i] for i in order]


def is_search_call(c):
    if c["name"] == "virtual_trial_search":
        return "manifest" in c["args"]  # {campaignId} alone only reads one
    return c["name"] == "vcr_simulate" and c["args"].get("action") == "search"


def accepted(c):
    r = c["result"]
    if not r or '"status": "error"' in r or '"status":"error"' in r:
        return False
    return ("Design search" in r and "is running" in r) or '"kind": "campaign"' in r or '"kind":"campaign"' in r or "campaignId" in r


def grade_rows(rows):
    calls = calls_of(rows)
    search = [c for c in calls if is_search_call(c)]
    designs = [c["args"].get("action") or c["name"] for c in calls if c["name"] == "vcr_simulate" and not is_search_call(c)]
    return {
        "started": any(accepted(c) for c in search),
        "attempted": bool(search),
        "searchCalls": len(search),
        "designCalls": len(designs),
        "designActions": sorted(set(designs)),
        "tools": [c["name"] for c in calls],
    }


def load_rows(path):
    out = []
    for line in open(path, encoding="utf8"):
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def grade_sample(dirpath):
    files = sorted(glob.glob(os.path.join(dirpath, "sessions", "*.jsonl")))
    try:
        res = json.load(open(os.path.join(dirpath, "result.json")))
    except Exception:
        res = {}
    # Every session of the account counts (a model may start a second conversation's worth of work through a sub-agent).
    rows = [r for f in files for r in load_rows(f)]
    g = grade_rows(rows) if rows else {"started": False, "attempted": False, "searchCalls": 0, "designCalls": 0, "designActions": [], "tools": []}
    turns = res.get("turns") or []
    g["ran"] = bool(rows) and bool(turns) and "error" not in res
    g["finished"] = bool(turns) and all(t.get("finished") for t in turns)
    g["seconds"] = sum(t.get("seconds", 0) for t in turns)
    g["costCNY"] = (res.get("costCNY") or {}).get("cny")
    g["requests"] = (res.get("costCNY") or {}).get("requests")
    return g


def rate(items):
    n = len(items)
    k = sum(1 for g in items if g["started"])
    return {"started": k, "n": n, "rate": round(k / n, 3) if n else None, "attempted": sum(1 for g in items if g["attempted"])}


def summarize(graded):
    """graded: {sampleLabel: {"id", "kind", **grade}} -> the baseline's rates, per request and per class."""
    ran = {k: v for k, v in graded.items() if v.get("ran")}
    per = {}
    for v in ran.values():
        per.setdefault(v["id"], []).append(v)
    return {
        "explicit": rate([v for v in ran.values() if v["kind"] == "explicit"]),
        "implicit": rate([v for v in ran.values() if v["kind"] == "implicit"]),
        "search": rate([v for v in ran.values() if v["kind"] in ("explicit", "implicit")]),
        "single": rate([v for v in ran.values() if v["kind"] == "single"]),
        "perRequest": {i: {"started": sum(1 for g in vs if g["started"]), "attempted": sum(1 for g in vs if g["attempted"]), "n": len(vs),
                           "designCalls": sum(g["designCalls"] for g in vs)} for i, vs in sorted(per.items())},
        "excluded": sorted(k for k, v in graded.items() if not v.get("ran")),
        "costCNY": round(sum(v.get("costCNY") or 0 for v in graded.values()), 4),
        "samples": len(graded),
    }


def items():
    d = json.load(open(REQUESTS))
    return d, d["searchRequests"] + d["singleDesignQuestions"]


def cmd_run(args):
    d, reqs = items()
    kit = os.environ.get("KIT") or sys.exit("set KIT to the local live-harness kit directory (it is not part of the repository)")
    out = os.environ.get("R") or sys.exit("set R to the harness results directory")
    only = set(args.only.split(",")) if args.only else None
    samples = args.samples or d["samplesPerRequest"]
    spent = 0.0
    scen = os.path.join(os.environ.get("TMPDIR", "/tmp"), "search-live-scenario.json")
    for s in range(1, samples + 1):
        for q in reqs:
            if only and q["id"] not in only:
                continue
            label = f"{args.label}-{q['id']}-s{s}"
            if os.path.exists(os.path.join(out, label, "result.json")):
                continue  # resumable: a finished sample is never run (or paid for) twice
            if args.budget_cny and spent >= args.budget_cny:
                print("budget reached", spent); return
            json.dump({"turns": [{"text": q["text"]}], "timeout": d["turnTimeoutSeconds"], "settle": 20}, open(scen, "w"), ensure_ascii=False)
            subprocess.run([sys.executable, os.path.join(kit, "drive.py"), label, scen, "--out", out], check=False)
            g = grade_sample(os.path.join(out, label))
            spent += g.get("costCNY") or 0
            print(label, json.dumps({k: g[k] for k in ("started", "attempted", "designCalls", "costCNY")}), "spent", round(spent, 4), flush=True)


def cmd_grade(args):
    d, reqs = items()
    by_id = {q["id"]: q["kind"] for q in reqs}
    graded = {}
    for p in sorted(glob.glob(os.path.join(args.dir, args.prefix + "-*-s*"))):
        label = os.path.basename(p)
        qid = label.split("-")[-2]
        if qid not in by_id:
            continue
        graded[label] = {"id": qid, "kind": by_id[qid], **grade_sample(p)}
    print(json.dumps({"summary": summarize(graded), "samples": graded}, ensure_ascii=False, indent=1))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run"); r.add_argument("label"); r.add_argument("--only"); r.add_argument("--samples", type=int); r.add_argument("--budget-cny", type=float)
    g = sub.add_parser("grade"); g.add_argument("dir"); g.add_argument("--prefix", default="r10")
    a = ap.parse_args()
    {"run": cmd_run, "grade": cmd_grade}[a.cmd](a)


if __name__ == "__main__":
    main()
