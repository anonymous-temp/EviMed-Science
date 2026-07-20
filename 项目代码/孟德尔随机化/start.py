"""
孟德尔随机化分析服务 v3.0
- 单次输入驱动：用户输入暴露/结局变量后直接运行完整分析流程
- Java WebSocket 接入，与文献计量分析/meta分析保持一致的消息协议
- 流程：解析变量 → 运行MR分析 → 生成论文 → 上传OSS → finish消息
- 并发支持：最多 MAX_CONCURRENT_SESSIONS 个会话同时运行
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from contextvars import ContextVar
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

import aiohttp
import requests as _requests
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# 加载自身 .env
load_dotenv(Path(__file__).parent / ".env", override=False)
load_dotenv(Path(__file__).parent / "deploy.env", override=True)
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)
# GWAS 搜索诊断日志（DEBUG 级别可见关键词匹配细节）
logging.getLogger("mr_agent.tools.gwas").setLevel(logging.DEBUG)

AGENT_TYPE  = "mendelian-randomization"
MR_ROOT     = Path(__file__).parent

# JAVA_WS_URL = os.getenv("JAVA_WS_URL", "ws://192.168.20.252:2066/ws/ws")
# JAVA_TOKEN_URL = os.getenv(
#     "JAVA_TOKEN_URL",
#     f"http://192.168.20.252:2066/api-evimed/ai-agent/token?clientType={AGENT_TYPE}",
# )
JAVA_WS_URL = os.getenv("JAVA_WS_URL", "wss://evidence-factory.evimed.com/ws/ws")
JAVA_TOKEN_URL = os.getenv(
    "JAVA_TOKEN_URL",
    f"https://evidence-factory.evimed.com/api-evimed/ai-agent/token?clientType={AGENT_TYPE}",
)
OSS_ACCESS_KEY_ID     = os.getenv("OSS_ACCESS_KEY_ID")
OSS_ACCESS_KEY_SECRET = os.getenv("OSS_ACCESS_KEY_SECRET")
OSS_ENDPOINT          = os.getenv("OSS_ENDPOINT", "https://oss-cn-beijing.aliyuncs.com")
OSS_BUCKET_NAME       = os.getenv("OSS_BUCKET_NAME", "project-beijing-a4hznzutlh")
OSS_PUBLIC_BASE_URL   = os.getenv("OSS_PUBLIC_BASE_URL", "https://image.evimed.com/oss")
SERVICE_PORT          = int(os.getenv("SERVICE_PORT", "8003"))
MAX_SESSIONS          = int(os.getenv("MAX_CONCURRENT_SESSIONS", "8"))

_java_client_task: asyncio.Task = None
_pipeline_executor = ThreadPoolExecutor(
    max_workers=MAX_SESSIONS,
    thread_name_prefix="mr-pipeline",
)

# ─────────────── 工具函数 ───────────────

def _make_ts() -> list:
    now = datetime.now()
    return [now.year, now.month, now.day, now.hour, now.minute, now.second, now.microsecond * 1000]


OPENGWAS_API_BASE = "https://api.opengwas.io/api"
OPENGWAS_REGISTER_URL = "https://api.opengwas.io/"

# 会话级 OpenGWAS JWT — 使用 ContextVar 替代 os.environ，避免并发用户之间的 token 覆盖
_OPENGWAS_JWT: ContextVar[str] = ContextVar("OPENGWAS_JWT", default="")
# 将 .env 中预置的 OpenGWAS Token 初始化到 ContextVar（作为默认值）
_env_gwas_token = os.getenv("OPENGWAS_JWT", "").strip()
if _env_gwas_token:
    _OPENGWAS_JWT.set(_env_gwas_token)

# 单次 MR 分析全流程的外层超时（秒）。R 子进程单次默认 900s（MR_R_TIMEOUT_SEC），
# 一次会话可能跑 3+ GWAS 对外加双向分析与解读，预留足够 budget。
_MR_PIPELINE_TIMEOUT_SEC = float(os.getenv("MR_PIPELINE_TIMEOUT_SEC", "3600"))

# 论文生成阶段的超时（秒）。STROBE-MR 合规检查 + 数值一致性修正会触发多次 LLM 调用，
# 整体常常 12–18 分钟，原 600s 远不够。env 可调。
_MR_PAPER_TIMEOUT_SEC = float(os.getenv("MR_PAPER_TIMEOUT_SEC", "1800"))


def _validate_opengwas_token(token: str) -> tuple[bool, str]:
    """验证 OpenGWAS JWT token 是否有效。

    Returns:
        (is_valid, error_msg) — 有效时 error_msg 为空
    """
    if not token or not token.strip():
        return False, "未提供 OpenGWAS Token"
    token = token.strip()
    try:
        resp = _requests.post(
            f"{OPENGWAS_API_BASE}/gwasinfo",
            json={},
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
        )
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, dict) and len(data) > 0:
                return True, ""
            if isinstance(data, dict):
                return True, ""
        if resp.status_code == 401 or resp.status_code == 403:
            return False, "Token 已过期或无效（HTTP 401/403）"
        return False, f"Token 验证失败（HTTP {resp.status_code}）"
    except _requests.Timeout:
        return False, "OpenGWAS 服务连接超时，请稍后重试"
    except Exception as e:
        return False, f"Token 验证异常: {e}"


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


async def _upload_report(content: str, user_id: str, message_id: str) -> Optional[str]:
    """上传论文 Markdown 到 OSS，返回公开 URL；失败降级为 None。"""
    if not OSS_ACCESS_KEY_ID or not OSS_ACCESS_KEY_SECRET:
        logger.warning("OSS 凭证未配置，跳过上传")
        return None
    remote_path = f"{AGENT_TYPE}/{user_id}/{message_id}/{int(time.time() * 1000)}.md"
    data = content.encode("utf-8")

    def _upload_sync():
        import oss2
        auth   = oss2.Auth(OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET)
        bucket = oss2.Bucket(auth, OSS_ENDPOINT, OSS_BUCKET_NAME)
        for attempt in range(3):
            try:
                bucket.put_object(remote_path, data)
                logger.info(f"OSS 上传成功（第{attempt + 1}次）: {remote_path}")
                return
            except Exception as e:
                logger.warning(f"OSS 上传失败（第{attempt + 1}次）: {e}")
                if attempt < 2:
                    time.sleep(2 ** attempt)
                else:
                    raise

    try:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, _upload_sync)
        return f"{OSS_PUBLIC_BASE_URL}/{remote_path}"
    except Exception as e:
        logger.error(f"OSS 上传最终失败，降级为 base64 返回: {e}")
        return None


# ─────────────── 论文 Markdown 组装 ───────────────

_SECTION_ORDER = [
    "title", "abstract", "introduction", "methods", "results",
    "discussion", "limitations", "conclusion",
    "data_availability", "ethics_statement", "table1", "table2", "references",
]

_SECTION_HEADERS_ZH = {
    "abstract": "摘要", "introduction": "前言", "methods": "方法",
    "results": "结果", "discussion": "讨论", "limitations": "局限性",
    "conclusion": "结论", "data_availability": "数据可用性声明",
    "ethics_statement": "伦理声明", "table1": "表1", "table2": "表2",
    "references": "参考文献",
}

_SECTION_HEADERS_EN = {
    "abstract": "Abstract", "introduction": "Introduction", "methods": "Methods",
    "results": "Results", "discussion": "Discussion", "limitations": "Limitations",
    "conclusion": "Conclusion", "data_availability": "Data Availability",
    "ethics_statement": "Ethics Statement", "table1": "Table 1", "table2": "Table 2",
    "references": "References",
}


_NUMBERED_SECTION_KEYS = {
    "introduction", "methods", "results", "discussion",
    "limitations", "conclusion", "data_availability", "ethics_statement",
}

_ZH_NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]


def _to_zh_numeral(n: int) -> str:
    return _ZH_NUMERALS[n - 1] if 1 <= n <= len(_ZH_NUMERALS) else str(n)


def _build_paper_markdown(state, language: str = "zh") -> str:
    """将 SessionState.paper_sections 组装为完整 Markdown 论文。"""
    paper = state.paper_sections
    if not paper:
        return ""

    headers = _SECTION_HEADERS_ZH if language == "zh" else _SECTION_HEADERS_EN

    parts = []
    title = paper.get("title", "")
    if title:
        parts.append(f"# {title}")
    else:
        slots = getattr(state, "slots", None)
        exp = (getattr(slots, "exposure", None) or "") if slots else ""
        out = (getattr(slots, "outcome", None) or "") if slots else ""
        sep = " 与 " if language == "zh" else " and "
        parts.append(
            f"# 孟德尔随机化研究：{exp}{sep}{out}" if language == "zh"
            else f"# Mendelian Randomization: {exp}{sep}{out}"
        )

    sec_num = 0
    for key in _SECTION_ORDER[1:]:
        content = paper.get(key, "").strip()
        if not content:
            continue
        header = headers.get(key, key.replace("_", " ").title())
        if key in _NUMBERED_SECTION_KEYS:
            sec_num += 1
            if language == "zh":
                parts.append(f"\n## {_to_zh_numeral(sec_num)}、{header}\n\n{content}")
            else:
                parts.append(f"\n## {sec_num}. {header}\n\n{content}")
        else:
            parts.append(f"\n## {header}\n\n{content}")

    return "\n\n".join(parts)


# ─────────────── 语言检测 ───────────────

_CJK_RE = re.compile(r'[\u4e00-\u9fff\u3400-\u4dbf]')

def _detect_language(text: str) -> str:
    """根据输入文本判断语言：含中文字符→'zh'，否则→'en'。"""
    return "zh" if _CJK_RE.search(text) else "en"


# ─────────────── MRAgent 工厂 ───────────────

def _create_agent(session_id: str, progress_cb, language: str = "zh") -> object:
    """初始化 MRAgent，注入 LLM 和 on_message 回调。"""
    src_path = str(MR_ROOT)
    if src_path not in sys.path:
        sys.path.insert(0, src_path)

    from mr_agent.core.engine import MRAgent
    from mr_agent.llm.client import get_llm

    llm = get_llm(
        provider=os.getenv("LLM_PROVIDER", "deepseek"),
    )
    agent = MRAgent(llm=llm, language=language, on_message=progress_cb)
    return agent


# ─────────────── 变量解析 ───────────────

def _extract_slots_from_input(input_text: str) -> tuple[str, str]:
    """从用户输入中提取暴露变量和结局变量。先尝试正则，失败则用 LLM。"""
    import re as _re, json as _json

    # 去除尾部描述性短语，保留核心 trait 名称
    _SUFFIX_RE = _re.compile(
        r'(的?(?:因果效应|因果关系|因果影响|发病风险|发生风险|风险|患病风险|'
        r'的影响|的关系|之间的关系|之间))+$'
    )

    def _clean(s: str) -> str:
        return _SUFFIX_RE.sub("", s.strip()).strip()

    # 常见格式：A→B / A和B / A与B / A对B的影响
    patterns = [
        r'^(.+?)\s*[→\->]+\s*(.+)$',
        r'^(?:分析|研究|探讨|评估|我想研究|我想分析)?(.+?)\s*(?:和|与|对)\s*(.+?)$',
    ]
    for pat in patterns:
        m = _re.search(pat, input_text.strip(), _re.IGNORECASE)
        if m:
            exp = _clean(m.group(1))
            out = _clean(m.group(2))
            for prefix in ['分析', '研究', '探讨', '评估', '我想研究', '我想分析']:
                if exp.startswith(prefix):
                    exp = exp[len(prefix):].strip()
            if exp and out and len(exp) < 80 and len(out) < 80:
                return exp, out

    # 回退到 LLM 提取
    try:
        from mr_agent.llm.client import get_llm
        llm = get_llm(
            provider=os.getenv("LLM_PROVIDER", "deepseek"),
        )
        prompt = (
            "从以下文本提取孟德尔随机化研究的暴露变量和结局变量。\n\n"
            f"文本：{input_text}\n\n"
            "要求：只提取核心疾病/表型名称，不包含「风险」「因果效应」「的影响」等描述性词语。\n"
            "例如：「咖啡摄入对2型糖尿病风险的因果效应」→ exposure=咖啡摄入, outcome=2型糖尿病\n"
            '以JSON返回：{"exposure": "暴露变量", "outcome": "结局变量"}\n'
            '若无法识别，返回 {"exposure": "", "outcome": ""}。只返回JSON，不要其他内容。'
        )
        result = llm.chat_json(
            messages=[{"role": "user", "content": prompt}],
            max_tokens=150,
            model_tier="flash",
        )
        if isinstance(result, dict):
            return _clean(result.get("exposure", "")), _clean(result.get("outcome", ""))
    except Exception as e:
        logger.warning(f"变量提取失败: {e}")
    return "", ""


# ─────────────── 会话处理 ───────────────

MR_STEPS = [
    "解析暴露因素与结局变量",
    "检索GWAS关联数据",
    "执行孟德尔随机化分析",
    "解读统计分析结果",
    "生成研究论文",
]

_QUESTION_RE = re.compile(r'[？?]|^.{0,10}(什么|为什么|怎么|如何|哪些|哪个|多少|是否|能不能|可以|吗|呢)')
_MR_KEYWORDS = {"mr", "孟德尔", "随机化", "因果", "gwas", "遗传", "暴露", "结局", "instrument", "iv"}

_GREETING_PATTERNS_MR = re.compile(
    r'^(你好|您好|hi|hello|hey|嗨|哈喽|在吗|在不在|你是谁|你是什么|介绍一下你自己|你能做什么|你有什么功能|help|帮助)',
    re.IGNORECASE,
)


async def _classify_intent_mr(text: str, session_ctx: dict) -> str:
    t = text.strip()
    if not t:
        return "other"
    if _GREETING_PATTERNS_MR.match(t):
        return "greeting"
    has_report = bool(session_ctx.get("last_report"))
    if not has_report:
        return "new_analysis"
    api_key = os.getenv("DEEPSEEK_API_KEY", "")
    base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    model = os.getenv("DEEPSEEK_FLASH_MODEL", "deepseek-v4-flash")
    if not api_key:
        return _fallback_intent_mr(t)
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=api_key, base_url=base_url or None)
        resp = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": (
                    "你是一个意图分类器。根据用户输入和上下文，判断用户意图。"
                    "只能回复以下标签之一：\n"
                    "- new_analysis: 用户想进行一项新的孟德尔随机化分析（包含暴露、结局、因果等关键词）\n"
                    "- followup: 用户在追问之前 MR 分析报告中的内容\n"
                    "- greeting: 打招呼、闲聊、询问功能\n"
                    "- other: 无法判断\n"
                    "只回复标签名，不要回复其他内容。"
                )},
                {"role": "user", "content": (
                    f"当前会话已完成的分析主题：{session_ctx.get('last_topic', '无')}\n\n"
                    f"用户输入：{t}"
                )},
            ],
            max_tokens=10,
            temperature=0,
            extra_body={"thinking": {"type": "disabled"}},
        )
        label = resp.choices[0].message.content.strip().lower() if resp.choices else ""
        if label in ("new_analysis", "followup", "greeting", "other"):
            return label
    except Exception as e:
        logger.warning(f"意图分类 LLM 调用失败: {e}")
    return _fallback_intent_mr(t)


def _fallback_intent_mr(text: str) -> str:
    t = text.strip()
    if len(t) > 100:
        return "new_analysis"
    if not _QUESTION_RE.search(t):
        return "new_analysis"
    lower = t.lower()
    if any(kw in lower for kw in _MR_KEYWORDS):
        has_connector = any(w in t for w in ["和", "与", "对", "→", "->", "引起", "导致", "影响", "关系"])
        if has_connector and len(t) > 8:
            return "new_analysis"
    return "followup"


async def _handle_session(
    parent_id: str,
    msg_queue: asyncio.Queue,
    python_client_id: str,
    ws_send,
    first_sender_id: str,
    user_id: str,
):
    """多轮对话：接收用户消息，执行 MR 分析或回答追问。"""
    session_id     = parent_id
    loop           = asyncio.get_running_loop()
    current_target = first_sender_id
    _TW_CHUNK      = 8
    _TW_DELAY      = 0.03
    session_ctx    = {"last_topic": "", "last_report": "", "analysis_summary": "", "chat_history": []}

    # ── 消息封装工具 ──
    def _wrap(payload: dict, msg_id: str) -> str:
        content = payload.get("content", {})
        if isinstance(content, (dict, list)):
            content = json.dumps(content, ensure_ascii=False)
        return json.dumps({
            "type": "text",
            "userId": user_id,
            "parentId": session_id,
            "id": msg_id,
            "senderType": AGENT_TYPE,
            "senderId": python_client_id,
            "targetClientId": current_target,
            "timestamp": _make_ts(),
            "agentType": payload.get("agentType", AGENT_TYPE),
            "content": content,
        }, ensure_ascii=False)

    async def send_msg(payload: dict, msg_id: str):
        try:
            await ws_send(_wrap(payload, msg_id))
        except Exception as e:
            logger.warning(f"发送消息失败: {e}")

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
                "id": msg_id, "parentId": session_id, "agentType": AGENT_TYPE,
                "content": {"clazz": "agent", "type": "stream", "data": data},
            }, msg_id)
            await asyncio.sleep(_TW_DELAY)

    async def push_tool_call(label: str, msg_id: str, str_val: str = "正在分析"):
        await send_msg({
            "id": msg_id, "parentId": session_id, "agentType": AGENT_TYPE,
            "content": {"clazz": "agent", "type": "raw",
                        "data": {"type": "tool_call", "str": str_val,
                                 "front_display": label, "inprogress": True}},
        }, msg_id)

    _doing_sent: set[int] = set()

    async def send_status(step_index: int, step_status: str, msg_id: str):
        """推送任务步骤状态（doing/done/todo）。

        去重：同一 step_index 只发送一次 "doing"，防止前端为同一步骤
        创建多个折叠面板。
        """
        if step_status == "doing":
            if step_index in _doing_sent:
                logger.debug(f"send_status 去重: step {step_index} 已发送 doing，跳过")
                return
            _doing_sent.add(step_index)
        status_list = []
        for i, title in enumerate(MR_STEPS):
            if i < step_index:
                status_list.append({"status": "done", "title": title})
            elif i == step_index:
                status_list.append({"status": step_status, "title": title})
            else:
                status_list.append({"status": "todo", "title": title})
        await send_msg({
            "id": msg_id, "parentId": session_id, "agentType": AGENT_TYPE,
            "content": {"clazz": "agent", "type": "status",
                        "data": {"item": status_list, "type": "task_status"}},
        }, msg_id)

    try:
        while True:
            # ── 1. 接收用户消息 ──
            try:
                user_msg = await asyncio.wait_for(msg_queue.get(), timeout=1800.0)
            except asyncio.TimeoutError:
                logger.warning(f"会话 {session_id} 空闲超时（30分钟），自动关闭")
                return

            if user_msg is None:
                return

            content = user_msg.get("content", {})
            if isinstance(content, str):
                try:
                    content = json.loads(content)
                except Exception:
                    pass

            input_text = (
                content.get("data", {}).get("content", "")
                or content.get("content", "")
                or content.get("text", "")
                or str(content)
            ).strip()

            if not input_text:
                continue

            current_target = user_msg.get("senderId", first_sender_id)
            message_id = str(uuid.uuid4())
            _doing_sent.clear()

            # ── 1.5 意图分类 ──
            intent = await _classify_intent_mr(input_text, session_ctx)
            logger.info(f"意图分类结果: {intent} | 输入: {input_text[:40]}")

            if intent == "greeting":
                await push_typewriter(
                    "你好！我是「孟德尔随机化分析助手」，专注于利用遗传变异作为工具变量进行因果推断分析。\n\n"
                    "我可以帮你：\n"
                    "- 自动从 GWAS 数据库检索暴露和结局的遗传关联数据\n"
                    "- 执行两样本孟德尔随机化分析（IVW、MR-Egger、WM 等）\n"
                    "- 生成包含敏感性分析的完整研究论文\n\n"
                    "请输入你的研究问题，例如：*BMI 对 2型糖尿病的因果影响*",
                    message_id, finished=True,
                )
                await send_msg({
                    "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "finish",
                                "data": {"md": "", "pdf": "", "name": "",
                                         "isFinished": True}},
                }, message_id)
                continue

            if intent == "followup" and session_ctx["last_report"]:
                try:
                    from mr_agent.llm.client import get_llm
                    _q_llm = get_llm(
                        provider=os.getenv("LLM_PROVIDER", "deepseek"),
                    )
                    chat_history: list = session_ctx.get("chat_history", [])
                    _messages = [
                        {"role": "system", "content": (
                            "你是一位资深孟德尔随机化和遗传流行病学专家。用户已完成一项 MR 分析，你手头有完整的研究论文。\n"
                            "请基于论文内容，深入、准确地回答用户的追问。\n\n"
                            "要求：\n"
                            "- 使用 Markdown 格式\n"
                            "- 引用论文中的具体统计数据（如 OR值、置信区间、p值、I²等）\n"
                            "- 如论文中无相关信息，明确告知并给出专业建议\n"
                            "- 绝不编造数据\n"
                            "- 用中文回复"
                        )},
                        {"role": "user", "content": (
                            f"## 分析主题\n{session_ctx.get('last_topic', '')}\n\n"
                            f"## 完整研究论文\n{session_ctx['last_report']}"
                        )},
                        {"role": "assistant", "content": "已了解论文全部内容，请随时提问。"},
                    ]
                    for h in chat_history[-10:]:
                        _messages.append(h)
                    _messages.append({"role": "user", "content": input_text})

                    _q_answer = _q_llm.chat(
                        messages=_messages,
                        max_tokens=3000,
                    )
                    await push_typewriter(_q_answer, message_id, finished=True)

                    session_ctx.setdefault("chat_history", []).append({"role": "user", "content": input_text})
                    session_ctx["chat_history"].append({"role": "assistant", "content": _q_answer})
                    if len(session_ctx["chat_history"]) > 20:
                        session_ctx["chat_history"] = session_ctx["chat_history"][-20:]
                except Exception as _qe:
                    await push_typewriter(
                        f"基于上次分析结果回答您的问题时出错：{_qe}",
                        message_id, finished=True,
                    )
                await send_msg({
                    "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "finish",
                                "data": {"md": "", "pdf": "", "name": "",
                                         "isFinished": True}},
                }, message_id)
                continue

            if intent == "other":
                await push_typewriter(
                    f"「{input_text[:40]}」——我暂时无法判断这是否为一个孟德尔随机化研究问题。\n\n"
                    "如果你希望进行 MR 分析，请描述暴露因素和结局变量之间的关系，例如：\n"
                    "- BMI 对 2型糖尿病的因果影响\n"
                    "- 咖啡摄入对帕金森病的保护作用",
                    message_id, finished=True,
                )
                await send_msg({
                    "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "finish",
                                "data": {"md": "", "pdf": "", "name": "",
                                         "isFinished": True}},
                }, message_id)
                continue

            # ── 2. 先解析变量，判断是否为 MR 研究问题 ──
            async def _flush_stream(msg_id: str):
                await send_msg({
                    "id": msg_id, "parentId": session_id, "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "text_finish", "data": {}},
                }, msg_id)

            await push_typewriter(
                f"正在解析「{input_text[:40]}」的研究变量，请稍候…",
                message_id, finished=False,
            )
            try:
                exposure, outcome = await asyncio.wait_for(
                    loop.run_in_executor(
                        _pipeline_executor, _extract_slots_from_input, input_text
                    ),
                    timeout=60.0,
                )
            except asyncio.TimeoutError:
                logger.error(f"会话 {session_id} 变量解析超时")
                await push_typewriter("变量解析超时，请重新发送您的研究问题。", message_id, finished=True)
                await send_msg({
                    "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "finish",
                                "data": {"md": "", "pdf": "", "name": "",
                                         "isFinished": True, "error": "变量解析超时"}},
                }, message_id)
                continue

            if not exposure or not outcome:
                input_lower = input_text.lower()
                _GREETING_PATTERNS = [
                    "你好", "你是谁", "你能做什么", "你能干什么", "帮我什么",
                    "hello", "hi", "who are you", "what can you",
                    "介绍", "功能", "使用", "怎么用", "帮助",
                ]
                is_greeting = any(p in input_lower for p in _GREETING_PATTERNS) and len(input_text) < 50

                if is_greeting:
                    await push_typewriter(
                        "您好！我是**孟德尔随机化分析助手**，可以帮您完成以下工作：\n\n"
                        "- 根据研究问题自动检索 GWAS 数据\n"
                        "- 执行多种 MR 分析方法（IVW、MR-Egger、Weighted Median 等）\n"
                        "- 解读统计分析结果并生成完整研究论文\n\n"
                        "请在下方输入您想研究的问题，例如：\n"
                        "- 「咖啡摄入对2型糖尿病的因果效应」\n"
                        "- 「BMI 和冠心病的关系」",
                        message_id, finished=True,
                    )
                else:
                    await push_typewriter(
                        "未能从您的问题中识别出**暴露因素**和**结局变量**，请重新描述，例如：\n\n"
                        "- 「BMI 和 2型糖尿病」\n"
                        "- 「体重指数 → 冠心病」\n"
                        "- 「分析吸烟对肺癌的影响」",
                        message_id, finished=True,
                    )
                await send_msg({
                    "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "finish",
                                "data": {"md": "", "pdf": "", "name": "",
                                         "isFinished": True, "error": "无法解析研究变量"}},
                }, message_id)
                continue

            await _flush_stream(message_id)

            # ── 3. 验证 OpenGWAS Token ──
            _session_gwas_token: str = ""
            gwas_jwt_env = _OPENGWAS_JWT.get().strip()

            if gwas_jwt_env:
                await push_typewriter(
                    "正在验证 OpenGWAS 服务连接，请稍候…",
                    message_id, finished=False,
                )
                try:
                    is_valid, err = await asyncio.wait_for(
                        loop.run_in_executor(
                            _pipeline_executor, _validate_opengwas_token, gwas_jwt_env
                        ),
                        timeout=30.0,
                    )
                except asyncio.TimeoutError:
                    is_valid, err = False, "验证超时"
                    logger.warning("OpenGWAS Token 验证超时（30秒）")
                if is_valid:
                    _session_gwas_token = gwas_jwt_env
                    await push_typewriter(
                        "✅ OpenGWAS 服务连接验证通过",
                        message_id, finished=False,
                    )
                    await _flush_stream(message_id)
                    logger.info("全局 OPENGWAS_JWT 验证通过")
                else:
                    logger.warning(f"全局 OPENGWAS_JWT 已失效: {err}")

            if not _session_gwas_token:
                if gwas_jwt_env:
                    await push_typewriter(
                        f"⚠️ 服务器预置的 OpenGWAS Token 已失效（{err}），需要您提供个人 Token。\n\n",
                        message_id, finished=False,
                    )
                    await _flush_stream(message_id)
                await push_typewriter(
                    "孟德尔随机化分析需要 **OpenGWAS Token** 才能获取 GWAS 数据。\n\n"
                    "请按以下步骤操作：\n\n"
                    f"**1.** 注册 OpenGWAS 账号：[点击注册]({OPENGWAS_REGISTER_URL})\n\n"
                    "**2.** 登录后在个人设置页面获取 API Token\n\n"
                    "**3.** 将 Token 复制后**直接粘贴发送给我**即可开始分析\n\n"
                    "---\n\n"
                    "如果您已有 Token，请直接粘贴发送。",
                    message_id, finished=False,
                )
                await _flush_stream(message_id)
                await send_msg({
                    "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "finish",
                                "data": {"md": "", "pdf": "", "name": "",
                                         "isFinished": True}},
                }, message_id)

                token_received = False
                for _attempt in range(5):
                    try:
                        token_msg = await asyncio.wait_for(msg_queue.get(), timeout=1800.0)
                    except asyncio.TimeoutError:
                        await push_typewriter("等待超时，请重新发送您的研究问题。", message_id, finished=True)
                        return

                    if token_msg is None:
                        return

                    token_content = token_msg.get("content", {})
                    if isinstance(token_content, str):
                        try:
                            token_content = json.loads(token_content)
                        except Exception:
                            pass

                    candidate = (
                        token_content.get("data", {}).get("content", "")
                        or token_content.get("data", {}).get("text", "")
                        or token_content.get("content", "")
                        or token_content.get("text", "")
                        or ""
                    ).strip()

                    current_target = token_msg.get("senderId", current_target)

                    if not candidate:
                        continue

                    _TOKEN_RE = re.compile(r'^[A-Za-z0-9\-_./+=]+$')
                    is_likely_token = (
                        _TOKEN_RE.match(candidate)
                        and len(candidate) >= 50
                        and (candidate.startswith("eyJ") or "." in candidate)
                    )

                    if is_likely_token or len(candidate) > 80:
                        await push_typewriter(
                            "正在验证您提供的 Token，请稍候…",
                            message_id, finished=False,
                        )
                        try:
                            is_valid, err = await asyncio.wait_for(
                                loop.run_in_executor(
                                    _pipeline_executor, _validate_opengwas_token, candidate
                                ),
                                timeout=30.0,
                            )
                        except asyncio.TimeoutError:
                            is_valid, err = False, "验证超时"
                        if is_valid:
                            _session_gwas_token = candidate
                            token_received = True
                            await push_typewriter(
                                "✅ Token 验证通过，正在准备分析环境…",
                                message_id, finished=False,
                            )
                            await _flush_stream(message_id)
                            break
                        else:
                            await push_typewriter(
                                f"❌ Token 验证失败：{err}\n\n"
                                "请检查 Token 是否完整复制，或重新获取后发送。\n\n"
                                f"如需注册新账号，请访问：{OPENGWAS_REGISTER_URL}",
                                message_id, finished=True,
                            )
                            await _flush_stream(message_id)
                            await send_msg({
                                "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                                "content": {"clazz": "agent", "type": "finish",
                                            "data": {"md": "", "pdf": "", "name": "",
                                                     "isFinished": True, "error": f"Token 验证失败：{err}"}},
                            }, message_id)
                            return
                    else:
                        await push_typewriter(
                            "⚠️ 您发送的内容不是有效的 Token 格式。\n\n"
                            "Token 通常是一串很长的字符，以 `eyJ` 开头，包含多个 `.` 分隔符。\n\n"
                            f"如需获取 Token，请访问：{OPENGWAS_REGISTER_URL}\n\n"
                            "请直接粘贴 Token 发送，或重新发送研究问题开始新的会话。",
                            message_id, finished=True,
                        )
                        await _flush_stream(message_id)
                        await send_msg({
                            "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                            "content": {"clazz": "agent", "type": "finish",
                                        "data": {"md": "", "pdf": "", "name": "",
                                                 "isFinished": True, "error": "Token 格式无效"}},
                        }, message_id)
                        return
                else:
                    await push_typewriter(
                        "Token 输入尝试次数过多，请重新发送研究问题开始新的会话。",
                        message_id, finished=True,
                    )
                    await send_msg({
                        "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                        "content": {"clazz": "agent", "type": "finish",
                                    "data": {"md": "", "pdf": "", "name": "",
                                             "isFinished": True}},
                    }, message_id)
                    return

                if not _session_gwas_token:
                    await push_typewriter(
                        "未收到有效 Token，无法进行孟德尔随机化分析。\n\n"
                        f"请先注册获取 Token：{OPENGWAS_REGISTER_URL}\n\n"
                        "获取 Token 后，重新发送您的研究问题即可。",
                        message_id, finished=True,
                    )
                    await send_msg({
                        "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                        "content": {"clazz": "agent", "type": "finish",
                                    "data": {"md": "", "pdf": "", "name": "",
                                             "isFinished": True}},
                    }, message_id)
                    return

            # ── 4. 发任务计划（变量解析成功后才创建）──
            await send_msg({
                "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                "content": {"clazz": "agent", "type": "orchestra",
                            "data": {"type": "plan",
                                     "item": {
                                         "analysis": f"孟德尔随机化分析：{input_text[:40]}",
                                         "todo": MR_STEPS,
                                     }, "isFinished": True}},
            }, message_id)

            # ── 5. 显示步骤状态 ──
            await send_status(0, "doing", message_id)
            await push_tool_call("正在解析研究变量…", message_id, "正在搜索")

            await push_typewriter(
                f"解析暴露因素与结局变量完成\n\n"
                f"**暴露因素**：{exposure}\n\n"
                f"**结局变量**：{outcome}",
                message_id, finished=False,
            )
            await send_status(0, "done", message_id)

            # ── 6. 检测语言 & 初始化 Agent ──
            paper_lang = _detect_language(input_text)
            logger.info(f"论文语言检测: input='{input_text[:30]}' → language='{paper_lang}'")
            await send_status(1, "doing", message_id)
            await push_tool_call(f"正在检索 {exposure} 和 {outcome} 的GWAS数据…", message_id, "正在搜索")

            # 步骤状态追踪：pipeline 通过 on_message 发送 "[XX%] 消息"
            # pct 0-49% → step1(检索), 50-74% → step2(执行MR), 75-99% → step3(解读)
            _step_state = {"current": 1}

            # 关键里程碑：只有这些才显示为 tool_call，其余静默
            _KEY_MILESTONES = (
                "检索GWAS", "执行MR分析", "解读分析结果",
                "MR分析完成", "双向分析", "正在解析研究变量",
            )

            def _get_analysis_step(pct: float) -> int:
                if pct < 0.50:
                    return 1
                if pct < 0.75:
                    return 2
                return 3

            def _progress_cb(msg: str):
                import re as _re
                m = _re.search(r'\[(\d+)%\]', msg)
                pct = int(m.group(1)) / 100 if m else 0.0
                new_step = _get_analysis_step(pct)
                label = (msg.split('] ', 1)[-1] if '] ' in msg else msg)[:60]
                str_val = "正在搜索" if new_step == 1 else "正在分析"
                logger.info(f"[分析进度] {msg}")

                # 同步判断步骤切换，立即更新状态，防止快速连续回调导致重复切换
                _transition = None
                if new_step != _step_state["current"]:
                    _transition = (_step_state["current"], new_step)
                    _step_state["current"] = new_step

                async def _do():
                    if _transition:
                        old, new = _transition
                        await send_status(old, "done", message_id)
                        await send_status(new, "doing", message_id)
                    # 仅关键里程碑显示为 tool_call
                    if any(kw in msg for kw in _KEY_MILESTONES):
                        await push_tool_call(label, message_id, str_val)

                asyncio.run_coroutine_threadsafe(_do(), loop)

            try:
                agent = await asyncio.wait_for(
                    loop.run_in_executor(
                        _pipeline_executor, _create_agent, session_id, _progress_cb, paper_lang
                    ),
                    timeout=30.0,
                )
            except Exception as e:
                logger.error(f"Agent 初始化失败: {e}", exc_info=True)
                await push_typewriter(f"服务初始化失败：{e}", message_id)
                await send_msg({
                    "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "finish",
                                "data": {"md": "", "pdf": "", "name": "",
                                         "isFinished": True, "error": str(e)}},
                }, message_id)
                continue

            # ── 7. 设置分析变量 & 注入 token 到运行环境 ──
            agent.state.slots.exposure = exposure
            agent.state.slots.outcome  = outcome
            if _session_gwas_token:
                agent.state.slots.gwas_token = _session_gwas_token
                _OPENGWAS_JWT.set(_session_gwas_token)
                # 同步 GWAS 代码跑在 ThreadPoolExecutor 中，ContextVar 不会传播到线程，
                # 因此同时设置 os.environ 作为同步代码的后备读取路径
                os.environ["OPENGWAS_JWT"] = _session_gwas_token
                try:
                    import mr_agent.tools.gwas as _gwas_mod
                    with _gwas_mod._gwas_db_lock:
                        _gwas_mod._gwas_db_cache = None
                    logger.info("已将用户 Token 注入 ContextVar + os.environ 并清除 GWAS 缓存")
                except Exception as _e:
                    logger.warning(f"清除 GWAS 缓存异常（非致命）: {_e}")
            else:
                logger.warning("无有效 OpenGWAS Token，R分析可能因认证失败而无法获取GWAS数据")

            # ── 8. 运行 MR 分析（步骤1-3，由 _progress_cb 驱动状态切换）──
            try:
                await asyncio.wait_for(
                    loop.run_in_executor(_pipeline_executor, agent._run_analysis),
                    timeout=_MR_PIPELINE_TIMEOUT_SEC,
                )
            except asyncio.TimeoutError:
                logger.error(f"会话 {session_id} MR 分析超时（{int(_MR_PIPELINE_TIMEOUT_SEC)}秒）")
                await push_typewriter("MR 分析执行超时，请稍后重试。", message_id, finished=True)
                await send_msg({
                    "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "finish",
                                "data": {"md": "", "pdf": "", "name": "",
                                         "isFinished": True, "error": "MR分析超时"}},
                }, message_id)
                continue
            except Exception as e:
                logger.error(f"MR 分析失败: {e}", exc_info=True)
                await push_typewriter(f"分析失败：{e}", message_id)
                await send_msg({
                    "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "finish",
                                "data": {"md": "", "pdf": "", "name": "",
                                         "isFinished": True, "error": str(e)}},
                }, message_id)
                continue

            # 检查是否产生了有效分析结果（R未安装/GWAS无数据/R脚本执行失败时）
            _results = agent.state.analysis_results
            _all_failed = (
                not _results
                or all(r.n_instruments == 0 for r in _results)
            )
            if _all_failed:
                errors = agent.state.errors
                err_detail = errors[-1] if errors else "未找到有效的GWAS数据或分析未能完成"
                # 识别 R 未安装的特定错误
                is_r_missing = any("Rscript not found" in e or "R environment" in e for e in errors)
                if is_r_missing:
                    tip = "服务器未安装R语言环境，请执行：`sudo apt install r-base`"
                elif _results:
                    # R runs but produced 0 instruments — show which IDs were tried
                    tried = ", ".join(
                        f"{r.exposure_id}→{r.outcome_id}" for r in _results
                    )
                    no_jwt = not _session_gwas_token
                    jwt_hint = "（Token 可能已失效，请重新获取后发送）" if no_jwt else ""
                    tip = f"R分析未产生有效工具变量（IVs=0）{jwt_hint}。尝试的GWAS对：{tried}\n原因：{err_detail}"
                else:
                    tip = f"原因：{err_detail}"
                logger.warning(f"分析结果无效: {tip}")
                await push_typewriter(
                    f"分析未能产生结果，无法生成报告。\n\n{tip}",
                    message_id,
                )
                await send_msg({
                    "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "finish",
                                "data": {"md": "", "pdf": "", "name": "",
                                         "isFinished": True, "error": tip}},
                }, message_id)
                continue

            # 分析完成，生成步骤3总结（在 done 之前发送，进入折叠面板）
            _n_pairs = len(_results)
            _n_ivs = sum(r.n_instruments for r in _results)
            _methods_used = set()
            for r in _results:
                for mr in (r.mr_results or []):
                    if mr.method:
                        _methods_used.add(mr.method)
            _methods_str = "、".join(sorted(_methods_used)) if _methods_used else "IVW、MR-Egger、Weighted Median"
            _sig_count = 0
            from mr_agent.models import find_ivw
            for r in _results:
                ivw = find_ivw(r.mr_results or [])
                if ivw and ivw.pval is not None and ivw.pval < 0.05:
                    _sig_count += 1
            await push_typewriter(
                f"解读统计分析结果完成\n\n"
                f"共 **{_n_pairs}** 个暴露-结局分析对，使用 **{_n_ivs}** 个工具变量（IV）\n\n"
                f"分析方法：{_methods_str}\n\n"
                f"其中 **{_sig_count}** 个分析对具有统计学显著性（p < 0.05）",
                message_id, finished=False,
            )
            # send_status(3, "done") 会把 0-3 全部显示为 done，step4 为 todo
            await send_status(3, "done", message_id)
            # ── 9. 生成论文（步骤4）──
            logger.info(f"分析完成，共 {len(_results)} 个结果，开始生成论文…")
            await send_status(4, "doing", message_id)
            await push_tool_call("正在撰写研究论文…", message_id, "正在写作")

            _PAPER_MILESTONES = (
                "撰写引言", "撰写方法", "撰写结果", "撰写讨论",
                "撰写结论", "撰写摘要", "一致性审查", "论文撰写完成",
            )

            def _paper_progress_cb(msg: str):
                logger.info(f"[论文进度] {msg}")

                async def _do():
                    if any(kw in msg for kw in _PAPER_MILESTONES):
                        label = (msg.split('] ', 1)[-1] if '] ' in msg else msg)[:60]
                        await push_tool_call(label, message_id, "正在写作")

                asyncio.run_coroutine_threadsafe(_do(), loop)
            agent.on_message = _paper_progress_cb

            try:
                await asyncio.wait_for(
                    loop.run_in_executor(
                        _pipeline_executor, agent._run_paper_generation
                    ),
                    timeout=_MR_PAPER_TIMEOUT_SEC,
                )
                logger.info(f"会话 {session_id} 论文生成 executor 已返回")
            except asyncio.TimeoutError:
                logger.error(f"会话 {session_id} 论文生成超时（{int(_MR_PAPER_TIMEOUT_SEC)}秒）")
                await push_typewriter("论文生成超时，正在用分析数据生成简化报告…", message_id, finished=False)
                # 超时后尝试用确定性回退生成报告
                try:
                    from mr_agent.paper.generator import PaperGenerator
                    gen = PaperGenerator(agent.llm, agent.state, on_message=lambda *_: None, language=paper_lang)
                    paper = gen._deterministic_fallback_paper(agent.state.paper_sections or {})
                    agent.state.paper_sections = paper
                except Exception:
                    pass
            except Exception as e:
                logger.error(f"论文生成失败: {e}", exc_info=True)
                await push_typewriter(f"论文生成失败：{e}", message_id)
                await send_msg({
                    "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "finish",
                                "data": {"md": "", "pdf": "", "name": "",
                                         "isFinished": True, "error": str(e)}},
                }, message_id)
                continue

            # ── 10. 组装 Markdown 并推送 finish ──
            logger.info(f"会话 {session_id} 推送论文完成 stream")
            await push_typewriter(
                "生成研究论文完成\n\n"
                "已生成符合 **STROBE-MR** 规范的孟德尔随机化研究论文，"
                "包含摘要、引言、方法、结果、讨论、局限性、结论等章节",
                message_id, finished=False,
            )
            await send_status(4, "done", message_id)
            paper_md = _build_paper_markdown(agent.state, paper_lang)
            logger.info(f"会话 {session_id} 论文 Markdown 组装完成 ({len(paper_md)} 字符)")
            if not paper_md:
                logger.warning(f"会话 {session_id} paper_md 为空，agent.state.paper_sections={bool(agent.state.paper_sections)}")
                await push_typewriter("论文内容为空，分析可能未成功完成。", message_id)
                await send_msg({
                    "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "finish",
                                "data": {"md": "", "pdf": "", "name": "",
                                         "isFinished": True, "error": "论文内容为空"}},
                }, message_id)
                continue

            # 上传 OSS
            logger.info(f"会话 {session_id} 开始 OSS 上传 ({len(paper_md)} 字符)")
            oss_url  = await _upload_report(paper_md, user_id, message_id)
            md_value = oss_url if oss_url else (
                "data:text/markdown;base64,"
                + base64.b64encode(paper_md.encode("utf-8")).decode()
            )

            exp_short = (agent.state.slots.exposure or exposure)[:10]
            out_short = (agent.state.slots.outcome or outcome)[:10]
            report_name = f"孟德尔随机化_{exp_short}_{out_short}"

            # text_finish（与科研选题保持一致：先 text_finish，再 finish）
            await send_msg({
                "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                "content": {"clazz": "agent", "type": "text_finish", "data": {}},
            }, message_id)

            await send_msg({
                "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                "content": {"clazz": "agent", "type": "finish",
                            "data": {"md": md_value, "pdf": "",
                                     "name": report_name, "isFinished": True}},
            }, message_id)
            logger.info(f"会话 {session_id} 完成，OSS={oss_url or '降级base64'}")

            session_ctx["last_topic"] = input_text
            session_ctx["last_report"] = paper_md
            session_ctx["chat_history"] = []
            session_ctx["analysis_summary"] = (
                f"暴露：{exposure}，结局：{outcome}，"
                f"{len(_results)}个分析对，{len(_methods_used)}种方法"
            )

            if agent.state.output_dir:
                try:
                    import shutil
                    shutil.rmtree(agent.state.output_dir, ignore_errors=True)
                except Exception:
                    pass

    except Exception as e:
        logger.error(f"会话 {session_id} 异常退出: {e}", exc_info=True)


# ─────────────── Java WebSocket 客户端 ───────────────

async def _java_ws_client():
    import websockets
    active_sessions: Dict[str, dict] = {}

    while True:
        _hb_task = None
        try:
            token            = await _get_java_token()
            python_client_id = AGENT_TYPE

            logger.info(f"正在连接 Java WebSocket: {JAVA_WS_URL}")
            async with websockets.connect(
                JAVA_WS_URL,
                ping_interval=15,
                ping_timeout=10,
                close_timeout=5,
            ) as ws:
                await ws.send(json.dumps({
                    "type":       "auth",
                    "token":      token,
                    "clientType": AGENT_TYPE,
                    "userId":     python_client_id,
                    "agentType":  AGENT_TYPE,
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
                    uid       = msg.get("userId", "")

                    # ── 并发会话上限检查 ──
                    if parent_id not in active_sessions:
                        if len(active_sessions) >= MAX_SESSIONS:
                            logger.warning(
                                f"并发会话已达上限 {MAX_SESSIONS}，拒绝新会话: {parent_id}"
                            )
                            continue

                        q: asyncio.Queue = asyncio.Queue(maxsize=50)
                        t = asyncio.create_task(
                            _handle_session(
                                parent_id, q, python_client_id,
                                ws_send, sender_id, uid,
                            )
                        )
                        t.add_done_callback(
                            lambda _, pid=parent_id: active_sessions.pop(pid, None)
                        )
                        active_sessions[parent_id] = {"queue": q, "task": t}
                        logger.info(
                            f"新会话: parentId={parent_id}, sender={sender_id}, "
                            f"当前活跃={len(active_sessions)}/{MAX_SESSIONS}"
                        )

                    # 消息入队，队满则丢弃（防止内存溢出）
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
    global _java_client_task

    # 启动检查
    llm_key = os.getenv("DEEPSEEK_API_KEY")
    if not llm_key:
        logger.error(
            "未配置 LLM API Key！请在 .env 中设置 DEEPSEEK_API_KEY。"
        )
    if not OSS_ACCESS_KEY_ID or not OSS_ACCESS_KEY_SECRET:
        logger.warning("OSS 凭证未配置，论文将以 base64 降级返回（不影响功能）。")

    logger.info(
        f"孟德尔随机化分析服务启动 | port={SERVICE_PORT} "
        f"| LLM={os.getenv('LLM_PROVIDER','deepseek')}:"
        f"{os.getenv('DEEPSEEK_FLASH_MODEL','deepseek-v4-flash')}/"
        f"{os.getenv('DEEPSEEK_PRO_MODEL','deepseek-v4-pro')} "
        f"| Java={JAVA_WS_URL} | MaxSessions={MAX_SESSIONS}"
    )
    _java_client_task = asyncio.create_task(_java_ws_client())
    yield
    logger.info("孟德尔随机化分析服务关闭")
    if _java_client_task:
        _java_client_task.cancel()
        try:
            await _java_client_task
        except asyncio.CancelledError:
            pass
    _pipeline_executor.shutdown(wait=False)


app = FastAPI(title="孟德尔随机化分析服务", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": AGENT_TYPE,
        "port": SERVICE_PORT,
        "max_sessions": MAX_SESSIONS,
    }


# ─────────────── 启动入口 ───────────────

def main():
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="孟德尔随机化分析 WebSocket 服务")
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
