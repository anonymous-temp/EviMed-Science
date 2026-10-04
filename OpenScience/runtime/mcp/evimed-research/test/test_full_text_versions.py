"""Full text by version: what the article says about itself, its tables as cells, its supplements, and why Europe PMC refused.

The article is the real PMC XML recorded 2026-10-04 (`wire/europepmc__fulltext_PMC6454835.xml`, CC-BY, with ten
declared supplements). The supplementary archives are constructed here (see `test_open_access_supplements`).
A `contentLevel` is the claim this module makes about its own text; a metadata response is never full text.
"""

import hashlib
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import open_access_fulltext as fulltext  # noqa: E402
import public_sources  # noqa: E402
import source_outcome  # noqa: E402
import source_transport as transport  # noqa: E402
import wire_fixtures as wire  # noqa: E402
from test_open_access_supplements import SHEET, TABLE, build_zip, md5  # noqa: E402

PMCID = "PMC6454835"
XML = wire.body("europepmc__fulltext_PMC6454835.xml")
META = {"pmcid": PMCID, "doi": "10.3389/fphys.2018.01776", "title": "Aging and Comorbidities", "isOpenAccess": "Y", "hasSuppl": "Y"}


def archive_for_declared(names):
    """A zip holding one constructed file per declared name, each with the md5 the article declares."""
    files = [(name, SHEET + name.encode()) for name in names]
    return build_zip(files, streamed=True), dict(files)


class Workspace(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.workspace = pathlib.Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)
        patch = mock.patch.dict(os.environ, {"OPEN_SCIENCE_WORKSPACE_DIR": str(self.workspace)})
        patch.start()
        self.addCleanup(patch.stop)
        for name in ("EVIMED_PUBLIC_SOURCE_GATEWAY_URL", "EVIMED_MCP_FIXTURES"):
            os.environ.pop(name, None)

    def fetch(self, arguments=None, *, xml=XML, metadata=META, download=None):
        """`fetch` with Europe PMC answering the recorded XML; `download` stands in for the supplementary archive."""
        arguments = {"identifier": PMCID, **(arguments or {})}
        patches = [
            mock.patch.object(fulltext, "_resolve", return_value=dict(metadata)),
            mock.patch.object(fulltext, "_request_bytes", return_value=xml),
        ]
        if download is not None:
            if isinstance(download, BaseException):
                patches.append(mock.patch.object(fulltext.transport, "download", side_effect=download))
            else:
                patches.append(mock.patch.object(fulltext.transport, "download", return_value=download))
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        return fulltext.fetch(arguments)


class VersionFactsTests(Workspace):
    def test_the_article_states_its_own_version_dates_license_and_open_access(self):
        result = self.fetch()
        self.assertEqual(result["status"], "success", result)
        data = result["data"]
        self.assertEqual(data["contentLevel"], "full_text_xml")
        self.assertEqual(result["sources"][0]["evidenceAccess"], "full_text")
        version = data["version"]
        self.assertEqual(
            (version["pmcVersion"], version["articleVersion"], version["released"], version["live"], version["lastChange"]),
            ("PMC6454835.1", "1", "2019-04-02", "2019-04-18", "2026-03-01"),
        )
        self.assertEqual(data["license"], "http://creativecommons.org/licenses/by/4.0/")
        self.assertIs(data["openAccess"], True)
        self.assertEqual(version["capture"]["xmlSha256"], hashlib.sha256(XML).hexdigest())
        self.assertEqual((version["capture"]["earlierVersions"], version["capture"]["new"], version["capture"]["changedSinceEarlierCapture"]), (0, True, False))

    def test_the_same_article_again_is_the_same_capture_and_a_changed_one_says_so(self):
        first = self.fetch()
        again = fulltext.fetch({"identifier": PMCID})
        self.assertEqual(first["artifacts"], again["artifacts"])
        self.assertEqual((again["data"]["version"]["capture"]["new"], again["data"]["version"]["capture"]["earlierVersions"]), (False, 1))
        changed_xml = XML.replace(b"2026-03-01 18:25:13.663", b"2026-09-01 10:00:00.000")
        with mock.patch.object(fulltext, "_request_bytes", return_value=changed_xml):
            third = fulltext.fetch({"identifier": PMCID})
        capture = third["data"]["version"]["capture"]
        self.assertEqual((capture["new"], capture["changedSinceEarlierCapture"], capture["earlierVersions"]), (True, True, 1))
        self.assertEqual(third["data"]["version"]["lastChange"], "2026-09-01")
        self.assertIn("different text than the version preserved earlier; both are kept", third["summary"])
        self.assertTrue(all((self.workspace / path).is_file() for path in first["artifacts"] + third["artifacts"]), "the earlier version is kept beside the new one")

    def test_a_fact_the_article_does_not_state_is_absent(self):
        bare = b"<article><front><article-meta><article-id pub-id-type='pmcid'>PMC1</article-id><title-group><article-title>T</article-title></title-group></article-meta></front><body><sec><title>M</title><p>text</p></sec></body></article>"
        result = self.fetch(xml=bare, metadata={"pmcid": "PMC1234567"})
        data = result["data"]
        self.assertNotIn("license", data)
        self.assertNotIn("openAccess", data)
        self.assertEqual(set(data["version"]) - {"capture"}, set())


class TablesTests(Workspace):
    TABLE_XML = b"""<article><front><article-meta><title-group><article-title>Trial</article-title></title-group></article-meta></front>
<body><sec><title>Results</title><p>See Table 1.</p>
<table-wrap id="T1"><label>Table 1</label><caption><p>Baseline and outcome</p></caption>
<table><thead><tr><th rowspan="2">Group</th><th colspan="2">Events</th></tr><tr><th>n</th><th>%</th></tr></thead>
<tbody><tr><td>Aspirin</td><td>130</td><td>4.1</td></tr><tr><td>Placebo</td><td>142</td><td>4.6</td></tr></tbody></table>
<table-wrap-foot><p>Percentages are of randomized participants.</p></table-wrap-foot></table-wrap></sec></body></article>"""

    def test_a_tables_cells_are_in_the_text_and_in_a_structured_file(self):
        result = self.fetch(xml=self.TABLE_XML, metadata={"pmcid": "PMC1234567"})
        data = result["data"]
        text = (self.workspace / data["markdownPath"]).read_text(encoding="utf-8")
        self.assertIn("| Aspirin | 130 | 4.1 |", text, "a number in a table is quotable only if it is in the text")
        self.assertIn("Percentages are of randomized participants.", text)
        self.assertIn("**Table 1.** Baseline and outcome", text)
        stored = json.loads((self.workspace / data["tables"]["path"]).read_text(encoding="utf-8"))
        (table,) = stored["tables"]
        self.assertEqual((table["label"], table["rowCount"], table["footnotes"]), ("Table 1", 2, ["Percentages are of randomized participants."]))
        self.assertEqual([[cell["text"] for cell in row] for row in table["rows"]], [["Aspirin", "130", "4.1"], ["Placebo", "142", "4.6"]])
        header = table["header"]
        self.assertEqual((header[0][0].get("rowspan"), header[0][1].get("colspan")), (2, 2), "spans stay on the cell, not repeated into neighbours")
        self.assertEqual(data["tables"]["count"], 1)
        self.assertIn(data["tables"]["path"], result["artifacts"])
        self.assertEqual(data["artifactSha256s"][data["tables"]["path"]], hashlib.sha256((self.workspace / data["tables"]["path"]).read_bytes()).hexdigest())

    def test_the_header_is_joined_per_column_in_the_markdown(self):
        record = fulltext._table_record(next(node for node in fulltext.ET.fromstring(self.TABLE_XML).iter() if node.tag == "table-wrap"))
        lines = fulltext._markdown_table(record)
        self.assertEqual(lines[0], "| Group | Events / n | Events / % |")
        self.assertEqual(lines[1], "| --- | --- | --- |")

    def test_an_article_with_no_tables_writes_no_tables_file(self):
        result = self.fetch(xml=b"<article><body><sec><title>M</title><p>text</p></sec></body></article>", metadata={"pmcid": "PMC1234567"})
        self.assertEqual(result["data"]["tables"], {"count": 0, "withCells": 0})
        self.assertFalse(any(path.endswith("tables.json") for path in result["artifacts"]))

    def test_the_real_article_has_tables_in_its_text(self):
        result = self.fetch()
        self.assertGreaterEqual(result["data"]["tables"]["count"], 1)


class SupplementsTests(Workspace):
    def declared_names(self):
        return [entry["name"] for entry in fulltext.supplements.declared_supplements(XML)["files"]]

    def whole(self):
        names = self.declared_names()
        archive, files = archive_for_declared(names)
        # Make each constructed file verify: rewrite the article's declared md5 to the constructed bytes.
        xml = XML
        for entry in fulltext.supplements.declared_supplements(XML)["files"]:
            xml = xml.replace(entry["md5"].encode(), md5(files[entry["name"]]).encode())
        return xml, archive, files

    def download(self, archive, **fields):
        return transport.Download(archive, "application/zip", fields.get("complete", True), fields.get("reason"), len(archive), 1, 4.2)

    def test_not_asked_for_is_not_fetched_and_the_article_still_lists_what_it_declares(self):
        with mock.patch.object(fulltext.transport, "download") as download:
            result = self.fetch()
        download.assert_not_called()
        section = result["data"]["supplementaryFiles"]
        self.assertEqual((section["retrieval"], section["declaredCount"]), ("not_requested", 10))
        self.assertEqual(section["declared"][0]["md5"], "24d51e4f342957e3b1bced5d6e4b3dab")
        self.assertEqual(section["links"][0]["url"].split("/")[2], "www.frontiersin.org")

    def test_a_whole_archive_is_preserved_file_by_file_each_verified_against_the_article(self):
        xml, archive, files = self.whole()
        result = self.fetch({"supplements": True}, xml=xml, download=self.download(archive))
        self.assertEqual(result["status"], "success", result)
        section = result["data"]["supplementaryFiles"]
        self.assertEqual((section["retrieval"], section["verified"], section["mismatched"], section["notReceived"]), ("complete", 10, 0, 0))
        self.assertEqual(len([record for record in section["files"] if "path" in record]), 10)
        for record in section["files"]:
            on_disk = (self.workspace / record["path"]).read_bytes()
            self.assertEqual(hashlib.sha256(on_disk).hexdigest(), record["sha256"])
            self.assertEqual(result["data"]["artifactSha256s"][record["path"]], record["sha256"])
            self.assertEqual((record["status"], record["md5Verified"]), ("verified", True))
        self.assertTrue(section["manifestPath"].endswith("/supplements.json"))
        self.assertIn(section["manifestPath"], result["artifacts"])
        manifest = json.loads((self.workspace / section["manifestPath"]).read_text(encoding="utf-8"))
        self.assertEqual((manifest["pmcid"], manifest["pmcVersion"], manifest["archiveComplete"]), (PMCID, "PMC6454835.1", True))
        self.assertEqual(len(manifest["declared"]), 10)
        self.assertEqual(result["data"]["outcome"], {"state": "complete"})
        # The supplements sit under the article's own capture root, apart from the text.
        self.assertTrue(section["manifestPath"].startswith(".evimed-sources/PMC6454835/supplements/"))

    def test_the_same_supplements_are_the_same_capture(self):
        xml, archive, _files = self.whole()
        first = self.fetch({"supplements": True}, xml=xml, download=self.download(archive))
        with mock.patch.object(fulltext.transport, "download", return_value=self.download(archive)):
            again = fulltext.fetch({"identifier": PMCID, "supplements": True})
        self.assertEqual(first["data"]["supplementaryFiles"]["manifestPath"], again["data"]["supplementaryFiles"]["manifestPath"])

    def test_a_file_whose_md5_does_not_match_is_kept_and_labelled_and_warned_about(self):
        # The constructed bytes do not match the real article's declared md5s.
        archive, _files = archive_for_declared(self.declared_names()[:2])
        result = self.fetch({"supplements": True}, download=self.download(archive))
        section = result["data"]["supplementaryFiles"]
        self.assertEqual((section["mismatched"], section["verified"]), (2, 0))
        kept = [record for record in section["files"] if "path" in record]
        self.assertEqual([record["status"] for record in kept], ["md5_mismatch", "md5_mismatch"])
        self.assertEqual(result["status"], "warning")
        self.assertIn("do not match the md5 the article declares", " ".join(result["warnings"]))
        self.assertEqual(section["notReceived"], 8)
        self.assertIn("not in Europe PMC's archive", " ".join(result["warnings"]))

    def test_an_archive_cut_short_keeps_the_whole_files_and_says_how_far_it_got(self):
        # 3.5 MB took 136 s on the live wire: a deadline shorter than that returns what arrived.
        xml, archive, _files = self.whole()
        second = archive.index(b"PK\x03\x04", 4)
        third = archive.index(b"PK\x03\x04", second + 4)
        cut = archive[:third + 44]
        result = self.fetch({"supplements": True}, xml=xml, download=self.download(cut, complete=False, reason="deadline"))
        section = result["data"]["supplementaryFiles"]
        kept = [record for record in section["files"] if "path" in record]
        self.assertEqual((section["retrieval"], len(kept), section["archive"]["complete"]), ("partial", 2, False))
        self.assertEqual([record["status"] for record in section["files"] if "path" not in record], ["not_received"] * 8, "every declared file is accounted for")
        self.assertEqual(section["notReceived"], 8)
        failed = result["data"]["outcome"]["failed"]
        self.assertEqual([(entry["state"], entry["reason"]) for entry in failed], [("timeout", "deadline")])
        self.assertEqual(failed[0]["partial"], {"bytesReceived": len(cut), "filesKept": 2})
        self.assertIn("2 file(s) arrived whole and are preserved", failed[0]["how"])
        self.assertEqual(result["status"], "warning")
        self.assertTrue(all(record["status"] == "verified" for record in kept))

    def test_an_article_that_is_not_open_access_is_denied_and_the_text_still_stands(self):
        denied = source_outcome.SourceError("denied", "Europe PMC does not serve the supplementary files of %s: it is not an open-access article." % PMCID, scope="Europe PMC", reason="not_open_access", retryable=False)
        result = self.fetch({"supplements": True}, download=denied)
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["supplementaryFiles"]["retrieval"], "failed")
        (failed,) = result["data"]["outcome"]["failed"]
        self.assertEqual((failed["state"], failed["reason"], failed["scope"]), ("denied", "not_open_access", "Europe PMC supplementary files"))
        self.assertTrue((self.workspace / result["data"]["markdownPath"]).is_file(), "the full text was retrieved whole; the supplements failing does not take it back")

    def test_a_timeout_before_the_first_byte_is_named_and_the_text_still_stands(self):
        timeout = source_outcome.SourceError("timeout", "Europe PMC did not answer within 20 s.", scope="Europe PMC", reason="no_answer_in_time", retryable=True)
        result = self.fetch({"supplements": True}, download=timeout)
        (failed,) = result["data"]["outcome"]["failed"]
        self.assertEqual((failed["state"], failed["reason"]), ("timeout", "no_answer_in_time"))
        self.assertEqual(result["status"], "warning")

    def test_an_article_with_no_supplements_is_no_results_and_is_not_asked(self):
        with mock.patch.object(fulltext.transport, "download") as download:
            result = self.fetch({"supplements": True}, xml=b"<article><body><sec><title>M</title><p>text</p></sec></body></article>", metadata={"pmcid": "PMC1234567", "hasSuppl": "N"})
        download.assert_not_called()
        section = result["data"]["supplementaryFiles"]
        self.assertEqual((section["retrieval"], section["outcome"]["state"], section["outcome"]["reason"]), ("none", "no_results", "none_declared"))
        self.assertEqual(result["status"], "success")

    def test_europe_pmcs_empty_answer_is_no_results(self):
        with mock.patch.object(fulltext.supplements, "retrieve", return_value=(None, source_outcome.no_results(reason="no_supplementary_files", how="none"))):
            result = self.fetch({"supplements": True})
        self.assertEqual(result["data"]["supplementaryFiles"]["outcome"]["state"], "no_results")

    def test_an_archive_over_the_bound_is_truncated_and_nothing_is_preserved_from_it(self):
        big = transport.Download(b"PK" + b"\0" * 100, "application/zip", False, "size_limit", 99_999_999, 1, 9.0)
        # Nothing whole arrived: a cut at the bound is never preserved as the file.
        result = self.fetch({"supplements": True}, download=big)
        section = result["data"]["supplementaryFiles"]
        self.assertEqual(section["retrieval"], "nothing_kept")
        self.assertEqual(section["outcome"]["state"], "truncated")
        self.assertNotIn("manifestPath", section)

    def test_only_figures_in_the_archive_is_no_results_not_supplements(self):
        archive = build_zip([("fphys-09-01776-g001.gif", b"GIF89a" + b"\0" * 100)], streamed=True)
        result = self.fetch({"supplements": True}, download=self.download(archive))
        section = result["data"]["supplementaryFiles"]
        self.assertEqual((section["retrieval"], section["outcome"]["reason"]), ("nothing_kept", "no_supplements_in_archive"))
        self.assertEqual(section["notKept"][0]["status"], "article_figure")

    def test_a_call_with_supplements_gets_the_longer_deadline(self):
        seen = []
        original = transport.Deadline

        def spy(seconds, **options):
            seen.append(seconds)
            return original(seconds, **options)

        with mock.patch.object(fulltext.transport, "Deadline", side_effect=spy), mock.patch.object(fulltext.supplements, "retrieve", return_value=(None, source_outcome.no_results(reason="x", how="y"))):
            self.fetch({"supplements": True})
            fulltext.fetch({"identifier": PMCID})
        self.assertEqual(seen, [fulltext.DEADLINE_WITH_SUPPLEMENTS_SECONDS, fulltext.DEADLINE_SECONDS])
        self.assertLess(fulltext.DEADLINE_WITH_SUPPLEMENTS_SECONDS, 180)


class IntakeTests(Workspace):
    def test_the_text_and_supplements_are_offered_to_intake_by_preserved_path_only(self):
        archive, _files = archive_for_declared(["Table_S1.csv"])
        xml = XML
        offered = []

        def hand_off(group, files, deadline=None):
            offered.append((group, list(files)))
            return {"available": True, "registered": len(files), "refused": 0, "results": [{"path": path, "registered": True} for path in files]}

        with mock.patch.object(fulltext.source_intake, "hand_off", side_effect=hand_off):
            result = self.fetch({"intake": True, "supplements": True}, xml=xml, download=transport.Download(archive, "application/zip", True, None, len(archive), 1, 1.0))
        (group, files) = offered[0]
        self.assertEqual(group, PMCID)
        self.assertTrue(files[0].endswith("/fulltext.md"))
        self.assertTrue(all(path.startswith(".evimed-sources/") for path in files), "only preserved paths cross")
        self.assertFalse(any(path.endswith("supplements.json") for path in files), "the manifest is the platform's record, not a document")
        self.assertEqual(result["data"]["intake"]["registered"], len(files))

    def test_an_intake_that_is_not_available_is_a_warning_and_never_a_failure(self):
        with mock.patch.object(fulltext.source_intake, "hand_off", return_value={"available": False, "reason": "no_gateway", "how": "Source intake is offered through the platform gateway."}):
            result = self.fetch({"intake": True})
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["intake"]["reason"], "no_gateway")
        self.assertIn("platform gateway", " ".join(result["warnings"]))
        self.assertTrue((self.workspace / result["data"]["markdownPath"]).is_file())

    def test_intake_is_not_attempted_unless_asked(self):
        with mock.patch.object(fulltext.source_intake, "hand_off") as hand_off:
            result = self.fetch()
        hand_off.assert_not_called()
        self.assertNotIn("intake", result["data"])


class RefusalTests(Workspace):
    """Recorded 2026-10-04: `fullTextXML` answers HTTP 500, not 403 or 404, for a non-open-access article and for a PMCID that does not exist."""

    def fetch_refused(self, metadata, *, lookup=None, pdf=None):
        failure = wire.through_gateway("europepmc__fulltextxml_500.json")
        patches = [mock.patch.object(fulltext, "_resolve", return_value=dict(metadata))]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        door = mock.Mock(side_effect=[failure] * 3)
        with mock.patch.object(public_sources, "_open_remote", door), mock.patch.object(public_sources, "_ncbi_pace"), \
                mock.patch.object(transport.time, "sleep"), \
                mock.patch.object(fulltext, "_request_json", return_value=lookup or {"resultList": {"result": []}}), \
                mock.patch.object(fulltext, "_fetch_open_access_pdf", side_effect=pdf) as pdf_route:
            return fulltext.fetch({"identifier": metadata["pmcid"]}), pdf_route, door

    def test_a_non_open_access_article_is_denied_and_is_not_called_unavailable(self):
        result, pdf_route, door = self.fetch_refused({"pmcid": "PMC6533834", "doi": ""}, lookup={"resultList": {"result": [{"pmcid": "PMC6533834", "isOpenAccess": "N"}]}})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "source_access_denied")
        self.assertIs(result["error"]["retryable"], False)
        self.assertIn("without an open license", result["error"]["message"])
        self.assertIn("knowledge base", " ".join(result["next_actions"]))
        self.assertEqual(len(door.call_args_list), 3, "the 500 was retried like any server error before it was explained")

    def test_a_pmcid_europe_pmc_has_no_record_of_is_not_available(self):
        result, _pdf, _door = self.fetch_refused({"pmcid": "PMC99999999", "doi": ""}, lookup={"resultList": {"result": []}})
        self.assertEqual((result["status"], result["error"]["code"]), ("error", "full_text_not_available"))

    def test_an_open_access_article_that_answers_500_is_the_source_being_down(self):
        result, _pdf, _door = self.fetch_refused({"pmcid": "PMC6454835", "doi": ""}, lookup={"resultList": {"result": [{"pmcid": "PMC6454835", "isOpenAccess": "Y"}]}})
        self.assertEqual(result["error"]["code"], "source_unavailable")
        self.assertIs(result["error"]["retryable"], True)

    def test_a_refusal_with_a_doi_goes_on_to_the_open_access_pdf_and_says_why(self):
        sentinel = {"status": "success", "data": {}, "sources": [], "artifacts": []}
        result, pdf_route, _door = self.fetch_refused(
            {"pmcid": "PMC6533834", "doi": "10.4022/jafib.2093"}, lookup={"resultList": {"result": [{"pmcid": "PMC6533834", "isOpenAccess": "N"}]}}, pdf=lambda *a, **k: sentinel,
        )
        self.assertIs(result, sentinel)
        failure = pdf_route.call_args.kwargs["xml_failure"]
        self.assertEqual((failure.code, failure.source_error.reason), ("source_access_denied", "not_open_access"))


class PdfRouteTests(Workspace):
    def test_the_pdf_route_says_what_the_text_is_and_why_the_xml_was_not_used(self):
        denied = source_outcome.SourceError("denied", "not open access", scope="Europe PMC", reason="not_open_access", retryable=False)
        failure = fulltext.FullTextError(denied.code, str(denied), False, source_error=denied)
        pdf = b"%PDF-1.7 open access"
        parsed = {"text": "Table 2. Hazard ratio 0.74 (95% CI 0.65-0.85).", "extractor": {"name": "evimed-extract", "version": "1"}, "pageMap": [{"page": 1}]}
        provenance = {"origin": "https://repo.example.org", "version": "acceptedVersion", "license": "cc-by"}
        with mock.patch.object(fulltext, "_open_access_pdf", return_value=(pdf, provenance, parsed, None)):
            result = fulltext._fetch_open_access_pdf({"doi": "10.1/oa", "title": "T"}, self.workspace, xml_failure=failure, deadline=transport.Deadline(30))
        data = result["data"]
        self.assertEqual((data["contentLevel"], data["version"]["openAccessVersion"]), ("full_text_pdf_parsed", "acceptedVersion"))
        self.assertEqual(data["fallbackFrom"]["code"], "source_access_denied")
        self.assertEqual(data["fallbackFrom"]["reason"], "not_open_access")
        self.assertIn("would not serve the publisher's XML (not open access)", result["summary"])
        self.assertEqual(result["sources"][0]["evidenceAccess"], "full_text")
        self.assertEqual(data["supplementaryFiles"], {"retrieval": "not_available_for_pdf_route"})

    def test_a_text_layer_reading_is_labelled_as_such(self):
        pdf = b"%PDF synthetic"

        class Reader:
            is_encrypted = False
            pages = [mock.Mock(extract_text=lambda: "Text layer evidence. " * 200)]
            metadata = None

        with mock.patch.dict(sys.modules, {"pypdf": mock.Mock(PdfReader=lambda _stream: Reader())}), \
                mock.patch.object(fulltext, "_open_access_pdf", return_value=(pdf, {"origin": "o", "version": "", "license": ""}, None, {"code": "source_parser_unavailable", "message": "none"})):
            result = fulltext._fetch_open_access_pdf({"doi": "10.1/oa", "title": "T"}, self.workspace)
        self.assertEqual(result["data"]["contentLevel"], "full_text_pdf_text_layer")
        self.assertIsNone(result["data"]["version"]["openAccessVersion"])


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_fulltext_versions", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ThroughTheServerTests(Workspace):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def test_the_tool_accepts_the_two_new_flags_and_nothing_else(self):
        schema = self.server.TOOLS["open_access_full_text"]["inputSchema"]
        self.assertEqual(sorted(schema["properties"]), ["identifier", "intake", "supplements"])
        self.assertFalse(schema["additionalProperties"])
        for flag in ("supplements", "intake"):
            self.assertEqual(schema["properties"][flag]["type"], "boolean")

    def test_the_new_result_shape_passes_the_servers_tool_result_contract(self):
        xml, archive, _files = SupplementsTests.whole(SupplementsTests("test_a_whole_archive_is_preserved_file_by_file_each_verified_against_the_article"))
        with mock.patch.object(fulltext, "_resolve", return_value=dict(META)), mock.patch.object(fulltext, "_request_bytes", return_value=xml), \
                mock.patch.object(fulltext.transport, "download", return_value=transport.Download(archive, "application/zip", True, None, len(archive), 1, 2.0)):
            result = self.server.call_tool("open_access_full_text", {"identifier": PMCID, "supplements": True})
        self.assertEqual(result["status"], "success", result)
        self.assertEqual(result["data"]["provenance"]["tool"], "open_access_full_text")
        self.assertEqual(result["sources"][0]["evidenceAccess"], "full_text")
        # The run-side evidence reader finds every preserved file by its digest.
        self.assertEqual(set(result["artifacts"]) - set(result["data"]["artifactSha256s"]), set())

    def test_a_refusal_reaches_the_run_in_the_closed_vocabulary(self):
        denied = source_outcome.SourceError("denied", "Europe PMC serves the full-text XML only for open-access articles.", scope="Europe PMC", reason="not_open_access", retryable=False)
        failure = fulltext.FullTextError(denied.code, str(denied), False, source_error=denied)
        with mock.patch.object(fulltext, "_resolve", return_value={"pmcid": "PMC1234567", "doi": ""}), mock.patch.object(fulltext, "_request_bytes", side_effect=failure):
            result = self.server.call_tool("open_access_full_text", {"identifier": "PMC1234567"})
        self.assertEqual(result["error"]["code"], "source_access_denied")
        self.assertEqual(set(result["error"]), {"code", "message", "retryable", "stopReason"})


if __name__ == "__main__":
    unittest.main()
