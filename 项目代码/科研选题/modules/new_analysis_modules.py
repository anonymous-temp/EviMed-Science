"""
重组后的6大核心分析模块 V5.0
新增：图表支撑和论据支撑机制、安全JSON解析
"""
import asyncio
import json
import os
import re
import logging
import threading
from typing import Dict, Any, List, Optional
from datetime import datetime
from collections import Counter, defaultdict
import networkx as nx

# matplotlib 全局线程锁：并行模块执行时序列化图表创建，防止 plt 全局状态污染
_MATPLOTLIB_LOCK = threading.Lock()

from utils import safe_parse_json

logger = logging.getLogger(__name__)

# 尝试导入matplotlib
try:
    import matplotlib
    matplotlib.use('Agg')  # 非交互式后端
    import matplotlib.pyplot as plt
    import matplotlib.patches as mpatches
    import matplotlib.font_manager as fm
    import os as _os, subprocess as _sp

    # ── 工具函数：通过 fc-list 或固定路径查找 CJK 字体文件（绕过 matplotlib 缓存）
    def _find_cjk_font_file():
        # 1. fc-list 是 Linux 上最可靠的方式（直接查询 fontconfig 数据库）
        try:
            out = _sp.check_output(
                ['fc-list', ':lang=zh', '--format=%{file}\n'],
                stderr=_sp.DEVNULL, timeout=5
            ).decode('utf-8', errors='ignore')
            for raw in out.splitlines():
                path = raw.strip().split(':')[0].strip()
                if path and _os.path.exists(path):
                    return path
        except Exception:
            pass
        # 2. 硬编码 Ubuntu/Debian 常见路径（fonts-noto-cjk / wqy-microhei）
        for p in [
            '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
            '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
            '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
            '/usr/share/fonts/opentype/wqy/wqy-microhei.ttc',
            '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
            '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
            '/usr/share/fonts/wqy-microhei/wqy-microhei.ttc',
            '/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc',
        ]:
            if _os.path.exists(p):
                return p
        return None

    # ── 第一步：从 matplotlib 字体缓存按名称匹配（Windows 或已缓存的 Linux）
    _CN_FONT_CANDIDATES = [
        'Microsoft YaHei', 'SimHei', 'SimSun',           # Windows
        'WenQuanYi Micro Hei', 'WenQuanYi Zen Hei',      # Linux 文泉驿
        'Noto Sans CJK SC', 'Noto Sans SC', 'Noto CJK SC',  # Google Noto
        'Source Han Sans SC', 'Source Han Sans CN',        # Adobe 思源
        'AR PL UMing CN', 'AR PL UKai CN',                # Linux 文鼎
        'Droid Sans Fallback',                             # Android/Linux 兜底
    ]
    _available_fonts = {f.name for f in fm.fontManager.ttflist}
    _cn_font = next((f for f in _CN_FONT_CANDIDATES if f in _available_fonts), None)

    if _cn_font:
        matplotlib.rcParams['font.sans-serif'] = [_cn_font, 'DejaVu Sans']
        logger.info(f"matplotlib 中文字体(缓存): {_cn_font}")
    else:
        # ── 第二步：fc-list + 硬编码路径查找（解决 Ubuntu .ttc 文件不在缓存的问题）
        _cjk_path = _find_cjk_font_file()
        if _cjk_path:
            fm.fontManager.addfont(_cjk_path)
            _prop = fm.FontProperties(fname=_cjk_path)
            _font_name = _prop.get_name()
            matplotlib.rcParams['font.sans-serif'] = [_font_name, 'DejaVu Sans']
            logger.info(f"matplotlib 中文字体(fc-list/路径): {_cjk_path} [{_font_name}]")
        else:
            # ── 第三步：扫描全局字体目录（兜底）
            _cjk_font_paths = [
                p for p in fm.findSystemFonts(fontext='ttf')
                + fm.findSystemFonts(fontext='otf')
                if any(k in p.lower() for k in ['cjk', 'chinese', 'noto', 'wqy', 'simsun', 'simhei', 'yahei', 'gothic'])
            ]
            if _cjk_font_paths:
                fm.fontManager.addfont(_cjk_font_paths[0])
                _prop = fm.FontProperties(fname=_cjk_font_paths[0])
                matplotlib.rcParams['font.sans-serif'] = [_prop.get_name(), 'DejaVu Sans']
                logger.info(f"matplotlib 中文字体(扫描): {_cjk_font_paths[0]}")
            else:
                matplotlib.rcParams['font.sans-serif'] = ['DejaVu Sans']
                logger.warning("未找到中文字体，图表汉字将显示为方块。建议：apt install fonts-noto-cjk")

    matplotlib.rcParams['axes.unicode_minus'] = False  # 防止负号显示为方块
    MATPLOTLIB_AVAILABLE = True
except ImportError:
    MATPLOTLIB_AVAILABLE = False
    logger.warning("matplotlib not available, charts will not be generated")

from models.schemas import (
    ModuleOutput, LiteratureRecord, EvidenceStats,
    StandardizedInput, BreakthroughOpportunity,
    ChartInfo, SupportingEvidence
)
from services.llm_service import llm_service
from config.prompts import (
    M1_PROBLEM_LANDSCAPE_PROMPT,
    M2_RESEARCH_ECOSYSTEM_PROMPT,
    M3_EVIDENCE_SYSTEM_PROMPT,
    M4_SCIENTIFIC_CONTRADICTION_PROMPT,
    M5_BREAKTHROUGH_OPPORTUNITY_PROMPT,
    M6_RESEARCH_AGENDA_PROMPT
)


class BaseAnalysisModule:
    """分析模块基类 V5.0 - 增加图表生成和论据支撑"""

    MODULE_ID = ""
    MODULE_NAME = ""

    # 图表输出目录
    CHARTS_DIR = "/tmp/research_topic_charts"

    # 主题同义词映射表
    THEME_SYNONYMS = {
        'rituximab': ['rituximab', 'rituxan', '美罗华', '利妥昔单抗'],
        'nephrotic syndrome': ['nephrotic syndrome', 'ns', '肾病综合征'],
        'membranous nephropathy': ['membranous nephropathy', 'mn', '膜性肾病'],
        'minimal change disease': ['minimal change disease', 'mcd', '微小病变'],
        'fsgs': ['fsgs', 'focal segmental glomerulosclerosis', '局灶节段性肾小球硬化'],
        'lupus nephritis': ['lupus nephritis', 'ln', '狼疮性肾炎'],
        'iga nephropathy': ['iga nephropathy', 'igan', 'iga肾病'],
        'anca vasculitis': ['anca vasculitis', 'anca相关性血管炎'],
        'treatment': ['treatment', 'therapy', '治疗'],
        'efficacy': ['efficacy', 'effectiveness', '疗效'],
        'safety': ['safety', 'adverse effects', '安全性', '不良反应'],
        'remission': ['remission', '缓解'],
        'relapse': ['relapse', 'recurrence', '复发'],
        'b cells': ['b cells', 'b lymphocytes', 'b细胞'],
        'cd20': ['cd20', 'ms4a1'],
        'immunosuppression': ['immunosuppression', '免疫抑制'],
        'proteinuria': ['proteinuria', '蛋白尿'],
        'mechanism': ['mechanism', 'pathway', '机制', '通路'],
    }

    def __init__(self):
        # 确保图表目录存在
        if MATPLOTLIB_AVAILABLE:
            os.makedirs(self.CHARTS_DIR, exist_ok=True)

    async def execute(self, *args, **kwargs) -> ModuleOutput:
        raise NotImplementedError

    async def _llm_analyze(
        self,
        prompt: str,
        stream_callback=None,
        *,
        max_tokens: int = 4000,
        temperature: float = 0.2,
    ) -> str:
        """统一 LLM 调用入口：有 callback 时流式提取 deep_analysis 字段，否则普通调用。"""
        if stream_callback is not None:
            return await llm_service.complete_streaming_extract(
                prompt,
                stream_callback,
                extract_field="deep_analysis",
                max_tokens=max_tokens,
                temperature=temperature,
            )
        return await llm_service.complete(
            prompt, json_mode=True, max_tokens=max_tokens, temperature=temperature
        )

    async def _create_chart_safe(self, chart_func, *args, **kwargs):
        """线程安全的图表创建：持锁执行整个 chart_func（含 plt.subplots + savefig）"""
        def _locked():
            with _MATPLOTLIB_LOCK:
                return chart_func(*args, **kwargs)
        return await asyncio.to_thread(_locked)

    # ==================== V5.0: 图表生成框架 ====================

    def _generate_chart(
        self,
        figure: Any,
        module_id: str,
        chart_name: str,
        chart_type: str = "line"
    ) -> Optional[str]:
        """
        通用图表生成和保存方法

        Args:
            figure: matplotlib figure对象
            module_id: 模块ID
            chart_name: 图表名称
            chart_type: 图表类型

        Returns:
            图表文件路径
        """
        if not MATPLOTLIB_AVAILABLE:
            return None

        try:
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            filename = f"{module_id}_{chart_name}_{timestamp}.png"
            filepath = os.path.join(self.CHARTS_DIR, filename)

            figure.savefig(filepath, dpi=96, bbox_inches='tight',
                         facecolor='white', edgecolor='none')
            plt.close(figure)

            return filepath
        except Exception as e:
            logger.warning(f"图表生成失败: {e}")
            return None

    def _create_chart_info(
        self,
        title: str,
        path: Optional[str],
        chart_type: str,
        description: str = ""
    ) -> Optional[ChartInfo]:
        """创建图表信息对象"""
        if not path:
            return None

        return ChartInfo(
            title=title,
            path=path,
            chart_type=chart_type,
            description=description
        )

    # ==================== V5.0: 论据支撑机制 ====================

    def find_supporting_evidence(
        self,
        conclusion: str,
        keywords: List[str],
        evidence_records: List[LiteratureRecord],
        max_results: int = 5
    ) -> List[SupportingEvidence]:
        """
        为结论查找支撑文献

        Args:
            conclusion: 结论/关键词
            keywords: 相关关键词列表
            evidence_records: 文献集
            max_results: 最大返回数量

        Returns:
            支撑文献列表
        """
        # 计算每篇文献的相关性得分
        scored_records = []
        conclusion_lower = conclusion.lower()
        keyword_set = set(k.lower() for k in keywords)

        for record in evidence_records:
            score = 0.0

            # 标题匹配
            if record.title and conclusion_lower in record.title.lower():
                score += 3.0

            # 摘要匹配
            if record.abstract:
                abstract_lower = record.abstract.lower()
                if conclusion_lower in abstract_lower:
                    score += 2.0
                # 关键词匹配
                for kw in keyword_set:
                    if kw in abstract_lower:
                        score += 0.5

            # MeSH术语匹配
            for mesh in record.mesh_terms:
                if any(kw in mesh.lower() for kw in keyword_set):
                    score += 1.0

            # 关键词匹配
            for kw in record.keywords:
                if any(k in kw.lower() for k in keyword_set):
                    score += 0.5

            # 临床研究加分
            if record.is_clinical:
                score += 0.5

            # 发表年份加分（近5年）
            if record.publication_year and record.publication_year >= datetime.now().year - 5:
                score += 0.3

            if score > 0:
                scored_records.append((record, score))

        # 按得分排序
        scored_records.sort(key=lambda x: x[1], reverse=True)

        # 构建结果
        results = []
        for record, score in scored_records[:max_results]:
            # 提取相关摘录
            excerpt = self._extract_relevant_excerpt(
                record.abstract, keywords
            ) if record.abstract else ""

            evidence = SupportingEvidence(
                pmid=record.pmid or "",
                title=record.title,
                authors=record.authors[:3],  # 前3作者
                year=record.publication_year,
                journal=record.journal or "",
                doi=record.doi,
                relevance_score=round(score, 2),
                excerpt=excerpt[:300] if excerpt else ""
            )
            results.append(evidence)

        return results

    def _extract_relevant_excerpt(
        self,
        abstract: str,
        keywords: List[str],
        context_chars: int = 100
    ) -> str:
        """从摘要中提取包含关键词的相关摘录"""
        abstract_lower = abstract.lower()

        for kw in keywords:
            kw_lower = kw.lower()
            if kw_lower in abstract_lower:
                idx = abstract_lower.find(kw_lower)
                start = max(0, idx - context_chars)
                end = min(len(abstract), idx + len(kw) + context_chars)
                excerpt = abstract[start:end]
                if start > 0:
                    excerpt = "..." + excerpt
                if end < len(abstract):
                    excerpt = excerpt + "..."
                return excerpt

        # 如果没有关键词匹配，返回前200字符
        return abstract[:200] + "..." if len(abstract) > 200 else abstract

    # ==================== 通用辅助方法 ====================

    def _canonicalize_themes(self, keywords: List[str], max_themes: int = 10) -> Dict[str, List[str]]:
        """主题归一化"""
        normalized_keywords = []
        for kw in keywords:
            if kw:
                normalized = kw.lower().strip().rstrip('s')
                normalized_keywords.append((kw, normalized))

        canonical_map = defaultdict(list)
        for original_kw, normalized_kw in normalized_keywords:
            found_canonical = None
            for canonical, synonyms in self.THEME_SYNONYMS.items():
                if normalized_kw in [s.lower().strip() for s in synonyms]:
                    found_canonical = canonical
                    break
            if not found_canonical:
                found_canonical = normalized_kw
            canonical_map[found_canonical].append(original_kw)

        sorted_canonical = sorted(canonical_map.items(), key=lambda x: len(x[1]), reverse=True)[:max_themes]
        return {k: v for k, v in sorted_canonical}

    def _extract_evidence_themes(self, records: List[LiteratureRecord]) -> List[str]:
        """提取统一主题集合"""
        all_themes = []
        for r in records:
            all_themes.extend(r.keywords)
            all_themes.extend(r.mesh_terms)
        return all_themes


class M1_ProblemLandscapeModule(BaseAnalysisModule):
    """
    M1: 科研问题全景分析 V5.0
    新增：发文量年度趋势图
    """

    MODULE_ID = "M1_PROBLEM_LANDSCAPE"
    MODULE_NAME = "科研问题全景分析"

    async def execute(
        self,
        standardized_input: StandardizedInput,
        evidence_records: List[LiteratureRecord],
        evidence_stats: EvidenceStats,
        dependencies: Dict[str, ModuleOutput] = None,
        stream_callback=None,
    ) -> ModuleOutput:

        query_terms = standardized_input.query_terms.zh + standardized_input.query_terms.en
        query_context = ", ".join(query_terms[:3]) if query_terms else "该研究领域"

        # 1. 领域趋势分析
        years = [r.publication_year for r in evidence_records if r.publication_year]
        year_counts = Counter(years)
        sorted_years = sorted(year_counts.keys())

        # 2. 主题演化分析
        all_themes = self._extract_evidence_themes(evidence_records)
        canonical_themes = self._canonicalize_themes(all_themes, max_themes=10)

        # 3. 生成趋势图 V5.0
        charts = []
        total_evidence = len(evidence_records)
        trend_chart = await self._create_chart_safe(
            self._create_publication_trend_chart, sorted_years, year_counts, total_evidence
        )
        if trend_chart:
            charts.append(trend_chart)

        # 4. 模块内LLM深度分析
        analysis_result = await self._generate_problem_landscape_analysis(
            sorted_years, year_counts, canonical_themes, evidence_stats, query_context,
            stream_callback=stream_callback,
        )

        # 5. 查找支撑论据 V5.0
        key_insights = analysis_result.get("core_problems", [])
        supporting_evidence = []
        if key_insights:
            for insight in key_insights[:3]:
                evidence = self.find_supporting_evidence(
                    insight.get("description", ""),
                    list(canonical_themes.keys())[:5],
                    evidence_records,
                    max_results=3
                )
                supporting_evidence.extend(evidence)

        return ModuleOutput(
            module_id=self.MODULE_ID,
            status="success",
            data={
                "publication_trend": {
                    "years": sorted_years,
                    "counts": [year_counts[y] for y in sorted_years]
                },
                "domain_stage": analysis_result.get("domain_stage", "未知"),
                "core_scientific_problems": analysis_result.get("core_problems", []),
                "problem_evolution": analysis_result.get("problem_evolution", {}),
                "research_focus_migration": analysis_result.get("focus_migration", ""),
                "scientific_tensions": analysis_result.get("scientific_tensions", []),
                "llm_deep_analysis": analysis_result.get("deep_analysis", ""),
                "action_paths": analysis_result.get("action_paths", [])
            },
            charts=charts,
            supporting_evidence=supporting_evidence,
            key_insights=[p.get("description", "") for p in analysis_result.get("core_problems", [])]
        )

    def _create_publication_trend_chart(
        self,
        years: List[int],
        year_counts: Counter,
        total_evidence: int = 0
    ) -> Optional[ChartInfo]:
        """V5.0: 创建发文量年度趋势图。
        从近5年开始，去除前导（最早的）连续零数据年份，最少保留3年。
        """
        if not MATPLOTLIB_AVAILABLE or not years:
            return None
        # 至少需要 2 年有非零数据，否则趋势线毫无意义
        non_zero_years = [y for y in years if year_counts.get(y, 0) > 0]
        if len(non_zero_years) < 2:
            return None

        try:
            from datetime import datetime as _dt
            current_year = _dt.now().year
            # 候选范围：近5年
            candidate_years = list(range(current_year - 4, current_year + 1))
            candidate_counts = [year_counts.get(y, 0) for y in candidate_years]

            # 从最早年份起，去除连续为0的前导年份，最少保留3年
            start_idx = 0
            while start_idx < len(candidate_years) - 3 and candidate_counts[start_idx] == 0:
                start_idx += 1

            full_years = candidate_years[start_idx:]
            counts = candidate_counts[start_idx:]

            start_year = full_years[0]
            span = len(full_years)

            fig, ax = plt.subplots(figsize=(10, 6))
            ax.plot(full_years, counts, marker='o', linewidth=2, markersize=6, color='#2E86AB')
            ax.fill_between(full_years, counts, alpha=0.3, color='#2E86AB')

            # 强制 X 轴为整数年份刻度
            ax.set_xticks(full_years)
            ax.set_xticklabels([str(y) for y in full_years], fontsize=10)

            ax.set_xlabel('年份', fontsize=12)
            ax.set_ylabel('文献数量', fontsize=12)
            ax.grid(True, alpha=0.3)

            # 每个年份标注数值，当前年份加注说明
            import datetime as _dt
            _cur_year = _dt.datetime.now().year
            _cur_month = _dt.datetime.now().month
            for year, count in zip(full_years, counts):
                label = str(count)
                if year == _cur_year:
                    label = f"{count}*"
                ax.annotate(label, xy=(year, count),
                            textcoords="offset points", xytext=(0, 10),
                            ha='center', fontsize=9)
            # 当前年份数据不完整说明
            ax.text(0.99, 0.01, f"*{_cur_year}年数据截至{_cur_month}月，不代表全年",
                    transform=ax.transAxes, ha='right', va='bottom', fontsize=8,
                    color='gray', style='italic')

            plt.tight_layout()
            path = self._generate_chart(fig, self.MODULE_ID, "publication_trend", "line")
            with_year = sum(year_counts.values())
            total_desc = f"本次筛选共 {total_evidence} 篇" if total_evidence else f"共 {with_year} 篇"
            year_note = f"，其中 {with_year} 篇具有有效发表年份" if total_evidence and total_evidence != with_year else ""
            return self._create_chart_info(
                "发文量年度趋势图", path, "line",
                f"展示该领域{start_year}—{current_year}年研究热度历史变化趋势（{total_desc}{year_note}，检索近5年，仅展示有效数据年份，不代表该领域全部发文量）"
            )
        except Exception as e:
            logger.warning(f"趋势图生成失败: {e}")
            return None

    async def _generate_problem_landscape_analysis(self, years, year_counts, canonical_themes, evidence_stats, query_context, stream_callback=None) -> Dict:
        """生成问题全景深度分析"""
        logger.info(f"[M1] 开始生成问题全景分析")

        theme_list = list(canonical_themes.keys())[:8]
        trend_data = {y: year_counts[y] for y in years}

        prompt = M1_PROBLEM_LANDSCAPE_PROMPT.format(
            query_context=query_context,
            min_year=min(years) if years else 'N/A',
            max_year=max(years) if years else 'N/A',
            trend_data=trend_data,
            theme_list=theme_list,
            design_distribution=evidence_stats.design_distribution
        )

        logger.info(f"[M1] 准备调用LLM...")
        try:
            response = await self._llm_analyze(prompt, stream_callback, max_tokens=4000, temperature=0.2)
            logger.info(f"[M1] LLM调用成功")
            return safe_parse_json(response)
        except Exception as e:
            logger.error(f"[M1] 分析失败: {e}")
            return {
                "domain_stage": "分析失败",
                "core_problems": [],
                "deep_analysis": "分析生成失败，使用默认输出。"
            }


class M2_ResearchEcosystemModule(BaseAnalysisModule):
    """
    M2: 研究生态结构分析 V5.0
    图表：研究热点分布（治疗/诊断/病理机制等），关键词共现网络图
    作者/期刊统计保留在 data 中供文献计量学模块使用
    """

    MODULE_ID = "M2_RESEARCH_ECOSYSTEM"
    MODULE_NAME = "研究生态结构分析"

    # 研究热点分类关键词映射
    _HOTSPOT_CATEGORIES = {
        "治疗/干预":    ["treatment", "therapy", "therapeutic", "drug", "medication",
                        "intervention", "regimen", "antibiotic", "inhibitor", "surgery",
                        "management", "clinical trial", "randomized", "efficacy", "dose",
                        "pharmacological", "surgical", "procedure", "protocol", "regimen",
                        "acupuncture", "exercise", "rehabilitation", "analgesic", "pain relief"],
        "诊断/检测":    ["diagnosis", "diagnostic", "detection", "biomarker", "test",
                        "screening", "imaging", "assay", "sensitivity", "specificity",
                        "ultrasound", "mri", "ct scan", "biopsy", "laboratory", "marker",
                        "classification", "criteria", "score", "questionnaire", "assessment"],
        "病理机制":     ["mechanism", "pathogenesis", "pathway", "signaling", "expression",
                        "pathophysiology", "molecular", "inflammation", "immune", "receptor",
                        "gene", "protein", "cytokine", "oxidative", "fibrosis", "apoptosis",
                        "prostaglandin", "endometrium", "hormonal", "neurological", "central"],
        "流行病学":     ["epidemiology", "prevalence", "incidence", "risk factor",
                        "cohort", "population", "surveillance", "mortality", "morbidity",
                        "cross-sectional", "survey", "demographic", "burden", "distribution",
                        "adolescent", "women", "female", "age", "primary", "secondary"],
        "预防/疫苗":    ["prevention", "vaccine", "prophylaxis", "protective",
                        "vaccination", "immunization", "risk reduction", "lifestyle",
                        "dietary", "physical activity", "behavioral", "education"],
        "预后/结局":    ["prognosis", "outcome", "survival", "recurrence", "complication",
                        "mortality", "follow-up", "long-term", "quality of life", "disability",
                        "functional", "symptom", "relief", "remission", "response"],
        "基础研究":     ["in vitro", "in vivo", "animal model", "mouse", "rat", "cell line",
                        "culture", "experiment", "laboratory", "preclinical", "model",
                        "study", "analysis", "investigation", "research", "effect"],
    }

    async def execute(
        self,
        standardized_input: StandardizedInput,
        evidence_records: List[LiteratureRecord],
        evidence_stats: EvidenceStats,
        dependencies: Dict[str, ModuleOutput] = None,
        stream_callback=None,
    ) -> ModuleOutput:

        query_terms = standardized_input.query_terms.zh + standardized_input.query_terms.en
        query_context = ", ".join(query_terms[:3]) if query_terms else "该研究领域"

        # 1. 作者统计（保留在 data，不再出图）
        author_counts = Counter()
        for r in evidence_records:
            for author in r.authors:
                author_counts[author] += 1

        # 2. 期刊统计（保留在 data，不再出图）
        journal_counts = Counter(r.journal for r in evidence_records if r.journal)

        # 3. 关键词共现网络
        keyword_network = self._build_keyword_network(evidence_records)

        # 4. 研究热点分类统计
        hotspot_counts, other_keywords = self._classify_research_hotspots(evidence_records)
        total_evidence = len(evidence_records)

        # 5. 生成图表：研究热点分布
        charts = []
        hotspot_chart = await self._create_chart_safe(self._create_research_hotspots_chart, hotspot_counts, total_evidence, other_keywords)
        if hotspot_chart:
            charts.append(hotspot_chart)

        # 6. 模块内LLM深度分析
        ecosystem_analysis = await self._generate_ecosystem_analysis(
            author_counts, journal_counts, keyword_network, evidence_stats,
            query_context, hotspot_counts,
            stream_callback=stream_callback,
        )

        return ModuleOutput(
            module_id=self.MODULE_ID,
            status="success",
            data={
                "core_authors": [{"name": n, "count": c} for n, c in author_counts.most_common(10)],
                "core_journals": [{"name": n, "count": c} for n, c in journal_counts.most_common(10)],
                "keyword_network": keyword_network,
                "hotspot_distribution": dict(hotspot_counts),
                "network_density": ecosystem_analysis.get("network_density", 0),
                "fragmentation_index": ecosystem_analysis.get("fragmentation_index", 0),
                "research_structure_type": ecosystem_analysis.get("research_structure_type", ""),
                "structure_impact": ecosystem_analysis.get("structure_impact", {}),
                "dominance_analysis": ecosystem_analysis.get("dominance", {}),
                "journal_level": ecosystem_analysis.get("journal_level", ""),
                "knowledge_network": ecosystem_analysis.get("knowledge_network", {}),
                "ecological_bottlenecks": ecosystem_analysis.get("ecological_bottlenecks", []),
                "llm_deep_analysis": ecosystem_analysis.get("deep_analysis", ""),
                "strategic_implications": ecosystem_analysis.get("implications", [])
            },
            charts=charts
        )

    def _create_author_chart(self, author_counts: Counter) -> Optional[ChartInfo]:
        """V5.0: 创建核心作者发文量图"""
        if not MATPLOTLIB_AVAILABLE or not author_counts:
            return None

        try:
            top_authors = author_counts.most_common(10)
            names = [a[0][:20] for a in top_authors]  # 截断长名
            counts = [a[1] for a in top_authors]

            fig, ax = plt.subplots(figsize=(10, 6))
            y_pos = range(len(names))
            ax.barh(y_pos, counts, color='#A23B72')
            ax.set_yticks(y_pos)
            ax.set_yticklabels(names)
            ax.invert_yaxis()
            ax.set_xlabel('文献数量', fontsize=12)
            ax.set_title('核心作者 Top10', fontsize=14, fontweight='bold')

            # 添加数值标签
            for i, v in enumerate(counts):
                ax.text(v + 0.1, i, str(v), va='center', fontsize=9)

            path = self._generate_chart(fig, self.MODULE_ID, "core_authors", "bar")
            return self._create_chart_info(
                "核心作者发文量图", path, "bar",
                "展示该领域发文量最多的Top 10作者"
            )
        except Exception as e:
            logger.warning(f"作者图生成失败: {e}")
            return None

    def _create_journal_chart(self, journal_counts: Counter) -> Optional[ChartInfo]:
        """V5.0: 创建核心期刊发文量图"""
        if not MATPLOTLIB_AVAILABLE or not journal_counts:
            return None

        try:
            top_journals = journal_counts.most_common(10)
            names = [j[0][:25] for j in top_journals]
            counts = [j[1] for j in top_journals]

            fig, ax = plt.subplots(figsize=(10, 6))
            y_pos = range(len(names))
            ax.barh(y_pos, counts, color='#F18F01')
            ax.set_yticks(y_pos)
            ax.set_yticklabels(names, fontsize=9)
            ax.invert_yaxis()
            ax.set_xlabel('文献数量', fontsize=12)
            ax.set_title('核心期刊 Top10', fontsize=14, fontweight='bold')

            path = self._generate_chart(fig, self.MODULE_ID, "core_journals", "bar")
            return self._create_chart_info(
                "核心期刊发文量图", path, "bar",
                "展示该领域发文量最多的Top 10期刊"
            )
        except Exception as e:
            logger.warning(f"期刊图生成失败: {e}")
            return None

    def _classify_research_hotspots(self, records: List[LiteratureRecord]):
        """按研究方向（治疗/诊断/病理机制等）统计论文分布，同时收集"其他"类的高频关键词"""
        counts: Counter = Counter()
        other_word_counts: Counter = Counter()
        for r in records:
            text = (
                (r.title or "") + " " +
                " ".join(r.keywords or []) + " " +
                " ".join(r.mesh_terms or [])
            ).lower()
            matched = False
            for category, kws in self._HOTSPOT_CATEGORIES.items():
                if any(kw in text for kw in kws):
                    counts[category] += 1
                    matched = True
            if not matched:
                counts["其他"] += 1
                # 收集"其他"类文献的高频词（过滤停用词和过短词）
                _stopwords = {"the", "and", "for", "with", "from", "this", "that",
                              "are", "was", "were", "has", "have", "been", "not",
                              "its", "our", "their", "also", "may", "can", "but"}
                words = [w.strip("(),.:;") for w in text.split()
                         if len(w) > 4 and w not in _stopwords]
                other_word_counts.update(words)

        # 医学专业名词特征：常见医学后缀/前缀，用于判断是否为专业术语
        _medical_suffixes = (
            "itis", "osis", "emia", "uria", "pathy", "plasty", "ectomy",
            "otomy", "oscopy", "graphy", "therapy", "toxin", "kinase",
            "receptor", "inhibitor", "antibody", "antigen", "peptide",
            "protein", "enzyme", "cytokine", "syndrome", "disorder",
            "carcinoma", "lymphoma", "sarcoma", "adenoma", "fibroma",
            "sclerosis", "stenosis", "necrosis", "fibrosis", "atrophy",
            "hypertrophy", "dysplasia", "metastasis", "angiogenesis",
        )
        _medical_prefixes = (
            "cardio", "neuro", "hepato", "nephro", "pulmo", "gastro",
            "onco", "immuno", "hemato", "endo", "myelo", "osteo",
            "arthro", "dermato", "ophthalmo", "rheumat",
        )
        # 非医学通用词黑名单（即使长度>4也排除）
        _generic_blacklist = {
            "study", "studies", "report", "reports", "review", "reviews",
            "analysis", "results", "method", "methods", "effect", "effects",
            "level", "levels", "group", "groups", "model", "models",
            "based", "using", "among", "after", "before", "during",
            "between", "within", "compared", "associated", "related",
            "increased", "decreased", "higher", "lower", "significant",
            "patients", "subjects", "controls", "follow", "years",
            "months", "weeks", "acute", "chronic", "severe", "mild",
            "primary", "secondary", "clinical", "medical", "health",
            "disease", "factor", "factors", "index", "score", "rate",
        }

        def _is_medical_term(word: str) -> bool:
            w = word.lower()
            if w in _generic_blacklist:
                return False
            if any(w.endswith(s) for s in _medical_suffixes):
                return True
            if any(w.startswith(p) for p in _medical_prefixes):
                return True
            return False

        # 取"其他"类高频词，只保留医学专业名词，过滤掉已在分类关键词中出现的词
        all_category_kws = {kw for kws in self._HOTSPOT_CATEGORIES.values() for kw in kws}
        other_top = [w for w, _ in other_word_counts.most_common(30)
                     if w not in all_category_kws and _is_medical_term(w)][:5]

        return counts, other_top

    def _create_research_hotspots_chart(self, hotspot_counts: Counter, total_evidence: int = 0, other_keywords: list = None) -> Optional[ChartInfo]:
        """创建研究热点分布横条图"""
        if not MATPLOTLIB_AVAILABLE or not hotspot_counts:
            return None
        active_categories = [v for v in hotspot_counts.values() if v > 0]
        if sum(active_categories) < 2 or len(active_categories) < 1:
            return None
        try:
            items = hotspot_counts.most_common()
            # "其他"类直接显示"其他"，不展示代表词
            labels = [item[0] for item in items]
            values = [item[1] for item in items]

            fig, ax = plt.subplots(figsize=(10, max(4, len(labels) * 0.6)))
            colors = ['#2E86AB', '#A23B72', '#F18F01', '#C73E1D',
                      '#3B1F2B', '#44BBA4', '#E94F37', '#393E41']
            bar_colors = [colors[i % len(colors)] for i in range(len(labels))]
            y_pos = range(len(labels))
            ax.barh(y_pos, values, color=bar_colors)
            ax.set_yticks(y_pos)
            ax.set_yticklabels(labels, fontsize=11)
            ax.invert_yaxis()
            ax.set_xlabel('文献数量', fontsize=12)
            for i, v in enumerate(values):
                ax.text(v + 0.3, i, str(v), va='center', fontsize=10)

            path = self._generate_chart(fig, self.MODULE_ID, "research_hotspots", "bar")
            total_classified = sum(hotspot_counts.values())
            if total_evidence > 0 and total_classified > total_evidence:
                desc = (
                    f"基于本次筛选的 {total_evidence} 篇文献，按研究方向（治疗/诊断/病理机制等）进行多标签分类统计。"
                    f"由于同一篇文献可同时归入多个研究方向，各方向数量之和（{total_classified}）大于文献总数，属正常现象。"
                )
            else:
                desc = (
                    f"展示该领域各研究方向的文献分布（基于本次筛选的 {total_evidence or total_classified} 篇文献多标签分类统计，"
                    f"不代表该领域全部发文量）"
                )
            return self._create_chart_info("研究热点分布图", path, "bar", desc)
        except Exception as e:
            logger.warning(f"研究热点图生成失败: {e}")
            return None

    def _build_keyword_network(self, records: List[LiteratureRecord]) -> Dict:
        """构建关键词共现网络"""
        G = nx.Graph()

        for r in records:
            keywords = [k.lower().strip() for k in r.keywords[:8] if k]
            for i, kw1 in enumerate(keywords):
                for kw2 in keywords[i+1:]:
                    if G.has_edge(kw1, kw2):
                        G[kw1][kw2]['weight'] += 1
                    else:
                        G.add_edge(kw1, kw2, weight=1)

        density = nx.density(G) if len(G.nodes()) > 1 else 0

        communities = []
        try:
            from networkx.algorithms import community
            if len(G.nodes()) > 3:
                comms = community.greedy_modularity_communities(G)
                communities = [list(c) for c in comms[:5]]
        except Exception as e:
            logger.debug(f"社区检测失败: {e}")
            pass

        centrality = {}
        if len(G.nodes()) > 0:
            try:
                centrality = dict(sorted(nx.degree_centrality(G).items(),
                                       key=lambda x: x[1], reverse=True)[:10])
            except Exception as e:
                logger.debug(f"中心性计算失败: {e}")
                pass

        return {
            "nodes": [{"id": n, "label": n} for n in G.nodes()],
            "edges": [{"source": u, "target": v, "weight": d['weight']}
                     for u, v, d in G.edges(data=True)],
            "density": round(density, 3),
            "communities": communities,
            "centrality": centrality
        }

    async def _generate_ecosystem_analysis(self, author_counts, journal_counts, keyword_network, evidence_stats, query_context, hotspot_counts=None, stream_callback=None) -> Dict:
        """生成生态结构深度分析"""
        logger.info(f"[M2] 开始生成生态结构分析")

        top_authors = author_counts.most_common(10)
        top_journals = journal_counts.most_common(10)
        hotspot_str = dict(hotspot_counts.most_common()) if hotspot_counts else {}

        prompt = M2_RESEARCH_ECOSYSTEM_PROMPT.format(
            query_context=query_context,
            evidence_count=evidence_stats.evidence_count,
            top_authors=[(n, c) for n, c in top_authors],
            top_journals=[(n, c) for n, c in top_journals],
            network_density=keyword_network.get('density', 0),
            community_count=len(keyword_network.get('communities', [])),
            hotspot_distribution=hotspot_str
        )

        logger.info(f"[M2] 准备调用LLM...")
        try:
            response = await self._llm_analyze(prompt, stream_callback, max_tokens=3000, temperature=0.2)
            logger.info(f"[M2] LLM调用成功")
            return safe_parse_json(response)
        except Exception as e:
            logger.error(f"[M2] 分析失败: {e}")
            return {
                "network_density": keyword_network.get('density', 0),
                "fragmentation_index": 0.5,
                "research_structure_type": "分析失败",
                "deep_analysis": "生态分析生成失败。"
            }


class M3_EvidenceSystemModule(BaseAnalysisModule):
    """
    M3: 证据体系结构诊断 V5.0
    新增：证据金字塔图，证据链路完整度图
    """

    MODULE_ID = "M3_EVIDENCE_SYSTEM"
    MODULE_NAME = "证据体系结构诊断"

    async def execute(
        self,
        standardized_input: StandardizedInput,
        evidence_records: List[LiteratureRecord],
        evidence_stats: EvidenceStats,
        dependencies: Dict[str, ModuleOutput] = None,
        stream_callback=None,
    ) -> ModuleOutput:

        query_terms = standardized_input.query_terms.zh + standardized_input.query_terms.en
        query_context = ", ".join(query_terms[:3]) if query_terms else "该研究领域"

        # 1. 研究设计分布
        pyramid = evidence_stats.design_distribution

        # 2. 构建证据链路
        evidence_chain = self._build_evidence_chain(evidence_records, pyramid)

        # 3. 主题-设计矩阵
        all_themes = self._extract_evidence_themes(evidence_records)
        canonical_themes = self._canonicalize_themes(all_themes, max_themes=8)

        designs = list(pyramid.keys())[:6]
        topics = list(canonical_themes.keys())[:6]
        matrix = self._build_evidence_matrix(topics, designs, evidence_records, canonical_themes)

        # 4. 生成图表 V5.0
        charts = []

        pyramid_chart = await self._create_chart_safe(self._create_evidence_pyramid_chart, pyramid)
        if pyramid_chart:
            charts.append(pyramid_chart)

        chain_chart = await self._create_chart_safe(
            self._create_evidence_chain_chart, evidence_chain, sum(pyramid.values())
        )
        if chain_chart:
            charts.append(chain_chart)

        # 5. 模块内LLM深度分析
        system_analysis = await self._generate_evidence_system_analysis(
            pyramid, evidence_chain, matrix, evidence_stats, query_context,
            stream_callback=stream_callback,
        )

        return ModuleOutput(
            module_id=self.MODULE_ID,
            status="success",
            data={
                "evidence_pyramid": pyramid,
                "evidence_chain": evidence_chain,
                "topic_design_matrix": {
                    "topics": topics,
                    "designs": designs,
                    "matrix": matrix
                },
                "chain_completeness": system_analysis.get("completeness", 0),
                "fracture_types": system_analysis.get("fracture_types", []),
                "bridge_gaps": system_analysis.get("bridge_gaps", []),
                "cross_domain_signals": system_analysis.get("cross_domain_signals", []),
                "mechanism_clinical_balance": system_analysis.get("balance", ""),
                "weak_links": system_analysis.get("weak_links", []),
                "llm_deep_analysis": system_analysis.get("deep_analysis", ""),
                "strengthening_paths": system_analysis.get("paths", [])
            },
            charts=charts
        )

    def _create_evidence_pyramid_chart(self, pyramid: Dict[str, int]) -> Optional[ChartInfo]:
        """V5.0: 创建证据层级分布图（水平条形图，按证据等级从高到低排序，标注数值）"""
        if not MATPLOTLIB_AVAILABLE or not pyramid:
            return None

        # 规范化：将原始 PubMed PublicationType 合并到标准证据层级
        _RAW_TO_STANDARD = {
            'meta-analysis': 'Meta-analysis',
            'systematic review': 'Systematic Review',
            'randomized controlled trial': 'RCT',
            'controlled clinical trial': 'RCT',
            'clinical trial, phase iii': 'Clinical Trial',
            'clinical trial, phase ii': 'Clinical Trial',
            'clinical trial, phase i': 'Clinical Trial',
            'clinical trial, phase iv': 'Clinical Trial',
            'clinical trial': 'Clinical Trial',
            'review': 'Review',
            'case reports': 'Case Report',
            'case report': 'Case Report',
            'comparative study': 'Comparative Study',
            'observational study': 'Cohort',
            'cohort study': 'Cohort',
            'case-control study': 'Case-Control',
            'cross-sectional study': 'Cross-sectional',
            'journal article': 'Clinical Study',
            'english abstract': 'Clinical Study',
            'multicenter study': 'Clinical Study',
            'letter': 'Other',
            'editorial': 'Other',
            'comment': 'Other',
            'news': 'Other',
            'biography': 'Other',
            'other': 'Other',
        }
        normalized_pyramid: Dict[str, int] = {}
        for design, count in pyramid.items():
            std = _RAW_TO_STANDARD.get(design.lower(), design)
            normalized_pyramid[std] = normalized_pyramid.get(std, 0) + count
        pyramid = normalized_pyramid

        try:
            hierarchy = [
                'Meta-analysis', 'Systematic Review',
                'RCT',
                'Clinical Trial', 'Non-randomized Trial',
                'Cohort',
                'Case-Control', 'Cross-sectional',
                'Comparative Study', 'Clinical Study',
                'Review',
                'Case Report', 'Case Series',
                'Animal Study',
                'In Vitro',
                'Basic Research',
                'Other',
            ]

            sorted_items = []
            seen = set()
            for design in hierarchy:
                if design in pyramid and design not in seen:
                    sorted_items.append((design, pyramid[design]))
                    seen.add(design)

            for design, count in pyramid.items():
                if design not in seen:
                    sorted_items.append((design, count))

            if not sorted_items:
                return None
            # 少于 2 种研究设计类型时金字塔无分层意义
            if len(sorted_items) < 2:
                return None

            designs = [item[0] for item in sorted_items]
            counts = [item[1] for item in sorted_items]
            n = len(designs)

            # 研究设计类型中文映射
            _DESIGN_ZH = {
                'Meta-analysis': '荟萃分析', 'Systematic Review': '系统综述',
                'RCT': '随机对照试验', 'Clinical Trial': '临床试验',
                'Non-randomized Trial': '非随机试验', 'Cohort': '队列研究',
                'Case-Control': '病例对照研究', 'Cross-sectional': '横断面研究',
                'Comparative Study': '对比研究', 'Clinical Study': '临床研究',
                'Review': '综述', 'Case Report': '病例报告',
                'Case Series': '病例系列', 'Animal Study': '动物研究',
                'In Vitro': '体外研究', 'Basic Research': '基础研究',
                'Observational Study': '观察性研究', 'Other': '其他',
            }
            designs_zh = [_DESIGN_ZH.get(d, d) for d in designs]

            fig, ax = plt.subplots(figsize=(11, max(5, n * 0.55)))

            # 颜色：从高证据等级（深蓝）到低等级（浅蓝）
            colors = plt.get_cmap('Blues')([0.85 - 0.55 * i / max(n - 1, 1) for i in range(n)])

            y_pos = range(n)
            ax.barh(y_pos, counts, color=colors, edgecolor='white', linewidth=0.5)
            ax.set_yticks(y_pos)
            ax.set_yticklabels(designs_zh, fontsize=10)
            ax.invert_yaxis()
            ax.set_xlabel('研究数量', fontsize=12)
            ax.set_title('证据层级分布', fontsize=14, fontweight='bold')
            ax.set_xlim(0, max(counts) * 1.15)

            for i, v in enumerate(counts):
                ax.text(
                    v + max(counts) * 0.01, i,
                    str(v), va='center', ha='left', fontsize=10, fontweight='bold'
                )

            plt.tight_layout()
            path = self._generate_chart(fig, self.MODULE_ID, "evidence_pyramid", "bar")
            total_pyramid = sum(count for _, count in sorted_items)
            return self._create_chart_info(
                "证据层级分布图", path, "bar",
                f"按循证医学证据等级从高到低排序，展示各研究设计类型的文献数量分布（基于本次筛选的 {total_pyramid} 篇文献统计，不代表该领域全部发文量）"
            )
        except Exception as e:
            logger.warning(f"证据层级图生成失败: {e}")
            return None

    def _create_evidence_chain_chart(self, chain: Dict, total_pyramid: int = 0) -> Optional[ChartInfo]:
        """V5.0: 创建证据链路完整度图"""
        if not MATPLOTLIB_AVAILABLE or not chain:
            return None
        # 只有 1 个或 0 个链路阶段有数据时，柱状图没有比较意义
        stages_with_data = sum(
            1 for s in ['mechanism', 'animal', 'human_observational', 'clinical_endpoint']
            if chain.get(s, {}).get('count', 0) > 0
        )
        if stages_with_data < 2:
            return None

        try:
            fig, ax = plt.subplots(figsize=(10, 6))

            stages = ['mechanism', 'animal', 'human_observational', 'clinical_endpoint']
            labels = ['机制研究', '动物研究', '人群观察', '临床终点']

            counts = [chain.get(s, {}).get('count', 0) for s in stages]
            strengths = [chain.get(s, {}).get('strength', 'weak') for s in stages]

            # 根据强度设置颜色
            color_map = {'strong': '#2E7D32', 'moderate': '#F9A825', 'weak': '#C62828'}
            colors = [color_map.get(s, '#757575') for s in strengths]

            bars = ax.bar(labels, counts, color=colors, edgecolor='black', linewidth=1.5)

            # 添加数值标签
            for bar, count in zip(bars, counts):
                height = bar.get_height()
                ax.text(bar.get_x() + bar.get_width()/2., height,
                       f'{count}',
                       ha='center', va='bottom', fontsize=11, fontweight='bold')

            ax.set_ylabel('研究数量', fontsize=12)
            ax.set_title('证据链完整度', fontsize=14, fontweight='bold')
            ax.set_ylim(0, max(counts) * 1.2 if counts else 10)

            # 添加图例
            from matplotlib.patches import Patch
            legend_elements = [
                Patch(facecolor='#2E7D32', label='强'),
                Patch(facecolor='#F9A825', label='中'),
                Patch(facecolor='#C62828', label='弱')
            ]
            ax.legend(handles=legend_elements, loc='upper right')

            path = self._generate_chart(fig, self.MODULE_ID, "evidence_chain", "bar")
            total_chain = sum(counts)
            chain_note = (
                f"本次筛选共 {total_pyramid} 篇，其中 {total_chain} 篇可映射到证据链各阶段"
                f"（综述/横断面等设计类型不参与链条分类，故两者数值存在差异）"
            ) if total_pyramid and total_pyramid != total_chain else f"基于本次筛选的 {total_chain} 篇相关文献统计"
            return self._create_chart_info(
                "证据链路完整度图", path, "bar",
                f"展示从机制到临床终点的证据链各环节强度（{chain_note}，不代表该领域全部发文量）"
            )
        except Exception as e:
            logger.warning(f"证据链图生成失败: {e}")
            return None

    def _build_evidence_chain(self, records, pyramid):
        """构建证据链路"""
        chain = {
            "mechanism": {"count": 0, "strength": "weak", "examples": []},
            "animal": {"count": 0, "strength": "weak", "examples": []},
            "human_observational": {"count": 0, "strength": "weak", "examples": []},
            "clinical_endpoint": {"count": 0, "strength": "weak", "examples": []}
        }

        for r in records:
            design = r.study_design or "Other"
            if design in ['In Vitro', 'Basic Research']:
                chain["mechanism"]["count"] += 1
            elif design == 'Animal Study':
                chain["animal"]["count"] += 1
            elif design in ['Cohort', 'Case-Control', 'Case Report']:
                chain["human_observational"]["count"] += 1
            elif design in ['RCT', 'Clinical Trial', 'Meta-analysis']:
                chain["clinical_endpoint"]["count"] += 1

        total = sum(pyramid.values()) if pyramid else 1
        for key in chain:
            ratio = chain[key]["count"] / total
            if ratio > 0.3:
                chain[key]["strength"] = "strong"
            elif ratio > 0.1:
                chain[key]["strength"] = "moderate"
            else:
                chain[key]["strength"] = "weak"

        return chain

    def _build_evidence_matrix(self, topics, designs, records, canonical_themes):
        """构建主题-设计矩阵"""
        matrix = []
        for topic in topics:
            row = []
            for design in designs:
                count = 0
                for r in records:
                    record_themes = [t.lower().strip() for t in r.keywords + r.mesh_terms]
                    synonyms = canonical_themes.get(topic, [topic])
                    has_theme = any(syn.lower().strip() in rt for syn in synonyms for rt in record_themes)
                    if has_theme and r.study_design == design:
                        count += 1
                row.append(count)
            matrix.append(row)
        return matrix

    async def _generate_evidence_system_analysis(self, pyramid, evidence_chain, matrix, evidence_stats, query_context, stream_callback=None) -> Dict:
        """生成证据体系深度分析"""
        logger.info(f"[M3] 开始生成证据体系分析")

        prompt = M3_EVIDENCE_SYSTEM_PROMPT.format(
            query_context=query_context,
            pyramid=pyramid,
            mechanism_count=evidence_chain['mechanism']['count'],
            mechanism_strength=evidence_chain['mechanism']['strength'],
            animal_count=evidence_chain['animal']['count'],
            animal_strength=evidence_chain['animal']['strength'],
            human_count=evidence_chain['human_observational']['count'],
            human_strength=evidence_chain['human_observational']['strength'],
            clinical_count=evidence_chain['clinical_endpoint']['count'],
            clinical_strength=evidence_chain['clinical_endpoint']['strength'],
            matrix=matrix
        )

        logger.info(f"[M3] 准备调用LLM...")
        try:
            response = await self._llm_analyze(prompt, stream_callback, max_tokens=3000, temperature=0.2)
            logger.info(f"[M3] LLM调用成功")
            return safe_parse_json(response)
        except Exception as e:
            logger.error(f"[M3] 分析失败: {e}")
            return {
                "completeness": 0.5,
                "bridge_gaps": [],
                "balance": "分析失败",
                "deep_analysis": "证据体系分析生成失败。"
            }


class M4_ScientificContradictionModule(BaseAnalysisModule):
    """
    M4: 科学争议与矛盾分析 V5.0
    新增：矛盾矩阵热力图
    """

    MODULE_ID = "M4_SCIENTIFIC_CONTRADICTION"
    MODULE_NAME = "科学争议与矛盾分析"

    async def execute(
        self,
        standardized_input: StandardizedInput,
        evidence_records: List[LiteratureRecord],
        evidence_stats: EvidenceStats,
        dependencies: Dict[str, ModuleOutput] = None,
        stream_callback=None,
    ) -> ModuleOutput:

        query_terms = standardized_input.query_terms.zh + standardized_input.query_terms.en
        query_context = ", ".join(query_terms[:3]) if query_terms else "该研究领域"

        # 获取依赖数据
        m3_data = {}
        if dependencies and "M3_EVIDENCE_SYSTEM" in dependencies:
            m3_data = dependencies["M3_EVIDENCE_SYSTEM"].data

        # 矛盾识别分析
        contradiction_analysis = await self._generate_contradiction_analysis(
            evidence_records, evidence_stats, m3_data, query_context,
            stream_callback=stream_callback,
        )

        contradictions = self._validate_contradictions(
            contradiction_analysis.get("contradictions", []),
            evidence_records,
        )

        # V5.0: 只对通过双侧证据门禁的矛盾生成图表
        charts = []
        contradiction_chart = await self._create_chart_safe(
            self._create_contradiction_heatmap,
            contradictions,
        )
        if contradiction_chart:
            charts.append(contradiction_chart)

        # 查找支撑论据
        supporting_evidence = []
        evidence_by_pmid = {record.pmid: record for record in evidence_records if record.pmid}
        used_pmids = set()
        for contradiction in contradictions:
            for pmid in [
                *contradiction.get("evidence_A_pmids", []),
                *contradiction.get("evidence_B_pmids", []),
            ]:
                record = evidence_by_pmid.get(pmid)
                if not record or pmid in used_pmids:
                    continue
                used_pmids.add(pmid)
                supporting_evidence.append(SupportingEvidence(
                    pmid=pmid,
                    title=record.title,
                    authors=record.authors[:3],
                    year=record.publication_year,
                    journal=record.journal or "",
                    doi=record.doi,
                    relevance_score=1.0,
                    excerpt=(record.abstract or "")[:500],
                ))

        return ModuleOutput(
            module_id=self.MODULE_ID,
            status="success",
            data={
                "identified_contradictions": contradictions,
                "knowledge_fractures": contradiction_analysis.get("knowledge_fractures", []),
                "conflict_sources": contradiction_analysis.get("conflict_sources", {}),
                "resolution_priority": contradiction_analysis.get("priority", []),
                "llm_deep_analysis": contradiction_analysis.get("deep_analysis", ""),
                "resolution_paths": contradiction_analysis.get("paths", [])
            },
            charts=charts,
            supporting_evidence=supporting_evidence,
            key_insights=[
                c.get("title") or c.get("description", "")
                for c in contradictions
                if c.get("title") or c.get("description")
            ]
        )

    @staticmethod
    def _validate_contradictions(contradictions, records):
        """Publish only conflicts whose two sides point to different known PMIDs."""
        valid_pmids = {record.pmid for record in records if record.pmid}
        validated = []
        for index, raw in enumerate(contradictions or []):
            if not isinstance(raw, dict):
                continue
            side_a = list(dict.fromkeys(
                str(value).strip() for value in raw.get("evidence_A_pmids", [])
                if str(value).strip() in valid_pmids
            ))
            side_b = list(dict.fromkeys(
                str(value).strip() for value in raw.get("evidence_B_pmids", [])
                if str(value).strip() in valid_pmids and str(value).strip() not in side_a
            ))
            if not side_a or not side_b:
                continue
            item = dict(raw)
            item["contradiction_id"] = str(item.get("contradiction_id") or f"C{index + 1}")
            item["evidence_A_pmids"] = side_a[:4]
            item["evidence_B_pmids"] = side_b[:4]
            title = str(item.get("title") or f"证据冲突{index + 1}")
            if not title.startswith("待复核证据冲突："):
                item["title"] = "待复核证据冲突：" + title
            item["support_level"] = "candidate_conflict"
            item["support_rationale"] = (
                "两侧叙述均绑定了不同的可核对PMID，但仍需逐篇全文确认"
                "人群、干预、结局和估计尺度是否真正可比。"
            )
            try:
                item["intensity"] = max(0.0, min(1.0, float(item.get("intensity", 0.5))))
            except (TypeError, ValueError):
                item["intensity"] = 0.5
            validated.append(item)
        return validated[:3]

    def _create_contradiction_heatmap(
        self,
        contradictions: List[Dict]
    ) -> Optional[ChartInfo]:
        """V5.0: 创建科学矛盾强度图（全部矛盾，真实标签+数值标注）"""
        if not MATPLOTLIB_AVAILABLE or not contradictions:
            return None

        try:
            total = len(contradictions)
            # 保持原始顺序（与正文 5.1/5.2/5.3 章节一致），不按 intensity 重排
            items = contradictions

            # 标签：优先用 title 字段（与正文章节标题一致），降级用 description
            labels = []
            for i, c in enumerate(items):
                title = c.get("title", "").strip()
                desc = c.get("description", "").strip()
                ctype = c.get("contradiction_type", "").strip()
                text = title if title else (desc if desc else (ctype if ctype else f"矛盾 {i+1}"))
                section_num = i + 1
                label = f"5.{section_num} {text}"
                labels.append(label[:40] + ("…" if len(label) > 40 else ""))

            intensities = [float(c.get("intensity", 0.5)) for c in items]
            n = len(labels)

            fig, ax = plt.subplots(figsize=(12, max(4, n * 0.7)))

            # 颜色随强度渐变（浅→深红）
            norm_vals = [(v - 0.2) / 0.8 for v in intensities]  # 归一化到 [0,1]
            norm_vals = [max(0.1, min(1.0, v)) for v in norm_vals]
            colors = plt.cm.Reds(norm_vals)

            y_pos = range(n)
            ax.barh(y_pos, intensities, color=colors, edgecolor='white', linewidth=0.4)
            ax.set_yticks(y_pos)
            ax.set_yticklabels(labels, fontsize=10)
            ax.invert_yaxis()
            ax.set_xlabel('矛盾强度（0-1，越大越激烈）', fontsize=12)
            ax.set_title(
                f'科学矛盾强度分布（共 {total} 个）',
                fontsize=13, fontweight='bold'
            )
            ax.set_xlim(0, 1.15)

            # 柱右侧标注数值
            for i, v in enumerate(intensities):
                ax.text(v + 0.02, i, f"{v:.2f}", va='center', ha='left', fontsize=10)

            plt.tight_layout()
            path = self._generate_chart(fig, self.MODULE_ID, "contradiction_heatmap", "heatmap")
            return self._create_chart_info(
                "科学矛盾强度图", path, "heatmap",
                f"展示全部 {total} 个科学矛盾的激烈程度（intensity 由LLM基于本次筛选文献的证据冲突强度评分，0–1，分值越高冲突越激烈）"
            )
        except Exception as e:
            logger.warning(f"矛盾热力图生成失败: {e}")
            return None

    async def _generate_contradiction_analysis(self, records, evidence_stats, m3_data, query_context, stream_callback=None) -> Dict:
        """生成矛盾与断裂点深度分析"""
        logger.info(f"[M4] 开始生成科学矛盾分析")

        evidence_context = "\n\n".join(
            f"[PMID {record.pmid}] 设计={record.study_design or 'N/A'}\n"
            f"标题: {record.title}\n摘要: {(record.abstract or '')[:900]}"
            for record in records
            if record.pmid and record.abstract
        )[:30000]

        prompt = M4_SCIENTIFIC_CONTRADICTION_PROMPT.format(
            query_context=query_context,
            design_distribution=evidence_stats.design_distribution,
            evidence_context=evidence_context or "无可核对PMID摘要；必须返回空contradictions。",
        )

        logger.info(f"[M4] 准备调用LLM...")
        try:
            response = await self._llm_analyze(prompt, stream_callback, max_tokens=3500, temperature=0.2)
            logger.info(f"[M4] LLM调用成功")
            return safe_parse_json(response)
        except Exception as e:
            logger.error(f"[M4] 分析失败: {e}")
            return {
                "contradictions": [],
                "deep_analysis": "矛盾分析生成失败。"
            }


class M5_BreakthroughOpportunityModule(BaseAnalysisModule):
    """
    M5: 跨域知识关联分析 V5.0
    新增：突破机会气泡图
    """

    MODULE_ID = "M5_BREAKTHROUGH_OPPORTUNITY"
    MODULE_NAME = "跨域知识关联分析"

    async def execute(
        self,
        standardized_input: StandardizedInput,
        evidence_records: List[LiteratureRecord],
        evidence_stats: EvidenceStats,
        dependencies: Dict[str, ModuleOutput] = None,
        stream_callback=None,
    ) -> ModuleOutput:

        query_terms = standardized_input.query_terms.zh + standardized_input.query_terms.en
        query_context = ", ".join(query_terms[:3]) if query_terms else "该研究领域"

        # 获取前置模块数据
        m4_data = {}
        m3_data = {}
        if dependencies:
            if "M4_SCIENTIFIC_CONTRADICTION" in dependencies:
                m4_data = dependencies["M4_SCIENTIFIC_CONTRADICTION"].data
            if "M3_EVIDENCE_SYSTEM" in dependencies:
                m3_data = dependencies["M3_EVIDENCE_SYSTEM"].data

        # BOM深度挖掘
        bom_analysis = await self._mine_breakthrough_opportunities(
            evidence_records, evidence_stats, m4_data, m3_data, query_context,
            stream_callback=stream_callback,
        )

        # LLM返回的key是 breakthrough_opportunities，兼容 opportunities
        opportunities = self._validate_opportunities(
            bom_analysis.get("breakthrough_opportunities", bom_analysis.get("opportunities", [])),
            evidence_records,
        )
        if len(opportunities) < 2:
            fallback = self._fallback_opportunities(evidence_records, query_context)
            existing_titles = {str(item.get("title")) for item in opportunities}
            for item in fallback:
                if item["title"] not in existing_titles:
                    opportunities.append(item)
                    existing_titles.add(item["title"])
                if len(opportunities) >= 3:
                    break
        charts = []  # 不生成气泡图

        evidence_by_pmid = {record.pmid: record for record in evidence_records if record.pmid}
        supporting_evidence = []
        used_pmids = set()
        for opportunity in opportunities:
            for pmid in opportunity.get("evidence_pmids", []):
                record = evidence_by_pmid.get(pmid)
                if not record or pmid in used_pmids:
                    continue
                used_pmids.add(pmid)
                supporting_evidence.append(SupportingEvidence(
                    pmid=pmid,
                    title=record.title,
                    authors=record.authors[:3],
                    year=record.publication_year,
                    journal=record.journal or "",
                    doi=record.doi,
                    relevance_score=1.0,
                    excerpt=(record.abstract or "")[:500],
                ))

        # key_insights 填充突破机会标题列表，供摘要生成器使用（只保留标题，不含BOM前缀）
        opportunity_insights = [
            o.get('title', '')
            for o in opportunities
            if o.get('title')
        ]

        return ModuleOutput(
            module_id=self.MODULE_ID,
            status="success",
            data={
                "opportunities": opportunities,
                "cross_domain_map": bom_analysis.get("cross_domain_map", {}),
                "transfer_types": bom_analysis.get("transfer_types", {}),
                "priority_ranking": bom_analysis.get("ranking", []),
                "llm_deep_analysis": bom_analysis.get("deep_analysis", ""),
                "action_roadmap": bom_analysis.get("roadmap", [])
            },
            key_insights=opportunity_insights,
            charts=charts,
            supporting_evidence=supporting_evidence,
        )

    @staticmethod
    def _sanitize_generated_value(value):
        """Remove publication-style certainty and marketing from generated plans."""
        if isinstance(value, dict):
            return {
                key: M5_BreakthroughOpportunityModule._sanitize_generated_value(item)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [M5_BreakthroughOpportunityModule._sanitize_generated_value(item) for item in value]
        if not isinstance(value, str):
            return value
        replacements = (
            ("已充分揭示", "间接提示"),
            ("已证明", "拟检验"),
            ("已证实", "拟检验"),
            ("首次", "拟探索"),
            ("必然", "可能"),
            ("彻底改变", "可能改进"),
            ("颠覆性", "探索性"),
            ("改写指南", "为指南更新提供证据"),
            ("模型已利用", "模型拟利用"),
            ("可直接生成高影响力", "可形成可复核"),
            ("国际认可", "已有方法学应用"),
            ("全球首个", "拟验证的"),
            ("国际首个", "拟验证的"),
            ("国内首个", "拟验证的"),
            ("首创", "拟探索"),
            ("里程碑式", "后续"),
            ("高引用潜力", "可复核性"),
            ("直接转化", "为转化评估提供依据"),
            ("直接支持", "可为后续评估提供依据"),
            ("直接指导", "为后续决策评估提供待验证依据"),
            ("已完成", "尚待核实"),
            ("证实", "评估"),
            ("明确的临床指导", "待验证的临床评估依据"),
            ("全面接纳", "进一步评估"),
            ("金标准", "常用的因果效应评估设计之一"),
            ("最高级别的证据", "较高等级的干预证据"),
            ("近似因果级别的证据", "更贴近预先定义因果问题的估计"),
            ("最大限度控制混杂", "通过预先定义策略降低已测混杂的影响"),
            ("直接关联", "用于评估"),
            ("开源发布", "在许可证与复现审查通过后考虑开源发布"),
            ("范式飞跃", "路径演进"),
            ("树立范例", "提供可复用的方法学线索"),
            ("亟需", "可优先考虑"),
            ("唯有如此", "若能落实上述条件"),
        )
        for source, target in replacements:
            value = value.replace(source, target)
        value = re.sub(r"显著(?=降低|提高|提升|改善|增加)", "可能", value)
        value = value.replace("能可能", "可能").replace("可可能", "可能")
        value = re.sub(
            r"(?:纳入|每组)?\s*\d+\s*[–—~-]\s*\d+\s*例",
            "纳入先导样本（例数待基于预注册主要结局与可核对先导数据估算）",
            value,
        )
        value = re.sub(
            r"[（(]\s*\d+\s*例\s*[）)]",
            "（例数待基于预注册主要结局与可核对先导数据估算）",
            value,
        )
        value = re.sub(
            r"(?:纳入|招募|样本量(?:为)?|每组)\s*\d+\s*例",
            "例数待基于预注册主要结局与可核对先导数据估算",
            value,
        )
        value = re.sub(
            r"\d+\s*例",
            "例数待基于预注册主要结局与可核对先导数据估算",
            value,
        )
        value = re.sub(r"至少\s*\d+\s*个(?:以上)?", "经预设标准筛选的多个", value)
        value = re.sub(
            r"至少\s*\d+(?:\s*[-–—~]\s*\d+)?\s*家(?:三甲医院|医院|中心)?",
            "多家符合预设条件的中心",
            value,
        )
        value = re.sub(r"开启[^，。；]{0,24}新纪元", "形成可验证的新路径", value)
        return value

    @staticmethod
    def _concept_families(text):
        text = str(text or "").casefold()
        families = {
            "reinforcement_learning": ("强化学习", "reinforcement learning", "deep q", "q网络", "policy gradient", "策略梯度"),
            "machine_learning": ("机器学习", "machine learning", "xgboost", "neural network", "神经网络"),
            "immune_biomarker": ("宿主生物标志", "免疫标志", "il-6", "hla-dr", "immune biomarker"),
            "pathogen_genomics": ("病原体基因组", "全基因组测序", "耐药基因", "pathogen genom", "whole-genome"),
            "multimodal": ("多模态", "multimodal", "多维特征"),
            "target_trial": ("目标试验", "target trial"),
            "precision_dosing": ("精准给药", "precision dosing", "model-informed precision dosing", "mipd"),
            "tdm": ("治疗药物监测", "therapeutic drug monitoring", "tdm"),
            "causal_forest": ("因果森林", "causal forest"),
            "adaptive_dosing": ("自适应给药", "adaptive dosing", "闭环"),
            "kidney_function": ("肾功能", "kidney function", "renal function", "ckrt", "crrt"),
            "digital_twin": ("数字孪生", "digital twin"),
            "pbpk": ("生理药动", "physiologically based pharmacokinetic", "pbpk"),
            "biosensor": ("微流控", "电化学传感", "biosensor", "microfluidic"),
            "model_predictive_control": ("模型预测控制", "model predictive control", "mpc"),
            "neurologic_biomarker": ("nse", "s100b", "神经损伤标志", "neurologic biomarker"),
        }
        return {
            name for name, aliases in families.items()
            if any(alias.casefold() in text for alias in aliases)
        }

    @staticmethod
    def _validate_opportunities(opportunities, records):
        """Keep only traceable opportunities and normalize their release fields."""
        record_by_pmid = {record.pmid: record for record in records if record.pmid}
        valid_pmids = set(record_by_pmid)
        mechanism_terms = (
            ("铁死亡", "ferroptosis"), ("铜死亡", "cuproptosis"),
            ("泛凋亡", "panoptosis"), ("肠-肾轴", "gut-kidney"),
            ("空间转录组", "spatial transcriptomics"),
            ("空间代谢组", "spatial metabolomics"),
            ("单细胞", "single-cell"), ("类器官", "organoid"),
            ("昼夜节律", "circadian"),
        )
        validated = []
        for index, raw in enumerate(opportunities or []):
            if not isinstance(raw, dict):
                continue
            pmids = []
            for value in raw.get("evidence_pmids", []):
                pmid = str(value).strip()
                if pmid in valid_pmids and pmid not in pmids:
                    pmids.append(pmid)
            if not pmids:
                continue
            narrative_pmids = re.findall(
                r"PMID\s*[:：]?\s*(\d{6,9})",
                json.dumps(raw, ensure_ascii=False),
                flags=re.IGNORECASE,
            )
            if any(pmid not in valid_pmids for pmid in narrative_pmids):
                continue
            for pmid in narrative_pmids:
                if pmid not in pmids:
                    pmids.append(pmid)
            item = M5_BreakthroughOpportunityModule._sanitize_generated_value(dict(raw))
            item_text = json.dumps(item, ensure_ascii=False).casefold()
            evidence_texts = [
                ((record_by_pmid[pmid].title or "") + " " + (record_by_pmid[pmid].abstract or "")).casefold()
                for pmid in pmids
            ]
            evidence_text = " ".join(evidence_texts)
            unsupported_mechanism = any(
                any(term.casefold() in item_text for term in aliases)
                and not any(term.casefold() in evidence_text for term in aliases)
                for aliases in mechanism_terms
            )
            if unsupported_mechanism:
                continue
            item["opportunity_id"] = str(item.get("opportunity_id") or f"BOM{index + 1}")
            item["evidence_pmids"] = pmids
            proposal_concepts = M5_BreakthroughOpportunityModule._concept_families(item_text)
            evidence_concepts = M5_BreakthroughOpportunityModule._concept_families(evidence_text)
            missing = sorted(proposal_concepts - evidence_concepts)
            critical = {
                "reinforcement_learning", "immune_biomarker", "pathogen_genomics",
                "multimodal", "causal_forest", "adaptive_dosing",
                "digital_twin", "biosensor", "model_predictive_control", "neurologic_biomarker",
            }
            directly_cooccurs = bool(proposal_concepts) and any(
                proposal_concepts.issubset(M5_BreakthroughOpportunityModule._concept_families(text))
                for text in evidence_texts
            )
            requested_level = str(item.get("support_level") or "indirect").casefold()
            if requested_level == "speculative" or set(missing).intersection(critical):
                level = "speculative"
            elif requested_level == "direct" and directly_cooccurs:
                level = "direct"
            else:
                level = "indirect"
            item["support_level"] = level
            item["missing_evidence_concepts"] = missing
            item["support_rationale"] = (
                "候选方案含引用文献摘要未直接出现的关键概念，仅作为待验证假说。"
                if level == "speculative" else
                "引用文献为相邻方法或部分构件提供支持，尚不构成完整方案的直接验证。"
                if level == "indirect" else
                "至少一条引用文献的标题或摘要同时包含候选方案的核心方法概念。"
            )
            expected_impact = item.get("expected_impact")
            if isinstance(expected_impact, dict):
                expected_impact["clinical"] = (
                    "潜在临床效应的方向和大小尚未知，须由预注册研究估计；"
                    "当前证据不足以预设达标率、风险降低幅度或提前预警时间。"
                )
            if item["support_level"] == "speculative":
                validation_pathway = str(item.get("validation_pathway") or "").strip()
                caution = "启动前须核对数据与样本可用性、使用授权和伦理条件。"
                if validation_pathway and caution not in validation_pathway:
                    item["validation_pathway"] = validation_pathway + caution
            if item["support_level"] == "speculative" and "待验证" not in str(item.get("title") or ""):
                item["title"] = "待验证假说：" + str(item.get("title") or f"突破机会{index + 1}")
            for score_name in (
                "priority_score", "feasibility_score", "novelty_score", "clinical_impact_score"
            ):
                try:
                    item[score_name] = max(0.0, min(1.0, float(item.get(score_name, 0.5))))
                except (TypeError, ValueError):
                    item[score_name] = 0.5
            validated.append(item)
        return validated[:3]

    @staticmethod
    def _fallback_opportunities(records, query_context):
        """Create conservative method opportunities when structured LLM output is unusable.

        These do not assert a new mechanism; they convert an observed evidence
        type into a validation design and cite the record that triggered it.
        """
        usable = [record for record in records if record.pmid and record.abstract]
        if not usable:
            return []
        if re.search(r"\badults?\b", str(query_context), flags=re.IGNORECASE) or any(
            marker in str(query_context) for marker in ("成人", "成年人", "老年")
        ):
            pediatric = re.compile(
                r"\b(pediatrics?|paediatrics?|children?|infants?|neonates?|newborns?|preterm)\b",
                flags=re.IGNORECASE,
            )
            adult = re.compile(r"\b(adults?|elderly|aged)\b", flags=re.IGNORECASE)
            adult_only = []
            mixed_or_unspecified = []
            for record in usable:
                text = f"{record.title} {record.abstract or ''}"
                if adult.search(text) and not pediatric.search(text):
                    adult_only.append(record)
                else:
                    mixed_or_unspecified.append(record)
            # Mixed-age evidence may remain contextual, but it must not become
            # the primary anchor when adult-specific evidence is available.
            usable = adult_only + mixed_or_unspecified
        topic = str(query_context).split("（", 1)[0][:60]
        observational = next(
            (record for record in usable if record.study_design in {
                "Cohort", "Clinical Study", "Cross-sectional", "Case-Control"
            }),
            usable[0],
        )
        model_record = next(
            (record for record in usable if any(term in (record.title + " " + (record.abstract or "")).casefold()
                                               for term in ("model", "monitor", "dose", "algorithm"))),
            usable[0],
        )
        return [
            {
                "opportunity_id": "BOM-F1",
                "title": f"对{topic}关键策略开展预注册、多中心的患者重要结局验证",
                "type": "方法迁移",
                "scientific_innovation": "将当前关联性或替代终点证据转化为预注册的临床效应验证。",
                "validation_pathway": "首先统一干预和结局定义，再开展多中心前瞻性研究，并公开分析计划。",
                "evidence_pmids": [model_record.pmid],
                "support_level": "indirect",
                "support_rationale": (
                    f"PMID {model_record.pmid} 提供了给药、监测或模型相关的相邻证据；"
                    "预注册、多中心且以患者重要结局为终点的验证仍是待检验的方法学扩展。"
                ),
                "missing_evidence_concepts": ["preregistered_multicenter_outcome_validation"],
                "priority_score": 0.75,
                "feasibility_score": 0.65,
                "novelty_score": 0.55,
                "clinical_impact_score": 0.80,
            },
            {
                "opportunity_id": "BOM-F2",
                "title": f"用目标试验模拟检验{topic}观察性关联的因果稳健性",
                "type": "范式迁移",
                "scientific_innovation": "显式定义零时点、处理策略和随访，减少适应证混杂与不朽时间偏倚。",
                "validation_pathway": "基于现有队列预注册目标试验协议，使用加权/克隆-删失方法并开展负对照与定量偏倚分析。",
                "evidence_pmids": [observational.pmid],
                "support_level": "indirect",
                "support_rationale": (
                    f"PMID {observational.pmid} 提供了可用于因果稳健性评估的观察性或相邻证据；"
                    "目标试验模拟是待预注册和外部验证的分析扩展，不是已证实的因果结论。"
                ),
                "missing_evidence_concepts": ["preregistered_target_trial_emulation"],
                "priority_score": 0.78,
                "feasibility_score": 0.75,
                "novelty_score": 0.62,
                "clinical_impact_score": 0.76,
            },
        ]

    def _create_opportunity_bubble_chart(
        self,
        opportunities: List[Dict]
    ) -> Optional[ChartInfo]:
        """V5.0: 创建突破机会气泡图"""
        if not MATPLOTLIB_AVAILABLE or len(opportunities) < 2:
            return None

        try:
            fig, ax = plt.subplots(figsize=(10, 8))

            # 提取数据
            feasibilities = [o.get("feasibility_score", 0.5) for o in opportunities]
            novelties = [o.get("novelty_score", 0.5) for o in opportunities]
            impacts = [o.get("clinical_impact_score", 0.5) * 500 for o in opportunities]  # 气泡大小
            labels = [o.get("type", f"O{i+1}")[:20] for i, o in enumerate(opportunities)]

            # 根据优先级着色
            priorities = [o.get("priority_score", 0.5) for o in opportunities]
            colors = plt.cm.viridis(priorities)

            scatter = ax.scatter(feasibilities, novelties, s=impacts, c=colors,
                                alpha=0.6, edgecolors='black', linewidth=1)

            # 添加标签
            for i, label in enumerate(labels):
                ax.annotate(label, (feasibilities[i], novelties[i]),
                           fontsize=9, ha='center', va='bottom')

            ax.set_xlabel('可行性评分', fontsize=12)
            ax.set_ylabel('新颖性评分', fontsize=12)
            ax.set_title('突破机会分布图\n（气泡大小 = 临床影响力）',
                        fontsize=14, fontweight='bold')
            ax.set_xlim(0, 1)
            ax.set_ylim(0, 1)
            ax.grid(True, alpha=0.3)

            # 添加象限标注
            ax.axhline(y=0.5, color='gray', linestyle='--', alpha=0.5)
            ax.axvline(x=0.5, color='gray', linestyle='--', alpha=0.5)
            ax.text(0.25, 0.95, '低可行性\n高新颖性', ha='center', fontsize=9, alpha=0.7)
            ax.text(0.75, 0.95, '高可行性\n高新颖性', ha='center', fontsize=9, alpha=0.7)

            path = self._generate_chart(fig, self.MODULE_ID, "opportunity_bubble", "bubble")
            n_opps = len(opportunities)
            return self._create_chart_info(
                "突破机会气泡图", path, "bubble",
                f"共 {n_opps} 个突破机会，X轴为研究可行性，Y轴为科学新颖性，气泡大小为预期临床影响力（LLM基于本次筛选文献评估）"
            )
        except Exception as e:
            logger.warning(f"气泡图生成失败: {e}")
            return None

    async def _mine_breakthrough_opportunities(self, records, evidence_stats, m4_data, m3_data, query_context, stream_callback=None) -> Dict:
        """深度挖掘跨领域突破机会"""
        logger.info(f"[M5] 开始挖掘突破机会")

        contradictions = m4_data.get("identified_contradictions", [])
        bridge_gaps = m3_data.get("bridge_gaps", [])

        evidence_context = "\n\n".join(
            f"[PMID {record.pmid}] {record.title}\n"
            f"设计: {record.study_design or 'N/A'}\n"
            f"摘要: {(record.abstract or '')[:900]}"
            for record in records
            if record.pmid and record.abstract
        )[:24000]
        prompt = M5_BREAKTHROUGH_OPPORTUNITY_PROMPT.format(
            query_context=query_context,
            contradictions=contradictions,
            bridge_gaps=bridge_gaps,
            evidence_context=evidence_context or "无可核对PMID摘要；不得生成突破机会。",
        )

        logger.info(f"[M5] 准备调用LLM...")
        try:
            response = await self._llm_analyze(prompt, stream_callback, max_tokens=4000, temperature=0.25)
            logger.info(f"[M5] LLM调用成功")
            return safe_parse_json(response)
        except Exception as e:
            logger.error(f"[M5] 分析失败: {e}")
            return {
                "opportunities": [],
                "deep_analysis": "跨域分析生成失败。"
            }


class M6_ResearchAgendaModule(BaseAnalysisModule):
    """
    M6: 研究策略与选题规划 V5.0
    新增：推荐选题组合分析散点图
    """

    MODULE_ID = "M6_RESEARCH_AGENDA"
    MODULE_NAME = "研究策略与选题规划"

    async def execute(
        self,
        standardized_input: StandardizedInput,
        evidence_records: List[LiteratureRecord],
        evidence_stats: EvidenceStats,
        dependencies: Dict[str, ModuleOutput] = None,
        stream_callback=None,
    ) -> ModuleOutput:

        query_terms = standardized_input.query_terms.zh + standardized_input.query_terms.en
        query_context = ", ".join(query_terms[:3]) if query_terms else "该研究领域"

        logger.info(f"[M6] 研究主题: {query_context}")

        # 获取前置模块数据
        m5_data = {}
        m4_data = {}
        if dependencies:
            if "M5_BREAKTHROUGH_OPPORTUNITY" in dependencies:
                m5_data = dependencies["M5_BREAKTHROUGH_OPPORTUNITY"].data
                logger.info(f"[M6] 已获取 M5 依赖数据")
            if "M4_SCIENTIFIC_CONTRADICTION" in dependencies:
                m4_data = dependencies["M4_SCIENTIFIC_CONTRADICTION"].data
                logger.info(f"[M6] 已获取 M4 依赖数据")

        opportunities = m5_data.get("opportunities", [])
        logger.info(f"[M6] 突破机会数量: {len(opportunities)}")

        # 生成研究议程
        logger.info(f"[M6] 开始生成研究议程...")
        agenda = await self._generate_research_agenda(
            opportunities, m4_data, evidence_stats, query_context,
            stream_callback=stream_callback,
        )
        logger.info(f"[M6] 研究议程生成完成")

        # V5.0: 生成选题散点图
        charts = []
        logger.info(f"[M6] 开始生成选题散点图...")
        topic_chart = await self._create_chart_safe(
            self._create_topic_scatter_chart,
            agenda.get("topics", [])
        )
        if topic_chart:
            charts.append(topic_chart)
            logger.info(f"[M6] 选题散点图生成成功")
        else:
            logger.info(f"[M6] 选题散点图生成跳过（数据不足或matplotlib不可用）")

        logger.info(f"[M6] ========== M6_RESEARCH_AGENDA 模块执行完成 ==========")

        # 兼容 LLM 返回 research_topics 或 topics 两种 key
        topics_list = self._validate_topics(
            agenda.get("research_topics", agenda.get("topics", [])), opportunities
        )
        # 为执行摘要提供可用的 key_insights（只保留标题，不含R前缀）
        topic_key_insights = [
            t.get('title', '')
            for t in topics_list
            if t.get("title")
        ]

        return ModuleOutput(
            module_id=self.MODULE_ID,
            status="success",
            data={
                "research_topics": topics_list,
                "implementation_roadmap": agenda.get("roadmap", {}),
                "resource_requirements": agenda.get("resources", {}),
                "publication_strategy": agenda.get("publication", {}),
                "risk_mitigation": agenda.get("risks", []),
                "llm_deep_analysis": agenda.get("deep_analysis", ""),
                "next_steps": agenda.get("next_steps", [])
            },
            charts=charts,
            key_insights=topic_key_insights,
            supporting_evidence=(dependencies.get("M5_BREAKTHROUGH_OPPORTUNITY").supporting_evidence
                                 if dependencies and dependencies.get("M5_BREAKTHROUGH_OPPORTUNITY") else []),
        )

    @staticmethod
    def _validate_topics(topics, opportunities):
        """Enforce one traceable topic per opportunity and inherit evidence."""
        by_id = {
            str(item.get("opportunity_id")): item
            for item in opportunities
            if isinstance(item, dict) and item.get("opportunity_id")
        }
        validated = []
        seen = set()
        for raw in topics or []:
            if not isinstance(raw, dict):
                continue
            source_id = str(raw.get("source_opportunity_id") or "")
            source = by_id.get(source_id)
            if not source or source_id in seen:
                continue
            seen.add(source_id)
            item = M5_BreakthroughOpportunityModule._sanitize_generated_value(dict(raw))
            item["source_opportunity_title"] = source.get("title", "")
            item["source_evidence_pmids"] = list(source.get("evidence_pmids", []))
            item["support_level"] = source.get("support_level", "indirect")
            item["support_rationale"] = source.get("support_rationale", "")
            item["missing_evidence_concepts"] = list(source.get("missing_evidence_concepts", []))
            if item["support_level"] == "speculative" and "待验证" not in str(item.get("title") or ""):
                item["title"] = "待验证选题：" + str(item.get("title") or source.get("title") or source_id)
            hypothesis = str(item.get("hypothesis") or "").strip()
            if hypothesis and not hypothesis.startswith("待验证："):
                item["hypothesis"] = "待验证：" + hypothesis
            elif not hypothesis:
                item["hypothesis"] = (
                    "待验证：按预注册的主要结局检验“"
                    + str(source.get("title") or source_id)
                    + "”对应的研究假设。"
                )
            sample_size = item.get("sample_size")
            if isinstance(sample_size, dict):
                item["sample_size"] = {
                    "estimated_n": "待基于先导数据、预注册主要结局、效应量和失访假设正式测算",
                    "calculation_basis": "规划性假设；不采用模型生成的具体例数，需用可核对先导数据重新校准",
                }
            publication = item.get("publication_strategy")
            if isinstance(publication, dict):
                publication["expected_impact_factor"] = "不预设；投稿前核对期刊范围、最新指标与稿件匹配度"
                publication["key_selling_points"] = [
                    "待研究完成后根据真实结果、局限性和可复核证据提炼；不预设阳性发现或影响力。"
                ]
            if item.get("timeline"):
                item["timeline"] = "规划性草案（需按伦理、入组能力和实际资源校准）：" + str(item["timeline"])
            for score_name in ("priority_score", "feasibility_score", "novelty_score"):
                try:
                    item[score_name] = max(0.0, min(1.0, float(item.get(score_name, 0.5))))
                except (TypeError, ValueError):
                    item[score_name] = 0.5
            validated.append(item)

        # Preserve the one-opportunity/one-topic contract even when the model
        # omits an item. The fallback is explicitly provisional and inherits
        # evidence/support fields instead of inventing a new mechanism.
        for source_id, source in by_id.items():
            if source_id in seen:
                continue
            source_title = str(source.get("title") or source_id)
            support_level = source.get("support_level", "indirect")
            validated.append({
                "topic_id": f"R-{source_id}",
                "title": f"待验证选题：{source_title}",
                "source_opportunity_id": source_id,
                "source_opportunity_title": source_title,
                "source_evidence_pmids": list(source.get("evidence_pmids", [])),
                "support_level": support_level,
                "support_rationale": source.get("support_rationale", ""),
                "missing_evidence_concepts": list(source.get("missing_evidence_concepts", [])),
                "hypothesis": f"待验证：按预注册的主要结局检验“{source_title}”对应的研究假设。",
                "sample_size": {
                    "estimated_n": "待基于先导数据和预注册主要结局正式测算",
                    "calculation_basis": "规划性假设（需用可核对先导数据重新校准）",
                },
                "publication_strategy": {
                    "expected_impact_factor": "不预设；投稿前核对期刊范围、最新指标与稿件匹配度",
                },
                "priority_score": float(source.get("priority_score", 0.5)),
                "feasibility_score": float(source.get("feasibility_score", 0.5)),
                "novelty_score": float(source.get("novelty_score", 0.5)),
            })
        return validated

    def _create_topic_scatter_chart(
        self,
        topics: List[Dict]
    ) -> Optional[ChartInfo]:
        """V5.0: 创建推荐选题组合分析散点图"""
        if not MATPLOTLIB_AVAILABLE or len(topics) < 2:
            return None

        try:
            fig, ax = plt.subplots(figsize=(10, 8))

            # 提取数据
            feasibilities = [t.get("feasibility_score", 0.5) for t in topics]
            novelties = [t.get("novelty_score", 0.5) for t in topics]
            titles = [t.get("title", f"选题{i+1}")[:25] for i, t in enumerate(topics)]

            # 根据优先级着色
            priorities = [t.get("priority_score", 0.5) for t in topics]
            colors = plt.cm.plasma(priorities)

            scatter = ax.scatter(feasibilities, novelties, s=200, c=colors,
                                alpha=0.7, edgecolors='black', linewidth=2)

            # 添加标题标签
            for i, title in enumerate(titles):
                ax.annotate(title, (feasibilities[i], novelties[i]),
                           fontsize=8, ha='center', va='bottom',
                           bbox=dict(boxstyle='round,pad=0.3', facecolor='white', alpha=0.7))

            ax.set_xlabel('可行性 / 成本', fontsize=12)
            ax.set_ylabel('创新性 / 影响力', fontsize=12)
            ax.set_title('推荐选题组合分析', fontsize=14, fontweight='bold')
            ax.set_xlim(0, 1)
            ax.set_ylim(0, 1)
            ax.grid(True, alpha=0.3)

            # 添加象限标注
            ax.axhline(y=0.5, color='gray', linestyle='--', alpha=0.5)
            ax.axvline(x=0.5, color='gray', linestyle='--', alpha=0.5)
            ax.text(0.25, 0.05, '挑战区', ha='center', fontsize=10,
                   style='italic', alpha=0.7)
            ax.text(0.75, 0.95, '理想区', ha='center', fontsize=10,
                   style='italic', alpha=0.7, fontweight='bold')

            path = self._generate_chart(fig, self.MODULE_ID, "topic_scatter", "scatter")
            n_topics = len(topics)
            return self._create_chart_info(
                "推荐选题组合分析图", path, "scatter",
                f"共 {n_topics} 个推荐选题，X轴为研究可行性，Y轴为科学创新性/影响力，颜色深浅代表综合优先级（LLM基于本次筛选文献评估）"
            )
        except Exception as e:
            logger.warning(f"选题散点图生成失败: {e}")
            return None

    async def _generate_research_agenda(self, opportunities, m4_data, evidence_stats, query_context, stream_callback=None) -> Dict:
        """生成研究议程和可执行选题"""
        logger.info(f"[M6] 开始生成研究议程")
        logger.info(f"[M6] 输入参数 - opportunities数量: {len(opportunities)}, evidence_count: {evidence_stats.evidence_count}")

        # 将突破机会格式化为清晰的结构化文本，确保 LLM 能准确对应
        opp_lines = []
        for i, o in enumerate(opportunities[:5]):
            oid = o.get("opportunity_id") or o.get("id") or f"BOM{i+1}"
            title = o.get("title", "")
            desc = o.get("description", "")
            opp_type = o.get("type", "")
            feasibility = o.get("feasibility_score", "")
            novelty = o.get("novelty_score", "")
            lines = [f"**{oid}: {title}**"]
            if opp_type:
                lines.append(f"  - 类型: {opp_type}")
            if desc:
                lines.append(f"  - 描述: {desc}")
            if o.get("scientific_innovation"):
                lines.append(f"  - 科学创新: {o['scientific_innovation']}")
            if o.get("validation_pathway"):
                lines.append(f"  - 验证路径: {o['validation_pathway']}")
            lines.append(f"  - 证据PMID: {', '.join(o.get('evidence_pmids', []))}")
            lines.append(f"  - 支持层级: {o.get('support_level', 'indirect')}")
            if feasibility:
                lines.append(f"  - 可行性: {feasibility}")
            if novelty:
                lines.append(f"  - 新颖性: {novelty}")
            opp_lines.append("\n".join(lines))
        opportunities_text = "\n\n".join(opp_lines) if opp_lines else "暂无突破机会数据"

        prompt = M6_RESEARCH_AGENDA_PROMPT.format(
            query_context=query_context,
            opportunities=opportunities_text,
            evidence_count=evidence_stats.evidence_count,
            clinical_ratio=evidence_stats.clinical_ratio
        )

        logger.info(f"[M6] Prompt已构建，长度: {len(prompt)} 字符")
        logger.info(f"[M6] 准备调用LLM，max_tokens=4000，这可能需要较长时间...")

        try:
            response = await self._llm_analyze(prompt, stream_callback, max_tokens=4000, temperature=0.2)
            logger.info(f"[M6] LLM调用成功，响应长度: {len(response)} 字符")

            result = safe_parse_json(response)
            n_topics = len(result.get("research_topics", result.get("topics", [])))
            logger.info(f"[M6] JSON解析成功，生成了 {n_topics} 个研究选题")
            return result
        except Exception as e:
            logger.error(f"[M6] 分析失败: {e}", exc_info=True)
            return {
                "topics": [],
                "deep_analysis": "研究议程生成失败。",
                "next_steps": []
            }
