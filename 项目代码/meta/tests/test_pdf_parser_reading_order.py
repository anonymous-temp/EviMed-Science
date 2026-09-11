from __future__ import annotations

import hashlib
import re
from pathlib import Path

import pytest
from reportlab.pdfgen import canvas

from new_meta.agents.pdf_parser import _parse_with_pdfplumber, get_page_for_position
from new_meta.core.pdf_intake import PDF_PARSE_CACHE_VERSION, parse_file_with_cache


def _lines(pdf: canvas.Canvas, x: float, y: float, lines: list[str]) -> None:
    text = pdf.beginText(x, y)
    text.setFont("Helvetica", 10)
    text.setLeading(14)
    for line in lines:
        text.textLine(line)
    pdf.drawText(text)


def _table(pdf: canvas.Canvas) -> None:
    pdf.setFont("Helvetica", 9)
    pdf.rect(0, 0, 300, 75)
    pdf.line(140, 0, 140, 75)
    for y in (25, 50):
        pdf.line(0, y, 300, y)
    for y, left, right in (
        (60, "Outcome", "Reported result"),
        (35, "Kidney composite", "0.66 (0.53-0.81)"),
        (10, "Events", "153/2202 224/2199"),
    ):
        pdf.drawString(5, y, left)
        pdf.drawString(145, y, right)


def test_two_column_prose_preserves_reading_order_and_source_bytes(tmp_path: Path) -> None:
    path = tmp_path / "columns.pdf"
    pdf = canvas.Canvas(str(path))
    _lines(pdf, 40, 740, [
        "A randomized cohort was analyzed",
        "using a stratified Cox model.",
        "Reported HR 0.67 (0.54-0.83).",
    ])
    _lines(pdf, 330, 740, [
        "Unrelated section starts here.",
        "Do not merge this sentence.",
        "Registry NCT01234567.",
    ])
    pdf.save()
    source_hash = hashlib.sha256(path.read_bytes()).hexdigest()

    parsed = _parse_with_pdfplumber(str(path))
    text = " ".join(parsed["full_text"].split())

    assert "A randomized cohort was analyzed using a stratified Cox model." in text
    assert "Unrelated section starts here. Do not merge this sentence." in text
    assert text.index("0.67 (0.54-0.83)") < text.index("Unrelated section")
    assert hashlib.sha256(path.read_bytes()).hexdigest() == source_hash


@pytest.mark.parametrize("angle", [90, -90])
def test_rotated_table_retains_numeric_tokens_without_claiming_cell_relationships(
    tmp_path: Path, angle: int,
) -> None:
    path = tmp_path / "rotated.pdf"
    pdf = canvas.Canvas(str(path))
    pdf.drawString(40, 760, "Synthetic rotated table")
    pdf.saveState()
    pdf.translate(200, 100 if angle == 90 else 600)
    pdf.rotate(angle)
    _table(pdf)
    pdf.restoreState()
    pdf.save()

    parsed = _parse_with_pdfplumber(str(path))
    text = parsed["full_text"]

    for value in ("153/2202", "224/2199", "0.66", "0.53-0.81"):
        assert value in text
    assert "[ROTATED TEXT: cell relationships are not inferred]" in text
    assert parsed["tables"] == []
    assert any(warning["code"] == "rotated_table_unstructured" for warning in parsed["parse_warnings"])


def test_rotated_margin_label_does_not_discard_an_upright_table(tmp_path: Path) -> None:
    path = tmp_path / "mixed.pdf"
    pdf = canvas.Canvas(str(path))
    pdf.saveState()
    pdf.translate(150, 500)
    _table(pdf)
    pdf.restoreState()
    pdf.saveState()
    pdf.translate(40, 100)
    pdf.rotate(90)
    pdf.drawString(0, 0, "Margin label 2026")
    pdf.restoreState()
    pdf.save()

    parsed = _parse_with_pdfplumber(str(path))

    assert len(parsed["tables"]) == 1
    assert "153/2202 224/2199" in parsed["tables"][0]
    assert "2026" in parsed["full_text"]
    assert not any(warning["code"] == "rotated_table_unstructured" for warning in parsed["parse_warnings"])


def test_page_offsets_and_signed_numeric_text_survive_reading_order_change(tmp_path: Path) -> None:
    path = tmp_path / "pages.pdf"
    pdf = canvas.Canvas(str(path))
    _lines(pdf, 40, 740, ["First page result -0.31 and P<0.001."])
    pdf.showPage()
    pdf.showPage()
    _lines(pdf, 40, 740, ["Third page result +1.25 and 95% CI."])
    pdf.save()

    parsed = _parse_with_pdfplumber(str(path))

    assert [entry["page_number"] for entry in parsed["page_map"]] == [1, 2, 3]
    assert re.findall(r"[+-]\d+\.\d+", parsed["full_text"]) == ["-0.31", "+1.25"]
    for value, number in (("-0.31", 1), ("+1.25", 3)):
        assert get_page_for_position(parsed["full_text"].index(value), parsed["page_map"]) == number


def test_new_parser_cache_leaves_historical_parse_untouched(tmp_path: Path) -> None:
    path = tmp_path / "source.pdf"
    path.write_bytes(b"synthetic cache identity")
    old, _ = parse_file_with_cache(
        path, tmp_path, parse_func=lambda _: {"full_text": "historical order"},
        parser_used="pdf_parser", parser_version="pdf_parse_cache_v1_pdf",
    )
    old_cache = next((tmp_path / "pdf_parse_cache").glob("*.json"))
    old_bytes = old_cache.read_bytes()

    current, cache_hit = parse_file_with_cache(
        path, tmp_path, parse_func=lambda _: {"full_text": "new reading order"},
        parser_used="pdf_parser", parser_version=f"{PDF_PARSE_CACHE_VERSION}_pdf",
    )

    assert cache_hit is False
    assert current["full_text"] == "new reading order"
    assert current["_source_sha256"] == old["_source_sha256"]
    assert old_cache.read_bytes() == old_bytes
