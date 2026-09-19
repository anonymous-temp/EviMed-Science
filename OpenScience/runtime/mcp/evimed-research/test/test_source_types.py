"""Evidence source types: one table, two readers, the same answers (C8)."""

import importlib.util
import json
import os
import pathlib
import re
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
OPENSCIENCE = ROOT.parents[2]
CASES = OPENSCIENCE / "packages" / "domain" / "test" / "fixtures" / "source-type-cases.json"
sys.path.insert(0, str(ROOT))

import immutable_capture  # noqa: E402
import web_read  # noqa: E402
import public_sources  # noqa: E402
import source_types  # noqa: E402


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_source_types", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SharedTableTests(unittest.TestCase):
    def test_every_shared_case_gets_the_domain_answer(self):
        cases = json.loads(CASES.read_text(encoding="utf-8"))["cases"]
        self.assertGreaterEqual(len(cases), 25)
        for case in cases:
            with self.subTest(note=case["note"]):
                self.assertEqual(source_types.source_type_of(case["record"]), case["expected"])

    def test_the_table_read_is_the_domain_file(self):
        self.assertEqual(
            pathlib.Path(source_types.table()["origin"]).resolve(),
            (OPENSCIENCE / "packages" / "domain" / "src" / "source-types.json").resolve(),
        )

    def test_the_image_path_is_where_both_runtime_builds_copy_the_domain(self):
        # The runtime image has no repository layout; the domain package is
        # copied under the socket bundle. If a Dockerfile moves it, this path
        # must move with it, or every source leaves the runtime untyped.
        destination = str(source_types.IMAGE_TABLE).removesuffix("/src/source-types.json")
        for name in ("Dockerfile", "Dockerfile.delta"):
            text = (OPENSCIENCE / "deploy" / "runtime-dsh" / name).read_text(encoding="utf-8")
            with self.subTest(dockerfile=name):
                self.assertRegex(text, r"(?m)^COPY packages/domain %s$" % re.escape(destination))

    def test_a_missing_table_leaves_the_type_unset_rather_than_guessing(self):
        with mock.patch.object(source_types, "table", return_value=None):
            self.assertIsNone(source_types.source_type_of({"tool": "guideline_search"}))
            self.assertIsNone(source_types.sidecar({"tool": "guideline_search"}))
            self.assertFalse(source_types.is_source_type("guideline"))

    def test_an_override_names_another_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            copy = pathlib.Path(temporary) / "source-types.json"
            copy.write_text(json.dumps({"types": ["guideline", "other"], "tools": {"x_tool": "guideline"}}), encoding="utf-8")
            source_types.table.cache_clear()
            try:
                with mock.patch.dict(os.environ, {source_types.TABLE_ENV: str(copy)}):
                    self.assertEqual(source_types.source_type_of({"tool": "x_tool"}), "guideline")
                    self.assertEqual(source_types.source_type_of({"tool": "guideline_search"}), "other")
            finally:
                source_types.table.cache_clear()

    def test_the_sidecar_is_deterministic(self):
        record = {"id": "PMID:1", "title": "T", "url": "https://pubmed.ncbi.nlm.nih.gov/1/", "publicationTypes": ["Randomized Controlled Trial"]}
        name, first = source_types.sidecar(record)
        _name, second = source_types.sidecar(dict(record))
        self.assertEqual(name, "source.json")
        self.assertEqual(first, second)
        self.assertEqual(json.loads(first)["sourceType"], "rct")


class StampingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def test_every_source_and_its_item_leave_with_a_type(self):
        body = {
            "summary": "Retrieved 2 records.",
            "data": {"items": [
                {"id": "PMID:1", "title": "a", "publicationTypes": ["Meta-Analysis", "Review"]},
                {"id": "PMID:2", "title": "b", "publicationTypes": ["Journal Article"]},
            ]},
            "sources": [
                {"id": "PMID:1", "source": "pubmed", "retrievedAt": "2026-09-18T00:00:00Z", "url": "https://pubmed.ncbi.nlm.nih.gov/1/"},
                {"id": "PMID:2", "source": "pubmed", "retrievedAt": "2026-09-18T00:00:00Z", "url": "https://pubmed.ncbi.nlm.nih.gov/2/"},
            ],
        }
        with mock.patch.object(self.server.public_sources, "call", return_value=body):
            result = self.server.call_tool("literature_search", {"query": "aspirin"})
        self.assertEqual([source["sourceType"] for source in result["sources"]], ["meta-analysis", "other"])
        self.assertEqual([item["sourceType"] for item in result["data"]["items"]], ["meta-analysis", "other"])

    def test_the_tool_decides_when_the_record_cannot(self):
        body = {
            "summary": "Retrieved 1 guideline.",
            "data": {"items": [{"id": "G1", "title": "g"}]},
            "sources": [{"id": "G1", "source": "somewhere", "retrievedAt": "2026-09-18T00:00:00Z"}],
        }
        with mock.patch.object(self.server.public_sources, "call", return_value=body):
            result = self.server.call_tool("guideline_search", {"query": "hypertension"})
        self.assertEqual(result["sources"][0]["sourceType"], "guideline")

    def test_an_adapter_type_is_kept_when_valid_and_replaced_when_not(self):
        body = {
            "summary": "Two labels.",
            "data": {"items": [{"id": "L1"}, {"id": "L2"}]},
            "sources": [
                {"id": "L1", "source": "x", "retrievedAt": "2026-09-18T00:00:00Z", "sourceType": "regulatory"},
                {"id": "L2", "source": "x", "retrievedAt": "2026-09-18T00:00:00Z", "sourceType": "brochure"},
            ],
        }
        with mock.patch.object(self.server.public_sources, "call", return_value=body):
            result = self.server.call_tool("drug_label_search", {"drug": "aspirin"})
        self.assertEqual([source["sourceType"] for source in result["sources"]], ["regulatory", "label"])

    def test_health_names_the_table_it_stamps_from(self):
        result = self.server.call_tool("health", {})
        self.assertTrue(result["data"]["sourceTypes"]["table"].endswith("source-types.json"))


class SidecarTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.workspace = pathlib.Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)
        environment = mock.patch.dict(os.environ, {"OPEN_SCIENCE_WORKSPACE_DIR": str(self.workspace)})
        environment.start()
        self.addCleanup(environment.stop)

    def sidecar_beside(self, relative):
        path = self.workspace / relative
        return json.loads((path.parent / "source.json").read_text(encoding="utf-8"))

    def test_a_web_page_carries_its_authority_type_beside_it(self):
        receipt = {
            "url": "https://www.nice.org.uk/guidance/ng136", "finalUrl": "https://www.nice.org.uk/guidance/ng136",
            "title": "Hypertension in adults", "site": "www.nice.org.uk", "fetchedAt": "2026-09-20T00:00:00.000Z",
            "official": True, "rendered": False, "contentType": "html", "mediaType": "text/html",
            "sha256": "a" * 64, "extractor": {"name": "evimed-html", "version": "1.0.0"},
        }
        payload = {"receipt": receipt, "text": "Offer lifestyle advice to people with hypertension. " * 10, "links": []}
        web_read._SNAPSHOTS.clear()
        with mock.patch.object(web_read, "_fetch", return_value=payload):
            result = web_read.read({"url": "https://www.nice.org.uk/guidance/ng136"})
        self.assertEqual(result["status"], "success", result)
        sidecar = self.sidecar_beside(result["data"]["markdownPath"])
        self.assertEqual(sidecar["sourceType"], "guideline")
        self.assertEqual(sidecar["url"], "https://www.nice.org.uk/guidance/ng136")
        # The sidecar is part of the capture: its digest is in the manifest.
        capture = self.workspace / pathlib.PurePosixPath(result["data"]["markdownPath"]).parent
        self.assertEqual(immutable_capture.verify_capture(self.workspace, capture.relative_to(self.workspace)), [])
        self.assertIn("source.json", json.loads((capture / "capture.json").read_text(encoding="utf-8"))["artifacts"])

    def test_a_preserved_abstract_carries_its_design(self):
        record = {
            "pmid": "30221597", "title": "Effect of Aspirin on Disability-free Survival in the Healthy Elderly.",
            "sections": ["RESULTS: No benefit."], "journal": "N Engl J Med", "year": "2018", "doi": "", "pmcid": "",
            "publicationTypes": ["Journal Article", "Randomized Controlled Trial"], "meshHeadings": [],
        }
        captured = public_sources._preserve_pubmed_abstract(record)
        self.assertEqual(self.sidecar_beside(captured["path"])["sourceType"], "rct")


if __name__ == "__main__":
    unittest.main()
