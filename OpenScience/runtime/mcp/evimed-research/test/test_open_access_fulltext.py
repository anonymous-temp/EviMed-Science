import importlib.util
import hashlib
import json
import os
import pathlib
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_FILE = ROOT / "open_access_fulltext.py"


def load_module():
    sys.path.insert(0, str(ROOT))
    spec = importlib.util.spec_from_file_location("evimed_open_access_fulltext_test", MODULE_FILE)
    try:
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.pop(0)


XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<article><front><article-meta><article-id pub-id-type="doi">10.1/test</article-id>
<title-group><article-title>Verified trial</article-title></title-group>
<abstract><p>Abstract evidence.</p></abstract></article-meta></front>
<body><sec><title>Methods</title><p>We enrolled 100 participants.</p></sec>
<sec><title>Results</title><p>The primary result was 42%.</p>
<table-wrap><label>Table 1</label><caption><p>Observed outcomes</p></caption><table><tr><td>42</td></tr></table></table-wrap>
</sec></body><back><ref-list><ref>Reference one.</ref></ref-list></back></article>"""


class OpenAccessFullTextTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.workspace = pathlib.Path(self.temp.name) / "workspace"
        self.workspace.mkdir()
        self.old_workspace = os.environ.get("OPEN_SCIENCE_WORKSPACE_DIR")
        os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = str(self.workspace)

    def tearDown(self):
        if self.old_workspace is None:
            os.environ.pop("OPEN_SCIENCE_WORKSPACE_DIR", None)
        else:
            os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = self.old_workspace
        self.temp.cleanup()

    def test_fetch_writes_complete_workspace_artifacts(self):
        with mock.patch.object(
            self.module,
            "_resolve",
            return_value={"pmcid": "PMC123456", "doi": "10.1/test", "title": "Verified trial"},
        ), mock.patch.object(self.module, "_request_bytes", return_value=XML):
            result = self.module.fetch({"identifier": "10.1/test"})
        self.assertEqual(result["status"], "success")
        markdown = self.workspace / result["data"]["markdownPath"]
        xml = self.workspace / result["data"]["xmlPath"]
        self.assertTrue(markdown.is_file())
        self.assertTrue(xml.is_file())
        self.assertEqual(
            result["data"]["artifactSha256s"][result["data"]["markdownPath"]],
            hashlib.sha256(markdown.read_bytes()).hexdigest(),
        )
        self.assertEqual(
            result["data"]["artifactSha256s"][result["data"]["xmlPath"]],
            hashlib.sha256(xml.read_bytes()).hexdigest(),
        )
        text = markdown.read_text(encoding="utf-8")
        self.assertIn("## Methods", text)
        self.assertIn("100 participants", text)
        self.assertIn("42%", text)
        self.assertIn("Table 1", text)

    def test_resolve_accepts_the_prefixed_pubmed_identifier_used_by_search_results(self):
        with mock.patch.object(
            self.module,
            "_request_json",
            return_value={"resultList": {"result": [{"pmcid": "PMC123456", "title": "Observed"}]}},
        ) as request:
            result = self.module._resolve(" PMID:30221597 ")

        self.assertEqual(result["pmcid"], "PMC123456")
        query = self.module.urllib.parse.parse_qs(
            self.module.urllib.parse.urlparse(request.call_args.args[0]).query
        )["query"]
        self.assertEqual(query, ["EXT_ID:30221597"])

    def test_missing_full_text_fails_without_artifacts(self):
        error = self.module.FullTextError("full_text_not_available", "No full text")
        with mock.patch.object(self.module, "_resolve", side_effect=error):
            result = self.module.fetch({"identifier": "10.1/missing"})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "full_text_not_available")
        self.assertFalse((self.workspace / ".evimed-sources").exists())

    def test_request_uses_the_managed_public_source_gateway_transport(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        response.headers.get.return_value = "12"
        response.headers.get_content_type.return_value = "application/xml"
        response.read.return_value = b"<article/>"
        with mock.patch.object(self.module.public_sources, "_open_remote", return_value=response) as opened:
            payload = self.module._request_bytes(
                "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1/fullTextXML",
                "application/xml",
            )
        self.assertEqual(payload, b"<article/>")
        opened.assert_called_once_with(
            "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1/fullTextXML",
            ("application/xml",),
            timeout_seconds=60,
        )

    def test_workspace_symlink_is_rejected(self):
        target = pathlib.Path(self.temp.name) / "target"
        target.mkdir()
        linked = pathlib.Path(self.temp.name) / "linked"
        linked.symlink_to(target, target_is_directory=True)
        os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = str(linked)
        with self.assertRaisesRegex(self.module.FullTextError, "workspace"):
            self.module._workspace()

    def test_identical_xml_is_immutable_while_retrieval_provenance_advances(self):
        with mock.patch.object(self.module, "_resolve", return_value={"pmcid": "PMC123456"}), \
                mock.patch.object(self.module, "_request_bytes", return_value=XML), \
                mock.patch.object(self.module, "datetime") as clock:
            clock.now.return_value = datetime(2026, 1, 1, tzinfo=timezone.utc)
            first = self.module.fetch({"identifier": "PMC123456"})
            original = {name: (self.workspace / name).read_bytes() for name in first["artifacts"]}
            mtimes = {name: (self.workspace / name).stat().st_mtime_ns for name in first["artifacts"]}
            clock.now.return_value = datetime(2026, 1, 2, tzinfo=timezone.utc)
            second = self.module.fetch({"identifier": "PMC123456"})
        self.assertEqual(first["artifacts"], second["artifacts"])
        self.assertEqual(first["data"]["artifactSha256s"], second["data"]["artifactSha256s"])
        self.assertNotEqual(first["sources"][0]["retrievedAt"], second["sources"][0]["retrievedAt"])
        for name, payload in original.items():
            self.assertEqual((self.workspace / name).read_bytes(), payload)
            self.assertEqual((self.workspace / name).stat().st_mtime_ns, mtimes[name])
        self.assertNotIn("- Retrieved:", (self.workspace / first["data"]["markdownPath"]).read_text())

    def test_changed_xml_has_a_new_version_and_preserves_both_prior_artifacts(self):
        changed = XML.replace(b"100 participants", b"120 participants")
        legacy = self.workspace / ".evimed-sources" / "PMC123456" / "fulltext.md"
        legacy.parent.mkdir(parents=True)
        legacy.write_text("Already-bound legacy article.\n")
        with mock.patch.object(self.module, "_resolve", return_value={"pmcid": "PMC123456"}), \
                mock.patch.object(self.module, "_request_bytes", side_effect=[XML, changed, XML]):
            first = self.module.fetch({"identifier": "PMC123456"})
            original = {name: (self.workspace / name).read_bytes() for name in first["artifacts"]}
            second = self.module.fetch({"identifier": "PMC123456"})
            restored = self.module.fetch({"identifier": "PMC123456"})
        self.assertTrue(set(first["artifacts"]).isdisjoint(second["artifacts"]))
        self.assertEqual(restored["artifacts"], first["artifacts"])
        for name, payload in original.items():
            self.assertEqual((self.workspace / name).read_bytes(), payload)
        self.assertEqual(legacy.read_text(), "Already-bound legacy article.\n")
        self.assertIn("120 participants", (self.workspace / second["data"]["markdownPath"]).read_text())

    def test_pdf_captures_reuse_identical_bytes_and_version_changed_bytes(self):
        first_pdf, second_pdf = b"%PDF synthetic first", b"%PDF synthetic second"

        def reader(stream):
            text = ("First PDF evidence. " if stream.getvalue() == first_pdf else "Second PDF evidence. ") * 200
            return SimpleNamespace(is_encrypted=False, pages=[SimpleNamespace(extract_text=lambda: text)], metadata=SimpleNamespace(title="Stable PDF title"))

        records = [
            (first_pdf, {"origin": "publisher", "version": "publishedVersion", "license": "cc-by"}),
            (first_pdf, {"origin": "repository", "version": "acceptedVersion", "license": "unspecified"}),
            (second_pdf, {"origin": "publisher", "version": "publishedVersion", "license": "cc-by"}),
        ]
        with mock.patch.dict(sys.modules, {"pypdf": SimpleNamespace(PdfReader=reader)}), \
                mock.patch.object(self.module, "_resolve", return_value={"doi": "10.1/test", "title": "Lookup title"}), \
                mock.patch.object(self.module.public_sources, "open_access_pdf_bytes", side_effect=records):
            first = self.module.fetch({"identifier": "10.1/test"})
            original = {name: (self.workspace / name).read_bytes() for name in first["artifacts"]}
            repeated = self.module.fetch({"identifier": "10.1/test"})
            changed = self.module.fetch({"identifier": "10.1/test"})
        self.assertEqual(first["status"], "success")
        self.assertEqual(first["artifacts"], repeated["artifacts"])
        self.assertEqual(first["data"]["artifactSha256s"], repeated["data"]["artifactSha256s"])
        self.assertEqual(repeated["data"]["openAccessOrigin"], "repository")
        self.assertTrue(set(first["artifacts"]).isdisjoint(changed["artifacts"]))
        for name, payload in original.items():
            self.assertEqual((self.workspace / name).read_bytes(), payload)

    def test_parallel_identical_fetches_publish_one_complete_capture(self):
        with mock.patch.object(self.module, "_resolve", return_value={"pmcid": "PMC123456"}), \
                mock.patch.object(self.module, "_request_bytes", return_value=XML), \
                ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _index: self.module.fetch({"identifier": "PMC123456"}), range(8)))
        self.assertTrue(all(result["status"] == "success" for result in results))
        self.assertTrue(all(result["artifacts"] == results[0]["artifacts"] for result in results))
        for name, digest in results[0]["data"]["artifactSha256s"].items():
            self.assertEqual(hashlib.sha256((self.workspace / name).read_bytes()).hexdigest(), digest)
        self.assertFalse(list(self.workspace.rglob("*.tmp")))

    def test_an_existing_capture_symlink_is_refused_without_touching_its_target(self):
        outside = pathlib.Path(self.temp.name) / "outside.txt"
        outside.write_text("Do not change this target.")
        with mock.patch.object(self.module, "_resolve", return_value={"pmcid": "PMC123456"}), \
                mock.patch.object(self.module, "_request_bytes", return_value=XML):
            first = self.module.fetch({"identifier": "PMC123456"})
            target = self.workspace / first["data"]["markdownPath"]
            target.unlink()
            target.symlink_to(outside)
            refused = self.module.fetch({"identifier": "PMC123456"})
        self.assertEqual(refused["status"], "error")
        self.assertEqual(refused["error"]["code"], "full_text_output_invalid")
        self.assertEqual(outside.read_text(), "Do not change this target.")

    def test_lookup_metadata_does_not_change_canonical_xml_content(self):
        with mock.patch.object(self.module, "_resolve", side_effect=[
            {"pmcid": "PMC123456", "doi": "10.1/lookup-first", "title": "First lookup"},
            {"pmcid": "PMC123456", "doi": "10.1/lookup-second", "title": "Updated lookup"},
        ]), mock.patch.object(self.module, "_request_bytes", return_value=XML):
            first = self.module.fetch({"identifier": "PMC123456"})
            repeated = self.module.fetch({"identifier": "PMC123456"})
        self.assertEqual(first["artifacts"], repeated["artifacts"])
        self.assertEqual(first["data"]["artifactSha256s"], repeated["data"]["artifactSha256s"])


if __name__ == "__main__":
    unittest.main()
