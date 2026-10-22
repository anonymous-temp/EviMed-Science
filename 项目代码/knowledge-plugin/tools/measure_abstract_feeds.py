#!/usr/bin/env python3
"""Measure the publisher feeds the paper text chain reads (``config.abstract_feed``), or candidate ones (rt-papers).

For each feed, through the plugin's own fetcher (the honest identity, robots.txt, host spacing; nothing stored): the
answer, the number of items, how many of the last 20 carry a text the feed step would take (``feeds.feed_text``'s rule:
ends as a sentence, at least 60 characters), the median length of those texts, how many are abstracts (≥ 200
characters, not cut) rather than excerpts, and how many items can be matched to an entry (a DOI, a HighWire master id,
or the link's last segment). One JSON line a feed.

    python tools/measure_abstract_feeds.py                       # every row of registry/sources.json naming a feed
    python tools/measure_abstract_feeds.py --candidates feeds.tsv # "<label>\\t<url>" lines, not in the registry yet

Inside the plugin container: ``docker exec -i evimed-knowledge-plugin python -c "$(cat tools/measure_abstract_feeds.py)"``
(the image does not ship ``tools/``).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
from pathlib import Path

if "__file__" in globals():
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from knowledge_plugin.adapters.common import looks_truncated  # noqa: E402
from knowledge_plugin.budget import HostBudget, MemoryCounterStore, host_rules  # noqa: E402
from knowledge_plugin.enrich import feeds  # noqa: E402
from knowledge_plugin.enrich.article_html import ABSTRACT_MAX, ABSTRACT_MIN  # noqa: E402
from knowledge_plugin.enrich.common import Trace  # noqa: E402
from knowledge_plugin.fetch import ProtectedFetcher  # noqa: E402
from knowledge_plugin.registry import load_registry  # noqa: E402
from knowledge_plugin.settings import Settings  # noqa: E402

LAST = 20


def configured(settings: Settings) -> list[tuple[str, str]]:
    out = []
    for row in load_registry(settings.registry_path):
        for url in feeds.feed_urls(row.source.config):
            out.append((row.source.id, url))
    return out


def measure_items(items: list[feeds.FeedItem]) -> dict:
    last = items[:LAST]
    texts = [item.text for item in last if len(item.text) >= feeds.EXCERPT_MIN
             and item.text.rstrip().endswith(feeds.SENTENCE_ENDS)]
    abstracts = [t for t in texts if ABSTRACT_MIN <= len(t) <= ABSTRACT_MAX and not looks_truncated(t)]
    matchable = [item for item in last if item.dois or item.ids or item.tail]
    return {"items": len(items), "last": len(last), "with_text": len(texts),
            "median_chars": int(statistics.median([len(t) for t in texts])) if texts else 0,
            "abstracts": len(abstracts), "matchable": len(matchable),
            "sample": (texts[0][:160] if texts else None)}


async def run(pairs: list[tuple[str, str]], settings: Settings) -> None:
    budget = HostBudget(MemoryCounterStore(), host_rules(ncbi_key=False, openfda_key=False))
    fetcher = ProtectedFetcher(settings, budget)
    cache = feeds.FeedCache()
    try:
        for label, url in pairs:
            trace = Trace()
            items = await feeds.read_feed(fetcher, url, source_id=None, egress="direct", trace=trace, cache=cache)
            line = {"row": label, "url": url}
            line.update(measure_items(items) if items is not None else {"error": ",".join(trace.notes)})
            print(json.dumps(line, ensure_ascii=False), flush=True)
    finally:
        await fetcher.aclose()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="measure_abstract_feeds", description=__doc__.split("\n\n")[0])
    parser.add_argument("--candidates", default=None, help="a TSV of <label>\\t<url> lines instead of the registry; - for stdin")
    args = parser.parse_args(argv)
    settings = Settings.from_env({"KNOWLEDGE_PLUGIN_DATABASE_URL": "postgresql://unused.invalid/none",
                                  **{k: v for k, v in os.environ.items() if k.startswith("KNOWLEDGE_PLUGIN_")}})
    if args.candidates:
        text = sys.stdin.read() if args.candidates == "-" else Path(args.candidates).read_text(encoding="utf-8")
        pairs = [tuple(line.split("\t")[:2]) for line in text.splitlines() if line.strip() and not line.startswith("#")]
    else:
        pairs = configured(settings)
    asyncio.run(run(pairs, settings))
    return 0


if __name__ == "__main__":
    sys.exit(main())
