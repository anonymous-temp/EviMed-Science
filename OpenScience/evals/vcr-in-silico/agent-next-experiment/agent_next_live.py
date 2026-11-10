#!/usr/bin/env python3
"""Plan R37c part 2: does the agent run the value-of-information method and name the planted input as the next step.

  agent_next_live.py run   <label> [--only V1,V2] [--samples N] [--budget-cny X]
  agent_next_live.py grade <results-dir> [--prefix <label>]

`scenarios.json` is frozen (with part1.R and its RUN) before this runner's first paid run. One sample = one throwaway account and one
conversation (`LIVE-digest/drive.py`). Three facts are read per sample and counted separately, never merged:

  agentRan    a `vcr_simulate` call of kind decision_voi (or method decision.value_of_information) whose scenario gives the planted input a
              distribution (a family other than fixed/range) -- from the recorded tool-call arguments;
  engineNext  that job's result, read from the platform's ledger (db.json `results`), names the planted input as the next step
              (`diagnostics.voi.next.input`: a result with no next step, EVPI 0, is not a hit) -- the engine's own field, code reading it;
  named       the last 40% of the final assistant message mentions the planted input's words at least as often as any other input's
              (a closed vocabulary of Chinese words per input, ALIASES below, written before the first run), and at least once.
Also recorded: whether the agent ran any statistics of its own (a `bash` call that wrote or ran python), which the platform exists to avoid.
"""
import argparse, glob, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCEN = os.path.join(HERE, "scenarios.json")
ALIASES = {"effect": ["效应", "减缓比例", "减缓进展", "减缓幅度"], "sd": ["标准差", "个体差异", "变异"], "dropoutShare": ["脱落", "退出"],
           "controlProgression": ["安慰剂", "对照组的进展", "对照组的恶化", "进展速度", "恶化幅度"]}


def short(n):
    return (n or "").split("__")[-1]


def rows_of(path):
    out = []
    for line in open(path, encoding="utf8"):
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def calls_of(rows):
    calls = []
    for r in rows:
        if r.get("type") == "tool/call":
            d = r.get("data") or {}
            try:
                a = json.loads(d.get("arguments") or "{}")
            except Exception:
                a = {}
            calls.append({"name": short(d.get("name")), "args": a if isinstance(a, dict) else {}})
    return calls


def final_text(rows):
    last = ""
    for r in rows:
        if r.get("type") == "assistant/message":
            t = "".join(p.get("text", "") for p in ((r.get("data") or {}).get("message") or {}).get("content", []) if isinstance(p, dict) and p.get("type") == "text")
            if t.strip():
                last = t
    return last


def grade_sample(scenario, dirpath):
    planted = scenario["plantedInput"]
    files = sorted(glob.glob(os.path.join(dirpath, "sessions", "*.jsonl")))
    rows = [r for f in files for r in rows_of(f)]
    calls = calls_of(rows)
    voi = [c for c in calls if c["name"] == "vcr_simulate" and c["args"].get("action") == "start" and str(c["args"].get("kind", "")).replace(".", "_") in ("decision_voi", "decision_value_of_information")]
    ran = False
    for c in voi:
        spec = (((c["args"].get("scenario") or {}).get("inputs") or {}).get(planted)) or {}
        if isinstance(spec, dict) and spec.get("family") not in (None, "fixed", "range"):
            ran = True
    engine_next, engine_rank = None, None
    try:
        db = json.load(open(os.path.join(dirpath, "db.json")))
        for r in db.get("results") or []:
            if r.get("kind") == "decision_voi":
                v = ((r.get("diagnostics") or {}).get("voi") or {})
                engine_next = (v.get("next") or {}).get("input")
                singles = [i for i in (v.get("inputs") or []) if not i.get("group")]
                engine_rank = singles[0].get("input") if singles else None
    except Exception:
        pass
    text = final_text(rows)
    tail = text[int(len(text) * 0.6):]
    counts = {role: sum(tail.count(w) for w in words) for role, words in ALIASES.items() if role in scenario["engineScenario"]["inputs"]}
    named = counts.get(planted, 0) > 0 and counts.get(planted, 0) >= max(counts.values())
    own = any(c["name"] == "bash" and re.search(r"python|\.py|numpy|scipy", json.dumps(c["args"])) for c in calls)
    try:
        res = json.load(open(os.path.join(dirpath, "result.json")))
    except Exception:
        res = {}
    turns = res.get("turns") or []
    return {"ran": bool(rows) and bool(turns) and "error" not in res, "finished": bool(turns) and all(t.get("finished") for t in turns), "voiCalls": len(voi), "agentRan": ran,
            "engineNext": engine_next, "engineTop": engine_rank, "engineNextIsPlanted": engine_next == planted,
            "named": named, "mentions": counts, "ownScripts": own, "costCNY": (res.get("costCNY") or {}).get("cny"), "seconds": sum(t.get("seconds", 0) for t in turns)}


def summarize(graded):
    ran = {k: v for k, v in graded.items() if v["ran"]}
    n = len(ran)
    return {"samples": len(graded), "ran": n, "excluded": sorted(k for k, v in graded.items() if not v["ran"]),
            "agentRan": sum(v["agentRan"] for v in ran.values()), "engineNextIsPlanted": sum(v["engineNextIsPlanted"] for v in ran.values()),
            "named": sum(v["named"] for v in ran.values()), "ranAndNamed": sum(v["agentRan"] and v["named"] for v in ran.values()),
            "ownScripts": sum(v["ownScripts"] for v in ran.values()), "costCNY": round(sum(v.get("costCNY") or 0 for v in graded.values()), 4)}


def cmd_run(a):
    d = json.load(open(SCEN))
    kit = os.environ.get("KIT") or sys.exit("set KIT to the local live-harness kit directory (it is not part of the repository)")
    out = os.environ.get("R") or sys.exit("set R to the harness results directory")
    only = set(a.only.split(",")) if a.only else None
    spent = 0.0
    scen = os.path.join(os.environ.get("TMPDIR", "/tmp"), f"agent-next-{a.label}.json")
    for s in range(1, (a.samples or d["samplesPerScenario"]) + 1):
        for q in d["scenarios"]:
            if only and q["id"] not in only:
                continue
            label = f"{a.label}-{q['id']}-s{s}"
            if os.path.exists(os.path.join(out, label, "result.json")):
                continue
            if a.budget_cny and spent >= a.budget_cny:
                print("budget reached", spent); return
            json.dump({"turns": [{"text": q["text"]}], "timeout": d["turnTimeoutSeconds"], "settle": 30}, open(scen, "w"), ensure_ascii=False)
            subprocess.run([sys.executable, os.path.join(kit, "drive.py"), label, scen, "--out", out], check=False)
            g = grade_sample(q, os.path.join(out, label))
            spent += g.get("costCNY") or 0
            print(label, json.dumps({k: g[k] for k in ("agentRan", "engineNextIsPlanted", "named", "ownScripts", "costCNY")}), "spent", round(spent, 4), flush=True)


def cmd_grade(a):
    d = json.load(open(SCEN))
    by = {q["id"]: q for q in d["scenarios"]}
    graded = {}
    for p in sorted(glob.glob(os.path.join(a.dir, a.prefix + "-*-s*"))):
        label = os.path.basename(p)
        qid = label.split("-")[-2]
        if qid in by:
            graded[label] = {"id": qid, **grade_sample(by[qid], p)}
    print(json.dumps({"summary": summarize(graded), "samples": graded}, ensure_ascii=False, indent=1))


def main():
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run"); r.add_argument("label"); r.add_argument("--only"); r.add_argument("--samples", type=int); r.add_argument("--budget-cny", type=float)
    g = sub.add_parser("grade"); g.add_argument("dir"); g.add_argument("--prefix", default="r37c")
    a = ap.parse_args()
    {"run": cmd_run, "grade": cmd_grade}[a.cmd](a)


if __name__ == "__main__":
    main()
