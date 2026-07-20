"""Outbound Java WebSocket client (clientType=drug-safety-analysis).

Protocol mirrors the other EviMed Python agents (孟德尔随机化 blueprint):
poll JAVA_TOKEN_URL for a token -> websockets.connect(JAVA_WS_URL) ->
auth frame -> 15s heartbeat -> per-session message queues -> per user
question: rule-based drug/ADR extraction -> run the analysis pipeline ->
push stream/status/finish frames, with the report markdown delivered as an
OSS URL (base64 data-URL fallback).

Extraction is deliberately rule-based (no LLM): Chinese suffixes like
「的ADR」「的不良反应」 are stripped and an optional "drug 的 reaction"
split is attempted; the normalize layer then validates the drug against
openFDA. LLM-based extraction is a P6 seam.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import uuid
from datetime import datetime
from typing import Any

import httpx
import websockets

from safety_agent.core.exceptions import SafetyAgentError
from safety_agent.core.logging import get_logger
from safety_agent.normalize.adr import normalize_adr
from safety_agent.report.markdown import render_markdown

from .jobs import STAGE_LABELS_ZH
from .oss import upload_markdown
from .service import ServiceContext

logger = get_logger(__name__)

AGENT_TYPE = "drug-safety-analysis"

SESSION_STEPS = [
    "解析药品与不良反应",
    "FAERS 病例概览",
    "失比例信号计算",
    "说明书对照与证据交叉",
    "生成安全性报告",
]

_STAGE_TO_STEP = {
    "normalize": 0,
    "overview": 1,
    "signals": 2,
    "evidence": 3,
    "interpret": 4,
    "write": 4,
}

#: leading intent verbs stripped before drug extraction
_PREFIX_RE = re.compile(
    r"^(?:帮我|请|帮忙|麻烦|我想(?:分析|了解|查询)?|给我)?\s*"
    r"(?:分析|分析一下|查询|查一下|评估|评价|做个|做下|检索)\s*",
    re.IGNORECASE,
)
#: "drug 的 reaction (的)ADR/不良反应" — drug + reaction split
_DRUG_REACTION_RE = re.compile(
    r"^(.+?)的(.+?)(?:的)?(?:ADR|adr|不良反应|不良事件|副作用)(?:的?(?:分析|评价|评估|报告))?$",
    re.IGNORECASE,
)
#: "drug (的)ADR/不良反应" — drug only
_DRUG_ONLY_RE = re.compile(
    r"^(.+?)(?:的)?(?:ADR|adr|不良反应|不良事件|副作用)(?:的?(?:分析|评价|评估|报告))?$",
    re.IGNORECASE,
)

_TOKEN_TIMEOUT = httpx.Timeout(10.0)


def extract_drug_and_reactions(text: str) -> tuple[str, list[str]]:
    """Rule-based extraction of (drug, [reaction...]) from a user question."""
    cleaned = _PREFIX_RE.sub("", text.strip().strip("。!！?？ ")).strip()
    if not cleaned:
        return "", []
    match = _DRUG_REACTION_RE.match(cleaned)
    if match:
        drug = match.group(1).strip(" 的对与和,")
        reaction = match.group(2).strip(" 的对与和,")
        if drug and reaction:
            return drug, [reaction]
    match = _DRUG_ONLY_RE.match(cleaned)
    if match:
        drug = match.group(1).strip(" 的对与和,")
        if drug:
            return drug, []
    # "drug 的 reaction" without an ADR suffix: accept the split only when
    # the reaction part deterministically resolves to a known MedDRA PT
    # (so 「二甲双胍的价格」 is not misread as drug+ADR).
    if "的" in cleaned:
        drug_part, _, reaction_part = cleaned.partition("的")
        drug_part = drug_part.strip(" 的对与和,")
        reaction_part = reaction_part.strip(" 的对与和,")
        if drug_part and reaction_part and normalize_adr(reaction_part).normalized:
            return drug_part, [reaction_part]
    # no ADR suffix at all: treat the whole cleaned text as the drug name
    return cleaned, []


def _make_ts() -> list[int]:
    now = datetime.now()
    return [now.year, now.month, now.day, now.hour, now.minute, now.second, now.microsecond * 1000]


async def _get_java_token(service: ServiceContext) -> str:
    """Poll the Java token endpoint until a token is issued."""
    url = service.settings.java_token_url
    attempt = 0
    while True:
        attempt += 1
        try:
            async with httpx.AsyncClient(timeout=_TOKEN_TIMEOUT) as client:
                response = await client.get(url)
            data = response.json()
            token = (
                (data.get("data") or {}).get("token")
                or (data.get("data") or {}).get("accessToken")
                or data.get("token", "")
                or data.get("accessToken", "")
            ) if isinstance(data, dict) else ""
            if token:
                logger.info("Java token obtained (attempt %d)", attempt)
                return token
            logger.warning("Java token endpoint returned empty (attempt %d), retrying", attempt)
        except Exception as exc:
            logger.error("Java token fetch failed (attempt %d): %s", attempt, exc)
        await asyncio.sleep(5)


class _SessionMessenger:
    """Frame builders + senders for one WS session."""

    def __init__(self, ws: Any, *, session_id: str, user_id: str, python_client_id: str) -> None:
        self._ws = ws
        self.session_id = session_id
        self.user_id = user_id
        self.python_client_id = python_client_id
        self.target_client_id = ""

    def _wrap(self, payload: dict, msg_id: str) -> str:
        content = payload.get("content", {})
        if isinstance(content, (dict, list)):
            content = json.dumps(content, ensure_ascii=False)
        return json.dumps(
            {
                "type": "text",
                "userId": self.user_id,
                "parentId": self.session_id,
                "id": msg_id,
                "senderType": AGENT_TYPE,
                "senderId": self.python_client_id,
                "targetClientId": self.target_client_id,
                "timestamp": _make_ts(),
                "agentType": payload.get("agentType", AGENT_TYPE),
                "content": content,
            },
            ensure_ascii=False,
        )

    async def send(self, payload: dict, msg_id: str) -> None:
        try:
            await self._ws.send(self._wrap(payload, msg_id))
        except Exception as exc:
            logger.warning("WS send failed: %s", exc)

    async def push_typewriter(self, text: str, msg_id: str, *, finished: bool) -> None:
        chunk_size, delay = 8, 0.03
        chunks = [text[i : i + chunk_size] for i in range(0, len(text), chunk_size)] or [""]
        buf = ""
        for index, chunk in enumerate(chunks):
            buf += chunk
            is_last = index == len(chunks) - 1
            data: dict[str, Any] = {"type": "text", "delta": buf, "inprogress": not is_last}
            if is_last and finished:
                data["isFinished"] = True
            await self.send(
                {
                    "id": msg_id,
                    "parentId": self.session_id,
                    "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "stream", "data": data},
                },
                msg_id,
            )
            await asyncio.sleep(delay)

    async def send_status(self, step_index: int, step_status: str, msg_id: str) -> None:
        items = []
        for index, title in enumerate(SESSION_STEPS):
            if index < step_index:
                items.append({"status": "done", "title": title})
            elif index == step_index:
                items.append({"status": step_status, "title": title})
            else:
                items.append({"status": "todo", "title": title})
        await self.send(
            {
                "id": msg_id,
                "parentId": self.session_id,
                "agentType": AGENT_TYPE,
                "content": {
                    "clazz": "agent",
                    "type": "status",
                    "data": {"item": items, "type": "task_status"},
                },
            },
            msg_id,
        )

    async def send_finish(self, msg_id: str, *, md: str = "", name: str = "", error: str | None = None) -> None:
        await self.send(
            {"id": msg_id, "parentId": self.session_id, "agentType": AGENT_TYPE,
             "content": {"clazz": "agent", "type": "text_finish", "data": {}}},
            msg_id,
        )
        data: dict[str, Any] = {"md": md, "pdf": "", "name": name, "isFinished": True}
        if error:
            data["error"] = error
        await self.send(
            {"id": msg_id, "parentId": self.session_id, "agentType": AGENT_TYPE,
             "content": {"clazz": "agent", "type": "finish", "data": data}},
            msg_id,
        )


def _extract_input_text(message: dict) -> str:
    content = message.get("content", {})
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except ValueError:
            pass
    if not isinstance(content, dict):
        return str(content).strip()
    return (
        content.get("data", {}).get("content", "")
        or content.get("content", "")
        or content.get("text", "")
        or ""
    ).strip()


async def _handle_session(
    parent_id: str,
    queue: asyncio.Queue,
    service: ServiceContext,
    messenger: _SessionMessenger,
) -> None:
    while True:
        try:
            message = await asyncio.wait_for(queue.get(), timeout=1800.0)
        except asyncio.TimeoutError:
            logger.warning("session %s idle timeout, closing", parent_id)
            return
        if message is None:
            return
        text = _extract_input_text(message)
        if not text:
            continue
        messenger.target_client_id = str(message.get("senderId", messenger.target_client_id))
        message_id = uuid.uuid4().hex[:12]

        drug, reactions = extract_drug_and_reactions(text)
        if not drug:
            await messenger.push_typewriter(
                "没有识别到药品名。请直接发送如「分析 atorvastatin 的ADR」或"
                "「atorvastatin 的肌痛不良反应」这样的描述。",
                message_id,
                finished=True,
            )
            await messenger.send_finish(message_id, error="无法识别药品名")
            continue

        await messenger.send_status(0, "doing", message_id)

        def on_stage(stage: str, status: str, detail: dict) -> None:
            step = _STAGE_TO_STEP.get(stage)
            if step is None:
                return
            label = STAGE_LABELS_ZH.get(stage, stage)
            coro = (
                messenger.send_status(step, "doing", message_id)
                if status == "started"
                else messenger.send_status(step, "done", message_id)
            )
            asyncio.get_running_loop().create_task(coro)
            logger.info("[session %s] stage %s %s (%s)", parent_id, stage, status, label)

        try:
            pipeline = service.make_pipeline(on_stage=on_stage)
            result = await pipeline.run(drug, reactions, language="zh")
        except SafetyAgentError as exc:
            await messenger.push_typewriter(f"分析未能完成:{exc.message}", message_id, finished=True)
            await messenger.send_finish(message_id, error=exc.message)
            continue
        except Exception as exc:
            logger.error("session %s analysis crashed: %s", parent_id, exc, exc_info=True)
            await messenger.push_typewriter("分析失败(内部错误),请稍后重试。", message_id, finished=True)
            await messenger.send_finish(message_id, error="internal error")
            continue

        markdown = render_markdown(result)
        oss_url = await upload_markdown(
            markdown,
            service.settings,
            user_id=messenger.user_id,
            message_id=message_id,
            agent_type=AGENT_TYPE,
        )
        md_value = oss_url or (
            "data:text/markdown;base64,"
            + base64.b64encode(markdown.encode("utf-8")).decode()
        )
        signal_count = sum(1 for row in result.signals if row.is_signal)
        await messenger.push_typewriter(
            f"分析完成:{result.drug_normalized} 共 {result.overview.total_reports:,} 份 FAERS 报告,"
            f"筛查 {len(result.signals)} 个 PT,其中 {signal_count} 个满足信号判定规则。"
            "完整报告见下方附件。",
            message_id,
            finished=False,
        )
        await messenger.send_status(4, "done", message_id)
        await messenger.send_finish(
            message_id, md=md_value, name=f"药物安全分析_{result.drug_normalized}"
        )
        logger.info("session %s finished, OSS=%s", parent_id, oss_url or "base64-fallback")


async def ws_client_loop(service: ServiceContext) -> None:
    """Reconnect-forever WS client loop (started from the app lifespan)."""
    settings = service.settings
    active_sessions: dict[str, dict] = {}
    max_sessions = settings.max_concurrent_sessions

    while True:
        hb_task = None
        try:
            token = await _get_java_token(service)
            python_client_id = AGENT_TYPE
            logger.info("connecting Java WebSocket: %s", settings.java_ws_url)
            async with websockets.connect(
                settings.java_ws_url,
                # Bypass OS-level proxy settings: the token endpoint is
                # already reached directly (httpx honors env vars only),
                # and websockets would otherwise demand python-socks for
                # the macOS system SOCKS proxy on some dev machines.
                proxy=None,
                ping_interval=15,
                ping_timeout=10,
                close_timeout=5,
            ) as ws:
                await ws.send(
                    json.dumps(
                        {
                            "type": "auth",
                            "token": token,
                            "clientType": AGENT_TYPE,
                            "userId": python_client_id,
                            "agentType": AGENT_TYPE,
                        },
                        ensure_ascii=False,
                    )
                )
                logger.info("WS auth frame sent, waiting for dispatch")

                async def _send_hb() -> None:
                    while True:
                        await asyncio.sleep(15)
                        try:
                            await ws.send(json.dumps({"type": "heartbeat"}))
                        except Exception:
                            break

                hb_task = asyncio.create_task(_send_hb())

                async for raw in ws:
                    try:
                        message = json.loads(raw)
                    except ValueError:
                        continue
                    msg_type = message.get("type")
                    if msg_type == "heartbeat":
                        continue
                    if msg_type == "system":
                        client_id = message.get("clientId") or message.get("pythonClientId")
                        if client_id:
                            python_client_id = client_id
                        content = message.get("content", "")
                        text = content if isinstance(content, str) else str(content)
                        logger.info("Java system message: %s", text[:100])
                        lowered = text.lower()
                        if "认证失败" in text or "无效" in text or "invalid" in lowered or "unauthorized" in lowered:
                            logger.error("Java auth rejected, reconnecting: %s", text)
                            break
                        continue
                    parent_id = message.get("parentId")
                    if not parent_id:
                        continue
                    if parent_id not in active_sessions:
                        if len(active_sessions) >= max_sessions:
                            logger.warning("session cap %d reached, refusing %s", max_sessions, parent_id)
                            continue
                        queue: asyncio.Queue = asyncio.Queue(maxsize=50)
                        messenger = _SessionMessenger(
                            ws,
                            session_id=parent_id,
                            user_id=str(message.get("userId", "")),
                            python_client_id=python_client_id,
                        )
                        messenger.target_client_id = str(message.get("senderId", ""))
                        task = asyncio.create_task(
                            _handle_session(parent_id, queue, service, messenger)
                        )
                        task.add_done_callback(
                            lambda _t, pid=parent_id: active_sessions.pop(pid, None)
                        )
                        active_sessions[parent_id] = {"queue": queue, "task": task}
                        logger.info(
                            "new session %s (active=%d/%d)",
                            parent_id, len(active_sessions), max_sessions,
                        )
                    try:
                        active_sessions[parent_id]["queue"].put_nowait(message)
                    except asyncio.QueueFull:
                        logger.warning("session %s queue full, dropping message", parent_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Java WS connection dropped: %s; reconnecting in 5s", exc)

        if hb_task and not hb_task.done():
            hb_task.cancel()
            try:
                await hb_task
            except asyncio.CancelledError:
                pass
        for session in list(active_sessions.values()):
            session["task"].cancel()
        active_sessions.clear()
        await asyncio.sleep(5)
