"""PDF download primitives: one bounded fetch, a publisher landing-page hop,
a per-run memo of hosts that answered with a bot wall, and a per-paper budget.

The retrieval order across sources lives in ``fulltext_retrieval``; this
module only knows how to turn one URL into PDF bytes on disk, or say why not.
"""
from __future__ import annotations

import re
import threading
import time
import logging
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests

from new_meta.config import (
    FULLTEXT_MAX_ATTEMPTS_PER_PAPER,
    FULLTEXT_PAPER_DEADLINE_SECONDS,
    PDF_DOWNLOAD_MAX_BYTES,
    SCIHUB_BASE_URL,
    SCIHUB_ENABLED,
)

logger = logging.getLogger("metaagent.pdf_downloader")

# An honest client name, not a spoofed browser: on 2026-09-28 Springer Nature
# (link.springer.com, BMC) answered a Chrome User-Agent that runs no JavaScript
# with a 200 "Client Challenge" page for both the article and its PDF, and this
# one with the article (citation_pdf_url) and the PDF; BMJ, PLOS answered both
# alike, and the Cloudflare-walled hosts refused both alike.
HEADERS = {
    "User-Agent": "MetaAgent/1.0 (mailto:metaagent@research.ai)",
    "Accept": "application/pdf,text/html;q=0.9,*/*;q=0.8",
}

PDF_FETCH_TIMEOUT = 30.0
DOI_HANDLE_API = "https://doi.org/api/handles/{doi}"
# A landing page's <head> carries citation_pdf_url; more than this is never read.
LANDING_PAGE_MAX_BYTES = 2 * 1024 * 1024
# Resolvers and metadata APIs sit in front of many publishers: a 403 behind a
# redirect from them says nothing about them.
_NEVER_BLOCK_HOSTS = frozenset({"doi.org", "dx.doi.org", "www.doi.org", "hdl.handle.net"})
_BOT_WALL_MARKERS = (
    b"just a moment",
    b"challenge-platform",
    b"cf-chl",
    b"attention required",
    b"access denied",
    b"captcha",
)
# A wall can also answer 200: only the page title is trusted there, since an
# ordinary article page may load a captcha script or quote "access denied".
_CHALLENGE_TITLES = (
    "client challenge",
    "just a moment...",
    "attention required! | cloudflare",
    "access denied",
    "are you a robot?",
)
_TITLE_RE = re.compile(r"<title[^>]*>\s*([^<]{0,120}?)\s*</title>", re.IGNORECASE)


def _http_get(url: str, **kwargs):
    """Single seam for network access so tests can substitute it."""
    return requests.get(url, **kwargs)


def _host(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except Exception:
        return ""


# =============================================================================
# Per-run host memo and per-paper budget
# =============================================================================

class HostMemo:
    """Hosts that refused this run, so later papers do not pay for them again.

    A 403 carrying a bot-wall signature (Cloudflare challenge, Akamai "Access
    Denied") blocks the host at once: from a given egress it answers the same
    way for every article. Any other 403 may be article-specific (a paywalled
    PDF next to open ones on the same host), so the host is blocked only after
    ``soft_limit`` such answers and never once it has served a PDF this run.
    """

    def __init__(self, soft_limit: int = 2) -> None:
        self._lock = threading.Lock()
        self._blocked: dict[str, str] = {}
        self._soft: dict[str, int] = {}
        self._served: set[str] = set()
        self.soft_limit = max(1, soft_limit)

    def blocked_reason(self, url: str) -> str:
        host = _host(url)
        with self._lock:
            return self._blocked.get(host, "")

    def note_refusal(self, url: str, *, status: int, headers=None, body_head: bytes = b"",
                     also: str = "") -> None:
        if status != 403:
            return
        wall = _looks_like_bot_wall(headers or {}, body_head)
        hosts = [h for h in {_host(url), _host(also) if also else ""} if h and h not in _NEVER_BLOCK_HOSTS]
        with self._lock:
            for host in hosts:
                if host in self._blocked:
                    continue
                if wall:
                    self._blocked[host] = "bot_wall_403"
                    logger.info("Full-text host blocked for this run (bot wall 403): %s", host)
                    continue
                if host in self._served:
                    continue
                self._soft[host] = self._soft.get(host, 0) + 1
                if self._soft[host] >= self.soft_limit:
                    self._blocked[host] = "repeated_403"
                    logger.info("Full-text host blocked for this run (repeated 403): %s", host)

    def note_challenge(self, url: str, *, also: str = "") -> None:
        """A 200 page that is a bot challenge, not the article: block the host."""
        hosts = [h for h in {_host(url), _host(also) if also else ""} if h and h not in _NEVER_BLOCK_HOSTS]
        with self._lock:
            for host in hosts:
                if host not in self._blocked and host not in self._served:
                    self._blocked[host] = "challenge_page"
                    logger.info("Full-text host blocked for this run (challenge page): %s", host)

    def note_served(self, url: str) -> None:
        host = _host(url)
        if host:
            with self._lock:
                self._served.add(host)

    def snapshot(self) -> dict[str, str]:
        with self._lock:
            return dict(sorted(self._blocked.items()))


def is_challenge_page(html: str) -> bool:
    match = _TITLE_RE.search((html or "")[:65536])
    return bool(match) and match.group(1).strip().lower() in _CHALLENGE_TITLES


def _looks_like_bot_wall(headers, body_head: bytes) -> bool:
    try:
        lowered = {str(k).lower(): str(v).lower() for k, v in dict(headers).items()}
    except Exception:
        lowered = {}
    if "cf-mitigated" in lowered:
        return True
    server = lowered.get("server", "")
    if any(name in server for name in ("cloudflare", "akamaighost", "ddos-guard")):
        return True
    head = (body_head or b"")[:8192].lower()
    return any(marker in head for marker in _BOT_WALL_MARKERS)


class PaperBudget:
    """Attempt and wall-clock bounds for one paper, plus its attempt log."""

    def __init__(
        self,
        max_attempts: int = FULLTEXT_MAX_ATTEMPTS_PER_PAPER,
        deadline_seconds: float = FULLTEXT_PAPER_DEADLINE_SECONDS,
        clock=time.monotonic,
    ) -> None:
        self.max_attempts = max(1, int(max_attempts))
        self.deadline_seconds = float(deadline_seconds)
        self._clock = clock
        self._start = clock()
        self.used = 0
        self.attempts: list[dict] = []

    def remaining(self) -> float:
        return self.deadline_seconds - (self._clock() - self._start)

    def exhausted(self) -> str:
        if self.used >= self.max_attempts:
            return "attempt_cap"
        if self.remaining() <= 0:
            return "deadline"
        return ""

    def timeout(self, default: float) -> float:
        return max(1.0, min(float(default), self.remaining()))

    def spend(self) -> None:
        self.used += 1

    def record(self, route: str, url: str, outcome: str) -> None:
        self.attempts.append({"route": route, "host": _host(url), "url": url, "outcome": outcome})


# =============================================================================
# One URL -> PDF on disk (with a single landing-page hop)
# =============================================================================

def fetch_pdf_url(
    url: str,
    save_path: str,
    *,
    route: str,
    memo: HostMemo | None = None,
    budget: PaperBudget | None = None,
    follow_landing: bool = True,
    timeout: float = PDF_FETCH_TIMEOUT,
) -> str:
    """Fetch ``url``; save it when it is a PDF, or follow its landing page's
    ``citation_pdf_url`` once. Returns the route that produced the PDF, or "".
    """
    url = str(url or "").strip()
    if not url.lower().startswith(("http://", "https://")):
        return ""
    memo = memo if memo is not None else HostMemo()
    budget = budget if budget is not None else PaperBudget()

    blocked = memo.blocked_reason(url)
    if blocked:
        budget.record(route, url, f"skipped_{blocked}")
        return ""
    spent = budget.exhausted()
    if spent:
        budget.record(route, url, f"skipped_{spent}")
        return ""
    budget.spend()

    try:
        resp = _http_get(
            url,
            headers=HEADERS,
            timeout=budget.timeout(timeout),
            stream=True,
            allow_redirects=True,
        )
    except Exception as exc:
        budget.record(route, url, f"error_{type(exc).__name__}")
        return ""

    final_url = str(getattr(resp, "url", "") or url)
    try:
        status = int(getattr(resp, "status_code", 0) or 0)
        headers = getattr(resp, "headers", {}) or {}
        if status != 200:
            head = _first_bytes(resp, 8192) if status == 403 else b""
            memo.note_refusal(final_url, status=status, headers=headers, body_head=head, also=url)
            budget.record(route, url, f"http_{status}")
            return ""

        content_length = headers.get("Content-Length")
        if content_length and str(content_length).isdigit() and int(content_length) > PDF_DOWNLOAD_MAX_BYTES:
            budget.record(route, url, "too_large")
            return ""

        chunks = _iter_body(resp)
        first = b""
        for chunk in chunks:
            if chunk:
                first = chunk
                break
        if _is_pdf_start(first):
            body = _read_rest(first, chunks, PDF_DOWNLOAD_MAX_BYTES)
            if body is None:
                budget.record(route, url, "too_large")
                return ""
            if len(body) <= 1000:
                budget.record(route, url, "pdf_too_small")
                return ""
            _write_pdf(body, save_path)
            memo.note_served(final_url)
            budget.record(route, url, "pdf")
            return route

        content_type = str(headers.get("Content-Type", "")).lower()
        looks_html = "html" in content_type or first.lstrip()[:1] == b"<"
        if not looks_html:
            budget.record(route, url, "not_pdf")
            return ""
        if not follow_landing:
            if is_challenge_page(first.decode("utf-8", errors="replace")):
                memo.note_challenge(final_url, also=url)
                budget.record(route, url, "challenge_page")
            else:
                budget.record(route, url, "not_pdf")
            return ""
        html_bytes = _read_rest(first, chunks, LANDING_PAGE_MAX_BYTES, truncate=True) or b""
    except Exception as exc:
        # A body that breaks mid-stream (reset, read timeout) is this URL's
        # answer; the paper's remaining routes still run.
        budget.record(route, url, f"error_{type(exc).__name__}")
        return ""
    finally:
        _close(resp)

    page = html_bytes.decode("utf-8", errors="replace")
    pdf_link = find_pdf_link(page, final_url)
    if not pdf_link and is_challenge_page(page):
        memo.note_challenge(final_url, also=url)
        budget.record(route, url, "challenge_page")
        return ""
    if not pdf_link or pdf_link in {url, final_url}:
        budget.record(route, url, "landing_without_pdf_link")
        return ""
    budget.record(route, url, "landing_page")
    hop_route = f"{route}+citation_pdf_url"
    return fetch_pdf_url(
        pdf_link,
        save_path,
        route=hop_route,
        memo=memo,
        budget=budget,
        follow_landing=False,
        timeout=timeout,
    )


def _iter_body(resp):
    try:
        return iter(resp.iter_content(chunk_size=65536))
    except Exception:
        content = getattr(resp, "content", b"") or b""
        return iter([content])


def _first_bytes(resp, limit: int) -> bytes:
    try:
        for chunk in resp.iter_content(chunk_size=limit):
            return (chunk or b"")[:limit]
    except Exception:
        return b""
    return b""


def _read_rest(first: bytes, chunks, limit: int, truncate: bool = False) -> bytes | None:
    parts = [first]
    total = len(first)
    for chunk in chunks:
        if not chunk:
            continue
        total += len(chunk)
        if total > limit:
            if truncate:
                break
            return None
        parts.append(chunk)
    body = b"".join(parts)
    return body[:limit] if truncate else body


def _is_pdf_start(content: bytes) -> bool:
    return (content or b"").lstrip()[:5].startswith(b"%PDF")


def _close(resp) -> None:
    close = getattr(resp, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            pass


class _PDFLinkParser(HTMLParser):
    """Collect citation_pdf_url metas and <link rel=alternate type=application/pdf>."""

    def __init__(self) -> None:
        super().__init__()
        self.citation: list[str] = []
        self.alternate: list[str] = []

    def handle_starttag(self, tag, attrs):
        attributes = {str(k).lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            name = (attributes.get("name") or attributes.get("property") or "").strip().lower()
            if name == "citation_pdf_url" and attributes.get("content", "").strip():
                self.citation.append(attributes["content"].strip())
        elif tag == "link":
            rel = attributes.get("rel", "").lower().split()
            kind = attributes.get("type", "").strip().lower()
            if "alternate" in rel and kind == "application/pdf" and attributes.get("href", "").strip():
                self.alternate.append(attributes["href"].strip())

    handle_startendtag = handle_starttag


def find_pdf_link(html: str, base_url: str) -> str:
    """Return a landing page's declared PDF URL (absolute http/https), or ""."""
    parser = _PDFLinkParser()
    try:
        parser.feed(html or "")
    except Exception:
        pass
    for candidate in parser.citation + parser.alternate:
        absolute = urljoin(base_url or "", candidate)
        if absolute.lower().startswith(("http://", "https://")):
            return absolute
    return ""


def resolve_doi_url(doi: str, *, timeout: float = 10) -> str:
    """Return the URL a DOI is registered to (doi.org handle API), without
    fetching it, so a blocked publisher host can be skipped before the request.
    Falls back to the doi.org URL itself."""
    doi = str(doi or "").strip()
    if not doi:
        return ""
    fallback = f"https://doi.org/{doi}"
    try:
        resp = _http_get(DOI_HANDLE_API.format(doi=doi), headers=HEADERS, timeout=timeout)
        if int(getattr(resp, "status_code", 0) or 0) != 200:
            return fallback
        for value in (resp.json() or {}).get("values") or []:
            if str(value.get("type") or "").upper() == "URL":
                target = str((value.get("data") or {}).get("value") or "").strip()
                if target.lower().startswith(("http://", "https://")):
                    return target
    except Exception as exc:
        logger.debug("DOI handle lookup failed for %s: %s", doi, type(exc).__name__)
    return fallback


# =============================================================================
# Backward-compatible single-call API (registry seeds, older callers)
# =============================================================================

def download_pdf(
    doi: str = None,
    pmid: str = None,
    url: str | list[str] | tuple[str, ...] = None,
    save_path: str = None,
    max_retries: int = 3,
    memo: HostMemo | None = None,
    budget: PaperBudget | None = None,
) -> bool:
    """Download a PDF from direct URL candidates, then the DOI.

    Every URL is fetched once (a refusal is an answer, not a transient error);
    an HTML landing page is followed once through its citation_pdf_url.
    PMC PDFs come from ``fulltext_retrieval`` via Europe PMC, not from here.
    Sci-Hub is disabled by default and only tried when SCIHUB_ENABLED=1 and a
    SCIHUB_BASE_URL is explicitly configured.
    """
    if save_path and Path(save_path).exists():
        logger.info(f"PDF already exists: {save_path}")
        return True
    memo = memo if memo is not None else HostMemo()
    budget = budget if budget is not None else PaperBudget()

    for candidate_url in _candidate_urls(url):
        if _try_url_download(candidate_url, save_path, max_retries, memo=memo, budget=budget):
            return True

    if doi:
        if _try_doi_download(doi, save_path, max_retries, memo=memo, budget=budget):
            return True

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


def _try_doi_download(doi: str, save_path: str, max_retries: int = 1, *,
                      memo: HostMemo | None = None, budget: PaperBudget | None = None) -> bool:
    """Resolve the DOI and fetch it: a PDF response, or its landing page's PDF."""
    target = resolve_doi_url(doi)
    return bool(fetch_pdf_url(target, save_path, route="doi", memo=memo, budget=budget))


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


def _try_url_download(url: str, save_path: str, max_retries: int = 1, *,
                      memo: HostMemo | None = None, budget: PaperBudget | None = None) -> bool:
    """Try one direct URL (a PDF, or a landing page declaring one)."""
    return bool(fetch_pdf_url(url, save_path, route="direct_url", memo=memo, budget=budget))


def _save_pdf(url: str, save_path: str) -> bool:
    """Download from URL and save to path (no landing-page hop)."""
    return bool(fetch_pdf_url(url, save_path, route="direct_url", follow_landing=False, timeout=60))


def _write_pdf(content: bytes, save_path: str) -> bool:
    """Write PDF bytes to disk."""
    Path(save_path).parent.mkdir(parents=True, exist_ok=True)
    with open(save_path, "wb") as f:
        f.write(content)
    logger.info(f"PDF saved: {save_path}")
    return True
