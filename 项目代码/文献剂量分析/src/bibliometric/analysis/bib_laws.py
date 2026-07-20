# [IN] articles, stats (top_authors, top_journals)
# [OUT] dict with law test results (lotka, bradford, zipf)
# [POS] src/bibliometric/analysis/bib_laws.py - bibliometric law testing

from __future__ import annotations

import logging
from collections import Counter

import numpy as np
from scipy import stats as sp_stats

logger = logging.getLogger(__name__)


def test_bibliometric_laws(articles: list[dict], stats: dict) -> dict:
    """Test Lotka's Law, Bradford's Law, and Zipf's Law."""
    return {
        "lotka": _test_lotka(articles),
        "bradford": _test_bradford(articles),
        "zipf": _test_zipf(articles),
    }


def _test_lotka(articles: list[dict]) -> dict:
    """Test Lotka's Law: proportion of authors with n papers ~ 1/n^a."""
    author_counts = Counter()
    for art in articles:
        for author in art.get("authors_normalized", []):
            author_counts[author] += 1

    if len(author_counts) < 10:
        return {"valid": False, "reason": "too few authors"}

    prod_freq = Counter(author_counts.values())
    x = np.array(sorted(prod_freq.keys()), dtype=float)
    y = np.array([prod_freq[int(xi)] for xi in x], dtype=float)

    if len(x) < 3:
        return {"valid": False, "reason": "too few productivity levels"}

    log_x = np.log10(x)
    log_y = np.log10(y)
    slope, intercept, r_value, p_value, std_err = sp_stats.linregress(log_x, log_y)

    n_authors = len(author_counts)
    one_paper = prod_freq.get(1, 0)
    pct_one_paper = one_paper / n_authors if n_authors > 0 else 0

    return {
        "valid": True,
        "exponent": round(-slope, 2),
        "r_squared": round(r_value ** 2, 4),
        "p_value": round(p_value, 6),
        "n_authors": n_authors,
        "one_paper_authors": one_paper,
        "pct_one_paper": round(pct_one_paper, 3),
        "conforms": abs(-slope - 2.0) < 0.5 and r_value ** 2 > 0.8,
        "productivity_distribution": {
            int(k): v for k, v in sorted(prod_freq.items())[:10]
        },
    }


def _test_bradford(articles: list[dict]) -> dict:
    """Test Bradford's Law: journal scatter into core/periphery zones."""
    journal_counts = Counter()
    for art in articles:
        j = art.get("journal", {}).get("title", "")
        if j:
            journal_counts[j] += 1

    if len(journal_counts) < 5:
        return {"valid": False, "reason": "too few journals"}

    sorted_journals = journal_counts.most_common()
    total_articles = sum(c for _, c in sorted_journals)
    third = total_articles / 3

    zones = []
    cumulative = 0
    zone_journals = []
    zone_num = 1

    for j, count in sorted_journals:
        cumulative += count
        zone_journals.append(j)
        if cumulative >= third * zone_num and zone_num <= 3:
            zones.append({
                "zone": zone_num,
                "journals": len(zone_journals),
                "articles": cumulative if zone_num == 1 else cumulative - sum(
                    z["articles"] for z in zones
                ),
                "core_journals": zone_journals[:5],
            })
            zone_journals = []
            zone_num += 1

    if len(zones) < 2:
        return {"valid": False, "reason": "insufficient data for zone analysis"}

    bradford_multiplier = None
    if len(zones) >= 2 and zones[0]["journals"] > 0:
        bradford_multiplier = round(
            zones[1]["journals"] / max(zones[0]["journals"], 1), 2
        )

    return {
        "valid": True,
        "zones": zones,
        "bradford_multiplier": bradford_multiplier,
        "total_journals": len(journal_counts),
        "core_journals": [j for j, _ in sorted_journals[:zones[0]["journals"]]]
        if zones else [],
    }


def _test_zipf(articles: list[dict]) -> dict:
    """Test Zipf's Law on keyword frequency distribution."""
    kw_counts = Counter()
    for art in articles:
        for kw in art.get("keywords_merged", []):
            kw_counts[kw] += 1

    if len(kw_counts) < 10:
        return {"valid": False, "reason": "too few keywords"}

    sorted_kw = kw_counts.most_common()
    ranks = np.arange(1, len(sorted_kw) + 1, dtype=float)
    freqs = np.array([c for _, c in sorted_kw], dtype=float)

    log_r = np.log10(ranks)
    log_f = np.log10(freqs)
    slope, intercept, r_value, p_value, std_err = sp_stats.linregress(log_r, log_f)

    return {
        "valid": True,
        "exponent": round(-slope, 2),
        "r_squared": round(r_value ** 2, 4),
        "p_value": round(p_value, 6),
        "conforms": abs(-slope - 1.0) < 0.3 and r_value ** 2 > 0.8,
        "n_keywords": len(kw_counts),
    }
