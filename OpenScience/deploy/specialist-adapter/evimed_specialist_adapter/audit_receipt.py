"""Record completed specialist jobs from their admitted worker state.

No signing key or operator approval is required. Version 2 records describe
observed source, request, input and artifact bytes; they do not claim independent
or cryptographic verification. Historical signed records remain readable by the
audit consumer, while new execution evidence uses ordinary protected job records.
Installation paths, customer data, environment and keys are never source evidence.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
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


def analysis_credentials():
    """Compatibility hook: ordinary analysis never needs an audit identity or key."""
    return None


def _load_manifest():
    return json.loads(_read_file(FIXTURE_MANIFEST.parent, FIXTURE_MANIFEST.name, 64 * 1024))


def ready(fixture=True):
    """Whether the retained job observation can include its declared public fixture."""
    try:
        if fixture:
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
#: What the manifest pinned at image build can say about the adapter on disk
#: that is worth writing down (see `pinned_manifest_status`).
PINNED_FINDINGS = ("mismatch", "unreadable")


def adapter_manifest(adapter_package=PACKAGE):
    package = Path(adapter_package)
    files = []
    for name in DEPLOYMENT_INPUTS:
        blob = _read_file(package.parent, name)
        files.append({"path": name, "sha256": digest(blob), "bytes": len(blob)})
    return {"schemaVersion": 1, "package": source_tree_evidence(package), "deploymentInputs": files}


def pinned_manifest_status(adapter_package=None, manifest=None):
    """Whether the manifest pinned when the image was built still describes the adapter on disk.

    ``absent`` (nothing was pinned: a checkout, a test), ``matches``, ``mismatch`` or
    ``unreadable``. It never raises: a stale pin is a finding about the image, not a
    reason to refuse anyone's job (owner ruling 2026-10-04). On 2026-09-27 an engine
    delta copied a changed package over its base image's pin and every MR start
    answered HTTP 500 until the next release.
    """
    package = Path(adapter_package or PACKAGE)
    pinned = package.parent / "adapter-evidence.json"
    try:
        if not (pinned.exists() or pinned.is_symlink()):
            return "absent"
        recorded = json.loads(_read_file(pinned.parent, pinned.name, 64 * 1024))
        if manifest is None:
            manifest = adapter_manifest(package)
    except (OSError, ValueError, TypeError):
        return "unreadable"
    return "matches" if recorded == manifest else "mismatch"


def _adapter_evidence(manifest):
    return {"sha256": digest(canonical(manifest)), "files": manifest["package"]["files"] + len(DEPLOYMENT_INPUTS)}


def _execution_evidence(tree, adapter_package):
    return {"schemaVersion": 1, "agentSourceSha256": tree["sha256"],
        "agentSourceFiles": tree["files"], "adapterSha256": digest(_read_file(adapter_package, "service.py")),
        "evidenceModuleSha256": digest(_read_file(adapter_package, "audit_receipt.py")),
        "model": "deepseek-flash", "thinking": True, "reasoningEffort": "high"}


def adapter_evidence(adapter_package=PACKAGE):
    """Strict: the clean-checkout verifier and the release audit need the pin to hold.

    A running job never calls this; it calls `observe_evidence`.
    """
    manifest = adapter_manifest(adapter_package)
    status = pinned_manifest_status(adapter_package, manifest)
    if status == "mismatch":
        raise AuditReceiptUnavailable("audit_adapter_manifest_changed")
    if status == "unreadable":
        raise AuditReceiptUnavailable("audit_adapter_manifest_unreadable")
    return _adapter_evidence(manifest)


def current_evidence(agent_root, adapter_package=PACKAGE):
    tree = source_tree_evidence(agent_root)
    return {"executionEvidence": _execution_evidence(tree, adapter_package),
        "adapterEvidence": adapter_evidence(adapter_package)}


def observe_evidence(agent_root, adapter_package=None):
    """The evidence a job's record can carry, or the reason it cannot: never an exception.

    The evidence is a label on the audit record, and nothing it does may fail a user's
    job (owner ruling 2026-10-04: the receipt is our own mechanism, not a gate). So
    where `current_evidence` raises, this answers
    ``{"evidence": None, "unavailable": <code>, "pinnedManifest": <status>}``, and
    where it succeeds, the same two blocks plus the pin's status. A stale pin does
    not stop the evidence being computed: the digest is of the adapter on disk.
    """
    package = Path(adapter_package or PACKAGE)
    pinned = "unreadable"
    try:
        manifest = adapter_manifest(package)
        pinned = pinned_manifest_status(package, manifest)
        tree = source_tree_evidence(agent_root)
        evidence = {"executionEvidence": _execution_evidence(tree, package),
            "adapterEvidence": _adapter_evidence(manifest)}
    except AuditReceiptUnavailable as error:
        code = str(error)
        return {"evidence": None, "pinnedManifest": pinned,
            "unavailable": code if re.fullmatch(r"[a-z][a-z0-9_]{0,79}", code) else "audit_evidence_unavailable"}
    except (OSError, ValueError, TypeError):
        return {"evidence": None, "unavailable": "audit_source_unreadable", "pinnedManifest": pinned}
    return {"evidence": evidence, "unavailable": None, "pinnedManifest": pinned}


def admission_note(observed):
    """What the record says at admission about evidence it could not take or whose pin is stale; None when clean."""
    note = {}
    if observed.get("evidence") is None:
        note["unavailable"] = observed.get("unavailable") or "audit_evidence_unavailable"
    if observed.get("pinnedManifest") in PINNED_FINDINGS:
        note["pinnedManifest"] = observed["pinnedManifest"]
    return note or None


def evidence_note(admission, carried, observed):
    """What a finished job's record says about its own evidence; None when the evidence is clean.

    ``admission`` is the evidence taken when the job was admitted (None when it could
    not be), ``carried`` the note written then, ``observed`` what `observe_evidence`
    sees now. The job's status is never an input: a changed source is recorded as
    ``changed`` with both evidence blocks, next to the digests it differs by, and the
    job stands.
    """
    note = dict(carried) if isinstance(carried, dict) else {}
    if observed.get("pinnedManifest") in PINNED_FINDINGS:
        note["pinnedManifest"] = observed["pinnedManifest"]
    if isinstance(admission, dict) and observed.get("evidence") != admission:
        note.update(changed=True, admission=admission,
            completion=observed["evidence"] if observed.get("evidence") is not None
            else {"unavailable": observed.get("unavailable") or "audit_evidence_unavailable"})
    return note or None


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
    """Record once at completion, never reconstruct evidence from a status response."""
    try:
        request, fixture, inputs, files = _fixture_contract(_load_manifest())
        if (state["status"] != "succeeded" or state["request"] != request
                or outcome.get("cleanupError")):
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
            "artifacts": artifacts, "completedAt": state["finishedAt"], "fixture": fixture,
            **_evidence_note_of(state)}
        return _worker_observation(proof)
    except (OSError, ValueError, TypeError, KeyError, ImportError):
        # Optional audit eligibility is narrower than normal MR eligibility.
        return None


def _evidence_note_of(state):
    """The record's own word on its evidence travels with the record it describes."""
    return {"evidenceNote": state["evidenceNote"]} if state.get("evidenceNote") else {}


def _worker_observation(proof):
    """A bounded worker observation, explicitly not a cryptographic attestation."""
    record = {**proof, "schemaVersion": 2, "evidenceKind": "worker-observation"}
    return record if len(canonical(record)) <= MAX_RECEIPT_BYTES else None


def job_scope(state, data_root):
    """Account, project and active workspace of a job, from its admitted owner and its own location."""
    owner = state["owner"]
    parts = Path(state["workspace"]).relative_to(Path(data_root)).parts
    if (len(parts) not in {5, 6} or parts[0] != "users" or parts[2] != "projects" or parts[4] != "workspace"
            or parts[1] != owner["userId"] or parts[3] != owner["projectId"]):
        raise AuditReceiptUnavailable("audit_scope_invalid")
    return {"userId": parts[1], "projectId": parts[3], "activeWorkspace": parts[5] if len(parts) == 6 else ""}


def produce_job_receipt(state, *, tool, output_prefix, inputs, artifacts, data_root):
    """Record a completed shared-adapter job, once, from its worker.

    Input and artifact rows describe the worker's private stage. The request
    digest was fixed at admission. Missing evidence affects this observation,
    never the useful job output itself.
    """
    try:
        if state["status"] != "succeeded":
            return None
        rows = _receipt_rows(artifacts)
        if ([row["path"] for row in rows] != sorted(row["path"] for row in state["artifacts"])
                or any(not row["path"].startswith(output_prefix) for row in rows)):
            return None
        request_sha = state["requestSha256"]
        if not isinstance(request_sha, str) or len(request_sha) != 64 or any(c not in "0123456789abcdef" for c in request_sha):
            return None
        proof = {"schemaVersion": 1, "tool": tool, "jobId": state["jobId"], "jobStatus": "succeeded",
            "scope": job_scope(state, data_root), "requestSha256": request_sha, **state["sourceEvidence"],
            "inputs": _receipt_rows(inputs) if inputs else [], "artifacts": rows, "completedAt": state["finishedAt"],
            **_evidence_note_of(state)}
        return _worker_observation(proof)
    except (OSError, ValueError, TypeError, KeyError, ImportError):
        return None


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--write-adapter-manifest":
        raise SystemExit("Expected --write-adapter-manifest OUTPUT")
    with Path(sys.argv[2]).open("xb") as stream:
        stream.write(canonical(adapter_manifest()) + b"\n")
