"""Elsevier's Article Retrieval API for ``/text`` — a hook, inert until the deployment gives the plugin a key.

Elsevier stopped giving the abstracts of its closed articles to Crossref and OpenAlex (2024-11), and its article pages
answer this crawler 403 from every exit, the browser included (2026-10-22: 476 of the week's 1,519 journal items without
text were Elsevier's). Its own API gives an abstract to a registered key: ``GET
https://api.elsevier.com/content/article/doi/<doi>?view=META_ABS&httpAccept=application/json``, the abstract in
``full-text-retrieval-response.coredata.dc:description``.

Without ``KNOWLEDGE_PLUGIN_ELSEVIER_KEY_FILE`` nothing here sends a request (``abstract_for`` answers ``None`` at once).
With it, the fetcher adds the key as the ``X-ELS-APIKey`` header on ``api.elsevier.com`` only (``fetch.py``), so no
code here reads it, and only DOIs under Elsevier's prefixes are asked.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from ..adapters.common import structured_abstract
from .article_html import is_abstract
from .common import Endpoints, Trace, get

ELSEVIER_PREFIXES = ("10.1016/", "10.1053/", "10.1067/", "10.1054/", "10.1078/", "10.1383/", "10.1529/")


def configured(settings: Any) -> bool:
    """The deployment named a key file (only the path is looked at; the fetcher reads the key)."""
    return bool(getattr(settings, "elsevier_key_file", None))


def article_url(endpoints: Endpoints, doi: str) -> str:
    return f"{endpoints.elsevier_article}/{quote(doi, safe='/:;()._-')}?view=META_ABS&httpAccept=application/json"


def parse_abstract(payload: Any) -> str | None:
    response = payload.get("full-text-retrieval-response") if isinstance(payload, dict) else None
    coredata = response.get("coredata") if isinstance(response, dict) else None
    value = coredata.get("dc:description") if isinstance(coredata, dict) else None
    text = structured_abstract(value) if isinstance(value, str) else ""
    return text if is_abstract(text) else None


async def abstract_for(fetcher: Any, endpoints: Endpoints, doi: str, trace: Trace, settings: Any) -> str | None:
    """The abstract Elsevier's API gives for ``doi``; ``None`` without a key, outside its prefixes, or when it has none."""
    if not configured(settings) or not doi.lower().startswith(ELSEVIER_PREFIXES):
        return None
    attempt = await get(fetcher, article_url(endpoints, doi))
    if attempt.result is None:
        trace.record(attempt, "elsevier")
        return None
    if attempt.result.status != 200:
        trace.notes.append(f"elsevier_http_{attempt.result.status}")
        return None
    try:
        return parse_abstract(json.loads(attempt.result.body.decode("utf-8", errors="replace")))
    except ValueError:
        trace.notes.append("elsevier_unreadable")
        return None


__all__ = ["ELSEVIER_PREFIXES", "abstract_for", "article_url", "configured", "parse_abstract"]
