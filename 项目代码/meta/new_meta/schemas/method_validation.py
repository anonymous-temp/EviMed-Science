"""Integrity-checked launch evidence for narrowly scoped synthesis capabilities."""
from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field, field_validator

from new_meta.schemas.method_policy import CapabilityStatus, ReviewDesignSpec, ReviewFamily


class ValidationEvidence(BaseModel):
    evidence_id: str = Field(min_length=1)
    evidence_class: str = Field(min_length=1)
    artifact: str = Field(min_length=1)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    source_url: str = ""


class CapabilityValidation(BaseModel):
    capability_id: str = Field(min_length=1)
    family: ReviewFamily
    supported_designs: list[str] = Field(min_length=1)
    supported_outcome_types: list[str] = Field(min_length=1)
    supported_effect_measures: list[str] = Field(min_length=1)
    release_status: CapabilityStatus
    required_evidence_classes: list[str] = Field(default_factory=list)
    evidence: list[ValidationEvidence] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)

    @field_validator("supported_designs", "supported_outcome_types")
    @classmethod
    def normalize_lower(cls, values: list[str]) -> list[str]:
        return sorted({str(value).strip().lower() for value in values if str(value).strip()})

    @field_validator("supported_effect_measures")
    @classmethod
    def normalize_effects(cls, values: list[str]) -> list[str]:
        return sorted({str(value).strip().upper() for value in values if str(value).strip()})

    def matches(self, spec: ReviewDesignSpec) -> bool:
        return (
            self.family is spec.family
            and set(spec.study_designs) <= set(self.supported_designs)
            and spec.outcome_type in self.supported_outcome_types
            and spec.requested_effect_measure in self.supported_effect_measures
        )


class MethodValidationManifest(BaseModel):
    schema_version: int = 1
    manifest_version: str = Field(min_length=1)
    manifest_fingerprint: str = ""
    capabilities: list[CapabilityValidation] = Field(min_length=1)
    repository_root: Path = Field(exclude=True)

    def capability(self, capability_id: str) -> CapabilityValidation:
        for item in self.capabilities:
            if item.capability_id == capability_id:
                return item
        raise KeyError(f"unknown method capability: {capability_id}")

    def resolve(self, spec: ReviewDesignSpec) -> CapabilityValidation | None:
        matches = [item for item in self.capabilities if item.matches(spec)]
        if not matches:
            return None
        # The most metric-specific capability must win over a family-wide fallback.
        return min(
            matches,
            key=lambda item: (
                len(item.supported_designs),
                len(item.supported_outcome_types),
                len(item.supported_effect_measures),
            ),
        )

    def verify_evidence(
        self,
        evidence: ValidationEvidence,
        *,
        artifact_override: str | Path | None = None,
    ) -> bool:
        import hashlib

        path = Path(artifact_override) if artifact_override else self.repository_root / evidence.artifact
        if not path.is_file():
            return False
        return hashlib.sha256(path.read_bytes()).hexdigest() == evidence.sha256
