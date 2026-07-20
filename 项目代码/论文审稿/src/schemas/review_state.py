"""
Review state and security alerts
"""
from typing import Dict, List, Optional, Any, Literal
from pydantic import BaseModel, Field
from enum import Enum
from datetime import datetime

from .document_ir import DocumentIR, StudyProfile, EvidenceMap
from .rubric import RubricBlock, BlockReviewResult, SeverityLevel


class EvidenceSpan(BaseModel):
    """Structured evidence with precise location information"""
    quote: str = Field(..., description="Exact quote from the manuscript")
    page: Optional[int] = Field(default=None, description="Page number where evidence was found")
    start_offset: int = Field(..., description="Character offset from document start")
    end_offset: int = Field(..., description="Character offset from document end")
    section: str = Field(..., description="Section where evidence was found (e.g., 'methods.randomization')")
    score: float = Field(..., ge=0.0, le=1.0, description="Relevance score (0-1)")
    method: Literal["structure", "semantic", "llm_fallback"] = Field(
        ...,
        description="Retrieval method used to find this evidence"
    )

    class Config:
        json_schema_extra = {
            "example": {
                "quote": "Patients were randomized using computer-generated random numbers",
                "page": 5,
                "start_offset": 1234,
                "end_offset": 1298,
                "section": "methods.randomization",
                "score": 0.95,
                "method": "structure"
            }
        }


class RetrievalTrace(BaseModel):
    """Trace of evidence retrieval process"""
    stage1_hits: int = Field(default=0, description="Number of hits from structure-based retrieval")
    stage2_hits: int = Field(default=0, description="Number of hits from semantic retrieval")
    stage3_used: bool = Field(default=False, description="Whether LLM fallback was used")
    total_candidates: int = Field(default=0, description="Total candidate spans evaluated")
    retrieval_time_ms: float = Field(default=0.0, description="Time spent on retrieval in milliseconds")

    class Config:
        json_schema_extra = {
            "example": {
                "stage1_hits": 3,
                "stage2_hits": 5,
                "stage3_used": False,
                "total_candidates": 8,
                "retrieval_time_ms": 125.5
            }
        }


class RubricItemExecution(BaseModel):
    """Structured execution state for a single rubric item"""
    item_id: str = Field(..., description="Rubric item identifier")
    severity: SeverityLevel = Field(..., description="Severity level of the issue")
    verdict: int = Field(..., ge=0, le=2, description="Evaluation verdict: 0=Not met, 1=Partially met, 2=Fully met")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Confidence in the verdict (0-1)")
    evidence: List[EvidenceSpan] = Field(default_factory=list, description="Evidence supporting the verdict")
    retrieval_trace: RetrievalTrace = Field(default_factory=RetrievalTrace, description="Trace of retrieval process")
    notes: str = Field(default="", description="Additional notes or explanations")

    class Config:
        json_schema_extra = {
            "example": {
                "item_id": "CONSORT_8a",
                "severity": "MAJOR",
                "verdict": 2,
                "confidence": 0.95,
                "evidence": [],
                "retrieval_trace": {
                    "stage1_hits": 3,
                    "stage2_hits": 0,
                    "stage3_used": False
                },
                "notes": "Randomization method clearly described"
            }
        }


class JobStatus(str, Enum):
    """Overall job status"""
    PENDING = "PENDING"
    PARSING = "PARSING"
    REVIEWING = "REVIEWING"
    SYNTHESIZING = "SYNTHESIZING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class SecurityAlertType(str, Enum):
    """Types of security alerts"""
    PROMPT_INJECTION = "PROMPT_INJECTION"
    INVISIBLE_TEXT = "INVISIBLE_TEXT"
    ETHICS_MISSING = "ETHICS_MISSING"
    SUSPICIOUS_CONTENT = "SUSPICIOUS_CONTENT"


class SecurityAlert(BaseModel):
    """Security or integrity alert"""
    alert_type: SecurityAlertType
    severity: str  # CRITICAL, WARNING, INFO
    evidence: str
    location: Optional[str] = None
    detected_at: datetime = Field(default_factory=datetime.now)

    class Config:
        json_schema_extra = {
            "example": {
                "alert_type": "ETHICS_MISSING",
                "severity": "WARNING",
                "evidence": "No mention of ethics committee approval found in methods section",
                "location": "methods.ethics",
                "detected_at": "2026-01-21T12:00:00Z"
            }
        }


class OrchestrationState(BaseModel):
    """State of rubric orchestration"""
    rubric_blocks: List[RubricBlock] = Field(default_factory=list)
    task_status: Dict[str, str] = Field(
        default_factory=dict,
        description="Maps block_id to status (PENDING, RUNNING, COMPLETED, FAILED)"
    )
    total_blocks: int = 0
    completed_blocks: int = 0


class ReviewState(BaseModel):
    """
    Central state object for an entire review job.
    This is the main coordination structure between all agents.
    """
    # Job identification
    job_id: str = Field(..., description="Unique job identifier")
    manuscript_path: str = Field(..., description="Path to original manuscript file")
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)

    # Article type
    is_review_article: bool = Field(default=True, description="Whether the manuscript is a review article (systematic review, meta-analysis, etc.)")

    # Current status
    status: JobStatus = Field(default=JobStatus.PENDING)
    progress_percentage: float = Field(default=0.0, ge=0.0, le=100.0)

    # Core data products
    document_ir: Optional[DocumentIR] = None
    study_profile: Optional[StudyProfile] = None
    evidence_map: Optional[EvidenceMap] = None

    # Security checks
    security_alerts: List[SecurityAlert] = Field(default_factory=list)

    # Orchestration
    orchestration: OrchestrationState = Field(default_factory=OrchestrationState)

    # Review results
    review_results: Dict[str, BlockReviewResult] = Field(
        default_factory=dict,
        description="Maps block_id to its review results"
    )

    # Final outputs
    final_reports: Dict[str, str] = Field(
        default_factory=dict,
        description="Final report content (author_report, editor_report)"
    )

    # Error tracking
    error_log: List[Dict[str, Any]] = Field(default_factory=list)

    # Metrics
    metrics: Dict[str, Any] = Field(
        default_factory=dict,
        description="Performance metrics (processing time, token usage, etc.)"
    )

    def add_error(self, error_code: str, message: str, details: Optional[Dict] = None):
        """Add an error to the error log"""
        self.error_log.append({
            "timestamp": datetime.now().isoformat(),
            "error_code": error_code,
            "message": message,
            "details": details or {}
        })

    def add_security_alert(self, alert: SecurityAlert):
        """Add a security alert"""
        self.security_alerts.append(alert)

    def update_progress(self):
        """Update progress percentage based on orchestration state"""
        if self.orchestration.total_blocks > 0:
            base_progress = (self.orchestration.completed_blocks / self.orchestration.total_blocks) * 70
            # Add fixed percentages for other stages
            if self.status == JobStatus.PARSING:
                self.progress_percentage = 10.0
            elif self.status == JobStatus.REVIEWING:
                self.progress_percentage = 20.0 + base_progress
            elif self.status == JobStatus.SYNTHESIZING:
                self.progress_percentage = 90.0
            elif self.status == JobStatus.COMPLETED:
                self.progress_percentage = 100.0
        self.updated_at = datetime.now()

    class Config:
        json_schema_extra = {
            "example": {
                "job_id": "uuid-1234-abcd",
                "manuscript_path": "/path/to/manuscript.docx",
                "status": "REVIEWING",
                "progress_percentage": 45.0,
                "document_ir": None,
                "study_profile": None,
                "security_alerts": [],
                "orchestration": {
                    "total_blocks": 10,
                    "completed_blocks": 4
                },
                "review_results": {},
                "final_reports": {},
                "error_log": []
            }
        }
