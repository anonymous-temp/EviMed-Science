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
    ("https://45.32.58.204", "evimed:fake-password", True),
    ("http://127.0.0.1:3128", "u:p", True),
    ("https://user:fake-password@45.32.58.204", "u:p", False),   # credentials never in the URL
    ("https://45.32.58.204/path", "u:p", False),
    ("socks5://45.32.58.204", "u:p", False),
    ("https://45.32.58.204", "no-colon", False),
    ("https://45.32.58.204", None, False),
    (None, "u:p", False),
])
def test_edge_proxy_configuration(url, credentials, ok):
    assert (edge_proxy_from(url, credentials) is not None) is ok
