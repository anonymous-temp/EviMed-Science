#!/usr/bin/env python3
"""Run the paper text chain on a list of DOIs, read-only, and say which step answered each (rt-papers, 2026-10-22).

For the before → after of the journal text gap: every DOI goes through ``knowledge_plugin.enrich.enrich_batch`` exactly
as the text worker runs it — PubMed, Europe PMC, Crossref, Unpaywall, OpenAlex, the journal's feeds, the landing page
through the exit ladder, Europe PMC's full text — with the plugin's own protected fetcher (robots.txt, host spacing,
pinned addresses, the deployment's exits and credentials). Nothing is written: the host budget is counted in this
process's memory, no database is opened, no entry is stored.

Input: one DOI a line, optionally ``doi|source_id`` (the registry row whose exit and ``abstract_feed`` the entry would
have; the controller's ``missing-dois.txt`` has that form). Output: one JSON line per DOI — ``status``, ``text_kind``,
``fetched_from`` (the step whose text answered), the characters of ``abstract`` / ``body_excerpt`` / ``body_text``, the
open-access facts and the step notes — then one ``summary`` line: counts by answering step and kind, and coverage per
DOI prefix (publisher) before (none of these DOIs had a text) and after.

Inside the plugin container (the image does not ship ``tools/``)::

    docker exec -i evimed-knowledge-plugin python -c "$(cat tools/text_probe.py)" - < missing-dois.txt > probe.jsonl

or from a checkout with a scratch environment: ``python tools/text_probe.py missing-dois.txt``. ``--limit N`` reads the
first N lines; ``--batch`` (default 20, the worker's) and the chain's own concurrency set the pace.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

if "__file__" in globals():                       # run from a checkout: the package beside tools/
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from knowledge_plugin.budget import HostBudget, MemoryCounterStore, host_rules  # noqa: E402
from knowledge_plugin.enrich import enrich_batch  # noqa: E402
from knowledge_plugin.fetch import ProtectedFetcher  # noqa: E402
from knowledge_plugin.registry import RegistryError, load_registry  # noqa: E402
from knowledge_plugin.settings import Settings, SettingsError  # noqa: E402


def read_lines(path: str, limit: int | None) -> list[tuple[str, str | None]]:
    text = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    out: list[tuple[str, str | None]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        doi, _, source_id = line.partition("|")
        out.append((doi.strip().lower(), source_id.strip() or None))
    return out[:limit] if limit else out


def rows_for(items: list[tuple[str, str | None]], registry: dict, now: datetime) -> list[dict]:
    rows = []
    for doi, source_id in items:
        source = registry.get(source_id) if source_id else None
        rows.append({
            "entry_id": f"probe:{doi}", "revision": 1, "source_id": source_id, "external_key": doi,
            "identity_key": f"doi:{doi}", "url": f"https://doi.org/{doi}", "canonical_url": f"https://doi.org/{doi}",
            "doi": doi, "pmid": None, "registry_ids": [], "title": None, "summary": None, "lang": None,
            "published_at": None, "facts": {}, "first_seen_at": now, "attempts": 0,
            "source_access": source.access if source else "crossref-issn",
            "source_egress": source.egress if source else "direct",
            "source_type": source.source_type if source else "journal",
            "source_config": dict(source.config or {}) if source else {},
        })
    return rows


def prefix(doi: str) -> str:
    return doi.split("/", 1)[0]


async def probe(settings: Settings, items: list[tuple[str, str | None]], *, batch: int, out=sys.stdout) -> dict:
    try:
        registry = {row.source.id: row.source for row in load_registry(settings.registry_path)}
    except RegistryError:
        registry = {}
    budget = HostBudget(MemoryCounterStore(), host_rules(ncbi_key=settings.has_ncbi_key(), openfda_key=settings.has_openfda_key()))
    fetcher = ProtectedFetcher(settings, budget)
    now = datetime.now(timezone.utc)
    by_step: Counter = Counter()
    by_kind: Counter = Counter()
    per_prefix: dict[str, Counter] = defaultdict(Counter)
    try:
        for start in range(0, len(items), batch):
            chunk = items[start:start + batch]
            rows = rows_for(chunk, registry, now)
            began = time.monotonic()
            results = await enrich_batch(rows, fetcher, settings, now=now)
            seconds = round(time.monotonic() - began, 1)
            for row, result in zip(rows, results, strict=True):
                text = bool(result.abstract or result.body_excerpt or result.body_text)
                step = result.fetched_from if text else None
                by_step[step or "none"] += 1
                by_kind[result.text_kind if text else "none"] += 1
                per_prefix[prefix(row["doi"])]["asked"] += 1
                per_prefix[prefix(row["doi"])]["after"] += 1 if text else 0
                per_prefix[prefix(row["doi"])]["full"] += 1 if result.text_kind == "full" and result.body_text else 0
                line = {"doi": row["doi"], "source_id": row["source_id"], "status": result.status,
                        "text_kind": result.text_kind, "fetched_from": step,
                        "abstract_chars": len(result.abstract or ""), "excerpt_chars": len(result.body_excerpt or ""),
                        "body_chars": len(result.body_text or ""),
                        "headings": (result.body_text or "").count("\n\n## ") + (result.body_text or "").startswith("## "),
                        "open_access": result.enrichment.get("open_access"),
                        "oa_pdf_url": bool(result.enrichment.get("oa_pdf_url")),
                        "notes": result.notes, "batch_seconds": seconds}
                print(json.dumps(line, ensure_ascii=False), file=out, flush=True)
            print(f"{min(start + batch, len(items))}/{len(items)} in {seconds}s", file=sys.stderr, flush=True)
    finally:
        await fetcher.aclose()
    summary = {"summary": {
        "dois": len(items), "before_with_text": 0, "after_with_text": sum(c["after"] for c in per_prefix.values()),
        "full_text": sum(c["full"] for c in per_prefix.values()), "by_step": dict(by_step.most_common()),
        "by_kind": dict(by_kind.most_common()),
        "by_prefix": {p: dict(c) for p, c in sorted(per_prefix.items(), key=lambda kv: -kv[1]["asked"])},
    }}
    print(json.dumps(summary, ensure_ascii=False), file=out, flush=True)
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="text_probe", description=__doc__.split("\n\n")[0])
    parser.add_argument("doi_file", help="one DOI (or doi|source_id) a line; - for standard input")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--batch", type=int, default=20)
    args = parser.parse_args(argv)
    try:
        settings = Settings.from_env()
    except SettingsError as error:
        print(f"configuration error: {error}", file=sys.stderr)
        return 2
    items = read_lines(args.doi_file, args.limit)
    asyncio.run(probe(settings, items, batch=max(1, min(args.batch, 50))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
