"""
数据模型定义 - V5.0（支持分阶段动态分析架构）
"""
from pydantic import BaseModel, Field
from typing import List, Dict, Optional, Any, Union, Tuple
from datetime import datetime
from enum import Enum


# ==================== 枚举定义 ====================

class StudyDesign(str, Enum):
    """研究设计类型"""
    RCT = "rct"
    META = "meta"
    MR = "mr"
    COHORT = "cohort"
    MECHANISM = "mechanism"
    ANIMAL = "animal"
    IN_VITRO = "in_vitro"
    CASE_REPORT = "case_report"
    UNKNOWN = "unknown"


class ResearchStageIntent(str, Enum):
    """科研阶段意图"""
    EXPLORATION = "exploration"
    GAP_HUNTING = "gap_hunting"
    IDEA_VALIDATION = "idea_validation"
    FEASIBILITY_CHECK = "feasibility_check"
    DESIGN_HELP = "design_help"
    PUBLICATION_STRATEGY = "publication_strategy"


class QuestionStructure(str, Enum):
    """问题结构"""
    ASSOCIATION = "association_question"
    CAUSAL = "causal_question"
    COMPARATIVE = "comparative_question"
    PREDICTIVE = "predictive_question"
    MECHANISM = "mechanism_question"
    OPTIMIZATION = "optimization_question"
    EVIDENCE_SUMMARY = "evidence_summary"
    UNCERTAINTY = "uncertainty_question"


class ResearchAxis(str, Enum):
    """研究轴向"""
    TREATMENT = "treatment"
    MECHANISM = "mechanism"
    DIAGNOSIS = "diagnosis"
    PROGNOSIS = "prognosis"
    SAFETY = "safety"
    ECOLOGY = "ecology"
    EPIDEMIOLOGY = "epidemiology"


class TaskStatus(str, Enum):
    """任务状态 - V5.0扩展"""
    PENDING = "pending"
    RETRIEVING = "retrieving"  # 新增：检索中
    PLANNING = "planning"  # 新增：规划中
    WAITING_CONFIRMATION = "waiting_confirmation"  # 新增：等待用户确认
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class AnalysisPhase(str, Enum):
    """分析阶段"""
    RETRIEVAL = "retrieval"  # 检索与规划
    ANALYSIS = "analysis"  # 逐步分析
    REPORTING = "reporting"  # 报告汇总


# ==================== 输入相关模型 ====================

class CoreEntities(BaseModel):
    """核心实体 - 扩展版"""
    drugs: List[str] = []
    diseases: List[str] = []
    genes: List[str] = []
    mechanisms: List[str] = []
    outcomes: List[str] = []
    populations: List[str] = []
    interventions: List[str] = []
    comparators: List[str] = []


class PICOElements(BaseModel):
    """PICO元素"""
    population: Optional[str] = None
    intervention: Optional[str] = None
    comparison: Optional[str] = None
    outcome: Optional[str] = None


class QueryTerms(BaseModel):
    """查询词"""
    zh: List[str] = []
    en: List[str] = []


class PreprocessedInput(BaseModel):
    """预处理后的输入"""
    original: str
    cleaned: str
    language: str
    char_count: int
    word_count: int
    preliminary_type: str = "general_query"
    stage_intent_guess: str = "exploration"
    question_structure_guess: str = "association_question"
    confidence_guess: float = 0.5


class StandardizedInput(BaseModel):
    """标准化输入 - V5.0扩展"""
    core_entities: CoreEntities
    study_design_hint: StudyDesign = StudyDesign.UNKNOWN
    research_stage_intent: ResearchStageIntent = ResearchStageIntent.EXPLORATION
    question_structure: QuestionStructure = QuestionStructure.ASSOCIATION
    research_axis: ResearchAxis = ResearchAxis.TREATMENT
    query_terms: QueryTerms
    pico_elements: PICOElements = PICOElements()
    confidence: float = Field(ge=0.0, le=1.0, default=0.5)
    ambiguity_flags: List[str] = []
    research_context: str = ""
    # V5.0新增：LLM驱动的结构化查询理解
    pico_entities: Dict[str, List[str]] = Field(default_factory=dict)
    logical_structure: str = ""  # 例如: "(population AND intervention) AND outcome"


class StructuredQuery(BaseModel):
    """结构化查询 - V5.0新增"""
    pico_entities: Dict[str, List[str]] = Field(default_factory=dict)
    logical_structure: str = ""
    sub_queries: List[str] = Field(default_factory=list)  # 生成的多个子查询


# ==================== 检索相关模型 ====================

class LiteratureRecord(BaseModel):
    """文献记录"""
    id: str
    title: str
    title_zh: Optional[str] = None
    abstract: Optional[str] = None
    abstract_zh: Optional[str] = None
    authors: List[str] = []
    journal: Optional[str] = None
    publication_year: Optional[int] = None
    doi: Optional[str] = None
    pmid: Optional[str] = None
    keywords: List[str] = []
    mesh_terms: List[str] = []
    study_design: Optional[str] = None
    is_clinical: bool = False
    language: str = "en"
    citations: int = 0


class EvidenceStats(BaseModel):
    """证据统计 - V5.0扩展"""
    evidence_count: int = 0
    clinical_ratio: float = 0.0
    year_span: int = 0
    keyword_diversity: float = 0.0
    earliest_year: int = datetime.now().year
    latest_year: int = datetime.now().year
    design_distribution: Dict[str, int] = {}
    # V5.0新增：更详细的统计
    year_counts: Dict[int, int] = Field(default_factory=dict)  # 年度发文量
    author_counts: Dict[str, int] = Field(default_factory=dict)  # 作者发文量
    journal_counts: Dict[str, int] = Field(default_factory=dict)  # 期刊发文量


# ==================== 任务规划相关模型 ====================

class ExecutionGroup(BaseModel):
    """执行组"""
    group_id: int
    modules: List[str]
    parallel: bool
    estimated_time_seconds: int


class ExecutionPlan(BaseModel):
    """执行计划 - V5.0"""
    plan_id: str
    created_at: datetime
    enabled_modules: List[str]
    execution_groups: List[ExecutionGroup]
    resource_estimate: Dict[str, Any]
    adjustments: List[str] = []
    # V5.0新增：规划理由说明
    planning_reasoning: str = ""  # 为什么启用这些模块
    module_scores: Dict[str, float] = Field(default_factory=dict)  # 各模块得分


class SearchDiagnostics(BaseModel):
    """检索诊断信息"""
    status: str  # "success", "low_recall", "no_results", "error"
    retrieved_count: int = 0
    diagnosis: str = ""
    suggestions: List[str] = []
    can_proceed: bool = True


class AnalysisBlueprint(BaseModel):
    """分析蓝图 - V5.0新增"""
    """向用户展示的分析计划"""
    task_id: str
    retrieved_count: int  # 检索到的文献数
    year_range: Tuple[int, int]  # (最早年份, 最新年份)
    trend_chart_path: Optional[str] = None  # 发文趋势图路径
    planned_modules: List[str]  # 计划执行的模块
    module_descriptions: Dict[str, str] = Field(default_factory=dict)  # 模块说明
    estimated_time_seconds: int
    can_proceed: bool  # 是否可以继续
    search_diagnostics: Optional[SearchDiagnostics] = None  # 检索诊断信息


# ==================== 模块输出模型 ====================

class ChartInfo(BaseModel):
    """图表信息 - V5.0新增"""
    title: str
    path: str
    chart_type: str  # line, bar, network, heatmap, scatter, bubble
    description: str = ""


class SupportingEvidence(BaseModel):
    """支撑论据 - V5.0新增"""
    pmid: str
    title: str
    authors: List[str]
    year: int
    journal: str
    doi: Optional[str] = None
    relevance_score: float  # 相关性得分
    excerpt: str  # 相关摘录


class ModuleOutput(BaseModel):
    """模块输出 - V5.0扩展"""
    module_id: str
    status: str  # success, failed, skipped
    data: Dict[str, Any] = {}
    error_message: Optional[str] = None
    execution_time_ms: int = 0
    # V5.0新增
    charts: List[ChartInfo] = Field(default_factory=list)  # 支撑图表
    supporting_evidence: List[SupportingEvidence] = Field(default_factory=list)  # 论据支撑
    key_insights: List[str] = Field(default_factory=list)  # 关键洞察


class TopicTrend(BaseModel):
    """主题趋势"""
    topic: str
    current_stage: str
    prediction: str
    next_5_years_forecast: List[int]


class ResearchGap(BaseModel):
    """研究空白"""
    gap_id: str
    description: str
    source_modules: List[str]
    strength: float
    keywords: List[str]
    actionable_paths: List[str]
    action_priority_score: float


class BreakthroughOpportunity(BaseModel):
    """科研突破机会"""
    opportunity_id: str
    type: str
    cross_domain_source: str
    bridge_hypothesis: str
    shortest_validation_path: str
    expected_contribution: str
    priority_score: float
    feasibility_score: float
    novelty_score: float
    clinical_impact_score: float


class GeneratedTopic(BaseModel):
    """生成的选题"""
    topic_id: str
    title: str
    pico: PICOElements
    study_type: str
    novelty_score: float = Field(ge=0.0, le=1.0)
    feasibility_score: float = Field(ge=0.0, le=1.0, default=0.7)
    clinical_impact_score: float = Field(ge=0.0, le=1.0, default=0.7)
    publication_probability: float = Field(ge=0.0, le=1.0, default=0.7)
    priority_score: float = Field(ge=0.0, le=1.0, default=0.7)
    comment: str


# ==================== 报告相关模型 ====================

class AnalysisReport(BaseModel):
    """分析报告 - V5.0"""
    report_id: str
    task_id: str
    title: str
    generated_at: datetime
    format: str = "markdown"
    content: str
    module_outputs: Dict[str, ModuleOutput] = {}
    evidence_stats: Optional[EvidenceStats] = None
    download_url_pdf: Optional[str] = None
    # V5.0新增
    all_charts: List[ChartInfo] = Field(default_factory=list)  # 所有图表汇总


# ==================== 任务相关模型 ====================

class AnalysisTask(BaseModel):
    """分析任务 - V5.0扩展"""
    task_id: str
    status: TaskStatus
    input_text: str
    standardized_input: Optional[StandardizedInput] = None
    execution_plan: Optional[ExecutionPlan] = None
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None
    progress_percentage: int = 0
    current_phase: Optional[str] = None
    completed_modules: List[str] = []
    pending_modules: List[str] = []
    error_message: Optional[str] = None
    report: Optional[Any] = None
    # V5.0新增：分阶段支持
    phase: AnalysisPhase = AnalysisPhase.RETRIEVAL  # 当前阶段
    evidence_records: List[LiteratureRecord] = Field(default_factory=list)  # 检索到的文献
    evidence_stats: Optional[EvidenceStats] = None  # 证据统计
    module_outputs: Dict[str, ModuleOutput] = Field(default_factory=dict)  # 模块输出
    blueprint: Optional[AnalysisBlueprint] = None  # 分析蓝图
    plan_confirmed: bool = False  # 用户是否确认了计划
    parallel_buffer: List[Dict] = Field(default_factory=list)  # 并行批次的缓冲结果


# ==================== 对话相关模型 ====================

class ConversationIntent(str, Enum):
    """对话意图"""
    CLARIFY = "clarify"
    ASK_ON_RESULT = "ask_on_result"
    REFINE_DIRECTION = "refine_direction"
    ADD_CONSTRAINTS = "add_constraints"
    SWITCH_DESIGN = "switch_design"
    DEEPEN_MODULE = "deepen_module"
    REGENERATE_REPORT = "regenerate_report"
    COMPARE_VERSIONS = "compare_versions"


class ChangeSet(BaseModel):
    """变更集"""
    action: str
    changes: Dict[str, Any] = {}
    target_modules: List[str] = []
    need_full_rerun: bool = False
    confidence: float = 0.5


class ReportVersion(BaseModel):
    """报告版本"""
    version: int
    research_object: Dict[str, Any]
    constraints: Dict[str, Any] = {}
    module_plan: Dict[str, Any] = {}
    evidence_set_stats: Optional[EvidenceStats] = None
    report_artifact_id: Optional[str] = None
    created_at: datetime


class SessionState(BaseModel):
    """会话状态"""
    session_id: str
    current_version: int
    versions: List[ReportVersion]
    created_at: datetime
    updated_at: datetime


# ==================== API请求/响应模型 ====================

class SubmitAnalysisRequest(BaseModel):
    """提交分析请求"""
    input_text: str = Field(..., min_length=1, max_length=5000, description="用户输入的科研问题")
    task_title: Optional[str] = Field(None, description="任务标题")
    options: Dict[str, Any] = Field(default_factory=dict, description="选项配置")


class InputValidationResponse(BaseModel):
    """输入校验失败响应"""
    status: str = "validation_error"
    message: str
    suggestions: List[str] = []



class SubmitAnalysisResponse(BaseModel):
    """提交分析响应"""
    status: str
    task_id: str
    message: str
    estimated_completion_time_seconds: int


class TaskStatusResponse(BaseModel):
    """任务状态响应"""
    task_id: str
    status: TaskStatus
    phase: Optional[AnalysisPhase] = None
    progress: Optional[Dict[str, Any]] = None


class ReportResponse(BaseModel):
    """报告响应"""
    task_id: str
    status: TaskStatus
    report: Optional[Dict[str, Any]] = None


# V5.0新增API模型

class AnalysisBlueprintResponse(BaseModel):
    """分析蓝图响应"""
    task_id: str
    blueprint: AnalysisBlueprint
    message: str


class ConfirmPlanRequest(BaseModel):
    """确认分析计划请求"""
    task_id: str
    confirmed: bool = True
    skip_modules: List[str] = Field(default_factory=list)  # 用户选择跳过的模块


class ConfirmPlanResponse(BaseModel):
    """确认分析计划响应"""
    task_id: str
    status: str
    message: str
    next_module: Optional[str] = None


class ExecuteModuleResponse(BaseModel):
    """执行模块响应"""
    task_id: str
    module_id: str
    status: str
    output: Optional[ModuleOutput] = None
    progress_percentage: int
    next_module: Optional[str] = None
    is_final: bool = False  # 是否是最后一个模块


class ModuleResultResponse(BaseModel):
    """模块结果响应"""
    task_id: str
    module_id: str
    output: ModuleOutput
    all_charts: List[ChartInfo]


class FinalizeReportResponse(BaseModel):
    """完成报告响应"""
    task_id: str
    status: str
    report: Optional[AnalysisReport] = None
    download_urls: Dict[str, str] = Field(default_factory=dict)
