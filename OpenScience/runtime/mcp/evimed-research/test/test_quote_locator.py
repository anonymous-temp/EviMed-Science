"""`locate_quote` and the quotation check it shares with the delivery gate.

The fixture is the domain's own verdicts (`packages/domain/test/fixtures/
quote-normalization.json`); the domain test reads the same file through
`claimVerification`. Either side drifting turns one of the two red.
"""

import importlib.util
import json
import os
import pathlib
import random
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = ROOT.parents[2]
FIXTURE = REPO / "packages" / "domain" / "test" / "fixtures" / "quote-normalization.json"
sys.path.insert(0, str(ROOT))

import immutable_capture  # noqa: E402
import quote_locator  # noqa: E402


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_locate", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SharedFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_the_fixture_names_this_normalisation(self):
        self.assertEqual(self.fixture["version"], quote_locator.NORMALIZATION)
        # Walked, not assumed: an empty fixture would pass every loop below.
        self.assertGreaterEqual(len(self.fixture["normalization"]), 20)
        self.assertGreaterEqual(len(self.fixture["presence"]), 20)

    def test_normalisation_equals_the_domain_on_every_fixture_pair(self):
        for case in self.fixture["normalization"]:
            with self.subTest(note=case["note"]):
                self.assertEqual(quote_locator.normalize_passage(case["input"]), case["expected"])

    def test_presence_equals_the_gate_verdict_on_every_fixture_case(self):
        for case in self.fixture["presence"]:
            with self.subTest(note=case["note"]):
                self.assertEqual(quote_locator.quote_is_present(case["source"], case["quote"]), case["present"])
                found, matches = quote_locator.locate_in_text(case["source"], case["quote"], ".evimed-sources/x/y.md")
                self.assertEqual(found, case["present"])
                for match in matches:
                    # The offsets point at the passage itself: the gate would
                    # accept the quote against the reported stretch alone.
                    stretch = case["source"][match["start"]:match["end"]]
                    self.assertTrue(quote_locator.quote_is_present(stretch, case["quote"]), stretch)


class OffsetMapTests(unittest.TestCase):
    """The mapped pipeline must produce the very text the verdict used."""

    ALPHABET = (
        list("abcXYZ019 .,;:!?-") + ["\n", "\t", "\u00a0", "\u3000", "\u00ad", "\u200b", "‘", "’",
                                   "“", "”", '"', "'", "–", "—", "⁄", "½", "³",
                                   "⁻", "，", "（", "Ａ", "阿", "司", "\u0301", "ᄀ",
                                   "ᅡ", "ᆨ", "İ", "Σ", "ﬁ", "㎎", "①", "\u0f73",
                                   "…", "\U0001d443", "\U00010400", "\u00a0", "-\n", "\n- ", " - ", "3.1", "0.25"]
    )

    def test_every_reading_maps_back_on_random_text(self):
        generator = random.Random(20260918)
        for _ in range(400):
            text = "".join(generator.choice(self.ALPHABET) for _ in range(generator.randint(0, 60)))
            for marker_free, extraction in quote_locator.READINGS:
                with self.subTest(text=text, marker_free=marker_free, extraction=extraction):
                    prepared = quote_locator._Prepared(text)
                    mapped = prepared.mapped(marker_free, extraction)
                    self.assertIsNotNone(mapped, "the offset map describes a different text than the verdict")
                    self.assertEqual(len(mapped.starts), len(mapped.text))
                    self.assertTrue(all(0 <= s < e <= len(text) for s, e in zip(mapped.starts, mapped.ends)))


class LocateInWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.workspace = pathlib.Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)
        self.full_text = (
            "# Aspirin for primary prevention in older adults\n\n"
            "## Results\n\n"
            "In the ASPREE trial, low-dose aspirin (100 mg daily) did not prolong disability-free survival "
            "among 19,114 older adults. Major haemorrhage occurred in 3.8% of the aspirin group and 2.8% of "
            "the placebo group (HR 1.38; 95% CI 1.18–1.62).\n\n"
            "阿司匹林用于一级预防时，出血风险增加。\n"
        )
        paths = immutable_capture.preserve(
            self.workspace, pathlib.Path(".evimed-sources") / "PMC6526574", {"fulltext.md": self.full_text.encode("utf-8")}
        )
        self.path = paths["fulltext.md"]

    def locate(self, **arguments):
        return quote_locator.locate(arguments, str(self.workspace))

    def test_an_exact_quote_is_found_with_offsets_line_and_context(self):
        quote = "low-dose aspirin (100 mg daily) did not prolong disability-free survival"
        data = self.locate(sourceId=self.path, quote=quote)
        self.assertTrue(data["found"])
        self.assertEqual(data["normalization"], "evimed-quote-v1")
        match = data["matches"][0]
        self.assertEqual(match["match"], "exact")
        self.assertEqual(self.full_text[match["start"]:match["end"]], quote)
        self.assertEqual(match["line"], 5)
        self.assertIn(quote, match["context"])
        self.assertEqual(match["artifactPath"], self.path)
        self.assertEqual(match["score"], 1.0)

    def test_a_quote_the_gate_forgives_is_a_normalized_match_on_the_original_passage(self):
        data = self.locate(sourceId=self.path, quote="“Major haemorrhage occurred in 3.8% of the aspirin group”")
        self.assertTrue(data["found"])
        match = data["matches"][0]
        self.assertEqual(match["match"], "normalized")
        self.assertEqual(self.full_text[match["start"]:match["end"]], "Major haemorrhage occurred in 3.8% of the aspirin group")

    def test_full_width_chinese_punctuation_maps_back_to_the_original_characters(self):
        data = self.locate(sourceId=self.path, quote="阿司匹林用于一级预防时,出血风险增加")
        self.assertTrue(data["found"])
        match = data["matches"][0]
        self.assertEqual(match["match"], "normalized")
        self.assertEqual(self.full_text[match["start"]:match["end"]], "阿司匹林用于一级预防时，出血风险增加")

    def test_an_elided_quote_spans_its_first_to_its_last_segment(self):
        data = self.locate(sourceId=self.path, quote="In the ASPREE trial … among 19,114 older adults")
        self.assertTrue(data["found"])
        match = data["matches"][0]
        self.assertTrue(self.full_text[match["start"]:match["end"]].startswith("In the ASPREE trial"))
        self.assertTrue(self.full_text[match["start"]:match["end"]].endswith("among 19,114 older adults"))

    def test_a_misquotation_is_not_found_and_the_nearest_passage_is_returned(self):
        data = self.locate(sourceId=self.path, quote="low-dose aspirin (100 mg daily) did not extend disability-free survival")
        self.assertFalse(data["found"])
        near = data["matches"][0]
        self.assertEqual(near["match"], "near")
        self.assertGreaterEqual(near["score"], quote_locator.NEAR_MIN_SCORE)
        self.assertLess(near["score"], 1.0)
        self.assertIn("did not prolong disability-free survival", near["text"])

    def test_a_passage_the_source_does_not_contain_returns_no_match(self):
        data = self.locate(sourceId=self.path, quote="Metformin lowered HbA1c by 0.8 percentage points in the intervention group.")
        self.assertFalse(data["found"])
        self.assertEqual(data["matches"], [])

    def test_a_number_cut_in_half_is_not_a_match(self):
        data = self.locate(sourceId=self.path, quote="8% of the aspirin group")
        self.assertFalse(data["found"])

    def test_occurrences_are_reported_without_overlap_and_bounded(self):
        text = ("bleeding risk increased. " * 30).encode("utf-8")
        path = immutable_capture.preserve(self.workspace, pathlib.Path(".evimed-sources") / "repeat", {"page.md": text})["page.md"]
        data = self.locate(sourceId=path, quote="bleeding risk increased", maxResults=3)
        self.assertTrue(data["found"])
        self.assertEqual(len(data["matches"]), 3)
        starts = [match["start"] for match in data["matches"]]
        self.assertEqual(starts, sorted(starts))
        self.assertTrue(all(b["start"] >= a["end"] for a, b in zip(data["matches"], data["matches"][1:])))

    def test_a_source_id_resolves_to_its_capture(self):
        for source_id in ("PMC6526574", "PMCID: PMC6526574"):
            with self.subTest(source_id=source_id):
                data = self.locate(sourceId=source_id, quote="did not prolong disability-free survival")
                self.assertTrue(data["found"])
                self.assertEqual(data["artifactPaths"], [self.path])

    def test_doi_web_page_and_guideline_ids_resolve_to_their_captures(self):
        doi_path = immutable_capture.preserve(
            self.workspace, pathlib.Path(".evimed-sources") / quote_locator._doi_slug("10.1056/nejmoa1805819"),
            {"fulltext.md": b"Aspirin use in older adults did not reduce cardiovascular disease."},
        )["fulltext.md"]
        page_path = immutable_capture.preserve(
            self.workspace, pathlib.Path(".evimed-sources") / "web-pages" / "fedcba9876543210",
            {"page.md": b"Take aspirin only if your doctor advises it."},
        )["page.md"]
        # Preserved by the official-page tool before it became `web_read`:
        # still in workspaces, still citable.
        old_page_path = immutable_capture.preserve(
            self.workspace, pathlib.Path(".evimed-sources") / "official-pages" / "0123456789abcdef",
            {"page.md": b"Chest pain that spreads to the arm needs an ambulance."},
        )["page.md"]
        guide_digest = __import__("hashlib").sha256(b"evimed-guide:G-42").hexdigest()[:16]
        guide_path = immutable_capture.preserve(
            self.workspace, pathlib.Path(".evimed-sources") / "evimed-guidelines" / guide_digest,
            {"guideline.md": b"Aspirin is not recommended for routine primary prevention in adults over 70."},
        )["guideline.md"]
        for source_id, path, quote in (
            ("https://doi.org/10.1056/NEJMoa1805819", doi_path, "did not reduce cardiovascular disease"),
            ("web-page:fedcba9876543210", page_path, "only if your doctor advises it"),
            ("official-page:0123456789abcdef", old_page_path, "needs an ambulance"),
            ("EVIMED-GUIDE:G-42", guide_path, "not recommended for routine primary prevention"),
        ):
            with self.subTest(source_id=source_id):
                data = self.locate(sourceId=source_id, quote=quote)
                self.assertTrue(data["found"])
                self.assertEqual(data["artifactPaths"], [path])

    def test_an_unknown_source_id_names_what_to_pass_instead(self):
        with self.assertRaises(quote_locator.QuoteLocatorError) as raised:
            self.locate(sourceId="PMC999999", quote="anything")
        self.assertEqual(raised.exception.code, "quote_source_not_found")
        self.assertIn(".evimed-sources", str(raised.exception))

    def test_only_preserved_sources_can_be_read(self):
        (self.workspace / "notes.md").write_text("did not prolong disability-free survival", encoding="utf-8")
        for source_id in ("notes.md", "../etc/passwd", ".evimed-sources/../notes.md", "/etc/passwd", ".evimed-sources//x.md"):
            with self.subTest(source_id=source_id), self.assertRaises(quote_locator.QuoteLocatorError) as raised:
                self.locate(sourceId=source_id, quote="did not prolong")
            self.assertIn(raised.exception.code, {"quote_source_invalid", "quote_source_not_found"})

    def test_a_symlink_inside_the_sources_is_never_followed(self):
        outside = self.workspace / "outside.md"
        outside.write_text("secret passage outside the sources", encoding="utf-8")
        (self.workspace / ".evimed-sources" / "linked.md").symlink_to(outside)
        with self.assertRaises(quote_locator.QuoteLocatorError) as raised:
            self.locate(sourceId=".evimed-sources/linked.md", quote="secret passage")
        self.assertEqual(raised.exception.code, "quote_source_not_found")

    def test_a_binary_artifact_is_refused_with_the_reason(self):
        path = immutable_capture.preserve(
            self.workspace, pathlib.Path(".evimed-sources") / "PMC1", {"fulltext.pdf": b"%PDF-1.7\0\0binary"}
        )["fulltext.pdf"]
        with self.assertRaises(quote_locator.QuoteLocatorError) as raised:
            self.locate(sourceId=path, quote="binary")
        self.assertEqual(raised.exception.code, "quote_source_unreadable")

    def test_a_megabyte_source_is_answered_in_bounded_time(self):
        generator = random.Random(7)
        words = "aspirin bleeding events older adults hazard ratio interval placebo trial outcome".split()
        filler = " ".join(generator.choice(words) for _ in range(160_000))
        text = filler[:500_000] + " The ASPREE finding was that aspirin did not prolong disability-free survival. " + filler[500_000:]
        path = immutable_capture.preserve(self.workspace, pathlib.Path(".evimed-sources") / "big", {"page.md": text.encode("utf-8")})["page.md"]
        started = time.monotonic()
        found = self.locate(sourceId=path, quote="aspirin did not prolong disability-free survival")
        near = self.locate(sourceId=path, quote="aspirin did not extend disability free survival")
        elapsed = time.monotonic() - started
        self.assertTrue(found["found"])
        self.assertFalse(near["found"])
        self.assertEqual(near["matches"][0]["match"], "near")
        # Generous on purpose: this guards against a quadratic regression, not
        # a slow machine. Measured at under a second for both calls.
        self.assertLess(elapsed, 10)


class ServerContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.workspace = pathlib.Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)
        self.path = immutable_capture.preserve(
            self.workspace, pathlib.Path(".evimed-sources") / "PMC7", {"fulltext.md": b"Aspirin increased major bleeding in older adults."}
        )["fulltext.md"]

    def call(self, arguments):
        with mock.patch.dict(os.environ, {"OPEN_SCIENCE_WORKSPACE_DIR": str(self.workspace)}):
            return self.server.call_tool("locate_quote", arguments)

    def test_the_tool_is_published_with_a_narrow_schema(self):
        tool = self.server.TOOLS["locate_quote"]
        schema = tool["inputSchema"]
        self.assertEqual(schema["required"], ["sourceId", "quote"])
        self.assertFalse(schema["additionalProperties"])
        self.assertIn("locate_quote", [item["name"] for item in self.server.list_tools()])

    def test_a_found_quote_is_a_success_with_the_contract_payload(self):
        result = self.call({"sourceId": self.path, "quote": "increased major bleeding"})
        self.assertEqual(result["status"], "success")
        data = result["data"]
        self.assertEqual(set(data) - {"provenance", "artifactPaths"}, {"sourceId", "found", "matches", "normalization"})
        self.assertTrue(data["found"])
        self.assertEqual(data["sourceId"], self.path)
        self.assertEqual(data["provenance"]["tool"], "locate_quote")
        match = data["matches"][0]
        self.assertLessEqual({"match", "start", "end", "score", "context"}, set(match))

    def test_a_missing_quote_is_a_warning_that_says_what_to_do(self):
        result = self.call({"sourceId": self.path, "quote": "Aspirin decreased major bleeding in older adults"})
        self.assertEqual(result["status"], "warning")
        self.assertFalse(result["data"]["found"])
        self.assertEqual(result["data"]["matches"][0]["match"], "near")
        self.assertTrue(result["next_actions"])

    def test_bad_input_is_refused_before_any_read(self):
        for arguments in ({"quote": "x"}, {"sourceId": self.path}, {"sourceId": self.path, "quote": "x", "maxResults": 0},
                          {"sourceId": self.path, "quote": "x", "extra": 1}):
            with self.subTest(arguments=arguments):
                self.assertEqual(self.call(arguments)["error"]["code"], "invalid_input")

    def test_an_unreadable_source_is_an_error_with_its_code(self):
        for source_id, code in (("../notes.md", "quote_source_invalid"), ("notes.md", "quote_source_not_found")):
            with self.subTest(source_id=source_id):
                result = self.call({"sourceId": source_id, "quote": "x"})
                self.assertEqual(result["status"], "error")
                self.assertEqual(result["error"]["code"], code)

    def test_without_a_managed_workspace_nothing_is_read(self):
        with mock.patch.dict(os.environ, {"OPEN_SCIENCE_WORKSPACE_DIR": ""}):
            result = self.server.call_tool("locate_quote", {"sourceId": self.path, "quote": "x"})
        self.assertEqual(result["error"]["code"], "quote_workspace_unavailable")


if __name__ == "__main__":
    unittest.main()
