"""Shared service context: the output root, step labels and path helpers."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path


META_ROOT = Path(__file__).resolve().parents[1]

REFERENCE_ADD_METHODOLOGY_SOURCE_TYPES = {
    "reporting_guideline",
    "methods_handbook",
    "risk_of_bias_tool",
    "certainty_framework",
    "statistical_method",
    "publication_bias_method",
}

META_STEPS = [
    "研究规划（PICO提取）",
    "生成检索策略",
    "文献检索",
    "标题摘要筛选",
    "全文筛选与数据提取",
    "偏倚风险评估",
    "分析路径判断",
    "GRADE证据评价",
    "生成图表",
    "撰写报告",
]


def _resolve_project_dir(project_dir: str | None, parent_id: str = "") -> Path:
    """Resolve a frontend project_dir safely inside this service output root."""
    output_root = (META_ROOT / "output").resolve()
    if project_dir:
        candidate = Path(project_dir)
        if not candidate.is_absolute():
            candidate = META_ROOT / candidate
    elif parent_id:
        candidate = META_ROOT / "output" / parent_id
    else:
        raise ValueError("project_dir is required")
    resolved = candidate.resolve()
    if output_root != resolved and output_root not in resolved.parents:
        raise ValueError("project_dir must be inside the MetaAgent output directory")
    if not resolved.exists():
        raise ValueError(f"project_dir does not exist: {resolved}")
    return resolved


def _make_ts() -> list:
    now = datetime.now()
    return [now.year, now.month, now.day, now.hour, now.minute, now.second, now.microsecond * 1000]
