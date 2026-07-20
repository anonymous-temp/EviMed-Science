"""Immutable operating-mode contract for review and benchmark projects."""
from __future__ import annotations

from enum import Enum
from typing import Any

from new_meta.core.project import Project


class RunMode(str, Enum):
    """Top-level evidence policy selected when a project is created."""

    REVIEW = "review"
    BENCHMARK = "benchmark"


RUN_MODE_FILE = "run_mode.json"


def normalize_run_mode(value: RunMode | str | None) -> RunMode:
    if isinstance(value, RunMode):
        return value
    normalized = str(value or RunMode.REVIEW.value).strip().lower()
    try:
        return RunMode(normalized)
    except ValueError as exc:
        allowed = ", ".join(mode.value for mode in RunMode)
        raise ValueError(f"Unsupported run mode {value!r}; expected one of: {allowed}") from exc


def project_run_mode(project: Project) -> RunMode:
    """Return the persisted mode, defaulting legacy/unconfigured projects to review."""
    payload = project.load_json(RUN_MODE_FILE) or {}
    if not isinstance(payload, dict):
        return RunMode.REVIEW
    return normalize_run_mode(payload.get("mode"))


def configure_project_run_mode(
    project: Project,
    requested_mode: RunMode | str | None,
) -> RunMode:
    """Persist a project mode and reject silent mode changes on resume."""
    requested = normalize_run_mode(requested_mode)
    payload = project.load_json(RUN_MODE_FILE) or {}
    if isinstance(payload, dict) and payload.get("mode"):
        current = normalize_run_mode(payload.get("mode"))
        if current is not requested:
            raise ValueError(
                f"Project run mode is {current.value!r} and cannot be changed to "
                f"{requested.value!r}; create a new project for a different evidence policy."
            )
        return current

    project.save_json(
        RUN_MODE_FILE,
        {
            "schema_version": 1,
            "mode": requested.value,
            "benchmark_evidence_enabled": requested is RunMode.BENCHMARK,
        },
    )
    return requested


def benchmark_evidence_enabled(
    project: Project,
    requested_mode: RunMode | str | None = None,
) -> bool:
    mode = normalize_run_mode(requested_mode) if requested_mode is not None else project_run_mode(project)
    return mode is RunMode.BENCHMARK


def load_benchmark_reference_manifest(project: Project) -> dict[str, Any] | None:
    """Load benchmark constraints only for projects explicitly locked to benchmark mode."""
    if not benchmark_evidence_enabled(project):
        return None
    payload = project.load_json("known_source_reference_set.json", subdir="extraction") or None
    return payload if isinstance(payload, dict) else None

