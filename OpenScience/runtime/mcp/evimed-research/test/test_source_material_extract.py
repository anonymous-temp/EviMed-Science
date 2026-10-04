"""The source-material extractor: a PDF's text page by page, a spreadsheet's cells
with their addresses, and named reasons for everything else.

Builds its own PDFs byte by byte (through the record extractor's test helper) and
its own workbooks with openpyxl, so nothing here needs a fixture file and the
suite runs the same where there is no PDF writer.
"""

import hashlib
import io
import json
import pathlib
import sys
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import source_material_extract as extract  # noqa: E402
from test_vcr_record_extract import pdf_bytes  # noqa: E402

try:
    import openpyxl  # noqa: F401

    HAVE_OPENPYXL = True
except ImportError:  # pragma: no cover - the image and CI ship it
    HAVE_OPENPYXL = False


def stage(directory, name, data, form, limits=None, sha256=None, size=None):
    """The attempt directory the control plane stages: the file, and the request that names it."""
    root = pathlib.Path(directory)
    (root / "input").mkdir()
    (root / "output").mkdir()
    (root / "input" / name).write_bytes(data)
    request = {
        "format": form,
        "file": {"name": name, "sha256": sha256 or hashlib.sha256(data).hexdigest(), "bytes": len(data) if size is None else size},
        "limits": limits or {},
    }
    (root / "input" / "request.json").write_text(json.dumps(request), encoding="utf-8")
    return root


def run(directory, deadline=0):
    code = extract.main([
        "--request", str(directory / "input" / "request.json"), "--input-dir", str(directory / "input"),
        "--output-dir", str(directory / "output"), "--deadline", str(deadline),
    ])
    assert code == 0
    return json.loads((directory / "output" / "result.json").read_text(encoding="utf-8"))


class PdfPages(unittest.TestCase):
    def test_every_page_text_is_reported_with_whether_it_has_a_text_layer(self):
        pages = [
            ["Table 2. Baseline characteristics", "Age years 61.2 9.8 60.7 10.1", "Male sex 72 60.0 69 58.5"],
            [],  # a scan: ink, no text
            ["Table 3. Outcomes at week 24", "Primary composite 22 118 18.6 38 120 31.7"],
        ]
        with tempfile.TemporaryDirectory() as tmp:
            staged = stage(tmp, "document.pdf", pdf_bytes(pages), "pdf")
            result = run(staged)
            texts = json.loads((staged / "output" / "pages.json").read_text(encoding="utf-8"))
        self.assertEqual(result["outcome"], "pages")
        self.assertEqual((result["pages"], result["pagesRead"]), (3, 3))
        self.assertEqual(result["textLayer"], [True, False, True])
        self.assertEqual(len(texts), 3)
        self.assertIn("Male sex 72 60.0 69 58.5", texts[0])
        self.assertEqual(texts[1], "")
        self.assertIn("Primary composite", texts[2])
        self.assertFalse(result["truncated"])
        self.assertEqual(result["extractor"]["name"], extract.NAME)
        self.assertIn("pypdf", result["extractor"]["libraries"])

    def test_a_page_with_a_running_head_only_is_not_a_text_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run(stage(tmp, "document.pdf", pdf_bytes([["12"], ["A page with a good deal of running text to read here."]]), "pdf"))
        self.assertEqual(result["textLayer"], [False, True])

    def test_the_page_ceiling_and_the_character_ceiling_are_honoured(self):
        with tempfile.TemporaryDirectory() as tmp:
            refused = run(stage(tmp, "document.pdf", pdf_bytes([["a"]] * 4), "pdf", {"maxPages": 3}))
        self.assertEqual((refused["outcome"], refused["reason"]), ("refused", "too_many_pages"))
        with tempfile.TemporaryDirectory() as tmp:
            capped = run(stage(tmp, "document.pdf", pdf_bytes([["x" * 40]] * 6), "pdf", {"maxChars": 90}))
        self.assertTrue(capped["truncated"])
        self.assertEqual(capped["pages"], 6)
        self.assertLess(capped["pagesRead"], 6)

    def test_a_file_that_is_not_the_one_named_is_refused_before_it_is_read(self):
        data = pdf_bytes([["hello world text here for the page"]])
        for kwargs in ({"sha256": "0" * 64}, {"size": len(data) + 1}):
            with tempfile.TemporaryDirectory() as tmp:
                result = run(stage(tmp, "document.pdf", data, "pdf", **kwargs))
            self.assertEqual((result["outcome"], result["reason"]), ("refused", "request_invalid"), kwargs)
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(run(stage(tmp, "document.pdf", b"not a pdf at all", "pdf"))["reason"], "not_pdf")
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(run(stage(tmp, "document.pdf", pdf_bytes([["x"]]), "docx"))["reason"], "request_invalid")

    def test_a_file_name_that_is_a_path_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run(stage(tmp, "document.pdf", pdf_bytes([["x"]]), "pdf"))
            self.assertEqual(result["outcome"], "pages")
        with tempfile.TemporaryDirectory() as tmp:
            staged = stage(tmp, "document.pdf", pdf_bytes([["x"]]), "pdf")
            request = json.loads((staged / "input" / "request.json").read_text())
            request["file"]["name"] = "../document.pdf"
            (staged / "input" / "request.json").write_text(json.dumps(request))
            self.assertEqual(run(staged)["reason"], "request_invalid")


def workbook_bytes(build):
    from openpyxl import Workbook

    book = Workbook()
    build(book)
    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


@unittest.skipUnless(HAVE_OPENPYXL, "openpyxl is not installed")
class SpreadsheetCells(unittest.TestCase):
    def build(self, book):
        sheet = book.active
        sheet.title = "Table S2"
        sheet["A1"], sheet["B1"], sheet["C1"] = "Arm", "n (%)", "Rate, %"
        sheet["A2"], sheet["B2"], sheet["C2"] = "Drug", "12 (40.0)", 0.4
        sheet["C2"].number_format = "0.0%"
        sheet["A3"], sheet["B3"], sheet["C3"] = "Placebo", 9, "=B3/B2"
        sheet.merge_cells("A5:C5")
        sheet["A5"] = "Footer note"
        hidden = book.create_sheet("Hidden")
        hidden["A1"] = "secret"
        hidden.sheet_state = "hidden"

    def test_cells_come_out_with_their_addresses_types_formulas_and_formats(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run(stage(tmp, "supplement.xlsx", workbook_bytes(self.build), "xlsx"))
        self.assertEqual(result["outcome"], "cells")
        first, second = result["sheets"]
        self.assertEqual((first["name"], first["state"], first["index"]), ("Table S2", "visible", 1))
        self.assertEqual(second["state"], "hidden")
        by_address = {cell["a"]: cell for cell in first["cells"]}
        self.assertEqual(by_address["A1"], {"a": "A1", "k": "s", "v": "Arm"})
        self.assertEqual(by_address["B2"]["v"], "12 (40.0)")
        self.assertEqual((by_address["C2"]["k"], by_address["C2"]["v"], by_address["C2"]["nf"]), ("n", 0.4, "0.0%"))
        self.assertEqual((by_address["B3"]["k"], by_address["B3"]["v"]), ("n", 9))
        # openpyxl wrote the formula and no cached value: the formula is reported, with no value.
        self.assertEqual(by_address["C3"]["f"], "=B3/B2")
        self.assertIsNone(by_address["C3"]["v"])
        self.assertEqual(first["merges"], ["A5:C5"])
        self.assertEqual(first["totalCells"], len(first["cells"]))
        self.assertEqual(first["dimensions"], {"rows": 5, "cols": 3})
        self.assertFalse(first["truncated"])

    def test_a_cached_formula_value_is_reported_only_when_the_file_holds_one(self):
        # Rewrite the sheet XML so the formula cell carries a cached value, as Excel writes it.
        raw = workbook_bytes(self.build)
        patched = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(raw)) as source, zipfile.ZipFile(patched, "w", zipfile.ZIP_DEFLATED) as target:
            for member in source.infolist():
                body = source.read(member)
                if member.filename == "xl/worksheets/sheet1.xml":
                    text = body.decode("utf-8")
                    assert "<f>B3/B2</f><v></v>" in text, "openpyxl wrote the formula cell in another shape"
                    body = text.replace("<f>B3/B2</f><v></v>", "<f>B3/B2</f><v>0.75</v>").encode("utf-8")
                target.writestr(member, body)
        with tempfile.TemporaryDirectory() as tmp:
            result = run(stage(tmp, "supplement.xlsx", patched.getvalue(), "xlsx"))
        cell = {item["a"]: item for item in result["sheets"][0]["cells"]}["C3"]
        self.assertEqual(cell["f"], "=B3/B2")
        self.assertEqual(cell["v"], 0.75)

    def test_a_sheet_lists_at_most_the_cells_it_was_asked_for_and_says_how_many_it_has(self):
        def many(book):
            sheet = book.active
            for row in range(1, 41):
                sheet.cell(row=row, column=1, value=row)

        with tempfile.TemporaryDirectory() as tmp:
            result = run(stage(tmp, "data.xlsx", workbook_bytes(many), "xlsx", {"maxCellsPerSheet": 10}))
        sheet = result["sheets"][0]
        self.assertEqual((len(sheet["cells"]), sheet["totalCells"], sheet["truncated"]), (10, 40, True))
        self.assertEqual(sheet["beyond"], 30, "the numbers it did not list are counted")

    def test_what_is_not_a_spreadsheet_or_is_hostile_is_a_named_reason(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(run(stage(tmp, "data.xlsx", b"plain text", "xlsx"))["reason"], "not_xlsx")
        raw = workbook_bytes(self.build)
        hostile = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(raw)) as source, zipfile.ZipFile(hostile, "w", zipfile.ZIP_DEFLATED) as target:
            for member in source.infolist():
                body = source.read(member)
                if member.filename == "xl/workbook.xml":
                    declaration, _, rest = body.partition(b"?>") if body.startswith(b"<?xml") else (b"", b"", body)
                    body = declaration + (b"?>" if declaration else b"") + b'<!DOCTYPE x [<!ENTITY a "b">]>' + rest
                target.writestr(member, body)
        with tempfile.TemporaryDirectory() as tmp:
            refused = run(stage(tmp, "data.xlsx", hostile.getvalue(), "xlsx"))
        self.assertEqual((refused["outcome"], refused["reason"]), ("refused", "corrupt"))
        # A zip that is not a workbook is not one, and no message of the file reaches the answer.
        junk = io.BytesIO()
        with zipfile.ZipFile(junk, "w") as target:
            target.writestr("hello.txt", "my secret patient name")
        with tempfile.TemporaryDirectory() as tmp:
            result = run(stage(tmp, "data.xlsx", junk.getvalue(), "xlsx"))
        self.assertEqual(result["reason"], "not_xlsx")
        self.assertNotIn("secret", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
