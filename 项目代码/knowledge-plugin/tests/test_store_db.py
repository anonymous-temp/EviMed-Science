"""Entries against a real PostgreSQL: seq, revision, idempotence, backfill, 400-day memory, the seq lock."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from knowledge_plugin.db import lock_seq
from knowledge_plugin.model import NormalizedEntry, SourceConfig
from knowledge_plugin.normalize import prepare
from knowledge_plugin.registry import RegistryRow, sync_registry
from knowledge_plugin.store import store_entries

pytestmark = pytest.mark.db

NOW = datetime(2026, 9, 22, 8, 0, tzinfo=timezone.utc)
SOURCE = SourceConfig(id="src-a", name="Source A", homepage="https://a.example.org/", lane="evidence", source_type="journal",
                      access="rss", egress="direct", authority=3, safety_feed=False, owner_entity="A", launch_tier="P0",
                      language="en", region="US", poll_floor_s=3600, poll_ceiling_s=21600,
                      config={"url": "https://a.example.org/feed", "allowed_hosts": ["a.example.org"]})


async def seed(conn, *sources: SourceConfig):
    rows = [RegistryRow(source=s, enabled=True, disabled_reason=None, category="test", sha256="0" * 64) for s in sources]
    await sync_registry(conn, rows, NOW)


def item(key: str, **overrides):
    base = dict(external_key=key, url=f"https://a.example.org/{key}", title=f"Title {key}", summary="S" * 120,
                published_at=NOW - timedelta(days=1))
    base.update(overrides)
    return prepare(NormalizedEntry(**base), SOURCE)


async def all_entries(conn):
    return await (await conn.execute(
        "SELECT entry_id, external_key, seq, revision, backfill, published_at, date_precision, defects, first_seen_at "
        "FROM evimed_knowledge.entries ORDER BY seq")).fetchall()


async def test_insert_noop_and_revision(pool):
    async with pool.connection() as conn:
        await seed(conn, SOURCE)
        first = await store_entries(conn, SOURCE.id, [item("a"), item("b")], now=NOW, first_contact=False)
        assert (first.inserted, first.unchanged, first.revised) == (2, 0, 0)
        before = await all_entries(conn)
        again = await store_entries(conn, SOURCE.id, [item("a"), item("b")], now=NOW + timedelta(hours=1), first_contact=False)
        assert (again.inserted, again.unchanged) == (0, 2)
        assert await all_entries(conn) == before                                    # same content: nothing moves
        changed = await store_entries(conn, SOURCE.id, [item("a", summary="T" * 130)], now=NOW + timedelta(hours=2), first_contact=False)
        assert changed.revised == 1
        after = await all_entries(conn)
        revised = next(r for r in after if r["external_key"] == "a")
        assert revised["revision"] == 2
        assert revised["seq"] > max(r["seq"] for r in before)                        # a new seq, at the end
        assert revised["first_seen_at"] == NOW                                       # the first sighting stays
        seen = await (await conn.execute("SELECT revision FROM evimed_knowledge.seen_keys WHERE source_id = %s ORDER BY revision", (SOURCE.id,))).fetchall()
        assert [r["revision"] for r in seen] == [1, 2]


async def test_seq_is_strictly_increasing(pool):
    async with pool.connection() as conn:
        await seed(conn, SOURCE)
        for n in range(5):
            await store_entries(conn, SOURCE.id, [item(f"k{n}"), item(f"j{n}")], now=NOW, first_contact=False)
        seqs = [r["seq"] for r in await all_entries(conn)]
        assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs) == 10


async def test_first_contact_guard(pool):
    async with pool.connection() as conn:
        await seed(conn, SOURCE)
        result = await store_entries(conn, SOURCE.id, [
            item("recent", published_at=NOW - timedelta(days=2)),
            item("old", published_at=NOW - timedelta(days=30)),
            item("undated", published_at=None),
            item("mislabelled", published_at=NOW + timedelta(hours=8)),
        ], now=NOW, first_contact=True)
        assert (result.inserted, result.backfilled) == (2, 2)
        rows = {r["external_key"]: r for r in await all_entries(conn)}
        assert rows["old"]["backfill"] and rows["undated"]["backfill"]
        assert not rows["recent"]["backfill"] and not rows["mislabelled"]["backfill"]
        assert rows["mislabelled"]["published_at"] == NOW and rows["mislabelled"]["date_precision"] == "inferred"
        assert "future-date" in rows["mislabelled"]["defects"] and "no-date" in rows["undated"]["defects"]
        # after first contact nothing is backfill, whatever its date
        later = await store_entries(conn, SOURCE.id, [item("older-news", published_at=NOW - timedelta(days=90))],
                                    now=NOW + timedelta(hours=3), first_contact=False)
        assert later.inserted == 1


async def test_undated_items_stay_put_across_polls(pool):
    async with pool.connection() as conn:
        await seed(conn, SOURCE)
        await store_entries(conn, SOURCE.id, [item("u", published_at=None)], now=NOW, first_contact=False)
        again = await store_entries(conn, SOURCE.id, [item("u", published_at=None)], now=NOW + timedelta(days=1), first_contact=False)
        assert again.unchanged == 1
        row = (await all_entries(conn))[0]
        assert row["published_at"] == NOW and row["revision"] == 1


async def test_purged_entries_are_remembered_for_400_days(pool):
    async with pool.connection() as conn:
        await seed(conn, SOURCE)
        await store_entries(conn, SOURCE.id, [item("deep")], now=NOW, first_contact=False)
        await conn.execute("DELETE FROM evimed_knowledge.entries")                  # the 30-day purge
        same = await store_entries(conn, SOURCE.id, [item("deep")], now=NOW + timedelta(days=40), first_contact=False)
        assert same.unchanged == 1 and await all_entries(conn) == []                 # not re-sent
        changed = await store_entries(conn, SOURCE.id, [item("deep", title="Title deep (updated)")],
                                      now=NOW + timedelta(days=41), first_contact=False)
        assert changed.resurrected == 1
        row = (await all_entries(conn))[0]
        assert row["revision"] == 2 and row["first_seen_at"] == NOW                  # continues, never repeats (id, 1)


async def test_duplicates_within_one_page_are_stored_once(pool):
    async with pool.connection() as conn:
        await seed(conn, SOURCE)
        result = await store_entries(conn, SOURCE.id, [item("dup"), item("dup", title="Other title")], now=NOW, first_contact=False)
        assert result.seen == 1 and len(await all_entries(conn)) == 1


async def test_the_seq_lock_makes_commit_order_seq_order(pool):
    """A writer holding the seq lock blocks the next writer until it commits, so a consumer can never
    read seq n+1 while n is still invisible."""
    async with pool.connection() as setup:
        await seed(setup, SOURCE)
    release = asyncio.Event()
    order: list[str] = []

    async def slow_writer():
        async with pool.connection() as conn:
            async with conn.transaction():
                await lock_seq(conn)
                await conn.execute(
                    "INSERT INTO evimed_knowledge.meta (key, value) VALUES ('probe', '1'::jsonb)")
                await release.wait()
                order.append("slow-commit")

    async def fast_writer():
        async with pool.connection() as conn:
            result = await store_entries(conn, SOURCE.id, [item("fast")], now=NOW, first_contact=False)
            order.append("fast-commit")
            return result

    slow = asyncio.create_task(slow_writer())
    await asyncio.sleep(0.2)
    fast = asyncio.create_task(fast_writer())
    await asyncio.sleep(0.3)
    assert order == []                         # the fast writer waits on the lock
    release.set()
    await asyncio.gather(slow, fast)
    assert order == ["slow-commit", "fast-commit"]
