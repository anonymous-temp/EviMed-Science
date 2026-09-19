"""What a finished MetaAgent job spent at the provider, reported to EviMed.

MetaAgent calls DeepSeek itself and the EviMed runtime calls this service
directly, so this report is the only way the control plane's usage ledger
learns what a meta-analysis cost. These tests hold: the signature is the one the
control plane verifies, the totals come from the job's own usage manifest with
the provider's cache split, a resumed job never reports a token twice, and a
failed job's tokens are reported as well.
"""
from __future__ import annotations

import hashlib
import hmac
import http.client
import http.server
import json
import threading
from pathlib import Path
from types import SimpleNamespace

from new_meta import evimed_adapter, evimed_usage_report
from new_meta.core import llm as llm_module
from tests.test_evimed_adapter import SECRET, _fixture, _post


def _event(prompt, completion, *, hit=None, miss=None, model="deepseek-flash", error=""):
    event = {"model": model, "prompt_tokens": prompt, "completion_tokens": completion, "timestamp": f"t{prompt}-{completion}"}
    if hit is not None:
        event["prompt_cache_hit_tokens"] = hit
    if miss is not None:
        event["prompt_cache_miss_tokens"] = miss
    if error:
        event["error_type"] = error
    return event


def test_the_signature_is_the_one_the_control_plane_verifies() -> None:
    # Pinned in OpenScience/apps/server/test/engineUsage.test.mjs as well.
    assert evimed_usage_report.signature(
        "test-only-engine-usage-vector-secret-0123456789",
        b'{"v":1,"kind":"peer-review","jobId":"review-20260920-abcdef"}',
    ) == "8b668423c7817cf0286e1e119411e38bce3bbf4e4b40b2a2e419a9a5b27ac370"


def test_a_jobs_usage_comes_from_its_manifest_and_an_unanswered_call_is_not_one() -> None:
    manifest = {"events": [
        _event(1000, 50, hit=900, miss=100),
        _event(400, 20),  # recorded before the split was kept: all of it a miss
        _event(0, 0, error="APITimeoutError"),
        _event(10, 1, model="deepseek-v4-pro"),
    ]}
    assert evimed_usage_report.usage_from_manifest(manifest) == {
        "requests": 3, "cacheHitTokens": 900, "cacheMissTokens": 510, "outputTokens": 71, "model": "deepseek-flash",
    }
    assert evimed_usage_report.usage_from_manifest({"summary": {}}) is None
    assert evimed_usage_report.usage_from_manifest(None) is None


def test_a_resumed_job_reports_only_what_it_added() -> None:
    first = {"requests": 3, "cacheHitTokens": 900, "cacheMissTokens": 510, "outputTokens": 71, "model": "deepseek-flash"}
    later = {**first, "requests": 5, "cacheHitTokens": 1500, "outputTokens": 100}
    assert evimed_usage_report.delta(later, first) == {
        "requests": 2, "cacheHitTokens": 600, "cacheMissTokens": 0, "outputTokens": 29, "model": "deepseek-flash",
    }
    assert evimed_usage_report.delta(first, None) == first


def test_a_job_that_ended_never_gets_an_exception_from_its_report() -> None:
    # The report runs after the terminal state is written, in the job's own
    # worker: whatever goes wrong comes back as a sentence for the job log.
    arguments = {
        "secret": SECRET, "job_id": "meta-20260920010203-abcdef012345", "user_id": "user-1", "project_id": "project-1",
        "status": "succeeded", "finished_at": "2026-09-20T01:02:03Z",
        "usage": {"requests": 1, "cacheHitTokens": 0, "cacheMissTokens": 10, "outputTokens": 1, "model": "deepseek-flash"},
    }

    def never(request, timeout):
        raise AssertionError("an unsendable address is not sent to")

    assert evimed_usage_report.report(
        url="open-science-web/internal/usage/v1/engine", opener=never, **arguments,
    ) == "not sent (invalid report URL)"

    def garbled(request, timeout):
        raise http.client.BadStatusLine("garbage")

    sleeps = []
    assert evimed_usage_report.report(
        url="http://control-plane.test/internal/usage/v1/engine", opener=garbled, sleep=sleeps.append, **arguments,
    ) == "undelivered (BadStatusLine)"
    assert sleeps == [1, 2]


def test_the_provider_cache_split_is_kept_on_every_usage_event() -> None:
    as_dict = llm_module._usage_dict_from_usage(
        {"prompt_tokens": 120, "completion_tokens": 8, "prompt_cache_hit_tokens": 100, "prompt_cache_miss_tokens": 20})
    assert (as_dict["prompt_cache_hit_tokens"], as_dict["prompt_cache_miss_tokens"]) == (100, 20)
    as_object = llm_module._usage_dict_from_usage(SimpleNamespace(prompt_tokens=50, completion_tokens=5))
    assert (as_object["prompt_cache_hit_tokens"], as_object["prompt_cache_miss_tokens"]) == (0, 50)
    summary = llm_module._build_llm_usage_manifest([
        {"prompt_tokens": 120, "completion_tokens": 8, "prompt_cache_hit_tokens": 100, "prompt_cache_miss_tokens": 20},
        {"prompt_tokens": 30, "completion_tokens": 2},
    ])["summary"]
    assert (summary["prompt_cache_hit_tokens"], summary["prompt_cache_miss_tokens"]) == (100, 50)


def test_the_exit_time_manifest_write_never_masks_the_runs_outcome(monkeypatch) -> None:
    from new_meta import main as meta_main

    written = []
    monkeypatch.setattr(meta_main, "write_llm_usage_manifest", written.append)
    meta_main._flush_llm_usage_manifest("project-a")
    assert written == ["project-a"]

    def broken(_project):
        raise OSError("disk full")

    monkeypatch.setattr(meta_main, "write_llm_usage_manifest", broken)
    meta_main._flush_llm_usage_manifest("project-b")  # must not raise


def _receiver():
    received: list[tuple[dict, bytes]] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 — the stdlib's name
            body = self.rfile.read(int(self.headers["content-length"]))
            received.append(({name.lower(): value for name, value in self.headers.items()}, body))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, received


def _start_job(client, monkeypatch, workspace):
    class Worker:
        pid = 12345

        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(evimed_adapter.subprocess, "Popen", lambda command, **kwargs: Worker())
    job_id = _post(client, {"action": "start", "topic": "Intervention A versus B for outcome C in adults"}).json()["data"]["jobId"]
    return job_id, workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"


def _cli(manifest_events, *, returncode=0):
    def run(command, **kwargs):
        project = Path(command[command.index("--output-dir") + 1]) / "measured-project"
        (project / "package").mkdir(parents=True, exist_ok=True)
        (project / "package" / "release_decision.json").write_text(json.dumps({"status": "ready"}), encoding="utf-8")
        (project / "llm_usage_manifest.json").write_text(json.dumps({"events": manifest_events}), encoding="utf-8")
        return SimpleNamespace(returncode=returncode)

    return run


def test_a_finished_job_reports_its_spend_once_and_a_resumed_attempt_only_its_share(tmp_path, monkeypatch) -> None:
    client, workspace = _fixture(tmp_path, monkeypatch)
    server, received = _receiver()
    monkeypatch.setenv("EVIMED_USAGE_REPORT_URL", f"http://127.0.0.1:{server.server_address[1]}/internal/usage/v1/engine")
    try:
        job_id, state_file = _start_job(client, monkeypatch, workspace)
        assert json.loads(state_file.read_text(encoding="utf-8"))["owner"] == {"userId": "user-1", "projectId": "project-1"}
        first = [_event(2000, 100, hit=1800, miss=200), _event(500, 40, hit=0, miss=500)]
        monkeypatch.setattr(evimed_adapter.subprocess, "run", _cli(first))
        assert evimed_adapter.run_job(str(state_file)) == 0

        # The same job run again (resumed): its manifest now carries both
        # attempts, and the second report carries only the second's share.
        state = json.loads(state_file.read_text(encoding="utf-8"))
        state.update(status="queued", attempts=1)
        state_file.write_text(json.dumps(state), encoding="utf-8")
        monkeypatch.setattr(evimed_adapter.subprocess, "run", _cli([*first, _event(700, 30, hit=600, miss=100)]))
        assert evimed_adapter.run_job(str(state_file)) == 0
    finally:
        server.shutdown()

    assert len(received) == 2
    reports = [json.loads(body) for _, body in received]
    for headers, body in received:
        key = hmac.new(SECRET.encode(), b"evimed/engine-usage/key/v1", hashlib.sha256).digest()
        assert headers["x-evimed-engine-usage-signature"] == "v1=" + hmac.new(key, body, hashlib.sha256).hexdigest()
    assert [report["attempt"] for report in reports] == [1, 2]
    assert all(report["kind"] == "meta-analysis" and report["jobId"] == job_id for report in reports)
    assert all((report["userId"], report["projectId"]) == ("user-1", "project-1") for report in reports)
    assert reports[0]["usage"] == {"requests": 2, "cacheHitTokens": 1800, "cacheMissTokens": 700, "outputTokens": 140,
                                   "model": "deepseek-flash"}
    assert reports[1]["usage"] == {"requests": 1, "cacheHitTokens": 600, "cacheMissTokens": 100, "outputTokens": 30,
                                   "model": "deepseek-flash"}
    final = json.loads(state_file.read_text(encoding="utf-8"))
    assert final["usageReported"]["requests"] == 3
    log = (workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.log").read_text(encoding="utf-8")
    assert log.count("usage report: recorded (HTTP 200)") == 2


def test_a_failed_job_reports_what_it_spent_too(tmp_path, monkeypatch) -> None:
    client, workspace = _fixture(tmp_path, monkeypatch)
    server, received = _receiver()
    monkeypatch.setenv("EVIMED_USAGE_REPORT_URL", f"http://127.0.0.1:{server.server_address[1]}/internal/usage/v1/engine")
    try:
        _, state_file = _start_job(client, monkeypatch, workspace)
        monkeypatch.setattr(evimed_adapter.subprocess, "run", _cli([_event(300, 10, hit=200, miss=100)], returncode=1))
        assert evimed_adapter.run_job(str(state_file)) == 1
    finally:
        server.shutdown()
    assert json.loads(state_file.read_text(encoding="utf-8"))["status"] == "failed"
    assert len(received) == 1
    report = json.loads(received[0][1])
    assert report["status"] == "failed"
    assert report["usage"]["requests"] == 1
