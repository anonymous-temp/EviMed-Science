"""
Cognitive Review Schemas - High-level manuscript assessment
"""
from typing import List, Optional
from pydantic import BaseModel, Field


class FatalFlaw(BaseModel):
    """A fatal methodological or logical flaw"""
    flaw_type: str = Field(default="unknown", description="Type of flaw (e.g., 'selection_bias', 'confounding', 'overgeneralization')")
    description: str = Field(default="", description="Detailed description of the flaw")
    evidence: str = Field(default="", description="Evidence from the manuscript")
    impact: str = Field(default="", description="Why this is fatal to the study's validity")
    severity: float = Field(default=0.8, ge=0.0, le=1.0, description="Severity score (0-1)")


class KeyStrength(BaseModel):
    """A key strength of the research"""
    strength_type: str = Field(default="unknown", description="Type of strength (e.g., 'novel_method', 'large_sample', 'rigorous_design')")
    description: str = Field(default="", description="Detailed description of the strength")
    evidence: str = Field(default="", description="Evidence from the manuscript")
    impact: str = Field(default="", description="Why this strengthens the study")


class KeyWeakness(BaseModel):
    """A key weakness of the research"""
    weakness_type: str = Field(default="unknown", description="Type of weakness (e.g., 'limited_generalizability', 'small_sample', 'unclear_methods')")
    description: str = Field(default="", description="Detailed description of the weakness")
    evidence: str = Field(default="", description="Evidence from the manuscript")
    impact: str = Field(default="", description="How this affects the study's validity or impact")
    severity: float = Field(default=0.5, ge=0.0, le=1.0, description="Severity score (0-1)")


class CognitiveReviewResult(BaseModel):
    """
    High-level cognitive review result - mimics expert reviewer assessment.

    This goes beyond checklist compliance to assess:
    - Novelty and originality
    - Scientific contribution
    - Fit with literature
    - Clarity and presentation
    - Fatal flaws not covered by checklists
    """

    # Quantitative scores (0-10 scale)
    novelty_score: float = Field(default=5.0, ge=0.0, le=10.0, description="Novelty score: 0=not novel at all, 10=highly novel and groundbreaking")
    contribution_score: float = Field(default=5.0, ge=0.0, le=10.0, description="Contribution score: 0=no meaningful contribution, 10=major breakthrough")
    fit_score: float = Field(default=5.0, ge=0.0, le=10.0, description="Fit with literature: 0=disconnected from field, 10=perfectly positioned")
    clarity_score: float = Field(default=5.0, ge=0.0, le=10.0, description="Clarity and presentation: 0=very unclear, 10=exceptionally clear")

    methodological_depth_score: float = Field(
        default=5.0,
        ge=0.0,
        le=10.0,
        description="Methodological depth: 0=insufficient theory, 10=strong theoretical foundation"
    )

    operability_score: float = Field(
        default=5.0,
        ge=0.0,
        le=10.0,
        description="Operability and translation value: 0=not actionable, 10=highly practical"
    )

    writing_quality_score: float = Field(
        default=5.0,
        ge=0.0,
        le=10.0,
        description="Writing quality: 0=poor expression, 10=excellent clarity"
    )

    figure_quality_score: float = Field(
        default=5.0,
        ge=0.0,
        le=10.0,
        description="Figure quality: 0=ineffective, 10=highly informative"
    )

    ethics_completeness_score: float = Field(
        default=5.0,
        ge=0.0,
        le=10.0,
        description="Ethics statement completeness: 0=missing, 10=fully compliant"
    )

    data_openness_score: float = Field(
        default=5.0,
        ge=0.0,
        le=10.0,
        description="Data openness: 0=no sharing, 10=fully open"
    )

    # Qualitative assessments
    fatal_flaws: List[FatalFlaw] = Field(
        default_factory=list,
        description="Fatal methodological or logical flaws that invalidate the study"
    )

    key_strengths: List[KeyStrength] = Field(
        default_factory=list,
        description="Key strengths of the research (typically 3-5)"
    )

    key_weaknesses: List[KeyWeakness] = Field(
        default_factory=list,
        description="Key weaknesses of the research (typically 3-5)"
    )

    # Detailed analyses
    originality_analysis: str = Field(default="", description="Detailed analysis of the research's originality and novelty")
    contribution_analysis: str = Field(default="", description="Detailed analysis of the marginal contribution to the field")

    literature_positioning_analysis: str = Field(
        default="",
        description="该研究相比同类综述/框架的增量贡献是什么？在领域中的定位如何？"
    )

    methodological_depth_analysis: str = Field(
        default="",
        description="提出的框架/方法是否有足够的理论支撑？方法论深度评估。"
    )

    operability_analysis: str = Field(
        default="",
        description="框架/建议是否具有实际可执行性？转化价值如何？"
    )

    writing_quality_analysis: str = Field(
        default="",
        description="语言是否精准，结构是否清晰，表达质量评估。"
    )

    figure_quality_analysis: str = Field(
        default="",
        description="图表是否有效传递了核心信息？设计质量如何？"
    )

    ethics_statement_analysis: str = Field(
        default="",
        description="是否有伦理声明、资金来源、利益冲突声明？完整性评估。"
    )

    data_openness_analysis: str = Field(
        default="",
        description="是否提供了数据共享声明或代码仓库链接？开放性评估。"
    )

    # Overall assessment
    suggestions: List[str] = Field(
        default_factory=list,
        description="High-level suggestions for improvement"
    )

    confidence: float = Field(default=0.5, ge=0.0, le=1.0, description="Reviewer's confidence in this assessment (0-1)")

    # Meta information
    is_incremental_work: bool = Field(
        default=False,
        description="Whether this is primarily incremental work (just changing dataset/parameters)"
    )

    is_conclusion_overstated: bool = Field(
        default=False,
        description="Whether the conclusions are overstated relative to the evidence"
    )

    has_uncovered_flaws: bool = Field(
        default=False,
        description="Whether fatal flaws were found that checklists didn't cover"
    )

    overall_recommendation: str = Field(default="major_revision", description="Overall recommendation: 'accept', 'minor_revision', 'major_revision', 'reject'")
    recommendation_rationale: str = Field(default="", description="Rationale for the overall recommendation")

    class Config:
        json_schema_extra = {
            "example": {
                "novelty_score": 7.5,
                "contribution_score": 6.5,
                "fit_score": 8.0,
                "clarity_score": 7.0,
                "fatal_flaws": [],
                "key_strengths": [
                    {
                        "strength_type": "novel_method",
                        "description": "First application of transformer models to this clinical problem",
                        "evidence": "Introduction paragraph 3",
                        "impact": "Opens new research direction"
                    }
                ],
                "key_weaknesses": [
                    {
                        "weakness_type": "limited_generalizability",
                        "description": "Single-center study limits generalizability",
                        "evidence": "Methods section",
                        "impact": "Results may not apply to other settings",
                        "severity": 0.6
                    }
                ],
                "originality_analysis": "The study presents a novel application...",
                "contribution_analysis": "The marginal contribution is moderate...",
                "suggestions": ["Validate in external cohort", "Discuss limitations more thoroughly"],
                "confidence": 0.85,
                "is_incremental_work": False,
                "is_conclusion_overstated": False,
                "has_uncovered_flaws": False,
                "overall_recommendation": "minor_revision",
                "recommendation_rationale": "Strong methodology with minor presentation issues"
            }
        }
