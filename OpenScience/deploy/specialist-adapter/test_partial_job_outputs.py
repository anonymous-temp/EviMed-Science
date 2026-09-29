"""A late engine failure exposes already retained usable files as partial outputs."""
import json

from test_job_receipts import RUNNER, _complete, _setup


def test_failed_job_retains_usable_files_without_claiming_success(tmp_path, monkeypatch):
    module, client, secret, workspace, agent, _, _ = _setup(tmp_path, monkeypatch)
    (agent / "evimed_runner.py").write_text(
        RUNNER + "(out/'result.json').write_text(json.dumps({'status':'failed','error':'Final narrative unavailable'}))\nraise SystemExit(7)\n"
    )
    code, job_id, status = _complete(
        module, client, secret, {"topic": "sepsis"}, monkeypatch,
        "/api/v1/evimed/bibliometric-analysis",
    )
    assert code == 7 and status["status"] == "error"
    assert status["error"]["code"] == "specialist_execution_failed"
    assert any(row["path"].endswith("report.md") for row in status.get("artifacts", []))
    assert any("partial" in warning.lower() for warning in status.get("warnings", []))
    assert any("preserve" in action.lower() for action in status["next_actions"])
    assert "data" not in status and "sources" not in status
    state = json.loads((workspace / 'bibliometric-analysis-runs' / '.jobs' / f'{job_id}.json').read_text())
    assert state['status'] == 'failed'
    assert state['artifacts'] == status['artifacts']
    assert "auditReceipt" not in state


def test_failed_job_with_only_bookkeeping_does_not_claim_partial_results(tmp_path, monkeypatch):
    module, client, secret, _, agent, _, _ = _setup(tmp_path, monkeypatch)
    (agent / "evimed_runner.py").write_text(
        "import argparse,json\nfrom pathlib import Path\n"
        "p=argparse.ArgumentParser();p.add_argument('--request');p.add_argument('--output-dir');a=p.parse_args()\n"
        "(Path(a.output_dir)/'result.json').write_text(json.dumps({'status':'failed','error':'No data found'}))\nraise SystemExit(3)\n"
    )
    code, _, status = _complete(module, client, secret, {"topic": "sepsis"}, monkeypatch,
                                 "/api/v1/evimed/bibliometric-analysis")
    assert code == 3 and status["status"] == "error"
    assert not status.get("artifacts")
