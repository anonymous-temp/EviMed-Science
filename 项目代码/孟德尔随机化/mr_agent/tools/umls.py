# [IN] None (external API)
# [OUT] Synonym list
# [POS] mr_agent/tools/umls.py - UMLS synonym expansion
"""UMLS API integration for medical synonym expansion."""

from __future__ import annotations

import logging
import os

import requests

from mr_agent.llm.client import LLMClient
from mr_agent.source_notes import STATUS_NOT_CONFIGURED, STATUS_REFUSED, STATUS_UNREACHABLE

logger = logging.getLogger(__name__)

UMLS_AUTH_URL = "https://utslogin.nlm.nih.gov/cas/v1/api-key"
UMLS_SEARCH_URL = "https://uts-ws.nlm.nih.gov/rest/search/current"
UMLS_CONTENT_URL = "https://uts-ws.nlm.nih.gov/rest/content/current"


class _Unavailable(Exception):
    """UMLS could not be used for this lookup, and which of the three ways it could not."""

    def __init__(self, status: str):
        super().__init__(status)
        self.status = status


def lookup_synonyms_umls(term: str, api_key: str | None = None) -> tuple[list[str], str | None]:
    """UMLS synonyms for ``term`` and, when UMLS could not be used, why not.

    The reason is ``not_configured`` (no key), ``refused`` (UMLS answered 401/403)
    or ``unreachable`` (it did not answer, or answered unusably); ``None`` when it
    answered, including with no match, which is an answer and not a lost source.
    """
    api_key = api_key or os.getenv("UMLS_API_KEY", "")
    if not api_key:
        logger.warning("UMLS API key not configured")
        return [], STATUS_NOT_CONFIGURED
    try:
        tgt = _get_ticket_granting_ticket(api_key)
        cui = _search_cui(term, tgt, api_key)
        return (_get_atoms(cui, tgt, api_key) if cui else []), None
    except _Unavailable as unavailable:
        return [], unavailable.status


def get_synonyms_umls(term: str, api_key: str | None = None) -> list[str]:
    """Get medical synonyms from UMLS API."""
    return lookup_synonyms_umls(term, api_key)[0]


def _refused(response) -> bool:
    return getattr(response, "status_code", None) in (401, 403)


def _get_ticket_granting_ticket(api_key: str) -> str:
    """Get TGT from UMLS authentication."""
    try:
        resp = requests.post(UMLS_AUTH_URL, data={"apikey": api_key}, timeout=15)
        if _refused(resp):
            raise _Unavailable(STATUS_REFUSED)
        resp.raise_for_status()
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(resp.text, "html.parser")
        form = soup.find("form")
        tgt = form["action"] if form else None
    except (requests.RequestException, TypeError, KeyError):
        logger.warning("UMLS TGT retrieval failed")
        raise _Unavailable(STATUS_UNREACHABLE) from None
    if not tgt:
        raise _Unavailable(STATUS_UNREACHABLE)  # answered, but not with a ticket
    return tgt


def _get_service_ticket(tgt_url: str) -> str | None:
    """Get service ticket from TGT."""
    service = "http://umlsks.nlm.nih.gov"
    try:
        resp = requests.post(tgt_url, data={"service": service}, timeout=15)
        return resp.text if resp.ok else None
    except requests.RequestException:
        return None


def _search_cui(term: str, tgt_url: str, api_key: str) -> str | None:
    """Search UMLS for CUI of a term; None when UMLS has no match."""
    ticket = _get_service_ticket(tgt_url)
    if not ticket:
        raise _Unavailable(STATUS_UNREACHABLE)
    params = {
        "string": term,
        "ticket": ticket,
        "searchType": "words",
        "pageSize": 1,
    }
    try:
        resp = requests.get(UMLS_SEARCH_URL, params=params, timeout=15)
        if _refused(resp):
            raise _Unavailable(STATUS_REFUSED)
        data = resp.json()
        results = data.get("result", {}).get("results", [])
        return results[0]["ui"] if results else None
    except (requests.RequestException, ValueError, IndexError, KeyError, AttributeError):
        raise _Unavailable(STATUS_UNREACHABLE) from None


def _get_atoms(cui: str, tgt_url: str, api_key: str) -> list[str]:
    """Get English synonyms from UMLS atoms."""
    ticket = _get_service_ticket(tgt_url)
    if not ticket:
        raise _Unavailable(STATUS_UNREACHABLE)
    url = f"{UMLS_CONTENT_URL}/CUI/{cui}/atoms"
    params = {
        "ticket": ticket,
        "language": "ENG",
        "pageSize": 25,
    }
    try:
        resp = requests.get(url, params=params, timeout=15)
        if _refused(resp):
            raise _Unavailable(STATUS_REFUSED)
        data = resp.json()
        names = set()
        for atom in data.get("result", []):
            name = atom.get("name", "")
            if name:
                names.add(name)
        return list(names)[:10]
    except (requests.RequestException, ValueError, KeyError, AttributeError):
        raise _Unavailable(STATUS_UNREACHABLE) from None


def get_synonyms_llm(term: str, llm: LLMClient) -> list[str]:
    """Fallback: use LLM to generate medical synonyms."""
    prompt = (
        f"List up to 7 medical synonyms or alternative names for: {term}\n"
        "Return ONLY a JSON array of strings, no explanation."
    )
    result = llm.chat_json(
        messages=[{"role": "user", "content": prompt}],
        model_tier="flash",
    )
    if isinstance(result, list):
        return [str(s) for s in result[:7]]
    return result.get("synonyms", [])[:7]
