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
- Dajiala: what the answer's ``cost_money`` says (``post_history`` ¥0.14 by id or link, ``article_detail`` ¥0.03), with
  ``remain_money`` recorded as the balance. Codes (its documentation, 2026): 0 ok; -1 rate limited (5 a second); 20001
  balance; 10002 key or code wrong; 101/104 the account or article is gone (charged); 105/20003/30001/400 the request
  was wrong (free); 2003/2005/50000 the provider failed, try later. 20002 is documented as a wrong request but behaves as
  one that passes: on 2026-10-22 production had 88 of 300 ``article_detail`` calls answer it, all between 16:21 and 17:29
  Beijing while the balance ran down, and the same links read fine after the top-up — so it is ``failed`` (try later),
  and what bounds the retries is the caller's (``collector``: six calls per entry's text, a pause after five in a row).
- The crawler: one request, counted against the day's request cap; 429/503 means GEO is using it.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx

from ..model import FetchError, RequestSpec
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
DAJIALA_GONE = (101, 104)
DAJIALA_RETRY = (2003, 2005, 20002, 50000)    # 20002: module docstring
CRAWL_PATH = "/api/crawl"
CRAWL_MAX_BYTES = 8 * 1024 * 1024


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

    async def search(self, query: str, cursor: str | None = None) -> tuple[list[dict], str | None]:
        """One page of a newest-first search: ``(tweets, next cursor)``."""
        params = {"query": query, "type": "Latest"}
        if cursor:
            params["cursor"] = cursor
        body = await self._get("/twitter/search?" + urlencode(params), purpose="search",
                               most_objects=SEARCH_PAGE_OBJECTS, count=lambda b: len(b.get("tweets") or []))
        if body is None:
            return [], None
        tweets = [t for t in body.get("tweets") or [] if isinstance(t, dict)]
        following = body.get("next_cursor")
        return tweets, following if isinstance(following, str) and following else None

    async def user(self, handle: str) -> dict | None:
        """The account behind a handle, or ``None`` when there is none."""
        return await self._get("/twitter/user/" + handle, purpose="user", most_objects=1, count=lambda b: 1)

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

    async def post_history(self, *, ghid: str | None = None, url: str | None = None) -> History:
        """An account's latest posts, by its original id or by the link of any of its articles (one call, ¥0.14)."""
        payload = {"ghid": ghid} if ghid else {"url": url}
        spec = RequestSpec(url=f"{DAJIALA_BASE}/fbmain/monitor/v3/post_history", method="POST",
                           body=json.dumps({**payload, "verifycode": ""}).encode("utf-8"),
                           headers={"Content-Type": "application/json", "Accept": "application/json"},
                           conditional=False, api=True)
        body = await self._call(spec, purpose="post_history", most=POST_HISTORY_CNY)
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
    """``POST {url}/api/crawl`` — the same request shape as the platform's ``socialCrawlClient.mjs``."""

    def __init__(self, ledger: ProviderLedger, settings, clock, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._ledger = ledger
        self._settings = settings
        self._clock = clock
        self._transport = transport
        self.calls = 0

    @property
    def configured(self) -> bool:
        return bool(self._settings.social_crawl_url)

    @property
    def cap(self) -> Cap:
        return Cap(SOCIAL_CRAWL, float(self._settings.social_crawl_daily))

    async def crawl(self, query: str, platform: str, *, detail_posts: int = 5) -> dict:
        """One platform's latest posts for one query. Raises ``ProviderError`` (``rate-limited`` on 429/503: GEO is busy)."""
        await self._ledger.check(self.cap, 1)
        self.calls += 1
        body = {"query": query, "platform": platform, "sort_type": "latest", "page": 1, "minimum_detail_posts": detail_posts,
                "minimum_comments_per_post": 0, "include_provider_raw": False}
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=self._settings.social_crawl_timeout_s,
                                         follow_redirects=False) as client:
                async with client.stream("POST", self._settings.social_crawl_url + CRAWL_PATH, json=body,
                                         headers={"Accept": "application/json"}) as response:
                    if response.status_code in (429, 503):
                        await self._ledger.record(SOCIAL_CRAWL, purpose="crawl", outcome="rate-limited", amount=1,
                                                  error=f"http_{response.status_code}")
                        raise ProviderError(SOCIAL_CRAWL, "rate-limited", f"http_{response.status_code}")
                    if response.status_code != 200:
                        await self._ledger.record(SOCIAL_CRAWL, purpose="crawl", outcome="failed", amount=1,
                                                  error=f"http_{response.status_code}")
                        raise ProviderError(SOCIAL_CRAWL, "failed", f"http_{response.status_code}")
                    chunks, size = [], 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > CRAWL_MAX_BYTES:
                            raise ProviderError(SOCIAL_CRAWL, "failed", "response_too_large")
                        chunks.append(chunk)
        except ProviderError:
            raise
        except (httpx.HTTPError, OSError) as error:
            await self._ledger.record(SOCIAL_CRAWL, purpose="crawl", outcome="failed", amount=1,
                                      error="timeout" if isinstance(error, httpx.TimeoutException) else type(error).__name__)
            raise ProviderError(SOCIAL_CRAWL, "failed", type(error).__name__) from None
        try:
            answer = json.loads(b"".join(chunks))
        except ValueError:
            await self._ledger.record(SOCIAL_CRAWL, purpose="crawl", outcome="failed", amount=1, error="invalid_json")
            raise ProviderError(SOCIAL_CRAWL, "failed", "invalid_json") from None
        if not isinstance(answer, dict):
            await self._ledger.record(SOCIAL_CRAWL, purpose="crawl", outcome="failed", amount=1, error="invalid_json")
            raise ProviderError(SOCIAL_CRAWL, "failed", "invalid_json")
        posts = answer.get("posts") if isinstance(answer.get("posts"), list) else []
        await self._ledger.record(SOCIAL_CRAWL, purpose="crawl", outcome="ok", objects=len(posts), amount=1)
        return answer


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

