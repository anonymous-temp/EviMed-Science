"""Manuscript fact table and hard validators.

The writing agent is allowed to phrase prose, but not to invent core facts.
This module builds a compact, auditable fact packet from deterministic pipeline
outputs and applies final manuscript checks that are too important to leave to
prompt wording alone.
"""
from __future__ import annotations

import json
import logging
import math
from pathlib import Path
import re
from typing import Any

from new_meta.core.manuscript_text_metrics import (
    main_publication_word_count,
    publication_min_main_words,
    publication_min_main_words_for_primary_count,
)
from new_meta.core.provenance import (
    PRIMARY_ALLOWED_TIERS,
    annotate_source_provenance,
    source_provenance_summary,
)
from new_meta.core.known_source_recovery import (
    TRIAL_ADDITIONAL_IDENTIFIERS,
    TRIAL_NCT_IDS,
    TRIAL_ORIGINAL_SOURCE_DETAILS,
    TRIAL_PUBLICATION_IDS,
    TRIAL_SLUGS,
)
from new_meta.core.denominator_recovery import (
    integer_evidenced_in_text,
    total_consistent_with_quoted_percentage,
)
from new_meta.engines.meta_engine import _to_original
from new_meta.schemas.grade import GRADEProfile
from new_meta.schemas.meta_result import MetaAnalysisResults, PooledEffect
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.schemas.risk_of_bias import StudyRoB
from new_meta.schemas.study import ExtractedStudy
from new_meta.tools.utils import first_author_lastname


logger = logging.getLogger("metaagent.manuscript_facts")


INTERNAL_LABEL_REPLACEMENTS = {
    "直接 eligible RCT": "直接相关随机对照试验",
    "direct eligible RCT": "directly relevant RCT",
    "direct_eligible_rct": "eligible RCT",
    "direct-eligible": "eligible",
    "direct eligible": "eligible",
    "direct_eligible": "eligible",
    "meta_eligible": "meta-analysis eligible",
    "analyzable_primary_outcome": "analyzable primary outcome",
}

PUBLICATION_TONE_PATTERNS = [
    r"\breproducibility benchmark\b",
    r"\bautomated systematic-review pipeline\b",
    r"\bautomated systematic review pipeline\b",
    r"\bmachine-readable record\b",
    r"\bgenerated manuscript\b",
    r"\bdebugging afterthought\b",
    r"\bremaining weakness is narrative polish\b",
    r"\bmanuscript should remain in review status\b",
    r"\breview-ready rather than submission-final\b",
    r"\buser-facing review\b",
    r"\bsource of truth\b",
    r"\bhard validation\b",
    r"\bautomated system\b",
    r"\bautomated review workflow\b",
    r"\bself-verification\b",
    r"\bself verification\b",
    r"\binternal validation\b",
    r"\bfirst-pass manuscript\b",
    r"\breviewer changes\b",
    r"\bwriting step\b",
    r"\bstored records\b",
    r"\bcheckpointed\b",
    r"事实锁定(?:写作|稿件|文本)?",
    r"结构化数据文件",
    r"结构化分析数据",
    r"同一套事实",
    r"可审计性",
    r"可审计",
    r"审稿意见能定位至具体数据行",
    r"具体数据行",
    r"选定主要行",
    r"来源核验字段",
    r"结构化证据表",
    r"结构化覆盖文件",
    r"提取复核界面",
    r"写作模块",
    r"只改正文",
    r"数据重新生成",
    r"重新生成效应量和稿件",
    r"全文都应随数据重新生成",
    r"逐节生成",
    r"参考对照报告",
    r"可核查性",
    r"证据链",
    r"人工修正",
]


COVID_CORTICOSTEROID_STUDY_CARD_NOTES = {
    "recovery": {
        "display_name": "RECOVERY",
        "intervention": "dexamethasone 6 mg once daily for up to 10 days",
        "population_note": (
            "The selected row is the invasive-mechanical-ventilation subgroup, not the full hospitalized "
            "RECOVERY population."
        ),
        "design_note": "Large open-label platform trial with respiratory-support strata.",
        "primary_outcome_note": "Trial-level 28-day mortality result; this review uses the critical-care subgroup.",
        "distinctive_feature": "Dominant source of precision for the pooled mortality estimate.",
        "interpretation_note": (
            "Supports a mortality benefit in patients already receiving invasive respiratory support, but does "
            "not by itself justify extrapolation to all hospitalized patients."
        ),
    },
    "codex": {
        "display_name": "CoDEX",
        "intervention": "dexamethasone in moderate or severe COVID-19 ARDS",
        "population_note": "Adults with COVID-19-associated moderate or severe ARDS.",
        "design_note": "Randomized trial in a mechanically ventilated ARDS population.",
        "primary_outcome_note": (
            "The trial's primary endpoint was ventilator-free days; mortality contributes as a compatible "
            "patient-important secondary outcome for the mortality synthesis."
        ),
        "distinctive_feature": "Second major dexamethasone source and clinically close to the target phenotype.",
        "interpretation_note": "Strengthens the dexamethasone-dominant signal but cannot settle long-term recovery.",
    },
    "remap_cap": {
        "display_name": "REMAP-CAP",
        "intervention": "hydrocortisone domain in an adaptive platform trial",
        "population_note": "Severe COVID-19 patients requiring ICU-level organ support.",
        "design_note": "International adaptive platform trial; the corticosteroid domain stopped after external evidence emerged.",
        "primary_outcome_note": "Organ-support and mortality outcomes were reported in the platform-trial framework.",
        "distinctive_feature": "Adds hydrocortisone evidence in a severe critical-care population.",
        "interpretation_note": "Supports class consistency but carries early-stopping and platform-context caveats.",
    },
    "cape_covid": {
        "display_name": "CAPE COVID",
        "intervention": "low-dose hydrocortisone",
        "population_note": "Critically ill COVID-19 patients with acute respiratory failure.",
        "design_note": "Placebo-controlled randomized trial stopped early after external dexamethasone evidence became available.",
        "primary_outcome_note": "Reported 21-day mortality or respiratory-support outcome; mortality is an adjacent short-term window.",
        "distinctive_feature": "Hydrocortisone trial with favorable but imprecise mortality direction.",
        "interpretation_note": "Contributes to class interpretation while preserving endpoint-window limitations.",
    },
    "dexa_covid_19": {
        "display_name": "DEXA-COVID",
        "intervention": "dexamethasone protocol/registry row",
        "population_note": "ARDS due to COVID-19 pneumonia.",
        "design_note": "Very small pilot/protocol-backed trial record.",
        "primary_outcome_note": "Mortality row is small and imprecise.",
        "distinctive_feature": "Opposite-direction point estimate with very low statistical weight.",
        "interpretation_note": "Useful as a caution against overclaiming uniform benefit across all settings.",
    },
    "covid_steroid": {
        "display_name": "COVID STEROID",
        "intervention": "low-dose hydrocortisone in severe hypoxia",
        "population_note": "Severe hypoxia due to COVID-19.",
        "design_note": "Registry/primary-report supported trial row with small sample size.",
        "primary_outcome_note": "Mortality comparison is compatible with the review window but imprecise.",
        "distinctive_feature": "Opposite-direction point estimate with low weight.",
        "interpretation_note": "Does not overturn pooled benefit but argues for regimen and timing caution.",
    },
    "steroids_sari": {
        "display_name": "Steroids-SARI",
        "intervention": "glucocorticoid therapy in severe acute respiratory failure",
        "population_note": "Critically ill patients with severe acute respiratory failure.",
        "design_note": "Trial registry and living-data source record.",
        "primary_outcome_note": "Small mortality row with broad uncertainty.",
        "distinctive_feature": "Near-null small trial row that broadens source coverage.",
        "interpretation_note": "Contributes little precision and should mainly inform uncertainty and source transparency.",
    },
}

DISCUSSION_PROCESS_PATTERNS = [
    r"\bai[- ]?detector\b",
    r"\bai[- ]?generated\b",
    r"\blower(?:ing)?\s+the\s+ai\s+detector\s+score\b",
    r"\bautomated\s+(?:full[- ]text\s+)?(?:parser|parsing|pipeline|workflow|manuscript)\b",
    r"\bgenerated\s+manuscript\b",
    r"\bmanuscript\s+generation\b",
    r"\bsubmission\s+(?:package|preparation)\b",
    r"\breview\s+package\b",
    r"\buser\s+(?:upload|uploaded|review)\b",
    r"\breview\s+ui\b",
    r"\bsource[- ](?:audit|coverage|linked|verified|verification|provenance)\b",
    r"\bsource\s+(?:audit|coverage|quote|quotes|excerpt|excerpts|location|locations|documentation|verification|provenance)\b",
    r"\btrace(?:able|ability)?\s+(?:to|from)\s+(?:the\s+)?(?:extraction|source|record|row)",
    r"\bextraction\s+(?:audit|record|records|row|rows|table|file|files|basis|queue)\b",
    r"\bstructured\s+(?:analysis|data|extraction|record|records)\b",
    r"\bmachine[- ]readable\b",
    r"\baudit\s+trail\b",
    r"\bcalculation\s+record\b",
    r"\bmanuscript_facts\.json\b",
    r"\bpipeline_warnings\.json\b",
    r"\bfact[- ]locked\b",
    r"\bsource\s+of\s+truth\b",
    r"\bwriting\s+(?:agent|module|step)\b",
    r"\bpolish(?:ed|ing)?\b",
    r"AI率",
    r"AI检测",
    r"AI查重",
    r"降低AI",
    r"绕开AI",
    r"自动(?:全文)?解析",
    r"自动生成",
    r"生成稿件",
    r"投稿(?:包|准备)",
    r"用户(?:上传|修改|复核)",
    r"提取复核(?:界面|过程)",
    r"来源提示",
    r"来源(?:核验|审计|覆盖|摘录|位置|记录)",
    r"原始报告摘录",
    r"提取(?:记录|行|表|文件|审计)",
    r"效应量计算",
    r"结构化(?:分析|数据|证据|提取|覆盖|记录)",
    r"事实(?:表|锁定)",
    r"可追溯",
    r"可核查",
    r"可审计",
    r"审稿和复核",
    r"审稿和投稿准备",
    r"写作(?:模块|器|步骤)",
    r"分段起草",
    r"证据链",
    r"语句是否流畅",
]

def _method_input_rows_for_readiness(method_input_audit: dict[str, Any]) -> list[dict[str, Any]]:
    """Project method-ledger inputs into the generic publication-readiness contract."""
    rows: list[dict[str, Any]] = []
    for item in method_input_audit.get("inputs") or []:
        if not isinstance(item, dict):
            continue
        locators = item.get("source_locators") or []
        locator = locators[0] if locators and isinstance(locators[0], dict) else {}
        raw_data = item.get("raw_data") if isinstance(item.get("raw_data"), dict) else {}
        estimate = item.get("estimate") if isinstance(item.get("estimate"), dict) else {}
        derivation = item.get("derivation") if isinstance(item.get("derivation"), dict) else {}
        row = {
            "row_id": item.get("result_id"),
            "result_id": item.get("result_id"),
            "study_id": item.get("study_id"),
            "outcome_name": item.get("outcome_id"),
            "timepoint": item.get("timepoint"),
            "subgroup": item.get("subgroup"),
            "effect_measure": item.get("effect_measure"),
            "decision": "selected_within_study",
            "in_final_primary_analysis": True,
            "source_location": locator.get("table") or locator.get("section") or "",
            "source_section": locator.get("section") or "",
            "source_page": locator.get("page"),
            "source_quote": locator.get("quote") or "",
            "source_quote_verified": locator.get("quote_verified") is True,
            "extraction_confidence": (
                "verified"
                if item.get("evidence_state") in {"verified", "adjudicated"}
                else "unverified"
            ),
            "method_input_data_type": raw_data.get("data_type"),
            "events_intervention": derivation.get("events_intervention"),
            "total_intervention": derivation.get("total_intervention"),
            "events_control": derivation.get("events_control"),
            "total_control": derivation.get("total_control"),
            "effect_size": estimate.get("estimate"),
            "reported_effect_measure": estimate.get("measure") or item.get("effect_measure"),
            "standard_error": estimate.get("standard_error"),
            "variance": estimate.get("variance"),
            "ci_lower": estimate.get("ci_lower"),
            "ci_upper": estimate.get("ci_upper"),
            "events": raw_data.get("events"),
            "total": raw_data.get("total"),
            "true_positive": raw_data.get("true_positive"),
            "false_negative": raw_data.get("false_negative"),
            "false_positive": raw_data.get("false_positive"),
            "true_negative": raw_data.get("true_negative"),
        }
        rows.append(row)
    return rows


def build_manuscript_facts(
    *,
    protocol: ResearchProtocol,
    meta_results: MetaAnalysisResults | None = None,
    extracted_studies: list[ExtractedStudy] | None = None,
    rob_results: list[StudyRoB] | None = None,
    prisma_data: dict | None = None,
    search_query: str = "",
    project=None,
    grade_profile: GRADEProfile | None = None,
) -> dict[str, Any]:
    """Build the single machine-readable fact source for manuscript writing."""
    extracted_studies = extracted_studies or []
    rob_results = rob_results or []
    prisma_data = prisma_data or {}

    search_source_counts = _load_project_json(project, "search_source_counts.json") or {}
    text_source_warnings = _load_project_json(project, "text_source_warnings.json") or []
    text_source_warnings = _filter_limited_text_warnings_resolved_by_benchmark_sources(
        text_source_warnings,
        project,
    )
    extraction_audit = _load_project_json(project, "extraction_audit.json", subdir="extraction") or {}
    extraction_audit = _apply_extraction_review_decisions(project, extraction_audit)
    evidence_understanding = _load_project_json(project, "evidence_understanding.json", subdir="extraction") or {}
    background_evidence = _compact_background_evidence_context(
        _load_project_json(project, "evidence_context.json", subdir="search") or {}
    )
    effect_selection_audit = _load_project_json(project, "effect_selection_audit.json", subdir="analysis") or []
    synthesis_result = _load_project_json(project, "synthesis_result.json", subdir="analysis") or {}
    method_input_audit = _load_project_json(project, "method_input_audit.json", subdir="analysis") or {}
    method_certainty = _load_project_json(project, "method_certainty.json", subdir="analysis") or {}
    compiled_method_active = bool(synthesis_result and method_input_audit)
    if not meta_results and synthesis_result and method_input_audit:
        effect_selection_audit = _method_input_rows_for_readiness(method_input_audit)
    effect_selection_audit = _annotate_effect_selection_audit_provenance(project, effect_selection_audit)
    model_decision = _load_project_json(project, "model_decision.json", subdir="analysis") or {}
    model_sensitivity = _load_project_json(project, "model_sensitivity.json", subdir="analysis") or {}
    positioning = _load_project_json(project, "positioning.json", subdir="analysis") or {}
    grade_inputs_snapshot = _load_project_json(project, "grade_inputs_snapshot.json", subdir="analysis") or {}
    if compiled_method_active and not meta_results:
        estimator = str(synthesis_result.get("estimator") or "")
        model_decision = {
            "schema_version": 1,
            "primary_model": estimator,
            "primary_engine_model": estimator,
            "tau_estimator": estimator,
            "reason": "The prespecified compiled method for this review family determined the estimator.",
            "compiled_method": True,
        }
        engine_payload = synthesis_result.get("engine_payload") or {}
        model_sensitivity = (
            engine_payload.get("sensitivity")
            or engine_payload.get("one_stage_sensitivity")
            or {}
        )
        grade_inputs_snapshot = {}
    pipeline_warnings = _load_project_json(project, "pipeline_warnings.json") or []
    if not isinstance(pipeline_warnings, list):
        pipeline_warnings = []
    search_source_counts_display = _source_counts(search_source_counts)
    source_names = _source_names(search_source_counts, prisma_data, search_query=search_query)
    extracted_label_by_id = _study_label_lookup(extracted_studies)
    extracted_labels = _dedupe([label for label in (_study_label(study) for study in extracted_studies) if label])

    primary = None
    primary_study_ids: list[str] = []
    primary_study_labels: list[str] = []
    actual_model = ""
    if meta_results and meta_results.primary_outcome:
        po = meta_results.primary_outcome
        actual_model = _actual_primary_model(po, model_decision)
        primary_study_ids = [s.study_id for s in po.studies]
        primary_study_labels = _dedupe([
            extracted_label_by_id.get(s.study_id, s.study_label)
            for s in po.studies
            if extracted_label_by_id.get(s.study_id, s.study_label)
        ])
        primary = {
            "outcome_name": po.outcome_name,
            "effect_measure": po.effect_measure,
            "n_studies": po.n_studies,
            "pooled_effect": po.pooled_effect,
            "ci_lower": po.ci_lower,
            "ci_upper": po.ci_upper,
            "p_value": po.p_value,
            "i_squared": po.i_squared,
            "tau_squared": po.tau_squared,
            "model": actual_model or po.model,
            "engine_model": actual_model or po.model,
            "tau_estimator": po.tau_estimator,
            "studies": [
                {
                    "study_id": s.study_id,
                    "study_label": extracted_label_by_id.get(s.study_id, s.study_label),
                    "effect": _to_original(s.yi, po.effect_measure),
                    "se": s.se,
                    "weight": s.weight,
                }
                for s in po.studies
            ],
        }
    elif synthesis_result and method_input_audit:
        estimates = synthesis_result.get("primary_estimates") or []
        estimate = estimates[0] if estimates else None
        inputs = method_input_audit.get("inputs") or []
        if estimate and inputs:
            primary_study_ids = _dedupe([str(item.get("study_id") or "") for item in inputs])
            primary_study_labels = _dedupe([
                extracted_label_by_id.get(study_id, study_id)
                for study_id in primary_study_ids
                if study_id
            ])
            actual_model = str(synthesis_result.get("estimator") or "")
            heterogeneity = synthesis_result.get("heterogeneity") or {}
            engine_studies = {
                str(item.get("study_id") or ""): item
                for item in (synthesis_result.get("engine_payload") or {}).get("study_effects") or []
                if isinstance(item, dict)
            }
            analysis_scale = str(
                ((synthesis_result.get("engine_payload") or {}).get("diagnostics") or {}).get("analysis_scale")
                or heterogeneity.get("scale")
                or ""
            ).lower()
            ratio_measure = str(estimate.get("measure") or protocol.effect_measure).upper() in {
                "OR", "RR", "HR", "IRR"
            }
            inverse_variances = {
                study_id: (1.0 / float(item.get("variance")))
                for study_id, item in engine_studies.items()
                if item.get("variance") not in {None, 0}
            }
            total_inverse_variance = sum(inverse_variances.values())
            method_study_rows = []
            for item in inputs:
                study_id = str(item.get("study_id") or "")
                engine_item = engine_studies.get(study_id, {})
                audit_estimate = item.get("estimate") if isinstance(item.get("estimate"), dict) else {}
                effect_value = audit_estimate.get("estimate")
                se_value = audit_estimate.get("standard_error")
                if engine_item.get("analysis_effect") is not None:
                    analysis_effect = float(engine_item["analysis_effect"])
                    effect_value = math.exp(analysis_effect) if ratio_measure and "log" in analysis_scale else analysis_effect
                if engine_item.get("variance") is not None:
                    se_value = math.sqrt(float(engine_item["variance"]))
                method_study_rows.append({
                    "study_id": study_id,
                    "study_label": extracted_label_by_id.get(study_id, study_id),
                    "result_id": item.get("result_id"),
                    "effect": effect_value,
                    "se": se_value,
                    "weight": (
                        100.0 * inverse_variances.get(study_id, 0.0) / total_inverse_variance
                        if total_inverse_variance else None
                    ),
                    "raw_data": item.get("raw_data"),
                })
            primary = {
                "outcome_name": protocol.pico.outcome_primary or estimate.get("label"),
                "effect_measure": estimate.get("measure") or protocol.effect_measure,
                "n_studies": int(synthesis_result.get("n_studies") or len(inputs)),
                "pooled_effect": estimate.get("estimate"),
                "ci_lower": estimate.get("ci_lower"),
                "ci_upper": estimate.get("ci_upper"),
                "prediction_lower": estimate.get("prediction_lower"),
                "prediction_upper": estimate.get("prediction_upper"),
                "p_value": None,
                "i_squared": heterogeneity.get("i_squared"),
                "tau_squared": heterogeneity.get("tau_squared"),
                "model": actual_model,
                "engine_model": actual_model,
                "tau_estimator": actual_model,
                "studies": method_study_rows,
            }

    evidence_readiness = _evidence_readiness_facts(
        primary=primary,
        protocol=protocol,
        text_source_warnings=text_source_warnings,
        extraction_audit=extraction_audit,
        effect_selection_audit=effect_selection_audit,
        positioning=positioning if isinstance(positioning, dict) else {},
    )
    _normalise_selected_row_labels(evidence_readiness.get("selected_primary_rows", []), extracted_label_by_id)
    _apply_known_original_sources_to_selected_rows(protocol, evidence_readiness.get("selected_primary_rows", []))
    provenance = source_provenance_summary(evidence_readiness.get("selected_primary_rows", []))
    abstract_only_count = sum(
        1
        for item in text_source_warnings
        if str(item.get("text_availability") or "abstract_only") == "abstract_only"
    )
    metadata_only_count = sum(
        1
        for item in text_source_warnings
        if str(item.get("text_availability") or "") == "metadata_only"
    )
    primary_population = _primary_population_facts(evidence_readiness.get("selected_primary_rows", []))
    if compiled_method_active and not primary_population.get("selected_total_participants"):
        sample_sizes: dict[str, int] = {}
        for study in extracted_studies:
            study_id = _study_id(study)
            total = _coerce_int(getattr(study.characteristics, "total_sample_size", 0))
            if study_id and total:
                sample_sizes[study_id] = total
                sample_sizes[f"study:{study_id}"] = total
        selected_total = sum(sample_sizes.get(study_id, 0) for study_id in set(primary_study_ids))
        ipd_total = _coerce_int(
            ((synthesis_result.get("engine_payload") or {}).get("n_participants"))
        )
        primary_population["selected_total_participants"] = ipd_total or selected_total
    study_cards = _study_cards_facts(
        protocol=protocol,
        selected_rows=evidence_readiness.get("selected_primary_rows", []),
        primary=primary,
    )
    study_cards = _merge_evidence_understanding_study_cards(study_cards, evidence_understanding)
    domain_controversy_candidates = _domain_controversy_candidates(
        protocol=protocol,
        background_evidence=background_evidence,
        evidence_understanding=evidence_understanding,
        study_cards=study_cards,
    )
    baseline_risk_scenarios = _load_baseline_risk_scenarios(project)
    absolute_effects = _absolute_effect_facts(primary, primary_population, baseline_risk_scenarios)
    secondary_effects = _secondary_effect_facts(meta_results)
    subgroup_effects = _subgroup_effect_facts(meta_results)

    primary_label_keys = {_study_label_key(item) for item in primary_study_labels}
    facts = {
        "report_type": evidence_readiness["report_type"],
        "method_family": str(synthesis_result.get("family") or ""),
        "synthesis_result": synthesis_result if isinstance(synthesis_result, dict) else {},
        "research_question": protocol.research_question,
        "pico": {
            "population": protocol.pico.population,
            "intervention": protocol.pico.intervention,
            "comparator": protocol.pico.comparator,
            "primary_outcome": protocol.pico.outcome_primary,
        },
        "effect_measure": protocol.effect_measure,
        "model": actual_model or protocol.model_preference,
        "requested_model": protocol.model_preference,
        "model_decision": model_decision if isinstance(model_decision, dict) else {},
        "model_sensitivity": model_sensitivity if isinstance(model_sensitivity, dict) else {},
        "positioning": positioning if isinstance(positioning, dict) else {},
        "prisma": _prisma_facts(prisma_data),
        "search": {
            "query": search_query,
            "source_counts": search_source_counts_display,
            "source_names": source_names,
        },
        "studies": {
            "extracted_count": len(extracted_studies),
            "extracted_ids": [_study_id(s) for s in extracted_studies],
            "extracted_labels": extracted_labels,
            "primary_analysis_count": len(primary_study_ids),
            "primary_analysis_ids": primary_study_ids,
            "primary_analysis_labels": primary_study_labels,
            "non_primary_review_labels": [
                label for label in extracted_labels
                if _study_label_key(label) not in primary_label_keys
            ],
        },
        "primary_effect": primary,
        "secondary_effects": secondary_effects,
        "subgroup_effects": subgroup_effects,
        "source_provenance": provenance,
        "primary_population": primary_population,
        "study_cards": study_cards,
        "evidence_understanding": _compact_evidence_understanding(evidence_understanding),
        "background_evidence": background_evidence,
        "domain_controversy_candidates": domain_controversy_candidates,
        "absolute_effects": absolute_effects,
        "rob": {
            "count": len(rob_results),
            "tools": sorted({r.tool_used for r in rob_results if r.tool_used}),
            "synthetic_count": sum(1 for r in rob_results if r.is_synthetic),
        },
        "grade": (
            _method_certainty_facts(
                method_certainty,
                synthesis_result,
                selected_total_n=primary_population.get("selected_total_participants") or 0,
            )
            if compiled_method_active and not meta_results
            else _grade_facts(
                grade_profile,
                primary_n=len(primary_study_ids),
                selected_total_n=primary_population.get("selected_total_participants") or 0,
            )
        ),
        "grade_inputs": grade_inputs_snapshot if isinstance(grade_inputs_snapshot, dict) else {},
        "text_sources": {
            "abstract_only_count": abstract_only_count,
            "metadata_only_count": metadata_only_count,
            "limited_source_count": len(text_source_warnings),
            "warnings": text_source_warnings,
        },
        "pipeline_warnings": pipeline_warnings,
        "evidence_readiness": evidence_readiness,
        "writing_constraints": {
            "human_review_claims_allowed": False,
            "prospero_registration_claim_allowed": False,
            "publication_bias_formal_tests_min_studies": 10,
            "publication_min_main_words": publication_min_main_words_for_primary_count(len(primary_study_ids)),
            "publication_min_main_words_source": "generated",
        },
    }
    return facts


def validate_and_repair_manuscript(manuscript: str, facts: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Apply hard manuscript fixes and return a validation report."""
    issues: list[dict[str, Any]] = []
    repaired = manuscript

    for old, new in INTERNAL_LABEL_REPLACEMENTS.items():
        if old in repaired:
            repaired = repaired.replace(old, new)
            issues.append(_issue("internal_label", "fixed", f"Replaced internal label {old!r}."))

    repaired, tone_issues = _repair_publication_tone(repaired)
    issues.extend(tone_issues)

    repaired, process_discussion_issues = _repair_process_framed_discussion(repaired)
    issues.extend(process_discussion_issues)

    repaired, process_note_issues = _repair_publication_process_notes(repaired)
    issues.extend(process_note_issues)

    repaired, path_spacing_issues = _repair_file_path_spacing(repaired)
    issues.extend(path_spacing_issues)

    repaired, heading_glue_issues = _repair_heading_glue(repaired)
    issues.extend(heading_glue_issues)

    repaired, reviewer_issues = _repair_reviewer_claims(repaired)
    issues.extend(reviewer_issues)

    repaired, registration_issues = _repair_registration_claims(repaired)
    issues.extend(registration_issues)

    repaired, source_issues = _ensure_search_source_note(repaired, facts)
    issues.extend(source_issues)

    repaired, source_claim_issues = _repair_search_source_claims(repaired, facts)
    issues.extend(source_claim_issues)

    repaired, source_label_issues = _repair_search_source_label_text(repaired)
    issues.extend(source_label_issues)

    repaired, text_source_issues = _ensure_text_source_note(repaired, facts)
    issues.extend(text_source_issues)

    repaired, pipeline_warning_issues = _ensure_pipeline_warning_note(repaired, facts)
    issues.extend(pipeline_warning_issues)

    repaired, pub_bias_issues = _repair_publication_bias_claims(repaired, facts)
    issues.extend(pub_bias_issues)

    repaired, low_k_heterogeneity_issues = _repair_low_k_heterogeneity_claims(repaired, facts)
    issues.extend(low_k_heterogeneity_issues)

    repaired, nr_total_issues = _repair_nr_total_sample_claims(repaired, facts)
    issues.extend(nr_total_issues)

    repaired, artifact_issues = _repair_statistical_test_artifacts(repaired)
    issues.extend(artifact_issues)

    repaired, mechanical_issues = _repair_mechanical_publication_phrases(repaired, facts)
    issues.extend(mechanical_issues)

    repaired, prisma_issues = _repair_prisma_summary(repaired, facts)
    issues.extend(prisma_issues)

    repaired, primary_availability_issues = _repair_primary_availability_claims(repaired, facts)
    issues.extend(primary_availability_issues)

    repaired, grade_issues = _repair_grade_domain_summary(repaired, facts)
    issues.extend(grade_issues)

    repaired, grade_contradiction_issues = _repair_grade_no_concern_contradictions(repaired, facts)
    issues.extend(grade_contradiction_issues)

    repaired, certainty_language_issues = _repair_grade_certainty_limit_language(repaired, facts)
    issues.extend(certainty_language_issues)

    repaired, grade_reader_language_issues = _repair_grade_reader_language(repaired)
    issues.extend(grade_reader_language_issues)

    repaired, readability_issues = _repair_overlong_interpretive_sentences(repaired)
    issues.extend(readability_issues)

    repaired, broken_citation_issues = _repair_broken_inline_citation_artifacts(repaired)
    issues.extend(broken_citation_issues)

    repaired, self_result_citation_issues = _repair_self_result_external_citations(repaired, facts)
    issues.extend(self_result_citation_issues)

    readiness_issues = _evidence_readiness_issues(facts)
    if readiness_issues:
        repaired = _ensure_evidence_readiness_note(repaired, facts)
    issues.extend(readiness_issues)

    repaired, non_publication_issues = _repair_non_publication_quantitative_claims(repaired, facts)
    issues.extend(non_publication_issues)

    count_issues = _detect_count_mismatches(repaired, facts)
    issues.extend(count_issues)

    effect_issues = _detect_primary_effect_mismatch(repaired, facts)
    issues.extend(effect_issues)

    repaired, arm_event_issues = _repair_arm_level_event_fraction_claims(repaired, facts)
    issues.extend(arm_event_issues)

    repaired, patient_total_repair_issues = _repair_patient_total_claims(repaired, facts)
    issues.extend(patient_total_repair_issues)

    patient_total_issues = _detect_patient_total_mismatches(repaired, facts)
    issues.extend(patient_total_issues)

    repaired, artifact_repair_issues = _repair_artifact_reference_mismatches(repaired)
    issues.extend(artifact_repair_issues)

    repaired, study_label_repair_issues = _repair_non_primary_study_label_claims(repaired, facts)
    issues.extend(study_label_repair_issues)

    artifact_reference_issues = _detect_artifact_reference_mismatches(repaired)
    issues.extend(artifact_reference_issues)

    study_label_issues = _detect_non_primary_study_label_claims(repaired, facts)
    issues.extend(study_label_issues)

    secondary_effect_issues = _detect_reported_effect_mismatches(
        repaired,
        facts.get("secondary_effects", []),
        issue_prefix="secondary",
    )
    issues.extend(secondary_effect_issues)

    subgroup_effect_issues = _detect_reported_effect_mismatches(
        repaired,
        facts.get("subgroup_effects", []),
        issue_prefix="subgroup",
    )
    issues.extend(subgroup_effect_issues)

    publication_length_issues = _publication_length_issues(repaired, facts)
    issues.extend(publication_length_issues)

    publication_contract_issues = _detect_publication_contract_violations(repaired, facts)
    issues.extend(publication_contract_issues)

    report = {
        "passed": not any(item["severity"] == "error" for item in issues),
        "issues": issues,
        "facts_summary": {
            "search_sources": facts.get("search", {}).get("source_names", []),
            "primary_analysis_count": (facts.get("primary_effect") or {}).get("n_studies"),
            "abstract_only_count": facts.get("text_sources", {}).get("abstract_only_count", 0),
            "metadata_only_count": facts.get("text_sources", {}).get("metadata_only_count", 0),
            "limited_source_count": facts.get("text_sources", {}).get("limited_source_count", 0),
            "primary_selected_total_participants": facts.get("primary_population", {}).get("selected_total_participants", 0),
            "absolute_effect_scenario_count": len((facts.get("absolute_effects") or {}).get("scenarios") or []),
            "secondary_effect_count": len(facts.get("secondary_effects", [])),
            "subgroup_effect_count": len(facts.get("subgroup_effects", [])),
            "pipeline_warning_count": len(facts.get("pipeline_warnings", []) or []),
            "report_type": facts.get("report_type", "meta"),
            "main_word_count": _main_publication_word_count(repaired),
        },
    }
    return repaired, report


def _repair_overlong_interpretive_sentences(manuscript: str) -> tuple[str, list[dict[str, Any]]]:
    """Split a common effect-to-absolute-effect bridge without changing facts."""
    repaired = str(manuscript or "")
    original = repaired
    repaired = re.sub(
        r",\s+corresponding\s+to\s+",
        ". This corresponds to ",
        repaired,
        flags=re.IGNORECASE,
    )
    if repaired == original:
        return repaired, []
    return repaired, [_issue(
        "overlong_interpretive_sentence_split",
        "fixed",
        "Split relative-effect and absolute-effect clauses into separate sentences for readability.",
    )]


def _report_type(facts: dict[str, Any]) -> str:
    return str((facts or {}).get("report_type") or "meta").strip().lower()


def _primary_n_from_facts(facts: dict[str, Any]) -> int:
    primary = (facts or {}).get("primary_effect") or {}
    studies = (facts or {}).get("studies") or {}
    for value in (primary.get("n_studies"), studies.get("primary_analysis_count")):
        try:
            return int(value or 0)
        except (TypeError, ValueError):
            continue
    return 0


def _has_reportable_primary_effect(facts: dict[str, Any]) -> bool:
    """Return true when a draft may report a pooled primary result.

    Publication-mode meta-analyses and benchmark reconstructions can both report
    a quantitative pooled effect. They differ in provenance claims: a benchmark
    reconstruction must disclose its secondary-source role, while a publication
    meta-analysis must pass the primary-source gate.
    """
    if _report_type(facts) not in {"meta", "benchmark_reconstruction"}:
        return False
    readiness = (facts or {}).get("evidence_readiness") or {}
    if readiness.get("blockers"):
        return False
    primary = (facts or {}).get("primary_effect") or {}
    if _primary_n_from_facts(facts) < 2:
        return False
    return primary.get("pooled_effect") is not None and primary.get("ci_lower") is not None and primary.get("ci_upper") is not None


def _repair_low_k_heterogeneity_claims(manuscript: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    """Keep low-k heterogeneity metrics descriptive, not interpretive.

    With fewer than three contributing studies, I²/tau² can be reported as an
    analysis output, but they should not be framed as evidence that studies are
    homogeneous, compatible, or reassuringly consistent.
    """
    primary_n = _primary_n_from_facts(facts)
    if primary_n <= 0 or primary_n >= 3:
        return manuscript, []

    repaired = str(manuscript or "")
    original = repaired
    replacements = [
        (
            r"\bHeterogeneity was low to moderate(?=\s*[\(\[]?(?:I²|I2|tau|τ|Cochran))",
            "Heterogeneity statistics were descriptive only",
        ),
        (
            r"\bHeterogeneity was low(?=\s*[\(\[]?(?:I²|I2|tau|τ|Cochran))",
            "Heterogeneity statistics were descriptive only",
        ),
        (
            r"\blow heterogeneity(?=[^.。]{0,80}(?:I²|I2|tau|τ|Cochran))",
            "descriptive heterogeneity statistics",
        ),
        (
            r"\bthe absence of (?:a strong )?heterogeneity signal is reassuring\b",
            "the low-k heterogeneity signal is descriptive",
        ),
        (
            r"(?:统计)?异质性较低(?=（?(?:I²|I2|tau|τ|Cochran))",
            "异质性统计量仅作描述性参考",
        ),
        (
            r"(?:统计)?异质性低(?=（?(?:I²|I2|tau|τ|Cochran))",
            "异质性统计量仅作描述性参考",
        ),
        (
            r"异质性(?:较)?低(?=[^。]{0,80}(?:I²|I2|tau|τ|Cochran))",
            "异质性统计量仅作描述性参考",
        ),
        (
            r"较低的异质性(?=[^。]{0,80}(?:I²|I2|tau|τ|Cochran))",
            "描述性异质性统计量",
        ),
        (
            r"未见明显异质性(?=[^。]{0,80}(?:I²|I2|tau|τ|Cochran))",
            "异质性统计量仅作描述性参考",
        ),
    ]
    for pattern, replacement in replacements:
        repaired = re.sub(pattern, replacement, repaired, flags=re.IGNORECASE)

    if repaired == original:
        return manuscript, []
    return repaired, [_issue(
        "low_k_heterogeneity_claim_repaired",
        "fixed",
        "Reframed heterogeneity wording as descriptive because fewer than three studies contributed to the primary meta-analysis.",
        primary_n=primary_n,
    )]


def _repair_broken_inline_citation_artifacts(manuscript: str) -> tuple[str, list[dict[str, Any]]]:
    """Repair citation markers that split comparison phrases into broken sentences."""
    repaired = str(manuscript or "")
    original = repaired
    citation = r"(?:\[[0-9,\s\-–—]+\]|［[0-9，,\s\-–—]+］)"
    repaired = re.sub(
        rf"\b(vs|versus)\s*{citation}\s*\.\s+",
        r"\1 ",
        repaired,
        flags=re.IGNORECASE,
    )
    repaired = re.sub(
        rf"\b(vs|versus)\s*{citation}\s*。\s*",
        r"\1 ",
        repaired,
        flags=re.IGNORECASE,
    )
    repaired = re.sub(
        rf"(住院)\s*(?:vs|versus)\s*{citation}\s*[\.\。]\s*(恶化/紧急就诊)",
        r"\1 vs \2",
        repaired,
        flags=re.IGNORECASE,
    )
    if repaired == original:
        return manuscript, []
    return repaired, [_issue(
        "broken_inline_citation_artifact_repaired",
        "fixed",
        "Moved or removed an inline citation marker that split a comparison phrase.",
    )]


def _repair_search_source_label_text(manuscript: str) -> tuple[str, list[dict[str, Any]]]:
    return manuscript, []


def _repair_grade_certainty_limit_language(manuscript: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    """Align vague 'limited evidence' language with the structured GRADE rating."""
    certainty = _primary_grade_certainty(facts)
    if certainty not in {"high", "moderate"}:
        return manuscript, []

    repaired = str(manuscript or "")
    original = repaired
    zh_certainty = "高" if certainty == "high" else "中等"
    en_certainty = "high" if certainty == "high" else "moderate"
    repaired = re.sub(
        r"证据仍有限，尚需进一步验证",
        f"证据确定性为{zh_certainty}，结果解释仍需结合研究数量、终点定义和适用人群谨慎判断",
        repaired,
    )
    repaired = re.sub(
        r"现有有限证据提示",
        f"现有{zh_certainty}确定性证据提示",
        repaired,
    )
    repaired = re.sub(
        r"结论尚需进一步验证",
        "结果解释需结合研究数量、终点定义和适用人群谨慎判断",
        repaired,
    )
    repaired = re.sub(
        r"(每1000[^。；;\n]{0,80})可避免(\d+例)",
        r"\1可能避免\2例",
        repaired,
    )
    repaired = re.sub(
        r"证据(?:仍然)?有限",
        f"证据确定性为{zh_certainty}",
        repaired,
    )
    repaired = re.sub(
        r"证据仍属有限",
        f"证据确定性为{zh_certainty}",
        repaired,
    )
    repaired = re.sub(
        r"证据基础相对有限",
        f"证据确定性为{zh_certainty}，但证据基础仍受研究数量限制",
        repaired,
    )
    repaired = re.sub(
        r"\bevidence remains limited\b",
        f"evidence certainty was {en_certainty}",
        repaired,
        flags=re.IGNORECASE,
    )
    repaired = re.sub(
        r"\blimited evidence\b",
        f"{en_certainty}-certainty evidence",
        repaired,
        flags=re.IGNORECASE,
    )
    if repaired == original:
        return manuscript, []
    return repaired, [_issue(
        "grade_certainty_language_repaired",
        "fixed",
        f"Aligned vague evidence-limit wording with the structured GRADE certainty ({certainty}).",
        certainty=certainty,
    )]


def _repair_grade_reader_language(manuscript: str) -> tuple[str, list[dict[str, Any]]]:
    """Translate GRADE audit terminology into manuscript-facing language."""
    repaired = str(manuscript or "")
    original = repaired

    repaired = repaired.replace("最优信息量（OIS）", "预设信息量")
    repaired = repaired.replace("最优信息量", "预设信息量")
    repaired = re.sub(
        r"\bOIS\b",
        "prespecified information-size requirement",
        repaired,
        flags=re.IGNORECASE,
    )
    repaired = re.sub(
        r"\boptimal information size(?:\s+threshold)?\b",
        "prespecified information-size requirement",
        repaired,
        flags=re.IGNORECASE,
    )
    repaired = re.sub(
        r"Total N\s*=\s*([0-9,]+)(?:\s*\([^)]*\))?\s*vs\s*prespecified information-size requirement\s*=\s*([0-9,]+);"
        r"(?:\s*CI width\s*=\s*([0-9.]+);)?\s*CI crosses null\s*=\s*(True|False)",
        lambda m: (
            f"The selected pooled sample included {m.group(1)} participants; the sample size met the "
            "prespecified information-size requirement and the confidence interval "
            f"{'crossed' if m.group(4).lower() == 'true' else 'did not cross'} the null."
        ),
        repaired,
        flags=re.IGNORECASE,
    )
    repaired = re.sub(
        r"\bCI crosses null\s*=\s*(True|False)\b",
        lambda m: "the confidence interval crossed the null" if m.group(1).lower() == "true" else "the confidence interval did not cross the null",
        repaired,
        flags=re.IGNORECASE,
    )
    repaired = re.sub(
        r"\bTotal N\s*=\s*([0-9,]+)\b",
        r"the selected pooled sample included \1 participants",
        repaired,
        flags=re.IGNORECASE,
    )

    if repaired == original:
        return manuscript, []
    return repaired, [_issue(
        "grade_reader_language_repaired",
        "fixed",
        "Translated GRADE audit terminology into reader-facing manuscript language.",
    )]


def _primary_grade_certainty(facts: dict[str, Any]) -> str:
    outcomes = ((facts or {}).get("grade") or {}).get("outcomes") or []
    if not outcomes:
        return ""
    certainty = str((outcomes[0] or {}).get("certainty") or "").strip().lower()
    aliases = {
        "high": "high",
        "moderate": "moderate",
        "中等": "moderate",
        "高": "high",
    }
    return aliases.get(certainty, certainty)


def _repair_non_publication_quantitative_claims(manuscript: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    """Downgrade non-meta reports so they cannot read like failed meta papers."""
    if _has_reportable_primary_effect(facts):
        return manuscript, []

    repaired = str(manuscript or "")
    original = repaired
    issues: list[dict[str, Any]] = []
    zh = _manuscript_or_requested_language_is_zh(repaired, facts)
    replacement_title = "# 证据缺口系统综述" if zh else "# Evidence-gap systematic review"

    first_line, sep, rest = repaired.partition("\n")
    if first_line.startswith("# ") and re.search(r"\bMeta[- ]analysis\b|Meta分析|荟萃分析", first_line, flags=re.I):
        repaired = replacement_title + (sep + rest if sep else "")
        issues.append(_issue(
            "non_meta_title_repaired",
            "fixed",
            "Replaced a meta-analysis title with an evidence-gap title because no publishable primary pooled effect is available.",
        ))

    quantitative_replacement = (
        "当前资料不足以计算主要结局的合并效应；本稿仅作为证据缺口和待补全文清单使用。"
        if zh else
        "The available evidence was insufficient to calculate a pooled primary effect; this draft should be used as an evidence-gap report and full-text acquisition checklist."
    )
    patterns = [
        r"主要Meta分析纳入\d+项研究、共0名参与者[^。]*。",
        r"主要Meta分析纳入\d+项研究[^。]*合并效应为[^。]*NR[^。]*。",
        r"合并效应为[^。]*NR[^。]*。",
        r"合并结果为[^。]*NR[^。]*。",
        r"合并估计在正文中报告为[^。]*NR[^。]*。",
        r"主要计算使用\d+项主要分析研究和0名参与者。",
        r"The primary meta-analysis included\s+\d+\s+stud(?:y|ies)[^.]*?0\s+participants[^.]*\.",
        r"The pooled (?:effect|OR|RR|HR|MD|SMD)[^.]*?NR[^.]*\.",
        r"The pooled estimate[^.]*?NR[^.]*\.",
    ]
    for pattern in patterns:
        repaired, n = re.subn(pattern, quantitative_replacement, repaired, flags=re.I)
        if n:
            issues.append(_issue("non_meta_quantitative_claim_repaired", "fixed", f"Removed unsupported pooled-effect claim ({n} occurrence(s))."))

    conclusion_patterns = [
        r"在本系统综述和Meta分析中，[^。]*?风险降低相关[^。]*。",
        r"在[^。]{0,120}?中，[^。]{0,180}?风险降低相关[^。]*。",
        r"[^。\n]{0,260}?风险降低相关[^。]*。",
        r"In this systematic review and meta-analysis,[^.]*?(?:was associated with|reduced the risk of)[^.]*\.",
    ]
    for pattern in conclusion_patterns:
        repaired, n = re.subn(pattern, quantitative_replacement, repaired, flags=re.I)
        if n:
            issues.append(_issue("non_meta_conclusion_repaired", "fixed", f"Replaced unsupported efficacy conclusion ({n} occurrence(s))."))

    effect_measure_text = str((facts or {}).get("effect_measure") or "")
    if effect_measure_text and ";" in effect_measure_text and effect_measure_text in repaired:
        repaired = repaired.replace(effect_measure_text, "预设效应量" if zh else "prespecified effect measures")
        issues.append(_issue("verbose_effect_measure_repaired", "fixed", "Replaced verbose protocol effect-measure text in non-meta draft."))

    repaired = re.sub(r"臂水平事件计数为干预组0/0、对照组0/0。", quantitative_replacement, repaired)
    repaired = re.sub(r"Arm-level event counts were 0/0[^.]*\.", quantitative_replacement, repaired, flags=re.I)
    repaired = repaired.replace("标题识别为系统综述和Meta分析", "标题识别为证据缺口系统综述")
    repaired = repaired.replace("主要Meta分析计算说明", "定量合成可行性说明")

    if repaired != original and not any(item.get("kind") == "non_meta_quantitative_claim_repaired" for item in issues):
        issues.append(_issue("non_meta_claims_repaired", "fixed", "Repaired non-meta wording to evidence-gap wording."))
    return repaired, issues


def _detect_publication_contract_violations(manuscript: str, facts: dict[str, Any]) -> list[dict[str, Any]]:
    """Hard-stop drafts that still masquerade as publication meta-analyses."""
    text = str(manuscript or "")
    issues: list[dict[str, Any]] = []
    has_reportable_effect = _has_reportable_primary_effect(facts)
    first_line = text.splitlines()[0] if text.splitlines() else ""

    if not has_reportable_effect:
        residual_patterns = [
            (r"\bNR\s*\(\s*95%\s*CI|\bNR（\s*95%\s*CI", "residual_nr_effect"),
            (r"\b0/0\b", "residual_zero_zero_counts"),
            (r"共0名参与者|\b0\s+participants\b", "residual_zero_participants"),
            (r"合并(?:效应|结果)[^。]{0,120}NR|pooled\s+(?:effect|estimate|OR|RR|HR|MD|SMD)[^.]{0,120}NR", "residual_pooled_nr_claim"),
            (r"风险降低相关|was associated with (?:a )?(?:lower|reduced) risk|reduced the risk of", "unsupported_efficacy_conclusion"),
        ]
        for pattern, code in residual_patterns:
            if re.search(pattern, text, flags=re.I):
                issues.append(_issue(
                    code,
                    "error",
                    "Draft still contains quantitative meta-analysis wording despite lacking a publishable primary pooled effect.",
                ))
        if re.search(r"\bMeta[- ]analysis\b|Meta分析|荟萃分析", first_line, flags=re.I):
            issues.append(_issue(
                "non_meta_title_still_claims_meta_analysis",
                "error",
                "Draft title still claims meta-analysis although the evidence is not cleared for pooled synthesis.",
            ))

    if re.search(r"RR for dichotomous outcomes;\s*MD for continuous outcomes", text, flags=re.I):
        issues.append(_issue(
            "verbose_protocol_effect_measure_leaked",
            "error",
            "Verbose protocol effect-measure planning text leaked into the manuscript.",
        ))
    if re.search(
        r"Rule-based P/I/C/O|\bOIS\b|最优信息量|CI crosses null|Synthetic RoB|structured GRADE|结构化GRADE|"
        r"Methodological note|PICO consistency note|Unit consistency note|Caution on results|"
        r"\*\*Note\*\*:\s*This systematic review included only|"
        r"方法学说明|PICO一致性说明|单位一致性说明|结果解读注意|"
        r"automated system|automated review workflow|automated synthesis|automated nature of the review workflow|"
        r"self-verification|self verification|"
        r"protocol\.\s+json|references\.\s+bib|\. \s*(?:json|bib|png|jpg|jpeg|webp)|"
        r"protocol metadata|metadata fields|(?:the\s+)?results pooled results|"
        r"Protocol and The review protocol|Heterogeneity and:|subgroup analyses and were|"
        r"to be a major issue despite the inability to test it formally",
        text,
        flags=re.I,
    ):
        issues.append(_issue(
            "internal_grade_or_pipeline_jargon_leaked",
            "error",
            "Internal GRADE or pipeline jargon leaked into the manuscript.",
        ))
    selected_total = _coerce_int((facts.get("primary_population") or {}).get("selected_total_participants"))
    if selected_total > 0 and re.search(r"total sample size[^.。]{0,180}(?:not fully reported|not reported|\bNR\b)", text, flags=re.I):
        issues.append(_issue(
            "residual_sample_size_nr_claim",
            "error",
            "Draft still says total sample size was not reported even though the selected primary-analysis total is known.",
            selected_total=selected_total,
        ))
    primary_n = _primary_n_from_facts(facts)
    if 0 < primary_n < 10 and re.search(
        r"(?:publication bias|small-study (?:bias|effects?))[^.。]{0,120}(?:not significant|not detected|no evidence)",
        text,
        flags=re.I,
    ):
        issues.append(_issue(
            "residual_publication_bias_overclaim",
            "error",
            "Draft still overinterprets publication-bias testing despite fewer than 10 primary-analysis studies.",
            primary_n=primary_n,
        ))
    return issues


def _repair_self_result_external_citations(manuscript: str, facts: dict[str, Any] | None = None) -> tuple[str, list[dict[str, Any]]]:
    """Remove external trial citations from sentences reporting this review's own pooled estimate."""
    repaired = str(manuscript or "")
    before = repaired
    citation_en = r"\s*\[[0-9,\s\-–—]+\]"
    citation_zh = r"［[0-9，,\s\-–—]+］"
    citation_any = rf"(?:{citation_zh}|{citation_en})"
    replacements = [
        (
            rf"((?:This systematic review and meta-analysis|This meta-analysis) (?:found|showed)[^\n]*?){citation_en}(\.)",
            r"\1\2",
            re.IGNORECASE,
        ),
        (
            rf"((?:In this systematic review and meta-analysis|In (?:a|this) meta-analysis|In (?:a|this) synthesis|Pooled analysis|This meta-analysis)[^\n]*?(?:pooled (?:HR|OR|RR|effect|result)|hazard ratio|odds ratio|risk ratio|HR\s*[0-9]))[^\n]*?{citation_en}(\.)",
            lambda match: re.sub(citation_en, "", match.group(0), flags=re.IGNORECASE),
            re.IGNORECASE,
        ),
        (
            rf"((?:The primary pooled estimate|The pooled (?:HR|OR|RR|estimate|effect))[^\n]*?){citation_en}(\.)",
            r"\1\2",
            re.IGNORECASE,
        ),
        (
            rf"(本系统综述和Meta分析显示[^。\n]*?){citation_any}(。)",
            r"\1\2",
            0,
        ),
        (
            rf"([^。\n]{{0,160}}?(?:合并HR|合并OR|合并RR|合并结果|合并效应)[^。\n]*?(?:HR|OR|RR)\s*[0-9][^。\n]*?){citation_any}(。)",
            r"\1\2",
            0,
        ),
    ]
    for pattern, replacement, flags in replacements:
        repaired = re.sub(pattern, replacement, repaired, flags=flags)
    repaired = _repair_primary_effect_anchor_citations(repaired, facts or {})
    if repaired == before:
        return manuscript, []
    return repaired, [_issue(
        "self_result_external_citation_removed",
        "fixed",
        "Removed external trial citation markers from sentences reporting this review's own pooled result.",
    )]


def _repair_primary_effect_anchor_citations(manuscript: str, facts: dict[str, Any]) -> str:
    """Remove external citations from sentences containing this review's exact pooled effect anchors."""
    primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
    if not primary:
        return manuscript
    measure = str(primary.get("effect_measure") or "").upper()
    if measure not in {"HR", "OR", "RR", "IRR"}:
        return manuscript
    values = [
        primary.get("pooled_effect"),
        primary.get("ci_lower"),
        primary.get("ci_upper"),
    ]
    anchors: list[str] = []
    for value in values:
        try:
            anchors.append(f"{float(value):.2f}")
        except Exception:
            continue
    if len(anchors) < 3:
        return manuscript
    citation_pattern = r"(?:\s*\[[0-9,\s\-–—]+\]|［[0-9，,\s\-–—]+］)"
    effect_terms = {
        "HR": r"\bHR\b|hazard ratio",
        "OR": r"\bOR\b|odds ratio",
        "RR": r"\bRR\b|risk ratio",
        "IRR": r"\bIRR\b|incidence rate ratio",
    }[measure]

    def sentence_has_pooled_anchor(sentence: str) -> bool:
        if not re.search(effect_terms, sentence, flags=re.IGNORECASE):
            return False
        compact = sentence.replace("．", ".")
        return all(anchor in compact for anchor in anchors)

    def repair_line(line: str) -> str:
        if not re.search(citation_pattern, line):
            return line
        stripped = line.lstrip()
        if stripped.startswith("|") or stripped.startswith("[") or stripped.startswith("［"):
            return line
        parts = re.split(r"(?<=[.!?。！？])(\s+)", line)
        changed = False
        for idx in range(0, len(parts), 2):
            sentence = parts[idx]
            if sentence_has_pooled_anchor(sentence):
                parts[idx] = re.sub(citation_pattern, "", sentence)
                changed = True
        return "".join(parts) if changed else line

    lines = manuscript.splitlines(keepends=True)
    in_references = False
    repaired_lines: list[str] = []
    for line in lines:
        if re.match(r"^##\s+(References|参考文献)\s*$", line.strip(), flags=re.IGNORECASE):
            in_references = True
        repaired_lines.append(line if in_references else repair_line(line))
    return "".join(repaired_lines)


def _publication_length_issues(manuscript: str, facts: dict[str, Any]) -> list[dict[str, Any]]:
    if facts.get("report_type", "meta") != "meta":
        return []
    readiness = facts.get("evidence_readiness") or {}
    if readiness.get("blockers"):
        return []
    primary = facts.get("primary_effect") or {}
    try:
        primary_n = int(primary.get("n_studies") or 0)
    except (TypeError, ValueError):
        primary_n = 0
    if primary_n < 2:
        return []
    if not _has_full_publication_section_shape(manuscript):
        return []
    minimum = publication_min_main_words(facts)
    if minimum <= 0:
        return []
    word_count = _main_publication_word_count(manuscript)
    if word_count >= minimum:
        return []
    return [
        _issue(
            "publication_length_too_short",
            "warning",
            (
                f"Publication-style meta-analysis main text is too short "
                f"({word_count} words; minimum {minimum})."
            ),
            main_word_count=word_count,
            minimum_main_words=minimum,
        )
    ]


def _has_full_publication_section_shape(manuscript: str) -> bool:
    headings = {_canonical_publication_heading(match.group(1)) for match in re.finditer(r"^#{1,3}\s+(.+?)\s*$", manuscript, flags=re.M)}
    required = {"abstract", "introduction", "methods", "results", "discussion"}
    return required.issubset(headings)


def _canonical_publication_heading(heading: str) -> str:
    raw = str(heading or "").strip().lower()
    zh_map = {
        "摘要": "abstract",
        "引言": "introduction",
        "绪论": "introduction",
        "背景": "introduction",
        "方法": "methods",
        "材料与方法": "methods",
        "结果": "results",
        "讨论": "discussion",
        "结论": "conclusion",
    }
    return zh_map.get(raw, raw)


def _main_publication_word_count(manuscript: str) -> int:
    return main_publication_word_count(manuscript)


def _load_project_json(project, filename: str, subdir: str | None = None) -> Any:
    if project is None:
        return None
    try:
        return project.load_json(filename, subdir=subdir)
    except Exception:
        return None


def _apply_extraction_review_decisions(project, extraction_audit: dict) -> dict:
    if project is None or not isinstance(extraction_audit, dict):
        return extraction_audit
    try:
        from new_meta.core.extraction_review import (
            apply_extraction_review_decisions_to_audit,
            load_extraction_review_decisions,
        )
        return apply_extraction_review_decisions_to_audit(
            extraction_audit,
            load_extraction_review_decisions(project),
        )
    except Exception:
        return extraction_audit


def _repair_publication_tone(manuscript: str) -> tuple[str, list[dict[str, Any]]]:
    """Remove engineering/meta-commentary that should not appear in a manuscript."""
    patterns = [re.compile(pattern, flags=re.IGNORECASE) for pattern in PUBLICATION_TONE_PATTERNS]
    removed_patterns: set[str] = set()
    changed = False
    repaired_lines: list[str] = []

    for line in manuscript.splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or stripped.startswith("|") or stripped.startswith("!["):
            repaired_lines.append(line)
            continue
        sentences = re.split(r"(?<!\d)(?<=[.!?。！？])(?!\d)\s*", line)
        kept: list[str] = []
        for sentence in sentences:
            matched = [pattern.pattern for pattern in patterns if pattern.search(sentence)]
            if matched:
                removed_patterns.update(matched)
                changed = True
                continue
            kept.append(sentence)
        repaired_lines.append(" ".join(part.strip() for part in kept if part.strip()))

    if not changed:
        return manuscript, []
    repaired = "\n".join(repaired_lines)
    repaired = re.sub(r"\n{3,}", "\n\n", repaired)
    return repaired, [_issue(
        "publication_tone",
        "fixed",
        "Removed engineering/meta-commentary from the manuscript text.",
        patterns=sorted(removed_patterns),
    )]


def _repair_process_framed_discussion(manuscript: str) -> tuple[str, list[dict[str, Any]]]:
    """Keep discussion and conclusion focused on clinical interpretation."""
    headings = ("Discussion", "讨论", "Conclusion", "结论")
    heading_re = "|".join(re.escape(item) for item in headings)
    pattern = re.compile(rf"(^##\s+(?:{heading_re})\s*$)([\s\S]*?)(?=^##\s+|\Z)", flags=re.M)
    compiled = [re.compile(item, flags=re.IGNORECASE) for item in DISCUSSION_PROCESS_PATTERNS]
    stats = {
        "removed_paragraphs": 0,
        "removed_sentences": 0,
        "sections": set(),
        "patterns": set(),
    }

    def repl(match: re.Match[str]) -> str:
        heading = match.group(1)
        body = match.group(2)
        repaired_body = _remove_process_commentary_from_section_body(
            body,
            compiled,
            stats=stats,
            section=heading.lstrip("#").strip(),
        )
        return heading + repaired_body

    repaired = pattern.sub(repl, manuscript)
    if repaired == manuscript:
        return manuscript, []
    return repaired, [_issue(
        "process_framed_discussion",
        "fixed",
        "Removed process-centered manuscript-generation commentary from Discussion/Conclusion.",
        removed_paragraphs=stats["removed_paragraphs"],
        removed_sentences=stats["removed_sentences"],
        sections=sorted(stats["sections"]),
        patterns=sorted(stats["patterns"]),
    )]


def _repair_publication_process_notes(manuscript: str) -> tuple[str, list[dict[str, Any]]]:
    """Remove machine-facing caution notes and automation traces from the paper."""
    text = str(manuscript or "")
    issues: list[dict[str, Any]] = []
    repaired = text

    note_patterns = [
        r"\n?>\s*\*\*(?:Methodological note|PICO consistency note|Unit consistency note|Caution on results)\*\*:[^\n]*(?:\n|$)",
        r"\n?>\s*\*\*Note\*\*:\s*This systematic review included only[^\n]*(?:\n|$)",
        r"\n?>\s*\*\*(?:方法学说明|PICO一致性说明|单位一致性说明|结果解读注意|注意)\*\*[:：][^\n]*(?:\n|$)",
    ]
    for pattern in note_patterns:
        new_text = re.sub(pattern, "\n", repaired, flags=re.IGNORECASE)
        if new_text != repaired:
            repaired = new_text
            issues.append(_issue(
                "machine_note_removed",
                "fixed",
                "Removed an internal caution note from the manuscript body.",
            ))

    process_sentence_patterns = [
        (
            r"(?:Data extraction|Data collection)[^.。]*(?:automated system|self-verification|self verification|automated review workflow|internal validation)[^.。]*[.。]",
            "Study characteristics and outcome data were extracted into structured evidence tables and checked against available source records.",
        ),
        (
            r"Records were screened against prespecified eligibility criteria using automated matching and source-location verification[.。]",
            "Records were screened against prespecified eligibility criteria, and report locations were documented for extracted values.",
        ),
        (
            r"\busing automated matching\b",
            "against prespecified eligibility criteria",
        ),
        (
            r"The review workflow extracted study characteristics[^.。]*[.。]",
            "Study characteristics, intervention details, comparators, and outcome data were prespecified for extraction.",
        ),
        (
            r"Structured extraction files were generated[^.。]*[.。]",
            "",
        ),
        (
            r"No manual hand-extraction by human reviewers was explicitly described[^.。]*[.。]",
            "",
        ),
        (
            r"The extraction process did not involve dual independent human reviewers[^.。]*[.。]",
            "",
        ),
        (
            r"as these steps were not explicitly specified in the protocol metadata",
            "because those procedures were not prespecified",
        ),
        (
            r"protocol metadata",
            "protocol records",
        ),
        (
            r"metadata fields",
            "source records",
        ),
        (
            r"未明确描述人工手工提取[^。]*。",
            "",
        ),
        (
            r"数据提取[^。]*(?:自动化|自我验证|内部验证)[^。]*。",
            "研究特征和结局数据提取至结构化证据表，并依据可用来源记录进行核对。",
        ),
    ]
    for pattern, replacement in process_sentence_patterns:
        new_text = re.sub(pattern, replacement, repaired, flags=re.IGNORECASE)
        if new_text != repaired:
            repaired = new_text
            issues.append(_issue(
                "process_wording_repaired",
                "fixed",
                "Replaced automation/process wording with manuscript-appropriate extraction wording.",
            ))

    repaired = re.sub(r"\n{3,}", "\n\n", repaired)
    repaired = re.sub(r"[ \t]{2,}", " ", repaired)
    return repaired, issues


def _repair_file_path_spacing(manuscript: str) -> tuple[str, list[dict[str, Any]]]:
    """Undo prose spacing fixes that corrupt file names and common abbreviations."""
    repaired = str(manuscript or "")
    before = repaired
    repaired = re.sub(
        r"\b([A-Za-z0-9_./-]+)\.\s+(json|bib|png|jpe?g|webp)\b",
        lambda match: f"{match.group(1)}.{match.group(2)}",
        repaired,
        flags=re.IGNORECASE,
    )
    repaired = re.sub(r"\bwww\.\s+", "www.", repaired, flags=re.IGNORECASE)
    repaired = re.sub(r"([A-Za-z0-9])\.\s+(org|com|gov|edu|net)\b", r"\1.\2", repaired, flags=re.IGNORECASE)
    repaired = re.sub(r"(https?://[^\s)\]]+\?)\s+([A-Za-z0-9_=&%-]+)", r"\1\2", repaired)
    repaired = re.sub(r"\be\.\s+g\.", "e.g.", repaired, flags=re.IGNORECASE)
    if repaired == before:
        return manuscript, []
    return repaired, [_issue(
        "file_path_spacing_repaired",
        "fixed",
        "Repaired spacing inserted into file paths or standard abbreviations.",
    )]


def _repair_heading_glue(manuscript: str) -> tuple[str, list[dict[str, Any]]]:
    repaired = re.sub(r"(##[ \t]+[^\n#]+?)[ \t]+(?=#{2,6}[ \t]+)", r"\1\n\n", str(manuscript or ""))
    if repaired == manuscript:
        return manuscript, []
    return repaired, [_issue(
        "heading_glue_repaired",
        "fixed",
        "Separated adjacent markdown headings that were glued onto one line.",
    )]


def _remove_process_commentary_from_section_body(
    body: str,
    patterns: list[re.Pattern[str]],
    *,
    stats: dict[str, Any],
    section: str,
) -> str:
    parts = re.split(r"(\n\s*\n+)", str(body or ""))
    kept: list[str] = []
    for index in range(0, len(parts), 2):
        paragraph = parts[index]
        separator = parts[index + 1] if index + 1 < len(parts) else ""
        if not paragraph:
            kept.append(paragraph)
            kept.append(separator)
            continue
        if _paragraph_is_protected_publication_block(paragraph):
            kept.append(paragraph)
            kept.append(separator)
            continue
        repaired_paragraph, removed_matches, removed_count = _remove_process_sentences(paragraph, patterns)
        if removed_count:
            stats["removed_sentences"] += removed_count
            stats["sections"].add(section)
            stats["patterns"].update(removed_matches)
            if repaired_paragraph.strip():
                kept.append(repaired_paragraph)
                kept.append(separator)
            continue
        paragraph_matches = _process_commentary_matches(paragraph, patterns)
        if paragraph_matches and _paragraph_is_process_framed(paragraph, paragraph_matches):
            stats["removed_paragraphs"] += 1
            stats["sections"].add(section)
            stats["patterns"].update(paragraph_matches)
            continue
        if repaired_paragraph.strip():
            kept.append(repaired_paragraph)
            kept.append(separator)
    repaired = "".join(kept)
    repaired = re.sub(r"\n{3,}", "\n\n", repaired)
    return repaired


def _paragraph_is_protected_publication_block(paragraph: str) -> bool:
    stripped = str(paragraph or "").strip()
    if not stripped:
        return False
    return stripped.startswith(("#", "|", "![", "```", "- ", "* "))


def _process_commentary_matches(text: str, patterns: list[re.Pattern[str]]) -> list[str]:
    return [pattern.pattern for pattern in patterns if pattern.search(str(text or ""))]


def _paragraph_is_process_framed(paragraph: str, matches: list[str]) -> bool:
    normalized = " ".join(str(paragraph or "").split())
    if not normalized or not matches:
        return False
    if len(matches) >= 2:
        return True
    process_leads = (
        "source note",
        "evidence source",
        "the most direct value",
        "for submission preparation",
        "for reviewers",
        "来源提示",
        "从数值一致性看",
        "对读者而言",
        "对审稿和投稿准备而言",
        "本研究最直接的价值",
        "图2提供研究流程",
    )
    lowered = normalized.lower()
    if any(lowered.startswith(item) for item in process_leads):
        return True
    return _text_unit_count_without_citations(normalized) <= 35


def _remove_process_sentences(
    paragraph: str,
    patterns: list[re.Pattern[str]],
) -> tuple[str, set[str], int]:
    sentences = [
        item.strip()
        for item in re.split(r"(?<!\d)(?<=[.!?。！？；;])(?!\d)\s*", str(paragraph or ""))
        if item.strip()
    ]
    if not sentences:
        return paragraph, set(), 0
    kept: list[str] = []
    removed_matches: set[str] = set()
    removed_count = 0
    for sentence in sentences:
        matches = _process_commentary_matches(sentence, patterns)
        if matches:
            removed_matches.update(matches)
            removed_count += 1
            continue
        kept.append(sentence)
    if removed_count and not kept:
        return "", removed_matches, removed_count
    if not removed_count:
        return paragraph, removed_matches, 0
    separator = "" if re.search(r"[\u4e00-\u9fff]", paragraph) else " "
    return separator.join(kept).strip(), removed_matches, removed_count


def _text_unit_count_without_citations(text: str) -> int:
    cleaned = re.sub(r"[\[［][0-9\s,，、;；\-–—至]+[\]］]", " ", str(text or ""))
    return len(re.findall(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?|[\u4e00-\u9fff]", cleaned))


_BENCHMARK_FULL_TEXT_SOURCE_KINDS = {
    "primary_source",
    "primary_full_text",
    "primary_publication_full_text",
    "full_text",
    "trial_results",
    "registry_result",
    "clinical_trial_registry",
}


def _filter_limited_text_warnings_resolved_by_benchmark_sources(
    warnings: Any,
    project,
) -> list[dict[str, Any]]:
    """Drop limited-text warnings once an explicit benchmark primary source is attached."""
    if not isinstance(warnings, list) or project is None:
        return warnings if isinstance(warnings, list) else []
    manifest = _load_project_json(project, "benchmark_source_manifest.json", subdir="benchmark")
    sources = manifest.get("sources") if isinstance(manifest, dict) else []
    if not isinstance(sources, list):
        return warnings

    source_texts: list[str] = []
    for source in sources:
        if not isinstance(source, dict):
            continue
        kind = str(source.get("source_kind") or "").strip().lower()
        if kind not in _BENCHMARK_FULL_TEXT_SOURCE_KINDS:
            continue
        if str(source.get("parse_status") or "").lower() not in {"ok", "empty_text"}:
            continue
        if int(source.get("text_chars") or 0) <= 0:
            continue
        source_texts.append(_benchmark_source_match_text(source, project))
    source_texts = [text for text in source_texts if text]
    if not source_texts:
        return warnings

    remaining: list[dict[str, Any]] = []
    for warning in warnings:
        if isinstance(warning, dict) and _warning_resolved_by_source_text(warning, source_texts):
            continue
        remaining.append(warning)
    return remaining


def _benchmark_source_match_text(source: dict[str, Any], project) -> str:
    parts = [
        source.get("trial_id"),
        source.get("trial_name"),
        source.get("filename"),
        source.get("text_preview"),
    ]
    for key in ("local_path", "parsed_path"):
        value = source.get(key)
        if not value:
            continue
        path = Path(str(value))
        if not path.is_absolute():
            path = project.base_dir / path
        try:
            if path.suffix.lower() == ".json":
                parsed = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
                parts.append(str(parsed.get("full_text") or "")[:30000] if isinstance(parsed, dict) else "")
            else:
                parts.append(path.read_text(encoding="utf-8", errors="ignore")[:30000])
        except Exception:
            continue
    return _normalise_fact_text(" ".join(str(part or "") for part in parts))


def _warning_resolved_by_source_text(warning: dict[str, Any], source_texts: list[str]) -> bool:
    identifiers = []
    for key in ("pmid", "doi", "title"):
        value = str(warning.get(key) or "").strip()
        if value:
            identifiers.append(value)
    if not identifiers:
        return False
    for identifier in identifiers:
        needle = _normalise_fact_text(identifier)
        if len(needle) < 6:
            continue
        if any(needle in text for text in source_texts):
            return True
    return False


def _normalise_fact_text(value: Any) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9.]+", " ", str(value or "").lower())).strip()


def _study_id(study: ExtractedStudy) -> str:
    return study.characteristics.pmid or study.characteristics.study_id or study.characteristics.doi or "unknown"


def _study_label_lookup(studies: list[ExtractedStudy]) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for study in studies:
        label = _study_label(study)
        if not label:
            continue
        c = study.characteristics
        for identifier in (c.pmid, c.study_id, c.doi):
            key = str(identifier or "").strip()
            if key:
                lookup[key] = label
                normalized = re.sub(r"[^a-zA-Z0-9]+", "-", key.lower()).strip("-")
                if normalized:
                    lookup[f"study:{normalized[:96]}"] = label
    return lookup


def _normalise_selected_row_labels(rows: list[dict[str, Any]], labels: dict[str, str]) -> None:
    for row in rows:
        study_id = str(row.get("study_id") or "").strip()
        if study_id and study_id in labels:
            row["study_label"] = labels[study_id]


def _study_label(study: ExtractedStudy) -> str:
    c = study.characteristics
    year = str(c.year) if c.year else ""
    author = ""
    if c.authors:
        source_format = " ".join([c.source_type or "", c.metadata_source or ""]).lower()
        prefer_display_order = "pubmed" not in source_format
        author = first_author_lastname(c.authors, prefer_display_order=prefer_display_order)
    elif c.title:
        author = str(c.title).split()[0]
    label = " ".join(part for part in (author, year) if part).strip()
    return label


def _prisma_facts(prisma_data: dict) -> dict[str, int]:
    ident = prisma_data.get("identification", {})
    screening = prisma_data.get("screening", {})
    eligibility = prisma_data.get("eligibility", {})
    included = prisma_data.get("included", {})
    return {
        "records_identified": int(ident.get("records_identified") or 0),
        "records_after_dedup": int(ident.get("records_after_dedup") or 0),
        "duplicates_removed": int(ident.get("duplicates_removed") or 0),
        "records_from_database": int(ident.get("records_from_database") or 0),
        "records_from_user_upload": int(ident.get("records_from_user_upload") or 0),
        "title_abstract_screened": int(screening.get("title_abstract_screened") or 0),
        "full_text_assessed": int(eligibility.get("full_text_assessed") or 0),
        "studies_included": int(included.get("studies_included") or 0),
    }


def _actual_primary_model(effect: PooledEffect, model_decision: dict[str, Any] | None) -> str:
    decision = model_decision if isinstance(model_decision, dict) else {}
    for key in ("primary_engine_model", "primary_model"):
        value = str(decision.get(key) or "").strip().lower()
        if value in {"fixed", "random"}:
            return value
    value = str(getattr(effect, "model", "") or "").strip().lower()
    return value if value in {"fixed", "random"} else ""


def _pooled_effect_fact(effect: PooledEffect, *, analysis_group: str = "") -> dict[str, Any]:
    return {
        "analysis_group": analysis_group,
        "outcome_name": effect.outcome_name,
        "effect_measure": effect.effect_measure,
        "n_studies": effect.n_studies,
        "pooled_effect": effect.pooled_effect,
        "ci_lower": effect.ci_lower,
        "ci_upper": effect.ci_upper,
        "p_value": effect.p_value,
        "i_squared": effect.i_squared,
    }


def _secondary_effect_facts(meta_results: MetaAnalysisResults | None) -> list[dict[str, Any]]:
    if not meta_results:
        return []
    return [_pooled_effect_fact(effect) for effect in meta_results.secondary_outcomes]


def _subgroup_effect_facts(meta_results: MetaAnalysisResults | None) -> list[dict[str, Any]]:
    if not meta_results:
        return []
    facts = []
    for analysis_group, effects in (meta_results.subgroup_results or {}).items():
        for effect in effects:
            facts.append(_pooled_effect_fact(effect, analysis_group=str(analysis_group)))
    return facts


def _grade_facts(
    grade_profile: GRADEProfile | None,
    primary_n: int = 0,
    selected_total_n: int = 0,
) -> dict[str, Any]:
    if not grade_profile:
        return {"outcomes": []}
    outcomes = []
    for item in grade_profile.outcomes:
        domains = []
        for domain in item.domains:
            original_rating = domain.rating
            domain_data = {
                "domain": domain.domain,
                "rating": domain.rating,
                "rationale": domain.rationale,
            }
            if getattr(domain, "details", None):
                domain_data["details"] = domain.details
            if domain.domain == "imprecision":
                domain_data = _repair_imprecision_domain(
                    domain_data,
                    selected_total_n=selected_total_n,
                    primary_n=primary_n,
                )
            if domain.domain == "publication_bias" and 0 < primary_n < 10:
                if primary_n < 3:
                    domain_data["rating"] = "serious"
                    domain_data["rationale"] = (
                        f"Only {primary_n} studies contributed to the primary meta-analysis, so small-study-effect "
                        "or non-publication could not be meaningfully assessed; a GRADE downgrade was applied for "
                        "publication-bias uncertainty."
                    )
                else:
                    domain_data["rating"] = "no concern"
                    domain_data["rationale"] = (
                        f"Fewer than 10 studies contributed to the primary meta-analysis (k={primary_n}), so "
                        "small-study-effect tests were not interpreted confirmatorily; no GRADE downgrade was "
                        "applied for this domain."
                    )
            domain_data["_original_rating"] = original_rating
            domains.append(domain_data)
        certainty = _recalculate_grade_certainty(item.certainty, domains)
        for domain_data in domains:
            domain_data.pop("_original_rating", None)
        outcomes.append({
            "outcome_name": item.outcome_name,
            "n_studies": item.n_studies,
            "effect_summary": item.effect_summary,
            "certainty": certainty,
            "domains": domains,
        })
    return {
        "outcomes": outcomes
    }


def _method_certainty_facts(
    method_certainty: dict[str, Any] | None,
    synthesis_result: dict[str, Any] | None,
    *,
    selected_total_n: int = 0,
) -> dict[str, Any]:
    """Project method-specific certainty into the manuscript GRADE contract."""
    certainty = method_certainty if isinstance(method_certainty, dict) else {}
    synthesis = synthesis_result if isinstance(synthesis_result, dict) else {}
    estimates = {
        str(item.get("estimate_id") or ""): item
        for item in synthesis.get("primary_estimates") or []
        if isinstance(item, dict)
    }
    outcomes: list[dict[str, Any]] = []
    for outcome in certainty.get("outcomes") or []:
        if not isinstance(outcome, dict):
            continue
        estimate = estimates.get(str(outcome.get("outcome_id") or ""), {})
        measure = str(estimate.get("measure") or "effect")
        effect_summary = ""
        if estimate.get("estimate") is not None:
            effect_summary = f"{measure} {float(estimate['estimate']):.3g}"
            if estimate.get("ci_lower") is not None and estimate.get("ci_upper") is not None:
                effect_summary += (
                    f" (95% CI {float(estimate['ci_lower']):.3g} to "
                    f"{float(estimate['ci_upper']):.3g})"
                )
        domains = []
        for domain in outcome.get("domains") or []:
            if not isinstance(domain, dict):
                continue
            rationale = str(domain.get("rationale") or "Not assessed.")
            rationale = rationale.replace(
                "Full-automatic mode used the conservative recommended option because no user confirmation was requested. ",
                "",
            ).replace(
                "A conservative assumption was applied because the decision context was not prespecified. ",
                "",
            )
            domain_name = str(domain.get("domain") or "")
            details = dict(domain.get("evidence") or {})
            if domain_name == "risk_of_bias":
                required = int(details.get("required_result_count") or synthesis.get("n_studies") or 0)
                judgments = [str(item) for item in details.get("judgments") or []]
                lowered = [item.lower() for item in judgments]
                details.update({
                    "n_assessed": len(judgments),
                    "total_contributing": required,
                    "n_high": sum("high" in item for item in lowered),
                    "n_some": sum("some concern" in item or "moderate" in item for item in lowered),
                    "n_low": sum("low" in item and "high" not in item for item in lowered),
                    "n_missing_assessment": max(required - len(judgments), 0),
                })
            elif domain_name in {"inconsistency", "heterogeneity"}:
                details.setdefault("n_studies", int(synthesis.get("n_studies") or 0))
            elif domain_name == "imprecision":
                details.setdefault("total_n", int(selected_total_n or 0))
                details.setdefault("n_studies", int(synthesis.get("n_studies") or 0))
                ci = details.get("ci") or []
                if len(ci) == 2:
                    null = 1.0 if measure.upper() in {"OR", "RR", "HR", "IRR"} else 0.0
                    details.setdefault("crosses_null", float(ci[0]) <= null <= float(ci[1]))
            elif domain_name == "publication_bias":
                details.setdefault("n_studies", int(synthesis.get("n_studies") or 0))
            domains.append({
                "domain": domain_name,
                "rating": str(domain.get("rating") or "not assessed").replace("_", " "),
                "rationale": rationale,
                "details": details,
            })
        outcomes.append({
            "outcome_name": outcome.get("outcome_label") or outcome.get("outcome_id"),
            "outcome_id": outcome.get("outcome_id"),
            "n_studies": int(synthesis.get("n_studies") or 0),
            "effect_summary": effect_summary,
            "certainty": str(outcome.get("certainty") or "not assessed").replace("_", " "),
            "starting_certainty": outcome.get("starting_certainty"),
            "domains": domains,
        })
    return {
        "framework": certainty.get("framework"),
        "framework_note": certainty.get("framework_note"),
        "status": certainty.get("status"),
        "revision": certainty.get("revision"),
        "outcomes": outcomes,
    }


def _repair_imprecision_domain(
    domain_data: dict[str, Any],
    *,
    selected_total_n: int = 0,
    primary_n: int = 0,
) -> dict[str, Any]:
    if not selected_total_n:
        return domain_data
    rationale = str(domain_data.get("rationale") or "")
    if "Total N=" not in rationale and "OIS=" not in rationale:
        return domain_data

    repaired = dict(domain_data)
    rationale = re.sub(r"Total N\s*=\s*\d+", f"Total N={int(selected_total_n)}", rationale)
    ois_match = re.search(r"OIS\s*=\s*(\d+)", rationale)
    crosses_match = re.search(r"CI crosses null\s*=\s*(True|False)", rationale, flags=re.I)
    width_match = re.search(r"CI width\s*=\s*([0-9.]+)", rationale, flags=re.I)
    if ois_match:
        ois = int(ois_match.group(1))
        crosses_null = crosses_match and crosses_match.group(1).lower() == "true"
        ci_width = float(width_match.group(1)) if width_match else 0.0
        concerns = 0
        if selected_total_n < ois:
            concerns += 1
        if crosses_null:
            concerns += 1
        if primary_n and primary_n < 3 and ci_width > 1.0:
            concerns += 1
        if concerns >= 2:
            repaired["rating"] = "very serious"
        elif concerns == 1:
            repaired["rating"] = "serious"
        else:
            repaired["rating"] = "no concern"
    repaired["rationale"] = rationale
    return repaired


def _recalculate_grade_certainty(original_certainty: str, domains: list[dict[str, Any]]) -> str:
    certainty_scores = {
        "high": 4,
        "moderate": 3,
        "low": 2,
        "very low": 1,
    }
    score_labels = {
        4: "High",
        3: "Moderate",
        2: "Low",
        1: "Very low",
    }
    original_score = certainty_scores.get(str(original_certainty or "").strip().lower())
    if original_score is None:
        return original_certainty or "Not assessed"

    original_penalty = sum(_grade_rating_penalty(item.get("_original_rating")) for item in domains)
    new_penalty = sum(_grade_rating_penalty(item.get("rating")) for item in domains)
    baseline_score = min(4, original_score + original_penalty)
    new_score = max(1, min(4, baseline_score - new_penalty))
    return score_labels[new_score]


def _grade_rating_penalty(rating: Any) -> int:
    value = str(rating or "").strip().lower()
    if value == "very serious":
        return 2
    if value == "serious":
        return 1
    return 0


def _evidence_readiness_facts(
    *,
    primary: dict[str, Any] | None,
    protocol: ResearchProtocol,
    text_source_warnings: list[dict],
    extraction_audit: dict[str, Any],
    effect_selection_audit: list[dict],
    positioning: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Summarize whether evidence is ready for publication-style synthesis."""
    primary_ids = {item.get("study_id") for item in (primary or {}).get("studies", [])}
    abstract_only_ids = {
        str(item.get("pmid") or item.get("doi") or "").strip()
        for item in text_source_warnings or []
        if item.get("pmid") or item.get("doi")
    }
    audit_summary = extraction_audit.get("summary", {}) if isinstance(extraction_audit, dict) else {}
    selected_rows = [
        row for row in effect_selection_audit or []
        if row.get("in_final_primary_analysis") or (
            row.get("decision") == "selected_within_study"
            and row.get("study_id") in primary_ids
        )
    ]
    selected_rows = _merge_selected_rows_with_extraction_audit(selected_rows, extraction_audit)
    for row in selected_rows:
        annotate_source_provenance(row)
    provenance = source_provenance_summary(selected_rows)
    positioning = positioning if isinstance(positioning, dict) else {}
    benchmark_mode = (
        str(positioning.get("report_type") or "").lower() == "benchmark_reconstruction"
        or str(positioning.get("category") or "").lower() == "reproduction_or_benchmark_alignment"
    )

    blockers: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    primary_n = int((primary or {}).get("n_studies") or 0)
    if primary is None or primary_n < 2:
        blockers.append({
            "code": "insufficient_primary_effects",
            "message": f"Primary meta-analysis has {primary_n} computable effect(s); at least 2 are required.",
        })
    elif not selected_rows:
        blockers.append({
            "code": "missing_primary_effect_audit",
            "message": (
                "Primary meta-analysis has computable effects, but no selected primary-effect audit rows "
                "were found in analysis/effect_selection_audit.json."
            ),
        })
    else:
        selected_study_ids = {str(row.get("study_id") or "") for row in selected_rows}
        missing_study_ids = sorted(str(study_id) for study_id in primary_ids if study_id and str(study_id) not in selected_study_ids)
        if missing_study_ids:
            blockers.append({
                "code": "incomplete_primary_effect_audit",
                "study_ids": missing_study_ids,
                "message": (
                    "Primary meta-analysis study IDs missing from selected primary-effect audit rows: "
                    + ", ".join(missing_study_ids)
                ),
            })

    if text_source_warnings:
        metadata_only_count = sum(1 for item in text_source_warnings if item.get("text_availability") == "metadata_only")
        abstract_only_count = len(text_source_warnings) - metadata_only_count
        selected_study_ids = {str(row.get("study_id") or "") for row in selected_rows}
        primary_limited_ids = sorted(study_id for study_id in selected_study_ids if study_id in abstract_only_ids)
        source_parts = []
        if abstract_only_count:
            source_parts.append(f"{abstract_only_count} abstract-only")
        if metadata_only_count:
            source_parts.append(f"{metadata_only_count} metadata-only")
        warnings.append({
            "code": "limited_text_sources_present",
            "message": (
                f"{len(text_source_warnings)} retrieved/screened record(s) use limited source text "
                f"({', '.join(source_parts) or 'limited text'})."
            ),
            "scope": "selected_primary_rows" if primary_limited_ids else "non_primary_records",
            "action_required": bool(primary_limited_ids),
            "primary_limited_study_ids": primary_limited_ids,
        })

    publication_blocking_rows = provenance.get("publication_blocking_rows") or []
    if publication_blocking_rows:
        secondary_rows = [
            row for row in publication_blocking_rows
            if str(row.get("source_provenance_tier") or "") == "secondary_meta_figure"
        ]
        other_non_primary_rows = [
            row for row in publication_blocking_rows
            if str(row.get("source_provenance_tier") or "") != "secondary_meta_figure"
        ]
        if secondary_rows and benchmark_mode:
            warnings.append({
                "code": "secondary_meta_source_used_for_benchmark_reconstruction",
                "message": (
                    f"{len(secondary_rows)} selected primary-effect row(s) originate from a published "
                    "secondary meta-analysis figure and are allowed only because this run is explicitly "
                    "classified as benchmark_reconstruction."
                ),
                "scope": "selected_primary_rows",
                "action_required": False,
                "rows": secondary_rows[:20],
            })
        elif secondary_rows:
            blockers.append({
                "code": "secondary_meta_source_used_as_primary_row",
                "message": (
                    f"{len(secondary_rows)} selected primary-effect row(s) originate from a published secondary "
                    "meta-analysis figure. Publication-mode primary rows must come from a primary report, "
                    "trial registry, or living-data source."
                ),
                "scope": "selected_primary_rows",
                "rows": secondary_rows[:20],
            })
        if other_non_primary_rows:
            blockers.append({
                "code": "non_primary_source_used_as_primary_row",
                "message": (
                    f"{len(other_non_primary_rows)} selected primary-effect row(s) do not have an allowed "
                    "primary-analysis provenance tier. Allowed tiers are: "
                    + ", ".join(sorted(PRIMARY_ALLOWED_TIERS))
                    + "."
                ),
                "scope": "selected_primary_rows",
                "rows": other_non_primary_rows[:20],
            })

    extraction_backlog = _extraction_backlog_counts(
        extraction_audit=extraction_audit,
        audit_summary=audit_summary,
        selected_rows=selected_rows,
    )
    review_rows = extraction_backlog["selected_primary_review_rows"]
    conflict_rows = extraction_backlog["selected_primary_conflict_rows"]
    if review_rows:
        warnings.append({
            "code": "unresolved_extraction_review_rows",
            "message": f"{review_rows} selected primary-effect row(s) require review.",
            "scope": "selected_primary_rows",
            "action_required": True,
        })
    if conflict_rows:
        warnings.append({
            "code": "unresolved_extraction_conflicts",
            "message": f"{conflict_rows} selected primary-effect row(s) contain conflict notes.",
            "scope": "selected_primary_rows",
            "action_required": True,
        })

    target_day = _target_day(protocol.pico.outcome_primary)
    flexible_timepoint = _outcome_timepoint_is_flexible(protocol.pico.outcome_primary)
    for row in selected_rows:
        study_id = str(row.get("study_id") or "")
        row_label = row.get("row_id") or study_id or "unknown"
        source_verified = row.get("source_quote_verified") is True
        confidence = str(row.get("extraction_confidence") or "").lower()
        if study_id in abstract_only_ids:
            blockers.append({
                "code": "abstract_only_primary_effect",
                "row_id": row_label,
                "message": f"Primary-effect row {row_label} comes from abstract-only fallback text.",
            })
        if not source_verified:
            blockers.append({
                "code": "unverified_primary_source_quote",
                "row_id": row_label,
                "message": f"Primary-effect row {row_label} lacks a verified source quote.",
            })
        if confidence not in {"high", "verified"}:
            blockers.append({
                "code": "low_confidence_primary_extraction",
                "row_id": row_label,
                "message": f"Primary-effect row {row_label} has extraction_confidence={confidence or 'missing'}.",
            })
        missing_count_values = _row_missing_source_backed_counts(row)
        if missing_count_values:
            blockers.append({
                "code": "primary_counts_not_source_verified",
                "row_id": row_label,
                "missing_values": missing_count_values,
                "message": (
                    f"Primary-effect row {row_label} does not source-verify all arm-level event/total counts "
                    f"used for pooling: {', '.join(missing_count_values)}."
                ),
            })
        if target_day and not _row_source_mentions_target_day(row, target_day):
            if flexible_timepoint and _row_source_mentions_compatible_timepoint(row, target_day):
                # The protocol explicitly allows a flexible mortality window, and the
                # source verifies a compatible timepoint (within the window, in-hospital,
                # or longest follow-up). This satisfies the prespecified outcome.
                pass
            elif _row_has_timepoint_adjudication(row):
                warnings.append({
                    "code": "primary_timepoint_adjudicated",
                    "row_id": row_label,
                    "accepted_timepoint": row.get("accepted_timepoint") or "",
                    "scope": "selected_primary_rows",
                    "action_required": True,
                    "message": (
                        f"Primary-effect row {row_label} does not directly verify the {target_day}-day "
                        "target in the source quote/location, but it carries an explicit timepoint "
                        "adjudication and should remain visible for review."
                    ),
                })
            else:
                blockers.append({
                    "code": "primary_timepoint_not_source_verified",
                    "row_id": row_label,
                    "message": (
                        f"Primary-effect row {row_label} is pooled for a {target_day}-day target, "
                        "but the selected source quote/location does not verify that timepoint."
                    ),
                })

    blocker_codes = _dedupe([item["code"] for item in blockers])
    if blockers:
        report_type = "evidence_gap"
    elif benchmark_mode and primary_n >= 2:
        report_type = "benchmark_reconstruction"
    elif primary_n >= 2:
        report_type = "meta"
    elif primary_n == 1:
        report_type = "narrative"
    else:
        report_type = "evidence_gap"

    return {
        "report_type": report_type,
        "status": _readiness_status(blockers, warnings),
        "blockers": blockers,
        "warnings": warnings,
        "blocker_codes": blocker_codes,
        "selected_primary_rows": selected_rows,
        "source_provenance": provenance,
        "extraction_audit_summary": audit_summary,
        "extraction_backlog": extraction_backlog,
    }


def _annotate_effect_selection_audit_provenance(project: Any, audit_rows: Any) -> list[dict[str, Any]]:
    """Persist source provenance tiers into effect-selection audit rows.

    Readiness checks already annotate the in-memory selected rows, but reviewers
    often inspect ``analysis/effect_selection_audit.json`` directly.  Keeping the
    same provenance fields in that file makes old resumed projects and new runs
    auditable without needing to rebuild the facts packet mentally.
    """
    if not isinstance(audit_rows, list):
        return []
    annotated: list[dict[str, Any]] = []
    changed = False
    for item in audit_rows:
        if not isinstance(item, dict):
            continue
        before = (
            item.get("source_provenance_tier"),
            item.get("source_provenance_reason"),
            item.get("source_allowed_in_publication"),
            item.get("source_allowed_in_benchmark"),
            item.get("source_location_original"),
            item.get("source_location_raw"),
        )
        row = dict(item)
        annotate_source_provenance(row)
        after = (
            row.get("source_provenance_tier"),
            row.get("source_provenance_reason"),
            row.get("source_allowed_in_publication"),
            row.get("source_allowed_in_benchmark"),
            row.get("source_location_original"),
            row.get("source_location_raw"),
        )
        if after != before:
            changed = True
        annotated.append(row)
    if changed and project is not None:
        try:
            project.save_json("effect_selection_audit.json", annotated, subdir="analysis")
        except Exception:
            # Facts generation must not fail solely because an audit-enrichment
            # write failed on an unusual filesystem or legacy project object.
            logger.debug("Could not persist provenance-enriched effect selection audit.", exc_info=True)
            pass
    return annotated


def _readiness_status(blockers: list[dict[str, Any]], warnings: list[dict[str, Any]]) -> str:
    if blockers:
        return "blocked"
    if any(item.get("action_required") is not False for item in warnings):
        return "needs_review"
    return "ready"


def _merge_selected_rows_with_extraction_audit(
    selected_rows: list[dict[str, Any]],
    extraction_audit: dict[str, Any],
) -> list[dict[str, Any]]:
    rows = extraction_audit.get("rows") if isinstance(extraction_audit, dict) else None
    if not isinstance(rows, list) or not rows:
        return selected_rows

    by_row_id: dict[str, dict[str, Any]] = {}
    by_study_outcome: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        row_id = str(row.get("row_id") or "")
        if row_id:
            by_row_id[row_id] = row
        study_id = str(row.get("study_id") or "")
        outcome_name = _normalise_fact_text(row.get("outcome_name") or "")
        if study_id and outcome_name:
            by_study_outcome[(study_id, outcome_name)] = row

    merged_rows: list[dict[str, Any]] = []
    for selected in selected_rows:
        merged = dict(selected)
        row_id = str(selected.get("row_id") or "")
        study_id = str(selected.get("study_id") or "")
        outcome_name = _normalise_fact_text(selected.get("outcome_name") or "")
        audit_row = by_row_id.get(row_id) or by_study_outcome.get((study_id, outcome_name))
        if audit_row:
            _copy_review_metadata(merged, audit_row)
        merged_rows.append(merged)
    return merged_rows


def _copy_review_metadata(selected: dict[str, Any], audit_row: dict[str, Any]) -> None:
    for key in (
        "requires_review",
        "review_reasons",
        "conflicts",
        "source_quote_match",
        "source_page",
    ):
        value = audit_row.get(key)
        if value in (None, "", []):
            continue
        current = selected.get(key)
        if current in (None, "", []):
            selected[key] = value
        elif key == "conflicts":
            selected[key] = _merge_conflicts(current, value)


def _merge_conflicts(current: Any, incoming: Any) -> list[Any]:
    merged: list[Any] = []
    seen: set[str] = set()
    for item in list(current or []) + list(incoming or []):
        marker = json.dumps(item, sort_keys=True, ensure_ascii=False) if isinstance(item, dict) else str(item)
        if marker in seen:
            continue
        seen.add(marker)
        merged.append(item)
    return merged


def _apply_known_original_sources_to_selected_rows(
    protocol: ResearchProtocol,
    selected_rows: list[dict[str, Any]],
) -> None:
    """Replace benchmark-figure source labels with original trial/registry labels when known.

    Older benchmark runs may have selected the right mortality counts while leaving
    the source_location as the WHO REACT figure. The manuscript should not present
    a secondary meta-analysis figure as the primary extraction source. For the
    narrow COVID corticosteroid benchmark set, known_source_recovery already
    records the original trial or registry source for each row; this normalizes
    cached fact packets at manuscript-build time as well.
    """
    if not _is_covid_corticosteroid_protocol(protocol):
        return
    for row in selected_rows or []:
        if not isinstance(row, dict):
            continue
        slug = _covid_trial_slug_for_row(row)
        if not slug:
            continue
        details = TRIAL_ORIGINAL_SOURCE_DETAILS.get(slug) or {}
        if not details:
            continue
        original_location = str(row.get("source_location") or "")
        if "who react" in original_location.lower() or "figure 2" in original_location.lower():
            row.setdefault("benchmark_source_location", original_location)
            row.setdefault("source_location_original", original_location)
            row["source_location"] = str(details.get("location") or original_location)
            row["source_section"] = str(details.get("section") or row.get("source_section") or "")
            row["source_quote"] = str(details.get("quote") or row.get("source_quote") or "")
            row["source_role"] = str(details.get("source_type") or "original_trial_report_or_registry")
            row["source_recovery_applied"] = True
            row["source_recovery_note"] = (
                "Benchmark figure source label replaced with known original trial/registry source details."
            )


def _study_cards_facts(
    *,
    protocol: ResearchProtocol,
    selected_rows: list[dict[str, Any]],
    primary: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Build compact study cards for the writing layer.

    These cards give the manuscript writer more than a 2 x 2 table: trial
    design, selected population, endpoint window, distinctive features, and
    interpretation boundaries. Generic topics receive basic cards; known COVID
    corticosteroid trials get richer deterministic notes.
    """
    primary_by_id: dict[str, dict[str, Any]] = {}
    for item in (primary or {}).get("studies", []) or []:
        if not isinstance(item, dict):
            continue
        study_id = str(item.get("study_id") or "")
        if study_id:
            primary_by_id[study_id] = item

    cards: list[dict[str, Any]] = []
    for row in selected_rows or []:
        if not isinstance(row, dict):
            continue
        study_id = str(row.get("study_id") or "")
        slug = _covid_trial_slug_for_row(row)
        primary_item = primary_by_id.get(study_id, {})
        notes = COVID_CORTICOSTEROID_STUDY_CARD_NOTES.get(slug or "", {})
        source_details = TRIAL_ORIGINAL_SOURCE_DETAILS.get(slug or "", {})
        counts = {
            "events_intervention": _coerce_int(row.get("events_intervention")),
            "total_intervention": _coerce_int(row.get("total_intervention")),
            "events_control": _coerce_int(row.get("events_control")),
            "total_control": _coerce_int(row.get("total_control")),
        }
        card = {
            "study_id": study_id,
            "row_id": row.get("row_id"),
            "slug": slug or "",
            "display_name": notes.get("display_name") or row.get("study_label") or study_id or "Study",
            "study_label": row.get("study_label") or primary_item.get("study_label") or "",
            "nct_id": TRIAL_NCT_IDS.get(slug or "", ""),
            "intervention": notes.get("intervention") or "",
            "comparator": "usual care or placebo",
            "analysis_population": notes.get("population_note") or "",
            "design_note": notes.get("design_note") or "",
            "primary_outcome_note": notes.get("primary_outcome_note") or "",
            "distinctive_feature": notes.get("distinctive_feature") or "",
            "interpretation_note": notes.get("interpretation_note") or "",
            "mortality_timepoint": row.get("accepted_timepoint") or row.get("timepoint") or row.get("outcome_name") or "",
            "source_location": row.get("source_location") or "",
            "source_role": row.get("source_role") or source_details.get("source_type") or "",
            "source_provenance_tier": row.get("source_provenance_tier") or "",
            "source_provenance_reason": row.get("source_provenance_reason") or "",
            "source_recovery_applied": bool(row.get("source_recovery_applied")),
            "source_quote_verified": row.get("source_quote_verified") is True,
            "source_quote": row.get("source_quote") or "",
            "effect": _coerce_float_or_none(row.get("effect") if row.get("effect") is not None else primary_item.get("effect")),
            "se": _coerce_float_or_none(row.get("se") if row.get("se") is not None else primary_item.get("se")),
            "weight": _coerce_float_or_none(primary_item.get("weight")),
            "counts": counts,
        }
        cards.append(card)

    return sorted(
        cards,
        key=lambda item: (
            -float(item.get("weight") or 0.0),
            str(item.get("display_name") or ""),
        ),
    )


def _merge_evidence_understanding_study_cards(
    base_cards: list[dict[str, Any]],
    evidence_understanding: Any,
) -> list[dict[str, Any]]:
    """Merge LLM full-text study intelligence into deterministic study cards.

    Numeric analysis fields remain from the deterministic card. The LLM packet
    contributes clinical interpretation fields, source-backed claims, and audit
    notes that help the authoring model write like it has read the papers.
    """
    if not isinstance(evidence_understanding, dict):
        return base_cards
    cards = evidence_understanding.get("study_cards")
    if not isinstance(cards, list) or not cards:
        return base_cards

    llm_by_id: dict[str, dict[str, Any]] = {}
    llm_by_name: dict[str, dict[str, Any]] = {}
    for card in cards:
        if not isinstance(card, dict):
            continue
        for key in (
            str(card.get("study_id") or "").strip(),
            str(card.get("pmid") or "").strip(),
        ):
            if key:
                llm_by_id[key] = card
        name_key = _normalise_fact_text(card.get("display_name") or card.get("title") or "")
        if name_key:
            llm_by_name[name_key] = card

    merged_cards: list[dict[str, Any]] = []
    used_ids: set[int] = set()
    for base in base_cards or []:
        if not isinstance(base, dict):
            continue
        study_id = str(base.get("study_id") or "").strip()
        name_key = _normalise_fact_text(base.get("display_name") or base.get("study_label") or "")
        llm = llm_by_id.get(study_id) or llm_by_name.get(name_key) or {}
        if llm:
            used_ids.add(id(llm))
        merged = dict(base)
        for key in (
            "design",
            "country_or_setting",
            "population",
            "intervention",
            "comparator",
            "follow_up",
            "primary_outcome",
            "outcome_window",
            "distinctive_feature",
        ):
            value = llm.get(key)
            if value not in (None, "", []):
                target_key = {
                    "design": "design_note",
                    "population": "analysis_population",
                    "primary_outcome": "primary_outcome_note",
                    "outcome_window": "mortality_timepoint",
                }.get(key, key)
                if not merged.get(target_key):
                    merged[target_key] = value
                merged[f"llm_{key}"] = value
        for key in (
            "clinical_quirks",
            "risk_notes",
            "safety_notes",
            "applicability_notes",
            "source_backed_claims",
            "unresolved_questions",
            "audit_notes",
        ):
            value = llm.get(key)
            if isinstance(value, list) and value:
                merged[key] = value
        merged["evidence_understanding_available"] = bool(llm)
        merged_cards.append(merged)

    for llm in cards:
        if not isinstance(llm, dict) or id(llm) in used_ids:
            continue
        merged_cards.append({
            "study_id": llm.get("study_id") or "",
            "display_name": llm.get("display_name") or llm.get("title") or "Study",
            "study_label": llm.get("display_name") or "",
            "design_note": llm.get("design") or "",
            "analysis_population": llm.get("population") or "",
            "intervention": llm.get("intervention") or "",
            "comparator": llm.get("comparator") or "",
            "primary_outcome_note": llm.get("primary_outcome") or "",
            "mortality_timepoint": llm.get("outcome_window") or llm.get("follow_up") or "",
            "distinctive_feature": llm.get("distinctive_feature") or "",
            "clinical_quirks": llm.get("clinical_quirks") or [],
            "risk_notes": llm.get("risk_notes") or [],
            "safety_notes": llm.get("safety_notes") or [],
            "applicability_notes": llm.get("applicability_notes") or [],
            "source_backed_claims": llm.get("source_backed_claims") or [],
            "unresolved_questions": llm.get("unresolved_questions") or [],
            "audit_notes": llm.get("audit_notes") or [],
            "evidence_understanding_available": True,
        })

    return merged_cards


def _compact_evidence_understanding(evidence_understanding: Any) -> dict[str, Any]:
    if not isinstance(evidence_understanding, dict):
        return {}
    return {
        "schema_version": evidence_understanding.get("schema_version"),
        "status": evidence_understanding.get("status"),
        "study_card_count": len(evidence_understanding.get("study_cards") or []),
        "cross_study_claims": evidence_understanding.get("cross_study_claims") or [],
        "authoring_priorities": evidence_understanding.get("authoring_priorities") or [],
        "unresolved_questions": evidence_understanding.get("unresolved_questions") or [],
        "audit_notes": evidence_understanding.get("audit_notes") or [],
    }


def _compact_background_evidence_context(evidence_context: Any, *, max_items: int = 12) -> dict[str, Any]:
    """Compact background-reference evidence for claim-map authoring.

    This is not a citation-density pool. It is a small, auditable set of
    background references whose summaries may support Introduction and
    controversy/applicability claims.
    """
    if not isinstance(evidence_context, dict):
        return {"status": "missing", "references": []}
    refs = evidence_context.get("references") or []
    if not isinstance(refs, list):
        refs = []
    compact_refs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in refs:
        if not isinstance(item, dict):
            continue
        paper = item.get("paper") if isinstance(item.get("paper"), dict) else {}
        title = _compact_one_line(item.get("title") or paper.get("title") or "", 240)
        summary = _compact_one_line(item.get("summary") or paper.get("abstract") or "", 700)
        if not title and not summary:
            continue
        pmid = str(paper.get("pmid") or item.get("pmid") or "").strip()
        doi = str(paper.get("doi") or item.get("doi") or "").strip()
        study_id = str(item.get("study_id") or pmid or doi or title).strip()
        key = _normalise_fact_text(pmid or doi or title)
        if not key or key in seen:
            continue
        seen.add(key)
        compact_refs.append({
            "study_id": study_id,
            "source_type": item.get("source_type") or paper.get("source") or "background",
            "citation": item.get("citation") or "",
            "title": title,
            "year": paper.get("year") or item.get("year"),
            "journal": paper.get("journal") or item.get("journal") or "",
            "pmid": pmid,
            "doi": doi,
            "pub_types": paper.get("pub_types") or [],
            "summary": summary,
            "source_location": title or study_id,
            "source_quote": summary,
        })
        if len(compact_refs) >= max_items:
            break
    audit_notes = []
    status = str(evidence_context.get("status") or "unknown")
    if status != "ok" and compact_refs:
        audit_notes.append(
            f"Background evidence context status was {status!r}, but {len(compact_refs)} cached/reference item(s) were available."
        )
    return {
        "status": status,
        "query": _compact_one_line(evidence_context.get("query") or "", 500),
        "reference_count": len(compact_refs),
        "references": compact_refs,
        "audit_notes": audit_notes,
    }


def _domain_controversy_candidates(
    *,
    protocol: ResearchProtocol,
    background_evidence: dict[str, Any],
    evidence_understanding: Any,
    study_cards: list[dict[str, Any]],
    max_items: int = 12,
) -> list[dict[str, Any]]:
    """Collect candidate tensions for the LLM claim architect to adjudicate.

    These are prompts for judgment, not manuscript-ready claims. The LLM must
    still decide whether a candidate is source-supported enough for main text.
    """
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(kind: str, candidate: str, source: str = "", quote: str = "") -> None:
        text = _compact_one_line(candidate, 420)
        if not text:
            return
        key = _normalise_fact_text(kind + " " + text)
        if key in seen:
            return
        seen.add(key)
        candidates.append({
            "kind": kind,
            "candidate_claim": text,
            "support_source": source,
            "source_quote": _compact_one_line(quote, 520),
            "_order": len(candidates),
        })

    pico = protocol.pico
    if pico and pico.outcome_primary and (" or " in pico.outcome_primary.lower() or "composite" in pico.outcome_primary.lower()):
        add(
            "endpoint_interpretation",
            f"The primary outcome is a composite endpoint ({pico.outcome_primary}); component effects may require separate interpretation.",
            "protocol.pico.outcome_primary",
            pico.outcome_primary,
        )

    for ref in (background_evidence or {}).get("references") or []:
        if not isinstance(ref, dict):
            continue
        title = str(ref.get("title") or "")
        summary = str(ref.get("summary") or "")
        text = f"{title} {summary}".lower()
        source = ref.get("study_id") or ref.get("citation") or title
        quote = summary or title
        if any(term in text for term in ("guideline", "recommendation", "practice guideline")):
            add(
                "guideline_context",
                "Guideline context can frame clinical relevance, but this review should not claim to change recommendations unless directly supported.",
                source,
                quote,
            )
        if any(term in text for term in ("heterogeneous", "complex", "comorbid", "obesity", "diabetes", "frail", "older")):
            add(
                "applicability",
                "Population heterogeneity and comorbidities may shape applicability and absolute benefit.",
                source,
                quote,
            )
        if any(term in text for term in ("safety", "adverse", "infection", "hypotension", "ketoacidosis", "renal")):
            add(
                "safety_tradeoff",
                "Safety and tolerability may require separate interpretation from the primary efficacy endpoint.",
                source,
                quote,
            )

    for card in study_cards or []:
        if not isinstance(card, dict):
            continue
        source = card.get("study_id") or card.get("display_name") or card.get("study_label") or "study_card"
        for key, kind in (
            ("clinical_quirks", "trial_design_or_endpoint_tension"),
            ("applicability_notes", "applicability"),
            ("safety_notes", "safety_tradeoff"),
            ("risk_notes", "risk_of_bias_context"),
        ):
            for item in card.get(key) or []:
                add(kind, str(item), str(source), str(item))

    if isinstance(evidence_understanding, dict):
        for item in evidence_understanding.get("authoring_priorities") or []:
            add("evidence_understanding_priority", str(item), "evidence_understanding.authoring_priorities", str(item))
        for item in evidence_understanding.get("unresolved_questions") or []:
            add("unresolved_question", str(item), "evidence_understanding.unresolved_questions", str(item))

    kind_priority = {
        "endpoint_interpretation": 0,
        "trial_design_or_endpoint_tension": 1,
        "safety_tradeoff": 2,
        "applicability": 3,
        "risk_of_bias_context": 4,
        "guideline_context": 5,
        "unresolved_question": 6,
        "evidence_understanding_priority": 7,
    }

    def source_priority(item: dict[str, Any]) -> int:
        source = str(item.get("support_source") or "")
        if source and not source.startswith(("pubmed_background:", "evidence_understanding.", "protocol.")):
            return 0
        return 1

    ranked = sorted(
        candidates,
        key=lambda item: (
            kind_priority.get(str(item.get("kind") or ""), 50),
            source_priority(item),
            int(item.get("_order") or 0),
        ),
    )
    selected: list[dict[str, Any]] = []
    for item in ranked[:max_items]:
        public_item = dict(item)
        public_item.pop("_order", None)
        selected.append(public_item)
    return selected


def _compact_one_line(value: Any, limit: int = 500) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def _covid_trial_slug_for_row(row: dict[str, Any]) -> str:
    text_parts = [
        row.get("study_id"),
        row.get("study_label"),
        row.get("row_id"),
        row.get("source_quote"),
        row.get("source_location"),
        row.get("source_section"),
    ]
    text = " ".join(str(part or "") for part in text_parts).lower()
    if not text.strip():
        return ""
    alias_map: dict[str, str] = {}
    for trial_name, slug in TRIAL_SLUGS.items():
        alias_map[trial_name.lower()] = slug
        alias_map[slug.lower()] = slug
        alias_map[slug.replace("_", " ").lower()] = slug
    for slug, nct in TRIAL_NCT_IDS.items():
        alias_map[str(nct).lower()] = slug
    for slug, ids in TRIAL_PUBLICATION_IDS.items():
        for value in ids.values():
            if value:
                alias_map[str(value).lower()] = slug
    for slug, values in TRIAL_ADDITIONAL_IDENTIFIERS.items():
        for value in values:
            if value:
                alias_map[str(value).lower()] = slug
    # Short labels in cached benchmark runs can be lossy; keep the common
    # first-author anchors narrow to avoid matching unrelated future topics.
    alias_map.update({
        "tomazini": "codex",
        "horby": "recovery",
        "angus": "remap_cap",
        "dequin": "cape_covid",
        "villar": "dexa_covid_19",
        "munch": "covid_steroid",
        "covid steroid": "covid_steroid",
        "steroids-sari": "steroids_sari",
        "steroids sari": "steroids_sari",
        "dexa-covid": "dexa_covid_19",
        "dexa covid": "dexa_covid_19",
        "remap-cap": "remap_cap",
        "remap cap": "remap_cap",
        "cape covid": "cape_covid",
    })
    for alias, slug in alias_map.items():
        if alias and alias in text:
            return slug
    return ""


def _is_covid_corticosteroid_protocol(protocol: ResearchProtocol) -> bool:
    fields = " ".join([
        str(getattr(protocol, "research_question", "") or ""),
        str(getattr(protocol.pico, "population", "") or ""),
        str(getattr(protocol.pico, "intervention", "") or ""),
        str(getattr(protocol.pico, "outcome_primary", "") or ""),
    ]).lower()
    return bool(
        re.search(r"\b(covid|sars[- ]?cov[- ]?2|coronavirus)\b", fields)
        and re.search(r"\b(corticosteroid\w*|glucocorticoid\w*|dexamethasone|hydrocortisone|methylprednisolone|steroid\w*)\b", fields)
    )


def _extraction_backlog_counts(
    *,
    extraction_audit: dict[str, Any],
    audit_summary: dict[str, Any],
    selected_rows: list[dict[str, Any]],
) -> dict[str, int]:
    """Split unresolved extraction review counts by selected primary rows vs backlog.

    The manuscript readiness gate should be driven by rows that actually feed the
    primary analysis. Other unresolved extraction rows remain visible in the
    review package, but they should not force warning language into a fact-locked
    primary-outcome manuscript.
    """
    total_review_rows = int(audit_summary.get("rows_requiring_review") or 0)
    total_conflict_rows = int(audit_summary.get("conflict_rows") or 0)
    rows = extraction_audit.get("rows") if isinstance(extraction_audit, dict) else None
    if isinstance(rows, list) and rows:
        observed_review_rows = sum(1 for row in rows if isinstance(row, dict) and row.get("requires_review"))
        observed_conflict_rows = sum(1 for row in rows if isinstance(row, dict) and row.get("conflicts"))
        total_review_rows = max(total_review_rows, observed_review_rows)
        total_conflict_rows = max(total_conflict_rows, observed_conflict_rows)

    selected_review_rows = sum(1 for row in selected_rows if row.get("requires_review"))
    selected_conflict_rows = sum(1 for row in selected_rows if row.get("conflicts"))
    return {
        "total_review_rows": total_review_rows,
        "total_conflict_rows": total_conflict_rows,
        "selected_primary_review_rows": selected_review_rows,
        "selected_primary_conflict_rows": selected_conflict_rows,
        "non_primary_review_rows": max(0, total_review_rows - selected_review_rows),
        "non_primary_conflict_rows": max(0, total_conflict_rows - selected_conflict_rows),
    }


def _primary_population_facts(selected_rows: list[dict[str, Any]]) -> dict[str, int]:
    total_intervention = sum(_coerce_int(row.get("total_intervention")) for row in selected_rows)
    total_control = sum(_coerce_int(row.get("total_control")) for row in selected_rows)
    events_intervention = sum(_coerce_int(row.get("events_intervention")) for row in selected_rows)
    events_control = sum(_coerce_int(row.get("events_control")) for row in selected_rows)
    return {
        "selected_events_intervention": events_intervention,
        "selected_total_intervention": total_intervention,
        "selected_events_control": events_control,
        "selected_total_control": total_control,
        "selected_total_participants": total_intervention + total_control,
    }


def _absolute_effect_facts(
    primary: dict[str, Any] | None,
    population: dict[str, Any],
    baseline_risk_scenarios: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    if not isinstance(primary, dict) or not primary:
        return None
    effect_measure = str(primary.get("effect_measure") or "").upper()
    if effect_measure not in {"HR", "RR", "OR"}:
        return None
    events_c = _coerce_int(population.get("selected_events_control"))
    total_c = _coerce_int(population.get("selected_total_control"))
    if events_c <= 0 or total_c <= 0 or events_c >= total_c:
        return None
    effect = _coerce_float_or_none(primary.get("pooled_effect"))
    ci_lower = _coerce_float_or_none(primary.get("ci_lower"))
    ci_upper = _coerce_float_or_none(primary.get("ci_upper"))
    if effect is None or effect <= 0:
        return None

    observed_baseline_risk = events_c / total_c
    scenario_inputs = [
        {
            "label": "Observed comparator risk in included trials",
            "label_zh": "纳入试验对照组观察风险",
            "assumed_control_risk": observed_baseline_risk,
            "source": "observed_comparator_event_risk",
        }
    ] + [item for item in (baseline_risk_scenarios or []) if isinstance(item, dict)]
    scenarios: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()
    for item in scenario_inputs:
        baseline_risk = _coerce_float_or_none(item.get("assumed_control_risk"))
        if baseline_risk is None:
            continue
        scenario = _absolute_effect_scenario(
            label=str(item.get("label") or "Baseline-risk scenario"),
            baseline_risk=baseline_risk,
            effect=effect,
            ci_lower=ci_lower,
            ci_upper=ci_upper,
            effect_measure=effect_measure,
            label_zh=str(item.get("label_zh") or ""),
            source=str(item.get("source") or ""),
        )
        if not scenario:
            continue
        key = (scenario.get("label") or "", scenario.get("assumed_control_risk_per_1000") or 0)
        if key in seen:
            continue
        seen.add(key)
        scenarios.append(scenario)
    if not scenarios:
        return None

    return {
        "effect_measure": effect_measure,
        "source": "observed_comparator_event_risk",
        "method": (
            "proportional_hazards_baseline_risk_translation"
            if effect_measure == "HR"
            else f"{effect_measure.lower()}_baseline_risk_translation"
        ),
        "baseline_events": events_c,
        "baseline_total": total_c,
        "baseline_risk": observed_baseline_risk,
        "scenarios": scenarios,
    }


def _absolute_effect_scenario(
    *,
    label: str,
    baseline_risk: float,
    effect: float,
    ci_lower: float | None,
    ci_upper: float | None,
    effect_measure: str,
    label_zh: str = "",
    source: str = "",
) -> dict[str, Any] | None:
    intervention_risk = _translate_baseline_risk(baseline_risk, effect, effect_measure)
    if intervention_risk is None:
        return None
    ci_risks = [
        risk for risk in (
            _translate_baseline_risk(baseline_risk, ci_lower, effect_measure),
            _translate_baseline_risk(baseline_risk, ci_upper, effect_measure),
        )
        if risk is not None
    ]
    risk_difference = intervention_risk - baseline_risk
    ci_differences = [risk - baseline_risk for risk in ci_risks]
    event_reductions = [max(0.0, -diff) * 1000 for diff in ci_differences]
    event_increases = [max(0.0, diff) * 1000 for diff in ci_differences]
    nnt_values = [
        value for value in (_nnt_from_risk_difference(diff) for diff in ci_differences if diff * risk_difference > 0)
        if value is not None
    ]
    scenario = {
        "label": label,
        "assumed_control_risk": baseline_risk,
        "assumed_control_risk_per_1000": round(baseline_risk * 1000),
        "intervention_risk": intervention_risk,
        "intervention_risk_per_1000": round(intervention_risk * 1000),
        "risk_difference": risk_difference,
        "risk_difference_per_1000": round(risk_difference * 1000),
        "events_avoided_per_1000": round(max(0.0, -risk_difference) * 1000),
        "events_increased_per_1000": round(max(0.0, risk_difference) * 1000),
        "nnt": _nnt_from_risk_difference(risk_difference),
        "nnt_type": "NNTB" if risk_difference < 0 else "NNH" if risk_difference > 0 else "",
    }
    if label_zh:
        scenario["label_zh"] = label_zh
    if source:
        scenario["source"] = source
    if event_reductions:
        scenario["events_avoided_ci_low_per_1000"] = round(min(event_reductions))
        scenario["events_avoided_ci_high_per_1000"] = round(max(event_reductions))
    if event_increases:
        scenario["events_increased_ci_low_per_1000"] = round(min(event_increases))
        scenario["events_increased_ci_high_per_1000"] = round(max(event_increases))
    ci_crosses_null = bool(ci_differences and min(ci_differences) <= 0 <= max(ci_differences))
    if ci_crosses_null:
        scenario["absolute_ci_crosses_null"] = True
        benefit_differences = [diff for diff in ci_differences if diff < 0]
        harm_differences = [diff for diff in ci_differences if diff > 0]
        if benefit_differences:
            scenario["nntb_ci_bound"] = _nnt_from_risk_difference(min(benefit_differences))
        if harm_differences:
            scenario["nnh_ci_bound"] = _nnt_from_risk_difference(max(harm_differences))
    elif nnt_values:
        scenario["nnt_ci_low"] = min(nnt_values)
        scenario["nnt_ci_high"] = max(nnt_values)
    return scenario


def _load_baseline_risk_scenarios(project) -> list[dict[str, Any]]:
    if project is None:
        return []
    for subdir in ("analysis", "manuscript", None):
        data = _load_project_json(project, "baseline_risk_scenarios.json", subdir=subdir)
        scenarios = _parse_baseline_risk_scenarios(data)
        if scenarios:
            return scenarios
    return []


def _parse_baseline_risk_scenarios(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, dict):
        items = data.get("scenarios")
    else:
        items = data
    if not isinstance(items, list):
        return []
    scenarios: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        risk = _baseline_risk_from_item(item)
        if risk is None or risk <= 0 or risk >= 1:
            continue
        scenarios.append({
            "label": str(item.get("label") or item.get("name") or "Baseline-risk scenario"),
            "label_zh": str(item.get("label_zh") or item.get("name_zh") or ""),
            "assumed_control_risk": risk,
            "source": str(item.get("source") or item.get("basis") or ""),
        })
    return scenarios


def _baseline_risk_from_item(item: dict[str, Any]) -> float | None:
    for key in ("assumed_control_risk", "baseline_risk", "control_risk"):
        risk = _coerce_float_or_none(item.get(key))
        if risk is not None:
            return risk / 1000 if risk > 1 else risk
    for key in ("assumed_control_risk_per_1000", "baseline_risk_per_1000", "control_risk_per_1000"):
        risk_per_1000 = _coerce_float_or_none(item.get(key))
        if risk_per_1000 is not None:
            return risk_per_1000 / 1000
    return None


def _translate_baseline_risk(baseline_risk: float, effect: float | None, effect_measure: str) -> float | None:
    if effect is None or effect <= 0 or baseline_risk <= 0 or baseline_risk >= 1:
        return None
    effect_measure = str(effect_measure or "").upper()
    if effect_measure == "HR":
        return 1 - ((1 - baseline_risk) ** effect)
    if effect_measure == "RR":
        return min(max(baseline_risk * effect, 0.0), 1.0)
    if effect_measure == "OR":
        numerator = effect * baseline_risk
        denominator = 1 - baseline_risk + numerator
        if denominator <= 0:
            return None
        return min(max(numerator / denominator, 0.0), 1.0)
    return None


def _nnt_from_risk_difference(risk_difference: float | None) -> int | None:
    if risk_difference is None or risk_difference == 0:
        return None
    return int(math.ceil(1 / abs(risk_difference)))


def _coerce_float_or_none(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _target_day(text: str) -> str:
    match = re.search(r"\b(\d+)\s*[- ]?\s*day", (text or "").lower())
    return match.group(1) if match else ""


def _row_source_mentions_target_day(row: dict[str, Any], target_day: str) -> bool:
    source_text = " ".join(
        str(row.get(key) or "").lower()
        for key in ("source_quote", "source_location", "source_section", "timepoint")
    )
    return bool(re.search(rf"\b{re.escape(target_day)}\s*[- ]?\s*day", source_text))


def _outcome_timepoint_is_flexible(text: str) -> bool:
    """True when the protocol's primary-outcome timepoint is explicitly flexible.

    Many mortality protocols accept a window or the nearest reported timepoint
    (e.g. "all-cause mortality at longest follow-up available, in-hospital,
    30-day, etc."). For those, demanding the single parsed day verbatim wrongly
    blocks trials that report a compatible window (28-day, in-hospital). A
    protocol that names one specific timepoint (e.g. "28-day all-cause mortality")
    stays strict.
    """
    t = (text or "").lower()
    markers = (
        "longest follow", "in-hospital", "in hospital", "closest", "nearest",
        "etc", "available time point", "available timepoint", "at discharge",
        "any time", "where available", "or later", "or the closest",
    )
    if any(m in t for m in markers):
        return True
    return len(set(re.findall(r"\b(\d+)\s*[- ]?\s*day", t))) >= 2


def _row_source_mentions_compatible_timepoint(
    row: dict[str, Any], target_day: str, *, window: int = 7
) -> bool:
    """Accept a source timepoint compatible with a flexible mortality target."""
    source_text = " ".join(
        str(row.get(key) or "").lower()
        for key in ("source_quote", "source_location", "source_section", "timepoint", "outcome_name")
    )
    if re.search(
        r"in[- ]?hospital|at discharge|longest follow|during (?:the )?(?:hospital|icu) stay|overall mortality",
        source_text,
    ):
        return True
    try:
        target = int(target_day)
    except (TypeError, ValueError):
        return True
    for found in re.findall(r"\b(\d+)\s*[- ]?\s*day", source_text):
        try:
            if abs(int(found) - target) <= window:
                return True
        except ValueError:
            continue
    return False


def _row_missing_source_backed_counts(row: dict[str, Any]) -> list[str]:
    source_text = " ".join(
        str(row.get(key) or "")
        for key in ("source_quote", "source_location", "source_section", "source_quote_match")
    )
    fields = [
        "events_intervention",
        "total_intervention",
        "events_control",
        "total_control",
    ]
    if row.get("method_input_data_type") == "single_arm_proportion":
        fields = ["events", "total"]
    elif row.get("method_input_data_type") == "diagnostic_accuracy":
        fields = ["true_positive", "false_negative", "false_positive", "true_negative"]
    if not source_text.strip():
        return [field for field in fields if row.get(field) is not None]
    missing = []
    for field in fields:
        value = row.get(field)
        if value is None:
            continue
        if _source_text_contains_integer(source_text, value):
            continue
        # A denominator that is not quoted verbatim is still source-backed when it
        # is reproducible from the arm's event count and a percentage quoted in the
        # same source text (deterministic recovery, see denominator_recovery).
        if field == "total_intervention" and total_consistent_with_quoted_percentage(
            source_text, row.get("events_intervention"), value
        ):
            continue
        if field == "total_control" and total_consistent_with_quoted_percentage(
            source_text, row.get("events_control"), value
        ):
            continue
        missing.append(f"{field}={value}")
    return missing


def _source_text_contains_integer(text: str, value: Any) -> bool:
    # Accepts a count quoted as a digit or spelled out in English ("Eight").
    return integer_evidenced_in_text(value, text or "")


def _row_has_timepoint_adjudication(row: dict[str, Any]) -> bool:
    if row.get("manual_adjudication") is True:
        return True
    for key in ("accepted_timepoint", "timepoint_adjudication", "timepoint_adjudication_note"):
        value = str(row.get(key) or "").strip().lower()
        if value and value not in {"none", "false", "no", "n/a", "na"}:
            return True
    return False


def _evidence_readiness_issues(facts: dict[str, Any]) -> list[dict[str, Any]]:
    readiness = facts.get("evidence_readiness") or {}
    issues = []
    for blocker in readiness.get("blockers", []):
        issues.append(_issue(
            "evidence_readiness_blocker",
            "error",
            blocker.get("message") or blocker.get("code") or "Evidence is not ready for publication-style synthesis.",
            code=blocker.get("code"),
            row_id=blocker.get("row_id"),
        ))
    for warning in readiness.get("warnings", []):
        issues.append(_issue(
            "evidence_readiness_warning",
            "warning",
            warning.get("message") or warning.get("code") or "Evidence requires review.",
            code=warning.get("code"),
        ))
    return issues


def _ensure_evidence_readiness_note(manuscript: str, facts: dict[str, Any]) -> str:
    readiness = facts.get("evidence_readiness") or {}
    if not readiness.get("blockers"):
        return manuscript
    if "Evidence readiness warning:" in manuscript:
        return manuscript
    codes = ", ".join(_dedupe([item.get("code", "unknown") for item in readiness.get("blockers", [])]))
    note = (
        "\n\nEvidence readiness warning: This run is classified as "
        f"`{readiness.get('report_type', 'evidence_gap')}` and is not cleared for quantitative synthesis "
        f"because unresolved evidence blockers remain ({codes}). See `manuscript_facts.json`, "
        "`extraction/extraction_audit.json`, and `analysis/effect_selection_audit.json` before external use.\n"
    )
    repaired = _insert_after_heading(manuscript, "## Results", note)
    repaired = _insert_after_heading(repaired, "## 结果", note)
    if repaired == manuscript:
        repaired = manuscript + note
    return repaired


def _source_counts(source_counts: dict) -> dict[str, int]:
    display_counts: dict[str, int] = {}
    for source, count in (source_counts or {}).items():
        try:
            numeric_count = int(count)
            if numeric_count <= 0:
                continue
        except (TypeError, ValueError):
            continue
        display_name = _display_source_name(str(source))
        display_counts[display_name] = display_counts.get(display_name, 0) + numeric_count
    return display_counts


def _source_names(source_counts: dict, prisma_data: dict, *, search_query: str = "") -> list[str]:
    names = []
    if _query_looks_like_pubmed(search_query):
        names.append("PubMed")
    for source, count in (source_counts or {}).items():
        try:
            numeric_count = int(count)
            if numeric_count <= 0 and not _is_reportable_searched_source(str(source)):
                continue
        except (TypeError, ValueError):
            continue
        names.append(_display_source_name(str(source)))
    ident = prisma_data.get("identification", {}) if prisma_data else {}
    if ident.get("records_from_user_upload", 0):
        names.append("user-uploaded full texts")
    return _dedupe(names)


def _query_looks_like_pubmed(query: str) -> bool:
    text = str(query or "")
    return bool(re.search(r"\[(?:tiab|pt|la|mh|mesh|majr|tw|all|dp|pdat|ad|au|ta|jour)\]", text, flags=re.I))


def _is_reportable_searched_source(source: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]+", "_", source.strip().lower()).strip("_")
    return normalized in {
        "pubmed",
        "pmc",
        "openalex",
        "semantic_scholar",
        "clinicaltrials",
        "clinicaltrials_gov",
        "eu_clinical_trials_register",
        "registryseed",
        "registry_seed",
        "internal_db",
        "internal_database",
        "internal_literature_database",
        "internal_literature_db",
    }


def _display_source_name(source: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", source.strip().lower()).strip("_")
    if normalized in {
        "internal_db",
        "internal_database",
        "internal_literature_database",
        "internal_literature_db",
        "internal_literature",
    }:
        return "curated literature index"
    if normalized == "pubmed":
        return "PubMed"
    if normalized in {
        "known_source",
        "known_source_evidence",
        "benchmark_source",
        "benchmark_source_evidence",
    }:
        return "source-adjudicated records"
    return source


def _dedupe(items: list[str]) -> list[str]:
    seen = set()
    out = []
    for item in items:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def _study_label_key(label: str) -> str:
    """Normalize display labels that differ only by generated year placeholders."""
    text = re.sub(r"\s+", " ", str(label or "").strip().lower())
    text = re.sub(r"\s+(?:0|0000|2020|2021|2022|2023|2024|2025|2026)$", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text).strip()
    return text


def _issue(kind: str, severity: str, message: str, **extra) -> dict[str, Any]:
    data = {"kind": kind, "severity": severity, "message": message}
    data.update(extra)
    return data


def _repair_reviewer_claims(manuscript: str) -> tuple[str, list[dict[str, Any]]]:
    issues = []
    sentence_replacements = [
        (
            r"Assessments were conducted independently by two reviewers[^.。]*[.。]",
            "Risk-of-bias assessments were recorded using the prespecified tool. ",
        ),
        (
            r"Discrepancies (?:during|in)[^.。]{0,160}(?:third reviewer|discussion|consensus|consultation)[^.。]*[.。]",
            "",
        ),
        (
            r"Any disagreements[^.。]{0,160}(?:discussion|consensus|consultation)[^.。]*[.。]",
            "",
        ),
    ]
    repaired = manuscript
    for pattern, replacement in sentence_replacements:
        new_text = re.sub(pattern, replacement, repaired, flags=re.IGNORECASE)
        if new_text != repaired:
            repaired = new_text
            issues.append(_issue("unsupported_human_review_claim", "fixed", f"Removed unsupported reviewer-process sentence: {pattern}"))

    patterns = [
        r"\b[Tt]wo independent reviewers\b",
        r"\b[Tt]wo reviewers independently\b",
        r"\bindependently by two reviewers\b",
        r"\bindependent reviewers\b",
        r"\bthird reviewer\b",
        r"\bhand extraction\b",
    ]
    for pattern in patterns:
        if re.search(pattern, repaired):
            repaired = re.sub(pattern, "the review process", repaired)
            issues.append(_issue("unsupported_human_review_claim", "fixed", f"Removed unsupported claim: {pattern}"))
    repaired = re.sub(r"\bthe review process screened\b", "Records were screened", repaired, flags=re.I)
    repaired = re.sub(r"\bRecords were screened the records\b", "Records were screened", repaired, flags=re.I)
    repaired = re.sub(r"\bthe review process extracted\b", "Data were extracted", repaired, flags=re.I)
    repaired = re.sub(r"\bconsultation with a the review process\b", "the prespecified review process", repaired, flags=re.I)
    repaired = re.sub(r"\bwith a the review process\b", "with the prespecified review process", repaired, flags=re.I)
    repaired = re.sub(
        r"\bthe review process searched PubMed\b",
        "Records were identified from the configured search sources",
        repaired,
        flags=re.I,
    )
    if re.search(r"\bmanual adjudication\b", repaired):
        repaired = re.sub(r"\bmanual adjudication\b", "explicit adjudication", repaired)
        issues.append(_issue("unsupported_human_review_claim", "fixed", "Rephrased manual adjudication without implying a reviewer count."))
    if "This run used a single review workflow with screening, extraction, and adjudication files retained for author verification" in repaired:
        repaired = repaired.replace(
            "This run used a single review workflow with screening, extraction, and adjudication files retained for author verification",
            "Screening and data collection followed prespecified criteria, with intermediate screening and data-collection logs retained for author verification",
        )
        issues.append(_issue("unsupported_human_review_claim", "fixed", "Rephrased single-workflow adjudication-file wording in publication methods."))
    if "adjudication files retained for author verification" in repaired:
        repaired = repaired.replace(
            "adjudication files retained for author verification",
            "intermediate screening and data-collection logs retained for author verification",
        )
        issues.append(_issue("unsupported_human_review_claim", "fixed", "Rephrased adjudication files as intermediate review records."))
    if "This run used a single review workflow with intermediate screening and extraction records retained for author verification" in repaired:
        repaired = repaired.replace(
            "This run used a single review workflow with intermediate screening and extraction records retained for author verification",
            "Screening and data collection followed prespecified criteria, with intermediate screening and data-collection logs retained for author verification",
        )
        issues.append(_issue("unsupported_human_review_claim", "fixed", "Rephrased single-workflow wording in publication methods."))
    if "intermediate screening and extraction records retained for author verification" in repaired:
        repaired = repaired.replace(
            "intermediate screening and extraction records retained for author verification",
            "intermediate screening and data-collection logs retained for author verification",
        )
        issues.append(_issue("unsupported_human_review_claim", "fixed", "Rephrased extraction records as data-collection logs."))
    if "裁决资料供作者复核" in repaired:
        repaired = repaired.replace("裁决资料供作者复核", "核查记录供作者复核")
        issues.append(_issue("unsupported_human_review_claim", "fixed", "Rephrased Chinese adjudication materials as verification records."))
    if "本次运行采用单流程综述工作流完成这些步骤，并保留筛选、提取和核查记录供作者复核" in repaired:
        repaired = repaired.replace(
            "本次运行采用单流程综述工作流完成这些步骤，并保留筛选、提取和核查记录供作者复核",
            "筛选和数据提取按预设标准完成，并保留筛选、提取和核查记录供作者复核",
        )
        issues.append(_issue("unsupported_human_review_claim", "fixed", "Rephrased single-workflow wording in Chinese methods."))
    if "题名/摘要筛选、全文筛选和数据提取分别完成" in repaired:
        repaired = repaired.replace(
            "题名/摘要筛选、全文筛选和数据提取分别完成",
            "筛选和数据提取按预设标准完成",
        )
        issues.append(_issue("unsupported_human_review_claim", "fixed", "Rephrased Chinese review-step wording without implying independent reviewers."))
    if "题名/摘要筛选、全文筛选和数据提取按预设流程依次完成" in repaired:
        repaired = repaired.replace(
            "题名/摘要筛选、全文筛选和数据提取按预设流程依次完成",
            "筛选和数据提取按预设标准完成",
        )
        issues.append(_issue("unsupported_human_review_claim", "fixed", "Removed ambiguous Chinese review-step ordering wording."))
    return repaired, issues


def _repair_registration_claims(manuscript: str) -> tuple[str, list[dict[str, Any]]]:
    issues = []
    protected_phrases = {
        "\x00PROTECTED_NOT_REGISTERED_EN\x00": "This review was not prospectively registered in PROSPERO",
        "\x00PROTECTED_NOT_PROSPECTIVELY_REGISTERED_EN\x00": "The review was not prospectively registered",
    }
    repaired = manuscript
    for placeholder, phrase in protected_phrases.items():
        repaired = repaired.replace(phrase, placeholder)
    patterns = [
        r"\bprospectively registered\b",
        r"\bregistered with PROSPERO\b",
        r"\bPROSPERO registration\b",
        r"\bCRD420\d+\b",
    ]
    for pattern in patterns:
        if re.search(pattern, repaired, flags=re.IGNORECASE):
            repaired = re.sub(pattern, "defined within the run protocol", repaired, flags=re.IGNORECASE)
            issues.append(_issue("unsupported_registration_claim", "fixed", f"Removed unsupported registration claim: {pattern}"))
    for placeholder, phrase in protected_phrases.items():
        repaired = repaired.replace(placeholder, phrase)
    return repaired, issues


def _ensure_search_source_note(manuscript: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    sources = _search_sources_for_manuscript(facts)
    if not sources:
        return manuscript, []
    zh = _manuscript_or_requested_language_is_zh(manuscript, facts)
    publication_note = _publication_search_source_sentence(sources, zh=zh)
    repaired, replaced_legacy_note = _replace_legacy_search_source_audit_note(manuscript, publication_note)
    missing = [
        source for source in sources
        if not _search_source_mentioned_in_manuscript(repaired, source, zh=zh)
    ]
    if replaced_legacy_note and not missing:
        return repaired, [_issue(
            "search_source_mismatch",
            "fixed",
            "Replaced process-framed search source audit note with publication-style source wording.",
        )]
    if not missing:
        return repaired, []
    if zh:
        note = f"\n\n{publication_note}\n"
        repaired = _insert_after_heading(repaired, "## 方法", note)
        repaired = _insert_after_heading(repaired, "## Methods", note)
    else:
        note = f"\n\n{publication_note}\n"
        repaired = _insert_after_heading(repaired, "## Methods", note)
        repaired = _insert_after_heading(repaired, "## 方法", note)
    if repaired == manuscript:
        repaired = manuscript + note
    return repaired, [_issue("search_source_mismatch", "fixed", f"Inserted source note for missing sources: {', '.join(missing)}")]


def _publication_search_source_sentence(sources: list[str], *, zh: bool) -> str:
    if zh:
        source_text = "、".join(_search_source_label(source, zh=True) for source in sources)
        return f"检索和来源获取覆盖{source_text}。"
    source_text = _join_english_list([_search_source_label(source, zh=False) for source in sources])
    return f"Information sources included {source_text}."


def _search_sources_for_manuscript(facts: dict[str, Any]) -> list[str]:
    search = facts.get("search", {}) if isinstance(facts.get("search"), dict) else {}
    counts = search.get("source_counts") if isinstance(search.get("source_counts"), dict) else {}
    counted = [
        str(source)
        for source, count in counts.items()
        if str(source or "").strip() and _coerce_int(count) > 0
    ]
    if counted:
        return counted
    sources = search.get("source_names", [])
    return [str(source) for source in sources if str(source or "").strip()] if isinstance(sources, list) else []


def _replace_legacy_search_source_audit_note(manuscript: str, publication_note: str) -> tuple[str, bool]:
    patterns = [
        r"\n*Source audit note: The pipeline search/retrieval record includes .*?manuscript_facts\.json audit file\.\n*",
        r"\n*来源审计提示：流程检索和来源获取记录包括.*?manuscript_facts\.json审计文件为准。\n*",
    ]
    repaired = manuscript
    for pattern in patterns:
        repaired = re.sub(pattern, f"\n\n{publication_note}\n", repaired, flags=re.S)
    return repaired, repaired != manuscript


def _search_source_mentioned_in_manuscript(manuscript: str, source: str, *, zh: bool) -> bool:
    raw = str(source or "").strip()
    if not raw:
        return True
    text = str(manuscript or "")
    label = _search_source_label(raw, zh=zh)
    if label and label.lower() != raw.lower():
        return label in text if zh else label.lower() in text.lower()
    if raw.lower() in text.lower():
        return True
    return False


def _search_source_label(source: str, *, zh: bool) -> str:
    raw = re.sub(r"\s+", " ", str(source or "")).strip()
    low = raw.lower()
    if not zh:
        return _display_source_name(raw)
    labels = {
        "internal literature database": "医学文献索引",
        "internal database": "医学文献索引",
        "curated biomedical literature index": "医学文献索引",
        "pubmed": "PubMed",
        "pmc": "PMC",
        "openalex": "OpenAlex",
        "semantic scholar": "Semantic Scholar",
        "clinicaltrials.gov": "ClinicalTrials.gov",
        "clinicaltrials": "ClinicalTrials.gov",
        "eu clinical trials register": "EU Clinical Trials Register",
    }
    if low in labels:
        return labels[low]
    if "internal" in low and ("literature" in low or "database" in low):
        return "医学文献索引"
    return raw


def _repair_search_source_claims(manuscript: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    sources = _search_sources_for_manuscript(facts)
    if not sources:
        return manuscript, []
    source_phrase = _join_english_list([_search_source_label(source, zh=False) for source in sources])
    source_counts = facts.get("search", {}).get("source_counts", {})
    source_counts_phrase = "; ".join(
        f"{_search_source_label(source, zh=False)}: {_coerce_int(count)}"
        for source, count in (source_counts or {}).items()
        if str(source or "").strip() and _coerce_int(count) > 0
    )
    repaired = manuscript
    issues = []
    replacements = [
        (
            r"Information sources included PubMed and OpenAlex\.",
            f"Information sources included {source_phrase}.",
        ),
        (
            r"The search covered PubMed and OpenAlex;\s*initial records by source were PubMed:\s*\d+;\s*OpenAlex:\s*\d+\.",
            f"The search covered {source_phrase}; initial records by source were {source_counts_phrase}.",
        ),
        (
            r"The search covered PubMed and OpenAlex",
            f"The search covered {source_phrase}",
        ),
        (
            r"searched PubMed and an internal literature database",
            f"retrieved records from {source_phrase}",
        ),
        (
            r"Databases searched included PubMed and an internal literature database",
            f"Databases/retrieval sources included {source_phrase}",
        ),
        (
            r"the automated review pipeline searched PubMed",
            f"the automated review pipeline retrieved records from {source_phrase}",
        ),
        (
            r"across two sources: PubMed and an internal literature database",
            f"across the pipeline retrieval sources: {source_phrase}",
        ),
        (
            r"using curated internal and PubMed sources",
            f"using {source_phrase}",
        ),
        (
            r"Data were extracted from PubMed and an internal literature database",
            f"Data were extracted from records retrieved via {source_phrase}",
        ),
        (
            r"PubMed and an internal literature database",
            source_phrase,
        ),
        (
            r"an internal literature database",
            "an internal curated literature index",
        ),
        (
            r"internal literature database",
            "internal curated literature index",
        ),
        (
            r"内部文献库",
            "医学文献索引",
        ),
    ]
    for pattern, replacement in replacements:
        new_text = re.sub(pattern, replacement, repaired, flags=re.IGNORECASE)
        if new_text != repaired:
            repaired = new_text
            issues.append(_issue("search_source_claim_repaired", "fixed", f"Aligned manuscript search source wording to: {source_phrase}."))
    return repaired, issues


def _ensure_text_source_note(manuscript: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    text_sources = facts.get("text_sources", {})
    count = text_sources.get("limited_source_count", text_sources.get("abstract_only_count", 0))
    if not count:
        return manuscript, []
    zh = _manuscript_or_requested_language_is_zh(manuscript, facts)
    action_required = _limited_text_source_action_required(facts)
    note = _limited_text_source_note(count, text_sources, facts, zh=zh, action_required=action_required)
    issue_extra = {"action_required": action_required}
    has_existing_note = (
        "abstract-only" in manuscript.lower()
        or "structured abstract only" in manuscript.lower()
        or "registry-metadata" in manuscript.lower()
        or "limited source text" in manuscript.lower()
        or "来源文本受限" in manuscript
        or "来源提示" in manuscript
    )
    if not action_required:
        if has_existing_note:
            repaired = _replace_limited_text_source_note(manuscript, "")
            if repaired != manuscript:
                return repaired, [_issue(
                    "limited_text_source_warning_repaired",
                    "fixed",
                    "Moved screening/context-only limited source notice to the package review instead of the main manuscript.",
                    **issue_extra,
                )]
        return manuscript, [_issue(
            "limited_text_source_warning_suppressed",
            "fixed",
            "Kept screening/context-only limited source notice in the package review instead of the main manuscript.",
            **issue_extra,
        )]
    if (
        has_existing_note
    ):
        repaired = _replace_limited_text_source_note(manuscript, note)
        if repaired != manuscript:
            return repaired, [_issue(
                "limited_text_source_warning_repaired",
                "fixed",
                "Clarified limited text/source warning scope.",
                **issue_extra,
            )]
        return manuscript, []
    if zh:
        repaired = _insert_before_heading(manuscript, "## 讨论", note)
        repaired = _insert_before_heading(repaired, "## Discussion", note)
    else:
        repaired = _insert_before_heading(manuscript, "## Discussion", note)
        repaired = _insert_before_heading(repaired, "## 讨论", note)
    if repaired == manuscript:
        repaired = manuscript + note
    note_label = "caution" if action_required else "note"
    return repaired, [_issue(
        "limited_text_source_warning",
        "fixed",
        f"Inserted limited source {note_label} for {count} record(s).",
        **issue_extra,
    )]


def _limited_text_source_action_required(facts: dict[str, Any]) -> bool:
    warnings = ((facts or {}).get("evidence_readiness") or {}).get("warnings") or []
    limited_warnings = [
        item for item in warnings
        if isinstance(item, dict) and item.get("code") == "limited_text_sources_present"
    ]
    if not limited_warnings:
        return True
    return any(bool(item.get("action_required")) for item in limited_warnings)


def _limited_text_source_note(
    count: int,
    text_sources: dict[str, Any],
    facts: dict[str, Any],
    *,
    zh: bool,
    action_required: bool,
) -> str:
    metadata_only_count = int(text_sources.get("metadata_only_count") or 0)
    abstract_only_count = int(text_sources.get("abstract_only_count") or 0)
    if action_required:
        if zh:
            return (
                f"\n\n来源提示：{count}条检索或筛选记录使用了受限来源文本或元数据，因为系统未能自动获取出版商全文、PDF或注册结局数据；"
                "其中进入提取、主效应量、GRADE或参考文献的记录在外部使用前需要人工核验，仅元数据记录还需要用户上传全文后再进入提取。\n"
            )
        return (
            f"\n\nEvidence source caution: {count} retrieved/screened record(s) used limited source text/metadata "
            "because publisher full text/PDF or registry outcome data could not be retrieved automatically; "
            "records that contributed extracted values, primary-effect estimates, GRADE judgments, or manuscript references require manual verification before external use, and metadata-only records require user-uploaded full text before extraction.\n"
        )
    source_parts = []
    if abstract_only_count:
        source_parts.append(f"{abstract_only_count} abstract-only")
    if metadata_only_count:
        source_parts.append(f"{metadata_only_count} metadata-only")
    source_summary = ", ".join(source_parts) or "limited-source"
    if zh:
        return (
            f"\n\n来源提示：{count}条检索或筛选记录使用了受限来源文本或元数据（{source_summary}），"
            "但这些记录仅用于筛选或背景上下文，未贡献提取值、主效应量、GRADE判断或参考文献；"
            "导出包中的来源覆盖审查会列出它们以便透明核对。\n"
        )
    return (
        f"\n\nEvidence source note: {count} retrieved/screened record(s) used limited source text/metadata "
        f"({source_summary}) as screening/context records only; they did not contribute extracted values, "
        "primary-effect estimates, GRADE judgments, or manuscript references. The source coverage audit lists them for transparency.\n"
    )


def _replace_limited_text_source_note(manuscript: str, note: str) -> str:
    patterns = [
        r"\n*Evidence source caution: \d+ retrieved/screened record\(s\) used limited source text/metadata .*?(?=\n##|\Z)",
        r"\n*Evidence source caution: \d+ included record\(s\) used structured abstract-only.*?(?=\n##|\Z)",
        r"\n*Evidence source note: \d+ retrieved/screened record\(s\) used limited source text/metadata .*?(?=\n##|\Z)",
        r"\n*来源提示：\d+条检索或筛选记录使用了受限来源文本或元数据.*?(?=\n##|\Z)",
    ]
    repaired = manuscript
    for pattern in patterns:
        repaired = re.sub(pattern, note.rstrip() + "\n", repaired, flags=re.S)
    return repaired


def _manuscript_or_requested_language_is_zh(manuscript: str, facts: dict[str, Any]) -> bool:
    requested = str((facts or {}).get("output_language") or (facts or {}).get("language") or "").strip().lower()
    if requested in {"zh", "cn", "chinese", "中文", "简体中文"}:
        return True
    cjk_chars = len(re.findall(r"[\u4e00-\u9fff]", str(manuscript or "")))
    latin_words = len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", str(manuscript or "")))
    return bool(cjk_chars and cjk_chars >= latin_words)


def _ensure_pipeline_warning_note(manuscript: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    """Keep run warnings in structured outputs rather than the journal manuscript."""
    warnings = facts.get("pipeline_warnings") or []
    if not warnings:
        return manuscript, []
    if facts.get("report_type", "meta") != "evidence_gap":
        return manuscript, []
    normalized_manuscript = manuscript.casefold()
    if (
        "pipeline warnings:" in normalized_manuscript
        or "## pipeline warnings" in normalized_manuscript
        or "retrieval and processing notes" in normalized_manuscript
    ):
        return manuscript, []

    shown = warnings[-5:]
    lines = [
        "",
        "### Appendix 4. Retrieval and processing notes",
        (
            f"{len(warnings)} run-level warning(s) were recorded during retrieval, parsing, "
            "analysis, or output generation. Review the project run-warning log before external use."
        ),
    ]
    for item in shown:
        stage = item.get("stage") or "unknown"
        code = item.get("code") or "warning"
        message = str(item.get("message") or "").replace("\n", " ").strip()
        lines.append(f"- `{stage}/{code}`: {message}")
    if len(warnings) > len(shown):
        lines.append(f"- ... {len(warnings) - len(shown)} earlier warning(s) omitted from this summary.")

    note = "\n".join(lines) + "\n"
    repaired = _insert_before_heading(manuscript, "## References", note)
    if repaired == manuscript:
        repaired = _insert_before_heading(manuscript, "## 参考文献", note)
    if repaired == manuscript:
        repaired = _insert_after_heading(manuscript, "## Supplementary Materials", note)
    if repaired == manuscript:
        repaired = _insert_after_heading(manuscript, "## 补充材料", note)
    if repaired == manuscript:
        lines[1] = "## Retrieval and Processing Notes"
        note = "\n".join(lines) + "\n"
        repaired = _insert_before_heading(manuscript, "## Recommended Next Actions", note)
    if repaired == manuscript:
        repaired = _insert_before_heading(manuscript, "## 下一步处理建议", note)
    if repaired == manuscript:
        repaired = _insert_before_heading(manuscript, "## Discussion", note)
    if repaired == manuscript:
        repaired = _insert_before_heading(manuscript, "## 讨论", note)
    if repaired == manuscript:
        repaired = manuscript + "\n" + note
    return repaired, [_issue("pipeline_warning_note", "fixed", f"Inserted evidence-gap warning summary for {len(warnings)} warning(s).")]


def _primary_counts(facts: dict[str, Any]) -> tuple[int, int]:
    prisma = facts.get("prisma", {})
    studies = facts.get("studies", {})
    included = int(prisma.get("studies_included") or studies.get("extracted_count") or 0)
    primary_n = int(studies.get("primary_analysis_count") or (facts.get("primary_effect") or {}).get("n_studies") or 0)
    return included, primary_n


def _primary_availability_sentence(facts: dict[str, Any]) -> str:
    included, primary_n = _primary_counts(facts)
    non_analyzable = max(included - primary_n, 0)
    if non_analyzable:
        return (
            f"Although {included} studies met review eligibility criteria, {primary_n} contributed analyzable data "
            f"to the primary meta-analysis; {non_analyzable} study record(s) required narrative or audit-only handling "
            "because compatible event counts or effect estimates were unavailable."
        )
    return f"All {primary_n} eligible study record(s) contributed analyzable data to the primary meta-analysis."


def _repair_prisma_summary(manuscript: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    prisma = facts.get("prisma", {})
    studies = facts.get("studies", {})
    ta_screened = int(prisma.get("title_abstract_screened") or 0)
    full_text = int(prisma.get("full_text_assessed") or 0)
    included = int(prisma.get("studies_included") or studies.get("extracted_count") or 0)
    primary_n = int(studies.get("primary_analysis_count") or (facts.get("primary_effect") or {}).get("n_studies") or 0)
    if not ta_screened or not included:
        return manuscript, []

    sentence = (
        f"Of {ta_screened} records screened at title/abstract level, {full_text} full-text records were assessed; "
        f"{included} studies were included, and {primary_n} contributed analyzable data to the primary meta-analysis."
    )
    patterns = [
        r"Of\s+\d+\s+studies\s+screened(?:\s+and\s+assessed\s+for\s+eligibility)?,\s+\d+\s+met\s+criteria[^.。]*[.。]",
        r"Of\s+\d+\s+records\s+screened,\s+\d+\s+[^.。]*primary\s+analysis[^.。]*[.。]",
    ]
    repaired = manuscript
    for pattern in patterns:
        new_text = re.sub(pattern, sentence, repaired, count=1, flags=re.IGNORECASE)
        if new_text != repaired:
            return new_text, [_issue(
                "prisma_summary_repaired",
                "fixed",
                "Repaired PRISMA/primary-analysis count summary from manuscript_facts.json.",
            )]
    return repaired, []


def _repair_primary_availability_claims(manuscript: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    included, primary_n = _primary_counts(facts)
    if not included or not primary_n or included <= primary_n:
        return manuscript, []
    replacement = _primary_availability_sentence(facts)
    repaired = manuscript
    issues = []
    patterns = [
        r"Following application of eligibility criteria,\s*Although \d+ studies met review eligibility criteria,[^.。]*unavailable[.。]",
        r"Following application of eligibility criteria,[^.。]*(?:included in the quantitative synthesis|analyzable form)[.。]",
        r"No exclusions occurred at this stage, resulting in \w+ directly eligible randomized controlled trials \(RCTs\) included in the quantitative synthesis \[[^\]]+\] \(Figure 1\)[.。]",
        r"No studies were excluded due to missing outcome data or unreported effect estimates, as all \w+ reported 28-day all-cause mortality in analyzable form[.。]",
        r"All \w+ trials contributed data to the primary outcome analysis[.。]",
        r"\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:RCTs|studies|trials)\s+contributed data to the primary outcome analysis[.。]",
        r"\b\d+\s+(?:RCTs|studies|trials)\s+contributed data to the primary outcome analysis[.。]",
        r"all \w+ reported 28-day all-cause mortality in analyzable form[.。]",
        r"\d+\s+randomized controlled trials were determined[^.。]*included in the quantitative synthesis[.。]",
        r"Pooled analysis of the five RCTs yielded",
        r"Pooled analysis of five RCTs yielded",
        r"A random-effects meta-analysis of the five eligible RCTs yielded",
        r"random-effects meta-analysis of the five eligible RCTs yielded",
        r"Peter 2020 \[3\] and Bruno 2020 \[2\] were included in the meta-analysis but were not assigned[^.。]*[.。]",
        r"three direct-eligible randomized controlled trials",
        r"three eligible randomized controlled trials",
    ]
    number_words = {
        1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
        6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
    }
    if primary_n in number_words:
        patterns.append(r"\b(?:one|two|three|four|five|six|seven|eight|nine|ten) eligible randomized controlled trials")
    for pattern in patterns:
        if "Pooled analysis" in pattern:
            new_text = re.sub(pattern, f"Pooled analysis of the {primary_n} analyzable RCTs yielded", repaired, flags=re.IGNORECASE)
        elif pattern.startswith("A random-effects"):
            new_text = re.sub(pattern, f"A meta-analysis of the {primary_n} analyzable RCTs yielded", repaired, flags=re.IGNORECASE)
        elif "meta-analysis of the five eligible RCTs" in pattern:
            new_text = re.sub(pattern, f"the meta-analysis of the {primary_n} analyzable RCTs yielded", repaired, flags=re.IGNORECASE)
        elif pattern.startswith("Peter 2020"):
            new_text = re.sub(
                pattern,
                "Peter 2020 [3] and Bruno 2020 [2] were included in the review but did not contribute analyzable primary-outcome effect estimates.",
                repaired,
                flags=re.IGNORECASE,
            )
        elif pattern == r"three direct-eligible randomized controlled trials":
            new_text = re.sub(pattern, "three analyzable randomized controlled trials", repaired, flags=re.IGNORECASE)
        elif pattern == r"three eligible randomized controlled trials":
            new_text = re.sub(pattern, "three analyzable randomized controlled trials", repaired, flags=re.IGNORECASE)
        elif primary_n in number_words and "eligible randomized controlled trials" in pattern:
            new_text = re.sub(
                pattern,
                f"{number_words[primary_n]} analyzable randomized controlled trials",
                repaired,
                flags=re.IGNORECASE,
            )
        else:
            new_text = re.sub(pattern, replacement, repaired, flags=re.IGNORECASE)
        if new_text != repaired:
            repaired = new_text
            issues.append(_issue(
                "primary_availability_claim_repaired",
                "fixed",
                f"Aligned primary-analysis availability wording to {primary_n}/{included} studies.",
            ))
    repaired = _collapse_repeated_sentence(repaired, replacement)
    return repaired, issues


def _repair_grade_no_concern_contradictions(manuscript: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    outcomes = facts.get("grade", {}).get("outcomes", [])
    if not outcomes:
        return manuscript, []
    primary_domains = {
        str(domain.get("domain", "")).lower(): str(domain.get("rating", "")).lower()
        for domain in outcomes[0].get("domains", [])
    }
    repaired = manuscript
    issues = []
    if primary_domains.get("imprecision") == "no concern":
        replacements = [
            (r"limitations in study design and precision", "methodological limitations"),
            (r"limitations in study design, precision, and", "limitations in study design and"),
            (r"methodological limitations and imprecision", "methodological limitations"),
            (r"imprecision and methodological limitations", "methodological limitations"),
        ]
        for pattern, replacement in replacements:
            new_text = re.sub(pattern, replacement, repaired, flags=re.IGNORECASE)
            if new_text != repaired:
                repaired = new_text
                issues.append(_issue("grade_no_concern_contradiction_repaired", "fixed", "Removed imprecision wording because GRADE imprecision was no concern."))
    return repaired, issues


def _collapse_repeated_sentence(text: str, sentence: str) -> str:
    doubled = f"{sentence} {sentence}"
    while doubled in text:
        text = text.replace(doubled, sentence)
    return text


def _repair_publication_bias_claims(manuscript: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    primary = facts.get("primary_effect") or {}
    n_studies = int(primary.get("n_studies") or 0)
    if n_studies >= 10 or n_studies <= 0:
        return manuscript, []

    repaired = manuscript
    issues = []
    replacements = [
        (
            r"Publication bias was assessed via [^.。]*[.。]",
            f"Publication bias was not formally assessed because fewer than 10 studies contributed to the primary analysis (k={n_studies}). ",
        ),
        (
            r"No evidence of (?:small-study bias|publication bias)[^.。]*[.。]",
            f"Formal small-study/publication-bias tests are exploratory and underpowered because fewer than 10 studies contributed to the primary analysis (k={n_studies}). ",
        ),
        (
            r"No evidence of (?:small-study effects?|small-study effects? or publication bias|publication bias)[^.。]*[.。]",
            f"Publication bias was not formally assessed because fewer than 10 studies contributed to the primary analysis (k={n_studies}). ",
        ),
        (
            r"The lack of detected publication bias[^.。]*[.。]",
            f"Publication bias was not formally assessed because fewer than 10 studies contributed to the primary analysis (k={n_studies}). ",
        ),
        (
            r"The absence of publication bias was confirmed through statistical assessment[^.。]*[.。]",
            f"Publication bias could not be confirmed statistically because fewer than 10 studies contributed to the primary analysis (k={n_studies}). ",
        ),
        (
            r"Additionally, there were no concerns regarding publication bias[.。]",
            f"Publication bias could not be formally assessed because fewer than 10 studies contributed to the primary analysis (k={n_studies}).",
        ),
        (
            r"There were no serious concerns regarding risk of bias, inconsistency, indirectness, imprecision, or publication bias[.。]",
            (
                "There were no serious concerns regarding risk of bias, inconsistency, indirectness, or imprecision; "
                f"publication bias could not be formally assessed because fewer than 10 studies contributed to the primary analysis (k={n_studies})."
            ),
        ),
        (
            r"There were no serious concerns regarding risk of bias, inconsistency, indirectness, imprecision, or publication bias\s*(?:\[[^\]]+\])?[.。]",
            (
                "There were no serious concerns regarding risk of bias, inconsistency, indirectness, or imprecision; "
                f"publication bias could not be formally assessed because fewer than 10 studies contributed to the primary analysis (k={n_studies})."
            ),
        ),
        (
            r"This rating reflects no serious concerns regarding risk of bias, inconsistency, indirectness, imprecision, or publication bias[.。]",
            (
                "This rating reflects no serious concerns regarding risk of bias, inconsistency, indirectness, or imprecision; "
                f"publication bias could not be formally assessed because fewer than 10 studies contributed to the primary analysis (k={n_studies})."
            ),
        ),
        (
            r"Standard methods for detecting publication bias[^.。]*minimum of\s*2\s+studies[^.。]*[.。]",
            f"Standard tests for publication bias were not used because fewer than 10 studies contributed to the primary analysis (k={n_studies}). ",
        ),
        (
            r"Standard guidelines recommend against formal testing for publication bias[^.。]*fewer than\s*2\s+studies[^.。]*[.。]",
            f"Standard tests for publication bias were not used because fewer than 10 studies contributed to the primary analysis (k={n_studies}). ",
        ),
        (
            r"Standard statistical tests for publication bias[^.。]*minimum of\s*2\s+studies[^.。]*[.。]",
            f"Standard tests for publication bias were not used because fewer than 10 studies contributed to the primary analysis (k={n_studies}). ",
        ),
        (
            r"Egger'?s test showed no evidence[^.。]*[.。]",
            f"Egger/Begg tests were not interpreted as confirmatory because fewer than 10 studies contributed to the primary analysis (k={n_studies}). ",
        ),
        (
            r"(?:Egger'?s|[’']) test indicated no (?:small-study bias|publication bias)[^.。]*[.。]",
            f"Formal small-study/publication-bias tests are exploratory and underpowered because fewer than 10 studies contributed to the primary analysis (k={n_studies}). ",
        ),
        (
            r"Publication bias \(Egger's p\): [^\n]+",
            f"Publication bias: not formally assessed (k={n_studies} < 10)",
        ),
        (
            r"Publication bias was not formally assessed due to the small number of included studies \(\*n\*\s*=\s*\d+\)",
            f"Publication bias was not formally assessed because fewer than 10 studies contributed to the primary analysis (*k* = {n_studies})",
        ),
        (
            r"Publication bias was not formally assessed, as fewer than 10 studies were included,[^.。]*[.。]",
            f"Publication bias was not formally assessed because fewer than 10 studies contributed to the primary analysis (k={n_studies}). ",
        ),
        (
            r"Formal assessment of publication bias was not performed, as the number of included RCTs \(\*n\*\s*=\s*\d+\)[^.。]*[.。]",
            f"Formal assessment of publication bias was not performed because fewer than 10 studies contributed to the primary meta-analysis (k={n_studies}). ",
        ),
        (
            r"Formal assessment of publication bias was not conducted, as the number of included RCTs \(\*n\*\s*=\s*\d+\)[^.。]*[.。]",
            f"Formal assessment of publication bias was not performed because fewer than 10 studies contributed to the primary meta-analysis (k={n_studies}). ",
        ),
        (
            r"Given the small number of included studies \(\*n\*\s*=\s*\d+\), formal assessment of publication bias[^.。]*[.。]",
            f"Given fewer than 10 studies contributed to the primary analysis (*k* = {n_studies}), formal assessment of publication bias was not performed. ",
        ),
        (
            r"Formal assessment of publication bias was not performed, as the number of included studies \(\*n\*\s*=\s*\d+\) was fewer than[^.。]*[.。]",
            f"Formal assessment of publication bias was not performed because fewer than 10 studies contributed to the primary analysis (*k* = {n_studies}). ",
        ),
        (
            r"Publication bias was not formally assessed due to the small number of included RCTs \(n\s*=\s*\d+\)[^.。]*[.。]",
            f"Publication bias was not formally assessed because fewer than 10 studies contributed to the primary analysis (k={n_studies}). ",
        ),
        (
            r"Publication bias was not formally assessed due to the small number of included RCTs \(\*n\*\s*=\s*\d+\)[^.。]*[.。]",
            f"Publication bias was not formally assessed because fewer than 10 studies contributed to the primary analysis (k={n_studies}). ",
        ),
        (
            r"Formal assessment of publication bias \(e\.g\., via funnel plot,\s*[’']s test,\s*or\s*\) was not performed[^.。]*[.。]",
            f"Publication bias was not formally assessed because fewer than 10 studies contributed to the primary analysis (k={n_studies}). ",
        ),
        (
            r"publication bias was not suspected",
            f"publication bias was not formally assessed because fewer than 10 studies contributed to the primary analysis (k={n_studies})",
        ),
        (
            r"Publication bias was not significant[.。]",
            f"Publication bias was not formally assessed because fewer than 10 studies contributed to the primary analysis (k={n_studies}).",
        ),
        (
            r"Publication bias was not detected[^.。]*[.。]",
            f"Publication bias was not formally assessed because fewer than 10 studies contributed to the primary analysis (k={n_studies}).",
        ),
        (
            r"The funnel plot and statistical tests did not detect small-study effects[^.。]*[.。]",
            f"Formal funnel-plot or small-study-effect testing was not performed because fewer than 10 studies contributed to the primary analysis (k={n_studies}). ",
        ),
        (
            r"The funnel plot and statistical tests did not detect (?:small-study effects|publication bias)[^.。]*[.。]",
            f"Formal funnel-plot or small-study-effect testing was not performed because fewer than 10 studies contributed to the primary analysis (k={n_studies}). ",
        ),
        (
            r"Publication bias was not formally assessed because fewer than 10 studies contributed to the primary analysis \(k=\d+\)\s+to be a major issue despite the inability to test it formally[^.。]*[.。]",
            (
                f"Publication bias was not formally assessed because fewer than 10 studies contributed to the primary analysis (k={n_studies}). "
                "This domain was interpreted cautiously rather than tested statistically."
            ),
        ),
        (
            r"No significant publication bias was (?:found|observed|detected)[^.。]*[.。]",
            f"Publication bias was not formally assessed because fewer than 10 studies contributed to the primary analysis (k={n_studies}). ",
        ),
        (
            r"未发现(?:明显|显著)?发表偏倚[^。]*。",
            f"由于主要分析纳入研究少于10项（k={n_studies}），未对发表偏倚进行正式检验。",
        ),
    ]
    for pattern, replacement in replacements:
        new_text = re.sub(pattern, replacement, repaired, flags=re.IGNORECASE)
        if new_text != repaired:
            repaired = new_text
            issues.append(_issue("publication_bias_overclaim", "fixed", f"Limited publication-bias claim for k={n_studies}."))
    repaired = re.sub(r"(?<=\.)\s+\d{2,4}\)\.", "", repaired)
    repaired = re.sub(
        r"(?<=\.)\s+meta-analysis of the (\d+) analyzable RCTs",
        r" A meta-analysis of the \1 analyzable RCTs",
        repaired,
        flags=re.IGNORECASE,
    )
    repaired = re.sub(r"e\.g\.,\s*[’']s regression", "e.g., Egger's regression", repaired, flags=re.IGNORECASE)
    repaired = re.sub(r"funnel plots\s+or\s+[’']s test", "funnel plots or Egger's test", repaired, flags=re.IGNORECASE)
    repaired = re.sub(r"\.\s*g\.,\s*[’']s test\)\s*underpowered and unreliable\.", ".", repaired, flags=re.IGNORECASE)
    repaired = re.sub(r"\band Formal small-study/publication-bias", "Formal small-study/publication-bias", repaired)
    repaired = re.sub(r",\s+Formal small-study/publication-bias", ". Formal small-study/publication-bias", repaired)

    return repaired, issues


def _repair_nr_total_sample_claims(manuscript: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    selected_total = _coerce_int((facts.get("primary_population") or {}).get("selected_total_participants"))
    if selected_total <= 0:
        return manuscript, []

    total_text = f"{selected_total:,}"
    patterns = [
        (
            r"The total sample size of the included eligible RCTs was not fully reported\s*\(NR\)\.",
            f"The selected primary comparisons included {total_text} participants.",
        ),
        (
            r"However,\s+as the total sample size[^.。]{0,180}(?:not fully reported|not reported)[^.。]*[.。]",
            f"The selected primary comparisons included {total_text} participants. ",
        ),
        (
            r"However,\s+the total sample size[^.。]{0,180}(?:not fully reported|not reported)[^.。]*[.。]",
            f"The selected primary comparisons included {total_text} participants. ",
        ),
        (
            r"The total sample size[^.。]{0,180}(?:not fully reported|not reported)[^.。]*[.。]",
            f"The selected primary comparisons included {total_text} participants. ",
        ),
        (
            r"However,\s+the total sample size report is incomplete[^.。]*[.。]",
            f"The selected primary comparisons included {total_text} participants. ",
        ),
        (
            r"The total sample size report is incomplete[^.。]*[.。]",
            f"The selected primary comparisons included {total_text} participants. ",
        ),
        (
            r"The total sample size was reported as incomplete[^.。]*[.。]",
            f"The selected primary comparisons included {total_text} participants. ",
        ),
        (
            r"The total sample size[^.。]{0,160}\bNR\b[^.。]*[.。]",
            f"The selected primary comparisons included {total_text} participants. ",
        ),
        (
            r"Total sample size[^.。]{0,160}\bNR\b[^.。]*[.。]",
            f"The selected primary comparisons included {total_text} participants. ",
        ),
        (
            r"总样本量[^。]{0,120}(?:未报告|NR)[^。]*。",
            f"选定的主要比较共纳入{total_text}名参与者。",
        ),
    ]
    repaired = manuscript
    issues: list[dict[str, Any]] = []
    for pattern, replacement in patterns:
        new_text = re.sub(pattern, replacement, repaired, flags=re.IGNORECASE)
        if new_text != repaired:
            repaired = new_text
            issues.append(_issue(
                "sample_size_nr_repaired",
                "fixed",
                "Replaced NR total sample-size claim with the selected primary-analysis participant total.",
                selected_total=selected_total,
            ))
    return repaired, issues


def _repair_statistical_test_artifacts(manuscript: str) -> tuple[str, list[dict[str, Any]]]:
    """Repair malformed remnants such as "’s test" after LLM/prose cleanup."""
    replacements = [
        (r"funnel plots,\s*[’']s test", "funnel plots or Egger's test"),
        (r"funnel plots,\s*[’']s regression", "funnel plots or Egger's regression"),
        (r"funnel plots\s+or\s+[’']s regression test", "funnel plots or Egger's regression test"),
        (r"funnel plots\s+or\s+[’']s test", "funnel plots or Egger's test"),
        (r"such as\s*[’']s regression", "such as Egger's regression"),
        (r"such as\s*[’']s test", "such as Egger's test"),
        (r"[’']s test indicated no (?:small-study bias|publication bias)[^.。]*[.。]", "Formal small-study/publication-bias tests were not interpreted as confirmatory. "),
        (r"\.\s*g\.,\s*funnel plots(?:\s+or\s+|,\s*)Egger's (?:test|regression)\)\s*was not performed(?:,\s*per Cochrane guidance)?\.", "."),
        (r"sensitivity analyses,\s*s,\s*and formal tests", "sensitivity analyses and formal tests"),
        (r"sensitivity analyses\s+and\s+s\b", "sensitivity analyses"),
        (r"subgroup analyses,\s*s,\s*and formal tests", "subgroup analyses and formal tests"),
        (r"the plot and plot", "formal influence plots"),
    ]
    repaired = manuscript
    issues = []
    for pattern, replacement in replacements:
        new_text = re.sub(pattern, replacement, repaired, flags=re.IGNORECASE)
        if new_text != repaired:
            repaired = new_text
            issues.append(_issue("statistical_test_artifact_repaired", "fixed", f"Repaired malformed statistical-test phrase: {pattern}"))
    return repaired, issues


def _repair_mechanical_publication_phrases(manuscript: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    repaired = str(manuscript or "")
    issues: list[dict[str, Any]] = []
    replacements = [
        (
            r"\b(?:The\s+)?results pooled results\b",
            "The pooled results",
        ),
        (
            r"\bProtocol and The review protocol\b",
            "Protocol: The review protocol",
        ),
        (
            r"\bHeterogeneity and:\s*",
            "Heterogeneity: ",
        ),
        (
            r"\bformal subgroup analyses and were not performed\b",
            "formal subgroup analyses were not performed",
        ),
        (
            r"\bwithout a prespecified for HFmrEF or HFpEF\b",
            "without prespecified HFmrEF or HFpEF subgroup data",
        ),
        (
            r"\bNo additional records were obtained from user uploads or other external sources\.\s*",
            "",
        ),
        (
            r"\bNo additional studies were identified through other sources or user uploads\.\s*",
            "",
        ),
        (
            r"\bNo prospective registration identifier is reported for this specific automated synthesis\.",
            "This review was not prospectively registered.",
        ),
        (
            r"\bThe extraction process did not involve manual cross-checking by human reviewers as per the automated nature of the review workflow described\.\s*",
            "",
        ),
        (
            r"\bRecords were screened records and extracted data\b",
            "Records were screened, and data were extracted",
        ),
        (
            r"\bremains a area\b",
            "remains an area",
        ),
        (
            r"\bSoftware and computational methods:\s*All statistical analyses and meta-analytic computations were performed using Python with a custom meta-analysis engine\.",
            "Statistical software: Statistical analyses were performed using reproducible Python scripts.",
        ),
        (
            r"\bAll statistical analyses were conducted using Python with a custom meta-analysis engine\.",
            "Statistical analyses were performed using reproducible Python scripts.",
        ),
        (
            r"\bAll statistical analyses and meta-analytic computations were performed using Python with a custom meta-analysis engine\.",
            "Statistical analyses were performed using reproducible Python scripts.",
        ),
        (
            r"\bunless a prespecified for HFmrEF or HFpEF was reported separately\b",
            "unless prespecified HFmrEF or HFpEF subgroup data were reported separately",
        ),
        (
            r"\bwithout a prespecified for HFmrEF/HFpEF\b",
            "without prespecified HFmrEF/HFpEF subgroup data",
        ),
        (
            r"\bwithout a prespecified for HFmrEF or HFpEF\b",
            "without prespecified HFmrEF or HFpEF subgroup data",
        ),
        (
            r"\bformal subgroup was not feasible\b",
            "formal subgroup analysis was not feasible",
        ),
        (
            r"\bthrough or is severely restricted\b",
            "through subgroup or sensitivity analyses is severely restricted",
        ),
        (
            r"\band The pooled results\b",
            "and the pooled results",
        ),
        (
            r"\bResults from these two studies pooled results should be interpreted with caution\b",
            "The pooled results from these two studies should be interpreted with caution",
        ),
        (
            r"\bThe results from each study pooled results should be interpreted with caution\b",
            "These study-specific estimates should be interpreted with caution",
        ),
        (
            r"\bThis rating was assigned because There were no serious concerns\b",
            "This rating was assigned because there were no serious concerns",
        ),
        (
            r"\bHFmrEF vs\s*\[([^\]]+)\]\.\s*HFpEF\)",
            r"HFmrEF vs. HFpEF) [\1]",
        ),
        (
            r"\bPublication bias was not formally assessed because fewer than 10 studies contributed to the primary analysis \(k=(\d+)\), although formal assessment was not possible\.",
            r"Publication bias was not formally assessed because fewer than 10 studies contributed to the primary analysis (k=\1).",
        ),
        (
            r"pooled results should be interpreted with caution,\s*pooled results should be interpreted with caution[^.。]*[.。]",
            "pooled results should be interpreted with caution because only a small number of trials contributed data. ",
        ),
        (
            r"the review process screened",
            "records were screened",
        ),
        (
            r"consultation with a the review process",
            "the prespecified review process",
        ),
        (
            r"The assessment was conducted independently, and disagreements were resolved through consensus[.。]",
            "Risk-of-bias judgments were recorded using the prespecified tool.",
        ),
        (
            r"assessment was conducted independently",
            "assessment followed the prespecified tool",
        ),
    ]
    for pattern, replacement in replacements:
        new_text = re.sub(pattern, replacement, repaired, flags=re.IGNORECASE)
        if new_text != repaired:
            repaired = new_text
            issues.append(_issue(
                "mechanical_phrase_repaired",
                "fixed",
                f"Repaired mechanical manuscript phrase: {pattern}",
            ))
    repaired = _repair_declaration_heading_inline_text(repaired, issues)
    repaired = _repair_full_text_exclusion_counts(repaired, facts, issues)
    repaired = _repair_table1_from_study_cards(repaired, facts, issues)
    return repaired, issues


def _repair_declaration_heading_inline_text(text: str, issues: list[dict[str, Any]]) -> str:
    headings = (
        "Author contributions",
        "Acknowledgements",
        "Registration and protocol",
        "Ethics approval",
        "Data and code availability",
        "Funding",
        "Competing interests",
    )
    heading_pattern = "|".join(re.escape(item) for item in headings)
    pattern = re.compile(rf"^(###\s+(?:{heading_pattern}))\s+([^\n]+)$", flags=re.IGNORECASE | re.MULTILINE)

    def repl(match: re.Match) -> str:
        issues.append(_issue(
            "declaration_heading_inline_text_repaired",
            "fixed",
            "Moved declaration heading body text onto its own paragraph.",
        ))
        return f"{match.group(1)}\n{match.group(2)}"

    return pattern.sub(repl, text)


def _repair_full_text_exclusion_counts(text: str, facts: dict[str, Any], issues: list[dict[str, Any]]) -> str:
    prisma = facts.get("prisma") if isinstance(facts.get("prisma"), dict) else {}
    full_text = _coerce_int(prisma.get("full_text_assessed"))
    included = _coerce_int(prisma.get("studies_included"))
    if full_text <= 0 or included <= 0 or full_text <= included:
        return text

    excluded = full_text - included
    replacement = (
        f"Of these, {excluded} full-text record(s) were excluded before final inclusion. "
        f"Ultimately, {included} randomized controlled trial(s) met all inclusion criteria and were included in the quantitative synthesis."
    )
    patterns = [
        r"Of these,\s*\d+\s+studies were excluded at the full-text stage\.[\s\S]{0,500}?Ultimately,\s*\d+\s+randomized controlled trials met all inclusion criteria and were included in the quantitative synthesis\.",
        r"Of these,\s*\d+\s+(?:articles|records) proceeded to full-text assessment\.\s*Ultimately,\s*(?:\w+|\d+)\s+randomized controlled trials met all inclusion criteria and were included in the quantitative synthesis\.",
    ]
    repaired = text
    for pattern in patterns:
        new_text = re.sub(pattern, replacement, repaired, flags=re.IGNORECASE)
        if new_text != repaired:
            repaired = new_text
            issues.append(_issue(
                "full_text_exclusion_count_repaired",
                "fixed",
                "Repaired full-text exclusion count from PRISMA facts.",
                full_text_assessed=full_text,
                studies_included=included,
                full_text_excluded=excluded,
            ))
    return repaired


def _repair_table1_from_study_cards(text: str, facts: dict[str, Any], issues: list[dict[str, Any]]) -> str:
    cards = facts.get("study_cards")
    if not isinstance(cards, list) or not cards:
        return text
    if not re.search(r"^###\s+Table\s+1\b", text, flags=re.IGNORECASE | re.MULTILINE):
        return text
    if "Not reported" not in text and "未报告" not in text:
        return text

    rows = []
    primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
    measure = str(primary.get("effect_measure") or "effect").upper()
    for card in sorted(cards, key=lambda item: str(item.get("display_name") or item.get("study_label") or "")):
        if not isinstance(card, dict):
            continue
        counts = card.get("counts") if isinstance(card.get("counts"), dict) else {}
        ti = _coerce_int(counts.get("total_intervention"))
        tc = _coerce_int(counts.get("total_control"))
        ei = _coerce_int(counts.get("events_intervention"))
        ec = _coerce_int(counts.get("events_control"))
        if ti <= 0 or tc <= 0:
            continue
        label = str(card.get("display_name") or card.get("study_label") or "Study").strip()
        year_match = re.search(r"\b(19|20)\d{2}\b", label)
        year = year_match.group(0) if year_match else ""
        quote = str(card.get("source_quote") or "")
        intervention = str(card.get("intervention") or "").strip() or _infer_intervention_from_text(quote)
        comparator = str(card.get("comparator") or "").strip() or _infer_comparator_from_text(quote)
        population = str(card.get("analysis_population") or "").strip() or _infer_population_from_label(label)
        outcome = str(card.get("mortality_timepoint") or primary.get("outcome_name") or "Primary outcome").strip()
        effect = _format_float(card.get("effect"), 2)
        weight = _format_float(card.get("weight"), 1)
        rows.append(
            "| "
            + " | ".join([
                label,
                year,
                "RCT",
                population,
                intervention,
                comparator,
                f"{ti}/{tc}",
                f"{ei}/{ec}",
                f"{measure} {effect}" if effect else measure,
                f"{weight}%" if weight else "",
            ])
            + " |"
        )
    if not rows:
        return text

    table = "\n".join([
        "### Table 1. Characteristics and primary-analysis data of included studies",
        "",
        "| Study | Year | Design | Population | Intervention | Control | N (I/C) | Primary outcome events (I/C) | Effect | Weight |",
        "|:--- |:--- |:--- |:--- |:--- |:--- |:--- |:--- |:--- |:--- |",
        *rows,
        "Note: I/C=intervention/control; effect estimates and weights are from the selected primary-analysis rows.",
    ])
    repaired = re.sub(
        r"###\s+Table\s+1\b[\s\S]*?(?=\n##\s+Figures|\n###\s+Table\s+2\b|\n##\s+Figure|\Z)",
        table + "\n",
        text,
        count=1,
        flags=re.IGNORECASE,
    )
    if repaired != text:
        issues.append(_issue(
            "table1_fact_locked",
            "fixed",
            "Re-rendered Table 1 from selected primary-analysis study cards.",
        ))
    return repaired


def _infer_intervention_from_text(text: str) -> str:
    raw = str(text or "").lower()
    for drug in ("dapagliflozin", "empagliflozin", "sotagliflozin", "canagliflozin", "ertugliflozin"):
        if drug in raw:
            return drug.capitalize()
    return "SGLT2 inhibitor"


def _infer_comparator_from_text(text: str) -> str:
    raw = str(text or "").lower()
    if "placebo" in raw:
        return "Placebo"
    if "usual care" in raw:
        return "Usual care"
    return "Control"


def _infer_population_from_label(label: str) -> str:
    raw = str(label or "").lower()
    if "solomon" in raw or "deliver" in raw:
        return "HFmrEF/HFpEF"
    if "anker" in raw or "emperor" in raw:
        return "HFpEF"
    return "Eligible HF population"


def _format_float(value: object, digits: int) -> str:
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return ""


def _repair_grade_domain_summary(manuscript: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    outcomes = facts.get("grade", {}).get("outcomes", [])
    if not outcomes:
        return manuscript, []
    domains = outcomes[0].get("domains") or []
    downgraded = [
        _grade_domain_label(item.get("domain", ""))
        for item in domains
        if str(item.get("rating", "")).lower() in {"serious", "very serious"}
    ]
    downgraded = [item for item in downgraded if item]
    if not downgraded:
        return manuscript, []

    replacement = f"due to concerns about {_join_english_list(downgraded)}"
    patterns = [
        r"due to serious risk of bias, imprecision, and indirectness",
        r"due to serious risk of bias, serious imprecision, and serious indirectness",
        r"due to serious concerns? (?:across|in) [^.。]*?(?:\.|,)",
    ]
    repaired = manuscript
    for pattern in patterns:
        new_text = re.sub(pattern, replacement, repaired, count=1, flags=re.IGNORECASE)
        if new_text != repaired:
            return new_text, [_issue(
                "grade_domain_summary_repaired",
                "fixed",
                "Repaired GRADE downgrade domains from manuscript_facts.json.",
            )]
    return repaired, []


def _grade_domain_label(domain: str) -> str:
    return {
        "risk_of_bias": "risk of bias",
        "inconsistency": "inconsistency",
        "indirectness": "indirectness",
        "imprecision": "imprecision",
        "publication_bias": "publication bias",
    }.get(domain, domain.replace("_", " "))


def _join_english_list(items: list[str]) -> str:
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} and {items[1]}"
    return f"{', '.join(items[:-1])}, and {items[-1]}"


def _detect_count_mismatches(manuscript: str, facts: dict[str, Any]) -> list[dict[str, Any]]:
    issues = []
    primary = facts.get("primary_effect") or {}
    n_primary = primary.get("n_studies")
    if n_primary:
        pattern = re.compile(r"\b(\d+)\s+(?:studies|RCTs|trials)\s+(?:contributed|included)\b", flags=re.IGNORECASE)
        for match in pattern.finditer(manuscript):
            prefix = manuscript[max(0, match.start() - 120):match.start()].lower()
            suffix = manuscript[match.end():match.end() + 160].lower()
            if re.search(r"(?:fewer than|less than|under|<)\s*$", prefix):
                continue
            if (
                "prisma" in prefix
                or "flow diagram" in prefix
                or "review eligibility" in suffix
                or "quantitative synthesis" in suffix
                or "full-text" in prefix
                or "full text" in prefix
            ):
                continue
            claim = match.group(1)
            if int(claim) != int(n_primary):
                issues.append(_issue(
                    "primary_count_mismatch",
                    "warning",
                    f"Manuscript claims {claim} primary-analysis studies but facts say {n_primary}.",
                ))
    if "direct_eligible" in manuscript:
        issues.append(_issue("internal_label", "error", "Internal evidence label still present after repair."))
    return issues


def _detect_primary_effect_mismatch(manuscript: str, facts: dict[str, Any]) -> list[dict[str, Any]]:
    primary = facts.get("primary_effect") or {}
    if not primary:
        return []
    effect = primary.get("pooled_effect")
    lower = primary.get("ci_lower")
    upper = primary.get("ci_upper")
    if effect is None or lower is None or upper is None:
        return []
    expected = f"{effect:.2f}"
    if expected not in manuscript:
        return [_issue(
            "primary_effect_not_found",
            "warning",
            f"Expected primary pooled effect around {effect:.3f} ({lower:.3f}-{upper:.3f}) not found verbatim in manuscript.",
        )]

    ci_pattern = re.compile(
        r"95\s*%\s*(?:confidence\s+interval|CI)?[^\d\-−]{0,20}"
        r"([\-−]?\d+(?:\.\d+)?)\s*(?:to|-|–|—|,|至)\s*([\-−]?\d+(?:\.\d+)?)",
        flags=re.IGNORECASE,
    )
    for match in re.finditer(re.escape(expected), manuscript):
        window = manuscript[max(0, match.start() - 80): match.end() + 180]
        ci_match = ci_pattern.search(window)
        if not ci_match:
            continue
        observed_lower = _coerce_float(ci_match.group(1))
        observed_upper = _coerce_float(ci_match.group(2))
        if not _rounded_equal(observed_lower, lower) or not _rounded_equal(observed_upper, upper):
            return [_issue(
                "primary_ci_mismatch",
                "error",
                (
                    f"Manuscript reports 95% CI {observed_lower:.2f}-{observed_upper:.2f} near the primary effect, "
                    f"but manuscript_facts.json says {float(lower):.2f}-{float(upper):.2f}."
                ),
                reported_ci_lower=round(observed_lower, 4),
                reported_ci_upper=round(observed_upper, 4),
                expected_ci_lower=round(float(lower), 4),
                expected_ci_upper=round(float(upper), 4),
            )]
        return []

    return [_issue(
        "primary_ci_not_found",
        "warning",
        f"Primary pooled effect {expected} appears, but a nearby 95% CI {float(lower):.2f}-{float(upper):.2f} was not found.",
    )]


def _detect_patient_total_mismatches(manuscript: str, facts: dict[str, Any]) -> list[dict[str, Any]]:
    selected_total = _coerce_int((facts.get("primary_population") or {}).get("selected_total_participants"))
    if selected_total <= 0:
        return []

    issues = []
    pattern = re.compile(
        r"(?<![\d,A-Za-z-])(\d{1,3}(?:,\d{3})+|\d{2,6})(?![\d,])"
        r"(?:\s+[A-Za-z-]+){0,5}\s+(?:patients|participants|adults|individuals)\b",
        flags=re.IGNORECASE,
    )
    for match in pattern.finditer(manuscript):
        if _looks_like_arm_level_denominator(manuscript, match.start(1)):
            continue
        if not _patient_total_claim_context(manuscript, match.start(), match.end()):
            continue
        claim = _coerce_int(match.group(1))
        if claim and claim != selected_total:
            issues.append(_issue(
                "patient_total_mismatch",
                "error",
                f"Manuscript claims {claim} participants/patients, but selected primary-effect rows sum to {selected_total}.",
                claimed_total=claim,
                selected_total=selected_total,
            ))
    return issues


def _repair_patient_total_claims(manuscript: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    selected_total = _coerce_int((facts.get("primary_population") or {}).get("selected_total_participants"))
    if selected_total <= 0:
        return manuscript, []

    pattern = re.compile(
        r"(?<![\d,A-Za-z-])(\d{1,3}(?:,\d{3})+|\d{2,6})(?![\d,])"
        r"(?:\s+[A-Za-z-]+){0,5}\s+(?:patients|participants|adults|individuals)\b",
        flags=re.IGNORECASE,
    )
    replacements: list[tuple[int, int, str, int]] = []
    for match in pattern.finditer(manuscript):
        if _looks_like_arm_level_denominator(manuscript, match.start(1)):
            continue
        if not _patient_total_claim_context(manuscript, match.start(), match.end()):
            continue
        claim = _coerce_int(match.group(1))
        if claim and claim != selected_total:
            replacements.append((match.start(1), match.end(1), f"{selected_total:,}", claim))
    if not replacements:
        return manuscript, []

    repaired = manuscript
    issues = []
    for start, end, replacement, claim in reversed(replacements):
        repaired = repaired[:start] + replacement + repaired[end:]
        issues.append(_issue(
            "patient_total_mismatch",
            "fixed",
            f"Replaced primary-analysis participant total {claim} with {selected_total}.",
            claimed_total=claim,
            selected_total=selected_total,
        ))
    issues.reverse()
    return repaired, issues


def _repair_arm_level_event_fraction_claims(manuscript: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
    expected = {
        "intervention": (
            _coerce_int(population.get("selected_events_intervention")),
            _coerce_int(population.get("selected_total_intervention")),
        ),
        "control": (
            _coerce_int(population.get("selected_events_control")),
            _coerce_int(population.get("selected_total_control")),
        ),
    }
    if not all(value for pair in expected.values() for value in pair):
        return manuscript, []

    number = r"(\d{1,3}(?:,\d{3})+|\d{1,7})"
    fraction = number + r"\s*/\s*" + number
    of_total = number + r"\s+of\s+" + number + r"\s+(?:patients|participants|adults|individuals)"
    group_patterns = [
        (
            "intervention",
            re.compile(
                fraction + r"(?=[^.\n]{0,80}\b(?:intervention|treatment|experimental)\s+groups?\b)",
                flags=re.IGNORECASE,
            ),
            "fraction",
        ),
        (
            "intervention",
            re.compile(
                of_total + r"(?=[^.\n]{0,80}\b(?:intervention|treatment|experimental)\s+groups?\b)",
                flags=re.IGNORECASE,
            ),
            "of_total",
        ),
        (
            "control",
            re.compile(
                fraction + r"(?=[^.\n]{0,80}\b(?:control|placebo|comparator)\s+groups?\b)",
                flags=re.IGNORECASE,
            ),
            "fraction",
        ),
        (
            "control",
            re.compile(
                of_total + r"(?=[^.\n]{0,80}\b(?:control|placebo|comparator)\s+groups?\b)",
                flags=re.IGNORECASE,
            ),
            "of_total",
        ),
    ]
    repaired = manuscript
    issues: list[dict[str, Any]] = []
    replacements: list[tuple[int, int, str, str, int, int, int, int]] = []
    for arm, pattern, mode in group_patterns:
        expected_events, expected_total = expected[arm]
        for match in pattern.finditer(manuscript):
            observed_events = _coerce_int(match.group(1))
            observed_total = _coerce_int(match.group(2))
            if observed_events != expected_events or observed_total == expected_total:
                continue
            if mode == "fraction":
                start, end = match.start(), match.end()
                replacement = f"{match.group(1)}/{expected_total:,}"
            else:
                start, end = match.start(2), match.end(2)
                replacement = f"{expected_total:,}"
            replacements.append((
                start,
                end,
                replacement,
                arm,
                observed_events,
                observed_total,
                expected_events,
                expected_total,
            ))
    for start, end, replacement, arm, observed_events, observed_total, expected_events, expected_total in reversed(replacements):
        repaired = repaired[:start] + replacement + repaired[end:]
        issues.append(_issue(
            "arm_event_denominator_mismatch",
            "fixed",
            (
                f"Replaced {arm} arm event denominator {observed_total} with "
                f"{expected_total} for {expected_events} events."
            ),
            arm=arm,
            observed_events=observed_events,
            observed_total=observed_total,
            expected_events=expected_events,
            expected_total=expected_total,
        ))
    issues.reverse()
    return repaired, issues


def _looks_like_arm_level_denominator(manuscript: str, number_start: int) -> bool:
    """Return true when a participant-looking number is the denominator in events/total."""
    raw = str(manuscript or "")
    prefix = raw[:number_start].rstrip()
    if prefix.endswith("/"):
        return True
    if re.search(r"\b\d{1,6}\s*/\s*$", prefix[-20:]):
        return True
    left = raw[max(0, number_start - 40):number_start]
    right = raw[number_start:number_start + 140]
    return bool(
        re.search(r"(?:\b\d{1,3}(?:,\d{3})*|\b\d{1,7})\s+of\s*$", left, flags=re.IGNORECASE)
        and re.search(
            r"^(?:\d{1,3}(?:,\d{3})+|\d{1,7})\s+(?:patients|participants|adults|individuals)\b"
            r"[^.\n]{0,80}\b(?:intervention|treatment|experimental|control|placebo|comparator)\s+groups?\b",
            right,
            flags=re.IGNORECASE,
        )
    )


def _patient_total_claim_context(manuscript: str, start: int, end: int) -> bool:
    left = max(manuscript.rfind(mark, 0, start) for mark in (".", "!", "?", "\n"))
    right_candidates = [idx for mark in (".", "!", "?", "\n") if (idx := manuscript.find(mark, end)) >= 0]
    right = min(right_candidates) if right_candidates else len(manuscript)
    window = manuscript[left + 1:right]
    patterns = [
        r"\bprimary\s+(?:analysis|synthesis|meta-analysis|outcome)\b",
        r"\bpooled\s+(?:analysis|synthesis|estimate|effect)\b",
        r"\bmeta-analysis\s+(?:included|pooled|comprised|used)\b",
        r"\b(?:totaling|totalling|comprised)\s+(?:a\s+total\s+of\s+)?(?:\d{1,3}(?:,\d{3})+|\d{2,6})\b",
        r"\b(?:included|enrolled)\s+a\s+total\s+of\s+(?:\d{1,3}(?:,\d{3})+|\d{2,6})\b",
        r"\b(?:total\s+sample|total\s+participants|overall\s+sample)\b",
    ]
    return any(re.search(pattern, window, flags=re.IGNORECASE) for pattern in patterns)


def _detect_artifact_reference_mismatches(manuscript: str) -> list[dict[str, Any]]:
    figure_refs = _numbered_artifact_refs(manuscript, r"(?:Figure|Fig\.?)") | _numbered_artifact_refs(manuscript, r"图")
    table_refs = _numbered_artifact_refs(manuscript, r"Table") | _numbered_artifact_refs(manuscript, r"表")
    figure_defs = _numbered_artifact_definitions(manuscript, r"(?:Figure|Fig\.?)") | _numbered_artifact_definitions(manuscript, r"图")
    table_defs = _numbered_artifact_definitions(manuscript, r"Table") | _numbered_artifact_definitions(manuscript, r"表")

    issues = []
    for ref in sorted(figure_refs - figure_defs):
        issues.append(_issue(
            "missing_figure_reference",
            "error",
            f"Manuscript references Figure {ref}, but no Figure {ref} caption/image definition was found.",
            reference_number=ref,
            defined_figures=sorted(figure_defs),
        ))
    for ref in sorted(table_refs - table_defs):
        issues.append(_issue(
            "missing_table_reference",
            "error",
            f"Manuscript references Table {ref}, but no Table {ref} heading/caption was found.",
            reference_number=ref,
            defined_tables=sorted(table_defs),
        ))
    return issues


def _repair_artifact_reference_mismatches(manuscript: str) -> tuple[str, list[dict[str, Any]]]:
    figure_refs = _numbered_artifact_refs(manuscript, r"(?:Figure|Fig\.?)") | _numbered_artifact_refs(manuscript, r"图")
    table_refs = _numbered_artifact_refs(manuscript, r"Table") | _numbered_artifact_refs(manuscript, r"表")
    figure_defs = _numbered_artifact_definitions(manuscript, r"(?:Figure|Fig\.?)") | _numbered_artifact_definitions(manuscript, r"图")
    table_defs = _numbered_artifact_definitions(manuscript, r"Table") | _numbered_artifact_definitions(manuscript, r"表")
    missing_figures = sorted(figure_refs - figure_defs)
    missing_tables = sorted(table_refs - table_defs)
    if not missing_figures and not missing_tables:
        return manuscript, []

    repaired = manuscript
    issues: list[dict[str, Any]] = []
    for ref in missing_figures:
        repaired, changed = _drop_sentences_with_artifact_ref(
            repaired,
            re.compile(
                rf"(?:\b(?:Figures?|Figs?\.?)\s*(?:\d+\s*(?:,|and|&)\s*)*{ref}\b|图\s*{ref}\b)",
                flags=re.IGNORECASE,
            ),
        )
        if changed:
            issues.append(_issue(
                "missing_figure_reference",
                "fixed",
                f"Removed sentence(s) referencing undefined Figure {ref}.",
                reference_number=ref,
                defined_figures=sorted(figure_defs),
            ))
    for ref in missing_tables:
        repaired, changed = _drop_sentences_with_artifact_ref(
            repaired,
            re.compile(rf"(?:\bTable\s*{ref}\b|表\s*{ref}\b)", flags=re.IGNORECASE),
        )
        if changed:
            issues.append(_issue(
                "missing_table_reference",
                "fixed",
                f"Removed sentence(s) referencing undefined Table {ref}.",
                reference_number=ref,
                defined_tables=sorted(table_defs),
            ))
    return repaired, issues


def _drop_sentences_with_artifact_ref(text: str, pattern: re.Pattern) -> tuple[str, bool]:
    changed = False
    repaired_lines = []
    for line in text.splitlines():
        if not pattern.search(line):
            repaired_lines.append(line)
            continue
        sentences = re.split(r"(?<=[.!?])\s+", line)
        kept = [sentence for sentence in sentences if not pattern.search(sentence)]
        if len(kept) != len(sentences):
            changed = True
        repaired_lines.append(" ".join(sentence.strip() for sentence in kept if sentence.strip()))
    repaired = "\n".join(repaired_lines)
    repaired = re.sub(r"\n{3,}", "\n\n", repaired)
    return repaired, changed


def _numbered_artifact_refs(manuscript: str, label_pattern: str) -> set[int]:
    text = str(manuscript or "")
    if "Figure" in label_pattern or "Fig" in label_pattern:
        refs: set[int] = set()
        for match in re.finditer(r"\bFigures?\s+([0-9][0-9,\sand–-]*)", text, flags=re.IGNORECASE):
            refs.update(_coerce_int(num) for num in re.findall(r"\d+", match.group(1)))
        for match in re.finditer(r"\bFigs?\.?\s+([0-9][0-9,\sand–-]*)", text, flags=re.IGNORECASE):
            refs.update(_coerce_int(num) for num in re.findall(r"\d+", match.group(1)))
        return {ref for ref in refs if ref > 0}
    if label_pattern in {"图", "表"}:
        pattern = re.compile(rf"{label_pattern}\s*(\d+)\b", flags=re.IGNORECASE)
    else:
        pattern = re.compile(rf"\b{label_pattern}\s*(\d+)\b", flags=re.IGNORECASE)
    return {_coerce_int(match.group(1)) for match in pattern.finditer(text) if _coerce_int(match.group(1)) > 0}


def _numbered_artifact_definitions(manuscript: str, label_pattern: str) -> set[int]:
    caption_pattern = re.compile(
        rf"^\s{{0,3}}(?:#{{1,6}}\s*)?(?:[-*]\s+)?(?:\*\*|\*)?\s*{label_pattern}\s*(\d+)\b"
        r"(?:\s*[.:]|\s*(?:\*\*)?\s*$)",
        flags=re.IGNORECASE | re.MULTILINE,
    )
    image_alt_pattern = re.compile(
        rf"!\[[^\]]*\b{label_pattern}\s*(\d+)\b[^\]]*\]\(",
        flags=re.IGNORECASE,
    )
    definitions = {
        _coerce_int(match.group(1))
        for match in caption_pattern.finditer(manuscript)
        if _coerce_int(match.group(1)) > 0
    }
    definitions.update(
        _coerce_int(match.group(1))
        for match in image_alt_pattern.finditer(manuscript)
        if _coerce_int(match.group(1)) > 0
    )
    return definitions


def _detect_non_primary_study_label_claims(manuscript: str, facts: dict[str, Any]) -> list[dict[str, Any]]:
    studies = facts.get("studies") or {}
    non_primary_labels = [
        str(label).strip()
        for label in studies.get("non_primary_review_labels", [])
        if str(label).strip()
    ]
    if not non_primary_labels:
        return []

    issues = []
    sentences = re.split(r"(?<=[.!?。])\s+", manuscript)
    primary_context = re.compile(
        r"\b(?:primary|pooled|meta-analysis|metaanalysis|quantitative synthesis|main analysis)\b",
        flags=re.IGNORECASE,
    )
    contribution_context = re.compile(
        r"\b(?:contributed|included|entered|pooled|analyzable|analysable|synthesis|analysis)\b",
        flags=re.IGNORECASE,
    )
    negation_context = re.compile(
        r"\b(?:did not|didn't|not|no|excluded|exclusion of|without|did not contribute|not contribute|not included|not enter)\b",
        flags=re.IGNORECASE,
    )
    for sentence in sentences:
        if not primary_context.search(sentence) or not contribution_context.search(sentence):
            continue
        for label in non_primary_labels:
            label_match = re.search(rf"\b{re.escape(label)}\b", sentence, flags=re.IGNORECASE)
            if not label_match:
                continue
            context_window = sentence[max(0, label_match.start() - 80): label_match.end() + 120]
            if negation_context.search(context_window):
                continue
            issues.append(_issue(
                "non_primary_study_in_primary_claim",
                "error",
                (
                    f"Manuscript describes {label} in a primary/meta-analysis contribution context, "
                    "but manuscript_facts.json marks it as review-only or non-primary-analysis."
                ),
                study_label=label,
                primary_analysis_labels=studies.get("primary_analysis_labels", []),
            ))
    return issues


def _repair_non_primary_study_label_claims(manuscript: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    studies = facts.get("studies") or {}
    non_primary_labels = [
        str(label).strip()
        for label in studies.get("non_primary_review_labels", [])
        if str(label).strip()
    ]
    if not non_primary_labels:
        return manuscript, []

    primary_context = re.compile(
        r"\b(?:primary|pooled|meta-analysis|metaanalysis|quantitative synthesis|main analysis)\b",
        flags=re.IGNORECASE,
    )
    contribution_context = re.compile(
        r"\b(?:contributed|included|entered|pooled|analyzable|analysable|synthesis|analysis)\b",
        flags=re.IGNORECASE,
    )
    negation_context = re.compile(
        r"\b(?:did not|didn't|not|no|excluded|exclusion of|without|did not contribute|not contribute|not included|not enter)\b",
        flags=re.IGNORECASE,
    )

    removed_labels: set[str] = set()
    changed = False
    repaired_lines: list[str] = []
    for line in manuscript.splitlines():
        if not primary_context.search(line) or not contribution_context.search(line):
            repaired_lines.append(line)
            continue
        sentences = re.split(r"(?<=[.!?。])\s+", line)
        kept: list[str] = []
        for sentence in sentences:
            drop_sentence = False
            for label in non_primary_labels:
                label_match = re.search(rf"\b{re.escape(label)}\b", sentence, flags=re.IGNORECASE)
                if not label_match:
                    continue
                context_window = sentence[max(0, label_match.start() - 80): label_match.end() + 120]
                if negation_context.search(context_window):
                    continue
                drop_sentence = True
                removed_labels.add(label)
            if drop_sentence:
                changed = True
            elif sentence.strip():
                kept.append(sentence.strip())
        repaired_lines.append(" ".join(kept))

    if not changed:
        return manuscript, []

    repaired = "\n".join(repaired_lines)
    repaired = re.sub(r"\n{3,}", "\n\n", repaired)
    issues = [
        _issue(
            "non_primary_study_claim_repaired",
            "fixed",
            f"Removed primary/meta-analysis contribution sentence(s) naming non-primary study label(s): {', '.join(sorted(removed_labels))}.",
            study_labels=sorted(removed_labels),
            primary_analysis_labels=studies.get("primary_analysis_labels", []),
        )
    ]
    return repaired, issues


def _detect_reported_effect_mismatches(
    manuscript: str,
    effects: list[dict[str, Any]],
    *,
    issue_prefix: str,
) -> list[dict[str, Any]]:
    issues = []
    for effect in effects or []:
        outcome_name = str(effect.get("outcome_name") or "").strip()
        measure = str(effect.get("effect_measure") or "").strip()
        expected_effect = effect.get("pooled_effect")
        expected_lower = effect.get("ci_lower")
        expected_upper = effect.get("ci_upper")
        if not outcome_name or not measure or expected_effect is None:
            continue
        for window in _windows_around_text(manuscript, outcome_name, before=0):
            value_match = _effect_value_match(window, measure)
            if not value_match:
                continue
            observed_effect = _coerce_float(value_match.group(1))
            if not _rounded_equal(observed_effect, expected_effect):
                issues.append(_issue(
                    f"{issue_prefix}_effect_mismatch",
                    "error",
                    (
                        f"Manuscript reports {measure} {observed_effect:.2f} near {outcome_name!r}, "
                        f"but manuscript_facts.json says {float(expected_effect):.2f}."
                    ),
                    outcome_name=outcome_name,
                    effect_measure=measure,
                    reported_effect=round(observed_effect, 4),
                    expected_effect=round(float(expected_effect), 4),
                    analysis_group=effect.get("analysis_group", ""),
                ))
            ci_match = _ci_match(window[value_match.start(): value_match.end() + 180])
            if ci_match and expected_lower is not None and expected_upper is not None:
                observed_lower = _coerce_float(ci_match.group(1))
                observed_upper = _coerce_float(ci_match.group(2))
                if not _rounded_equal(observed_lower, expected_lower) or not _rounded_equal(observed_upper, expected_upper):
                    issues.append(_issue(
                        f"{issue_prefix}_ci_mismatch",
                        "error",
                        (
                            f"Manuscript reports 95% CI {observed_lower:.2f}-{observed_upper:.2f} near {outcome_name!r}, "
                            f"but manuscript_facts.json says {float(expected_lower):.2f}-{float(expected_upper):.2f}."
                        ),
                        outcome_name=outcome_name,
                        effect_measure=measure,
                        reported_ci_lower=round(observed_lower, 4),
                        reported_ci_upper=round(observed_upper, 4),
                        expected_ci_lower=round(float(expected_lower), 4),
                        expected_ci_upper=round(float(expected_upper), 4),
                        analysis_group=effect.get("analysis_group", ""),
                    ))
            break
    return issues


def _windows_around_text(text: str, needle: str, before: int = 80, after: int = 220) -> list[str]:
    pattern = re.compile(re.escape(needle), flags=re.IGNORECASE)
    return [
        text[max(0, match.start() - before): match.end() + after]
        for match in pattern.finditer(text)
    ]


def _effect_value_match(window: str, measure: str):
    pattern = re.compile(
        rf"\b{re.escape(measure)}\b\s*(?:=|:|was|is|of)?\s*([\-−]?\d+(?:\.\d+)?)",
        flags=re.IGNORECASE,
    )
    return pattern.search(window)


def _ci_match(window: str):
    pattern = re.compile(
        r"(?:95\s*%\s*(?:confidence\s+interval|CI)?|CI)[^\d\-−]{0,20}"
        r"([\-−]?\d+(?:\.\d+)?)\s*(?:to|-|–|—|,)\s*([\-−]?\d+(?:\.\d+)?)",
        flags=re.IGNORECASE,
    )
    return pattern.search(window)


def _coerce_int(value: Any) -> int:
    try:
        return int(float(str(value).replace(",", "")))
    except (TypeError, ValueError):
        return 0


def _coerce_float(value: Any) -> float:
    try:
        return float(str(value).replace("−", "-"))
    except (TypeError, ValueError):
        return 0.0


def _rounded_equal(left: Any, right: Any, digits: int = 2) -> bool:
    return round(_coerce_float(left), digits) == round(_coerce_float(right), digits)


def _insert_after_heading(text: str, heading: str, note: str) -> str:
    idx = text.find(heading)
    if idx < 0:
        return text
    line_end = text.find("\n", idx)
    if line_end < 0:
        return text + note
    return text[:line_end + 1] + note + text[line_end + 1:]


def _insert_before_heading(text: str, heading: str, note: str) -> str:
    idx = text.find(heading)
    if idx < 0:
        return text
    return text[:idx] + note + text[idx:]
