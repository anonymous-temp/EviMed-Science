"""LLM interpretation step: narrative over the finished statistics.

The Pro-tier model receives a structured JSON context containing ONLY the
numbers already produced by the openFDA + signals layers, and is forbidden
from computing, estimating or introducing any number. Output is schema-
validated; on any LLM failure the pipeline degrades to a statistics-only
report with an explicit methodology note.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from safety_agent.analysis.models import (
    CaseOverview,
    Interpretation,
    SignalRow,
)
from safety_agent.evidence.label_check import LabelCheckReport

if TYPE_CHECKING:
    from safety_agent.llm.client import DeepSeekClient

_SYSTEM_PROMPT = (
    "你是药物警戒分析报告撰写助手。输入是一份已完成统计分析的结构化 JSON"
    "(FAERS 失比例信号筛查结果)。你的任务是写中文解读文字。"
    "硬性规则:"
    "1) 你只能叙述输入 JSON 中给出的数字,不得计算、估算、改造或引入任何新数字;"
    "引用指标数值时最多保留 3 位小数,报告数用整数;"
    "2) 不得给出因果关系结论,不得把报告数解释为发生率,必须使用「报告」「信号」「筛查」等措辞;"
    "3) 不得给出用药建议或临床决策;"
    "4) 只输出 JSON,不要输出任何额外解释。"
    "输出 JSON 格式:"
    "{\"overview\":\"总览段\",\"demographics\":\"人口学段\",\"outcomes\":\"结局段\","
    "\"signal_commentary\":\"信号解读段\",\"label_commentary\":\"说明书对照段(无对照数据时空字符串)\","
    "\"focus_adrs\":[{\"reaction\":\"...\",\"text\":\"重点 ADR 段落\"}]}"
)


def build_interpretation_context(
    *,
    drug: str,
    overview: CaseOverview,
    signals: list[SignalRow],
    label_check: LabelCheckReport | None,
    focus_reactions: list[str],
) -> dict:
    """Compact JSON context handed to the Pro model (numbers as-is)."""
    return {
        "drug": drug,
        "total_faers_reports": overview.total_reports,
        "yearly_counts": [b.model_dump() for b in overview.yearly],
        "sex_distribution": [b.model_dump() for b in overview.sex],
        "age_distribution": [b.model_dump() for b in overview.age_buckets],
        "outcome_distribution": [b.model_dump() for b in overview.outcomes],
        "top_countries": [b.model_dump() for b in overview.countries[:5]],
        "top_concomitant_drugs": [b.model_dump() for b in overview.concomitant_drugs[:5]],
        "top_indications": [b.model_dump() for b in overview.indications[:5]],
        "signal_table": [
            row.model_dump(exclude={"haldane_anscombe_applied"}) for row in signals
        ],
        "label_cross_check": (
            {
                "status": label_check.status,
                "checks": [c.model_dump() for c in label_check.checks],
                "note": label_check.note,
            }
            if label_check is not None
            else None
        ),
        "focus_reactions_required": focus_reactions,
        "task": (
            "为每个 focus_reactions_required 中的 ADR 写一段重点解读(focus_adrs),"
            "并撰写 overview/demographics/outcomes/signal_commentary/label_commentary 五段。"
        ),
    }


async def interpret_results(
    llm: "DeepSeekClient",
    *,
    drug: str,
    overview: CaseOverview,
    signals: list[SignalRow],
    label_check: LabelCheckReport | None,
    focus_reactions: list[str],
    max_tokens: int = 8192,
) -> Interpretation:
    """Run the Pro-tier interpretation; raises LLMError on failure."""
    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {
            "role": "user",
            "content": json.dumps(
                build_interpretation_context(
                    drug=drug,
                    overview=overview,
                    signals=signals,
                    label_check=label_check,
                    focus_reactions=focus_reactions,
                ),
                ensure_ascii=False,
            ),
        },
    ]
    output = await llm.complete_json(
        messages, schema=Interpretation, tier="pro", max_tokens=max_tokens
    )
    return output
