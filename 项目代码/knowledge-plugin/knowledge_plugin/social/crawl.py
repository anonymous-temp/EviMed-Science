"""Six Chinese platforms through the GEO module's crawler, for monitoring (contract 1.5.0, channel ``social``).

``POST {KNOWLEDGE_PLUGIN_SOCIAL_CRAWL_URL}/api/jobs`` and fixed-path job polling with the request the platform's ``socialCrawlClient.mjs`` sends:
``platforms: [one name]``, newest first, five detailed posts, collect_comments=false, and the provider's raw answer (read for the
addresses of a post's pictures and discarded, see below). What is read:

- **A standing watch list** (``watch_list`` in ``registry/social-sources.json``): about forty medical topics and drug
  classes the public talks about and the feed covers, each with the reason it is there. Every (term, platform) pair is
  searched in turn, the one searched longest ago first.
- **No hot list.** The platform publishes none outside a signed-in session, and the plugin never calls the platform
  (contract rule 6), so the watch list is all there is.
- **Pacing.** ``KNOWLEDGE_PLUGIN_SOCIAL_CRAWL_DAILY`` requests a day (120), spread evenly (one every twelve minutes),
  one at a time. The crawler is the GEO module's and serves one request at a time: a busy answer (429/503) is GEO's, and
  the monitor waits at least ten minutes before it asks again — never a retry inside those ten minutes. (An accepted
  job's *poll* that meets a busy answer or a dropped connection is asked again at once, twice at most, inside the one
  deadline: the job is running there and must not be lost to one blip; the crawl is never submitted again.)
- **Partial is a read.** A platform that kept posts but is short of what was asked (a failed comments stage, fewer posts than
  the five asked for) is recorded as a read that worked, with ``partial`` in its detail; its failure streak does not grow.
  A read with nothing usable and something wrong is a failure of that platform; a read with nothing and nothing wrong is
  empty.
- **One failing platform never holds the other five.** A request that failed for a reason of its own (an HTTP 500, a
  timeout, an answer that is not JSON) records the attempt for that term × platform and parks that platform for a few
  hours (``park_for``: three hours, doubled by every failure in a row, at most twelve), so the round robin moves on to the
  platforms it has not asked yet; a parked platform comes back by itself when its time is up, and its first success clears
  the record. A platform that keeps failing reads ``degraded`` and then ``unreadable`` as a source, like any other.
- **What is kept of a post.** Its address, its title or first line, an excerpt of at most 300 characters (the ``summary``),
  the post's **whole own text** (``body_text``: what the platform answered as the post's ``content``, as paragraphs, at most
  ``BODY_MAX`` characters; the title is not put in front of it, and a ``content`` that only repeats the title is no text),
  its pictures and the counts the platform states (likes, shares, the comment count when stated — never the length of a comment
  sample). The pictures are read out of the provider's raw answer by ``pictures_of`` (a picture note's pictures in order, a
  video's one poster), stored by the media store like an X post's, and the raw answer is dropped there: it holds the author
  and the account's other data, and it reaches no store, no log and no entry. Never the author: a post on these platforms is
  a member of the public's, and personal data does not pass the adapter (contract rule 4). Comments are not asked for. A post
  the crawler returns without an address (only the first detailed ones carry one) is left out. A post with a title and no
  ``content`` is still an entry — with no text, which the platform sees as such.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from ..model import MEDIA_MAX, URL_MAX, NormalizedEntry
from ..normalize import clean_body

PLATFORMS = {"xhs": "xiaohongshu", "douyin": "douyin", "zhihu": "zhihu", "weibo": "weibo", "bilibili": "bilibili",
             "wechat_channels": "channels"}
EXCERPT_MAX = 300
TITLE_MAX = 100
# The longest post text kept. The platforms' posts run to a few thousand characters (Weibo's long text, a Zhihu answer): this is
# the bound of a stored excerpt too (``BODY_EXCERPT_MAX``), so the excerpt of a full text is the text itself, and several times
# what the longest answer in the crawler's retained jobs (2026-10-27..31) needed; a longer one is an article, not a post, and is
# cut at a paragraph with an ellipsis.
BODY_MAX = 20_000
# A post's pictures kept: the contract's ``Entry.media`` bound (``MEDIA_MAX``, 8) — a picture note has up to 18, its first eight
# are the note.
PICTURES_MAX = MEDIA_MAX
BUSY_WAIT = timedelta(minutes=10)
PARK_BASE = timedelta(hours=3)
PARK_MAX = timedelta(hours=12)
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


def park_for(failures: int) -> timedelta:
    """How long a platform that failed ``failures`` times in a row is left alone: three hours, doubled each time, at most twelve."""
    return min(PARK_MAX, PARK_BASE * 2 ** max(0, min(failures, 8) - 1))


def parked_until(parked: dict | None, platform: str, now: datetime) -> datetime | None:
    """When a parked platform may be asked again, or ``None`` when it is not parked (a record past its time is not a park)."""
    record = (parked or {}).get(platform)
    try:
        until = datetime.fromisoformat(record["until"]) if isinstance(record, dict) else None
    except (KeyError, TypeError, ValueError):
        return None
    return until if until is not None and until > now else None


def next_pair(terms: list[str], platforms: list[str], last: dict[str, str], *, parked: dict | None = None,
              now: datetime | None = None) -> tuple[str, str] | None:
    """The (term, crawler platform) asked longest ago; never asked comes first, in list order. A platform parked at ``now``
    (``parked``: platform → ``{"until": iso, …}``) is passed over; with every platform parked there is no pair."""
    if parked and now is not None:
        platforms = [platform for platform in platforms if parked_until(parked, platform, now) is None]
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


def whole_text(post: dict) -> str | None:
    """The post's whole own text: its ``content`` as paragraphs (``clean_body``: whitespace only — markers such as XHS's
    ``[话题]`` and its tab-only lines are the platform's to read), at most ``BODY_MAX`` characters. A ``content`` that only
    repeats the title is not a text: the title is the entry's own field, and a text of the same words would be read twice."""
    content = post.get("content") if isinstance(post.get("content"), str) else ""
    body = clean_body(content, BODY_MAX)
    if body is None:
        return None
    title = post.get("title") if isinstance(post.get("title"), str) else ""
    return None if " ".join(title.split()) == " ".join(body.split()) else body


def build_entry(post: dict, crawler_platform: str, *, now: datetime, media: list[dict] | None = None) -> NormalizedEntry | None:
    """One post as an entry, minimised (module docstring); ``None`` without an address or any text. ``media`` are the stored
    pictures (contract ``MediaItem``, ``MediaStore.ensure``); the entry is the same without them."""
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
    body = whole_text(post)
    return NormalizedEntry(
        external_key=str(key)[:512], url=url, title=title, summary=excerpt, published_at=_time(post), date_precision="instant",
        language="zh", channel="social", platform=PLATFORMS.get(crawler_platform), metrics=metrics, media=list(media or []),
        body_text=body, body_from="social" if body else None, body_kind="full",
    )


# ------------------------------------------------------------------------------------ pictures
#
# The provider's raw answer (``posts[].raw_response``, asked with ``include_provider_raw``) is read here for the addresses of a
# post's pictures, one small function per platform, and goes no further. Every step tolerates a missing or differently-typed
# key (a platform changing its answer costs that platform's pictures, never the post). The shapes are the crawler's retained
# answers (2026-10-27..31, values masked): XHS ``detail.data.data[0].note_list[0]`` and ``search.note`` (``images_list``,
# ``type`` normal/video), Douyin ``detail.data.aweme_detail`` / ``search`` (``video.cover``, ``images``), Bilibili
# ``detail.data.data.View.pic`` / ``search.av.cover``, Channels ``detail.data.cover_img_url`` / ``search.image``, Weibo
# ``detail.data.pic_infos`` / ``pic_ids``.

# What the media store decodes (``media._FORMATS``): an address of another format is chosen only when it is the only one.
_UNDECODED = (".heic", ".heif", ".avif")


def _dig(value, *path):
    """``value`` followed down ``path`` (dict keys, list indexes); ``None`` at the first step that is not there."""
    for step in path:
        if isinstance(step, int):
            if not isinstance(value, list) or not -len(value) <= step < len(value):
                return None
            value = value[step]
        else:
            if not isinstance(value, dict):
                return None
            value = value.get(step)
    return value


def _link(value) -> str | None:
    """An https address from an address, a ``{url}`` object or a ``url_list``'s first usable member; ``//host`` and ``http://`` are
    taken as https (the platforms' image hosts serve it), anything else is nothing."""
    if isinstance(value, dict):
        value = value.get("url") if isinstance(value.get("url"), str) else value.get("url_list")
    if isinstance(value, list):
        usable = [link for link in (_link(item) for item in value) if link]
        return next((link for link in usable if not urlsplit(link).path.lower().endswith(_UNDECODED)), usable[0] if usable else None)
    if not isinstance(value, str):
        return None
    url = value.strip()
    if url.startswith("//"):
        url = "https:" + url
    elif url.startswith("http://"):
        url = "https://" + url[len("http://"):]
    return url if url.startswith("https://") and " " not in url and len(url) <= URL_MAX else None


def _first_link(*values) -> str | None:
    return next((link for link in (_link(value) for value in values) if link), None)


def _xhs_picture(item) -> str | None:
    return _first_link(*(_dig(item, key) for key in ("url_size_large", "original", "url")))


def _xhs(raw: dict) -> list[dict]:
    note = _dig(raw, "detail", "data", "data", 0, "note_list", 0)
    if not isinstance(_dig(note, "images_list"), list):
        note = _dig(raw, "search", "note")
    images = _dig(note, "images_list")
    if not isinstance(images, list):
        return []
    items = [item for item in images if isinstance(item, dict)]
    if all(isinstance(item.get("index"), int) for item in items):
        items.sort(key=lambda item: item["index"])
    links = [link for link in (_xhs_picture(item) for item in items) if link]
    if _dig(note, "type") == "video":
        return [{"url": links[0], "kind": "video-poster"}] if links else []
    return [{"url": link, "kind": "image"} for link in links]


def _weibo(raw: dict) -> list[dict]:
    data = _dig(raw, "detail", "data")
    infos = _dig(data, "pic_infos")
    ids = _dig(data, "pic_ids")
    links: list[str | None] = []
    if isinstance(infos, dict):
        for pid in (ids if isinstance(ids, list) and ids else list(infos)):
            links.append(_first_link(*(_dig(infos, pid, size) for size in ("large", "largest", "original", "mw2000", "bmiddle"))))
    if not any(links):
        parsed = _dig(raw, "search", "_v2_parsed", "media", "images")
        links = [_link(item) for item in parsed] if isinstance(parsed, list) else []
    if any(links):
        return [{"url": link, "kind": "image"} for link in links if link]
    poster = _first_link(_dig(data, "page_info", "page_pic")) if _dig(data, "page_info", "type") == "video" else None
    return [{"url": poster, "kind": "video-poster"}] if poster else []


def _douyin(raw: dict) -> list[dict]:
    for aweme in (_dig(raw, "detail", "data", "aweme_detail"), _dig(raw, "search")):
        album = _dig(aweme, "images")
        if isinstance(album, list) and album:
            return [{"url": link, "kind": "image"} for link in (_link(item) for item in album) if link]
        poster = _first_link(*(_dig(aweme, "video", key) for key in ("cover", "origin_cover", "dynamic_cover")))
        if poster:
            return [{"url": poster, "kind": "video-poster"}]
    return []


def _bilibili(raw: dict) -> list[dict]:
    poster = _first_link(_dig(raw, "detail", "data", "data", "View", "pic"), _dig(raw, "search", "av", "cover"))
    return [{"url": poster, "kind": "video-poster"}] if poster else []


def _channels(raw: dict) -> list[dict]:
    poster = _first_link(_dig(raw, "detail", "data", "cover_img_url"), _dig(raw, "search", "image"),
                         _dig(raw, "detail", "data", "media", "cover_url"))
    return [{"url": poster, "kind": "video-poster"}] if poster else []


_PICTURES = {"xhs": _xhs, "weibo": _weibo, "douyin": _douyin, "bilibili": _bilibili, "wechat_channels": _channels}


def pictures_of(post: dict, crawler_platform: str) -> list[dict]:
    """``[{url, kind}]`` of a post's pictures, at most ``PICTURES_MAX``, in the post's order: the pictures of a picture post
    (``image``) or the poster of a video (``video-poster``, one). Read from the post's raw provider answer only; nothing there is
    kept but these addresses. Zhihu's answers carry theirs in the text, not here."""
    raw = post.get("raw_response") if isinstance(post, dict) else None
    reader = _PICTURES.get(crawler_platform)
    if not isinstance(raw, dict) or reader is None:
        return []
    try:
        found = reader(raw)
    except (TypeError, AttributeError, KeyError, ValueError, RecursionError):
        return []
    out: list[dict] = []
    for item in found:
        if item["url"] not in {seen["url"] for seen in out}:
            out.append(item)
    return out[:PICTURES_MAX]
