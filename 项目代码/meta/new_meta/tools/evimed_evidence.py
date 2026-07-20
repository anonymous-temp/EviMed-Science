"""Evimed evidence-search normalization for manuscript background citations."""
from __future__ import annotations

import json
import logging
import re
import subprocess
from typing import Any

import requests

from new_meta.config import EVIMED_API_KEY, EVIMED_EVIDENCE_MAX_REFERENCES, EVIMED_EVIDENCE_URL

logger = logging.getLogger("metaagent.evimed_evidence")

REQUEST_TIMEOUT = 30


def search_evimed_evidence(
    query: str,
    *,
    api_key: str | None = None,
    url: str | None = None,
    max_references: int | None = None,
) -> dict:
    """Search Evimed evidence API and return normalized background references.

    The API key is intentionally read from environment/config, never hard-coded.
    Missing credentials disable this optional enrichment without breaking a run.
    """
    query = " ".join(str(query or "").split())
    key = (api_key if api_key is not None else EVIMED_API_KEY).strip()
    endpoint = (url or EVIMED_EVIDENCE_URL).strip()
    if not query:
        return {"status": "skipped", "query": query, "references": [], "message": "empty_query"}
    if not key:
        return {"status": "disabled", "query": query, "references": [], "message": "missing_evimed_api_key"}

    payload_result = _post_evimed_json(endpoint, key, {"query": query})
    if payload_result.get("status") != "ok":
        return {
            "status": "error",
            "query": query,
            "references": [],
            "message": payload_result.get("message", "request_failed"),
        }
    payload = payload_result.get("payload")

    return normalize_evidence_response(
        query,
        payload,
        max_references=max_references or EVIMED_EVIDENCE_MAX_REFERENCES,
    )


def _post_evimed_json(endpoint: str, api_key: str, payload: dict) -> dict:
    try:
        response = requests.post(
            endpoint,
            json=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            timeout=REQUEST_TIMEOUT,
        )
        if response.status_code != 200:
            return {"status": "error", "message": f"http_{response.status_code}"}
        return {"status": "ok", "payload": response.json()}
    except requests.Timeout:
        return {"status": "error", "message": "timeout"}
    except requests.RequestException as exc:
        logger.warning("Evimed evidence search via requests failed; trying curl fallback: %s", exc)
        return _post_evimed_json_with_curl(endpoint, api_key, payload)
    except ValueError as exc:
        return {"status": "error", "message": f"invalid_json: {exc}"}


def _post_evimed_json_with_curl(endpoint: str, api_key: str, payload: dict) -> dict:
    """Use curl when local Python TLS cannot negotiate with the Evimed gateway."""
    curl_config = "\n".join([
        f'url = "{_curl_escape(endpoint)}"',
        'request = "POST"',
        'http1.1',
        'silent',
        'show-error',
        f'max-time = "{REQUEST_TIMEOUT}"',
        'header = "Content-Type: application/json"',
        f'header = "Authorization: Bearer {_curl_escape(api_key)}"',
        f'data = "{_curl_escape(json.dumps(payload, ensure_ascii=False))}"',
        "",
    ])
    try:
        completed = subprocess.run(
            ["curl", "--http1.1", "-sS", "-K", "-"],
            input=curl_config,
            capture_output=True,
            text=True,
            timeout=REQUEST_TIMEOUT + 5,
        )
    except Exception as exc:
        return {"status": "error", "message": str(exc)}
    if completed.returncode != 0:
        return {"status": "error", "message": completed.stderr.strip() or f"curl_exit_{completed.returncode}"}
    try:
        return {"status": "ok", "payload": json.loads(completed.stdout)}
    except ValueError as exc:
        return {"status": "error", "message": f"curl_invalid_json: {exc}"}


def _curl_escape(value: str) -> str:
    return str(value or "").replace("\\", "\\\\").replace('"', '\\"')


def normalize_evidence_response(query: str, payload: Any, *, max_references: int = 12) -> dict:
    """Normalize Evimed evidence API response into ReferenceManager-ready rows."""
    data = _response_data(payload)
    if not isinstance(data, dict):
        return {"status": "error", "query": query, "references": [], "message": "unexpected_response_shape"}

    deduped = _balanced_dedupe_reference_groups(
        [
            _normalize_guides(data.get("guide") or []),
            _normalize_papers(data.get("paper") or []),
            _normalize_trials(data.get("clinicalTrials") or []),
        ],
        max_references=max_references,
    )

    return {
        "status": "ok",
        "query": query,
        "references": deduped,
        "counts": {
            "paper": len(data.get("paper") or []),
            "guide": len(data.get("guide") or []),
            "clinicalTrials": len(data.get("clinicalTrials") or []),
            "instructions": len(data.get("instructions") or []),
            "normalized": len(deduped),
        },
    }


def _balanced_dedupe_reference_groups(
    groups: list[list[dict]],
    *,
    max_references: int,
) -> list[dict]:
    limit = max(0, int(max_references))
    if limit <= 0:
        return []
    deduped: list[dict] = []
    seen: set[str] = set()
    max_group_len = max((len(group) for group in groups), default=0)
    for index in range(max_group_len):
        for group in groups:
            if index >= len(group):
                continue
            item = group[index]
            key = _dedupe_key(item)
            if not key or key in seen:
                continue
            seen.add(key)
            deduped.append(item)
            if len(deduped) >= limit:
                return deduped
    return deduped


def _response_data(payload: Any) -> Any:
    if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
        return payload.get("data")
    return payload


def _normalize_papers(items: list[dict]) -> list[dict]:
    refs = []
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        title = _clean(item.get("title") or item.get("literatureTitle") or "")
        if not title:
            continue
        url_map = _parse_url_map(item.get("url"))
        pmid = _extract_pmid(url_map) or _extract_pmid(item.get("literatureTitle") or "")
        doi = _extract_doi(item.get("doi") or item.get("literatureTitle") or item.get("summary") or "")
        evimed_id = str(item.get("id") or item.get("paperId") or pmid or doi or idx).strip()
        refs.append({
            "study_id": f"evimed:paper:{evimed_id}",
            "source_type": "paper",
            "title": title,
            "summary": _clean(item.get("summary") or item.get("answer") or ""),
            "question": _clean(item.get("question") or ""),
            "paper": {
                "title": title,
                "authors": _authors(item),
                "journal": _clean(item.get("journal") or ""),
                "year": _year(item.get("year") or ""),
                "doi": doi,
                "pmid": pmid,
                "url": _best_url(url_map) or _clean(item.get("url") or ""),
                "pub_types": [_clean(item.get("type") or "")] if item.get("type") else [],
                "source": "evimed_evidence",
            },
        })
    return refs


def _normalize_guides(items: list[dict]) -> list[dict]:
    refs = []
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        title = _clean(item.get("title") or "")
        if not title:
            continue
        guide_id = str(item.get("guideId") or item.get("id") or idx).strip()
        refs.append({
            "study_id": f"evimed:guide:{guide_id}",
            "source_type": "guide",
            "title": title,
            "summary": _clean(item.get("introduction") or item.get("text") or ""),
            "paper": {
                "title": title,
                "authors": [_clean(item.get("formulator") or "Guideline panel")],
                "journal": "Guideline",
                "year": _year(item.get("year") or ""),
                "url": _clean(item.get("url") or ""),
                "source": "evimed_evidence",
            },
        })
    return refs


def _normalize_trials(items: list[dict]) -> list[dict]:
    refs = []
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        title = _clean(item.get("title") or "")
        if not title:
            continue
        registry = _clean(item.get("belong") or "Clinical trial registry")
        reg_no = _clean(item.get("registerNo") or item.get("id") or f"trial-{idx}")
        refs.append({
            "study_id": f"evimed:trial:{reg_no}",
            "source_type": "clinical_trial",
            "title": title,
            "summary": _clean(item.get("outcome") or item.get("instruction") or ""),
            "paper": {
                "title": f"{title}. Identifier {reg_no}",
                "authors": [registry],
                "journal": registry,
                "year": _year(str(item.get("registerDate") or "")[:4]),
                "url": _clean(item.get("url") or ""),
                "registry_id": reg_no,
                "source": "evimed_evidence",
            },
        })
    return refs


def _normalize_instructions(items: list[dict]) -> list[dict]:
    refs = []
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        generic = _clean(item.get("genericNames") or item.get("tradeNames") or "")
        if not generic:
            continue
        ref_id = str(item.get("id") or idx).strip()
        refs.append({
            "study_id": f"evimed:instruction:{ref_id}",
            "source_type": "drug_label",
            "title": f"{generic} prescribing information",
            "summary": _clean(item.get("indication") or ""),
            "paper": {
                "title": f"{generic} prescribing information",
                "authors": [_clean(item.get("enterpriseName") or "Regulatory drug label")],
                "journal": "Prescribing information",
                "year": _year(str(item.get("revisionDate") or item.get("approvalDates") or "")[:4]),
                "url": _clean(item.get("url") or item.get("pdfUrl") or ""),
                "source": "evimed_evidence",
            },
        })
    return refs


def _authors(item: dict) -> list[str]:
    raw = item.get("author") or item.get("authors") or item.get("authorList") or []
    if isinstance(raw, list):
        authors = [_clean(author) for author in raw if _clean(author)]
        if authors:
            return authors
    if isinstance(raw, str):
        split = re.split(r";|\band\b|,", raw)
        authors = [_clean(author) for author in split if _clean(author)]
        if authors:
            return authors
    literature = _clean(item.get("literatureTitle") or "")
    if literature:
        prefix = literature.split(".", 1)[0]
        authors = [_clean(author) for author in prefix.split(",") if _clean(author)]
        if authors:
            return authors[:6]
    return ["Unknown"]


def _parse_url_map(raw: Any) -> dict[str, str]:
    if isinstance(raw, dict):
        return {str(k): str(v) for k, v in raw.items() if v}
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError:
        return {"url": raw}
    if isinstance(loaded, dict):
        return {str(k): str(v) for k, v in loaded.items() if v}
    return {"url": raw}


def _best_url(url_map: dict[str, str]) -> str:
    for key in ("Pubmed", "pubmed", "evimed", "Semantic Scholar", "Google Scholar", "url"):
        if url_map.get(key):
            return url_map[key]
    return next(iter(url_map.values()), "")


def _extract_pmid(value: Any) -> str:
    text = " ".join(str(value or "").split())
    match = re.search(r"(?:pubmed\.ncbi\.nlm\.nih\.gov/|PMID:?\s*)(\d{6,9})", text, flags=re.I)
    return match.group(1) if match else ""


def _extract_doi(value: Any) -> str:
    text = " ".join(str(value or "").split())
    match = re.search(r"\b10\.\d{4,9}/[^\s,;)}\]]+", text, flags=re.I)
    if not match:
        return ""
    return match.group(0).rstrip(".")


def _year(value: Any) -> int | str:
    text = str(value or "").strip()
    match = re.search(r"\b(19|20)\d{2}\b", text)
    if not match:
        return text
    return int(match.group(0))


def _clean(value: Any) -> str:
    return " ".join(str(value or "").replace("\n", " ").split()).strip()


def _dedupe_key(item: dict) -> str:
    paper = item.get("paper") or {}
    doi = str(paper.get("doi") or "").strip().lower()
    if doi:
        return f"doi:{doi}"
    pmid = str(paper.get("pmid") or "").strip().lower()
    if pmid:
        return f"pmid:{pmid}"
    url = str(paper.get("url") or "").strip().lower().rstrip("/")
    if url:
        return f"url:{url}"
    title = " ".join(str(paper.get("title") or item.get("title") or "").lower().split())
    year = str(paper.get("year") or "")
    return f"title:{title}|year:{year}" if title else ""
