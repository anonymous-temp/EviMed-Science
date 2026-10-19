"""The relay exit against a local TLS CONNECT proxy (the Tokyo node only admits the Beijing host)."""

from __future__ import annotations

import shutil
import ssl
from dataclasses import replace
from datetime import datetime, timezone

import pytest

from knowledge_plugin.budget import HostBudget, MemoryCounterStore
from knowledge_plugin.fetch import ProtectedFetcher
from knowledge_plugin.model import FetchError, RequestSpec
from knowledge_plugin.settings import edge_proxy_from
from relay_rig import ConnectProxy, Target, make_certificates, server_context

pytestmark = pytest.mark.skipif(shutil.which("openssl") is None, reason="openssl is needed to mint the rig's certificates")

CREDENTIALS = "rig-user:rig-fake-password"


class NoSleep:
    async def __call__(self, seconds):
        return None


@pytest.fixture()
async def rig(tmp_path):
    certs = make_certificates(tmp_path)
    target = await Target(server_context(certs["target_cert"], certs["target_key"])).start()
    proxy = await ConnectProxy(server_context(certs["proxy_cert"], certs["proxy_key"]), CREDENTIALS,
                               {"target.test": ("127.0.0.1", target.port)}).start()
    trust = ssl.create_default_context(cafile=str(certs["ca"]))
    yield {"target": target, "proxy": proxy, "trust": trust}
    await proxy.close()
    await target.close()


def relay_fetcher(plain_settings, rig, tmp_path, *, credentials=CREDENTIALS, port=None):
    secret = tmp_path / "edge-proxy.credentials"
    secret.write_text(credentials + "\n")
    settings = replace(plain_settings, edge_proxy_url=f"https://127.0.0.1:{port or rig['proxy'].port}",
                       edge_proxy_credentials_file=str(secret), edge_proxy_connect_timeout_s=3.0)
    budget = HostBudget(MemoryCounterStore(), {}, sleep=NoSleep())
    return ProtectedFetcher(settings, budget, relay_ssl_context=rig["trust"])


async def test_a_request_goes_through_connect_with_tls_to_the_target(plain_settings, rig, tmp_path):
    fetcher = relay_fetcher(plain_settings, rig, tmp_path)
    result = await fetcher.fetch(RequestSpec(url="https://target.test/feed.xml"), source_id="fda-feed", egress="relay",
                                 allowed_hosts=["target.test"])
    assert result.status == 200 and b"through the relay" in result.body
    assert result.headers["etag"] == '"rig-1"'
    tunnels = [s for s in rig["proxy"].seen if s.method == "CONNECT"]
    assert tunnels and all(s.target == "target.test:443" and s.authorized for s in tunnels)
    paths = [r["line"].split(" ")[1] for r in rig["target"].requests]
    assert paths == ["/robots.txt", "/feed.xml"]                   # robots.txt travelled the same exit
    sent = rig["target"].requests[-1]["headers"]
    assert sent["host"] == "target.test" and sent["user-agent"].startswith("EviMedBot/1.0")
    assert "proxy-authorization" not in sent                       # the credential stops at the proxy
    assert fetcher.egress_status(datetime.now(timezone.utc))["relay"] == "ok"
    await fetcher.aclose()


async def test_rejected_credentials_are_the_deployments_problem(plain_settings, rig, tmp_path):
    fetcher = relay_fetcher(plain_settings, rig, tmp_path, credentials="rig-user:wrong-fake-password")
    with pytest.raises(FetchError) as refused:
        await fetcher.fetch(RequestSpec(url="https://target.test/feed.xml", api=True), egress="relay")
    assert (refused.value.outcome, refused.value.detail, refused.value.status) == ("blocked", "edge_proxy_refused", 407)
    assert fetcher.egress_status(datetime.now(timezone.utc))["relay"] == "down"
    await fetcher.aclose()


async def test_a_destination_the_node_refuses(plain_settings, rig, tmp_path):
    fetcher = relay_fetcher(plain_settings, rig, tmp_path)
    with pytest.raises(FetchError) as refused:
        await fetcher.fetch(RequestSpec(url="https://elsewhere.test/x", api=True), egress="relay")
    assert (refused.value.outcome, refused.value.detail) == ("blocked", "edge_proxy_destination_refused")
    await fetcher.aclose()


async def test_a_dead_node_is_told_apart_from_a_dead_upstream(plain_settings, rig, tmp_path):
    import socket
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        dead_port = probe.getsockname()[1]
    fetcher = relay_fetcher(plain_settings, rig, tmp_path, port=dead_port)
    with pytest.raises(FetchError) as refused:
        await fetcher.fetch(RequestSpec(url="https://target.test/feed.xml", api=True), egress="relay")
    assert (refused.value.outcome, refused.value.detail) == ("blocked", "edge_proxy_unreachable")
    await fetcher.aclose()


async def test_private_literals_never_reach_the_node(plain_settings, rig, tmp_path):
    fetcher = relay_fetcher(plain_settings, rig, tmp_path)
    for url in ("https://10.0.0.5/x", "https://127.0.0.1/", "https://[::1]/", "https://169.254.169.254/latest", "https://localhost/"):
        with pytest.raises(FetchError) as refused:
            await fetcher.fetch(RequestSpec(url=url, api=True), egress="relay")
        assert (refused.value.outcome, refused.value.detail) == ("blocked", "private_address")
    assert rig["proxy"].seen == []
    await fetcher.aclose()


async def test_no_relay_configured_is_refused_by_name(plain_settings):
    fetcher = ProtectedFetcher(plain_settings, HostBudget(MemoryCounterStore(), {}, sleep=NoSleep()))
    with pytest.raises(FetchError) as refused:
        await fetcher.fetch(RequestSpec(url="https://target.test/feed.xml", api=True), egress="relay")
    assert (refused.value.outcome, refused.value.detail) == ("blocked", "egress_unavailable")
    assert fetcher.egress_status(datetime.now(timezone.utc))["relay"] == "unconfigured"
    await fetcher.aclose()


@pytest.mark.parametrize("url, credentials, ok", [
    ("https://203.0.113.20", "evimed:fake-password", True),
    ("http://127.0.0.1:3128", "u:p", True),
    ("https://user:fake-password@203.0.113.20", "u:p", False),   # credentials never in the URL
    ("https://203.0.113.20/path", "u:p", False),
    ("socks5://203.0.113.20", "u:p", False),
    ("https://203.0.113.20", "no-colon", False),
    ("https://203.0.113.20", None, False),
    (None, "u:p", False),
])
def test_edge_proxy_configuration(url, credentials, ok):
    assert (edge_proxy_from(url, credentials) is not None) is ok


async def test_a_failed_shared_pool_is_replaced_without_closing_other_inflight_requests(plain_settings, tmp_path, monkeypatch):
    import asyncio
    import httpx

    secret = tmp_path / "relay-credentials"
    secret.write_text(CREDENTIALS)
    settings = replace(plain_settings, edge_proxy_url="https://proxy.test", edge_proxy_credentials_file=str(secret))
    fetcher = ProtectedFetcher(settings, HostBudget(MemoryCounterStore(), {}))
    started, release = asyncio.Event(), asyncio.Event()
    class Client:
        def __init__(self, broken=False):
            self.broken, self.closed = broken, False
            self.cookies = httpx.Cookies()
        def build_request(self, method, url, **kwargs): return httpx.Request(method, url, **kwargs)
        async def send(self, request, **_kwargs):
            if request.url.path == "/inflight":
                started.set()
                await release.wait()
                assert not self.closed, "a peer's failure must not close this active response"
            elif self.broken:
                raise httpx.PoolTimeout("synthetic stale pool")
            return httpx.Response(200, content=b"real test response", request=request)
        async def aclose(self): self.closed = True
    old, fresh = Client(True), Client()
    proxy = settings.edge_proxy()
    fetcher._relay_client = old
    fetcher._relay_key = (proxy.url, proxy.username, proxy.password)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_kwargs: fresh)
    peer = asyncio.create_task(fetcher._exchange_relay("GET", "https://target.test/inflight", {}, None, "target.test", api=False))
    try:
        await asyncio.wait_for(started.wait(), 1)
        with pytest.raises(FetchError) as failed:
            await fetcher._exchange_relay("GET", "https://target.test/fail", {}, None, "target.test", api=False)
        assert failed.value.outcome == "timeout"
        assert not old.closed
        reply = await fetcher._exchange_relay("GET", "https://target.test/recovered", {}, None, "target.test", api=False)
        assert reply[0] == 200, "next scheduled read gets a fresh pool, not permanent outage"
        release.set()
        assert (await peer)[0] == 200
        await asyncio.sleep(0)
        assert old.closed
    finally:
        release.set()
        await asyncio.gather(peer, return_exceptions=True)
        await fetcher.aclose()
    assert fresh.closed


async def test_canceling_relay_read_releases_its_pool_for_the_next_attempt(plain_settings, tmp_path, monkeypatch):
    import asyncio
    import httpx

    secret = tmp_path / "relay-credentials"
    secret.write_text(CREDENTIALS)
    settings = replace(plain_settings, edge_proxy_url="https://proxy.test", edge_proxy_credentials_file=str(secret))
    fetcher = ProtectedFetcher(settings, HostBudget(MemoryCounterStore(), {}))
    started = asyncio.Event()
    class Client:
        cookies = httpx.Cookies()
        closed = False
        def build_request(self, method, url, **kwargs): return httpx.Request(method, url, **kwargs)
        async def send(self, request, **_kwargs):
            started.set()
            await asyncio.Event().wait()
        async def aclose(self): self.closed = True
    client = Client()
    proxy = settings.edge_proxy()
    fetcher._relay_client = client
    fetcher._relay_key = (proxy.url, proxy.username, proxy.password)
    pending = asyncio.create_task(fetcher._exchange_relay("GET", "https://target.test/cancel", {}, None, "target.test", api=False))
    await asyncio.wait_for(started.wait(), 1)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError): await pending
    await asyncio.sleep(0)
    assert client.closed and fetcher._relay_client is None and not fetcher._relay_inflight
    await fetcher.aclose()
