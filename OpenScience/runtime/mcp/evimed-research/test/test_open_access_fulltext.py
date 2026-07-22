import importlib.util
import hashlib
import json
import os
import pathlib
import sys
import tempfile
import unittest
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


if __name__ == "__main__":
    unittest.main()
