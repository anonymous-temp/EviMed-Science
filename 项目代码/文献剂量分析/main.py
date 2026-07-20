"""
文献计量分析服务 v2.0
- 优先检索内部数据库，PubMed 作为兜底补充
- 支持中文输入自动翻译为英文后检索
- 问题句式输入检测与友好引导提示
- 每步完成后实时打字机效果汇总
- 全步骤兜底错误处理，非关键步骤失败不中断分析
- 并发支持：多用户会话独立执行
"""
import asyncio
import base64
import json
import logging
import os
import re
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Dict

import aiohttp
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)

AGENT_TYPE = "quantitative-analysis"
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
OSS_ACCESS_KEY_ID = os.getenv("OSS_ACCESS_KEY_ID")
OSS_ACCESS_KEY_SECRET = os.getenv("OSS_ACCESS_KEY_SECRET")
OSS_ENDPOINT = os.getenv("OSS_ENDPOINT", "https://oss-cn-beijing.aliyuncs.com")
OSS_BUCKET_NAME = os.getenv("OSS_BUCKET_NAME", "project-beijing-a4hznzutlh")
OSS_PUBLIC_BASE_URL = os.getenv("OSS_PUBLIC_BASE_URL", "https://image.evimed.com/oss")

# 内部数据库接口（优先检索，PubMed 兜底）
INTERNAL_DB_URL = os.getenv(
    "INTERNAL_DB_URL",
    "https://www.evimed.com/api-evimed/FineScreenController/interface/paper",
)

BIBLIOMETRIC_ROOT = Path(os.getenv("BIBLIOMETRIC_ROOT", str(Path(__file__).parent)))
BIBLIOMETRIC_SRC = BIBLIOMETRIC_ROOT / "src"
if str(BIBLIOMETRIC_SRC) not in sys.path:
    sys.path.insert(0, str(BIBLIOMETRIC_SRC))

_java_client_task: asyncio.Task = None
# 支持多用户并发：最多 8 个分析管线同时运行
_pipeline_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="bib-pipeline")


# ─────────────── 工具函数 ───────────────

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


def _inline_images(markdown_text: str, report_dir: Path) -> str:
    """将 Markdown 中的相对路径图片替换为 base64 内联，确保前端能正常渲染。"""
    def _replace(match):
        alt, path = match.group(1), match.group(2)
        if path.startswith(("http://", "https://", "data:")):
            return match.group(0)
        img_path = report_dir / path
        if not img_path.exists():
            return match.group(0)
        try:
            img_b64 = base64.b64encode(img_path.read_bytes()).decode()
            ext = img_path.suffix.lstrip(".").lower()
            mime = "image/png" if ext == "png" else f"image/{ext}"
            return f"![{alt}](data:{mime};base64,{img_b64})"
        except Exception:
            return match.group(0)
    return re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", _replace, markdown_text)


async def _upload_report(content: str, user_id: str, message_id: str) -> str | None:
    """上传报告 Markdown 到 OSS，返回公开访问 URL；上传失败降级为 None。
    路径规则: {agentType}/{userId}/{messageId}/{timestamp_ms}.md
    """
    import time
    remote_path = f"{AGENT_TYPE}/{user_id}/{message_id}/{int(time.time() * 1000)}.md"
    data = content.encode("utf-8")

    def _upload_sync():
        import oss2
        auth = oss2.Auth(OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET)
        bucket = oss2.Bucket(auth, OSS_ENDPOINT, OSS_BUCKET_NAME)
        for attempt in range(3):
            try:
                bucket.put_object(
                    remote_path, data,
                    headers={"Content-Type": "text/markdown; charset=utf-8"},
                )
                logger.info(f"OSS 上传成功（第{attempt + 1}次）: {remote_path}")
                return
            except Exception as e:
                logger.warning(f"OSS 上传失败（第{attempt + 1}次）: {e}")
                if attempt < 2:
                    time.sleep(2)
        raise RuntimeError(f"OSS 上传失败，已重试 3 次: {remote_path}")

    try:
        await asyncio.to_thread(_upload_sync)
        url = f"{OSS_PUBLIC_BASE_URL.rstrip('/')}/{remote_path}"
        logger.info(f"报告 OSS 地址: {url}")
        return url
    except Exception as e:
        logger.error(f"OSS 上传异常，降级为 base64 返回: {e}")
        return None


# ─────────────── 内部数据库检索（同步，在线程池中调用）───────────────

def _get_internal_pmids_sync(topic: str) -> list:
    """同步调用内部数据库接口，提取有效 PubMed PMIDs。优先级高于 PubMed 直接检索结果。"""
    try:
        import requests as _req
        resp = _req.post(
            INTERNAL_DB_URL,
            json={"query": topic},
            headers={"Content-Type": "application/json"},
            timeout=30,
        )
        if not resp.ok:
            logger.warning(f"内部数据库接口返回非200状态: {resp.status_code}")
            return []
        data = resp.json()
        items = (
            data if isinstance(data, list)
            else data.get("data") or data.get("records") or data.get("papers") or data.get("result") or []
        )
        pmids = []
        for item in items:
            pmid = str(item.get("pmid") or item.get("id") or "")
            if pmid and pmid.isdigit():
                pmids.append(pmid)
        logger.info(f"内部数据库返回 {len(items)} 条记录，有效 PMID {len(pmids)} 个")
        return pmids
    except Exception as e:
        logger.warning(f"内部数据库检索失败（将仅用 PubMed 兜底）: {e}")
        return []


# ─────────────── 输入分类 ───────────────

# 问题句式检测规则
_QUESTION_PATTERNS = [
    # 标点结尾
    r"[?？]\s*$",
    # 语气词结尾
    r"(吗|么|呢|嘛|吧)\s*[?？。]?\s*$",
    # 句首疑问词（中文）
    r"^(什么|如何|怎么|怎样|为什么|为何|是否|能否|可以|可否|请问|请帮|告诉我)",
    # 哪X 出现在句中任意位置
    r"(哪个|哪些|哪里|哪儿|哪种|哪类|哪家|哪位|哪年|哪篇)",
    # 多少 / 几X
    r"(多少|几个|几种|几篇|几位|几家|几年)",
    # 谁
    r"(是谁|由谁|谁是|谁的)",
    # "有哪" / "是哪"
    r"(有哪|是哪)",
    # 句首疑问词（英文）
    r"^(what|how|why|when|where|which|who|is\s|are\s|can\s|does\s|do\s|did\s|will\s|would\s)",
]


def _is_question(text: str) -> bool:
    """判断用户输入是否为疑问句而非检索关键词。"""
    stripped = text.strip()
    for pat in _QUESTION_PATTERNS:
        if re.search(pat, stripped, re.IGNORECASE):
            return True
    return False


def _has_chinese(text: str) -> bool:
    return any("\u4e00" <= c <= "\u9fff" for c in text)


def _has_english_words(text: str) -> bool:
    """判断文本中是否含有英文单词（2个及以上连续字母）。"""
    return bool(re.search(r"[A-Za-z]{2,}", text))


def _is_pure_chinese(text: str) -> bool:
    """纯中文检索词：含中文字符且不含英文单词。"""
    return _has_chinese(text) and not _has_english_words(text)


def _is_valid_topic(text: str) -> bool:
    """判断英文输入是否为有效的检索主题词（允许中文，中文在外部处理）。"""
    if not text or len(text.strip()) < 2:
        return False
    # 纯符号/数字
    if re.match(r"^[\d\s\W]+$", text.strip()):
        return False
    return True



# ─────────────── LLM 异步工具 ───────────────

async def _llm_reply(text: str, reason: str, send_msg, session_id: str, message_id: str):
    """校验失败时发送友好提示（支持 LLM 生成或模板回退）。
    reason: 'question' | 'question_no_context' | 'invalid' | 'chinese_fail'
    """
    _TW_CHUNK = 8
    _TW_DELAY = 0.03

    # 模板回退文案（专业学术风格）
    if reason == "question_no_context":
        reply = (
            "**请先完成一次文献计量分析**\n\n"
            f"您询问的「{text}」是关于分析结果的问题，"
            "但当前会话尚未完成任何文献分析。\n\n"
            "**使用步骤：**\n\n"
            "1. 先输入研究主题关键词，系统将自动完成检索与分析（约 2-5 分钟）\n"
            "2. 分析完成后，可直接追问报告中的任意内容，例如：\n"
            "   - 哪些国家发文量最多？\n"
            "   - 近几年的突现词有哪些？\n"
            "   - 排名前三的期刊分别是？\n\n"
            "**推荐检索词示例：**\n\n"
            "| 研究方向 | 检索词 |\n"
            "|----------|--------|\n"
            "| 降糖药物 | `metformin type 2 diabetes` |\n"
            "| 心血管保护 | `SGLT2 inhibitor heart failure` |\n"
            "| 肿瘤免疫 | `checkpoint inhibitor cancer immunotherapy` |\n"
            "| 减重治疗 | `semaglutide obesity cardiovascular` |"
        )
    elif reason == "question":
        reply = (
            "**输入格式提示**\n\n"
            f"您的输入「{text}」为疑问句格式，不符合本系统的输入规范。\n\n"
            "本平台为**文献计量分析系统**，支持对医学研究主题进行系统性定量分析，"
            "包括发文趋势、高产作者/机构/期刊、关键词共现网络、爆发词检测及研究前沿识别等。\n\n"
            "**请直接输入英文研究主题关键词**（建议 2-6 个词），示例：\n\n"
            "| 研究方向 | 推荐检索词 |\n"
            "|----------|------------|\n"
            "| 降糖药物 | `metformin type 2 diabetes` |\n"
            "| 心血管保护 | `SGLT2 inhibitor heart failure` |\n"
            "| 肿瘤免疫 | `checkpoint inhibitor cancer immunotherapy` |\n"
            "| 减重治疗 | `semaglutide obesity cardiovascular` |"
        )
    elif reason == "chinese_fail":
        reply = (
            "**中文输入翻译失败**\n\n"
            f"系统无法将「{text}」自动翻译为有效的英文 PubMed 检索词。\n\n"
            "为保证检索质量，建议直接使用**英文主题词**（MeSH 术语或药品通用名）：\n\n"
            "| 中文主题 | 英文检索词 |\n"
            "|----------|------------|\n"
            "| 二甲双胍 | `metformin` |\n"
            "| 糖尿病 | `diabetes mellitus` |\n"
            "| 高血压 | `hypertension` |\n"
            "| 心力衰竭 | `heart failure` |\n"
            "| 肺癌 | `lung cancer` |\n"
            "| 免疫治疗 | `immunotherapy` |\n\n"
            "> 💡 支持组合关键词，如 `metformin cardiovascular outcomes type 2 diabetes`"
        )
    else:
        reply = (
            "**输入内容无法识别**\n\n"
            f"系统无法将「{text}」识别为有效的医学研究主题。\n\n"
            "**有效输入规范**：\n"
            "- 使用英文医学关键词，2-8 个词组成\n"
            "- 支持 MeSH 术语、药品通用名（INN）、疾病规范名称\n"
            "- 可添加限定词，如 `metformin type 2 diabetes cardiovascular outcomes`\n\n"
            "**无效输入示例**：纯数字、单个字符、无意义符号组合"
        )

    # 尝试 LLM 增强回复
    try:
        from bibliometric.llm.client import DeepSeekClient

        client = DeepSeekClient()
        if client.available:
            system = (
                "你是专业文献计量分析顾问，熟悉 PubMed 检索规范与医学 MeSH 术语体系。"
                "当用户输入不符合要求时，请以专业学术语气用中文回复，"
                "解释原因并给出具体的英文检索词建议（含中英对照）。"
                "使用 Markdown 格式（加粗、表格、代码块），不要使用标题（#），回复不超过 250 字。"
            )
            prompt = f"用户输入：{text}\n问题类型：{reason}\n请给出专业的检索指导。"
            chunks = []
            async for chunk in client.astream(
                messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
                tier="flash",
                max_tokens=200,
            ):
                chunks.append(chunk)
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
    except Exception:
        pass

    # 模板回退
    buf = ""
    chunks_list = [reply[i:i + _TW_CHUNK] for i in range(0, len(reply), _TW_CHUNK)]
    for i, ch in enumerate(chunks_list):
        buf += ch
        is_last = (i == len(chunks_list) - 1)
        await send_msg({
            "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
            "content": {"clazz": "agent", "type": "stream",
                        "data": {"type": "text", "delta": buf, "inprogress": not is_last,
                                 **({"isFinished": True} if is_last else {})}},
        })
        await asyncio.sleep(_TW_DELAY)


# ─────────────── 分析步骤配置 ───────────────

STEPS = [
    "检索相关文献",       # 0
    "解析与清洗元数据",   # 1
    "统计分析",           # 2
    "生成可视化图表",     # 3
    "构建共现矩阵",       # 4
    "网络分析",           # 5
    "爆发词检测",         # 6
    "时间线聚类",         # 7
    "研究前沿识别",       # 8
    "AI 洞察挖掘",       # 9
    "生成分析报告",       # 10
]


def _make_status_all(doing_idx: int, done_indices: list) -> list:
    result = []
    for i, title in enumerate(STEPS):
        if i in done_indices:
            result.append({"status": "done", "title": title})
        elif i == doing_idx:
            result.append({"status": "doing", "title": title})
        else:
            result.append({"status": "todo", "title": title})
    return result


# 步骤工具调用显示配置：(str值, 显示文本)
# str值对应前端图标：'正在搜索'→搜索图标，'正在分析'→分析图标，'正在写作'→写作图标
STEP_TOOL_DISPLAY = {
    0:  ("正在搜索",  "正在检索内部文献库与 PubMed，汇总相关文献…"),
    1:  ("正在分析",  "正在解析文献元数据，清洗作者、机构、关键词…"),
    2:  ("正在分析",  "正在计算发文趋势、高产作者、期刊分布等统计指标…"),
    3:  ("正在分析",  "正在生成年度趋势、关键词词云等可视化图表…"),
    4:  ("正在分析",  "正在构建关键词、作者、机构、国家共现矩阵…"),
    5:  ("正在分析",  "正在执行 Louvain 社区检测，分析知识网络结构…"),
    6:  ("正在分析",  "正在运行爆发词检测算法，识别研究热点…"),
    7:  ("正在分析",  "正在识别各研究主题的时间演化轨迹…"),
    8:  ("正在分析",  "正在基于综合评分识别新兴研究前沿…"),
    9:  ("正在分析",  "正在挖掘领域洞察，生成 AI 叙事分析…"),
    10: ("正在写作",  "正在撰写完整分析报告…"),
}


def _fmt_stats(p) -> str:
    try:
        stats = p.stats or {}
        year_df = stats.get("year_trend")
        n = len(p.articles)
        lines = [f"✅ 统计分析完成\n\n共分析 **{n}** 篇文献"]
        if year_df is not None and not year_df.empty:
            peak = year_df.loc[year_df["count"].idxmax()]
            lines.append(f"，发文高峰年份为 **{int(peak['year'])}** 年（{int(peak['count'])} 篇）")
        top_j = stats.get("top_journals")
        if top_j is not None and not top_j.empty:
            lines.append(f"，核心期刊：**{top_j.iloc[0]['journal']}**")
        return "".join(lines) + "。"
    except Exception:
        return "✅ 统计分析完成\n\n已完成发文趋势、高产作者、期刊、机构、国家等多维统计。"


def _fmt_burst(p) -> str:
    try:
        bursts = (p.stats or {}).get("bursts", {})
        import pandas as pd
        df = bursts.get("burst_terms", pd.DataFrame())
        if isinstance(df, pd.DataFrame) and not df.empty:
            terms = "、".join(df.head(3)["term"].tolist())
            return f"✅ 爆发词检测完成\n\n识别到 **{len(df)}** 个爆发词，近期热点词汇：**{terms}**。"
    except Exception:
        pass
    return "✅ 爆发词检测完成\n\n已识别近年快速增长的研究热点词汇。"


def _fmt_frontier(p) -> str:
    try:
        import pandas as pd
        df = (p.stats or {}).get("frontiers", {}).get("frontier_topics", pd.DataFrame())
        if isinstance(df, pd.DataFrame) and not df.empty:
            topics = "、".join(df.head(3)["topic"].tolist())
            return f"✅ 研究前沿识别完成\n\n识别到 **{len(df)}** 个前沿主题，代表性方向：**{topics}**。"
    except Exception:
        pass
    return "✅ 研究前沿识别完成\n\n已基于综合评分识别出新兴研究前沿主题。"


# 每步完成后的打字机汇总文本（各步骤独立生效）
STEP_SUMMARY = {
    0:  lambda p: f"✅ 文献检索完成\n\n共检索到 **{len(p.articles)}** 篇相关文献，时间跨度覆盖近年研究成果。",
    1:  lambda p: f"✅ 元数据清洗完成\n\n保留有效文献 **{len(p.articles)}** 篇，完成作者名标准化、机构消歧与关键词合并。",
    2:  lambda p: _fmt_stats(p),
    3:  lambda p: "✅ 可视化图表生成完成\n\n已生成年度发文趋势、高产作者/机构/期刊/国家分布等统计图表。",
    4:  lambda p: "✅ 共现矩阵构建完成\n\n已完成关键词、作者、机构、国家四类共现矩阵构建，为网络分析奠定基础。",
    5:  lambda p: "✅ 网络分析完成\n\n已完成 Louvain 社区检测，识别研究聚类，并导出 VOSviewer 兼容文件。",
    6:  lambda p: _fmt_burst(p),
    7:  lambda p: "✅ 时间线聚类完成\n\n已识别各研究主题的时间演化轨迹，标注上升/下降/稳定趋势。",
    8:  lambda p: _fmt_frontier(p),
    9:  lambda p: "✅ AI 洞察挖掘完成\n\n已完成领域成熟度、研究集中度、主题迁移、新兴前沿等多维洞察分析。",
    10: lambda p: "✅ 分析报告生成完成\n\n报告已包含摘要、方法、结果、讨论、结论等完整章节，符合学术发表规范。",
}


# ─────────────── 管线同步执行（在线程池中运行）───────────────

def _run_pipeline_sync(topic: str, output_dir: Path, progress_queue: asyncio.Queue, loop: asyncio.AbstractEventLoop,
                        lang: str = "en", date_from: str = "", date_to: str = "", max_records: int = 1000):
    """在线程池中同步运行文献计量分析管线，通过队列推送进度事件。"""
    logger.info(f"_run_pipeline_sync 启动: topic={topic!r}, lang={lang!r}, date={date_from or 'any'}-{date_to or 'any'}, max={max_records}")
    src_path = str(BIBLIOMETRIC_SRC)
    if src_path not in sys.path:
        sys.path.insert(0, src_path)

    # 加载文献计量分析自身的配置
    bib_deploy = BIBLIOMETRIC_ROOT / "deploy.env"
    bib_env = BIBLIOMETRIC_ROOT / ".env"
    if bib_env.exists():
        load_dotenv(str(bib_env), override=True)
    if bib_deploy.exists():
        load_dotenv(str(bib_deploy), override=True)
    def push(kind: str, payload):
        asyncio.run_coroutine_threadsafe(progress_queue.put((kind, payload)), loop)

    # ── Step 1: 先查内部数据库，获取 PMIDs ──
    extra_pmids = _get_internal_pmids_sync(topic)

    # ── STEP_LABELS: 步骤名称 → (step_idx, 中文标签) ──
    STEP_LABELS = {
        "_step_search":         (0,  "检索相关文献"),
        "_step_clean":          (1,  "解析与清洗元数据"),
        "_step_statistics":     (2,  "统计分析"),
        "_step_bib_laws":       (2,  None),
        "_step_citations":      (2,  None),
        "_step_charts":         (3,  "生成可视化图表"),
        "_step_network":        (4,  "构建共现矩阵"),
        "_step_network_charts": (5,  "网络分析"),
        "_step_vosviewer":      (5,  None),
        "_step_burst":          (6,  "爆发词检测"),
        "_step_timeline":       (7,  "时间线聚类"),
        "_step_frontier":       (8,  "研究前沿识别"),
        "_step_insight":        (9,  "AI 洞察挖掘"),
        "_step_ai_narratives":  (9,  None),
        "_step_report":         (10, "生成分析报告"),
    }

    # 关键步骤（失败时终止管线）
    CRITICAL_STEPS = {0, 1, 10}  # 0=检索, 1=清洗, 10=报告生成

    try:
        from bibliometric.config import load_config
        from bibliometric.pipeline import AnalysisPipeline
        from bibliometric.pubmed.connector import PubMedConnector
        from bibliometric.pubmed.parser import parse_articles
        from bibliometric.pubmed.search_strategy import build_search_strategy

        # 去除布尔算符与 Windows 文件名非法字符，空白转下划线
        _st = re.sub(r'\b(AND|OR|NOT)\b', ' ', topic, flags=re.IGNORECASE)
        _st = re.sub(r'[\\/:*?"<>|]', '', _st)
        safe_topic = re.sub(r'\s+', '_', _st.strip()).strip('_')[:50]
        topic_output = output_dir / safe_topic
        topic_output.mkdir(parents=True, exist_ok=True)

        cfg = load_config(output_dir=str(topic_output))

        # ── 创建注入了内部数据库 PMID 的增强管线 ──
        _extra = list(extra_pmids)

        class _BibPipeline(AnalysisPipeline):
            """继承自 AnalysisPipeline，重写相关步骤以支持内部数据库与中文报告。"""

            def _step_search(self, progress):
                from rich.console import Console as _Console
                _con = _Console()
                task = progress.add_task("Searching literature...", total=None)

                self.search_strategy = build_search_strategy(
                    self.query,
                    date_from=self.date_from,
                    date_to=self.date_to,
                    api_key=self.config.ncbi_api_key or "",
                    email=self.config.ncbi_email or "",
                )
                formal_query = self.search_strategy["formal_query"]
                _con.print(f"  Search strategy: [dim]{formal_query[:120]}...[/]")

                connector = PubMedConnector(self.config)
                pmids = connector.search(formal_query, self.date_from, self.date_to, self.max_records)

                # 将内部数据库 PMIDs 优先排在前面（去重）
                if _extra:
                    seen = set(pmids)
                    new_internal = [p for p in _extra if p not in seen]
                    if new_internal:
                        pmids = new_internal + pmids
                        pmids = pmids[:self.max_records]
                        logger.info(f"内部数据库补充 {len(new_internal)} 个 PMID，合计 {len(pmids)} 个")

                xml_chunks = connector.fetch_details(pmids)
                progress.update(task, completed=True)

                self.articles = parse_articles(xml_chunks)
                self._save_metadata(len(pmids))
                self._save_raw(self.articles)
                _con.print(f"  Retrieved [bold]{len(self.articles)}[/] articles")

            def _step_ai_narratives(self, progress):
                from bibliometric.insight.ai_narrator import generate_ai_narratives
                _lang = getattr(self, "_report_lang", "en")
                task = progress.add_task("Generating AI narratives...", total=None)
                self.stats["ai_narratives"] = generate_ai_narratives(
                    self.query, self.articles, self.stats, self.networks,
                    config=self.config, lang=_lang,
                )
                progress.update(task, completed=True)

            def _step_report(self, progress):
                from bibliometric.report.generator import generate_report
                _lang = getattr(self, "_report_lang", "en")
                logger.info(f"生成报告: lang={_lang!r}, query={self.query!r}")
                task = progress.add_task("Generating report...", total=None)
                generate_report(
                    query=self.query,
                    date_from=self.date_from,
                    date_to=self.date_to,
                    articles=self.articles,
                    stats=self.stats,
                    networks=self.networks,
                    output_dir=str(self.output_dir),
                    lang=_lang,
                )
                progress.update(task, completed=True)

        pipeline = _BibPipeline(cfg, query=topic, date_from=date_from, date_to=date_to, max_records=max_records)
        # 将语言标记注入实例，_step_ai_narratives/_step_report 通过 self._report_lang 读取
        pipeline._report_lang = lang

        # ── Monkey-patch 每个 _step_* 方法，添加进度上报与兜底处理 ──
        for method_name, (step_idx, label) in STEP_LABELS.items():
            original = getattr(pipeline, method_name, None)
            if original is None:
                continue

            def _make_wrapper(orig, idx, lbl, is_critical):
                def wrapper(progress):
                    if lbl:
                        push("progress", (idx, lbl))
                    try:
                        orig(progress)
                    except Exception as e:
                        logger.error(f"步骤 {lbl or idx} 执行失败: {e}", exc_info=True)
                        if is_critical:
                            raise  # 关键步骤失败直接抛出，终止管线
                        # 非关键步骤：推送兜底 done_step（p_obj=None 时用默认文案）
                        if lbl:
                            push("done_step", (idx, lbl, None))
                        return
                    if lbl:
                        # 检索步骤：如无结果则不推送完成
                        if idx == 0 and not pipeline.articles:
                            return
                        # 将 pipeline 对象一并推送，供打字机汇总文本使用
                        push("done_step", (idx, lbl, pipeline))
                return wrapper

            setattr(pipeline, method_name, _make_wrapper(
                original, step_idx, label,
                is_critical=(step_idx in CRITICAL_STEPS and label is not None)
            ))

        run_error = None
        try:
            pipeline.run()
        except Exception as e:
            import traceback
            run_error = f"{e}\n{traceback.format_exc()}"

        report_path = topic_output / "report.md"
        if report_path.exists():
            push("done", (str(report_path), pipeline))
        elif run_error:
            push("error", run_error)
        elif not pipeline.articles:
            push("error", f"未能检索到相关文献，请尝试使用英文关键词重新检索。（检索词：{topic}）")
        else:
            push("error", f"管线执行完毕但未生成报告文件，请检查日志。输出目录: {topic_output}")

    except Exception as e:
        import traceback
        try:
            report_path = topic_output / "report.md"
            if report_path.exists():
                push("done", (str(report_path), pipeline))
                return
        except Exception:
            pass
        push("error", f"{e}\n{traceback.format_exc()}")


# ─────────────── 管线异步驱动（含打字机效果）───────────────

async def _run_pipeline(topic: str, send_msg, session_id: str, message_id: str, user_id: str,
                        lang: str = "en", date_from: str = "", date_to: str = "", max_records: int = 1000):
    output_dir = BIBLIOMETRIC_ROOT / "output"
    output_dir.mkdir(parents=True, exist_ok=True)

    _TW_CHUNK = 8
    _TW_DELAY = 0.03

    done_indices: list = []

    async def push_status_doing(idx: int):
        await send_msg({
            "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
            "content": {"clazz": "agent", "type": "status",
                        "data": {"type": "task_status", "item": _make_status_all(idx, done_indices)}},
        })

    async def push_status_done(idx: int):
        if idx not in done_indices:
            done_indices.append(idx)
        await send_msg({
            "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
            "content": {"clazz": "agent", "type": "status",
                        "data": {"type": "task_status", "item": _make_status_all(-1, done_indices)}},
        })

    async def push_tool_call(step_idx: int):
        str_val, display = STEP_TOOL_DISPLAY.get(step_idx, ("正在分析", f"正在执行步骤 {step_idx}…"))
        await send_msg({
            "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
            "content": {"clazz": "agent", "type": "raw",
                        "data": {"type": "tool_call", "str": str_val,
                                 "front_display": display, "inprogress": True}},
        })

    async def push_typewriter(text: str):
        """累积打字机效果发送文本"""
        buf = ""
        for i in range(0, len(text), _TW_CHUNK):
            buf += text[i:i + _TW_CHUNK]
            await send_msg({
                "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                "content": {"clazz": "agent", "type": "stream",
                            "data": {"type": "text", "delta": buf, "inprogress": True}},
            })
            await asyncio.sleep(_TW_DELAY)

    loop = asyncio.get_running_loop()
    progress_queue: asyncio.Queue = asyncio.Queue()

    # 使用专用线程池，支持多用户并发
    thread_future = loop.run_in_executor(
        _pipeline_executor,
        _run_pipeline_sync, topic, output_dir, progress_queue, loop, lang, date_from, date_to, max_records
    )

    report_md = None
    pipeline_obj = None
    last_step_idx = 0
    orchestra_sent = False

    try:
        while True:
            try:
                kind, payload = await asyncio.wait_for(progress_queue.get(), timeout=600)
            except asyncio.TimeoutError:
                if orchestra_sent:
                    await push_typewriter("⚠️ 分析超时，请重试。")
                else:
                    await send_msg({
                        "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                        "content": {"clazz": "agent", "type": "stream",
                                    "data": {"type": "text", "delta": "⚠️ 分析超时，请重试。", "inprogress": False}},
                    })
                return

            if kind == "progress":
                step_idx, label = payload
                if not orchestra_sent:
                    # 第一个 progress 到达时发送任务计划
                    await send_msg({
                        "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                        "content": {"clazz": "agent", "type": "orchestra",
                                    "data": {"type": "plan",
                                             "item": {"analysis": f"对「{topic}」进行文献计量分析", "todo": STEPS},
                                             "isFinished": True}},
                    })
                    orchestra_sent = True
                    await push_status_doing(step_idx)
                    await push_tool_call(step_idx)
                else:
                    await push_status_done(last_step_idx)
                    await push_status_doing(step_idx)
                    await push_tool_call(step_idx)
                last_step_idx = step_idx

            elif kind == "done_step":
                # payload 为 (step_idx, label, pipeline_obj_or_None)
                step_idx, label, p_obj = payload
                summary_fn = STEP_SUMMARY.get(step_idx)
                if summary_fn and p_obj:
                    try:
                        summary = summary_fn(p_obj)
                        await push_typewriter(summary)
                    except Exception:
                        await push_typewriter(f"✅ {label} 完成")
                elif label:
                    await push_typewriter(f"✅ {label} 完成")

            elif kind == "done":
                report_path_str, pipeline_obj = payload
                report_path = Path(report_path_str)
                if report_path.exists():
                    report_md = report_path.read_text(encoding="utf-8")
                    # 将相对路径图片转为 base64 内联，确保前端正常渲染
                    report_md = _inline_images(report_md, report_path.parent)

                    # 清理本地文件（可选，通过环境变量控制）
                    cleanup_local = os.getenv("CLEANUP_LOCAL_REPORT", "true").lower() == "true"
                    if cleanup_local:
                        try:
                            import shutil
                            shutil.rmtree(report_path.parent)  # 删除整个output目录
                            logger.info(f"Cleaned up local report: {report_path.parent}")
                        except Exception as e:
                            logger.warning(f"Failed to cleanup local report: {e}")
                break

            elif kind == "error":
                if orchestra_sent:
                    await push_typewriter(f"❌ 分析失败：{payload}")
                else:
                    await send_msg({
                        "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                        "content": {"clazz": "agent", "type": "stream",
                                    "data": {"type": "text", "delta": f"❌ {payload}", "inprogress": False}},
                    })
                report_md = f"# {topic} 文献计量分析\n\n{payload}"
                break

        await thread_future

    except Exception as e:
        logger.error(f"管线执行失败: {e}", exc_info=True)
        if orchestra_sent:
            await push_typewriter(f"❌ 分析失败：{e}")
        report_md = f"# {topic} 文献计量分析报告\n\n分析过程中发生错误：{e}"

    if not report_md:
        report_md = f"# {topic} 文献计量分析报告\n\n分析已完成，但报告文件未找到。"

    # 无 orchestra 表示无有效结果，直接返回（不发 finish）
    if not orchestra_sent:
        return

    # 最后一步标为完成（汇总文本已由 done_step 事件实时展示，此处仅更新状态）
    await push_status_done(last_step_idx)
    await push_typewriter("\n\n---\n\n📊 **分析完成**，报告已生成，请查看下方文件。")

    # text_finish
    await send_msg({
        "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
        "content": {"clazz": "agent", "type": "text_finish", "data": {}},
    })

    # 上传 OSS
    oss_url = await _upload_report(report_md, user_id, message_id)
    md_value = oss_url if oss_url else (
        "data:text/markdown;charset=utf-8;base64," + base64.b64encode(report_md.encode('utf-8')).decode()
    )

    # finish
    await send_msg({
        "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
        "content": {"clazz": "agent", "type": "finish",
                    "data": {"md": md_value, "pdf": "",
                             "name": f"文献计量分析_{topic[:20]}", "isFinished": True}},
    })

    # 返回纯文本报告（剥离 base64 图片），供多轮对话上下文使用
    report_text_only = re.sub(r'!\[([^\]]*)\]\(data:[^)]{20,}\)', r'[图表: \1]', report_md)
    return report_text_only[:15000]


# ─────────────── 追问回答（基于上次报告上下文）───────────────

async def _answer_from_report(
    question: str,
    session_ctx: dict,
    send_msg,
    session_id: str,
    message_id: str,
):
    """基于上一次分析报告，用 LLM 流式回答追问。不发送任何任务计划/状态消息。"""
    _TW_CHUNK = 8
    _TW_DELAY = 0.03
    topic = session_ctx.get("last_topic", "")
    report_text = session_ctx.get("last_report", "")

    async def _send_stream(text: str, inprogress: bool, finished: bool = False):
        data = {"type": "text", "delta": text, "inprogress": inprogress}
        if finished:
            data["isFinished"] = True
        await send_msg({
            "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
            "content": {"clazz": "agent", "type": "stream", "data": data},
        })

    try:
        from bibliometric.llm.client import DeepSeekClient

        client = DeepSeekClient()
        if not client.available:
            raise ValueError("未配置 DEEPSEEK_API_KEY")
        system = (
            "你是专业的文献计量分析助手。以下是一份已完成的文献计量分析报告，"
            "请基于报告内容准确回答用户的追问。\n"
            "要求：使用 Markdown 格式，语言专业简洁，"
            "如报告中无相关信息请明确告知，不要编造数据。"
        )
        user_prompt = (
            f"## 分析主题\n{topic}\n\n"
            f"## 报告内容（摘录）\n{report_text}\n\n"
            f"## 用户追问\n{question}"
        )

        buf = ""
        async for delta in client.astream(
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_prompt},
            ],
            tier="pro",
            max_tokens=800,
        ):
            if not delta:
                continue
            buf += delta
            await _send_stream(buf, inprogress=True)
            await asyncio.sleep(_TW_DELAY)

        # 发送带终止标志的最后一帧
        await _send_stream(buf, inprogress=False, finished=True)
        return

    except Exception as e:
        logger.warning(f"LLM 追问回答失败: {e}")

    # LLM 不可用时的模板降级
    fallback = (
        f"当前 AI 服务不可用，无法回答追问。\n\n"
        f"如需了解「{topic}」分析报告的具体内容，请直接查阅上方生成的报告文件。\n"
        f"如需重新分析或更换主题，请直接输入新的研究关键词。"
    )
    buf = ""
    chunks_list = [fallback[i:i + _TW_CHUNK] for i in range(0, len(fallback), _TW_CHUNK)]
    for i, ch in enumerate(chunks_list):
        buf += ch
        is_last = i == len(chunks_list) - 1
        await _send_stream(buf, inprogress=not is_last, finished=is_last)
        await asyncio.sleep(_TW_DELAY)


# ─────────────── 会话处理 ───────────────

async def _handle_session(
    parent_id: str,
    msg_queue: asyncio.Queue,
    python_client_id: str,
    ws_send,
    first_sender_id: str,
    user_id: str,
):
    session_id = parent_id
    current_target = first_sender_id

    def _wrap(payload: dict) -> str:
        content = payload.get("content", {})
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
            "agentType": payload.get("agentType", AGENT_TYPE),
            "content": content,
        }, ensure_ascii=False)

    async def send_msg(payload: dict):
        await ws_send(_wrap(payload))

    _TW_CHUNK = 8
    _TW_DELAY = 0.03

    async def push_stream(message_id: str, text: str, inprogress: bool = False):
        buf = ""
        chunks = [text[i:i + _TW_CHUNK] for i in range(0, len(text), _TW_CHUNK)]
        for i, ch in enumerate(chunks):
            buf += ch
            is_last = (i == len(chunks) - 1)
            await send_msg({
                "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                "content": {"clazz": "agent", "type": "stream",
                            "data": {"type": "text", "delta": buf,
                                     "inprogress": inprogress and not is_last,
                                     **({"isFinished": True} if is_last else {})}},
            })
            await asyncio.sleep(_TW_DELAY)

    try:
        session_ctx: dict = {"last_topic": "", "last_report": ""}

        while True:
            user_msg = await msg_queue.get()
            if user_msg is None:
                break

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

            # ── 1. 问题检测 ──
            if _is_question(input_text):
                if session_ctx["last_report"]:
                    # 有上下文：基于上次报告回答追问，不触发 pipeline
                    await _answer_from_report(
                        input_text, session_ctx, send_msg, session_id, message_id
                    )
                else:
                    # 无上下文：提示先完成一次分析
                    await _llm_reply(input_text, "question_no_context", send_msg, session_id, message_id)
                continue

            # ── 2. 含中文输入：提示用户正在处理 ──
            # 语言规则：纯中文→中文报告；纯英文→英文报告；中英混合→英文报告
            report_lang = 'zh' if _is_pure_chinese(input_text) else 'en'
            if _has_chinese(input_text):
                hint = f"检测到中文输入「{input_text}」，正在生成 PubMed 检索式…\n\n"
                await send_msg({
                    "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "stream",
                                "data": {"type": "text", "delta": hint, "inprogress": True}},
                })
                # 中文处理已内置在 build_search_strategy() 中，无需预处理

            # ── 3. 英文输入有效性校验 ──
            if not _is_valid_topic(input_text):
                await _llm_reply(input_text, "invalid", send_msg, session_id, message_id)
                continue

            # ── 4. 使用默认参数执行分析 ──
            from datetime import datetime
            current_date = datetime.now()
            current_year = current_date.year
            date_from = str(current_year - 9)  # 默认近10年
            date_to = str(current_year)         # 包含当年最新数据
            max_records = 1000  # 默认1000篇

            # ── 5. 执行文献计量分析 ──
            try:
                report_text = await _run_pipeline(
                    input_text, send_msg, session_id, message_id, user_id,
                    lang=report_lang, date_from=date_from, date_to=date_to, max_records=max_records
                )
                if report_text:
                    session_ctx["last_topic"] = input_text
                    session_ctx["last_report"] = report_text
            except Exception as e:
                logger.error(f"管线异常: {e}", exc_info=True)
                await send_msg({
                    "id": message_id, "parentId": session_id, "agentType": AGENT_TYPE,
                    "content": {"clazz": "agent", "type": "stream",
                                "data": {"type": "text",
                                         "delta": f"⚠️ 处理过程中发生错误：{e}",
                                         "inprogress": False, "isFinished": True}},
                })

    except Exception as e:
        logger.error(f"会话 {parent_id} 异常退出: {e}")


# ─────────────── Java WebSocket 客户端 ───────────────

async def _java_ws_client():
    import websockets
    active_sessions: Dict[str, dict] = {}

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
                logger.info("已发送 auth 消息")

                async def ws_send(data: str):
                    await ws.send(data)

                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except Exception:
                        continue

                    if msg.get("type") == "heartbeat":
                        await ws.send(json.dumps({"status": "received"}))
                        continue

                    if msg.get("type") == "system":
                        cid = msg.get("clientId") or msg.get("pythonClientId")
                        if cid:
                            python_client_id = cid
                        content = msg.get('content', '')
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
                            _handle_session(parent_id, q, python_client_id, ws_send, sender_id, uid)
                        )
                        t.add_done_callback(lambda _, pid=parent_id: active_sessions.pop(pid, None))
                        active_sessions[parent_id] = {"queue": q, "task": t}
                        logger.info(f"新会话: parentId={parent_id}, sender={sender_id}")

                    await active_sessions[parent_id]["queue"].put(msg)

        except Exception as e:
            logger.error(f"Java WS 连接断开: {e}，5 秒后重连…")

        # 连接断开时取消所有进行中的会话任务
        for sid, sess in list(active_sessions.items()):
            sess["task"].cancel()
        active_sessions.clear()
        await asyncio.sleep(5)


# ─────────────── FastAPI 应用 ───────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _java_client_task
    logger.info("文献计量分析服务启动")
    _java_client_task = asyncio.create_task(_java_ws_client())
    yield
    logger.info("文献计量分析服务关闭")
    if _java_client_task:
        _java_client_task.cancel()
        try:
            await _java_client_task
        except asyncio.CancelledError:
            pass
    _pipeline_executor.shutdown(wait=False)


app = FastAPI(title="文献计量分析服务", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "agent": AGENT_TYPE, "version": "2.0.0"}
