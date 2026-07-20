"""Local registry metadata seeds for registry-first trial recall.

These records are intentionally metadata-only. They can help surface
registered/unpublished trials when live registry APIs are unavailable, but they
must not be treated as extracted outcome data.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any


DEFAULT_SEED_PATH = Path(__file__).resolve().parents[1] / "data" / "registry_seed_trials.json"


def load_seed_trials(path: str | Path | None = None) -> list[dict[str, Any]]:
    """Load registry seed records from bundled and optional local JSON files."""
    paths = [Path(path)] if path else [DEFAULT_SEED_PATH]
    extra_path = os.getenv("REGISTRY_SEED_PATH")
    if extra_path and (not path or Path(extra_path) not in paths):
        paths.append(Path(extra_path))

    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for seed_path in paths:
        if not seed_path.exists():
            continue
        try:
            payload = json.loads(seed_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(payload, list):
            continue
        for item in payload:
            if not isinstance(item, dict):
                continue
            nct_id = str(item.get("nct_id") or item.get("trial_registration") or "").strip().upper()
            title = str(item.get("title") or "").strip()
            key = nct_id or title.lower()
            if not key or key in seen:
                continue
            seen.add(key)
            records.append(item)
    return records


def search_seed_records(
    query: str,
    *,
    max_results: int = 20,
    year_range: tuple[int | None, int | None] | None = None,
    seed_path: str | Path | None = None,
) -> tuple[list[dict], dict]:
    """Return seed records that match a topic query."""
    records = []
    attempts = []
    for seed in load_seed_trials(seed_path):
        score, reasons = _score_seed(query, seed)
        attempts.append({
            "nct_id": seed.get("nct_id") or "",
            "title": seed.get("title") or "",
            "score": score,
            "matched": score >= 7,
            "reasons": reasons,
        })
        if score < 7:
            continue
        record = seed_to_record(seed)
        if not _record_in_year_range(record, year_range):
            continue
        record["registry_seed_score"] = score
        record["registry_seed_reasons"] = reasons
        records.append(record)
    records.sort(key=lambda item: (item.get("registry_seed_score") or 0, item.get("year") or 0), reverse=True)
    records = records[:max_results]
    return records, {
        "status": "ok",
        "n_records": len(records),
        "attempts": attempts,
    }


def seed_to_record(seed: dict[str, Any]) -> dict:
    """Convert one local seed into a paper-like retrieval record."""
    nct_id = str(seed.get("nct_id") or "").strip().upper()
    aliases = [str(alias) for alias in seed.get("aliases", []) or [] if alias]
    conditions = [str(item) for item in seed.get("conditions", []) or [] if item]
    interventions = [str(item) for item in seed.get("interventions", []) or [] if item]
    summary = str(seed.get("brief_summary") or "")
    abstract_parts = [
        summary,
        "Aliases: " + "; ".join(aliases),
        "Conditions: " + "; ".join(conditions),
        "Interventions: " + "; ".join(interventions),
        "Registry source: " + str(seed.get("registry_source") or ""),
        "Metadata-only registry seed; outcome event counts require source verification or user extraction.",
    ]
    abstract = "\n\n".join(part for part in abstract_parts if part and not part.endswith(": "))
    return {
        "title": str(seed.get("title") or nct_id).strip(),
        "authors": [str(seed.get("sponsor"))] if seed.get("sponsor") else [],
        "year": seed.get("year") or 0,
        "doi": "",
        "pmid": "",
        "abstract": abstract,
        "journal": str(seed.get("registry_source") or "Registry seed"),
        "url": str(seed.get("source_url") or ""),
        "source": "registry_seed",
        "source_type": "registry_seed",
        "trial_registration": nct_id,
        "nct_id": nct_id,
        "clinicaltrials_id": nct_id,
        "registry_source": str(seed.get("registry_source") or ""),
        "registry_seed": True,
        "metadata_only": True,
        "text_availability": "metadata_only",
        "fulltext_source": "registry_seed_metadata",
        "needs_user_full_text": True,
        "study_status": str(seed.get("study_status") or ""),
        "study_design": "Randomized controlled trial",
        "interventions": interventions,
        "conditions": conditions,
        "outcomes": [],
        "aliases": aliases,
        "source_urls": [str(url) for url in seed.get("source_urls", []) or [] if url],
        "source_warning": "registry_seed_metadata_only",
    }


def _score_seed(query: str, seed: dict[str, Any]) -> tuple[int, list[str]]:
    query_text = _normalise(query)
    seed_text = _normalise(" ".join([
        str(seed.get("title") or ""),
        str(seed.get("brief_summary") or ""),
        " ".join(str(alias) for alias in seed.get("aliases", []) or []),
        " ".join(str(item) for item in seed.get("conditions", []) or []),
        " ".join(str(item) for item in seed.get("interventions", []) or []),
    ]))
    score = 0
    reasons: list[str] = []

    concept_groups = [
        ("disease", ["covid", "sars cov", "coronavirus"], 3),
        ("design", ["randomized", "randomised", "trial", "rct"], 2),
        ("critical_illness", ["critically ill", "critical illness", "icu", "intensive care", "ards", "respiratory failure", "hypoxia", "severe"], 2),
        ("comparator", ["standard care", "usual care", "placebo", "control"], 1),
    ]
    for name, terms, weight in concept_groups:
        if _any_term(query_text, terms) and _any_term(seed_text, terms):
            score += weight
            reasons.append(name)

    intervention_terms = [
        "methylprednisolone",
        "hydrocortisone",
        "dexamethasone",
        "prednisone",
        "prednisolone",
        "corticosteroid",
        "glucocorticoid",
        "steroid",
    ]
    q_interventions = [term for term in intervention_terms if term in query_text]
    s_interventions = [term for term in intervention_terms if term in seed_text]
    overlap = set(q_interventions) & set(s_interventions)
    if overlap:
        score += 3
        reasons.append("intervention:" + ",".join(sorted(overlap)))
    elif q_interventions and s_interventions and _same_steroid_class(q_interventions, s_interventions):
        score += 2
        reasons.append("intervention_class")

    return score, reasons


def _record_in_year_range(record: dict, year_range: tuple[int | None, int | None] | None) -> bool:
    if not year_range:
        return True
    start_year, end_year = year_range
    year = int(record.get("year") or 0)
    if start_year and year and year < start_year:
        return False
    if end_year and year and year > end_year:
        return False
    return True


def _normalise(text: Any) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", str(text or "").lower())).strip()


def _any_term(text: str, terms: list[str]) -> bool:
    return any(term in text for term in terms)


def _same_steroid_class(left: list[str], right: list[str]) -> bool:
    steroid_markers = {"corticosteroid", "glucocorticoid", "steroid"}
    return bool(set(left) & steroid_markers or set(right) & steroid_markers)
