"""Writes to the plugin database: entries (seq, revision), seen_keys, fetches, texts, source state.

Entry upsert, by ``(source_id, external_key)``, in one transaction per parsed page, holding the seq
lock (``db.lock_seq``) so that commit order is seq order:

- **new** → insert (a fresh ``seq``, ``revision`` 1, ``backfill`` per the first-contact guard);
- **same content hash** → nothing is written to ``entries`` (only ``seen_keys.last_seen_at``);
- **changed** → ``revision + 1`` and a new ``seq`` via ``UPDATE … SET seq = DEFAULT`` (an identity
  column takes its next value on ``DEFAULT``), so the row moves to the end of the stream and the
  consumer sees the new revision exactly once;
- **purged but remembered** (``seen_keys`` has the key, ``entries`` no longer has the row): the same
  hash is a no-op — the 400-day memory is what stops a deep feed (MMWR back to 2019) or an undated
  list from coming back as new a month after the purge (review finding 13 #23); a changed hash
  re-delivers with the revision after the last one delivered.

A revision re-arms text enrichment when the platform had asked for the text: content changed, so
the abstract may have too.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb

from .db import lock_seq
from .model import ENRICHMENT_TYPES, FETCHED_FROM, OPEN_ACCESS, TEXT_KINDS, TRIAL_FACT_TYPES, EntryTextResult
from .normalize import Prepared, clean_text, cut, is_backfill, resolve_dates

ENTRY_COLUMNS = (
    "seq, entry_id, source_id, external_key, identity_key, url, canonical_url, doi, pmid, registry_ids, title, "
    "summary, lang, lane_hint, published_at, date_precision, first_seen_at, content_sha256, revision, backfill, "
    "defects, facts, text_status, text_requested_at, delivered_at"
)


@dataclass
class StoreResult:
    seen: int = 0
    inserted: int = 0          # new, delivered as new
    backfilled: int = 0        # new, delivered with backfill=true (first contact, older than 7 days)
    revised: int = 0
    unchanged: int = 0
    resurrected: int = 0       # purged rows re-delivered because their content changed
    dated: int = 0             # entries whose adapter gave a date (drift: "all dates empty")

    @property
    def new(self) -> int:
        return self.inserted + self.resurrected

    def add(self, other: "StoreResult") -> None:
        for name in ("seen", "inserted", "backfilled", "revised", "unchanged", "resurrected", "dated"):
            setattr(self, name, getattr(self, name) + getattr(other, name))


async def store_entries(conn: AsyncConnection, source_id: str, batch: list[Prepared], *, now: datetime,
                        first_contact: bool) -> StoreResult:
    """Upsert one page of prepared entries of one source (see module docstring)."""
    result = StoreResult()
    unique: dict[str, Prepared] = {}
    for item in batch:
        unique.setdefault(item.external_key, item)
    items = list(unique.values())
    result.seen = len(items)
    result.dated = sum(1 for item in items if item.raw_published_at is not None)
    if not items:
        return result
    async with conn.transaction():
        await lock_seq(conn)
        rows = await (await conn.execute(
            """SELECT external_key, content_sha256, revision, first_seen_at, text_requested_at, text_status
                 FROM evimed_knowledge.entries
                WHERE source_id = %s AND external_key = ANY(%s) FOR UPDATE""",
            (source_id, [i.external_key for i in items]),
        )).fetchall()
        existing = {row["external_key"]: row for row in rows}
        memory_rows = await (await conn.execute(
            """SELECT key_sha256, content_sha256, revision, first_seen_at FROM evimed_knowledge.seen_keys
                WHERE source_id = %s AND key_sha256 = ANY(%s)""",
            (source_id, [i.key_sha256 for i in items]),
        )).fetchall()
        memory = {row["key_sha256"]: row for row in memory_rows}
        seen_rows: list[tuple] = []
        for item in items:
            current = existing.get(item.external_key)
            if current is not None:
                if current["content_sha256"] == item.content_sha256:
                    result.unchanged += 1
                    seen_rows.append((source_id, item.key_sha256, item.content_sha256, current["first_seen_at"], now, current["revision"]))
                    continue
                published, precision, date_defects = resolve_dates(item, current["first_seen_at"])
                rearm = current["text_requested_at"] is not None and current["text_status"] in ("available", "unavailable", "pending")
                await conn.execute(
                    """UPDATE evimed_knowledge.entries SET seq = DEFAULT, revision = revision + 1, identity_key = %s,
                              url = %s, canonical_url = %s, doi = %s, pmid = %s, registry_ids = %s, title = %s,
                              summary = %s, lang = %s, lane_hint = %s, published_at = %s, date_precision = %s,
                              content_sha256 = %s, defects = %s, facts = %s, delivered_at = %s,
                              text_status = CASE WHEN %s THEN 'pending' ELSE text_status END
                        WHERE source_id = %s AND external_key = %s""",
                    (item.identity_key, item.url, item.canonical_url, item.doi, item.pmid, item.registry_ids, item.title,
                     item.summary, item.language, item.lane_hint, published, precision, item.content_sha256,
                     item.defects + date_defects, Jsonb(item.facts), now, rearm, source_id, item.external_key),
                )
                if rearm:
                    await conn.execute(
                        """INSERT INTO evimed_knowledge.entry_texts (entry_id, revision, next_attempt_at)
                           VALUES (%s, %s, %s)
                           ON CONFLICT (entry_id) DO UPDATE SET next_attempt_at = EXCLUDED.next_attempt_at, attempts = 0""",
                        (item.entry_id, current["revision"] + 1, now),
                    )
                result.revised += 1
                seen_rows.append((source_id, item.key_sha256, item.content_sha256, current["first_seen_at"], now, current["revision"] + 1))
                continue
            remembered = memory.get(item.key_sha256)
            if remembered is not None and remembered["content_sha256"] == item.content_sha256:
                result.unchanged += 1
                seen_rows.append((source_id, item.key_sha256, item.content_sha256, remembered["first_seen_at"], now, remembered["revision"]))
                continue
            first_seen = remembered["first_seen_at"] if remembered is not None else now
            revision = remembered["revision"] + 1 if remembered is not None else 1
            backfill = False if remembered is not None else is_backfill(item, now, first_contact)
            published, precision, date_defects = resolve_dates(item, first_seen)
            await conn.execute(
                """INSERT INTO evimed_knowledge.entries
                     (entry_id, source_id, external_key, identity_key, url, canonical_url, doi, pmid, registry_ids,
                      title, summary, lang, lane_hint, published_at, date_precision, first_seen_at, content_sha256,
                      revision, backfill, defects, facts, delivered_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (item.entry_id, source_id, item.external_key, item.identity_key, item.url, item.canonical_url, item.doi,
                 item.pmid, item.registry_ids, item.title, item.summary, item.language, item.lane_hint, published,
                 precision, first_seen, item.content_sha256, revision, backfill, item.defects + date_defects,
                 Jsonb(item.facts), now),
            )
            if remembered is not None:
                result.resurrected += 1
            elif backfill:
                result.backfilled += 1
            else:
                result.inserted += 1
            seen_rows.append((source_id, item.key_sha256, item.content_sha256, first_seen, now, revision))
        async with conn.cursor() as cur:
            await cur.executemany(
                """INSERT INTO evimed_knowledge.seen_keys (source_id, key_sha256, content_sha256, first_seen_at, last_seen_at, revision)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   ON CONFLICT (source_id, key_sha256) DO UPDATE SET content_sha256 = EXCLUDED.content_sha256,
                     last_seen_at = EXCLUDED.last_seen_at,
                     revision = greatest(evimed_knowledge.seen_keys.revision, EXCLUDED.revision)""",
                seen_rows,
            )
    return result


# ------------------------------------------------------------------------------------ fetch log

async def insert_fetch(conn: AsyncConnection, *, source_id: str, fetched_at: datetime, egress: str, host: str | None,
                       http_status: int | None, outcome: str, bytes_: int, duration_ms: int, content_sha256: str | None,
                       entries_seen: int, entries_new: int, error_detail: str | None, requests: int) -> None:
    await conn.execute(
        """INSERT INTO evimed_knowledge.fetches (source_id, fetched_at, egress, host, http_status, outcome, bytes,
                  duration_ms, content_sha256, entries_seen, entries_new, error_detail, requests)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (source_id, fetched_at, egress, host, http_status, outcome, max(0, bytes_), max(0, duration_ms), content_sha256,
         entries_seen, entries_new, (error_detail or None) and error_detail[:500], max(1, requests)),
    )


async def success_rate_24h(conn: AsyncConnection, source_id: str, now: datetime) -> float | None:
    row = await (await conn.execute(
        """SELECT count(*) FILTER (WHERE outcome IN ('ok', 'not-modified', 'empty')) AS good,
                  count(*) FILTER (WHERE outcome <> 'host-budget') AS total
             FROM evimed_knowledge.fetches WHERE source_id = %s AND fetched_at > %s""",
        (source_id, now - timedelta(hours=24)),
    )).fetchone()
    if not row or not row["total"]:
        return None
    return row["good"] / row["total"]


# ------------------------------------------------------------------------------------ texts

TEXT_HORIZON = timedelta(days=5)
TEXT_REFRESH_GRACE = timedelta(days=1)
_COUNTRY = re.compile(r"^[A-Z]{2}$")
TEXT_RETRY_DEFAULT_S = 6 * 3600
TEXT_RETRY_MIN_S = 15 * 60
TEXT_RETRY_MAX_S = 12 * 3600


def text_deadline(job: dict, now: datetime) -> datetime:
    """When enrichment stops retrying: five days after the entry was first seen (plan 10.3.4 — the
    same clock the readers' own rule uses), or a day after an operator's refresh of an older entry."""
    first_seen = job.get("first_seen_at") or now
    requested = job.get("text_requested_at") or now
    return max(first_seen + TEXT_HORIZON, requested + TEXT_REFRESH_GRACE)


async def entry_row(conn: AsyncConnection, entry_id: str) -> dict | None:
    return await (await conn.execute(
        f"SELECT {ENTRY_COLUMNS} FROM evimed_knowledge.entries WHERE entry_id = %s", (entry_id,)
    )).fetchone()


async def text_row(conn: AsyncConnection, entry_id: str) -> dict | None:
    return await (await conn.execute(
        """SELECT entry_id, revision, text_kind, abstract, body_excerpt, fetched_from, fetched_at, attempts,
                  next_attempt_at, enrichment, last_error FROM evimed_knowledge.entry_texts WHERE entry_id = %s""",
        (entry_id,),
    )).fetchone()


async def schedule_text(conn: AsyncConnection, entry_id: str, revision: int, now: datetime, *, reset: bool) -> datetime:
    """Queue enrichment for an entry now; ``reset`` clears the attempt count (operator refresh)."""
    await conn.execute(
        """INSERT INTO evimed_knowledge.entry_texts (entry_id, revision, next_attempt_at) VALUES (%s, %s, %s)
           ON CONFLICT (entry_id) DO UPDATE SET next_attempt_at = least(coalesce(evimed_knowledge.entry_texts.next_attempt_at, EXCLUDED.next_attempt_at), EXCLUDED.next_attempt_at),
             attempts = CASE WHEN %s THEN 0 ELSE evimed_knowledge.entry_texts.attempts END""",
        (entry_id, revision, now, reset),
    )
    await conn.execute(
        """UPDATE evimed_knowledge.entries SET text_status = 'pending',
                  text_requested_at = CASE WHEN %s THEN %s ELSE coalesce(text_requested_at, %s) END
            WHERE entry_id = %s""",
        (reset, now, now, entry_id),
    )
    return now


async def claim_texts(conn: AsyncConnection, limit: int, now: datetime, lease_s: int) -> list[dict]:
    """Take up to ``limit`` due enrichment jobs; the lease is a pushed-back ``next_attempt_at``."""
    async with conn.transaction():
        rows = await (await conn.execute(
            """WITH due AS (
                 SELECT t.entry_id FROM evimed_knowledge.entry_texts t
                   JOIN evimed_knowledge.entries e ON e.entry_id = t.entry_id
                  WHERE e.text_status = 'pending' AND t.next_attempt_at <= %s
                  ORDER BY t.next_attempt_at LIMIT %s FOR UPDATE OF t SKIP LOCKED)
               UPDATE evimed_knowledge.entry_texts t SET next_attempt_at = %s
                 FROM due WHERE t.entry_id = due.entry_id
               RETURNING t.entry_id, t.attempts""",
            (now, limit, now + timedelta(seconds=lease_s)),
        )).fetchall()
    jobs = []
    for row in rows:
        joined = await (await conn.execute(
            f"""SELECT {', '.join('e.' + c.strip() for c in ENTRY_COLUMNS.split(','))},
                       s.access AS source_access, s.egress AS source_egress, s.source_type AS source_type,
                       s.config AS source_config
                  FROM evimed_knowledge.entries e JOIN evimed_knowledge.sources s ON s.id = e.source_id
                 WHERE e.entry_id = %s""",
            (row["entry_id"],),
        )).fetchone()
        if joined:
            joined["attempts"] = row["attempts"]
            jobs.append(joined)
    return jobs


def whitelist_enrichment(enrichment: dict | None) -> dict:
    """Contract rule 4 for ``EntryText.enrichment``: known keys, right types, bounded sizes."""
    kept: dict = {}
    for key, value in (enrichment or {}).items():
        expected = ENRICHMENT_TYPES.get(key)
        if expected is None or value is None:
            continue
        if key == "affiliation_countries":
            codes = [v.strip().upper() for v in value if isinstance(v, str)] if isinstance(value, list) else []
            codes = list(dict.fromkeys(c for c in codes if _COUNTRY.match(c)))
            if codes:
                kept[key] = codes[:50]
        elif expected is list and isinstance(value, list):
            items = [cut(clean_text(v), 200) for v in value if isinstance(v, str) and clean_text(v)]
            if items:
                kept[key] = items[:50]
        elif expected is str and isinstance(value, str) and clean_text(value):
            text = cut(clean_text(value), 2000)
            if key == "open_access" and text not in OPEN_ACCESS:
                continue
            if key == "oa_pdf_url" and not text.startswith(("http://", "https://")):
                continue
            kept[key] = text
        elif expected is float and isinstance(value, (int, float)) and not isinstance(value, bool):
            kept[key] = float(value)
        elif expected is dict and isinstance(value, dict):
            facts = {}
            for fact, fact_type in TRIAL_FACT_TYPES.items():
                item = value.get(fact)
                if fact_type is int and isinstance(item, int) and not isinstance(item, bool):
                    facts[fact] = item
                elif fact_type is str and isinstance(item, str) and clean_text(item):
                    facts[fact] = cut(clean_text(item), 200)
            if facts:
                kept[key] = facts
    return kept


async def save_text_result(conn: AsyncConnection, job: dict, result: EntryTextResult, now: datetime) -> str:
    """Store an enrichment outcome; returns the entry's new text status."""
    attempts = int(job.get("attempts") or 0) + 1
    status = result.status if result.status in ("available", "pending", "unavailable") else "pending"
    if status == "pending" and now >= text_deadline(job, now):
        status = "unavailable"
    enrichment = whitelist_enrichment(result.enrichment)
    abstract = cut(clean_text(result.abstract), 20_000) if result.abstract else None
    excerpt = cut(clean_text(result.body_excerpt), 20_000) if result.body_excerpt else None
    kind = result.text_kind if result.text_kind in TEXT_KINDS else "none"
    source = result.fetched_from if result.fetched_from in FETCHED_FROM else None
    if status == "pending":
        delay = result.retry_after_s or TEXT_RETRY_DEFAULT_S
        next_attempt = now + timedelta(seconds=min(max(delay, TEXT_RETRY_MIN_S), TEXT_RETRY_MAX_S))
    else:
        next_attempt = None
    async with conn.transaction():
        await conn.execute(
            """UPDATE evimed_knowledge.entry_texts SET revision = %s, attempts = %s, next_attempt_at = %s,
                      text_kind = CASE WHEN %s THEN %s ELSE text_kind END,
                      abstract = coalesce(%s, abstract), body_excerpt = coalesce(%s, body_excerpt),
                      fetched_from = coalesce(%s, fetched_from), fetched_at = coalesce(%s, fetched_at),
                      enrichment = enrichment || %s, last_error = %s
                WHERE entry_id = %s""",
            (job["revision"], min(attempts, 32767), next_attempt, kind != "none", kind, abstract, excerpt, source,
             result.fetched_at or (now if status == "available" else None), Jsonb(enrichment),
             ",".join(result.notes)[:200] or None, job["entry_id"]),
        )
        await conn.execute("UPDATE evimed_knowledge.entries SET text_status = %s WHERE entry_id = %s", (status, job["entry_id"]))
    return status


async def text_failure(conn: AsyncConnection, job: dict, code: str, now: datetime, *, retry_s: int = 3600) -> str:
    """An enrichment attempt that raised or had no enricher: retry later, give up after 5 days."""
    status = "unavailable" if now >= text_deadline(job, now) else "pending"
    async with conn.transaction():
        await conn.execute(
            """UPDATE evimed_knowledge.entry_texts SET attempts = least(attempts + 1, 32767), last_error = %s,
                      next_attempt_at = %s WHERE entry_id = %s""",
            (code[:200], None if status == "unavailable" else now + timedelta(seconds=retry_s), job["entry_id"]),
        )
        await conn.execute("UPDATE evimed_knowledge.entries SET text_status = %s WHERE entry_id = %s", (status, job["entry_id"]))
    return status
