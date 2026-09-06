"""Review regressions for protected MR signing and single-execution ownership."""
from __future__ import annotations

import copy
import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from test_audit_receipt import AUDIT, completed, setup_audit, start_job


def test_readonly_owner_key_is_supported(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    setup[-1].chmod(0o400)
    result, _ = completed(setup, monkeypatch)
    assert result["data"]["auditReceipt"]["attestation"]["algorithm"] == "Ed25519"


def test_terminal_job_cannot_be_reexecuted_or_rewritten(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    result, state_path = completed(setup, monkeypatch)
    before = state_path.read_bytes()
    setup[0].run_job(str(state_path))
    assert state_path.read_bytes() == before
    state = setup[0]._read_state(state_path)
    state["auditReceipt"]["completedAt"] = "2000-01-01T00:00:00Z"
    with pytest.raises(ValueError, match="terminal|Terminal"):
        setup[0]._write_state(state_path, state)
    assert setup[0]._status({"jobId": result["data"]["jobId"]}, setup[3])["data"] == result["data"]


def test_running_job_claim_rejects_reentrant_execution(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    state_path, _ = start_job(setup, monkeypatch)
    store = setup[0]._mr_store()
    with store.claim(state_path) as claimed:
        assert claimed["status"] == "running"
        with store.claim(state_path) as duplicate:
            assert duplicate is None
        before = state_path.read_bytes()
        assert setup[0].run_job(str(state_path)) != 0
        assert state_path.read_bytes() == before


@pytest.mark.parametrize("name", ["Dockerfile", "Dockerfile.evidence", "requirements.txt"])
def test_each_shipped_deployment_input_is_bound_to_current_evidence(tmp_path, monkeypatch, name):
    setup_audit(tmp_path, monkeypatch)
    from evimed_specialist_adapter import audit_receipt
    adapter = tmp_path / "adapter"
    shutil.copytree(Path(__file__).parent / "evimed_specialist_adapter", adapter / "evimed_specialist_adapter")
    for filename in ("Dockerfile", "Dockerfile.evidence", "requirements.txt"):
        (adapter / filename).write_bytes((Path(__file__).parent / filename).read_bytes())
    before = audit_receipt.current_evidence(tmp_path / "agent", adapter / "evimed_specialist_adapter")
    (adapter / name).write_bytes((adapter / name).read_bytes() + b"\n# changed deployment input\n")
    assert audit_receipt.current_evidence(tmp_path / "agent", adapter / "evimed_specialist_adapter") != before


def test_non_mr_hosted_evidence_preserves_legacy_rule(tmp_path, monkeypatch):
    setup_audit(tmp_path, monkeypatch)
    import hosted_receipts
    location = AUDIT.parents[1] / "runtime/mcp/evimed-research/execution_evidence.py"
    spec = importlib.util.spec_from_file_location("legacy_execution_for_test", location)
    legacy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(legacy)
    adapter = AUDIT.parents[1] / "deploy/specialist-adapter"
    expected = {"executionEvidence": legacy.execution_evidence(AUDIT.parents[2] / "项目代码/论文审稿",
        adapter / "evimed_specialist_adapter/service.py"), "adapterEvidence": legacy.source_tree_evidence(adapter)}
    assert hosted_receipts.current_evidence("peer_review") == expected


def test_audit_mode_refuses_same_uid_runner_before_launch(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    from evimed_specialist_adapter import audit_receipt
    with pytest.raises(audit_receipt.AuditReceiptUnavailable):
        audit_receipt.analysis_credentials()


@pytest.mark.skipif(not os.getenv("EVIMED_AUDIT_CONTAINER_TEST_IMAGE"), reason="explicit cached Linux test image required")
@pytest.mark.parametrize("drop_capability", [False, True])
def test_actual_analysis_uid_cannot_read_key_and_missing_drop_capability_fails(drop_capability):
    image = os.environ["EVIMED_AUDIT_CONTAINER_TEST_IMAGE"]
    repo = Path(__file__).resolve().parents[3]
    script = r'''
import errno,json,os,sys
from pathlib import Path
sys.path[:0]=['/src/OpenScience/deploy/specialist-adapter','/src/项目代码/孟德尔随机化']
from evimed_specialist_adapter import audit_receipt
import evimed_mr_job as jobs
import evimed_local_inputs as inputs
key=Path('/run/test-audit-key');key.write_bytes(b'test-only-signing-secret');key.chmod(0o400)
os.environ['EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE']=str(key)
workspace=Path('/data/users/user1/projects/project1/workspace');workspace.mkdir(parents=True)
output=workspace/'mendelian-randomization-runs/mr-audit-test/output';output.mkdir(parents=True)
runner=Path('/agent/evimed_runner.py')
runner.write_text("import errno,json,os\nfrom pathlib import Path\nos.fchdir(int(__import__('sys').argv[-1]))\nassert os.getuid()==65532 and os.getgid()==65532 and os.getgroups()==[]\ntry:\n open('/run/test-audit-key','rb').read()\n raise AssertionError('key readable')\nexcept PermissionError as e:\n assert e.errno==errno.EACCES\ntry:\n os.setuid(0)\n raise AssertionError('root regained')\nexcept PermissionError: pass\nPath('result.json').write_text(json.dumps({'status':'succeeded'}))\n")
request={'exposure':'BMI','outcome':'CHD','analysisDirection':'forward'}
bindings=inputs.capture_bindings(workspace,request,Path('/data'))
job=jobs.Job(workspace=workspace,output_root=output,data_root=Path('/data'),request=request,bindings=bindings,python=sys.executable,runner=runner)
try:
 result=jobs.execute(inputs,job,{},analysis_credentials=audit_receipt.analysis_credentials())
 assert not DROP and result['result']['status']=='succeeded' and result['analysisIsolated'] is True
 print('actual-uid-key-access-denied')
except (inputs.MRInputError,audit_receipt.AuditReceiptUnavailable,PermissionError):
 assert DROP
 assert not (output/'result.json').exists()
 print('privilege-drop-refused-before-runner')
'''.replace("DROP", repr(drop_capability))
    command = ["docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only",
        "--cap-drop", "ALL", "--cap-add", "SETGID", "--security-opt", "no-new-privileges:true",
        "--tmpfs", "/tmp", "--tmpfs", "/run", "--tmpfs", "/data", "--tmpfs", "/agent",
        "--mount", f"type=bind,src={repo},dst=/src,readonly"]
    if not drop_capability:
        command += ["--cap-add", "SETUID"]
    result = subprocess.run([*command, image, "python", "-c", script], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert ("privilege-drop-refused-before-runner" if drop_capability else "actual-uid-key-access-denied") in result.stdout
