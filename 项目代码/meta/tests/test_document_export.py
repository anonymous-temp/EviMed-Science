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
