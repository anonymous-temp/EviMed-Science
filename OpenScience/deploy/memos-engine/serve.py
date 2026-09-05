"""Private MemOS entrypoint with operational metadata separated from memory text."""

from __future__ import annotations

import asyncio
import importlib
import json
import logging
import sys
import time
from typing import Any, Awaitable, Callable

ASGI = Callable[[dict[str, Any], Callable, Callable], Awaitable[None]]
ROUTES = frozenset({
    "/health", "/product/add", "/product/search", "/product/get_memory",
    "/product/delete_memory", "/product/scheduler/status",
})


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
    main()
