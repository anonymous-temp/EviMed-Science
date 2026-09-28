"""EBI through the edge proxy: which way each request goes, the fallback, and the credential.

From the Beijing host ftp.ebi.ac.uk gave ~19 KB/s direct and ~358 KB/s through
the Tokyo node (2026-09-28). The node only admits the Beijing address, so the
tunnel is proven here against a local TLS CONNECT proxy (``edge_proxy_rig``):
TLS to the proxy, CONNECT, TLS to "EBI" inside it, then the same catalogue the
offline suite reads — a streamed exposure file and a tabix outcome file read by
HTTP Range.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import shutil
import socket
import threading

import pytest

from edge_proxy_rig import Redirect, Rig
from mr_agent.tools import open_sumstats as osm
from test_open_sumstats import _Catalogue

pytestmark = pytest.mark.skipif(shutil.which("openssl") is None, reason="openssl mints the rig's certificates")

USER, PASSWORD = "mr-rig-user", "rig-password-4b1f9e"
CREDENTIALS = f"{USER}:{PASSWORD}"
SECRETS = (PASSWORD, CREDENTIALS, base64.b64encode(CREDENTIALS.encode()).decode())
EBI_API = "https://www.ebi.ac.uk/gwas/rest/api/v2"
SOURCES = ({"type": "gwas_catalog", "accession": "GCST000001"}, {"type": "gwas_catalog", "pubmedId": "222"})


def _ebi_files() -> dict[str, bytes]:
    """The offline suite's catalogue, served from EBI's own host names."""
    catalogue = _Catalogue()
    return {
        key.replace(osm.CATALOG_API, EBI_API).replace("https://ftp.example", "https://ftp.ebi.ac.uk"):
            value.replace(b"https://ftp.example", b"https://ftp.ebi.ac.uk")
        for key, value in catalogue.files.items()
    }


class _Direct(_Catalogue):
    """The direct way: the same files, answered in process, every request counted."""

    def __init__(self):
        super().__init__()
        self.files = _ebi_files()


@pytest.fixture(scope="module")
def rig(tmp_path_factory):
    rig = Rig(tmp_path_factory.mktemp("edge-rig"), CREDENTIALS)
    yield rig
    rig.close()


@pytest.fixture
def node(rig, monkeypatch, tmp_path):
    """A configured proxy on the rig, reset for each test."""
    monkeypatch.setattr(osm, "CATALOG_API", EBI_API)
    monkeypatch.delenv("EVIMED_MR_LD_BFILE", raising=False)
    monkeypatch.delenv("EVIMED_MR_OPEN_CACHE_DIR", raising=False)
    rig.proxy.seen.clear()
    rig.proxy.answer_status = None
    rig.proxy.credentials = CREDENTIALS
    rig.origin.requests.clear()
    rig.origin.files = _ebi_files()
    rig.origin.keep_alive = rig.origin.drop_kept = False
    secret = tmp_path / "edge-proxy.credentials"
    secret.write_text(CREDENTIALS + "\n")
    secret.chmod(0o440)  # production: root:10002 0440, shared with the knowledge plugin
    monkeypatch.setenv("EVIMED_MR_OPEN_PROXY_URL", f"https://127.0.0.1:{rig.proxy.port}")
    monkeypatch.setenv("EVIMED_MR_OPEN_PROXY_CREDENTIALS_FILE", str(secret))
    return rig


def _no_direct(request, timeout=None):
    raise AssertionError(f"went direct: {request.full_url}")


def _assert_no_secret(*texts: str) -> None:
    for text in texts:
        for secret in SECRETS:
            assert secret not in text


def test_ebi_is_read_through_the_tunnel_ranges_and_stream_included(node):
    http = osm._Http(opener=_no_direct, egress=osm._Egress.from_env(ssl_context=node.trust))
    pair = osm.build_pair(*SOURCES, http=http)

    # The same analysis the direct path produces (test_open_sumstats).
    assert [row.snp for row in pair.exposure_rows] == ["rs1", "rs3", "rs4", "rs5"]
    assert [row.snp for row in pair.outcome_rows] == ["rs1", "rs3", "rs4"]
    tunnels = {seen.target for seen in node.proxy.seen}
    assert tunnels == {"www.ebi.ac.uk:443", "ftp.ebi.ac.uk:443"}
    assert all(seen.method == "CONNECT" and seen.authorized for seen in node.proxy.seen)
    # One tunnel per request, and the credential stops at the proxy.
    assert len(node.proxy.seen) == len(node.origin.requests) == http.requests
    assert all("proxy-authorization" not in request["headers"] for request in node.origin.requests)
    ranged = [r for r in node.origin.requests if r["url"].endswith("GCST000002.h.tsv.gz")]
    assert ranged and all(r["headers"]["range"].startswith("bytes=") for r in ranged)

    record = pair.record
    assert record["exposure"]["read"]["mode"] == "streamed"
    assert record["exposure"]["read"]["egress"] == {"edge_proxy": 1}
    assert record["exposure"]["read"]["rows"] == 7
    assert record["outcome"]["read"]["mode"] == "tabix"
    assert set(record["outcome"]["read"]["egress"]) == {"edge_proxy"}
    egress = record["http"]["egress"]
    assert egress == {
        "proxy": "configured", "proxiedHosts": "*.ebi.ac.uk", "requests": {"edge_proxy": http.requests},
        "proxyFailureCount": 0, "proxyFailures": [], "proxyTurnedOff": False,
    }
    _assert_no_secret(json.dumps(record), repr(http.egress.proxy))


def test_only_ebi_hosts_are_routed_through_the_node(node):
    egress = osm._Egress.from_env(ssl_context=node.trust)
    for url in ("https://www.ebi.ac.uk/gwas/rest/api/v2/studies/GCST1", "https://ftp.ebi.ac.uk/pub/x",
                "https://ebi.ac.uk/"):
        assert egress.routes(url), url
    for url in ("https://ftp.example/pub/x", "https://evil-ebi.ac.uk/", "https://ebi.ac.uk.example.com/",
                "http://ftp.ebi.ac.uk/pub/x", "https://api.opengwas.io/api/"):
        assert not egress.routes(url), url

    direct = _Catalogue()
    http = osm._Http(opener=direct, egress=egress)
    body = http.read("https://ftp.example/pub/GCST000001/harmonised/")
    assert body.startswith(b"<a href=") and http.routes == {"edge_proxy": 0, "direct": 1}
    assert node.proxy.seen == []


def test_a_redirect_through_the_tunnel_is_followed_through_it(node):
    node.origin.files["https://ftp.ebi.ac.uk/moved/"] = Redirect("/pub/elsewhere/")
    node.origin.files["https://ftp.ebi.ac.uk/pub/elsewhere/"] = b"listing"
    http = osm._Http(opener=_no_direct, egress=osm._Egress.from_env(ssl_context=node.trust))
    assert http.read("https://ftp.ebi.ac.uk/moved/") == b"listing"
    assert http.routes == {"edge_proxy": 2, "direct": 0}


def test_an_answer_from_ebi_is_not_a_failure_of_the_node(node):
    http = osm._Http(opener=_no_direct, egress=osm._Egress.from_env(ssl_context=node.trust))
    with pytest.raises(osm.OpenSourceError) as caught:
        http.read("https://ftp.ebi.ac.uk/pub/missing/")
    assert "HTTP 404" in str(caught.value) and "through the edge proxy" in str(caught.value)
    assert http.egress.failure_count == 0 and not http.egress.off


@pytest.mark.parametrize(
    ("breakage", "code", "status", "off_after"),
    [
        ("wrong_credentials", "edge_proxy_refused", 407, 1),
        ("destination_refused", "edge_proxy_refused", 403, 1),
        ("untrusted_certificate", "edge_proxy_certificate_rejected", None, 1),
        # Transient: each request retries the node before going direct, and
        # the node goes off only after this many failures in a row.
        ("upstream_unreachable", "edge_proxy_refused", 502, osm._PROXY_FAILURES_BEFORE_OFF),
        ("node_down", "edge_proxy_unreachable", None, osm._PROXY_FAILURES_BEFORE_OFF),
    ],
)
def test_a_failing_node_sends_the_request_direct_and_the_record_says_so(
    node, monkeypatch, tmp_path, caplog, breakage, code, status, off_after,
):
    trust = node.trust
    if breakage == "wrong_credentials":
        node.proxy.credentials = "someone:else"
    elif breakage == "destination_refused":
        monkeypatch.setattr(node.proxy, "routes", {})
    elif breakage == "untrusted_certificate":
        trust = None  # the system's roots: the rig's CA is not among them
    elif breakage == "upstream_unreachable":
        node.proxy.answer_status = 502
    elif breakage == "node_down":
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            closed = probe.getsockname()[1]
        monkeypatch.setenv("EVIMED_MR_OPEN_PROXY_URL", f"https://127.0.0.1:{closed}")
    monkeypatch.setattr(osm, "_sleep", lambda seconds: None)
    caplog.set_level(logging.DEBUG)
    direct = _Direct()
    http = osm._Http(opener=direct, egress=osm._Egress.from_env(ssl_context=trust))

    pair = osm.build_pair(*SOURCES, http=http)

    assert [row.snp for row in pair.outcome_rows] == ["rs1", "rs3", "rs4"]
    assert len(direct.requests) == http.requests  # every request was answered the direct way
    egress = pair.record["http"]["egress"]
    assert egress["proxy"] == "configured"
    assert egress["requests"] == {"direct": http.requests}
    assert egress["proxyFailureCount"] == off_after and egress["proxyTurnedOff"] is True
    assert {(failure["code"], failure["httpStatus"]) for failure in egress["proxyFailures"]} == {(code, status)}
    assert pair.record["exposure"]["read"]["egress"] == {"direct": 1}
    assert "the request goes direct" in caplog.text and code in caplog.text
    _assert_no_secret(json.dumps(pair.record), caplog.text)


def test_a_failed_request_names_its_way_and_never_the_credential(node, monkeypatch, caplog):
    node.proxy.credentials = "someone:else"
    monkeypatch.setattr(osm.time, "sleep", lambda seconds: None)

    def unreachable(request, timeout=None):
        raise OSError("direct is down too")

    caplog.set_level(logging.DEBUG)
    http = osm._Http(opener=unreachable, egress=osm._Egress.from_env(ssl_context=node.trust))
    with pytest.raises(osm.OpenSourceError) as caught:
        osm.resolve_study(SOURCES[0], http)
    assert "could not be reached (OSError, direct)" in str(caught.value)
    _assert_no_secret(str(caught.value), caplog.text, repr(http.egress.proxy), repr(http.egress.failures))
    seen = node.proxy.seen[0]
    assert (seen.method, seen.authorized) == ("CONNECT", False)


def _configure(monkeypatch, tmp_path, url="https://203.0.113.7", content=CREDENTIALS + "\n", mode=0o400):
    monkeypatch.setenv("EVIMED_MR_OPEN_PROXY_URL", url)
    if content is None:
        monkeypatch.delenv("EVIMED_MR_OPEN_PROXY_CREDENTIALS_FILE", raising=False)
        return
    secret = tmp_path / "edge-proxy.credentials"
    secret.write_text(content)
    secret.chmod(mode)
    monkeypatch.setenv("EVIMED_MR_OPEN_PROXY_CREDENTIALS_FILE", str(secret))


@pytest.mark.parametrize(
    ("url", "content", "mode", "state", "issue"),
    [
        ("https://203.0.113.7", CREDENTIALS + "\n", 0o400, "configured", None),
        ("https://203.0.113.7:8443/", CREDENTIALS, 0o440, "configured", None),
        ("https://203.0.113.7", CREDENTIALS, 0o444, "unusable", "edge_proxy_credentials_permissions"),
        ("https://203.0.113.7", CREDENTIALS, 0o460, "unusable", "edge_proxy_credentials_permissions"),
        ("https://203.0.113.7", "no-colon\n", 0o400, "unusable", "edge_proxy_credentials_invalid"),
        ("https://203.0.113.7", "user: spaced\n", 0o400, "unusable", "edge_proxy_credentials_invalid"),
        ("https://203.0.113.7", None, 0o400, "unusable", "edge_proxy_credentials_missing"),
        ("http://203.0.113.7", CREDENTIALS, 0o400, "unusable", "edge_proxy_url_invalid"),
        (f"https://{CREDENTIALS}@203.0.113.7", CREDENTIALS, 0o400, "unusable", "edge_proxy_url_invalid"),
        ("https://203.0.113.7/squid", CREDENTIALS, 0o400, "unusable", "edge_proxy_url_invalid"),
    ],
)
def test_the_configuration_is_read_like_the_control_planes(
    monkeypatch, tmp_path, caplog, url, content, mode, state, issue,
):
    _configure(monkeypatch, tmp_path, url, content, mode)
    caplog.set_level(logging.DEBUG)
    egress = osm._Egress.from_env()
    assert (egress.state, egress.issue) == (state, issue)
    assert (egress.proxy is not None) is (state == "configured")
    if egress.proxy is not None:
        assert egress.proxy.host == "203.0.113.7" and egress.proxy.port in (443, 8443)
    # A proxy that is set but cannot be used says so in the container's log, by code.
    assert (f"edge proxy is unusable ({issue})" in caplog.text) is (state == "unusable")
    _assert_no_secret(repr(egress.proxy), json.dumps(egress.record({"direct": 1})), caplog.text)


def test_no_node_is_direct_and_says_so(monkeypatch, tmp_path):
    monkeypatch.delenv("EVIMED_MR_OPEN_PROXY_URL", raising=False)
    egress = osm._Egress.from_env()
    assert egress.proxy is None and not egress.routes("https://ftp.ebi.ac.uk/pub/x")
    assert egress.record({"direct": 3, "edge_proxy": 0}) == {
        "proxy": "not_configured", "proxiedHosts": None, "requests": {"direct": 3},
        "proxyFailureCount": 0, "proxyFailures": [], "proxyTurnedOff": False,
    }
    # A deployment without a node binds /dev/null over the credentials path: none, not broken.
    monkeypatch.setenv("EVIMED_MR_OPEN_PROXY_URL", "https://203.0.113.7")
    monkeypatch.setenv("EVIMED_MR_OPEN_PROXY_CREDENTIALS_FILE", os.devnull)
    assert (osm._Egress.from_env().state, osm._Egress.from_env().issue) == ("unusable", "edge_proxy_credentials_missing")
    link = tmp_path / "link"
    link.symlink_to(tmp_path / "elsewhere")
    monkeypatch.setenv("EVIMED_MR_OPEN_PROXY_CREDENTIALS_FILE", str(link))
    assert osm._Egress.from_env().issue == "edge_proxy_credentials_symlink"
    monkeypatch.setenv("EVIMED_MR_OPEN_PROXY_CREDENTIALS_FILE", str(tmp_path / "absent"))
    assert osm._Egress.from_env().issue == "edge_proxy_credentials_unavailable"


def test_a_passing_node_failure_is_retried_through_the_node_not_sent_direct(node, monkeypatch):
    # 2026-09-28: two passing failures and one unreachable moment sent a 450 MB
    # production job direct (~19 KB/s from Beijing instead of ~350 through the
    # node) for hours. A transient failure is now tried through the node again.
    waits = []
    monkeypatch.setattr(osm, "_sleep", waits.append)
    failures_left = {"n": 2}
    real_open = osm._Egress.open

    def flaky(self, url, headers, timeout, **options):
        if failures_left["n"] > 0:
            failures_left["n"] -= 1
            raise osm._ProxyFailure("edge_proxy_unreachable")
        return real_open(self, url, headers, timeout, **options)

    monkeypatch.setattr(osm._Egress, "open", flaky)
    http = osm._Http(opener=_no_direct, egress=osm._Egress.from_env(ssl_context=node.trust))
    pair = osm.build_pair(*SOURCES, http=http)
    assert [row.snp for row in pair.outcome_rows] == ["rs1", "rs3", "rs4"]
    egress = pair.record["http"]["egress"]
    assert "direct" not in egress["requests"], egress
    assert egress["proxyTurnedOff"] is False and egress["proxyFailureCount"] == 2
    assert waits == list(osm._PROXY_RETRY_WAITS[:2])


def test_whole_answers_share_a_kept_tunnel_and_tabix_reads_open_no_new_ones(node):
    # A tabix outcome is dozens of ~70 KB reads; each new tunnel is TLS to the
    # node, CONNECT and TLS to EBI across the Beijing-Tokyo link.
    node.origin.keep_alive = True
    http = osm._Http(opener=_no_direct, egress=osm._Egress.from_env(ssl_context=node.trust))
    pair = osm.build_pair(*SOURCES, http=http)

    assert [row.snp for row in pair.outcome_rows] == ["rs1", "rs3", "rs4"]
    assert len(node.origin.requests) == http.requests
    reused = len(node.origin.requests) - len(node.proxy.seen)
    egress = pair.record["http"]["egress"]
    assert reused > 0 and egress["tunnelsReused"] == reused
    assert egress["requests"] == {"edge_proxy": http.requests} and egress["proxyFailureCount"] == 0
    ranged = [r for r in node.origin.requests if r["url"].endswith("GCST000002.h.tsv.gz")]
    assert len(ranged) > 2
    # The size probe and the stream are not read to their end by design: each asks
    # for its own tunnel and says so.
    closing = [r for r in node.origin.requests if r["headers"].get("connection") == "close"]
    assert {r["url"].rsplit("/", 1)[-1] for r in closing} == {
        "111-GCST000001-EFO_1.h.tsv.gz", "GCST000002.h.tsv.gz"}
    assert all(r["headers"].get("range") in (None, "bytes=0-0") for r in closing)
    _assert_no_secret(json.dumps(pair.record))


def test_a_kept_tunnel_ebi_has_closed_is_replaced_not_counted_as_a_node_failure(node):
    node.origin.keep_alive = node.origin.drop_kept = True  # promises the connection, then closes it
    http = osm._Http(opener=_no_direct, egress=osm._Egress.from_env(ssl_context=node.trust))
    pair = osm.build_pair(*SOURCES, http=http)

    assert [row.snp for row in pair.outcome_rows] == ["rs1", "rs3", "rs4"]
    egress = pair.record["http"]["egress"]
    assert egress["requests"] == {"edge_proxy": http.requests}
    assert egress["proxyFailureCount"] == 0 and egress["proxyTurnedOff"] is False
    assert "tunnelsReused" not in egress  # every kept tunnel was found closed and replaced
    assert egress["keptTunnelsFoundClosed"] > 0
    # The stale tunnel carried nothing to EBI: every answered request had a fresh tunnel of its own.
    assert len(node.proxy.seen) == len(node.origin.requests) == http.requests


def test_one_blip_met_by_every_parallel_range_does_not_turn_the_node_off(node, monkeypatch, tmp_path):
    from test_open_sumstats_ranged import BIG, CHUNK, SPANS, significant

    url = "https://ftp.ebi.ac.uk/pub/databases/gwas/summary_statistics/big.h.tsv.gz"
    node.origin.files[url] = BIG
    monkeypatch.setenv("EVIMED_MR_OPEN_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("EVIMED_MR_OPEN_FETCH_CHUNK_BYTES", str(CHUNK))
    monkeypatch.setenv("EVIMED_MR_OPEN_FETCH_WORKERS", "4")
    waits = []
    monkeypatch.setattr(osm, "_sleep", waits.append)
    in_flight = threading.Barrier(4, timeout=10)
    blips = {"left": 4}
    lock = threading.Lock()
    real_open = osm._Egress.open

    def blip(self, url, headers, timeout, **options):
        with lock:
            hit = blips["left"] > 0
            blips["left"] -= hit
        if hit:
            in_flight.wait()  # all four requests are under way before the node fails any of them
            raise osm._ProxyFailure("edge_proxy_unreachable")
        return real_open(self, url, headers, timeout, **options)

    monkeypatch.setattr(osm._Egress, "open", blip)
    http = osm._Http(opener=_no_direct, egress=osm._Egress.from_env(ssl_context=node.trust))
    kept, read = osm.read_whole_file(url, http, significant, size=len(BIG))

    assert read["mode"] == "ranged" and read["sha256"] == hashlib.sha256(BIG).hexdigest()
    assert len(kept) > 100
    # Four failures seen, one outage counted: the node stays on and nothing went direct.
    assert (http.egress.failure_count, http.egress.consecutive_failures, http.egress.off) == (4, 0, False)
    assert read["egress"] == {"edge_proxy": len(SPANS)}
    assert waits == [osm._PROXY_RETRY_WAITS[0]] * 4
    # One fresh tunnel per range: a whole-file fetch never reuses one.
    assert len(node.proxy.seen) == len(SPANS)
    assert read["ranged"]["spool"] == "cache_volume" and read["ranged"]["workers"] == 4
    _assert_no_secret(json.dumps(read))
