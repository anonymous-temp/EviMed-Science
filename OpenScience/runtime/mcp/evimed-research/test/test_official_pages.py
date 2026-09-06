import importlib.util
import hashlib
import os
import pathlib
import sys
import tempfile
import unittest
from datetime import datetime, timezone
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
        self.assertEqual(
            result["data"]["artifactSha256s"][result["data"]["markdownPath"]],
            hashlib.sha256(artifact.read_bytes()).hexdigest(),
        )
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

    def test_fetch_accepts_the_fixed_nhs_chest_pain_route(self):
        html = b"""<!doctype html><html><head><title>Chest pain</title></head><body><main>
        <h1>Chest pain</h1><p>Call emergency services for sudden pressure-like chest discomfort.</p>
        <p>This official page explains urgent symptoms, emergency assessment, transport, and the limits
        of symptom-based self-diagnosis when chest discomfort could represent a heart attack.</p>
        </main></body></html>"""
        url = "https://www.nhs.uk/symptoms/chest-pain/"
        with mock.patch.object(
            self.module.public_sources,
            "_open_remote",
            return_value=self.response(html),
        ) as opened:
            result = self.module.fetch({"url": url})

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["sources"][0]["url"], url)
        opened.assert_called_once_with(url, ("text/html",), timeout_seconds=60)

    def test_repeated_official_capture_preserves_content_hash_and_mtime(self):
        body = b"<html><title>Official guidance</title><main><p>" + b"Verified official content. " * 20 + b"</p></main></html>"
        url = "https://www.nhs.uk/symptoms/chest-pain/"
        with mock.patch.object(self.module.public_sources, "_open_remote", side_effect=lambda *_args, **_kwargs: self.response(body)), \
                mock.patch.object(self.module, "datetime") as clock:
            clock.now.return_value = datetime(2026, 1, 1, tzinfo=timezone.utc)
            first = self.module.fetch({"url": url})
            artifact = self.workspace / first["data"]["markdownPath"]
            original, mtime = artifact.read_bytes(), artifact.stat().st_mtime_ns
            clock.now.return_value = datetime(2026, 1, 2, tzinfo=timezone.utc)
            repeated = self.module.fetch({"url": url})
        self.assertEqual(first["artifacts"], repeated["artifacts"])
        self.assertEqual(first["data"]["artifactSha256s"], repeated["data"]["artifactSha256s"])
        self.assertEqual(artifact.read_bytes(), original)
        self.assertEqual(artifact.stat().st_mtime_ns, mtime)
        self.assertNotEqual(first["sources"][0]["retrievedAt"], repeated["sources"][0]["retrievedAt"])
        self.assertNotIn(b"- Retrieved:", original)

    def test_changed_official_content_keeps_the_previously_bound_artifact(self):
        first_body = b"<html><title>Official guidance</title><main><p>" + b"First verified content. " * 20 + b"</p></main></html>"
        second_body = first_body.replace(b"First", b"Revised")
        url = "https://www.nhs.uk/symptoms/chest-pain/"
        with mock.patch.object(self.module.public_sources, "_open_remote", side_effect=[self.response(first_body), self.response(second_body)]):
            first = self.module.fetch({"url": url})
            original = (self.workspace / first["artifacts"][0]).read_bytes()
            second = self.module.fetch({"url": url})
        self.assertNotEqual(first["artifacts"], second["artifacts"])
        self.assertEqual((self.workspace / first["artifacts"][0]).read_bytes(), original)
        self.assertEqual(first["data"]["artifactSha256s"][first["artifacts"][0]], hashlib.sha256(original).hexdigest())

    def test_identical_html_at_distinct_official_urls_cannot_overwrite_source_identity(self):
        body = b"<html><title>Official guidance</title><main><p>" + b"Verified official content. " * 20 + b"</p></main></html>"
        first_url = "https://www.nhs.uk/symptoms/chest-pain/"
        second_url = first_url + "?view=print"
        with mock.patch.object(self.module.public_sources, "_open_remote", side_effect=lambda *_args, **_kwargs: self.response(body)):
            first = self.module.fetch({"url": first_url})
            original = (self.workspace / first["artifacts"][0]).read_bytes()
            second = self.module.fetch({"url": second_url})
        self.assertNotEqual(first["artifacts"], second["artifacts"])
        self.assertEqual((self.workspace / first["artifacts"][0]).read_bytes(), original)
        self.assertIn(second_url, (self.workspace / second["artifacts"][0]).read_text())

    def test_source_directory_symlinks_are_refused_before_preserving_content(self):
        outside = pathlib.Path(self.temp.name) / "outside"
        outside.mkdir()
        (self.workspace / ".evimed-sources").symlink_to(outside, target_is_directory=True)
        body = b"<main><p>" + b"Verified official content. " * 20 + b"</p></main>"
        with mock.patch.object(self.module.public_sources, "_open_remote", return_value=self.response(body)):
            result = self.module.fetch({"url": "https://www.nhs.uk/symptoms/chest-pain/"})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "official_page_output_invalid")
        self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
