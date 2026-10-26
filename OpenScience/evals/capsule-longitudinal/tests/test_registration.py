"""The harness is registered in evals/acceptance-ledger.json beside the other suites, and the row says what the scenario table says."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import scenarios as sce  # noqa: E402

LEDGER = json.loads((HERE.parent / "acceptance-ledger.json").read_text(encoding="utf-8"))


class Registration(unittest.TestCase):
    def test_the_ledger_row_matches_the_scenario_table(self):
        rows = [r for r in LEDGER["suites"] if r["id"] == "capsule-longitudinal"]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["evalHarness"], "evals/capsule-longitudinal")
        self.assertTrue((HERE.parents[1] / row["evalHarness"]).is_dir())
        self.assertEqual(row["caseCount"], len(sce.SCENARIOS))
        self.assertEqual(sorted(row["scenarios"]), sorted(sid for sid, _, _ in sce.SCENARIOS))

    def test_the_other_suites_are_untouched(self):
        self.assertEqual(LEDGER["schemaVersion"], 1)
        self.assertTrue({"general-tasks", "capsule-longitudinal", "remembered-format", "follow-up-judge"} <= {r["id"] for r in LEDGER["suites"]})


if __name__ == "__main__":
    unittest.main()
