#!/usr/bin/env python3
"""Deterministic scorer for MedCalc-Bench items (port of the official evaluation).

Source of the logic: ncbi-nlp/MedCalc-Bench @ 20b10f9d (2025-12-18)
  evaluation/evaluate.py   -> check_correctness (kept rule for rule)
  evaluation/run.py        -> extract_answer    (kept rule for rule, applied to a "Final answer:" line)

Differences from the official code (all deliberate, none loosens a tolerance):
  1. The official harness reads a JSON {"answer": ...} produced by the model.  EviMed answers in free
     text, so the string that plays the role of the JSON "answer" is the text after the LAST
     "Final answer:" marker of the response.  If there is no marker, a flagged fallback is used
     (the last line of the response for dates/tuples, the last number for numeric calculators);
     `extraction` says which path was taken so strict and lenient scores can both be reported.
  2. No eval() on model text or on gold strings: numbers are parsed with float()/int(), and the
     official `str(...)`-expression branch (a model writing Python in its JSON) is not needed.
  3. Thousands separators ("1,234.5") are removed before the number regexes run (the official
     regex would read "234.5").
  4. Dates are searched anywhere in the answer string, not only at its start.
  5. The weeks/days tuple also accepts "4 weeks and 3 days" (the official regex only takes "4 weeks, 3 days").
Everything else (the integer-list count, "N out of M", mL/min/1.73 and "%" branches, rounding of
integer scores, the weeks/days tuple for calculator 69, the lower/upper decimal window) is official.

Result of score(): {"verdict": "correct"|"incorrect", "extraction": "final_line"|"fallback"|"none",
                    "parsed": <normalised answer or None>, "alt_verdict": ..., "reason": str}
`alt_verdict` re-scores with the FIRST number of the answer string instead of the last (catches
"98.6 mg/dL (5.4 mmol/L)"); a row with verdict incorrect and alt_verdict correct is flagged
`review: true` for the judge, it is never counted as correct here.

CLI:
  score_medcalc.py --selftest [--csv data/medcalc/test_data.csv]
  score_medcalc.py --items items/medcalc.jsonl --answers answers.jsonl [--out scored.jsonl]
      answers.jsonl: one {"key": "medcalc/<row>", "text": "<full assistant reply>"} per line
"""
import os
import argparse
import csv
import json
import math
import re
import sys
from datetime import datetime

DATE_IDS = (13, 68)
TUPLE_IDS = (69,)
INTEGER_IDS = (4, 15, 16, 17, 18, 20, 21, 25, 27, 28, 29, 32, 33, 36, 43, 45, 48, 51)
DECIMAL_IDS = (2, 3, 5, 6, 7, 8, 9, 10, 11, 19, 22, 23, 24, 26, 30, 31, 38, 39, 40, 44, 46, 49,
               56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67)

_TUPLE_RE = re.compile(r"\(?[\"\']?(\d+)\s*(weeks?)?[\"\']?,?\s*[\"\']?(\d+)\s*(days?)?[\"\']?\s*\)?")
# answer-side variant: also accepts "4 weeks and 3 days" (format only; the official regex needs "4 weeks, 3 days")
_TUPLE_ANS_RE = re.compile(r"\(?[\"\']?(\d+)\s*(weeks?)?[\"\']?,?\s*(?:and\s+)?[\"\']?(\d+)\s*(days?)?[\"\']?\s*\)?")
_DATE_RE = re.compile(r"(0?[1-9]|1[0-2])\/(0?[1-9]|[12][0-9]|3[01])\/(\d{4})")
_NUM_RE = r"(-?\d+(?:\.\d+)?)"
_FINAL_RE = re.compile(r"final\s*answer\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.*)", re.IGNORECASE)


# --------------------------------------------------------------------------- extraction
def _strip_md(s: str) -> str:
    s = s.strip()
    s = re.sub(r"[*`]+", "", s)
    s = s.replace("$", "").replace("\\(", "").replace("\\)", "").strip()
    s = re.sub(r"(?<=\d),(?=\d{3}\b)", "", s)  # 1,234.5 -> 1234.5
    return s.strip().strip('"').strip()


def final_answer_text(response: str):
    """Return (text, extraction) where text plays the role of the official JSON answer."""
    matches = _FINAL_RE.findall(response or "")
    for m in reversed(matches):
        t = _strip_md(m)
        if t:
            return t, "final_line"
    lines = [ln for ln in (response or "").strip().splitlines() if ln.strip()]
    if lines:
        return _strip_md(lines[-1]), "fallback"
    return "", "none"


def parse_value(answer: str, calid: int, which: str = "last"):
    """Official extract_answer() for one calculator, applied to `answer`. Returns a string or 'N/A'."""
    if calid in DATE_IDS:
        m = _DATE_RE.search(answer)
        if not m:
            return "N/A"
        return f"{int(m.group(1)):02}/{int(m.group(2)):02}/{m.group(3)}"
    if calid in TUPLE_IDS:
        txt = answer.replace("[", "(").replace("]", ")").replace("'", "").replace('"', "")
        m = _TUPLE_ANS_RE.search(txt)
        return f"({m.group(1)}, {m.group(3)})" if m else "N/A"
    if calid in INTEGER_IDS:
        m = re.search(r"(\d+) out of", answer)
        if m:
            return m.group(1)
        m = re.search(r"-?\d+(, ?-?\d+)+", answer)
        if m:
            return str(len(m.group(0).split(",")))
        nums = re.findall(_NUM_RE, answer)
        if nums:
            return nums[-1] if which == "last" else nums[0]
        return "N/A"
    if calid in DECIMAL_IDS:
        m = re.search(_NUM_RE + r"\s*mL/min/1.73", answer)
        if m:
            return m.group(1)
        pct = re.findall(_NUM_RE + r"\%", answer)
        if pct:
            return str(float(pct[-1]) / 100)  # official behaviour
        nums = re.findall(_NUM_RE, answer)
        if nums:
            return nums[-1] if which == "last" else nums[0]
        return "N/A"
    raise ValueError(f"Unknown calculator ID: {calid}")


# --------------------------------------------------------------------------- official correctness
def check_correctness(answer: str, ground_truth: str, calid: int, upper_limit: str, lower_limit: str) -> int:
    """Official evaluate.check_correctness without eval(); `answer` is the output of parse_value()."""
    calid = int(calid)
    if answer == "N/A":
        return 0
    if calid in DATE_IDS:
        try:
            a = datetime.strptime(answer, "%m/%d/%Y")
            g = datetime.strptime(ground_truth, "%m/%d/%Y")
        except ValueError:
            return 0
        return int(a == g)
    if calid in TUPLE_IDS:
        gm = _TUPLE_RE.search(ground_truth)
        am = re.fullmatch(r"\((\d+), (\d+)\)", answer)
        if not gm or not am:
            return 0
        return int((int(gm.group(1)), int(gm.group(3))) == (int(am.group(1)), int(am.group(2))))
    if calid in INTEGER_IDS:
        try:
            return int(round(float(answer)) == float(ground_truth))
        except ValueError:
            return 0
    if calid in DECIMAL_IDS:
        try:
            v = float(answer)
            return int(float(lower_limit) <= v <= float(upper_limit))
        except ValueError:
            return 0
    raise ValueError(f"Unknown calculator ID: {calid}")


def score(response: str, gold: dict) -> dict:
    calid = int(gold["calculator_id"])
    text, extraction = final_answer_text(response)
    if extraction == "fallback" and calid in DECIMAL_IDS + INTEGER_IDS:
        # no marker: the official extractor would have seen the model's short answer; use the last number of the reply
        text = _strip_md(response or "")
    parsed = parse_value(text, calid) if text else "N/A"
    ok = check_correctness(parsed, gold["answer"], calid, gold["upper"], gold["lower"])
    alt_ok = ok
    if not ok and calid in DECIMAL_IDS + INTEGER_IDS and text:
        alt = parse_value(text, calid, which="first")
        alt_ok = check_correctness(alt, gold["answer"], calid, gold["upper"], gold["lower"])
    reason = "within official window/equal" if ok else (
        "no parsable answer" if parsed == "N/A" else f"parsed {parsed!r} vs gold {gold['answer']!r} [{gold['lower']}, {gold['upper']}]")
    return {"verdict": "correct" if ok else "incorrect", "extraction": extraction if text else "none",
            "parsed": None if parsed == "N/A" else parsed,
            "alt_verdict": "correct" if alt_ok else "incorrect",
            "review": bool((not ok) and alt_ok), "reason": reason}


# --------------------------------------------------------------------------- self-test
def selftest(csv_path: str) -> int:
    rows = list(csv.DictReader(open(csv_path, encoding="utf-8")))
    fails = []

    def gold_of(r):
        return {"calculator_id": int(r["Calculator ID"]), "answer": r["Ground Truth Answer"],
                "lower": r["Lower Limit"], "upper": r["Upper Limit"]}

    def fmt_gold(r):
        """What a well-behaved model would write for this row."""
        cid = int(r["Calculator ID"])
        g = r["Ground Truth Answer"]
        if cid == 69:
            m = _TUPLE_RE.search(g)
            return f"({m.group(1)} weeks, {m.group(3)} days)"
        return g

    # 1. every gold answer, written as a model would, scores correct (all 1100 rows, 55 calculators)
    for r in rows:
        res = score(f"Some reasoning...\n\n**Final answer:** {fmt_gold(r)}", gold_of(r))
        if res["verdict"] != "correct":
            fails.append(("gold-roundtrip", r["Row Number"], res))
    # 2. decimal window edges and a clear miss
    dec = [r for r in rows if int(r["Calculator ID"]) in DECIMAL_IDS and float(r["Ground Truth Answer"]) > 0][:200]
    for r in dec:
        g = gold_of(r)
        lo, hi, mid = float(r["Lower Limit"]), float(r["Upper Limit"]), float(r["Ground Truth Answer"])
        for v, want in ((lo, "correct"), (hi, "correct"), (lo - abs(lo) * 0.01 - 1e-6, "incorrect"),
                        (hi + abs(hi) * 0.01 + 1e-6, "incorrect"), (mid * 1.2, "incorrect")):
            res = score(f"Final answer: {v!r}", g)
            if res["verdict"] != want:
                fails.append(("decimal-window", r["Row Number"], v, want, res["verdict"]))
    # 3. integers: exact only (after rounding), "N out of M" and lists as in the official code
    ints = [r for r in rows if int(r["Calculator ID"]) in INTEGER_IDS][:100]
    for r in ints:
        g = gold_of(r)
        v = int(float(r["Ground Truth Answer"]))
        # official quirk: "(\d+) out of" drops a minus sign, so "N out of M" is only tested for v >= 0
        outof = [(f"{v} out of 20", "correct")] if v >= 0 else []
        for text, want in ([(f"{v}", "correct"), (f"{v + 1}", "incorrect"),
                           (f"{v}.4", "correct"), (f"{v}.6", "incorrect")] + outof):
            res = score(f"Final answer: {text}", g)
            if res["verdict"] != want:
                fails.append(("integer", r["Row Number"], text, want, res["verdict"]))
    # 4. dates and weeks/days
    for r in rows:
        cid = int(r["Calculator ID"])
        g = gold_of(r)
        if cid in DATE_IDS:
            d = datetime.strptime(r["Ground Truth Answer"], "%m/%d/%Y")
            ok = score(f"Final answer: {d.month}/{d.day}/{d.year}", g)["verdict"]
            bad = score(f"Final answer: {d.month}/{d.day + 1 if d.day < 28 else 1}/{d.year}", g)["verdict"]
            if (ok, bad) != ("correct", "incorrect"):
                fails.append(("date", r["Row Number"], ok, bad))
        if cid == 69:
            m = _TUPLE_RE.search(r["Ground Truth Answer"])
            w, dd = int(m.group(1)), int(m.group(3))
            for text, want in ((f"({w} weeks, {dd} days)", "correct"), (f"{w} weeks and {dd} days", "correct"),
                               (f"({w + 1} weeks, {dd} days)", "incorrect"), (f"({w} weeks, {(dd + 1) % 7} days)", "incorrect")):
                got = score(f"Final answer: {text}", g)["verdict"]
                if got != want:
                    fails.append(("tuple", r["Row Number"], text, want, got))
    # 5. extraction behaviours
    g = {"calculator_id": 2, "answer": "25.2381", "lower": "23.97619", "upper": "26.50001"}
    cases = [("Final answer: 1,025.2 mL/min", "incorrect"), ("Final answer: 25.2 mL/min", "correct"),
             ("Final answer: 25.24 mL/min/1.73 m^2", "correct"), ("no marker, the CrCl is 25.2", "correct"),
             ("Final answer: not enough information", "incorrect"), ("", "incorrect"),
             ("Final answer: 40%\nFinal answer: 25.2", "correct")]  # last marker wins
    for text, want in cases:
        got = score(text, g)["verdict"]
        if got != want:
            fails.append(("extract", text, want, got))
    pct = {"calculator_id": 46, "answer": "29.023", "lower": "27.57185", "upper": "30.47415"}
    if score("Final answer: 29%", pct)["verdict"] != "incorrect":  # official quirk: % divides by 100
        fails.append(("pct-quirk-changed",))
    if not score("Final answer: 29%", pct)["parsed"] == "0.29":
        fails.append(("pct-quirk-parsed",))
    print(f"selftest: {len(rows)} rows, {len(fails)} failures")
    for f in fails[:20]:
        print("  FAIL", f)
    return 1 if fails else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--csv", default=os.path.join(os.environ.get('BENCH_ROOT', '.'), 'data/medcalc/test_data.csv'))
    ap.add_argument("--items")
    ap.add_argument("--answers")
    ap.add_argument("--out")
    a = ap.parse_args()
    if a.selftest:
        sys.exit(selftest(a.csv))
    if not (a.items and a.answers):
        ap.error("--items and --answers required")
    items = {json.loads(l)["key"]: json.loads(l) for l in open(a.items, encoding="utf-8") if l.strip()}
    out = open(a.out, "w", encoding="utf-8") if a.out else sys.stdout
    n = c = 0
    for line in open(a.answers, encoding="utf-8"):
        if not line.strip():
            continue
        ans = json.loads(line)
        it = items[ans["key"]]
        res = score(ans.get("text", ""), it["gold"])
        res["key"] = ans["key"]
        n += 1
        c += res["verdict"] == "correct"
        out.write(json.dumps(res, ensure_ascii=False) + "\n")
    print(f"scored {n}, correct {c} ({(c / n if n else 0):.1%})", file=sys.stderr)


if __name__ == "__main__":
    main()
