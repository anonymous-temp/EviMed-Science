"""Review regressions for protected MR signing and single-execution ownership."""
from __future__ import annotations

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
    setup = setup_audit(tmp_path, monkeypatch, simulate_isolation=False)
    from evimed_specialist_adapter import audit_receipt
    with pytest.raises(audit_receipt.AuditReceiptUnavailable):
        audit_receipt.analysis_credentials()


@pytest.mark.skipif(not os.getenv("EVIMED_AUDIT_CONTAINER_TEST_IMAGE"), reason="explicit cached Linux test image required")
@pytest.mark.parametrize("drop_capability", [False, True])
@pytest.mark.parametrize("key_mode", [0o400, 0o600])
def test_actual_analysis_uid_cannot_read_key_and_missing_drop_capability_fails(drop_capability, key_mode):
    image = os.environ["EVIMED_AUDIT_CONTAINER_TEST_IMAGE"]
    repo = Path(__file__).resolve().parents[3]
    script = r'''
import errno,json,os,sys
from pathlib import Path
sys.path[:0]=['/src/OpenScience/deploy/specialist-adapter','/src/项目代码/孟德尔随机化']
from evimed_specialist_adapter import audit_receipt
import evimed_mr_job as jobs
import evimed_local_inputs as inputs
key=Path('/run/test-audit-key');key.write_bytes(b'test-only-signing-secret');key.chmod(KEY_MODE)
os.environ['EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE']=str(key)
workspace=Path('/data/users/user1/projects/project1/workspace');workspace.mkdir(parents=True);workspace.chmod(0o700)
output=workspace/'mendelian-randomization-runs/mr-audit-test/output';output.mkdir(parents=True)
runner=Path('/agent/evimed_runner.py')
runner.write_text("import errno,json,os\nfrom pathlib import Path\nos.fchdir(int(__import__('sys').argv[-1]))\nassert 'rs1' in Path('inputs/exposure.csv').read_text()\nassert os.getuid()==65532 and os.getgid()==65532 and os.getgroups()==[]\ntry:\n open('/run/test-audit-key','rb').read()\n raise AssertionError('key readable')\nexcept PermissionError as e:\n assert e.errno==errno.EACCES\ntry:\n os.setuid(0)\n raise AssertionError('root regained')\nexcept PermissionError: pass\nPath('result.json').write_text(json.dumps({'status':'succeeded'}))\n")
source={'type':'local_file','columnMapping':{'snp':'SNP','beta':'beta','se':'se','effect_allele':'effect_allele','other_allele':'other_allele','eaf':'eaf','pval':'pval'},'sampleSize':10000,'instrumentsPreclumped':True,'clumpingProvenance':'Provider declared independent instruments; LD not rechecked.'}
request={'exposure':'BMI','outcome':'CHD','analysisDirection':'forward'}
for role in ('exposure','outcome'):
 path=workspace/(role+'.csv');path.write_text('SNP,beta,se,effect_allele,other_allele,eaf,pval\\nrs1,0.2,0.01,A,G,0.2,1e-10\\n'.replace('\\n','\n'));path.chmod(0o600)
 request[role+'Source']={**source,'path':path.name}
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
'''.replace("DROP", repr(drop_capability)).replace("KEY_MODE", repr(key_mode))
    command = ["docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only",
        "--cap-drop", "ALL", "--cap-add", "SETGID", "--security-opt", "no-new-privileges:true",
        "--tmpfs", "/tmp", "--tmpfs", "/run", "--tmpfs", "/data", "--tmpfs", "/agent",
        "--mount", f"type=bind,src={repo},dst=/src,readonly"]
    if not drop_capability:
        command += ["--cap-add", "SETUID"]
    result = subprocess.run([*command, image, "python", "-c", script], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert ("privilege-drop-refused-before-runner" if drop_capability else "actual-uid-key-access-denied") in result.stdout


def test_concurrent_claims_have_one_winner(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    setup = setup_audit(tmp_path, monkeypatch)
    path, _ = start_job(setup, monkeypatch)
    barrier = Barrier(4)

    def claim():
        barrier.wait(timeout=5)
        with setup[0]._mr_store().claim(path) as state:
            return state is not None

    with ThreadPoolExecutor(max_workers=4) as pool:
        winners = list(pool.map(lambda _: claim(), range(4)))
    assert winners.count(True) == 1
    assert setup[0]._read_state(path)["status"] == "running"


def test_unsigned_jobs_need_no_privilege_drop(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch, simulate_isolation=False)
    monkeypatch.delenv("EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE")
    result, _ = completed(setup, monkeypatch)
    assert "auditReceipt" not in result["data"]


def test_unproven_isolation_fails_before_analysis_execution(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch, simulate_isolation=False)
    path, job_id = start_job(setup, monkeypatch)
    service = setup[0]
    original = service._mr_job
    executions = []

    def wrapped(root):
        jobs = original(root)
        jobs.execute = lambda *_args, **_kwargs: executions.append(True)
        return jobs

    monkeypatch.setattr(service, "_mr_job", wrapped)
    assert service.run_job(str(path)) == 1
    assert executions == []
    assert service._status({"jobId": job_id}, setup[3])["status"] == "error"


def test_image_manifest_detects_deployment_changes_without_reading_private_state(tmp_path, monkeypatch):
    setup_audit(tmp_path, monkeypatch)
    from evimed_specialist_adapter import audit_receipt
    target = tmp_path / "image/evimed_specialist_adapter"
    shutil.copytree(Path(__file__).parent / "evimed_specialist_adapter", target)
    for name in audit_receipt.DEPLOYMENT_INPUTS:
        (target.parent / name).write_bytes((Path(__file__).parent / name).read_bytes())
    manifest = audit_receipt.adapter_manifest(target)
    (target.parent / "adapter-evidence.json").write_bytes(audit_receipt.canonical(manifest) + b"\n")
    audit_receipt.adapter_evidence(target)
    (target.parent / "requirements.txt").write_text("changed dependency")
    with pytest.raises(audit_receipt.AuditReceiptUnavailable, match="manifest_changed"):
        audit_receipt.adapter_evidence(target)


def test_status_race_preserves_worker_terminal_receipt(tmp_path, monkeypatch):
    setup = setup_audit(tmp_path, monkeypatch)
    path, job_id = start_job(setup, monkeypatch)
    service = setup[0]
    monkeypatch.setattr(service, "_managed_worker_alive", lambda *_: False)
    write = service._write_state
    injected = []

    def race(state_path, state, **kwargs):
        if state.get("status") == "failed" and not injected:
            injected.append(True)
            assert service.run_job(str(path)) == 0
        return write(state_path, state, **kwargs)

    monkeypatch.setattr(service, "_write_state", race)
    result = service._status({"jobId": job_id}, setup[3])
    assert result["status"] == "success"
    assert result["data"]["auditReceipt"] == service._read_state(path)["auditReceipt"]
