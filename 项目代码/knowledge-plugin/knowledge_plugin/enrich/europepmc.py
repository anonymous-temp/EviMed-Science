"""Europe PMC for ``/text``: the second route to an abstract, and the preprint ↔ publication links.

Asked when PubMed has no abstract (not indexed yet, or never: preprints). DOIs go in batches of
up to 20 as ``DOI:"a" OR DOI:"b"`` (the DOI must be quoted; Europe PMC lower-cases DOIs in its
answer, so matching is on the lower-cased DOI). The ~20 % of answers without ``hitCount``
(2026-09-21) are a transient failure of this attempt, never "not found".

Preprint links (measured 2026-09-22): a medRxiv preprint that became a paper carries
``commentCorrectionList.commentCorrection[{source: "MED", id: <PMID>, type: "Preprint of"}]``
("Link created based on a title-first author match") — an id, not a DOI. The linked record is
looked up once more (``EXT_ID:<id> AND SRC:<source>``) for its DOI, which becomes
``published_version_doi`` on a preprint or ``preprint_of_doi`` on a paper.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ..adapters.common import clean_markup, normalize_doi
from ..adapters.europepmc import europepmc_journal, europepmc_results
from ..adapters.eutils import affiliation_country, authors_short
from ..model import FetchError
from .common import Attempt, Endpoints, Trace, get

DOIS_PER_QUERY = 20


def search_url(endpoints: Endpoints, query: str, page_size: int = 25) -> str:
    return f"{endpoints.europepmc_search}?query={quote(query, safe='')}&format=json&resultType=core&pageSize={page_size}"


def doi_query(dois: list[str]) -> str:
    return " OR ".join(f'DOI:"{doi}"' for doi in dois)


def id_query(source: str, record_id: str) -> str:
    return f"EXT_ID:{record_id} AND SRC:{source}"


async def _search(fetcher: Any, endpoints: Endpoints, query: str, page_size: int, trace: Trace,
                  step: str) -> list[dict] | None:
    attempt = await get(fetcher, search_url(endpoints, query, page_size))
    if attempt.result is None:
        trace.record(attempt, step)
        return None
    try:
        _, results = europepmc_results(attempt.result)
    except FetchError as error:
        trace.record(Attempt(error=error), step)
        return None
    found = [r for r in results if isinstance(r, dict)]
    for result in found:
        result["fetched_at"] = attempt.result.fetched_at  # not an Europe PMC field; when we read it
    return found


async def by_dois(fetcher: Any, endpoints: Endpoints, dois: list[str], trace: Trace) -> dict[str, dict]:
    """Core results keyed by lower-cased DOI, for the DOIs Europe PMC knows."""
    found: dict[str, dict] = {}
    wanted = sorted({d.lower() for d in dois if d})
    for start in range(0, len(wanted), DOIS_PER_QUERY):
        batch = wanted[start:start + DOIS_PER_QUERY]
        results = await _search(fetcher, endpoints, doi_query(batch), 25, trace, "europepmc_doi")
        for result in results or []:
            doi = normalize_doi(result.get("doi"))
            if doi in batch and doi not in found:
                found[doi] = result
    return found


async def resolve_doi(fetcher: Any, endpoints: Endpoints, source: str, record_id: str, trace: Trace) -> str | None:
    """The DOI of the Europe PMC record ``source``/``record_id`` (a linked paper or preprint)."""
    results = await _search(fetcher, endpoints, id_query(source, record_id), 1, trace, "europepmc_link")
    for result in results or []:
        if str(result.get("id")) == str(record_id):
            return normalize_doi(result.get("doi"))
    return None


def preprint_links(result: dict) -> list[tuple[str, str, str]]:
    """``(type, source, id)`` of the preprint relations in a core result (``Preprint of`` / ``Preprint in`` …)."""
    corrections = (result.get("commentCorrectionList") or {}).get("commentCorrection") or []
    links = []
    for item in corrections if isinstance(corrections, list) else [corrections]:
        kind = str(item.get("type") or "")
        if "preprint" in kind.lower() and item.get("id") and item.get("source"):
            links.append((kind, str(item["source"]), str(item["id"])))
    return links


def result_enrichment(result: dict) -> tuple[str | None, dict[str, Any]]:
    """``(abstract, enrichment)`` from one core result."""
    abstract = clean_markup(result.get("abstractText")) or None
    types = (result.get("pubTypeList") or {}).get("pubType") or []
    mesh = [clean_markup(h.get("descriptorName")) for h in ((result.get("meshHeadingList") or {}).get("meshHeading") or [])
            if isinstance(h, dict) and h.get("descriptorName")]
    authors = (result.get("authorList") or {}).get("author") or []
    names = [clean_markup(a.get("fullName")) for a in authors if isinstance(a, dict) and a.get("fullName")]
    countries: list[str] = []
    for author in authors if isinstance(authors, list) else []:
        details = ((author or {}).get("authorAffiliationDetailsList") or {}).get("authorAffiliation") or []
        for detail in details:
            country = affiliation_country(str((detail or {}).get("affiliation") or ""))
            if country and country not in countries:
                countries.append(country)
    values = {
        "publication_types": [str(t) for t in (types if isinstance(types, list) else [types]) if t] or None,
        "mesh": mesh or None,
        "journal": europepmc_journal(result),
        "authors_short": authors_short(names),
        "affiliation_countries": countries or None,
    }
    return abstract, {k: v for k, v in values.items() if v}
