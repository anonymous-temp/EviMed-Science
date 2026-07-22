import importlib.util
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_FILE = ROOT / "official_pages.py"


def load_module():
    sys.path.insert(0, str(ROOT))
    spec = importlib.util.spec_from_file_location("evimed_official_pages_test", MODULE_FILE)
    try:
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.pop(0)


class OfficialPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.workspace = pathlib.Path(self.temp.name) / "workspace"
        self.workspace.mkdir()
        self.previous = os.environ.get("OPEN_SCIENCE_WORKSPACE_DIR")
        os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = str(self.workspace)

    def tearDown(self):
        if self.previous is None:
            os.environ.pop("OPEN_SCIENCE_WORKSPACE_DIR", None)
        else:
            os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = self.previous
        self.temp.cleanup()

    def response(self, body):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        response.headers.get_content_type.return_value = "text/html"
        response.headers.get.return_value = str(len(body))
        response.read.return_value = body
        return response

    def test_fetch_extracts_visible_official_content_and_writes_a_hashed_receipt(self):
        html = b"""<!doctype html><html><head><title>First Aid Guideline</title>
        <style>.hidden{}</style></head><body><nav>Navigation noise</nav><main>
        <h1>First Aid Guideline</h1><p>Call emergency medical services for acute chest pressure.</p>
        <h2>Evidence</h2><p>Aspirin decisions require an allergy and bleeding check. The guidance describes recognition, emergency activation, immediate precautions, and the limits of first-aid treatment. It distinguishes time-critical chest symptoms from conditions that can be assessed only after urgent causes have been excluded.</p>
        </main><script>doNotInclude()</script></body></html>"""
        url = "https://professional.heart.org/en/science-news/2024-aha-and-american-red-cross-guidelines-for-first-aid"
        with mock.patch.object(
            self.module.public_sources,
            "_open_remote",
            return_value=self.response(html),
        ) as opened:
            result = self.module.fetch({"url": url})

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["sources"][0]["url"], url)
        self.assertRegex(result["data"]["sha256"], r"^[0-9a-f]{64}$")
        artifact = self.workspace / result["data"]["markdownPath"]
        self.assertTrue(artifact.is_file())
        content = artifact.read_text(encoding="utf-8")
        self.assertIn("Call emergency medical services", content)
        self.assertNotIn("doNotInclude", content)
        self.assertNotIn("Navigation noise", content)
        opened.assert_called_once_with(url, ("text/html",), timeout_seconds=60)

    def test_fetch_rejects_unapproved_hosts_before_network(self):
        with mock.patch.object(self.module.public_sources, "_open_remote") as opened:
            result = self.module.fetch({"url": "https://example.org/unreviewed"})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "official_page_url_forbidden")
        opened.assert_not_called()


if __name__ == "__main__":
    unittest.main()
