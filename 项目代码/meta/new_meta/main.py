"""MetaAgent — One-click meta-analysis manuscript generation.

Usage:
    python -m new_meta.main --topic "Your research question here"
    python -m new_meta.main --topic "Effect of GLP-1RA on body weight in obese adults" --output-dir ./output
    python -m new_meta.main --topic "NMA of smoking cessation" --analysis-type network
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import logging
import os
import re
import sys
from pathlib import Path

from new_meta.config import (
    LANGUAGETOOL_TIMEOUT_SECONDS,
    LANGUAGETOOL_URL,
    LLM_API_KEY,
    MANUSCRIPT_POLISH_ENABLED,
    MANUSCRIPT_POLISH_MAX_LLM_CHUNKS,
    MANUSCRIPT_POLISH_PROOFREADER,
    MANUSCRIPT_POLISH_REWRITE_SCOPE,
    MANUSCRIPT_POLISH_USE_LLM,
    OUTPUT_DIR,
    LARGE_RESULT_WARNING,
    LOW_SEARCH_RESULTS,
    LOW_SCREENING_RESULTS,
)
from new_meta.core.artifact_package import create_artifact_package
from new_meta.core.evidence_gap_delivery import complete_zero_record_review
from new_meta.core.known_source_recovery import (
    augment_with_known_source_evidence,
    known_source_reference_manifest,
    known_source_protocol_preferences,
)
from new_meta.core.evidence_gate import (
    EvidenceGate,
    GateDecision,
    GateResult,
    build_report_state,
    outcome_matches as _outcome_matches,
)
from new_meta.core.protocol_overrides import apply_protocol_override
from new_meta.core.llm import LLMClient, write_llm_usage_manifest
from new_meta.core.grade_inputs import (
    build_grade_input_snapshot,
    cached_grade_snapshot_matches,
    repair_grade_profile_with_snapshot,
    save_grade_input_snapshot,
)
from new_meta.core.manuscript_polish import audit_manuscript_style, polish_manuscript_text, preservation_guard_issues
from new_meta.core.manuscript_facts import validate_and_repair_manuscript
from new_meta.core.manuscript_text_metrics import remove_near_duplicate_sentences
from new_meta.core.pdf_intake import PDF_PARSE_CACHE_VERSION, parse_file_with_cache
from new_meta.core.model_selection import build_model_decision_and_sensitivity
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.rct_design_reconciliation import reconcile_extracted_rct_designs
from new_meta.core.positioning import ensure_review_positioning
from new_meta.core.proofreading import LanguageToolProofreader
from new_meta.core.project import Project
from new_meta.core.run_mode import RunMode, configure_project_run_mode, normalize_run_mode
from new_meta.core.provenance import (
    BENCHMARK_ALLOWED_TIERS,
    PRIMARY_ALLOWED_TIERS,
    annotate_source_provenance,
)
from new_meta.agents.research_planner import ResearchPlanner
from new_meta.agents.query_builder import QueryBuilder
from new_meta.agents.paper_retriever import PaperRetriever
from new_meta.agents.pdf_parser import parse_pdf, parse_text_fulltext
from new_meta.agents.screening_agent import ScreeningAgent
from new_meta.agents.data_extraction_agent import DataExtractionAgent
from new_meta.agents.evidence_understanding_agent import EvidenceUnderstandingAgent
from new_meta.agents.rob_agent import RoBAgent
from new_meta.agents.writing_agent import WritingAgent
from new_meta.agents.grade_agent import GRADEAgent
from new_meta.engines import effect_size as es_engine
from new_meta.engines import meta_engine
from new_meta.engines import publication_bias
from new_meta.engines import visualization
from new_meta.engines.nma import NMAEngine
from new_meta.engines import influence as influence_engine
from new_meta.schemas.meta_result import StudyEffect, MetaAnalysisResults, PublicationBiasResult
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.schemas.study import ExtractedStudy
from new_meta.schemas.risk_of_bias import StudyRoB
from new_meta.schemas.grade import GRADEProfile
from new_meta.tools.reference_manager import ReferenceManager
from new_meta.tools.evimed_evidence import search_evimed_evidence
from new_meta.tools import pubmed
from new_meta.tools.utils import paper_identity, safe_identifier
from new_meta.tools.utils import study_label as _study_label


logger = logging.getLogger("metaagent.main")
EVIMED_CONTEXT_CACHE_VERSION = 6
METHODOLOGY_CONTEXT_CACHE_VERSION = 1
EVIDENCE_CONTEXT_TARGET_REFERENCES = 12
PUBMED_BACKGROUND_FALLBACK_MAX_RESULTS = 30

METHODOLOGY_REFERENCES = [
    {
        "study_id": "methodology:prisma_2020",
        "source_type": "reporting_guideline",
        "title": "The PRISMA 2020 statement: an updated guideline for reporting systematic reviews",
        "paper": {
            "title": "The PRISMA 2020 statement: an updated guideline for reporting systematic reviews",
            "authors": ["Page MJ", "McKenzie JE", "Bossuyt PM", "Boutron I", "Hoffmann TC", "Mulrow CD"],
            "journal": "BMJ",
            "year": "2021",
            "volume": "372",
            "pages": "n71",
            "doi": "10.1136/bmj.n71",
            "source": "methodology",
        },
    },
    {
        "study_id": "methodology:prisma_search",
        "source_type": "reporting_guideline",
        "title": "PRISMA-S: an extension to the PRISMA Statement for Reporting Literature Searches in Systematic Reviews",
        "paper": {
            "title": "PRISMA-S: an extension to the PRISMA Statement for Reporting Literature Searches in Systematic Reviews",
            "authors": ["Rethlefsen ML", "Kirtley S", "Waffenschmidt S", "Ayala AP", "Moher D", "Page MJ"],
            "journal": "Systematic Reviews",
            "year": "2021",
            "volume": "10",
            "pages": "39",
            "doi": "10.1186/s13643-020-01542-z",
            "source": "methodology",
        },
    },
    {
        "study_id": "methodology:cochrane_handbook",
        "source_type": "methods_handbook",
        "title": "Cochrane Handbook for Systematic Reviews of Interventions",
        "paper": {
            "title": "Cochrane Handbook for Systematic Reviews of Interventions",
            "authors": ["Higgins JPT", "Thomas J", "Chandler J", "Cumpston M", "Li T", "Page MJ"],
            "journal": "Cochrane",
            "year": "2023",
            "url": "https://training.cochrane.org/handbook",
            "source": "methodology",
        },
    },
    {
        "study_id": "methodology:rob2",
        "source_type": "risk_of_bias_tool",
        "title": "RoB 2: A revised Cochrane risk-of-bias tool for randomized trials",
        "paper": {
            "title": "RoB 2: A revised Cochrane risk-of-bias tool for randomized trials",
            "authors": ["Sterne JAC", "Savovic J", "Page MJ", "Elbers RG", "Blencowe NS", "Boutron I"],
            "journal": "BMJ",
            "year": "2019",
            "volume": "366",
            "pages": "l4898",
            "doi": "10.1136/bmj.l4898",
            "source": "methodology",
        },
    },
    {
        "study_id": "methodology:grade_handbook",
        "source_type": "certainty_framework",
        "title": "GRADE guidelines: a new series of articles in the Journal of Clinical Epidemiology",
        "paper": {
            "title": "GRADE guidelines: a new series of articles in the Journal of Clinical Epidemiology",
            "authors": ["Guyatt GH", "Oxman AD", "Vist GE", "Kunz R", "Falck-Ytter Y", "Alonso-Coello P"],
            "journal": "Journal of Clinical Epidemiology",
            "year": "2011",
            "volume": "64",
            "issue": "4",
            "pages": "380-382",
            "doi": "10.1016/j.jclinepi.2010.09.011",
            "source": "methodology",
        },
    },
    {
        "study_id": "methodology:dersimonian_laird",
        "source_type": "statistical_method",
        "title": "DerSimonian-Laird random-effects method: Meta-analysis in clinical trials",
        "paper": {
            "title": "Meta-analysis in clinical trials",
            "authors": ["DerSimonian R", "Laird N"],
            "journal": "Controlled Clinical Trials",
            "year": "1986",
            "volume": "7",
            "issue": "3",
            "pages": "177-188",
            "doi": "10.1016/0197-2456(86)90046-2",
            "source": "methodology",
        },
    },
    {
        "study_id": "methodology:heterogeneity_i2",
        "source_type": "statistical_method",
        "title": "Measuring inconsistency in meta-analyses",
        "paper": {
            "title": "Measuring inconsistency in meta-analyses",
            "authors": ["Higgins JPT", "Thompson SG", "Deeks JJ", "Altman DG"],
            "journal": "BMJ",
            "year": "2003",
            "volume": "327",
            "issue": "7414",
            "pages": "557-560",
            "doi": "10.1136/bmj.327.7414.557",
            "source": "methodology",
        },
    },
    {
        "study_id": "methodology:egger_bias",
        "source_type": "publication_bias_method",
        "title": "Bias in meta-analysis detected by a simple, graphical test",
        "paper": {
            "title": "Bias in meta-analysis detected by a simple, graphical test",
            "authors": ["Egger M", "Davey Smith G", "Schneider M", "Minder C"],
            "journal": "BMJ",
            "year": "1997",
            "volume": "315",
            "issue": "7109",
            "pages": "629-634",
            "doi": "10.1136/bmj.315.7109.629",
            "source": "methodology",
        },
    },
]

SGLT2_TEXT_PATTERN = (
    r"\b(?:sglt2|sglt-2|gliflozin|empagliflozin|dapagliflozin|canagliflozin|"
    r"ertugliflozin|sotagliflozin)\b|"
    r"\bsodium[- ]glucose\s+(?:co-?transporter|cotransporter)[- ]?2\b|"
    r"\bsodium[- ]glucose\s+(?:co-?transporter|cotransporter)[- ]two\b"
)


def _detect_output_language_from_text(text: str | None) -> str:
    content = str(text or "")
    if not content:
        return "en"
    cjk_chars = sum(1 for ch in content if "\u4e00" <= ch <= "\u9fff")
    return "zh" if cjk_chars > len(content) * 0.15 else "en"


def _normalize_output_language(value: object) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None

    lowered = raw.lower().replace("_", "-")
    if raw in {"中文", "汉语", "简体中文", "繁体中文"} or re.fullmatch(
        r"(zh|zh-(?:cn|hans|hant)|cn|chinese)",
        lowered,
    ):
        return "zh"
    if raw in {"英文", "英语"} or re.fullmatch(r"(en|en-[a-z]+|english)", lowered):
        return "en"
    raise ValueError(
        f"Unsupported output language: {raw}. Use 'zh'/'中文' or 'en'/'English'."
    )


def _resolve_output_language(args, fallback_text: str | None = None) -> str:
    for attr in ("output_language", "language", "lang"):
        if not hasattr(args, attr):
            continue
        normalized = _normalize_output_language(getattr(args, attr))
        if normalized:
            return normalized
    source_text = fallback_text if fallback_text is not None else getattr(args, "topic", "")
    return _detect_output_language_from_text(source_text)


def _format_pet_peese_summary(pub_bias: PublicationBiasResult, effect_measure: str) -> str | None:
    """Format PET-PEESE for CLI output without hiding the analysis scale."""
    if pub_bias.pet_intercept is None or pub_bias.pet_p_value is None:
        return None

    measure = str(effect_measure or "").upper()
    pet_estimate = float(pub_bias.pet_intercept)
    pet_p = float(pub_bias.pet_p_value)
    if meta_engine._is_log_measure(measure):
        original = meta_engine._to_original(pet_estimate, measure)
        return (
            f"  PET-PEESE adjusted {measure}: {original:.3f} "
            f"(log {measure}={pet_estimate:.4f}; PET p={pet_p:.4f})"
        )
    return f"  PET-PEESE adjusted {measure}: {pet_estimate:.4f} (PET p={pet_p:.4f})"


def _prefer_display_author_order(characteristics) -> bool:
    source_format = " ".join([
        getattr(characteristics, "source_type", "") or "",
        getattr(characteristics, "metadata_source", "") or "",
    ]).lower()
    return "pubmed" not in source_format


def _display_study_label(characteristics) -> str:
    return _study_label(
        getattr(characteristics, "authors", []) or [],
        getattr(characteristics, "year", 0) or 0,
        prefer_display_order=_prefer_display_author_order(characteristics),
    )


def _subgroup_is_pooled_intervention_contrast(subgroup: str) -> bool:
    """Accept labels that combine intervention arms against a common control arm."""
    sg = subgroup.strip().lower()
    if not sg:
        return False
    patient_markers = (
        "invasive mechanical ventilation",
        "mechanical ventilation",
        "oxygen",
        "no oxygen",
        "older",
        "younger",
        "male",
        "female",
        "diabetes",
        "renal",
        "kidney",
        "subgroup of patients",
        "among patients",
        "among those",
    )
    if any(marker in sg for marker in patient_markers):
        return False
    pooled_markers = ("pooled", "combined", "all corticosteroid", "all treatment")
    contrast_markers = (" vs ", " versus ", " compared with ", " compared to ", " no ", " control", " usual care", " placebo", " standard care")
    return any(marker in sg for marker in pooled_markers) and any(marker in sg for marker in contrast_markers)


def _protocol_requires_critical_care(protocol: ResearchProtocol) -> bool:
    population = (getattr(getattr(protocol, "pico", None), "population", "") or "").lower()
    critical_terms = (
        "critical", "critically ill", "icu", "intensive care", "mechanical ventilation",
        "mechanically ventilated", "vasopressor", "ecmo", "ards",
    )
    return any(term in population for term in critical_terms)


def _study_population_confirms_critical_care(study) -> bool:
    c = getattr(study, "characteristics", None)
    text = " ".join(
        str(getattr(c, attr, "") or "").lower()
        for attr in ("title", "population_description", "intervention_description", "control_description")
    )
    critical_terms = (
        "critically ill", "critical illness", "icu", "intensive care",
        "mechanical ventilation", "mechanically ventilated", "vasopressor",
        "ecmo", "ards",
    )
    return any(term in text for term in critical_terms)


def _study_population_appears_broader_than_protocol(study, protocol: ResearchProtocol) -> bool:
    if not _protocol_requires_critical_care(protocol):
        return False
    c = getattr(study, "characteristics", None)
    text = " ".join(
        str(getattr(c, attr, "") or "").lower()
        for attr in ("title", "population_description")
    )
    broad_terms = ("hospitalized", "hospitalised", "hospitalized patients", "hospitalised patients", "severe covid")
    if any(term in text for term in broad_terms):
        return True
    return not _study_population_confirms_critical_care(study)


def _outcome_is_protocol_population_subgroup(outcome, study, protocol: ResearchProtocol) -> bool:
    """Allow patient subgroups only when they are needed to satisfy the protocol population."""
    if not _study_population_appears_broader_than_protocol(study, protocol):
        return False
    subgroup_text = str(getattr(outcome, "subgroup", "") or "").lower()
    critical_markers = (
        "invasive mechanical ventilation", "mechanically ventilated", "mechanical ventilation",
        "icu", "intensive care", "vasopressor", "ecmo", "ards",
    )
    text = " ".join(
        str(getattr(outcome, attr, "") or "").lower()
        for attr in ("subgroup", "outcome_name", "source_quote", "source_section", "source_location")
    )
    exclusion_markers = (
        "not receiving invasive", "without invasive", "oxygen only", "no oxygen",
        "no respiratory support", "non-invasive only",
    )
    if subgroup_text and any(marker in subgroup_text for marker in critical_markers):
        return not any(marker in subgroup_text for marker in exclusion_markers)
    if any(marker in text for marker in exclusion_markers):
        return False
    return any(marker in text for marker in critical_markers)


def _primary_population_rank(outcome, study, protocol: ResearchProtocol) -> int:
    if _outcome_is_protocol_population_subgroup(outcome, study, protocol):
        return 2
    if _is_overall_outcome(outcome):
        return 1
    return 0


def _is_overall_outcome(outcome) -> bool:
    """Return True when an extracted outcome is the overall effect row."""
    subgroup = (getattr(outcome, "subgroup", None) or "").strip().lower()
    if (
        subgroup
        and subgroup not in {"overall", "total", "all", "all participants", "intention-to-treat", "itt"}
        and not _subgroup_is_pooled_intervention_contrast(subgroup)
    ):
        return False

    evidence_text = " ".join(
        str(getattr(outcome, attr, "") or "").lower()
        for attr in ("outcome_name", "source_location", "source_quote", "source_section")
    )
    subgroup_markers = [
        "among patients receiving",
        "among those receiving",
        "receiving invasive mechanical ventilation",
        "invasive mechanical ventilation",
        "oxygen without invasive",
        "oxygen only",
        "no oxygen received",
        "no respiratory support",
        "not receiving invasive mechanical ventilation",
        "mechanical ventilation subgroup",
        "subgroup",
    ]
    return not any(marker in evidence_text for marker in subgroup_markers)


def _candidate_quality(study, outcome) -> tuple[int, int, int, int, int]:
    """Rank duplicate publication candidates for the same trial totals."""
    c = study.characteristics
    title = (c.title or "").lower()
    return (
        1 if getattr(outcome, "manual_adjudication", False) is True else 0,
        1 if c.pmid else 0,
        1 if c.doi else 0,
        1 if "preliminary" not in title else 0,
        1 if getattr(outcome, "source_quote_verified", False) else 0,
    )


def _manual_reference_source_key(outcome) -> str:
    if getattr(outcome, "manual_adjudication", False) is not True:
        return ""
    source_location = re.sub(r"\s+", " ", str(getattr(outcome, "source_location", "") or "").strip().lower())
    source_section = re.sub(r"\s+", " ", str(getattr(outcome, "source_section", "") or "").strip().lower())
    return source_location or source_section or "__manual_reference__"


def _manual_reference_set_key(candidates) -> str:
    counts: dict[str, int] = {}
    for _, outcome, _ in candidates:
        key = _manual_reference_source_key(outcome)
        if key:
            counts[key] = counts.get(key, 0) + 1
    if not counts:
        return ""
    key, count = max(counts.items(), key=lambda item: item[1])
    return key if count >= 2 else ""


def _normalise_reference_token(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def _study_identity_tokens_from_characteristics(characteristics) -> set[str]:
    tokens: set[str] = set()
    for attr in ("pmid", "doi", "study_id", "title"):
        value = getattr(characteristics, attr, "") if characteristics is not None else ""
        token = _normalise_reference_token(value)
        if token:
            tokens.add(token)
    return tokens


def _paper_identity_tokens(paper: dict) -> set[str]:
    tokens: set[str] = set()
    raw = paper.get("paper") if isinstance(paper.get("paper"), dict) else paper
    if not isinstance(raw, dict):
        return tokens
    for key in ("pmid", "doi", "study_id", "id", "title"):
        token = _normalise_reference_token(raw.get(key))
        if token:
            tokens.add(token)
    return tokens


def _build_paper_source_lookup(papers: list[dict]) -> dict[str, dict]:
    lookup: dict[str, dict] = {}
    for paper in papers or []:
        raw = paper.get("paper") if isinstance(paper.get("paper"), dict) else paper
        if not isinstance(raw, dict):
            continue
        record = {
            "text_availability": raw.get("text_availability") or paper.get("text_availability") or "",
            "fulltext_source": raw.get("fulltext_source") or paper.get("fulltext_source") or "",
            "pdf_path": raw.get("pdf_path") or paper.get("pdf_path") or "",
            "fulltext_path": raw.get("fulltext_path") or paper.get("fulltext_path") or "",
        }
        for token in _paper_identity_tokens(raw):
            lookup[token] = record
    return lookup


def _source_record_for_study(study, source_lookup: dict[str, dict]) -> dict:
    for token in _study_identity_tokens_from_characteristics(getattr(study, "characteristics", None)):
        if token in source_lookup:
            return source_lookup[token]
    return {}


def _build_rob_lookup(rob_results: list[StudyRoB]) -> dict[str, StudyRoB]:
    lookup: dict[str, StudyRoB] = {}
    for rob in rob_results or []:
        token = _normalise_reference_token(getattr(rob, "study_id", ""))
        if token:
            lookup[token] = rob
    return lookup


def _rob_for_study(study, effect: StudyEffect | None, rob_lookup: dict[str, StudyRoB]) -> StudyRoB | None:
    tokens = set()
    tokens.update(_study_identity_tokens_from_characteristics(getattr(study, "characteristics", None)))
    if effect is not None:
        tokens.add(_normalise_reference_token(effect.study_id))
        tokens.add(_normalise_reference_token(effect.study_label))
    for token in tokens:
        if token and token in rob_lookup:
            return rob_lookup[token]
    return None


def _primary_candidate_block_reason(
    audit_row: dict,
    outcome,
    rob: StudyRoB | None,
    *,
    benchmark_reference_manifest: dict | None = None,
) -> str:
    """Return a pre-pooling hard-gate reason, or an empty string when poolable."""
    annotate_source_provenance(audit_row)
    tier = str(audit_row.get("source_provenance_tier") or "unknown")
    allowed_tiers = BENCHMARK_ALLOWED_TIERS if benchmark_reference_manifest else PRIMARY_ALLOWED_TIERS
    if tier not in allowed_tiers:
        return f"source_provenance_not_allowed:{tier}"
    text_availability = str(audit_row.get("text_availability") or "").lower()
    if text_availability in {"abstract_only", "metadata_only"}:
        return f"limited_text_source:{text_availability}"
    if getattr(outcome, "source_quote_verified", False) is not True:
        return "source_quote_not_verified"
    if rob is None:
        return "missing_risk_of_bias_assessment"
    if getattr(rob, "is_synthetic", False):
        return "synthetic_risk_of_bias_assessment"
    if not str(getattr(rob, "overall_judgment", "") or "").strip():
        return "empty_risk_of_bias_judgment"
    return ""


def _benchmark_reference_alias_index(reference_manifest: dict | None) -> dict[str, str]:
    """Map identifier aliases from a benchmark reference set to trial slugs."""
    index: dict[str, str] = {}
    for trial in (reference_manifest or {}).get("expected_trials") or []:
        slug = str(trial.get("slug") or "").strip()
        if not slug:
            continue
        aliases = set(trial.get("aliases") or [])
        aliases.update([slug, slug.replace("_", " "), trial.get("label"), trial.get("nct_id")])
        for alias in aliases:
            token = _normalise_reference_token(alias)
            if token:
                index[token] = slug
    return index


def _candidate_reference_text(study, outcome) -> str:
    c = getattr(study, "characteristics", None)
    parts = []
    for attr in ("study_id", "pmid", "doi", "title", "journal", "source_type", "metadata_source"):
        parts.append(str(getattr(c, attr, "") or ""))
    for attr in ("source_location", "source_section", "source_quote", "source_quote_match", "subgroup", "outcome_name"):
        parts.append(str(getattr(outcome, attr, "") or ""))
    return " ".join(parts)


def _benchmark_reference_slug_for_candidate(
    study,
    outcome,
    reference_manifest: dict | None,
) -> str:
    alias_index = _benchmark_reference_alias_index(reference_manifest)
    if not alias_index:
        return ""
    c = getattr(study, "characteristics", None)
    direct_values = [
        getattr(c, "study_id", ""),
        getattr(c, "pmid", ""),
        getattr(c, "doi", ""),
    ]
    for value in direct_values:
        slug = alias_index.get(_normalise_reference_token(value))
        if slug:
            return slug
    text = _candidate_reference_text(study, outcome)
    normalized_text = _normalise_reference_token(text)
    for token, slug in alias_index.items():
        if token and len(token) >= 5 and token in normalized_text:
            return slug
    return ""


def _benchmark_reference_candidate_score(study, outcome) -> tuple[int, int, int, int, int, int]:
    c = getattr(study, "characteristics", None)
    source_text = " ".join([
        str(getattr(c, "source_type", "") or ""),
        str(getattr(c, "metadata_source", "") or ""),
    ]).lower()
    has_counts = all(
        getattr(outcome, field, None) is not None
        for field in ("events_intervention", "total_intervention", "events_control", "total_control")
    )
    return (
        int(getattr(outcome, "manual_adjudication", False) is True),
        int("primary_trial_or_registry_seed" in source_text or "trial_registry_seed" in source_text),
        int(getattr(outcome, "source_quote_verified", False) is True),
        int(has_counts),
        int(bool(getattr(c, "pmid", "") or "")),
        int(bool(getattr(c, "doi", "") or "")),
    )


def _filter_benchmark_reference_primary_candidates(
    candidates,
    reference_manifest: dict | None,
    audit_rows: list[dict],
    logger,
):
    """Constrain benchmark reproduction runs to the expected original trial set.

    The benchmark publication may define the target trial set, but data rows that
    enter pooling must still come from original trial reports, registries, or
    accepted source seeds. Extra trials found by a broader search are retained in
    extraction artifacts and excluded from the primary pooled estimate.
    """
    if not (reference_manifest or {}).get("expected_trials"):
        return candidates

    audit_by_row_id = {str(row.get("row_id") or ""): row for row in audit_rows}
    grouped: dict[str, list[tuple[tuple[int, int, int, int, int, int], object, object, object, str]]] = {}
    for study, outcome, effect, row_id in candidates:
        slug = _benchmark_reference_slug_for_candidate(study, outcome, reference_manifest)
        row = audit_by_row_id.get(str(row_id))
        if row is not None:
            row["benchmark_reference_source_id"] = reference_manifest.get("source_id")
            row["benchmark_reference_trial"] = slug
        if not slug:
            if row is not None:
                row["decision"] = "excluded"
                row["reason"] = "outside_benchmark_reference_trial_set"
            logger.warning(
                "Excluding primary candidate %s from benchmark reproduction: not in expected trial set.",
                getattr(effect, "study_id", ""),
            )
            continue
        grouped.setdefault(slug, []).append(
            (_benchmark_reference_candidate_score(study, outcome), study, outcome, effect, row_id)
        )

    selected = []
    for slug, items in grouped.items():
        items.sort(key=lambda item: item[0], reverse=True)
        chosen = items[0]
        selected.append((chosen[1], chosen[2], chosen[3], chosen[4]))
        for dropped in items[1:]:
            row = audit_by_row_id.get(str(dropped[4]))
            if row is not None:
                row["decision"] = "excluded"
                row["reason"] = "benchmark_reference_duplicate_lower_ranked"
            logger.warning(
                "Excluding duplicate candidate %s for benchmark trial %s; keeping higher-ranked source %s.",
                getattr(dropped[3], "study_id", ""),
                slug,
                getattr(chosen[3], "study_id", ""),
            )

    return selected


def _primary_effect_identity_key(study, outcome, effect) -> tuple[str, str, str]:
    """Build a dedupe key that cannot merge independent trials sharing arm totals."""
    c = getattr(study, "characteristics", None)
    study_key = (
        getattr(c, "pmid", None)
        or getattr(c, "doi", None)
        or getattr(c, "study_id", None)
        or getattr(effect, "study_id", None)
        or getattr(effect, "study_label", "")
    )
    if not study_key and getattr(outcome, "total_intervention", None) and getattr(outcome, "total_control", None):
        study_key = f"unknown_totals_{int(outcome.total_intervention)}_{int(outcome.total_control)}"
    return (
        _normalise_reference_token(study_key),
        _normalise_reference_token(getattr(outcome, "outcome_name", "") or ""),
        _normalise_reference_token(getattr(outcome, "timepoint", "") or ""),
    )


def _totals_outcome_key(outcome) -> tuple[int, int, str] | None:
    if not (getattr(outcome, "total_intervention", None) and getattr(outcome, "total_control", None)):
        return None
    return (
        int(outcome.total_intervention),
        int(outcome.total_control),
        _normalise_reference_token(getattr(outcome, "outcome_name", "") or ""),
    )


def _looks_like_preliminary_publication(study, effect) -> bool:
    c = getattr(study, "characteristics", None)
    text = " ".join(
        str(value or "").lower()
        for value in (
            getattr(c, "title", ""),
            getattr(c, "doi", ""),
            getattr(c, "source_type", ""),
            getattr(c, "metadata_source", ""),
            getattr(effect, "study_id", ""),
            getattr(effect, "study_label", ""),
        )
    )
    return any(marker in text for marker in ("preprint", "preliminary", "medrxiv", "biorxiv"))


def _dedupe_primary_effect_candidates(candidates, logger) -> list[StudyEffect]:
    """Keep one overall primary effect per study without using arm totals alone."""
    manual_reference_key = _manual_reference_set_key(candidates)
    if manual_reference_key:
        filtered = []
        for study, outcome, effect in candidates:
            if _manual_reference_source_key(outcome) == manual_reference_key:
                filtered.append((study, outcome, effect))
            else:
                logger.warning(
                    "Source-adjudicated primary reference set detected; excluding non-adjudicated "
                    "primary candidate %s from the main analysis pending review.",
                    effect.study_id,
                )
        candidates = filtered

    totals_groups: dict[tuple[int, int, str], list[tuple[object, object, StudyEffect]]] = {}
    for study, outcome, effect in candidates:
        totals_key = _totals_outcome_key(outcome)
        if totals_key:
            totals_groups.setdefault(totals_key, []).append((study, outcome, effect))
    duplicate_publication_totals = {
        key
        for key, items in totals_groups.items()
        if len(items) > 1 and any(_looks_like_preliminary_publication(study, effect) for study, _, effect in items)
    }

    by_key = {}
    for study, outcome, effect in candidates:
        totals_key = _totals_outcome_key(outcome)
        key = (
            ("duplicate_publication_totals", *totals_key)
            if totals_key in duplicate_publication_totals
            else _primary_effect_identity_key(study, outcome, effect)
        )
        score = _candidate_quality(study, outcome)
        current = by_key.get(key)
        if current is None or score > current[0]:
            if current is not None:
                logger.warning(
                    "Duplicate primary-effect candidate detected for study/outcome key %s; "
                    "keeping higher-quality publication (%s over %s)",
                    key,
                    effect.study_id,
                    current[3].study_id,
                )
            by_key[key] = (score, study, outcome, effect)
        else:
            logger.warning(
                "Duplicate primary-effect candidate detected for study/outcome key %s; "
                "dropping lower-quality publication %s",
                key,
                effect.study_id,
            )
    return [entry[3] for entry in by_key.values()]


def _effect_is_poolable(effect: StudyEffect) -> tuple[bool, str]:
    if not math.isfinite(effect.yi):
        return False, "nonfinite_effect_size"
    if not math.isfinite(effect.vi) or effect.vi <= 0:
        return False, "nonpositive_or_nonfinite_variance"
    if not math.isfinite(effect.se) or effect.se <= 0:
        return False, "nonpositive_or_nonfinite_standard_error"
    if abs(effect.yi) >= 50 or effect.vi >= 100:
        return False, "extreme_effect_size_or_variance"
    return True, ""


def _primary_outcome_rank(outcome, target: str) -> tuple[int, int, int, int, int, int, int, int]:
    """Rank matching primary-outcome rows within one study.

    Extraction can produce several mortality-related rows from the same paper
    (for example the true 28-day mortality row plus a secondary "Death" row for
    a subset that excludes ventilated patients). Prefer the row closest to the
    protocol target before cross-study pooling.
    """
    name_lower = (getattr(outcome, "outcome_name", "") or "").strip().lower()
    target_lower = target.strip().lower()
    name_days = set(re.findall(r"\b(\d+)\s*[- ]?\s*day", name_lower))
    target_days = set(re.findall(r"\b(\d+)\s*[- ]?\s*day", target_lower))
    has_counts = all(
        getattr(outcome, field, None) is not None
        for field in ("events_intervention", "total_intervention", "events_control", "total_control")
    )
    return (
        int(name_lower == target_lower),
        int(bool(name_days & target_days)),
        int(target_lower in name_lower or name_lower in target_lower),
        int("all-cause" in name_lower),
        int("mortality" in name_lower),
        int(bool(getattr(outcome, "source_quote_verified", False))),
        int(has_counts),
        -int(name_lower in {"death", "deaths"}),
    )


def _primary_candidate_rank(outcome, study, protocol: ResearchProtocol) -> tuple[int, int, int, int, int, int, int, int, int, int]:
    """Rank candidate primary rows, keeping source-adjudicated rows above LLM-only rows."""
    return (
        int(getattr(outcome, "manual_adjudication", False) is True),
        _primary_population_rank(outcome, study, protocol),
        *_primary_outcome_rank(outcome, protocol.pico.outcome_primary),
    )


def _outcome_mentions_target_day(outcome, target: str) -> bool:
    target_days = set(re.findall(r"\b(\d+)\s*[- ]?\s*day", target.strip().lower()))
    if not target_days:
        return True
    text = " ".join(
        str(getattr(outcome, attr, "") or "").lower()
        for attr in ("outcome_name", "timepoint", "source_quote", "source_location", "source_section")
    )
    outcome_days = set(re.findall(r"\b(\d+)\s*[- ]?\s*day", text))
    return bool(outcome_days & target_days)


def _unpack_query_result(query_result) -> tuple[str, str, bool]:
    """Normalize QueryBuilder.run return values across older/newer call sites."""
    if not isinstance(query_result, tuple):
        return query_result, "", False
    search_query = query_result[0] if len(query_result) > 0 else ""
    strategy_report = query_result[1] if len(query_result) > 1 else ""
    is_single_drug = query_result[2] if len(query_result) > 2 else False
    return search_query, strategy_report, is_single_drug


def _broaden_protocol_for_retry(protocol: ResearchProtocol) -> str:
    """Relax comparator wording without injecting topic-specific assumptions."""
    original = protocol.pico.comparator
    intervention = protocol.pico.intervention or "the intervention"
    protocol.pico.comparator = (
        f"{original}; any eligible comparator arm that does not contain {intervention}, "
        "including placebo, usual care, standard care, no treatment, or another active "
        "non-intervention control when clinically appropriate"
    )
    return protocol.pico.comparator


def _apply_topic_date_range(protocol: ResearchProtocol, topic: str) -> None:
    """Fill protocol.date_range from explicit topic wording when the LLM leaves it blank."""
    if protocol.date_range:
        return
    match = re.search(
        r"(?:through|until|up\s+to|to|before|截止|至)\s*(?:[A-Za-z]+\s*)?(\d{4})",
        topic or "",
        flags=re.IGNORECASE,
    )
    if match:
        protocol.date_range = f"to {match.group(1)}"


def _compute_study_effect(study, outcome, protocol, logger) -> StudyEffect | None:
    """Compute effect size for a single study-outcome pair."""
    try:
        yi, vi = es_engine.compute_effect_size(
            outcome_type=outcome.outcome_type,
            effect_measure=protocol.effect_measure,
            mean_i=outcome.mean_intervention,
            sd_i=outcome.sd_intervention,
            n_i=outcome.n_intervention,
            mean_c=outcome.mean_control,
            sd_c=outcome.sd_control,
            n_c=outcome.n_control,
            median_i=outcome.median_intervention,
            q1_i=outcome.q1_intervention,
            q3_i=outcome.q3_intervention,
            min_i=outcome.min_intervention,
            max_i=outcome.max_intervention,
            median_c=outcome.median_control,
            q1_c=outcome.q1_control,
            q3_c=outcome.q3_control,
            min_c=outcome.min_control,
            max_c=outcome.max_control,
            events_i=outcome.events_intervention,
            total_i=outcome.total_intervention,
            events_c=outcome.events_control,
            total_c=outcome.total_control,
            effect=outcome.effect_size,
            ci_lower=outcome.ci_lower,
            ci_upper=outcome.ci_upper,
            p_value=outcome.p_value,
            hr=outcome.hazard_ratio,
            hr_ci_lower=outcome.hr_ci_lower,
            hr_ci_upper=outcome.hr_ci_upper,
            hr_se=outcome.hr_se,
            events_single=outcome.events,
            total_n=outcome.total_n,
            correlation_r=outcome.correlation_r,
            correlation_n=outcome.correlation_n,
            pyears_i=outcome.pyears_intervention,
            pyears_c=outcome.pyears_control,
        )
        c = study.characteristics
        label = _display_study_label(c)
        return StudyEffect(
            study_id=c.pmid or c.study_id,
            study_label=label,
            yi=yi,
            vi=vi,
            se=vi ** 0.5,
            subgroup=outcome.subgroup,
        )
    except Exception as e:
        logger.warning(f"Cannot compute effect size for {study.characteristics.study_id}: {e}")
        return None


# Compatibility exports while callers migrate from `new_meta.main` to the
# shared core. Rebinding here guarantees CLI and Web execute the same code.
from new_meta.core.effect_selection import (
    build_paper_source_lookup as _build_paper_source_lookup,
    build_rob_lookup as _build_rob_lookup,
    compute_study_effect as _compute_study_effect,
    dedupe_primary_effect_candidates as _dedupe_primary_effect_candidates,
    effect_is_poolable as _effect_is_poolable,
    filter_benchmark_reference_primary_candidates as _filter_benchmark_reference_primary_candidates,
    primary_candidate_block_reason as _primary_candidate_block_reason,
    primary_candidate_rank as _primary_candidate_rank,
    primary_population_rank as _primary_population_rank,
    rob_for_study as _rob_for_study,
    source_record_for_study as _source_record_for_study,
)


def _normalise_outcome_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).strip()


def _outcome_tokens(text: str) -> set[str]:
    stop = {
        "the", "and", "or", "of", "for", "to", "a", "an", "with", "first",
        "time", "composite", "outcome", "primary", "secondary", "alone",
    }
    return {
        token for token in re.findall(r"[a-z0-9]+", str(text or "").lower())
        if len(token) >= 3 and token not in stop
    }


def _strict_secondary_outcome_matches(outcome_name: str, secondary_name: str, primary_name: str) -> bool:
    """Prevent primary composite rows from being reused as secondary outcomes."""
    candidate = _normalise_outcome_key(outcome_name)
    target = _normalise_outcome_key(secondary_name)
    primary = _normalise_outcome_key(primary_name)
    if not candidate or not target:
        return False
    if candidate == target:
        return True
    if not _outcome_matches(outcome_name, secondary_name):
        return False
    target_tokens = _outcome_tokens(secondary_name)
    candidate_tokens = _outcome_tokens(outcome_name)
    if target_tokens and not target_tokens.issubset(candidate_tokens):
        return False
    component_tokens = {
        "cardiovascular", "death", "mortality", "hospitalization", "hospitalisation", "urgent", "visit",
    }
    target_components = target_tokens & component_tokens
    candidate_components = candidate_tokens & component_tokens
    if candidate_components - target_components:
        return False
    if "urgent" in target_tokens and "urgent" not in candidate_tokens:
        return False
    if "alone" in str(secondary_name or "").lower() and ({"cardiovascular", "death", "urgent", "visit"} & candidate_tokens):
        return False
    if primary and candidate == primary and target != primary:
        return False
    if _outcome_matches(outcome_name, primary_name) and target != primary:
        primary_components = _outcome_tokens(primary_name) & component_tokens
        if primary_components - target_components:
            return False
    return True


def setup_logging():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def print_step(step: str, title: str):
    print(f"\n{'=' * 60}")
    print(f"  Step {step}: {title}")
    print(f"{'=' * 60}\n")


def _finalize_cli_release(
    project: Project,
    package_path: str | Path,
    *,
    success_label: str,
) -> dict:
    """Print a truthful CLI terminal state and reject blocked submissions."""
    from new_meta.core.release_contract import (
        ReleaseBlockedError,
        ReleaseStatus,
        build_release_decision,
        load_release_decision,
        persist_release_decision,
    )

    decision = load_release_decision(project)
    if decision is None:
        decision = persist_release_decision(
            project,
            build_release_decision(None, package_path=package_path),
        )
    status = str(decision.get("status") or "").strip().lower()
    if status == ReleaseStatus.BLOCKED.value:
        print_step("14", "BLOCKED — Submission Release Gate")
        print(decision.get("summary") or "Submission release is blocked.")
        print(f"  Review package: {package_path}")
        print(f"  Blocking gates: {', '.join(decision.get('blocker_codes') or []) or 'unknown'}")
        for action in decision.get("next_actions") or []:
            print(f"  - {action}")
        raise ReleaseBlockedError(decision)

    print_step("14", success_label)
    if status == ReleaseStatus.READY_WITH_WARNINGS.value:
        print("  Release status: ready with warnings; explicit reviewer acceptance is required.")
        print(f"  Warning gates: {', '.join(decision.get('warning_codes') or []) or 'unspecified'}")
    return decision


def _can_write_manuscript_from_cached_artifacts(project: Project) -> bool:
    """Return True when cached artifacts are sufficient to write a manuscript."""
    required_files = [
        project.base_dir / "protocol.json",
        project.base_dir / "search_query.txt",
        project.base_dir / "extraction" / "all_extractions.json",
        project.base_dir / "risk_of_bias" / "rob_results.json",
        project.base_dir / "analysis" / "meta_results.json",
    ]
    return all(path.exists() for path in required_files)


def _can_write_narrative_manuscript_from_cached_artifacts(project: Project) -> bool:
    """Return True when a cached narrative/evidence-gap report can be rewritten."""
    required_files = [
        project.base_dir / "protocol.json",
        project.base_dir / "search_query.txt",
        project.base_dir / "extraction" / "all_extractions.json",
    ]
    if not all(path.exists() for path in required_files):
        return False
    report_state = project.load_json("report_state.json", subdir="analysis") or {}
    report_type = str(report_state.get("report_type") or "").strip().lower()
    if report_type in {"narrative", "evidence_gap"}:
        return True
    gate = project.load_json("evidence_gate_result.json", subdir="analysis") or {}
    return str(gate.get("decision") or "").strip().lower() in {"narrative", "evidence_gap"}


def _can_resume_direct_to_manuscript(project: Project) -> bool:
    """Return True when only manuscript generation needs to be rerun."""
    late_steps_done = project.is_step_done("grade") and project.is_step_done("figures")
    return (not project.is_step_done("manuscript")) and late_steps_done and _can_write_manuscript_from_cached_artifacts(project)


def _can_rerun_manuscript_only(project: Project) -> bool:
    """Return True when cached artifacts allow a forced manuscript rewrite."""
    return (
        _can_write_manuscript_from_cached_artifacts(project)
        or _can_write_narrative_manuscript_from_cached_artifacts(project)
    )


def _load_included_papers_for_resume(project: Project) -> list[dict]:
    ft_results = project.load_json("full_text_screening.json", subdir="screening") or []
    included = [
        item.get("paper", item)
        for item in ft_results
        if str(item.get("decision", "")).lower() == "include"
    ]
    if included:
        return included
    pdf_records = project.load_json("pdf_download_results.json") or []
    return [
        paper for paper in pdf_records
        if paper.get("pdf_path") or paper.get("fulltext_path") or paper.get("text_availability") == "abstract_only"
    ]


def _add_reference_if_absent(ref_manager: ReferenceManager, study_id: str, paper: dict) -> None:
    if study_id in getattr(ref_manager, "_id_map", {}):
        return
    ref_manager.add(paper, study_id=study_id)


def _alias_reference_if_present(ref_manager: ReferenceManager, alias: str, target: str) -> None:
    id_map = getattr(ref_manager, "_id_map", {})
    if alias not in id_map and target in id_map:
        id_map[alias] = id_map[target]


def _has_any_id(study_ids: set[str], *ids: str) -> bool:
    return bool(set(ids) & study_ids)


def _evidence_context_query(protocol: ResearchProtocol, search_query: str = "") -> str:
    """Build a concise evidence-search query for background citations."""
    pieces = [
        _intervention_search_terms(getattr(protocol.pico, "intervention", "")),
        _population_search_terms(getattr(protocol.pico, "population", "")),
        _compact_search_field(getattr(protocol.pico, "outcome_primary", ""), max_words=8),
        "guideline systematic review meta-analysis",
    ]
    seen: set[str] = set()
    out: list[str] = []
    for piece in pieces:
        cleaned = " ".join(str(piece or "").split())
        key = cleaned.lower()
        if cleaned and key not in seen:
            seen.add(key)
            out.append(cleaned)
    query = " ".join(out)
    if not query.strip():
        query = search_query or protocol.research_question
    return query[:260]


def _first_sentence(value: str) -> str:
    text = " ".join(str(value or "").split())
    if not text:
        return ""
    return re.split(r"(?<=[.!?。！？])\s+", text, maxsplit=1)[0]


def _compact_search_field(value: str, *, max_words: int) -> str:
    text = _first_sentence(re.sub(r"\([^)]*\)", " ", str(value or "")))
    words = text.split()
    return " ".join(words[:max_words])


def _population_search_terms(value: str) -> str:
    text = " ".join(str(value or "").split())
    lowered = text.lower()
    if any(marker in lowered for marker in ("covid", "sars-cov-2", "coronavirus")):
        parts = ["COVID-19"]
        if any(marker in lowered for marker in ("icu", "intensive care", "critically ill", "critical")):
            parts.extend(["ICU", "adults"])
        return " ".join(parts)
    return _compact_search_field(text, max_words=10)


def _intervention_search_terms(value: str) -> str:
    """Keep the intervention identity while dropping route/timing prefixes."""
    text = _first_sentence(re.sub(r"\([^)]*\)", " ", str(value or "")))
    prefix_modifiers = {
        "perioperative", "preoperative", "postoperative", "intraoperative",
        "intravenous", "oral", "subcutaneous", "intramuscular", "topical",
        "low-dose", "low", "high-dose", "high", "prophylactic", "therapeutic",
    }
    stop_tokens = {"with", "without", "versus", "vs", "compared", "including", "plus", "and"}
    selected: list[str] = []
    for word in text.split():
        normalized = re.sub(r"[^a-z0-9+-]", "", word.lower())
        if not selected and normalized in prefix_modifiers:
            continue
        if selected and normalized in stop_tokens:
            break
        if normalized:
            selected.append(word)
        if len(selected) >= 3:
            break
    return " ".join(selected) or _compact_search_field(text, max_words=3)


def _add_evidence_context_references(
    project: Project,
    protocol: ResearchProtocol,
    ref_manager: ReferenceManager,
    *,
    search_query: str = "",
) -> dict:
    """Add Evimed background evidence references for Introduction/Discussion context."""
    query = _evidence_context_query(protocol, search_query)
    cached = project.load_json("evidence_context.json", subdir="search") or {}
    if (
        cached.get("query") == query
        and cached.get("cache_version") == EVIMED_CONTEXT_CACHE_VERSION
        and isinstance(cached.get("references"), list)
        and len(cached.get("references") or []) >= EVIDENCE_CONTEXT_TARGET_REFERENCES
    ):
        context = cached
    else:
        context = _search_evidence_context_with_fallbacks(protocol, query)
        if context.get("status") == "error":
            project.add_warning(
                "search",
                f"Evimed evidence search failed and background citation enrichment was skipped: {context.get('message', 'unknown error')}",
                code="evimed_evidence_search_failed",
                severity="warning",
                context={"query": query},
            )

    if context.get("status") == "ok":
        project.clear_warnings(stage="search", code="evimed_evidence_search_failed")

    added = 0
    raw_references = context.get("references") or []
    filtered_references = _filter_evidence_context_references(protocol, raw_references)
    if len(filtered_references) < EVIDENCE_CONTEXT_TARGET_REFERENCES:
        pubmed_background = _pubmed_background_references(
            protocol,
            max_results=PUBMED_BACKGROUND_FALLBACK_MAX_RESULTS,
        )
        existing_ids = {str(item.get("study_id") or "") for item in filtered_references}
        for item in pubmed_background:
            if item.get("study_id") not in existing_ids:
                filtered_references.append(item)
                existing_ids.add(str(item.get("study_id") or ""))
    references = []
    seen_title_keys: set[str] = set()
    for item in filtered_references:
        if not isinstance(item, dict):
            continue
        study_id = str(item.get("study_id") or "").strip()
        paper = item.get("paper") or {}
        if not study_id or not isinstance(paper, dict) or not paper.get("title"):
            continue
        title_key = _background_reference_title_key(str(paper.get("title") or item.get("title") or ""))
        if title_key and title_key in seen_title_keys:
            continue
        if title_key:
            seen_title_keys.add(title_key)
        before = len(ref_manager.entries)
        ref_manager.add(paper, study_id=study_id)
        added += int(len(ref_manager.entries) > before)
        enriched = dict(item)
        enriched["citation"] = ref_manager.cite(study_id)
        references.append(enriched)

    context = dict(context)
    context["cache_version"] = EVIMED_CONTEXT_CACHE_VERSION
    context["query"] = query
    context["references"] = references
    context["filtered_out_references"] = max(0, len(raw_references) - len(filtered_references))
    context["added_references"] = added
    context["pubmed_background_references"] = sum(1 for item in references if item.get("source_type") == "pubmed_background")
    project.save_json("evidence_context.json", context, subdir="search")
    return {"status": context.get("status", "unknown"), "added_references": added, "query": query}


def _add_methodology_references(
    project: Project,
    ref_manager: ReferenceManager,
    *,
    include_rob: bool = False,
    include_grade: bool = True,
    include_publication_bias: bool = True,
) -> dict:
    """Add stable reporting/methods references used outside Introduction."""
    selected: list[dict] = []
    for item in METHODOLOGY_REFERENCES:
        source_type = str(item.get("source_type") or "")
        if source_type == "risk_of_bias_tool" and not include_rob:
            continue
        if source_type == "certainty_framework" and not include_grade:
            continue
        if source_type == "publication_bias_method" and not include_publication_bias:
            continue
        selected.append(item)

    added = 0
    references: list[dict] = []
    for item in selected:
        study_id = str(item.get("study_id") or "").strip()
        paper = item.get("paper") or {}
        if not study_id or not paper:
            continue
        before = len(ref_manager.entries)
        ref_manager.add(paper, study_id=study_id)
        added += int(len(ref_manager.entries) > before)
        references.append({
            "study_id": study_id,
            "source_type": item.get("source_type", "methodology"),
            "title": item.get("title") or paper.get("title") or "",
            "citation": ref_manager.cite(study_id),
            "paper": paper,
        })

    context = {
        "schema_version": 1,
        "cache_version": METHODOLOGY_CONTEXT_CACHE_VERSION,
        "references": references,
        "added_references": added,
    }
    project.save_json("methodology_context.json", context, subdir="search")
    return {"status": "ok", "added_references": added}


def _should_polish_manuscript(args) -> bool:
    if bool(getattr(args, "no_polish_manuscript", False)):
        return False
    if bool(getattr(args, "polish_manuscript", False)):
        return True
    return bool(MANUSCRIPT_POLISH_ENABLED)


def _resolve_manuscript_polish_scope(args) -> str:
    explicit_scope = (
        getattr(args, "manuscript_polish_scope", None)
        or getattr(args, "polish_scope", None)
    )
    if explicit_scope:
        raw = str(explicit_scope).strip().lower().replace("-", "_")
    elif bool(getattr(args, "polish_manuscript", False)):
        raw = "all"
    else:
        raw = str(MANUSCRIPT_POLISH_REWRITE_SCOPE or "targeted").strip().lower().replace("-", "_")
    if raw in {"target", "targeted", "issue", "issues", "problematic"}:
        return "targeted"
    if raw in {"all", "full", "complete", "deep"}:
        return "all"
    return "targeted"


def _resolve_manuscript_polish_max_chunks(rewrite_fn, rewrite_scope: str) -> int | None:
    if not rewrite_fn:
        return None
    configured = int(MANUSCRIPT_POLISH_MAX_LLM_CHUNKS)
    if os.getenv("MANUSCRIPT_POLISH_MAX_LLM_CHUNKS") is not None:
        return configured
    if str(rewrite_scope or "").strip().lower() == "all":
        return max(configured, 24)
    return configured


def _finalize_manuscript_after_postprocessing(project: Project, manuscript: str, *, lang: str) -> tuple[str, dict]:
    """Re-run hard manuscript gates after polish/no-polish post-processing.

    Post-write citation backfill, citation-marker normalization, and de-duplication
    can change the text after the writing agent's own validation. The final draft,
    validation JSON, style audit, and quality gate must describe the same text.
    """
    facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    facts = facts if isinstance(facts, dict) else {}
    if not facts:
        return str(manuscript or ""), {"passed": True, "issues": [], "facts_summary": {"report_type": "unknown"}}
    finalized = WritingAgent._normalize_citation_marker_style(str(manuscript or ""), lang=lang)
    finalized = WritingAgent._normalize_figure_heading_spacing(finalized)
    finalized = WritingAgent._repair_markdown_image_syntax(finalized)
    citation_agent = WritingAgent(lang=lang)
    finalized, citation_plan_audit = citation_agent._apply_claim_map_citations(finalized, facts)
    project.save_json("final_claim_map_citation_plan.json", citation_plan_audit, subdir="manuscript")
    citation_agent._save_citation_contract(project, facts)
    finalized, validation = validate_and_repair_manuscript(finalized, facts)
    finalized = WritingAgent._normalize_citation_marker_style(finalized, lang=lang)
    finalized = WritingAgent._normalize_figure_heading_spacing(finalized)
    finalized = WritingAgent._repair_markdown_image_syntax(finalized)
    finalized, citation_plan_audit = citation_agent._apply_claim_map_citations(finalized, facts)
    project.save_json("final_claim_map_citation_plan.json", citation_plan_audit, subdir="manuscript")
    citation_agent._save_citation_contract(project, facts)
    finalized, validation = validate_and_repair_manuscript(finalized, facts)
    validation, _, _ = WritingAgent(lang=lang)._quality_checked_validation(
        finalized,
        facts,
        validation,
        project=project,
    )
    try:
        from new_meta.core.real_smoke import write_real_smoke_manifest
        write_real_smoke_manifest(project.base_dir)
    except Exception as exc:
        logger.warning("Could not write real smoke manifest: %s", exc)
    return finalized, validation


def _run_final_manuscript_llm_readiness_review(
    project: Project,
    *,
    model: str | None,
    lang: str,
) -> dict:
    """Persist a non-blocking LLM peer-review audit of the final saved manuscript."""
    draft_path = project.base_dir / "manuscript" / "draft.md"
    facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    if not draft_path.exists() or not isinstance(facts, dict) or not facts:
        review = {
            "schema_version": 1,
            "enabled": True,
            "status": "skipped",
            "reason": "missing_final_draft_or_facts",
        }
        project.save_json("manuscript_llm_readiness_review.json", review, subdir="manuscript")
        return review
    if not LLM_API_KEY:
        review = {
            "schema_version": 1,
            "enabled": True,
            "status": "skipped",
            "reason": "missing_llm_api_key",
        }
        project.save_json("manuscript_llm_readiness_review.json", review, subdir="manuscript")
        return review
    manuscript = draft_path.read_text(encoding="utf-8", errors="replace")
    validation = project.load_json("manuscript_validation.json", subdir="manuscript")
    quality_gate = project.load_json("manuscript_quality_gate.json", subdir="manuscript")
    submission_quality_gate = project.load_json("submission_quality_gate.json", subdir="manuscript")
    citation_audit = None
    try:
        from new_meta.core.artifact_package import _build_citation_audit_review
        citation_audit = _build_citation_audit_review(project)
        if isinstance(citation_audit, dict):
            project.save_json("citation_audit_review.json", citation_audit, subdir="manuscript")
    except Exception as exc:
        citation_audit = {
            "schema_version": 1,
            "status": "failed",
            "error": str(exc)[:500],
        }
    review = WritingAgent(model=model, lang=lang)._llm_final_manuscript_readiness_review(
        manuscript,
        facts,
        validation=validation if isinstance(validation, dict) else None,
        quality_gate=quality_gate if isinstance(quality_gate, dict) else None,
        submission_quality_gate=submission_quality_gate if isinstance(submission_quality_gate, dict) else None,
        citation_audit=citation_audit if isinstance(citation_audit, dict) else None,
    )
    project.save_json("manuscript_llm_readiness_review.json", review, subdir="manuscript")
    revision_agent = WritingAgent(model=model, lang=lang)
    for revision_round in range(1, 3):
        if not WritingAgent._final_review_can_auto_revise(review):
            break
        revision_agent = WritingAgent(model=model, lang=lang)
        revised, revision_audit = revision_agent._llm_apply_final_minor_revision(
            manuscript,
            facts,
            review,
        )
        revision_audit["round"] = revision_round
        project.save_json("manuscript_final_minor_revision_audit.json", revision_audit, subdir="manuscript")
        if int(revision_audit.get("accepted_patches") or 0) <= 0 or revised == manuscript:
            break
        finalized, final_validation = _finalize_manuscript_after_postprocessing(project, revised, lang=lang)
        project.save_text("draft.md", finalized, subdir="manuscript")
        project.save_json("manuscript_validation.json", final_validation, subdir="manuscript")
        manuscript = finalized
        validation = final_validation
        quality_gate = project.load_json("manuscript_quality_gate.json", subdir="manuscript")
        submission_quality_gate = project.load_json("submission_quality_gate.json", subdir="manuscript")
        try:
            from new_meta.core.artifact_package import _build_citation_audit_review
            citation_audit = _build_citation_audit_review(project)
            if isinstance(citation_audit, dict):
                project.save_json("citation_audit_review.json", citation_audit, subdir="manuscript")
        except Exception as exc:
            citation_audit = {
                "schema_version": 1,
                "status": "failed",
                "error": str(exc)[:500],
            }
        review = revision_agent._llm_final_manuscript_readiness_review(
            manuscript,
            facts,
            validation=validation if isinstance(validation, dict) else None,
            quality_gate=quality_gate if isinstance(quality_gate, dict) else None,
            submission_quality_gate=submission_quality_gate if isinstance(submission_quality_gate, dict) else None,
            citation_audit=citation_audit if isinstance(citation_audit, dict) else None,
        )
        review["after_final_minor_revision"] = True
        review["final_minor_revision_round"] = revision_round
        project.save_json("manuscript_llm_readiness_review.json", review, subdir="manuscript")
    if (
        revision_agent._final_review_has_citation_grounding_issue(review)
        and WritingAgent._auto_revisable_final_review(review).get("issues")
    ):
        citation_agent = WritingAgent(model=model, lang=lang)
        working_review = WritingAgent._auto_revisable_final_review(review)
        citation_revised, citation_revision_audit = citation_agent._llm_ground_existing_reference_citations(
            manuscript,
            facts,
            working_review,
        )
        citation_revision_audit["mode"] = "final_tail_citation_grounding"
        project.save_json(
            "manuscript_final_citation_grounding_audit.json",
            citation_revision_audit,
            subdir="manuscript",
        )
        if int(citation_revision_audit.get("accepted_patches") or 0) > 0 and citation_revised != manuscript:
            finalized, final_validation = _finalize_manuscript_after_postprocessing(project, citation_revised, lang=lang)
            project.save_text("draft.md", finalized, subdir="manuscript")
            project.save_json("manuscript_validation.json", final_validation, subdir="manuscript")
            manuscript = finalized
            validation = final_validation
            quality_gate = project.load_json("manuscript_quality_gate.json", subdir="manuscript")
            submission_quality_gate = project.load_json("submission_quality_gate.json", subdir="manuscript")
            try:
                from new_meta.core.artifact_package import _build_citation_audit_review
                citation_audit = _build_citation_audit_review(project)
                if isinstance(citation_audit, dict):
                    project.save_json("citation_audit_review.json", citation_audit, subdir="manuscript")
            except Exception as exc:
                citation_audit = {
                    "schema_version": 1,
                    "status": "failed",
                    "error": str(exc)[:500],
                }
            review = citation_agent._llm_final_manuscript_readiness_review(
                manuscript,
                facts,
                validation=validation if isinstance(validation, dict) else None,
                quality_gate=quality_gate if isinstance(quality_gate, dict) else None,
                submission_quality_gate=submission_quality_gate if isinstance(submission_quality_gate, dict) else None,
                citation_audit=citation_audit if isinstance(citation_audit, dict) else None,
            )
            review["after_final_tail_citation_grounding"] = True
            project.save_json("manuscript_llm_readiness_review.json", review, subdir="manuscript")
    return review


def _polish_project_manuscript(
    project: Project,
    args,
    *,
    model: str | None,
    lang: str,
    progress_cb=None,
) -> str | None:
    """Run the optional post-write polish stage and persist its audit."""
    draft_path = project.base_dir / "manuscript" / "draft.md"
    if not draft_path.exists():
        return None
    original = draft_path.read_text(encoding="utf-8", errors="replace")
    enabled = _should_polish_manuscript(args)
    project.save_json(
        "manuscript_output_language.json",
        {
            "schema_version": 1,
            "expected_language": lang,
            "output_language": lang,
            "source": "pipeline_requested_output_language",
            "polish_enabled": enabled,
        },
        subdir="manuscript",
    )
    rewrite_fn = _llm_polish_rewriter(model=model, lang=lang) if enabled and MANUSCRIPT_POLISH_USE_LLM and LLM_API_KEY else None
    proofread_fn = _manuscript_polish_proofreader() if enabled else None
    rewrite_scope = _resolve_manuscript_polish_scope(args)
    if not enabled:
        _unchanged, report = polish_manuscript_text(original, enabled=False, rewrite_scope=rewrite_scope)
        finalized = original
        audit_backfill_summary = {
            "schema_version": 1,
            "applied": False,
            "mode": "skipped_no_polish_semantic_citation_grounding_deferred_to_final_llm_review",
            "reason": "no_polish_keeps_manuscript_text_stable; citation support is reviewed by the final LLM readiness pass",
        }
        normalized = WritingAgent._normalize_citation_marker_style(finalized, lang=lang)
        normalized = WritingAgent._repair_covid_contextual_citation_attribution(normalized)
        normalized = WritingAgent._normalize_citation_marker_style(normalized, lang=lang)
        normalized = WritingAgent._normalize_figure_heading_spacing(normalized)
        normalized = re.sub(
            r"(These rows did not affect the selected primary mortality comparisons or the pooled estimate)\s*\[[^\]\n]+\]",
            r"\1",
            normalized,
        )
        # Final cross-section dedup AFTER citation backfill, which can re-insert a
        # sentence that in-generation dedup already removed. No-polish drafts had no
        # such sweep, so verbatim doublings survived into the published draft.
        normalized = remove_near_duplicate_sentences(normalized, cross_section=True)
        normalized, final_validation = _finalize_manuscript_after_postprocessing(project, normalized, lang=lang)
        normalized = WritingAgent(lang=lang)._normalize_structured_abstract_spacing(normalized)
        citation_style_normalized = normalized != finalized
        finalized = normalized
        if finalized != draft_path.read_text(encoding="utf-8", errors="replace"):
            report["after"] = audit_manuscript_style(finalized)
            project.save_text("draft.md", finalized, subdir="manuscript")
        report["post_polish_citation_backfill"] = {
            "applied": False,
            "mode": "skipped_general_reference_backfill_without_polish",
        }
        report["publication_body_cleanup"] = {
            "applied": False,
            "mode": "polish_disabled_no_op",
        }
        report["length_floor_guard"] = {
            "applied": False,
            "mode": "polish_disabled",
        }
        report["post_polish_citation_audit_backfill"] = audit_backfill_summary
        report["citation_marker_style_normalization"] = {
            "applied": citation_style_normalized,
            "mode": "normalize_citation_marker_style_without_polish",
        }
        report["final_validation"] = {
            "passed": bool(final_validation.get("passed", False)),
            "issue_count": len(final_validation.get("issues", []) or []),
        }
        report["deterministic_finalization"] = {
            "applied": finalized != original,
            "mode": "citation_only_no_polish_finalization",
        }
        project.save_json("manuscript_polish_audit.json", report, subdir="manuscript")
        return finalized if finalized != original else None

    max_rewrite_chunks = _resolve_manuscript_polish_max_chunks(rewrite_fn, rewrite_scope)
    polished, report = polish_manuscript_text(
        original,
        rewrite_fn=rewrite_fn,
        proofread_fn=proofread_fn,
        enabled=enabled,
        max_rewrite_chars=3000,
        max_rewrite_chunks=max_rewrite_chunks,
        rewrite_scope=rewrite_scope,
        progress_cb=progress_cb,
    )
    publication_body_cleaned = WritingAgent._polish_publication_body_language(polished, compress_discussion=False)
    publication_body_cleanup_applied = publication_body_cleaned != polished
    if publication_body_cleanup_applied:
        polished = publication_body_cleaned
        report["after"] = audit_manuscript_style(polished)
    citation_repaired = WritingAgent._backfill_publication_inline_citations(polished)
    citation_backfill_applied = citation_repaired != polished
    if citation_backfill_applied:
        polished = citation_repaired
        report["after"] = audit_manuscript_style(polished)
    polished, audit_backfill_summary = _apply_post_polish_citation_audit_backfill(project, polished, lang=lang)
    if audit_backfill_summary.get("applied"):
        report["after"] = audit_manuscript_style(polished)
    normalized_polished = WritingAgent._normalize_citation_marker_style(polished, lang=lang)
    normalized_polished = WritingAgent._repair_covid_contextual_citation_attribution(normalized_polished)
    normalized_polished = WritingAgent._normalize_citation_marker_style(normalized_polished, lang=lang)
    if normalized_polished != polished:
        polished = normalized_polished
        report["after"] = audit_manuscript_style(polished)
    final_guard_issues = preservation_guard_issues(original, polished, "Manuscript polish final output")
    final_guard_applied = bool(final_guard_issues)
    if final_guard_applied:
        issue_codes = []
        for issue in final_guard_issues:
            code = str(issue.get("code") or "").strip()
            if code and code not in issue_codes:
                issue_codes.append(code)
        report["issues"].extend(final_guard_issues)
        polished = original
        report["after"] = audit_manuscript_style(polished)
    else:
        issue_codes = []
    polished = WritingAgent._normalize_figure_heading_spacing(polished)
    # Final cross-section dedup runs after citation backfill and after the
    # preservation guard; removing a verbatim duplicate keeps the first occurrence,
    # so every unique fact and citation is preserved.
    polished = remove_near_duplicate_sentences(polished, cross_section=True)
    polished, final_validation = _finalize_manuscript_after_postprocessing(project, polished, lang=lang)
    polished = WritingAgent(lang=lang)._normalize_structured_abstract_spacing(polished)
    length_floor_guard = _publication_length_soft_target(project, original, polished)
    report["final_preservation_guard"] = {
        "schema_version": 1,
        "checked": True,
        "applied": final_guard_applied,
        "kept_original": final_guard_applied,
        "issue_count": len(final_guard_issues),
        "issue_codes": issue_codes,
        "review_action": (
            "kept_unpolished_manuscript_after_post_processing_guard"
            if final_guard_applied else
            "accepted_fact_preserving_polish"
        ),
    }
    report["post_polish_citation_backfill"] = {
        "applied": citation_backfill_applied,
        "mode": "reference_role_aware_inline_citation_backfill",
    }
    report["publication_body_cleanup"] = {
        "applied": publication_body_cleanup_applied,
        "mode": "remove_process_framed_main_text_before_citation_backfill",
    }
    report["length_floor_guard"] = length_floor_guard
    report["post_polish_citation_audit_backfill"] = audit_backfill_summary
    report["final_validation"] = {
        "passed": bool(final_validation.get("passed", False)),
        "issue_count": len(final_validation.get("issues", []) or []),
    }
    project.save_json("manuscript_polish_audit.json", report, subdir="manuscript")
    if polished != original:
        project.save_text("draft.unpolished.md", original, subdir="manuscript")
        project.save_text("draft.md", polished, subdir="manuscript")
    elif draft_path.read_text(encoding="utf-8", errors="replace") != original:
        project.save_text("draft.md", original, subdir="manuscript")
    return polished


def _publication_length_soft_target(project: Project, original: str, polished: str) -> dict:
    facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    facts = facts if isinstance(facts, dict) else {}
    constraints = facts.get("writing_constraints") if isinstance(facts.get("writing_constraints"), dict) else {}
    try:
        minimum_main_words = int((constraints or {}).get("publication_min_main_words") or 0)
    except (TypeError, ValueError):
        minimum_main_words = 0
    original_main_words = WritingAgent._main_manuscript_word_count(original)
    candidate_main_words = WritingAgent._main_manuscript_word_count(polished)
    return {
        "schema_version": 1,
        "applied": False,
        "minimum_main_words": minimum_main_words,
        "original_main_words": original_main_words,
        "candidate_main_words": candidate_main_words,
        "soft_target": True,
        "below_target_after_polish": (
            minimum_main_words > 0
            and candidate_main_words < minimum_main_words
        ),
    }


def _apply_post_polish_citation_audit_backfill(
    project: Project,
    polished: str,
    *,
    lang: str = "en",
    max_iterations: int = 2,
) -> tuple[str, dict]:
    """Use citation-audit recommended citations as a final conservative post-polish pass."""
    draft_path = project.base_dir / "manuscript" / "draft.md"
    draft_path.parent.mkdir(parents=True, exist_ok=True)
    abstract_formatter = WritingAgent(lang=lang)

    def _normalize_for_draft_write(value: str) -> str:
        return abstract_formatter._normalize_structured_abstract_spacing(str(value or ""))

    current = _normalize_for_draft_write(str(polished or ""))
    draft_path.write_text(current, encoding="utf-8")
    summary = {
        "schema_version": 1,
        "applied": False,
        "mode": "citation_audit_recommended_sentence_backfill",
        "iterations": 0,
        "applied_citation_recommendations": 0,
        "applied_citation_cleanup": False,
        "post_cleanup_repair_recommendations": 0,
        "post_repair_density_cleanup": False,
        "dominant_primary_trial_citation_cleanup": False,
        "warning_issues_before": 0,
        "warning_issues_after": 0,
    }
    try:
        from new_meta.core.artifact_package import _build_citation_audit_review
    except Exception as exc:  # pragma: no cover - defensive packaging guard
        summary["error"] = str(exc)
        return current, summary

    initial_audit = _build_citation_audit_review(project)
    if isinstance(initial_audit, dict):
        summary["warning_issues_before"] = int((initial_audit.get("summary") or {}).get("warning_issues") or 0)

    for iteration in range(max(0, int(max_iterations or 0))):
        audit = _build_citation_audit_review(project)
        if not isinstance(audit, dict):
            break
        updated, applied = WritingAgent._backfill_citation_audit_recommendations(current, audit)
        if not applied or updated == current:
            break
        current = _normalize_for_draft_write(updated)
        summary["iterations"] = iteration + 1
        summary["applied_citation_recommendations"] += applied
        summary["applied"] = True
        draft_path.write_text(current, encoding="utf-8")

    # Final post-polish cleanup should narrow repeated broad citation bundles rather
    # than rotate them into other broad bundles that may already appear elsewhere.
    cleaned = WritingAgent._limit_repeated_large_citation_clusters(
        current,
    )
    cleaned = WritingAgent._merge_adjacent_citation_clusters(
        cleaned,
        max_cluster_size=5,
        trim_overloaded=True,
    )
    cleaned = WritingAgent._limit_repeated_large_citation_clusters(
        cleaned,
    )
    cleaned = WritingAgent._smooth_mechanical_citation_density(cleaned)
    if cleaned != current:
        current = _normalize_for_draft_write(cleaned)
        summary["applied"] = True
        summary["applied_citation_cleanup"] = True
        draft_path.write_text(current, encoding="utf-8")

    post_cleanup_audit = _build_citation_audit_review(project)
    if isinstance(post_cleanup_audit, dict):
        repaired, repaired_count = WritingAgent._backfill_citation_audit_recommendations(current, post_cleanup_audit)
        if repaired_count and repaired != current:
            current = _normalize_for_draft_write(repaired)
            summary["applied"] = True
            summary["post_cleanup_repair_recommendations"] = repaired_count
            draft_path.write_text(current, encoding="utf-8")
            capped = WritingAgent._cap_excessive_global_citation_density(current)
            if capped != current:
                current = _normalize_for_draft_write(capped)
                summary["applied"] = True
                summary["applied_citation_cleanup"] = True
                summary["post_repair_density_cleanup"] = True
                draft_path.write_text(current, encoding="utf-8")

    dominant_capped = WritingAgent._cap_dominant_primary_trial_citations_from_references(current)
    if dominant_capped != current:
        current = _normalize_for_draft_write(dominant_capped)
        summary["applied"] = True
        summary["applied_citation_cleanup"] = True
        summary["dominant_primary_trial_citation_cleanup"] = True
        draft_path.write_text(current, encoding="utf-8")

    final_audit = _build_citation_audit_review(project)
    if isinstance(final_audit, dict):
        summary["warning_issues_after"] = int((final_audit.get("summary") or {}).get("warning_issues") or 0)
    return current, summary


def _manuscript_polish_proofreader():
    if MANUSCRIPT_POLISH_PROOFREADER != "languagetool" or not LANGUAGETOOL_URL:
        return None
    return LanguageToolProofreader(
        LANGUAGETOOL_URL,
        timeout_seconds=LANGUAGETOOL_TIMEOUT_SECONDS,
    ).check


def _llm_polish_rewriter(*, model: str | None, lang: str):
    client = LLMClient(model=model)

    def rewrite(section_text: str, meta: dict) -> str:
        heading = str(meta.get("heading") or "")
        style_targets = meta.get("style_targets") or {}
        template_phrases = ", ".join(style_targets.get("template_phrases") or [])
        retry_issue_codes = [
            str(item).strip()
            for item in (meta.get("preservation_issue_codes") or [])
            if str(item).strip()
        ]
        rejected_candidate_excerpt = " ".join(str(meta.get("rejected_candidate_excerpt") or "").split())[:500]
        retry_instruction_en = ""
        retry_instruction_zh = ""
        if meta.get("retry_after_preservation_rejection"):
            issue_text = ", ".join(retry_issue_codes) or "fact-preservation guard failure"
            retry_instruction_en = (
                " Previous rewrite attempt was rejected by the fact-preservation guard for: "
                f"{issue_text}. Preserve the original numbers and citation markers exactly"
                ", keep the same clinical meaning, and make only safe wording changes."
            )
            retry_instruction_zh = (
                " 上一次润色候选被事实保护闸拒绝，原因："
                f"{issue_text}。请严格保留原始数字、P值、CI、效应量、引用编号和临床含义，只做安全的文字调整。"
            )
            if rejected_candidate_excerpt:
                retry_instruction_en += f" Rejected candidate excerpt: {rejected_candidate_excerpt}."
                retry_instruction_zh += f" 被拒候选片段：{rejected_candidate_excerpt}。"
        style_instruction_en = (
            "Style target: reduce formulaic or generic prose by removing template phrases, varying sentence "
            "openings and sentence length, and making transitions specific to the evidence. "
            "Keep each citation marker attached to the same sentence and claim it supported in the source text. "
            "Preserve protected clinical terms and acronyms exactly, including population labels, interventions, "
            "comparators, outcomes, study acronyms, statistical model names, and certainty ratings. "
            "Do not shorten the section by more than 20%; polish wording without deleting clinical reasoning, "
            "limitations, or source-supported context. "
            "Do not optimize for AI detectors or add unsupported claims. "
        )
        style_instruction_zh = (
            "风格目标：减少模板化生成腔，避免重复句首，适度变化句长，让转承更贴合证据本身。"
            "引用编号必须留在原句和原声明之后，不要移动到相邻句或段落。"
            "保护性临床术语和缩写必须原样保留，包括人群标签、干预、对照、结局、研究缩写、统计模型名称和证据确定性评级。"
            "不要把段落压缩超过20%；润色措辞即可，不要删除临床推理、局限性或有来源支持的语境。"
            "不要针对AI检测器做规避优化，也不要添加原文没有的判断。"
        )
        if template_phrases:
            style_instruction_en += f" Template phrases to remove where possible: {template_phrases}."
            style_instruction_zh += f" 尽量移除这些模板短语：{template_phrases}。"
        if lang == "zh":
            instruction = (
                "请对下面的系统综述/Meta分析稿件段落做保守的中文学术润色。"
                "可以改善句式、减少模板腔、提升自然度和可读性，但不得改变任何数字、P值、CI、"
                "效应量、表图编号、引用编号、研究名称、方向性结论或Markdown结构。"
                "不得强化结论：不要把“相关/associated with/HR为0.81”改成“降低风险/reduced risk/"
                "lower risk/有获益”等更强的因果或方向性表述；原文没有 lower/reduced/decreased 时不要新增。"
                "不得新增NNT、ARR、风险差、绝对风险差、需治数或其它原文没有的临床指标。"
                f"{retry_instruction_zh}"
                f"{style_instruction_zh}"
                "只返回润色后的段落正文，不要解释。"
            )
        else:
            instruction = (
                "Conservatively polish the following systematic-review/meta-analysis manuscript section. "
                "Improve academic flow, remove template phrasing, and reduce repetitive generated prose, "
                "but do not change any numbers, P values, CIs, effect estimates, table/figure labels, "
                "citation markers, study names, directional conclusions, or Markdown structure. "
                "Do not strengthen conclusions: do not rewrite 'associated with' or 'HR 0.81' as "
                "'reduced risk', 'lower risk', 'benefit', or other stronger causal/directional language; "
                "if the original text does not already say lower/reduced/decreased, do not add those terms. "
                "Do not introduce NNT, ARR, risk difference, absolute risk difference, number needed to treat, "
                "or other clinical metrics not already present in the source section. "
                f"{retry_instruction_en}"
                f"{style_instruction_en}"
                "Return only the polished section body, with no explanation."
            )
        messages = [
            {"role": "system", "content": "You are a conservative scientific copyeditor. Preserve facts exactly."},
            {"role": "user", "content": f"{instruction}\n\nSECTION: {heading}\n\n{section_text}"},
        ]
        return client.chat(messages, temperature=0.2, max_tokens=6000) or section_text

    return rewrite


def _search_evidence_context_with_fallbacks(protocol: ResearchProtocol, query: str) -> dict:
    contexts = []
    for candidate in _evidence_context_query_candidates(protocol, query):
        context = search_evimed_evidence(candidate)
        contexts.append(context)
        if len(context.get("references") or []) >= 3:
            break
    merged = _merge_evidence_contexts(query, contexts)
    return merged if merged.get("references") else (contexts[-1] if contexts else {"status": "error", "query": query, "references": []})


def _evidence_context_query_candidates(protocol: ResearchProtocol, query: str) -> list[str]:
    candidates = [query]
    population = str(getattr(protocol.pico, "population", "") or "").lower()
    intervention = _intervention_search_terms(getattr(protocol.pico, "intervention", ""))
    if "covid" in population or "sars-cov-2" in population or "coronavirus" in population:
        candidates.extend([
            f"{intervention} critically ill COVID-19 mortality randomized trial guideline meta-analysis",
            "surviving sepsis campaign COVID-19 ICU corticosteroids guideline",
            f"{intervention} COVID-19 ICU guideline systematic review meta-analysis",
        ])
    else:
        candidates.extend([
            f"{intervention} guideline systematic review meta-analysis",
            f"{intervention} clinical guideline randomized trial",
        ])
    out: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        cleaned = " ".join(str(candidate or "").split())
        key = cleaned.lower()
        if cleaned and key not in seen:
            out.append(cleaned[:260])
            seen.add(key)
    return out


def _merge_evidence_contexts(query: str, contexts: list[dict]) -> dict:
    references = []
    seen: set[str] = set()
    status = "ok" if any(context.get("status") == "ok" for context in contexts) else "error"
    counts: dict[str, int] = {}
    attempted = []
    for context in contexts:
        attempted.append({"query": context.get("query", ""), "status": context.get("status"), "counts": context.get("counts")})
        for key, value in (context.get("counts") or {}).items():
            if isinstance(value, int):
                counts[key] = counts.get(key, 0) + value
        for item in context.get("references") or []:
            paper = item.get("paper") or {}
            identity = str(paper.get("doi") or paper.get("pmid") or paper.get("url") or item.get("study_id") or item.get("title") or "").lower()
            if not identity or identity in seen:
                continue
            seen.add(identity)
            references.append(item)
    counts["normalized"] = len(references)
    return {
        "status": status,
        "query": query,
        "references": references,
        "counts": counts,
        "attempted_queries": attempted,
    }


def _filter_evidence_context_references(protocol: ResearchProtocol, references: list[dict]) -> list[dict]:
    """Remove obvious population-mismatched background refs from broad evidence API output."""
    population = str(getattr(protocol.pico, "population", "") or "").lower()
    wants_child = any(term in population for term in ("child", "children", "pediatric", "paediatric", "adolescent", "newborn"))
    wants_pregnancy = any(term in population for term in ("pregnan", "maternal", "obstetric"))
    wants_covid = any(term in population for term in ("covid", "sars-cov-2", "coronavirus"))
    wants_systemic_steroid = wants_covid and any(
        term in str(getattr(protocol.pico, "intervention", "") or "").lower()
        for term in ("systemic corticosteroid", "corticosteroid", "dexamethasone", "hydrocortisone", "methylprednisolone", "glucocorticoid")
    )
    relevance = _evidence_context_relevance_terms(protocol)
    filtered: list[dict] = []
    for item in references:
        title = " ".join([
            str(item.get("title") or ""),
            str((item.get("paper") or {}).get("title") or ""),
            str(item.get("summary") or ""),
        ]).lower()
        title_only = " ".join([
            str(item.get("title") or ""),
            str((item.get("paper") or {}).get("title") or ""),
        ]).lower()
        if not wants_child and re.search(r"\b(child|children|pediatric|paediatric|adolescent|newborn|neonatal)\b", title):
            continue
        if not wants_pregnancy and re.search(r"\b(pregnan\w*|maternal|obstetric)\b", title):
            continue
        if wants_covid and not re.search(r"\b(covid|sars[- ]?cov[- ]?2|coronavirus)\b", title):
            continue
        if wants_systemic_steroid and not _covid_systemic_steroid_background_title_is_relevant(title_only):
            continue
        if _protocol_is_sglt2_heart_failure(protocol) and not re.search(
            r"\bheart failure\b|\bhfpef\b|\bhfmref\b|\bejection fraction\b",
            title_only,
        ):
            continue
        if not wants_covid and not _protocol_is_sglt2_heart_failure(protocol):
            if not _generic_background_reference_matches_protocol(protocol, title):
                continue
        if not _evidence_context_reference_is_relevant(title, relevance):
            continue
        filtered.append(item)
    return filtered


def _covid_systemic_steroid_background_title_is_relevant(title: str) -> bool:
    """Keep COVID steroid background citations on treatment evidence, not complications or unrelated drugs."""
    text = str(title or "").lower()
    if not re.search(r"\b(covid|sars[- ]?cov[- ]?2|coronavirus)\b", text):
        return False
    if re.search(
        r"\b("
        r"hypophysitis|vasculitis|mucormycosis|thyroiditis|hearing loss|sensorineural|"
        r"alopecia|nephrotic|vaccine|vaccination|tocilizumab|baricitinib|inhaled"
        r")\b",
        text,
    ):
        return False
    if re.search(r"\b(corticosteroid\w*|dexamethasone|hydrocortisone|methylprednisolone|glucocorticoid\w*|steroid\w*)\b", text):
        return True
    if re.search(r"\b(icu|critical(?:ly)? ill|severe|surviving sepsis|guideline|guidelines)\b", text):
        return True
    return False


def _evidence_context_relevance_terms(protocol: ResearchProtocol) -> dict[str, list[str]]:
    fields = " ".join([
        str(getattr(protocol, "research_question", "") or ""),
        str(getattr(protocol.pico, "population", "") or ""),
        str(getattr(protocol.pico, "intervention", "") or ""),
        str(getattr(protocol.pico, "outcome_primary", "") or ""),
    ]).lower()
    strong: set[str] = set()
    if re.search(r"\b(?:sglt2|gliflozin|empagliflozin|dapagliflozin|canagliflozin|ertugliflozin|sotagliflozin)\b", fields):
        strong.update([
            r"\bsglt2\b",
            r"\bgliflozin\w*\b",
            r"\b(?:empagliflozin|dapagliflozin|canagliflozin|ertugliflozin|sotagliflozin)\b",
        ])
    if re.search(r"\b(?:heart failure|hfpef|hfmref|ejection fraction|lvef)\b", fields):
        strong.update([
            r"\bheart failure\b",
            r"\bhfpef\b",
            r"\bhfmref\b",
            r"\bejection fraction\b",
            r"\blvef\b",
        ])
    if re.search(r"\b(?:covid|sars[- ]?cov[- ]?2|coronavirus)\b", fields):
        strong.update([r"\bcovid(?:-19)?\b", r"\bsars[- ]?cov[- ]?2\b", r"\bcoronavirus\b"])
    tokens = sorted(_evidence_context_keyword_tokens(fields))
    return {"strong": sorted(strong), "tokens": [rf"\b{re.escape(token)}\b" for token in tokens]}


def _evidence_context_keyword_tokens(text: str) -> set[str]:
    stopwords = {
        "adult", "adults", "patient", "patients", "people", "with", "without", "compared",
        "compare", "effect", "effects", "outcome", "outcomes", "primary", "secondary",
        "placebo", "usual", "care", "treatment", "therapy", "intervention", "control",
        "mildly", "reduced", "preserved", "versus", "among", "whether", "does", "improve",
        "lower", "decrease", "increase", "reduce", "risk", "clinical", "trial", "randomized",
        "background", "guideline", "guidelines", "including", "first", "standard", "criteria",
        "confirmed", "contemporary", "meeting", "approved", "administered", "formulation",
        "monotherapy", "combination", "index", "score", "years", "alone", "change", "baseline",
        "summary", "pharmacological", "diagnostic", "cardiac", "failure", "death",
    }
    return {
        token
        for token in re.findall(r"[a-z][a-z0-9+-]{4,}", str(text or "").lower())
        if token not in stopwords
    }


def _evidence_context_reference_is_relevant(text: str, relevance: dict[str, list[str]]) -> bool:
    strong = relevance.get("strong") or []
    tokens = relevance.get("tokens") or []
    if not strong and not tokens:
        return True
    if any(re.search(pattern, text, flags=re.I) for pattern in strong):
        return True
    token_hits = sum(1 for pattern in tokens if re.search(pattern, text, flags=re.I))
    if len(tokens) <= 1:
        return token_hits >= 1
    return token_hits >= 2


def _generic_background_reference_matches_protocol(protocol: ResearchProtocol, text: str) -> bool:
    """Require clinical background refs to match intervention or outcome plus context."""
    haystack = str(text or "").lower()
    intervention = str(getattr(protocol.pico, "intervention", "") or "")
    outcome = str(getattr(protocol.pico, "outcome_primary", "") or "")
    population = str(getattr(protocol.pico, "population", "") or "")
    intervention_drop = {
        "administered", "dose", "dosing", "intravenous", "oral", "perioperative",
        "postoperative", "preoperative", "intraoperative", "prophylactic", "regimen",
        "surgery", "therapeutic", "treatment",
    }
    outcome_drop = {"incidence", "primary", "outcome", "postoperative"}
    population_drop = {"adults", "aged", "older", "patients", "undergoing", "years"}
    intervention_tokens = _evidence_context_keyword_tokens(intervention) - intervention_drop
    outcome_tokens = _evidence_context_keyword_tokens(outcome) - outcome_drop
    population_tokens = _evidence_context_keyword_tokens(population) - population_drop

    def matches(tokens: set[str]) -> bool:
        return any(re.search(rf"\b{re.escape(token)}\b", haystack) for token in tokens)

    intervention_match = matches(intervention_tokens)
    outcome_match = matches(outcome_tokens)
    population_match = matches(population_tokens)
    if intervention_tokens and outcome_tokens:
        return (intervention_match and (outcome_match or population_match)) or (outcome_match and population_match)
    if intervention_tokens:
        return intervention_match and population_match
    if outcome_tokens:
        return outcome_match and population_match
    return population_match


def _background_reference_title_key(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(title or "").lower()).strip()


def _pubmed_background_references(protocol: ResearchProtocol, *, max_results: int = 6) -> list[dict]:
    """Fetch PubMed background references when Evimed returns too few usable citations."""
    query = _pubmed_background_query(protocol)
    try:
        pmids = pubmed.search(query, max_results=max_results)
        papers = pubmed.fetch_details(pmids)
    except Exception as exc:
        logger.warning("PubMed background evidence fallback failed: %s", exc)
        return []
    refs = []
    for paper in papers:
        if not _background_paper_matches_protocol(protocol, paper):
            continue
        pmid = str(paper.get("pmid") or "").strip()
        title = str(paper.get("title") or "").strip()
        if not pmid or not title:
            continue
        refs.append({
            "study_id": f"pubmed_background:{pmid}",
            "source_type": "pubmed_background",
            "title": title,
            "summary": str(paper.get("abstract") or "")[:600],
            "paper": {
                **paper,
                "source": "pubmed_background",
            },
        })
    return refs


def _pubmed_background_query(protocol: ResearchProtocol) -> str:
    population = str(getattr(protocol.pico, "population", "") or "").lower()
    intervention = str(getattr(protocol.pico, "intervention", "") or "").lower()
    if "covid" in population or "sars-cov-2" in population or "coronavirus" in population:
        if "corticosteroid" in intervention or "dexamethasone" in intervention or "hydrocortisone" in intervention:
            treatment = (
                "corticosteroid*[Title/Abstract] OR dexamethasone[Title/Abstract] "
                "OR hydrocortisone[Title/Abstract] OR methylprednisolone[Title/Abstract] "
                "OR glucocorticoid*[Title/Abstract]"
            )
        else:
            treatment = f"{_compact_search_field(intervention, max_words=3)}[Title/Abstract]"
        disease = "COVID-19[Title/Abstract] OR SARS-CoV-2[Title/Abstract] OR coronavirus[Title/Abstract]"
        return (
            f"({treatment}) AND ({disease}) AND "
            "(guideline[Publication Type] OR practice guideline[Publication Type] "
            "OR systematic review[Publication Type] OR meta-analysis[Publication Type])"
        )
    if _text_mentions_sglt2(intervention):
        treatment = (
            "SGLT2[Title/Abstract] OR \"sodium-glucose cotransporter 2\"[Title/Abstract] "
            "OR \"sodium-glucose cotransporter-2\"[Title/Abstract] OR gliflozin*[Title/Abstract] "
            "OR empagliflozin[Title/Abstract] OR dapagliflozin[Title/Abstract] "
            "OR canagliflozin[Title/Abstract] OR ertugliflozin[Title/Abstract] OR sotagliflozin[Title/Abstract]"
        )
        disease = (
            "\"heart failure\"[Title/Abstract] OR HFpEF[Title/Abstract] OR HFmrEF[Title/Abstract] "
            "OR \"preserved ejection fraction\"[Title/Abstract] "
            "OR \"mildly reduced ejection fraction\"[Title/Abstract]"
        )
        return (
            f"({treatment}) AND ({disease}) AND "
            "(guideline[Publication Type] OR practice guideline[Publication Type] "
            "OR systematic review[Publication Type] OR meta-analysis[Publication Type] "
            "OR guideline[Title/Abstract] OR \"systematic review\"[Title/Abstract] "
            "OR meta-analysis[Title/Abstract])"
        )
    base_query = _evidence_context_query(protocol)
    return (
        f'({base_query}) AND (guideline[Publication Type] OR practice guideline[Publication Type] '
        'OR systematic review[Publication Type] OR meta-analysis[Publication Type])'
    )


def _background_paper_matches_protocol(protocol: ResearchProtocol, paper: dict) -> bool:
    text = " ".join([
        str(paper.get("title") or ""),
        str(paper.get("abstract") or ""),
    ]).lower()
    population = str(getattr(protocol.pico, "population", "") or "").lower()
    intervention = str(getattr(protocol.pico, "intervention", "") or "").lower()
    title = str(paper.get("title") or "").lower()
    if "covid" in population or "sars-cov-2" in population or "coronavirus" in population:
        if not re.search(r"\b(covid|sars[- ]?cov[- ]?2|coronavirus)\b", text):
            return False
        if re.search(r"\b(child|children|pediatric|paediatric|adolescent|newborn|neonatal|pregnan\w*|maternal|obstetric|olfactory)\b", text):
            return False
        if any(term in population for term in ("icu", "intensive care", "critically ill", "critical")) and re.search(r"\b(mild or moderate|nonsevere|non-severe)\b", text):
            return False
    if "corticosteroid" in intervention or "dexamethasone" in intervention or "hydrocortisone" in intervention:
        if not _covid_systemic_steroid_background_title_is_relevant(title):
            return False
        return bool(re.search(r"\b(corticosteroid\w*|dexamethasone|hydrocortisone|methylprednisolone|glucocorticoid\w*)\b", text))
    if _protocol_is_sglt2_heart_failure(protocol) and not re.search(
        r"\bheart failure\b|\bhfpef\b|\bhfmref\b|\bejection fraction\b",
        title,
    ):
        return False
    if not any(term in population for term in ("covid", "sars-cov-2", "coronavirus")) and not _protocol_is_sglt2_heart_failure(protocol):
        if not _generic_background_reference_matches_protocol(protocol, text):
            return False
    return _evidence_context_reference_is_relevant(text, _evidence_context_relevance_terms(protocol))


def _protocol_is_sglt2_heart_failure(protocol: ResearchProtocol) -> bool:
    fields = " ".join([
        str(getattr(protocol.pico, "population", "") or ""),
        str(getattr(protocol.pico, "intervention", "") or ""),
        str(getattr(protocol.pico, "outcome_primary", "") or ""),
    ]).lower()
    has_sglt2 = _text_mentions_sglt2(fields)
    has_hf = bool(re.search(r"\bheart failure\b|\bhfpef\b|\bhfmref\b|\bejection fraction\b", fields))
    return has_sglt2 and has_hf


def _text_mentions_sglt2(text: str) -> bool:
    return bool(re.search(SGLT2_TEXT_PATTERN, str(text or "").lower(), flags=re.I))


def _augment_with_known_source_recovery(
    protocol: ResearchProtocol,
    extracted_studies: list[ExtractedStudy],
    project: Project,
    *,
    run_mode: RunMode | str = RunMode.REVIEW,
) -> list[ExtractedStudy]:
    """Attach deterministic, auditable source rows for known registry-first evidence."""
    mode = configure_project_run_mode(project, normalize_run_mode(run_mode))
    if mode is not RunMode.BENCHMARK:
        return extracted_studies

    before_studies = len(extracted_studies)
    before_outcomes = sum(len(study.outcomes) for study in extracted_studies)
    try:
        augmented = augment_with_known_source_evidence(protocol, extracted_studies, project)
    except Exception as exc:
        logger.exception("Known source recovery failed")
        project.add_warning(
            "extraction",
            f"Known source recovery failed and was skipped: {exc}",
            code="known_source_recovery_failed",
            severity="warning",
        )
        return extracted_studies

    after_outcomes = sum(len(study.outcomes) for study in augmented)
    added_studies = len(augmented) - before_studies
    added_outcomes = after_outcomes - before_outcomes
    prefs = known_source_protocol_preferences(protocol)
    if prefs:
        project.save_json("known_source_protocol_preferences.json", prefs, subdir="extraction")
        reference_manifest = known_source_reference_manifest(protocol)
        if reference_manifest:
            project.save_json("known_source_reference_set.json", reference_manifest, subdir="extraction")
        override_result = apply_protocol_override(
            project,
            protocol,
            {
                key: prefs[key]
                for key in ("effect_measure", "model_preference", "tau_estimator")
                if prefs.get(key)
            },
            reason=(
                "Benchmark comparator preference: "
                f"{prefs.get('source_label') or prefs.get('source_id') or 'known source'}"
            ),
            updated_by="known_source_recovery",
        )
        compile_project_method_plan(
            project,
            protocol,
            allow_validating=True,
            enforce=True,
        )
    if added_studies or added_outcomes:
        print(
            "Known source evidence added "
            f"{added_outcomes} auditable primary outcome row(s) "
            f"across {added_studies} new study record(s)."
        )
    return augmented


def _reconcile_project_rct_designs(
    project: Project,
    protocol: ResearchProtocol,
    extracted_studies: list[ExtractedStudy],
    parsed_papers: dict[str, dict],
    *,
    allow_validating: bool,
) -> dict:
    """Persist extraction-discovered RCT dependencies and recompile routing."""
    previous_plan = project.load_json("method_plan.json", subdir="analysis") or {}
    report = reconcile_extracted_rct_designs(
        protocol,
        extracted_studies,
        parsed_papers=parsed_papers,
    )
    project.save_json("rct_design_reconciliation.json", report, subdir="extraction")
    if report.get("changed"):
        project.save_json("protocol.json", protocol)
        project.save_json("all_extractions.json", extracted_studies, subdir="extraction")
        for study in extracted_studies:
            sid = study.characteristics.pmid or study.characteristics.study_id
            if sid:
                project.save_json(f"{safe_identifier(sid)}.json", study, subdir="extraction")
        audit = DataExtractionAgent._build_extraction_audit(extracted_studies)
        old_audit = project.load_json("extraction_audit.json", subdir="extraction") or {}
        for key in ("overrides_revision", "overrides_applied"):
            if key in (old_audit.get("summary") or {}):
                audit["summary"][key] = old_audit["summary"][key]
        project.save_json("extraction_audit.json", audit, subdir="extraction")
        project.save_text(
            "extraction_audit.md",
            DataExtractionAgent._audit_to_markdown(audit),
            subdir="extraction",
        )
        migrate_extractions_to_ledger(
            project,
            protocol=protocol,
            extracted_studies=extracted_studies,
            change_reason="RCT design dependency reconciliation",
        )

    plan = compile_project_method_plan(
        project,
        protocol,
        allow_validating=allow_validating,
        enforce=True,
    )
    if report.get("changed") or previous_plan.get("plan_fingerprint") != plan.plan_fingerprint:
        project.clear_downstream("effect_sizes", include_self=True)
    report["compiled_capability_id"] = plan.capability_id
    report["compiled_plan_fingerprint"] = plan.plan_fingerprint
    project.save_json("rct_design_reconciliation.json", report, subdir="extraction")
    return report


def _add_benchmark_references(ref_manager: ReferenceManager, extracted_studies: list[ExtractedStudy] | None = None) -> None:
    """Add source references needed for benchmark/registry-backed primary rows."""
    study_ids: set[str] = set()
    for study in extracted_studies or []:
        characteristics = getattr(study, "characteristics", None)
        for attr in ("study_id", "pmid", "doi"):
            value = str(getattr(characteristics, attr, "") or "").strip()
            if value:
                study_ids.add(value)
    has_benchmark_source = any(study_id.startswith("benchmark_source:") for study_id in study_ids)
    has_known_source = any(study_id.startswith("known_source:") for study_id in study_ids)
    has_dexa = _has_any_id(
        study_ids,
        "32799933",
        "10.1186/s13063-020-04643-1",
        "benchmark_source:dexa_covid_19",
        "known_source:dexa_covid_19",
    )
    if has_benchmark_source or has_known_source or has_dexa:
        _add_reference_if_absent(
            ref_manager,
            "benchmark:who_react",
            {
                "title": "Association Between Administration of Systemic Corticosteroids and Mortality Among Critically Ill Patients With COVID-19: A Meta-analysis",
                "authors": ["WHO REACT Working Group"],
                "journal": "JAMA",
                "year": "2020",
                "doi": "10.1001/jama.2020.17023",
            },
        )
    if has_dexa:
        _add_reference_if_absent(
            ref_manager,
            "32799933",
            {
                "title": "Efficacy of dexamethasone treatment for patients with the acute respiratory distress syndrome caused by COVID-19: study protocol for a randomized controlled trial",
                "authors": ["Villar J", "Confalonieri M", "Pastores SM", "Meduri GU"],
                "journal": "Trials",
                "year": "2020",
                "doi": "10.1186/s13063-020-04643-1",
            },
        )
    if "known_source:recovery" in study_ids:
        _add_reference_if_absent(
            ref_manager,
            "known_source:recovery",
            {
                "title": "Effect of Dexamethasone in Hospitalized Patients with COVID-19: Preliminary Report",
                "authors": ["Horby P", "Lim WS", "Emberson JR", "Mafham M", "Bell JL", "Linsell L"],
                "journal": "medRxiv",
                "year": "2020",
                "doi": "10.1101/2020.06.22.20137273",
            },
        )
    if _has_any_id(study_ids, "benchmark_source:covid_steroid", "known_source:covid_steroid"):
        _add_reference_if_absent(
            ref_manager,
            "benchmark_source:covid_steroid",
            {
                "title": "Low-dose Hydrocortisone in Patients With COVID-19 and Severe Hypoxia (COVID STEROID)",
                "authors": ["ClinicalTrials.gov"],
                "journal": "ClinicalTrials.gov",
                "year": "2020",
                "doi": "",
                "url": "https://clinicaltrials.gov/study/NCT04348305",
            },
        )
        _alias_reference_if_present(ref_manager, "known_source:covid_steroid", "benchmark_source:covid_steroid")
        _add_reference_if_absent(
            ref_manager,
            "benchmark:eudract_2020_001395_15",
            {
                "title": "COVID STEROID trial results. EudraCT number 2020-001395-15",
                "authors": ["EU Clinical Trials Register"],
                "journal": "EU Clinical Trials Register",
                "year": "2020",
                "doi": "",
                "url": "https://www.clinicaltrialsregister.eu/ctr-search/trial/2020-001395-15/results",
            },
        )
    if _has_any_id(study_ids, "benchmark_source:steroids_sari", "known_source:steroids_sari"):
        _add_reference_if_absent(
            ref_manager,
            "benchmark_source:steroids_sari",
            {
                "title": "Glucocorticoid Therapy for COVID-19 Critically Ill Patients With Severe Acute Respiratory Failure (Steroids-SARI)",
                "authors": ["ClinicalTrials.gov"],
                "journal": "ClinicalTrials.gov",
                "year": "2020",
                "doi": "",
                "url": "https://clinicaltrials.gov/study/NCT04244591",
            },
        )
        _alias_reference_if_present(ref_manager, "known_source:steroids_sari", "benchmark_source:steroids_sari")
        _add_reference_if_absent(
            ref_manager,
            "benchmark:covid_nma_steroids_sari",
            {
                "title": "Steroids-SARI trial living-data record",
                "authors": ["COVID-NMA initiative"],
                "journal": "COVID-NMA",
                "year": "2020",
                "doi": "",
                "url": "https://covid-nma.com/living_data/infos_participants_pharmaco.php?i=167",
            },
        )


def _load_parsed_papers_cache(project: Project) -> dict[str, dict]:
    """Load parsed full-text cache written by the pdf_parsing step."""
    parsed = project.load_json("parsed_papers.json", subdir="papers") or {}
    return parsed if isinstance(parsed, dict) else {}


def _save_parsed_papers_cache(project: Project, parsed_papers: dict[str, dict]) -> None:
    """Persist parsed full-text cache so resume does not reparse all PDFs."""
    project.save_json("parsed_papers.json", parsed_papers, subdir="papers")


def _parse_fulltext_source(project: Project, path: str, *, is_pdf: bool) -> tuple[dict, bool]:
    """Parse a downloaded/user full-text source through the per-file cache."""
    parser_version = f"{PDF_PARSE_CACHE_VERSION}_{'pdf' if is_pdf else 'text'}"
    parse_func = parse_pdf if is_pdf else parse_text_fulltext
    parser_used = "pdf_parser" if is_pdf else "text_fulltext_parser"
    return parse_file_with_cache(
        path,
        project.base_dir,
        parse_func=parse_func,
        parser_used=parser_used,
        parser_version=parser_version,
    )


def _load_cached_study_effects(project: Project) -> list[StudyEffect]:
    data = project.load_json("effect_sizes.json", subdir="analysis") or []
    return [StudyEffect.model_validate(item) for item in data]


def _load_cached_meta_results(project: Project) -> MetaAnalysisResults:
    return MetaAnalysisResults.model_validate(project.load_json("meta_results.json", subdir="analysis"))


def _load_cached_grade_profile(project: Project) -> GRADEProfile | None:
    data = project.load_json("grade_profile.json", subdir="analysis")
    return GRADEProfile.model_validate(data) if data else None


def _run_evidence_understanding(
    project: Project,
    model: str | None,
    *,
    included_papers: list[dict],
    parsed_papers: dict[str, dict],
    extracted_studies: list[ExtractedStudy],
    rob_results: list[StudyRoB],
    protocol: ResearchProtocol,
) -> None:
    """Build LLM source-grounded study intelligence for authoring."""
    cached = project.load_json("evidence_understanding.json", subdir="extraction")
    if project.is_step_done("evidence_understanding") and cached:
        print_step("9b", "Evidence Understanding [CACHED]")
        cards = cached.get("study_cards") if isinstance(cached, dict) else []
        print(f"Loaded evidence understanding for {len(cards or [])} study card(s)")
        return

    print_step("9b", "Evidence Understanding (LLM source reading)")
    try:
        agent = EvidenceUnderstandingAgent(model=model)
        report = agent.run(
            included_papers=included_papers,
            parsed_papers=parsed_papers,
            extracted_studies=extracted_studies,
            rob_results=rob_results,
            protocol=protocol,
            project=project,
        )
        print(f"Generated evidence understanding for {len(report.study_cards)} study card(s)")
        project.save_checkpoint("evidence_understanding")
    except Exception as exc:
        logger.warning(f"Evidence understanding failed: {exc}", exc_info=True)
        project.add_warning(
            "evidence_understanding",
            f"Evidence understanding failed; manuscript will use extraction-level study cards only: {exc}",
            code="evidence_understanding_failed",
        )


def _load_cached_resume_inputs(project: Project, args) -> tuple[
    ResearchProtocol,
    str,
    list[ExtractedStudy],
    list[StudyRoB],
    list[dict],
    dict,
    str,
]:
    protocol = ResearchProtocol.model_validate(project.load_json("protocol.json"))
    if args.analysis_type:
        protocol.analysis_type = args.analysis_type
    _apply_topic_date_range(protocol, args.topic)
    search_query = project.load_text("search_query.txt")
    extracted_studies = [
        ExtractedStudy.model_validate(item)
        for item in (project.load_json("all_extractions.json", subdir="extraction") or [])
    ]
    rob_results = [
        StudyRoB.model_validate(item)
        for item in (project.load_json("rob_results.json", subdir="risk_of_bias") or [])
    ]
    prisma_data = project.prisma.to_dict()
    included_papers = _load_included_papers_for_resume(project)
    lang = _resolve_output_language(args)
    return protocol, search_query, extracted_studies, rob_results, included_papers, prisma_data, lang


def _evaluate_evidence_gate_for_report(
    project: Project,
    protocol: ResearchProtocol,
    extracted_studies: list[ExtractedStudy],
    prisma_data: dict,
):
    """Evaluate evidence readiness and persist the manuscript fact-state audit."""
    gate_result = EvidenceGate(protocol).evaluate(extracted_studies)
    gate_result = _reconcile_gate_result_with_final_effect_sizes(project, gate_result)
    report_state = build_report_state(
        gate_result,
        extracted_studies,
        prisma_data,
        getattr(protocol, "date_range", "") or "",
    )
    project.save_json("evidence_gate_result.json", gate_result.model_dump(mode="json"), subdir="analysis")
    project.save_json("report_state.json", report_state.model_dump(mode="json"), subdir="analysis")
    return gate_result, report_state


def _final_effect_size_study_ids(project: Project) -> list[str]:
    """Return ordered unique study IDs from the persisted final primary effects."""
    rows = project.load_json("effect_sizes.json", subdir="analysis") or []
    ids: list[str] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        study_id = str(row.get("study_id") or "").strip()
        if study_id and study_id not in ids:
            ids.append(study_id)
    return ids


def _reconcile_gate_result_with_final_effect_sizes(project: Project, gate_result: GateResult) -> GateResult:
    """Use final selected effect-size rows as the manuscript-stage meta-eligible set."""
    final_ids = _final_effect_size_study_ids(project)
    if not final_ids:
        return gate_result

    evidence_classes = dict(gate_result.evidence_classes or {})
    evidence_tiers = dict(gate_result.evidence_tiers or {})
    outcome_tiers = dict(gate_result.outcome_tiers or {})
    final_set = set(final_ids)
    for study_id in final_ids:
        evidence_classes.setdefault(study_id, "direct_eligible_rct")
        evidence_tiers[study_id] = "direct_eligible_study"
        outcome_tiers[study_id] = "outcome_extractable"
    for study_id, tier in list(evidence_tiers.items()):
        if study_id in final_set:
            continue
        if tier == "direct_eligible_study":
            evidence_tiers[study_id] = "analyzable_primary_outcome"

    prisma_counts = dict(gate_result.prisma_counts or {})
    prisma_counts["direct_eligible"] = len(final_ids)
    prisma_counts["meta_eligible"] = len(final_ids)
    prisma_counts["analyzable_primary_outcome"] = max(
        int(prisma_counts.get("analyzable_primary_outcome") or 0),
        len(final_ids),
    )

    payload = gate_result.model_dump(mode="python")
    payload.update({
        "meta_eligible_studies": final_ids,
        "evidence_classes": evidence_classes,
        "evidence_tiers": evidence_tiers,
        "outcome_tiers": outcome_tiers,
        "prisma_counts": prisma_counts,
    })
    if len(final_ids) >= 2:
        payload["decision"] = GateDecision.META
        payload["summary"] = (
            f"纳入 {prisma_counts.get('full_text_assessed') or prisma_counts.get('search_results') or len(final_ids)} "
            f"项研究，{len(final_ids)} 项满足Meta分析条件，进入定量合并分析。"
        )
    return GateResult.model_validate(payload)


def _write_manuscript_from_artifacts(
    project: Project,
    args,
    model: str | None,
    *,
    protocol: ResearchProtocol,
    search_query: str,
    extracted_studies: list[ExtractedStudy],
    rob_results: list[StudyRoB],
    included_papers: list[dict],
    prisma_data: dict,
    lang: str,
    meta_results: MetaAnalysisResults,
    grade_profile: GRADEProfile | None,
) -> str:
    """Write references and manuscript from already-loaded analysis artifacts."""
    print_step("13", "Manuscript Generation")
    ref_manager = ReferenceManager()
    for paper in included_papers:
        ref_manager.add(paper, study_id=paper_identity(paper))
    _add_benchmark_references(ref_manager, extracted_studies)
    _add_evidence_context_references(project, protocol, ref_manager, search_query=search_query)
    _add_methodology_references(
        project,
        ref_manager,
        include_rob=bool(rob_results),
        include_grade=grade_profile is not None,
        include_publication_bias=True,
    )
    project.save_text("references.bib", ref_manager.to_bibtex())
    gate_result, report_state = _evaluate_evidence_gate_for_report(
        project,
        protocol,
        extracted_studies,
        prisma_data,
    )
    positioning = ensure_review_positioning(
        project=project,
        protocol=protocol,
        extracted_studies=extracted_studies,
        meta_results=meta_results,
    )
    print(f"Review positioning: {positioning.get('category', 'not_assessed')}")

    writer = WritingAgent(model=model, lang=lang, topic=args.topic)
    manuscript = writer.run(
        protocol=protocol,
        meta_results=meta_results,
        extracted_studies=extracted_studies,
        rob_results=rob_results,
        prisma_data=prisma_data,
        search_query=search_query,
        project=project,
        ref_manager=ref_manager,
        grade_profile=grade_profile,
        figures_b64=_load_figures_b64(project),
        evidence_classes=gate_result.evidence_classes,
        report_state=report_state,
    )
    project.save_text("references.bib", ref_manager.to_bibtex())
    manuscript = _polish_project_manuscript(project, args, model=model, lang=lang) or manuscript
    _run_final_manuscript_llm_readiness_review(project, model=model, lang=lang)
    project.save_checkpoint("manuscript")
    write_llm_usage_manifest(project)
    package_path = create_artifact_package(project)

    _finalize_cli_release(project, package_path, success_label="Complete!")
    figures_dir = project.base_dir / "figures"
    print(f"Project directory: {project.base_dir}")
    print(f"\nKey outputs:")
    print(f"  Manuscript:         {project.base_dir / 'manuscript' / 'draft.md'}")
    print(f"  Forest plot:        {figures_dir / 'forest_plot.png'}")
    print(f"  PRISMA 2020:        {figures_dir / 'prisma_diagram.png'}")
    print(f"  Artifact package:   {package_path}")
    if grade_profile:
        print(f"  GRADE profile:      {project.base_dir / 'analysis' / 'grade_profile.json'}")
    return manuscript


def _generate_narrative_figures(
    project: Project,
    *,
    prisma_data: dict,
    lang: str,
    force: bool = False,
) -> None:
    """Generate only figures that are valid for a non-pooled synthesis."""
    if project.is_step_done("figures") and not force:
        print_step("12", "Figure Generation [CACHED]")
        return
    print_step("12", "Figure Generation (narrative synthesis)")
    figures_dir = project.base_dir / "figures"
    figures_dir.mkdir(exist_ok=True)
    try:
        visualization.prisma_flow_diagram(
            prisma_data,
            str(figures_dir / "prisma_diagram.png"),
            lang=lang,
        )
        print("  Generated: prisma_diagram.png")
    except Exception as exc:
        logger.warning(f"PRISMA diagram generation failed: {exc}")
        project.add_warning("figures", f"PRISMA diagram generation failed: {exc}", code="prisma_diagram_failed")

    rob_summary = project.load_json("rob_summary.json", subdir="risk_of_bias")
    if rob_summary:
        try:
            visualization.rob_summary_plot(
                rob_summary,
                str(figures_dir / "rob_summary.png"),
                lang=lang,
            )
            print("  Generated: rob_summary.png")
        except Exception as exc:
            logger.warning(f"RoB summary plot generation failed: {exc}")
            project.add_warning("figures", f"RoB summary plot generation failed: {exc}", code="rob_summary_plot_failed")
    project.save_checkpoint("figures")


def _write_narrative_manuscript_from_artifacts(
    project: Project,
    args,
    model: str | None,
    *,
    protocol: ResearchProtocol,
    search_query: str,
    extracted_studies: list[ExtractedStudy],
    rob_results: list[StudyRoB],
    included_papers: list[dict],
    prisma_data: dict,
    lang: str,
    force_figures: bool = False,
) -> str:
    """Write and release a narrative review from verified cached artifacts."""
    _generate_narrative_figures(
        project,
        prisma_data=prisma_data,
        lang=lang,
        force=force_figures,
    )
    print_step("13", "Manuscript Generation (narrative synthesis)")
    ref_manager = ReferenceManager()
    for paper in included_papers:
        ref_manager.add(paper, study_id=paper_identity(paper))
    _add_benchmark_references(ref_manager, extracted_studies)
    _add_evidence_context_references(project, protocol, ref_manager, search_query=search_query)
    _add_methodology_references(
        project,
        ref_manager,
        include_rob=bool(rob_results),
        include_grade=False,
        include_publication_bias=False,
    )
    gate_result, report_state = _evaluate_evidence_gate_for_report(
        project,
        protocol,
        extracted_studies,
        prisma_data,
    )
    writer = WritingAgent(model=model, narrative_mode=True, topic=args.topic, lang=lang)
    manuscript = writer.run(
        protocol=protocol,
        extracted_studies=extracted_studies,
        rob_results=rob_results,
        prisma_data=prisma_data,
        search_query=search_query,
        project=project,
        ref_manager=ref_manager,
        figures_b64=_load_figures_b64(project),
        evidence_classes=gate_result.evidence_classes,
        report_state=report_state,
    )
    project.save_text("references.bib", ref_manager.to_bibtex())
    manuscript = _polish_project_manuscript(project, args, model=model, lang=lang) or manuscript
    _run_final_manuscript_llm_readiness_review(project, model=model, lang=lang)
    project.save_checkpoint("manuscript")
    write_llm_usage_manifest(project)
    package_path = create_artifact_package(project)
    _finalize_cli_release(
        project,
        package_path,
        success_label="Complete (Narrative Synthesis)",
    )
    print(f"Project directory: {project.base_dir}")
    print(f"  Manuscript: {project.base_dir / 'manuscript' / 'draft.md'}")
    print(f"  PRISMA 2020: {project.base_dir / 'figures' / 'prisma_diagram.png'}")
    if (project.base_dir / "figures" / "rob_summary.png").exists():
        print(f"  RoB summary: {project.base_dir / 'figures' / 'rob_summary.png'}")
    print(f"  Artifact package: {package_path}")
    print("  Note: Quantitative meta-analysis was not performed because fewer than two eligible effect estimates were available.")
    return manuscript


def _can_resume_from_cached_meta_analysis(project: Project) -> bool:
    """Return True when late-stage resume can start from cached meta_results."""
    if project.is_step_done("manuscript"):
        return False
    required_steps = ["protocol", "search_query", "extraction", "rob", "effect_sizes", "meta_analysis"]
    if not all(project.is_step_done(step) for step in required_steps):
        return False
    required_files = [
        project.base_dir / "protocol.json",
        project.base_dir / "search_query.txt",
        project.base_dir / "extraction" / "all_extractions.json",
        project.base_dir / "risk_of_bias" / "rob_results.json",
        project.base_dir / "analysis" / "effect_sizes.json",
        project.base_dir / "analysis" / "meta_results.json",
    ]
    return all(path.exists() for path in required_files)


def _can_resume_from_cached_effect_sizes(project: Project) -> bool:
    """Return True when resume can start from cached effect_sizes.json."""
    if project.is_step_done("manuscript") or project.is_step_done("meta_analysis"):
        return False
    required_steps = ["protocol", "search_query", "extraction", "rob", "effect_sizes"]
    if not all(project.is_step_done(step) for step in required_steps):
        return False
    required_files = [
        project.base_dir / "protocol.json",
        project.base_dir / "search_query.txt",
        project.base_dir / "extraction" / "all_extractions.json",
        project.base_dir / "risk_of_bias" / "rob_results.json",
        project.base_dir / "analysis" / "effect_sizes.json",
    ]
    return all(path.exists() for path in required_files)


def _run_grade_from_cached_meta(
    project: Project,
    model: str | None,
    *,
    protocol: ResearchProtocol,
    meta_results: MetaAnalysisResults,
    rob_results: list[StudyRoB],
    extracted_studies: list[ExtractedStudy],
    force: bool = False,
) -> GRADEProfile | None:
    from new_meta.core.result_rob import load_effective_rob_assessments

    effective_rob_results = load_effective_rob_assessments(project, rob_results)
    snapshot = build_grade_input_snapshot(
        project=project,
        protocol=protocol,
        meta_results=meta_results,
        rob_results=effective_rob_results,
        extracted_studies=extracted_studies,
    )
    if project.is_step_done("grade") and not force:
        grade_profile = _load_cached_grade_profile(project)
        if grade_profile and cached_grade_snapshot_matches(project, snapshot):
            print_step("11b", "GRADE Evidence Assessment [CACHED]")
            grade_profile = repair_grade_profile_with_snapshot(grade_profile, snapshot)
            project.save_json("grade_profile.json", grade_profile, subdir="analysis")
            project.save_json("grade_inputs_snapshot.json", snapshot, subdir="analysis")
            print(f"Loaded cached GRADE profile for {len(grade_profile.outcomes)} outcome(s)")
            return grade_profile
        if grade_profile:
            logger.warning("Cached GRADE profile invalidated because the selected evidence snapshot changed.")
            project.add_warning(
                "grade",
                "Cached GRADE profile invalidated because the selected evidence snapshot changed; rerunning GRADE.",
                code="grade_snapshot_changed",
                severity="warning",
            )

    print_step("11b", "GRADE Evidence Assessment")
    grade_profile = None
    try:
        grade_agent = GRADEAgent(model=model)
        grade_profile = grade_agent.run(
            meta_results=meta_results,
            rob_results=effective_rob_results,
            pub_bias=meta_results.publication_bias,
            studies=extracted_studies,
            protocol=protocol,
        )
        grade_profile = repair_grade_profile_with_snapshot(grade_profile, snapshot)
        project.save_json("grade_profile.json", grade_profile, subdir="analysis")
        save_grade_input_snapshot(
            project=project,
            protocol=protocol,
            meta_results=meta_results,
            rob_results=effective_rob_results,
            extracted_studies=extracted_studies,
        )
        for go in grade_profile.outcomes:
            domains_str = ", ".join(f"{d.domain}={d.rating}" for d in go.domains)
            print(f"  {go.outcome_name}: {go.certainty} ({domains_str})")
    except Exception as e:
        logger.warning(f"GRADE assessment failed: {e}")
        project.add_warning("grade", f"GRADE assessment failed: {e}", code="grade_failed")
    project.save_checkpoint("grade")
    return grade_profile


def _pool_primary_effects(
    study_effects: list[StudyEffect],
    protocol: ResearchProtocol,
):
    """Pool primary study effects using the protocol-specified model."""
    if protocol.model_preference == "fixed":
        return meta_engine.fixed_effect(study_effects, protocol.effect_measure, protocol.pico.outcome_primary)
    if protocol.tau_estimator == "REML":
        return meta_engine.random_effects_reml(study_effects, protocol.effect_measure, protocol.pico.outcome_primary)
    if protocol.tau_estimator == "HKSJ":
        return meta_engine.random_effects_hksj(study_effects, protocol.effect_measure, protocol.pico.outcome_primary)
    return meta_engine.random_effects_dl(study_effects, protocol.effect_measure, protocol.pico.outcome_primary)


def _meta_function_for_protocol(protocol: ResearchProtocol):
    if protocol.model_preference == "fixed":
        return meta_engine.fixed_effect
    if protocol.tau_estimator == "REML":
        return meta_engine.random_effects_reml
    if protocol.tau_estimator == "HKSJ":
        return meta_engine.random_effects_hksj
    return meta_engine.random_effects_dl


def _ensure_cached_model_artifacts(
    project: Project,
    protocol: ResearchProtocol,
    meta_results: MetaAnalysisResults,
) -> MetaAnalysisResults:
    """Backfill model decision/sensitivity artifacts for cached resume paths."""
    try:
        study_effects = _load_cached_study_effects(project)
    except Exception as exc:
        logger.warning("Could not load cached study effects for model sensitivity: %s", exc)
        return meta_results
    if len(study_effects) < 2:
        return meta_results
    try:
        known_source_preferences = project.load_json("known_source_protocol_preferences.json", subdir="extraction") or {}
        _, model_decision, model_sensitivity = build_model_decision_and_sensitivity(
            study_effects=study_effects,
            protocol=protocol,
            known_source_preferences=known_source_preferences,
        )
    except Exception as exc:
        logger.warning("Could not build cached model sensitivity artifacts: %s", exc)
        project.add_warning(
            "meta_analysis",
            f"Could not build model sensitivity artifacts from cached effects: {exc}",
            code="model_sensitivity_backfill_failed",
            severity="warning",
        )
        return meta_results

    project.save_json("model_decision.json", model_decision, subdir="analysis")
    project.save_json("model_sensitivity.json", model_sensitivity, subdir="analysis")
    meta_results = meta_results.model_copy(update={
        "model_decision": model_decision,
        "model_sensitivity": model_sensitivity,
    })
    project.save_json("meta_results.json", meta_results, subdir="analysis")
    return meta_results


def _run_meta_analysis_from_effects(
    project: Project,
    *,
    protocol: ResearchProtocol,
    extracted_studies: list[ExtractedStudy],
    study_effects: list[StudyEffect],
) -> MetaAnalysisResults:
    """Run Step 11 from cached study effects and persist meta_results.json."""
    print_step("11", "Meta-Analysis — Pooling, Heterogeneity, Sensitivity, Advanced Methods")
    if len(study_effects) < 2:
        raise ValueError("At least two cached study effects are required for quantitative meta-analysis.")

    known_source_preferences = project.load_json("known_source_protocol_preferences.json", subdir="extraction") or {}
    primary_result, model_decision, model_sensitivity = build_model_decision_and_sensitivity(
        study_effects=study_effects,
        protocol=protocol,
        known_source_preferences=known_source_preferences,
    )
    print(f"Primary Outcome: {protocol.pico.outcome_primary}")
    print(f"  Primary model decision: {model_decision.get('reason', primary_result.model)}")
    print(f"  Pooled {protocol.effect_measure}: {primary_result.pooled_effect:.3f} "
          f"(95% CI: {primary_result.ci_lower:.3f} to {primary_result.ci_upper:.3f})")
    print(f"  p-value: {primary_result.p_value:.4f}")
    print(f"  I²: {primary_result.i_squared:.1f}%, τ²: {primary_result.tau_squared:.4f}")

    loo_results = meta_engine.leave_one_out(
        study_effects, protocol.effect_measure, protocol.pico.outcome_primary,
        model=protocol.model_preference,
    )
    cumulative_results = meta_engine.cumulative_meta_analysis(
        study_effects, protocol.effect_measure, protocol.pico.outcome_primary,
        model=protocol.model_preference,
    )
    if cumulative_results:
        print(f"  Cumulative analysis: {len(cumulative_results)} steps")

    regression_results = []
    effect_map = {se.study_id: se for se in study_effects}
    for var_name in protocol.subgroup_variables:
        cov_values = []
        cov_studies = []
        for study in extracted_studies:
            sid = study.characteristics.pmid or study.characteristics.study_id
            se = effect_map.get(sid)
            if se is None:
                continue
            try:
                raw_val = getattr(study.characteristics, var_name, None)
                if raw_val is None:
                    continue
                cov_values.append(float(raw_val))
                cov_studies.append(se)
            except (ValueError, TypeError):
                continue
        if len(cov_values) >= 3 and len(cov_values) == len(cov_studies):
            try:
                mr_result = meta_engine.meta_regression(
                    cov_studies,
                    cov_values,
                    covariate_name=var_name,
                    effect_measure=protocol.effect_measure,
                )
                regression_results.append(mr_result)
                print(f"  Meta-regression ({var_name}): β={mr_result.coefficient:.4f}, p={mr_result.p_value:.4f}")
            except Exception as e:
                logger.warning(f"Meta-regression for {var_name} failed: {e}")
                project.add_warning("meta_analysis", f"Meta-regression for {var_name} failed: {e}", code="meta_regression_failed")

    secondary_results = []
    meta_fn = _meta_function_for_protocol(protocol)
    for sec_outcome_name in protocol.pico.outcomes_secondary:
        sec_effects = []
        for study in extracted_studies:
            study_candidates = []
            for outcome in study.outcomes:
                if not _strict_secondary_outcome_matches(
                    outcome.outcome_name,
                    sec_outcome_name,
                    protocol.pico.outcome_primary,
                ):
                    continue
                if not _outcome_mentions_target_day(outcome, sec_outcome_name):
                    logger.warning(
                        "Skipping secondary outcome row without target timepoint: %s / %s",
                        study.characteristics.study_id,
                        outcome.outcome_name,
                    )
                    continue
                population_rank = _primary_population_rank(outcome, study, protocol)
                if not population_rank:
                    logger.warning(
                        "Skipping non-protocol subgroup row for secondary meta-analysis: %s / %s",
                        study.characteristics.study_id,
                        outcome.subgroup,
                    )
                    continue
                se = _compute_study_effect(study, outcome, protocol, logger)
                if se:
                    rank = (population_rank,) + _primary_outcome_rank(outcome, sec_outcome_name)
                    study_candidates.append((rank, se))
            if study_candidates:
                study_candidates.sort(key=lambda item: item[0], reverse=True)
                sec_effects.append(study_candidates[0][1])
        if len(sec_effects) >= 2:
            sec_effects = [
                s for s in sec_effects
                if s.yi is not None and s.vi is not None
                and math.isfinite(s.yi) and math.isfinite(s.vi) and s.vi > 0
            ]
        if len(sec_effects) >= 2:
            sec_pooled = meta_fn(sec_effects, protocol.effect_measure, sec_outcome_name)
            secondary_results.append(sec_pooled)
            print(f"  Secondary: {sec_outcome_name} — {sec_pooled.pooled_effect:.3f} "
                  f"(95% CI: {sec_pooled.ci_lower:.3f} to {sec_pooled.ci_upper:.3f}), "
                  f"k={sec_pooled.n_studies}")

    subgroup_results = {}
    if any(s.subgroup for s in study_effects):
        sg = meta_engine.subgroup_analysis(
            study_effects,
            protocol.effect_measure,
            protocol.pico.outcome_primary,
            model=protocol.model_preference,
        )
        subgroup_results[protocol.pico.outcome_primary] = sg

    pub_bias = publication_bias.run_all_tests(study_effects, protocol.effect_measure)

    nma_result = None
    if protocol.analysis_type == "network" and protocol.interventions:
        print("\n  Running Network Meta-Analysis...")
        try:
            contrasts = []
            for study in extracted_studies:
                for outcome in study.outcomes:
                    if not _outcome_matches(outcome.outcome_name, protocol.pico.outcome_primary):
                        continue
                    if outcome.treatment_arm and outcome.reference_arm:
                        se_nma = _compute_study_effect(study, outcome, protocol, logger)
                        if se_nma:
                            contrasts.append({
                                "treatment": outcome.treatment_arm,
                                "comparator": outcome.reference_arm,
                                "yi": se_nma.yi,
                                "vi": se_nma.vi,
                                "study_id": se_nma.study_id,
                            })
            if contrasts:
                treatments = list(set(
                    [c["treatment"] for c in contrasts] + [c["comparator"] for c in contrasts]
                ))
                reference = protocol.interventions[0] if protocol.interventions else treatments[0]
                nma_engine = NMAEngine(contrasts, treatments, reference)
                nma_result = nma_engine.fit()
                print(f"  NMA: {len(treatments)} treatments, {len(contrasts)} contrasts")
                if nma_result.sucra_rankings:
                    print(f"  SUCRA rankings: {nma_result.sucra_rankings}")
        except Exception as e:
            logger.warning(f"NMA failed: {e}")
            project.add_warning("nma", f"Network meta-analysis failed: {e}", code="nma_failed")

    meta_results = MetaAnalysisResults(
        primary_outcome=primary_result,
        secondary_outcomes=secondary_results,
        leave_one_out=loo_results,
        subgroup_results=subgroup_results,
        publication_bias=pub_bias,
        meta_regression=regression_results,
        cumulative=cumulative_results,
        nma_result=nma_result,
        model_decision=model_decision,
        model_sensitivity=model_sensitivity,
    )
    project.save_json("meta_results.json", meta_results, subdir="analysis")
    project.save_json("model_decision.json", model_decision, subdir="analysis")
    project.save_json("model_sensitivity.json", model_sensitivity, subdir="analysis")
    method_plan_payload = project.load_json("method_plan.json", subdir="analysis")
    if method_plan_payload:
        from new_meta.core.synthesis_results import persist_pairwise_synthesis_envelope
        from new_meta.schemas.method_policy import MethodPlan

        persist_pairwise_synthesis_envelope(
            project,
            plan=MethodPlan.model_validate(method_plan_payload),
            results=meta_results,
        )
    project.save_checkpoint("meta_analysis")
    return meta_results


def _generate_figures_from_cached_meta(
    project: Project,
    *,
    protocol: ResearchProtocol,
    meta_results: MetaAnalysisResults,
    study_effects: list[StudyEffect],
    lang: str,
    force: bool = False,
) -> None:
    """Generate figures from cached analysis artifacts."""
    if project.is_step_done("figures") and not force:
        print_step("12", "Figure Generation [CACHED]")
        print(f"Figures already generated in {project.base_dir / 'figures'}")
        return

    print_step("12", "Figure Generation")
    figures_dir = project.base_dir / "figures"
    figures_dir.mkdir(exist_ok=True)
    primary_result = meta_results.primary_outcome
    loo_results = meta_results.leave_one_out
    cumulative_results = meta_results.cumulative
    nma_result = meta_results.nma_result
    prisma_data = project.prisma.to_dict()

    try:
        visualization.forest_plot(
            primary_result,
            str(figures_dir / "forest_plot.png"),
            title=f"{'森林图' if lang == 'zh' else 'Forest Plot'}: {protocol.pico.outcome_primary}",
            lang=lang,
        )
        print("  Generated: forest_plot.png")
    except Exception as e:
        logger.warning(f"Forest plot generation failed: {e}")
        project.add_warning("figures", f"Forest plot generation failed: {e}", code="forest_plot_failed")

    try:
        visualization.funnel_plot(primary_result, str(figures_dir / "funnel_plot.png"), lang=lang)
        print("  Generated: funnel_plot.png")
    except Exception as e:
        logger.warning(f"Funnel plot generation failed: {e}")
        project.add_warning("figures", f"Funnel plot generation failed: {e}", code="funnel_plot_failed")

    try:
        visualization.contour_funnel_plot(primary_result, str(figures_dir / "contour_funnel_plot.png"), lang=lang)
        print("  Generated: contour_funnel_plot.png")
    except Exception as e:
        logger.warning(f"Contour funnel plot generation failed: {e}")
        project.add_warning("figures", f"Contour funnel plot generation failed: {e}", code="contour_funnel_plot_failed")

    try:
        visualization.prisma_flow_diagram(prisma_data, str(figures_dir / "prisma_diagram.png"), lang=lang)
        print("  Generated: prisma_diagram.png")
    except Exception as e:
        logger.warning(f"PRISMA diagram generation failed: {e}")
        project.add_warning("figures", f"PRISMA diagram generation failed: {e}", code="prisma_diagram_failed")

    rob_summary = project.load_json("rob_summary.json", subdir="risk_of_bias")
    if rob_summary:
        try:
            visualization.rob_summary_plot(rob_summary, str(figures_dir / "rob_summary.png"), lang=lang)
            print("  Generated: rob_summary.png")
        except Exception as e:
            logger.warning(f"RoB summary plot generation failed: {e}")
            project.add_warning("figures", f"RoB summary plot generation failed: {e}", code="rob_summary_plot_failed")

    if loo_results:
        try:
            visualization.sensitivity_plot(
                loo_results,
                primary_result.pooled_effect,
                (primary_result.ci_lower, primary_result.ci_upper),
                protocol.effect_measure,
                str(figures_dir / "sensitivity.png"),
                lang=lang,
            )
            print("  Generated: sensitivity.png")
        except Exception as e:
            logger.warning(f"Sensitivity plot generation failed: {e}")
            project.add_warning("figures", f"Sensitivity plot generation failed: {e}", code="sensitivity_plot_failed")

    if cumulative_results:
        try:
            visualization.cumulative_forest_plot(
                cumulative_results,
                protocol.effect_measure,
                str(figures_dir / "cumulative_forest.png"),
                lang=lang,
            )
            print("  Generated: cumulative_forest.png")
        except Exception as e:
            logger.warning(f"Cumulative forest plot generation failed: {e}")
            project.add_warning("figures", f"Cumulative forest plot generation failed: {e}", code="cumulative_forest_plot_failed")

    if nma_result and nma_result.network_geometry:
        try:
            visualization.network_plot(nma_result.network_geometry, str(figures_dir / "nma_network.png"))
            print("  Generated: nma_network.png")
        except Exception as e:
            logger.warning(f"NMA network plot generation failed: {e}")
            project.add_warning("figures", f"NMA network plot generation failed: {e}", code="nma_network_plot_failed")

    try:
        visualization.galbraith_plot(primary_result, str(figures_dir / "galbraith_plot.png"), lang=lang)
        print("  Generated: galbraith_plot.png")
    except Exception as e:
        logger.warning(f"Galbraith plot generation failed: {e}")
        project.add_warning("figures", f"Galbraith plot generation failed: {e}", code="galbraith_plot_failed")

    try:
        diag = influence_engine.influence_diagnostics(study_effects, model=protocol.model_preference)
        if diag:
            project.save_json("influence_diagnostics.json", diag, subdir="analysis")
            visualization.baujat_plot(diag, str(figures_dir / "baujat_plot.png"), lang=lang)
            print("  Generated: baujat_plot.png")
    except Exception as e:
        logger.warning(f"Influence diagnostics failed: {e}")
        project.add_warning("figures", f"Influence diagnostics failed: {e}", code="influence_diagnostics_failed")

    try:
        pcurve = influence_engine.p_curve_analysis(study_effects)
        if pcurve:
            project.save_json("p_curve.json", pcurve, subdir="analysis")
            print(f"  P-curve: {pcurve.get('conclusion', 'N/A')} (k_sig={pcurve.get('n_significant', 0)})")
    except Exception as e:
        logger.warning(f"P-curve analysis failed: {e}")
        project.add_warning("figures", f"P-curve analysis failed: {e}", code="p_curve_failed")

    if nma_result:
        if nma_result.league_table:
            try:
                visualization.league_table_heatmap(
                    nma_result.league_table,
                    nma_result.treatments,
                    str(figures_dir / "nma_league_table.png"),
                )
                print("  Generated: nma_league_table.png")
            except Exception as e:
                logger.warning(f"NMA league table heatmap failed: {e}")
                project.add_warning("figures", f"NMA league table heatmap failed: {e}", code="nma_league_table_failed")
        if nma_result.sucra_rankings:
            try:
                visualization.sucra_barplot(nma_result.sucra_rankings, str(figures_dir / "sucra_rankings.png"))
                print("  Generated: sucra_rankings.png")
            except Exception as e:
                logger.warning(f"SUCRA barplot failed: {e}")
                project.add_warning("figures", f"SUCRA barplot failed: {e}", code="sucra_barplot_failed")

    project.save_checkpoint("figures")


def _load_figures_b64(project: Project) -> dict[str, str]:
    """Load generated figure PNG files into the WritingAgent data-URI contract."""
    figures_dir = project.base_dir / "figures"
    figure_files = {
        "prisma_diagram": "prisma_diagram.png",
        "forest_plot": "forest_plot.png",
        "funnel_plot": "funnel_plot.png",
        "rob_plot": "rob_summary.png",
        "contour_funnel_plot": "contour_funnel_plot.png",
        "sensitivity_plot": "sensitivity.png",
        "cumulative_forest": "cumulative_forest.png",
        "nma_network": "nma_network.png",
    }
    figures_b64: dict[str, str] = {}
    for key, filename in figure_files.items():
        path = figures_dir / filename
        if not path.exists() or path.stat().st_size <= 0:
            continue
        figures_b64[key] = "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode("ascii")
    return figures_b64


def _resume_from_cached_meta_analysis(project: Project, args, model: str | None) -> str:
    """Resume after cached meta-analysis without rerunning effect-size or pooling steps."""
    print_step("10-11", "Effect Sizes and Meta-Analysis [CACHED]")
    protocol, search_query, extracted_studies, rob_results, included_papers, prisma_data, lang = _load_cached_resume_inputs(project, args)
    study_effects = _load_cached_study_effects(project)
    meta_results = _load_cached_meta_results(project)
    meta_results = _ensure_cached_model_artifacts(project, protocol, meta_results)
    print(f"Loaded {len(study_effects)} cached study effect(s)")
    print(f"Loaded cached meta-analysis for {meta_results.primary_outcome.n_studies} study effect(s)")

    grade_profile = _run_grade_from_cached_meta(
        project,
        model,
        protocol=protocol,
        meta_results=meta_results,
        rob_results=rob_results,
        extracted_studies=extracted_studies,
    )
    _generate_figures_from_cached_meta(
        project,
        protocol=protocol,
        meta_results=meta_results,
        study_effects=study_effects,
        lang=lang,
    )
    return _write_manuscript_from_artifacts(
        project,
        args,
        model,
        protocol=protocol,
        search_query=search_query,
        extracted_studies=extracted_studies,
        rob_results=rob_results,
        included_papers=included_papers,
        prisma_data=prisma_data,
        lang=lang,
        meta_results=meta_results,
        grade_profile=grade_profile,
    )


def _resume_from_cached_effect_sizes(project: Project, args, model: str | None) -> str:
    """Resume after cached effect-size computation without recomputing extraction-derived effects."""
    print_step("10", "Effect Size Computation [CACHED]")
    protocol, search_query, extracted_studies, rob_results, included_papers, prisma_data, lang = _load_cached_resume_inputs(project, args)
    study_effects = _load_cached_study_effects(project)
    print(f"Loaded {len(study_effects)} cached study effect(s)")

    meta_results = _run_meta_analysis_from_effects(
        project,
        protocol=protocol,
        extracted_studies=extracted_studies,
        study_effects=study_effects,
    )
    grade_profile = _run_grade_from_cached_meta(
        project,
        model,
        protocol=protocol,
        meta_results=meta_results,
        rob_results=rob_results,
        extracted_studies=extracted_studies,
    )
    _generate_figures_from_cached_meta(
        project,
        protocol=protocol,
        meta_results=meta_results,
        study_effects=study_effects,
        lang=lang,
    )
    return _write_manuscript_from_artifacts(
        project,
        args,
        model,
        protocol=protocol,
        search_query=search_query,
        extracted_studies=extracted_studies,
        rob_results=rob_results,
        included_papers=included_papers,
        prisma_data=prisma_data,
        lang=lang,
        meta_results=meta_results,
        grade_profile=grade_profile,
    )


def _resume_direct_to_manuscript(project: Project, args, model: str | None) -> str:
    """Regenerate manuscript from cached analysis artifacts without rerunning analysis."""
    print_step("10-12", "Analysis and Figures [CACHED]")
    protocol, search_query, extracted_studies, rob_results, included_papers, prisma_data, lang = _load_cached_resume_inputs(project, args)
    meta_results = _load_cached_meta_results(project)
    meta_results = _ensure_cached_model_artifacts(project, protocol, meta_results)
    grade_profile = _run_grade_from_cached_meta(
        project,
        model,
        protocol=protocol,
        meta_results=meta_results,
        rob_results=rob_results,
        extracted_studies=extracted_studies,
    )

    print(f"Loaded cached meta-analysis for {meta_results.primary_outcome.n_studies} study effect(s)")
    print(f"Loaded {len(extracted_studies)} extraction(s), {len(rob_results)} RoB record(s)")
    return _write_manuscript_from_artifacts(
        project,
        args,
        model,
        protocol=protocol,
        search_query=search_query,
        extracted_studies=extracted_studies,
        rob_results=rob_results,
        included_papers=included_papers,
        prisma_data=prisma_data,
        lang=lang,
        meta_results=meta_results,
        grade_profile=grade_profile,
    )


def _resume_direct_to_narrative_manuscript(project: Project, args, model: str | None) -> str:
    """Regenerate a narrative manuscript without repeating search or extraction."""
    print_step("1-11", "Review Evidence Preparation [CACHED]")
    protocol, search_query, extracted_studies, rob_results, included_papers, prisma_data, lang = _load_cached_resume_inputs(project, args)
    print(f"Loaded {len(extracted_studies)} extraction(s), {len(rob_results)} RoB record(s)")
    return _write_narrative_manuscript_from_artifacts(
        project,
        args,
        model,
        protocol=protocol,
        search_query=search_query,
        extracted_studies=extracted_studies,
        rob_results=rob_results,
        included_papers=included_papers,
        prisma_data=prisma_data,
        lang=lang,
        force_figures=True,
    )


def _get_advisory(planner: ResearchPlanner, stage: str, count: int,
                  protocol: ResearchProtocol,
                  project: Project | None = None) -> str:
    """Get LLM-powered advice when results are few at a pipeline checkpoint."""
    try:
        return planner.get_advice(stage, count, protocol)
    except Exception as exc:
        logger.exception("LLM advisory failed at %s checkpoint", stage)
        raw_message = str(exc) or exc.__class__.__name__
        safe_message = re.sub(r"sk-[A-Za-z0-9_-]{12,}", "sk-***", raw_message)[:400]
        if project is not None:
            project.add_warning(
                "decision_point",
                f"LLM advisory failed at {stage}: {safe_message}",
                code="advisory_llm_failed",
                severity="error",
                context={
                    "stage": stage,
                    "count": count,
                    "exception_type": exc.__class__.__name__,
                },
            )
        return (
            f"LLM advisory failed at {stage}: {safe_message}. "
            "This decision point is missing model-generated advice; review the current counts and sources before continuing."
        )


def _interactive_checkpoint(planner: ResearchPlanner, stage: str, count: int,
                            protocol: ResearchProtocol,
                            skip_confirm: bool,
                            project: Project | None = None) -> str:
    """Pause pipeline and let user decide how to proceed when results are few.

    Returns: "adjust", "continue", or "abort".
    """
    if skip_confirm:
        return "continue"

    stage_labels = {
        "search": "Literature Search",
        "ta_screening": "Title/Abstract Screening",
        "ft_screening": "Full-Text Screening",
    }
    label = stage_labels.get(stage, stage)

    print(f"\n{'─' * 60}")
    print(f"  ⚠ Low result count at {label}: {count} result(s)")
    print(f"{'─' * 60}")

    advice = _get_advisory(planner, stage, count, protocol, project=project)
    print(f"\n  LLM Advisory:\n  {advice}\n")

    if count == 0:
        # No results — only adjust or abort
        print("  [1] Adjust research topic/scope (refine PICO)")
        print("  [2] Abort pipeline")
        while True:
            choice = input("\n  Choose [1/2]: ").strip()
            if choice == "1":
                return "adjust"
            if choice == "2":
                return "abort"
            print("  Please enter 1 or 2.")
    else:
        print("  [1] Adjust research topic/scope (refine PICO)")
        print("  [2] Continue with current results")
        print("  [3] Abort pipeline")
        while True:
            choice = input("\n  Choose [1/2/3]: ").strip()
            if choice == "1":
                return "adjust"
            if choice == "2":
                return "continue"
            if choice == "3":
                return "abort"
            print("  Please enter 1, 2, or 3.")


def _require_full_text_sources(
    *,
    project: Project,
    papers_with_full_text: list[dict],
    extra_user_papers: list[dict],
    screened_papers: list[dict],
) -> None:
    """Block extraction when every candidate is abstract-only or metadata-only."""
    if any(_is_usable_full_text_source(paper) for paper in papers_with_full_text) or any(
        _is_usable_full_text_source(paper) for paper in extra_user_papers
    ):
        return

    message = (
        "Full text sources are required before extraction. No user PDF, retrieved PDF, "
        "or verified full-text HTML source was available for the included records; "
        "upload full texts or add verified source data and resume the run."
    )
    project.add_warning(
        "fulltext_retrieval",
        message,
        code="no_full_text_sources",
        severity="error",
        context={"screened_records": len(screened_papers or [])},
    )
    raise RuntimeError(message)


def _is_usable_full_text_source(paper: dict) -> bool:
    """Return whether a record has article-level text suitable for extraction."""
    availability = str(paper.get("text_availability") or "").strip().lower()
    source = str(paper.get("fulltext_source") or "").strip().lower()
    if availability in {"abstract_only", "metadata_only"}:
        return False
    if source in {"europe_pmc_abstract", "structured_abstract", "abstract"}:
        return False
    return bool(
        paper.get("pdf_path")
        or paper.get("fulltext_path")
        or paper.get("full_text")
    )


def _partition_full_text_sources(papers: list[dict]) -> tuple[list[dict], list[dict]]:
    """Partition records into usable full text and unavailable/limited sources."""
    usable: list[dict] = []
    unavailable: list[dict] = []
    for paper in papers:
        (usable if _is_usable_full_text_source(paper) else unavailable).append(paper)
    return usable, unavailable


def _select_narrative_extraction_papers(
    *,
    included_papers: list[dict],
    papers_for_ft_screening: list[dict],
    ta_included_papers: list[dict],
) -> list[dict]:
    """Select records allowed to feed narrative-mode extraction after FT screening.

    Narrative fallback must not turn title/abstract-only screening records into
    extraction inputs. Records need a full-text screening include decision first.
    """
    allowed_ids = {paper_identity(paper) for paper in papers_for_ft_screening}
    return [
        paper for paper in included_papers
        if paper_identity(paper) in allowed_ids
    ]


def _compute_cli_primary_effect_selection(
    *,
    project: Project,
    protocol: ResearchProtocol,
    extracted_studies: list[ExtractedStudy],
    rob_results: list[StudyRoB],
    included_papers: list[dict],
):
    """Run the same strict primary-effect phase used by Web and API callers."""
    from new_meta.core.pipeline_runner import PipelineRunner

    return PipelineRunner(project, logger=logger).run_primary_effect_selection(
        protocol=protocol,
        extracted_studies=extracted_studies,
        rob_results=rob_results,
        included_papers=included_papers,
    )


def _prompt_cli_analysis_set(project: Project, phase_result) -> None:
    """Ask one clinically meaningful question when multiple strata are valid."""
    from new_meta.core.analysis_set import save_analysis_set_adjudication

    data = phase_result.data or {}
    options = data.get("options") or []
    if not options:
        raise ValueError("analysis-set decision has no selectable options")
    recommended_id = str(data.get("recommended_candidate_id") or "")
    print("\nSeveral clinically distinct result sets are available:")
    recommended_index = 0
    for index, option in enumerate(options, start=1):
        marker = " (recommended)" if option.get("candidate_id") == recommended_id else ""
        if marker:
            recommended_index = index - 1
        print(f"  [{index}] {option.get('label')}{marker} — {option.get('description')}")
    raw = input(f"Choose analysis set [default {recommended_index + 1}]: ").strip()
    selected_index = recommended_index if not raw else int(raw) - 1
    if selected_index < 0 or selected_index >= len(options):
        raise ValueError("invalid analysis-set choice")
    selected = options[selected_index]
    current = project.load_json("analysis_set.json", subdir="analysis") or {}
    save_analysis_set_adjudication(
        project,
        candidate_id=str(selected["candidate_id"]),
        expected_revision=int(current.get("revision") or 0),
        selected_by="cli_user",
        reason=(
            "User selected this option after reviewing the outcome, timepoint, subgroup, "
            "effect measure, and contributing study count."
        ),
    )


def _prompt_cli_method_certainty(project: Project) -> None:
    """Offer three compact certainty choices and apply the user's confirmation."""
    from new_meta.core.method_certainty import (
        apply_method_certainty_option,
        build_method_certainty_option_payload,
    )
    from new_meta.schemas.method_certainty import MethodCertaintyAssessment

    assessment = MethodCertaintyAssessment.model_validate(
        project.load_json("method_certainty.json", subdir="analysis")
    )
    payload = build_method_certainty_option_payload(assessment)
    print("\nSome certainty domains depend on clinical context:")
    for item in payload["unresolved_domains"]:
        print(f"  - {item['domain']}: {item['why_uncertain']}")
    for index, option in enumerate(payload["options"], start=1):
        marker = " (recommended)" if option["option_id"] == payload["recommended_option_id"] else ""
        print(f"  [{index}] {option['label']}{marker} — {option['description']}")
    raw = input("Choose certainty handling [default 1]: ").strip()
    selected = int(raw) - 1 if raw else 0
    if selected < 0 or selected >= len(payload["options"]):
        raise ValueError("invalid certainty option")
    option_id = payload["options"][selected]["option_id"]
    custom = None
    if option_id == "custom":
        custom = {}
        for item in payload["unresolved_domains"]:
            raw_rating = input(
                f"{item['domain']} [1=no concern, 2=serious, 3=very serious]: "
            ).strip()
            ratings = {"1": "no_concern", "2": "serious", "3": "very_serious"}
            if raw_rating not in ratings:
                raise ValueError(f"invalid certainty rating for {item['domain']}")
            rationale = input(f"Brief rationale for {item['domain']}: ").strip()
            if not rationale:
                raise ValueError(f"rationale is required for {item['domain']}")
            custom[item["domain"]] = {
                "rating": ratings[raw_rating],
                "rationale": rationale,
            }
    apply_method_certainty_option(
        project,
        option_id=option_id,
        selected_by="cli_user",
        custom_overrides=custom,
    )


def main():
    parser = argparse.ArgumentParser(description="MetaAgent — Automated Meta-Analysis Manuscript Generator")
    parser.add_argument("--topic", type=str, required=True, help="Research question or topic")
    parser.add_argument("--output-dir", type=str, default=None, help="Output directory")
    parser.add_argument("--max-papers", type=int, default=None, help="Max papers to search")
    parser.add_argument("--model", type=str, default=None, help="LLM model to use")
    parser.add_argument(
        "--skip-confirm",
        action="store_true",
        help=(
            "Run fully unattended: rank ambiguous analysis sets and apply the "
            "documented conservative certainty option"
        ),
    )
    parser.add_argument(
        "--allow-validating-methods",
        action="store_true",
        help=(
            "Permit capabilities marked validating for a controlled validation run. "
            "Never use this flag for a production review or submission package."
        ),
    )
    parser.add_argument(
        "--run-mode",
        choices=[mode.value for mode in RunMode],
        default=RunMode.REVIEW.value,
        help=(
            "Evidence policy: review uses only acquired review evidence; benchmark "
            "explicitly enables bundled reference fixtures for reproduction runs."
        ),
    )
    parser.add_argument("--analysis-type", type=str, default=None, choices=["pairwise", "network"],
                        help="Analysis type override (pairwise or network)")
    parser.add_argument(
        "--language",
        "--output-language",
        dest="output_language",
        type=str,
        default=None,
        help="Manuscript output language: zh/中文 or en/English. Defaults to topic-based detection.",
    )
    parser.add_argument("--resume", type=str, default=None,
                        help="Resume from an existing project directory")
    parser.add_argument("--user-pdfs", type=str, default=None,
                        help="Directory containing user-uploaded PDFs for missing papers")
    parser.add_argument(
        "--ipd-data",
        type=str,
        default=None,
        help=(
            "JSON participant dataset for IPD meta-analysis. The file may be a study list or "
            "an object with studies, outcome_type, covariates, and effect_modifier."
        ),
    )
    parser.add_argument(
        "--rerun-manuscript-only",
        action="store_true",
        help="Force a manuscript-only rewrite from cached analysis artifacts, even if manuscript checkpoint exists",
    )
    parser.add_argument(
        "--polish-manuscript",
        action="store_true",
        help="Force the conservative post-write manuscript polish stage",
    )
    parser.add_argument(
        "--no-polish-manuscript",
        action="store_true",
        help="Disable manuscript polish for this run",
    )
    parser.add_argument(
        "--manuscript-polish-scope",
        choices=["targeted", "all"],
        default=None,
        help="Polish rewrite scope: targeted rewrites only style-problem chunks; all rewrites every polishable chunk.",
    )
    args = parser.parse_args()
    try:
        args.output_language = _resolve_output_language(args)
    except ValueError as exc:
        parser.error(str(exc))

    output_dir = Path(args.output_dir) if args.output_dir else OUTPUT_DIR

    # Resume or create project
    resume_dir = Path(args.resume) if args.resume else None
    if resume_dir and resume_dir.exists():
        project = Project(args.topic, output_dir=output_dir, resume_dir=resume_dir)
        resume_step = project.get_resume_step()
        completed = project.get_completed_steps()
        print(f"\nResuming project: {project.base_dir}")
        print(f"  Completed steps: {', '.join(completed) if completed else 'none'}")
        print(f"  Resuming from: {resume_step or 'all done'}\n")
    else:
        project = Project(args.topic, output_dir=output_dir)
        print(f"\nProject directory: {project.base_dir}\n")

    try:
        args.run_mode = configure_project_run_mode(project, args.run_mode)
    except ValueError as exc:
        parser.error(str(exc))

    setup_logging()
    logger = logging.getLogger("metaagent.main")

    # Input validation
    if not args.topic or not args.topic.strip():
        print("Error: --topic cannot be empty. Please provide a research question.")
        sys.exit(1)

    # Validate LLM API key early unless we can safely rewrite from cached artifacts.
    from new_meta.config import LLM_API_KEY
    can_run_without_key = (
        (args.rerun_manuscript_only and _can_rerun_manuscript_only(project))
        or _can_resume_direct_to_manuscript(project)
    )
    if not LLM_API_KEY and not can_run_without_key:
        print("Error: LLM_API_KEY is not set. Set it via environment variable or .env file.")
        print("  export LLM_API_KEY='your-api-key'")
        sys.exit(1)

    model = args.model
    if args.rerun_manuscript_only:
        if not _can_rerun_manuscript_only(project):
            print("Error: cached protocol/extraction/analysis artifacts are incomplete; cannot rerun manuscript only.")
            sys.exit(1)
        if _can_write_narrative_manuscript_from_cached_artifacts(project):
            print("Forcing narrative manuscript-only rewrite from cached review artifacts.")
            _resume_direct_to_narrative_manuscript(project, args, model)
        else:
            print("Forcing manuscript-only rewrite from cached analysis artifacts.")
            _resume_direct_to_manuscript(project, args, model)
        return
    if _can_resume_direct_to_manuscript(project):
        print("Detected cached analysis artifacts; regenerating manuscript only.")
        _resume_direct_to_manuscript(project, args, model)
        return
    if _can_resume_from_cached_meta_analysis(project):
        print("Detected cached meta-analysis artifacts; resuming from GRADE/figures/manuscript.")
        _resume_from_cached_meta_analysis(project, args, model)
        return
    if _can_resume_from_cached_effect_sizes(project):
        print("Detected cached effect-size artifacts; resuming from meta-analysis.")
        _resume_from_cached_effect_sizes(project, args, model)
        return

    # =========================================================================
    # Step 1: Research Planning
    # =========================================================================
    if project.is_step_done("protocol"):
        print_step("1", "Research Planning — PICO Extraction [CACHED]")
        protocol_data = project.load_json("protocol.json")
        protocol = ResearchProtocol.model_validate(protocol_data)
        if args.analysis_type:
            protocol.analysis_type = args.analysis_type
        _apply_topic_date_range(protocol, args.topic)
        print(ResearchPlanner.display_protocol(protocol))
    else:
        print_step("1", "Research Planning — PICO Extraction")
        planner = ResearchPlanner(model=model)
        protocol = planner.run(args.topic)

        if args.analysis_type:
            protocol.analysis_type = args.analysis_type
        _apply_topic_date_range(protocol, args.topic)

        print(ResearchPlanner.display_protocol(protocol))

        project.save_json("protocol.json", protocol)
        project.save_checkpoint("protocol")

    ipd_records = None
    ipd_options: dict = {}
    ipd_outcome_type = None
    if args.ipd_data:
        from new_meta.core.ipd_ingestion import load_ipd_json

        try:
            ipd_records, ipd_outcome_type, ipd_options = load_ipd_json(args.ipd_data)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            parser.error(str(exc))
        protocol.review_family = "ipd_meta"
        protocol.study_design = "parallel RCT"
        protocol.study_designs = ["parallel RCT"]
        if ipd_outcome_type:
            normalized_ipd_outcome = str(ipd_outcome_type).strip().lower().replace("-", "_")
            normalized_ipd_outcome = {
                "dichotomous": "binary",
            }.get(normalized_ipd_outcome, normalized_ipd_outcome)
            if normalized_ipd_outcome not in {"binary", "continuous", "time_to_event"}:
                parser.error(f"Unsupported IPD outcome_type: {ipd_outcome_type}")
            protocol.primary_outcome_type = (
                "dichotomous" if normalized_ipd_outcome == "binary" else normalized_ipd_outcome
            )
            protocol.effect_measure = {
                "binary": "OR",
                "continuous": "MD",
                "time_to_event": "HR",
            }[normalized_ipd_outcome]
        project.save_json("protocol.json", protocol)

    compile_project_method_plan(
        project,
        protocol,
        allow_validating=args.allow_validating_methods,
        enforce=True,
    )
    if ipd_records is not None:
        from new_meta.core.ipd_ingestion import ingest_ipd_studies_to_ledger

        ipd_report = ingest_ipd_studies_to_ledger(
            project,
            protocol=protocol,
            records=ipd_records,
            outcome_type=ipd_outcome_type,
            source_path=args.ipd_data,
        )
        project.save_json("ipd_analysis_options.json", ipd_options, subdir="analysis")
        print(
            f"Imported {len(ipd_report.result_ids)} participant-level study dataset(s) "
            f"for IPD synthesis."
        )
    has_ipd_dataset = bool(ipd_records) or bool(
        project.load_json("ipd_ingestion.json", subdir="evidence")
    )

    # =========================================================================
    # Step 2: Search Query Generation (with MeSH validation)
    # =========================================================================
    if project.is_step_done("search_query"):
        print_step("2", "Search Query Generation [CACHED]")
        search_query = project.load_text("search_query.txt")
        print(f"PubMed Query:\n{search_query}\n")
    else:
        print_step("2", "Search Query Generation (MeSH-validated)")
        query_builder = QueryBuilder(model=model)
        search_query, strategy_report, _ = _unpack_query_result(query_builder.run(protocol))
        if strategy_report:
            project.save_text("search_strategy_report.txt", strategy_report)
            print(f"Search strategy report saved")
        print(f"PubMed Query:\n{search_query}\n")
        project.save_text("search_query.txt", search_query)
        project.save_checkpoint("search_query")

    # =========================================================================
    # Steps 3-4: Search + T/A Screening (wrapped in retry loop for adaptive adjustment)
    # =========================================================================
    planner = ResearchPlanner(model=model)
    query_builder = QueryBuilder(model=model)
    search_iteration = 0

    while True:
        search_iteration += 1

        # Step 3: Literature Search (metadata only, NO PDF download)
        if project.is_step_done("search") and search_iteration == 1:
            print_step("3", "Literature Search — PubMed Metadata [CACHED]")
            papers = project.load_json("search_results.json") or []
            print(f"Retrieved {len(papers)} papers (cached)")
            # Sanity check: if cached results have no PubMed papers, the previous
            # search likely failed mid-way (e.g. PubMed 502). Force re-search.
            has_pubmed = any(p.get("pmid", "") and len(str(p.get("pmid", ""))) >= 6
                            for p in papers[:20])
            if papers and not has_pubmed and len(papers) < 100:
                logger.warning(f"Cached results have no PubMed papers ({len(papers)} total). "
                               "Previous search may have failed. Re-searching...")
                project.clear_downstream("search", include_self=True)
        else:
            print_step("3", "Literature Search — PubMed Metadata (no PDF download)")
            retriever = PaperRetriever(model=model)
            papers = retriever.search_and_fetch(
                search_query,
                project,
                max_results=args.max_papers,
                date_range=protocol.date_range,
            )
            print(f"Retrieved {len(papers)} papers (metadata only)")

            if len(papers) >= LARGE_RESULT_WARNING:
                print(f"\n  WARNING: Large result set ({len(papers)} papers). "
                      f"Batched screening will be used automatically.")

            project.save_checkpoint("search")

        # Sparse search results are handled automatically. They are evidence,
        # not a reason to interrupt a topic-to-article run.
        if not papers:
            if search_iteration == 1:
                print("  No records found. Auto-broadening the comparator and retrying once...")
                _broaden_protocol_for_retry(protocol)
                project.save_json("protocol.json", protocol)
                compile_project_method_plan(
                    project,
                    protocol,
                    allow_validating=args.allow_validating_methods,
                    enforce=True,
                )
                search_query, _, _ = _unpack_query_result(query_builder.run(protocol))
                project.save_text("search_query.txt", search_query)
                project.clear_downstream("search_query")
                continue
            print("No papers found after the automatic retry. Writing an evidence-gap article.")
            manuscript = complete_zero_record_review(
                project=project,
                protocol=protocol,
                search_query=search_query,
                prisma_data=project.prisma.to_dict(),
                reason="no_records_identified",
                lang=_resolve_output_language(args),
            )
            write_llm_usage_manifest(project)
            package_path = create_artifact_package(project)
            print(f"Project directory: {project.base_dir}")
            print(f"  Manuscript: {project.base_dir / 'manuscript' / 'draft.md'}")
            print(f"  Artifact package: {package_path}")
            print("  Note: The article reports an evidence gap; no quantitative effect was estimated.")
            return
        elif len(papers) < LOW_SEARCH_RESULTS:
            print(f"  Sparse search ({len(papers)} records); continuing with explicit evidence limitations.")

        # Step 4: Title/Abstract Screening (batched for large result sets)
        if project.is_step_done("ta_screening") and search_iteration == 1:
            print_step("4", "Title/Abstract Screening [CACHED]")
            ta_results = project.load_json("title_abstract_screening.json", subdir="screening") or []
            ta_included_papers = [r["paper"] for r in ta_results if r.get("decision") == "include"]
            print(f"T/A screening: {len(ta_included_papers)} included (cached)")
        else:
            print_step("4", "Title/Abstract Screening")
            screener = ScreeningAgent(model=model)
            ta_included_papers, ta_excluded_papers = screener.screen_title_abstract(papers, protocol, project)
            print(f"T/A screening: {len(ta_included_papers)} included, {len(ta_excluded_papers)} excluded")
            for p in ta_included_papers[:20]:
                print(f"  + {p.get('title', '')[:70]}")
            if len(ta_included_papers) > 20:
                print(f"  ... and {len(ta_included_papers) - 20} more")
            project.save_checkpoint("ta_screening")

        # Retry an empty screen once. Non-zero sparse screens continue and are
        # represented honestly in the final evidence-gap/narrative article.
        if not ta_included_papers:
            if search_iteration == 1:
                print("  No records passed screening. Auto-broadening the comparator and retrying once...")
                _broaden_protocol_for_retry(protocol)
                project.save_json("protocol.json", protocol)
                compile_project_method_plan(
                    project,
                    protocol,
                    allow_validating=args.allow_validating_methods,
                    enforce=True,
                )
                search_query, _, _ = _unpack_query_result(query_builder.run(protocol))
                project.save_text("search_query.txt", search_query)
                project.clear_downstream("search_query")
                continue
            manuscript = complete_zero_record_review(
                project=project,
                protocol=protocol,
                search_query=search_query,
                prisma_data=project.prisma.to_dict(),
                reason="no_records_eligible",
                lang=_resolve_output_language(args),
            )
            write_llm_usage_manifest(project)
            package_path = create_artifact_package(project)
            print(f"Project directory: {project.base_dir}")
            print(f"  Manuscript: {project.base_dir / 'manuscript' / 'draft.md'}")
            print(f"  Artifact package: {package_path}")
            print("  Note: The article reports an evidence gap; no quantitative effect was estimated.")
            return
        elif len(ta_included_papers) < LOW_SCREENING_RESULTS:
            print(
                f"  Sparse title/abstract inclusion ({len(ta_included_papers)} records); "
                "continuing with explicit evidence limitations."
            )

        break  # Results are sufficient, exit retry loop

    # =========================================================================
    # Step 5: Full-text handling — automatic retrieval first, user fallback only
    # =========================================================================
    if project.is_step_done("pdf_download"):
        print_step("5", "PDF Handling [CACHED]")
        pdf_download_data = project.load_json("pdf_download_results.json") or []
        extra_user_papers = [p for p in pdf_download_data
                             if p.get("pmid", "").startswith("user_pdf_")]
        extra_pmids = {p["pmid"] for p in extra_user_papers}
        cached_screened = [
            p for p in pdf_download_data if p.get("pmid", "") not in extra_pmids
        ]
        papers_with_pdf, _limited_or_missing = _partition_full_text_sources(cached_screened)
        print(f"Full texts available: {len(papers_with_pdf)} (cached), "
              f"extra user PDFs: {len(extra_user_papers)}")
    else:
        print_step("5", "Full-text Handling (Automatic Retrieval → Optional User Fallback)")
        retriever = PaperRetriever(model=model)
        extra_user_papers = []

        # A caller may proactively supply PDFs. Otherwise, do not interrupt the
        # topic-to-article run before automatic retrieval has had a chance.
        user_pdf_dir = args.user_pdfs

        matched_count = 0
        user_parsed = {}  # pmid/key -> parsed content (from match_user_pdfs)

        if user_pdf_dir:
            pdf_dir = Path(user_pdf_dir)
            if pdf_dir.is_dir():
                user_pdf_paths = sorted(str(p) for p in pdf_dir.glob("*.pdf"))
                print(f"  Found {len(user_pdf_paths)} user PDFs in {pdf_dir}")

                if user_pdf_paths:
                    matched_count, extra_user_papers, user_parsed = retriever.match_user_pdfs(
                        ta_included_papers, user_pdf_paths
                    )
                    print(f"  Matched {matched_count} user PDFs to T/A-screened papers")
                    if extra_user_papers:
                        print(f"  {len(extra_user_papers)} unmatched user PDFs → extra papers for screening")
            else:
                print(f"  Directory not found: {user_pdf_dir}")

        # Automatic retrieval is the default path for every remaining paper.
        unmatched_ta = [
            p for p in ta_included_papers if not _is_usable_full_text_source(p)
        ]
        auto_downloaded = []
        if unmatched_ta:
            print(f"\n  {len(unmatched_ta)} T/A papers still without PDF — attempting auto text retrieval...")
            auto_with, auto_without = retriever.download_pdfs(unmatched_ta, project)
            auto_downloaded = auto_with
            print(f"  Retrieved machine-readable text for {len(auto_with)}/{len(unmatched_ta)} papers")
            if auto_without:
                for p in auto_without[:5]:
                    print(f"    - {p.get('title', '')[:60]}... (PMID: {p.get('pmid', 'N/A')})")
                if len(auto_without) > 5:
                    print(f"    ... and {len(auto_without) - 5} more")

        # Only a genuine automatic-retrieval failure may ask for user input.
        # Full-auto mode leaves the resumable project blocked with a concise
        # missing-fulltext reason instead of opening an unrelated prompt.
        has_usable_fulltext = any(
            _is_usable_full_text_source(p) for p in ta_included_papers
        ) or any(_is_usable_full_text_source(p) for p in extra_user_papers)
        if not has_usable_fulltext and not user_pdf_dir and not args.skip_confirm:
            fallback_dir = input(
                "\nAutomatic full-text retrieval found no usable sources. "
                "Provide a directory of PDFs, or press Enter to stop and resume later: "
            ).strip()
            if fallback_dir:
                pdf_dir = Path(fallback_dir)
                if pdf_dir.is_dir():
                    user_pdf_paths = sorted(str(p) for p in pdf_dir.glob("*.pdf"))
                    if user_pdf_paths:
                        matched_count, extra_user_papers, user_parsed = retriever.match_user_pdfs(
                            ta_included_papers,
                            user_pdf_paths,
                        )
                        print(f"  Matched {matched_count} user PDFs after automatic retrieval failed")
                else:
                    print(f"  Directory not found: {fallback_dir}")

        # Combine all papers with PDF
        papers_with_pdf, papers_without_pdf = _partition_full_text_sources(
            ta_included_papers
        )

        # Save all (T/A matched + extra user papers) for downstream
        all_pdf_data = papers_with_pdf + papers_without_pdf + extra_user_papers
        project.save_json("pdf_download_results.json", all_pdf_data)
        text_source_warnings = []
        for p in all_pdf_data:
            text_availability = p.get("text_availability")
            if text_availability == "abstract_only":
                warning = "Only structured abstract text was retrievable automatically; extraction requires manual verification."
            elif text_availability == "metadata_only":
                warning = "Only registry metadata is available; outcome extraction requires user-uploaded full text or verified source data."
            else:
                continue
            text_source_warnings.append({
                "pmid": p.get("pmid", ""),
                "doi": p.get("doi", ""),
                "title": p.get("title", ""),
                "trial_registration": p.get("trial_registration") or p.get("nct_id") or "",
                "text_availability": text_availability,
                "warning": warning,
            })
        if text_source_warnings:
            project.save_json("text_source_warnings.json", text_source_warnings)
            print(f"  Warning: {len(text_source_warnings)} paper(s) use limited text/metadata fallback")
        project.save_json("prisma_flow.json", project.prisma.to_dict())
        project.save_checkpoint("pdf_download")

    _require_full_text_sources(
        project=project,
        papers_with_full_text=papers_with_pdf,
        extra_user_papers=extra_user_papers,
        screened_papers=ta_included_papers,
    )

    # =========================================================================
    # Step 6: PDF Parsing
    # =========================================================================
    if project.is_step_done("pdf_parsing"):
        print_step("6", "PDF Parsing [CACHED]")
        parsed_papers = _load_parsed_papers_cache(project)
        if parsed_papers:
            print(f"Parsed {len(parsed_papers)} papers (loaded from cache)")
        else:
            logger.warning("pdf_parsing checkpoint exists but parsed_papers.json is missing; reparsing legacy run.")
            parsed_papers = {}
            all_for_parsing = papers_with_pdf + extra_user_papers
            for paper in all_for_parsing:
                paper_id = paper_identity(paper)
                pdf_path = paper.get("pdf_path")
                fulltext_path = paper.get("fulltext_path")
                if pdf_path:
                    try:
                        parsed, _cache_hit = _parse_fulltext_source(project, pdf_path, is_pdf=True)
                        parsed_papers[paper_id] = parsed
                    except Exception as e:
                        logger.warning(f"Failed to parse {pdf_path}: {e}")
                        project.add_warning(
                            "pdf_parsing",
                            f"Failed to parse PDF: {e}",
                            code="pdf_parse_failed",
                            context={"path": str(pdf_path), "paper_id": paper_id},
                        )
                elif fulltext_path:
                    try:
                        parsed, _cache_hit = _parse_fulltext_source(project, fulltext_path, is_pdf=False)
                        parsed_papers[paper_id] = parsed
                    except Exception as e:
                        logger.warning(f"Failed to parse {fulltext_path}: {e}")
                        project.add_warning(
                            "pdf_parsing",
                            f"Failed to parse full text: {e}",
                            code="fulltext_parse_failed",
                            context={"path": str(fulltext_path), "paper_id": paper_id},
                        )
            _save_parsed_papers_cache(project, parsed_papers)
            print(f"Parsed {len(parsed_papers)} papers (legacy cache rebuilt)")
    else:
        print_step("6", "PDF Parsing")

        parsed_papers = {}
        parse_failures = 0
        all_for_parsing = papers_with_pdf + extra_user_papers

        for paper in all_for_parsing:
            paper_id = paper_identity(paper)
            pdf_path = paper.get("pdf_path")
            fulltext_path = paper.get("fulltext_path")
            if not pdf_path and not fulltext_path:
                continue
            try:
                parsed, cache_hit = _parse_fulltext_source(
                    project,
                    pdf_path or fulltext_path,
                    is_pdf=bool(pdf_path),
                )
                parsed_papers[paper_id] = parsed
                page_count = len(parsed.get("page_map", []))
                if pdf_path:
                    source_label = "PDF"
                elif paper.get("text_availability") == "abstract_only":
                    source_label = "abstract-only text"
                else:
                    source_label = "HTML full text"
                cache_note = " [cache]" if cache_hit else ""
                print(f"  Parsed {source_label}{cache_note}: {paper.get('title', '')[:55]}... ({page_count} pages)")
            except Exception as e:
                parse_failures += 1
                logger.warning(f"Failed to parse {pdf_path or fulltext_path}: {e}")
                project.add_warning(
                    "pdf_parsing",
                    f"Failed to parse full text source: {e}",
                    code="fulltext_parse_failed",
                    context={
                        "path": str(pdf_path or fulltext_path or ""),
                        "paper_id": paper_id,
                        "title": paper.get("title", ""),
                    },
                )

        parse_rate = len(parsed_papers) / len(all_for_parsing) if all_for_parsing else 0
        print(f"Successfully parsed {len(parsed_papers)} papers (rate: {parse_rate:.0%})")
        if parse_rate < 0.3:
            logger.warning(f"Low PDF parsing rate ({parse_rate:.0%}). Results may be incomplete.")
            project.add_warning(
                "pdf_parsing",
                f"Low full-text parsing rate ({parse_rate:.0%}); results may be incomplete.",
                code="low_parse_rate",
                context={
                    "parsed": len(parsed_papers),
                    "attempted": len(all_for_parsing),
                    "parse_failures": parse_failures,
                },
            )

        _save_parsed_papers_cache(project, parsed_papers)
        project.save_checkpoint("pdf_parsing")

    # =========================================================================
    # Step 7: Full-Text Screening (includes extra user PDFs)
    # =========================================================================
    papers_for_ft_screening = papers_with_pdf + extra_user_papers

    if project.is_step_done("ft_screening"):
        print_step("7", "Full-Text Screening [CACHED]")
        ft_results = project.load_json("full_text_screening.json", subdir="screening") or []
        included_pmids = set(r.get("paper", {}).get("pmid", "") for r in ft_results
                            if r.get("decision") == "include")
        included_papers = [p for p in papers_for_ft_screening
                           if p.get("pmid", "") in included_pmids]
        print(f"Included: {len(included_papers)} papers (cached)")
    else:
        print_step("7", "Full-Text Screening")
        screener = ScreeningAgent(model=model)
        included_papers, ft_excluded = screener.screen_full_text(
            papers_for_ft_screening, protocol, parsed_papers, project
        )
        print(f"Full-text screening: {len(included_papers)} included, {len(ft_excluded)} excluded")
        for p in included_papers:
            print(f"  + {p.get('title', '')[:70]}")
        project.save_checkpoint("ft_screening")

    if len(included_papers) < 2 and not has_ipd_dataset:
        print(f"\n  Only {len(included_papers)} study(ies) after full-text screening (need >= 2).")
        print("  Generating narrative systematic review instead...")

        papers_for_extraction = _select_narrative_extraction_papers(
            included_papers=included_papers,
            papers_for_ft_screening=papers_for_ft_screening,
            ta_included_papers=ta_included_papers,
        )
        extracted_studies: list[ExtractedStudy] = []
        rob_results: list[StudyRoB] = []
        if papers_for_extraction:
            if project.is_step_done("extraction"):
                print_step("8", "Structured Data Extraction (narrative mode) [CACHED]")
                extracted_studies = [
                    ExtractedStudy.model_validate(item)
                    for item in (project.load_json("all_extractions.json", subdir="extraction") or [])
                ]
            else:
                project.clear_downstream("extraction")
                print_step("8", "Structured Data Extraction (narrative mode)")
                extractor = DataExtractionAgent(model=model)
                extracted_studies = extractor.run(papers_for_extraction, parsed_papers, protocol, project)
                project.save_checkpoint("extraction")
            print(f"Extracted data from {len(extracted_studies)} studies")
            for s in extracted_studies:
                c = s.characteristics
                print(f"  {_display_study_label(c)}: "
                      f"{len(s.outcomes)} outcome(s), design={c.study_design}")

            if project.is_step_done("rob"):
                print_step("9", "Risk of Bias Assessment (narrative mode) [CACHED]")
                rob_results = [
                    StudyRoB.model_validate(item)
                    for item in (project.load_json("rob_results.json", subdir="risk_of_bias") or [])
                ]
            else:
                project.clear_downstream("rob")
                print_step("9", "Risk of Bias Assessment (narrative mode)")
                rob_agent = RoBAgent(model=model)
                rob_results = rob_agent.run(extracted_studies, parsed_papers, project)
                project.save_checkpoint("rob")
            print(f"Risk of bias assessed for {len(rob_results)} studies")
            _run_evidence_understanding(
                project,
                model,
                included_papers=papers_for_extraction,
                parsed_papers=parsed_papers,
                extracted_studies=extracted_studies,
                rob_results=rob_results,
                protocol=protocol,
            )

        # Generate valid non-pooled figures and narrative manuscript.
        prisma_data = project.prisma.to_dict()
        _lang = _resolve_output_language(args)
        _write_narrative_manuscript_from_artifacts(
            project,
            args,
            model,
            protocol=protocol,
            search_query=search_query,
            extracted_studies=extracted_studies,
            rob_results=rob_results,
            included_papers=papers_for_extraction,
            prisma_data=prisma_data,
            lang=_lang,
            force_figures=True,
        )
        return

    # =========================================================================
    # Step 8: Data Extraction (with page/section traceability)
    # =========================================================================
    if project.is_step_done("extraction"):
        print_step("8", "Structured Data Extraction [CACHED]")
        extractions_data = project.load_json("all_extractions.json", subdir="extraction") or []
        extracted_studies = [ExtractedStudy.model_validate(s) for s in extractions_data]
        print(f"Extracted data from {len(extracted_studies)} studies (cached)")
    else:
        print_step("8", "Structured Data Extraction (page-aware)")
        extractor = DataExtractionAgent(model=model)
        extracted_studies = extractor.run(included_papers, parsed_papers, protocol, project)
        print(f"Extracted data from {len(extracted_studies)} studies")
        for s in extracted_studies:
            c = s.characteristics
            print(f"  {_display_study_label(c)}: "
                  f"{len(s.outcomes)} outcome(s), design={c.study_design}")
        project.save_checkpoint("extraction")

    extracted_studies = _augment_with_known_source_recovery(
        protocol,
        extracted_studies,
        project,
        run_mode=args.run_mode,
    )
    rct_reconciliation = _reconcile_project_rct_designs(
        project,
        protocol,
        extracted_studies,
        parsed_papers,
        allow_validating=args.allow_validating_methods,
    )
    if rct_reconciliation.get("multi_arm_studies"):
        print(
            "  Recompiled design-aware RCT route for "
            f"{len(rct_reconciliation['multi_arm_studies'])} eligible multi-arm study/studies."
        )

    # =========================================================================
    # Step 9: Risk of Bias Assessment (with page/section traceability)
    # =========================================================================
    if project.is_step_done("rob"):
        print_step("9", "Risk of Bias Assessment [CACHED]")
        rob_data = project.load_json("rob_results.json", subdir="risk_of_bias") or []
        rob_results = [StudyRoB.model_validate(r) for r in rob_data]
        print(f"Risk of bias assessed for {len(rob_results)} studies (cached)")
    else:
        print_step("9", "Risk of Bias Assessment (page-aware)")
        rob_agent = RoBAgent(model=model)
        rob_results = rob_agent.run(extracted_studies, parsed_papers, project)
        for r in rob_results:
            print(f"  {r.study_id}: {r.overall_judgment} ({r.tool_used})")
        project.save_checkpoint("rob")

    _run_evidence_understanding(
        project,
        model,
        included_papers=included_papers,
        parsed_papers=parsed_papers,
        extracted_studies=extracted_studies,
        rob_results=rob_results,
        protocol=protocol,
    )

    from new_meta.core.synthesis_routing import SynthesisRoute, load_synthesis_route

    synthesis_route = load_synthesis_route(project)
    if synthesis_route.route is SynthesisRoute.METHOD_PLUGIN:
        from new_meta.core.method_delivery import run_method_delivery, MethodDeliveryBlocked
        from new_meta.core.method_artifacts import clear_stale_compiled_method_outputs
        from new_meta.core.method_figures import generate_method_figures
        from new_meta.core.method_manuscript import merge_method_manuscript_validation
        from new_meta.schemas.phase_result import ExecutionStatus

        print_step("10", "Compiled Method Synthesis")
        _lang = _resolve_output_language(args)
        removed_outputs = clear_stale_compiled_method_outputs(project)
        if removed_outputs:
            logger.info(
                "Removed %d stale pairwise/manuscript artifacts before compiled synthesis",
                len(removed_outputs),
            )
        result_rob_agent = RoBAgent(model=model)

        def prepare_method_result_rob(result_ids: list[str]):
            return result_rob_agent.complete_result_level_assessments(
                project=project,
                extracted_studies=extracted_studies,
                parsed_papers=parsed_papers,
                study_assessments=rob_results,
                required_result_ids=result_ids,
            )

        method_options = (
            project.load_json("ipd_analysis_options.json", subdir="analysis") or None
            if synthesis_route.capability_id == "ipd_meta.parallel_two_stage"
            else None
        )
        method_delivery = run_method_delivery(
            project=project,
            protocol=protocol,
            extracted_studies=extracted_studies,
            rob_results=rob_results,
            prisma_data=project.prisma.to_dict(),
            search_query=search_query,
            lang=_lang,
            options=method_options,
            auto_resolve_uncertainty=args.skip_confirm,
            prepare_result_rob=prepare_method_result_rob,
        )
        if (
            method_delivery.phase.error_code == "analysis_set_adjudication_required"
            and not args.skip_confirm
        ):
            _prompt_cli_analysis_set(project, method_delivery.phase)
            method_delivery = run_method_delivery(
                project=project,
                protocol=protocol,
                extracted_studies=extracted_studies,
                rob_results=rob_results,
                prisma_data=project.prisma.to_dict(),
                search_query=search_query,
                lang=_lang,
                options=method_options,
                auto_resolve_uncertainty=False,
                prepare_result_rob=prepare_method_result_rob,
            )
        if method_delivery.phase.status is not ExecutionStatus.SUCCEEDED:
            project.save_json(
                "method_delivery_status.json",
                method_delivery.phase,
                subdir="analysis",
            )
            raise MethodDeliveryBlocked(method_delivery.phase)
        if method_delivery.decisions and not args.skip_confirm:
            _prompt_cli_method_certainty(project)
            from new_meta.core.method_manuscript import build_method_manuscript

            build_method_manuscript(
                project=project,
                protocol=protocol,
                extracted_studies=extracted_studies,
                rob_results=rob_results,
                prisma_data=project.prisma.to_dict(),
                search_query=search_query,
                lang=_lang,
            )

        figures_dir = project.base_dir / "figures"
        figures_dir.mkdir(exist_ok=True)
        try:
            visualization.prisma_flow_diagram(
                project.prisma.to_dict(),
                str(figures_dir / "prisma_diagram.png"),
                lang=_lang,
            )
            project.save_checkpoint("figures")
        except Exception as exc:
            project.add_warning(
                "figures",
                f"PRISMA diagram generation failed: {exc}",
                code="prisma_figure_failed",
            )
        try:
            generated_method_figures = generate_method_figures(
                project,
                lang=_lang,
                extracted_studies=extracted_studies,
                rob_results=rob_results,
            )
            if generated_method_figures:
                print(f"  Generated compiled-method figures: {', '.join(generated_method_figures)}")
        except Exception as exc:
            project.add_warning(
                "figures",
                f"Compiled-method figure generation failed: {exc}",
                code="method_figures_failed",
            )

        ref_manager = ReferenceManager()
        for paper in included_papers:
            ref_manager.add(paper, study_id=paper_identity(paper))
        _add_evidence_context_references(project, protocol, ref_manager, search_query=search_query)
        _add_methodology_references(
            project,
            ref_manager,
            include_rob=bool(rob_results),
            include_grade=True,
            include_publication_bias=False,
        )
        project.save_text("references.bib", ref_manager.to_bibtex())
        print_step("13", "Manuscript Generation")
        writer = WritingAgent(model=model, lang=_lang, topic=args.topic)
        manuscript = writer.run(
            protocol=protocol,
            meta_results=None,
            extracted_studies=extracted_studies,
            rob_results=rob_results,
            prisma_data=project.prisma.to_dict(),
            search_query=search_query,
            project=project,
            ref_manager=ref_manager,
            grade_profile=None,
            figures_b64=_load_figures_b64(project),
        )
        project.save_text("references.bib", ref_manager.to_bibtex())
        manuscript = _polish_project_manuscript(project, args, model=model, lang=_lang) or manuscript
        _run_final_manuscript_llm_readiness_review(project, model=model, lang=_lang)
        manuscript = project.load_text("draft.md", subdir="manuscript") or manuscript
        merge_method_manuscript_validation(
            project=project,
            manuscript=manuscript,
            lang=_lang,
        )
        project.save_checkpoint("manuscript")
        write_llm_usage_manifest(project)
        package_path = create_artifact_package(project)
        _finalize_cli_release(
            project,
            package_path,
            success_label="Complete (Compiled Method Synthesis)",
        )
        print(f"Project directory: {project.base_dir}")
        print(f"  Manuscript: {project.base_dir / 'manuscript' / 'draft.md'}")
        print(f"  Synthesis result: {project.base_dir / 'analysis' / 'synthesis_result.json'}")
        print(f"  Artifact package: {package_path}")
        return

    # =========================================================================
    # Step 10: Effect Size Computation
    # =========================================================================
    print_step("10", "Effect Size Computation")
    selection_result = _compute_cli_primary_effect_selection(
        project=project,
        protocol=protocol,
        extracted_studies=extracted_studies,
        rob_results=rob_results,
        included_papers=included_papers,
    )
    study_effects = selection_result.data["effects"]
    primary_selection_audit = selection_result.data["selection_audit"]
    for effect in study_effects:
        yi_display = meta_engine._to_original(effect.yi, protocol.effect_measure, effect.vi)
        print(f"  {effect.study_label}: {protocol.effect_measure}={yi_display:.4f}, SE={effect.se:.4f}")

    if len(study_effects) < 2:
        print(f"\n  Only {len(study_effects)} study(ies) with computable effect sizes (need >= 2).")
        print("  Switching to narrative synthesis mode...")

        # Narrative synthesis: generate report without quantitative meta-analysis
        # Generate PRISMA diagram and manuscript directly
        prisma_data = project.prisma.to_dict()

        figures_dir = project.base_dir / "figures"
        figures_dir.mkdir(exist_ok=True)
        _lang = _resolve_output_language(args)

        try:
            visualization.prisma_flow_diagram(
                prisma_data,
                str(figures_dir / "prisma_diagram.png"),
                lang=_lang,
            )
            print("  Generated: prisma_diagram.png")
        except Exception as e:
            logger.warning(f"PRISMA diagram generation failed: {e}")

        # Build references
        ref_manager = ReferenceManager()
        for paper in included_papers:
            ref_manager.add(paper, study_id=paper_identity(paper))
        _add_evidence_context_references(project, protocol, ref_manager, search_query=search_query)
        _add_methodology_references(
            project,
            ref_manager,
            include_rob=bool(rob_results),
            include_grade=False,
            include_publication_bias=False,
        )

        # Generate narrative manuscript
        gate_result, report_state = _evaluate_evidence_gate_for_report(
            project,
            protocol,
            extracted_studies,
            prisma_data,
        )
        writer = WritingAgent(model=model, narrative_mode=True, topic=args.topic, lang=_lang)
        manuscript = writer.run(
            protocol=protocol,
            extracted_studies=extracted_studies,
            rob_results=rob_results,
            prisma_data=prisma_data,
            search_query=search_query,
            project=project,
            ref_manager=ref_manager,
            figures_b64=_load_figures_b64(project),
            evidence_classes=gate_result.evidence_classes,
            report_state=report_state,
        )
        project.save_text("references.bib", ref_manager.to_bibtex())
        manuscript = _polish_project_manuscript(project, args, model=model, lang=_lang) or manuscript
        _run_final_manuscript_llm_readiness_review(project, model=model, lang=_lang)

        project.save_checkpoint("manuscript")
        write_llm_usage_manifest(project)
        package_path = create_artifact_package(project)

        _finalize_cli_release(
            project,
            package_path,
            success_label="Complete (Narrative Synthesis)",
        )
        print(f"Project directory: {project.base_dir}")
        print(f"  Manuscript: {project.base_dir / 'manuscript' / 'draft.md'}")
        print(f"  PRISMA 2020: {figures_dir / 'prisma_diagram.png'}")
        print(f"  Artifact package: {package_path}")
        print(f"  Note: Quantitative meta-analysis could not be performed due to insufficient studies.")
        return

    # =========================================================================
    # Step 11: Meta-Analysis (Pairwise + optional NMA) + GRADE
    # =========================================================================
    meta_results = _run_meta_analysis_from_effects(
        project,
        protocol=protocol,
        extracted_studies=extracted_studies,
        study_effects=study_effects,
    )
    primary_result = meta_results.primary_outcome
    cumulative_results = meta_results.cumulative
    nma_result = meta_results.nma_result
    pub_bias = meta_results.publication_bias
    regression_results = meta_results.meta_regression

    grade_profile = _run_grade_from_cached_meta(
        project,
        model,
        protocol=protocol,
        meta_results=meta_results,
        rob_results=rob_results,
        extracted_studies=extracted_studies,
    )

    # =========================================================================
    # Step 12: Figure Generation
    # =========================================================================
    _lang = _resolve_output_language(args)
    _generate_figures_from_cached_meta(
        project,
        protocol=protocol,
        meta_results=meta_results,
        study_effects=study_effects,
        lang=_lang,
    )
    figures_dir = project.base_dir / "figures"
    prisma_data = project.prisma.to_dict()

    # =========================================================================
    # Step 13: Manuscript Generation
    # =========================================================================
    print_step("13", "Manuscript Generation")

    # Build references
    ref_manager = ReferenceManager()
    for paper in included_papers:
        ref_manager.add(paper, study_id=paper_identity(paper))
    _add_benchmark_references(ref_manager, extracted_studies)
    _add_evidence_context_references(project, protocol, ref_manager, search_query=search_query)
    _add_methodology_references(
        project,
        ref_manager,
        include_rob=bool(rob_results),
        include_grade=grade_profile is not None,
        include_publication_bias=True,
    )
    project.save_text("references.bib", ref_manager.to_bibtex())
    gate_result, report_state = _evaluate_evidence_gate_for_report(
        project,
        protocol,
        extracted_studies,
        prisma_data,
    )

    writer = WritingAgent(model=model, lang=_lang, topic=args.topic)
    manuscript = writer.run(
        protocol=protocol,
        meta_results=meta_results,
        extracted_studies=extracted_studies,
        rob_results=rob_results,
        prisma_data=prisma_data,
        search_query=search_query,
        project=project,
        ref_manager=ref_manager,
        grade_profile=grade_profile,
        figures_b64=_load_figures_b64(project),
        evidence_classes=gate_result.evidence_classes,
        report_state=report_state,
    )
    project.save_text("references.bib", ref_manager.to_bibtex())
    manuscript = _polish_project_manuscript(project, args, model=model, lang=_lang) or manuscript
    _run_final_manuscript_llm_readiness_review(project, model=model, lang=_lang)

    project.save_checkpoint("manuscript")
    write_llm_usage_manifest(project)
    package_path = create_artifact_package(project)

    # =========================================================================
    # Summary
    # =========================================================================
    _finalize_cli_release(project, package_path, success_label="Complete!")

    print(f"Project directory: {project.base_dir}")
    print(f"\nKey outputs:")
    print(f"  Manuscript:         {project.base_dir / 'manuscript' / 'draft.md'}")
    print(f"  Forest plot:        {figures_dir / 'forest_plot.png'}")
    print(f"  Funnel plot:        {figures_dir / 'funnel_plot.png'}")
    print(f"  Contour funnel:     {figures_dir / 'contour_funnel_plot.png'}")
    print(f"  PRISMA 2020:        {figures_dir / 'prisma_diagram.png'}")
    print(f"  RoB summary:        {figures_dir / 'rob_summary.png'}")
    print(f"  Sensitivity:        {figures_dir / 'sensitivity.png'}")
    if cumulative_results:
        print(f"  Cumulative forest:  {figures_dir / 'cumulative_forest.png'}")
    if nma_result:
        print(f"  NMA network:        {figures_dir / 'nma_network.png'}")
    print(f"  References:         {project.base_dir / 'references.bib'}")
    print(f"  Artifact package:   {package_path}")
    if grade_profile:
        print(f"  GRADE profile:      {project.base_dir / 'analysis' / 'grade_profile.json'}")

    print(f"\nResults summary:")
    print(f"  Studies included: {primary_result.n_studies}")
    print(f"  Pooled {protocol.effect_measure}: {primary_result.pooled_effect:.3f} "
          f"(95% CI: {primary_result.ci_lower:.3f} to {primary_result.ci_upper:.3f})")
    print(f"  p-value: {primary_result.p_value:.4f}")
    print(f"  Heterogeneity: I\u00b2={primary_result.i_squared:.1f}%")

    if pub_bias.egger_p_value is not None and not (isinstance(pub_bias.egger_p_value, float) and pub_bias.egger_p_value != pub_bias.egger_p_value):
        print(f"  Publication bias (Egger's p): {pub_bias.egger_p_value:.4f}")
    pet_peese_summary = _format_pet_peese_summary(pub_bias, protocol.effect_measure)
    if pet_peese_summary:
        print(pet_peese_summary)

    if grade_profile and grade_profile.outcomes:
        primary_grade = grade_profile.outcomes[0]
        print(f"  GRADE certainty: {primary_grade.certainty}")

    if nma_result:
        print(f"  NMA treatments: {len(nma_result.treatments)}")
        if nma_result.sucra_rankings:
            best = max(nma_result.sucra_rankings, key=nma_result.sucra_rankings.get)
            print(f"  Best treatment (SUCRA): {best} ({nma_result.sucra_rankings[best]:.1%})")

    if regression_results:
        for mr in regression_results:
            print(f"  Meta-regression ({mr.covariate_name}): \u03b2={mr.coefficient:.4f}, R\u00b2={mr.r_squared_analog:.1%}")

    print(f"\nManuscript: {len(manuscript.split())} words")
    print(f"\nDone.")


if __name__ == "__main__":
    import sys
    import os
    if sys.platform == "win32":
        os.environ.setdefault("PYTHONIOENCODING", "utf-8")
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    try:
        main()
    except Exception as exc:
        from new_meta.core.release_contract import ReleaseBlockedError

        if isinstance(exc, ReleaseBlockedError):
            sys.exit(2)
        raise
