# [IN] query string, date range, max_results, Config
# [OUT] list of PMIDs, list of raw XML records
# [POS] src/bibliometric/pubmed/connector.py - PubMed E-utilities API

from __future__ import annotations

import threading
import time
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

import requests

from bibliometric.config import Config

logger = logging.getLogger(__name__)

BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
_EFETCH_TIMEOUT = 120  # EFetch 单批次可能返回大量 XML，需要更长超时


class PubMedConnector:
    """Wrapper for NCBI E-utilities ESearch + EFetch."""

    def __init__(self, config: Config):
        self.config = config
        self.session = requests.Session()
        self._last_request_time = 0.0
        self._throttle_lock = threading.Lock()  # 多线程并发时保护速率限制

    def _throttle(self):
        """Enforce rate limit between requests (thread-safe)."""
        with self._throttle_lock:
            elapsed = time.time() - self._last_request_time
            min_interval = 1.0 / self.config.rate_limit
            if elapsed < min_interval:
                time.sleep(min_interval - elapsed)
            self._last_request_time = time.time()

    def _base_params(self) -> dict:
        """Common API parameters."""
        params = {"db": "pubmed", "retmode": "xml"}
        if self.config.ncbi_api_key:
            params["api_key"] = self.config.ncbi_api_key
        if self.config.ncbi_email:
            params["email"] = self.config.ncbi_email
        return params

    def _request_with_retry(self, url: str, params: dict) -> requests.Response:
        """Make HTTP GET request with retry logic."""
        for attempt in range(self.config.max_retries):
            self._throttle()
            try:
                resp = self.session.get(url, params=params, timeout=30)
                resp.raise_for_status()
                return resp
            except requests.RequestException as e:
                logger.warning(
                    "Request failed (attempt %d/%d): %s",
                    attempt + 1,
                    self.config.max_retries,
                    e,
                )
                if attempt < self.config.max_retries - 1:
                    time.sleep(self.config.retry_delay * (attempt + 1))
                else:
                    raise

    def _request_with_retry_post(self, url: str, params: dict, data: dict) -> requests.Response:
        """Make HTTP POST request with retry logic (avoids URL length limits)."""
        for attempt in range(self.config.max_retries):
            self._throttle()
            try:
                resp = self.session.post(url, params=params, data=data, timeout=30)
                resp.raise_for_status()
                return resp
            except requests.RequestException as e:
                logger.warning(
                    "Request failed (attempt %d/%d): %s",
                    attempt + 1,
                    self.config.max_retries,
                    e,
                )
                if attempt < self.config.max_retries - 1:
                    time.sleep(self.config.retry_delay * (attempt + 1))
                else:
                    raise

    def search(
        self,
        query: str,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        max_results: int = 10000,
    ) -> list[str]:
        """Search PubMed and return list of PMIDs."""
        params = {
            **self._base_params(),
            "term": query,
            "retmax": 0,
            "usehistory": "y",
        }
        if date_from:
            params["mindate"] = date_from
            params["datetype"] = "pdat"
        if date_to:
            params["maxdate"] = date_to
            params["datetype"] = "pdat"

        resp = self._request_with_retry(f"{BASE_URL}/esearch.fcgi", params)
        webenv, query_key, total = self._parse_search_response(resp.text)
        if not webenv:
            logger.warning("Empty WebEnv; falling back to direct ID fetch")
            return self._direct_id_search(params, min(total, max_results))
        total = min(total, max_results)
        logger.info("Found %d records (fetching up to %d)", total, max_results)

        pmids = self._fetch_all_pmids(webenv, query_key, total)
        return pmids

    def _direct_id_search(self, base_params: dict, total: int) -> list[str]:
        """Fallback: fetch PMIDs directly without history server."""
        pmids = []
        batch = 10000
        for start in range(0, total, batch):
            params = {
                **base_params,
                "retstart": start,
                "retmax": min(batch, total - start),
                "rettype": "uilist",
                "usehistory": "n",
            }
            resp = self._request_with_retry(f"{BASE_URL}/esearch.fcgi", params)
            from lxml import etree
            root = etree.fromstring(resp.content)
            page_ids = [el.text for el in root.findall(".//Id") if el.text]
            pmids.extend(page_ids)
        return pmids[:total]

    def _parse_search_response(self, xml_text: str) -> tuple[str, str, int]:
        """Extract WebEnv, QueryKey, Count from ESearch XML."""
        from lxml import etree

        root = etree.fromstring(xml_text.encode())
        count = int(root.findtext("Count", "0"))
        webenv = root.findtext("WebEnv", "")
        query_key = root.findtext("QueryKey", "1")
        return webenv, query_key, count

    def _fetch_all_pmids(
        self, webenv: str, query_key: str, total: int
    ) -> list[str]:
        """Paginate through ESearch results to collect all PMIDs."""
        pmids = []
        batch = 10000
        for start in range(0, total, batch):
            params = {
                **self._base_params(),
                "WebEnv": webenv,
                "query_key": query_key,
                "retstart": start,
                "retmax": min(batch, total - start),
                "rettype": "uilist",
            }
            resp = self._request_with_retry(f"{BASE_URL}/esearch.fcgi", params)
            from lxml import etree

            root = etree.fromstring(resp.content)
            page_ids = [el.text for el in root.findall(".//Id") if el.text]
            pmids.extend(page_ids)
            logger.info("Fetched PMIDs: %d / %d", len(pmids), total)
        return pmids[:total]

    def _fetch_batch(self, idx: int, chunk: list[str], total: int) -> tuple[int, str]:
        """Fetch a single batch of PMIDs via EFetch POST. Uses an independent
        session per call to avoid thread-safety issues with the shared session."""
        params = {**self._base_params(), "rettype": "xml"}
        data = {"id": ",".join(chunk)}
        batch_size = self.config.batch_size

        session = requests.Session()
        for attempt in range(self.config.max_retries):
            self._throttle()
            try:
                resp = session.post(
                    f"{BASE_URL}/efetch.fcgi",
                    params=params,
                    data=data,
                    timeout=_EFETCH_TIMEOUT,
                )
                resp.raise_for_status()
                fetched = min((idx + 1) * batch_size, total)
                logger.info("Fetched details: %d / %d", fetched, total)
                return idx, resp.text
            except requests.RequestException as e:
                logger.warning(
                    "Request failed (attempt %d/%d): %s",
                    attempt + 1,
                    self.config.max_retries,
                    e,
                )
                if attempt < self.config.max_retries - 1:
                    time.sleep(self.config.retry_delay * (attempt + 1))
                else:
                    raise

    def fetch_details(self, pmids: list[str]) -> list[str]:
        """Fetch detailed records for given PMIDs concurrently.

        Splits PMIDs into batches and fetches them in parallel (up to 3 workers)
        to reduce total wall-clock time. Results are returned in original order.
        Uses POST to avoid 414 Request-URI Too Long when batch_size is large.
        """
        if not pmids:
            return []

        batch_size = self.config.batch_size
        batches = [pmids[i:i + batch_size] for i in range(0, len(pmids), batch_size)]
        total = len(pmids)
        results: list[Optional[str]] = [None] * len(batches)

        # 最多 3 个并发批次：NCBI 单次 EFetch 耗时约 2 分钟，
        # 3 路并发可将 2000 篇的拉取时间从 ~8 分钟压缩到 ~3 分钟
        max_workers = min(3, len(batches))
        logger.info(
            "Fetching %d records in %d batches (%d workers)",
            total, len(batches), max_workers,
        )

        with ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="efetch"
        ) as pool:
            futures = {
                pool.submit(self._fetch_batch, i, chunk, total): i
                for i, chunk in enumerate(batches)
            }
            for future in as_completed(futures):
                idx, text = future.result()
                results[idx] = text

        return [r for r in results if r is not None]
