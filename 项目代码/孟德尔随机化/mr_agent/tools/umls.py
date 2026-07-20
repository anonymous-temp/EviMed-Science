# [IN] None (external API)
# [OUT] Synonym list
# [POS] mr_agent/tools/umls.py - UMLS synonym expansion
"""UMLS API integration for medical synonym expansion."""

from __future__ import annotations

import logging
import os

import requests

from mr_agent.llm.client import LLMClient

logger = logging.getLogger(__name__)

UMLS_AUTH_URL = "https://utslogin.nlm.nih.gov/cas/v1/api-key"
UMLS_SEARCH_URL = "https://uts-ws.nlm.nih.gov/rest/search/current"
UMLS_CONTENT_URL = "https://uts-ws.nlm.nih.gov/rest/content/current"


def get_synonyms_umls(term: str, api_key: str | None = None) -> list[str]:
    """Get medical synonyms from UMLS API."""
    api_key = api_key or os.getenv("UMLS_API_KEY", "")
    if not api_key:
        logger.warning("UMLS API key not configured")
        return []
    tgt = _get_ticket_granting_ticket(api_key)
    if not tgt:
        return []
    cui = _search_cui(term, tgt, api_key)
    if not cui:
        return []
    return _get_atoms(cui, tgt, api_key)


def _get_ticket_granting_ticket(api_key: str) -> str | None:
    """Get TGT from UMLS authentication."""
    try:
        resp = requests.post(UMLS_AUTH_URL, data={"apikey": api_key}, timeout=15)
        resp.raise_for_status()
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(resp.text, "html.parser")
        form = soup.find("form")
        return form["action"] if form else None
    except (requests.RequestException, TypeError):
        logger.warning("UMLS TGT retrieval failed")
        return None


def _get_service_ticket(tgt_url: str) -> str | None:
    """Get service ticket from TGT."""
    service = "http://umlsks.nlm.nih.gov"
    try:
        resp = requests.post(tgt_url, data={"service": service}, timeout=15)
        return resp.text if resp.ok else None
    except requests.RequestException:
        return None


def _search_cui(term: str, tgt_url: str, api_key: str) -> str | None:
    """Search UMLS for CUI of a term."""
    ticket = _get_service_ticket(tgt_url)
    if not ticket:
        return None
    params = {
        "string": term,
        "ticket": ticket,
        "searchType": "words",
        "pageSize": 1,
    }
    try:
        resp = requests.get(UMLS_SEARCH_URL, params=params, timeout=15)
        data = resp.json()
        results = data.get("result", {}).get("results", [])
        return results[0]["ui"] if results else None
    except (requests.RequestException, IndexError, KeyError):
        return None


def _get_atoms(cui: str, tgt_url: str, api_key: str) -> list[str]:
    """Get English synonyms from UMLS atoms."""
    ticket = _get_service_ticket(tgt_url)
    if not ticket:
        return []
    url = f"{UMLS_CONTENT_URL}/CUI/{cui}/atoms"
    params = {
        "ticket": ticket,
        "language": "ENG",
        "pageSize": 25,
    }
    try:
        resp = requests.get(url, params=params, timeout=15)
        data = resp.json()
        names = set()
        for atom in data.get("result", []):
            name = atom.get("name", "")
            if name:
                names.add(name)
        return list(names)[:10]
    except (requests.RequestException, KeyError):
        return []


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
