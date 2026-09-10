# [IN] list of normalized articles
# [OUT] articles carrying observed citation counts + real reference relations
# [POS] src/bibliometric/analysis/citations.py - citation data from real sources only

"""Citation data for the retrieved record set.

Every number in this module comes from an external citation index. There is no
estimator: an article whose citations could not be observed keeps
``citation_source == "missing"`` and carries no ``citations`` key, so it is
excluded from every citation statistic instead of being filled with a guess.

Source order:
  1. NIH iCite  - free, no key, returns ``citation_count``, ``references`` and
     ``cited_by`` (the reference relations co-citation actually needs).
  2. OpenAlex   - needs an API key since 2026-02. Without a key the source is
     recorded as unavailable; it is never silently skipped.
  3. Semantic Scholar - counts only, no reference relations.
"""

from __future__ import annotations

import logging
import os
from collections import Counter, defaultdict
from itertools import combinations

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

ICITE_URL = "https://icite.od.nih.gov/api/pubs"
OPENALEX_URL = "https://api.openalex.org/works"
S2_BATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/batch"

ICITE_BATCH_LIMIT = 400  # keeps the GET URL well inside server limits
OPENALEX_BATCH_LIMIT = 50  # OpenAlex pmid filter is an OR list
S2_BATCH_LIMIT = 500

SOURCE_ICITE = "icite"
SOURCE_OPENALEX = "openalex"
SOURCE_S2 = "semantic_scholar"
SOURCE_MISSING = "missing"

SOURCE_LABELS = {
    SOURCE_ICITE: "NIH iCite",
    SOURCE_OPENALEX: "OpenAlex",
    SOURCE_S2: "Semantic Scholar",
}

_USER_AGENT = "evimed-bibliometric-agent/1.0"


class CitationCoverage(dict):
    """Coverage ledger for one citation-fetching pass.

    Kept as a plain dict so it serialises straight into
    ``search_metadata.json`` / ``result.json``.
    """

    @property
    def observed(self) -> int:
        return int(self.get("observed", 0))

    @property
    def total(self) -> int:
        return int(self.get("total", 0))

    @property
    def complete(self) -> bool:
        return self.total > 0 and self.observed == self.total


def _new_coverage(total: int) -> CitationCoverage:
    return CitationCoverage({
        "total": total,
        "observed": 0,
        "missing": total,
        "by_source": {},
        "sources_unavailable": {},
        "reference_relations": 0,
    })


def fetch_citations(
    articles: list[dict],
    *,
    openalex_api_key: str | None = None,
    session=None,
    timeout: int = 30,
) -> tuple[list[dict], CitationCoverage]:
    """Attach observed citation data to ``articles``.

    Returns ``(articles, coverage)``. Articles without an observation keep
    ``citation_source == "missing"`` and no ``citations`` key.
    """
    coverage = _new_coverage(len(articles))
    pmid_map: dict[str, dict] = {}
    for art in articles:
        art["citation_source"] = SOURCE_MISSING
        art.pop("citations", None)
        pmid = str(art.get("pmid") or "").strip()
        if pmid:
            pmid_map[pmid] = art

    if not pmid_map:
        coverage["sources_unavailable"][SOURCE_ICITE] = "no_pmids_in_record_set"
        _finish_coverage(articles, coverage)
        return articles, coverage

    session = session or _default_session()

    pending = list(pmid_map)
    pending = _fetch_icite(session, pmid_map, pending, coverage, timeout)
    if pending:
        pending = _fetch_openalex(
            session, pmid_map, pending, coverage, timeout,
            api_key=openalex_api_key,
        )
    if pending:
        pending = _fetch_semantic_scholar(session, pmid_map, pending, coverage, timeout)

    _finish_coverage(articles, coverage)
    logger.info(
        "Citations observed for %d/%d articles (%s); %d unresolved",
        coverage["observed"], coverage["total"],
        ", ".join(f"{k}={v}" for k, v in coverage["by_source"].items()) or "no source",
        coverage["missing"],
    )
    for name, reason in coverage["sources_unavailable"].items():
        logger.warning("Citation source %s unavailable: %s", name, reason)
    return articles, coverage


def _default_session():
    import requests

    session = requests.Session()
    session.headers.update({"User-Agent": _USER_AGENT})
    return session


def _finish_coverage(articles: list[dict], coverage: CitationCoverage) -> None:
    observed = sum(1 for a in articles if "citations" in a)
    coverage["observed"] = observed
    coverage["missing"] = coverage["total"] - observed
    coverage["reference_relations"] = sum(
        1 for a in articles if a.get("cited_by") or a.get("references")
    )


def _record(article: dict, source: str, count: int, coverage: CitationCoverage) -> None:
    article["citations"] = int(count)
    article["citation_source"] = source
    coverage["by_source"][source] = coverage["by_source"].get(source, 0) + 1


# --------------------------------------------------------------------------- #
# iCite
# --------------------------------------------------------------------------- #

def _fetch_icite(session, pmid_map, pending, coverage, timeout) -> list[str]:
    """Primary source. Returns the PMIDs it could not resolve."""
    unresolved: list[str] = []
    failures = 0
    for start in range(0, len(pending), ICITE_BATCH_LIMIT):
        batch = pending[start:start + ICITE_BATCH_LIMIT]
        try:
            resp = session.get(
                ICITE_URL,
                params={"pmids": ",".join(batch), "format": "json"},
                timeout=timeout,
            )
        except Exception as error:  # network stack failure
            failures += 1
            coverage["sources_unavailable"].setdefault(SOURCE_ICITE, f"request_failed: {error}")
            unresolved.extend(batch)
            continue
        if resp.status_code != 200:
            failures += 1
            coverage["sources_unavailable"].setdefault(
                SOURCE_ICITE, f"http_{resp.status_code}"
            )
            unresolved.extend(batch)
            continue
        try:
            payload = resp.json()
        except ValueError as error:
            failures += 1
            coverage["sources_unavailable"].setdefault(SOURCE_ICITE, f"bad_json: {error}")
            unresolved.extend(batch)
            continue

        resolved = set()
        for row in payload.get("data") or []:
            pmid = str(row.get("pmid") or row.get("_id") or "").strip()
            article = pmid_map.get(pmid)
            if article is None:
                continue
            count = row.get("citation_count")
            if count is None:
                continue
            _record(article, SOURCE_ICITE, count, coverage)
            article["references"] = _pmid_list(row.get("references"))
            article["cited_by"] = _pmid_list(row.get("cited_by"))
            rcr = row.get("relative_citation_ratio")
            if rcr is not None:
                article["relative_citation_ratio"] = float(rcr)
            resolved.add(pmid)
        unresolved.extend(p for p in batch if p not in resolved)

    if failures == 0:
        coverage["sources_unavailable"].pop(SOURCE_ICITE, None)
    return unresolved


def _pmid_list(value) -> list[str]:
    """iCite returns PMID relations as a list of ints or a space-separated string."""
    if not value:
        return []
    if isinstance(value, str):
        return [part for part in value.replace(",", " ").split() if part]
    return [str(item).strip() for item in value if str(item).strip()]


# --------------------------------------------------------------------------- #
# OpenAlex (API key required since 2026-02)
# --------------------------------------------------------------------------- #

def _fetch_openalex(session, pmid_map, pending, coverage, timeout, api_key=None) -> list[str]:
    key = (api_key if api_key is not None else os.getenv("OPENALEX_API_KEY", "")).strip()
    if not key:
        # Degrade visibly. OpenAlex has required a key since 2026-02-13, so an
        # unkeyed call is not a fallback, it is an unavailable source.
        coverage["sources_unavailable"][SOURCE_OPENALEX] = "api_key_missing"
        return list(pending)

    unresolved: list[str] = []
    for start in range(0, len(pending), OPENALEX_BATCH_LIMIT):
        batch = pending[start:start + OPENALEX_BATCH_LIMIT]
        pmid_filter = "|".join(f"https://pubmed.ncbi.nlm.nih.gov/{p}" for p in batch)
        try:
            resp = session.get(
                OPENALEX_URL,
                params={
                    "filter": f"ids.pmid:{pmid_filter}",
                    "per-page": str(len(batch)),
                    "select": "ids,cited_by_count,referenced_works",
                    "api_key": key,
                },
                timeout=timeout,
            )
        except Exception as error:
            coverage["sources_unavailable"].setdefault(
                SOURCE_OPENALEX, f"request_failed: {error}"
            )
            unresolved.extend(batch)
            continue
        if resp.status_code != 200:
            coverage["sources_unavailable"].setdefault(
                SOURCE_OPENALEX, f"http_{resp.status_code}"
            )
            unresolved.extend(batch)
            continue
        try:
            payload = resp.json()
        except ValueError as error:
            coverage["sources_unavailable"].setdefault(
                SOURCE_OPENALEX, f"bad_json: {error}"
            )
            unresolved.extend(batch)
            continue

        resolved = set()
        for row in payload.get("results") or []:
            pmid = _openalex_pmid(row)
            article = pmid_map.get(pmid)
            if article is None:
                continue
            count = row.get("cited_by_count")
            if count is None:
                continue
            _record(article, SOURCE_OPENALEX, count, coverage)
            # referenced_works are OpenAlex ids, not PMIDs: kept as opaque ids so
            # bibliographic coupling stays computable within this source.
            article["references"] = [str(w) for w in (row.get("referenced_works") or [])]
            resolved.add(pmid)
        unresolved.extend(p for p in batch if p not in resolved)
    return unresolved


def _openalex_pmid(row: dict) -> str:
    raw = str((row.get("ids") or {}).get("pmid") or "")
    return raw.rstrip("/").rsplit("/", 1)[-1].strip()


# --------------------------------------------------------------------------- #
# Semantic Scholar (counts only)
# --------------------------------------------------------------------------- #

def _fetch_semantic_scholar(session, pmid_map, pending, coverage, timeout) -> list[str]:
    unresolved: list[str] = []
    for start in range(0, len(pending), S2_BATCH_LIMIT):
        batch = pending[start:start + S2_BATCH_LIMIT]
        try:
            resp = session.post(
                S2_BATCH_URL,
                params={"fields": "citationCount"},
                json={"ids": [f"PMID:{p}" for p in batch]},
                timeout=timeout,
            )
        except Exception as error:
            coverage["sources_unavailable"].setdefault(SOURCE_S2, f"request_failed: {error}")
            unresolved.extend(batch)
            continue
        if resp.status_code == 429:
            coverage["sources_unavailable"].setdefault(SOURCE_S2, "rate_limited")
            unresolved.extend(pending[start:])
            break
        if resp.status_code != 200:
            coverage["sources_unavailable"].setdefault(SOURCE_S2, f"http_{resp.status_code}")
            unresolved.extend(batch)
            continue
        try:
            rows = resp.json()
        except ValueError as error:
            coverage["sources_unavailable"].setdefault(SOURCE_S2, f"bad_json: {error}")
            unresolved.extend(batch)
            continue

        for pmid, row in zip(batch, rows or []):
            article = pmid_map.get(pmid)
            if article is None or not row:
                unresolved.append(pmid)
                continue
            count = row.get("citationCount")
            if count is None:
                unresolved.append(pmid)
                continue
            _record(article, SOURCE_S2, count, coverage)
    return unresolved


# --------------------------------------------------------------------------- #
# Real reference relations
# --------------------------------------------------------------------------- #

def build_cocitation_pairs(articles: list[dict], top_n: int = 500) -> pd.DataFrame:
    """Co-citation (Small 1973): how many documents cite both A and B.

    Computed from the ``cited_by`` lists a citation index returned. When no
    article carries reference relations the frame is empty - the analysis is
    reported as unavailable rather than approximated by anything else.
    """
    citers: dict[int, set[str]] = {}
    for idx, art in enumerate(articles):
        cited_by = set(art.get("cited_by") or [])
        if cited_by:
            citers[idx] = cited_by

    if len(citers) < 2:
        logger.info("Co-citation skipped: reference relations available for %d articles", len(citers))
        return pd.DataFrame(columns=_COCITATION_COLUMNS)

    # Invert: citing document -> the indexed articles it cites.
    citing_to_targets: dict[str, list[int]] = defaultdict(list)
    for idx, cited_by in citers.items():
        for citer in cited_by:
            citing_to_targets[citer].append(idx)

    pair_counts: Counter = Counter()
    for targets in citing_to_targets.values():
        if len(targets) < 2:
            continue
        for i, j in combinations(sorted(targets), 2):
            pair_counts[(i, j)] += 1

    rows = []
    for (i, j), strength in pair_counts.most_common(top_n):
        rows.append({
            "source_pmid": articles[i].get("pmid", ""),
            "target_pmid": articles[j].get("pmid", ""),
            "source_title": str(articles[i].get("title", ""))[:80],
            "target_title": str(articles[j].get("title", ""))[:80],
            "cocitation_strength": int(strength),
            "source_citations": articles[i].get("citations"),
            "target_citations": articles[j].get("citations"),
        })
    df = pd.DataFrame(rows, columns=_COCITATION_COLUMNS)
    logger.info("Built %d co-citation pairs from observed citing documents", len(df))
    return df


_COCITATION_COLUMNS = [
    "source_pmid", "target_pmid", "source_title", "target_title",
    "cocitation_strength", "source_citations", "target_citations",
]

_COUPLING_COLUMNS = [
    "source_pmid", "target_pmid", "source_title", "target_title", "shared_references",
]


def build_bibliographic_coupling_pairs(articles: list[dict], top_n: int = 500) -> pd.DataFrame:
    """Bibliographic coupling (Kessler 1963): shared references between A and B."""
    refs: dict[int, set[str]] = {}
    for idx, art in enumerate(articles):
        reference_ids = set(art.get("references") or [])
        if reference_ids:
            refs[idx] = reference_ids

    if len(refs) < 2:
        logger.info("Bibliographic coupling skipped: references available for %d articles", len(refs))
        return pd.DataFrame(columns=_COUPLING_COLUMNS)

    reference_to_sources: dict[str, list[int]] = defaultdict(list)
    for idx, reference_ids in refs.items():
        for reference in reference_ids:
            reference_to_sources[reference].append(idx)

    pair_counts: Counter = Counter()
    for sources in reference_to_sources.values():
        if len(sources) < 2:
            continue
        for i, j in combinations(sorted(sources), 2):
            pair_counts[(i, j)] += 1

    rows = []
    for (i, j), strength in pair_counts.most_common(top_n):
        rows.append({
            "source_pmid": articles[i].get("pmid", ""),
            "target_pmid": articles[j].get("pmid", ""),
            "source_title": str(articles[i].get("title", ""))[:80],
            "target_title": str(articles[j].get("title", ""))[:80],
            "shared_references": int(strength),
        })
    return pd.DataFrame(rows, columns=_COUPLING_COLUMNS)


# --------------------------------------------------------------------------- #
# Statistics over the observed subset only
# --------------------------------------------------------------------------- #

def compute_citation_statistics(articles: list[dict]) -> dict:
    """Citation statistics over the articles that carry an observed count.

    Articles with ``citation_source == "missing"`` are excluded, not zero-filled;
    ``coverage`` reports how many of the record set the numbers stand for.
    """
    observed = [a for a in articles if "citations" in a]
    coverage = {
        "observed": len(observed),
        "total": len(articles),
        "by_source": dict(Counter(a.get("citation_source", SOURCE_MISSING) for a in observed)),
    }
    if not observed:
        return {"coverage": coverage}

    arr = np.array([int(a["citations"]) for a in observed])
    sorted_cites = np.sort(arr)[::-1]

    h_index = 0
    for i, c in enumerate(sorted_cites):
        if c >= i + 1:
            h_index = i + 1
        else:
            break

    indexed = [(a.get("title", ""), int(a["citations"]), a.get("year", ""),
                a.get("pmid", ""), a.get("citation_source", ""))
               for a in observed]
    indexed.sort(key=lambda x: x[1], reverse=True)
    top_cited = pd.DataFrame(
        indexed[:20],
        columns=["title", "citations", "year", "pmid", "citation_source"],
    )

    year_cites = defaultdict(list)
    for a in observed:
        year = a.get("year", "")
        if year:
            year_cites[year].append(int(a["citations"]))

    year_stats = []
    for year in sorted(year_cites):
        cites = year_cites[year]
        year_stats.append({
            "year": year,
            "mean_citations": round(float(np.mean(cites)), 1),
            "median_citations": round(float(np.median(cites)), 1),
            "total_citations": int(np.sum(cites)),
            "n_articles": len(cites),
        })

    return {
        "coverage": coverage,
        "total_citations": int(arr.sum()),
        "mean_citations": round(float(arr.mean()), 1),
        "median_citations": round(float(np.median(arr)), 1),
        "max_citations": int(arr.max()),
        "h_index": h_index,
        "top_cited": top_cited,
        "year_citation_stats": pd.DataFrame(year_stats),
    }
