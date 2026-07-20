# [IN] list of normalized articles, output_dir
# [OUT] burst detection results (DataFrame + chart data)
# [POS] src/bibliometric/analysis/burst_detector.py - Kleinberg burst detection

from __future__ import annotations

import logging
import math
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


def detect_bursts(
    articles: list[dict],
    output_dir: str,
    min_freq: int = 3,
    max_states: int = 2,
    gamma: float = 1.0,
    s: float = 2.0,
    lang: str = "en",
) -> dict:
    """Detect burst terms using Kleinberg's automaton model."""
    year_term_freq, year_totals = _build_year_term_matrix(articles)
    if not year_term_freq:
        return {"burst_terms": pd.DataFrame(), "chart_data": []}

    years = sorted(year_term_freq.keys())
    all_terms = _get_frequent_terms(year_term_freq, min_freq)

    burst_results = []
    for term in all_terms:
        freqs = [year_term_freq[y].get(term, 0) for y in years]
        totals = [year_totals.get(y, 1) for y in years]
        bursts = _kleinberg_burst(freqs, totals, years, max_states, gamma, s)
        for b in bursts:
            b["term"] = term
            burst_results.append(b)

    burst_results.sort(key=lambda x: x["burst_strength"], reverse=True)
    burst_df = pd.DataFrame(burst_results)
    if not burst_df.empty:
        burst_df = burst_df.head(25)

    _save_bursts(burst_df, years, output_dir)
    _plot_bursts(burst_df, years, output_dir, lang=lang)

    return {
        "burst_terms": burst_df,
        "years": years,
        "year_term_freq": year_term_freq,
    }


def _build_year_term_matrix(articles: list[dict]):
    """Build year → {term: count} and year → total_count."""
    year_term = defaultdict(Counter)
    year_totals = Counter()
    for art in articles:
        year = str(art.get("year", ""))
        if not year:
            continue
        kws = art.get("keywords_merged", [])
        for kw in kws:
            year_term[year][kw] += 1
        year_totals[year] += len(kws)
    return dict(year_term), dict(year_totals)


def _get_frequent_terms(year_term_freq, min_freq):
    """Get terms with total frequency >= min_freq."""
    total = Counter()
    for year_counts in year_term_freq.values():
        total.update(year_counts)
    return [t for t, c in total.items() if c >= min_freq]


def _kleinberg_burst(
    freqs: list[int],
    totals: list[int],
    years: list[str],
    max_states: int = 2,
    gamma: float = 1.0,
    s: float = 2.0,
) -> list[dict]:
    """Kleinberg automaton-based burst detection.

    Based on: Kleinberg, J. (2003). Bursty and Hierarchical Structure
    in Streams. Data Mining and Knowledge Discovery, 7(4), 373-397.

    States: 0 = baseline, 1 = elevated (burst)
    Transitions penalized by gamma * ln(n).
    """
    n = len(freqs)
    if n < 2:
        return []

    total_all = sum(totals)
    total_freq = sum(freqs)
    if total_freq == 0 or total_all == 0:
        return []

    # Base rate (global proportion)
    p0 = total_freq / total_all
    if p0 <= 0 or p0 >= 1:
        return []

    # State rates: p[j] = p0 * s^j
    num_states = max_states
    rates = [min(p0 * (s ** j), 0.999) for j in range(num_states)]

    # Transition cost
    trans_cost = gamma * math.log(n)

    # Viterbi-like forward pass
    costs = np.full((n, num_states), np.inf)
    path = np.zeros((n, num_states), dtype=int)

    for j in range(num_states):
        costs[0][j] = _emission_cost(freqs[0], totals[0], rates[j])
        if j > 0:
            costs[0][j] += j * trans_cost

    for t in range(1, n):
        for j in range(num_states):
            emit = _emission_cost(freqs[t], totals[t], rates[j])
            for prev_j in range(num_states):
                tc = 0
                if j > prev_j:
                    tc = (j - prev_j) * trans_cost
                total_cost = costs[t - 1][prev_j] + tc + emit
                if total_cost < costs[t][j]:
                    costs[t][j] = total_cost
                    path[t][j] = prev_j

    # Backtrack
    states = np.zeros(n, dtype=int)
    states[-1] = np.argmin(costs[-1])
    for t in range(n - 2, -1, -1):
        states[t] = path[t + 1][states[t + 1]]

    # Extract burst intervals (state > 0)
    bursts = []
    in_burst = False
    start_idx = 0

    for i in range(n):
        if states[i] > 0 and not in_burst:
            in_burst = True
            start_idx = i
        elif states[i] == 0 and in_burst:
            end_idx = i - 1
            strength = sum(freqs[start_idx:end_idx + 1])
            max_state = int(max(states[start_idx:end_idx + 1]))
            bursts.append({
                "burst_start": years[start_idx],
                "burst_end": years[end_idx],
                "burst_strength": round(float(strength), 2),
                "burst_level": max_state,
                "duration": end_idx - start_idx + 1,
            })
            in_burst = False

    # Handle burst that extends to the last position
    if in_burst:
        end_idx = n - 1
        strength = sum(freqs[start_idx:end_idx + 1])
        max_state = int(max(states[start_idx:end_idx + 1]))
        bursts.append({
            "burst_start": years[start_idx],
            "burst_end": years[end_idx],
            "burst_strength": round(float(strength), 2),
            "burst_level": max_state,
            "duration": end_idx - start_idx + 1,
        })

    return bursts


def _emission_cost(freq, total, rate):
    """Negative log-likelihood of binomial emission."""
    if total == 0:
        return 0
    p = max(min(rate, 0.999), 0.001)
    if freq == 0:
        return -total * math.log(1 - p)
    if freq >= total:
        return -total * math.log(p)
    cost = -(freq * math.log(p) + (total - freq) * math.log(1 - p))
    return cost


def _save_bursts(burst_df, years, output_dir):
    """Save burst terms to CSV."""
    if burst_df is None or burst_df.empty:
        return
    tables_dir = Path(output_dir) / "tables"
    tables_dir.mkdir(parents=True, exist_ok=True)
    burst_df.to_csv(tables_dir / "burst_terms.csv", index=False)
    logger.info("Saved burst_terms.csv (%d terms)", len(burst_df))


def _plot_bursts(burst_df, years, output_dir, lang: str = "en"):
    """Plot burst terms timeline chart."""
    if burst_df is None or burst_df.empty:
        return

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    _title = "爆发词检测（Kleinberg）" if lang == "zh" else "Burst Terms (Kleinberg Detection)"
    _xlabel = "年份" if lang == "zh" else "Year"

    top = burst_df.head(20)
    fig, ax = plt.subplots(figsize=(12, max(6, len(top) * 0.45)))

    colors = ["#E91E63", "#D32F2F", "#B71C1C"]

    for i, (_, row) in enumerate(top.iterrows()):
        start = str(row["burst_start"])
        end = str(row["burst_end"])
        term = row["term"]
        level = int(row.get("burst_level", 1))

        start_pos = years.index(start) if start in years else 0
        end_pos = years.index(end) if end in years else len(years) - 1

        color = colors[min(level - 1, len(colors) - 1)]
        ax.barh(
            i, end_pos - start_pos + 1, left=start_pos,
            height=0.6, color=color, alpha=0.7 + 0.1 * level,
        )
        label = f"{term} (str={row['burst_strength']:.0f})"
        ax.text(-0.5, i, label, ha="right", va="center", fontsize=8)

    ax.set_yticks([])
    tick_step = max(1, len(years) // 10)
    tick_idx = list(range(0, len(years), tick_step))
    ax.set_xticks(tick_idx)
    ax.set_xticklabels([years[i] for i in tick_idx], rotation=45)
    ax.set_title(_title, fontsize=14, fontweight="bold")
    ax.set_xlabel(_xlabel)

    plt.tight_layout()
    fig_dir = Path(output_dir) / "figures"
    fig_dir.mkdir(parents=True, exist_ok=True)
    fig.savefig(fig_dir / "burst_terms.png", dpi=96, bbox_inches="tight",
                facecolor="white", edgecolor="none")
    plt.close(fig)
    logger.info("Saved burst_terms.png")
