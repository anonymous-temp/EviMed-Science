"""The shared vocabulary and the reader interfaces of the knowledge-source plugin.

Everything another module needs to agree on lives here, once: the closed vocabularies of the HTTP
contract (``contract/knowledge-plugin-openapi.yaml`` v1.1.0, whose enums these tuples copy value
for value), the whitelists that decide which adapter facts and enrichment fields exist past the
adapter (contract rule 4), and the dataclasses that pass between the scheduler, the protected
fetch, the adapters (package P2) and the store.

Hidden knowledge worth keeping next to the types:

- ``SourceState.last_ok_at`` doubles as the incremental-window signal. Adapters that read a
  rolling window compute ``since`` from it (``urltemplate.window_since``: last success minus a
  one-day overlap, never further back than the source's look-back). The scheduler asks for the
  daily 7-day full rescan (plan 10.2.2 "每天一次 7 天全扫补漏") by handing the adapter a state whose
  ``last_ok_at`` is ``None`` — the same state a source has on first contact — so no adapter needs
  to know that rescans exist.
- ``RequestSpec.api`` is the robots switch: an open API (Crossref, E-utilities, openFDA, …) is read
  under its provider's published rules and never consults robots.txt — E-utilities' own
  robots.txt says ``Disallow: /`` (plan 6.1, review finding 13 #2).
- Adapters never put credentials or the contact address into a URL. The fetcher injects them per
  host (NCBI ``tool``/``email``/``api_key``, openFDA ``api_key``, Unpaywall ``email``) so that
  secrets stay in one module and every logged URL can be redacted in one place.
- ``NormalizedEntry.identity_hint`` is how registry and database sources get event-level identity
  (plan 10.3.3): ``reg:<id>:<event>:<YYYY-MM-DD>`` for trial registries, ``fda:<application>:
  <supplement>`` for Drugs@FDA, ``wx:<biz>:<mid>:<idx>`` for WeChat. A key that stopped at the
  registry number would fold "results posted" into the years-old "registered" item.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol, runtime_checkable

CONTRACT_VERSION = "1.1.0"   # 1.1.0 (2026-09-22): EntryText.enrichment.affiliation_countries
PLUGIN_NAME = "evimed-knowledge-plugin"

# ---------------------------------------------------------------------------------------------
# Contract vocabularies (normative: equal to the enums of the contract YAML; a test compares them)
# ---------------------------------------------------------------------------------------------

LANES = ("evidence", "guideline", "regulatory", "safety", "pipeline", "public-health", "research", "ai", "mixed")
SOURCE_TYPES = ("journal", "regulator", "evidence-body", "preprint", "company", "media")
EGRESSES = ("direct", "browser", "relay", "bridge", "api")
ACCESSES = (
    "crossref-issn", "eutils-query", "europepmc", "json-api", "rss", "atom", "html-list",
    "browser-list", "relay", "wechat-bridge", "evimed-api",
)
LAUNCH_TIERS = ("P0", "P1", "P2")
HEALTH_STATES = ("new", "healthy", "degraded", "unreadable", "drifted", "disabled")
DATE_PRECISIONS = ("instant", "day", "inferred")
DEFECTS = (
    "no-date", "future-date", "truncated-summary", "short-summary", "no-summary", "encoding",
    "link-derived", "oversize-truncated",
)
# Entry.text_status as delivered. The table also stores 'unavailable' (enrichment gave up); the
# contract's Entry enum has no such value, so it is delivered as 'none' ("no text now").
ENTRY_TEXT_STATUSES = ("none", "pending", "available")
TEXT_STATUSES = ("available", "pending", "unavailable")          # EntryText.status
TEXT_KINDS = ("abstract", "excerpt", "full", "none")
FETCHED_FROM = ("pubmed", "europepmc", "crossref", "page", "browser", "relay", "evimed-api", "wechat")
OPEN_ACCESS = ("gold", "green", "bronze", "closed", "unknown")
TRIAL_EVENTS = ("registered", "results-posted", "terminated", "suspended", "updated")
ERROR_CODES = (
    "unauthorized", "not_found", "invalid_cursor", "invalid_params", "capability_unavailable",
    "upstream_unavailable", "rate_limited", "internal",
)

# The fetches.outcome vocabulary (plugin schema CHECK constraint). What each one means:
#   ok            200 with a body the adapter parsed (zero entries is 'empty', recorded by the scheduler)
#   not-modified  304, or a 200 whose body hash equals the last one (not parsed again)
#   empty         a 200/204 without a body, or a body that parsed to zero entries
#   challenge     a bot wall: Cloudflare / Ruishu 412-202 script page / WAF marker / empty shell page
#   blocked       refused before or by the server: 401/403/451, a private address, an egress this
#                 build does not have, a host outside the source's allowed_hosts
#   timeout       no complete answer within the host's timeout
#   http-error    any other failure: 4xx/5xx, 429 (which also pauses the host), connect/DNS errors
#   parse-error   the adapter could not read a 200 body
#   robots-denied robots.txt disallows the page (API requests never ask)
#   host-budget   the plugin's own budget refused to send: daily cap spent or the host is paused
#   too-large     the body passed the 16 MiB cap and the transfer was aborted
FETCH_OUTCOMES = (
    "ok", "not-modified", "empty", "challenge", "blocked", "timeout", "http-error", "parse-error",
    "robots-denied", "host-budget", "too-large",
)
# Outcomes that say nothing about the source itself: the plugin chose not to send the request.
NEUTRAL_OUTCOMES = frozenset({"host-budget"})
SUCCESS_OUTCOMES = frozenset({"ok", "not-modified", "empty"})

# Batch 1 (plan 14.6): the read methods and exits the first release implemented.
BATCH1_ACCESSES = frozenset({"crossref-issn", "eutils-query", "europepmc", "json-api", "rss", "atom", "html-list"})
BATCH1_EGRESSES = frozenset({"direct", "api"})
# What this build implements (batch 2 adds the Tokyo relay, the headless browser and the team's
# EviMed API scans). An enabled source outside these sets fails the registry load test; a source an
# operator enables anyway is refused by name (egress_unavailable / adapter_unavailable), never guessed.
IMPLEMENTED_ACCESSES = BATCH1_ACCESSES | {"browser-list", "evimed-api"}
IMPLEMENTED_EGRESSES = BATCH1_EGRESSES | {"relay", "browser"}
# Refusals that are about this deployment, not about the source: the scheduler reschedules them
# without counting a failure (a missing exit or key must not turn 60 sources "unreadable").
NEUTRAL_DETAILS = {
    "adapter_unavailable": 3600,
    "egress_unavailable": 3600,
    "edge_proxy_unreachable": 600,
    "edge_proxy_refused": 600,
    "browser_unreachable": 600,
    "evimed_api_key_unconfigured": 3600,
    "evimed_unauthorized": 3600,   # the EviMed API refused the key: HTTP 200 {"code": 401} (P2, measured)
}

# Contract rule 4: Entry.facts keys and their JSON types. Anything else never leaves the adapter.
FACT_TYPES: dict[str, type] = {
    "crossref_type": str,
    "update_to": list,            # [{type, doi, date}] — each item filtered to those three string keys
    "author_count": int,
    "journal": str,
    "issn": str,
    "trial_phase": str,
    "trial_status": str,
    "trial_event": str,           # one of TRIAL_EVENTS
    "sponsor": str,
    "recall_class": str,
    "fda_application": str,
    "fda_supplement": str,
    "wx_biz": str,
    "wx_author": str,
    "wx_original": bool,
    "is_correction_notice": bool,
    "is_masthead": bool,
}
UPDATE_TO_KEYS = ("type", "doi", "date")

# EntryText.enrichment keys and their JSON types (the contract leaves the object open for additive
# growth, but rule 4 applies to it as much as to facts, so the plugin whitelists it too).
ENRICHMENT_TYPES: dict[str, type] = {
    "publication_types": list,
    "mesh": list,
    "journal": str,
    "authors_short": str,
    "open_access": str,           # one of OPEN_ACCESS
    "oa_pdf_url": str,            # absolute http(s) URI
    "impact_factor": float,
    "core_journal_tags": list,
    "preprint_of_doi": str,
    "published_version_doi": str,
    "trial_facts": dict,          # {phase: str, status: str, enrollment: int, sponsor: str}
    "drug_label_excerpt": str,
    "affiliation_countries": list,  # ISO 3166-1 alpha-2, upper case, de-duplicated (contract 1.1.0)
}
TRIAL_FACT_TYPES: dict[str, type] = {"phase": str, "status": str, "enrollment": int, "sponsor": str}

# Bounds the contract states or implies.
TITLE_MAX = 1000
SUMMARY_MAX = 20_000
URL_MAX = 2048
EXTERNAL_KEY_MAX = 512
BODY_EXCERPT_MAX = 20_000
SOURCE_ID_MAX = 120
SHORT_SUMMARY_MIN = 80
ENTRIES_PAGE_MAX = 500
SOURCES_PAGE_MAX = 1000


# ---------------------------------------------------------------------------------------------
# The reader interface (SPEC A.1, normative)
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class SourceConfig:
    """One runtime-registry row (``registry/sources.json``), as the scheduler hands it to an adapter.

    ``config`` is the adapter's own configuration: ``url`` (a template with ``{since}``,
    ``{until}``, ``{today}``, ``{cursor}``, ``{issn}`` … placeholders — never a literal date),
    ``params``, ``selectors`` ``{item, title, link, date, summary}``, ``date_field``,
    ``id_field``, ``allowed_hosts``, ``page_size``, ``max_pages``, ``date_format``,
    ``link_template``, ``family`` (json-api), ``lookback_days``/``overlap_days`` (windows).
    """

    id: str
    name: str
    homepage: str | None
    lane: str
    source_type: str
    access: str
    egress: str
    authority: int
    safety_feed: bool
    owner_entity: str
    launch_tier: str
    language: str | None
    region: str | None
    poll_floor_s: int
    poll_ceiling_s: int
    config: dict


@dataclass
class SourceState:
    """What the scheduler knows about a source when it plans a poll.

    ``last_ok_at`` is ``None`` on first contact and whenever the scheduler wants the full look-back
    window (the daily rescan of incremental queries); see the module docstring. ``cursor`` is
    adapter-private and survives between polls (the value of ``ParseOutput.cursor`` of the last
    successful poll).
    """

    etag: str | None
    last_modified: str | None
    last_content_sha256: str | None
    last_ok_at: datetime | None
    first_contact_at: datetime | None
    cursor: dict


@dataclass(frozen=True)
class RequestSpec:
    """One HTTP request an adapter wants made.

    ``conditional`` lets the scheduler attach the source's stored ``If-None-Match`` /
    ``If-Modified-Since`` validators (only to the first request of a poll, and only when its URL is
    the one the validators came from). ``api`` marks an open API: robots.txt is not consulted.
    """

    url: str
    method: str = "GET"
    headers: dict = field(default_factory=dict)
    body: bytes | None = None
    conditional: bool = True
    api: bool = False


@dataclass(frozen=True)
class FetchResult:
    """A completed HTTP exchange. ``headers`` keys are lower-case; ``body`` is at most 16 MiB."""

    request: RequestSpec
    final_url: str
    status: int
    headers: dict
    body: bytes
    fetched_at: datetime
    not_modified: bool = False


@dataclass
class NormalizedEntry:
    """What an adapter emits; ``normalize.py`` finishes it (identity, defects, whitelist, hash).

    ``date_precision``: ``instant`` (a timestamp with a time of day), ``day`` (a calendar date the
    source gave without a time) or ``inferred`` (set by normalisation, never by an adapter).
    ``facts`` may only carry ``FACT_TYPES`` keys; others are dropped and counted.
    ``identity_hint``: the event-level key for registries and databases (see module docstring).
    """

    external_key: str
    url: str
    title: str
    summary: str | None = None
    published_at: datetime | None = None
    date_precision: str = "instant"
    language: str = "und"
    doi: str | None = None
    pmid: str | None = None
    registry_ids: list[str] = field(default_factory=list)
    lane_hint: str | None = None
    facts: dict = field(default_factory=dict)
    defects: list[str] = field(default_factory=list)
    identity_hint: str | None = None


@dataclass
class ParseOutput:
    """An adapter's reading of one response.

    ``next`` asks for another request within the same poll (pagination; the scheduler stops at the
    source's ``max_pages``). ``cursor`` replaces the stored adapter cursor when the poll succeeds
    (``None`` keeps the old one). ``notes`` are short machine-readable remarks (logged, counted).
    """

    entries: list[NormalizedEntry]
    next: RequestSpec | None = None
    cursor: dict | None = None
    notes: list[str] = field(default_factory=list)


@dataclass
class EntryTextResult:
    """What ``knowledge_plugin.enrich.enrich`` returns for one entry (package P2 implements it).

    ``status``: ``available`` (something to show: an abstract, an excerpt or enrichment facts),
    ``pending`` (try again later: PubMed has not indexed it yet, a page was temporarily
    unreadable) or ``unavailable`` (nothing will come). ``retry_after_s`` lets a pending result
    suggest its own retry delay; the text worker bounds it (12 h cadence, 5-day horizon).
    ``enrichment`` may only carry ``ENRICHMENT_TYPES`` keys.
    """

    status: str
    text_kind: str = "none"
    abstract: str | None = None
    body_excerpt: str | None = None
    fetched_from: str | None = None
    fetched_at: datetime | None = None
    enrichment: dict = field(default_factory=dict)
    retry_after_s: int | None = None
    notes: list[str] = field(default_factory=list)


class FetchError(Exception):
    """A request that did not produce a usable response, classified into ``FETCH_OUTCOMES``.

    ``detail`` is a short snake_case reason (``private_address``, ``egress_unavailable``,
    ``http_404``, ``cloudflare`` …) and never contains a URL query, a key or the contact address.
    ``retry_after_s`` is set when the upstream said when to come back (429/503 ``Retry-After``).
    """

    def __init__(self, outcome: str, detail: str, *, status: int | None = None,
                 retry_after_s: float | None = None, final_url: str | None = None,
                 bytes_read: int = 0) -> None:
        if outcome not in FETCH_OUTCOMES:
            raise ValueError(f"unknown fetch outcome: {outcome}")
        super().__init__(f"{outcome}: {detail}")
        self.outcome = outcome
        self.detail = detail[:200]
        self.status = status
        self.retry_after_s = retry_after_s
        self.final_url = final_url
        self.bytes_read = bytes_read


@runtime_checkable
class Fetcher(Protocol):
    """The protected fetch (``knowledge_plugin.fetch.ProtectedFetcher``).

    Honours per-host budgets, robots.txt for non-API page requests, DNS pinning and the address
    policy; raises ``FetchError``. ``source_id`` is used for accounting and the source's
    ``allowed_hosts``; enrichment requests pass the entry's source id.
    """

    async def fetch(self, spec: RequestSpec, *, source_id: str | None = None, egress: str = "direct") -> FetchResult: ...


class Enricher(Protocol):
    """``knowledge_plugin.enrich`` exposes ``async def enrich(entry_row, fetcher, settings)``.

    ``entry_row`` is the stored entry joined with its source: keys ``entry_id``, ``revision``,
    ``source_id``, ``external_key``, ``identity_key``, ``url``, ``canonical_url``, ``doi``,
    ``pmid``, ``registry_ids``, ``title``, ``summary``, ``lang``, ``published_at``, ``facts``,
    ``first_seen_at``, and the source's ``source_access``, ``source_egress``, ``source_type``,
    ``source_config``, plus ``attempts`` (how many enrichment attempts came before this one).
    """

    async def __call__(self, entry_row: dict[str, Any], fetcher: Fetcher, settings: Any) -> EntryTextResult: ...
