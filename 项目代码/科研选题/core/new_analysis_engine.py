"""
分析引擎 V5.0 - 逐步分析引擎 (Stepwise Analysis Engine)
支持按需、串行、可追溯的模块执行
"""
from typing import Dict, List, Any, Optional
from datetime import datetime
import logging
from models.schemas import (
    StandardizedInput, ExecutionPlan, ModuleOutput,
    LiteratureRecord, EvidenceStats
)

logger = logging.getLogger(__name__)
from modules.new_analysis_modules import (
    M1_ProblemLandscapeModule,
    M2_ResearchEcosystemModule,
    M3_EvidenceSystemModule,
    M4_ScientificContradictionModule,
    M5_BreakthroughOpportunityModule,
    M6_ResearchAgendaModule
)


class AnalysisEngine:
    """分析引擎 V5.0 - 逐步分析引擎"""

    def __init__(self):
        self.modules = {
            "M1_PROBLEM_LANDSCAPE": M1_ProblemLandscapeModule(),
            "M2_RESEARCH_ECOSYSTEM": M2_ResearchEcosystemModule(),
            "M3_EVIDENCE_SYSTEM": M3_EvidenceSystemModule(),
            "M4_SCIENTIFIC_CONTRADICTION": M4_ScientificContradictionModule(),
            "M5_BREAKTHROUGH_OPPORTUNITY": M5_BreakthroughOpportunityModule(),
            "M6_RESEARCH_AGENDA": M6_ResearchAgendaModule()
        }

        # 模块依赖关系
        self.MODULE_DEPENDENCIES = {
            "M4_SCIENTIFIC_CONTRADICTION": ["M3_EVIDENCE_SYSTEM"],
            "M5_BREAKTHROUGH_OPPORTUNITY": ["M4_SCIENTIFIC_CONTRADICTION", "M3_EVIDENCE_SYSTEM"],
            "M6_RESEARCH_AGENDA": ["M5_BREAKTHROUGH_OPPORTUNITY", "M4_SCIENTIFIC_CONTRADICTION"]
        }

    # ==================== V5.0: 逐步执行单个模块 ====================

    async def execute_module(
        self,
        module_id: str,
        standardized_input: StandardizedInput,
        evidence_records: List[LiteratureRecord],
        evidence_stats: EvidenceStats,
        existing_outputs: Dict[str, ModuleOutput],
        stream_callback=None,
    ) -> ModuleOutput:
        """
        V5.0: 执行单个指定模块

        Args:
            module_id: 要执行的模块ID
            standardized_input: 标准化输入
            evidence_records: 文献记录
            evidence_stats: 证据统计
            existing_outputs: 已执行模块的输出（用于依赖）
            stream_callback: 可选，async callable(delta: str)，实时转发 deep_analysis token

        Returns:
            模块执行结果
        """
        if module_id not in self.modules:
            return ModuleOutput(
                module_id=module_id,
                status="failed",
                error_message=f"未知模块: {module_id}"
            )

        module = self.modules[module_id]
        start_time = datetime.now()

        try:
            # 收集依赖数据
            deps = self._collect_dependencies(module_id, existing_outputs)

            # 执行模块
            output = await module.execute(
                standardized_input=standardized_input,
                evidence_records=evidence_records,
                evidence_stats=evidence_stats,
                dependencies=deps,
                stream_callback=stream_callback,
            )

            # 计算执行时间
            execution_time = (datetime.now() - start_time).total_seconds() * 1000
            output.execution_time_ms = int(execution_time)

            return output

        except Exception as e:
            return ModuleOutput(
                module_id=module_id,
                status="failed",
                error_message=str(e),
                execution_time_ms=int((datetime.now() - start_time).total_seconds() * 1000)
            )

    def get_ready_modules(
        self,
        execution_plan: ExecutionPlan,
        completed_modules: List[str]
    ) -> List[str]:
        """返回当前所有依赖已满足、可并行执行的模块列表（保持原始顺序）"""
        completed = set(completed_modules)
        return [
            module_id for module_id in execution_plan.enabled_modules
            if module_id not in completed
            and all(dep in completed for dep in self.MODULE_DEPENDENCIES.get(module_id, []))
        ]

    def get_next_module(
        self,
        execution_plan: ExecutionPlan,
        completed_modules: List[str]
    ) -> Optional[str]:
        """
        获取下一个应该执行的模块

        Args:
            execution_plan: 执行计划
            completed_modules: 已完成的模块列表

        Returns:
            下一个模块ID，如果全部完成则返回None
        """
        enabled_ordered = execution_plan.enabled_modules  # 保持原始列表顺序
        completed = set(completed_modules)

        for module_id in enabled_ordered:
            if module_id in completed:
                continue

            # 检查依赖是否已满足
            deps = self.MODULE_DEPENDENCIES.get(module_id, [])
            if all(dep in completed for dep in deps):
                return module_id

        return None

    def get_execution_sequence(self, execution_plan: ExecutionPlan) -> List[str]:
        """
        获取完整的执行序列

        按照依赖关系排序所有启用的模块
        """
        enabled = execution_plan.enabled_modules  # 保持原始列表顺序
        sequence = []
        completed = set()

        remaining = list(enabled)  # 用列表保持顺序
        while remaining:
            found = False
            for module_id in list(remaining):
                deps = self.MODULE_DEPENDENCIES.get(module_id, [])
                if all(dep in completed for dep in deps):
                    sequence.append(module_id)
                    completed.add(module_id)
                    remaining.remove(module_id)
                    found = True

            if not found and remaining:
                # 有依赖循环，记录警告后追加剩余模块（保持列表顺序）
                logger.warning(f"检测到模块依赖循环，受影响模块: {remaining}，将按默认顺序执行")
                sequence.extend(remaining)
                break

        return sequence

    def _collect_dependencies(
        self,
        module_id: str,
        existing_outputs: Dict[str, ModuleOutput]
    ) -> Dict[str, ModuleOutput]:
        """收集模块依赖"""
        deps = {}
        for dep_id in self.MODULE_DEPENDENCIES.get(module_id, []):
            if dep_id in existing_outputs:
                deps[dep_id] = existing_outputs[dep_id]
        return deps

    # ==================== 向后兼容：批量执行 ====================

    async def execute_plan(
        self,
        execution_plan: ExecutionPlan,
        standardized_input: StandardizedInput,
        evidence_records: List[LiteratureRecord],
        evidence_stats: EvidenceStats,
        progress_callback: callable = None
    ) -> Dict[str, ModuleOutput]:
        """
        执行完整的分析计划 - 向后兼容

        V5.0: 改为串行执行
        """
        outputs = {}

        # 获取执行序列
        sequence = self.get_execution_sequence(execution_plan)

        for module_id in sequence:
            output = await self.execute_module(
                module_id=module_id,
                standardized_input=standardized_input,
                evidence_records=evidence_records,
                evidence_stats=evidence_stats,
                existing_outputs=outputs
            )

            outputs[module_id] = output

            if progress_callback:
                await progress_callback(module_id, output)

        return outputs

    def get_module_info(self, module_id: str) -> Dict[str, Any]:
        """获取模块信息"""
        if module_id not in self.modules:
            return {}

        module = self.modules[module_id]
        deps = self.MODULE_DEPENDENCIES.get(module_id, [])

        return {
            "module_id": module_id,
            "module_name": getattr(module, 'MODULE_NAME', module_id),
            "dependencies": deps,
            "has_charts_support": hasattr(module, '_generate_chart'),
            "has_evidence_support": hasattr(module, 'find_supporting_evidence')
        }

    def get_all_modules_info(self) -> Dict[str, Dict[str, Any]]:
        """获取所有模块信息"""
        return {
            module_id: self.get_module_info(module_id)
            for module_id in self.modules.keys()
        }


# 全局分析引擎实例
analysis_engine = AnalysisEngine()
