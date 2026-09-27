"""Regenerate the FAERS reaction-term vocabulary from openFDA's own reaction field.

    python -m safety_agent.normalize.build_vocabulary \
        --out safety_agent/data/faers_reaction_terms.json --budget 450

What it harvests: the MedDRA Preferred Term strings FAERS reports carry, as
openFDA publishes them in ``patient.reaction.reactionmeddrapt.exact``. These
are public report fields, not the licensed MedDRA hierarchy; the vocabulary
holds strings only (no codes, no SOC/HLT structure).

How: openFDA's count endpoint returns at most the top 999 terms of one query
without an API key (1000 with one), so a single global count sees only the
commonest PTs. The crawl therefore scopes each count to the reports that carry
a reaction containing one word (``patient.reaction.reactionmeddrapt:"word"``).
A rare word scopes a small report set whose top terms include every rare PT
built on that word (``myocarditis`` returns ``coxsackie myocarditis`` at 11
reports). Words come from the terms already found; the next word asked is the
one shared by the most found terms, so families are exhausted before the
tail. The run stops at ``--budget`` requests.

Nothing here is interpreted: a term enters the vocabulary only because openFDA
returned it as a reaction value with a report count. The count stored beside
each term is the largest count any one harvesting query returned for it -- a
lower bound on its FAERS report count, used only to order candidates.

The anonymous openFDA quota is about 1,000 requests a day per IP; an API key
(``OPENFDA_API_KEY`` or ``--api-key-file``) raises it. The key is sent as a
query parameter and never written to the output or the log.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import httpx

EVENT_URL = "https://api.fda.gov/drug/event.json"
COUNT_FIELD = "patient.reaction.reactionmeddrapt.exact"
SEARCH_FIELD = "patient.reaction.reactionmeddrapt"
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "data" / "faers_reaction_terms.json"

#: Words that scope nothing useful: they join terms rather than name them.
STOPWORDS = frozenset(
    {
        "and", "the", "of", "with", "without", "to", "in", "on", "for", "by",
        "due", "not", "non", "other", "or", "at", "from", "after", "as", "an",
        "into", "than", "via", "per", "nos",
    }
)

_WORD = re.compile(r"[a-z0-9]+")


class HarvestStopped(RuntimeError):
    """openFDA refused further requests (quota, key, or a persistent error)."""


def words_of(term: str) -> list[str]:
    """Crawlable words of one term: lower-case, >= 3 letters, not a stopword."""
    return [
        word
        for word in _WORD.findall(term.casefold())
        if len(word) >= 3 and not word.isdigit() and word not in STOPWORDS
    ]


@dataclass
class Harvest:
    terms: dict[str, int] = field(default_factory=dict)
    queried_words: list[str] = field(default_factory=list)
    requests: int = 0
    source_last_updated: str | None = None
    stop_reason: str | None = None

    def add(self, results: list[dict]) -> int:
        """Merge one count response; returns how many terms were new."""
        new = 0
        for item in results:
            term, count = item.get("term"), item.get("count")
            if not isinstance(term, str) or not isinstance(count, int) or count <= 0:
                continue
            key = " ".join(term.split()).casefold()
            if not key:
                continue
            if key not in self.terms:
                new += 1
                self.terms[key] = count
            elif count > self.terms[key]:
                self.terms[key] = count
        return new

    def next_word(self) -> str | None:
        """The unqueried word shared by the most found terms (ties: alphabetical)."""
        asked = set(self.queried_words)
        family: Counter[str] = Counter()
        for term in self.terms:
            for word in set(words_of(term)):
                if word not in asked:
                    family[word] += 1
        if not family:
            return None
        return min(family, key=lambda word: (-family[word], word))


Fetch = Callable[[dict[str, str]], dict]


def http_fetch(
    client: httpx.Client,
    *,
    api_key: str | None,
    max_attempts: int = 4,
    sleep: Callable[[float], None] = time.sleep,
) -> Fetch:
    """One count request with bounded retry on 429/5xx; 404 means "no results"."""

    def fetch(params: dict[str, str]) -> dict:
        query = dict(params)
        if api_key:
            query["api_key"] = api_key
        for attempt in range(max_attempts):
            try:
                response = client.get(EVENT_URL, params=query)
            except httpx.TransportError:
                sleep(min(30.0, 2.0 * 2**attempt))
                continue
            if response.status_code == 200:
                return response.json()
            if response.status_code == 404:
                return {"results": []}
            if response.status_code == 429 or response.status_code >= 500:
                retry_after = response.headers.get("Retry-After", "")
                delay = float(retry_after) if retry_after.isdigit() else 2.0 * 2**attempt
                sleep(min(120.0, delay))
                continue
            # 403 (quota or a key requirement) and any other 4xx: asking again
            # cannot help. The body names the reason without echoing the key.
            try:
                reason = response.json().get("error", {}).get("code") or response.status_code
            except ValueError:
                reason = response.status_code
            raise HarvestStopped(f"openFDA refused the request ({reason})")
        raise HarvestStopped("openFDA kept failing after retries")

    return fetch


def harvest(
    fetch: Fetch,
    *,
    budget: int,
    limit: int,
    pause: float = 0.0,
    sleep: Callable[[float], None] = time.sleep,
    log: Callable[[str], None] = lambda _line: None,
) -> Harvest:
    """Global top terms, then word-scoped counts until the budget is spent."""
    result = Harvest()

    def ask(search: str | None) -> list[dict]:
        params = {"count": COUNT_FIELD, "limit": str(limit)}
        if search:
            params["search"] = search
        payload = fetch(params)
        result.requests += 1
        meta = payload.get("meta") if isinstance(payload, dict) else None
        updated = meta.get("last_updated") if isinstance(meta, dict) else None
        if isinstance(updated, str) and updated:
            result.source_last_updated = max(result.source_last_updated or "", updated)
        items = payload.get("results") if isinstance(payload, dict) else None
        return items if isinstance(items, list) else []

    try:
        result.add(ask(None))
        while result.requests < budget:
            word = result.next_word()
            if word is None:
                break
            result.queried_words.append(word)
            if pause:
                sleep(pause)
            new = result.add(ask(f'{SEARCH_FIELD}:"{word}"'))
            log(f"{result.requests:4d} {word!r:28} +{new:<4d} total {len(result.terms)}")
    except HarvestStopped as stopped:
        result.stop_reason = str(stopped)
        log(f"stopped: {stopped}")
    return result


def vocabulary_document(result: Harvest, *, limit: int, budget: int) -> dict:
    return {
        "schemaVersion": 1,
        "source": f"openFDA drug/event.json count={COUNT_FIELD}",
        "sourceLastUpdated": result.source_last_updated,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generator": "python -m safety_agent.normalize.build_vocabulary",
        "method": (
            f"global top {limit}, then counts scoped to "
            f'{SEARCH_FIELD}:"<word>" for the word shared by the most found '
            f"terms, {result.requests} requests of a {budget} budget"
        ),
        "stopReason": result.stop_reason,
        "countMeaning": (
            "largest report count one harvesting query returned for the term; "
            "a lower bound on its FAERS report count, used only to order candidates"
        ),
        "termCount": len(result.terms),
        "terms": dict(sorted(result.terms.items())),
    }


def _api_key(path: Path | None) -> str | None:
    if path is not None:
        return path.read_text(encoding="utf-8").strip() or None
    return os.environ.get("OPENFDA_API_KEY", "").strip() or None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--budget", type=int, default=450, help="maximum openFDA requests")
    parser.add_argument("--pause", type=float, default=0.35, help="seconds between requests")
    parser.add_argument("--api-key-file", type=Path, default=None)
    args = parser.parse_args(argv)
    if args.budget < 1:
        parser.error("--budget must be at least 1")
    api_key = _api_key(args.api_key_file)
    limit = 1000 if api_key else 999
    with httpx.Client(timeout=60.0, headers={"Accept": "application/json"}) as client:
        result = harvest(
            http_fetch(client, api_key=api_key),
            budget=args.budget,
            limit=limit,
            pause=args.pause,
            log=lambda line: print(line, file=sys.stderr, flush=True),
        )
    if not result.terms:
        print("no terms harvested; nothing written", file=sys.stderr)
        return 1
    document = vocabulary_document(result, limit=limit, budget=args.budget)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(document, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    print(
        f"wrote {len(result.terms)} terms from {result.requests} requests to {args.out}",
        file=sys.stderr,
    )
    return 0 if result.stop_reason is None else 2


if __name__ == "__main__":
    raise SystemExit(main())
