# [IN] stats dict, networks dict
# [OUT] template-based narrative strings for each report section
# [POS] src/bibliometric/insight/templates.py - template generators for fallback narratives

from __future__ import annotations

import logging
from datetime import datetime

import pandas as pd

logger = logging.getLogger(__name__)


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


def describe_trend(stats: dict) -> str:
    """Describe publication trend in words, excluding partial year."""
    year_df = stats.get("year_trend")
    if year_df is None or year_df.empty or len(year_df) < 2:
        return "a limited"
    if "is_partial" in year_df.columns:
        complete = year_df[~year_df["is_partial"]]
    else:
        complete = year_df
    if complete.empty or len(complete) < 2:
        return "a limited"
    counts = complete["count"].values
    if len(counts) >= 3:
        change = (counts[-1] - counts[0]) / max(counts[0], 1)
        if change > 1:
            return "a rapidly growing"
        elif change > 0.3:
            return "a steadily increasing"
        elif change > -0.1:
            return "a stable"
        else:
            return "a declining"
    return "an evolving"


def describe_key_findings(stats, networks, stage) -> str:
    """Summarize key findings for conclusion."""
    article = "an" if stage[0] in "aeiou" else "a"
    parts = [f"{article} {stage} field"]
    kw_net = networks.get("keyword", {})
    n_clusters = len(kw_net.get("clusters", {}))
    if n_clusters > 0:
        parts.append(f"{n_clusters} distinct research clusters")

    insights = stats.get("insights", [])
    for ins in insights[:2]:
        title = ins.get("title", "").lower()
        if "concentration" in title or "dominance" in title:
            parts.append("notable concentration patterns in authorship/geography")
            break

    return ", ".join(parts)


# --------------- Results section template generators ---------------

def template_results_trends(stats: dict) -> str:
    year_df = stats.get("year_trend")
    if year_df is None or year_df.empty:
        return ""

    complete_df = year_df[~year_df.get("is_partial", False)].copy() if "is_partial" in year_df.columns else year_df
    counts = complete_df["count"].values
    years = complete_df["year"].values
    total = int(year_df["count"].sum())
    peak_idx = complete_df["count"].values.argmax() if len(complete_df) > 0 else 0
    peak_year = years[peak_idx] if len(years) > 0 else "N/A"
    peak_count = int(counts[peak_idx]) if len(counts) > 0 else 0

    parts = [
        f"The annual publication output shows a clear temporal pattern across "
        f"the {len(year_df)}-year observation window, with a cumulative total of "
        f"{total} articles."
    ]
    if len(counts) >= 3:
        early_avg = float(counts[:len(counts)//3].mean())
        late_avg = float(counts[-len(counts)//3:].mean())
        if late_avg > early_avg * 1.5:
            parts.append(
                f"A marked acceleration is evident, with the mean annual output "
                f"rising from {early_avg:.1f} in the early period to {late_avg:.1f} "
                f"in the most recent complete years, suggesting intensifying research interest."
            )
        elif late_avg < early_avg * 0.7:
            parts.append(
                "Publication volume has declined in recent complete years, potentially "
                "indicating a shift in research focus or field maturation."
            )
        else:
            parts.append(
                "The publication rate has remained relatively stable across complete years, "
                "indicating sustained but not accelerating research activity."
            )
    parts.append(
        f"The peak year was {peak_year} with {peak_count} publications, "
        f"which may reflect heightened clinical or policy interest during that period."
    )

    partial = year_df[year_df.get("is_partial", False)] if "is_partial" in year_df.columns else pd.DataFrame()
    if not partial.empty:
        row = partial.iloc[0]
        month_name = datetime.now().strftime("%B")
        parts.append(
            f"Note: {row['year']} data is partial (Jan–{month_name}). "
            f"Annualized estimate: ~{int(row.get('annualized_count', row['count']))} articles."
        )

    return " ".join(parts)


def template_results_authors(stats: dict) -> str:
    author_df = stats.get("top_authors")
    if author_df is None or author_df.empty:
        return ""
    top = author_df.head(5)
    leader = top.iloc[0]
    name, count = leader["authors_normalized"], int(leader["count"])
    n_total = len(author_df)
    if count <= 1:
        return (
            f"Among {n_total} contributing authors, no individual published more "
            f"than one article, reflecting a highly dispersed authorship pattern "
            f"characteristic of an emerging or interdisciplinary field."
        )
    top5_sum = int(top["count"].sum())

    bib_laws = stats.get("bib_laws", {})
    lotka = bib_laws.get("lotka", {})
    lotka_exp = lotka.get("exponent", 2.0) if lotka.get("valid") else 2.0

    if lotka_exp > 3.0:
        concentration_desc = (
            f"a highly dispersed productivity distribution "
            f"(Lotka exponent = {lotka_exp:.2f}, indicating extreme fragmentation)"
        )
    elif lotka_exp > 2.5:
        concentration_desc = (
            f"a moderately dispersed productivity distribution "
            f"(Lotka exponent = {lotka_exp:.2f})"
        )
    else:
        concentration_desc = (
            f"a moderately concentrated productivity distribution "
            f"consistent with Lotka's Law"
        )

    return (
        f"The most prolific author, {name}, contributed {count} publications, "
        f"followed by {', '.join(top.iloc[1:4]['authors_normalized'].tolist())}. "
        f"The top five authors collectively account for {top5_sum} articles out of "
        f"{n_total} unique contributors, indicating {concentration_desc}."
    )


def template_results_institutions(stats: dict) -> str:
    inst_df = stats.get("top_institutions")
    if inst_df is None or inst_df.empty:
        return ""
    top = inst_df.head(5)
    leader = top.iloc[0]
    name, count = leader["institutions"], int(leader["count"])
    total_pubs = int(inst_df["count"].sum())
    top5_sum = int(top["count"].sum())
    top5_pct = top5_sum / total_pubs * 100 if total_pubs > 0 else 0
    n_inst = len(inst_df)

    pharma = [r for _, r in top.iterrows()
              if any(k in r["institutions"].lower() for k in
                     ["novo nordisk", "pfizer", "lilly", "astrazeneca",
                      "merck", "roche", "novartis", "sanofi", "inc", "a/s", "ltd"])]
    academic = [r for _, r in top.iterrows()
                if any(k in r["institutions"].lower() for k in
                       ["university", "school", "institute", "college"])]
    clinical = [r for _, r in top.iterrows()
                if any(k in r["institutions"].lower() for k in
                       ["hospital", "clinic", "medical center", "health"])]

    parts = [
        f"Institutional analysis reveals {name} as the leading contributor "
        f"with {count} publications, followed by "
        f"{', '.join(top.iloc[1:4]['institutions'].tolist())}. "
        f"The top five institutions collectively account for {top5_sum} articles "
        f"({top5_pct:.1f}% of the {n_inst} contributing institutions)."
    ]

    sector_parts = []
    if pharma:
        sector_parts.append(f"{len(pharma)} pharmaceutical/industry entities")
    if academic:
        sector_parts.append(f"{len(academic)} academic institutions")
    if clinical:
        sector_parts.append(f"{len(clinical)} clinical centers")
    if sector_parts:
        parts.append(
            f"The top-5 composition includes {', '.join(sector_parts)}, "
            f"reflecting the translational nature of this research area where "
            f"industry-sponsored trials and academic investigation converge."
            if pharma else
            f"The top-5 composition includes {', '.join(sector_parts)}, "
            f"suggesting a predominantly academic research landscape."
        )

    return " ".join(parts)


def template_results_journals(stats: dict) -> str:
    journal_df = stats.get("top_journals")
    if journal_df is None or journal_df.empty:
        return ""
    top = journal_df.head(5)
    leader = top.iloc[0]
    name, count = leader["journal"], int(leader["count"])
    n_total = len(journal_df)
    total_pubs = int(journal_df["count"].sum())
    top5_sum = int(top["count"].sum())
    top5_pct = top5_sum / total_pubs * 100 if total_pubs > 0 else 0

    cumsum = 0
    core_count = 0
    for _, row in journal_df.iterrows():
        cumsum += int(row["count"])
        core_count += 1
        if cumsum >= total_pubs * 0.5:
            break

    parts = [
        f"Publications were distributed across {n_total} journals, with "
        f"{name} leading ({count} articles). The top five journals account "
        f"for {top5_sum} articles ({top5_pct:.1f}%), while {core_count} journals "
        f"are needed to cover 50% of all publications."
    ]

    if core_count <= 5:
        parts.append(
            "This high concentration in a small core set is consistent with "
            "Bradford's Law of Scattering and suggests a well-defined disciplinary "
            "home for this research topic."
        )
    elif core_count <= 15:
        parts.append(
            "This moderate scatter across core journals reflects the "
            "multidisciplinary nature of this research area, spanning clinical, "
            "pharmacological, and public health outlets."
        )
    else:
        parts.append(
            "The wide dispersion across many journals indicates a highly "
            "interdisciplinary topic without a single dominant publication venue, "
            "which may complicate systematic literature monitoring."
        )

    return " ".join(parts)


def template_results_countries(stats: dict) -> str:
    country_df = stats.get("top_countries")
    if country_df is None or country_df.empty:
        return ""
    top = country_df.head(5)
    leader = top.iloc[0]
    name, count = leader["countries"], int(leader["count"])
    total = int(country_df["count"].sum())
    pct = count / total * 100 if total > 0 else 0
    n_countries = len(country_df)

    shares = country_df["count"].values / total if total > 0 else []
    hhi = float(sum(s**2 for s in shares)) if len(shares) > 0 else 0

    western = {"United States", "United Kingdom", "Germany", "France", "Italy",
               "Canada", "Australia", "Spain", "Netherlands", "Sweden",
               "Switzerland", "Belgium", "Austria", "Denmark", "Norway", "Finland"}
    asian = {"China", "Japan", "South Korea", "India", "Taiwan", "Singapore",
             "Thailand", "Malaysia", "Pakistan"}
    lmic = {"Brazil", "India", "Mexico", "Egypt", "Iran", "Turkey", "Colombia",
            "South Africa", "Pakistan", "Thailand", "Malaysia", "Argentina"}

    top10_names = set(country_df.head(10)["countries"])
    lmic_in_top10 = top10_names & lmic

    parts = [
        f"{name} dominates the geographic distribution, contributing "
        f"{count} publications ({pct:.1f}% of total output from {n_countries} countries), "
        f"followed by {', '.join(top.iloc[1:4]['countries'].tolist())}."
    ]

    if hhi > 0.25:
        parts.append(
            f"The Herfindahl–Hirschman Index (HHI = {hhi:.3f}) indicates high "
            f"geographic concentration, with research output heavily dependent on "
            f"a few nations. This concentration may limit the generalizability of "
            f"findings to diverse populations and healthcare systems."
        )
    elif hhi > 0.15:
        parts.append(
            f"The moderate geographic concentration (HHI = {hhi:.3f}) suggests "
            f"a research landscape transitioning toward broader international "
            f"participation, though still anchored by a few leading nations."
        )
    else:
        parts.append(
            f"The relatively low geographic concentration (HHI = {hhi:.3f}) "
            f"reflects genuinely global research engagement."
        )

    if lmic_in_top10:
        parts.append(
            f"Notably, {', '.join(sorted(lmic_in_top10))} represent low- and "
            f"middle-income country participation in the top 10, suggesting "
            f"growing research capacity in regions where this topic may have "
            f"significant public health relevance."
        )
    elif not lmic_in_top10 and n_countries > 10:
        parts.append(
            "The absence of low- and middle-income countries from the top 10 "
            "contributors highlights a potential equity gap in research capacity, "
            "particularly concerning for topics with global health implications."
        )

    return " ".join(parts)


def template_results_keyword_network(networks: dict) -> str:
    kw_net = networks.get("keyword", {})
    if not kw_net:
        return ""
    quality = kw_net.get("quality", {})
    q_val = quality.get("modularity", 0)
    s_val = quality.get("silhouette", 0)
    n_nodes = kw_net.get("node_count", 0)
    n_edges = kw_net.get("edge_count", 0)
    density = 2 * n_edges / (n_nodes * (n_nodes - 1)) if n_nodes > 1 else 0

    if q_val < 0.1:
        structure = "no significant"
        structure_note = (
            " The extremely low modularity indicates that community detection "
            "did not identify meaningful clusters; the network lacks clear "
            "thematic boundaries, and clustering results should be interpreted "
            "with caution."
        )
    elif q_val < 0.3:
        structure = "weak"
        structure_note = (
            " The modularity below 0.3 suggests that thematic boundaries "
            "between clusters are not well-defined."
        )
    else:
        structure = "well-defined"
        structure_note = ""

    parts = [
        f"The keyword co-occurrence network ({n_nodes} nodes, {n_edges} edges, "
        f"density = {density:.4f}) exhibits {structure} community structure "
        f"(Q = {q_val:.4f}, S = {s_val:.4f}).{structure_note}"
    ]
    centrality = kw_net.get("centrality", {})
    if centrality:
        top_bridge = sorted(
            centrality.items(),
            key=lambda x: x[1].get("betweenness", 0),
            reverse=True,
        )[:3]
        bridge_names = [n for n, _ in top_bridge]
        parts.append(
            f"High-betweenness keywords such as {', '.join(bridge_names)} serve "
            f"as conceptual bridges connecting distinct research themes, suggesting "
            f"integrative or cross-cutting research areas."
        )
    return " ".join(parts)


def template_results_clusters(stats: dict) -> str:
    cluster_labels = stats.get("cluster_labels", {})
    if not cluster_labels:
        return ""
    n = len(cluster_labels)
    labels = []
    for cid, info in sorted(cluster_labels.items()):
        labels.append(
            f'"{info.get("en_label", f"Cluster {cid}")}" '
            f'(n={info.get("size", 0)})'
        )
    parts = [
        f"The {n} identified clusters represent distinct thematic domains: "
        f"{', '.join(labels)}."
    ]
    sizes = [info.get("size", 0) for info in cluster_labels.values()]
    if sizes:
        largest = max(sizes)
        smallest = min(sizes)
        if largest > smallest * 3:
            parts.append(
                "The substantial size disparity between clusters suggests that "
                "certain research themes have attracted considerably more attention "
                "than others, potentially indicating underexplored niches."
            )
    return " ".join(parts)


def template_results_hotspots(stats: dict) -> str:
    parts = []
    kw_df = stats.get("top_keywords")
    if kw_df is not None and not kw_df.empty:
        top5 = kw_df.head(5)
        top_kw = top5["keywords_merged"].tolist()
        total_kw_count = int(kw_df["count"].sum())
        top5_count = int(top5["count"].sum())
        top5_pct = top5_count / total_kw_count * 100 if total_kw_count > 0 else 0
        parts.append(
            f"The most frequently occurring keywords — {', '.join(top_kw[:3])} — "
            f"define the core conceptual territory of this field. "
            f"The top five keywords account for {top5_pct:.1f}% of all keyword "
            f"occurrences, indicating a tightly focused research agenda."
        )

    burst_data = stats.get("bursts", {})
    burst_df = burst_data.get("burst_terms")
    if burst_df is not None and hasattr(burst_df, "empty") and not burst_df.empty:
        recent = burst_df.head(5).to_dict("records")
        current_year = str(datetime.now().year)
        ongoing = [r for r in recent if str(r.get("burst_end", "")) >= current_year
                   or str(r.get("burst_end", "")) == ""]

        burst_terms = [r.get("term", "?") for r in recent[:3]]
        parts.append(
            f"Burst detection reveals {', '.join(burst_terms)} as terms with "
            f"sudden frequency surges."
        )

        if ongoing:
            ongoing_names = [r.get("term", "?") for r in ongoing[:3]]
            parts.append(
                f"Among these, {', '.join(ongoing_names)} show ongoing burst "
                f"activity extending to the present, signaling active and "
                f"intensifying research fronts rather than transient interest."
            )

        strongest = max(recent, key=lambda r: r.get("burst_strength", 0))
        parts.append(
            f"The strongest burst signal belongs to \"{strongest.get('term', '?')}\" "
            f"(strength = {strongest.get('burst_strength', 0):.2f}, "
            f"{strongest.get('burst_start', '?')}–{strongest.get('burst_end', '?')}), "
            f"which may reflect a paradigm shift or major clinical development "
            f"during that period."
        )

    return " ".join(parts) if parts else ""


def template_results_frontiers(stats: dict) -> str:
    frontiers = stats.get("frontiers", {})
    frontier_df = frontiers.get("frontier_topics")
    if frontier_df is None or not hasattr(frontier_df, "empty") or frontier_df.empty:
        return ""
    top = frontier_df.head(5).to_dict("records")
    names = [r.get("topic", "?") for r in top]
    top_score = top[0].get("frontier_score", 0)

    parts = [
        f"Composite frontier scoring identifies {', '.join(names)} as the "
        f"leading emerging topics (top score: {top_score:.3f})."
    ]

    leader = top[0]
    drivers = []
    if leader.get("growth_rate", 0) > 0.5:
        drivers.append(f"rapid recent growth ({leader['growth_rate']:.0%} of articles in the recent period)")
    if leader.get("burst_score", 0) > 2:
        drivers.append(f"strong burst signal (score = {leader['burst_score']:.1f})")
    if leader.get("novelty_score", 0) > 0.7:
        drivers.append("high novelty (recently introduced concept)")
    if drivers:
        parts.append(
            f"The top-ranked frontier, \"{leader['topic']}\", is driven by "
            f"{' and '.join(drivers)}, distinguishing it from established "
            f"but stable research themes."
        )

    growth_driven = [r for r in top if r.get("growth_rate", 0) > 0.5]
    novelty_driven = [r for r in top if r.get("novelty_score", 0) > 0.7]
    if growth_driven and novelty_driven:
        parts.append(
            f"Among the top frontiers, {len(growth_driven)} are growth-driven "
            f"(expanding established topics) while {len(novelty_driven)} are "
            f"novelty-driven (recently introduced concepts), suggesting both "
            f"deepening of existing lines and genuine conceptual innovation."
        )

    return " ".join(parts)


def template_results_trends_zh(stats: dict) -> str:
    year_df = stats.get("year_trend")
    if year_df is None or year_df.empty:
        return ""

    complete_df = year_df[~year_df["is_partial"]].copy() if "is_partial" in year_df.columns else year_df
    counts = complete_df["count"].values
    years = complete_df["year"].values
    total = int(year_df["count"].sum())
    peak_idx = complete_df["count"].values.argmax() if len(complete_df) > 0 else 0
    peak_year = years[peak_idx] if len(years) > 0 else "N/A"
    peak_count = int(counts[peak_idx]) if len(counts) > 0 else 0

    parts = [
        f"在 {len(year_df)} 年的观察窗口内，年度发文量呈现出清晰的时间规律，累计发文 {total} 篇。"
    ]
    if len(counts) >= 3:
        early_avg = float(counts[:len(counts)//3].mean())
        late_avg = float(counts[-len(counts)//3:].mean())
        if late_avg > early_avg * 1.5:
            parts.append(
                f"发文量呈明显加速态势，年均发文量从早期的 {early_avg:.1f} 篇增长至近期完整年份的 {late_avg:.1f} 篇，"
                f"提示该领域研究热度持续升温。"
            )
        elif late_avg < early_avg * 0.7:
            parts.append(
                "近期完整年份发文量有所下降，可能反映研究重心转移或领域趋于成熟。"
            )
        else:
            parts.append(
                "完整年份发文量保持相对稳定，表明该领域研究活动持续但未见明显加速。"
            )
    parts.append(
        f"发文高峰年份为 {peak_year} 年（{peak_count} 篇），可能与该时期临床或政策层面的高度关注有关。"
    )

    partial = year_df[year_df["is_partial"]] if "is_partial" in year_df.columns else pd.DataFrame()
    if not partial.empty:
        row = partial.iloc[0]
        month_name = datetime.now().strftime("%m")
        parts.append(
            f"注：{row['year']} 年数据不完整（截至 {month_name} 月），"
            f"年化估算约 {int(row.get('annualized_count', row['count']))} 篇。"
        )

    return "".join(parts)


def template_results_authors_zh(stats: dict) -> str:
    author_df = stats.get("top_authors")
    if author_df is None or author_df.empty:
        return ""
    top = author_df.head(5)
    leader = top.iloc[0]
    name, count = leader["authors_normalized"], int(leader["count"])
    n_total = len(author_df)
    if count <= 1:
        return (
            f"在 {n_total} 位贡献作者中，无人发表超过 1 篇文章，"
            f"反映出高度分散的作者格局，这在新兴或交叉学科领域较为常见。"
        )
    top5_sum = int(top["count"].sum())

    bib_laws = stats.get("bib_laws", {})
    lotka = bib_laws.get("lotka", {})
    lotka_exp = lotka.get("exponent", 2.0) if lotka.get("valid") else 2.0

    if lotka_exp > 3.0:
        concentration_desc = f"高度分散的生产力分布（洛特卡指数 = {lotka_exp:.2f}，提示极度碎片化）"
    elif lotka_exp > 2.5:
        concentration_desc = f"中度分散的生产力分布（洛特卡指数 = {lotka_exp:.2f}）"
    else:
        concentration_desc = "符合洛特卡定律的中度集中生产力分布"

    return (
        f"发文量最高的作者为 {name}，共发表 {count} 篇，"
        f"其后依次为 {', '.join(top.iloc[1:4]['authors_normalized'].tolist())}。"
        f"前五位作者合计发表 {top5_sum} 篇，占 {n_total} 位贡献者总量的相当比例，"
        f"呈现出{concentration_desc}。"
    )


def template_results_institutions_zh(stats: dict) -> str:
    inst_df = stats.get("top_institutions")
    if inst_df is None or inst_df.empty:
        return ""
    top = inst_df.head(5)
    leader = top.iloc[0]
    name, count = leader["institutions"], int(leader["count"])
    total_pubs = int(inst_df["count"].sum())
    top5_sum = int(top["count"].sum())
    top5_pct = top5_sum / total_pubs * 100 if total_pubs > 0 else 0
    n_inst = len(inst_df)

    pharma = [r for _, r in top.iterrows()
              if any(k in r["institutions"].lower() for k in
                     ["novo nordisk", "pfizer", "lilly", "astrazeneca",
                      "merck", "roche", "novartis", "sanofi", "inc", "a/s", "ltd"])]
    academic = [r for _, r in top.iterrows()
                if any(k in r["institutions"].lower() for k in
                       ["university", "school", "institute", "college"])]
    clinical = [r for _, r in top.iterrows()
                if any(k in r["institutions"].lower() for k in
                       ["hospital", "clinic", "medical center", "health"])]

    parts = [
        f"机构分析显示，{name} 以 {count} 篇位居首位，"
        f"其后依次为 {', '.join(top.iloc[1:4]['institutions'].tolist())}。"
        f"前五位机构合计发表 {top5_sum} 篇（占 {n_inst} 家贡献机构总量的 {top5_pct:.1f}%）。"
    ]

    sector_parts = []
    if pharma:
        sector_parts.append(f"{len(pharma)} 家制药/产业机构")
    if academic:
        sector_parts.append(f"{len(academic)} 家学术机构")
    if clinical:
        sector_parts.append(f"{len(clinical)} 家临床中心")
    if sector_parts:
        parts.append(
            f"前五名机构涵盖{'、'.join(sector_parts)}，"
            + ("反映出该研究领域产学研融合的转化医学特征。" if pharma else "提示该领域以学术研究为主导。")
        )

    return "".join(parts)


def template_results_journals_zh(stats: dict) -> str:
    journal_df = stats.get("top_journals")
    if journal_df is None or journal_df.empty:
        return ""
    top = journal_df.head(5)
    leader = top.iloc[0]
    name, count = leader["journal"], int(leader["count"])
    n_total = len(journal_df)
    total_pubs = int(journal_df["count"].sum())
    top5_sum = int(top["count"].sum())
    top5_pct = top5_sum / total_pubs * 100 if total_pubs > 0 else 0

    cumsum = 0
    core_count = 0
    for _, row in journal_df.iterrows():
        cumsum += int(row["count"])
        core_count += 1
        if cumsum >= total_pubs * 0.5:
            break

    parts = [
        f"文献分布于 {n_total} 种期刊，其中 {name} 发文量最高（{count} 篇）。"
        f"前五种期刊合计 {top5_sum} 篇（{top5_pct:.1f}%），"
        f"覆盖 50% 文献需 {core_count} 种核心期刊。"
    ]

    if core_count <= 5:
        parts.append(
            "高度集中于少数核心期刊，符合布拉德福散布定律，表明该研究主题具有明确的学科归属。"
        )
    elif core_count <= 15:
        parts.append(
            "核心期刊适度分散，反映该研究领域跨越临床、药理和公共卫生等多学科出版渠道。"
        )
    else:
        parts.append(
            "文献高度分散于众多期刊，提示该主题具有强烈的跨学科属性，缺乏单一主导发表平台，"
            "可能增加系统性文献监测的难度。"
        )

    return "".join(parts)


def template_results_countries_zh(stats: dict) -> str:
    country_df = stats.get("top_countries")
    if country_df is None or country_df.empty:
        return ""

    def _cn(c: str) -> str:
        return _COUNTRY_ZH.get(c, c)

    top = country_df.head(5)
    leader = top.iloc[0]
    name, count = _cn(leader["countries"]), int(leader["count"])
    total = int(country_df["count"].sum())
    pct = count / total * 100 if total > 0 else 0
    n_countries = len(country_df)

    shares = country_df["count"].values / total if total > 0 else []
    hhi = float(sum(s**2 for s in shares)) if len(shares) > 0 else 0

    lmic = {"Brazil", "India", "Mexico", "Egypt", "Iran", "Turkey", "Colombia",
            "South Africa", "Pakistan", "Thailand", "Malaysia", "Argentina"}
    top10_names = set(country_df.head(10)["countries"])
    lmic_in_top10 = top10_names & lmic

    parts = [
        f"{name} 在地理分布中占据主导地位，贡献 {count} 篇（占 {n_countries} 个国家总发文量的 {pct:.1f}%），"
        f"其后依次为 {'、'.join(_cn(c) for c in top.iloc[1:4]['countries'].tolist())}。"
    ]

    if hhi > 0.25:
        parts.append(
            f"赫芬达尔-赫希曼指数（HHI = {hhi:.3f}）显示地理集中度较高，"
            f"研究产出高度依赖少数国家，可能限制研究结论对不同人群和卫生体系的普适性。"
        )
    elif hhi > 0.15:
        parts.append(
            f"中等地理集中度（HHI = {hhi:.3f}）表明研究格局正向更广泛的国际参与过渡，"
            f"但仍以少数领先国家为主导。"
        )
    else:
        parts.append(
            f"较低的地理集中度（HHI = {hhi:.3f}）反映出真正意义上的全球研究参与。"
        )

    if lmic_in_top10:
        parts.append(
            f"值得关注的是，{'、'.join(_cn(c) for c in sorted(lmic_in_top10))} 等中低收入国家跻身前十，"
            f"表明这些地区的研究能力正在提升，而该主题在这些地区可能具有重要的公共卫生意义。"
        )
    elif n_countries > 10:
        parts.append(
            "前十名贡献国中缺乏中低收入国家，凸显了研究能力方面潜在的公平性差距，"
            "对于具有全球健康意义的主题而言尤为值得关注。"
        )

    return "".join(parts)


def template_results_keyword_network_zh(networks: dict) -> str:
    kw_net = networks.get("keyword", {})
    if not kw_net:
        return ""
    quality = kw_net.get("quality", {})
    q_val = quality.get("modularity", 0)
    s_val = quality.get("silhouette", 0)
    n_nodes = kw_net.get("node_count", 0)
    n_edges = kw_net.get("edge_count", 0)
    density = 2 * n_edges / (n_nodes * (n_nodes - 1)) if n_nodes > 1 else 0

    if q_val < 0.1:
        structure = "无显著"
        structure_note = (
            "极低的模块度表明社区检测未能识别出有意义的聚类，"
            "网络缺乏清晰的主题边界，聚类结果须谨慎解读。"
        )
    elif q_val < 0.3:
        structure = "较弱的"
        structure_note = "模块度低于 0.3，提示各聚类间主题边界不够清晰。"
    else:
        structure = "清晰的"
        structure_note = ""

    parts = [
        f"关键词共现网络（{n_nodes} 个节点，{n_edges} 条边，密度 = {density:.4f}）"
        f"呈现出{structure}社区结构（Q = {q_val:.4f}，S = {s_val:.4f}）。{structure_note}"
    ]
    centrality = kw_net.get("centrality", {})
    if centrality:
        top_bridge = sorted(
            centrality.items(),
            key=lambda x: x[1].get("betweenness", 0),
            reverse=True,
        )[:3]
        bridge_names = [n for n, _ in top_bridge]
        parts.append(
            f"中介中心性较高的关键词（如 {', '.join(bridge_names)}）"
            f"在不同研究主题间发挥桥接作用，可能代表具有整合潜力的跨领域研究方向。"
        )
    return "".join(parts)


def template_results_clusters_zh(stats: dict) -> str:
    cluster_labels = stats.get("cluster_labels", {})
    if not cluster_labels:
        return ""
    n = len(cluster_labels)
    labels = []
    for cid, info in sorted(cluster_labels.items()):
        label = info.get("zh_label") or info.get("en_label") or f"聚类 {cid}"
        labels.append(f'"{label}"（n={info.get("size", 0)}）')
    parts = [
        f"共识别出 {n} 个研究聚类，代表不同主题方向：{'、'.join(labels)}。"
    ]
    sizes = [info.get("size", 0) for info in cluster_labels.values()]
    if sizes:
        largest = max(sizes)
        smallest = min(sizes)
        if largest > smallest * 3:
            parts.append(
                "各聚类规模差异显著，表明部分研究主题受到的关注远多于其他方向，"
                "可能存在尚待深入探索的研究空白。"
            )
    return "".join(parts)


def template_results_hotspots_zh(stats: dict) -> str:
    parts = []
    kw_df = stats.get("top_keywords")
    if kw_df is not None and not kw_df.empty:
        top5 = kw_df.head(5)
        top_kw = top5["keywords_merged"].tolist()
        total_kw_count = int(kw_df["count"].sum())
        top5_count = int(top5["count"].sum())
        top5_pct = top5_count / total_kw_count * 100 if total_kw_count > 0 else 0
        parts.append(
            f"出现频率最高的关键词——{', '.join(top_kw[:3])}——界定了该领域的核心概念范畴。"
            f"前五位关键词占全部关键词出现次数的 {top5_pct:.1f}%，反映出高度聚焦的研究议题。"
        )

    burst_data = stats.get("bursts", {})
    burst_df = burst_data.get("burst_terms")
    if burst_df is not None and hasattr(burst_df, "empty") and not burst_df.empty:
        recent = burst_df.head(5).to_dict("records")
        current_year = str(datetime.now().year)
        ongoing = [r for r in recent if str(r.get("burst_end", "")) >= current_year
                   or str(r.get("burst_end", "")) == ""]

        burst_terms = [r.get("term", "?") for r in recent[:3]]
        parts.append(f"爆发词检测发现 {', '.join(burst_terms)} 等词频出现突增。")

        if ongoing:
            ongoing_names = [r.get("term", "?") for r in ongoing[:3]]
            parts.append(
                f"其中，{', '.join(ongoing_names)} 的爆发活动延续至今，"
                f"标志着持续升温的研究前沿，而非短暂的研究热点。"
            )

        strongest = max(recent, key=lambda r: r.get("burst_strength", 0))
        parts.append(
            f"爆发强度最高的词为\"{strongest.get('term', '?')}\"（强度 = {strongest.get('burst_strength', 0):.2f}，"
            f"{strongest.get('burst_start', '?')}—{strongest.get('burst_end', '?')}），"
            f"可能反映该时期的范式转变或重大临床进展。"
        )

    return "".join(parts) if parts else ""


def template_results_frontiers_zh(stats: dict) -> str:
    frontiers = stats.get("frontiers", {})
    frontier_df = frontiers.get("frontier_topics")
    if frontier_df is None or not hasattr(frontier_df, "empty") or frontier_df.empty:
        return ""
    top = frontier_df.head(5).to_dict("records")
    names = [r.get("topic", "?") for r in top]
    top_score = top[0].get("frontier_score", 0)

    parts = [
        f"综合前沿评分识别出 {', '.join(names)} 为领先新兴主题（最高得分：{top_score:.3f}）。"
    ]

    leader = top[0]
    drivers = []
    if leader.get("growth_rate", 0) > 0.5:
        drivers.append(f"近期快速增长（{leader['growth_rate']:.0%} 的文章集中于近期）")
    if leader.get("burst_score", 0) > 2:
        drivers.append(f"强爆发信号（得分 = {leader['burst_score']:.1f}）")
    if leader.get("novelty_score", 0) > 0.7:
        drivers.append("高新颖性（近期引入的概念）")
    if drivers:
        parts.append(
            f"排名第一的前沿主题\"{leader['topic']}\"的驱动因素包括：{'和'.join(drivers)}，"
            f"使其有别于已成熟但趋于稳定的研究方向。"
        )

    growth_driven = [r for r in top if r.get("growth_rate", 0) > 0.5]
    novelty_driven = [r for r in top if r.get("novelty_score", 0) > 0.7]
    if growth_driven and novelty_driven:
        parts.append(
            f"前沿主题中，{len(growth_driven)} 个由增长驱动（现有主题持续扩展），"
            f"{len(novelty_driven)} 个由新颖性驱动（近期引入的新概念），"
            f"表明该领域既有对既有方向的深化，也存在真正的概念创新。"
        )

    return "".join(parts)


def template_results_citation_zh(stats: dict) -> str:
    cite_stats = stats.get("citation_stats", {})
    if not cite_stats:
        return ""
    h = cite_stats.get("h_index", 0)
    total = cite_stats.get("total_citations", 0)
    mean = cite_stats.get("mean_citations", 0)
    median = cite_stats.get("median_citations", 0)
    skew = "右偏" if mean > median * 1.5 else "相对对称"
    impact = "显著" if h > 20 else ("中等" if h > 10 else "新兴")

    parts = [
        f"该领域文献的估算 h 指数为 {h}，引用影响力处于{impact}水平。"
        f"篇均被引 {mean:.1f} 次，中位数为 {median:.1f} 次，分布呈{skew}态。"
    ]

    if mean > median * 2:
        parts.append(
            f"均值与中位数之比达 {mean/max(median, 0.1):.1f} 倍，表明少数高被引里程碑文献"
            f"贡献了 {total:,} 次总被引中的不成比例份额，而大多数文章被引次数有限。"
            f"这一模式在生物医学领域较为典型，关键临床试验或 Meta 分析往往获得极高引用。"
        )
    elif mean > median * 1.5:
        parts.append(
            "中度偏态提示存在少量高被引核心文献与大量低被引文章并存的格局，"
            "符合趋于成熟但尚未完全整合的证据基础特征。"
        )
    else:
        parts.append(
            "引用分布相对均匀，表明该领域没有单一文献主导引用格局，"
            "反映出宽泛的证据基础。"
        )

    pub_type_df = stats.get("pub_type_distribution")
    if pub_type_df is not None and not pub_type_df.empty:
        review_count = sum(
            int(r["count"]) for _, r in pub_type_df.iterrows()
            if "review" in r["pub_type"].lower() or "meta-analysis" in r["pub_type"].lower()
        )
        if review_count > 0:
            parts.append(
                f"数据集中包含 {review_count} 篇综述和 Meta 分析，"
                f"这类综合性文章通常比原始研究积累引用更快，可能是引用集中的重要原因。"
            )

    return "".join(parts)


def template_results_citation(stats: dict) -> str:
    cite_stats = stats.get("citation_stats", {})
    if not cite_stats:
        return ""
    h = cite_stats.get("h_index", 0)
    total = cite_stats.get("total_citations", 0)
    mean = cite_stats.get("mean_citations", 0)
    median = cite_stats.get("median_citations", 0)
    skew = "right-skewed" if mean > median * 1.5 else "relatively symmetric"
    impact = "substantial" if h > 20 else ("moderate" if h > 10 else "emerging")

    parts = [
        f"The estimated h-index of {h} indicates {impact} citation impact "
        f"for this body of literature. With a mean of {mean:.1f} and median "
        f"of {median:.1f} citations per article, the distribution is {skew}."
    ]

    if mean > median * 2:
        parts.append(
            f"The {mean/max(median, 0.1):.1f}x ratio between mean and median "
            f"confirms that a small number of highly cited landmark papers "
            f"drive a disproportionate share of the total {total:,} citations, "
            f"while the majority of articles receive modest attention. "
            f"This pattern is typical of biomedical fields where pivotal "
            f"clinical trials or meta-analyses attract outsized citation counts."
        )
    elif mean > median * 1.5:
        parts.append(
            f"The moderate skew suggests a mix of well-cited core papers "
            f"and a long tail of less-cited contributions, consistent with "
            f"a maturing but not yet consolidated evidence base."
        )
    else:
        parts.append(
            f"The relatively even citation distribution suggests that "
            f"no single paper dominates the field's citation landscape, "
            f"indicating a broad base of contributing evidence."
        )

    pub_type_df = stats.get("pub_type_distribution")
    if pub_type_df is not None and not pub_type_df.empty:
        review_count = sum(
            int(r["count"]) for _, r in pub_type_df.iterrows()
            if "review" in r["pub_type"].lower() or "meta-analysis" in r["pub_type"].lower()
        )
        if review_count > 0:
            parts.append(
                f"The presence of {review_count} reviews and meta-analyses "
                f"likely contributes to the citation concentration, as these "
                f"synthesis articles typically accumulate citations faster "
                f"than primary research."
            )

    return " ".join(parts)
