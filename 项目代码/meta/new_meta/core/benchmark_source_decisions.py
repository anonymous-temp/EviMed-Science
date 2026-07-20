"""Reviewer decisions for benchmark source quote candidates."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from typing import Any

from pydantic import BaseModel, Field

from new_meta.core.project import Project


class BenchmarkSourceDecisionConflictError(RuntimeError):
    """Raised when a benchmark-source decision is written against a stale revision."""


class BenchmarkSourceDecision(BaseModel):
    """A reviewer decision on one benchmark source quote candidate."""
    candidate_id: str
    task_id: str
    trial_id: str = ""
    candidate_type: str = ""
    decision: str
    source_sha256: str = ""
    source_filename: str = ""
    quote: str = ""
    matched_values: list[str] = Field(default_factory=list)
    suggested_override: dict[str, Any] = Field(default_factory=dict)
    reason: str = ""
    updated_by: str = "unknown"
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    revision: int = 0


class BenchmarkSourceDecisionsFile(BaseModel):
    schema_version: int = 1
    current_revision: int = 0
    decisions: list[BenchmarkSourceDecision] = Field(default_factory=list)


def benchmark_candidate_id(
    *,
    task_id: str,
    source: dict[str, Any],
    candidate: dict[str, Any],
) -> str:
    """Return a deterministic identifier for a generated quote candidate."""
    existing = str(candidate.get("candidate_id") or "").strip()
    if existing:
        return existing
    payload = {
        "task_id": str(task_id or ""),
        "source_sha256": str(source.get("sha256") or ""),
        "source_local_path": str(source.get("local_path") or ""),
        "candidate_type": str(candidate.get("candidate_type") or ""),
        "matched_values": [str(value) for value in candidate.get("matched_values") or []],
        "quote": str(candidate.get("quote") or ""),
    }
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    ).hexdigest()[:20]
    return f"bsc_{digest}"


def load_benchmark_source_decisions(project: Project) -> BenchmarkSourceDecisionsFile:
    data = project.load_json("benchmark_source_decisions.json", subdir="benchmark")
    if not data:
        return BenchmarkSourceDecisionsFile()
    return BenchmarkSourceDecisionsFile.model_validate(data)


def save_benchmark_source_decision(
    project: Project,
    *,
    task_id: str,
    trial_id: str = "",
    source: dict[str, Any] | None = None,
    candidate: dict[str, Any] | None = None,
    decision: str,
    reason: str = "",
    updated_by: str = "unknown",
    expected_revision: int | None = None,
) -> BenchmarkSourceDecisionsFile:
    """Append or replace a review decision for a benchmark quote candidate."""
    source = source or {}
    candidate = candidate or {}
    normalized_decision = str(decision or "").strip().lower()
    if normalized_decision not in {"accepted", "rejected"}:
        raise ValueError("Benchmark source decision must be 'accepted' or 'rejected'.")
    manifest = load_benchmark_source_decisions(project)
    if expected_revision is not None and expected_revision != manifest.current_revision:
        raise BenchmarkSourceDecisionConflictError(
            f"stale benchmark source decision revision: expected {expected_revision}, "
            f"current {manifest.current_revision}"
        )

    next_revision = manifest.current_revision + 1
    candidate_id = benchmark_candidate_id(task_id=task_id, source=source, candidate=candidate)
    record = BenchmarkSourceDecision(
        candidate_id=candidate_id,
        task_id=str(task_id or ""),
        trial_id=str(trial_id or candidate.get("trial_id") or ""),
        candidate_type=str(candidate.get("candidate_type") or ""),
        decision=normalized_decision,
        source_sha256=str(source.get("sha256") or ""),
        source_filename=str(source.get("filename") or ""),
        quote=str(candidate.get("quote") or ""),
        matched_values=[str(value) for value in candidate.get("matched_values") or []],
        suggested_override=candidate.get("suggested_override") or {},
        reason=str(reason or ""),
        updated_by=str(updated_by or "unknown"),
        revision=next_revision,
    )

    replaced = False
    for idx, existing in enumerate(manifest.decisions):
        if existing.candidate_id == candidate_id:
            manifest.decisions[idx] = record
            replaced = True
            break
    if not replaced:
        manifest.decisions.append(record)
    manifest.current_revision = next_revision
    project.save_json("benchmark_source_decisions.json", manifest, subdir="benchmark")
    return manifest


def benchmark_source_decisions_by_candidate(project: Project) -> dict[str, dict[str, Any]]:
    """Return latest benchmark source decisions keyed by candidate id."""
    manifest = load_benchmark_source_decisions(project)
    return {decision.candidate_id: decision.model_dump() for decision in manifest.decisions}
