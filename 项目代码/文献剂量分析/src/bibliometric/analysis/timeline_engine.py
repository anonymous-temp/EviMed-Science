# [IN] clusters, articles, cluster_labels, output_dir
# [OUT] timeline data (cluster × year activity matrix) + chart
# [POS] src/bibliometric/analysis/timeline_engine.py - timeline clustering

from __future__ import annotations

import logging
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


def build_timeline(
    clusters: dict[int, list[str]],
    articles: list[dict],
    cluster_labels: dict[int, dict],
    output_dir: str,
    lang: str = "en",
) -> dict:
    """Build timeline data showing cluster activity over years."""
    if not clusters:
        return {"timeline_matrix": pd.DataFrame(), "cluster_periods": []}

    years = sorted(set(str(a.get("year", "")) for a in articles if a.get("year")))
    if not years:
        return {"timeline_matrix": pd.DataFrame(), "cluster_periods": []}

    activity_matrix = _build_activity_matrix(clusters, articles, years)
    cluster_periods = _identify_active_periods(activity_matrix, years)

    timeline = {
        "timeline_matrix": activity_matrix,
        "cluster_periods": cluster_periods,
        "years": years,
    }

    _save_timeline(timeline, cluster_labels, output_dir)
    _plot_timeline(timeline, cluster_labels, output_dir, lang=lang)

    return timeline


def _build_activity_matrix(
    clusters: dict[int, list[str]],
    articles: list[dict],
    years: list[str],
) -> pd.DataFrame:
    """Build cluster × year activity matrix."""
    cluster_year = defaultdict(Counter)

    # Pre-compute lowered term sets per cluster
    cluster_term_sets = {
        cid: set(t.lower() for t in terms)
        for cid, terms in clusters.items()
    }

    for art in articles:
        year = art.get("year", "")
        if not year:
            continue
        year = str(year)
        kws = set(k.lower() for k in art.get("keywords_merged", []))
        for cid, term_set in cluster_term_sets.items():
            overlap = len(kws & term_set)
            if overlap > 0:
                cluster_year[cid][year] += overlap

    data = {}
    for cid in sorted(clusters.keys()):
        data[cid] = [cluster_year[cid].get(y, 0) for y in years]

    return pd.DataFrame(data, index=years).T


def _identify_active_periods(
    matrix: pd.DataFrame, years: list[str]
) -> list[dict]:
    """Identify active time period for each cluster."""
    periods = []
    for cid in matrix.index:
        row = matrix.loc[cid].values
        if row.sum() == 0:
            continue

        nonzero = np.where(row > 0)[0]
        start = years[nonzero[0]]
        end = years[nonzero[-1]]
        peak_idx = np.argmax(row)
        peak = years[peak_idx]

        total = int(row.sum())
        n_years = len(row)
        recent_n = min(3, n_years)
        recent = int(row[-recent_n:].sum()) if recent_n > 0 else total
        # Normalize thresholds by time span proportion
        recent_proportion = recent_n / max(n_years, 1)
        trend = "growing" if recent / max(total, 1) > recent_proportion * 1.5 else "stable"
        if recent / max(total, 1) < recent_proportion * 0.3:
            trend = "declining"

        periods.append({
            "cluster_id": cid,
            "start_year": start,
            "end_year": end,
            "peak_year": peak,
            "total_activity": total,
            "recent_activity": recent,
            "trend": trend,
        })

    return periods


def _save_timeline(
    timeline: dict, cluster_labels: dict, output_dir: str
):
    """Save timeline data to CSV."""
    tables_dir = Path(output_dir) / "tables"
    tables_dir.mkdir(parents=True, exist_ok=True)

    periods = timeline.get("cluster_periods", [])
    if not periods:
        return

    rows = []
    for p in periods:
        cid = p["cluster_id"]
        label = cluster_labels.get(cid, {}).get("en_label", f"Cluster {cid}")
        rows.append({
            "cluster": label,
            **{k: v for k, v in p.items() if k != "cluster_id"},
        })

    df = pd.DataFrame(rows)
    df.to_csv(tables_dir / "cluster_summary.csv", index=False)
    logger.info("Saved cluster_summary.csv")


def _plot_timeline(
    timeline: dict, cluster_labels: dict, output_dir: str, lang: str = "en"
):
    """Plot timeline clusters chart."""
    matrix = timeline.get("timeline_matrix")
    if matrix is None or matrix.empty:
        return

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    _title = "研究主题时间演化" if lang == "zh" else "Research Timeline by Cluster"
    _xlabel = "年份" if lang == "zh" else "Year"
    _trend_marker = {"growing": "↑", "declining": "↓", "stable": "→"}

    years = timeline.get("years", [])
    periods = timeline.get("cluster_periods", [])
    if not periods:
        return

    fig, ax = plt.subplots(figsize=(14, max(6, len(periods) * 0.5)))

    colors = [
        "#E91E63", "#2196F3", "#4CAF50", "#FF9800", "#9C27B0",
        "#00BCD4", "#FF5722", "#795548", "#607D8B", "#3F51B5",
    ]

    for i, p in enumerate(periods):
        cid = p["cluster_id"]
        label = cluster_labels.get(cid, {}).get("en_label", f"Cluster {cid}")
        start_idx = years.index(p["start_year"]) if p["start_year"] in years else 0
        end_idx = years.index(p["end_year"]) if p["end_year"] in years else len(years) - 1
        peak_idx = years.index(p["peak_year"]) if p["peak_year"] in years else start_idx

        color = colors[i % len(colors)]
        ax.barh(
            i, end_idx - start_idx + 1, left=start_idx,
            height=0.6, color=color, alpha=0.5,
        )
        ax.plot(peak_idx, i, "D", color=color, markersize=8)

        short_label = label[:35] + "..." if len(label) > 35 else label
        ax.text(-0.5, i, short_label, ha="right", va="center", fontsize=8)

        ax.text(
            end_idx + 0.5, i,
            _trend_marker.get(p["trend"], ""),
            ha="left", va="center", fontsize=10,
        )

    ax.set_yticks([])
    tick_step = max(1, len(years) // 10)
    tick_indices = list(range(0, len(years), tick_step))
    ax.set_xticks(tick_indices)
    ax.set_xticklabels([years[i] for i in tick_indices], rotation=45)
    ax.set_title(_title, fontsize=14, fontweight="bold")
    ax.set_xlabel(_xlabel)

    plt.tight_layout()
    fig_dir = Path(output_dir) / "figures"
    fig_dir.mkdir(parents=True, exist_ok=True)
    fig.savefig(fig_dir / "timeline_clusters.png", dpi=96, bbox_inches="tight",
                facecolor="white", edgecolor="none")
    plt.close(fig)
    logger.info("Saved timeline_clusters.png")
