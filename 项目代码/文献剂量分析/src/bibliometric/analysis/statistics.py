# [IN] list of normalized article dicts
# [OUT] dict of statistical summaries (year_trend, top_authors, etc.)
# [POS] src/bibliometric/analysis/statistics.py - basic descriptive stats

from __future__ import annotations

import json
import logging
from collections import Counter

import pandas as pd

logger = logging.getLogger(__name__)


def compute_statistics(articles: list[dict], date_to: str = "", *, date_from: str = "") -> dict:
    """Compute all basic statistics from normalized articles."""
    stats = {
        "total_articles": len(articles),
        "year_trend": _year_trend(articles),
        "trend_coverage": {
            "status": "selected_records", "query_from": date_from, "query_to": date_to,
            "query_date_field": "pdat" if date_from or date_to else "unrestricted",
            "year_basis_counts": dict(Counter(a.get("year_basis") or "unknown" for a in articles)),
        },
        "top_authors": _top_items(articles, "authors_normalized", 20),
        "top_institutions": _top_items(articles, "institutions", 20),
        "top_journals": _top_journal(articles, 20),
        "top_countries": _top_items(articles, "countries", 20),
        "top_keywords": _top_items(articles, "keywords_merged", 30),
        "pub_type_distribution": _pub_type_dist(articles),
    }
    logger.info("Computed statistics for %d articles", len(articles))
    return stats


def _year_trend(articles: list[dict]) -> pd.DataFrame:
    """Count observed bibliographic years without guessing calendar coverage."""
    years = [str(a["year"]) for a in articles if a.get("year")]
    return pd.DataFrame(sorted(Counter(years).items()), columns=["year", "count"])


def trend_coverage_note(stats: dict, lang: str = "en") -> str:
    """Describe the query and the selected sample, never a calendar census."""
    coverage = stats.get("trend_coverage")
    if not isinstance(coverage, dict):
        return ("按记录年份汇总样本文献；检索日期边界和年份来源未记录，年度覆盖程度未知。"
                if lang == "zh" else "Selected records are grouped by recorded year; query date bounds and year provenance were not recorded. Calendar coverage is unknown.")
    start = _coverage_bound(coverage, "query_from", lang)
    end = _coverage_bound(coverage, "query_to", lang)
    if lang == "zh":
        window = f"检索日期范围：{start}—{end}。"
        return ("按记录年份汇总本次选入样本文献。" + window
                + "记录年份可来自期刊出版年、Medline日期或索引完成年，与检索日期字段不同。"
                + "年度覆盖程度未经确认；以上为实际记录数，不作全年外推。")
    window = f"Query date bounds: {start} to {end}. "
    return ("Counts describe selected records grouped by recorded year. " + window
            + "Recorded years may use journal issue dates, Medline dates or indexing completion, distinct from the query date field. "
            + "Calendar coverage is unverified; observed counts are not extrapolated.")


def _coverage_bound(coverage: dict, key: str, lang: str) -> str:
    value = coverage.get(key)
    if not isinstance(value, str):
        return "未知" if lang == "zh" else "unknown"
    if value == "":
        return "未限定" if lang == "zh" else "unbounded"
    return value


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
        (tables_dir / "year_trend_coverage.json").write_text(
            json.dumps(stats.get("trend_coverage", {"status": "unknown"}), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
