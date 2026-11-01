"""The three upstreams of the social adapters, one client each, every call through the provider ledger.

SocialData and Dajiala are public paid APIs and go through the protected fetch like every other request of the plugin: the
fetcher adds the key (SocialData's ``Authorization: Bearer``, Dajiala's ``key`` query parameter — measured on 2026-10-22:
a POST with the key only in the query is read, a wrong key answers 10002), pins DNS, paces the host and pauses it on a 429.
The GEO module's crawler is an internal service at an address the operator configures (production:
``OPEN_SCIENCE_GEO_SOCIAL_URL``); it is reached with a plain client, one request at a time, because it serves one request
at a time and the GEO module's own requests come first.

What each costs (the ledger's amounts):

- SocialData: US$0.20 per 1,000 returned objects, ``objects × 0.0002`` (AIHOT ``providers/socialdata.ts``); a search
  page is at most 20 tweets, a user or an article one object; a 404 (no such user or post) costs nothing.
- Dajiala: what the answer's ``cost_money`` says (``post_history`` ¥0.14 by id or link, ¥0.16 by nickname,
  ``article_detail`` ¥0.03), with
  ``remain_money`` recorded as the balance. Codes (its documentation, 2026): 0 ok; -1 rate limited (5 a second); 20001
  balance; 10002 key or code wrong; 101/104/107 the account or article is gone (charged; 107 is AIHOT's too); 105/20003/30001/400 the request
  was wrong (free); 2003/2005/50000 the provider failed, try later. 20002 is documented as a wrong request but behaves as
  one that passes: on 2026-10-22 production had 88 of 300 ``article_detail`` calls answer it, all between 16:21 and 17:29
  Beijing while the balance ran down, and the same links read fine after the top-up — so it is ``failed`` (try later),
  and what bounds the retries is the caller's (``collector``: six calls per entry's text, a pause after five in a row).
- The crawler: one request, counted against the day's request cap; 429/503 means GEO is using it. A crawl of XHS or Weibo asks for
  the provider's raw answer (``include_provider_raw``) so a post's pictures can be named from the file ids in it
  (``crawl.pictures_of``); the answer is large (``CRAWL_MAX_BYTES``) and is dropped by the collector. ``CrawlClient.retained``
  reads the crawler's retained jobs (``GET /api/jobs``) for ``social-bodies``: no crawl, no request against the day's cap.
"""

from __future__ import annotations

import asyncio
import json
import logging
import ipaddress
import re
from uuid import uuid4
from dataclasses import dataclass
from urllib.parse import urlencode, urlsplit

import httpx

from ..model import FetchError, RequestSpec
from .crawl import PICTURE_PLATFORMS
from .spend import DAJIALA, SOCIAL_CRAWL, SOCIALDATA, Cap, ProviderLedger

log = logging.getLogger("knowledge_plugin.social.providers")

SOCIALDATA_BASE = "https://api.socialdata.tools"
SOCIALDATA_HOST = "api.socialdata.tools"
OBJECT_USD = 0.0002
SEARCH_PAGE_OBJECTS = 20
DAJIALA_BASE = "https://www.dajiala.com"
DAJIALA_HOST = "www.dajiala.com"
POST_HISTORY_CNY = 0.14
POST_HISTORY_BY_NAME_CNY = 0.16
ARTICLE_DETAIL_CNY = 0.03
DAJIALA_RATE_LIMITED = -1
DAJIALA_BALANCE = 20001
DAJIALA_GONE = (101, 104, 107)       # 107: measured 2026-10-24 on a nickname no account answers to (¥0.02)
DAJIALA_RETRY = (2003, 2005, 20002, 50000)    # 20002: module docstring
CRAWL_PATH = "/api/jobs"
# The answer's size cap: a bound on a runaway answer. With the provider's raw answer (asked for XHS and Weibo only) a detailed post is
# 12–15 KB (retained answers, 2026-10-31), far inside it; an answer over it parks the platform.
CRAWL_MAX_BYTES = 8 * 1024 * 1024
# A poll of an accepted job that met a busy answer (429/503) or a dropped connection is asked again, at most this many times and
# within the crawl's one deadline: the job is running there, and one blip must not end it. The platform's own client retries twice.
CRAWL_POLL_RETRY_DELAYS_S = (0.5, 2.0)
CRAWL_MAX_RETRY_AFTER_S = 30.0


class ProviderError(Exception):
    """A provider call that gave nothing usable. ``kind``: ``rate-limited`` (come back later), ``balance`` (the account
    is out of money: the provider stops for the day), ``refused`` (key wrong, private account), ``gone`` (the account or
    post no longer exists), ``bad-request`` and ``failed``. ``retry_after_s`` when the provider said when."""

    def __init__(self, provider: str, kind: str, detail: str, *, retry_after_s: float | None = None) -> None:
        super().__init__(f"{provider}: {kind}: {detail}")
        self.provider = provider
        self.kind = kind
        self.detail = detail[:200]
        self.retry_after_s = retry_after_s


def _retry_after_s(headers, fallback: float) -> float:
    """``Retry-After`` in seconds when the collector gave a number, capped; otherwise the retry's own delay."""
    try:
        seconds = float(headers.get("retry-after", ""))
    except (TypeError, ValueError):
        return fallback
    return min(CRAWL_MAX_RETRY_AFTER_S, max(0.0, seconds)) if seconds == seconds else fallback


def _ledger_outcome(kind: str) -> str:
    return {"rate-limited": "rate-limited", "balance": "balance", "refused": "refused", "gone": "missing"}.get(kind, "failed")


# ------------------------------------------------------------------------------------ SocialData (X)

class SocialDataClient:
    def __init__(self, fetcher, ledger: ProviderLedger, settings, clock) -> None:
        self._fetcher = fetcher
        self._ledger = ledger
        self._settings = settings
        self._clock = clock
        self.calls = 0

    @property
    def configured(self) -> bool:
        return bool(self._settings.secret("socialdata_key"))

    @property
    def cap(self) -> Cap:
        return Cap(SOCIALDATA, float(self._settings.socialdata_daily_usd))

    async def _get(self, path: str, *, purpose: str, most_objects: int, count) -> dict | None:
        """One paid GET: the cap is checked for its largest cost, the answer's real cost is recorded; ``None`` for a 404."""
        await self._ledger.check(self.cap, most_objects * OBJECT_USD)
        self.calls += 1
        try:
            result = await self._fetcher.fetch(
                RequestSpec(url=SOCIALDATA_BASE + path, headers={"Accept": "application/json"}, conditional=False, api=True),
                source_id="socialdata", egress="api", allowed_hosts=[SOCIALDATA_HOST])
        except FetchError as error:
            if error.status == 404:
                await self._ledger.record(SOCIALDATA, purpose=purpose, outcome="missing")
                return None
            kind = ("rate-limited" if error.status == 429 else "balance" if error.status == 402
                    else "refused" if error.status in (401, 403) else "failed")
            await self._ledger.record(SOCIALDATA, purpose=purpose, outcome=_ledger_outcome(kind),
                                      error=f"{error.outcome}:{error.detail}")
            raise ProviderError(SOCIALDATA, kind, error.detail, retry_after_s=error.retry_after_s) from None
        if result.status == 404:
            await self._ledger.record(SOCIALDATA, purpose=purpose, outcome="missing")
            return None
        try:
            body = json.loads(result.body)
        except ValueError:
            await self._ledger.record(SOCIALDATA, purpose=purpose, outcome="failed", error="invalid_json")
            raise ProviderError(SOCIALDATA, "failed", "invalid_json") from None
        if not isinstance(body, dict) or body.get("status") == "error":
            await self._ledger.record(SOCIALDATA, purpose=purpose, outcome="missing")
            return None
        objects = max(0, int(count(body)))
        await self._ledger.record(SOCIALDATA, purpose=purpose, outcome="ok", objects=objects, amount=objects * OBJECT_USD)
        return body

    async def search(self, query: str, cursor: str | None = None, *, purpose: str = "search") -> tuple[list[dict], str | None]:
        """One page of a newest-first search: ``(tweets, next cursor)``. ``purpose`` is the ledger's label for the call."""
        params = {"query": query, "type": "Latest"}
        if cursor:
            params["cursor"] = cursor
        body = await self._get("/twitter/search?" + urlencode(params), purpose=purpose,
                               most_objects=SEARCH_PAGE_OBJECTS, count=lambda b: len(b.get("tweets") or []))
        if body is None:
            return [], None
        tweets = [t for t in body.get("tweets") or [] if isinstance(t, dict)]
        following = body.get("next_cursor")
        return tweets, following if isinstance(following, str) and following else None

    async def user(self, handle: str, *, purpose: str = "user") -> dict | None:
        """The account behind a handle, or ``None`` when there is none."""
        return await self._get("/twitter/user/" + handle, purpose=purpose, most_objects=1, count=lambda b: 1)

    async def article(self, tweet_id: str) -> dict | None:
        """The X Article a post published (looked up by the post's id), or ``None``."""
        body = await self._get(f"/twitter/article/{tweet_id}", purpose="article", most_objects=1,
                               count=lambda b: 1 if isinstance(b.get("article"), dict) else 0)
        article = (body or {}).get("article")
        return article if isinstance(article, dict) else None


# ------------------------------------------------------------------------------------ Dajiala (WeChat)

@dataclass
class History:
    nickname: str | None
    ghid: str | None
    posts: list[dict]
    remaining: float | None


class DajialaClient:
    def __init__(self, fetcher, ledger: ProviderLedger, settings, clock) -> None:
        self._fetcher = fetcher
        self._ledger = ledger
        self._settings = settings
        self._clock = clock
        self.calls = 0

    @property
    def configured(self) -> bool:
        return bool(self._settings.secret("dajiala_key"))

    @property
    def cap(self) -> Cap:
        return Cap(DAJIALA, float(self._settings.dajiala_daily_cny))

    async def _call(self, spec: RequestSpec, *, purpose: str, most: float) -> dict:
        await self._ledger.check(self.cap, most)
        for attempt in range(2):
            self.calls += 1
            try:
                result = await self._fetcher.fetch(spec, source_id="dajiala", egress="api", allowed_hosts=[DAJIALA_HOST])
                body = json.loads(result.body)
                if not isinstance(body, dict):
                    raise ValueError("not an object")
            except FetchError as error:
                kind = "rate-limited" if error.status == 429 else "refused" if error.status in (401, 403) else "failed"
                await self._ledger.record(DAJIALA, purpose=purpose, outcome=_ledger_outcome(kind), error=f"{error.outcome}:{error.detail}")
                raise ProviderError(DAJIALA, kind, error.detail, retry_after_s=error.retry_after_s) from None
            except ValueError:
                await self._ledger.record(DAJIALA, purpose=purpose, outcome="failed", error="invalid_json")
                raise ProviderError(DAJIALA, "failed", "invalid_json") from None
            code = _int(body.get("code"))
            cost = _float(body.get("cost_money")) or 0.0
            remaining = _float(body.get("remain_money"))
            if code == 0:
                await self._ledger.record(DAJIALA, purpose=purpose, outcome="ok", amount=cost, remaining=remaining)
                return body
            kind = ("rate-limited" if code == DAJIALA_RATE_LIMITED else "balance" if code == DAJIALA_BALANCE
                    else "refused" if code == 10002 else "gone" if code in DAJIALA_GONE
                    else "failed" if code in DAJIALA_RETRY else "bad-request")
            await self._ledger.record(DAJIALA, purpose=purpose, outcome=_ledger_outcome(kind), amount=cost,
                                      remaining=remaining, error=f"code_{code}")
            if kind == "rate-limited" and attempt == 0:
                await asyncio.sleep(5)          # its documentation: wait five seconds
                continue
            raise ProviderError(DAJIALA, kind, f"code_{code}", retry_after_s=60 if kind == "rate-limited" else None)
        raise ProviderError(DAJIALA, "rate-limited", "code_-1", retry_after_s=60)

    async def post_history(self, *, ghid: str | None = None, url: str | None = None, nickname: str | None = None,
                           purpose: str = "post_history") -> History:
        """An account's latest posts, by its original id or by the link of any of its articles (one call, ¥0.14), or by
        its nickname (¥0.16; measured 2026-10-24: the answer names the account — ``nickname``, ``ghid`` — and its posts
        carry its ``__biz``; asked by ``biz`` it answers code 105, free). Exactly one of the three is sent."""
        if ghid:
            payload, most = {"ghid": ghid}, POST_HISTORY_CNY
        elif url:
            payload, most = {"url": url}, POST_HISTORY_CNY
        elif nickname:
            payload, most = {"nickname": nickname}, POST_HISTORY_BY_NAME_CNY
        else:
            raise ValueError("post_history needs a ghid, a url or a nickname")
        spec = RequestSpec(url=f"{DAJIALA_BASE}/fbmain/monitor/v3/post_history", method="POST",
                           body=json.dumps({**payload, "verifycode": ""}).encode("utf-8"),
                           headers={"Content-Type": "application/json", "Accept": "application/json"},
                           conditional=False, api=True)
        body = await self._call(spec, purpose=purpose, most=most)
        posts = [post for post in body.get("data") or [] if isinstance(post, dict)]
        return History(nickname=_text(body.get("nickname") or body.get("nick_name")),
                       ghid=_text(body.get("ghid") or body.get("user_name")), posts=posts,
                       remaining=_float(body.get("remain_money")))

    async def article_detail(self, url: str) -> dict:
        """One article's text (mode 1: light HTML with its paragraphs and images), ¥0.03."""
        spec = RequestSpec(url=f"{DAJIALA_BASE}/fbmain/monitor/v3/article_detail?" + urlencode({"url": url, "mode": "1",
                                                                                               "verifycode": ""}),
                           headers={"Accept": "application/json"}, conditional=False, api=True)
        return await self._call(spec, purpose="article_detail", most=ARTICLE_DETAIL_CNY)


# ------------------------------------------------------------------------------------ the GEO module's crawler

class CrawlClient:
    """One authenticated asynchronous job; polling never submits another crawl."""

    def __init__(self, ledger: ProviderLedger, settings, clock, *, transport: httpx.AsyncBaseTransport | None = None,
                 poll_interval_s: float = 1.0, poll_retry_delays_s: tuple[float, ...] = CRAWL_POLL_RETRY_DELAYS_S) -> None:
        self._ledger = ledger
        self._settings = settings
        self._clock = clock
        self._transport = transport
        self._poll_interval_s = max(0.001, poll_interval_s)
        self._poll_retry_delays_s = poll_retry_delays_s
        self.calls = 0

    @property
    def configured(self) -> bool:
        return bool(self._settings.social_crawl_url and self._settings.secret("social_crawl_key"))

    @property
    def cap(self) -> Cap:
        return Cap(SOCIAL_CRAWL, float(self._settings.social_crawl_daily))

    def _headers(self, idempotency_key: str | None = None) -> dict:
        key = self._settings.secret("social_crawl_key")
        if not key or any(ord(char) < 33 or ord(char) > 126 for char in key):
            raise ProviderError(SOCIAL_CRAWL, "refused", "credential_unavailable")
        headers = {"Accept": "application/json", "Authorization": f"Bearer {key}"}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return headers

    def _endpoint(self) -> str:
        origin = self._settings.social_crawl_url or ""
        parsed = urlsplit(origin)
        host = parsed.hostname or ""
        try:
            private = ipaddress.ip_address(host).is_private
        except ValueError:
            private = "." not in host or host.endswith((".internal", ".localhost", ".local"))
        if not origin or (parsed.scheme == "http" and not private and not self._settings.social_crawl_allow_plaintext):
            raise ProviderError(SOCIAL_CRAWL, "refused", "endpoint_unavailable")
        return origin

    async def crawl(self, query: str, platform: str, *, detail_posts: int = 5) -> dict:
        """Keep a single deadline and one ledger charge for submit plus all polling reads."""
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 256 or platform not in (
                "xhs", "douyin", "zhihu", "weibo", "bilibili", "wechat_channels"):
            raise ProviderError(SOCIAL_CRAWL, "bad-request", "invalid_input")
        origin = self._endpoint()
        self._headers()
        await self._ledger.check(self.cap, 1)
        self.calls += 1
        # `platforms`, as the platform's own client sends it: the collector's job takes a list, one name for this crawl.
        body = {"query": query, "platforms": [platform], "sort_type": "latest", "page": 1,
                "minimum_detail_posts": max(0, min(50, detail_posts)), "minimum_comments_per_post": 0,
                "collect_comments": False, "include_provider_raw": platform in PICTURE_PLATFORMS}
        accepted = False
        outcome, detail, objects = "failed", "request_failed", 0
        try:
            async with asyncio.timeout(self._settings.social_crawl_timeout_s):
                async with httpx.AsyncClient(transport=self._transport, timeout=self._settings.social_crawl_timeout_s,
                                             follow_redirects=False) as client:
                    async def request(method, path, *, payload=None, idempotency_key=None):
                        nonlocal accepted
                        # Only a poll is asked again: a submit that met a busy answer was not accepted and is the caller's to retry later.
                        delays = self._poll_retry_delays_s if method == "GET" else ()
                        for attempt in range(len(delays) + 1):
                            wait = None
                            try:
                                async with client.stream(method, origin + path, json=payload,
                                                         headers=self._headers(idempotency_key)) as response:
                                    # 202: a job started; 200: a job the collector already held under the key. Both are accepted.
                                    if method == "POST" and response.status_code in (200, 202):
                                        accepted = True
                                    if response.status_code in (429, 503):
                                        if not accepted:
                                            raise ProviderError(SOCIAL_CRAWL, "rate-limited", f"http_{response.status_code}")
                                        if attempt >= len(delays):
                                            raise ProviderError(SOCIAL_CRAWL, "failed", "accepted_result_unavailable")
                                        wait = _retry_after_s(response.headers, delays[attempt])
                                    elif response.status_code not in (200, 202):
                                        raise ProviderError(SOCIAL_CRAWL, "failed", "accepted_result_unavailable" if accepted else f"http_{response.status_code}")
                                    else:
                                        chunks, size = [], 0
                                        async for chunk in response.aiter_bytes():
                                            size += len(chunk)
                                            if size > CRAWL_MAX_BYTES:
                                                raise ProviderError(SOCIAL_CRAWL, "failed", "response_too_large")
                                            chunks.append(chunk)
                                        value = json.loads(b"".join(chunks))
                                        if not isinstance(value, dict):
                                            raise ValueError("not an object")
                                        return value
                            except httpx.TransportError:
                                if attempt >= len(delays):
                                    raise
                                wait = delays[attempt]
                            await asyncio.sleep(wait)

                    snapshot = await request("POST", CRAWL_PATH, payload=body, idempotency_key=uuid4().hex)
                    job_id = snapshot.get("job_id")
                    if not isinstance(job_id, str) or not re.fullmatch(r"[a-fA-F0-9]{32}", job_id):
                        raise ProviderError(SOCIAL_CRAWL, "failed", "invalid_job")
                    while True:
                        if snapshot.get("job_id") != job_id or snapshot.get("query", query) != query or snapshot.get("platforms", [platform]) != [platform]:
                            raise ProviderError(SOCIAL_CRAWL, "failed", "job_identity_mismatch")
                        state = snapshot.get("job_status")
                        if state in ("done", "partial", "failed"):
                            break
                        if state not in ("waiting", "queued", "running"):
                            raise ProviderError(SOCIAL_CRAWL, "failed", "invalid_job_status")
                        await asyncio.sleep(self._poll_interval_s)
                        snapshot = await request("GET", f"{CRAWL_PATH}/{job_id}")
                    answer = snapshot.get("result")
                    # A job of one platform may answer as the platform's own result or inside the multi-platform envelope
                    # (`results`, with `progress` and `errors` by platform), as the platform's client reads both.
                    progress, platform_errored = [], False
                    if isinstance(answer, dict) and isinstance(answer.get("results"), dict):
                        envelope = answer
                        if (envelope.get("job_id", job_id) != job_id or envelope.get("query", query) != query
                                or any(name != platform for name in envelope["results"])):
                            raise ProviderError(SOCIAL_CRAWL, "failed", "invalid_result")
                        answer = envelope["results"].get(platform)
                        if not isinstance(answer, dict):
                            raise ProviderError(SOCIAL_CRAWL, "failed", "missing_platform")
                        answer = {**answer, "platform": answer.get("platform", platform)}
                        for source in (envelope.get("progress"), snapshot.get("progress")):
                            entry = source.get(platform) if isinstance(source, dict) else None
                            if isinstance(entry, dict):
                                progress.append(entry)
                        errors = envelope.get("errors")
                        platform_errored = isinstance(errors, dict) and platform in errors
                    if not isinstance(answer, dict) or answer.get("platform") != platform or answer.get("question", query) != query:
                        raise ProviderError(SOCIAL_CRAWL, "failed", "invalid_result")
                    meta = answer.get("meta") if isinstance(answer.get("meta"), dict) else {}
                    status = meta.get("collection_status")
                    posts = answer.get("posts") if isinstance(answer.get("posts"), list) else []
                    # What went wrong (errored) is not what is short (unmet): `requirements_met: false` is a platform that had fewer
                    # posts than the five asked for, which is what a quiet term on a quiet platform looks like.
                    evidence = (snapshot, answer, meta, *progress)
                    unmet = any(item.get("requirements_met") is False for item in evidence)
                    errored = (state != "done" or status in ("partial_collected", "failed") or platform_errored
                               or any(item.get("has_errors") is True for item in evidence)
                               or any(item.get("status") in ("error", "partial") for item in progress)
                               or bool(meta.get("error_details_total")))
                    stages = [meta.get("detail"), meta.get("comments")]
                    stages.extend((meta.get("stage_completeness") or {}).values() if isinstance(meta.get("stage_completeness"), dict) else [])
                    errored = errored or any(
                        isinstance(stage, dict) and stage.get("enabled") is not False
                        and (stage.get("complete") is False or stage.get("status") in ("failed", "partial")
                             or isinstance(stage.get("failed"), (int, float)) and stage["failed"] > 0) for stage in stages)
                    if status not in ("collected", "no_results", "partial_collected", "failed") or (errored and not posts):
                        raise ProviderError(SOCIAL_CRAWL, "failed", "collection_incomplete")
                    # Usable posts that are not the whole of what was asked for are kept and said to be partial; no posts and nothing
                    # wrong is an empty read.
                    incomplete = errored or (unmet and bool(posts))
                    # The posts still carry their raw provider answer: the collector reads a post's picture addresses out of it
                    # and drops it; build_entry keeps only the public text and stated counts.
                    answer = {"platform": platform, "posts": posts, "meta": {"collection_status": "partial_collected" if incomplete else status}}
                    outcome, detail, objects = ("failed" if incomplete else "ok"), ("collection_incomplete" if incomplete else ""), len(posts)
                    return answer
        except ProviderError as error:
            outcome, detail = _ledger_outcome(error.kind), error.detail
            raise
        except (httpx.HTTPError, OSError, ValueError, TimeoutError) as error:
            detail = "accepted_result_unavailable" if accepted else "timeout" if isinstance(error, (TimeoutError, httpx.TimeoutException)) else "invalid_response"
            raise ProviderError(SOCIAL_CRAWL, "failed", detail) from None
        finally:
            await self._ledger.record(SOCIAL_CRAWL, purpose="crawl", outcome=outcome, objects=objects, amount=1, error=detail or None)

    async def retained(self, *, page: int = 100, most: int = 2000, on_job=None) -> dict:
        """The crawler's retained jobs, read and not asked for: ``GET /api/jobs?limit&offset`` page by page, then each job's
        snapshot, newest listing first as the crawler orders it. It starts no crawl and is no crawl request (the day's cap and the
        ledger are untouched); the crawler serves one request at a time, so a busy answer (429/503) is waited out for the time it
        names (at most ``CRAWL_MAX_RETRY_AFTER_S``, three times) and a job that still cannot be read is counted, not retried.
        ``on_job(snapshot)`` is called with each readable snapshot; returns ``{"listed", "read", "unreadable"}`` (and ``"stopped"`` when a later page of the listing could not be read)."""
        origin = self._endpoint()
        self._headers()
        counts: dict = {"listed": 0, "read": 0, "unreadable": 0}
        seen: set[str] = set()

        async with httpx.AsyncClient(transport=self._transport, timeout=self._settings.social_crawl_timeout_s,
                                     follow_redirects=False) as client:
            async def get(path: str):
                for attempt in range(4):
                    async with client.stream("GET", origin + path, headers=self._headers()) as response:
                        if response.status_code in (429, 503) and attempt < 3:
                            wait = _retry_after_s(response.headers, 2.0 * (attempt + 1))
                        elif response.status_code != 200:
                            raise ProviderError(SOCIAL_CRAWL, "failed", f"http_{response.status_code}")
                        else:
                            chunks, size = [], 0
                            async for chunk in response.aiter_bytes():
                                size += len(chunk)
                                if size > CRAWL_MAX_BYTES:
                                    raise ProviderError(SOCIAL_CRAWL, "failed", "response_too_large")
                                chunks.append(chunk)
                            return json.loads(b"".join(chunks))
                    await asyncio.sleep(wait)

            offset = 0
            while counts["listed"] < most:
                try:
                    listing = await get(f"{CRAWL_PATH}?{urlencode({'limit': page, 'offset': offset})}")
                except (ProviderError, httpx.HTTPError, ValueError, OSError) as error:
                    if offset == 0:
                        raise ProviderError(SOCIAL_CRAWL, "failed", "jobs_unlistable") from error
                    counts["stopped"] = "list_failed"
                    break
                found = job_ids(listing)
                offset += len(found)
                ids = [job for job in found if job not in seen]
                if not ids:
                    break               # past the last page (or a crawler that ignores the offset)
                seen.update(ids)
                counts["listed"] += len(ids)
                for job_id in ids:
                    try:
                        snapshot = await get(f"{CRAWL_PATH}/{job_id}")
                    except (ProviderError, httpx.HTTPError, ValueError, OSError):
                        counts["unreadable"] += 1
                        continue
                    if not isinstance(snapshot, dict):
                        counts["unreadable"] += 1
                        continue
                    counts["read"] += 1
                    if on_job is not None:
                        await on_job(snapshot)
        return counts


def job_ids(listing) -> list[str]:
    """The job ids of one page of ``GET /api/jobs``: the answer is a list, or an object holding one (``jobs``, ``items``,
    ``results``, ``data``); an entry is an id or an object with ``job_id``. Anything else is no id."""
    items = listing
    if isinstance(listing, dict):
        items = next((listing[key] for key in ("jobs", "items", "results", "data") if isinstance(listing.get(key), list)), [])
    ids = []
    for item in items if isinstance(items, list) else []:
        value = item.get("job_id") if isinstance(item, dict) else item
        if isinstance(value, str) and re.fullmatch(r"[a-fA-F0-9]{32}", value):
            ids.append(value)
    return ids


def snapshot_posts(snapshot) -> list[tuple[str, dict]]:
    """``(crawler platform, post)`` of every post a retained job's snapshot holds: its ``result`` is one platform's answer, or the
    multi-platform envelope (``results``) the live read also accepts. Jobs without a result (waiting, failed) hold none."""
    result = snapshot.get("result") if isinstance(snapshot, dict) else None
    if not isinstance(result, dict):
        return []
    if isinstance(result.get("results"), dict):
        answers = list(result["results"].items())
    else:
        named = snapshot.get("platforms") if isinstance(snapshot.get("platforms"), list) else []
        answers = [(result.get("platform") or (named[0] if len(named) == 1 else None), result)]
    out = []
    for platform, answer in answers:
        posts = answer.get("posts") if isinstance(answer, dict) and isinstance(answer.get("posts"), list) else []
        out.extend((platform, post) for post in posts if isinstance(platform, str) and isinstance(post, dict))
    return out


def _int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _float(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and number >= 0 else None


def _text(value) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None

