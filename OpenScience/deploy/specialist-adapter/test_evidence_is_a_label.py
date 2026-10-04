"""The adapter's evidence labels a job's record and never decides the job.

Owner ruling 2026-10-04: a receipt is our own mechanism, not a gate on a
researcher's job. Before it, three things failed a job over evidence alone: an
engine-source change between admission and completion (an MR job that had
finished ended as `mr_input_changed`), a stale pinned adapter manifest (HTTP 500
on every start, the 2026-09-27 delta incident), and any source file the hashing
could not read. What stays a failure is not evidence: the user's own input
files, unsafe published files, the MR workspace and output bindings, and the
request's authentication -- those tests live where they always did and are not
touched.
"""
from __future__ import annotations

import copy
import json
import os
import shutil
from pathlib import Path

import pytest

from evimed_specialist_adapter import audit_receipt
from test_job_receipts import RUNNER, _complete, _setup, _wrapper
from test_service import _token

BIBLIOMETRIC = "/api/v1/evimed/bibliometric-analysis"
ARGUMENTS = {"topic": "antimicrobial stewardship", "maxRecords": 20}


def _touch_source(agent: Path) -> str:
    # The engine's source tree is edited while the job works, as a hot patch would.
    return f"Path({str(agent / 'src' / 'late_patch.py')!r}).write_text('PATCHED = 1\\n')\n"


def _runner_that_touches_source(agent: Path) -> str:
    return RUNNER + _touch_source(agent)


def _copied_adapter(tmp_path: Path) -> Path:
    """A copy of the adapter package with its deployment inputs, as the image holds it."""
    here = Path(__file__).parent
    target = tmp_path / "image" / "evimed_specialist_adapter"
    shutil.copytree(here / "evimed_specialist_adapter", target, ignore=shutil.ignore_patterns("__pycache__"))
    for name in audit_receipt.DEPLOYMENT_INPUTS:
        (target.parent / name).write_bytes((here / name).read_bytes())
    return target


def _pin(package: Path, *, matching: bool) -> None:
    manifest = audit_receipt.adapter_manifest(package)
    if not matching:
        manifest["deploymentInputs"][0]["sha256"] = "0" * 64
    (package.parent / "adapter-evidence.json").write_bytes(audit_receipt.canonical(manifest) + b"\n")


# ---------------------------------------------------------------------------
# The vocabulary: what a record may say about its own evidence.
# ---------------------------------------------------------------------------

EVIDENCE = {"executionEvidence": {"agentSourceSha256": "a" * 64}, "adapterEvidence": {"sha256": "b" * 64, "files": 12}}
OTHER = {"executionEvidence": {"agentSourceSha256": "c" * 64}, "adapterEvidence": {"sha256": "b" * 64, "files": 12}}


def _observed(evidence, *, pinned="matches", unavailable=None):
    return {"evidence": evidence, "unavailable": unavailable, "pinnedManifest": pinned}


def test_clean_evidence_has_no_note_at_either_end():
    assert audit_receipt.admission_note(_observed(EVIDENCE)) is None
    assert audit_receipt.admission_note(_observed(EVIDENCE, pinned="absent")) is None
    assert audit_receipt.evidence_note(EVIDENCE, None, _observed(copy.deepcopy(EVIDENCE))) is None


def test_a_change_is_recorded_with_both_evidence_blocks():
    note = audit_receipt.evidence_note(EVIDENCE, None, _observed(OTHER))
    assert note == {"changed": True, "admission": EVIDENCE, "completion": OTHER}


def test_evidence_that_vanishes_during_a_job_is_a_change_not_a_failure():
    note = audit_receipt.evidence_note(EVIDENCE, None, _observed(None, unavailable="audit_file_invalid"))
    assert note == {"changed": True, "admission": EVIDENCE, "completion": {"unavailable": "audit_file_invalid"}}


def test_findings_made_at_admission_travel_to_the_end_of_the_job():
    admitted = audit_receipt.admission_note(_observed(None, pinned="mismatch", unavailable="audit_source_symlink"))
    assert admitted == {"unavailable": "audit_source_symlink", "pinnedManifest": "mismatch"}
    # Nothing was taken at admission, so there is nothing to compare and nothing to add.
    assert audit_receipt.evidence_note(None, admitted, _observed(EVIDENCE)) == admitted


def test_a_pin_that_goes_stale_during_a_job_is_noted():
    assert audit_receipt.evidence_note(EVIDENCE, None, _observed(EVIDENCE, pinned="mismatch")) == {"pinnedManifest": "mismatch"}
    assert audit_receipt.evidence_note(EVIDENCE, None, _observed(EVIDENCE, pinned="unreadable")) == {"pinnedManifest": "unreadable"}


def test_pinned_manifest_status_names_each_state_and_never_raises(tmp_path):
    package = _copied_adapter(tmp_path)
    assert audit_receipt.pinned_manifest_status(package) == "absent"
    _pin(package, matching=True)
    assert audit_receipt.pinned_manifest_status(package) == "matches"
    audit_receipt.adapter_evidence(package)
    _pin(package, matching=False)
    assert audit_receipt.pinned_manifest_status(package) == "mismatch"
    with pytest.raises(audit_receipt.AuditReceiptUnavailable, match="manifest_changed"):
        audit_receipt.adapter_evidence(package)
    pin = package.parent / "adapter-evidence.json"
    pin.unlink()
    pin.symlink_to(package.parent / "Dockerfile")
    assert audit_receipt.pinned_manifest_status(package) == "unreadable"
    with pytest.raises(audit_receipt.AuditReceiptUnavailable, match="manifest_unreadable"):
        audit_receipt.adapter_evidence(package)
    pin.unlink()
    pin.write_text("{not json")
    assert audit_receipt.pinned_manifest_status(package) == "unreadable"


def test_observe_evidence_matches_the_strict_function_when_nothing_is_wrong(tmp_path):
    agent = tmp_path / "agent"
    (agent / "src").mkdir(parents=True)
    (agent / "src" / "engine.py").write_text("X = 1\n")
    observed = audit_receipt.observe_evidence(agent)
    assert observed["evidence"] == audit_receipt.current_evidence(agent)
    assert observed["unavailable"] is None


@pytest.mark.parametrize("breakage", ["hardlink", "symlink", "empty"])
def test_observe_evidence_answers_with_a_code_where_the_strict_function_raises(tmp_path, breakage):
    agent = tmp_path / "agent"
    (agent / "src").mkdir(parents=True)
    if breakage == "hardlink":
        (agent / "src" / "engine.py").write_text("X = 1\n")
        os.link(agent / "src" / "engine.py", agent / "src" / "twin.py")
    elif breakage == "symlink":
        (agent / "src" / "engine.py").write_text("X = 1\n")
        (agent / "src" / "linked.py").symlink_to(agent / "src" / "engine.py")
    with pytest.raises((audit_receipt.AuditReceiptUnavailable, OSError)):
        audit_receipt.current_evidence(agent)
    observed = audit_receipt.observe_evidence(agent)
    assert observed["evidence"] is None
    assert observed["unavailable"].startswith("audit_")
    assert str(tmp_path) not in json.dumps(observed), "a code, never a path"


# ---------------------------------------------------------------------------
# A stale pinned manifest: the job runs, the record and /health say so.
# ---------------------------------------------------------------------------

def test_a_stale_pinned_manifest_never_refuses_a_start_and_is_reported(tmp_path, monkeypatch):
    module, client, secret, workspace, agent, _, receipts = _setup(tmp_path, monkeypatch)
    package = _copied_adapter(tmp_path)
    _pin(package, matching=False)
    monkeypatch.setattr(audit_receipt, "PACKAGE", package)
    health = client.get("/health").json()
    assert health["adapterManifest"] == "mismatch"
    assert health["status"] == "ok" and health["serving"] is True, "a stale pin is reported, never a reason to be unhealthy"
    assert str(tmp_path) not in json.dumps(health)

    code, job_id, status = _complete(module, client, secret, ARGUMENTS, monkeypatch, BIBLIOMETRIC)
    assert code == 0 and status["status"] == "success", status
    assert status["artifacts"]
    receipt = status["data"]["auditReceipt"]
    assert receipt["evidenceNote"] == {"pinnedManifest": "mismatch"}
    state = json.loads((workspace / f"bibliometric-analysis-runs/.jobs/{job_id}.json").read_text())
    assert state["evidenceNote"] == {"pinnedManifest": "mismatch"} and state["status"] == "succeeded"
    # What the audit certifies is a clean build; a record on a stale pin is not one.
    with pytest.raises(receipts.ReceiptError, match="source_changed"):
        receipts.validate_receipt(_wrapper("bibliometric_analysis", ARGUMENTS, status), workspace,
                                  "bibliometric_analysis", 1, expected=module._source_evidence(agent))


def test_a_stale_pinned_manifest_never_refuses_an_mr_start(tmp_path, monkeypatch):
    from test_audit_receipt import completed, setup_audit

    setup = setup_audit(tmp_path, monkeypatch)
    package = _copied_adapter(tmp_path)
    _pin(package, matching=False)
    monkeypatch.setattr(audit_receipt, "PACKAGE", package)
    assert setup[1].get("/health").json()["adapterManifest"] == "mismatch"
    result, state_path = completed(setup, monkeypatch)
    assert result["status"] == "success" and result["data"]["auditReceipt"]["evidenceNote"] == {"pinnedManifest": "mismatch"}
    assert setup[0]._read_state(state_path)["status"] == "succeeded"


def test_a_matching_pin_leaves_the_record_exactly_as_it_was(tmp_path, monkeypatch):
    module, client, secret, workspace, agent, _, receipts = _setup(tmp_path, monkeypatch)
    package = _copied_adapter(tmp_path)
    _pin(package, matching=True)
    monkeypatch.setattr(audit_receipt, "PACKAGE", package)
    assert client.get("/health").json()["adapterManifest"] == "matches"
    code, _, status = _complete(module, client, secret, ARGUMENTS, monkeypatch, BIBLIOMETRIC)
    assert code == 0 and "evidenceNote" not in status["data"]["auditReceipt"]
    receipts.validate_receipt(_wrapper("bibliometric_analysis", ARGUMENTS, status), workspace,
                              "bibliometric_analysis", 1, expected=audit_receipt.current_evidence(agent, package))


# ---------------------------------------------------------------------------
# Evidence that cannot be taken: the job is admitted and runs, without a receipt.
# ---------------------------------------------------------------------------

def test_evidence_that_cannot_be_hashed_never_refuses_a_start(tmp_path, monkeypatch):
    module, client, secret, workspace, agent, _, _ = _setup(tmp_path, monkeypatch)
    os.link(agent / "evimed_runner.py", agent / "evimed_runner_twin.py")  # a hard link: not hashable
    with pytest.raises(audit_receipt.AuditReceiptUnavailable):
        audit_receipt.current_evidence(agent)  # this used to be an uncaught error: HTTP 500 on every start
    health = client.get("/health").json()
    assert health["sourceEvidence"] == "audit_file_invalid"
    assert health["status"] == "ok" and health["serving"] is True

    code, job_id, status = _complete(module, client, secret, ARGUMENTS, monkeypatch, BIBLIOMETRIC)
    assert code == 0 and status["status"] == "success" and status["artifacts"], status
    assert "auditReceipt" not in status["data"], "no evidence, no receipt; the output is still the job's"
    state = json.loads((workspace / f"bibliometric-analysis-runs/.jobs/{job_id}.json").read_text())
    assert "sourceEvidence" not in state
    assert state["evidenceNote"] == {"unavailable": "audit_file_invalid"}
    assert state["status"] == "succeeded"


# ---------------------------------------------------------------------------
# A source change between admission and completion, on the shared adapter.
# ---------------------------------------------------------------------------

def test_a_source_change_while_the_engine_runs_labels_the_receipt_and_the_job_stands(tmp_path, monkeypatch):
    module, client, secret, workspace, agent, _, receipts = _setup(tmp_path, monkeypatch)
    (agent / "evimed_runner.py").write_text(_runner_that_touches_source(agent), encoding="utf-8")
    code, job_id, status = _complete(module, client, secret, ARGUMENTS, monkeypatch, BIBLIOMETRIC)
    assert code == 0 and status["status"] == "success", status
    assert any(item["path"].endswith("/report.md") for item in status["artifacts"])
    state_path = workspace / f"bibliometric-analysis-runs/.jobs/{job_id}.json"
    state = json.loads(state_path.read_text())
    receipt = status["data"]["auditReceipt"]
    assert receipt["evidenceNote"] == state["evidenceNote"]
    assert receipt["evidenceNote"]["changed"] is True
    assert receipt["evidenceNote"]["admission"] == state["sourceEvidence"]
    assert receipt["evidenceNote"]["completion"] == module._source_evidence(agent)
    assert receipt["executionEvidence"] == state["sourceEvidence"]["executionEvidence"], "the proof keeps the admitted evidence"
    with pytest.raises(receipts.ReceiptError, match="source_changed"):
        receipts.validate_receipt(_wrapper("bibliometric_analysis", ARGUMENTS, status), workspace,
                                  "bibliometric_analysis", 1, expected=module._source_evidence(agent))


def test_a_source_change_before_the_worker_starts_does_not_stop_it(tmp_path, monkeypatch):
    module, client, secret, workspace, agent, _, _ = _setup(tmp_path, monkeypatch)
    spawned = []

    class Worker:
        def wait(self, timeout=None):
            return 0

    with monkeypatch.context() as patch:
        patch.setattr(module.subprocess, "Popen", lambda command, **kwargs: spawned.append(command) or Worker())
        started = client.post(BIBLIOMETRIC, json={"action": "start", **ARGUMENTS},
                              headers={"Authorization": f"Bearer {_token(secret)}"}).json()
    (agent / "src" / "bibliometric" / "pipeline.py").write_text("# marker, edited after admission\n")
    assert module.run_job(spawned[0][-1]) == 0
    state = json.loads((workspace / f"bibliometric-analysis-runs/.jobs/{started['data']['jobId']}.json").read_text())
    assert state["status"] == "succeeded" and state["evidenceNote"]["changed"] is True


def test_an_engine_that_failed_is_failed_for_its_own_reason_and_still_records_the_evidence(tmp_path, monkeypatch):
    module, client, secret, workspace, agent, _, _ = _setup(tmp_path, monkeypatch)
    succeeded = "(out/'result.json').write_text(json.dumps({'status':'succeeded'}),encoding='utf-8')\n"
    assert succeeded in RUNNER
    failing = RUNNER.replace(
        succeeded,
        _touch_source(agent)
        + "(out/'result.json').write_text(json.dumps({'status':'failed','error':'PubMed did not answer'}),encoding='utf-8')\n"
        "raise SystemExit(1)\n")
    (agent / "evimed_runner.py").write_text(failing, encoding="utf-8")
    code, job_id, status = _complete(module, client, secret, ARGUMENTS, monkeypatch, BIBLIOMETRIC)
    assert code == 1 and status["status"] == "error"
    assert "PubMed did not answer" in status["error"]["message"]
    assert "evidence" not in status["error"]["message"].lower() and "mr_input_changed" not in json.dumps(status)
    state = json.loads((workspace / f"bibliometric-analysis-runs/.jobs/{job_id}.json").read_text())
    assert state["status"] == "failed" and state["evidenceNote"]["changed"] is True


# ---------------------------------------------------------------------------
# The release reader: a record that says its evidence is off is never certified.
# ---------------------------------------------------------------------------

def test_the_release_reader_refuses_a_record_that_carries_an_evidence_note(tmp_path, monkeypatch):
    module, client, secret, workspace, agent, _, receipts = _setup(tmp_path, monkeypatch)
    code, _, status = _complete(module, client, secret, ARGUMENTS, monkeypatch, BIBLIOMETRIC)
    assert code == 0
    clean = _wrapper("bibliometric_analysis", ARGUMENTS, status)
    receipts.validate_receipt(clean, workspace, "bibliometric_analysis", 1, expected=module._source_evidence(agent))
    noted = copy.deepcopy(clean)
    noted["proof"]["evidenceNote"] = {"unavailable": "audit_file_invalid"}
    with pytest.raises(receipts.ReceiptError, match="source_changed"):
        receipts.validate_receipt(noted, workspace, "bibliometric_analysis", 1, expected=module._source_evidence(agent))
    stray = copy.deepcopy(clean)
    stray["proof"]["somethingElse"] = True
    with pytest.raises(receipts.ReceiptError, match="private_or_unknown_fields"):
        receipts.validate_receipt(stray, workspace, "bibliometric_analysis", 1, expected=module._source_evidence(agent))


def test_a_clean_checkout_health_says_so(tmp_path, monkeypatch):
    _, client, _, _, _, _, _ = _setup(tmp_path, monkeypatch)
    health = client.get("/health").json()
    assert health["adapterManifest"] == "absent"  # nothing was pinned: this is not an image
    assert health["sourceEvidence"] == "observable"
    assert health["auditReceiptsReady"] is True
