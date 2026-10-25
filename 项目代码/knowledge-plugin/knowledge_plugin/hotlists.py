"""Hot lists: the public boards of what people are reading now (``GET /v1/hot-lists``, contract 1.7.0, c2-leads 2026-10-25).

The platform's hot-event trigger (``apps/server/src/frontierTopics.mjs``) looks at what the public is reading — a war, an
economic decision, a public figure's stated illness, a disaster — for the events that raise a general medical question
readers will want evidence for the same day. This module is the reading, and only that:

- **The boards** (``BOARDS``): Baidu's realtime board (the PC face of its board API, which carries a one-line description
  and a heat score), Toutiao's hot board, Weibo's hot search (its side-panel JSON, asked with a Referer as a browser's page
  asks it; the owner decided on 2026-10-25 to read it directly although its robots.txt refuses generic crawlers), English
  Wikipedia's most-viewed articles of the last full UTC day and Google Trends' US trending searches — the last two through
  the relay egress, which mainland China does not reach directly. Each is a JSON or RSS endpoint (``RequestSpec.api``),
  read through the protected fetch: the host's pacing and budgets, DNS pinning, the redirect rules.
- **What is kept**: per board and round, the ranked entries — rank (pinned and sponsored entries left out, the rest
  numbered from 1), title, heat (the board's own figure; scales differ by board and hour), the board's one-line
  description where it gives one, and the board's own link. Never a post, a comment or anybody's account. A snapshot is
  kept 72 hours (``RETENTION``), long enough for the platform to see an entry stay on a board.
- **A board that fails** is recorded (``hot_list_boards.last_error``, ``Health.hot_lists``) and skipped; the other boards
  are read as usual and the next round tries it again.

The plugin still never calls the platform and makes no model call: which entries are events, and whether one raises a
medical question, is the platform's model's judgement.
"""

from __future__ import annotations

import json
import logging
import re
import xml.etree.ElementTree as ElementTree
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from urllib.parse import quote, urlsplit

from psycopg.types.json import Jsonb

from .model import FetchError, RequestSpec

log = logging.getLogger("knowledge_plugin.hotlists")

RETENTION = timedelta(hours=72)
PER_BOARD = 50                          # entries kept from one board's snapshot
PAGE_MAX = 300                          # snapshots one answer carries at most
TITLE_MAX = 200
DESC_MAX = 300
URL_MAX = 2048
ERROR_MAX = 200
# Wikipedia's pages that are not articles: the main page and the namespaces (a format, not a judgement of the article).
WIKI_NOT_ARTICLES = ("Main_Page",)
WIKI_NAMESPACES = re.compile(r"^(Special|Wikipedia|File|Portal|Help|Template|Category|Talk|User|Draft|Module|MediaWiki|Book|TimedText|WP)(_talk)?:")
GOOGLE_NS = "https://trends.google.com/trending/rss"


@dataclass(frozen=True)
class Board:
    """One board: where it is read, through which exit, with which headers, and how its answer is read."""

    name: str
    egress: str
    headers: dict
    parse: Callable[[bytes], list]
    url: Callable[[datetime], str]


def _text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    clean = re.sub(r"\s+", " ", value).strip()
    return clean[:limit] if clean else None


def _heat(value: Any) -> float | None:
    """A board's heat figure: a number, or the digits of a string like ``"2000+"`` / ``"7808462"``; anything else null."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if value >= 0 else None
    if isinstance(value, str):
        digits = re.sub(r"[,\s+]", "", value)
        if re.fullmatch(r"\d+(\.\d+)?", digits):
            return float(digits)
    return None


def _url(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > URL_MAX:
        return None
    parts = urlsplit(value.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        return None
    return value.strip()


def _entry(rank: int, title: Any, heat: Any = None, desc: Any = None, url: Any = None) -> dict | None:
    clean = _text(title, TITLE_MAX)
    if not clean:
        return None
    return {"rank": rank, "title": clean, "heat": _heat(heat), "desc": _text(desc, DESC_MAX), "url": _url(url)}


def _ranked(rows: list) -> list:
    """The entries kept, renumbered 1..n in board order (pinned and sponsored entries were left out before)."""
    entries = []
    for row in rows:
        made = _entry(len(entries) + 1, *row)
        if made:
            entries.append(made)
        if len(entries) >= PER_BOARD:
            break
    return entries


def parse_baidu(body: bytes) -> list:
    """``top.baidu.com/api/board`` (``platform=pc``: ``desc`` and ``hotScore``; the ``wise`` face nests one level deeper)."""
    data = json.loads(body.decode("utf-8"))
    cards = (data.get("data") or {}).get("cards") or []
    content = cards[0].get("content") if cards and isinstance(cards[0], dict) else None
    if isinstance(content, list) and content and isinstance(content[0], dict) and isinstance(content[0].get("content"), list):
        content = content[0]["content"]
    if not isinstance(content, list):
        raise ValueError("baidu: no board in the answer")
    rows = [(row.get("word") or row.get("query"), row.get("hotScore"), row.get("desc"), row.get("url") or row.get("appUrl"))
            for row in content if isinstance(row, dict) and not row.get("isTop")]
    return _ranked(rows)


def parse_toutiao(body: bytes) -> list:
    """``www.toutiao.com/hot-event/hot-board/``: ``data`` is the board in order; ``fixed_top_data`` (pinned) is left out."""
    data = json.loads(body.decode("utf-8"))
    rows = data.get("data")
    if not isinstance(rows, list):
        raise ValueError("toutiao: no board in the answer")

    def link(row: dict) -> str | None:
        cluster = str(row.get("ClusterIdStr") or row.get("ClusterId") or "")
        return f"https://www.toutiao.com/trending/{cluster}/" if cluster.isdigit() else None

    return _ranked([(row.get("Title"), row.get("HotValue"), None, link(row)) for row in rows if isinstance(row, dict)])


def parse_weibo(body: bytes) -> list:
    """``weibo.com/ajax/side/hotSearch``: ``data.realtime`` in order; a sponsored entry (``is_ad``) is left out."""
    data = json.loads(body.decode("utf-8"))
    rows = (data.get("data") or {}).get("realtime")
    if data.get("ok") != 1 or not isinstance(rows, list):
        raise ValueError("weibo: no board in the answer")

    def link(word: Any) -> str | None:
        return f"https://s.weibo.com/weibo?q={quote('#' + word + '#')}" if isinstance(word, str) and word.strip() else None

    return _ranked([(row.get("word") or row.get("note"), row.get("num"), None, link(row.get("word")))
                    for row in rows if isinstance(row, dict) and not row.get("is_ad")])


def parse_wikipedia(body: bytes) -> list:
    """Wikimedia's top pageviews of one day: the articles in rank order, the main page and the namespaces left out."""
    data = json.loads(body.decode("utf-8"))
    items = data.get("items") or []
    articles = items[0].get("articles") if items and isinstance(items[0], dict) else None
    if not isinstance(articles, list):
        raise ValueError("wikipedia: no articles in the answer")
    rows = []
    for row in articles:
        name = row.get("article") if isinstance(row, dict) else None
        if not isinstance(name, str) or name in WIKI_NOT_ARTICLES or WIKI_NAMESPACES.match(name):
            continue
        rows.append((name.replace("_", " "), row.get("views"), None, "https://en.wikipedia.org/wiki/" + quote(name, safe="()_,'-.")))
    return _ranked(rows)


def parse_google_trends(body: bytes) -> list:
    """Google Trends' trending RSS: each item's title, its approximate traffic, its first news headline and link."""
    root = ElementTree.fromstring(body)
    rows = []
    for item in root.iter("item"):
        title = item.findtext("title")
        traffic = item.findtext(f"{{{GOOGLE_NS}}}approx_traffic")
        news = item.find(f"{{{GOOGLE_NS}}}news_item")
        headline = news.findtext(f"{{{GOOGLE_NS}}}news_item_title") if news is not None else None
        link = news.findtext(f"{{{GOOGLE_NS}}}news_item_url") if news is not None else None
        rows.append((title, traffic, headline, link))
    if not rows and root.find("channel") is None:
        raise ValueError("google-trends: not a feed")
    return _ranked(rows)


def _wikipedia_url(now: datetime) -> str:
    day = (now.astimezone(timezone.utc) - timedelta(days=1)).strftime("%Y/%m/%d")
    return f"https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/{day}"


JSON = {"Accept": "application/json"}
BOARDS: dict[str, Board] = {
    "baidu": Board("baidu", "direct", JSON, parse_baidu, lambda now: "https://top.baidu.com/api/board?platform=pc&tab=realtime"),
    "toutiao": Board("toutiao", "direct", JSON, parse_toutiao, lambda now: "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc"),
    "weibo": Board("weibo", "direct", {**JSON, "Referer": "https://weibo.com/"}, parse_weibo, lambda now: "https://weibo.com/ajax/side/hotSearch"),
    "wikipedia-en": Board("wikipedia-en", "relay", JSON, parse_wikipedia, _wikipedia_url),
    "google-trends": Board("google-trends", "relay", {"Accept": "application/rss+xml, application/xml;q=0.9"}, parse_google_trends,
                           lambda now: "https://trends.google.com/trending/rss?geo=US"),
}


def configured_boards(settings) -> list[str]:
    names = tuple(getattr(settings, "hot_lists_boards", ()) or ())
    return [name for name in (names or tuple(BOARDS)) if name in BOARDS]


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class HotListReader:
    """The crawler's hot-list loop (module docstring): each configured board read once a round, its snapshot kept."""

    def __init__(self, settings, pool, fetcher, *, clock=None) -> None:
        self._settings = settings
        self._pool = pool
        self._fetcher = fetcher
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self.counters: dict[str, int] = {}

    def _count(self, name: str) -> None:
        self.counters[name] = self.counters.get(name, 0) + 1

    async def read_board(self, board: Board, now: datetime) -> list:
        url = board.url(now)
        host = (urlsplit(url).hostname or "").lower()
        result = await self._fetcher.fetch(RequestSpec(url=url, headers=dict(board.headers), conditional=False, api=True),
                                           source_id=f"hot-list:{board.name}", egress=board.egress, allowed_hosts=[host])
        entries = board.parse(result.body)
        if not entries:
            raise ValueError(f"{board.name}: the board was empty")
        return entries

    async def tick(self) -> dict:
        now = self._clock()
        read: dict[str, int] = {}
        failed: dict[str, str] = {}
        snapshots = []
        for name in configured_boards(self._settings):
            board = BOARDS[name]
            try:
                snapshots.append((name, await self.read_board(board, now)))
                read[name] = len(snapshots[-1][1])
                self._count(f"read:{name}")
            except FetchError as error:
                failed[name] = f"{error.outcome}:{error.detail}"[:ERROR_MAX]
            except (ValueError, ElementTree.ParseError, UnicodeDecodeError, AttributeError, TypeError) as error:
                failed[name] = f"parse:{type(error).__name__}:{error}"[:ERROR_MAX]
            except Exception as error:      # one board never ends the round
                log.exception("hot list %s failed", name)
                failed[name] = f"internal:{type(error).__name__}"[:ERROR_MAX]
            if name in failed:
                self._count(f"failed:{name}")
                log.warning("hot list %s: %s", name, failed[name])
        async with self._pool.connection() as conn:
            async with conn.transaction():
                await conn.execute("DELETE FROM evimed_knowledge.hot_lists WHERE fetched_at < %s", (now - RETENTION,))
                for name, entries in snapshots:
                    await conn.execute(
                        """INSERT INTO evimed_knowledge.hot_lists (board, fetched_at, entries) VALUES (%s, %s, %s)
                           ON CONFLICT (board, fetched_at) DO NOTHING""", (name, now, Jsonb(entries)))
                for name in configured_boards(self._settings):
                    error = failed.get(name)
                    await conn.execute(
                        """INSERT INTO evimed_knowledge.hot_list_boards (board, last_attempt_at, last_ok_at, last_error)
                                VALUES (%s, %s, %s, %s)
                           ON CONFLICT (board) DO UPDATE SET last_attempt_at = EXCLUDED.last_attempt_at,
                                last_ok_at = coalesce(EXCLUDED.last_ok_at, evimed_knowledge.hot_list_boards.last_ok_at),
                                last_error = EXCLUDED.last_error""",
                        (name, now, None if error else now, error))
        return {"read": read, "failed": failed}


def parse_since(value: str | None, now: datetime) -> datetime:
    """``since`` as the contract reads it: a date-time, at most 72 hours back (an earlier one is read as 72 hours back);
    absent is 72 hours back. Raises ``ValueError`` on anything else."""
    floor = now - RETENTION
    if value is None or value == "":
        return floor
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return max(parsed, floor)


async def list_snapshots(conn, since: datetime) -> dict:
    """The snapshots taken after ``since``, the oldest first, at most ``PAGE_MAX``: ``GET /v1/hot-lists``."""
    rows = await (await conn.execute(
        """SELECT board, fetched_at, entries FROM evimed_knowledge.hot_lists WHERE fetched_at > %s
            ORDER BY fetched_at, board LIMIT %s""", (since, PAGE_MAX))).fetchall()
    return {"boards": [{"board": row["board"], "fetched_at": _iso(row["fetched_at"]), "entries": list(row["entries"] or [])}
                       for row in rows if row["board"] in BOARDS]}


async def hot_lists_health(conn) -> dict:
    """Each board's last read: ``Health.hot_lists``."""
    rows = await (await conn.execute("SELECT board, last_ok_at, last_error FROM evimed_knowledge.hot_list_boards ORDER BY board")).fetchall()
    return {row["board"]: {"last_ok_at": _iso(row["last_ok_at"]) if row["last_ok_at"] else None, "last_error": row["last_error"]}
            for row in rows if row["board"] in BOARDS}
