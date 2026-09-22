"""The ``browser`` egress: pages drawn in script, read through a headless Chromium over CDP.

Why a browser at all (plan 10.2.6): Chinese regulators (NMPA, CDE, CMDE, NHC) sit behind Ruishu,
which answers a plain request with a 412/202 script page and only lets a real browser that ran its
script through. Measured 2026-09-22 from Beijing: an ordinary Chromium container got every list
(1–5 s a page); plain requests got the script page from both vantage points. Nothing here fights a
challenge that a real browser does not pass by itself: no fingerprint games, no CAPTCHA solving.

How it is wired:

- The browser is the ``frontier-browser`` container (the platform runtime image's Chromium),
  reached with Playwright's ``connect_over_cdp`` — the client library only; no browser is
  downloaded into the plugin image. Chromium's DevTools endpoint refuses any ``Host`` header that is
  not an IP address or ``localhost`` ("Host header is specified and is not an IP address or
  localhost", Chrome 145 measured 2026-09-22), so the plugin resolves the service name itself and
  connects by IP. New-headless Chrome also ignores ``--remote-debugging-address`` and listens on
  127.0.0.1 only, which is why the container runs a small TCP forwarder in front of it (see
  ``deploy/web/docker-compose.knowledge.yml``).
- One browser context per poll, closed afterwards: no cookie, cache or storage carries from one
  source to the next. Service workers are blocked, downloads refused.
- Every request the page makes is routed through ``allowed_hosts``: the source's own hosts (and
  their subdomains) continue, anything else — trackers, CDNs the list does not need, and every
  private or loopback address — is aborted. The page's script cannot reach the internal network.
- The poll waits for the list selector (``config.wait_for``, else ``config.selectors.item``); a
  Ruishu page reloads itself once its script has run, so the answer that counts is the LAST
  main-frame document response, and the body is the rendered DOM re-encoded as UTF-8 for the
  html-list parser.
- Concurrency 1: one page at a time (the container has 1 GB; the plan's 240 pages a day take ten
  minutes in total).
"""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import logging
import re
import socket
import sys
from typing import Any, Iterable
from urllib.parse import urlsplit, urlunsplit

from .model import FetchError, RequestSpec

log = logging.getLogger("knowledge_plugin.browser")

NAVIGATION_TIMEOUT_S = 45.0
SELECTOR_TIMEOUT_S = 25.0
IDLE_TIMEOUT_S = 8.0
SETTLED_VISIBLE_CHARS = 300
NETWORK_SCHEMES = ("http", "https", "ws", "wss")
# How a render ended, reported to the fetcher in a pseudo-header of the returned headers (the render
# signature stays a 4-tuple): the fetcher's vendor-marker test must not judge a page whose list was
# found — Ruishu leaves its inline script in the DOM of a page that PASSED (CDE, 2026-09-22).
RENDER_HEADER = "x-evimed-render"
RENDER_SELECTOR_FOUND = "selector-found"
RENDER_SELECTOR_MISSING = "selector-missing"
RENDER_NO_SELECTOR = "no-selector"


def host_is_allowed(host: str, allowed: Iterable[str]) -> bool:
    host = (host or "").lower().rstrip(".")
    return any(host == a or host.endswith("." + a) for a in (h.lower().rstrip(".") for h in allowed))


def _private_literal(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return host in ("localhost",) or host.endswith(".localhost")
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return not ip.is_global


def request_allowed(url: str, allowed_hosts: Iterable[str]) -> bool:
    """The route rule: data/blob/about stay in the page; network requests only to allowed hosts."""
    parts = urlsplit(url)
    if parts.scheme in ("data", "blob", "about"):
        return True
    if parts.scheme not in NETWORK_SCHEMES:
        return False
    host = (parts.hostname or "").lower()
    if not host or _private_literal(host):
        return False
    return host_is_allowed(host, allowed_hosts)


async def resolve_cdp_endpoint(cdp_url: str) -> str:
    """``http://frontier-browser:9222`` → ``http://172.19.0.3:9222``: Chromium only answers an IP Host."""
    parts = urlsplit(cdp_url)
    host = parts.hostname or ""
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        ipaddress.ip_address(host)
        return cdp_url.rstrip("/")
    except ValueError:
        pass
    if host == "localhost":
        address = "127.0.0.1"
    else:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
        v4 = [info[4][0] for info in infos if info[0] == socket.AF_INET]
        address = (v4 or [infos[0][4][0]])[0]
    netloc = f"[{address}]:{port}" if ":" in address else f"{address}:{port}"
    return urlunsplit((parts.scheme, netloc, parts.path.rstrip("/"), "", ""))


class BrowserFetcher:
    """Render pages through the shared headless Chromium (see module docstring)."""

    def __init__(self, cdp_url: str, *, timeout_s: float = 60.0, user_agent_suffix: str | None = None) -> None:
        self._cdp_url = cdp_url
        self._timeout_s = timeout_s
        self._suffix = user_agent_suffix
        self._gate = asyncio.Semaphore(1)
        self._playwright: Any = None
        self._browser: Any = None
        self._user_agent: str | None = None

    async def aclose(self) -> None:
        browser, playwright = self._browser, self._playwright
        self._browser = self._playwright = None
        if browser is not None:
            try:
                await browser.close()
            except Exception as error:  # already gone: nothing to release
                log.debug("browser close: %s", type(error).__name__)
        if playwright is not None:
            await playwright.stop()

    async def _connect(self):
        if self._browser is not None and self._browser.is_connected():
            return self._browser
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise FetchError("blocked", "browser_unreachable") from None
        if self._playwright is None:
            self._playwright = await async_playwright().start()
        try:
            endpoint = await resolve_cdp_endpoint(self._cdp_url)
            self._browser = await self._playwright.chromium.connect_over_cdp(endpoint, timeout=15_000)
        except Exception as error:
            log.warning("browser endpoint unreachable (%s)", type(error).__name__)
            self._browser = None
            raise FetchError("blocked", "browser_unreachable") from None
        version = self._browser.version or ""
        major = version.split(".")[0] if version else "0"
        agent = (f"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
                 f"Chrome/{major}.0.0.0 Safari/537.36")
        # Honest identity inside a real browser: the page sees a Chrome it can run its script in,
        # and the log on the other side still says who is reading and how to reach us.
        self._user_agent = f"{agent} {self._suffix}" if self._suffix else agent
        return self._browser

    async def render(self, spec: RequestSpec, *, allowed_hosts: Iterable[str], wait_for: str | None,
                     text: bool = False) -> tuple[int, dict, bytes, str]:
        """(status, lower-case headers, body, final URL) of the rendered page; raises ``FetchError``.

        ``text=True`` returns the document's text (robots.txt) instead of the DOM.
        """
        allowed = [h for h in allowed_hosts if h]
        if not request_allowed(spec.url, allowed):
            raise FetchError("blocked", "host_not_allowed")
        async with self._gate:
            browser = await self._connect()
            try:
                async with asyncio.timeout(self._timeout_s):
                    return await self._render_in_context(browser, spec, allowed, wait_for, text)
            except TimeoutError:
                raise FetchError("timeout", "timeout") from None
            except FetchError:
                raise
            except Exception as error:
                # Whatever else the driver throws is a failed poll with a name, not an exception that
                # ends the caller (the production probe died on one, 2026-09-22).
                log.warning("browser render failed on %s: %s", urlsplit(spec.url).hostname, type(error).__name__)
                raise FetchError("http-error", "browser_render_failed") from None

    async def _render_in_context(self, browser, spec: RequestSpec, allowed: list[str], wait_for: str | None,
                                 text: bool) -> tuple[int, dict, bytes, str]:
        context = await browser.new_context(user_agent=self._user_agent, locale="zh-CN", service_workers="block",
                                            accept_downloads=False, java_script_enabled=True)
        blocked: list[str] = []
        documents: list[Any] = []
        try:
            async def route(route_):
                if request_allowed(route_.request.url, allowed):
                    await route_.continue_()
                else:
                    blocked.append(urlsplit(route_.request.url).hostname or "?")
                    await route_.abort("blockedbyclient")

            await context.route("**/*", route)
            page = await context.new_page()

            def on_response(response):
                try:
                    if response.request.resource_type == "document" and response.frame == page.main_frame:
                        documents.append(response)
                except Exception as error:  # a frame detached mid-navigation: that response is not the page
                    log.debug("response bookkeeping: %s", type(error).__name__)

            page.on("response", on_response)
            try:
                await page.goto(spec.url, wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_S * 1000)
            except Exception as error:
                name = type(error).__name__
                if "Timeout" in name:
                    raise FetchError("timeout", "navigation_timeout") from None
                message = str(error)
                if "ERR_BLOCKED_BY_CLIENT" in message:
                    raise FetchError("blocked", "host_not_allowed") from None
                if "ERR_NAME_NOT_RESOLVED" in message:
                    raise FetchError("http-error", "dns_failed") from None
                raise FetchError("http-error", "navigation_failed") from None
            if text:
                body = (await self._settled_text(page, urlsplit(spec.url).hostname)).encode("utf-8")
                state = RENDER_NO_SELECTOR
            else:
                html, found = await self._settled_content(page, wait_for, urlsplit(spec.url).hostname)
                body = html.encode("utf-8")
                state = RENDER_NO_SELECTOR if not wait_for else (RENDER_SELECTOR_FOUND if found else RENDER_SELECTOR_MISSING)
            last = documents[-1] if documents else None
            status = last.status if last is not None else 200
            headers = {k.lower(): v for k, v in (last.headers.items() if last is not None else [])}
            content_type = headers.get("content-type", "text/plain") if text else "text/html; charset=utf-8"
            headers = {k: v for k, v in headers.items() if k not in ("content-length", "content-encoding", "transfer-encoding")}
            headers["content-type"] = content_type
            headers[RENDER_HEADER] = state
            if blocked:
                log.debug("aborted %s off-list request(s) on %s", len(blocked), urlsplit(spec.url).hostname)
            return status, headers, body, page.url
        finally:
            await context.close()


    @staticmethod
    async def _settle(page, wait_for: str | None) -> bool:
        """Wait for the list (or, without a selector, for the network to go quiet), then for the load
        to finish. Returns False when the selector never appeared."""
        found = True
        if wait_for:
            try:
                await page.wait_for_selector(wait_for, state="attached", timeout=SELECTOR_TIMEOUT_S * 1000)
            except Exception as error:
                found = False
                log.info("selector not found (%s)", type(error).__name__)
        else:
            try:
                await page.wait_for_load_state("networkidle", timeout=IDLE_TIMEOUT_S * 1000)
            except Exception as error:  # a page that never goes idle is read as it stands
                log.debug("networkidle: %s", type(error).__name__)
        try:
            await page.wait_for_load_state("load", timeout=10_000)
        except Exception as error:
            log.debug("load: %s", type(error).__name__)
        return found

    async def _settled_text(self, page, host: str | None) -> str:
        """The page's visible text once it has settled — the robots.txt of a Ruishu site among them.
        The same self-reload that ``_settled_content`` rides out destroys the execution context under
        ``evaluate``; in production (2026-09-22, NMPA's robots.txt) that escaped as an exception and
        ended the poll. Three tries, then a named failure, never an exception from the driver."""
        for _ in range(3):
            await self._settle(page, None)
            try:
                return await page.evaluate("document.body ? document.body.innerText : ''")
            except Exception as error:          # "execution context was destroyed": a navigation won
                log.debug("text during navigation on %s: %s", host, type(error).__name__)
                await asyncio.sleep(1.0)
        raise FetchError("http-error", "navigation_interrupted")

    async def _settled_content(self, page, wait_for: str | None, host: str | None) -> tuple[str, bool]:
        """The rendered DOM once it has settled. Ruishu serves a script page first and reloads once
        its script has run, so a selector can match on the document that is about to be replaced and
        ``content()`` can land mid-navigation (seen live on NMPA, 2026-09-22): re-check on the final
        document and capture again when a navigation interrupts or the text is still near-empty. What
        never settles is handed over as it is — the challenge detector or the parser decides."""
        html, found = "", False
        for _ in range(3):
            found = await self._settle(page, wait_for)
            try:
                html = await page.content()
            except Exception as error:          # "execution context was destroyed": a navigation won
                log.debug("content during navigation on %s: %s", host, type(error).__name__)
                await asyncio.sleep(1.0)
                continue
            if not found or _visible_text_length(html) >= SETTLED_VISIBLE_CHARS:
                return html, found
            await asyncio.sleep(1.5)
        if wait_for and found:
            try:                                 # the list must be in the document handed over
                found = await page.query_selector(wait_for) is not None
            except Exception as error:
                log.debug("final selector check on %s: %s", host, type(error).__name__)
                found = False
        return html, found


_SCRIPTS = re.compile(r"<(script|style|noscript)[^>]*>.*?</\1\s*>", re.I | re.S)
_TAGS = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"\s+")


def _visible_text_length(html: str) -> int:
    return len(_SPACE.sub("", _TAGS.sub(" ", _SCRIPTS.sub(" ", html))))


# ------------------------------------------------------------------ a fixture helper for the readers


async def _render_cli(url: str, cdp: str, hosts: list[str], wait_for: str | None) -> int:
    fetcher = BrowserFetcher(cdp, user_agent_suffix="EviMedBot/1.0 (+https://www.evimed.com; knowledge-source monitor)")
    try:
        status, headers, body, final_url = await fetcher.render(RequestSpec(url=url), allowed_hosts=hosts or [urlsplit(url).hostname],
                                                                  wait_for=wait_for)
    except FetchError as error:
        print(f"render failed: {error.outcome} {error.detail}", file=sys.stderr)
        return 1
    finally:
        await fetcher.aclose()
    print(f"status {status}, {len(body)} bytes, final {final_url}", file=sys.stderr)
    sys.stdout.buffer.write(body)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m knowledge_plugin.browser",
                                     description="Render one page the way the browser egress does (fixtures).")
    sub = parser.add_subparsers(dest="command", required=True)
    render = sub.add_parser("render", help="print the rendered DOM of a URL to stdout")
    render.add_argument("url")
    render.add_argument("--cdp", default="http://127.0.0.1:9222")
    render.add_argument("--allowed-host", action="append", default=[], help="repeatable; default: the URL's host")
    render.add_argument("--wait", default=None, help="CSS selector to wait for")
    args = parser.parse_args(argv)
    return asyncio.run(_render_cli(args.url, args.cdp, args.allowed_host, args.wait))


if __name__ == "__main__":
    sys.exit(main())
