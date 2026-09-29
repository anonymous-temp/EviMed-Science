"""Report rendering tests: required sections, number fidelity, exports."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from safety_agent.analysis.models import (
    AnalysisResult,
    CaseOverview,
    CountBucket,
    Interpretation,
    NormalizedReaction,
    SignalRow,
)
from safety_agent.evidence.label_check import (
    LabelCheckReport,
    LabelCheckResult,
    LabelQuote,
)
from safety_agent.evidence.models import EvidenceLayerResult
from safety_agent.report.docx_export import export_docx, export_pdf
from safety_agent.report.markdown import render_markdown, signal_table_csv

# The signal row mirrors the hand-computed T1 panel (see
# test_signals_known_answers): ROR=10.444444..., PRR=9.5, chi2=51.473862....
T1_ROW = SignalRow(
    reaction="myalgia",
    source="user-specified",
    a=10, b=90, c=20, d=1880, n=2000,
    haldane_anscombe_applied=False,
    ror=10.444444444444445, ror_ci95_lower=4.749574678434984, ror_ci95_upper=22.96761860559505,
    prr=9.5, prr_ci95_lower=4.569056617568817, prr_ci95_upper=19.75243634604419,
    chi2=51.47386232077656,
    ic=2.736965594166206, ic025=1.7345667481436353,
    ebgm=6.353572889693643, eb05=3.4210649828906288,
    is_signal=True,
)


def _result(**overrides) -> AnalysisResult:
    base = dict(
        drug_query="Atorvastatin 20 mg",
        drug_normalized="atorvastatin",
        drug_candidates=["atorvastatin"],
        reactions=[
            NormalizedReaction(query="肌痛", normalized="myalgia", method="zh-map", confidence=1.0)
        ],
        language="zh",
        overview=CaseOverview(
            total_reports=2000,
            yearly=[CountBucket(term="2023", count=100), CountBucket(term="2024", count=120)],
            sex=[CountBucket(term="male", count=55), CountBucket(term="female", count=45)],
            age_buckets=[CountBucket(term="45-64", count=80)],
            outcomes=[CountBucket(term="death (死亡)", count=30)],
            countries=[CountBucket(term="us", count=80)],
            concomitant_drugs=[CountBucket(term="ASPIRIN", count=50)],
            indications=[CountBucket(term="HYPERTENSION", count=25)],
        ),
        signals=[T1_ROW],
        label_check=LabelCheckReport(
            drug="atorvastatin",
            status="ok",
            checks=[
                LabelCheckResult(
                    reaction="myalgia",
                    status="labeled",
                    quotes=[
                        LabelQuote(
                            section="adverse_reactions",
                            sentence="The most common adverse reactions are myalgia.",
                        )
                    ],
                )
            ],
            label_refs=["set-1 (LIPITOR)"],
        ),
        evidence=EvidenceLayerResult(enabled=False, note="证据检索层未启用。"),
        interpretation=Interpretation(
            overview="总览文字",
            demographics="人口学文字",
            outcomes="结局文字",
            signal_commentary="信号解读文字",
            label_commentary="说明书对照文字",
            focus_adrs=[{"reaction": "myalgia", "text": "重点段落文字"}],
        ),
        llm_status="ok",
        degradation_notes=["证据检索层未启用。"],
        query_urls={
            "drug_total": "https://api.fda.gov/drug/event.json?limit=1&search=x",
            "signal_joint[myalgia]": "https://api.fda.gov/drug/event.json?limit=1&search=y",
        },
        generated_at=datetime(2026, 7, 20, tzinfo=timezone.utc),
    )
    base.update(overrides)
    return AnalysisResult(**base)


def test_markdown_contains_all_required_sections():
    md = render_markdown(_result())
    for heading in (
        "## 1. 分析概览",
        "## 2. 输入归一",
        "## 3. 病例概览(FAERS)",
        "### 3.1 年度趋势",
        "### 3.3 结局分布",
        "### 3.5 合并用药",
        "## 4. 失比例信号分析",
        "## 5. 重点 ADR 解读",
        "## 6. 说明书对照(FDA label)",
        "## 7. 循证证据检索(EviMed)",
        "## 8. 局限性声明",
        "## 附录:数据来源与可追溯查询",
    ):
        assert heading in md, heading


def test_markdown_numbers_match_statistics_input():
    md = render_markdown(_result())
    # every figure comes from T1_ROW's display strings: ratios and their
    # intervals to two decimals, other estimates to three significant figures
    assert "10.44 [4.75, 22.97]" in md
    assert "9.50 [4.57, 19.75]" in md
    assert "51.5" in md
    assert "2.74 (1.73)" in md
    assert "6.35 (3.42)" in md
    assert "2,000" in md  # total reports with thousands separator
    # LLM narrative is present but the numbers above are the renderer's own
    assert "总览文字" in md and "重点段落文字" in md
    # label cross-check verdict and verbatim quote
    assert "已标注" in md
    assert "The most common adverse reactions are myalgia." in md


def test_markdown_limitations_and_traceability():
    md = render_markdown(_result())
    assert "信号不等于因果关系" in md
    assert "不能用于推算不良反应发生率" in md
    assert "VigiBase" in md
    assert "https://api.fda.gov/drug/event.json?limit=1&search=y" in md
    assert "证据检索层未启用" in md
    assert "report_contains_suspect_approximation" in md
    assert "不得解释为 PS-only" in md
    assert "unfitted-starting-prior" in md


def test_markdown_frozen_snapshot_provenance_is_visible():
    md = render_markdown(
        _result(
            data_source="frozen_faers",
            suspect_binding="same_drug_object",
            suspect_roles=["PS"],
            ps_only=True,
            drug_field_used="frozen_normalized",
            study_date_from="2018-01-01",
            study_date_to="2020-12-31",
            snapshot_id="faers-2020q4-v1",
            snapshot_source="FDA quarterly files",
            snapshot_sha256="a" * 64,
        )
    )
    assert "冻结 FAERS 快照(faers-2020q4-v1)" in md
    assert "same_drug_object" in md
    assert "2018-01-01 至 2020-12-31" in md
    assert "FDA quarterly files" in md
    assert "`" + "a" * 64 + "`" in md
    assert "报告级近似" not in md


def test_live_report_discloses_report_level_binding_and_unfitted_prior():
    md = render_markdown(_result())
    assert "openFDA live API" in md
    assert "report_contains_suspect_approximation" in md
    assert "不得解释为 PS-only" in md
    assert "unfitted-starting-prior" in md
    assert "不能标作已完成全矩阵经验贝叶斯拟合" in md


def test_frozen_report_discloses_snapshot_scope_and_fitted_prior():
    md = render_markdown(
        _result(
            data_source="frozen_faers",
            suspect_binding="same_drug_object",
            suspect_roles=["PS"],
            study_date_from="2024-01-01",
            study_date_to="2024-12-31",
            snapshot_id="faers-2024q4",
            snapshot_source="FDA quarterly ASCII files",
            snapshot_sha256="a" * 64,
            gps_prior_fitted=True,
            gps_prior_id="prior-2024q4",
        )
    )
    assert "冻结 FAERS 快照(faers-2024q4)" in md
    assert "same_drug_object" in md
    assert "2024-01-01 至 2024-12-31" in md
    assert "GPS prior=fitted (prior-2024q4)" in md
    assert "FDA quarterly ASCII files" in md
    assert "`" + "a" * 64 + "`" in md
    assert "不得解释为 PS-only" not in md
    assert "未拟合的 GPS" not in md


def test_markdown_degraded_run_shows_methodology_note():
    result = _result(interpretation=None, llm_status="degraded",
                     degradation_notes=["LLM 解读失败(backend down),报告降级为仅统计结果。"])
    md = render_markdown(result)
    assert "方法学声明" in md
    assert "LLM 解读缺失" in md
    # statistics survive degradation
    assert "10.44 [4.75, 22.97]" in md


def test_every_derived_column_publishes_its_formula(tmp_path):
    """A delivered report called expected_count's formula unknown and rebuilt it
    with (c+d); the engine states each derived column's formula itself."""
    import json

    from safety_agent.analysis.runner import write_artifacts
    from safety_agent.signals.disproportionality import FORMULAS
    from safety_agent.signals.disproportionality import analyze
    from safety_agent.signals.tables import build_table_from_counts

    provenance = json.loads(write_artifacts(_result(), tmp_path)["provenance"].read_text(encoding="utf-8"))
    assert provenance["formulas"] == FORMULAS
    assert provenance["display_convention"] == "evimed-display-v1"
    for column in ("expected_count", "ROR", "PRR", "chi2", "IC", "IC025", "EBGM", "EB05"):
        assert column in FORMULAS, column
    assert FORMULAS["expected_count"].startswith("E = (a+b)(a+c)/N")
    table = build_table_from_counts(joint=10, drug_total=100, event_total=30, grand_total=2000)
    metrics = analyze(table)
    assert metrics.ebgm.expected == (10 + 90) * (10 + 20) / 2000


def test_signal_csv_same_data_source():
    import csv as csv_module
    import io

    csv_text = signal_table_csv(_result())
    rows = list(csv_module.reader(io.StringIO(csv_text)))
    # Row 0 names the tier that produced the numbers; row 1 is the header.
    assert rows[0][0].startswith("# data_source=")
    assert "statistics_version=" in rows[0][0]
    assert rows[1][:7] == ["reaction", "source", "a", "b", "c", "d", "N"]
    assert len(rows) == 3
    cells = rows[2]
    assert cells[0] == "myalgia"
    assert cells[2:7] == ["10", "90", "20", "1,880", "2,000"]
    # Raw columns carry the value at full precision; the *_display columns
    # carry what a report states.
    header = rows[1]
    assert float(cells[header.index("ROR")]) == T1_ROW.ror
    assert cells[header.index("ROR_display")] == "10.44"
    assert cells[header.index("ROR_CI_display")] == "4.75–22.97"
    assert cells[header.index("IC025_display")] == "1.73"
    assert cells[header.index("is_signal")] == "yes"
    assert header[header.index("expected_count"):header.index("is_signal") + 1] == [
        "expected_count",
        "haldane_anscombe_applied",
        "gps_prior_id",
        "is_signal",
    ]
    assert header[-1] == "expected_count_display"


def test_docx_export_roundtrip(tmp_path):
    path = export_docx(_result(), tmp_path / "report.docx")
    assert path.is_file() and path.stat().st_size > 5000
    from docx import Document

    document = Document(path)
    headings = [
        p.text
        for p in document.paragraphs
        if p.style.name.startswith(("Heading", "Title"))
    ]
    assert any("atorvastatin" in h for h in headings)
    assert any("失比例信号分析" in h for h in headings)
    assert any("局限性声明" in h for h in headings)
    tables_text = "\n".join(
        cell.text for table in document.tables for row in table.rows for cell in row.cells
    )
    assert "myalgia" in tables_text
    assert "10.44 [4.75, 22.97]" in tables_text


def test_pdf_export_via_libreoffice(tmp_path):
    docx = export_docx(_result(), tmp_path / "report.docx")
    pdf = export_pdf(docx, tmp_path)
    if pdf is None:
        pytest.skip("LibreOffice not installed on this machine")
    assert pdf.is_file() and pdf.stat().st_size > 10000
    assert pdf.read_bytes()[:4] == b"%PDF"


@pytest.mark.parametrize("cells", [(55, 7902, 49431, 13783147), (0, 50, 10, 940), (5, 0, 100, 895), (7, 17, 31, 109)])
def test_expected_count_worked_example_uses_raw_row_and_column_margins(cells):
    from decimal import Decimal
    from safety_agent.signals import ContingencyTable2x2, analyze
    a, b, c, d = cells
    metrics = analyze(ContingencyTable2x2(a=a, b=b, c=c, d=d))
    row = T1_ROW.model_copy(update={"a": a, "b": b, "c": c, "d": d, "n": sum(cells),
                                   "expected_count": metrics.ebgm.expected,
                                   "haldane_anscombe_applied": metrics.haldane_anscombe_applied})
    calculation = row.expected_count_calculation
    assert calculation["raw_cells"] == {"a": a, "b": b, "c": c, "d": d, "n": sum(cells)}
    assert calculation["drug_margin"] == a + b
    assert calculation["event_margin"] == a + c
    oracle = Decimal(a + b) * Decimal(a + c) / Decimal(sum(cells))
    assert calculation["expected_count"] == pytest.approx(float(oracle), rel=1e-14)
    assert calculation["worked_example"].endswith(row.display["expected_count"])
    if metrics.haldane_anscombe_applied:
        assert calculation["drug_margin"] != metrics.table.a + metrics.table.b


def test_expected_count_example_and_table_share_the_recorded_value():
    row = T1_ROW.model_copy(update={"expected_count": 1.5})
    report = render_markdown(_result(signals=[row]))
    assert "E = (a+b) × (a+c) / N = 100 × 30 / 2,000 ≈ 1.5" in report
    assert "| E |" in report
    assert row.display["expected_count"] in report
    assert T1_ROW.expected_count_calculation["worked_example"] is None


def test_interpretation_distinguishes_yearly_counts_from_an_unperformed_lag_analysis():
    from safety_agent.analysis.interpret import build_interpretation_context
    row = T1_ROW.model_copy(update={"expected_count": 1.5})
    context = build_interpretation_context(drug="atorvastatin", overview=_result().overview,
        signals=[row], label_check=None, focus_reactions=["myalgia"])
    assert context["signal_table"][0]["expected_count_calculation"] == row.expected_count_calculation
    assert context["yearly_count_interpretation"]["reporting_lag_analysis"] == "not_performed"
    assert context["yearly_count_interpretation"]["causal_explanations"] == "hypotheses_only"
    assert context["yearly_counts"] == [{"term": "2023", "count": 100}, {"term": "2024", "count": 120}]


def test_docx_and_provenance_carry_the_same_worked_example(tmp_path):
    import json
    from docx import Document
    from safety_agent.analysis.runner import write_artifacts
    row = T1_ROW.model_copy(update={"expected_count": 1.5})
    artifacts = write_artifacts(_result(signals=[row]), tmp_path)
    document = Document(artifacts["docx"])
    assert row.expected_count_calculation["worked_example"] in "\n".join(p.text for p in document.paragraphs)
    signal_table = next(table for table in document.tables if table.rows[0].cells[0].text == "ADR")
    headers = [cell.text for cell in signal_table.rows[0].cells]
    assert signal_table.rows[1].cells[headers.index("E")].text == row.display["expected_count"]
    provenance = json.loads(artifacts["provenance"].read_text())
    assert provenance["expected_count_calculations"][0] == {"reaction": row.reaction, **row.expected_count_calculation}
    assert provenance["yearly_count_interpretation"]["reporting_lag_analysis"] == "not_performed"


@pytest.mark.parametrize("expected", [float("nan"), float("inf"), float("-inf"), None, 0.0, 1.5])
def test_provenance_projection_is_strict_json_with_nonfinite_expected_counts(tmp_path, monkeypatch, expected):
    import json
    from safety_agent.analysis import runner
    # PDF conversion is independently covered; this regression inspects the JSON writer.
    monkeypatch.setattr(runner, "export_pdf", lambda *args: None)
    row = T1_ROW.model_copy(update={"expected_count": expected})
    artifact = runner.write_artifacts(_result(signals=[row]), tmp_path)["provenance"]
    def reject(value):
        raise AssertionError(f"Invalid JSON numeric constant: {value}")
    stored = json.loads(artifact.read_text(), parse_constant=reject)
    value = stored["expected_count_calculations"][0]["expected_count"]
    assert value == expected if expected is not None and __import__("math").isfinite(expected) else value is None
