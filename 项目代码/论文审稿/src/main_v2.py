"""
Main Review Orchestrator V2 - Multi-Rubric Parallel Architecture

新架构：
1. 并行调用4个最相关的审稿规范
2. MetaReviewer 融合多规范结果
3. NarrativeGenerator 生成自然语言报告
"""
import asyncio
import uuid
import time
from typing import Tuple
from pathlib import Path

from .schemas.review_state import ReviewState, JobStatus
from .schemas.meta_review import MultiRubricReviewResult, ConsolidatedIssue
from .services.document_parser import DocumentParser
from .services.llm_gateway import LLMGateway, LLMProvider
from .agents.document_analyzer import DocumentAnalyzerAgent
from .agents.cognitive_reviewer import CognitiveReviewerAgent
from .agents.rubric_selector import RubricSelectorAgent
from .orchestrators.multi_rubric_orchestrator import MultiRubricOrchestrator
from .agents.meta_reviewer import MetaReviewerAgent
from .agents.narrative_generator import NarrativeReportGenerator
from .agents.statistical_reviewer import StatisticalDeepReviewAgent

from dotenv import load_dotenv
load_dotenv()


class ReviewOrchestratorV2:
    """多规范并行审稿编排器"""

    def __init__(self, llm_api_key: str = None, llm_provider: str = "deepseek"):
        provider = LLMProvider.DEEPSEEK
        self.llm_gateway = LLMGateway(provider=provider, api_key=llm_api_key)
        self.document_parser = DocumentParser(use_marker=False)  # 禁用 marker，使用 pypdf 轻量解析

        # 新架构组件
        self.document_analyzer = DocumentAnalyzerAgent(self.llm_gateway)
        self.multi_rubric_orchestrator = MultiRubricOrchestrator(self.llm_gateway)
        self.rubric_selector = RubricSelectorAgent(self.llm_gateway)
        self.cognitive_reviewer = CognitiveReviewerAgent(self.llm_gateway)
        self.meta_reviewer = MetaReviewerAgent(self.llm_gateway)
        self.statistical_reviewer = StatisticalDeepReviewAgent(self.llm_gateway)
        self.narrative_generator = NarrativeReportGenerator(self.llm_gateway)

    async def review_manuscript(
        self,
        manuscript_path: str,
        job_id: str = None,
        is_review_article: bool = True
    ) -> MultiRubricReviewResult:
        """执行多规范并行审稿"""
        if job_id is None:
            job_id = str(uuid.uuid4())

        start_time = time.time()

        try:
            print(f"\n{'='*60}")
            print(f"[{job_id}] 多规范并行审稿流程")
            print(f"{'='*60}\n")

            # Stage 1: 解析文档
            print(f"[{job_id}] 阶段 1/5: 解析文档...")
            manuscript_text, parse_metadata = self.document_parser.parse(manuscript_path)
            print(f"  → 解析方法: {parse_metadata.get('parse_method', 'unknown')}")

            # Stage 2: 分析文档结构
            print(f"[{job_id}] 阶段 2/5: 分析文档结构...")
            document_ir, study_profile, evidence_map, coverage_summary = await self.document_analyzer.analyze(
                manuscript_text,
                parse_metadata=parse_metadata
            )
            print(f"  → 研究类型: {', '.join(study_profile.study_types)}")
            print(f"  → 覆盖率: {coverage_summary.section_coverage_percentage:.1f}%")

            # Stage 2b: LLM 智能规范选择
            print(f"[{job_id}] 阶段 2b: 智能选择审稿规范...")
            selected_rubrics = await self.rubric_selector.select(
                document_ir=document_ir,
                study_profile=study_profile
            )

            # Stage 3: 并行多规范审稿
            print(f"[{job_id}] 阶段 3/5: 并行多规范审查...")
            multi_rubric_results = await self.multi_rubric_orchestrator.review_with_multiple_rubrics(
                document_ir=document_ir,
                study_profile=study_profile,
                pre_selected_rubrics=selected_rubrics
            )
            print(f"  → 已使用 {len(multi_rubric_results)} 个规范审查")
            _rubric_fail_total = sum(
                1 for blocks in multi_rubric_results.values() for block in blocks
                for item in block.results
                if (item.verdict.value if hasattr(item.verdict, "value") else str(item.verdict)) in ["FAIL", "PARTIAL"]
            )
            print(f"  → [问题追踪] Stage3 多规范审稿 FAIL+PARTIAL 条目数: {_rubric_fail_total}")

            # Stage 4: 认知审查
            print(f"[{job_id}] 阶段 4/5: 认知审查...")
            rubric_summary = self._summarize_rubric_results(multi_rubric_results)
            cognitive_result = await self.cognitive_reviewer.review(
                document_ir=document_ir,
                rubric_summary=rubric_summary,
                language="zh"
            )
            print(f"  → 新颖性: {cognitive_result.novelty_score}/10")
            print(f"  → 推荐: {cognitive_result.overall_recommendation}")

            # Stage 5: Meta融合 + 自然语言生成
            print(f"[{job_id}] 阶段 5/5: Meta融合与自然语言生成...")
            meta_review = await self.meta_reviewer.synthesize_multi_rubric_results(
                document_ir=document_ir,
                multi_rubric_results=multi_rubric_results,
                cognitive_result=cognitive_result,
                study_profile=study_profile
            )
            print(f"  → 致命问题: {len(meta_review.fatal_issues)}")
            print(f"  → 主要问题: {len(meta_review.major_issues)}")
            print(f"  → [问题追踪] Stage5 Meta融合后: fatal={len(meta_review.fatal_issues)}, major={len(meta_review.major_issues)}, minor={len(meta_review.minor_issues)}, 总计={len(meta_review.fatal_issues)+len(meta_review.major_issues)+len(meta_review.minor_issues)}")

            # Stage 5b: 方案B — 注入 PARTIAL 条目（LLM过滤后仍未进入报告的"有但不足"问题）
            partial_issues = self._collect_partial_issues(multi_rubric_results, meta_review)
            if partial_issues:
                meta_review.minor_issues.extend(partial_issues)
                print(f"  → 注入 PARTIAL 补充条目: {len(partial_issues)} 条")
            print(f"  → [问题追踪] PARTIAL注入后: fatal={len(meta_review.fatal_issues)}, major={len(meta_review.major_issues)}, minor={len(meta_review.minor_issues)}, 总计={len(meta_review.fatal_issues)+len(meta_review.major_issues)+len(meta_review.minor_issues)}")

            # Stage 5c: 方案C — 统计精查
            print(f"[{job_id}] 阶段 5c: 统计方法精查...")
            stat_issues = await self.statistical_reviewer.review(document_ir)
            if stat_issues:
                # major 级别的统计问题加入 major_issues，minor 的加入 minor_issues
                for si in stat_issues:
                    if si.severity == "major":
                        meta_review.major_issues.append(si)
                    else:
                        meta_review.minor_issues.append(si)
                print(f"  → 统计精查追加问题: {len(stat_issues)} 条")
            print(f"  → [问题追踪] 统计精查后(送入NarrativeGen前): fatal={len(meta_review.fatal_issues)}, major={len(meta_review.major_issues)}, minor={len(meta_review.minor_issues)}, 总计={len(meta_review.fatal_issues)+len(meta_review.major_issues)+len(meta_review.minor_issues)}")

            narrative_report = await self.narrative_generator.generate_narrative_report(
                document_ir=document_ir,
                meta_review=meta_review,
                cognitive_result=cognitive_result,
                technical_appendix={"rubric_results": multi_rubric_results}
            )

            processing_time = time.time() - start_time
            print(f"\n{'='*60}")
            print(f"[{job_id}] 审稿完成，耗时 {processing_time:.1f}秒")
            print(f"{'='*60}\n")

            return MultiRubricReviewResult(
                document_title=document_ir.title or "未知标题",
                rubric_results=multi_rubric_results,
                meta_review=meta_review,
                narrative_report=narrative_report,
                rubrics_used=list(multi_rubric_results.keys()),
                processing_time=processing_time
            )

        except Exception as error:
            print(f"[{job_id}] 审稿失败: {error}")
            raise RuntimeError(f"Peer-review pipeline failed for job {job_id}") from error

    def _collect_partial_issues(self, multi_rubric_results, meta_review) -> list:
        """
        方案B：从 rubric 结果中收集 PARTIAL 条目，剔除已被 MetaReview 覆盖的问题，
        剩余的直接转为 ConsolidatedIssue 追加到 minor_issues。
        这是 MetaReview LLM 过滤的安全网，保证"有但不足"的问题不会被遗漏。
        """
        # 收集已存在问题的 item_id 集合（避免重复）
        existing_item_ids = set()
        for issue in meta_review.fatal_issues + meta_review.major_issues + meta_review.minor_issues:
            for sid in issue.source_items:
                existing_item_ids.add(sid.lower())

        partial_issues = []
        seen_item_ids = set()

        for rubric_name, blocks in multi_rubric_results.items():
            for block in blocks:
                for item in block.results:
                    verdict = item.verdict.value if hasattr(item.verdict, "value") else str(item.verdict)
                    if verdict != "PARTIAL":
                        continue
                    item_id_lower = item.item_id.lower()
                    # 跳过已覆盖或已重复
                    if item_id_lower in existing_item_ids or item_id_lower in seen_item_ids:
                        continue
                    seen_item_ids.add(item_id_lower)

                    missing  = getattr(item, "missing_detail", "") or ""
                    fix      = getattr(item, "actionable_fix",  "") or ""
                    question = getattr(item, "question", item.item_id)
                    description = (
                        f"原文对此项有所涉及，但内容不够完整或不符合规范要求。"
                        f"{missing} {fix}".strip()
                    )
                    if len(description) < 20:
                        continue

                    evidence_locs = getattr(item, "evidence_location", None) or []
                    partial_issues.append(ConsolidatedIssue(
                        issue_type=f"partial_{item.item_id}",
                        title=f"{question[:30]}（不完整）" if len(question) > 30 else f"{question}（不完整）",
                        description=description,
                        severity="minor",
                        source_rubrics=[rubric_name],
                        source_items=[item.item_id],
                        standard_reference=getattr(item, "standard_reference", "") or rubric_name,
                        location_in_paper=", ".join(evidence_locs[:2]) if evidence_locs else "相关章节",
                        confidence=0.7
                    ))

        return partial_issues

    def _summarize_rubric_results(self, multi_rubric_results):
        """汇总多规范结果"""
        total_items = 0
        fail_count = 0
        for rubric_name, blocks in multi_rubric_results.items():
            for block in blocks:
                for item in block.results:
                    total_items += 1
                    verdict = item.verdict.value if hasattr(item.verdict, "value") else str(item.verdict)
                    if verdict == "FAIL":
                        fail_count += 1

        return {
            "total_items": total_items,
            "fail_count": fail_count,
            "pass_count": total_items - fail_count,
            "critical_issues": 0,
            "major_issues": fail_count
        }
