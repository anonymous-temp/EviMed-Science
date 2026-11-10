#!/usr/bin/env python3
"""Plan R16: the agent arm of the matched-budget search benchmark (BENCHMARK-PROTOCOL.md, "The agent arm's slot").

  agent_arm_live.py run   <label> [--budgets 80000,320000] [--worlds level,level85] [--budget-cny X]   one conversation per world x budget
  agent_arm_live.py score <results-dir> [--prefix <label>]                                              score what a run recorded (no model call)

The agent is asked, in plain Chinese, to find the fewest-patients design of a frozen benchmark world within a stated budget of
simulated trials and to end with one fixed line, `最终选择：每组 N 人，分析水平 A` (a format, parsed by code, never the prose). Everything
else is read from the platform's own ledger: every `design_simulation` job of the account (its `replicates`, or the progress total
when none was stated), the designs they evaluated (`design.nTreat`, `analysis.alpha`, `truth.hazardRatio`), the trials they spent.
The pick is scored by `search-benchmark-matched.mjs --score-agent` (rule P of the protocol: truly feasible and optimal patients,
regret, re-evaluated violation) against the world's full-precision truth. A run that spends over its budget is reported as over
budget, never trimmed. Worlds, constraints and the truth table are the protocol's; nothing here edits them.
"""
import argparse, glob, json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.join(HERE, "..", "search-benchmark-matched.mjs")
WORLDS = {"level": 0.80, "level85": 0.85}
PICK = re.compile(r"最终选择[：:]\s*每组\s*(\d+)\s*人[，,]\s*分析水平\s*([0-9.]+)")


def prompt(world, budget):
    power = int(round(WORLDS[world] * 100))
    return (f"请帮我在一个固定的设计空间里找出最优的两臂生存期试验设计。设定：对数秩检验（单侧），备择假设下真实风险比 0.70，零效应情形风险比 1.0（用来看一类错误），"
            f"对照组中位生存期 12 个月，均匀入组 24 个月，入组结束后随访 12 个月。候选设计共 12 个：每组 200、225、250 人，分析所用的单侧水平 α 取 0.025、0.0235、0.022、0.02 四种之一"
            f"（分析水平本身可以作为设计的一部分调整）。目标：总人数最少，同时备择下的功效不低于 {power}%，零效应下的一类错误不超过单侧 2.5%。"
            f"预算：所有模拟加起来最多 {budget:,} 次模拟试验（把你提交的每个模拟作业的重复次数加起来，备择和零效应两种情形都算），不要超出。"
            f"做完以后，在回复的最后单独写一行，格式固定：最终选择：每组 N 人，分析水平 A（例如：最终选择：每组 225 人，分析水平 0.022）。")


def rows_of(path):
    out = []
    for line in open(path, encoding="utf8"):
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def last_text(sess_dir):
    """The text of the last assistant message of the conversation (the one the person reads last)."""
    last = ""
    for f in sorted(glob.glob(os.path.join(sess_dir, "sessions", "*.jsonl"))):
        for r in rows_of(f):
            if r.get("type") == "assistant/message":
                t = "".join(p.get("text", "") for p in ((r.get("data") or {}).get("message") or {}).get("content", []) if isinstance(p, dict) and p.get("type") == "text")
                if t.strip():
                    last = t
    return last


def jobs_of(sample_dir):
    try:
        return json.load(open(os.path.join(sample_dir, "db.json"))).get("jobs") or []
    except Exception:
        return []


def extract(sample_dir):
    """What the agent evaluated and spent, from the ledger; the pick from its final line."""
    evaluated, trials, jobs = {}, 0, 0
    for j in jobs_of(sample_dir):
        if j.get("kind") != "design_simulation" or j.get("state") == "canceled" and not (j.get("progress") or {}).get("done"):
            continue
        sc = j.get("scenario") or {}
        n = (sc.get("design") or {}).get("nTreat"); a = (sc.get("analysis") or {}).get("alpha"); hr = (sc.get("truth") or {}).get("hazardRatio")
        done = (j.get("progress") or {}).get("done")
        reps = j.get("replicates") or (j.get("progress") or {}).get("total") or 0
        spent = done if isinstance(done, (int, float)) and j.get("state") != "succeeded" else reps
        trials += int(spent or 0); jobs += 1
        evaluated.setdefault(f"{n}|{a}", {"nTreat": n, "alpha": a, "alt": 0, "null": 0})["alt" if hr != 1 and hr != 1.0 else "null"] += int(spent or 0)
    m = PICK.findall(last_text(sample_dir))
    pick = {"nTreat": int(m[-1][0]), "alpha": float(m[-1][1])} if m else None
    return {"jobs": jobs, "trialsSpent": trials, "designsEvaluated": len(evaluated), "evaluated": sorted(evaluated.values(), key=lambda x: (x["nTreat"] or 0, x["alpha"] or 0)), "pick": pick}


def score(world, ex):
    if ex["pick"] is None:
        return {"category": "none", "note": "no final line in the required format"}
    key = {"design.nTreat": ex["pick"]["nTreat"], "design.nControl": ex["pick"]["nTreat"], "analysis.alpha": ex["pick"]["alpha"]}
    view = {"candidates": [{"key": "picked", "set": key}], "best": "picked", "usage": {"replicatesCompleted": ex["trialsSpent"]}}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(view, f)
    out = subprocess.run(["node", BENCH, "--score-agent", f.name, "--world", world, "--trials", str(ex["trialsSpent"])], capture_output=True, text=True, timeout=120)
    os.unlink(f.name)
    try:
        return json.loads(out.stdout)
    except Exception:
        return {"category": "score_error", "stderr": out.stderr[-300:]}


def grade_sample(sample_dir, world, budget):
    try:
        res = json.load(open(os.path.join(sample_dir, "result.json")))
    except Exception:
        res = {}
    ex = extract(sample_dir)
    sc = score(world, ex)
    turns = res.get("turns") or []
    return {"world": world, "budget": budget, "ran": bool(turns) and "error" not in res, "finished": bool(turns) and all(t.get("finished") for t in turns), **ex,
            "overBudget": ex["trialsSpent"] > budget, "score": sc, "costCNY": (res.get("costCNY") or {}).get("cny")}


def cmd_run(a):
    kit = os.environ.get("KIT") or sys.exit("set KIT to the local live-harness kit directory (it is not part of the repository)")
    out = os.environ.get("R") or sys.exit("set R to the harness results directory")
    spent = 0.0
    scen = os.path.join(os.environ.get("TMPDIR", "/tmp"), f"agent-arm-{a.label}.json")
    for world in a.worlds.split(","):
        for budget in [int(b) for b in a.budgets.split(",")]:
            label = f"{a.label}-{world}-{budget}"
            if os.path.exists(os.path.join(out, label, "result.json")):
                continue
            if a.budget_cny and spent >= a.budget_cny:
                print("budget reached", spent); return
            json.dump({"turns": [{"text": prompt(world, budget)}], "timeout": 1500, "settle": 60}, open(scen, "w"), ensure_ascii=False)
            subprocess.run([sys.executable, os.path.join(kit, "drive.py"), label, scen, "--out", out], check=False)
            g = grade_sample(os.path.join(out, label), world, budget)
            spent += g.get("costCNY") or 0
            print(label, json.dumps({k: g[k] for k in ("ran", "trialsSpent", "designsEvaluated", "pick", "overBudget", "costCNY")}, ensure_ascii=False), g["score"].get("category"), flush=True)


def cmd_score(a):
    res = {}
    for p in sorted(glob.glob(os.path.join(a.dir, a.prefix + "-*"))):
        m = re.match(rf"{re.escape(a.prefix)}-(level85|level)-(\d+)$", os.path.basename(p))
        if m and os.path.isdir(p):
            res[os.path.basename(p)] = grade_sample(p, m.group(1), int(m.group(2)))
    print(json.dumps(res, ensure_ascii=False, indent=1))


def main():
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run"); r.add_argument("label"); r.add_argument("--budgets", default="80000,320000"); r.add_argument("--worlds", default="level,level85"); r.add_argument("--budget-cny", type=float)
    s = sub.add_parser("score"); s.add_argument("dir"); s.add_argument("--prefix", default="r16")
    a = ap.parse_args()
    {"run": cmd_run, "score": cmd_score}[a.cmd](a)


if __name__ == "__main__":
    main()
