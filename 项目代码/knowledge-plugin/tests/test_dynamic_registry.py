"""Real PostgreSQL keeps both dynamic channels across reload and parent revocation."""
from dataclasses import replace
from datetime import datetime, timezone

from knowledge_plugin.db import meta_set
from knowledge_plugin.dynamic_registry import sync_dynamic_registry
from knowledge_plugin.medical_discovery import MEDICAL_META, feed_row
from test_medical_discovery import parent_row
from test_source_requests import PLATFORM_ARXIV_ROW


async def test_reload_keeps_both_channels_and_disables_a_revoked_medical_parent(pool):
    parent = parent_row()
    child = feed_row(parent, {"url": "https://www.example.org/updates.xml", "name": "Updates", "access": "rss"})
    now = datetime.now(timezone.utc)
    async with pool.connection() as conn:
        await meta_set(conn, "source_requests_admitted", {"sources": [PLATFORM_ARXIV_ROW]})
        await meta_set(conn, MEDICAL_META, {"sources": [child]})
        first = await sync_dynamic_registry(conn, [parent], now)
        assert first["rows"] == 3
        await sync_dynamic_registry(conn, [parent], now)
        rows = await (await conn.execute("SELECT id, retired_at FROM evimed_knowledge.sources")).fetchall()
        assert len(rows) == 3 and all(row["retired_at"] is None for row in rows)
        await conn.execute("UPDATE evimed_knowledge.sources SET operator_enabled=false WHERE id=%s", (parent.source.id,))
        await sync_dynamic_registry(conn, [parent], now)
        held = await (await conn.execute("SELECT retired_at FROM evimed_knowledge.sources WHERE id=%s", (child["id"],))).fetchone()
        assert held["retired_at"] is not None
        ai = await (await conn.execute("SELECT retired_at FROM evimed_knowledge.sources WHERE id=%s", (PLATFORM_ARXIV_ROW["id"],))).fetchone()
        assert ai["retired_at"] is None


async def test_parent_removed_from_registry_retires_only_its_dynamic_children(pool):
    parent = parent_row()
    child = feed_row(parent, {"url": "https://www.example.org/updates.xml", "name": "Updates", "access": "rss"})
    async with pool.connection() as conn:
        await meta_set(conn, MEDICAL_META, {"sources": [child]})
        await sync_dynamic_registry(conn, [parent], datetime.now(timezone.utc))
        await sync_dynamic_registry(conn, [replace(parent, enabled=False, disabled_reason="owner_excluded")], datetime.now(timezone.utc))
        rows = await (await conn.execute("SELECT id, retired_at, enabled FROM evimed_knowledge.sources")).fetchall()
        assert next(row for row in rows if row["id"] == parent.source.id)["enabled"] is False
        assert next(row for row in rows if row["id"] == child["id"])["retired_at"] is not None
