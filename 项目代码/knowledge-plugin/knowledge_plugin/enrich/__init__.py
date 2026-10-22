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
    The indexes first: PubMed by PMID/DOI with DOI realignment → Europe PMC when PubMed has no abstract (and for
    preprints, whose links to a published version only Europe PMC gives) → Crossref's own abstract → Elsevier's API
    (``elsevier.py``, a hook that asks nothing without a key) → Unpaywall's open-access status → OpenAlex
    (``openalex.py``: an abstract none of the others has, the PMC id, the open copy's licence) when there is still no
    abstract, or the work may be open and its PMC id is unknown. Then the publisher: the journal's own feeds
    (``feeds.py``, ``config.abstract_feed``) while there is no abstract, and its landing page (``landing.py``: the
    source's exit, then the relay, then the browser, a challenge being an answer) — on the first attempt and every
    ``LANDING_EVERY``-th after while there is no abstract, and once for an open, Creative-Commons-licensed work's
    whole text. The whole text of an open work comes from Europe PMC's ``fullTextXML`` when it has a PMC id
    (``fulltext.py``), else from a CC-licensed landing page; else the PDF stays ``enrichment.oa_pdf_url`` for the
    platform's parser. Trial facts for registry ids last. Status by the text rule below.

    What answers: ``text_kind`` ``full`` (``body_text``, ``## `` section titles, the excerpt its first 12,000
    characters; ``fetched_from`` ``europepmc-fulltext`` or ``landing``), else ``abstract`` (``fetched_from`` the index
    or ``openalex``, ``publisher-feed``, ``landing``), else ``excerpt`` (a feed's teaser or a page's standfirst).
    The per-entry steps of a batch run ``ENTRY_CONCURRENCY`` at a time inside ``BATCH_DEADLINE_S``: a landing read
    that cannot finish in time is not started, and the entry is asked again within the hour.

    **A provisional text is upgraded.** A journal feed's teaser or summary (``publisher-feed``) and a page's standfirst
    (an ``excerpt``) answer at once — the platform publishes with them — but are not the abstract PubMed gives a
    research article days later (JAMA's feed summary: 200–300 characters; the abstract: ~2,500). Such an answer keeps
    a 12-hour ``retry_after_s``; the text worker asks the entry again (``store.claim_texts``, the row marked
    ``upgrade``) until ``TEXT_HORIZON``, with the indexes only (PubMed, Europe PMC, Crossref, OpenAlex), and an abstract
    they give is stored and the entry delivered again as its next revision, so the platform reads it.
``trial`` (a ClinicalTrials.gov entry)
    Phase, status, enrollment, sponsor and the detailed description from the registry.
``page`` (news, regulators, societies, feeds, lists)
    The feed's own text when it is already the full, uncut text; else the main text of the
    entry's page (``page.py``), plus trial facts when the entry names a registered trial.
    Challenge pages, robots refusals, PDFs and 404s are final (``unavailable``); timeouts, 5xx,
    429 and the plugin's own budget are transient (``pending``). A WeChat article's page is never
    read (robots.txt refuses mp.weixin.qq.com): its text is bought through Dajiala by the text
    worker (``social.wechat``), and an enricher handed one anyway answers ``unavailable``.
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

**The text rule for journal and preprint entries** (controller ruling, 2026-09-22; horizon 14 days since 2026-10-22):
an entry from a journal read method (``crossref-issn``, ``eutils-query``, ``europepmc``) or carrying a DOI or PMID is
``available`` as soon as an abstract or an excerpt exists; until then it is ``pending`` — with whatever enrichment was
found (publication types, open access …) and a retry delay of 12 hours (PubMed indexes most articles within two
weeks: journal text coverage measured 55–63 % in the first week, 78–80 % after two) — for up to ``TEXT_HORIZON`` from
``first_seen_at``, and ``unavailable`` (enrichment kept) after that. The plugin does not bump an entry's revision when
its text arrives, so answering ``available`` without an abstract would let the platform publish a title-only item that
is never re-edited once PubMed indexes the abstract (77 % of 0–1-day-old articles are not in PubMed yet, plan 10.1).
``now`` is the clock the horizon is measured against (the current time when omitted; tests pass it).

Every enrichment value is deterministic data from the named upstream; the plugin makes no model
call here (contract rule 8).
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from ..adapters.common import registry_ids
from ..adapters.json_api import family_for
from ..model import EntryTextResult
from ..social.wechat import is_article as is_wechat_article
from . import crossref as crossref_step
from . import elsevier as elsevier_step
from . import europepmc as europepmc_step
from . import evimed as evimed_step
from . import feeds as feeds_step
from . import fulltext as fulltext_step
from . import landing as landing_step
from . import openalex as openalex_step
from . import pubmed as pubmed_step
from . import trials as trials_step
from . import unpaywall as unpaywall_step
from .article_html import fit_body, same_text
from .common import Endpoints, Trace
from .page import clip_excerpt, page_excerpt, summary_is_full_text

RETRY_NOT_INDEXED_S = 12 * 3600
INDEX_SOURCES = frozenset({"pubmed", "europepmc", "crossref", "openalex", "elsevier", "europepmc-fulltext"})
RETRY_TRANSIENT_S = 3600
TEXT_HORIZON = timedelta(days=14)
MIN_RETRY_S = 60
LANDING_EVERY = 4                 # attempts: the first, then about every two days at the 12-hour cadence
ENTRY_CONCURRENCY = 4
BATCH_DEADLINE_S = 300.0          # the scheduler gives a batch 360 s (``ENRICH_TIMEOUT_S * 2``)
OPEN_STATUSES = frozenset({"gold", "green", "bronze", "unknown"})     # not known to be closed
# Read by the tests: the clock the batch deadline is measured on.
monotonic: Callable[[], float] = time.monotonic

ARTICLE_ACCESS = frozenset({"crossref-issn", "eutils-query", "europepmc"})
ARTICLE_FAMILIES = frozenset({"crossref-works", "biorxiv", "arxiv"})
RECORD_FAMILIES = frozenset({"openfda-enforcement", "openfda-shortages", "openfda-drugsfda", "openfda-event",
                             "medhelm", "prepare-registry", "star-rating"})
RECORD_ACCESS = frozenset({"evimed-api"})
# bioRxiv/medRxiv (10.1101, and 10.64898 since 2026), arXiv (DataCite 10.48550), Research Square,
# Preprints.org, SSRN: PubMed does not index these; Europe PMC does.
PREPRINT_DOI_PREFIXES = ("10.1101/", "10.64898/", "10.48550/", "10.21203/", "10.20944/", "10.2139/")
SUMMARY_TEXT_SOURCE = {"eutils-query": "pubmed", "europepmc": "europepmc", "crossref-issn": "crossref"}
# OpenAlex's oa_status in the contract's vocabulary (Unpaywall's own mapping: hybrid and diamond read as gold).
OPENALEX_OA_STATUS = {"gold": "gold", "diamond": "gold", "hybrid": "gold", "green": "green", "bronze": "bronze",
                      "closed": "closed"}


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


def is_cc(license_: str | None) -> bool:
    """A Creative Commons (or public-domain) licence, in any of the forms the sources write it."""
    value = (license_ or "").strip().lower()
    return value.startswith(("cc-", "cc ", "cc0", "cc_")) or value == "cc" or "creativecommons.org" in value \
        or value in ("public-domain", "pd")


@dataclass
class _Found:
    """What one article's steps found so far (``_article``)."""

    abstract: str | None = None
    abstract_from: str | None = None
    fetched_at: datetime | None = None
    excerpt: str | None = None
    excerpt_from: str | None = None
    body: str | None = None
    body_from: str | None = None
    pmcid: str | None = None
    licenses: list[str] = field(default_factory=list)

    def take_abstract(self, text: str | None, source: str, at: datetime | None = None) -> None:
        if text and not self.abstract:
            self.abstract, self.abstract_from, self.fetched_at = text, source, at

    def take_structure(self, text: str | None, source: str) -> None:
        """The same abstract with its sections (a feed's summary is stored as one line; the page keeps the headings)."""
        if text and self.abstract and "\n" not in self.abstract and "\n" in text and same_text(self.abstract, text):
            self.abstract, self.abstract_from = text, source

    def take_excerpt(self, text: str | None, source: str) -> None:
        if text and len(text) > len(self.excerpt or ""):
            self.excerpt, self.excerpt_from = text, source

    @property
    def cc(self) -> bool:
        return any(is_cc(value) for value in self.licenses)


async def _article(row: dict, fetcher: Any, endpoints: Endpoints, pubmed_records: dict, epmc: dict,
                   batch_trace: Trace, *, settings: Any = None, deadline: float | None = None) -> EntryTextResult:
    trace = Trace(notes=list(batch_trace.notes), transient=batch_trace.transient)
    doi, pmid = (row.get("doi") or "").lower() or None, row.get("pmid")
    preprint = is_preprint(row)
    upgrade = bool(row.get("upgrade"))     # a provisional text is there: the indexes only (module docstring)
    enrichment: dict[str, Any] = {}
    found = _Found()
    known = False
    record = pubmed_records.get(f"pmid:{pmid}") if pmid else None
    record = record or (pubmed_records.get(f"doi:{doi}") if doi else None)
    if record:
        known = True
        enrichment.update(pubmed_step.record_enrichment(record))
        found.take_abstract(record.get("abstract"), "pubmed", record.get("fetched_at"))
        found.pmcid = record.get("pmcid")
    result = epmc.get(doi) if doi else None
    if result:
        known = True
        epmc_abstract, epmc_enrichment = europepmc_step.result_enrichment(result)
        _merge(enrichment, epmc_enrichment)
        found.take_abstract(epmc_abstract, "europepmc", result.get("fetched_at"))
        found.pmcid = found.pmcid or europepmc_step.result_pmcid(result)
        if result.get("isOpenAccess") == "Y" and result.get("license"):
            found.licenses.append(str(result["license"]))
        for kind, source, record_id in europepmc_step.preprint_links(result)[:1]:
            linked = await europepmc_step.resolve_doi(fetcher, endpoints, source, record_id, trace)
            if linked and linked != doi:
                enrichment["published_version_doi" if kind.lower() == "preprint of" else "preprint_of_doi"] = linked
    if not found.abstract and row.get("summary"):
        family = _family(row)
        source_text = SUMMARY_TEXT_SOURCE.get(row.get("source_access")) or \
            {"crossref-works": "crossref", "biorxiv": None, "arxiv": None}.get(family or "", "unset")
        if source_text != "unset":
            found.abstract, found.abstract_from = row["summary"], source_text
    if not found.abstract and doi and not preprint and not upgrade:
        crossref_abstract, journal, crossref_at = await crossref_step.abstract_for(fetcher, endpoints, doi, trace)
        found.take_abstract(crossref_abstract, "crossref", crossref_at)
        if journal:
            enrichment.setdefault("journal", journal)
    if not found.abstract and doi and not preprint:
        found.take_abstract(await elsevier_step.abstract_for(fetcher, endpoints, doi, trace, settings), "elsevier")
    if doi and not doi.startswith("10.48550/") and (found.abstract or known) and not upgrade:
        oa_enrichment, location = await unpaywall_step.open_access_details(fetcher, endpoints, doi, trace)
        enrichment.update(oa_enrichment)
        if location.get("license"):
            found.licenses.append(location["license"])
    open_status = enrichment.get("open_access", "unknown")
    if upgrade and doi and not preprint and not found.abstract:
        work = await openalex_step.work_for(fetcher, endpoints, doi, trace)
        found.take_abstract(work.abstract if work else None, "openalex")
    if upgrade:
        # A provisional text is there already (module docstring): only an index's abstract replaces it.
        if found.abstract and found.abstract_from in INDEX_SOURCES:
            return EntryTextResult(status="available", text_kind="abstract", abstract=found.abstract,
                                   fetched_from=found.abstract_from, fetched_at=found.fetched_at, enrichment=enrichment,
                                   notes=trace.notes + ["upgraded"])
        return EntryTextResult(status="available", enrichment=enrichment, retry_after_s=RETRY_NOT_INDEXED_S,
                               notes=trace.notes + ["upgrade_not_yet"])
    if doi and not preprint and (not found.abstract or (not found.pmcid and open_status in OPEN_STATUSES)):
        work = await openalex_step.work_for(fetcher, endpoints, doi, trace)
        if work is not None:
            found.take_abstract(work.abstract, "openalex")
            found.pmcid = found.pmcid or work.pmcid
            if work.license:
                found.licenses.append(work.license)
            if work.pdf_url and "oa_pdf_url" not in enrichment:
                enrichment["oa_pdf_url"] = work.pdf_url
            status = OPENALEX_OA_STATUS.get(work.oa_status or "")
            if status and enrichment.get("open_access", "unknown") == "unknown":
                enrichment["open_access"] = status
    if not found.abstract and doi and not preprint:
        feed = await feeds_step.feed_text(fetcher, row, doi, trace)
        if feed is not None:
            kind, text = feed
            if kind == "abstract":
                found.take_abstract(text, "publisher-feed")
            else:
                found.take_excerpt(text, "publisher-feed")
    # Europe PMC answers fullTextXML for its open-access subset only (404 otherwise), so a PMC id is asked unless the
    # work is known to be closed.
    if found.pmcid and enrichment.get("open_access") != "closed" and not preprint:
        jats_abstract, body = await fulltext_step.europepmc_fulltext(fetcher, endpoints, found.pmcid, trace)
        found.take_abstract(jats_abstract, "europepmc-fulltext")
        if body:
            found.body, found.body_from = body, "europepmc-fulltext"
    landing_due = not found.abstract and int(row.get("attempts") or 0) % LANDING_EVERY == 0
    # An open work's whole text: its page says its licence when no index knows the work yet (a paper published today
    # is in none of them, and its answer is final once an abstract is found). Without an abstract the page waits for
    # its turn (``landing_due``); its whole text, when open, comes with that read.
    wants_body = found.body is None and (found.cc or (bool(found.abstract)
                                                      and enrichment.get("open_access", "unknown") in ("gold", "unknown")))
    if doi and not preprint and (landing_due or wants_body):
        read = await landing_step.read_landing(fetcher, endpoints, doi, egress=row.get("source_egress") or "direct",
                                               trace=trace, source_id=row.get("source_id"), deadline=deadline,
                                               clock=lambda: monotonic())
        if read.outcome == "deferred" and not found.abstract:
            trace.transient = True                # not tried for lack of time: asked again within the hour
        page = read.page
        if page is not None:
            found.take_abstract(page.abstract, "landing")
            found.take_structure(page.abstract, "landing")
            found.take_excerpt(page.excerpt, "landing")
            if page.license_url:
                found.licenses.append(page.license_url)
            if page.body_text and found.body is None and found.cc:
                found.body, found.body_from = page.body_text, "landing"
    await _trial_facts(row, fetcher, endpoints, trace, enrichment)
    if found.body:
        # Over the contract's 40,000 characters the captions go first; a text still longer is its first part, told as
        # an excerpt (``text_kind`` full means the article's whole text).
        body, whole = fit_body(found.body)
        return EntryTextResult(status="available", text_kind="full" if whole else "excerpt", abstract=found.abstract,
                               body_text=body, body_excerpt=clip_excerpt(body), fetched_from=found.body_from,
                               fetched_at=found.fetched_at, enrichment=enrichment,
                               notes=trace.notes + ([] if whole else ["full_text_over_limit"]))
    provisional = RETRY_NOT_INDEXED_S if not preprint and doi else None     # asked again for an index's abstract
    if found.abstract:
        return EntryTextResult(status="available", text_kind="abstract", abstract=found.abstract,
                               fetched_from=found.abstract_from, fetched_at=found.fetched_at, enrichment=enrichment,
                               notes=trace.notes,
                               retry_after_s=provisional if found.abstract_from == "publisher-feed" else None)
    if found.excerpt:
        return EntryTextResult(status="available", text_kind="excerpt", body_excerpt=clip_excerpt(found.excerpt),
                               fetched_from=found.excerpt_from, enrichment=enrichment, notes=trace.notes,
                               retry_after_s=provisional)
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

    def feed_text() -> EntryTextResult:
        # The entry's summary is the whole text, but stored as one line (its paragraphs are folded before hashing), so
        # it is the answer only when the page itself gives none (2026-10-22: it used to be read before the page).
        excerpt = clip_excerpt(summary)
        return EntryTextResult(status="available", text_kind="full" if excerpt == summary else "excerpt",
                               body_excerpt=excerpt, body_text=summary, enrichment=enrichment,
                               notes=trace.notes + ["feed_text"])

    url = row.get("url")
    if not url:
        if summary_is_full_text(summary):
            return feed_text()
        return EntryTextResult(status="unavailable", enrichment=enrichment, notes=trace.notes + ["no_url"])
    if is_wechat_article(url):
        return EntryTextResult(status="available" if enrichment else "unavailable", enrichment=enrichment,
                               notes=trace.notes + ["wechat_page_not_read"])
    text, attempt = await page_excerpt(fetcher, url, source_id=row.get("source_id"),
                                       egress=row.get("source_egress") or "direct", trace=trace)
    if not text and summary_is_full_text(summary):
        return feed_text()
    if text:
        return EntryTextResult(status="available", text_kind="excerpt", body_excerpt=clip_excerpt(text), body_text=text,
                               fetched_from="page",
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
    """The text rule (module docstring) on one journal-like entry's result; other entries pass unchanged. An available
    answer keeps a ``retry_after_s`` only when it is provisional and the horizon is not reached (the upgrade)."""
    if not is_journal_like(row):
        return result
    first_seen = _as_datetime(row.get("first_seen_at")) or now
    left = (first_seen + TEXT_HORIZON - now).total_seconds()
    if result.abstract or result.body_excerpt or (row.get("upgrade") and result.status == "available"):
        upgrade_in = int(max(MIN_RETRY_S, min(result.retry_after_s, left))) if result.retry_after_s and left > 0 else None
        return replace(result, status="available", retry_after_s=upgrade_in)
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
    """Enrich several entries, sharing the PubMed and Europe PMC round trips (see module docstring); the per-entry
    steps run ``ENTRY_CONCURRENCY`` at a time within ``BATCH_DEADLINE_S``."""
    now = now or datetime.now(timezone.utc)
    deadline = monotonic() + BATCH_DEADLINE_S
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
    gate = asyncio.Semaphore(ENTRY_CONCURRENCY)

    async def one(row: dict, kind: str) -> EntryTextResult:
        async with gate:
            if kind == "article":
                return await _article(row, fetcher, endpoints, pubmed_records, epmc, batch_trace, settings=settings,
                                      deadline=deadline)
            if kind == "trial":
                return await _trial(row, fetcher, endpoints)
            if kind == "record":
                return EntryTextResult(status="unavailable", notes=["record_is_the_text"])
            return await _page(row, fetcher, endpoints)

    results = await asyncio.gather(*(one(row, kind) for row, kind in zip(entry_rows, kinds, strict=True)))
    finals = [apply_text_rule(row, result, now) for row, result in zip(entry_rows, results, strict=True)]
    if evimed_configured(settings):
        finals = [await evimed_extras(row, result, fetcher, endpoints) for row, result in zip(entry_rows, finals, strict=True)]
    return finals


async def enrich(entry_row: dict, fetcher: Any, settings: Any, *, now: datetime | None = None) -> EntryTextResult:
    """Enrich one entry (``enrich_batch`` of one)."""
    return (await enrich_batch([entry_row], fetcher, settings, now=now))[0]


__all__ = ["apply_text_rule", "enrich", "enrich_batch", "evimed_extras", "is_journal_like", "kind_of"]
