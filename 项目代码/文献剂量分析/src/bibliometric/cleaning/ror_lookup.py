# [IN] list of raw institution names
# [OUT] dict mapping raw name → standardized ROR name
# [POS] src/bibliometric/cleaning/ror_lookup.py - ROR API institution resolution

from __future__ import annotations

import logging
from collections import Counter

import requests

logger = logging.getLogger(__name__)

_ROR_API = "https://api.ror.org/organizations"
_TIMEOUT = 10


def lookup_ror(name: str) -> str | None:
    """Look up a single institution name via the ROR API.

    Returns the standardized name if a confident match is found, else None.
    The ROR API is free and requires no authentication.
    """
    try:
        resp = requests.get(
            _ROR_API,
            params={"affiliation": name},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        items = data.get("items", [])
        if not items:
            return None
        best = items[0]
        # Only accept high-confidence matches
        if best.get("score", 0) >= 0.8 and best.get("chosen", False):
            org = best.get("organization", {})
            return org.get("name")
    except Exception as exc:
        logger.debug("ROR lookup failed for '%s': %s", name, exc)
    return None


def resolve_institutions(
    articles: list[dict],
    top_n: int = 50,
) -> dict[str, str]:
    """Resolve the top-N most frequent institution names via ROR API.

    Returns a mapping {raw_name: standardized_name} for names that were
    successfully resolved. Silently skips on network errors.
    """
    freq: Counter = Counter()
    for art in articles:
        for inst in art.get("institutions", []):
            freq[inst] += 1

    top_names = [name for name, _ in freq.most_common(top_n)]
    mapping: dict[str, str] = {}

    for name in top_names:
        resolved = lookup_ror(name)
        if resolved and resolved.lower() != name.lower():
            mapping[name] = resolved
            logger.info("ROR resolved: '%s' → '%s'", name, resolved)

    return mapping


def apply_ror_mapping(articles: list[dict], mapping: dict[str, str]) -> None:
    """Apply ROR name mapping to articles in-place."""
    if not mapping:
        return
    for art in articles:
        art["institutions"] = [
            mapping.get(inst, inst) for inst in art.get("institutions", [])
        ]
