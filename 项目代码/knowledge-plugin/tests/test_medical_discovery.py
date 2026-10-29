"""Medical subscription discovery uses the existing publisher's authority, never page instructions."""
from dataclasses import replace
from urllib.parse import urlunsplit

from knowledge_plugin.medical_discovery import advertised_feeds, feed_row, medical_rows, eligible_parents
from knowledge_plugin.registry import parse_registry


def parent_row(**changes):
    row = {"id": "clinical-journal", "name": "Clinical journal", "homepage": "https://www.example.org/journal",
           "lane": "evidence", "source_type": "journal", "access": "rss", "egress": "direct",
           "authority": 2, "safety_feed": False, "owner_entity": "clinical-publisher", "launch_tier": "P0",
           "language": "en", "region": None, "poll_floor_s": 21600, "poll_ceiling_s": 86400,
           "enabled": True, "disabled_reason": None, "category": "journal-specialty",
           "config": {"url": "https://www.example.org/current.xml", "allowed_hosts": ["www.example.org"], "max_pages": 1}}
    row.update(changes)
    return parse_registry({"sources": [row]})[0]


def test_only_explicit_same_origin_subscription_links_are_candidates():
    credential_url = urlunsplit(("https", ":".join(("fixture-user", "fixture-password")) + "@www.example.org", "/private", "", ""))
    html = f'''<base href="https://outside.example.net/">
      <link rel="alternate" type="application/rss+xml" title="Clinical updates" href="/updates.xml">
      <link rel="alternate" type="application/atom+xml" href="https://outside.example.net/feed">
      <link rel="alternate" type="application/rss+xml" href="{credential_url}">
      <link rel="alternate" type="application/rss+xml" href="http://www.example.org/insecure">
      <link rel="alternate" type="text/html" href="/article">
      <link rel="alternate" type="application/rss+xml" href="/updates.xml#fragment">'''.encode()
    candidates = advertised_feeds(html, "https://www.example.org/journal")
    assert len(candidates) == 1
    assert candidates[0]["url"] == "https://www.example.org/updates.xml"
    assert candidates[0]["access"] == "rss"


def test_discovered_rows_keep_medical_scope_and_do_not_inherit_api_exemption():
    parent = parent_row()
    candidate = feed_row(parent, {"url": "https://www.example.org/updates.xml", "name": "Updates", "access": "rss"})
    assert candidate["lane"] == "evidence"
    assert candidate["config"]["api"] is False
    assert candidate["config"]["same_origin_redirects"] is True
    assert candidate["config"]["medical_parent"] == parent.source.id
    accepted = medical_rows({"sources": [candidate]}, [parent], set())
    assert len(accepted) == 1
    assert not medical_rows({"sources": [candidate]}, [replace(parent, enabled=False)], set())
    assert not medical_rows({"sources": [candidate]}, [parent], {parent.source.id})
    assert not medical_rows({"sources": [candidate]}, [], set())


def test_existing_disabled_urls_and_excluded_publishers_cannot_return_under_new_ids():
    parent = parent_row()
    candidate = feed_row(parent, {"url": parent.source.config["url"], "name": "Duplicate", "access": "rss"})
    assert not medical_rows({"sources": [candidate]}, [parent], set())
    excluded = parent_row(id="excluded", enabled=False, disabled_reason="owner_excluded")
    candidate = feed_row(parent, {"url": "https://www.example.org/new.xml", "name": "New", "access": "rss"})
    assert not medical_rows({"sources": [candidate]}, [parent, excluded], set())
    assert not eligible_parents([parent, excluded], set())


def test_mixed_sources_and_browser_only_transport_are_not_silently_reclassified():
    assert not eligible_parents([parent_row(lane="mixed")], set())
    assert not eligible_parents([parent_row(egress="browser")], set())
    assert not eligible_parents([parent_row(category="journal-general")], set())


def test_same_publisher_candidates_are_not_counted_as_new_institutions():
    first = parent_row()
    second = parent_row(id="clinical-journal-two")
    assert len(eligible_parents([first, second], set())) == 1


async def test_daily_cycle_admits_real_parsed_feed_once_and_normal_poll_owns_first_entries(pool, settings, tmp_path):
    import json
    from dataclasses import asdict
    from datetime import datetime, timedelta, timezone
    from knowledge_plugin.medical_discovery import MEDICAL_STATUS, run_daily_discovery
    from knowledge_plugin.dynamic_registry import sync_dynamic_registry
    from knowledge_plugin.db import meta_get
    from knowledge_plugin.model import FetchResult
    from knowledge_plugin.scheduler import Crawler

    parent = parent_row()
    raw = {**asdict(parent.source), "enabled": True, "disabled_reason": None, "category": parent.category}
    registry = tmp_path / "registry.json"
    registry.write_text(json.dumps({"sources": [raw]}))
    configured = replace(settings, registry_path=str(registry))
    now = datetime(2026, 10, 19, 8, tzinfo=timezone.utc)
    feed_bytes = b'''<?xml version="1.0"?><rss version="2.0"><channel><title>Clinical journal</title>
      <item><title>Synthetic clinical discovery fixture</title><link>https://www.example.org/paper</link>
      <guid>synthetic-discovery-paper</guid><pubDate>Mon, 19 Oct 2026 07:00:00 GMT</pubDate>
      <description>A synthetic source-discovery test article, not clinical evidence.</description></item></channel></rss>'''

    class Fetcher:
        def __init__(self): self.calls = []
        async def fetch(self, spec, **kwargs):
            self.calls.append((spec, kwargs))
            assert spec.api is False and spec.same_origin_redirects is True
            body = b'<html><head><link rel="alternate" type="application/rss+xml" href="/updates.xml"></head></html>' if spec.url.endswith("/journal") else feed_bytes
            return FetchResult(request=spec, final_url=spec.url, status=200, headers={"content-type": "application/rss+xml"}, body=body, fetched_at=now)

    fetcher = Fetcher()
    async with pool.connection() as conn:
        await sync_dynamic_registry(conn, [parent], now)
    report = await run_daily_discovery(configured, pool, fetcher, lambda: now)
    assert report["status"] == "complete" and report["admittedFeeds"] == 1 and report["newInstitutions"] == 0
    calls = len(fetcher.calls)
    assert (await run_daily_discovery(configured, pool, fetcher, lambda: now))["status"] == "already_checked"
    assert len(fetcher.calls) == calls
    async with pool.connection() as conn:
        status = await meta_get(conn, MEDICAL_STATUS)
        assert status["last"]["admittedFeeds"] == 1 and len(status["history"]) == 1
        assert (await (await conn.execute("SELECT count(*) n FROM evimed_knowledge.entries")).fetchone())["n"] == 0
        await conn.execute("UPDATE evimed_knowledge.sources SET next_poll_at=%s WHERE id=%s", (now + timedelta(days=1), parent.source.id))
    crawler = Crawler(configured, pool, fetcher, clock=lambda: now, enricher=lambda *args: None)
    polled = await crawler.run_due(limit=1)
    assert len(polled) == 1 and polled[0].outcome == "ok"
    async with pool.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM evimed_knowledge.entries")).fetchone())["n"] == 1
        assert (await (await conn.execute("SELECT last_ok_at FROM evimed_knowledge.sources WHERE id LIKE 'medical-discovery-%'")).fetchone())["last_ok_at"] is not None


async def test_robots_refusal_is_recorded_without_admitting_or_publishing_a_source(pool, settings, tmp_path):
    import json
    from dataclasses import asdict
    from datetime import datetime, timezone
    from knowledge_plugin.medical_discovery import run_daily_discovery
    from knowledge_plugin.model import FetchError

    parent = parent_row()
    registry = tmp_path / "registry.json"
    registry.write_text(json.dumps({"sources": [{**asdict(parent.source), "enabled": True, "disabled_reason": None, "category": parent.category}]}))
    class Denied:
        async def fetch(self, *_args, **_kwargs): raise FetchError("robots-denied", "robots_disallow")
    report = await run_daily_discovery(replace(settings, registry_path=str(registry)), pool, Denied(), lambda: datetime(2026, 10, 19, 8, tzinfo=timezone.utc))
    assert report["admittedFeeds"] == 0
    assert report["items"] == [{"parent": parent.source.id, "status": "deferred", "reason": "robots-denied:robots_disallow"}]


def test_parent_metadata_changes_refresh_inherited_fields_without_accepting_child_overrides():
    parent = parent_row()
    child = feed_row(parent, {"url": "https://www.example.org/new.xml", "access": "rss"})
    child["authority"] = 5
    child["config"]["api"] = True
    changed = parent_row(authority=3, language="zh", poll_floor_s=43200)
    rows = medical_rows({"sources": [child]}, [changed], set())
    assert len(rows) == 1
    assert rows[0].source.authority == 3 and rows[0].source.language == "zh"
    assert rows[0].source.poll_floor_s == 43200
    assert rows[0].source.config["api"] is False
    assert rows[0].source.config["same_origin_redirects"] is True
    forged = {**child, "id": "unrelated-source"}
    assert not medical_rows({"sources": [forged]}, [changed], set())


async def test_completed_day_still_reconciles_revocation_and_claim_never_polls_disabled_parent(pool, settings, tmp_path):
    import json
    from dataclasses import asdict
    from datetime import datetime, timezone
    from knowledge_plugin.db import meta_set
    from knowledge_plugin.dynamic_registry import sync_dynamic_registry
    from knowledge_plugin.medical_discovery import MEDICAL_META, MEDICAL_STATUS, run_daily_discovery
    from knowledge_plugin.scheduler import Crawler

    parent = parent_row()
    child = feed_row(parent, {"url": "https://www.example.org/new.xml", "access": "rss"})
    now = datetime(2026, 10, 19, 8, tzinfo=timezone.utc)
    registry = tmp_path / "registry.json"
    registry.write_text(json.dumps({"sources": [{**asdict(parent.source), "enabled": True, "disabled_reason": None, "category": parent.category}]}))
    configured = replace(settings, registry_path=str(registry))
    async with pool.connection() as conn:
        await meta_set(conn, MEDICAL_META, {"sources": [child]})
        await sync_dynamic_registry(conn, [parent], now)
        await meta_set(conn, MEDICAL_STATUS, {"completedDay": "2026-10-19"})
        await conn.execute("UPDATE evimed_knowledge.sources SET operator_enabled=false WHERE id=%s", (parent.source.id,))
    crawler = Crawler(configured, pool, None, clock=lambda: now, enricher=lambda *args: None)
    assert await crawler.claim(10) == [], "revocation applies before the hourly reconciler runs"
    report = await run_daily_discovery(configured, pool, None, lambda: now)
    assert report["status"] == "already_checked"
    async with pool.connection() as conn:
        row = await (await conn.execute("SELECT retired_at FROM evimed_knowledge.sources WHERE id=%s", (child["id"],))).fetchone()
        assert row["retired_at"] is not None


async def test_retired_children_release_capacity_before_new_valid_feeds_are_admitted(pool, settings, tmp_path, monkeypatch):
    import json
    from dataclasses import asdict
    from datetime import datetime, timezone
    import knowledge_plugin.medical_discovery as discovery
    from knowledge_plugin.db import meta_set, meta_get
    from knowledge_plugin.dynamic_registry import sync_dynamic_registry

    parent = parent_row()
    revoked = parent_row(id="revoked-parent")
    old = [feed_row(revoked, {"url": f"https://www.example.org/old-{index}.xml", "access": "rss"}) for index in range(discovery.MAX_ADMITTED)]
    new = feed_row(parent, {"url": "https://www.example.org/new.xml", "access": "rss"})
    now = datetime(2026, 10, 19, 8, tzinfo=timezone.utc)
    registry = tmp_path / "registry.json"
    registry.write_text(json.dumps({"sources": [{**asdict(parent.source), "enabled": True, "disabled_reason": None, "category": parent.category}]}))
    async with pool.connection() as conn:
        await meta_set(conn, discovery.MEDICAL_META, {"sources": old})
        await sync_dynamic_registry(conn, [parent, revoked], now)
    async def probe(*_args): return [new], [{"status": "validated", "source": new["id"]}]
    monkeypatch.setattr(discovery, "discover_parent", probe)
    report = await discovery.run_daily_discovery(replace(settings, registry_path=str(registry)), pool, None, lambda: now)
    assert report["admittedFeeds"] == 1 and report["capacityDeferred"] == 0
    async with pool.connection() as conn:
        document = await meta_get(conn, discovery.MEDICAL_META)
        assert [row["id"] for row in document["sources"]] == [new["id"]]
        retired = await (await conn.execute("SELECT count(*) n FROM evimed_knowledge.sources WHERE retired_at IS NOT NULL")).fetchone()
        assert retired["n"] >= len(old), "historical source and article identities remain available"


async def test_waiting_discovery_reads_registry_after_the_newer_revocation_commits(pool, settings, tmp_path, monkeypatch):
    import asyncio
    import json
    from dataclasses import asdict
    from datetime import datetime, timezone
    from knowledge_plugin.db import meta_set
    import knowledge_plugin.dynamic_registry as dynamic
    from knowledge_plugin.medical_discovery import MEDICAL_META, MEDICAL_STATUS, run_daily_discovery

    now = datetime(2026, 10, 19, 8, tzinfo=timezone.utc)
    parent = parent_row()
    child = feed_row(parent, {"url": "https://www.example.org/new.xml", "access": "rss"})
    registry = tmp_path / "registry.json"
    def write(row):
        registry.write_text(json.dumps({"sources": [{**asdict(row.source), "enabled": row.enabled,
            "disabled_reason": row.disabled_reason, "category": row.category}]}))
    write(parent)
    async with pool.connection() as conn:
        await meta_set(conn, MEDICAL_META, {"sources": [child]})
        await dynamic.sync_dynamic_registry(conn, [parent], now)
        await meta_set(conn, MEDICAL_STATUS, {"completedDay": "2026-10-19"})
    waiting, release = asyncio.Event(), asyncio.Event()
    original_lock = dynamic.lock_registry
    target = None
    async def intercepted_lock(conn):
        if asyncio.current_task() is target and not release.is_set():
            waiting.set()
            await release.wait()
        await original_lock(conn)
    monkeypatch.setattr(dynamic, "lock_registry", intercepted_lock)
    target = asyncio.create_task(run_daily_discovery(replace(settings, registry_path=str(registry)), pool, None, lambda: now))
    try:
        await asyncio.wait_for(waiting.wait(), 2)
        revoked = replace(parent, enabled=False, disabled_reason="owner_excluded")
        write(revoked)
        async with pool.connection() as conn:
            await dynamic.sync_dynamic_registry(conn, [revoked], now)
        release.set()
        assert (await target)["status"] == "already_checked"
        async with pool.connection() as conn:
            rows = await (await conn.execute("SELECT id,enabled,retired_at FROM evimed_knowledge.sources")).fetchall()
        assert not next(row for row in rows if row["id"] == parent.source.id)["enabled"]
        assert next(row for row in rows if row["id"] == child["id"])["retired_at"] is not None
    finally:
        release.set()
        if not target.done():
            target.cancel()
        await asyncio.gather(target, return_exceptions=True)
