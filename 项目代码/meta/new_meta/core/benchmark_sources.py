"""Project-local intake for benchmark source files."""
from __future__ import annotations

import hashlib
import json
import shutil
import time
from pathlib import Path
from typing import Any, Callable

from new_meta.core.project import Project


def attach_benchmark_sources_to_project(
    project: Project,
    source_paths: list[str],
    *,
    task_id: str = "",
    trial_id: str = "",
    trial_name: str = "",
    source_kind: str = "benchmark_source",
    user_id: str = "",
    parse_func: Callable[[str], dict] | None = None,
) -> dict[str, Any]:
    """Stage user-supplied benchmark sources without changing the evidence set."""
    if not source_paths:
        return {
            "ok": True,
            "project_dir": str(project.base_dir),
            "attached": 0,
            "sources": [],
            "manifest_path": str(project.base_dir / "benchmark" / "benchmark_source_manifest.json"),
            "message": "No benchmark source files were provided.",
        }

    manifest = _load_manifest(project)
    sources = manifest.setdefault("sources", [])
    attached: list[dict[str, Any]] = []
    for raw_path in source_paths:
        source = Path(raw_path)
        if not source.exists() or not source.is_file():
            attached.append({
                "task_id": task_id,
                "trial_id": trial_id,
                "trial_name": trial_name,
                "source_kind": source_kind,
                "filename": source.name,
                "local_path": str(source),
                "status": "missing_file",
                "uploaded_by": user_id,
                "error": "source file does not exist",
            })
            continue
        dest = _stage_source(project, source, trial_id)
        parse_preview = _parse_source_preview(project, dest, parse_func=parse_func)
        entry = {
            "task_id": task_id,
            "trial_id": trial_id,
            "trial_name": trial_name,
            "source_kind": source_kind,
            "filename": source.name,
            "local_path": str(dest),
            "status": "uploaded_needs_review",
            "uploaded_by": user_id,
            "uploaded_at": time.time(),
            "sha256": _sha256(dest),
            "size_bytes": dest.stat().st_size,
            **parse_preview,
        }
        sources.append(entry)
        attached.append(entry)

    manifest["updated_at"] = time.time()
    project.save_json("benchmark_source_manifest.json", manifest, subdir="benchmark")
    ok_count = sum(1 for item in attached if item.get("status") == "uploaded_needs_review")
    return {
        "ok": True,
        "project_dir": str(project.base_dir),
        "attached": ok_count,
        "sources": attached,
        "manifest_path": str(project.base_dir / "benchmark" / "benchmark_source_manifest.json"),
        "message": (
            "Benchmark source files were saved for review. They have not been added to the evidence set yet."
            if ok_count else
            "No benchmark source files could be saved."
        ),
    }


def _load_manifest(project: Project) -> dict[str, Any]:
    manifest = project.load_json("benchmark_source_manifest.json", subdir="benchmark")
    if isinstance(manifest, dict):
        manifest.setdefault("schema_version", 1)
        manifest.setdefault("sources", [])
        return manifest
    return {
        "schema_version": 1,
        "project_dir": str(project.base_dir),
        "sources": [],
    }


def _parse_source_preview(
    project: Project,
    path: Path,
    *,
    parse_func: Callable[[str], dict] | None = None,
) -> dict[str, Any]:
    if parse_func is None:
        parse_func = _default_parse_func(path)
    try:
        parsed = parse_func(str(path)) or {}
        text = str(parsed.get("full_text") or "")
        page_map = parsed.get("page_map") or []
        tables = parsed.get("tables") or []
        preview = {
            "parse_status": "ok" if text else "empty_text",
            "parse_error": "",
            "text_chars": len(text),
            "page_count": len(page_map) if isinstance(page_map, list) else 0,
            "table_count": len(tables) if isinstance(tables, list) else 0,
            "text_preview": text[:1200],
        }
        if text or tables or page_map:
            preview["parsed_path"] = _save_parsed_source(project, path, parsed)
        return preview
    except Exception as exc:
        return {
            "parse_status": "failed",
            "parse_error": str(exc),
            "text_chars": 0,
            "page_count": 0,
            "table_count": 0,
            "text_preview": "",
        }


def _save_parsed_source(project: Project, source_path: Path, parsed: dict[str, Any]) -> str:
    digest = _sha256(source_path)
    parsed_dir = project.base_dir / "benchmark" / "source_parsed"
    parsed_dir.mkdir(parents=True, exist_ok=True)
    parsed_path = parsed_dir / f"{digest}.json"
    parsed_path.write_text(
        json.dumps(parsed, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    return str(parsed_path.relative_to(project.base_dir))


def _default_parse_func(path: Path) -> Callable[[str], dict]:
    suffix = path.suffix.lower()
    if suffix in {".txt", ".md", ".csv", ".tsv", ".json", ".html", ".htm"}:
        return _parse_plain_text_source
    from new_meta.agents.pdf_parser import parse_pdf

    return parse_pdf


def _parse_plain_text_source(path: str) -> dict[str, Any]:
    text = Path(path).read_text(encoding="utf-8", errors="ignore")
    return {
        "full_text": f"[PAGE 1]\n{text}",
        "tables": [],
        "page_map": [{"page_number": 1, "start_char": 0, "end_char": len(text) + len("[PAGE 1]\n")}],
    }


def _stage_source(project: Project, source: Path, trial_id: str) -> Path:
    project_root = project.base_dir.resolve()
    resolved = source.resolve()
    if project_root == resolved or project_root in resolved.parents:
        return resolved
    safe_trial = _safe_segment(trial_id or "unassigned")
    dest_dir = project.base_dir / "benchmark" / "sources" / safe_trial
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = _unique_destination(dest_dir, source.name)
    shutil.copy2(source, dest)
    return dest


def _unique_destination(dest_dir: Path, filename: str) -> Path:
    candidate = dest_dir / filename
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    suffix = candidate.suffix
    for idx in range(2, 1000):
        candidate = dest_dir / f"{stem}_{idx}{suffix}"
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"Could not allocate benchmark source filename for {filename}")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_segment(value: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in str(value or ""))
    return safe.strip("_") or "unassigned"
