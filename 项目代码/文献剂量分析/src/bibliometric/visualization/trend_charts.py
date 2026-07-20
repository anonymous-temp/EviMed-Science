# [IN] statistical summaries (DataFrames)
# [OUT] PNG chart files in figures/ directory
# [POS] src/bibliometric/visualization/trend_charts.py - basic charts

from __future__ import annotations

import logging
import os as _os
import subprocess as _sp
import threading
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.font_manager as _fm
import matplotlib.pyplot as plt
import pandas as pd

logger = logging.getLogger(__name__)

# matplotlib 全局线程锁：防止并发图表创建时 plt 全局状态污染
_MATPLOTLIB_LOCK = threading.Lock()

# ── 3-layer CJK font detection ──
_CN_FONT_CANDIDATES = [
    "Microsoft YaHei", "SimHei", "SimSun",
    "WenQuanYi Micro Hei", "WenQuanYi Zen Hei",
    "Noto Sans CJK SC", "Noto Sans SC",
    "Source Han Sans SC", "Source Han Sans CN",
    "PingFang SC", "Heiti SC", "STHeiti",
    "Droid Sans Fallback", "Arial Unicode MS",
]
_available_fonts = {f.name for f in _fm.fontManager.ttflist}
_cn_font = next((f for f in _CN_FONT_CANDIDATES if f in _available_fonts), None)

if _cn_font:
    plt.rcParams["font.sans-serif"] = [_cn_font, "DejaVu Sans"]
    logger.info("matplotlib CJK font (cache): %s", _cn_font)
else:
    # Layer 2: fc-list + hardcoded paths (Linux/macOS)
    _cjk_path = None
    try:
        _out = _sp.check_output(
            ["fc-list", ":lang=zh", "--format=%{file}\n"],
            stderr=_sp.DEVNULL, timeout=5,
        ).decode("utf-8", errors="ignore")
        for _raw in _out.splitlines():
            _p = _raw.strip().split(":")[0].strip()
            if _p and _os.path.exists(_p):
                _cjk_path = _p
                break
    except Exception:
        pass
    if _cjk_path is None:
        for _p in [
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/opentype/wqy/wqy-microhei.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        ]:
            if _os.path.exists(_p):
                _cjk_path = _p
                break
    if _cjk_path:
        _fm.fontManager.addfont(_cjk_path)
        _prop = _fm.FontProperties(fname=_cjk_path)
        plt.rcParams["font.sans-serif"] = [_prop.get_name(), "DejaVu Sans"]
        logger.info("matplotlib CJK font (fc-list/path): %s", _cjk_path)
    else:
        # Layer 3: scan system font directories
        _cjk_paths = [
            p for p in
            _fm.findSystemFonts(fontext="ttf") + _fm.findSystemFonts(fontext="otf")
            if any(k in p.lower() for k in
                   ["cjk", "chinese", "noto", "wqy", "simsun", "simhei", "yahei"])
        ]
        if _cjk_paths:
            _fm.fontManager.addfont(_cjk_paths[0])
            _prop = _fm.FontProperties(fname=_cjk_paths[0])
            plt.rcParams["font.sans-serif"] = [_prop.get_name(), "DejaVu Sans"]
            logger.info("matplotlib CJK font (scan): %s", _cjk_paths[0])
        else:
            plt.rcParams["font.sans-serif"] = ["DejaVu Sans"]
            logger.warning("No CJK font found; Chinese characters may render as boxes.")

plt.rcParams["axes.unicode_minus"] = False

# Style config
plt.rcParams.update({
    "figure.figsize": (10, 6),
    "figure.dpi": 96,
    "font.size": 11,
    "axes.titlesize": 14,
    "axes.labelsize": 12,
    "savefig.dpi": 96,
    "savefig.bbox": "tight",
})

COLORS = [
    "#2196F3", "#4CAF50", "#FF9800", "#E91E63", "#9C27B0",
    "#00BCD4", "#FF5722", "#795548", "#607D8B", "#3F51B5",
]

# 国家名称英译中字典
_COUNTRY_ZH = {
    "China": "中国", "United States": "美国", "USA": "美国", "United Kingdom": "英国",
    "UK": "英国", "Germany": "德国", "Japan": "日本", "France": "法国",
    "Italy": "意大利", "Canada": "加拿大", "Australia": "澳大利亚", "Spain": "西班牙",
    "South Korea": "韩国", "Korea": "韩国", "Netherlands": "荷兰", "Switzerland": "瑞士",
    "Sweden": "瑞典", "India": "印度", "Brazil": "巴西", "Russia": "俄罗斯",
    "Poland": "波兰", "Belgium": "比利时", "Austria": "奥地利", "Denmark": "丹麦",
    "Norway": "挪威", "Finland": "芬兰", "Israel": "以色列", "Singapore": "新加坡",
    "Turkey": "土耳其", "Mexico": "墨西哥", "Argentina": "阿根廷", "Chile": "智利",
    "South Africa": "南非", "Egypt": "埃及", "Iran": "伊朗", "Saudi Arabia": "沙特阿拉伯",
    "Thailand": "泰国", "Malaysia": "马来西亚", "Indonesia": "印度尼西亚",
    "Pakistan": "巴基斯坦", "Bangladesh": "孟加拉国", "Vietnam": "越南",
    "Philippines": "菲律宾", "New Zealand": "新西兰", "Ireland": "爱尔兰",
    "Portugal": "葡萄牙", "Greece": "希腊", "Czech Republic": "捷克", "Hungary": "匈牙利",
    "Romania": "罗马尼亚", "Ukraine": "乌克兰", "Colombia": "哥伦比亚", "Peru": "秘鲁",
}


_LABELS_ZH = {
    "annual_title": "年度发文趋势",
    "annual_xlabel": "年份",
    "annual_ylabel": "发文量",
    "complete_years": "完整年份",
    "partial_year": "不完整年份（部分数据）",
    "top_authors": "主要作者",
    "top_institutions": "主要机构",
    "top_journals": "主要期刊",
    "top_countries": "主要国家/地区",
    "bar_xlabel": "数量",
    "kw_xlabel": "频次",
    "kw_title": "高频关键词",
    "wc_title": "关键词词云",
    "cite_year_title": "各年引用影响",
    "cite_year_xlabel": "年份",
    "cite_year_ylabel": "引用次数（估算）",
    "cite_mean": "均值",
    "cite_median": "中位数",
    "cite_top_title": "高引文献",
    "cite_top_xlabel": "估算引用次数",
}
_LABELS_EN = {
    "annual_title": "Annual Publication Trend",
    "annual_xlabel": "Year",
    "annual_ylabel": "Number of Publications",
    "complete_years": "Complete years",
    "partial_year": "Partial year (incomplete)",
    "top_authors": "Top Authors",
    "top_institutions": "Top Institutions",
    "top_journals": "Top Journals",
    "top_countries": "Top Countries",
    "bar_xlabel": "Count",
    "kw_xlabel": "Frequency",
    "kw_title": "Top Keywords",
    "wc_title": "Keyword Word Cloud",
    "cite_year_title": "Citation Impact by Year",
    "cite_year_xlabel": "Year",
    "cite_year_ylabel": "Citations (estimated)",
    "cite_mean": "Mean",
    "cite_median": "Median",
    "cite_top_title": "Top Cited Articles",
    "cite_top_xlabel": "Estimated Citations",
}


def generate_trend_charts(stats: dict, output_dir: str, lang: str = "en") -> list[str]:
    """Generate all basic trend charts. Returns list of saved file paths."""
    fig_dir = Path(output_dir) / "figures"
    fig_dir.mkdir(parents=True, exist_ok=True)

    L = _LABELS_ZH if lang == "zh" else _LABELS_EN

    with _MATPLOTLIB_LOCK:
        saved = []
        saved.extend(_plot_annual_trend(stats.get("year_trend"), fig_dir, L))
        saved.extend(_plot_top_bar(stats.get("top_authors"), L["top_authors"],
                                    "authors_normalized", fig_dir, "top_authors.png", L))
        saved.extend(_plot_top_bar(stats.get("top_institutions"), L["top_institutions"],
                                    "institutions", fig_dir, "top_institutions.png", L))
        saved.extend(_plot_top_bar(stats.get("top_journals"), L["top_journals"],
                                    "journal", fig_dir, "top_journals.png", L))
        saved.extend(_plot_top_bar(stats.get("top_countries"), L["top_countries"],
                                    "countries", fig_dir, "top_countries.png", L))
        saved.extend(_plot_keyword_frequency(stats.get("top_keywords"), fig_dir, L))
        saved.extend(_plot_wordcloud(stats.get("top_keywords"), fig_dir, L))
        saved.extend(_plot_citation_overview(stats.get("citation_stats", {}), fig_dir, L))
    return saved


def _plot_annual_trend(df: pd.DataFrame, fig_dir: Path, L: dict) -> list[str]:
    """Plot annual publication trend with bar+line chart (academic journal style)."""
    if df is None or df.empty:
        return []

    years = pd.to_numeric(df["year"], errors="coerce")
    counts = df["count"]

    # 根据年份数量动态调整图表宽度
    num_years = len(years)
    if num_years <= 3:
        figsize = (6, 6)
    elif num_years <= 5:
        figsize = (8, 6)
    else:
        figsize = (12, 6)

    fig, ax = plt.subplots(figsize=figsize)

    # 分离完整年份和不完整年份
    has_partial = "is_partial" in df.columns
    if has_partial:
        complete_mask = ~df["is_partial"]
        partial_mask = df["is_partial"]
        complete_years = years[complete_mask]
        complete_counts = counts[complete_mask]
        partial_years = years[partial_mask]
        partial_counts = counts[partial_mask]
    else:
        complete_years = years
        complete_counts = counts
        partial_years = pd.Series([], dtype=float)
        partial_counts = pd.Series([], dtype=float)

    # 绘制柱状图（完整年份：蓝色，不完整年份：橙色）
    if not complete_years.empty:
        bars1 = ax.bar(complete_years, complete_counts, color='#2E86AB', alpha=0.7,
               width=0.6, label=L.get("complete_years", "Complete years"), zorder=2)
        # 添加数值标签
        for bar in bars1:
            height = bar.get_height()
            ax.text(bar.get_x() + bar.get_width()/2., height,
                   f'{int(height)}', ha='center', va='bottom', fontsize=10)

    if has_partial and not partial_years.empty:
        bars2 = ax.bar(partial_years, partial_counts, color='#FF9800', alpha=0.7,
               width=0.6, label=L.get("partial_year", "Partial year"), zorder=2)
        # 添加数值标签
        for bar in bars2:
            height = bar.get_height()
            ax.text(bar.get_x() + bar.get_width()/2., height,
                   f'{int(height)}', ha='center', va='bottom', fontsize=10)

    # 设置坐标轴标签（加大字号）
    ax.set_xlabel(L["annual_xlabel"], fontsize=12, fontweight='bold')
    ax.set_ylabel(L["annual_ylabel"], fontsize=12, fontweight='bold')

    # 设置X轴刻度为整数年份
    valid_years = years.dropna().astype(int)
    ax.set_xticks(valid_years)
    ax.set_xticklabels([str(y) for y in valid_years],
                       rotation=45 if len(valid_years) > 10 else 0, ha="right", fontsize=10)
    ax.tick_params(axis='y', labelsize=10)

    # 优化网格线（仅Y轴，虚线样式）
    ax.grid(axis="y", alpha=0.3, linestyle='--', linewidth=0.7, zorder=1)
    ax.set_axisbelow(True)

    # 设置Y轴从0开始
    ax.set_ylim(bottom=0)

    # 当最大值较小时，强制使用整数刻度
    max_count = int(counts.max()) if hasattr(counts, 'max') else max(counts)
    if max_count <= 10:
        import matplotlib.ticker as ticker
        ax.yaxis.set_major_locator(ticker.MaxNLocator(integer=True))

    # 添加图例
    if has_partial and not partial_years.empty:
        ax.legend(loc="upper left", fontsize=10, framealpha=0.9)

    # 移除顶部和右侧边框
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)

    plt.tight_layout()

    path = fig_dir / "annual_trend.png"
    fig.savefig(path, dpi=150, bbox_inches="tight", facecolor="white", edgecolor="none")
    plt.close(fig)
    logger.info("Saved %s", path)
    return [str(path)]


def _plot_top_bar(
    df: pd.DataFrame, title: str, col: str,
    fig_dir: Path, filename: str, L: dict, top_n: int = 10,
) -> list[str]:
    """Plot horizontal bar chart for top-N items."""
    if df is None or df.empty:
        return []

    plot_df = df.head(top_n).iloc[::-1].copy()

    # 如果是国家列且为中文报告，翻译国家名称
    is_zh = L.get("annual_title") == "年度发文趋势"
    if col == "countries" and is_zh:
        plot_df[col] = plot_df[col].apply(lambda x: _COUNTRY_ZH.get(x, x))

    fig, ax = plt.subplots()
    bars = ax.barh(
        range(len(plot_df)),
        plot_df["count"],
        color=COLORS[0],
        alpha=0.85,
    )
    ax.set_yticks(range(len(plot_df)))
    ax.set_yticklabels(
        [_truncate(s, 40) for s in plot_df[col]],
        fontsize=9,
    )
    ax.set_xlabel(L["bar_xlabel"])

    for bar, val in zip(bars, plot_df["count"]):
        ax.text(
            bar.get_width() + 0.5, bar.get_y() + bar.get_height() / 2,
            str(val), va="center", fontsize=8,
        )

    plt.tight_layout()
    path = fig_dir / filename
    fig.savefig(path, dpi=96, bbox_inches="tight", facecolor="white", edgecolor="none")
    plt.close(fig)
    logger.info("Saved %s", path)
    return [str(path)]


def _plot_keyword_frequency(df: pd.DataFrame, fig_dir: Path, L: dict) -> list[str]:
    """Plot keyword frequency bar chart."""
    if df is None or df.empty:
        return []

    plot_df = df.head(20).iloc[::-1]
    fig, ax = plt.subplots(figsize=(10, 8))
    ax.barh(
        range(len(plot_df)),
        plot_df["count"],
        color=COLORS[1],
        alpha=0.85,
    )
    ax.set_yticks(range(len(plot_df)))
    ax.set_yticklabels(
        [_truncate(s, 45) for s in plot_df["keywords_merged"]],
        fontsize=9,
    )
    ax.set_xlabel(L["kw_xlabel"])
    plt.tight_layout()

    path = fig_dir / "top_keywords.png"
    fig.savefig(path, dpi=96, bbox_inches="tight", facecolor="white", edgecolor="none")
    plt.close(fig)
    logger.info("Saved %s", path)
    return [str(path)]


def _truncate(text: str, max_len: int) -> str:
    """Truncate text with ellipsis."""
    if len(text) > max_len:
        return text[: max_len - 3] + "..."
    return text


def _rotate_labels(ax, df: pd.DataFrame):
    """Rotate x-axis labels if too many."""
    if len(df) > 10:
        plt.xticks(rotation=45, ha="right")


def _plot_wordcloud(df: pd.DataFrame, fig_dir: Path, L: dict) -> list[str]:
    """Generate keyword word cloud."""
    if df is None or df.empty:
        return []

    try:
        from wordcloud import WordCloud
    except ImportError:
        return []

    freq_dict = {}
    for _, row in df.iterrows():
        freq_dict[row["keywords_merged"]] = int(row["count"])

    if not freq_dict:
        return []

    wc = WordCloud(
        width=1200, height=600,
        background_color="white",
        max_words=80,
        colormap="viridis",
        prefer_horizontal=0.7,
    )
    wc.generate_from_frequencies(freq_dict)

    fig, ax = plt.subplots(figsize=(12, 6))
    ax.imshow(wc, interpolation="bilinear")
    ax.axis("off")

    path = fig_dir / "keyword_wordcloud.png"
    fig.savefig(path, dpi=96, bbox_inches="tight", facecolor="white", edgecolor="none")
    plt.close(fig)
    logger.info("Saved %s", path)
    return [str(path)]


def _plot_citation_overview(cite_stats: dict, fig_dir: Path, L: dict) -> list[str]:
    """Plot citation distribution and top-cited papers."""
    if not cite_stats:
        return []

    saved = []

    year_stats = cite_stats.get("year_citation_stats")
    if year_stats is not None and not year_stats.empty:
        top_cited = cite_stats.get("top_cited")
        has_top = top_cited is not None and not top_cited.empty

        fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 10))

        years_numeric = pd.to_numeric(year_stats["year"], errors="coerce")
        ax1.bar(
            years_numeric, year_stats["mean_citations"],
            color=COLORS[0], alpha=0.7, label=L["cite_mean"],
        )
        ax1.plot(
            years_numeric, year_stats["median_citations"],
            color=COLORS[1], marker="o", linewidth=2, label=L["cite_median"],
        )
        ax1.set_xlabel(L["cite_year_xlabel"])
        ax1.set_ylabel(L["cite_year_ylabel"])
        ax1.legend()
        valid_y = years_numeric.dropna().astype(int)
        ax1.set_xticks(valid_y)
        ax1.set_xticklabels([str(y) for y in valid_y], rotation=45, ha="right", fontsize=9)

        if has_top:
            top10 = top_cited.head(10).iloc[::-1]
            titles = [_truncate(t, 60) for t in top10["title"]]
            ax2.barh(range(len(top10)), top10["citations"],
                     color=COLORS[3], alpha=0.85)
            ax2.set_yticks(range(len(top10)))
            ax2.set_yticklabels(titles, fontsize=8)
            ax2.set_xlabel(L["cite_top_xlabel"])
        else:
            ax2.set_visible(False)

        plt.tight_layout()
        path = fig_dir / "citation_overview.png"
        fig.savefig(path, dpi=96, bbox_inches="tight", facecolor="white", edgecolor="none")
        plt.close(fig)
        logger.info("Saved %s", path)
        saved.append(str(path))

    return saved
