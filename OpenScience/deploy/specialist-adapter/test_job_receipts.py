"""Signed receipts are a property of the shared adapter, not of one engine
(gap E9 / D14): with an audit key mounted, every engine the adapter runs is
run as the analysis UID in a private stage, its inputs and outputs are hashed
by the owner, and the completed job is signed with the same proof schema and
key as the MR audit -- verified here by the release audit's own verifier.

These fixtures cannot change UID; like test_audit_receipt.py they drive the
isolated path with empty credentials, and one test checks that real
credentials reach the engine's process and the helpers that stop and clean up
after it.
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
    return {"schemaVersion": 1, "kind": "isolated-specialist-receipt", "tool": tool,
            "startedJobId": status["data"]["jobId"],
            "scope": {"userId": "user1", "projectId": "project1", "activeWorkspace": ""},
            "request": arguments, "proof": status["data"]["auditReceipt"],
            "response": {"status": status["status"], "jobId": status["data"]["jobId"],
                         "jobStatus": status["data"]["jobStatus"],
                         "artifacts": [row["path"] for row in status["artifacts"]]}}


def test_a_completed_job_of_any_engine_is_signed_and_the_release_verifier_accepts_it(tmp_path, monkeypatch):
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


def test_the_manuscript_a_review_read_is_the_input_it_signs(tmp_path, monkeypatch):
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


def test_a_key_the_engine_could_not_be_kept_from_refuses_the_job(tmp_path, monkeypatch):
    # Not root, so the real isolation check fails: the key is mounted and
    # nothing may run beside it.
    module, client, secret, workspace, _, _, _ = _setup(tmp_path, monkeypatch, isolated=False)
    body = client.post("/api/v1/evimed/bibliometric-analysis", json={"action": "start", "topic": "sepsis"},
                       headers={"Authorization": f"Bearer {_token(secret)}"}).json()
    assert body["error"]["code"] == "specialist_audit_isolation_unavailable"
    assert not (workspace / "bibliometric-analysis-runs").exists()
    assert client.get("/health").json()["auditReceiptsReady"] is False


def test_without_a_key_jobs_run_as_before_and_nothing_is_signed(tmp_path, monkeypatch):
    module, client, secret, workspace, _, _, _ = _setup(tmp_path, monkeypatch)
    monkeypatch.delenv("EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE")
    assert client.get("/health").json()["auditReceiptsReady"] is False
    code, job_id, status = _complete(module, client, secret, {"topic": "sepsis"}, monkeypatch,
                                     "/api/v1/evimed/bibliometric-analysis")
    assert code == 0 and status["status"] == "success"
    assert "auditReceipt" not in status["data"]
    state = json.loads((workspace / f"bibliometric-analysis-runs/.jobs/{job_id}.json").read_text())
    assert "analysisIsolated" not in state
    # The engine wrote straight into the workspace, as it always has.
    seen = json.loads((workspace / f"bibliometric-analysis-runs/{job_id}/output/seen.json").read_text())
    assert seen["output"] == str(workspace / f"bibliometric-analysis-runs/{job_id}/output")


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
    monkeypatch.setattr(isolated_job.os, "waitid", lambda *args: None)
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


@pytest.mark.skipif(not os.getenv("EVIMED_AUDIT_CONTAINER_TEST_IMAGE"), reason="explicit cached Linux test image required")
def test_actual_analysis_uid_is_kept_from_the_key_and_the_workspace_and_leaves_nothing_behind():
    import subprocess

    image = os.environ["EVIMED_AUDIT_CONTAINER_TEST_IMAGE"]
    repo = Path(__file__).resolve().parents[3]
    engine = (
        "import errno,json,os,subprocess,sys\n"
        "from pathlib import Path\n"
        "assert os.getuid()==65532 and os.getgid()==65532 and os.getgroups()==[]\n"
        "for target in ('/run/test-audit-key','/data/users/u1/projects/p1/workspace/secret.txt'):\n"
        "    try:\n        open(target,'rb').read()\n        raise AssertionError('readable: '+target)\n"
        "    except PermissionError as error:\n        assert error.errno==errno.EACCES\n"
        "try:\n    Path('/data/users/u1/projects/p1/workspace/planted.txt').write_text('x')\n    raise AssertionError('workspace writable')\n"
        "except PermissionError:\n    pass\n"
        "try:\n    os.setuid(0)\n    raise AssertionError('root regained')\nexcept PermissionError:\n    pass\n"
        "request=json.loads(Path(sys.argv[1]).read_text())\n"
        "out=Path(sys.argv[2]);(out/'figures').mkdir()\n"
        "(out/'figures'/'plot.svg').write_text('<svg/>')\n"
        "(out/'report.md').write_text(Path(request['manuscript']).read_text().upper())\n"
        "subprocess.Popen(['sleep','300'])\n"
        "(out/'result.json').write_text(json.dumps({'status':'succeeded'}))\n"
    )
    script = r'''
import json,os,sys
from pathlib import Path
sys.path[:0]=['/src/OpenScience/deploy/specialist-adapter']
from evimed_specialist_adapter import audit_receipt, isolated_job
key=Path('/run/test-audit-key');key.write_bytes(b'test-only-signing-material');key.chmod(0o600)
os.environ['EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE']=str(key)
workspace=Path('/data/users/u1/projects/p1/workspace');workspace.mkdir(parents=True);workspace.chmod(0o700)
(workspace/'secret.txt').write_text('private');(workspace/'secret.txt').chmod(0o600)
(workspace/'paper.md').write_text('a trial');(workspace/'paper.md').chmod(0o600)
output=workspace/'peer-review-runs/review-00000000/output';output.mkdir(parents=True)
Path('/tmp/engine.py').write_text(ENGINE);Path('/tmp/engine.py').chmod(0o644)
credentials=audit_receipt.analysis_credentials()
blob,row=isolated_job.read_input(workspace,'paper.md')
with isolated_job.stage(credentials) as stage:
    manuscript=isolated_job.hand_over(blob,'paper.md',stage/'input')
    request=stage/'request.json';request.write_text(json.dumps({'manuscript':str(manuscript)}));request.chmod(0o640)
    with open('/tmp/engine.log','ab') as log:
        code=isolated_job.run([sys.executable,'/tmp/engine.py',str(request),str(stage/'output')],credentials=credentials,cwd='/tmp',env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(stage/'home')},log=log)
    assert code==0, Path('/tmp/engine.log').read_text()
    rows=isolated_job.publish(stage/'output',output,workspace)
# A killed orphan is reparented to this PID 1, which reaps nothing: a
# zombie is a stopped process, not a surviving one.
status=[(p/'status').read_text() for p in Path('/proc').iterdir() if p.name.isdigit() and (p/'status').exists()]
left=[text for text in status if 'Uid:\t65532' in text and 'State:\tZ' not in text]
assert not left, 'analysis processes survived the job: '+repr(left)
assert not stage.exists(), 'the stage was not removed'
assert not (workspace/'planted.txt').exists()
assert (output/'report.md').read_text()=='A TRIAL'
print(json.dumps({'rows':[r['path'] for r in rows],'input':row['path']}))
'''.replace("ENGINE", repr(engine))
    command = ["docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only",
               "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID",
               "--security-opt", "no-new-privileges:true", "--user", "0:0",
               "--tmpfs", "/tmp", "--tmpfs", "/run", "--tmpfs", "/data",
               "--mount", f"type=bind,src={repo},dst=/src,readonly", image, "python", "-c", script]
    result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    published = json.loads(result.stdout.strip().splitlines()[-1])
    assert published == {"rows": ["peer-review-runs/review-00000000/output/figures/plot.svg",
                                  "peer-review-runs/review-00000000/output/report.md",
                                  "peer-review-runs/review-00000000/output/result.json"], "input": "paper.md"}
