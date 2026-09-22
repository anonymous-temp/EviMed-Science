"""The HTTP face: ``contract/knowledge-plugin-openapi.yaml`` (v1.1.0), served exactly.

Rules the handlers keep:

- **Auth.** Every path except ``/v1/health`` needs ``Authorization: Bearer <token>``; the token is
  the content of ``KNOWLEDGE_PLUGIN_TOKEN_FILE``, re-read when the file changes (rotation without a
  restart) and compared in constant time. No token file → every request is refused (fail closed).
- **Errors** are the contract's ``Error`` object ``{code, message, retryable, details?}`` with its
  closed code list; a bad ``after`` is ``400 invalid_cursor``, any other bad parameter ``400
  invalid_params`` naming the field. FastAPI's own 422 and HTML-ish 404/405 never leak out.
- **The stream** is ``seq > after`` ascending, at most 500 per page, ``has_more`` when another page
  exists, ``next_after`` the last delivered seq (``after`` itself on an empty page). Backfill rows
  are skipped unless ``include_backfill=true``. An ``after`` below ``oldest_seq_available`` still
  answers from the oldest retained entry — the consumer detects the gap from the manifest.
- **Shapes.** Optional-but-not-nullable fields (``homepage``, ``lane_hint``, ``text_kind`` …) are
  omitted when unknown, nullable ones are ``null``; ``facts`` and ``enrichment`` are whitelisted
  again at serialisation (contract rule 4), so a bad row in the database cannot leak a field.
- ``/text`` answers from the stored text, or schedules enrichment and says ``pending`` with
  ``next_attempt_at``; asking marks ``text_requested_at`` (retention 90 days instead of 30).
- ``/v1/lookups`` lists nothing in batch 1 and every ``POST`` is ``501 capability_unavailable``.
"""

from __future__ import annotations

import hmac
import logging
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, ClassVar, Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_serializer
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .db import meta_get
from .model import (
    CONTRACT_VERSION, DATE_PRECISIONS, DEFECTS, EGRESSES, ENRICHMENT_TYPES, ENTRIES_PAGE_MAX, FACT_TYPES,
    FETCHED_FROM, HEALTH_STATES, LANES, LAUNCH_TIERS, PLUGIN_NAME, SOURCES_PAGE_MAX, SUMMARY_MAX,
)
from .normalize import whitelist_facts
from .settings import Settings, read_secret_file
from .store import ENTRY_COLUMNS, entry_row, schedule_text, text_row, whitelist_enrichment

log = logging.getLogger("knowledge_plugin.api")

TEXT_MAX_CHARS = 20_000
LOOKUP_TIMEOUT_MS = 8000
FIELDS_CACHE_S = 600.0
_CAPABILITY = re.compile(r"^[a-z][a-z0-9-]{1,60}$")


# ------------------------------------------------------------------------------------ errors

class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, *, retryable: bool = False,
                 details: dict | None = None, headers: dict | None = None) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
        self.retryable, self.details, self.headers = retryable, details, headers


def error_body(code: str, message: str, retryable: bool, details: dict | None = None) -> dict:
    body: dict[str, Any] = {"code": code, "message": message, "retryable": retryable}
    if details:
        body["details"] = details
    return body


# ------------------------------------------------------------------------------------ contract models

class ContractModel(BaseModel):
    """A contract schema: unknown fields refused; ``_omit_if_none`` fields dropped when None."""

    model_config = ConfigDict(extra="forbid")
    _omit_if_none: ClassVar[frozenset[str]] = frozenset()

    @model_serializer(mode="wrap")
    def _serialize(self, handler):
        data = handler(self)
        for key in self._omit_if_none:
            if data.get(key) is None:
                data.pop(key, None)
        return data


Lane = Literal["evidence", "guideline", "regulatory", "safety", "pipeline", "public-health", "research", "ai", "mixed"]
SourceTypeName = Literal["journal", "regulator", "evidence-body", "preprint", "company", "media"]
EgressName = Literal["direct", "browser", "relay", "bridge", "api"]
AccessName = Literal["crossref-issn", "eutils-query", "europepmc", "json-api", "rss", "atom", "html-list",
                     "browser-list", "relay", "wechat-bridge", "evimed-api"]
HealthName = Literal["new", "healthy", "degraded", "unreadable", "drifted", "disabled"]
DefectName = Literal["no-date", "future-date", "truncated-summary", "short-summary", "no-summary", "encoding",
                     "link-derived", "oversize-truncated"]


class UpdateTo(ContractModel):
    model_config = ConfigDict(extra="ignore")
    _omit_if_none = frozenset({"type", "doi", "date"})
    type: str | None = None
    doi: str | None = None
    date: str | None = None


class EntryFacts(ContractModel):
    _omit_if_none = frozenset(FACT_TYPES)
    crossref_type: str | None = None
    update_to: list[UpdateTo] | None = None
    author_count: int | None = None
    journal: str | None = None
    issn: str | None = None
    trial_phase: str | None = None
    trial_status: str | None = None
    trial_event: str | None = None
    sponsor: str | None = None
    recall_class: str | None = None
    fda_application: str | None = None
    fda_supplement: str | None = None
    wx_biz: str | None = None
    wx_author: str | None = None
    wx_original: bool | None = None
    is_correction_notice: bool | None = None
    is_masthead: bool | None = None


class Entry(ContractModel):
    _omit_if_none = frozenset({"external_key", "lane_hint", "text_status"})
    entry_id: str
    seq: int
    revision: int = Field(ge=1)
    source_id: str
    external_key: str | None = Field(default=None, max_length=512)
    identity_key: str
    url: str = Field(max_length=2048)
    canonical_url: str = Field(max_length=2048)
    doi: str | None
    pmid: str | None
    registry_ids: list[str]
    title: str = Field(max_length=1000)
    summary: str | None = Field(max_length=SUMMARY_MAX)
    language: str
    lane_hint: Lane | None = None
    published_at: datetime | None
    date_precision: Literal["instant", "day", "inferred"]
    first_seen_at: datetime
    content_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    backfill: bool
    defects: list[DefectName]
    text_status: Literal["none", "pending", "available"] | None = None
    facts: EntryFacts


class EntryPage(ContractModel):
    entries: list[Entry]
    next_after: int
    has_more: bool
    server_time: datetime


class TrialFacts(ContractModel):
    _omit_if_none = frozenset({"phase", "status", "enrollment", "sponsor"})
    phase: str | None = None
    status: str | None = None
    enrollment: int | None = None
    sponsor: str | None = None


class Enrichment(ContractModel):
    _omit_if_none = frozenset(ENRICHMENT_TYPES)
    publication_types: list[str] | None = None
    mesh: list[str] | None = None
    journal: str | None = None
    authors_short: str | None = None
    open_access: Literal["gold", "green", "bronze", "closed", "unknown"] | None = None
    oa_pdf_url: str | None = None
    impact_factor: float | None = None
    core_journal_tags: list[str] | None = None
    preprint_of_doi: str | None = None
    published_version_doi: str | None = None
    trial_facts: TrialFacts | None = None
    drug_label_excerpt: str | None = None
    affiliation_countries: list[str] | None = None


class EntryText(ContractModel):
    _omit_if_none = frozenset({"text_kind", "fetched_from", "enrichment"})
    entry_id: str
    revision: int
    status: Literal["available", "pending", "unavailable"]
    text_kind: Literal["abstract", "excerpt", "full", "none"] | None = None
    abstract: str | None = None
    body_excerpt: str | None = Field(default=None, max_length=TEXT_MAX_CHARS)
    fetched_from: Literal["pubmed", "europepmc", "crossref", "page", "browser", "relay", "evimed-api", "wechat"] | None = None
    fetched_at: datetime | None = None
    next_attempt_at: datetime | None = None
    enrichment: Enrichment | None = None


class Source(ContractModel):
    _omit_if_none = frozenset({"homepage", "language", "region"})
    id: str = Field(max_length=120)
    name: str
    homepage: str | None = None
    lane: Lane
    source_type: SourceTypeName
    access: AccessName
    egress: EgressName
    authority: int = Field(ge=1, le=5)
    safety_feed: bool
    owner_entity: str
    launch_tier: Literal["P0", "P1", "P2"]
    language: str | None = None
    region: str | None = None
    cadence_s: int
    enabled: bool
    retired_at: datetime | None
    health: HealthName
    last_ok_at: datetime | None
    last_new_entry_at: datetime | None
    consecutive_failures: int
    entries_7d: int
    registry_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class SourcePage(ContractModel):
    sources: list[Source]
    next_cursor: str | None
    fetched_at: datetime


# ------------------------------------------------------------------------------------ helpers

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _int_param(request: Request, name: str, *, default: int | None, low: int, high: int, code: str = "invalid_params") -> int:
    raw = request.query_params.get(name)
    if raw is None:
        if default is None:
            raise ApiError(400, code, f"{name} is required", details={"field": name})
        return default
    if not re.fullmatch(r"\d{1,19}", raw.strip()):
        raise ApiError(400, code, f"{name} must be a non-negative integer", details={"field": name})
    value = int(raw.strip())
    if not low <= value <= high:
        raise ApiError(400, code, f"{name} must be between {low} and {high}", details={"field": name})
    return value


def _bool_param(request: Request, name: str, default: bool) -> bool:
    raw = request.query_params.get(name)
    if raw is None:
        return default
    lowered = raw.strip().lower()
    if lowered in ("true", "1"):
        return True
    if lowered in ("false", "0"):
        return False
    raise ApiError(400, "invalid_params", f"{name} must be true or false", details={"field": name})


def _enum_param(request: Request, name: str, vocabulary) -> str | None:
    raw = request.query_params.get(name)
    if raw is None:
        return None
    if raw not in vocabulary:
        raise ApiError(400, "invalid_params", f"{name} is not a known value", details={"field": name})
    return raw


def serialize_entry(row: dict) -> dict:
    facts, _ = whitelist_facts(row.get("facts") or {})
    text_status = row.get("text_status") or "none"
    return Entry(
        entry_id=row["entry_id"], seq=row["seq"], revision=row["revision"], source_id=row["source_id"],
        external_key=row["external_key"], identity_key=row["identity_key"], url=row["url"],
        canonical_url=row["canonical_url"], doi=row["doi"], pmid=row["pmid"], registry_ids=list(row["registry_ids"] or []),
        title=row["title"], summary=row["summary"], language=row["lang"] or "und",
        lane_hint=row["lane_hint"] if row["lane_hint"] in LANES else None, published_at=row["published_at"],
        date_precision=row["date_precision"] if row["date_precision"] in DATE_PRECISIONS else "inferred",
        first_seen_at=row["first_seen_at"], content_sha256=row["content_sha256"], backfill=row["backfill"],
        defects=[d for d in (row["defects"] or []) if d in DEFECTS],
        text_status=text_status if text_status in ("none", "pending", "available") else "none",
        facts=EntryFacts(**facts),
    ).model_dump(mode="json")


def serialize_source(row: dict) -> dict:
    return Source(
        id=row["id"], name=row["name"], homepage=row["homepage"], lane=row["lane"], source_type=row["source_type"],
        access=row["access"], egress=row["egress"], authority=row["authority"], safety_feed=row["safety_feed"],
        owner_entity=row["owner_entity"], launch_tier=row["launch_tier"], language=row["language"], region=row["region"],
        cadence_s=row["poll_interval_s"], enabled=row["enabled"], retired_at=row["retired_at"],
        health=row["health"] if row["health"] in HEALTH_STATES else "degraded", last_ok_at=row["last_ok_at"],
        last_new_entry_at=row["last_new_entry_at"], consecutive_failures=row["consecutive_failures"],
        entries_7d=row["entries_7d"], registry_sha256=row["registry_sha256"],
    ).model_dump(mode="json")


def serialize_text(entry: dict, text: dict | None, status: str, next_attempt_at: datetime | None) -> dict:
    enrichment = whitelist_enrichment((text or {}).get("enrichment") or {})
    kind = (text or {}).get("text_kind")
    source = (text or {}).get("fetched_from")
    return EntryText(
        entry_id=entry["entry_id"],
        revision=(text or {}).get("revision") or entry["revision"],
        status=status,
        text_kind=kind if kind in ("abstract", "excerpt", "full", "none") else ("none" if status != "pending" else None),
        abstract=(text or {}).get("abstract") if status == "available" else None,
        body_excerpt=(text or {}).get("body_excerpt") if status == "available" else None,
        fetched_from=source if source in FETCHED_FROM else None,
        fetched_at=(text or {}).get("fetched_at"),
        next_attempt_at=next_attempt_at,
        enrichment=Enrichment(**enrichment) if enrichment else None,
    ).model_dump(mode="json")


class TokenGate:
    """The bearer token, re-read when its file changes, compared in constant time."""

    def __init__(self, settings: Settings) -> None:
        self._path = settings.token_file
        self._warned = False

    def check(self, request: Request) -> None:
        token = read_secret_file(self._path)
        if not token:
            if not self._warned:
                log.error("no token configured (KNOWLEDGE_PLUGIN_TOKEN_FILE missing or empty): refusing every request")
                self._warned = True
            raise ApiError(401, "unauthorized", "missing or wrong bearer token", headers={"WWW-Authenticate": "Bearer"})
        header = request.headers.get("authorization", "")
        scheme, _, given = header.partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(given.strip().encode("utf-8"), token.encode("utf-8")):
            raise ApiError(401, "unauthorized", "missing or wrong bearer token", headers={"WWW-Authenticate": "Bearer"})


# ------------------------------------------------------------------------------------ the app

def create_app(settings: Settings, *, pool=None, crawler=None, lifespan_hooks: dict | None = None,
               clock=_utcnow) -> FastAPI:
    """Build the app. With ``pool`` given the caller owns the pool and the crawler (tests); otherwise
    the lifespan opens the pool, migrates, syncs the registry and starts the crawler."""
    state: dict[str, Any] = {"pool": pool, "crawler": crawler, "started_at": clock(), "started_monotonic": time.monotonic(),
                             "fields_cache": (0.0, None)}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        hooks = lifespan_hooks or {}
        if state["pool"] is None and "startup" in hooks:
            await hooks["startup"](state)
        try:
            yield
        finally:
            if "shutdown" in hooks:
                await hooks["shutdown"](state)

    app = FastAPI(title="EviMed Knowledge Source Plugin", version=__version__, docs_url=None, redoc_url=None,
                  openapi_url=None, lifespan=lifespan)
    gate = TokenGate(settings)
    app.state.plugin = state

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, error: ApiError):
        return JSONResponse(error_body(error.code, error.message, error.retryable, error.details), status_code=error.status,
                            headers=error.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, error: RequestValidationError):
        field = ".".join(str(p) for p in (error.errors()[0].get("loc") or [])[1:]) if error.errors() else ""
        return JSONResponse(error_body("invalid_params", "invalid request parameters", False, {"field": field} if field else None),
                            status_code=400)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, error: StarletteHTTPException):
        if error.status_code == 404:
            return JSONResponse(error_body("not_found", "no such path", False), status_code=404)
        if error.status_code == 405:
            return JSONResponse(error_body("invalid_params", "method not allowed on this path", False), status_code=405)
        return JSONResponse(error_body("internal", "request failed", True), status_code=error.status_code)

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, error: Exception):
        log.exception("request failed")
        return JSONResponse(error_body("internal", "internal error", True), status_code=500)

    def pool_of():
        if state["pool"] is None:
            raise ApiError(503, "internal", "the plugin is starting", retryable=True)
        return state["pool"]

    # ---------------------------------------------------------------- discovery

    @app.get("/v1/health")
    async def health():
        now = clock()
        body: dict[str, Any] = {"status": "ok", "contract": CONTRACT_VERSION,
                                "uptime_s": int(time.monotonic() - state["started_monotonic"]),
                                "egress": {"direct": "ok", "api": "ok", "browser": "unconfigured",
                                           "relay": "unconfigured", "bridge": "unconfigured"},
                                "model_calls_24h": 0, "sources": {}}
        pool = state["pool"]
        if pool is None:
            body["status"] = "down"
            return JSONResponse(body)
        try:
            async with pool.connection() as conn:
                rows = await (await conn.execute(
                    """SELECT health, count(*) AS n FROM evimed_knowledge.sources WHERE retired_at IS NULL GROUP BY health""",
                )).fetchall()
                body["sources"] = {row["health"]: row["n"] for row in rows}
                stats = await (await conn.execute(
                    """SELECT (SELECT max(fetched_at) FROM evimed_knowledge.fetches) AS last_fetch_at,
                              (SELECT max(last_new_entry_at) FROM evimed_knowledge.sources) AS last_new_entry_at,
                              (SELECT coalesce(max(seq), 0) FROM evimed_knowledge.entries) AS latest_seq,
                              (SELECT count(*) FROM evimed_knowledge.sources WHERE enabled AND retired_at IS NULL
                                  AND next_poll_at <= %(now)s) AS due_sources,
                              (SELECT min(next_poll_at) FROM evimed_knowledge.sources WHERE enabled AND retired_at IS NULL
                                  AND next_poll_at <= %(now)s) AS oldest_due,
                              (SELECT count(*) FROM evimed_knowledge.entries WHERE text_status = 'pending') AS pending_texts""",
                    {"now": now},
                )).fetchone()
                egress_rows = await (await conn.execute(
                    """SELECT egress,
                              (array_agg(outcome ORDER BY fetched_at DESC))[1] AS last_outcome,
                              bool_or(outcome IN ('ok', 'not-modified', 'empty')) AS any_ok
                         FROM evimed_knowledge.fetches
                        WHERE fetched_at > %s AND outcome NOT IN ('host-budget', 'robots-denied')
                        GROUP BY egress""",
                    (now - timedelta(hours=24),),
                )).fetchall()
            body["egress"] = egress_health(state.get("fetcher"), egress_rows, now)
            body["last_fetch_at"] = stats["last_fetch_at"].isoformat().replace("+00:00", "Z") if stats["last_fetch_at"] else None
            body["last_new_entry_at"] = stats["last_new_entry_at"].isoformat().replace("+00:00", "Z") if stats["last_new_entry_at"] else None
            body["latest_seq"] = int(stats["latest_seq"])
            body["backlog"] = {"due_sources": int(stats["due_sources"]), "pending_texts": int(stats["pending_texts"]),
                               "oldest_due_s": int((now - stats["oldest_due"]).total_seconds()) if stats["oldest_due"] else 0}
        except Exception as error:  # health must answer even when the database does not
            log.warning("health query failed: %s", type(error).__name__)
            body["status"] = "down"
            return JSONResponse(body)
        crawler = state["crawler"]
        recent_error = (crawler is not None and crawler.last_error_at is not None
                        and now - crawler.last_error_at < timedelta(hours=1))
        if settings.crawl_enabled and recent_error and body["status"] == "ok":
            body["status"] = "degraded"     # a crawler loop failed within the hour (named in the log)
        if body["egress"]["direct"] == "down":
            body["status"] = "degraded"
        return JSONResponse(body)

    @app.get("/v1/manifest")
    async def manifest(request: Request):
        gate.check(request)
        async with pool_of().connection() as conn:
            rows = await (await conn.execute(
                """SELECT lane, launch_tier, egress, access, source_type, enabled
                     FROM evimed_knowledge.sources WHERE retired_at IS NULL""",
            )).fetchall()
            purged = int(await meta_get(conn, "purged_through_seq", 0) or 0)
            fields = await _populated_fields(conn, state)

        def tally(key: str, only_enabled: bool = False) -> dict:
            counts: dict[str, int] = {}
            for row in rows:
                if only_enabled and not row["enabled"]:
                    continue
                counts[row[key]] = counts.get(row[key], 0) + 1
            return dict(sorted(counts.items()))

        body = {
            "plugin": {"name": PLUGIN_NAME, "version": settings.version, "build": settings.build,
                       "started_at": state["started_at"].isoformat().replace("+00:00", "Z")},
            "contract": {"version": CONTRACT_VERSION},
            "capabilities": {"stream": True, "text": True, "refresh": True, "lookups": []},
            "vocabularies": {
                "lane": sorted({r["lane"] for r in rows}), "source_type": sorted({r["source_type"] for r in rows}),
                "egress": sorted({r["egress"] for r in rows}), "access": sorted({r["access"] for r in rows}),
            },
            "sources": {"total": len(rows), "enabled": sum(1 for r in rows if r["enabled"]), "by_lane": tally("lane"),
                        "by_tier": tally("launch_tier"), "by_egress": tally("egress")},
            "fields": fields,
            "limits": {"entries_page_max": ENTRIES_PAGE_MAX, "text_max_chars": TEXT_MAX_CHARS,
                       "summary_max_chars": SUMMARY_MAX, "lookup_timeout_ms": LOOKUP_TIMEOUT_MS},
            "oldest_seq_available": purged + 1,
        }
        return JSONResponse(body)

    # ---------------------------------------------------------------- sources

    @app.get("/v1/sources")
    async def list_sources(request: Request):
        gate.check(request)
        lane = _enum_param(request, "lane", LANES)
        tier = _enum_param(request, "tier", LAUNCH_TIERS)
        health_state = _enum_param(request, "health", HEALTH_STATES)
        egress = _enum_param(request, "egress", EGRESSES)
        include_retired = _bool_param(request, "include_retired", False)
        limit = _int_param(request, "limit", default=500, low=1, high=SOURCES_PAGE_MAX)
        cursor = request.query_params.get("cursor")
        if cursor is not None and (not cursor or len(cursor) > 120):
            raise ApiError(400, "invalid_params", "cursor is not one this plugin issued", details={"field": "cursor"})
        clauses, params = [], {}
        if not include_retired:
            clauses.append("retired_at IS NULL")
        for key, value in (("lane", lane), ("launch_tier", tier), ("health", health_state), ("egress", egress)):
            if value is not None:
                clauses.append(f"{key} = %({key})s")
                params[key] = value
        if cursor:
            clauses.append("id > %(cursor)s")
            params["cursor"] = cursor
        params["limit"] = limit + 1
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        async with pool_of().connection() as conn:
            rows = await (await conn.execute(
                f"SELECT * FROM evimed_knowledge.sources {where} ORDER BY id LIMIT %(limit)s", params,
            )).fetchall()
        more = len(rows) > limit
        rows = rows[:limit]
        body = SourcePage(sources=[], next_cursor=rows[-1]["id"] if more and rows else None, fetched_at=clock()).model_dump(mode="json")
        body["sources"] = [serialize_source(row) for row in rows]
        return JSONResponse(body)

    @app.get("/v1/sources/{source_id}")
    async def get_source(source_id: str, request: Request):
        gate.check(request)
        if len(source_id) > 120:
            raise ApiError(404, "not_found", "no such source")
        async with pool_of().connection() as conn:
            row = await (await conn.execute("SELECT * FROM evimed_knowledge.sources WHERE id = %s", (source_id,))).fetchone()
        if row is None:
            raise ApiError(404, "not_found", "no such source")
        return JSONResponse(serialize_source(row))

    # ---------------------------------------------------------------- stream

    @app.get("/v1/entries")
    async def list_entries(request: Request):
        gate.check(request)
        after = _int_param(request, "after", default=None, low=0, high=2**63 - 1, code="invalid_cursor")
        limit = _int_param(request, "limit", default=200, low=1, high=ENTRIES_PAGE_MAX)
        lane = _enum_param(request, "lane", LANES)
        include_backfill = _bool_param(request, "include_backfill", False)
        source_id = request.query_params.get("source_id")
        if source_id is not None and (not source_id or len(source_id) > 120):
            raise ApiError(400, "invalid_params", "source_id is not a source id", details={"field": "source_id"})
        clauses = ["e.seq > %(after)s"]
        params: dict[str, Any] = {"after": after, "limit": limit + 1}
        if not include_backfill:
            clauses.append("NOT e.backfill")
        if source_id is not None:
            clauses.append("e.source_id = %(source_id)s")
            params["source_id"] = source_id
        join = ""
        if lane is not None:
            join = "JOIN evimed_knowledge.sources s ON s.id = e.source_id"
            clauses.append("coalesce(e.lane_hint, s.lane) = %(lane)s")
            params["lane"] = lane
        columns = ", ".join("e." + c.strip() for c in ENTRY_COLUMNS.split(","))
        async with pool_of().connection() as conn:
            rows = await (await conn.execute(
                f"""SELECT {columns} FROM evimed_knowledge.entries e {join}
                     WHERE {' AND '.join(clauses)} ORDER BY e.seq LIMIT %(limit)s""",
                params,
            )).fetchall()
        more = len(rows) > limit
        rows = rows[:limit]
        body = EntryPage(entries=[], next_after=rows[-1]["seq"] if rows else after, has_more=more,
                         server_time=clock()).model_dump(mode="json")
        body["entries"] = [serialize_entry(row) for row in rows]
        return JSONResponse(body)

    @app.get("/v1/entries/{entry_id:path}/text")
    async def get_entry_text(entry_id: str, request: Request):
        gate.check(request)
        now = clock()
        async with pool_of().connection() as conn:
            async with conn.transaction():
                entry = await entry_row(conn, entry_id)
                if entry is None:
                    raise ApiError(404, "not_found", "no such entry")
                text = await text_row(conn, entry_id)
                status = entry["text_status"]
                if status == "available" and text is not None:
                    await conn.execute(
                        "UPDATE evimed_knowledge.entries SET text_requested_at = coalesce(text_requested_at, %s) WHERE entry_id = %s",
                        (now, entry_id))
                    return JSONResponse(serialize_text(entry, text, "available", None))
                if status == "unavailable":
                    await conn.execute(
                        "UPDATE evimed_knowledge.entries SET text_requested_at = coalesce(text_requested_at, %s) WHERE entry_id = %s",
                        (now, entry_id))
                    return JSONResponse(serialize_text(entry, text, "unavailable", None))
                if status == "pending" and text is not None and text.get("next_attempt_at"):
                    return JSONResponse(serialize_text(entry, text, "pending", text["next_attempt_at"]))
                next_attempt = await schedule_text(conn, entry_id, entry["revision"], now, reset=False)
                text = await text_row(conn, entry_id)
        return JSONResponse(serialize_text(entry, text, "pending", next_attempt))

    @app.post("/v1/entries/{entry_id:path}/refresh")
    async def refresh_entry(entry_id: str, request: Request):
        gate.check(request)
        now = clock()
        async with pool_of().connection() as conn:
            async with conn.transaction():
                entry = await entry_row(conn, entry_id)
                if entry is None:
                    raise ApiError(404, "not_found", "no such entry")
                await schedule_text(conn, entry_id, entry["revision"], now, reset=True)
        return JSONResponse({"scheduled": True, "not_before": now.isoformat().replace("+00:00", "Z")}, status_code=202)

    @app.get("/v1/entries/{entry_id:path}")
    async def get_entry(entry_id: str, request: Request):
        gate.check(request)
        async with pool_of().connection() as conn:
            row = await entry_row(conn, entry_id)
        if row is None:
            raise ApiError(404, "not_found", "no such entry")
        return JSONResponse(serialize_entry(row))

    # ---------------------------------------------------------------- lookups (batch 3)

    @app.get("/v1/lookups")
    async def list_lookups(request: Request):
        gate.check(request)
        return JSONResponse({"lookups": []})

    @app.post("/v1/lookups/{capability}")
    async def run_lookup(capability: str, request: Request):
        gate.check(request)
        if not _CAPABILITY.match(capability):
            raise ApiError(400, "invalid_params", "capability is not a capability id", details={"field": "capability"})
        raise ApiError(501, "capability_unavailable", "this build offers no lookups (see /v1/manifest)")

    return app


def egress_health(fetcher, egress_rows: list[dict], now: datetime) -> dict[str, str]:
    """Per exit (contract ``Health.egress``): ``unconfigured`` when this deployment lacks it; else
    what this process saw on its transport (``EgressStats``); else, after a restart, the last 24 h of
    the fetch log; else ``ok`` (configured, nothing wrong seen). ``evimed-api`` is the team's API key
    and service, reported next to the exits because an exit without its key reads nothing."""
    from_log = {row["egress"]: ("ok" if row["last_outcome"] in ("ok", "not-modified", "empty")
                                else "degraded" if row["any_ok"] else "down") for row in egress_rows}
    live = fetcher.egress_status(now) if fetcher is not None else {
        "direct": None, "api": None, "relay": "unconfigured", "browser": "unconfigured", "bridge": "unconfigured"}
    out: dict[str, str] = {}
    for egress in ("direct", "api", "relay", "browser", "bridge"):
        value = live.get(egress)
        out[egress] = value if value is not None else from_log.get(egress, "ok")
    out["evimed-api"] = fetcher.evimed_status() if fetcher is not None else "unconfigured"
    return out


async def _populated_fields(conn, state: dict) -> dict:
    """Which optional fields this build actually populates, from the stored data (cached 10 min)."""
    cached_at, cached = state["fields_cache"]
    if cached is not None and time.monotonic() - cached_at < FIELDS_CACHE_S:
        return cached
    row = await (await conn.execute(
        """SELECT bool_or(doi IS NOT NULL) AS doi, bool_or(pmid IS NOT NULL) AS pmid,
                  bool_or(cardinality(registry_ids) > 0) AS registry_ids, bool_or(summary IS NOT NULL) AS summary,
                  bool_or(lane_hint IS NOT NULL) AS lane_hint, bool_or(published_at IS NOT NULL) AS published_at
             FROM evimed_knowledge.entries""",
    )).fetchone()
    fact_rows = await (await conn.execute(
        "SELECT DISTINCT jsonb_object_keys(facts) AS key FROM evimed_knowledge.entries",
    )).fetchall()
    enrichment_rows = await (await conn.execute(
        "SELECT DISTINCT jsonb_object_keys(enrichment) AS key FROM evimed_knowledge.entry_texts",
    )).fetchall()
    entry_fields = ["external_key", "date_precision", "defects", "text_status", "facts"]
    entry_fields += [name for name in ("doi", "pmid", "registry_ids", "summary", "lane_hint", "published_at") if row and row[name]]
    fields = {
        "entry": sorted(entry_fields),
        "facts": sorted({r["key"] for r in fact_rows if r["key"] in FACT_TYPES} | {"is_masthead", "is_correction_notice"}),
        "enrichment": sorted({r["key"] for r in enrichment_rows if r["key"] in ENRICHMENT_TYPES}),
    }
    state["fields_cache"] = (time.monotonic(), fields)
    return fields
