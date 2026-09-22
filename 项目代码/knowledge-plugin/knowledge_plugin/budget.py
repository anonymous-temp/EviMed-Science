"""Per-host token buckets: spacing, concurrency, a daily cap that survives restarts, and pauses.

Limits are per HOST, not per source: 154 journals share one Crossref bucket. The table is the
plan's (10.2.2), checked against each provider's published rules on 2026-09-21:

==========================  ====  =============  =========  ==========================================
host                        conc  min interval   daily cap  basis
==========================  ====  =============  =========  ==========================================
api.crossref.org            1     1.2 s          3,000      anonymous list pool 1 req/s (Jul 2026 rules)
eutils.ncbi.nlm.nih.gov     1     0.4 s / 0.15   2,000      3 req/s per IP without key, 10 with; shared
www.ebi.ac.uk (Europe PMC)  1     1 s            1,500
api.fda.gov                 1     1 s            300 / 800  1,000/day per IP anonymous, SHARED with the
                                                            research runs and the drug-safety engine
clinicaltrials.gov          1     1.5 s          500        no published limit: self-restraint
www.federalregister.gov     1     1.5 s          200
api.medrxiv.org/biorxiv     1     2 s (30 s TO)  300
export.arxiv.org            1     3 s            100        terms of use: one request per 3 s
www.who.int, EMA, GOV.UK    1     1.5 s          300 each
anything else               1     1.5 s          none       and the site's robots.txt crawl-delay
==========================  ====  =============  =========  ==========================================

A 429 (or a 503 with ``Retry-After``) pauses the whole host, not just the source that met it; the
pause and the day's count are persisted (``host_state``, ``host_counters``), because a restart that
forgot them would spend a shared allowance twice (review finding 13 #9). Waiting is bounded: a
request that would wait more than a minute for its slot is refused as ``host-budget`` /
``host_busy`` with the time to come back, so a slow host cannot hold every worker.
"""

from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import AsyncIterator, Callable, Protocol

from .model import FetchError
from .policy import next_utc_midnight

log = logging.getLogger("knowledge_plugin.budget")

MAX_WAIT_S = 60.0
MAX_CRAWL_DELAY_S = 3600.0
MAX_PAUSE_S = 6 * 3600.0


@dataclass(frozen=True)
class HostRule:
    min_interval_s: float
    daily_cap: int | None
    concurrency: int = 1
    timeout_s: float | None = None


DEFAULT_RULE = HostRule(1.5, None)


def host_rules(*, ncbi_key: bool, openfda_key: bool) -> dict[str, HostRule]:
    return {
        "api.crossref.org": HostRule(1.2, 3000),
        "eutils.ncbi.nlm.nih.gov": HostRule(0.15 if ncbi_key else 0.4, 2000),
        "www.ebi.ac.uk": HostRule(1.0, 1500),
        "api.fda.gov": HostRule(1.0, 800 if openfda_key else 300),
        "clinicaltrials.gov": HostRule(1.5, 500),
        "www.federalregister.gov": HostRule(1.5, 200),
        "api.medrxiv.org": HostRule(2.0, 300, timeout_s=30.0),
        "api.biorxiv.org": HostRule(2.0, 300, timeout_s=30.0),
        "connect.medrxiv.org": HostRule(2.0, 300, timeout_s=30.0),
        "connect.biorxiv.org": HostRule(2.0, 300, timeout_s=30.0),
        "export.arxiv.org": HostRule(3.0, 100),
        "www.who.int": HostRule(1.5, 300),
        "www.ema.europa.eu": HostRule(1.5, 300),
        "www.gov.uk": HostRule(1.5, 300),
        "api.unpaywall.org": HostRule(1.0, 2000),
    }


class CounterStore(Protocol):
    async def reserve(self, host: str, day: date, cap: int | None) -> bool: ...

    async def pause(self, host: str, until: datetime, reason: str) -> None: ...

    async def load_pauses(self) -> dict[str, datetime]: ...

    async def counts(self, day: date) -> dict[str, int]: ...


class PgCounterStore:
    """``host_counters`` / ``host_state`` in the plugin database."""

    def __init__(self, pool) -> None:
        self._pool = pool

    async def reserve(self, host: str, day: date, cap: int | None) -> bool:
        async with self._pool.connection() as conn:
            if cap is None:
                await conn.execute(
                    """INSERT INTO evimed_knowledge.host_counters (host, day, requests) VALUES (%s, %s, 1)
                       ON CONFLICT (host, day) DO UPDATE SET requests = evimed_knowledge.host_counters.requests + 1""",
                    (host, day),
                )
                return True
            row = await (await conn.execute(
                """INSERT INTO evimed_knowledge.host_counters (host, day, requests) VALUES (%s, %s, 1)
                   ON CONFLICT (host, day) DO UPDATE SET requests = evimed_knowledge.host_counters.requests + 1
                   WHERE evimed_knowledge.host_counters.requests < %s
                   RETURNING requests""",
                (host, day, cap),
            )).fetchone()
            return row is not None

    async def pause(self, host: str, until: datetime, reason: str) -> None:
        async with self._pool.connection() as conn:
            await conn.execute(
                """INSERT INTO evimed_knowledge.host_state (host, paused_until, pause_reason, updated_at)
                   VALUES (%s, %s, %s, clock_timestamp())
                   ON CONFLICT (host) DO UPDATE SET paused_until = greatest(evimed_knowledge.host_state.paused_until, EXCLUDED.paused_until),
                     pause_reason = EXCLUDED.pause_reason, updated_at = clock_timestamp()""",
                (host, until, reason[:100]),
            )

    async def load_pauses(self) -> dict[str, datetime]:
        async with self._pool.connection() as conn:
            rows = await (await conn.execute(
                "SELECT host, paused_until FROM evimed_knowledge.host_state WHERE paused_until > clock_timestamp()"
            )).fetchall()
        return {row["host"]: row["paused_until"] for row in rows}

    async def counts(self, day: date) -> dict[str, int]:
        async with self._pool.connection() as conn:
            rows = await (await conn.execute(
                "SELECT host, requests FROM evimed_knowledge.host_counters WHERE day = %s", (day,)
            )).fetchall()
        return {row["host"]: row["requests"] for row in rows}


class MemoryCounterStore:
    """The same contract in memory (tests, and the fetcher used outside the service)."""

    def __init__(self) -> None:
        self.requests: dict[tuple[str, date], int] = {}
        self.pauses: dict[str, datetime] = {}

    async def reserve(self, host: str, day: date, cap: int | None) -> bool:
        current = self.requests.get((host, day), 0)
        if cap is not None and current >= cap:
            return False
        self.requests[(host, day)] = current + 1
        return True

    async def pause(self, host: str, until: datetime, reason: str) -> None:
        self.pauses[host] = max(until, self.pauses.get(host, until))

    async def load_pauses(self) -> dict[str, datetime]:
        return dict(self.pauses)

    async def counts(self, day: date) -> dict[str, int]:
        return {host: n for (host, d), n in self.requests.items() if d == day}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class HostBudget:
    """Spacing, concurrency, daily caps and pauses per host (see module docstring)."""

    def __init__(self, store: CounterStore, rules: dict[str, HostRule], *, clock: Callable[[], datetime] = _utcnow,
                 monotonic: Callable[[], float] = time.monotonic, sleep=asyncio.sleep, max_wait_s: float = MAX_WAIT_S) -> None:
        self._store = store
        self._rules = rules
        self._clock = clock
        self._monotonic = monotonic
        self._sleep = sleep
        self._max_wait_s = max_wait_s
        self._next_slot: dict[str, float] = {}
        self._last_start: dict[str, float] = {}
        self._locks: dict[str, asyncio.Semaphore] = {}
        self._crawl_delay: dict[str, float] = {}
        self._paused: dict[str, datetime] = {}

    async def load(self) -> None:
        self._paused.update(await self._store.load_pauses())

    def rule(self, host: str) -> HostRule:
        return self._rules.get(host, DEFAULT_RULE)

    def interval_s(self, host: str) -> float:
        return max(self.rule(host).min_interval_s, self._crawl_delay.get(host, 0.0))

    def timeout_s(self, host: str, default: float) -> float:
        return self.rule(host).timeout_s or default

    def observe_crawl_delay(self, host: str, seconds: float | None) -> None:
        if seconds and seconds > 0:
            self._crawl_delay[host] = min(float(seconds), MAX_CRAWL_DELAY_S)

    def paused_until(self, host: str) -> datetime | None:
        until = self._paused.get(host)
        if until and until > self._clock():
            return until
        return None

    async def pause(self, host: str, seconds: float, reason: str) -> datetime:
        seconds = min(max(1.0, float(seconds)), MAX_PAUSE_S)
        until = self._clock() + timedelta(seconds=seconds)
        self._paused[host] = max(until, self._paused.get(host, until))
        await self._store.pause(host, self._paused[host], reason)
        log.warning("host %s paused for %.0f s (%s)", host, seconds, reason)
        return self._paused[host]

    @asynccontextmanager
    async def slot(self, host: str, *, robots: bool = False) -> AsyncIterator[None]:
        """Hold ``host``'s request slot for one request; raises ``FetchError('host-budget', …)``.

        A robots.txt fetch (``robots=True``) keeps only the host's base spacing and does not take
        the crawl-delay slot: a site declaring ``Crawl-delay: 3600`` would otherwise lose its one
        hourly request to the hourly robots.txt refresh, and every page request after it would wait
        an hour and be refused as ``host_busy`` — for ever (measured on statmodeling.stat.columbia.edu,
        2026-09-22). It still counts toward the daily cap.
        """
        now = self._clock()
        until = self.paused_until(host)
        if until:
            raise FetchError("host-budget", "host_paused", retry_after_s=(until - now).total_seconds())
        rule = self.rule(host)
        semaphore = self._locks.setdefault(host, asyncio.Semaphore(rule.concurrency))
        await semaphore.acquire()
        try:
            base_ready = self._last_start.get(host, float("-inf")) + rule.min_interval_s
            ready = base_ready if robots else max(base_ready, self._next_slot.get(host, 0.0))
            wait = ready - self._monotonic()
            if wait > self._max_wait_s:
                raise FetchError("host-budget", "host_busy", retry_after_s=wait)
            today = self._clock().date()
            if not await self._store.reserve(host, today, rule.daily_cap):
                midnight = next_utc_midnight(self._clock())
                raise FetchError("host-budget", "daily_cap", retry_after_s=(midnight - self._clock()).total_seconds())
            if wait > 0:
                await self._sleep(wait)
            self._last_start[host] = self._monotonic()
            if not robots:
                self._next_slot[host] = self._last_start[host] + self.interval_s(host)
            yield
        finally:
            semaphore.release()
