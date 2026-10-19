"""Discover advertised medical subscriptions within an already trusted publisher's scope.

This expands subscription coverage, not the set of trusted institutions. Fetching,
robots, parsing, publication and source health remain the existing plugin's work.
"""
from __future__ import annotations

import hashlib
import ipaddress
import asyncio
from dataclasses import asdict
from datetime import datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlunsplit

from .registry import RegistryRow, parse_registry, RegistryError
from .model import FetchError, RequestSpec

MEDICAL_META = "medical_sources_admitted"
MEDICAL_STATUS = "medical_source_discovery"
MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_PARENTS = 12
MAX_FEEDS_PER_PARENT = 3
MAX_ADMITTED = 200
MEDICAL_CATEGORIES = frozenset({"journal-specialty", "journal-tcm", "journal-pharmacy", "journal-cn",
                               "regulator", "drug-safety", "hta-access", "evidence", "guideline",
                               "public-health", "trial-registry"})


def canonical_feed_url(value: str) -> str | None:
    """Keep meaningful query order; discard only fragments and the default HTTPS port."""
    if not isinstance(value, str) or len(value) > 2048 or any(ord(char) < 32 for char in value):
        return None
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower()
        if parsed.scheme != "https" or not host or parsed.username is not None or parsed.password is not None or parsed.port not in (None, 443):
            return None
        if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
            return None
        try:
            if not ipaddress.ip_address(host).is_global:
                return None
        except ValueError:
            pass
        return urlunsplit(("https", f"[{host}]" if ":" in host else host, parsed.path or "/", parsed.query, ""))
    except ValueError:
        return None


def origin(value: str) -> tuple[str, str, int] | None:
    clean = canonical_feed_url(value)
    return ("https", urlsplit(clean).hostname or "", 443) if clean else None


class _AdvertisedFeeds(HTMLParser):
    def __init__(self, page: str):
        super().__init__(convert_charrefs=True)
        self.page = page
        self.rows: list[dict] = []
        self.seen: set[str] = set()

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "link" or len(self.rows) >= 32:
            return
        attributes = dict(attrs)
        if "alternate" not in (attributes.get("rel") or "").lower().split():
            return
        mime = (attributes.get("type") or "").lower().split(";", 1)[0].strip()
        access = {"application/rss+xml": "rss", "application/atom+xml": "atom"}.get(mime)
        if not access:
            return
        # A page's <base> and links never expand its source's authority.
        try:
            candidate = canonical_feed_url(urljoin(self.page, attributes.get("href") or ""))
        except ValueError:
            return
        if not candidate or origin(candidate) != origin(self.page) or candidate in self.seen:
            return
        self.seen.add(candidate)
        self.rows.append({"url": candidate, "name": (attributes.get("title") or "Subscription")[:100], "access": access})


def advertised_feeds(body: bytes, page: str) -> list[dict]:
    if len(body) > MAX_PAGE_BYTES or not canonical_feed_url(page):
        return []
    parser = _AdvertisedFeeds(page)
    parser.feed(body.decode("utf-8", errors="replace"))
    return parser.rows


def source_urls(row: RegistryRow) -> set[str]:
    config = row.source.config
    values = [config.get("url"), *(config.get("urls") or [])]
    return {url for value in values if isinstance(value, str) and (url := canonical_feed_url(value))}


def eligible_parents(rows: list[RegistryRow], disabled: set[str], *, deduplicate: bool = True) -> list[RegistryRow]:
    excluded = [row for row in rows if row.disabled_reason == "owner_excluded"]
    excluded_owners = {row.source.owner_entity for row in excluded}
    excluded_origins = {origin(row.source.homepage or "") for row in excluded}
    parents, publishers = [], set()
    for row in sorted(rows, key=lambda item: item.source.id):
        source = row.source
        if (not row.enabled or source.id in disabled or row.category not in MEDICAL_CATEGORIES
                or source.platform_produced or source.lane in {"ai", "mixed"}
                or source.source_type not in {"journal", "regulator", "evidence-body", "preprint"}
                or source.egress not in {"direct", "relay"} or source.owner_entity in excluded_owners
                or not origin(source.homepage or "") or origin(source.homepage or "") in excluded_origins):
            continue
        publisher = (source.owner_entity, canonical_feed_url(source.homepage))
        if deduplicate and publisher in publishers:
            continue
        publishers.add(publisher)
        parents.append(row)
    return parents


def feed_row(parent: RegistryRow, candidate: dict) -> dict:
    source = parent.source
    url = canonical_feed_url(candidate["url"])
    if not url or origin(url) != origin(source.homepage or "") or candidate["access"] not in {"rss", "atom"}:
        raise ValueError("medical_feed_scope_invalid")
    return {"id": "medical-discovery-" + hashlib.sha256(url.encode()).hexdigest()[:20],
            "name": f"{source.name} · {candidate.get('name') or 'Subscription'}"[:160],
            "homepage": source.homepage, "lane": source.lane, "source_type": source.source_type,
            "access": candidate["access"], "egress": source.egress, "authority": source.authority,
            "safety_feed": source.safety_feed, "owner_entity": source.owner_entity, "launch_tier": source.launch_tier,
            "language": source.language, "region": source.region, "poll_floor_s": max(21600, source.poll_floor_s),
            "poll_ceiling_s": max(86400, source.poll_ceiling_s), "category": parent.category,
            "enabled": True, "disabled_reason": None,
            "config": {"url": url, "allowed_hosts": [urlsplit(url).hostname], "max_pages": 1,
                       "api": False, "same_origin_redirects": True, "medical_parent": source.id}}


def medical_rows(document: dict, base: list[RegistryRow], disabled: set[str]) -> list[RegistryRow]:
    """Revalidate durable children against current parent/exclusion and operator policy."""
    parents = {row.source.id: row for row in eligible_parents(base, disabled, deduplicate=False)}
    known_urls = set().union(*(source_urls(row) for row in base)) if base else set()
    accepted = []
    for raw in document.get("sources", [])[:MAX_ADMITTED]:
        if not isinstance(raw, dict) or not isinstance(raw.get("config"), dict):
            continue
        parent = parents.get(raw["config"].get("medical_parent"))
        url = canonical_feed_url(raw["config"].get("url"))
        if not parent or not url or url in known_urls:
            continue
        try:
            expected = feed_row(parent, {"url": url, "name": "Subscription", "access": raw.get("access")})
            # Identity stays bound to the admitted URL and parent. Mutable authority,
            # cadence and transport always come from today's trusted registry.
            if raw.get("id") != expected["id"]:
                continue
            expected["name"] = raw.get("name") or expected["name"]
            row = parse_registry({"sources": [expected]})[0]
            if row.source.id in disabled:
                continue
            accepted.append(row)
            known_urls.add(url)
        except (RegistryError, ValueError, TypeError, KeyError):
            continue
    return accepted


async def discover_parent(fetcher, parent: RegistryRow, known_urls: set[str], now: datetime) -> tuple[list[dict], list[dict]]:
    """Probe advertised feeds through the real fetch/parser boundary, without writing articles."""
    from .adapters.feed import FeedAdapter
    from .normalize import prepare, Rejected

    homepage = canonical_feed_url(parent.source.homepage or "")
    if not homepage:
        return [], [{"parent": parent.source.id, "status": "deferred", "reason": "homepage_invalid"}]
    accepted, observations = [], []
    try:
        page = await fetcher.fetch(RequestSpec(url=homepage, conditional=False, same_origin_redirects=True),
                                   source_id=parent.source.id, egress=parent.source.egress,
                                   allowed_hosts=[urlsplit(homepage).hostname])
        if page.status != 200 or origin(page.final_url) != origin(homepage):
            return [], [{"parent": parent.source.id, "status": "deferred", "reason": "homepage_unavailable"}]
        candidates = advertised_feeds(page.body, page.final_url)
    except FetchError as error:
        return [], [{"parent": parent.source.id, "status": "deferred", "reason": f"{error.outcome}:{error.detail}"}]
    probed = 0
    for candidate in candidates:
        if candidate["url"] in known_urls:
            observations.append({"parent": parent.source.id, "status": "duplicate"})
            continue
        if probed >= MAX_FEEDS_PER_PARENT:
            break
        probed += 1
        try:
            row = feed_row(parent, candidate)
            parsed_source = parse_registry({"sources": [row]})[0].source
            feed = await fetcher.fetch(RequestSpec(url=candidate["url"], conditional=False, same_origin_redirects=True),
                                       source_id=parent.source.id, egress=parent.source.egress,
                                       allowed_hosts=[urlsplit(candidate["url"]).hostname])
            final_url = canonical_feed_url(feed.final_url)
            if not final_url or origin(final_url) != origin(homepage):
                raise ValueError("feed_origin_changed")
            if final_url in known_urls:
                observations.append({"parent": parent.source.id, "status": "duplicate"})
                continue
            if len(feed.body) > MAX_PAGE_BYTES:
                raise ValueError("feed_too_large")
            candidate = {**candidate, "url": final_url}
            row = feed_row(parent, candidate)
            parsed_source = parse_registry({"sources": [row]})[0].source
            parsed = FeedAdapter(candidate["access"]).parse(feed, parsed_source, now)
            valid = 0
            for entry in parsed.entries[:20]:
                try:
                    prepare(entry, parsed_source)
                    valid += 1
                except Rejected:
                    continue
            if valid == 0:
                observations.append({"parent": parent.source.id, "status": "deferred", "reason": "feed_has_no_usable_entries"})
                continue
            accepted.append(row)
            known_urls.add(final_url)
            observations.append({"parent": parent.source.id, "source": row["id"], "status": "validated",
                                 "sampleEntries": valid, "bodySha256": hashlib.sha256(feed.body).hexdigest()})
        except (FetchError, RegistryError, ValueError, TypeError, KeyError) as error:
            reason = f"{error.outcome}:{error.detail}" if isinstance(error, FetchError) else type(error).__name__
            observations.append({"parent": parent.source.id, "status": "deferred", "reason": reason})
    if not candidates:
        observations.append({"parent": parent.source.id, "status": "unchanged", "reason": "no_advertised_feed"})
    return accepted, observations


async def run_daily_discovery(settings, pool, fetcher, clock) -> dict:
    """One bounded daily publisher rotation; admissions become ordinary scheduler work."""
    from .db import meta_get, meta_set
    from .dynamic_registry import disabled_sources, lock_registry, sync_dynamic_registry
    from .registry import load_registry

    started = clock()
    day = started.astimezone(ZoneInfo("Asia/Shanghai")).date().isoformat()
    nonce = uuid4().hex
    async with pool.connection() as conn:
        async with conn.transaction():
            await lock_registry(conn)
            base = load_registry(settings.registry_path)
            await sync_dynamic_registry(conn, base, started)
            previous = await meta_get(conn, MEDICAL_STATUS) or {}
            if previous.get("completedDay") == day:
                return {"status": "already_checked", "day": day}
            if previous.get("leaseUntil") and datetime.fromisoformat(previous["leaseUntil"]) > started:
                return {"status": "running", "day": day}
            parents = eligible_parents(base, await disabled_sources(conn))
            stored = await (await conn.execute(
                "SELECT config FROM evimed_knowledge.sources WHERE retired_at IS NULL "
                "OR operator_enabled=false OR disabled_reason='owner_excluded'"
            )).fetchall()
            known_urls = set().union(*(source_urls(row) for row in base)) if base else set()
            for row in stored:
                config = row["config"] or {}
                for value in [config.get("url"), *(config.get("urls") or [])]:
                    if clean := canonical_feed_url(value):
                        known_urls.add(clean)
            cursor = int(previous.get("cursor", 0)) % max(1, len(parents))
            await meta_set(conn, MEDICAL_STATUS, {**previous, "status": "running", "runId": nonce,
                                                 "startedAt": started.isoformat(),
                                                 "leaseUntil": (started + timedelta(minutes=5)).isoformat()})
    selected = (parents[cursor:] + parents[:cursor])[:MAX_PARENTS]
    candidates, observations = [], []
    visited = 0
    status = "complete"
    canceled = False
    try:
        async with asyncio.timeout(150):
            for parent in selected:
                visited += 1
                accepted, recorded = await discover_parent(fetcher, parent, known_urls, clock())
                candidates.extend(accepted)
                observations.extend(recorded)
    except asyncio.CancelledError:
        canceled = True
        status = "interrupted"
    except TimeoutError:
        status = "partial"
        observations.append({"status": "deferred", "reason": "cycle_deadline"})
    except Exception as error:
        status = "partial"
        observations.append({"status": "deferred", "reason": type(error).__name__})
    async with pool.connection() as conn:
        async with conn.transaction():
            await lock_registry(conn)
            current = await meta_get(conn, MEDICAL_STATUS) or {}
            if current.get("runId") != nonce:
                if canceled:
                    raise asyncio.CancelledError
                return {"status": "superseded", "day": day}
            fresh_base = load_registry(settings.registry_path)
            saved = await meta_get(conn, MEDICAL_META) or {"sources": []}
            disabled = await disabled_sources(conn)
            held = medical_rows(saved, fresh_base, disabled)
            known_ids = {row.source.id for row in held}
            additions = [] if canceled else [row for row in medical_rows({"sources": candidates}, fresh_base, disabled)
                                             if row.source.id not in known_ids]
            combined = (held + additions)[:MAX_ADMITTED]
            permitted = {row.source.id for row in combined}
            admitted = [row for row in additions if row.source.id in permitted]
            # Historical sources remain retired in the source table; only active
            # validated subscriptions consume the discovery registry's capacity.
            await meta_set(conn, MEDICAL_META, {"sources": [
                {**asdict(row.source), "enabled": row.enabled, "disabled_reason": row.disabled_reason,
                 "category": row.category} for row in combined
            ]})
            await sync_dynamic_registry(conn, fresh_base, clock())
            report = {"status": status, "day": day, "checkedAt": clock().isoformat(), "parents": visited,
                      "advertisedCandidatesValidated": len(candidates), "admittedFeeds": len(admitted),
                      "newInstitutions": 0, "capacityDeferred": max(0, len(held) + len(additions) - MAX_ADMITTED),
                      "items": observations}
            history = [*current.get("history", []), report][-30:]
            await meta_set(conn, MEDICAL_STATUS, {"status": status, "runId": nonce, "startedAt": started.isoformat(),
                                                 "leaseUntil": None, "cursor": (cursor + visited) % max(1, len(parents)),
                                                 "completedDay": day if status == "complete" else previous.get("completedDay"),
                                                 "last": report, "history": history})
    if canceled:
        raise asyncio.CancelledError
    return report
