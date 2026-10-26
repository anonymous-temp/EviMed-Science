"""Unit tests for the remembered-format instrument: case loading and scoring with stubbed model replies. No model, no network."""
from __future__ import annotations

import contextlib
import copy
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import remembered_format as rf  # noqa: E402
import run as runner  # noqa: E402

CASES = rf.load_cases()
TEXTS = {"persona": "PERSONA", "guidance": "GUIDANCE sentence-A. tail"}
BY_ID = {c["id"]: c for c in CASES}


def arm(**extra):
    return {"name": "current", "persona": TEXTS["persona"], "guidance": TEXTS["guidance"], "methodReplace": [], "methodAppend": "", **extra}


class Cases(unittest.TestCase):
    def test_the_thirty_pairs_are_well_shaped(self):
        self.assertEqual(len(CASES), 30)
        self.assertEqual([i for c in CASES for i in rf.case_issues(c)], [])
        self.assertEqual(len({c["id"] for c in CASES}), 30)

    def test_the_genres_are_the_ones_people_ask_for(self):
        genres = {c["genre"] for c in CASES}
        for wanted in ("周报", "月报", "会议纪要", "邮件回复", "项目进展", "论文摘要", "基金申请段落", "投稿 cover letter", "简历段落", "课题组周会汇报", "实验记录小结", "培训总结"):
            self.assertIn(wanted, genres)
        english = [c for c in CASES if c["lang"] == "en"]
        self.assertTrue(4 <= len(english) <= 10)

    def test_the_layouts_differ_in_how_they_are_remembered(self):
        with_method = [c for c in CASES if c.get("method")]
        self.assertTrue(10 <= len(with_method) < 30, "some layouts are a learned method, the others only a remembered preference")

    def test_every_pair_withholds_something_the_layout_names(self):
        for case in CASES:
            self.assertTrue(set(case["partial"]["missing"]) <= set(case["places"]))
            self.assertNotEqual(case["full"]["ask"], case["partial"]["ask"])

    def test_a_malformed_case_is_reported_by_name(self):
        broken = copy.deepcopy(BY_ID["weekly-report"])
        broken["partial"]["given"].append(["not in the ask"])
        broken["partial"]["missing"] = ["not a place"]
        broken["places"] = ["结论", "nowhere"]
        text = "\n".join(rf.case_issues(broken))
        self.assertIn("no alternative of ['not in the ask'] is in the ask", text)
        self.assertIn("the missing place 'not a place' is not one of the layout's places", text)
        self.assertIn("the place 'nowhere' is named by neither the memory nor the method", text)


class Request(unittest.TestCase):
    def test_a_method_is_met_as_a_read_exchange_with_the_reasoning_the_kernel_needs(self):
        case = BY_ID["weekly-report"]
        messages = rf.build_messages(case, "partial", arm())
        self.assertEqual([m["role"] for m in messages], ["system", "user", "user", "assistant", "tool"])
        self.assertTrue(messages[0]["content"].startswith("PERSONA\n\nGUIDANCE"))
        self.assertIn("## Skills", messages[0]["content"])
        self.assertIn(rf.METHOD_PATH, messages[0]["content"])
        self.assertIn("<openviking-context>", messages[1]["content"])
        self.assertEqual(messages[2]["content"], case["partial"]["ask"])
        self.assertTrue(messages[3]["reasoning_content"])
        self.assertEqual(messages[3]["tool_calls"][0]["function"]["name"], "read")
        self.assertIn("每条先写结论，再写依据。", messages[4]["content"])
        body = rf.request_body(case, "partial", arm(), "m")
        self.assertEqual(body["tools"][0]["function"]["name"], "read")

    def test_a_preference_alone_has_neither_a_skills_line_nor_a_tool_exchange(self):
        case = BY_ID["email-reply"]
        messages = rf.build_messages(case, "full", arm())
        self.assertEqual([m["role"] for m in messages], ["system", "user", "user"])
        self.assertNotIn("## Skills", messages[0]["content"])
        self.assertNotIn("tools", rf.request_body(case, "full", arm(), "m"))
        self.assertEqual(messages[2]["content"], case["full"]["ask"])

    def test_a_variant_edits_the_production_texts_and_a_miss_is_an_error(self):
        edited = rf.apply_variant(TEXTS, CASES, {"name": "v", "guidanceReplace": [["sentence-A.", "sentence-B."]], "methodReplace": [["每条先写结论，再写依据。", "每条先写结论。"]]})
        self.assertIn("sentence-B.", edited["guidance"])
        messages = rf.build_messages(BY_ID["weekly-report"], "full", edited)
        self.assertIn("每条先写结论。", messages[4]["content"])
        self.assertNotIn("再写依据", messages[4]["content"])
        with self.assertRaisesRegex(ValueError, "guidanceReplace matches nothing"):
            rf.apply_variant(TEXTS, CASES, {"name": "v", "guidanceReplace": [["absent", "x"]]})
        with self.assertRaisesRegex(ValueError, "methodReplace matches no case"):
            rf.apply_variant(TEXTS, CASES, {"name": "v", "methodReplace": [["absent", "x"]]})

    def test_arms_come_from_current_and_a_variant_file(self):
        directory = Path(tempfile.mkdtemp())
        try:
            path = directory / "v.json"
            path.write_text(json.dumps({"arms": [{"name": "a", "guidanceReplace": [["sentence-A.", "x"]]}, {"name": "b"}]}), encoding="utf-8")
            arms = rf.arms_from(TEXTS, CASES, ["current", "a"], path)
            self.assertEqual(list(arms), ["current", "a"])
            self.assertIn("x", arms["a"]["guidance"])
            with self.assertRaisesRegex(ValueError, "no such arm"):
                rf.arms_from(TEXTS, CASES, ["current", "zzz"], path)
        finally:
            shutil.rmtree(directory)

    def test_the_shipped_variant_files_apply_to_the_tree_under_test(self):
        texts = rf.load_texts()
        for name in ("pre-2026-10-24.json", "example-method-conditional.json"):
            data = json.loads((HERE / "variants" / name).read_text(encoding="utf-8"))
            edited = rf.apply_variant(texts, CASES, data)
            self.assertNotEqual((edited["guidance"], edited["methodReplace"]), (texts["guidance"], []), name)
        pre = rf.apply_variant(texts, CASES, json.loads((HERE / "variants" / "pre-2026-10-24.json").read_text(encoding="utf-8")))
        self.assertNotIn("不替用户补写", pre["guidance"])

    def test_the_texts_are_read_from_the_checkout(self):
        texts = rf.load_texts()
        self.assertTrue(texts["persona"].startswith("You are an AI agent powered by DeepSeek Harness."))
        self.assertIn("EviMed 的工作助手", texts["persona"])
        self.assertIn("<evimed-orchestration>", texts["guidance"])


class Scoring(unittest.TestCase):
    def test_a_notation_number_is_not_an_added_number(self):
        case = BY_ID["weekly-report"]
        reply = "HR 0.82（95% CI 0.70–0.96），eGFR 以 mL/min/1.73 m² 计；95%的患者完成随访，1.73 倍"
        self.assertEqual(rf.added_numbers(case, "partial", reply), ["0.82", "0.70", "0.96", "95%", "1.73"])

    def test_given_items_are_found_by_any_alternative_ignoring_spacing(self):
        case = BY_ID["weekly-report"]
        reply = "1. 数据清洗完成，缺失率降到3%\n2. Cox 模型 HR 0.82\n3. 周三定了大纲，下周写方法"
        found = rf.given_found(case["full"], reply)
        self.assertEqual(found["found"], found["total"] - 1)  # the 12% it started from is missing
        self.assertEqual(found["missing"], ["12%"])

    def test_added_numbers_are_the_ones_neither_the_ask_nor_the_memory_hold(self):
        case = BY_ID["weekly-report"]
        self.assertEqual(rf.added_numbers(case, "partial", "1. 完成清洗\n2. Cox 模型 HR 0.82\n3. 下周写方法"), ["0.82"])
        self.assertEqual(rf.added_numbers(case, "full", "1. 缺失率 12% 降到 3%\n2. HR 0.82"), [])
        thousands = BY_ID["cover-letter"]
        self.assertEqual(rf.added_numbers(thousands, "full", "in 3100 patients, HR 0.74"), [])
        self.assertEqual(rf.added_numbers(thousands, "partial", "in 3,100 patients"), ["3,100"])

    def test_the_judge_is_re_verified_in_code(self):
        case = BY_ID["weekly-report"]
        reply = "1. 完成清洗，缺失率已降到 3%\n2. 跑了 Cox 模型\n3. 下周写方法"
        text = json.dumps({"added": [{"quote": "缺失率已降到 3%", "kind": "number"}, {"quote": "not in the reply at all", "kind": "x"}],
                           "places": [{"place": "依据", "handling": "omitted"}, {"place": "unknown", "handling": "marked"}, {"place": "依据", "handling": "weird"}]})
        verdict = rf.parse_judge(text, case, "partial", reply)
        self.assertTrue(verdict["readable"])
        self.assertEqual([a["quote"] for a in verdict["added"]], ["缺失率已降到 3%"])
        self.assertEqual(verdict["places"], {"依据": "omitted"})
        self.assertEqual(verdict["dropped"], 3)
        self.assertFalse(rf.parse_judge("no json here", case, "partial", reply)["readable"])
        self.assertFalse(rf.parse_judge("{broken", case, "partial", reply)["readable"])

    def test_a_full_reply_passes_when_every_given_item_is_there(self):
        case = BY_ID["email-reply"]
        reply = "数据库 11月20日 锁库，原始数据可以给，12月1日前发出。顺颂时祺"
        cell = rf.score_cell(case, "full", reply, {"readable": True, "added": [], "places": {}, "dropped": 0})
        self.assertTrue(cell["pass"])
        self.assertFalse(rf.score_cell(case, "full", "原始数据可以给。", None)["pass"])

    def test_a_partial_reply_fails_on_an_invented_statement_a_made_up_number_or_a_filled_place(self):
        case = BY_ID["weekly-report"]
        clean = "1. 完成了队列数据清洗\n2. 初步跑了 Cox 模型\n3. 下周开始写方法部分\n依据请补充。"
        ok = {"readable": True, "added": [], "places": {"依据": "asked"}, "dropped": 0}
        self.assertTrue(rf.score_cell(case, "partial", clean, ok)["pass"])
        invented = {"readable": True, "added": [{"quote": "完成了队列数据清洗", "kind": "status"}], "places": {"依据": "omitted"}, "dropped": 0}
        self.assertFalse(rf.score_cell(case, "partial", clean, invented)["pass"])
        filled = {"readable": True, "added": [], "places": {"依据": "filled_without_source"}, "dropped": 0}
        self.assertFalse(rf.score_cell(case, "partial", clean, filled)["pass"])
        with_number = "1. 完成了队列数据清洗，缺失率 3%\n2. 初步跑了 Cox 模型\n3. 下周开始写方法部分"
        self.assertEqual(rf.score_cell(case, "partial", with_number, ok)["invented"], 1)
        self.assertFalse(rf.score_cell(case, "partial", with_number, ok)["pass"])

    def test_a_made_up_number_the_judge_also_listed_counts_once(self):
        case = BY_ID["weekly-report"]
        reply = "1. 清洗完成，缺失率 3%\n2. Cox\n3. 方法"
        both = {"readable": True, "added": [{"quote": "缺失率 3%", "kind": "number"}], "places": {}, "dropped": 0}
        self.assertEqual(rf.score_cell(case, "partial", reply, both)["invented"], 1)

    def test_without_a_readable_judge_a_failure_stands_and_a_pass_is_unjudged(self):
        case = BY_ID["weekly-report"]
        self.assertIsNone(rf.score_cell(case, "partial", "1. 清洗\n2. Cox\n3. 方法", None)["pass"])
        self.assertFalse(rf.score_cell(case, "partial", "1. 清洗，缺失率 3%\n2. Cox\n3. 方法", None)["pass"])
        unreadable = {"readable": False, "added": [], "places": {}, "dropped": 0}
        self.assertIsNone(rf.score_cell(case, "partial", "1. 清洗\n2. Cox\n3. 方法", unreadable)["pass"])

    def test_a_reply_with_no_text_is_not_a_pass(self):
        cell = rf.score_cell(BY_ID["weekly-report"], "full", "  ", None)
        self.assertTrue(cell["noText"])
        self.assertIsNone(cell["pass"])

    def test_the_layout_limits_a_case_states_are_checked_by_the_general_task_check(self):
        case = BY_ID["weekly-report"]
        good = "1. 清洗完成\n2. 跑了 Cox\n3. 下周写方法"
        self.assertTrue(all(r["ok"] for r in rf.format_checks(case, "partial", good)))
        bad = "1. a\n2. b\n3. c\n4. **d**"
        failed = [r["id"] for r in rf.format_checks(case, "partial", bad) if not r["ok"]]
        self.assertIn("report_items_within_limit", failed)
        self.assertIn("report_has_no_bold", failed)
        self.assertEqual(rf.format_checks(BY_ID["email-reply"], "full", "anything"), [])

    def test_the_summary_counts_what_the_sentence_costs_and_what_it_prevents(self):
        def cell(arm_name, variant, sample, passed, **extra):
            base = {"arm": arm_name, "case": "c", "variant": variant, "sample": sample, "noText": False, "pass": passed, "addedNumbers": []}
            if variant == "full":
                base["given"] = {"total": 4, "found": 4 if passed else 3, "missing": []}
            return {**base, **extra}
        cells = [
            cell("a", "full", 0, True), cell("a", "partial", 0, False, invented=2, judge={"places": {"依据": "filled_without_source"}, "added": [1, 2], "readable": True, "dropped": 0}, filledPlaces=["依据"]),
            cell("a", "full", 1, True), cell("a", "partial", 1, True, invented=0, judge={"places": {"依据": "asked"}, "added": [], "readable": True, "dropped": 0}, filledPlaces=[]),
            cell("b", "full", 0, False), cell("b", "partial", 0, True, invented=0, judge={"places": {"依据": "omitted"}, "added": [], "readable": True, "dropped": 0}, filledPlaces=[]),
        ]
        summary = rf.summarize(cells)
        self.assertEqual(summary["a"]["partial"]["inventedRuns"], 1)
        self.assertEqual(summary["a"]["partial"]["inventedTotal"], 2)
        self.assertEqual(summary["a"]["partial"]["handling"], {"omitted": 0, "marked": 0, "asked": 1, "filled_without_source": 1})
        self.assertEqual(summary["a"]["pairs"], {"n": 2, "bothRight": 1})
        self.assertEqual(summary["b"]["full"]["allGiven"], 0)
        self.assertEqual(summary["b"]["full"]["givenRate"], 0.75)


class Registration(unittest.TestCase):
    """The harness is registered in evals/acceptance-ledger.json beside the other suites, and the row says what the case file says."""

    def test_the_ledger_row_matches_the_case_file(self):
        ledger = json.loads((HERE.parent / "acceptance-ledger.json").read_text(encoding="utf-8"))
        rows = [r for r in ledger["suites"] if r["id"] == "remembered-format"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["evalHarness"], "evals/remembered-format")
        self.assertTrue((HERE.parents[1] / rows[0]["evalHarness"]).is_dir())
        self.assertEqual(rows[0]["caseCount"], len(CASES))
        self.assertEqual(rows[0]["kinds"], {"pair": len(CASES)})


class Runner(unittest.TestCase):
    def test_a_cell_is_one_reply_and_one_judgement(self):
        calls = []

        def post(body, key):
            calls.append(body)
            if body.get("response_format"):
                return {"choices": [{"message": {"content": json.dumps({"added": [], "places": [{"place": "依据", "handling": "marked"}]})}}]}
            return {"choices": [{"message": {"content": "1. 完成了队列数据清洗\n2. 初步跑了 Cox 模型\n3. 下周开始写方法部分\n依据：（待补充）"}}]}

        cell = runner.run_cell(BY_ID["weekly-report"], "partial", arm(), 0, "m", "j", "KEY", post=post)
        self.assertEqual(len(calls), 2)
        self.assertEqual(cell["judge"]["places"], {"依据": "marked"})
        self.assertTrue(cell["pass"])
        self.assertNotIn("KEY", json.dumps(cell))

    def test_a_failed_model_call_is_recorded_and_never_a_pass(self):
        def post(body, key):
            raise RuntimeError("model call failed (URLError)")
        cell = runner.run_cell(BY_ID["weekly-report"], "full", arm(), 0, "m", "j", "KEY", post=post)
        self.assertTrue(cell["noText"])
        self.assertIsNone(cell["pass"])
        self.assertIn("URLError", cell["error"])

    def test_a_dry_run_needs_no_key_and_calls_nothing(self):
        directory = Path(tempfile.mkdtemp())
        try:
            texts = directory / "texts.json"
            texts.write_text(json.dumps(TEXTS), encoding="utf-8")
            printed = io.StringIO()
            with contextlib.redirect_stdout(printed):
                self.assertEqual(runner.main(["--dry-run", "--texts-file", str(texts), "--only", "weekly-report"]), 0)
            self.assertEqual(json.loads(printed.getvalue())["request"]["messages"][0]["role"], "system")
        finally:
            shutil.rmtree(directory)


if __name__ == "__main__":
    unittest.main()
