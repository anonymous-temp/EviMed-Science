"""``python -m knowledge_plugin wechat-bodies [--days 7] [--apply]``: the WeChat texts lost before fr-ext, bought again.

Until 2026-10-22 a WeChat post whose body purchase failed at collection (Dajiala code 20002: 88 of 300 calls that
afternoon, while the balance ran down) was stored without it, and when the platform asked ``/text`` the page reader read
mp.weixin.qq.com, whose robots.txt refuses it: the entry was answered ``unavailable`` and the platform published it from
its title and digest for good. The text worker now buys such a text (``SocialCollector.wechat_text``); this command takes
the entries already answered that way through the same call.

- Without ``--apply`` it writes nothing and calls nobody: one line per entry (a WeChat article answered ``unavailable``,
  without a text, first seen within ``--days``, with calls left of its six), then the count, what buying them would cost
  and what is left of the day's cap.
- With ``--apply`` each text is bought in turn, newest first, until the day's cap or a pause stops it. A text that arrives
  is stored and the entry delivered again as its next revision (``store.redeliver``), so the platform asks ``/text`` again
  and re-edits the item with it. A call that fails for a reason that passes leaves the entry as it was: running the
  command again later tries it again, within the entry's six calls. An article that is gone (or that Dajiala says it cannot
  read) stays ``unavailable`` with the reason kept, and is not a candidate again.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta

from ..db import lock_seq
from ..store import redeliver, save_text_result
from . import wechat as wechat_mod
from .providers import ARTICLE_DETAIL_CNY
from .spend import DAJIALA

DEFAULT_DAYS = 7
DEFAULT_LIMIT = 2000
# The text worker's final answers about a WeChat text (``SocialCollector.wechat_text`` notes): bought once, never again.
FINAL_REASONS = frozenset({"dajiala_gone", "dajiala_bad-request", "wechat_body_empty"})


def _answered(last_error: str | None) -> bool:
    return any(note.split(":")[0] in FINAL_REASONS for note in (last_error or "").split(","))


async def candidates(pool, now: datetime, *, days: int = DEFAULT_DAYS, limit: int = DEFAULT_LIMIT) -> list[dict]:
    """The WeChat entries answered ``unavailable`` without a text in the last ``days``, newest first, as text jobs."""
    async with pool.connection() as conn:
        rows = await (await conn.execute(
            r"""SELECT e.entry_id, e.source_id, e.url, e.revision, e.first_seen_at, e.text_requested_at, t.attempts,
                       t.paid_attempts, t.last_error
                  FROM evimed_knowledge.entries e JOIN evimed_knowledge.entry_texts t USING (entry_id)
                 WHERE e.text_status = 'unavailable' AND t.body_text IS NULL AND e.first_seen_at >= %s
                   AND t.paid_attempts < %s AND e.url ~* '^https?://mp\.weixin\.qq\.com/'
                 ORDER BY e.first_seen_at DESC, e.entry_id LIMIT %s""",
            (now - timedelta(days=days), wechat_mod.BODY_CALLS, limit))).fetchall()
    return [row for row in rows if wechat_mod.is_article(row["url"]) and not _answered(row["last_error"])]


async def report(collector, pool, now: datetime, *, days: int = DEFAULT_DAYS, limit: int = DEFAULT_LIMIT) -> dict:
    """What ``--apply`` would buy: ``{"entries": [...], "summary": {...}}``; writes nothing, calls nobody."""
    rows = await candidates(pool, now, days=days, limit=limit)
    spent = await collector.ledger.spent_today(DAJIALA, now)
    return {
        "entries": [{"entry_id": row["entry_id"], "source_id": row["source_id"], "first_seen_at": row["first_seen_at"],
                     "calls_so_far": int(row["paid_attempts"] or 0), "last_error": row["last_error"]} for row in rows],
        "summary": {"candidates": len(rows), "days": days, "estimate_cny": round(len(rows) * ARTICLE_DETAIL_CNY, 2),
                    "spent_today_cny": round(spent, 2), "daily_cap_cny": float(collector.dajiala.cap.amount),
                    "dajiala_configured": collector.dajiala.configured},
    }


async def apply(collector, pool, clock, *, days: int = DEFAULT_DAYS, limit: int = DEFAULT_LIMIT) -> dict:
    """Buy the texts (module docstring): ``{"entries": [one outcome each], "summary": counts}``."""
    rows = await candidates(pool, clock(), days=days, limit=limit)
    out: list[dict] = []
    counts: Counter = Counter()
    stopped = None
    for index, row in enumerate(rows):
        now = clock()
        stopped = await collector.bodies_blocked(now)
        if stopped:
            counts["not_tried"] += len(rows) - index
            break
        result = await collector.wechat_text(row, now)
        line = {"entry_id": row["entry_id"], "source_id": row["source_id"]}
        if result.status == "available":
            async with pool.connection() as conn:
                async with conn.transaction():
                    await lock_seq(conn)        # before any row lock: the order every stream write takes
                    await save_text_result(conn, row, result, now)
                    revision = await redeliver(conn, row["entry_id"], now)
            line.update(outcome="recovered", revision=revision, chars=len(result.body_text or ""))
        elif result.status == "unavailable":
            async with pool.connection() as conn:
                await save_text_result(conn, row, result, now)      # stays unavailable, with its reason
            line.update(outcome="unavailable", reason=",".join(result.notes))
        else:
            line.update(outcome="later", reason=",".join(result.notes))
        counts[line["outcome"]] += 1
        out.append(line)
    summary = {"candidates": len(rows), **{key: counts[key] for key in ("recovered", "unavailable", "later", "not_tried")}}
    if stopped:
        summary["stopped"] = stopped
    return {"entries": out, "summary": summary}
