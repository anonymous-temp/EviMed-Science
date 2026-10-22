"""Six Chinese platforms through the GEO module's crawler, for monitoring (contract 1.5.0, channel ``social``).

``POST {KNOWLEDGE_PLUGIN_SOCIAL_CRAWL_URL}/api/crawl`` with the request the platform's ``socialCrawlClient.mjs`` sends:
one platform, newest first, five detailed posts, no comments asked for, no provider raw answer. What is read:

- **A standing watch list** (``watch_list`` in ``registry/social-sources.json``): about forty medical topics and drug
  classes the public talks about and the feed covers, each with the reason it is there. Every (term, platform) pair is
  searched in turn, the one searched longest ago first.
- **No hot list.** The platform publishes none outside a signed-in session, and the plugin never calls the platform
  (contract rule 6), so the watch list is all there is.
- **Pacing.** ``KNOWLEDGE_PLUGIN_SOCIAL_CRAWL_DAILY`` requests a day (120), spread evenly (one every twelve minutes),
  one at a time. The crawler is the GEO module's and serves one request at a time: a busy answer (429/503) is GEO's, and
  the monitor waits at least ten minutes before it asks again — never a retry inside those ten minutes.
- **What is kept of a post.** Its address, its title or first line, an excerpt of at most 300 characters and the counts
  the platform states (likes, shares, the comment count when stated — never the length of a comment sample). Never the
  author: a post on these platforms is a member of the public's, and personal data does not pass the adapter (contract
  rule 4). Comments are not asked for. A post the crawler returns without an address (only the first detailed ones
  carry one) is left out.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..model import NormalizedEntry

PLATFORMS = {"xhs": "xiaohongshu", "douyin": "douyin", "zhihu": "zhihu", "weibo": "weibo", "bilibili": "bilibili",
             "wechat_channels": "channels"}
EXCERPT_MAX = 300
TITLE_MAX = 100
BUSY_WAIT = timedelta(minutes=10)
FAILURE_WAIT = timedelta(minutes=30)
STATE_KEY = "social_crawl_state"
_TIME_KEYS = ("publish_time", "create_time", "created_at", "publish_at", "time", "pub_time", "date")


def load_watch_list(path: str) -> list[str]:
    """The watch list's terms, in file order; an unreadable file is an empty list (the monitor then does nothing)."""
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    terms = []
    for item in document.get("watch_list") or [] if isinstance(document, dict) else []:
        term = item.get("term") if isinstance(item, dict) else None
        if isinstance(term, str) and 1 <= len(term.strip()) <= 100 and term.strip() not in terms:
            terms.append(term.strip())
    return terms


def interval(daily: int) -> timedelta:
    return timedelta(seconds=86400 / max(1, daily))


def next_pair(terms: list[str], platforms: list[str], last: dict[str, str]) -> tuple[str, str] | None:
    """The (term, crawler platform) searched longest ago; never searched comes first, in list order."""
    best, best_at = None, None
    for term in terms:
        for platform in platforms:
            at = last.get(f"{term}|{platform}") or ""
            if best is None or at < best_at:
                best, best_at = (term, platform), at
    return best


def _excerpt(*parts) -> str:
    text = " ".join(" ".join(str(part).split()) for part in parts if isinstance(part, str) and part.strip())
    return text if len(text) <= EXCERPT_MAX else text[: EXCERPT_MAX - 1].rstrip() + "…"


def _stated(value) -> int | None:
    if value is None or value == "":
        return None
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def _time(post: dict) -> datetime | None:
    for key in _TIME_KEYS:
        value = post.get(key)
        if isinstance(value, (int, float)) and value > 0:
            seconds = value / 1000 if value > 10**11 else value
            try:
                return datetime.fromtimestamp(seconds, tz=timezone.utc)
            except (OverflowError, OSError, ValueError):
                return None
        if isinstance(value, str) and value.strip():
            try:
                parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00").replace(" ", "T", 1))
            except ValueError:
                continue
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone(timedelta(hours=8)))
    return None


def build_entry(post: dict, crawler_platform: str, *, now: datetime) -> NormalizedEntry | None:
    """One post as an entry, minimised (module docstring); ``None`` without an address or any text."""
    if not isinstance(post, dict):
        return None
    url = post.get("url").strip() if isinstance(post.get("url"), str) else ""
    if not url.startswith(("http://", "https://")):
        return None
    title_raw = post.get("title") if isinstance(post.get("title"), str) else ""
    content = post.get("content") if isinstance(post.get("content"), str) else ""
    excerpt = _excerpt(title_raw, content)
    if not excerpt:
        return None
    first = next((line.strip() for line in (title_raw or content).splitlines() if line.strip()), excerpt)
    title = first if len(first) <= TITLE_MAX else first[: TITLE_MAX - 1].rstrip() + "…"
    post_id = post.get("post_id") if isinstance(post.get("post_id"), (str, int)) else post.get("id")
    key = f"{crawler_platform}:{post_id}" if isinstance(post_id, (str, int)) and str(post_id) else url
    metrics = {"likes": _stated(post.get("likes")), "reposts": _stated(post.get("shares")),
               "replies": _stated(post.get("comment_count", post.get("comments_count"))), "observed_at": now}
    return NormalizedEntry(
        external_key=str(key)[:512], url=url, title=title, summary=excerpt, published_at=_time(post), date_precision="instant",
        language="zh", channel="social", platform=PLATFORMS.get(crawler_platform), metrics=metrics,
        body_text=excerpt, body_from="social", body_kind="excerpt",
    )
