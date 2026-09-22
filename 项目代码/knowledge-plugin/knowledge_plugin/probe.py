"""``python -m knowledge_plugin.probe``: read enabled sources once through their own exit, store nothing.

For the checks that can only be made where an exit works — the Tokyo relay admits the Beijing host
alone, and the regulators answer the browser from Beijing — this runs, inside the plugin container,
exactly what a poll does up to parsing: the source's adapter plans, the protected fetch sends the
first request through the source's egress (robots, budget spacing, pinning, credentials as usual),
the adapter parses. One JSON line per source: outcome, HTTP status, bytes, entries parsed, seconds.
Nothing is written to the database; the day's budget is counted in memory only, so keep the
selection small (``--egress relay`` is 33 requests).

    docker exec evimed-knowledge-plugin python -m knowledge_plugin.probe --egress relay
    python -m knowledge_plugin.probe --source fda-press-announcements --source nmpa-ggtg
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from datetime import datetime, timezone

from .budget import HostBudget, MemoryCounterStore, host_rules
from .fetch import ProtectedFetcher
from .model import FetchError, SourceState
from .registry import load_registry
from .settings import Settings, SettingsError


async def probe(settings: Settings, *, egress: str | None, source_ids: list[str], limit: int, out=sys.stdout) -> int:
    from .adapters import REGISTRY as adapters

    rows = [r for r in load_registry(settings.registry_path)
            if (r.source.id in source_ids) or (not source_ids and r.enabled and (egress in (None, "all") or r.source.egress == egress))]
    budget = HostBudget(MemoryCounterStore(), host_rules(ncbi_key=settings.has_ncbi_key(), openfda_key=settings.has_openfda_key()))
    fetcher = ProtectedFetcher(settings, budget)
    failures = 0
    try:
        for row in rows[:limit]:
            source = row.source
            line = {"id": source.id, "egress": source.egress, "access": source.access}
            started = time.monotonic()
            adapter = adapters.get(source.access)
            try:
                if adapter is None:
                    raise FetchError("blocked", "adapter_unavailable")
                now = datetime.now(timezone.utc)
                specs = adapter.plan(source, SourceState(None, None, None, None, None, {}), now)
                if not specs:
                    raise FetchError("empty", "nothing_planned")
                wait_for = None
                if source.egress == "browser":
                    wait_for = source.config.get("wait_for") or (source.config.get("selectors") or {}).get("item")
                    wait_for = wait_for.split("@", 1)[0].strip() if wait_for else None
                extra = {"wait_for": wait_for} if wait_for else {}
                result = await fetcher.fetch(specs[0], source_id=source.id, egress=source.egress,
                                             allowed_hosts=source.config.get("allowed_hosts"), **extra)
                output = adapter.parse(result, source, now)
                line.update(outcome="ok" if output.entries or output.next else "empty", status=result.status,
                            bytes=len(result.body), entries=len(output.entries), chained=output.next is not None)
            except FetchError as error:
                failures += 1
                line.update(outcome=error.outcome, detail=error.detail, status=error.status)
            line["seconds"] = round(time.monotonic() - started, 2)
            print(json.dumps(line, ensure_ascii=False), file=out, flush=True)
    finally:
        await fetcher.aclose()
    return 1 if failures and failures == len(rows[:limit]) else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m knowledge_plugin.probe", description=__doc__.split("\n\n")[0])
    parser.add_argument("--egress", choices=["direct", "api", "relay", "browser", "all"], default=None)
    parser.add_argument("--source", action="append", default=[], help="a source id (repeatable); overrides --egress")
    parser.add_argument("--limit", type=int, default=60)
    args = parser.parse_args(argv)
    if not args.source and not args.egress:
        parser.error("name --egress or at least one --source")
    try:
        settings = Settings.from_env()
    except SettingsError as error:
        print(f"configuration error: {error}", file=sys.stderr)
        return 2
    return asyncio.run(probe(settings, egress=args.egress, source_ids=args.source, limit=max(1, args.limit)))


if __name__ == "__main__":
    sys.exit(main())
