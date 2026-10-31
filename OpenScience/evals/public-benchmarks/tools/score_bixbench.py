#!/usr/bin/env python3
"""BixBench scorer: the benchmark's own deterministic verifiers over a capsule reply, and what is left for a judge.

Source of the verifiers: Future-House/BixBench `bixbench/graders.py` (main, read 2026-10-31) and `grade_outputs.py`, which grades
the open-answer setting with `partial_match=True, llm_match=True`. What is ported, and what is not:

  str_verifier    `GradingFunction._grade_str_verifier`: both strings lower-cased with every non-[a-zA-Z0-9] character removed;
                  equal -> correct (rule "exact"); else, `partial_match`, the cleaned prediction is a substring of the cleaned
                  target -> correct (rule "partial"); else the benchmark asks its LLM grader (here: `needs_judge`).
                  One deliberate deviation: the official code returns correct for an EMPTY cleaned prediction (the empty string
                  is a substring of everything), i.e. an answer with no letters or digits would pass. Here it is `incorrect`.
  range_verifier  `GradingFunction._grade_range_verifier`: `lower <= float(predicted) <= upper`, the range read from "(lo,hi)".
                  In the OPEN-answer setting the benchmark does not call this function (it sends range questions to an LLM with
                  OPEN_ENDED_RANGE_GRADING_PROMPT, because a free-text answer is not a float); it is the MCQ path. It is ported
                  as the arithmetic of the check, with two ways to get the float out of a free-text answer, recorded per
                  question as `rule`: "official-float" (the whole answer, markdown/thousands separators/a trailing % removed,
                  parses as one number: exactly the official input) and "first-number" (our extraction, the first number in
                  the answer; outside the range but a LATER number inside it -> needs_judge, never correct).
  llm_verifier    the benchmark always asks its LLM grader; here `needs_judge`. The one shortcut kept from the v1 pre-scorer: an
                  answer equal to the ideal after the str_verifier cleaning is `correct` (rule "exact-shortcut"; any judge agrees).

`--official-only` keeps only the first-hand official forms: range answers that are exactly one number, str answers that match
exactly or partially; everything else is `needs_judge`. The `--deterministic-only` aggregate counts the range and str questions
(the 122 of 205 the benchmark can settle without a model) and says how many of them code settled; `needs_judge` counts as not
correct in the strict figure and as correct in the upper bound.

Answer parsing (ours, not the benchmark's, whose harness takes a one-line <answer> tag): the text after the LAST line
"Final answers:" (markdown stripped); lines "<n>. <answer>" / "<n>) <answer>" / "<n>: <answer>" start answer n, following lines
without a number belong to the previous answer. No marker -> the whole reply is searched for lines that start with a number
(extraction = "fallback"). A long free-text line is therefore compared whole, which is why most str_verifier answers reach the judge.

CLI
  score_bixbench.py --selftest
  score_bixbench.py --items items/bixbench.jsonl --answers answers.jsonl [--out scored.jsonl] [--official-only]
                    [--deterministic-only] [--compare judge/bixbench.final.jsonl] [--disagreements]
  (answers: {"key","text"[, "status"]}; --out: one JSON line per capsule with per-question verdicts; --deterministic-only prints the
   aggregate; --compare adds the agreement with a judge's verdicts {"key": "<item key>#<question id>", "verdict"} and lists
   every disagreement and every question code could not settle.)
"""
import argparse
import json
import re
import sys

FINAL = re.compile(r"final\s*answers?\s*(?:\*\*)?\s*[:：]?\s*(?:\*\*)?\s*$", re.IGNORECASE | re.MULTILINE)
LINE_NO = re.compile(r"^\s*(?:[-*>]\s*)?\**\s*(\d{1,2})\s*[.):]\s*\**\s*(.*)$")
NUM = re.compile(r"(?<![\w.])[-+]?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][-+]?\d+)?")
WHOLE_NUMBER = re.compile(r"^[-+]?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][-+]?\d+)?$|^[-+]?\.\d+(?:[eE][-+]?\d+)?$")
RANGE = re.compile(r"^\(\s*([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\s*\)$")
MODES = ("range_verifier", "str_verifier", "llm_verifier")


def strip_md(s):
    return re.sub(r"[*`_]+", "", s or "").strip()


def clean_alnum(s):
    """The official str_verifier cleaning: everything but [a-zA-Z0-9] removed, lower-cased."""
    return re.sub(r"[^a-zA-Z0-9]", "", s or "").lower()


def parse_answers(text):
    text = text or ""
    marks = list(FINAL.finditer(text))
    region, extraction = (text[marks[-1].end():], "final") if marks else (text, "fallback")
    ans, cur = {}, None
    for ln in region.splitlines():
        m = LINE_NO.match(ln)
        if m:
            cur = int(m.group(1))
            ans[cur] = m.group(2).strip()
        elif cur is not None and ln.strip():
            ans[cur] += " " + ln.strip()
    return {n: strip_md(a) for n, a in ans.items()}, extraction


def _minus(s):
    return (s or "").replace("−", "-")  # a typographic minus is a minus


def numbers(s):
    out = []
    for m in NUM.finditer(_minus(s)):
        try:
            out.append(float(m.group(0).replace(",", "")))
        except ValueError:
            pass
    return out


def official_float(answer):
    """The whole answer as one number (markdown, a trailing % and surrounding space dropped), else None."""
    core = _minus(strip_md(answer)).strip().rstrip("%").strip()
    if not WHOLE_NUMBER.match(core):
        return None
    try:
        return float(core.replace(",", ""))
    except ValueError:
        return None


def parse_range(q):
    if q.get("range"):
        return float(q["range"][0]), float(q["range"][1])
    m = RANGE.match((q.get("ideal") or "").strip())
    if not m:
        return None
    try:
        return float(m.group(1)), float(m.group(2))
    except ValueError:
        return None


def str_verdict(target, predicted, partial=True):
    """_grade_str_verifier with partial_match; the LLM step is `needs_judge`."""
    t, p = clean_alnum(target), clean_alnum(predicted)
    if not p:
        return "incorrect", "no-alphanumeric", "the answer has no letter or digit"
    if p == t:
        return "correct", "exact", "equal after removing everything but letters and digits"
    if partial and p in t:
        return "correct", "partial", f"cleaned answer {p!r} is inside cleaned target {t!r}"
    return "needs_judge", "llm", "not exact, not partial: the benchmark asks its LLM grader"


def range_verdict(q, answer, official_only=False):
    rng = parse_range(q)
    if rng is None:
        return {"verdict": "needs_judge", "rule": "no-range", "why": "the ideal answer is not a (lower,upper) range"}
    lo, hi = rng
    whole = official_float(answer)
    if whole is not None:
        ok = lo <= whole <= hi
        return {"verdict": "correct" if ok else "incorrect", "rule": "official-float", "parsed": whole, "range": [lo, hi],
                "why": f"{whole:g} {'in' if ok else 'outside'} [{lo:g}, {hi:g}]"}
    if official_only:
        return {"verdict": "needs_judge", "rule": "not-a-float", "range": [lo, hi], "why": "the answer is not a single number (official-only)"}
    nums = numbers(answer)
    if not nums:
        return {"verdict": "incorrect", "rule": "first-number", "range": [lo, hi], "why": "no number in the answer"}
    if lo <= nums[0] <= hi:
        return {"verdict": "correct", "rule": "first-number", "parsed": nums[0], "range": [lo, hi], "why": f"{nums[0]:g} in [{lo:g}, {hi:g}]"}
    if any(lo <= n <= hi for n in nums[1:]):
        return {"verdict": "needs_judge", "rule": "first-number", "parsed": nums[0], "range": [lo, hi],
                "why": f"first number {nums[0]:g} outside [{lo:g}, {hi:g}] but a later one is inside"}
    return {"verdict": "incorrect", "rule": "first-number", "parsed": nums[0], "range": [lo, hi], "why": f"{nums[0]:g} outside [{lo:g}, {hi:g}]"}


def score_question(q, answer, official_only=False):
    if answer is None or not answer.strip():
        return {"verdict": "incorrect", "rule": "no-answer", "why": "no answer for this question"}
    mode, ideal = q["eval_mode"], q["ideal"]
    if mode == "range_verifier":
        return range_verdict(q, answer, official_only)
    if mode == "str_verifier":
        verdict, rule, why = str_verdict(ideal, answer)
        return {"verdict": verdict, "rule": rule, "why": why}
    if clean_alnum(answer) == clean_alnum(ideal) and clean_alnum(ideal):
        return {"verdict": "correct", "rule": "exact-shortcut", "why": "equal to the ideal answer after cleaning (not an official step)"}
    return {"verdict": "needs_judge", "rule": "llm", "why": "llm_verifier: the benchmark asks its LLM grader"}


def score(text, gold, official_only=False):
    ans, extraction = parse_answers(text)
    rows = []
    for q in gold["questions"]:
        a = ans.get(q["n"])
        rows.append({"n": q["n"], "qid": q["qid"], "eval_mode": q["eval_mode"], "ideal": q["ideal"], "answer": a,
                     **score_question(q, a, official_only)})
    n = len(rows)
    return {"extraction": extraction, "questions": rows,
            "correct": sum(r["verdict"] == "correct" for r in rows), "needs_judge": sum(r["verdict"] == "needs_judge" for r in rows),
            "n": n, "accuracy_lower_bound": sum(r["verdict"] == "correct" for r in rows) / n if n else 0.0}


def aggregate(rows):
    """rows: per-question dicts (with eval_mode and verdict). The strict and upper-bound deterministic figures, by mode and by rule."""
    out = {"questions": len(rows), "by_mode": {}, "rules": {}}
    for mode in MODES:
        mine = [r for r in rows if r["eval_mode"] == mode]
        c = sum(r["verdict"] == "correct" for r in mine)
        w = sum(r["verdict"] == "incorrect" for r in mine)
        j = sum(r["verdict"] == "needs_judge" for r in mine)
        out["by_mode"][mode] = {"n": len(mine), "correct": c, "incorrect": w, "needs_judge": j}
    for r in rows:
        key = f"{r['eval_mode']}:{r.get('rule')}:{r['verdict']}"
        out["rules"][key] = out["rules"].get(key, 0) + 1
    det = [r for r in rows if r["eval_mode"] in ("range_verifier", "str_verifier")]
    c = sum(r["verdict"] == "correct" for r in det)
    j = sum(r["verdict"] == "needs_judge" for r in det)
    w = sum(r["verdict"] == "incorrect" for r in det)
    out["deterministic"] = {
        "n": len(det), "correct": c, "incorrect": w, "needs_judge": j, "settled_by_code": c + w,
        "accuracy_strict": c / len(det) if det else None,
        "accuracy_upper_bound": (c + j) / len(det) if det else None,
        "accuracy_of_settled": c / (c + w) if c + w else None,
    }
    return out


def compare(rows_by_key, judge):
    """Agreement with a judge's verdicts. rows_by_key: {"<item key>#<qid>": row}; judge: {same key: verdict}."""
    agree, disagree, unsettled, missing = [], [], [], []
    agreed = set()
    for key, row in rows_by_key.items():
        theirs = judge.get(key)
        if theirs is None:
            missing.append(key)
        elif row["verdict"] == "needs_judge":
            unsettled.append({"key": key, "eval_mode": row["eval_mode"], "judge": theirs, "ideal": row["ideal"], "answer": row["answer"], "why": row["why"]})
        elif row["verdict"] == theirs:
            agree.append(key)
            agreed.add(key)
        else:
            disagree.append({"key": key, "eval_mode": row["eval_mode"], "code": row["verdict"], "judge": theirs, "rule": row.get("rule"),
                             "ideal": row["ideal"], "answer": row["answer"], "why": row["why"]})
    settled = len(agree) + len(disagree)
    by_mode = {}
    for mode in MODES:
        mk = [k for k, r in rows_by_key.items() if r["eval_mode"] == mode and k in judge]
        by_mode[mode] = {
            "judged": len(mk),
            "settled_by_code": sum(rows_by_key[k]["verdict"] != "needs_judge" for k in mk),
            "agree": sum(k in agreed for k in mk),
            "judge_correct_among_unsettled": sum(judge[k] == "correct" and rows_by_key[k]["verdict"] == "needs_judge" for k in mk),
            "unsettled": sum(rows_by_key[k]["verdict"] == "needs_judge" for k in mk),
        }
    judge_correct = sum(judge[k] == "correct" for k in rows_by_key if k in judge)
    code_correct = sum(r["verdict"] == "correct" for k, r in rows_by_key.items() if k in judge)
    return {"questions_with_judge_verdict": len(rows_by_key) - len(missing), "settled_by_code": settled, "agree": len(agree), "disagree": len(disagree),
            "agreement": len(agree) / settled if settled else None, "unsettled_for_judge": len(unsettled), "missing_judge_verdict": len(missing),
            "judge_correct": judge_correct, "code_strict_correct": code_correct,
            "by_mode": by_mode, "disagreements": disagree, "unsettled": unsettled}


def selftest():
    fails = []
    gold = {"questions": [
        {"n": 1, "qid": "q1", "eval_mode": "range_verifier", "ideal": "(1.50,1.54)", "range": [1.5, 1.54]},
        {"n": 2, "qid": "q2", "eval_mode": "str_verifier", "ideal": "1-50", "range": None},
        {"n": 3, "qid": "q3", "eval_mode": "llm_verifier", "ideal": "35%", "range": None},
        {"n": 4, "qid": "q4", "eval_mode": "range_verifier", "ideal": "(0.024,0.026)", "range": [0.024, 0.026]}]}
    txt = ("analysis...\n\n**Final answers:**\n1. The odds ratio is 1.52 (95% CI 1.1-2.0)\n2. 1-50\n3. about 35 percent\n"
           "   (based on the filtered set)\n4. 0.31")
    r = score(txt, gold)
    got = [x["verdict"] for x in r["questions"]]
    if got != ["correct", "correct", "needs_judge", "incorrect"]:
        fails.append(("basic", got))
    if "filtered set" not in (r["questions"][2]["answer"] or ""):
        fails.append(("continuation-line", r["questions"][2]["answer"]))
    r2 = score("Final answers:\n1. OR 1.9 (CI 1.50-1.54)\n2. 51-100\n", gold)
    got2 = [x["verdict"] for x in r2["questions"]]
    if got2 != ["needs_judge", "needs_judge", "incorrect", "incorrect"]:
        fails.append(("later-number/missing", got2))
    r3 = score("1. 1.52\n2. 1-50\n3. 35%\n4. 0.025", gold)
    if r3["extraction"] != "fallback" or r3["correct"] != 4:
        fails.append(("fallback", r3["extraction"], r3["correct"]))
    # official str_verifier: exact after cleaning, partial (prediction inside the target), empty prediction is not a pass
    for target, predicted, want in (("1.9E-05", "1.9e-05", "exact"), ("1-50", "1 - 50", "exact"), ("166", "16", "partial"),
                                    ("10.6%", "10.6 percent of the genes", "llm"), ("7", "---", "no-alphanumeric")):
        rule = str_verdict(target, predicted)[1]
        if rule != want:
            fails.append(("str", target, predicted, rule, want))
    # official range check, whole-number form and first-number form
    q = {"eval_mode": "range_verifier", "ideal": "(24,26)", "range": [24.0, 26.0]}
    for answer, verdict, rule in (("25%", "correct", "official-float"), ("1,025", "incorrect", "official-float"), ("−25", "incorrect", "official-float"),
                                  ("about 25% (OR 0.75)", "correct", "first-number"), ("OR 0.75, a 25% reduction", "needs_judge", "first-number")):
        got3 = range_verdict(q, answer)
        if (got3["verdict"], got3["rule"]) != (verdict, rule):
            fails.append(("range", answer, got3["verdict"], got3["rule"]))
    if range_verdict(q, "about 25%", official_only=True)["verdict"] != "needs_judge":
        fails.append(("official-only",))
    if score_question({"eval_mode": "llm_verifier", "ideal": "0.05"}, "0.05")["rule"] != "exact-shortcut":
        fails.append(("llm-shortcut",))
    print(f"selftest: {len(fails)} failures")
    for f in fails:
        print("  FAIL", f)
    return 1 if fails else 0


def read_jsonl(path):
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--items")
    ap.add_argument("--answers")
    ap.add_argument("--out")
    ap.add_argument("--official-only", action="store_true", help="only the first-hand official forms are settled by code")
    ap.add_argument("--deterministic-only", action="store_true", help="print the range+str aggregate (strict and upper bound) and nothing else")
    ap.add_argument("--compare", help="a judge's verdict file ({key: '<item key>#<question id>', verdict}); adds the agreement and the disagreements")
    ap.add_argument("--disagreements", action="store_true", help="print only the comparison's disagreement and unsettled lists")
    a = ap.parse_args()
    if a.selftest:
        sys.exit(selftest())
    if not (a.items and a.answers):
        ap.error("--items and --answers are required")
    items = {i["key"]: i for i in read_jsonl(a.items)}
    scored, flat = [], {}
    for ans in read_jsonl(a.answers):
        if ans["key"] not in items:
            continue
        r = score(ans.get("text", "") if ans.get("status", "succeeded") == "succeeded" else "", items[ans["key"]]["gold"], a.official_only)
        r["key"] = ans["key"]
        scored.append(r)
        for q in r["questions"]:
            flat[f"{ans['key']}#{q['qid']}"] = q
    summary = {"capsules": len(scored), **aggregate(list(flat.values())), "official_only": a.official_only}
    if a.compare:
        judge = {j["key"]: j["verdict"] for j in read_jsonl(a.compare)}
        summary["compare"] = compare(flat, judge)
    out = open(a.out, "w", encoding="utf-8") if a.out else None
    if out:
        for r in scored:
            out.write(json.dumps(r, ensure_ascii=False) + "\n")
        out.close()
    if a.disagreements and "compare" in summary:
        json.dump({k: summary["compare"][k] for k in ("disagreements", "unsettled")}, sys.stdout, ensure_ascii=False, indent=1)
    elif a.deterministic_only or a.compare or out:
        json.dump(summary, sys.stdout, ensure_ascii=False, indent=1)
    else:
        for r in scored:
            sys.stdout.write(json.dumps(r, ensure_ascii=False) + "\n")
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
