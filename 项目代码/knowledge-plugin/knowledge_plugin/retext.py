"""``python -m knowledge_plugin retext [--kinds wechat,page,crossref] [--since 2026-09-01] [--before <iso>] [--limit N]
[--apply]``: the texts stored before the 2026-10-22 reader-text fixes, read again through them.

The audit of the 23,948 published texts (2026-10-22) found three stored kinds the fixes cannot repair in place, because
what was lost is not in the stored text any more:

- ``wechat``: bodies made from Dajiala's light HTML, a paragraph split at every styled run (222 of 256). The article is
  bought again (``SocialCollector.wechat_text``, ¥0.03) and read from its own HTML.
- ``page``: page texts whose paragraph breaks were folded by ``save_text_result`` (5,408 of 7,968 excerpts) or that carry
  the page's furniture. The page is read again (``enrich``, robots.txt and the host budget as always).
- ``crossref``: Crossref abstracts with an entity escaped twice (``P &lt;.001``, 58). The record is read again.

Only entries the platform asked a text for (``text_requested_at``) are read, newest first, those whose text was fetched
before ``--before`` (default: now) and that were first seen after ``--since`` (default: 60 days ago).

- Without ``--apply`` it reads nothing and writes nothing: one line per kind and source with the count, then the totals
  and what the WeChat part would cost.
- With ``--apply`` each text is read again. A text that comes back is stored (``save_text_result``), so its
  ``fetched_at`` moves past ``--before`` and a second run skips it; if it differs from the stored one the entry is
  delivered again as its next revision (``store.redeliver``), so the platform reads the new text. A read that fails —
  the page gone, a pause, the day's Dajiala cap — leaves the stored text exactly as it was: a failure never replaces a
  text, and the next run tries it again.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from datetime import datetime, timedelta
from .db import lock_seq
from .enrich import enrich
from .model import EntryTextResult
from .normalize import clean_body
from .social import wechat as wechat_mod
from .social.providers import ARTICLE_DETAIL_CNY
from .store import ENTRY_COLUMNS, redeliver, save_text_result

KINDS = ("wechat", "page", "crossref")
DEFAULT_SINCE_DAYS = 60
DEFAULT_LIMIT = 20_000
CONCURRENCY = 6          # texts read at once; each host's own pace is the fetcher's budget, as for the text worker

_WHERE = {
    "wechat": "t.fetched_from = 'wechat' AND t.body_text IS NOT NULL",
    "page": "t.fetched_from = 'page' AND (t.body_text IS NOT NULL OR t.body_excerpt IS NOT NULL)",
    "crossref": r"t.fetched_from = 'crossref' AND t.abstract ~ '&(lt|gt|amp|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);'",
}


def kind_of_row(row: dict) -> str:
    return "wechat" if row["fetched_from"] == "wechat" else "crossref" if row["fetched_from"] == "crossref" else "page"


async def candidates(pool, kinds: list[str], *, since: datetime, before: datetime, limit: int = DEFAULT_LIMIT) -> list[dict]:
    """The text jobs to read again, newest first, shaped like ``store.claim_texts``'s (plus the stored texts)."""
    where = " OR ".join(f"({_WHERE[kind]})" for kind in kinds)
    async with pool.connection() as conn:
        rows = await (await conn.execute(
            f"""SELECT {', '.join('e.' + column.strip() for column in ENTRY_COLUMNS.split(','))},
                       s.access AS source_access, s.egress AS source_egress, s.source_type AS source_type,
                       s.config AS source_config, t.attempts, t.paid_attempts, t.fetched_from,
                       t.body_text AS stored_body, t.body_excerpt AS stored_excerpt, t.abstract AS stored_abstract
                  FROM evimed_knowledge.entries e
                  JOIN evimed_knowledge.entry_texts t USING (entry_id)
                  JOIN evimed_knowledge.sources s ON s.id = e.source_id
                 WHERE e.text_status = 'available' AND e.text_requested_at IS NOT NULL AND e.first_seen_at >= %s
                   AND t.fetched_at < %s AND ({where})
                 ORDER BY e.first_seen_at DESC, e.entry_id LIMIT %s""",
            (since, before, limit))).fetchall()
    return [row for row in rows if kind_of_row(row) != "wechat" or wechat_mod.is_article(row["url"])]


async def report(collector, pool, now: datetime, kinds: list[str], *, since: datetime, before: datetime,
                 limit: int = DEFAULT_LIMIT) -> dict:
    """What ``--apply`` would read: counts by kind and source; reads nothing, writes nothing."""
    rows = await candidates(pool, kinds, since=since, before=before, limit=limit)
    by = Counter((kind_of_row(row), row["source_id"]) for row in rows)
    wechat = sum(count for (kind, _), count in by.items() if kind == "wechat")
    return {
        "entries": [{"kind": kind, "source_id": source, "count": count} for (kind, source), count in by.most_common()],
        "summary": {"candidates": len(rows), **{kind: sum(c for (k, _), c in by.items() if k == kind) for kind in kinds},
                    "wechat_estimate_cny": round(wechat * ARTICLE_DETAIL_CNY, 2),
                    "dajiala_configured": collector.dajiala.configured, "since": since.isoformat(),
                    "before": before.isoformat()},
    }


def changed(row: dict, result: EntryTextResult) -> bool:
    """Whether the text read again differs from the stored one, each compared as ``save_text_result`` stores it (a text
    that did not come back keeps the stored one)."""
    pairs = ((clean_body(result.body_text), row["stored_body"]), (clean_body(result.body_excerpt, 20_000), row["stored_excerpt"]),
             (clean_body(result.abstract, 20_000), row["stored_abstract"]))
    return any(new is not None and new != old for new, old in pairs)


async def read_again(collector, fetcher, settings, row: dict, now: datetime) -> EntryTextResult:
    if kind_of_row(row) == "wechat":
        return await collector.wechat_text(row, now)
    return await enrich(row, fetcher, settings, now=now)


async def apply(collector, pool, fetcher, settings, clock, kinds: list[str], *, since: datetime, before: datetime,
                limit: int = DEFAULT_LIMIT, emit=None) -> dict:
    """Read the texts again (module docstring): ``{"entries": [one line each], "summary": counts}``."""
    rows = await candidates(pool, kinds, since=since, before=before, limit=limit)
    counts: Counter = Counter()
    out: list[dict] = []
    gate = asyncio.Semaphore(CONCURRENCY)

    async def one(row: dict) -> None:
        async with gate:
            now = clock()
            line = {"entry_id": row["entry_id"], "source_id": row["source_id"], "kind": kind_of_row(row)}
            try:
                result = await asyncio.wait_for(read_again(collector, fetcher, settings, row, now), timeout=120)
            except Exception as error:  # noqa: BLE001 - one entry's failure is reported, the run goes on
                result = EntryTextResult(status="pending", notes=[f"retext_failed:{type(error).__name__}"])
            if result.status == "available" and (result.body_text or result.body_excerpt or result.abstract):
                is_new = changed(row, result)
                async with pool.connection() as conn:
                    async with conn.transaction():
                        await lock_seq(conn)        # before any row lock: the order every stream write takes
                        await save_text_result(conn, row, result, now)
                        revision = await redeliver(conn, row["entry_id"], now) if is_new else None
                line.update(outcome="redelivered" if is_new else "same", revision=revision,
                            chars=len(result.body_text or result.body_excerpt or result.abstract or ""))
            else:
                line.update(outcome="kept", reason=",".join(result.notes)[:120])
            counts[line["outcome"]] += 1
            out.append(line)
            if emit is not None:
                emit(line)

    await asyncio.gather(*(one(row) for row in rows))
    return {"entries": out, "summary": {"candidates": len(rows), **{key: counts[key] for key in ("redelivered", "same", "kept")}}}


def window(argv: list[str], now: datetime) -> tuple[list[str], datetime, datetime, int] | str:
    """``(kinds, since, before, limit)`` from the command's flags, or the message for a flag that is wrong."""
    kinds, since, before, limit = list(KINDS), now - timedelta(days=DEFAULT_SINCE_DAYS), now, DEFAULT_LIMIT
    for flag, value in zip(argv, argv[1:]):
        try:
            if flag == "--kinds":
                kinds = [kind.strip() for kind in value.split(",") if kind.strip()]
                if not kinds or any(kind not in KINDS for kind in kinds):
                    return f"--kinds takes a comma-separated list of {', '.join(KINDS)}"
            elif flag in ("--since", "--before"):
                moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
                moment = moment if moment.tzinfo else moment.replace(tzinfo=now.tzinfo)
                since, before = (moment, before) if flag == "--since" else (since, moment)
            elif flag == "--limit":
                limit = int(value)
                if not 1 <= limit <= 100_000:
                    return "--limit takes a whole number from 1 to 100000"
        except ValueError:
            return f"{flag} {value!r} is not valid"
    return kinds, since, before, limit


__all__ = ["KINDS", "apply", "candidates", "changed", "report", "window"]
