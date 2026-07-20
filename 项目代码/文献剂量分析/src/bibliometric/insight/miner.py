# [IN] articles, stats, networks
# [OUT] structured insight JSON with 6 pattern categories
# [POS] src/bibliometric/insight/miner.py - insight mining engine

from __future__ import annotations

import logging
from collections import Counter

import pandas as pd

logger = logging.getLogger(__name__)


def mine_insights(
    articles: list[dict],
    stats: dict,
    networks: dict,
) -> list[dict]:
    """Mine insights from analysis results. Returns structured insight list."""
    insights = []
    insights.extend(_detect_dominance(articles, stats))
    insights.extend(_detect_migration(articles, stats))
    insights.extend(_detect_imbalance(articles, stats))
    insights.extend(_detect_maturity(articles, stats))
    insights.extend(_detect_emerging(stats))
    insights.extend(_detect_paradox(articles, stats, networks))

    insights.sort(key=lambda x: x.get("importance", 0), reverse=True)
    logger.info("Mined %d insights", len(insights))
    return insights


def _detect_dominance(articles: list[dict], stats: dict) -> list[dict]:
    """Detect concentration/dominance patterns."""
    insights = []

    # Author concentration
    author_df = stats.get("top_authors")
    if author_df is not None and not author_df.empty:
        total = len(articles)
        top5_count = author_df.head(5)["count"].sum()
        ratio = top5_count / max(total, 1)
        if ratio > 0.1:
            top_names = ", ".join(author_df.head(3)["authors_normalized"])
            insights.append({
                "category": "dominance",
                "title": "Author Concentration",
                "description": (
                    f"Top 5 authors contributed {ratio:.0%} of all publications. "
                    f"Key figures: {top_names}."
                ),
                "importance": 0.7 + ratio,
                "evidence": {"ratio": ratio, "top_authors": top_names},
            })

    # Country concentration
    country_df = stats.get("top_countries")
    if country_df is not None and not country_df.empty:
        total = sum(country_df["count"])
        top3_count = country_df.head(3)["count"].sum()
        ratio = top3_count / max(total, 1)
        if ratio > 0.5:
            top_names = ", ".join(country_df.head(3)["countries"])
            insights.append({
                "category": "dominance",
                "title": "Geographic Concentration",
                "description": (
                    f"Top 3 countries account for {ratio:.0%} of research output: "
                    f"{top_names}."
                ),
                "importance": 0.6 + ratio * 0.3,
                "evidence": {"ratio": ratio, "countries": top_names},
            })

    # Journal concentration
    journal_df = stats.get("top_journals")
    if journal_df is not None and not journal_df.empty:
        total = sum(journal_df["count"])
        top5_count = journal_df.head(5)["count"].sum()
        ratio = top5_count / max(total, 1)
        if ratio > 0.2:
            insights.append({
                "category": "dominance",
                "title": "Journal Concentration",
                "description": (
                    f"Top 5 journals published {ratio:.0%} of papers, "
                    f"led by {journal_df.iloc[0]['journal']}."
                ),
                "importance": 0.5 + ratio * 0.3,
                "evidence": {"ratio": ratio},
            })

    return insights


def _detect_migration(articles: list[dict], stats: dict) -> list[dict]:
    """Detect topic migration/shift patterns."""
    insights = []

    years = sorted(set(a.get("year", "") for a in articles if a.get("year")))
    if len(years) < 4:
        return insights

    mid = len(years) // 2
    early_years = set(years[:mid])
    late_years = set(years[mid:])

    early_kw = Counter()
    late_kw = Counter()
    for art in articles:
        year = art.get("year", "")
        for kw in art.get("keywords_merged", []):
            if year in early_years:
                early_kw[kw] += 1
            elif year in late_years:
                late_kw[kw] += 1

    # Find terms that grew significantly
    growing = []
    declining = []
    for kw in set(early_kw) | set(late_kw):
        e = early_kw.get(kw, 0)
        la = late_kw.get(kw, 0)
        if e + la < 5:
            continue
        if la > e * 2 and la >= 5:
            growing.append((kw, e, la))
        elif e > la * 2 and e >= 5:
            declining.append((kw, e, la))

    if growing:
        growing.sort(key=lambda x: x[2], reverse=True)
        top_growing = [g[0] for g in growing[:5]]
        insights.append({
            "category": "migration",
            "title": "Emerging Research Directions",
            "description": (
                f"Topics with significant recent growth: "
                f"{', '.join(top_growing)}."
            ),
            "importance": 0.85,
            "evidence": {"growing_topics": top_growing},
        })

    if declining:
        declining.sort(key=lambda x: x[1], reverse=True)
        top_declining = [d[0] for d in declining[:5]]
        insights.append({
            "category": "migration",
            "title": "Declining Research Areas",
            "description": (
                f"Topics with decreasing attention: "
                f"{', '.join(top_declining)}."
            ),
            "importance": 0.65,
            "evidence": {"declining_topics": top_declining},
        })

    return insights


def _detect_imbalance(articles: list[dict], stats: dict) -> list[dict]:
    """Detect supply-demand imbalances in research focus."""
    insights = []

    kw_df = stats.get("top_keywords")
    pub_type_df = stats.get("pub_type_distribution")

    if pub_type_df is not None and not pub_type_df.empty:
        rct_count = 0
        review_count = 0
        for _, row in pub_type_df.iterrows():
            pt = row["pub_type"].lower()
            if "randomized" in pt or "clinical trial" in pt:
                rct_count += row["count"]
            if "review" in pt or "meta-analysis" in pt:
                review_count += row["count"]

        total = len(articles)
        if total > 50:
            rct_ratio = rct_count / total
            review_ratio = review_count / total

            if review_ratio > rct_ratio * 2 and review_ratio > 0.1:
                insights.append({
                    "category": "imbalance",
                    "title": "Review-Heavy, Evidence-Lean",
                    "description": (
                        f"Reviews/meta-analyses ({review_ratio:.0%}) far exceed "
                        f"original clinical trials ({rct_ratio:.0%}), suggesting "
                        f"a potential need for more primary research."
                    ),
                    "importance": 0.75,
                    "evidence": {
                        "rct_ratio": rct_ratio,
                        "review_ratio": review_ratio,
                    },
                })

    return insights


def _detect_maturity(articles: list[dict], stats: dict) -> list[dict]:
    """Assess field maturity based on evidence structure."""
    insights = []

    year_df = stats.get("year_trend")
    if year_df is None or year_df.empty or len(year_df) < 3:
        return insights

    # Exclude partial (current incomplete) year from growth calculation
    if "is_partial" in year_df.columns:
        complete_df = year_df[~year_df["is_partial"]]
    else:
        complete_df = year_df

    if complete_df.empty or len(complete_df) < 3:
        return insights

    counts = complete_df["count"].values
    earlier = int(counts[-3])
    recent = int(counts[-1])
    if earlier >= 5:
        recent_growth = (recent - earlier) / earlier
    else:
        recent_growth = 1.0 if recent > earlier else (0.0 if recent == earlier else -0.5)

    if len(counts) >= 5:
        prev = int(counts[-5])
        if prev >= 5:
            earlier_growth = (int(counts[-3]) - prev) / prev
        else:
            earlier_growth = recent_growth
    else:
        earlier_growth = recent_growth

    total = len(articles)
    # Use complete-year counts for stage determination
    stage = "emerging"
    if total > 1000 and recent_growth < 0:
        stage = "declining"
    elif total > 500 and recent_growth < 0.2:
        stage = "mature"
    elif total > 200 and recent_growth > 0.3:
        stage = "rapid growth"
    elif total < 100:
        stage = "nascent"

    # Format growth description safely
    if earlier >= 5:
        growth_desc = f"{recent_growth:+.0%} recent change"
    else:
        trend_word = "growing" if recent > earlier else ("declining" if recent < earlier else "stable")
        growth_desc = f"{trend_word}, {earlier} → {recent} articles"

    insights.append({
        "category": "maturity",
        "title": f"Field Maturity: {stage.title()}",
        "description": (
            f"With {total} total publications and "
            f"{'growing' if recent_growth > 0 else 'declining'} trend "
            f"({growth_desc}), this field appears "
            f"to be in a {stage} stage."
        ),
        "importance": 0.8,
        "evidence": {
            "total": total,
            "stage": stage,
            "recent_growth": recent_growth,
        },
    })

    return insights


def _detect_emerging(stats: dict) -> list[dict]:
    """Identify genuinely new frontiers from frontier data."""
    insights = []

    frontiers = stats.get("frontiers", {})
    frontier_df = frontiers.get("frontier_topics", pd.DataFrame())
    if frontier_df is None or (isinstance(frontier_df, pd.DataFrame) and frontier_df.empty):
        return insights

    top3 = frontier_df.head(3)
    topics = ", ".join(top3["topic"].tolist())
    insights.append({
        "category": "emerging",
        "title": "Research Frontiers Identified",
        "description": (
            f"Key emerging frontiers: {topics}. "
            f"These show high growth, novelty, and/or burst activity."
        ),
        "importance": 0.9,
        "evidence": {"frontier_topics": top3.to_dict("records")},
    })

    return insights


def _detect_paradox(
    articles: list[dict], stats: dict, networks: dict
) -> list[dict]:
    """Detect counter-intuitive patterns (e.g., high volume ≠ high centrality)."""
    insights = []

    kw_net = networks.get("keyword", {})
    centrality = kw_net.get("centrality", {})
    kw_df = stats.get("top_keywords")

    if not centrality or kw_df is None or kw_df.empty:
        return insights

    top_freq = set(kw_df.head(10)["keywords_merged"])
    top_central = sorted(
        centrality.items(),
        key=lambda x: x[1].get("betweenness", 0),
        reverse=True,
    )[:10]
    top_central_names = set(n for n, _ in top_central)

    high_freq_low_central = top_freq - top_central_names
    low_freq_high_central = top_central_names - top_freq

    if high_freq_low_central and low_freq_high_central:
        insights.append({
            "category": "paradox",
            "title": "Frequency vs. Centrality Mismatch",
            "description": (
                f"High-frequency but low-centrality terms: "
                f"{', '.join(list(high_freq_low_central)[:3])}. "
                f"Low-frequency but high-centrality (bridging) terms: "
                f"{', '.join(list(low_freq_high_central)[:3])}. "
                f"The bridging terms may represent underexplored connections."
            ),
            "importance": 0.7,
            "evidence": {
                "freq_not_central": list(high_freq_low_central),
                "central_not_freq": list(low_freq_high_central),
            },
        })

    return insights
