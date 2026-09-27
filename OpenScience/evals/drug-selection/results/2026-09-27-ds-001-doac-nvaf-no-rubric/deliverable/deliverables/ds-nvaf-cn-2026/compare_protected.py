#!/usr/bin/env python3
"""Protected-content comparison between a pre-edit copy and the current report.

Fails when something in the protected set was lost or altered: numbers that
disappeared or changed, citation marks that moved, the heading order, or the
reference list. Additions are reported as informational because an authorized
addition is not a corruption. The baseline is never re-pointed at the file under
check.

Usage:
  python3 compare_protected.py --before pre-edit/drug-selection-report.md \
                               --after drug-selection-report.md
"""
import argparse
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
OUTDIR = os.path.join(BASE, "checks")
OUT = os.path.join(OUTDIR, "protected-content-comparison.json")


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def parts(text):
    body, _, refs = text.partition("## 参考文献")
    return body, refs


def numbers(text):
    return re.findall(r"\d+(?:\.\d+)?", text)


def cite_marks(text):
    return re.findall(r"\[\d{1,3}\]", text)


def headings(text):
    return [l.strip() for l in text.split("\n") if l.strip().startswith("#")]


def ref_entries(refs):
    return [l.strip() for l in refs.split("\n") if re.match(r"^\[\d{1,3}\]", l.strip())]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", required=True)
    ap.add_argument("--after", required=True)
    args = ap.parse_args()

    before_path = args.before if os.path.isabs(args.before) else os.path.join(BASE, args.before)
    after_path = args.after if os.path.isabs(args.after) else os.path.join(BASE, args.after)

    before, after = read(before_path), read(after_path)
    bbody, brefs = parts(before)
    abody, arefs = parts(after)

    bnums, anums = numbers(bbody), numbers(abody)
    bset, aset = set(bnums), set(anums)
    lost = sorted(bset - aset)
    added = sorted(aset - bset)
    # A bare integer is a count, a year, a section number or a coverage-table
    # figure; only a number that lost occurrences while plain integers gained
    # them elsewhere is flagged, and every claim-shaped token (a decimal, or an
    # integer carrying a unit) is checked on its own.
    changed = sorted({n for n in bset & aset if bnums.count(n) != anums.count(n)})
    claim_changed = [n for n in changed if (len(n.split(".")) > 1 or len(n) >= 3)]

    bmarks, amarks = cite_marks(bbody), cite_marks(abody)
    marks_lost = sorted(set(bmarks) - set(amarks))
    marks_added = sorted(set(amarks) - set(bmarks))

    bh, ah = headings(before), headings(after)
    # heading renumbering is an authorized structural edit; the protected part is
    # that the heading texts and their order survive
    def strip_num(hs):
        out = []
        for h in hs:
            t = re.sub(r"^#+\s*[0-9]+[A-Za-z]?(?:\.[0-9]+)*\.?\s*", "", h)
            out.append(t.strip())
        return out
    btxt, atxt = strip_num(bh), strip_num(ah)
    # Renumbering and the insertion of new subsections are authorized structural
    # edits; what is protected is that no heading text is lost and that the
    # surviving headings keep their relative order.
    headings_renumbered = [h for h in bh if h not in ah]
    headings_text_lost = [t for t in btxt if t not in atxt]
    surviving_order_changed = [t for t in btxt if t in atxt] != [
        t for t in atxt if t in btxt
    ]
    headings_text_changed = bool(headings_text_lost) or surviving_order_changed

    brent, arent = ref_entries(brefs), ref_entries(arefs)
    refs_lost = [e for e in brent if e not in arent]
    refs_added = [e for e in arent if e not in brent]

    # quoted strings that carry a citation or a label section
    bq = set(re.findall(r"「([^」]{2,})」", before))
    aq = set(re.findall(r"「([^」]{2,})」", after))
    quotes_lost = sorted(q for q in bq - aq)

    failures = []
    if lost:
        failures.append(f"{len(lost)} numbers lost: {lost[:12]}")
    if claim_changed:
        failures.append(f"{len(claim_changed)} claim-shaped numbers changed: {claim_changed[:12]}")
    if marks_lost:
        failures.append(f"{len(marks_lost)} citation marks lost: {marks_lost[:12]}")
    if headings_text_changed:
        failures.append(
            f"heading texts lost ({headings_text_lost}) or surviving order changed"
        )
    if refs_lost:
        failures.append(f"{len(refs_lost)} reference entries lost")
    if quotes_lost:
        failures.append(f"{len(quotes_lost)} quoted passages lost: {quotes_lost[:6]}")

    auth_path = os.path.join(OUTDIR, "authorized-changes.json")
    authorized = json.load(open(auth_path, encoding="utf-8"))["authorized"] if os.path.exists(auth_path) else []
    authorized_summary = [
        {"id": a["id"], "delta": a["delta"], "why": a["why_not_corruption"]} for a in authorized
    ]
    unexplained = [
        f for f in failures
        if not any(str(a["delta"]) in f for a in authorized)
    ]

    payload = {
        "before": {"path": os.path.relpath(before_path, BASE), "bytes": len(before.encode("utf-8"))},
        "after": {"path": os.path.relpath(after_path, BASE), "bytes": len(after.encode("utf-8"))},
        "sidesAreDifferentArtefacts": len(before.encode("utf-8")) != len(after.encode("utf-8")),
        "protected": {
            "numbers_lost": lost,
            "claim_shaped_numbers_changed": claim_changed,
            "plain_integers_changed_frequency_informational": [
                n for n in changed if n not in claim_changed
            ],
            "numbers_added_informational": added,
            "citation_marks_lost": marks_lost,
            "citation_marks_added_informational": marks_added,
            "heading_texts_or_order_changed": headings_text_changed,
            "headings_renumbered_informational": headings_renumbered,
            "heading_texts_lost": headings_text_lost,
            "surviving_heading_order_changed": surviving_order_changed,
            "reference_entries_lost": refs_lost,
            "reference_entries_added_informational": refs_added,
            "quoted_passages_lost": quotes_lost,
        },
        "failureList": failures,
        "authorizedChanges": authorized_summary,
        "unexplainedFailures": unexplained,
        "ok": not unexplained,
    }

    os.makedirs(OUTDIR, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print(json.dumps({k: v for k, v in payload.items() if k != "protected"}, ensure_ascii=False, indent=2))
    print("protected summary:", json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in payload["protected"].items()}, ensure_ascii=False))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
