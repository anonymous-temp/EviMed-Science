"""One serialized registry composition for startup, reload and both discovery channels."""
from __future__ import annotations

from .db import meta_get
from .medical_discovery import MEDICAL_META, medical_rows
from .registry import sync_registry
from .source_requests import admitted_requests

REGISTRY_LOCK = "evimed-knowledge-registry"


async def lock_registry(conn) -> None:
    await conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (REGISTRY_LOCK,))


async def disabled_sources(conn) -> set[str]:
    rows = await (await conn.execute(
        "SELECT id FROM evimed_knowledge.sources WHERE operator_enabled=false OR disabled_reason='owner_excluded'"
    )).fetchall()
    return {row["id"] for row in rows}


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
        return await sync_registry(conn, [*base, *ai_rows, *medical], now)
