"""The protected transport every plugin request goes through (plan 10.2.3 step 3).

One request, in order:

1. **Egress.** ``direct``/``api`` (pinned connections from this host), ``relay`` (the Tokyo TLS
   forward proxy, for sites that refuse Beijing) and ``browser`` (a headless Chromium over CDP, for
   lists drawn in script behind Ruishu). An exit this deployment has not configured, and ``bridge``
   (WeChat, not built), raise ``FetchError('blocked', 'egress_unavailable')`` — a source can be
   enabled before its exit exists, and must fail by name (the scheduler counts that as the
   deployment's gap, not the source's failure).
2. **Host policy.** http(s) only, no userinfo, and the first hop must be one of the source's
   ``allowed_hosts`` (subdomains included) when the caller passes them.
3. **robots.txt** for page requests only (``RequestSpec.api`` is False); a disallowed page is
   ``robots-denied``; a ``Crawl-delay`` widens the host's spacing.
4. **Budget.** The host's slot (spacing, concurrency, daily cap, pause) — see ``budget.py``.
5. **DNS pinning.** The plugin resolves the name itself and refuses the request if ANY answer is
   not a global unicast address (private, loopback, link-local, CGNAT, reserved, multicast,
   IPv4-mapped forms included) — a name that answers both public and private is the rebinding
   trick, not a CDN. It then connects to the vetted IP with ``Host`` and TLS SNI set to the name
   (httpx's ``sni_hostname`` extension), so the certificate is still verified against the name.
   Each host gets its own connection pool: CDN addresses are shared by many sites, and a pool keyed
   by IP would reuse a TLS session made for another name.
6. **Transfer.** Redirects are followed by hand, at most five, each hop re-vetted (scheme, DNS,
   robots for pages, budget); the body is streamed and aborted past 16 MiB *decoded* (a gzip bomb
   is still 16 MiB); one deadline of 35 s covers the whole exchange (medRxiv 30 s).
7. **Outcome.** 304 → ``not_modified``; 429 or 503 with ``Retry-After`` pause the whole host;
   bot walls (Cloudflare, Ruishu 412/202 script pages, Akamai, Incapsula, DataDome, PerimeterX,
   Aliyun and Volcano WAF markers — the detector of ``tools/verify_feed.py``) are ``challenge``;
   401/403/451 are ``blocked``; other errors ``http-error``; see ``model.FETCH_OUTCOMES``. Empty
   HTML shells (< 300 visible characters) are also ``challenge`` — decided by the scheduler after
   the adapter found no entries on the page (``is_empty_shell``).

Identity: ``User-Agent: EviMedBot/1.0 (+https://www.evimed.com; knowledge-source monitor;
mailto:<contact>)``. FDA, CDC and Health Canada refuse a browser string from a datacenter address
but answer this honest one (measured 2026-09-22), so the crawler never pretends to be a browser.

Credentials are the transport's business, per host: NCBI ``tool``/``email``/``api_key``, openFDA
``api_key``, Unpaywall ``email``, OpenAlex ``mailto`` are added to the query here and stripped from
``FetchResult.final_url``; the team's EviMed evidence API gets ``Authorization: Bearer <key>`` on its
API path only; adapters, logs and the fetch log never see any of them, and an ``Authorization``,
``Cookie`` or ``Host`` header an adapter sets is dropped. Log lines carry URLs without their query
string (``redact_url``).
"""

from __future__ import annotations

import asyncio
import html
import ipaddress
import logging
import re
import socket
import ssl
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Iterable, Sequence
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

import httpx

from .budget import HostBudget
from .browser import RENDER_HEADER, RENDER_NO_SELECTOR, RENDER_SELECTOR_FOUND, BrowserFetcher
from .model import IMPLEMENTED_EGRESSES, FetchError, FetchResult, RequestSpec
from .robots import RobotsCache
from .settings import EdgeProxy, Settings

log = logging.getLogger("knowledge_plugin.fetch")

ACCEPT = ("application/rss+xml, application/atom+xml, application/xml;q=0.9, application/json;q=0.9, "
          "text/html;q=0.8, */*;q=0.5")
ACCEPT_LANGUAGE = "en;q=0.9, zh-CN;q=0.8"
MIN_VISIBLE_CHARS = 300
MAX_CLIENTS = 64
DEFAULT_PAUSE_S = 600.0

Resolver = Callable[[str, int], Awaitable[list[str]]]


def user_agent(contact: str | None) -> str:
    base = "EviMedBot/1.0 (+https://www.evimed.com; knowledge-source monitor"
    return f"{base}; mailto:{contact})" if contact else base + ")"


def redact_url(url: str) -> str:
    """A URL fit for a log line: no query, no fragment, no userinfo."""
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
        port = f":{parts.port}" if parts.port else ""
        return urlunsplit((parts.scheme, host + port, parts.path, "…" if parts.query else "", ""))
    except ValueError:
        return "<unparsable-url>"


# ------------------------------------------------------------------------------------ address policy

def is_public_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        elif ip.sixtofour is not None or ip.teredo is not None:
            return False
    return ip.is_global and not ip.is_multicast


async def system_resolver(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    ordered: list[str] = []
    for family in (socket.AF_INET, socket.AF_INET6):
        for info in infos:
            if info[0] == family and info[4][0] not in ordered:
                ordered.append(info[4][0])
    return ordered


def host_allowed(host: str, allowed: Iterable[str]) -> bool:
    host = host.lower().rstrip(".")
    return any(host == a or host.endswith("." + a) for a in (h.lower().rstrip(".") for h in allowed))


# ------------------------------------------------------------------------------------ challenge detection

# Ported from tools/verify_feed.py CHALLENGES. "Strong" markers never occur in real content; "weak"
# ones can ("security check" in a news story), so on a 200 they only count on a small page.
STRONG_MARKERS = [
    ("cloudflare", re.compile(r"cf-chl-|challenge-platform|Attention Required! \| Cloudflare", re.I)),
    ("ruishu", re.compile(r"\$_ts\s*=|_\$[a-zA-Z0-9]{2}\(|<meta\s+id=\"[A-Za-z0-9]{16,}\"\s+content=", re.I)),
    ("incapsula", re.compile(r"Incapsula incident|_Incapsula_Resource", re.I)),
    ("aliyun-waf", re.compile(r"acw_sc__v2|aliyun_waf", re.I)),
    ("volc-waf", re.compile(r"verifycenter|captcha\.volces|byted_acrawler", re.I)),
    ("datadome", re.compile(r"captcha-delivery\.com", re.I)),
]
WEAK_MARKERS = [
    ("cloudflare", re.compile(r"Just a moment\.\.\.", re.I)),
    ("ruishu", re.compile(r"/[A-Za-z0-9]{8,}/[A-Za-z0-9]{8,}\.[a-f0-9]{6,}\.js", re.I)),
    ("akamai", re.compile(r"Access Denied.*Reference #|errors\.edgesuite\.net", re.I | re.S)),
    ("datadome", re.compile(r"datadome", re.I)),
    ("perimeterx", re.compile(r"px-captcha|perimeterx", re.I)),
    ("aliyun-waf", re.compile(r"renderData.*captcha", re.I | re.S)),
    ("volc-waf", re.compile(r"security check", re.I)),
]
_SCRIPT_STYLE = re.compile(r"<(script|style|noscript)[^>]*>.*?</\1\s*>", re.I | re.S)
_COMMENT = re.compile(r"<!--.*?-->", re.S)
_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


def looks_like_html(content_type: str, body: bytes) -> bool:
    if "html" in content_type:
        return True
    head = body[:512].lstrip().lower()
    return head.startswith((b"<!doctype html", b"<html"))


def visible_chars(body: bytes) -> int:
    text = body[:2_000_000].decode("utf-8", "replace")
    text = _COMMENT.sub(" ", _SCRIPT_STYLE.sub(" ", text))
    text = html.unescape(_TAG.sub(" ", text))
    return len(_WS.sub("", text))


def detect_challenge(status: int, content_type: str, body: bytes, *, api: bool) -> str | None:
    """The name of the bot wall this response is, or None (see module docstring)."""
    if not looks_like_html(content_type, body):
        return None
    head = body[:6000].decode("utf-8", "replace")
    for name, pattern in STRONG_MARKERS:
        if pattern.search(head):
            return name
    visible = visible_chars(body)
    small = visible < 1500
    if status != 200 or small:
        for name, pattern in WEAK_MARKERS:
            if pattern.search(head):
                return name
    if status in (202, 412) and small:
        return f"script_page_{status}"
    # An empty shell (< 300 visible characters) is judged AFTER parsing, by the scheduler
    # (``is_empty_shell``): Chinese government lists ship their items inside a <script> CDATA or
    # JSON block (NHSA, NDCPA) that an adapter reads fine, so the transport cannot tell a shell from
    # a script-carried list; "no visible text AND the adapter found nothing" can.
    return None


def is_empty_shell(content_type: str, body: bytes) -> bool:
    """An HTML page with almost no visible text (the second half of the challenge rule)."""
    return looks_like_html(content_type, body) and visible_chars(body) < MIN_VISIBLE_CHARS


def rendered_passed(status: int, headers: dict, content: bytes) -> bool:
    """A browser-rendered page is judged by what it shows, not by the vendor script it still carries.

    Ruishu leaves its inline script in the DOM of a page that got through (药审中心, 2026-09-22: 200,
    10 table rows, 5,498 visible characters, and ``_$tG(`` in the first 6,000 bytes), so the marker
    test would call every passed CDE page a challenge. A 200 page whose awaited list was found — or,
    rendered without a selector, one with plenty of visible text — has passed; a final 202/412, a list
    that never appeared, or a near-empty page is still judged by the markers and the status.
    """
    state = headers.get(RENDER_HEADER)
    if state is None or status != 200:
        return False
    if state == RENDER_SELECTOR_FOUND:
        return True
    return state == RENDER_NO_SELECTOR and visible_chars(content) >= 1500


def retry_after_seconds(value: str | None, now: datetime) -> float | None:
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        from email.utils import parsedate_to_datetime
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - now).total_seconds())


# ------------------------------------------------------------------------------------ credentials

CREDENTIAL_KEYS = frozenset({"api_key", "email", "tool", "mailto"})


def _credential_params(host: str, settings: Settings) -> list[tuple[str, str]]:
    contact = settings.contact_email()
    params: list[tuple[str, str]] = []
    if host == "eutils.ncbi.nlm.nih.gov":
        params.append(("tool", "evimed-knowledge-plugin"))
        if contact:
            params.append(("email", contact))
        key = settings.secret("ncbi_key")
        if key:
            params.append(("api_key", key))
    elif host == "api.fda.gov":
        key = settings.secret("openfda_key")
        if key:
            params.append(("api_key", key))
    elif host == "api.unpaywall.org" and contact:
        params.append(("email", contact))
    elif host == "api.openalex.org" and contact:
        params.append(("mailto", contact))
    return params


def with_credentials(url: str, settings: Settings) -> str:
    parts = urlsplit(url)
    extra = _credential_params((parts.hostname or "").lower(), settings)
    if not extra:
        return url
    present = {k for k, _ in parse_qsl(parts.query, keep_blank_values=True)}
    added = [(k, v) for k, v in extra if k not in present]
    if not added:
        return url
    query = parts.query + ("&" if parts.query else "") + urlencode(added)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))


def without_credentials(url: str) -> str:
    parts = urlsplit(url)
    if not parts.query:
        return url
    kept = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k not in CREDENTIAL_KEYS]
    if len(kept) == len(parse_qsl(parts.query, keep_blank_values=True)):
        return url
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(kept), parts.fragment))


# ------------------------------------------------------------------------------------ the fetcher

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


EVIMED_API_HOST = "www.evimed.com"
EVIMED_API_PREFIX = "/api-evimed/medicine-api/ai-api/"
# Headers an adapter never sets: identity, credentials and cookies are the transport's business.
HEADERS_NEVER_FROM_ADAPTERS = frozenset({"host", "user-agent", "authorization", "proxy-authorization", "cookie"})
# Outcomes that say the EXIT failed (the request never reached, or never came back from, the
# upstream) — what the per-egress health in /v1/health counts.
TRANSPORT_FAILURES = frozenset({"connect_failed", "dns_failed", "tls_failed", "timeout", "navigation_timeout",
                                "edge_proxy_unreachable", "edge_proxy_refused", "browser_unreachable"})


@dataclass
class EgressStats:
    """How one exit has behaved since this process started (the health endpoint's per-egress state)."""

    attempts: int = 0
    failures: int = 0
    last_ok_at: datetime | None = None
    last_failure_at: datetime | None = None
    last_detail: str | None = None

    def status(self, now: datetime) -> str | None:
        if self.attempts == 0:
            return None
        if self.last_ok_at is not None and (self.last_failure_at is None or self.last_ok_at >= self.last_failure_at):
            return "ok"
        if self.last_ok_at is not None and now - self.last_ok_at < timedelta(hours=1):
            return "degraded"
        return "down"


def _ip_literal(host: str) -> str | None:
    try:
        return str(ipaddress.ip_address(host.strip("[]")))
    except ValueError:
        return None


_EVIMED_CODE = re.compile(rb'"code"\s*:\s*(\d{3})')


def _evimed_envelope_code(status: int, content: bytes) -> int:
    """The EviMed API wraps its own status in the body: a refused key is HTTP 200 with
    ``{"code": 401, "msg": "当前api_key不存在"}`` (measured 2026-09-22), so health reads the envelope."""
    if status != 200:
        return status
    match = _EVIMED_CODE.search(content[:256])
    return int(match.group(1)) if match else status


def _proxy_error_status(error: Exception) -> int | None:
    match = re.search(r"\b([1-5]\d\d)\b", str(error))
    return int(match.group(1)) if match else None


class ProtectedFetcher:
    """``fetch(spec, source_id=, egress=, allowed_hosts=, wait_for=) -> FetchResult`` (module docstring).

    Exits: ``direct``/``api`` connect to the vetted, pinned address; ``relay`` goes through the Tokyo
    TLS forward proxy (TLS to the proxy, then a CONNECT tunnel and TLS from here to the target, so the
    node sees a host name and nothing else and cannot alter what the target signs); ``browser`` renders
    the page in the shared headless Chromium (``browser.py``). robots.txt for a page is read through
    the same exit as the page — a site that refuses Beijing refuses Beijing's robots.txt request too.
    """

    def __init__(self, settings: Settings, budget: HostBudget, *, resolver: Resolver = system_resolver,
                 transport_factory: Callable[[], httpx.AsyncBaseTransport] | None = None,
                 clock: Callable[[], datetime] = _utcnow, robots: RobotsCache | None = None,
                 relay_ssl_context: ssl.SSLContext | None = None, browser: BrowserFetcher | None = None) -> None:
        self._settings = settings
        self._budget = budget
        self._resolver = resolver
        self._transport_factory = transport_factory
        self._clock = clock
        self._clients: OrderedDict[str, httpx.AsyncClient] = OrderedDict()
        self._closing: set[asyncio.Task] = set()
        self._relay_ssl_context = relay_ssl_context
        self._relay_client: httpx.AsyncClient | None = None
        self._relay_key: tuple | None = None
        if browser is None and settings.browser_cdp_url:
            browser = BrowserFetcher(settings.browser_cdp_url, timeout_s=settings.browser_timeout_s,
                                     user_agent_suffix=user_agent(settings.contact_email()))
        self._browser = browser
        self.robots = robots or RobotsCache(lambda origin: self._fetch_robots(origin, "direct"))
        self._robots_by_egress = {
            "direct": self.robots, "api": self.robots,
            "relay": RobotsCache(lambda origin: self._fetch_robots(origin, "relay")),
            "browser": RobotsCache(lambda origin: self._fetch_robots(origin, "browser")),
        }
        self.egress_stats: dict[str, EgressStats] = {}
        self.evimed_last_status: tuple[int, datetime] | None = None

    # ---------------------------------------------------------------- lifecycle and state

    async def aclose(self) -> None:
        clients = list(self._clients.values())
        self._clients.clear()
        for client in clients:
            await client.aclose()
        if self._relay_client is not None:
            await self._relay_client.aclose()
            self._relay_client = None
        if self._browser is not None:
            await self._browser.aclose()

    def egress_configured(self, egress: str) -> bool:
        if egress in ("direct", "api"):
            return True
        if egress == "relay":
            return self._settings.edge_proxy() is not None
        if egress == "browser":
            return self._browser is not None
        return False

    def egress_status(self, now: datetime) -> dict[str, str | None]:
        """Per exit: ``unconfigured``, else what this process has seen (``None`` = nothing yet)."""
        out: dict[str, str | None] = {}
        for egress in ("direct", "api", "relay", "browser", "bridge"):
            if not self.egress_configured(egress):
                out[egress] = "unconfigured"
            else:
                stats = self.egress_stats.get(egress)
                out[egress] = stats.status(now) if stats else None
        return out

    def evimed_status(self) -> str:
        """The team's EviMed API: unconfigured without a key; else by the last answer it gave."""
        if not self._settings.secret("evimed_api_key"):
            return "unconfigured"
        if self.evimed_last_status is None:
            return "ok"
        status = self.evimed_last_status[0]
        if 200 <= status < 300:
            return "ok"
        if status in (401, 403):
            return "down"
        return "degraded"

    def _client_for(self, host: str) -> httpx.AsyncClient:
        client = self._clients.get(host)
        if client is not None:
            self._clients.move_to_end(host)
            return client
        client = httpx.AsyncClient(
            transport=self._transport_factory() if self._transport_factory else None,
            timeout=httpx.Timeout(self._settings.request_timeout_s, connect=10.0),
            follow_redirects=False,
            trust_env=False,
            limits=httpx.Limits(max_connections=2, max_keepalive_connections=1, keepalive_expiry=30.0),
        )
        self._clients[host] = client
        while len(self._clients) > MAX_CLIENTS:
            _, old = self._clients.popitem(last=False)
            task = asyncio.get_running_loop().create_task(old.aclose())
            self._closing.add(task)
            task.add_done_callback(self._closing.discard)
        return client

    def _relay_client_for(self, proxy: EdgeProxy) -> httpx.AsyncClient:
        """One client for the relay, rebuilt when the proxy or its credentials change (rotation)."""
        key = (proxy.url, proxy.username, proxy.password)
        if self._relay_client is not None and self._relay_key == key:
            return self._relay_client
        if self._relay_client is not None:
            task = asyncio.get_running_loop().create_task(self._relay_client.aclose())
            self._closing.add(task)
            task.add_done_callback(self._closing.discard)
        context = self._relay_ssl_context
        proxy_spec = (httpx.Proxy(proxy.url, auth=(proxy.username, proxy.password), ssl_context=context) if context
                      else httpx.Proxy(proxy.url, auth=(proxy.username, proxy.password)))
        self._relay_client = httpx.AsyncClient(
            proxy=proxy_spec, verify=context if context else True, trust_env=False, follow_redirects=False,
            timeout=httpx.Timeout(self._settings.request_timeout_s, connect=proxy.connect_timeout_s),
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=4, keepalive_expiry=30.0),
        )
        self._relay_key = key
        return self._relay_client

    # ---------------------------------------------------------------- public API

    async def fetch(self, spec: RequestSpec, *, source_id: str | None = None, egress: str = "direct",
                    allowed_hosts: Sequence[str] | None = None, wait_for: str | None = None) -> FetchResult:
        return await self._fetch(spec, egress=egress, allowed_hosts=allowed_hosts, robots_file=False, wait_for=wait_for)

    async def _fetch(self, spec: RequestSpec, *, egress: str, allowed_hosts: Sequence[str] | None,
                     robots_file: bool, wait_for: str | None = None) -> FetchResult:
        if egress not in IMPLEMENTED_EGRESSES or not self.egress_configured(egress):
            raise FetchError("blocked", "egress_unavailable")
        method = spec.method.upper()
        if method not in ("GET", "POST", "HEAD"):
            raise FetchError("blocked", "method_not_allowed")
        first = _check_url(spec.url)
        if allowed_hosts and not host_allowed(first.hostname or "", allowed_hosts):
            raise FetchError("blocked", "host_not_allowed")
        if egress == "browser":
            return await self._fetch_browser(spec, first, allowed_hosts, robots_file, wait_for)
        url, body = spec.url, spec.body
        headers = {k: v for k, v in (spec.headers or {}).items() if k.lower() not in HEADERS_NEVER_FROM_ADAPTERS}
        exchange = self._exchange_relay if egress == "relay" else self._exchange
        for hop in range(self._settings.max_redirects + 1):
            parts = _check_url(url)
            host = (parts.hostname or "").lower()
            if not spec.api:
                allowed, delay, unreachable = await self._robots_by_egress[egress].check(url)
                self._budget.observe_crawl_delay(host, delay)
                if not allowed:
                    raise FetchError("robots-denied", "robots_unreachable" if unreachable else "robots_disallow")
            async with self._budget.slot(host, robots=robots_file):
                response_status, response_headers, content, final_url = await self._counted(
                    egress, exchange(method, url, headers, body, host, api=spec.api))
            if host == EVIMED_API_HOST and (parts.path or "").startswith(EVIMED_API_PREFIX):
                self.evimed_last_status = (_evimed_envelope_code(response_status, content), self._clock())
            if response_status in (301, 302, 303, 307, 308) and "location" in response_headers:
                if hop >= self._settings.max_redirects:
                    raise FetchError("http-error", "too_many_redirects", status=response_status)
                target = urljoin(url, response_headers["location"])
                next_host = (urlsplit(target).hostname or "").lower()
                if next_host != host:
                    target = without_credentials(target)
                    headers = {k: v for k, v in headers.items() if k.lower() not in ("if-none-match", "if-modified-since")}
                if response_status in (301, 302, 303) and method != "HEAD":
                    method, body = "GET", None
                url = target
                continue
            return await self._result(spec, response_status, response_headers, content, url)
        raise FetchError("http-error", "too_many_redirects")

    async def _counted(self, egress: str, operation):
        """Run one exchange and count its transport outcome for the exit's health."""
        stats = self.egress_stats.setdefault(egress, EgressStats())
        try:
            value = await operation
        except FetchError as error:
            if error.detail in TRANSPORT_FAILURES or error.outcome == "timeout":
                stats.attempts += 1
                stats.failures += 1
                stats.last_failure_at = self._clock()
                stats.last_detail = error.detail
            raise
        stats.attempts += 1
        stats.last_ok_at = self._clock()
        return value

    # ---------------------------------------------------------------- credentials in headers

    def _credential_headers(self, parts) -> dict[str, str]:
        """The EviMed evidence API: ``Authorization: Bearer <key>`` on its API path only, as the
        platform's ``publicSourceGateway.mjs`` (``evimed-evidence``) sends it. No key configured →
        refused before anything is sent (a request without a key is a certain 401)."""
        host = (parts.hostname or "").lower()
        if host == EVIMED_API_HOST and (parts.path or "").startswith(EVIMED_API_PREFIX):
            key = self._settings.secret("evimed_api_key")
            if not key:
                raise FetchError("blocked", "evimed_api_key_unconfigured")
            return {"Authorization": f"Bearer {key}"}
        return {}

    # ---------------------------------------------------------------- one hop, direct

    async def _exchange(self, method: str, url: str, headers: dict, body: bytes | None, host: str, *,
                        api: bool) -> tuple[int, dict, bytes, str]:
        parts = urlsplit(url)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        credentials = self._credential_headers(parts)
        try:
            addresses = await self._resolver(host, port)
        except (OSError, UnicodeError):
            raise FetchError("http-error", "dns_failed") from None
        if not addresses:
            raise FetchError("http-error", "dns_failed")
        if not all(is_public_address(a) for a in addresses):
            raise FetchError("blocked", "private_address")
        wire_url = with_credentials(url, self._settings)
        wire = urlsplit(wire_url)
        host_header = host if parts.port in (None, 443 if parts.scheme == "https" else 80) else f"{host}:{parts.port}"
        request_headers = {
            "User-Agent": user_agent(self._settings.contact_email()),
            "Accept": ACCEPT,
            "Accept-Language": ACCEPT_LANGUAGE,
            **headers,
            **credentials,
            "Host": host_header,
        }
        client = self._client_for(host)
        deadline = self._budget.timeout_s(host, self._settings.request_timeout_s)
        last_error: FetchError | None = None
        for address in addresses[:2]:
            ip_host = f"[{address}]" if ":" in address else address
            target = urlunsplit((wire.scheme, f"{ip_host}:{port}", wire.path or "/", wire.query, ""))
            extensions = {"sni_hostname": host} if wire.scheme == "https" else {}
            try:
                async with asyncio.timeout(deadline):
                    request = client.build_request(method, target, headers=request_headers, content=body, extensions=extensions)
                    response = await client.send(request, stream=True)
                    try:
                        content = await self._read_capped(response)
                    finally:
                        await response.aclose()
                client.cookies.clear()
                return response.status_code, {k.lower(): v for k, v in response.headers.items()}, content, url
            except TimeoutError:
                raise FetchError("timeout", "timeout") from None
            except httpx.TimeoutException:
                raise FetchError("timeout", "timeout") from None
            except httpx.ConnectError as error:
                last_error = FetchError("http-error", "tls_failed" if "SSL" in str(error) or "certificate" in str(error).lower() else "connect_failed")
                continue
            except httpx.HTTPError as error:
                raise FetchError("http-error", "transport_" + type(error).__name__.lower()) from None
        raise last_error or FetchError("http-error", "connect_failed")

    # ---------------------------------------------------------------- one hop, through the Tokyo node

    async def _exchange_relay(self, method: str, url: str, headers: dict, body: bytes | None, host: str, *,
                              api: bool) -> tuple[int, dict, bytes, str]:
        """A request through the TLS forward proxy. The node resolves the name (a Beijing answer
        would say nothing about Tokyo's) and refuses private destinations itself; what can be
        refused here is refused here: an IP-literal private target never reaches the proxy."""
        proxy = self._settings.edge_proxy()
        if proxy is None:
            raise FetchError("blocked", "egress_unavailable")
        literal = _ip_literal(host)
        if (literal is not None and not is_public_address(literal)) or host == "localhost" or host.endswith(".localhost"):
            raise FetchError("blocked", "private_address")
        parts = urlsplit(url)
        credentials = self._credential_headers(parts)
        wire_url = with_credentials(url, self._settings)
        request_headers = {
            "User-Agent": user_agent(self._settings.contact_email()),
            "Accept": ACCEPT,
            "Accept-Language": ACCEPT_LANGUAGE,
            **headers,
            **credentials,
        }
        client = self._relay_client_for(proxy)
        # every new tunnel pays two extra TLS handshakes, 1-2 s (edgeProxy.mjs, measured 2026-09-22)
        deadline = self._budget.timeout_s(host, self._settings.request_timeout_s) + proxy.connect_timeout_s
        try:
            async with asyncio.timeout(deadline):
                request = client.build_request(method, wire_url, headers=request_headers, content=body)
                response = await client.send(request, stream=True)
                try:
                    content = await self._read_capped(response)
                finally:
                    await response.aclose()
            client.cookies.clear()
            return response.status_code, {k.lower(): v for k, v in response.headers.items()}, content, url
        except (TimeoutError, httpx.TimeoutException):
            raise FetchError("timeout", "timeout") from None
        except httpx.ProxyError as error:
            status = _proxy_error_status(error)
            if status == 403:
                # the node's policy refuses this destination: the source is unreachable this way
                raise FetchError("blocked", "edge_proxy_destination_refused", status=403) from None
            if status in (502, 503, 504):
                raise FetchError("http-error", "relay_upstream_unreachable", status=status) from None
            raise FetchError("blocked", "edge_proxy_refused", status=status) from None
        except httpx.ConnectError:
            if await self._proxy_reachable(proxy):
                raise FetchError("http-error", "relay_upstream_unreachable") from None
            raise FetchError("blocked", "edge_proxy_unreachable") from None
        except httpx.HTTPError as error:
            raise FetchError("http-error", "transport_" + type(error).__name__.lower()) from None

    async def _proxy_reachable(self, proxy: EdgeProxy) -> bool:
        """Tell a dead node from a dead upstream behind it: can we complete TLS to the node itself?"""
        parts = urlsplit(proxy.url)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        context = None
        if parts.scheme == "https":
            context = self._relay_ssl_context or ssl.create_default_context()
        try:
            async with asyncio.timeout(proxy.connect_timeout_s):
                _, writer = await asyncio.open_connection(parts.hostname, port, ssl=context,
                                                          server_hostname=parts.hostname if context else None)
            writer.close()
            return True
        except (OSError, TimeoutError, ssl.SSLError):
            return False

    # ---------------------------------------------------------------- one page, through the browser

    async def _fetch_browser(self, spec: RequestSpec, first, allowed_hosts: Sequence[str] | None, robots_file: bool,
                             wait_for: str | None) -> FetchResult:
        host = (first.hostname or "").lower()
        hosts = list(allowed_hosts or [host])
        if not spec.api and not robots_file:
            allowed, delay, unreachable = await self._robots_by_egress["browser"].check(spec.url)
            self._budget.observe_crawl_delay(host, delay)
            if not allowed:
                raise FetchError("robots-denied", "robots_unreachable" if unreachable else "robots_disallow")
        async with self._budget.slot(host, robots=robots_file):
            status, headers, content, final_url = await self._counted(
                "browser", self._browser.render(spec, allowed_hosts=hosts, wait_for=wait_for, text=robots_file))
        if len(content) > self._settings.max_body_bytes:
            raise FetchError("too-large", "body_over_cap", status=status, bytes_read=len(content))
        return await self._result(spec, status, headers, content, final_url, rendered_passed=rendered_passed(status, headers, content))

    async def _read_capped(self, response: httpx.Response) -> bytes:
        cap = self._settings.max_body_bytes
        declared = response.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > cap:
            raise FetchError("too-large", "content_length_over_cap", status=response.status_code)
        chunks: list[bytes] = []
        size = 0
        async for chunk in response.aiter_bytes():
            size += len(chunk)
            if size > cap:
                raise FetchError("too-large", "body_over_cap", status=response.status_code, bytes_read=size)
            chunks.append(chunk)
        return b"".join(chunks)

    async def _result(self, spec: RequestSpec, status: int, headers: dict, content: bytes, url: str, *,
                      rendered_passed: bool = False) -> FetchResult:
        now = self._clock()
        final_url = without_credentials(url)
        host = (urlsplit(url).hostname or "").lower()
        content_type = headers.get("content-type", "").lower()
        if status == 304:
            return FetchResult(request=spec, final_url=final_url, status=304, headers=headers, body=b"",
                               fetched_at=now, not_modified=True)
        if status == 429 or (status == 503 and headers.get("retry-after")):
            wait = retry_after_seconds(headers.get("retry-after"), now) or DEFAULT_PAUSE_S
            await self._budget.pause(host, wait, f"http_{status}")
            raise FetchError("http-error", f"rate_limited_{status}", status=status, retry_after_s=wait, final_url=final_url)
        if spec.api and status == 404 and content.strip():
            # openFDA answers a search with zero matches as 404 {"error": {"code": "NOT_FOUND"}}: for
            # an API that is "nothing in the window", which only the adapter can tell from a real 404,
            # so API 404s with a body go to parse (which raises FetchError for a real failure).
            return FetchResult(request=spec, final_url=final_url, status=404, headers=headers, body=content, fetched_at=now)
        challenge = None if rendered_passed else detect_challenge(status, content_type, content, api=spec.api)
        if challenge:
            raise FetchError("challenge", challenge, status=status, final_url=final_url, bytes_read=len(content))
        if status in (401, 403, 451):
            raise FetchError("blocked", f"http_{status}", status=status, final_url=final_url)
        if status < 200 or status >= 300:
            raise FetchError("http-error", f"http_{status}", status=status, final_url=final_url)
        if status == 204 or not content.strip():
            raise FetchError("empty", "empty_body", status=status, final_url=final_url)
        return FetchResult(request=spec, final_url=final_url, status=status, headers=headers, body=content, fetched_at=now)

    # ---------------------------------------------------------------- robots.txt through the same exit

    async def _fetch_robots(self, origin: str, egress: str = "direct") -> tuple[int | None, str | None]:
        spec = RequestSpec(url=origin + "/robots.txt", conditional=False, api=True)
        try:
            result = await self._fetch(spec, egress=egress, allowed_hosts=None, robots_file=True)
        except FetchError as error:
            if error.status is not None and 400 <= error.status < 500 and error.outcome in ("http-error", "blocked"):
                return error.status, None
            if error.outcome == "empty":
                return 200, ""
            if error.outcome == "challenge" and error.status is not None and 400 <= error.status < 500:
                return error.status, None
            return None, None
        text = result.body[:512 * 1024].decode("utf-8", "replace")
        if looks_like_html(result.headers.get("content-type", ""), result.body):
            return 404, None      # an HTML page served as robots.txt is a soft 404
        return result.status, text


def _check_url(url: str):
    try:
        parts = urlsplit(url)
    except ValueError:
        raise FetchError("blocked", "invalid_url") from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise FetchError("blocked", "invalid_url")
    if parts.username or parts.password:
        raise FetchError("blocked", "userinfo_in_url")
    return parts
