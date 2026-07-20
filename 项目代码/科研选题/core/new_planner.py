"""
任务规划器模块 V5.0 - 真正的动态规划器
基于证据统计和用户意图智能决定模块启用
"""
from typing import Set, List, Dict, Any
from datetime import datetime
from config.settings import settings
from models.schemas import (
    EvidenceStats, StandardizedInput, ExecutionPlan,
    ExecutionGroup
)


class PlanningError(Exception):
    """规划错误"""
    pass


class AnalysisPlanner:
    """分析规划器 V5.0 - 真正的动态规划"""

    # 模块依赖关系
    MODULE_DEPENDENCIES = {
        'M1_PROBLEM_LANDSCAPE': [],
        'M2_RESEARCH_ECOSYSTEM': [],
        'M3_EVIDENCE_SYSTEM': [],
        'M4_SCIENTIFIC_CONTRADICTION': ['M3_EVIDENCE_SYSTEM'],
        'M5_BREAKTHROUGH_OPPORTUNITY': ['M4_SCIENTIFIC_CONTRADICTION', 'M3_EVIDENCE_SYSTEM'],
        'M6_RESEARCH_AGENDA': ['M5_BREAKTHROUGH_OPPORTUNITY', 'M4_SCIENTIFIC_CONTRADICTION']
    }

    # 意图权重矩阵
    INTENT_WEIGHTS = {
        'M1_PROBLEM_LANDSCAPE': {
            'exploration': 1.2, 'gap_hunting': 0.9, 'idea_validation': 0.9,
            'feasibility_check': 0.8, 'design_help': 0.8, 'publication_strategy': 0.9
        },
        'M2_RESEARCH_ECOSYSTEM': {
            'exploration': 1.1, 'gap_hunting': 0.9, 'idea_validation': 0.9,
            'feasibility_check': 1.0, 'design_help': 0.8, 'publication_strategy': 1.0
        },
        'M3_EVIDENCE_SYSTEM': {
            'exploration': 1.0, 'gap_hunting': 1.1, 'idea_validation': 1.2,
            'feasibility_check': 1.1, 'design_help': 0.9, 'publication_strategy': 1.0
        },
        'M4_SCIENTIFIC_CONTRADICTION': {
            'exploration': 0.9, 'gap_hunting': 1.2, 'idea_validation': 1.1,
            'feasibility_check': 1.0, 'design_help': 0.9, 'publication_strategy': 0.9
        },
        'M5_BREAKTHROUGH_OPPORTUNITY': {
            'exploration': 0.9, 'gap_hunting': 1.2, 'idea_validation': 1.1,
            'feasibility_check': 1.0, 'design_help': 1.0, 'publication_strategy': 0.9
        },
        'M6_RESEARCH_AGENDA': {
            'exploration': 0.8, 'gap_hunting': 1.1, 'idea_validation': 1.2,
            'feasibility_check': 1.2, 'design_help': 1.2, 'publication_strategy': 1.1
        }
    }

    # 模块描述
    MODULE_DESCRIPTIONS = {
        'M1_PROBLEM_LANDSCAPE': '科研问题全景分析 - 理解领域发展脉络和核心问题',
        'M2_RESEARCH_ECOSYSTEM': '研究生态结构分析 - 分析作者、期刊和知识网络',
        'M3_EVIDENCE_SYSTEM': '证据体系结构诊断 - 评估证据金字塔和转化断层',
        'M4_SCIENTIFIC_CONTRADICTION': '科学争议与矛盾分析 - 识别研究争议和知识断裂点',
        'M5_BREAKTHROUGH_OPPORTUNITY': '跨域知识关联分析 - 发现跨领域突破机会',
        'M6_RESEARCH_AGENDA': '研究策略与选题规划 - 生成可执行的研究选题'
    }

    def create_execution_plan(
        self,
        evidence_stats: EvidenceStats,
        standardized_input: StandardizedInput
    ) -> ExecutionPlan:
        """
        创建执行计划 - V5.0真正的动态规划

        基于证据统计和用户意图智能决定启用哪些模块
        """
        enabled_modules, module_scores = self._apply_module_enable_rules(
            evidence_stats,
            standardized_input
        )

        execution_groups = self._generate_execution_groups(enabled_modules)
        resource_estimate = self._estimate_resources(enabled_modules)

        # 生成规划理由
        planning_reasoning = self._generate_planning_reasoning(
            enabled_modules,
            module_scores,
            evidence_stats
        )

        return ExecutionPlan(
            plan_id=f"PLAN_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
            created_at=datetime.now(),
            enabled_modules=self._topological_sort(enabled_modules),  # 稳定拓扑顺序，不用 set 随机顺序
            execution_groups=execution_groups,
            resource_estimate=resource_estimate,
            adjustments=[],
            planning_reasoning=planning_reasoning,
            module_scores=module_scores
        )

    def _apply_module_enable_rules(
        self,
        stats: EvidenceStats,
        standardized_input: StandardizedInput
    ) -> tuple[Set[str], Dict[str, float]]:
        """
        应用模块启用规则 - V5.0真正的动态规划

        返回：
            (启用的模块集合, 各模块得分字典)
        """
        enabled = set()
        module_scores = {}

        stage_intent = (
            standardized_input.research_stage_intent.value
            if hasattr(standardized_input.research_stage_intent, 'value')
            else str(standardized_input.research_stage_intent)
        )

        # V5.0: 真正的动态评分函数
        for module_id in self.INTENT_WEIGHTS.keys():
            # 计算证据评分
            evidence_score = self._calculate_evidence_score(module_id, stats)

            # 获取意图权重
            intent_weight = self.INTENT_WEIGHTS.get(module_id, {}).get(stage_intent, 1.0)

            # 计算最终得分
            final_score = evidence_score * intent_weight
            module_scores[module_id] = final_score

            # V5.0: 使用动态阈值决定是否启用
            threshold = self._get_module_threshold(module_id)
            if final_score >= threshold:
                enabled.add(module_id)

        # 确保至少启用基础模块
        if not enabled:
            enabled.add('M1_PROBLEM_LANDSCAPE')
            if stats.evidence_count >= 10:
                enabled.add('M3_EVIDENCE_SYSTEM')

        return enabled, module_scores

    def _calculate_evidence_score(self, module_id: str, stats: EvidenceStats) -> float:
        """
        V5.0: 计算证据评分 - 更细致的评估

        根据文献统计数据评估某模块的适用性
        """
        count = stats.evidence_count

        if module_id == "M1_PROBLEM_LANDSCAPE":
            # M1: 只要有文献就可以执行
            if count >= 10:
                return 1.0
            elif count >= 5:
                return 0.8
            elif count >= 1:
                return 0.6
            return 0.0

        elif module_id == "M2_RESEARCH_ECOSYSTEM":
            # M2: 需要足够文献来识别生态结构
            # 需要至少20篇文献和5个独立作者
            author_diversity = len(stats.author_counts) if stats.author_counts else 0

            score = 0.0
            if count >= 30:
                score = 1.0
            elif count >= 20:
                score = 0.8
            elif count >= 10:
                score = 0.6
            elif count >= 5:
                score = 0.4

            # 作者多样性加成
            if author_diversity >= 10:
                score *= 1.0
            elif author_diversity >= 5:
                score *= 0.9
            else:
                score *= 0.7

            return min(score, 1.0)

        elif module_id == "M3_EVIDENCE_SYSTEM":
            # M3: 需要多种研究类型才能诊断证据体系
            design_count = len(stats.design_distribution) if stats.design_distribution else 0

            if count >= 20 and design_count >= 3:
                return 1.0
            elif count >= 15 and design_count >= 2:
                return 0.8
            elif count >= 10:
                return 0.6
            elif count >= 5:
                return 0.4
            return 0.0

        elif module_id == "M4_SCIENTIFIC_CONTRADICTION":
            # M4: 需要足够临床研究来识别矛盾
            clinical_ratio = stats.clinical_ratio

            if count >= 20 and clinical_ratio >= 0.3:
                return 1.0
            elif count >= 15 and clinical_ratio >= 0.2:
                return 0.8
            elif count >= 10:
                return 0.6
            elif count >= 5:
                return 0.4
            return 0.0

        elif module_id == "M5_BREAKTHROUGH_OPPORTUNITY":
            # M5: 基于M3和M4的结果，需要较好的证据基础
            if count >= 25:
                return 1.0
            elif count >= 20:
                return 0.8
            elif count >= 15:
                return 0.6
            elif count >= 10:
                return 0.4
            return 0.0

        elif module_id == "M6_RESEARCH_AGENDA":
            # M6: 生成选题，只要有足够证据即可
            if count >= 10:
                return 1.0
            elif count >= 5:
                return 0.7
            return 0.5

        return 0.0

    def _get_module_threshold(self, module_id: str) -> float:
        """统一低阈值，确保6个模块全部启用"""
        return 0.0

    def _generate_planning_reasoning(
        self,
        enabled_modules: Set[str],
        module_scores: Dict[str, float],
        stats: EvidenceStats
    ) -> str:
        """
        V5.0新增: 生成规划理由说明

        向用户解释为什么选择这些模块
        """
        reasoning_parts = []

        # 总体说明
        reasoning_parts.append(
            f"基于检索到的 {stats.evidence_count} 篇文献，"
            f"系统评估了各分析模块的适用性。"
        )

        # 启用的模块说明
        if enabled_modules:
            reasoning_parts.append(f"\n已启用 {len(enabled_modules)} 个分析模块:")
            for module_id in sorted(enabled_modules):
                score = module_scores.get(module_id, 0)
                desc = self.MODULE_DESCRIPTIONS.get(module_id, module_id)
                reasoning_parts.append(f"  • {desc} (匹配度: {score:.0%})")

        # 未启用的模块说明
        all_modules = set(self.INTENT_WEIGHTS.keys())
        disabled = all_modules - enabled_modules
        if disabled:
            reasoning_parts.append(f"\n暂不适合分析的模块:")
            for module_id in sorted(disabled):
                score = module_scores.get(module_id, 0)
                desc = self.MODULE_DESCRIPTIONS.get(module_id, module_id)
                reasoning_parts.append(f"  • {desc} (匹配度: {score:.0%}，低于阈值)")

        return "\n".join(reasoning_parts)

    def _generate_execution_groups(
        self,
        modules: Set[str]
    ) -> List[ExecutionGroup]:
        """生成执行组 - V5.0串行执行为主"""
        # V5.0: 改为串行执行组，每个模块一个组
        groups = []

        # 按依赖关系排序模块
        sorted_modules = self._topological_sort(modules)

        # 每个模块单独一个组（串行执行）
        for i, module in enumerate(sorted_modules):
            if module in modules:
                estimated_time = self._estimate_module_time(module)
                groups.append(ExecutionGroup(
                    group_id=i + 1,
                    modules=[module],
                    parallel=False,  # V5.0: 串行执行
                    estimated_time_seconds=estimated_time
                ))

        return groups

    def _topological_sort(self, modules: Set[str]) -> List[str]:
        """拓扑排序模块"""
        in_degree = {m: 0 for m in modules}
        for module in modules:
            deps = self.MODULE_DEPENDENCIES.get(module, [])
            for dep in deps:
                if dep in modules:
                    in_degree[module] += 1

        result = []
        remaining = set(modules)

        while remaining:
            ready = {m for m in remaining if in_degree[m] == 0}
            if not ready:
                # 有循环依赖，直接返回剩余模块
                result.extend(sorted(remaining))
                break

            # 按模块ID排序以保证稳定顺序
            for module in sorted(ready):
                result.append(module)
                remaining.remove(module)

                # 更新入度
                for m in remaining:
                    if module in self.MODULE_DEPENDENCIES.get(m, []):
                        in_degree[m] -= 1

        return result

    def _estimate_module_time(self, module_id: str) -> int:
        """估算单个模块执行时间"""
        time_per_module = {
            'M1_PROBLEM_LANDSCAPE': 45,
            'M2_RESEARCH_ECOSYSTEM': 40,
            'M3_EVIDENCE_SYSTEM': 35,
            'M4_SCIENTIFIC_CONTRADICTION': 40,
            'M5_BREAKTHROUGH_OPPORTUNITY': 50,
            'M6_RESEARCH_AGENDA': 45
        }
        return time_per_module.get(module_id, 40)

    def _estimate_group_time(self, modules: Set[str]) -> int:
        """估算执行组时间（向后兼容）"""
        return max(self._estimate_module_time(m) for m in modules) if modules else 0

    def _estimate_resources(self, modules: Set[str]) -> Dict[str, Any]:
        """估算资源需求"""
        llm_calls_per_module = {
            'M1_PROBLEM_LANDSCAPE': 3,
            'M2_RESEARCH_ECOSYSTEM': 3,
            'M3_EVIDENCE_SYSTEM': 2,
            'M4_SCIENTIFIC_CONTRADICTION': 3,
            'M5_BREAKTHROUGH_OPPORTUNITY': 4,
            'M6_RESEARCH_AGENDA': 4
        }

        total_llm_calls = sum(llm_calls_per_module.get(m, 3) for m in modules)

        return {
            "total_llm_calls": total_llm_calls,
            "estimated_time_seconds": sum(self._estimate_module_time(m) for m in modules),
            "estimated_token_usage": total_llm_calls * 3000,
            "module_count": len(modules)
        }

    def get_module_description(self, module_id: str) -> str:
        """获取模块描述"""
        return self.MODULE_DESCRIPTIONS.get(module_id, module_id)

    def get_all_module_descriptions(self) -> Dict[str, str]:
        """获取所有模块描述"""
        return self.MODULE_DESCRIPTIONS.copy()
