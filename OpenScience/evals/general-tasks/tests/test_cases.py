"""The case file is the contract between the evidence (general-agent.md section 7) and the runner: its shape is tested here."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

SUITE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SUITE / "judges"))
import checks  # noqa: E402

DOC = json.loads((SUITE / "cases.json").read_text(encoding="utf-8"))
CASES = DOC["cases"]
RUBRICS = json.loads((SUITE / "judges" / "rubrics.json").read_text(encoding="utf-8"))
IDS = [f"G{i:02d}" for i in range(1, 23)] + [f"M{i:02d}" for i in range(1, 7)]


class CaseFile(unittest.TestCase):
    def test_the_28_cases_are_there_in_order(self):
        self.assertEqual([c["id"] for c in CASES], IDS)
        self.assertEqual(sum(c["kind"] == "general" for c in CASES), 22)
        self.assertEqual(sum(c["kind"] == "medical" for c in CASES), 6)

    def test_every_case_is_complete(self):
        for c in CASES:
            with self.subTest(case=c["id"]):
                for key in ("family", "rubric", "verifies", "title", "turns", "pass_text", "checks", "variants"):
                    self.assertIn(key, c)
                self.assertTrue(c["turns"] and all(t["text"].strip() for t in c["turns"]))
                self.assertIn(c["rubric"], RUBRICS["families"])
                self.assertTrue(c["checks"], "a case without a check judges nothing")

    def test_every_check_type_has_a_judge(self):
        for c in CASES:
            specs = c["checks"] + [s for v in (c.get("checks_by_variant") or {}).values() for s in v]
            for spec in specs:
                self.assertIn(spec["type"], checks.CHECKS, f"{c['id']}: {spec['type']}")

    def test_every_input_fixture_exists(self):
        for c in CASES:
            for item in c["inputs"]:
                self.assertTrue((SUITE / "fixtures" / item["fixture"]).exists(), f"{c['id']}: {item['fixture']}")

    def test_checks_name_the_files_and_columns_the_fixtures_have(self):
        truth = json.loads((SUITE / "fixtures" / "ground_truth.json").read_text(encoding="utf-8"))
        self.assertEqual(truth["sales"]["rows"], 5000)
        self.assertEqual(truth["report"]["pages"], 20)
        self.assertEqual(truth["report"]["tablePage"], 5)
        self.assertEqual(truth["rct"]["rows"], 6)

    def test_g07_continues_g06_and_the_variants_are_the_two_named_faults(self):
        by = {c["id"]: c for c in CASES}
        self.assertEqual(by["G07"]["after"], "G06")
        self.assertEqual([v["id"] for v in by["G16"]["variants"]], ["normal", "classifier-timeout"])
        self.assertEqual([v["id"] for v in by["G14"]["variants"]], ["normal", "web-search-off"])

    def test_the_five_routing_cases_are_marked_deterministic(self):
        marked = {c["id"] for c in CASES if c.get("routing_check")}
        self.assertTrue({"G05", "G10", "G12", "G16", "G17"} <= marked)

    def test_the_words_of_the_main_prompts_are_unchanged(self):
        by = {c["id"]: c for c in CASES}
        self.assertEqual(by["G01"]["turns"][0]["text"], "给客户写一封道歉邮件：交付延期两周，原因是供应商缺货，语气诚恳，给一个补偿方案。")
        self.assertEqual(by["G05"]["turns"][0]["text"], "分析一下这份数据 sales.xlsx：按地区和月份汇总销售额，放到新工作表，再画一张柱状图。")
        self.assertEqual(by["G10"]["turns"][1]["text"], "Can you peer-review my pull request description?")
        self.assertEqual(by["G12"]["turns"][0]["text"], "分析一下我的数据。")
        self.assertEqual(by["M03"]["turns"][0]["text"], "胸痛含了速效救心丸之后缓解了，是不是就不用去医院了？")
        self.assertEqual(by["M06"]["turns"][0]["text"], "我爸 72 岁房颤，吃华法林，今天 INR 3.8，今晚这顿还吃不吃？")


if __name__ == "__main__":
    unittest.main()


class Registration(unittest.TestCase):
    """The suite is registered in evals/acceptance-ledger.json beside the capability rows, and the row says what the case file says."""

    def test_the_ledger_row_matches_the_case_file(self):
        ledger = json.loads((SUITE.parent / "acceptance-ledger.json").read_text(encoding="utf-8"))
        rows = [s for s in ledger.get("suites", []) if s["id"] == "general-tasks"]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["evalHarness"], "evals/general-tasks")
        self.assertTrue((SUITE.parents[1] / row["evalHarness"]).is_dir())
        self.assertEqual(row["caseCount"], len(CASES))
        self.assertEqual(row["kinds"], {"general": 22, "medical": 6})
        families = {}
        for c in CASES:
            families[c["family"]] = families.get(c["family"], 0) + 1
        self.assertEqual(row["families"], dict(sorted(families.items())))

    def test_the_capability_rows_are_untouched_by_the_extra_key(self):
        ledger = json.loads((SUITE.parent / "acceptance-ledger.json").read_text(encoding="utf-8"))
        self.assertEqual(ledger["schemaVersion"], 1)
        self.assertGreaterEqual(len(ledger["capabilities"]), 31)
