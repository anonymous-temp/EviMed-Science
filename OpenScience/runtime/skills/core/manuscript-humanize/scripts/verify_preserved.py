#!/usr/bin/env python3
"""Prove a humanizing pass changed only prose.

The pass is allowed to rewrite the analyst's sentences and nothing else. What it
must not touch is checkable exactly — quotations bound to sources, numbers,
citation indices, claim markers — so it is checked exactly rather than reviewed
by eye, which is how a rewrite that reads better than the original ends up no
longer matching it.

Exit 0 and an empty report mean the rewrite is safe to deliver.
"""
import argparse
import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

CLAIM_MARKER = re.compile(r"<!--\s*claim:([A-Z]+-\d+)\s*-->")
CITATION = re.compile(r"\[(\d+(?:\s*[,，\-–]\s*\d+)*)\]")
DERIVED_MARK = "〔推导〕"
HEADING = re.compile(r"^(#{1,6})\s*(.+?)\s*$", re.M)
# Any run of digits with optional decimal part, percent, or unit-ish tail. Kept
# deliberately broad: a number that moved is worth a false positive, and the
# report says where, so a reviewer resolves it in seconds.
NUMBER = re.compile(r"(?<![A-Za-z0-9])\d+(?:[.,]\d+)*\s*%?")


def normalize(text: str) -> str:
    """Fold what a writer may legitimately change, keep what they may not.

    Whitespace and full-width/half-width punctuation are presentation. Digits
    and letters are not, and NFKC leaves them alone.
    """
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text))


def support_quotes(matrix_path: Path) -> list[str]:
    if not matrix_path or not matrix_path.exists():
        return []
    try:
        matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    quotes = []
    for claim in matrix.get("claims") or []:
        quote = claim.get("supportQuote")
        if isinstance(quote, str) and quote.strip():
            quotes.append(quote.strip())
    return quotes


def counted(pattern: re.Pattern, text: str) -> Counter:
    return Counter(m.group(0) for m in pattern.finditer(text))


def missing(before: Counter, after: Counter) -> list[tuple[str, int, int]]:
    return [(key, count, after.get(key, 0)) for key, count in before.items() if after.get(key, 0) != count]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", required=True, type=Path)
    parser.add_argument("--after", required=True, type=Path)
    parser.add_argument("--matrix", type=Path)
    args = parser.parse_args()

    before = args.before.read_text(encoding="utf-8")
    after = args.after.read_text(encoding="utf-8")
    issues: list[str] = []

    # Quotations are bound to a source; the gate checks them against the
    # preserved artifact verbatim, so a single reworded word fails the package.
    folded_after = normalize(after)
    for quote in support_quotes(args.matrix):
        if normalize(quote) not in folded_after:
            issues.append(f"support quote no longer present verbatim: {quote[:80]}…")

    for label, pattern in (("claim marker", CLAIM_MARKER), ("citation", CITATION), ("number", NUMBER)):
        for value, was, now in missing(counted(pattern, before), counted(pattern, after)):
            issues.append(f"{label} {value!r} appeared {was}× before and {now}× after")

    if before.count(DERIVED_MARK) != after.count(DERIVED_MARK):
        issues.append(
            f"derivation marks: {before.count(DERIVED_MARK)} before, {after.count(DERIVED_MARK)} after",
        )

    headings_before = [(m.group(1), m.group(2)) for m in HEADING.finditer(before)]
    headings_after = [(m.group(1), m.group(2)) for m in HEADING.finditer(after)]
    if headings_before != headings_after:
        removed = [h for h in headings_before if h not in headings_after]
        added = [h for h in headings_after if h not in headings_before]
        issues.append(
            "section headings changed"
            + (f"; removed: {[t for _, t in removed][:5]}" if removed else "")
            + (f"; added: {[t for _, t in added][:5]}" if added else ""),
        )

    report = {
        "ok": not issues,
        "issues": issues,
        "charsBefore": len(before),
        "charsAfter": len(after),
    }
    # A humanizing pass tightens prose, so some shrinkage is expected and a lot
    # is not: this project has watched whole-file rewrites quietly drop
    # thousands of characters of evidence.
    if len(after) < len(before) * 0.85:
        report["issues"].append(
            f"the rewrite is {100 - round(len(after) / len(before) * 100)}% shorter; "
            "check whether evidence was dropped rather than tightened",
        )
        report["ok"] = False
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
