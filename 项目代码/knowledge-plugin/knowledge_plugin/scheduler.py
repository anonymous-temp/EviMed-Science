"""The crawl loop: one leased worker over the ``sources`` table (plan 10.2.2, 10.2.3).

The queue is the ``sources`` table itself — the partial "due and not leased" index — and there
is no job table: a day of ~7,000 polls would drown one (plan 10.4.4). Every ``tick_s`` the worker
claims up to its free concurrency with ``FOR UPDATE SKIP LOCKED``, in priority order (safety feeds
and regulators first, journals and APIs, media, societies), and leases each claimed source for
10 minutes; a worker that dies simply lets its leases expire.

One poll (at least once, harmless to repeat — step 6 is idempotent):

1. plan: the adapter turns (source, state, now) into requests. On the first contact and once a day
   for incremental queries, the state carries ``last_ok_at = None`` — the full look-back window.
2. fetch: the first request carries the stored ``If-None-Match`` / ``If-Modified-Since`` when its URL
   is the one they came from; a 304, or a 200 whose body hashes like the last one (Europe PMC
   ignores validators), is ``not-modified`` and is not parsed.
3. parse → normalise → store, page by page (one transaction each); ``ParseOutput.next`` is followed
   until the source's ``max_pages`` requests are spent. A chain step (zero entries, a ``next``) is
   not an empty page.
4. account: one ``fetches`` row per poll; the source's validators, cursor, counters, cadence,
   health and next poll are updated and the lease released, in one transaction.

Failures raised by the fetcher and by ``plan``/``parse`` alike are ``FetchError``s with an outcome;
a parse error carrying a short ``retry_after_s`` (Europe PMC's 200-without-hitCount) is retried once
within the poll. The plugin's own budget refusals (``host-budget``) reschedule without counting as
the source's failure.

The same process also runs the text worker (on-demand enrichment for ``/text``), the hourly
retention purge (fetches 14 d, entries 30 d after delivery or 90 d when their text was asked for,
seen_keys 400 d) and a registry watcher that re-syncs when the file changes.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import socket
from collections import Counter, deque
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Callable
from urllib.parse import urlsplit

from psycopg.types.json import Jsonb

from . import policy
from .db import meta_get, meta_set
from .fetch import ProtectedFetcher, is_empty_shell
from .model import NEUTRAL_DETAILS, EntryTextResult, FetchError, SourceState
from .normalize import Rejected, prepare
from .registry import RegistryError, load_registry, source_from_row, sync_registry
from .settings import Settings
from .store import StoreResult, claim_texts, insert_fetch, save_text_result, store_entries, success_rate_24h, text_failure

log = logging.getLogger("knowledge_plugin.scheduler")

MAX_IN_POLL_RETRY_S = 30.0
ENRICH_TIMEOUT_S = 180.0
MAINTENANCE_EVERY_S = 3600.0
REGISTRY_WATCH_EVERY_S = 60.0
PURGE_BATCH = 5000
ADAPTER_MISSING_RETRY_S = 3600
LEASE_RENEW_EVERY = 20
TEXT_BATCH = 20


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class PollReport:
    source_id: str
    outcome: str
    detail: str | None = None
    requests: int = 0
    seen: int = 0
    new: int = 0
    backfilled: int = 0
    revised: int = 0
    rejected: dict = field(default_factory=dict)
    notes: dict = field(default_factory=dict)
    duration_ms: int = 0


class Crawler:
    def __init__(self, settings: Settings, pool, fetcher: ProtectedFetcher, *, adapters: dict | None = None,
                 enricher: Callable | None = None, clock: Callable[[], datetime] = _utcnow) -> None:
        self._settings = settings
        self._pool = pool
        self._fetcher = fetcher
        if adapters is None:
            from .adapters import REGISTRY as adapters  # the build's read methods (package P2)
        self._adapters = adapters
        if enricher is not None:
            self._enricher, self._enrich_batch = enricher, None
        else:
            self._enricher, self._enrich_batch = _load_enricher()
        self._clock = clock
        self._tasks: list[asyncio.Task] = []
        self._inflight: set[asyncio.Task] = set()
        self._stopping = asyncio.Event()
        self._registry_mtime: float | None = None
        self._missing_adapter_logged: set[str] = set()
        self._busy_hosts: Counter = Counter()
        self.last_tick_at: datetime | None = None
        self.last_error: str | None = None
        self.last_error_at: datetime | None = None
        self.polls_total: Counter = Counter()

    # ------------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        await self._release_own_leases()
        try:
            self._registry_mtime = os.stat(self._settings.registry_path).st_mtime   # the file just synced
        except OSError:
            self._registry_mtime = None
        self._tasks = [
            asyncio.create_task(self._loop("poll", self._poll_tick, self._settings.tick_s)),
            asyncio.create_task(self._loop("text", self._text_tick, self._settings.tick_s)),
            asyncio.create_task(self._loop("maintenance", self.maintenance, MAINTENANCE_EVERY_S, initial_delay=60.0)),
            asyncio.create_task(self._loop("registry", self.watch_registry, REGISTRY_WATCH_EVERY_S, initial_delay=REGISTRY_WATCH_EVERY_S)),
        ]
        log.info("crawler started: concurrency %s, text concurrency %s, adapters %s",
                 self._settings.concurrency, self._settings.text_concurrency, sorted(self._adapters) or "none")

    async def stop(self) -> None:
        self._stopping.set()
        for task in self._tasks:
            task.cancel()
        for task in list(self._inflight):
            task.cancel()
        await asyncio.gather(*self._tasks, *self._inflight, return_exceptions=True)
        await self._release_own_leases()

    async def _loop(self, name: str, step: Callable, every_s: float, initial_delay: float = 0.0) -> None:
        if initial_delay:
            await self._sleep(initial_delay)
        while not self._stopping.is_set():
            try:
                await step()
            except asyncio.CancelledError:
                raise
            except Exception as error:  # a loop must survive any one bad iteration; the error is named
                self.last_error = f"{name}:{type(error).__name__}"
                self.last_error_at = self._clock()
                log.exception("%s loop iteration failed", name)
            await self._sleep(every_s)

    async def _sleep(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._stopping.wait(), timeout=seconds)
        except TimeoutError:
            pass

    async def _release_own_leases(self) -> None:
        """Leases held by this host's previous process (same container, new pid) are released now
        instead of waiting ten minutes; the service runs one crawler per host."""
        prefix = socket.gethostname() + ":%"
        async with self._pool.connection() as conn:
            await conn.execute(
                "UPDATE evimed_knowledge.sources SET lease_owner = NULL, lease_until = NULL WHERE lease_owner LIKE %s",
                (prefix,),
            )

    # ------------------------------------------------------------------ polling

    async def _poll_tick(self) -> None:
        self.last_tick_at = self._clock()
        free = self._settings.concurrency - len(self._inflight)
        if free <= 0:
            return
        for row in await self.claim(free, busy_hosts=sorted(h for h, n in self._busy_hosts.items() if n > 0)):
            host = row.get("host") or row["id"]
            self._busy_hosts[host] += 1
            task = asyncio.create_task(self._poll_guarded(row))
            self._inflight.add(task)
            task.add_done_callback(self._inflight.discard)
            task.add_done_callback(lambda _, h=host: self._busy_hosts.subtract([h]))

    async def claim(self, limit: int, *, busy_hosts: list[str] | None = None) -> list[dict]:
        """Lease up to ``limit`` due sources: at most one per host, none on a host already being
        polled, the rest in priority order. The lease condition is repeated under the row lock so a
        row another worker leased a moment ago is skipped, not polled twice."""
        async with self._pool.connection() as conn:
            async with conn.transaction():
                return await (await conn.execute(
                    """WITH candidates AS (
                         SELECT DISTINCT ON (coalesce(host, id)) id, priority, next_poll_at
                           FROM evimed_knowledge.sources
                          WHERE enabled AND retired_at IS NULL AND next_poll_at <= %(now)s
                            AND (lease_until IS NULL OR lease_until < %(now)s)
                            AND NOT (coalesce(host, id) = ANY(%(busy)s))
                          ORDER BY coalesce(host, id), priority, next_poll_at),
                       picked AS (
                         SELECT s.id FROM evimed_knowledge.sources s JOIN candidates c ON c.id = s.id
                          WHERE s.enabled AND s.next_poll_at <= %(now)s
                            AND (s.lease_until IS NULL OR s.lease_until < %(now)s)
                          ORDER BY c.priority, c.next_poll_at
                          LIMIT %(limit)s
                          FOR UPDATE OF s SKIP LOCKED)
                       UPDATE evimed_knowledge.sources s
                          SET lease_owner = %(worker)s, lease_until = %(until)s
                         FROM picked WHERE s.id = picked.id
                       RETURNING s.*""",
                    {"now": self._clock(), "limit": limit, "worker": self._settings.worker_id,
                     "until": self._clock() + timedelta(seconds=self._settings.lease_s),
                     "busy": list(busy_hosts or [])},
                )).fetchall()

    async def _poll_guarded(self, row: dict) -> None:
        try:
            await self.poll(row)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.last_error = f"poll:{type(error).__name__}"
            self.last_error_at = self._clock()
            log.exception("poll of %s crashed; lease released, retry in 10 minutes", row["id"])
            async with self._pool.connection() as conn:
                await conn.execute(
                    """UPDATE evimed_knowledge.sources SET lease_owner = NULL, lease_until = NULL,
                              next_poll_at = %s, last_error_code = %s WHERE id = %s""",
                    (self._clock() + timedelta(minutes=10), f"internal:{type(error).__name__}"[:100], row["id"]),
                )

    async def run_due(self, limit: int = 1000) -> list[PollReport]:
        """Claim and poll every due source now, sequentially (tests and one-shot runs); a claim
        returns one source per host, so this repeats until nothing is due."""
        reports: list[PollReport] = []
        while len(reports) < limit:
            rows = await self.claim(limit - len(reports))
            if not rows:
                break
            for row in rows:
                reports.append(await self.poll(row))
        return reports

    async def poll(self, row: dict) -> PollReport:
        started = self._clock()
        source = source_from_row(row)
        report = PollReport(source_id=source.id, outcome="ok")
        adapter = self._adapters.get(source.access)
        if adapter is None:
            if source.id not in self._missing_adapter_logged:
                self._missing_adapter_logged.add(source.id)
                log.warning("no adapter for access %s: source %s waits", source.access, source.id)
            report.outcome, report.detail = "blocked", "adapter_unavailable"
            await self._finish_neutral(row, report, started, retry_s=ADAPTER_MISSING_RETRY_S, host=None)
            return report

        full_walk = policy.wants_full_walk(source.config, row["last_full_scan_at"], row["last_full_attempt_at"], started)
        full = full_walk or policy.wants_full_rescan(source.config, row["last_full_scan_at"], started)
        if full_walk:
            await self._mark_full_attempt(source.id, started)
        state = SourceState(
            etag=row["etag"], last_modified=row["last_modified"], last_content_sha256=row["last_content_sha256"],
            last_ok_at=None if full else row["last_ok_at"], first_contact_at=row["first_contact_at"],
            cursor=dict(row["cursor"] or {}),
        )
        first_contact = row["first_contact_at"] is None
        cap_key = "full_walk_max_pages" if full_walk else "max_pages"
        max_requests = max(1, int(source.config.get(cap_key) or source.config.get("max_pages") or 5))
        # the browser waits for the list to be drawn before it hands the page over
        wait_for = None
        if source.egress == "browser":
            wait_for = source.config.get("wait_for") or (source.config.get("selectors") or {}).get("item")
            if wait_for and "@" in wait_for:
                wait_for = wait_for.split("@", 1)[0].strip() or None     # "css@attr" reads an attribute
        totals = StoreResult()
        rejected: Counter = Counter()
        notes: Counter = Counter()
        failure: FetchError | None = None
        later_error: str | None = None
        first: dict = {}
        cursor = None
        not_modified = False
        bytes_total = 0
        retried: set[str] = set()
        host: str | None = None

        try:
            queue = deque(adapter.plan(source, state, started))
        except FetchError as error:
            failure, queue = error, deque()
        except Exception as error:
            log.exception("plan() of %s failed", source.id)
            failure, queue = FetchError("parse-error", f"plan_failed:{type(error).__name__}"), deque()

        requests = 0
        while queue and requests < max_requests and failure is None:
            spec = queue.popleft()
            is_first = requests == 0
            if is_first:
                host = (urlsplit(spec.url).hostname or "").lower() or None
                if spec.conditional and row["last_url"] == spec.url and not full:
                    validators = {}
                    if row["etag"]:
                        validators["If-None-Match"] = row["etag"]
                    if row["last_modified"]:
                        validators["If-Modified-Since"] = row["last_modified"]
                    if validators:
                        spec = replace(spec, headers={**spec.headers, **validators})
            requests += 1
            if requests % LEASE_RENEW_EVERY == 0:
                await self._renew_lease(source.id)
            extra = {"wait_for": wait_for} if wait_for else {}
            try:
                result = await self._fetcher.fetch(spec, source_id=source.id, egress=source.egress,
                                                   allowed_hosts=source.config.get("allowed_hosts"), **extra)
            except FetchError as error:
                if is_first:
                    failure = error
                else:
                    later_error = f"request_{requests}:{error.outcome}:{error.detail}"
                break
            bytes_total += len(result.body)
            if is_first:
                first = {"url": spec.url, "status": result.status, "headers": result.headers}
            if result.not_modified:
                not_modified = is_first
                break
            body_hash = hashlib.sha256(result.body).hexdigest()
            if is_first:
                first["body_sha256"] = body_hash
                # The unchanged-body shortcut is for conditional GETs of one resource (a feed, a list
                # page). A plan of POSTs to one URL (20 ChiCTR queries, STAR's pages) answers the same
                # first page while the rest differ, so it never short-cuts those (P2, 2026-09-22).
                if (not full and spec.conditional and spec.method.upper() == "GET" and spec.body is None
                        and row["last_content_sha256"] == body_hash and row["last_url"] == spec.url):
                    not_modified = True
                    break
            try:
                output = adapter.parse(result, source, started)
            except FetchError as error:
                if (error.retry_after_s is not None and error.retry_after_s <= MAX_IN_POLL_RETRY_S
                        and spec.url not in retried and requests < max_requests):
                    retried.add(spec.url)
                    notes[f"retried:{error.detail}"] += 1
                    await asyncio.sleep(max(0.0, error.retry_after_s))
                    queue.appendleft(spec)
                    continue
                if is_first:
                    failure = error
                else:
                    later_error = f"request_{requests}:{error.outcome}:{error.detail}"
                break
            except Exception as error:
                log.exception("parse() of %s failed", source.id)
                parse_failure = FetchError("parse-error", f"parse_failed:{type(error).__name__}")
                if is_first:
                    failure = parse_failure
                else:
                    later_error = f"request_{requests}:parse-error:{parse_failure.detail}"
                break
            if (not output.entries and output.next is None and not spec.api
                    and is_empty_shell(result.headers.get("content-type", ""), result.body)):
                # a page with no visible text that the adapter could not read either: a bot shell
                shell = FetchError("challenge", "empty_shell", status=result.status)
                if is_first:
                    failure = shell
                else:
                    later_error = f"request_{requests}:challenge:empty_shell"
                break
            prepared = []
            for entry in output.entries:
                try:
                    item = prepare(entry, source)
                except Rejected as reason:
                    rejected[reason.code] += 1
                    continue
                prepared.append(item)
                for note in item.notes:
                    notes[note.split(":", 1)[0]] += 1
            for note in output.notes:
                notes[str(note)[:60]] += 1
            if prepared:
                async with self._pool.connection() as conn:
                    totals.add(await store_entries(conn, source.id, prepared, now=started, first_contact=first_contact))
            if output.cursor is not None:
                cursor = output.cursor
            if output.next is not None:
                queue.append(output.next)
        if failure is None and queue and requests >= max_requests:
            notes["max_pages_reached"] += 1

        report.requests = requests
        report.seen, report.new, report.backfilled, report.revised = totals.seen, totals.new, totals.backfilled, totals.revised
        report.rejected, report.notes = dict(rejected), dict(notes)
        if failure is not None:
            report.outcome, report.detail = failure.outcome, failure.detail
            if failure.outcome == "host-budget":
                retry = failure.retry_after_s if failure.retry_after_s is not None else 60.0
                await self._finish_neutral(row, report, started, retry_s=retry, host=host)
            elif failure.detail in NEUTRAL_DETAILS:
                # this deployment's gap (an exit or a key it lacks, the node or the browser down): not
                # the source's failure, so no backoff and no slide towards "unreadable"
                await self._finish_neutral(row, report, started, retry_s=NEUTRAL_DETAILS[failure.detail], host=host)
            else:
                await self._finish_failure(row, report, started, failure, host=host, bytes_total=bytes_total)
        else:
            if not_modified:
                report.outcome = "not-modified"
            elif totals.seen == 0:
                report.outcome = "empty"
            report.detail = later_error
            await self._finish_success(row, report, started, totals=totals, first=first, cursor=cursor, full=full,
                                       not_modified=not_modified, host=host, bytes_total=bytes_total)
        self.polls_total[report.outcome] += 1
        log.info("poll %s %s%s requests=%s seen=%s new=%s backfill=%s revised=%s rejected=%s ms=%s",
                 source.id, report.outcome, f" ({report.detail})" if report.detail else "", report.requests,
                 report.seen, report.new, report.backfilled, report.revised, sum(rejected.values()), report.duration_ms)
        return report

    async def _mark_full_attempt(self, source_id: str, now: datetime) -> None:
        async with self._pool.connection() as conn:
            await conn.execute("UPDATE evimed_knowledge.sources SET last_full_attempt_at = %s WHERE id = %s", (now, source_id))

    async def _renew_lease(self, source_id: str) -> None:
        """A long poll (a 160-page walk) keeps its lease: another claim must never start it twice."""
        async with self._pool.connection() as conn:
            await conn.execute(
                "UPDATE evimed_knowledge.sources SET lease_until = %s WHERE id = %s AND lease_owner = %s",
                (self._clock() + timedelta(seconds=self._settings.lease_s), source_id, self._settings.worker_id),
            )

    # ------------------------------------------------------------------ accounting

    def _duration_ms(self, started: datetime) -> int:
        return max(0, int((self._clock() - started).total_seconds() * 1000))

    async def _finish_neutral(self, row: dict, report: PollReport, started: datetime, *, retry_s: float,
                              host: str | None) -> None:
        """A poll the plugin itself declined (budget, missing adapter): no failure is counted."""
        report.duration_ms = self._duration_ms(started)
        retry_s = min(max(float(retry_s), 30.0), 86400.0)
        async with self._pool.connection() as conn:
            async with conn.transaction():
                await insert_fetch(conn, source_id=row["id"], fetched_at=started, egress=row["egress"], host=host,
                                   http_status=None, outcome=report.outcome if report.outcome in ("host-budget", "blocked") else "blocked",
                                   bytes_=0, duration_ms=report.duration_ms, content_sha256=None, entries_seen=0,
                                   entries_new=0, error_detail=report.detail, requests=max(1, report.requests))
                await conn.execute(
                    """UPDATE evimed_knowledge.sources SET lease_owner = NULL, lease_until = NULL, next_poll_at = %s,
                              last_attempt_at = %s, last_error_code = %s, updated_at = %s WHERE id = %s""",
                    (started + timedelta(seconds=retry_s), started, (report.detail or "")[:100] or None, started, row["id"]),
                )

    async def _finish_failure(self, row: dict, report: PollReport, started: datetime, failure: FetchError, *,
                              host: str | None, bytes_total: int) -> None:
        report.duration_ms = self._duration_ms(started)
        failures = int(row["consecutive_failures"] or 0) + 1
        failing_since = row["failing_since"] or started
        delay = policy.failure_delay_s(row["poll_floor_s"], failures)
        if failure.retry_after_s:
            delay = max(delay, min(int(failure.retry_after_s), policy.BACKOFF_CAP_S))
        async with self._pool.connection() as conn:
            async with conn.transaction():
                await insert_fetch(conn, source_id=row["id"], fetched_at=started, egress=row["egress"], host=host,
                                   http_status=failure.status, outcome=failure.outcome, bytes_=bytes_total,
                                   duration_ms=report.duration_ms, content_sha256=None, entries_seen=report.seen,
                                   entries_new=report.new + report.backfilled, error_detail=failure.detail,
                                   requests=max(1, report.requests))
                rate = await success_rate_24h(conn, row["id"], started)
                health = policy.health_state(
                    enabled=row["enabled"], last_ok_at=row["last_ok_at"], failing_since=failing_since, now=started,
                    success_rate_24h=rate,
                    drifted=policy.is_drifted(row["access"], row["last_nonempty_at"], row["zero_streak"],
                                              row["ever_dated"], row["undated_streak"]))
                await conn.execute(
                    """UPDATE evimed_knowledge.sources SET lease_owner = NULL, lease_until = NULL, next_poll_at = %s,
                              last_attempt_at = %s, consecutive_failures = %s, failing_since = %s,
                              last_error_code = %s, health = %s, updated_at = %s WHERE id = %s""",
                    (started + timedelta(seconds=delay), started, failures, failing_since,
                     f"{failure.outcome}:{failure.detail}"[:100], health, started, row["id"]),
                )

    async def _finish_success(self, row: dict, report: PollReport, started: datetime, *, totals: StoreResult,
                              first: dict, cursor: dict | None, full: bool, not_modified: bool, host: str | None,
                              bytes_total: int) -> None:
        report.duration_ms = self._duration_ms(started)
        interval, empty_polls = policy.adapt_interval(row["poll_interval_s"], row["poll_floor_s"], row["poll_ceiling_s"],
                                                      totals.new, row["empty_polls"])
        last_nonempty_at, zero_streak = row["last_nonempty_at"], row["zero_streak"]
        ever_dated, undated_streak = row["ever_dated"], row["undated_streak"]
        if not not_modified:
            if totals.seen > 0:
                last_nonempty_at, zero_streak = started, 0
                if totals.dated > 0:
                    ever_dated, undated_streak = True, 0
                else:
                    undated_streak += 1
            else:
                zero_streak += 1
        headers = first.get("headers") or {}
        took_validators = first.get("status") == 200
        etag = headers.get("etag") if took_validators else row["etag"]
        last_modified = headers.get("last-modified") if took_validators else row["last_modified"]
        content_sha = first.get("body_sha256") or row["last_content_sha256"]
        drifted = policy.is_drifted(row["access"], last_nonempty_at, zero_streak, ever_dated, undated_streak)
        async with self._pool.connection() as conn:
            async with conn.transaction():
                await insert_fetch(conn, source_id=row["id"], fetched_at=started, egress=row["egress"], host=host,
                                   http_status=first.get("status"), outcome=report.outcome, bytes_=bytes_total,
                                   duration_ms=report.duration_ms, content_sha256=first.get("body_sha256"),
                                   entries_seen=totals.seen, entries_new=totals.new + totals.backfilled,
                                   error_detail=report.detail, requests=max(1, report.requests))
                rate = await success_rate_24h(conn, row["id"], started)
                health = policy.health_state(enabled=row["enabled"], last_ok_at=started, failing_since=None,
                                             now=started, success_rate_24h=rate, drifted=drifted)
                await conn.execute(
                    """UPDATE evimed_knowledge.sources SET lease_owner = NULL, lease_until = NULL,
                              next_poll_at = %(next)s, poll_interval_s = %(interval)s, empty_polls = %(empty)s,
                              last_attempt_at = %(now)s, last_ok_at = %(now)s,
                              first_contact_at = coalesce(first_contact_at, %(now)s),
                              last_new_entry_at = CASE WHEN %(new)s > 0 THEN %(now)s ELSE last_new_entry_at END,
                              consecutive_failures = 0, failing_since = NULL, last_error_code = %(detail)s,
                              etag = %(etag)s, last_modified = %(lm)s, last_content_sha256 = %(sha)s,
                              last_url = coalesce(%(url)s, last_url),
                              cursor = coalesce(%(cursor)s, cursor),
                              last_full_scan_at = CASE WHEN %(full)s THEN %(now)s ELSE last_full_scan_at END,
                              last_nonempty_at = %(nonempty)s, zero_streak = %(zero)s, ever_dated = %(dated)s,
                              undated_streak = %(undated)s, health = %(health)s, updated_at = %(now)s
                        WHERE id = %(id)s""",
                    {"next": policy.next_slot(row["id"], interval, started), "interval": interval, "empty": empty_polls,
                     "now": started, "new": totals.new, "detail": (report.detail or "")[:100] or None, "etag": etag,
                     "lm": last_modified, "sha": content_sha, "url": first.get("url"),
                     "cursor": Jsonb(cursor) if cursor is not None else None, "full": full,
                     "nonempty": last_nonempty_at, "zero": zero_streak, "dated": ever_dated, "undated": undated_streak,
                     "health": health, "id": row["id"]},
                )

    # ------------------------------------------------------------------ text enrichment

    async def _text_tick(self) -> None:
        if self._settings.text_concurrency <= 0:
            return
        limit = TEXT_BATCH if self._enrich_batch is not None else self._settings.text_concurrency
        async with self._pool.connection() as conn:
            jobs = await claim_texts(conn, limit, self._clock(), self._settings.lease_s)
        if not jobs:
            return
        if self._enrich_batch is not None and len(jobs) > 1:
            await self.enrich_many(jobs)
            return
        gate = asyncio.Semaphore(self._settings.text_concurrency)

        async def one(job: dict) -> None:
            async with gate:
                await self.enrich_one(job)

        await asyncio.gather(*(one(job) for job in jobs))

    async def enrich_many(self, jobs: list[dict]) -> list[str]:
        """One ``enrich_batch`` call for several due entries (it shares the PubMed / Europe PMC round
        trips); a batch that fails as a whole puts every job back on its retry schedule."""
        now = self._clock()
        try:
            async with asyncio.timeout(ENRICH_TIMEOUT_S * 2):
                results = await self._enrich_batch(jobs, self._fetcher, self._settings)
            if len(results) != len(jobs) or not all(isinstance(r, EntryTextResult) for r in results):
                raise TypeError("enrich_batch returned a list that does not match its input")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            code = f"{error.outcome}:{error.detail}" if isinstance(error, FetchError) else f"enrich_failed:{type(error).__name__}"
            if not isinstance(error, (FetchError, TimeoutError)):
                log.exception("batch enrichment of %s entries failed", len(jobs))
            statuses = []
            async with self._pool.connection() as conn:
                for job in jobs:
                    statuses.append(await text_failure(conn, job, code, now))
            return statuses
        statuses = []
        async with self._pool.connection() as conn:
            for job, result in zip(jobs, results, strict=True):
                statuses.append(await save_text_result(conn, job, result, now))
        log.info("texts: %s", dict(Counter(statuses)))
        return statuses

    async def enrich_one(self, job: dict) -> str:
        now = self._clock()
        if self._enricher is None:
            async with self._pool.connection() as conn:
                return await text_failure(conn, job, "enricher_unavailable", now, retry_s=3600)
        try:
            async with asyncio.timeout(ENRICH_TIMEOUT_S):
                result = await self._enricher(job, self._fetcher, self._settings)
            if not isinstance(result, EntryTextResult):
                raise TypeError("enricher returned something other than EntryTextResult")
        except asyncio.CancelledError:
            raise
        except FetchError as error:
            async with self._pool.connection() as conn:
                return await text_failure(conn, job, f"{error.outcome}:{error.detail}", now,
                                          retry_s=int(error.retry_after_s or 3600))
        except TimeoutError:
            async with self._pool.connection() as conn:
                return await text_failure(conn, job, "enrich_timeout", now)
        except Exception as error:
            log.exception("enrichment of %s failed", job["entry_id"])
            async with self._pool.connection() as conn:
                return await text_failure(conn, job, f"enrich_failed:{type(error).__name__}", now)
        async with self._pool.connection() as conn:
            status = await save_text_result(conn, job, result, now)
        log.info("text %s %s via %s", job["entry_id"], status, result.fetched_from or "-")
        return status

    # ------------------------------------------------------------------ maintenance

    async def maintenance(self) -> dict:
        """Retention purge + entries_7d; bounded deletes, repeated next hour if more remain."""
        now = self._clock()
        done: dict = {}
        async with self._pool.connection() as conn:
            deleted = await (await conn.execute(
                """DELETE FROM evimed_knowledge.fetches WHERE id IN (
                     SELECT id FROM evimed_knowledge.fetches WHERE fetched_at < %s ORDER BY id LIMIT %s) RETURNING id""",
                (now - timedelta(days=14), PURGE_BATCH),
            )).fetchall()
            done["fetches"] = len(deleted)
            purged_max = 0
            purged = 0
            for condition, age in (("text_requested_at IS NULL", timedelta(days=30)),
                                   ("text_requested_at IS NOT NULL", timedelta(days=90))):
                async with conn.transaction():
                    rows = await (await conn.execute(
                        f"""DELETE FROM evimed_knowledge.entries WHERE seq IN (
                              SELECT seq FROM evimed_knowledge.entries WHERE {condition} AND delivered_at < %s
                               ORDER BY seq LIMIT %s) RETURNING seq""",
                        (now - age, PURGE_BATCH),
                    )).fetchall()
                    if rows:
                        purged += len(rows)
                        purged_max = max(purged_max, max(r["seq"] for r in rows))
                        watermark = int(await meta_get(conn, "purged_through_seq", 0) or 0)
                        if purged_max > watermark:
                            await meta_set(conn, "purged_through_seq", purged_max)
            done["entries"] = purged
            deleted = await (await conn.execute(
                """DELETE FROM evimed_knowledge.seen_keys WHERE (source_id, key_sha256) IN (
                     SELECT source_id, key_sha256 FROM evimed_knowledge.seen_keys WHERE last_seen_at < %s LIMIT %s)
                   RETURNING key_sha256""",
                (now - timedelta(days=400), PURGE_BATCH),
            )).fetchall()
            done["seen_keys"] = len(deleted)
            await conn.execute("DELETE FROM evimed_knowledge.host_counters WHERE day < %s", ((now - timedelta(days=30)).date(),))
            await conn.execute("DELETE FROM evimed_knowledge.host_state WHERE paused_until < %s", (now - timedelta(days=1),))
            await conn.execute(
                """WITH counts AS (
                     SELECT source_id, count(*) AS n FROM evimed_knowledge.entries
                      WHERE NOT backfill AND first_seen_at > %s GROUP BY source_id)
                   UPDATE evimed_knowledge.sources s SET entries_7d = coalesce(c.n, 0)
                     FROM evimed_knowledge.sources s2 LEFT JOIN counts c ON c.source_id = s2.id
                    WHERE s.id = s2.id AND s.entries_7d IS DISTINCT FROM coalesce(c.n, 0)""",
                (now - timedelta(days=7),),
            )
        if any(done.values()):
            log.info("retention purge: %s", done)
        return done

    async def watch_registry(self) -> None:
        path = self._settings.registry_path
        try:
            mtime = os.stat(path).st_mtime
        except OSError:
            log.error("registry file %s is unreadable; keeping the loaded registry", path)
            return
        if self._registry_mtime is None:
            self._registry_mtime = mtime
            return
        if mtime == self._registry_mtime:
            return
        self._registry_mtime = mtime
        try:
            rows = load_registry(path)
        except RegistryError as error:
            log.error("registry file changed but is invalid; keeping the loaded registry: %s", error)
            return
        async with self._pool.connection() as conn:
            await sync_registry(conn, rows, self._clock())


def _load_enricher() -> tuple[Callable | None, Callable | None]:
    """``knowledge_plugin.enrich``'s ``enrich`` and ``enrich_batch`` when this build has them (package P2)."""
    try:
        from . import enrich as module
    except ImportError as error:
        log.warning("no enrichment module in this build (%s); /text requests stay pending", error)
        return None, None
    single = getattr(module, "enrich", None)
    batch = getattr(module, "enrich_batch", None)
    if single is None and batch is None:
        log.warning("knowledge_plugin.enrich has neither enrich() nor enrich_batch(); /text requests stay pending")
    return single, batch
