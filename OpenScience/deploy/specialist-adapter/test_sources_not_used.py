"""An engine that went on without an optional source says which, and why, in its job result.

The MR engine's UMLS path and the bibliometric engine's OpenAlex path wrote one log
line when the source was not used, so the result read as if it had been. Each engine
now states it in its own `result.json` (`sourcesNotUsed`: not_configured / refused /
unreachable) and in the report where the sources are listed; this is the adapter
carrying that statement to the poller, and the EviMed evidence key's deployment-first
rule for the drug-safety engine.
"""
from __future__ import annotations

import json

import pytest

from test_job_receipts import RUNNER, _complete, _setup
from test_job_credentials import _Answer
from test_service import _load_service, _token

BIBLIOMETRIC = "/api/v1/evimed/bibliometric-analysis"
SOURCE = {"source": "openalex", "label": "OpenAlex", "status": "not_configured"}


def _engine_writing(rows) -> str:
    return RUNNER.replace(
        "(out/'result.json').write_text(json.dumps({'status':'succeeded'}),encoding='utf-8')\n",
        f"(out/'result.json').write_text(json.dumps({{'status':'succeeded','sourcesNotUsed':{rows!r}}}),encoding='utf-8')\n",
    )


def test_a_source_the_engine_did_not_use_reaches_the_poller_with_a_sentence_to_relay(tmp_path, monkeypatch) -> None:
    module, client, secret, workspace, agent, _, _ = _setup(tmp_path, monkeypatch)
    (agent / "evimed_runner.py").write_text(_engine_writing([SOURCE]), encoding="utf-8")

    code, job_id, status = _complete(module, client, secret, {"topic": "sepsis"}, monkeypatch, BIBLIOMETRIC)

    assert code == 0 and status["status"] == "success", status
    assert status["data"]["sourcesNotUsed"] == [SOURCE]
    assert len(status["warnings"]) == 1
    assert "OpenAlex (not configured)" in status["warnings"][0] and "设置 → 数据源" in status["warnings"][0]
    state = json.loads((workspace / "bibliometric-analysis-runs" / ".jobs" / f"{job_id}.json").read_text())
    assert state["status"] == "succeeded" and state["sourcesNotUsed"] == [SOURCE]


def test_a_job_that_used_every_source_carries_nothing_of_the_kind(tmp_path, monkeypatch) -> None:
    module, client, secret, workspace, _, _, _ = _setup(tmp_path, monkeypatch)
    code, job_id, status = _complete(module, client, secret, {"topic": "sepsis"}, monkeypatch, BIBLIOMETRIC)
    assert code == 0 and status["status"] == "success"
    assert "sourcesNotUsed" not in status["data"] and "warnings" not in status
    state = json.loads((workspace / "bibliometric-analysis-runs" / ".jobs" / f"{job_id}.json").read_text())
    assert "sourcesNotUsed" not in state


@pytest.mark.parametrize("rows", [
    "not a list", {"source": "x"}, None, [None, 3, "x", []],
    [{"source": "openalex", "label": "OpenAlex", "status": "gone_fishing"}],
    [{"source": "", "label": "OpenAlex", "status": "refused"}],
    [{"source": "openalex", "label": "O" * 81, "status": "refused"}],
    [{"source": "openalex", "label": "Open\nAlex", "status": "refused"}],
    [{"source": "openalex", "label": 7, "status": "refused"}],
])
def test_only_the_closed_shape_survives_the_trip_through_the_result(tmp_path, monkeypatch, rows) -> None:
    module, *_ = _load_service(tmp_path, monkeypatch)
    assert module._sources_not_used({"sourcesNotUsed": rows}) == []
    assert module._sources_not_used_warning(rows) is None


def test_the_list_is_bounded_and_keeps_a_bounded_fallback(tmp_path, monkeypatch) -> None:
    module, *_ = _load_service(tmp_path, monkeypatch)
    many = [{"source": f"s{index}", "label": f"S{index}", "status": "unreachable"} for index in range(20)]
    assert len(module._sources_not_used({"sourcesNotUsed": many})) == 8
    kept = module._sources_not_used({"sourcesNotUsed": [{**SOURCE, "fallback": "llm", "module": "ignored", "extra": 1},
                                                        {**SOURCE, "source": "umls", "fallback": "x" * 41}]})
    assert kept == [{**SOURCE, "fallback": "llm"}, {**SOURCE, "source": "umls"}]


# --- the EviMed evidence key, drug-safety: the deployment's own wins -------------

CREDENTIAL_URL = "http://control-plane.internal/internal/connectors/v1/credential"


def _drug_safety(tmp_path, monkeypatch):
    # Reuses the fixture engine of the bibliometric kind and answers as drug safety.
    module, client, secret, workspace = _load_service(tmp_path, monkeypatch, kind="bibliometric-analysis")
    monkeypatch.setattr(module, "_kind", lambda: "drug-safety-analysis")
    monkeypatch.setenv("EVIMED_CONNECTOR_CREDENTIAL_URL", CREDENTIAL_URL)
    for name in ("OPENFDA_API_KEY", "EVIMED_EVIDENCE_SEARCH_KEY", "EVIMED_EVIDENCE_SEARCH_KEY_FILE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("OPENFDA_API_KEY", "deployment-openfda")
    asked = []
    monkeypatch.setattr(module.urllib.request, "urlopen", lambda request, timeout=None: (
        asked.append(request.full_url.rsplit("connector=", 1)[1]),
        _Answer({"data": {"value": "alice-evimed-evidence"}}))[1])
    return module, _token(secret), asked


def test_a_researchers_evidence_key_fills_the_gap_where_the_deployment_has_none(tmp_path, monkeypatch) -> None:
    module, token, asked = _drug_safety(tmp_path, monkeypatch)
    for shape in ("unset", "dev-null", "empty", "missing"):
        asked.clear()
        if shape == "unset":
            monkeypatch.delenv("EVIMED_EVIDENCE_SEARCH_KEY_FILE", raising=False)
        elif shape == "dev-null":
            monkeypatch.setenv("EVIMED_EVIDENCE_SEARCH_KEY_FILE", "/dev/null")
        elif shape == "empty":
            (tmp_path / "empty.key").write_text("", encoding="utf-8")
            monkeypatch.setenv("EVIMED_EVIDENCE_SEARCH_KEY_FILE", str(tmp_path / "empty.key"))
        else:
            monkeypatch.setenv("EVIMED_EVIDENCE_SEARCH_KEY_FILE", str(tmp_path / "missing.key"))
        assert module._job_credentials(token) == {"EVIMED_JOB_CREDENTIAL_EVIMED_EVIDENCE_SEARCH_KEY": "alice-evimed-evidence"}, shape
        assert asked == ["evimed-evidence"], shape


def test_the_deployments_evidence_key_file_wins_and_nothing_is_asked(tmp_path, monkeypatch) -> None:
    module, token, asked = _drug_safety(tmp_path, monkeypatch)
    key = tmp_path / "evimed.key"
    key.write_text("deployment-evimed-key\n", encoding="utf-8")
    key.chmod(0o600)
    monkeypatch.setenv("EVIMED_EVIDENCE_SEARCH_KEY_FILE", str(key))
    assert module._job_credentials(token) == {}
    assert asked == [], "an engine reads a direct value before the file, so the researcher's must not be handed over"
