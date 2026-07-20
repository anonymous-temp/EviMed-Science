"""ClinicalTrials.gov API v2 helpers for registry fallback retrieval."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

import requests

logger = logging.getLogger("metaagent.clinicaltrials")

API_BASE = "https://clinicaltrials.gov/api/v2"
DEFAULT_TIMEOUT = int(os.getenv("CLINICALTRIALS_TIMEOUT", "5"))
FAILED_CACHE_TTL = int(os.getenv("CLINICALTRIALS_FAILED_CACHE_TTL", "3600"))
HEADERS = {"User-Agent": os.getenv("CLINICALTRIALS_USER_AGENT", "MetaAgent/1.0")}
MAX_QUERY_TERM_CHARS = int(os.getenv("CLINICALTRIALS_QUERY_TERM_MAX_CHARS", "240"))
CACHE_SCHEMA_VERSION = 3

_QUERY_STOPWORDS = {
    "adrenal",
    "artificial",
    "clinical",
    "controlled",
    "cortex",
    "hormones",
    "illness",
    "infections",
    "intensive",
    "randomized",
    "randomised",
    "respiration",
    "sars",
    "study",
    "trial",
    "units",
}


def extract_nct_ids(text: str) -> list[str]:
    """Extract unique NCT identifiers from free text."""
    ids = []
    for match in re.findall(r"\bNCT\d{8}\b", text or "", flags=re.IGNORECASE):
        nct_id = match.upper()
        if nct_id not in ids:
            ids.append(nct_id)
    return ids


def search_studies(query: str, max_results: int = 20, timeout: int = DEFAULT_TIMEOUT) -> list[dict]:
    """Search ClinicalTrials.gov and return MetaAgent paper-like records."""
    records, _ = search_studies_with_status(query, max_results=max_results, timeout=timeout)
    return records


def search_studies_with_status(
    query: str,
    max_results: int = 20,
    timeout: int = DEFAULT_TIMEOUT,
) -> tuple[list[dict], dict]:
    """Search ClinicalTrials.gov and return records plus a status manifest entry."""
    if not query:
        return [], {"query": query, "status": "skipped", "n_records": 0, "error": "empty_query"}
    query_term = sanitize_query_term(query)
    params = {
        "format": "json",
        "query.term": query_term,
        "pageSize": max(1, min(int(max_results or 20), 100)),
    }
    try:
        resp = requests.get(f"{API_BASE}/studies", params=params, timeout=timeout, headers=HEADERS)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        logger.warning("ClinicalTrials.gov search failed for %r: %s", query[:120], exc)
        return [], {
            "query": query,
            "status": "failed",
            "n_records": 0,
            "error": str(exc),
            "timeout": timeout,
        }
    records = []
    for study in data.get("studies", []) or []:
        record = study_to_record(study)
        if record:
            records.append(record)
    records = records[:max_results]
    return records, {
        "query": query,
        "query_term": query_term,
        "query_sanitized": query_term != query,
        "status": "ok",
        "n_records": len(records),
        "error": "",
        "timeout": timeout,
    }


def sanitize_query_term(query: str) -> str:
    """Convert PubMed/MeSH-style strings into ClinicalTrials.gov free-text terms."""
    text = str(query or "").strip()
    nct_ids = extract_nct_ids(text)
    if nct_ids:
        return " ".join(nct_ids)
    text = re.sub(r"\[[^\]]+\]", " ", text)
    text = re.sub(r"\b(AND|OR|NOT)\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"[\"'()*,:;/\\]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= MAX_QUERY_TERM_CHARS and not any(ch in text for ch in "[],"):
        return text

    focused = _focused_registry_query(text)
    if focused:
        return focused

    seen: set[str] = set()
    kept: list[str] = []
    for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9.+-]*", text):
        normalized = token.lower().strip("-")
        if len(normalized) < 3 or normalized in _QUERY_STOPWORDS or normalized in seen:
            continue
        seen.add(normalized)
        kept.append(token)

    priority_terms = [
        token for token in kept
        if re.search(
            r"covid|coronavirus|nct\d+|dexamethasone|hydrocortisone|methylprednisolone|prednisone|prednisolone|corticosteroid|glucocorticoid|steroid|icu|ventilat|critical|mortality|death",
            token,
            flags=re.IGNORECASE,
        )
    ]
    remainder = [token for token in kept if token not in priority_terms]
    compact: list[str] = []
    for token in priority_terms + remainder:
        candidate = " ".join(compact + [token])
        if len(candidate) > MAX_QUERY_TERM_CHARS:
            break
        compact.append(token)
    return " ".join(compact) or text[:MAX_QUERY_TERM_CHARS].strip()


def _focused_registry_query(text: str) -> str:
    """Build a conservative registry query from high-signal disease/drug terms."""
    lower = text.lower()
    disease = ""
    if "covid" in lower or "sars" in lower or "coronavirus" in lower:
        disease = "COVID-19"
    drug_patterns = [
        "dexamethasone",
        "hydrocortisone",
        "methylprednisolone",
        "prednisone",
        "prednisolone",
        "corticosteroid",
        "glucocorticoid",
        "steroid",
    ]
    drugs = []
    for term in drug_patterns:
        if re.search(rf"\b{re.escape(term)}s?\b", lower) and term not in drugs:
            drugs.append(term)
    if not disease and not drugs:
        return ""
    terms = [disease, *drugs[:6]]
    if "random" in lower or "rct" in lower or "clinical trial" in lower:
        terms.extend(["randomized", "trial"])
    query = " ".join(term for term in terms if term)
    return query[:MAX_QUERY_TERM_CHARS].strip()


def search_studies_cached(
    query: str,
    cache_dir: str | Path | None = None,
    max_results: int = 20,
    timeout: int = DEFAULT_TIMEOUT,
) -> tuple[list[dict], dict]:
    """Search with project-local cache to avoid repeated slow registry calls."""
    cache_path = _cache_path(cache_dir, "query", query)
    if cache_path and cache_path.exists():
        payload = _read_cache(cache_path)
        records = payload.get("records", [])
        status = payload.get("status", {})
        if _cache_payload_is_current(payload) and (status.get("status") == "ok" or _failed_cache_is_fresh(payload)):
            cached_status = "cached" if status.get("status") == "ok" else "cached_failed"
            status = {**status, "status": cached_status, "cache_path": str(cache_path), "n_records": len(records)}
            return records, status
    records, status = search_studies_with_status(query, max_results=max_results, timeout=timeout)
    if cache_path and (status.get("status") == "ok" or _should_cache_failure(status)):
        _write_cache(cache_path, {
            "schema_version": CACHE_SCHEMA_VERSION,
            "records": records,
            "status": status,
            "cached_at": time.time(),
        })
    return records, status


def fetch_study(nct_id: str, timeout: int = DEFAULT_TIMEOUT) -> dict | None:
    """Fetch one ClinicalTrials.gov study by NCT ID."""
    record, _ = fetch_study_with_status(nct_id, timeout=timeout)
    return record


def fetch_study_with_status(nct_id: str, timeout: int = DEFAULT_TIMEOUT) -> tuple[dict | None, dict]:
    """Fetch one ClinicalTrials.gov study by NCT ID with status metadata."""
    nct_id = str(nct_id or "").strip()
    if not nct_id:
        return None, {"nct_id": nct_id, "status": "skipped", "error": "empty_nct_id"}
    try:
        resp = requests.get(
            f"{API_BASE}/studies/{nct_id}",
            params={"format": "json"},
            timeout=timeout,
            headers=HEADERS,
        )
        resp.raise_for_status()
        record = study_to_record(resp.json())
        return record, {"nct_id": nct_id, "status": "ok", "n_records": 1 if record else 0, "error": ""}
    except Exception as exc:
        logger.warning("ClinicalTrials.gov fetch failed for %s: %s", nct_id, exc)
        return None, {"nct_id": nct_id, "status": "failed", "n_records": 0, "error": str(exc), "timeout": timeout}


def fetch_study_cached(
    nct_id: str,
    cache_dir: str | Path | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> tuple[dict | None, dict]:
    """Fetch one NCT ID with cache."""
    cache_path = _cache_path(cache_dir, "nct", nct_id)
    if cache_path and cache_path.exists():
        payload = _read_cache(cache_path)
        record = payload.get("record")
        status = payload.get("status", {})
        if _cache_payload_is_current(payload) and (status.get("status") == "ok" or _failed_cache_is_fresh(payload)):
            cached_status = "cached" if status.get("status") == "ok" else "cached_failed"
            status = {**status, "status": cached_status, "cache_path": str(cache_path), "n_records": 1 if record else 0}
            return record, status
    record, status = fetch_study_with_status(nct_id, timeout=timeout)
    if cache_path and (status.get("status") == "ok" or _should_cache_failure(status)):
        _write_cache(cache_path, {
            "schema_version": CACHE_SCHEMA_VERSION,
            "record": record,
            "status": status,
            "cached_at": time.time(),
        })
    return record, status


def study_to_record(study: dict[str, Any]) -> dict:
    """Convert a ClinicalTrials.gov v2 study payload into a paper-like dict."""
    protocol = study.get("protocolSection", {}) if isinstance(study, dict) else {}
    ident = protocol.get("identificationModule", {}) or {}
    status = protocol.get("statusModule", {}) or {}
    desc = protocol.get("descriptionModule", {}) or {}
    design = protocol.get("designModule", {}) or {}
    conditions = protocol.get("conditionsModule", {}) or {}
    arms = protocol.get("armsInterventionsModule", {}) or {}
    eligibility = protocol.get("eligibilityModule", {}) or {}
    outcomes = protocol.get("outcomesModule", {}) or {}
    sponsor = protocol.get("sponsorCollaboratorsModule", {}) or {}

    nct_id = str(ident.get("nctId") or "").strip()
    title = str(ident.get("briefTitle") or ident.get("officialTitle") or nct_id).strip()
    if not nct_id and not title:
        return {}

    interventions = [
        item.get("name", "")
        for item in arms.get("interventions", []) or []
        if isinstance(item, dict) and item.get("name")
    ]
    outcome_names = [
        item.get("measure", "")
        for key in ("primaryOutcomes", "secondaryOutcomes")
        for item in outcomes.get(key, []) or []
        if isinstance(item, dict) and item.get("measure")
    ]
    brief_summary = str(desc.get("briefSummary") or "")
    detailed_description = str(desc.get("detailedDescription") or "")
    eligibility_text = str(eligibility.get("eligibilityCriteria") or "")
    abstract = "\n\n".join(
        part for part in [
            brief_summary,
            detailed_description,
            "Conditions: " + "; ".join(conditions.get("conditions", []) or []),
            "Interventions: " + "; ".join(interventions),
            "Outcomes: " + "; ".join(outcome_names),
            "Eligibility: " + eligibility_text,
        ]
        if part and not part.endswith(": ")
    )
    year = _year_from_dates(
        status.get("startDateStruct", {}),
        status.get("primaryCompletionDateStruct", {}),
        status.get("studyFirstSubmitDate"),
    )
    org = ((sponsor.get("leadSponsor") or {}).get("name") or "").strip()
    return {
        "title": title,
        "authors": [org] if org else [],
        "year": year,
        "doi": "",
        "pmid": "",
        "abstract": abstract,
        "journal": "ClinicalTrials.gov",
        "url": f"https://clinicaltrials.gov/study/{nct_id}" if nct_id else "",
        "source": "clinicaltrials",
        "source_type": "clinicaltrials",
        "trial_registration": nct_id,
        "nct_id": nct_id,
        "clinicaltrials_id": nct_id,
        "study_status": status.get("overallStatus") or "",
        "study_design": "; ".join(design.get("studyType", "").splitlines()).strip(),
        "interventions": interventions,
        "conditions": conditions.get("conditions", []) or [],
        "outcomes": outcome_names,
    }


def _year_from_dates(*date_structs) -> int:
    for item in date_structs:
        if isinstance(item, dict):
            value = item.get("date") or item.get("startDate") or ""
        else:
            value = str(item or "")
        match = re.search(r"\b(19|20)\d{2}\b", str(value))
        if match:
            return int(match.group(0))
    return 0


def _cache_path(cache_dir: str | Path | None, kind: str, key: str) -> Path | None:
    if not cache_dir:
        return None
    safe = hashlib.sha1(str(key or "").strip().lower().encode("utf-8")).hexdigest()
    return Path(cache_dir) / f"clinicaltrials_{kind}_{safe}.json"


def _read_cache(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_cache(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def _should_cache_failure(status: dict) -> bool:
    error = str(status.get("error") or "").lower()
    bad_request = "400" in error or "bad request" in error
    return FAILED_CACHE_TTL > 0 and status.get("status") == "failed" and not bad_request


def _cache_payload_is_current(payload: dict) -> bool:
    return int(payload.get("schema_version") or 0) == CACHE_SCHEMA_VERSION


def _failed_cache_is_fresh(payload: dict) -> bool:
    status = payload.get("status", {})
    if status.get("status") != "failed" or FAILED_CACHE_TTL <= 0:
        return False
    cached_at = payload.get("cached_at")
    try:
        return (time.time() - float(cached_at)) <= FAILED_CACHE_TTL
    except (TypeError, ValueError):
        return False
