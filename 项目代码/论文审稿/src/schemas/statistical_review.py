"""
Statistical Review Schemas - 统计方法审查的数据结构
"""
from typing import List, Optional, Dict
from pydantic import BaseModel, Field
from enum import Enum


class StatisticalCheckSeverity(str, Enum):
    """统计检查项缺失的严重程度"""
    CRITICAL = "CRITICAL"
    MAJOR = "MAJOR"
    MINOR = "MINOR"


class StatisticalCheckStatus(str, Enum):
    """统计检查项的状态"""
    PASS = "PASS"              # 检查项满足
    FAIL = "FAIL"              # 检查项不满足
    PARTIAL = "PARTIAL"        # 部分满足
    NOT_APPLICABLE = "NOT_APPLICABLE"  # 不适用
    UNCERTAIN = "UNCERTAIN"    # 无法确定


class StatisticalCheck(BaseModel):
    """单个统计检查项的定义"""
    check_id: str = Field(..., description="检查项ID，如 'sample_size_calculation'")
    name: str = Field(..., description="检查项名称")
    description: str = Field(..., description="检查项详细描述")
    keywords: List[str] = Field(default_factory=list, description="用于检索的关键词")
    severity_if_missing: StatisticalCheckSeverity = Field(
        default=StatisticalCheckSeverity.MAJOR,
        description="如果缺失该项的严重程度"
    )


class StatisticalCheckResult(BaseModel):
    """单个统计检查项的评审结果"""
    check_id: str = Field(..., description="检查项ID")
    check_name: str = Field(..., description="检查项名称")
    status: StatisticalCheckStatus = Field(..., description="检查状态")
    confidence: float = Field(..., ge=0.0, le=1.0, description="置信度 (0-1)")

    evidence_found: List[str] = Field(
        default_factory=list,
        description="找到的证据文本片段"
    )
    evidence_location: List[str] = Field(
        default_factory=list,
        description="证据在文档中的位置"
    )

    missing_detail: Optional[str] = Field(
        default=None,
        description="如果FAIL或PARTIAL，说明缺少什么"
    )

    recommendation: Optional[str] = Field(
        default=None,
        description="改进建议"
    )

    severity: StatisticalCheckSeverity = Field(
        default=StatisticalCheckSeverity.MAJOR,
        description="问题严重程度"
    )


class StudyTypeStatisticalRules(BaseModel):
    """特定研究类型的统计审查规则集"""
    study_type: str = Field(..., description="研究类型，如 'RCT'")
    description: str = Field(..., description="研究类型描述")

    required_checks: List[str] = Field(
        default_factory=list,
        description="必需的统计检查项ID列表"
    )
    recommended_checks: List[str] = Field(
        default_factory=list,
        description="推荐的统计检查项ID列表"
    )
    not_applicable_checks: List[str] = Field(
        default_factory=list,
        description="不适用的统计检查项ID列表"
    )


class StatisticalReviewResult(BaseModel):
    """完整的统计审查结果"""
    study_types: List[str] = Field(..., description="识别的研究类型")

    check_results: List[StatisticalCheckResult] = Field(
        default_factory=list,
        description="所有检查项的结果"
    )

    # 统计汇总
    total_checks: int = Field(default=0, description="总检查项数")
    required_checks_count: int = Field(default=0, description="必需检查项数")
    passed_required: int = Field(default=0, description="通过的必需检查项数")
    failed_required: int = Field(default=0, description="未通过的必需检查项数")

    critical_issues: List[StatisticalCheckResult] = Field(
        default_factory=list,
        description="严重问题列表"
    )
    major_issues: List[StatisticalCheckResult] = Field(
        default_factory=list,
        description="主要问题列表"
    )
    minor_issues: List[StatisticalCheckResult] = Field(
        default_factory=list,
        description="次要问题列表"
    )

    overall_assessment: str = Field(
        default="",
        description="总体评估"
    )

    statistical_rigor_score: float = Field(
        default=0.0,
        ge=0.0,
        le=100.0,
        description="统计严谨性评分 (0-100)"
    )

    execution_time_seconds: float = Field(default=0.0, description="执行时间（秒）")


class StatisticalRuleSet(BaseModel):
    """完整的统计规则集配置"""
    study_type_rules: Dict[str, StudyTypeStatisticalRules] = Field(
        default_factory=dict,
        description="各研究类型的规则映射"
    )

    check_definitions: Dict[str, StatisticalCheck] = Field(
        default_factory=dict,
        description="所有检查项的定义映射"
    )

    def get_rules_for_study_type(self, study_type: str) -> Optional[StudyTypeStatisticalRules]:
        """获取特定研究类型的规则"""
        return self.study_type_rules.get(study_type)

    def get_check_definition(self, check_id: str) -> Optional[StatisticalCheck]:
        """获取检查项定义"""
        return self.check_definitions.get(check_id)
