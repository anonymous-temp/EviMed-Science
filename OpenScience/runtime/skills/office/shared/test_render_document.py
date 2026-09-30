"""Real Unicode conversion and hostile-resource tests for the office renderer."""
import hashlib
import io
import json
import unicodedata
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile

import render_document as renderer


class DocumentRendererTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.document = {"version": 1, "rendererVersion": renderer.VERSION, "sourceDigest": "test-snapshot", "title": "循证研究",
                         "canonicalMarkdown": "# 中文研究\n\nLatin 95% CI 12.5; 缺失值：未计算。\n\n| 指标 | 数值 |\n|---|---|\n" + "\n".join(f"|样本 {i}|{i}.25|" for i in range(120)),
                         "assets": [], "formats": ["docx", "html", "pdf"]}

    def tearDown(self):
        self.temporary.cleanup()

    def test_real_unicode_table_formats(self):
        from pypdf import PdfReader
        from PIL import Image
        figure = io.BytesIO()
        Image.new("RGB", (160, 80), (30, 90, 200)).save(figure, format="PNG")
        (self.root / "figure.png").write_bytes(figure.getvalue())
        self.document["assets"] = [{"path": "figure.png", "mime": "image/png", "sha256": hashlib.sha256(figure.getvalue()).hexdigest()}]
        self.document["canonicalMarkdown"] += "\n\n::: {.pagebreak}\n## Appendix\n\n页后文本。\n:::\n"
        self.document["canonicalMarkdown"] = "![研究图](figure.png)\n\n数学 $x=\\beta+0.5$。\n\n" + self.document["canonicalMarkdown"]
        result = renderer.render(self.document, self.root, self.root / "out")
        self.assertTrue(all(value["state"] == "ready" for value in result["formats"].values()), result)
        with ZipFile(self.root / "out/document.docx") as archive:
            document = archive.read("word/document.xml").decode()
            self.assertIn("中文研究", document)
            self.assertIn("<w:tbl>", document)
            self.assertIn("<w:pageBreakBefore/>", document)
            self.assertIn("119.25", document)
            self.assertTrue(any(name.startswith("word/media/") for name in archive.namelist()))
        pdf = PdfReader(self.root / "out/document.pdf")
        text = unicodedata.normalize("NFKC", "".join(page.extract_text() for page in pdf.pages))
        self.assertGreater(len(pdf.pages), 2)
        self.assertGreater(len(pdf.pages[0].images), 0)
        for value in ("中文研究", "95%", "12.5", "119.25", "未计算"):
            self.assertIn(value, text)

    def test_pdf_failure_keeps_docx_and_html(self):
        with patch.object(renderer, "pdf", side_effect=RuntimeError("unavailable")):
            result = renderer.render(self.document, self.root, self.root / "out")
        self.assertEqual(result["formats"]["pdf"]["state"], "failed")
        self.assertEqual(result["formats"]["docx"]["state"], "ready")
        self.assertEqual(result["formats"]["html"]["state"], "ready")
        self.assertFalse((self.root / "out/document.pdf").exists())

    def test_scripts_and_remote_images_do_not_reach_html(self):
        self.document["canonicalMarkdown"] = '# Safe\n```{=html}\n<img src="file:///etc/passwd">\n```\n\n<script>alert(1)</script>\n\n![remote](https://example.com/track.png)\n\n[bad](javascript:alert%281%29)\n\n![file](file:///etc/passwd)'
        self.document["formats"] = ["html"]
        result = renderer.render(self.document, self.root, self.root / "out")
        output = (self.root / "out/document.html").read_text()
        self.assertNotIn("<script>", output)
        self.assertNotIn('src="https://', output)
        self.assertNotIn('href="javascript:', output)
        self.assertNotIn('file:///etc', output)
        self.assertIn("document_image_unavailable", result["findings"])

    def test_process_interruption_keeps_a_receipt_for_completed_formats(self):
        with patch.object(renderer, "pdf", side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                renderer.render(self.document, self.root, self.root / "out")
        manifest = json.loads((self.root / "out/manifest.json").read_text())
        self.assertEqual(manifest["formats"]["docx"]["state"], "ready")
        self.assertEqual(manifest["formats"]["html"]["state"], "ready")
        self.assertNotIn("pdf", manifest["formats"])

    def test_html_failure_does_not_suppress_docx(self):
        original = renderer.pandoc
        def convert(args, data):
            if "--to=html5" in args:
                raise RuntimeError("html unavailable")
            return original(args, data)
        with patch.object(renderer, "pandoc", side_effect=convert):
            result = renderer.render(self.document, self.root, self.root / "out")
        self.assertEqual(result["formats"]["docx"]["state"], "ready")
        self.assertEqual(result["formats"]["pdf"]["code"], "document_html_render_failed")
        self.assertEqual(result["formats"]["html"]["state"], "failed")
        self.assertTrue((self.root / "out/manifest.json").exists())

    def test_raw_scientific_text_and_heading_links_are_preserved(self):
        self.document["canonicalMarkdown"] = "[Methods](#methods)\n\n# Methods\n\n```{=html}\n<p>样本 42.5</p><script>unsafe()</script>\n```"
        self.document["formats"] = ["html"]
        result = renderer.render(self.document, self.root, self.root / "out")
        output = (self.root / "out/document.html").read_text()
        self.assertIn('id="methods"', output)
        self.assertIn('href="#methods"', output)
        self.assertIn("样本 42.5", output)
        self.assertNotIn("unsafe()", output)
        self.assertIn("document_raw_markup_removed", result["findings"])

    def test_raw_table_cells_and_void_elements_do_not_change_numbers(self):
        source = "<table><tr><th>Effect</th><th>CI</th></tr><tr><td>12.5</td><td>95</td></tr><tr><td>Missing</td><td>—</td></tr></table><embed><p>42.5</p>"
        text = renderer.raw_text("html", source)
        self.assertRegex(text, r"12\.5\s+95")
        self.assertNotIn("12.595", text)
        self.assertRegex(text, r"Missing\s+—")
        self.assertIn("42.5", text)

    def test_assets_reject_symlinks_hash_mismatch_and_svg(self):
        asset = self.root / "figure.png"
        asset.write_bytes(b"\x89PNG\r\n\x1a\nfixture")
        self.document["assets"] = [{"path": asset.name, "sha256": hashlib.sha256(asset.read_bytes()).hexdigest(), "mime": "image/png"}]
        renderer.verified_assets(self.document, self.root)
        self.document["assets"][0]["sha256"] = "changed"
        with self.assertRaisesRegex(ValueError, "hash_mismatch"):
            renderer.verified_assets(self.document, self.root)
        asset.unlink()
        asset.symlink_to("/etc/passwd")
        with self.assertRaisesRegex(ValueError, "symlink"):
            renderer.verified_assets(self.document, self.root)


if __name__ == "__main__":
    unittest.main()
