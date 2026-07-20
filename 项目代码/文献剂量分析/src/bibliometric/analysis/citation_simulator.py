# [IN] list of normalized articles
# [OUT] articles with real/estimated citation counts + co-citation pairs
# [POS] src/bibliometric/analysis/citation_simulator.py - citation data (real then fallback)

from __future__ import annotations

import logging
import math
import random
from collections import Counter, defaultdict
from datetime import datetime
from itertools import combinations

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# Approximate journal impact tiers — full journal name matching
HIGH_IMPACT_JOURNALS = {
    "the new england journal of medicine", "the lancet", "jama",
    "bmj", "nature", "science", "nature medicine", "cell",
    "nature reviews", "lancet oncology",
    "lancet diabetes & endocrinology",
    "jama internal medicine", "jama network open",
    "annals of internal medicine",
    "circulation", "european heart journal", "gut",
    "journal of clinical oncology", "blood", "diabetes care",
    "cell metabolism",
    "diabetes, obesity & metabolism", "obesity reviews",
    "international journal of obesity",
}
# Prefix patterns for mid-impact journals (match start of name)
MID_IMPACT_PREFIXES = [
    "plos one", "scientific reports", "frontiers in",
    "bmc ", "annals of ",
]

CURRENT_YEAR = datetime.now().year

_S2_BATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/batch"
_S2_BATCH_LIMIT = 500  # S2 allows up to 500 per batch request


def fetch_real_citations(articles: list[dict]) -> list[dict]:
    """Fetch real citation counts from Semantic Scholar; fall back to simulation.

    Returns articles with:
      - citations_estimated: int (real count when available, else simulated)
      - citation_source: 'semantic_scholar' | 'simulated'
    Also sets stats key 'citation_real_count' on the articles list via the
    returned list's metadata attribute (not used downstream, just logged).
    """
    pmid_map: dict[str, dict] = {}  # pmid -> article
    for art in articles:
        pmid = art.get("pmid", "")
        if pmid:
            pmid_map[pmid] = art

    real_count = 0
    if pmid_map:
        try:
            import requests as _req
            pmids = list(pmid_map.keys())
            ids = [f"PMID:{p}" for p in pmids]
            # Process in batches if > 500
            for batch_start in range(0, len(ids), _S2_BATCH_LIMIT):
                batch_ids = ids[batch_start: batch_start + _S2_BATCH_LIMIT]
                batch_pmids = pmids[batch_start: batch_start + _S2_BATCH_LIMIT]
                resp = _req.post(
                    _S2_BATCH_URL,
                    params={"fields": "citationCount"},
                    json={"ids": batch_ids},
                    timeout=30,
                    headers={"User-Agent": "bibliometric-analysis/1.0"},
                )
                if resp.status_code == 200:
                    # S2 returns results in same order as input IDs
                    for pmid, item in zip(batch_pmids, resp.json()):
                        if not item:
                            continue
                        count = item.get("citationCount")
                        if count is not None and pmid in pmid_map:
                            pmid_map[pmid]["citations_estimated"] = int(count)
                            pmid_map[pmid]["citation_source"] = "semantic_scholar"
                            real_count += 1
                elif resp.status_code == 429:
                    logger.warning("Semantic Scholar rate limit hit, using simulation for remaining articles")
                    break
                else:
                    logger.warning(f"Semantic Scholar batch returned {resp.status_code}, using simulation")
        except Exception as e:
            logger.warning(f"Semantic Scholar fetch failed: {e}, falling back to simulation")

    # Fill in simulation for articles that didn't get real data
    sim_count = 0
    for art in articles:
        if "citations_estimated" not in art:
            art["citations_estimated"] = _estimate_citations(art)
            art["citation_source"] = "simulated"
            sim_count += 1

    logger.info(
        "Citations: %d real (Semantic Scholar), %d simulated",
        real_count, sim_count,
    )
    return articles, real_count, sim_count


def simulate_citations(articles: list[dict]) -> list[dict]:
    """Add estimated citation counts to articles (pure simulation fallback)."""
    for art in articles:
        art["citations_estimated"] = _estimate_citations(art)
        art["citation_source"] = "simulated"
    logger.info("Simulated citations for %d articles", len(articles))
    return articles


def _estimate_citations(article: dict) -> int:
    """Estimate citation count based on journal, year, and type."""
    base = 5.0

    # Journal tier factor
    journal_name = ""
    j = article.get("journal", {})
    if isinstance(j, dict):
        journal_name = j.get("title", "").lower()
    else:
        journal_name = str(j).lower()

    if journal_name in HIGH_IMPACT_JOURNALS:
        base *= 8.0
    elif any(journal_name.startswith(mp) for mp in MID_IMPACT_PREFIXES):
        base *= 2.5

    # Year factor: older papers accumulate more citations
    try:
        year = int(article.get("year", CURRENT_YEAR))
    except (ValueError, TypeError):
        year = CURRENT_YEAR
    age = max(CURRENT_YEAR - year, 0)
    if age == 0:
        base *= 0.3
    elif age == 1:
        base *= 0.8
    elif age <= 3:
        base *= 1.0 + age * 0.4
    else:
        base *= 1.0 + min(age, 10) * 0.6

    # Article type factor
    pub_types = [pt.lower() for pt in article.get("pub_types", [])]
    if any("review" in pt or "meta-analysis" in pt for pt in pub_types):
        base *= 2.5
    elif any("randomized" in pt or "clinical trial" in pt for pt in pub_types):
        base *= 2.0
    elif any("case report" in pt for pt in pub_types):
        base *= 0.4

    # Add controlled randomness (log-normal distribution)
    random.seed(hash(article.get("pmid", "")) % (2**31))
    noise = random.lognormvariate(0, 0.6)
    result = int(base * noise)
    return max(0, result)


def build_cocitation_pairs(articles: list[dict]) -> pd.DataFrame:
    """Build co-citation pairs from shared references (simulated via keyword overlap)."""
    # Group articles by shared keywords as proxy for co-citation
    kw_to_articles = defaultdict(set)
    for i, art in enumerate(articles):
        for kw in art.get("keywords_merged", []):
            kw_to_articles[kw].add(i)

    # Co-citation strength = number of shared keywords weighted by citations
    pair_scores = Counter()
    for kw, art_indices in kw_to_articles.items():
        if len(art_indices) < 2 or len(art_indices) > 50:
            continue
        for i, j in combinations(sorted(art_indices), 2):
            ci = articles[i].get("citations_estimated", 1)
            cj = articles[j].get("citations_estimated", 1)
            strength = math.log1p(ci) + math.log1p(cj)
            pair_scores[(i, j)] += strength

    # Convert to DataFrame
    rows = []
    for (i, j), score in pair_scores.most_common(500):
        rows.append({
            "source_pmid": articles[i].get("pmid", ""),
            "target_pmid": articles[j].get("pmid", ""),
            "source_title": articles[i].get("title", "")[:80],
            "target_title": articles[j].get("title", "")[:80],
            "cocitation_strength": round(score, 2),
            "source_citations": articles[i].get("citations_estimated", 0),
            "target_citations": articles[j].get("citations_estimated", 0),
        })

    df = pd.DataFrame(rows)
    logger.info("Built %d co-citation pairs", len(df))
    return df


def compute_citation_statistics(articles: list[dict]) -> dict:
    """Compute citation-based statistics."""
    citations = [a.get("citations_estimated", 0) for a in articles]
    if not citations:
        return {}

    arr = np.array(citations)
    sorted_cites = np.sort(arr)[::-1]

    # h-index
    h_index = 0
    for i, c in enumerate(sorted_cites):
        if c >= i + 1:
            h_index = i + 1
        else:
            break

    # Top cited papers
    indexed = [(a.get("title", ""), a.get("citations_estimated", 0),
                a.get("year", ""), a.get("pmid", ""))
               for a in articles]
    indexed.sort(key=lambda x: x[1], reverse=True)

    top_cited = pd.DataFrame(
        indexed[:20],
        columns=["title", "citations", "year", "pmid"],
    )

    # Citation per year
    year_cites = defaultdict(list)
    for a in articles:
        y = a.get("year", "")
        if y:
            year_cites[y].append(a.get("citations_estimated", 0))

    year_stats = []
    for y in sorted(year_cites):
        cites = year_cites[y]
        year_stats.append({
            "year": y,
            "mean_citations": round(np.mean(cites), 1),
            "median_citations": round(np.median(cites), 1),
            "total_citations": int(np.sum(cites)),
            "n_articles": len(cites),
        })

    return {
        "total_citations": int(arr.sum()),
        "mean_citations": round(float(arr.mean()), 1),
        "median_citations": round(float(np.median(arr)), 1),
        "max_citations": int(arr.max()),
        "h_index": h_index,
        "top_cited": top_cited,
        "year_citation_stats": pd.DataFrame(year_stats),
    }
