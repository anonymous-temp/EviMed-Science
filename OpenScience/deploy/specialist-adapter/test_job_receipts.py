"""Ordinary completed specialist jobs retain unsigned worker observations.

The actual engine fixture writes files in a private stage. The worker records
source, request, input and output bindings without an operator key or a privileged
UID transition. Authentication, ownership and artifact boundaries remain checked.
"""
from __future__ import annotations

import importlib
import json
import os
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from test_service import _load_service, _token

AUDIT = Path(__file__).resolve().parents[2] / "evals/capability-audit"

RUNNER = (
    "import argparse,json,os\n"
    "from pathlib import Path\n"
    "p=argparse.ArgumentParser();p.add_argument('--request');p.add_argument('--output-dir');a=p.parse_args()\n"
    "request=json.loads(Path(a.request).read_text())\n"
    "out=Path(a.output_dir);(out/'figures').mkdir(exist_ok=True)\n"
    "(out/'report.md').write_text('# Verified report\\n\\nEvidence.',encoding='utf-8')\n"
    "(out/'figures'/'trend.svg').write_text('<svg/>',encoding='utf-8')\n"
    "seen={'request':a.request,'output':a.output_dir,'home':os.environ.get('HOME'),'tmp':os.environ.get('TMPDIR'),"
    "'auditKey':os.environ.get('EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE'),'manuscript':request.get('manuscript'),"
    "'manuscriptText':Path(request['manuscript']).read_text() if request.get('manuscript') else None}\n"
    "(out/'seen.json').write_text(json.dumps(seen),encoding='utf-8')\n"
    "(out/'result.json').write_text(json.dumps({'status':'succeeded'}),encoding='utf-8')\n"
)


def _setup(tmp_path, monkeypatch, *, kind="bibliometric-analysis", isolated=True):
    module, client, secret, workspace = _load_service(tmp_path, monkeypatch, kind=kind)
    agent = tmp_path / "agent"
    (agent / "evimed_runner.py").write_text(RUNNER, encoding="utf-8")
    if kind == "peer-review":
        (agent / "src" / "main_v2.py").write_text("# marker\n", encoding="utf-8")
    key = Ed25519PrivateKey.generate()
    key_file = tmp_path / "audit-test-key.pem"
    key_file.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()))
    key_file.chmod(0o600)
    monkeypatch.setenv("EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE", str(key_file))
    audit_receipt = importlib.import_module("evimed_specialist_adapter.audit_receipt")
    if isolated:
        # No UID change without root: the contract, not the kernel boundary.
        monkeypatch.setattr(audit_receipt, "analysis_credentials",
                            lambda: {} if os.getenv("EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE") else None)
    public = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    monkeypatch.syspath_prepend(str(AUDIT))
    import hosted_receipts
    return module, client, secret, workspace, agent, public, hosted_receipts


def _complete(module, client, secret, arguments, monkeypatch, endpoint):
    spawned = []

    class Worker:
        def wait(self, timeout=None):
            return 0

    with monkeypatch.context() as patch:
        patch.setattr(module.subprocess, "Popen", lambda command, **kwargs: spawned.append(command) or Worker())
        started = client.post(endpoint, json={"action": "start", **arguments},
                              headers={"Authorization": f"Bearer {_token(secret)}"}).json()
    assert started["status"] == "warning", started
    job_id = started["data"]["jobId"]
    code = module.run_job(spawned[0][-1])
    status = client.post(endpoint, json={"action": "status", "jobId": job_id},
                         headers={"Authorization": f"Bearer {_token(secret)}"}).json()
    return code, job_id, status


def _wrapper(tool, arguments, status):
    return {"schemaVersion": 2, "kind": "specialist-worker-record", "tool": tool,
            "startedJobId": status["data"]["jobId"],
            "scope": {"userId": "user1", "projectId": "project1", "activeWorkspace": ""},
            "request": arguments, "proof": status["data"]["auditReceipt"],
            "response": {"status": status["status"], "jobId": status["data"]["jobId"],
                         "jobStatus": status["data"]["jobStatus"],
                         "artifacts": [row["path"] for row in status["artifacts"]]}}


def test_a_completed_engine_job_has_retained_evidence_the_release_reader_accepts(tmp_path, monkeypatch):
    module, client, secret, workspace, agent, public, receipts = _setup(tmp_path, monkeypatch)
    arguments = {"topic": "antimicrobial stewardship", "maxRecords": 20}
    code, job_id, status = _complete(module, client, secret, arguments, monkeypatch, "/api/v1/evimed/bibliometric-analysis")
    assert code == 0 and status["status"] == "success", status
    proof = status["data"]["auditReceipt"]
    value = _wrapper("bibliometric_analysis", arguments, status)
    receipts.validate_receipt(value, workspace, "bibliometric_analysis", 1,
                              expected=module._source_evidence(agent), trustedPublicKey=public)
    prefix = f"bibliometric-analysis-runs/{job_id}/output/"
    assert [row["path"] for row in proof["artifacts"]] == [prefix + name for name in (
        "figures/trend.svg", "report.md", "request.json", "result.json", "seen.json")]
    assert proof["inputs"] == []
    assert str(tmp_path) not in json.dumps(value)
    # The engine ran in its stage, never in the workspace, and without the key.
    seen = json.loads((workspace / prefix / "seen.json").read_text())
    assert seen["auditKey"] is None
    for name in ("request", "output", "home", "tmp"):
        assert Path(seen[name]).parts[1:2] != ("data",) and str(workspace) not in seen[name]
        assert not Path(seen[name]).exists(), "the stage is removed once the job is published"
    # A changed artifact fails verification; the signature stays what it was.
    (workspace / prefix / "report.md").write_text("swapped")
    assert module._status({"jobId": job_id}, workspace)["data"]["auditReceipt"] == proof
    with pytest.raises(receipts.ReceiptError):
        receipts.validate_receipt(value, workspace, "bibliometric_analysis", 1,
                                  expected=module._source_evidence(agent), trustedPublicKey=public)


def test_the_manuscript_a_review_read_is_retained_as_input_evidence(tmp_path, monkeypatch):
    module, client, secret, workspace, agent, public, receipts = _setup(tmp_path, monkeypatch, kind="peer-review")
    (workspace / "papers").mkdir()
    (workspace / "papers" / "trial.md").write_text("# A randomized trial\n", encoding="utf-8")
    arguments = {"manuscript": "papers/trial.md", "articleType": "randomized-controlled-trial", "outputLanguage": "en"}
    code, job_id, status = _complete(module, client, secret, arguments, monkeypatch, "/api/v1/evimed/peer-review")
    assert code == 0 and status["status"] == "success", status
    value = _wrapper("peer_review", arguments, status)
    receipts.validate_receipt(value, workspace, "peer_review", 1,
                              expected=module._source_evidence(agent), trustedPublicKey=public)
    assert [row["path"] for row in value["proof"]["inputs"]] == ["papers/trial.md"]
    seen = json.loads((workspace / f"peer-review-runs/{job_id}/output/seen.json").read_text())
    assert seen["manuscriptText"] == "# A randomized trial\n"
    assert str(workspace) not in seen["manuscript"], "the engine reads the owner's staged copy"
    # Replacing the manuscript afterwards is caught by the same verifier.
    (workspace / "papers" / "trial.md").write_text("# A different paper\n", encoding="utf-8")
    with pytest.raises(receipts.ReceiptError):
        receipts.validate_receipt(value, workspace, "peer_review", 1,
                                  expected=module._source_evidence(agent), trustedPublicKey=public)


def test_an_engine_that_leaves_a_link_in_its_output_is_not_published_or_signed(tmp_path, monkeypatch):
    module, client, secret, workspace, agent, _, _ = _setup(tmp_path, monkeypatch)
    (agent / "evimed_runner.py").write_text(RUNNER + "os.symlink('/etc/hostname', out/'leak.txt')\n", encoding="utf-8")
    code, job_id, status = _complete(module, client, secret, {"topic": "sepsis"}, monkeypatch,
                                     "/api/v1/evimed/bibliometric-analysis")
    assert code == 1 and status["status"] == "error"
    assert "auditReceipt" not in json.dumps(status)
    assert not (workspace / f"bibliometric-analysis-runs/{job_id}/output/leak.txt").exists()
    log = (workspace / f"bibliometric-analysis-runs/.jobs/{job_id}.log").read_text()
    assert "isolated run failed: IsolatedJobError" in log




def test_without_a_key_jobs_have_unsigned_observations_from_a_private_stage(tmp_path, monkeypatch):
    module, client, secret, workspace, _, _, _ = _setup(tmp_path, monkeypatch)
    monkeypatch.delenv("EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE")
    assert client.get("/health").json()["auditReceiptsReady"] is True
    code, job_id, status = _complete(module, client, secret, {"topic": "sepsis"}, monkeypatch,
                                     "/api/v1/evimed/bibliometric-analysis")
    assert code == 0 and status["status"] == "success"
    assert status["data"]["auditReceipt"]["evidenceKind"] == "worker-observation"
    state = json.loads((workspace / f"bibliometric-analysis-runs/.jobs/{job_id}.json").read_text())
    assert state["analysisStaged"] is True
    # The worker observes staged bytes and then publishes them without a signing key.
    seen = json.loads((workspace / f"bibliometric-analysis-runs/{job_id}/output/seen.json").read_text())
    assert str(workspace) not in seen["output"]


def test_health_reports_receipt_readiness_for_every_engine(tmp_path, monkeypatch):
    _, client, _, _, _, _, _ = _setup(tmp_path, monkeypatch, kind="peer-review")
    health = client.get("/health").json()
    assert health["auditReceiptsReady"] is True
    assert str(tmp_path) not in json.dumps(health)


def test_real_credentials_reach_the_engine_and_the_helpers_that_stop_and_clean_after_it(tmp_path, monkeypatch):
    from evimed_specialist_adapter import isolated_job

    credentials = {"user": 65532, "group": 65532, "extra_groups": [], "umask": 0o007}
    launched, helpers, groups = [], [], []

    class Leader:
        pid = 424242

        def wait(self):
            return 0

    monkeypatch.setattr(isolated_job.subprocess, "Popen", lambda command, **kwargs: launched.append(kwargs) or Leader())
    monkeypatch.setattr(isolated_job.subprocess, "run", lambda command, **kwargs: helpers.append((command, kwargs)))
    monkeypatch.setattr(isolated_job.os, "waitid", lambda *args: None, raising=False)
    monkeypatch.setattr(isolated_job.os, "P_PID", 1, raising=False)
    monkeypatch.setattr(isolated_job.os, "WEXITED", 4, raising=False)
    monkeypatch.setattr(isolated_job.os, "WNOWAIT", 0x1000000, raising=False)
    egid = [1000]

    def setegid(value):
        groups.append(value)
        egid[0] = value

    monkeypatch.setattr(isolated_job.os, "getegid", lambda: egid[0])
    monkeypatch.setattr(isolated_job.os, "setegid", setegid)
    monkeypatch.setattr(isolated_job.os, "chmod", lambda *args: None)
    with isolated_job.stage(credentials, parent=str(tmp_path)) as stage:
        assert isolated_job.run(["engine"], credentials=credentials, cwd=str(tmp_path), env={}, log=None) == 0
    assert {key: launched[0][key] for key in credentials} == credentials
    assert launched[0]["start_new_session"] is True
    stop, clean = helpers
    assert "killpg" in stop[0][3] and stop[0][4] == "424242" and stop[1]["env"] == {}
    assert "rmtree" in clean[0][3] and clean[0][4] == str(stage)
    for _, kwargs in helpers:
        assert {key: kwargs[key] for key in credentials} == credentials
    assert groups == [65532, 1000], "the owner holds the analysis group only while the stage exists"
    assert not stage.exists()
