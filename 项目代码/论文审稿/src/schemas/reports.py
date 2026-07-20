"""
Report data structures
"""
from typing import List, Dict, Optional
from pydantic import BaseModel, Field
from datetime import datetime
from enum import Enum

from .rubric import SeverityLevel


def _get_author_labels(zh: bool) -> dict:
    """Return UI label strings for AuthorReport in the requested language."""
    if zh:
        return {
            "title": "自动预审报告",
            "manuscript": "稿件：",
            "generated": "生成时间：",
            "summary": "问题摘要",
            "col_category": "类别", "col_count": "数量", "col_priority": "处理优先级",
            "critical": "严重问题", "major": "重要问题", "minor": "次要问题", "total": "合计",
            "must_fix": "必须修改", "should_fix": "建议修改", "recommended": "建议完善",
            "guidelines_label": "适用报告规范：",
            "checklist_title": "快速处理清单",
            "checklist_subtitle": "再次投稿前需重点处理的问题：",
            "col_item": "序号", "col_desc": "问题描述", "col_type": "问题类型", "col_status": "处理状态",
            "findings_title": "详细审查结果",
            "critical_heading": "严重问题（必须修改）",
            "critical_priority": "▶ 优先级：最高 — 以下为可能导致论文无法发表的根本性缺陷。",
            "critical_action": "▶ 操作要求：再次投稿前必须解决所有严重问题。",
            "major_heading": "重要问题（建议修改）",
            "major_priority": "▶ 优先级：高 — 存在显著的方法学或报告规范问题。",
            "major_action": "▶ 操作要求：尽可能解决以提升稿件质量。",
            "minor_heading": "次要问题（建议完善）",
            "minor_priority": "▶ 优先级：中 — 可完善稿件质量的建议。",
            "minor_action": "▶ 操作要求：建议处理以提高论文的清晰度和完整性。",
            "conclusion_title": "总结",
            "issue_label": "发现的问题：",
            "fix_label": "修改建议：",
        }
    return {
        "title": "Automated Pre-Review Report",
        "manuscript": "Manuscript:",
        "generated": "Generated:",
        "summary": "Summary",
        "col_category": "Category", "col_count": "Count", "col_priority": "Priority",
        "critical": "Critical Issues", "major": "Major Issues", "minor": "Minor Issues", "total": "Total",
        "must_fix": "Must Fix", "should_fix": "Should Fix", "recommended": "Recommended",
        "guidelines_label": "Reporting Guidelines Applied:",
        "checklist_title": "Quick Action Checklist",
        "checklist_subtitle": "Priority items to address before resubmission:",
        "col_item": "No.", "col_desc": "Issue Description", "col_type": "Type", "col_status": "Status",
        "findings_title": "Detailed Findings",
        "critical_heading": "Critical Issues (Must Fix)",
        "critical_priority": "Priority Level: HIGHEST - These are fundamental flaws that may prevent publication.",
        "critical_action": "Action Required: Address ALL critical issues before resubmission.",
        "major_heading": "Major Issues (Should Fix)",
        "major_priority": "Priority Level: HIGH - Significant methodological or reporting concerns.",
        "major_action": "Action Required: Address as many as possible to strengthen the manuscript.",
        "minor_heading": "Minor Issues (Recommended)",
        "minor_priority": "Priority Level: MODERATE - Improvements that enhance manuscript quality.",
        "minor_action": "Action Required: Consider addressing to improve overall clarity and completeness.",
        "conclusion_title": "Conclusion",
        "issue_label": "Issue Identified:",
        "fix_label": "How to Fix:",
    }


def _get_editor_labels(zh: bool) -> dict:
    """Return UI label strings for EditorReport in the requested language."""
    if zh:
        return {
            "title": "编辑预审报告",
            "manuscript": "稿件：",
            "generated": "生成时间：",
            "score_section": "多维度评估",
            "dim_col": "评估维度", "basis_col": "评估依据", "score_col": "得分", "rating_col": "评级",
            "dim_reporting": "报告规范性",
            "basis_reporting": "适用规范（CONSORT/STROBE/PRISMA等）全部条目的核查通过率；每条按通过/部分通过/未通过评分",
            "dim_rigor": "方法严谨性",
            "basis_rigor": "报告规范得分扣除问题罚分（严重问题各 −15 分，重要问题各 −5 分，次要问题各 −2 分）；反映方法学质量与可重复性",
            "dim_novelty": "研究新颖性",
            "basis_novelty": "AI认知审查：与现有文献相比的原创程度、研究问题的独特性、研究发现是否挑战现有认知",
            "dim_contribution": "科学贡献度",
            "basis_contribution": "AI认知审查：证据强度、临床/实践相关性、结论可推广性，以及对未来研究或指南的潜在影响力",
            "score_calc_guide": """> **各维度计算方式：**
> - **报告规范性** — 核查表通过率：CONSORT/STROBE/PRISMA 等规范条目中完全符合的比例
> - **方法严谨性** — 报告规范得分扣除罚分：每个严重问题 −15 分，每个重要问题 −5 分，每个次要问题 −2 分
> - **研究新颖性** — AI 认知审查对原创性与现有文献对比的评估（0–100）
> - **科学贡献度** — AI 认知审查对科学推进程度与领域影响力的评估（0–100）""",
            "score_rating_guide": """> **评分标准**
>
> | **分数区间** | **评级** | **含义** |
> |----------|------|------|
> | 80 – 100 | 优秀 | 达到或超过发表标准，问题极少 |
> | 60 – 79 | 良好 | 存在少量不足，经适度修改可达标 |
> | 40 – 59 | 一般 | 存在中度问题，需大幅修改方可接受 |
> | 0 – 39 | 较差 | 存在重大缺陷，不经重大修改难以发表 |""",
            "score_result_title": "### 评分结果",
            "recommendation_section": "综合处理建议",
            "decision_label": "建议决定：",
            "primary_reason_label": "主要原因：",
            "rules_label": "适用的决策规则：",
            "factors_label": "支撑因素：",
            "compliance_section": "A) 报告规范性与可重复性",
            "based_on_label": "评审依据：",
            "checklist_table_title": "规范条目符合情况",
            "checklist_detail_title": "#### 条目核查明细",
            "col_item_id": "条目编号", "col_item_question": "条目内容", "col_verdict": "符合情况",
            "summary_label": "总体情况",
            "key_issues_label": "主要问题",
            "reporting_issues_label": "报告规范问题",
            "method_issues_label": "方法学问题",
            "rubric_evidence_label": "评分依据（核查表）",
            "methodology_section": "A2) 方法学专业度与论文撰写规范",
            "methodology_label": "方法学专业度评估",
            "science_section": "B) 科学价值与学术贡献",
            "novelty_label": "研究新颖性评估",
            "contribution_label": "学术贡献评估",
            "strengths_label": "主要优点",
            "weaknesses_label": "主要不足",
            "fatal_label": "致命缺陷",
            "cognitive_evidence_label": "认知审查依据",
            "uncertainty_section": "不确定性与证据质量",
            "total_items_label": "评估条目总数：",
            "uncertain_label": "不确定判断数：",
            "llm_assist_label": "AI推断辅助条目：",
            "llm_assist_note": "项 — 以下条目在原文中未能找到直接对应文字，由AI根据上下文进行推断评估，结论仅供参考，建议人工核查。",
            "unlocated_label": "未能定位到原文证据的条目",
            "unlocated_note": "以下条目在原文中未找到对应段落，评判结果为 UNCERTAIN，建议人工核查：",
            "low_conf_label": "低置信度条目",
            "warning_label": "注意：",
            "editor_note": "编辑注意：以上标注为 UNCERTAIN 或低置信度的条目，可能为证据检索失败所致，而非确认存在缺陷，建议人工复核。",
            "col_num": "#", "col_item": "清单条目", "col_desc": "问题描述",
        }
    return {
        "title": "Editor Pre-Review Report (Enhanced)",
        "manuscript": "Manuscript:",
        "generated": "Generated:",
        "score_section": "Multi-Dimensional Assessment",
        "dim_col": "Dimension", "basis_col": "Assessment Basis", "score_col": "Score", "rating_col": "Rating",
        "dim_reporting": "Reporting",
        "basis_reporting": "Checklist compliance rate across all applicable guideline items (CONSORT / STROBE / PRISMA etc.); each item scored as Pass / Partial / Fail",
        "dim_rigor": "Rigor",
        "basis_rigor": "Reporting score minus issue deductions (−15 per critical, −5 per major, −2 per minor issue); reflects methodological soundness and reproducibility",
        "dim_novelty": "Novelty",
        "basis_novelty": "AI cognitive assessment of originality: incremental advance vs. existing literature, uniqueness of research question, and whether findings challenge current knowledge",
        "dim_contribution": "Contribution",
        "basis_contribution": "AI cognitive assessment of scientific impact: strength of evidence, clinical/practical relevance, generalisability, and potential to influence future research or guidelines",
        "score_calc_guide": """> **How scores are calculated:**
> - **Reporting** — Checklist pass rate: proportion of guideline items (CONSORT/STROBE/PRISMA etc.) fully satisfied
> - **Rigor** — Reporting score minus deductions: −15 per critical issue, −5 per major issue, −2 per minor issue
> - **Novelty** — AI cognitive assessment of originality vs. existing literature (0–100)
> - **Contribution** — AI cognitive assessment of scientific advancement and field impact (0–100)""",
        "score_rating_guide": """> **Scoring Guide**
>
> | **Score Range** | **Rating** | **Meaning** |
> |-------------|--------|---------|
> | 80 – 100 | Excellent | Meets or exceeds publication standards with minimal issues |
> | 60 – 79 | Good | Minor gaps that can be addressed with moderate revision |
> | 40 – 59 | Fair | Moderate issues requiring substantial revision before acceptance |
> | 0 – 39 | Poor | Major deficiencies that may prevent publication without major rework |""",
        "score_result_title": "### Score Results",
        "recommendation_section": "Final Recommendation",
        "decision_label": "Decision:",
        "primary_reason_label": "Primary Reason:",
        "rules_label": "Decision Rules Applied:",
        "factors_label": "Supporting Factors:",
        "compliance_section": "A) Compliance & Reproducibility",
        "based_on_label": "Based on:",
        "checklist_table_title": "Checklist Compliance",
        "checklist_detail_title": "#### Item-by-Item Results",
        "col_item_id": "Item", "col_item_question": "Criterion", "col_verdict": "Status",
        "summary_label": "Summary",
        "key_issues_label": "Key Issues",
        "reporting_issues_label": "Reporting Issues",
        "method_issues_label": "Methodological Issues",
        "rubric_evidence_label": "Evidence from Rubric",
        "methodology_section": "A2) Methodological Professionalism & Writing Standards",
        "methodology_label": "Methodology Assessment",
        "science_section": "B) Scientific Value & Contribution",
        "novelty_label": "Novelty Assessment",
        "contribution_label": "Contribution Assessment",
        "strengths_label": "Key Strengths",
        "weaknesses_label": "Key Weaknesses",
        "fatal_label": "Fatal Flaws",
        "cognitive_evidence_label": "Evidence from Cognitive Review",
        "uncertainty_section": "Uncertainty & Evidence Quality",
        "total_items_label": "Total Items Evaluated:",
        "uncertain_label": "Uncertain Verdicts:",
        "llm_assist_label": "AI-inferred items:",
        "llm_assist_note": "items — direct textual evidence could not be located for these items; the AI inferred an assessment from surrounding context. Results are indicative only and should be manually verified.",
        "unlocated_label": "Items with unlocated evidence",
        "unlocated_note": "The following checklist items could not be matched to specific text passages in the manuscript. Verdicts for these items are marked as UNCERTAIN and should be manually verified:",
        "low_conf_label": "Low confidence items",
        "warning_label": "Warning:",
        "editor_note": "Note for Editors: Items marked as UNCERTAIN or with low confidence may represent evidence retrieval failures rather than confirmed deficiencies. Manual verification is recommended for these items.",
        "col_num": "#", "col_item": "Checklist Item", "col_desc": "Issue Description",
    }


class MultiDimensionalScore(BaseModel):
    """Multi-dimensional assessment scores (replacing single 0-100 score)"""
    reporting: float = Field(
        ...,
        ge=0.0,
        le=100.0,
        description="Reporting quality: completeness and clarity of reporting (based on rubric)"
    )
    rigor: float = Field(
        ...,
        ge=0.0,
        le=100.0,
        description="Methodological rigor: study design, execution, and analysis quality (based on rubric)"
    )
    novelty: float = Field(
        ...,
        ge=0.0,
        le=100.0,
        description="Novelty: originality and innovation (based on cognitive review)"
    )
    contribution: float = Field(
        ...,
        ge=0.0,
        le=100.0,
        description="Scientific contribution: impact and advancement of knowledge (based on cognitive review)"
    )

    def to_dict(self) -> Dict[str, float]:
        return {
            "reporting": self.reporting,
            "rigor": self.rigor,
            "novelty": self.novelty,
            "contribution": self.contribution
        }


class UncertaintyMetrics(BaseModel):
    """Metrics about retrieval uncertainty and potential false positives"""
    total_items_evaluated: int = Field(..., description="Total rubric items evaluated")
    uncertain_count: int = Field(..., description="Number of UNCERTAIN verdicts")
    uncertain_percentage: float = Field(..., description="Percentage of UNCERTAIN verdicts")
    stage3_fallback_count: int = Field(..., description="Number of times Stage 3 (LLM fallback) was used")
    unlocated_items: List[str] = Field(
        default_factory=list,
        description="List of item IDs where evidence could not be located"
    )
    low_confidence_items: List[str] = Field(
        default_factory=list,
        description="List of item IDs with confidence < 0.5"
    )
    warning_message: Optional[str] = Field(
        default=None,
        description="Warning message if uncertainty is high"
    )


class FusedDecision(str, Enum):
    """Fused editorial decision"""
    ACCEPT = "ACCEPT"
    MINOR_REVISION = "MINOR_REVISION"
    MAJOR_REVISION = "MAJOR_REVISION"
    REJECT = "REJECT"


class DecisionRationale(BaseModel):
    """Detailed rationale for the fused decision"""
    decision: FusedDecision = Field(..., description="Final editorial decision")
    primary_reason: str = Field(..., description="Primary reason for this decision")
    supporting_factors: List[str] = Field(
        default_factory=list,
        description="Supporting factors from rubric and cognitive review"
    )
    rubric_evidence: List[str] = Field(
        default_factory=list,
        description="Key evidence from rubric evaluation"
    )
    cognitive_evidence: List[str] = Field(
        default_factory=list,
        description="Key evidence from cognitive review"
    )
    decision_rules_applied: List[str] = Field(
        default_factory=list,
        description="Decision rules that were applied"
    )


class IssueItem(BaseModel):
    """A single issue identified in the manuscript"""
    category: str = Field(..., description="Issue category, e.g., 'Randomization', 'Statistics'")
    severity: SeverityLevel
    description: str = Field(..., description="Description of the issue")
    evidence: List[str] = Field(default_factory=list, description="Supporting evidence quotes")
    recommendation: str = Field(..., description="Actionable fix recommendation")
    checklist_reference: str = Field(..., description="Source checklist item, e.g., 'CONSORT 8a'")


class AuthorReport(BaseModel):
    """
    Report for manuscript authors.
    Focuses on constructive feedback and actionable recommendations.
    """
    job_id: str
    manuscript_title: str
    generated_at: datetime = Field(default_factory=datetime.now)
    language: str = Field(default="en", description="Report language: 'en' or 'zh'")

    # Greeting and introduction
    introduction: str = Field(
        default="Thank you for your submission. Our automated pre-review system has conducted a preliminary assessment of your manuscript based on international reporting guidelines."
    )

    # Issues organized by severity
    critical_issues: List[IssueItem] = Field(default_factory=list)
    major_issues: List[IssueItem] = Field(default_factory=list)
    minor_issues: List[IssueItem] = Field(default_factory=list)

    # Summary statistics
    total_issues: int = 0
    checklists_applied: List[str] = Field(default_factory=list)

    # Closing statement
    conclusion: str = Field(
        default="Please address the issues identified above before resubmission. For questions about specific recommendations, please consult the relevant reporting guidelines."
    )

    # Disclaimer
    disclaimer: str = Field(
        default="This report was generated with AI assistance and is for reference only. It does not constitute a final peer-review decision."
    )

    def to_markdown(self) -> str:
        """Generate markdown formatted report in the detected language."""
        zh = self.language == "zh"

        T = _get_author_labels(zh)

        lines = [
            f"# {T['title']}",
            f"",
            f"**{T['manuscript']}** **{self.manuscript_title}**",
            f"",
            f"**{T['generated']}** {self.generated_at.strftime('%Y-%m-%d %H:%M:%S')}",
            f"",
            f"---",
            f"",
            f"## {T['summary']}",
            f"",
            f"| **{T['col_category']}** | **{T['col_count']}** | **{T['col_priority']}** |",
            f"|----------|-------|----------|",
            f"| {T['critical']} | {len(self.critical_issues)} | {T['must_fix']} |",
            f"| {T['major']} | {len(self.major_issues)} | {T['should_fix']} |",
            f"| {T['minor']} | {len(self.minor_issues)} | {T['recommended']} |",
            f"| {T['total']} | {self.total_issues} | |",
            f"",
            f"**{T['guidelines_label']}** {', '.join(self.checklists_applied)}",
            f"",
        ]

        has_issues = len(self.critical_issues) + len(self.major_issues) + len(self.minor_issues) > 0
        if has_issues:
            lines.extend([
                f"## {T['checklist_title']}",
                f"",
                T['checklist_subtitle'],
                f"",
                f"| **{T['col_item']}** | **{T['col_desc']}** | **{T['col_type']}** | **{T['col_status']}** |",
                f"|---------------|-------------------|--------|--------|",
            ])

            idx = 1
            for issue in self.critical_issues:
                desc = issue.description.replace("|", "\\|")
                lines.append(f"| {idx} | {desc} | {T['critical']} | {T['must_fix']} |")
                idx += 1

            for issue in self.major_issues:
                desc = issue.description.replace("|", "\\|")
                lines.append(f"| {idx} | {desc} | {T['major']} | {T['should_fix']} |")
                idx += 1

            for issue in self.minor_issues:
                desc = issue.description.replace("|", "\\|")
                lines.append(f"| {idx} | {desc} | {T['minor']} | {T['recommended']} |")
                idx += 1

            lines.extend([f"", f"---", f""])

        lines.extend([f"## {T['findings_title']}", f""])

        if self.critical_issues:
            lines.extend([
                f"### {T['critical_heading']}",
                f"",
                f"**{T['critical_priority']}**",
                f"**{T['critical_action']}**",
                f"",
            ])
            for idx, issue in enumerate(self.critical_issues, 1):
                lines.extend(self._format_issue(idx, issue, T['issue_label'], T['fix_label']))

        if self.major_issues:
            lines.extend([
                f"### {T['major_heading']}",
                f"",
                f"**{T['major_priority']}**",
                f"**{T['major_action']}**",
                f"",
            ])
            for idx, issue in enumerate(self.major_issues, 1):
                lines.extend(self._format_issue(idx, issue, T['issue_label'], T['fix_label']))

        if self.minor_issues:
            lines.extend([
                f"### {T['minor_heading']}",
                f"",
                f"**{T['minor_priority']}**",
                f"**{T['minor_action']}**",
                f"",
            ])
            for idx, issue in enumerate(self.minor_issues, 1):
                lines.extend(self._format_issue(idx, issue, T['issue_label'], T['fix_label']))

        _disclaimer = "本报告由 AI 辅助生成，仅供参考，不构成最终同行评审意见。" if self.language == "zh" else self.disclaimer
        lines.extend([
            f"", f"---", f"",
            f"## {T['conclusion_title']}",
            f"",
            f"{self.conclusion}",
            f"",
            f"---",
            f"",
            f"*{_disclaimer}*",
        ])

        return "\n".join(lines)

    def _format_issue(self, number: int, issue: IssueItem, issue_label: str = "Issue Identified:", fix_label: str = "How to Fix:") -> List[str]:
        """Format a single issue for markdown output with enhanced actionability"""
        zh = self.language == "zh"
        if zh:
            # 去掉 category 中的规范前缀（如 "PRISMA" / "PRISMA_6"），直接用序号+主题
            category = issue.category
            # 若 category 形如 "PRISMA" 或 "PRISMA_6" 则用通用标题
            import re as _re
            if _re.match(r'^[A-Z_0-9]+$', category.strip()):
                heading = f"问题{number}"
            else:
                heading = f"问题{number}：{category}"
            lines = [
                f"#### {heading}",
                f"",
                f"**{issue_label}** {issue.description}",
                f"",
                f"**{fix_label}** {issue.recommendation}",
                f"",
                f"---",
                f"",
            ]
        else:
            lines = [
                f"#### {number}. {issue.category}",
                f"",
                f"**{issue_label}** {issue.description}",
                f"",
                f"**{fix_label}** {issue.recommendation}",
                f"",
                f"---",
                f"",
            ]
        return lines


class EditorDecision(str):
    """Recommended decision for editor"""
    REJECT = "REJECT"
    MAJOR_REVISION = "MAJOR_REVISION"
    MINOR_REVISION = "MINOR_REVISION"
    SEND_FOR_REVIEW = "SEND_FOR_REVIEW"


class EditorReport(BaseModel):
    """
    Enhanced editor report with fused decision-making.

    Structure:
    A) Compliance & Reproducibility (based on rubric)
    B) Scientific Value & Contribution (based on cognitive review)
    C) Final Recommendation (fused decision)
    """
    job_id: str
    manuscript_title: str
    generated_at: datetime = Field(default_factory=datetime.now)
    language: str = Field(default="en", description="Report language: 'en' or 'zh'")

    # Multi-dimensional scores (replacing single overall score)
    scores: MultiDimensionalScore = Field(..., description="Multi-dimensional assessment scores")

    # A) Compliance & Reproducibility Section
    compliance_summary: str = Field(..., description="Summary of rubric compliance")
    reporting_issues: List[IssueItem] = Field(default_factory=list, description="Reporting-related issues")
    methodological_issues: List[IssueItem] = Field(default_factory=list, description="Methodology-related issues")
    all_rubric_items: List[Dict] = Field(default_factory=list, description="All rubric items with verdict: [{item_id, question, verdict}]")

    # A2) Methodology Assessment Section
    methodology_assessment: str = Field(default="", description="Assessment of methodological professionalism and writing standards")

    # B) Scientific Value & Contribution Section
    novelty_assessment: str = Field(..., description="Assessment of novelty from cognitive review")
    contribution_assessment: str = Field(..., description="Assessment of contribution from cognitive review")
    key_strengths: List[str] = Field(default_factory=list, description="Key strengths identified")
    key_weaknesses: List[str] = Field(default_factory=list, description="Key weaknesses identified")
    fatal_flaws: List[str] = Field(default_factory=list, description="Fatal flaws if any")

    # C) Final Recommendation (Fused Decision)
    decision_rationale: DecisionRationale = Field(..., description="Detailed decision rationale")

    # Uncertainty & False Positive Protection
    uncertainty_metrics: UncertaintyMetrics = Field(..., description="Metrics about retrieval uncertainty")

    # Legacy fields (for backward compatibility)
    recommendation: str = Field(..., description="Overall recommendation")
    executive_summary: str = Field(..., description="Brief summary of key findings")
    critical_risks: List[str] = Field(default_factory=list)
    major_risks: List[str] = Field(default_factory=list)
    study_types_identified: List[str] = Field(default_factory=list)
    checklists_applied: List[str] = Field(default_factory=list)
    total_issues: int = 0
    critical_count: int = 0
    major_count: int = 0
    minor_count: int = 0

    # Deprecated fields (kept for compatibility)
    overall_quality_score: float = Field(default=0.0, description="DEPRECATED: Use scores.reporting instead")
    reporting_completeness_score: float = Field(default=0.0, description="DEPRECATED: Use scores.reporting")
    methodological_rigor_score: float = Field(default=0.0, description="DEPRECATED: Use scores.rigor")

    security_alerts: List[str] = Field(default_factory=list)
    disclaimer: str = Field(
        default="This report was generated with AI assistance for pre-screening purposes only. Final editorial decisions should be based on comprehensive peer review."
    )

    def _score_to_rating(self, score: float) -> str:
        """Convert numerical score to qualitative rating"""
        zh = self.language == "zh"
        if score >= 80:
            return "优秀" if zh else "Excellent"
        elif score >= 60:
            return "良好" if zh else "Good"
        elif score >= 40:
            return "一般" if zh else "Fair"
        else:
            return "较差" if zh else "Poor"

    def to_markdown(self) -> str:
        """Generate markdown formatted editor report in the detected language."""
        T = _get_editor_labels(self.language == "zh")

        lines = [
            f"# {T['title']}",
            f"",
            f"**{T['manuscript']}** **{self.manuscript_title}**",
            f"",
            f"**{T['generated']}** {self.generated_at.strftime('%Y-%m-%d %H:%M:%S')}",
            f"",
            f"---",
            f"",
            f"## {T['score_section']}",
            f"",
            T['score_calc_guide'],
            f"",
            T['score_rating_guide'],
            f"",
            T['score_result_title'],
            f"",
            f"| **{T['dim_col']}** | **{T['basis_col']}** | **{T['score_col']}** | **{T['rating_col']}** |",
            f"|-----------|-------|-------|--------|",
            f"| {T['dim_reporting']} | {T['basis_reporting']} | {self.scores.reporting:.1f}/100 | {self._score_to_rating(self.scores.reporting)} |",
            f"| {T['dim_rigor']} | {T['basis_rigor']} | {self.scores.rigor:.1f}/100 | {self._score_to_rating(self.scores.rigor)} |",
            f"| {T['dim_novelty']} | {T['basis_novelty']} | {self.scores.novelty:.1f}/100 | {self._score_to_rating(self.scores.novelty)} |",
            f"| {T['dim_contribution']} | {T['basis_contribution']} | {self.scores.contribution:.1f}/100 | {self._score_to_rating(self.scores.contribution)} |",
        ]
        # 总分行：四个维度各占25%
        total_score = (self.scores.reporting + self.scores.rigor + self.scores.novelty + self.scores.contribution) / 4
        zh = self.language == "zh"
        total_label = "综合总分（各维度25%）" if zh else "Overall Score (25% each)"
        total_basis = "四维度加权平均" if zh else "Weighted average of all dimensions"
        _decision_zh = {
            "REJECT": "拒稿", "MAJOR_REVISION": "大修", "MINOR_REVISION": "小修",
            "ACCEPT": "接受", "SEND_FOR_REVIEW": "送审"
        }
        _zh = self.language == "zh"
        decision_display = _decision_zh.get(self.decision_rationale.decision.value, self.decision_rationale.decision.value) if _zh else self.decision_rationale.decision.value
        lines.extend([
            f"| {total_label} | {total_basis} | {total_score:.1f}/100 | {self._score_to_rating(total_score)} |",
            f"",
            f"---",
            f"",
            f"## {T['recommendation_section']}",
            f"",
            f"**{T['decision_label']} {decision_display}**",
            f"",
            f"**{T['primary_reason_label']}** {self.decision_rationale.primary_reason}",
            f"",
        ])

        if self.decision_rationale.decision_rules_applied:
            lines.extend([f"**{T['rules_label']}**", f""])
            for rule in self.decision_rationale.decision_rules_applied:
                lines.append(f"- {rule}")
            lines.append(f"")

        if self.decision_rationale.supporting_factors:
            lines.extend([f"**{T['factors_label']}**", f""])
            for factor in self.decision_rationale.supporting_factors:
                lines.append(f"- {factor}")
            lines.append(f"")

        # 提取规范名称前缀（如 "PRISMA_6" → "PRISMA"）
        clean_checklists = list(dict.fromkeys(
            c.split("_")[0] for c in self.checklists_applied
        )) if self.checklists_applied else []
        lines.extend([
            f"---",
            f"",
            f"## {T['compliance_section']}",
            f"",
            f"**{T['based_on_label']}** {', '.join(clean_checklists)}",
            f"",
            f"### {T['summary_label']}",
            f"{self.compliance_summary}",
            f"",
        ])

        if self.all_rubric_items:
            verdict_map = {
                "PASS": "Y", "FAIL": "N", "PARTIAL": "△", "UNCERTAIN": "?",
            }
            zh = self.language == "zh"
            if zh:
                symbol_note = (
                    "| **符号** | **含义** |\n"
                    "|:---:|------|\n"
                    "| Y | 符合 |\n"
                    "| N | 不符合 |\n"
                    "| △ | 部分符合 |\n"
                    "| ? | 无法判断 |"
                )
            else:
                symbol_note = (
                    "| **Symbol** | **Meaning** |\n"
                    "|:---:|------|\n"
                    "| Y | Pass |\n"
                    "| N | Fail |\n"
                    "| △ | Partial |\n"
                    "| ? | Uncertain |"
                )
            lines.extend([
                f"### {T['checklist_table_title']}",
                f"",
                symbol_note,
                f"",
                T['checklist_detail_title'],
                f"",
                f"| **{T['col_item_id']}** | **{T['col_item_question']}** | **{T['col_verdict']}** |",
                f"|---|---|:---:|",
            ])
            import re as _re

            def _item_sort_key(it):
                """Sort by checklist prefix then numeric item number (e.g. PRISMA_10 < PRISMA_10a < PRISMA_11)."""
                iid = it.get("item_id", "")
                m = _re.match(r'^([A-Z]+)_(\d+)(.*)', iid)
                if m:
                    return (m.group(1), int(m.group(2)), m.group(3))
                return (iid, 0, "")

            sorted_items = sorted(self.all_rubric_items, key=_item_sort_key)
            for seq, item in enumerate(sorted_items, 1):
                raw_id = item.get("item_id", "")
                # Convert "PRISMA_4", "CONSORT_8a" etc. to "PRISMA-4", "CONSORT-8a"
                # keeping the checklist prefix + item number for traceability
                m = _re.match(r'^([A-Z]+)_(.+)$', raw_id)
                if m:
                    item_id = f"{m.group(1)}-{m.group(2)}"
                else:
                    item_id = raw_id if raw_id else str(seq)
                item_id = item_id.replace("|", "\\|")
                question = item.get("question", "").replace("|", "\\|")
                verdict_raw = item.get("verdict", "UNCERTAIN").upper()
                verdict_symbol = verdict_map.get(verdict_raw, "?")
                lines.append(f"| {item_id} | {question} | {verdict_symbol} |")
            lines.append(f"")

        if self.decision_rationale.rubric_evidence:
            lines.extend([f"### {T['rubric_evidence_label']}", f""])
            for evidence in self.decision_rationale.rubric_evidence:
                lines.append(f"> {evidence}")
            lines.append(f"")

        if self.methodology_assessment:
            lines.extend([
                f"---",
                f"",
                f"## {T['methodology_section']}",
                f"",
                f"### {T['methodology_label']}",
                f"{self.methodology_assessment}",
                f"",
            ])

        lines.extend([
            f"---",
            f"",
            f"## {T['science_section']}",
            f"",
            f"### {T['novelty_label']}",
            f"{self.novelty_assessment}",
            f"",
            f"### {T['contribution_label']}",
            f"{self.contribution_assessment}",
            f"",
        ])

        if self.key_strengths:
            lines.extend([f"### {T['strengths_label']}", f""])
            for strength in self.key_strengths:
                lines.append(f"- {strength}")
            lines.append(f"")

        if self.key_weaknesses:
            lines.extend([f"### {T['weaknesses_label']}", f""])
            for weakness in self.key_weaknesses:
                lines.append(f"- {weakness}")
            lines.append(f"")

        if self.decision_rationale.cognitive_evidence:
            lines.extend([f"### {T['cognitive_evidence_label']}", f""])
            for evidence in self.decision_rationale.cognitive_evidence:
                lines.append(f"> {evidence}")
            lines.append(f"")

        if self.fatal_flaws:
            lines.extend([f"### {T['fatal_label']}", f""])
            for flaw in self.fatal_flaws:
                lines.append(f"- {flaw}")
            lines.append(f"")

        _editor_disclaimer = "本报告由 AI 辅助生成，仅供预审参考，最终录用决定应基于完整的同行评审。" if self.language == "zh" else self.disclaimer
        lines.extend([
            f"---",
            f"",
            f"*{_editor_disclaimer}*",
        ])

        return "\n".join(lines)
