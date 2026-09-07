"""Attest the pinned public MR audit only, from protected worker authority.

This module also supplies the clean-checkout verifier's source evidence. The
adapter package and full auditable agent tree are hashed with the same rules;
installation paths, customer data, environment and keys are never evidence.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
import sys
from contextlib import contextmanager
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
FIXTURE_MANIFEST = (PACKAGE.parent / "fixtures/public_mr.json" if PACKAGE.parent == Path("/adapter")
                    else PACKAGE.parents[2] / "evals/capability-audit/fixtures/public_mr.json")
EXCLUDED_DIRECTORIES = {".cache", ".git", ".mypy_cache", ".pytest_cache", ".r-lib",
    ".ruff_cache", ".venv", "__pycache__", "analysis-data", "build", "dist", "log",
    "logs", "node_modules", "output", "outputs", "venv"}
SOURCE_EXTENSIONS = {".cfg", ".csv", ".ini", ".j2", ".jinja", ".jinja2", ".json", ".lock",
    ".md", ".py", ".r", ".rmd", ".sql", ".tex", ".toml", ".txt", ".yaml", ".yml"}
MAX_FILE_BYTES = 128 * 1024 * 1024
MAX_RECEIPT_BYTES = 128 * 1024


class AuditReceiptUnavailable(ValueError):
    """The optional audit cannot be attested; never include private details."""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def digest(blob):
    return hashlib.sha256(blob).hexdigest()


def _parts(relative):
    if (not isinstance(relative, str) or not relative or len(relative) > 2048
            or "\\" in relative or any(ord(c) < 32 for c in relative)
            or any(p in {"", ".", ".."} for p in relative.split("/"))):
        raise AuditReceiptUnavailable("audit_path_invalid")
    return relative.split("/")


@contextmanager
def directory_fd(root, parts=()):
    descriptor = os.dup(root) if isinstance(root, int) else os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts:
            if _parts(part) != [part]:
                raise AuditReceiptUnavailable("audit_path_invalid")
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


def _identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _read_file(root, relative, limit=MAX_FILE_BYTES, *, secret=False):
    parts = _parts(relative)
    with directory_fd(root, parts[:-1]) as parent:
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            before = os.fstat(descriptor)
            if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit
                    or (secret and (before.st_uid != os.geteuid() or stat.S_IMODE(before.st_mode) not in {0o400, 0o600}))):
                raise AuditReceiptUnavailable("audit_file_invalid")
            chunks, total = [], 0
            while chunk := os.read(descriptor, min(65536, limit + 1 - total)):
                total += len(chunk)
                if total > limit:
                    raise AuditReceiptUnavailable("audit_file_too_large")
                chunks.append(chunk)
            if _identity(before) != _identity(os.fstat(descriptor)):
                raise AuditReceiptUnavailable("audit_file_changed")
            return b"".join(chunks)
        finally:
            os.close(descriptor)


def signing_key():
    """An absent or unsafe optional key never prevents ordinary MR analysis."""
    name = os.environ.get("EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE", "")
    if not name:
        return None
    try:
        from cryptography.exceptions import UnsupportedAlgorithm
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        path = Path(name).absolute()
        pem = _read_file(Path(path.anchor), path.relative_to(path.anchor).as_posix(), 8192, secret=True)
        if not pem.startswith(b"-----BEGIN PRIVATE KEY-----\n"):
            return None
        try:
            key = serialization.load_pem_private_key(pem, password=None)
        except UnsupportedAlgorithm:
            return None
        return key if isinstance(key, Ed25519PrivateKey) else None
    except (OSError, ValueError, TypeError, ImportError):
        return None



def analysis_credentials():
    """Audit signing requires a Linux owner process with a separate analysis UID.

    The runner receives neither this key path nor a privileged group. No-new-
    privileges plus the UID change performed by Popen prevents regaining root at exec.
    The existing unsigned deployment needs no privilege-changing capability.
    """
    name = os.environ.get("EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE", "")
    if not name:
        return None
    if sys.platform != "linux" or os.geteuid() != 0:
        raise AuditReceiptUnavailable("audit_analysis_isolation_unavailable")
    try:
        process = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
        if int(process["CapEff"].strip(), 16) & ((1 << 6) | (1 << 7)) != ((1 << 6) | (1 << 7)) or process["NoNewPrivs"].strip() != "1":
            raise AuditReceiptUnavailable("audit_analysis_isolation_unavailable")
        path = Path(name).absolute()
        # The descriptor read also verifies owner, link count, mode and size.
        _read_file(Path(path.anchor), path.relative_to(path.anchor).as_posix(), 8192, secret=True)
    except (OSError, KeyError, ValueError):
        raise AuditReceiptUnavailable("audit_analysis_isolation_unavailable") from None
    return {"user": 65532, "group": 65532, "extra_groups": [], "umask": 0o007}


def _load_manifest():
    return json.loads(_read_file(FIXTURE_MANIFEST.parent, FIXTURE_MANIFEST.name, 64 * 1024))


def ready():
    if signing_key() is None:
        return False
    try:
        analysis_credentials()
        _fixture_contract(_load_manifest())
        return True
    except (OSError, ValueError, TypeError, KeyError):
        return False


def source_tree_evidence(root):
    files = []

    def visit(directory, parts=()):
        for name in sorted(os.listdir(directory)):
            if name in EXCLUDED_DIRECTORIES or name.startswith(".env") or name == "deploy.env":
                continue
            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                with directory_fd(directory, (name,)) as child:
                    visit(child, (*parts, name))
            elif Path(name).suffix.casefold() in SOURCE_EXTENSIONS or name in {"Dockerfile", "Makefile"}:
                files.append(("/".join((*parts, name)), digest(_read_file(directory, name))))
            elif stat.S_ISLNK(info.st_mode):
                raise AuditReceiptUnavailable("audit_source_symlink")

    with directory_fd(root) as directory:
        visit(directory)
    if not files:
        raise AuditReceiptUnavailable("audit_source_empty")
    hasher = hashlib.sha256()
    for relative, sha in sorted(files):
        encoded = relative.encode("utf-8")
        hasher.update(len(encoded).to_bytes(4, "big"))
        hasher.update(encoded)
        hasher.update(bytes.fromhex(sha))
    return {"sha256": hasher.hexdigest(), "files": len(files)}


DEPLOYMENT_INPUTS = ("Dockerfile", "Dockerfile.evidence", "requirements.txt")


def adapter_manifest(adapter_package=PACKAGE):
    package = Path(adapter_package)
    files = []
    for name in DEPLOYMENT_INPUTS:
        blob = _read_file(package.parent, name)
        files.append({"path": name, "sha256": digest(blob), "bytes": len(blob)})
    return {"schemaVersion": 1, "package": source_tree_evidence(package), "deploymentInputs": files}


def adapter_evidence(adapter_package=PACKAGE):
    manifest = adapter_manifest(adapter_package)
    pinned = Path(adapter_package).parent / "adapter-evidence.json"
    if pinned.exists() or pinned.is_symlink():
        if json.loads(_read_file(pinned.parent, pinned.name, 64 * 1024)) != manifest:
            raise AuditReceiptUnavailable("audit_adapter_manifest_changed")
    return {"sha256": digest(canonical(manifest)), "files": manifest["package"]["files"] + len(DEPLOYMENT_INPUTS)}


def current_evidence(agent_root, adapter_package=PACKAGE):
    tree = source_tree_evidence(agent_root)
    return {"executionEvidence": {"schemaVersion": 1, "agentSourceSha256": tree["sha256"],
        "agentSourceFiles": tree["files"], "adapterSha256": digest(_read_file(adapter_package, "service.py")),
        "evidenceModuleSha256": digest(_read_file(adapter_package, "audit_receipt.py")),
        "model": "deepseek-v4-pro", "thinking": True, "reasoningEffort": "high"},
        "adapterEvidence": adapter_evidence(adapter_package)}


def _fixture_contract(manifest):
    prefix = "data/public-mr-" + manifest["commit"]
    mapping = {key: key for key in ("beta", "se", "effect_allele", "other_allele", "eaf", "pval")}
    mapping["snp"] = "SNP"
    request = {"exposure": manifest["exposure"]["trait"], "outcome": manifest["outcome"]["trait"],
               "analysisDirection": "forward", "outputLanguage": "en"}
    for role, name in (("exposure", "bmi_exposure.csv"), ("outcome", "chd_outcome.csv")):
        data = manifest[role]
        request[role + "Source"] = {"type": "local_file", "path": prefix + "/" + name,
            "columnMapping": dict(mapping), "sampleSize": data["sampleSize"],
            "instrumentsPreclumped": data["instrumentsPreclumped"],
            "clumpingProvenance": data.get("clumpingProvenance", data.get("selectionProvenance"))}
    fixture = {"manifestSha256": digest(canonical(manifest)), "sources": [
        {"path": prefix + "/" + row["name"], **{k: row[k] for k in ("url", "bytes", "sha256")}}
        for row in manifest["files"]]}
    inputs = [{"path": prefix + "/" + name, **value} for name, value in manifest["outputs"].items()]
    manifest_body = canonical(manifest) + b"\n"
    files = [{k: row[k] for k in ("path", "bytes", "sha256")} for row in fixture["sources"]]
    files.append({"path": prefix + "/fixture-manifest.json", "bytes": len(manifest_body), "sha256": digest(manifest_body)})
    return request, fixture, inputs, files


def _receipt_rows(rows):
    if not isinstance(rows, list) or not rows or len(rows) > 100:
        raise AuditReceiptUnavailable("audit_rows_invalid")
    paths = []
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"path", "bytes", "sha256"}:
            raise AuditReceiptUnavailable("audit_rows_invalid")
        _parts(row["path"])
        if (type(row["bytes"]) is not int or not 0 < row["bytes"] <= MAX_FILE_BYTES
                or not isinstance(row["sha256"], str) or len(row["sha256"]) != 64
                or any(c not in "0123456789abcdef" for c in row["sha256"])):
            raise AuditReceiptUnavailable("audit_rows_invalid")
        paths.append(row["path"])
    if len(set(paths)) != len(paths):
        raise AuditReceiptUnavailable("audit_rows_duplicate")
    return sorted(rows, key=lambda row: row["path"])


def produce(state, outcome, data_root):
    """Sign once at completion, never from status or client-supplied receipts."""
    key = signing_key()
    if key is None:
        return None
    try:
        from cryptography.hazmat.primitives import serialization
        request, fixture, inputs, files = _fixture_contract(_load_manifest())
        if (state["status"] != "succeeded" or state["request"] != request
                or outcome.get("analysisIsolated") is not True or outcome.get("cleanupError")):
            return None
        if _receipt_rows(outcome.get("inputReceipts")) != _receipt_rows(inputs):
            return None
        artifacts = _receipt_rows(outcome.get("artifactReceipts"))
        expected_paths = sorted(row["path"] for row in state["artifacts"])
        prefix = f"mendelian-randomization-runs/{state['jobId']}/output/"
        if ([row["path"] for row in artifacts] != expected_paths
                or any(not row["path"].startswith(prefix) for row in artifacts)):
            return None
        context = state["queueContext"]
        scope = {k: context[k] for k in ("userId", "projectId", "activeWorkspace")}
        workspace = Path(state["workspace"])
        with directory_fd(data_root, workspace.relative_to(data_root).parts) as directory:
            info = os.fstat(directory)
            if {"device": info.st_dev, "inode": info.st_ino} != context["identity"]["workspace"]:
                return None
            for row in files:
                blob = _read_file(directory, row["path"])
                if len(blob) != row["bytes"] or digest(blob) != row["sha256"]:
                    return None
        proof = {"schemaVersion": 1, "tool": "mendelian_randomization", "jobId": state["jobId"],
            "jobStatus": "succeeded", "scope": scope, "requestSha256": digest(canonical(request)),
            **state["sourceEvidence"], "inputs": _receipt_rows(outcome["inputReceipts"]),
            "artifacts": artifacts, "completedAt": state["finishedAt"], "fixture": fixture}
        body = canonical(proof)
        if len(body) > MAX_RECEIPT_BYTES:
            return None
        public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        proof["attestation"] = {"algorithm": "Ed25519", "keyId": "ed25519-" + digest(public),
                                "signature": base64.b64encode(key.sign(body)).decode("ascii")}
        return proof
    except (OSError, ValueError, TypeError, KeyError, ImportError):
        # Optional audit eligibility is narrower than normal MR eligibility.
        return None


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--write-adapter-manifest":
        raise SystemExit("Expected --write-adapter-manifest OUTPUT")
    with Path(sys.argv[2]).open("xb") as stream:
        stream.write(canonical(adapter_manifest()) + b"\n")
