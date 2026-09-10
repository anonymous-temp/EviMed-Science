"""Check every quoted evidence span against the manuscript it claims to come from.

The meta stage discards the rubric-level evidence and asks the model to restate
`evidence_quotes` and `location_in_paper`. Nothing compared those strings with
the parsed manuscript, so a quote that the model composed read exactly like a
quote it had found. This module does the comparison, drops what cannot be
located, and records what it dropped.

The verdict is a return value, not a block: an issue whose quotes cannot be
located keeps its text but loses its quotes, is marked unverified, and is
demoted out of the fatal/major buckets so an invented quote cannot carry a
critical finding.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from difflib import SequenceMatcher
from typing import Iterable

logger = logging.getLogger(__name__)

# A quote shorter than this matches too much of any manuscript to mean anything.
MIN_QUOTE_CHARS = 8
# Similarity a normalised quote must reach against the best window of the
# manuscript. Parsers reflow lines and drop hyphenation, so exact equality is
# too strict; 0.88 still rejects a sentence the manuscript never contained.
FUZZY_THRESHOLD = 0.88

_QUOTE_MARKS = "“”‘’「」『』«»\"'`"
_DASHES = "‐‑‒–—―−"
_ELLIPSIS_PATTERN = re.compile(r"(\.{3}|…|‥)")


def normalise(text: str) -> str:
    """Fold away the differences a PDF/DOCX parser introduces."""
    folded = unicodedata.normalize("NFKC", str(text or ""))
    folded = "".join(" " if ch in _QUOTE_MARKS else ch for ch in folded)
    folded = "".join("-" if ch in _DASHES else ch for ch in folded)
    folded = folded.replace("­", "")  # soft hyphen
    folded = re.sub(r"-\s+", "", folded)   # hyphenation across a line break
    folded = re.sub(r"\s+", " ", folded)
    return folded.strip().casefold()


def _fragments(quote: str) -> list[str]:
    """An elided quote ("A ... B") is verified fragment by fragment."""
    parts = [part.strip() for part in _ELLIPSIS_PATTERN.split(quote)]
    parts = [part for part in parts if part and not _ELLIPSIS_PATTERN.fullmatch(part)]
    return parts or [quote]


def locate_quote(quote: str, haystack: str) -> dict:
    """Locate one quote in a normalised manuscript.

    Returns ``{"located": bool, "match": "exact"|"fuzzy"|"", "similarity": float,
    "offset": int|None, "reason": str}``.
    """
    normalised_quote = normalise(quote)
    if len(normalised_quote) < MIN_QUOTE_CHARS:
        return {"located": False, "match": "", "similarity": 0.0, "offset": None,
                "reason": "quote_too_short"}
    if not haystack:
        return {"located": False, "match": "", "similarity": 0.0, "offset": None,
                "reason": "manuscript_text_unavailable"}

    best = {"located": False, "match": "", "similarity": 0.0, "offset": None,
            "reason": "not_found_in_manuscript"}
    for fragment in _fragments(normalised_quote):
        fragment = fragment.strip()
        if len(fragment) < MIN_QUOTE_CHARS:
            continue
        offset = haystack.find(fragment)
        if offset >= 0:
            best = {"located": True, "match": "exact", "similarity": 1.0,
                    "offset": offset, "reason": ""}
            continue
        similarity, offset = _best_window(fragment, haystack)
        if similarity >= FUZZY_THRESHOLD:
            if not best["located"] or best["match"] != "exact":
                best = {"located": True, "match": "fuzzy", "similarity": round(similarity, 4),
                        "offset": offset, "reason": ""}
        elif not best["located"] and similarity > best["similarity"]:
            best["similarity"] = round(similarity, 4)
    return best


def _best_window(needle: str, haystack: str) -> tuple[float, int | None]:
    """Best similarity of `needle` against same-length windows of `haystack`.

    Anchored on the needle's longest literal run so the scan stays linear in the
    manuscript rather than quadratic.
    """
    anchor = max(re.split(r"[^\w]+", needle) or [""], key=len)
    if len(anchor) < 4:
        anchor = needle[: max(4, len(needle) // 4)]
    width = len(needle)
    best_ratio, best_offset = 0.0, None
    start = 0
    while True:
        hit = haystack.find(anchor, start)
        if hit < 0:
            break
        window_start = max(0, hit - width)
        window = haystack[window_start:hit + width]
        matcher = SequenceMatcher(None, needle, window, autojunk=False)
        ratio = matcher.real_quick_ratio()
        if ratio > best_ratio:
            ratio = matcher.ratio()
            if ratio > best_ratio:
                best_ratio, best_offset = ratio, window_start
        start = hit + max(1, len(anchor))
    return best_ratio, best_offset


def verify_issue(issue, haystack: str) -> dict:
    """Verify one issue in place. Returns its verification record."""
    quotes = list(getattr(issue, "evidence_quotes", None) or [])
    record = {
        "checked": len(quotes),
        "located": 0,
        "kept": [],
        "dropped": [],
        "verified": True,
    }
    if not quotes:
        # Nothing was claimed, so nothing is contradicted. The issue keeps its
        # severity; it simply carries no quoted evidence.
        record["verified"] = False
        record["reason"] = "no_quote_supplied"
        return record

    kept: list[str] = []
    for quote in quotes:
        outcome = locate_quote(quote, haystack)
        if outcome["located"]:
            record["located"] += 1
            kept.append(quote)
            record["kept"].append({"quote": quote, "match": outcome["match"],
                                   "similarity": outcome["similarity"],
                                   "offset": outcome["offset"]})
        else:
            record["dropped"].append({"quote": quote, "reason": outcome["reason"],
                                      "similarity": outcome["similarity"]})

    issue.evidence_quotes = kept
    record["verified"] = bool(kept)
    if not kept:
        record["reason"] = "no_quote_located_in_manuscript"
    return record


def verify_meta_review(meta_review, manuscript_text: str) -> dict:
    """Verify every issue's quotes; demote the ones whose quotes do not exist.

    Returns a summary suitable for the run artifact.
    """
    haystack = normalise(manuscript_text)
    summary = {
        "manuscript_chars": len(haystack),
        "issues_checked": 0,
        "quotes_checked": 0,
        "quotes_located": 0,
        "quotes_dropped": 0,
        "issues_demoted": 0,
        "issues_without_quotes": 0,
    }
    demoted = []

    for bucket in ("fatal_issues", "major_issues", "minor_issues"):
        for issue in getattr(meta_review, bucket, None) or []:
            record = verify_issue(issue, haystack)
            summary["issues_checked"] += 1
            summary["quotes_checked"] += record["checked"]
            summary["quotes_located"] += record["located"]
            summary["quotes_dropped"] += len(record["dropped"])
            if record["checked"] == 0:
                summary["issues_without_quotes"] += 1
            issue.quote_verification = record
            if record["checked"] and not record["verified"] and bucket != "minor_issues":
                demoted.append((bucket, issue))

    for bucket, issue in demoted:
        getattr(meta_review, bucket).remove(issue)
        issue.severity = "minor"
        issue.confidence = min(float(getattr(issue, "confidence", 0.7) or 0.7), 0.3)
        issue.description = (issue.description or "").rstrip()
        issue.description += (
            "\n\n[未核实] 该问题引用的原文语句未能在稿件解析文本中定位，"
            "引文已移除，严重度已下调；请以稿件原文复核。"
        )
        meta_review.minor_issues.append(issue)
        summary["issues_demoted"] += 1

    logger.info(
        "Quote verification: %d/%d quotes located, %d issues demoted",
        summary["quotes_located"], summary["quotes_checked"], summary["issues_demoted"],
    )
    return summary


def verified_quotes(issues: Iterable) -> list[str]:
    """Every quote that survived verification, in order."""
    result: list[str] = []
    for issue in issues:
        result.extend(getattr(issue, "evidence_quotes", None) or [])
    return result
