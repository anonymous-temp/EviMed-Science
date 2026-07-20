"""PDF downloader with PMC Open Access and publisher/direct OA priority."""
from __future__ import annotations

import re
import time
import logging
from pathlib import Path

import requests

from new_meta.config import PDF_DOWNLOAD_MAX_BYTES, SCIHUB_BASE_URL, SCIHUB_ENABLED

logger = logging.getLogger("metaagent.pdf_downloader")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}


def download_pdf(
    doi: str = None,
    pmid: str = None,
    url: str | list[str] | tuple[str, ...] = None,
    save_path: str = None,
    max_retries: int = 3,
) -> bool:
    """Download a PDF using the best available method.

    Priority: known OA/direct URL → PMC OA → Publisher DOI.
    Sci-Hub is disabled by default and only tried when SCIHUB_ENABLED=1 and a
    SCIHUB_BASE_URL is explicitly configured.
    Returns True on success, False on failure.
    """
    if save_path and Path(save_path).exists():
        logger.info(f"PDF already exists: {save_path}")
        return True

    # Try known OA/direct PDF URLs from metadata providers (OpenAlex, Europe PMC, etc.)
    for candidate_url in _candidate_urls(url):
        if _try_url_download(candidate_url, save_path, max_retries):
            return True

    # Try PMC Open Access. This is after provider URLs because NCBI/PMC can be
    # slow in some environments, while Europe PMC often exposes direct PDFs.
    if pmid:
        if _try_pmc_download(pmid, save_path):
            return True

    # Try DOI direct download
    if doi:
        if _try_doi_download(doi, save_path, max_retries):
            return True

    # Try Sci-Hub only when explicitly enabled by deployment config.
    identifier = doi or pmid or url
    if identifier and SCIHUB_ENABLED and SCIHUB_BASE_URL:
        if _try_scihub_download(identifier, save_path, max_retries):
            return True

    logger.warning(f"Failed to download PDF for DOI={doi}, PMID={pmid}")
    return False


def _candidate_urls(url: str | list[str] | tuple[str, ...] | None) -> list[str]:
    """Normalize one or more URL candidates, preserving order and uniqueness."""
    if not url:
        return []
    raw_urls = list(url) if isinstance(url, (list, tuple)) else [url]
    urls: list[str] = []
    for item in raw_urls:
        if not item:
            continue
        item = str(item).strip()
        if not item or item in urls:
            continue
        urls.append(item)
    return urls


def _try_pmc_download(pmid: str, save_path: str) -> bool:
    """Try downloading from PMC Open Access."""
    try:
        # Check if paper is in PMC
        resp = requests.get(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi",
            params={"dbfrom": "pubmed", "db": "pmc", "id": pmid, "retmode": "xml"},
            timeout=15,
        )
        if "LinkSetDb" in resp.text:
            import xml.etree.ElementTree as ET
            root = ET.fromstring(resp.text)
            pmc_id = root.findtext(".//LinkSetDb/Link/Id")
            if pmc_id:
                # Try the direct OA PDF URL first (more reliable)
                oa_url = f"https://pmc.ncbi.nlm.nih.gov/articles/PMC{pmc_id}/pdf/"
                if _save_pdf(oa_url, save_path):
                    return True
                # Fallback: try the FTP-style OA service
                try:
                    oa_resp = requests.get(
                        "https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi",
                        params={"id": f"PMC{pmc_id}"},
                        timeout=15,
                    )
                    pdf_match = re.search(r'href="(https?://[^"]+\.pdf)"', oa_resp.text)
                    if pdf_match:
                        return _save_pdf(pdf_match.group(1), save_path)
                except Exception:
                    pass
    except Exception as e:
        logger.debug(f"PMC download failed for PMID {pmid}: {e}")
    return False


def _try_doi_download(doi: str, save_path: str, max_retries: int) -> bool:
    """Try downloading from DOI-resolved publisher URL."""
    for attempt in range(max_retries):
        try:
            resp = requests.get(
                f"https://doi.org/{doi}",
                headers=HEADERS,
                timeout=20,
                allow_redirects=True,
            )
            if resp.status_code == 200 and resp.headers.get("Content-Type", "").startswith("application/pdf"):
                return _write_pdf(resp.content, save_path)
        except Exception as e:
            logger.debug(f"DOI download attempt {attempt + 1} failed for {doi}: {e}")
            time.sleep(1)
    return False


def _try_scihub_download(identifier: str, save_path: str, max_retries: int) -> bool:
    """Try downloading from Sci-Hub."""
    for attempt in range(max_retries):
        try:
            resp = requests.get(
                f"{SCIHUB_BASE_URL}/{identifier}",
                headers=HEADERS,
                timeout=30,
            )
            if resp.status_code != 200:
                continue

            # Extract PDF URL from page
            pdf_url = None
            # Try iframe src
            match = re.search(r'<iframe[^>]+src="([^"]+\.pdf[^"]*)"', resp.text)
            if match:
                pdf_url = match.group(1)
            else:
                # Try embed src
                match = re.search(r'<embed[^>]+src="([^"]+\.pdf[^"]*)"', resp.text)
                if match:
                    pdf_url = match.group(1)
            if not pdf_url:
                # Try button onclick
                match = re.search(r"location\.href\s*=\s*'([^']+\.pdf[^']*)'", resp.text)
                if match:
                    pdf_url = match.group(1)

            if pdf_url:
                if pdf_url.startswith("//"):
                    pdf_url = "https:" + pdf_url
                return _save_pdf(pdf_url, save_path)

        except Exception as e:
            logger.debug(f"Sci-Hub attempt {attempt + 1} failed for {identifier}: {e}")
            time.sleep(2)
    return False


def _try_url_download(url: str, save_path: str, max_retries: int) -> bool:
    """Try downloading from a direct URL."""
    for attempt in range(max_retries):
        try:
            return _save_pdf(url, save_path)
        except Exception as e:
            logger.debug(f"URL download attempt {attempt + 1} failed for {url}: {e}")
            time.sleep(1)
    return False


def _save_pdf(url: str, save_path: str) -> bool:
    """Download from URL and save to path."""
    resp = requests.get(url, headers=HEADERS, timeout=60, stream=True)
    content_length = resp.headers.get("Content-Length")
    if content_length and int(content_length) > PDF_DOWNLOAD_MAX_BYTES:
        logger.warning("PDF download exceeded size limit before body read: %s", url)
        return False
    if resp.status_code == 200:
        chunks: list[bytes] = []
        total = 0
        for chunk in resp.iter_content(chunk_size=65536):
            if not chunk:
                continue
            total += len(chunk)
            if total > PDF_DOWNLOAD_MAX_BYTES:
                logger.warning("PDF download exceeded size limit: %s", url)
                return False
            chunks.append(chunk)
        content = b"".join(chunks)
        if len(content) <= 1000:
            return False
        # Validate content is actually a PDF (magic bytes: %PDF)
        if not content[:5].startswith(b"%PDF"):
            logger.debug(f"Not a valid PDF (got HTML or other content): {url}")
            return False
        return _write_pdf(content, save_path)
    return False


def _write_pdf(content: bytes, save_path: str) -> bool:
    """Write PDF bytes to disk."""
    Path(save_path).parent.mkdir(parents=True, exist_ok=True)
    with open(save_path, "wb") as f:
        f.write(content)
    logger.info(f"PDF saved: {save_path}")
    return True
