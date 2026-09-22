"""PubMed for ``/text``: abstract, publication types, MeSH, journal, authors, affiliation countries.

Entries with a PMID are fetched by PMID; entries with only a DOI are first searched by DOI in
batches (``"<doi>"[doi] OR …``) and then fetched. **``[doi]`` is not an exact match**: in the
2026-09-21 dry run 1,687 DOIs in 43 batches came back as 1,324 records, 185 of them (14.0 %)
carrying a DOI that was never asked for. Records are therefore re-joined on the DOI they carry
(lower-cased) and on the PMIDs that were asked for; everything else is dropped and counted.
Nothing here trusts a count or a position.

On 2026-09-22 the same 40 Nature Communications DOIs searched as quoted phrases (``"<doi>"[doi]``,
as ``esearch_url`` builds them) returned exactly the 6 indexed records; the dry run's unquoted form
is what over-returned. The quoting is the first defence; ``realign`` is the second and is kept.

PubMed indexing lags Crossref: at 0–1 days 77 % of new articles are not in PubMed yet, at 4–7
days 25 % (plan 10.1) — "not found" is the normal first answer, and the caller keeps the entry
``pending``. The fetcher adds ``tool``/``email``/``api_key``; batches stay at ≤ 40 DOIs per search
and ≤ 200 PMIDs per efetch (NCBI asks for POST above ~200 ids).
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from ..adapters.eutils import authors_short, parse_pubmed_xml
from ..model import FetchError
from .common import Endpoints, Trace, get

DOIS_PER_SEARCH = 40
PMIDS_PER_FETCH = 200


def esearch_url(endpoints: Endpoints, dois: list[str]) -> str:
    term = " OR ".join(f'"{doi}"[doi]' for doi in dois)
    return f"{endpoints.pubmed_esearch}?db=pubmed&retmode=json&retmax=200&term={quote(term, safe='')}"


def efetch_url(endpoints: Endpoints, pmids: list[str]) -> str:
    return f"{endpoints.pubmed_efetch}?db=pubmed&retmode=xml&id={','.join(pmids)}"


def _batches(values: list[str], size: int) -> list[list[str]]:
    return [values[i:i + size] for i in range(0, len(values), size)]


def record_enrichment(record: dict[str, Any]) -> dict[str, Any]:
    """The contract ``enrichment`` fields a PubMed record gives (plus ``affiliation_countries``)."""
    values = {
        "publication_types": record.get("publication_types") or None,
        "mesh": record.get("mesh") or None,
        "journal": record.get("journal") or None,
        "authors_short": authors_short(record.get("authors") or []),
        "affiliation_countries": record.get("affiliation_countries") or None,
    }
    return {k: v for k, v in values.items() if v}


def realign(records: list[dict[str, Any]], *, dois: list[str], pmids: list[str]) -> tuple[dict[str, dict[str, Any]], int]:
    """Key records by what was asked — ``pmid:<n>`` for asked PMIDs, ``doi:<doi>`` for asked DOIs —
    and count the records that match neither (an over-returned ``[doi]`` search)."""
    asked_dois = {d.lower() for d in dois if d}
    asked_pmids = {p for p in pmids if p}
    keyed: dict[str, dict[str, Any]] = {}
    dropped = 0
    for record in records:
        pmid, doi = record.get("pmid"), (record.get("doi") or "").lower()
        matched = False
        if pmid in asked_pmids:
            keyed[f"pmid:{pmid}"] = record
            matched = True
        if doi and doi in asked_dois:
            keyed[f"doi:{doi}"] = record
            matched = True
        dropped += 0 if matched else 1
    return keyed, dropped


async def lookup(fetcher: Any, endpoints: Endpoints, *, dois: list[str], pmids: list[str],
                 trace: Trace) -> dict[str, dict[str, Any]]:
    """PubMed records keyed ``pmid:<n>`` and ``doi:<doi>`` for what was asked, realigned (module docstring)."""
    asked_dois = sorted({d.lower() for d in dois if d})
    asked_pmids = sorted({p for p in pmids if p and p.isdigit()})
    found_pmids = list(asked_pmids)
    for batch in _batches(asked_dois, DOIS_PER_SEARCH):
        attempt = await get(fetcher, esearch_url(endpoints, batch))
        if attempt.result is None:
            trace.record(attempt, "pubmed_esearch")
            continue
        try:
            payload = json.loads(attempt.result.body.decode("utf-8", errors="replace"))
            ids = (payload.get("esearchresult") or {}).get("idlist") or []
        except (ValueError, AttributeError):
            trace.notes.append("pubmed_esearch_unreadable")
            continue
        found_pmids += [str(i) for i in ids if str(i).isdigit() and str(i) not in found_pmids]
    records: dict[str, dict[str, Any]] = {}
    dropped = 0
    for batch in _batches(found_pmids, PMIDS_PER_FETCH):
        attempt = await get(fetcher, efetch_url(endpoints, batch))
        if attempt.result is None:
            trace.record(attempt, "pubmed_efetch")
            continue
        try:
            parsed = parse_pubmed_xml(attempt.result.body)
        except FetchError as error:
            trace.notes.append(f"pubmed_efetch_{error.detail}")
            continue
        for record in parsed:
            record["fetched_at"] = attempt.result.fetched_at
        keyed, extra = realign(parsed, dois=asked_dois, pmids=asked_pmids)
        records.update(keyed)
        dropped += extra
    if dropped:
        trace.notes.append(f"pubmed_realigned_dropped={dropped}")
    return records
