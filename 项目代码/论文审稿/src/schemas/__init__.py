"""
Core data schemas for the Medical SCI Paper Review System

Plan-Retrieve-Argue Architecture schemas:
- ReviewPlan: Strategic review plan
- MaterialSnippet: Neutral evidence snippet
- CoverageSummary: Document parsing coverage
"""
from .document_ir import DocumentIR, StudyProfile, EvidenceMap
from .rubric import RubricItem, RubricBlock, RubricItemOutputSchema, VerdictType, SeverityLevel
from .review_state import ReviewState, SecurityAlert, EvidenceSpan, RetrievalTrace
from .reports import AuthorReport, EditorReport
from .cognitive_review import CognitiveReviewResult
from .plan_retrieve_argue import (
    ReviewPlan, ReviewFocus, MaterialSnippet, MaterialStatus,
    CoverageSummary, PRAState, EvidenceGateResult, SeverityCalibrationResult
)

__all__ = [
    # Document IR
    "DocumentIR",
    "StudyProfile",
    "EvidenceMap",
    # Rubric
    "RubricItem",
    "RubricBlock",
    "RubricItemOutputSchema",
    "VerdictType",
    "SeverityLevel",
    # Review state
    "ReviewState",
    "SecurityAlert",
    "EvidenceSpan",
    "RetrievalTrace",
    # Reports
    "AuthorReport",
    "EditorReport",
    "CognitiveReviewResult",
    # Plan-Retrieve-Argue
    "ReviewPlan",
    "ReviewFocus",
    "MaterialSnippet",
    "MaterialStatus",
    "CoverageSummary",
    "PRAState",
    "EvidenceGateResult",
    "SeverityCalibrationResult",
]
