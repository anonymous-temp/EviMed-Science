#!/usr/bin/env python3
"""Short-answer scorer (normalized exact / contains matching) with an explicit `needs_judge` verdict.

Built for MedBrowseComp (five task types, see TASKS) but the generic helpers (normalise, token_set,
best_ratio) can be reused for other short-answer sets.  No LLM is called here: anything the rules
cannot settle with confidence is returned as `needs_judge` together with the evidence the judge needs
(`extracted`, `gold`, `why`).  A verdict file is later merged with judge verdicts via --merge-judge.

Verdicts:  correct | incorrect | needs_judge
Extraction: the label line asked for by the prompt is looked for first (INGREDIENT:, COMPANY:, "date:"),
last occurrence wins; `extraction` is "label" when found, "fallback" otherwise.  A fallback answer can
never be `correct` by itself - an exact normalised hit in the last 400 characters is `needs_judge`.

Per-task rules (gold = the dataset's `gold` column):
  Ingredient               exact token-set equality -> correct; one side's tokens a subset of the other's
                           (salt/ester forms: "GEMCITABINE" vs "GEMCITABINE HYDROCHLORIDE") or a near-typo
                           (ratio >= 0.85) -> needs_judge; "UNKNOWN" or anything else -> incorrect.
  Applicant_Full_Name      same after dropping legal-form tokens (INC, LTD, CORP, CO, LLC, LP, US, ...).
  Patent_Expire_Date_Text  the prompt asks for a year (YYYY) while gold is a full date: correct iff the
                           answer's year equals the gold year (a full date with that year also passes).
  Exclusivity_Date         gold "" means "no exclusivity date": correct iff the answer is NA/N-A/none; a
                           dated gold needs the same calendar date (MM-DD-YYYY, "Nov 17, 2026", ISO or MM/DD/YYYY).
  Open_on_Approval         gold "Not_Listed": correct iff the closing region says NOT LISTED and gives no price;
                           numeric gold (opening price): correct iff a number in the closing region is within
                           max(0.011, 0.5 %) of it.  Prices elsewhere in a long answer -> needs_judge.

CLI
  score_shortanswer.py --selftest
  score_shortanswer.py --items items/medbrowsecomp.jsonl --answers answers.jsonl [--out scored.jsonl]
  score_shortanswer.py --summary scored.jsonl [--items items/medbrowsecomp.jsonl] [--judge judged.jsonl]
      judged.jsonl: {"key": ..., "verdict": "correct"|"incorrect"} overrides needs_judge rows.
      Prints accuracy by task type, unweighted and population-weighted (meta.popWeight).
"""
import argparse
import collections
import difflib
import json
import re
import sys
from datetime import datetime

LEGAL = {"INC", "LTD", "LLC", "LP", "CORP", "CORPORATION", "CO", "COMPANY", "LIMITED", "PLC", "AG", "GMBH",
         "SA", "US", "USA", "THE", "OF", "AND"}
MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
NA_WORDS = {"NA", "N/A", "N-A", "NONE", "NOT AVAILABLE", "NOT APPLICABLE", "NO EXCLUSIVITY", "NULL"}


# ------------------------------------------------------------------ helpers
def strip_md(s: str) -> str:
    s = re.sub(r"[*`_]{1,3}", "", s or "")
    return s.strip().strip('"').strip("'").strip()


def normalise(s: str) -> str:
    s = strip_md(s).upper().replace("&", " AND ")
    s = re.sub(r"[^A-Z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def token_set(s: str, drop=()):
    return frozenset(t for t in normalise(s).split() if t not in drop)


def best_ratio(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, normalise(a), normalise(b)).ratio()


def last_label(text: str, label_re: str):
    """Text after the last `<label>:` on a line, or None."""
    hits = re.findall(rf"(?im)^[\s>*\-#\d.)]*\**\s*(?:{label_re})\s*\**\s*[:：]\s*\**\s*(.+)$", text or "")
    for h in reversed(hits):
        h = strip_md(h)
        if h:
            return h
    return None


def tail(text: str, n: int) -> str:
    return (text or "")[-n:]


def parse_date(s: str):
    """Parse one calendar date out of s; returns (y, m, d) or None."""
    s = strip_md(s)
    m = re.search(r"\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b", s)
    if m:
        a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if 1 <= a <= 12 and 1 <= b <= 31:
            return (y, a, b)
    m = re.search(r"\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b", s)
    if m:
        return (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.search(r"\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b", s)
    if m and m.group(1).lower() in MONTHS:
        return (int(m.group(3)), MONTHS[m.group(1).lower()], int(m.group(2)))
    m = re.search(r"\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})\b", s)
    if m and m.group(2).lower() in MONTHS:
        return (int(m.group(3)), MONTHS[m.group(2).lower()], int(m.group(1)))
    return None


def is_na(s: str) -> bool:
    n = normalise(s)
    return n in {normalise(w) for w in NA_WORDS} or bool(re.fullmatch(r"(DATE )?N ?/? ?A", n)) or n.startswith("NA ")


def res(verdict, extraction, extracted, why):
    return {"verdict": verdict, "extraction": extraction, "extracted": extracted, "why": why}


# ------------------------------------------------------------------ name-like tasks
def score_name(text, gold, label_re, drop=()):
    ext = last_label(text, label_re)
    extraction = "label"
    if ext is None:
        lines = [ln for ln in (text or "").strip().splitlines() if ln.strip()]
        ext = strip_md(lines[-1]) if lines else ""
        extraction = "fallback"
    g = token_set(gold, drop)
    a = token_set(ext, drop)
    if not a or normalise(ext) in ("UNKNOWN", "NONE", "NA", "N A"):
        return res("incorrect", extraction, ext, "no answer / unknown")
    if extraction == "label":
        if a == g:
            return res("correct", extraction, ext, "token sets equal")
        if a <= g or g <= a or best_ratio(ext, gold) >= 0.85:
            return res("needs_judge", extraction, ext, "partial overlap (salt/legal form or near-typo)")
        return res("incorrect", extraction, ext, "different name")
    # no label: only an exact hit near the end can ever be rescued, and only by the judge
    tail_tokens = token_set(tail(text, 400), drop)
    if g and g <= tail_tokens:
        return res("needs_judge", extraction, ext, "gold tokens appear in the closing text but no labelled answer line")
    return res("incorrect", extraction, ext, "no labelled answer and gold not in the closing text")


# ------------------------------------------------------------------ per task
def score_ingredient(text, gold):
    return score_name(text, gold, r"INGREDIENT|ACTIVE INGREDIENT")


def score_company(text, gold):
    return score_name(text, gold, r"COMPANY|APPLICANT", drop=LEGAL)


def score_patent_year(text, gold):
    gd = parse_date(gold)
    gy = gd[0] if gd else None
    ext = last_label(text, r"date|YYYY|year|patent expiration(?: date)?|patent expiry")
    extraction = "label"
    if ext is None:
        ext, extraction = tail(text, 300), "fallback"
    years = re.findall(r"\b(19\d{2}|20\d{2})\b", ext)
    if not years:
        return res("incorrect", extraction, ext[:120], "no year given")
    if extraction == "label":
        d = parse_date(ext)
        y = d[0] if d else int(years[-1] if len(set(years)) == 1 else years[0])
        return res("correct" if y == gy else "incorrect", extraction, ext[:120], f"answer year {y} vs gold year {gy}")
    if str(gy) in years:
        return res("needs_judge", extraction, ext[:120], "gold year appears in the closing text but no 'date:' line")
    return res("incorrect", extraction, ext[:120], "no labelled date and gold year not in the closing text")


def score_exclusivity(text, gold):
    ext = last_label(text, r"date|exclusivity date|exclusivity")
    extraction = "label"
    if ext is None:
        ext, extraction = tail(text, 300), "fallback"
    if gold == "":
        if extraction == "label":
            return res("correct" if is_na(ext) and not parse_date(ext) else "incorrect", extraction, ext[:120],
                       "gold: no exclusivity date")
        return res("needs_judge" if re.search(r"(?i)\bN/?A\b|no exclusivity|not available", ext) else "incorrect",
                   extraction, ext[:120], "gold: no exclusivity date; no 'date:' line")
    gd = parse_date(gold)
    ad = parse_date(ext)
    if ad is None:
        return res("incorrect", extraction, ext[:120], "no date given" if not is_na(ext) else "answered NA, gold has a date")
    if extraction == "label":
        return res("correct" if ad == gd else "incorrect", extraction, ext[:120], f"answer {ad} vs gold {gd}")
    return res("needs_judge" if ad == gd else "incorrect", extraction, ext[:120], f"unlabelled date {ad} vs gold {gd}")


def numbers(s: str):
    out = []
    for m in re.finditer(r"(?<![\w.])\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)", s or ""):
        try:
            out.append(float(m.group(1).replace(",", "")))
        except ValueError:
            pass
    return out


def score_open_price(text, gold):
    region = tail(text, 500)
    not_listed = bool(re.search(r"(?i)not[\s_-]*listed", region))
    if gold.lower().replace("_", " ") == "not listed":
        nums_region = [n for n in numbers(region) if n != 0]
        # a price next to NOT LISTED means the answer hedged -> judge
        if not_listed and not re.search(r"(?i)\$\s?\d|price", region):
            return res("correct", "label", region[-160:], "NOT LISTED")
        if not_listed:
            return res("needs_judge", "label", region[-160:], "NOT LISTED mentioned together with a price")
        return res("incorrect" if nums_region else "needs_judge", "fallback", region[-160:], "gold NOT LISTED; answer gives a price or nothing clear")
    g = float(gold)
    tol = max(0.011, 0.005 * g)
    if any(abs(n - g) <= tol for n in numbers(region)):
        return res("correct", "label", region[-160:], f"price within {tol:.3f} of {g:.2f}")
    if not_listed:
        return res("incorrect", "label", region[-160:], "answered NOT LISTED; gold has a price")
    if any(abs(n - g) <= tol for n in numbers(text)):
        return res("needs_judge", "fallback", region[-160:], "gold price appears earlier in a long answer, not in the closing region")
    return res("incorrect", "label", region[-160:], f"no number within {tol:.3f} of {g:.2f}")


TASKS = {
    "Ingredient": score_ingredient,
    "Applicant_Full_Name": score_company,
    "Patent_Expire_Date_Text": score_patent_year,
    "Exclusivity_Date": score_exclusivity,
    "Open_on_Approval": score_open_price,
}


def score(text: str, gold: dict) -> dict:
    return TASKS[gold["task_name"]](text or "", gold["answer"])


# ------------------------------------------------------------------ summary
def summarise(scored, items, judged=None):
    judged = judged or {}
    by = collections.defaultdict(lambda: [0, 0, 0, 0.0, 0.0])  # n, correct, undecided, wsum, wcorrect
    for r in scored:
        it = items[r["key"]]
        t = it["meta"]["task_name"]
        v = judged.get(r["key"], r["verdict"])
        w = it["meta"].get("popWeight", 1.0)
        for k in (t, "ALL"):
            b = by[k]
            b[0] += 1
            b[1] += v == "correct"
            b[2] += v == "needs_judge"
            b[3] += w
            b[4] += w * (v == "correct")
    lines = [f"{'task':26s} {'n':>4s} {'correct':>8s} {'undecided':>9s} {'acc':>7s} {'pop-weighted':>12s}"]
    for k in [*TASKS, "ALL"]:
        if k in by:
            n, c, u, ws, wc = by[k]
            lines.append(f"{k:26s} {n:4d} {c:8d} {u:9d} {c / n:7.1%} {wc / ws:12.1%}")
    return "\n".join(lines)


# ------------------------------------------------------------------ self-test
def selftest():
    fails = []

    def chk(name, text, task, gold, want):
        got = score(text, {"task_name": task, "answer": gold})["verdict"]
        if got != want:
            fails.append((name, got, want))

    chk("ing-exact", "Reasoning...\nINGREDIENT: ENZALUTAMIDE", "Ingredient", "ENZALUTAMIDE", "correct")
    chk("ing-case-md", "**INGREDIENT:** Enzalutamide", "Ingredient", "ENZALUTAMIDE", "correct")
    chk("ing-salt", "INGREDIENT: GEMCITABINE", "Ingredient", "GEMCITABINE HYDROCHLORIDE", "needs_judge")
    chk("ing-wrong", "INGREDIENT: DOCETAXEL", "Ingredient", "ENZALUTAMIDE", "incorrect")
    chk("ing-unknown", "INGREDIENT: UNKNOWN", "Ingredient", "ENZALUTAMIDE", "incorrect")
    chk("ing-nolabel-hit", "The ingredient is enzalutamide.", "Ingredient", "ENZALUTAMIDE", "needs_judge")
    chk("ing-nolabel-miss", "I could not determine it.", "Ingredient", "ENZALUTAMIDE", "incorrect")
    chk("co-legal", "COMPANY: Bristol Myers Squibb Co.", "Applicant_Full_Name", "BRISTOL MYERS SQUIBB", "correct")
    chk("co-us", "COMPANY: ASTELLAS PHARMA INC", "Applicant_Full_Name", "ASTELLAS PHARMA US INC", "correct")
    chk("co-wrong", "COMPANY: PFIZER INC", "Applicant_Full_Name", "ASTELLAS PHARMA US INC", "incorrect")
    chk("co-partial", "COMPANY: NOVARTIS", "Applicant_Full_Name", "NOVARTIS PHARMACEUTICALS CORP", "needs_judge")
    chk("pat-year", "date: 2027", "Patent_Expire_Date_Text", "Aug 13, 2027", "correct")
    chk("pat-fulldate", "DATE: Aug 13, 2027", "Patent_Expire_Date_Text", "Aug 13, 2027", "correct")
    chk("pat-wrong", "date: 2029", "Patent_Expire_Date_Text", "Aug 13, 2027", "incorrect")
    chk("pat-nolabel", "The patent expires in 2027.", "Patent_Expire_Date_Text", "Aug 13, 2027", "needs_judge")
    chk("exc-date", "date: 11-17-2026", "Exclusivity_Date", "Nov 17, 2026", "correct")
    chk("exc-date-wrong", "DATE: 11-18-2026", "Exclusivity_Date", "Nov 17, 2026", "incorrect")
    chk("exc-na-gold-na", "DATE: NA", "Exclusivity_Date", "", "correct")
    chk("exc-na-gold-date", "DATE: NA", "Exclusivity_Date", "Nov 17, 2026", "incorrect")
    chk("exc-date-gold-na", "DATE: 11-17-2026", "Exclusivity_Date", "", "incorrect")
    chk("open-nl", "COMPANY not listed.\nNOT LISTED", "Open_on_Approval", "Not_Listed", "correct")
    chk("open-nl-hedge", "NOT LISTED (though in 2019 it traded at $12.40)", "Open_on_Approval", "Not_Listed", "needs_judge")
    chk("open-price", "Ticker: ALXN\nOpening price on approval date: $157.02", "Open_on_Approval", "157.02000427246094", "correct")
    chk("open-price-round", "ticker XYZ, opening price 15.99", "Open_on_Approval", "15.989999771118164", "correct")
    chk("open-price-wrong", "ticker XYZ, opening price $16.80", "Open_on_Approval", "15.989999771118164", "incorrect")
    chk("open-said-nl", "NOT LISTED", "Open_on_Approval", "15.989999771118164", "incorrect")
    chk("open-nl-gold-price", "ticker ABC, $20.10", "Open_on_Approval", "Not_Listed", "incorrect")
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
    ap.add_argument("--summary")
    ap.add_argument("--judge")
    a = ap.parse_args()
    if a.selftest:
        sys.exit(selftest())
    if a.summary:
        items = {json.loads(l)["key"]: json.loads(l) for l in open(a.items, encoding="utf-8") if l.strip()}
        scored = [json.loads(l) for l in open(a.summary, encoding="utf-8") if l.strip()]
        judged = {}
        if a.judge:
            for l in open(a.judge, encoding="utf-8"):
                if l.strip():
                    j = json.loads(l)
                    judged[j["key"]] = j["verdict"]
        print(summarise(scored, items, judged))
        return
    if not (a.items and a.answers):
        ap.error("--items and --answers required")
    items = {json.loads(l)["key"]: json.loads(l) for l in open(a.items, encoding="utf-8") if l.strip()}
    out = open(a.out, "w", encoding="utf-8") if a.out else sys.stdout
    for line in open(a.answers, encoding="utf-8"):
        if not line.strip():
            continue
        ans = json.loads(line)
        r = score(ans.get("text", ""), items[ans["key"]]["gold"])
        r["key"] = ans["key"]
        out.write(json.dumps(r, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
