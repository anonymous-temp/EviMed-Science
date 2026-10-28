#!/usr/bin/env python3
"""BixBench pre-scorer: parses a capsule reply into per-question answers and settles what code can settle.

Scorer name in the items is `claude-open`: the verdicts below are a first pass, every `needs_judge` row goes to the Claude
judge together with the question, the ideal answer and the extracted answer text.  Nothing here ever turns a wrong answer
into a right one: `correct` is only returned for a number inside the official range or an exact normalised string match.

Parsing: the text after the LAST line "Final answers:" (markdown stripped); lines "<n>. <answer>" / "<n>) <answer>" /
"<n>: <answer>" start answer n, following lines without a number belong to the previous answer.  No marker -> the whole reply
is searched for lines that start with a number (extraction = "fallback").

Per question (gold.questions[i], BixBench v1.5 eval_mode):
  range_verifier  ideal "(lo,hi)": correct iff the FIRST number in the answer lies in [lo, hi] (a trailing % is read as the number
                  itself, "0.25 (25%)" -> 0.25); no number -> incorrect; a number outside -> needs_judge only when another number in
                  the answer lies inside (e.g. "OR 1.52 (CI 1.1-2.0)" reported with the estimate second), else incorrect.
  str_verifier    exact match after lower-casing and stripping space/punctuation/markdown -> correct; otherwise needs_judge
                  (open-answer phrasing "1-50 patients" vs "1-50" is the judge's call).
  llm_verifier    exact normalised match -> correct; otherwise needs_judge.
Capsule score = share of questions correct (after judging); BixBench itself reports per-question accuracy.

CLI
  score_bixbench.py --selftest
  score_bixbench.py --items items/bixbench.jsonl --answers answers.jsonl [--out scored.jsonl]    (answers: {"key","text"})
"""
import argparse
import json
import re
import sys

FINAL = re.compile(r"final\s*answers?\s*(?:\*\*)?\s*[:：]?\s*(?:\*\*)?\s*$", re.IGNORECASE | re.MULTILINE)
LINE_NO = re.compile(r"^\s*(?:[-*>]\s*)?\**\s*(\d{1,2})\s*[.):]\s*\**\s*(.*)$")
NUM = re.compile(r"(?<![\w.])[-+]?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][-+]?\d+)?")


def strip_md(s):
    return re.sub(r"[*`_]+", "", s or "").strip()


def norm(s):
    return re.sub(r"[^a-z0-9.<>%-]+", "", strip_md(s).lower())


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


def numbers(s):
    out = []
    for m in NUM.finditer(s or ""):
        try:
            out.append(float(m.group(0).replace(",", "")))
        except ValueError:
            pass
    return out


def score_question(q, answer):
    if answer is None or not answer.strip():
        return {"verdict": "incorrect", "why": "no answer for this question"}
    mode, ideal = q["eval_mode"], q["ideal"]
    if norm(answer) == norm(ideal):
        return {"verdict": "correct", "why": "exact normalised match"}
    if mode == "range_verifier" and q.get("range"):
        lo, hi = q["range"]
        nums = numbers(answer)
        if not nums:
            return {"verdict": "incorrect", "why": "no number in the answer"}
        if lo <= nums[0] <= hi:
            return {"verdict": "correct", "why": f"{nums[0]} in [{lo}, {hi}]"}
        if any(lo <= n <= hi for n in nums[1:]):
            return {"verdict": "needs_judge", "why": f"first number {nums[0]} outside [{lo}, {hi}] but a later one is inside"}
        return {"verdict": "incorrect", "why": f"{nums[0]} outside [{lo}, {hi}]"}
    return {"verdict": "needs_judge", "why": f"{mode}: not an exact match"}


def score(text, gold):
    ans, extraction = parse_answers(text)
    rows = []
    for q in gold["questions"]:
        a = ans.get(q["n"])
        rows.append({"n": q["n"], "qid": q["qid"], "eval_mode": q["eval_mode"], "ideal": q["ideal"], "answer": a,
                     **score_question(q, a)})
    n = len(rows)
    return {"extraction": extraction, "questions": rows,
            "correct": sum(r["verdict"] == "correct" for r in rows), "needs_judge": sum(r["verdict"] == "needs_judge" for r in rows),
            "n": n, "accuracy_lower_bound": sum(r["verdict"] == "correct" for r in rows) / n if n else 0.0}


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
    r4 = score("Final answers:\n1) 1,52\n", gold)
    print(f"selftest: {len(fails)} failures")
    for f in fails:
        print("  FAIL", f)
    return 1 if fails else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--items")
    ap.add_argument("--answers")
    ap.add_argument("--out")
    a = ap.parse_args()
    if a.selftest:
        sys.exit(selftest())
    items = {json.loads(l)["key"]: json.loads(l) for l in open(a.items, encoding="utf-8") if l.strip()}
    out = open(a.out, "w", encoding="utf-8") if a.out else sys.stdout
    for line in open(a.answers, encoding="utf-8"):
        if line.strip():
            ans = json.loads(line)
            r = score(ans.get("text", ""), items[ans["key"]]["gold"])
            r["key"] = ans["key"]
            out.write(json.dumps(r, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
