"""
Rubric data structures for checklist-driven review
"""
from typing import List, Optional, Literal
from pydantic import BaseModel, Field
from enum import Enum


class SeverityLevel(str, Enum):
    """Severity classification for identified issues"""
    CRITICAL = "CRITICAL"  # Fatal flaws that invalidate the study
    MAJOR = "MAJOR"  # Significant methodological concerns
    MINOR = "MINOR"  # Minor issues that should be addressed
    NONE = "NONE"  # No issues found


class ItemStatus(str, Enum):
    """Execution status of a rubric item"""
    COMPLETED = "COMPLETED"
    EXECUTION_FAILED = "EXECUTION_FAILED"
    SKIPPED = "SKIPPED"
    PENDING = "PENDING"


class VerdictType(str, Enum):
    """Structured verdict types for rubric evaluation"""
    PASS = "PASS"          # Criterion fully met
    FAIL = "FAIL"          # Criterion clearly not met (confirmed absence)
    PARTIAL = "PARTIAL"    # Criterion partially met (incomplete information)
    UNCERTAIN = "UNCERTAIN"  # Cannot determine (insufficient evidence)


class RubricItem(BaseModel):
    """
    A single evaluation criterion from a checklist.
    Maps directly to one item from CONSORT, PRISMA, etc.
    """
    item_id: str = Field(..., description="Unique identifier, e.g., 'CONSORT_8a'")
    checklist_name: str = Field(..., description="Source checklist, e.g., 'CONSORT 2010'")
    item_number: str = Field(..., description="Original item number in checklist, e.g., '8a'")

    question: str = Field(
        ...,
        description="The specific question to evaluate, e.g., 'Was the randomization sequence generation method described?'"
    )

    question_zh: str = Field(
        default="",
        description="Chinese version of the question for zh-language reports"
    )

    evaluation_criteria: str = Field(
        ...,
        description="Detailed criteria for scoring this item"
    )

    evidence_location_hint: str = Field(
        ...,
        description="Where to look in DocumentIR, e.g., 'methods.randomization'"
    )

    severity_if_missing: SeverityLevel = Field(
        default=SeverityLevel.MAJOR,
        description="Default severity if this item is not adequately addressed"
    )

    category: str = Field(
        default="General",
        description="Category grouping, e.g., 'Methods', 'Results', 'Statistics'"
    )

    class Config:
        json_schema_extra = {
            "example": {
                "item_id": "CONSORT_8a",
                "checklist_name": "CONSORT 2010",
                "item_number": "8a",
                "question": "Was the method used to generate the random allocation sequence described?",
                "evaluation_criteria": "The manuscript should specify the exact method used (e.g., computer-generated random numbers, random number table, coin toss).",
                "evidence_location_hint": "methods.randomization",
                "severity_if_missing": "MAJOR",
                "category": "Randomization"
            }
        }


class RubricBlock(BaseModel):
    """
    A group of related rubric items that can be evaluated together.
    This is the unit of concurrent execution (typically 5-8 items).
    """
    block_id: str = Field(..., description="Unique identifier for this block")
    block_name: str = Field(..., description="Descriptive name, e.g., 'Methods_Randomization_Allocation'")
    items: List[RubricItem] = Field(..., description="List of rubric items in this block")

    priority: int = Field(
        default=1,
        description="Execution priority (higher = more important)"
    )

    class Config:
        json_schema_extra = {
            "example": {
                "block_id": "block_001",
                "block_name": "Methods_Randomization_Allocation",
                "items": [],
                "priority": 1
            }
        }


class RubricItemOutputSchema(BaseModel):
    """
    Standardized output format for each rubric item evaluation.
    All reviewer agents must return results in this format.
    """
    item_id: str = Field(..., description="Rubric item identifier")

    status: ItemStatus = Field(
        default=ItemStatus.COMPLETED,
        description="Execution status"
    )

    # NEW: Structured verdict instead of simple score
    verdict: VerdictType = Field(
        ...,
        description="Structured verdict: PASS, FAIL, PARTIAL, or UNCERTAIN"
    )

    # DEPRECATED but kept for backward compatibility
    score: Optional[Literal[0, 1, 2]] = Field(
        default=None,
        description="DEPRECATED: Use verdict instead. 0: Not met, 1: Partially met, 2: Fully met"
    )

    # NEW: Confidence in the verdict
    confidence: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description="Confidence in this verdict (0-1)"
    )

    severity: SeverityLevel = Field(
        ...,
        description="Issue severity level"
    )

    # NEW: Structured evidence spans (replaces evidence_quote + evidence_location)
    evidence_spans: List[dict] = Field(
        default_factory=list,
        description="List of EvidenceSpan objects supporting this verdict"
    )

    # DEPRECATED but kept for backward compatibility
    evidence_quote: List[str] = Field(
        default_factory=list,
        description="DEPRECATED: Use evidence_spans instead. Direct quotes from the manuscript"
    )

    evidence_location: List[str] = Field(
        default_factory=list,
        description="DEPRECATED: Use evidence_spans instead. Precise locations in DocumentIR"
    )

    missing_detail: Optional[str] = Field(
        default=None,
        description="What specific information is missing or inadequate"
    )

    risk_reason: Optional[str] = Field(
        default=None,
        description="Why this deficiency introduces bias or reduces quality"
    )

    actionable_fix: Optional[str] = Field(
        default=None,
        description="Specific, concrete recommendation for improvement"
    )

    # NEW: What would change the verdict
    what_would_change_verdict: Optional[str] = Field(
        default=None,
        description="What information, if provided, would change this verdict to PASS"
    )

    # Renamed from confidence_score for clarity
    confidence_score: float = Field(
        default=0.9,
        ge=0.0,
        le=1.0,
        description="DEPRECATED: Use 'confidence' instead"
    )

    context_quality: Optional[Literal["exact", "fuzzy", "full_text"]] = Field(
        default=None,
        description="Quality of the context provided for evaluation"
    )

    search_strategy: Optional[str] = Field(
        default=None,
        description="Strategy used to find evidence (e.g., 'exact_path', 'keyword_search', 'full_text_scan')"
    )

    class Config:
        json_schema_extra = {
            "example": {
                "item_id": "CONSORT_9",
                "status": "COMPLETED",
                "score": 0,
                "severity": "CRITICAL",
                "evidence_quote": [
                    "Patients were randomized to either the ML-EWS group or the SOFA group."
                ],
                "evidence_location": ["methods.randomization.text[2]"],
                "missing_detail": "The mechanism used to implement the random allocation sequence (e.g., central telephone; sequentially numbered, opaque, sealed envelopes) was not described.",
                "risk_reason": "Lack of allocation concealment is a major source of selection bias in RCTs, potentially invalidating the trial's results.",
                "actionable_fix": "Please describe the allocation concealment mechanism in detail. For example, 'We used a central, 24-hour telephone randomization service.'",
                "confidence_score": 0.95
            }
        }


class BlockReviewResult(BaseModel):
    """Results from reviewing a single rubric block"""
    block_id: str
    block_name: str
    results: List[RubricItemOutputSchema] = Field(default_factory=list)
    execution_time_seconds: float = 0.0
    error_log: List[str] = Field(default_factory=list)

    class Config:
        json_schema_extra = {
            "example": {
                "block_id": "block_001",
                "block_name": "Methods_Randomization",
                "results": [],
                "execution_time_seconds": 18.5,
                "error_log": []
            }
        }
