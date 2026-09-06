"""Private MemOS entrypoint with operational metadata separated from memory text."""

from __future__ import annotations

import asyncio
import importlib
import json
import logging
import math
import sys
import time
from typing import Any, Awaitable, Callable
import urllib.request

ASGI = Callable[[dict[str, Any], Callable, Callable], Awaitable[None]]
ROUTES = frozenset({
    "/health", "/product/add", "/product/search", "/product/get_memory",
    "/product/delete_memory", "/product/scheduler/status",
})
HEALTH_BODY_MAX_BYTES = 64 * 1024
EMBEDDING_MODEL = "bge-m3:latest"
EMBEDDING_DIMENSIONS = 1024


def _health_json(url: str, timeout: float, payload: dict[str, Any] | None = None) -> dict:
    """Read a bounded response from one deployment-owned health dependency."""
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode() if payload is not None else None,
        headers={"accept": "application/json", "content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise ValueError("Health dependency did not return success")
        body = response.read(HEALTH_BODY_MAX_BYTES + 1)
    if len(body) > HEALTH_BODY_MAX_BYTES:
        raise ValueError("Health response exceeded its byte limit")
    result = json.loads(body)
    if not isinstance(result, dict):
        raise ValueError("Health response was not an object")
    return result


def check_health() -> bool:
    """Require a working index API and a warm, finite embedding from its model.

    The Ollama image has no HTTP client. This existing Python image performs
    readiness without importing MemOS, loading provider keys, or logging vectors.
    The caller-facing recall deadlines are independent of this startup probe.
    """
    stage = "engine"
    try:
        engine = _health_json("http://127.0.0.1:8000/health", timeout=2)
        if any(engine.get(key) != value for key, value in {
            "status": "healthy", "service": "memos", "version": "1.0.1",
        }.items()):
            raise ValueError("Memory API is not ready")
        stage = "embedding"
        result = _health_json("http://evimed-memos-ollama:11434/api/embed", timeout=6, payload={
            "model": EMBEDDING_MODEL, "input": "EviMed embedding readiness", "keep_alive": -1,
        })
        embeddings = result.get("embeddings")
        if result.get("model") != EMBEDDING_MODEL or not isinstance(embeddings, list) or len(embeddings) != 1:
            raise ValueError("Embedding response does not match the configured model")
        vector = embeddings[0]
        if not isinstance(vector, list) or len(vector) != EMBEDDING_DIMENSIONS or not all(
            isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
            for value in vector
        ) or not any(vector):
            raise ValueError("Embedding vector is not usable")
        return True
    except (OSError, ValueError, TypeError, OverflowError):
        print(json.dumps({"event": "memory_engine_health_failed", "stage": stage}), flush=True)
        return False


def silence_upstream_logging() -> None:
    """Upstream INFO/file handlers include full requests; retain only our metadata."""
    logging.disable(sys.maxsize)


class PrivateMemoryApplication:
    def __init__(self, app: ASGI) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Callable, send: Callable) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False
        status = 500
        failed = False
        canceled = False
        completed = False
        began = time.monotonic()

        async def capture(message: dict[str, Any]) -> None:
            nonlocal started, status, completed
            if message["type"] == "http.response.start":
                started = True
                status = int(message["status"])
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                completed = True
            await send(message)

        try:
            await self.app(scope, receive, capture)
        except asyncio.CancelledError:
            failed = True
            canceled = True
            raise
        except Exception:
            failed = True
            if started:
                # The HTTP server closes a partial response. Never turn it into success.
                raise
            status = 500
            body = b'{"code":"memory_engine_failed","message":"Memory engine request failed."}'
            await send({"type": "http.response.start", "status": status, "headers": [
                (b"content-type", b"application/json"), (b"cache-control", b"no-store"),
            ]})
            await send({"type": "http.response.body", "body": body})
        finally:
            route = scope.get("path")
            method = scope.get("method")
            print(json.dumps({
                "event": "memory_engine_request", "path": route if route in ROUTES else "/unmatched",
                "method": method if method in {"GET", "POST", "DELETE", "PUT", "PATCH", "HEAD", "OPTIONS"} else "OTHER",
                "status": status, "failed": failed or status >= 500 or not completed, "canceled": canceled, "elapsedMs": round((time.monotonic() - began) * 1000),
            }), flush=True)


def main() -> None:
    silence_upstream_logging()
    try:
        from index_profile import configure_scheduler, prepare_environment
        prepare_environment()
        configure_scheduler(importlib.import_module("memos.api.config").APIConfig)
        app = importlib.import_module("memos.api.server_api").app
        import uvicorn

        print('{"event":"memory_engine_starting"}', flush=True)
        uvicorn.run(PrivateMemoryApplication(app), host="0.0.0.0", port=8000,
                    access_log=False, log_config=None, server_header=False)
    except (Exception, SystemExit):
        print('{"event":"memory_engine_start_failed"}', file=sys.stderr, flush=True)
        raise SystemExit(1) from None


if __name__ == "__main__":
    if sys.argv[1:] == ["--health"]:
        raise SystemExit(0 if check_health() else 1)
    main()
