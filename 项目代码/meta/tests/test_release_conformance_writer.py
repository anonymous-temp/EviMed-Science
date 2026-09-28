"""The writer produces what the release gate checks, from the engine's own records.

Cases come from the ma-001 manuscript (TXA in primary TKA) that the gate
blocked on PRISMA flow, cross-references, readability and calculation detail.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import new_meta.config as config
from new_meta.agents.writing.contracts import SentenceSplitRevision, SentenceSplitRewrite
from new_meta.agents.writing_agent import WritingAgent
from new_meta.core.artifact_package import (
    _build_cross_reference_audit_review,
    _build_prisma_audit_review,
    _build_readability_audit_review,
)
from new_meta.core.artifact_package_citation_audit import _sentence_has_numeric_effect_claim
from new_meta.core.artifact_package_manifest import _has_calculation_detail
from new_meta.core.manuscript_cross_references import generate_table_figure_cross_references
from new_meta.core.manuscript_facts import _prisma_facts
from new_meta.core.project import Project
from new_meta.core.readability import (
    overlong_interpretive_sentences,
    sentence_split_issues,
    split_overlong_sentences,
)

MA001_PRISMA_FLOW = {
    "identification": {
        "records_identified": 400,
        "records_after_dedup": 398,
        "duplicates_removed": 2,
        "records_not_screened": 248,
        "automation_excluded": 248,
        "records_not_screened_reasons": {"relevance cap before screening": 248},
    },
    "screening": {"title_abstract_screened": 150, "title_abstract_excluded": 101},
    "eligibility": {"full_text_assessed": 14, "full_text_excluded": 11},
    "included": {"studies_included": 3},
}

MA001_SYNTHESIS = {
    "estimator": "DESIGN_AWARE_REML_HKSJ",
    "n_studies": 3,
    "primary_estimates": [{
        "measure": "MD",
        "estimate": -303.2265806852571,
        "ci_lower": -504.51984194942247,
        "ci_upper": -101.93331942109168,
        "prediction_lower": -2730.381643234127,
        "prediction_upper": 2123.928481863613,
    }],
    "heterogeneity": {"tau_squared": 25941.694303702847, "i_squared": 83.37866097349779, "q": 12.032724901471903},
    "engine_payload": {
        "measure": "MD",
        "n_contrasts": 3,
        "standard_error_analysis_scale": 102.70253068522736,
        "design_counts": {"multi_arm_rct": 3},
        "study_effects": [
            {"study_id": "study:28326403", "analysis_effect": -329.69999999999993, "variance": 7363.488146551725},
            {"study_id": "study:33511201", "analysis_effect": -458.0, "variance": 3942.5924369747895},
            {"study_id": "study:34566475", "analysis_effect": -112.5, "variance": 5984.607142857144},
        ],
        "sensitivity": {"HKSJ": {"estimate": -303.0174996601474, "ci_lower": -759.4317794697145, "ci_upper": 153.3967801494196}},
    },
}

MA001_ROWS = [
    {"study_id": "study:28326403", "study_label": "Alexandru 2016"},
    {"study_id": "study:33511201", "study_label": "Shih-Hsiang 2021"},
    {"study_id": "study:34566475", "study_label": "Montovanelli 2021"},
]


# ── prisma_flow ───────────────────────────────────────────────────────────


def test_prisma_facts_carry_the_records_removed_before_screening() -> None:
    prisma = _prisma_facts(MA001_PRISMA_FLOW)

    assert prisma["records_not_screened"] == 248
    assert prisma["records_not_screened_reasons"] == {"relevance cap before screening": 248}
    assert prisma["title_abstract_screened"] == 150


def test_screening_sentence_reports_the_screened_count_from_the_ledger(tmp_path: Path) -> None:
    prisma = _prisma_facts(MA001_PRISMA_FLOW)
    zh = WritingAgent(lang="zh")._screening_entry_phrase(prisma, "经跨来源去重和同源记录合并（移除2条）后剩余398条")
    en = WritingAgent(lang="en")._screening_entry_phrase(prisma, "after deduplication removed 2 records, 398 unique records remained")

    assert zh == (
        "经跨来源去重和同源记录合并（移除2条）后剩余398条；"
        "其中248条因相关性排序超出筛选上限未进入筛选，150条进入题名/摘要筛选"
    )
    assert "248 ranked beyond the relevance cap for screening and were not screened" in en
    assert "150 title/abstract records were screened" in en
    project = Project("prisma sentence", output_dir=tmp_path)
    project.save_json("prisma_flow.json", MA001_PRISMA_FLOW)
    project.save_text(
        "draft.md",
        (
            f"# 标题\n\n## 摘要\n\n**结果：** 检索识别400条记录，{zh}，全文评估14篇，最终纳入3项研究。\n\n"
            "## 图表\n\n### 图1. PRISMA流程图\n\n"
            + WritingAgent(lang="zh")._fallback_prisma_flow_legend(prisma=prisma, n_primary=3)
            + "\n"
        ),
        subdir="manuscript",
    )

    audit = _build_prisma_audit_review(project)

    assert audit["passed"] is True, audit["issues"]


def test_screening_sentence_is_unchanged_when_every_deduplicated_record_was_screened() -> None:
    prisma = {"records_after_dedup": 120, "title_abstract_screened": 120}

    assert WritingAgent(lang="zh")._screening_entry_phrase(prisma, "经去重后剩余120条") == "经去重后剩余120条进入题名/摘要筛选"


# ── manuscript_content: calculation detail from the engine record ─────────


def test_calculation_appendix_is_rendered_from_the_engine_record() -> None:
    notes = WritingAgent(lang="zh")._computation_record_notes({"synthesis_result": MA001_SYNTHESIS}, MA001_ROWS)
    text = "\n\n".join(notes)

    assert "合并效应估计为MD -303.23（标准误102.70；95% CI -504.52至-101.93）；95%预测区间为-2730.38至2123.93。" in text
    assert "Alexandru 2016 -329.70（方差7363.49）" in text
    assert "Montovanelli 2021 -112.50（方差5984.61）" in text
    assert "异质性统计量为Cochran Q=12.03，I²=83.4%，tau²=25941.694。" in text
    assert "HKSJ敏感性分析得到MD -303.02（95% CI -759.43至153.40）。" in text
    # I² = 83.4% is not "low": the appendix reports statistics, not an adjective.
    assert "异质性较低" not in text
    assert _has_calculation_detail(text) is True


def test_calculation_appendix_falls_back_without_an_engine_record() -> None:
    assert WritingAgent(lang="en")._computation_record_notes({}, MA001_ROWS) == []


# ── cross_references ──────────────────────────────────────────────────────


def _ma001_like_manuscript() -> str:
    return "\n".join([
        "# 氨甲环酸Meta分析",
        "",
        "## 结果",
        "",
        "检索与筛选：共检索到400条记录，最终3项随机对照试验符合纳入标准。",
        "",
        "纳入研究与人群：3项随机对照试验共266名成年患者进入主要分析。",
        "",
        "主要合并效应：合并均数差（MD）为-303.23 mL（95% CI -504.52 至 -101.93）。",
        "",
        "证据确定性：该比较的GRADE证据确定性为极低。",
        "",
        "## 讨论",
        "",
        "本Meta分析纳入3项随机对照试验。",
        "",
        "## 表格",
        "### 表1. 选定主要分析行的基本特征",
        "| 研究 | 报告位置 |",
        "|---|---|",
        "| Alexandru 2016 | Table 3 |",
        "",
        "### 表2. 设计校正后的研究层效应",
        "| 研究 | MD |",
        "|---|---:|",
        "| Alexandru 2016 | -329.70 |",
        "",
        "### 表3. GRADE证据概要",
        "| 结局 | 确定性 |",
        "|---|---|",
        "| 总失血量 | 极低 |",
        "",
        "## 图表",
        "### 图1. PRISMA流程图",
        "![图1. PRISMA流程图](../figures/prisma_diagram.png)",
        "### 图2. 总失血量森林图",
        "![图2. 总失血量森林图](../figures/forest_plot.png)",
        "### 图3. 偏倚风险概要",
        "![图3. 偏倚风险概要](../figures/rob_summary.png)",
        "",
        "## 参考文献",
        "［1］ Example.",
        "",
    ])


MA001_FACTS = {
    "prisma": {"records_identified": 400},
    "primary_effect": {"pooled_effect": -303.2265806852571, "effect_measure": "MD"},
    "primary_population": {"selected_total_participants": 266},
}


def test_every_defined_table_and_figure_gets_a_generated_reference(tmp_path: Path) -> None:
    text, records = generate_table_figure_cross_references(_ma001_like_manuscript(), MA001_FACTS)
    project = Project("cross references", output_dir=tmp_path)
    project.save_text("draft.md", text, subdir="manuscript")

    audit = _build_cross_reference_audit_review(project)

    assert audit["passed"] is True, audit["issues"]
    assert len(records) == 6
    paragraphs = {line.split("：")[0]: line for line in text.splitlines() if "：" in line}
    assert paragraphs["检索与筛选"].endswith("检索与筛选流程见图1。")
    assert paragraphs["纳入研究与人群"].endswith("纳入研究的基本特征见表1。")
    assert paragraphs["主要合并效应"].endswith("各研究的效应量、标准误和权重见表2。各研究结果的森林图见图2。")
    assert paragraphs["证据确定性"].endswith("证据确定性（GRADE）概要见表3。偏倚风险评价见图3。")
    # Generated, and idempotent: a second pass adds nothing.
    assert generate_table_figure_cross_references(text, MA001_FACTS) == (text, [])


def test_generated_references_carry_no_quantitative_claim() -> None:
    _text, records = generate_table_figure_cross_references(_ma001_like_manuscript(), MA001_FACTS)

    assert records
    assert not [record["sentence"] for record in records if _sentence_has_numeric_effect_claim(record["sentence"])]


def test_items_already_cited_in_the_text_are_left_alone() -> None:
    manuscript = _ma001_like_manuscript().replace(
        "最终3项随机对照试验符合纳入标准。",
        "最终3项随机对照试验符合纳入标准（图1）。纳入研究见表1，效应量见表2，GRADE见表3，森林图见图2，偏倚风险见图3。",
    )

    assert generate_table_figure_cross_references(manuscript, MA001_FACTS) == (manuscript, [])


# ── readability ───────────────────────────────────────────────────────────

# Verbatim from the ma-001 Discussion (116 units; gate limit 100).
MA001_SEMICOLON_SENTENCE = (
    "本综述未获得绝对效应数据，因此无法量化氨甲环酸减少围手术期总失血量的绝对临床获益；"
    "GRADE 不精确性判断要求将置信区间与预测区间同预设的最小重要效应或决策阈值进行比较［13］，"
    "而本综述未报告此类阈值，因此该合并效应量是否达到临床可感知的差异幅度仍无法判断。"
)
# Verbatim from the ma-001 Discussion (119 units): a colon-led list.
MA001_COLON_LIST_SENTENCE = (
    "在适用性方面，纳入研究在干预方案与对照定义上并不一致：一项研究采用按体重给药的局部方案（15 mg/kg 溶于100 mL生理盐水），"
    "而非常用的固定关节腔内剂量［3］；另一项研究的治疗组在氨甲环酸之外合并使用双极电凝作为共同干预［1］；"
    "部分研究的对照为不使用氨甲环酸而非安慰剂［3］。"
)


def test_top_level_semicolon_between_clauses_is_split_without_changing_a_word() -> None:
    body, splits = split_overlong_sentences(f"\n{MA001_SEMICOLON_SENTENCE}\n", language="zh")

    assert len(splits) == 1
    assert body == "\n" + MA001_SEMICOLON_SENTENCE.replace("获益；GRADE", "获益。GRADE") + "\n"
    assert overlong_interpretive_sentences(f"## 讨论\n{body}") == []


def test_colon_led_list_and_bracketed_semicolons_are_not_split() -> None:
    parenthetical = (
        "在成年初次单侧全膝关节置换术患者中，与安慰剂或不使用氨甲环酸相比，围手术期经静脉、局部或联合途径使用氨甲环酸"
        "可能减少围手术期总失血量（MD -303.23，95% CI -504.52 至 -101.93；原研究未报告单位），"
        "该合并估计基于3项随机对照试验、共266例受试者［1，2］。"
    )
    body = f"{MA001_COLON_LIST_SENTENCE}\n\n{parenthetical}\n"

    assert split_overlong_sentences(body, language="zh") == (body, [])


def test_english_semicolon_split_capitalizes_the_next_clause() -> None:
    sentence = (
        "The pooled estimate favoured tranexamic acid across three trials that differed in dose, route, timing, "
        "and the definition of blood loss used by each report, and in the populations that were enrolled; the "
        "prediction interval was wide and crossed the line of no effect, so the size of benefit in a new surgical "
        "setting remains uncertain for surgeons and for the patients they treat."
    )

    body, splits = split_overlong_sentences(sentence, language="en")

    assert len(splits) == 1
    assert "were enrolled. The prediction interval" in body


def test_a_split_is_accepted_only_when_it_changes_no_fact() -> None:
    faithful = MA001_COLON_LIST_SENTENCE.replace("不一致：", "不一致。").replace("［3］；", "［3］。").replace("［1］；", "［1］。")

    assert sentence_split_issues(MA001_COLON_LIST_SENTENCE, faithful, language="zh") == []
    assert "negation_or_hedge_changed" in sentence_split_issues(
        MA001_COLON_LIST_SENTENCE, faithful.replace("不使用", "使用"), language="zh"
    )
    assert "numbers_changed" in sentence_split_issues(
        MA001_COLON_LIST_SENTENCE, faithful.replace("15 mg/kg", "20 mg/kg"), language="zh"
    )
    assert "citations_changed_or_moved" in sentence_split_issues(
        MA001_COLON_LIST_SENTENCE, faithful.replace("双极电凝作为共同干预［1］", "双极电凝［1］作为共同干预"), language="zh"
    )
    assert "not_split" in sentence_split_issues(
        MA001_COLON_LIST_SENTENCE, MA001_COLON_LIST_SENTENCE.replace("；", "，"), language="zh"
    )


def _discussion_manuscript() -> str:
    return "\n".join([
        "# 标题",
        "## 结果",
        "主要合并效应为MD -303.23。",
        "## 讨论",
        MA001_SEMICOLON_SENTENCE,
        "",
        MA001_COLON_LIST_SENTENCE,
        "## 结论",
        "氨甲环酸可能减少总失血量。",
        "## 参考文献",
        "［1］ Example.",
        "",
    ])


class _StubSplitter(WritingAgent):
    def __init__(self, replacement: str):
        super().__init__(lang="zh")
        self.replacement = replacement
        self.prompts: list[str] = []

    def call_llm_structured(self, prompt, schema, **kwargs):  # noqa: D401 - test double
        assert schema is SentenceSplitRevision
        self.prompts.append(prompt)
        return SentenceSplitRevision(rewrites=[SentenceSplitRewrite(index=0, replacement=self.replacement)])


def test_residual_overlong_sentence_takes_the_models_faithful_split(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(config, "LLM_API_KEY", "test-key")
    faithful = MA001_COLON_LIST_SENTENCE.replace("不一致：", "不一致。").replace("［3］；", "［3］。").replace("［1］；", "［1］。")
    agent = _StubSplitter(faithful)
    project = Project("sentence split", output_dir=tmp_path)

    text, audit = agent._apply_release_conformance(_discussion_manuscript(), {}, project=project)

    assert len(audit["deterministic_sentence_splits"]) == 1
    assert [item["replacement"] for item in audit["model_sentence_splits"]["accepted"]] == [faithful]
    assert audit["remaining_overlong_sentences"] == []
    assert "100 counted units" in agent.prompts[0]
    project.save_text("draft.md", text, subdir="manuscript")
    assert _build_readability_audit_review(project)["passed"] is True
    audit_path = project.base_dir / "manuscript" / "release_conformance_audit.json"
    saved = json.loads(audit_path.read_text())
    assert [item["model_sentence_splits"]["status"] for item in saved["passes"]] == ["ok"]
    # A later save with nothing left to do keeps the record of the pass that did the work.
    agent._apply_release_conformance(text, {}, project=project)
    again = json.loads(audit_path.read_text())
    assert len(again["passes"]) == 1 and again["remaining_overlong_sentences"] == []


def test_an_unfaithful_split_is_rejected_and_left_as_the_gates_finding(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(config, "LLM_API_KEY", "test-key")
    unfaithful = MA001_COLON_LIST_SENTENCE.replace("不一致：", "不一致。").replace("［3］；", "［3］。").replace(
        "［1］；", "［1］。"
    ).replace("不使用", "使用")
    agent = _StubSplitter(unfaithful)

    text, audit = agent._apply_release_conformance(_discussion_manuscript(), {}, project=None)

    assert MA001_COLON_LIST_SENTENCE in text
    assert audit["model_sentence_splits"]["rejected"][0]["issues"] == ["negation_or_hedge_changed"]
    assert [item["units"] for item in audit["remaining_overlong_sentences"]] == [119]


def test_no_model_call_without_a_configured_key(monkeypatch) -> None:
    monkeypatch.setattr(config, "LLM_API_KEY", "")
    agent = _StubSplitter("unused")

    _text, audit = agent._apply_release_conformance(_discussion_manuscript(), {}, project=None)

    assert agent.prompts == []
    assert audit["model_sentence_splits"] == {"status": "skipped", "reason": "missing_llm_api_key"}


# ── the save-time hook ────────────────────────────────────────────────────


def _no_model(*_args, **_kwargs):
    raise RuntimeError("no model in offline tests")


def test_saved_draft_carries_generated_references(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(config, "LLM_API_KEY", "")
    monkeypatch.setattr(WritingAgent, "call_llm_structured", _no_model)
    monkeypatch.setattr(WritingAgent, "call_llm", _no_model)
    project = Project("save hook", output_dir=tmp_path)
    agent = WritingAgent(lang="zh")

    agent._quality_checked_validation(_ma001_like_manuscript(), MA001_FACTS, {"passed": True, "issues": []}, project=project)

    saved = project.load_text("draft.md", subdir="manuscript")
    assert agent._quality_checked_manuscript == saved
    assert "检索与筛选流程见图1。" in saved
    assert _build_cross_reference_audit_review(project)["passed"] is True


def test_cli_finalization_saves_the_conformed_text(tmp_path: Path, monkeypatch) -> None:
    import new_meta.main as main_module

    monkeypatch.setattr(config, "LLM_API_KEY", "")
    monkeypatch.setattr(WritingAgent, "call_llm_structured", _no_model)
    monkeypatch.setattr(WritingAgent, "call_llm", _no_model)
    project = Project("cli finalize", output_dir=tmp_path)
    project.save_json("manuscript_facts.json", MA001_FACTS, subdir="manuscript")

    finalized, _validation = main_module._finalize_manuscript_after_postprocessing(
        project,
        _ma001_like_manuscript(),
        lang="zh",
    )

    assert "纳入研究的基本特征见表1。" in finalized


# ── numbers carry the engine's bytes ──────────────────────────────────────


def test_a_retyped_unicode_minus_becomes_the_engines_ascii_minus(tmp_path: Path) -> None:
    from new_meta.agents.writing.release_conformance import normalize_number_signs
    from new_meta.core.artifact_package import _build_claim_support_audit_review

    # Verbatim from the ma-001 run-12 abstract, as the final revision retyped it.
    typed = "与安慰剂或不使用氨甲环酸相比，围手术期经静脉、局部或联合给药氨甲环酸的合并均数差（MD）为 −303.23 mL（95% CI −504.52 至 −101.93 mL）。"
    ranged = "HR 0.81（95% CI 0.74–0.88）"

    text, count = normalize_number_signs(typed + ranged)

    assert count == 3
    assert text == typed.replace("−", "-") + ranged
    project = Project("minus signs", output_dir=tmp_path)
    project.save_json(
        "manuscript_facts.json",
        {"primary_effect": {"effect_measure": "MD", "pooled_effect": -303.2265806852571,
                            "ci_lower": -504.51984194942247, "ci_upper": -101.93331942109168}},
        subdir="manuscript",
    )

    def unsupported(body: str) -> int:
        project.save_text("draft.md", f"# 标题\n\n## 结论\n\n{body}\n", subdir="manuscript")
        return _build_claim_support_audit_review(project)["summary"]["unsupported_claims"]

    # The retyped bytes read as +303.23; the engine's bytes match the facts.
    assert unsupported(typed) == 1
    assert unsupported(text) == 0


MA001_PRIMARY_FACTS = {
    "primary_effect": {
        "effect_measure": "MD",
        "pooled_effect": -303.2265806852571,
        "ci_lower": -504.51984194942247,
        "ci_upper": -101.93331942109168,
        "prediction_lower": -2730.381643234127,
        "prediction_upper": 2123.928481863613,
    },
    "studies": [{"effect": -329.69999999999993}, {"effect": -458.0}, {"effect": -112.5}],
}


def test_rounded_primary_numbers_are_written_back_as_the_engine_renders_them(tmp_path: Path) -> None:
    from new_meta.core.artifact_package import _build_claim_support_audit_review
    from new_meta.core.manuscript_numbers import rendered_primary_numbers, restore_rendered_primary_numbers

    # Verbatim from the ma-001 run-14 Conclusion, authored from the raw floats.
    typed = (
        "在初次单侧全膝关节置换术的成年患者中，围手术期氨甲环酸与安慰剂或不使用氨甲环酸相比，"
        "合并估计提示围手术期总失血量可能减少（MD -303.2 mL，95% CI -504.5～-101.9 mL）。"
    )
    table_row = "| Total blood loss | MD -303.2 (95% CI -504.5 to -101.9) | 极低 |"

    text, restored = restore_rendered_primary_numbers(f"{typed}\n{table_row}\n", MA001_PRIMARY_FACTS)

    assert text.splitlines()[0] == typed.replace("-303.2 mL", "-303.23 mL").replace(
        "-504.5～-101.9", "-504.52～-101.93"
    )
    assert text.splitlines()[1] == table_row
    assert [item["rendered"] for item in restored] == ["-303.23", "-504.52", "-101.93"]
    assert restore_rendered_primary_numbers(text, MA001_PRIMARY_FACTS)[1] == []
    assert rendered_primary_numbers(MA001_PRIMARY_FACTS)["prediction_upper"] == "2123.93"
    project = Project("rounded numbers", output_dir=tmp_path)
    project.save_json("manuscript_facts.json", MA001_PRIMARY_FACTS, subdir="manuscript")

    def unsupported(body: str) -> int:
        project.save_text("draft.md", f"# 标题\n\n## 结论\n\n{body}\n", subdir="manuscript")
        return _build_claim_support_audit_review(project)["summary"]["unsupported_claims"]

    assert unsupported(typed) == 1
    assert unsupported(text.splitlines()[0]) == 0


def test_a_rounding_that_could_be_another_fact_is_left_alone() -> None:
    from new_meta.core.manuscript_numbers import restore_rendered_primary_numbers

    facts = {
        "primary_effect": {"pooled_effect": -112.54, "ci_lower": -200.0, "ci_upper": -20.0},
        "studies": [{"effect": -112.5}],
    }

    assert restore_rendered_primary_numbers("Montovanelli 2021为-112.5 mL。", facts) == ("Montovanelli 2021为-112.5 mL。", [])


# ── Table 1 shows the row's own numbers, never a fabricated 0/0 ───────────


def test_continuous_study_table_shows_each_rows_estimate_not_event_counts() -> None:
    rows = [
        {
            "study_id": "study:28326403",
            "study_label": "Alexandru 2016",
            "source_location": "Table 3",
            "timepoint": "perioperative",
            "effect_size": -329.69999999999993,
            "ci_lower": -497.88601752716465,
            "ci_upper": -161.5139824728352,
            "source_quote_verified": True,
        },
        {
            "study_id": "study:34566475",
            "study_label": "Montovanelli 2021",
            "source_location": "Table 5 (Drained Blood, ml)",
            "timepoint": "24 hours after surgery",
            "effect_size": -112.5,
            "source_quote_verified": True,
        },
    ]

    table = WritingAgent(lang="zh")._generic_study_table(rows, {}, "MD")

    assert "| Alexandru 2016 | Table 3 | perioperative | -329.70（-497.89至-161.51） | 报告摘录支持 |" in table
    assert "| Montovanelli 2021 | Table 5 (Drained Blood, ml) | 24 hours after surgery | -112.50 | 报告摘录支持 |" in table
    assert "0/0" not in table


def test_dichotomous_study_table_marks_missing_denominators_as_not_reported() -> None:
    rows = [
        {"study_id": "S1", "study_label": "Trial A", "events_intervention": 3, "total_intervention": 40,
         "events_control": 9, "total_control": 41},
        {"study_id": "S2", "study_label": "Trial B", "effect": 0.8},
    ]

    table = WritingAgent(lang="en")._generic_study_table(rows, {}, "OR")

    assert "| 3/40 | 9/41 |" in table
    assert "| NR | NR | 0.80 |" in table


@pytest.mark.parametrize("language", ["zh", "en"])
def test_writer_prompts_carry_the_gate_limit(language: str) -> None:
    from new_meta.core.readability import sentence_length_rule

    rule = sentence_length_rule(language)
    assert ("100 counted units" if language == "zh" else "55 words") in rule
