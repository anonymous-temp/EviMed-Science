"""``python -m knowledge_plugin [serve|migrate|check-registry]``.

``serve`` (the default and the image's command) opens the pool, applies the schema, syncs the
registry file into ``sources``, and — unless ``KNOWLEDGE_PLUGIN_CRAWL=0`` — starts the crawler in
the same process as the API (one image, one process; plan 14.5). ``migrate`` applies the schema
and exits; ``check-registry`` validates the registry file (and the adapters' view of each row)
and exits non-zero on a problem, without touching a database.
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
    from .registry import load_registry, sync_registry
    from .scheduler import Crawler

    rows = load_registry(settings.registry_path)
    pool = await create_pool(settings)
    async with pool.connection() as conn:
        await migrate(conn)
        await sync_registry(conn, rows, datetime.now(timezone.utc))
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
    print(f"unknown command {command!r}; use serve, migrate or check-registry", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
