"""Tests for ingest_e.py (board E): a small zip of public-XML records becomes the index layout the platform's reader opens."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
import zipfile
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ingest_e  # noqa: E402


def record(nct, title, conditions=(), summary="", eligibility=None, gender="All", minimum="18 Years", maximum="N/A", status="Recruiting", phase="Phase 2",
           interventions=()):
    parts = [f"<clinical_study><id_info><nct_id>{nct}</nct_id></id_info><brief_title>{title}</brief_title><overall_status>{status}</overall_status>"]
    if summary:
        parts.append(f"<brief_summary><textblock>\n      {summary}&#xD;\n    </textblock></brief_summary>")
    parts.append(f"<phase>{phase}</phase><study_type>Interventional</study_type>")
    parts += [f"<condition>{value}</condition>" for value in conditions]
    parts += [f"<intervention><intervention_type>Drug</intervention_type><intervention_name>{value}</intervention_name></intervention>" for value in interventions]
    if eligibility is not None:
        parts.append(f"<eligibility><criteria><textblock>\n        {eligibility}\n      </textblock></criteria><gender>{gender}</gender>"
                     f"<minimum_age>{minimum}</minimum_age><maximum_age>{maximum}</maximum_age></eligibility>")
    parts.append("</clinical_study>")
    return "".join(parts).encode()


def make_zip(path, members):
    with zipfile.ZipFile(path, "w") as bundle:
        for name, data in members.items():
            bundle.writestr(name, data)


ELIGIBILITY = "Inclusion Criteria:\n\n          -  Age 18 or older\n          -  Histologic diagnosis of lung cancer\n\n        Exclusion Criteria:\n\n          -  Pregnant"
MEMBERS = {
    "snap/NCT0000xxxx/NCT00000001.xml": record("NCT00000001", "A study of osimertinib in lung cancer", ["Lung Cancer", "EGFR Mutation"],
                                               "Tests osimertinib.", ELIGIBILITY, interventions=["Osimertinib", "Placebo"]),
    "snap/NCT0000xxxx/NCT00000002.xml": record("NCT00000002", "Aspirin for migraine", ["Migraine"], "Aspirin versus placebo.", None, gender="Female"),
    "snap/NCT0000xxxx/NCT00000003.xml": record("NCT00000003", "Insulin pump trial", ["Diabetes"], "", "Inclusion Criteria:\n\n  - Type 1 diabetes", maximum="65 Years"),
    "snap/NCT0000xxxx/notes.xml": b"<other><x/></other>",
    "snap/NCT0000xxxx/NCT00000009.xml": b"<clinical_study><broken",
    "snap/NCT0000xxxx/readme.txt": b"not a record",
}


class Ingest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.dir = Path(self.scratch.name)
        self.zip = self.dir / "part1.zip"
        make_zip(self.zip, MEMBERS)
        self.index = self.dir / "index"

    def tearDown(self):
        self.scratch.cleanup()

    def add(self, name="part1.zip", **extra):
        return ingest_e.add(self.dir / name, self.index, "trec-ct-test", 0.0, **extra)

    def test_records_become_the_reader_layout(self):
        result = self.add()
        self.assertEqual((result["status"], result["documents"], result["invalid"]), ("ingested", 3, 2))
        db = sqlite3.connect(self.index / "trec-ct-test.sqlite")
        self.assertEqual(db.execute("SELECT count(*) FROM documents").fetchone()[0], 3)
        row = db.execute("SELECT nct_id, xml_sha256, payload_sha256, payload, archive FROM documents WHERE nct_id='NCT00000001'").fetchone()
        raw = MEMBERS["snap/NCT0000xxxx/NCT00000001.xml"]
        payload_bytes = zlib.decompress(row[3])
        self.assertEqual(row[1], hashlib.sha256(raw).hexdigest())
        self.assertEqual(row[2], hashlib.sha256(payload_bytes).hexdigest())
        payload = json.loads(payload_bytes)
        self.assertEqual(payload["xml_sha256"], row[1])
        self.assertEqual(row[4], "part1.zip")
        self.assertEqual(payload["title"], "A study of osimertinib in lung cancer")
        self.assertEqual(payload["condition"].split("\n"), ["Lung Cancer", "EGFR Mutation"])
        self.assertEqual(payload["interventions"].split("\n"), ["Osimertinib", "Placebo"])
        self.assertEqual((payload["gender"], payload["minimum_age"], payload["maximum_age"], payload["overall_status"], payload["phase"]),
                         ("All", "18 Years", "N/A", "Recruiting", "Phase 2"))
        self.assertEqual(payload["summary"], "Tests osimertinib.")  # the XML's indentation and the carriage return are gone
        self.assertEqual(payload["detailed_description"], "")
        self.assertTrue(payload["eligibility"].startswith("Inclusion Criteria:\n\n  -  Age 18 or older"))
        self.assertIn("\n\nExclusion Criteria:\n", payload["eligibility"])
        # A record with no eligibility module is kept, with empty eligibility text and no stated ages.
        none = json.loads(zlib.decompress(db.execute("SELECT payload FROM documents WHERE nct_id='NCT00000002'").fetchone()[0]))
        self.assertEqual((none["eligibility"], none["minimum_age"]), ("", ""))

    def test_the_full_text_index_finds_by_bm25(self):
        self.add()
        db = sqlite3.connect(self.index / "trec-ct-test.sqlite")
        hits = db.execute("SELECT d.nct_id FROM terms JOIN documents d ON d.id=terms.rowid WHERE terms MATCH ? ORDER BY bm25(terms), d.nct_id", ('"osimertinib" OR "migraine"',)).fetchall()
        self.assertEqual({row[0] for row in hits}, {"NCT00000001", "NCT00000002"})
        # The index is contentless: the eligibility text is searchable but the detailed description column is empty.
        self.assertEqual(db.execute("SELECT count(*) FROM terms WHERE terms MATCH ?", ('"pregnant"',)).fetchone()[0], 1)
        self.assertEqual(db.execute("SELECT count(*) FROM terms WHERE terms MATCH ?", ('description:"aspirin"',)).fetchone()[0], 0)

    def test_a_zip_already_in_is_skipped_and_nothing_is_added_twice(self):
        self.add()
        again = self.add()
        self.assertEqual(again["status"], "already_ingested")
        db = sqlite3.connect(self.index / "trec-ct-test.sqlite")
        self.assertEqual(db.execute("SELECT count(*) FROM documents").fetchone()[0], 3)
        # The same trial in a second zip is a duplicate and is not taken again.
        make_zip(self.dir / "part2.zip", {"x/NCT00000001.xml": MEMBERS["snap/NCT0000xxxx/NCT00000001.xml"],
                                          "x/NCT00000004.xml": record("NCT00000004", "Another", ["Asthma"], "s", "Inclusion Criteria:\n\n  - x")})
        second = self.add("part2.zip")
        self.assertEqual((second["documents"], second["duplicates"]), (1, 1))

    def test_a_failed_zip_leaves_nothing_half_written(self):
        broken = self.dir / "bad.zip"
        make_zip(broken, {"a/NCT00000007.xml": record("NCT00000007", "Seven", ["Cough"], "s", "Inclusion Criteria:\n\n  - x")})
        data = bytearray(broken.read_bytes())
        data[45] ^= 0xFF  # flip a byte inside the stored record: its CRC no longer matches
        broken.write_bytes(bytes(data))
        with self.assertRaises(Exception):
            ingest_e.add(broken, self.index, "trec-ct-test", 0.0)
        db = sqlite3.connect(self.index / "trec-ct-test.sqlite")
        self.assertEqual(db.execute("SELECT count(*) FROM documents").fetchone()[0], 0)
        self.assertEqual(db.execute("SELECT count(*) FROM terms WHERE terms MATCH ?", ('"cough"',)).fetchone()[0], 0)

    def test_the_disk_floor_stops_before_reading(self):
        with self.assertRaises(SystemExit):
            ingest_e.add(self.zip, self.index, "trec-ct-test", 1e9)

    def test_seal_counts_hashes_and_writes_the_manifest(self):
        self.add()
        with self.assertRaises(SystemExit):
            ingest_e.seal(self.index, "trec-ct-test", "2021-04-27", None, 4, False, 0.0)
        sealed = ingest_e.seal(self.index, "trec-ct-test", "2021-04-27", None, 3, True, 0.0)
        manifest = json.loads((self.index / "collection.json").read_text())
        self.assertEqual(manifest, {"version": 1, "id": "trec-ct-test", "sourceVersion": "trec-ct-test-snapshot-2021-04-27", "snapshotDate": "2021-04-27",
                                    "sourceFormat": "clinicaltrials-xml", "databasePath": "trec-ct-test.sqlite",
                                    "databaseSha256": hashlib.sha256((self.index / "trec-ct-test.sqlite").read_bytes()).hexdigest()})
        self.assertEqual(sealed["documents"], 3)
        self.assertFalse(list(self.index.glob("*-wal")) or list(self.index.glob("*-journal")))
        record_ = json.loads((self.index / "provenance.json").read_text())
        self.assertEqual(record_["zips"]["part1.zip"]["sha256"], hashlib.sha256(self.zip.read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
