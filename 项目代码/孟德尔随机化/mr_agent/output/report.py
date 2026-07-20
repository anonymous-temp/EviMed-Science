# [IN] MRAnalysisResult, paper sections
# [OUT] PDF report
# [POS] mr_agent/output/report.py - PDF/report assembly
"""Report assembly - PDF generation."""

from __future__ import annotations

import logging
from pathlib import Path

from mr_agent.models import MRAnalysisResult, SessionState

logger = logging.getLogger(__name__)


def _escape_xml(text: str) -> str:
    """Escape text for reportlab XML paragraphs."""
    return (
        text.strip()
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def generate_pdf_report(
    state: SessionState,
    output_dir: Path | None = None,
) -> Path:
    """Generate complete PDF report with text and plots."""
    output_dir = output_dir or state.output_dir or Path("mr_output")
    output_dir.mkdir(parents=True, exist_ok=True)
    filepath = output_dir / "mr_report.pdf"
    _build_pdf(state, filepath)
    return filepath


def _build_pdf(state: SessionState, filepath: Path) -> None:
    """Build PDF using reportlab."""
    from reportlab.lib.pagesizes import letter
    from reportlab.platypus import SimpleDocTemplate, Spacer
    from reportlab.lib.units import inch

    doc = SimpleDocTemplate(str(filepath), pagesize=letter)
    styles = _create_styles()
    story = []
    exp = state.slots.exposure or "Exposure"
    out = state.slots.outcome or "Outcome"
    story.append(_make_paragraph(f"MR Analysis: {exp} and {out}", styles["title"]))
    story.append(Spacer(1, 0.3 * inch))
    _add_results_section(story, state.analysis_results, styles["heading"], styles["body"])
    _add_interpretations(story, state.analysis_results, styles["heading"], styles["body"])
    if state.paper_sections:
        _add_paper_sections(story, state.paper_sections, styles["heading"], styles["body"])
    doc.build(story)
    _merge_plots(filepath, state.analysis_results)
    logger.info(f"PDF report saved to {filepath}")


def _create_styles() -> dict:
    """Create PDF styles."""
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    styles = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("T", parent=styles["Title"], fontSize=16, spaceAfter=20),
        "heading": ParagraphStyle("H", parent=styles["Heading1"], fontSize=14, spaceAfter=12),
        "body": ParagraphStyle("B", parent=styles["Normal"], fontSize=11, leading=16, spaceAfter=8),
    }


def _make_paragraph(text: str, style):
    """Create a Paragraph object."""
    from reportlab.platypus import Paragraph
    return Paragraph(text, style)


def _add_results_section(story, results, heading_style, body_style) -> None:
    """Add MR results to PDF."""
    from reportlab.platypus import Paragraph, Spacer
    from reportlab.lib.units import inch
    story.append(Paragraph("MR Analysis Results", heading_style))
    for r in results:
        if not r.mr_results:
            continue
        story.append(Paragraph(
            f"<b>{r.exposure_name} → {r.outcome_name}</b>", body_style
        ))
        for mr in r.mr_results:
            line = (
                f"{mr.method}: beta={mr.beta:.4f}, "
                f"p={mr.pval:.2e}"
            )
            if mr.or_value is not None:
                line += f", OR={mr.or_value:.3f}"
            story.append(Paragraph(line, body_style))
        story.append(Spacer(1, 0.2 * inch))


def _add_interpretations(story, results, heading_style, body_style) -> None:
    """Add LLM interpretations to PDF."""
    from reportlab.platypus import Paragraph, Spacer
    from reportlab.lib.units import inch
    story.append(Paragraph("Interpretation", heading_style))
    for r in results:
        if not r.interpretation:
            continue
        for para in r.interpretation.split("\n\n"):
            para = _escape_xml(para)
            if para:
                story.append(Paragraph(para, body_style))
        story.append(Spacer(1, 0.2 * inch))


def _add_paper_sections(story, paper, heading_style, body_style) -> None:
    """Add paper sections to PDF."""
    from reportlab.platypus import Paragraph, Spacer, PageBreak
    from reportlab.lib.units import inch
    story.append(PageBreak())
    order = [
        "abstract", "introduction", "methods", "results",
        "discussion", "limitations", "conclusion",
    ]
    for section in order:
        text = paper.get(section, "")
        if not text:
            continue
        story.append(Paragraph(section.upper(), heading_style))
        for para in text.split("\n\n"):
            para = _escape_xml(para)
            if para:
                story.append(Paragraph(para, body_style))
        story.append(Spacer(1, 0.3 * inch))


def _merge_plots(report_path: Path, results: list[MRAnalysisResult]) -> None:
    """Merge plot PDFs into the report."""
    from PyPDF2 import PdfReader, PdfWriter
    writer = PdfWriter()
    reader = PdfReader(str(report_path))
    for page in reader.pages:
        writer.add_page(page)
    for r in results:
        _append_result_plots(writer, r)
    with open(str(report_path), "wb") as f:
        writer.write(f)


def _append_result_plots(writer, result: MRAnalysisResult) -> None:
    """Append all plot PDFs from a single result to the writer."""
    from PyPDF2 import PdfReader
    for plot_path in result.plots.values():
        if not plot_path.exists():
            continue
        # Only merge PDF files; skip PNGs and other non-PDF formats
        if plot_path.suffix.lower() != ".pdf":
            continue
        try:
            plot_reader = PdfReader(str(plot_path))
            for page in plot_reader.pages:
                writer.add_page(page)
        except Exception as e:
            logger.warning(f"Failed to merge plot {plot_path}: {e}")
