"""The committed public data and the independent reference of the gene-expression-analysis numerical check are what their manifest says.

Run: python3 -m unittest discover -s evals/gene-expression-analysis -p 'test_*.py'

The statistics themselves are compared in `runtime/mcp/evimed-research/test/test_gene_expression.py`, which reads these files.
This keeps the record of where they came from honest: a fixture edited without the manifest, or a reference computed by
the module it is meant to check, fails here.
"""
import gzip
import hashlib
import json
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
MANIFEST = json.loads((HERE / "fixtures" / "source-manifest.json").read_text(encoding="utf-8"))


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Provenance(unittest.TestCase):
    def test_the_series_matrix_is_the_download_the_manifest_hashes(self):
        series = MANIFEST["series"]
        path = REPO / series["file"]
        self.assertEqual((sha256(path), path.stat().st_size), (series["sha256"], series["bytes"]))
        text = gzip.decompress(path.read_bytes()).decode("utf-8")
        self.assertIn('!Series_geo_accession\t"GSE5583"', text)
        self.assertIn('!Series_last_update_date\t"Feb 18 2018"', text, "the dates the manifest states are the file's own")

    def test_the_reduced_platform_record_is_what_the_manifest_says_was_kept(self):
        platform = MANIFEST["platform"]
        path = REPO / platform["reducedFile"]
        self.assertEqual((sha256(path), path.stat().st_size), (platform["reducedSha256"], platform["reducedBytes"]))
        text = gzip.decompress(path.read_bytes()).decode("utf-8").replace("\r\n", "\n")
        self.assertNotIn("!Platform_sample_id", text)
        self.assertNotIn("!Platform_series_id", text)
        table = text.split("!platform_table_begin\n", 1)[1].split("!platform_table_end", 1)[0].splitlines()
        self.assertEqual(table[0].split("\t"), ["ID", "GB_ACC", "Species Scientific Name", "Gene Title", "Gene Symbol", "ENTREZ_GENE_ID"])
        self.assertEqual(len(table) - 1, 12488)
        self.assertFalse(platform["fullRecord"]["committed"])

    def test_the_reference_files_are_the_ones_the_manifest_hashes_and_are_not_the_modules_own_output(self):
        reference = MANIFEST["reference"]
        self.assertEqual(sha256(REPO / reference["file"]), reference["sha256"])
        self.assertEqual(sha256(REPO / reference["summaryFile"]), reference["summarySha256"])
        script = (REPO / reference["script"]).read_text(encoding="utf-8")
        for needed in ("t.test", "p.adjust", 'method = "BH"', "var.equal = FALSE"):
            self.assertIn(needed, script)
        self.assertNotIn("gene_expression", script.replace("gene-expression", ""), "the reference reads nothing of the module it checks")
        rows = (REPO / reference["file"]).read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(rows), reference["topRows"] + 1)

    def test_the_manifest_records_the_terms_that_were_read_and_what_could_not_be(self):
        terms = MANIFEST["terms"]
        self.assertIn("places no restrictions", terms["statement"])
        self.assertIn("could not be read", terms["recordOwnTerms"])

    def test_the_briefs_name_real_public_series_and_the_capabilitys_required_input(self):
        briefs = json.loads((HERE / "briefs.json").read_text(encoding="utf-8"))
        self.assertEqual(briefs["capability"], "gene-expression-analysis")
        self.assertGreaterEqual(len(briefs["briefs"]), 3)
        for brief in briefs["briefs"]:
            self.assertRegex(brief["inputs"]["seriesAccession"], r"^GSE[1-9][0-9]{0,8}$")
            self.assertTrue(brief["mustDo"] and brief["mustNotDo"] and brief["gradedOn"])
        self.assertEqual(briefs["briefs"][0]["inputs"]["seriesAccession"], MANIFEST["series"]["accession"])


if __name__ == "__main__":
    unittest.main()
