"""Internal database (evimed) retrieval — used before PubMed fallback."""
from __future__ import annotations

import logging
from typing import Optional

import requests

from new_meta.config import INTERNAL_DB_URL

logger = logging.getLogger("metaagent.internal_db")

REQUEST_TIMEOUT = 30
MAX_RETRIES = 2
RETRY_BACKOFF = 5  # seconds between retries


def _map_record(item: dict, idx: int) -> Optional[dict]:
    """Map a single internal DB record to Meta's paper dict format.

    Target fields: pmid, title, abstract, authors, year, journal, doi, pub_types
    """
    try:
        pmid = str(item.get("pmid") or item.get("id") or item.get("paperId") or f"internal_{idx}")
        title = item.get("title") or item.get("paperTitle") or "Unknown Title"
        abstract = item.get("abstract") or item.get("paperAbstract") or ""
        if abstract:
            abstract = abstract[:2000]

        authors_raw = item.get("authors") or item.get("authorList") or []
        if isinstance(authors_raw, str):
            authors = [a.strip() for a in authors_raw.split(";") if a.strip()]
        else:
            authors = [str(a) for a in authors_raw]

        journal = item.get("journal") or item.get("journalName") or ""

        year_raw = (
            item.get("publication_year")
            or item.get("year")
            or item.get("publicationYear")
            or item.get("publishYear")
            or "0"
        )
        try:
            year = int(year_raw)
        except (ValueError, TypeError):
            year = 0

        doi = item.get("doi") or ""

        pub_types_raw = item.get("pubTypes") or item.get("publicationTypes") or []
        if isinstance(pub_types_raw, str):
            pub_types = [p.strip() for p in pub_types_raw.split(";") if p.strip()]
        elif isinstance(pub_types_raw, list):
            pub_types = [str(p) for p in pub_types_raw]
        else:
            pub_types = []

        return {
            "pmid": pmid,
            "title": title,
            "abstract": abstract,
            "authors": authors,
            "year": year,
            "journal": journal,
            "doi": doi,
            "pub_types": pub_types,
        }
    except Exception as e:
        logger.warning(f"内部数据库记录映射失败(idx={idx}): {e}")
        return None


def search_internal_db(query: str) -> list[dict]:
    """Search the internal evimed database.

    Args:
        query: Search query (the API handles PICO splitting internally).

    Returns:
        List of paper dicts in Meta format. Returns [] on error or no results.
    """
    import time

    last_err = None
    for attempt in range(1 + MAX_RETRIES):
        try:
            timeout = REQUEST_TIMEOUT * (attempt + 1)  # 30, 60, 90
            resp = requests.post(
                INTERNAL_DB_URL,
                json={"query": query},
                headers={"Content-Type": "application/json"},
                timeout=timeout,
            )
            if resp.status_code != 200:
                logger.warning(f"内部数据库接口返回非200状态: {resp.status_code}")
                last_err = f"HTTP {resp.status_code}"
                if attempt < MAX_RETRIES:
                    time.sleep(RETRY_BACKOFF)
                continue

            data = resp.json()

            # Handle various response structures
            if isinstance(data, list):
                items = data
            elif isinstance(data, dict):
                items = (
                    data.get("data")
                    or data.get("records")
                    or data.get("papers")
                    or data.get("result")
                    or []
                )
            else:
                logger.warning(f"内部数据库接口返回未知格式: {type(data)}")
                return []

            logger.info(f"内部数据库原始返回条数: {len(items)}")
            papers = []
            for idx, item in enumerate(items):
                paper = _map_record(item, idx)
                if paper:
                    papers.append(paper)

            logger.info(f"内部数据库检索成功，有效文献: {len(papers)}/{len(items)} 篇")
            return papers

        except requests.Timeout:
            last_err = f"超时(>{timeout}s)"
            logger.warning(f"内部数据库接口{last_err}，第{attempt + 1}次尝试")
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF)
        except requests.RequestException as e:
            last_err = str(e)
            logger.warning(f"内部数据库接口网络错误: {e}，第{attempt + 1}次尝试")
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF)
        except Exception as e:
            logger.warning(f"内部数据库检索异常: {e}")
            return []

    logger.warning(f"内部数据库检索失败，已重试{MAX_RETRIES}次: {last_err}")
    return []
