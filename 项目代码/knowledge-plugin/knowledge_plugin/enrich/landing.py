"""The landing page for ``/text``: read the article's own page when no index has its abstract, or for its open text.

**Where the page is.** The DOI's handle record names it (``GET https://doi.org/api/handles/<doi>?type=URL``, an API
answer, no robots.txt); when the record cannot be read the page is asked at ``https://doi.org/<doi>`` and the redirects
are followed hop by hop (robots.txt and the host budget at every hop — the fetcher's rules). Elsevier's handle names
``linkinghub.elsevier.com``, whose page names its target in a hidden ``redirectURL`` field; that address is read next.

**Which page.** Every request says ``Accept: text/html``. The fetcher's default ``Accept`` prefers JSON, and doi.org
answers a JSON preference with Crossref's metadata record: on 2026-10-22 all 83 sample DOIs read "through the landing
page" from Beijing came back as Crossref JSON (status 200, no abstract), which had read as consent or app shells. With
``text/html`` the same Nature, Springer, BMC, BMJ and Frontiers pages give their abstracts through the direct exit.

**Which exit.** The source's own exit first, then the Tokyo ``relay``, then the ``browser``, each only when this
deployment has it, moving on only when the page answered with a challenge (``challenge``), a refusal (401/403) or a shell
that names no article. A challenge that remains is the answer (``landing_challenge``) — nothing here tries to get round
one: no other identity, no fingerprint games, no solving. robots.txt refusing the page ends the read
(``landing_robots``); so does a 404. A timeout or a 5xx is noted and not retried here (the entry is asked again on its
own schedule). An exit that met a challenge or a refusal at a host is not tried at that host again for
``VERDICT_TTL_S`` (``HostVerdicts``, per process): on 2026-10-22 JAMA, NEJM, OUP, Wiley, AAP, ASH, AACR, ASCO, the AAN,
CMAJ, PNAS and ACP challenged every exit and the Elsevier hosts refused even the browser, so asking each of their
articles again would cost their servers and our browser (one page at a time) for nothing.

**What is read off it** is ``article_html.read_article_page``'s: the abstract, an excerpt, the whole open text, the
licence.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import quote, unquote, urljoin, urlsplit

from selectolax.parser import HTMLParser

from ..adapters.base import decode_body
from ..model import FetchError
from .article_html import ArticlePage, read_article_page
from .common import Attempt, Endpoints, Trace, get

ACCEPT_HTML = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"
LADDER = ("direct", "relay", "browser")
VERDICT_TTL_S = 24 * 3600
BROWSER_MIN_LEFT_S = 70.0       # a render may take a minute; one that cannot finish in time is not started
MIN_ARTICLE_CHARS = 1_500       # an HTML answer with less visible text and no article metadata is a shell
_SECOND_LEVEL = frozenset({"co", "com", "org", "net", "ac", "gov", "edu", "or", "ne", "go"})


@dataclass
class HostVerdicts:
    """Hosts at which an exit met a challenge or a refusal, and until when that answer stands (module docstring)."""

    clock: Callable[[], float] = time.monotonic
    until: dict[tuple[str, str], float] = field(default_factory=dict)

    def refused(self, host: str, egress: str) -> bool:
        stamp = self.until.get((host, egress))
        return stamp is not None and self.clock() < stamp

    def record(self, host: str, egress: str) -> None:
        self.until[(host, egress)] = self.clock() + VERDICT_TTL_S


VERDICTS = HostVerdicts()


@dataclass(frozen=True)
class LandingRead:
    """``outcome``: ``read`` (the page was read; ``page`` says what it held), ``challenge``, ``blocked``, ``robots``,
    ``not_found``, ``transient``, ``deferred`` (no time left) or ``unreachable`` (no exit could ask)."""

    outcome: str
    page: ArticlePage | None = None
    url: str | None = None
    egress: str | None = None


def handle_url(endpoints: Endpoints, doi: str) -> str:
    return f"{endpoints.doi_handles}/{quote(doi, safe='/:;()._-')}?type=URL"


def site_hosts(*urls: str | None) -> list[str]:
    """The registrable domains of the URLs (``academic.oup.com`` → ``oup.com``), for the browser's allowed hosts."""
    out: list[str] = []
    for url in urls:
        host = (urlsplit(url).hostname or "").lower() if url else ""
        labels = [label for label in host.split(".") if label]
        if len(labels) < 2:
            continue
        keep = 3 if len(labels) >= 3 and len(labels[-1]) == 2 and labels[-2] in _SECOND_LEVEL else 2
        domain = ".".join(labels[-keep:])
        if domain not in out:
            out.append(domain)
    return out


def _host(url: str | None) -> str:
    return (urlsplit(url).hostname or "").lower() if url else ""


async def resolve(fetcher: Any, endpoints: Endpoints, doi: str, trace: Trace) -> str:
    """The landing page's address from the DOI's handle record, else the ``https://doi.org/<doi>`` redirect."""
    fallback = f"{endpoints.doi_resolver}/{quote(doi, safe='/:;()._-')}"
    attempt = await get(fetcher, handle_url(endpoints, doi))
    if attempt.result is None:
        trace.record(attempt, "doi_handle")
        return fallback
    if attempt.result.status != 200:
        trace.notes.append(f"doi_handle_http_{attempt.result.status}")
        return fallback
    try:
        payload = json.loads(attempt.result.body.decode("utf-8", errors="replace"))
    except ValueError:
        return fallback
    for value in payload.get("values") or [] if isinstance(payload, dict) else []:
        data = (value or {}).get("data") or {}
        target = data.get("value") if isinstance(data, dict) else None
        if (value or {}).get("type") == "URL" and isinstance(target, str) and target.startswith(("https://", "http://")):
            return target
    return fallback


def linkinghub_target(html_text: str, base: str) -> str | None:
    """The address Elsevier's linkinghub page forwards to (its hidden ``redirectURL`` field)."""
    node = HTMLParser(html_text).css_first('input[name="redirectURL"]')
    value = unquote(node.attributes.get("value") or "") if node is not None else ""
    target = urljoin(base, value) if value else ""
    return target if target.startswith(("https://", "http://")) else None


def _is_shell(page: ArticlePage, html_text: str) -> bool:
    if page.is_article or page.abstract or page.excerpt or page.body_text:
        return False
    tree = HTMLParser(html_text)
    for node in tree.css("script, style, noscript, template"):
        node.decompose()
    body = tree.body
    return len((body.text(separator=" ", strip=True) if body is not None else "")) < MIN_ARTICLE_CHARS


async def _read(fetcher: Any, url: str, *, egress: str, source_id: str | None, allowed: list[str]) -> Attempt:
    return await get(fetcher, url, api=False, source_id=source_id, egress=egress, headers={"Accept": ACCEPT_HTML},
                     allowed_hosts=allowed if egress == "browser" else None)


async def read_landing(fetcher: Any, endpoints: Endpoints, doi: str, *, egress: str, trace: Trace,
                       source_id: str | None = None, url: str | None = None, deadline: float | None = None,
                       verdicts: HostVerdicts | None = None, clock: Callable[[], float] = time.monotonic) -> LandingRead:
    """Read the article's landing page through the exit ladder (module docstring)."""
    verdicts = verdicts or VERDICTS
    start = url or await resolve(fetcher, endpoints, doi, trace)
    host = _host(start)
    first = "direct" if egress in ("direct", "api") else egress
    configured = getattr(fetcher, "egress_configured", None)
    if configured is None:                      # a fetcher that cannot say which exits it has: its own only
        ladder = [first]
    else:
        ladder = [e for e in [first] + [e for e in LADDER if e != first] if configured(e)]
    seen: list[str] = [start]
    refusals: list[str] = []
    for exit_ in ladder:
        if verdicts.refused(host, exit_):
            refusals.append("cached")
            continue
        left = None if deadline is None else deadline - clock()
        if left is not None and (left <= 5 or (exit_ == "browser" and left < BROWSER_MIN_LEFT_S)):
            trace.notes.append(f"landing_deferred:{exit_}")
            return LandingRead("deferred")
        target = start
        for _ in range(2):                      # the page, and once more for linkinghub's forward
            attempt = await _read(fetcher, target, egress=exit_, source_id=source_id, allowed=site_hosts(*seen))
            error: FetchError | None = attempt.error
            if attempt.result is not None and error is None:
                result = attempt.result
                if result.final_url and result.final_url not in seen:
                    seen.append(result.final_url)
                content_type = (result.headers or {}).get("content-type", "").lower()
                if result.status != 200 or (content_type and "html" not in content_type and "xml" not in content_type):
                    trace.notes.append(f"landing_http_{result.status}" if result.status != 200 else "landing_not_html")
                    return LandingRead("not_found", url=result.final_url, egress=exit_)
                html_text = decode_body(result)
                forward = linkinghub_target(html_text, result.final_url) if "linkinghub" in _host(result.final_url) else None
                if forward and forward not in seen:
                    seen.append(forward)
                    target = forward
                    continue
                page = read_article_page(html_text, result.final_url)
                if _is_shell(page, html_text):
                    trace.notes.append(f"landing_shell:{exit_}")
                    break
                return LandingRead("read", page=page, url=result.final_url, egress=exit_)
            assert error is not None
            if error.final_url and error.final_url not in seen:
                seen.append(error.final_url)
            if error.outcome == "robots-denied":
                trace.notes.append("landing_robots")
                return LandingRead("robots", egress=exit_)
            if error.detail == "egress_unavailable":
                break
            if error.outcome == "challenge" or (error.outcome == "blocked" and error.status in (401, 403)):
                verdicts.record(host, exit_)
                refusals.append(error.outcome)
                trace.notes.append(f"landing_{error.outcome}:{exit_}")
                break
            if error.status in (404, 410) or error.outcome == "blocked":
                trace.notes.append(f"landing_{error.outcome}:{error.detail}"[:120])
                return LandingRead("not_found", egress=exit_)
            trace.notes.append(f"landing_transient:{error.detail}"[:120])
            return LandingRead("transient", egress=exit_)
    if refusals:
        trace.notes.append("landing_challenge_cached" if set(refusals) == {"cached"} else "landing_challenge")
        return LandingRead("challenge")
    return LandingRead("unreachable")


__all__ = ["ACCEPT_HTML", "HostVerdicts", "LandingRead", "VERDICTS", "handle_url", "linkinghub_target", "read_landing",
           "resolve", "site_hosts"]
