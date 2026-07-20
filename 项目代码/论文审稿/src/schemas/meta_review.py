"""
Meta Review Schemas - 融合多规范审稿结果的数据结构
"""
from typing import List, Dict, Optional
from pydantic import BaseModel, Field
from datetime import datetime


class RubricIssue(BaseModel):
    """单个规范发现的问题"""
    rubric_name: str = Field(description="规范名称，如 prisma_2020")
    item_id: str = Field(description="条目ID")
    item_question: str = Field(description="条目问题")
    verdict: str = Field(description="判断结果: PASS/FAIL/PARTIAL/UNCERTAIN")
    evidence: str = Field(description="证据摘录")
    reasoning: str = Field(description="判断理由")
    severity: str = Field(description="严重程度: CRITICAL/MAJOR/MINOR")


class ConsolidatedIssue(BaseModel):
    """融合后的问题（可能来自多个规范的相同判断）"""
    issue_type: str = Field(default="unknown", description="问题类型，如 search_strategy_incomplete")
    title: str = Field(default="未知问题", description="问题标题")
    description: str = Field(default="", description="自然语言描述")
    severity: str = Field(default="major", description="严重程度: fatal/major/minor")
    source_rubrics: List[str] = Field(default_factory=list, description="来源规范列表")
    source_items: List[str] = Field(default_factory=list, description="来源条目ID列表")
    evidence_quotes: List[str] = Field(default_factory=list, description="证据引用")
    confidence: float = Field(default=0.7, description="置信度 0-1")
    standard_reference: str = Field(default="", description="违反的具体规范条目，如 PRISMA-ScR 第17条")
    location_in_paper: str = Field(default="", description="问题在原文中的位置，如 方法部分第4页")


class MetaReviewResult(BaseModel):
    """Meta审稿结果 - 融合多个规范的判断"""
    fatal_issues: List[ConsolidatedIssue] = Field(default_factory=list, description="致命问题")
    major_issues: List[ConsolidatedIssue] = Field(default_factory=list, description="主要问题")
    minor_issues: List[ConsolidatedIssue] = Field(default_factory=list, description="次要问题")
    key_strengths: List[str] = Field(default_factory=list, description="主要优点（自然语言）")
    overall_assessment: str = Field(default="", description="总体评价（自然语言段落）")
    recommendation: str = Field(default="major_revision", description="推荐意见: accept/minor_revision/major_revision/reject")
    confidence: float = Field(default=0.5, description="整体置信度")
    # 新增字段：模块二需要
    applied_rubrics: List[str] = Field(default_factory=list, description="实际采纳的规范列表")
    rejected_rubrics: List[Dict[str, str]] = Field(default_factory=list, description="被拒绝的规范及原因")
    hallucination_rejected: List[Dict[str, str]] = Field(default_factory=list, description="被驳回的幻觉问题")


class NarrativeReport(BaseModel):
    """自然语言审稿报告（面向客户，大纲仅作内部审查主题）"""
    title: str = Field(default="未知标题", description="稿件标题")
    outline: str = Field(default="", description="稿件大纲（内部使用，不展示）")
    overall_evaluation: str = Field(default="", description="总体评价")
    key_strengths_narrative: str = Field(default="", description="主要优点")
    critical_issues_narrative: str = Field(default="", description="修改意见（自然语言兜底）")
    minor_suggestions_narrative: str = Field(default="", description="次要建议")
    recommendation_narrative: str = Field(default="", description="推荐意见")
    recommendation: str = Field(default="major_revision", description="推荐结果")
    generated_at: datetime = Field(default_factory=datetime.now)
    technical_appendix: Optional[Dict] = Field(default=None, description="条目级详细结果")


class MultiRubricReviewResult(BaseModel):
    """多规范并行审稿的完整结果"""
    document_title: str
    rubric_results: Dict[str, List] = Field(description="各规范的原始结果")
    meta_review: MetaReviewResult = Field(description="融合后的meta审稿")
    narrative_report: NarrativeReport = Field(description="自然语言报告")
    rubrics_used: List[str] = Field(description="使用的规范列表")
    processing_time: float = Field(description="处理时间（秒）")
