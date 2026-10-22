"""Automatic source discovery: candidates → validation → seven-day trial → admission, with the lifecycle beside it.

The owner's target (2026-10-22) is at least ten net new working sources a day, sustained, where net is admitted minus
retired and working means the source produced a new entry during its trial. Nothing here lowers the bar to make the
count: a source is admitted only when it is fetched within robots rules, an existing adapter reads it, it produced a
fresh item after we started watching it, and it is medical — by data (a MEDLINE journal, a curated directory, a
request) or by the platform's own screen of what it delivered during its trial.

The candidate lines (``discovery_lines.py``), each with its own daily cap on validations:

- ``outbound``   sites linked from recent entries' pages (institutions, hospitals, societies, newsrooms);
- ``journal``    MEDLINE journals not in the registry: ISSNs seen in the literature streams first, then the NLM
                 catalogue in rotation; admitted as a ``crossref-issn`` row, the same adapter the 154 journals use;
- ``directory``  organisations listed in ``registry/discovery.json`` (regulators, agencies, hospitals, societies, media);
- ``hot-origin`` the origins of entries several publishers carried in the last two days (a DOI's journal, a site);
- ``social``     accounts quoted or reposted in social entries (their adapters are another package's; a candidate
                 waits while this build has none for its platform);
- ``request``    rows asked for in the platform's public source-request manifest, any lane, validated like the rest;
- ``parent-feed`` the advertised feeds of trusted publishers (``medical_discovery.py``, counted here);
- ``readmit``    retired sources due for a re-check.

Validation, in order: reachable (direct, then through the Tokyo relay when this deployment has one), robots allows it
(the protected fetch asks), an existing adapter parses it, at least one item dated within the last 30 days, and the
medical basis when there is one in data. No content model call is made here — the plugin makes none (contract): the
language judgement "is this medical" is the platform's screen, which already reads every entry the plugin delivers
(``deepseek-flash``, purpose ``frontier``, its daily budget) and reports its verdicts per source back to the plugin
(``POST /v1/sources/screening``). A trial source is an ordinary registry row polled at a low rate (every 6–24 hours);
its entries reach the platform like any other source's and are screened there.

The day is Shanghai's. Each run (hourly) applies the retirements once a day, decides the trials that ended, gathers
candidates once a day, and validates pending candidates within each line's remaining cap and a time budget; a run cut
short resumes on the next tick. Every transition adds one to its column in ``discovery_daily`` (``/v1/health``
``discovery``).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from itertools import zip_longest
from pathlib import Path
from typing import Any
from urllib.parse import quote, urljoin, urlsplit, urlunsplit
from uuid import uuid4
from zoneinfo import ZoneInfo

from psycopg.types.json import Jsonb

from .lifecycle import (RECHECK_AFTER, TRIAL_DAYS, TrialFacts, retirement_plan, screening_of, trial_verdict)
from .model import FetchError, RequestSpec, SourceState
from .registry import RegistryError, parse_registry, source_from_row

log = logging.getLogger("knowledge_plugin.discovery")

LINES = ("outbound", "journal", "directory", "hot-origin", "social", "request", "parent-feed", "readmit")
# Validations a line may spend a day, sized from the yields measured on 2026-10-22 over a day of production entries
# (handoff fr-sources): journals 41 of 60 validated (MEDLINE, ≥ 8 articles in 30 days), directories 10 of 60, outbound
# sites 2–8 of 60 (a third or fewer of them medical by the screen). At these caps ~115–205 candidates are validated a
# day and about 15–20 admitted, most of them journals.
DEFAULT_CAPS = {"outbound": 60, "journal": 25, "directory": 30, "hot-origin": 15, "social": 20, "request": 25,
                "readmit": 30}
# Discovered journals are read through Crossref, whose daily allowance the registry's journals share (budget.py): the
# journal line waits for tomorrow while today's use is past this share of the cap.
CROSSREF_HOST = "api.crossref.org"
CROSSREF_SHARE = 0.8
DEFAULT_OUTBOUND_PAGES = 120          # article pages the outbound line reads a day to find the sites they link to
STATUS_KEY = "source_discovery"
SHANGHAI = ZoneInfo("Asia/Shanghai")
FRESH_DAYS = 30
FAILED_RETRY_AFTER = timedelta(days=30)
DEFERRED_RETRY_AFTER = timedelta(days=7)
RUN_DEADLINE_S = 900.0
VALIDATION_CONCURRENCY = 6
TRIAL_FLOOR_S = 21600
TRIAL_CEILING_S = 86400
JOURNAL_FLOOR_S = 43200
JOURNAL_MIN_ARTICLES_30D = 8
COMMON_FEED_PATHS = ("/feed", "/rss.xml", "/feed.xml", "/rss", "/atom.xml", "/index.xml", "/news/rss.xml")
MAX_FEED_TRIES = 3
MAX_PAGE_BYTES = 2 * 1024 * 1024
DATA_PATH = Path(__file__).resolve().parent.parent / "registry" / "discovery.json"
CROSSREF = "https://api.crossref.org"
EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
SOCIAL_PLATFORMS = ("x", "wechat")


def shanghai_day(now: datetime) -> str:
    return now.astimezone(SHANGHAI).date().isoformat()


def parse_caps(raw: str | None) -> dict[str, int]:
    """``KNOWLEDGE_PLUGIN_DISCOVERY_CAPS`` (``line=n,line=n``) over the defaults; unknown lines and bad numbers are
    ignored by name in the log, never guessed."""
    caps = dict(DEFAULT_CAPS)
    for part in (raw or "").split(","):
        name, sep, value = part.strip().partition("=")
        if not sep:
            continue
        if name not in caps or not value.strip().isdigit():
            log.warning("discovery cap %r ignored", part.strip())
            continue
        caps[name] = min(int(value), 1000)
    return caps


# ------------------------------------------------------------------------------------ pure helpers


def canonical_site(value: Any) -> str | None:
    """``scheme://host/`` of a public http(s) URL, or ``None``."""
    if not isinstance(value, str) or len(value) > 2048:
        return None
    try:
        parts = urlsplit(value.strip())
    except ValueError:
        return None
    host = (parts.hostname or "").lower().rstrip(".")
    if parts.scheme not in ("http", "https") or not host or "." not in host or parts.username or parts.password:
        return None
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")) or host.replace(".", "").isdigit():
        return None
    if parts.port not in (None, 80, 443):
        return None
    return f"{parts.scheme}://{host}/"


def canonical_url(value: Any) -> str | None:
    """A public http(s) URL without its fragment (query kept), or ``None``."""
    site = canonical_site(value)
    if not site:
        return None
    parts = urlsplit(value.strip())
    return urlunsplit((parts.scheme, (parts.hostname or "").lower(), parts.path or "/", parts.query, ""))


def host_of(url: str | None) -> str:
    try:
        return (urlsplit(url or "").hostname or "").lower().rstrip(".")
    except ValueError:
        return ""


def site_family(host: str) -> str:
    """The host without a leading ``www.``: ``www.cdc.gov`` and ``tools.cdc.gov`` are one family below ``cdc.gov``."""
    return host[4:] if host.startswith("www.") else host


def host_matches(host: str, names: set[str]) -> bool:
    """``host`` is one of ``names`` or below one of them (``news.example.org`` below ``example.org``)."""
    parts = host.split(".")
    return any(".".join(parts[i:]) in names for i in range(len(parts) - 1))


def candidate_id(key: str) -> str:
    return "cand-" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]


def discovered_source_id(url: str) -> str:
    return "discovered-" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:20]


def load_data(path: Path = DATA_PATH) -> dict:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        log.error("discovery data %s is unreadable; directories and exclusions are empty", path)
        return {"exclude_hosts": [], "directories": []}
    return {"exclude_hosts": [h.lower() for h in document.get("exclude_hosts", []) if isinstance(h, str)],
            "directories": [d for d in document.get("directories", []) if isinstance(d, dict)]}


@dataclass
class Candidate:
    """What a line proposes. ``kind``: ``site`` (a homepage to probe for a feed), ``feed`` (a feed URL), ``journal``
    (``key`` = ``issn:<ISSN>``), ``social`` (``key`` = ``<platform>:<account>``), ``row`` (a requested registry row),
    ``source`` (a retired source, ``key`` = ``source:<id>``). ``hint`` carries what the line knows about it (type,
    category, lane, region, language, owner, ISSNs, the requested row)."""

    line: str
    kind: str
    key: str
    name: str | None = None
    medical_basis: str | None = None
    hint: dict = field(default_factory=dict)
    evidence: dict = field(default_factory=dict)


def site_row(url: str, *, access: str, egress: str, name: str, homepage: str, hint: dict, language: str | None,
             line: str) -> dict:
    """A registry row for a discovered subscription feed: a ``mixed`` lane (the platform's screen decides each entry),
    the type and owner the line knew or the host, and the trial cadence."""
    host = host_of(url)
    return {
        "id": discovered_source_id(url), "name": name[:160] or host, "homepage": homepage,
        "lane": hint.get("lane") or "mixed", "source_type": hint.get("source_type") or "media", "access": access,
        "egress": egress, "authority": int(hint.get("authority") or 2), "safety_feed": False,
        "owner_entity": (hint.get("owner_entity") or site_family(host_of(homepage) or host))[:200],
        "launch_tier": "P2", "language": hint.get("language") or language, "region": hint.get("region"),
        "poll_floor_s": TRIAL_FLOOR_S, "poll_ceiling_s": TRIAL_CEILING_S, "enabled": True, "disabled_reason": None,
        "category": hint.get("category") or f"discovered-{line}",
        "config": {"url": url, "allowed_hosts": [host], "max_pages": 1},
    }


def journal_row(issns: list[str], *, title: str, publisher: str | None, medical_basis: str | None) -> dict:
    """A ``crossref-issn`` row, the template of the registry's journals (``tools/build_registry.py``)."""
    issn = issns[0]
    return {
        "id": f"j-{issn.lower()}", "name": title[:160], "homepage": None, "lane": "evidence", "source_type": "journal",
        "access": "crossref-issn", "egress": "direct", "authority": 3 if medical_basis == "medline" else 2,
        "safety_feed": False, "owner_entity": (publisher or title)[:200], "launch_tier": "P2", "language": "en",
        "region": "INT", "poll_floor_s": JOURNAL_FLOOR_S, "poll_ceiling_s": TRIAL_CEILING_S, "enabled": True,
        "disabled_reason": None, "category": "journal-discovered",
        "config": {
            "url": ("https://api.crossref.org/journals/{issn}/works?filter=from-created-date:{since:%Y-%m-%d},"
                    "type:journal-article&rows=100&sort=created&order=desc&select=DOI,title,created,published,type,"
                    "update-to,abstract,author,container-title&cursor={cursor}"),
            "issn": issn, "issns": issns, "cursor_start": "*", "page_size": 100, "max_pages": 3, "lookback_days": 7,
            "overlap_days": 1, "incremental": True, "allowed_hosts": ["api.crossref.org"],
        },
    }


def advertised_feed_links(body: bytes, page_url: str) -> list[dict]:
    """``<link rel="alternate" type="application/rss+xml|atom+xml">`` on a page, kept to the page's own site family
    (a page's links never name another site's feed as its own)."""
    from html.parser import HTMLParser

    family = site_family(host_of(page_url))
    found: list[dict] = []

    class Links(HTMLParser):
        def handle_starttag(self, tag, attrs):
            if tag.lower() != "link" or len(found) >= 16:
                return
            attributes = dict(attrs)
            if "alternate" not in (attributes.get("rel") or "").lower().split():
                return
            mime = (attributes.get("type") or "").lower().split(";", 1)[0].strip()
            access = {"application/rss+xml": "rss", "application/atom+xml": "atom"}.get(mime)
            url = canonical_url(urljoin(page_url, attributes.get("href") or "")) if access else None
            if not url or not host_matches(host_of(url), {family}) or any(f["url"] == url for f in found):
                return
            found.append({"url": url, "access": access, "title": (attributes.get("title") or "").strip()[:100]})

    if len(body) <= MAX_PAGE_BYTES:
        parser = Links(convert_charrefs=True)
        try:
            parser.feed(body.decode("utf-8", errors="replace"))
        except Exception:  # a page that breaks the parser has no feed we can trust
            return []
    return found


def page_title(body: bytes) -> str | None:
    from selectolax.parser import HTMLParser

    try:
        node = HTMLParser(body[:MAX_PAGE_BYTES].decode("utf-8", errors="replace")).css_first("title")
    except Exception:
        return None
    text = " ".join((node.text() if node else "").split())
    return text[:160] or None


# ------------------------------------------------------------------------------------ the candidate store


async def count(conn, day: str, line: str, **columns: int) -> None:
    """Add to a line's counts for the day (``discovery_daily``)."""
    names = [name for name, value in columns.items() if value]
    if not names:
        return
    assignments = ", ".join(f"{name} = d.{name} + EXCLUDED.{name}" for name in names)
    await conn.execute(
        f"""INSERT INTO evimed_knowledge.discovery_daily AS d (day, line, {", ".join(names)})
            VALUES (%s, %s, {", ".join(["%s"] * len(names))})
            ON CONFLICT (day, line) DO UPDATE SET {assignments}""",
        (day, line, *[int(columns[name]) for name in names]),
    )


async def upsert_candidates(conn, candidates: list[Candidate], now: datetime, day: str) -> dict[str, int]:
    """Store what the lines found: a new key is a candidate (counted); a key seen before adds a sighting; a failed one
    older than 30 days is a candidate again (counted again)."""
    added: dict[str, int] = {}
    for candidate in candidates:
        row = await (await conn.execute(
            """INSERT INTO evimed_knowledge.source_candidates AS c
                 (id, line, key, name, first_seen_at, last_seen_at, evidence, state, state_at, medical_basis)
               VALUES (%(id)s, %(line)s, %(key)s, %(name)s, %(now)s, %(now)s, %(evidence)s, 'candidate', %(now)s, %(basis)s)
               ON CONFLICT (key) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, sightings = c.sightings + 1,
                 medical_basis = coalesce(c.medical_basis, EXCLUDED.medical_basis),
                 state = CASE WHEN c.state = 'failed' AND c.state_at < %(retry)s THEN 'candidate' ELSE c.state END,
                 state_reason = CASE WHEN c.state = 'failed' AND c.state_at < %(retry)s THEN NULL ELSE c.state_reason END,
                 attempts = CASE WHEN c.state = 'failed' AND c.state_at < %(retry)s THEN 0 ELSE c.attempts END,
                 state_at = CASE WHEN c.state = 'failed' AND c.state_at < %(retry)s THEN EXCLUDED.state_at ELSE c.state_at END
               RETURNING (xmax = 0) AS inserted, state, state_at = %(now)s AS reopened""",
            {"id": candidate_id(candidate.key), "line": candidate.line, "key": candidate.key,
             "name": (candidate.name or "")[:200] or None, "now": now, "basis": candidate.medical_basis,
             "evidence": Jsonb({**candidate.evidence, "kind": candidate.kind, "hint": candidate.hint}),
             "retry": now - FAILED_RETRY_AFTER},
        )).fetchone()
        if row["inserted"] or row["reopened"]:
            added[candidate.line] = added.get(candidate.line, 0) + 1
    for line, n in added.items():
        await count(conn, day, line, candidates=n)
    return added


async def known_urls_and_hosts(conn, base=()) -> tuple[set[str], set[str], set[str]]:
    """Every URL and host the registry already reads (any state, retired included: a retired source comes back by its
    re-check, not as a new candidate) — the source table and the registry file's rows (``base``) —, the ISSNs of its
    journals, and the hosts of owner-excluded rows."""
    rows = [dict(r) for r in await (await conn.execute(
        "SELECT id, homepage, config, disabled_reason FROM evimed_knowledge.sources",
    )).fetchall()]
    rows += [{"id": row.source.id, "homepage": row.source.homepage, "config": row.source.config,
              "disabled_reason": row.disabled_reason} for row in base]
    urls: set[str] = set()
    issns: set[str] = set()
    excluded: set[str] = set()
    for row in rows:
        config = row["config"] or {}
        for value in [config.get("url"), *(config.get("urls") or []), row["homepage"]]:
            if clean := canonical_url(value):
                urls.add(clean)
        for value in [config.get("issn"), *(config.get("issns") or [])]:
            if isinstance(value, str) and value:
                issns.add(value.upper())
        if row["disabled_reason"] == "owner_excluded":
            for value in (row["homepage"], config.get("url")):
                if host := host_of(value):
                    excluded.add(site_family(host))
    candidate_rows = await (await conn.execute(
        "SELECT key, row FROM evimed_knowledge.source_candidates WHERE row IS NOT NULL",
    )).fetchall()
    for row in candidate_rows:
        config = (row["row"] or {}).get("config") or {}
        if clean := canonical_url(config.get("url")):
            urls.add(clean)
        for value in config.get("issns") or []:
            issns.add(str(value).upper())
    return urls, issns, excluded


# ------------------------------------------------------------------------------------ validation


@dataclass
class Probe:
    ok: bool
    reason: str | None = None
    egress: str = "direct"
    url: str | None = None
    entries: int = 0
    fresh: int = 0
    newest: datetime | None = None
    titles: list[str] = field(default_factory=list)
    language: str | None = None
    feed_title: str | None = None
    feed_link: str | None = None


@dataclass
class Verdict:
    status: str                 # 'trial' | 'admitted' (readmit) | 'failed' | 'deferred'
    reason: str | None = None
    row: dict | None = None
    validation: dict = field(default_factory=dict)
    medical_basis: str | None = None


class Validator:
    """Probes a candidate through the protected fetch (robots, budgets, pinning, the address policy), exactly as a poll
    would read it, and builds the registry row. Writes nothing."""

    def __init__(self, fetcher, settings, now: datetime, *, known_urls: set[str], known_issns: set[str],
                 excluded_hosts: set[str], adapters: dict | None = None) -> None:
        if adapters is None:
            from .adapters import REGISTRY as adapters
        self.fetcher = fetcher
        self.settings = settings
        self.now = now
        self.known_urls = known_urls
        self.known_issns = known_issns
        self.excluded_hosts = excluded_hosts
        self.adapters = adapters
        self.relay = bool(getattr(fetcher, "egress_configured", lambda _e: False)("relay"))

    async def fetch(self, url: str, *, egress: str, api: bool = False, allowed: list[str] | None = None):
        spec = RequestSpec(url=url, conditional=False, api=api)
        return await self.fetcher.fetch(spec, source_id="discovery", egress=egress,
                                        allowed_hosts=allowed or [host_of(url)])

    async def fetch_page(self, url: str) -> tuple[Any, str]:
        """A page through ``direct``, then once through the relay when the site refused or did not answer Beijing.
        Raises the direct exit's ``FetchError`` when neither read it."""
        try:
            return await self.fetch(url, egress="direct"), "direct"
        except FetchError as error:
            if not self.relay or error.outcome not in ("blocked", "challenge", "timeout", "http-error"):
                raise
            try:
                return await self.fetch(url, egress="relay"), "relay"
            except FetchError:
                raise error from None

    def probe_parsed(self, source, result) -> Probe:
        """Parse a response with the source's adapter and count what is fresh (dated within 30 days, not ahead)."""
        from .normalize import Rejected, prepare

        adapter = self.adapters.get(source.access)
        if adapter is None:
            return Probe(False, "adapter_unavailable")
        try:
            output = adapter.parse(result, source, self.now)
        except FetchError as error:
            return Probe(False, f"unreadable:{error.detail}")
        except Exception as error:  # an adapter crash on a stranger's page is that page's failure
            return Probe(False, f"unreadable:{type(error).__name__}")
        horizon = self.now - timedelta(days=FRESH_DAYS)
        ahead = self.now + timedelta(days=2)
        probe = Probe(True, entries=len(output.entries))
        languages: dict[str, int] = {}
        for entry in output.entries[:200]:
            try:
                item = prepare(entry, source)
            except Rejected:
                continue
            published = item.raw_published_at
            if published is not None and horizon <= published <= ahead:
                probe.fresh += 1
                probe.newest = max(probe.newest or published, published)
                if len(probe.titles) < 5:
                    probe.titles.append(item.title[:160])
            if item.language and item.language != "und":
                languages[item.language] = languages.get(item.language, 0) + 1
        probe.language = max(languages, key=languages.get) if languages else None
        if probe.entries == 0:
            probe.ok, probe.reason = False, "no_entries"
        elif probe.fresh == 0:
            probe.ok, probe.reason = False, "no_fresh_items"
        return probe

    async def probe_feed(self, url: str, access: str, *, egress: str | None = None) -> Probe:
        from .model import SourceConfig

        host = host_of(url)
        if host_matches(host, self.excluded_hosts):
            return Probe(False, "excluded")
        try:
            result, used = (await self.fetch(url, egress=egress), egress) if egress else await self.fetch_page(url)
        except FetchError as error:
            return Probe(False, f"{error.outcome}:{error.detail}")
        if result.status != 200:
            return Probe(False, f"http_{result.status}")
        source = SourceConfig(id="discovery-probe", name="probe", homepage=None, lane="mixed", source_type="media",
                              access=access, egress=used, authority=2, safety_feed=False, owner_entity=host,
                              launch_tier="P2", language=None, region=None, poll_floor_s=TRIAL_FLOOR_S,
                              poll_ceiling_s=TRIAL_CEILING_S, config={"url": url, "allowed_hosts": [host]})
        probe = self.probe_parsed(source, result)
        probe.egress, probe.url = used, canonical_url(result.final_url) or url
        try:
            import feedparser

            meta = feedparser.parse(result.body).feed
            probe.feed_title = " ".join(str(meta.get("title") or "").split())[:160] or None
            probe.feed_link = canonical_url(meta.get("link"))
        except Exception:
            pass
        return probe

    async def validate(self, candidate: dict) -> Verdict:
        evidence = candidate.get("evidence") or {}
        kind = evidence.get("kind")
        hint = evidence.get("hint") or {}
        try:
            if kind in ("site", "feed"):
                return await self.validate_site(candidate, kind, hint)
            if kind == "journal":
                return await self.validate_journal(candidate, hint)
            if kind == "row":
                return await self.validate_row(candidate, hint)
            if kind == "social":
                return self.validate_social(candidate, hint)
        except FetchError as error:
            if error.outcome == "host-budget":
                return Verdict("deferred", "host_budget")
            return Verdict("failed", f"{error.outcome}:{error.detail}")
        except (ValueError, KeyError, TypeError, AttributeError) as error:
            # An answer that is not what the provider documents (an HTML error page for JSON): this candidate's
            # failure, named, never the run's.
            return Verdict("failed", f"answer_invalid:{type(error).__name__}")
        return Verdict("failed", "unknown_kind")

    async def validate_site(self, candidate: dict, kind: str, hint: dict) -> Verdict:
        key = candidate["key"]
        if host_matches(host_of(key), self.excluded_hosts):
            return Verdict("failed", "excluded")
        feeds: list[dict] = []
        homepage = canonical_site(key) if kind == "site" else canonical_site(hint.get("homepage") or key)
        site_title = None
        if kind == "feed":
            feeds = [{"url": key, "access": hint.get("access") or "rss", "title": ""}]
        else:
            page_url = hint.get("homepage") or key
            try:
                page, _exit = await self.fetch_page(page_url)
            except FetchError as error:
                if error.outcome == "host-budget":
                    return Verdict("deferred", "host_budget")
                return Verdict("failed", f"unreachable:{error.outcome}:{error.detail}")
            site_title = page_title(page.body)
            feeds = advertised_feed_links(page.body, page.final_url)
            if not feeds:
                base = canonical_site(page.final_url) or homepage
                feeds = [{"url": base.rstrip("/") + path, "access": "rss", "title": "", "guessed": True}
                         for path in COMMON_FEED_PATHS[:MAX_FEED_TRIES]]
        tried: list[dict] = []
        for feed in feeds[:MAX_FEED_TRIES]:
            url = feed["url"]
            if url in self.known_urls:
                tried.append({"url": url, "reason": "known"})
                continue
            probe = await self.probe_feed(url, feed["access"])
            if probe.url and probe.url != url and probe.url in self.known_urls:
                tried.append({"url": url, "reason": "known"})
                continue
            tried.append({"url": url, "reason": probe.reason, "fresh": probe.fresh, "entries": probe.entries})
            if not probe.ok:
                continue
            access = feed["access"]
            if probe.reason is None and feed.get("guessed"):
                access = "atom" if "atom" in url else "rss"
            final = probe.url or url
            name = hint.get("name") or probe.feed_title or site_title or host_of(final)
            if feed.get("title") and hint.get("name") and feed["title"].lower() not in ("rss", "atom", "feed"):
                name = f"{hint['name']} · {feed['title']}"
            row = site_row(final, access=access, egress=probe.egress, name=name,
                           homepage=homepage or probe.feed_link or canonical_site(final), hint=hint,
                           language=probe.language, line=candidate["line"])
            try:
                parse_registry({"sources": [row]})
            except RegistryError as error:
                tried[-1]["reason"] = f"row_invalid:{error.problems[0][:80]}"
                continue
            return Verdict("trial", None, row, {"exit": probe.egress, "feed": final, "fresh": probe.fresh,
                                                "entries": probe.entries, "titles": probe.titles, "tried": tried,
                                                "newest": probe.newest.isoformat() if probe.newest else None},
                           candidate.get("medical_basis"))
        reasons = [t["reason"] for t in tried if t.get("reason")]
        if reasons and all(r == "known" for r in reasons):
            return Verdict("failed", "known", validation={"tried": tried})
        if any((r or "").startswith("robots-denied") for r in reasons):
            return Verdict("failed", "robots", validation={"tried": tried})
        guessed = any(f.get("guessed") for f in feeds)
        fresh_fail = next((r for r in reasons if r in ("no_fresh_items", "no_entries")), None)
        return Verdict("failed", fresh_fail or ("no_feed" if guessed else "feed_unreadable"), validation={"tried": tried})

    async def validate_journal(self, candidate: dict, hint: dict) -> Verdict:
        issns = [i.upper() for i in hint.get("issns") or [candidate["key"].split(":", 1)[1]]]
        if any(i in self.known_issns for i in issns):
            return Verdict("failed", "known")
        basis = candidate.get("medical_basis")
        if basis != "medline":
            term = quote("(" + " OR ".join(f'"{i}"[ISSN]' for i in issns[:2]) + ") AND currentlyindexed[All]")
            listing = await self.fetch(f"{EUTILS}/esearch.fcgi?db=nlmcatalog&retmode=json&retmax=1&term={term}",
                                       egress="api", api=True)
            found = int((json.loads(listing.body).get("esearchresult") or {}).get("count") or 0)
            if not found:
                return Verdict("failed", "not_medline")
            basis = "medline"
        since = (self.now - timedelta(days=FRESH_DAYS)).date().isoformat()
        volume, title, publisher, chosen = None, hint.get("title"), hint.get("publisher"), None
        for issn in issns[:2]:
            try:
                works = await self.fetch(f"{CROSSREF}/journals/{issn}/works?filter=from-created-date:{since},"
                                         "type:journal-article&rows=0", egress="api", api=True)
            except FetchError as error:
                if error.status == 404:
                    continue
                raise
            volume = int(json.loads(works.body).get("message", {}).get("total-results") or 0)
            chosen = issn
            try:
                meta = await self.fetch(f"{CROSSREF}/journals/{issn}", egress="api", api=True)
                message = json.loads(meta.body).get("message") or {}
                title = title or message.get("title")
                publisher = publisher or message.get("publisher")
                issns = sorted({*issns, *[i.upper() for i in message.get("ISSN") or []]},
                               key=lambda value: (value != issn, value))
            except (FetchError, ValueError):
                pass
            break
        if chosen is None:
            return Verdict("failed", "not_in_crossref", medical_basis=basis)
        if volume < JOURNAL_MIN_ARTICLES_30D:
            return Verdict("failed", "no_fresh_items", validation={"articles_30d": volume}, medical_basis=basis)
        row = journal_row([chosen, *[i for i in issns if i != chosen]], title=title or chosen, publisher=publisher,
                          medical_basis=basis)
        return Verdict("trial", None, row, {"articles_30d": volume, "issn": chosen}, basis)

    async def validate_row(self, candidate: dict, hint: dict) -> Verdict:
        requested = dict(hint.get("row") or {})
        requested.update({"enabled": True, "disabled_reason": None})
        try:
            source = parse_registry({"sources": [requested]})[0].source
        except RegistryError as error:
            return Verdict("failed", f"row_invalid:{error.problems[0][:80]}")
        from .adapters import validate_config

        if validate_config(source):
            return Verdict("failed", "adapter_config_invalid")
        hosts = set(source.config.get("allowed_hosts") or [])
        if any(host_matches(h, self.excluded_hosts) for h in hosts | {host_of(source.config.get("url"))}):
            return Verdict("failed", "excluded")
        if canonical_url(source.config.get("url")) in self.known_urls:
            return Verdict("failed", "known")
        probe = await self.probe_source(source)
        if not probe.ok:
            return Verdict("failed", probe.reason, validation={"exit": probe.egress})
        requested["poll_floor_s"] = max(int(requested.get("poll_floor_s") or 0), TRIAL_FLOOR_S)
        requested["poll_ceiling_s"] = max(int(requested.get("poll_ceiling_s") or 0), requested["poll_floor_s"], TRIAL_CEILING_S)
        return Verdict("trial", None, requested, {"exit": probe.egress, "fresh": probe.fresh, "titles": probe.titles},
                       candidate.get("medical_basis"))

    def validate_social(self, candidate: dict, hint: dict) -> Verdict:
        platform = candidate["key"].split(":", 1)[0]
        access = (hint.get("row") or {}).get("access")
        if not access or access not in self.adapters:
            # The adapters for social accounts are another package's; the candidate waits for them, it has not failed.
            return Verdict("deferred", f"adapter_unavailable:{platform}")
        return Verdict("deferred", "social_validation_pending")

    async def probe_source(self, source) -> Probe:
        """Plan the source's first request with its own adapter, fetch it through its exit (relay as the fallback of a
        direct one), parse, count what is fresh — what a poll does up to storing."""
        adapter = self.adapters.get(source.access)
        if adapter is None:
            return Probe(False, "adapter_unavailable")
        try:
            specs = adapter.plan(source, SourceState(None, None, None, None, None, {}), self.now)
        except FetchError as error:
            return Probe(False, f"plan:{error.detail}")
        if not specs:
            return Probe(False, "nothing_planned")
        exits = [source.egress] + (["relay"] if source.egress == "direct" and self.relay else [])
        last: FetchError | None = None
        for egress in exits:
            try:
                result = await self.fetcher.fetch(specs[0], source_id=source.id, egress=egress,
                                                  allowed_hosts=source.config.get("allowed_hosts"))
            except FetchError as error:
                last = error
                if error.outcome not in ("blocked", "challenge", "timeout", "http-error"):
                    break
                continue
            from dataclasses import replace

            probe = self.probe_parsed(replace(source, egress=egress), result)
            probe.egress = egress
            return probe
        return Probe(False, f"{last.outcome}:{last.detail}" if last else "unreachable")


# ------------------------------------------------------------------------------------ trials and retirements


async def apply_retirements(conn, now: datetime, day: str, curated_ids: set[str]) -> list[dict]:
    """Retire every source a lifecycle rule names now (``lifecycle.retirement``), once. A source on trial is judged at
    the end of its trial instead (``decide_trials``): it was never admitted, so it cannot be retired."""
    retired = []
    candidates = await (await conn.execute(
        "SELECT source_id, line, state FROM evimed_knowledge.source_candidates WHERE source_id IS NOT NULL")).fetchall()
    lines = {row["source_id"]: row["line"] for row in candidates}
    on_trial = {row["source_id"] for row in candidates if row["state"] == "trial"}
    for decision in await retirement_plan(conn, now, curated_ids):
        if decision.source_id in on_trial:
            continue
        line = "registry" if decision.source_id in curated_ids else lines.get(decision.source_id, "dynamic")
        recheck = RECHECK_AFTER.get(decision.reason)
        inserted = await (await conn.execute(
            """INSERT INTO evimed_knowledge.source_lifecycle (source_id, reason, line, decided_at, recheck_after, evidence)
               VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (source_id) DO NOTHING RETURNING source_id""",
            (decision.source_id, decision.reason, line, now, now + recheck if recheck else None, Jsonb(decision.evidence)),
        )).fetchone()
        if not inserted:
            continue
        await conn.execute(
            """UPDATE evimed_knowledge.source_candidates SET state = 'retired', state_reason = %s, state_at = %s
                WHERE source_id = %s AND state IN ('trial', 'admitted')""",
            (decision.reason, now, decision.source_id),
        )
        await count(conn, day, line, retired=1)
        retired.append({"source_id": decision.source_id, "reason": decision.reason, "line": line})
    return retired


async def decide_trials(conn, now: datetime, day: str) -> list[dict]:
    """Admit, fail or reject every trial that has ended (``lifecycle.trial_verdict``)."""
    rows = await (await conn.execute(
        """SELECT c.id, c.line, c.source_id, c.medical_basis, c.trial_until, s.first_contact_at,
                  (SELECT count(*) FROM evimed_knowledge.fetches f WHERE f.source_id = c.source_id
                      AND f.fetched_at >= c.trial_started_at AND f.outcome IN ('ok', 'not-modified', 'empty')) AS ok_polls,
                  (SELECT count(*) FROM evimed_knowledge.entries e WHERE e.source_id = c.source_id AND NOT e.backfill
                      AND s.first_contact_at IS NOT NULL AND e.first_seen_at > s.first_contact_at) AS new_entries
             FROM evimed_knowledge.source_candidates c
             LEFT JOIN evimed_knowledge.sources s ON s.id = c.source_id
            WHERE c.state = 'trial' AND c.trial_until <= %s""",
        (now,),
    )).fetchall()
    screening = await screening_of(conn, now)
    decided = []
    for row in rows:
        screened, off_topic = screening.get(row["source_id"], (None, None))
        verdict, reason = trial_verdict(TrialFacts(
            trial_until=row["trial_until"], medical_basis=row["medical_basis"], ok_polls=int(row["ok_polls"] or 0),
            new_entries=int(row["new_entries"] or 0), screened=screened, off_topic=off_topic), now)
        if verdict in ("wait", "extend"):
            continue
        state = {"admit": "admitted", "fail": "failed", "reject": "rejected"}[verdict]
        await conn.execute(
            "UPDATE evimed_knowledge.source_candidates SET state = %s, state_reason = %s, state_at = %s WHERE id = %s",
            (state, reason, now, row["id"]),
        )
        await count(conn, day, row["line"], **({"admitted": 1} if state == "admitted" else {"failed": 1}))
        decided.append({"source_id": row["source_id"], "line": row["line"], "verdict": state, "reason": reason})
    return decided


# ------------------------------------------------------------------------------------ the daily cycle


async def record_verdict(conn, candidate: dict, verdict: Verdict, now: datetime, day: str) -> str:
    line = candidate["line"]
    if verdict.status == "deferred":
        await conn.execute(
            """UPDATE evimed_knowledge.source_candidates SET attempts = attempts + 1, state_reason = %s, next_check_at = %s
                WHERE id = %s""",
            (verdict.reason, now + DEFERRED_RETRY_AFTER, candidate["id"]),
        )
        return "deferred"
    if verdict.status == "failed":
        await conn.execute(
            """UPDATE evimed_knowledge.source_candidates SET state = 'failed', state_reason = %s, state_at = %s,
                      attempts = attempts + 1, validation = %s, medical_basis = coalesce(medical_basis, %s) WHERE id = %s""",
            ((verdict.reason or "failed")[:200], now, Jsonb(verdict.validation), verdict.medical_basis, candidate["id"]),
        )
        await count(conn, day, line, failed=1)
        return "failed"
    if verdict.status == "admitted":           # a re-check that brought a retired source back
        source_id = candidate["key"].split(":", 1)[1]
        await conn.execute("DELETE FROM evimed_knowledge.source_lifecycle WHERE source_id = %s", (source_id,))
        await conn.execute(
            """UPDATE evimed_knowledge.source_candidates SET state = 'admitted', state_reason = 'readmitted', state_at = %s
                WHERE source_id = %s AND state = 'retired'""",
            (now, source_id),
        )
        await conn.execute(
            """UPDATE evimed_knowledge.source_candidates SET state = 'admitted', state_reason = 'readmitted', state_at = %s,
                      attempts = attempts + 1, validation = %s WHERE id = %s""",
            (now, Jsonb(verdict.validation), candidate["id"]),
        )
        await count(conn, day, line, validated=1, admitted=1)
        return "admitted"
    row = verdict.row or {}
    await conn.execute(
        """UPDATE evimed_knowledge.source_candidates SET state = 'trial', state_reason = NULL, state_at = %s,
                  attempts = attempts + 1, source_id = %s, row = %s, validation = %s,
                  medical_basis = coalesce(%s, medical_basis), trial_started_at = %s, trial_until = %s WHERE id = %s""",
        (now, row.get("id"), Jsonb(row), Jsonb(verdict.validation), verdict.medical_basis, now,
         now + timedelta(days=TRIAL_DAYS), candidate["id"]),
    )
    await count(conn, day, line, validated=1, trial=1)
    return "trial"


async def crossref_spent(fetcher) -> bool:
    """Whether today's Crossref use is past ``CROSSREF_SHARE`` of its cap (unknown counts as not)."""
    try:
        usage = (await fetcher.host_budget_usage()).get(CROSSREF_HOST) or {}
    except Exception:
        return False
    cap = int(usage.get("cap") or 0)
    return bool(cap) and int(usage.get("used") or 0) >= CROSSREF_SHARE * cap


async def validate_readmission(validator: Validator, conn, candidate: dict) -> Verdict:
    """A retired source is back when it is permitted, readable and has an item newer than its retirement."""
    source_id = candidate["key"].split(":", 1)[1]
    row = await (await conn.execute("SELECT * FROM evimed_knowledge.sources WHERE id = %s", (source_id,))).fetchone()
    retired = await (await conn.execute(
        "SELECT reason, decided_at FROM evimed_knowledge.source_lifecycle WHERE source_id = %s", (source_id,))).fetchone()
    if row is None or retired is None:
        return Verdict("failed", "not_retired")
    probe = await validator.probe_source(source_from_row(row))
    if not probe.ok:
        return Verdict("failed", probe.reason, validation={"exit": probe.egress})
    if probe.newest is None or probe.newest <= retired["decided_at"]:
        return Verdict("failed", "nothing_new_since_retirement", validation={"newest": None if probe.newest is None
                                                                             else probe.newest.isoformat()})
    return Verdict("admitted", "readmitted", validation={"exit": probe.egress, "fresh": probe.fresh,
                                                         "titles": probe.titles})


async def run_discovery(settings, pool, fetcher, clock, *, caps: dict[str, int] | None = None,
                        outbound_pages: int = DEFAULT_OUTBOUND_PAGES, deadline_s: float = RUN_DEADLINE_S,
                        data: dict | None = None, gather_lines=None) -> dict:
    """One run of the daily cycle (see the module docstring). Safe to repeat: each step records what it did."""
    from .db import meta_get, meta_set
    from .discovery_lines import gather_all
    from .dynamic_registry import lock_registry, sync_dynamic_registry
    from .registry import load_registry

    caps = caps or dict(DEFAULT_CAPS)
    data = data if data is not None else load_data()
    started = clock()
    day = shanghai_day(started)
    nonce = uuid4().hex
    async with pool.connection() as conn:
        async with conn.transaction():
            await lock_registry(conn)
            status = await meta_get(conn, STATUS_KEY) or {}
            if status.get("leaseUntil") and datetime.fromisoformat(status["leaseUntil"]) > started:
                return {"status": "running", "day": day}
            if status.get("day") != day:
                status = {"day": day, "attempts": {}, "cursors": status.get("cursors", {})}
            status.update(runId=nonce, leaseUntil=(started + timedelta(seconds=deadline_s + 300)).isoformat())
            await meta_set(conn, STATUS_KEY, status)
    report: dict = {"status": "complete", "day": day, "retired": [], "decided": [], "gathered": {}, "validated": {}}
    changed = False
    deadline = asyncio.get_running_loop().time() + deadline_s
    try:
        base = load_registry(settings.registry_path)
        curated = {row.source.id for row in base}
        async with pool.connection() as conn:
            async with conn.transaction():
                if status.get("retiredDay") != day:
                    report["retired"] = await apply_retirements(conn, clock(), day, curated)
                    status["retiredDay"] = day
                    changed = changed or bool(report["retired"])
                report["decided"] = await decide_trials(conn, clock(), day)
                changed = changed or bool(report["decided"])
        if status.get("gatheredDay") != day:
            async with pool.connection() as conn:
                known_urls, known_issns, excluded = await known_urls_and_hosts(conn, base)
                found, cursors = await gather_all(conn, fetcher, clock(), data=data, known_urls=known_urls,
                                                  known_issns=known_issns, excluded_hosts=excluded,
                                                  cursors=status.get("cursors", {}), outbound_pages=outbound_pages,
                                                  caps=caps, lines=gather_lines)
                async with conn.transaction():
                    report["gathered"] = await upsert_candidates(conn, found, clock(), day)
            status["cursors"] = cursors
            status["gatheredDay"] = day
        async with pool.connection() as conn:
            known_urls, known_issns, excluded = await known_urls_and_hosts(conn, base)
            excluded |= {h for h in data.get("exclude_hosts", [])}
            validator = Validator(fetcher, settings, clock(), known_urls=known_urls, known_issns=known_issns,
                                  excluded_hosts=excluded)
            attempts = status.setdefault("attempts", {})
            crossref_tight = await crossref_spent(fetcher)
            report["crossrefTight"] = crossref_tight
            by_line: list[list[dict]] = []
            for line in LINES:
                room = caps.get(line, 0) - int(attempts.get(line, 0))
                if line == "journal" and crossref_tight:
                    room = 0
                if room <= 0:
                    continue
                by_line.append(await (await conn.execute(
                    """SELECT id, line, key, medical_basis, evidence FROM evimed_knowledge.source_candidates
                        WHERE state = 'candidate' AND line = %s AND (next_check_at IS NULL OR next_check_at <= %s)
                        ORDER BY sightings DESC, first_seen_at, id LIMIT %s""",
                    (line, clock(), room),
                )).fetchall())
            # Interleaved, so one slow line (sites that time out) never starves the others within a run's budget.
            pending = [row for group in zip_longest(*by_line) for row in group if row is not None]
        gate = asyncio.Semaphore(VALIDATION_CONCURRENCY)

        async def one(candidate: dict) -> None:
            nonlocal changed
            if asyncio.get_running_loop().time() > deadline:
                return
            async with gate:
                if asyncio.get_running_loop().time() > deadline:
                    return
                async with pool.connection() as conn:
                    try:
                        if candidate["line"] == "readmit":
                            verdict = await validate_readmission(validator, conn, candidate)
                        else:
                            verdict = await validator.validate(candidate)
                    except asyncio.CancelledError:
                        raise
                    except Exception as error:  # one candidate's surprise never ends the run; it is tried again later
                        log.exception("validation of %s failed", candidate["key"][:200])
                        verdict = Verdict("deferred", f"internal:{type(error).__name__}")
                    async with conn.transaction():
                        outcome = await record_verdict(conn, candidate, verdict, clock(), day)
                attempts[candidate["line"]] = int(attempts.get(candidate["line"], 0)) + 1
                bucket = report["validated"].setdefault(candidate["line"], {})
                bucket[outcome] = bucket.get(outcome, 0) + 1
                if outcome in ("trial", "admitted"):
                    validator.known_urls.add(canonical_url(((verdict.row or {}).get("config") or {}).get("url")) or "")
                    changed = True

        await asyncio.gather(*(one(candidate) for candidate in pending))
        if asyncio.get_running_loop().time() > deadline:
            report["status"] = "partial"
    except asyncio.CancelledError:
        report["status"] = "interrupted"
        raise
    finally:
        async with pool.connection() as conn:
            async with conn.transaction():
                await lock_registry(conn)
                current = await meta_get(conn, STATUS_KEY) or {}
                if current.get("runId") == nonce:
                    status.update(leaseUntil=None, last={k: v for k, v in report.items() if k != "retired"}
                                  | {"retired": len(report["retired"])}, lastRunAt=clock().isoformat())
                    await meta_set(conn, STATUS_KEY, status)
                if changed:
                    await sync_dynamic_registry(conn, lambda: load_registry(settings.registry_path), clock())
    return report


# ------------------------------------------------------------------------------------ what /v1/health reports


async def discovery_health(conn, now: datetime) -> dict:
    """Today's counts (Shanghai day), the 14 days before it, today's counts by line, and how many are on trial."""
    today = now.astimezone(SHANGHAI).date()
    rows = await (await conn.execute(
        """SELECT day, line, candidates, validated, trial, admitted, retired, failed FROM evimed_knowledge.discovery_daily
            WHERE day > %s ORDER BY day DESC""",
        (today - timedelta(days=15),),
    )).fetchall()
    columns = ("candidates", "validated", "trial", "admitted", "retired", "failed")
    days: dict = {}
    by_line: dict = {}
    for row in rows:
        total = days.setdefault(row["day"], {name: 0 for name in columns})
        for name in columns:
            total[name] += row[name]
        if row["day"] == today:
            by_line[row["line"]] = {name: row[name] for name in columns}
    in_trial = await (await conn.execute(
        "SELECT count(*) AS n FROM evimed_knowledge.source_candidates WHERE state = 'trial'")).fetchone()

    def entry(day) -> dict:
        return {"day": day.isoformat(), **days.get(day, {name: 0 for name in columns})}

    return {"today": entry(today), "history": [entry(today - timedelta(days=n)) for n in range(1, 15)],
            "by_line": by_line, "in_trial": int(in_trial["n"])}


