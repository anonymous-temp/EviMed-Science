"""MeSH descriptors for query building, and ATC classes for drug terms.

Both are deterministic lookups in public vocabularies through the gateway:
nothing here classifies a record or infers a concept from prose."""

import importlib.util
import pathlib
import sys
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import public_sources as sources  # noqa: E402


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_vocabulary", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MESH_SEARCH = {"esearchresult": {"idlist": ["68009203", "68017202"]}}
MESH_SUMMARY = {"result": {
    "uids": ["68009203", "68017202"],
    "68009203": {
        "uid": "68009203", "ds_meshui": "D009203",
        "ds_meshterms": ["Myocardial Infarction", "Infarction, Myocardial", "Heart Attack", "Myocardial Infarct"],
        "ds_scopenote": "NECROSIS of the MYOCARDIUM caused by an obstruction of the blood supply to the heart.",
        "ds_idxlinks": [
            {"parent": 68017202, "treenum": "C14.280.647.500", "children": [68056988, 68056989, 2101083]},
            {"parent": 68017202, "treenum": "C14.907.585.500", "children": [68056988]},
        ],
    },
    "68017202": {"uid": "68017202", "ds_meshui": "D017202", "ds_meshterms": ["Myocardial Ischemia"], "ds_idxlinks": []},
}}
MESH_CHILDREN = {"result": {
    "68056988": {"uid": "68056988", "ds_meshui": "D056988", "ds_meshterms": ["Anterior Wall Myocardial Infarction"]},
    "68056989": {"uid": "68056989", "ds_meshui": "D056989", "ds_meshterms": ["Inferior Wall Myocardial Infarction"]},
}}
ATC_PROPERTY = {"propConceptGroup": {"propConcept": [
    {"propCategory": "CODES", "propName": "ATC", "propValue": "A01AD05"},
    {"propCategory": "CODES", "propName": "ATC", "propValue": "B01AC06"},
    {"propCategory": "CODES", "propName": "ATC", "propValue": "N02BA01"},
]}}
ATC_CLASSES = {"rxclassDrugInfoList": {"rxclassDrugInfo": [
    {"minConcept": {"rxcui": "1191", "name": "aspirin", "tty": "IN"}, "rxclassMinConceptItem": {"classId": "B01AC", "className": "Platelet aggregation inhibitors excl. heparin", "classType": "ATC1-4"}, "relaSource": "ATC"},
    {"minConcept": {"rxcui": "1191", "name": "aspirin", "tty": "IN"}, "rxclassMinConceptItem": {"classId": "N02BA", "className": "Salicylic acid and derivatives", "classType": "ATC1-4"}, "relaSource": "ATC"},
    {"minConcept": {"rxcui": "135095", "name": "aspirin / codeine", "tty": "MIN"}, "rxclassMinConceptItem": {"classId": "N02AJ", "className": "Opioids in combination with non-opioid analgesics", "classType": "ATC1-4"}, "relaSource": "ATC"},
]}}


class MeshTests(unittest.TestCase):
    def test_a_term_maps_to_its_descriptor_with_what_a_query_needs(self):
        with mock.patch.object(sources, "_ncbi_get_json", side_effect=[MESH_SEARCH, MESH_SUMMARY, MESH_CHILDREN]) as fetch:
            descriptor = sources.mesh_descriptor("heart attack")
        urls = [call.args[0] for call in fetch.call_args_list]
        self.assertIn("esearch.fcgi", urls[0])
        self.assertIn("db=mesh", urls[0])
        # The record whose own entry terms contain the term wins, not merely the first.
        self.assertEqual(descriptor["descriptorUi"], "D009203")
        self.assertEqual(descriptor["name"], "Myocardial Infarction")
        self.assertEqual(descriptor["entryTerms"], ["Heart Attack", "Myocardial Infarct"])
        self.assertEqual(descriptor["treeNumbers"], ["C14.280.647.500", "C14.907.585.500"])
        # Narrower descriptors by name; the supplementary concept (2101083) is not one.
        self.assertIn("id=68056988%2C68056989", urls[2])
        self.assertEqual([item["name"] for item in descriptor["narrower"]], ["Anterior Wall Myocardial Infarction", "Inferior Wall Myocardial Infarction"])
        self.assertTrue(descriptor["pubmedQuery"].startswith('"Myocardial Infarction"[MeSH Terms] OR "Myocardial Infarction"[tiab]'))
        self.assertIn('"Heart Attack"[tiab]', descriptor["pubmedQuery"])
        self.assertNotIn("Infarction, Myocardial", descriptor["pubmedQuery"])

    def test_no_descriptor_is_none_not_a_guess(self):
        with mock.patch.object(sources, "_ncbi_get_json", return_value={"esearchresult": {"idlist": []}}):
            self.assertIsNone(sources.mesh_descriptor("心肌梗死"))

    def test_narrower_names_failing_keep_the_descriptor(self):
        unavailable = sources.PublicSourceError("public_source_unavailable", "timed out", True)
        with mock.patch.object(sources, "_ncbi_get_json", side_effect=[MESH_SEARCH, MESH_SUMMARY, unavailable]):
            descriptor = sources.mesh_descriptor("Myocardial Infarction")
        self.assertEqual(descriptor["descriptorUi"], "D009203")
        self.assertEqual(descriptor["narrower"], [])


class AtcTests(unittest.TestCase):
    def test_an_ingredient_gets_every_atc_code_with_its_class(self):
        with mock.patch.object(sources, "_get_json", side_effect=[ATC_PROPERTY, ATC_CLASSES]) as fetch:
            classes = sources.rxnorm_atc("1191")
        self.assertIn("rxcui/1191/property.json", fetch.call_args_list[0].args[0])
        self.assertIn("relaSource=ATC", fetch.call_args_list[1].args[0])
        self.assertEqual([item["code"] for item in classes], ["A01AD05", "B01AC06", "N02BA01"])
        by_code = {item["code"]: item for item in classes}
        self.assertEqual(by_code["B01AC06"]["className"], "Platelet aggregation inhibitors excl. heparin")
        self.assertEqual(by_code["B01AC06"]["anatomicalGroup"], "Blood and blood forming organs")
        # A combination product's class is not the ingredient's.
        self.assertIsNone(by_code["A01AD05"]["className"])

    def test_class_names_failing_keep_the_codes(self):
        unavailable = sources.PublicSourceError("public_source_unavailable", "timed out", True)
        with mock.patch.object(sources, "_get_json", side_effect=[ATC_PROPERTY, unavailable]):
            classes = sources.rxnorm_atc("1191")
        self.assertEqual(len(classes), 3)
        self.assertTrue(all(item["className"] is None for item in classes))

    def test_a_bad_rxcui_asks_nothing(self):
        with mock.patch.object(sources, "_get_json") as fetch:
            self.assertEqual(sources.rxnorm_atc("12a"), [])
        fetch.assert_not_called()


class ToolContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def test_term_normalize_maps_to_mesh_on_request(self):
        descriptor = {"descriptorUi": "D009203", "name": "Myocardial Infarction", "entryTerms": [], "treeNumbers": [], "narrower": [], "scopeNote": None, "pubmedQuery": "q", "url": "https://www.ncbi.nlm.nih.gov/mesh/68009203"}
        with mock.patch.object(self.server.public_sources, "mesh_descriptor", return_value=descriptor) as lookup:
            result = self.server.call_tool("term_normalize", {"term": "heart attack", "mesh": True})
            plain = self.server.call_tool("term_normalize", {"term": "heart attack"})
        lookup.assert_called_once()
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["mesh"]["descriptorUi"], "D009203")
        self.assertIn("MeSH descriptor Myocardial Infarction", result["summary"])
        self.assertNotIn("mesh", plain["data"])

    def test_term_normalize_says_when_mesh_has_nothing(self):
        with mock.patch.object(self.server.public_sources, "mesh_descriptor", return_value=None):
            result = self.server.call_tool("term_normalize", {"term": "心绞痛发作", "mesh": True})
        self.assertEqual(result["status"], "warning")
        self.assertTrue(any("MeSH is English" in text for text in result["warnings"]))

    def test_drug_term_normalize_carries_atc_and_survives_its_failure(self):
        resolved = {"rxcui": "1191", "preferred": "aspirin", "synonyms": ["aspirin"]}
        with mock.patch.object(self.server.public_sources, "rxnorm_resolve", return_value=resolved), \
             mock.patch.object(self.server.public_sources, "rxnorm_atc", return_value=[{"code": "B01AC06", "class": "B01AC", "className": "x", "anatomicalGroup": "y"}]):
            result = self.server.call_tool("drug_term_normalize", {"term": "aspirin"})
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["atc"][0]["code"], "B01AC06")
        unavailable = self.server.public_sources.PublicSourceError("public_source_unavailable", "timed out", True)
        with mock.patch.object(self.server.public_sources, "rxnorm_resolve", return_value=resolved), \
             mock.patch.object(self.server.public_sources, "rxnorm_atc", side_effect=unavailable):
            degraded = self.server.call_tool("drug_term_normalize", {"term": "aspirin"})
        self.assertEqual(degraded["status"], "warning")
        self.assertEqual(degraded["data"]["rxcui"], "1191")
        self.assertNotIn("atc", degraded["data"])


if __name__ == "__main__":
    unittest.main()
