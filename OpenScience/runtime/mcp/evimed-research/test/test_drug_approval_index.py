"""drug_approval_records on an invented snapshot: candidates side by side, nothing invented, the snapshot always stated."""

import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import build_fda_approvals as builder  # noqa: E402
import drug_approval_index as index  # noqa: E402
import fda_fixtures  # noqa: E402


class SnapshotCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        root = Path(cls.directory.name)
        payloads = fda_fixtures.payloads()
        cache = root / "cache"
        cache.mkdir()
        for data in payloads.values():
            (cache / hashlib.sha256(data).hexdigest()).write_bytes(data)
        cls.output = root / "fda-approvals.sqlite"
        with mock.patch.object(builder, "SOURCES", fda_fixtures.pins_for(payloads)):
            builder.build(cls.output, cache)
        cls.environment = mock.patch.dict(os.environ, {index.DATABASE_ENV: str(cls.output)})
        cls.environment.start()

    @classmethod
    def tearDownClass(cls):
        cls.environment.stop()
        cls.directory.cleanup()

    def find(self, name, **more):
        return index.call({"action": "find", "name": name, **more})

    def record(self, applNo, **more):
        return index.call({"action": "record", "applNo": applNo, **more})


class FindTests(SnapshotCase):
    def test_a_brand_lists_its_application_and_counts_the_others_that_share_its_ingredient(self):
        data = self.find("Alphamox")["data"]
        self.assertEqual([row["application"] for row in data["applications"]], ["NDA 900001"])
        self.assertEqual(data["matched"], "exact")
        self.assertEqual(data["otherApplicationsSameIngredient"], {"total": 2, "byType": {"ANDA": 2}, "how": "find by the ingredient name to list them"})

    def test_an_ingredient_lists_every_application_that_carries_it_side_by_side_nda_first(self):
        result = self.find("Alphamox Hydrochloride")
        data = result["data"]
        self.assertEqual([row["application"] for row in data["applications"]], ["NDA 900001", "ANDA 900002", "ANDA 900005"])
        self.assertEqual(data["countsByType"], {"NDA": 1, "ANDA": 2, "BLA": 0})
        self.assertNotIn("otherApplicationsSameIngredient", data)
        nda = data["applications"][0]
        self.assertEqual(nda["applicant"], "ALPHA PHARMACEUTICALS INC")
        self.assertEqual(nda["sponsor"], "ALPHA")
        self.assertEqual(nda["originalApproval"]["date"], "2010-03-05")
        self.assertEqual(nda["latestApproved"]["date"], "2023-02-14")
        self.assertEqual(nda["marketing"], {"Prescription": 2})
        self.assertEqual(len(nda["products"]), 2)
        self.assertIn("EQ 20MG BASE", nda["products"][1])
        self.assertIn("approved 2014-06-01", nda["products"][1])
        self.assertEqual(nda["patentRows"], 4)
        self.assertEqual(nda["exclusivityRows"], 2)

    def test_the_answer_states_its_snapshot_and_that_earlier_states_may_be_missing(self):
        for result in (self.find("alphamox"), self.find("zzqxv unknown"), self.record("900001")):
            snapshot = result["data"]["snapshot"]
            self.assertIn("2026-10-30", snapshot["drugsAtFda"])
            self.assertIn("September 2026", snapshot["orangeBook"])
            self.assertIn("earlier than the snapshot may be missing", snapshot["caveat"])
            self.assertEqual(len(snapshot["inputs"]), 4)

    def test_a_generic_row_is_labelled_and_its_discontinued_status_is_shown(self):
        by_number = {row["applNo"]: row for row in self.find("alphamox hydrochloride")["data"]["applications"]}
        self.assertEqual(by_number["900005"]["type"], "ANDA")
        self.assertEqual(by_number["900005"]["marketing"], {"Discontinued": 1})
        self.assertEqual(by_number["900002"]["products"][0].count("TE AB"), 1)

    def test_a_biologic_with_a_tentative_approval_is_labelled_bla_and_has_no_full_applicant_name(self):
        row = self.find("betakine")["data"]["applications"][0]
        self.assertEqual(row["type"], "BLA")
        self.assertIsNone(row["applicant"])
        self.assertEqual(row["sponsor"], "BETA")
        self.assertIn("applicantNote", row)
        self.assertEqual(row["originalApproval"]["status"], "tentative approval")
        self.assertFalse(row["orangeBook"])

    def test_an_ingredient_matches_through_its_salt_and_a_dose_word_does_not_stop_the_match(self):
        self.assertEqual(self.find("betakinemab")["data"]["total"], 1)
        plain = self.find("alphamox hydrochloride")["data"]
        dosed = self.find("alphamox hydrochloride 10 mg tablets")["data"]
        self.assertEqual([row["applNo"] for row in dosed["applications"]], [row["applNo"] for row in plain["applications"]])
        self.assertEqual(dosed["matched"], "contains")

    def test_a_combination_is_found_by_either_of_its_ingredients(self):
        self.assertEqual(self.find("epsilocaine")["data"]["applications"][0]["applNo"], "900007")
        self.assertEqual(self.find("deltapin epsilocaine")["data"]["applications"][0]["applNo"], "900007")

    def test_a_name_longer_than_the_file_still_finds_the_most_specific_name_inside_it(self):
        result = self.find("gammaflex extended release cream")
        self.assertEqual(result["data"]["matched"], "within")
        self.assertEqual([row["applNo"] for row in result["data"]["applications"]], ["900006"])
        self.assertEqual(result["status"], "warning")

    def test_the_type_filter_keeps_the_counts_of_the_others(self):
        data = self.find("alphamox hydrochloride", applType="ANDA")["data"]
        self.assertEqual([row["type"] for row in data["applications"]], ["ANDA", "ANDA"])
        self.assertEqual(data["countsByType"]["NDA"], 1)

    def test_the_limit_lists_the_first_rows_and_counts_the_rest(self):
        result = self.find("alphamox hydrochloride", limit=1)
        self.assertEqual(result["data"]["shown"], 1)
        self.assertEqual(result["data"]["total"], 3)
        self.assertTrue(any("2 further applications" in warning for warning in result["warnings"]))

    def test_an_unknown_name_returns_close_names_and_never_a_row(self):
        result = self.find("alphamoxx")
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["applications"], [])
        self.assertEqual(result["data"]["total"], 0)
        self.assertIn("alphamox", [item["name"] for item in result["data"]["closeNames"]])
        self.assertIn("not guessed", result["warnings"][0])
        nothing = self.find("qqqq zzzz")
        self.assertEqual(nothing["data"]["applications"], [])
        self.assertEqual(nothing["data"]["closeNames"], [])

    def test_an_application_number_typed_as_a_name_finds_no_drug(self):
        self.assertEqual(self.find("NDA 900001")["data"]["applications"], [])

    def test_bad_arguments_are_refused_by_one_code(self):
        for arguments in ({"action": "find"}, {"action": "find", "name": "   "}, {"action": "find", "name": "!!!"}, {"action": "find", "name": "x" * 200},
                          {"action": "find", "name": "alphamox", "applType": "XYZ"}, {"action": "find", "name": "alphamox", "limit": 101},
                          {"action": "find", "name": "alphamox", "limit": True}, {"action": "drop"}):
            with self.assertRaises(index.DrugApprovalError, msg=arguments) as caught:
                index.call(arguments)
            self.assertEqual(caught.exception.code, "drug_approval_input_invalid")
            self.assertEqual(caught.exception.stop_reason(), "invalid_input")


class RecordTests(SnapshotCase):
    def test_the_submissions_are_listed_with_dates_types_class_and_category(self):
        rows = self.record("900001")["data"]["submissions"]
        self.assertEqual(rows["total"], 6)
        self.assertEqual(rows["rows"][0], "ORIG 1 | 2010-03-05 | approved | Type 1 - New Molecular Entity | review priority")
        self.assertEqual(rows["rows"][1], "SUPPL 1 | 2011-04-01 | approved | Labeling | review standard")
        self.assertEqual(rows["rows"][2], "SUPPL 2 | 2014-06-01 | approved | Not Applicable | review standard | categories: Efficacy-New Indication")
        self.assertIn("SUPPL 4 | 2020-01-01 | CR", rows["rows"][4])

    def test_a_short_limit_keeps_the_original_and_the_newest_and_says_what_it_left_out(self):
        result = self.record("900001", limit=3)
        rows = result["data"]["submissions"]
        self.assertEqual(rows["shown"], 3)
        self.assertEqual(rows["omittedMiddle"], 3)
        self.assertTrue(rows["rows"][0].startswith("ORIG 1"))
        self.assertTrue(rows["rows"][-1].startswith("SUPPL 5"))
        self.assertTrue(any("middle submissions" in warning for warning in result["warnings"]))

    def test_patents_come_with_expiry_flags_use_codes_and_the_codes_meaning(self):
        patents = self.record("900001")["data"]["patents"]
        self.assertEqual(patents["total"], 2)
        first, second = patents["rows"]
        self.assertEqual((first["patentNo"], first["expires"]), ("7000002", "2029-02-01"))
        self.assertEqual(first["flags"], ["drugProduct", "delistRequested"])
        self.assertNotIn("useCodes", first)
        self.assertEqual((second["patentNo"], second["expires"]), ("7000001", "2031-08-24"))
        self.assertEqual(second["flags"], ["drugSubstance", "drugProduct"])
        self.assertEqual(second["products"], ["001", "002"])
        # U-9001 covers both products, U-9002 only the first: nothing the file separates is merged
        self.assertEqual(second["useCodes"], ["U-9001", "U-9002 (products 001)"])
        self.assertEqual(second["submittedToFda"], "2013-06-27")
        self.assertEqual(patents["useCodeMeanings"]["U-9002"], "METHOD OF TREATING INVENTED CONDITION TWO")

    def test_exclusivities_come_with_expiry_and_the_codes_meaning(self):
        exclusivity = self.record("900001")["data"]["exclusivity"]
        self.assertEqual([(row["code"], row["expires"], row["products"]) for row in exclusivity["rows"]], [("NCE", "2015-03-05", ["001"]), ("I-9100", "2030-06-01", ["002"])])
        self.assertEqual(exclusivity["codeMeanings"]["NCE"], "NEW CHEMICAL ENTITY")
        self.assertEqual(exclusivity["codeMeanings"]["I-9100"], "A NEW INDICATION & A SECOND CLAUSE")

    def test_a_product_narrows_patents_exclusivities_and_the_header(self):
        data = self.record("900001", productNo="2")["data"]
        self.assertEqual(data["productFilter"], "002")
        self.assertEqual([row["code"] for row in data["exclusivity"]["rows"]], ["I-9100"])
        self.assertEqual([row["patentNo"] for row in data["patents"]["rows"]], ["7000001"])
        self.assertEqual(len(data["application"]["products"]), 1)
        self.assertIn("Product_No=002&Appl_No=900001&Appl_type=N", data["checkCurrent"]["orangeBookPatents"])

    def test_the_application_number_is_read_the_way_find_and_people_write_it(self):
        for text in ("900001", "NDA 900001", "nda900001", "N-900001"):
            self.assertEqual(self.record(text)["data"]["application"]["applNo"], "900001", text)
        self.assertEqual(self.record("900001")["data"]["checkCurrent"]["drugsAtFda"].split("ApplNo=")[1], "900001")

    def test_an_application_with_no_patent_or_exclusivity_says_that_is_not_a_finding_of_none(self):
        result = self.record("900002")
        self.assertEqual(result["data"]["patents"]["rows"], [])
        self.assertEqual(result["data"]["exclusivity"]["rows"], [])
        self.assertTrue(any("Orange Book drops them once expired" in warning for warning in result["warnings"]))

    def test_an_application_outside_the_orange_book_says_so(self):
        result = self.record("900003")
        self.assertTrue(any("not in the Orange Book" in warning for warning in result["warnings"]))
        self.assertNotIn("orangeBookPatents", result["data"]["checkCurrent"])

    def test_the_orange_books_pre_1982_approval_is_kept_as_written(self):
        header = self.record("900006")["data"]["application"]
        self.assertIsNone(header["originalApproval"]["date"])
        self.assertIn("prior to Jan 1, 1982", header["originalApproval"]["source"])
        self.assertIn("before 1982-01-01", header["products"][0])

    def test_an_unknown_application_or_product_is_not_found_by_name_and_invents_nothing(self):
        for arguments in ({"applNo": "123456"}, {"applNo": "900001", "productNo": "009"}):
            with self.assertRaises(index.DrugApprovalError) as caught:
                self.record(**arguments)
            self.assertEqual(caught.exception.code, "drug_approval_application_not_found")
            self.assertEqual(caught.exception.stop_reason(), "not_found")
        with self.assertRaises(index.DrugApprovalError) as caught:
            self.record("123456")
        self.assertIn("2026-10-30", str(caught.exception))

    def test_bad_arguments_are_refused_by_one_code(self):
        for arguments in ({"applNo": ""}, {"applNo": "12345678"}, {"applNo": "abc"}, {"applNo": "900001", "productNo": "1234"}, {"applNo": "900001", "limit": 0}):
            with self.assertRaises(index.DrugApprovalError, msg=arguments) as caught:
                self.record(**arguments)
            self.assertEqual(caught.exception.code, "drug_approval_input_invalid")


class SnapshotFileTests(unittest.TestCase):
    def test_a_missing_snapshot_is_a_named_fact_and_the_status_says_so(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {index.DATABASE_ENV: str(Path(directory) / "absent.sqlite")}):
            with self.assertRaises(index.DrugApprovalError) as caught:
                index.call({"action": "find", "name": "alphamox"})
            self.assertEqual(caught.exception.code, "drug_approval_index_unconfigured")
            self.assertEqual(index.status(), {"installed": False, "code": "drug_approval_index_unconfigured"})

    def test_a_file_built_for_another_schema_or_not_a_database_is_refused(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as directory:
            other = Path(directory) / "other.sqlite"
            connection = sqlite3.connect(other)
            connection.executescript("CREATE TABLE metadata (key TEXT, value TEXT); INSERT INTO metadata VALUES ('schema', 'something-else');")
            connection.commit()
            connection.close()
            garbage = Path(directory) / "garbage.sqlite"
            garbage.write_bytes(b"not a database" * 100)
            link = Path(directory) / "link.sqlite"
            link.symlink_to(other)
            for path in (other, garbage, link):
                with mock.patch.dict(os.environ, {index.DATABASE_ENV: str(path)}):
                    with self.assertRaises(index.DrugApprovalError, msg=str(path)) as caught:
                        index.call({"action": "find", "name": "alphamox"})
                    self.assertEqual(caught.exception.code, "drug_approval_index_invalid")
        with mock.patch.dict(os.environ, {index.DATABASE_ENV: "relative/path.sqlite"}):
            with self.assertRaises(index.DrugApprovalError) as caught:
                index.call({"action": "find", "name": "alphamox"})
            self.assertEqual(caught.exception.code, "drug_approval_index_invalid")


class ToolDefinitionTests(unittest.TestCase):
    def test_the_schema_is_short_narrow_and_states_what_each_action_needs(self):
        (tool,) = index.tool_definitions()
        schema = tool["inputSchema"]
        self.assertEqual(tool["name"], "drug_approval_records")
        self.assertEqual(schema["required"], ["action"])
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["properties"]), {"action", "name", "applType", "applNo", "productNo", "limit"})
        self.assertLess(len(json.dumps(tool)), 2200, "the catalogue's size is a cost on every first request")
        for field in ("name", "applNo", "productNo", "limit"):
            self.assertIn("description", schema["properties"][field])
        self.assertIn("snapshot", tool["description"])
        self.assertIn("does not choose", tool["description"])


class ThroughTheServerTests(SnapshotCase):
    """What a run receives: the tool as the MCP server dispatches it."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        import importlib.util
        spec = importlib.util.spec_from_file_location("evimed_research_mcp_fda", HERE.parent / "server.py")
        cls.server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.server)

    def test_the_tool_is_offered_and_answers_through_call_tool(self):
        self.assertIn("drug_approval_records", {tool["name"] for tool in self.server.list_tools()})
        result = self.server.call_tool("drug_approval_records", {"action": "find", "name": "alphamox"})
        self.assertIn(result["status"], {"success", "warning"})
        self.assertEqual(result["data"]["applications"][0]["applNo"], "900001")
        self.assertNotIn("provenance", result["data"])
        self.assertNotIn("sources", result)

    def test_a_failure_names_its_code_its_stop_reason_and_the_next_step(self):
        missing = self.server.call_tool("drug_approval_records", {"action": "record", "applNo": "123456"})
        self.assertEqual(missing["status"], "error")
        self.assertEqual(missing["error"]["code"], "drug_approval_application_not_found")
        self.assertEqual(missing["error"]["stopReason"], "not_found")
        self.assertIn("find", missing["next_actions"][0])
        invalid = self.server.call_tool("drug_approval_records", {"action": "record", "applNo": "x"})
        self.assertEqual(invalid["error"]["code"], "drug_approval_input_invalid")
        schema = self.server.call_tool("drug_approval_records", {"action": "find", "name": "a", "extra": 1})
        self.assertEqual(schema["error"]["code"], "invalid_input")
        with mock.patch.dict(os.environ, {index.DATABASE_ENV: "/nonexistent/fda.sqlite"}):
            absent = self.server.call_tool("drug_approval_records", {"action": "find", "name": "alphamox"})
        self.assertEqual(absent["error"]["code"], "drug_approval_index_unconfigured")
        self.assertIn("web_read", absent["next_actions"][0])


if __name__ == "__main__":
    unittest.main()
