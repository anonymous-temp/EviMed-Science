# [IN] list of normalized article dicts
# [OUT] dict of statistical summaries (year_trend, top_authors, etc.)
# [POS] src/bibliometric/analysis/statistics.py - basic descriptive stats

from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime

import pandas as pd

logger = logging.getLogger(__name__)


def compute_statistics(articles: list[dict], date_to: str = "") -> dict:
    """Compute all basic statistics from normalized articles."""
    stats = {
        "total_articles": len(articles),
        "year_trend": _year_trend(articles, date_to=date_to),
        "top_authors": _top_items(articles, "authors_normalized", 20),
        "top_institutions": _top_items(articles, "institutions", 20),
        "top_journals": _top_journal(articles, 20),
        "top_countries": _top_items(articles, "countries", 20),
        "top_keywords": _top_items(articles, "keywords_merged", 30),
        "pub_type_distribution": _pub_type_dist(articles),
    }
    logger.info("Computed statistics for %d articles", len(articles))
    return stats


def _year_trend(articles: list[dict], date_to: str = "") -> pd.DataFrame:
    """Count articles per year, marking the current year as partial if date_to is current year."""
    years = [a.get("year", "") for a in articles if a.get("year")]
    year_counts = Counter(years)
    df = pd.DataFrame(
        sorted(year_counts.items()),
        columns=["year", "count"],
    )
    df["year"] = df["year"].astype(str)

    # Mark current (incomplete) year
    now = datetime.now()
    current_year = str(now.year)
    current_month = now.month
    df["is_partial"] = df["year"] == current_year
    df["annualized_count"] = df["count"]

    # 数据异常检测：当前年份（不完整）的发文量异常高
    if current_month < 12 and current_year in df["year"].values:
        current_count = df.loc[df["year"] == current_year, "count"].iloc[0]
        # 计算年化后的预估值
        annualized = int(current_count * 12 / current_month)
        df.loc[df["is_partial"], "annualized_count"] = annualized

        # 如果当前年份（不完整）的实际发文量已超过历史任何完整年份，标记异常
        complete_years = df[~df["is_partial"]]
        if not complete_years.empty:
            max_complete = complete_years["count"].max()
            if current_count > max_complete:
                logger.warning(
                    f"数据异常：{current_year}年仅{current_month}个月已有{current_count}篇文献，"
                    f"超过历史完整年份最高值{max_complete}篇。请检查数据质量（可能存在年份标注错误）。"
                )
                df["data_quality_warning"] = df["year"] == current_year

    return df


def _top_items(
    articles: list[dict], field: str, top_n: int
) -> pd.DataFrame:
    """Count top-N items from a list-valued field."""
    counter = Counter()
    for art in articles:
        items = art.get(field, [])
        if isinstance(items, list):
            for item in items:
                if item:
                    counter[item] += 1
    top = counter.most_common(top_n)
    return pd.DataFrame(top, columns=[field, "count"])


def _top_journal(articles: list[dict], top_n: int) -> pd.DataFrame:
    """Count top journals by title."""
    counter = Counter()
    for art in articles:
        journal = art.get("journal", {})
        if isinstance(journal, str):
            name = journal
        else:
            name = journal.get("title", "") or journal.get("iso", "")
        if name:
            counter[name] += 1
    top = counter.most_common(top_n)
    return pd.DataFrame(top, columns=["journal", "count"])


def _pub_type_dist(articles: list[dict]) -> pd.DataFrame:
    """Distribution of publication types."""
    counter = Counter()
    for art in articles:
        for pt in art.get("pub_types", []):
            counter[pt] += 1
    top = counter.most_common(20)
    return pd.DataFrame(top, columns=["pub_type", "count"])


def save_statistics(stats: dict, output_dir) -> None:
    """Save statistical tables as CSV files."""
    from pathlib import Path

    tables_dir = Path(output_dir) / "tables"
    tables_dir.mkdir(parents=True, exist_ok=True)

    for key in ["top_authors", "top_institutions", "top_journals",
                 "top_countries", "top_keywords", "pub_type_distribution"]:
        df = stats.get(key)
        if df is not None and isinstance(df, pd.DataFrame) and not df.empty:
            filename = f"{key}.csv"
            df.to_csv(tables_dir / filename, index=False)
            logger.info("Saved %s", filename)

    year_df = stats.get("year_trend")
    if year_df is not None and not year_df.empty:
        year_df.to_csv(tables_dir / "year_trend.csv", index=False)
