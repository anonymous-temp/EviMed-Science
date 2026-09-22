"""Unpaywall for ``/text``: is there a legal free copy, and where is its PDF.

``GET /v2/<doi>``; the contact ``email`` Unpaywall requires is added by the core's fetcher for this
host (read from the contact file, never logged), so no request built here carries it. Unpaywall
answers 404 for DOIs it does not track — that is ``unknown``, not an error.

``oa_status`` vocabulary mapping to the contract's ``open_access`` enum
(``gold green bronze closed unknown``): Unpaywall also says ``hybrid`` (an openly licensed article
in a subscription journal); the contract has no such value, and the class a reader cares about
— the published version is free under a licence — is gold's, so ``hybrid`` is reported as
``gold``. A later minor contract version could add ``hybrid``.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from .common import Endpoints, Trace, get

OA_STATUS = {"gold": "gold", "hybrid": "gold", "green": "green", "bronze": "bronze", "closed": "closed"}


def doi_url(endpoints: Endpoints, doi: str) -> str:
    return f"{endpoints.unpaywall}/{quote(doi, safe='/:;()._-')}"


def parse_unpaywall(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {"open_access": "unknown"}
    status = OA_STATUS.get(str(payload.get("oa_status") or "").lower(), "unknown")
    values: dict[str, Any] = {"open_access": status}
    best = payload.get("best_oa_location") or {}
    for key in ("url_for_pdf", "url"):
        candidate = best.get(key) if isinstance(best, dict) else None
        if isinstance(candidate, str) and candidate.startswith(("https://", "http://")):
            values["oa_pdf_url"] = candidate
            break
    return values


async def open_access(fetcher: Any, endpoints: Endpoints, doi: str, trace: Trace) -> dict[str, Any]:
    attempt = await get(fetcher, doi_url(endpoints, doi))
    if attempt.result is None:
        trace.record(attempt, "unpaywall")
        return {}
    if attempt.result.status == 404:
        return {"open_access": "unknown"}
    try:
        payload = json.loads(attempt.result.body.decode("utf-8", errors="replace"))
    except ValueError:
        trace.notes.append("unpaywall_unreadable")
        return {}
    return parse_unpaywall(payload)
