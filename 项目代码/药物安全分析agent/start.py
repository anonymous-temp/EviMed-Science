"""Drug Safety Analysis Agent — service entry point.

Starts the FastAPI REST service (default port 6010) and, unless disabled,
the outbound Java WebSocket client (clientType=drug-safety-analysis) inside
the app lifespan — the same coexistence shape as the other EviMed Python
agents.

    python start.py [--host 0.0.0.0] [--port 6010] [--no-ws] [--reload]
"""

from __future__ import annotations

import argparse
import asyncio
from contextlib import asynccontextmanager

import uvicorn

from safety_agent.api.app import create_app
from safety_agent.api.service import ServiceContext
from safety_agent.api.ws_client import ws_client_loop
from safety_agent.core.config import get_settings
from safety_agent.core.logging import configure_logging, get_logger

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app):
    settings = get_settings()
    configure_logging(settings.log_level)
    if not settings.deepseek_api_key.get_secret_value():
        logger.warning("DEEPSEEK_API_KEY not configured; LLM steps will degrade")
    if not settings.oss_access_key_id.get_secret_value():
        logger.warning("OSS credentials not configured; reports degrade to base64")

    service = ServiceContext(settings)
    app.state.service = service
    ws_task = None
    if app.state.enable_ws and settings.java_ws_url:
        ws_task = asyncio.create_task(ws_client_loop(service))
        logger.info(
            "service starting | port=%s | WS=%s | agent=drug-safety-analysis",
            settings.service_port,
            settings.java_ws_url,
        )
    else:
        logger.info("service starting | port=%s | WS disabled", settings.service_port)
    try:
        yield
    finally:
        if ws_task is not None:
            ws_task.cancel()
            try:
                await ws_task
            except asyncio.CancelledError:
                pass
        await service.aclose()
        logger.info("service stopped")


app = create_app()
app.router.lifespan_context = lifespan


def main() -> None:
    settings = get_settings()
    parser = argparse.ArgumentParser(description="Drug Safety Analysis Agent service")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=settings.service_port)
    parser.add_argument("--no-ws", action="store_true", help="do not start the Java WS client")
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()
    if args.no_ws:
        app.state.enable_ws = False
    uvicorn.run(
        "start:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
        factory=False,
    )


if __name__ == "__main__":
    main()
