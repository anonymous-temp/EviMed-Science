"""
HTTP 流式分析接口
响应格式与原 WebSocket 服务保持一致，封装为 NDJSON 流。
"""
import asyncio
import json
import logging
import os
import base64
from typing import AsyncGenerator, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from services.task_service import task_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/http", tags=["HTTP流式接口"])

AGENT_TYPE = "research-topic-selection"

MODULE_NAMES = {
    "M1_PROBLEM_LANDSCAPE": "问题全景分析",
    "M2_RESEARCH_ECOSYSTEM": "研究生态系统",
    "M3_EVIDENCE_SYSTEM": "证据体系",
    "M4_SCIENTIFIC_CONTRADICTION": "科学争议",
    "M5_BREAKTHROUGH_OPPORTUNITY": "突破性机会",
    "M6_RESEARCH_AGENDA": "研究议程",
}

MODULE_PROCESS_MAP = {
    "问题全景分析": ("正在搜索", "正在检索问题全景文献数据，分析研究发展脉络..."),
    "研究生态系统": ("正在搜索", "正在绘制研究生态系统图谱，分析学术合作网络..."),
    "证据体系":     ("正在搜索", "正在评估证据层次结构，梳理研究设计分布..."),
    "科学争议":     ("正在搜索", "正在识别核心科学争议，分析研究矛盾焦点..."),
    "突破性机会":   ("正在分析", "正在发现潜在研究突破口，评估创新机会窗口..."),
    "研究议程":     ("正在分析", "正在规划研究路线图，生成优先研究议程..."),
}


class StreamAnalysisRequest(BaseModel):
    title: str
    status: int = 0
    startYear: Optional[str] = None
    endYear: Optional[str] = None


def _ndjson(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False) + "\n"


def _build_status_list(current_index: int, plan_todos: list, status_for_current: str) -> list:
    result = []
    for i, title in enumerate(plan_todos):
        if i < current_index:
            result.append({"status": "done", "title": title})
        elif i == current_index:
            result.append({"status": status_for_current, "title": title})
        else:
            result.append({"status": "todo", "title": title})
    return result


async def _analysis_generator(input_text: str) -> AsyncGenerator[str, None]:
    task_id = ""
    try:
        # 输入校验
        validation_error = task_service.validate_input(input_text)
        if validation_error:
            yield _ndjson({"id": "", "finished": True, "type": "error", "content": validation_error.message})
            return

        # 创建任务
        task = await task_service.create_task(input_text=input_text, options={})
        task_id = task.task_id

        yield _ndjson({"id": task_id, "finished": False, "type": "stream",
                       "data": {"type": "text", "delta": f"正在检索与规划「{input_text}」的分析蓝图，请稍候…\n\n", "inprogress": True}})

        # 检索与规划
        yield _ndjson({"id": task_id, "finished": False, "type": "stream",
                       "data": {"type": "text", "delta": "正在检索相关文献，生成分析蓝图…\n\n", "inprogress": True}})

        blueprint = await task_service.start_retrieval_and_planning(task_id)

        if not blueprint.can_proceed:
            diag = blueprint.search_diagnostics
            msg = diag.diagnosis if diag else "检索结果不足"
            yield _ndjson({"id": task_id, "finished": True, "type": "stream",
                           "data": {"type": "text", "delta": f"⚠️ {msg}", "inprogress": True, "isFinished": True}})
            return

        # 确认计划
        await task_service.confirm_analysis_plan(task_id=task_id, confirmed=True, skip_modules=[])

        planned_modules_list = blueprint.planned_modules
        plan_todos = [MODULE_NAMES.get(m, m) for m in planned_modules_list]
        module_id_to_index = {mid: i for i, mid in enumerate(planned_modules_list)}

        # 发送任务计划
        yield _ndjson({"id": task_id, "finished": False, "type": "orchestra",
                       "data": {"type": "plan", "item": {"analysis": "课题分析进度", "todo": plan_todos}, "isFinished": True}})

        iter_index = 0
        while True:
            # 发送当前模块 doing 状态
            if iter_index < len(planned_modules_list):
                cur_mid = planned_modules_list[iter_index]
                cur_idx = module_id_to_index.get(cur_mid, iter_index)
                cur_name = plan_todos[cur_idx] if cur_idx < len(plan_todos) else "分析"
                str_type, front_display = MODULE_PROCESS_MAP.get(cur_name, ("正在分析", f"正在执行{cur_name}深度分析..."))

                yield _ndjson({"id": task_id, "finished": False, "type": "status",
                               "data": {"item": _build_status_list(cur_idx, plan_todos, "doing"), "type": "task_status"}})
                yield _ndjson({"id": task_id, "finished": False, "type": "raw",
                               "data": {"type": "tool_call", "str": str_type, "front_display": front_display, "inprogress": True}})

            # 流式回调
            token_queue: asyncio.Queue = asyncio.Queue()
            stream_buf = []

            async def on_token(delta: str, _q=token_queue, _buf=stream_buf):
                _buf.append(delta)
                await _q.put(''.join(_buf))

            exec_task = asyncio.create_task(
                task_service.execute_next_module(task_id, stream_callback=on_token)
            )

            try:
                while not exec_task.done():
                    try:
                        cumulative = await asyncio.wait_for(token_queue.get(), timeout=0.05)
                        yield _ndjson({"id": task_id, "finished": False, "type": "stream",
                                       "data": {"type": "text", "delta": cumulative, "inprogress": True}})
                    except asyncio.TimeoutError:
                        pass

                while not token_queue.empty():
                    cumulative = token_queue.get_nowait()
                    yield _ndjson({"id": task_id, "finished": False, "type": "stream",
                                   "data": {"type": "text", "delta": cumulative, "inprogress": True}})

                result = exec_task.result()
            except Exception:
                exec_task.cancel()
                raise

            module_id = result.get("module_id", "")
            module_index = module_id_to_index.get(module_id, iter_index)
            iter_index += 1
            output = result.get("output")
            was_streamed = result.get("was_streamed", False)

            # 非流式模块打字机输出
            if output and output.status == "success" and not was_streamed:
                section_content = output.data.get("llm_deep_analysis", "")
                if not section_content and output.key_insights:
                    section_content = "\n".join(f"- {i}" for i in output.key_insights)
                if section_content:
                    _TW_CHUNK = 60
                    for start in range(0, len(section_content), _TW_CHUNK):
                        typed = section_content[:start + _TW_CHUNK]
                        yield _ndjson({"id": task_id, "finished": False, "type": "stream",
                                       "data": {"type": "text", "delta": typed, "inprogress": True}})
                        await asyncio.sleep(0.035)

            # 图表输出
            if output and output.status == "success":
                for chart in output.charts:
                    try:
                        if chart.path and os.path.exists(chart.path):
                            img_bytes = await asyncio.to_thread(lambda p=chart.path: open(p, "rb").read())
                            img_b64 = base64.b64encode(img_bytes).decode()
                            chart_md = f"\n\n![{chart.title}](data:image/png;base64,{img_b64})\n\n"
                            if chart.description:
                                chart_md += f"*{chart.description}*\n\n"
                            yield _ndjson({"id": task_id, "finished": False, "type": "stream",
                                           "data": {"type": "text", "delta": chart_md, "inprogress": True}})
                    except Exception as e:
                        logger.warning(f"图表读取失败: {chart.path}, {e}")

            # 所有模块完成
            if result.get("is_final"):
                yield _ndjson({"id": task_id, "finished": False, "type": "raw",
                               "data": {"type": "tool_call", "str": "正在写作", "front_display": "正在撰写分析报告…", "inprogress": True}})

                final_md = ""
                async for _, cumulative_md in task_service.generate_report_streaming(task_id):
                    final_md = cumulative_md
                    yield _ndjson({"id": task_id, "finished": False, "type": "report_writing_stream",
                                   "data": {"type": "text", "delta": cumulative_md, "inprogress": True}})

                # 最后一个模块标为 done
                yield _ndjson({"id": task_id, "finished": False, "type": "status",
                               "data": {"item": _build_status_list(module_index, plan_todos, "done"), "type": "task_status"}})

                yield _ndjson({"id": task_id, "finished": False, "type": "text_finish", "data": {}})

                yield _ndjson({"id": task_id, "finished": True, "type": "finish",
                               "data": {"md": "", "pdf": "", "name": f"科研选题分析_{input_text[:20]}", "isFinished": True}})
                break
            else:
                yield _ndjson({"id": task_id, "finished": False, "type": "status",
                               "data": {"item": _build_status_list(module_index, plan_todos, "done"), "type": "task_status"}})

    except Exception as e:
        logger.exception(f"[HTTP流式] task_id={task_id} 异常: {e}")
        yield _ndjson({"id": task_id, "finished": True, "type": "stream",
                       "data": {"type": "text", "delta": f"⚠️ 处理过程中发生错误：{str(e)}", "inprogress": True, "isFinished": True}})


@router.post("/analysis/stream", summary="科研选题分析（HTTP流式）")
async def http_stream_analysis(request: StreamAnalysisRequest):
    input_text = request.title.strip()
    if not input_text:
        raise HTTPException(status_code=400, detail="title 不能为空")

    return StreamingResponse(
        _analysis_generator(input_text),
        media_type="application/x-ndjson",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
