#!/usr/bin/env python3
"""Record real upstream answers as reader-test fixtures, through the readers' own code paths.

Usage (from the plugin directory, with its .venv):
    .venv/bin/python tests/fixtures/record.py --list
    .venv/bin/python tests/fixtures/record.py <case> [<case> …]
    .venv/bin/python tests/fixtures/record.py --all

An adapter case runs the adapter exactly as the scheduler does — ``plan()`` on a registry row
(``registry/sources.json`` + the P2 selector blocks + the case's own config), then ``parse()`` on
each answer, following ``ParseOutput.next`` up to the case's request budget — and stores every
answer. An enrichment case runs ``knowledge_plugin.enrich`` on entry rows with a recording
fetcher. Either way the stored request is the one the code made, so the tests can check that
``plan()`` still asks the same thing and replay the answers byte for byte.

Etiquette: one request at a time, at least 1.5 s apart (3 s for arXiv, 2 s for medRxiv), the
honest ``EviMedBot/1.0`` User-Agent, robots.txt honoured for page requests (``api`` false) exactly
like the plugin's fetcher. No credential is sent except the contact address Unpaywall requires,
and the EviMed API key (``Authorization`` for ``www.evimed.com``), each read from its file by path,
added to the wire request only, and never stored: the recorded request is the one the code built
(the plugin's fetcher adds the same credential per host).
Rows with ``egress: browser`` (the Ruishu-protected regulators) are recorded through the plugin's
own browser egress — ``knowledge_plugin.fetch.ProtectedFetcher`` with ``knowledge_plugin.browser``
(robots.txt read through the browser, the list selector awaited, the same outcome rules) — against
the Chromium at ``--cdp`` (default ``http://127.0.0.1:9222``, P1's local Chrome for Testing), with
the Chrome User-Agent plus the ``EviMedBot/1.0`` suffix; the stored body is the rendered DOM the
browser handed over, and every robots.txt render is listed under ``robots`` in the provenance.
Contact details an upstream leaks (PREPARE's registrant name, e-mail, phone, address, WeChat) are
replaced by ``REDACTED`` before a body is stored; ``provenance.json`` names every redacted key and
keeps the sha256 of the original bytes. Bodies over 48 KiB are stored gzip-compressed.
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import json
import sys
import time
import urllib.robotparser
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT))

from knowledge_plugin.adapters import REGISTRY  # noqa: E402
from knowledge_plugin.browser import BrowserFetcher  # noqa: E402  (the plugin's browser egress)
from knowledge_plugin.budget import HostBudget, MemoryCounterStore  # noqa: E402
from knowledge_plugin.fetch import ProtectedFetcher, detect_challenge  # noqa: E402  (the plugin's own bot-wall rule)
from knowledge_plugin.model import FetchError, FetchResult, RequestSpec, SourceConfig, SourceState  # noqa: E402
from knowledge_plugin.settings import Settings  # noqa: E402

UA = "EviMedBot/1.0 (+https://www.evimed.com; knowledge-source monitor)"
CONTACT_FILE = ROOT.parent.parent / ".evimed-local" / "secrets" / "unpaywall.email"
EVIMED_KEY_FILE = ROOT.parent.parent / ".evimed-local" / "secrets" / "evimed.api-key"
SELECTORS_FILE = ROOT.parent.parent / "outputs" / "2026-09-22-frontier-build" / "P2-selectors.json"
REGISTRY_FILE = ROOT / "registry" / "sources.json"
BROWSER_CDP = "http://127.0.0.1:9222"
EVIMED_API_BASE = "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/"
KEPT_HEADERS = ("content-type", "etag", "last-modified", "retry-after")
GZIP_OVER = 48 * 1024
GAP_S = 1.5
HOST_GAP_S = {"export.arxiv.org": 3.1, "api.medrxiv.org": 2.1, "api.biorxiv.org": 2.1}
PII_KEYS = frozenset({"contact_name", "contact_email", "contact_phone", "contact_address", "contact_wechat",
                      "creator_info"})
UTC = timezone.utc


def _now() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


def _ext(content_type: str, url: str) -> str:
    content_type = content_type.lower()
    if "json" in content_type:
        return "json"
    if "xml" in content_type or "rss" in content_type or "atom" in content_type:
        return "xml"
    if "javascript" in content_type or url.endswith(".js"):
        return "js"
    if "pdf" in content_type:
        return "pdf"
    if "html" in content_type:
        return "html"
    return "txt"


def _redact(body: bytes, content_type: str) -> tuple[bytes, list[str]]:
    if "json" not in content_type.lower():
        return body, []
    try:
        payload = json.loads(body.decode("utf-8"))
    except ValueError:
        return body, []
    hits: list[str] = []

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            out = {}
            for key, value in node.items():
                if key in PII_KEYS and value not in (None, "", [], {}):
                    hits.append(key)
                    out[key] = "REDACTED"
                else:
                    out[key] = walk(value)
            return out
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    redacted = walk(payload)
    if not hits:
        return body, []
    return json.dumps(redacted, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), sorted(set(hits))


class RecordingBrowser(BrowserFetcher):
    """The plugin's browser egress, keeping every raw render (the page, or robots.txt as text)."""

    def __init__(self, recorder: "RecordingFetcher", cdp_url: str) -> None:
        super().__init__(cdp_url, user_agent_suffix=UA)
        self.recorder = recorder

    async def render(self, spec: RequestSpec, *, allowed_hosts, wait_for: str | None,
                     text: bool = False) -> tuple[int, dict, bytes, str]:
        meta: dict[str, Any] = {"method": spec.method, "url": spec.url, "api": spec.api, "conditional": spec.conditional,
                                "request_body": None, "request_headers": None, "egress": "browser",
                                "wait_for": wait_for, "render": "text" if text else "dom"}
        fetched_at = _now()
        target = self.recorder.robots_log if text else self.recorder.exchanges
        try:
            status, headers, body, final_url = await super().render(spec, allowed_hosts=allowed_hosts,
                                                                    wait_for=wait_for, text=text)
        except FetchError as error:
            meta.update(status=error.status, fetched_at=fetched_at.isoformat(),
                        error={"outcome": error.outcome, "detail": error.detail})
            target.append(meta)
            raise
        kept = {k: v for k, v in headers.items() if k in KEPT_HEADERS}
        meta.update(status=status, final_url=final_url, headers=kept, fetched_at=fetched_at.isoformat(),
                    user_agent=self._user_agent, browser_version=self._browser.version if self._browser else None)
        if text:
            meta.update(bytes=len(body), sha256=hashlib.sha256(body).hexdigest(),
                        text=body.decode("utf-8", "replace")[:4000])
        else:
            self.recorder._store(meta, body, kept.get("content-type", ""))
        target.append(meta)
        return status, headers, body, final_url


class RecordingFetcher:
    """Real HTTP with the plugin fetcher's outcome rules; every exchange is kept for the case.

    ``egress="browser"`` requests go through the plugin's own ``ProtectedFetcher`` and browser
    egress (module docstring), so robots.txt, the awaited selector and the outcome rules are the
    production ones.
    """

    def __init__(self, case_dir: Path, *, credentials: bool = True, browser_cdp: str = BROWSER_CDP) -> None:
        self.case_dir = case_dir
        self.credentials = credentials
        self.browser_cdp = browser_cdp
        self._protected: ProtectedFetcher | None = None
        self.robots_log: list[dict] = []
        self.exchanges: list[dict] = []
        self.client = httpx.AsyncClient(follow_redirects=True, timeout=90.0,
                                        headers={"User-Agent": UA, "Accept-Encoding": "gzip, deflate"})
        self._last: dict[str, float] = {}
        self._last_any = 0.0
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}

    async def close(self) -> None:
        await self.client.aclose()
        if self._protected is not None:
            await self._protected.aclose()

    async def _fetch_browser(self, spec: RequestSpec, allowed_hosts: Any, wait_for: str | None) -> FetchResult:
        if self._protected is None:
            settings = Settings(database_url="postgresql://unused.invalid/none")  # no database: memory budget
            self._protected = ProtectedFetcher(settings, HostBudget(MemoryCounterStore(), {}),
                                               browser=RecordingBrowser(self, self.browser_cdp))
        await self._pace((urlsplit(spec.url).hostname or "").lower())
        before = len(self.exchanges)
        try:
            return await self._protected.fetch(spec, egress="browser", allowed_hosts=allowed_hosts, wait_for=wait_for)
        except FetchError as error:
            if len(self.exchanges) > before and "error" not in self.exchanges[-1]:
                self.exchanges[-1]["error"] = {"outcome": error.outcome, "detail": error.detail}  # the fetcher's verdict
            elif len(self.exchanges) == before:  # refused before any render (robots)
                self.exchanges.append({"method": spec.method, "url": spec.url, "api": spec.api,
                                       "conditional": spec.conditional, "request_body": None, "request_headers": None,
                                       "egress": "browser", "status": error.status, "fetched_at": _now().isoformat(),
                                       "error": {"outcome": error.outcome, "detail": error.detail}})
            raise

    async def _pace(self, host: str) -> None:
        wait = max(GAP_S - (time.monotonic() - self._last_any),
                   HOST_GAP_S.get(host, GAP_S) - (time.monotonic() - self._last.get(host, 0.0)))
        if wait > 0:
            await asyncio.sleep(wait)
        self._last[host] = self._last_any = time.monotonic()

    async def _robots_allow(self, url: str) -> bool:
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            await self._pace(parts.hostname or "")
            parser: urllib.robotparser.RobotFileParser | None = urllib.robotparser.RobotFileParser()
            try:
                response = await self.client.get(origin + "/robots.txt")
                if response.status_code == 200 and "text/plain" in response.headers.get("content-type", ""):
                    parser.parse(response.text.splitlines())
                elif 400 <= response.status_code < 500:
                    parser.parse([])
                else:
                    parser.parse([])  # an HTML "robots.txt" (a homepage) carries no rules
            except httpx.HTTPError:
                parser = None
            self._robots[origin] = parser
        parser = self._robots[origin]
        return bool(parser and parser.can_fetch("EviMedBot", url))

    async def fetch(self, spec: RequestSpec, *, source_id: str | None = None, egress: str = "direct",
                    allowed_hosts: Any = None, wait_for: str | None = None) -> FetchResult:
        if egress == "browser":
            return await self._fetch_browser(spec, allowed_hosts, wait_for)
        meta: dict[str, Any] = {"method": spec.method, "url": spec.url, "api": spec.api, "conditional": spec.conditional,
                                "request_body": spec.body.decode("utf-8") if spec.body else None,
                                "request_headers": dict(spec.headers or {}) or None}
        if not spec.api and not await self._robots_allow(spec.url):
            meta.update(error={"outcome": "robots-denied", "detail": "robots_disallow"}, status=None,
                        fetched_at=_now().isoformat())
            self.exchanges.append(meta)
            raise FetchError("robots-denied", "robots_disallow")
        wire_url = spec.url
        host = (urlsplit(spec.url).hostname or "").lower()
        if host == "api.unpaywall.org":
            contact = CONTACT_FILE.read_text(encoding="utf-8").strip()
            wire_url += ("&" if "?" in wire_url else "?") + "email=" + contact
        wire_headers = dict(spec.headers or {})
        if host == "www.evimed.com" and self.credentials:  # the plugin's fetcher adds the same header from its key file
            wire_headers["Authorization"] = "Bearer " + EVIMED_KEY_FILE.read_text(encoding="utf-8").strip()
        await self._pace(host)
        fetched_at = _now()
        try:
            response = await self.client.request(spec.method, wire_url, content=spec.body, headers=wire_headers)
        except httpx.TimeoutException:
            meta.update(error={"outcome": "timeout", "detail": "timeout"}, status=None, fetched_at=fetched_at.isoformat())
            self.exchanges.append(meta)
            raise FetchError("timeout", "timeout") from None
        body = response.content
        headers = {k.lower(): v for k, v in response.headers.items() if k.lower() in KEPT_HEADERS}
        final_url = str(response.url)
        if host == "api.unpaywall.org":
            final_url = spec.url
        meta.update(status=response.status_code, final_url=final_url, headers=headers, fetched_at=fetched_at.isoformat())
        error = None
        status = response.status_code
        if status == 429 or (status == 503 and "retry-after" in headers):
            error = FetchError("http-error", f"rate_limited_{status}", status=status)
        elif spec.api and status == 404 and body.strip():
            error = None
        elif detect_challenge(status, headers.get("content-type", ""), body, api=spec.api):
            error = FetchError("challenge", detect_challenge(status, headers.get("content-type", ""), body, api=spec.api),
                               status=status)
        elif status in (401, 403, 451):
            error = FetchError("blocked", f"http_{status}", status=status)
        elif status < 200 or status >= 300:
            error = FetchError("http-error", f"http_{status}", status=status)
        elif not body.strip():
            error = FetchError("empty", "empty_body", status=status)
        if body:
            self._store(meta, body, headers.get("content-type", ""))
        if error is not None:
            meta["error"] = {"outcome": error.outcome, "detail": error.detail}
            self.exchanges.append(meta)
            raise error
        self.exchanges.append(meta)
        stored = gzip.decompress((self.case_dir / meta["file"]).read_bytes()) if meta["gzip"] else \
            (self.case_dir / meta["file"]).read_bytes()
        return FetchResult(request=spec, final_url=final_url, status=status, headers=headers, body=stored,
                           fetched_at=fetched_at)

    def _store(self, meta: dict, body: bytes, content_type: str) -> None:
        original_sha = hashlib.sha256(body).hexdigest()
        body, redacted = _redact(body, content_type)
        name = f"{len(self.exchanges) + 1:02d}.{_ext(content_type, meta['url'])}"
        packed = len(body) > GZIP_OVER
        if packed:
            name += ".gz"
            (self.case_dir / name).write_bytes(gzip.compress(body, mtime=0))
        else:
            (self.case_dir / name).write_bytes(body)
        meta.update(file=name, gzip=packed, bytes=len(body), sha256=hashlib.sha256(body).hexdigest())
        if redacted:
            meta.update(redacted_keys=redacted, original_sha256=original_sha)


# ---------------------------------------------------------------------------------------------
# Registry rows and cases
# ---------------------------------------------------------------------------------------------

def registry_row(source_id: str) -> dict:
    rows = {r["id"]: r for r in json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))["sources"]}
    row = json.loads(json.dumps(rows[source_id]))
    if SELECTORS_FILE.exists():
        block = json.loads(SELECTORS_FILE.read_text(encoding="utf-8")).get(source_id) or {}
        row["config"].update({k: v for k, v in block.items() if not k.startswith("_")})
    return row


def _source(row: dict) -> SourceConfig:
    return SourceConfig(**{name: row.get(name) for name in SourceConfig.__dataclass_fields__})


def _clean_row(row: dict) -> dict:
    return {k: v for k, v in row.items() if k in SourceConfig.__dataclass_fields__}


ADAPTER_CASES: dict[str, dict] = {
    # crossref-issn
    "crossref-issn/nejm": {"source": "j-0028-4793", "budget": 5},
    "crossref-issn/frontiers-pharmacology-paging": {"source": "j-1663-9812", "budget": 5},
    "crossref-issn/kidney-international-masthead": {"source": "j-0085-2538", "budget": 5,
                                                     "note": "a week with an 'Editorial Board' work (found by a Crossref title query on 2026-09-22)"},
    "crossref-issn/nature-communications-notices": {"source": "j-2041-1723", "budget": 3,
                                                     "note": "first 3 pages of a 7-day window with >200 works: cursor chain + Author Correction notices"},
    # eutils-query
    "eutils-query/rct-core-journals": {"source": "pubmed-rct-core-journals", "budget": 6},
    "eutils-query/mendelian-randomization-backward-pages": {"source": "pubmed-mendelian-randomization", "budget": 6,
                                                             "config": {"page_size": 25}},
    "eutils-query/retractions": {"source": "pubmed-retractions", "budget": 3, "config": {"page_size": 30},
                                 "last_ok_hours": 24},
    # europepmc
    "europepmc/medrxiv-preprints": {"source": "europepmc-medrxiv-preprints", "budget": 2, "config": {"page_size": 50},
                                    "last_ok_hours": 24},
    # json-api
    "json-api/openfda-enforcement": {"source": "openfda-drug-enforcement-api", "budget": 1},
    "json-api/openfda-shortages": {"source": "openfda-drug-shortages-api", "budget": 1},
    "json-api/openfda-drugsfda": {"source": "openfda-drugsfda-api", "budget": 1,
                                  "note": "first page only (the chain continues by skip)"},
    "json-api/openfda-event": {"source": "openfda-drug-event-faers-api", "budget": 1},
    "json-api/ctgov-results-first-posted": {"source": "ctgov-results-first-posted", "budget": 2},
    "json-api/ctgov-stopped-phase3": {"source": "ctgov-stopped-phase3", "budget": 1},
    "json-api/ctgov-phase3-new-registrations": {"source": "ctgov-phase3-new-registrations", "budget": 1},
    "json-api/who-news": {"source": "who-news-api", "budget": 1},
    "json-api/who-disease-outbreak-news": {"source": "who-disease-outbreak-news", "budget": 1},
    "json-api/who-publications": {"source": "who-publications-api", "budget": 1},
    "json-api/medrxiv-details": {"source": "medrxiv-api-details", "budget": 3, "last_ok_hours": 24},
    "json-api/crossref-retraction-updates": {"source": "crossref-retraction-updates", "budget": 1},
    "json-api/medhelm": {"source": "stanford-medhelm", "budget": 2},
    "json-api/prepare-registry": {"source": "prepare-guideline-registry", "budget": 1},
    "json-api/star-rating": {"source": "star-guideline-rating-cn", "budget": 2,
                             "note": "first two pages of the 152-page walk"},
    "json-api/federalregister-fda": {
        "row": {"id": "federalregister-fda-documents", "name": "Federal Register · FDA documents", "homepage": None,
                "lane": "regulatory", "source_type": "regulator", "access": "json-api", "egress": "direct",
                "authority": 4, "safety_feed": False, "owner_entity": "US Office of the Federal Register",
                "launch_tier": "P2", "language": "en", "region": "US", "poll_floor_s": 3600, "poll_ceiling_s": 86400,
                "config": {"url": "https://www.federalregister.gov/api/v1/documents.json?conditions[agencies][]=food-and-drug-administration&conditions[publication_date][gte]={since:%Y-%m-%d}&order=newest&per_page=20",
                           "family": "federalregister", "lookback_days": 7, "max_pages": 2,
                           "allowed_hosts": ["www.federalregister.gov"]}},
        "budget": 2, "note": "not a registry row: the FDA-agency query the P2 relay rows name as endpoint_alt"},
    # evimed-api (rows proposed to P1 in P2-selectors.json; not in the registry yet)
    "evimed-api/chictr": {"row": "EVIMED_CHICTR_ROW", "budget": 3,
                          "note": "the first 3 of the 20 specialty queries of the daily ChiCTR scan"},
    "evimed-api/guide": {"row": "EVIMED_GUIDE_ROW", "budget": 2,
                         "note": "the first 2 of the 4 queries of the weekly guideline scan"},
    "evimed-api/chictr-v1": {"row": "EVIMED_CHICTR_ROW", "budget": 1, "config": {"url": EVIMED_API_BASE + "clinical-trial"},
                             "note": "the first query of the daily ChiCTR scan against the v1 endpoint (it carries primarySponsor)"},
    # rss / atom
    "rss/zgyxzz-undated": {"source": "zgyxzz-pharm", "budget": 1},
    "rss/chinjmap-double-escaped": {"source": "chinjmap", "budget": 1},
    "rss/harrell-stale-oversize": {"source": "statistical-thinking-harrell", "budget": 1},
    "rss/sciencenet-naive-local-time": {"source": "sciencenet-paper-med", "budget": 1},
    "rss/medrxiv-epidemiology": {"source": "medrxiv-epidemiology", "budget": 1},
    "rss/ema-new-human-medicines": {"source": "ema-new-human-medicines", "budget": 1},
    "rss/cdc-eid-ahead-of-print": {"source": "cdc-eid-journal", "budget": 1},
    "atom/mhra-drug-safety-update": {"source": "mhra-drug-safety-update", "budget": 1},
    "atom/arxiv-qbio-qm": {"source": "arxiv-qbio-qm", "budget": 1},
    # html-list
    "html-list/nhsa-notices": {"source": "nhsa-notices", "budget": 1},
    "html-list/nhsa-consultations": {"source": "nhsa-consultations", "budget": 1},
    "html-list/nhsa-policy-interpretation": {"source": "nhsa-policy-interpretation", "budget": 1},
    "html-list/gov-cn-policy": {"source": "gov-cn-policy", "budget": 1},
    "html-list/cdr-adr-safety-warnings": {"source": "cdr-adr-safety-warnings", "budget": 1},
    "html-list/cdr-adr-pv-newsletter": {"source": "cdr-adr-pv-newsletter", "budget": 1},
    "html-list/ema-prac-safety-signals": {"source": "ema-prac-safety-signals", "budget": 1},
    "html-list/pubmed-trending": {"source": "pubmed-trending-page", "budget": 1},
    "html-list/ndcpa-notices": {"source": "ndcpa-notices", "budget": 1},
    "html-list/ndcpa-epidemic-info": {"source": "ndcpa-epidemic-info", "budget": 1},
    "html-list/sciencenet-topnews": {"source": "sciencenet-news", "budget": 1},
    # html-list, batch 2 (SPEC G(4): P1-tier Chinese societies, regulators and media with clean lists)
    "html-list/natcm-notices": {"source": "natcm-notices", "budget": 1},
    "html-list/most-tztg": {"source": "most-tztg", "budget": 1},
    "html-list/nmpa-gd-mirror": {"source": "nmpa-gd-mirror", "budget": 1},
    "html-list/csco-news": {"source": "csco-news", "budget": 1},
    "html-list/gd-pharm-society-notifications": {"source": "gd-pharm-society-notifications", "budget": 1},
    "html-list/cntcm-news": {"source": "cntcm-news", "budget": 1},
    "html-list/nhsa-policy-regulations": {"source": "nhsa-policy-regulations", "budget": 1},
    "html-list/cdr-adr-notices": {"source": "cdr-adr-notices", "budget": 1},
    "html-list/zhongguokexuebao": {"source": "zhongguokexuebao", "budget": 1},
    "html-list/chinacdc-notifiable-disease": {"source": "chinacdc-notifiable-disease", "budget": 1},
    "html-list/china-cdc-news": {"source": "china-cdc-news", "budget": 1},
    # browser-list (egress browser: rendered by the plugin's browser egress, see the module docstring)
    "browser-list/nmpa-ggtg": {"source": "nmpa-ggtg", "budget": 1},
    "browser-list/nmpa-label-revision-announcements": {"source": "nmpa-label-revision-announcements", "budget": 1},
    "browser-list/nmpa-other-drug-announcements": {"source": "nmpa-other-drug-announcements", "budget": 1},
    "browser-list/nmpa-innovative-approvals": {"source": "nmpa-innovative-approvals", "budget": 1},
    "browser-list/cde-breakthrough-therapy": {
        "source": "cde-breakthrough-therapy", "budget": 1,
        "note": ("药审中心 refused this box from ~11:13Z on 2026-09-22 (403 WAF page); the stored fixture is the 11:11:15Z "
                 "render of knowledge_plugin.browser's helper (see its provenance) — re-record only from a host CDE answers")},
    "browser-list/cmde-guidance": {"source": "cmde-guidance", "budget": 1},
    "browser-list/nhc-policy-documents": {"source": "nhc-policy-documents", "budget": 1},
    "browser-list/cde-guidance-principles-refused": {
        "source": "cde-guidance-principles", "budget": 1,
        "note": "negative case: 药审中心's guidance list answers a real Chromium on this box with a 403 WAF page"},
}

EVIMED_API = "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/"
EVIMED_CHICTR_ROW = {
    "id": "evimed-chictr", "name": "中国临床试验注册中心 ChiCTR（经 EviMed 接口）", "homepage": "https://www.chictr.org.cn/",
    "lane": "pipeline", "source_type": "regulator", "access": "evimed-api", "egress": "api", "authority": 4,
    "safety_feed": False, "owner_entity": "中国临床试验注册中心", "launch_tier": "P1", "language": "zh", "region": "CN",
    "poll_floor_s": 86400, "poll_ceiling_s": 172800,
    "config": {"family": "chictr", "url": EVIMED_API + "v2/clinical-trial",
               "queries": ["肿瘤", "心血管", "糖尿病", "神经", "精神", "感染", "呼吸", "重症", "消化", "肝病", "肾脏", "风湿免疫",
                           "血液", "儿科", "妇产", "老年", "外科", "麻醉", "中医药", "药物"],
               "registry": 0, "count": 100, "new_within_days": 14, "max_pages": 25,
               "allowed_hosts": ["www.evimed.com"]}}
EVIMED_GUIDE_ROW = {
    "id": "evimed-guides", "name": "EviMed 指南库 · 新收录的指南与共识", "homepage": "https://www.evimed.com/",
    "lane": "guideline", "source_type": "evidence-body", "access": "evimed-api", "egress": "api", "authority": 3,
    "safety_feed": False, "owner_entity": "EviMed", "launch_tier": "P1", "language": "zh", "region": "CN",
    "poll_floor_s": 604800, "poll_ceiling_s": 604800,
    "config": {"family": "guide", "url": EVIMED_API + "v2/literature-guide",
               "queries": ["指南", "专家共识", "临床实践指南", "诊疗规范"], "type": "guide", "count": 100,
               "new_within_days": 30, "max_pages": 35, "allowed_hosts": ["www.evimed.com"]}}
ROWS = {"EVIMED_CHICTR_ROW": EVIMED_CHICTR_ROW, "EVIMED_GUIDE_ROW": EVIMED_GUIDE_ROW}


# Negative cases: a real upstream answer to a deliberately wrong request, parsed with the named row.
RAW_CASES: dict[str, dict] = {
    "crossref-issn/select-refused": {
        "source": "j-0028-4793",
        "requests": [{"url": "https://api.crossref.org/journals/0028-4793/works?filter=from-created-date:2026-09-15,type:journal-article&rows=5&select=DOI,title,subtype"}],
        "note": "negative case: select=subtype on the journal route (Crossref answers 400 select-not-available)"},
    "eutils-query/datetype-misspelled": {
        "source": "pubmed-rct-core-journals",
        "requests": [{"url": "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=0&usehistory=y&datetype=edta&mindate=2026/09/15&maxdate=2026/09/22&term=(randomized%20controlled%20trial%5Bpt%5D)"}],
        "note": "negative case: datetype=edta (misspelled); PubMed answers 200 count 0 with the dates read as words"},
    "json-api/openfda-no-matches": {
        "source": "openfda-drugsfda-api",
        "requests": [{"url": "https://api.fda.gov/drug/drugsfda.json?search=submissions.submission_status_date:%5B20300101+TO+20300102%5D&limit=5"}],
        "note": "a window with no approvals: openFDA answers HTTP 404 NOT_FOUND"},
    "evimed-api/no-key": {
        "row": "EVIMED_CHICTR_ROW", "credentials": False,
        "requests": [{"url": EVIMED_API + "v2/clinical-trial", "method": "POST",
                      "body": {"query": "肿瘤", "count": 1, "registry": 0, "startYear": 2026}}],
        "note": "negative case: the request sent without the Authorization header"},
    "europepmc/hitcount-probe": {
        "source": "europepmc-medrxiv-preprints",
        "requests": [{"url": "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=SRC%3APPR%20AND%20PUBLISHER%3A%22medRxiv%22&format=json&resultType=lite&pageSize=1"}],
        "repeat_until_missing_hitcount": 12,
        "note": "the same small request repeated (>= 1.5 s apart) until Europe PMC answered 200 without hitCount, or 12 tries"},
}


async def record_adapter_case(name: str, spec: dict) -> dict:
    case_dir = HERE / name
    case_dir.mkdir(parents=True, exist_ok=True)
    for old in case_dir.iterdir():
        old.unlink()
    row = spec.get("row") or registry_row(spec["source"])
    if isinstance(row, str):
        row = ROWS[row]
    row = json.loads(json.dumps(row))
    row["config"].update(spec.get("config") or {})
    source = _source(row)
    now = _now()
    last_ok = now - timedelta(hours=spec["last_ok_hours"]) if spec.get("last_ok_hours") else None
    state = SourceState(etag=None, last_modified=None, last_content_sha256=None, last_ok_at=last_ok,
                        first_contact_at=None, cursor={})
    adapter = REGISTRY[source.access]
    fetcher = RecordingFetcher(case_dir)
    parse_notes: list[str] = []
    errors: list[dict] = []
    try:
        # The scheduler's order: planned requests in a FIFO queue, a page's `next` appended at the
        # end, a request whose parse named a short retry delay put back at the front once.
        budget = int(spec.get("budget", 1))
        wait_for = None
        if source.egress == "browser":  # the scheduler's rule: config.wait_for, else the item selector minus "@attr"
            wait_for = source.config.get("wait_for") or (source.config.get("selectors") or {}).get("item")
            if wait_for and "@" in wait_for:
                wait_for = wait_for.split("@", 1)[0].strip() or None
        queue = deque(adapter.plan(source, state, now))
        retried: set[str] = set()
        while queue and budget > 0:
            request = queue.popleft()
            budget -= 1
            try:
                result = await fetcher.fetch(request, source_id=source.id, egress=source.egress,
                                             allowed_hosts=source.config.get("allowed_hosts"), wait_for=wait_for)
            except FetchError as error:
                errors.append({"step": "fetch", "outcome": error.outcome, "detail": error.detail})
                break
            try:
                output = adapter.parse(result, source, now)
            except FetchError as error:
                errors.append({"step": "parse", "outcome": error.outcome, "detail": error.detail})
                if request.url not in retried and error.retry_after_s is not None and error.retry_after_s <= 30:
                    retried.add(request.url)
                    await asyncio.sleep(error.retry_after_s)
                    queue.appendleft(request)
                    budget += 1
                    continue
                break
            parse_notes += output.notes
            if output.next is not None:
                queue.append(output.next)
    finally:
        await fetcher.close()
    provenance = {"case": name, "recorded_by": "tests/fixtures/record.py (package P2)", "user_agent": UA,
                  "recorded_at": _now().isoformat(), "note": spec.get("note"), "source": _clean_row(row),
                  "state": {"last_ok_at": last_ok.isoformat() if last_ok else None, "cursor": {}},
                  "now": now.isoformat(), "request_budget": spec.get("budget", 1), "parse_notes": parse_notes,
                  "errors": errors, "exchanges": fetcher.exchanges}
    if fetcher.robots_log:
        provenance["robots"] = fetcher.robots_log
    (case_dir / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return provenance


async def record_raw_case(name: str, spec: dict) -> dict:
    case_dir = HERE / name
    case_dir.mkdir(parents=True, exist_ok=True)
    for old in case_dir.iterdir():
        old.unlink()
    row = ROWS[spec["row"]] if spec.get("row") else registry_row(spec["source"])
    fetcher = RecordingFetcher(case_dir, credentials=spec.get("credentials", True))
    tries = 0
    try:
        for item in spec["requests"]:
            body = json.dumps(item["body"], ensure_ascii=False).encode("utf-8") if item.get("body") else None
            request = RequestSpec(url=item["url"], method=item.get("method", "GET"), body=body,
                                  headers={"Content-Type": "application/json"} if body else {}, conditional=False, api=True)
            repeat = int(spec.get("repeat_until_missing_hitcount") or 1)
            for _ in range(repeat):
                tries += 1
                try:
                    result = await fetcher.fetch(request, source_id=row["id"])
                except FetchError:
                    break
                if repeat > 1:
                    payload = json.loads(result.body.decode("utf-8", errors="replace"))
                    if isinstance(payload, dict) and "hitCount" not in payload:
                        break
                    # a normal answer: forget it and ask again, keeping only the fault when it comes
                    (case_dir / fetcher.exchanges[-1]["file"]).unlink()
                    fetcher.exchanges.pop()
    finally:
        await fetcher.close()
    provenance = {"case": name, "recorded_by": "tests/fixtures/record.py (package P2)", "user_agent": UA,
                  "recorded_at": _now().isoformat(), "note": spec.get("note"), "tries": tries,
                  "source": _clean_row(row), "state": None, "now": _now().isoformat(), "exchanges": fetcher.exchanges}
    (case_dir / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return provenance


# Enrichment cases are defined in record_enrich.py (they are built from recorded adapter cases).


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("cases", nargs="*")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args(argv)
    known = {**ADAPTER_CASES, **RAW_CASES}
    if args.list:
        print("\n".join(sorted(known)))
        return 0
    names = sorted(known) if args.all else args.cases
    unknown = [n for n in names if n not in known]
    if unknown:
        print(f"unknown cases: {unknown}", file=sys.stderr)
        return 2
    for name in names:
        runner = record_adapter_case if name in ADAPTER_CASES else record_raw_case
        provenance = asyncio.run(runner(name, known[name]))
        statuses = [e.get("status") for e in provenance["exchanges"]]
        print(f"{name}: {len(provenance['exchanges'])} exchange(s) {statuses} errors={provenance.get('errors')}",
              flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
