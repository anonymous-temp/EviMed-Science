"""``python -m knowledge_plugin [serve|migrate|check-registry|lifecycle|discover|wechat-bodies]``.

``serve`` (the default and the image's command) opens the pool, applies the schema, syncs the
registry file into ``sources``, and — unless ``KNOWLEDGE_PLUGIN_CRAWL=0`` — starts the crawler in
the same process as the API (one image, one process; plan 14.5). ``migrate`` applies the schema
and exits; ``check-registry`` validates the registry file (and the adapters' view of each row)
and exits non-zero on a problem, without touching a database.

``lifecycle`` prints, one JSON line each, the sources the lifecycle rules would retire now and why, and a last line
with the counts by reason; it writes nothing (``lifecycle --apply`` retires them and syncs the registry, what the
hourly discovery run does once a day). ``discover`` runs the discovery cycle once in the foreground and prints its
report (``--lines journal,directory`` limits the gathering; ``--caps line=n,…`` overrides the day's caps).

``wechat-bodies`` prints, one JSON line each, the WeChat articles answered ``unavailable`` without their text in the last
``--days`` (default 7) and a last line with the count and what buying them would cost; it writes nothing and calls nobody.
``wechat-bodies --apply`` buys them through Dajiala within the day's cap and delivers each recovered entry again
(``social.lost_bodies``).
"""

from __future__ import annotations

import asyncio
import logging
import sys

from .settings import Settings, SettingsError

log = logging.getLogger("knowledge_plugin")


def configure_logging(level: str) -> None:
    logging.basicConfig(level=getattr(logging, level, logging.INFO),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s", stream=sys.stdout)
    # httpx logs every request URL at INFO — with the query string, where per-host credentials live.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


async def _startup(settings: Settings, state: dict) -> None:
    from datetime import datetime, timezone

    from .budget import HostBudget, PgCounterStore, host_rules
    from .db import create_pool, migrate
    from .fetch import ProtectedFetcher
    from .registry import load_registry
    from .dynamic_registry import sync_dynamic_registry
    from .scheduler import Crawler

    pool = await create_pool(settings)
    async with pool.connection() as conn:
        await migrate(conn)
        await sync_dynamic_registry(conn, lambda: load_registry(settings.registry_path), datetime.now(timezone.utc))
    budget = HostBudget(PgCounterStore(pool), host_rules(ncbi_key=settings.has_ncbi_key(), openfda_key=settings.has_openfda_key()))
    await budget.load()
    fetcher = ProtectedFetcher(settings, budget)
    state.update(pool=pool, fetcher=fetcher)
    if not settings.contact_email():
        log.warning("no contact address configured: the User-Agent carries no mailto (set KNOWLEDGE_PLUGIN_CONTACT_EMAIL[_FILE])")
    if settings.crawl_enabled:
        crawler = Crawler(settings, pool, fetcher)
        await crawler.start()
        state["crawler"] = crawler
    else:
        log.info("crawler disabled (KNOWLEDGE_PLUGIN_CRAWL=0): serving the stored stream only")


async def _shutdown(state: dict) -> None:
    crawler = state.get("crawler")
    if crawler is not None:
        await crawler.stop()
    fetcher = state.get("fetcher")
    if fetcher is not None:
        await fetcher.aclose()
    pool = state.get("pool")
    if pool is not None:
        await pool.close()


def serve(settings: Settings) -> None:
    import uvicorn

    from .api import create_app

    app = create_app(settings, lifespan_hooks={
        "startup": lambda state: _startup(settings, state),
        "shutdown": _shutdown,
    })
    uvicorn.run(app, host=settings.host, port=settings.port, log_level=settings.log_level.lower(),
                access_log=False, proxy_headers=False, server_header=False)


async def _migrate(settings: Settings) -> None:
    from .db import create_pool, migrate

    pool = await create_pool(settings)
    try:
        async with pool.connection() as conn:
            await migrate(conn)
    finally:
        await pool.close()


async def _lifecycle(settings: Settings, apply: bool) -> int:
    import json
    from collections import Counter
    from datetime import datetime, timezone

    from .db import create_pool
    from .lifecycle import retirement_plan
    from .registry import load_registry

    pool = await create_pool(settings)
    try:
        now = datetime.now(timezone.utc)
        curated = {row.source.id for row in load_registry(settings.registry_path)}
        if apply:
            from .discovery import apply_retirements, shanghai_day
            from .dynamic_registry import sync_dynamic_registry
            async with pool.connection() as conn:
                async with conn.transaction():
                    plan = await apply_retirements(conn, now, shanghai_day(now), curated)
                    await sync_dynamic_registry(conn, lambda: load_registry(settings.registry_path), now)
            for item in plan:
                print(json.dumps(item, ensure_ascii=False))
            print(json.dumps({"applied": len(plan), "by_reason": dict(Counter(i["reason"] for i in plan))}))
            return 0
        async with pool.connection() as conn:
            plan = await retirement_plan(conn, now, curated)
        for decision in plan:
            print(json.dumps({"source_id": decision.source_id, "reason": decision.reason,
                              "registry_row": decision.source_id in curated, "evidence": decision.evidence},
                             ensure_ascii=False, default=str))
        print(json.dumps({"would_retire": len(plan), "by_reason": dict(Counter(d.reason for d in plan))}))
        return 0
    finally:
        await pool.close()


async def _discover(settings: Settings, lines: list[str] | None, caps: str | None) -> int:
    import json
    from datetime import datetime, timezone

    from .budget import HostBudget, PgCounterStore, host_rules
    from .db import create_pool
    from .discovery import parse_caps, run_discovery
    from .fetch import ProtectedFetcher

    pool = await create_pool(settings)
    budget = HostBudget(PgCounterStore(pool), host_rules(ncbi_key=settings.has_ncbi_key(), openfda_key=settings.has_openfda_key()))
    await budget.load()
    fetcher = ProtectedFetcher(settings, budget)
    try:
        report = await run_discovery(settings, pool, fetcher, lambda: datetime.now(timezone.utc),
                                     caps=parse_caps(caps if caps is not None else settings.discovery_caps),
                                     outbound_pages=settings.discovery_outbound_pages, gather_lines=lines)
        print(json.dumps(report, ensure_ascii=False, default=str, indent=1))
        return 0
    finally:
        await fetcher.aclose()
        await pool.close()


async def _wechat_bodies(settings: Settings, days: int, apply: bool) -> int:
    import json
    from datetime import datetime, timezone

    from .budget import HostBudget, PgCounterStore, host_rules
    from .db import create_pool
    from .fetch import ProtectedFetcher
    from .social import lost_bodies
    from .social.collector import SocialCollector

    def clock():
        return datetime.now(timezone.utc)

    pool = await create_pool(settings)
    budget = HostBudget(PgCounterStore(pool), host_rules(ncbi_key=settings.has_ncbi_key(), openfda_key=settings.has_openfda_key()))
    await budget.load()
    fetcher = ProtectedFetcher(settings, budget)
    try:
        collector = SocialCollector(settings, pool, fetcher, clock=clock)
        if apply:
            outcome = await lost_bodies.apply(collector, pool, clock, days=days)
        else:
            outcome = await lost_bodies.report(collector, pool, clock(), days=days)
        for line in outcome["entries"]:
            print(json.dumps(line, ensure_ascii=False, default=str))
        print(json.dumps(outcome["summary"], ensure_ascii=False, default=str))
        return 0
    finally:
        await fetcher.aclose()
        await pool.close()


def check_registry(path: str) -> int:
    from .registry import RegistryError, load_registry

    try:
        rows = load_registry(path)
    except RegistryError as error:
        for problem in error.problems:
            print(problem, file=sys.stderr)
        return 1
    problems: list[str] = []
    later = 0
    try:
        from .adapters import validate_config
    except ImportError:
        validate_config = None
    if validate_config is not None:
        for row in rows:
            found = [f"{row.source.id}: {p}" for p in validate_config(row.source)]
            if row.enabled:
                problems += found
            else:
                later += len(found)      # disabled rows: configured when their batch comes
    for problem in problems:
        print(problem, file=sys.stderr)
    print(f"{len(rows)} sources, {sum(r.enabled for r in rows)} enabled, {len(problems)} adapter config problem(s) "
          f"on enabled rows, {later} on disabled rows (not polled)")
    return 1 if problems else 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    command = argv[0] if argv else "serve"
    if command == "check-registry":
        from .settings import PROJECT_ROOT
        import os
        path = argv[1] if len(argv) > 1 else os.environ.get("KNOWLEDGE_PLUGIN_REGISTRY") or str(PROJECT_ROOT / "registry" / "sources.json")
        return check_registry(path)
    try:
        settings = Settings.from_env()
    except SettingsError as error:
        print(f"configuration error: {error}", file=sys.stderr)
        return 2
    configure_logging(settings.log_level)
    if command == "serve":
        serve(settings)
        return 0
    if command == "migrate":
        asyncio.run(_migrate(settings))
        return 0
    if command == "lifecycle":
        return asyncio.run(_lifecycle(settings, apply="--apply" in argv[1:]))
    if command == "discover":
        lines = caps = None
        for flag, value in zip(argv[1:], argv[2:]):
            if flag == "--lines":
                lines = [line.strip() for line in value.split(",") if line.strip()]
            elif flag == "--caps":
                caps = value
        return asyncio.run(_discover(settings, lines, caps))
    if command == "wechat-bodies":
        days = 7
        for flag, value in zip(argv[1:], argv[2:]):
            if flag == "--days":
                if not (value.isdigit() and 1 <= int(value) <= 30):
                    print("--days takes a whole number of days from 1 to 30", file=sys.stderr)
                    return 2
                days = int(value)
        return asyncio.run(_wechat_bodies(settings, days, apply="--apply" in argv[1:]))
    print(f"unknown command {command!r}; use serve, migrate, check-registry, lifecycle, discover or wechat-bodies",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
