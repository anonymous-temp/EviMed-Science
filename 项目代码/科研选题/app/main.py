"""
FastAPI主应用 V5.0
支持分阶段动态分析架构
新增：输入校验、检索诊断、CORS安全、请求频率限制
"""
import asyncio
import logging
import uuid
import json
import re
import os
from datetime import datetime
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from contextlib import asynccontextmanager
from typing import List, Dict

from config.settings import settings
from models.schemas import (
    SubmitAnalysisRequest, SubmitAnalysisResponse,
    TaskStatusResponse, ReportResponse,
    AnalysisBlueprintResponse, ConfirmPlanRequest, ConfirmPlanResponse,
    ExecuteModuleResponse, ModuleResultResponse, FinalizeReportResponse,
    InputValidationResponse
)
from services.task_service import task_service
from services.llm_service import llm_service
from app.http_stream import router as http_stream_router

logger = logging.getLogger(__name__)


AGENT_TYPE = "research-topic-selection"
_java_client_task: asyncio.Task = None


def _make_ts() -> list:
    """生成 Java 格式的时间元组 [年,月,日,时,分,秒,纳秒]"""
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
                async with s.get(settings.JAVA_TOKEN_URL, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    data = await resp.json(content_type=None)
                    payload = data.get("data") or {}
                    token = (
                        payload.get("token")
                        or payload.get("accessToken")
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


_GREETING_PATTERNS = re.compile(
    r'^(你好|您好|hi|hello|hey|嗨|哈喽|在吗|在不在|你是谁|你是什么|介绍一下你自己|你能做什么|你有什么功能|help|帮助)',
    re.IGNORECASE,
)


async def _classify_intent(text: str, session_ctx: dict, model: str = "") -> str:
    """用 LLM 分类用户意图: new_topic / followup / greeting / other。
    返回字符串标签。如果 LLM 不可用则降级为正则判断。"""
    t = text.strip()
    if not t:
        return "other"

    if _GREETING_PATTERNS.match(t):
        return "greeting"

    has_report = bool(session_ctx.get("last_report"))
    if not has_report:
        return "new_topic"

    if not llm_service.client:
        return _fallback_intent(t)

    try:
        response = await llm_service.complete_messages(
            [
                {"role": "system", "content": (
                    "你是一个意图分类器。根据用户输入和上下文，判断用户意图。"
                    "只能回复以下标签之一：\n"
                    "- new_topic: 用户想分析一个新的研究主题/课题（包含疾病、药物、治疗、机制等医学研究关键词）\n"
                    "- followup: 用户在追问之前分析报告中的内容（如提问、要求解释、对比、细化等）\n"
                    "- greeting: 打招呼、闲聊、询问功能\n"
                    "- other: 无法判断\n"
                    "只回复标签名，不要回复其他内容。"
                )},
                {"role": "user", "content": (
                    f"当前会话已完成的分析主题：{session_ctx.get('last_topic', '无')}\n\n"
                    f"用户输入：{t}"
                )},
            ],
            model=model or None,
            model_tier="flash",
            max_tokens=10,
            temperature=0,
        )
        label = response.strip().lower()
        if label in ("new_topic", "followup", "greeting", "other"):
            return label
    except Exception as e:
        logger.warning(f"意图分类 LLM 调用失败: {e}")

    return _fallback_intent(t)


def _fallback_intent(text: str) -> str:
    """LLM 不可用时的正则降级意图判断。"""
    t = text.strip()
    if len(t) > 30:
        return "new_topic"
    question_pats = [
        r"[?？]\s*$",
        r"(吗|么|呢|嘛|吧)\s*[?？。]?\s*$",
        r"^(什么|如何|怎么|怎样|为什么|为何|是否|能否|可以|可否|请问|请帮|告诉我)",
        r"^(what|how|why|when|where|which|who|is\s|are\s|can\s|does\s)",
    ]
    for pat in question_pats:
        if re.search(pat, t, re.IGNORECASE):
            return "followup"
    return "new_topic"


async def _answer_from_report(
    question: str,
    session_ctx: dict,
    send_msg,
    session_id: str,
    message_id: str,
):
    """基于上一次科研选题分析报告，用 LLM 流式回答追问。支持多轮对话历史。"""
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
        if not llm_service.client:
            raise ValueError("未配置 DEEPSEEK_API_KEY")
        system = (
            "你是一位资深的医学科研选题分析顾问。用户已完成一次科研选题分析，你手头有完整的分析报告。\n"
            "请基于报告内容，深入、准确地回答用户的追问。\n\n"
            "要求：\n"
            "- 使用 Markdown 格式，层次清晰\n"
            "- 引用报告中的具体数据、指标、趋势来支撑回答\n"
            "- 如报告中无相关信息，明确告知并给出你的专业建议\n"
            "- 绝不编造数据或虚构研究结论\n"
            "- 语言专业、简洁，避免空泛的描述"
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
        async for delta in llm_service.stream_messages(
            messages,
            model_tier="pro",
            max_tokens=3000,
        ):
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
        f"如需了解「{topic}」分析报告的具体内容，请直接查阅上方生成的报告文件。\n"
        f"如需分析新的研究主题，请直接输入主题关键词。"
    )
    buf = ""
    for i, ch in enumerate([fallback[j:j + _TW_CHUNK] for j in range(0, len(fallback), _TW_CHUNK)]):
        buf += ch
        is_last = (i == len(fallback) // _TW_CHUNK)
        await _send_stream(buf, inprogress=not is_last, finished=is_last)
        await asyncio.sleep(_TW_DELAY)


async def _send_no_context_hint(
    text: str, send_msg, session_id: str, message_id: str
):
    """无先验报告时，引导用户先输入研究主题。"""
    _TW_CHUNK = 8
    _TW_DELAY = 0.03
    reply = (
        "**请先完成一次科研选题分析**\n\n"
        f"您询问的「{text}」是关于分析结果的问题，"
        "但当前会话尚未完成任何选题分析。\n\n"
        "**使用步骤：**\n\n"
        "1. 先输入医学研究主题，系统将自动检索文献并生成深度分析报告（约 3-5 分钟）\n"
        "2. 分析完成后，可直接追问报告中的任意内容，例如：\n"
        "   - 哪个国家在该领域发文量最多？\n"
        "   - 目前的研究空白在哪里？\n"
        "   - 有哪些值得关注的研究方向？\n\n"
        "**主题输入示例：**\n\n"
        "| 研究方向 | 示例输入 |\n"
        "|----------|----------|\n"
        "| 代谢疾病 | `二甲双胍与心血管保护` |\n"
        "| 肿瘤免疫 | `PD-1抑制剂在肺癌中的应用` |\n"
        "| 慢性病管理 | `糖尿病合并高血压的治疗策略` |\n"
        "| 新型疗法 | `GLP-1受体激动剂减重机制` |"
    )
    buf = ""
    chunks = [reply[i:i + _TW_CHUNK] for i in range(0, len(reply), _TW_CHUNK)]
    for i, ch in enumerate(chunks):
        buf += ch
        is_last = (i == len(chunks) - 1)
        data = {"type": "text", "delta": buf, "inprogress": not is_last}
        if is_last:
            data["isFinished"] = True
        await send_msg({
            "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
            "content": {"clazz": "agent", "type": "stream", "data": data},
        })
        await asyncio.sleep(_TW_DELAY)


async def _llm_reply(text: str, validation_error, send_msg, session_id: str, message_id: str):
    """调用LLM进行智能回复（打字机效果），支持校验失败和闲聊两种场景。"""
    _TW_CHUNK = 8
    _TW_DELAY = 0.03

    if validation_error:
        system_prompt = (
            "你是一个医学科研选题分析智能助手，专门帮助用户分析医学科研选题方向。"
            "当用户输入不符合要求时，请用中文友好地解释原因并给出具体建议。"
            "回复要简洁、专业、有帮助性。"
        )
        user_prompt = (
            f"用户输入：{text}\n"
            f"校验提示：{validation_error.message}\n"
            f"建议：{', '.join(validation_error.suggestions)}\n\n"
            f"请友好地回复用户，解释为什么无法处理该输入，并给出具体的改进建议。"
        )
    else:
        system_prompt = (
            "你是「科研选题分析助手」，一个专业的医学科研AI助手。\n"
            "你可以帮助用户分析医学科研选题，检索相关文献，生成深度分析报告。\n\n"
            "当用户打招呼或询问功能时：\n"
            "- 友好地自我介绍\n"
            "- 简要说明你的核心能力（科研选题分析、文献检索、研究趋势洞察等）\n"
            "- 引导用户输入研究主题关键词开始分析\n"
            "- 回复简洁，不超过200字"
        )
        user_prompt = text

    try:
        if llm_service.client:
            chunks = []
            async for delta in llm_service.stream_messages(
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                model_tier="flash",
                max_tokens=600,
            ):
                if delta:
                    chunks.append(delta)
            buf = ""
            for i, ch in enumerate(chunks):
                buf += ch
                is_last = (i == len(chunks) - 1)
                await send_msg({
                    "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "stream",
                                "data": {"type": "text", "delta": buf, "inprogress": not is_last,
                                         **({"isFinished": True} if is_last else {})}},
                })
                await asyncio.sleep(_TW_DELAY)
            return
        else:
            raise Exception("no api key")
    except Exception:
        if validation_error:
            reply = f"{validation_error.message}\n\n**建议**：\n" + "\n".join(f"- {s}" for s in validation_error.suggestions)
        else:
            reply = (
                "你好！我是「科研选题分析助手」，专注于医学科研选题分析。\n\n"
                "我可以帮你：\n"
                "- 分析医学科研选题的研究前景\n"
                "- 检索相关文献并洞察研究趋势\n"
                "- 发现研究空白和突破性机会\n\n"
                "请输入你感兴趣的研究主题关键词，我将为你生成深度分析报告。"
            )
        buf = ""
        chunks = [reply[i:i + _TW_CHUNK] for i in range(0, len(reply), _TW_CHUNK)]
        for i, ch in enumerate(chunks):
            buf += ch
            is_last = (i == len(chunks) - 1)
            await send_msg({
                "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                "content": {"clazz": "agent", "type": "stream",
                            "data": {"type": "text", "delta": buf, "inprogress": not is_last,
                                     **({"isFinished": True} if is_last else {})}},
            })
            await asyncio.sleep(_TW_DELAY)


async def _handle_session(
    parent_id: str,
    msg_queue: asyncio.Queue,
    python_client_id: str,
    ws_send,          # coroutine: ws_send(raw_str)
    first_sender_id: str,
    user_id: str,
):
    """
    处理单个前端用户会话（逻辑与原 websocket_endpoint 完全一致）
    send_msg 将 payload 包裹为 Java 消息格式后发出。
    """
    session_id = parent_id
    current_target = first_sender_id   # 本次响应的接收方（前端 clientId）

    def _wrap(payload: dict) -> str:
        """将内部 payload 包装为 Java 消息格式的 JSON 字符串"""
        content = payload.get("content", "")
        # Java TextMessage.content 字段类型为 String，必须序列化
        if isinstance(content, dict):
            content = json.dumps(content, ensure_ascii=False)
        java_msg = {
            "type": "text",
            "userId": user_id,
            "parentId": payload.get("parentId", session_id),
            "id": payload.get("id", str(uuid.uuid4())),
            "senderType": AGENT_TYPE,
            "senderId": python_client_id,
            "targetClientId": current_target,
            "timestamp": _make_ts(),
            "agentType": payload.get("agentType", AGENT_TYPE),
            "content": content,
        }
        return json.dumps(java_msg, ensure_ascii=False)

    async def send_msg(payload: dict):
        await ws_send(_wrap(payload))

    try:
        # Java 已完成前端 auth，第一条消息直接是用户查询，无需 auth 握手步骤
        session_ctx: dict = {"last_topic": "", "last_report": "", "chat_history": []}

        while True:
            user_msg = await msg_queue.get()
            if user_msg is None:
                break

            current_target = user_msg.get("senderId", first_sender_id)
            content_raw = user_msg.get("content", "")
            try:
                content_obj = json.loads(content_raw) if isinstance(content_raw, str) else content_raw
                input_text = content_obj.get("content", content_obj.get("text", "")) or ""
            except Exception:
                input_text = ""

            if not input_text:
                continue

            message_id = str(uuid.uuid4())

            # ── 意图分类 ──
            intent = await _classify_intent(input_text, session_ctx)
            logger.info(f"意图分类结果: {intent} | 输入: {input_text[:40]}")

            if intent == "greeting":
                await _llm_reply(input_text, None, send_msg, session_id, message_id)
                continue

            if intent == "followup":
                if session_ctx["last_report"]:
                    await _answer_from_report(
                        input_text, session_ctx, send_msg, session_id, message_id
                    )
                else:
                    await _send_no_context_hint(
                        input_text, send_msg, session_id, message_id
                    )
                continue

            if intent == "other":
                await _llm_reply(input_text, None, send_msg, session_id, message_id)
                continue

            # 前置校验，不通过则 LLM 友好回复，不走分析流程
            validation_error = task_service.validate_input(input_text)
            if validation_error:
                await _llm_reply(input_text, validation_error, send_msg, session_id, message_id)
                continue

            # 4. 发送"正在分析"状态
            await send_msg({
                "senderType": "backend",
                "id": message_id,
                "parentId": session_id,
                "agentType": AGENT_TYPE,
                "content": {
                    "clazz": "agent",
                    "type": "stream",
                    "data": {"type": "text", "delta": f"正在检索与规划「{input_text}」的分析蓝图，请稍候…\n\n", "inprogress": True},
                },
            })

            try:
                # 5. 创建任务并执行检索与规划（阶段一）
                task = await task_service.create_task(input_text=input_text, options={})

                await send_msg({
                    "senderType": "backend",
                    "id": message_id,
                    "parentId": session_id,
                    "agentType": AGENT_TYPE,
                    "content": {
                        "clazz": "agent",
                        "type": "stream",
                        "data": {"type": "text", "delta": "正在检索相关文献，生成分析蓝图…\n\n", "inprogress": True},
                    },
                })

                blueprint = await task_service.start_retrieval_and_planning(task.task_id)

                if not blueprint.can_proceed:
                    diag = blueprint.search_diagnostics
                    msg = diag.diagnosis if diag else "检索结果不足"
                    await send_msg({
                        "senderType": "backend",
                        "id": message_id,
                        "parentId": session_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "stream",
                            "data": {"type": "text", "delta": f"⚠️ {msg}", "inprogress": True, "isFinished": True},
                        },
                    })
                    continue

                # 6. 自动确认计划并逐模块执行
                await task_service.confirm_analysis_plan(
                    task_id=task.task_id, confirmed=True, skip_modules=[]
                )

                module_names = {
                    "M1_PROBLEM_LANDSCAPE": "问题全景分析",
                    "M2_RESEARCH_ECOSYSTEM": "研究生态系统",
                    "M3_EVIDENCE_SYSTEM": "证据体系",
                    "M4_SCIENTIFIC_CONTRADICTION": "科学争议",
                    "M5_BREAKTHROUGH_OPPORTUNITY": "突破性机会",
                    "M6_RESEARCH_AGENDA": "研究议程",
                }
                plan_todos = [module_names.get(m, m) for m in blueprint.planned_modules]

                # 发送任务计划
                await send_msg({
                    "senderType": "backend",
                    "id": message_id,
                    "parentId": session_id,
                    "agentType": AGENT_TYPE,
                    "content": {
                        "clazz": "agent",
                        "type": "orchestra",
                        "data": {
                            "type": "plan",
                            "item": {"analysis": "课题分析进度", "todo": plan_todos},
                            "isFinished": True,
                        },
                    },
                })

                full_report = ""
                _TW_CHUNK = 60
                _TW_DELAY = 0.035

                def build_task_status_list(current_index, total_count, status_for_current="doing"):
                    status_list = []
                    for i in range(total_count):
                        if i < current_index:
                            status_list.append({"status": "done", "title": plan_todos[i]})
                        elif i == current_index:
                            status_list.append({"status": status_for_current, "title": plan_todos[i]})
                        else:
                            status_list.append({"status": "todo", "title": plan_todos[i]})
                    return status_list

                async def send_status(current_index, status_for_current):
                    task_status_list = build_task_status_list(current_index, len(plan_todos), status_for_current)
                    await send_msg({
                        "senderType": "backend",
                        "id": message_id,
                        "parentId": session_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "data": {"item": task_status_list, "type": "task_status"},
                            "type": "status",
                        },
                    })

                async def send_tool_call(str_type: str, front_display: str):
                    await send_msg({
                        "senderType": "backend",
                        "id": message_id,
                        "parentId": session_id,
                        "agentType": AGENT_TYPE,
                        "content": {
                            "clazz": "agent",
                            "type": "raw",
                            "data": {"type": "tool_call", "str": str_type, "front_display": front_display, "inprogress": True},
                        },
                    })

                module_process_map = {
                    "问题全景分析": ("正在搜索", "正在检索问题全景文献数据，分析研究发展脉络..."),
                    "研究生态系统": ("正在搜索", "正在绘制研究生态系统图谱，分析学术合作网络..."),
                    "证据体系":     ("正在搜索", "正在评估证据层次结构，梳理研究设计分布..."),
                    "科学争议":     ("正在搜索", "正在识别核心科学争议，分析研究矛盾焦点..."),
                    "突破性机会":   ("正在分析", "正在发现潜在研究突破口，评估创新机会窗口..."),
                    "研究议程":     ("正在分析", "正在规划研究路线图，生成优先研究议程..."),
                }

                # 构建 module_id -> plan_todos 索引的映射，用于精确定位状态
                planned_modules_list = blueprint.planned_modules  # 原始模块ID列表
                module_id_to_index = {mid: i for i, mid in enumerate(planned_modules_list)}

                iter_index = 0
                while True:
                    # 预先获取当前模块信息，在执行前发送 doing 状态
                    # 确保前端先收到 doing 状态再收到流式内容，避免内容无法归属
                    if iter_index < len(planned_modules_list):
                        cur_module_id = planned_modules_list[iter_index]
                        cur_module_index = module_id_to_index.get(cur_module_id, iter_index)
                        current_todo = plan_todos[cur_module_index] if cur_module_index < len(plan_todos) else "分析"
                        str_type, front_display = module_process_map.get(
                            current_todo, ("正在分析", f"正在执行{current_todo}深度分析...")
                        )
                        await send_status(cur_module_index, "doing")
                        await send_tool_call(str_type, front_display)

                    # 为当前模块创建实时流式回调（累积模式，与打字机保持一致）
                    _stream_buf: list = []
                    async def on_token(delta: str, _mid=message_id, _sid=session_id, _buf=_stream_buf):
                        _buf.append(delta)
                        cumulative = ''.join(_buf)
                        await send_msg({
                            "senderType": "backend",
                            "id": _mid,
                            "parentId": _sid,
                            "agentType": AGENT_TYPE,
                            "content": {
                                "clazz": "agent",
                                "type": "stream",
                                "data": {"type": "text", "delta": cumulative, "inprogress": True},
                            },
                        })

                    # 所有模块统一带流式回调直接执行（M1/M4-M6 流式，M2/M3 来自并行缓冲立即返回）
                    result = await task_service.execute_next_module(task.task_id, stream_callback=on_token)

                    module_id = result.get("module_id", "")
                    module_name = module_names.get(module_id, module_id)
                    module_index = module_id_to_index.get(module_id, iter_index)
                    iter_index += 1

                    output = result.get("output")
                    was_streamed = result.get("was_streamed", False)

                    if output and output.status == "success":
                        section_content = output.data.get("llm_deep_analysis", "")
                        if not section_content and output.key_insights:
                            section_content = "\n".join(f"- {insight}" for insight in output.key_insights)
                        # 无文字内容且无图表时，静默跳过本模块，不发送任何消息
                        if not section_content and not output.charts:
                            logger.info(f"[模块] {module_name} 无有效内容与图表，跳过输出")
                            section_content = None
                    elif output:
                        # 模块执行失败：不向前端发送错误文字，静默跳过
                        logger.warning(f"[模块] {module_name} 执行失败: {output.error_message}")
                        section_content = None
                    else:
                        logger.warning(f"[模块] {module_name} 无输出，跳过")
                        section_content = None

                    if section_content is not None and not was_streamed:
                        # M2/M3 来自并行缓冲（已完成），用打字机快速展示
                        for start in range(0, len(section_content), _TW_CHUNK):
                            typed = section_content[:start + _TW_CHUNK]
                            await send_msg({
                                "senderType": "backend",
                                "id": message_id,
                                "parentId": session_id,
                                "agentType": AGENT_TYPE,
                                "content": {
                                    "clazz": "agent",
                                    "type": "stream",
                                    "data": {"type": "text", "delta": typed, "inprogress": True},
                                },
                            })
                            await asyncio.sleep(_TW_DELAY)
                    # else: deep_analysis 内容已在 on_token 回调中实时发出；或模块被跳过

                    import os, base64 as _b64
                    chart_markdown = ""
                    # 仅当模块成功时才尝试读取图表
                    if output and output.status == "success":
                        for chart in output.charts:
                            try:
                                if chart.path and os.path.exists(chart.path):
                                    img_bytes = await asyncio.to_thread(
                                        lambda p=chart.path: open(p, "rb").read()
                                    )
                                    img_b64 = _b64.b64encode(img_bytes).decode()
                                    chart_markdown += f"\n\n![{chart.title}](data:image/png;base64,{img_b64})\n\n"
                                    if chart.description:
                                        chart_markdown += f"*{chart.description}*\n\n"
                            except Exception as _e:
                                logger.warning(f"图表读取失败: {chart.path}, {_e}")

                    if chart_markdown:
                        # 图表消息始终携带完整文本内容，避免前端替换机制导致描述文字消失
                        chart_payload = (section_content or "") + chart_markdown
                        await send_msg({
                            "senderType": "backend",
                            "id": message_id,
                            "parentId": session_id,
                            "agentType": AGENT_TYPE,
                            "content": {
                                "clazz": "agent",
                                "type": "stream",
                                "data": {"type": "text", "delta": chart_payload, "inprogress": True},
                            },
                        })

                    # 只有有实质内容时才累加到全文报告
                    if section_content is not None or chart_markdown:
                        section_header = f"\n\n## {module_name}\n\n"
                        full_report += f"{section_header}{section_content or ''}"

                    if result.get("is_final"):
                        # 最后一步保持 doing（加载动画），等报告生成完毕再标 done
                        await send_msg({
                            "senderType": "backend",
                            "id": message_id,
                            "parentId": session_id,
                            "agentType": AGENT_TYPE,
                            "content": {
                                "clazz": "agent",
                                "type": "raw",
                                "data": {"type": "tool_call", "str": "正在写作", "front_display": "正在撰写分析报告…", "inprogress": True},
                            },
                        })
                        final_md = full_report
                        async for _, cumulative_md in task_service.generate_report_streaming(task.task_id):
                            final_md = cumulative_md
                            await send_msg({
                                "senderType": "backend",
                                "id": message_id,
                                "parentId": session_id,
                                "agentType": AGENT_TYPE,
                                "content": {
                                    "clazz": "agent",
                                    "type": "report_writing_stream",
                                    "data": {"type": "text", "delta": cumulative_md, "inprogress": True},
                                },
                            })
                        # 报告生成完毕，最后一步标为 done
                        await send_status(module_index, "done")
                        break
                    else:
                        await send_status(module_index, "done")

                # 重置消息路由（text_finish），后续消息进入顶层
                import base64
                from utils.oss_uploader import upload_report
                await send_msg({
                    "senderType": "backend",
                    "id": message_id,
                    "parentId": session_id,
                    "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "text_finish", "data": {}},
                })

                # 上传报告到 OSS，失败时降级为 base64 data URI
                oss_url = await upload_report(
                    content=final_md,
                    user_id=user_id,
                    message_id=message_id,
                    agent_type=AGENT_TYPE,
                )
                md_value = oss_url if oss_url else (
                    "data:text/markdown;base64," + base64.b64encode(final_md.encode()).decode()
                )

                # 发送 md 文件链接（顶层展示）
                await send_msg({
                    "senderType": "backend",
                    "id": message_id,
                    "parentId": session_id,
                    "agentType": AGENT_TYPE,
                    "content": {
                        "clazz": "agent",
                        "type": "finish",
                        "data": {
                            "md": md_value,
                            "pdf": "",
                            "name": f"科研选题分析_{input_text[:20]}",
                            "isFinished": True,
                        },
                    },
                })

                report_text_only = re.sub(r'!\[([^\]]*)\]\(data:[^)]{20,}\)', r'[图表: \1]', final_md)
                session_ctx["last_topic"] = input_text
                session_ctx["last_report"] = report_text_only
                session_ctx["chat_history"] = []

            except Exception as e:
                logger.exception(f"会话 {session_id} 任务处理失败: {e}")
                await send_msg({
                    "senderType": "backend",
                    "id": message_id,
                    "parentId": session_id,
                    "agentType": AGENT_TYPE,
                    "content": {
                        "clazz": "agent",
                        "type": "stream",
                        "data": {"type": "text", "delta": f"⚠️ 处理过程中发生错误：{str(e)}", "inprogress": True, "isFinished": True},
                    },
                })

    except Exception as e:
        logger.error(f"会话 {parent_id} 异常退出: {e}")
    finally:
        pass


async def _java_ws_client():
    """
    作为 WebSocket 客户端持续连接 Java 网关，处理所有前端用户的会话。
    断线后自动重连。
    """
    import websockets
    active_sessions: Dict[str, dict] = {}   # {parent_id: {queue, task}}

    while True:
        _hb_task = None
        try:
            token = await _get_java_token()
            python_client_id = "research-topic-selection"

            logger.info(f"正在连接 Java WebSocket: {settings.JAVA_WS_URL}")
            async with websockets.connect(
                settings.JAVA_WS_URL,
                ping_interval=15,
                ping_timeout=10,
                close_timeout=5,
            ) as ws:

                # ---- 发送 auth ----
                await ws.send(json.dumps({
                    "type": "auth",
                    "token": token,
                    "clientType": "research-topic-selection",
                    "userId": python_client_id,
                    "agentType": AGENT_TYPE,
                }, ensure_ascii=False))
                logger.info("已发送 auth 消息，等待 Java 响应...")

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

                # ---- 消息主循环 ----
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except Exception:
                        continue

                    # 收到心跳不回复，避免死循环
                    if msg.get("type") == "heartbeat":
                        continue

                    # Java 系统消息（auth 响应等）
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

                    # 前端用户消息（由 Java 路由到此）
                    parent_id = msg.get("parentId")
                    if not parent_id:
                        continue

                    sender_id = msg.get("senderId", "")
                    uid = msg.get("userId", "")

                    if parent_id not in active_sessions:
                        q: asyncio.Queue = asyncio.Queue()
                        t = asyncio.create_task(
                            _handle_session(parent_id, q, python_client_id, ws_send, sender_id, uid)
                        )
                        # 会话结束后自动从 active_sessions 移除，防止内存泄漏
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

        # 通知所有活跃会话连接已断开，并取消正在进行的分析任务
        for sid, sess in list(active_sessions.items()):
            sess["task"].cancel()  # 立即取消后台分析协程，防止服务卡死
        active_sessions.clear()
        await asyncio.sleep(5)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理：启动时连接 Java WebSocket 网关"""
    logger.info(f"Starting {settings.APP_NAME} v{settings.APP_VERSION}")
    global _java_client_task
    _java_client_task = asyncio.create_task(_java_ws_client())
    task_service.start_cleanup_loop()
    yield
    logger.info("Shutting down...")
    if _java_client_task:
        _java_client_task.cancel()
        try:
            await _java_client_task
        except asyncio.CancelledError:
            pass
    await task_service.pubmed_service.close()


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="科研选题智能分析Agent系统 V5.0 - 分阶段动态分析架构",
    lifespan=lifespan
)

# ── HTTP 流式接口（新增，不影响原有 WebSocket 服务）──
app.include_router(http_stream_router)

# CORS配置 - 允许所有来源
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    """根路径"""
    return {
        "name": settings.APP_NAME,
        "version": f"{settings.APP_VERSION}-V5.0",
        "status": "running",
        "features": [
            "分阶段动态分析",
            "LLM驱动查询生成",
            "逐步模块执行",
            "图表支撑",
            "论据追溯"
        ]
    }


@app.get("/health")
async def health_check():
    """健康检查"""
    return {"status": "healthy", "version": "5.0"}


# ==================== V5.0: 阶段一 - 检索与规划 ====================

@app.post("/api/v1/analysis/start")
async def start_analysis(request: SubmitAnalysisRequest):
    """
    V5.0: 开始分析 - 阶段一：检索与规划

    1. 输入校验（空输入、非医学内容、注入攻击）
    2. LLM驱动的查询理解
    3. 并行执行多子查询检索（PubMed + ES）
    4. 检索结果诊断与降级策略
    5. 生成动态分析计划
    6. 返回分析蓝图供用户确认
    """
    # Step 0: 输入校验
    validation_error = task_service.validate_input(request.input_text)
    if validation_error:
        return JSONResponse(
            status_code=422,
            content=InputValidationResponse(
                message=validation_error.message,
                suggestions=validation_error.suggestions
            ).model_dump()
        )

    try:
        # 创建任务
        task = await task_service.create_task(
            input_text=request.input_text,
            options=request.options
        )

        # 执行阶段一：检索与规划
        blueprint = await task_service.start_retrieval_and_planning(task.task_id)

        # 如果检索结果不足
        if not blueprint.can_proceed:
            diagnostics = blueprint.search_diagnostics
            return JSONResponse(
                status_code=200,
                content={
                    "task_id": task.task_id,
                    "blueprint": blueprint.model_dump(),
                    "message": diagnostics.diagnosis if diagnostics else "检索结果不足，无法继续分析",
                    "suggestions": diagnostics.suggestions if diagnostics else [],
                    "can_proceed": False
                }
            )

        return AnalysisBlueprintResponse(
            task_id=task.task_id,
            blueprint=blueprint,
            message="分析蓝图已生成，请确认是否继续执行"
        )

    except Exception as e:
        logger.exception("分析启动失败")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/analysis/blueprint/{task_id}", response_model=AnalysisBlueprintResponse)
async def get_analysis_blueprint(task_id: str):
    """
    V5.0: 获取分析蓝图

    获取已生成的分析蓝图，包括检索结果统计、计划模块列表等
    """
    try:
        blueprint = await task_service.get_analysis_blueprint(task_id)
        if not blueprint:
            raise HTTPException(status_code=404, detail="蓝图不存在或任务未开始")

        return AnalysisBlueprintResponse(
            task_id=task_id,
            blueprint=blueprint,
            message="获取分析蓝图成功"
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== V5.0: 阶段二 - 逐步分析 ====================

@app.post("/api/v1/analysis/confirm", response_model=ConfirmPlanResponse)
async def confirm_analysis_plan(request: ConfirmPlanRequest):
    """
    V5.0: 确认分析计划

    用户确认执行分析计划，可以选择跳过某些模块
    """
    try:
        result = await task_service.confirm_analysis_plan(
            task_id=request.task_id,
            confirmed=request.confirmed,
            skip_modules=request.skip_modules
        )

        if result.get("status") == "cancelled":
            return ConfirmPlanResponse(
                task_id=request.task_id,
                status="cancelled",
                message=result.get("message", "分析计划已取消"),
                next_module=None
            )

        return ConfirmPlanResponse(
            task_id=request.task_id,
            status="confirmed",
            message=result.get("message", "分析计划已确认"),
            next_module=result.get("next_module")
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/analysis/execute-next", response_model=ExecuteModuleResponse)
async def execute_next_module(task_id: str):
    """
    V5.0: 执行下一个分析模块

    按照计划顺序执行下一个模块，返回模块分析结果
    """
    try:
        result = await task_service.execute_next_module(task_id)

        return ExecuteModuleResponse(
            task_id=task_id,
            module_id=result.get("module_id", ""),
            status=result.get("status", ""),
            output=result.get("output"),
            progress_percentage=result.get("progress_percentage", 0),
            next_module=result.get("next_module"),
            is_final=result.get("is_final", False)
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/analysis/module/{task_id}/{module_id}", response_model=ModuleResultResponse)
async def get_module_result(task_id: str, module_id: str):
    """
    V5.0: 获取模块分析结果

    获取特定模块的完整分析结果，包括图表和论据支撑
    """
    try:
        output = await task_service.get_module_result(task_id, module_id)
        if not output:
            raise HTTPException(status_code=404, detail="模块结果不存在")

        # 获取所有图表
        all_charts = await task_service.get_all_charts(task_id)

        return ModuleResultResponse(
            task_id=task_id,
            module_id=module_id,
            output=output,
            all_charts=all_charts
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/analysis/charts/{task_id}")
async def get_all_charts(task_id: str):
    """
    V5.0: 获取所有分析图表

    返回所有已执行模块生成的图表列表
    """
    try:
        charts = await task_service.get_all_charts(task_id)
        return {
            "task_id": task_id,
            "charts": charts
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/analysis/chart-image/{task_id}/{chart_path:path}")
async def get_chart_image(task_id: str, chart_path: str):
    """
    V5.0: 获取图表图片

    返回指定路径的图表图片文件
    """
    try:
        import os
        from pathlib import Path

        full_path = os.path.join("/tmp/research_topic_charts", chart_path)

        # 安全校验：防止路径遍历
        allowed_dir = Path("/tmp/research_topic_charts").resolve()
        requested_path = Path(full_path).resolve()

        if not requested_path.is_relative_to(allowed_dir):
            raise HTTPException(status_code=403, detail="非法路径")

        if not os.path.exists(full_path):
            raise HTTPException(status_code=404, detail="图表不存在")

        return FileResponse(full_path, media_type="image/png")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 向后兼容的API ====================

@app.post("/api/v1/analysis/submit", response_model=SubmitAnalysisResponse)
async def submit_analysis(
    request: SubmitAnalysisRequest,
    background_tasks: BackgroundTasks
):
    """提交分析任务 - 向后兼容（后台完整执行）"""
    # 输入校验
    validation_error = task_service.validate_input(request.input_text)
    if validation_error:
        return JSONResponse(
            status_code=422,
            content=InputValidationResponse(
                message=validation_error.message,
                suggestions=validation_error.suggestions
            ).model_dump()
        )

    try:
        task = await task_service.create_task(
            input_text=request.input_text,
            options=request.options
        )

        background_tasks.add_task(task_service.process_task, task.task_id)

        return SubmitAnalysisResponse(
            status="accepted",
            task_id=task.task_id,
            message="任务已提交，正在后台处理中。",
            estimated_completion_time_seconds=300
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/analysis/status/{task_id}", response_model=TaskStatusResponse)
async def get_task_status(task_id: str):
    """
    查询任务状态 - V5.0增强

    获取指定任务的当前执行状态、阶段和进度。
    """
    status = await task_service.get_task_status(task_id)

    if not status:
        raise HTTPException(status_code=404, detail="任务不存在")

    return TaskStatusResponse(
        task_id=task_id,
        status=status["status"],
        phase=status.get("phase"),
        progress=status.get("progress")
    )


@app.get("/api/v1/analysis/report/{task_id}", response_model=ReportResponse)
async def get_analysis_report(task_id: str):
    """
    获取分析报告

    获取指定任务生成的完整分析报告。
    """
    task = await task_service.get_task(task_id)

    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    if task.status == "processing":
        return ReportResponse(
            task_id=task_id,
            status=task.status,
            report=None
        )

    if task.status == "failed":
        raise HTTPException(
            status_code=500,
            detail=f"任务执行失败: {task.error_message}"
        )

    report_data = await task_service.get_task_report(task_id)

    return ReportResponse(
        task_id=task_id,
        status=task.status,
        report=report_data.get("report") if report_data else None
    )


@app.post("/api/v1/analysis/quick")
async def quick_analysis(request: SubmitAnalysisRequest):
    """快速分析（同步接口）- 向后兼容"""
    # 输入校验
    validation_error = task_service.validate_input(request.input_text)
    if validation_error:
        return JSONResponse(
            status_code=422,
            content=InputValidationResponse(
                message=validation_error.message,
                suggestions=validation_error.suggestions
            ).model_dump()
        )

    try:
        task = await task_service.create_task(
            input_text=request.input_text,
            options=request.options
        )

        completed_task = await task_service.process_task(task.task_id)

        if completed_task.status == "failed":
            raise HTTPException(
                status_code=500,
                detail=f"分析失败: {completed_task.error_message}"
            )

        report_data = await task_service.get_task_report(task.task_id)

        return {
            "status": "success",
            "task_id": task.task_id,
            "report": report_data.get("report") if report_data else None
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== V5.0: 辅助接口 ====================

@app.get("/api/v1/analysis/execution-sequence/{task_id}")
async def get_execution_sequence(task_id: str):
    """
    V5.0: 获取执行序列

    返回计划的模块执行顺序
    """
    try:
        task = await task_service.get_task(task_id)
        if not task or not task.execution_plan:
            raise HTTPException(status_code=404, detail="执行计划不存在")

        from core.new_analysis_engine import analysis_engine
        sequence = analysis_engine.get_execution_sequence(task.execution_plan)

        return {
            "task_id": task_id,
            "execution_sequence": sequence,
            "module_descriptions": {
                m: task_service.planner.get_module_description(m)
                for m in sequence
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=settings.API_HOST,
        port=settings.API_PORT,
        reload=settings.DEBUG
    )
