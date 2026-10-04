"""MetaAgent's optional source: the researcher's own key reaches the job, and a source not used is said.

Owner ruling 2026-10-04: a data source nobody configured is the researcher's to
configure where they use it, and the job goes on in place. The other engines got a
job-scoped credential fetch first; MetaAgent had none, so a researcher who had saved
their own EviMed evidence key was served exactly like one who had not, and a run with
no key at all recorded nothing about the source it had gone without.
"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from new_meta import evimed_adapter
from new_meta.core import job_credentials
from new_meta.core.project import Project
from new_meta.main import _add_evidence_context_references
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.tools.evimed_evidence import search_evimed_evidence, source_status
from new_meta.tools.reference_manager import ReferenceManager
from test_evimed_adapter import _LiveWorker, _fixture, _post, _token

URL = "http://control-plane.internal/internal/connectors/v1/credential"
OWN_EVIDENCE = "alice-own-evimed-key"
OWN_NCBI = "alice-own-ncbi-key"


class _Answer:
    def __init__(self, payload):
        self.payload = payload

    def read(self, _limit):
        return json.dumps(self.payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def _control_plane(monkeypatch, answers):
    """A control plane that answers `answers[connector]` (the researcher's own key) or has none for it."""
    asked = []

    def urlopen(request, timeout=None):
        connector = request.full_url.split("connector=")[1]
        asked.append((connector, request.get_header("Authorization")))
        if connector not in answers:
            raise job_credentials.urllib.error.HTTPError(request.full_url, 404, "none", {}, None)
        return _Answer({"data": {"connector": connector, "source": "user", "value": answers[connector]}})

    monkeypatch.setattr(job_credentials.urllib.request, "urlopen", urlopen)
    return asked


def _bare_environment(monkeypatch):
    for name in ("PUBMED_API_KEY", "PUBMED_API_KEY_FILE", "EVIMED_API_KEY", "EVIMED_API_KEY_FILE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(job_credentials.CREDENTIAL_URL_ENV, URL)


# ---------------------------------------------------------------------------
# The roster is the control plane's, and the fetch itself.
# ---------------------------------------------------------------------------

def test_the_roster_is_what_the_control_plane_answers_for() -> None:
    assert job_credentials.CONNECTORS == {"ncbi": "PUBMED_API_KEY", "evimed-evidence": "EVIMED_API_KEY"}
    # The engine reads exactly these variables.
    config = (Path(__file__).resolve().parents[1] / "new_meta" / "config.py").read_text(encoding="utf-8")
    assert 'os.getenv("PUBMED_API_KEY"' in config and 'read_secret("EVIMED_API_KEY")' in config


def test_the_researchers_own_keys_are_asked_for_with_their_workload_token(monkeypatch) -> None:
    _bare_environment(monkeypatch)
    asked = _control_plane(monkeypatch, {"ncbi": OWN_NCBI, "evimed-evidence": OWN_EVIDENCE})
    assert job_credentials.resolve("workload-token") == {
        f"{job_credentials.PREFIX}PUBMED_API_KEY": OWN_NCBI,
        f"{job_credentials.PREFIX}EVIMED_API_KEY": OWN_EVIDENCE,
    }
    assert asked == [("ncbi", "Bearer workload-token"), ("evimed-evidence", "Bearer workload-token")]


def test_the_deployments_own_key_wins_and_nothing_is_asked(monkeypatch, tmp_path) -> None:
    _bare_environment(monkeypatch)
    asked = _control_plane(monkeypatch, {"ncbi": OWN_NCBI, "evimed-evidence": OWN_EVIDENCE})
    monkeypatch.setenv("PUBMED_API_KEY", "deployment-ncbi-key")
    key_file = tmp_path / "evimed.key"
    key_file.write_text("deployment-evimed-key\n", encoding="utf-8")
    monkeypatch.setenv("EVIMED_API_KEY_FILE", str(key_file))
    assert job_credentials.resolve("workload-token") == {}
    assert asked == []
    # An unreadable file, an empty one and /dev/null are a deployment without a key.
    for location in (str(tmp_path / "missing"), "/dev/null", str(tmp_path)):
        monkeypatch.setenv("EVIMED_API_KEY_FILE", location)
        monkeypatch.delenv("PUBMED_API_KEY")
        assert set(job_credentials.resolve("workload-token")) == {
            f"{job_credentials.PREFIX}PUBMED_API_KEY", f"{job_credentials.PREFIX}EVIMED_API_KEY"}
        monkeypatch.setenv("PUBMED_API_KEY", "deployment-ncbi-key")


def test_nothing_is_asked_without_a_url_a_token_or_a_key_to_ask_for(monkeypatch) -> None:
    _bare_environment(monkeypatch)
    asked = _control_plane(monkeypatch, {"evimed-evidence": OWN_EVIDENCE})
    assert job_credentials.resolve(None) == {} and job_credentials.resolve("") == {}
    monkeypatch.delenv(job_credentials.CREDENTIAL_URL_ENV)
    assert job_credentials.resolve("workload-token") == {}
    assert asked == []


def test_a_control_plane_that_cannot_answer_leaves_the_engine_on_its_own_environment(monkeypatch) -> None:
    _bare_environment(monkeypatch)
    # The researcher saved no NCBI key: that connector answers 404, the other still resolves.
    _control_plane(monkeypatch, {"evimed-evidence": OWN_EVIDENCE})
    assert job_credentials.resolve("workload-token") == {f"{job_credentials.PREFIX}EVIMED_API_KEY": OWN_EVIDENCE}

    def down(request, timeout=None):
        raise TimeoutError("slow")

    monkeypatch.setattr(job_credentials.urllib.request, "urlopen", down)
    assert job_credentials.resolve("workload-token") == {}
    for payload in ({"data": {"value": "has whitespace"}}, {"data": {"value": "x" * 9000}}, {"data": {"value": ""}},
                    {"data": []}, {"nodata": 1}, []):
        monkeypatch.setattr(job_credentials.urllib.request, "urlopen", lambda r, timeout=None, payload=payload: _Answer(payload))
        assert job_credentials.resolve("workload-token") == {}


def test_the_worker_maps_the_prefixed_key_onto_the_engines_variable_and_drops_the_prefixed_name() -> None:
    environment = {f"{job_credentials.PREFIX}EVIMED_API_KEY": OWN_EVIDENCE, f"{job_credentials.PREFIX}UNLISTED": "x", "PATH": "/bin"}
    job_credentials.apply(environment)
    assert environment == {"EVIMED_API_KEY": OWN_EVIDENCE, "PATH": "/bin"}
    # Where the deployment holds one by now, it stays.
    held = {f"{job_credentials.PREFIX}PUBMED_API_KEY": OWN_NCBI, "PUBMED_API_KEY": "deployment"}
    job_credentials.apply(held)
    assert held == {"PUBMED_API_KEY": "deployment"}


# ---------------------------------------------------------------------------
# The adapter: the keys ride the spawn environment, never the state file.
# ---------------------------------------------------------------------------

def test_a_start_hands_the_researchers_keys_to_the_worker_environment_only(tmp_path, monkeypatch) -> None:
    client, workspace = _fixture(tmp_path, monkeypatch)
    _bare_environment(monkeypatch)
    _control_plane(monkeypatch, {"ncbi": OWN_NCBI, "evimed-evidence": OWN_EVIDENCE})
    launched = []
    monkeypatch.setattr(evimed_adapter.subprocess, "Popen", lambda command, **kwargs: launched.append(kwargs) or _LiveWorker())
    evimed_adapter._WORKERS.clear()

    started = _post(client, {"action": "start", "topic": "Intervention A versus B for outcome C"}, token=_token()).json()

    assert started["status"] == "warning", started
    environment = launched[0]["env"]
    assert environment[f"{job_credentials.PREFIX}EVIMED_API_KEY"] == OWN_EVIDENCE
    assert environment[f"{job_credentials.PREFIX}PUBMED_API_KEY"] == OWN_NCBI
    for path in (workspace / "meta-analysis-runs").rglob("*"):
        if path.is_file():
            text = path.read_text(encoding="utf-8", errors="replace")
            assert OWN_EVIDENCE not in text and OWN_NCBI not in text, f"a key reached {path.name}"


def test_a_resume_hands_them_over_too(tmp_path, monkeypatch) -> None:
    client, workspace = _fixture(tmp_path, monkeypatch)
    _bare_environment(monkeypatch)
    _control_plane(monkeypatch, {"evimed-evidence": OWN_EVIDENCE})
    launched = []
    monkeypatch.setattr(evimed_adapter.subprocess, "Popen", lambda command, **kwargs: launched.append(kwargs) or _LiveWorker())
    evimed_adapter._WORKERS.clear()
    body = {"action": "start", "topic": "Intervention A versus B for outcome C"}
    job_id = _post(client, body).json()["data"]["jobId"]
    state_path = workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state.update(status="failed", error="killed")
    state_path.write_text(json.dumps(state), encoding="utf-8")
    (workspace / "meta-analysis-runs" / job_id / "output" / "project").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(evimed_adapter, "_resumable_project", lambda output_root: output_root / "project")

    resumed = _post(client, body).json()

    assert resumed["data"].get("resumed") is True, resumed
    assert launched[-1]["env"][f"{job_credentials.PREFIX}EVIMED_API_KEY"] == OWN_EVIDENCE


def test_the_engine_process_gets_the_key_under_its_own_name(tmp_path, monkeypatch) -> None:
    client, workspace = _fixture(tmp_path, monkeypatch)
    _bare_environment(monkeypatch)
    _control_plane(monkeypatch, {"evimed-evidence": OWN_EVIDENCE})
    monkeypatch.setattr(evimed_adapter.subprocess, "Popen", lambda command, **kwargs: _LiveWorker())
    evimed_adapter._WORKERS.clear()
    job_id = _post(client, {"action": "start", "topic": "Intervention A versus B for outcome C"}).json()["data"]["jobId"]
    # What the worker's own environment holds after the adapter spawned it.
    monkeypatch.setenv(f"{job_credentials.PREFIX}EVIMED_API_KEY", OWN_EVIDENCE)
    seen = {}

    def run(command, **kwargs):
        seen.update(kwargs["env"])
        return SimpleNamespace(returncode=1)

    monkeypatch.setattr(evimed_adapter.subprocess, "run", run)
    evimed_adapter.run_job(str(workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json"))

    assert seen["EVIMED_API_KEY"] == OWN_EVIDENCE
    assert f"{job_credentials.PREFIX}EVIMED_API_KEY" not in seen


# ---------------------------------------------------------------------------
# The source not used is recorded, with why.
# ---------------------------------------------------------------------------

def test_the_evidence_tool_says_why_it_was_not_used() -> None:
    assert search_evimed_evidence("heart failure guideline", api_key="")["status"] == "disabled"
    assert source_status(search_evimed_evidence("heart failure guideline", api_key="")) == "not_configured"
    assert source_status({"status": "error", "message": "http_401"}) == "refused"
    assert source_status({"status": "error", "message": "http_403"}) == "refused"
    assert source_status({"status": "error", "message": "http_429"}) == "refused"
    assert source_status({"status": "error", "message": "http_500"}) == "unreachable"
    assert source_status({"status": "error", "message": "timeout"}) == "unreachable"
    assert source_status({"status": "ok", "references": []}) is None, "an answer with nothing relevant is a source that was used"
    assert source_status({"status": "skipped"}) is None and source_status(None) is None


def _protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Do SGLT2 inhibitors improve outcomes in heart failure?",
        pico=PICO(population="Adults with heart failure", intervention="SGLT2 inhibitors", comparator="Placebo",
                  outcome_primary="Cardiovascular death or hospitalization for heart failure"),
        effect_measure="HR", model_preference="random",
    )


def _warnings(project: Project) -> list[dict]:
    return project.load_json("pipeline_warnings.json") or []


def test_each_reason_is_a_warning_with_its_own_code_and_a_later_answer_clears_it(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("new_meta.main.pubmed.search", lambda query, max_results=6: [])
    for context, code, status in [
        ({"status": "disabled", "query": "q", "references": [], "message": "missing_evimed_api_key"},
         "evimed_evidence_not_configured", "not_configured"),
        ({"status": "error", "query": "q", "references": [], "message": "http_403"}, "evimed_evidence_refused", "refused"),
        ({"status": "error", "query": "q", "references": [], "message": "timeout"}, "evimed_evidence_search_failed", "unreachable"),
    ]:
        project = Project(f"unused-{status}", output_dir=tmp_path)
        monkeypatch.setattr("new_meta.main.search_evimed_evidence", lambda query, context=context: context)
        _add_evidence_context_references(project, _protocol(), ReferenceManager())
        warnings = _warnings(project)
        assert [(item["stage"], item["code"], item["severity"]) for item in warnings] == [("search", code, "warning")], warnings
        assert warnings[0]["context"]["sourceStatus"] == status
        assert "background citation enrichment was skipped" in warnings[0]["message"]
        assert "missing_evimed_api_key" not in json.dumps(warnings) or status == "not_configured"
        # The same project, asked again once the source answers: the warning is cleared.
        monkeypatch.setattr("new_meta.main.search_evimed_evidence", lambda query: {"status": "ok", "query": query, "references": []})
        (project.base_dir / "search" / "evidence_context.json").unlink(missing_ok=True)
        _add_evidence_context_references(project, _protocol(), ReferenceManager())
        assert _warnings(project) == []


def _written_project(workspace: Path, job_id: str, *, warning_code: str | None) -> None:
    project = workspace / "meta-analysis-runs" / job_id / "output" / "project"
    (project / "manuscript").mkdir(parents=True)
    (project / "package").mkdir(parents=True)
    (project / "manuscript" / "draft.md").write_text("# Result\n", encoding="utf-8")
    (project / "package" / "release_decision.json").write_text(json.dumps({"status": "ready", "next_actions": []}), encoding="utf-8")
    if warning_code:
        (project / "pipeline_warnings.json").write_text(json.dumps([
            {"stage": "search", "code": warning_code, "severity": "warning", "message": "Evimed evidence search was not used"},
        ]), encoding="utf-8")


def _run_to_a_result(client, workspace, monkeypatch, *, warning_code):
    monkeypatch.setattr(evimed_adapter.subprocess, "Popen", lambda command, **kwargs: _LiveWorker())
    evimed_adapter._WORKERS.clear()
    job_id = _post(client, {"action": "start", "topic": "Intervention A versus B for outcome C"}).json()["data"]["jobId"]

    def run(command, **kwargs):
        _written_project(workspace, job_id, warning_code=warning_code)
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(evimed_adapter.subprocess, "run", run)
    assert evimed_adapter.run_job(str(workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json")) == 0
    return job_id, _post(client, {"action": "status", "jobId": job_id}).json()


def test_the_job_result_states_which_source_was_not_used_and_why(tmp_path, monkeypatch) -> None:
    for code, status in [("evimed_evidence_not_configured", "not_configured"), ("evimed_evidence_refused", "refused"),
                         ("evimed_evidence_search_failed", "unreachable")]:
        client, workspace = _fixture(tmp_path / status, monkeypatch)
        _bare_environment(monkeypatch)
        job_id, result = _run_to_a_result(client, workspace, monkeypatch, warning_code=code)
        expected = [{"source": "evimed-evidence", "label": "EviMed evidence", "status": status}]
        assert result["status"] == "success", result
        assert result["data"]["sourcesNotUsed"] == expected
        assert "EviMed evidence (" + status.replace("_", " ") + ")" in result["warnings"][0]
        assert "设置 → 数据源" in result["warnings"][0]
        state = json.loads((workspace / "meta-analysis-runs" / ".jobs" / f"{job_id}.json").read_text(encoding="utf-8"))
        assert state["sourcesNotUsed"] == expected and state["status"] == "succeeded"


def test_a_job_that_used_every_source_says_nothing_of_the_kind(tmp_path, monkeypatch) -> None:
    client, workspace = _fixture(tmp_path, monkeypatch)
    _bare_environment(monkeypatch)
    _, result = _run_to_a_result(client, workspace, monkeypatch, warning_code=None)
    assert result["status"] == "success"
    assert "sourcesNotUsed" not in result["data"] and "warnings" not in result
