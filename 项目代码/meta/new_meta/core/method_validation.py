"""Load and verify the versioned method launch-evidence manifest."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from new_meta.schemas.method_policy import CapabilityStatus
from new_meta.schemas.method_validation import MethodValidationManifest


class ValidationManifestError(RuntimeError):
    pass


_REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_MANIFEST = _REPOSITORY_ROOT / "validation" / "capability_manifest.json"


def load_default_validation_manifest(
    path: str | Path | None = None,
) -> MethodValidationManifest:
    manifest_path = Path(path) if path else _DEFAULT_MANIFEST
    raw_bytes = manifest_path.read_bytes()
    payload = json.loads(raw_bytes)
    fingerprint = hashlib.sha256(raw_bytes).hexdigest()
    manifest = MethodValidationManifest.model_validate({
        **payload,
        "manifest_fingerprint": fingerprint,
        "repository_root": manifest_path.resolve().parents[1],
    })
    _validate_manifest(manifest)
    return manifest


def _validate_manifest(manifest: MethodValidationManifest) -> None:
    identifiers = [item.capability_id for item in manifest.capabilities]
    if len(identifiers) != len(set(identifiers)):
        raise ValidationManifestError("method capability identifiers must be unique")
    for capability in manifest.capabilities:
        evidence_classes = {item.evidence_class for item in capability.evidence}
        missing = sorted(set(capability.required_evidence_classes) - evidence_classes)
        if capability.release_status is CapabilityStatus.PRODUCTION and missing:
            raise ValidationManifestError(
                f"production capability {capability.capability_id} lacks evidence class(es): "
                + ", ".join(missing)
            )
        invalid = [
            item.evidence_id
            for item in capability.evidence
            if not manifest.verify_evidence(item)
        ]
        if invalid:
            raise ValidationManifestError(
                f"capability {capability.capability_id} has missing or changed evidence: "
                + ", ".join(invalid)
            )
