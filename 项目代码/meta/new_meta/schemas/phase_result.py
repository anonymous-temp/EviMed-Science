"""Stable execution envelope shared by CLI, Web, REST API, and Skills."""
from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ExecutionStatus(str, Enum):
    SUCCEEDED = "succeeded"
    NEEDS_INPUT = "needs_input"
    BLOCKED = "blocked"
    FAILED = "failed"


class PhaseName(str, Enum):
    PROTOCOL = "protocol"
    ACQUISITION = "acquisition"
    SCREENING = "screening"
    EXTRACTION = "extraction"
    RISK_OF_BIAS = "risk_of_bias"
    EFFECT_SELECTION = "effect_selection"
    SYNTHESIS = "synthesis"
    CERTAINTY = "certainty"
    MANUSCRIPT = "manuscript"
    PACKAGE = "package"
    RELEASE = "release"


class ArtifactRef(BaseModel):
    artifact_id: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    path: str = Field(min_length=1)
    media_type: str = "application/octet-stream"
    sha256: str = Field(default="", pattern=r"^(?:[0-9a-fA-F]{64})?$")


class PhaseIssue(BaseModel):
    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    blocking: bool = False
    retryable: bool = False
    entity_ids: list[str] = Field(default_factory=list)
    context: dict[str, Any] = Field(default_factory=dict)


class NextAction(BaseModel):
    action_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    description: str = ""
    required: bool = True
    input_schema: dict[str, Any] = Field(default_factory=dict)


class PhaseResult(BaseModel):
    """Machine-readable phase outcome; never infer success from process exit text."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    schema_version: int = 1
    run_id: str = Field(min_length=1)
    phase: PhaseName
    status: ExecutionStatus
    summary: str = Field(min_length=1)
    checkpoint: str = ""
    retryable: bool = False
    metrics: dict[str, int | float | str | bool | None] = Field(default_factory=dict)
    artifacts: list[ArtifactRef] = Field(default_factory=list)
    issues: list[PhaseIssue] = Field(default_factory=list)
    next_actions: list[NextAction] = Field(default_factory=list)
    data: dict[str, Any] = Field(default_factory=dict)
    error_code: str = ""

    @model_validator(mode="after")
    def validate_terminal_semantics(self):
        blockers = [issue for issue in self.issues if issue.blocking]
        if self.status in {ExecutionStatus.BLOCKED, ExecutionStatus.NEEDS_INPUT} and not (
            blockers or self.next_actions
        ):
            raise ValueError("blocked result requires a blocking issue or next action")
        if self.status is ExecutionStatus.SUCCEEDED and blockers:
            raise ValueError("successful result cannot contain blocking issues")
        if self.status is ExecutionStatus.FAILED and not self.error_code:
            raise ValueError("failed result requires error_code")
        return self
