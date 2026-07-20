# [IN] ctx dict (stats, networks, output_dir, counters)
# [OUT] Markdown strings for Results subsections
# [POS] src/bibliometric/report/results_sections.py - Results section generators

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path

import pandas as pd

logger = logging.getLogger(__name__)

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
    "Portugal": "葡萄牙", "Greece": "希腊", "Czech Republic": "捷克",
}


def _get_narrative(ctx: dict, key: str) -> str:
    """Return an AI/template narrative paragraph for a Results subsection."""
    text = ctx["stats"].get("ai_narratives", {}).get(key, "")
    if not text:
        return ""
    return f"\n{text}\n"


def _zh(ctx: dict) -> bool:
    """Return True if the report should be in Chinese."""
    return ctx.get("lang") == "zh"


def _next_fig(ctx: dict) -> int:
    """Increment and return the next figure number."""
    ctx["fig_counter"] += 1
    return ctx["fig_counter"]


def _next_table(ctx: dict) -> int:
    """Increment and return the next table number."""
    ctx["table_counter"] += 1
    return ctx["table_counter"]


def _df_to_table(
    df: pd.DataFrame, columns: list[str], headers: list[str]
) -> str:
    """Convert DataFrame to Markdown table."""
    lines = []
    lines.append("| " + " | ".join(headers) + " |")
    lines.append("| " + " | ".join(["---"] * len(headers)) + " |")

    for _, row in df.iterrows():
        vals = []
        for col in columns:
            val = row.get(col, "")
            if isinstance(val, float):
                vals.append(f"{val:.3f}")
            else:
                s = str(val).replace("|", "\\|").replace("\n", " ")
                vals.append(s)
        lines.append("| " + " | ".join(vals) + " |")

    return "\n".join(lines)


def _results_overview(ctx):
    stats = ctx["stats"]
    zh = _zh(ctx)
    n = ctx["n"]

    # PRISMA 筛选流程表（从方法部分移至结果开头）
    lines = [("## 3. 结果\n" if zh else "## 3. Results\n")]

    # 添加 PRISMA 表
    excluded_clean = ctx["after_dedup"] - n
    if zh:
        lines.append("### 3.1 文献筛选流程（PRISMA适用性改编）\n")
        lines.append("| 阶段 | 操作 | 记录数 |")
        lines.append("|------|------|--------|")
        lines.append(f"| 检索 | MEDLINE (via PubMed) 数据库检索 | {ctx['total_found']:,} |")
        lines.append(f"| 获取 | API 批量获取全文记录 | {ctx['total_fetched']:,} |")
        lines.append(f"| 去重 | 去重后剩余记录 | {ctx['after_dedup']:,} |")
        if excluded_clean > 0:
            lines.append(f"| 排除 | 排除（元数据缺失/无法解析）| -{excluded_clean:,} |")
        lines.append(f"| 纳入 | 最终纳入分析 | {n:,} |")
        if ctx["total_found"] > ctx["total_fetched"]:
            pct = ctx["total_fetched"] / ctx["total_found"] * 100
            max_r = ctx.get("max_records", 0)
            lines.append(
                f"\n> **抽样说明：** PubMed 共返回 {ctx['total_found']:,} 条记录，"
                f"受检索上限（max_records={max_r}）限制，本次分析了 {ctx['total_fetched']:,} 篇"
                f"（占总量的 {pct:.1f}%）。结果应理解为对全部文献的代表性样本。\n"
            )
    else:
        lines.append("### 3.1 Study Selection (PRISMA-Adapted Flow)\n")
        lines.append("| Stage | Action | Records |")
        lines.append("|-------|--------|---------|")
        lines.append(f"| Identification | MEDLINE (via PubMed) database search | {ctx['total_found']:,} |")
        lines.append(f"| Retrieval | API batch fetch of full records | {ctx['total_fetched']:,} |")
        lines.append(f"| Screening | After deduplication | {ctx['after_dedup']:,} |")
        if excluded_clean > 0:
            lines.append(f"| Excluded | Missing/unparseable metadata | -{excluded_clean:,} |")
        lines.append(f"| Included | Final analysis | {n:,} |")
        if ctx["total_found"] > ctx["total_fetched"]:
            pct = ctx["total_fetched"] / ctx["total_found"] * 100
            max_r = ctx.get("max_records", 0)
            lines.append(
                f"\n> **Sampling note:** PubMed returned {ctx['total_found']:,} records. "
                f"Due to the retrieval limit (max_records={max_r}), "
                f"{ctx['total_fetched']:,} were analyzed ({pct:.1f}% of available). "
                f"Results represent a sample of the full literature.\n"
            )

    lines.append(("### 3.2 发文趋势\n" if zh else "### 3.2 Publication Trends\n"))

    year_df = stats.get("year_trend")
    if year_df is not None and not year_df.empty:
        total = int(year_df["count"].sum())
        # Use only complete years for peak and trend comparison
        has_partial = "is_partial" in year_df.columns
        complete_df = year_df[~year_df["is_partial"]] if has_partial else year_df
        partial_df = year_df[year_df["is_partial"]] if has_partial else pd.DataFrame()

        peak_row = complete_df.loc[complete_df["count"].idxmax()] if not complete_df.empty else year_df.loc[year_df["count"].idxmax()]
        fig = _next_fig(ctx)
        if zh:
            lines.append(
                f"研究时段内（{ctx['year_range']}）共检索到 {total} 篇文献，"
                f"发文高峰年份为 {peak_row['year']}（{int(peak_row['count'])} 篇，图{fig}）。"
            )
        else:
            lines.append(
                f"A total of {total} publications were identified spanning "
                f"{ctx['year_range']}. The peak publication year was "
                f"{peak_row['year']} with {int(peak_row['count'])} articles "
                f"(Figure {fig})."
            )

        counts = complete_df["count"].values if not complete_df.empty else year_df["count"].values
        if len(counts) >= 3:
            recent = int(counts[-1])
            earlier = int(counts[-3])
            if earlier >= 5:
                change = (recent - earlier) / earlier
                if zh:
                    trend = "上升" if change > 0.1 else ("下降" if change < -0.1 else "相对稳定")
                    lines.append(
                        f" 近3年完整数据显示发文量总体呈{trend}趋势（{earlier} → {recent} 篇）。"
                    )
                else:
                    trend = "increasing" if change > 0.1 else (
                        "decreasing" if change < -0.1 else "relatively stable"
                    )
                    lines.append(
                        f" The overall trajectory is {trend} "
                        f"({earlier} → {recent} articles over the most recent 3-year window of complete data)."
                    )
            else:
                if zh:
                    trend = "上升" if recent > earlier else ("下降" if recent < earlier else "相对稳定")
                    lines.append(
                        f" 近3年完整数据显示发文量总体呈{trend}趋势（{earlier} → {recent} 篇）。"
                    )
                else:
                    trend = "increasing" if recent > earlier else (
                        "decreasing" if recent < earlier else "stable"
                    )
                    lines.append(
                        f" The overall trajectory is {trend} "
                        f"({earlier} → {recent} articles over the most recent 3-year window of complete data)."
                    )

        if zh:
            lines.append(
                "\n![Annual Publication Trend](figures/annual_trend.png)\n"
                f"\n图{fig}. 年度发文趋势分析"
            )
        else:
            lines.append(
                "\n![Annual Publication Trend](figures/annual_trend.png)\n"
                f"\nFigure {fig}. Annual Publication Trend Analysis"
            )

        # Partial year annotation
        if not partial_df.empty:
            row = partial_df.iloc[0]
            from datetime import datetime
            month_name = datetime.now().strftime("%B")
            annualized = int(row.get("annualized_count", row["count"]))
            if zh:
                lines.append(
                    f"\n> **注：** {row['year']}年数据不完整（截至{month_name}），"
                    f"年化估算约{annualized}篇，趋势对比仅使用完整自然年数据。"
                )
            else:
                lines.append(
                    f"\n> **Note:** {row['year']} data is partial (Jan–{month_name}). "
                    f"Annualized estimate: ~{annualized} articles. "
                    f"Trend comparisons above use only complete calendar years."
                )

        lines.append(_get_narrative(ctx, "results_trends"))

    return "\n".join(lines)


def _results_contributors(ctx):
    stats = ctx["stats"]
    zh = _zh(ctx)
    lines = ["### 3.3 主要贡献者\n" if zh else "### 3.3 Key Contributors\n"]
    sub = 1

    # Authors
    author_df = stats.get("top_authors")
    if author_df is not None and not author_df.empty:
        max_pub = int(author_df.iloc[0]["count"])
        lines.append(f"#### 3.3.{sub} 高产作者\n" if zh else f"#### 3.3.{sub} Prolific Authors\n")
        if max_pub > 1:
            tbl = _next_table(ctx)
            if zh:
                lines.append(
                    f"表{tbl}. 高产作者发文量Top10\n"
                )
            else:
                lines.append(
                    f"Table {tbl}. Top 10 Most Productive Authors\n"
                )
            lines.append(_df_to_table(
                author_df.head(10),
                ["authors_normalized", "count"],
                (["作者", "发文量"] if zh else ["Author", "Publications"]),
            ))
            lines.append(_get_narrative(ctx, "results_authors"))
        else:
            if zh:
                lines.append(
                    "该数据集中无作者发表超过1篇文献，提示作者分布高度分散。"
                )
            else:
                lines.append(
                    "No author published more than one article in this dataset, "
                    "indicating a highly dispersed authorship pattern."
                )
        sub += 1

    # Institutions
    inst_df = stats.get("top_institutions")
    if inst_df is not None and not inst_df.empty:
        lines.append(f"\n#### 3.3.{sub} {'机构' if zh else 'Leading Institutions'}\n")
        tbl = _next_table(ctx)
        lines.append(
            f"{'表' if zh else 'Table '}{tbl}. {'高产机构发文量Top10' if zh else 'Top 10 Institutions by Publication Count'}\n"
        )
        lines.append(_df_to_table(
            inst_df.head(10),
            ["institutions", "count"],
            (["机构", "发文量"] if zh else ["Institution", "Publications"]),
        ))
        lines.append(_get_narrative(ctx, "results_institutions"))
        sub += 1

    # Journals
    journal_df = stats.get("top_journals")
    if journal_df is not None and not journal_df.empty:
        lines.append(f"\n#### 3.3.{sub} {'期刊' if zh else 'Core Journals'}\n")
        tbl = _next_table(ctx)
        lines.append(
            f"{'表' if zh else 'Table '}{tbl}. {'高产期刊发文量Top10' if zh else 'Top 10 Journals by Publication Count'}\n"
        )
        lines.append(_df_to_table(
            journal_df.head(10),
            ["journal", "count"],
            (["期刊", "发文量"] if zh else ["Journal", "Publications"]),
        ))
        lines.append(_get_narrative(ctx, "results_journals"))
        sub += 1

    # Countries
    country_df = stats.get("top_countries")
    if country_df is not None and not country_df.empty:
        lines.append(f"\n#### 3.3.{sub} {'国家/地区' if zh else 'Geographic Distribution'}\n")
        tbl = _next_table(ctx)
        lines.append(
            f"{'表' if zh else 'Table '}{tbl}. {'国家/地区发文量分布' if zh else 'Distribution of Publications by Country/Region'}\n"
        )
        # 如果是中文报告，翻译国家名称
        display_df = country_df.head(10).copy()
        if zh:
            display_df["countries"] = display_df["countries"].apply(lambda x: _COUNTRY_ZH.get(x, x))
        lines.append(_df_to_table(
            display_df,
            ["countries", "count"],
            (["国家/地区", "发文量"] if zh else ["Country/Region", "Publications"]),
        ))
        lines.append(_get_narrative(ctx, "results_countries"))

    return "\n".join(lines)


def _results_knowledge_structure(ctx):
    stats = ctx["stats"]
    networks = ctx["networks"]
    zh = _zh(ctx)
    lines = ["### 3.4 知识结构\n" if zh else "### 3.4 Knowledge Structure\n"]
    sub = 1

    kw_net = networks.get("keyword", {})
    if kw_net:
        lines.append(
            f"#### 3.4.{sub} {'关键词共现网络' if zh else 'Keyword Co-occurrence Network'}\n"
        )
        quality = kw_net.get("quality", {})
        q_val = quality.get("modularity", 0)
        s_val = quality.get("silhouette", 0)
        n_clusters = quality.get("num_clusters", len(kw_net.get("clusters", {})))

        if zh:
            lines.append(
                f"关键词共现网络包含 {kw_net.get('node_count', 0)} 个节点和 "
                f"{kw_net.get('edge_count', 0)} 条边。"
                f"Louvain社区检测共识别出 {n_clusters} 个聚类 "
                f"（模块度 Q = {q_val:.4f}，平均轮廓系数 S = {s_val:.4f}）。"
            )
        else:
            lines.append(
                f"The keyword co-occurrence network comprises "
                f"{kw_net.get('node_count', 0)} nodes and "
                f"{kw_net.get('edge_count', 0)} edges. "
                f"Louvain community detection identified {n_clusters} clusters "
                f"(Modularity Q = {q_val:.4f}, Mean Silhouette S = {s_val:.4f})."
            )

        if q_val >= 0.3:
            if zh:
                lines.append(
                    " 模块度值超过0.3，表明社区结构划分清晰（Newman, 2006）。"
                )
            else:
                lines.append(
                    " The modularity value exceeds 0.3, indicating a well-defined "
                    "community structure (Newman, 2006)."
                )
        elif q_val >= 0.1:
            if zh:
                lines.append(
                    " 模块度值低于0.3，表明社区结构较弱，聚类边界解读需谨慎。"
                )
            else:
                lines.append(
                    " The modularity value is below 0.3, indicating a weak community "
                    "structure. Cluster boundaries should be interpreted cautiously."
                )
        else:
            if zh:
                lines.append(
                    "\n> **警告：** 模块度 Q < 0.1，表明社区结构不具统计显著性。"
                    "以下聚类结果需极度谨慎解读，网络未表现出有意义的主题划分。"
                )
            else:
                lines.append(
                    "\n> **Warning:** Modularity Q < 0.1 indicates that the community "
                    "structure is not statistically significant. The clustering results "
                    "below should be interpreted with extreme caution, as the network "
                    "does not exhibit meaningful thematic partitioning."
                )

        fig = _next_fig(ctx)
        lines.append("\n![Keyword Network](figures/keyword_network.png)")
        lines.append(f"\n\n{'图' if zh else 'Figure '}{fig}. {'关键词共现网络分析' if zh else 'Keyword Co-occurrence Network Analysis'}\n")

        centrality = kw_net.get("centrality", {})
        if centrality:
            top_central = sorted(
                centrality.items(),
                key=lambda x: x[1].get("betweenness", 0),
                reverse=True,
            )[:10]
            tbl = _next_table(ctx)
            lines.append(
                f"{'表' if zh else 'Table '}{tbl}. {'桥接关键词（介数中心性）' if zh else 'Bridging Keywords (Betweenness Centrality)'}\n"
            )
            if zh:
                lines.append("| 关键词 | 介数中心性 | 度中心性 | 加权度 |")
                lines.append("|--------|-----------|---------|-------|")
            else:
                lines.append("| Keyword | Betweenness | Degree | Weighted Degree |")
                lines.append("|---------|------------|--------|-----------------|")
            for name, m in top_central:
                lines.append(
                    f"| {name} | {m['betweenness']:.4f} | "
                    f"{m['degree']:.4f} | {m.get('weighted_degree', 0)} |"
                )
        lines.append(_get_narrative(ctx, "results_keyword_network"))
        sub += 1

    cluster_labels = stats.get("cluster_labels", {})
    if cluster_labels:
        lines.append(f"\n#### 3.4.{sub} {'研究聚类' if zh else 'Research Clusters'}\n")
        tbl = _next_table(ctx)
        lines.append(
            f"{'表' if zh else 'Table '}{tbl}. {'研究聚类标签与主题分类' if zh else 'Research Cluster Labels and Thematic Categories'}\n"
        )
        _cat_zh = {"therapy": "治疗", "mechanism": "机制", "diagnosis": "诊断",
                   "safety": "安全性", "epidemiology": "流行病学", "implementation": "应用"}
        if zh:
            lines.append("| 聚类 | 标签 | 类别 | 规模 |")
            lines.append("|------|------|------|------|")
        else:
            lines.append("| Cluster | Label | Category | Size |")
            lines.append("|---------|-------|----------|------|")
        for cid, info in sorted(cluster_labels.items()):
            cat_raw = info.get('category', 'N/A')
            cat_display = _cat_zh.get(cat_raw, cat_raw) if zh else cat_raw
            label_col = (info.get('zh_label') or info.get('en_label', 'N/A')) if zh else info.get('en_label', 'N/A')
            lines.append(
                f"| #{cid} | {label_col} | "
                f"{cat_display} | {info.get('size', 0)} |"
            )
        lines.append(_get_narrative(ctx, "results_clusters"))
        sub += 1

    author_net = networks.get("author", {})
    if author_net and author_net.get("node_count", 0) > 0:
        lines.append(f"\n#### 3.4.{sub} {'作者合作网络' if zh else 'Author Collaboration Network'}\n")
        a_nodes = author_net.get("node_count", 0)
        a_edges = author_net.get("edge_count", 0)
        a_density = 2 * a_edges / (a_nodes * (a_nodes - 1)) if a_nodes > 1 else 0
        a_clusters = author_net.get("clusters", {})
        a_components = author_net.get("components", [])
        a_centrality = author_net.get("centrality", {})

        if zh:
            lines.append(
                f"作者合作网络包含 {a_nodes} 位作者和 {a_edges} 条合作连接"
                f"（密度 = {a_density:.4f}）。"
            )
        else:
            lines.append(
                f"The author collaboration network contains "
                f"{a_nodes} authors and {a_edges} collaborative links "
                f"(density = {a_density:.4f})."
            )

        # Component fragmentation analysis
        if a_components:
            largest = a_components[0].get("size", 0)
            n_components = len(a_components)
            frag_ratio = largest / a_nodes if a_nodes > 0 else 0
            if frag_ratio < 0.5:
                if zh:
                    lines.append(
                        f" 网络分裂为{n_components}个以上连通分量，"
                        f"最大分量仅含{largest}位作者"
                        f"（占网络的{frag_ratio:.0%}）。这种碎片化提示各研究团队相对孤立，跨团队合作有限。"
                    )
                else:
                    lines.append(
                        f" The network is fragmented into {n_components}+ components, "
                        f"with the largest containing only {largest} authors "
                        f"({frag_ratio:.0%} of the network). This fragmentation suggests "
                        f"that research groups operate in relative isolation, with limited "
                        f"cross-team collaboration."
                    )
            else:
                if zh:
                    lines.append(
                        f" 最大连通分量包含{largest}位作者（{frag_ratio:.0%}），"
                        f"表明存在较为凝聚的合作核心。"
                    )
                else:
                    lines.append(
                        f" The largest connected component encompasses {largest} authors "
                        f"({frag_ratio:.0%}), indicating a reasonably cohesive "
                        f"collaboration core."
                    )

        # Top collaborators by degree
        if a_centrality:
            top_collab = sorted(
                a_centrality.items(),
                key=lambda x: x[1].get("weighted_degree", 0),
                reverse=True,
            )[:3]
            if zh:
                collab_names = [f"{n}（度={m.get('weighted_degree', 0):.0f}）"
                               for n, m in top_collab]
            else:
                collab_names = [f"{n} (degree={m.get('weighted_degree', 0):.0f})"
                               for n, m in top_collab]
            if zh:
                lines.append(
                    f" 合作最多的作者为{', '.join(collab_names)}，"
                    f"他们作为枢纽连接多个研究团队。"
                )
            else:
                lines.append(
                    f" The most collaborative authors are {', '.join(collab_names)}, "
                    f"who serve as hubs connecting multiple research teams."
                )

        fig = _next_fig(ctx)
        lines.append("\n![Author Network](figures/author_network.png)")
        lines.append(f"\n\n{'图' if zh else 'Figure '}{fig}. {'作者合作网络分析' if zh else 'Author Collaboration Network Analysis'}")
        sub += 1

    country_net = networks.get("country", {})
    if country_net and country_net.get("node_count", 0) > 0:
        lines.append(f"\n#### 3.4.{sub} {'国际合作' if zh else 'International Collaboration'}\n")
        c_nodes = country_net.get("node_count", 0)
        c_edges = country_net.get("edge_count", 0)
        c_density = 2 * c_edges / (c_nodes * (c_nodes - 1)) if c_nodes > 1 else 0
        max_possible = c_nodes * (c_nodes - 1) // 2
        c_centrality = country_net.get("centrality", {})

        if zh:
            lines.append(
                f"国家合作网络包含 {c_nodes} 个国家，"
                f"共 {c_edges} 条合作连接"
                f"（密度 = {c_density:.4f}，{c_edges}/{max_possible} 对可能组合）。"
            )
        else:
            lines.append(
                f"The country collaboration network comprises {c_nodes} countries "
                f"with {c_edges} collaborative links "
                f"(density = {c_density:.4f}, {c_edges}/{max_possible} possible pairs)."
            )

        if c_density > 0.5:
            if zh:
                lines.append(
                    " 网络密度较高，表明国际合作广泛，大多数参与国存在直接共同署名关系。"
                )
            else:
                lines.append(
                    " The high network density indicates extensive international "
                    "collaboration, with most participating countries having direct "
                    "co-authorship ties."
                )
        elif c_density > 0.2:
            if zh:
                lines.append(
                    " 中等密度表明国际合作呈选择性伙伴关系，而非全体参与国的普遍合作。"
                )
            else:
                lines.append(
                    " The moderate density suggests selective international partnerships "
                    "rather than universal collaboration across all participating nations."
                )
        else:
            if zh:
                lines.append(
                    " 较低密度表明国际合作集中于少数国家对，大多数国家独立贡献。"
                )
            else:
                lines.append(
                    " The low density reveals that international collaboration is "
                    "concentrated among a few country pairs, with many nations "
                    "contributing independently."
                )

        # Identify hub countries and peripheral ones
        if c_centrality:
            top_hubs = sorted(
                c_centrality.items(),
                key=lambda x: x[1].get("degree", 0),
                reverse=True,
            )[:3]
            hub_names = [n for n, _ in top_hubs]
            peripheral = sorted(
                c_centrality.items(),
                key=lambda x: x[1].get("degree", 0),
            )[:2]
            peri_names = [n for n, _ in peripheral]

            if zh:
                lines.append(
                    f" {', '.join(hub_names)}具有最高的度中心性，充当跨区域知识传播的枢纽。"
                )
                if peri_names and len(c_centrality) > 5:
                    lines.append(
                        f" 相比之下，{', '.join(peri_names)}的连接性较低，"
                        f"提示这些国家的研究项目处于起步阶段或地理上较为孤立，可从扩展国际合作中获益。"
                    )
            else:
                lines.append(
                    f" {', '.join(hub_names)} serve as collaboration hubs with the "
                    f"highest degree centrality, acting as bridges for knowledge "
                    f"transfer across regions."
                )
                if peri_names and len(c_centrality) > 5:
                    lines.append(
                        f" In contrast, {', '.join(peri_names)} show lower connectivity, "
                        f"suggesting emerging or geographically isolated research programs "
                        f"that may benefit from expanded international partnerships."
                    )

        # Top country stats for context
        country_df = stats.get("top_countries")
        if country_df is not None and not country_df.empty:
            top3 = country_df.head(3)
            total_pubs = int(country_df["count"].sum())
            top3_pct = int(top3["count"].sum()) / total_pubs * 100 if total_pubs > 0 else 0
            if zh:
                lines.append(
                    f" 前三位国家（{', '.join(top3['countries'].tolist())}）"
                    f"占总产出的{top3_pct:.0f}%，反映出地理集中的研究格局。"
                )
            else:
                lines.append(
                    f" The top three countries ({', '.join(top3['countries'].tolist())}) "
                    f"account for {top3_pct:.0f}% of total output, reflecting a "
                    f"geographically concentrated research landscape."
                )

        fig = _next_fig(ctx)
        lines.append("\n![Country Network](figures/country_network.png)")
        lines.append(f"\n\n{'图' if zh else 'Figure '}{fig}. {'国家/地区合作网络分析' if zh else 'Country/Region Collaboration Network Analysis'}")

    return "\n".join(lines)


def _results_hotspots(ctx):
    stats = ctx["stats"]
    zh = _zh(ctx)
    lines = ["### 3.5 研究热点\n" if zh else "### 3.5 Research Hotspots\n"]

    kw_df = stats.get("top_keywords")
    burst_data = stats.get("bursts", {})
    burst_df = burst_data.get("burst_terms", pd.DataFrame())
    has_kw = kw_df is not None and not kw_df.empty
    has_burst = isinstance(burst_df, pd.DataFrame) and not burst_df.empty

    if has_kw or has_burst:
        tbl = _next_table(ctx)
        if zh:
            lines.append(
                "高频词反映领域核心研究议题；突现词（Kleinberg自动机算法）识别频次骤增的关键词，"
                "指示研究关注点的转移与新兴方向。\n"
            )
            lines.append(
                f"表{tbl}. 关键词热度综合分析（高频词 × 突现词检测）\n"
            )
            lines.append(
                "| 分析维度 | 词项 | 频次 | 突现强度 | 突现区间 | 持续时长（年） |"
            )
            lines.append(
                "| :------: | ---- | :--: | :------: | :------: | :-----------: |"
            )
            lines.append(
                "| **高频关键词** | | | | | |"
            )
        else:
            lines.append(
                "High-frequency terms reflect the core research topics of the field. "
                "Burst terms (Kleinberg's automaton algorithm) identify keywords with sudden "
                "frequency increases, signaling shifts in research attention and emerging directions.\n"
            )
            lines.append(
                f"Table {tbl}. Comprehensive Keyword Analysis: High-Frequency Terms × Burst Detection\n"
            )
            lines.append(
                "| Dimension | Keyword | Frequency | Burst Strength | Burst Period | Duration (yrs) |"
            )
            lines.append(
                "| :-------: | ------- | :-------: | :------------: | :----------: | :------------: |"
            )
            lines.append(
                "| **High-frequency** | | | | | |"
            )

        if has_kw:
            for _, row in kw_df.head(15).iterrows():
                kw = str(row.get("keywords_merged", "")).replace("|", "\\|")
                freq = int(row.get("count", 0))
                if zh:
                    lines.append(f"| 高频词 | {kw} | {freq} | — | — | — |")
                else:
                    lines.append(f"| High-freq | {kw} | {freq} | — | — | — |")

        if has_burst:
            if zh:
                lines.append("| **突现词（Kleinberg）** | | | | | |")
            else:
                lines.append("| **Burst terms (Kleinberg)** | | | | | |")
            for _, row in burst_df.head(15).iterrows():
                term = str(row.get("term", "")).replace("|", "\\|")
                strength = f"{row.get('burst_strength', 0):.2f}"
                b_start = str(row.get("burst_start", "—"))
                b_end = str(row.get("burst_end", "—"))
                period = f"{b_start}–{b_end}" if b_start != "—" else "—"
                duration = str(row.get("duration", "—"))
                if zh:
                    lines.append(f"| 突现词 | {term} | — | {strength} | {period} | {duration} |")
                else:
                    lines.append(f"| Burst | {term} | — | {strength} | {period} | {duration} |")

        lines.append("")

        # 词云图
        wc_path = Path(ctx.get("output_dir", "")) / "figures" / "keyword_wordcloud.png"
        if wc_path.exists():
            fig = _next_fig(ctx)
            lines.append("![Keyword Word Cloud](figures/keyword_wordcloud.png)")
            lines.append(f"\n{'图' if zh else 'Figure '}{fig}. {'关键词词云可视化' if zh else 'Keyword Word Cloud Visualization'}\n")

        # 突现词时间演化图
        if has_burst:
            fig2 = _next_fig(ctx)
            lines.append("![Burst Terms](figures/burst_terms.png)")
            lines.append(f"\n{'图' if zh else 'Figure '}{fig2}. {'突现词时间演化分析（Kleinberg算法）' if zh else 'Temporal Evolution of Burst Terms (Kleinberg Algorithm)'}")
            lines.append(_get_narrative(ctx, "results_hotspots"))

    return "\n".join(lines)


def _results_frontiers(ctx):
    stats = ctx["stats"]
    zh = _zh(ctx)
    lines = ["### 3.6 研究前沿\n" if zh else "### 3.6 Research Frontiers\n"]

    timeline = stats.get("timeline", {})
    periods = timeline.get("cluster_periods", [])
    if periods:
        lines.append("#### 3.6.1 时间演化\n" if zh else "#### 3.6.1 Temporal Evolution\n")
        n_periods = len(periods)
        year_span = ""
        if periods:
            all_starts = [p.get("start_year", "") for p in periods if p.get("start_year")]
            all_ends = [p.get("end_year", "") for p in periods if p.get("end_year")]
            if all_starts and all_ends:
                year_span = f" spanning {min(all_starts)}–{max(all_ends)}" if not zh else f"，时间跨度为{min(all_starts)}—{max(all_ends)}年"
        if zh:
            lines.append(
                f"时间线分析共识别出{n_periods}个聚类时期{year_span}。"
                f"下图展示了研究聚类的时间演化过程。"
            )
        else:
            lines.append(
                f"Timeline analysis identified {n_periods} cluster periods{year_span}. "
                f"The figure below illustrates the temporal evolution of research clusters."
            )
        fig = _next_fig(ctx)
        lines.append("\n![Timeline](figures/timeline_clusters.png)\n")
        lines.append(f"\n\n{'图' if zh else 'Figure '}{fig}. {'研究聚类时间演化分析' if zh else 'Temporal Evolution of Research Clusters'}")
        growing = [p for p in periods if p.get("trend") == "growing"]
        if growing:
            lines.append("**活跃增长聚类：**\n" if zh else "**Actively growing clusters:**\n")
            for p in growing[:5]:
                cid = p["cluster_id"]
                cluster_info = stats.get("cluster_labels", {}).get(cid, {})
                if zh:
                    label = cluster_info.get("zh_label") or cluster_info.get("en_label", f"聚类{cid}")
                    lines.append(
                        f"- {label}（{p['start_year']}—{p['end_year']}年，"
                        f"峰值年：{p['peak_year']}）"
                    )
                else:
                    label = cluster_info.get("en_label", f"Cluster {cid}")
                    lines.append(
                        f"- {label} ({p['start_year']}–{p['end_year']}, "
                        f"peak: {p['peak_year']})"
                    )
        else:
            if zh:
                lines.append(
                    "最近一期未发现持续增长的聚类，提示该领域可能处于整合阶段。"
                )
            else:
                lines.append(
                    "No clusters exhibited a sustained growth trend in the most recent period, "
                    "suggesting the field may be in a consolidation phase."
                )

    frontiers = stats.get("frontiers", {})
    frontier_df = frontiers.get("frontier_topics", pd.DataFrame())
    if isinstance(frontier_df, pd.DataFrame) and not frontier_df.empty:
        lines.append("\n#### 3.6.2 前沿主题\n" if zh else "\n#### 3.6.2 Frontier Topics\n")
        if zh:
            lines.append(
                "前沿得分通过最小-最大归一化综合计算：近期增长率（35%）、突现得分（25%）、新颖性（25%）和网络中心性（15%）。\n"
            )
        else:
            lines.append(
                "Frontier scores are computed via min-max normalized composite of "
                "recent growth rate (35%), burst score (25%), novelty (25%), and "
                "network centrality (15%).\n"
            )
        tbl = _next_table(ctx)
        cols = ["topic", "frontier_score", "growth_rate", "burst_score", "evidence"]
        headers = ["Topic", "Score", "Growth", "Burst", "Evidence"]
        headers_zh = ["主题", "前沿得分", "增长率", "突现得分", "证据"]
        available = [c for c in cols if c in frontier_df.columns]
        if zh:
            available_h = [headers_zh[cols.index(c)] for c in available]
        else:
            available_h = [headers[cols.index(c)] for c in available]
        lines.append(
            f"{'表' if zh else 'Table '}{tbl}. {'研究前沿主题识别' if zh else 'Research Frontier Topics Identification'}\n"
        )
        lines.append(_df_to_table(frontier_df.head(10), available, available_h))
        lines.append(_get_narrative(ctx, "results_frontiers"))

    return "\n".join(lines)


def _results_citation(ctx):
    stats = ctx["stats"]
    zh = _zh(ctx)
    cite_stats = stats.get("citation_stats", {})
    if not cite_stats:
        return ""

    real_count = stats.get("citation_real_count", 0)
    sim_count = stats.get("citation_sim_count", 0)
    total_count = real_count + sim_count
    all_real = sim_count == 0 and real_count > 0
    all_sim = real_count == 0

    if all_sim:
        return ""

    if all_real:
        section_title = "### 3.7 引用分析\n" if zh else "### 3.7 Citation Analysis\n"
        source_note = (
            f"引用数据来源于 Semantic Scholar（共{real_count}篇）。\n"
            if zh else
            f"Citation counts sourced from Semantic Scholar ({real_count} articles).\n"
        )
    else:
        pct = round(real_count / total_count * 100) if total_count else 0
        section_title = "### 3.7 引用分析\n" if zh else "### 3.7 Citation Analysis\n"
        source_note = (
            f"引用数据来源：{real_count}篇来自 Semantic Scholar（占{pct}%），{sim_count}篇为估算值。\n"
            if zh else
            f"Citation sources: {real_count} from Semantic Scholar ({pct}%), {sim_count} estimated.\n"
        )

    lines = [section_title, source_note]

    h_index = cite_stats.get("h_index", 0)
    total_c = cite_stats.get("total_citations", 0)
    mean_c = cite_stats.get("mean_citations", 0)
    median_c = cite_stats.get("median_citations", 0)

    tbl = _next_table(ctx)
    tbl_label = "文献引用指标" if (zh and all_real) else ("Citation Metrics" if (not zh and all_real) else ("文献引用指标估算" if zh else "Estimated Citation Metrics"))
    lines.append(f"{'表' if zh else 'Table '}{tbl}. {tbl_label}\n")
    if zh:
        lines.append("| 指标 | 数值 |")
        lines.append("|------|------|")
        h_label = "h 指数" if all_real else "估算 h 指数"
        lines.append(f"| {h_label} | {h_index} |")
        lines.append(f"| 总引用次数 | {total_c:,} |")
        lines.append(f"| 篇均引用次数 | {mean_c} |")
        lines.append(f"| 引用次数中位数 | {median_c} |")
    else:
        lines.append("| Metric | Value |")
        lines.append("|--------|-------|")
        h_label = "h-index" if all_real else "Estimated h-index"
        lines.append(f"| {h_label} | {h_index} |")
        lines.append(f"| Total citations | {total_c:,} |")
        lines.append(f"| Mean citations/paper | {mean_c} |")
        lines.append(f"| Median citations/paper | {median_c} |")

    top_cited = cite_stats.get("top_cited")
    if top_cited is not None and not top_cited.empty:
        tbl2 = _next_table(ctx)
        if all_real:
            top_label = "高被引文献Top10" if zh else "Top 10 Highly Cited Articles"
            col_label = ["标题", "引用次数", "年份"] if zh else ["Title", "Citations", "Year"]
        else:
            top_label = "高被引文献Top10（估算）" if zh else "Top 10 Highly Cited Articles (Estimated)"
            col_label = ["标题", "估算引用", "年份"] if zh else ["Title", "Est. Citations", "Year"]
        lines.append(f"\n{'表' if zh else 'Table '}{tbl2}. {top_label}\n")
        lines.append(_df_to_table(top_cited.head(10), ["title", "citations", "year"], col_label))

    fig_dir = Path(ctx.get("output_dir", "")) / "figures"
    if (fig_dir / "citation_overview.png").exists():
        fig = _next_fig(ctx)
        lines.append("\n![Citation Overview](figures/citation_overview.png)")
        lines.append(f"\n\n{'图' if zh else 'Figure '}{fig}. {'文献引用分析概览' if zh else 'Overview of Citation Analysis'}")
    lines.append(_get_narrative(ctx, "results_citation"))

    return "\n".join(lines)


def _results_bib_laws(ctx):
    stats = ctx["stats"]
    zh = _zh(ctx)
    bib_laws = stats.get("bib_laws", {})
    if not bib_laws:
        return ""

    lines = ["### 3.8 文献计量定律分析\n" if zh else "### 3.8 Bibliometric Law Analysis\n"]
    sub = 0

    lotka = bib_laws.get("lotka", {})
    if lotka.get("valid"):
        sub += 1
        lines.append(f"#### 3.8.{sub} 洛特卡定律（作者生产力）\n" if zh else f"#### 3.8.{sub} Lotka's Law (Author Productivity)\n")
        if zh:
            lines.append(
                f"观测指数为 {lotka['exponent']:.2f}（R² = {lotka['r_squared']:.4f}，p = {lotka['p_value']:.4g}）。"
            )
            if lotka.get("conforms"):
                lines.append("分布符合洛特卡定律，科学生产力呈典型幂律规律。")
            else:
                lines.append("分布偏离经典洛特卡定律（指数约为2.0）。")
            lines.append(
                f"\n{lotka['n_authors']}位作者中，"
                f"{lotka['one_paper_authors']}位（{lotka['pct_one_paper']:.0%}）仅发表了1篇文章。"
            )
        else:
            lines.append(
                f"The observed exponent is {lotka['exponent']:.2f} "
                f"(R² = {lotka['r_squared']:.4f}, p = {lotka['p_value']:.4g}). "
            )
            if lotka.get("conforms"):
                lines.append("The distribution conforms to Lotka's Law.")
            else:
                lines.append("The distribution deviates from the classical Lotka's Law (exponent ≈ 2.0).")
            lines.append(
                f"\nOf {lotka['n_authors']} total authors, "
                f"{lotka['one_paper_authors']} ({lotka['pct_one_paper']:.0%}) "
                f"published only one paper."
            )

    bradford = bib_laws.get("bradford", {})
    if bradford.get("valid"):
        sub += 1
        lines.append(f"\n#### 3.8.{sub} 布拉德福定律（期刊分散）\n" if zh else f"\n#### 3.8.{sub} Bradford's Law (Journal Scatter)\n")
        zones = bradford.get("zones", [])
        if zh:
            lines.append(f"共分析{bradford['total_journals']}种期刊，三区分布如下：\n")
        else:
            lines.append(f"{bradford['total_journals']} journals were analyzed across three zones:\n")
        if zones:
            if zh:
                lines.append("| 区域 | 期刊数 | 文章数 |")
                lines.append("|------|--------|--------|")
                for z in zones:
                    lines.append(f"| 第{z['zone']}区 | {z['journals']} | {z['articles']} |")
            else:
                lines.append("| Zone | Journals | Articles |")
                lines.append("|------|----------|----------|")
                for z in zones:
                    lines.append(f"| Zone {z['zone']} | {z['journals']} | {z['articles']} |")
        bm = bradford.get("bradford_multiplier")
        if bm:
            lines.append(f"\n{'布拉德福乘数（第2区/第1区）：' if zh else 'Bradford multiplier (Zone 2 / Zone 1): '}{bm}")

    zipf = bib_laws.get("zipf", {})
    if zipf.get("valid"):
        sub += 1
        lines.append(f"\n#### 3.8.{sub} 齐普夫定律（关键词频率）\n" if zh else f"\n#### 3.8.{sub} Zipf's Law (Keyword Frequency)\n")
        if zh:
            lines.append(
                f"观测指数为 {zipf['exponent']:.2f}（R² = {zipf['r_squared']:.4f}，p = {zipf['p_value']:.4g}）。"
            )
            if zipf.get("conforms"):
                lines.append("关键词频率分布符合齐普夫定律。")
            else:
                lines.append("关键词频率分布偏离经典齐普夫定律（指数约为1.0）。")
        else:
            lines.append(
                f"The observed exponent is {zipf['exponent']:.2f} "
                f"(R² = {zipf['r_squared']:.4f}, p = {zipf['p_value']:.4g}). "
            )
            if zipf.get("conforms"):
                lines.append("The keyword frequency distribution conforms to Zipf's Law.")
            else:
                lines.append("The keyword frequency distribution deviates from classical Zipf's Law (exponent ≈ 1.0).")

    return "\n".join(lines)
