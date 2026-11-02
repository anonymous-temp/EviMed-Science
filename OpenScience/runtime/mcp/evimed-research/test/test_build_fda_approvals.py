"""The FDA approval-records builder: a pinned input that moved is refused by name, and the same inputs make the same index."""

import hashlib
import io
import json
import sqlite3
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import build_fda_approvals as builder  # noqa: E402
import fda_fixtures  # noqa: E402


class FixtureBuild(unittest.TestCase):
    """Builds the invented snapshot once into a temporary directory, from a cache named by digest (no network)."""

    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        root = Path(cls.directory.name)
        cls.payloads = fda_fixtures.payloads()
        cls.cache = root / "cache"
        cls.cache.mkdir()
        for data in cls.payloads.values():
            (cls.cache / hashlib.sha256(data).hexdigest()).write_bytes(data)
        cls.pins = fda_fixtures.pins_for(cls.payloads)
        cls.patch = mock.patch.object(builder, "SOURCES", cls.pins)
        cls.patch.start()
        cls.output = root / "fda-approvals.sqlite"
        with mock.patch.object(builder.urllib.request, "urlopen", side_effect=AssertionError("the build made a request")):
            builder.build(cls.output, cls.cache)

    @classmethod
    def tearDownClass(cls):
        cls.patch.stop()
        cls.directory.cleanup()

    def query(self, sql, *parameters):
        connection = sqlite3.connect("file:%s?mode=ro" % self.output, uri=True)
        try:
            return connection.execute(sql, parameters).fetchall()
        finally:
            connection.close()

    def test_every_table_is_read_and_the_file_ships_read_only(self):
        counts = json.loads(dict(self.query("SELECT key, value FROM metadata"))["counts"])
        self.assertEqual(counts["application"], 8)  # six listed, one seen only in Products, one only in Submissions
        self.assertEqual(counts["product"], 8)
        self.assertEqual(counts["patent"], 5)
        self.assertEqual(counts["exclusivity"], 3)
        self.assertFalse(self.output.stat().st_mode & 0o222)

    def test_the_original_is_the_approved_orig_submission_and_a_tentative_approval_says_so(self):
        row = self.query("SELECT orig_date, orig_status, orig_source, latest_date, latest_type, latest_no FROM application WHERE appl_no = '900001'")[0]
        self.assertEqual(row, ("2010-03-05", "approved", "Drugs@FDA ORIG submission", "2023-02-14", "SUPPL", 5))
        row = self.query("SELECT orig_date, orig_status, latest_date FROM application WHERE appl_no = '900003'")[0]
        self.assertEqual(row, ("2019-05-05", "tentative approval", None))

    def test_without_an_original_submission_the_orange_book_date_stands_in_and_says_so(self):
        row = self.query("SELECT orig_date, orig_status, orig_source FROM application WHERE appl_no = '900006'")[0]
        self.assertIsNone(row[0])
        self.assertEqual(row[1], "approved")
        self.assertIn("prior to Jan 1, 1982", row[2])

    def test_an_untyped_application_is_kept_untyped_and_the_orange_book_types_what_it_lists(self):
        self.assertEqual(self.query("SELECT appl_type FROM application WHERE appl_no = '900009'")[0][0], "unknown")
        self.assertEqual(self.query("SELECT appl_type FROM application WHERE appl_no = '900008'")[0][0], "unknown")
        self.assertEqual(self.query("SELECT appl_type FROM application WHERE appl_no = '900005'")[0][0], "ANDA")

    def test_dates_are_iso_and_a_supplement_category_that_is_only_punctuation_is_dropped(self):
        self.assertEqual(self.query("SELECT expire_iso FROM patent WHERE patent_no = '7000001' LIMIT 1")[0][0], "2031-08-24")
        self.assertEqual(self.query("SELECT categories FROM submission WHERE appl_no = '900001' AND no = 3 AND kind = 'SUPPL'")[0][0], "Labeling-Package Insert")
        self.assertIsNone(self.query("SELECT categories FROM submission WHERE appl_no = '900001' AND no = 4 AND kind = 'SUPPL'")[0][0])

    def test_code_meanings_are_decoded_and_the_index_is_the_same_file_every_time(self):
        self.assertEqual(self.query("SELECT meaning FROM code_meaning WHERE kind = 'exclusivity' AND code = 'I-9100'")[0][0], "A NEW INDICATION & A SECOND CLAUSE")
        again = self.output.parent / "again.sqlite"
        builder.build(again, self.cache)
        self.assertEqual(hashlib.sha256(self.output.read_bytes()).hexdigest(), hashlib.sha256(again.read_bytes()).hexdigest())

    def test_an_index_of_the_pinned_inputs_is_reused_and_anything_else_is_built_again(self):
        self.assertTrue(builder.reusable(self.output))
        other = {**self.pins, "orange-book.zip": {**self.pins["orange-book.zip"], "sha256": "0" * 64}}
        with mock.patch.object(builder, "SOURCES", other):
            self.assertFalse(builder.reusable(self.output))
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(builder.reusable(Path(directory) / "absent.sqlite"))
            garbage = Path(directory) / "garbage.sqlite"
            garbage.write_bytes(b"not a database")
            self.assertFalse(builder.reusable(garbage))

    def test_the_smoke_check_refuses_an_index_that_cannot_answer_for_a_common_drug(self):
        with self.assertRaisesRegex(SystemExit, "metformin"):
            builder.verify(self.output)


class RefusedInputs(unittest.TestCase):
    def build_with(self, payloads):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "cache"
            cache.mkdir()
            for data in payloads.values():
                (cache / hashlib.sha256(data).hexdigest()).write_bytes(data)
            with mock.patch.object(builder, "SOURCES", fda_fixtures.pins_for(payloads)):
                builder.build(root / "out.sqlite", cache)

    def test_a_changed_column_is_refused_because_a_dropped_column_is_a_dropped_fact(self):
        header = list(builder.ORANGE_BOOK_MEMBERS["products.txt"])
        header[0] = "Active_Ingredient"
        with self.assertRaisesRegex(SystemExit, "has columns"):
            self.build_with(fda_fixtures.payloads(orange_book={"header_override": tuple(header)}))

    def test_a_missing_table_is_refused(self):
        with self.assertRaisesRegex(SystemExit, "no TE.txt"):
            self.build_with(fda_fixtures.payloads(drugs_at_fda={"drop": ("TE.txt",)}))

    def test_an_application_listed_twice_is_refused_not_merged(self):
        with self.assertRaisesRegex(SystemExit, "listed twice"):
            self.build_with(fda_fixtures.payloads(drugs_at_fda={"applications_extra": (("900001", "NDA", "", "ALPHA"),)}))

    def test_a_code_page_that_lost_its_tables_is_refused(self):
        payloads = fda_fixtures.payloads()
        payloads["patent-use-codes.html"] = b"<html><body>moved</body></html>"
        with self.assertRaisesRegex(SystemExit, "code table"):
            self.build_with(payloads)


class PinnedDownload(unittest.TestCase):
    """The publisher replaces these files in place, so a download that no longer matches the pin stops the build and names the way out."""

    def setUp(self):
        self.payload = b"pinned FDA snapshot\n"
        self.spec = {"url": "https://example.invalid/fda", "bytes": len(self.payload), "sha256": hashlib.sha256(self.payload).hexdigest(), "label": "x"}

    def test_a_moved_input_stops_the_build_and_names_the_source_cache(self):
        with mock.patch.object(builder.urllib.request, "urlopen", return_value=io.BytesIO(b"a newer weekday file")):
            with self.assertRaisesRegex(SystemExit, "source-cache"):
                builder.download("drugsatfda.zip", self.spec)

    def test_the_cache_is_reverified_and_needs_no_network(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            (cache / self.spec["sha256"]).write_bytes(self.payload)
            with mock.patch.object(builder.urllib.request, "urlopen", side_effect=AssertionError("offline")):
                self.assertEqual(builder.download("x", self.spec, cache), self.payload)
                (cache / self.spec["sha256"]).write_bytes(b"modified cache")
                with self.assertRaisesRegex(SystemExit, "changed"):
                    builder.download("x", self.spec, cache)

    @mock.patch("build_fda_approvals.time.sleep")
    def test_a_transient_failure_is_retried_and_a_refusal_is_not(self, sleep):
        with mock.patch.object(builder.urllib.request, "urlopen", side_effect=[urllib.error.URLError(TimeoutError("slow")), io.BytesIO(self.payload)]) as request:
            self.assertEqual(builder.download("x", self.spec), self.payload)
        self.assertEqual(request.call_count, 2)
        error = urllib.error.HTTPError(self.spec["url"], 403, "refused", {}, io.BytesIO(b""))
        with mock.patch.object(builder.urllib.request, "urlopen", side_effect=error) as request:
            with self.assertRaises(urllib.error.HTTPError):
                builder.download("x", self.spec)
        request.assert_called_once()

    def test_the_source_receipt_names_exactly_the_pinned_inputs(self):
        self.assertTrue(builder.receipt_agrees())
        moved = {**builder.SOURCES, "drugsatfda.zip": {**builder.SOURCES["drugsatfda.zip"], "sha256": "0" * 64}}
        with mock.patch.object(builder, "SOURCES", moved):
            self.assertFalse(builder.receipt_agrees())

    def test_the_real_pins_are_four_fda_files_with_digests(self):
        self.assertEqual(set(builder.SOURCES), {"orange-book.zip", "drugsatfda.zip", "exclusivity-codes.html", "patent-use-codes.html"})
        for spec in builder.SOURCES.values():
            self.assertRegex(spec["sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue(spec["url"].startswith("https://www.fda.gov/") or spec["url"].startswith("https://www.accessdata.fda.gov/"))
            self.assertGreater(spec["bytes"], 100_000)


if __name__ == "__main__":
    unittest.main()
