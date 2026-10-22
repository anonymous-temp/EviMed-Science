"""X accounts through SocialData (contract 1.5.0, channel ``x``).

Shapes and rules after AIHOT's ``sources/x.ts`` and ``providers/socialdata.ts`` (MIT, engine at 47531fa), adapted:

- **Shards.** Accounts are packed into searches ``(from:a OR from:b …) -filter:replies``, at most 24 handles and 470
  characters (SocialData refuses queries over 512; the ``since_id:`` bound takes about 30 more), per pace, in a stable
  order by source id, so a shard's accounts stay together between runs and an account added or removed shifts only the
  shards after it. A shard is read when any of its accounts is due, all of them at once.
- **Pace.** ``editorial`` accounts (regulators, journals, news desks) every 30 minutes, ``signal`` accounts (people,
  smaller organisations) every 60.
- **Watermarks.** Each account keeps the id of its own newest post it has read. The search is bounded below by the
  oldest of its accounts' coverage, so no account misses a post; afterwards each account's watermark moves to its own
  newest post the search saw — another account's newer post would hide this one's late posts. An account read
  successfully is covered up to ten minutes before that read, even when it posted nothing (a quiet account's newest post
  can be months old, and bounding a shard by it would re-read months of the others). A new account starts from the last
  24 hours, so it can share a shard at once.
- **Pages.** A run reads at most ten pages newer than the bound; a longer stretch (an outage) is kept as a backlog
  ``(query, cursor)`` in every member's cursor and read on in later runs, oldest first, at most five pages a run and five
  stretches kept; a stretch the provider refuses to continue is given up and counted.
- **Posts.** Retweets are left out (the original is someone else's post); replies are filtered by the query; a quote's
  quoted post is carried as ``quoted``. A post that links an X Article (``x.com/i/article/<id>``) has the article fetched
  (one object) and its text is the body. ``t.co`` links are expanded and the trailing media link dropped. Photos and
  video posters are stored by the media store; the platform's own counts are ``metrics``.

The cost is ``objects × US$0.0002`` (the ledger): a search page is at most 20 objects, an article one.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from ..adapters.common import registry_ids
from ..model import NormalizedEntry
from .providers import ProviderError
from .spend import SpendCapReached

SHARD_MAX_ACCOUNTS = 24
SHARD_QUERY_MAX = 470
MAX_PAGES = 10
MAX_BACKLOG_PAGES = 5
MAX_BACKLOG = 5
FIRST_LOOKBACK = timedelta(hours=24)
COVERAGE_SLACK = timedelta(minutes=10)
PACE_MINUTES = {"editorial": 30, "signal": 60}
X_EPOCH_MS = 1288834974657            # X ids begin with their millisecond timestamp since 2010-11-04
TITLE_MAX = 140
_HANDLE = re.compile(r"^[A-Za-z0-9_]{1,15}$")
_X_ARTICLE = re.compile(r"https?://(?:www\.)?(?:x|twitter)\.com/i/article/\d+", re.I)
_TRAILING_TCO = re.compile(r"\s*https://t\.co/\w+\s*$")
_ENTITIES = {"&amp;": "&", "&lt;": "<", "&gt;": ">"}
_NOT_LANGUAGES = {"und", "qme", "zxx", "qht", "qam", "qct", "qst", "art"}


def x_id_at(when: datetime) -> int:
    """The smallest id of a post made at ``when``."""
    ms = int(when.timestamp() * 1000)
    return max(0, ms - X_EPOCH_MS) << 22


def pace(row: dict) -> timedelta:
    return timedelta(minutes=PACE_MINUTES.get((row.get("config") or {}).get("mode"), 60))


def handle_of(row: dict) -> str | None:
    handle = str((row.get("config") or {}).get("handle") or "").lstrip("@")
    return handle if _HANDLE.match(handle) else None


def shard_query(handles: list[str]) -> str:
    return "(" + " OR ".join(f"from:{h}" for h in handles) + ") -filter:replies"


@dataclass
class Shard:
    mode: str
    members: list[dict]
    key: str = ""
    query: str = ""


def plan_shards(rows: list[dict]) -> list[Shard]:
    """The accounts packed into searches (module docstring); a row without a usable handle is left out."""
    by_mode: dict[str, list[dict]] = {}
    for row in rows:
        if handle_of(row):
            by_mode.setdefault((row.get("config") or {}).get("mode") or "signal", []).append(row)
    shards: list[Shard] = []
    for mode in sorted(by_mode):
        current: list[dict] = []

        def close() -> None:
            if current:
                ids = ",".join(row["id"] for row in current)
                shards.append(Shard(mode=mode, members=list(current), key=f"{mode}:{hashlib.sha256(ids.encode()).hexdigest()[:12]}",
                                    query=shard_query([handle_of(row) for row in current])))
                current.clear()

        for row in sorted(by_mode[mode], key=lambda r: r["id"]):
            candidate = [handle_of(r) for r in current] + [handle_of(row)]
            if len(current) >= SHARD_MAX_ACCOUNTS or len(shard_query(candidate)) > SHARD_QUERY_MAX:
                close()
            current.append(row)
        close()
    return shards


def covered_to(row: dict, now: datetime) -> int:
    """How far an account's posts are known to be read (module docstring)."""
    cursor = row.get("cursor") or {}
    own = int(cursor.get("last_tweet_id") or 0)
    checked = cursor.get("last_ok_at")
    try:
        by_time = x_id_at(datetime.fromisoformat(checked) - COVERAGE_SLACK) if checked else 0
    except (TypeError, ValueError):
        by_time = 0
    covered = max(own, by_time)
    return covered or x_id_at(now - FIRST_LOOKBACK)


@dataclass
class SearchRead:
    tweets: list[dict]
    pages: int = 0
    backlog_pages: int = 0
    truncated: bool = False
    dropped: int = 0
    backlog: list[dict] = field(default_factory=list)


async def read_search(client, base: str, since: int, backlog: list[dict]) -> SearchRead:
    """New posts above ``since``, then older stretches left from earlier runs (module docstring). A first page that fails
    raises; a later one keeps what was read and leaves the rest as a stretch."""
    backlog = [dict(item) for item in backlog if isinstance(item, dict) and item.get("query") and item.get("next")]
    query = f"{base} since_id:{since}"
    found: list[dict] = []
    read = SearchRead(tweets=[])
    cursor: str | None = None
    while True:
        try:
            tweets, following = await client.search(query, cursor)
        except (ProviderError, SpendCapReached):
            if cursor is None:
                raise
            read.truncated = True
            backlog.append({"query": query, "next": cursor})
            break
        read.pages += 1
        found.extend(tweets)
        if not following or not tweets:
            break
        if read.pages >= MAX_PAGES:
            read.truncated = True
            backlog.append({"query": query, "next": following})
            break
        cursor = following
    while len(backlog) > MAX_BACKLOG:
        backlog.pop(0)
        read.dropped += 1
    while backlog and read.backlog_pages < MAX_BACKLOG_PAGES:
        stretch = backlog[0]
        try:
            tweets, following = await client.search(stretch["query"], stretch["next"])
        except SpendCapReached:
            break
        except ProviderError as error:
            if error.kind == "bad-request" or error.detail in ("http_400", "http_422"):
                backlog.pop(0)
                read.dropped += 1
                continue
            break
        read.backlog_pages += 1
        found.extend(tweets)
        if not following or not tweets:
            backlog.pop(0)
        else:
            stretch["next"] = following
    seen: set[str] = set()
    for tweet in found:
        tweet_id = str(tweet.get("id_str") or "")
        if not tweet_id.isdigit() or tweet_id in seen or tweet.get("retweeted_status"):
            continue
        seen.add(tweet_id)
        read.tweets.append(tweet)
    read.backlog = backlog
    return read


def written_by(tweet: dict, row: dict) -> bool:
    user = tweet.get("user") or {}
    config = row.get("config") or {}
    if config.get("user_id") and str(user.get("id_str") or "") == str(config["user_id"]):
        return True
    return str(user.get("screen_name") or "").lower() == (handle_of(row) or "").lower()


def tweet_text(tweet: dict) -> str:
    """The post's text: the three entities SocialData escapes decoded, ``t.co`` links expanded, the media link dropped."""
    text = re.sub(r"&(?:amp|lt|gt);", lambda m: _ENTITIES[m.group(0)], str(tweet.get("full_text") or tweet.get("text") or ""))
    entities = tweet.get("entities") or {}
    for link in entities.get("urls") or []:
        if isinstance(link, dict) and link.get("url") and link.get("expanded_url"):
            text = text.replace(link["url"], link["expanded_url"])
    if (tweet.get("extended_entities") or {}).get("media") or entities.get("media"):
        text = _TRAILING_TCO.sub("", text)
    return text.strip()


def tweet_media(tweet: dict) -> list[dict]:
    """``[{url, kind, alt, width, height}]`` of a post's photos and video posters, at most four."""
    out = []
    for item in ((tweet.get("extended_entities") or {}).get("media") or (tweet.get("entities") or {}).get("media") or [])[:4]:
        if not isinstance(item, dict) or not str(item.get("media_url_https") or "").startswith("https://"):
            continue
        info = item.get("original_info") or {}
        out.append({"url": item["media_url_https"], "kind": "image" if item.get("type") == "photo" else "video-poster",
                    "alt": item.get("ext_alt_text") if isinstance(item.get("ext_alt_text"), str) else None,
                    "width": info.get("width"), "height": info.get("height")})
    return out


def links_article(text: str) -> bool:
    return bool(_X_ARTICLE.search(text or ""))


def article_text(article: dict) -> tuple[str, str] | None:
    """``(title, text)`` of an X Article: its DraftJS blocks as paragraphs, media blocks left out."""
    lines = []
    for block in (article.get("content_state") or {}).get("blocks") or []:
        text = str((block or {}).get("text") or "").strip()
        if text and (block or {}).get("type") != "atomic":
            lines.append(text)
    text = "\n\n".join(lines).strip()
    return (str(article.get("title") or "").strip(), text) if text else None


def language(tweet: dict) -> str:
    lang = str(tweet.get("lang") or "").strip().lower()
    return lang if re.fullmatch(r"[a-z]{2,3}", lang) and lang not in _NOT_LANGUAGES else "und"


def title_of(text: str) -> str:
    first = next((line.strip() for line in text.splitlines() if line.strip()), text.strip())
    return first if len(first) <= TITLE_MAX else first[: TITLE_MAX - 1].rstrip() + "…"


def published(tweet: dict) -> datetime | None:
    value = tweet.get("tweet_created_at") or tweet.get("created_at")
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = datetime.strptime(value, "%a %b %d %H:%M:%S %z %Y")
        except ValueError:
            return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def post_url(tweet: dict) -> str:
    return f"https://x.com/{(tweet.get('user') or {}).get('screen_name')}/status/{tweet.get('id_str')}"


def metrics_of(tweet: dict, now: datetime) -> dict:
    return {"likes": tweet.get("favorite_count"), "reposts": tweet.get("retweet_count"),
            "replies": tweet.get("reply_count"), "views": tweet.get("views_count"), "observed_at": now}


def build_entry(tweet: dict, row: dict, *, now: datetime, media: list[dict], quoted_media: list[dict],
                article: tuple[str, str] | None) -> NormalizedEntry:
    """A post as an entry. ``media`` / ``quoted_media`` are the stored items (contract ``MediaItem``)."""
    text = tweet_text(tweet)
    user = tweet.get("user") or {}
    handle = str(user.get("screen_name") or handle_of(row) or "")
    config = row.get("config") or {}
    title = title_of(text) if text else ""
    body = text
    if article:
        article_title, article_body = article
        if article_title and len(_X_ARTICLE.sub("", text).strip()) < 30:
            title = title_of(article_title)
        body = "\n\n".join(part for part in (article_title, article_body) if part)
    quoted = None
    original = tweet.get("quoted_status")
    if isinstance(original, dict) and original.get("id_str"):
        quoted_user = original.get("user") or {}
        quoted = {"author": {"name": quoted_user.get("name") or quoted_user.get("screen_name"),
                             "handle": quoted_user.get("screen_name")},
                  "text": tweet_text(original), "url": post_url(original), "lang": language(original),
                  "media": quoted_media}
    return NormalizedEntry(
        external_key=str(tweet["id_str"]), url=post_url(tweet), title=title or f"@{handle}", summary=text or None,
        published_at=published(tweet), date_precision="instant", language=language(tweet),
        registry_ids=registry_ids(text, quoted["text"] if quoted else None),
        channel="x", platform="x",
        author={"name": user.get("name") or handle, "handle": handle, "url": f"https://x.com/{handle}",
                "role": config.get("role")},
        media=media, quoted=quoted, metrics=metrics_of(tweet, now), body_text=body or None, body_from="x",
    )
