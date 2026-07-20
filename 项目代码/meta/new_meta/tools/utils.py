"""Shared utility functions used across MetaAgent modules."""
from __future__ import annotations

import hashlib
import re


_SURNAME_PARTICLES = {
    "al",
    "da",
    "de",
    "del",
    "della",
    "der",
    "di",
    "dos",
    "du",
    "la",
    "le",
    "van",
    "von",
}


def _is_initial_token(value: str) -> bool:
    cleaned = re.sub(r"[^A-Za-z]", "", value or "")
    return 0 < len(cleaned) <= 2 and cleaned.upper() == cleaned


def _trailing_surname(parts: list[str]) -> str:
    start = len(parts) - 1
    while start > 0 and parts[start - 1].lower().strip(".") in _SURNAME_PARTICLES:
        start -= 1
    return " ".join(parts[start:])


def first_author_lastname(authors: list[str], *, prefer_display_order: bool = False) -> str:
    """Safely extract first author's last name from an author list."""
    if not authors:
        return "Unknown"
    first = re.sub(r"\s+", " ", authors[0].strip())
    if not first:
        return "Unknown"
    if "," in first:
        family = first.split(",", 1)[0].strip()
        return family or "Unknown"
    parts = first.split()
    parts = [part for part in parts if part.lower().rstrip(".") not in {"md", "phd"}]
    if not parts:
        return "Unknown"
    if len(parts) >= 3:
        middle = parts[1:-1]
        if _is_initial_token(parts[-1]) and any(not _is_initial_token(part) for part in middle):
            return parts[0]
        if any(_is_initial_token(part) for part in middle) and parts[-2].lower().strip(".") in _SURNAME_PARTICLES:
            return _trailing_surname(parts)
        if middle and all(_is_initial_token(part) for part in middle):
            return _trailing_surname(parts)
    if prefer_display_order and len(parts) >= 2:
        return _trailing_surname(parts)
    return parts[0] if parts else "Unknown"


def study_label(authors: list[str], year: int, *, prefer_display_order: bool = False) -> str:
    """Format a study label as 'LastName YYYY'."""
    return f"{first_author_lastname(authors, prefer_display_order=prefer_display_order)} {year}"


def paper_identity(paper: dict) -> str:
    """Return a stable identifier for papers that may lack PMID.

    PMID is preferred, but preprints and repository records often only have DOI
    or provider IDs. Falling back to an empty string causes cache collisions
    across parsing, extraction, and RoB, so this helper is the single identity
    path for pipeline dictionaries.
    """
    for key in ("pmid", "doi", "openalex_id", "s2_paper_id"):
        value = str(paper.get(key) or "").strip()
        if value:
            return value

    title = re.sub(r"\s+", " ", str(paper.get("title") or "").strip().lower())
    if title:
        return "title_" + hashlib.sha1(title.encode("utf-8")).hexdigest()[:12]
    return "unknown"


def safe_identifier(identifier: str) -> str:
    """Make an identifier safe for filenames while keeping it recognizable."""
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(identifier or "").strip())
    safe = safe.strip("._-")
    return safe[:120] if safe else "unknown"
