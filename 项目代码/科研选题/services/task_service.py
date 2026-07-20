"""
任务服务模块 V5.0
实现分阶段动态分析架构
新增：输入校验、检索鲁棒性、降级策略、ES集成
"""
import asyncio
import json
import re
import uuid
import logging
from typing import Optional, Dict, Any, List
from datetime import datetime
from models.schemas import (
    AnalysisTask, TaskStatus, StandardizedInput, AnalysisPhase,
    ExecutionPlan, ModuleOutput, EvidenceStats, AnalysisBlueprint,
    ChartInfo, SearchDiagnostics
)
from core.input_processor import InputPreprocessor, InputValidationError
from core.new_planner import AnalysisPlanner
from core.new_analysis_engine import AnalysisEngine
from core.new_report_generator import ReportGenerator
from services.llm_service import llm_service
from services.pubmed_service import PubMedSearchService
from services.internal_db_service import search_internal_db
from config.settings import settings

logger = logging.getLogger(__name__)


class TaskService:
    """任务服务 V5.0 - 分阶段处理"""

    TASK_TTL_SECONDS = 3600  # 任务最长保留 1 小时

    def __init__(self):
        self.preprocessor = InputPreprocessor()
        self.pubmed_service = PubMedSearchService()
        self.planner = AnalysisPlanner()
        self.analysis_engine = AnalysisEngine()
        self.report_generator = ReportGenerator()
        self.tasks = {}  # 内存存储，生产环境应使用数据库
        self._tasks_lock = asyncio.Lock()  # 保护 tasks 字典的并发写
        self._cleanup_task: Optional[asyncio.Task] = None

    def start_cleanup_loop(self):
        """启动后台 TTL 清理协程（在事件循环启动后调用）"""
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def close(self):
        """Release network resources owned by this service instance."""
        if self._cleanup_task is not None and not self._cleanup_task.done():
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
        self._cleanup_task = None
        await self.pubmed_service.close()

    async def _cleanup_loop(self):
        """每 10 分钟清理超时任务及对应图表文件，释放内存和磁盘"""
        while True:
            await asyncio.sleep(600)
            try:
                now = datetime.now()
                async with self._tasks_lock:
                    expired = [
                        task_id for task_id, task in self.tasks.items()
                        if (now - task.updated_at).total_seconds() > self.TASK_TTL_SECONDS
                    ]
                    for task_id in expired:
                        del self.tasks[task_id]
                if expired:
                    logger.info(f"[TTL清理] 已清理 {len(expired)} 个过期任务: {expired}")
                # 清理超过2小时的图表文件，防止 /tmp 磁盘堆积
                import os, time
                charts_dir = "/tmp/research_topic_charts"
                if os.path.isdir(charts_dir):
                    now_ts = time.time()
                    removed = 0
                    for fname in os.listdir(charts_dir):
                        fpath = os.path.join(charts_dir, fname)
                        try:
                            if now_ts - os.path.getmtime(fpath) > 7200:
                                os.remove(fpath)
                                removed += 1
                        except Exception:
                            pass
                    if removed:
                        logger.info(f"[TTL清理] 已删除 {removed} 个过期图表文件")
            except Exception as e:
                logger.warning(f"[TTL清理] 清理异常: {e}")

    # ==================== 输入校验 ====================

    def validate_input(self, input_text: str) -> Optional[InputValidationError]:
        """
        校验用户输入

        Returns:
            None if valid, InputValidationError if invalid
        """
        return self.preprocessor.validate(input_text)

    # ==================== V5.0: 阶段一 - 检索与规划 ====================

    async def create_task(self, input_text: str, options: Dict = None) -> AnalysisTask:
        """创建新任务"""
        task_id = f"TASK_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"

        task = AnalysisTask(
            task_id=task_id,
            status=TaskStatus.PENDING,
            input_text=input_text,
            created_at=datetime.now(),
            updated_at=datetime.now(),
            phase=AnalysisPhase.RETRIEVAL
        )

        async with self._tasks_lock:
            self.tasks[task_id] = task
        return task

    async def start_retrieval_and_planning(self, task_id: str) -> AnalysisBlueprint:
        """
        V5.0: 阶段一 - 检索与规划

        1. LLM驱动的查询理解
        2. 多子查询并行检索（PubMed + ES）
        3. 检索结果诊断与降级策略
        4. 初步统计分析
        5. 动态规划生成
        """
        task = self.tasks.get(task_id)
        if not task:
            raise ValueError(f"任务不存在: {task_id}")

        try:
            task.status = TaskStatus.RETRIEVING
            task.current_phase = "检索与规划"
            task.updated_at = datetime.now()

            # Step 1: 输入预处理
            preprocessed = self.preprocessor.process(task.input_text)

            # Step 2: LLM驱动的查询理解与实体化
            task.current_phase = "查询理解与实体化"
            query_structure = await llm_service.analyze_query_structure(preprocessed)

            # Step 3: 多源检索（优先内部数据库，无结果时再生成子查询走 PubMed）
            task.current_phase = "多源并行检索"
            evidence_records, sub_queries = await self._multi_source_search(task.input_text, query_structure)

            # Step 5: 去重
            evidence_records = await self.pubmed_service.deduplicate_records(evidence_records)
            evidence_records = self._filter_relevant_records(
                evidence_records,
                query_structure,
                raw_query=task.input_text,
            )
            task.evidence_records = evidence_records

            # Step 6: 检索诊断与降级判断
            search_diagnostics = self._diagnose_search_results(
                evidence_records, sub_queries, query_structure
            )
            logger.info(f"检索诊断: {search_diagnostics.status}, 共{search_diagnostics.retrieved_count}篇")

            # 如果完全没有结果，返回诊断信息而非继续
            if not search_diagnostics.can_proceed:
                task.status = TaskStatus.FAILED
                task.error_message = search_diagnostics.diagnosis
                task.current_phase = "检索结果不足"
                task.updated_at = datetime.now()

                # 构建一个最小蓝图，携带诊断信息
                blueprint = AnalysisBlueprint(
                    task_id=task.task_id,
                    retrieved_count=search_diagnostics.retrieved_count,
                    year_range=(datetime.now().year, datetime.now().year),
                    planned_modules=[],
                    module_descriptions={},
                    estimated_time_seconds=0,
                    can_proceed=False,
                    search_diagnostics=search_diagnostics
                )
                task.blueprint = blueprint
                return blueprint

            # Step 7: 证据评估与统计
            task.current_phase = "证据评估与统计"
            evidence_stats = await self.pubmed_service.calculate_evidence_stats(evidence_records)
            task.evidence_stats = evidence_stats

            # 构建标准化输入
            standardized = self._build_standardized_input(preprocessed, query_structure)
            # 兜底：LLM 可能返回不在枚举内的值
            _valid_intents = {"exploration", "gap_hunting", "idea_validation", "feasibility_check", "design_help", "publication_strategy"}
            if standardized.get("research_stage_intent") not in _valid_intents:
                standardized["research_stage_intent"] = "exploration"
            _valid_study_designs = {"rct", "meta", "mr", "cohort", "mechanism", "animal", "in_vitro", "case_report", "unknown"}
            if standardized.get("study_design_hint") not in _valid_study_designs:
                standardized["study_design_hint"] = "unknown"
            task.standardized_input = StandardizedInput(**standardized)

            # Step 8: 动态规划（根据文献量自动降级）
            task.current_phase = "动态规划生成"
            task.status = TaskStatus.PLANNING
            execution_plan = self.planner.create_execution_plan(
                evidence_stats,
                task.standardized_input
            )
            task.execution_plan = execution_plan
            task.pending_modules = execution_plan.enabled_modules.copy()

            # 生成分析蓝图
            blueprint = self._create_analysis_blueprint(
                task, evidence_stats, execution_plan, search_diagnostics
            )
            task.blueprint = blueprint

            task.status = TaskStatus.WAITING_CONFIRMATION
            task.current_phase = "等待用户确认分析计划"
            task.updated_at = datetime.now()

            return blueprint

        except Exception as e:
            task.status = TaskStatus.FAILED
            task.error_message = str(e)
            task.current_phase = f"检索与规划失败: {str(e)}"
            task.updated_at = datetime.now()
            logger.exception(f"任务 {task_id} 检索与规划失败")
            raise

    async def _multi_source_search(
        self,
        input_text: str,
        query_structure: Dict
    ) -> tuple:
        """
        优先使用内部数据库检索，无结果或异常时降级到 PubMed。

        Returns:
            (records, sub_queries) — sub_queries 内部数据库时为空列表，PubMed 时为实际使用的子查询
        """
        logger.info(f"[检索] 优先调用内部数据库，查询词: {input_text!r}")
        internal_records = await search_internal_db(input_text)

        # Internal search improves recall, while PubMed supplies authoritative
        # identifiers, publication types, and traceable metadata.  Use both;
        # a non-empty private result must not suppress the public evidence path.
        logger.info(
            "[检索] 内部数据库返回 %d 篇；继续查询 PubMed 以补充标准元数据",
            len(internal_records),
        )
        llm_synonyms = query_structure.get('synonyms', {})
        llm_sub_queries = query_structure.get('sub_queries', [])
        if llm_sub_queries:
            sub_queries = llm_sub_queries
            logger.info(f"[检索] 使用LLM生成的 {len(sub_queries)} 个子查询")
        else:
            sub_queries = llm_service.build_final_queries(
                query_structure.get('pico_entities', {}),
                query_structure.get('logical_structure', ''),
                llm_synonyms=llm_synonyms
            )
            logger.info(f"[检索] 使用机械拼接的 {len(sub_queries)} 个子查询")

        current_year = datetime.now().year
        pubmed_records = await self.pubmed_service.search_with_subqueries(
            sub_queries, max_results=300, date_range=(current_year - 4, current_year)
        )
        pubmed_records = pubmed_records if isinstance(pubmed_records, list) else []
        logger.info(
            "[检索] 多源合并：内部库 %d 篇 + PubMed %d 篇",
            len(internal_records), len(pubmed_records),
        )
        return [*internal_records, *pubmed_records], sub_queries

    @staticmethod
    def _normalized_evidence_text(value: Any) -> str:
        return re.sub(r"[^a-z0-9]+", " ", str(value or "").casefold()).strip()

    @classmethod
    def _is_pediatric_dominant(cls, record: Any) -> bool:
        """Identify records whose actual population is pediatric, not a passing mention."""
        pediatric_terms = {
            "pediatric", "pediatrics", "paediatric", "paediatrics", "child",
            "children", "childhood", "infant", "infants", "neonate", "neonates",
            "neonatal", "newborn", "newborns", "preterm", "adolescent", "adolescents",
        }
        raw_title = f"{getattr(record, 'title', '') or ''} {getattr(record, 'title_zh', '') or ''}"
        if re.search(r"儿科|儿童|婴儿|新生儿|早产儿|青少年", raw_title):
            return True
        title = cls._normalized_evidence_text(raw_title)
        if set(title.split()).intersection(pediatric_terms):
            return True
        raw_abstract = f"{getattr(record, 'abstract', '') or ''} {getattr(record, 'abstract_zh', '') or ''}"
        if re.search(r"儿科患者|儿科人群|儿科重症监护|儿童患者|儿童队列|婴儿患者|新生儿患者", raw_abstract):
            return True
        abstract = " " + cls._normalized_evidence_text(raw_abstract) + " "
        strong_population_phrases = (
            " pediatric patients ", " paediatric patients ", " pediatric population ",
            " paediatric population ", " pediatric intensive care ",
            " paediatric intensive care ", " pediatric icu ", " paediatric icu ",
            " pediatrics unit ", " paediatrics unit ", " among critically ill children ",
            " children aged ", " adolescent patients ",
        )
        return any(phrase in abstract for phrase in strong_population_phrases)

    @classmethod
    def _filter_relevant_records(
        cls,
        records: List,
        query_structure: Dict,
        raw_query: str = "",
    ) -> List:
        """Keep records that satisfy every explicit population/intervention anchor."""
        pico = query_structure.get("pico_entities") or {}
        synonyms = query_structure.get("synonyms") or {}
        generic_terms = {"adult", "adults", "human", "humans", "patient", "patients"}
        synonym_lookup = {
            cls._normalized_evidence_text(key): value
            for key, value in synonyms.items()
            if isinstance(key, str) and isinstance(value, list)
        }
        required_groups = []
        for category in ("population", "intervention"):
            for entity in pico.get(category) or []:
                normalized = cls._normalized_evidence_text(entity)
                if not normalized or normalized in generic_terms:
                    continue
                candidates = {normalized}
                for synonym in synonym_lookup.get(normalized, []):
                    candidate = cls._normalized_evidence_text(synonym)
                    if candidate and candidate not in generic_terms:
                        candidates.add(candidate)
                required_groups.append(candidates)

        relevant = []
        normalized_query = cls._normalized_evidence_text(raw_query)
        adult_scoped = bool(re.search(r"\badults?\b", normalized_query)) or any(
            marker in str(raw_query) for marker in ("成人", "成年人", "老年")
        )
        for record in records:
            fields = [
                getattr(record, "title", "") or "",
                getattr(record, "abstract", "") or "",
                getattr(record, "title_zh", "") or "",
                getattr(record, "abstract_zh", "") or "",
                " ".join(getattr(record, "keywords", []) or []),
                " ".join(getattr(record, "mesh_terms", []) or []),
            ]
            haystack = " " + cls._normalized_evidence_text(" ".join(fields)) + " "
            if adult_scoped and cls._is_pediatric_dominant(record):
                continue
            if all(any((" " + term + " ") in haystack for term in group) for group in required_groups):
                relevant.append(record)

        logger.info(
            "[检索] PICO相关性门控保留 %d/%d 篇（%d个必需概念组）",
            len(relevant),
            len(records),
            len(required_groups),
        )
        return relevant

    def _diagnose_search_results(
        self,
        records: List,
        sub_queries: List[str],
        query_structure: Dict
    ) -> SearchDiagnostics:
        """
        检索结果诊断 - 分析检索质量并给出建议

        Returns:
            SearchDiagnostics with status, diagnosis, and suggestions
        """
        count = len(records)
        pico = query_structure.get('pico_entities', {})

        # 提取用户的核心检索词用于建议
        p_terms = pico.get('population', [])
        i_terms = pico.get('intervention', [])
        o_terms = pico.get('outcome', [])

        if count == 0:
            suggestions = [
                "请检查输入中的专业术语拼写是否正确",
                "尝试使用更通用的疾病/药物名称",
            ]
            if p_terms and i_terms and o_terms:
                suggestions.append(
                    f"尝试去掉结局指标，只保留人群({', '.join(p_terms[:2])})和干预({', '.join(i_terms[:2])})"
                )
            if p_terms:
                suggestions.append(
                    f"尝试使用更上位的疾病分类名称，如将具体亚型改为大类疾病名"
                )
            suggestions.append("尝试使用英文医学术语进行检索")

            return SearchDiagnostics(
                status="no_results",
                retrieved_count=0,
                diagnosis="未检索到相关文献。可能原因：检索词过于具体、术语拼写有误、或该领域文献极少。",
                suggestions=suggestions,
                can_proceed=False
            )

        elif count < 5:
            suggestions = [
                f"当前仅检索到{count}篇文献，分析结果可能不够全面",
                "建议放宽检索条件以获取更多文献",
            ]
            if o_terms:
                suggestions.append(f"尝试去掉结局指标限定（{', '.join(o_terms[:2])}）")
            suggestions.append("可以继续分析，但报告将标注'证据基础薄弱'")

            return SearchDiagnostics(
                status="low_recall",
                retrieved_count=count,
                diagnosis=f"仅检索到{count}篇相关文献，证据基础较薄弱。系统将执行简化分析。",
                suggestions=suggestions,
                can_proceed=True  # 允许继续但会降级
            )

        elif count < 20:
            return SearchDiagnostics(
                status="moderate",
                retrieved_count=count,
                diagnosis=f"检索到{count}篇相关文献，可进行基础分析。部分需要大样本的模块可能被跳过。",
                suggestions=[
                    "文献量适中，系统将自动调整分析深度",
                    "如需更全面的分析，可尝试扩大检索范围"
                ],
                can_proceed=True
            )

        else:
            return SearchDiagnostics(
                status="success",
                retrieved_count=count,
                diagnosis=f"检索到{count}篇相关文献，证据基础充分，将执行全量分析。",
                suggestions=[],
                can_proceed=True
            )

    def _create_analysis_blueprint(
        self,
        task: AnalysisTask,
        evidence_stats: EvidenceStats,
        execution_plan: ExecutionPlan,
        search_diagnostics: SearchDiagnostics = None
    ) -> AnalysisBlueprint:
        """创建分析蓝图"""
        # 模块描述
        module_descriptions = {}
        for module_id in execution_plan.enabled_modules:
            module_descriptions[module_id] = self.planner.get_module_description(module_id)

        return AnalysisBlueprint(
            task_id=task.task_id,
            retrieved_count=evidence_stats.evidence_count,
            year_range=(evidence_stats.earliest_year, evidence_stats.latest_year),
            trend_chart_path=None,
            planned_modules=execution_plan.enabled_modules,
            module_descriptions=module_descriptions,
            estimated_time_seconds=execution_plan.resource_estimate.get("estimated_time_seconds", 300),
            can_proceed=evidence_stats.evidence_count >= 5,
            search_diagnostics=search_diagnostics
        )

    def _build_standardized_input(
        self,
        preprocessed: Any,
        query_structure: Dict
    ) -> Dict:
        """构建标准化输入"""
        pico = query_structure.get('pico_entities', {})
        all_terms = []
        for terms in pico.values():
            if isinstance(terms, list):
                all_terms.extend(terms)
            elif isinstance(terms, str) and terms:
                all_terms.append(terms)

        return {
            "core_entities": {
                "drugs": pico.get('intervention', []),
                "diseases": pico.get('population', []),
                "genes": [],
                "mechanisms": [],
                "outcomes": pico.get('outcome', []),
                "populations": pico.get('population', []),
                "interventions": pico.get('intervention', []),
                "comparators": pico.get('comparison', [])
            },
            "study_design_hint": query_structure.get('study_design_hint', 'unknown'),
            "research_stage_intent": query_structure.get('research_stage_intent', 'exploration'),
            "question_structure": "association_question",
            "research_axis": "treatment",
            "query_terms": {
                "zh": [],
                "en": all_terms[:8]
            },
            "pico_elements": {
                "population": ", ".join(pico.get('population', [])) if pico.get('population') else None,
                "intervention": ", ".join(pico.get('intervention', [])) if pico.get('intervention') else None,
                "comparison": ", ".join(pico.get('comparison', [])) if pico.get('comparison') else None,
                "outcome": ", ".join(pico.get('outcome', [])) if pico.get('outcome') else None
            },
            "pico_entities": pico,
            "logical_structure": query_structure.get('logical_structure', ''),
            "confidence": query_structure.get('confidence', 0.7),
            "research_context": ""
        }

    # ==================== V5.0: 阶段二 - 逐步分析 ====================

    async def confirm_analysis_plan(
        self,
        task_id: str,
        confirmed: bool = True,
        skip_modules: List[str] = None
    ) -> Dict[str, Any]:
        """V5.0: 确认分析计划"""
        task = self.tasks.get(task_id)
        if not task:
            raise ValueError(f"任务不存在: {task_id}")

        if not confirmed:
            task.status = TaskStatus.FAILED
            task.error_message = "用户取消了分析计划"
            return {"status": "cancelled", "message": "分析计划已取消"}

        # 更新待执行模块列表（同时同步 execution_plan，确保 get_ready_modules 生效）
        if skip_modules:
            for module_id in skip_modules:
                if module_id in task.pending_modules:
                    task.pending_modules.remove(module_id)
                if task.execution_plan and module_id in task.execution_plan.enabled_modules:
                    task.execution_plan.enabled_modules.remove(module_id)

        task.plan_confirmed = True
        task.status = TaskStatus.PROCESSING
        task.phase = AnalysisPhase.ANALYSIS
        task.current_phase = "逐步分析执行中"
        task.updated_at = datetime.now()

        next_module = self.analysis_engine.get_next_module(
            task.execution_plan,
            task.completed_modules
        )

        return {
            "status": "confirmed",
            "message": "分析计划已确认，开始逐步执行",
            "total_modules": len(task.pending_modules),
            "next_module": next_module,
            "execution_sequence": self.analysis_engine.get_execution_sequence(task.execution_plan)
        }

    async def execute_next_module(self, task_id: str, stream_callback=None) -> Dict[str, Any]:
        """V5.0: 执行下一个模块（自动并行执行无依赖的就绪模块）"""
        task = self.tasks.get(task_id)
        if not task:
            raise ValueError(f"任务不存在: {task_id}")

        if not task.plan_confirmed:
            raise ValueError("请先确认分析计划")

        # 优先从并行缓冲区返回已完成的结果
        if task.parallel_buffer:
            return task.parallel_buffer.pop(0)

        ready_modules = self.analysis_engine.get_ready_modules(
            task.execution_plan,
            task.completed_modules
        )

        if not ready_modules:
            logger.info(f"[任务 {task_id}] 所有模块执行完毕，开始生成报告")
            return await self._finalize_analysis(task)

        total = len(task.execution_plan.enabled_modules)

        if len(ready_modules) == 1:
            # 单模块，原有逻辑
            return await self._execute_single_module(task, task_id, ready_modules[0], total, stream_callback=stream_callback)

        # 多个模块无依赖关系，并行执行
        # 并行时只对第一个模块启用 stream_callback（其余静默执行）
        logger.info(f"[任务 {task_id}] 并行执行 {len(ready_modules)} 个模块: {ready_modules}")
        coros = [
            self._run_module_pure(task, module_id, stream_callback=(stream_callback if i == 0 else None))
            for i, module_id in enumerate(ready_modules)
        ]
        pairs = await asyncio.gather(*coros, return_exceptions=True)

        # 统一更新任务状态（串行，避免并发修改），同时构建安全输出映射
        safe_outputs: Dict[str, ModuleOutput] = {}
        for module_id, output in zip(ready_modules, pairs):
            if isinstance(output, Exception):
                logger.error(f"[任务 {task_id}] 并行模块 {module_id} 失败，降级为错误输出: {output}")
                # 生成降级输出，不中断整体流程
                output = ModuleOutput(
                    module_id=module_id,
                    status="error",
                    error_message=str(output),
                    data={},
                    key_insights=[],
                    charts=[],
                )
            safe_outputs[module_id] = output
            task.module_outputs[module_id] = output
            task.completed_modules.append(module_id)
            if module_id in task.pending_modules:
                task.pending_modules.remove(module_id)
            logger.info(f"[任务 {task_id}] 模块 {module_id} 执行完成（并行批次）, 状态: {output.status}")

        completed = len(task.completed_modules)
        task.progress_percentage = int(completed / total * 100) if total else 0
        task.updated_at = datetime.now()

        # 构建每个模块的结果，缓冲后续模块
        # 使用 safe_outputs 而非原始 pairs，确保 output 始终是 ModuleOutput 对象
        results = []
        for i, module_id in enumerate(ready_modules):
            output = safe_outputs[module_id]
            next_module = self.analysis_engine.get_next_module(
                task.execution_plan,
                task.completed_modules
            )
            results.append({
                "task_id": task_id,
                "module_id": module_id,
                "status": output.status,
                "output": output,
                "progress_percentage": task.progress_percentage,
                "completed_count": completed,
                "total_count": total,
                "next_module": next_module,
                "is_final": next_module is None and i == len(ready_modules) - 1,
                "was_streamed": i == 0 and stream_callback is not None and output.status == "success",
            })

        # 第一个结果直接返回，其余放入缓冲区
        task.parallel_buffer = results[1:]
        return results[0]

    async def _run_module_pure(self, task: Any, module_id: str, stream_callback=None):
        """纯执行模块（不修改 task 状态，供并行调用）"""
        import time
        total = len(task.execution_plan.enabled_modules)
        completed = len(task.completed_modules)
        logger.info(f"[任务 {task.task_id}] 开始执行模块(并行): {module_id} "
                    f"进度: {completed}/{total}")
        start_time = time.time()
        try:
            output = await asyncio.wait_for(
                self.analysis_engine.execute_module(
                    module_id=module_id,
                    standardized_input=task.standardized_input,
                    evidence_records=task.evidence_records,
                    evidence_stats=task.evidence_stats,
                    existing_outputs=task.module_outputs,
                    stream_callback=stream_callback,
                ),
                timeout=settings.MODULE_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            elapsed = time.time() - start_time
            logger.error(f"[任务 {task.task_id}] 模块 {module_id} 并行执行超时（>{settings.MODULE_TIMEOUT_SECONDS}s，已耗时{elapsed:.1f}s）")
            raise
        elapsed = time.time() - start_time
        logger.info(f"[任务 {task.task_id}] 模块 {module_id} 完成 - 耗时: {elapsed:.2f}秒")
        return output

    async def _execute_single_module(self, task: Any, task_id: str, module_id: str, total: int, stream_callback=None) -> Dict[str, Any]:
        """执行单个模块并更新任务状态"""
        try:
            task.current_phase = f"执行模块: {module_id}"

            completed = len(task.completed_modules)
            logger.info(f"[任务 {task_id}] ========================================")
            logger.info(f"[任务 {task_id}] 开始执行模块: {module_id}")
            logger.info(f"[任务 {task_id}] 进度: {completed}/{total} ({int(completed/total*100) if total else 0}%)")
            logger.info(f"[任务 {task_id}] 已完成: {task.completed_modules}")
            logger.info(f"[任务 {task_id}] ========================================")

            import time
            start_time = time.time()

            try:
                output = await asyncio.wait_for(
                    self.analysis_engine.execute_module(
                        module_id=module_id,
                        standardized_input=task.standardized_input,
                        evidence_records=task.evidence_records,
                        evidence_stats=task.evidence_stats,
                        existing_outputs=task.module_outputs,
                        stream_callback=stream_callback,
                    ),
                    timeout=settings.MODULE_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                elapsed = time.time() - start_time
                logger.error(f"[任务 {task_id}] 模块 {module_id} 执行超时（>{settings.MODULE_TIMEOUT_SECONDS}s，已耗时{elapsed:.1f}s）")
                raise

            elapsed = time.time() - start_time

            task.module_outputs[module_id] = output
            task.completed_modules.append(module_id)
            if module_id in task.pending_modules:
                task.pending_modules.remove(module_id)

            completed = len(task.completed_modules)
            task.progress_percentage = int(completed / total * 100) if total else 0

            next_module = self.analysis_engine.get_next_module(
                task.execution_plan,
                task.completed_modules
            )

            task.updated_at = datetime.now()

            logger.info(f"[任务 {task_id}] 模块 {module_id} 执行完成 - 耗时: {elapsed:.2f}秒, 状态: {output.status}")
            if next_module:
                logger.info(f"[任务 {task_id}] 下一个模块: {next_module}")
            else:
                logger.info(f"[任务 {task_id}] 这是最后一个模块")

            return {
                "task_id": task_id,
                "module_id": module_id,
                "status": output.status,
                "output": output,
                "progress_percentage": task.progress_percentage,
                "completed_count": completed,
                "total_count": total,
                "next_module": next_module,
                "is_final": next_module is None,
                "was_streamed": stream_callback is not None and output.status == "success",
            }

        except Exception as e:
            logger.error(f"[任务 {task_id}] 模块 {module_id} 执行失败: {e}", exc_info=True)
            task.status = TaskStatus.FAILED
            task.error_message = str(e)
            task.current_phase = f"模块执行失败: {str(e)}"
            task.updated_at = datetime.now()
            raise

    async def _finalize_analysis(self, task: AnalysisTask) -> Dict[str, Any]:
        """完成分析，生成报告"""
        task.phase = AnalysisPhase.REPORTING
        task.current_phase = "报告生成"

        try:
            failure_markers = ("分析失败", "生成失败", "使用默认输出")
            invalid_modules = []
            for module_id, output in task.module_outputs.items():
                serialized = json.dumps(output.data, ensure_ascii=False, default=str)
                if output.status != "success" or any(marker in serialized for marker in failure_markers):
                    invalid_modules.append(module_id)
            if invalid_modules:
                raise RuntimeError(
                    "核心分析模块未产生有效结果: " + ", ".join(sorted(invalid_modules))
                )
            report = await self.report_generator.generate(
                task_id=task.task_id,
                input_text=task.input_text,
                standardized_input=task.standardized_input,
                execution_plan=task.execution_plan,
                module_outputs=task.module_outputs,
                evidence_stats=task.evidence_stats,
                evidence_records=task.evidence_records
            )

            task.status = TaskStatus.COMPLETED
            task.completed_at = datetime.now()
            task.progress_percentage = 100
            task.current_phase = "已完成"
            task.report = report
            task.updated_at = datetime.now()

            return {
                "task_id": task.task_id,
                "status": "completed",
                "message": "所有模块执行完毕，报告已生成",
                "report": report,
                "is_final": True
            }

        except Exception as e:
            task.status = TaskStatus.FAILED
            task.error_message = str(e)
            logger.exception(f"报告生成失败: {task.task_id}")
            raise

    # ==================== V5.0: 获取中间结果 ====================

    async def generate_report_streaming(self, task_id: str):
        """流式生成报告 - 逐章 yield (section_name, cumulative_content)"""
        task = self.tasks.get(task_id)
        if not task:
            raise ValueError(f"任务不存在: {task_id}")
        final_content = ""
        async for section_name, cumulative in self.report_generator.generate_streaming(
            task_id=task.task_id,
            input_text=task.input_text,
            standardized_input=task.standardized_input,
            execution_plan=task.execution_plan,
            module_outputs=task.module_outputs,
            evidence_stats=task.evidence_stats,
            evidence_records=task.evidence_records,
        ):
            final_content = cumulative
            yield section_name, cumulative
        # 报告流式生成完毕，更新任务状态
        task.status = TaskStatus.COMPLETED
        task.completed_at = datetime.now()
        task.progress_percentage = 100
        task.current_phase = "已完成"
        task.report = final_content
        task.updated_at = datetime.now()

    async def get_module_result(
        self,
        task_id: str,
        module_id: str
    ) -> Optional[ModuleOutput]:
        """获取特定模块的执行结果"""
        task = self.tasks.get(task_id)
        if not task:
            return None
        return task.module_outputs.get(module_id)

    async def get_all_charts(self, task_id: str) -> List[ChartInfo]:
        """获取所有已生成模块的图表"""
        task = self.tasks.get(task_id)
        if not task:
            return []
        all_charts = []
        for output in task.module_outputs.values():
            all_charts.extend(output.charts)
        return all_charts

    # ==================== 向后兼容：完整处理流程 ====================

    async def process_task(self, task_id: str) -> AnalysisTask:
        """完整处理任务 - 向后兼容"""
        task = self.tasks.get(task_id)
        if not task:
            raise ValueError(f"任务不存在: {task_id}")

        try:
            # 阶段一：检索与规划
            blueprint = await self.start_retrieval_and_planning(task_id)

            # 如果检索结果不足以继续
            if not blueprint.can_proceed:
                task.status = TaskStatus.FAILED
                task.error_message = blueprint.search_diagnostics.diagnosis if blueprint.search_diagnostics else "检索结果不足"
                return task

            # 自动确认
            await self.confirm_analysis_plan(task_id, confirmed=True)

            # 阶段二：逐步执行所有模块
            while True:
                result = await self.execute_next_module(task_id)
                if result.get("is_final"):
                    # 最后一个模块执行完成，再调用一次触发报告生成
                    logger.info(f"[任务 {task_id}] 所有模块执行完毕，触发报告生成")
                    await self.execute_next_module(task_id)
                    break

            return task

        except Exception as e:
            task.status = TaskStatus.FAILED
            task.error_message = str(e)
            task.current_phase = f"执行失败: {str(e)}"
            task.updated_at = datetime.now()
            logger.exception(f"任务 {task_id} 执行失败")
            return task

    # ==================== 任务查询方法 ====================

    async def get_task(self, task_id: str) -> Optional[AnalysisTask]:
        """获取任务"""
        return self.tasks.get(task_id)

    async def get_task_status(self, task_id: str) -> Optional[Dict[str, Any]]:
        """获取任务状态"""
        task = self.tasks.get(task_id)
        if not task:
            return None

        return {
            "task_id": task.task_id,
            "status": task.status,
            "phase": task.phase,
            "progress": {
                "current_phase": task.current_phase,
                "completed_modules": task.completed_modules,
                "pending_modules": task.pending_modules,
                "percentage": task.progress_percentage
            },
            "blueprint": task.blueprint.model_dump() if task.blueprint else None,
            "plan_confirmed": task.plan_confirmed
        }

    async def get_task_report(self, task_id: str) -> Optional[Dict[str, Any]]:
        """获取任务报告"""
        task = self.tasks.get(task_id)
        if not task or not hasattr(task, 'report') or not task.report:
            return None

        report = task.report
        return {
            "task_id": task_id,
            "status": task.status,
            "report": {
                "report_id": report.report_id,
                "title": report.title,
                "generated_at": report.generated_at,
                "format": report.format,
                "content": report.content
            }
        }

    async def get_analysis_blueprint(self, task_id: str) -> Optional[AnalysisBlueprint]:
        """V5.0: 获取分析蓝图"""
        task = self.tasks.get(task_id)
        if not task:
            return None
        return task.blueprint


# 全局任务服务实例
task_service = TaskService()
