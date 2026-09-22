"""robots.txt for page requests (RFC 9309), cached one hour per origin.

robots.txt governs *pages*, not APIs (plan 6.1, review finding 13 #2): list pages and site feeds
ask it first; Crossref, E-utilities, openFDA and the other open APIs are read under their
providers' published rules and never ask — E-utilities' own robots.txt is ``Disallow: /``, and
obeying it would read no PubMed at all. The caller decides by ``RequestSpec.api``.

Semantics (RFC 9309):

- The group for our product token ``EviMedBot`` if the file has one, else the ``*`` group; several
  matching groups merge. No group at all: everything allowed.
- The most specific (longest) matching rule wins; on a tie, ``Allow`` wins. ``*`` matches any run
  of characters, a trailing ``$`` anchors the end. An empty ``Disallow:`` allows everything.
  ``/robots.txt`` itself is always allowed.
- A 4xx answer means "unavailable": crawl freely. A 5xx or no answer means "unreachable": assume
  complete disallow — cached for 10 minutes only, so a flapping server costs one short pause.
- ``Crawl-delay`` (non-standard, widely used) feeds the host's minimum interval in the budget.
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable
from urllib.parse import unquote, urlsplit

AGENT_TOKEN = "evimedbot"
MAX_ROBOTS_BYTES = 512 * 1024
TTL_S = 3600.0
FAILURE_TTL_S = 600.0


@dataclass
class RobotsRules:
    rules: list[tuple[bool, str]] = field(default_factory=list)   # (allow, pattern)
    crawl_delay: float | None = None
    allow_all: bool = False
    disallow_all: bool = False

    def allowed(self, path: str) -> bool:
        if self.allow_all:
            return True
        if self.disallow_all:
            return False
        path = _normalize_path(path)
        if path == "/robots.txt":
            return True
        best_len = -1
        best_allow = True
        for allow, pattern in self.rules:
            if _matches(pattern, path):
                length = len(pattern)
                if length > best_len or (length == best_len and allow):
                    best_len, best_allow = length, allow
        return best_allow


def _normalize_path(path: str) -> str:
    return unquote(path or "/") or "/"


def _matches(pattern: str, path: str) -> bool:
    anchored = pattern.endswith("$")
    body = pattern[:-1] if anchored else pattern
    regex = "".join(".*" if ch == "*" else re.escape(ch) for ch in body)
    return re.match(regex + ("$" if anchored else ""), path, re.S) is not None


def parse_robots(text: str, agent: str = AGENT_TOKEN) -> RobotsRules:
    groups: list[tuple[list[str], list[tuple[bool, str]], list[float]]] = []
    agents: list[str] = []
    rules: list[tuple[bool, str]] = []
    delays: list[float] = []
    in_rules = False
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        key, value = (part.strip() for part in line.split(":", 1))
        key = key.lower()
        if key == "user-agent":
            if in_rules:
                groups.append((agents, rules, delays))
                agents, rules, delays, in_rules = [], [], [], False
            agents.append(value.lower())
        elif key in ("allow", "disallow"):
            if not agents:
                continue
            in_rules = True
            if value:
                rules.append((key == "allow", _normalize_path(value)))
        elif key == "crawl-delay":
            if not agents:
                continue
            in_rules = True
            try:
                delays.append(float(value))
            except ValueError:
                pass
    if agents:
        groups.append((agents, rules, delays))
    mine = [g for g in groups if agent in g[0]]
    chosen = mine or [g for g in groups if "*" in g[0]]
    if not chosen:
        return RobotsRules(allow_all=True)
    merged_rules = [rule for g in chosen for rule in g[1]]
    merged_delays = [d for g in chosen for d in g[2] if d >= 0]
    return RobotsRules(rules=merged_rules, crawl_delay=max(merged_delays) if merged_delays else None)


# fetch_robots(origin) -> (status or None when unreachable, text or None)
RobotsFetcher = Callable[[str], Awaitable[tuple[int | None, str | None]]]


class RobotsCache:
    def __init__(self, fetch_robots: RobotsFetcher, *, ttl_s: float = TTL_S, failure_ttl_s: float = FAILURE_TTL_S,
                 monotonic: Callable[[], float] = time.monotonic) -> None:
        self._fetch = fetch_robots
        self._ttl = ttl_s
        self._failure_ttl = failure_ttl_s
        self._monotonic = monotonic
        self._cache: dict[str, tuple[float, RobotsRules]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def rules_for(self, url: str) -> RobotsRules:
        """Single flight per origin: polls of three lists on one site that start together fetch
        robots.txt once, not three times in a row (each waiting out the same dead host)."""
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}".lower()
        cached = self._cache.get(origin)
        if cached and cached[0] > self._monotonic():
            return cached[1]
        async with self._locks.setdefault(origin, asyncio.Lock()):
            cached = self._cache.get(origin)
            if cached and cached[0] > self._monotonic():
                return cached[1]
            return await self._refresh(origin)

    async def _refresh(self, origin: str) -> RobotsRules:
        status, text = await self._fetch(origin)
        if status is not None and 200 <= status < 300 and text is not None:
            rules, ttl = parse_robots(text[:MAX_ROBOTS_BYTES]), self._ttl
        elif status is not None and 400 <= status < 500:
            rules, ttl = RobotsRules(allow_all=True), self._ttl
        else:
            rules, ttl = RobotsRules(disallow_all=True), self._failure_ttl
        self._cache[origin] = (self._monotonic() + ttl, rules)
        return rules

    async def check(self, url: str) -> tuple[bool, float | None, bool]:
        """(allowed, crawl_delay, robots_unreachable) for a page URL."""
        rules = await self.rules_for(url)
        parts = urlsplit(url)
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        return rules.allowed(path), rules.crawl_delay, rules.disallow_all
