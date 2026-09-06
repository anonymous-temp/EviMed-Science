"""Sparse evidence remains usable; citation and workspace validity stay required."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
PREFLIGHT = ROOT / "capabilities/research-topic-selection/scripts/preflight.py"


class ResearchTopicPreflightTests(unittest.TestCase):
    def run_preflight(self, root):
        result = subprocess.run([sys.executable, str(PREFLIGHT), "--workspace", str(root)],
                                capture_output=True, text=True, check=False)
        return result.returncode, json.loads(result.stdout)

    def write_sparse_package(self, root):
        (root / "research-topic-report.md").write_text(
            "# Agenda\nSearch scope: sparse rare-disease literature.\n"
            "## Q1 Candidate\nNovelty: unresolved; one small study, PMID 420001.\n")
        (root / "evidence-map.md").write_text(
            "| Prior study | PMID 420001 | https://pubmed.ncbi.nlm.nih.gov/420001/ | pubmed | subject | Q1 | no |\n")
        (root / "research-topic-run.json").write_text('{"status":"succeeded"}')
        (root / "research-portfolio.json").write_text(json.dumps({
            "schemaVersion": "1.0.0", "researchDirection": "Rare disease",
            "researchContext": {}, "candidates": [],
        }))
        (root / "evidence-records.json").write_text(json.dumps([{
            "id": "pubmed_420001", "pmid": "420001", "publicationStatus": "active",
            "statusCheckedAt": "2026-09-06T00:00:00Z", "statusSource": "PubMed",
        }]))

    def test_sparse_topic_counts_are_advisory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_sparse_package(root)
            code, result = self.run_preflight(root)
            self.assertEqual(code, 0, result)
            self.assertTrue(result["ok"])
            self.assertEqual(result["metrics"]["worksCited"], 1)
            self.assertTrue(result["warnings"])

    def test_unknown_citation_and_missing_url_still_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_sparse_package(root)
            (root / "research-topic-report.md").write_text("# Agenda\nPMID 999999\n")
            (root / "evidence-map.md").write_text("PMID 420001\n")
            code, result = self.run_preflight(root)
            self.assertEqual(code, 1)
            self.assertTrue(any("absent" in issue for issue in result["issues"]))
            self.assertTrue(any("URL" in issue for issue in result["issues"]))

    def test_required_artifact_cannot_escape_by_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_sparse_package(root)
            report = root / "research-topic-report.md"
            report.unlink()
            report.symlink_to(PREFLIGHT)
            code, result = self.run_preflight(root)
            self.assertEqual(code, 1)
            self.assertTrue(any("regular" in issue or "workspace" in issue for issue in result["issues"]))


if __name__ == "__main__":
    unittest.main()
