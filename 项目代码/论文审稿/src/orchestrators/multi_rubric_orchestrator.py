"""
Multi-Rubric Orchestrator - 并行调用多个审稿规范
"""
import asyncio
from typing import List, Dict
from ..schemas.document_ir import DocumentIR, StudyProfile, EvidenceMap
from ..schemas.rubric import BlockReviewResult, RubricBlock
from ..utils.rubric_loader import RubricLoader
from ..agents.methodology_reviewer import MethodologyReviewerAgent
from ..services.llm_gateway import LLMGateway


class MultiRubricOrchestrator:
    """并行调用最多4个最相关的审稿规范"""

    # 规范优先级映射（与 src/rubrics/ 目录中实际存在的文件对齐）
    RUBRIC_PRIORITY: Dict[str, List[str]] = {
        # 系统综述 / Meta分析 / Scoping Review / 方案
        "Systematic Review":              ["prisma_2020", "universal_rubric"],
        "Meta-Analysis":                  ["prisma_2020", "universal_rubric"],
        "Scoping Review":                 ["prisma_scr", "universal_rubric"],
        "Protocol":                       ["prisma_2020", "universal_rubric"],
        "Protocol for Clinical Practice Guideline": ["prisma_2020", "grade", "universal_rubric"],
        # 随机对照试验
        "RCT":                            ["consort_2010", "universal_rubric"],
        "Cluster RCT":                    ["consort_2010", "universal_rubric"],
        # 观察性研究
        "Cohort Study":                   ["strobe", "universal_rubric"],
        "Case-Control Study":             ["strobe", "universal_rubric"],
        "Cross-Sectional Study":          ["strobe", "universal_rubric"],
        # 诊断研究
        "Diagnostic Study":               ["stard", "universal_rubric"],
        # 预测模型 / AI / 机器学习
        "Prognostic Model":               ["tripod_ai", "universal_rubric"],
        "AI":                             ["tripod_ai", "universal_rubric"],
        "Machine Learning":               ["tripod_ai", "universal_rubric"],
        # 指南
        "Guideline Development":          ["grade", "prisma_2020", "universal_rubric"],
        "Clinical Practice Guideline":    ["grade", "universal_rubric"],
        # 病例报告
        "Case Report":                    ["care", "universal_rubric"],
        # 卫生经济学
        "Economic Evaluation":            ["cheers_2022", "universal_rubric"],
        # 定性研究
        "Qualitative Research":           ["coreq", "universal_rubric"],
        # 动物研究
        "Animal Study":                   ["arrive", "universal_rubric"],
        # 新增类型
        "Narrative Review":               ["universal_rubric"],
        "Literature Review":              ["universal_rubric"],
        "Rapid Review":                   ["universal_rubric"],
        "Umbrella Review":                ["prisma_2020", "universal_rubric"],
        "Methodology Paper":              ["universal_rubric", "tripod_ai"],
        "Framework Paper":                ["universal_rubric", "tripod_ai"],
        "Benchmark Paper":                ["universal_rubric"],
        "Mixed Methods":                  ["coreq", "universal_rubric"],
        "Quality Improvement":            ["universal_rubric"],
        # 文献计量/横断面分析类（不使用 PRISMA-ScR）
        "Bibliometric Study":             ["universal_rubric"],
        "Bibliometric Analysis":          ["universal_rubric"],
        "Cross-Sectional Analysis":       ["strobe", "universal_rubric"],
        "Literature Analysis":            ["universal_rubric"],
        "Systematic Analysis":            ["universal_rubric"],
        "Descriptive Study":              ["strobe", "universal_rubric"],
        # 跨领域兜底：研究类型模糊时
        "Ambiguous Review":               ["prisma_2020", "prisma_scr", "universal_rubric"],
    }

    # 明确禁止对以下研究类型使用 PRISMA-ScR
    PRISMA_SCR_EXCLUDED_TYPES = {
        "Cross-Sectional Study", "Cross-Sectional Analysis",
        "Bibliometric Study", "Bibliometric Analysis",
        "Cohort Study", "Case-Control Study",
        "RCT", "Cluster RCT", "Diagnostic Study",
        "AI", "Machine Learning", "Prognostic Model",
        "Case Report", "Qualitative Research", "Animal Study",
        "Economic Evaluation", "Systematic Analysis", "Literature Analysis",
        "Descriptive Study",
        # 叙述性综述类——不强制 PRISMA-ScR 系统综述要求
        "Narrative Review", "Literature Review", "Rapid Review",
    }

    def __init__(self, llm_gateway: LLMGateway):
        self.llm = llm_gateway
        self.rubric_loader = RubricLoader()

    def _select_top_4_rubrics(self, study_types: List[str]) -> List[str]:
        """根据研究类型选择最多4个最相关的规范（模糊匹配兜底 + 宽泛触发）"""
        rubric_scores: Dict[str, float] = {}
        confidence = 1.0  # 默认高置信度

        # 检测研究类型歧义：如果同时包含多个相似类型，降低置信度
        ambiguous_keywords = [
            ("systematic", "scoping"),
            ("review", "meta-analysis"),
            ("rct", "observational"),
        ]

        study_types_lower = [st.lower() for st in study_types]
        for kw1, kw2 in ambiguous_keywords:
            if any(kw1 in st for st in study_types_lower) and any(kw2 in st for st in study_types_lower):
                confidence = 0.8  # 存在歧义，降低置信度
                break

        # 如果置信度低于0.85，标记为 Ambiguous Review
        if confidence < 0.85:
            print(f"  → 检测到研究类型歧义（置信度 {confidence:.2f}），触发宽泛并行")
            study_types = study_types + ["Ambiguous Review"]

        for study_type in study_types:
            # 精确匹配
            rubrics = self.RUBRIC_PRIORITY.get(study_type)

            # 模糊匹配：关键词包含
            if rubrics is None:
                for key, val in self.RUBRIC_PRIORITY.items():
                    if any(k.lower() in study_type.lower() or study_type.lower() in k.lower()
                           for k in key.split()):
                        rubrics = val
                        break

            # 仍未命中，用通用规范
            if rubrics is None:
                rubrics = ["universal_rubric"]

            for i, rubric in enumerate(rubrics):
                score = 10 - i
                rubric_scores[rubric] = rubric_scores.get(rubric, 0) + score

        # 确保通用规范始终包含
        if "universal_rubric" not in rubric_scores:
            rubric_scores["universal_rubric"] = 1

        # 按分数排序，取前4个
        sorted_rubrics = sorted(rubric_scores.items(), key=lambda x: x[1], reverse=True)
        selected = [r[0] for r in sorted_rubrics[:4]]

        # 【防过拟合】：如果研究类型明确不应使用 PRISMA-ScR，强制移除
        has_excluded_type = any(st in self.PRISMA_SCR_EXCLUDED_TYPES for st in study_types)
        # 只有 Scoping Review / Meta-Analysis / Systematic Review 才允许 PRISMA-ScR
        has_scoping_type = any(
            any(k in st.lower() for k in ["scoping review", "scoping_review"])
            for st in study_types
        )
        print(f"  → [Orchestrator·指纹] 研究类型={study_types} | "
              f"在排除列表={'Y' if has_excluded_type else 'N'} | "
              f"含Scoping综述={'Y' if has_scoping_type else 'N'} | "
              f"PRISMA-ScR候选={'Y' if 'prisma_scr' in selected else 'N'}")
        if has_excluded_type and not has_scoping_type and "prisma_scr" in selected:
            selected.remove("prisma_scr")
            print(f"  → [规范过滤·强制] 研究类型 {study_types} 不适用 PRISMA-ScR，已移除 Y")

        # 【叙述性综述保护】：如果包含 Narrative/Literature Review，只保留 universal_rubric
        # 其余（strobe, arrive, tripod_ai 等）均为误判产生的噪声，强制剔除
        _narrative_types = {"Narrative Review", "Literature Review", "Rapid Review"}
        has_narrative = any(st in _narrative_types for st in study_types)
        if has_narrative:
            # 仅保留 universal_rubric，剔除所有其他规范
            selected = [r for r in selected if r == "universal_rubric"]
            if "universal_rubric" not in selected:
                selected = ["universal_rubric"]
            print(f"  → [规范过滤·叙述综述] 叙述性综述仅保留 universal_rubric，剔除其他规范 Y")

        print(f"  → 选中 {len(selected)} 个规范: {selected}")
        return selected

    async def review_with_multiple_rubrics(
        self,
        document_ir: DocumentIR,
        study_profile: StudyProfile,
        pre_selected_rubrics: List[str] = None
    ) -> Dict[str, List[BlockReviewResult]]:
        """真正并行调用多个规范进行审稿"""
        try:
            if pre_selected_rubrics:
                selected_rubrics = pre_selected_rubrics
                print(f"  → 使用预选规范: {selected_rubrics}")
            else:
                selected_rubrics = self._select_top_4_rubrics(
                    study_profile.study_types or ["Unknown"]
                )

            # 使用 asyncio.gather 真正并行执行
            async def run_one(rubric_name: str):
                result = await self._review_with_single_rubric(document_ir, rubric_name)
                print(f"  → {rubric_name}: 完成 {len(result)} 个区块")
                return rubric_name, result

            tasks = [run_one(name) for name in selected_rubrics]
            pairs = await asyncio.gather(*tasks, return_exceptions=True)

            results: Dict[str, List[BlockReviewResult]] = {}
            for item in pairs:
                if isinstance(item, Exception):
                    print(f"  → 某规范并行执行异常: {item}")
                    continue
                rubric_name, blocks = item
                results[rubric_name] = blocks

            # 兜底：所有规范都失败时使用通用规范
            if not any(results.values()):
                print("  → 警告：所有规范审查均失败，使用通用规范兜底")
                try:
                    fallback = await self._review_with_single_rubric(document_ir, "universal_rubric")
                    results["universal_rubric"] = fallback
                except Exception as e:
                    print(f"  → 兜底规范也失败: {e}")
                    results["universal_rubric"] = []

            return results

        except Exception as e:
            print(f"  → 多规范编排失败: {e}，返回空结果")
            return {}

    async def _review_with_single_rubric(
        self,
        document_ir: DocumentIR,
        rubric_name: str
    ) -> List[BlockReviewResult]:
        """使用单个规范进行审稿"""
        try:
            rubric_items = self.rubric_loader.load_rubric(rubric_name)

            block = RubricBlock(
                block_id=f"{rubric_name}_block",
                block_name=rubric_name,
                items=rubric_items
            )

            # 每次调用创建独立的 reviewer 实例，避免并发状态共享
            reviewer = MethodologyReviewerAgent(self.llm)
            evidence_map = EvidenceMap()

            result = await reviewer.review_block(
                rubric_block=block,
                document_ir=document_ir,
                evidence_map=evidence_map,
                language="zh"
            )
            return [result]

        except FileNotFoundError:
            print(f"  → 规范文件不存在，跳过: {rubric_name}")
            return []
        except Exception as e:
            print(f"  → 规范审查失败 [{rubric_name}]: {e}")
            return []
