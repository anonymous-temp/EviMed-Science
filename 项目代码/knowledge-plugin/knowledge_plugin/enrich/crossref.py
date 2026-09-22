"""Crossref for ``/text``: the publisher-deposited abstract (JATS), when PubMed and Europe PMC have none.

44 % of journal works carry a Crossref ``abstract`` (dry run 2026-09-21, 738 of 1,687), as JATS
XML (``<jats:p>``, ``<jats:sec>``, ``<jats:title>Abstract</jats:title>``). An entry read by the
``crossref-issn`` adapter already holds it as its summary, so this request is only made for
entries that came from elsewhere with a DOI. A 404 means Crossref does not know the DOI
(DataCite DOIs such as arXiv's live elsewhere) and is final.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any
from urllib.parse import quote

from ..adapters.common import clean_markup
from .common import Endpoints, Trace, get


def work_url(endpoints: Endpoints, doi: str) -> str:
    return f"{endpoints.crossref_works}/{quote(doi, safe='/:;()._-')}"


def jats_abstract(value: Any) -> str | None:
    text = clean_markup(value)
    if text[:9].lower() == "abstract ":
        text = text[9:].lstrip()
    return text or None


async def abstract_for(fetcher: Any, endpoints: Endpoints, doi: str,
                       trace: Trace) -> tuple[str | None, str | None, datetime | None]:
    """``(abstract, journal, fetched_at)`` from Crossref's record of ``doi``."""
    attempt = await get(fetcher, work_url(endpoints, doi))
    if attempt.result is None:
        trace.record(attempt, "crossref_work")
        return None, None, None
    if attempt.result.status == 404:
        trace.notes.append("crossref_work_not_found")
        return None, None, None
    try:
        message = json.loads(attempt.result.body.decode("utf-8", errors="replace")).get("message") or {}
    except (ValueError, AttributeError):
        trace.notes.append("crossref_work_unreadable")
        return None, None, None
    container = message.get("container-title") or []
    return (jats_abstract(message.get("abstract")), (clean_markup(container[0]) if container else None),
            attempt.result.fetched_at)
