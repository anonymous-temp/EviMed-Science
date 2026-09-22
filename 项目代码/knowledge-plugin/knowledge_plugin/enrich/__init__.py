"""``/text`` enrichment: abstract, excerpt and deterministic facts for the entries the platform kept.

The core's text worker calls, for one entry or a batch::

    async def enrich(entry_row: dict, fetcher: Fetcher, settings, *, now=None) -> EntryTextResult
    async def enrich_batch(entry_rows: list[dict], fetcher: Fetcher, settings, *, now=None) -> list[EntryTextResult]

``entry_row`` is the stored entry joined with its source (keys documented on
``model.Enricher``); ``fetcher`` is the protected fetch (it injects NCBI/openFDA keys and the
Unpaywall e-mail per host, so nothing here reads a secret); ``settings`` supplies
``settings.enrichment`` (endpoint bases; defaults when absent). The batch form shares one PubMed
search/fetch and one Europe PMC query across the batch — use it when several entries are due.

Order of work (plan 10.3.4), by entry kind:

``article`` (a journal or preprint entry with a DOI or PMID)
    PubMed by PMID/DOI with DOI realignment → Europe PMC when PubMed has no abstract (and for
    preprints, whose links to a published version only Europe PMC gives) → Crossref's own abstract
    → Unpaywall open-access status → trial facts for registry ids. Status by the text rule below.
``trial`` (a ClinicalTrials.gov entry)
    Phase, status, enrollment, sponsor and the detailed description from the registry.
``page`` (news, regulators, societies, feeds, lists)
    The feed's own text when it is already the full, uncut text; else the main text of the
    entry's page (``page.py``), plus trial facts when the entry names a registered trial.
    Challenge pages, robots refusals, PDFs and 404s are final (``unavailable``); timeouts, 5xx,
    429 and the plugin's own budget are transient (``pending``).
``record`` (openFDA, MedHELM, PREPARE, STAR, and the EviMed API scans — ChiCTR registrations and
guideline index records)
    The structured record already is the text; nothing is fetched (``unavailable``). An EviMed
    record's link is a page the source may not read (ChiCTR answers 405 to programs; WHO ICTRP and
    guideline publishers are outside the row's ``allowed_hosts``).

**EviMed extras** (``evimed.py``, when the deployment configured ``evimed_api_key_file``), on an
entry's final answer only (``available`` / ``unavailable``, never on a pending retry): impact factor
and core-journal tags for journal entries, and the NMPA label excerpt for a safety notice that
names a drug in a closed title form. An entry that had nothing but gains a label excerpt is
``available`` (the contract counts enrichment facts as something to show).

**The text rule for journal and preprint entries** (controller ruling, 2026-09-22): an entry from a
journal read method (``crossref-issn``, ``eutils-query``, ``europepmc``) or carrying a DOI or PMID is
``available`` as soon as an abstract or an excerpt exists; until then it is ``pending`` — with
whatever enrichment was found (publication types, open access …) and a retry delay — for up to 5
days from ``first_seen_at``, and ``unavailable`` (enrichment kept) after that. The plugin does not
bump an entry's revision when its text arrives, so answering ``available`` without an abstract
would let the platform publish a title-only item that is never re-edited once PubMed indexes the
abstract (77 % of 0–1-day-old articles are not in PubMed yet, plan 10.1). ``now`` is the clock
the horizon is measured against (the current time when omitted; tests pass it).

Every enrichment value is deterministic data from the named upstream; the plugin makes no model
call here (contract rule 8).
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import Any

from ..adapters.common import registry_ids
from ..adapters.json_api import family_for
from ..model import EntryTextResult
from . import crossref as crossref_step
from . import europepmc as europepmc_step
from . import evimed as evimed_step
from . import pubmed as pubmed_step
from . import trials as trials_step
from . import unpaywall as unpaywall_step
from .common import Endpoints, Trace
from .page import clip_excerpt, page_excerpt, summary_is_full_text

RETRY_NOT_INDEXED_S = 12 * 3600
RETRY_TRANSIENT_S = 3600
TEXT_HORIZON = timedelta(days=5)
MIN_RETRY_S = 60

ARTICLE_ACCESS = frozenset({"crossref-issn", "eutils-query", "europepmc"})
ARTICLE_FAMILIES = frozenset({"crossref-works", "biorxiv", "arxiv"})
RECORD_FAMILIES = frozenset({"openfda-enforcement", "openfda-shortages", "openfda-drugsfda", "openfda-event",
                             "medhelm", "prepare-registry", "star-rating"})
RECORD_ACCESS = frozenset({"evimed-api"})
# bioRxiv/medRxiv (10.1101, and 10.64898 since 2026), arXiv (DataCite 10.48550), Research Square,
# Preprints.org, SSRN: PubMed does not index these; Europe PMC does.
PREPRINT_DOI_PREFIXES = ("10.1101/", "10.64898/", "10.48550/", "10.21203/", "10.20944/", "10.2139/")
SUMMARY_TEXT_SOURCE = {"eutils-query": "pubmed", "europepmc": "europepmc", "crossref-issn": "crossref"}


def _family(row: dict) -> str | None:
    return family_for(row.get("source_config")) if row.get("source_access") == "json-api" else None


def kind_of(row: dict) -> str:
    """``article`` | ``trial`` | ``page`` | ``record`` (see module docstring)."""
    family = _family(row)
    if family == "ctgov":
        return "trial"
    if family in RECORD_FAMILIES or row.get("source_access") in RECORD_ACCESS:
        return "record"
    has_id = bool(row.get("doi") or row.get("pmid"))
    if has_id and (row.get("source_access") in ARTICLE_ACCESS or family in ARTICLE_FAMILIES
                   or row.get("source_type") in ("journal", "preprint")):
        return "article"
    return "page"


def is_preprint(row: dict) -> bool:
    doi = (row.get("doi") or "").lower()
    return row.get("source_type") == "preprint" or doi.startswith(PREPRINT_DOI_PREFIXES)


def _nct_ids(row: dict) -> list[str]:
    ids = [i for i in (row.get("registry_ids") or []) if str(i).startswith("NCT")]
    return ids or [i for i in registry_ids(row.get("title"), row.get("summary")) if i.startswith("NCT")]


def _merge(target: dict, extra: dict) -> None:
    for key, value in extra.items():
        if value and not target.get(key):
            target[key] = value


async def _trial_facts(row: dict, fetcher: Any, endpoints: Endpoints, trace: Trace,
                       enrichment: dict) -> str | None:
    ncts = _nct_ids(row)
    if not ncts:
        return None
    facts, text = await trials_step.trial(fetcher, endpoints, ncts[0], trace)
    if facts:
        enrichment["trial_facts"] = facts
    return text


async def _article(row: dict, fetcher: Any, endpoints: Endpoints, pubmed_records: dict, epmc: dict,
                   batch_trace: Trace) -> EntryTextResult:
    trace = Trace(notes=list(batch_trace.notes), transient=batch_trace.transient)
    doi, pmid = (row.get("doi") or "").lower() or None, row.get("pmid")
    enrichment: dict[str, Any] = {}
    abstract, fetched_from, fetched_at, known = None, None, None, False
    record = pubmed_records.get(f"pmid:{pmid}") if pmid else None
    record = record or (pubmed_records.get(f"doi:{doi}") if doi else None)
    if record:
        known = True
        enrichment.update(pubmed_step.record_enrichment(record))
        abstract, fetched_from = record.get("abstract"), "pubmed" if record.get("abstract") else None
        fetched_at = record.get("fetched_at") if abstract else None
    result = epmc.get(doi) if doi else None
    if result:
        known = True
        epmc_abstract, epmc_enrichment = europepmc_step.result_enrichment(result)
        _merge(enrichment, epmc_enrichment)
        if not abstract and epmc_abstract:
            abstract, fetched_from, fetched_at = epmc_abstract, "europepmc", result.get("fetched_at")
        for kind, source, record_id in europepmc_step.preprint_links(result)[:1]:
            linked = await europepmc_step.resolve_doi(fetcher, endpoints, source, record_id, trace)
            if linked and linked != doi:
                enrichment["published_version_doi" if kind.lower() == "preprint of" else "preprint_of_doi"] = linked
    if not abstract and row.get("summary"):
        family = _family(row)
        source_text = SUMMARY_TEXT_SOURCE.get(row.get("source_access")) or \
            {"crossref-works": "crossref", "biorxiv": None, "arxiv": None}.get(family or "", "unset")
        if source_text != "unset":
            abstract, fetched_from = row["summary"], source_text
    if not abstract and doi and not is_preprint(row):
        crossref_abstract, journal, crossref_at = await crossref_step.abstract_for(fetcher, endpoints, doi, trace)
        if crossref_abstract:
            abstract, fetched_from, fetched_at = crossref_abstract, "crossref", crossref_at
        if journal:
            enrichment.setdefault("journal", journal)
    if doi and not doi.startswith("10.48550/") and (abstract or known):
        enrichment.update(await unpaywall_step.open_access(fetcher, endpoints, doi, trace))
    await _trial_facts(row, fetcher, endpoints, trace, enrichment)
    if abstract:
        return EntryTextResult(status="available", text_kind="abstract", abstract=abstract, fetched_from=fetched_from,
                               fetched_at=fetched_at, enrichment=enrichment, notes=trace.notes)
    # no abstract yet: pending under the text rule (``apply_text_rule`` decides pending / unavailable)
    return EntryTextResult(status="pending", enrichment=enrichment,
                           retry_after_s=RETRY_TRANSIENT_S if trace.transient else RETRY_NOT_INDEXED_S,
                           notes=trace.notes + (["indexed_without_abstract"] if known else ["not_indexed_yet"]))


async def _trial(row: dict, fetcher: Any, endpoints: Endpoints) -> EntryTextResult:
    trace = Trace()
    enrichment: dict[str, Any] = {}
    text = await _trial_facts(row, fetcher, endpoints, trace, enrichment)
    if text or enrichment:
        return EntryTextResult(status="available", text_kind="excerpt" if text else "none",
                               body_excerpt=clip_excerpt(text) if text else None, enrichment=enrichment,
                               notes=trace.notes)
    if trace.transient:
        return EntryTextResult(status="pending", retry_after_s=RETRY_TRANSIENT_S, notes=trace.notes)
    return EntryTextResult(status="unavailable", notes=trace.notes)


async def _page(row: dict, fetcher: Any, endpoints: Endpoints) -> EntryTextResult:
    trace = Trace()
    enrichment: dict[str, Any] = {}
    await _trial_facts(row, fetcher, endpoints, trace, enrichment)
    summary = row.get("summary")
    if summary_is_full_text(summary):
        excerpt = clip_excerpt(summary)
        return EntryTextResult(status="available", text_kind="full" if excerpt == summary else "excerpt",
                               body_excerpt=excerpt, enrichment=enrichment, notes=trace.notes + ["feed_text"])
    url = row.get("url")
    if not url:
        return EntryTextResult(status="unavailable", enrichment=enrichment, notes=trace.notes + ["no_url"])
    excerpt, attempt = await page_excerpt(fetcher, url, source_id=row.get("source_id"),
                                          egress=row.get("source_egress") or "direct", trace=trace)
    if excerpt:
        return EntryTextResult(status="available", text_kind="excerpt", body_excerpt=excerpt, fetched_from="page",
                               fetched_at=attempt.result.fetched_at if attempt.result else None,
                               enrichment=enrichment, notes=trace.notes)
    if attempt.transient:
        return EntryTextResult(status="pending", enrichment=enrichment, retry_after_s=RETRY_TRANSIENT_S,
                               notes=trace.notes)
    return EntryTextResult(status="available" if enrichment else "unavailable", enrichment=enrichment,
                           notes=trace.notes)


def is_journal_like(row: dict) -> bool:
    """In scope of the text rule: a journal read method, or an entry that carries a DOI or PMID."""
    return row.get("source_access") in ARTICLE_ACCESS or bool(row.get("doi") or row.get("pmid"))


def _as_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def apply_text_rule(row: dict, result: EntryTextResult, now: datetime) -> EntryTextResult:
    """The text rule (module docstring) on one journal-like entry's result; other entries pass unchanged."""
    if not is_journal_like(row):
        return result
    if result.abstract or result.body_excerpt:
        return replace(result, status="available", retry_after_s=None)
    first_seen = _as_datetime(row.get("first_seen_at")) or now
    left = (first_seen + TEXT_HORIZON - now).total_seconds()
    if left <= 0:
        return replace(result, status="unavailable", text_kind="none", retry_after_s=None,
                       notes=result.notes + ["text_horizon_passed"])
    wanted = result.retry_after_s or RETRY_NOT_INDEXED_S
    return replace(result, status="pending", text_kind="none", retry_after_s=int(max(MIN_RETRY_S, min(wanted, left))))


def evimed_configured(settings: Any) -> bool:
    """The deployment gave the plugin an EviMed key file (the fetcher injects the key; we only look at the path)."""
    return bool(getattr(settings, "evimed_api_key_file", None))


async def evimed_extras(row: dict, result: EntryTextResult, fetcher: Any, endpoints: Endpoints) -> EntryTextResult:
    """Add impact factor / core-journal tags and the NMPA label excerpt to a final answer."""
    if result.status not in ("available", "unavailable"):
        return result
    enrichment = dict(result.enrichment)
    trace = Trace(notes=list(result.notes))
    if kind_of(row) == "article" and row.get("title") and "impact_factor" not in enrichment:
        journal = enrichment.get("journal") or (row.get("facts") or {}).get("journal")
        enrichment.update(await evimed_step.journal_facts(fetcher, endpoints, title=row["title"], journal=journal,
                                                          trace=trace))
    names = evimed_step.drug_mentions(row.get("title") or "", row.get("source_type"))
    if names and "drug_label_excerpt" not in enrichment:
        excerpt = await evimed_step.drug_label(fetcher, endpoints, names, trace)
        if excerpt:
            enrichment["drug_label_excerpt"] = excerpt
    status = result.status
    if status == "unavailable" and enrichment and not is_journal_like(row):
        status = "available"
    return replace(result, status=status, enrichment=enrichment, notes=trace.notes)


async def enrich_batch(entry_rows: list[dict], fetcher: Any, settings: Any, *,
                       now: datetime | None = None) -> list[EntryTextResult]:
    """Enrich several entries, sharing the PubMed and Europe PMC round trips (see module docstring)."""
    now = now or datetime.now(timezone.utc)
    endpoints = Endpoints.from_settings(settings)
    kinds = [kind_of(row) for row in entry_rows]
    articles = [row for row, kind in zip(entry_rows, kinds, strict=True) if kind == "article"]
    pubmed_trace = Trace()
    pubmed_records: dict = {}
    indexed = [row for row in articles if not is_preprint(row)]
    if indexed:
        pubmed_records = await pubmed_step.lookup(
            fetcher, endpoints, dois=[row["doi"] for row in indexed if row.get("doi") and not row.get("pmid")],
            pmids=[str(row["pmid"]) for row in indexed if row.get("pmid")], trace=pubmed_trace)
    need_epmc = []
    for row in articles:
        doi = (row.get("doi") or "").lower()
        record = pubmed_records.get(f"pmid:{row.get('pmid')}") or pubmed_records.get(f"doi:{doi}")
        if doi and (is_preprint(row) or not (record and record.get("abstract"))):
            need_epmc.append(doi)
    epmc_trace = Trace()
    epmc = await europepmc_step.by_dois(fetcher, endpoints, need_epmc, epmc_trace) if need_epmc else {}
    batch_trace = Trace(notes=pubmed_trace.notes + epmc_trace.notes,
                        transient=pubmed_trace.transient or epmc_trace.transient)
    results = []
    for row, kind in zip(entry_rows, kinds, strict=True):
        if kind == "article":
            results.append(await _article(row, fetcher, endpoints, pubmed_records, epmc, batch_trace))
        elif kind == "trial":
            results.append(await _trial(row, fetcher, endpoints))
        elif kind == "record":
            results.append(EntryTextResult(status="unavailable", notes=["record_is_the_text"]))
        else:
            results.append(await _page(row, fetcher, endpoints))
    finals = [apply_text_rule(row, result, now) for row, result in zip(entry_rows, results, strict=True)]
    if evimed_configured(settings):
        finals = [await evimed_extras(row, result, fetcher, endpoints) for row, result in zip(entry_rows, finals, strict=True)]
    return finals


async def enrich(entry_row: dict, fetcher: Any, settings: Any, *, now: datetime | None = None) -> EntryTextResult:
    """Enrich one entry (``enrich_batch`` of one)."""
    return (await enrich_batch([entry_row], fetcher, settings, now=now))[0]


__all__ = ["apply_text_rule", "enrich", "enrich_batch", "evimed_extras", "is_journal_like", "kind_of"]
