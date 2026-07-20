from pathlib import Path
from types import SimpleNamespace

import pytest

from evimed_runner import _copy_release_artifacts, _validate_release
from mr_agent.models import (
    HeterogeneityResult,
    MRAnalysisResult,
    MRResult,
    PleiotopyResult,
    SessionState,
)
from mr_agent.paper.generator import PaperGenerator


def _result(tmp_path: Path | None = None) -> MRAnalysisResult:
    raw = tmp_path / "raw" if tmp_path else None
    if raw:
        raw.mkdir()
        (raw / "mr_results.csv").write_text("method,beta\nIVW,0.38\n", encoding="utf-8")
        (raw / "forest_plot.png").write_bytes(b"png")
    return MRAnalysisResult(
        exposure_id="ebi-a-exposure",
        outcome_id="ebi-a-outcome",
        exposure_name="LDL cholesterol",
        outcome_name="coronary heart disease",
        mr_results=[
            MRResult(
                method="Inverse variance weighted",
                nsnp=155,
                beta=0.3877,
                se=0.0537,
                pval=5.42e-13,
                or_value=1.474,
                ci_lower=1.326,
                ci_upper=1.637,
            )
        ],
        heterogeneity=[
            HeterogeneityResult(
                method="Inverse variance weighted",
                q=1566.16,
                q_df=154,
                q_pval=4.08e-232,
            )
        ],
        pleiotropy=PleiotopyResult(egger_intercept=-0.004, se=0.0028, pval=0.153),
        n_instruments=155,
        f_statistic_mean=247.253,
        steiger_correct=True,
        steiger_pval=0.0,
        presso_n_outliers=19,
        sample_overlap_warning=True,
        exposure_metadata={
            "gwas_id": "ebi-a-exposure",
            "trait": "Direct LDL cholesterol",
            "sample_size": 437068,
            "population": "European",
            "year": 2021,
            "nsnp": 4231872,
        },
        outcome_metadata={
            "gwas_id": "ebi-a-outcome",
            "trait": "Coronary artery disease",
            "sample_size": 547261,
            "population": "NA",
            "year": 2017,
            "nsnp": 7934254,
        },
        raw_data_path=raw,
        plots={"forest_plot_png": raw / "forest_plot.png"} if raw else {},
    )


def test_release_sections_are_rebuilt_from_structured_results():
    result = _result()
    state = SessionState(analysis_results=[result])
    generator = PaperGenerator(SimpleNamespace(), state, language="zh")
    paper = generator._enforce_structured_grounding(
        {
            "abstract": "本研究已证明无条件因果关系。",
            "methods": "两个数据集在样本构成上不存在重叠。",
            "results": "初步提取213个SNP，保留182个。",
            "discussion": "通过PhenoScanner数据库排除所有混杂。",
            "limitations": "MR-PRESSO全局检验未发现多效性。",
            "conclusion": "每增加一个标准差必然导致结局。",
            "data_availability": "完整代码已存档于GitHub。",
            "ethics_statement": "所有原始研究均已核验伦理审批。",
            "table1": "fabricated",
            "table2": "fabricated",
        }
    )

    joined = "\n".join(paper.values())
    assert "不存在重叠" not in joined
    assert "213" not in joined
    assert "保留182" not in joined
    assert "全局p值不可用" in paper["limitations"]
    assert "不单独等同于无条件因果证明" in paper["abstract"]
    assert "PhenoScanner" not in paper["discussion"]
    assert "不由此推导具体剂量" in paper["conclusion"]
    assert "未声称另有公开GitHub代码仓库" in paper["data_availability"]
    assert "没有独立验证" in paper["ethics_statement"]
    assert "结局人群元数据分别为European和N/A" in paper["limitations"]
    assert "ebi-a-exposure → ebi-a-outcome" in paper["results"]
    assert "OR=1.474" in paper["results"]
    assert "547,261" in paper["table1"]
    assert "4.080e-232" in paper["results"]


def test_release_validator_rejects_false_overlap_and_presso_claims():
    result = _result()
    base = "437068 547261 ebi-a-exposure ebi-a-outcome 异质性"
    with pytest.raises(RuntimeError, match="non-overlap"):
        _validate_release(base + " 两个数据集在样本构成上不存在重叠", [result])
    with pytest.raises(RuntimeError, match="MR-PRESSO"):
        _validate_release(base + " MR-PRESSO全局检验未发现多效性", [result])
    with pytest.raises(RuntimeError, match="unsupported method"):
        _validate_release(base + " 通过PhenoScanner数据库排除所有混杂因素", [result])
    with pytest.raises(RuntimeError, match="unsupported method"):
        _validate_release(base + " 完整代码已存档于GitHub。", [result])


def test_release_artifacts_are_copied_and_paths_become_portable(tmp_path: Path):
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "paper.docx").write_bytes(b"docx")
    (runtime / "mr_report.pdf").write_bytes(b"pdf")
    result = _result(tmp_path)
    output = tmp_path / "output"
    output.mkdir()

    copied = _copy_release_artifacts(
        output,
        SimpleNamespace(output_dir=runtime),
        [result],
    )

    assert "mendelian-randomization-report.docx" in copied
    assert "mendelian-randomization-report.pdf" in copied
    assert (output / result.raw_data_path / "mr_results.csv").is_file()
    assert result.plots["forest_plot_png"] == result.raw_data_path / "forest_plot.png"
    assert not result.raw_data_path.is_absolute()
