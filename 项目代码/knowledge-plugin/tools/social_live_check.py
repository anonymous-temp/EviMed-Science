#!/usr/bin/env python3
"""One live pass of the three social adapters into a scratch database (fr-social, 2026-10-22).

Through the plugin's own code — the collector, the providers, the media store, the store — against the real upstreams:

- X: one shard search over the accounts named by ``--x`` (their rows from ``registry/social-sources.json``), their posts
  stored with media;
- WeChat: the accounts named by ``--wechat`` re-resolved from their verified links (``article_detail``, ¥0.03 each), the
  first of them read once (``post_history``, ¥0.14) with at most ``--wechat-bodies`` bodies bought;
- six platforms: one search (``--crawl-term`` on ``--crawl-platform``) when ``--crawl-url`` is given.

Output is status lines only — counts, outcomes, field names, the ledger's spend — never a key and never a post's text.
The database must be a scratch one (its name starts with ``evimed_test_``); the schema is applied, the rows synced.

    python tools/social_live_check.py --database-url postgresql://postgres@127.0.0.1:55670/evimed_test_social_live \\
        --socialdata-key-file <path> --dajiala-key-file <path> --media-dir /tmp/media \\
        --x NEJM --x statnews --wechat wx-nejm --crawl-url http://<crawler> --crawl-platform zhihu --crawl-term 司美格鲁肽
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from knowledge_plugin.budget import HostBudget, PgCounterStore, host_rules  # noqa: E402
from knowledge_plugin.db import create_pool, migrate  # noqa: E402
from knowledge_plugin.fetch import ProtectedFetcher  # noqa: E402
from knowledge_plugin.registry import sync_registry  # noqa: E402
from knowledge_plugin.settings import Settings  # noqa: E402
from knowledge_plugin.social import x as x_mod  # noqa: E402
from knowledge_plugin.social.collector import SocialCollector  # noqa: E402
from knowledge_plugin.social.registry import load_social_registry  # noqa: E402


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--socialdata-key-file")
    parser.add_argument("--dajiala-key-file")
    parser.add_argument("--media-dir")
    parser.add_argument("--x", action="append", default=[])
    parser.add_argument("--wechat", action="append", default=[])
    parser.add_argument("--wechat-bodies", type=int, default=1)
    parser.add_argument("--crawl-url")
    parser.add_argument("--crawl-platform", default="zhihu")
    parser.add_argument("--crawl-term", default="司美格鲁肽")
    args = parser.parse_args()
    if "/evimed_test_" not in args.database_url:
        print("refused: the database must be a scratch one (evimed_test_*)")
        return 2
    settings = Settings(database_url=args.database_url, socialdata_key_file=args.socialdata_key_file,
                        dajiala_key_file=args.dajiala_key_file, media_dir=args.media_dir,
                        social_crawl_url=(args.crawl_url or "").rstrip("/") or None, socialdata_daily_usd=1.0,
                        dajiala_daily_cny=1.0, social_crawl_daily=10)
    rows = {row.source.id: row for row in load_social_registry(ROOT / "registry" / "social-sources.json")}
    wanted = [rows[f"x-{handle.lower()}"] for handle in args.x] + [rows[source_id] for source_id in args.wechat]
    if args.crawl_url:
        wanted += [row for row in rows.values() if (row.source.config or {}).get("crawl_platform") == args.crawl_platform]
    pool = await create_pool(settings)
    fetcher = ProtectedFetcher(settings, HostBudget(PgCounterStore(pool), host_rules(ncbi_key=False, openfda_key=False)))
    now = datetime.now(timezone.utc)
    try:
        async with pool.connection() as conn:
            await migrate(conn)
            await sync_registry(conn, wanted, now)
        collector = SocialCollector(settings, pool, fetcher)
        collector.wechat_bodies_per_read = args.wechat_bodies
        if args.x:
            print("x:", await collector.run_x(datetime.now(timezone.utc)))
        if args.wechat:
            sources = await collector._rows("dajiala")
            by_id = {row["id"]: row for row in sources}
            for source_id in args.wechat:
                outcome, resolved = await collector.wechat_resolve(by_id[source_id], datetime.now(timezone.utc))
                print(f"wechat resolve {source_id}: {outcome}"
                      + (f" (nickname matches, ghid {'named' if resolved.get('ghid') else 'absent'}, alias "
                         f"{'named' if resolved.get('alias') else 'absent'})" if resolved else ""))
                if resolved:
                    async with pool.connection() as conn:
                        await conn.execute("UPDATE evimed_knowledge.sources SET cursor = cursor || %s::jsonb WHERE id = %s",
                                           (json.dumps({"resolved": resolved}), source_id))
            first = (await collector._rows("dajiala"))
            first = next(row for row in first if row["id"] == args.wechat[0])
            print(f"wechat read {first['id']}:", await collector._wechat_account(first, datetime.now(timezone.utc)))
        if args.crawl_url:
            print("crawl:", await collector.run_crawl(datetime.now(timezone.utc)))
        async with pool.connection() as conn:
            for row in await (await conn.execute(
                    """SELECT e.source_id, count(*) AS entries, count(*) FILTER (WHERE e.media <> '[]'::jsonb) AS with_media,
                              count(*) FILTER (WHERE e.quoted IS NOT NULL) AS with_quote,
                              count(*) FILTER (WHERE t.body_text IS NOT NULL) AS with_body,
                              count(*) FILTER (WHERE e.author IS NOT NULL) AS with_author,
                              count(*) FILTER (WHERE e.metrics IS NOT NULL) AS with_metrics
                         FROM evimed_knowledge.entries e LEFT JOIN evimed_knowledge.entry_texts t USING (entry_id)
                        GROUP BY e.source_id ORDER BY e.source_id""")).fetchall():
                print("stored", dict(row))
            for row in await (await conn.execute(
                    "SELECT id, health, last_error_code FROM evimed_knowledge.sources ORDER BY id")).fetchall():
                print("source", dict(row))
            media = await (await conn.execute(
                "SELECT count(*) AS stored, coalesce(sum(bytes), 0) AS bytes, max(bytes) AS largest FROM evimed_knowledge.media")).fetchone()
            print("media", dict(media), "failures",
                  [dict(r) for r in await (await conn.execute("SELECT reason, count(*) AS n FROM evimed_knowledge.media_failures GROUP BY reason")).fetchall()])
            for row in await (await conn.execute(
                    """SELECT provider, purpose, outcome, count(*) AS calls, sum(objects) AS objects, round(sum(amount), 4) AS amount,
                              min(currency) AS currency, min(remaining) AS remaining
                         FROM evimed_knowledge.provider_calls GROUP BY provider, purpose, outcome ORDER BY provider, purpose""")).fetchall():
                print("spend", {key: (float(value) if hasattr(value, "as_tuple") else value) for key, value in dict(row).items()})
        print("shards that would read these accounts:", [(s.mode, len(s.members)) for s in x_mod.plan_shards(
            [{"id": r.source.id, "config": r.source.config, "cursor": {}} for r in rows.values() if r.source.access == "socialdata"])])
    finally:
        await fetcher.aclose()
        await pool.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
