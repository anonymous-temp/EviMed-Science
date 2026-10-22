"""One serialized registry composition for startup, reload and every discovery channel.

The composition is the file's rows, the AI source requests, the medical-discovery feeds and the discovered sources on
trial or admitted (``discovery.py``), minus every source the lifecycle retired (``lifecycle.py``): a retired row is
left out, so the sync marks it ``retired_at`` and nothing polls it, while its row, entries and history stay.
"""
from __future__ import annotations

from .db import meta_get
from .medical_discovery import MEDICAL_META, medical_rows
from .registry import RegistryError, parse_registry, sync_registry
from .source_requests import admitted_requests

REGISTRY_LOCK = "evimed-knowledge-registry"


async def lock_registry(conn) -> None:
    await conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (REGISTRY_LOCK,))


async def disabled_sources(conn) -> set[str]:
    rows = await (await conn.execute(
        "SELECT id FROM evimed_knowledge.sources WHERE operator_enabled=false OR disabled_reason='owner_excluded'"
    )).fetchall()
    return {row["id"] for row in rows}


async def discovered_rows(conn, taken: set[str]) -> list:
    """The rows of discovered sources on trial or admitted. A row that no longer loads (a vocabulary this build dropped)
    or whose id another channel holds is left out; it is never repaired here."""
    rows = await (await conn.execute(
        """SELECT row FROM evimed_knowledge.source_candidates
            WHERE state IN ('trial', 'admitted') AND row IS NOT NULL ORDER BY trial_started_at, id""",
    )).fetchall()
    accepted = []
    for row in rows:
        try:
            parsed = parse_registry({"sources": [row["row"]]})[0]
        except (RegistryError, TypeError, KeyError):
            continue
        if parsed.source.id in taken:
            continue
        taken.add(parsed.source.id)
        accepted.append(parsed)
    return accepted


async def sync_dynamic_registry(conn, base, now) -> dict:
    """Every caller retains admitted dynamic rows and rechecks their parent authority."""
    async with conn.transaction():
        await lock_registry(conn)
        # File-backed callers load only after serialization; a waiting old
        # reload must not restore a parent that a newer reload revoked.
        base = base() if callable(base) else base
        ai_document = await meta_get(conn, "source_requests_admitted") or {"sources": []}
        ai_rows, _ = admitted_requests(ai_document, base)
        medical_document = await meta_get(conn, MEDICAL_META) or {"sources": []}
        medical = medical_rows(medical_document, [*base, *ai_rows], await disabled_sources(conn))
        composed = [*base, *ai_rows, *medical]
        composed += await discovered_rows(conn, {row.source.id for row in composed})
        retired = {row["source_id"] for row in await (await conn.execute(
            "SELECT source_id FROM evimed_knowledge.source_lifecycle")).fetchall()}
        return await sync_registry(conn, [row for row in composed if row.source.id not in retired], now)
