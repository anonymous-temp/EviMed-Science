"""Real deterministic engine fixtures; no model calls or generated estimates."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import os
import sys
import time
from pathlib import Path
from contextlib import contextmanager

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evimed_specialist_adapter import deterministic_replay as replay
from evimed_specialist_adapter.replay_service import ReplayJobs, install_replay_routes

linux_process_join = pytest.mark.skipif(
    sys.platform != "linux" or not hasattr(os, "waitid"),
    reason="Real worker ownership requires Linux waitid(WNOWAIT); run in the replay image or Linux CI.",
)

WORKSPACE_ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def engines(monkeypatch):
    for environment, directory in [("EVIMED_REPLAY_META_ROOT", "meta"), ("EVIMED_REPLAY_SAFETY_ROOT", "药物安全分析agent"),
                                   ("EVIMED_REPLAY_BIBLIOMETRIC_ROOT", "文献剂量分析")]:
        monkeypatch.setenv(environment, str(WORKSPACE_ROOT / "项目代码" / directory))


def recipe(method, value, parameters=None):
    blob = replay.canonical(value)
    manifest = replay.manifest(method)
    return {"method": method, "version": "1", "input": {"path": "input.json", "sha256": replay.digest(blob)},
            "parameters": parameters or {}, "codeDigest": manifest["codeDigest"], "environmentDigest": manifest["environmentDigest"]}, blob


def test_meta_dl_reference_and_same_recipe_numerical_replay(engines):
    # Existing test_executed_pooling_methods.effects fixture: equal variance.
    value = {"studies": [{"id": str(i), "label": str(i), "yi": y, "vi": .1} for i, y in enumerate([0, 1, 3])],
             "effectMeasure": "MD", "outcome": "outcome"}
    frozen, blob = recipe("meta.dl", value)
    first, second = replay.execute(frozen, blob), replay.execute(frozen, blob)
    want_tau = 67 / 30
    want_se = math.sqrt((.1 + want_tau) / 3)
    result = first["result"]["values"]
    assert result["pooled_effect"] == pytest.approx(4 / 3, abs=1e-12)
    assert result["tau_squared"] == pytest.approx(want_tau, abs=1e-12)
    assert result["ci_lower"] == pytest.approx(4 / 3 - 1.96 * want_se, abs=1e-12)
    assert second["receipt"]["outputDigest"] == first["receipt"]["outputDigest"]
    assert all(item["unit"] for item in first["machineValues"])
    assert first["result"]["executedMethod"]["tau_estimator"] == "DL"


def test_faers_known_t1_t2_panels_keep_zero_correction_and_omit_unbound_fitted_prior(engines):
    # Existing safety tests/test_signals_known_answers.py T1 and T2.
    frozen, blob = recipe("faers.signals", {"tables": [
        {"id": "T1", "a": 10, "b": 90, "c": 20, "d": 1880}, {"id": "T2", "a": 0, "b": 50, "c": 10, "d": 940}]})
    first = replay.execute(frozen, blob)
    rows = first["result"]["values"]
    assert rows[0]["ror"]["value"] == pytest.approx(10.4444444444, rel=1e-10)
    assert rows[0]["prr"]["value"] == 9.5
    assert rows[0]["chi2"]["value"] == pytest.approx(51.4738623208, rel=1e-10)
    assert rows[1]["haldaneAnscombeApplied"] is True
    assert rows[1]["ror"]["value"] == pytest.approx(.88684582744, rel=1e-10)
    assert first["result"]["omitted"][0]["statistic"] == "EBGM"
    assert replay.execute(frozen, blob)["receipt"]["outputDigest"] == first["receipt"]["outputDigest"]


def test_bibliometric_existing_selected_graph_fixture_keeps_scope_and_deterministic_values(engines):
    # Existing test_sample_coverage.test_network_context fixture.
    frozen, blob = recipe("bibliometric.network", {"edges": [
        {"source": "A", "target": "B", "weight": 2, "source_freq": 8, "target_freq": 7},
        {"source": "C", "target": "D", "weight": 1, "source_freq": 2, "target_freq": 1}]}, {"maxNodes": 2})
    first = replay.execute(frozen, blob)
    values = first["result"]["values"]
    assert values["nodeCount"] == 2 and values["edgeCount"] == 1
    assert values["centrality"]["A"] == {"degree": 1, "betweenness": 0, "closeness": 2, "weighted_degree": 2}
    assert "C" not in values["centrality"]
    assert replay.execute(frozen, blob)["receipt"]["outputDigest"] == first["receipt"]["outputDigest"]


def test_the_real_engines_compute_every_input_the_calculation_tool_describes(engines):
    # research_calculate's description is rendered from a table of inputs, and its own suite holds that table
    # to this adapter's validation with the engines replaced by stand-ins. Here the engines are real: each
    # described input computes, each step away from one is refused, and so is the single study that only the
    # meta engine itself refuses. `{"studies": [...]}` alone is what the description once offered.
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime" / "mcp" / "evimed-research" / "test"))
    import calculation_inputs
    for method in replay.METHODS:
        cases, parameters = calculation_inputs.cases(method), calculation_inputs.parameter_cases(method)
        for value in cases["admitted"]:
            for accepted in parameters["admitted"]:
                frozen, blob = recipe(method, value, accepted)
                assert replay.execute(frozen, blob)["machineValues"], (method, value, accepted)
        refused = [(value, parameters["admitted"][0]) for value in cases["refused"]]
        refused += [(cases["admitted"][0], changed) for changed in parameters["refused"]]
        assert len(refused) >= 9, method
        for value, supplied in refused:
            with pytest.raises(replay.ReplayError, match="replay_input_invalid"):
                replay.compute(method, value, supplied)
    described = calculation_inputs.cases("meta.dl")["admitted"][0]
    for value in ({"studies": described["studies"]}, {**described, "studies": described["studies"][:1]}):
        frozen, blob = recipe("meta.dl", value)
        with pytest.raises(replay.ReplayError, match="replay_input_invalid"):
            replay.execute(frozen, blob)


def test_changed_missing_or_incompatible_recipe_inputs_are_named(engines):
    frozen, blob = recipe("faers.signals", {"tables": [{"id": "T1", "a": 10, "b": 90, "c": 20, "d": 1880}]})
    with pytest.raises(replay.ReplayError, match="replay_input_changed"):
        replay.execute(frozen, blob + b" ")
    with pytest.raises(replay.ReplayError, match="replay_code_changed"):
        replay.execute({**frozen, "codeDigest": "a" * 64}, blob)
    with pytest.raises(replay.ReplayError, match="replay_environment_incompatible"):
        replay.execute({**frozen, "environmentDigest": "a" * 64}, blob)
    with pytest.raises(replay.ReplayError, match="replay_method_unsupported"):
        replay.execute({**frozen, "method": "imported.script"}, blob)
    with pytest.raises(ValueError):
        replay.validate_recipe({**frozen, "input": {"path": "../patient.csv", "sha256": "a" * 64}})


@pytest.mark.parametrize("measure, original, analysis", [
    ("MD", "mean_difference_unspecified_unit", "mean_difference_unspecified_unit"),
    ("RR", "risk_ratio", "log_risk_ratio"),
    ("SMD", "standardized_mean_difference", "standardized_mean_difference"),
])
def test_meta_numeric_units_distinguish_counts_percentages_and_effect_scales(engines, measure, original, analysis):
    frozen, blob = recipe("meta.dl", {"studies": [
        {"id": str(i), "label": str(i), "yi": y, "vi": .1} for i, y in enumerate([0, 1, 3])],
        "effectMeasure": measure, "outcome": "Unspecified outcome unit"})
    output = replay.execute(frozen, blob)
    units = {item["key"]: item["unit"] for item in output["machineValues"]}
    assert units["values.n_studies"] == "count"
    assert units["values.i_squared"] == units["values.studies[0].weight"] == "percent"
    assert units["values.p_value"] == units["values.q_statistic"] == "dimensionless"
    assert units["values.pooled_effect"] == units["values.prediction_interval[0]"] == original
    assert units["values.pooled_log"] == units["values.studies[0].se"] == analysis
    assert units["values.tau_squared"] == units["values.studies[0].vi"] == analysis + "_squared"
    with pytest.raises(replay.ReplayError, match="replay_output_unit_unknown"):
        replay.numeric_unit("meta.dl", output["result"], ("new_unsupported_statistic",))


def test_signal_and_network_numeric_units_do_not_label_counts_as_ratios(engines):
    frozen, blob = recipe("faers.signals", {"tables": [{"id": "T1", "a": 10, "b": 90, "c": 20, "d": 1880}]})
    units = {item["key"]: item["unit"] for item in replay.execute(frozen, blob)["machineValues"]}
    assert units["values[0].table.a"] == "count"
    assert units["values[0].ror.value"] == units["values[0].chi2.value"] == "dimensionless"
    assert units["values[0].ic.value"] == "log2_reporting_ratio"
    frozen, blob = recipe("bibliometric.network", {"edges": [
        {"source": "A", "target": "B", "weight": 2, "source_freq": 8, "target_freq": 7}]}, {"maxNodes": 2})
    units = {item["key"]: item["unit"] for item in replay.execute(frozen, blob)["machineValues"]}
    assert units["values.nodeCount"] == units["values.edgeCount"] == "count"
    assert units["values.centrality.A.degree"] == "dimensionless"
    assert units["values.centrality.A.closeness"] == units["values.centrality.A.weighted_degree"] == "cooccurrence_weight"


@pytest.fixture
def jobs(tmp_path, monkeypatch, engines):
    data = tmp_path / "data"
    project = data / "users" / "user1" / "projects" / "project1"
    workspace = project / "workspace"; workspace.mkdir(parents=True)
    secret = tmp_path / "secret"; secret.write_text("test-only-workload-signing-secret-32-bytes"); secret.chmod(0o600)
    monkeypatch.setenv("EVIMED_DATA_ROOT", str(data)); monkeypatch.setenv("EVIMED_WORKLOAD_SIGNING_SECRET_FILE", str(secret))
    manager = ReplayJobs(lambda claims: workspace)
    app = FastAPI(); install_replay_routes(app, lambda claims: workspace, manager=manager)
    return manager, TestClient(app), workspace, secret.read_text()


def claims(frozen, job_id="replay-reference0001"):
    return {"v": 1, "aud": "evimed-result-replay", "userId": "user1", "projectId": "project1", "jobId": job_id,
            "recipeDigest": replay.digest(replay.canonical(frozen)), "iat": int(time.time()), "exp": int(time.time()) + 300, "jti": "test-token"}


def token(secret, value):
    encoded = lambda v: base64.urlsafe_b64encode(json.dumps(v, separators=(",", ":")).encode()).decode().rstrip("=")
    head, body = encoded({"alg": "HS256", "typ": "JWT"}), encoded(value)
    sig = base64.urlsafe_b64encode(hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return f"{head}.{body}.{sig}"


def wait_job(manager, scope):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        value = manager.status(scope)
        if value["state"] in {"succeeded", "failed", "canceled", "timed_out", "ownership_unknown"}:
            return value
        time.sleep(.02)
    raise AssertionError("owned replay job did not finish")


@linux_process_join
def test_real_isolated_execution_is_idempotent_publishes_original_recipe_and_preserves_input(jobs):
    manager, client, workspace, secret = jobs
    frozen, blob = recipe("meta.dl", {"studies": [{"id": str(i), "label": str(i), "yi": y, "vi": .1} for i, y in enumerate([0, 1, 3])],
                                   "effectMeasure": "MD", "outcome": "outcome"})
    (workspace / "input.json").write_bytes(blob)
    scope = claims(frozen); headers = {"Authorization": f"Bearer {token(secret, scope)}"}
    body = {"jobId": scope["jobId"], "recipe": frozen}
    assert client.post("/api/v1/evimed/result-replays", json=body, headers=headers).status_code == 200
    assert client.post("/api/v1/evimed/result-replays", json=body, headers=headers).status_code == 200
    result = wait_job(manager, scope)
    assert result["state"] == "succeeded" and result["cleanup"] == "confirmed"
    out = workspace / result["resultPath"]
    parsed = json.loads(out.read_bytes())
    assert parsed["recipe"] == frozen and parsed["receipt"]["recipeDigest"] == scope["recipeDigest"]
    assert result["artifacts"][0]["sha256"] == hashlib.sha256(out.read_bytes()).hexdigest()
    assert (workspace / "input.json").read_bytes() == blob
    assert client.get(f"/api/v1/evimed/result-replays/{scope['jobId']}", headers=headers).json()["state"] == "succeeded"
    bad = {**frozen, "parameters": {"script": "run.py"}}
    assert client.post("/api/v1/evimed/result-replays", json={**body, "recipe": bad}, headers=headers).status_code == 403
    assert client.get("/api/v1/evimed/result-replays/replay-other0001", headers=headers).status_code == 403


def test_runtime_or_expired_tokens_cannot_admit_recipes_and_source_changes_do_not_execute(jobs):
    manager, client, workspace, secret = jobs
    frozen, blob = recipe("faers.signals", {"tables": [{"id": "T1", "a": 10, "b": 90, "c": 20, "d": 1880}]})
    (workspace / "input.json").write_bytes(blob + b" ")
    scope = claims(frozen)
    body = {"jobId": scope["jobId"], "recipe": frozen}
    for invalid in [{**scope, "aud": "evimed-adapter"}, {**scope, "exp": int(time.time()) - 1}]:
        assert client.post("/api/v1/evimed/result-replays", json=body, headers={"Authorization": f"Bearer {token(secret, invalid)}"}).status_code == 401
    headers = {"Authorization": f"Bearer {token(secret, scope)}"}
    response = client.post("/api/v1/evimed/result-replays", json=body, headers=headers)
    assert response.status_code == 422 and response.json()["detail"] == "replay_input_changed"
    assert not manager.running
    response = client.get("/api/v1/evimed/result-replays/capabilities", headers=headers)
    assert response.status_code == 200 and all(method["available"] for method in response.json()["methods"])


@pytest.mark.parametrize("cancel", [False, True])
@linux_process_join
def test_timeout_and_cancel_join_actual_process_and_retain_original(jobs, cancel):
    manager, _, workspace, _ = jobs
    frozen, blob = recipe("meta.dl", {"studies": [{"id": str(i), "label": str(i), "yi": y, "vi": .1} for i, y in enumerate([0, 1, 3])],
                                   "effectMeasure": "MD", "outcome": "outcome"})
    (workspace / "input.json").write_bytes(blob)
    scope = claims(frozen)
    manager.timeout_seconds = 30 if cancel else .001
    manager.start(scope, frozen)
    result = manager.cancel(scope) if cancel else wait_job(manager, scope)
    assert result["state"] == ("canceled" if cancel else "timed_out")
    assert result["cleanup"] == "confirmed" and not manager.running
    assert (workspace / "input.json").read_bytes() == blob
    assert not (workspace / "result-replays" / scope["jobId"] / "output" / "result.json").exists()


def test_lost_owner_is_not_a_duplicate_execution_and_cross_tenant_state_unavailable(jobs):
    manager, _, workspace, _ = jobs
    frozen, blob = recipe("faers.signals", {"tables": [{"id": "T1", "a": 10, "b": 90, "c": 20, "d": 1880}]})
    scope = claims(frozen)
    project = workspace.parent
    manager._write(project, {"schemaVersion": 1, "jobId": scope["jobId"], "recipeDigest": scope["recipeDigest"], "state": "running", "cleanup": "pending"}, exclusive=True)
    assert manager.status(scope)["state"] == "ownership_unknown"
    assert manager.cancel(scope)["cleanup"] == "unknown"
    assert not manager.running
    (workspace / "input.json").write_bytes(blob)
    assert manager.start(scope, frozen)["state"] == "ownership_unknown"  # never launches another
    assert not manager.running
    with pytest.raises((HTTPException, FileNotFoundError)):
        manager.status({**scope, "userId": "user2"})


@pytest.mark.parametrize("leave_stage", [True, False])
def test_failure_does_not_claim_cleanup_when_private_stage_remains(jobs, tmp_path, monkeypatch, leave_stage):
    from evimed_specialist_adapter import isolated_job
    manager, _, workspace, _ = jobs
    frozen, blob = recipe("faers.signals", {"tables": [{"id": "T1", "a": 10, "b": 90, "c": 20, "d": 1880}]})
    (workspace / "input.json").write_bytes(blob)
    owned_stage = tmp_path / "owned-stage"

    @contextmanager
    def failing_stage(_credentials):
        owned_stage.mkdir()
        try:
            yield owned_stage
        finally:
            if not leave_stage:
                owned_stage.rmdir()

    def fail_handover(*_args):
        raise OSError("Test-only input staging failure")

    monkeypatch.setattr(isolated_job, "stage", failing_stage)
    monkeypatch.setattr(isolated_job, "hand_over", fail_handover)
    scope = claims(frozen)
    manager.start(scope, frozen)
    result = wait_job(manager, scope)
    assert result["state"] == "failed"
    assert result["cleanup"] == ("unknown" if leave_stage else "confirmed")
    assert (workspace / "input.json").read_bytes() == blob


def test_cancel_before_http_start_reserves_identity_and_never_launches_late_work(jobs):
    manager, client, workspace, secret = jobs
    frozen, blob = recipe("faers.signals", {"tables": [{"id": "T1", "a": 10, "b": 90, "c": 20, "d": 1880}]})
    scope = claims(frozen, "5be1d202-5912-41a3-8a34-b3aeed932d85")  # ProductJobs' genuine UUID shape.
    headers = {"Authorization": f"Bearer {token(secret, scope)}"}
    assert client.post(f"/api/v1/evimed/result-replays/{scope['jobId']}/cancel", headers=headers).json()["cleanup"] == "confirmed"
    (workspace / "input.json").write_bytes(blob)
    result = client.post("/api/v1/evimed/result-replays", json={"jobId": scope["jobId"], "recipe": frozen}, headers=headers)
    assert result.status_code == 200 and result.json()["state"] == "canceled"
    assert not manager.running
