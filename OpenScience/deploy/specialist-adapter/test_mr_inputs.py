"""Hosted MR producer/worker tests; no statistical engine or model is called."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest
from test_service import _load_service, _token


def local_source(path: str, *, clumped: bool = True) -> dict:
    return {
        "type": "local_file",
        "path": path,
        "columnMapping": {
            "snp": "variant",
            "beta": "effect",
            "se": "stderr",
            "effect_allele": "A1",
            "other_allele": "A2",
            "eaf": "freq",
            "pval": "p",
        },
        "sampleSize": 10000,
        "population": "European",
        "instrumentsPreclumped": clumped,
        **(
            {
                "clumpingProvenance": (
                    "Provided study instruments, r2 < 0.001, "
                    "10 Mb; provider declaration."
                )
            }
            if clumped
            else {}
        ),
    }


def setup_mr(tmp_path, monkeypatch):
    service, client, secret, workspace = _load_service(
        tmp_path, monkeypatch, kind="mendelian-randomization"
    )
    agent = tmp_path / "agent"
    (agent / "mr_agent/core").mkdir(parents=True)
    (agent / "mr_agent/core/engine.py").write_text("# fixed fake MR marker\n")
    agent_source = Path(__file__).resolve().parents[3] / "项目代码/孟德尔随机化"
    for name in ("evimed_local_inputs.py", "evimed_mr_job.py"):
        (agent / name).write_bytes((agent_source / name).read_bytes())
    (agent / "evimed_runner.py").write_text(
        "import argparse,json,os\nfrom pathlib import Path\n"
        "p=argparse.ArgumentParser();p.add_argument('--request');p.add_argument('--output-dir');p.add_argument('--input-authority-fd',type=int);p.add_argument('--working-directory-fd',type=int);a=p.parse_args()\n"
        "os.fchdir(a.working_directory_fd);authority=json.load(os.fdopen(a.input_authority_fd))\n"
        "out=Path(a.output_dir);request=json.loads(Path(a.request).re"
        "ad_text());assert authority['request']==request\n"
        "(out/'received.json').write_text(json.dumps(request))\n"
        "(out/'result.json').write_text(json.dumps({'status':'succeeded'}))\n"
    )
    return service, client, secret, workspace


def test_uploaded_mr_sources_reach_the_fixed_runner_as_standardized_job_files(
    tmp_path, monkeypatch
):
    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    (workspace / "data").mkdir()
    original = "variant,effect,stderr,A1,A2,freq,p\nrs1,0.2,0.01,A,G,0.2,1e-10\n"
    (workspace / "data/exposure.csv").write_text(original)
    (workspace / "data/outcome.tsv").write_text(original.replace(",", "\t"))
    queued = []

    class QueuedWorker:
        def wait(self, timeout=None):
            return 0

    with monkeypatch.context() as patch:
        patch.setattr(
            service.subprocess,
            "Popen",
            lambda command, **_kwargs: queued.append(command) or QueuedWorker(),
        )
        response = client.post(
            "/api/v1/evimed/mendelian-randomization",
            headers={"Authorization": f"Bearer {_token(secret)}"},
            json={
                "action": "start",
                "exposure": "BMI",
                "outcome": "CHD",
                "analysisDirection": "forward",
                "exposureSource": local_source("data/exposure.csv"),
                "outcomeSource": local_source("data/outcome.tsv", clumped=False),
            },
        )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "warning"
    assert len(queued) == 1
    assert service.run_job(queued[0][-1]) == 0
    job_id = response.json()["data"]["jobId"]
    output = workspace / "mendelian-randomization-runs" / job_id / "output"
    received = json.loads((output / "received.json").read_text())
    assert received["exposureSource"]["path"] == "inputs/exposure.csv"
    assert received["outcomeSource"]["path"] == "inputs/outcome.csv"
    assert received["exposureSource"]["columnMapping"]["snp"] == "SNP"
    assert (output / "inputs/exposure.csv").read_text().splitlines()[
        0
    ] == "SNP,beta,se,effect_allele,other_allele,eaf,pval"
    provenance = json.loads(
        (output / "mendelian-randomization-inputs.json").read_text()
    )
    assert provenance["sources"]["exposure"]["path"] == "data/exposure.csv"
    assert provenance["sources"]["exposure"]["ld_rechecked"] is False
    assert str(tmp_path) not in json.dumps(provenance)
    assert (workspace / "data/exposure.csv").read_text() == original
    result = service._status({"jobId": job_id}, workspace)
    assert result["status"] == "success"
    assert any(
        item["path"].endswith("mendelian-randomization-inputs.json")
        for item in result["artifacts"]
    )
    assert all(not item["path"].startswith("/") for item in result["artifacts"])


def queue_job(service, client, secret, monkeypatch, *, user="user1", local=True):
    commands = []

    class QueuedWorker:
        def wait(self, timeout=None):
            return 0

    request = {
        "action": "start",
        "exposure": "BMI",
        "outcome": "CHD",
        "analysisDirection": "forward",
    }
    if local:
        request.update(
            exposureSource=local_source("data/exposure.csv"),
            outcomeSource=local_source("data/outcome.csv", clumped=False),
        )
    with monkeypatch.context() as patch:
        patch.setattr(
            service.subprocess,
            "Popen",
            lambda command, **_kwargs: commands.append(command) or QueuedWorker(),
        )
        response = client.post(
            "/api/v1/evimed/mendelian-randomization",
            json=request,
            headers={"Authorization": f"Bearer {_token(secret, user=user)}"},
        )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "warning", response.text
    return Path(commands[0][-1]), response.json()["data"]["jobId"]


def write_sources(workspace, variant):
    (workspace / "data").mkdir(parents=True, exist_ok=True)
    for role in ("exposure", "outcome"):
        (workspace / f"data/{role}.csv").write_text(
            f"variant,effect,stderr,A1,A2,freq,p\n{variant},0.2,0.01,A,G,0.2,1e-10\n"
        )


def test_same_filenames_are_bound_to_the_authenticated_account_and_active_workspace(
    tmp_path, monkeypatch
):
    service, client, secret, base = setup_mr(tmp_path, monkeypatch)
    write_sources(base, "rs999")
    (base.parent / "project.json").write_text(
        json.dumps({"activeWorkspace": "analysis"})
    )
    active = base / "analysis"
    write_sources(active, "rs101")
    other = tmp_path / "data/users/user2/projects/project1/workspace"
    write_sources(other, "rs202")
    for user, workspace, expected in (
        ("user1", active, "rs101"),
        ("user2", other, "rs202"),
    ):
        state, job_id = queue_job(service, client, secret, monkeypatch, user=user)
        assert service.run_job(str(state)) == 0
        output = workspace / "mendelian-randomization-runs" / job_id / "output"
        assert (
            (output / "inputs/exposure.csv")
            .read_text()
            .splitlines()[1]
            .startswith(expected + ",")
        )
        assert service._status({"jobId": job_id}, workspace)["status"] == "success"
    assert "rs999" in (base / "data/exposure.csv").read_text()


def test_worker_rejects_replaced_input_and_mcp_preserves_its_error_envelope(
    tmp_path, monkeypatch
):
    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    write_sources(workspace, "rs101")
    state, job_id = queue_job(service, client, secret, monkeypatch)
    (workspace / "data/exposure.csv").write_text("replacement input")
    assert service.run_job(str(state)) == 1
    finished = service._status({"jobId": job_id}, workspace)
    assert finished["status"] == "error"
    assert finished["error"]["code"] == "mr_input_changed"
    assert "data" not in finished and "sources" not in finished
    assert str(tmp_path) not in json.dumps(finished)
    mcp_file = (
        Path(__file__).resolve().parents[2] / "runtime/mcp/evimed-research/server.py"
    )
    spec = importlib.util.spec_from_file_location(
        "mr_adapter_mcp_normalization", mcp_file
    )
    mcp = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mcp)
    normalized = mcp._normalize_tool_result(
        "mendelian_randomization", finished, {"action": "status", "jobId": job_id}, {}
    )
    assert normalized["error"]["code"] == "mr_input_changed"
    assert "data" not in normalized and "sources" not in normalized


def test_worker_state_symlink_cannot_select_another_accounts_queued_job(
    tmp_path, monkeypatch
):
    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    other = tmp_path / "data/users/user2/projects/project1/workspace"
    write_sources(workspace, "rs101")
    write_sources(other, "rs202")
    owned_state, _ = queue_job(service, client, secret, monkeypatch)
    victim_state, victim_id = queue_job(
        service, client, secret, monkeypatch, user="user2"
    )
    before = victim_state.read_bytes()
    owned_state.unlink()
    owned_state.symlink_to(victim_state)
    with pytest.raises(ValueError, match="unavailable or unsafe"):
        service.run_job(str(owned_state))
    assert victim_state.read_bytes() == before
    assert not (
        other / "mendelian-randomization-runs" / victim_id / "output/received.json"
    ).exists()


def test_legacy_remote_text_request_still_reaches_the_same_fixed_runner(
    tmp_path, monkeypatch
):
    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    state, job_id = queue_job(service, client, secret, monkeypatch, local=False)
    assert service.run_job(str(state)) == 0
    output = workspace / "mendelian-randomization-runs" / job_id / "output"
    assert json.loads((output / "received.json").read_text()) == {
        "exposure": "BMI",
        "outcome": "CHD",
        "analysisDirection": "forward",
    }
    assert not (output / "mendelian-randomization-inputs.json").exists()


def test_output_directory_replacement_receives_no_worker_request_or_results(
    tmp_path, monkeypatch
):
    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    write_sources(workspace, "rs101")
    state, job_id = queue_job(service, client, secret, monkeypatch)
    output = workspace / "mendelian-randomization-runs" / job_id / "output"
    helper = service._mr_inputs()
    prepare = helper.prepare_sources

    def prepare_then_move(*args, **kwargs):
        authority = prepare(*args, **kwargs)
        output.rename(output.with_name("reserved-output"))
        output.mkdir()
        return authority

    monkeypatch.setattr(helper, "prepare_sources", prepare_then_move)
    monkeypatch.setattr(service, "_mr_inputs", lambda _root=None: helper)
    assert service.run_job(str(state)) == 1
    assert list(output.iterdir()) == []
    assert list(output.with_name("reserved-output").iterdir()) == []
    terminal = service._status({"jobId": job_id}, workspace)
    assert terminal["error"]["code"] == "mr_input_changed"
    assert "data" not in terminal and "sources" not in terminal


def test_accepted_request_and_status_use_only_the_protected_queue(
    tmp_path, monkeypatch
):
    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    write_sources(workspace, "rs101")
    state, job_id = queue_job(service, client, secret, monkeypatch)
    assert workspace not in state.parents
    assert workspace.parent / ".openscience" in state.parents
    accepted = service._read_state(state)
    assert accepted["schemaVersion"] == 2
    assert accepted["queueContext"]["userId"] == "user1"
    assert accepted["queueContext"]["projectId"] == "project1"
    assert accepted["queueContext"]["activeWorkspace"] == ""
    assert accepted["queueGeneration"]
    shadow = workspace / "mendelian-randomization-runs/.jobs" / f"{job_id}.json"
    shadow.parent.mkdir(parents=True)
    shadow.write_text(json.dumps({"request": {"exposure": "Updated workspace note"}}))
    worker = service.subprocess.run(
        [
            service.sys.executable,
            "-m",
            "evimed_specialist_adapter.service",
            "--run-job",
            str(state),
        ],
        cwd=str(Path(service.__file__).resolve().parents[1]),
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert worker.returncode == 0, worker.stderr
    output = workspace / "mendelian-randomization-runs" / job_id / "output"
    received = json.loads((output / "received.json").read_text())
    assert received["exposure"] == accepted["request"]["exposure"] == "BMI"
    assert received["outcome"] == accepted["request"]["outcome"] == "CHD"
    shadow.write_text(json.dumps({"status": "failed"}))
    assert service._status({"jobId": job_id}, workspace)["status"] == "success"
    assert service._read_state(state)["request"] == accepted["request"]


def test_workspace_generation_change_does_not_reuse_queue_authority(
    tmp_path, monkeypatch
):
    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    write_sources(workspace, "rs101")
    old_state, old_id = queue_job(service, client, secret, monkeypatch)
    old_generation = service._read_state(old_state)["queueGeneration"]
    workspace.rename(workspace.with_name("old-workspace"))
    write_sources(workspace, "rs202")
    new_state, new_id = queue_job(service, client, secret, monkeypatch)
    new_generation = service._read_state(new_state)["queueGeneration"]
    assert new_generation != old_generation
    assert service._status({"jobId": old_id}, workspace)["status"] == "error"
    assert service.run_job(str(old_state)) == 1
    assert service._read_state(new_state)["status"] == "queued"
    assert service.run_job(str(new_state)) == 0
    assert service._status({"jobId": new_id}, workspace)["status"] == "success"


@pytest.mark.parametrize("fail", [False, True])
def test_analysis_scratch_is_cleaned_and_never_published(tmp_path, monkeypatch, fail):
    service, client, secret, workspace = setup_mr(tmp_path, monkeypatch)
    source = Path(__file__).resolve().parents[3] / "项目代码/孟德尔随机化"
    agent = tmp_path / "agent"
    observer = tmp_path / "scratch-observed.json"
    (agent / "evimed_runner.py").write_bytes((source / "evimed_runner.py").read_bytes())
    (agent / "mr_agent/models.py").write_bytes(
        (source / "mr_agent/models.py").read_bytes()
    )
    (agent / "mr_agent/__init__.py").write_text("")
    (agent / "mr_agent/core/__init__.py").write_text("")
    (agent / "mr_agent/tools").mkdir()
    (agent / "mr_agent/tools/__init__.py").write_text("")
    (agent / "mr_agent/tools/gwas.py").write_text(
        "# No remote sources in this fixture.\n"
    )
    (agent / "mr_agent/core/engine.py").write_text(
        "import json,tempfile\nfrom pathlib import Path\n"
        "from types import SimpleNamespace\n"
        "from mr_agent.models import DataSourceType,MRAnalysisResult\n"
        "class MRAgent:\n"
        " def __init__(self,language):\n"
        "  self.state=SimpleNamespace(slots=SimpleNamespace(),analysis_results=[],"
        "errors=[],paper_sections={},output_dir=None)\n"
        " def _run_analysis(self):\n"
        "  analysis=Path(tempfile.mkdtemp(prefix='mr_analysis_'))\n"
        "  self.state.output_dir=analysis\n"
        "  (analysis/'raw-script.R').write_text('# Internal fixture only.\\n')\n"
        "  (analysis/'internal-only.log').write_text('Internal fixture only.\\n')\n"
        f"  Path({str(observer)!r}).write_text(json.dumps({{"
        "'scratch':tempfile.gettempdir(),'analysis':str(analysis),"
        "'input':str(Path(self.state.slots.exposure_source.file_path).parent)}))\n"
        f"  if {fail!r}: raise RuntimeError('Controlled fixture failure')\n"
        "  self.state.analysis_results=[MRAnalysisResult(exposure_id='exposure.csv',"
        "outcome_id='outcome.csv',n_instruments=1,"
        "exposure_source_type=DataSourceType.LOCAL_FILE,"
        "outcome_source_type=DataSourceType.LOCAL_FILE)]\n"
        "  return 'Fixture completed.'\n"
        " def _run_paper_generation(self):\n"
        "  self.state.paper_sections={'abstract':"
        "'The supplied dataset describes 10,000 participants; "
        "inputs were not independently verified. '*15}\n"
    )
    compile((agent / "mr_agent/core/engine.py").read_text(), "fake_engine.py", "exec")
    write_sources(workspace, "rs101")
    state, job_id = queue_job(service, client, secret, monkeypatch)
    assert service.run_job(str(state)) == (1 if fail else 0)
    observed = json.loads(observer.read_text())
    scratch = Path(observed["scratch"])
    assert scratch.name.startswith("evimed-mr-scratch-")
    assert Path(observed["analysis"]).parent == scratch
    assert Path(observed["input"]).parent == scratch
    assert not scratch.exists()
    assert not Path(observed["analysis"]).exists()
    assert not Path(observed["input"]).exists()
    output = workspace / "mendelian-randomization-runs" / job_id / "output"
    published = [path.relative_to(output).as_posix() for path in output.rglob("*")]
    assert not any("mr_analysis_" in path or "scratch" in path for path in published)
    assert not any(path.endswith((".R", ".log")) for path in published)
    if not fail:
        assert "mendelian-randomization-report.md" in published
        assert "mendelian-randomization-inputs.json" in published
