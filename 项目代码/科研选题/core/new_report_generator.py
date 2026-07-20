"""
报告生成器 V5.0 - 专家级循证选题分析报告
核心改造：模块输出作为素材 → 大纲生成 → 二次检索 → 分段撰写 → 引用整合 → 全文润色

生成的报告应达到世界级循证专家的选题分析水准：
- 每个结论都有具体文献引用（PMID、作者、年份）
- 图表嵌入正文并有引用标记
- Vancouver格式参考文献列表
- 证据链完整、逻辑严密
"""
import json
import logging
from typing import Dict, Any, List, Optional, AsyncGenerator
from datetime import datetime
from collections import OrderedDict

from models.schemas import (
    AnalysisReport, ModuleOutput, EvidenceStats,
    StandardizedInput, ExecutionPlan, LiteratureRecord,
    ChartInfo, SupportingEvidence
)
from services.llm_service import llm_service
from utils import safe_parse_json

logger = logging.getLogger(__name__)


class ReportGenerator:
    """
    报告生成器 V5.0

    Pipeline:
    1. 素材汇总 - 收集所有模块输出的data/key_insights/supporting_evidence/charts
    2. 大纲生成 - LLM基于素材摘要生成5-8章报告大纲
    3. 二次检索 - 对关键论点补充高质量证据
    4. 分段撰写 - 每章独立生成，要求引用具体文献
    5. 引用整合 - 统一编号，生成Vancouver格式参考文献列表
    6. 图表嵌入 - 在正文适当位置插入图表引用
    """

    # 模块中文名映射
    MODULE_NAMES = {
        "M1_PROBLEM_LANDSCAPE": "研究问题结构与领域全景",
        "M2_RESEARCH_ECOSYSTEM": "研究生态与知识结构",
        "M3_EVIDENCE_SYSTEM": "证据体系结构诊断",
        "M4_SCIENTIFIC_CONTRADICTION": "科学矛盾与知识断裂点",
        "M5_BREAKTHROUGH_OPPORTUNITY": "跨领域突破机会挖掘",
        "M6_RESEARCH_AGENDA": "研究议程与选题生成"
    }

    MODULE_ORDER = [
        "M1_PROBLEM_LANDSCAPE",
        "M2_RESEARCH_ECOSYSTEM",
        "M3_EVIDENCE_SYSTEM",
        "M4_SCIENTIFIC_CONTRADICTION",
        "M5_BREAKTHROUGH_OPPORTUNITY",
        "M6_RESEARCH_AGENDA"
    ]

    async def generate(
        self,
        task_id: str,
        input_text: str,
        standardized_input: StandardizedInput,
        execution_plan: ExecutionPlan,
        module_outputs: Dict[str, ModuleOutput],
        evidence_stats: EvidenceStats,
        evidence_records: List[LiteratureRecord] = None
    ) -> AnalysisReport:
        """
        生成专家级循证选题分析报告

        Args:
            task_id: 任务ID
            input_text: 用户原始输入
            standardized_input: 标准化输入
            execution_plan: 执行计划
            module_outputs: 各模块输出
            evidence_stats: 证据统计
            evidence_records: 原始文献记录列表
        """
        logger.info(f"[报告生成] ========== 开始生成报告: {task_id} ==========")

        # 构建查询上下文
        logger.info(f"[报告生成] Step 1: 构建查询上下文")
        query_context = self._build_query_context(standardized_input, input_text)
        logger.info(f"[报告生成] 查询上下文: {query_context}")

        # Step 1: 素材汇总
        logger.info(f"[报告生成] Step 2: 素材汇总")
        materials = self._collect_materials(module_outputs, evidence_stats, evidence_records)
        logger.info(f"[报告生成] 素材汇总完成 - 模块数: {len(materials.get('module_summaries', []))}")

        # Step 2: 生成报告大纲
        logger.info(f"[报告生成] Step 3: 生成报告大纲（调用LLM）")
        outline = await self._generate_outline(query_context, materials)
        logger.info(f"[报告生成] 大纲生成完成 - 章节数: {len(outline.get('sections', []))}")

        # Step 3: 构建引用库（从evidence_records和supporting_evidence中）
        logger.info(f"[报告生成] Step 4: 构建引用库")
        citation_pool = self._build_citation_pool(evidence_records or [], module_outputs)
        logger.info(f"[报告生成] 引用库构建完成 - 文献数: {len(citation_pool)}")

        # Step 4: 分段生成报告正文
        logger.info(f"[报告生成] Step 5: 开始分段生成报告正文")
        sections = []

        # 4a: 封面与元信息
        logger.info(f"[报告生成] 生成标题和元信息")
        title = self._generate_title(query_context, standardized_input)
        sections.append(self._render_cover(title, evidence_stats, query_context, module_outputs))

        # 4b: 执行摘要（基于所有模块的key_insights）
        logger.info(f"[报告生成] 生成执行摘要（调用LLM）")
        executive_summary = await self._generate_executive_summary(
            query_context, materials, evidence_stats
        )
        logger.info(f"[报告生成] 执行摘要生成完成")
        sections.append(executive_summary)

        # 4b2: 研究方法章节（第1章，固定结构）
        logger.info(f"[报告生成] 生成研究方法章节")
        sections.append(self._render_methodology(evidence_stats, query_context, standardized_input.pico_elements, module_outputs))

        # 4c: 各章节（基于大纲，融合模块素材，引用具体文献）
        logger.info(f"[报告生成] 开始生成各章节内容")
        chapter_num = 2  # 第1章为研究方法，分析章节从第2章开始
        for module_id in self.MODULE_ORDER:
            if module_id not in module_outputs:
                continue
            output = module_outputs[module_id]
            if output.status != "success":
                continue

            module_name = self.MODULE_NAMES.get(module_id, module_id)
            chapter_outline = outline.get(module_id, {})

            logger.info(f"[报告生成] 生成第 {chapter_num} 章: {module_name}（调用LLM）")
            m5_opps = []
            if module_id == "M6_RESEARCH_AGENDA" and "M5_BREAKTHROUGH_OPPORTUNITY" in module_outputs:
                m5_opps = module_outputs["M5_BREAKTHROUGH_OPPORTUNITY"].data.get("opportunities", [])
            section = await self._generate_chapter(
                chapter_num=chapter_num,
                module_id=module_id,
                module_name=module_name,
                module_data=output.data,
                key_insights=output.key_insights,
                supporting_evidence=output.supporting_evidence,
                charts=output.charts,
                chapter_outline=chapter_outline,
                query_context=query_context,
                evidence_stats=evidence_stats,
                citation_pool=citation_pool,
                m5_opportunities=m5_opps
            )
            logger.info(f"[报告生成] 第 {chapter_num} 章生成完成")
            sections.append(section)
            chapter_num += 1

        # 4d: 综合结论与建议
        logger.info(f"[报告生成] 生成综合结论（调用LLM）")
        conclusion = await self._generate_conclusion(
            query_context, materials, evidence_stats, chapter_num=chapter_num
        )
        logger.info(f"[报告生成] 综合结论生成完成")
        sections.append(conclusion)

        # Step 5: 生成参考文献列表
        logger.info(f"[报告生成] Step 6: 生成参考文献列表")
        references_section = self._render_references(citation_pool)
        logger.info(f"[报告生成] 参考文献列表生成完成 - 文献数: {len(citation_pool)}")
        sections.append(references_section)

        # Step 6: 图表索引
        logger.info(f"[报告生成] Step 7: 生成图表索引")
        chart_index = self._render_chart_index(module_outputs)
        if chart_index:
            logger.info(f"[报告生成] 图表索引生成完成")
            sections.append(chart_index)
        else:
            logger.info(f"[报告生成] 无图表，跳过图表索引")

        # 组装最终报告
        logger.info(f"[报告生成] Step 8: 组装最终报告")
        content = "\n\n".join(sections)

        # 收集所有图表
        all_charts = []
        for output in module_outputs.values():
            all_charts.extend(output.charts)

        report = AnalysisReport(
            report_id=f"REPORT_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
            task_id=task_id,
            title=title,
            generated_at=datetime.now(),
            content=content,
            module_outputs=module_outputs,
            evidence_stats=evidence_stats,
            all_charts=all_charts
        )

        logger.info(f"报告生成完成: {report.report_id}, 共{len(content)}字符")
        return report

    async def generate_streaming(
        self,
        task_id: str,
        input_text: str,
        standardized_input: StandardizedInput,
        execution_plan: ExecutionPlan,
        module_outputs: Dict[str, ModuleOutput],
        evidence_stats: EvidenceStats,
        evidence_records: List[LiteratureRecord] = None
    ) -> AsyncGenerator[tuple, None]:
        """
        流式生成报告 - 逐token yield (section_name, cumulative_content)，实现打字机效果
        对每个 LLM chunk 做二次分块 + sleep，确保无论 API 是否真流式都有打字机效果
        """
        import asyncio as _asyncio
        # 打字机参数：每次发送 CHUNK 个字符，间隔 DELAY 秒
        CHUNK = 40    # chars per display frame
        DELAY = 0.05   # 50ms，确保每个rAF帧(16ms)只到1条消息，Windows timer分辨率~15ms须>16ms

        logger.info(f"[流式报告] 开始: {task_id}")
        query_context = self._build_query_context(standardized_input, input_text)
        materials = self._collect_materials(module_outputs, evidence_stats, evidence_records)

        # 大纲（内部使用，不单独推流）
        outline = await self._generate_outline(query_context, materials)
        citation_pool = self._build_citation_pool(evidence_records or [], module_outputs)

        title = self._generate_title(query_context, standardized_input)
        sections = []

        # 封面（同步，立即推）
        cover = self._render_cover(title, evidence_stats, query_context, module_outputs)
        sections.append(cover)
        yield "封面", "\n\n".join(sections)

        # ── 内部工具：流式分块 ──
        async def stream_section(prompt, sec_name, max_tok, temp, prefix=""):
            """对单段内容做流式 + 打字机分块 yield，失败时降级批量"""
            sections.append(prefix)
            idx = len(sections) - 1
            try:
                async for raw in llm_service.complete_stream(prompt, max_tokens=max_tok, temperature=temp):
                    if not raw:
                        continue
                    for start in range(0, len(raw), CHUNK):
                        sections[idx] += raw[start:start + CHUNK]
                        yield sec_name, "\n\n".join(sections)
                        await _asyncio.sleep(DELAY)
            except Exception as e:
                logger.warning(f"[流式打字机] {sec_name} 流式失败，降级批量: {e}")
                text = await llm_service.complete(prompt, max_tokens=max_tok, temperature=temp)
                for start in range(0, len(text), CHUNK):
                    sections[idx] += text[start:start + CHUNK]
                    yield sec_name, "\n\n".join(sections)
                    await _asyncio.sleep(DELAY)

        # 执行摘要
        logger.info(f"[流式报告] 流式生成执行摘要")
        es_prompt = self._build_executive_summary_prompt(query_context, materials, evidence_stats)
        async for item in stream_section(es_prompt, "摘要", 1500, 0.25, "# 摘要\n\n"):
            yield item
        sections[-1] += "\n\n---\n"
        yield "摘要(完成)", "\n\n".join(sections)

        # 研究方法章节（第1章，固定结构，同步推）
        logger.info(f"[流式报告] 生成研究方法章节")
        sections.append(self._render_methodology(evidence_stats, query_context, standardized_input.pico_elements, module_outputs))
        yield "研究方法", "\n\n".join(sections)

        # 各章节
        chapter_num = 2  # 第1章为研究方法，分析章节从第2章开始
        for module_id in self.MODULE_ORDER:
            if module_id not in module_outputs:
                continue
            output = module_outputs[module_id]
            if output.status != "success":
                continue
            module_name = self.MODULE_NAMES.get(module_id, module_id)
            chapter_outline = outline.get(module_id, {})

            logger.info(f"[流式报告] 流式生成第{chapter_num}章: {module_name}")
            m5_opps = []
            if module_id == "M6_RESEARCH_AGENDA" and "M5_BREAKTHROUGH_OPPORTUNITY" in module_outputs:
                m5_opps = module_outputs["M5_BREAKTHROUGH_OPPORTUNITY"].data.get("opportunities", [])
            ch_prompt = self._build_chapter_prompt(
                chapter_num, module_id, module_name, output.data, output.key_insights,
                output.supporting_evidence, output.charts, chapter_outline,
                query_context, citation_pool,
                m5_opportunities=m5_opps
            )
            async for item in stream_section(ch_prompt, f"第{chapter_num}章", 3000, 0.3):
                yield item
            # 清理标题格式（去除 ###· 等符号）
            sections[-1] = self._clean_headings(sections[-1])
            # 将本章图表以base64内嵌入章节末尾
            chart_inline = self._render_charts_inline(output.charts, chapter_num)
            if chart_inline:
                sections[-1] += "\n\n" + chart_inline
            yield f"第{chapter_num}章(完成)", "\n\n".join(sections)
            chapter_num += 1

        # 综合结论
        logger.info(f"[流式报告] 流式生成综合结论")
        conclusion_prompt = self._build_conclusion_prompt(query_context, materials, evidence_stats, chapter_num=chapter_num)
        async for item in stream_section(conclusion_prompt, "综合结论", 1200, 0.25, f"## {chapter_num}. 综合结论\n\n"):
            yield item
        sections[-1] += self._render_limitations()
        sections[-1] += "\n\n---\n"
        yield "综合结论(完成)", "\n\n".join(sections)

        # 参考文献 + 图表索引（同步，最终推）
        references = self._render_references(citation_pool)
        sections.append(references)
        chart_index = self._render_chart_index(module_outputs)
        if chart_index:
            sections.append(chart_index)
        final_content = "\n\n".join(sections)
        logger.info(f"[流式报告] 完成, 共{len(final_content)}字符")
        yield "完成", final_content

    # ==================== Step 1: 素材汇总 ====================

    def _collect_materials(
        self,
        module_outputs: Dict[str, ModuleOutput],
        evidence_stats: EvidenceStats,
        evidence_records: List[LiteratureRecord] = None
    ) -> Dict[str, Any]:
        """收集所有模块输出作为报告素材"""
        materials = {
            "module_data": {},
            "all_key_insights": [],
            "all_supporting_evidence": [],
            "all_charts": [],
            "evidence_stats_summary": {
                "total_papers": evidence_stats.evidence_count,
                "clinical_ratio": evidence_stats.clinical_ratio,
                "year_span": evidence_stats.year_span,
                "earliest_year": evidence_stats.earliest_year,
                "latest_year": evidence_stats.latest_year,
                "design_distribution": evidence_stats.design_distribution,
                "top_journals": dict(list(evidence_stats.journal_counts.items())[:5]),
                "top_authors": dict(list(evidence_stats.author_counts.items())[:5])
            }
        }

        for module_id, output in module_outputs.items():
            if output.status != "success":
                continue

            materials["module_data"][module_id] = {
                "deep_analysis": output.data.get("llm_deep_analysis", ""),
                "key_insights": output.key_insights if module_id in ("M6_RESEARCH_AGENDA", "M5_BREAKTHROUGH_OPPORTUNITY") else output.key_insights[:5],
                "key_fields": {k: v for k, v in output.data.items()
                              if k != "llm_deep_analysis" and not isinstance(v, (list, dict))},
                # 单独保存M5/M6的原始列表，供摘要生成器构建带描述的emphasis
                "raw_opportunities": output.data.get("opportunities", []) if module_id == "M5_BREAKTHROUGH_OPPORTUNITY" else [],
                "raw_topics": output.data.get("research_topics", output.data.get("topics", [])) if module_id == "M6_RESEARCH_AGENDA" else [],
            }
            materials["all_key_insights"].extend(output.key_insights)
            materials["all_supporting_evidence"].extend(output.supporting_evidence)
            materials["all_charts"].extend(output.charts)

        return materials

    # ==================== Step 2: 大纲生成 ====================

    async def _generate_outline(
        self,
        query_context: str,
        materials: Dict[str, Any]
    ) -> Dict[str, Dict]:
        """LLM生成报告大纲"""
        logger.info(f"[报告生成-大纲] 开始生成报告大纲")

        insights_text = "\n".join(
            f"- {insight}" for insight in materials["all_key_insights"][:15]
        ) or "暂无关键洞察"

        modules_available = list(materials["module_data"].keys())
        stats = materials["evidence_stats_summary"]

        logger.info(f"[报告生成-大纲] 可用模块: {modules_available}")
        logger.info(f"[报告生成-大纲] 关键洞察数: {len(materials['all_key_insights'])}")

        prompt = f"""你是一位世界级的循证医学研究战略专家。请为以下科研选题分析报告生成详细的章节大纲。

## 研究主题
{query_context}

## 已有分析素材
- 文献总量: {stats['total_papers']}篇
- 时间跨度: 2022-2026
- 临床研究占比: {stats['clinical_ratio']:.1%}
- 已完成的分析模块: {', '.join(modules_available)}

## 关键发现摘要
{insights_text}

## 要求
为每个已完成的分析模块生成2-4个子章节标题和每个子章节的核心论点。
大纲应体现循证医学的严谨性，每个论点都应该能被文献证据支撑。

## 输出格式（JSON）
{{
  "模块ID": {{
    "chapter_title": "章节标题",
    "subsections": [
      {{"title": "子章节标题", "key_argument": "核心论点", "evidence_needed": "需要的证据类型"}}
    ]
  }}
}}"""

        logger.info(f"[报告生成-大纲] 准备调用LLM生成大纲...")
        try:
            response = await llm_service.complete(prompt, json_mode=True, max_tokens=3000, temperature=0.2)
            result = safe_parse_json(response, {})
            if not result and response.strip():
                logger.warning("[报告生成-大纲] 首次JSON无法解析，进行一次紧凑结构重试")
                compact_prompt = (
                    prompt
                    + "\n\n## 重试格式硬约束\n"
                    + f"仅输出这些模块ID: {', '.join(modules_available)}。"
                    + "每个模块恰好2个subsections；每个字段不超过60个汉字；"
                    + "只返回一个完整JSON对象，不得使用Markdown代码块或添加解释。"
                )
                response = await llm_service.complete(
                    compact_prompt,
                    json_mode=True,
                    max_tokens=6000,
                    temperature=0.1,
                )
                result = safe_parse_json(response, {})
            result = {
                module_id: result[module_id]
                for module_id in modules_available
                if isinstance(result.get(module_id), dict)
            }
            logger.info(f"[报告生成-大纲] 大纲生成成功，包含 {len(result)} 个模块的大纲")
            return result
        except Exception as e:
            logger.warning(f"[报告生成-大纲] 大纲生成失败，使用默认大纲: {e}")
            return {}

    # ==================== Step 3: 引用库构建 ====================

    def _build_citation_pool(
        self,
        evidence_records: List[LiteratureRecord],
        module_outputs: Dict[str, ModuleOutput]
    ) -> OrderedDict:
        """
        构建引用库：从文献记录和模块supporting_evidence中收集

        Returns:
            OrderedDict: pmid -> citation_info，按引用顺序排列
        """
        pool = OrderedDict()

        # 从模块的supporting_evidence中收集（优先，因为这些是最相关的）
        for output in module_outputs.values():
            for ev in output.supporting_evidence:
                if ev.pmid and ev.pmid not in pool:
                    pool[ev.pmid] = {
                        "pmid": ev.pmid,
                        "title": ev.title,
                        "authors": ev.authors,
                        "year": ev.year,
                        "journal": ev.journal,
                        "doi": ev.doi,
                        "excerpt": ev.excerpt,
                        "ref_num": 0  # 稍后分配
                    }

        # 从原始文献记录中补充高引用/高相关的。DOI-only 文献可以
        # 被引用，但绝不得将内部复合 ID 伪装成 PMID。
        if evidence_records:
            # 按年份降序排列，优先引用新文献
            sorted_records = sorted(
                evidence_records,
                key=lambda r: (r.is_clinical, r.publication_year or 0),
                reverse=True
            )
            for record in sorted_records[:50]:  # 最多50篇
                key = (
                    record.pmid
                    or (f"doi:{record.doi.strip().casefold()}" if record.doi else "")
                    or f"id:{record.id}"
                )
                if key and key not in pool:
                    authors = record.authors[:3]
                    pool[key] = {
                        "pmid": record.pmid,
                        "title": record.title,
                        "authors": authors,
                        "year": record.publication_year,
                        "journal": record.journal or "",
                        "doi": record.doi,
                        "excerpt": (record.abstract or "")[:200],
                        "ref_num": 0
                    }

        # 分配引用编号
        for i, pmid in enumerate(pool, 1):
            pool[pmid]["ref_num"] = i

        return pool

    # ==================== Step 4: 分段生成 ====================

    def _build_chapter_prompt(
        self,
        chapter_num: int,
        module_id: str,
        module_name: str,
        module_data: Dict[str, Any],
        key_insights: List[str],
        supporting_evidence: List[SupportingEvidence],
        charts: List[ChartInfo],
        chapter_outline: Dict,
        query_context: str,
        citation_pool: OrderedDict,
        m5_opportunities: List[Dict] = None
    ) -> str:
        """构建章节Prompt（供非流式和流式共用）"""
        chapter_refs = self._prepare_chapter_references(supporting_evidence, citation_pool)
        chart_refs = self._prepare_chart_references(charts, chapter_num)
        grounded_module_data = dict(module_data)
        # Free-form module prose is useful for interactive reasoning, but it is
        # not a factual source.  Publication prompts receive structured fields,
        # evidence excerpts, and validated identifiers only.
        grounded_module_data.pop("llm_deep_analysis", None)
        data_summary = self._summarize_module_data(grounded_module_data)

        outline_info = ""
        if chapter_outline and isinstance(chapter_outline, dict):
            subsections = chapter_outline.get("subsections", [])
            if subsections:
                outline_info = "## 章节大纲\n"
                for sub in subsections:
                    if isinstance(sub, dict):
                        outline_info += f"- {sub.get('title', '')}: {sub.get('key_argument', '')}\n"

        # M5专项：要求在正文中展示每个突破机会的优先级评分
        m5_score_note = ""
        if module_id == "M5_BREAKTHROUGH_OPPORTUNITY":
            m5_score_note = """
## 优先级评分展示要求
每个突破机会子章节末尾必须包含以下格式的评分说明：
> **优先级评分**：综合X.XX（科学创新性X.X / 临床转化价值X.X / 研究可行性X.X）

评分来源于分析素材中各突破机会的 priority_score、feasibility_score、novelty_score、clinical_impact_score 字段，请如实填入，不要编造。
"""

        # M6专项：注入M5突破机会列表，强制要求选题与突破机会对应
        m5_linkage_note = ""
        if m5_opportunities:
            opps_str = "\n".join(
                f"- {o.get('opportunity_id', f'BOM{i+1}')}: {o.get('title', '')} "
                f"| support={o.get('support_level', 'indirect')} "
                f"| PMID={','.join(o.get('evidence_pmids', []))}"
                for i, o in enumerate(m5_opportunities)
            )
            n_opps = len(m5_opportunities)
            m5_linkage_note = f"""
## 第6章突破机会列表（共{n_opps}项）
{opps_str}

**格式要求**：
1. 本章开头先用1-2句话说明第6章突破机会如何转化为本章具体选题（过渡说明）
2. 选题数量与上方突破机会数量完全一致（{n_opps}个突破机会对应{n_opps}个选题）
3. 每个子章节标题格式为"### {chapter_num}.N 选题标题（来源：对应突破机会标题）"
4. 每个选题正文开头注明"**来源突破机会**：BOM编号 — 突破机会标题"
5. 每个选题末尾注明"**优先级评分**：综合X.XX（科学创新性X.X / 临床转化价值X.X / 研究可行性X.X）"
"""

        return f"""你是一位世界级的循证医学研究战略专家，正在撰写一份专业的科研选题分析报告的第{chapter_num}章。

## 研究主题
{query_context}

## 本章主题
第{chapter_num}章: {module_name}

{outline_info}
{m5_score_note}
{m5_linkage_note}
## 分析素材
{data_summary}

## 关键发现
{chr(10).join(f'- {insight}' for insight in key_insights[:5]) if key_insights else '暂无'}

## 可引用的文献（请在正文中用[编号]格式引用）
{chapter_refs}
{f"## 可引用的图表{chr(10)}{chart_refs}" if chart_refs else ""}

## 撰写要求
1. 以专业的学术语言撰写，逻辑严密，论证充分
2. 每个重要结论必须引用具体文献，使用[编号]格式，如[1]、[2,3]、[4-6]
3. 如有图表可引用，在适当位置插入"（见图X）"或"如图X所示"
4. 内容要有深度和洞察力，不要泛泛而谈
5. 每个子章节200-400字，整章800-1500字
6. 格式规范（严格遵守）：
   - 本章顶级标题固定写为"## {chapter_num}. {module_name}"，直接以此开头，禁止写"第X章"等中文序号
   - 子章节格式固定为"### {chapter_num}.N 标题文字"（N从1递增，如"### {chapter_num}.1 科学张力识别"）
   - **若上方"关键发现"列表不为空，子章节标题必须与关键发现列表中的条目一一对应，顺序和措辞保持完全一致，不得自行改写或新增**
   - 禁止在任何标题后添加·、-、：、—、•等符号，禁止标题末尾加句号
7. 必须基于提供的分析素材撰写，不要编造数据
8. 引用只能支持其标题/摘要明确包含的主张；不得用一篇仅讨论TDM的文献支持铁死亡、肠-肾轴、空间组学等未出现概念
9. 若分析素材的 support_level 为 speculative，每次描述都必须明示“待验证假说”，不得写成已有事实
10. 深度来自清晰区分“直接证据”“间接推断”“待验证假说”，而不是增加无证据的机制细节
11. 不得使用“首次”、“已证实”、“一致否定”、“必然”、“根本性断裂”、“改写指南”、“开启新纪元”等绝对或宣传措辞
12. 研究方案中的生物标志物、算法、样本量、效应量、发生率和数据库如非被引用摘要直接支持，必须表述为“拟设计/规划性假设/待校准”，不得声称已经完成

请直接输出Markdown格式的章节内容，不要输出JSON。"""

    async def _generate_chapter(
        self,
        chapter_num: int,
        module_id: str,
        module_name: str,
        module_data: Dict[str, Any],
        key_insights: List[str],
        supporting_evidence: List[SupportingEvidence],
        charts: List[ChartInfo],
        chapter_outline: Dict,
        query_context: str,
        evidence_stats: EvidenceStats,
        citation_pool: OrderedDict,
        m5_opportunities: List[Dict] = None
    ) -> str:
        """生成单个章节 - 融合素材、引用文献、嵌入图表"""
        logger.info(f"[报告生成-章节{chapter_num}] 开始生成: {module_name}")
        logger.info(f"[报告生成-章节{chapter_num}] 可引用文献: {len(supporting_evidence)}, 图表: {len(charts)}")

        prompt = self._build_chapter_prompt(
            chapter_num, module_id, module_name, module_data, key_insights,
            supporting_evidence, charts, chapter_outline, query_context, citation_pool,
            m5_opportunities=m5_opportunities
        )

        logger.info(f"[报告生成-章节{chapter_num}] 准备调用LLM生成章节内容...")
        try:
            chapter_content = await llm_service.complete(
                prompt, max_tokens=3000, temperature=0.3
            )
            logger.info(f"[报告生成-章节{chapter_num}] 章节内容生成成功，长度: {len(chapter_content)} 字符")
            return self._clean_headings(chapter_content)
        except Exception as e:
            logger.warning(f"[报告生成-章节{chapter_num}] 章节 {module_id} 生成失败，使用简化版本: {e}")
            return self._fallback_chapter(chapter_num, module_name, module_data, key_insights)

    @staticmethod
    def _clean_headings(text: str) -> str:
        """清理 LLM 输出中的标题格式问题：
        - 去除 ##/### 后的 ·、-、：等连接符号
        - 去除标题末尾的句号/。
        """
        import re
        # 匹配 ##+ 开头，后面紧跟非空白的连接符号（·、-、：、:、—、•）
        text = re.sub(r'^(#{2,})\s*[·\-：:—•]\s*', r'\1 ', text, flags=re.MULTILINE)
        # 去除标题行末尾的中文句号或英文句点
        text = re.sub(r'^(#{2,} .+)[。\.]\s*$', r'\1', text, flags=re.MULTILINE)
        return text

    def _prepare_chapter_references(
        self,
        supporting_evidence: List[SupportingEvidence],
        citation_pool: OrderedDict
    ) -> str:
        """准备章节可引用的文献列表"""
        refs = []

        # 优先使用该模块的supporting_evidence
        used_pmids = set()
        for ev in supporting_evidence[:10]:
            if ev.pmid in citation_pool:
                info = citation_pool[ev.pmid]
                ref_num = info["ref_num"]
                authors_str = ", ".join(info["authors"][:3])
                if len(info["authors"]) > 3:
                    authors_str += " et al."
                refs.append(
                    f"[{ref_num}] {authors_str}. {info['title'][:80]}. "
                    f"{info['journal']}, {info['year']}. PMID: {ev.pmid}. "
                    f"可核对摘要：{str(info.get('excerpt') or '')[:240]}"
                )
                used_pmids.add(ev.pmid)

        # 补充引用池中的其他高相关文献
        for pmid, info in list(citation_pool.items())[:20]:
            if pmid not in used_pmids and len(refs) < 15:
                ref_num = info["ref_num"]
                authors_str = ", ".join(info["authors"][:3])
                if len(info["authors"]) > 3:
                    authors_str += " et al."
                refs.append(
                    f"[{ref_num}] {authors_str}. {info['title'][:80]}. "
                    f"{info['journal']}, {info['year']}. "
                    f"{('PMID: ' + str(info.get('pmid')) + '. ') if info.get('pmid') else ''}"
                    f"{('DOI: ' + str(info.get('doi')) + '. ') if info.get('doi') else ''}"
                    f"可核对摘要：{str(info.get('excerpt') or '')[:240]}"
                )

        return "\n".join(refs) if refs else "暂无可引用文献"

    def _prepare_chart_references(self, charts: List[ChartInfo], chapter_num: int) -> str:
        """准备图表引用信息；无图表时返回空字符串，不占用LLM上下文"""
        if not charts:
            return ""

        refs = []
        for i, chart in enumerate(charts, 1):
            fig_num = f"{chapter_num}.{i}"
            refs.append(f"图{fig_num}: {chart.title} ({chart.chart_type}图) - {chart.description}")

        return "\n".join(refs)

    def _summarize_module_data(self, data: Dict[str, Any]) -> str:
        """将模块数据摘要化，避免传入过大的prompt"""
        summary_parts = []

        # 提取深度分析文本
        deep_analysis = data.get("llm_deep_analysis", "")
        if deep_analysis:
            summary_parts.append(f"### 深度分析\n{deep_analysis[:1500]}")

        # M5 突破机会：专项处理，保留评分字段
        opportunities = data.get("opportunities", [])
        if opportunities:
            lines = ["### 突破机会列表（含优先级评分）"]
            for i, o in enumerate(opportunities):
                title = o.get("title", o.get("name", f"机会{i+1}"))
                priority = o.get("priority_score", "N/A")
                feasibility = o.get("feasibility_score", "N/A")
                novelty = o.get("novelty_score", "N/A")
                impact = o.get("clinical_impact_score", "N/A")
                desc = o.get("description", "")[:100]
                lines.append(
                    f"- {title}｜优先级={priority}｜可行性={feasibility}｜新颖性={novelty}｜临床影响={impact}"
                    f"｜支持层级={o.get('support_level', 'indirect')}"
                    f"｜PMID={','.join(o.get('evidence_pmids', [])) or 'N/A'}"
                    + (f"｜{desc}" if desc else "")
                )
            summary_parts.append("\n".join(lines))

        # M6 研究选题：专项处理，保留评分字段
        research_topics = data.get("research_topics", [])
        if research_topics:
            lines = ["### 推荐研究选题列表（含优先级评分）"]
            for i, t in enumerate(research_topics):
                title = t.get("title", f"选题{i+1}")
                priority = t.get("priority_score", "N/A")
                feasibility = t.get("feasibility_score", "N/A")
                novelty = t.get("novelty_score", "N/A")
                rationale = t.get("rationale", t.get("description", ""))[:100]
                lines.append(
                    f"- {title}｜优先级={priority}｜可行性={feasibility}｜新颖性={novelty}"
                    f"｜支持层级={t.get('support_level', 'indirect')}"
                    f"｜PMID={','.join(t.get('source_evidence_pmids', [])) or 'N/A'}"
                    + (f"｜{rationale}" if rationale else "")
                )
            summary_parts.append("\n".join(lines))

        # 提取其他关键数值和列表
        skip_keys = {"llm_deep_analysis", "opportunities", "research_topics"}
        for key, value in data.items():
            if key in skip_keys:
                continue
            if isinstance(value, (int, float, str)) and value:
                summary_parts.append(f"- {key}: {value}")
            elif isinstance(value, list) and value:
                if len(value) <= 5:
                    items = []
                    for item in value:
                        if isinstance(item, dict):
                            desc = item.get("description", item.get("title", item.get("name", str(item)[:100])))
                            items.append(str(desc)[:100])
                        else:
                            items.append(str(item)[:100])
                    summary_parts.append(f"- {key}: {'; '.join(items)}")
                else:
                    summary_parts.append(f"- {key}: 共{len(value)}项")
            elif isinstance(value, dict) and value:
                summary_parts.append(f"- {key}: {', '.join(str(k) for k in list(value.keys())[:5])}")

        return "\n".join(summary_parts) if summary_parts else "暂无数据"

    def _fallback_chapter(
        self,
        chapter_num: int,
        module_name: str,
        data: Dict,
        key_insights: List[str]
    ) -> str:
        """章节生成失败时的降级方案"""
        section = f"## {chapter_num}. {module_name}\n\n"

        deep_analysis = data.get("llm_deep_analysis", "")
        if deep_analysis:
            section += f"{deep_analysis}\n\n"

        if key_insights:
            section += "### 关键发现\n\n"
            for insight in key_insights[:5]:
                section += f"- {insight}\n"

        return section

    # ==================== 执行摘要 ====================

    def _build_executive_summary_prompt(
        self,
        query_context: str,
        materials: Dict[str, Any],
        evidence_stats: EvidenceStats
    ) -> str:
        """构建执行摘要Prompt（供非流式和流式共用）"""
        all_insights = materials["all_key_insights"][:20]
        stats = materials["evidence_stats_summary"]
        module_summaries = []
        m6_topic_list = []  # 专门收集 M6 研究议程完整列表（标题）
        m4_contradiction_list = []  # 专门收集 M4 科学矛盾完整列表
        m5_opportunity_list = []  # 专门收集 M5 突破机会完整列表（标题）
        m5_raw_opportunities = []  # M5 原始对象列表（含描述）
        m6_raw_topics = []  # M6 原始对象列表（含描述）
        for mid, mdata in materials["module_data"].items():
            deep = mdata.get("deep_analysis", "")
            module_insights = mdata.get("key_insights", [])
            parts = []
            # M5/M6 不放 deep_analysis 进 module_summaries，防止 LLM 从中自行提炼
            if deep and mid not in ("M5_BREAKTHROUGH_OPPORTUNITY", "M6_RESEARCH_AGENDA"):
                parts.append(deep[:500])
            if module_insights:
                # M6 研究议程、M5 突破机会全部展示，其余模块保留 3 条
                max_items = len(module_insights) if mid in ("M6_RESEARCH_AGENDA", "M5_BREAKTHROUGH_OPPORTUNITY") else 3
                parts.append("关键发现: " + "; ".join(module_insights[:max_items]))
            if mid == "M6_RESEARCH_AGENDA" and module_insights:
                m6_topic_list = module_insights
                m6_raw_topics = mdata.get("raw_topics", [])
            if mid == "M4_SCIENTIFIC_CONTRADICTION" and module_insights:
                m4_contradiction_list = module_insights
            if mid == "M5_BREAKTHROUGH_OPPORTUNITY" and module_insights:
                m5_opportunity_list = module_insights
                m5_raw_opportunities = mdata.get("raw_opportunities", [])
            if parts:
                module_summaries.append(f"[{self.MODULE_NAMES.get(mid, mid)}] " + " | ".join(parts))

        # 构建 M5 突破机会强调提示（含描述）
        m5_emphasis = ""
        if m5_opportunity_list:
            opp_lines = []
            for i, title in enumerate(m5_opportunity_list):
                raw = m5_raw_opportunities[i] if i < len(m5_raw_opportunities) else {}
                # M5 JSON结构：scientific_innovation / expected_breakthrough / validation_pathway
                desc = (raw.get("scientific_innovation", "")
                        or raw.get("expected_breakthrough", "")
                        or raw.get("validation_pathway", "")
                        or raw.get("description", ""))
                if desc:
                    opp_lines.append(f"- **{title}**\n  {desc[:200]}")
                else:
                    opp_lines.append(f"- **{title}**")
            m5_emphasis = (
                f"\n\n## 【第4段专用】第6章突破机会完整列表（共 {len(m5_opportunity_list)} 项）\n"
                f"⚠️ 第4段必须逐一列出以下全部 {len(m5_opportunity_list)} 项，每项用标题+1-2句描述展开，不得遗漏：\n"
                + "\n".join(opp_lines)
            )

        # 构建 M6 研究议程强调提示（含描述）
        m6_emphasis = ""
        if m6_topic_list:
            topic_lines = []
            for i, title in enumerate(m6_topic_list):
                raw = m6_raw_topics[i] if i < len(m6_raw_topics) else {}
                # M6 JSON结构：rationale 在 study_design 子对象里，hypothesis 在顶层
                study_design = raw.get("study_design", {})
                study_design = study_design if isinstance(study_design, dict) else {}
                rationale = (study_design.get("rationale", "")
                             or raw.get("hypothesis", "")
                             or (raw.get("innovation_points", [""])[0] if raw.get("innovation_points") else "")
                             or raw.get("description", ""))
                if rationale:
                    topic_lines.append(f"- **{title}**\n  {rationale[:200]}")
                else:
                    topic_lines.append(f"- **{title}**")
            m6_emphasis = (
                f"\n\n## 【第5段专用】第7章研究议程完整列表（共 {len(m6_topic_list)} 项）\n"
                f"⚠️ 第5段必须逐一列出以下全部 {len(m6_topic_list)} 项，每项用标题+1-2句价值描述展开，不得遗漏：\n"
                + "\n".join(topic_lines)
            )

        # 构建 M4 科学矛盾强调提示
        m4_emphasis = ""
        if m4_contradiction_list:
            m4_emphasis = (
                f"\n\n## 【第3段专用】第5章科学矛盾完整列表（共 {len(m4_contradiction_list)} 项）\n"
                f"⚠️ 第3段必须逐一列出以下全部 {len(m4_contradiction_list)} 项矛盾，不得遗漏任何一项：\n"
                + "\n".join(f"- {c}" for c in m4_contradiction_list)
            )

        return f"""你是一位世界级的循证医学研究战略专家。请基于以下全部分析结果，撰写一份高度浓缩的摘要。

## 重要背景
- 当前年份：{datetime.now().year}年（请以此为准，{datetime.now().year-1}-{datetime.now().year}年的文献属于最新文献）

## 研究主题
{query_context}

## 证据基础
- 系统检索并分析了{stats['total_papers']}篇相关文献（{datetime.now().year - 4}-{datetime.now().year}）
- 临床研究占比: {stats['clinical_ratio']:.1%}
- 研究设计分布: {json.dumps(stats['design_distribution'], ensure_ascii=False)}

## 各模块核心发现
{chr(10).join(module_summaries[:6])}

## 关键洞察
{chr(10).join(f'- {i}' for i in all_insights) if all_insights else '暂无'}

---
**以下三个列表分别是第3、4、5段的唯一数据来源，必须逐一照搬，不得改写、合并或省略：**
{m4_emphasis}
{m5_emphasis}
{m6_emphasis}
---

## 撰写要求
1. 分为5个段落，所有段落均为连贯叙述文字，风格与第1、2段保持一致，禁止使用编号列表或条目式格式：
   - 第1段：研究背景与领域定位（该领域处于什么发展阶段，核心科学问题是什么）
   - 第2段：证据体系评估（证据链完整度、关键断裂点、方法学特征）
   - 第3段：核心科学矛盾——先用1句话概括该领域矛盾的整体特征，再将上方"第5章科学矛盾"中的全部 {len(m4_contradiction_list)} 项标题自然嵌入叙述句中（如"具体表现为：XXX、YYY、ZZZ"），最后1句说明这些矛盾对研究的启示，不得遗漏任何一项
   - 第4段：跨领域突破机会——先用1句话说明该领域突破机会的整体方向，再将上方"第6章突破机会"中的全部 {len(m5_opportunity_list)} 项标题自然嵌入叙述中，每个标题后跟1句核心创新点说明，整段连贯成文，不得遗漏任何一项
   - 第5段：研究议程与价值——先用1句话引出研究议程的整体布局，再将上方"第7章研究议程"中的全部 {len(m6_topic_list)} 项选题标题自然嵌入叙述中，每个标题后跟1句研究设计亮点，最后1句总结整体预期价值，整段连贯成文，不得遗漏任何一项
2. 语言专业、简洁有力，体现循证医学的严谨性，段落内部流畅连贯，读起来像专家撰写的综述摘要
3. 每个关键结论都要有数据支撑（文献数量、比例等）
4. 不要生成「{query_context}摘要」或「{query_context}研究战略摘要」之类的副标题，直接输出正文段落
5. 第3、4、5段的矛盾、突破机会、研究选题，必须且只能来自上方对应的强调列表，绝对不得从"各模块核心发现"的deep_analysis中自行提炼或改写
6. 直接输出Markdown正文，绝对不得在输出中包含任何指令性语句，如"与正文保持一致"、"与第X章一致"、"用【数字】标注"、"描述与正文完全一致"等，这些是内部约束，不得出现在最终输出中"""

    async def _generate_executive_summary(
        self,
        query_context: str,
        materials: Dict[str, Any],
        evidence_stats: EvidenceStats
    ) -> str:
        """生成执行摘要 - 浓缩所有模块的核心发现"""
        logger.info(f"[报告生成-摘要] 开始生成执行摘要")
        all_insights = materials["all_key_insights"][:20]
        stats = materials["evidence_stats_summary"]
        logger.info(f"[报告生成-摘要] 关键洞察数: {len(all_insights)}")

        # Release summaries are assembled from structured module outputs.  The
        # analytical chapters still use the LLM, but the summary must never be
        # truncated mid-list or turn a speculative opportunity into an
        # established mechanism.
        module_data = materials.get("module_data", {})
        design_text = "、".join(
            f"{name}{count}篇" for name, count in stats.get("design_distribution", {}).items()
        ) or "未分类"
        p1 = (
            f"本报告围绕「{query_context}」对{stats['total_papers']}篇筛选文献进行探索性循证分析。"
            "它用于识别可验证的研究缺口，不是覆盖全部文献的系统综述或临床结论。"
        )
        p2 = (
            f"样本中的研究设计分布为：{design_text}；系统计算的临床研究占比为"
            f"{stats['clinical_ratio']:.1%}。所有比例只描述本次筛选样本，不外推为领域总体发文结构。"
        )
        contradictions = module_data.get("M4_SCIENTIFIC_CONTRADICTION", {}).get("key_insights", [])
        p3 = (
            "在当前样本中识别的待核验科学矛盾包括："
            + ("；".join(str(x) for x in contradictions) if contradictions else "未产生可发布矛盾")
            + "。这些条目是后续研究的问题清单，不代表已证实的因果关系。"
        )
        opportunities = module_data.get("M5_BREAKTHROUGH_OPPORTUNITY", {}).get("raw_opportunities", [])
        opportunity_bits = []
        for item in opportunities:
            if not isinstance(item, dict):
                continue
            pmids = ",".join(item.get("evidence_pmids", [])) or "N/A"
            opportunity_bits.append(
                f"{item.get('title', '未命名机会')}（{item.get('support_level', 'indirect')}；PMID {pmids}）"
            )
        p4 = (
            "通过证据绑定后保留的突破机会为："
            + ("；".join(opportunity_bits) if opportunity_bits else "无；未获得可核对PMID的候选不予发布")
            + "。间接或推测性机会需经独立检索和预实验确认。"
        )
        topics = module_data.get("M6_RESEARCH_AGENDA", {}).get("raw_topics", [])
        p5 = (
            "对应的研究议程包括："
            + ("；".join(str(item.get("title")) for item in topics if isinstance(item, dict) and item.get("title"))
               if topics else "无通过证据映射的可发布选题")
            + "。每个选题的来源机会、支持层级和PMID必须在详细章节中可追溯。"
        )
        summary = "\n\n".join((p1, p2, p3, p4, p5))
        logger.info(f"[报告生成-摘要] 结构化执行摘要生成完成，长度: {len(summary)} 字符")

        return f"""# 摘要

{summary}

---
"""

    @staticmethod
    def _drop_incomplete_trailing_fragments(text: str) -> tuple[str, int]:
        """Drop only a trailing fragment after an otherwise complete prose sentence."""
        import re

        blocks = re.split(r'(\n\s*\n+)', str(text or ''))
        repaired = 0
        terminal = '.!?。！？;；:：]】)）》」”\'"'
        sentence_end = '.!?。！？'
        for index in range(0, len(blocks), 2):
            paragraph = blocks[index]
            stripped = paragraph.strip()
            if (
                len(stripped) < 40
                or stripped.startswith(('#', '-', '* ', '|', '```'))
                or stripped[-1] in terminal
            ):
                continue
            boundary = max(stripped.rfind(mark) for mark in sentence_end)
            if boundary < 20:
                continue
            leading = paragraph[:len(paragraph) - len(paragraph.lstrip())]
            blocks[index] = leading + stripped[:boundary + 1]
            repaired += 1
        return ''.join(blocks), repaired

    # ==================== 综合结论 ====================

    def _build_conclusion_prompt(
        self,
        query_context: str,
        materials: Dict[str, Any],
        evidence_stats: EvidenceStats,
        chapter_num: int = 8
    ) -> str:
        """构建综合结论Prompt（供非流式和流式共用）"""
        current_year = datetime.now().year
        insights = materials["all_key_insights"][:10]
        stats = materials["evidence_stats_summary"]
        return f"""你是一位世界级的循证医学研究战略专家。请为科研选题分析报告撰写综合结论。

## 重要背景
- 当前年份：{current_year}年（请以此为准评估文献时效性，{current_year-1}-{current_year}年的文献属于最新文献，不应被视为异常）

## 研究主题
{query_context}

## 关键发现汇总
{chr(10).join(f'- {i}' for i in insights) if insights else '暂无'}

## 证据基础
- 文献总量: {stats['total_papers']}篇
- 时间跨度: 2022-2026

## 撰写要求
1. 用1-2段文字（共200-300字）对上述六个维度的分析进行高度凝练的总结
2. 突出该领域最核心的科学矛盾与最有价值的研究机会
3. 语言精炼、逻辑严谨，避免重复正文中已有的具体细节
4. 禁止输出任何小节标题、行动建议或路线图——只需纯段落总结
5. 禁止在输出开头生成任何形式的报告大标题，直接从正文内容开始
6. 必须使用中文输出"""

    async def _generate_conclusion(
        self,
        query_context: str,
        materials: Dict[str, Any],
        evidence_stats: EvidenceStats,
        chapter_num: int = 8
    ) -> str:
        """Assemble the release conclusion from validated structured outputs."""
        logger.info("[报告生成-结论] 从结构化证据映射生成综合结论")
        stats = materials["evidence_stats_summary"]
        module_data = materials.get("module_data", {})
        contradictions = module_data.get("M4_SCIENTIFIC_CONTRADICTION", {}).get("key_insights", [])
        opportunities = module_data.get("M5_BREAKTHROUGH_OPPORTUNITY", {}).get("raw_opportunities", [])
        topics = module_data.get("M6_RESEARCH_AGENDA", {}).get("raw_topics", [])

        contradiction_text = (
            "；".join(str(item) for item in contradictions)
            if contradictions else
            "未有同时绑定冲突双方PMID的候选矛盾通过发布门禁"
        )
        opportunity_text = "；".join(
            f"{item.get('title', '未命名机会')}"
            f"（{item.get('support_level', 'indirect')}；PMID "
            f"{','.join(item.get('evidence_pmids', [])) or 'N/A'}）"
            for item in opportunities if isinstance(item, dict)
        ) or "无通过PMID绑定的候选机会"
        topic_text = "；".join(
            f"{item.get('title')}（来源{item.get('source_opportunity_id', 'N/A')}）"
            for item in topics if isinstance(item, dict) and item.get("title")
        ) or "无通过机会映射的研究选题"

        conclusion = (
            f"本次围绕「{query_context}」筛选{stats['total_papers']}条证据记录，"
            f"时间范围为{stats['earliest_year']}—{stats['latest_year']}年，"
            f"系统分类的临床研究占比为{stats['clinical_ratio']:.1%}。"
            "这些统计仅描述本次检索和相关性门禁后的样本，不代表领域全部发文或完成了系统综述。"
            f"待复核证据冲突为：{contradiction_text}。\n\n"
            f"通过真实PMID绑定保留的研究机会为：{opportunity_text}。"
            f"对应的规划性选题为：{topic_text}。"
            "direct只表示文献标题或摘要直接覆盖核心方法概念，indirect表示仅支持相邻方法，"
            "speculative表示存在证据摘要未覆盖的关键构件。所有假说、样本量、终点、期刊和时间表都是待专家、先导数据、"
            "可用资源与伦理条件共同校准的研究规划，不是已证实的临床结论。"
        )

        return f"""## {chapter_num}. 综合结论

{conclusion}{self._render_limitations()}

---
"""

    # ==================== Step 5: 参考文献 ====================

    def _render_references(self, citation_pool: OrderedDict) -> str:
        """生成Vancouver格式参考文献列表"""
        if not citation_pool:
            return "## 参考文献\n\n暂无参考文献。\n"

        section = "## 参考文献\n\n"

        for _, info in citation_pool.items():
            ref_num = info["ref_num"]
            authors = info["authors"]

            # Vancouver格式
            if authors:
                authors_str = ", ".join(authors[:6])
                if len(authors) > 6:
                    authors_str += ", et al"
            else:
                authors_str = "Unknown authors"

            title = info["title"]
            journal = info["journal"] or "Unknown Journal"
            year = info["year"]
            doi = info.get("doi", "")

            ref_line = f"[{ref_num}] {authors_str}. {title}. *{journal}*. {year}."
            if doi:
                ref_line += f" DOI: {doi}."
            if info.get("pmid"):
                ref_line += f" PMID: {info['pmid']}."

            section += f"{ref_line}\n\n"

        return section

    # ==================== Step 6: 图表索引 ====================

    def _render_methodology(self, evidence_stats: EvidenceStats, query_context: str, pico_elements=None, module_outputs: Dict = None) -> str:
        """生成第1章：研究方法（固定结构章节）"""
        design_types = list(evidence_stats.design_distribution.keys())[:4]
        design_str = "、".join(design_types) if design_types else "未分类"
        year_range = f"{datetime.now().year - 4}—{datetime.now().year}"

        # 根据实际 PICO 要素动态生成检索策略描述
        pico = pico_elements
        active_elements = []
        if pico:
            if getattr(pico, 'population', None):
                active_elements.append("P（研究人群/疾病）")
            if getattr(pico, 'intervention', None):
                active_elements.append("I（干预/暴露）")
            if getattr(pico, 'comparison', None):
                active_elements.append("C（对照）")
            if getattr(pico, 'outcome', None):
                active_elements.append("O（结局）")

        n = len(active_elements)
        if n >= 3:
            query_strategy_desc = (
                f"生成多个不同精度层级的并行子查询，涵盖精准组合检索（{'·AND·'.join([e[0] for e in active_elements])}）、"
                f"核心双词检索（{active_elements[0][0]}·AND·{active_elements[1][0]}）、MeSH 主题词检索，"
                f"以及针对各要素的宽泛单词检索"
            )
        elif n == 2:
            query_strategy_desc = (
                f"生成多个不同精度层级的并行子查询，涵盖双词组合检索（{active_elements[0][0]}·AND·{active_elements[1][0]}）、"
                f"MeSH 主题词检索，以及针对各要素的宽泛单词检索"
            )
        else:
            # 只有单个要素或无 PICO 信息
            elem_desc = active_elements[0] if active_elements else "核心主题词"
            query_strategy_desc = (
                f"围绕{elem_desc}展开检索，涵盖 MeSH 标准主题词、同义词扩展及自由词检索，"
                f"生成多个精度层级的并行子查询"
            )

        return f"""## 1. 研究方法

### 1.1 检索策略

本报告并行使用 EviMed 内部文献索引与 PubMed 标准元数据，围绕研究主题「{query_context}」开展结构化文献检索。检索采用大语言模型（LLM）驱动的 PICO 框架（Population、Intervention、Comparison、Outcome）自动提取核心实体，结合 MeSH 标准主题词与自由词同义词扩展，{query_strategy_desc}。各子查询独立执行，时间范围限定为近5年（{year_range}），每条子查询最多获取 **300 篇**文献；多源结果按 PMID、DOI 或规范化题名去重。最终纳入分析的文献共 **{evidence_stats.evidence_count} 篇**，涵盖{design_str}，共 {len(evidence_stats.design_distribution)} 种研究设计类型。

> ⚠️ **检索范围说明**：本报告基于上述筛选后的 {evidence_stats.evidence_count} 篇文献生成，属于对该领域的抽样分析，**并非覆盖全部相关文献的系统综述**。报告中各类统计图表（发文趋势、研究设计分布、热点分布等）所呈现的数值与比例，均以本次检索所得文献为计算基准，可能低于该领域实际总发文量。读者在引用具体数字时，应结合其他来源数据综合判断。

### 1.2 纳入与排除标准

**纳入标准**：

- 与研究主题直接相关，可从标题/摘要中提取有效科学信息的同行评审文献
- 发表时间限定为近5年（{year_range}），具备可追溯 PMID 或 DOI 且摘要完整
- 覆盖所有相关研究设计类型（含基础研究、临床研究、综述等）

**排除标准**：

- 摘要缺失或信息极度不完整，无法判断研究内容的文献
- 经相关性评估后与研究主题无实质关联的文献
- 重复发表（同一 PMID 多次出现时保留首次命中的记录）
- 当年度（{datetime.now().year}年）尚未完整收录，发文量可能低于全年实际数量

**说明**：本次检索未设置语言限制，但 PubMed 收录文献以英文为主，中文文献覆盖有限；未检索灰色文献、预印本平台（如 bioRxiv）及会议摘要。

### 1.3 分析框架

本报告采用六维度循证分析框架，从多角度系统评估领域研究现状与选题机会：

| 章节 | 分析维度 | 核心目标 |
|------|----------|----------|
| 第2章 | 研究问题结构与领域全景 | 识别科学张力，构建研究问题空间树 |
| 第3章 | 研究生态与知识结构 | 分析发文趋势、热点分布与知识网络 |
| 第4章 | 证据体系结构诊断 | 评估证据金字塔分布与方法学格局 |
| 第5章 | 科学矛盾与知识断裂点 | 定位领域内核心矛盾与争议焦点 |
| 第6章 | 跨领域突破机会挖掘 | 发现跨学科融合与技术迁移机会 |
| 第7章 | 研究议程与选题生成 | 产出优先级排序的具体研究方向 |

### 1.4 计算方法

本报告各章节量化指标均由大语言模型（LLM）基于逐篇文献证据自动评分，评分过程依据预设的分级标准（rubric）进行。

#### 1.4.1 科学矛盾强度评分（intensity，第5章）

LLM 对每组科学矛盾依据以下分级标准赋予 0–1 分值，该得分决定了**第5章科学矛盾强度图**中各矛盾的横条长度与颜色深浅：

| 分值区间 | 等级 | 判定依据 |
|---------|------|---------|
| 0.8 – 1.0 | 强烈冲突 | 大量直接对照证据互相矛盾，临床影响显著，且两方均有高质量文献支撑 |
| 0.5 – 0.8 | 明确冲突 | 存在明确证据冲突，但结论存在解释空间（如研究人群或方法差异可部分解释分歧） |
| 0.2 – 0.5 | 间接冲突 | 证据量有限或冲突为间接推断，尚无直接对照研究 |
| 0.0 – 0.2 | 弱冲突 | 仅理论层面的张力，缺乏实证支撑 |

#### 1.4.2 优先级综合评分（第6–7章）

突破机会与研究选题的优先级得分由 LLM 综合以下三个维度评估，各维度均以 0–1 计分，综合后取值同为 0–1。{self._build_priority_chart_desc(module_outputs)}

| 子维度 | 评分要点 |
|-------|---------|
| 科学创新性 | 是否填补知识空白、引入新机制或新范式 |
| 临床转化价值 | 结果是否可直接或间接改善患者预后、影响指南 |
| 研究可行性 | 样本量可及性、技术平台获取难度、伦理与资助壁垒 |

> 注：LLM 不使用固定权重公式，而是基于当前领域实际情境对三个维度进行语境感知加权，属于专家判断型评分（expert-in-the-loop scoring），与传统数值公式有本质区别。

---
"""

    def _build_priority_chart_desc(self, module_outputs: Dict = None) -> str:
        """根据实际生成的图表动态描述 1.4.2 优先级得分的可视化位置"""
        if not module_outputs:
            return "该得分体现为各章节图表中的颜色深浅——颜色越深表示综合优先级越高。"

        import os
        m5_has_chart = any(
            os.path.exists(c.path)
            for c in module_outputs.get("M5_BREAKTHROUGH_OPPORTUNITY", ModuleOutput(module_id="", status="")).charts
        ) if "M5_BREAKTHROUGH_OPPORTUNITY" in module_outputs else False

        m6_has_chart = any(
            os.path.exists(c.path)
            for c in module_outputs.get("M6_RESEARCH_AGENDA", ModuleOutput(module_id="", status="")).charts
        ) if "M6_RESEARCH_AGENDA" in module_outputs else False

        parts = []
        if m5_has_chart:
            parts.append("**第6章突破机会气泡图**中体现为气泡颜色深浅")
        if m6_has_chart:
            parts.append("**第7章推荐选题散点图**中体现为散点颜色深浅")

        if parts:
            return "该得分在" + "，在".join(parts) + "——颜色越深表示综合优先级越高。"
        else:
            return "该得分供各章节分析时参考排序，本次检索数据量有限，相关可视化图表未生成。"

    def _render_limitations(self) -> str:
        """生成局限性说明段落（置于综合结论末尾）"""
        return (
            f"\n\n**研究局限性**：本报告由人工智能辅助生成，检索范围限于 EviMed 文献索引与 PubMed 公开数据，"
            f"未涵盖灰色文献及会议摘要。当前年份（{datetime.now().year}年）数据仅统计至检索时间点，"
            f"发文量可能低于全年实际数量。证据质量评估基于研究设计类型分类，未进行逐篇偏倚风险系统评价。"
            f"本报告分析结论供科研选题参考，建议结合所在领域专家意见综合判断。"
        )

    def _render_chart_index(self, module_outputs: Dict[str, ModuleOutput]) -> Optional[str]:
        """生成图表索引（与正文章节式编号一致）"""
        import os
        # MODULE_ORDER 对应章节从第2章开始
        chapter_start = 2
        all_charts = []
        for chapter_offset, module_id in enumerate(self.MODULE_ORDER):
            chapter_num = chapter_start + chapter_offset
            if module_id in module_outputs:
                for chart_idx, chart in enumerate(module_outputs[module_id].charts, 1):
                    if chart.path and os.path.exists(chart.path):
                        all_charts.append((f"图{chapter_num}.{chart_idx}", chart, self.MODULE_NAMES.get(module_id, module_id)))

        if not all_charts:
            return None

        section = "## 图表索引\n\n"
        section += "| 图号 | 标题 | 类型 | 所属章节 |\n"
        section += "|------|------|------|----------|\n"
        for fig_label, chart, module_name in all_charts:
            section += f"| {fig_label} | {chart.title} | {chart.chart_type} | {module_name} |\n"

        return section

    def _render_charts_inline(self, charts, chapter_num: int = 0) -> str:
        """将图表列表渲染为内嵌base64 PNG的markdown（用于最终报告正文）"""
        import os
        import base64 as _b64
        parts = []
        for i, chart in enumerate(charts, 1):
            try:
                if chart.path and os.path.exists(chart.path):
                    with open(chart.path, "rb") as f:
                        img_b64 = _b64.b64encode(f.read()).decode()
                    fig_label = f"图{chapter_num}.{i}" if chapter_num else f"图{i}"
                    # 图标题放在图下方（学术规范：图注在图下）
                    parts.append(f"![{chart.title}](data:image/png;base64,{img_b64})\n\n**{fig_label}: {chart.title}**")
                    if chart.description:
                        parts.append(f"*{chart.description}*")
            except Exception as e:
                logger.warning(f"报告图表读取失败: {chart.path}, {e}")
        return "\n\n".join(parts)

    # ==================== 辅助方法 ====================

    def _build_query_context(self, standardized_input: StandardizedInput, input_text: str) -> str:
        """构建查询上下文描述"""
        parts = []

        pico = standardized_input.pico_elements
        if pico.population:
            parts.append(f"人群/疾病: {pico.population}")
        if pico.intervention:
            parts.append(f"干预/暴露: {pico.intervention}")
        if pico.comparison:
            parts.append(f"对照: {pico.comparison}")
        if pico.outcome:
            parts.append(f"结局: {pico.outcome}")

        if parts:
            return f"{input_text}（{'; '.join(parts)}）"

        terms = standardized_input.query_terms.en + standardized_input.query_terms.zh
        if terms:
            return f"{input_text}（关键词: {', '.join(terms[:5])}）"

        return input_text

    def _generate_title(self, query_context: str, standardized_input: StandardizedInput) -> str:
        """生成报告标题"""
        core = standardized_input.core_entities
        keywords = []

        if core.diseases:
            keywords.append(core.diseases[0])
        if core.drugs or core.interventions:
            interventions = list(dict.fromkeys(core.drugs or core.interventions))
            keywords.append(" / ".join(interventions[:2]))

        if keywords:
            return f"「{' × '.join(keywords)}」科研选题循证分析报告"

        return f"「{query_context[:30]}」科研选题循证分析报告"

    def _render_cover(self, title: str, evidence_stats: EvidenceStats, query_context: str, module_outputs: Dict = None) -> str:
        """渲染报告封面"""
        now = datetime.now().strftime("%Y年%m月%d日")
        cover = f"""# {title}

**生成日期**: {now}

**分析范围**: {query_context}

**证据基础**: 系统检索并分析 **{evidence_stats.evidence_count}** 篇相关文献（{evidence_stats.earliest_year}-{evidence_stats.latest_year}），涵盖 {len(evidence_stats.design_distribution)} 种研究设计类型

**分析方法**: 基于循证医学框架，通过PICO结构化检索、多维度证据评估、研究生态分析、科学矛盾识别、跨领域机会挖掘等6大分析模块，系统性评估该领域的研究现状与选题机会

---
"""
        if not module_outputs:
            return cover

        # 封面不再内嵌图表，图表统一在正文各章节渲染，避免重复和编号混乱
        return cover


# 全局报告生成器实例
report_generator = ReportGenerator()
