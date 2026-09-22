"""The browser exit against a Chromium this test starts (headless, CDP on loopback).

Chromium resolves ``list.test`` and ``tracker.test`` to a local HTTP server (``--host-resolver-rules``),
so the page is "a site" and the tracker "another site": the list is drawn by script after a delay
(the Ruishu shape: nothing in the first HTML), and the page also asks the tracker for a pixel and a
beacon — which route interception must abort before they leave the browser.
"""

from __future__ import annotations

import http.server
import os
import shutil
import socket
import subprocess
import threading
import time
from dataclasses import replace
from pathlib import Path

import pytest

from knowledge_plugin.browser import BrowserFetcher, request_allowed
from knowledge_plugin.budget import HostBudget, MemoryCounterStore
from knowledge_plugin.fetch import ProtectedFetcher
from knowledge_plugin.model import FetchError, RequestSpec

CHROME = os.environ.get("KNOWLEDGE_PLUGIN_TEST_CHROME") or next(
    (str(p) for p in sorted(Path.home().glob(".cache/ms-playwright/chromium-*/chrome-linux*/chrome"))), "")

pytestmark = pytest.mark.skipif(not CHROME or not Path(CHROME).exists() or shutil.which("true") is None,
                                reason="no local Chromium to drive (set KNOWLEDGE_PLUGIN_TEST_CHROME)")

LIST_PAGE = """<!doctype html><html><head><title>List</title></head><body>
<ul id="list"></ul>
<img src="http://tracker.test:{port}/pixel.gif">
<script>
  fetch("http://tracker.test:{port}/beacon").catch(() => {{}});
  setTimeout(() => {{
    document.getElementById("list").innerHTML =
      '<li><a href="/item/1">First drawn item</a> <span>2026-09-22</span></li>' +
      '<li><a href="/item/2">Second drawn item</a> <span>2026-09-21</span></li>';
  }}, 400);
</script></body></html>"""


RUISHU_PAGE = """<!doctype html><html><head><title>R</title>
<script type="text/javascript" r="m">function _$tG(_$sP){return _$sP;} var $_ts = window['$_ts'] || {};</script></head>
<body><table><tbody id="rows"></tbody></table>
<script>if (DRAW) setTimeout(() => { document.getElementById("rows").innerHTML =
  '<tr><td>CXSL2300094</td><td>First breakthrough product</td><td>2026-09-18</td></tr>'.repeat(10)
  + '<tr><td colspan=3>' + 'A long line of visible table text for the list. '.repeat(40) + '</td></tr>'; }, 300);</script>
</body></html>"""


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class Site(http.server.ThreadingHTTPServer):
    def __init__(self):
        self.seen: list[tuple[str, str]] = []
        super().__init__(("127.0.0.1", 0), Handler)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        self.server.seen.append((host, self.path))
        port = self.server.server_address[1]
        if host == "list.test" and self.path == "/list":
            self._send(200, "text/html; charset=utf-8", LIST_PAGE.format(port=port).encode())
        elif host == "list.test" and self.path in ("/ruishu-passed", "/ruishu-stuck"):
            # the vendor's inline script stays in the DOM whether or not the page got through
            draw = "true" if self.path == "/ruishu-passed" else "false"
            page = (RUISHU_PAGE.replace("DRAW", draw)).encode()
            self._send(200, "text/html; charset=utf-8", page)
        elif host == "list.test" and self.path == "/robots.txt":
            self._send(200, "text/plain", b"User-agent: *\nDisallow: /private\n")
        elif host == "list.test" and self.path == "/private":
            self._send(200, "text/html", b"<html><body><p>not for crawlers</p></body></html>")
        else:
            self._send(404, "text/plain", b"no")

    def _send(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture(scope="module")
def site():
    server = Site()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()


@pytest.fixture(scope="module")
def chrome(tmp_path_factory):
    port = free_port()
    profile = tmp_path_factory.mktemp("chrome-profile")
    process = subprocess.Popen(
        [CHROME, "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", f"--remote-debugging-port={port}",
         f"--user-data-dir={profile}", "--no-first-run", "--host-resolver-rules=MAP list.test 127.0.0.1,MAP tracker.test 127.0.0.1",
         "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                break
        except OSError:
            time.sleep(0.2)
    yield f"http://127.0.0.1:{port}"
    process.terminate()
    process.wait(timeout=10)


class NoSleep:
    async def __call__(self, seconds):
        return None


def test_the_route_rule():
    assert request_allowed("https://www.nmpa.gov.cn/xxgk/ggtg/index.html", ["www.nmpa.gov.cn"])
    assert request_allowed("https://static.nmpa.gov.cn/a.js", ["nmpa.gov.cn"])
    assert request_allowed("data:image/png;base64,AAAA", ["x.org"])
    assert not request_allowed("https://tracker.example.com/p.gif", ["www.nmpa.gov.cn"])
    assert not request_allowed("http://10.0.0.8/admin", ["10.0.0.8"])            # private literals never, listed or not
    assert not request_allowed("http://localhost:8080/", ["localhost"])
    assert not request_allowed("file:///etc/passwd", ["x.org"])


async def test_a_list_drawn_in_script_is_awaited_and_off_list_requests_never_leave(chrome, site):
    fetcher = BrowserFetcher(chrome, timeout_s=30, user_agent_suffix="EviMedBot/1.0 (+https://www.evimed.com)")
    port = site.server_address[1]
    try:
        status, headers, body, final_url = await fetcher.render(
            RequestSpec(url=f"http://list.test:{port}/list"), allowed_hosts=["list.test"], wait_for="#list li")
    finally:
        await fetcher.aclose()
    html = body.decode("utf-8")
    assert status == 200 and "First drawn item" in html and "Second drawn item" in html
    assert headers["content-type"].startswith("text/html")
    assert final_url == f"http://list.test:{port}/list"
    assert not [path for host, path in site.seen if host == "tracker.test"]          # the pixel and the beacon were aborted


async def test_the_browser_exit_end_to_end_with_robots(chrome, site, plain_settings):
    settings = replace(plain_settings, browser_cdp_url=chrome, browser_timeout_s=30.0)
    fetcher = ProtectedFetcher(settings, HostBudget(MemoryCounterStore(), {}, sleep=NoSleep()))
    port = site.server_address[1]
    try:
        result = await fetcher.fetch(RequestSpec(url=f"http://list.test:{port}/list"), source_id="nmpa-like", egress="browser",
                                     allowed_hosts=["list.test"], wait_for="#list li")
        assert result.status == 200 and b"First drawn item" in result.body
        assert ("list.test", "/robots.txt") in site.seen                             # robots.txt read through the browser
        with pytest.raises(FetchError) as denied:
            await fetcher.fetch(RequestSpec(url=f"http://list.test:{port}/private"), egress="browser", allowed_hosts=["list.test"])
        assert denied.value.outcome == "robots-denied"
    finally:
        await fetcher.aclose()


async def test_an_unreachable_browser_is_refused_by_name(plain_settings):
    settings = replace(plain_settings, browser_cdp_url=f"http://127.0.0.1:{free_port()}")
    fetcher = ProtectedFetcher(settings, HostBudget(MemoryCounterStore(), {}, sleep=NoSleep()))
    try:
        with pytest.raises(FetchError) as refused:
            await fetcher.fetch(RequestSpec(url="https://www.nmpa.gov.cn/x", api=True), egress="browser")
        assert (refused.value.outcome, refused.value.detail) == ("blocked", "browser_unreachable")
    finally:
        await fetcher.aclose()



async def test_a_page_that_passed_is_read_even_with_the_vendor_script_still_in_it(chrome, site, plain_settings):
    settings = replace(plain_settings, browser_cdp_url=chrome, browser_timeout_s=40.0)
    fetcher = ProtectedFetcher(settings, HostBudget(MemoryCounterStore(), {}, sleep=NoSleep()))
    port = site.server_address[1]
    try:
        passed = await fetcher.fetch(RequestSpec(url=f"http://list.test:{port}/ruishu-passed"), egress="browser",
                                     allowed_hosts=["list.test"], wait_for="#rows tr")
        assert passed.status == 200 and b"First breakthrough product" in passed.body and b"_$tG(" in passed.body
        with pytest.raises(FetchError) as stuck:
            await fetcher.fetch(RequestSpec(url=f"http://list.test:{port}/ruishu-stuck"), egress="browser",
                                allowed_hosts=["list.test"], wait_for="#rows tr")
        assert (stuck.value.outcome, stuck.value.detail) == ("challenge", "ruishu")
    finally:
        await fetcher.aclose()
