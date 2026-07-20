"""Review positioning: decide whether a run is reproduction, update, or new synthesis."""
from __future__ import annotations

import re
from typing import Any

from new_meta.core.project import Project
from new_meta.schemas.meta_result import MetaAnalysisResults
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.schemas.study import ExtractedStudy


def build_review_positioning(
    *,
    project: Project | None,
    protocol: ResearchProtocol,
    extracted_studies: list[ExtractedStudy] | None = None,
    meta_results: MetaAnalysisResults | None = None,
) -> dict[str, Any]:
    """Build a structured novelty/positioning payload for manuscript writing.

    The payload is deterministic and conservative. It does not invent novelty:
    if the run is backed by a declared benchmark comparator, it is labeled as a
    reproduction/benchmark-aligned synthesis unless additional update evidence
    is explicitly present.
    """
    extracted_studies = extracted_studies or []
    known_source = _load_project_json(project, "known_source_reference_set.json", subdir="extraction") or []
    known_prefs = _load_project_json(project, "known_source_protocol_preferences.json", subdir="extraction") or {}
    evidence_context = _load_project_json(project, "evidence_context.json", subdir="analysis")
    if evidence_context is None:
        evidence_context = _load_project_json(project, "evimed_evidence_context.json", subdir="analysis")

    anchor = _anchor_from_known_source(known_source, known_prefs)
    prior_reviews = _merge_prior_reviews(
        _prior_review_candidates(evidence_context),
        _prior_reviews_from_search_results(project),
    )
    primary_ids = _primary_ids(meta_results)
    extracted_ids = {_study_id(study) for study in extracted_studies if _study_id(study)}
    added_ids = sorted(extracted_ids - set(primary_ids)) if primary_ids else []

    if anchor:
        category = "reproduction_or_benchmark_alignment"
        report_type = "benchmark_reconstruction"
        manuscript_stance = (
            "Benchmark-aligned reproduction: the analysis should explain that it tests whether the automated "
            "pipeline can recover the trial set, effect measure, model choice, and pooled estimate of the declared "
            "published synthesis while preserving primary-source provenance."
        )
    elif prior_reviews:
        category = "potential_update_or_expansion"
        report_type = "updated_meta_analysis"
        manuscript_stance = (
            "Potential update or expansion: the manuscript should state how the current search date, eligible "
            "population, outcomes, or analysis choices differ from earlier systematic reviews."
        )
    else:
        category = "new_or_unclear"
        report_type = "updated_meta_analysis"
        manuscript_stance = (
            "No closely matching prior synthesis was recorded by the pipeline; the manuscript should avoid claiming "
            "novelty beyond the documented search and evidence set."
        )

    return {
        "schema_version": 1,
        "category": category,
        "report_type": report_type,
        "anchor_review": anchor,
        "prior_reviews": prior_reviews[:10],
        "primary_study_ids": primary_ids,
        "non_primary_extracted_ids": added_ids,
        "manuscript_stance": manuscript_stance,
        "requires_human_novelty_review": category != "reproduction_or_benchmark_alignment",
        "topic_terms": _topic_terms(protocol),
    }


def ensure_review_positioning(
    *,
    project: Project | None,
    protocol: ResearchProtocol,
    extracted_studies: list[ExtractedStudy] | None = None,
    meta_results: MetaAnalysisResults | None = None,
) -> dict[str, Any]:
    """Build, save, and return positioning metadata."""
    payload = build_review_positioning(
        project=project,
        protocol=protocol,
        extracted_studies=extracted_studies,
        meta_results=meta_results,
    )
    if project is not None:
        project.save_json("positioning.json", payload, subdir="analysis")
    return payload


def _load_project_json(project: Project | None, filename: str, subdir: str | None = None) -> Any:
    if project is None:
        return None
    try:
        return project.load_json(filename, subdir=subdir)
    except Exception:
        return None


def _anchor_from_known_source(known_source: Any, known_prefs: Any) -> dict[str, Any] | None:
    prefs = known_prefs if isinstance(known_prefs, dict) else {}
    source_label = str(prefs.get("source_label") or prefs.get("source_id") or "").strip()
    if isinstance(known_source, dict):
        label = str(known_source.get("source_label") or known_source.get("title") or "").strip()
        source_id = str(known_source.get("source_id") or "").strip()
        if label or source_id or source_label:
            return {
                "source_id": source_id or str(prefs.get("source_id") or "").strip(),
                "label": label or source_label,
                "role": "published benchmark comparator",
            }
    if isinstance(known_source, list) and known_source:
        first = known_source[0] if isinstance(known_source[0], dict) else {}
        label = str(first.get("source_label") or first.get("title") or source_label or "").strip()
        return {
            "source_id": str(first.get("source_id") or prefs.get("source_id") or "").strip(),
            "label": label,
            "role": "published benchmark comparator",
        }
    if source_label:
        return {
            "source_id": str(prefs.get("source_id") or "").strip(),
            "label": source_label,
            "role": "published benchmark comparator",
        }
    return None


def _prior_review_candidates(evidence_context: Any) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    items = []
    if isinstance(evidence_context, dict):
        for key in ("references", "items", "papers", "results", "evidence"):
            value = evidence_context.get(key)
            if isinstance(value, list):
                items.extend(value)
    elif isinstance(evidence_context, list):
        items = evidence_context
    for item in items:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or item.get("name") or "").strip()
        if not title:
            continue
        text = " ".join(str(item.get(key) or "") for key in ("title", "abstract", "journal", "source_type")).lower()
        if not re.search(r"\b(meta-analysis|meta analysis|systematic review|living review)\b", text):
            continue
        candidates.append({
            "title": title,
            "year": item.get("year") or item.get("publication_year"),
            "doi": item.get("doi") or "",
            "source": item.get("source") or item.get("journal") or "",
            "role": "prior systematic review or meta-analysis candidate",
        })
    return candidates


def _prior_reviews_from_search_results(project: Project | None) -> list[dict[str, Any]]:
    """Mine systematic reviews / meta-analyses already retrieved by the search.

    The primary-study search routinely returns prior reviews on the same question
    (they are later excluded at screening because they are not primary trials).
    Mining them by PubMed publication type gives deterministic prior-review
    candidates for any topic, without an extra network call, instead of relying
    only on the background-citation context — which is empty for most generic
    topics and made positioning collapse to "new_or_unclear".
    """
    records = _load_project_json(project, "search_results.json")
    papers = records if isinstance(records, list) else []
    candidates: list[dict[str, Any]] = []
    for paper in papers:
        if not isinstance(paper, dict):
            continue
        title = str(paper.get("title") or "").strip()
        if not title:
            continue
        pub_types = paper.get("pub_types") if isinstance(paper.get("pub_types"), list) else []
        if not (_pub_types_indicate_review(pub_types) or _text_indicates_review(title)):
            continue
        candidates.append({
            "title": title,
            "year": paper.get("year") or paper.get("epub_year"),
            "doi": paper.get("doi") or "",
            "source": paper.get("journal") or "",
            "role": "prior systematic review or meta-analysis candidate",
            "detected_from": "search_results",
        })
    return candidates


def _pub_types_indicate_review(pub_types: list[Any]) -> bool:
    joined = " ".join(str(pt or "").lower() for pt in pub_types or [])
    return bool(re.search(r"meta-analysis|systematic review", joined))


def _text_indicates_review(text: str) -> bool:
    return bool(re.search(r"\b(meta-analysis|meta analysis|systematic review|living review)\b", str(text or ""), re.I))


def _merge_prior_reviews(*lists: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for candidates in lists:
        for item in candidates or []:
            if not isinstance(item, dict):
                continue
            doi = str(item.get("doi") or "").strip().lower()
            key = doi or re.sub(r"[^a-z0-9]+", "", str(item.get("title") or "").lower())[:80]
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(item)
    return merged


def _primary_ids(meta_results: MetaAnalysisResults | None) -> list[str]:
    if not meta_results or not meta_results.primary_outcome:
        return []
    ids: list[str] = []
    for study in meta_results.primary_outcome.studies:
        value = str(getattr(study, "study_id", "") or "").strip()
        if value and value not in ids:
            ids.append(value)
    return ids


def _study_id(study: ExtractedStudy) -> str:
    c = getattr(study, "characteristics", None)
    for attr in ("pmid", "study_id", "doi"):
        value = str(getattr(c, attr, "") or "").strip()
        if value:
            return value
    return ""


def _topic_terms(protocol: ResearchProtocol) -> list[str]:
    fields = [
        getattr(protocol, "research_question", ""),
        getattr(protocol.pico, "population", ""),
        getattr(protocol.pico, "intervention", ""),
        getattr(protocol.pico, "comparator", ""),
        getattr(protocol.pico, "outcome_primary", ""),
    ]
    text = " ".join(str(value or "").lower() for value in fields)
    stop = {"with", "without", "among", "patients", "patient", "adult", "adults", "versus", "usual", "care"}
    terms = []
    for token in re.findall(r"[a-z0-9][a-z0-9-]{2,}", text):
        if token in stop or token in terms:
            continue
        terms.append(token)
    return terms[:20]
