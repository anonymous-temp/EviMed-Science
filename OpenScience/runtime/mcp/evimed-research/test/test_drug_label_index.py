"""The drug-label index: built from exports, searched, read, preserved, quoted.

Built for real from small workbooks in both export layouts (label_fixtures),
then exercised through the module, the research server and `locate_quote`."""

import hashlib
import importlib.util
import json
import os
import pathlib
import stat
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "test"))

import build_drug_label_index as builder  # noqa: E402
import drug_label_index as labels  # noqa: E402
import label_fixtures  # noqa: E402

ASPIRIN = "国药准字J20130078"


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_labels", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BuiltIndex(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.directory = pathlib.Path(cls.temporary.name)
        cls.path, cls.report = label_fixtures.build_index(cls.directory)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def label_row(self, approval):
        connection = sqlite3.connect(self.path)
        try:
            connection.row_factory = sqlite3.Row
            return dict(connection.execute("SELECT * FROM labels WHERE approval = ?", (approval,)).fetchone())
        finally:
            connection.close()

    def section_text(self, approval, section):
        connection = sqlite3.connect(self.path)
        try:
            row = connection.execute(
                "SELECT t.body, s.flags FROM sections s JOIN labels l ON l.id = s.label JOIN texts t ON t.id = s.text "
                "WHERE l.approval = ? AND s.section = ?", (approval, section),
            ).fetchone()
            return row
        finally:
            connection.close()


class BuilderTests(BuiltIndex):
    def test_rows_are_kept_or_counted_out_with_a_reason(self):
        rows = self.report["rows"]
        self.assertEqual(rows["read"], 10)
        self.assertEqual(rows["kept"], 7)
        self.assertEqual(rows["hiddenInSource"], 1, "a row hidden by the export's filter is still a label")
        self.assertEqual(rows["excludedReasons"], {
            "not a drug approval: 国食健注G9{8}": 1,
            "not a drug approval: (none)": 1,
            "no label text": 1,
        })
        self.assertEqual(self.report["labels"], 4)
        self.assertLess(self.report["peakMemoryMB"], 1024)

    def test_one_label_per_approval_the_fuller_copy_first_then_the_newer_export(self):
        aspirin = self.label_row(ASPIRIN)
        self.assertEqual(aspirin["origin"], "315jiage", "six core sections beat three")
        self.assertEqual(aspirin["alternates"], 1, "two identical 315jiage rows and one yaozs copy are two versions")
        aliases = json.loads(aspirin["aliases_json"])
        self.assertEqual(aliases["tradeNames"], ["拜阿司匹林"])
        self.assertEqual(aliases["manufacturers"], ["拜耳医药保健有限公司(进口)"])
        self.assertEqual(aspirin["generic_name"], "阿司匹林肠溶片", "the brand in brackets is not part of the name")
        self.assertEqual(aspirin["national_code"], "86900000000001", "a code stored as a number keeps its digits")
        warfarin = self.label_row("国药准字H31022123")
        self.assertEqual(warfarin["origin"], "yaozs", "the fuller copy wins even from the older export")
        self.assertEqual(self.label_row("H20140973")["generic_name"], "氯吡格雷片", "注册证号 wording is not part of the number")

    def test_cells_are_read_as_a_reader_sees_them(self):
        self.assertEqual(self.section_text(ASPIRIN, "adverse-reactions")[0], "胃肠道不适。\n可能增加出血风险。")
        self.assertEqual(self.section_text(ASPIRIN, "precautions")[0], "与其他抗凝药合用时应监测出血。", "rich-text runs join")
        self.assertEqual(self.section_text("国药准字H31020644", "dosage")[0], "每周1次。\n具体剂量遵医嘱。", "| is a line break")
        body, flags = self.section_text("国药准字H31020644", "precautions")
        self.assertEqual(len(body), 200)
        self.assertEqual(flags, "possibly-truncated")
        self.assertIsNone(self.section_text(ASPIRIN, "description"))

    def test_the_release_is_the_hash_of_the_content_and_the_file_is_read_only(self):
        again, report = label_fixtures.build_index(self.directory / "again")
        self.assertEqual(report["release"], self.report["release"])
        self.assertTrue(self.report["release"].startswith("drug-labels-"))
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o444)
        with self.assertRaises(FileExistsError):
            builder.build(self.directory / "exports", self.path, datasets=label_fixtures.DATASETS)
        metadata = dict(sqlite3.connect(again).execute("SELECT key, value FROM metadata"))
        self.assertEqual(metadata["schema"], labels.SCHEMA)
        self.assertEqual(json.loads(metadata["snapshots_json"])["315jiage"], "www.315jiage.cn, exported 2025-12-17")
        self.assertEqual(sorted(path.name for path in again.parent.iterdir() if path.name.startswith(".")), [], "no scratch left behind")

    def test_an_export_with_another_layout_is_refused_by_name(self):
        exports = self.directory / "changed"
        label_fixtures.write_exports(exports)
        headers = [name for name in label_fixtures.LABEL_COLUMNS if name != "禁忌"] + ["编号", "新列"]
        label_fixtures.write_workbook(exports / "labels(1).xlsx", headers, [])
        with self.assertRaisesRegex(builder.BuildError, "unexpected: 新列; missing: 禁忌"):
            builder.build(exports, self.directory / "changed.sqlite", datasets=label_fixtures.DATASETS)
        self.assertFalse((self.directory / "changed.sqlite").exists())

    def test_the_bounds_hold(self):
        with mock.patch.object(builder, "MAX_ROWS", 3):
            with self.assertRaisesRegex(builder.BuildError, "more rows"):
                builder.build(self.directory / "exports", self.directory / "bounded.sqlite", datasets=label_fixtures.DATASETS)
        with mock.patch.object(builder, "MAX_CELL_CHARS", 50):
            with self.assertRaisesRegex(builder.BuildError, "longer than 50"):
                builder.build(self.directory / "exports", self.directory / "bounded.sqlite", datasets=label_fixtures.DATASETS)
        self.assertFalse((self.directory / "bounded.sqlite").exists())

    def test_the_shipped_registry_maps_only_known_sections(self):
        for dataset in builder.DATASETS:
            for header, target in dataset["columns"].items():
                if target.startswith("section:"):
                    self.assertIn(target[len("section:"):], labels.SECTION_TITLES, header)
            self.assertFalse(set(dataset["columns"]) & set(dataset["ignored"]))


class IdentifierTests(unittest.TestCase):
    def test_approval_numbers_have_one_spelling(self):
        self.assertEqual(labels.canonical_approval(" 国药准字 h19990280 "), "国药准字H19990280")
        self.assertEqual(labels.canonical_approval("注册证号 H20140973"), "H20140973")
        self.assertEqual(labels.canonical_approval("国药准字ＨＪ２０２５０１０９"), "国药准字HJ20250109")
        for value in ("国食健注G20230831", "卫食健字(2001)第0424号", "-", "", None, "国药准字H1999028"):
            self.assertIsNone(labels.canonical_approval(value), value)

    def test_label_ids_parse_with_slugs_or_headings(self):
        self.assertEqual(labels.parse_label_id("label:国药准字H19990280#禁忌"), ("国药准字H19990280", "contraindications"))
        self.assertEqual(labels.parse_label_id("国药准字H19990280"), ("国药准字H19990280", None))
        self.assertEqual(labels.parse_label_id("label:H20140973#adverse-reactions"), ("H20140973", "adverse-reactions"))
        with self.assertRaises(labels.DrugLabelIndexError) as caught:
            labels.parse_label_id("label:aspirin")
        self.assertEqual(caught.exception.code, "drug_label_id_invalid")
        with self.assertRaises(labels.DrugLabelIndexError) as caught:
            labels.parse_label_id("label:国药准字H19990280#warnings")
        self.assertEqual(caught.exception.code, "drug_label_section_unknown")

    def test_query_terms_split_scripts_and_chinese_runs(self):
        self.assertEqual(labels.fts_query("维C银翘片"), '"维" AND "c" AND "银翘" AND "翘片"')
        self.assertEqual(labels.fts_query("amoxi", "丹参"), '"amoxi"* AND "丹参"')
        self.assertIsNone(labels.fts_query("  ", "!!"))


class ReaderTests(BuiltIndex):
    def search(self, **arguments):
        return labels.search(arguments, str(self.path))

    def test_search_by_name_brand_number_pinyin_and_holder(self):
        self.assertEqual(self.search(drug="阿司匹林肠溶片")["data"]["items"][0]["labelId"], "label:" + ASPIRIN)
        self.assertEqual([item["approvalNumber"] for item in self.search(drug="拜阿司匹林")["data"]["items"]], [ASPIRIN], "a second brand finds the label")
        self.assertEqual([item["approvalNumber"] for item in self.search(drug="国药准字 J20130078")["data"]["items"]], [ASPIRIN])
        self.assertEqual([item["approvalNumber"] for item in self.search(drug="H20140973")["data"]["items"]], ["H20140973"])
        self.assertEqual([item["approvalNumber"] for item in self.search(drug="amosipilin")["data"]["items"]], [ASPIRIN])
        narrowed = self.search(drug="华法林", manufacturer="上药信谊")["data"]["items"]
        self.assertEqual([item["approvalNumber"] for item in narrowed], ["国药准字H31022123"], "an alias holder narrows too")

    def test_a_search_item_says_what_can_be_read(self):
        result = self.search(drug="阿司匹林")
        item = result["data"]["items"][0]
        self.assertEqual(item["id"], item["labelId"])
        self.assertIn("contraindications", item["sections"])
        self.assertEqual(item["snapshot"], "www.315jiage.cn, exported 2025-12-17")
        self.assertEqual(item["otherNames"]["tradeNames"], ["拜阿司匹林"])
        self.assertEqual(result["status"], "warning")
        self.assertIn("snapshot of public label databases", result["warnings"][0])
        self.assertEqual(result["sources"][0]["id"], "label:" + ASPIRIN)

    def test_a_product_that_narrows_to_nothing_widens_and_says_so(self):
        result = self.search(drug="阿司匹林", product="不存在的商品名")
        self.assertEqual(len(result["data"]["items"]), 1)
        self.assertIn("for the drug alone", result["warnings"][0])
        self.assertEqual(self.search(drug="不存在的药")["data"]["items"], [])

    def test_a_read_returns_every_section_at_full_length(self):
        result = labels.read({"labelId": "label:国药准字H31020644", "sections": ["注意事项"]}, str(self.path))
        label = result["data"]["label"]
        self.assertEqual(label["requestedSections"], ["precautions"])
        by_section = {entry["section"]: entry for entry in label["sections"]}
        self.assertEqual(list(by_section), ["indications", "dosage", "contraindications", "precautions"], "label order")
        self.assertEqual(by_section["precautions"]["sectionId"], "label:国药准字H31020644#precautions")
        self.assertTrue(by_section["precautions"]["possiblyTruncated"])
        self.assertEqual(by_section["dosage"]["text"], "每周1次。\n具体剂量遵医嘱。")
        self.assertEqual(label["indexRelease"], self.report["release"])

    def test_reads_that_cannot_be_answered_say_why(self):
        for arguments, code in (
            ({"labelId": "label:国药准字H99999999"}, "drug_label_not_found"),
            ({"labelId": "aspirin"}, "drug_label_id_invalid"),
            ({"labelId": "label:" + ASPIRIN, "sections": ["boxed-warning"]}, "drug_label_section_unknown"),
        ):
            with self.assertRaises(labels.DrugLabelIndexError) as caught:
                labels.read(arguments, str(self.path))
            self.assertEqual(caught.exception.code, code)

    def test_the_file_is_found_or_refused_never_guessed(self):
        with mock.patch.dict(os.environ, {labels.DATABASE_ENV: ""}):
            self.assertIsNone(labels.database_path())
        with mock.patch.dict(os.environ, {labels.DATABASE_ENV: str(self.directory / "absent.sqlite")}):
            self.assertIsNone(labels.database_path(), "not shipped yet is not an error")
        link = self.directory / "link.sqlite"
        if not link.exists():
            link.symlink_to(self.path)
        for value in ("relative.sqlite", str(link)):
            with mock.patch.dict(os.environ, {labels.DATABASE_ENV: value}):
                with self.assertRaises(labels.DrugLabelIndexError):
                    labels.database_path()
        other = self.directory / "other.sqlite"
        if not other.exists():
            connection = sqlite3.connect(other)
            connection.executescript("CREATE TABLE metadata(key TEXT, value TEXT); INSERT INTO metadata VALUES ('schema', 'something-else');")
            connection.close()
        with self.assertRaises(labels.DrugLabelIndexError) as caught:
            labels.search({"drug": "阿司匹林"}, str(other))
        self.assertEqual(caught.exception.code, "drug_label_index_invalid")
        with mock.patch.dict(os.environ, {labels.DATABASE_ENV: str(self.path)}):
            self.assertEqual(labels.status(), {"configured": True, "release": self.report["release"], "labels": 4,
                                               "builtAt": labels.status()["builtAt"]})


class ServerTests(BuiltIndex):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.server = load_server()

    def setUp(self):
        self.workspace_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace_directory.cleanup)
        self.workspace = pathlib.Path(self.workspace_directory.name).resolve()
        environment = mock.patch.dict(os.environ, {
            labels.DATABASE_ENV: str(self.path),
            "OPEN_SCIENCE_WORKSPACE_DIR": str(self.workspace),
            "EVIMED_DRUG_LABEL_SEARCH_URL": "",
            "EVIMED_PUBLIC_CONNECTORS_ENABLED": "true",
        })
        environment.start()
        self.addCleanup(environment.stop)

    def read(self, **arguments):
        return self.server.call_tool("drug_label_search", arguments)

    def test_a_read_preserves_the_whole_label_and_shows_what_was_asked(self):
        result = self.read(labelId="label:" + ASPIRIN, sections=["contraindications"])
        self.assertEqual(result["status"], "warning", result.get("error"))
        label = result["data"]["label"]
        root = labels.capture_root(ASPIRIN)
        by_section = {entry["section"]: entry for entry in label["sections"]}
        self.assertEqual(by_section["contraindications"]["text"], "对阿司匹林过敏者禁用。活动性消化性溃疡者禁用。")
        self.assertNotIn("text", by_section["dosage"], "a section not asked for is listed, not shown")
        hashes = result["data"]["artifactSha256s"]
        for entry in label["sections"]:
            path = self.workspace / entry["artifactPath"]
            self.assertTrue(entry["artifactPath"].startswith(root + "/"))
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), hashes[entry["artifactPath"]])
        self.assertEqual(sorted(hashes), result["artifacts"])
        names = sorted(pathlib.PurePosixPath(path).name for path in result["artifacts"])
        self.assertEqual(names, sorted(["label.json", "source.json", *("%s.md" % entry["section"] for entry in label["sections"])]))
        sidecar = json.loads((self.workspace / label["labelFile"]).with_name("source.json").read_text(encoding="utf-8"))
        self.assertEqual(sidecar["sourceType"], "label")
        metadata = json.loads((self.workspace / label["labelFile"]).read_text(encoding="utf-8"))
        self.assertEqual(metadata["approvalNumber"], ASPIRIN)
        self.assertEqual(metadata["indexRelease"], self.report["release"])
        self.assertEqual(result["sources"][0]["sourceType"], "label")
        again = self.read(labelId="label:" + ASPIRIN)
        self.assertEqual(again["artifacts"], result["artifacts"], "one label text is one capture however it is read")
        self.assertIn("text", {entry["section"]: entry for entry in again["data"]["label"]["sections"]}["dosage"])

    def test_a_preserved_section_is_what_locate_quote_checks(self):
        self.read(labelId="label:" + ASPIRIN)
        found = self.server.call_tool("locate_quote", {"sourceId": "label:%s#contraindications" % ASPIRIN, "quote": "活动性消化性溃疡者禁用"})
        self.assertEqual(found["status"], "success", found)
        self.assertTrue(found["data"]["found"])
        self.assertEqual(found["data"]["matches"][0]["match"], "exact")
        anywhere = self.server.call_tool("locate_quote", {"sourceId": "label:" + ASPIRIN, "quote": "可能增加出血风险"})
        self.assertTrue(anywhere["data"]["found"], "a bare label id searches every preserved section")
        self.assertTrue(anywhere["data"]["matches"][0]["artifactPath"].endswith("/adverse-reactions.md"))
        heading = self.server.call_tool("locate_quote", {"sourceId": "label:%s#禁忌" % ASPIRIN, "quote": "对阿司匹林过敏者禁用"})
        self.assertTrue(heading["data"]["found"])

    def test_the_budget_lists_what_it_cannot_show(self):
        with mock.patch.object(self.server, "MAX_LABEL_TEXT_CHARS", 30):
            result = self.read(labelId="label:" + ASPIRIN)
        shown = [entry for entry in result["data"]["label"]["sections"] if "text" in entry]
        omitted = [entry for entry in result["data"]["label"]["sections"] if "omitted" in entry]
        self.assertTrue(shown and omitted)
        self.assertLessEqual(sum(len(entry["text"]) for entry in shown), 30)

    def test_a_section_the_label_lacks_is_named(self):
        result = self.read(labelId="label:国药准字H31020644", sections=["overdose", "dosage"])
        self.assertEqual(result["data"]["label"]["missingSections"], ["overdose"])

    def test_search_answers_from_the_index_for_china_and_elsewhere_from_the_connectors(self):
        result = self.read(drug="阿司匹林")
        self.assertEqual(result["data"]["items"][0]["sourceType"], "label")
        self.assertEqual(result["artifacts"] if "artifacts" in result else [], [], "a search preserves nothing")
        sentinel = {"status": "warning", "summary": "FDA labels.", "data": {"items": []}, "sources": [],
                    "warnings": ["fda"], "next_actions": ["verify"]}
        with mock.patch.object(self.server.public_sources, "labels", return_value=sentinel) as connectors, \
             mock.patch.object(labels, "search", wraps=labels.search) as index_search:
            self.read(drug="aspirin", jurisdiction="US")
            index_search.assert_not_called()
            self.assertEqual(connectors.call_args.args[0]["limit"], 3)
            nothing = self.read(drug="不存在的药", limit=10)
            self.assertEqual(connectors.call_count, 2)
            self.assertIn("has no Chinese label", nothing["warnings"][0])
            self.assertEqual(connectors.call_args.args[0]["limit"], 3, "the connectors keep their cap of three")

    def test_openfda_through_the_catalogue_never_reads_the_index(self):
        with mock.patch.object(labels, "search") as index_search, \
             mock.patch.object(self.server.public_sources, "_get_json", return_value={"results": []}), \
             mock.patch.object(self.server.public_sources, "_evimed_instruction_records",
                               side_effect=self.server.public_sources.PublicSourceError("evimed_evidence_unconfigured", "x", False)):
            self.server.public_sources.biomedical_search({"source": "openfda", "query": "aspirin"})
        index_search.assert_not_called()

    def test_refusals_name_the_fix(self):
        self.assertEqual(self.read()["error"]["code"], "invalid_input")
        self.assertEqual(self.read(labelId="aspirin")["error"]["code"], "drug_label_id_invalid")
        self.assertEqual(self.read(labelId="label:国药准字H99999999")["error"]["code"], "drug_label_not_found")
        with mock.patch.dict(os.environ, {labels.DATABASE_ENV: ""}):
            self.assertEqual(self.read(labelId="label:" + ASPIRIN)["error"]["code"], "drug_label_index_unconfigured")
        with mock.patch.dict(os.environ, {"OPEN_SCIENCE_WORKSPACE_DIR": ""}):
            self.assertEqual(self.read(labelId="label:" + ASPIRIN)["error"]["code"], "drug_label_preservation_failed")

    def test_a_remote_adapter_answer_is_preserved_here(self):
        # The container runtime has no index file: the adapter answers, and
        # this process writes the capture.
        server = self.server

        def adapter(name, arguments):
            body = server.public_sources.call(name, arguments)
            return server._normalize_tool_result(name, body, arguments, server._scope())

        with mock.patch.object(server, "_adapter_call", side_effect=adapter) as remote, \
             mock.patch.dict(os.environ, {labels.DATABASE_ENV: ""}):
            with mock.patch.dict(os.environ, {labels.DATABASE_ENV: str(self.path)}):
                result = self.read(labelId="label:%s#禁忌" % ASPIRIN)
        self.assertEqual(remote.call_args.args[1], {"labelId": "label:" + ASPIRIN, "sections": ["contraindications"]})
        self.assertTrue(all((self.workspace / path).is_file() for path in result["artifacts"]))

        def other_label(name, arguments):
            body = server.public_sources.call(name, {"labelId": "label:H20140973"})
            return server._normalize_tool_result(name, body, arguments, server._scope())

        with mock.patch.object(server, "_adapter_call", side_effect=other_label):
            refused = self.read(labelId="label:" + ASPIRIN)
        self.assertEqual(refused["error"]["code"], "adapter_contract_invalid")

    def test_health_reports_the_index(self):
        health = self.server.call_tool("health", {})
        self.assertEqual(health["data"]["drugLabelIndex"]["release"], self.report["release"])
        with mock.patch.dict(os.environ, {labels.DATABASE_ENV: ""}):
            self.assertEqual(self.server.call_tool("health", {})["data"]["drugLabelIndex"], {"configured": False})


if __name__ == "__main__":
    unittest.main()
