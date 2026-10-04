"""Deterministic source evidence for managed specialist executions."""

from __future__ import annotations

import hashlib
from pathlib import Path


EXCLUDED_DIRECTORIES = {
    ".cache",
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".r-lib",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "analysis-data",
    "build",
    "dist",
    "log",
    "logs",
    "node_modules",
    "output",
    "outputs",
    "venv",
}
SOURCE_EXTENSIONS = {
    ".cfg",
    ".csv",
    ".ini",
    ".j2",
    ".jinja",
    ".jinja2",
    ".json",
    ".lock",
    ".md",
    ".py",
    ".r",
    ".rmd",
    ".sql",
    ".tex",
    ".toml",
    ".txt",
    ".yaml",
    ".yml",
}
SOURCE_FILENAMES = {"Dockerfile", "Makefile"}


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_tree_evidence(root):
    root = Path(root).resolve(strict=True)
    files = []
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(root)
        if any(part in EXCLUDED_DIRECTORIES for part in relative.parts[:-1]):
            continue
        if path.name.startswith(".env") or path.name in {"deploy.env"}:
            continue
        if path.suffix.casefold() not in SOURCE_EXTENSIONS and path.name not in SOURCE_FILENAMES:
            continue
        files.append((relative.as_posix(), path))
    if not files:
        raise ValueError("specialist source tree contains no auditable files")
    digest = hashlib.sha256()
    for relative, path in sorted(files):
        encoded = relative.encode("utf-8")
        digest.update(len(encoded).to_bytes(4, "big"))
        digest.update(encoded)
        digest.update(bytes.fromhex(file_sha256(path)))
    return {"sha256": digest.hexdigest(), "files": len(files)}


def execution_evidence(root, adapter_file):
    tree = source_tree_evidence(root)
    helper = Path(__file__).resolve()
    return {
        "schemaVersion": 1,
        "agentSourceSha256": tree["sha256"],
        "agentSourceFiles": tree["files"],
        "adapterSha256": file_sha256(Path(adapter_file).resolve(strict=True)),
        "evidenceModuleSha256": file_sha256(helper),
        "model": "deepseek-flash",
        "thinking": True,
        "reasoningEffort": "high",
    }


def observe_execution_evidence(root, adapter_file):
    """The evidence a job's record can carry, or the reason it cannot: never an exception.

    The evidence is a label on the job's record, and nothing it does may fail a
    researcher's job (owner ruling 2026-10-04: a receipt is our own mechanism, not a
    gate). Where `execution_evidence` raises, this answers
    ``{"evidence": None, "unavailable": <code>}``; where it succeeds,
    ``{"evidence": <block>, "unavailable": None}``. The same vocabulary the hosted
    adapter's `audit_receipt.observe_evidence` records, so a record reads one way
    wherever its job ran.
    """
    try:
        return {"evidence": execution_evidence(root, adapter_file), "unavailable": None}
    except Exception:  # noqa: BLE001 — a surprise from the label is still only a label
        return {"evidence": None, "unavailable": "execution_evidence_unavailable"}


def evidence_note(admission, carried, observed):
    """What a job's record says about its own evidence; None when the evidence is clean.

    ``admission`` is the evidence taken when the job was queued (None when it could
    not be), ``carried`` the note written then, ``observed`` what
    `observe_execution_evidence` sees now. The job's status is never an input: a
    source that changed since the job was queued is recorded as ``changed`` with
    both evidence blocks, and the job stands. Before 2026-10-04 it failed a finished
    job (`specialist_source_evidence_mismatch`, `meta_source_evidence_mismatch`).
    """
    note = dict(carried) if isinstance(carried, dict) else {}
    if isinstance(admission, dict) and observed.get("evidence") != admission:
        note.update(
            changed=True,
            admission=admission,
            completion=observed["evidence"] if observed.get("evidence") is not None
            else {"unavailable": observed.get("unavailable") or "execution_evidence_unavailable"},
        )
    return note or None
