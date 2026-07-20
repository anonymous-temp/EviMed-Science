"""
Plan-Retrieve-Argue Architecture Data Structures

This module contains the core data structures for the new Plan-Retrieve-Argue
architecture that replaces the simple pipeline with a more sophisticated
three-layer system:

1. Plan Layer: Review Planner generates a strategic review plan
2. Retrieve Layer: Material Engine workers gather evidence as neutral materials
3. Argue Layer: Editor Synthesizer produces final reports using materials
"""

from typing import List, Dict, Optional, Any, Literal
from pydantic import BaseModel, Field
from enum import Enum
from datetime import datetime


# ============================================================================
# P0: Coverage Meter Data Structures
# ============================================================================

class ParsedSection(BaseModel):
    """Information about a parsed section"""
    section_name: str = Field(..., description="Name of the section (e.g., 'methods', 'results')")
    is_present: bool = Field(default=False, description="Whether this section was found")
    paragraph_count: int = Field(default=0, description="Number of paragraphs extracted")
    character_count: int = Field(default=0, description="Total character count")
    start_offset: Optional[int] = Field(default=None, description="Start offset in full text")
    end_offset: Optional[int] = Field(default=None, description="End offset in full text")


class ParsedTable(BaseModel):
    """Information about a parsed table"""
    table_number: int = Field(..., description="Table number in the document")
    caption: str = Field(default="", description="Table caption")
    row_count: int = Field(default=0, description="Number of rows")
    column_count: int = Field(default=0, description="Number of columns")
    page: Optional[int] = Field(default=None, description="Page number where table appears")


class ParsedFigure(BaseModel):
    """Information about a parsed figure"""
    figure_number: int = Field(..., description="Figure number in the document")
    caption: str = Field(default="", description="Figure caption")
    has_description: bool = Field(default=False, description="Whether description was extracted")
    page: Optional[int] = Field(default=None, description="Page number where figure appears")


class CoverageSummary(BaseModel):
    """
    Summary of document parsing coverage.

    This is used by the Evidence Gate to determine whether
    a FAIL verdict is justified (full coverage) or should be
    downgraded to UNCERTAIN (partial coverage).
    """
    # Overall metrics
    total_pages: int = Field(default=0, description="Total pages in document")
    total_characters: int = Field(default=0, description="Total character count")

    # Section coverage
    sections_found: List[ParsedSection] = Field(default_factory=list)
    sections_missing: List[str] = Field(default_factory=list)

    # Structured content
    tables_parsed: List[ParsedTable] = Field(default_factory=list)
    figures_parsed: List[ParsedFigure] = Field(default_factory=list)

    # Supplementary materials
    supplementary_parsed: bool = Field(default=False, description="Whether supplementary materials were parsed")
    supplementary_note: Optional[str] = Field(default=None)

    # Quality indicators
    parse_method: Literal["marker", "pypdf", "docx", "fallback"] = Field(
        default="pypdf",
        description="Method used for parsing"
    )
    parse_quality: Literal["high", "medium", "low"] = Field(
        default="medium",
        description="Overall parse quality assessment"
    )

    # Coverage percentage
    @property
    def section_coverage_percentage(self) -> float:
        """Calculate percentage of standard sections found"""
        standard_sections = ["abstract", "introduction", "methods", "results", "discussion"]
        found = sum(1 for s in self.sections_found if s.section_name.lower() in standard_sections and s.is_present)
        return (found / len(standard_sections)) * 100

    def generate_coverage_note(self) -> str:
        """Generate a human-readable coverage note"""
        sections_list = ", ".join([s.section_name for s in self.sections_found if s.is_present])
        tables_count = len(self.tables_parsed)
        figures_count = len(self.figures_parsed)

        note = f"审稿范围摘要: 本次自动审阅已完整解析论文的 **{sections_list}** 章节"
        if tables_count > 0:
            note += f"，并成功提取了 **{tables_count}个表格**"
        if figures_count > 0:
            note += f" 和 **{figures_count}个图表**"

        if not self.supplementary_parsed:
            note += "。补充材料 **未被解析**。"
        else:
            note += "，包括补充材料。"

        return note

    class Config:
        json_schema_extra = {
            "example": {
                "total_pages": 12,
                "total_characters": 45000,
                "sections_found": [
                    {"section_name": "abstract", "is_present": True, "paragraph_count": 1},
                    {"section_name": "methods", "is_present": True, "paragraph_count": 15}
                ],
                "tables_parsed": [
                    {"table_number": 1, "caption": "Baseline characteristics", "row_count": 10, "column_count": 5}
                ],
                "parse_method": "marker",
                "parse_quality": "high"
            }
        }


# ============================================================================
# P1: Review Planning Data Structures
# ============================================================================

class ReviewFocus(BaseModel):
    """A single review focus point identified by the planner"""
    topic: str = Field(..., description="Focus topic (e.g., 'Comparability', 'Heterogeneity')")
    rationale: str = Field(..., description="Why this is a risk point for this study type")
    evidence_slots: List[str] = Field(
        default_factory=list,
        description="Specific locations/items to check (e.g., 'Table 1', 'Methods.Statistical Analysis')"
    )
    rubric_materials: List[str] = Field(
        default_factory=list,
        description="Related rubric material IDs to use"
    )
    must_have_evidence: bool = Field(
        default=True,
        description="Whether evidence is required before making a judgment"
    )
    priority: int = Field(
        default=1,
        ge=1,
        le=5,
        description="Priority level (1=highest, 5=lowest)"
    )


class ReviewPlan(BaseModel):
    """
    Strategic review plan generated by the Review Planner.

    This replaces the simple rubric orchestration with a
    strategic, study-type-aware review approach.
    """
    # Plan identification
    plan_id: str = Field(..., description="Unique plan identifier")
    created_at: datetime = Field(default_factory=datetime.now)

    # Study context
    study_types: List[str] = Field(default_factory=list, description="Identified study types")
    journal_context: Optional[str] = Field(default=None, description="Target journal context if available")

    # Core planning output
    review_focus: List[ReviewFocus] = Field(
        ...,
        min_length=3,
        max_length=6,
        description="3-6 key review focus points"
    )

    # Overall strategy
    overall_strategy: str = Field(
        ...,
        description="High-level review strategy description"
    )

    # Risk assessment
    high_risk_areas: List[str] = Field(
        default_factory=list,
        description="Areas with highest methodological risk"
    )

    # Confidence requirements
    confidence_requirements: Dict[str, float] = Field(
        default_factory=dict,
        description="Minimum confidence required for each focus area"
    )

    # Materials to gather
    rubric_materials_to_use: List[str] = Field(
        default_factory=list,
        description="List of rubric material IDs to use"
    )

    class Config:
        json_schema_extra = {
            "example": {
                "plan_id": "plan-uuid-1234",
                "study_types": ["Meta-Analysis", "Systematic Review"],
                "review_focus": [
                    {
                        "topic": "Search Strategy Completeness",
                        "rationale": "Incomplete search may miss relevant studies",
                        "evidence_slots": ["Methods.Search Strategy", "Appendix A"],
                        "rubric_materials": ["PRISMA_6", "PRISMA_7"],
                        "must_have_evidence": True,
                        "priority": 1
                    }
                ],
                "overall_strategy": "Focus on transitivity and heterogeneity assessment",
                "high_risk_areas": ["Indirect comparison validity", "Publication bias"]
            }
        }


# ============================================================================
# P1: Material Gathering Data Structures
# ============================================================================

class MaterialStatus(str, Enum):
    """Status of material gathering"""
    FOUND = "FOUND"          # Evidence clearly found
    NOT_FOUND = "NOT_FOUND"  # Evidence confirmed absent after thorough search
    UNCLEAR = "UNCLEAR"      # Evidence ambiguous or incomplete


class MaterialSnippet(BaseModel):
    """
    A neutral evidence snippet gathered by the Material Engine.

    CRITICAL: This is a factual record of what was found.
    It must NOT contain any subjective judgments or criticism.
    """
    # Material identification
    material_id: str = Field(..., description="Unique material ID")
    rubric_item_id: str = Field(..., description="Related rubric item ID")

    # Status
    status: MaterialStatus = Field(
        ...,
        description="Whether evidence was found"
    )

    # Evidence content
    evidence_quote: Optional[str] = Field(
        default=None,
        description="Direct quote from manuscript (required if FOUND)"
    )

    evidence_location: Optional[str] = Field(
        default=None,
        description="Location in document (e.g., 'Table 1, Row 5', 'Page 7, Paragraph 2')"
    )

    # Neutral summary (NO JUDGMENTS)
    material_summary: Optional[str] = Field(
        default=None,
        description="One-sentence NEUTRAL summary of what was found. NO criticism allowed."
    )

    # Retrieval metadata
    search_sections: List[str] = Field(
        default_factory=list,
        description="Sections that were searched"
    )
    search_keywords: List[str] = Field(
        default_factory=list,
        description="Keywords used in search"
    )
    retrieval_method: Literal["structure", "semantic", "llm_fallback"] = Field(
        default="structure",
        description="Method used to retrieve evidence"
    )
    retrieval_confidence: float = Field(
        default=0.5,
        ge=0.0,
        le=1.0,
        description="Confidence in retrieval accuracy"
    )

    # Context quality
    context_quality: Literal["exact", "fuzzy", "full_text"] = Field(
        default="exact",
        description="Quality of the context provided"
    )

    class Config:
        json_schema_extra = {
            "example": {
                "material_id": "mat-001",
                "rubric_item_id": "CONSORT_8a",
                "status": "FOUND",
                "evidence_quote": "Randomization was performed using a computer-generated sequence",
                "evidence_location": "Methods, Page 5, Paragraph 3",
                "material_summary": "The manuscript describes randomization using computer-generated sequence.",
                "search_sections": ["methods.randomization"],
                "retrieval_method": "structure",
                "retrieval_confidence": 0.95
            }
        }


# ============================================================================
# P2: Evidence Gate Data Structures
# ============================================================================

class EvidenceGateResult(BaseModel):
    """
    Result of Evidence Gate validation.

    The Evidence Gate ensures that:
    1. Any FAIL verdict must have confirming NOT_FOUND status from materials
    2. Coverage must be sufficient to justify FAIL
    3. Uncertain situations are properly labeled
    """
    original_verdict: str = Field(..., description="Original verdict from LLM")
    adjusted_verdict: str = Field(..., description="Verdict after Evidence Gate")

    was_adjusted: bool = Field(default=False, description="Whether verdict was changed")
    adjustment_reason: Optional[str] = Field(default=None, description="Reason for adjustment")

    # Coverage check results
    coverage_sufficient: bool = Field(default=True, description="Whether coverage justifies verdict")
    sections_checked: List[str] = Field(default_factory=list)
    sections_missing: List[str] = Field(default_factory=list)

    # Evidence check results
    evidence_supports_verdict: bool = Field(default=True)
    material_status: Optional[MaterialStatus] = Field(default=None)


# ============================================================================
# P2: Severity Calibration Data Structures
# ============================================================================

class SeverityCriteria(BaseModel):
    """Criteria for determining severity level"""
    level: Literal["CRITICAL", "MAJOR", "MINOR", "NONE"] = Field(...)
    description: str = Field(...)
    examples: List[str] = Field(default_factory=list)


class SeverityCalibrationResult(BaseModel):
    """Result of severity calibration"""
    original_severity: str = Field(...)
    calibrated_severity: str = Field(...)

    was_calibrated: bool = Field(default=False)
    calibration_reason: Optional[str] = Field(default=None)

    # Prior adjustments
    prior_applied: Optional[str] = Field(
        default=None,
        description="Prior adjustment applied (e.g., 'high_tier_journal')"
    )
    confidence_in_calibration: float = Field(
        default=1.0,
        ge=0.0,
        le=1.0
    )


# ============================================================================
# Combined State for Plan-Retrieve-Argue Pipeline
# ============================================================================

class PRAState(BaseModel):
    """
    State object for Plan-Retrieve-Argue pipeline.

    This extends the existing ReviewState with new P-R-A specific fields.
    """
    # Plan phase outputs
    review_plan: Optional[ReviewPlan] = Field(
        default=None,
        description="Strategic review plan from planner"
    )

    # Retrieve phase outputs
    material_snippets: List[MaterialSnippet] = Field(
        default_factory=list,
        description="Gathered materials from retrieval phase"
    )

    # Coverage tracking
    coverage_summary: Optional[CoverageSummary] = Field(
        default=None,
        description="Document parsing coverage summary"
    )

    # Evidence Gate results
    evidence_gate_results: Dict[str, EvidenceGateResult] = Field(
        default_factory=dict,
        description="Evidence Gate validation results by item ID"
    )

    # Severity calibration results
    severity_calibrations: Dict[str, SeverityCalibrationResult] = Field(
        default_factory=dict,
        description="Severity calibration results by item ID"
    )

    # Timing metrics
    plan_duration_ms: float = Field(default=0.0)
    retrieve_duration_ms: float = Field(default=0.0)
    argue_duration_ms: float = Field(default=0.0)

    class Config:
        json_schema_extra = {
            "example": {
                "review_plan": {"plan_id": "plan-001", "review_focus": []},
                "material_snippets": [],
                "coverage_summary": {"total_pages": 12, "parse_quality": "high"}
            }
        }
