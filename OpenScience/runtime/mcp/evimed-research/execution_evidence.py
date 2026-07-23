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
        "model": "deepseek-v4-pro",
        "thinking": True,
        "reasoningEffort": "high",
    }
