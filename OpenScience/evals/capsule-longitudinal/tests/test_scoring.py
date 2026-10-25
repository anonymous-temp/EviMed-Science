"""Unit tests for the pure scoring of the capsule longitudinal check. No server, no model, no network."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import scoring as sc  # noqa: E402


def judge_returning(*payloads, key="k"):
    """A Judge whose model answers the given JSON payloads in turn (as the chat completion text)."""
    answers = list(payloads)

    def post(body, key):
        payload = answers.pop(0) if len(answers) > 1 else answers[0]
        if isinstance(payload, Exception):
            raise payload
        return {"choices": [{"message": {"content": payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)}}]}

    return sc.Judge(key, post=post)


class Status(unittest.TestCase):
    def test_a_failed_required_check_fails_the_scenario(self):
        self.assertEqual(sc.status_of([sc.check("a", True), sc.check("b", False)]), sc.FAIL)

    def test_all_decided_and_true_passes(self):
        self.assertEqual(sc.status_of([sc.check("a", True), sc.check("b", True)]), sc.PASS)

    def test_an_undecided_required_check_is_inconclusive_never_a_pass(self):
        self.assertEqual(sc.status_of([sc.check("a", True), sc.check("b", None)]), sc.INCONCLUSIVE)

    def test_a_false_premise_makes_it_inconclusive_not_a_failure(self):
        self.assertEqual(sc.status_of([sc.check("setup", False, premise=True), sc.check("b", False)]), sc.INCONCLUSIVE)
        self.assertEqual(sc.status_of([sc.check("setup", False, premise=True), sc.check("b", True)]), sc.INCONCLUSIVE)

    def test_a_failure_stands_even_when_another_check_is_undecided(self):
        self.assertEqual(sc.status_of([sc.check("a", False), sc.check("b", None)]), sc.FAIL)

    def test_an_optional_check_decides_nothing(self):
        self.assertEqual(sc.status_of([sc.check("a", True), sc.check("info", False, required=False)]), sc.PASS)
        self.assertEqual(sc.status_of([sc.check("info", True, required=False)]), sc.INCONCLUSIVE, "no required check is no evidence")


class Text(unittest.TestCase):
    def test_bold_is_double_asterisks_or_underscores(self):
        self.assertTrue(sc.has_bold("a **b** c"))
        self.assertTrue(sc.has_bold("a __b__ c"))
        self.assertFalse(sc.has_bold("a * b * c"))
        self.assertFalse(sc.has_bold("plain text"))

    def test_language_is_the_share_of_cjk_among_letters(self):
        self.assertEqual(sc.cjk_ratio(""), 0.0)
        self.assertLess(sc.cjk_ratio("A review of SGLT2 inhibitors in heart failure."), 0.05)
        self.assertGreater(sc.cjk_ratio("这是一个面向社区居民的高血压科普项目。"), 0.95)
        self.assertAlmostEqual(sc.cjk_ratio("ab 中文"), 0.5)

    def test_needles_are_found_ignoring_spacing(self):
        self.assertEqual(sc.contains_any("我 每天 骑 自行车 通勤", ["自行车", "骑车"]), ["自行车"])
        self.assertEqual(sc.contains_any("", ["a"]), [])


class Records(unittest.TestCase):
    RECORDS = [{"id": "r1", "value": "邮件结尾用「顺颂时祺」", "version": 3}, {"id": "r2", "summary": "做肾脏病研究", "value": ""}]

    def test_records_holding_a_needle(self):
        self.assertEqual([r["id"] for r in sc.records_holding(self.RECORDS, ["顺颂时祺"])], ["r1"])
        self.assertEqual([r["id"] for r in sc.records_holding(self.RECORDS, ["肾脏病"])], ["r2"], "the summary is read when there is no value")

    def test_the_card_is_the_text_of_its_rows(self):
        rows = [{"slot": "goal", "text": "评估卒中风险"}, {"slot": "stage", "text": "数据清洗"}]
        self.assertEqual(sc.card_text({"card": rows}), "评估卒中风险\n数据清洗")
        self.assertEqual(sc.card_text({"card": {"rows": rows}}), "评估卒中风险\n数据清洗")
        self.assertEqual(sc.card_text({"card": []}), "")
        self.assertEqual(sc.card_text(None), "")

    def test_the_source_conversations_of_a_record(self):
        record = {"evidence": [{"sourceType": "conversation", "conversationId": "c1", "projectId": "p"}, {"sourceType": "document", "conversationId": "x"}, {"sourceType": "conversation"}]}
        self.assertEqual(sc.evidence_conversations(record), [{"conversationId": "c1", "projectId": "p"}])
        self.assertEqual(sc.evidence_conversations({}), [])

    def test_a_platform_conversation_and_a_kernel_session_are_one_conversation(self):
        self.assertTrue(sc.same_session("dsh-abc", "abc"))
        self.assertTrue(sc.same_session("abc", "abc"))
        self.assertFalse(sc.same_session("abc", "abd"))
        self.assertFalse(sc.same_session(None, "abc"))

    def test_the_card_among_what_was_recalled(self):
        self.assertTrue(sc.recalled_card({"recalledMemories": [{"id": "card:p1"}, {"id": "x"}]}, "p1"))
        self.assertFalse(sc.recalled_card({"recalledMemories": [{"id": "x"}]}, "p1"))
        self.assertFalse(sc.recalled_card({"recalledMemories": []}, "p1"))
        self.assertIsNone(sc.recalled_card({"id": "run"}, "p1"), "a record without the field cannot say")
        self.assertIsNone(sc.recalled_card(None, "p1"))

    def test_methods_loaded_and_the_names_a_method_goes_by(self):
        self.assertEqual(sc.methods_loaded({"methodsLoaded": [{"name": "a", "reason": "similarity"}, "junk"]}), [{"name": "a", "reason": "similarity"}])
        self.assertEqual(sc.methods_loaded(None), [])
        self.assertEqual(sc.method_names({"name": "n", "title": "t", "id": "i", "other": "x"}), ["n", "t", "i"])


class G23(unittest.TestCase):
    """Case G23's own checks, through the general-task judges' own table."""

    CASE = sc.load_case("G23")

    def turns(self, third):
        return [{"text": self.CASE["turns"][0]["text"], "reply": "x"}, {"text": self.CASE["turns"][1]["text"], "reply": "y"}, {"text": self.CASE["turns"][2]["text"], "reply": third}]

    def test_a_report_in_the_remembered_format_passes_every_check(self):
        results = sc.case_checks(self.CASE, self.turns("1. 做完敏感性分析\n2. 和统计师讨论缺失值\n3. 下周准备投会议摘要"))
        self.assertTrue(results and all(r["ok"] for r in results), [r for r in results if not r["ok"]])
        self.assertIn("report_items_within_limit", {r["id"] for r in results})

    def test_too_many_items_bold_and_a_number_nobody_gave_each_fail_their_own_check(self):
        results = {r["id"]: r for r in sc.case_checks(self.CASE, self.turns("1. **做完敏感性分析**\n2. 讨论缺失值，样本 4200 例\n3. 投摘要\n4. 其他"))}
        self.assertFalse(results["report_items_within_limit"]["ok"])
        self.assertFalse(results["report_has_no_bold"]["ok"])
        self.assertFalse(results["report_adds_no_number"]["ok"])
        self.assertIn("4200", results["report_adds_no_number"]["detail"])

    def test_the_forbidden_kinds_of_the_case_are_checked_too(self):
        results = sc.case_checks(self.CASE, self.turns("1. a\n2. b\n3. c\n\n参考文献\n[1] x"))
        self.assertFalse(next(r for r in results if r["id"] == "forbidden:references")["ok"])


class Judging(unittest.TestCase):
    def test_without_a_key_nothing_is_decided(self):
        judge = sc.Judge(None)
        self.assertFalse(judge.available)
        self.assertIsNone(judge.invented("ask", "reply"))
        self.assertIsNone(judge.states("text", "claim"))

    def test_invented_statements_are_re_verified_as_substrings(self):
        judge = judge_returning({"added": [{"quote": "拟用多重插补", "kind": "method"}, {"quote": "不在回答里", "kind": "x"}], "places": []})
        verdict = judge.invented("帮我写周报", "1. 讨论了缺失值，拟用多重插补\n2. 投摘要", "周报", ["依据"])
        self.assertEqual([a["quote"] for a in verdict["added"]], ["拟用多重插补"])
        self.assertEqual(verdict["dropped"], 1)

    def test_an_unreadable_or_failed_judge_is_undecided(self):
        self.assertIsNone(judge_returning("not json").invented("a", "reply"))
        self.assertIsNone(judge_returning(RuntimeError("down")).invented("a", "reply"))
        self.assertIsNone(judge_returning(RuntimeError("down")).states("t", "c"))

    def test_a_statement_verdict_must_carry_a_quotation_that_is_in_the_text(self):
        text = "这位用户每天骑自行车通勤。"
        self.assertEqual(judge_returning({"states": True, "quote": "每天骑自行车通勤"}).states(text, "c"), {"states": True, "quote": "每天骑自行车通勤"})
        self.assertIsNone(judge_returning({"states": True, "quote": "凭空的话"}).states(text, "c"), "a verdict whose evidence is not in the text is dropped")
        self.assertEqual(judge_returning({"states": False, "quote": None}).states(text, "c"), {"states": False, "quote": None})
        self.assertIsNone(judge_returning({"states": "maybe"}).states(text, "c"))

    def test_a_claim_check_follows_the_judge_and_falls_back_to_the_scenarios_keywords(self):
        stated = judge_returning({"states": True, "quote": "骑自行车"})
        result = sc.claim_check("not used", "他骑自行车上班", "bicycle", ["自行车"], stated)
        self.assertIs(result["ok"], False)
        self.assertIn("judge: states", result["detail"])
        denied = judge_returning({"states": False, "quote": None})
        self.assertIs(sc.claim_check("not used", "我不知道你怎么通勤，若骑自行车请…", "bicycle", ["自行车"], denied)["ok"], True, "the judge reads a meaning; a keyword in a denial is not a statement")
        nokey = sc.claim_check("not used", "他骑自行车上班", "bicycle", ["自行车"], sc.Judge(None))
        self.assertIs(nokey["ok"], False)
        self.assertIn("no judge", nokey["detail"])
        self.assertIs(sc.claim_check("not used", "我不知道", "bicycle", ["自行车"], sc.Judge(None))["ok"], True)


class Summary(unittest.TestCase):
    def test_cost_by_purpose(self):
        cost = sc.cost_of([["chat", "4", "0.1234"], ["learning", "2", "0.0100"], ["bad"], ["x", "1", "nope"]])
        self.assertEqual(cost["totalCny"], 0.1334)
        self.assertEqual(cost["byPurpose"]["chat"], {"calls": 4, "cny": 0.1234})

    def test_the_table_names_every_undecided_and_failed_check(self):
        results = [{"id": "S1", "title": "t", "status": "fail", "checks": [sc.check("fmt", False, "4 items"), sc.check("ok", True)]},
                   {"id": "S8", "title": "u", "status": "not_available", "checks": [], "reason": "no adopt"}]
        text = sc.summary_table(results)
        self.assertIn("FAIL fmt: 4 items", text)
        self.assertIn("-- no adopt", text)
        self.assertIn("fail 1  not_available 1", text)


if __name__ == "__main__":
    unittest.main()
