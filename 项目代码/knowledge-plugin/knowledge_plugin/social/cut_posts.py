"""Posts of the six Chinese platforms stored short of themselves, and ``python -m knowledge_plugin social-bodies [--apply]``.

Until 2026-10-31 a post kept ``title + content`` cut to 300 characters and no picture, although the crawler answered the post
whole (37 of 60 Xiaohongshu and 46 of 64 Weibo posts stopped at the cut). A post read now is stored whole (``crawl.build_entry``,
``crawl.pictures_of``); this module takes the ones already stored the same way:

- **``fill`` (the crawl loop, ``SocialCollector.run_crawl``).** A post the crawler answers again whose entry is still in the
  stream, holds no full text, and now comes with one (or has no picture and now comes with some) is written in and delivered
  again as its next revision (``store.fill_post``), so the platform re-reads it. Nothing is asked of the crawler for this: it is
  the answer of the read the loop was making anyway.
- **``social-bodies`` (this command).** Posts the loop will not see again are in the crawler's retained jobs (about 350, back to
  2026-10-27): the command lists them and reads each one (``GET /api/jobs``, ``GET /api/jobs/{id}``: no crawl, no request
  against the day's cap), and for every post whose entry holds a cut text or none stores the whole text. Without ``--apply`` it
  writes nothing and prints one line per platform with counts, then a summary. With ``--apply`` each is written and
  delivered again. Idempotent: an entry that holds a full text is not a candidate, a post whose ``content`` only repeats its
  title has no text to store, and the same post in several jobs is stored once, from the longest ``content``. The retained jobs
  were asked without the raw answer, so this command restores texts only; a picture comes with the loop's next read of the post.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime

from ..db import lock_seq
from ..normalize import clean_media
from ..store import fill_post
from . import crawl as crawl_mod
from .providers import snapshot_posts


async def stored(pool, source_id: str | None, keys: list[str]) -> dict[str, dict]:
    """The entries of the six platforms' sources among ``keys`` (``source_id`` narrows it to one source): their text and
    pictures as stored, by external key."""
    if not keys:
        return {}
    async with pool.connection() as conn:
        rows = await (await conn.execute(
            """SELECT e.entry_id, e.source_id, e.external_key, e.platform, e.media, t.body_text
                 FROM evimed_knowledge.entries e
                 JOIN evimed_knowledge.sources s ON s.id = e.source_id
                 LEFT JOIN evimed_knowledge.entry_texts t USING (entry_id)
                WHERE s.access = 'social-crawl' AND e.external_key = ANY(%s) AND (%s::text IS NULL OR e.source_id = %s)""",
            (keys, source_id, source_id))).fetchall()
    return {row["external_key"]: row for row in rows}


def wants(row: dict, entry) -> tuple[bool, bool]:
    """``(text, pictures)``: whether the stored entry is short of the post as read (module docstring). A stored full text is
    never replaced: it is the platform's already, and a post that was edited since is not this command's business."""
    return (bool(entry.body_text) and not row["body_text"], bool(entry.media) and not row["media"])


async def fill(pool, row: dict, entry, now: datetime) -> str | None:
    """Write what the stored entry is short of from the post as read and deliver it again; the outcome (``text``, ``pictures``
    or ``text+pictures``), or ``None`` when it was short of nothing."""
    text, pictures = wants(row, entry)
    if not (text or pictures):
        return None
    async with pool.connection() as conn:
        async with conn.transaction():
            await lock_seq(conn)        # before any row lock: the order every stream write takes
            revision = await fill_post(conn, row["entry_id"], body=entry.body_text if text else None,
                                       media=clean_media(entry.media) if pictures else None, now=now)
    return "+".join(name for name, wanted in (("text", text), ("pictures", pictures)) if wanted) if revision else None


async def posts_in_jobs(crawler, now: datetime) -> tuple[dict[str, object], dict]:
    """The retained jobs' posts that have a text, by external key (the longest ``content`` of a post seen in several jobs), and
    what reading the jobs came to (``CrawlClient.retained``)."""
    found: dict[str, object] = {}

    async def on_job(snapshot: dict) -> None:
        for platform, post in snapshot_posts(snapshot):
            entry = crawl_mod.build_entry(post, platform, now=now)
            post.pop("raw_response", None)
            if entry is None or not entry.body_text:
                continue
            held = found.get(entry.external_key)
            if held is None or len(entry.body_text) > len(held.body_text):
                found[entry.external_key] = entry

    counts = await crawler.retained(on_job=on_job)
    return found, counts


async def report(crawler, pool, now: datetime) -> dict:
    """What ``--apply`` would store: ``{"entries": [one line per platform], "summary": {...}}``; writes nothing, asks the
    crawler for nothing but its retained jobs."""
    posts, jobs = await posts_in_jobs(crawler, now)
    rows = await stored(pool, None, list(posts))
    by_platform: dict[str, Counter] = defaultdict(Counter)
    for key, entry in posts.items():
        counter = by_platform[entry.platform or "?"]
        counter["posts"] += 1
        row = rows.get(key)
        if row is None:
            counter["not_stored"] += 1
        elif wants(row, entry)[0]:
            counter["to_fill"] += 1
        else:
            counter["already_full"] += 1
    lines = [{"platform": name, **{key: counter[key] for key in ("posts", "to_fill", "already_full", "not_stored")}}
             for name, counter in sorted(by_platform.items())]
    return {"entries": lines, "summary": {**jobs, "posts": len(posts), "to_fill": sum(line["to_fill"] for line in lines)}}


async def apply(crawler, pool, clock) -> dict:
    """Store the whole texts (module docstring): ``{"entries": [one line per platform], "summary": counts}``."""
    posts, jobs = await posts_in_jobs(crawler, clock())
    rows = await stored(pool, None, list(posts))
    by_platform: dict[str, Counter] = defaultdict(Counter)
    for key, entry in posts.items():
        counter = by_platform[entry.platform or "?"]
        counter["posts"] += 1
        row = rows.get(key)
        if row is None:
            counter["not_stored"] += 1
        elif not wants(row, entry)[0]:
            counter["already_full"] += 1
        else:
            counter["filled" if await fill(pool, row, entry, clock()) else "gone"] += 1
    lines = [{"platform": name, **{key: counter[key] for key in ("posts", "filled", "already_full", "not_stored", "gone")}}
             for name, counter in sorted(by_platform.items())]
    return {"entries": lines, "summary": {**jobs, "posts": len(posts), "filled": sum(line["filled"] for line in lines)}}
