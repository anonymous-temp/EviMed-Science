from pathlib import Path
from uuid import uuid4

from PIL import Image

from new_meta.core.document_export import export_manuscript_pdf
from new_meta.core.project import Project


def test_pdf_export_scales_tall_figure_to_fit_page(tmp_path: Path) -> None:
    project = Project("tall figure export", output_dir=tmp_path / uuid4().hex)
    figures_dir = project.base_dir / "figures"
    figures_dir.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (400, 2400), color="white").save(figures_dir / "rob_summary.png")
    project.save_text(
        "draft.md",
        "\n".join([
            "# Tall figure manuscript",
            "",
            "## Results",
            "Figure 1 summarizes risk of bias.",
            "",
            "## Figures",
            "### Figure 1. Risk-of-bias summary",
            "![Figure 1. Risk-of-bias summary](../figures/rob_summary.png)",
        ]),
        subdir="manuscript",
    )

    pdf_path = export_manuscript_pdf(project)

    assert pdf_path is not None
    assert pdf_path.exists()
    assert pdf_path.stat().st_size > 0


# Verbatim Table 2 / Appendix 2 row of the ma-001 manuscript: a quoted source
# table whose pipes are escaped inside one cell.
_ESCAPED_PIPE_ROW = (
    "| Montovanelli 2021 | result:34566475:1 | Table 5 (Drained Blood, ml), rows Group 1 and Group 2; "
    "pairwise p-value from Table 6 | Drained Blood \\| Group 1 \\| 453.6 \\| 475.0 \\| 191.9 \\| 42% \\| "
    "200.0 \\| 710.0 \\| 14 \\| 100.5 \\| 0.001* ; Group 2 \\| 341.1 \\| 332.5 \\| 216.7 \\| 64% \\| 100.0 \\| "
    "890.0 \\| 14 \\| 113.5 ; Table 6... | verified |"
)


def test_escaped_pipes_stay_inside_their_cell() -> None:
    from new_meta.core.document_export import _split_table_row

    cells = _split_table_row(_ESCAPED_PIPE_ROW)

    assert len(cells) == 5
    assert cells[3].startswith("Drained Blood | Group 1 | 453.6 | 475.0")
    assert cells[4] == "verified"


# Verbatim Appendix 2 of the ma-001 run-12 draft; the naive split made it
# 23 cells wide and reportlab raised LayoutError, so no package was written.
_MA001_APPENDIX_2 = [
    "| 研究 | 行ID | 来源位置 | 来源依据 | 提取置信度 |",
    "|---|---|---|---|---|",
    "| Alexandru 2016 | result:28326403:0 | Table 3 | EBL (mL) \\| 746.6 ± 270 \\| 747.9 ± 298 \\| 938.9 ± 376 "
    "\\| 1077.6± 371 \\|.0002 | verified |",
    "| Shih-Hsiang 2021 | result:33511201:0 | Results, paragraph 1; Table 3, 'Total blood loss (mL)' row | "
    "The mean TBL in the TXA group was 645 ± 209 mL (227 to 1090 mL), which was lower than 1103 ± 305 mL "
    "(424 to 1711 mL) in the placebo group (p < 0.001). \\| Table 3: Total blood... | verified |",
    "| Montovanelli 2021 | result:34566475:1 | Table 5 (Drained Blood, ml), rows Group 1 and Group 2; pairwise "
    "p-value from Table 6 | Drained Blood \\| Group 1 \\| 453.6 \\| 475.0 \\| 191.9 \\| 42% \\| 200.0 \\| "
    "710.0 \\| 14 \\| 100.5 \\| 0.001*; Group 2 \\| 341.1 \\| 332.5 \\| 216.7 \\| 64% \\| 100.0 \\| "
    "890.0 \\| 14 \\| 113.5; Table 6... | verified |",
]


def test_pdf_export_lays_out_the_ma001_source_appendix(tmp_path: Path) -> None:
    project = Project("escaped pipe export", output_dir=tmp_path / uuid4().hex)
    project.save_text(
        "draft.md",
        "\n".join(["# 标题", "", "## 补充材料", "### 附录2. 主要分析记录的来源核验", *_MA001_APPENDIX_2]),
        subdir="manuscript",
    )

    pdf_path = export_manuscript_pdf(project)

    assert pdf_path is not None and pdf_path.exists()


# Verbatim Table 1 of a ma-001 narrative draft (fresh run 13, attempt 4): with
# content-sized columns reportlab gave one column a negative width and the
# export raised ValueError, so the run ended without a package.
_MA001_TEN_COLUMN_TABLE = [
    "| 研究 | 年份 | 研究设计 | 国家 | N（干预/对照） | 人群 | 干预措施 | 对照措施 | 随访 | 主要终点 |",
    "|---|---|---|---|---|---|---|---|---|---|",
    "| Helito et al. | 2019 | RCT（前瞻性、随机、三臂） | 巴西 | 30/30（TXA/对照；三臂共90） | "
    "拟行初次单侧全膝关节置换术的成人（年龄>21岁；排除炎症性关节炎、膝关节僵硬、肾功能不全、凝血功能障碍及血栓栓塞病史等） | "
    "氨甲环酸（TXA）静脉给药，于充气止血带前至少20分钟给予10 mg/kg，止血带松开前再给予10 mg/kg | "
    "不予TXA及Floseal®，仅接受常规手术处理 | 至少12个月（并发症随访90天） | 出血控制（引流量、输血率；主要终点未明确标注） |",
]


def test_pdf_export_lays_out_a_ten_column_characteristics_table(tmp_path: Path) -> None:
    from new_meta.core.document_export import _pdf_column_widths, _split_table_row

    rows = [_split_table_row(line) for line in _MA001_TEN_COLUMN_TABLE[::2]]
    widths = _pdf_column_widths(rows, 10, 492.0)
    assert len(widths) == 10 and min(widths) > 20 and abs(sum(widths) - 492.0) < 1e-6

    project = Project("ten column export", output_dir=tmp_path / uuid4().hex)
    project.save_text(
        "draft.md",
        "\n".join(["# 标题", "", "## 表格", "### 表1. 纳入研究基本特征", "", *_MA001_TEN_COLUMN_TABLE]),
        subdir="manuscript",
    )

    pdf_path = export_manuscript_pdf(project)

    assert pdf_path is not None and pdf_path.exists()
