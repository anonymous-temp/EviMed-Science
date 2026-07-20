# [IN] llm/client.py, llm/prompts.py, models.py
# [OUT] Paper section text
# [POS] mr_agent/paper/sections.py - Individual section writers
"""Paper section writers using LLM."""

from __future__ import annotations

import logging
import json
import re

from mr_agent.llm.client import LLMClient
from mr_agent.llm.prompts import (
    LANGUAGE_INSTRUCTION,
    PAPER_CONCLUSION,
    PAPER_CONNECTED_ABSTRACT,
    PAPER_DATA_AVAILABILITY,
    PAPER_DISCUSSION,
    PAPER_ETHICS,
    PAPER_INTRODUCTION,
    PAPER_LIMITATIONS,
    PAPER_METHODS,
    PAPER_OUTLINE,
    PAPER_OUTLINE_SCHEMA,
    PAPER_RESULTS,
    PAPER_TABLE1,
    PAPER_TABLE2,
    SYSTEM_MR_SCIENTIST,
)
from mr_agent.models import AnalysisSlots, MRAnalysisResult, PaperReference, find_ivw
from mr_agent.paper.references import build_reference_context

_SUBSECTION_RE = re.compile(r'^(### )\d+\.', re.MULTILINE)
_TABLE_BOLD_RE = re.compile(r'\*\*([^*]+)\*\*')


def _strip_table_header_bold(text: str) -> str:
    """Remove bold markers from table header rows (lines starting with |).

    LLMs often bold the first row of markdown tables despite instructions.
    This post-processor strips ** from any pipe-delimited table row.
    """
    result = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("|") and "**" in line:
            line = _TABLE_BOLD_RE.sub(r'\1', line)
        result.append(line)
    return "\n".join(result)


def _renumber_subsections(text: str) -> str:
    """Reset ### subsection numbers to 1, 2, 3... in order of appearance.

    LLMs routinely start the counter from the parent section number
    (e.g., ### 2. Data Sources inside Methods section 2) or from a hidden
    first paragraph they treat as subsection 1.  This post-processor
    corrects the numbering regardless of what the LLM produced.
    """
    counter = 0

    def _replace(m: re.Match) -> str:
        nonlocal counter
        counter += 1
        return f"{m.group(1)}{counter}."

    return _SUBSECTION_RE.sub(_replace, text)





def write_introduction(
    llm: LLMClient,
    exposure: str,
    outcome: str,
    refs: list[PaperReference],
    language: str = "en",
) -> str:
    """Generate Introduction section with citations."""
    lit_context = build_reference_context(refs)
    prompt = PAPER_INTRODUCTION.format(
        exposure=exposure,
        outcome=outcome,
        literature=lit_context,
    )
    return _generate_section(llm, prompt, max_tokens=3000, language=language)


def write_methods(
    llm: LLMClient,
    results: list[MRAnalysisResult],
    exposure: str,
    outcome: str,
    language: str = "en",
) -> str:
    """Generate Methods section following STROBE-MR."""
    if not results:
        return ""
    first = results[0]
    methods_used = ", ".join(r.method for r in first.mr_results)
    sensitivity = _describe_sensitivity(first)
    prompt = PAPER_METHODS.format(
        exposure=exposure,
        outcome=outcome,
        exposure_id=first.exposure_id,
        outcome_id=first.outcome_id,
        pval_threshold=first.pval_threshold,
        n_ivs=first.n_instruments,
        methods=methods_used or "IVW, MR-Egger, Weighted Median, Simple Mode, Weighted Mode",
        sensitivity=sensitivity,
        exposure_metadata=json.dumps(first.exposure_metadata, ensure_ascii=False),
        outcome_metadata=json.dumps(first.outcome_metadata, ensure_ascii=False),
    )
    return _generate_section(llm, prompt, max_tokens=3000, language=language)


def write_results(
    llm: LLMClient,
    results: list[MRAnalysisResult],
    language: str = "en",
) -> str:
    """Generate Results section."""
    summary = _build_results_summary(results)
    prompt = PAPER_RESULTS.format(results_summary=summary)
    return _generate_section(llm, prompt, max_tokens=3000, language=language)


def write_discussion(
    llm: LLMClient,
    exposure: str,
    outcome: str,
    results: list[MRAnalysisResult],
    refs: list[PaperReference],
    language: str = "en",
) -> str:
    """Generate Discussion section."""
    findings = _format_key_findings(results)
    lit_context = build_reference_context(refs[:10])
    prompt = PAPER_DISCUSSION.format(
        exposure=exposure,
        outcome=outcome,
        findings=findings,
        literature=lit_context,
    )
    return _generate_section(llm, prompt, max_tokens=4000, language=language)


def _generate_section(
    llm: LLMClient, prompt: str, max_tokens: int = 2000, language: str = "en",
) -> str:
    """Common LLM call for section generation."""
    lang_instruction = LANGUAGE_INSTRUCTION.get(language, "")
    if lang_instruction:
        prompt += lang_instruction
    if language == "zh":
        system = (
            SYSTEM_MR_SCIENTIST
            + "\n\n【强制语言要求】请始终用中文撰写所有正文内容。"
            "专有名词（IVW、MR-Egger、OR、CI、SNP、beta、GWAS ID等缩写）保留英文，"
            "其余所有句子、段落必须为中文，禁止出现完整英文句子。"
        )
    else:
        system = (
            SYSTEM_MR_SCIENTIST
            + "\n\nLANGUAGE REQUIREMENT (strictly enforced): "
            "Write ENTIRELY in English. "
            "Do NOT include any Chinese characters anywhere in your response. "
            "All section text, headings, table content, and footnotes must be in English only."
        )
    raw = llm.chat(
        messages=[{"role": "user", "content": prompt}],
        system=system,
        max_tokens=max_tokens,
        temperature=0.4,
    )
    return _renumber_subsections(_strip_leading_heading(_strip_table_header_bold(raw)))


def _strip_leading_heading(text: str) -> str:
    """Remove the first line if it is a markdown heading (starts with #).

    Section titles are added by the assembler; if the LLM also outputs one at
    the top, the result contains a duplicate heading.
    """
    lines = text.lstrip("\n").splitlines()
    if lines and lines[0].lstrip().startswith("#"):
        lines = lines[1:]
        # also drop a blank line immediately after the stripped heading
        if lines and not lines[0].strip():
            lines = lines[1:]
    return "\n".join(lines)


def _describe_sensitivity(result: MRAnalysisResult) -> str:
    """Describe sensitivity analyses performed."""
    analyses = ["MR-Egger regression", "Weighted median method"]
    if result.heterogeneity:
        analyses.append("Cochran's Q test for heterogeneity")
    if result.pleiotropy:
        analyses.append("MR-Egger intercept test for pleiotropy")
    analyses.append("Leave-one-out analysis")
    analyses.append("Funnel plot for asymmetry")
    if result.steiger_correct is not None:
        analyses.append("Steiger directionality test")
    if result.presso_global_pval is not None:
        analyses.append("MR-PRESSO outlier detection")
    return ", ".join(analyses)


def _build_results_summary(results: list[MRAnalysisResult]) -> str:
    """Build comprehensive results summary for the prompt."""
    parts = []
    for r in results:
        if not r.mr_results:
            continue
        part = f"\n## {r.exposure_name} → {r.outcome_name}\n"
        part += f"GWAS IDs: {r.exposure_id} → {r.outcome_id}\n"
        part += f"Number of IVs: {r.n_instruments}\n"
        if r.f_statistic_mean is not None:
            part += f"Mean F-statistic: {r.f_statistic_mean:.2f}\n"
        part += "\nMR Results:\n"
        for m in r.mr_results:
            line = f"  {m.method}: beta={m.beta:.4f}, p={m.pval:.2e}"
            if m.or_value is not None:
                ci_lo = f"{m.ci_lower:.3f}" if m.ci_lower is not None else "?"
                ci_hi = f"{m.ci_upper:.3f}" if m.ci_upper is not None else "?"
                line += f", OR={m.or_value:.3f} [{ci_lo}-{ci_hi}]"
            part += line + "\n"
        if r.heterogeneity:
            part += "\nHeterogeneity:\n"
            for h in r.heterogeneity:
                part += f"  {h.method}: Q={h.q:.2f}, p={h.q_pval:.4f}\n"
        if r.pleiotropy:
            p = r.pleiotropy
            part += f"\nPleiotropy: intercept={p.egger_intercept:.4f}, p={p.pval:.4f}\n"
        parts.append(part)
    return "\n".join(parts) if parts else "No results available."


def write_conclusion(
    llm: LLMClient,
    exposure: str,
    outcome: str,
    results: list[MRAnalysisResult],
    language: str = "en",
) -> str:
    """Generate Conclusion section."""
    findings = _format_key_findings(results)
    prompt = PAPER_CONCLUSION.format(
        exposure=exposure, outcome=outcome, findings=findings,
    )
    return _generate_section(llm, prompt, max_tokens=1000, language=language)


def write_limitations(
    llm: LLMClient,
    exposure: str,
    outcome: str,
    results: list[MRAnalysisResult],
    bidirectional: bool = False,
    population: str = "European",
    language: str = "en",
) -> str:
    """Generate Limitations section."""
    if not results:
        return ""
    first = results[0]
    sensitivity = _describe_sensitivity(first)
    prompt = PAPER_LIMITATIONS.format(
        exposure=exposure, outcome=outcome,
        n_ivs=first.n_instruments, population=population,
        bidirectional=bidirectional, sensitivity=sensitivity,
    )
    return _generate_section(llm, prompt, max_tokens=2000, language=language)


def write_table1(
    llm: LLMClient,
    results: list[MRAnalysisResult],
    exposure: str,
    outcome: str,
    language: str = "en",
) -> str:
    """Generate Table 1: Data source characteristics."""
    if not results:
        return ""
    first = results[0]
    f_stat = f"{first.f_statistic_mean:.2f}" if first.f_statistic_mean else "N/A"
    prompt = PAPER_TABLE1.format(
        exposure=exposure, outcome=outcome,
        exposure_id=first.exposure_id, outcome_id=first.outcome_id,
        n_ivs=first.n_instruments, pval_threshold=first.pval_threshold,
        f_stat=f_stat,
        exposure_metadata=json.dumps(first.exposure_metadata, ensure_ascii=False),
        outcome_metadata=json.dumps(first.outcome_metadata, ensure_ascii=False),
    )
    return _generate_section(llm, prompt, max_tokens=1500, language=language)


def write_table2(
    llm: LLMClient,
    results: list[MRAnalysisResult],
    language: str = "en",
) -> str:
    """Generate Table 2: MR results summary."""
    summary = _build_results_summary(results)
    prompt = PAPER_TABLE2.format(results_summary=summary)
    return _generate_section(llm, prompt, max_tokens=2000, language=language)


def generate_outline(
    llm: LLMClient,
    exposure: str,
    outcome: str,
    results: list[MRAnalysisResult],
    bidirectional: bool = False,
    feedback: str = "",
) -> dict:
    """Generate paper outline for user confirmation."""
    findings = _format_key_findings(results)
    prompt = PAPER_OUTLINE.format(
        exposure=exposure, outcome=outcome, findings=findings,
        n_results=len(results), bidirectional=bidirectional,
    )
    if feedback:
        prompt += f"\n\nUser revision feedback: {feedback}"
    return llm.chat_structured(
        prompt=prompt, schema=PAPER_OUTLINE_SCHEMA,
        system=SYSTEM_MR_SCIENTIST,
    )


def _format_key_findings(results: list[MRAnalysisResult]) -> str:
    """Format key MR findings with complete numerical values.

    Single source of truth for all prompts — every section receives
    this identical text so IVW/Egger/Median numbers stay consistent
    across Results, Discussion, Conclusion, Abstract, and Tables.
    """
    lines = []
    for r in results:
        ivw = find_ivw(r.mr_results)
        if not ivw:
            continue
        sig = "significant" if ivw.pval < 0.05 else "non-significant"
        direction = "positive" if ivw.beta > 0 else "negative/protective"
        line = (
            f"{r.exposure_name} → {r.outcome_name}: "
            f"{sig} {direction} effect"
        )
        line += f"\n  IVW: beta={ivw.beta:.4f}, SE={ivw.se:.4f}, p={ivw.pval:.2e}"
        if ivw.or_value is not None:
            ci_lo = f"{ivw.ci_lower:.3f}" if ivw.ci_lower is not None else "N/A"
            ci_hi = f"{ivw.ci_upper:.3f}" if ivw.ci_upper is not None else "N/A"
            line += f"\n  IVW: OR={ivw.or_value:.3f} (95% CI: {ci_lo}-{ci_hi})"
        for m in r.mr_results:
            if m == ivw:
                continue
            m_line = f"  {m.method}: beta={m.beta:.4f}, p={m.pval:.2e}"
            if m.or_value is not None:
                ci_lo = f"{m.ci_lower:.3f}" if m.ci_lower is not None else "N/A"
                ci_hi = f"{m.ci_upper:.3f}" if m.ci_upper is not None else "N/A"
                m_line += f", OR={m.or_value:.3f} (95% CI: {ci_lo}-{ci_hi})"
            line += "\n" + m_line
        lines.append(line)
    return "\n".join(lines) if lines else "No significant findings."


def write_abstract_connected(
    llm: LLMClient,
    intro_text: str,
    methods_text: str,
    results_text: str,
    conclusion_text: str,
    key_data: str = "",
    language: str = "en",
) -> str:
    """Generate abstract from actual section content."""
    prompt = PAPER_CONNECTED_ABSTRACT.format(
        intro_summary=intro_text,
        methods_summary=methods_text,
        results_summary=results_text,
        conclusion_summary=conclusion_text,
        key_data=key_data,
    )
    return _generate_section(llm, prompt, language=language)


def write_data_availability(
    llm: LLMClient,
    results: list[MRAnalysisResult],
    slots: AnalysisSlots,
    language: str = "en",
) -> str:
    """Generate Data Availability Statement."""
    sources = []
    for r in results[:3]:
        src_type = r.exposure_source_type.value
        sources.append(f"Exposure: {r.exposure_name} ({src_type}, ID: {r.exposure_id})")
        src_type = r.outcome_source_type.value
        sources.append(f"Outcome: {r.outcome_name} ({src_type}, ID: {r.outcome_id})")
    if slots.exposure_source and slots.exposure_source.file_path:
        sources.append(f"Local exposure file: {slots.exposure_source.file_path}")
    if slots.outcome_source and slots.outcome_source.file_path:
        sources.append(f"Local outcome file: {slots.outcome_source.file_path}")
    data_sources = "\n".join(sources) if sources else "OpenGWAS API"
    prompt = PAPER_DATA_AVAILABILITY.format(data_sources=data_sources)
    return _generate_section(llm, prompt, max_tokens=800, language=language)


def write_ethics_statement(
    llm: LLMClient,
    results: list[MRAnalysisResult],
    language: str = "en",
) -> str:
    """Generate Ethics Statement."""
    source_types = set()
    for r in results:
        source_types.add(r.exposure_source_type.value)
        source_types.add(r.outcome_source_type.value)
    data_sources = ", ".join(sorted(source_types))
    prompt = PAPER_ETHICS.format(
        study_design="Two-sample Mendelian Randomization",
        data_sources=data_sources or "publicly available GWAS summary statistics",
    )
    return _generate_section(llm, prompt, max_tokens=500, language=language)
