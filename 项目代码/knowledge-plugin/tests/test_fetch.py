"""The protected transport, against a mock transport and a fake resolver (no network)."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path

import httpx
import pytest

from knowledge_plugin.budget import HostBudget, MemoryCounterStore
from knowledge_plugin.fetch import ProtectedFetcher, detect_challenge, is_empty_shell, is_public_address, redact_url, user_agent
from knowledge_plugin.model import FetchError, RequestSpec

PUBLIC = {"www.example.org": ["93.184.216.34"], "api.example.org": ["93.184.216.35"], "www.evimed.com": ["101.37.98.4"],
          "eutils.ncbi.nlm.nih.gov": ["130.14.29.110"], "other.example.net": ["151.101.1.69"],
          "rebind.example.org": ["93.184.216.36", "10.0.0.5"], "inside.example.org": ["192.168.1.10"]}
ARTICLE = ("<html><head><title>News</title></head><body>" + "<p>A long article paragraph about a new trial. </p>" * 40
           + "</body></html>").encode()


async def fake_resolver(host, port):
    if host not in PUBLIC:
        raise OSError("no such host")
    return PUBLIC[host]


class Upstream:
    """A scripted upstream: routes by (Host header, path)."""

    def __init__(self):
        self.routes: dict[tuple[str, str], object] = {}
        self.requests: list[httpx.Request] = []

    def route(self, host, path, response):
        self.routes[(host, path)] = response

    async def __call__(self, request: httpx.Request):
        self.requests.append(request)
        key = (request.headers["host"], request.url.path)
        handler = self.routes.get(key)
        if handler is None:
            if request.url.path == "/robots.txt":
                return httpx.Response(404, text="not found")
            return httpx.Response(404, text="no route")
        if callable(handler):
            result = handler(request)
            return await result if asyncio.iscoroutine(result) else result
        return handler


class NoSleep:
    async def __call__(self, seconds):
        return None


def make_fetcher(settings, upstream: Upstream, **overrides):
    budget = HostBudget(MemoryCounterStore(), {}, sleep=NoSleep())
    return ProtectedFetcher(replace(settings, **overrides), budget, resolver=fake_resolver,
                            transport_factory=lambda: httpx.MockTransport(upstream))


@pytest.fixture()
def upstream():
    return Upstream()


# ------------------------------------------------------------------ address policy


@pytest.mark.parametrize("address, public", [
    ("93.184.216.34", True), ("2606:2800:220:1:248:1893:25c8:1946", True),
    ("127.0.0.1", False), ("10.1.2.3", False), ("172.16.0.1", False), ("192.168.0.1", False),
    ("169.254.169.254", False), ("100.64.0.1", False), ("0.0.0.0", False), ("224.0.0.1", False),
    ("::1", False), ("fe80::1", False), ("fc00::1", False), ("::ffff:127.0.0.1", False), ("::ffff:10.0.0.1", False),
    ("2002:c000:0204::1", False), ("not-an-ip", False),
])
def test_is_public_address(address, public):
    assert is_public_address(address) is public


async def test_private_answers_are_refused(plain_settings, upstream):
    fetcher = make_fetcher(plain_settings, upstream)
    for url in ("https://inside.example.org/", "https://rebind.example.org/"):
        with pytest.raises(FetchError) as refused:
            await fetcher.fetch(RequestSpec(url=url, api=True))
        assert (refused.value.outcome, refused.value.detail) == ("blocked", "private_address")
    assert upstream.requests == []                      # nothing was sent anywhere
    await fetcher.aclose()


async def test_pinned_ip_with_host_and_sni(plain_settings, upstream):
    upstream.route("api.example.org", "/data", httpx.Response(200, json={"ok": True}))
    fetcher = make_fetcher(plain_settings, upstream)
    result = await fetcher.fetch(RequestSpec(url="https://api.example.org/data?x=1", api=True))
    sent = upstream.requests[-1]
    assert sent.url.host == "93.184.216.35"             # connected to the vetted address
    assert sent.headers["host"] == "api.example.org"     # HTTP Host is the name
    assert sent.extensions.get("sni_hostname") == "api.example.org"   # TLS verifies the name
    assert result.status == 200 and result.final_url == "https://api.example.org/data?x=1"
    assert sent.headers["user-agent"] == user_agent("crawler-contact@example.org")
    assert "EviMedBot/1.0" in sent.headers["user-agent"]
    await fetcher.aclose()


async def test_redirects_are_followed_by_hand_and_revetted(plain_settings, upstream):
    upstream.route("www.example.org", "/a", httpx.Response(301, headers={"location": "/b"}))
    upstream.route("www.example.org", "/b", httpx.Response(302, headers={"location": "https://other.example.net/c"}))
    upstream.route("other.example.net", "/c", httpx.Response(200, content=b'{"x": 1}', headers={"content-type": "application/json"}))
    fetcher = make_fetcher(plain_settings, upstream)
    result = await fetcher.fetch(RequestSpec(url="https://www.example.org/a", api=True))
    assert result.final_url == "https://other.example.net/c"
    upstream.route("www.example.org", "/private", httpx.Response(302, headers={"location": "https://inside.example.org/"}))
    with pytest.raises(FetchError) as refused:
        await fetcher.fetch(RequestSpec(url="https://www.example.org/private", api=True))
    assert refused.value.detail == "private_address"
    await fetcher.aclose()


async def test_redirect_limit(plain_settings, upstream):
    for n in range(10):
        upstream.route("www.example.org", f"/r{n}", httpx.Response(302, headers={"location": f"/r{n + 1}"}))
    fetcher = make_fetcher(plain_settings, upstream)
    with pytest.raises(FetchError) as refused:
        await fetcher.fetch(RequestSpec(url="https://www.example.org/r0", api=True))
    assert refused.value.detail == "too_many_redirects"
    assert len(upstream.requests) == 6                  # the first request and five redirects
    await fetcher.aclose()


async def test_body_cap_streams_and_aborts(plain_settings, upstream):
    upstream.route("api.example.org", "/big", httpx.Response(200, content=b"x" * 5000))
    fetcher = make_fetcher(plain_settings, upstream, max_body_bytes=1000)
    with pytest.raises(FetchError) as refused:
        await fetcher.fetch(RequestSpec(url="https://api.example.org/big", api=True))
    assert refused.value.outcome == "too-large"
    await fetcher.aclose()


async def test_timeout(plain_settings, upstream):
    async def slow(request):
        await asyncio.sleep(2)
        return httpx.Response(200, text="late")
    upstream.route("api.example.org", "/slow", slow)
    fetcher = make_fetcher(plain_settings, upstream, request_timeout_s=0.3)
    with pytest.raises(FetchError) as refused:
        await fetcher.fetch(RequestSpec(url="https://api.example.org/slow", api=True))
    assert refused.value.outcome == "timeout"
    await fetcher.aclose()


async def test_not_modified_and_rate_limit_pause(plain_settings, upstream):
    upstream.route("api.example.org", "/feed", httpx.Response(304))
    upstream.route("api.example.org", "/limited", httpx.Response(429, headers={"retry-after": "90"}))
    fetcher = make_fetcher(plain_settings, upstream)
    result = await fetcher.fetch(RequestSpec(url="https://api.example.org/feed", headers={"If-None-Match": '"abc"'}, api=True))
    assert result.not_modified and result.status == 304
    assert upstream.requests[-1].headers["if-none-match"] == '"abc"'
    with pytest.raises(FetchError) as limited:
        await fetcher.fetch(RequestSpec(url="https://api.example.org/limited", api=True))
    assert limited.value.detail == "rate_limited_429" and limited.value.retry_after_s == 90
    with pytest.raises(FetchError) as paused:                      # the whole host now waits
        await fetcher.fetch(RequestSpec(url="https://api.example.org/feed", api=True))
    assert paused.value.outcome == "host-budget" and paused.value.detail == "host_paused"
    await fetcher.aclose()


async def test_robots_apply_to_pages_not_to_apis(plain_settings, upstream):
    upstream.route("www.example.org", "/robots.txt", httpx.Response(200, text="User-agent: *\nDisallow: /news\n"))
    upstream.route("www.example.org", "/news", httpx.Response(200, content=ARTICLE, headers={"content-type": "text/html"}))
    fetcher = make_fetcher(plain_settings, upstream)
    with pytest.raises(FetchError) as denied:
        await fetcher.fetch(RequestSpec(url="https://www.example.org/news"))
    assert denied.value.outcome == "robots-denied"
    result = await fetcher.fetch(RequestSpec(url="https://www.example.org/news", api=True))
    assert result.status == 200
    await fetcher.aclose()


async def test_challenges_and_blocks(plain_settings, upstream):
    cloudflare = b"<html><head><title>Just a moment...</title></head><body><div id='cf-chl-widget'></div></body></html>"
    ruishu = b"<html><head><meta id=\"abcdefghijklmnopqr\" content=\"x\"><script>$_ts=window['$_ts'];</script></head><body></body></html>"
    upstream.route("www.example.org", "/cf", httpx.Response(403, content=cloudflare, headers={"content-type": "text/html"}))
    upstream.route("www.example.org", "/rs", httpx.Response(412, content=ruishu, headers={"content-type": "text/html"}))
    upstream.route("www.example.org", "/shell", httpx.Response(200, content=b"<html><body><div id=app></div></body></html>", headers={"content-type": "text/html"}))
    upstream.route("www.example.org", "/forbidden", httpx.Response(403, text="Forbidden"))
    fetcher = make_fetcher(plain_settings, upstream)
    for path, outcome, detail in (("/cf", "challenge", "cloudflare"), ("/rs", "challenge", "ruishu"),
                                  ("/forbidden", "blocked", "http_403")):
        with pytest.raises(FetchError) as refused:
            await fetcher.fetch(RequestSpec(url=f"https://www.example.org{path}"))
        assert (refused.value.outcome, refused.value.detail) == (outcome, detail)
    # a near-empty page is handed to the adapter: the scheduler calls it a shell only if nothing parses
    shell = await fetcher.fetch(RequestSpec(url="https://www.example.org/shell"))
    assert shell.status == 200 and is_empty_shell(shell.headers["content-type"], shell.body)
    assert not is_empty_shell("text/html", ARTICLE)
    await fetcher.aclose()


def test_a_news_page_mentioning_a_security_check_is_not_a_challenge():
    body = ("<html><body><h1>Airport news</h1>" + "<p>Travellers faced a long security check at the airport today.</p>" * 50
            + "</body></html>").encode()
    assert detect_challenge(200, "text/html", body, api=False) is None
    assert detect_challenge(200, "application/rss+xml", b"<rss><channel></channel></rss>", api=False) is None


async def test_api_404_with_a_body_goes_to_the_adapter(plain_settings, upstream):
    upstream.route("api.example.org", "/search", httpx.Response(404, json={"error": {"code": "NOT_FOUND"}}))
    upstream.route("api.example.org", "/empty404", httpx.Response(404))
    fetcher = make_fetcher(plain_settings, upstream)
    result = await fetcher.fetch(RequestSpec(url="https://api.example.org/search", api=True))
    assert result.status == 404 and b"NOT_FOUND" in result.body
    with pytest.raises(FetchError) as missing:
        await fetcher.fetch(RequestSpec(url="https://api.example.org/empty404", api=True))
    assert missing.value.detail == "http_404"
    with pytest.raises(FetchError):
        await fetcher.fetch(RequestSpec(url="https://www.example.org/nothing"))        # pages: a 404 is an error
    await fetcher.aclose()


async def test_credentials_are_injected_on_the_wire_and_never_returned(plain_settings, upstream, tmp_path):
    key = tmp_path / "ncbi"
    key.write_text("secret-ncbi-key\n")
    upstream.route("eutils.ncbi.nlm.nih.gov", "/entrez/eutils/esearch.fcgi", httpx.Response(200, json={"esearchresult": {}}))
    fetcher = make_fetcher(plain_settings, upstream, ncbi_key_file=str(key))
    result = await fetcher.fetch(RequestSpec(url="https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=x", api=True))
    sent = upstream.requests[-1].url.params
    assert sent["tool"] == "evimed-knowledge-plugin" and sent["email"] == "crawler-contact@example.org"
    assert sent["api_key"] == "secret-ncbi-key"
    assert "secret-ncbi-key" not in result.final_url and "crawler-contact" not in result.final_url
    assert "secret-ncbi-key" not in result.request.url
    await fetcher.aclose()


async def test_egress_and_host_policy(plain_settings, upstream):
    fetcher = make_fetcher(plain_settings, upstream)
    for egress in ("relay", "browser", "bridge"):
        with pytest.raises(FetchError) as refused:
            await fetcher.fetch(RequestSpec(url="https://www.example.org/", api=True), egress=egress)
        assert (refused.value.outcome, refused.value.detail) == ("blocked", "egress_unavailable")
    with pytest.raises(FetchError) as refused:
        await fetcher.fetch(RequestSpec(url="https://other.example.net/", api=True), allowed_hosts=["example.org"])
    assert refused.value.detail == "host_not_allowed"
    with pytest.raises(FetchError) as refused:
        await fetcher.fetch(RequestSpec(url="ftp://www.example.org/x", api=True))
    assert refused.value.detail == "invalid_url"
    with pytest.raises(FetchError) as refused:
        await fetcher.fetch(RequestSpec(url="https://user:fake-password@www.example.org/x", api=True))  # a fake credential
    assert refused.value.detail == "userinfo_in_url"
    await fetcher.aclose()


def test_redact_url_drops_query():
    assert redact_url("https://eutils.ncbi.nlm.nih.gov/x?api_key=SECRET&email=a@b") == "https://eutils.ncbi.nlm.nih.gov/x?…"


EVIMED_TRIALS = "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/v2/clinical-trial"


async def test_the_evimed_key_goes_in_the_header_on_the_api_path_only(plain_settings, upstream, tmp_path):
    key = tmp_path / "evimed.key"
    key.write_text("fake-evimed-key-for-tests\n")
    upstream.route("www.evimed.com", "/api-evimed/medicine-api/ai-api/review/api/v2/clinical-trial",
                   httpx.Response(200, json={"code": 200, "msg": "success", "data": {"list": []}}))
    upstream.route("www.evimed.com", "/", httpx.Response(200, content=ARTICLE, headers={"content-type": "text/html"}))
    fetcher = make_fetcher(plain_settings, upstream, evimed_api_key_file=str(key))
    body = b'{"query": "\\u80bf\\u7624", "registry": 0, "count": 100}'
    result = await fetcher.fetch(RequestSpec(url=EVIMED_TRIALS, method="POST", body=body, api=True,
                                             headers={"Content-Type": "application/json", "Authorization": "Bearer adapter-must-not-set-this"}),
                                 egress="api")
    sent = upstream.requests[-1]
    assert sent.method == "POST" and sent.headers["authorization"] == "Bearer fake-evimed-key-for-tests"
    assert sent.headers["content-type"] == "application/json" and sent.content == body
    assert "fake-evimed-key" not in str(result.request.headers) and "fake-evimed-key" not in result.final_url
    assert fetcher.evimed_status() == "ok"
    await fetcher.fetch(RequestSpec(url="https://www.evimed.com/", api=True), egress="direct")
    assert "authorization" not in upstream.requests[-1].headers                     # the site itself gets no key
    await fetcher.aclose()


async def test_no_evimed_key_is_refused_before_sending(plain_settings, upstream):
    fetcher = make_fetcher(plain_settings, upstream)
    with pytest.raises(FetchError) as refused:
        await fetcher.fetch(RequestSpec(url=EVIMED_TRIALS, method="POST", body=b"{}", api=True), egress="api")
    assert (refused.value.outcome, refused.value.detail) == ("blocked", "evimed_api_key_unconfigured")
    assert upstream.requests == [] and fetcher.evimed_status() == "unconfigured"
    await fetcher.aclose()


async def test_a_rejected_evimed_key_reads_as_down(plain_settings, upstream, tmp_path):
    key = tmp_path / "evimed.key"
    key.write_text("fake-revoked-key\n")
    upstream.route("www.evimed.com", "/api-evimed/medicine-api/ai-api/review/api/v2/clinical-trial", httpx.Response(401, json={"code": 401}))
    fetcher = make_fetcher(plain_settings, upstream, evimed_api_key_file=str(key))
    with pytest.raises(FetchError) as refused:
        await fetcher.fetch(RequestSpec(url=EVIMED_TRIALS, method="POST", body=b"{}", api=True), egress="api")
    assert refused.value.detail == "http_401" and fetcher.evimed_status() == "down"
    await fetcher.aclose()


async def test_adapters_cannot_set_identity_or_credential_headers(plain_settings, upstream):
    upstream.route("api.example.org", "/data", httpx.Response(200, json={"ok": True}))
    fetcher = make_fetcher(plain_settings, upstream)
    await fetcher.fetch(RequestSpec(url="https://api.example.org/data", api=True, headers={
        "Authorization": "Bearer nope", "Cookie": "a=b", "User-Agent": "Mozilla/5.0 pretend", "Host": "evil.example"}))
    sent = upstream.requests[-1].headers
    assert "authorization" not in sent and "cookie" not in sent
    assert sent["user-agent"].startswith("EviMedBot/1.0") and sent["host"] == "api.example.org"
    await fetcher.aclose()



async def test_a_refused_evimed_key_in_the_envelope_reads_as_down(plain_settings, upstream, tmp_path):
    key = tmp_path / "evimed.key"
    key.write_text("fake-unknown-key\n")
    upstream.route("www.evimed.com", "/api-evimed/medicine-api/ai-api/review/api/v2/clinical-trial",
                   httpx.Response(200, json={"code": 401, "msg": "api key unknown"}))
    fetcher = make_fetcher(plain_settings, upstream, evimed_api_key_file=str(key))
    result = await fetcher.fetch(RequestSpec(url=EVIMED_TRIALS, method="POST", body=b"{}", api=True), egress="api")
    assert result.status == 200 and fetcher.evimed_status() == "down"       # the adapter names it evimed_unauthorized
    await fetcher.aclose()



CDE_RENDER = Path(__file__).parent / "fixtures" / "browser-list" / "cde-breakthrough-therapy" / "01.html.gz"


@pytest.mark.skipif(not CDE_RENDER.exists(), reason="the readers' recorded CDE render is not in this checkout")
async def test_a_rendered_page_that_passed_ruishu_is_not_a_challenge(plain_settings, upstream):
    """药审中心 rendered 200 with its list, yet its DOM keeps Ruishu's inline script (P2, 11:38Z)."""
    import gzip
    from knowledge_plugin.browser import RENDER_HEADER
    from knowledge_plugin.fetch import rendered_passed
    body = gzip.decompress(CDE_RENDER.read_bytes())
    assert detect_challenge(200, "text/html; charset=utf-8", body, api=False) == "ruishu"      # the false flag
    found = {"content-type": "text/html; charset=utf-8", RENDER_HEADER: "selector-found"}
    assert rendered_passed(200, found, body)
    assert not rendered_passed(200, {**found, RENDER_HEADER: "selector-missing"}, body)      # the list never came
    assert not rendered_passed(202, found, body)                                             # a script page is a script page
    assert not rendered_passed(200, {"content-type": "text/html"}, body)                     # not a browser render
    fetcher = make_fetcher(plain_settings, upstream)
    result = await fetcher._result(RequestSpec(url="https://www.cde.org.cn/main/xxgk/listpage/x"), 200, found, body,
                                   "https://www.cde.org.cn/main/xxgk/listpage/x", rendered_passed=True)
    assert result.status == 200 and len(result.body) == len(body)
    with pytest.raises(FetchError) as flagged:
        await fetcher._result(RequestSpec(url="https://www.cde.org.cn/main/xxgk/listpage/x"), 200,
                              {**found, RENDER_HEADER: "selector-missing"}, body, "https://www.cde.org.cn/main/xxgk/listpage/x")
    assert (flagged.value.outcome, flagged.value.detail) == ("challenge", "ruishu")
    await fetcher.aclose()
