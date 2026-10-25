"""Leads: addresses the platform found and hands over to be read (``POST /v1/leads``, contract 1.6.0, ct-mix 2026-10-24).

The platform decides when to go looking for material — a daily watch, a congress in its window, a genre 精选 is short of,
an event that turned hot, a story without a Chinese report or without its primary source — and searches the open web
through its own gateway. What it finds is a list of addresses; this module is everything the plugin does with them, under
its own rules, exactly as it reads any source:

- **Received** (``submit``): each address once (idempotent on its canonical form: a second post of it, or of a page the
  stream already holds, is ``duplicate``), within a day's cap (``KNOWLEDGE_PLUGIN_LEADS_DAILY``, Shanghai day; past it,
  ``capped``), never from an owner-excluded or discovery-excluded host (``refused``) — nor from a host the plugin's own
  record shows it cannot read (``refused``, reason ``host_blocked``: ``blocked_hosts``). Nothing is fetched while the
  platform waits: an accepted address is queued.
- **Read** (``LeadReader.tick``, a loop of the crawler): a few a minute, through the protected fetch — robots, the
  per-host pacing and budgets, the address policy, the relay when Beijing is refused — with the readers the plugin
  already has: a page's main text (``enrich.page``) and its metadata (trafilatura), a WeChat article's text bought through
  Dajiala within the shared daily cap (the social collector's client and ``social.wechat.build_entry``: never read as a
  page), a DOI through Crossref, a PMID through PubMed's summary, a trial number through ClinicalTrials.gov's API. A page
  or an article must carry a date within ``FRESH_DAYS`` (a search finds old pages too); an identifier needs none.
- **Emitted** as ordinary entries on the ``seq`` stream: under the registered source of that site (or WeChat account, or
  journal) when there is one, else under a lead source of its own — one per site, account or journal (``lead_sources``),
  named by the page itself, its operator the site, composed into the registry with every other channel
  (``dynamic_registry``) and never polled (access ``lead``). A lead source is the plugin's, not a reader's word: what a
  reader sees is the site's own name.
- **Discovered**: the site, account or journal of every page read becomes a discovery candidate of line ``lead``
  (``discovery.LINES``), validated, tried and admitted like every other line's.

The plugin still never calls the platform and makes no model call.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote, urlsplit
from zoneinfo import ZoneInfo

from psycopg.types.json import Jsonb

from .model import FetchError, NormalizedEntry, RequestSpec
from .normalize import Rejected, canonical_url, normalize_doi, prepare

log = logging.getLogger("knowledge_plugin.leads")

LEAD_ACCESS = "lead"
DEFAULT_DAILY = 600                     # addresses accepted a Shanghai day (KNOWLEDGE_PLUGIN_LEADS_DAILY; settings.py holds the same number)
PER_POST = 50                           # addresses one post carries at most (the contract's bound)
PER_TICK = 8                            # addresses one tick reads
FRESH_DAYS = 30                         # a page or an article older than this (or undated) is not emitted
MAX_ATTEMPTS = 3
RETRY_AFTER = timedelta(hours=1)
RETENTION = timedelta(days=30)
BLOCKED_WINDOW = timedelta(days=7)      # a host that denied a read this recently is not queued again (``blocked_hosts``)
# How a read ends when the host says no: ``leads.state_reason`` is ``<fetch outcome>:<detail>`` (``LeadReader.tick``).
BLOCKED_REASON = re.compile(r"^(robots-denied:|challenge:|blocked:http_(401|403|451)$)")
LEAD_FLOOR_S = 86400                    # a lead source's cadence is a registry formality: it is never polled
LEAD_CEILING_S = 604800
SHANGHAI = ZoneInfo("Asia/Shanghai")
TRIGGER = re.compile(r"^[a-z][a-z0-9-]{1,39}$")
NCT = re.compile(r"^NCT\d{8}$")
CJK = re.compile(r"[一-鿿]")
STATUSES = ("accepted", "duplicate", "refused", "capped")


class LeadsInvalid(ValueError):
    """A post the contract does not allow; ``field`` names what."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field


@dataclass(frozen=True)
class Lead:
    url: str
    trigger: str
    query: str | None = None
    title: str | None = None
    snippet: str | None = None
    published_hint: datetime | None = None


def _text(value: Any, field: str, limit: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > limit:
        raise LeadsInvalid(field, f"{field} must be a string of at most {limit} characters")
    return value.strip() or None


def parse_leads(payload: Any) -> list[Lead]:
    """The post's leads, each checked against the contract (``LeadBatch``); raises ``LeadsInvalid``."""
    rows = payload.get("leads") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or not 1 <= len(rows) <= PER_POST:
        raise LeadsInvalid("leads", f"leads must be a list of 1-{PER_POST}")
    leads = []
    for row in rows:
        if not isinstance(row, dict) or set(row) - {"url", "trigger", "query", "title", "snippet", "published_hint"}:
            raise LeadsInvalid("leads", "a lead is an object with url, trigger and optional query, title, snippet, published_hint")
        url = row.get("url")
        if not isinstance(url, str) or not 8 <= len(url) <= 2048 or not url.startswith(("http://", "https://")):
            raise LeadsInvalid("leads.url", "url must be an http(s) address of at most 2048 characters")
        trigger = row.get("trigger")
        if not isinstance(trigger, str) or not TRIGGER.match(trigger):
            raise LeadsInvalid("leads.trigger", "trigger must match ^[a-z][a-z0-9-]{1,39}$")
        hint = row.get("published_hint")
        published = None
        if hint is not None:
            try:
                published = datetime.fromisoformat(str(hint).replace("Z", "+00:00"))
            except ValueError:
                raise LeadsInvalid("leads.published_hint", "published_hint must be a date-time") from None
            if published.tzinfo is None:
                published = published.replace(tzinfo=timezone.utc)
        leads.append(Lead(url=url.strip(), trigger=trigger, query=_text(row.get("query"), "leads.query", 300),
                          title=_text(row.get("title"), "leads.title", 300), snippet=_text(row.get("snippet"), "leads.snippet", 700),
                          published_hint=published))
    return leads


def url_sha256(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def host_family(url: str | None) -> str:
    host = (urlsplit(url or "").hostname or "").lower().rstrip(".")
    return host[4:] if host.startswith("www.") else host


def lead_kind(url: str) -> tuple[str, str | None]:
    """What an address names, and the identifier it carries: ``wechat`` (a WeChat article), ``doi``, ``pmid``, ``nct``
    or ``page``. A format, not language: the host and the path."""
    from .social.wechat import is_article

    if is_article(url):
        return "wechat", None
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    path = parts.path or ""
    if host in ("doi.org", "dx.doi.org") and path.strip("/"):
        doi = normalize_doi(path.lstrip("/"))
        if doi:
            return "doi", doi
    if host == "pubmed.ncbi.nlm.nih.gov" and re.fullmatch(r"/\d{6,9}/?", path):
        return "pmid", path.strip("/")
    if host in ("clinicaltrials.gov", "www.clinicaltrials.gov"):
        found = re.search(r"(NCT\d{8})", path, re.I)
        if found:
            return "nct", found.group(1).upper()
    return "page", None


def identity_keys(url: str) -> list[str]:
    """The stream's identity keys an address would be delivered under, to tell a duplicate before it is read."""
    kind, ident = lead_kind(url)
    keys = ["url:" + hashlib.sha256(canonical_url(url).encode("utf-8")).hexdigest()]
    if kind == "doi" and ident:
        keys.append(f"doi:{ident}")
    if kind == "pmid" and ident:
        keys.append(f"pmid:{ident}")
    return keys


def shanghai_day(now: datetime) -> str:
    return now.astimezone(SHANGHAI).date().isoformat()


async def excluded_hosts(conn) -> set[str]:
    """The hosts of owner-excluded rows (CDE, Fierce …): never read for a lead either. Discovery's own exclusions
    (``registry/discovery.json``: resolvers, aggregators, social platforms, general news) are about what to subscribe to,
    not what to read once: they keep a site from becoming a candidate (``LeadReader``), never a page from being read."""
    from .discovery import host_of, site_family

    rows = await (await conn.execute(
        "SELECT homepage, config FROM evimed_knowledge.sources WHERE disabled_reason = 'owner_excluded'")).fetchall()
    return {site_family(host_of(value)) for row in rows for value in (row["homepage"], (row["config"] or {}).get("url")) if host_of(value)}


async def blocked_hosts(conn, now: datetime) -> set[str]:
    """The host families a lead read was refused by within ``BLOCKED_WINDOW`` — robots.txt denied it, a challenge page
    answered, or the host said 401, 403 or 451 — and that no lead read got a page from in the same window (a host that
    served one page denied this one only: its robots rules or its paywall, not the host). The plugin's own record of what it
    fetched, in the same two states the reader writes (``leads.state``), so an address of such a host is never queued for a
    fetch the plugin already knows will fail (c2-fixes 2026-10-25: about 95 of the 300 accepted leads of 2026-10-25 failed so)."""
    rows = await (await conn.execute(
        """SELECT url, state, state_reason FROM evimed_knowledge.leads
            WHERE done_at > %s AND state IN ('fetched', 'stale', 'failed')""", (now - BLOCKED_WINDOW,))).fetchall()
    denied: set[str] = set()
    served: set[str] = set()
    for row in rows:
        family = host_family(row["url"])
        if not family:
            continue
        if row["state"] in ("fetched", "stale"):
            served.add(family)
        elif BLOCKED_REASON.match(row["state_reason"] or ""):
            denied.add(family)
    return denied - served


async def submit(conn, leads: list[Lead], now: datetime, *, daily_cap: int, excluded: set[str],
                 blocked: set[str] | None = None) -> dict:
    """Receive a post (module docstring): each address accepted (queued), a duplicate, refused or capped. ``blocked``
    is ``blocked_hosts`` (read here when not given)."""
    from .discovery import canonical_url as public_url, host_matches, host_of

    day = shanghai_day(now)
    results: list[dict] = []
    counts = {status: 0 for status in STATUSES}
    async with conn.transaction():
        if blocked is None:
            blocked = await blocked_hosts(conn, now)
        await conn.execute("SELECT pg_advisory_xact_lock(hashtext('evimed-knowledge-leads'))")
        received = int((await (await conn.execute(
            "SELECT count(*) AS n FROM evimed_knowledge.leads WHERE day = %s", (day,))).fetchone())["n"])
        for lead in leads:
            clean = public_url(lead.url)
            status, reason = "accepted", None
            if not clean:
                status, reason = "refused", "not_a_public_address"
            elif host_matches(host_of(clean), excluded):
                status, reason = "refused", "excluded"
            elif host_family(clean) in blocked:
                status, reason = "refused", "host_blocked"
            else:
                key = url_sha256(canonical_url(clean))
                seen = await (await conn.execute(
                    "SELECT 1 FROM evimed_knowledge.leads WHERE url_sha256 = %s", (key,))).fetchone()
                held = seen or await (await conn.execute(
                    "SELECT 1 FROM evimed_knowledge.entries WHERE identity_key = ANY(%s) LIMIT 1", (identity_keys(clean),))).fetchone()
                if held:
                    status, reason = "duplicate", "received" if seen else "in_stream"
                elif received >= daily_cap:
                    status, reason = "capped", "daily_cap"
                else:
                    await conn.execute(
                        """INSERT INTO evimed_knowledge.leads (url_sha256, url, trigger, query, title, snippet, published_hint,
                                  received_at, day, state, next_attempt_at)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'queued', %s) ON CONFLICT (url_sha256) DO NOTHING""",
                        (key, clean, lead.trigger, lead.query, lead.title, lead.snippet, lead.published_hint, now, day, now))
                    received += 1
            counts[status] += 1
            results.append({"url": lead.url, "status": status, **({"reason": reason} if reason else {})})
    return {**counts, "results": results}


# ------------------------------------------------------------------------------------ reading


def lead_source_row(key: str, *, name: str, homepage: str | None, url: str, source_type: str, owner: str,
                    egress: str = "direct", language: str | None = None) -> dict:
    """A registry row for a lead source (module docstring): never polled (access ``lead``), named and owned by the site,
    account or journal it stands for."""
    host = (urlsplit(url).hostname or "").lower()
    return {
        "id": "lead-" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:20], "name": name[:160] or host,
        "homepage": homepage, "lane": "mixed", "source_type": source_type, "access": LEAD_ACCESS, "egress": egress,
        "authority": 2, "safety_feed": False, "owner_entity": owner[:200] or host, "launch_tier": "P2", "language": language,
        "region": None, "poll_floor_s": LEAD_FLOOR_S, "poll_ceiling_s": LEAD_CEILING_S, "enabled": True,
        "disabled_reason": None, "category": "lead", "config": {"url": url, "allowed_hosts": [host], "lead_key": key},
    }


def _language(*texts: str | None) -> str:
    """``zh`` when the title or text is written in Han characters, else ``en`` — a script, not a language judgement."""
    sample = " ".join(t for t in texts if t)[:400]
    han = len(CJK.findall(sample))
    latin = len(re.findall(r"[A-Za-z]", sample))
    return "zh" if han >= 2 and han >= 0.3 * (han + latin) else "en"


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _fresh(published: datetime | None, now: datetime) -> bool:
    return published is not None and now - timedelta(days=FRESH_DAYS) <= published <= now + timedelta(days=2)


@dataclass
class Read:
    """What reading one lead gave: an entry for a target (``source`` an existing row id, or ``lead_row`` a lead source
    to compose first), the discovery candidate it names, or why there is none (``state``/``reason``)."""

    state: str                                  # fetched | stale | failed | refused | retry
    reason: str | None = None
    entry: NormalizedEntry | None = None
    source: str | None = None
    lead_row: dict | None = None
    candidate: Any = None
    retry_at: datetime | None = None


class LeadReader:
    """The crawler's leads loop (module docstring): a few queued addresses a tick, read, emitted, discovered."""

    def __init__(self, settings, pool, fetcher, *, collector=None, clock=None, data: dict | None = None) -> None:
        from .discovery import data_path, load_data

        self._settings = settings
        self._pool = pool
        self._fetcher = fetcher
        self._collector = collector
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        # Discovery's exclusions: a site in them is read when a lead names it, never proposed as a candidate.
        self._not_candidates = {h.lower() for h in (data if data is not None else load_data(data_path(settings.registry_path))).get("exclude_hosts", [])}
        self.counters: dict[str, int] = {}

    def _count(self, name: str) -> None:
        self.counters[name] = self.counters.get(name, 0) + 1

    async def tick(self, limit: int = PER_TICK) -> dict:
        from .discovery import shanghai_day as discovery_day, upsert_candidates
        from .dynamic_registry import sync_dynamic_registry
        from .registry import load_registry, parse_registry, source_from_row
        from .store import store_entries

        now = self._clock()
        async with self._pool.connection() as conn:
            await conn.execute("DELETE FROM evimed_knowledge.leads WHERE received_at < %s", (now - RETENTION,))
            rows = await (await conn.execute(
                """UPDATE evimed_knowledge.leads SET next_attempt_at = %s
                    WHERE url_sha256 IN (SELECT url_sha256 FROM evimed_knowledge.leads
                      WHERE state = 'queued' AND next_attempt_at <= %s ORDER BY received_at LIMIT %s FOR UPDATE SKIP LOCKED)
                    RETURNING *""", (now + timedelta(minutes=10), now, limit))).fetchall()
            sources = [dict(r) for r in await (await conn.execute(
                """SELECT id, homepage, config, access, egress, source_type, cursor FROM evimed_knowledge.sources
                    WHERE retired_at IS NULL AND enabled""")).fetchall()]
        if not rows:
            return {"read": 0}
        reads = []
        for row in rows:
            try:
                read = await self.read(row, sources, now)
            except FetchError as error:
                read = Read("retry" if error.outcome in ("timeout", "host-budget", "http-error") else "failed",
                            f"{error.outcome}:{error.detail}"[:200])
            except Exception as error:      # one stranger's page never ends the tick; it is tried again later
                log.exception("lead %s failed", str(row["url"])[:200])
                read = Read("retry", f"internal:{type(error).__name__}")
            self._count(f"read:{read.state}")
            reads.append((row, read))
        new_rows = {read.lead_row["id"]: read.lead_row for _, read in reads if read.lead_row}
        async with self._pool.connection() as conn:
            if new_rows:
                async with conn.transaction():
                    for lead_row in new_rows.values():
                        parse_registry({"sources": [lead_row]})       # a row that does not load is a bug, said here
                        await conn.execute(
                            """INSERT INTO evimed_knowledge.lead_sources (id, key, row, created_at) VALUES (%s, %s, %s, %s)
                               ON CONFLICT (id) DO NOTHING""",
                            (lead_row["id"], lead_row["config"]["lead_key"], Jsonb(lead_row), now))
                await sync_dynamic_registry(conn, lambda: load_registry(self._settings.registry_path), now)
            candidates = [read.candidate for _, read in reads if read.candidate is not None and self._proposable(read.candidate)]
            if candidates:
                async with conn.transaction():
                    await upsert_candidates(conn, candidates, now, discovery_day(now))
            emitted = 0
            for row, read in reads:
                state, reason, entry_id, source_id = read.state, read.reason, None, None
                if read.state == "fetched" and read.entry is not None:
                    source_id = read.source or (read.lead_row or {}).get("id")
                    source_row = await (await conn.execute(
                        "SELECT * FROM evimed_knowledge.sources WHERE id = %s", (source_id,))).fetchone()
                    try:
                        prepared = prepare(read.entry, source_from_row(source_row))
                        # A lead was asked for: it is never a first contact's backlog, whatever its age.
                        result = await store_entries(conn, source_id, [prepared], now=now, first_contact=False)
                        entry_id = prepared.entry_id
                        emitted += result.new + result.revised
                        if source_row["access"] == LEAD_ACCESS:
                            await conn.execute(
                                """UPDATE evimed_knowledge.sources SET first_contact_at = coalesce(first_contact_at, %s),
                                          last_ok_at = %s, last_new_entry_at = %s, health = 'healthy' WHERE id = %s""",
                                (now, now, now, source_id))
                            await conn.execute("UPDATE evimed_knowledge.lead_sources SET last_entry_at = %s WHERE id = %s",
                                               (now, source_id))
                    except Rejected as rejected:
                        state, reason = "failed", f"rejected:{rejected.code}"
                if state == "retry":
                    attempts = int(row["attempts"]) + 1
                    retry_at = read.retry_at or now + RETRY_AFTER
                    await conn.execute(
                        """UPDATE evimed_knowledge.leads SET attempts = %s, state = CASE WHEN %s >= %s THEN 'failed' ELSE 'queued' END,
                                  state_reason = %s, next_attempt_at = %s, done_at = CASE WHEN %s >= %s THEN %s END
                            WHERE url_sha256 = %s""",
                        (attempts, attempts, MAX_ATTEMPTS, reason, retry_at, attempts, MAX_ATTEMPTS, now, row["url_sha256"]))
                    continue
                await conn.execute(
                    """UPDATE evimed_knowledge.leads SET state = %s, state_reason = %s, attempts = attempts + 1, source_id = %s,
                              entry_id = %s, done_at = %s WHERE url_sha256 = %s""",
                    (state, reason, source_id, entry_id, now, row["url_sha256"]))
        return {"read": len(reads), "emitted": emitted, "lead_sources": len(new_rows), "candidates": len(candidates)}

    def _proposable(self, candidate) -> bool:
        from .discovery import host_matches, host_of

        if candidate.kind != "site":
            return True
        return not host_matches(host_of(candidate.key), self._not_candidates)

    async def read(self, row: dict, sources: list[dict], now: datetime) -> Read:
        url = row["url"]
        kind, ident = lead_kind(url)
        if kind == "wechat":
            return await self.read_wechat(row, sources, now)
        if kind == "doi":
            return await self.read_doi(ident, sources, now)
        if kind == "pmid":
            return await self.read_pmid(ident, sources, now)
        if kind == "nct":
            return await self.read_trial(ident, sources, now)
        return await self.read_page(row, sources, now)

    # ---------------------------------------------------------------- the target source

    @staticmethod
    def registered_site(url: str, sources: list[dict]) -> dict | None:
        """The registered source of a page's site (its homepage's or feed's host family), polled ones first."""
        family = host_family(url)
        matches = [s for s in sources if s["access"] != LEAD_ACCESS and family
                   and family in {host_family(s["homepage"]), host_family((s["config"] or {}).get("url"))}]
        return sorted(matches, key=lambda s: (s["access"] in ("dajiala", "socialdata", "social-crawl"), s["id"]))[0] if matches else None

    @staticmethod
    def registered_journal(issns: list[str], sources: list[dict]) -> dict | None:
        wanted = {i.upper() for i in issns if i}
        for source in sources:
            config = source["config"] or {}
            listed = {str(v).upper() for v in [config.get("issn"), *(config.get("issns") or [])] if v}
            if source["access"] != LEAD_ACCESS and wanted & listed:
                return source
        return None

    async def _fetch(self, url: str, *, egress: str = "direct", api: bool = False):
        """A request through the protected fetch, the relay when Beijing is refused (as discovery's ``fetch_page``)."""
        host = (urlsplit(url).hostname or "").lower()
        spec = RequestSpec(url=url, conditional=False, api=api)
        try:
            return await self._fetcher.fetch(spec, source_id="leads", egress=egress, allowed_hosts=[host])
        except FetchError as error:
            relay = bool(getattr(self._fetcher, "egress_configured", lambda _e: False)("relay"))
            if egress != "direct" or not relay or error.outcome not in ("blocked", "challenge", "timeout", "http-error"):
                raise
            return await self._fetcher.fetch(spec, source_id="leads", egress="relay", allowed_hosts=[host])

    # ---------------------------------------------------------------- a page

    async def read_page(self, row: dict, sources: list[dict], now: datetime) -> Read:
        from trafilatura import extract_metadata

        from .adapters.base import decode_body
        from .adapters.common import registry_ids
        from .discovery import Candidate, canonical_site
        from .enrich.page import main_text

        url = row["url"]
        registered = self.registered_site(url, sources)
        egress = registered["egress"] if registered and registered["egress"] in ("direct", "relay") else "direct"
        result = await self._fetch(url, egress=egress)
        if result.status != 200:
            return Read("failed", f"http_{result.status}")
        html = decode_body(result)
        meta = extract_metadata(html, default_url=url)
        title = (getattr(meta, "title", None) or row["title"] or "").strip()
        if not title:
            return Read("failed", "no_title")
        published, precision = None, "day"
        if getattr(meta, "date", None):
            try:
                published = datetime.fromisoformat(str(meta.date)[:10]).replace(tzinfo=timezone.utc)
            except ValueError:
                published = None
        if published is None and row["published_hint"]:
            published, precision = _as_utc(row["published_hint"]), "instant"
        if not _fresh(published, now):
            return Read("stale", "undated" if published is None else "older_than_window")
        text = main_text(html, result.final_url)
        description = (getattr(meta, "description", None) or "").strip()
        summary = (description or text[:500] or row["snippet"] or "").strip() or None
        site_name = (getattr(meta, "sitename", None) or "").strip()
        language = _language(title, text)
        entry = NormalizedEntry(external_key=canonical_url(url), url=url, title=title, summary=summary, published_at=published,
                                date_precision=precision, language=language, registry_ids=registry_ids(title, summary, text),
                                channel="news", body_text=text if len(text) >= 200 else None,
                                body_from="page" if len(text) >= 200 else None, body_kind="full")
        if registered:
            return Read("fetched", entry=entry, source=registered["id"])
        site = canonical_site(url) or url
        family = host_family(url)
        lead_row = lead_source_row(f"site:{family}", name=site_name or family, homepage=site, url=site, source_type="media",
                                   owner=family, egress=egress, language=language)
        candidate = Candidate("lead", "site", site, name=site_name or None,
                              hint={"homepage": site, **({"name": site_name} if site_name else {}), "language": language},
                              evidence={"lead_url": url, "trigger": row["trigger"]})
        return Read("fetched", entry=entry, lead_row=lead_row, candidate=candidate)

    # ---------------------------------------------------------------- a WeChat article

    async def read_wechat(self, row: dict, sources: list[dict], now: datetime) -> Read:
        from .social import wechat as wechat_mod
        from .social.providers import ProviderError
        from .social.spend import SpendCapReached, day_window
        from .social.wechat_discovery import candidate_from_lead_read

        collector = self._collector
        if collector is None or not collector.dajiala.configured:
            return Read("refused", "wechat_unconfigured")
        blocked = await collector.bodies_blocked(now)
        if blocked == "daily_cap":
            return Read("retry", "dajiala_daily_cap", retry_at=day_window(now)[1])
        if blocked == "paused":
            return Read("retry", "dajiala_paused", retry_at=collector.bodies_wait(now) or now + RETRY_AFTER)
        link, keys = wechat_mod.article_link(row["url"])
        try:
            detail = await collector.dajiala.article_detail(link)
        except SpendCapReached as capped:
            return Read("retry", "dajiala_daily_cap", retry_at=capped.retry_at)
        except ProviderError as error:
            if error.kind in ("gone", "bad-request"):
                return Read("failed", f"dajiala_{error.kind}:{error.detail}"[:200])
            return Read("retry", f"dajiala_{error.kind}:{error.detail}"[:200])
        nickname = str(detail.get("nick_name") or "").strip()
        biz = str(detail.get("biz") or keys.get("__biz") or "").strip()
        posted = _wechat_time(detail.get("pubtime") or detail.get("post_time")) or _as_utc(row["published_hint"])
        if not _fresh(posted, now):
            return Read("stale", "undated" if posted is None else "older_than_window")
        post = {"url": link, "title": detail.get("title") or row["title"], "digest": detail.get("desc"),
                "post_time": int(posted.timestamp()), "original": detail.get("copyright_stat")}
        registered = next((s for s in sources if s["access"] == "dajiala" and biz
                           and ((s["cursor"] or {}).get("resolved") or {}).get("biz") == biz), None)
        target = registered or lead_source_row(f"wechat:{biz or nickname}", name=nickname or "WeChat", homepage=None,
                                               url="https://mp.weixin.qq.com/", source_type="media", owner=nickname or biz,
                                               egress="api", language="zh")
        entry = wechat_mod.build_entry(post, {"config": (target.get("config") or {}), "name": nickname}, nickname or target.get("name", ""),
                                       now=now, cover=None, detail=detail, alias=str(detail.get("alias") or "") or None)
        if entry is None:
            return Read("failed", "wechat_no_title")
        if registered:
            return Read("fetched", entry=entry, source=registered["id"])
        candidate = candidate_from_lead_read(
            "lead", link, nickname, biz,
            hint={"platform": "wechat", "account": nickname, "biz": biz, "ghid": detail.get("user_name"), "alias": detail.get("alias"),
                  "verified_url": link, "expected_names": [nickname] if nickname else []},
            evidence={"lead_url": row["url"], "trigger": row["trigger"]})
        return Read("fetched", entry=entry, lead_row=target, candidate=candidate)

    # ---------------------------------------------------------------- identifiers

    async def _journal_target(self, issns: list[str], title: str | None, publisher: str | None, sources: list[dict]):
        from .discovery import Candidate

        registered = self.registered_journal(issns, sources)
        if registered:
            return registered["id"], None, None
        issn = next((i.upper() for i in issns if i), None)
        if not issn:
            return None, lead_source_row("journal:unknown", name="Journal articles", homepage=None, url="https://doi.org/",
                                         source_type="journal", owner="journals"), None
        lead_row = lead_source_row(f"issn:{issn}", name=title or issn, homepage=None, url="https://doi.org/", source_type="journal",
                                   owner=publisher or title or issn, egress="api", language="en")
        candidate = Candidate("lead", "journal", f"issn:{issn}", name=title, hint={"issns": issns, "title": title, "publisher": publisher},
                              evidence={"via": "lead"})
        return None, lead_row, candidate

    async def read_doi(self, doi: str | None, sources: list[dict], now: datetime) -> Read:
        from .adapters.common import clean_markup

        if not doi:
            return Read("refused", "not_a_doi")
        result = await self._fetch(f"{self._settings.enrichment.crossref_works}/{quote(doi, safe='/')}", egress="api", api=True)
        message = json.loads(result.body).get("message") or {}
        title = clean_markup((message.get("title") or [""])[0])
        if not title:
            return Read("failed", "no_title")
        journal = (message.get("container-title") or [None])[0]
        issns = [str(i).upper() for i in message.get("ISSN") or []]
        published = _date_parts(message.get("published-online") or message.get("published-print") or message.get("published")
                                or message.get("created"))
        abstract = clean_markup(message.get("abstract") or "", keep_paragraphs=True) or None
        facts = {k: v for k, v in (("journal", journal), ("issn", issns[0] if issns else None),
                                   ("crossref_type", message.get("type"))) if v}
        entry = NormalizedEntry(external_key=f"doi:{doi}", url=message.get("URL") or f"https://doi.org/{doi}", title=title,
                                summary=abstract, published_at=published, date_precision="day", language="en", doi=doi,
                                facts=facts, channel="journal")
        source, lead_row, candidate = await self._journal_target(issns, journal, message.get("publisher"), sources)
        return Read("fetched", entry=entry, source=source, lead_row=lead_row, candidate=candidate)

    async def read_pmid(self, pmid: str | None, sources: list[dict], now: datetime) -> Read:
        if not pmid:
            return Read("refused", "not_a_pmid")
        result = await self._fetch(f"{self._settings.enrichment.pubmed_esummary}?db=pubmed&retmode=json&id={pmid}", egress="api", api=True)
        record = ((json.loads(result.body).get("result") or {}).get(pmid)) or {}
        title = str(record.get("title") or "").strip()
        if not title:
            return Read("failed", "no_title")
        doi = next((normalize_doi(a.get("value")) for a in record.get("articleids") or [] if a.get("idtype") == "doi"), None)
        issns = [v for v in (record.get("issn"), record.get("essn")) if v]
        published = _pubmed_date(record.get("sortpubdate") or record.get("pubdate"))
        entry = NormalizedEntry(external_key=f"pmid:{pmid}", url=f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/", title=title,
                                published_at=published, date_precision="day", language="en", doi=doi, pmid=pmid,
                                facts={k: v for k, v in (("journal", record.get("fulljournalname")), ("issn", issns[0] if issns else None)) if v},
                                channel="journal")
        source, lead_row, candidate = await self._journal_target(issns, record.get("fulljournalname"), None, sources)
        return Read("fetched", entry=entry, source=source, lead_row=lead_row, candidate=candidate)

    async def read_trial(self, nct: str | None, sources: list[dict], now: datetime) -> Read:
        if not nct or not NCT.match(nct):
            return Read("refused", "not_a_trial_number")
        result = await self._fetch(f"{self._settings.enrichment.ctgov_studies}/{nct}", egress="api", api=True)
        protocol = (json.loads(result.body).get("protocolSection") or {})
        ident = protocol.get("identificationModule") or {}
        status = protocol.get("statusModule") or {}
        title = str(ident.get("briefTitle") or ident.get("officialTitle") or "").strip()
        if not title:
            return Read("failed", "no_title")
        results_at = (status.get("resultsFirstPostDateStruct") or {}).get("date")
        updated_at = (status.get("lastUpdatePostDateStruct") or {}).get("date")
        first_at = (status.get("studyFirstPostDateStruct") or {}).get("date")
        event, day = ("results-posted", results_at) if results_at else ("updated", updated_at) if updated_at else ("registered", first_at)
        published = _iso_day(day)
        hint = f"reg:{nct}:{event}:{published.date().isoformat()}" if published else None
        summary = str((protocol.get("descriptionModule") or {}).get("briefSummary") or "").strip()[:4000] or None
        url = f"https://clinicaltrials.gov/study/{nct}"
        entry = NormalizedEntry(external_key=f"{nct}:{event}:{day or ''}", url=url, title=title, summary=summary, published_at=published,
                                date_precision="day", language="en", registry_ids=[nct], identity_hint=hint, channel="registry",
                                facts={k: v for k, v in (("trial_status", status.get("overallStatus")), ("trial_event", event)) if v})
        registered = self.registered_site(url, sources)
        if registered:
            return Read("fetched", entry=entry, source=registered["id"])
        lead_row = lead_source_row("site:clinicaltrials.gov", name="ClinicalTrials.gov", homepage="https://clinicaltrials.gov/",
                                   url="https://clinicaltrials.gov/", source_type="evidence-body", owner="nlm", egress="api",
                                   language="en")
        return Read("fetched", entry=entry, lead_row=lead_row)


def _date_parts(value: Any) -> datetime | None:
    parts = (value or {}).get("date-parts") if isinstance(value, dict) else None
    if not parts or not parts[0]:
        return None
    y, m, d = (list(parts[0]) + [1, 1])[:3]
    try:
        return datetime(int(y), int(m or 1), int(d or 1), tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _pubmed_date(value: Any) -> datetime | None:
    text = str(value or "").strip()
    found = re.match(r"^(\d{4})[/ -](\d{2})[/ -](\d{2})", text)
    if found:
        return datetime(int(found.group(1)), int(found.group(2)), int(found.group(3)), tzinfo=timezone.utc)
    found = re.match(r"^(\d{4})", text)
    return datetime(int(found.group(1)), 1, 1, tzinfo=timezone.utc) if found else None


def _iso_day(value: Any) -> datetime | None:
    text = str(value or "")
    found = re.match(r"^(\d{4})-(\d{2})(?:-(\d{2}))?$", text)
    if not found:
        return None
    return datetime(int(found.group(1)), int(found.group(2)), int(found.group(3) or 1), tzinfo=timezone.utc)


def _wechat_time(value: Any) -> datetime | None:
    """Dajiala's article time: epoch seconds, or Beijing wall time ``YYYY-MM-DD HH:MM[:SS]``."""
    if value is None:
        return None
    text = str(value).strip()
    if text.isdigit():
        seconds = int(text)
        return datetime.fromtimestamp(seconds, tz=timezone.utc) if seconds > 0 else None
    found = re.match(r"^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?", text)
    if not found:
        return None
    y, mo, d, h, mi, s = (int(g or 0) for g in found.groups())
    return datetime(y, mo, d, h, mi, s, tzinfo=SHANGHAI).astimezone(timezone.utc)


async def lead_rows(conn, taken: set[str]) -> list:
    """The lead sources, as registry rows, for the composition (``dynamic_registry``): a row that no longer loads or whose
    id another channel holds is left out."""
    from .registry import RegistryError, parse_registry

    rows = await (await conn.execute("SELECT row FROM evimed_knowledge.lead_sources ORDER BY created_at, id")).fetchall()
    accepted = []
    for row in rows:
        try:
            parsed = parse_registry({"sources": [row["row"]]})[0]
        except (RegistryError, TypeError, KeyError):
            continue
        if parsed.source.id in taken:
            continue
        taken.add(parsed.source.id)
        accepted.append(parsed)
    return accepted


async def leads_health(conn, now: datetime) -> dict:
    """Today's leads (Shanghai day) by state, and how many wait to be read: ``/v1/health`` ``leads``."""
    rows = await (await conn.execute(
        "SELECT state, count(*) AS n FROM evimed_knowledge.leads WHERE day = %s GROUP BY state", (shanghai_day(now),))).fetchall()
    queued = await (await conn.execute("SELECT count(*) AS n FROM evimed_knowledge.leads WHERE state = 'queued'")).fetchone()
    today = {state: 0 for state in ("queued", "fetched", "stale", "failed", "refused")}
    for row in rows:
        today[row["state"]] = int(row["n"])
    return {"today": today, "queued": int(queued["n"])}
