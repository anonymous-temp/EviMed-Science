# [IN] list of normalized article dicts
# [OUT] dict of co-occurrence/collaboration matrices (as DataFrames)
# [POS] src/bibliometric/analysis/matrix_builder.py - co-occurrence matrices

from __future__ import annotations

import logging
from collections import Counter
from itertools import combinations

import pandas as pd

logger = logging.getLogger(__name__)


def build_matrices(
    articles: list[dict], min_count: int = 2
) -> dict[str, pd.DataFrame]:
    """Build all co-occurrence and collaboration matrices."""
    matrices = {
        "keyword_cooccurrence": _build_cooccurrence(
            articles, "keywords_merged", min_count
        ),
        "author_collaboration": _build_cooccurrence(
            articles, "authors_normalized", min_count
        ),
        "institution_collaboration": _build_cooccurrence(
            articles, "institutions", min_count
        ),
        "country_collaboration": _build_cooccurrence(
            articles, "countries", min_count
        ),
    }
    for name, df in matrices.items():
        logger.info("Matrix '%s': %d edges", name, len(df))
    return matrices


def _build_cooccurrence(
    articles: list[dict], field: str, min_count: int
) -> pd.DataFrame:
    """Build edge list from co-occurrence of items within articles."""
    item_freq = Counter()
    pair_freq = Counter()

    for art in articles:
        items = art.get(field, [])
        if not isinstance(items, list):
            continue
        unique_items = list(dict.fromkeys(items))
        for item in unique_items:
            item_freq[item] += 1
        for a, b in combinations(unique_items, 2):
            pair = tuple(sorted([a, b]))
            pair_freq[pair] += 1

    frequent = {k for k, v in item_freq.items() if v >= min_count}

    edges = []
    for (a, b), weight in pair_freq.items():
        if a in frequent and b in frequent and weight >= 1:
            edges.append({
                "source": a,
                "target": b,
                "weight": weight,
                "source_freq": item_freq[a],
                "target_freq": item_freq[b],
            })

    df = pd.DataFrame(edges)
    if not df.empty:
        df = df.sort_values("weight", ascending=False).reset_index(drop=True)
    return df


def save_matrices(matrices: dict[str, pd.DataFrame], output_dir: str):
    """Save matrices as CSV files."""
    from pathlib import Path

    data_dir = Path(output_dir) / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    for name, df in matrices.items():
        if not df.empty:
            df.to_csv(data_dir / f"{name}.csv", index=False)
            logger.info("Saved %s.csv", name)
