"""PDF intake manifest and parse-cache helpers.

This module keeps user-uploaded full text handling observable: each file gets a
record even when parsing fails, and repeated uploads can reuse parsed content by
content hash.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from pydantic import BaseModel, Field


PDF_PARSE_CACHE_VERSION = "pdf_parse_cache_v1"


class PDFIntakeRecord(BaseModel):
    file_id: str | None = None
    filename: str
    local_path: str
    file_size_bytes: int = 0
    sha256: str | None = None
    download_status: str = "ok"
    download_error: str | None = None
    parse_status: str = "pending"
    parse_error: str | None = None
    parser_used: str | None = None
    parser_cache_version: str | None = None
    cache_hit: bool = False
    ocr_used: bool = False
    page_count: int = 0
    text_chars: int = 0
    table_count: int = 0
    empty_pages: list[int] = Field(default_factory=list)
    matched_pmid: str | None = None
    matched_title: str | None = None
    match_score: float | None = None
    match_method: str | None = None
    source_type: str = "user_upload"
    requires_user_review: bool = False


class PDFIntakeManifest(BaseModel):
    session_id: str | None = None
    created_at: str
    files: list[PDFIntakeRecord] = Field(default_factory=list)


def empty_parse_result() -> dict:
    return {"full_text": "", "abstract": "", "sections": {}, "tables": [], "page_map": []}


def file_sha256(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _cache_path(cache_dir: Path, sha256: str, parser_version: str) -> Path:
    safe_version = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "_" for ch in parser_version)
    return cache_dir / "pdf_parse_cache" / f"{sha256}.{safe_version}.json"


def _summarize_parse(parsed: dict) -> tuple[int, int, int, list[int]]:
    text = parsed.get("full_text", "") or ""
    page_map = parsed.get("page_map", []) or []
    tables = parsed.get("tables", []) or []
    empty_pages = []
    for page in page_map:
        start = page.get("start_char", 0)
        end = page.get("end_char", start)
        if end <= start:
            empty_pages.append(page.get("page_number", 0))
    return len(page_map), len(text), len(tables), empty_pages


def parse_file_with_cache(
    path: str | Path,
    cache_dir: str | Path,
    *,
    parse_func: Callable[[str], dict],
    parser_used: str,
    parser_version: str = PDF_PARSE_CACHE_VERSION,
) -> tuple[dict, bool]:
    """Parse a full-text file with content-hash and parser-version caching."""
    source = Path(path)
    sha256 = file_sha256(source)
    base = Path(cache_dir)
    cache_file = _cache_path(base, sha256, parser_version)
    if cache_file.exists():
        cached = json.loads(cache_file.read_text(encoding="utf-8"))
        return cached, True

    parsed = parse_func(str(source)) or empty_parse_result()
    parsed["_parser_used"] = parsed.get("_parser_used") or parser_used
    parsed["_parser_cache_version"] = parser_version
    parsed["_source_sha256"] = sha256
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(parsed, ensure_ascii=False), encoding="utf-8")
    return parsed, False


def parse_user_pdfs(
    pdf_paths: list[str],
    cache_dir: str | Path,
    *,
    session_id: str | None = None,
    parse_func: Callable[[str], dict] | None = None,
    parser_version: str = PDF_PARSE_CACHE_VERSION,
    progress_cb: Callable[[PDFIntakeRecord], None] | None = None,
) -> tuple[PDFIntakeManifest, dict[str, dict]]:
    """Parse uploaded PDFs with content-hash caching.

    Returns a manifest plus a mapping of local path -> parsed content. Failures
    are represented in both outputs instead of being silently dropped.
    """
    if parse_func is None:
        from new_meta.agents.pdf_parser import parse_pdf

        parse_func = parse_pdf

    base = Path(cache_dir)
    cache_base = base / "pdf_parse_cache"
    cache_base.mkdir(parents=True, exist_ok=True)

    manifest = PDFIntakeManifest(
        session_id=session_id,
        created_at=datetime.now(timezone.utc).isoformat(),
        files=[],
    )
    parsed_by_path: dict[str, dict] = {}

    for raw_path in pdf_paths:
        path = Path(raw_path)
        record = PDFIntakeRecord(
            filename=path.name,
            local_path=str(path),
            file_size_bytes=path.stat().st_size if path.exists() else 0,
        )

        try:
            record.sha256 = file_sha256(path)
            record.parser_cache_version = parser_version
            parsed, cache_hit = parse_file_with_cache(
                path,
                base,
                parse_func=parse_func,
                parser_used="pdf_parser",
                parser_version=parser_version,
            )
            record.cache_hit = cache_hit
            record.parse_status = "ok"
            record.parser_used = parsed.get("_parser_used") or "cache"
            record.parser_cache_version = parsed.get("_parser_cache_version") or parser_version

            page_count, text_chars, table_count, empty_pages = _summarize_parse(parsed)
            record.page_count = page_count
            record.text_chars = text_chars
            record.table_count = table_count
            record.empty_pages = empty_pages
            if text_chars == 0:
                record.parse_status = "empty_text"
                record.requires_user_review = True
            parsed_by_path[str(path)] = parsed
        except Exception as exc:
            record.parse_status = "failed"
            record.parse_error = str(exc)
            record.requires_user_review = True
            parsed_by_path[str(path)] = empty_parse_result()

        manifest.files.append(record)
        if progress_cb:
            progress_cb(record)

    return manifest, parsed_by_path


def save_pdf_intake_manifest(manifest: PDFIntakeManifest, output_dir: str | Path) -> Path:
    path = Path(output_dir) / "pdf_intake_manifest.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(manifest.model_dump(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return path
