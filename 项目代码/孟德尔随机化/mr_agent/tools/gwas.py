# [IN] None (external API + local CSV)
# [OUT] GWASEntry list
# [POS] mr_agent/tools/gwas.py - OpenGWAS data retrieval
"""OpenGWAS API and data retrieval."""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from pathlib import Path

import pandas as pd
import requests

from mr_agent.models import GWASEntry
from mr_agent.utils import safe_int

logger = logging.getLogger(__name__)

OPENGWAS_API = "https://api.opengwas.io/api"
OPENGWAS_TIMEOUT = 10
_OPENGWAS_RETRIES = 3
_OPENGWAS_RETRY_DELAY = 3

# 全量 GWAS 数据库内存缓存（首次拉取后所有搜索直接过滤）
_gwas_db_cache: dict | None = None
_gwas_db_lock = threading.Lock()

# Valid GWAS ID pattern: alphanumeric + hyphens + dots
GWAS_ID_PATTERN = re.compile(r'^[a-zA-Z0-9\-\.\_]+$')
_SEARCH_STOP_WORDS = {
    "and", "the", "for", "with", "from", "level", "levels", "trait",
    "disease", "disorder", "adult", "adults", "blood", "serum", "plasma",
}


def _auth_headers() -> dict:
    """Build Authorization header from OPENGWAS_JWT (ContextVar with os.environ fallback)."""
    # 优先从 start 模块的 ContextVar 读取（并发安全，避免多用户 token 互相覆盖）
    # 回退到 os.environ（兼容旧调用路径）
    token = ""
    try:
        import importlib
        _start = importlib.import_module("start")
        token = _start._OPENGWAS_JWT.get("").strip()
    except Exception:
        pass
    if not token:
        token = os.getenv("OPENGWAS_JWT", "").strip()
    if token:
        return {"Authorization": f"Bearer {token}"}
    return {}


def _get_gwas_db() -> dict | None:
    """Fetch and cache the full OpenGWAS database (50k+ entries).

    Thread-safe double-checked locking with retry.
    """
    global _gwas_db_cache
    if _gwas_db_cache is not None:
        return _gwas_db_cache
    with _gwas_db_lock:
        if _gwas_db_cache is not None:
            return _gwas_db_cache
        logger.info("首次拉取 OpenGWAS 全量数据库，约需 15-30 秒...")
        headers = _auth_headers()
        for attempt in range(1, _OPENGWAS_RETRIES + 1):
            try:
                resp = requests.post(
                    f"{OPENGWAS_API}/gwasinfo",
                    json={},
                    headers=headers,
                    timeout=30,
                )
                resp.raise_for_status()
                data = resp.json()
                if isinstance(data, dict) and data:
                    _gwas_db_cache = data
                    logger.info(f"OpenGWAS 数据库已缓存，共 {len(data)} 条记录")
                    return _gwas_db_cache
            except Exception as e:
                logger.warning(
                    f"OpenGWAS 全量拉取失败 ({attempt}/{_OPENGWAS_RETRIES}): {e}"
                )
                if attempt < _OPENGWAS_RETRIES:
                    time.sleep(_OPENGWAS_RETRY_DELAY)
        logger.error("OpenGWAS 全量拉取最终失败，将降级到直接搜索或本地CSV")
    return None

def validate_gwas_id(gwas_id: str) -> bool:
    """Validate GWAS ID format to prevent injection."""
    return bool(GWAS_ID_PATTERN.match(gwas_id))


def sanitize_gwas_id(gwas_id: str) -> str:
    """Sanitize GWAS ID, raising ValueError if invalid."""
    gwas_id = gwas_id.strip()
    if not validate_gwas_id(gwas_id):
        raise ValueError(f"Invalid GWAS ID format: {gwas_id}")
    return gwas_id


def search_gwas_api(keyword: str, max_results: int = 50) -> list[GWASEntry]:
    """Search OpenGWAS via REST API.

    Uses cached full database for instant lookups after first call.
    Falls back to direct API query if cache fetch fails.
    """
    db = _get_gwas_db()
    if db is not None:
        results = _parse_dict_response(db, keyword, max_results)
        logger.debug(f"GWAS缓存搜索 '{keyword}' → {len(results)} 条 (库大小={len(db)})")
        return results
    # 缓存失败时降级：尝试直接 GET 搜索
    logger.warning(f"GWAS缓存未命中，降级到直接API搜索: '{keyword}'")
    entries = _search_by_get(keyword, max_results)
    if entries:
        return entries
    return search_gwas_local(keyword)


def _search_by_get(keyword: str, max_results: int) -> list[GWASEntry]:
    """Search OpenGWAS with GET query parameter (newer API versions)."""
    url = f"{OPENGWAS_API}/gwasinfo/search"
    try:
        resp = requests.get(
            url, params={"query": keyword},
            headers=_auth_headers(), timeout=OPENGWAS_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, list) and data:
            return _parse_api_results(data, max_results)
        return []
    except requests.RequestException as e:
        logger.debug(f"OpenGWAS GET search unavailable: {e}")
        return []


def _parse_dict_response(
    data: dict, keyword: str, max_results: int,
) -> list[GWASEntry]:
    """Parse dict-format API response: {gwas_id: metadata, ...}, filter by keyword.

    Matches meaningful query terms and ranks exact traits before larger, newer studies.
    Generic words such as "disease" cannot match a dataset on their own.
    """
    normalized_query = _normalize_trait(keyword)
    query_words = _meaningful_words(normalized_query)
    ranked = []
    for gwas_id, meta in data.items():
        if not isinstance(meta, dict):
            continue
        normalized_trait = _normalize_trait(meta.get("trait", ""))
        trait_words = set(_meaningful_words(normalized_trait))
        overlap = len(set(query_words) & trait_words)
        coverage = overlap / len(set(query_words)) if query_words else 0.0
        phrase_match = bool(normalized_query and normalized_query in normalized_trait)
        exact_match = normalized_trait == normalized_query
        if not phrase_match and coverage < 0.5:
            continue
        entry = _dict_to_gwas_entry({**meta, "id": gwas_id})
        if not entry:
            continue
        ranked.append((
            int(exact_match),
            int(phrase_match),
            coverage,
            int(entry.sample_size or 0),
            int(entry.year or 0),
            entry,
        ))
    ranked.sort(key=lambda row: row[:-1], reverse=True)
    return [row[-1] for row in ranked[:max_results]]


def _normalize_trait(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").casefold()).strip()


def _meaningful_words(value: str) -> list[str]:
    return [
        word for word in value.split()
        if len(word) >= 3 and word not in _SEARCH_STOP_WORDS
    ]


def _filter_and_parse(
    data: list[dict], keyword: str, max_results: int,
) -> list[GWASEntry]:
    """Filter API results by keyword match (word-level)."""
    if not isinstance(data, list):
        logger.warning(f"Unexpected API response type: {type(data)}, value[:100]={str(data)[:100]}")
        return []
    keyword_lower = keyword.lower()
    kw_words = [w for w in re.split(r'[\s\-_/,()\[\]]+', keyword_lower) if len(w) >= 5]
    matched = []
    for item in data:
        if not isinstance(item, dict):
            continue
        trait = str(item.get("trait", "")).lower()
        if keyword_lower in trait or (kw_words and any(w in trait for w in kw_words)):
            entry = _dict_to_gwas_entry(item)
            if entry:
                matched.append(entry)
            if len(matched) >= max_results:
                break
    return matched


def _parse_api_results(data: list[dict], max_results: int) -> list[GWASEntry]:
    """Parse API response into GWASEntry list."""
    if not isinstance(data, list):
        logger.warning(f"Unexpected API response type: {type(data)}, value[:100]={str(data)[:100]}")
        return []
    entries = []
    for item in data[:max_results]:
        entry = _dict_to_gwas_entry(item)
        if entry:
            entries.append(entry)
    return entries


def _dict_to_gwas_entry(item: dict) -> GWASEntry | None:
    """Convert API dict to GWASEntry."""
    if not isinstance(item, dict):
        return None
    gwas_id = str(item.get("id", ""))
    if not gwas_id or gwas_id == "None":
        return None
    return GWASEntry(
        gwas_id=gwas_id,
        trait=str(item.get("trait", "")),
        year=safe_int(item.get("year")),
        consortium=str(item.get("consortium", "")),
        sample_size=safe_int(item.get("sample_size")),
        nsnp=safe_int(item.get("nsnp")),
        population=str(item.get("population", "")),
    )


def search_gwas_ids(keyword: str, max_pages: int = 5) -> list[GWASEntry]:
    """Search GWAS IDs - tries API first, falls back to local CSV."""
    entries = search_gwas_api(keyword)
    if entries:
        return entries
    return search_gwas_local(keyword)


def search_gwas_local(
    keyword: str,
    csv_path: str | Path | None = None,
) -> list[GWASEntry]:
    """Search GWAS IDs from local CSV file."""
    if csv_path is None:
        candidates = [Path("opengwas.csv"), Path(__file__).parent.parent.parent / "opengwas.csv"]
        csv_path = next((p for p in candidates if p.exists()), None)
    if csv_path is None or not Path(csv_path).exists():
        logger.info("No local GWAS CSV available")
        return []
    df = pd.read_csv(csv_path)
    if "trait" not in df.columns:
        logger.warning(f"Local GWAS CSV missing 'trait' column: {csv_path}")
        return []
    keyword_lower = keyword.lower()
    mask = df["trait"].str.lower().str.contains(keyword_lower, na=False)
    matches = df[mask]
    return [
        GWASEntry(
            gwas_id=str(row.get("id", "")),
            trait=str(row.get("trait", "")),
            year=safe_int(row.get("year")),
            consortium=str(row.get("consortium", "")),
            sample_size=safe_int(row.get("sample_size")),
            nsnp=safe_int(row.get("nsnp")),
            population=str(row.get("population", "")),
        )
        for _, row in matches.iterrows()
        if str(row.get("id", "")).strip() and str(row.get("id", "")).lower() != "nan"
    ]


def format_gwas_for_llm(entries: list[GWASEntry]) -> str:
    """Format GWAS entries for LLM selection."""
    if not entries:
        return "No GWAS datasets found."
    lines = []
    for e in entries:
        parts = [f"ID: {e.gwas_id}", f"Trait: {e.trait}"]
        if e.sample_size:
            parts.append(f"N={e.sample_size:,}")
        if e.year:
            parts.append(f"Year={e.year}")
        if e.population:
            parts.append(f"Pop={e.population}")
        lines.append(" | ".join(parts))
    return "\n".join(lines)
