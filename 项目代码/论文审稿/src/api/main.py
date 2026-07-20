"""
FastAPI application for Medical Review Service
"""
from fastapi import FastAPI, File, UploadFile, HTTPException, BackgroundTasks, Depends, Form, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from pydantic import BaseModel
from typing import Optional, List, Dict
from datetime import datetime
import uuid
import os
import json
import asyncio
import base64
import tempfile
from pathlib import Path

import aiohttp

from ..main import ReviewOrchestrator
from ..schemas.review_state import ReviewState, JobStatus
from ..schemas.reports import AuthorReport, EditorReport
from ..utils.logging_config import setup_logging, get_logger
from ..utils.oss_uploader import upload_report
from ..utils.job_store import JobStore
from ..services.llm_gateway import ModelTier, set_http_connector
from .metrics import (
    setup_metrics,
    REQUEST_COUNT,
    REQUEST_DURATION,
    JOB_STATUS_COUNTER,
    ACTIVE_JOBS
)

from dotenv import load_dotenv
load_dotenv()

AGENT_TYPE        = "paper-review"
AGENT_TYPE_REVIEW = "paper-review"
JAVA_WS_URL    = os.getenv("JAVA_WS_URL",    "wss://evidence-factory.evimed.com/ws/ws")
JAVA_TOKEN_URL = os.getenv("JAVA_TOKEN_URL", "https://evidence-factory.evimed.com/api-evimed/ai-agent/token?clientType=paper-review")
# JAVA_WS_URL    = os.getenv("JAVA_WS_URL",    "ws://192.168.20.252:2066/ws/ws")
# JAVA_TOKEN_URL = os.getenv("JAVA_TOKEN_URL", "http://192.168.20.252:2066/api-evimed/ai-agent/token?clientType=paper-review")

# ── MongoDB 全局单例连接池 ────────────────────────────────────────────────────
# 复用同一个 AsyncIOMotorClient，避免每次查询重建连接
_mongo_client = None

def _get_mongo_client():
    """返回全局 MongoDB 客户端（懒初始化，带连接池配置）"""
    global _mongo_client
    if _mongo_client is None:
        from motor.motor_asyncio import AsyncIOMotorClient
        mongo_uri = os.getenv("MONGO_URI")
        if not mongo_uri:
            raise RuntimeError("MONGO_URI not configured. Set it in .env or environment variables.")
        _mongo_client = AsyncIOMotorClient(
            mongo_uri,
            serverSelectionTimeoutMS=5000,
            socketTimeoutMS=10000,
            maxPoolSize=20,
            minPoolSize=2,
        )
    return _mongo_client

_java_client_task: asyncio.Task = None
_current_token: str = ""
# 全局 ws_send：由 _java_ws_client 在每次（重）连接成功后更新，
# _handle_session 通过此引用发消息，断线重连后自动使用新连接
_global_ws_send = None

# ==================== 审稿阶段配置 ====================
# 各阶段在前端折叠面板中显示的标题（发送 status doing/done 消息）
_STAGE_PLAN_TITLES: dict = {
    "PARSING":      "文档解析与结构化",
    "REVIEWING":    "内容质量智能审查",
    "SYNTHESIZING": "综合报告生成",
}

# 每个 stage 对应的子步骤 chip 文本列表（在折叠面板内逐步展示）
_STAGE_SUB_STEPS: dict = {
    "PARSING": [
        "正在读取文档结构与章节层级…",
        "正在提取摘要、关键词与作者信息…",
        "正在识别图表、表格与统计数据…",
        "正在解析参考文献列表与引用格式…",
    ],
    "REVIEWING": [
        "方法学审查：评估研究设计与纳排标准合理性…",
        "统计学审查：核验统计方法选择、样本量与效应量报告…",
        "报告规范审查：对照 CONSORT / PRISMA / STROBE 等国际规范…",
        "完整性审查：检查伦理声明、知情同意与利益冲突声明…",
        "临床意义评估：评价研究结论的临床相关性与外推性…",
        "引用规范审查：核查参考文献格式与引用准确性…",
    ],
    "SYNTHESIZING": [
        "正在起草作者修改建议（Author Feedback）…",
        "正在撰写编辑决策报告（Editor Report）…",
        "正在整合多维度审查意见…",
        "正在校验报告内容完整性…",
    ],
}

# Setup logging
setup_logging(log_level="INFO", log_file="logs/api.log", json_format=True)
logger = get_logger(__name__)


# ==================== Java WebSocket 客户端架构 ====================

def _make_ts() -> list:
    now = datetime.now()
    return [now.year, now.month, now.day, now.hour, now.minute, now.second, now.microsecond * 1000]


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
                    token = (data.get("data") or {}).get("token") or data.get("token", "")
                    if token:
                        logger.info(f"获取 Java token 成功 (第{attempt}次尝试)")
                        return token
                    logger.warning(f"获取 Java token 返回空 (第{attempt}次)，5秒后重试...")
        except Exception as e:
            logger.error(f"获取 Java token 失败 (第{attempt}次): {e}，5秒后重试...")
        await asyncio.sleep(5)


async def _download_paper_from_ids(file_ids: list, user_token: str = "") -> tuple:
    """从 MongoDB share_search_file 集合查询文件信息并下载，返回 (tmp_path, filename)"""
    import aiohttp
    from bson import ObjectId

    if not file_ids:
        return "", ""

    file_id = file_ids[0]

    try:
        # 使用全局连接池单例，避免每次查询重建连接
        client = _get_mongo_client()
        db_name = os.getenv("MONGO_DB", "evimed_test")
        db = client[db_name]
        collection = db["share_search_file"]

        # 尝试 ObjectId 格式，否则用字符串
        try:
            query_id = ObjectId(file_id)
        except Exception:
            query_id = file_id

        doc = await collection.find_one({"_id": query_id}, {"url": 1, "fileName": 1, "originalFileName": 1})

        if not doc:
            logger.warning(f"MongoDB 未找到文件记录: id={file_id}")
            return "", ""

        file_url = doc.get("url", "")
        if not file_url:
            logger.warning(f"MongoDB 记录缺少 url 字段: id={file_id}, doc={doc}")
            return "", ""

        # 优先用 originalFileName，再用 fileName
        filename = doc.get("originalFileName") or doc.get("fileName") or f"manuscript_{file_id[:8]}"
        ext = os.path.splitext(filename)[1].lower()
        if ext not in {".pdf", ".docx", ".txt"}:
            filename = filename + ".pdf"

        logger.info(f"从 MongoDB 获取文件: id={file_id}, url={file_url}, filename={filename}")

        # 下载文件
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60)) as s:
            async with s.get(file_url) as resp:
                if resp.status != 200:
                    logger.error(f"文件下载失败: status={resp.status}, url={file_url}")
                    return "", ""
                file_content = await resp.read()
                content_type = resp.headers.get("Content-Type", "").lower()

        # 根据 Content-Type 修正扩展名
        if ext not in {".pdf", ".docx", ".txt"}:
            ct_map = {
                "application/pdf": ".pdf",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
                "text/plain": ".txt",
            }
            ext = next((v for k, v in ct_map.items() if k in content_type), ".pdf")
            filename = os.path.splitext(filename)[0] + ext

        tmp_path = os.path.join(tempfile.gettempdir(), f"review_{file_id[:8]}_{filename}")
        with open(tmp_path, "wb") as f:
            f.write(file_content)

        logger.info(f"文件已保存至临时路径: {tmp_path}")
        return tmp_path, filename

    except Exception as e:
        logger.error(f"_download_paper_from_ids 失败: {e}", exc_info=True)
        return "", ""



async def _handle_session(
    parent_id: str,
    msg_queue: asyncio.Queue,
    python_client_id: str,
    first_sender_id: str,
    user_id: str,
    ws_send=None,
):
    session_id = parent_id
    current_target = first_sender_id
    session_ctx: dict = {"last_report": "", "last_filename": ""}

    def _wrap(payload: dict) -> str:
        content = payload.get("content", "")
        if isinstance(content, dict):
            content = json.dumps(content, ensure_ascii=False)
        return json.dumps({
            "type": "text",
            "userId": user_id,
            "parentId": payload.get("parentId", session_id),
            "id": payload.get("id", str(uuid.uuid4())),
            "senderType": AGENT_TYPE,
            "senderId": python_client_id,
            "targetClientId": current_target,
            "timestamp": _make_ts(),
            "agentType": AGENT_TYPE,
            "content": content,
        }, ensure_ascii=False)

    async def send_msg(payload: dict):
        # 优先使用会话创建时捕获的 ws_send 闭包（与 meta/MR 服务一致）
        # 若会话无 ws_send（兼容旧调用方式），则回退到全局引用
        sender = ws_send or _global_ws_send
        if sender is not None:
            try:
                await sender(_wrap(payload))
                return
            except Exception as se:
                logger.warning(f"发送消息失败: {se}")
        else:
            logger.warning(f"send_msg: WS 不可用，丢弃消息 parentId={session_id}")

    try:
        while True:
            user_msg = await msg_queue.get()
            if user_msg is None:
                break

            current_target = user_msg.get("senderId", first_sender_id)
            # 从消息中提取用户 token（优先于 agent token 用于文件接口）
            msg_user_token = user_msg.get("token", "") or user_msg.get("userToken", "")
            logger.info(f"收到消息字段: {list(user_msg.keys())}, user_token={'有' if msg_user_token else '无'}")
            content_raw = user_msg.get("content", "")
            file_ids = []
            try:
                content_obj = json.loads(content_raw) if isinstance(content_raw, str) else content_raw
                input_text = content_obj.get("content", content_obj.get("text", "")) or ""
                if isinstance(content_obj, dict):
                    file_ids = content_obj.get("fileIds", []) or []
            except Exception:
                input_text = ""

            if not input_text and not file_ids:
                continue

            message_id = str(uuid.uuid4())

            if not file_ids:
                # 有文字无文件：流式智能回复（若有审稿上下文则基于报告回答追问）；无文字无文件：引导上传
                if input_text and input_text.strip():
                    await _stream_reply_no_file(
                        input_text.strip(), send_msg, message_id, session_id,
                        report_context=session_ctx["last_report"],
                        context_filename=session_ctx["last_filename"],
                    )
                else:
                    await send_msg({
                        "id": message_id, "parentId": session_id,
                        "content": {
                            "clazz": "agent", "type": "stream",
                            "data": {"type": "text", "delta": "您好！请上传稿件文件（PDF 格式）以开始论文智能预审。", "isFinished": True},
                        },
                    })
                await send_msg({
                    "id": message_id, "parentId": session_id,
                    "content": {"clazz": "agent", "type": "text_finish", "data": {}},
                })
                continue

            # 下载论文文件
            await send_msg({
                "id": message_id, "parentId": session_id,
                "content": {
                    "clazz": "agent", "type": "stream",
                    "data": {"type": "text", "delta": "正在获取稿件文件，请稍候…\n\n"},
                },
            })

            tmp_path, file_name = await _download_paper_from_ids(file_ids, user_token=msg_user_token)
            if not tmp_path:
                await send_msg({
                    "id": message_id, "parentId": session_id,
                    "content": {
                        "clazz": "agent", "type": "stream",
                        "data": {"type": "text", "delta": "⚠️ 稿件文件获取失败，请重试。", "isFinished": True},
                    },
                })
                await send_msg({
                    "id": message_id, "parentId": session_id,
                    "content": {"clazz": "agent", "type": "text_finish", "data": {}},
                })
                continue

            try:
                import httpx

                await send_msg({
                    "id": message_id, "parentId": session_id,
                    "content": {
                        "clazz": "agent", "type": "stream",
                        "data": {"type": "text", "delta": f"已接收稿件「{file_name}」，正在启动PRA审稿流程…\n\n"},
                    },
                })

                # 提交审稿任务
                with open(tmp_path, "rb") as f:
                    async with httpx.AsyncClient(timeout=30.0) as client:
                        submit_resp = await client.post(
                            "http://localhost:6009/api/v1/review/submit",
                            files={"file": (file_name, f, "application/octet-stream")},
                            data={"use_ocr": "false", "is_review_article": "true"},
                        )
                job_data = submit_resp.json()
                job_id_review = job_data.get("job_id", "")

                # 发送任务计划（orchestra），前端渲染折叠面板标题列表
                await send_msg({
                    "id": message_id, "parentId": session_id,
                    "content": {
                        "clazz": "agent", "type": "orchestra",
                        "data": {
                            "type": "plan",
                            "item": {"todo": list(_STAGE_PLAN_TITLES.values())},
                        },
                    },
                })

                # 所有阶段的当前状态，每条 status 消息包含全部阶段，保证前端进度条准确
                stage_statuses: dict = {s: "todo" for s in _STAGE_PLAN_TITLES}

                def _build_status_items_h() -> list:
                    return [
                        {"status": stage_statuses.get(s, "todo"), "title": _STAGE_PLAN_TITLES[s]}
                        for s in ["PARSING", "REVIEWING", "SYNTHESIZING"]
                    ]

                async def _open_stage_h(stage: str):
                    """打开一个折叠阶段（doing）"""
                    stage_statuses[stage] = "doing"
                    await send_msg({
                        "id": message_id, "parentId": session_id,
                        "content": {"clazz": "agent", "type": "status", "data": {"item": _build_status_items_h()}},
                    })

                async def _close_stage_h(stage: str):
                    """关闭一个折叠阶段（done）"""
                    stage_statuses[stage] = "done"
                    await send_msg({
                        "id": message_id, "parentId": session_id,
                        "content": {"clazz": "agent", "type": "status", "data": {"item": _build_status_items_h()}},
                    })

                async def _send_substep_h(text: str):
                    await send_msg({
                        "id": message_id, "parentId": session_id,
                        "content": {
                            "clazz": "agent", "type": "raw",
                            "data": {"type": "tool_call", "front_display": text, "inprogress": True},
                        },
                    })

                # 预构建所有阶段子步骤的线性队列：每次轮询推进一步，
                # PARSING 子步骤走完后立即自动进入 REVIEWING，最终卡在 SYNTHESIZING 等待报告
                _all_display_steps: list = [
                    (stage, txt)
                    for stage in ["PARSING", "REVIEWING", "SYNTHESIZING"]
                    for txt in _STAGE_SUB_STEPS.get(stage, [])
                ]
                display_step_idx = 0  # 当前展示进度（线性队列索引）
                display_stage = ""    # 当前 UI 中已打开的折叠阶段

                for _ in range(400):  # 最多等待 20 分钟（400 × 3s）
                    await asyncio.sleep(3)
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        status_resp = await client.get(f"http://localhost:6009/api/v1/review/{job_id_review}/status")
                    status_data = status_resp.json()
                    current_status = status_data.get("status", "PENDING")

                    if current_status == "FAILED":
                        if display_stage in _STAGE_PLAN_TITLES:
                            await _close_stage_h(display_stage)
                        await send_msg({
                            "id": message_id, "parentId": session_id,
                            "content": {
                                "clazz": "agent", "type": "stream",
                                "data": {"type": "text", "delta": "⚠️ 审稿任务执行失败，请检查文件格式后重试", "isFinished": True},
                            },
                        })
                        await send_msg({
                            "id": message_id, "parentId": session_id,
                            "content": {"clazz": "agent", "type": "text_finish", "data": {}},
                        })
                        break

                    if current_status == "COMPLETED":
                        # 将剩余子步骤以 0.7s 间隔快速播放完，再关闭最后阶段
                        while display_step_idx < len(_all_display_steps):
                            _s, _txt = _all_display_steps[display_step_idx]
                            if _s != display_stage:
                                if display_stage in _STAGE_PLAN_TITLES:
                                    await _close_stage_h(display_stage)
                                display_stage = _s
                                await _open_stage_h(display_stage)
                            await _send_substep_h(_txt)
                            display_step_idx += 1
                            await asyncio.sleep(0.7)
                        if display_stage in _STAGE_PLAN_TITLES:
                            await _close_stage_h(display_stage)

                        async with httpx.AsyncClient(timeout=30.0) as client:
                            author_resp = await client.get(f"http://localhost:6009/api/v1/review/{job_id_review}/report/author")

                        if author_resp.status_code != 200:
                            logger.error(f"获取报告失败: status={author_resp.status_code}, body={author_resp.text[:200]}", job_id=job_id_review)
                            raise RuntimeError(f"报告获取失败(HTTP {author_resp.status_code}): {author_resp.text[:200]}")

                        full_report = author_resp.json().get("content", "")
                        if not full_report:
                            logger.error(f"报告内容为空: job_id={job_id_review}")
                            raise RuntimeError("报告内容为空，请重试")

                        # 保存报告上下文，供后续追问使用
                        session_ctx["last_report"] = full_report
                        session_ctx["last_filename"] = file_name

                        await send_msg({
                            "id": message_id, "parentId": session_id,
                            "content": {
                                "clazz": "agent", "type": "stream",
                                "data": {"type": "text", "delta": "✅ 审稿完成！报告已生成。"},
                            },
                        })
                        await send_msg({
                            "id": message_id, "parentId": session_id,
                            "content": {"clazz": "agent", "type": "text_finish", "data": {}},
                        })
                        oss_url = await upload_report(
                            content=full_report,
                            user_id=user_id,
                            message_id=message_id,
                            agent_type="paper-review",
                        )
                        md_value = oss_url if oss_url else (
                            "data:text/markdown;base64," + base64.b64encode(full_report.encode()).decode()
                        )
                        await send_msg({
                            "id": message_id, "parentId": session_id,
                            "content": {
                                "clazz": "agent", "type": "finish",
                                "data": {"md": md_value, "pdf": "", "name": f"预审报告_{file_name}", "isFinished": True},
                            },
                        })
                        break

                    # 后端仍在运行：每次轮询推进一个子步骤（与后端当前 stage 无关）
                    if display_step_idx < len(_all_display_steps):
                        _s, _txt = _all_display_steps[display_step_idx]
                        if _s != display_stage:
                            if display_stage in _STAGE_PLAN_TITLES:
                                await _close_stage_h(display_stage)
                            display_stage = _s
                            await _open_stage_h(display_stage)
                        await _send_substep_h(_txt)
                        display_step_idx += 1
                    # 所有子步骤已全部展示完，SYNTHESIZING 保持 doing 状态等待后端完成

                # 清理临时文件
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass

            except Exception as e:
                logger.error(f"论文预审会话处理失败: {e}", exc_info=True)
                await send_msg({
                    "id": message_id, "parentId": session_id,
                    "content": {
                        "clazz": "agent", "type": "stream",
                        "data": {"type": "text", "delta": f"⚠️ 处理错误：{str(e)}", "isFinished": True},
                    },
                })
                await send_msg({
                    "id": message_id, "parentId": session_id,
                    "content": {"clazz": "agent", "type": "text_finish", "data": {}},
                })

    except Exception as e:
        logger.error(f"会话 {parent_id} 异常退出: {e}")


async def _java_ws_client():
    import websockets
    global _global_ws_send
    active_sessions: Dict[str, dict] = {}

    while True:
        _hb_task = None
        try:
            token = await _get_java_token()
            global _current_token
            _current_token = token
            python_client_id = "paper-review"

            logger.info(f"正在连接 Java WebSocket: {JAVA_WS_URL}")
            async with websockets.connect(JAVA_WS_URL, ping_interval=15, ping_timeout=10, close_timeout=5) as ws:
                await ws.send(json.dumps({
                    "type": "auth", "token": token,
                    "clientType": "paper-review",
                    "userId": python_client_id, "agentType": AGENT_TYPE,
                }, ensure_ascii=False))
                logger.info("已发送 auth 消息")

                async def ws_send(data: str):
                    await ws.send(data)

                # 更新全局引用，已有任务可通过 _global_ws_send 使用新连接
                _global_ws_send = ws_send

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
                        content = msg.get('content', '')
                        if not isinstance(content, str):
                            content = str(content) if content else ''
                        logger.info(f"Java 系统消息: {content}")
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
                        q: asyncio.Queue = asyncio.Queue()
                        t = asyncio.create_task(
                            _handle_session(parent_id, q, python_client_id, sender_id, uid, ws_send)
                        )
                        t.add_done_callback(lambda _, pid=parent_id: active_sessions.pop(pid, None))
                        active_sessions[parent_id] = {"queue": q, "task": t}
                        logger.info(f"新会话: parentId={parent_id}, sender={sender_id}")

                    await active_sessions[parent_id]["queue"].put(msg)

        except Exception as e:
            logger.warning(f"Java WS 连接断开: {e}，5 秒后重连...")

        # 清理心跳任务
        if _hb_task and not _hb_task.done():
            _hb_task.cancel()
            try:
                await _hb_task
            except asyncio.CancelledError:
                pass

        # 断连时置空全局 ws_send，但不取消正在执行审稿的任务
        # 任务中的 send_msg 会在重连后通过 _global_ws_send 继续发送
        _global_ws_send = None
        # 仅清理已完成的会话，保留仍在运行的任务
        finished = [pid for pid, sess in active_sessions.items() if sess.get("task", None) and sess["task"].done()]
        for pid in finished:
            active_sessions.pop(pid, None)
        await asyncio.sleep(5)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── 1. 环境变量 fail-fast 验证 ──────────────────────────────────────────
    llm_key = os.getenv("DEEPSEEK_API_KEY")
    if not llm_key:
        raise RuntimeError("LLM API key not configured. Set DEEPSEEK_API_KEY in environment.")

    # ── 2. 全局 HTTP 连接池，注入 LLM Gateway ───────────────────────────────
    connector = aiohttp.TCPConnector(
        limit=int(os.getenv("HTTP_POOL_SIZE", "100")),
        limit_per_host=int(os.getenv("HTTP_POOL_PER_HOST", "30")),
        ttl_dns_cache=600,
        use_dns_cache=True,
    )
    set_http_connector(connector)

    # ── 3. JobStore 连接（Redis 或内存 fallback）───────────────────────────
    await job_store.connect()

    # ── 4. 启动 Java WS 客户端 ─────────────────────────────────────────────
    global _java_client_task
    _java_client_task = asyncio.create_task(_java_ws_client())

    # ── 5. 定期清理超过24小时的临时文件 ────────────────────────────────────
    async def _periodic_temp_cleanup():
        import shutil, time
        while True:
            try:
                await asyncio.sleep(3600)  # 每小时扫描一次
                base = Path(tempfile.gettempdir()) / "medical_review"
                if base.exists():
                    now = time.time()
                    cleaned = 0
                    for d in base.iterdir():
                        if d.is_dir() and now - d.stat().st_mtime > 86400:
                            shutil.rmtree(d, ignore_errors=True)
                            cleaned += 1
                    if cleaned:
                        logger.info(f"定期清理：删除 {cleaned} 个超时临时目录")
                job_store.cleanup_memory()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning(f"定期临时文件清理异常: {exc}")

    _cleanup_task = asyncio.create_task(_periodic_temp_cleanup())

    yield

    # ── 关闭 ────────────────────────────────────────────────────────────────
    _cleanup_task.cancel()
    if _java_client_task:
        _java_client_task.cancel()
        try:
            await _java_client_task
        except asyncio.CancelledError:
            pass
    await connector.close()
    await job_store.close()
    if _mongo_client:
        _mongo_client.close()


# Create FastAPI app
app = FastAPI(
    title="Medical SCI Paper Review API",
    description="AI-powered automated pre-review system for medical manuscripts",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Setup Prometheus metrics
setup_metrics(app)

# Include V2 router
from .review_v2 import router as review_v2_router
app.include_router(review_v2_router)

# Job storage — Redis-backed with in-memory fallback (see src/utils/job_store.py)
job_store = JobStore()

# ──────────────────────────────────────────────────────────────────────────────
# 审稿任务并发限制：同时执行的 review 不超过此数，超出则在后台排队等待
# MAX_CONCURRENT_REVIEWS 可通过环境变量调整，默认 5
# ──────────────────────────────────────────────────────────────────────────────
_REVIEW_SEMAPHORE = asyncio.Semaphore(int(os.getenv("MAX_CONCURRENT_REVIEWS", "5")))

# Initialize orchestrator
orchestrator = None


def get_orchestrator() -> ReviewOrchestrator:
    """Get or create review orchestrator"""
    global orchestrator
    if orchestrator is None:
        # Read API key from environment
        api_key = os.getenv("DEEPSEEK_API_KEY")
        provider = "deepseek"
        orchestrator = ReviewOrchestrator(
            llm_api_key=api_key,
            llm_provider=provider,
            use_pra_architecture=True  # Enable Plan-Retrieve-Argue
        )
    return orchestrator


_REVIEW_ASSISTANT_SYSTEM = """你是一名专业的医学论文智能预审助手，具备以下能力：
- 熟悉国际医学报告规范（CONSORT、PRISMA、STROBE、TRIPOD-AI、STARD 等11项标准）
- 能解答论文写作、投稿、统计方法、伦理声明等相关问题
- 能指导用户准备稿件以通过预审

当用户没有上传文件时，请根据其问题给出专业、有深度的回答。
若用户的意图是进行论文审稿，则在回答末尾友好地引导其上传稿件文件（PDF 格式）。
回答用中文，语气专业友好。"""

_REVIEW_CONTEXT_SYSTEM = """你是一名资深的医学论文预审专家。用户已完成一份稿件的审稿，以下是本次审稿的完整报告：

{report_context}

请基于上述审稿报告回答用户的追问。

要求：
- 具体引用报告中的相关审稿意见、评分、具体问题描述
- 如报告中无相关信息，明确告知并给出你的专业建议
- 绝不编造审稿意见
- 语气专业友好，用中文回答，使用 Markdown 格式"""


async def _stream_reply_no_file(
    user_text: str,
    send_msg,
    message_id: str,
    session_id: str,
    report_context: str = "",
    context_filename: str = "",
):
    """当用户未上传文件时，流式推送 LLM 回复；传入 report_context 时基于报告上下文回答追问"""
    orch = get_orchestrator()
    if report_context:
        context_note = f"（稿件：{context_filename}）" if context_filename else ""
        system_content = _REVIEW_CONTEXT_SYSTEM.format(
            report_context=report_context
        ) + context_note
        messages = [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_text},
        ]
    else:
        messages = [
            {"role": "system", "content": _REVIEW_ASSISTANT_SYSTEM},
            {"role": "user", "content": user_text},
        ]
    try:
        accumulated = ""
        model_tier = ModelTier.ADVANCED if report_context else ModelTier.FAST
        async for chunk in orch.llm_gateway.stream_text(messages, model_tier=model_tier):
            accumulated += chunk
            await send_msg({
                "senderType": "backend",
                "id": message_id,
                "parentId": session_id,
                "agentType": AGENT_TYPE_REVIEW,
                "content": {
                    "type": "stream",
                    "data": {"type": "text", "delta": accumulated},
                },
            })
        # 流式结束，发送 isFinished
        await send_msg({
            "senderType": "backend",
            "id": message_id,
            "parentId": session_id,
            "agentType": AGENT_TYPE_REVIEW,
            "content": {
                "type": "stream",
                "data": {"type": "text", "delta": accumulated, "isFinished": True},
            },
        })
    except Exception as e:
        logger.warning(f"流式智能回复失败，降级为默认提示: {e}")
        fallback = "您好！如需进行论文智能预审，请上传稿件文件（PDF 格式），我将为您启动全面的 PRA 审稿流程。"
        await send_msg({
            "senderType": "backend",
            "id": message_id,
            "parentId": session_id,
            "agentType": AGENT_TYPE_REVIEW,
            "content": {
                "type": "stream",
                "data": {"type": "text", "delta": fallback, "isFinished": True},
            },
        })


# Request/Response models
class JobSubmitResponse(BaseModel):
    """Response for job submission"""
    job_id: str
    status: str
    message: str


class JobStatusResponse(BaseModel):
    """Response for job status check"""
    job_id: str
    status: str
    progress_percentage: float
    created_at: str
    updated_at: str
    error_count: int


class HealthResponse(BaseModel):
    """Health check response"""
    status: str
    version: str
    service: str


# Endpoints
@app.get("/", response_model=HealthResponse)
async def root():
    """Root endpoint - health check"""
    return HealthResponse(
        status="healthy",
        version="1.0.0",
        service="Medical Review API"
    )


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint"""
    REQUEST_COUNT.labels(method="GET", endpoint="/health", status="200").inc()
    return HealthResponse(
        status="healthy",
        version="1.0.0",
        service="Medical Review API"
    )


@app.post("/api/v1/review/submit", response_model=JobSubmitResponse)
async def submit_review(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    use_ocr: bool = Form(False),
    is_review_article: bool = Form(True)
):
    """
    Submit a manuscript for automated review.

    Args:
        file: Manuscript file (.pdf, .docx, .txt)
        use_ocr: Enable OCR for scanned PDFs
        is_review_article: Whether the manuscript is a review article (systematic review, meta-analysis, etc.)
                          If False, PRISMA checklist will not be used and original text parsing will be skipped in reports

    Returns:
        Job submission response with job_id
    """
    # Convert string boolean values to actual boolean (FastAPI Form handling)
    if isinstance(is_review_article, str):
        is_review_article = is_review_article.lower() in ('true', '1', 'yes')
    if isinstance(use_ocr, str):
        use_ocr = use_ocr.lower() in ('true', '1', 'yes')

    logger.debug(f"Received is_review_article={is_review_article}, use_ocr={use_ocr}")
    REQUEST_COUNT.labels(method="POST", endpoint="/api/v1/review/submit", status="202").inc()

    # Validate file format
    allowed_formats = ['.pdf', '.docx', '.txt']
    file_ext = Path(file.filename).suffix.lower()

    if file_ext not in allowed_formats:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format: {file_ext}. Allowed: {', '.join(allowed_formats)}"
        )

    # Generate job ID
    job_id = str(uuid.uuid4())

    # Save uploaded file to temp location
    temp_dir = Path(tempfile.gettempdir()) / "medical_review" / job_id
    temp_dir.mkdir(parents=True, exist_ok=True)
    file_path = temp_dir / file.filename

    try:
        # Save file
        content = await file.read()
        with open(file_path, "wb") as f:
            f.write(content)

        # Create initial job state
        job_state = ReviewState(
            job_id=job_id,
            manuscript_path=str(file_path),
            status=JobStatus.PENDING,
            is_review_article=is_review_article
        )
        await job_store.set(job_id, job_state)

        # Schedule background task
        background_tasks.add_task(
            process_review_job,
            job_id=job_id,
            file_path=str(file_path),
            use_ocr=use_ocr,
            is_review_article=is_review_article
        )

        ACTIVE_JOBS.inc()
        JOB_STATUS_COUNTER.labels(status="submitted").inc()

        # logger.info(f"Job {job_id} submitted for review", job_id=job_id, filename=file.filename)
        logger.info(
            "Job submitted for review",
            job_id=job_id,
            file_name=file.filename
        )

        return JobSubmitResponse(
            job_id=job_id,
            status="accepted",
            message="Manuscript submitted successfully. Check job status with job_id."
        )

    except Exception as e:
        logger.error(f"Failed to submit job {job_id}", job_id=job_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to process upload: {str(e)}")


@app.get("/api/v1/review/{job_id}/status", response_model=JobStatusResponse)
async def get_job_status(job_id: str):
    """
    Get status of a review job.

    Args:
        job_id: Job identifier

    Returns:
        Current job status and progress
    """
    REQUEST_COUNT.labels(method="GET", endpoint="/api/v1/review/status", status="200").inc()

    if not await job_store.exists(job_id):
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

    job_state = await job_store.get(job_id)

    return JobStatusResponse(
        job_id=job_id,
        status=job_state.status.value,
        progress_percentage=job_state.progress_percentage,
        created_at=job_state.created_at.isoformat(),
        updated_at=job_state.updated_at.isoformat(),
        error_count=len(job_state.error_log)
    )


@app.get("/api/v1/review/{job_id}/report/author")
async def get_author_report(job_id: str):
    """
    Get review report for completed review.
    """
    REQUEST_COUNT.labels(method="GET", endpoint="/api/v1/review/report/author", status="200").inc()

    if not await job_store.exists(job_id):
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

    job_state = await job_store.get(job_id)

    if job_state.status != JobStatus.COMPLETED:
        raise HTTPException(status_code=400, detail=f"Job not completed. Current status: {job_state.status.value}")

    report = job_state.final_reports.get("report")
    if not report:
        raise HTTPException(status_code=404, detail="Report not available")

    return {
        "job_id": job_id,
        "report_type": "review",
        "content": report,
        "generated_at": job_state.updated_at.isoformat()
    }


@app.get("/api/v1/review/{job_id}/report/editor")
async def get_editor_report(job_id: str):
    """
    Get review report (same as author report, kept for compatibility).
    """
    REQUEST_COUNT.labels(method="GET", endpoint="/api/v1/review/report/editor", status="200").inc()

    if not await job_store.exists(job_id):
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

    job_state = await job_store.get(job_id)

    if job_state.status != JobStatus.COMPLETED:
        raise HTTPException(status_code=400, detail=f"Job not completed. Current status: {job_state.status.value}")

    report = job_state.final_reports.get("report")
    if not report:
        raise HTTPException(status_code=404, detail="Report not available")

    return {
        "job_id": job_id,
        "report_type": "review",
        "content": report,
        "generated_at": job_state.updated_at.isoformat()
    }


@app.get("/api/v1/checklists")
async def list_checklists():
    """
    List all available checklists.

    Returns:
        List of available checklists with metadata
    """
    REQUEST_COUNT.labels(method="GET", endpoint="/api/v1/checklists", status="200").inc()

    from ..utils.rubric_loader import RubricLoader

    loader = RubricLoader()
    rubrics = loader.list_available_rubrics()

    checklist_info = []
    for rubric_name in rubrics:
        try:
            metadata = loader.get_rubric_metadata(rubric_name)
            checklist_info.append({
                "id": rubric_name,
                "name": metadata["name"],
                "version": metadata["version"],
                "applicable_to": metadata["applicable_to"],
                "description": metadata["description"],
                "item_count": metadata["item_count"]
            })
        except Exception as e:
            logger.error(f"Failed to load metadata for {rubric_name}", error=str(e))

    return {
        "total": len(checklist_info),
        "checklists": checklist_info
    }


@app.delete("/api/v1/review/{job_id}")
async def delete_job(job_id: str):
    """
    Delete a review job and associated data.

    Args:
        job_id: Job identifier

    Returns:
        Deletion confirmation
    """
    REQUEST_COUNT.labels(method="DELETE", endpoint="/api/v1/review", status="200").inc()

    if not await job_store.exists(job_id):
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

    # Clean up temp files（带重试）
    job_state = await job_store.get(job_id)
    import shutil
    for attempt in range(3):
        try:
            temp_dir = Path(job_state.manuscript_path).parent
            if temp_dir.exists():
                shutil.rmtree(temp_dir)
            break
        except Exception as e:
            if attempt == 2:
                logger.warning(f"Failed to clean up temp files for job {job_id} after 3 attempts", error=str(e))

    # Remove from store
    await job_store.delete(job_id)

    ACTIVE_JOBS.dec()

    return {
        "job_id": job_id,
        "status": "deleted",
        "message": "Job deleted successfully"
    }


# Background task
async def process_review_job(job_id: str, file_path: str, use_ocr: bool = False, is_review_article: bool = True):
    """
    Background task to process review job.
    使用 V2 多规范并行架构
    """
    async with _REVIEW_SEMAPHORE:
        logger.info(f"Starting review processing for job {job_id}", job_id=job_id)

        try:
            # 使用 V2 架构
            from ..main_v2 import ReviewOrchestratorV2
            from ..services.document_parser import DocumentParser
            orch_v2 = ReviewOrchestratorV2()

            await job_store.update_status(job_id, JobStatus.PARSING)

            # 调用 V2 审稿
            result = await orch_v2.review_manuscript(
                manuscript_path=file_path,
                job_id=job_id,
                is_review_article=is_review_article
            )

            r = result.narrative_report
            m = result.meta_review

            # 提取上传的文件名
            from pathlib import Path
            uploaded_filename = Path(file_path).name

            # 各字段居底处理，防止空内容输出
            import re as _re

            def _strip_minor_section(text: str) -> tuple:
                """从 critical_issues 中剥离 LLM 越界写入的次要建议段落，返回 (主体, 次要) 两部分"""
                if not text:
                    return text, ""
                # 先规范化换行符
                text = text.replace('\\n', '\n').replace('\\r', '')
                # 宽松匹配：遇到任何形式的"次要建议"标题就截断
                pattern = r'\n+(?:#{1,3}\s*次要建议|\*{1,2}次要建议\*{1,2}|次要建议[:：]).*'
                m_sec = _re.search(pattern, text, flags=_re.DOTALL)
                if m_sec:
                    main_part  = text[:m_sec.start()].strip()
                    minor_raw  = text[m_sec.start():].strip()
                    # 去掉标题行本身
                    minor_part = _re.sub(r'^(?:#{1,3}\s*次要建议|\*{1,2}次要建议\*{1,2}|次要建议[:：])\s*', '',
                                         minor_raw, flags=_re.MULTILINE).strip()
                    return main_part, minor_part
                return text, ""

            def _clean_tags(text: str) -> str:
                """过滤内部规范标签"""
                if not text:
                    return text
                for pat in [r'[a-zA-Z0-9_]+_rubric:[A-Z0-9_]+', r'URVAR_[A-Z0-9_]+',
                            r'PRISMA_[A-Z0-9_]+', r'CONSORT_[A-Z0-9_]+',
                            r'STROBE_[A-Z0-9_]+', r'TRIPOD_[A-Z0-9_]+']:
                    text = _re.sub(pat, '', text)
                text = _re.sub(r'\(\s*\)', '', text)
                text = _re.sub(r'  +', ' ', text)
                # 清除 JSON 字符串转义残留的引号/逗号碎片
                text = _re.sub(r'"\s*,\s*"', '\n\n', text)
                text = _re.sub(r'(?m)^\s*"\s*,?\s*$', '', text)
                text = _re.sub(r'(?m)^(\s*)"(\d+[、.．])', r'\1\2', text)
                text = _re.sub(r'\n{3,}', '\n\n', text)
                return text.strip()

            raw_critical = r.critical_issues_narrative or "修改意见待生成，建议人工复核。"
            raw_minor    = r.minor_suggestions_narrative or ""
            logger.debug(f"raw_critical长度={len(raw_critical)}, raw_minor长度={len(raw_minor)}, raw_critical末200字={repr(raw_critical[-200:]) if len(raw_critical) > 200 else repr(raw_critical)}")

            # 剥离 LLM 越界写入的次要建议
            main_critical, extracted_minor = _strip_minor_section(raw_critical)

            # 合并次要建议到修改意见末尾（如有实质内容）
            combined_minor = (extracted_minor + "\n\n" + raw_minor).strip() if raw_minor else extracted_minor
            if combined_minor and len(combined_minor) > 20:
                # 找当前最大编号
                nums = _re.findall(r'(?:^|\n)\s*(\d+)\.', main_critical)
                next_num = (max(int(n) for n in nums) + 1) if nums else (len(main_critical.split('\n\n')) + 1)
                main_critical = main_critical.rstrip() + f"\n\n{next_num}. {combined_minor}"

            overall_eval      = _clean_tags(r.overall_evaluation or "总体评价待生成，建议人工复核。")
            _ci_raw           = _clean_tags(main_critical)
            recommendation_n  = _clean_tags(r.recommendation_narrative or "推荐意见待生成，建议人工复核。")
            recommendation    = m.recommendation             or "major_revision"
            rubrics_used      = ', '.join(result.rubrics_used) if result.rubrics_used else "通用规范"

            # 最终兆底清理：无论 LLM 如何输出，一律截断修改意见中的"次要建议"标题及其后内容
            # 同时将其内容追加到修改意见末尾
            _minor_keywords = ['次要建议', 'Minor Issues', 'Minor Suggestions', 'minor issues']
            _ci_final = _ci_raw
            import sys as _sys
            _sys.stderr.write(f"[FINAL_CLEAN] _ci_raw长度={len(_ci_raw)}, 含次要建议={'次要建议' in _ci_raw}\n")
            _sys.stderr.flush()
            for _kw in _minor_keywords:
                _idx = _ci_final.find(_kw)
                _sys.stderr.write(f"[FINAL_CLEAN] 搜索关键词='{_kw}', _idx={_idx}\n")
                _sys.stderr.flush()
                if _idx > 0:
                    # 向前找到标题行开头（## 或 ** 或直接文字）
                    _start = _ci_final.rfind('\n', 0, _idx)
                    _start = max(0, _start)
                    _minor_text = _ci_final[_start:].strip()
                    _ci_final = _ci_final[:_start].strip()
                    # 将次要建议内容清洗后追加到末尾
                    _minor_clean = _re.sub(r'^(?:#{1,3}\s*|\.{0,3}\s*)次要建议\s*', '', _minor_text, flags=_re.MULTILINE).strip()
                    if _minor_clean and len(_minor_clean) > 20:
                        _nums = _re.findall(r'(?:^|\n)\s*(\d+)\.', _ci_final)
                        _next = (max(int(n) for n in _nums) + 1) if _nums else (len(_ci_final.split('\n\n')) + 1)
                        _ci_final = _ci_final + f"\n\n{_next}. {_minor_clean}"
                    break
            critical_issues = _ci_final

            # ── 最终防线：正则审查报告中的幻觉声称 ──
            def _verify_report_claims(report_text: str, fulltext: str) -> tuple:
                """
                正则扫描报告中的常见幻觉声称，与原文比对后移除虚假内容。
                返回 (清洗后报告, 移除的幻觉数)。
                """
                if not fulltext:
                    return report_text, 0

                fulltext_lower = fulltext.lower()
                removed = 0

                # 已确认存在的章节：直接正则检测原文
                confirmed = set()
                _section_checks = {
                    "abstract": ["abstract"],
                    "introduction": ["introduction"],
                    "methods": ["methods", "methodology", "materials and methods"],
                    "results": ["results", "findings"],
                    "discussion": ["discussion"],
                    "conclusion": ["conclusion", "conclusions"],
                    "coi": ["conflict of interest", "competing interest", "利益冲突"],
                    "funding": ["funding", "资助"],
                    "author_contrib": ["author contributions", "作者贡献"],
                    "ethics": ["ethics approval", "ethics committee", "institutional review board", "informed consent", "伦理"],
                    "data_availability": ["data availability", "data sharing", "数据可用"],
                    "acknowledgements": ["acknowledgement", "acknowledgment", "致谢"],
                    "references": ["references", "reference"],
                }
                for _key, _kws in _section_checks.items():
                    for _kw in _kws:
                        if _kw in fulltext_lower:
                            confirmed.add(_key)
                            break

                # 幻觉声称模式：(pattern, 对应的 confirmed key)
                HALLUCINATION_RULES = [
                    # 摘要
                    (r'(?:全文|文章|本文)[^。]*?(?:无摘要|没有摘要|缺少摘要|未提供摘要|摘要缺失|摘要.*?不存在)[^。]*?[。；]',
                     "abstract"),
                    (r'[^。]*?(?:no\s+abstract|abstract\s+is\s+missing|lacks?\s+an?\s+abstract|no\s+structured\s+abstract)[^。]*?[。；\.]',
                     "abstract"),
                    # 引言
                    (r'(?:全文|文章|本文)[^。]*?(?:没有引言|缺少引言|无引言|引言缺失|引言.*?截断|引言.*?不完整)[^。]*?[。；]',
                     "introduction"),
                    (r'[^。]*?(?:no\s+introduction|introduction\s+is\s+missing|lacks?\s+an?\s+introduction|introduction.*?truncated)[^。]*?[。；\.]',
                     "introduction"),
                    # 方法
                    (r'(?:全文|文章|本文)[^。]*?(?:没有方法|缺少方法|无方法|方法部分缺失|未提供方法|方法.*?不存在)[^。]*?[。；]',
                     "methods"),
                    (r'[^。]*?(?:no\s+methods?|methods?\s+section\s+is\s+missing|lacks?\s+a?\s*methods?)[^。]*?[。；\.]',
                     "methods"),
                    # 结果
                    (r'(?:全文|文章|本文)[^。]*?(?:没有结果|缺少结果|无结果|结果部分缺失|未报告结果)[^。]*?[。；]',
                     "results"),
                    (r'[^。]*?(?:no\s+results?|results?\s+section\s+is\s+missing|lacks?\s+results?)[^。]*?[。；\.]',
                     "results"),
                    # 讨论
                    (r'(?:全文|文章|本文)[^。]*?(?:讨论缺失|没有讨论|无讨论|讨论部分缺失|缺少讨论)[^。]*?[。；]',
                     "discussion"),
                    (r'[^。]*?(?:no\s+discussion|discussion\s+(?:section\s+)?is\s+missing|lacks?\s+a?\s*discussion)[^。]*?[。；\.]',
                     "discussion"),
                    # 结论
                    (r'[^。]*?(?:结论.*?(?:未完成|缺失|截断)|没有结论|无结论|结论章节缺失|缺少结论|结论部分缺失)[^。]*?[。；]',
                     "conclusion"),
                    (r'[^。]*?(?:conclusion.*?(?:missing|incomplete|truncated)|no\s+conclusion|lacks?\s+a?\s*conclusion)[^。]*?[。；\.]',
                     "conclusion"),
                    # COI
                    (r'[^。]*?(?:未.*?(?:声明|提供|见).*?利益冲突|没有.*?利益冲突|缺少.*?利益冲突声明|无利益冲突)[^。]*?[。；]',
                     "coi"),
                    (r'[^。]*?(?:no\s+conflict|no\s+competing\s+interest|lacks?\s+conflict)[^。]*?[。；\.]',
                     "coi"),
                    # Funding
                    (r'[^。]*?(?:未.*?(?:声明|提供|见).*?(?:资金|funding)|没有.*?(?:资金|funding)|缺少.*?(?:资金|funding)|无资金|未见.*?funding)[^。]*?[。；]',
                     "funding"),
                    (r'[^。]*?(?:no\s+funding|funding\s+statement\s+is\s+missing|lacks?\s+funding)[^。]*?[。；\.]',
                     "funding"),
                    # Author Contributions
                    (r'[^。]*?(?:未.*?(?:声明|提供|见).*?作者贡献|没有.*?作者贡献|缺少.*?作者贡献|无作者贡献)[^。]*?[。；]',
                     "author_contrib"),
                    (r'[^。]*?(?:no\s+author\s+contribution|lacks?\s+author\s+contribution)[^。]*?[。；\.]',
                     "author_contrib"),
                    # Ethics
                    (r'[^。]*?(?:未.*?(?:获得|提供).*?伦理|没有.*?伦理|缺少.*?伦理|无伦理|伦理.*?缺失)[^。]*?[。；]',
                     "ethics"),
                    (r'[^。]*?(?:no\s+ethics|ethical\s+approval\s+is\s+missing|lacks?\s+ethics)[^。]*?[。；\.]',
                     "ethics"),
                    # Data Availability
                    (r'[^。]*?(?:未.*?数据可用|没有.*?数据.*?声明|缺少.*?数据可用|无数据可用)[^。]*?[。；]',
                     "data_availability"),
                    (r'[^。]*?(?:no\s+data\s+availability|data\s+availability\s+statement\s+is\s+missing)[^。]*?[。；\.]',
                     "data_availability"),
                    # Acknowledgements
                    (r'[^。]*?(?:未.*?致谢|没有.*?致谢|缺少.*?致谢|无致谢)[^。]*?[。；]',
                     "acknowledgements"),
                    (r'[^。]*?(?:no\s+acknowledgement|acknowledgement\s+is\s+missing)[^。]*?[。；\.]',
                     "acknowledgements"),
                    # References
                    (r'(?:全文|文章|本文)[^。]*?(?:没有参考文献|缺少参考文献|无参考文献|参考文献.*?缺失)[^。]*?[。；]',
                     "references"),
                    (r'[^。]*?(?:no\s+references?|references?\s+are?\s+missing|lacks?\s+references?)[^。]*?[。；\.]',
                     "references"),
                ]

                for pattern, section_key in HALLUCINATION_RULES:
                    if section_key not in confirmed:
                        continue  # 原文确实没有，不是幻觉
                    matches = list(_re.finditer(pattern, report_text, _re.IGNORECASE))
                    for m in reversed(matches):  # 从后往前删，避免位置偏移
                        offending = m.group()
                        report_text = report_text[:m.start()] + report_text[m.end():]
                        removed += 1
                        _sys.stderr.write(f"[幻觉审查] 移除虚假声称({section_key}): {offending[:80]}...\n")
                        _sys.stderr.flush()

                # 清理多余空行
                report_text = _re.sub(r'\n{3,}', '\n\n', report_text)
                return report_text.strip(), removed

            # 对三个报告字段逐一审查
            _manuscript_text_for_verify = ""
            try:
                _manuscript_text_for_verify, _ = DocumentParser(use_marker=False).parse(file_path)
            except Exception:
                pass
            if _manuscript_text_for_verify:
                overall_eval, _r1 = _verify_report_claims(overall_eval, _manuscript_text_for_verify)
                critical_issues, _r2 = _verify_report_claims(critical_issues, _manuscript_text_for_verify)
                recommendation_n, _r3 = _verify_report_claims(recommendation_n, _manuscript_text_for_verify)
                _total_removed = _r1 + _r2 + _r3
                if _total_removed > 0:
                    _sys.stderr.write(f"[幻觉审查] 共移除 {_total_removed} 处虚假声称\n")
                    _sys.stderr.flush()
                else:
                    _sys.stderr.write(f"[幻觉审查] 未发现虚假声称\n")
                    _sys.stderr.flush()

            # 统一报告：修改意见包含所有问题（方法学+写作），不再单独设次要建议板块
            report_md = f"""# 审稿报告

**稿件标题**: {uploaded_filename}

## 总体评价

{overall_eval}

## 修改意见

{critical_issues}

## 推荐意见

{recommendation_n}

**推荐决策**: {recommendation}

---
*参考规范: {rubrics_used}*
*处理时间: {result.processing_time:.1f}秒*
"""

            # 取出已存在的 job_state，写入报告内容，更新状态
            review_state = await job_store.get(job_id) or ReviewState(
                job_id=job_id,
                manuscript_path=file_path,
                status=JobStatus.COMPLETED,
                is_review_article=is_review_article
            )
            review_state.status = JobStatus.COMPLETED
            review_state.final_reports["report"] = report_md
            review_state.update_progress()   # 同步更新 updated_at

            await job_store.set(job_id, review_state)

            JOB_STATUS_COUNTER.labels(status="completed").inc()
            logger.info(f"Review completed for job {job_id}", job_id=job_id)

        except Exception as e:
            logger.error(f"Review failed for job {job_id}", job_id=job_id, error=str(e))
            await job_store.update_failed(job_id, f"Review processing failed: {str(e)}")
            JOB_STATUS_COUNTER.labels(status="failed").inc()

        finally:
            ACTIVE_JOBS.dec()
            # 任务结束（成功或失败）后清理临时文件
            try:
                import shutil
                temp_dir = Path(file_path).parent
                if temp_dir.exists() and temp_dir.name != "medical_review":
                    shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception as cleanup_err:
                logger.warning(f"Temp file cleanup error for job {job_id}: {cleanup_err}")


# ==================== WebSocket 端点 (供前端直连) ====================


@app.websocket("/ws")
async def websocket_review_endpoint(websocket: WebSocket):
    """
    WebSocket端点 - 论文智能预审
    前端发送base64编码的文件内容，服务端提交审稿任务并推送进度及最终报告
    """
    await websocket.accept()
    session_id = str(uuid.uuid4())
    python_client_id = f"review-ws-{session_id[:8]}"
    session_ctx: dict = {"last_report": "", "last_filename": ""}

    async def send_msg(payload: dict):
        await websocket.send_text(json.dumps(payload, ensure_ascii=False))

    try:
        # 1. 等待认证消息
        raw_auth = await websocket.receive_text()

        # 2. 回复认证成功 + 创建会话
        await send_msg({
            "type": "system",
            "content": "认证成功",
            "pythonClientId": python_client_id,
            "parentId": session_id,
            "agentType": AGENT_TYPE_REVIEW,
        })

        while True:
            raw_user = await websocket.receive_text()
            user_msg = json.loads(raw_user)

            # 响应心跳
            if user_msg.get("type") == "heartbeat":
                await websocket.send_text(json.dumps({"status": "received"}))
                continue

            content_raw = user_msg.get("content", "")
            try:
                content_obj = json.loads(content_raw) if isinstance(content_raw, str) else content_raw
            except Exception:
                content_obj = {}

            # 提取文件信息（前端通过chat的文件上传功能发送）
            file_info_list = content_obj.get("fileInfo", [])
            # 支持通过文件ID获取文件（文件已上传至外部服务，只携带ID）
            file_ids = content_obj.get("fileIds", []) or []
            # 提取用户token（用于外部服务文件接口鉴权）
            msg_user_token = user_msg.get("token", "") or user_msg.get("userToken", "")
            # 提取用户ID（用于OSS上传路径）
            user_id_ws = user_msg.get("userId", "") or user_msg.get("uid", "")
            text_content = content_obj.get("content", content_obj.get("text", ""))

            # 每次对话生成独立 message_id
            message_id = str(uuid.uuid4())

            # 回显用户消息（触发前端 createModelMessages 创建消息槽）
            await send_msg({
                "senderType": "frontend",
                "id": message_id,
                "parentId": session_id,
                "agentType": AGENT_TYPE_REVIEW,
                "content": content_raw,
            })

            if not file_info_list and not file_ids:
                if text_content and text_content.strip():
                    # 有文字无文件：流式智能回复（若有审稿上下文则基于报告回答追问）
                    await _stream_reply_no_file(
                        text_content.strip(), send_msg, message_id, session_id,
                        report_context=session_ctx["last_report"],
                        context_filename=session_ctx["last_filename"],
                    )
                else:
                    # 既无文件也无文字：引导上传
                    await send_msg({
                        "senderType": "backend",
                        "id": message_id,
                        "parentId": session_id,
                        "agentType": AGENT_TYPE_REVIEW,
                        "content": {
                            "type": "stream",
                            "data": {"type": "text", "delta": "您好！请上传稿件文件（PDF 格式）以开始论文智能预审。", "isFinished": True},
                        },
                    })
                await send_msg({
                    "senderType": "backend",
                    "id": message_id,
                    "parentId": session_id,
                    "agentType": AGENT_TYPE_REVIEW,
                    "content": {"type": "text_finish", "data": {}},
                })
                continue

            try:
                import httpx
                import tempfile

                if file_ids:
                    # 通过文件ID从外部服务获取文件
                    await send_msg({
                        "senderType": "backend",
                        "id": message_id,
                        "parentId": session_id,
                        "agentType": AGENT_TYPE_REVIEW,
                        "content": {
                            "type": "stream",
                            "data": {"type": "text", "delta": "正在获取稿件文件，请稍候…\n\n"},
                        },
                    })
                    tmp_path, file_name = await _download_paper_from_ids(file_ids, user_token=msg_user_token)
                    if not tmp_path:
                        await send_msg({
                            "senderType": "backend",
                            "id": message_id,
                            "parentId": session_id,
                            "agentType": AGENT_TYPE_REVIEW,
                            "content": {
                                "type": "stream",
                                "data": {"type": "text", "delta": "⚠️ 稿件文件获取失败，请确认文件ID有效后重试。", "isFinished": True},
                            },
                        })
                        await send_msg({
                            "senderType": "backend",
                            "id": message_id,
                            "parentId": session_id,
                            "agentType": AGENT_TYPE_REVIEW,
                            "content": {"type": "text_finish", "data": {}},
                        })
                        continue
                else:
                    # 从fileInfo中的URL下载文件
                    file_info = file_info_list[0]
                    file_name = file_info.get("name", "manuscript.pdf")
                    file_url = file_info.get("url", "")

                    # 从URL下载文件（文件已通过前端上传到API服务器）
                    async with httpx.AsyncClient(timeout=60.0) as client:
                        file_resp = await client.get(file_url)
                        file_content = file_resp.content

                    # 保存到临时文件
                    ext = os.path.splitext(file_name)[1].lower() or ".pdf"
                    tmp_path = os.path.join(tempfile.gettempdir(), f"review_{session_id}{ext}")
                    with open(tmp_path, "wb") as f:
                        f.write(file_content)

                # 提交审稿任务（通过本地HTTP接口）
                with open(tmp_path, "rb") as f:
                    async with httpx.AsyncClient(timeout=30.0) as client:
                        submit_resp = await client.post(
                            "http://localhost:6009/api/v1/review/submit",
                            files={"file": (file_name, f, "application/octet-stream")},
                            data={"use_ocr": "false", "is_review_article": "true"},
                        )
                job_data = submit_resp.json()
                job_id = job_data.get("job_id", "")

                # 确认接收稿件
                await send_msg({
                    "senderType": "backend",
                    "id": message_id,
                    "parentId": session_id,
                    "agentType": AGENT_TYPE_REVIEW,
                    "content": {
                        "type": "stream",
                        "data": {"type": "text", "delta": f"已接收稿件「{file_name}」，正在启动PRA审稿流程…\n\n"},
                    },
                })

                # 轮询状态并推送进度
                # 发送任务计划（orchestra），前端渲染折叠面板标题列表
                await send_msg({
                    "senderType": "backend",
                    "id": message_id,
                    "parentId": session_id,
                    "agentType": AGENT_TYPE_REVIEW,
                    "content": {
                        "type": "orchestra",
                        "data": {
                            "type": "plan",
                            "item": {"todo": list(_STAGE_PLAN_TITLES.values())},
                        },
                    },
                })

                # 所有阶段的当前状态，每条 status 消息包含全部阶段，保证前端进度条准确
                stage_statuses: dict = {s: "todo" for s in _STAGE_PLAN_TITLES}

                def _build_status_items_ws() -> list:
                    return [
                        {"status": stage_statuses.get(s, "todo"), "title": _STAGE_PLAN_TITLES[s]}
                        for s in ["PARSING", "REVIEWING", "SYNTHESIZING"]
                    ]

                async def _open_stage_ws(stage: str):
                    stage_statuses[stage] = "doing"
                    await send_msg({
                        "senderType": "backend", "id": message_id, "parentId": session_id,
                        "agentType": AGENT_TYPE_REVIEW,
                        "content": {"type": "status", "data": {"item": _build_status_items_ws()}},
                    })

                async def _close_stage_ws(stage: str):
                    stage_statuses[stage] = "done"
                    await send_msg({
                        "senderType": "backend", "id": message_id, "parentId": session_id,
                        "agentType": AGENT_TYPE_REVIEW,
                        "content": {"type": "status", "data": {"item": _build_status_items_ws()}},
                    })

                async def _send_substep_ws(text: str):
                    await send_msg({
                        "senderType": "backend", "id": message_id, "parentId": session_id,
                        "agentType": AGENT_TYPE_REVIEW,
                        "content": {
                            "type": "raw",
                            "data": {"type": "tool_call", "front_display": text, "inprogress": True},
                        },
                    })

                # 预构建所有阶段子步骤的线性队列：每次轮询推进一步，
                # PARSING 子步骤走完后立即自动进入 REVIEWING，最终卡在 SYNTHESIZING 等待报告
                _all_display_steps: list = [
                    (stage, txt)
                    for stage in ["PARSING", "REVIEWING", "SYNTHESIZING"]
                    for txt in _STAGE_SUB_STEPS.get(stage, [])
                ]
                display_step_idx = 0  # 当前展示进度（线性队列索引）
                display_stage = ""    # 当前 UI 中已打开的折叠阶段

                for _ in range(400):  # 最多等待 20 分钟（400 × 3s）
                    await asyncio.sleep(3)
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        status_resp = await client.get(f"http://localhost:6009/api/v1/review/{job_id}/status")
                    status_data = status_resp.json()
                    current_status = status_data.get("status", "PENDING")

                    if current_status == "FAILED":
                        if display_stage in _STAGE_PLAN_TITLES:
                            await _close_stage_ws(display_stage)
                        await send_msg({
                            "senderType": "backend", "id": message_id, "parentId": session_id,
                            "agentType": AGENT_TYPE_REVIEW,
                            "content": {
                                "type": "stream",
                                "data": {"type": "text", "delta": "⚠️ 审稿任务执行失败，请检查文件格式后重试", "isFinished": True},
                            },
                        })
                        await send_msg({
                            "senderType": "backend", "id": message_id, "parentId": session_id,
                            "agentType": AGENT_TYPE_REVIEW,
                            "content": {"type": "text_finish", "data": {}},
                        })
                        break

                    if current_status == "COMPLETED":
                        # 将剩余子步骤以 0.7s 间隔快速播放完，再关闭最后阶段
                        while display_step_idx < len(_all_display_steps):
                            _s, _txt = _all_display_steps[display_step_idx]
                            if _s != display_stage:
                                if display_stage in _STAGE_PLAN_TITLES:
                                    await _close_stage_ws(display_stage)
                                display_stage = _s
                                await _open_stage_ws(display_stage)
                            await _send_substep_ws(_txt)
                            display_step_idx += 1
                            await asyncio.sleep(0.7)
                        if display_stage in _STAGE_PLAN_TITLES:
                            await _close_stage_ws(display_stage)

                        async with httpx.AsyncClient(timeout=30.0) as client:
                            author_resp = await client.get(f"http://localhost:6009/api/v1/review/{job_id}/report/author")

                        if author_resp.status_code != 200:
                            raise RuntimeError(f"报告获取失败(HTTP {author_resp.status_code}): {author_resp.text[:200]}")

                        full_report = author_resp.json().get("content", "")
                        if not full_report:
                            raise RuntimeError("报告内容为空，请重试")

                        # 保存报告上下文，供后续追问使用
                        session_ctx["last_report"] = full_report
                        session_ctx["last_filename"] = file_name

                        await send_msg({
                            "senderType": "backend", "id": message_id, "parentId": session_id,
                            "agentType": AGENT_TYPE_REVIEW,
                            "content": {
                                "type": "stream",
                                "data": {"type": "text", "delta": "✅ 审稿完成！报告已生成。"},
                            },
                        })
                        await send_msg({
                            "senderType": "backend", "id": message_id, "parentId": session_id,
                            "agentType": AGENT_TYPE_REVIEW,
                            "content": {"type": "text_finish", "data": {}},
                        })
                        oss_url = await upload_report(
                            content=full_report,
                            user_id=user_id_ws,
                            message_id=message_id,
                            agent_type="paper-review",
                        )
                        md_value = oss_url if oss_url else (
                            "data:text/markdown;base64," + base64.b64encode(full_report.encode()).decode()
                        )
                        await send_msg({
                            "senderType": "backend", "id": message_id, "parentId": session_id,
                            "agentType": AGENT_TYPE_REVIEW,
                            "content": {
                                "type": "finish",
                                "data": {
                                    "md": md_value,
                                    "pdf": "",
                                    "name": f"预审报告_{file_name}",
                                    "isFinished": True,
                                },
                            },
                        })
                        break

                    # 后端仍在运行：每次轮询推进一个子步骤（与后端当前 stage 无关）
                    if display_step_idx < len(_all_display_steps):
                        _s, _txt = _all_display_steps[display_step_idx]
                        if _s != display_stage:
                            if display_stage in _STAGE_PLAN_TITLES:
                                await _close_stage_ws(display_stage)
                            display_stage = _s
                            await _open_stage_ws(display_stage)
                        await _send_substep_ws(_txt)
                        display_step_idx += 1
                    # 所有子步骤已全部展示完，SYNTHESIZING 保持 doing 状态等待后端完成

            except Exception as e:
                logger.error(f"论文预审WebSocket处理失败: {e}")
                await send_msg({
                    "senderType": "backend",
                    "id": message_id,
                    "parentId": session_id,
                    "agentType": AGENT_TYPE_REVIEW,
                    "content": {
                        "type": "stream",
                        "data": {"type": "text", "delta": f"⚠️ 处理错误：{str(e)}", "isFinished": True},
                    },
                })
                await send_msg({
                    "senderType": "backend",
                    "id": message_id,
                    "parentId": session_id,
                    "agentType": AGENT_TYPE_REVIEW,
                    "content": {"type": "text_finish", "data": {}},
                })

    except WebSocketDisconnect:
        logger.info(f"论文预审WebSocket断开: session={session_id}")
    except Exception as e:
        logger.error(f"论文预审WebSocket异常: {e}")


# Run the application
if __name__ == "__main__":

    import os

    # 必须在导入 torch 或 tensorflow 之前设置
    os.environ["CUDA_VISIBLE_DEVICES"] = "-1"

    import torch

    # 或者 import tensorflow

    # 验证一下
    if torch.cuda.is_available():
        print("显卡可用 (错误)")
    else:
        print("显卡已禁用，正在使用 CPU (正确)")

    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=6009)
