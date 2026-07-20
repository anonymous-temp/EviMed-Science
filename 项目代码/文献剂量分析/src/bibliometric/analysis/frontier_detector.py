# [IN] articles, burst results, cluster_labels, keyword network, output_dir
# [OUT] frontier topics list with scores and evidence
# [POS] src/bibliometric/analysis/frontier_detector.py - research frontier identification

from __future__ import annotations

import logging
import re
from collections import Counter
from pathlib import Path

import pandas as pd

logger = logging.getLogger(__name__)


def detect_frontiers(
    articles: list[dict],
    burst_data: dict,
    cluster_labels: dict[int, dict],
    keyword_network: dict,
    output_dir: str,
    recent_years: int = 3,
    query: str = "",
    lang: str = "en",
) -> dict:
    """Identify research frontiers based on composite scoring."""
    if not articles:
        return {"frontier_topics": pd.DataFrame()}

    years = sorted(set(a.get("year", "") for a in articles if a.get("year")))
    if len(years) < 2:
        return {"frontier_topics": pd.DataFrame()}

    recent_cutoff = years[-recent_years] if len(years) >= recent_years else years[0]

    # Build set of query terms to exclude from frontiers
    stop_terms = set()
    if query:
        for token in re.split(r'[\s,;/\-\+\(\)\"]+', query.lower()):
            token = token.strip()
            if len(token) >= 3:
                stop_terms.add(token)

    topic_scores = _compute_frontier_scores(
        articles, burst_data, cluster_labels,
        keyword_network, years, recent_cutoff, stop_terms,
        lang=lang,
    )

    df = pd.DataFrame(topic_scores)
    if not df.empty:
        df = df.sort_values("frontier_score", ascending=False).head(20)
        df = df.reset_index(drop=True)

    _save_frontiers(df, output_dir)

    return {"frontier_topics": df, "recent_cutoff": recent_cutoff}


def _compute_frontier_scores(
    articles, burst_data, cluster_labels,
    keyword_network, years, recent_cutoff, stop_terms=None,
    lang: str = "en",
) -> list[dict]:
    """Compute frontier score for each candidate topic."""
    growth_scores = _compute_growth(articles, years, recent_cutoff)
    burst_scores = _extract_burst_scores(burst_data)
    novelty_scores = _compute_novelty(articles, years, recent_cutoff)
    density_scores = _compute_centrality_scores(keyword_network)

    all_topics = set(growth_scores) | set(burst_scores) | set(novelty_scores)

    # Filter out query search terms — they are baseline, not frontiers
    if stop_terms:
        all_topics = {
            t for t in all_topics
            if t.lower() not in stop_terms
        }

    # Collect raw scores first, then min-max normalize across all topics
    raw_scores = []
    for topic in all_topics:
        raw_scores.append({
            "topic": topic,
            "growth": growth_scores.get(topic, 0),
            "burst": burst_scores.get(topic, 0),
            "novelty": novelty_scores.get(topic, 0),
            "centrality": density_scores.get(topic, 0),
        })

    if not raw_scores:
        return []

    # Min-max normalization per dimension
    for dim in ["growth", "burst", "novelty", "centrality"]:
        vals = [r[dim] for r in raw_scores]
        mn, mx = min(vals), max(vals)
        spread = mx - mn if mx > mn else 1.0
        for r in raw_scores:
            r[f"{dim}_norm"] = (r[dim] - mn) / spread

    results = []
    for r in raw_scores:
        frontier_score = (
            0.35 * r["growth_norm"]
            + 0.25 * r["burst_norm"]
            + 0.25 * r["novelty_norm"]
            + 0.15 * r["centrality_norm"]
        )

        if frontier_score < 0.1:
            continue

        evidence = _build_evidence(
            r["topic"], r["growth"], r["burst"],
            r["novelty"], r["centrality"], lang=lang,
        )
        results.append({
            "topic": r["topic"],
            "frontier_score": round(frontier_score, 3),
            "growth_rate": round(r["growth"], 3),
            "burst_score": round(r["burst"], 2),
            "novelty_score": round(r["novelty"], 3),
            "centrality": round(r["centrality"], 3),
            "evidence": evidence,
        })

    return results


def _compute_growth(
    articles: list[dict], years: list, recent_cutoff: str
) -> dict[str, float]:
    """Compute recent growth rate for each keyword."""
    recent_freq = Counter()
    total_freq = Counter()

    for art in articles:
        year = art.get("year", "")
        for kw in art.get("keywords_merged", []):
            total_freq[kw] += 1
            if year >= recent_cutoff:
                recent_freq[kw] += 1

    growth = {}
    for kw, total in total_freq.items():
        if total < 3:
            continue
        recent = recent_freq.get(kw, 0)
        growth[kw] = recent / max(total, 1)

    return growth


def _extract_burst_scores(burst_data: dict) -> dict[str, float]:
    """Extract burst scores from burst detection results."""
    burst_df = burst_data.get("burst_terms", pd.DataFrame())
    if burst_df is None or (isinstance(burst_df, pd.DataFrame) and burst_df.empty):
        return {}

    scores = {}
    for _, row in burst_df.iterrows():
        term = row.get("term", "")
        score = row.get("burst_strength", row.get("burst_score", 0))
        if term:
            scores[term] = max(scores.get(term, 0), score)
    return scores


def _compute_novelty(
    articles: list[dict], years: list, recent_cutoff: str
) -> dict[str, float]:
    """Compute novelty: ratio of first appearances in recent period."""
    first_seen = {}
    for art in articles:
        year = art.get("year", "")
        for kw in art.get("keywords_merged", []):
            if kw not in first_seen or year < first_seen[kw]:
                first_seen[kw] = year

    novelty = {}
    for kw, first_year in first_seen.items():
        if first_year >= recent_cutoff:
            novelty[kw] = 1.0
        else:
            total_years = len(years)
            year_idx = years.index(first_year) if first_year in years else 0
            novelty[kw] = year_idx / max(total_years, 1)

    return novelty


def _compute_centrality_scores(keyword_network: dict) -> dict[str, float]:
    """Compute network centrality score for each term (betweenness)."""
    centrality = keyword_network.get("centrality", {})
    scores = {}
    for term, metrics in centrality.items():
        scores[term] = metrics.get("betweenness", 0)
    return scores


def _build_evidence(
    topic: str, growth: float, burst: float,
    novelty: float, density: float,
    lang: str = "en",
) -> str:
    """Build human-readable evidence string."""
    if lang == "zh":
        parts = []
        if growth > 0.5:
            parts.append(f"近期快速增长（{growth:.0%}）")
        if burst > 2:
            parts.append(f"检测到突现（得分={burst:.1f}）")
        if novelty > 0.7:
            parts.append("相对新颖的主题")
        if density > 0.1:
            parts.append(f"网络中心性高（{density:.2f}）")
        return "；".join(parts) if parts else "中等信号"
    else:
        parts = []
        if growth > 0.5:
            parts.append(f"rapid growth ({growth:.0%} recent)")
        if burst > 2:
            parts.append(f"burst detected (score={burst:.1f})")
        if novelty > 0.7:
            parts.append("relatively novel topic")
        if density > 0.1:
            parts.append(f"high network centrality ({density:.2f})")
        return "; ".join(parts) if parts else "moderate signal"


def _save_frontiers(df: pd.DataFrame, output_dir: str):
    """Save frontier topics to CSV."""
    if df.empty:
        return
    tables_dir = Path(output_dir) / "tables"
    tables_dir.mkdir(parents=True, exist_ok=True)
    df.to_csv(tables_dir / "frontier_topics.csv", index=False)
    logger.info("Saved frontier_topics.csv (%d topics)", len(df))
