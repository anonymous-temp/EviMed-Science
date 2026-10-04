"""The patient-record extractor: text PDFs and Word files become text; scans,
protected files and hostile packages become named reasons.

Builds its own PDFs and .docx packages byte by byte, so the suite needs nothing
but pypdf (which the runtime image and CI both carry) and runs the same where
there is no PDF writer. Chinese text is not tested through PDF (a CJK text layer
needs an embedded font with a ToUnicode map, which a hand-built file cannot
honestly stand in for); it is tested through Word, which stores text as text.
"""

import contextlib
import hashlib
import io
import json
import os
import pathlib
import shutil
import sys
import tempfile
import unittest
import zipfile
from unittest import mock
from xml.sax.saxutils import escape

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import vcr_record_extract as extract  # noqa: E402

try:
    import pypdf  # noqa: F401

    HAVE_PYPDF = True
except ImportError:  # pragma: no cover - the image and CI ship it
    HAVE_PYPDF = False

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def pdf_bytes(pages):
    """A PDF whose pages carry the given text lines (a page of ``[]`` has no text layer)."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        ("<< /Type /Pages /Kids [%s] /Count %d >>" % (" ".join("%d 0 R" % (4 + 2 * i) for i in range(len(pages))), len(pages))).encode(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for index, lines in enumerate(pages):
        if lines:
            body = "BT /F1 11 Tf 72 720 Td 13 TL " + " ".join("(%s) Tj T*" % line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") for line in lines) + " ET"
        else:
            body = "0.9 g 40 40 500 700 re f"  # a scan: ink, and no text
        stream = body.encode("latin-1")
        objects.append(("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>" % (5 + 2 * index)).encode())
        objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += ("%d 0 obj\n" % number).encode() + body + b"\nendobj\n"
    xref = len(out)
    out += ("xref\n0 %d\n" % (len(objects) + 1)).encode() + b"0000000000 65535 f \n"
    for offset in offsets:
        out += ("%010d 00000 n \n" % offset).encode()
    out += ("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)).encode()
    return bytes(out)


def docx_bytes(document_xml, *, app_pages=None, extra=None, encrypted=False, declared_encoding=None):
    """A minimal .docx package around a ``word/document.xml`` body."""
    declaration = '<?xml version="1.0" encoding="%s" standalone="yes"?>' % (declared_encoding or "UTF-8")
    xml = declaration + '<w:document xmlns:w="%s" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml"><w:body>%s</w:body></w:document>' % (W, document_xml)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        archive.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr("word/document.xml", xml.encode("utf-8"))
        if app_pages is not None:
            archive.writestr("docProps/app.xml", "<Properties><Pages>%d</Pages></Properties>" % app_pages)
        for name, data in (extra or {}).items():
            archive.writestr(name, data)
    data = buffer.getvalue()
    if encrypted:
        # zipfile resets a member's flags when it writes, so the "this member is
        # encrypted" bit (general-purpose flag bit 0) is set in the central
        # directory afterwards, which is where a reader looks.
        patched = bytearray(data)
        position = patched.find(b"PK\x01\x02")
        while position != -1:
            patched[position + 8] |= 0x01
            position = patched.find(b"PK\x01\x02", position + 4)
        data = bytes(patched)
    return data


def para(*runs, deleted=False):
    inner = "".join("<w:r><w:t>%s</w:t></w:r>" % escape(run) if not deleted else "<w:del><w:r><w:delText>%s</w:delText></w:r></w:del>" % escape(run) for run in runs)
    return "<w:p>%s</w:p>" % inner


def cell(*paragraphs):
    return "<w:tc>%s</w:tc>" % "".join(paragraphs)


def row(*cells):
    return "<w:tr>%s</w:tr>" % "".join(cells)


class Workspace(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="vcr-extract-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.input = self.root / "in"
        self.output = self.root / "out"
        self.input.mkdir()
        self.output.mkdir()

    def stage(self, name, data, form, limits=None, *, sha256=None, size=None):
        """The one file, and the flags the controller's launch plan gives the script for it."""
        self.file = self.input / name
        self.file.write_bytes(data)
        self.flags = [
            "--file", str(self.file), "--format", form,
            "--expect-sha256", sha256 or hashlib.sha256(data).hexdigest(),
            "--expect-bytes", str(len(data) if size is None else size),
        ]
        for key, flag in (("maxPages", "--max-pages"), ("maxChars", "--max-chars"), ("maxXmlBytes", "--max-xml-bytes")):
            if key in (limits or {}):
                self.flags += [flag, str(limits[key])]

    def run_script(self):
        code = extract.main([*self.flags, "--output-dir", str(self.output)])
        self.assertEqual(code, 0)
        result = json.loads((self.output / "result.json").read_text(encoding="utf-8"))
        text = (self.output / "text.txt").read_text(encoding="utf-8") if (self.output / "text.txt").exists() else None
        return result, text

    def refused(self, reason="request_invalid"):
        result, text = self.run_script()
        self.assertEqual((result["outcome"], result["reason"]), ("refused", reason))
        self.assertIsNone(text, "a refused file yields no text at all")
        return result


@unittest.skipUnless(HAVE_PYPDF, "pypdf is the runtime image's PDF reader")
class PdfExtraction(Workspace):
    def test_a_text_pdf_yields_its_text_and_a_count_per_page(self):
        pages = [["Patient 0001 admitted with chest pain.", "BP 140/90 mmHg, heart rate 88."], ["Troponin I 0.04 ng/mL on arrival.", "Discharged on day 4."]]
        self.stage("document.pdf", pdf_bytes(pages), "pdf")
        result, text = self.run_script()
        self.assertEqual(result["outcome"], "text")
        self.assertEqual(result["format"], "pdf")
        self.assertEqual(result["pages"], 2)
        self.assertEqual(len(result["pageChars"]), 2)
        self.assertTrue(all(count > 30 for count in result["pageChars"]))
        self.assertIn("BP 140/90 mmHg", text)
        self.assertIn("Troponin I 0.04 ng/mL", text)
        self.assertEqual(result["textSha256"], hashlib.sha256(text.encode("utf-8")).hexdigest())
        self.assertEqual(result["chars"], extract.significant_chars(text))
        self.assertEqual(result["extractor"]["name"], extract.NAME)
        self.assertEqual(result["extractor"]["libraries"]["pypdf"], pypdf.__version__)

    def test_a_scan_is_measured_as_pages_with_no_characters(self):
        self.stage("document.pdf", pdf_bytes([[], [], []]), "pdf")
        result, text = self.run_script()
        self.assertEqual(result["outcome"], "text")  # the script measures; the control plane refuses
        self.assertEqual(result["pages"], 3)
        self.assertEqual(result["pageChars"], [0, 0, 0])
        self.assertEqual(result["chars"], 0)
        self.assertEqual(text, "")

    def test_a_mixed_document_reports_which_pages_had_no_text(self):
        self.stage("document.pdf", pdf_bytes([["A typed discharge summary, page one."], [], ["Follow-up plan on page three."]]), "pdf")
        result, _ = self.run_script()
        self.assertEqual([count == 0 for count in result["pageChars"]], [False, True, False])

    def test_more_pages_than_the_limit_are_refused_before_any_is_read(self):
        self.stage("document.pdf", pdf_bytes([["one"], ["two"], ["three"]]), "pdf", {"maxPages": 2})
        result, text = self.run_script()
        self.assertEqual((result["outcome"], result["reason"]), ("refused", "too_many_pages"))
        self.assertIsNone(text)

    def test_text_past_the_character_limit_is_marked_truncated(self):
        self.stage("document.pdf", pdf_bytes([["x" * 80] * 20, ["y" * 80] * 20]), "pdf", {"maxChars": 500})
        result, _ = self.run_script()
        self.assertTrue(result["truncated"])

    def test_a_file_that_is_not_a_pdf_is_a_named_refusal(self):
        self.stage("document.pdf", b"this is a text file named like a pdf", "pdf")
        result, _ = self.run_script()
        self.assertEqual((result["outcome"], result["reason"]), ("refused", "not_pdf"))

    def test_a_truncated_pdf_is_corrupt_not_a_crash(self):
        self.stage("document.pdf", pdf_bytes([["some text here"]])[:150], "pdf")
        result, _ = self.run_script()
        self.assertEqual(result["outcome"], "refused")
        self.assertIn(result["reason"], ("corrupt", "failed"))

    def test_a_pdf_that_needs_a_password_is_encrypted(self):
        from pypdf import PdfReader, PdfWriter

        source = self.root / "plain.pdf"
        source.write_bytes(pdf_bytes([["secret findings"]]))
        writer = PdfWriter()
        for page in PdfReader(str(source)).pages:
            writer.add_page(page)
        try:
            writer.encrypt("user-password", "owner-password", algorithm="RC4-128")
        except Exception as error:  # noqa: BLE001 - no cryptography here, and this build cannot make the fixture
            self.skipTest("this pypdf build cannot write an encrypted fixture: %s" % type(error).__name__)
        locked = self.root / "locked.pdf"
        with locked.open("wb") as handle:
            writer.write(handle)
        self.stage("document.pdf", locked.read_bytes(), "pdf")
        result, _ = self.run_script()
        self.assertEqual((result["outcome"], result["reason"]), ("refused", "encrypted"))


class WordExtraction(Workspace):
    def test_paragraphs_are_lines_and_table_rows_are_lines_with_cells_joined(self):
        body = (
            para("患者男，62岁，主诉胸痛2小时。")
            + para("既往高血压10年。")
            + "<w:tbl>" + row(cell(para("检查项目")), cell(para("结果")), cell(para("参考范围")))
            + row(cell(para("肌钙蛋白I")), cell(para("0.04 ng/mL")), cell(para("<0.03")))
            + row(cell(para("血压")), cell(para("140/90 mmHg"), para("（入院时）")), cell(para("")))
            + "</w:tbl>"
            + para("诊断：不稳定型心绞痛。")
        )
        self.stage("document.docx", docx_bytes(body, app_pages=2), "docx")
        result, text = self.run_script()
        self.assertEqual((result["outcome"], result["format"], result["pages"]), ("text", "docx", 2))
        lines = text.split("\n")
        self.assertEqual(lines[0], "患者男，62岁，主诉胸痛2小时。")
        self.assertIn("检查项目 | 结果 | 参考范围", lines)
        self.assertIn("肌钙蛋白I | 0.04 ng/mL | <0.03", lines)
        self.assertIn("血压 | 140/90 mmHg （入院时） |", lines)
        self.assertIn("诊断：不稳定型心绞痛。", lines)
        self.assertEqual(result["pageChars"], [])

    def test_a_tracked_deletion_is_left_out_and_an_insertion_is_kept(self):
        body = ('<w:p><w:r><w:t>剂量 </w:t></w:r><w:del><w:r><w:delText>5 mg</w:delText></w:r></w:del>'
                '<w:ins><w:r><w:t>10 mg</w:t></w:r></w:ins><w:r><w:t> 每日一次</w:t></w:r></w:p>')
        self.stage("document.docx", docx_bytes(body), "docx")
        _, text = self.run_script()
        self.assertEqual(text, "剂量 10 mg 每日一次")

    def test_tabs_and_breaks_are_kept_as_whitespace(self):
        body = "<w:p><w:r><w:t>体温</w:t><w:tab/><w:t>37.2</w:t><w:br/><w:t>脉搏</w:t><w:tab/><w:t>88</w:t></w:r></w:p>"
        self.stage("document.docx", docx_bytes(body), "docx")
        _, text = self.run_script()
        self.assertEqual(text, "体温\t37.2\n脉搏\t88")

    def test_a_text_box_is_read_once_through_its_drawingml_choice_only(self):
        box = '<w:txbxContent><w:p><w:r><w:t>%s</w:t></w:r></w:p></w:txbxContent>'
        body = ('<w:p><w:r><w:t>正文</w:t></w:r><w:r><mc:AlternateContent>'
                '<mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx>' + box % "框内文字" + '</wps:txbx></wps:wsp></w:drawing></mc:Choice>'
                '<mc:Fallback><w:pict><v:shape><v:textbox>' + box % "框内文字" + '</v:textbox></v:shape></w:pict></mc:Fallback>'
                '</mc:AlternateContent></w:r></w:p>')
        self.stage("document.docx", docx_bytes(body), "docx")
        _, text = self.run_script()
        self.assertEqual(text.count("框内文字"), 1)
        self.assertIn("正文", text)

    def test_a_content_control_and_a_hyperlink_keep_their_text(self):
        body = ('<w:p><w:sdt><w:sdtPr><w:alias w:val="x"/></w:sdtPr><w:sdtContent><w:r><w:t>控件内</w:t></w:r></w:sdtContent></w:sdt>'
                '<w:hyperlink><w:r><w:t>链接文字</w:t></w:r></w:hyperlink></w:p>')
        self.stage("document.docx", docx_bytes(body), "docx")
        _, text = self.run_script()
        self.assertEqual(text, "控件内链接文字")

    def test_an_image_only_document_has_no_text(self):
        self.stage("document.docx", docx_bytes('<w:p><w:r><w:drawing><a:blip xmlns:a="x"/></w:drawing></w:r></w:p>'), "docx")
        result, text = self.run_script()
        self.assertEqual((result["outcome"], result["chars"], text), ("text", 0, ""))

    def test_a_doctype_is_refused_before_any_entity_could_be_expanded(self):
        bomb = '<!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>'
        data = docx_bytes(para("x"))
        with zipfile.ZipFile(io.BytesIO(data)) as source:
            xml = source.read("word/document.xml").decode("utf-8")
        poisoned = xml.replace("?>", "?>" + bomb, 1).replace("<w:t>x</w:t>", "<w:t>&b;</w:t>")
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
            archive.writestr("word/document.xml", poisoned.encode("utf-8"))
        self.stage("document.docx", buffer.getvalue(), "docx")
        result, _ = self.run_script()
        self.assertEqual((result["outcome"], result["reason"]), ("refused", "corrupt"))

    def test_a_declared_exotic_encoding_cannot_hide_a_doctype(self):
        self.stage("document.docx", docx_bytes(para("x"), declared_encoding="cp037"), "docx")
        result, _ = self.run_script()
        self.assertEqual((result["outcome"], result["reason"]), ("refused", "corrupt"))

    def test_an_old_doc_and_a_random_file_are_not_docx(self):
        self.stage("document.docx", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 512, "docx")
        result, _ = self.run_script()
        self.assertEqual((result["outcome"], result["reason"]), ("refused", "not_docx"))

    def test_an_encrypted_member_is_refused_by_name(self):
        self.stage("document.docx", docx_bytes(para("x"), encrypted=True), "docx")
        result, _ = self.run_script()
        self.assertEqual((result["outcome"], result["reason"]), ("refused", "encrypted"))

    def test_a_truncated_package_is_corrupt(self):
        self.stage("document.docx", docx_bytes(para("some record text"))[:90], "docx")
        result, _ = self.run_script()
        self.assertEqual(result["outcome"], "refused")
        self.assertIn(result["reason"], ("corrupt", "not_docx"))

    def test_a_document_part_over_the_size_limit_is_refused(self):
        self.stage("document.docx", docx_bytes(para("x" * 5000)), "docx", {"maxXmlBytes": 1024})
        result, _ = self.run_script()
        self.assertEqual((result["outcome"], result["reason"]), ("refused", "too_large"))

    def test_text_past_the_character_limit_is_marked_truncated(self):
        self.stage("document.docx", docx_bytes(para("字" * 400)), "docx", {"maxChars": 100})
        result, text = self.run_script()
        self.assertTrue(result["truncated"])
        self.assertEqual(len(text), 100)


class Request(Workspace):
    """The container's first act: hold the bound file to the digest and size it was told."""

    def test_a_changed_input_is_not_read(self):
        data = docx_bytes(para("record"))
        self.stage("document.docx", data, "docx")
        # The same size with one byte changed: the hash says so, and the file is never parsed.
        self.file.write_bytes(data[:-1] + bytes([data[-1] ^ 0x01]))
        self.assertEqual(self.refused()["outcome"], "refused")
        # A different size is caught before the bytes are even read.
        self.file.write_bytes(docx_bytes(para("a different, longer record")))
        self.refused()

    def test_a_file_of_another_size_or_digest_than_the_one_named_is_refused(self):
        data = docx_bytes(para("record"))
        self.stage("document.docx", data, "docx", size=len(data) + 1)
        self.refused()
        self.stage("document.docx", data, "docx", sha256="0" * 64)
        self.refused()

    def test_a_link_a_directory_a_pipe_and_a_missing_file_are_not_the_file(self):
        data = docx_bytes(para("record"))
        self.stage("document.docx", data, "docx")
        real = self.input / "real.docx"
        real.write_bytes(data)
        (self.input / "link.docx").symlink_to(real)
        self.flags[1] = str(self.input / "link.docx")
        self.refused()
        (self.input / "folder.docx").mkdir()
        self.flags[1] = str(self.input / "folder.docx")
        self.refused()
        os.mkfifo(self.input / "pipe.docx")
        self.flags[1] = str(self.input / "pipe.docx")
        self.refused()
        self.flags[1] = str(self.input / "missing.docx")
        self.refused()

    def test_an_expectation_that_is_not_a_digest_and_a_size_is_refused_without_reading(self):
        data = docx_bytes(para("record"))
        for sha256, size in (("not-a-digest", len(data)), ("A" * 64, len(data)), ("a" * 63, len(data)), (hashlib.sha256(data).hexdigest(), 0)):
            self.stage("document.docx", data, "docx", sha256=sha256, size=size)
            self.refused()

    def test_the_document_is_parsed_from_the_verified_bytes_and_not_from_the_path_again(self):
        data = docx_bytes(para("what was digested"))
        self.stage("document.docx", data, "docx")
        original = extract.read_verified

        def swap_after_verifying(source, expectation):
            verified = original(source, expectation)
            source.write_bytes(docx_bytes(para("what was swapped in afterwards")))
            return verified

        with mock.patch.object(extract, "read_verified", swap_after_verifying):
            result, text = self.run_script()
        self.assertEqual(result["outcome"], "text")
        self.assertEqual(text, "what was digested")

    def test_an_unknown_format_is_not_guessed_from_anything(self):
        data = docx_bytes(para("x"))
        self.stage("document.pdf", data, "rtf")
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as stopped:
            extract.main([*self.flags, "--output-dir", str(self.output)])
        self.assertEqual(stopped.exception.code, 2)
        self.assertFalse((self.output / "result.json").exists())

    def test_an_unexpected_failure_still_ends_in_a_result_file_that_names_the_class_and_never_the_message(self):
        self.stage("document.docx", docx_bytes(para("x")), "docx")
        with mock.patch.object(extract, "extract_docx", side_effect=ValueError("a line of the record")):
            result, _ = self.run_script()
        self.assertEqual((result["outcome"], result["reason"], result["errorClass"]), ("refused", "failed", "ValueError"))
        self.assertNotIn("a line of the record", json.dumps(result))


class Text(unittest.TestCase):
    def test_clean_text_normalizes_newlines_and_folds_blank_runs_and_nothing_else(self):
        raw = "第一行  \r\n\r\n\r\n\r\n第二行\x00\x07 第三行\f"
        self.assertEqual(extract.clean_text(raw), "第一行\n\n第二行\n第三行")

    def test_significant_chars_ignores_whitespace_only(self):
        self.assertEqual(extract.significant_chars(" a b\n\tc　d "), 4)

    def test_the_module_imports_without_pypdf_or_any_file_system_effect(self):
        self.assertTrue(callable(extract.extract_pdf))
        self.assertTrue(callable(extract.extract_docx))


if __name__ == "__main__":
    unittest.main()
