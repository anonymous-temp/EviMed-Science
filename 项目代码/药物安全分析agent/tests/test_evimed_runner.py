"""evimed_runner contract tests (pipeline mocked, artifacts stubbed)."""

from __future__ import annotations

import json
from pathlib import Path

import evimed_runner


def _fake_artifacts(output_dir: Path):
    def _make(name: str, content: bytes) -> Path:
        path = output_dir / name
        path.write_bytes(content)
        return path

    return {
        "markdown": _make("safety-report.md", b"# report"),
        "csv": _make("signals.csv", b"reaction,ror\nmyalgia,10.444\n"),
        "docx": _make("safety-report.docx", b"PK-fake-docx"),
        "pdf": None,  # LibreOffice absence must be tolerated
    }


async def _fake_run_to_files(drug, reactions, *, language, outdir, stem, **_kwargs):
    assert stem == "safety-report"
    return _fake_artifacts(outdir)


async def _failing_run_to_files(*_args, **_kwargs):
    raise RuntimeError("pipeline exploded")


def _patch(monkeypatch, impl):
    monkeypatch.setattr(evimed_runner, "run_to_files", impl)


def test_runner_success_contract(tmp_path, monkeypatch):
    _patch(monkeypatch, _fake_run_to_files)
    request = tmp_path / "request.json"
    request.write_text(
        json.dumps({"drug": "metformin", "reactions": ["lactic acidosis"], "outputLanguage": "zh"}),
        encoding="utf-8",
    )
    out = tmp_path / "out"
    assert evimed_runner.run(request, out) == 0

    result = json.loads((out / "result.json").read_text(encoding="utf-8"))
    assert result["status"] == "succeeded"
    assert result["drug"] == "metformin"
    assert result["reactions"] == ["lactic acidosis"]
    assert result["report"] == "safety-report.md"
    assert result["signals"] == "signals.csv"
    assert set(result["artifacts"]) == {
        "safety-report.md",
        "safety-report.docx",
        "signals.csv",
    }
    assert (out / "safety-report.md").is_file()
    assert (out / "signals.csv").is_file()


def test_runner_missing_drug_fails_with_exit_1(tmp_path, monkeypatch):
    _patch(monkeypatch, _fake_run_to_files)
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"reactions": ["x"]}), encoding="utf-8")
    out = tmp_path / "out"
    assert evimed_runner.run(request, out) == 1
    result = json.loads((out / "result.json").read_text(encoding="utf-8"))
    assert result["status"] == "failed"
    assert "drug" in result["error"]


def test_runner_bad_language_fails(tmp_path, monkeypatch):
    _patch(monkeypatch, _fake_run_to_files)
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"drug": "x", "outputLanguage": "fr"}), encoding="utf-8")
    assert evimed_runner.run(request, tmp_path / "out") == 1


def test_runner_pipeline_failure_contract(tmp_path, monkeypatch):
    _patch(monkeypatch, _failing_run_to_files)
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"drug": "metformin"}), encoding="utf-8")
    out = tmp_path / "out"
    assert evimed_runner.run(request, out) == 1
    result = json.loads((out / "result.json").read_text(encoding="utf-8"))
    assert result["status"] == "failed"
    assert "pipeline exploded" in result["error"]


def test_runner_reactions_not_array_fails(tmp_path, monkeypatch):
    _patch(monkeypatch, _fake_run_to_files)
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"drug": "x", "reactions": "myalgia"}), encoding="utf-8")
    assert evimed_runner.run(request, tmp_path / "out") == 1


def test_runner_passes_reproducible_faers_scope_controls(tmp_path, monkeypatch):
    observed = {}

    async def capture(drug, reactions, **kwargs):
        observed.update(kwargs)
        return _fake_artifacts(kwargs["outdir"])

    _patch(monkeypatch, capture)
    request = tmp_path / "request.json"
    request.write_text(json.dumps({
        "drug": "cefiderocol",
        "drugAliases": ["Fetroja"],
        "suspectRoles": ["PS", "SS"],
        "administrationRoutes": ["048"],
        "studyDateFrom": "2019-11-14",
        "studyDateTo": "2024-09-30",
        "backgroundDateFrom": "2004-01-01",
        "backgroundDateTo": "2024-09-30",
    }), encoding="utf-8")
    out = tmp_path / "out"

    assert evimed_runner.run(request, out) == 0
    assert observed["drug_aliases"] == ("Fetroja",)
    assert observed["suspect_roles"] == frozenset({"PS", "SS"})
    assert observed["administration_routes"] == ("048",)
    assert observed["background_date_from"] == "2004-01-01"
    result = json.loads((out / "result.json").read_text(encoding="utf-8"))
    assert result["scope"]["studyDateFrom"] == "2019-11-14"
