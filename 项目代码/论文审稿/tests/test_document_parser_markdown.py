import tempfile
import unittest
from pathlib import Path

from src.services.document_parser import DocumentParser


class MarkdownDocumentParserTests(unittest.TestCase):
    def test_markdown_manuscript_is_parsed_as_structured_text(self):
        with tempfile.TemporaryDirectory() as directory:
            manuscript = Path(directory) / "manuscript.md"
            manuscript.write_text(
                "# Study title\n\n## Methods\n\n" + "Participants and outcomes were assessed. " * 8,
                encoding="utf-8",
            )
            text, metadata = DocumentParser(use_marker=False).parse(str(manuscript))
        self.assertIn("Study title", text)
        self.assertEqual(metadata["format"], ".md")
        self.assertEqual(metadata["parse_method"], "markdown")


if __name__ == "__main__":
    unittest.main()
