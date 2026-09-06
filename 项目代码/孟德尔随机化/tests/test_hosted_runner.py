"""Exercise the fixed runner with a fake agent and real input preparation."""

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

import evimed_local_inputs as inputs
import evimed_runner
from mr_agent.models import DataSourceType, MRAnalysisResult


def prepared_job(tmp_path, *, remote=False):
    workspace = tmp_path / "workspace"
    (workspace / "data").mkdir(parents=True)
    output = workspace / "mendelian-randomization-runs/mr-runner-001/output"
    output.mkdir(parents=True)
    request = {"exposure": "BMI", "outcome": "CHD", "outputLanguage": "en"}
    for role in ("exposure", "outcome"):
        (workspace / f"data/{role}.csv").write_text(
            ",".join(inputs.STANDARD_MAPPING.values()) + "\nrs1,0.2,0.01,A,G,0.2,1e-10\n"
        )
        request[f"{role}Source"] = {
            "type": "local_file",
            "path": f"data/{role}.csv",
            "columnMapping": dict(inputs.STANDARD_MAPPING),
            "instrumentsPreclumped": True,
            "clumpingProvenance": "Study-supplied independent instruments: r2 < 0.001, 10 Mb.",
        }
    if remote:
        request["outcomeSource"] = {"type": "opengwas", "gwasId": "ieu-a-7"}
    binding = inputs.capture_bindings(workspace, request, tmp_path)
    authority = inputs.prepare_sources(
        workspace, output, request, binding, tmp_path, token_available=remote
    )
    request = authority["request"]
    request_path = output / "request.json"
    request_path.write_text(json.dumps(request))
    return output, request_path, request, authority


@pytest.mark.parametrize(
    "direction,tamper", [("forward", False), ("bidirectional", False), ("forward", True)]
)
def test_fixed_runner_populates_local_slots_and_releases_honest_metadata(
    tmp_path, monkeypatch, direction, tamper
):
    output, request_path, request, authority = prepared_job(tmp_path)
    request["analysisDirection"] = direction
    request_path.write_text(json.dumps(request))
    observed = []

    class FakeMRAgent:
        def __init__(self, language):
            assert language == "en"
            self.state = SimpleNamespace(
                slots=SimpleNamespace(),
                analysis_results=[],
                errors=[],
                paper_sections={},
                output_dir=None,
            )

        def _run_analysis(self):
            slots = self.state.slots
            assert slots.exposure_source.source_type == DataSourceType.LOCAL_FILE
            assert slots.outcome_source.source_type == DataSourceType.LOCAL_FILE
            assert slots.exposure_source.column_mapping.snp == "SNP"
            assert slots.exposure_source.instruments_preclumped is True
            assert slots.bidirectional is (direction == "bidirectional")
            for source in (slots.exposure_source, slots.outcome_source):
                assert "/data/users/" not in source.file_path
                observed.append(source.file_path)
            self.state.analysis_results = [
                MRAnalysisResult(
                    exposure_id="exposure.csv",
                    outcome_id="outcome.csv",
                    n_instruments=1,
                    exposure_source_type=DataSourceType.LOCAL_FILE,
                    outcome_source_type=DataSourceType.LOCAL_FILE,
                )
            ]
            if direction == "bidirectional":
                self.state.analysis_results.append(
                    MRAnalysisResult(
                        exposure_id="outcome.csv",
                        outcome_id="exposure.csv",
                        n_instruments=1,
                        exposure_source_type=DataSourceType.LOCAL_FILE,
                        outcome_source_type=DataSourceType.LOCAL_FILE,
                    )
                )
            return "Fake analysis complete."

        def _run_paper_generation(self):
            assert self.state.slots.exposure_source.file_path == "inputs/exposure.csv"
            if tamper:
                (output / "inputs/exposure.csv").write_text("changed after private analysis")
            self.state.paper_sections = {
                "abstract": "The data and instrument selection were supplied and not "
                "independently verified. " * 15
            }

    fake = ModuleType("mr_agent.core.engine")
    fake.MRAgent = FakeMRAgent
    monkeypatch.setitem(sys.modules, "mr_agent.core.engine", fake)
    monkeypatch.delenv("OPENGWAS_JWT", raising=False)
    code = evimed_runner.run(request_path, output, input_authority=authority)
    if tamper:
        assert code == 1
        assert (
            json.loads((output / "result.json").read_text())["errorCode"]
            == "mr_input_manifest_invalid"
        )
        return
    assert code == 0
    result = json.loads((output / "result.json").read_text())
    assert inputs.MANIFEST_NAME in result["artifacts"]
    assert "inputs/exposure.csv" in result["artifacts"]
    assert all(not name.startswith("/") for name in result["artifacts"])
    rows = json.loads((output / "mendelian-randomization-run.json").read_text())
    metadata = rows[0]["exposure_metadata"]
    assert metadata["metadata_source"] == "provided_local_data"
    assert metadata["verification_status"] == "supplied_not_independently_verified"
    assert metadata["ld_rechecked"] is False
    assert metadata["input_provenance"]["path"] == "data/exposure.csv"
    assert not metadata.get("gwas_id") and not metadata.get("year")
    assert str(tmp_path) not in json.dumps(rows)
    assert observed
    if direction == "bidirectional":
        assert rows[1]["exposure_metadata"]["input_provenance"]["path"] == "data/outcome.csv"


def test_missing_remote_metadata_remains_a_release_failure():
    result = MRAnalysisResult(exposure_id="ieu-a-2", outcome_id="ieu-a-7", n_instruments=1)
    with pytest.raises(RuntimeError, match="metadata is incomplete"):
        evimed_runner._validate_release("Supplied evidence.", [result])


def test_prepared_files_are_digest_bound_before_agent_construction(tmp_path):
    output, _, request, authority = prepared_job(tmp_path)
    (output / "inputs/exposure.csv").write_text(
        "SNP,beta,se,effect_allele,other_allele,eaf,pval\nrs1,9,0.01,A,G,0.2,1e-10\n"
    )
    private = tmp_path / "private"
    private.mkdir()
    with pytest.raises(inputs.MRInputError) as error:
        inputs.runner_sources(request, output, private, authority=authority)
    assert error.value.code == "mr_input_manifest_invalid"


def test_workspace_manifest_cannot_replace_the_worker_authority(tmp_path):
    output, _, request, authority = prepared_job(tmp_path)
    canonical = output / "inputs/exposure.csv"
    canonical.write_text(canonical.read_text().replace("0.2,0.01", "0.3,0.01"))
    manifest_file = output / inputs.MANIFEST_NAME
    manifest = json.loads(manifest_file.read_text())
    manifest["sources"]["exposure"]["preparedSha256"] = hashlib.sha256(
        canonical.read_bytes()
    ).hexdigest()
    manifest["sources"]["exposure"]["preparedBytes"] = canonical.stat().st_size
    manifest_file.write_text(json.dumps(manifest))
    private = tmp_path / "private"
    private.mkdir()
    with pytest.raises(inputs.MRInputError, match="manifest"):
        inputs.runner_sources(request, output, private, authority=authority)
    with pytest.raises(inputs.MRInputError, match="manifest"):
        inputs.verify_published_inputs(request, output, authority["sources"])


def test_quoted_parent_directories_are_escaped_in_generated_r_strings(tmp_path):
    from mr_agent.models import ColumnMapping, DataSource
    from mr_agent.tools.mr_executor import _build_local_both_script, _r_path

    parent = tmp_path / 'a"quoted\nparent'
    parent.mkdir()
    exposure = parent / "exposure.csv"
    outcome = parent / "outcome.csv"
    for file in (exposure, outcome):
        file.write_text(
            "SNP,beta,se,effect_allele,other_allele,eaf,pval\nrs1,0.2,0.01,A,G,0.2,1e-10\n"
        )

    def data_source(file):
        return DataSource(
            source_type=DataSourceType.LOCAL_FILE,
            file_path=str(file),
            column_mapping=ColumnMapping(),
            instruments_preclumped=True,
            clumping_provenance="Provided selected instruments.",
        )

    script = _build_local_both_script(
        data_source(exposure), data_source(outcome), parent / "analysis", "", [5e-8]
    )
    # Decode the quoted path as a string, independently of the R template. The
    # raw quote/newline must be data, never a new R statement or template row.
    assert json.loads('"' + _r_path(exposure) + '"') == str(exposure)
    assert str(exposure) not in script
    assert '\\"quoted\\nparent' in script
    rscript = shutil.which("Rscript") or (
        "/opt/homebrew/bin/Rscript" if Path("/opt/homebrew/bin/Rscript").is_file() else None
    )
    if rscript:
        script_path = tmp_path / "parse-only.R"
        script_path.write_text(script)
        subprocess.run(
            [
                rscript,
                "--vanilla",
                "-e",
                "invisible(parse(file=commandArgs(TRUE)[1]));cat('parse-ok')",
                str(script_path),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )


@pytest.mark.parametrize("failure", [None, "missing_year", "auth"])
def test_mixed_runner_gets_remote_metadata_from_the_existing_client(tmp_path, monkeypatch, failure):
    from mr_agent.tools import gwas

    output, request_path, request, authority = prepared_job(tmp_path, remote=True)
    monkeypatch.setenv("OPENGWAS_JWT", "fixture-token")
    monkeypatch.setattr(gwas, "_auth_headers", lambda: {"Authorization": "Bearer fixture-token"})
    calls = []
    row = {
        "id": "ieu-a-7",
        "trait": "CHD",
        "sample_size": 90000,
        "population": "European",
        "year": 2020,
    }
    if failure == "missing_year":
        row.pop("year")

    class Response:
        status_code = 401 if failure == "auth" else 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def iter_content(self, chunk_size):
            assert chunk_size == 8192
            yield json.dumps({"ieu-a-7": row}).encode()

    def post(url, **kwargs):
        calls.append(url)
        assert url == f"{gwas.OPENGWAS_API}/gwasinfo"
        assert kwargs["json"] == {"id": ["ieu-a-7"]}
        assert kwargs["allow_redirects"] is False
        assert kwargs["timeout"] == gwas.OPENGWAS_TIMEOUT
        return Response()

    monkeypatch.setattr(gwas.requests, "post", post)

    class FakeMRAgent:
        def __init__(self, language):
            assert failure is None, "metadata must fail before constructing the analysis agent"
            self.state = SimpleNamespace(
                slots=SimpleNamespace(),
                analysis_results=[],
                errors=[],
                paper_sections={},
                output_dir=None,
            )

        def _run_analysis(self):
            assert self.state.slots.outcome_source.gwas_id == "ieu-a-7"
            assert self.state.slots.outcome_source.source_type == DataSourceType.OPENGWAS
            self.state.analysis_results = [
                MRAnalysisResult(
                    exposure_id="exposure.csv",
                    outcome_id="ieu-a-7",
                    n_instruments=1,
                    exposure_source_type=DataSourceType.LOCAL_FILE,
                    outcome_source_type=DataSourceType.OPENGWAS,
                )
            ]
            return "Fake mixed analysis completed."

        def _run_paper_generation(self):
            remote_metadata = self.state.analysis_results[0].outcome_metadata
            assert remote_metadata["year"] == 2020
            assert remote_metadata["sample_size"] == 90000
            assert remote_metadata["metadata_source"] == "opengwas_api"
            self.state.paper_sections = {
                "abstract": "Repository dataset ieu-a-7 reports 90,000 participants in "
                "2020; local inputs are supplied and not independently "
                "verified. " * 10
            }

    fake = ModuleType("mr_agent.core.engine")
    fake.MRAgent = FakeMRAgent
    monkeypatch.setitem(sys.modules, "mr_agent.core.engine", fake)
    code = evimed_runner.run(request_path, output, input_authority=authority)
    result = json.loads((output / "result.json").read_text())
    assert len(calls) == 1
    if failure:
        assert code == 1
        assert result["errorCode"] == (
            "mr_input_remote_auth_required"
            if failure == "auth"
            else "mr_input_remote_metadata_unavailable"
        )
    else:
        assert code == 0
        assert result["status"] == "succeeded"
        record = json.loads((output / "mendelian-randomization-run.json").read_text())[0]
        assert record["outcome_metadata"]["gwas_id"] == "ieu-a-7"
        assert record["outcome_metadata"]["year"] == 2020
