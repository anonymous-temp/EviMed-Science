# [IN] query, dates, articles, stats, networks, output_dir
# [OUT] report.md - publication-grade Markdown analysis report
# [POS] src/bibliometric/report/generator.py - Markdown report generation

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path

import pandas as pd

from bibliometric.report.results_sections import (
    _next_table,
    _results_bib_laws,
    _results_citation,
    _results_contributors,
    _results_frontiers,
    _results_hotspots,
    _results_knowledge_structure,
    _results_overview,
)

logger = logging.getLogger(__name__)


def generate_report(
    query: str,
    date_from: str,
    date_to: str,
    articles: list[dict],
    stats: dict,
    networks: dict,
    output_dir: str,
    lang: str = "en",
) -> str:
    """Generate publication-grade Markdown analysis report.
    lang: 'en' (default) | 'zh' (Chinese output)
    """
    ctx = _build_context(query, date_from, date_to, articles, stats, networks, output_dir)
    ctx["lang"] = lang

    sections = [
        _header(ctx),
        _abstract(ctx),
        _introduction(ctx),
        _methods(ctx),
        _results_overview(ctx),
        _results_contributors(ctx),
        _results_knowledge_structure(ctx),
        _results_hotspots(ctx),
        _results_frontiers(ctx),
        _results_citation(ctx),
        _results_bib_laws(ctx),
        _discussion(ctx),
        _conclusion(ctx),
        _limitations(ctx),
        _references(ctx),
        _appendix(ctx),
    ]

    report = "\n\n".join(s for s in sections if s)

    # 始终保存到本地（用于图片转base64），但可以通过环境变量控制是否保留
    path = Path(output_dir) / "report.md"
    path.write_text(report, encoding="utf-8")
    logger.info("Generated report: %s (%d chars)", path, len(report))
    return str(path)


def _build_context(query, date_from, date_to, articles, stats, networks, output_dir):
    """Build a context dict for all report sections."""
    years = sorted(set(a.get("year", "") for a in articles if a.get("year")))
    journals = set()
    countries = set()
    for a in articles:
        j = a.get("journal", {})
        if isinstance(j, dict):
            jt = j.get("title", "")
        else:
            jt = str(j)
        if jt:
            journals.add(jt)
        for c in a.get("countries", []):
            countries.add(c)

    # Try to read search metadata for PRISMA flow
    total_found = len(articles)
    total_fetched = len(articles)
    after_dedup = len(articles)
    max_records_cfg = 0
    search_strategy = {}
    try:
        import json
        meta_path = Path(output_dir) / "data" / "search_metadata.json"
        if meta_path.exists():
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            total_found = meta.get("total_found", len(articles))
            total_fetched = meta.get("total_fetched", len(articles))
            after_dedup = meta.get("after_dedup", len(articles))
            max_records_cfg = meta.get("max_records", 0)
            search_strategy = meta.get("search_strategy", {})
    except Exception:
        pass

    search_year_range = f"{date_from or 'inception'}–{date_to or 'present'}"
    observed_year_range = f"{years[0]}–{years[-1]}" if years else search_year_range
    return {
        "query": query,
        "date_from": date_from,
        "date_to": date_to,
        "articles": articles,
        "stats": stats,
        "networks": networks,
        "n": len(articles),
        "total_found": total_found,
        "total_fetched": total_fetched,
        "after_dedup": after_dedup,
        "max_records": max_records_cfg,
        "search_strategy": search_strategy,
        "years": years,
        "year_range": observed_year_range,
        "search_year_range": search_year_range,
        "n_journals": len(journals),
        "n_countries": len(countries),
        "date_str": datetime.now().strftime("%Y-%m-%d"),
        "output_dir": output_dir,
        "fig_counter": 0,
        "table_counter": 0,
    }


def _header(ctx):
    q = ctx['query']
    if ctx.get("lang") == "zh":
        return f"# 「{q}」文献计量分析：发文趋势、知识结构与研究前沿\n\n---"
    return (
        f"# A Bibliometric Analysis of \"{q}\" Research: "
        f"Trends, Knowledge Structure, and Emerging Frontiers\n\n---"
    )


def _abstract(ctx):
    stats = ctx["stats"]
    n = ctx["n"]
    year_range = ctx["year_range"]
    search_year_range = ctx["search_year_range"]
    zh = ctx.get("lang") == "zh"

    peak = ""
    year_df = stats.get("year_trend")
    if year_df is not None and not year_df.empty:
        peak_row = year_df.loc[year_df["count"].idxmax()]
        if zh:
            peak = f"，发文高峰为{peak_row['year']}年（{int(peak_row['count'])}篇）"
        else:
            peak = f", peaking in {peak_row['year']} ({int(peak_row['count'])} articles)"

    kw_net = ctx["networks"].get("keyword", {})
    n_clusters = len(kw_net.get("clusters", {}))

    top_countries = stats.get("top_countries")
    top_authors = stats.get("top_authors")
    burst_data = stats.get("bursts", {})
    burst_df = burst_data.get("burst_terms", pd.DataFrame())
    frontiers = stats.get("frontiers", {})
    frontier_df = frontiers.get("frontier_topics", pd.DataFrame())

    if zh:
        lines = ["## 摘要\n"]
        lines.append(
            f"**背景：** 本研究对MEDLINE (via PubMed)数据库中收录的「{ctx['query']}」相关文献进行文献计量分析。"
        )
        lines.append(
            f"\n**方法：** 采用NCBI E-utilities API系统检索（检索过滤范围：{search_year_range}），"
            f"运用共现分析、Louvain社区检测、爆发词识别及综合前沿评分等方法，"
            f"并对Lotka定律、Bradford定律和Zipf定律进行验证。"
        )
        if search_year_range != year_range:
            lines.append(
                f"\n**日期口径：** PubMed检索日期过滤范围（{search_year_range}）与"
                f"文献元数据中的实际期刊/卷期年份（{year_range}）是两个不同字段。"
            )
        results_parts = [
            f"\n**结果：** 共分析来自{ctx['n_journals']}种期刊、{ctx['n_countries']}个国家的"
            f"{n}篇文献（{year_range}）{peak}。"
        ]
        if top_countries is not None and not top_countries.empty:
            top_c = top_countries.iloc[0]
            results_parts.append(f"发文量最多的国家为{top_c['countries']}（{int(top_c['count'])}篇）。")
        if top_authors is not None and not top_authors.empty:
            top_a = top_authors.iloc[0]
            if int(top_a["count"]) > 1:
                results_parts.append(f"高产作者为{top_a['authors_normalized']}（{int(top_a['count'])}篇）。")
        results_parts.append(f"网络分析识别出{n_clusters}个研究聚类。")
        if isinstance(burst_df, pd.DataFrame) and not burst_df.empty:
            top_bursts = "、".join(burst_df.head(3)["term"].tolist())
            results_parts.append(f"主要爆发词包括{top_bursts}。")
        lines.append("".join(results_parts))
        if isinstance(frontier_df, pd.DataFrame) and not frontier_df.empty:
            top3 = "、".join(frontier_df.head(3)["topic"].tolist())
            lines.append(f"关键研究前沿包括：{top3}。")
        lines.append(
            f"\n**结论：** 本研究系统描绘了「{ctx['query']}」领域的知识图谱，"
            f"识别了核心贡献者、知识聚类、新兴趋势与研究缺口，"
            f"为后续研究选题和资助决策提供了数据支撑。"
        )
    else:
        lines = ["## Abstract\n"]
        lines.append(
            f"**Background:** This study presents a bibliometric analysis of research "
            f"on \"{ctx['query']}\" indexed in MEDLINE (via PubMed)."
        )
        lines.append(
            f"\n**Methods:** A systematic search was conducted using NCBI E-utilities API "
            f"(search filter: {search_year_range}). "
            f"Co-occurrence analysis, Louvain community detection, burst detection, "
            f"and composite frontier scoring were applied. "
            f"Bibliometric laws (Lotka, Bradford, Zipf) were tested."
        )
        if search_year_range != year_range:
            lines.append(
                f"\n**Date convention:** The PubMed search-date filter ({search_year_range}) and "
                f"the observed journal/issue-year metadata ({year_range}) are distinct fields."
            )
        results_parts = [
            f"\n**Results:** A total of {n} publications ({year_range}) from "
            f"{ctx['n_journals']} journals and {ctx['n_countries']} countries were analyzed"
            f"{peak}."
        ]
        if top_countries is not None and not top_countries.empty:
            top_c = top_countries.iloc[0]
            results_parts.append(
                f" The most productive country was {top_c['countries']} "
                f"({int(top_c['count'])} publications)."
            )
        if top_authors is not None and not top_authors.empty:
            top_a = top_authors.iloc[0]
            if int(top_a["count"]) > 1:
                results_parts.append(
                    f" The most prolific author was {top_a['authors_normalized']} "
                    f"({int(top_a['count'])} publications)."
                )
        results_parts.append(f" Network analysis identified {n_clusters} research clusters.")
        if isinstance(burst_df, pd.DataFrame) and not burst_df.empty:
            top_bursts = ", ".join(burst_df.head(3)["term"].tolist())
            results_parts.append(f" Key burst terms include {top_bursts}.")
        lines.append(" ".join(results_parts))
        if isinstance(frontier_df, pd.DataFrame) and not frontier_df.empty:
            top3 = ", ".join(frontier_df.head(3)["topic"].tolist())
            lines.append(f" Key research frontiers include: {top3}.")
        lines.append(
            f"\n**Conclusions:** This analysis maps the intellectual landscape of "
            f"\"{ctx['query']}\" research, identifying core contributors, "
            f"knowledge clusters, emerging trends, and research gaps."
        )

    return "\n".join(lines)


def _generate_topic_intro_llm(query: str, zh: bool = True) -> str:
    """使用 LLM 生成研究主题的详细介绍（概念+现状）。失败返回空字符串。"""
    try:
        from bibliometric.llm.client import DeepSeekClient

        client = DeepSeekClient()
        if not client.available:
            return ""
        prompt = (
            f"为医学文献计量分析报告撰写「{query}」主题的引言段落（2-3段，200-300字）。\n"
            f"要求：\n"
            f"1. 第一段：简述该主题的核心概念、定义或临床意义\n"
            f"2. 第二段：描述当前研究现状、流行趋势或学术关注度\n"
            f"3. 第三段：说明文献计量分析对该领域的价值和本研究目的\n"
            f"4. 语言专业、学术，避免空泛表述\n"
            f"5. 只输出段落内容，不要标题"
        ) if zh else (
            f"Write an introduction (2-3 paragraphs, 200-300 words) for a bibliometric analysis report on \"{query}\".\n"
            f"Requirements:\n"
            f"1. First paragraph: Describe the core concept, definition, or clinical significance\n"
            f"2. Second paragraph: Discuss current research status, trends, or academic attention\n"
            f"3. Third paragraph: Explain the value of bibliometric analysis and study objectives\n"
            f"4. Use professional, academic language; avoid generic statements\n"
            f"5. Output only the paragraphs, no headings"
        )
        return client.complete(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "你是医学研究写作专家，擅长撰写学术报告引言。"
                        if zh
                        else "You are a medical research writing expert specializing in academic report introductions."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            tier="pro",
            max_tokens=800,
        ).strip()
    except Exception as e:
        logger.warning(f"LLM topic intro generation failed: {e}")
        return ""


def _introduction(ctx):
    ai = ctx["stats"].get("ai_narratives", {})
    ai_intro = ai.get("introduction", "")
    zh = ctx.get("lang") == "zh"

    if ai_intro:
        heading = "## 1. 引言\n\n" if zh else "## 1. Introduction\n\n"
        return heading + ai_intro

    # 尝试使用 LLM 生成详细主题介绍
    topic_intro = _generate_topic_intro_llm(ctx['query'], zh)

    heading = "## 1. 引言\n\n" if zh else "## 1. Introduction\n\n"

    if topic_intro:
        return heading + topic_intro

    # LLM失败时简化兜底（仅说明文献计量分析价值）
    if zh:
        fallback = (
            f"文献计量分析作为定量研究方法，能够通过对科学文献的系统分析，"
            f"揭示学科发展规律和知识演化趋势。本研究基于MEDLINE (via PubMed)数据库，"
            f"运用文献计量学方法对「{ctx['query']}」领域进行系统分析，"
            f"旨在识别核心贡献者、把握研究热点与前沿方向。"
        )
    else:
        fallback = (
            f"Bibliometric analysis provides a quantitative approach to examining scientific literature, "
            f"revealing patterns of disciplinary development and knowledge evolution. "
            f"This study employs bibliometric methods to systematically analyze literature on \"{ctx['query']}\" "
            f"retrieved from MEDLINE (via PubMed), aiming to identify key contributors and understand research hotspots."
        )

    return heading + fallback


def _methods(ctx):
    n = ctx["n"]
    strategy = ctx.get("search_strategy", {})
    zh = ctx.get("lang") == "zh"

    if zh:
        lines = [
            "## 2. 方法\n",
            "### 2.1 数据来源与检索策略\n",
            f"本研究于{ctx['date_str']}通过NCBI E-utilities API对MEDLINE（via PubMed）数据库"
            f"进行系统检索。\n",
        ]

        if strategy.get("concepts"):
            concepts = strategy["concepts"]
            # LLM 生成路径：只有一个占位概念，直接说明检索式由 LLM 生成
            if len(concepts) == 1 and concepts[0].get("llm_generated"):
                lines.append("检索策略由大语言模型（LLM）根据研究主题自动生成，包含MeSH主题词与自由词组合。\n")
            else:
                lines.append("检索策略采用医学主题词（MeSH）和自由词（标题/摘要字段）组合，各概念块以布尔AND算符连接：\n")
                for ci, concept in enumerate(concepts, 1):
                    mesh_desc = concept.get("mesh_descriptor")
                    free = concept.get("free_terms", [])
                    label = concept.get("label", "")
                    if isinstance(label, bytes):
                        label = label.decode('utf-8', errors='replace')
                    lines.append(f"**概念{ci}（{label}）：**")
                    entry = concept.get("entry_terms_used", [])
                    if mesh_desc:
                        lines.append(f"- MeSH: \"{mesh_desc}\"[MeSH Terms]")
                        if entry:
                            lines.append(f"- 入口词: {', '.join(entry[:5])}")
                    elif concept.get("mesh_lookup_failed"):
                        lines.append("- MeSH: 未使用（采用自由词检索）")
                    else:
                        lines.append("- MeSH: 无匹配描述词（使用自由词检索）")
                    entry_set = {e.lower() for e in entry}
                    free_terms_clean = []
                    for t in free[:5]:
                        if isinstance(t, bytes):
                            t = t.decode('utf-8', errors='replace')
                        if t.lower() not in entry_set:
                            free_terms_clean.append(t)
                    ft_str = "; ".join(f'"{t}"[Title/Abstract]' for t in free_terms_clean)
                    lines.append(f"- 自由词: {ft_str if ft_str else '（见完整检索式）'}")
                    lines.append("")

        formal_query = strategy.get("formal_query", ctx["query"])
        # 确保检索式正确编码
        if isinstance(formal_query, bytes):
            formal_query = formal_query.decode('utf-8', errors='replace')
        lines.append("**完整检索式：**\n")
        lines.append(f"```\n{formal_query}\n```\n")

        lines.append("### 2.2 纳入与排除标准\n")
        lines.append("**纳入标准：**")
        lines.append(f"- 符合检索策略的MEDLINE收录文献")
        lines.append(f"- PubMed检索日期过滤范围：{ctx['search_year_range']}")
        if ctx["search_year_range"] != ctx["year_range"]:
            lines.append(
                f"- 文献元数据的实际期刊/卷期年份：{ctx['year_range']}；"
                "该字段与PubMed检索日期过滤范围分开报告"
            )
        lines.append("- 文献类型：原始研究、综述、Meta分析、系统评价\n")
        lines.append("**排除标准：**")
        lines.append("- 重复记录（通过PMID及标准化标题匹配识别）")
        lines.append("- 元数据缺失或无法解析的记录")
        lines.append("- 已撤稿文献")
        lines.append("- 述评、评论、信件、勘误等非研究性文献\n")

        lines.append("### 2.3 数据处理\n")
        lines.append(
            "从PubMed XML格式解析文献记录，作者姓名规范化为「姓 名字首字母」格式，"
            "通过模式匹配提取机构信息，合并MeSH主题词与作者自定义关键词，"
            "并剔除「Humans」、「Male」、「Female」等无信息量的人口学限定词，"
            "通过PMID和标准化标题进行去重处理。\n"
        )

        tbl = _next_table(ctx)
        lines.append("### 2.4 软件与工具\n")
        lines.append(f"表{tbl}. 本研究使用的软件与工具\n")
        lines.append("| 工具 | 用途 | 版本/来源 |")
        lines.append("|------|------|-----------|")
        lines.append("| NCBI E-utilities API | 数据检索 | eutils.ncbi.nlm.nih.gov |")
        lines.append("| Python | 编程环境 | 3.9+ |")
        lines.append("| NetworkX | 网络构建与分析 | 3.x |")
        lines.append("| community (python-louvain) | Louvain社区检测 | 0.16+ |")
        lines.append("| scikit-learn | TF-IDF向量化、轮廓系数计算 | 1.x |")
        lines.append("| matplotlib / plotly | 可视化 | — |")
        lines.append("| VOSviewer（导出） | 交互式网络探索 | 1.6.x兼容 |\n")

        lines.append("### 2.5 分析框架\n")
        lines.append("- **描述性统计：** 年度发文趋势、高产贡献者（作者、机构、期刊、国家）")
        lines.append("- **共现分析：** 关键词、作者、机构、国家共现矩阵（最小频次阈值筛选）")
        lines.append("- **网络分析：** NetworkX构建图谱，Louvain社区检测（Blondel et al., 2008），中心性指标包括度中心性、中介中心性（共现强度倒数加权）和接近中心性")
        lines.append("- **聚类质量：** 模块度Q（Newman, 2006）和平均轮廓系数评估聚类效果")
        lines.append("- **爆发词检测：** Kleinberg自动机爆发检测算法（Kleinberg, 2003），识别频率突增的关键词")
        lines.append("- **前沿识别：** 综合评分（近期增长率35%、爆发强度25%、新颖性25%、网络中心性15%），各指标最小-最大归一化；新颖性定义为关键词首次出现时间在研究期内的相对位置（最近出现得分最高）")
        lines.append("- **文献计量定律：** 采用对数线性回归（log-log OLS）验证三项定律：①洛特卡定律——以作者发文量分布拟合幂律，指数≈2.0且R²>0.8视为符合；②布拉德福定律——将期刊按发文量降序排列并划分为三个等文献量区，计算区间期刊数比值（布拉德福乘数）；③齐普夫定律——以关键词频率-排名对数回归，指数≈1.0且R²>0.8视为符合（Lotka, 1926; Bradford, 1934; Zipf, 1949）\n")
    else:
        lines = [
            "## 2. Methods\n",
            "### 2.1 Data Source and Search Strategy\n",
            f"A bibliometric search was conducted on MEDLINE (via PubMed) using the NCBI "
            f"E-utilities API on {ctx['date_str']}.\n",
        ]

        if strategy.get("concepts"):
            concepts = strategy["concepts"]
            if len(concepts) == 1 and concepts[0].get("llm_generated"):
                lines.append("The search strategy was automatically generated by a large language model (LLM) based on the research topic, incorporating MeSH terms and free-text synonyms.\n")
            else:
                lines.append("The search strategy was constructed using a combination of "
                              "Medical Subject Headings (MeSH) descriptors and free-text "
                              "terms in Title/Abstract fields. Concept blocks were combined "
                              "with the Boolean AND operator:\n")
                for ci, concept in enumerate(concepts, 1):
                    mesh_desc = concept.get("mesh_descriptor")
                    free = concept.get("free_terms", [])
                    lines.append(f"**Concept {ci} ({concept['label']}):**")
                    entry = concept.get("entry_terms_used", [])
                    if mesh_desc:
                        lines.append(f"- MeSH: \"{mesh_desc}\"[MeSH Terms]")
                        if entry:
                            lines.append(f"- Entry terms: {', '.join(entry[:5])}")
                    elif concept.get("mesh_lookup_failed"):
                        lines.append("- MeSH: lookup failed (API/network error; free-text search used)")
                    else:
                        lines.append("- MeSH: no matching descriptor found (free-text search used)")
                    entry_set = {e.lower() for e in entry}
                    free_display = [t for t in free[:5] if t.lower() not in entry_set]
                    ft_str = "; ".join(f'"{t}"[Title/Abstract]' for t in free_display)
                    lines.append(f"- Free-text: {ft_str if ft_str else '(see full search string)'}")
                    lines.append("")

        formal_query = strategy.get("formal_query", ctx["query"])
        lines.append(f"**Complete search string:**\n")
        lines.append(f"```\n{formal_query}\n```\n")

        lines.append("### 2.2 Inclusion and Exclusion Criteria\n")
        lines.append("**Inclusion criteria:**")
        lines.append(f"- Articles indexed in MEDLINE matching the search strategy")
        lines.append(f"- PubMed publication-date filter: {ctx['search_year_range']}")
        if ctx["search_year_range"] != ctx["year_range"]:
            lines.append(
                f"- Observed journal/issue-year metadata: {ctx['year_range']}; "
                "this field is reported separately from the PubMed search-date filter"
            )
        lines.append("- Article types: original research, reviews, meta-analyses, systematic reviews\n")
        lines.append("**Exclusion criteria:**")
        lines.append("- Duplicate records (identified by PMID and normalized title matching)")
        lines.append("- Records with missing or unparseable metadata")
        lines.append("- Retracted publications")
        lines.append("- Non-research articles (editorials, commentaries, letters, errata)\n")

        lines.append("### 2.3 Data Processing\n")
        lines.append(
            "Records were parsed from PubMed XML format. Author names were normalized "
            "to \"LastName Initials\" format. Institutional affiliations were extracted "
            "using pattern matching. Keywords were merged from both MeSH descriptors "
            "and author-supplied keywords, with non-informative terms (demographic "
            "qualifiers such as \"Humans\", \"Male\", \"Female\") removed. "
            "Deduplication was performed by PMID and normalized title matching.\n"
        )

        tbl = _next_table(ctx)
        lines.append("### 2.4 Software and Tools\n")
        lines.append(f"Table {tbl}. Software and tools used in this analysis\n")
        lines.append("| Tool | Purpose | Version/Source |")
        lines.append("|------|---------|----------------|")
        lines.append("| NCBI E-utilities API | Data retrieval | eutils.ncbi.nlm.nih.gov |")
        lines.append("| Python | Programming environment | 3.9+ |")
        lines.append("| NetworkX | Network construction and analysis | 3.x |")
        lines.append("| community (python-louvain) | Louvain community detection | 0.16+ |")
        lines.append("| scikit-learn | TF-IDF vectorization, silhouette scoring | 1.x |")
        lines.append("| matplotlib / plotly | Visualization | — |")
        lines.append("| VOSviewer (export) | Interactive network exploration | 1.6.x compatible |\n")

        lines.append("### 2.5 Analytical Framework\n")
        lines.append(
            "- **Descriptive statistics:** Annual publication trends, top contributors "
            "(authors, institutions, journals, countries)"
        )
        lines.append(
            "- **Co-occurrence analysis:** Keyword, author, institution, and country "
            "co-occurrence matrices with minimum frequency threshold"
        )
        lines.append(
            "- **Network analysis:** NetworkX graph construction with Louvain community "
            "detection (Blondel et al., 2008). Centrality metrics include degree, "
            "betweenness (with inverted weights for co-occurrence strength), and "
            "closeness centrality"
        )
        lines.append(
            "- **Cluster quality:** Modularity Q (Newman, 2006) and mean silhouette "
            "score for partition evaluation"
        )
        lines.append(
            "- **Burst detection:** Kleinberg's automaton-based burst detection "
            "(Kleinberg, 2003) with Viterbi-like forward pass for identifying "
            "keywords with sudden frequency increases"
        )
        lines.append(
            "- **Frontier identification:** Composite scoring based on recent growth "
            "rate (35%), burst score (25%), novelty (25%), and network centrality (15%), "
            "with min-max normalization across all candidates. "
            "Novelty is defined as the proportion of a keyword's first appearance "
            "relative to the study period: keywords first appearing in the most recent "
            "period receive a novelty score of 1.0, while those present since the "
            "earliest year receive a score proportional to their position in the "
            "timeline (year_index / total_years). This captures how recently a "
            "concept entered the literature"
        )
        lines.append(
            "- **Bibliometric laws:** Three laws were tested via log-log OLS regression: "
            "① Lotka's Law — power-law fit of author productivity distribution (conforms if exponent ≈ 2.0 and R² > 0.8); "
            "② Bradford's Law — journals ranked by output and divided into three equal-article zones, with the Bradford multiplier (Zone 2 / Zone 1 journal count) quantifying scatter; "
            "③ Zipf's Law — frequency-rank log regression of keywords (conforms if exponent ≈ 1.0 and R² > 0.8) "
            "(Lotka, 1926; Bradford, 1934; Zipf, 1949)\n"
        )

    return "\n".join(lines)


def _discussion(ctx):
    stats = ctx["stats"]
    zh = ctx.get("lang") == "zh"
    lines = ["## 4. 讨论\n" if zh else "## 4. Discussion\n"]

    ai = stats.get("ai_narratives", {})
    ai_disc = ai.get("discussion", "")
    if ai_disc:
        lines.append(ai_disc)
    else:
        # 生成综合性段落讨论
        year_df = stats.get("year_trend")
        top_authors = stats.get("top_authors")
        top_countries = stats.get("top_countries")
        kw_net = ctx["networks"].get("keyword", {})
        n_clusters = len(kw_net.get("clusters", {}))
        frontiers = stats.get("frontiers", {})

        if zh:
            para = f"本研究通过文献计量学方法对\"{ctx['query']}\"领域的研究现状进行了系统分析，研究时段（{ctx['year_range']}）内共检索到{ctx['n']}篇相关文献。"

            if year_df is not None and not year_df.empty:
                complete_df = year_df[~year_df["is_partial"]] if "is_partial" in year_df.columns else year_df
                if not complete_df.empty:
                    peak_year = complete_df.loc[complete_df["count"].idxmax(), "year"]
                    peak_count = int(complete_df.loc[complete_df["count"].idxmax(), "count"])
                    para += f"发文量呈持续增长趋势，峰值出现在{peak_year}年（{peak_count}篇），表明该领域正处于快速发展阶段，学术关注度不断提升。"

            if top_countries is not None and not top_countries.empty:
                top_country = top_countries.iloc[0]["countries"]
                top_count = int(top_countries.iloc[0]["count"])
                para += f"从地域分布来看，{top_country}在该领域占据主导地位（{top_count}篇），反映出其在相关研究中的领先优势。"

            if top_authors is not None and not top_authors.empty:
                top_author = top_authors.iloc[0]["authors_normalized"]
                author_count = int(top_authors.iloc[0]["count"])
                para += f"核心作者群体已经形成，其中{top_author}发文量最高（{author_count}篇），显示出该领域已建立起相对稳定的研究团队。"

            if n_clusters > 0:
                quality = kw_net.get("quality", {})
                modularity = quality.get("modularity", 0)
                para += f"知识结构分析识别出{n_clusters}个主要研究聚类（模块度Q = {modularity:.3f}），表明该领域已形成相对清晰的研究主题分化。"
                clusters = kw_net.get("clusters", {})
                cluster_labels = stats.get("cluster_labels", {})
                if clusters:
                    top_cluster_id = max(clusters.keys(), key=lambda cid: len(clusters[cid]))
                    cluster_label = cluster_labels.get(top_cluster_id, {}).get("zh_label") or \
                                    cluster_labels.get(top_cluster_id, {}).get("en_label", f"聚类{top_cluster_id}")
                    para += f"其中\"{cluster_label}\"聚类规模最大，代表了当前研究的核心方向。"

            if frontiers and "top_frontiers" in frontiers:
                top_frontiers_list = frontiers["top_frontiers"][:3]
                if top_frontiers_list:
                    frontier_terms = "、".join([f["keyword"] for f in top_frontiers_list])
                    para += f"前沿识别分析显示，{frontier_terms}等关键词代表了该领域的新兴研究方向，这些主题近期增长迅速，具有较高的学术关注度和创新潜力，值得研究者重点关注。"

            lines.append(para)
        else:
            para = (
                f"This study systematically analyzed the research landscape of \"{ctx['query']}\" "
                f"using bibliometric methods, identifying {ctx['n']} publications spanning {ctx['year_range']}."
            )

            if year_df is not None and not year_df.empty:
                complete_df = year_df[~year_df["is_partial"]] if "is_partial" in year_df.columns else year_df
                if not complete_df.empty:
                    peak_year = complete_df.loc[complete_df["count"].idxmax(), "year"]
                    peak_count = int(complete_df.loc[complete_df["count"].idxmax(), "count"])
                    para += (
                        f" Publication volume showed sustained growth, peaking in {peak_year} ({peak_count} articles), "
                        f"indicating rapid development and increasing academic attention."
                    )

            if top_countries is not None and not top_countries.empty:
                top_country = top_countries.iloc[0]["countries"]
                top_count = int(top_countries.iloc[0]["count"])
                para += (
                    f" Geographically, {top_country} dominates the field with {top_count} publications, "
                    f"reflecting its leading position in this research area."
                )

            if top_authors is not None and not top_authors.empty:
                top_author = top_authors.iloc[0]["authors_normalized"]
                author_count = int(top_authors.iloc[0]["count"])
                para += (
                    f" A core group of prolific authors has emerged, with {top_author} being the most productive ({author_count} publications), "
                    f"indicating the establishment of stable research teams."
                )

            if n_clusters > 0:
                quality = kw_net.get("quality", {})
                modularity = quality.get("modularity", 0)
                para += (
                    f" Knowledge structure analysis identified {n_clusters} major research clusters (modularity Q = {modularity:.3f}), "
                    f"suggesting clear thematic differentiation within the field."
                )
                clusters = kw_net.get("clusters", {})
                cluster_labels = stats.get("cluster_labels", {})
                if clusters:
                    top_cluster_id = max(clusters.keys(), key=lambda cid: len(clusters[cid]))
                    cluster_label = cluster_labels.get(top_cluster_id, {}).get("en_label", f"Cluster {top_cluster_id}")
                    para += f" The \"{cluster_label}\" cluster represents the largest research focus, indicating the core direction of current investigations."

            if frontiers and "top_frontiers" in frontiers:
                top_frontiers_list = frontiers["top_frontiers"][:3]
                if top_frontiers_list:
                    frontier_terms = ", ".join([f["keyword"] for f in top_frontiers_list])
                    para += (
                        f" Frontier analysis reveals that keywords such as {frontier_terms} represent emerging research directions "
                        f"with rapid recent growth and high innovation potential, warranting focused investigation."
                    )

            lines.append(para)

    insights = stats.get("insights", [])
    # insights 描述由 miner.py 生成，固定为英文；中文模式下 LLM 已将其内容融入讨论正文，无需再追加
    if ai_disc and insights and not zh:
        para = " ".join(ins["description"] for ins in insights)
        lines.append(f"\n{para}\n\n")

    # 局限性直接接在讨论后面，不单独分小节
    if zh:
        lines.append(
            "本研究存在若干局限性，在解读结果时需加以考量。"
            "首先，分析仅限于PubMed收录文献，可能遗漏Scopus、Web of Science、Embase等数据库中的相关研究，"
            "多数据库联合检索有助于进一步提升文献覆盖度。"
            "其次，PubMed本身不提供引用计数，本报告中的引用估算基于期刊影响因子层级、发表年份和文献类型进行模拟，"
            "应视为近似参考指标而非精确计数，解读时需保持审慎。"
            "第三，检索虽未设语言限制，但PubMed以英文文献为主，"
            "其他语言发表的研究可能未能充分纳入，存在一定的语言偏倚。"
            "第四，作者和机构名称通过启发式方法规范化，对于常见姓名或复杂隶属关系可能引入误差，"
            "本研究未采用ORCID进行精确消歧。"
            "第五，分析结果受MeSH索引质量和作者自定义关键词质量影响，"
            "近期文献的MeSH索引可能尚不完整，从而影响关键词共现分析的准确性。"
            "第六，文献计量分析存在固有的马太效应，高产作者和知名机构往往受到不成比例的关注，"
            "可能遮蔽新兴研究者与机构的贡献。\n"
        )
    else:
        lines.append(
            "Several limitations should be considered when interpreting the findings of this study. "
            "First, the analysis is restricted to PubMed-indexed publications, which may exclude relevant literature "
            "from other databases such as Scopus, Web of Science, and Embase; "
            "multi-database searches would improve overall coverage, particularly for non-biomedical dimensions of the topic. "
            "Second, PubMed does not provide citation counts, and the citation estimates reported here are modeled "
            "using journal impact factor tiers, publication year, and article type; "
            "they should be interpreted as approximate indicators rather than exact counts. "
            "Third, while no language restrictions were applied, PubMed predominantly indexes English-language publications, "
            "which may underrepresent research published in other languages. "
            "Fourth, author and institutional names were normalized using heuristic methods, "
            "which may introduce errors for common surnames or complex affiliations; "
            "ORCID-based disambiguation was not available. "
            "Fifth, the results depend on the completeness of MeSH indexing and author-supplied keywords; "
            "recently published articles may not yet have full MeSH annotations, "
            "potentially affecting keyword co-occurrence analyses. "
            "Sixth, bibliometric analyses are inherently subject to the Matthew effect, "
            "where highly cited authors and established institutions may receive disproportionate attention, "
            "potentially overshadowing the contributions of emerging researchers.\n"
        )

    return "\n".join(lines)


def _conclusion(ctx):
    zh = ctx.get("lang") == "zh"
    ai = ctx["stats"].get("ai_narratives", {})
    ai_concl = ai.get("conclusion", "")
    if ai_concl:
        heading = "## 5. 结论\n\n" if zh else "## 5. Conclusions\n\n"
        return heading + ai_concl

    stats = ctx["stats"]
    year_df = stats.get("year_trend")
    kw_net = ctx["networks"].get("keyword", {})
    n_clusters = len(kw_net.get("clusters", {}))
    quality = kw_net.get("quality", {})
    modularity = quality.get("modularity", 0)
    frontiers = stats.get("frontiers", {})
    top_authors = stats.get("top_authors")
    top_countries = stats.get("top_countries")

    total = int(year_df["count"].sum()) if year_df is not None and not year_df.empty else ctx["n"]
    complete_df = (year_df[~year_df["is_partial"]] if "is_partial" in year_df.columns else year_df) if year_df is not None else None
    peak_year = complete_df.loc[complete_df["count"].idxmax(), "year"] if complete_df is not None and not complete_df.empty else ""
    peak_count = int(complete_df.loc[complete_df["count"].idxmax(), "count"]) if complete_df is not None and not complete_df.empty else 0

    top_country = top_countries.iloc[0]["countries"] if top_countries is not None and not top_countries.empty else ""
    top_author = top_authors.iloc[0]["authors_normalized"] if top_authors is not None and not top_authors.empty else ""

    frontier_terms_zh, frontier_terms_en = "", ""
    if frontiers and "top_frontiers" in frontiers:
        top_frontiers_list = frontiers["top_frontiers"][:3]
        frontier_terms_zh = "、".join([f["keyword"] for f in top_frontiers_list])
        frontier_terms_en = ", ".join([f["keyword"] for f in top_frontiers_list])

    if zh:
        lines = ["## 5. 结论\n"]
        para = (
            f"本研究通过文献计量学方法系统分析了「{ctx['query']}」领域的研究现状与发展态势。"
            f"分析结果揭示了该领域的核心研究力量、知识结构特征及新兴研究方向，"
            f"为研究者把握学科发展脉络、识别研究缺口与合作机会提供了实证依据。"
        )
        if frontier_terms_zh:
            para += (
                f"特别是{frontier_terms_zh}等前沿主题的快速发展，"
                f"预示着该领域未来的重要研究方向。"
            )
        para += (
            f"未来研究可在本分析基础上，结合多数据库文献、引文网络分析及质性研究方法，"
            f"进一步深化对该领域知识演化规律的理解。"
        )
        lines.append(para + "\n")
    else:
        lines = ["## 5. Conclusions\n"]
        para = (
            f"This bibliometric study systematically analyzed the research landscape of \"{ctx['query']}\", "
            f"revealing the field's core research forces, knowledge structure characteristics, and emerging research directions. "
            f"The findings provide empirical evidence for researchers to grasp disciplinary development trajectories, "
            f"identify research gaps, and explore collaboration opportunities. "
        )
        if frontier_terms_en:
            para += (
                f"Notably, the rapid development of frontier topics such as {frontier_terms_en} "
                f"signals important future research directions in this field. "
            )
        para += (
            f"Future research may build upon this analysis by integrating multi-database literature, "
            f"citation network analysis, and qualitative research methods to further deepen understanding "
            f"of knowledge evolution patterns in this domain."
        )
        lines.append(para + "\n")

    return "\n".join(lines)


def _limitations(ctx):
    """Limitations are now inside Discussion. Return empty."""
    return ""


_METHODOLOGY_REFS = [
    "- Aria, M., & Cuccurullo, C. (2017). bibliometrix: An R-tool for "
    "comprehensive science mapping analysis. *Journal of Informetrics*, "
    "11(4), 959–975.",
    "- Blondel, V. D., Guillaume, J.-L., Lambiotte, R., & Lefebvre, E. (2008). "
    "Fast unfolding of communities in large networks. *Journal of Statistical "
    "Mechanics: Theory and Experiment*, 2008(10), P10008.",
    "- Bradford, S. C. (1934). Sources of information on specific subjects. "
    "*Engineering*, 137, 85–86.",
    "- Chen, C. (2006). CiteSpace II: Detecting and visualizing emerging trends "
    "and transient patterns in scientific literature. *Journal of the American "
    "Society for Information Science and Technology*, 57(3), 359–377.",
    "- Dontcheva, G. D., et al. (2023). BIBLIO: A checklist for reporting "
    "biomedical bibliometric reviews. *Systematic Reviews*, 12, 207.",
    "- Kleinberg, J. (2003). Bursty and hierarchical structure in streams. "
    "*Data Mining and Knowledge Discovery*, 7(4), 373–397.",
    "- Lotka, A. J. (1926). The frequency distribution of scientific productivity. "
    "*Journal of the Washington Academy of Sciences*, 16(12), 317–323.",
    "- Newman, M. E. J. (2006). Modularity and community structure in networks. "
    "*Proceedings of the National Academy of Sciences*, 103(23), 8577–8582.",
    "- Page, M. J., et al. (2021). The PRISMA 2020 statement: An updated "
    "guideline for reporting systematic reviews. *BMJ*, 372, n71.",
    "- Pritchard, A. (1969). Statistical bibliography or bibliometrics? "
    "*Journal of Documentation*, 25(4), 348–349.",
    "- van Eck, N. J., & Waltman, L. (2010). Software survey: VOSviewer, a "
    "computer program for bibliometric mapping. *Scientometrics*, 84(2), 523–538.",
    "- Zipf, G. K. (1949). *Human Behavior and the Principle of Least Effort*. "
    "Addison-Wesley.",
]


def _format_article_ref(idx: int, a: dict) -> str:
    """Format a PubMed article as a numbered reference entry."""
    authors = a.get("authors", [])
    if isinstance(authors, list):
        def _to_str(a):
            if isinstance(a, dict):
                last = a.get("last_name") or a.get("LastName") or a.get("lastname") or ""
                initials = a.get("initials") or a.get("Initials") or ""
                fore = a.get("fore_name") or a.get("ForeName") or a.get("forename") or ""
                if last and initials:
                    return f"{last} {initials}"
                if last and fore:
                    return f"{last} {fore[:1]}"
                if last:
                    return last
                return a.get("name") or str(a)
            return str(a)
        names = [_to_str(a) for a in authors]
        if len(names) > 6:
            author_str = "; ".join(names[:6]) + ", et al."
        elif names:
            author_str = "; ".join(names) + "."
        else:
            author_str = "Anonymous."
    else:
        author_str = f"{authors}."

    title = a.get("title", "").rstrip(".")
    year = a.get("year", "")
    journal = a.get("journal", {})
    journal_title = journal.get("title", "") if isinstance(journal, dict) else str(journal)
    pmid = a.get("pmid", "")
    doi = a.get("doi", "")

    parts = [f"{idx}. {author_str} ({year}). {title}."]
    if journal_title:
        parts.append(f" *{journal_title}*.")
    if pmid:
        parts.append(f" PMID: [{pmid}](https://pubmed.ncbi.nlm.nih.gov/{pmid}/).")
    if doi:
        parts.append(f" https://doi.org/{doi}.")
    return "".join(parts)


def _references(ctx=None):
    zh = (ctx or {}).get("lang") == "zh"
    heading = "## 参考文献\n" if zh else "## References\n"
    lines = [heading]

    # 纳入分析的文献（真实 PubMed 数据）
    articles = (ctx or {}).get("articles", [])
    if articles:
        sorted_articles = sorted(articles, key=lambda x: x.get("year", ""), reverse=True)
        if zh:
            lines.append("### 纳入分析文献\n")
        else:
            lines.append("### Analyzed Literature\n")
        for i, a in enumerate(sorted_articles, 1):
            lines.append(_format_article_ref(i, a))
        lines.append("")

    # 方法学参考文献
    if zh:
        lines.append("### 方法学参考文献\n")
    else:
        lines.append("### Methodological References\n")
    lines.extend(_METHODOLOGY_REFS)

    return "\n".join(lines)


def _appendix(ctx=None):
    zh = (ctx or {}).get("lang") == "zh"
    if zh:
        lines = [
            "## 附录\n",
            "### 数据可及性\n",
            "本研究所有数据来源于PubMed公开数据库。分析代码、共现矩阵、网络图谱及VOSviewer兼容文件可根据合理要求提供。",
        ]
    else:
        lines = [
            "## Appendix\n",
            "### Data Availability\n",
            "All data used in this study are publicly available from PubMed. "
            "Analysis code, co-occurrence matrices, network files, and VOSviewer-compatible "
            "outputs are available upon reasonable request.",
        ]
    return "\n".join(lines)
