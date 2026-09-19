"""A finished job's model spend, forwarded to the control plane.

The engines call the provider from their own containers and the runtime calls
this adapter directly, so this report is the only way the control plane learns
what a job spent. What these tests hold: the signature is byte-for-byte the one
the control plane verifies, a malformed usage block is never forwarded, and a
report that cannot be delivered is retried a bounded number of times and then
given up on without touching the job.
"""
from __future__ import annotations

import hashlib
import hmac
import importlib
import io
import json
import sys
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
usage_report = importlib.import_module("evimed_specialist_adapter.usage_report")

USAGE = {"requests": 3, "cacheHitTokens": 9000, "cacheMissTokens": 1200, "outputTokens": 400, "model": "deepseek-flash"}


def test_the_signature_is_the_one_the_control_plane_verifies() -> None:
    # Pinned in apps/server/test/engineUsage.test.mjs as well.
    assert usage_report.signature(
        "test-only-engine-usage-vector-secret-0123456789",
        b'{"v":1,"kind":"peer-review","jobId":"review-20260920-abcdef"}',
    ) == "8b668423c7817cf0286e1e119411e38bce3bbf4e4b40b2a2e419a9a5b27ac370"


def test_only_a_well_formed_usage_block_is_forwarded() -> None:
    assert usage_report.normalize(USAGE) == USAGE
    assert usage_report.normalize({**USAGE, "extra": "dropped"}) == USAGE
    for broken in (
        None,
        [],
        {**USAGE, "requests": -1},
        {**USAGE, "outputTokens": 1.5},
        {**USAGE, "cacheHitTokens": True},
        {**USAGE, "model": 7},
        {key: value for key, value in USAGE.items() if key != "cacheMissTokens"},
    ):
        assert usage_report.normalize(broken) is None, broken


class _Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _report(opener, **overrides):
    sleeps = []
    arguments = {
        "url": "http://control-plane.test/internal/usage/v1/engine",
        "secret": "adapter-test-workload-secret-0123456789abcdef",
        "kind": "peer-review",
        "job_id": "review-20260920010203-abcdef012345",
        "user_id": "user1",
        "project_id": "project1",
        "status": "succeeded",
        "finished_at": "2026-09-20T01:02:03Z",
        "usage": USAGE,
        "sleep": sleeps.append,
        "opener": opener,
        **overrides,
    }
    return usage_report.report(**arguments), sleeps


def test_a_report_is_signed_over_its_exact_bytes_and_names_the_job() -> None:
    sent = []

    def opener(request, timeout):
        sent.append((request, timeout))
        return _Response()

    outcome, sleeps = _report(opener)
    assert outcome == "recorded (HTTP 200)"
    assert sleeps == []
    request, timeout = sent[0]
    assert timeout == 10
    assert request.get_method() == "POST"
    body = json.loads(request.data)
    assert body == {
        "v": 1, "kind": "peer-review", "jobId": "review-20260920010203-abcdef012345", "attempt": 1,
        "userId": "user1", "projectId": "project1", "status": "succeeded",
        "finishedAt": "2026-09-20T01:02:03Z", "usage": USAGE,
    }
    key = hmac.new(b"adapter-test-workload-secret-0123456789abcdef", b"evimed/engine-usage/key/v1", hashlib.sha256).digest()
    expected = hmac.new(key, request.data, hashlib.sha256).hexdigest()
    assert request.get_header("X-evimed-engine-usage-signature") == f"v1={expected}"
    assert request.get_header("Content-type") == "application/json"


def test_a_refusal_is_final_and_an_outage_is_retried_then_given_up() -> None:
    def refused(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 400, "bad", {}, io.BytesIO(b"{}"))

    assert _report(refused) == ("refused (HTTP 400)", [])

    calls = []

    def down(request, timeout):
        calls.append(1)
        raise urllib.error.HTTPError(request.full_url, 503, "busy", {}, io.BytesIO(b"{}"))

    outcome, sleeps = _report(down)
    assert outcome == "undelivered (HTTP 503)"
    assert len(calls) == 3 and sleeps == [1, 2]

    def unreachable(request, timeout):
        raise urllib.error.URLError("connection refused")

    assert _report(unreachable)[0] == "undelivered (URLError)"

    def recovers(request, timeout):
        calls.append(2)
        if calls.count(2) == 1:
            raise urllib.error.HTTPError(request.full_url, 429, "slow down", {}, io.BytesIO(b"{}"))
        return _Response()

    assert _report(recovers)[0] == "recorded (HTTP 200)"


def test_no_address_means_no_report() -> None:
    def never(request, timeout):
        raise AssertionError("no report without an address")

    assert _report(never, url="")[0] == "not configured"


def test_an_mr_job_reports_under_the_owner_its_protected_queue_recorded(tmp_path, monkeypatch) -> None:
    """MR keeps its state outside the workspace, bound to the account and
    project that admitted it; the report names that owner, not a path's guess."""
    from test_mr_inputs import local_source, setup_mr
    from test_service import _token, _usage_receiver

    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    usage = {"requests": 2, "cacheHitTokens": 7000, "cacheMissTokens": 900, "outputTokens": 350, "model": "deepseek-flash"}
    runner = Path(tmp_path / "agent" / "evimed_runner.py")
    runner.write_text(runner.read_text().replace(
        "json.dumps({'status':'succeeded'})", f"json.dumps({{'status':'succeeded','usage':{usage!r}}})"))
    (workspace / "data").mkdir()
    rows = "variant,effect,stderr,A1,A2,freq,p\nrs1,0.2,0.01,A,G,0.2,1e-10\n"
    (workspace / "data/exposure.csv").write_text(rows)
    (workspace / "data/outcome.tsv").write_text(rows.replace(",", "\t"))
    server, received = _usage_receiver()
    monkeypatch.setenv("EVIMED_USAGE_REPORT_URL", f"http://127.0.0.1:{server.server_address[1]}/internal/usage/v1/engine")
    queued = []

    class QueuedWorker:
        def wait(self, timeout=None):
            return 0

    try:
        with monkeypatch.context() as patch:
            patch.setattr(service.subprocess, "Popen", lambda command, **_kwargs: queued.append(command) or QueuedWorker())
            response = client.post(
                "/api/v1/evimed/mendelian-randomization",
                headers={"Authorization": f"Bearer {_token(secret)}"},
                json={
                    "action": "start", "exposure": "BMI", "outcome": "CHD", "analysisDirection": "forward",
                    "exposureSource": local_source("data/exposure.csv"),
                    "outcomeSource": local_source("data/outcome.tsv", clumped=False),
                },
            )
        assert response.status_code == 200, response.text
        assert service.run_job(queued[0][-1]) == 0
    finally:
        server.shutdown()
    assert len(received) == 1
    report = json.loads(received[0][1])
    assert report["kind"] == "mendelian-randomization"
    assert report["jobId"] == response.json()["data"]["jobId"]
    assert (report["userId"], report["projectId"]) == ("user1", "project1")
    assert report["usage"] == usage
