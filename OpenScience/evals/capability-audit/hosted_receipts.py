"""Audit-only retained proof for an isolated specialist adapter.

This is deliberately a different schema from legacy workspace .jobs files.
An authenticated terminal response must supply data.auditReceipt from protected
job state; a driver must never manufacture that proof from its own checkout.
The current adapter's status-only response is insufficient and remains uncertified.
Ed25519 verification requires cryptography and a digest-pinned public PEM. The
signature covers canonical(proof without attestation); keyId is "ed25519-"
followed by SHA-256 of the raw 32-byte public key. No receipt-provided key is
trusted, and no signing private key belongs in this module or its output.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SOURCE_DIRS = {"meta_analysis": "meta", "mendelian_randomization": "孟德尔随机化",
    "bibliometric_analysis": "文献剂量分析", "research_topic_selection": "科研选题",
    "peer_review": "论文审稿", "drug_safety_analysis": "药物安全分析agent"}
RECEIPT_DIRECTORY = ".evimed-audit/hosted-receipts"
TRUSTED_PUBLIC_KEY_FILE = HERE / "fixtures/specialist-audit-public.pem"
TRUSTED_PUBLIC_KEY_SHA256 = "e008739d00e2d415ccbb628bcae20a46009d6c5545e17f4050b85abc95d9af74"


class ReceiptError(ValueError):
    """A stable, non-secret diagnostic; never contains provider response prose."""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def trusted_public_key():
    """Only a reviewed local trust anchor, never a key supplied in the receipt."""
    try:
        pem = read_owned(TRUSTED_PUBLIC_KEY_FILE.parent, TRUSTED_PUBLIC_KEY_FILE.name, 8192)
    except (OSError, ReceiptError):
        raise ReceiptError("hosted_receipt_trusted_key_missing") from None
    if digest(pem) != TRUSTED_PUBLIC_KEY_SHA256:
        raise ReceiptError("hosted_receipt_trusted_key_digest_mismatch")
    return pem


def verify_attestation(proof, trustedPublicKey=None):
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError:
        raise ReceiptError("hosted_receipt_signature_verifier_unavailable") from None
    attestation = proof.get("attestation")
    if (not isinstance(attestation, dict) or set(attestation) != {"algorithm", "keyId", "signature"}
            or attestation["algorithm"] != "Ed25519"):
        raise ReceiptError("hosted_receipt_attestation_invalid")
    pem = trustedPublicKey if trustedPublicKey is not None else trusted_public_key()
    try:
        public = serialization.load_pem_public_key(pem)
        if not isinstance(public, Ed25519PublicKey):
            raise ValueError()
        raw = public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        if attestation["keyId"] != "ed25519-" + digest(raw):
            raise ReceiptError("hosted_receipt_attestation_key_mismatch")
        signature = base64.b64decode(attestation["signature"], validate=True)
        if len(signature) != 64:
            raise ValueError()
        public.verify(signature, canonical({key: value for key, value in proof.items() if key != "attestation"}))
    except ReceiptError:
        raise
    except (InvalidSignature, ValueError, TypeError):
        raise ReceiptError("hosted_receipt_signature_invalid") from None


def relative_path(value):
    if (not isinstance(value, str) or not value or len(value) > 2048
            or "\\" in value or any(ord(c) < 32 for c in value)
            or PurePosixPath(value).is_absolute()
            or any(part in {"", ".", ".."} for part in value.split("/"))):
        raise ReceiptError("audit_path_invalid")
    return value


def read_owned(root, relative, limit=128 * 1024 * 1024):
    """Read through no-follow directory descriptors; no parent-symlink escape."""
    parts = relative_path(relative).split("/")
    flags = os.O_RDONLY | os.O_NOFOLLOW
    descriptor = os.open(Path(root).resolve(strict=True), flags | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, flags | os.O_DIRECTORY, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_fd
        file_fd = os.open(parts[-1], flags, dir_fd=descriptor)
        try:
            before = os.fstat(file_fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
                raise ReceiptError("audit_file_invalid")
            chunks = []
            total = 0
            while chunk := os.read(file_fd, min(65536, limit + 1 - total)):
                chunks.append(chunk)
                total += len(chunk)
                if total > limit:
                    raise ReceiptError("audit_file_too_large")
            after = os.fstat(file_fd)
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
                    after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
                raise ReceiptError("audit_file_changed")
            return b"".join(chunks)
        finally:
            os.close(file_fd)
    except OSError as error:
        raise ReceiptError("audit_file_unavailable") from error
    finally:
        os.close(descriptor)


def file_receipt(root, relative):
    blob = read_owned(root, relative)
    if not blob:
        raise ReceiptError("audit_file_empty")
    return {"path": relative, "bytes": len(blob), "sha256": digest(blob)}


def write_new(root, relative, blob):
    """Create audit bytes without replacing an earlier result or following links."""
    parts = relative_path(relative).split("/")
    descriptor = os.open(Path(root).resolve(strict=True), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            try:
                os.mkdir(part, 0o700, dir_fd=descriptor)
            except FileExistsError:
                pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_fd
        file_fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
        with os.fdopen(file_fd, "wb") as stream:
            stream.write(blob)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as error:
        raise ReceiptError("audit_output_exists_or_unavailable") from error
    finally:
        os.close(descriptor)


def current_evidence(tool, repo=REPO):
    location = repo / "runtime/mcp/evimed-research/execution_evidence.py"
    spec = importlib.util.spec_from_file_location("hosted_audit_execution_evidence", location)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    adapter = repo / "deploy/specialist-adapter"
    return {
        "executionEvidence": module.execution_evidence(repo.parent / "项目代码" / SOURCE_DIRS[tool],
            adapter / "evimed_specialist_adapter/service.py"),
        "adapterEvidence": module.source_tree_evidence(adapter),
    }


def request_inputs(request):
    sources = [request[key] for key in ("exposureSource", "outcomeSource") if key in request]
    paths = [relative_path(source["path"]) for source in sources if isinstance(source, dict) and source.get("type") == "local_file"]
    if request.get("manuscript"):
        paths.append(relative_path(request["manuscript"]))
    return paths


def artifact_paths(rows):
    if not isinstance(rows, list):
        raise ReceiptError("audit_artifact_list_missing")
    paths = [relative_path(row.get("path") if isinstance(row, dict) else row) for row in rows]
    if len(set(paths)) != len(paths):
        raise ReceiptError("audit_artifact_list_duplicate")
    return sorted(paths)


def validate_public_mr_fixture(request, proof, workspace):
    # One checked-in manifest drives preparation and verification. An attested
    # unrelated MR analysis cannot stand in for this specific release brief.
    from public_mr_fixture import (arguments_for_manifest, fixture_binding,
        fixture_file_receipts, fixture_prefix, load_manifest)
    manifest = load_manifest()
    if request != arguments_for_manifest(manifest):
        raise ReceiptError("hosted_receipt_public_fixture_request_mismatch")
    if proof.get("fixture") != fixture_binding(manifest):
        raise ReceiptError("hosted_receipt_public_fixture_provenance_mismatch")
    expected_inputs = [{"path": fixture_prefix(manifest) + "/" + name, **metadata}
        for name, metadata in manifest["outputs"].items()]
    if sorted(proof["inputs"], key=lambda row: row["path"]) != sorted(expected_inputs, key=lambda row: row["path"]):
        raise ReceiptError("hosted_receipt_public_fixture_input_mismatch")
    for receipt in fixture_file_receipts(manifest):
        if file_receipt(workspace, receipt["path"]) != receipt:
            raise ReceiptError("hosted_receipt_public_fixture_source_changed")


def validate_receipt(value, workspace, tool, max_age_days, *, expected=None, trustedPublicKey=None):
    """One eligibility check used by capture, resume, harvest and clean replay."""
    if not isinstance(value, dict) or value.get("schemaVersion") != 1 or value.get("kind") != "isolated-specialist-receipt":
        raise ReceiptError("hosted_receipt_schema_invalid")
    proof = value.get("proof")
    if not isinstance(proof, dict):
        raise ReceiptError("hosted_receipt_missing:auditReceipt")
    required = {"schemaVersion", "tool", "jobId", "jobStatus", "scope", "requestSha256", "executionEvidence", "adapterEvidence", "inputs", "artifacts", "completedAt", "attestation"}
    if tool == "mendelian_randomization":
        required.add("fixture")
    for key in sorted(required):
        if key not in proof:
            raise ReceiptError("hosted_receipt_missing:" + key)
    if set(proof) - required - {"releaseStatus", "adapterImageDigest", "adapterRevision"}:
        raise ReceiptError("hosted_receipt_private_or_unknown_fields")
    if proof["schemaVersion"] != 1 or proof["tool"] != tool or value.get("tool") != tool:
        raise ReceiptError("hosted_receipt_identity_invalid")
    if not isinstance(proof["jobId"], str) or not re.fullmatch(r"[a-z][a-z0-9-]{7,100}", proof["jobId"]):
        raise ReceiptError("hosted_receipt_job_invalid")
    if proof["jobStatus"] not in {"succeeded", "blocked"}:
        raise ReceiptError("hosted_receipt_not_terminal")
    if value.get("startedJobId") != proof["jobId"]:
        raise ReceiptError("hosted_receipt_started_job_mismatch")
    verify_attestation(proof, trustedPublicKey)
    scope = proof["scope"]
    if (not isinstance(scope, dict) or set(scope) != {"userId", "projectId", "activeWorkspace"}
            or scope != value.get("scope")
            or any(not isinstance(scope.get(key), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", scope[key]) for key in ("userId", "projectId"))
            or not isinstance(scope.get("activeWorkspace"), str)
            or (scope["activeWorkspace"] and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_. -]{0,127}", scope["activeWorkspace"]))):
        raise ReceiptError("hosted_receipt_scope_invalid")
    try:
        completed = datetime.fromisoformat(proof["completedAt"].replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - completed).total_seconds() / 86400
        if not -1 / 1440 <= age <= max_age_days:
            raise ValueError()
    except (TypeError, ValueError, AttributeError):
        raise ReceiptError("hosted_receipt_stale") from None
    current = expected if expected is not None else current_evidence(tool)
    if any(proof[key] != current[key] for key in ("executionEvidence", "adapterEvidence")):
        raise ReceiptError("hosted_receipt_source_changed")
    request = value.get("request")
    if not isinstance(request, dict) or proof["requestSha256"] != digest(canonical(request)):
        raise ReceiptError("hosted_receipt_request_changed")
    response = value.get("response")
    if (not isinstance(response, dict) or response.get("status") not in {"success", "warning"}
            or response.get("jobId") != proof["jobId"] or response.get("jobStatus") != proof["jobStatus"]):
        raise ReceiptError("hosted_receipt_started_job_mismatch")
    for field in ("inputs", "artifacts"):
        rows = proof[field]
        if not isinstance(rows, list) or (field == "artifacts" and not rows) or len(rows) > 1000:
            raise ReceiptError("hosted_receipt_missing:" + field)
        if any(not isinstance(row, dict) or not isinstance(row.get("path"), str) for row in rows):
            raise ReceiptError("hosted_receipt_path_invalid")
        if len({row["path"] for row in rows}) != len(rows):
            raise ReceiptError("hosted_receipt_duplicate_path")
        for row in rows:
            if not isinstance(row, dict) or set(row) != {"path", "bytes", "sha256"} or file_receipt(workspace, row["path"]) != row:
                raise ReceiptError("hosted_receipt_artifact_changed")
    if sorted(row["path"] for row in proof["inputs"]) != sorted(request_inputs(request)):
        raise ReceiptError("hosted_receipt_input_binding_invalid")
    if sorted(response.get("artifacts", [])) != sorted(row["path"] for row in proof["artifacts"]):
        raise ReceiptError("hosted_receipt_artifact_binding_invalid")
    if tool == "mendelian_randomization":
        validate_public_mr_fixture(request, proof, workspace)
    if "adapterImageDigest" in proof and not re.fullmatch(r"sha256:[a-f0-9]{64}", str(proof["adapterImageDigest"])):
        raise ReceiptError("hosted_receipt_image_invalid")
    if "adapterRevision" in proof and not re.fullmatch(r"[a-f0-9]{40,64}", str(proof["adapterRevision"])):
        raise ReceiptError("hosted_receipt_revision_invalid")
    return proof


def capture_receipt(workspace, tool, request, response, scope, *, expected_job_id, expected=None, trustedPublicKey=None):
    data = response.get("data") or {}
    proof = data.get("auditReceipt")
    value = {"schemaVersion": 1, "kind": "isolated-specialist-receipt", "tool": tool,
        "startedJobId": expected_job_id,
        "scope": scope, "request": request, "proof": proof,
        "response": {"status": response.get("status"), "jobId": data.get("jobId"), "jobStatus": data.get("jobStatus"),
            "artifacts": [item.get("path") for item in response.get("artifacts", []) if isinstance(item, dict)]}}
    proof = validate_receipt(value, workspace, tool, 1, expected=expected, trustedPublicKey=trustedPublicKey)
    relative = f"{RECEIPT_DIRECTORY}/{proof['jobId']}.json"
    write_new(workspace, relative, canonical(value) + b"\n")
    return relative
