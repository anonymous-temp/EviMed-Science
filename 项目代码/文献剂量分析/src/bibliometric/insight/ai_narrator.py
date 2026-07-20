# [IN] articles, stats, networks, config
# [OUT] AI-generated narrative sections (intro, discussion, conclusion)
# [POS] src/bibliometric/insight/ai_narrator.py - LLM-powered report narratives

from __future__ import annotations

import json
import logging
from typing import Optional

import pandas as pd

from bibliometric.insight.templates import (
    describe_key_findings,
    describe_trend,
    template_results_authors,
    template_results_authors_zh,
    template_results_citation,
    template_results_citation_zh,
    template_results_clusters,
    template_results_clusters_zh,
    template_results_countries,
    template_results_countries_zh,
    template_results_frontiers,
    template_results_frontiers_zh,
    template_results_hotspots,
    template_results_hotspots_zh,
    template_results_institutions,
    template_results_institutions_zh,
    template_results_journals,
    template_results_journals_zh,
    template_results_keyword_network,
    template_results_keyword_network_zh,
    template_results_trends,
    template_results_trends_zh,
)

logger = logging.getLogger(__name__)


def generate_ai_narratives(
    query: str,
    articles: list[dict],
    stats: dict,
    networks: dict,
    config=None,
    lang: str = "en",
) -> dict[str, str]:
    """Generate AI-enhanced narrative sections for the report.

    Tries DeepSeek V4 Pro, then falls back to deterministic smart templates.
    lang: 'en' (default) | 'zh' (Chinese output)
    """
    data_summary = _build_data_summary(query, articles, stats, networks)

    # Try LLM APIs
    narratives = _try_deepseek_api(data_summary, config, lang=lang)
    if not narratives:
        narratives = _smart_template_narratives(query, articles, stats, networks, lang=lang)
        logger.info("Using template-based narratives (no LLM API key found)")
    else:
        logger.info("Generated AI-enhanced narratives via LLM")

    return narratives


def _build_data_summary(query, articles, stats, networks) -> str:
    """Build concise data summary for LLM prompt."""
    n = len(articles)
    years = sorted(set(str(a.get("year", "")) for a in articles if a.get("year")))

    summary_parts = [
        f"Topic: {query}",
        f"Total articles: {n}, Years: {years[0] if years else '?'}-{years[-1] if years else '?'}",
    ]

    # Top keywords
    kw_df = stats.get("top_keywords")
    if kw_df is not None and not kw_df.empty:
        top_kw = ", ".join(kw_df.head(10)["keywords_merged"].tolist())
        summary_parts.append(f"Top keywords: {top_kw}")

    # Top countries
    country_df = stats.get("top_countries")
    if country_df is not None and not country_df.empty:
        top_c = ", ".join(country_df.head(5)["countries"].tolist())
        summary_parts.append(f"Top countries: {top_c}")

    # Clusters
    cluster_labels = stats.get("cluster_labels", {})
    if cluster_labels:
        labels = [v.get("en_label", "") for v in cluster_labels.values()]
        summary_parts.append(f"Research clusters: {'; '.join(labels)}")

    # Insights
    insights = stats.get("insights", [])
    for ins in insights[:5]:
        summary_parts.append(f"Insight: {ins.get('title', '')}: {ins.get('description', '')}")

    # Frontiers
    frontiers = stats.get("frontiers", {})
    frontier_df = frontiers.get("frontier_topics")
    if frontier_df is not None and hasattr(frontier_df, "empty") and not frontier_df.empty:
        top_f = ", ".join(frontier_df.head(5)["topic"].tolist())
        summary_parts.append(f"Research frontiers: {top_f}")

    # Citation stats
    cite_stats = stats.get("citation_stats", {})
    if cite_stats:
        summary_parts.append(
            f"H-index: {cite_stats.get('h_index', 'N/A')}, "
            f"Total citations: {cite_stats.get('total_citations', 'N/A')}"
        )

    # Bib laws
    bib_laws = stats.get("bib_laws", {})
    lotka = bib_laws.get("lotka", {})
    if lotka.get("valid"):
        lotka_exp = lotka.get("exponent", 0)
        summary_parts.append(
            f"Lotka's Law: exponent={lotka_exp}, "
            f"R²={lotka.get('r_squared', 'N/A')}, "
            f"{'conforms' if lotka.get('conforms') else 'deviates'}"
        )
        if lotka_exp > 3.0:
            pct_one = lotka.get("pct_one_paper", 0)
            summary_parts.append(
                f"[CROSS-CHECK WARNING] Lotka exponent={lotka_exp:.2f} indicates "
                f"extremely dispersed authorship ({pct_one:.0%} single-paper authors). "
                f"Do NOT describe this as 'concentrated' or 'dominated by a few'. "
                f"Use 'highly dispersed' or 'fragmented'."
            )

    # --- Per-section data blocks for Results narratives ---

    # [TRENDS DATA]
    year_df = stats.get("year_trend")
    if year_df is not None and not year_df.empty:
        rows = year_df.to_dict("records")
        trend_lines = []
        for r in rows:
            line = f"  {r.get('year')}: {int(r.get('count', 0))}"
            if r.get("is_partial"):
                annualized = int(r.get("annualized_count", r.get("count", 0)))
                line += f"  [PARTIAL YEAR — only Jan–present data; annualized estimate: ~{annualized}]"
            trend_lines.append(line)
        summary_parts.append(
            "[TRENDS DATA]\n" + "\n".join(trend_lines)
            + "\n  [NOTE: Do NOT use partial-year data for trend comparisons. "
            "Compare only complete years.]"
        )

    # [AUTHORS DATA]
    author_df = stats.get("top_authors")
    if author_df is not None and not author_df.empty:
        top = author_df.head(10).to_dict("records")
        summary_parts.append(
            "[AUTHORS DATA]\n"
            + "\n".join(
                f"  {r.get('authors_normalized', '?')}: {int(r.get('count', 0))}"
                for r in top
            )
        )

    # [INSTITUTIONS DATA]
    inst_df = stats.get("top_institutions")
    if inst_df is not None and not inst_df.empty:
        top = inst_df.head(10).to_dict("records")
        summary_parts.append(
            "[INSTITUTIONS DATA]\n"
            + "\n".join(
                f"  {r.get('institutions', '?')}: {int(r.get('count', 0))}"
                for r in top
            )
        )

    # [JOURNALS DATA]
    journal_df = stats.get("top_journals")
    if journal_df is not None and not journal_df.empty:
        top = journal_df.head(10).to_dict("records")
        summary_parts.append(
            "[JOURNALS DATA]\n"
            + "\n".join(
                f"  {r.get('journal', '?')}: {int(r.get('count', 0))}"
                for r in top
            )
        )

    # [COUNTRIES DATA]
    if country_df is not None and not country_df.empty:
        top = country_df.head(10).to_dict("records")
        summary_parts.append(
            "[COUNTRIES DATA]\n"
            + "\n".join(
                f"  {r.get('countries', '?')}: {int(r.get('count', 0))}"
                for r in top
            )
        )

    # [KEYWORD NETWORK DATA]
    kw_net = networks.get("keyword", {})
    if kw_net:
        quality = kw_net.get("quality", {})
        q_val = quality.get("modularity", 0)
        net_lines = [
            "[KEYWORD NETWORK DATA]",
            f"  Nodes: {kw_net.get('node_count', 0)}, "
            f"Edges: {kw_net.get('edge_count', 0)}",
            f"  Modularity Q: {q_val:.4f}, "
            f"Silhouette: {quality.get('silhouette', 0):.4f}",
            f"  Clusters: {quality.get('num_clusters', 0)}",
        ]
        if q_val < 0.1:
            net_lines.append(
                "  [WARNING] Modularity Q < 0.1: community structure is NOT significant. "
                "Clustering results should be interpreted with extreme caution. "
                "Do NOT describe this as 'tightly interwoven' or 'well-structured'. "
                "State that clustering is unreliable at this modularity level."
            )
        elif q_val < 0.3:
            net_lines.append(
                "  [NOTE] Modularity Q < 0.3: community structure is weak. "
                "Describe clusters cautiously; avoid overstating thematic separation."
            )
        summary_parts.append("\n".join(net_lines))

        # Add keyword centrality data for bridging term analysis
        kw_centrality = kw_net.get("centrality", {})
        if kw_centrality:
            top_between = sorted(kw_centrality.items(),
                                 key=lambda x: x[1].get("betweenness", 0),
                                 reverse=True)[:5]
            top_degree = sorted(kw_centrality.items(),
                                key=lambda x: x[1].get("weighted_degree", 0),
                                reverse=True)[:5]
            summary_parts.append(
                "[KEYWORD CENTRALITY — Top betweenness (bridging terms)]\n"
                + "\n".join(
                    f"  {n}: betweenness={m.get('betweenness',0):.4f}, "
                    f"degree={m.get('degree',0):.4f}, "
                    f"weighted_degree={m.get('weighted_degree',0):.0f}"
                    for n, m in top_between
                )
            )
            summary_parts.append(
                "[KEYWORD CENTRALITY — Top weighted degree (core terms)]\n"
                + "\n".join(
                    f"  {n}: weighted_degree={m.get('weighted_degree',0):.0f}, "
                    f"betweenness={m.get('betweenness',0):.4f}"
                    for n, m in top_degree
                )
            )

    # [CLUSTERS DATA]
    if cluster_labels:
        cluster_lines = []
        for cid, info in sorted(cluster_labels.items()):
            cluster_lines.append(
                f"  #{cid}: {info.get('en_label', 'N/A')} "
                f"({info.get('category', '')}, size={info.get('size', 0)})"
            )
        summary_parts.append("[CLUSTERS DATA]\n" + "\n".join(cluster_lines))

    # [HOTSPOTS DATA]
    burst_data = stats.get("bursts", {})
    burst_df = burst_data.get("burst_terms")
    if burst_df is not None and hasattr(burst_df, "empty") and not burst_df.empty:
        top_bursts = burst_df.head(10).to_dict("records")
        summary_parts.append(
            "[HOTSPOTS DATA]\n"
            + "\n".join(
                f"  {r.get('term', '?')}: strength={r.get('burst_strength', 0):.2f}, "
                f"{r.get('burst_start', '?')}-{r.get('burst_end', '?')}"
                for r in top_bursts
            )
        )

    # [FRONTIERS DATA]
    if frontier_df is not None and hasattr(frontier_df, "empty") and not frontier_df.empty:
        top_fr = frontier_df.head(10).to_dict("records")
        summary_parts.append(
            "[FRONTIERS DATA]\n"
            + "\n".join(
                f"  {r.get('topic', '?')}: score={r.get('frontier_score', 0):.3f}, "
                f"growth={r.get('growth_rate', 0):.2f}, "
                f"novelty={r.get('novelty_score', 0):.2f}, "
                f"burst={r.get('burst_score', 0):.1f}"
                for r in top_fr
            )
        )

    # [AUTHOR NETWORK DATA]
    author_net = networks.get("author", {})
    if author_net and author_net.get("node_count", 0) > 0:
        a_nodes = author_net.get("node_count", 0)
        a_edges = author_net.get("edge_count", 0)
        a_density = 2 * a_edges / (a_nodes * (a_nodes - 1)) if a_nodes > 1 else 0
        a_components = author_net.get("components", [])
        a_centrality = author_net.get("centrality", {})
        net_lines = [
            "[AUTHOR NETWORK DATA]",
            f"  Nodes: {a_nodes}, Edges: {a_edges}, Density: {a_density:.4f}",
        ]
        if a_components:
            net_lines.append(
                f"  Components: {len(a_components)}, "
                f"largest: {a_components[0].get('size', 0)} nodes"
            )
        if a_centrality:
            top3 = sorted(a_centrality.items(),
                          key=lambda x: x[1].get("weighted_degree", 0),
                          reverse=True)[:3]
            net_lines.append(
                f"  Top collaborators: "
                + ", ".join(f"{n}(deg={m.get('weighted_degree',0):.0f})" for n, m in top3)
            )
        summary_parts.append("\n".join(net_lines))

    # [COUNTRY NETWORK DATA]
    country_net = networks.get("country", {})
    if country_net and country_net.get("node_count", 0) > 0:
        c_nodes = country_net.get("node_count", 0)
        c_edges = country_net.get("edge_count", 0)
        c_density = 2 * c_edges / (c_nodes * (c_nodes - 1)) if c_nodes > 1 else 0
        c_centrality = country_net.get("centrality", {})
        net_lines = [
            "[COUNTRY NETWORK DATA]",
            f"  Nodes: {c_nodes}, Edges: {c_edges}, Density: {c_density:.4f}",
        ]
        if c_centrality:
            top3 = sorted(c_centrality.items(),
                          key=lambda x: x[1].get("degree", 0),
                          reverse=True)[:3]
            net_lines.append(
                f"  Hub countries: "
                + ", ".join(f"{n}(deg={m.get('degree',0):.3f})" for n, m in top3)
            )
        summary_parts.append("\n".join(net_lines))

    # [CITATION DATA]
    if cite_stats:
        summary_parts.append(
            "[CITATION DATA]\n"
            f"  H-index: {cite_stats.get('h_index', 0)}, "
            f"Total: {cite_stats.get('total_citations', 0)}, "
            f"Mean: {cite_stats.get('mean_citations', 0)}, "
            f"Median: {cite_stats.get('median_citations', 0)}"
        )

    # [PUBLICATION TYPE DATA]
    pub_type_df = stats.get("pub_type_distribution")
    if pub_type_df is not None and not pub_type_df.empty:
        top_types = pub_type_df.head(8).to_dict("records")
        summary_parts.append(
            "[PUBLICATION TYPE DATA]\n"
            + "\n".join(
                f"  {r.get('pub_type', '?')}: {int(r.get('count', 0))}"
                for r in top_types
            )
        )

    return "\n".join(summary_parts)


def _try_deepseek_api(
    data_summary: str,
    config=None,
    lang: str = "en",
) -> Optional[dict[str, str]]:
    """Generate all narrative sections with DeepSeek V4 Pro."""
    try:
        from bibliometric.llm.client import DeepSeekClient

        client = DeepSeekClient.from_config(config) if config else DeepSeekClient()
        if not client.available:
            return None
        max_tokens = config.llm_max_tokens if config else 12000
        prompt = _build_llm_prompt(data_summary, lang=lang)
        response = client.complete(
            messages=[{"role": "user", "content": prompt}],
            tier="pro",
            max_tokens=max_tokens,
            json_mode=True,
        )
        return _parse_llm_response(response)
    except Exception as error:
        logger.warning("DeepSeek narrative generation failed: %s", error)
        return None


def _build_llm_prompt(data_summary: str, lang: str = "en") -> str:
    """Build prompt for LLM-powered narrative generation."""
    if lang == "zh":
        lang_instruction = (
            "【⚠️ 强制语言要求】所有叙述正文必须使用简体中文（Simplified Chinese）书写。"
            "严禁输出韩文、日文、繁体中文或其他任何语言。"
            "学术术语优先使用中文，英文专有名词（药品通用名、基因名等）可在中文后括号内保留英文原词。"
            "JSON的key保持英文，value全部为中文正文。违反此规则的输出视为无效。\n\n"
        )
        task_desc = (
            "生成以下13个叙述段落，内容必须超越数字描述，结合领域专业知识解读数据含义：\n\n"
            "每节采用双层结构：\n"
            "第一层—数据描述（1-2句）：陈述关键定量发现。\n"
            "第二层—分析洞察（2-4句）：解释规律成因、领域意义与实践含义。\n"
        )
        json_schema = (
            "{\n"
            '  "introduction": "2-3段，介绍研究主题背景及开展文献计量分析的必要性，引用Pritchard(1969)、Chen(2006)等方法论文献",\n'
            '  "discussion": "4-5段，综合多维度数据发现，结合领域知识解读意义，讨论证据缺口、方法局限与未来方向",\n'
            '  "conclusion": "1-2段，总结主要发现，向研究者和政策制定者提出具体建议",\n'
            '  "results_trends": "描述发文量轨迹，分析增长阶段拐点的驱动因素（药物获批、指南更新、标志性研究）",\n'
            '  "results_authors": "描述作者产出分布，分析集中/分散模式对领域成熟度和知识领袖涌现的意义",\n'
            '  "results_institutions": "描述机构产出排名，分析学术/产业/临床机构比例及转化研究管线",\n'
            '  "results_journals": "描述期刊分布，分析核心期刊谱揭示的学科定位和受众覆盖",\n'
            '  "results_countries": "描述地理分布，分析国家研究优先级的驱动因素，识别研究公平性差异",\n'
            '  "results_keyword_network": "描述网络指标，分析主题整合/碎片化结构，识别连接子领域的桥接关键词",\n'
            '  "results_clusters": "描述各聚类组成，分析每个聚类代表的研究方向及其相互关联",\n'
            '  "results_hotspots": "描述爆发词及强度，分析每次爆发可能的临床/科学触发事件，区分持续趋势与短暂峰值",\n'
            '  "results_frontiers": "描述前沿评分，分析顶级前沿主题的临床/科学意义及其重塑领域格局的潜力",\n'
            '  "results_citation": "描述引用指标，分析分布模式揭示的证据层级及哪类研究驱动领域影响力"\n'
            "}"
        )
        writing_guidelines = (
            "写作规范：\n"
            "- 学术风格，第三人称，流畅段落（正文不用项目符号）\n"
            "- 每个results_*节：4-8句（描述+洞察）\n"
            "- 总篇幅：约2500-3500字（中文字数）\n"
            "- 具体数据驱动，每个洞察须溯源至数据中的具体数字\n"
            "- 运用领域专业知识解释规律，而非仅描述现象\n"
            "- 仅输出JSON，不加Markdown代码围栏\n\n"
            "数据完整性规则（必须严格遵守）：\n"
            "- 若Modularity Q < 0.1：须说明聚类不可靠，禁用\"紧密交织\"或\"结构良好\"等美化表述\n"
            "- 若Modularity Q < 0.3：聚类结构描述须谨慎，避免夸大主题边界\n"
            "- 若出现[CROSS-CHECK WARNING]：严格按其指示执行\n"
            "- 若有[PARTIAL YEAR]或[NOTE]标注：禁止将该年份用于趋势对比\n"
            "- 禁止捏造数据中未出现的具体研究名称、作者发现或临床试验结果\n"
            "- discussion中对解释性判断须使用模糊限定语（可能、提示、表明、有待验证）\n"
            "【最终提醒】输出语言=简体中文。禁止韩文，禁止日文，禁止英文正文。"
        )
    else:
        lang_instruction = ""
        task_desc = (
            "YOUR TASK: Generate narrative sections that go beyond describing numbers. "
            "For each section, follow this two-layer structure:\n\n"
            "LAYER 1 — DATA DESCRIPTION (1-2 sentences): State the key quantitative findings.\n"
            "LAYER 2 — ANALYTICAL INSIGHT (2-4 sentences): Explain WHY these patterns exist, "
            "what they MEAN for the field, and what IMPLICATIONS they carry. Draw on your "
            "domain knowledge to contextualize the data.\n"
        )
        json_schema = """{
  "introduction": "2-3 paragraphs introducing the topic and justifying the bibliometric study. Cite Pritchard 1969, Chen 2006. Include domain-specific context.",
  "discussion": "4-5 substantive paragraphs synthesizing findings with domain knowledge. Reference specific data. Discuss evidence gaps and future directions.",
  "conclusion": "1-2 paragraphs with specific recommendations for researchers and policymakers.",
  "results_trends": "Publication trajectory + analysis of growth drivers (drug approvals, guideline changes, landmark trials).",
  "results_authors": "Productivity distribution + analysis of concentration pattern and field maturity.",
  "results_institutions": "Institutional rankings + analysis of academic vs industry mix and translational pipeline.",
  "results_journals": "Journal distribution + analysis of disciplinary identity and audience reach.",
  "results_countries": "Geographic distribution + analysis of national research drivers and equity gaps.",
  "results_keyword_network": "Network metrics + analysis of thematic integration vs fragmentation and bridging concepts.",
  "results_clusters": "Cluster composition + analysis of what each cluster represents as a research program.",
  "results_hotspots": "Burst terms + analysis of clinical/scientific triggers. Distinguish sustained trends from spikes.",
  "results_frontiers": "Frontier scores + analysis of clinical/scientific significance and field-reshaping potential.",
  "results_citation": "Citation metrics + analysis of evidence hierarchy and influence drivers."
}"""
        writing_guidelines = (
            "WRITING GUIDELINES:\n"
            "- Academic tone, third person, flowing prose (no bullet points in text)\n"
            "- Each results_* section: 4-8 sentences total (description + insight)\n"
            "- Total length: 2500-3500 words\n"
            "- Be specific and data-grounded — every insight should trace back to a number in the data\n"
            "- Use your domain knowledge to explain patterns, not just describe them\n"
            "- Return ONLY the JSON, no markdown fences\n\n"
            "DATA INTEGRITY RULES (must follow exactly):\n"
            "- If Modularity Q < 0.1: state clustering is unreliable, do NOT use 'tightly interwoven' or 'well-structured'\n"
            "- If Modularity Q < 0.3: describe community structure as 'weak' or 'modest'\n"
            "- If a [CROSS-CHECK WARNING] appears, follow its instructions exactly\n"
            "- If [PARTIAL YEAR] or [NOTE] about partial data appears, do NOT use that year for trend comparisons\n"
            "- Do NOT fabricate specific study names, author findings, or clinical trial results not present in the data\n"
            "- In 'discussion', use hedging language (may, could, suggests, warrants) for interpretive claims"
        )

    role_desc = (
        "你是资深生物医学研究员和文献计量学专家，正在用简体中文为同行评审期刊撰写分析论文。"
        "你对下方研究主题有深刻的领域认知，能够从专业视角解读数据规律。"
        "本任务的输出语言为简体中文，禁止使用韩文（한국어）或日文（日本語）。\n\n"
        if lang == "zh"
        else (
            "You are a senior biomedical researcher and bibliometrics expert writing an "
            "analysis paper for a peer-reviewed journal. You have deep domain knowledge "
            "in the research topic below and can draw on your understanding of the field "
            "to provide meaningful interpretation.\n\n"
        )
    )

    data_label = "数据摘要：\n" if lang == "zh" else "DATA SUMMARY:\n"
    sections_label = "请生成以下13个章节的JSON（所有正文用中文）：\n" if lang == "zh" else "Generate exactly these 13 sections in JSON format:\n"

    return (
        f"{role_desc}"
        f"{lang_instruction}"
        f"{data_label}{data_summary}\n\n"
        f"{task_desc}\n"
        f"{sections_label}{json_schema}\n\n"
        f"{writing_guidelines}"
    )


def _parse_llm_response(text: str) -> Optional[dict[str, str]]:
    """Parse LLM response into sections dict."""
    _REQUIRED = {"introduction", "discussion", "conclusion"}
    _ALL_KEYS = _REQUIRED | {
        "results_trends", "results_authors", "results_institutions",
        "results_journals", "results_countries", "results_keyword_network",
        "results_clusters", "results_hotspots", "results_frontiers",
        "results_citation",
    }

    try:
        # Strip markdown fences if present
        text = text.strip()
        if text.startswith("```"):
            parts = text.split("\n", 1)
            text = parts[1] if len(parts) > 1 else ""
        if text.endswith("```"):
            text = text.rsplit("```", 1)[0]
        text = text.strip()

        result = json.loads(text)
        if all(k in result for k in _REQUIRED):
            # Keep only recognized keys
            return {k: v for k, v in result.items() if k in _ALL_KEYS}
    except (json.JSONDecodeError, KeyError):
        pass

    # Try to extract sections from plain text
    sections = {}
    for section in sorted(_ALL_KEYS):
        start = text.lower().find(f'"{section}"')
        if start >= 0:
            val_start = text.find(":", start) + 1
            val_end = text.find('",', val_start)
            if val_end < 0:
                val_end = text.find('"}', val_start)
            if val_end > val_start:
                sections[section] = text[val_start:val_end].strip().strip('"')

    return sections if _REQUIRED.issubset(sections) else None


def _smart_template_narratives(
    query: str, articles: list[dict], stats: dict, networks: dict, lang: str = "en"
) -> dict[str, str]:
    """Generate intelligent template-based narratives from data patterns."""
    n = len(articles)
    years = sorted(set(str(a.get("year", "")) for a in articles if a.get("year")))
    year_range = f"{years[0]}–{years[-1]}" if years else "the study period"

    # Analyze data patterns for context
    kw_net = networks.get("keyword", {})
    n_clusters = len(kw_net.get("clusters", {}))
    quality = kw_net.get("quality", {})
    q_val = quality.get("modularity", 0)

    cluster_labels = stats.get("cluster_labels", {})
    cluster_names = [v.get("en_label", "") for v in cluster_labels.values()]

    country_df = stats.get("top_countries")
    top_country = ""
    if country_df is not None and not country_df.empty:
        top_country = country_df.iloc[0]["countries"]

    insights = stats.get("insights", [])
    maturity_insight = next(
        (i for i in insights if i.get("category") == "maturity"), None
    )
    stage = "emerging"
    if maturity_insight:
        stage = maturity_insight.get("evidence", {}).get("stage", "") or "emerging"

    kw_df = stats.get("top_keywords")
    top_keywords = []
    if kw_df is not None and not kw_df.empty:
        top_keywords = kw_df.head(5)["keywords_merged"].tolist()

    frontiers = stats.get("frontiers", {})
    frontier_df = frontiers.get("frontier_topics")
    frontier_topics = []
    if frontier_df is not None and hasattr(frontier_df, "empty") and not frontier_df.empty:
        frontier_topics = frontier_df.head(3)["topic"].tolist()

    cite_stats = stats.get("citation_stats", {})
    h_index = cite_stats.get("h_index", 0)

    # Build introduction
    intro = (
        f"The research landscape surrounding \"{query}\" has undergone significant "
        f"evolution in recent years, reflecting broader trends in biomedical science "
        f"and clinical practice. As the volume of published literature continues to "
        f"grow, bibliometric analysis offers a systematic, quantitative approach to "
        f"mapping the intellectual structure of a research field, identifying key "
        f"contributors, and detecting emerging trends (Pritchard, 1969; Chen, 2006).\n\n"
        f"Despite the increasing research output on this topic, no comprehensive "
        f"bibliometric analysis has been conducted to systematically characterize "
        f"the knowledge base, collaboration patterns, and thematic evolution. "
        f"Understanding these dimensions is essential for researchers seeking to "
        f"identify knowledge gaps, for funding agencies allocating resources, and "
        f"for clinicians staying abreast of evolving evidence.\n\n"
        f"This study aims to fill this gap by applying a multi-dimensional "
        f"bibliometric approach to {n} publications indexed in PubMed/MEDLINE "
        f"from {year_range}. Through co-occurrence network analysis, community "
        f"detection, burst detection, and frontier identification, we provide a "
        f"data-driven portrait of the field's current state and trajectory."
    )

    # Build discussion
    disc_parts = []

    # Paragraph 1: Overall landscape
    article = "an" if stage[0] in "aeiou" else "a"
    disc_parts.append(
        f"This bibliometric analysis of {n} publications reveals {article} {stage} "
        f"research field with {describe_trend(stats)} publication trajectory. "
        f"The geographic distribution of research output shows {top_country} as "
        f"the leading contributor, consistent with its dominant role in biomedical "
        f"research globally. The multi-national collaboration network suggests "
        f"growing international research interest in this area."
    )

    # Paragraph 2: Knowledge structure
    if n_clusters > 0 and cluster_names:
        cluster_desc = ", ".join(f'"{c}"' for c in cluster_names[:4])
        if q_val < 0.1:
            modularity_desc = "unreliable (Q < 0.1)"
            cluster_caveat = (
                "However, the extremely low modularity (Q = {:.4f}) indicates "
                "that these clusters lack statistical significance and should be "
                "interpreted with caution rather than as distinct research streams."
            ).format(q_val)
        elif q_val < 0.3:
            modularity_desc = "weak"
            cluster_caveat = (
                "The modest modularity (Q = {:.4f}) suggests that thematic "
                "boundaries between clusters are not sharply defined."
            ).format(q_val)
        else:
            modularity_desc = "well-defined"
            cluster_caveat = (
                "The betweenness centrality analysis highlights bridging terms "
                "that connect these clusters, potentially representing integrative "
                "research themes or underexplored connections between subfields."
            )
        disc_parts.append(
            f"Network analysis identified {n_clusters} research clusters "
            f"({cluster_desc}), with {modularity_desc} community structure "
            f"(Q = {q_val:.4f}). {cluster_caveat}"
        )

    # Paragraph 3: Hotspots and frontiers
    if top_keywords:
        kw_str = ", ".join(top_keywords[:5])
        disc_parts.append(
            f"The high-frequency keyword analysis identifies {kw_str} as the "
            f"dominant research foci. "
            + (
                f"Notably, the frontier analysis highlights "
                f"{', '.join(frontier_topics)} as emerging areas with "
                f"particularly strong recent growth, suggesting these may "
                f"represent the next wave of research emphasis."
                if frontier_topics
                else "Further investigation of emerging subtopics within these "
                f"broad themes would be valuable."
            )
        )

    # Paragraph 4: Implications
    if h_index > 0:
        impact_word = "substantial" if h_index > 20 else "growing"
        disc_parts.append(
            f"The estimated h-index of {h_index} for this body of literature "
            f"indicates a {impact_word} "
            f"citation impact. "
            f"These findings have several practical implications: researchers "
            f"entering this field should consider the identified knowledge gaps "
            f"and emerging frontiers; funding agencies can use the cluster analysis "
            f"to assess portfolio balance; and systematic reviewers can leverage "
            f"the thematic mapping to define review scope."
        )

    discussion = "\n\n".join(disc_parts)

    # Build conclusion
    frontier_sentence = ""
    if frontier_topics:
        frontier_sentence = (
            "The identification of " + ", ".join(frontier_topics)
            + " as research frontiers provides direction for future investigation. "
        )
    conclusion = (
        f"This bibliometric analysis provides a comprehensive mapping of "
        f"\"{query}\" research, spanning {n} publications from {year_range}. "
        f"The analysis reveals {describe_key_findings(stats, networks, stage)}. "
        f"{frontier_sentence}"
        f"As the field continues to evolve, periodic bibliometric reassessment "
        f"will be valuable for tracking progress and emerging directions.\n\n"
        f"Future studies should consider integrating citation data from multiple "
        f"databases (Scopus, Web of Science) and employing co-citation analysis "
        f"to further elucidate the intellectual structure of this field."
    )

    if lang == "zh":
        return _smart_template_narratives_zh(query, articles, stats, networks, stage, n, year_range,
                                             n_clusters, q_val, cluster_names, top_keywords,
                                             frontier_topics, h_index, top_country)

    return {
        "introduction": intro,
        "discussion": discussion,
        "conclusion": conclusion,
        "results_trends": template_results_trends(stats),
        "results_authors": template_results_authors(stats),
        "results_institutions": template_results_institutions(stats),
        "results_journals": template_results_journals(stats),
        "results_countries": template_results_countries(stats),
        "results_keyword_network": template_results_keyword_network(networks),
        "results_clusters": template_results_clusters(stats),
        "results_hotspots": template_results_hotspots(stats),
        "results_frontiers": template_results_frontiers(stats),
        "results_citation": template_results_citation(stats),
    }


def _smart_template_narratives_zh(
    query, articles, stats, networks, stage, n, year_range,
    n_clusters, q_val, cluster_names, top_keywords, frontier_topics, h_index, top_country
) -> dict[str, str]:
    """中文智能模板叙述（无 LLM 时兜底）。"""
    stage_zh = {"emerging": "新兴", "growing": "快速发展", "mature": "成熟", "stable": "稳定"}.get(stage, "发展中")
    kw_df = stats.get("top_keywords")
    burst_data = stats.get("bursts", {})
    burst_df = burst_data.get("burst_terms")
    frontiers = stats.get("frontiers", {})
    frontier_df = frontiers.get("frontier_topics")
    cite_stats = stats.get("citation_stats", {})

    intro = (
        f"围绕\"{query}\"的研究近年来持续增长，反映了生物医学领域的整体发展趋势。"
        f"文献计量分析作为一种系统化定量方法，能够全面揭示研究领域的知识结构、"
        f"核心贡献者及主题演化规律（Pritchard, 1969; Chen, 2006）。\n\n"
        f"尽管该主题的研究产出不断增加，目前仍缺乏系统性的文献计量学研究来梳理知识基础、"
        f"合作模式和主题演变脉络，制约了研究者对该领域全貌的把握。\n\n"
        f"本研究通过多维文献计量方法，对PubMed/MEDLINE数据库中{year_range}年间"
        f"收录的{n}篇文献进行系统分析，采用共现网络分析、社区检测、爆发词识别和前沿评分等"
        f"方法，从数据驱动视角描绘该领域的现状与发展轨迹。"
    )

    disc_parts = []
    disc_parts.append(
        f"本次文献计量分析共纳入{n}篇文献，研究领域整体处于{stage_zh}阶段。"
        f"从地理分布来看，{top_country}是发文量最高的国家，与其在全球生物医学研究中的"
        f"主导地位相符。多国合作网络的形成表明，该领域已吸引广泛的国际研究关注。"
    )

    if n_clusters > 0 and cluster_names:
        cluster_desc = "、".join(f'\"{c}\"' for c in cluster_names[:4])
        if q_val < 0.1:
            mod_desc = "不可靠（Q < 0.1）"
            caveat = f"然而，极低的模块度（Q = {q_val:.4f}）表明这些聚类缺乏统计显著性，须谨慎解读，不宜视为独立研究方向。"
        elif q_val < 0.3:
            mod_desc = "较弱"
            caveat = f"模块度（Q = {q_val:.4f}）较低，提示各聚类间的主题边界并不清晰。"
        else:
            mod_desc = "较为清晰"
            caveat = "中介中心性分析识别出连接各聚类的桥接关键词，可能代表具有整合潜力的跨领域研究方向。"
        disc_parts.append(
            f"网络分析识别出{n_clusters}个研究聚类（{cluster_desc}），"
            f"社区结构{mod_desc}（Q = {q_val:.4f}）。{caveat}"
        )

    if top_keywords:
        kw_str = "、".join(top_keywords[:5])
        if frontier_topics:
            frontier_str = "、".join(frontier_topics)
            disc_parts.append(
                f"高频关键词分析显示，{kw_str}是当前主要研究焦点。"
                f"前沿评分分析进一步表明，{frontier_str}等方向近年增长势头强劲，"
                f"可能代表该领域下一阶段的研究重点。"
            )
        else:
            disc_parts.append(f"高频关键词分析显示，{kw_str}是当前核心研究焦点，建议后续深入探索其中的新兴子主题。")

    if h_index > 0:
        impact_word = "显著" if h_index > 20 else "持续增长的"
        disc_parts.append(
            f"该领域文献的估算h指数为{h_index}，体现出{impact_word}的引用影响力。"
            f"上述发现具有多方面实践价值：进入该领域的研究者应重点关注已识别的知识缺口与前沿方向；"
            f"资助机构可借助聚类分析评估研究组合的均衡性；"
            f"系统综述团队可利用主题图谱合理界定综述范围。"
        )

    discussion = "\n\n".join(disc_parts)

    if frontier_topics:
        frontier_sentence = f"识别出{', '.join(frontier_topics)}等研究前沿，为后续研究方向提供了重要参考。"
    else:
        frontier_sentence = ""
    conclusion = (
        f"本次文献计量分析对\"{query}\"领域{year_range}年间的{n}篇文献进行了系统梳理，"
        f"揭示了该领域的核心贡献者、知识聚类结构和新兴研究趋势。"
        f"{frontier_sentence}"
        f"随着领域的持续演进，定期开展文献计量再评估对追踪研究进展具有重要意义。\n\n"
        f"未来研究可考虑整合Scopus、Web of Science等多数据库的引用数据，"
        f"并引入共被引分析以进一步厘清该领域的知识结构。"
    )

    # Results sections — Chinese template functions
    return {
        "introduction": intro,
        "discussion": discussion,
        "conclusion": conclusion,
        "results_trends": template_results_trends_zh(stats),
        "results_authors": template_results_authors_zh(stats),
        "results_institutions": template_results_institutions_zh(stats),
        "results_journals": template_results_journals_zh(stats),
        "results_countries": template_results_countries_zh(stats),
        "results_keyword_network": template_results_keyword_network_zh(networks),
        "results_clusters": template_results_clusters_zh(stats),
        "results_hotspots": template_results_hotspots_zh(stats),
        "results_frontiers": template_results_frontiers_zh(stats),
        "results_citation": template_results_citation_zh(stats),
    }
