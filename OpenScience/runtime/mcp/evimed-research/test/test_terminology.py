"""The terminology file behind `term_normalize`: lookup stages, the states of a file that is not there, the scale definitions, and the tool's answer.

The fixture file is written here with the builder's schema and a few synthetic entities (no vocabulary text of any real source); the node test
`apps/server/test/terminologyBuild.test.mjs` builds a file with the real builder and reads it through this module, so the two cannot drift apart.
"""

import importlib.util
import json
import os
import pathlib
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import terminology  # noqa: E402

SCHEMA = """
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE sources (id TEXT PRIMARY KEY, letter TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL, license TEXT NOT NULL, attribution TEXT NOT NULL, concepts INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE entities (id INTEGER PRIMARY KEY, en TEXT, zh TEXT, types TEXT NOT NULL, sources TEXT NOT NULL, detail TEXT NOT NULL);
CREATE TABLE lookup (folded TEXT NOT NULL, entity_id INTEGER NOT NULL, kind INTEGER NOT NULL, PRIMARY KEY (folded, entity_id)) WITHOUT ROWID;
CREATE TABLE code_lookup (code TEXT NOT NULL, entity_id INTEGER NOT NULL, PRIMARY KEY (code, entity_id)) WITHOUT ROWID;
CREATE VIRTUAL TABLE entity_fts USING fts5(w, content='', tokenize='unicode61 remove_diacritics 2');
"""

# id, en, zh, types, sources, [(lang, kind, source letter, text)], [(source letter, system, code)]
ENTITIES = [
    (1, "Lung Carcinoma", "肺癌", "disease", "ncit,zz", [("e", 0, "a", "Lung Carcinoma"), ("e", 1, "a", "Lung Cancer"), ("e", 1, "a", "Cancer of the Lung"),
                                                         ("z", 0, "b", "肺癌"), ("z", 1, "b", "肺恶性肿瘤"), ("e", 2, "a", "LC"),
                                                         ("e", 1, "a", "x" * 120)], [("a", "NCIt", "C0001"), ("a", "ICD-10", "C34.9")]),
    (2, "Non-Small Cell Lung Carcinoma", "非小细胞肺癌", "disease", "ncit,zz", [("e", 0, "a", "Non-Small Cell Lung Carcinoma"), ("e", 1, "a", "NSCLC"),
                                                                                  ("z", 0, "b", "非小细胞肺癌")], [("a", "NCIt", "C0002")]),
    (3, "Pembrolizumab", "帕博利珠单抗", "drug", "ncit", [("e", 0, "a", "Pembrolizumab"), ("e", 1, "a", "Keytruda"), ("z", 0, "b", "帕博利珠单抗")], [("a", "NCIt", "C0003")]),
    (4, "Pembrolizumab Regimen", None, "procedure", "ncit", [("e", 0, "a", "Pembrolizumab Regimen")], [("a", "NCIt", "C0004")]),
    (5, "EGFR", None, "gene", "zz", [("e", 0, "b", "EGFR"), ("e", 1, "b", "epidermal growth factor receptor")], [("b", "HGNC", "HGNC:3236")]),
    (6, "Common Cold", "普通感冒", "disease", "ncit", [("e", 0, "a", "Common Cold"), ("e", 1, "a", "Cold"), ("z", 0, "b", "普通感冒")], [("a", "NCIt", "C0006")]),
    (7, "Cold Temperature", None, "finding", "ncit", [("e", 0, "a", "Cold Temperature"), ("e", 1, "a", "Cold")], [("a", "NCIt", "C0007")]),
]
SOURCES = [("ncit", "a", "NCI Thesaurus", "26.10d", "CC BY 4.0", "NCI Thesaurus (CC BY 4.0)", 4),
           ("zz", "b", "Synthetic bridge", "file 000000000000", "private", "synthetic", 3)]


def fold(value):
    return terminology.fold(value)


def build(path, release=terminology.RELEASE):
    connection = sqlite3.connect(path)
    connection.executescript(SCHEMA)
    for row in SOURCES:
        connection.execute("INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?)", row)
    connection.execute("INSERT INTO metadata VALUES ('release', ?)", (release,))
    connection.execute("INSERT INTO metadata VALUES ('entities', ?)", (str(len(ENTITIES)),))
    for entity_id, en, zh, types, sources, terms, codes in ENTITIES:
        detail = "\n".join([f"{lang}{kind}{letter}{text}" for lang, kind, letter, text in terms] + ["#"] + [f"{letter}{system}\t{code}" for letter, system, code in codes])
        connection.execute("INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?)", (entity_id, en, zh, types, sources, detail))
        best = {}
        for lang, kind, letter, text in terms:
            best[fold(text)] = min(kind, best.get(fold(text), 9))
        for folded, kind in best.items():
            connection.execute("INSERT INTO lookup VALUES (?, ?, ?)", (folded, entity_id, kind))
        for _, _, code in codes:
            connection.execute("INSERT INTO code_lookup VALUES (?, ?)", (code, entity_id))
        words = sorted({word for _, _, _, text in terms for word in terminology.search_words(text)})
        connection.execute("INSERT INTO entity_fts (rowid, w) VALUES (?, ?)", (entity_id, " ".join(words)))
    connection.commit()
    connection.close()


class TerminologyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.join(self.directory.name, "terminology.sqlite")
        build(self.path)
        patcher = mock.patch.dict(os.environ, {terminology.ENV_DB: self.path})
        patcher.start()
        self.addCleanup(patcher.stop)

    def names(self, outcome):
        return [match["concept"] for match in outcome["matches"]]

    def test_an_exact_name_finds_its_entity_in_either_language_with_codes_and_sources(self):
        for term in ("肺癌", "lung cancer", "  LUNG   Cancer ", "ｌｕｎｇ ｃａｎｃｅｒ"):
            with self.subTest(term=term):
                found = terminology.lookup(term)
                self.assertTrue(found["available"])
                self.assertEqual(self.names(found)[0], "Lung Carcinoma")
                top = found["matches"][0]
                self.assertEqual(top["matchedOn"]["how"], "exact")
                self.assertEqual(top["chinese"], "肺癌")
                self.assertIn("Lung Cancer", top["synonyms"]["en"])
                self.assertIn("肺恶性肿瘤", top["synonyms"]["zh"])
                self.assertEqual(top["abbreviations"], ["LC"])
                self.assertEqual([(c["system"], c["code"]) for c in top["codes"]], [("ICD-10", "C34.9"), ("NCIt", "C0001")])
        found = terminology.lookup("肺癌")
        self.assertEqual({item["id"] for item in found["sources"]}, {"ncit", "zz"})
        self.assertEqual(next(item["version"] for item in found["sources"] if item["id"] == "ncit"), "26.10d")

    def test_dashes_read_as_spaces_and_a_very_long_synonym_is_not_listed(self):
        self.assertEqual(self.names(terminology.lookup("non small cell lung carcinoma"))[0], "Non-Small Cell Lung Carcinoma")
        self.assertEqual(self.names(terminology.lookup("Non-Small-Cell Lung Carcinoma"))[0], "Non-Small Cell Lung Carcinoma")
        self.assertNotIn("x" * 120, terminology.lookup("肺癌")["matches"][0]["synonyms"]["en"])

    def test_a_code_finds_the_entities_that_carry_it(self):
        for term in ("C34.9", "c34.9", "HGNC:3236"):
            with self.subTest(term=term):
                found = terminology.lookup(term)
                self.assertEqual(found["matches"][0]["matchedOn"]["how"], "code")
        self.assertEqual(self.names(terminology.lookup("C34.9")), ["Lung Carcinoma"])
        self.assertEqual(self.names(terminology.lookup("HGNC:3236")), ["EGFR"])

    def test_a_prefix_then_the_words_of_a_name_are_tried_when_nothing_matches_exactly(self):
        prefix = terminology.lookup("pembrolizumab r")
        self.assertEqual(self.names(prefix), ["Pembrolizumab Regimen"])
        self.assertEqual(prefix["matches"][0]["matchedOn"]["how"], "prefix")
        words = terminology.lookup("cancer lung of the")
        self.assertEqual(self.names(words)[0], "Lung Carcinoma")
        self.assertEqual(words["matches"][0]["matchedOn"]["how"], "words")
        chinese = terminology.lookup("恶性肿瘤")
        self.assertEqual(self.names(chinese)[0], "Lung Carcinoma")

    def test_nothing_found_is_an_empty_list_not_an_error(self):
        found = terminology.lookup("zzz-no-such-term")
        self.assertTrue(found["available"])
        self.assertEqual(found["matches"], [])

    def test_kinds_filter_and_domain_preference_and_language(self):
        both = terminology.lookup("pembrolizumab", limit=5)
        self.assertEqual(self.names(both), ["Pembrolizumab", "Pembrolizumab Regimen"])
        self.assertEqual(self.names(terminology.lookup("pembrolizumab", kinds=["procedure"])), ["Pembrolizumab Regimen"])
        # A preferred type orders entities that match the same way; it never lifts a prefix match above an exact one.
        self.assertEqual(self.names(terminology.lookup("pembrolizumab", prefer=["procedure"])), ["Pembrolizumab", "Pembrolizumab Regimen"])
        self.assertEqual(self.names(terminology.lookup("cold", prefer=["disease"])), ["Common Cold", "Cold Temperature"])
        self.assertEqual(self.names(terminology.lookup("cold", prefer=["finding"])), ["Cold Temperature", "Common Cold"])
        zh_only = terminology.lookup("lung cancer", language="zh")["matches"][0]
        self.assertEqual(zh_only["synonyms"]["en"], [])
        self.assertIn("肺恶性肿瘤", zh_only["synonyms"]["zh"])
        self.assertEqual(len(terminology.lookup("pembrolizumab", limit=1)["matches"]), 1)

    def test_a_file_that_is_not_usable_answers_unavailable_and_never_raises(self):
        junk = os.path.join(self.directory.name, "junk.sqlite")
        with open(junk, "wb") as handle:
            handle.write(b"not a database" * 100)
        foreign = os.path.join(self.directory.name, "foreign.sqlite")
        build(foreign, release="another-release")
        link = os.path.join(self.directory.name, "link.sqlite")
        os.symlink(self.path, link)
        for value, reason in (
            ("", "terminology_unconfigured"), ("relative.sqlite", "terminology_invalid"), (os.path.join(self.directory.name, "missing.sqlite"), "terminology_unavailable"),
            (junk, "terminology_invalid"), (foreign, "terminology_invalid"), (link, "terminology_invalid"), (self.directory.name, "terminology_invalid"),
        ):
            with self.subTest(value=value), mock.patch.dict(os.environ, {terminology.ENV_DB: value}):
                found = terminology.lookup("肺癌")
                self.assertFalse(found["available"])
                self.assertEqual(found["reason"], reason)
                self.assertFalse(terminology.status()["available"])
                self.assertEqual(terminology.adapter_result({"term": "肺癌"})["status"], "warning")

    def test_status_reports_the_release_and_its_sources(self):
        status = terminology.status()
        self.assertEqual((status["configured"], status["available"], status["release"], status["entities"]), (True, True, terminology.RELEASE, 7))

    def test_an_invalid_term_is_an_empty_answer(self):
        self.assertEqual(terminology.lookup("   ")["matches"], [])
        self.assertEqual(terminology.lookup("x" * 500)["matches"], [])

    def test_the_adapter_answers_a_tool_result_with_the_file_as_source(self):
        result = terminology.adapter_result({"term": "肺癌", "limit": 1})
        self.assertEqual(result["status"], "success")
        self.assertEqual(len(result["data"]["matches"]), 1)
        self.assertEqual(result["sources"][0]["source"], "evimed-terminology")
        self.assertIn("retrievedAt", result["sources"][0])

    def test_search_words_split_chinese_into_pairs_and_keep_other_words_whole(self):
        self.assertEqual(terminology.search_words("非小细胞肺癌"), ["非小", "小细", "细胞", "胞肺", "肺癌"])
        self.assertEqual(terminology.search_words("Non-Small cell, 肺癌2期"), ["non", "small", "cell", "肺癌", "癌2", "2", "期"][:3] + terminology.search_words("肺癌2期"))
        self.assertEqual(terminology.search_words("癌"), ["癌"])


class ScaleTests(unittest.TestCase):
    def test_a_scale_is_found_by_its_name_or_an_alias_in_either_language(self):
        for term, expected in (("ECOG", "ecog"), ("ecog ps", "ecog"), ("卡氏评分", "karnofsky"), ("Karnofsky", "karnofsky"), ("NYHA class", "nyha"),
                               ("child pugh", "child-pugh"), ("Child-Pugh", "child-pugh"), ("格拉斯哥昏迷评分", "gcs"), ("GCS", "gcs")):
            with self.subTest(term=term):
                self.assertEqual(terminology.scale(term)["id"], expected)
        self.assertIsNone(terminology.scale("MMSE"))

    def test_the_scales_carry_their_wording_source_and_licence_and_no_excluded_instrument(self):
        data = terminology.scales()
        self.assertEqual(sorted(item["id"] for item in data["scales"]), ["child-pugh", "ecog", "gcs", "karnofsky", "nyha"])
        self.assertTrue(data["note"])
        for item in data["scales"]:
            with self.subTest(scale=item["id"]):
                self.assertTrue(item["source"]["citation"] and item["source"]["codelist"] and item["license"])
        ecog = terminology.scale("ECOG")
        self.assertEqual([level["value"] for level in ecog["levels"]], [0, 1, 2, 3, 4, 5])
        self.assertTrue(ecog["levels"][0]["text"].startswith("Fully active"))
        self.assertEqual([level["value"] for level in terminology.scale("KPS")["levels"]], [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0])
        self.assertEqual([level["value"] for level in terminology.scale("NYHA")["levels"]], ["I", "II", "III", "IV"])
        serialized = json.dumps(data, ensure_ascii=False).lower()
        for banned in ("ajcc", "recist", "mmse", "moca", "mini-mental", "montreal cognitive"):
            self.assertNotIn(banned, serialized)


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_terminology", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TermNormalizeToolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.join(self.directory.name, "terminology.sqlite")
        build(self.path)

    def call(self, arguments, environment=None):
        values = {"EVIMED_TERMINOLOGY_DB": self.path, "EVIMED_TERMINOLOGY_SEARCH_URL": ""}
        values.update(environment or {})
        with mock.patch.dict(os.environ, values):
            return self.server.call_tool("term_normalize", arguments)

    def test_a_term_the_builtin_table_lacks_is_answered_from_the_file(self):
        result = self.call({"term": "非小细胞肺癌", "domain": "disease"})
        self.assertEqual(result["status"], "success")
        data = result["data"]
        self.assertEqual(data["preferred"], "Non-Small Cell Lung Carcinoma")
        self.assertIn("NSCLC", data["synonyms"] + data["matches"][0]["abbreviations"] if "abbreviations" in data["matches"][0] else data["synonyms"])
        self.assertEqual(data["vocabulary"], "evimed-terminology")
        self.assertTrue(data["terminology"]["available"])
        self.assertEqual(data["matches"][0]["codes"][0]["code"], "C0002")
        self.assertTrue(result["sources"])
        self.assertTrue(all("retrievedAt" in source for source in result["sources"]))

    def test_the_builtin_table_keeps_preferred_and_synonyms_where_it_has_the_term(self):
        result = self.call({"term": "心肌梗死"})
        self.assertEqual(result["data"]["preferred"], "myocardial infarction")
        self.assertEqual(result["data"]["synonyms"], ["myocardial infarction", "heart attack", "心肌梗死"])
        self.assertEqual(result["data"]["terminology"]["found"], 0)

    def test_a_missing_file_says_so_and_the_builtin_answer_stands(self):
        for environment in ({"EVIMED_TERMINOLOGY_DB": ""}, {"EVIMED_TERMINOLOGY_DB": os.path.join(self.directory.name, "none.sqlite")}):
            with self.subTest(environment=environment):
                known = self.call({"term": "aspirin"}, environment)
                self.assertEqual(known["status"], "success")
                self.assertFalse(known["data"]["terminology"]["available"])
                unknown = self.call({"term": "非小细胞肺癌"}, environment)
                self.assertEqual(unknown["status"], "warning")
                self.assertTrue(any("terminology file did not answer" in text for text in unknown["warnings"]))
                self.assertEqual(unknown["data"]["preferred"], "非小细胞肺癌")

    def test_no_match_in_an_available_file_is_the_old_warning_without_a_file_complaint(self):
        result = self.call({"term": "zzz-no-such-term"})
        self.assertEqual(result["status"], "warning")
        self.assertTrue(result["data"]["terminology"]["available"])
        self.assertFalse(any("did not answer" in text for text in result["warnings"]))

    def test_scale_returns_the_wording_with_its_source(self):
        result = self.call({"term": "ECOG", "scale": True})
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["scale"]["id"], "ecog")
        self.assertIn("ECOG", result["summary"])
        self.assertTrue(any(source["source"] == "cdisc-sdtm" for source in result["sources"]))
        missing = self.call({"term": "MMSE", "scale": True})
        self.assertEqual(missing["status"], "warning")
        self.assertTrue(any("scales held" in text for text in missing["warnings"]))

    def test_a_lookup_that_raises_never_ends_the_turn(self):
        with mock.patch.object(self.server.terminology, "lookup", side_effect=RuntimeError("boom")):
            result = self.call({"term": "aspirin"})
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["preferred"], "aspirin")
        self.assertFalse(result["data"]["terminology"]["available"])

    def test_docker_runtimes_ask_the_adapter(self):
        with mock.patch.dict(os.environ, {"EVIMED_TERMINOLOGY_DB": self.path}):
            answer = self.server.terminology.adapter_result({"term": "非小细胞肺癌"})
        with mock.patch.object(self.server, "_adapter_call", return_value={**answer, "data": {**answer["data"], "provenance": {}}}) as adapter:
            result = self.call({"term": "非小细胞肺癌", "language": "zh", "kinds": ["disease"], "domain": "disease"},
                               {"EVIMED_TERMINOLOGY_SEARCH_URL": "http://adapter.invalid/api/v1/evimed/terminology-lookup", "EVIMED_TERMINOLOGY_DB": ""})
        self.assertEqual(adapter.call_args.args[0], "terminology_lookup")
        sent = adapter.call_args.args[1]
        self.assertEqual((sent["term"], sent["language"], sent["kinds"], sent["prefer"]), ("非小细胞肺癌", "zh", ["disease"], ["disease", "phenotype", "finding"]))
        self.assertEqual(result["data"]["preferred"], "Non-Small Cell Lung Carcinoma")
        self.assertNotIn("provenance", result["data"]["matches"][0])

    def test_an_adapter_that_cannot_answer_leaves_the_builtin_table(self):
        failed = {"status": "error", "summary": "down", "next_actions": ["retry"], "error": {"code": "adapter_unavailable", "message": "down", "retryable": True, "stopReason": "x"}}
        with mock.patch.object(self.server, "_adapter_call", return_value=failed):
            result = self.call({"term": "aspirin"}, {"EVIMED_TERMINOLOGY_SEARCH_URL": "http://adapter.invalid/x", "EVIMED_TERMINOLOGY_DB": ""})
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["terminology"], {"available": False, "reason": "terminology_adapter_unavailable"})

    def test_the_schema_takes_only_the_declared_new_inputs(self):
        schema = self.server.TOOLS["term_normalize"]["inputSchema"]
        self.server._validate({"term": "x", "language": "zh", "kinds": ["disease", "gene"], "limit": 3, "scale": True}, schema, "request")
        for bad in ({"language": "fr"}, {"kinds": ["disease_state"]}, {"limit": 11}, {"scale": "yes"}, {"unknown": 1}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.server._validate({"term": "x", **bad}, schema, "request")


if __name__ == "__main__":
    unittest.main()
