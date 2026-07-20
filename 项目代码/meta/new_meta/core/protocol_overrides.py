"""Audited protocol override helpers."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from new_meta.core.project import Project
from new_meta.schemas.protocol import ResearchProtocol


SUPPORTED_PROTOCOL_OVERRIDE_FIELDS = {"effect_measure", "model_preference", "tau_estimator"}


def apply_protocol_override(
    project: Project,
    protocol: ResearchProtocol,
    fields: dict[str, Any],
    *,
    reason: str = "",
    updated_by: str = "",
) -> dict[str, Any]:
    """Apply analysis-level protocol fields, persist audit, and clear stale checkpoints."""
    if not fields:
        return {
            "manifest": load_protocol_override_manifest(project),
            "changed_fields": {},
            "cleared_checkpoints": [],
        }

    changed_fields: dict[str, dict[str, Any]] = {}
    for field, raw_value in fields.items():
        if field not in SUPPORTED_PROTOCOL_OVERRIDE_FIELDS:
            raise ValueError(f"Unsupported protocol override field: {field}")
        value = normalize_protocol_override_value(field, raw_value)
        old_value = getattr(protocol, field, None)
        if old_value != value:
            setattr(protocol, field, value)
            changed_fields[field] = {"old": old_value, "new": value}

    if not changed_fields:
        return {
            "manifest": load_protocol_override_manifest(project),
            "changed_fields": {},
            "cleared_checkpoints": [],
        }

    project.save_json("protocol.json", protocol)
    manifest = append_protocol_override_manifest(
        project,
        changed_fields,
        reason=reason,
        updated_by=updated_by or "system",
    )
    return {
        "manifest": manifest,
        "changed_fields": changed_fields,
        "cleared_checkpoints": clear_protocol_override_downstream(project, changed_fields),
    }


def normalize_protocol_override_value(field: str, value: Any) -> Any:
    """Normalize protocol values exactly as the runtime expects them."""
    text = str(value).strip()
    if field == "effect_measure":
        return text.upper()
    if field == "model_preference":
        return text.lower()
    if field == "tau_estimator":
        return text.upper()
    return value


def load_protocol_override_manifest(project: Project) -> dict[str, Any]:
    """Load or initialize the protocol override audit ledger."""
    manifest = project.load_json("protocol_overrides.json")
    if not isinstance(manifest, dict):
        return {"schema_version": 1, "current_revision": 0, "overrides": []}
    manifest.setdefault("schema_version", 1)
    manifest.setdefault("current_revision", 0)
    if not isinstance(manifest.get("overrides"), list):
        manifest["overrides"] = []
    return manifest


def append_protocol_override_manifest(
    project: Project,
    changed_fields: dict[str, dict[str, Any]],
    *,
    reason: str,
    updated_by: str,
) -> dict[str, Any]:
    """Append one audited protocol override revision."""
    manifest = load_protocol_override_manifest(project)
    manifest["current_revision"] = int(manifest.get("current_revision") or 0) + 1
    manifest["overrides"].append({
        "revision": manifest["current_revision"],
        "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "updated_by": updated_by,
        "reason": reason,
        "fields": changed_fields,
    })
    project.save_json("protocol_overrides.json", manifest)
    return manifest


def clear_protocol_override_downstream(
    project: Project,
    changed_fields: dict[str, dict[str, Any]],
) -> list[str]:
    """Clear checkpoints made stale by protocol analysis-field changes."""
    if "effect_measure" in changed_fields:
        return project.clear_downstream("effect_sizes", include_self=True)
    if {"model_preference", "tau_estimator"} & set(changed_fields):
        return project.clear_downstream("meta_analysis", include_self=True)
    return []
