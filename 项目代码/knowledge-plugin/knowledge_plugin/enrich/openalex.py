"""OpenAlex for ``/text``: an abstract the other indexes do not have, the PMC id, and where the open copy is.

``GET https://api.openalex.org/works/doi:<doi>?select=…`` — one work by its DOI. Measured 2026-10-22: a single work is
free (``x-ratelimit-cost-usd: 0``; OpenAlex meters lists and searches by credit, by API key or address), so the request
carries no key, no e-mail and no other identifier, and a DOI OpenAlex has not seen yet answers 404 (``openalex_not_found``:
new works take days to arrive, the same lag as PubMed's).

- ``abstract``: OpenAlex stores abstracts as an inverted index (word → positions); the text is rebuilt by position, one
  paragraph (the index keeps no breaks, so a structured abstract's headings stay inline). Elsevier and Springer Nature
  withdrew the abstracts of closed content from OpenAlex (Springer Nature 2022-11, Elsevier 2024-11), so OpenAlex mostly
  answers for works it read elsewhere; the controller's sample of the gap found 12 of 83. A rebuilt text shorter than
  ``article_html.ABSTRACT_MIN`` is not taken (OpenAlex keeps the first lines of some letters as their "abstract").
- ``pmcid``: ``ids.pmcid`` — the key to Europe PMC's full text (``fulltext.py``).
- ``best_oa_location``: its ``landing_page_url``, ``pdf_url`` and ``license`` (``cc-by`` …), and ``open_access.oa_status``.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

from .article_html import ABSTRACT_MIN
from .common import Endpoints, Trace, get

SELECT = "id,doi,type,ids,open_access,best_oa_location,primary_location,abstract_inverted_index"
_PMCID = re.compile(r"PMC[0-9]+", re.I)
_LEADING_LABEL = re.compile(r"^(?:abstract|summary)\s*[:.]?\s+", re.I)


@dataclass(frozen=True)
class OpenAlexWork:
    abstract: str | None = None
    pmcid: str | None = None
    work_type: str | None = None
    oa_status: str | None = None
    license: str | None = None
    landing_url: str | None = None
    pdf_url: str | None = None


def work_url(endpoints: Endpoints, doi: str) -> str:
    return f"{endpoints.openalex_works}/doi:{quote(doi, safe='/:;()._-')}?select={SELECT}"


def rebuild_abstract(index: Any) -> str | None:
    """The text of an ``abstract_inverted_index`` (words placed by position), or ``None``."""
    if not isinstance(index, dict) or not index:
        return None
    placed: dict[int, str] = {}
    for word, positions in index.items():
        if not isinstance(word, str) or not isinstance(positions, list):
            continue
        for position in positions:
            if isinstance(position, int) and 0 <= position < 20_000:
                placed[position] = word
    if not placed:
        return None
    text = " ".join(placed[i] for i in sorted(placed)).strip()
    return _LEADING_LABEL.sub("", text) or None


def _https(value: Any) -> str | None:
    return value if isinstance(value, str) and value.startswith(("https://", "http://")) else None


def parse_work(payload: Any) -> OpenAlexWork:
    if not isinstance(payload, dict):
        return OpenAlexWork()
    abstract = rebuild_abstract(payload.get("abstract_inverted_index"))
    if abstract and len(abstract) < ABSTRACT_MIN:
        abstract = None
    ids = payload.get("ids") if isinstance(payload.get("ids"), dict) else {}
    match = _PMCID.search(str(ids.get("pmcid") or ""))
    best = payload.get("best_oa_location") if isinstance(payload.get("best_oa_location"), dict) else {}
    primary = payload.get("primary_location") if isinstance(payload.get("primary_location"), dict) else {}
    open_access = payload.get("open_access") if isinstance(payload.get("open_access"), dict) else {}
    license_ = best.get("license") or primary.get("license")
    return OpenAlexWork(
        abstract=abstract,
        pmcid=match.group(0).upper() if match else None,
        work_type=payload.get("type") if isinstance(payload.get("type"), str) else None,
        oa_status=open_access.get("oa_status") if isinstance(open_access.get("oa_status"), str) else None,
        license=license_ if isinstance(license_, str) and license_ else None,
        landing_url=_https(best.get("landing_page_url")),
        pdf_url=_https(best.get("pdf_url")),
    )


async def work_for(fetcher: Any, endpoints: Endpoints, doi: str, trace: Trace) -> OpenAlexWork | None:
    """The work OpenAlex knows by ``doi``; ``None`` when it does not know it or could not be asked."""
    attempt = await get(fetcher, work_url(endpoints, doi))
    if attempt.result is None:
        if attempt.error is not None and attempt.error.status == 404:
            trace.notes.append("openalex_not_found")
            return None
        trace.record(attempt, "openalex")
        return None
    if attempt.result.status == 404:
        trace.notes.append("openalex_not_found")
        return None
    try:
        payload = json.loads(attempt.result.body.decode("utf-8", errors="replace"))
    except ValueError:
        trace.notes.append("openalex_unreadable")
        return None
    return parse_work(payload)


__all__ = ["OpenAlexWork", "parse_work", "rebuild_abstract", "work_for", "work_url"]
