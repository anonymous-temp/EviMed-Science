"""A paper's supplementary files: declared by the article, sent as a zip that may be cut short, verified file by file.

The article's declarations are read from the real PMC XML recorded 2026-10-04
(`wire/europepmc__fulltext_PMC6454835.xml`). The archives are constructed here, in
the two layouts the live service produces and the one Python's zipfile writes: sizes in
the local header, and sizes after the data (flag 0x0808, which is what Europe PMC's
streamed zip uses). Their bytes are not the real files, so a declared md5 is computed
from the constructed bytes where a test needs a file to verify.
"""

import hashlib
import io
import pathlib
import struct
import sys
import unittest
import zipfile
import zlib
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import open_access_supplements as supplements  # noqa: E402
import public_sources  # noqa: E402
import source_outcome  # noqa: E402
import source_transport as transport  # noqa: E402
import wire_fixtures as wire  # noqa: E402


class Unseekable(io.RawIOBase):
    """A write-only stream: zipfile then writes data descriptors, as a streaming service does."""

    def __init__(self):
        self.parts = []

    def writable(self):
        return True

    def write(self, data):
        self.parts.append(bytes(data))
        return len(data)

    def value(self):
        return b"".join(self.parts)


def build_zip(files, streamed=True, compression=zipfile.ZIP_DEFLATED):
    sink = Unseekable() if streamed else io.BytesIO()
    with zipfile.ZipFile(sink, "w", compression=compression) as archive:
        for name, payload in files:
            archive.writestr(name, payload)
    return sink.value() if streamed else sink.getvalue()


def md5(payload):
    return hashlib.md5(payload).hexdigest()


TABLE = b"id,age,outcome\n" + b"\n".join(b"%d,%d,%d" % (index, 40 + index % 30, index % 2) for index in range(400)) + b"\n"
SHEET = b"%PDF-1.4 " + bytes(range(256)) * 40
FIGURE = b"GIF89a" + b"\x00" * 300


class DeclaredTests(unittest.TestCase):
    def test_the_real_article_declares_ten_files_with_their_digests(self):
        found = supplements.declared_supplements(wire.body("europepmc__fulltext_PMC6454835.xml"))
        self.assertEqual(len(found["files"]), 10)
        first = found["files"][0]
        self.assertEqual(
            (first["name"], first["sizeBytes"], first["md5"], first["mimeType"], first["label"]),
            ("Data_Sheet_1.PDF", 318682, "24d51e4f342957e3b1bced5d6e4b3dab", "application/pdf", "APPENDIX 1"),
        )
        self.assertEqual(first["id"], "SM1")
        self.assertIn("Tables of demography", first["caption"])
        self.assertEqual(
            sorted(entry["name"] for entry in found["files"]),
            sorted("Data_Sheet_%d.PDF" % number for number in range(1, 11)),
        )
        self.assertTrue(all(len(entry["md5"]) == 32 for entry in found["files"]))
        self.assertEqual(found["links"], [{"label": None, "url": "https://www.frontiersin.org/articles/10.3389/fphys.2018.01776/full#supplementary-material"}])

    def test_an_article_that_declares_nothing_or_is_not_xml_declares_nothing(self):
        self.assertEqual(supplements.declared_supplements(b"<article><body><p>text</p></body></article>"), {"files": [], "links": []})
        self.assertEqual(supplements.declared_supplements(b"not xml at all"), {"files": [], "links": []})

    def test_a_field_the_article_does_not_give_is_absent_never_guessed(self):
        xml = (b'<article xmlns:xlink="http://www.w3.org/1999/xlink"><body><supplementary-material id="S1"><label>Table S1</label>'
               b'<media xlink:href="data/table_s1.xlsx"/></supplementary-material></body></article>')
        (entry,) = supplements.declared_supplements(xml)["files"]
        self.assertEqual(entry, {"id": "S1", "label": "Table S1", "name": "table_s1.xlsx"})


class ZipReadingTests(unittest.TestCase):
    FILES = [("Table_S1.csv", TABLE), ("Data_Sheet_1.PDF", SHEET), ("fig-g001.gif", FIGURE)]

    def test_a_streamed_archive_with_data_descriptors_and_a_normal_one_read_the_same_as_zipfile(self):
        for streamed in (True, False):
            with self.subTest(streamed=streamed):
                data = build_zip(self.FILES, streamed=streamed)
                entries, skipped, ended = supplements.read_zip(data)
                self.assertEqual(ended, "end_of_archive")
                self.assertEqual(skipped, [])
                with zipfile.ZipFile(io.BytesIO(data)) as reference:
                    self.assertEqual({entry["name"]: entry["payload"] for entry in entries}, {name: reference.read(name) for name in reference.namelist()})
                self.assertTrue(all(entry["crcOk"] is True for entry in entries))
        # Europe PMC's flag: 0x0808, sizes after the data.
        flags = struct.unpack_from("<H", build_zip(self.FILES, streamed=True), 6)[0]
        self.assertEqual(flags & 0x08, 0x08)

    def test_a_download_cut_short_still_yields_every_entry_that_finished(self):
        data = build_zip(self.FILES, streamed=True)
        second = data.index(b"PK\x03\x04", 4)
        third = data.index(b"PK\x03\x04", second + 4)
        cut_inside_third = data[:third + 44]
        entries, skipped, ended = supplements.read_zip(cut_inside_third)
        self.assertEqual([entry["name"] for entry in entries], ["Table_S1.csv", "Data_Sheet_1.PDF"])
        self.assertEqual(ended, "cut_in_entry")
        self.assertTrue(all(entry["crcOk"] is True for entry in entries))
        # Cut before the first descriptor is complete: the entry's data is whole, its CRC unknown.
        first_end = data.index(b"PK\x07\x08")
        entries, _skipped, ended = supplements.read_zip(data[:first_end + 6])
        self.assertEqual([(entry["name"], entry["crcOk"]) for entry in entries], [("Table_S1.csv", None)])
        # Cut inside a header, before any entry.
        self.assertEqual(supplements.read_zip(data[:20])[2], "cut_in_header")
        self.assertEqual(supplements.read_zip(b"")[2:], ("end_of_data",))

    def test_a_corrupt_entry_is_marked_by_its_own_crc(self):
        data = bytearray(build_zip(self.FILES[:1], streamed=True))
        descriptor = data.index(b"PK\x07\x08")
        data[descriptor + 4] ^= 0xFF
        (entry,), _skipped, ended = supplements.read_zip(bytes(data))
        self.assertEqual((entry["name"], entry["crcOk"], ended), ("Table_S1.csv", False, "end_of_archive"))

    def test_an_entry_larger_than_the_bound_is_walked_past_not_inflated_into_memory(self):
        bomb = b"\x00" * 200_000
        data = build_zip([("big.bin", bomb), ("small.csv", TABLE)], streamed=True)
        with mock.patch.object(supplements, "MAX_ENTRY_BYTES", 10_000):
            entries, skipped, ended = supplements.read_zip(data)
        self.assertEqual([entry["name"] for entry in entries], ["small.csv"])
        self.assertEqual([item["zipPath"] for item in skipped], ["big.bin"])
        self.assertIn("larger_than_10000", skipped[0]["reason"])
        self.assertEqual(ended, "end_of_archive")

    def test_directories_are_not_files_and_paths_are_flattened_to_a_name(self):
        data = build_zip([("sub/", b""), ("sub/inner.csv", TABLE), ("../../evil.txt", b"x")], streamed=False)
        entries, _skipped, _ended = supplements.read_zip(data)
        self.assertEqual(sorted(entry["name"] for entry in entries), ["evil.txt", "inner.csv"])
        self.assertEqual(sorted(entry["zipPath"] for entry in entries), ["../../evil.txt", "sub/inner.csv"])

    def test_what_is_not_a_zip_is_not_walked(self):
        self.assertEqual(supplements.read_zip(b"<html>not a zip</html>")[2], "unrecognised")

    def test_stored_entries_are_read(self):
        data = build_zip([("plain.txt", b"stored bytes")], streamed=False, compression=zipfile.ZIP_STORED)
        (entry,), _skipped, ended = supplements.read_zip(data)
        self.assertEqual((entry["payload"], ended), (b"stored bytes", "end_of_archive"))


class ReconcileTests(unittest.TestCase):
    def entries(self, files):
        found, _skipped, ended = supplements.read_zip(build_zip(files, streamed=True))
        return found, ended

    def test_a_file_whose_md5_matches_the_article_is_the_file_and_one_that_does_not_is_kept_and_labelled(self):
        found, ended = self.entries([("Table_S1.csv", TABLE), ("Data_Sheet_1.PDF", SHEET)])
        declared = [
            {"name": "Table_S1.csv", "md5": md5(TABLE), "sizeBytes": len(TABLE), "id": "S1", "label": "Table S1"},
            {"name": "Data_Sheet_1.PDF", "md5": "0" * 32, "sizeBytes": len(SHEET)},
        ]
        preserved, files, left_out = supplements.reconcile(declared, found, [], complete=True, ended=ended)
        by_name = {record["name"]: record for record in files}
        self.assertEqual((by_name["Table_S1.csv"]["status"], by_name["Table_S1.csv"]["md5Verified"]), ("verified", True))
        self.assertEqual((by_name["Data_Sheet_1.PDF"]["status"], by_name["Data_Sheet_1.PDF"]["md5Verified"]), ("md5_mismatch", False))
        self.assertEqual(sorted(preserved), ["Data_Sheet_1.PDF", "Table_S1.csv"], "a mismatch is kept: it is labelled, never silently dropped")
        self.assertEqual(left_out, [])
        self.assertEqual(by_name["Table_S1.csv"]["sha256"], hashlib.sha256(TABLE).hexdigest())

    def test_an_article_figure_is_not_a_supplement_but_an_undeclared_data_file_is_kept(self):
        found, ended = self.entries([("fig-g001.gif", FIGURE), ("extra_data.csv", TABLE)])
        preserved, files, left_out = supplements.reconcile([], found, [], complete=True, ended=ended)
        self.assertEqual(sorted(preserved), ["extra_data.csv"])
        self.assertEqual(files[0]["status"], "undeclared")
        self.assertEqual([(item["name"], item["status"]) for item in left_out], [("fig-g001.gif", "article_figure")])
        # A declared image IS a supplement.
        preserved, _files, left_out = supplements.reconcile([{"name": "fig-g001.gif"}], found, [], complete=True, ended=ended)
        self.assertIn("fig-g001.gif", preserved)
        self.assertEqual(left_out, [])

    def test_a_declared_file_that_did_not_arrive_says_why(self):
        found, _ended = self.entries([("Table_S1.csv", TABLE)])
        declared = [{"name": "Table_S1.csv"}, {"name": "Data_Sheet_2.PDF", "md5": "1" * 32}]
        _preserved, files, _left_out = supplements.reconcile(declared, found, [], complete=False, ended="cut_in_entry")
        missing = [record for record in files if record["status"] == "not_received"]
        self.assertEqual([record["name"] for record in missing], ["Data_Sheet_2.PDF"])
        self.assertIn("download ended before this file (cut_in_entry)", missing[0]["reason"])
        _preserved, files, _left_out = supplements.reconcile(declared, found, [], complete=True, ended="end_of_archive")
        self.assertIn("does not contain it", [record for record in files if record["status"] == "not_received"][0]["reason"])

    def test_a_corrupt_entry_is_never_preserved(self):
        data = bytearray(build_zip([("a.csv", TABLE)], streamed=True))
        data[data.index(b"PK\x07\x08") + 4] ^= 0xFF
        found, _skipped, ended = supplements.read_zip(bytes(data))
        preserved, files, left_out = supplements.reconcile([], found, [], complete=True, ended=ended)
        self.assertEqual((preserved, [record for record in files if record["status"] != "not_received"]), ({}, []))
        self.assertEqual(left_out[0]["status"], "corrupt")

    def test_names_that_collide_or_are_the_captures_own_become_distinct_plain_names(self):
        found, ended = self.entries([("a/data.csv", TABLE), ("b/data.csv", TABLE + b"1\n"), ("capture.json", b"{}"), (".hidden", b"x")])
        preserved, files, _left_out = supplements.reconcile([], found, [], complete=True, ended=ended)
        self.assertEqual(sorted(preserved), ["capture-2.json", "data-2.csv", "data.csv", "hidden"])
        self.assertTrue(all("/" not in name for name in preserved))

    def test_the_manifest_is_the_same_bytes_for_the_same_supplements(self):
        found, ended = self.entries([("Table_S1.csv", TABLE)])
        declared = [{"name": "Table_S1.csv", "md5": md5(TABLE)}]
        args = ("PMC6454835", "PMC6454835.1", declared)
        first = supplements.manifest_bytes(*args, *supplements.reconcile(declared, found, [], complete=True, ended=ended)[1:], complete=True, ended=ended)
        second = supplements.manifest_bytes(*args, *supplements.reconcile(declared, found, [], complete=True, ended=ended)[1:], complete=True, ended=ended)
        self.assertEqual(first, second)
        self.assertNotIn(b"retrievedAt", first)


class RetrieveTests(unittest.TestCase):
    def retrieve(self, response):
        door = mock.Mock(return_value=response)
        with mock.patch.object(public_sources, "_open_remote", door), mock.patch.object(public_sources, "_gateway_settings", return_value=None):
            return supplements.retrieve("PMC6454835", deadline=transport.Deadline(60), max_bytes=16 * 1024 * 1024), door

    def test_a_zip_is_returned_as_a_download(self):
        archive = build_zip([("Table_S1.csv", TABLE)])
        (download, outcome), door = self.retrieve(wire.Response(archive, "application/zip"))
        self.assertEqual((download.complete, download.received, outcome), (True, len(archive), None))
        self.assertEqual(door.call_args.args[0], "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC6454835/supplementaryFiles")

    def test_an_article_that_is_not_open_access_is_a_refusal_not_an_empty_list(self):
        # Recorded: HTTP 200 and an errorBean in XML.
        with self.assertRaises(source_outcome.SourceError) as raised:
            self.retrieve(wire.ok("europepmc__supplementary_not_open_access.xml"))
        self.assertEqual((raised.exception.state, raised.exception.reason, raised.exception.code), ("denied", "not_open_access", "source_access_denied"))
        self.assertIn("not an open-access article", str(raised.exception))
        self.assertIs(raised.exception.retryable, False)

    def test_an_open_access_article_with_no_supplements_is_no_results(self):
        # Recorded: HTTP 200 and an empty fullTextXMLBean.
        (download, outcome), _door = self.retrieve(wire.ok("europepmc__supplementary_none.xml"))
        self.assertIsNone(download)
        self.assertEqual((outcome["state"], outcome["reason"]), ("no_results", "no_supplementary_files"))

    def test_an_archive_that_sent_nothing_before_the_deadline_is_a_timeout(self):
        with self.assertRaises(source_outcome.SourceError) as raised:
            self.retrieve(wire.Response(b"", "application/zip"))
        self.assertEqual(raised.exception.state, "unavailable")
        self.assertEqual(raised.exception.reason, "empty_answer")

    def test_xml_that_is_neither_a_refusal_nor_an_empty_answer_is_unreadable(self):
        with self.assertRaises(source_outcome.SourceError) as raised:
            self.retrieve(wire.Response(b"<other/>", "application/xml"))
        self.assertEqual((raised.exception.state, raised.exception.reason), ("unavailable", "unexpected_answer"))
        with self.assertRaises(source_outcome.SourceError) as raised:
            self.retrieve(wire.Response(b'<errorBean><errMsg>quota</errMsg></errorBean>', "application/xml"))
        self.assertEqual(raised.exception.reason, "error_bean")


if __name__ == "__main__":
    unittest.main()
