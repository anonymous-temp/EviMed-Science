# [IN] list of article dicts
# [OUT] deduplicated list of article dicts
# [POS] src/bibliometric/cleaning/dedup.py - deduplication

from __future__ import annotations

import hashlib
import logging
import re

logger = logging.getLogger(__name__)


def deduplicate(articles: list[dict]) -> list[dict]:
    """Remove duplicate articles by PMID and fuzzy title matching."""
    deduped = _dedup_by_pmid(articles)
    deduped = _dedup_by_title_hash(deduped)
    removed = len(articles) - len(deduped)
    if removed > 0:
        logger.info("Removed %d duplicates (%d → %d)", removed, len(articles), len(deduped))
    return deduped


def _dedup_by_pmid(articles: list[dict]) -> list[dict]:
    """Remove exact PMID duplicates, keeping first occurrence."""
    seen = set()
    result = []
    for art in articles:
        pmid = art.get("pmid", "")
        if pmid and pmid in seen:
            continue
        if pmid:
            seen.add(pmid)
        result.append(art)
    return result


def _dedup_by_title_hash(articles: list[dict]) -> list[dict]:
    """Remove near-duplicate titles using normalized hashing (O(n))."""
    result = []
    seen_hashes = set()

    for art in articles:
        title = art.get("title", "").strip()
        year = art.get("year", "")
        if not title:
            result.append(art)
            continue

        title_key = _normalize_title(title) + "|" + str(year)
        h = hashlib.md5(title_key.encode()).hexdigest()

        if h not in seen_hashes:
            seen_hashes.add(h)
            result.append(art)

    return result


def _normalize_title(title: str) -> str:
    """Normalize title for dedup: lowercase, strip punctuation/spaces."""
    title = title.lower()
    title = re.sub(r"[^a-z0-9\s]", "", title)
    title = re.sub(r"\s+", " ", title).strip()
    return title
