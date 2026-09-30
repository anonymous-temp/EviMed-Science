"""Optional, unsigned observations of hosted Meta inputs, source and outputs.

This image does not contain the shared specialist adapter. The audit consumer
imports this standard-library module so both sides use the same source formula
and the shared adapter's schema 2 worker-observation contract. No observation
failure changes the job's scientific result or its delivery.
"""
from __future__ import annotations

import hashlib
import json
import os
import stat
from contextlib import contextmanager
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REQUEST_FIELDS = ("topic", "outputLanguage", "maxPapers", "analysisType", "userPdfDirectory", "ipdData")
MAX_FILE_BYTES = 128 * 1024 * 1024
SOURCE_EXTENSIONS = {".py", ".json", ".j2", ".jinja", ".jinja2", ".tex", ".yaml", ".yml"}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(blob):
    return hashlib.sha256(blob).hexdigest()


def parts(relative):
    if (not isinstance(relative, str) or not relative or len(relative) > 2048 or "\\" in relative
            or any(ord(c) < 32 for c in relative)
            or any(not p or p.startswith(".") or p in {"secrets", "privatequeue"} for p in relative.split("/"))):
        raise ValueError("observation_path_invalid")
    return relative.split("/")


@contextmanager
def directory(root, relative_parts=()):
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in relative_parts:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


def file_receipt(root, relative, *, allow_empty=False):
    names = parts(relative)
    with directory(root, names[:-1]) as parent:
        descriptor = os.open(names[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            before = os.fstat(descriptor)
            if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                    or not (0 if allow_empty else 1) <= before.st_size <= MAX_FILE_BYTES):
                raise ValueError("observation_file_invalid")
            hasher, size = hashlib.sha256(), 0
            while chunk := os.read(descriptor, 65536):
                size += len(chunk)
                if size > MAX_FILE_BYTES:
                    raise ValueError("observation_file_too_large")
                hasher.update(chunk)
            after = os.fstat(descriptor)
            identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            if identity(before) != identity(after):
                raise ValueError("observation_file_changed")
            return {"path": relative, "bytes": size, "sha256": hasher.hexdigest()}
        finally:
            os.close(descriptor)


def current_evidence(root=ROOT):
    """Hash shipped code/data and dependency declarations, never a runtime tree."""
    root = Path(root)
    rows = []
    def unavailable(error):
        raise error

    for current, directories, files in os.walk(root / "new_meta", followlinks=False, onerror=unavailable):
        directories[:] = sorted(name for name in directories if not name.startswith((".", "__")))
        for name in directories:
            if (Path(current) / name).is_symlink():
                raise ValueError("observation_source_symlink")
        for name in sorted(files):
            if not name.startswith(".") and Path(name).suffix.lower() in SOURCE_EXTENSIONS:
                rows.append(file_receipt(root, (Path(current) / name).relative_to(root).as_posix(), allow_empty=True))
    if not rows:
        raise ValueError("observation_source_empty")
    deployment = [file_receipt(root, name) for name in ("requirements.txt", "pyproject.toml")]
    if (root / "requirements.lock").exists():
        deployment.append(file_receipt(root, "requirements.lock"))
    return {"executionEvidence": {"schemaVersion": 1,
        "agentSourceSha256": digest(canonical(sorted(rows, key=lambda row: row["path"]))),
        "agentSourceFiles": len(rows),
        "adapterSha256": file_receipt(root, "new_meta/evimed_adapter.py")["sha256"],
        "evidenceModuleSha256": file_receipt(root, "new_meta/evimed_job_observation.py")["sha256"]},
        "adapterEvidence": {"sha256": digest(canonical(deployment)), "files": len(deployment)}}


def request_inputs(request, workspace):
    paths = []
    if request.get("ipdData"):
        parts(request["ipdData"])
        paths.append(request["ipdData"])
    if request.get("userPdfDirectory"):
        prefix = request["userPdfDirectory"]
        with directory(workspace, parts(prefix)) as descriptor:
            # This exactly matches the engine's non-recursive glob("*.pdf").
            paths.extend(prefix + "/" + name for name in sorted(os.listdir(descriptor)) if name.endswith(".pdf"))
    if len(paths) > 1000 or len(set(paths)) != len(paths):
        raise ValueError("observation_inputs_invalid")
    return sorted(paths)


def admission(arguments, workspace, owner):
    try:
        request = {key: arguments[key] for key in REQUEST_FIELDS if arguments.get(key) is not None}
        tail = ("users", owner["userId"], "projects", owner["projectId"], "workspace")
        names = Path(workspace).parts
        if names[-5:] == tail:
            active = ""
        elif names[-6:-1] == tail:
            active = names[-1]
        else:
            raise ValueError("observation_scope_invalid")
        observation = {"requestSha256": digest(canonical(request)), "auditRequest": request,
            "auditScope": {**owner, "activeWorkspace": active}, "sourceEvidence": current_evidence(),
            "inputReceipts": [file_receipt(workspace, path) for path in request_inputs(request, workspace)]}
        # The existing state reader is bounded at 256 KiB. Leave room for the
        # terminal observation, output metadata and the engine's own findings.
        if len(canonical(observation)) > 64 * 1024:
            raise ValueError("observation_too_large")
        return observation
    except (OSError, ValueError, TypeError, KeyError):
        return {"auditObservationUnavailable": "admission_evidence_unavailable"}


def unchanged(state):
    try:
        workspace = Path(state["workspace"])
        return (state["sourceEvidence"] == current_evidence()
                and digest(canonical(state["auditRequest"])) == state["requestSha256"]
                and [file_receipt(workspace, path) for path in request_inputs(state["auditRequest"], workspace)]
                == state["inputReceipts"])
    except (OSError, ValueError, TypeError, KeyError):
        return False


def complete(state):
    """Observe once at completion; status reads must never reconstruct evidence."""
    try:
        if state["status"] != "succeeded" or state.get("auditObservationUnavailable") or not unchanged(state):
            return None
        prefix = f"meta-analysis-runs/{state['jobId']}/output/"
        paths = sorted(row["path"] for row in state["artifacts"])
        if not paths or len(paths) > 1000 or len(set(paths)) != len(paths) or any(not path.startswith(prefix) for path in paths):
            return None
        proof = {"schemaVersion": 2, "evidenceKind": "worker-observation", "tool": "meta_analysis",
            "jobId": state["jobId"], "jobStatus": state["status"], "releaseStatus": state["releaseStatus"],
            "scope": state["auditScope"], "requestSha256": state["requestSha256"], **state["sourceEvidence"],
            "inputs": state["inputReceipts"], "artifacts": [file_receipt(state["workspace"], path) for path in paths],
            "completedAt": state["finishedAt"]}
        return proof if len(canonical(proof)) <= 128 * 1024 else None
    except (OSError, ValueError, TypeError, KeyError):
        return None
