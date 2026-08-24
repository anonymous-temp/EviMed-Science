"""Authenticated internal adapters for the five evidence-backed drug workflows."""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Security

from .security import _authorized_claims, _signing_secret


MCP_ROOT = Path(os.getenv("EVIMED_MCP_ROOT", "/mcp")).resolve()
if str(MCP_ROOT) not in sys.path:
    sys.path.insert(0, str(MCP_ROOT))

import public_sources  # noqa: E402


ENDPOINTS = {
    "/api/v1/evimed/adr-cases": "adr_case_query",
    "/api/v1/evimed/adr-signal": "adr_signal_analysis",
    "/api/v1/evimed/offlabel-evidence-packet": "offlabel_evidence_packet",
    "/api/v1/evimed/comprehensive-drug-evaluation": "comprehensive_drug_evaluation",
    "/api/v1/evimed/drug-selection-evaluation": "drug_selection_evaluation",
    "/api/v1/evimed/pharmacy-reference-search": "pharmacy_reference_search",
}


def _pharmacy_database_ready() -> bool:
    configured = os.getenv("EVIMED_PHARMACY_REFERENCE_DB", "").strip()
    if not configured or not os.path.isabs(configured) or "\0" in configured:
        return False
    database = Path(configured)
    try:
        if database.is_symlink() or not database.is_file():
            return False
        connection = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True, timeout=2)
        try:
            connection.execute("PRAGMA query_only = ON")
            records = connection.execute("SELECT COUNT(*) FROM records").fetchone()
            fts = connection.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'records_fts'"
            ).fetchone()
            return bool(records and records[0] > 0 and fts and fts[0] == 1)
        finally:
            connection.close()
    except (OSError, sqlite3.Error):
        return False


def _failure(error: public_sources.PublicSourceError) -> dict[str, Any]:
    return {
        "status": "error",
        "summary": str(error),
        "next_actions": ["Review source availability and retry once when the upstream is healthy."],
        "error": {
            "code": error.code,
            "message": str(error),
            "retryable": bool(error.retryable),
            "stopReason": "Stop after one retry if the evidence source remains unavailable.",
        },
    }


def _call(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(arguments, dict):
        raise HTTPException(status_code=422, detail="request body must be a JSON object")
    if len(arguments) > 100:
        raise HTTPException(status_code=422, detail="request contains too many fields")
    if len(json.dumps(arguments, ensure_ascii=False).encode("utf-8")) > 64 * 1024:
        raise HTTPException(status_code=422, detail="request body is too large")
    try:
        return public_sources.call(tool_name, arguments)
    except public_sources.PublicSourceError as error:
        return _failure(error)


def _create_app() -> FastAPI:
    instance = FastAPI(title="EviMed Drug Evidence Adapters", docs_url=None, redoc_url=None)

    @instance.get("/health")
    def health() -> dict[str, Any]:
        try:
            _signing_secret()
            ready = _pharmacy_database_ready()
        except (OSError, UnicodeDecodeError, RuntimeError):
            ready = False
        return {
            "status": "ok" if ready else "degraded",
            "ready": ready,
            "tools": sorted(ENDPOINTS.values()),
        }

    def route_for(tool_name: str):
        def adapter_call(
            arguments: dict[str, Any] = Body(...),
            _claims: dict[str, Any] = Security(_authorized_claims),
        ) -> dict[str, Any]:
            return _call(tool_name, arguments)

        return adapter_call

    for endpoint, tool_name in ENDPOINTS.items():
        instance.add_api_route(endpoint, route_for(tool_name), methods=["POST"], name=tool_name)
    return instance


app = _create_app()
