# [IN] models.py, llm/client.py
# [OUT] Clarification questions, updated slots
# [POS] mr_agent/dialog/slots.py - Slot filling and clarification
"""Slot filling for MR analysis parameters."""

from __future__ import annotations

import logging

from mr_agent.analysis.validators import same_consortium_prefix
from mr_agent.llm.client import LLMClient
from mr_agent.llm.prompts import SLOT_CLARIFICATION, SYSTEM_DIALOG
from mr_agent.models import AnalysisSlots, DataSource, DataSourceType

logger = logging.getLogger(__name__)

SLOT_QUESTIONS = {
    "exposure": {
        "zh": "请问您想研究的暴露变量（exposure）是什么？例如：血清维生素D、BMI、吸烟等",
        "en": "What is the exposure variable? e.g., serum vitamin D, BMI, smoking",
    },
    "outcome": {
        "zh": "请问您想研究的结局变量（outcome）是什么？例如：II型糖尿病、冠心病等",
        "en": "What is the outcome variable? e.g., type 2 diabetes, coronary heart disease",
    },
    "data_source": {
        "zh": (
            "请选择数据来源：\n"
            "1. OpenGWAS (在线API查询)\n"
            "2. 本地文件 (上传GWAS汇总统计数据)\n"
            "3. eQTL数据 (如eQTLGen, GTEx)\n"
            "4. pQTL数据 (如UKB-PPP)\n"
            "5. VCF格式文件\n\n"
            "请输入编号或名称，默认为OpenGWAS。"
        ),
        "en": (
            "Select data source:\n"
            "1. OpenGWAS (online API)\n"
            "2. Local file (upload GWAS summary stats)\n"
            "3. eQTL data (e.g., eQTLGen, GTEx)\n"
            "4. pQTL data (e.g., UKB-PPP)\n"
            "5. VCF format file\n\n"
            "Enter number or name (default: OpenGWAS)."
        ),
    },
}


def get_clarification(
    slots: AnalysisSlots,
    llm: LLMClient,
    language: str = "zh",
) -> str | None:
    """Generate a clarification question for missing slots."""
    missing = slots.missing_required()
    if not missing:
        return None
    first_missing = missing[0]
    if first_missing in SLOT_QUESTIONS:
        return SLOT_QUESTIONS[first_missing].get(language, SLOT_QUESTIONS[first_missing]["en"])
    return _generate_question(slots, missing, llm, language)


def _generate_question(
    slots: AnalysisSlots,
    missing: list[str],
    llm: LLMClient,
    language: str,
) -> str:
    """Use LLM to generate a natural clarification question."""
    prompt = SLOT_CLARIFICATION.format(
        exposure=slots.exposure or "未指定",
        outcome=slots.outcome or "未指定",
        mode=slots.mode.value,
        missing=", ".join(missing),
        language=language,
    )
    return llm.chat(
        messages=[{"role": "user", "content": prompt}],
        system=SYSTEM_DIALOG,
        max_tokens=200,
        model_tier="flash",
    )


def update_slots_from_intent(
    slots: AnalysisSlots,
    intent_result: dict,
) -> AnalysisSlots:
    """Update slots with extracted entities from intent recognition."""
    if intent_result.get("exposure"):
        slots.exposure = intent_result["exposure"]
    if intent_result.get("outcome"):
        slots.outcome = intent_result["outcome"]
    # Handle additional outcomes from outcomes array
    for extra in intent_result.get("outcomes", []):
        if extra and extra != slots.outcome and extra not in slots.additional_outcomes:
            slots.additional_outcomes.append(extra)
    prefs = intent_result.get("preferences", {})
    if prefs.get("bidirectional") is not None:
        slots.bidirectional = prefs["bidirectional"]
    if prefs.get("population"):
        slots.population = prefs["population"]
    ds_pref = intent_result.get("data_source_preference")
    if ds_pref:
        _apply_data_source_preference(slots, ds_pref)
    return slots


def _apply_data_source_preference(slots: AnalysisSlots, pref: str) -> None:
    """Apply a data source preference string to slots."""
    pref_lower = pref.lower().strip()
    type_map = {
        "local": DataSourceType.LOCAL_FILE,
        "local_file": DataSourceType.LOCAL_FILE,
        "eqtl": DataSourceType.EQTL,
        "pqtl": DataSourceType.PQTL,
        "vcf": DataSourceType.VCF,
        "opengwas": DataSourceType.OPENGWAS,
    }
    source_type = type_map.get(pref_lower, DataSourceType.OPENGWAS)
    if source_type != DataSourceType.OPENGWAS:
        if not slots.exposure_source:
            slots.exposure_source = DataSource(source_type=source_type)
        if not slots.outcome_source:
            slots.outcome_source = DataSource(source_type=source_type)


def _describe_source(source: DataSource | None) -> str:
    """Create a human-readable description of a data source."""
    if source is None:
        return "OpenGWAS (default)"
    parts = [source.source_type.value]
    if source.file_path:
        parts.append(f"file: {source.file_path}")
    if source.gwas_id:
        parts.append(f"ID: {source.gwas_id}")
    if source.trait_name:
        parts.append(f"trait: {source.trait_name}")
    return ", ".join(parts)


def format_confirmation(slots: AnalysisSlots, language: str = "zh") -> str:
    """Format slots for user confirmation with smart recommendations."""
    exp_src = _describe_source(slots.exposure_source)
    out_src = _describe_source(slots.outcome_source)
    recommendations = _generate_recommendations(slots, language)
    if language == "zh":
        return _format_confirmation_zh(slots, exp_src, out_src, recommendations)
    return _format_confirmation_en(slots, exp_src, out_src, recommendations)


def _generate_recommendations(slots: AnalysisSlots, lang: str = "zh") -> list[str]:
    """Generate smart parameter recommendations based on known info."""
    recs = []
    if slots.exposure_source and slots.outcome_source:
        exp_id = slots.exposure_source.gwas_id or ""
        out_id = slots.outcome_source.gwas_id or ""
        if exp_id and out_id and same_consortium_prefix(exp_id, out_id):
            recs.append(
                "建议使用MR-LAP校正潜在样本重叠" if lang == "zh"
                else "Consider MR-LAP to correct for potential sample overlap"
            )
    if slots.mr_method.value == "standard":
        recs.append(
            "建议p值阈值: 5e-8 → 5e-6 → 5e-5 (逐级放宽)" if lang == "zh"
            else "Recommended p-value thresholds: 5e-8 → 5e-6 → 5e-5"
        )
    if not slots.bidirectional:
        recs.append(
            "建议开启双向分析以验证因果方向" if lang == "zh"
            else "Consider enabling bidirectional analysis"
        )
    return recs


def _format_confirmation_zh(slots, exp_src, out_src, recs=None) -> str:
    lines = [
        "请确认以下分析参数：",
        f"  暴露变量: {slots.exposure}",
        f"  结局变量: {slots.outcome}",
    ]
    if slots.additional_outcomes:
        lines.append(f"  额外结局变量: {', '.join(slots.additional_outcomes)}")
    lines.extend([
        f"  暴露数据源: {exp_src}",
        f"  结局数据源: {out_src}",
        f"  分析模式: {slots.mode.value}",
        f"  MR方法: {slots.mr_method.value}",
        f"  双向分析: {'是' if slots.bidirectional else '否'}",
        f"  同义词扩展: {'是' if slots.use_synonyms else '否'}",
    ])
    if recs:
        lines.append("")
        lines.append("智能建议：")
        lines.extend(f"  💡 {r}" for r in recs)
    lines.extend(["", "确认开始分析吗？(是/否)"])
    return "\n".join(lines)


def _format_confirmation_en(slots, exp_src, out_src, recs=None) -> str:
    lines = [
        "Please confirm analysis parameters:",
        f"  Exposure: {slots.exposure}",
        f"  Outcome: {slots.outcome}",
    ]
    if slots.additional_outcomes:
        lines.append(f"  Additional outcomes: {', '.join(slots.additional_outcomes)}")
    lines.extend([
        f"  Exposure source: {exp_src}",
        f"  Outcome source: {out_src}",
        f"  Mode: {slots.mode.value}",
        f"  MR Method: {slots.mr_method.value}",
        f"  Bidirectional: {slots.bidirectional}",
        f"  Synonyms: {slots.use_synonyms}",
    ])
    if recs:
        lines.append("")
        lines.append("Recommendations:")
        lines.extend(f"  - {r}" for r in recs)
    lines.extend(["", "Confirm to start? (yes/no)"])
    return "\n".join(lines)
