"""The social collector: one loop beside the scheduler that reads X, WeChat and the six platforms (see the package).

Each tick (a minute) runs the three adapters in turn, each guarded on its own — one failing never stops the others —,
and once an hour the upkeep: the media store's eviction, the ledger's 30-day retention.

Every read of a source ends the way a scheduler poll does: one row in the fetch log (``ok`` or ``empty`` for a read,
``host-budget`` for a call the plugin itself declined — a daily cap, a paused provider —, the failure's outcome
otherwise), and the source's state updated in the same transaction — next read, last success, the failure streak and
health by the same rule (``policy.health_state``) — so ``/v1/sources`` and the hourly health re-check see these sources
like any other. A post already stored is not bought again: posts are matched against the stream by their key before any
media, article or body is fetched.
"""

from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime, timedelta, timezone

from psycopg.types.json import Jsonb

from .. import policy
from ..db import meta_get, meta_set
from ..model import SUCCESS_OUTCOMES
from ..normalize import Rejected, key_sha256, prepare
from ..registry import source_from_row
from ..store import StoreResult, insert_fetch, reliability_24h, store_entries
from . import crawl as crawl_mod
from . import wechat as wechat_mod
from . import x as x_mod
from .media import MediaStore
from .providers import (DAJIALA_HOST, SOCIALDATA_HOST, CrawlClient, DajialaClient, ProviderError, SocialDataClient)
from .spend import DAJIALA, SOCIALDATA, ProviderLedger, SpendCapReached, day_window

log = logging.getLogger("knowledge_plugin.social")

UPKEEP_EVERY = timedelta(hours=1)
WECHAT_PER_TICK = 6
REFUSED_PAUSE = timedelta(hours=1)
RATE_LIMITED_WAIT = timedelta(minutes=5)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class SocialCollector:
    def __init__(self, settings, pool, fetcher, *, clock=_utcnow, crawl_transport=None) -> None:
        self._settings = settings
        self._pool = pool
        self._clock = clock
        self.ledger = ProviderLedger(pool, clock)
        self.media = MediaStore(settings, pool, fetcher=fetcher, clock=clock)
        self.socialdata = SocialDataClient(fetcher, self.ledger, settings, clock)
        self.dajiala = DajialaClient(fetcher, self.ledger, settings, clock)
        self.crawler = CrawlClient(self.ledger, settings, clock, transport=crawl_transport)
        self.watch = crawl_mod.load_watch_list(settings.social_registry())
        self.paused: dict[str, datetime] = {}
        self._last_upkeep: datetime | None = None
        self.counters: Counter = Counter()
        self.last_error: str | None = None
        self.last_error_at: datetime | None = None

    # ------------------------------------------------------------------ the loop

    async def tick(self) -> dict:
        now = self._clock()
        report: dict = {}
        for name, step in (("x", self.run_x), ("wechat", self.run_wechat), ("crawl", self.run_crawl),
                           ("upkeep", self.upkeep)):
            try:
                report[name] = await step(now)
            except Exception as error:   # one adapter failing never stops the others; the error is named
                self.last_error, self.last_error_at = f"{name}:{type(error).__name__}", self._clock()
                log.exception("social %s step failed", name)
                report[name] = {"error": type(error).__name__}
        return report

    def _paused(self, provider: str, now: datetime) -> bool:
        until = self.paused.get(provider)
        return until is not None and now < until

    async def _rows(self, access: str) -> list[dict]:
        async with self._pool.connection() as conn:
            return await (await conn.execute(
                """SELECT * FROM evimed_knowledge.sources
                    WHERE access = %s AND enabled AND operator_enabled IS DISTINCT FROM false AND retired_at IS NULL
                    ORDER BY id""", (access,))).fetchall()

    async def _known(self, source_id: str, keys: list[str]) -> set[str]:
        """The keys of a source's posts already in the stream or in its 400-day memory."""
        keys = [key for key in keys if key]
        if not keys:
            return set()
        hashes = {key_sha256(key): key for key in keys}
        async with self._pool.connection() as conn:
            stored = await (await conn.execute(
                "SELECT external_key FROM evimed_knowledge.entries WHERE source_id = %s AND external_key = ANY(%s)",
                (source_id, keys))).fetchall()
            seen = await (await conn.execute(
                "SELECT key_sha256 FROM evimed_knowledge.seen_keys WHERE source_id = %s AND key_sha256 = ANY(%s)",
                (source_id, list(hashes)))).fetchall()
        return {row["external_key"] for row in stored} | {hashes[row["key_sha256"]] for row in seen}

    async def _store(self, row: dict, entries: list, now: datetime) -> StoreResult:
        source = source_from_row(row)
        prepared = []
        for entry in entries:
            if entry is None:
                continue
            try:
                prepared.append(prepare(entry, source))
            except Rejected as reason:
                self.counters[f"rejected:{reason.code}"] += 1
        if not prepared:
            return StoreResult()
        async with self._pool.connection() as conn:
            return await store_entries(conn, source.id, prepared, now=now, first_contact=row["first_contact_at"] is None)

    async def _finish(self, row: dict, now: datetime, *, outcome: str, next_at: datetime, host: str | None,
                      result: StoreResult | None = None, detail: str | None = None, cursor: dict | None = None,
                      requests: int = 1) -> None:
        """One fetch-log row and the source's state, in one transaction (module docstring)."""
        result = result or StoreResult()
        ok = outcome in SUCCESS_OUTCOMES
        neutral = outcome == "host-budget"
        async with self._pool.connection() as conn:
            async with conn.transaction():
                await insert_fetch(conn, source_id=row["id"], fetched_at=now, egress=row["egress"], host=host, http_status=None,
                                   outcome=outcome, bytes_=0, duration_ms=max(0, int((self._clock() - now).total_seconds() * 1000)),
                                   content_sha256=None, entries_seen=result.seen, entries_new=result.new + result.backfilled,
                                   error_detail=detail, requests=max(1, requests))
                if neutral:
                    await conn.execute(
                        """UPDATE evimed_knowledge.sources SET next_poll_at = %s, last_attempt_at = %s, last_error_code = %s,
                                  updated_at = %s WHERE id = %s""",
                        (next_at, now, (detail or "")[:100] or None, now, row["id"]))
                    return
                failures = 0 if ok else int(row["consecutive_failures"] or 0) + 1
                failing_since = None if ok else (row["failing_since"] or now)
                last_ok = now if ok else row["last_ok_at"]
                successes, episodes = await reliability_24h(conn, row["id"], now)
                health = policy.health_state(enabled=True, last_ok_at=last_ok, failing_since=failing_since, now=now,
                                             successes_24h=successes, failure_episodes_24h=episodes, drifted=False)
                await conn.execute(
                    """UPDATE evimed_knowledge.sources SET next_poll_at = %(next)s, last_attempt_at = %(now)s,
                              last_ok_at = %(last_ok)s,
                              first_contact_at = CASE WHEN %(ok)s THEN coalesce(first_contact_at, %(now)s) ELSE first_contact_at END,
                              last_new_entry_at = CASE WHEN %(new)s > 0 THEN %(now)s ELSE last_new_entry_at END,
                              last_nonempty_at = CASE WHEN %(seen)s > 0 THEN %(now)s ELSE last_nonempty_at END,
                              consecutive_failures = %(failures)s, failing_since = %(failing)s, last_error_code = %(detail)s,
                              cursor = coalesce(%(cursor)s, cursor), health = %(health)s, updated_at = %(now)s
                        WHERE id = %(id)s""",
                    {"next": next_at, "now": now, "last_ok": last_ok, "ok": ok, "new": result.new, "seen": result.seen,
                     "failures": failures, "failing": failing_since, "detail": (detail or "")[:100] or None,
                     "cursor": Jsonb(cursor) if cursor is not None else None, "health": health, "id": row["id"]})
        self.counters[f"poll:{outcome}"] += 1

    async def _failure_next(self, row: dict, now: datetime, error: ProviderError) -> datetime:
        delay = policy.failure_delay_s(row["poll_floor_s"], int(row["consecutive_failures"] or 0) + 1)
        if error.retry_after_s:
            delay = max(delay, int(error.retry_after_s))
        return now + timedelta(seconds=delay)

    # ------------------------------------------------------------------ X

    async def run_x(self, now: datetime) -> dict:
        if not self.socialdata.configured or self._paused(SOCIALDATA, now):
            return {"skipped": "unconfigured" if not self.socialdata.configured else "paused"}
        shards = x_mod.plan_shards(await self._rows("socialdata"))
        done: Counter = Counter()
        for shard in shards:
            if not any(member["next_poll_at"] <= now for member in shard.members):
                continue
            outcome = await self._x_shard(shard, now)
            done[outcome] += 1
            if outcome in ("capped", "balance"):
                break
        return dict(done)

    async def _x_shard(self, shard: x_mod.Shard, now: datetime) -> str:
        since = min(x_mod.covered_to(member, now) for member in shard.members)
        backlog, stretches = [], set()
        for member in shard.members:
            for stretch in (member["cursor"] or {}).get("backlog") or []:
                marker = f"{stretch.get('query')} {stretch.get('next')}"
                if marker not in stretches:
                    stretches.add(marker)
                    backlog.append(stretch)
        try:
            read = await x_mod.read_search(self.socialdata, shard.query, since, backlog)
        except SpendCapReached as capped:
            for member in shard.members:
                await self._finish(member, now, outcome="host-budget", detail="daily_cap", next_at=capped.retry_at,
                                   host=SOCIALDATA_HOST)
            return "capped"
        except ProviderError as error:
            if error.kind == "balance":
                self.paused[SOCIALDATA] = day_window(now)[1]
                for member in shard.members:
                    await self._finish(member, now, outcome="host-budget", detail="socialdata_balance",
                                       next_at=self.paused[SOCIALDATA], host=SOCIALDATA_HOST)
                return "balance"
            for member in shard.members:
                await self._finish(member, now, outcome="blocked" if error.kind == "refused" else "http-error",
                                   detail=f"socialdata_{error.kind}:{error.detail}"[:100],
                                   next_at=await self._failure_next(member, now, error), host=SOCIALDATA_HOST)
            return "failed"
        requests = read.pages + read.backlog_pages
        detail = f"shard={shard.key} pages={read.pages}" + (" truncated" if read.truncated else "") + (
            f" dropped={read.dropped}" if read.dropped else "")
        for member in shard.members:
            mine = [tweet for tweet in read.tweets if x_mod.written_by(tweet, member)]
            known = await self._known(member["id"], [str(tweet["id_str"]) for tweet in mine])
            entries = [await self._x_entry(tweet, member, now) for tweet in mine if str(tweet["id_str"]) not in known]
            result = await self._store(member, entries, now)
            own = int((member["cursor"] or {}).get("last_tweet_id") or 0)
            newest = max([own] + [int(tweet["id_str"]) for tweet in mine])
            cursor = {**(member["cursor"] or {}), "last_ok_at": now.isoformat(), "backlog": read.backlog}
            if newest:
                cursor["last_tweet_id"] = str(newest)
            await self._finish(member, now, outcome="ok" if mine else "empty", result=result, detail=detail,
                               next_at=now + x_mod.pace(member), cursor=cursor, requests=requests, host=SOCIALDATA_HOST)
        return "ok"

    async def _x_entry(self, tweet: dict, row: dict, now: datetime):
        media = [item for item in [await self.media.ensure(m["url"], kind=m["kind"], alt=m["alt"])
                                   for m in x_mod.tweet_media(tweet)] if item]
        quoted_media = []
        if isinstance(tweet.get("quoted_status"), dict):
            quoted_media = [item for item in [await self.media.ensure(m["url"], kind=m["kind"], alt=m["alt"])
                                              for m in x_mod.tweet_media(tweet["quoted_status"])] if item]
        article = None
        if x_mod.links_article(x_mod.tweet_text(tweet)):
            try:
                found = await self.socialdata.article(str(tweet["id_str"]))
                article = x_mod.article_text(found) if found else None
            except (ProviderError, SpendCapReached) as error:
                self.counters["x_article_unavailable"] += 1
                log.info("x article of %s not read: %s", tweet["id_str"], type(error).__name__)
        return x_mod.build_entry(tweet, row, now=now, media=media, quoted_media=quoted_media, article=article)

    # ------------------------------------------------------------------ WeChat

    async def run_wechat(self, now: datetime) -> dict:
        if not self.dajiala.configured or self._paused(DAJIALA, now):
            return {"skipped": "unconfigured" if not self.dajiala.configured else "paused"}
        due = [row for row in await self._rows("dajiala") if row["next_poll_at"] <= now]
        due.sort(key=lambda row: (wechat_mod.priority(row), row["next_poll_at"], row["id"]))
        done: Counter = Counter()
        for row in due[:WECHAT_PER_TICK]:
            outcome = await self._wechat_account(row, now)
            done[outcome] += 1
            if outcome in ("capped", "balance", "refused", "rate-limited"):
                break
        return dict(done)

    async def _wechat_account(self, row: dict, now: datetime) -> str:
        cursor = dict(row["cursor"] or {})
        config = row["config"] or {}
        resolved = cursor.get("resolved") if isinstance(cursor.get("resolved"), dict) else None
        try:
            if resolved and resolved.get("ghid"):
                history = await self.dajiala.post_history(ghid=resolved["ghid"])
            else:
                verified = config.get("verified_url")
                if not verified:
                    await self._finish(row, now, outcome="blocked", detail="wechat_unverified", host=DAJIALA_HOST,
                                       next_at=now + wechat_mod.MISMATCH_PARK)
                    return "unverified"
                history = await self.dajiala.post_history(url=verified)
        except SpendCapReached as capped:
            await self._finish(row, now, outcome="host-budget", detail="daily_cap", next_at=capped.retry_at, host=DAJIALA_HOST)
            return "capped"
        except ProviderError as error:
            return await self._wechat_failed(row, now, error)
        nickname = history.nickname or (resolved or {}).get("nickname")
        if not resolved or not resolved.get("ghid"):
            if not wechat_mod.nickname_matches(history.nickname, row):
                cursor["mismatch"] = {"nickname": (history.nickname or "")[:100], "at": now.isoformat()}
                await self._finish(row, now, outcome="blocked", detail="wechat_nickname_mismatch", cursor=cursor,
                                   next_at=now + wechat_mod.MISMATCH_PARK, host=DAJIALA_HOST)
                log.warning("wechat %s: the verified link names another account; parked", row["id"])
                return "mismatch"
            cursor.pop("mismatch", None)
            cursor["resolved"] = {"ghid": history.ghid, "nickname": history.nickname, "at": now.isoformat()}
        posts = sorted(history.posts, key=lambda post: -(wechat_mod.post_time(post) or now).timestamp())
        known = await self._known(row["id"], [wechat_mod.external_key(post) for post in posts])
        first_contact = row["first_contact_at"] is None
        bodies, buying, entries = 0, True, []
        for post in posts:
            key = wechat_mod.external_key(post)
            if not key or key in known:
                continue
            cover = None
            if isinstance(post.get("cover_url"), str) and post["cover_url"].startswith(("http://", "https://")):
                cover = await self.media.ensure(post["cover_url"].replace("http://", "https://", 1))
            detail = None
            if buying and bodies < wechat_mod.MAX_BODIES_PER_READ and (not first_contact or wechat_mod.is_recent(post, now)):
                link, _ = wechat_mod.article_link(post.get("url"))
                try:
                    detail = await self.dajiala.article_detail(link) if link else None
                    bodies += 1 if detail else 0
                except SpendCapReached:
                    buying = False
                except ProviderError as error:
                    if error.kind in ("balance", "refused"):
                        buying = False
                        if error.kind == "balance":
                            self.paused[DAJIALA] = day_window(now)[1]
            entries.append(wechat_mod.build_entry(post, row, nickname or row["name"], now=now, cover=cover, detail=detail))
        result = await self._store(row, entries, now)
        await self._finish(row, now, outcome="ok" if posts else "empty", result=result, cursor=cursor, host=DAJIALA_HOST,
                           detail=f"bodies={bodies}", requests=1 + bodies,
                           next_at=now + timedelta(days=1) / wechat_mod.polls_per_day(row))
        return "ok"

    async def _wechat_failed(self, row: dict, now: datetime, error: ProviderError) -> str:
        if error.kind == "balance":
            self.paused[DAJIALA] = day_window(now)[1]
            await self._finish(row, now, outcome="host-budget", detail="dajiala_balance", next_at=self.paused[DAJIALA],
                               host=DAJIALA_HOST)
            return "balance"
        if error.kind == "refused":
            self.paused[DAJIALA] = now + REFUSED_PAUSE
            await self._finish(row, now, outcome="host-budget", detail="dajiala_key_refused", next_at=self.paused[DAJIALA],
                               host=DAJIALA_HOST)
            return "refused"
        if error.kind == "rate-limited":
            await self._finish(row, now, outcome="host-budget", detail="dajiala_rate_limited", next_at=now + RATE_LIMITED_WAIT,
                               host=DAJIALA_HOST)
            return "rate-limited"
        next_at = now + wechat_mod.GONE_RETRY if error.kind == "gone" else await self._failure_next(row, now, error)
        await self._finish(row, now, outcome="http-error", detail=f"dajiala_{error.kind}:{error.detail}"[:100],
                           next_at=next_at, host=DAJIALA_HOST)
        return "failed"

    # ------------------------------------------------------------------ the six platforms

    async def run_crawl(self, now: datetime) -> dict:
        if not self.crawler.configured or not self.watch:
            return {"skipped": "unconfigured" if not self.crawler.configured else "no_watch_list"}
        async with self._pool.connection() as conn:
            state = dict(await meta_get(conn, crawl_mod.STATE_KEY) or {})
        if state.get("next_at") and now < datetime.fromisoformat(state["next_at"]):
            return {"skipped": "not_yet"}
        rows = {(row["config"] or {}).get("crawl_platform"): row for row in await self._rows("social-crawl")}
        platforms = [name for name in crawl_mod.PLATFORMS if name in rows]
        pair = crawl_mod.next_pair(self.watch, platforms, state.get("last") or {})
        if pair is None:
            return {"skipped": "no_platform"}
        term, platform = pair
        row = rows[platform]
        try:
            answer = await self.crawler.crawl(term, platform)
        except SpendCapReached as capped:
            state["next_at"] = capped.retry_at.isoformat()
            await self._save_crawl_state(state)
            await self._finish(row, now, outcome="host-budget", detail="daily_cap", next_at=capped.retry_at, host=None)
            return {"capped": True}
        except ProviderError as error:
            busy = error.kind == "rate-limited"
            wait = crawl_mod.BUSY_WAIT if busy else crawl_mod.FAILURE_WAIT
            state["next_at"] = (now + wait).isoformat()
            await self._save_crawl_state(state)
            await self._finish(row, now, outcome="host-budget" if busy else "http-error",
                               detail=("geo_busy" if busy else f"crawl_{error.detail}")[:100], next_at=now + wait, host=None)
            return {"busy" if busy else "failed": error.detail}
        posts = answer.get("posts") if isinstance(answer.get("posts"), list) else []
        candidates = [crawl_mod.build_entry(post, platform, now=now) for post in posts]
        candidates = [entry for entry in candidates if entry is not None]
        known = await self._known(row["id"], [entry.external_key for entry in candidates])
        result = await self._store(row, [entry for entry in candidates if entry.external_key not in known], now)
        last = dict(state.get("last") or {})
        last[f"{term}|{platform}"] = now.isoformat()
        state.update(last=last, next_at=(now + crawl_mod.interval(self._settings.social_crawl_daily)).isoformat())
        await self._save_crawl_state(state)
        status = str((answer.get("meta") or {}).get("collection_status") or "")
        await self._finish(row, now, outcome="ok" if candidates else "empty", result=result, host=None,
                           detail=f"term={term[:40]} status={status[:20]}",
                           next_at=now + crawl_mod.interval(self._settings.social_crawl_daily))
        return {"term": term, "platform": platform, "posts": len(candidates), "new": result.new}

    async def _save_crawl_state(self, state: dict) -> None:
        async with self._pool.connection() as conn:
            await meta_set(conn, crawl_mod.STATE_KEY, state)

    # ------------------------------------------------------------------ upkeep

    async def upkeep(self, now: datetime) -> dict:
        if self._last_upkeep is not None and now - self._last_upkeep < UPKEEP_EVERY:
            return {"skipped": "not_yet"}
        self._last_upkeep = now
        evicted = await self.media.evict()
        purged = await self.ledger.purge(now)
        async with self._pool.connection() as conn:
            await conn.execute("DELETE FROM evimed_knowledge.media_failures WHERE failed_at < %s", (now - timedelta(days=7),))
        return {"evicted": evicted, "ledger_purged": purged}
