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


class TestCorpusAndDemandGates(GateTestCase):
    """DM-G02/G03/G04/G06 与 CN-G04/G06：语料进来时的诚实性。"""

    def _groups(self, **over):
        base = {
            "groups": [{"group_id": "G01", "name": "长期服用", "pool": "P1"}],
            "coverage": {"total": 100, "assigned": 95},
        }
        base.update(over)
        return base

    def test_dm_g02_blocks_seo_farm_content_left_in_the_corpus(self) -> None:
        # SEO 农场文是需求信号的赝品：它读起来像一群人在问，其实是一个人在投放。
        self.write("contracts/corpus.jsonl", [
            {"utterance_id": "U-1", "text": "速效救心丸能长期吃吗", "url": "https://www.zhihu.com/q/1"},
            {"utterance_id": "U-2", "text": "十大品牌推荐：家里必备的救心药", "url": "https://example.test/a"},
        ])
        self.assertBlocked("DM-G02", self.run_rules("DM-G02"))

    def test_dm_g02_blocks_a_known_content_farm_domain(self) -> None:
        self.write("contracts/corpus.jsonl", [
            {"utterance_id": "U-3", "text": "服用注意事项", "url": "https://99健康网.test/x"},
        ])
        self.assertBlocked("DM-G02", self.run_rules("DM-G02"))

    def test_dm_g02_lets_ordinary_utterances_through(self) -> None:
        self.write("contracts/corpus.jsonl", [
            {"utterance_id": "U-4", "text": "医生说可以长期吃，是真的吗", "url": "https://www.zhihu.com/q/2"},
        ])
        self.assertNotIn("DM-G02", self.run_rules("DM-G02"))

    def test_dm_g03_blocks_an_utterance_with_no_primary_group(self) -> None:
        self.write("contracts/groups.json", self._groups())
        self.write("contracts/corpus.jsonl", [{"utterance_id": "U-5", "text": "能长期吃吗"}])
        self.assertBlocked("DM-G03", self.run_rules("DM-G03"))

    def test_dm_g03_blocks_a_primary_group_that_does_not_exist(self) -> None:
        self.write("contracts/groups.json", self._groups())
        self.write("contracts/corpus.jsonl", [
            {"utterance_id": "U-6", "text": "能长期吃吗", "primary_group": "G99"},
        ])
        self.assertBlocked("DM-G03", self.run_rules("DM-G03"))

    def test_dm_g03_blocks_a_group_in_an_illegal_pool(self) -> None:
        self.write("contracts/groups.json", self._groups(
            groups=[{"group_id": "G01", "name": "长期服用", "pool": "P9"}],
        ))
        self.write("contracts/corpus.jsonl", [
            {"utterance_id": "U-7", "text": "能长期吃吗", "primary_group": "G01"},
        ])
        self.assertBlocked("DM-G03", self.run_rules("DM-G03"))

    def test_dm_g04_blocks_coverage_under_the_floor(self) -> None:
        self.write("contracts/groups.json", self._groups(coverage={"total": 100, "assigned": 50}))
        self.assertBlocked("DM-G04", self.run_rules("DM-G04"))

    def test_dm_g04_blocks_coverage_above_one_hundred_percent(self) -> None:
        # 127% 的覆盖率不是「覆盖得特别好」，是分子分母对不上——重复归组或
        # total 记漏了，两种都会让下游所有比例失真。只查下界会静默放行它。
        self.write("contracts/groups.json", self._groups(coverage={"total": 100, "assigned": 128}))
        self.assertBlocked("DM-G04", self.run_rules("DM-G04"))

    def test_dm_g04_lets_adequate_coverage_through(self) -> None:
        self.write("contracts/groups.json", self._groups(coverage={"total": 100, "assigned": 95}))
        self.assertNotIn("DM-G04", self.run_rules("DM-G04"))

    def test_dm_g06_blocks_a_population_share_inferred_from_engagement(self) -> None:
        # 点赞一万不等于一万人这么想。内容可以来自社媒，权重不可以。
        self.deliverable("report.md", "小红书上这条点赞过万，可见 30% 的患者都有这个困扰。\n")
        self.assertBlocked("DM-G06", self.run_rules("DM-G06"))

    def test_dm_g06_lets_engagement_used_for_ranking_through(self) -> None:
        self.deliverable("report.md", "小红书互动量用于组内强度排序，不用于人群比例推断。\n")
        self.assertNotIn("DM-G06", self.run_rules("DM-G06"))

    def test_cn_g04_blocks_a_node_phrase_absent_from_the_label(self) -> None:
        # 证型、主治、症见逐字出自说明书，否则就是我们替药监局写了适应症。
        self.write("label.json", {"clauses": [
            {
                "clause_id": "L-01",
                "layer": "功能主治",
                "field": "功能主治",
                "gated_by_syndrome": True,
                "text": "行气活血，祛瘀止痛。用于气滞血瘀所致的胸痹",
            },
        ]})
        self.write("contracts/nodes.json", {"collection_status": "collected", "nodes": [
            {"node_id": "N-1", "label_phrases": ["改善心肌供血不足"]},
        ]})
        grouped = self.run_rules("CN-G04")
        self.assertBlocked("CN-G04", grouped)
        # 为什么被拦下也要钉住：这条最初「通过」是因为 label_parse 抛了 KeyError，
        # 检查崩溃与检查生效在阻断列表里长得一模一样。
        self.assertIn("改善心肌供血不足", grouped["CN-G04"][0]["message"])

    def test_cn_g04_lets_a_verbatim_phrase_through(self) -> None:
        self.write("label.json", {"clauses": [
            {
                "clause_id": "L-01",
                "layer": "功能主治",
                "field": "功能主治",
                "gated_by_syndrome": True,
                "text": "行气活血，祛瘀止痛。用于气滞血瘀所致的胸痹",
            },
        ]})
        self.write("contracts/nodes.json", {"collection_status": "collected", "nodes": [
            {"node_id": "N-1", "label_phrases": ["气滞血瘀"]},
        ]})
        self.assertNotIn("CN-G04", self.run_rules("CN-G04"))

    def test_cn_g06_blocks_corpus_refs_when_nothing_was_collected(self) -> None:
        # 没采集到就写「无信号」并停在那里。反向从功能主治编出问法，
        # 产出看起来与真采到过完全一样——这正是「空不是错」那一族缺陷。
        self.write("contracts/nodes.json", {"collection_status": "empty", "nodes": [
            {"node_id": "N-2", "source": "corpus_ref", "text": "患者常问能否长期服用"},
        ]})
        self.assertBlocked("CN-G06", self.run_rules("CN-G06"))

    def test_cn_g06_lets_an_honest_no_signal_node_through(self) -> None:
        self.write("contracts/nodes.json", {"collection_status": "empty", "nodes": [
            {"node_id": "N-3", "source": "label_derived", "text": "本节点无信号"},
        ]})
        self.assertNotIn("CN-G06", self.run_rules("CN-G06"))


class TestEvidenceBoundaryGates(GateTestCase):
    """EF-G04/G08 与 HR-E3/E4、VF-G01/G05：证据与实测的边界。"""

    def test_ef_g04_blocks_a_reprint_counted_as_independent(self) -> None:
        # 五家网站转载同一篇，权威性没有变成五倍。
        self.write("contracts/sources.json", {"sources": [
            {"source_id": "S-01", "origin_source_id": "S-01"},
            {"source_id": "S-02", "origin_source_id": "S-01"},
            {"source_id": "S-03", "origin_source_id": "S-01"},
        ]})
        self.write("contracts/claims.json", {"claims_hash": "x" * 12, "claims": [{
            "claim_id": "C-01",
            "independent_source_count": 3,
            "evidence": [{"source_id": "S-01"}, {"source_id": "S-02"}, {"source_id": "S-03"}],
        }]})
        self.assertBlocked("EF-G04", self.run_rules("EF-G04"))

    def test_ef_g04_blocks_reprints_with_no_independent_count_declared(self) -> None:
        self.write("contracts/sources.json", {"sources": [
            {"source_id": "S-01", "origin_source_id": "S-01"},
            {"source_id": "S-02", "origin_source_id": "S-01"},
        ]})
        self.write("contracts/claims.json", {"claims_hash": "x" * 12, "claims": [{
            "claim_id": "C-02",
            "evidence": [{"source_id": "S-01"}, {"source_id": "S-02"}],
        }]})
        self.assertBlocked("EF-G04", self.run_rules("EF-G04"))

    def test_ef_g04_lets_a_correct_dedup_count_through(self) -> None:
        self.write("contracts/sources.json", {"sources": [
            {"source_id": "S-01", "origin_source_id": "S-01"},
            {"source_id": "S-02", "origin_source_id": "S-01"},
        ]})
        self.write("contracts/claims.json", {"claims_hash": "x" * 12, "claims": [{
            "claim_id": "C-03",
            "independent_source_count": 1,
            "evidence": [{"source_id": "S-01"}, {"source_id": "S-02"}],
        }]})
        self.assertNotIn("EF-G04", self.run_rules("EF-G04"))

    def test_ef_g08_blocks_a_silent_absence_of_fact_differences(self) -> None:
        # 「没有可核验的事实差异」和「我们没查事实差异」在交付物上长得一模一样，
        # 所以 0 条时必须显式写出来。
        self.write("contracts/claims.json", {"claims_hash": "x" * 12, "claims": [
            {"claim_id": "C-04", "claim_type": "efficacy", "on_label": True},
        ]})
        self.assertBlocked("EF-G08", self.run_rules("EF-G08"))

    def test_ef_g08_lets_an_explicit_declaration_through(self) -> None:
        self.write("contracts/claims.json", {
            "claims_hash": "x" * 12,
            "fact_diff_declaration": "本品与竞品在可核验事实层无差异",
            "claims": [{"claim_id": "C-05", "claim_type": "efficacy", "on_label": True}],
        })
        self.assertNotIn("EF-G08", self.run_rules("EF-G08"))

    def test_ef_g08_blocks_a_verifiable_fact_marked_off_label(self) -> None:
        self.write("contracts/claims.json", {"claims_hash": "x" * 12, "claims": [
            {"claim_id": "C-06", "claim_type": "verifiable_fact", "on_label": False},
        ]})
        self.assertBlocked("EF-G08", self.run_rules("EF-G08"))

    def test_hr_e3_blocks_a_numeric_evidence_score_in_a_client_file(self) -> None:
        # 0.82 分给客户看，就等于宣称这是一套分级体系——而它不是 GRADE。
        self.deliverable("report.md", "该主张的证据等级：0.82，属于较强证据。\n")
        self.assertBlocked("HR-E3", self.run_rules("HR-E3"))

    def test_hr_e3_lets_a_qualitative_tier_through(self) -> None:
        self.deliverable("report.md", "该主张属于产品级直接证据（本体系为定性金字塔，非 GRADE 分级）。\n")
        self.assertNotIn("HR-E3", self.run_rules("HR-E3"))

    def test_hr_e4_blocks_a_real_utterance_used_as_product_evidence(self) -> None:
        # 患者怎么问，不能证明药怎么起效。问法只进需求与语义层。
        self.write("contracts/sources.json", {"sources": [
            {"source_id": "S-10", "source_type": "真实问法"},
        ]})
        self.write("contracts/claims.json", {"claims_hash": "x" * 12, "claims": [{
            "claim_id": "C-07",
            "evidence": [{"source_id": "S-10", "tier": "产品级直接证据"}],
        }]})
        self.assertBlocked("HR-E4", self.run_rules("HR-E4"))

    def test_hr_e4_lets_a_trial_source_through(self) -> None:
        self.write("contracts/sources.json", {"sources": [
            {"source_id": "S-11", "source_type": "临床试验"},
        ]})
        self.write("contracts/claims.json", {"claims_hash": "x" * 12, "claims": [{
            "claim_id": "C-08",
            "evidence": [{"source_id": "S-11", "tier": "产品级直接证据"}],
        }]})
        self.assertNotIn("HR-E4", self.run_rules("HR-E4"))

    def test_vf_g01_blocks_measured_and_estimated_in_one_cell(self) -> None:
        self.deliverable("kpi.md", "| 指标 | 数值 |\n| --- | --- |\n| 可见度 | 实测 42%，预估年底 60% |\n")
        self.assertBlocked("VF-G01", self.run_rules("VF-G01"))

    def test_vf_g01_lets_separate_columns_through(self) -> None:
        # 分栏正是这条规则要求的形态，不能连它一起挡。
        self.deliverable("kpi.md", "| 指标 | 实测 | 预估 |\n| --- | --- | --- |\n| 可见度 | 42% | 60% |\n")
        self.assertNotIn("VF-G01", self.run_rules("VF-G01"))

    def test_vf_g05_blocks_metrics_without_a_probe_surface(self) -> None:
        self.write("contracts/metrics.json", {"pools": {}, "sampling": {}})
        self.assertBlocked("VF-G05", self.run_rules("VF-G05"))

    def test_vf_g05_blocks_an_incomplete_surface_triple(self) -> None:
        self.write("contracts/metrics.json", {"pools": {}, "sampling": {"surfaces": ["deepseek-web/deep"]}})
        self.assertBlocked("VF-G05", self.run_rules("VF-G05"))

    def test_vf_g05_blocks_a_client_file_that_never_says_what_was_measured(self) -> None:
        # 甲方掏出手机、开着深度思考问同一句、答案和报告对不上——现场即塌。
        self.write("contracts/metrics.json", {"pools": {}, "sampling": {
            "surfaces": ["deepseek-web × deep × new_chat"],
        }})
        self.deliverable("report.md", "本次可见度为 42%。\n")
        self.assertBlocked("VF-G05", self.run_rules("VF-G05"))

    def test_vf_g05_lets_a_disclosed_probe_surface_through(self) -> None:
        self.write("contracts/metrics.json", {"pools": {}, "sampling": {
            "surfaces": ["deepseek-web × deep × new_chat"],
        }})
        self.deliverable("report.md", "本次测的是网页端深度思考模式下的新会话首答，不是 App 端、不是多轮追问。\n")
        self.assertNotIn("VF-G05", self.run_rules("VF-G05"))


class TestClientFacingGates(GateTestCase):
    """X-WRITE / X-JARGON / PB-G03 / CP-G01 / CP-G07：交到客户手里的那一份。"""

    def test_x_write_blocks_a_done_claim_with_nothing_to_open(self) -> None:
        # 每个「已」字后面必须能当场点开一个东西，否则它只是一句好听的话。
        self.deliverable("summary.md", "本轮已完成全部竞品的可见度测算，结论稳健。\n")
        self.assertBlocked("X-WRITE", self.run_rules("X-WRITE"))

    def test_x_write_lets_a_done_claim_with_a_pointer_through(self) -> None:
        self.deliverable("summary.md", "本轮已完成全部竞品的可见度测算，见附件明细。\n")
        self.assertNotIn("X-WRITE", self.run_rules("X-WRITE"))

    def test_x_write_blocks_a_declaration_repeated_verbatim(self) -> None:
        line = "本表为背景处理口径，不做疗效优劣的直接比较，仅供参考。\n"
        self.deliverable("notes.md", line * 3 + "见附件。\n")
        self.assertBlocked("X-WRITE", self.run_rules("X-WRITE"))

    def test_x_jargon_blocks_an_internal_id_used_as_content(self) -> None:
        # 客户读不懂一个叫 N-ALLERGY 的东西，而读不懂的表格会让整份报告像内部草稿。
        self.deliverable("table.md", "| 内容归属 | 建议 |\n| --- | --- |\n| N-ALLERGY | 增加科普 |\n")
        self.assertBlocked("X-JARGON", self.run_rules("X-JARGON"))

    def test_x_jargon_lets_an_id_used_as_a_traceability_anchor_through(self) -> None:
        # 这条正向对照是必需的：把溯源锚点一起挡掉，就等于挡掉了可反查性本身。
        self.deliverable("table.md", "本结论依据 G10、E1 的原始记录，可反查。\n")
        self.assertNotIn("X-JARGON", self.run_rules("X-JARGON"))

    def test_pb_g03_blocks_a_concept_set_over_the_cap(self) -> None:
        self.write("contracts/theses.json", {"concept_set": [
            {"term": f"概念{i}", "definition": f"定义{i}"} for i in range(9)
        ]})
        self.assertBlocked("PB-G03", self.run_rules("PB-G03"))

    def test_pb_g03_blocks_a_concept_with_no_definition(self) -> None:
        self.write("contracts/theses.json", {"concept_set": [
            {"term": "可见度指数", "definition": "在监测题面上被提及的比例"},
            {"term": "语义占位", "definition": ""},
        ]})
        self.assertBlocked("PB-G03", self.run_rules("PB-G03"))

    def test_pb_g03_lets_a_small_defined_set_through(self) -> None:
        self.write("contracts/theses.json", {"concept_set": [
            {"term": "可见度指数", "definition": "在监测题面上被提及的比例"},
        ]})
        self.assertNotIn("PB-G03", self.run_rules("PB-G03"))

    def test_cp_g01_blocks_an_asset_bound_to_nothing(self) -> None:
        self.write("contracts/claims.json", {"claims_hash": "x" * 12, "claims": [
            {"claim_id": "C-20", "on_label": True},
        ]})
        self.write("contracts/pilot.json", {"assets": [{"asset_id": "A-1", "claim_ids": []}]})
        self.assertBlocked("CP-G01", self.run_rules("CP-G01"))

    def test_cp_g01_blocks_an_asset_bound_to_an_off_label_claim(self) -> None:
        self.write("contracts/claims.json", {"claims_hash": "x" * 12, "claims": [
            {"claim_id": "C-21", "on_label": False, "claim_type": "efficacy"},
        ]})
        self.write("contracts/pilot.json", {"assets": [{"asset_id": "A-2", "claim_ids": ["C-21"]}]})
        self.assertBlocked("CP-G01", self.run_rules("CP-G01"))

    def test_cp_g01_lets_an_on_label_binding_through(self) -> None:
        self.write("contracts/claims.json", {"claims_hash": "x" * 12, "claims": [
            {"claim_id": "C-22", "on_label": True},
        ]})
        self.write("contracts/pilot.json", {"assets": [{"asset_id": "A-3", "claim_ids": ["C-22"]}]})
        self.assertNotIn("CP-G01", self.run_rules("CP-G01"))

    def test_cp_g07_blocks_an_asset_with_no_qualification_note(self) -> None:
        self.write("contracts/pilot.json", {"assets": [{"asset_id": "A-4", "qualification": {}}]})
        self.assertBlocked("CP-G07", self.run_rules("CP-G07"))

    def test_cp_g07_blocks_an_rx_asset_aimed_at_the_public(self) -> None:
        self.write("identity.json", {"rx_otc": "Rx"})
        self.write("contracts/pilot.json", {"assets": [{
            "asset_id": "A-5",
            "qualification": {"ad_review_number_required": True, "audience": "public"},
        }]})
        self.assertBlocked("CP-G07", self.run_rules("CP-G07"))

    def test_cp_g07_lets_an_rx_asset_on_the_professional_channel_through(self) -> None:
        self.write("identity.json", {"rx_otc": "Rx"})
        self.write("contracts/pilot.json", {"assets": [{
            "asset_id": "A-6",
            "qualification": {"ad_review_number_required": True, "audience": "professional_only"},
        }]})
        self.assertNotIn("CP-G07", self.run_rules("CP-G07"))


class TestJourneySkeletonGates(GateTestCase):
    """PJ-G01/G03：骨架身份一致与原话出处。"""

    def _stages(self, count=12):
        return [{"stage_id": f"S{i}", "name": f"阶段{i}"} for i in range(1, count + 1)]

    def test_pj_g01_blocks_an_otc_product_on_the_rx_skeleton(self) -> None:
        # OTC 硬套 Rx 骨架会凭空造出诊断确立期与终末期，而空阶段在 PPT 上
        # 和「这一段我们没洞察」看起来一模一样。
        self.write("identity.json", {"rx_otc": "OTC_A"})
        self.write("contracts/journey.json", {"skeleton": "rx", "stages": self._stages(), "cells": []})
        self.assertBlocked("PJ-G01", self.run_rules("PJ-G01"))

    def test_pj_g01_blocks_a_merged_skeleton(self) -> None:
        self.write("identity.json", {"rx_otc": "OTC_A"})
        self.write("contracts/journey.json", {"skeleton": "otc", "stages": self._stages(9), "cells": []})
        self.assertBlocked("PJ-G01", self.run_rules("PJ-G01"))

    def test_pj_g01_blocks_a_not_applicable_stage_with_no_reason(self) -> None:
        # 空着比合并诚实，但空着不写理由和漏了没有区别。
        stages = self._stages()
        stages[3] = {"stage_id": "S4", "name": "阶段4", "applicable": False, "skip_reason": ""}
        self.write("identity.json", {"rx_otc": "OTC_A"})
        self.write("contracts/journey.json", {"skeleton": "otc", "stages": stages, "cells": []})
        self.assertBlocked("PJ-G01", self.run_rules("PJ-G01"))

    def test_pj_g01_lets_a_matching_skeleton_through(self) -> None:
        self.write("identity.json", {"rx_otc": "OTC_A"})
        self.write("contracts/journey.json", {"skeleton": "otc", "stages": self._stages(), "cells": []})
        self.assertNotIn("PJ-G01", self.run_rules("PJ-G01"))

    def test_pj_g03_blocks_an_invented_patient_quote(self) -> None:
        # 拟写的原话被问一句「这是谁说的」，整张图的可信度一起塌。
        self.write("contracts/journey.json", {
            "skeleton": "otc",
            "stages": self._stages(),
            "lanes": [{"lane_id": 6, "name": "痛点线"}],
            "cells": [{"stage_id": "S2", "lane_id": 6, "text": "患者说「吃了三天一点用都没有」", "source": ""}],
        })
        self.assertBlocked("PJ-G03", self.run_rules("PJ-G03"))

    def test_pj_g03_lets_a_quote_with_a_corpus_ref_through(self) -> None:
        self.write("contracts/journey.json", {
            "skeleton": "otc",
            "stages": self._stages(),
            "lanes": [{"lane_id": 6, "name": "痛点线"}],
            "cells": [{
                "stage_id": "S2", "lane_id": 6,
                "text": "患者说「吃了三天一点用都没有」",
                "source": "corpus_ref:xhs-00417",
            }],
        })
        self.assertNotIn("PJ-G03", self.run_rules("PJ-G03"))

    def test_pj_g03_lets_an_honest_no_signal_cell_through(self) -> None:
        self.write("contracts/journey.json", {
            "skeleton": "otc",
            "stages": self._stages(),
            "lanes": [{"lane_id": 6, "name": "痛点线"}],
            "cells": [{"stage_id": "S9", "lane_id": 6, "text": "本阶段无信号，未取得「任何原话」", "source": ""}],
        })
        self.assertNotIn("PJ-G03", self.run_rules("PJ-G03"))
