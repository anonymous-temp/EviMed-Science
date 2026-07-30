"""
Meta 分析服务 v1.0
- Java WebSocket 接入，与其他工作流保持一致的消息协议
- 流程：意图识别 → 研究规划 → 文献检索 → 筛选 → 数据提取 → Meta分析 → 报告生成 → OSS上传 → finish消息
- 多轮对话：追问检测 + 上下文回答
- 并发支持：最多 MAX_SESSIONS 个会话同时运行
"""
from __future__ import annotations

import asyncio

# Motor 2.5.1 依赖 asyncio.coroutine（Python 3.11 已移除），补丁恢复
if not hasattr(asyncio, "coroutine"):
    import functools
    def _coroutine(func):
        if isinstance(func, type):
            return func
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            return func(*args, **kwargs)
        return wrapper
    asyncio.coroutine = _coroutine

import base64
import difflib
import ipaddress
import json
import logging
import os
import re
import socket
import subprocess
import sys
import time
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlparse

import aiohttp
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from new_meta.api import api_cors_origins, create_api_router
from new_meta.evimed_adapter import create_evimed_adapter_router

# 加载自身 .env
load_dotenv(Path(__file__).parent / ".env", override=False)
load_dotenv(Path(__file__).parent / "deploy.env", override=True)
load_dotenv()

from new_meta.core.llm import write_llm_usage_manifest

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)

from web_service.context import (
    META_ROOT,
    META_STEPS,
    REFERENCE_ADD_METHODOLOGY_SOURCE_TYPES,
    _resolve_project_dir,
    _make_ts,
)
from web_service.manuscript_review import (
    _load_manuscript_quality_payload,
    _build_reference_add_batch_suggestion,
    _reference_add_batch_dedupe_key,
    _reference_add_target_section,
    _manuscript_quality_review_contract,
    _build_manuscript_quality_actionable_issues,
    _actionable_clinical_interpretation_issue,
    _actionable_primary_result_issue,
    _actionable_claim_support_issue,
    _actionable_llm_reliability_issue,
    _llm_reliability_remediation_payload,
    _recommended_llm_max_tokens,
    _quality_integer_or_none,
    _actionable_readability_issue,
    _manuscript_quality_language,
    _detect_manuscript_quality_language_from_text,
    _manuscript_quality_language_detection_text,
    _strip_manuscript_quality_references,
    _manuscript_quality_language_gate,
    _expected_manuscript_quality_language,
    _normalize_manuscript_quality_language,
    _actionable_manuscript_language_issue,
    _manuscript_language_label,
    _manuscript_language_mismatch_warning_message,
    _manuscript_language_mismatch_issue_message,
    _manuscript_language_mismatch_suggested_action,
    _polish_guard_suggested_action,
    _polish_guard_message,
    _polish_rejections_warning_message,
    _polish_budget_warning_message,
    _polish_review_required_warning_message,
    _polish_proofreading_failed_warning_message,
    _polish_proofreading_failed_next_action,
    _readability_warning_message,
    _clinical_interpretation_warning_message,
    _primary_result_mismatch_warning_message,
    _claim_support_warning_message,
    _primary_result_issue_message,
    _primary_result_issue_suggested_action,
    _claim_support_issue_message,
    _claim_support_issue_suggested_action,
    _clinical_interpretation_issue_message,
    _clinical_interpretation_issue_suggested_action,
    _expected_value_from_claim_support_message,
    _readability_issue_message,
    _readability_issue_suggested_action,
    _citation_audit_missing_warning_message,
    _citation_coverage_warning_message,
    _citation_quality_warning_message,
    _llm_reliability_warning_message,
    _llm_reliability_issue_message,
    _llm_reliability_issue_suggested_action,
    _llm_reliability_remediation_message,
    _llm_reliability_issue_snippet,
    _polish_rejection_review_payload,
    _polish_rejected_edits_from_issues,
    _polish_edit_diff,
    _polish_manual_accept_condition,
    _actionable_citation_issue,
    _citation_issue_existing_citations,
    _citation_issue_suggested_action,
    _localized_citation_recommendations,
    _localized_reference_add_candidates,
    _display_citation_for_quality_context,
    _display_citation_for_language,
    _is_zh_quality_language,
    _zh_quality_section_label,
    _recommended_citations_for_issue,
    _reference_add_candidates_for_issue,
    _reference_add_candidate_rows_for_issue,
    _reference_candidate_matches_section,
    _preferred_reference_source_types_for_issue,
    _claim_preferred_source_types,
    _recommended_sections_for_reference_add_candidate,
    _canonical_quality_section,
    _reference_add_candidate_source_payload,
    _reference_add_candidate_trust_payload,
    _context_reference_add_candidate_rows,
    _prioritize_uncited_reference_candidates,
    _context_reference_candidates,
    _bibliography_reference_candidates,
    _bibliography_reference_source_type,
    _citation_number,
    _explicit_recommended_citation_numbers,
    _recommended_sections_for_reference,
    _manuscript_reference_count,
    _references_section_body,
    _manuscript_reference_title_tokens,
    _reference_title_token,
    _format_numbered_reference_from_paper,
    _format_bibtex_entry_from_paper,
    _rank_reference_candidates,
    _citation_issue_snippet,
    _markdown_section_target,
    _section_snippet,
    _snippet_around_pattern,
    _markdown_section_text_for_quality,
    _markdown_section_start_line,
    _compact_markdown_snippet,
    _slugify_anchor,
    _compact_polish_audit,
    _polish_proofreading_payload,
    _polish_review_queue,
    _polish_style_review_payload,
    _polish_style_issue_codes,
    _polish_resolved_style_issue_details,
    _polish_style_issue_details,
    _enrich_polish_style_issue,
    _polish_style_issue_message,
    _polish_style_issue_action,
    _polish_style_status,
    _polish_style_suggested_action,
    _compact_reference_context,
    _push_manuscript_quality,
    _make_manuscript_polish_progress_cb,
    _manuscript_quality_delta,
    _preview_manuscript_citation_patch_payload,
    _apply_manuscript_citation_patch_payload,
    _preview_manuscript_reference_add_payload,
    _apply_manuscript_reference_add_payload,
    _preview_manuscript_reference_add_batch_payload,
    _apply_manuscript_reference_add_batch_payload,
    _build_manuscript_citation_patch,
    _build_manuscript_reference_add_patch,
    _build_manuscript_reference_add_batch_patch,
    _sync_reference_add_context_citations,
    _reference_add_context_filename,
    _reference_add_context_match_index,
    _reference_add_context_row,
    _reference_add_batch_requests,
    _renumber_reference_add_candidate,
    _find_manuscript_quality_issue,
    _select_reference_add_candidate,
    _select_manuscript_patch_citation,
    _selected_manuscript_patch_candidate,
    _canonical_inline_citation,
    _select_manuscript_patch_target_section,
    _insert_citation_for_issue,
    _inserted_display_citation,
    _append_reference_to_manuscript,
    _insert_citation_into_section_body,
    _insert_citation_after_issue_excerpt,
    _citation_patch_issue_excerpt,
    _append_citation_to_paragraph,
    _has_inline_citation_marker,
    _display_citation_for_manuscript,
    _display_reference_for_manuscript,
    _prefers_full_width_citations,
    _markdown_section_match_for_quality,
    _main_text_before_reference_section,
    _reference_heading_match,
    _load_manuscript_citation_fix_log,
)

AGENT_TYPE = "meta-analysis"

# ── 线上环境 ──
JAVA_WS_URL = os.getenv("JAVA_WS_URL", "wss://evidence-factory.evimed.com/ws/ws")
JAVA_TOKEN_URL = os.getenv(
    "JAVA_TOKEN_URL",
    f"https://evidence-factory.evimed.com/api-evimed/ai-agent/token?clientType={AGENT_TYPE}",
)
JAVA_API_BASE = os.getenv("JAVA_API_BASE", "https://evidence-factory.evimed.com/api-evimed")
# ── 测试环境 ──
# JAVA_WS_URL = os.getenv("JAVA_WS_URL", "ws://192.168.20.252:2066/ws/ws")
# JAVA_TOKEN_URL = os.getenv(
#     "JAVA_TOKEN_URL",
#     f"http://192.168.20.252:2066/api-evimed/ai-agent/token?clientType={AGENT_TYPE}",
# )
# JAVA_API_BASE = os.getenv("JAVA_API_BASE", "http://192.168.20.252:2066/api-evimed")
OSS_ACCESS_KEY_ID     = os.getenv("OSS_ACCESS_KEY_ID")
OSS_ACCESS_KEY_SECRET = os.getenv("OSS_ACCESS_KEY_SECRET")
OSS_ENDPOINT          = os.getenv("OSS_ENDPOINT", "https://oss-cn-beijing.aliyuncs.com")
OSS_BUCKET_NAME       = os.getenv("OSS_BUCKET_NAME", "project-beijing-a4hznzutlh")
OSS_PUBLIC_BASE_URL   = os.getenv("OSS_PUBLIC_BASE_URL", "https://image.evimed.com/oss")
SERVICE_PORT          = int(os.getenv("SERVICE_PORT", "8002"))
MAX_SESSIONS          = int(os.getenv("MAX_CONCURRENT_SESSIONS", "16"))
USER_PDF_MAX_BYTES    = int(os.getenv("USER_PDF_MAX_BYTES", str(50 * 1024 * 1024)))
USER_PDF_TOTAL_MAX_BYTES = int(os.getenv("USER_PDF_TOTAL_MAX_BYTES", str(500 * 1024 * 1024)))
PDF_DOWNLOAD_ALLOW_INSECURE_HTTP = os.getenv("PDF_DOWNLOAD_ALLOW_INSECURE_HTTP", "").strip().lower() in {"1", "true", "yes", "on"}
PDF_DOWNLOAD_ALLOWED_HOSTS = [
    host.strip().lower()
    for host in os.getenv("PDF_DOWNLOAD_ALLOWED_HOSTS", "").split(",")
    if host.strip()
]

_java_client_task: asyncio.Task = None
_pipeline_executor = ThreadPoolExecutor(
    max_workers=MAX_SESSIONS,
    thread_name_prefix="meta-pipeline",
)
# Semaphore to limit concurrent pipeline runs; excess requests queue and wait
_pipeline_semaphore: asyncio.Semaphore = None  # initialized in lifespan
_pipeline_queue_lock: asyncio.Lock = None
_pipeline_waiting = 0
_pipeline_running = 0
_pipeline_limiter: "PipelineSlotLimiter | None" = None


class PipelineSlotTicket:
    def __init__(self, stage: str):
        self.stage = stage
        self.released = False


class PipelineSlotLimiter:
    """Fair async limiter that exposes queue status for the Web UI."""

    def __init__(self, max_sessions: int):
        self.max_sessions = max(1, int(max_sessions))
        self._condition = asyncio.Condition()
        self._waiters = deque()
        self._running = 0

    @property
    def running(self) -> int:
        return self._running

    @property
    def waiting(self) -> int:
        return len(self._waiters)

    def snapshot(self) -> dict[str, int]:
        return {
            "max_sessions": self.max_sessions,
            "running_sessions": self._running,
            "queued_sessions": len(self._waiters),
        }

    async def acquire(
        self,
        stage: str,
        *,
        status_cb: Callable[[dict[str, Any]], Any] | None = None,
    ) -> PipelineSlotTicket:
        token = object()
        queued_payload: dict[str, Any] | None = None
        started_payload: dict[str, Any] | None = None

        async with self._condition:
            if self._running < self.max_sessions and not self._waiters:
                self._running += 1
                return PipelineSlotTicket(stage)
            self._waiters.append(token)
            queued_payload = self._status_payload(stage, "queued", len(self._waiters))

        await self._emit_status(status_cb, queued_payload)

        try:
            async with self._condition:
                while self._running >= self.max_sessions or not self._waiters or self._waiters[0] is not token:
                    await self._condition.wait()
                self._waiters.popleft()
                self._running += 1
                started_payload = self._status_payload(stage, "started", 0)
        except BaseException:
            async with self._condition:
                try:
                    self._waiters.remove(token)
                except ValueError:
                    pass
                self._condition.notify_all()
            raise

        await self._emit_status(status_cb, started_payload)
        return PipelineSlotTicket(stage)

    async def release(self, ticket: PipelineSlotTicket | None) -> None:
        if ticket is None or ticket.released:
            return
        async with self._condition:
            self._running = max(0, self._running - 1)
            ticket.released = True
            self._condition.notify_all()

    def _status_payload(self, stage: str, status: str, queue_position: int) -> dict[str, Any]:
        message = (
            "当前同时运行任务已满，已进入排队。"
            if status == "queued"
            else "已获得运行名额，正在继续执行。"
        )
        return {
            "type": "service_busy",
            "stage": stage,
            "status": status,
            "queue_position": queue_position,
            "max_sessions": self.max_sessions,
            "running_sessions": self._running,
            "queued_sessions": len(self._waiters),
            "eta_seconds": None,
            "message": message,
        }

    async def _emit_status(
        self,
        status_cb: Callable[[dict[str, Any]], Any] | None,
        payload: dict[str, Any] | None,
    ) -> None:
        if status_cb is None or payload is None:
            return
        try:
            result = status_cb(payload)
            if hasattr(result, "__await__"):
                await result
        except Exception:
            logger.warning("Pipeline queue status callback failed", exc_info=True)

# ─────────────── MongoDB 连接池 ───────────────
_mongo_client = None

def _get_mongo_client():
    global _mongo_client
    if _mongo_client is None:
        from motor.motor_asyncio import AsyncIOMotorClient
        mongo_uri = os.getenv("MONGO_URI")
        if not mongo_uri:
            raise RuntimeError("MONGO_URI not configured")
        _mongo_client = AsyncIOMotorClient(
            mongo_uri,
            serverSelectionTimeoutMS=5000,
            socketTimeoutMS=10000,
            maxPoolSize=20,
            minPoolSize=2,
        )
    return _mongo_client

# ─────────────── 工具函数 ───────────────


def _pdf_intake_record_dict(record: Any) -> dict:
    """Return a JSON-safe dict for a PDF intake record."""
    if hasattr(record, "model_dump"):
        data = record.model_dump()
    elif isinstance(record, dict):
        data = dict(record)
    else:
        data = {
            name: getattr(record, name)
            for name in (
                "file_id",
                "filename",
                "local_path",
                "file_size_bytes",
                "sha256",
                "download_status",
                "download_error",
                "parse_status",
                "parse_error",
                "parser_used",
                "parser_cache_version",
                "cache_hit",
                "ocr_used",
                "page_count",
                "text_chars",
                "table_count",
                "empty_pages",
                "matched_pmid",
                "matched_title",
                "match_score",
                "match_method",
                "source_type",
                "requires_user_review",
            )
            if hasattr(record, name)
        }
    return data


def _prepare_web_manuscript_references(
    project,
    protocol,
    ref_manager,
    *,
    papers: list[dict] | None = None,
    extracted_studies: list | None = None,
    search_query: str = "",
    include_rob: bool = False,
    include_grade: bool = True,
    include_publication_bias: bool = True,
) -> dict:
    """Use the same manuscript reference enrichment chain for Web runs as CLI runs."""
    import new_meta.main as main_module
    from new_meta.tools.utils import paper_identity

    added_papers = 0
    for paper in papers or []:
        if not isinstance(paper, dict):
            continue
        try:
            before = len(ref_manager.entries)
            ref_manager.add(paper, study_id=paper_identity(paper))
            added_papers += int(len(ref_manager.entries) > before)
        except Exception:
            logger.debug("Skipping malformed manuscript reference paper.", exc_info=True)

    before_benchmark = len(ref_manager.entries)
    try:
        main_module._add_benchmark_references(ref_manager, extracted_studies or [])
    except Exception as exc:
        logger.warning("Benchmark reference enrichment failed: %s", exc, exc_info=True)
        if hasattr(project, "add_warning"):
            project.add_warning(
                "manuscript",
                f"Benchmark reference enrichment failed: {exc}",
                code="benchmark_reference_enrichment_failed",
            )
    added_benchmark = len(ref_manager.entries) - before_benchmark

    try:
        evidence_summary = main_module._add_evidence_context_references(
            project,
            protocol,
            ref_manager,
            search_query=search_query,
        )
    except Exception as exc:
        logger.warning("Background evidence reference enrichment failed: %s", exc, exc_info=True)
        evidence_summary = {"status": "error", "added_references": 0, "message": str(exc)}
        if hasattr(project, "add_warning"):
            project.add_warning(
                "manuscript",
                f"Background evidence reference enrichment failed: {exc}",
                code="evidence_reference_enrichment_failed",
            )

    methodology_summary = main_module._add_methodology_references(
        project,
        ref_manager,
        include_rob=include_rob,
        include_grade=include_grade,
        include_publication_bias=include_publication_bias,
    )
    project.save_text("references.bib", ref_manager.to_bibtex())
    return {
        "added_papers": added_papers,
        "added_benchmark": added_benchmark,
        "evidence": evidence_summary,
        "methodology": methodology_summary,
        "n_references": len(ref_manager.entries),
    }


def _polish_web_manuscript(
    project,
    *,
    payload: dict | None = None,
    model: str | None = None,
    lang: str | None = None,
    progress_cb=None,
) -> str | None:
    """Run the shared manuscript polish stage for Web-triggered manuscript writes."""
    from new_meta.main import _polish_project_manuscript

    payload = payload or {}
    args = SimpleNamespace(
        polish_manuscript=bool(payload.get("polish_manuscript") or payload.get("polishManuscript")),
        no_polish_manuscript=bool(payload.get("no_polish_manuscript") or payload.get("noPolishManuscript")),
        manuscript_polish_scope=(
            payload.get("manuscript_polish_scope")
            or payload.get("manuscriptPolishScope")
            or payload.get("polish_scope")
            or payload.get("polishScope")
        ),
    )
    polish_lang = _requested_output_language(
        payload,
        fallback_lang=lang,
        fallback_text=getattr(project, "topic", "") or "",
    )
    kwargs = {"model": model, "lang": polish_lang}
    if progress_cb is not None:
        kwargs["progress_cb"] = progress_cb
    return _polish_project_manuscript(project, args, **kwargs)


def _requested_output_language(payload: dict | None, *, fallback_lang: str | None = None, fallback_text: str = "") -> str:
    """Resolve explicit user-selected manuscript language before falling back to topic detection."""
    payload = payload if isinstance(payload, dict) else {}
    for key in ("output_language", "outputLanguage", "manuscript_language", "manuscriptLanguage", "language", "lang"):
        raw = str(payload.get(key) or "").strip()
        if not raw:
            continue
        lowered = raw.lower()
        if raw in {"中文", "汉语", "简体中文", "繁体中文"} or re.fullmatch(r"(zh|zh[-_](?:cn|hans|hant)|cn|chinese)", lowered):
            return "zh"
        if raw in {"英文", "英语"} or re.fullmatch(r"(en|en[-_][a-z]+|english)", lowered):
            return "en"
    normalized_fallback = str(fallback_lang or "").strip().lower()
    if normalized_fallback in {"zh", "en"}:
        return normalized_fallback
    return _detect_lang(fallback_text or "")


def _pdf_intake_progress_payload(
    record: Any,
    *,
    current: int,
    total: int,
    stage: str,
    session_id: str | None = None,
    project_dir: str | None = None,
) -> dict:
    """Build the structured WebSocket payload for one parsed uploaded PDF."""
    data = _pdf_intake_record_dict(record)
    total = max(int(total or 0), 1)
    current = max(1, min(int(current or 1), total))
    status = str(data.get("parse_status") or "unknown")
    return {
        "type": "pdf_intake",
        "stage": stage,
        "session_id": session_id or "",
        "project_dir": project_dir or "",
        "current": current,
        "total": total,
        "progress": round(current / total, 4),
        "is_finished": current >= total,
        "file": {
            "file_id": data.get("file_id"),
            "filename": data.get("filename") or Path(str(data.get("local_path") or "")).name,
            "local_path": data.get("local_path") or "",
            "file_size_bytes": int(data.get("file_size_bytes") or 0),
            "sha256": data.get("sha256"),
            "download_status": data.get("download_status") or "ok",
            "download_error": data.get("download_error"),
            "parse_status": status,
            "parse_error": data.get("parse_error"),
            "parser_used": data.get("parser_used"),
            "parser_cache_version": data.get("parser_cache_version"),
            "cache_hit": bool(data.get("cache_hit")),
            "ocr_used": bool(data.get("ocr_used")),
            "page_count": int(data.get("page_count") or 0),
            "text_chars": int(data.get("text_chars") or 0),
            "table_count": int(data.get("table_count") or 0),
            "empty_pages": data.get("empty_pages") or [],
            "matched_pmid": data.get("matched_pmid"),
            "matched_title": data.get("matched_title"),
            "match_score": data.get("match_score"),
            "match_method": data.get("match_method"),
            "source_type": data.get("source_type") or "user_upload",
            "requires_user_review": bool(data.get("requires_user_review")),
        },
        "message": _pdf_intake_progress_message(data, current=current, total=total),
    }


def _pdf_intake_progress_message(record: dict, *, current: int, total: int) -> str:
    filename = record.get("filename") or Path(str(record.get("local_path") or "")).name or "uploaded PDF"
    status = str(record.get("parse_status") or "unknown")
    if status == "ok":
        return (
            f"PDF 解析完成 {current}/{total}: {filename}，"
            f"{int(record.get('text_chars') or 0)} 字符，"
            f"{int(record.get('table_count') or 0)} 张表。"
        )
    if status == "empty_text":
        return f"PDF 解析需复核 {current}/{total}: {filename} 未提取到正文，可能是扫描件或排版异常。"
    if status == "failed":
        error = record.get("parse_error") or record.get("download_error") or "unknown error"
        return f"PDF 解析失败 {current}/{total}: {filename}，原因：{error}"
    return f"PDF 解析状态 {current}/{total}: {filename}，status={status}"


def _make_pdf_intake_progress_cb(
    push,
    *,
    total: int,
    stage: str,
    session_id: str | None,
    project_dir: str | None,
):
    state = {"current": 0}

    def _progress(record: Any) -> None:
        state["current"] += 1
        if push:
            push(
                "pdf_intake",
                _pdf_intake_progress_payload(
                    record,
                    current=state["current"],
                    total=total,
                    stage=stage,
                    session_id=session_id,
                    project_dir=project_dir,
                ),
            )

    return _progress


async def _get_java_token() -> str:
    """从 Java token 接口获取 Python Agent token（轮询直到成功）"""
    import aiohttp
    attempt = 0
    while True:
        attempt += 1
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(JAVA_TOKEN_URL, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    data = await resp.json(content_type=None)
                    token = (
                        (data.get("data") or {}).get("token")
                        or (data.get("data") or {}).get("accessToken")
                        or data.get("token", "")
                        or data.get("accessToken", "")
                    )
                    if token:
                        logger.info(f"获取 Java token 成功 (第{attempt}次尝试)")
                        return token
                    logger.warning(f"获取 Java token 返回空 (第{attempt}次)，5秒后重试...")
        except Exception as e:
            logger.error(f"获取 Java token 失败 (第{attempt}次): {e}，5秒后重试...")
        await asyncio.sleep(5)


def _do_upload_bytes(data: bytes, remote_path: str, retries: int = 3):
    """Upload raw bytes to OSS synchronously."""
    import oss2
    auth = oss2.Auth(OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET)
    bucket = oss2.Bucket(auth, OSS_ENDPOINT, OSS_BUCKET_NAME)
    for attempt in range(retries):
        try:
            bucket.put_object(remote_path, data)
            return
        except Exception as e:
            logger.warning(f"OSS upload failed (attempt {attempt + 1}): {e}")
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                raise


async def _upload_report(content: str, user_id: str, message_id: str) -> Optional[str]:
    if not OSS_ACCESS_KEY_ID or not OSS_ACCESS_KEY_SECRET:
        logger.warning("OSS 凭证未配置，跳过上传")
        return None
    remote_path = f"{AGENT_TYPE}/{user_id}/{message_id}/{int(time.time() * 1000)}.md"
    data = content.encode("utf-8")

    try:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, _do_upload_bytes, data, remote_path)
        logger.info(f"OSS 上传成功: {remote_path}")
        return f"{OSS_PUBLIC_BASE_URL}/{remote_path}"
    except Exception as e:
        logger.error(f"OSS 上传最终失败，降级为 base64 返回: {e}")
        return None


def _safe_pdf_filename(raw_name: object, fallback: str) -> str:
    """Return a traversal-safe PDF filename derived from untrusted metadata."""
    name = Path(str(raw_name or "")).name.strip() or fallback
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name)
    name = name.strip("._") or fallback
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    if name in {".pdf", "..pdf"} or "/" in name or "\\" in name or ".." in name:
        raise ValueError(f"unsafe PDF filename: {raw_name!r}")
    return name[:180]


def _safe_child_path(parent: Path, filename: str) -> Path:
    parent_resolved = parent.resolve()
    path = (parent / filename).resolve()
    if parent_resolved != path.parent and parent_resolved not in path.parents:
        raise ValueError("resolved PDF path escapes the target directory")
    return path


def _host_allowed_by_config(hostname: str) -> bool:
    if not PDF_DOWNLOAD_ALLOWED_HOSTS:
        return True
    host = hostname.lower().rstrip(".")
    return any(host == allowed or host.endswith(f".{allowed}") for allowed in PDF_DOWNLOAD_ALLOWED_HOSTS)


def _validate_download_url(url: str) -> str:
    parsed = urlparse(str(url or "").strip())
    if parsed.scheme not in {"https", "http"} or not parsed.hostname:
        raise ValueError("download URL must be http(s) with a hostname")
    if parsed.scheme == "http" and not PDF_DOWNLOAD_ALLOW_INSECURE_HTTP:
        raise ValueError("insecure HTTP PDF downloads are disabled")
    hostname = parsed.hostname.strip().lower()
    if hostname in {"localhost"} or hostname.endswith(".localhost") or hostname.endswith(".local"):
        raise ValueError("local hostnames are not allowed for PDF downloads")
    if not _host_allowed_by_config(hostname):
        raise ValueError(f"PDF download host is not in allowlist: {hostname}")

    try:
        infos = socket.getaddrinfo(hostname, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError(f"could not resolve PDF download host: {hostname}") from exc
    for info in infos:
        address = info[4][0]
        ip = ipaddress.ip_address(address)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            raise ValueError(f"PDF download host resolves to a non-public address: {hostname}")
    return parsed.geturl()


async def _download_pdf_url_to_path(session: aiohttp.ClientSession, url: str, save_path: Path) -> int:
    """Stream a verified PDF into save_path and return bytes written."""
    safe_url = _validate_download_url(url)
    timeout = aiohttp.ClientTimeout(total=120, sock_connect=15, sock_read=30)
    temp_path = save_path.with_name(f".{save_path.name}.{uuid.uuid4().hex}.tmp")
    total = 0
    header = b""
    try:
        async with session.get(safe_url, timeout=timeout) as resp:
            if resp.status != 200:
                raise ValueError(f"PDF download failed with HTTP {resp.status}")
            content_length = resp.headers.get("Content-Length")
            if content_length and int(content_length) > USER_PDF_MAX_BYTES:
                raise ValueError("PDF exceeds per-file size limit")
            with open(temp_path, "wb") as fh:
                async for chunk in resp.content.iter_chunked(65536):
                    if not chunk:
                        continue
                    if not header:
                        header = chunk[:5]
                    total += len(chunk)
                    if total > USER_PDF_MAX_BYTES:
                        raise ValueError("PDF exceeds per-file size limit")
                    fh.write(chunk)
        if total <= 100 or not header.startswith(b"%PDF"):
            raise ValueError("downloaded file is not a valid PDF")
        temp_path.replace(save_path)
        return total
    finally:
        if temp_path.exists():
            try:
                temp_path.unlink()
            except OSError:
                pass


async def _download_user_pdfs(file_ids: list, save_dir: Path, token: str = "") -> list[str]:
    """从 Java 文件服务器下载用户上传的 PDF 文件。

    调用 POST /medicine-api/file/parse-more 获取下载 URL，然后逐个下载保存。
    返回本地文件路径列表。
    """
    if not file_ids:
        return []

    papers_dir = save_dir / "papers"
    papers_dir.mkdir(parents=True, exist_ok=True)
    local_paths: list[str] = []

    try:
        async with aiohttp.ClientSession() as session:
            headers = {"Content-Type": "application/json"}
            if token:
                headers["token"] = token

            async with session.post(
                f"{JAVA_API_BASE}/medicine-api/file/parse-more",
                json={"ids": file_ids},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                data = await resp.json(content_type=None)

            files_info = data.get("data", [])
            if not files_info:
                logger.warning(f"Java 文件解析返回空: {data}")
                return []

            for file_info in files_info:
                if file_info.get("status") != "success":
                    logger.warning(f"跳过文件 status={file_info.get('status')}: {file_info.get('msg', '')}")
                    continue

                file_url = file_info.get("url", "")
                if not file_url:
                    continue

                url_path = urlparse(file_url).path
                file_name = _safe_pdf_filename(os.path.basename(url_path), f"user_{file_info.get('id', 'unknown')}.pdf")
                save_path = _safe_child_path(papers_dir, file_name)
                downloaded = await _download_pdf_url_to_path(session, file_url, save_path)
                if sum(Path(path).stat().st_size for path in local_paths if Path(path).exists()) + downloaded > USER_PDF_TOTAL_MAX_BYTES:
                    save_path.unlink(missing_ok=True)
                    raise ValueError("uploaded PDFs exceed total size limit")
                local_paths.append(str(save_path))
                logger.info(f"下载用户 PDF: {file_name} ({downloaded} bytes)")

    except Exception as e:
        logger.error(f"下载用户 PDF 出错: {e}", exc_info=True)

    return local_paths


async def _download_pdfs_from_mongo(file_ids: list, save_dir: Path) -> list[str]:
    """从 MongoDB share_search_file 集合查询文件 URL，下载 PDF 到 save_dir/papers/。"""
    from bson import ObjectId
    if not file_ids:
        return []

    papers_dir = save_dir / "papers"
    papers_dir.mkdir(parents=True, exist_ok=True)
    local_paths: list[str] = []
    db_name = os.getenv("MONGO_DB", "evimed_test")

    try:
        client = _get_mongo_client()
        collection = client[db_name]["share_search_file"]

        async with aiohttp.ClientSession() as http:
            for file_id in file_ids:
                try:
                    query_id = ObjectId(file_id)
                except Exception:
                    query_id = file_id

                doc = await collection.find_one(
                    {"_id": query_id},
                    {"url": 1, "fileName": 1, "originalFileName": 1},
                )
                if not doc:
                    logger.warning(f"MongoDB 未找到文件: {file_id}")
                    continue

                file_url = doc.get("url", "")
                if not file_url:
                    logger.warning(f"MongoDB 文件记录缺少 url: {file_id}")
                    continue

                filename = _safe_pdf_filename(
                    doc.get("originalFileName") or doc.get("fileName"),
                    f"paper_{str(file_id)[:8]}.pdf",
                )
                save_path = _safe_child_path(papers_dir, filename)
                downloaded = await _download_pdf_url_to_path(http, file_url, save_path)
                if sum(Path(path).stat().st_size for path in local_paths if Path(path).exists()) + downloaded > USER_PDF_TOTAL_MAX_BYTES:
                    save_path.unlink(missing_ok=True)
                    raise ValueError("uploaded PDFs exceed total size limit")
                local_paths.append(str(save_path))
                logger.info(f"下载用户 PDF: {filename} ({downloaded} bytes)")
    except Exception as e:
        logger.error(f"_download_pdfs_from_mongo 失败: {e}", exc_info=True)

    return local_paths

_QUESTION_PATTERNS = [
    r"[?？]\s*$",
    r"(吗|么|呢|嘛|吧)\s*[?？。]?\s*$",
    r"^(什么|如何|怎么|怎样|为什么|为何|是否|能否|可以|可否|请问|请帮|告诉我)",
    r"(哪个|哪些|哪里|哪儿|哪种|哪类|哪家|哪位|哪年|哪篇)",
    r"(多少|几个|几种|几篇|几位|几家|几年)",
    r"(是谁|由谁|谁是|谁的)",
    r"(有哪|是哪)",
    r"^(what|how|why|when|where|which|who|is\s|are\s|can\s|does\s|do\s|did\s|will\s|would\s)",
]

_GREETING_PATTERNS = re.compile(
    r'^(你好|您好|hi|hello|hey|嗨|哈喽|在吗|在不在|你是谁|你是什么|介绍一下你自己|你能做什么|你有什么功能|help|帮助)',
    re.IGNORECASE,
)


async def _classify_intent(text: str, session_ctx: dict) -> str:
    t = text.strip()
    if not t:
        return "other"
    if _GREETING_PATTERNS.match(t):
        return "greeting"

    from new_meta.config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
    if not LLM_API_KEY:
        return _fallback_intent(t, session_ctx)
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL or None)
        has_report = bool(session_ctx.get("last_report"))
        system_prompt = (
            "你是一个意图分类器。根据用户输入判断意图，只能回复以下标签之一：\n"
            "- meta_question: 提出了一个具体的医学系统评价/Meta分析研究问题（含干预/暴露、人群、结局等PICO要素，或明确要求做meta分析/系统评价/系统综述）\n"
            "- followup: 在追问之前Meta分析报告的内容（仅在已有报告时可用）\n"
            "- general_chat: 普通问答、概念解释、方法咨询、闲聊，不需要运行完整分析流程\n"
            "- greeting: 打招呼、询问功能介绍\n"
            "只回复标签名，不要回复其他内容。"
        )
        context_note = f"当前会话已完成分析主题：{session_ctx.get('last_topic', '无')}\n\n" if has_report else ""
        resp = await client.chat.completions.create(
            model=LLM_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"{context_note}用户输入：{t}"},
            ],
            max_tokens=10,
            temperature=0,
        )
        label = resp.choices[0].message.content.strip().lower() if resp.choices else ""
        if label in ("meta_question", "general_chat", "followup", "greeting"):
            return label
        if label == "new_analysis":
            return "meta_question"
    except Exception as e:
        logger.warning(f"意图分类 LLM 调用失败: {e}")
    return _fallback_intent(t, session_ctx)


def _fallback_intent(text: str, session_ctx: dict = None) -> str:
    t = text.strip()
    # Check question patterns first
    for pat in _QUESTION_PATTERNS:
        if re.search(pat, t, re.IGNORECASE):
            return "general_chat" if (session_ctx and session_ctx.get("last_report")) else "meta_question"
    # Short non-question text → general chat, not meta analysis
    if len(t) <= 30:
        return "general_chat"
    return "meta_question"


# ─────────────── 追问回答 ───────────────

async def _answer_from_report(
    question: str,
    session_ctx: dict,
    send_msg,
    session_id: str,
    message_id: str,
):
    _TW_CHUNK = 8
    _TW_DELAY = 0.03
    topic = session_ctx.get("last_topic", "")
    report_text = session_ctx.get("last_report", "")
    chat_history: list = session_ctx.get("chat_history", [])

    async def _send_stream(text: str, inprogress: bool, finished: bool = False):
        data = {"type": "text", "delta": text, "inprogress": inprogress}
        if finished:
            data["isFinished"] = True
        await send_msg({
            "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
            "content": {"clazz": "agent", "type": "stream", "data": data},
        })

    try:
        from new_meta.config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
        if not LLM_API_KEY:
            raise ValueError("LLM_API_KEY 未配置")

        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL or None)
        system = (
            "你是一位资深循证医学和 Meta 分析专家。用户已完成一项 Meta 分析，你手头有完整的分析报告。\n"
            "请基于报告内容，深入、准确地回答用户的追问。\n\n"
            "要求：\n"
            "- 使用 Markdown 格式，层次清晰\n"
            "- 引用报告中的具体统计数据（如效应量、置信区间、I²、p值等）来支撑回答\n"
            "- 如报告中无相关信息，明确告知并给出你的专业建议\n"
            "- 绝不编造数据或虚构研究结论\n"
            "- 语言专业、简洁，避免空泛描述"
        )
        messages = [{"role": "system", "content": system}]
        messages.append({"role": "user", "content": (
            f"## 分析主题\n{topic}\n\n"
            f"## 完整分析报告\n{report_text}"
        )})
        messages.append({"role": "assistant", "content": "已了解报告全部内容，请随时提问。"})
        for h in chat_history[-10:]:
            messages.append(h)
        messages.append({"role": "user", "content": question})

        buf = ""
        async for chunk in await client.chat.completions.create(
            model=LLM_MODEL,
            messages=messages,
            stream=True,
            max_tokens=3000,
        ):
            if not chunk.choices:
                continue
            delta = (chunk.choices[0].delta.content or "")
            if not delta:
                continue
            buf += delta
            await _send_stream(buf, inprogress=True)
            await asyncio.sleep(_TW_DELAY)

        session_ctx.setdefault("chat_history", []).append({"role": "user", "content": question})
        session_ctx["chat_history"].append({"role": "assistant", "content": buf})
        if len(session_ctx["chat_history"]) > 20:
            session_ctx["chat_history"] = session_ctx["chat_history"][-20:]

        await _send_stream(buf, inprogress=False, finished=True)
        return

    except Exception as e:
        logger.warning(f"LLM 追问回答失败: {e}")

    fallback = (
        f"当前 AI 服务不可用，无法回答追问。\n\n"
        f"如需了解「{topic}」Meta 分析报告的具体内容，请直接查阅上方生成的报告文件。\n"
        "如需重新分析或更换研究问题，请直接输入新的研究课题。"
    )
    buf = ""
    chunks_list = [fallback[i:i + _TW_CHUNK] for i in range(0, len(fallback), _TW_CHUNK)]
    for i, ch in enumerate(chunks_list):
        buf += ch
        is_last = i == len(chunks_list) - 1
        await _send_stream(buf, inprogress=not is_last, finished=is_last)
        await asyncio.sleep(_TW_DELAY)


async def _answer_general(
    question: str,
    session_ctx: dict,
    send_msg,
    session_id: str,
    message_id: str,
):
    """普通对话回答，不启动 pipeline。"""
    _TW_DELAY = 0.03
    chat_history: list = session_ctx.get("chat_history", [])

    async def _send_stream(text: str, inprogress: bool, finished: bool = False):
        data = {"type": "text", "delta": text, "inprogress": inprogress}
        if finished:
            data["isFinished"] = True
        await send_msg({
            "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
            "content": {"clazz": "agent", "type": "stream", "data": data},
        })

    try:
        from new_meta.config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
        if not LLM_API_KEY:
            raise ValueError("LLM_API_KEY 未配置")
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL or None)
        messages = [
            {"role": "system", "content": (
                "你是一位资深循证医学和 Meta 分析专家助手。"
                "请简洁、专业地回答用户的问题。"
                "如果用户提出了一个适合做系统评价/Meta分析的研究问题，"
                "请鼓励他直接输入该问题以启动完整分析流程。"
            )}
        ]
        for h in chat_history[-8:]:
            messages.append(h)
        messages.append({"role": "user", "content": question})

        buf = ""
        async for chunk in await client.chat.completions.create(
            model=LLM_MODEL, messages=messages, stream=True, max_tokens=2000,
        ):
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content or ""
            if not delta:
                continue
            buf += delta
            await _send_stream(buf, inprogress=True)
            await asyncio.sleep(_TW_DELAY)

        session_ctx.setdefault("chat_history", []).append({"role": "user", "content": question})
        session_ctx["chat_history"].append({"role": "assistant", "content": buf})
        if len(session_ctx["chat_history"]) > 20:
            session_ctx["chat_history"] = session_ctx["chat_history"][-20:]
        await _send_stream(buf, inprogress=False, finished=True)
        return

    except Exception as e:
        logger.warning(f"general_chat LLM 调用失败: {e}")

    await _send_stream(
        "抱歉，AI 服务暂时不可用。如需进行 Meta 分析，请直接输入具体的研究问题。",
        inprogress=False, finished=True,
    )


def _detect_lang(text: str) -> str:
    """Detect if text is primarily Chinese ('zh') or not ('en')."""
    cjk = sum(1 for ch in text if '一' <= ch <= '鿿')
    return "zh" if cjk > len(text) * 0.15 else "en"


# ─────────────── Meta 分析管线 ───────────────


# Per-step tool_call display: (icon_str, front_display_text, description)
META_STEP_DISPLAY = {
    0: ("正在规划", "正在解析研究问题，提取 PICO 要素…",
        "解析研究问题的人群(P)、干预(I)、对照(C)、结局(O)四要素，制定系统评价的纳入与排除标准，确定统计分析模型。"),
    1: ("正在检索", "正在构建系统检索策略，优化检索词组合…",
        "结合 MeSH 规范词汇与自由词，使用布尔逻辑运算符构建覆盖全面的 PubMed 检索式，并进行同义词和缩写扩展。"),
    2: ("正在检索", "正在检索 PubMed 数据库，获取相关文献…",
        "向 PubMed/MEDLINE 数据库提交检索请求，批量获取文献元数据（标题、摘要、作者、期刊、PMID、DOI 等），并进行去重处理。"),
    3: ("正在筛选", "正在对标题和摘要进行初筛，排除不相关文献…",
        "由自动筛选模型依据纳排标准评估每篇文献的标题和摘要，判断是否进入全文评审阶段；双评审模式为模型内模拟复核，并非人工审稿。"),
    4: ("正在提取", "正在进行全文筛选、数据提取与质量评估…",
        "对全文进行详细阅读，提取样本量、基线特征、干预措施、结局指标数值（均值/标准差/事件数）等关键数据，并记录研究质量信息。"),
    5: ("正在评估", "正在使用 Cochrane RoB 2.0 工具评估偏倚风险…",
        "依据 Cochrane RoB 2.0 框架，从随机化过程、偏倚分配、盲法实施、数据完整性、选择性报告等维度评估每项研究的偏倚风险。"),
    6: ("正在分析", "正在判断分析路径，评估定量合并可行性…",
        "评估纳入研究的效应量数据完整性与同质性，判断是否满足定量Meta分析条件（≥2项可提取、同质、可合并数据），否则转为叙述性系统评价。"),
    7: ("正在评估", "正在进行 GRADE 证据质量分级…",
        "依据 GRADE 框架，从研究设计、偏倚风险、不一致性、间接性、不精确性、发表偏倚六个维度对证据质量进行分级（高/中/低/极低）。"),
    8: ("正在分析", "正在生成统计图表…",
        "Meta分析模式下生成森林图、漏斗图及 PRISMA 2020 流程图；叙述性模式下仅生成 PRISMA 流程图与研究特征表。"),
    9: ("正在写作", "正在撰写符合 PRISMA 规范的系统评价报告…",
        "依据 PRISMA 2020 声明撰写完整的系统评价报告，包括摘要、引言、方法、结果、讨论和结论各节，并自动生成参考文献列表。"),
}

# Per-step completion summary (receives context dict with pipeline data)
META_STEP_SUMMARY = {
    0: lambda ctx: "✅ 研究规划完成\n\n已完成 PICO 要素提取，明确了研究纳入排除标准。",
    1: lambda ctx: "✅ 检索策略生成完成\n\n已构建优化的系统检索式。",
    2: lambda ctx: f"✅ 文献检索完成\n\n共检索到 **{ctx.get('n_papers', 0)}** 篇相关文献。",
    3: lambda ctx: f"✅ 标题摘要筛选完成\n\n初筛后纳入 **{ctx.get('n_ta_included', 0)}** 篇文献进入全文评估。",
    4: lambda ctx: (
        "\n".join(filter(None, [
            "✅ 全文筛选与数据提取完成",
            "",
            f"最终纳入 **{ctx.get('n_extracted', 0)}** 篇研究完成数据提取。",
            "",
            "**文献去向说明：**",
            f"- 标题摘要筛选通过：{ctx.get('n_ta_included', 0)} 篇",
            f"- 已使用全文 PDF：{ctx.get('n_fulltext_used', ctx.get('n_pdf_matched', 0))} 篇；未上传/未匹配全文而跳过：{ctx.get('n_ta_no_pdf', 0)} 篇"
            if ctx.get('n_user_pdfs', 0) > 0 else None,
            f"- 全文解析缓存命中：{ctx.get('n_pdf_cache_hits', 0) + ctx.get('n_fulltext_parse_cache_hits', 0)} 篇"
            if (ctx.get('n_pdf_cache_hits', 0) + ctx.get('n_fulltext_parse_cache_hits', 0)) > 0 else None,
            f"- 全文筛选通过：{ctx.get('n_ft_included', ctx.get('n_extracted', 0))} 篇"
            + f"（{ctx.get('n_ft_excluded', 0)} 篇不符纳入标准）" if ctx.get('n_ft_excluded', 0) > 0 else "",
            f"- 数据提取失败：{ctx.get('n_ft_included', ctx.get('n_extracted', 0)) - ctx.get('n_extracted', 0)} 篇"
            if ctx.get('n_ft_included', ctx.get('n_extracted', 0)) - ctx.get('n_extracted', 0) > 0 else None,
            f"- 数据溯源：{ctx.get('n_source_verified', 0)} 条引用已校验，"
            f"{ctx.get('n_extraction_review_items', 0)} 条需要人工复核"
            if ctx.get('n_extraction_outcomes', 0) > 0 else None,
        ]))
    ),
    5: lambda ctx: "✅ 偏倚风险评估完成\n\n已完成 Cochrane RoB 2.0 偏倚风险评价。",
    6: lambda ctx: (
        "⚠️ 证据差距报告\n\n"
        "无直接证据研究，现有证据不足以直接回答研究问题，生成证据差距报告。"
        if ctx.get("_evidence_gap") else
        f"✅ 分析路径判断\n\n"
        f"纳入 **{ctx.get('n_extracted', 0)}** 篇研究，可计算定量效应量的数据不足，"
        "将采用叙述性综合分析方式呈现结果。"
        if ctx.get("_narrative") else
        f"✅ 分析路径判断\n\n"
        f"合并效应量基于 **{ctx.get('n_effects', 0)}** 个效应估计，"
        f"I² = {ctx.get('i_squared', 0):.1f}%，进入定量Meta分析。"
    ),
    7: lambda ctx: (
        "✅ GRADE 评价\n\n未进行定量Meta分析，故未执行正式GRADE证据评级。"
        if ctx.get("_narrative") else
        "✅ GRADE 评价完成\n\n已完成证据质量分级。"
    ),
    8: lambda ctx: (
        f"✅ 图表生成完成\n\n已生成 PRISMA 2020 流程图与研究特征表。"
        if ctx.get("_narrative") else
        f"✅ 图表生成完成\n\n已生成 **{ctx.get('n_figures', 0)}** 张统计图表。"
    ),
    9: lambda ctx: _report_completion_summary(ctx),
}


def _report_completion_summary(ctx: dict) -> str:
    if ctx.get("report_type") == "evidence_gap":
        return (
            "⚠️ 报告撰写完成：证据缺口状态\n\n"
            f"当前报告类型为 `{ctx.get('report_type')}`，"
            f"仍有 {ctx.get('n_evidence_blockers', 0)} 个证据阻断项需要复核。"
        )

    lines = [
        "✅ 报告撰写完成",
        "",
        "已生成符合 PRISMA 规范的完整系统评价报告。",
    ]
    quality_lines: list[str] = []
    reference_entries = int(ctx.get("n_reference_entries") or 0)
    if reference_entries:
        quality_lines.append(f"- 参考文献：{reference_entries} 条")
    if "citation_audit_passed" in ctx:
        failed = int(ctx.get("n_citation_audit_failed_issues") or 0)
        if ctx.get("citation_audit_passed"):
            quality_lines.append("- 引用覆盖：通过")
        else:
            quality_lines.append(f"- 引用覆盖：需复核（{failed} 个问题）")
    if "polish_enabled" in ctx:
        if ctx.get("polish_enabled"):
            rejected_sections = int(ctx.get("n_polish_rejected_sections") or 0)
            rejected_chunks = int(ctx.get("n_polish_rejected_chunks") or 0)
            if rejected_sections or rejected_chunks:
                quality_lines.append(
                    f"- 润色保护：已启用，拒绝 {rejected_sections} 个章节 / {rejected_chunks} 个段落块"
                )
            else:
                quality_lines.append("- 润色保护：已启用，无事实/引用改写风险")
        else:
            quality_lines.append("- 润色保护：未启用")
    if quality_lines:
        lines.extend(["", "**稿件质量门：**", *quality_lines])
    return "\n".join(lines)


def _load_extraction_review_payload(project, ctx: dict) -> dict | None:
    """Load extraction audit and mirror key review counters into progress context."""
    from new_meta.core.extraction_review import (
        apply_extraction_review_decisions_to_audit,
        build_extraction_source_cards,
        build_extraction_source_card,
        build_source_context,
        summarize_source_context_cards,
        build_extraction_value_fields,
        has_count_conflict,
        load_extraction_outcome_rows,
        load_extraction_review_decisions,
        load_extraction_overrides,
    )

    audit = project.load_json("extraction_audit.json", subdir="extraction")
    if not audit:
        return None
    review_decisions = load_extraction_review_decisions(project)
    audit = apply_extraction_review_decisions_to_audit(audit, review_decisions)
    rows = audit.get("rows", [])
    if not isinstance(rows, list):
        rows = []

    outcome_by_row = load_extraction_outcome_rows(project)
    current_revision = load_extraction_overrides(project).current_revision
    source_cards = build_extraction_source_cards(project)

    def _compact_review_row(row: dict) -> dict:
        compact = {
            "row_id": row.get("row_id"),
            "study_id": row.get("study_id"),
            "outcome_index": row.get("outcome_index"),
            "study_label": row.get("study_label"),
            "title": row.get("title"),
            "outcome_name": row.get("outcome_name"),
            "outcome_type": row.get("outcome_type"),
            "value_summary": row.get("value_summary"),
            "source_location": row.get("source_location"),
            "source_page": row.get("source_page"),
            "source_section": row.get("source_section"),
            "source_quote": row.get("source_quote"),
            "source_quote_verified": row.get("source_quote_verified"),
            "extraction_confidence": row.get("extraction_confidence"),
            "timepoint": row.get("timepoint"),
            "accepted_timepoint": row.get("accepted_timepoint"),
            "timepoint_adjudication": row.get("timepoint_adjudication"),
            "timepoint_adjudication_note": row.get("timepoint_adjudication_note"),
            "manual_adjudication": row.get("manual_adjudication"),
            "conflicts": row.get("conflicts") or [],
            "requires_review": row.get("requires_review"),
            "needs_user_count_verification": has_count_conflict(row),
            "user_override_applied": row.get("user_override_applied"),
            "override_revision": row.get("override_revision"),
        }
        compact["value_fields"] = build_extraction_value_fields(row, outcome_by_row.get(str(row.get("row_id") or "")))
        compact["source_card"] = build_extraction_source_card(
            compact,
            outcome_by_row.get(str(row.get("row_id") or "")),
            current_revision=current_revision,
            review_revision=review_decisions.current_revision,
        )
        compact["source_card"]["source_context"] = build_source_context(project, compact["source_card"])
        return compact

    review_rows = [row for row in rows if row.get("requires_review")]
    conflict_rows = [row for row in rows if row.get("conflicts")]
    count_conflict_rows = [row for row in conflict_rows if has_count_conflict(row)]
    compact_rows = [_compact_review_row(row) for row in rows]
    review_compact_rows = [row for row in compact_rows if row.get("requires_review")]
    conflict_compact_rows = [row for row in compact_rows if row.get("conflicts")]
    count_conflict_compact_rows = [row for row in conflict_compact_rows if row.get("needs_user_count_verification")]

    summary = dict(audit.get("summary", {}) or {})
    summary["count_conflict_rows"] = len(count_conflict_rows)
    summary["review_decisions_revision"] = review_decisions.current_revision
    summary["review_decisions_accepted"] = summary.get("review_decisions_accepted", 0)
    summary["source_cards"] = len(source_cards)
    summary["extraction_source_cards"] = len(source_cards)
    summary["verified_source_cards"] = sum(1 for card in source_cards if (card.get("source") or {}).get("quote_verified") is True)
    summary["review_cards"] = len(review_compact_rows)
    source_context_summary = summarize_source_context_cards(source_cards)
    summary.update({
        key: source_context_summary[key]
        for key in (
            "source_context_available_cards",
            "source_context_missing_cards",
            "source_context_coverage",
            "source_context_missing_review_cards",
        )
    })
    ctx["n_extraction_outcomes"] = summary.get("outcomes", 0)
    ctx["n_source_verified"] = summary.get("source_quotes_verified", 0)
    ctx["n_source_unverified"] = summary.get("source_quotes_unverified", 0)
    ctx["n_extraction_review_items"] = summary.get("rows_requiring_review", 0)
    ctx["n_extraction_conflicts"] = summary.get("conflict_rows", 0)
    ctx["n_count_conflict_rows"] = len(count_conflict_rows)
    ctx["n_extraction_source_cards"] = len(source_cards)
    return {
        "project_dir": str(project.base_dir),
        "summary": summary,
        "rows": rows,
        "source_cards": source_cards,
        "review_cards": [row["source_card"] for row in review_compact_rows],
        "source_context_summary": source_context_summary,
        "missing_source_context_cards": source_context_summary["missing_source_context_cards"],
        "review_rows": review_compact_rows,
        "conflict_rows": conflict_compact_rows,
        "count_conflict_rows": count_conflict_compact_rows,
    }


def _apply_overrides_to_existing_extractions(project) -> dict:
    """Apply saved overrides to persisted extraction outputs and refresh audit."""
    from new_meta.agents.data_extraction_agent import DataExtractionAgent
    from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
    from new_meta.core.extraction_review import apply_extraction_overrides, load_extraction_overrides
    from new_meta.schemas.evidence_ledger import ActorType, EvidenceActor
    from new_meta.schemas.protocol import ResearchProtocol
    from new_meta.schemas.study import ExtractedStudy
    from new_meta.tools.utils import safe_identifier

    raw = project.load_json("all_extractions.json", subdir="extraction") or []
    if not raw:
        return {"applied": 0, "updated_extractions": 0, "audit": project.load_json("extraction_audit.json", subdir="extraction")}
    studies = [ExtractedStudy.model_validate(item) for item in raw]
    overrides = load_extraction_overrides(project)
    applied = apply_extraction_overrides(studies, overrides)
    if applied:
        for item in studies:
            sid = item.characteristics.pmid or item.characteristics.study_id
            if sid:
                project.save_json(f"{safe_identifier(sid)}.json", item, subdir="extraction")
        project.save_json("all_extractions.json", studies, subdir="extraction")
    ledger_report = None
    protocol_data = project.load_json("protocol.json")
    if applied and protocol_data:
        latest_override = max(
            overrides.overrides,
            key=lambda item: int(item.revision or 0),
        )
        ledger_report = migrate_extractions_to_ledger(
            project,
            protocol=ResearchProtocol.model_validate(protocol_data),
            extracted_studies=studies,
            actor=EvidenceActor(
                actor_id=str(latest_override.updated_by or "web_user"),
                actor_type=ActorType.HUMAN,
                code_version="extraction-override-v1",
            ),
            change_reason=f"extraction override revision {overrides.current_revision}",
        )
    audit = DataExtractionAgent()._build_extraction_audit(studies)
    audit["summary"]["overrides_revision"] = overrides.current_revision
    audit["summary"]["overrides_applied"] = applied
    project.save_json("extraction_audit.json", audit, subdir="extraction")
    project.save_text("extraction_audit.md", DataExtractionAgent()._audit_to_markdown(audit), subdir="extraction")
    return {
        "applied": applied,
        "updated_extractions": len(studies),
        "audit": audit,
        "ledger": ledger_report.model_dump(mode="json") if ledger_report is not None else None,
    }


def _save_result_rob_adjudication_payload(
    payload: dict,
    *,
    parent_id: str = "",
    user_id: str = "",
) -> dict:
    """Persist a human result-specific RoB decision from Web/API input."""
    from new_meta.core.project import Project
    from new_meta.core.result_rob import save_result_rob_adjudication
    from new_meta.schemas.risk_of_bias import ResultRoBAssessment, RoBAssessmentStatus

    project_dir = _resolve_project_dir(payload.get("project_dir"), parent_id=parent_id)
    project = Project("result RoB adjudication", resume_dir=project_dir)
    assessment_data = payload.get("assessment")
    if not isinstance(assessment_data, dict):
        raise ValueError("assessment is required")
    assessment_data = dict(assessment_data)
    result_id = str(assessment_data.get("result_id") or "").strip()
    queued = project.load_json("rob_result_assessments.json", subdir="risk_of_bias") or []
    queued_ids = {
        str(item.get("result_id") or "")
        for item in queued
        if isinstance(item, dict)
    }
    if result_id not in queued_ids:
        raise ValueError(
            f"result_id {result_id!r} is not present in the result-level RoB review queue"
        )
    reviewer = str(user_id or payload.get("adjudicated_by") or "").strip()
    if not reviewer:
        raise ValueError("authenticated reviewer identity is required")
    assessment_data["adjudicated_by"] = reviewer
    assessment_data["assessment_status"] = RoBAssessmentStatus.ADJUDICATED.value
    assessment_data["requires_adjudication"] = False
    assessment_data["assessment_origin"] = "human_adjudication"
    assessment = ResultRoBAssessment.model_validate(assessment_data)
    manifest = save_result_rob_adjudication(
        project,
        assessment,
        expected_revision=int(payload.get("expected_revision") or 0),
        reason=str(payload.get("reason") or "").strip(),
    )
    cleared = project.clear_downstream("rob")
    return {
        "ok": True,
        "type": "result_rob_adjudication",
        "project_dir": str(project.base_dir),
        "current_revision": manifest["current_revision"],
        "assessment": assessment.model_dump(mode="json"),
        "readiness": project.load_json("rob_result_readiness.json", subdir="risk_of_bias"),
        "cleared_checkpoints": cleared,
    }


def _clear_override_downstream_checkpoints(project) -> list[str]:
    """Clear downstream artifacts that depend on corrected extraction values."""
    return project.clear_downstream("extraction")


def _save_extraction_override_payload(payload: dict, *, parent_id: str = "", user_id: str = "") -> dict:
    """Persist one or more user extraction corrections from Web payload data."""
    from new_meta.core.extraction_review import (
        ExtractionOverride,
        OverrideConflictError,
        save_extraction_override,
        load_extraction_overrides,
    )
    from new_meta.core.project import Project
    from new_meta.schemas.study import OutcomeData

    project_dir = _resolve_project_dir(payload.get("project_dir"), parent_id=parent_id)
    project = Project("override", resume_dir=project_dir)
    expected_revision = payload.get("expected_revision")
    if expected_revision is not None:
        expected_revision = int(expected_revision)
    items = payload.get("overrides") or payload.get("items")
    if not items:
        single = payload.get("override") or payload
        items = [single]

    saved = None
    try:
        for item in items:
            study_id = str(item.get("study_id") or item.get("pmid") or "")
            field = str(item.get("field") or "")
            if not study_id or not field:
                raise ValueError("Each extraction override requires study_id and field")
            if field not in OutcomeData.model_fields:
                raise ValueError(f"Unsupported extraction override field: {field}")
            override = ExtractionOverride(
                study_id=study_id,
                outcome_index=item.get("outcome_index"),
                outcome_name=str(item.get("outcome_name") or ""),
                field=field,
                value=item.get("value"),
                reason=str(item.get("reason") or ""),
                updated_by=str(item.get("updated_by") or user_id or "web_user"),
            )
            saved = save_extraction_override(project, override, expected_revision=expected_revision)
            expected_revision = saved.current_revision
    except OverrideConflictError as exc:
        manifest = load_extraction_overrides(project)
        return {
            "ok": False,
            "error": "revision_conflict",
            "message": str(exc),
            "current_revision": manifest.current_revision,
            "project_dir": str(project.base_dir),
        }

    manifest = saved or load_extraction_overrides(project)
    apply_result = _apply_overrides_to_existing_extractions(project)
    cleared = _clear_override_downstream_checkpoints(project)
    ctx = {}
    extraction_review = _load_extraction_review_payload(project, ctx)
    return {
        "ok": True,
        "project_dir": str(project.base_dir),
        "current_revision": manifest.current_revision,
        "saved_count": len(items),
        "applied_overrides": apply_result.get("applied", 0),
        "updated_extractions": apply_result.get("updated_extractions", 0),
        "cleared_checkpoints": cleared,
        "extraction_review": extraction_review,
        "requires_rerun": True,
        "message": "Extraction override saved. Re-run effect selection/meta-analysis to clear downstream blockers.",
    }


def _save_protocol_override_payload(payload: dict, *, parent_id: str = "", user_id: str = "") -> dict:
    """Persist analysis-protocol corrections from benchmark/protocol adjudication."""
    from new_meta.core.benchmark_review import build_benchmark_review_payload
    from new_meta.core.protocol_overrides import apply_protocol_override
    from new_meta.core.project import Project
    from new_meta.schemas.protocol import ResearchProtocol

    project_dir = _resolve_project_dir(payload.get("project_dir"), parent_id=parent_id)
    project = Project("protocol override", resume_dir=project_dir)
    protocol_data = project.load_json("protocol.json")
    if not protocol_data:
        raise ValueError("protocol.json is required before saving a protocol override")
    protocol = ResearchProtocol.model_validate(protocol_data)

    fields = _protocol_override_fields_from_payload(payload)
    if not fields:
        raise ValueError("protocol override requires a non-empty fields object")

    result = apply_protocol_override(
        project,
        protocol,
        fields,
        reason=str(payload.get("reason") or ""),
        updated_by=str(payload.get("updated_by") or user_id or "web_user"),
    )
    changed_fields = result["changed_fields"]
    manifest = result["manifest"]

    if not changed_fields:
        return {
            "ok": True,
            "project_dir": str(project.base_dir),
            "changed_fields": {},
            "current_revision": manifest["current_revision"],
            "cleared_checkpoints": [],
            "requires_rerun": False,
            "message": "Protocol already matches the requested override.",
        }

    return {
        "ok": True,
        "project_dir": str(project.base_dir),
        "current_revision": manifest["current_revision"],
        "changed_fields": changed_fields,
        "cleared_checkpoints": result["cleared_checkpoints"],
        "benchmark": build_benchmark_review_payload(project),
        "evidence_readiness": _load_evidence_readiness_payload(project, {}) or None,
        "requires_rerun": True,
        "message": "Protocol override saved. Re-run downstream analysis to refresh effect sizes, GRADE, figures, and manuscript.",
    }


def _protocol_override_fields_from_payload(payload: dict) -> dict:
    patch = payload.get("suggested_protocol_patch")
    if isinstance(patch, dict) and isinstance(patch.get("fields"), dict):
        return dict(patch["fields"])
    if isinstance(payload.get("fields"), dict):
        return dict(payload["fields"])
    if isinstance(payload.get("protocol_patch"), dict):
        return dict(payload["protocol_patch"])
    return {}


def _clear_review_decision_downstream_checkpoints(project) -> list[str]:
    """Review decisions affect manuscript facts/readiness, but not effect estimates."""
    cleared = []
    if project.is_step_done("manuscript"):
        project.clear_checkpoint("manuscript")
        cleared.append("manuscript")
    return cleared


def _refresh_review_decision_artifacts(project) -> dict:
    """Refresh review-visible facts/package after source-card adjudication.

    Review decisions change evidence readiness but not extraction values or
    effect sizes, so this deliberately avoids LLM calls and deterministic
    re-analysis. It rebuilds the fact packet from cached pipeline outputs,
    revalidates an existing draft when present, and regenerates the package
    review files users inspect after clicking "accepted".
    """
    from new_meta.core.artifact_package import create_artifact_package
    from new_meta.core.manuscript_facts import build_manuscript_facts, validate_and_repair_manuscript
    from new_meta.schemas.grade import GRADEProfile
    from new_meta.schemas.meta_result import MetaAnalysisResults
    from new_meta.schemas.protocol import ResearchProtocol
    from new_meta.schemas.risk_of_bias import StudyRoB
    from new_meta.schemas.study import ExtractedStudy

    warnings: list[str] = []
    protocol_data = project.load_json("protocol.json")
    if not protocol_data:
        return {
            "artifacts_refreshed": False,
            "refresh_warnings": ["protocol.json is required to refresh manuscript facts."],
            "evidence_readiness": _load_evidence_readiness_payload(project, {}) or None,
        }

    protocol = ResearchProtocol.model_validate(protocol_data)
    meta_results = None
    meta_data = project.load_json("meta_results.json", subdir="analysis")
    if meta_data:
        try:
            meta_results = MetaAnalysisResults.model_validate(meta_data)
        except Exception as exc:
            warnings.append(f"Cached meta_results.json could not be loaded: {exc}")

    extracted_studies = []
    for item in project.load_json("all_extractions.json", subdir="extraction") or []:
        try:
            extracted_studies.append(ExtractedStudy.model_validate(item))
        except Exception as exc:
            warnings.append(f"Cached extraction row could not be loaded: {exc}")

    rob_results = []
    for item in project.load_json("rob_results.json", subdir="risk_of_bias") or []:
        try:
            rob_results.append(StudyRoB.model_validate(item))
        except Exception as exc:
            warnings.append(f"Cached RoB row could not be loaded: {exc}")

    grade_profile = None
    grade_data = project.load_json("grade_profile.json", subdir="analysis")
    if grade_data:
        try:
            grade_profile = GRADEProfile.model_validate(grade_data)
        except Exception as exc:
            warnings.append(f"Cached grade_profile.json could not be loaded: {exc}")

    prisma_data = project.load_json("prisma_flow.json") or project.prisma.to_dict()
    search_query = project.load_text("search_query.txt") or ""
    facts = build_manuscript_facts(
        protocol=protocol,
        meta_results=meta_results,
        extracted_studies=extracted_studies,
        rob_results=rob_results,
        prisma_data=prisma_data,
        search_query=search_query,
        project=project,
        grade_profile=grade_profile,
    )
    project.save_json("manuscript_facts.json", facts, subdir="manuscript")

    draft = project.load_text("draft.md", subdir="manuscript")
    validation = None
    if draft:
        repaired, validation = validate_and_repair_manuscript(draft, facts)
        project.save_text("draft.md", repaired, subdir="manuscript")
        project.save_json("manuscript_validation.json", validation, subdir="manuscript")
        if validation.get("passed") is True:
            project.save_checkpoint("manuscript")

    write_llm_usage_manifest(project)
    package_path = create_artifact_package(project)
    evidence_readiness = _load_evidence_readiness_payload(project, {}) or None
    manuscript_ready = bool(draft) and validation is not None and validation.get("passed") is True
    return {
        "artifacts_refreshed": True,
        "manuscript_ready": manuscript_ready,
        "refresh_warnings": warnings,
        "evidence_readiness": evidence_readiness,
        "package_path": str(package_path),
        "manuscript_validation": validation,
    }


def _save_extraction_review_decision_payload(payload: dict, *, parent_id: str = "", user_id: str = "") -> dict:
    """Persist one or more extraction row review decisions from Web payload data."""
    from new_meta.core.extraction_review import (
        ExtractionReviewDecision,
        OverrideConflictError,
        load_extraction_review_decisions,
        save_extraction_review_decision,
    )
    from new_meta.core.project import Project

    project_dir = _resolve_project_dir(payload.get("project_dir"), parent_id=parent_id)
    project = Project("extraction review decision", resume_dir=project_dir)
    expected_revision = payload.get("expected_revision")
    if expected_revision is not None:
        expected_revision = int(expected_revision)
    items = payload.get("decisions") or payload.get("items")
    if not items:
        single = payload.get("decision") or payload
        items = [single]

    saved = None
    try:
        for item in items:
            row_id = str(item.get("row_id") or "")
            study_id = str(item.get("study_id") or item.get("pmid") or "")
            outcome_index = item.get("outcome_index")
            if not row_id and (not study_id or outcome_index is None):
                raise ValueError("Each extraction review decision requires row_id or study_id + outcome_index")
            decision = ExtractionReviewDecision(
                row_id=row_id,
                study_id=study_id,
                outcome_index=outcome_index,
                outcome_name=str(item.get("outcome_name") or ""),
                decision=str(item.get("decision") or "accepted"),
                note=str(item.get("note") or item.get("reason") or ""),
                resolves_review=bool(item.get("resolves_review", True)),
                resolves_conflicts=bool(item.get("resolves_conflicts", True)),
                updated_by=str(item.get("updated_by") or user_id or "web_user"),
            )
            saved = save_extraction_review_decision(project, decision, expected_revision=expected_revision)
            expected_revision = saved.current_revision
    except OverrideConflictError as exc:
        manifest = load_extraction_review_decisions(project)
        return {
            "ok": False,
            "error": "revision_conflict",
            "message": str(exc),
            "current_revision": manifest.current_revision,
            "project_dir": str(project.base_dir),
        }

    manifest = saved or load_extraction_review_decisions(project)
    cleared = _clear_review_decision_downstream_checkpoints(project)
    ctx = {}
    extraction_review = _load_extraction_review_payload(project, ctx)
    refresh = _refresh_review_decision_artifacts(project)
    needs_rerun = bool(cleared) and not refresh.get("manuscript_ready")
    return {
        "ok": True,
        "project_dir": str(project.base_dir),
        "current_revision": manifest.current_revision,
        "saved_count": len(items),
        "cleared_checkpoints": cleared,
        "extraction_review": extraction_review,
        "requires_rerun": needs_rerun,
        "message": "Extraction review decision saved. Evidence readiness artifacts were refreshed."
        if refresh.get("artifacts_refreshed") and not needs_rerun
        else "Extraction review decision saved. Evidence readiness artifacts were refreshed, but manuscript generation still needs rerun or review."
        if refresh.get("artifacts_refreshed")
        else "Extraction review decision saved. Re-run manuscript generation to refresh evidence readiness.",
        **refresh,
    }


def _attach_fulltext_upload_payload(
    payload: dict,
    pdf_paths: list[str],
    *,
    parent_id: str = "",
    user_id: str = "",
    progress_cb=None,
) -> dict:
    """Attach user-uploaded PDFs to an existing project after an evidence gap."""
    from new_meta.core.fulltext_uploads import attach_user_fulltexts_to_project
    from new_meta.core.project import Project

    project_dir = _resolve_project_dir(payload.get("project_dir"), parent_id=parent_id)
    project = Project("fulltext upload", resume_dir=project_dir)
    result = attach_user_fulltexts_to_project(
        project,
        pdf_paths,
        session_id=parent_id or project.base_dir.name,
        progress_cb=progress_cb,
    )
    result["updated_by"] = user_id or "web_user"
    return result


def _attach_benchmark_source_payload(
    payload: dict,
    source_paths: list[str],
    *,
    parent_id: str = "",
    user_id: str = "",
) -> dict:
    """Attach user-uploaded benchmark source files for review without reclassifying evidence."""
    from new_meta.core.benchmark_review import build_benchmark_review_payload
    from new_meta.core.benchmark_sources import attach_benchmark_sources_to_project
    from new_meta.core.project import Project

    project_dir = _resolve_project_dir(payload.get("project_dir"), parent_id=parent_id)
    project = Project("benchmark source upload", resume_dir=project_dir)
    result = attach_benchmark_sources_to_project(
        project,
        source_paths,
        task_id=str(payload.get("task_id") or ""),
        trial_id=str(payload.get("trial_id") or ""),
        trial_name=str(payload.get("trial_name") or ""),
        source_kind=str(payload.get("source_kind") or payload.get("kind") or "benchmark_source"),
        user_id=user_id or str(payload.get("user_id") or "web_user"),
    )
    result["type"] = "benchmark_source_upload"
    result["updated_by"] = user_id or "web_user"
    result["benchmark"] = build_benchmark_review_payload(project)
    result["evidence_readiness"] = _load_evidence_readiness_payload(project, {})
    return result


def _save_benchmark_source_decision_payload(payload: dict, *, parent_id: str = "", user_id: str = "") -> dict:
    """Persist a reviewer decision for an uploaded benchmark source quote candidate."""
    from new_meta.core.benchmark_review import build_benchmark_review_payload
    from new_meta.core.benchmark_source_decisions import (
        BenchmarkSourceDecisionConflictError,
        load_benchmark_source_decisions,
        save_benchmark_source_decision,
    )
    from new_meta.core.project import Project

    project_dir = _resolve_project_dir(payload.get("project_dir"), parent_id=parent_id)
    project = Project("benchmark source decision", resume_dir=project_dir)
    expected_revision = payload.get("expected_revision")
    if expected_revision is not None:
        expected_revision = int(expected_revision)
    try:
        manifest = save_benchmark_source_decision(
            project,
            task_id=str(payload.get("task_id") or ""),
            trial_id=str(payload.get("trial_id") or ""),
            source=payload.get("source") or {},
            candidate=payload.get("candidate") or {},
            decision=str(payload.get("decision") or ""),
            reason=str(payload.get("reason") or ""),
            updated_by=str(payload.get("updated_by") or user_id or "web_user"),
            expected_revision=expected_revision,
        )
    except BenchmarkSourceDecisionConflictError as exc:
        manifest = load_benchmark_source_decisions(project)
        return {
            "ok": False,
            "type": "benchmark_source_decision",
            "error": "revision_conflict",
            "message": str(exc),
            "current_revision": manifest.current_revision,
            "project_dir": str(project.base_dir),
        }

    return {
        "ok": True,
        "type": "benchmark_source_decision",
        "project_dir": str(project.base_dir),
        "current_revision": manifest.current_revision,
        "benchmark": build_benchmark_review_payload(project),
        "message": "Benchmark source decision saved. It has not changed extraction or pooled effects yet.",
    }


def _apply_benchmark_source_candidates_payload(payload: dict, *, parent_id: str = "", user_id: str = "") -> dict:
    """Apply accepted benchmark source candidates into extraction data."""
    from new_meta.core.benchmark_review import build_benchmark_review_payload
    from new_meta.core.benchmark_source_apply import (
        BenchmarkSourceApplicationConflictError,
        apply_accepted_benchmark_source_candidates,
        load_benchmark_source_applications,
    )
    from new_meta.core.project import Project

    project_dir = _resolve_project_dir(payload.get("project_dir"), parent_id=parent_id)
    project = Project("benchmark source apply", resume_dir=project_dir)
    expected_revision = payload.get("expected_revision")
    if expected_revision is not None:
        expected_revision = int(expected_revision)
    candidate_ids = payload.get("candidate_ids") or payload.get("candidates") or payload.get("candidate_id")
    if isinstance(candidate_ids, str):
        candidate_ids = [candidate_ids]
    try:
        result = apply_accepted_benchmark_source_candidates(
            project,
            candidate_ids=candidate_ids,
            updated_by=str(payload.get("updated_by") or user_id or "web_user"),
            expected_revision=expected_revision,
            force=bool(payload.get("force") or payload.get("force_reapply")),
        )
    except BenchmarkSourceApplicationConflictError as exc:
        manifest = load_benchmark_source_applications(project)
        return {
            "ok": False,
            "type": "benchmark_source_apply",
            "error": "revision_conflict",
            "message": str(exc),
            "current_revision": manifest.current_revision,
            "project_dir": str(project.base_dir),
        }

    apply_result = _apply_overrides_to_existing_extractions(project)
    cleared = _clear_override_downstream_checkpoints(project)
    ctx = {}
    extraction_review = _load_extraction_review_payload(project, ctx)
    benchmark_review = build_benchmark_review_payload(project)
    result.update({
        "type": "benchmark_source_apply",
        "applied_overrides": apply_result.get("applied", 0),
        "updated_extractions": apply_result.get("updated_extractions", 0),
        "cleared_checkpoints": cleared,
        "extraction_review": extraction_review,
        "benchmark": benchmark_review,
        "evidence_readiness": _load_evidence_readiness_payload(project, {}),
        "requires_rerun": True,
        "message": "Accepted benchmark source candidates were applied to extraction data. Re-run downstream analysis to update pooled effects.",
    })
    return result


def _tail_text(text: str | bytes, limit: int = 4000) -> str:
    """Return the tail of process output for compact WebSocket diagnostics."""
    if not text:
        return ""
    if isinstance(text, bytes):
        text = text.decode("utf-8", errors="replace")
    return text[-limit:]


def _infer_resume_topic(project_dir: Path, payload: dict) -> str:
    """Infer the CLI topic required by new_meta.main for an existing project."""
    for key in ("topic", "research_question", "content", "text"):
        value = str(payload.get(key) or "").strip()
        if value:
            return value
    protocol_path = project_dir / "protocol.json"
    if protocol_path.exists():
        try:
            protocol = json.loads(protocol_path.read_text(encoding="utf-8"))
            question = str(protocol.get("research_question") or "").strip()
            if question:
                return question
        except (json.JSONDecodeError, OSError):
            pass
    # Project directory names are timestamp-prefixed, but still better than an
    # empty topic when resuming a legacy run with no protocol file.
    return project_dir.name


def _run_resume_subprocess(cmd: list[str], *, timeout_seconds: int) -> subprocess.CompletedProcess:
    """Run the canonical CLI resume command. Split out for focused tests."""
    return subprocess.run(
        cmd,
        cwd=str(META_ROOT),
        text=True,
        capture_output=True,
        timeout=timeout_seconds,
    )


def _resume_project_payload(payload: dict, *, parent_id: str = "", user_id: str = "") -> dict:
    """Resume a project through the canonical CLI checkpoint pipeline.

    This is used after user-uploaded full texts clear downstream checkpoints:
    the Web service delegates to ``new_meta.main --resume`` instead of keeping a
    second copy of the orchestration logic in start.py.
    """
    from new_meta.core.artifact_package import create_artifact_package
    from new_meta.core.project import Project

    project_dir = _resolve_project_dir(payload.get("project_dir"), parent_id=parent_id)
    project = Project("resume project", resume_dir=project_dir)
    completed_before = project.get_completed_steps()
    resume_step_before = project.get_resume_step()
    evidence_before = _load_evidence_readiness_payload(project, {})
    rerun_manuscript_only = bool(payload.get("rerun_manuscript_only") or payload.get("force_manuscript_rerun"))

    if resume_step_before is None and not rerun_manuscript_only:
        package_path = project.get_path("metaagent_export.zip", subdir="package")
        if not package_path.exists():
            write_llm_usage_manifest(project)
            package_path = create_artifact_package(project)
        return {
            "ok": True,
            "skipped": True,
            "project_dir": str(project.base_dir),
            "resume_step_before": None,
            "resume_step_after": None,
            "completed_steps_before": completed_before,
            "completed_steps_after": project.get_completed_steps(),
            "report_type": (evidence_before or {}).get("report_type"),
            "evidence_readiness": evidence_before,
            "manuscript_path": str(project.get_path("draft.md", subdir="manuscript")),
            "package_path": str(package_path),
            "message": "Project already has all checkpoints complete.",
        }

    topic = _infer_resume_topic(project_dir, payload)
    cmd = [
        sys.executable,
        "-m",
        "new_meta.main",
        "--topic",
        topic,
        "--resume",
        str(project_dir),
        "--skip-confirm",
    ]
    model = str(payload.get("model") or "").strip()
    if model:
        cmd.extend(["--model", model])
    if rerun_manuscript_only:
        cmd.append("--rerun-manuscript-only")
    analysis_type = str(payload.get("analysis_type") or "").strip()
    if analysis_type in {"pairwise", "network"}:
        cmd.extend(["--analysis-type", analysis_type])

    timeout_seconds = int(os.getenv("META_RESUME_TIMEOUT_SECONDS", "7200"))
    try:
        proc = _run_resume_subprocess(cmd, timeout_seconds=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        project.add_warning(
            "resume_project",
            f"Resume timed out after {timeout_seconds} seconds.",
            code="resume_timeout",
            severity="error",
            context={"project_dir": str(project_dir), "resume_step": resume_step_before},
        )
        return {
            "ok": False,
            "error": "resume_timeout",
            "project_dir": str(project.base_dir),
            "resume_step_before": resume_step_before,
            "completed_steps_before": completed_before,
            "timeout_seconds": timeout_seconds,
            "stdout_tail": _tail_text(exc.stdout or ""),
            "stderr_tail": _tail_text(exc.stderr or ""),
            "message": f"Resume timed out after {timeout_seconds} seconds.",
        }

    project = Project("resume project", resume_dir=project_dir)
    stdout_tail = _tail_text(proc.stdout or "")
    stderr_tail = _tail_text(proc.stderr or "")
    if proc.returncode != 0:
        project.add_warning(
            "resume_project",
            f"Resume failed with exit code {proc.returncode}.",
            code="resume_failed",
            severity="error",
            context={
                "project_dir": str(project_dir),
                "resume_step": resume_step_before,
                "stderr_tail": stderr_tail,
            },
        )
        return {
            "ok": False,
            "error": "resume_failed",
            "returncode": proc.returncode,
            "project_dir": str(project.base_dir),
            "resume_step_before": resume_step_before,
            "resume_step_after": project.get_resume_step(),
            "completed_steps_before": completed_before,
            "completed_steps_after": project.get_completed_steps(),
            "stdout_tail": stdout_tail,
            "stderr_tail": stderr_tail,
            "message": "Project resume failed; see stderr_tail and pipeline_warnings.json.",
        }

    evidence_readiness = _load_evidence_readiness_payload(project, {})
    package_path = project.get_path("metaagent_export.zip", subdir="package")
    if project.get_path("draft.md", subdir="manuscript").exists() and not package_path.exists():
        write_llm_usage_manifest(project)
        package_path = create_artifact_package(project)
    return {
        "ok": True,
        "skipped": False,
        "project_dir": str(project.base_dir),
        "resume_step_before": resume_step_before,
        "resume_step_after": project.get_resume_step(),
        "completed_steps_before": completed_before,
        "completed_steps_after": project.get_completed_steps(),
        "report_type": (evidence_readiness or {}).get("report_type"),
        "evidence_readiness": evidence_readiness,
        "manuscript_path": str(project.get_path("draft.md", subdir="manuscript")),
        "package_path": str(package_path) if package_path.exists() else "",
        "stdout_tail": stdout_tail,
        "stderr_tail": stderr_tail,
        "message": "Project resumed through the canonical checkpoint pipeline.",
    }


def _compute_primary_effect_selection(
    project,
    protocol,
    extracted_studies: list,
    log,
    *,
    rob_results: list | None = None,
    included_papers: list | None = None,
) -> tuple[list, list[dict]]:
    """Recompute primary-effect rows using the stricter CLI selector."""
    from new_meta.core.pipeline_runner import PipelineRunner

    return PipelineRunner(project, logger=log).compute_primary_effect_selection(
        protocol=protocol,
        extracted_studies=extracted_studies,
        rob_results=rob_results,
        included_papers=included_papers,
    )


def _run_downstream_after_overrides_payload(payload: dict, *, parent_id: str = "", user_id: str = "") -> dict:
    """Rerun the compiled deterministic downstream route after extraction overrides.

    This endpoint is deliberately route-aware.  A correction to a prevalence,
    diagnostic, NRSI, prognostic, or prediction review must re-execute its
    compiled method plugin from current Ledger results; it must never fall
    through to the legacy pairwise effect selector.
    """
    from new_meta.agents.writing_agent import WritingAgent
    from new_meta.core.artifact_package import create_artifact_package
    from new_meta.core.project import Project
    from new_meta.engines import visualization
    from new_meta.main import (
        _evaluate_evidence_gate_for_report,
        _require_full_text_sources,
        _run_grade_from_cached_meta,
        _run_meta_analysis_from_effects,
    )
    from new_meta.schemas.protocol import ResearchProtocol
    from new_meta.schemas.risk_of_bias import StudyRoB
    from new_meta.schemas.study import ExtractedStudy
    from new_meta.tools.reference_manager import ReferenceManager

    project_dir = _resolve_project_dir(payload.get("project_dir"), parent_id=parent_id)
    project = Project("downstream rerun", resume_dir=project_dir)
    log = logging.getLogger("metaagent.downstream_rerun")
    warnings: list[str] = []

    protocol_data = project.load_json("protocol.json")
    if not protocol_data:
        raise ValueError("protocol.json is required for downstream rerun")
    protocol = ResearchProtocol.model_validate(protocol_data)
    output_lang = _requested_output_language(
        payload,
        fallback_text=str(payload.get("topic") or getattr(protocol, "research_question", "") or project.topic or ""),
    )
    apply_result = _apply_overrides_to_existing_extractions(project)
    extracted_raw = project.load_json("all_extractions.json", subdir="extraction") or []
    if not extracted_raw:
        raise ValueError("extraction/all_extractions.json is required for downstream rerun")
    extracted_studies = [ExtractedStudy.model_validate(item) for item in extracted_raw]
    rob_results = [
        StudyRoB.model_validate(item)
        for item in (project.load_json("rob_results.json", subdir="risk_of_bias") or [])
    ]
    prisma_data = project.load_json("prisma_flow.json") or project.prisma.to_dict()
    search_query = project.load_text("search_query.txt") or ""

    # Recompile from the persisted protocol every time: a web override updates
    # input evidence, but must not silently reuse an obsolete plan/route.
    from new_meta.core.method_planning import compile_project_method_plan
    from new_meta.core.synthesis_routing import SynthesisRoute, load_synthesis_route

    method_plan = compile_project_method_plan(project, protocol, enforce=True)
    synthesis_route = load_synthesis_route(project)
    if synthesis_route.route is SynthesisRoute.METHOD_PLUGIN:
        # Migration is idempotent.  It is also required for legacy projects
        # that acquired a method plan before the Ledger migration was wired in.
        from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
        from new_meta.core.method_delivery import run_method_delivery
        from new_meta.schemas.phase_result import ExecutionStatus

        ledger_migration = migrate_extractions_to_ledger(
            project,
            protocol=protocol,
            extracted_studies=extracted_studies,
            change_reason="downstream rerun after extraction override",
        )
        delivery = run_method_delivery(
            project=project,
            protocol=protocol,
            extracted_studies=extracted_studies,
            rob_results=rob_results,
            prisma_data=prisma_data,
            search_query=search_query,
            lang=output_lang,
            auto_resolve_uncertainty=bool(payload.get("skip_confirm")),
        )
        method_phase = delivery.phase
        if method_phase.status is not ExecutionStatus.SUCCEEDED:
            return {
                "ok": False,
                "error": method_phase.error_code or "method_delivery_not_ready",
                "project_dir": str(project.base_dir),
                "warnings": warnings,
                "applied_overrides": apply_result.get("applied", 0),
                "synthesis_route": synthesis_route.route.value,
                "method_plan_fingerprint": method_plan.plan_fingerprint,
                "ledger_migration": ledger_migration.model_dump(mode="json"),
                "evidence_readiness": _load_evidence_readiness_payload(project, {}),
                "execution": method_phase.model_dump(mode="json"),
                "message": method_phase.summary,
            }

        write_llm_usage_manifest(project)
        package_path = create_artifact_package(project)
        evidence_readiness = _load_evidence_readiness_payload(project, {})
        manuscript_quality = _load_manuscript_quality_payload(project, {})
        from new_meta.core.phase_results import build_downstream_phase_result

        manuscript_path = project.get_path("draft.md", subdir="manuscript")
        phase_result = build_downstream_phase_result(
            project,
            evidence_readiness=evidence_readiness,
            manuscript_path=manuscript_path,
            package_path=package_path,
            metrics={
                "applied_overrides": apply_result.get("applied", 0),
                "method_inputs": int(method_phase.metrics.get("input_results") or 0),
            },
            warnings=warnings,
        )
        return {
            "ok": True,
            "project_dir": str(project.base_dir),
            "warnings": warnings,
            "applied_overrides": apply_result.get("applied", 0),
            "n_effects": 0,
            "n_selection_rows": 0,
            "n_method_inputs": int(method_phase.metrics.get("input_results") or 0),
            "synthesis_route": synthesis_route.route.value,
            "method_plan_fingerprint": method_plan.plan_fingerprint,
            "ledger_migration": ledger_migration.model_dump(mode="json"),
            "report_type": (evidence_readiness or {}).get("report_type"),
            "evidence_readiness": evidence_readiness,
            "manuscript_quality": manuscript_quality,
            "manuscript_path": str(manuscript_path),
            "package_path": str(package_path),
            "execution": phase_result.model_dump(mode="json"),
            "synthesis_execution": method_phase.model_dump(mode="json"),
            "decisions": delivery.decisions,
            "message": "The compiled method synthesis and fact-locked manuscript were rerun.",
        }
    if synthesis_route.route is not SynthesisRoute.PAIRWISE_AGGREGATE:
        return {
            "ok": False,
            "error": "synthesis_route_blocked",
            "project_dir": str(project.base_dir),
            "applied_overrides": apply_result.get("applied", 0),
            "synthesis_route": synthesis_route.route.value,
            "method_plan_fingerprint": method_plan.plan_fingerprint,
            "execution": {
                "status": "blocked",
                "error_code": "synthesis_route_blocked",
                "issues": [
                    {
                        "code": "synthesis_route_blocked",
                        "message": "; ".join(synthesis_route.blocking_reasons)
                        or f"No execution route is available for {method_plan.capability_id}.",
                    }
                ],
            },
            "message": "; ".join(synthesis_route.blocking_reasons)
            or "The compiled synthesis capability is not executable.",
        }

    included_rows = project.load_json("full_text_screening.json", subdir="screening") or []
    study_effects, selection_audit = _compute_primary_effect_selection(
        project,
        protocol,
        extracted_studies,
        log,
        rob_results=rob_results,
        included_papers=included_rows,
    )
    meta_results = None
    grade_profile = None
    figures_b64: dict[str, str] = {}

    if len(study_effects) >= 2:
        meta_results = _run_meta_analysis_from_effects(
            project,
            protocol=protocol,
            extracted_studies=extracted_studies,
            study_effects=study_effects,
        )
        grade_profile = _run_grade_from_cached_meta(
            project,
            None,
            protocol=protocol,
            meta_results=meta_results,
            rob_results=rob_results,
            extracted_studies=extracted_studies,
            force=True,
        )
        if grade_profile is None:
            warnings.append("GRADE rerun failed; see pipeline_warnings.json for details.")
        primary_result = meta_results.primary_outcome
        try:
            forest = visualization.forest_plot(primary_result, lang=output_lang)
            if forest:
                figures_b64["forest_plot"] = forest
            funnel = visualization.funnel_plot(primary_result, lang=output_lang)
            if funnel:
                figures_b64["funnel_plot"] = funnel
            prisma = visualization.prisma_flow_diagram(prisma_data, lang=output_lang)
            if prisma:
                figures_b64["prisma_diagram"] = prisma
        except Exception as exc:
            warnings.append(f"Figure rerun failed: {exc}")
        project.save_checkpoint("figures")
    else:
        warnings.append(f"Only {len(study_effects)} computable primary effect(s); manuscript will remain narrative/evidence-gap.")

    ref_manager = ReferenceManager()
    _prepare_web_manuscript_references(
        project,
        protocol,
        ref_manager,
        papers=project.load_json("pdf_download_results.json") or project.load_json("search_results.json") or [],
        extracted_studies=extracted_studies,
        search_query=search_query,
        include_rob=bool(rob_results),
        include_grade=grade_profile is not None,
        include_publication_bias=meta_results is not None,
    )

    # Zero computable effects should stay evidence_gap; one computable effect can
    # produce a narrative artifact, but must not be mislabeled as meta-ready.
    gate_result, report_state = _evaluate_evidence_gate_for_report(
        project,
        protocol,
        extracted_studies,
        prisma_data,
    )
    writer = WritingAgent(lang=output_lang, narrative_mode=len(study_effects) == 1, topic=project.topic)
    manuscript = writer.run(
        protocol=protocol,
        meta_results=meta_results,
        extracted_studies=extracted_studies,
        rob_results=rob_results,
        prisma_data=prisma_data,
        search_query=search_query,
        project=project,
        ref_manager=ref_manager,
        grade_profile=grade_profile,
        figures_b64=figures_b64,
        evidence_classes=gate_result.evidence_classes,
        report_state=report_state,
    )
    polished = _polish_web_manuscript(
        project,
        payload=payload,
        model=payload.get("model") if isinstance(payload, dict) else None,
        lang=output_lang,
    )
    if polished is not None:
        manuscript = polished
    project.save_checkpoint("manuscript")
    write_llm_usage_manifest(project)
    package_path = create_artifact_package(project)
    evidence_readiness = _load_evidence_readiness_payload(project, {})
    manuscript_quality = _load_manuscript_quality_payload(project, {})
    from new_meta.core.phase_results import build_downstream_phase_result

    manuscript_path = project.get_path("draft.md", subdir="manuscript")
    phase_result = build_downstream_phase_result(
        project,
        evidence_readiness=evidence_readiness,
        manuscript_path=manuscript_path,
        package_path=package_path,
        metrics={
            "applied_overrides": apply_result.get("applied", 0),
            "selected_effects": len(study_effects),
            "selection_audit_rows": len(selection_audit),
        },
        warnings=warnings,
    )
    return {
        "ok": True,
        "project_dir": str(project.base_dir),
        "warnings": warnings,
        "applied_overrides": apply_result.get("applied", 0),
        "n_effects": len(study_effects),
        "n_selection_rows": len(selection_audit),
        "report_type": (evidence_readiness or {}).get("report_type"),
        "evidence_readiness": evidence_readiness,
        "manuscript_quality": manuscript_quality,
        "manuscript_path": str(manuscript_path),
        "package_path": str(package_path),
        "execution": phase_result.model_dump(mode="json"),
        "message": "Downstream effect selection, meta-analysis, and manuscript facts were rerun.",
    }


def _load_evidence_readiness_payload(project, ctx: dict) -> dict | None:
    """Load manuscript evidence-readiness state for frontend review/adjudication."""
    from new_meta.core.benchmark_review import build_benchmark_review_payload
    from new_meta.core.extraction_review import summarize_selected_primary_source_context
    from new_meta.core.method_release import build_method_release_review

    facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    if not facts:
        return None
    validation = project.load_json("manuscript_validation.json", subdir="manuscript") or {}
    readiness = facts.get("evidence_readiness") or {}
    blockers = list(readiness.get("blockers", []))
    warnings = readiness.get("warnings", [])
    validation_issues = validation.get("issues", [])
    pipeline_warnings = project.load_json("pipeline_warnings.json") or []
    if not isinstance(pipeline_warnings, list):
        pipeline_warnings = []
    extraction_review = _load_extraction_review_payload(project, {}) or {}
    timepoint_adjudication_rows = _timepoint_adjudication_rows(readiness)
    primary_count_verification_rows = _primary_count_verification_rows(readiness)
    fulltext_upload_rows = _fulltext_upload_rows(readiness, facts, str(project.base_dir))
    benchmark_review = build_benchmark_review_payload(project)
    method_release = build_method_release_review(project)
    # The artifact package already carries this gate.  Surface the exact same
    # failed checks in the Web/API readiness envelope so a package with pending
    # result-level RoB or certainty cannot appear releasable in the UI.
    if method_release and method_release.get("passed") is not True:
        existing_codes = {
            str(item.get("code") or "")
            for item in blockers
            if isinstance(item, dict)
        }
        for check in method_release.get("checks") or []:
            if check.get("passed") is True:
                continue
            code = str(check.get("blocker_code") or "method_release_blocked")
            if code in existing_codes:
                continue
            blockers.append({
                "code": code,
                "message": (
                    "Compiled method release gate failed: "
                    f"{check.get('id') or code}. {check.get('detail') or ''}"
                ).strip(),
                "method_check": check.get("id"),
            })
            existing_codes.add(code)
    benchmark_summary = (benchmark_review or {}).get("summary") or {}
    source_context_summary = extraction_review.get("source_context_summary") or {}
    selected_primary_source_context = summarize_selected_primary_source_context(
        extraction_review.get("source_cards") or [],
        readiness.get("selected_primary_rows") or [],
    )

    ctx["report_type"] = facts.get("report_type")
    ctx["evidence_readiness_status"] = readiness.get("status")
    ctx["n_evidence_blockers"] = len(blockers)
    ctx["n_evidence_warnings"] = len(warnings)
    ctx["n_pipeline_warnings"] = len(pipeline_warnings)
    ctx["n_timepoint_adjudication_rows"] = len(timepoint_adjudication_rows)
    ctx["n_primary_count_verification_rows"] = len(primary_count_verification_rows)
    ctx["n_fulltext_upload_rows"] = len(fulltext_upload_rows)
    ctx["benchmark_status"] = (benchmark_review or {}).get("status")
    ctx["benchmark_passed"] = (benchmark_review or {}).get("passed")
    ctx["n_benchmark_failing_gates"] = benchmark_summary.get("failing_gates", 0)
    ctx["n_benchmark_missing_primary_full_texts"] = benchmark_summary.get("missing_primary_full_texts", 0)
    ctx["manuscript_validation_passed"] = validation.get("passed")
    ctx["n_selected_primary_source_context_available"] = selected_primary_source_context["selected_primary_source_context_available_cards"]
    ctx["n_selected_primary_source_context_missing"] = selected_primary_source_context["selected_primary_source_context_missing_cards"]

    return {
        "project_dir": str(project.base_dir),
        "report_type": facts.get("report_type"),
        "status": "blocked" if (method_release and method_release.get("passed") is not True) else readiness.get("status"),
        "action_required": bool(blockers) or validation.get("passed") is False or (benchmark_review or {}).get("passed") is False,
        "blocker_codes": list(dict.fromkeys(
            [str(item.get("code") or "") for item in blockers if isinstance(item, dict)]
            + [str(item) for item in (readiness.get("blocker_codes") or []) if str(item)]
        )),
        "blockers": blockers,
        "warnings": warnings,
        "benchmark": benchmark_review,
        "method_release": method_release,
        "selected_primary_rows": readiness.get("selected_primary_rows", []),
        "source_context_summary": source_context_summary,
        "selected_primary_source_context": selected_primary_source_context,
        "fulltext_upload_rows": fulltext_upload_rows,
        "timepoint_adjudication_rows": timepoint_adjudication_rows,
        "primary_count_verification_rows": primary_count_verification_rows,
        "extraction_audit_summary": readiness.get("extraction_audit_summary", {}),
        "extraction_review_queue": extraction_review.get("review_rows", [])[:50],
        "count_conflict_rows": extraction_review.get("count_conflict_rows", [])[:50],
        "primary_effect": facts.get("primary_effect"),
        "primary_population": facts.get("primary_population", {}),
        "text_sources": facts.get("text_sources", {}),
        "pipeline_warnings": pipeline_warnings[-50:],
        "pipeline_warning_count": len(pipeline_warnings),
        "validation": {
            "passed": validation.get("passed"),
            "issue_count": len(validation_issues),
            "error_count": sum(1 for issue in validation_issues if issue.get("severity") == "error"),
            "warning_count": sum(1 for issue in validation_issues if issue.get("severity") == "warning"),
            "issues": validation_issues,
        },
    }


def _fulltext_upload_rows(readiness: dict, facts: dict, project_dir: str) -> list[dict]:
    """Build frontend-ready rows for abstract-only primary effects needing PDFs."""
    issues = [
        issue for issue in readiness.get("blockers") or []
        if issue.get("code") == "abstract_only_primary_effect" and issue.get("row_id")
    ]
    if not issues:
        return []

    selected_by_row = {
        str(row.get("row_id") or ""): row
        for row in readiness.get("selected_primary_rows") or []
        if row.get("row_id")
    }
    warnings_by_key: dict[str, dict] = {}
    for warning in (facts.get("text_sources", {}) or {}).get("warnings", []) or []:
        for key in (warning.get("pmid"), warning.get("doi")):
            key = str(key or "").strip()
            if key:
                warnings_by_key[key] = warning

    rows = []
    for issue in issues:
        row_id = str(issue.get("row_id") or "")
        selected = selected_by_row.get(row_id, {})
        study_id = str(selected.get("study_id") or "")
        source_warning = warnings_by_key.get(study_id) or warnings_by_key.get(str(selected.get("doi") or "")) or {}
        pmid = source_warning.get("pmid") or study_id
        doi = source_warning.get("doi") or selected.get("doi") or ""
        title = source_warning.get("title") or selected.get("title") or selected.get("study_label") or study_id
        rows.append({
            "row_id": row_id,
            "study_id": study_id,
            "pmid": pmid,
            "doi": doi,
            "title": title,
            "outcome_name": selected.get("outcome_name") or "",
            "source_location": selected.get("source_location") or "",
            "source_section": selected.get("source_section") or "",
            "source_quote": selected.get("source_quote") or "",
            "text_availability": source_warning.get("text_availability") or "abstract_only",
            "warning": source_warning.get("warning") or issue.get("message") or "",
            "requires_user_full_text": True,
            "status": "missing_full_text",
            "issue": issue,
            "accepted_file_hints": [item for item in [pmid, doi, title] if item],
            "suggested_upload": {
                "type": "fulltext_upload",
                "project_dir": project_dir,
                "expected_pmid": pmid,
                "expected_doi": doi,
                "expected_title": title,
            },
        })
    return rows


def _timepoint_adjudication_rows(readiness: dict) -> list[dict]:
    """Build frontend-ready rows for accepting/rejecting ambiguous primary timepoints."""
    issue_by_row: dict[str, list[dict]] = {}
    for issue in list(readiness.get("blockers") or []) + list(readiness.get("warnings") or []):
        code = issue.get("code")
        if code not in {"primary_timepoint_not_source_verified", "primary_timepoint_adjudicated"}:
            continue
        row_id = str(issue.get("row_id") or "")
        if not row_id:
            continue
        issue_by_row.setdefault(row_id, []).append(issue)
    if not issue_by_row:
        return []

    selected_by_row = {
        str(row.get("row_id") or ""): row
        for row in readiness.get("selected_primary_rows") or []
        if row.get("row_id")
    }
    rows = []
    for row_id, issues in issue_by_row.items():
        selected = selected_by_row.get(row_id, {})
        blocking = any(issue.get("code") == "primary_timepoint_not_source_verified" for issue in issues)
        rows.append({
            "row_id": row_id,
            "study_id": selected.get("study_id") or "",
            "outcome_name": selected.get("outcome_name") or "",
            "source_location": selected.get("source_location") or "",
            "source_section": selected.get("source_section") or "",
            "source_quote": selected.get("source_quote") or "",
            "source_quote_verified": selected.get("source_quote_verified"),
            "timepoint": selected.get("timepoint") or "",
            "accepted_timepoint": selected.get("accepted_timepoint") or "",
            "timepoint_adjudication": selected.get("timepoint_adjudication") or "",
            "timepoint_adjudication_note": selected.get("timepoint_adjudication_note") or "",
            "manual_adjudication": selected.get("manual_adjudication"),
            "requires_user_adjudication": blocking,
            "status": "blocked" if blocking else "adjudicated",
            "issues": issues,
            "suggested_overrides": [
                {
                    "field": "timepoint_adjudication_note",
                    "value": "Accepted closest available primary timepoint after user/protocol review.",
                },
                {
                    "field": "accepted_timepoint",
                    "value": selected.get("timepoint") or selected.get("outcome_name") or "",
                },
            ],
        })
    return rows


def _primary_count_verification_rows(readiness: dict) -> list[dict]:
    """Build frontend-ready rows for source-verifying primary arm counts."""
    issues = [
        issue for issue in readiness.get("blockers") or []
        if issue.get("code") == "primary_counts_not_source_verified" and issue.get("row_id")
    ]
    if not issues:
        return []
    selected_by_row = {
        str(row.get("row_id") or ""): row
        for row in readiness.get("selected_primary_rows") or []
        if row.get("row_id")
    }
    rows = []
    for issue in issues:
        row_id = str(issue.get("row_id") or "")
        selected = selected_by_row.get(row_id, {})
        missing_values = issue.get("missing_values") or []
        rows.append({
            "row_id": row_id,
            "study_id": selected.get("study_id") or "",
            "outcome_name": selected.get("outcome_name") or "",
            "source_location": selected.get("source_location") or "",
            "source_section": selected.get("source_section") or "",
            "source_quote": selected.get("source_quote") or "",
            "source_quote_verified": selected.get("source_quote_verified"),
            "events_intervention": selected.get("events_intervention"),
            "total_intervention": selected.get("total_intervention"),
            "events_control": selected.get("events_control"),
            "total_control": selected.get("total_control"),
            "missing_values": missing_values,
            "requires_user_count_source_verification": True,
            "issue": issue,
            "suggested_overrides": [
                {
                    "field": "source_quote",
                    "value": selected.get("source_quote") or "",
                    "instruction": "Replace with the exact table/text quote containing all four arm-level counts.",
                },
                {
                    "field": "source_location",
                    "value": selected.get("source_location") or "",
                    "instruction": "Point to the table, figure, page, or paragraph containing all four counts.",
                },
            ],
        })
    return rows


def _save_evidence_gap_validation(
    *,
    project,
    protocol,
    manuscript: str,
    extracted_studies: list,
    rob_results: list,
    prisma_data: dict,
    search_query: str,
    report_state,
) -> str:
    """Persist manuscript facts/validation for deterministic EvidenceGate gap reports."""
    from new_meta.core.manuscript_facts import build_manuscript_facts, validate_and_repair_manuscript
    from new_meta.agents.writing_agent import WritingAgent

    facts = build_manuscript_facts(
        protocol=protocol,
        meta_results=None,
        extracted_studies=extracted_studies,
        rob_results=rob_results or [],
        prisma_data=prisma_data,
        search_query=search_query,
        project=project,
        grade_profile=None,
    )
    if report_state is not None:
        WritingAgent._force_report_state_evidence_gap(facts, report_state)
    project.save_json("manuscript_facts.json", facts, subdir="manuscript")
    manuscript, validation = validate_and_repair_manuscript(manuscript, facts)
    project.save_json("manuscript_validation.json", validation, subdir="manuscript")
    project.save_text("draft.md", manuscript, subdir="manuscript")
    return manuscript


def _run_phase1_sync(topic: str, output_dir: str, push=None) -> dict:
    """Run steps 0-3 (PICO → Query → Search → T/A Screening). Returns state dict for phase 2."""
    def _push(kind, payload):
        if push:
            push(kind, payload)
    try:
        result = _run_phase1_inner(topic, output_dir, _push)
        _push("phase1_done", result)
        return result
    except Exception as e:
        _push("error", str(e))
        raise


def _run_phase1_inner(topic: str, output_dir: str, _push) -> dict:
    ctx: dict = {}
    if str(META_ROOT) not in sys.path:
        sys.path.insert(0, str(META_ROOT))

    from new_meta.core.project import Project
    from new_meta.core.method_planning import compile_project_method_plan
    from new_meta.core.evidence_gap_delivery import complete_zero_record_review
    from new_meta.core.pdf_intake import PDF_PARSE_CACHE_VERSION, parse_file_with_cache, parse_user_pdfs, save_pdf_intake_manifest
    from new_meta.agents.research_planner import ResearchPlanner
    from new_meta.agents.query_builder import QueryBuilder
    from new_meta.agents.paper_retriever import PaperRetriever
    from new_meta.agents.screening_agent import ScreeningAgent

    pl = logging.getLogger("metaagent.pipeline")
    pl.info(f"Phase1 启动: {topic}")
    project = Project(topic, output_dir=Path(output_dir))

    _push("progress", (0, META_STEPS[0]))
    protocol = ResearchPlanner().run(topic)
    project.save_json("protocol.json", protocol)
    compile_project_method_plan(
        project,
        protocol,
        enforce=True,
    )
    project.save_checkpoint("protocol")
    _push("done_step", (0, META_STEPS[0], ctx))

    _push("progress", (1, META_STEPS[1]))
    query_result = QueryBuilder().run(protocol)
    if isinstance(query_result, tuple):
        search_query = query_result[0]
        is_single_drug = query_result[2] if len(query_result) > 2 else False
    else:
        search_query = query_result
        is_single_drug = False
    project.save_text("search_query.txt", search_query)
    project.save_checkpoint("search_query")
    _push("done_step", (1, META_STEPS[1], ctx))

    _push("progress", (2, META_STEPS[2]))
    retriever = PaperRetriever()
    if is_single_drug:
        papers = retriever.search_monotherapy_priority(
            search_query, protocol.pico.intervention, project,
            date_range=protocol.date_range,
        )
    else:
        papers = retriever.search_and_fetch(search_query, project, date_range=protocol.date_range)
    if len(papers) < 30:
        pl.warning(f"首次检索仅 {len(papers)} 篇，尝试放宽检索策略…")
        broad_terms = [t for t in re.findall(r'"([^"]+)"', search_query) if len(t) < 60 and not t.isdigit()]
        if broad_terms:
            core_terms = broad_terms[:6]
            broad_query = (
                "(" + " OR ".join(f'"{t}"[tiab]' for t in core_terms) + ") "
                'AND ("randomized controlled trial"[pt] OR randomized[tiab])'
            )
            broad_results = retriever.search_and_fetch(broad_query, project, date_range=protocol.date_range)
            if len(broad_results) > len(papers):
                # Merge and deduplicate instead of replacing
                seen_pmids = {p.get("pmid") for p in papers}
                for p in broad_results:
                    if p.get("pmid") not in seen_pmids:
                        papers.append(p)
                        seen_pmids.add(p.get("pmid"))
                # PRISMA: records_identified already set by search_and_fetch (pre-dedup)
                # Just update after_dedup
                project.prisma.records_after_dedup = len(papers)
    project.save_checkpoint("search")
    ctx["n_papers"] = len(papers)
    _push("done_step", (2, META_STEPS[2], ctx))

    if not papers:
        manuscript = complete_zero_record_review(
            project=project,
            protocol=protocol,
            search_query=search_query,
            prisma_data=project.prisma.to_dict(),
            reason="no_records_identified",
            lang=_requested_output_language({}, fallback_text=topic),
        )
        return {
            "ta_included": [],
            "protocol": protocol,
            "search_query": search_query,
            "project_dir": str(project.base_dir),
            "ctx": dict(ctx),
            "terminal_manuscript": manuscript,
            "terminal_reason": "no_records_identified",
        }

    _push("progress", (3, META_STEPS[3]))
    screener = ScreeningAgent()
    ta_included, _ = screener.screen_title_abstract(papers, protocol, project)
    project.save_checkpoint("ta_screening")
    ctx["n_ta_included"] = len(ta_included)
    _push("done_step", (3, META_STEPS[3], ctx))

    if not ta_included:
        manuscript = complete_zero_record_review(
            project=project,
            protocol=protocol,
            search_query=search_query,
            prisma_data=project.prisma.to_dict(),
            reason="no_records_eligible",
            lang=_requested_output_language({}, fallback_text=topic),
        )
        return {
            "ta_included": [],
            "protocol": protocol,
            "search_query": search_query,
            "project_dir": str(project.base_dir),
            "ctx": dict(ctx),
            "terminal_manuscript": manuscript,
            "terminal_reason": "no_records_eligible",
        }

    project.save_json("ta_included.json", ta_included)
    pl.info(f"Phase1 完成，共 {len(ta_included)} 篇进入全文阶段")

    return {
        "ta_included": ta_included,
        "protocol": protocol,
        "search_query": search_query,
        "project_dir": str(project.base_dir),
        "ctx": dict(ctx),
    }


def _run_phase2_sync(phase1_state: dict, output_dir: str, push=None, user_pdf_paths: list = None) -> str:
    """Run steps 4-9 using phase 1 state. Returns manuscript markdown."""
    def _push(kind, payload):
        if push:
            push(kind, payload)
    try:
        return _run_phase2_inner(phase1_state, output_dir, _push, user_pdf_paths or [])
    except Exception as e:
        if "Full text sources are required" in str(e):
            project_dir = str(phase1_state.get("project_dir") or "")
            screened_records = len(phase1_state.get("ta_included") or [])
            _push("fulltext_required", {
                "type": "fulltext_required",
                "project_dir": project_dir,
                "screened_records": screened_records,
                "message": str(e),
                "suggested_upload": {
                    "type": "fulltext_upload",
                    "project_dir": project_dir,
                },
            })
        _push("error", str(e))
        raise


def _finalize_web_release(project, *, manuscript: str, push) -> dict:
    """Build the review package and emit exactly one terminal Web outcome."""
    from new_meta.core.artifact_package import create_artifact_package
    from new_meta.core.llm import write_llm_usage_manifest
    from new_meta.core.release_contract import ReleaseStatus, load_release_decision

    write_llm_usage_manifest(project)
    package_path = create_artifact_package(project)
    decision = load_release_decision(project) or {
        "status": ReleaseStatus.BLOCKED.value,
        "summary": "The artifact package did not produce a release decision.",
        "next_actions": ["Rebuild the package and inspect submission readiness."],
        "blocker_codes": ["missing_release_decision"],
        "warning_codes": [],
    }
    if str(decision.get("status") or "").strip().lower() == ReleaseStatus.BLOCKED.value:
        push(
            "blocked",
            {
                **decision,
                "project_dir": str(project.base_dir),
                "manuscript_path": str(project.get_path("draft.md", subdir="manuscript")),
                "package_path": str(package_path),
            },
        )
    else:
        push("done", manuscript)
    return decision


def _run_phase2_inner(phase1_state: dict, output_dir: str, _push, user_pdf_paths: list) -> str:
    if str(META_ROOT) not in sys.path:
        sys.path.insert(0, str(META_ROOT))

    from new_meta.core.project import Project
    from new_meta.core.pdf_intake import parse_user_pdfs, save_pdf_intake_manifest
    from new_meta.agents.pdf_parser import parse_pdf
    from new_meta.agents.screening_agent import ScreeningAgent
    from new_meta.agents.data_extraction_agent import DataExtractionAgent
    from new_meta.agents.rob_agent import RoBAgent
    from new_meta.agents.writing_agent import WritingAgent
    from new_meta.engines import visualization
    from new_meta.tools.utils import paper_identity
    from new_meta.main import (
        _require_full_text_sources,
        _run_grade_from_cached_meta,
        _run_meta_analysis_from_effects,
    )
    from new_meta.tools.reference_manager import ReferenceManager

    pl = logging.getLogger("metaagent.pipeline")

    ta_included = phase1_state["ta_included"]
    n_original_ta = len(ta_included)
    protocol = phase1_state["protocol"]
    search_query = phase1_state["search_query"]
    ctx = dict(phase1_state.get("ctx", {}))

    project_dir = Path(phase1_state["project_dir"])
    if not project_dir.exists():
        raise ValueError(f"phase1 project_dir does not exist: {project_dir}")
    project = Project(phase1_state.get("topic", "unknown"), resume_dir=project_dir)
    output_lang = _requested_output_language(
        phase1_state,
        fallback_text=str(phase1_state.get("topic") or ""),
    )

    retriever_cls = None
    try:
        from new_meta.agents.paper_retriever import PaperRetriever
        retriever_cls = PaperRetriever
    except Exception:
        pass

    # Step 4: Full-text screening + Data extraction
    _push("progress", (4, META_STEPS[4]))

    # Use all user-uploaded PDFs directly; no automatic download attempted
    # Match user PDFs to papers in ta_included by filename proximity
    pre_parsed: dict[str, dict] = {}  # pdf_path -> parse_pdf result，预解析避免重复解析
    n_pdf_matched = 0

    if user_pdf_paths:
        # 预解析所有 PDF（用于匹配 + 后续提取，只解析一次），并写入可审计的 intake manifest。
        manifest, pre_parsed = parse_user_pdfs(
            user_pdf_paths,
            project.base_dir,
            session_id=phase1_state.get("parent_id") or project_dir.name,
            progress_cb=_make_pdf_intake_progress_cb(
                _push,
                total=len(user_pdf_paths),
                stage="phase2_pdf_intake",
                session_id=phase1_state.get("parent_id") or project_dir.name,
                project_dir=str(project.base_dir),
            ),
        )
        save_pdf_intake_manifest(manifest, project.base_dir)
        ctx["n_pdf_parse_failed"] = sum(1 for f in manifest.files if f.parse_status == "failed")
        ctx["n_pdf_empty_text"] = sum(1 for f in manifest.files if f.parse_status == "empty_text")
        ctx["n_pdf_cache_hits"] = sum(1 for f in manifest.files if f.cache_hit)
        for item in manifest.files:
            pl.info(
                f"PDF intake: {item.filename} status={item.parse_status} "
                f"chars={item.text_chars} tables={item.table_count} cache={item.cache_hit}"
            )

        assigned_pdfs: set[str] = set()
        for paper in ta_included:
            pmid = str(paper.get("pmid", ""))
            doi_raw = (paper.get("doi", "") or "").lower()
            # DOI 末段（斜杠后）通常就是文件名，如 10.1002/art.40049 → art.40049
            doi_suffix = doi_raw.split("/")[-1] if "/" in doi_raw else doi_raw
            title_words = set(w for w in (paper.get("title", "") or "").lower().split() if len(w) > 3)
            for pdf_path in user_pdf_paths:
                if pdf_path in assigned_pdfs:
                    continue
                fname = Path(pdf_path).stem.lower()
                # 匹配优先级:
                # 1) PMID 出现在文件名
                if pmid and pmid in fname:
                    paper["pdf_path"] = pdf_path
                    paper["fulltext_available"] = True
                    assigned_pdfs.add(pdf_path)
                    break
                # 2) DOI 末段出现在文件名（如 art.40049.pdf → doi .../art.40049）
                if doi_suffix and len(doi_suffix) >= 5 and doi_suffix in fname:
                    paper["pdf_path"] = pdf_path
                    paper["fulltext_available"] = True
                    assigned_pdfs.add(pdf_path)
                    break
                # 3) PDF 全文（前3000字）与 PubMed 标题词重叠
                pdf_text = pre_parsed.get(pdf_path, {}).get("full_text", "")
                pdf_words = set(w for w in pdf_text[:3000].lower().split() if len(w) > 3)
                overlap = len(pdf_words & title_words)
                if overlap >= 4:
                    paper["pdf_path"] = pdf_path
                    paper["fulltext_available"] = True
                    assigned_pdfs.add(pdf_path)
                    break
            if not paper.get("fulltext_available"):
                paper["fulltext_available"] = False

        n_pdf_matched = sum(1 for p in ta_included if p.get("fulltext_available"))
        n_unmatched = len(user_pdf_paths) - len(assigned_pdfs)
        n_no_pdf = len(ta_included) - n_pdf_matched
        pl.info(f"用户 PDF 匹配: {n_pdf_matched}/{len(ta_included)} 篇匹配到PDF, {n_no_pdf} 篇未匹配全文将跳过"
                + (f", {n_unmatched} 个PDF未匹配" if n_unmatched > 0 else ""))

        # Inject unmatched user PDFs as extra papers for full-text screening
        if n_unmatched > 0:
            assigned_set = set(assigned_pdfs)
            extra_idx = 0
            for pdf_path in user_pdf_paths:
                if pdf_path in assigned_set:
                    continue
                parsed = pre_parsed.get(pdf_path, {})
                # Try to extract real title from PDF first, fall back to filename
                title = ""
                try:
                    from new_meta.agents.pdf_parser import extract_pdf_title
                    title = extract_pdf_title(pdf_path)
                except Exception:
                    pass
                if not title or len(title) < 10:
                    title = Path(pdf_path).stem
                abstract = parsed.get("abstract", "") or parsed.get("full_text", "")[:500]
                extra_key = f"user_pdf_{extra_idx}"
                extra_idx += 1
                ta_included.append({
                    "pmid": extra_key,
                    "title": title,
                    "abstract": abstract,
                    "authors": [],
                    "year": 0,
                    "journal": "",
                    "doi": "",
                    "pub_types": [],
                    "pdf_path": pdf_path,
                    "fulltext_available": True,
                    "priority_tier": "uncertain",
                })
                pl.info(f"注入未匹配用户 PDF: {Path(pdf_path).name} as {extra_key}")
        # Track user-uploaded PDF count in PRISMA
        if n_unmatched > 0:
            project.prisma.records_from_user_upload = n_unmatched
            # Ensure records_identified reflects all sources
            project.prisma.records_identified = (
                project.prisma.records_from_database + n_unmatched
            )
            if project.prisma.records_after_dedup < project.prisma.records_identified:
                project.prisma.records_after_dedup = project.prisma.records_identified
    else:
        for paper in ta_included:
            paper["fulltext_available"] = False

    # User uploads are optional. Retrieve open PDFs/Europe PMC full text for
    # every remaining T/A candidate before asking the user for anything.
    automatic_candidates = [
        paper
        for paper in ta_included
        if not paper.get("pdf_path") and not paper.get("fulltext_path")
    ]
    auto_with_text: list[dict] = []
    auto_without_text: list[dict] = []
    if automatic_candidates and retriever_cls is not None:
        pl.info(
            "自动全文获取: 正在为 %s 篇候选检索开放PDF/Europe PMC全文",
            len(automatic_candidates),
        )
        auto_with_text, auto_without_text = retriever_cls().download_pdfs(
            automatic_candidates,
            project,
        )
        retrieved_by_id = {
            paper_identity(item): item
            for item in [*auto_with_text, *auto_without_text]
        }
        ta_included[:] = [
            retrieved_by_id.get(paper_identity(item), item)
            for item in ta_included
        ]
        _push("fulltext_retrieval", {
            "type": "fulltext_retrieval",
            "project_dir": str(project.base_dir),
            "attempted": len(automatic_candidates),
            "retrieved": sum(
                1
                for item in auto_with_text
                if item.get("text_availability") == "full_text"
                or item.get("pdf_path")
            ),
            "abstract_only": sum(
                1 for item in auto_with_text
                if item.get("text_availability") == "abstract_only"
            ),
            "missing": len(auto_without_text),
        })

    # Full-text screening accepts user PDFs, automatically retrieved PDFs, and
    # verified full-text HTML/XML. Structured abstracts stay outside extraction.
    all_ta_papers = [
        paper
        for paper in ta_included
        if (paper.get("pdf_path") or paper.get("fulltext_path"))
        and paper.get("text_availability") != "abstract_only"
        and not paper.get("metadata_only")
    ]
    skipped_no_pdf = [p for p in ta_included if p not in all_ta_papers]
    if skipped_no_pdf:
        pl.info(
            f"跳过 {len(skipped_no_pdf)} 篇无可用全文的候选文献，"
            f"分析 {len(all_ta_papers)} 篇用户上传或自动获取的全文"
        )

    project.save_json("pdf_download_results.json", ta_included)

    _require_full_text_sources(
        project=project,
        papers_with_full_text=all_ta_papers,
        extra_user_papers=[],
        screened_papers=ta_included,
    )
    project.save_checkpoint("pdf_download")

    # 复用预解析结果
    parsed_papers = {}
    fulltext_parse_cache_hits = 0
    for paper in all_ta_papers:
        pmid = paper.get("pmid", "")
        pdf_path = paper.get("pdf_path")
        fulltext_path = paper.get("fulltext_path")
        if pdf_path:
            if pdf_path in pre_parsed:
                parsed_papers[pmid] = pre_parsed[pdf_path]
            else:
                try:
                    parsed, _cache_hit = parse_file_with_cache(
                        pdf_path,
                        project.base_dir,
                        parse_func=parse_pdf,
                        parser_used="pdf_parser",
                        parser_version=f"{PDF_PARSE_CACHE_VERSION}_pdf",
                    )
                    if _cache_hit:
                        fulltext_parse_cache_hits += 1
                    parsed_papers[pmid] = parsed
                except Exception as e:
                    pl.warning(f"PDF解析失败 {pdf_path}: {e}")
        elif fulltext_path:
            try:
                text = Path(fulltext_path).read_text(encoding="utf-8", errors="replace")
                if text.strip():
                    parsed_papers[pmid] = {
                        "full_text": text,
                        "abstract": paper.get("abstract", ""),
                        "sections": {},
                        "tables": [],
                        "page_map": [],
                        "source_path": str(fulltext_path),
                        "source_type": paper.get("fulltext_source") or "retrieved_fulltext",
                    }
            except Exception as e:
                pl.warning(f"自动全文读取失败 {fulltext_path}: {e}")
    project.save_checkpoint("pdf_parsing")

    screener = ScreeningAgent()
    included_papers, _ = screener.screen_full_text(all_ta_papers, protocol, parsed_papers, project)
    project.save_checkpoint("ft_screening")

    # 统计各阶段数量，供 summary 展示
    ctx["n_ta_included"] = n_original_ta
    ctx["n_user_pdfs"] = len(user_pdf_paths) if user_pdf_paths else 0
    ctx["n_pdf_matched"] = n_pdf_matched
    ctx["n_pdf_unmatched"] = sum(1 for p in all_ta_papers if str(p.get("pmid", "")).startswith("user_pdf_"))
    ctx["n_ft_included"] = len(included_papers)
    ctx["n_ft_excluded"] = len(all_ta_papers) - len(included_papers)
    ctx["n_ta_no_pdf"] = max(0, n_original_ta - n_pdf_matched)
    ctx["n_fulltext_used"] = len(all_ta_papers)
    ctx["n_fulltext_parse_cache_hits"] = fulltext_parse_cache_hits

    if len(included_papers) < 1:
        raise ValueError("全文筛选后无纳入文献，无法生成报告")

    extractor = DataExtractionAgent()
    extracted_studies = extractor.run(included_papers, parsed_papers, protocol, project)
    project.save_checkpoint("extraction")
    ctx["n_extracted"] = len(extracted_studies)
    ctx["n_ft_excluded"] = len(all_ta_papers) - len(included_papers)
    extraction_review = _load_extraction_review_payload(project, ctx)
    if extraction_review:
        _push("extraction_review", extraction_review)
    _push("done_step", (4, META_STEPS[4], ctx))

    # ── EvidenceGate: 证据有效性评估（在RoB和效应量计算之前） ──
    gate = EvidenceGate(protocol)
    gate_result = gate.evaluate(extracted_studies)
    pl.info(f"EvidenceGate: {gate_result.decision.value} — {gate_result.summary}")

    report_state = _build_report_state(gate_result, extracted_studies, project.prisma.to_dict(), protocol.date_range)

    if gate_result.decision == GateDecision.EVIDENCE_GAP:
        for reason in gate_result.reasons:
            pl.warning(f"证据差距: {reason}")
        _push("progress", (5, META_STEPS[5]))
        rob_agent = RoBAgent()
        rob_results = rob_agent.run(extracted_studies, parsed_papers, project,
                                     required_study_ids=report_state.direct_eligible_ids)
        project.save_checkpoint("rob")
        _push("done_step", (5, META_STEPS[5], ctx))
        _push("progress", (6, META_STEPS[6]))
        _push("done_step", (6, META_STEPS[6], {**ctx, "_evidence_gap": True}))
        for skip_idx in [7, 8]:
            _push("progress", (skip_idx, META_STEPS[skip_idx]))
            _push("done_step", (skip_idx, META_STEPS[skip_idx], {**ctx, "_evidence_gap": True}))
        _push("progress", (9, META_STEPS[9]))
        manuscript = _evidence_gap_report(
            phase1_state.get("topic", ""), protocol, extracted_studies, gate_result,
            rob_results=rob_results,
            prisma_data=project.prisma.to_dict(), search_query=search_query,
            report_state=report_state,
            lang=output_lang,
        )
        manuscript = _save_evidence_gap_validation(
            project=project,
            protocol=protocol,
            manuscript=manuscript,
            extracted_studies=extracted_studies,
            rob_results=rob_results,
            prisma_data=project.prisma.to_dict(),
            search_query=search_query,
            report_state=report_state,
        )
        polished = _polish_web_manuscript(
            project,
            payload=phase1_state,
            lang=output_lang,
            progress_cb=_make_manuscript_polish_progress_cb(_push),
        )
        if polished is not None:
            manuscript = polished
        _push_manuscript_quality(project, ctx, _push)
        evidence_readiness = _load_evidence_readiness_payload(project, ctx)
        if evidence_readiness:
            _push("evidence_readiness", evidence_readiness)
        project.save_checkpoint("manuscript")
        _push("done_step", (9, META_STEPS[9], ctx))
        _finalize_web_release(project, manuscript=manuscript, push=_push)
        return manuscript

    from new_meta.core.synthesis_routing import SynthesisRoute, load_synthesis_route

    synthesis_route = load_synthesis_route(project)
    if synthesis_route.route is SynthesisRoute.METHOD_PLUGIN:
        from new_meta.core.method_delivery import run_method_delivery, MethodDeliveryBlocked
        from new_meta.schemas.phase_result import ExecutionStatus

        _push("progress", (5, META_STEPS[5]))
        rob_results = RoBAgent().run(
            extracted_studies,
            parsed_papers,
            project,
            required_study_ids=report_state.direct_eligible_ids,
        )
        project.save_checkpoint("rob")
        _push("done_step", (5, META_STEPS[5], ctx))

        _push("progress", (6, META_STEPS[6]))
        method_delivery = run_method_delivery(
            project=project,
            protocol=protocol,
            extracted_studies=extracted_studies,
            rob_results=rob_results,
            prisma_data=project.prisma.to_dict(),
            search_query=search_query,
            lang=output_lang,
            auto_resolve_uncertainty=bool(phase1_state.get("skip_confirm")),
        )
        if method_delivery.phase.status is not ExecutionStatus.SUCCEEDED:
            project.save_json(
                "method_delivery_status.json",
                method_delivery.phase,
                subdir="analysis",
            )
            if (
                method_delivery.phase.error_code == "analysis_set_adjudication_required"
                and method_delivery.phase.data
            ):
                _push("method_decision_required", {
                    "project_dir": str(project.base_dir),
                    "decisions": [method_delivery.phase.data],
                    "execution": method_delivery.phase.model_dump(mode="json"),
                })
                return ""  # wait for the selected method option
            raise MethodDeliveryBlocked(method_delivery.phase)
        if method_delivery.decisions:
            _push("method_decision_required", {
                "project_dir": str(project.base_dir),
                "decisions": method_delivery.decisions,
                "execution": method_delivery.phase.model_dump(mode="json"),
            })
            return ""  # wait for the selected method option
        manuscript = method_delivery.manuscript
        ctx["n_effects"] = method_delivery.phase.metrics.get("input_results", 0)
        _push("done_step", (6, META_STEPS[6], ctx))

        _push("progress", (7, META_STEPS[7]))
        _push("done_step", (7, META_STEPS[7], {**ctx, "_method_specific_certainty": True}))
        _push("progress", (8, META_STEPS[8]))
        figures_b64 = {}
        try:
            prisma_figure = visualization.prisma_flow_diagram(
                project.prisma.to_dict(),
                lang=output_lang,
            )
            if prisma_figure:
                figures_b64["prisma_diagram"] = prisma_figure
            project.save_checkpoint("figures")
        except Exception as exc:
            project.add_warning(
                "figures",
                f"PRISMA diagram generation failed: {exc}",
                code="prisma_figure_failed",
            )
        ctx["n_figures"] = len(figures_b64)
        _push("done_step", (8, META_STEPS[8], ctx))

        _push("progress", (9, META_STEPS[9]))
        ref_manager = ReferenceManager()
        _prepare_web_manuscript_references(
            project,
            protocol,
            ref_manager,
            papers=included_papers,
            extracted_studies=extracted_studies,
            search_query=search_query,
            include_rob=bool(rob_results),
            include_grade=False,
            include_publication_bias=False,
        )
        project.save_text("references.bib", ref_manager.to_bibtex())
        _push_manuscript_quality(project, ctx, _push)
        project.save_checkpoint("manuscript")
        _push("done_step", (9, META_STEPS[9], ctx))
        _finalize_web_release(project, manuscript=manuscript, push=_push)
        return manuscript

    # ── RoB → 严格效应量选择（NARRATIVE和META都需要RoB） ──
    _push("progress", (5, META_STEPS[5]))
    from new_meta.core.pipeline_runner import PipelineRunner

    rob_results, study_effects, _selection_audit = (
        PipelineRunner(project, logger=pl).assess_risk_and_select_primary_effects(
            protocol=protocol,
            extracted_studies=extracted_studies,
            parsed_papers=parsed_papers,
            included_papers=included_papers,
            required_study_ids=report_state.direct_eligible_ids,
            rob_agent=RoBAgent(),
        )
    )
    _push("done_step", (5, META_STEPS[5], ctx))
    _push("progress", (6, META_STEPS[6]))

    if gate_result.decision == GateDecision.NARRATIVE:
        ctx["n_effects"] = len(study_effects)
        _push("done_step", (6, "分析路径判断", {**ctx, "_narrative": True}))
        _push("progress", (7, META_STEPS[7]))
        _push("done_step", (7, META_STEPS[7], {**ctx, "_narrative": True}))
        _push("progress", (8, META_STEPS[8]))
        ctx["n_figures"] = 1
        _push("done_step", (8, META_STEPS[8], {**ctx, "_narrative": True}))
        _push("progress", (9, META_STEPS[9]))
        manuscript = _narrative_review(
            phase1_state.get("topic", ""), protocol, extracted_studies, rob_results,
            prisma_data=project.prisma.to_dict(), search_query=search_query,
            project=project, ref_manager=None, study_effects=study_effects,
            lang=output_lang,
            report_state=report_state, gate_result=gate_result,
        )
        _push_manuscript_quality(project, ctx, _push)
        evidence_readiness = _load_evidence_readiness_payload(project, ctx)
        if evidence_readiness:
            _push("evidence_readiness", evidence_readiness)
        project.save_checkpoint("manuscript")
        _push("done_step", (9, META_STEPS[9], ctx))
        _finalize_web_release(project, manuscript=manuscript, push=_push)
        return manuscript

    # ── META路径：效应量 + Meta分析 ──
    project.save_json("effect_sizes.json", [s.model_dump() for s in study_effects], subdir="analysis")
    project.save_checkpoint("effect_sizes")

    meta_results = _run_meta_analysis_from_effects(
        project,
        protocol=protocol,
        extracted_studies=extracted_studies,
        study_effects=study_effects,
    )
    primary_result = meta_results.primary_outcome
    ctx["n_effects"] = len(study_effects)
    ctx["i_squared"] = primary_result.i_squared
    _push("done_step", (6, META_STEPS[6], ctx))

    _push("progress", (7, META_STEPS[7]))
    _step_executor2 = ThreadPoolExecutor(max_workers=2, thread_name_prefix="meta-step2")

    def _run_grade():
        return _run_grade_from_cached_meta(
            project,
            None,
            protocol=protocol,
            meta_results=meta_results,
            rob_results=rob_results,
            extracted_studies=extracted_studies,
            force=True,
        )

    def _generate_figures():
        fb64: dict[str, str] = {}
        for fn, key in [
            (visualization.forest_plot, "forest_plot"),
            (visualization.funnel_plot, "funnel_plot"),
            (visualization.prisma_flow_diagram, "prisma_diagram"),
        ]:
            try:
                b64 = fn(primary_result if key != "prisma_diagram" else project.prisma.to_dict(), lang=output_lang)
                if b64:
                    fb64[key] = b64
                else:
                    pl.warning(f"图表 {key} 返回空（数据不足或参数问题）")
            except Exception as e:
                import traceback
                pl.warning(f"图表 {key} 生成失败: {e}\n{traceback.format_exc()}")
        pl.info(f"图表生成结果: {list(fb64.keys())} ({len(fb64)} 张)")
        project.save_checkpoint("figures")
        return fb64

    grade_future = _step_executor2.submit(_run_grade)
    figures_future = _step_executor2.submit(_generate_figures)
    grade_profile = grade_future.result()
    figures_b64 = figures_future.result()
    _step_executor2.shutdown(wait=False)
    # 两个任务都完成后，顺序推送完成信号
    _push("done_step", (7, META_STEPS[7], ctx))
    _push("progress", (8, META_STEPS[8]))
    ctx["n_figures"] = len(figures_b64)
    _push("done_step", (8, META_STEPS[8], ctx))

    _push("progress", (9, META_STEPS[9]))
    ref_manager = ReferenceManager()
    _prepare_web_manuscript_references(
        project,
        protocol,
        ref_manager,
        papers=included_papers,
        extracted_studies=extracted_studies,
        search_query=search_query,
        include_rob=bool(rob_results),
        include_grade=grade_profile is not None,
        include_publication_bias=meta_results is not None,
    )

    writer = WritingAgent(lang=output_lang, topic=phase1_state.get("topic", ""))
    from datetime import date
    _search_date = date.today().strftime("%Y年%m月%d日")
    manuscript = writer.run(
        protocol=protocol, meta_results=meta_results,
        extracted_studies=extracted_studies, rob_results=rob_results,
        prisma_data=project.prisma.to_dict(), search_query=search_query,
        search_date=_search_date, project=project, ref_manager=ref_manager,
        grade_profile=grade_profile, figures_b64=figures_b64,
        evidence_classes=gate_result.evidence_classes,
        report_state=report_state,
    )
    project.save_checkpoint("manuscript")
    project.save_text("draft.md", manuscript, subdir="manuscript")
    polished = _polish_web_manuscript(
        project,
        payload=phase1_state,
        lang=output_lang,
        progress_cb=_make_manuscript_polish_progress_cb(_push),
    )
    if polished is not None:
        manuscript = polished
    _push_manuscript_quality(project, ctx, _push)
    evidence_readiness = _load_evidence_readiness_payload(project, ctx)
    if evidence_readiness:
        _push("evidence_readiness", evidence_readiness)
    _push("done_step", (9, META_STEPS[9], ctx))
    _finalize_web_release(project, manuscript=manuscript, push=_push)
    return manuscript


def _run_pipeline_sync(
    topic: str,
    output_dir: str,
    push=None,
    user_pdf_paths: list = None,
    *,
    skip_confirm: bool = False,
) -> str:
    """在 ThreadPoolExecutor 中同步运行 Meta 分析管线，返回最终报告 Markdown。

    push: optional callable(kind, payload) bridging to async progress queue.
          kind: "progress" | "done_step" | "done" | "error"
    user_pdf_paths: 用户上传的 PDF 本地路径列表。
    """
    def _push(kind, payload):
        if push:
            push(kind, payload)

    try:
        return _run_pipeline_inner(
            topic,
            output_dir,
            _push,
            user_pdf_paths=user_pdf_paths,
            skip_confirm=skip_confirm,
        )
    except Exception as e:
        _push("error", str(e))
        raise


def _run_pipeline_inner(
    topic: str,
    output_dir: str,
    _push,
    user_pdf_paths: list = None,
    *,
    skip_confirm: bool = False,
) -> str:
    """Run the Web one-shot pipeline through the same phase runners as the interactive flow."""
    phase1_state = _run_phase1_inner(topic, output_dir, _push)
    phase1_state["topic"] = topic
    phase1_state["skip_confirm"] = bool(skip_confirm)
    return _run_phase2_inner(phase1_state, output_dir, _push, user_pdf_paths or [])


def _build_report_state(
    gate_result: GateResult,
    extracted_studies: list,
    prisma_data: dict,
    date_range: str = "",
) -> ReportState:
    """Build a read-only ReportState from GateResult + PRISMA + extracted studies."""
    return build_report_state(gate_result, extracted_studies, prisma_data, date_range)


def _evidence_gap_report(
    topic: str,
    protocol,
    extracted_studies: list,
    gate_result: GateResult,
    rob_results: list = None,
    prisma_data: dict = None,
    search_query: str = "",
    report_state: ReportState = None,
    lang: str | None = None,
) -> str:
    """Generate a deterministic markdown report for evidence gap scenarios.

    No LLM call — pure template based on GateResult + ReportState.
    """
    lang = lang if str(lang or "").strip().lower() in {"zh", "en"} else _detect_lang(topic)
    primary = protocol.pico.outcome_primary
    evidence_tiers = gate_result.evidence_tiers or {}
    evidence_classes = gate_result.evidence_classes or {}

    # PRISMA numbers
    if report_state is not None:
        n_full_text_assessed = report_state.prisma_full_text_assessed
        n_direct_eligible = report_state.n_direct_eligible
        n_analyzable = report_state.n_analyzable_primary
        n_meta_eligible = report_state.n_meta_eligible
        n_from_db = report_state.prism_source_database if hasattr(report_state, 'prism_source_database') else getattr(report_state, 'prisma_source_database', 0)
        n_from_upload = report_state.prism_source_user_upload if hasattr(report_state, 'prism_source_user_upload') else getattr(report_state, 'prisma_source_user_upload', 0)
        search_end_year = getattr(report_state, 'search_end_year', None)
    else:
        counts = gate_result.prisma_counts or {}
        n_full_text_assessed = counts.get("full_text_assessed", len(extracted_studies))
        n_direct_eligible = counts.get("direct_eligible", 0)
        n_analyzable = counts.get("analyzable_primary_outcome", 0)
        n_meta_eligible = counts.get("meta_eligible", 0)
        n_from_db = 0
        n_from_upload = 0
        search_end_year = None
    rob_results = rob_results or []

    # Build flag map: study_label -> list of flags
    flag_map: dict[str, list] = {}
    for flag in gate_result.flagged_studies:
        flag_map.setdefault(flag.study_label, []).append(flag)

    # Tier labels
    tier_labels_zh = {
        "direct_eligible_study": "直接证据（RCT + PICO匹配 + 数据可提取）",
        "analyzable_primary_outcome": "可分析主要结局（报告但非完整RCT）",
        "indirect_evidence": "间接证据（未报告主要结局）",
        "excluded": "排除（设计不符或数据异常）",
    }
    tier_labels_en = {
        "direct_eligible_study": "Direct eligible (RCT + PICO match + extractable)",
        "analyzable_primary_outcome": "Analyzable primary outcome",
        "indirect_evidence": "Indirect evidence (primary outcome not reported)",
        "excluded": "Excluded (design or data issues)",
    }

    # Source description
    if lang == "zh":
        if n_from_db == 0 and n_from_upload > 0:
            source_desc = f"数据库检索未获得可用记录；另有 {n_from_upload} 篇用户上传/补充全文进入评估。"
        elif n_from_db > 0 and n_from_upload > 0:
            source_desc = f"数据库检索识别 {n_from_db} 条记录，用户上传 {n_from_upload} 篇全文。"
        else:
            source_desc = f"数据库检索识别 {n_from_db} 条记录。"
    else:
        if n_from_db == 0 and n_from_upload > 0:
            source_desc = f"No records identified via database search; {n_from_upload} user-supplied full texts entered assessment."
        elif n_from_db > 0 and n_from_upload > 0:
            source_desc = f"{n_from_db} records identified via database search, {n_from_upload} user-supplied full texts."
        else:
            source_desc = f"{n_from_db} records identified via database search."

    if lang == "zh":
        report = f"""# 系统评价报告：证据差距评估

## 研究问题
{topic}

## 主要结局指标
{primary}

## 检索与筛选概况

{source_desc}

| 指标 | 数值 |
|------|------|
| 全文评估 | {n_full_text_assessed} |
| 直接证据研究 | {n_direct_eligible} |
| 可分析主要结局 | {n_analyzable} |
| 满足Meta分析条件 | {n_meta_eligible} |

## 证据评估结论

{gate_result.summary}

### 详细原因
"""
        for i, reason in enumerate(gate_result.reasons, 1):
            report += f"{i}. {reason}\n"

        # Evidence tiers breakdown
        tier_counts = {}
        for tier_val in evidence_tiers.values():
            tier_counts[tier_val] = tier_counts.get(tier_val, 0) + 1
        if tier_counts:
            report += "\n## 证据分层概览\n\n"
            for tier_val, count in tier_counts.items():
                label = tier_labels_zh.get(tier_val, tier_val)
                report += f"- **{label}**: {count} 项\n"

        if gate_result.flagged_studies:
            report += "\n## 各研究评估详情\n\n"
            report += "| 研究 | 问题类型 | 说明 |\n"
            report += "|------|---------|------|\n"
            for flag in gate_result.flagged_studies:
                report += f"| {flag.study_label} | {flag.flag_type} | {flag.detail} |\n"

        # Related but not included studies (P9)
        if extracted_studies:
            report += "\n## 相关但未纳入研究概况\n\n"
            report += "*以下研究经过全文评估但未满足直接证据纳入标准，仅作概况记录。*\n\n"
            for study in extracted_studies:
                c = study.characteristics
                label = c.study_id or (c.title[:40] if c.title else "Unknown")
                first_author = (c.authors[0].split()[0] if c.authors else "Unknown")
                sid = c.pmid or c.study_id
                tier = evidence_tiers.get(sid, "未分类")
                tier_label = tier_labels_zh.get(tier, tier)
                ev_class = evidence_classes.get(sid, "")
                # Exclusion reason from flags
                flags = flag_map.get(label, [])
                reasons_text = "; ".join(f.detail for f in flags[:3]) if flags else ""
                # Available data summary
                outcomes = [o.outcome_name for o in study.outcomes[:3] if o.outcome_name]
                outcomes_text = ", ".join(outcomes) if outcomes else "无可用结局数据"
                n = c.total_sample_size or "NR"

                report += f"**{first_author} {c.year}** [{label}]\n"
                report += f"- 证据等级: {tier_label}\n"
                if ev_class:
                    report += f"- 研究设计分类: {ev_class}\n"
                if reasons_text:
                    report += f"- 未纳入原因: {reasons_text}\n"
                report += f"- 可用数据摘要: {outcomes_text}\n"
                report += f"- 样本量: {n}\n\n"

        # No RoB table when direct_eligible=0 (P5)
        # No "纳入研究" language (P3)

        report += f"""## 证据缺口分析

**证据确定性判断：** 未纳入直接研究，无法进行正式证据确定性评级。当前结论为直接证据缺失（evidence not available），而非低质量证据。

### 研究空白与建议

1. 现有证据不足以直接回答研究问题，建议扩大检索范围（增加数据库、扩展检索词）
2. 考虑调整纳入/排除标准（如纳入观察性研究、放宽干预定义）
3. 确保主要结局指标（{primary}）的数据以可提取格式报告（均值±SD、事件数/总数）
4. 未来研究需明确报告对照组数据、基线-终点变化值及其变异度

## 结论

本系统评价经严格检索与全文评估，**未纳入任何满足直接证据标准的随机对照试验**。当前无直接证据支持或反驳 "{primary}" 的相关研究问题。上述相关研究因设计不符、结局定义不一致或数据报告不完整等原因未达到纳入标准。本发现本身构成重要证据——提示该领域高质量直接比较证据存在明确缺口。

---

*本报告由 EvidenceGate 自动生成。*
"""
    else:
        report = f"""# Systematic Review Report: Evidence Gap Assessment

## Research Question
{topic}

## Primary Outcome
{primary}

## Search and Screening Overview

{source_desc}

| Metric | Value |
|--------|-------|
| Full-text assessed | {n_full_text_assessed} |
| Direct eligible studies | {n_direct_eligible} |
| Analyzable primary outcome | {n_analyzable} |
| Meta-analysis eligible | {n_meta_eligible} |

## Evidence Assessment Conclusion

{gate_result.summary}

### Detailed Reasons
"""
        for i, reason in enumerate(gate_result.reasons, 1):
            report += f"{i}. {reason}\n"

        tier_counts = {}
        for tier_val in evidence_tiers.values():
            tier_counts[tier_val] = tier_counts.get(tier_val, 0) + 1
        if tier_counts:
            report += "\n## Evidence Tier Summary\n\n"
            for tier_val, count in tier_counts.items():
                label = tier_labels_en.get(tier_val, tier_val)
                report += f"- **{label}**: {count}\n"

        if gate_result.flagged_studies:
            report += "\n## Study Assessment Details\n\n"
            report += "| Study | Issue Type | Detail |\n"
            report += "|-------|-----------|--------|\n"
            for flag in gate_result.flagged_studies:
                report += f"| {flag.study_label} | {flag.flag_type} | {flag.detail} |\n"

        # Related but not included studies (P9)
        if extracted_studies:
            report += "\n## Related but Not Included Studies\n\n"
            report += "*The following studies were assessed at full-text but did not meet direct evidence inclusion criteria.*\n\n"
            for study in extracted_studies:
                c = study.characteristics
                label = c.study_id or (c.title[:40] if c.title else "Unknown")
                first_author = (c.authors[0].split()[0] if c.authors else "Unknown")
                sid = c.pmid or c.study_id
                tier = evidence_tiers.get(sid, "Unclassified")
                tier_label = tier_labels_en.get(tier, tier)
                ev_class = evidence_classes.get(sid, "")
                flags = flag_map.get(label, [])
                reasons_text = "; ".join(f.detail for f in flags[:3]) if flags else ""
                outcomes = [o.outcome_name for o in study.outcomes[:3] if o.outcome_name]
                outcomes_text = ", ".join(outcomes) if outcomes else "No extractable outcome data"
                n = c.total_sample_size or "NR"

                report += f"**{first_author} {c.year}** [{label}]\n"
                report += f"- Evidence tier: {tier_label}\n"
                if ev_class:
                    report += f"- Design classification: {ev_class}\n"
                if reasons_text:
                    report += f"- Exclusion reason: {reasons_text}\n"
                report += f"- Available data: {outcomes_text}\n"
                report += f"- Sample size: {n}\n\n"

        report += f"""## Evidence Gap Analysis

**Certainty assessment:** No direct eligible studies were included; formal certainty grading is not applicable. The finding is absence of direct evidence (evidence not available), not low-quality evidence.

### Research Gaps and Recommendations

1. Current evidence is insufficient to directly answer the research question; consider broadening the search (additional databases, expanded search terms)
2. Consider adjusting inclusion/exclusion criteria (e.g., include observational studies, relax intervention definitions)
3. Ensure primary outcome ({primary}) data are reported in extractable format (mean±SD, events/total)
4. Future studies should report control group data, baseline-to-endpoint change values with variability measures

## Conclusion

This systematic review, following rigorous search and full-text assessment, **included zero studies meeting direct evidence criteria**. There is currently no direct evidence to support or refute the research question regarding "{primary}". The related studies identified did not meet inclusion criteria due to design mismatch, inconsistent outcome definitions, or incomplete data reporting. This finding itself constitutes important evidence — highlighting a clear gap in high-quality direct comparative evidence in this area.

---

*This report was auto-generated by EvidenceGate.*
"""
    return report


def _narrative_review(
    topic: str,
    protocol,
    extracted_studies: list,
    rob_results: list,
    prisma_data: dict,
    search_query: str,
    project,
    ref_manager=None,
    study_effects: list = None,
    lang: str = None,
    report_state: ReportState = None,
    gate_result: GateResult = None,
) -> str:
    """Generate a narrative systematic review when meta-analysis is not possible (< 2 effect sizes)."""
    from new_meta.agents.writing_agent import WritingAgent
    from new_meta.tools.reference_manager import ReferenceManager

    pl = logging.getLogger("metaagent.pipeline")
    _lang = lang or _detect_lang(topic)

    n_studies = len(extracted_studies)

    # Reference manager
    if ref_manager is None:
        ref_manager = ReferenceManager()
        for paper in extracted_studies:
            pmid = paper.characteristics.pmid or paper.characteristics.study_id
            ref_manager.add({
                "pmid": pmid,
                "title": paper.characteristics.title,
                "authors": paper.characteristics.authors,
                "year": paper.characteristics.year,
                "journal": paper.characteristics.journal,
                "doi": paper.characteristics.doi,
            }, study_id=pmid)

    _prepare_web_manuscript_references(
        project,
        protocol,
        ref_manager,
        papers=[],
        extracted_studies=extracted_studies,
        search_query=search_query,
        include_rob=bool(rob_results),
        include_grade=False,
        include_publication_bias=False,
    )

    # Generate only PRISMA diagram for narrative mode (no forest/funnel plots)
    figures_b64: dict[str, str] = {}
    try:
        from new_meta.engines import visualization
        b64 = visualization.prisma_flow_diagram(prisma_data, lang=_lang)
        if b64:
            figures_b64["prisma_diagram"] = b64
    except Exception as e:
        pl.warning(f"PRISMA流程图生成失败: {e}")

    writer = WritingAgent(lang=_lang, narrative_mode=True, topic=topic)
    from datetime import date
    _search_date = date.today().strftime("%Y年%m月%d日")

    manuscript = writer.run(
        protocol=protocol,
        meta_results=None,
        extracted_studies=extracted_studies,
        rob_results=rob_results,
        prisma_data=prisma_data,
        search_query=search_query,
        search_date=_search_date,
        project=project,
        ref_manager=ref_manager,
        grade_profile=None,
        figures_b64=figures_b64,
        evidence_classes=gate_result.evidence_classes if gate_result else None,
        report_state=report_state,
    )

    project.save_checkpoint("manuscript")
    polished = _polish_web_manuscript(project, payload={}, lang=_lang)
    if polished is not None:
        manuscript = polished
    pl.info("叙述性系统评价报告生成完成")

    return manuscript


from new_meta.core.evidence_gate import (
    EvidenceGate, GateDecision, GateResult, ReportState, build_report_state,
    outcome_matches as _outcome_matches_meta,
    is_outcome_meta_extractable as _is_outcome_meta_extractable,
)


def _compute_study_effect_meta(study, outcome, protocol, log):
    from new_meta.engines import effect_size as es_engine
    from new_meta.schemas.meta_result import StudyEffect
    from new_meta.tools.utils import first_author_lastname as _first_author
    try:
        yi, vi = es_engine.compute_effect_size(
            outcome_type=outcome.outcome_type,
            effect_measure=protocol.effect_measure,
            mean_i=outcome.mean_intervention, sd_i=outcome.sd_intervention, n_i=outcome.n_intervention,
            mean_c=outcome.mean_control, sd_c=outcome.sd_control, n_c=outcome.n_control,
            median_i=outcome.median_intervention, q1_i=outcome.q1_intervention, q3_i=outcome.q3_intervention,
            min_i=outcome.min_intervention, max_i=outcome.max_intervention,
            median_c=outcome.median_control, q1_c=outcome.q1_control, q3_c=outcome.q3_control,
            min_c=outcome.min_control, max_c=outcome.max_control,
            events_i=outcome.events_intervention, total_i=outcome.total_intervention,
            events_c=outcome.events_control, total_c=outcome.total_control,
            effect=outcome.effect_size, ci_lower=outcome.ci_lower, ci_upper=outcome.ci_upper,
            p_value=outcome.p_value,
            hr=outcome.hazard_ratio, hr_ci_lower=outcome.hr_ci_lower,
            hr_ci_upper=outcome.hr_ci_upper, hr_se=outcome.hr_se,
            events_single=outcome.events, total_n=outcome.total_n,
            correlation_r=outcome.correlation_r, correlation_n=outcome.correlation_n,
            pyears_i=outcome.pyears_intervention, pyears_c=outcome.pyears_control,
        )
        c = study.characteristics
        label = f"{_first_author(c.authors)} {c.year}"
        return StudyEffect(
            study_id=c.pmid or c.study_id, study_label=label,
            yi=yi, vi=vi, se=vi ** 0.5,
        )
    except Exception as e:
        log.warning(f"效应量计算失败 {study.characteristics.study_id}: {e}")
        return None


# ─────────────── 会话处理 ───────────────

async def _handle_session(
    parent_id: str,
    msg_queue: asyncio.Queue,
    python_client_id: str,
    ws_send,
    first_sender_id: str,
    user_id: str,
):
    current_target = first_sender_id
    _TW_CHUNK = 8
    _TW_DELAY = 0.03
    session_ctx: dict = {"last_topic": "", "last_report": "", "chat_history": []}

    def _wrap(payload: dict) -> str:
        content = payload.get("content", {})
        if isinstance(content, dict):
            content = json.dumps(content, ensure_ascii=False)
        return json.dumps({
            "type": "text",
            "userId": user_id,
            "parentId": payload.get("parentId", parent_id),
            "id": payload.get("id", str(uuid.uuid4())),
            "senderType": AGENT_TYPE,
            "senderId": python_client_id,
            "targetClientId": current_target,
            "timestamp": _make_ts(),
            "agentType": payload.get("agentType", AGENT_TYPE),
            "content": content,
        }, ensure_ascii=False)

    async def send_msg(payload: dict):
        try:
            await ws_send(_wrap(payload))
        except Exception as se:
            logger.warning(f"发送消息失败: {se}")

    async def push_typewriter(text: str, msg_id: str, finished: bool = True):
        buf = ""
        chunks = [text[i:i + _TW_CHUNK] for i in range(0, len(text), _TW_CHUNK)]
        for i, ch in enumerate(chunks):
            buf += ch
            is_last = (i == len(chunks) - 1)
            data: dict = {"type": "text", "delta": buf, "inprogress": not is_last}
            if is_last and finished:
                data["isFinished"] = True
            await send_msg({
                "id": msg_id, "parentId": parent_id, "agentType": AGENT_TYPE,
                "content": {"clazz": "agent", "type": "stream", "data": data},
            })
            await asyncio.sleep(_TW_DELAY)

    _done_steps: set = set()
    _doing_step: int = -1

    async def push_status():
        """Send Phase 2 step status list to frontend.
        Only sends Phase 2 steps (index 4+) to align with sessionPlan which was
        populated from the Phase 2 orchestra message (META_STEPS[4:]).
        """
        status_list = []
        for i in range(4, len(META_STEPS)):  # Phase 2 steps only
            if i in _done_steps:
                status_list.append({"status": "done", "title": META_STEPS[i]})
            elif i == _doing_step:
                status_list.append({"status": "doing", "title": META_STEPS[i]})
            else:
                status_list.append({"status": "todo", "title": META_STEPS[i]})
        await send_msg({
            "id": message_id, "parentId": parent_id, "agentType": AGENT_TYPE,
            "content": {
                "clazz": "agent",
                "data": {"item": status_list, "type": "task_status"},
                "type": "status",
            },
        })

    async def send_service_busy(data: dict[str, Any]):
        await send_msg({
            "id": message_id,
            "parentId": parent_id,
            "agentType": AGENT_TYPE,
            "content": {"clazz": "agent", "type": "service_busy", "data": data},
        })

    async def acquire_pipeline_slot(stage: str) -> PipelineSlotTicket | None:
        if not _pipeline_limiter:
            return None
        ticket = await _pipeline_limiter.acquire(stage, status_cb=send_service_busy)
        if ticket:
            logger.info(
                "会话 %s 获得运行名额: stage=%s, running=%s, waiting=%s",
                parent_id, stage, _pipeline_limiter.running, _pipeline_limiter.waiting,
            )
        return ticket

    async def release_pipeline_slot(ticket: PipelineSlotTicket | None):
        if not _pipeline_limiter or ticket is None:
            return
        stage = ticket.stage
        await _pipeline_limiter.release(ticket)
        logger.info(
            "会话 %s 释放运行名额: stage=%s, running=%s, waiting=%s",
            parent_id, stage, _pipeline_limiter.running, _pipeline_limiter.waiting,
        )

    try:
        while True:
            user_msg = await msg_queue.get()
            if user_msg is None:
                break

            content_raw = user_msg.get("content", "")
            file_ids = []
            content_obj = {}
            try:
                content_obj = json.loads(content_raw) if isinstance(content_raw, str) else content_raw
                input_text = content_obj.get("content", content_obj.get("text", "")) or ""
                file_ids = content_obj.get("fileIds", []) or []
            except Exception:
                input_text = ""

            current_target = user_msg.get("senderId", first_sender_id)
            request_type = str(content_obj.get("type") or content_obj.get("action") or "").strip()

            if request_type in {"fulltext_upload", "user_fulltext_upload", "attach_fulltext"}:
                message_id = str(uuid.uuid4())
                try:
                    upload_file_ids = content_obj.get("fileIds", []) or file_ids
                    pdf_paths: list[str] = []
                    if upload_file_ids:
                        pdf_save_dir = META_ROOT / "output" / "user_pdfs" / parent_id / "fulltext_uploads"
                        pdf_paths = await _download_pdfs_from_mongo(upload_file_ids, pdf_save_dir)
                    else:
                        for raw_path in content_obj.get("pdf_paths") or content_obj.get("local_paths") or []:
                            candidate = Path(str(raw_path)).resolve()
                            output_root = (META_ROOT / "output").resolve()
                            if output_root == candidate or output_root in candidate.parents:
                                pdf_paths.append(str(candidate))
                    upload_loop = asyncio.get_running_loop()
                    result = await asyncio.to_thread(
                        _attach_fulltext_upload_payload,
                        content_obj,
                        pdf_paths,
                        parent_id=parent_id,
                        user_id=user_id,
                        progress_cb=_make_pdf_intake_progress_cb(
                            lambda kind, payload: asyncio.run_coroutine_threadsafe(
                                send_msg({
                                    "id": message_id,
                                    "parentId": parent_id,
                                    "agentType": AGENT_TYPE,
                                    "content": {
                                        "clazz": "agent",
                                        "type": kind,
                                        "data": payload,
                                    },
                                }),
                                upload_loop,
                            ),
                            total=len(pdf_paths),
                            stage="fulltext_upload_intake",
                            session_id=parent_id,
                            project_dir=str(
                                _resolve_project_dir(content_obj.get("project_dir"), parent_id=parent_id)
                            ),
                        ),
                    )
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "fulltext_upload_processed",
                            "data": result,
                        },
                    })
                except Exception as e:
                    logger.exception(f"补充全文上传处理失败: {e}")
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "fulltext_upload_processed",
                            "data": {"ok": False, "error": "fulltext_upload_failed", "message": str(e)},
                        },
                    })
                continue

            if request_type in {"benchmark_source_upload", "attach_benchmark_source", "benchmark_source"}:
                message_id = str(uuid.uuid4())
                try:
                    upload_file_ids = content_obj.get("fileIds", []) or file_ids
                    source_paths: list[str] = []
                    if upload_file_ids:
                        source_save_dir = META_ROOT / "output" / "user_pdfs" / parent_id / "benchmark_sources"
                        source_paths = await _download_pdfs_from_mongo(upload_file_ids, source_save_dir)
                    else:
                        output_root = (META_ROOT / "output").resolve()
                        for raw_path in content_obj.get("source_paths") or content_obj.get("pdf_paths") or content_obj.get("local_paths") or []:
                            candidate = Path(str(raw_path)).resolve()
                            if output_root == candidate or output_root in candidate.parents:
                                source_paths.append(str(candidate))
                    result = await asyncio.to_thread(
                        _attach_benchmark_source_payload,
                        content_obj,
                        source_paths,
                        parent_id=parent_id,
                        user_id=user_id,
                    )
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "benchmark_source_upload_processed",
                            "data": result,
                        },
                    })
                    if result.get("benchmark"):
                        await send_msg({
                            "id": message_id,
                            "parentId": parent_id,
                            "agentType": AGENT_TYPE,
                            "content": {
                                "clazz": "agent",
                                "type": "benchmark_review",
                                "data": result["benchmark"],
                            },
                        })
                    if result.get("evidence_readiness"):
                        await send_msg({
                            "id": message_id,
                            "parentId": parent_id,
                            "agentType": AGENT_TYPE,
                            "content": {
                                "clazz": "agent",
                                "type": "evidence_readiness",
                                "data": result["evidence_readiness"],
                            },
                        })
                except Exception as e:
                    logger.exception(f"benchmark source 上传处理失败: {e}")
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "benchmark_source_upload_processed",
                            "data": {"ok": False, "error": "benchmark_source_upload_failed", "message": str(e)},
                        },
                    })
                continue

            if request_type in {"resume_project", "resume_after_fulltext", "rerun_after_fulltext"}:
                message_id = str(uuid.uuid4())
                sem_acquired = False
                sem_ticket: PipelineSlotTicket | None = None
                try:
                    sem_ticket = await acquire_pipeline_slot("resume_project")
                    sem_acquired = sem_ticket is not None
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "resume_project_started",
                            "data": {
                                "project_dir": content_obj.get("project_dir") or "",
                                "message": "已收到继续运行请求，正在从 checkpoint 恢复。",
                            },
                        },
                    })
                    result = await asyncio.to_thread(
                        _resume_project_payload,
                        content_obj,
                        parent_id=parent_id,
                        user_id=user_id,
                    )
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "resume_project_done",
                            "data": result,
                        },
                    })
                    if result.get("ok") and result.get("evidence_readiness"):
                        await send_msg({
                            "id": message_id,
                            "parentId": parent_id,
                            "agentType": AGENT_TYPE,
                            "content": {
                                "clazz": "agent",
                                "type": "evidence_readiness",
                                "data": result["evidence_readiness"],
                            },
                        })
                except Exception as e:
                    logger.exception(f"恢复项目运行失败: {e}")
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "resume_project_done",
                            "data": {"ok": False, "error": "resume_failed", "message": str(e)},
                        },
                    })
                finally:
                    if sem_acquired:
                        await release_pipeline_slot(sem_ticket)
                continue

            if request_type in {"extraction_override", "extraction_overrides", "save_extraction_override"}:
                message_id = str(uuid.uuid4())
                try:
                    result = _save_extraction_override_payload(content_obj, parent_id=parent_id, user_id=user_id)
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "extraction_override_saved",
                            "data": result,
                        },
                    })
                    if result.get("ok") and result.get("extraction_review"):
                        await send_msg({
                            "id": message_id,
                            "parentId": parent_id,
                            "agentType": AGENT_TYPE,
                            "content": {
                                "clazz": "agent",
                                "type": "extraction_review",
                                "data": result["extraction_review"],
                            },
                        })
                except Exception as e:
                    logger.exception(f"保存 extraction override 失败: {e}")
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "extraction_override_saved",
                            "data": {"ok": False, "error": "save_failed", "message": str(e)},
                        },
                    })
                continue

            if request_type in {
                "result_rob_adjudication",
                "save_result_rob_adjudication",
                "rob_result_decision",
            }:
                message_id = str(uuid.uuid4())
                try:
                    result = _save_result_rob_adjudication_payload(
                        content_obj,
                        parent_id=parent_id,
                        user_id=user_id,
                    )
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "result_rob_adjudication_saved",
                            "data": result,
                        },
                    })
                except Exception as e:
                    logger.exception(f"保存 result-level RoB adjudication 失败: {e}")
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "result_rob_adjudication_saved",
                            "data": {"ok": False, "error": "save_failed", "message": str(e)},
                        },
                    })
                continue

            if request_type in {
                "extraction_review_decision",
                "extraction_review_decisions",
                "save_extraction_review_decision",
            }:
                message_id = str(uuid.uuid4())
                try:
                    result = _save_extraction_review_decision_payload(content_obj, parent_id=parent_id, user_id=user_id)
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "extraction_review_decision_saved",
                            "data": result,
                        },
                    })
                    if result.get("ok") and result.get("extraction_review"):
                        await send_msg({
                            "id": message_id,
                            "parentId": parent_id,
                            "agentType": AGENT_TYPE,
                            "content": {
                                "clazz": "agent",
                                "type": "extraction_review",
                                "data": result["extraction_review"],
                            },
                        })
                except Exception as e:
                    logger.exception(f"保存 extraction review decision 失败: {e}")
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "extraction_review_decision_saved",
                            "data": {"ok": False, "error": "save_failed", "message": str(e)},
                        },
                    })
                continue

            if request_type in {"protocol_override", "protocol_overrides", "save_protocol_override"}:
                message_id = str(uuid.uuid4())
                try:
                    result = _save_protocol_override_payload(content_obj, parent_id=parent_id, user_id=user_id)
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "protocol_override_saved",
                            "data": result,
                        },
                    })
                    if result.get("ok") and result.get("benchmark"):
                        await send_msg({
                            "id": message_id,
                            "parentId": parent_id,
                            "agentType": AGENT_TYPE,
                            "content": {
                                "clazz": "agent",
                                "type": "benchmark_review",
                                "data": result["benchmark"],
                            },
                        })
                    if result.get("ok") and result.get("evidence_readiness"):
                        await send_msg({
                            "id": message_id,
                            "parentId": parent_id,
                            "agentType": AGENT_TYPE,
                            "content": {
                                "clazz": "agent",
                                "type": "evidence_readiness",
                                "data": result["evidence_readiness"],
                            },
                        })
                except Exception as e:
                    logger.exception(f"保存 protocol override 失败: {e}")
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "protocol_override_saved",
                            "data": {"ok": False, "error": "save_failed", "message": str(e)},
                        },
                    })
                continue

            if request_type in {
                "benchmark_source_decision",
                "save_benchmark_source_decision",
                "benchmark_quote_decision",
            }:
                message_id = str(uuid.uuid4())
                try:
                    result = _save_benchmark_source_decision_payload(
                        content_obj,
                        parent_id=parent_id,
                        user_id=user_id,
                    )
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "benchmark_source_decision_saved",
                            "data": result,
                        },
                    })
                    if result.get("ok") and result.get("benchmark"):
                        await send_msg({
                            "id": message_id,
                            "parentId": parent_id,
                            "agentType": AGENT_TYPE,
                            "content": {
                                "clazz": "agent",
                                "type": "benchmark_review",
                                "data": result["benchmark"],
                            },
                        })
                except Exception as e:
                    logger.exception(f"保存 benchmark source decision 失败: {e}")
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "benchmark_source_decision_saved",
                            "data": {"ok": False, "error": "save_failed", "message": str(e)},
                        },
                    })
                continue

            if request_type in {
                "benchmark_source_apply",
                "apply_benchmark_source_candidates",
                "apply_accepted_benchmark_sources",
            }:
                message_id = str(uuid.uuid4())
                try:
                    result = _apply_benchmark_source_candidates_payload(
                        content_obj,
                        parent_id=parent_id,
                        user_id=user_id,
                    )
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "benchmark_source_apply_done",
                            "data": result,
                        },
                    })
                    if result.get("ok") and result.get("extraction_review"):
                        await send_msg({
                            "id": message_id,
                            "parentId": parent_id,
                            "agentType": AGENT_TYPE,
                            "content": {
                                "clazz": "agent",
                                "type": "extraction_review",
                                "data": result["extraction_review"],
                            },
                        })
                    if result.get("ok") and result.get("benchmark"):
                        await send_msg({
                            "id": message_id,
                            "parentId": parent_id,
                            "agentType": AGENT_TYPE,
                            "content": {
                                "clazz": "agent",
                                "type": "benchmark_review",
                                "data": result["benchmark"],
                            },
                        })
                except Exception as e:
                    logger.exception(f"应用 benchmark source candidate 失败: {e}")
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "benchmark_source_apply_done",
                            "data": {"ok": False, "error": "apply_failed", "message": str(e)},
                        },
                    })
                continue

            if request_type in {"rerun_downstream", "rerun_after_overrides", "run_downstream_after_overrides"}:
                message_id = str(uuid.uuid4())
                try:
                    result = await asyncio.to_thread(
                        _run_downstream_after_overrides_payload,
                        content_obj,
                        parent_id=parent_id,
                        user_id=user_id,
                    )
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "downstream_rerun_done",
                            "data": result,
                        },
                    })
                    if result.get("ok") and result.get("evidence_readiness"):
                        await send_msg({
                            "id": message_id,
                            "parentId": parent_id,
                            "agentType": AGENT_TYPE,
                            "content": {
                                "clazz": "agent",
                                "type": "evidence_readiness",
                                "data": result["evidence_readiness"],
                            },
                        })
                except Exception as e:
                    logger.exception(f"重算 override 下游失败: {e}")
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "downstream_rerun_done",
                            "data": {"ok": False, "error": "rerun_failed", "message": str(e)},
                        },
                    })
                continue

            if request_type in {
                "manuscript_citation_patch_preview",
                "preview_manuscript_citation_patch",
                "preview_citation_patch",
            }:
                message_id = str(uuid.uuid4())
                try:
                    result = _preview_manuscript_citation_patch_payload(
                        content_obj,
                        parent_id=parent_id,
                        user_id=user_id,
                    )
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "manuscript_citation_patch_preview",
                            "data": result,
                        },
                    })
                except Exception as e:
                    logger.exception(f"预览 manuscript citation patch 失败: {e}")
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "manuscript_citation_patch_preview",
                            "data": {"ok": False, "error": "preview_failed", "message": str(e)},
                        },
                    })
                continue

            if request_type in {
                "manuscript_citation_patch_apply",
                "apply_manuscript_citation_patch",
                "apply_citation_patch",
            }:
                message_id = str(uuid.uuid4())
                try:
                    result = _apply_manuscript_citation_patch_payload(
                        content_obj,
                        parent_id=parent_id,
                        user_id=user_id,
                    )
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "manuscript_citation_patch_applied",
                            "data": result,
                        },
                    })
                    if result.get("ok") and result.get("manuscript_quality"):
                        await send_msg({
                            "id": message_id,
                            "parentId": parent_id,
                            "agentType": AGENT_TYPE,
                            "content": {
                                "clazz": "agent",
                                "type": "manuscript_quality",
                                "data": result["manuscript_quality"],
                            },
                        })
                except Exception as e:
                    logger.exception(f"应用 manuscript citation patch 失败: {e}")
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "manuscript_citation_patch_applied",
                            "data": {"ok": False, "error": "apply_failed", "message": str(e)},
                        },
                    })
                continue

            if request_type in {
                "manuscript_reference_add_preview",
                "preview_manuscript_reference_add",
                "preview_reference_add",
            }:
                message_id = str(uuid.uuid4())
                try:
                    result = _preview_manuscript_reference_add_payload(
                        content_obj,
                        parent_id=parent_id,
                        user_id=user_id,
                    )
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "manuscript_reference_add_preview",
                            "data": result,
                        },
                    })
                except Exception as e:
                    logger.exception(f"预览 manuscript reference add 失败: {e}")
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "manuscript_reference_add_preview",
                            "data": {"ok": False, "error": "preview_failed", "message": str(e)},
                        },
                    })
                continue

            if request_type in {
                "manuscript_reference_add_apply",
                "apply_manuscript_reference_add",
                "apply_reference_add",
            }:
                message_id = str(uuid.uuid4())
                try:
                    result = _apply_manuscript_reference_add_payload(
                        content_obj,
                        parent_id=parent_id,
                        user_id=user_id,
                    )
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "manuscript_reference_add_applied",
                            "data": result,
                        },
                    })
                    if result.get("ok") and result.get("manuscript_quality"):
                        await send_msg({
                            "id": message_id,
                            "parentId": parent_id,
                            "agentType": AGENT_TYPE,
                            "content": {
                                "clazz": "agent",
                                "type": "manuscript_quality",
                                "data": result["manuscript_quality"],
                            },
                        })
                except Exception as e:
                    logger.exception(f"应用 manuscript reference add 失败: {e}")
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "manuscript_reference_add_applied",
                            "data": {"ok": False, "error": "apply_failed", "message": str(e)},
                        },
                    })
                continue

            if request_type in {
                "manuscript_reference_add_batch_preview",
                "preview_manuscript_reference_add_batch",
                "preview_reference_add_batch",
            }:
                message_id = str(uuid.uuid4())
                try:
                    result = _preview_manuscript_reference_add_batch_payload(
                        content_obj,
                        parent_id=parent_id,
                        user_id=user_id,
                    )
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "manuscript_reference_add_batch_preview",
                            "data": result,
                        },
                    })
                except Exception as e:
                    logger.exception(f"预览 manuscript reference add batch 失败: {e}")
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "manuscript_reference_add_batch_preview",
                            "data": {"ok": False, "error": "preview_failed", "message": str(e)},
                        },
                    })
                continue

            if request_type in {
                "manuscript_reference_add_batch_apply",
                "apply_manuscript_reference_add_batch",
                "apply_reference_add_batch",
            }:
                message_id = str(uuid.uuid4())
                try:
                    result = _apply_manuscript_reference_add_batch_payload(
                        content_obj,
                        parent_id=parent_id,
                        user_id=user_id,
                    )
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "manuscript_reference_add_batch_applied",
                            "data": result,
                        },
                    })
                    if result.get("ok") and result.get("manuscript_quality"):
                        await send_msg({
                            "id": message_id,
                            "parentId": parent_id,
                            "agentType": AGENT_TYPE,
                            "content": {
                                "clazz": "agent",
                                "type": "manuscript_quality",
                                "data": result["manuscript_quality"],
                            },
                        })
                except Exception as e:
                    logger.exception(f"应用 manuscript reference add batch 失败: {e}")
                    await send_msg({
                        "id": message_id,
                        "parentId": parent_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "manuscript_reference_add_batch_applied",
                            "data": {"ok": False, "error": "apply_failed", "message": str(e)},
                        },
                    })
                continue

            if not input_text:
                continue

            # ── PDF 等待状态处理（理论上不应到达此处，inline 循环已拦截）──
            # 保留作为安全兜底，以防竞态
            if session_ctx.get("pdf_waiting"):
                continue

            # ── 过滤 stale PDF 回复（Phase 2 已启动后才到达的点击）──
            _PDF_RESPONSES = {"跳过PDF上传，继续分析", "已完成PDF上传，请继续分析"}
            if input_text in _PDF_RESPONSES:
                continue

            message_id = str(uuid.uuid4())
            _done_steps.clear()
            _doing_step = -1

            # ── 意图分类 ──
            intent = await _classify_intent(input_text, session_ctx)
            logger.info(f"意图分类结果: {intent} | 输入: {input_text[:40]}")

            if intent == "greeting":
                await push_typewriter(
                    "你好！我是「Meta 分析助手」，专注于自动化系统评价和 Meta 分析。\n\n"
                    "我可以帮你：\n"
                    "- 自动完成从文献检索到统计分析的全流程\n"
                    "- 生成符合 PRISMA 规范的完整报告\n"
                    "- 提供异质性检验、发表偏倚评估等专业统计\n\n"
                    "请输入你的临床研究问题，例如：*二甲双胍对2型糖尿病患者心血管事件的影响*",
                    message_id, finished=True,
                )
                continue

            if intent == "general_chat":
                await _answer_general(input_text, session_ctx, send_msg, parent_id, message_id)
                continue

            if intent == "followup":
                if session_ctx["last_report"]:
                    await _answer_from_report(input_text, session_ctx, send_msg, parent_id, message_id)
                else:
                    await push_typewriter(
                        "**请先完成一次 Meta 分析**\n\n"
                        f"您询问的「{input_text}」是关于分析结果的问题，"
                        "但当前会话尚未完成任何 Meta 分析。\n\n"
                        "请先输入具体的临床研究问题，例如：\n"
                        "- *二甲双胍对2型糖尿病患者心血管事件的影响*\n"
                        "- *阿司匹林预防心血管疾病的有效性*",
                        message_id, finished=True,
                    )
                continue

            if intent == "other":
                await _answer_general(input_text, session_ctx, send_msg, parent_id, message_id)
                continue

            # ── meta_question：两阶段 pipeline ──
            sem_acquired = False
            sem_stage = ""
            sem_ticket: PipelineSlotTicket | None = None
            try:
                sem_ticket = await acquire_pipeline_slot("phase1")
                sem_acquired = sem_ticket is not None
                sem_stage = "phase1" if sem_acquired else ""
            except Exception:
                pass

            try:
                loop = asyncio.get_running_loop()
                progress_queue: asyncio.Queue = asyncio.Queue()

                def push(kind: str, payload):
                    asyncio.run_coroutine_threadsafe(progress_queue.put((kind, payload)), loop)

                async def consume_progress_events(until_error_or_done: bool = True, use_status: bool = False):
                    """Drain progress_queue, send messages to frontend. Returns (report_md, error)."""
                    nonlocal last_step_idx, _doing_step
                    _report = None
                    _err = False
                    while True:
                        try:
                            kind, payload = await asyncio.wait_for(progress_queue.get(), timeout=3600)
                        except asyncio.TimeoutError:
                            await push_typewriter("⏰ Meta 分析超时，请稍后重试", message_id)
                            return None, True

                        if kind == "progress":
                            step_idx, label = payload
                            if last_step_idx >= 0:
                                _done_steps.add(last_step_idx)
                            _doing_step = step_idx
                            if use_status:
                                await push_status()
                            display = META_STEP_DISPLAY.get(step_idx)
                            if display:
                                await send_msg({
                                    "id": message_id, "parentId": parent_id, "agentType": AGENT_TYPE,
                                    "content": {
                                        "clazz": "agent", "type": "raw",
                                        "data": {
                                            "type": "tool_call",
                                            "str": display[0],
                                            "front_display": display[1],
                                            "description": display[2] if len(display) > 2 else "",
                                            "inprogress": True,
                                        },
                                    },
                                })
                            last_step_idx = step_idx

                        elif kind == "done_step":
                            step_idx, label, ctx_data = payload
                            summary_fn = META_STEP_SUMMARY.get(step_idx)
                            summary = summary_fn(ctx_data) if summary_fn else f"✅ {label} 完成"
                            await push_typewriter(summary, message_id, finished=False)

                        elif kind == "extraction_review":
                            await send_msg({
                                "id": message_id,
                                "parentId": parent_id,
                                "agentType": AGENT_TYPE,
                                "content": {
                                    "clazz": "agent",
                                    "type": "extraction_review",
                                    "data": payload,
                                },
                            })

                        elif kind == "pdf_intake":
                            await send_msg({
                                "id": message_id,
                                "parentId": parent_id,
                                "agentType": AGENT_TYPE,
                                "content": {
                                    "clazz": "agent",
                                    "type": "pdf_intake",
                                    "data": payload,
                                },
                            })

                        elif kind == "fulltext_retrieval":
                            await send_msg({
                                "id": message_id,
                                "parentId": parent_id,
                                "agentType": AGENT_TYPE,
                                "content": {
                                    "clazz": "agent",
                                    "type": "fulltext_retrieval",
                                    "data": payload,
                                },
                            })

                        elif kind == "fulltext_required":
                            _doing_step = -1
                            await send_msg({
                                "id": message_id,
                                "parentId": parent_id,
                                "agentType": AGENT_TYPE,
                                "content": {
                                    "clazz": "agent",
                                    "type": "fulltext_required",
                                    "data": payload,
                                },
                            })
                            await push_typewriter(
                                "自动全文获取未找到可用于提取的原文。请上传全文后继续当前任务。",
                                message_id,
                                finished=True,
                            )
                            return None, True

                        elif kind == "method_decision_required":
                            _doing_step = -1
                            await send_msg({
                                "id": message_id,
                                "parentId": parent_id,
                                "agentType": AGENT_TYPE,
                                "content": {
                                    "clazz": "agent",
                                    "type": "method_decision_required",
                                    "data": payload,
                                },
                            })
                            await push_typewriter(
                                "当前存在需要方法学确认的选项。请选择推荐项或其他选项后继续当前任务。",
                                message_id,
                                finished=True,
                            )
                            return None, True

                        elif kind == "evidence_readiness":
                            await send_msg({
                                "id": message_id,
                                "parentId": parent_id,
                                "agentType": AGENT_TYPE,
                                "content": {
                                    "clazz": "agent",
                                    "type": "evidence_readiness",
                                    "data": payload,
                                },
                            })

                        elif kind == "manuscript_quality":
                            await send_msg({
                                "id": message_id,
                                "parentId": parent_id,
                                "agentType": AGENT_TYPE,
                                "content": {
                                    "clazz": "agent",
                                    "type": "manuscript_quality",
                                    "data": payload,
                                },
                            })

                        elif kind == "done":
                            _report = payload
                            for i in range(len(META_STEPS)):
                                _done_steps.add(i)
                            _doing_step = -1
                            if use_status:
                                await push_status()
                            return _report, False

                        elif kind == "blocked":
                            _doing_step = -1
                            await send_msg({
                                "id": message_id,
                                "parentId": parent_id,
                                "agentType": AGENT_TYPE,
                                "content": {
                                    "clazz": "agent",
                                    "type": "release_blocked",
                                    "data": payload,
                                },
                            })
                            await push_typewriter(
                                "⛔ 分析与审查包已生成，但投稿发布门禁未通过。请按阻断项完成复核后重新运行。",
                                message_id,
                                finished=True,
                            )
                            return None, True

                        elif kind == "error":
                            await push_typewriter(f"❌ {payload}", message_id)
                            return None, True

                        elif kind == "phase1_done":
                            # 明确标记步骤 0-3 全部完成，重置 doing 状态
                            for i in range(4):
                                _done_steps.add(i)
                            _doing_step = -1
                            return payload, False  # payload = phase1_state dict

                last_step_idx = -1

                # ─ Phase 1 启动提示 ─
                await push_typewriter(
                    f"收到您的研究问题：**{input_text}**\n\n"
                    "我将为您执行完整的 Meta 分析流程，共分两个阶段：\n"
                    "- **第一阶段**：PICO 提取 → 检索策略构建 → PubMed 文献检索 → 标题摘要筛选\n"
                    "- **第二阶段**：全文精筛 → 数据提取 → 偏倚评估 → 统计合并 → 报告撰写\n\n"
                    "正在启动第一阶段…",
                    message_id, finished=False,
                )

                # ─ Phase 1: 步骤 0-3 ─
                phase1_future = loop.run_in_executor(
                    _pipeline_executor, _run_phase1_sync,
                    input_text, str(META_ROOT / "output"), push,
                )

                phase1_state, phase1_err = await consume_progress_events()
                if phase1_err:
                    try:
                        await asyncio.wait_for(phase1_future, timeout=15)
                    except Exception:
                        pass
                    continue

                try:
                    phase1_state = await asyncio.wait_for(phase1_future, timeout=30)
                except Exception as fe:
                    await push_typewriter(f"❌ 文献检索阶段失败：{fe}", message_id)
                    continue

                phase1_state["topic"] = input_text
                phase1_state["skip_confirm"] = bool(
                    content_obj.get("skip_confirm")
                    or content_obj.get("skipConfirm")
                    or content_obj.get("full_auto")
                )
                for _lang_key in (
                    "output_language",
                    "outputLanguage",
                    "manuscript_language",
                    "manuscriptLanguage",
                    "language",
                    "lang",
                ):
                    if content_obj.get(_lang_key):
                        phase1_state[_lang_key] = content_obj.get(_lang_key)
                if phase1_state.get("terminal_manuscript"):
                    from new_meta.core.evidence_gap_delivery import complete_zero_record_review
                    from new_meta.core.project import Project

                    requested_lang = _requested_output_language(
                        phase1_state,
                        fallback_text=input_text,
                    )
                    project = Project(
                        input_text,
                        resume_dir=Path(phase1_state["project_dir"]),
                    )
                    manuscript = complete_zero_record_review(
                        project=project,
                        protocol=phase1_state["protocol"],
                        search_query=phase1_state["search_query"],
                        prisma_data=project.prisma.to_dict(),
                        reason=phase1_state["terminal_reason"],
                        lang=requested_lang,
                    )
                    await push_typewriter(manuscript, message_id, finished=True)
                    continue
                ta_included = phase1_state.get("ta_included", [])
                if sem_acquired:
                    await release_pipeline_slot(sem_ticket)
                    sem_acquired = False
                    sem_stage = ""
                    sem_ticket = None

                # ─ 按 priority_tier 排序：direct > uncertain > indirect ─
                _tier_order = {"direct": 0, "uncertain": 1, "indirect": 2}
                ta_included_sorted = sorted(
                    ta_included,
                    key=lambda p: _tier_order.get(p.get("priority_tier", "uncertain"), 1)
                )
                phase1_state["ta_included"] = ta_included_sorted  # 保持完整有序列表

                # Do not stop for an upload before automatic retrieval. Files
                # attached with the original topic are still accepted, while
                # Phase 2 first attempts open PDF and Europe PMC full text for
                # every remaining candidate.
                user_pdf_paths: list[str] = []
                if file_ids:
                    pdf_save_dir = META_ROOT / "output" / "user_pdfs" / parent_id
                    user_pdf_paths = await _download_pdfs_from_mongo(file_ids, pdf_save_dir)
                    logger.info(f"MongoDB 用户 PDF: {len(user_pdf_paths)} 个")

                # ─ 发送 Phase 2 任务计划 ─
                phase2_steps = META_STEPS[4:]
                n_screened = len(ta_included)
                await push_typewriter(
                    f"文献检索阶段完成，共 **{n_screened}** 篇文献通过标题摘要筛选，进入全文审查。\n\n"
                    "正在自动获取可用全文并继续分析…",
                    message_id, finished=False,
                )

                await send_msg({
                    "id": message_id, "parentId": parent_id, "agentType": AGENT_TYPE,
                    "content": {
                        "clazz": "agent", "type": "orchestra",
                        "data": {
                            "type": "plan",
                            "item": {"analysis": "Meta分析进度（全文阶段）", "todo": phase2_steps},
                        },
                    },
                })

                # ─ Phase 2: 步骤 4-9 ─
                try:
                    sem_ticket = await acquire_pipeline_slot("phase2")
                    sem_acquired = sem_ticket is not None
                    sem_stage = "phase2" if sem_acquired else ""
                except Exception:
                    sem_acquired = False
                    sem_stage = ""
                    sem_ticket = None

                progress_queue2: asyncio.Queue = asyncio.Queue()

                def push2(kind: str, payload):
                    asyncio.run_coroutine_threadsafe(progress_queue2.put((kind, payload)), loop)

                phase2_future = loop.run_in_executor(
                    _pipeline_executor, _run_phase2_sync,
                    phase1_state, str(META_ROOT / "output"), push2, user_pdf_paths,
                )

                # Temporarily point progress consumer to queue2
                _orig_queue = progress_queue
                progress_queue = progress_queue2

                report_md, phase2_err = await consume_progress_events(use_status=True)

                progress_queue = _orig_queue

                if phase2_err:
                    try:
                        await asyncio.wait_for(phase2_future, timeout=15)
                    except Exception:
                        pass
                    continue

                if not report_md:
                    try:
                        report_md = await asyncio.wait_for(phase2_future, timeout=30)
                    except Exception:
                        report_md = None

                if not report_md:
                    raise ValueError("管线运行完成但未生成报告")

                # text_finish 重置消息路由
                await send_msg({
                    "id": message_id, "parentId": parent_id, "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "text_finish", "data": {}},
                })

                # 上传报告到 OSS
                report_text_only = re.sub(r'!\[([^\]]*)\]\(data:[^)]{20,}\)', r'[图表: \1]', report_md)
                oss_url = await _upload_report(report_md, user_id, message_id)
                md_value = oss_url if oss_url else (
                    "data:text/markdown;base64," + base64.b64encode(report_md.encode()).decode()
                )

                # 发送 finish
                await send_msg({
                    "id": message_id, "parentId": parent_id, "agentType": AGENT_TYPE,
                    "content": {
                        "clazz": "agent", "type": "finish",
                        "data": {
                            "md": md_value,
                            "pdf": "",
                            "name": f"Meta分析_{input_text[:20]}",
                            "isFinished": True,
                        },
                    },
                })

                session_ctx["last_topic"] = input_text
                session_ctx["last_report"] = report_text_only
                session_ctx["chat_history"] = []

            except Exception as e:
                logger.exception(f"会话 {parent_id} Meta分析失败: {e}")
                await send_msg({
                    "id": message_id, "parentId": parent_id, "agentType": AGENT_TYPE,
                    "content": {
                        "clazz": "agent", "type": "stream",
                        "data": {"type": "text", "delta": f"Meta 分析执行失败：{str(e)}", "inprogress": False, "isFinished": True},
                    },
                })
            finally:
                if sem_acquired and _pipeline_limiter:
                    await release_pipeline_slot(sem_ticket)

    except Exception as e:
        logger.error(f"会话 {parent_id} 异常退出: {e}", exc_info=True)


# ─────────────── Java WebSocket 客户端 ───────────────

async def _java_ws_client():
    import websockets
    active_sessions: Dict[str, dict] = {}

    _hb_task = None
    while True:
        try:
            token = await _get_java_token()
            python_client_id = AGENT_TYPE

            logger.info(f"正在连接 Java WebSocket: {JAVA_WS_URL}")
            async with websockets.connect(
                JAVA_WS_URL,
                ping_interval=15,
                ping_timeout=10,
                close_timeout=5,
            ) as ws:
                await ws.send(json.dumps({
                    "type": "auth",
                    "token": token,
                    "clientType": AGENT_TYPE,
                    "userId": python_client_id,
                    "agentType": AGENT_TYPE,
                }, ensure_ascii=False))
                logger.info("已发送 auth 消息，等待 Java 分发消息…")

                async def ws_send(data: str):
                    await ws.send(data)

                # Python → Java 主动心跳（每15秒）
                async def _send_hb():
                    while True:
                        await asyncio.sleep(15)
                        try:
                            await ws.send(json.dumps({"type": "heartbeat"}))
                        except Exception:
                            break
                _hb_task = asyncio.create_task(_send_hb())

                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except Exception:
                        continue

                    # 收到心跳不回复，避免死循环
                    if msg.get("type") == "heartbeat":
                        continue

                    if msg.get("type") == "system":
                        cid = msg.get("clientId") or msg.get("pythonClientId")
                        if cid:
                            python_client_id = cid
                        content = msg.get('content', '') if isinstance(msg.get('content', ''), str) else str(msg.get('content', ''))
                        logger.info(f"Java 系统消息: {content[:100]}")
                        if '认证失败' in content or '无效' in content.lower() or 'invalid' in content.lower() or 'unauthorized' in content.lower():
                            logger.error(f"Java 认证失败，主动断开重连: {content}")
                            break
                        continue

                    parent_id = msg.get("parentId")
                    if not parent_id:
                        continue

                    sender_id = msg.get("senderId", "")
                    uid = msg.get("userId", "")

                    if parent_id not in active_sessions:
                        q: asyncio.Queue = asyncio.Queue(maxsize=50)
                        t = asyncio.create_task(
                            _handle_session(parent_id, q, python_client_id, ws_send, sender_id, uid)
                        )
                        t.add_done_callback(lambda _, pid=parent_id: active_sessions.pop(pid, None))
                        active_sessions[parent_id] = {"queue": q, "task": t}
                        logger.info(f"新会话: parentId={parent_id}, 活跃={len(active_sessions)}, sender={sender_id}")

                    try:
                        active_sessions[parent_id]["queue"].put_nowait(msg)
                    except asyncio.QueueFull:
                        logger.warning(f"会话 {parent_id} 消息队列已满，丢弃消息")

        except Exception as e:
            logger.warning(f"Java WS 连接断开: {e}，5 秒后重连…")

        # 清理心跳任务
        if _hb_task and not _hb_task.done():
            _hb_task.cancel()
            try:
                await _hb_task
            except asyncio.CancelledError:
                pass

        for sid, sess in list(active_sessions.items()):
            sess["task"].cancel()
        active_sessions.clear()
        await asyncio.sleep(5)


# ─────────────── FastAPI 应用 ───────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _java_client_task, _pipeline_semaphore, _pipeline_queue_lock, _pipeline_waiting, _pipeline_running, _pipeline_limiter

    from new_meta.config import LLM_API_KEY
    if not LLM_API_KEY:
        logger.error("未配置 LLM_API_KEY！请在 .env 中设置。")
    if not OSS_ACCESS_KEY_ID or not OSS_ACCESS_KEY_SECRET:
        logger.warning("OSS 凭证未配置，报告将以 base64 降级返回。")

    _pipeline_semaphore = asyncio.Semaphore(MAX_SESSIONS)
    _pipeline_queue_lock = asyncio.Lock()
    _pipeline_waiting = 0
    _pipeline_running = 0
    _pipeline_limiter = PipelineSlotLimiter(MAX_SESSIONS)

    logger.info(
        f"Meta 分析服务启动 | port={SERVICE_PORT} "
        f"| Java={JAVA_WS_URL} | MaxSessions={MAX_SESSIONS}"
    )
    _java_client_task = asyncio.create_task(_java_ws_client())
    yield
    logger.info("Meta 分析服务关闭")
    if _java_client_task:
        _java_client_task.cancel()
        try:
            await _java_client_task
        except asyncio.CancelledError:
            pass
    _pipeline_executor.shutdown(wait=False)


app = FastAPI(title="Meta 分析服务", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=api_cors_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(create_api_router(META_ROOT / "output"))
app.include_router(create_evimed_adapter_router())


@app.get("/health")
async def health():
    limiter_snapshot = _pipeline_limiter.snapshot() if _pipeline_limiter else {
        "running_sessions": _pipeline_running,
        "queued_sessions": _pipeline_waiting,
    }
    return {
        "status": "ok",
        "service": AGENT_TYPE,
        "port": SERVICE_PORT,
        "max_sessions": MAX_SESSIONS,
        **limiter_snapshot,
    }


# ─────────────── 启动入口 ───────────────

def main():
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="Meta 分析 WebSocket 服务")
    parser.add_argument("--port", type=int, default=SERVICE_PORT, help="服务端口")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址")
    parser.add_argument("--reload", action="store_true", help="开发模式热重载")
    args = parser.parse_args()

    uvicorn.run(
        "start:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
