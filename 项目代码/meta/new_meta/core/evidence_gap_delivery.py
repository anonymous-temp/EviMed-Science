"""Deterministic article delivery when a systematic search yields no eligible evidence."""
from __future__ import annotations

import re
from typing import Literal

from new_meta.schemas.protocol import ResearchProtocol


ZeroEvidenceReason = Literal["no_records_identified", "no_records_eligible"]


def complete_zero_record_review(
    *,
    project,
    protocol: ResearchProtocol,
    search_query: str,
    prisma_data: dict,
    reason: ZeroEvidenceReason,
    lang: str = "en",
) -> str:
    """Write a complete, editable evidence-gap article without inventing evidence."""
    language = "zh" if str(lang).lower().startswith("zh") else "en"
    counts = _prisma_counts(prisma_data)
    manuscript = (
        _render_zh(protocol, search_query, counts, reason)
        if language == "zh"
        else _render_en(protocol, search_query, counts, reason)
    )
    blocker = (
        "no_records_identified"
        if reason == "no_records_identified"
        else "no_records_eligible_after_title_abstract_screening"
    )
    report_state = {
        "report_type": "evidence_gap",
        "reason": reason,
        "n_direct_eligible": 0,
        "n_analyzable_primary": 0,
        "n_meta_eligible": 0,
        "prisma_records_identified": counts["identified"],
        "prisma_after_dedup": counts["deduplicated"],
        "prisma_full_text_assessed": counts["full_text"],
        "prisma_studies_included": 0,
    }
    facts = {
        "schema_version": 1,
        "report_type": "evidence_gap",
        "output_language": language,
        "research_question": protocol.research_question,
        "search": {
            "query": search_query,
            "source_names": list(protocol.databases),
        },
        "prisma": prisma_data,
        "studies": {"extracted_count": 0, "primary_analysis_count": 0},
        "evidence_readiness": {
            "status": "blocked",
            "report_type": "evidence_gap",
            "blocker_codes": [blocker],
            "blockers": [
                {
                    "code": blocker,
                    "message": (
                        "No records were identified by the final search."
                        if reason == "no_records_identified"
                        else "No records met the prespecified title/abstract eligibility criteria."
                    ),
                }
            ],
        },
    }
    validation = {
        "schema_version": 1,
        "passed": True,
        "publication_ready": False,
        "report_type": "evidence_gap",
        "reason": reason,
        "required_sections_present": True,
        "quantitative_claims_present": False,
        "search_query_present": bool(search_query and search_query in manuscript),
        "issues": [],
        "facts_summary": {
            "report_type": "evidence_gap",
            "n_studies": 0,
        },
    }
    project.save_json("report_state.json", report_state, subdir="analysis")
    project.save_json("manuscript_facts.json", facts, subdir="manuscript")
    project.save_json("manuscript_validation.json", validation, subdir="manuscript")
    project.save_text("draft.md", manuscript, subdir="manuscript")
    project.save_text("references.bib", "")
    project.save_checkpoint("manuscript")
    return manuscript


def _prisma_counts(prisma: dict) -> dict[str, int]:
    identification = prisma.get("identification") or {}
    screening = prisma.get("screening") or {}
    eligibility = prisma.get("eligibility") or {}
    return {
        "identified": int(identification.get("records_identified") or 0),
        "deduplicated": int(identification.get("records_after_dedup") or 0),
        "screened": int(screening.get("title_abstract_screened") or 0),
        "excluded": int(screening.get("title_abstract_excluded") or 0),
        "full_text": int(eligibility.get("full_text_assessed") or 0),
    }


def _render_en(
    protocol: ResearchProtocol,
    search_query: str,
    counts: dict[str, int],
    reason: ZeroEvidenceReason,
) -> str:
    outcome = protocol.pico.outcome_primary or "the primary outcome"
    result = (
        "No records were identified by the final search after one automatic broadening pass."
        if reason == "no_records_identified"
        else (
            f"{counts['screened']} title/abstract records were screened, and no record met "
            "the prespecified eligibility criteria."
        )
    )
    return f"""# Evidence availability for {outcome} in {protocol.pico.population}: a systematic review

## Abstract

**Background:** The availability of direct evidence for {protocol.research_question.rstrip('?')} was assessed.

**Methods:** We searched {', '.join(protocol.databases) or 'the prespecified bibliographic sources'} using a prospectively generated strategy and screened records against the review PICO and study-design criteria.

**Results:** {result} No study was eligible for full-text evidence extraction, risk-of-bias assessment, or quantitative synthesis.

**Conclusions:** The search found no eligible direct evidence for this narrowly defined question. This is an evidence-availability finding rather than evidence that the intervention has no effect.

## Introduction

The review question concerns {protocol.pico.population}, compares {protocol.pico.intervention or 'the intervention'} with {protocol.pico.comparator or 'the comparator'}, and targets {outcome}. A systematic search was undertaken to determine whether eligible direct studies were available.

## Methods

### Eligibility criteria

Eligible records had to address the prespecified population, intervention or exposure, comparator, primary outcome, and study designs ({', '.join(protocol.study_designs) or 'as specified in the protocol'}). Records outside that scope were not treated as direct evidence.

### Information sources and search

The prespecified sources were {', '.join(protocol.databases) or 'not reported'}. The final search strategy was:

```text
{search_query or 'Not reported'}
```

The pipeline performed one automatic broadening attempt before classifying the result as an evidence gap. Screening counts were retained in the PRISMA record.

### Synthesis

Quantitative synthesis was planned only if at least two eligible studies supplied source-verifiable primary-outcome data. No effect estimate was imputed from metadata or abstracts.

## Results

The search identified {counts['identified']} records and retained {counts['deduplicated']} after deduplication. {result} No study entered quantitative synthesis; therefore, no pooled effect, heterogeneity estimate, prediction interval, publication-bias analysis, or certainty rating was calculated.

## Discussion

This review documents a lack of eligible direct evidence for the exact question and search scope. It must not be interpreted as showing equivalence, benefit, harm, or absence of effect. A genuinely empty result can reflect a narrow question, terminology not captured by available indexing, unpublished research, or a true research gap.

Future updates should rerun the documented strategy, add newly available sources, and reassess eligibility if the scientific question changes. Broadening the population, intervention, comparator, outcome, or design would answer a different question and should be declared as a protocol amendment.

## Conclusions

No eligible direct study was available for the prespecified review question, so no quantitative meta-analysis was possible. The principal finding is an evidence gap requiring new primary research or a future updated search.

## Declarations

**Registration:** No registration identifier was supplied in the review input.

**Funding and conflicts of interest:** Not supplied in the review input.

**Data availability:** The editable project retains the protocol, exact search strategy, search records, screening counts, and this manuscript. No individual participant data were analyzed.
""".strip()


def _render_zh(
    protocol: ResearchProtocol,
    search_query: str,
    counts: dict[str, int],
    reason: ZeroEvidenceReason,
) -> str:
    outcome = _zh_outcome_label(protocol.pico.outcome_primary) or "主要结局"
    result = (
        "自动放宽一次检索后，最终仍未识别到任何记录。"
        if reason == "no_records_identified"
        else f"共筛选{counts['screened']}条题名/摘要，未发现符合预设标准的记录。"
    )
    return f"""# {outcome}的证据可得性：系统评价

## 摘要

**背景：** 本评价考察以下问题是否存在直接证据：{protocol.research_question}

**方法：** 检索{('、'.join(protocol.databases) or '预设文献来源')}，依据预设PICO和研究设计标准筛选记录。

**结果：** {result}没有研究进入全文证据提取、偏倚风险评价或定量合并。

**结论：** 本次检索未发现符合该严格问题定义的直接证据。这是证据可得性结论，不代表干预无效。

## 引言

本评价针对{protocol.pico.population}，比较{protocol.pico.intervention or '目标干预'}与{protocol.pico.comparator or '对照'}，主要结局为{outcome}。研究目的为系统判断是否存在可直接回答该问题的合格研究。

## 方法

### 纳入标准

记录需符合预设人群、干预或暴露、对照、主要结局及研究设计（{('、'.join(protocol.study_designs) or '方案预设设计')}）。超出该范围的记录不作为直接证据。

### 信息来源与检索

预设来源为{('、'.join(protocol.databases) or '未报告')}。最终检索式如下：

```text
{search_query or '未报告'}
```

系统在判定为证据缺口前自动放宽检索一次，并保留PRISMA筛选计数。

### 证据合成

仅在至少两项合格研究提供来源可核验的主要结局数据时开展定量合并。摘要或元数据中的数字不用于推算效应量。

## 结果

共识别{counts['identified']}条记录，去重后{counts['deduplicated']}条。{result}未进行定量合并，因此没有计算合并效应、异质性、预测区间、发表偏倚或证据确定性。

## 讨论

本评价记录了当前问题定义和检索范围内缺少合格直接证据的事实。该结果不能解释为等效、有益、有害或无效。空结果可能来自问题范围严格、索引术语覆盖不足、未发表研究，或真实研究缺口。

后续更新应复用所记录的检索式，加入新来源并重新判断资格。若改变人群、干预、对照、结局或设计，实质上是在回答不同问题，应作为方案修订明确记录。

## 结论

预设评价问题下没有可用的合格直接研究，因此无法进行定量Meta分析。主要发现为证据缺口，需要新的原始研究或未来更新检索。

## 声明

**注册：** 评价输入中未提供注册号。

**资助与利益冲突：** 评价输入中未提供。

**数据可得性：** 可编辑项目保留研究方案、完整检索式、检索记录、筛选计数及本文；未使用个体参与者数据。
""".strip()


def _zh_outcome_label(value: str) -> str:
    """Localize a few common protocol labels without inventing scientific content."""
    text = str(value or "").strip()
    match = re.fullmatch(r"(\d+)[ -]day mortality", text, flags=re.I)
    if match:
        return f"{match.group(1)}天死亡"
    if text.lower() == "mortality":
        return "死亡"
    return text
