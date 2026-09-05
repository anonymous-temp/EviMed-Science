from __future__ import annotations

import hashlib
import json
import os
import secrets
import stat
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field


PROTOCOL_VERSION = 1
MINERU_VERSION = "3.4.5"
TEXT_EXTENSIONS = {".txt", ".md", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".html", ".r", ".py", ".sql"}
STRUCTURED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".docx", ".pptx", ".xlsx"}
MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
MAX_UNITS = 100_000


class ParseRequest(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    mimeType: str = Field(min_length=1, max_length=160)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    sourceId: str = Field(min_length=1, max_length=160)


def read_token(file: Path) -> str:
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError("Parser token file permissions must be owner-only.")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise RuntimeError("Parser token file must be owned by the service user.")
    value = file.read_text(encoding="utf-8").strip()
    if len(value) < 16 or len(value) > 4096:
        raise RuntimeError("Parser token is invalid.")
    return value


def safe_file(raw: str, data_root: Path) -> Path:
    root = data_root.resolve(strict=True)
    candidate = Path(raw)
    if not candidate.is_absolute():
        raise ValueError("Document path must be absolute inside the data root.")
    try:
        relative = candidate.relative_to(root)
    except ValueError as error:
        raise ValueError("Document path is outside the data root.") from error
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Document path contains a symbolic link.")
    resolved = candidate.resolve(strict=True)
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise ValueError("Document path is outside the data root.") from error
    info = resolved.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_INPUT_BYTES:
        raise ValueError("Document is not a supported regular file.")
    return resolved


def file_digest(file: Path) -> str:
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def run_mineru(file: Path, output: Path, timeout: int) -> None:
    environment = {**os.environ, "CUDA_VISIBLE_DEVICES": os.environ.get("CUDA_VISIBLE_DEVICES", "")}
    result = subprocess.run(
        ["mineru", "-p", str(file), "-o", str(output), "-b", "pipeline"],
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("MinerU parsing failed.")


def text_result(file: Path, source_id: str, chunk_chars: int) -> dict[str, Any]:
    value = file.read_text(encoding="utf-8", errors="replace")
    chunks = [value[offset:offset + chunk_chars] for offset in range(0, len(value), chunk_chars)] or [""]
    units = []
    facts = []
    for index, chunk in enumerate(chunks, start=1):
        unit_id = f"chunk-{index}"
        item_ids = []
        if chunk.strip():
            item_id = f"item-{hashlib.sha256(f'{source_id}:{index}'.encode()).hexdigest()[:24]}"
            item_ids.append(item_id)
            facts.append({
                "id": item_id,
                "content": chunk.strip()[:4000],
                "provenance": {"unitId": unit_id, "span": f"chars:{(index - 1) * chunk_chars}-{min(index * chunk_chars, len(value))}"},
            })
        units.append({"id": unit_id, "unitType": "chunk", "status": "extracted" if item_ids else "no_content", "itemIds": item_ids})
    summary = " ".join(value.split())[:500] or "The source contains no extractable text."
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "extractor": {"name": "plain-text", "version": "1.0.0", "parser": "fallback"},
        "units": units,
        "summary": summary,
        "facts": facts,
        "methods": [],
        "text": value or "No extractable text.",
    }


def mineru_result(output: Path, file: Path, source_id: str) -> dict[str, Any]:
    markdown_files = sorted(output.rglob("*.md"))
    if not markdown_files:
        raise RuntimeError("MinerU produced no Markdown output.")
    parts = []
    total = 0
    for markdown in markdown_files:
        value = markdown.read_text(encoding="utf-8", errors="replace")
        total += len(value.encode("utf-8"))
        if total > MAX_OUTPUT_BYTES:
            raise RuntimeError("MinerU output exceeded its limit.")
        parts.append(value)
    extracted_text = "\n\n".join(parts).strip()
    content = []
    for candidate in sorted(output.rglob("*_content_list.json")):
        if candidate.stat().st_size > MAX_OUTPUT_BYTES:
            raise RuntimeError("MinerU coverage output exceeded its limit.")
        parsed = json.loads(candidate.read_text(encoding="utf-8"))
        if isinstance(parsed, list):
            content.extend(item for item in parsed if isinstance(item, dict))
    extension = file.suffix.lower()
    unit_type = "page" if extension == ".pdf" else "slide" if extension == ".pptx" else "column" if extension == ".xlsx" else "chunk"
    grouped: dict[int, list[dict[str, Any]]] = {}
    for item in content:
        raw_index = item.get("page_idx", item.get("pageIndex", 0))
        try:
            index = max(0, int(raw_index))
        except (TypeError, ValueError):
            index = 0
        if index >= MAX_UNITS:
            raise RuntimeError("MinerU returned an out-of-range physical unit index.")
        grouped.setdefault(index, []).append(item)
    expected = physical_unit_count(file)
    if grouped:
        expected = max(expected, max(grouped) + 1)
    expected = max(1, expected)
    if expected > MAX_UNITS:
        raise RuntimeError("Document physical unit count exceeded its limit.")
    units = []
    facts = []
    for position in range(expected):
        items = grouped.get(position, [])
        unit_id = f"{unit_type}-{position + 1}"
        item_ids = []
        for item_index, item in enumerate(items, start=1):
            item_text = str(item.get("text") or item.get("content") or "").strip()
            if not item_text:
                continue
            item_id = f"item-{hashlib.sha256(f'{source_id}:{unit_id}:{item_index}'.encode()).hexdigest()[:24]}"
            item_ids.append(item_id)
            facts.append({"id": item_id, "content": item_text[:4000], "provenance": {"unitId": unit_id, "span": str(item.get("bbox") or item.get("type") or "block")[:500]}})
        units.append({"id": unit_id, "unitType": unit_type, "status": "extracted" if item_ids else "failed", "itemIds": item_ids})
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "extractor": {"name": "mineru", "version": MINERU_VERSION, "parser": "mineru"},
        "units": units,
        "summary": " ".join(extracted_text.split())[:500] or "MinerU produced no extractable text.",
        "facts": facts,
        "methods": [],
        "text": extracted_text or "No extractable text.",
    }


def physical_unit_count(file: Path) -> int:
    extension = file.suffix.lower()
    if extension == ".pdf":
        from pypdf import PdfReader
        return len(PdfReader(str(file), strict=False).pages)
    if extension in {".pptx", ".xlsx", ".docx"}:
        with zipfile.ZipFile(file) as archive:
            names = archive.namelist()
            if extension == ".pptx":
                return sum(1 for name in names if name.startswith("ppt/slides/slide") and name.endswith(".xml"))
            if extension == ".xlsx":
                return sum(1 for name in names if name.startswith("xl/worksheets/sheet") and name.endswith(".xml"))
            # DOCX has no stable physical pages until a layout engine renders
            # it. MinerU's emitted positions are therefore treated as chunks,
            # rather than inventing page coverage from optional XML hints.
            return 1
    return 1


def parse_document(request: ParseRequest, *, data_root: Path, chunk_chars: int = 8000, timeout: int = 900) -> dict[str, Any]:
    file = safe_file(request.path, data_root)
    if not secrets.compare_digest(file_digest(file), request.sha256):
        raise ValueError("Document digest does not match the registered source.")
    if file.suffix.lower() in TEXT_EXTENSIONS or request.mimeType.startswith("text/"):
        return text_result(file, request.sourceId, chunk_chars)
    if file.suffix.lower() not in STRUCTURED_EXTENSIONS:
        raise ValueError("Document format is unsupported.")
    with tempfile.TemporaryDirectory(prefix="evimed-mineru-") as directory:
        output = Path(directory)
        run_mineru(file, output, timeout)
        return mineru_result(output, file, request.sourceId)


DATA_ROOT = Path(os.environ.get("EVIMED_PARSER_DATA_ROOT", "/data"))
TOKEN_FILE = Path(os.environ.get("EVIMED_PARSER_TOKEN_FILE", "/run/secrets/document_parser_token"))
app = FastAPI(title="EviMed document parser", docs_url=None, redoc_url=None)


def authenticate(authorization: Optional[str]) -> None:
    try:
        expected = read_token(TOKEN_FILE)
    except (OSError, RuntimeError) as error:
        raise HTTPException(status_code=503, detail="Parser authentication is unavailable.") from error
    supplied = authorization.removeprefix("Bearer ") if authorization and authorization.startswith("Bearer ") else ""
    if not supplied or not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Authentication required.")


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "protocolVersion": PROTOCOL_VERSION, "mineruVersion": MINERU_VERSION}


@app.post("/v1/parse")
def parse(request: ParseRequest, authorization: Optional[str] = Header(default=None)) -> dict[str, Any]:
    authenticate(authorization)
    try:
        return parse_document(request, data_root=DATA_ROOT)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except subprocess.TimeoutExpired as error:
        raise HTTPException(status_code=504, detail="Document parsing timed out.") from error
    except (OSError, RuntimeError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=503, detail="Document parsing failed.") from error
