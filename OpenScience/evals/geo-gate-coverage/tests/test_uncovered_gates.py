"""为原本没有对抗测试的 BLOCK 规则补上负向对照。

来由：把 78 条 BLOCK 规则逐条改成 `return []`（等于关掉）再跑全套测试，
55 条被抓住，23 条存活——存活的意思是这条铁律可以被彻底关掉而 309 个测试
全绿。它可能是对的，但没有任何东西证明它是对的；下一次重构把它改坏，没人
会知道。

其中患者旅程 PJ-G01~G06 整组无对照，而 PJ-G02 的规则原文正是
「把推演写成实测是本技能唯一不可接受的错误」。一条没有对照的 BLOCK，比
没有这条规则更危险——它给人一种被保护了的错觉。

写法沿用 test_gates.py：先造违规数据，再断言对应 rule_id 出现在阻断列表里。
只测「合规能通过」是没用的。
"""

from __future__ import annotations

from tests.test_gates import GateTestCase


def _cell(stage: str, lane: str, **over):
    cell = {"stage_id": stage, "lane_id": lane, "evidence_level": "🟡", "source": "", "text": "占位"}
    cell.update(over)
    return cell


class TestPatientJourneyGates(GateTestCase):
    """PJ-G01~G06：整组原本零覆盖。"""

    def _journey(self, **over):
        base = {
            "identity": "otc",
            "input_mode": "A",
            "stages": [
                {"stage_id": "S1", "name": "自我诊断"},
                {"stage_id": "S2", "name": "自我药疗"},
            ],
            "lanes": [{"lane_id": "L1", "name": "认知线"}, {"lane_id": "L2", "name": "痛点线"}],
            "cells": [_cell("S1", "L1"), _cell("S1", "L2"), _cell("S2", "L1"), _cell("S2", "L2")],
            "emotion_curve": [],
            "opportunities": [],
            "windows": [],
        }
        base.update(over)
        return base

    def test_pj_g02_blocks_an_unlabelled_cell(self) -> None:
        journey = self._journey()
        journey["cells"][0].pop("evidence_level")
        self.write("contracts/journey.json", journey)
        self.assertBlocked("PJ-G02", self.run_rules("PJ-G02"))

    def test_pj_g02_blocks_measured_without_a_source(self) -> None:
        # 标了 🟢 实测却指不出出处，就是把推演写成了实测——这条规则存在的
        # 全部理由。
        journey = self._journey()
        journey["cells"][0]["evidence_level"] = "🟢"
        journey["cells"][0]["source"] = ""
        self.write("contracts/journey.json", journey)
        self.assertBlocked("PJ-G02", self.run_rules("PJ-G02"))

    def test_pj_g02_blocks_measured_cells_in_a_pure_inference_run(self) -> None:
        journey = self._journey(input_mode="C")
        journey["cells"][0]["evidence_level"] = "🟢"
        journey["cells"][0]["source"] = "corpus:LB-0006"
        self.write("contracts/journey.json", journey)
        self.assertBlocked("PJ-G02", self.run_rules("PJ-G02"))

    def test_pj_g02_lets_a_fully_labelled_journey_through(self) -> None:
        # 正向对照。没有它，一条永远返回 issue 的检查也会「通过」上面三条。
        self.write("contracts/journey.json", self._journey())
        self.assertNotIn("PJ-G02", self.run_rules("PJ-G02"))


class TestCapAndCoherenceGates(GateTestCase):
    """IRON-04 / VF-G01：数值封顶与实测-预估分栏。"""

    def test_iron04_blocks_a_group_reference_above_the_cap(self) -> None:
        # 96.0 是封顶值；100.0 的需求强度意味着把排序当成了测量。
        self.write("contracts/metrics.json", {"pools": {"P1": {"gvi": {"raw_value": 100.0}}}})
        self.assertBlocked("IRON-04", self.run_rules("IRON-04"))

    def test_iron04_lets_a_value_under_the_cap_through(self) -> None:
        self.write("contracts/metrics.json", {"pools": {"P1": {"gvi": {"raw_value": 88.0}}}})
        self.assertNotIn("IRON-04", self.run_rules("IRON-04"))


class TestJourneyStructureGates(GateTestCase):
    """PJ-G04/G05/G06：情绪曲线、机会点交叉、切入窗口。"""

    def _base(self, **over):
        journey = {
            "identity": "otc",
            "input_mode": "A",
            "stages": [{"stage_id": f"S{i}", "name": f"阶段{i}"} for i in range(1, 13)],
            "lanes": [{"lane_id": "1", "name": "认知线"}, {"lane_id": "2", "name": "痛点线"}],
            "cells": [_cell("S1", "1")],
        }
        journey.update(over)
        return journey

    def test_pj_g04_blocks_a_score_without_a_driver(self) -> None:
        # 只有分数没有驱动因素的曲线，是一条画出来好看的线，不是一次观察。
        self.write("contracts/journey.json", self._base(emotion_curve=[
            {"stage_id": "S1", "score": 3, "driver": ""},
            {"stage_id": "S2", "score": 7, "driver": "确诊后安心"},
        ]))
        self.assertBlocked("PJ-G04", self.run_rules("PJ-G04"))

    def test_pj_g05_blocks_an_opportunity_from_a_single_lane(self) -> None:
        # 单线得出的不是机会点，那只是一个观察。
        self.write("contracts/journey.json", self._base(opportunities=[
            {"description": "夜间症状检索高峰", "lanes_crossed": ["认知线"]},
        ]))
        self.assertBlocked("PJ-G05", self.run_rules("PJ-G05"))

    def test_pj_g06_blocks_a_window_missing_one_of_its_three_numbers(self) -> None:
        # 情绪分、检索触发率、我方提及率，缺一即不成立——只给结论不给三个数的
        # 窗口，是拿别人的排期换自己的判断。
        self.write("contracts/journey.json", self._base(intercept_window={
            "stage_id": "S3", "emotion_score": 3, "search_trigger_rate": 0.42,
        }))
        self.assertBlocked("PJ-G06", self.run_rules("PJ-G06"))
