#!/usr/bin/env python3
"""AutoResearchBench scorer (deep: title match; wide: IoU / recall / precision on arXiv ids).

Reproduces CherYou/AutoResearchBench @ 15a5c58e (2026-10-15) evaluate/evaluate_deep_search.py and
evaluate_wide_search.py on a free-text answer instead of the official agent's structured candidate list.

HOW A FREE-TEXT ANSWER BECOMES CANDIDATES
  1. Answer region = text after the LAST "Final answer:" marker (case-insensitive, markdown stripped).
     No marker -> the last 40 lines (deep) / the whole reply (wide), and `extraction` = "fallback".
  2. If the region is just "None" (also "no paper", "none found") -> the answer is the explicit empty answer
     (the official `final_candidate_state == "none"`).
  3. Each non-empty line of the region is one candidate (bullets, numbering and markdown stripped).
     arXiv ids on the line are read with two patterns: new style 0000.00000 (version suffix ignored) and old style
     (cs/0409043, math/9811157, cond-mat/0009432), also from arxiv.org/abs|pdf URLs.  The title is the line text
     before "(arXiv", before " - arXiv", or the markdown link text.
  Deep keeps only the FIRST candidate (official --max-candidates-per-pass 1).  Wide keeps all candidates.

DEEP  (official: an LLM judge compares the candidate title with the gold title; "None" gold is right only for "None")
  gold None            -> correct iff the answer is the explicit None, else incorrect.
  gold paper:
    answer None / no candidate                               -> incorrect
    candidate id == gold id                                  -> correct (id)
    normalised titles equal, or one is a >=5-word prefix of the other (the official judge accepts truncation)
    or similarity >= 0.92                                    -> correct (title)
    0.50 <= similarity < 0.92 or one title contains the other -> needs_judge  (official judge prompt: deep_judge_prompt())
    otherwise                                                -> incorrect
  Metrics: accuracy = correct / n; `needs_judge` rows are reported separately and resolved with --judge.

WIDE  (official: IoU, recall, precision between gold arXiv-id set and predicted arXiv-id set)
  predicted ids = ids found on the candidate lines.  Lines that carry no id, or an id that is not in the gold
  set but whose title matches a gold title (>= 0.92 similarity), are mapped to the gold id of that title
  (`rescued`): the official pipeline takes ids from the search tool's record, a free-text answer can mistype one.
  Reported per item: iou, recall, precision (rescued) and iou_strict (ids exactly as typed).  Edge cases follow
  compute_iou_recall(): both sets empty -> 1.0; an empty prediction scores 0.
  Aggregate: mean iou / recall / precision / iou_strict over items.

CLI
  score_arb.py --selftest
  score_arb.py --items items/arb.jsonl --answers answers.jsonl [--out scored.jsonl]
  score_arb.py --summary scored.jsonl [--judge judged.jsonl]
"""
import argparse
import collections
import difflib
import json
import re
import sys

NEW_ID = re.compile(r"(?<![\d.])(\d{4}\.\d{4,5})(?:v\d+)?(?![\d])")
OLD_ID = re.compile(r"(?<![A-Za-z\-])([a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?", re.IGNORECASE)
FINAL = re.compile(r"final\s*answer\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?", re.IGNORECASE)
NONE_RE = re.compile(r"^(none|no paper(?:s)?(?: found| satisfies?.*)?|none found|n/?a)\.?$", re.IGNORECASE)

JUDGE_SYSTEM = (
    "You are an expert verifier for academic paper titles. Your task is to determine if a candidate paper title "
    "refers to the exact same paper as a ground truth title.\n"
    "Note that the returned candidate title may be truncated, such as \"The effects of external planets on inner "
    "systems: multiplicities, inclinations, and pathways to eccentric warm Jupiters\" becoming \"The effects of "
    "external planets on inner systems: multiplicities ...\". Such cases should still be judged as correct.\n"
    "Ignore minor differences in punctuation, capitalization, or the presence or absence of subtitles unless they "
    "fundamentally change the paper's identity.\n"
    "Respond ONLY with a JSON object in the following format:\n"
    "{\"is_match\": boolean, \"reason\": \"A brief explanation for your decision.\"}"
)


def deep_judge_prompt(gold_title: str, candidate_title: str) -> str:
    """The official judge user message (system message: JUDGE_SYSTEM)."""
    return ("Please verify if the following two titles refer to the same paper.\n\n"
            f"Ground Truth Title:\n`{gold_title}`\n\nCandidate Title:\n`{candidate_title}`")


# ------------------------------------------------------------------ parsing
def norm_id(s: str) -> str:
    s = re.sub(r"(?i)arxiv:", "", s or "").strip()
    s = re.sub(r"v\d+$", "", s)
    m = NEW_ID.search(s)
    if m:
        return m.group(1)
    m = OLD_ID.search(s)
    return m.group(1).lower() if m else s.strip().lower()


def norm_title(s: str) -> str:
    s = re.sub(r"[*_`]+", "", s or "").lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def similarity(a: str, b: str) -> float:
    a, b = norm_title(a), norm_title(b)
    return difflib.SequenceMatcher(None, a, b).ratio() if a and b else 0.0


def titles_equal(cand: str, gold: str) -> bool:
    a, b = norm_title(cand), norm_title(gold)
    if not a or not b:
        return False
    if a == b:
        return True
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    if len(short.split()) >= 5 and long_.startswith(short):
        return True
    return similarity(a, b) >= 0.92


def ids_in(line: str):
    out = [m.group(1) for m in NEW_ID.finditer(line)]
    out += [m.group(1).lower() for m in OLD_ID.finditer(line) if "/" in m.group(1) and not m.group(1).lower().startswith(("http", "arxiv.org"))]
    seen, uniq = set(), []
    for i in out:
        if i not in seen:
            seen.add(i)
            uniq.append(i)
    return uniq


def clean_title(line: str) -> str:
    s = line.strip()
    m = re.search(r"\[([^\]]+)\]\((?:https?://)?arxiv[^)]*\)", s)
    if m:
        return m.group(1).strip()
    s = re.sub(r"^[\s>*\-•#]*(?:\d+[.)]\s*)?", "", s)
    s = re.sub(r"\(?\s*arxiv\s*[:/].*$", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s[-–—|]\s*arxiv.*$", "", s, flags=re.IGNORECASE)
    s = re.sub(r"https?://\S+", "", s)
    return re.sub(r"[*_`\"“”]+", "", s).strip(" .,;:-–—[]")


def parse_answer(text: str, kind: str):
    """-> {"is_none": bool, "candidates": [{"title","ids","raw"}], "extraction": "final"|"fallback"|"empty"}"""
    text = text or ""
    marks = list(FINAL.finditer(text))
    if marks:
        region, extraction = text[marks[-1].end():], "final"
    else:
        lines = text.strip().splitlines()
        region, extraction = ("\n".join(lines[-40:]) if kind == "deep" else text), "fallback"
    lines = [ln for ln in region.splitlines() if ln.strip()]
    if not lines:
        return {"is_none": False, "candidates": [], "extraction": "empty"}
    first = re.sub(r"[*_`]+", "", lines[0]).strip()
    if NONE_RE.match(first) and extraction == "final":
        return {"is_none": True, "candidates": [], "extraction": extraction}
    cands = []
    for ln in lines:
        stripped = ln.strip()
        if stripped in ("---", "***") or re.match(r"^#+\s", stripped) and not ids_in(stripped):
            continue
        ids = ids_in(ln)
        title = clean_title(ln)
        if not ids and len(title.split()) < 3:
            continue
        cands.append({"title": title, "ids": ids, "raw": stripped[:300]})
    if kind == "deep" and extraction == "final":
        # the "Final answer:" line itself may be followed by explanation lines; only the first line is the answer
        cands = cands[:1]
    return {"is_none": False, "candidates": cands, "extraction": extraction}


# ------------------------------------------------------------------ scoring
def score_deep(text: str, gold: dict) -> dict:
    ans = parse_answer(text, "deep")
    base = {"extraction": ans["extraction"], "answer_is_none": ans["is_none"]}
    if gold.get("is_none"):
        return {**base, "verdict": "correct" if ans["is_none"] else "incorrect",
                "why": "gold is None; " + ("answered None" if ans["is_none"] else "answered a paper or nothing")}
    if ans["is_none"] or not ans["candidates"]:
        return {**base, "verdict": "incorrect", "why": "answered None" if ans["is_none"] else "no candidate parsed"}
    cand = ans["candidates"][0]
    gold_title, gold_id = gold["titles"][0], norm_id(gold["arxiv_ids"][0]) if gold["arxiv_ids"] else ""
    out = {**base, "candidate_title": cand["title"], "candidate_ids": cand["ids"], "gold_title": gold_title,
           "gold_id": gold_id}
    if gold_id and gold_id in [norm_id(i) for i in cand["ids"]]:
        return {**out, "verdict": "correct", "why": "arXiv id equals gold id"}
    if titles_equal(cand["title"], gold_title):
        return {**out, "verdict": "correct", "why": "title matches (exact / truncation / >=0.92)"}
    sim = similarity(cand["title"], gold_title)
    a, b = norm_title(cand["title"]), norm_title(gold_title)
    if sim >= 0.50 or (len(a) >= 15 and (a in b or b in a)):
        return {**out, "verdict": "needs_judge", "why": f"title similarity {sim:.2f}"}
    return {**out, "verdict": "incorrect", "why": f"different paper (title similarity {sim:.2f})"}


def score_wide(text: str, gold: dict) -> dict:
    ans = parse_answer(text, "wide")
    gold_ids = [norm_id(i) for i in gold["arxiv_ids"] if i]
    gold_set = set(gold_ids)
    gold_titles = gold["titles"]
    strict, final = set(), set()
    rescued = []
    for c in ans["candidates"]:
        cid = {norm_id(i) for i in c["ids"]}
        strict |= cid
        hit = cid & gold_set
        if hit:
            final |= hit
            continue
        # id absent or not in gold: try the title
        matched = None
        if c["title"] and len(c["title"].split()) >= 3:
            for t, i in zip(gold_titles, gold["arxiv_ids"]):
                if i and titles_equal(c["title"], t):
                    matched = norm_id(i)
                    break
        if matched:
            final.add(matched)
            rescued.append({"title": c["title"], "typed_ids": sorted(cid), "gold_id": matched})
        else:
            final |= cid

    def metrics(pred):
        if not gold_set and not pred:
            return 1.0, 1.0, 1.0
        inter = len(gold_set & pred)
        union = len(gold_set | pred)
        return (inter / union if union else 0.0, inter / len(gold_set) if gold_set else 0.0,
                inter / len(pred) if pred else 0.0)

    iou, rec, prec = metrics(final)
    iou_s, _, _ = metrics(strict)
    return {"extraction": ans["extraction"], "answer_is_none": ans["is_none"], "verdict": "scored",
            "iou": round(iou, 6), "recall": round(rec, 6), "precision": round(prec, 6), "iou_strict": round(iou_s, 6),
            "gold_count": len(gold_set), "predicted_count": len(final), "hit_count": len(gold_set & final),
            "rescued": rescued, "missed_ids": sorted(gold_set - final)[:50], "extra_ids": sorted(final - gold_set)[:50],
            "why": f"{len(gold_set & final)}/{len(gold_set)} gold found, {len(final - gold_set)} extra"}


def score(text: str, gold: dict) -> dict:
    return score_deep(text, gold) if gold["type"] == "deep" else score_wide(text, gold)


def summarise(scored, items, judged=None):
    judged = judged or {}
    deep = [r for r in scored if items[r["key"]]["gold"]["type"] == "deep"]
    wide = [r for r in scored if items[r["key"]]["gold"]["type"] == "wide"]
    lines = []
    if deep:
        v = [judged.get(r["key"], r["verdict"]) for r in deep]
        n = len(v)
        lines.append(f"DEEP  n={n}  correct={v.count('correct')} ({v.count('correct') / n:.1%})  "
                     f"incorrect={v.count('incorrect')}  needs_judge={v.count('needs_judge')}")
        none_rows = [judged.get(r["key"], r["verdict"]) for r in deep if items[r["key"]]["gold"]["is_none"]]
        if none_rows:
            lines.append(f"  of which gold=None: n={len(none_rows)} correct={none_rows.count('correct')}")
        paper_rows = [x for r, x in zip(deep, v) if not items[r["key"]]["gold"]["is_none"]]
        if paper_rows:
            lines.append(f"  gold=paper: n={len(paper_rows)} correct={paper_rows.count('correct')} ({paper_rows.count('correct') / len(paper_rows):.1%})")
    if wide:
        n = len(wide)
        avg = lambda k: sum(r[k] for r in wide) / n
        lines.append(f"WIDE  n={n}  IoU={avg('iou'):.4f}  recall={avg('recall'):.4f}  precision={avg('precision'):.4f}  "
                     f"IoU_strict={avg('iou_strict'):.4f}")
    return "\n".join(lines)


# ------------------------------------------------------------------ self-test
def selftest():
    fails = []
    gdeep = {"type": "deep", "titles": ["ReLMoGen: Leveraging Motion Generation in Reinforcement Learning for Mobile Manipulation"],
             "arxiv_ids": ["2008.07792"], "is_none": False}
    gnone = {"type": "deep", "titles": ["None"], "arxiv_ids": [""], "is_none": True}
    gwide = {"type": "wide", "titles": ["Alpha Beta Gamma Method", "Delta Epsilon Zeta Study", "Old Style Paper On Graphs", "Fourth Paper Title Here"],
             "arxiv_ids": ["2301.00001", "2302.12345", "cs/0409043", "2303.00004"], "is_none": False}

    def d(name, text, g, want):
        got = score_deep(text, g)["verdict"]
        if got != want:
            fails.append((name, got, want))

    d("deep-id", "long text\nFinal answer: ReLMoGen (arXiv:2008.07792)", gdeep, "correct")
    d("deep-id-v2", "Final answer: some other wording (arXiv:2008.07792v2)", gdeep, "correct")
    d("deep-title-exact", "**Final answer:** ReLMoGen: Leveraging Motion Generation in Reinforcement Learning for Mobile Manipulation", gdeep, "correct")
    d("deep-title-trunc", "Final answer: ReLMoGen: Leveraging Motion Generation in Reinforcement Learning ...", gdeep, "correct")
    d("deep-title-case", "Final answer: relmogen leveraging motion generation in reinforcement learning for mobile manipulation (arXiv:2001.00001)", gdeep, "correct")
    d("deep-wrong", "Final answer: Attention Is All You Need (arXiv:1706.03762)", gdeep, "incorrect")
    d("deep-close", "Final answer: Leveraging Motion Generation in RL for Mobile Manipulation", gdeep, "needs_judge")
    d("deep-none", "Final answer: None", gdeep, "incorrect")
    d("deep-empty", "I could not find it.", gdeep, "incorrect")
    d("none-right", "...\nFinal answer: None", gnone, "correct")
    d("none-right-md", "...\n**Final answer:** **None**.", gnone, "correct")
    d("none-wrong", "Final answer: Some Paper (arXiv:2001.00001)", gnone, "incorrect")
    d("none-empty", "no idea", gnone, "incorrect")

    def w(name, text, want_iou, want_strict=None):
        r = score_wide(text, gwide)
        if abs(r["iou"] - want_iou) > 1e-6 or (want_strict is not None and abs(r["iou_strict"] - want_strict) > 1e-6):
            fails.append((name, r["iou"], r["iou_strict"], want_iou, want_strict))

    w("wide-all", "x\nFinal answer:\n1. Alpha Beta Gamma Method (arXiv:2301.00001)\n2. Delta Epsilon Zeta Study (arXiv:2302.12345)\n"
      "3. Old Style Paper On Graphs (arXiv:cs/0409043)\n4. Fourth Paper Title Here (arXiv:2303.00004v2)", 1.0, 1.0)
    w("wide-half", "Final answer:\n- Alpha Beta Gamma Method (arXiv:2301.00001)\n- Delta Epsilon Zeta Study (arXiv:2302.12345)\n"
      "- Unrelated Extra Paper (arXiv:2399.99999)\n- Another Extra (arXiv:2399.99998)", 2 / 6, 2 / 6)
    w("wide-links", "Final answer:\n* [Alpha Beta Gamma Method](https://arxiv.org/abs/2301.00001)\n* [Old Style Paper On Graphs](https://arxiv.org/abs/cs/0409043v1)", 0.5, 0.5)
    w("wide-title-only", "Final answer:\nAlpha Beta Gamma Method\nDelta Epsilon Zeta Study", 0.5, 0.0)
    w("wide-wrong-id-right-title", "Final answer:\nAlpha Beta Gamma Method (arXiv:2301.99999)", 0.25, 0.0)
    w("wide-none", "Final answer: None", 0.0, 0.0)
    w("wide-nothing", "I give up.", 0.0, 0.0)
    w("wide-last-marker-wins", "Final answer:\nWrong One (arXiv:2399.99999)\n\nFinal answer:\nAlpha Beta Gamma Method (arXiv:2301.00001)", 0.25, 0.25)
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
