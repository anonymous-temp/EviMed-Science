"""Markdown report renderer.

Structure (aligned with the approved rewrite plan):
    概览 -> 输入归一 -> 病例概览(人口学/结局/国别/合并用药/适应症)
    -> 信号分析(信号表) -> 重点 ADR 解读 -> 说明书对照 -> 循证证据
    -> 局限性声明 -> 数据来源与可追溯 URL 附录

Rendering rules:
- every number is taken verbatim from AnalysisResult (openFDA + signals
  layers); the renderer never recomputes anything;
- the markdown table and the CSV export are built from the same SignalRow
  list with the same formatters (markdown shows a summarized view, the
  CSV carries full precision), so the two can never disagree;
- when the run degraded (no LLM), the narrative sections are replaced by
  an explicit methodology note instead of being silently omitted.
"""

from __future__ import annotations

import csv
import io
from datetime import timezone

from safety_agent.analysis.models import AnalysisResult, CountBucket, SignalRow

_AGENT_NAME = "EviMed 药品安全性专项 Agent(safety_agent)"

_BASE_LIMITATIONS = [
    "本报告为自发报告数据库(FAERS)的失比例信号**筛查**结果;信号不等于因果关系,不能据此判定该药导致某不良反应。",
    "FAERS 报告数**不能用于推算不良反应发生率**;数据库存在漏报、重复报告、适应证偏倚(protopathic bias)与媒体驱动报告(Weber 效应)等已知偏倚。",
    "FAERS 由美国 FDA 管理但包含全球来源的自发报告;本分析不含 WHO VigiBase 与中国国家药品不良反应监测数据库。",
    "年龄分布按 patientonsetage 原始数值分桶,未区分年龄单位,仅为近似。",
    "LLM 仅用于文字解读与说明书对照,不参与任何数值计算。",
]

_LLM_DEGRADED_NOTE = (
    "**方法学声明:本次运行 LLM 解读缺失({reason})。**"
    "以下内容为纯统计结果:信号表、病例概览与说明书对照状态均由确定性流程产出,"
    "缺失的「重点 ADR 解读」等叙述性段落不影响任何数值的有效性。"
)


def render_markdown(result: AnalysisResult) -> str:
    """Render the full Chinese Markdown report from one AnalysisResult."""
    p: list[str] = []
    add = p.append

    add(f"# {result.drug_normalized} — FAERS 药物安全性分析报告")
    add("")
    add(f"**生成时间**:{result.generated_at.astimezone(timezone.utc):%Y-%m-%d %H:%M UTC}  ")
    add(f"**分析工具**:{_AGENT_NAME}  ")
    data_source = (
        f"冻结 FAERS 快照({result.snapshot_id})"
        if result.data_source == "frozen_faers"
        else "FAERS,经 openFDA live API 访问"
    )
    add(f"**数据源**:{data_source}  ")
    add("**分析指标**:ROR、PRR、χ²、IC/IC025(BCPNN)、EBGM/EB05(GPS)  ")
    add("**信号判定规则**:a≥3 且(ROR 95%CI 下限>1 或(PRR≥2 且 χ²≥4))  ")
    add("")
    add("---")
    add("")

    _section_overview(add, result)
    _section_normalization(add, result)
    _section_case_profile(add, result)
    _section_signals(add, result)
    _section_focus_adrs(add, result)
    _section_label_check(add, result)
    _section_evidence(add, result)
    _section_limitations(add, result)
    _section_appendix(add, result)

    add("---")
    add("")
    add(
        f"*本报告由 {_AGENT_NAME} 自动生成。定量结果由确定性统计路径产生;"
        "live 结果按附录查询复核,冻结结果按快照来源与哈希复核;LLM 不参与数值计算。*"
    )
    return "\n".join(p) + "\n"


def signal_table_csv(result: AnalysisResult) -> str:
    """CSV export of the signal table — same rows as the markdown table."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(_SIGNAL_HEADERS)
    for row in result.signals:
        writer.writerow(_signal_row_cells(row))
    return buf.getvalue()


# -- sections ------------------------------------------------------------------


def _section_overview(add, result: AnalysisResult) -> None:
    add("## 1. 分析概览")
    add("")
    add(f"- **目标药品**:{result.drug_normalized}(原始输入:{result.drug_query})")
    requested = [r.normalized for r in result.reactions if r.normalized]
    add(
        "- **目标 ADR**:"
        + ("、".join(requested) if requested else "未指定(仅自动筛查 top PT)")
    )
    add(f"- **FAERS 报告总数(该药)**:{_int(result.overview.total_reports)} 份")
    add(f"- **药品角色口径**:{'、'.join(result.suspect_roles) or '未限定'}")
    add(f"- **药名/角色绑定**:{result.suspect_binding}")
    if result.study_date_from or result.study_date_to:
        add(
            f"- **研究时间窗**:{result.study_date_from or 'open'} 至 "
            f"{result.study_date_to or 'open'}"
        )
    prior_label = "fitted" if result.gps_prior_fitted else "unfitted-starting-prior"
    prior_id = f" ({result.gps_prior_id})" if result.gps_prior_id else ""
    add(f"- **统计版本**:{result.statistics_version};GPS prior={prior_label}{prior_id}")
    signal_count = sum(1 for r in result.signals if r.is_signal)
    add(
        f"- **信号筛查范围**:{len(result.signals)} 个 PT,其中 {signal_count} 个满足信号判定规则"
    )
    add("")
    if result.interpretation and result.interpretation.overview:
        add(result.interpretation.overview)
        add("")


def _section_normalization(add, result: AnalysisResult) -> None:
    add("## 2. 输入归一")
    add("")
    add("| 环节 | 输入 | 归一结果 | 方法 | 置信度 |")
    add("|---|---|---|---|---|")
    candidates = "、".join(result.drug_candidates[:3]) or "—"
    add(
        f"| 药品 | {result.drug_query} | {result.drug_normalized} "
        f"| 规则+openFDA(候选:{candidates}) | — |"
    )
    for reaction in result.reactions:
        add(
            f"| ADR | {reaction.query} | {reaction.normalized or '未命中'} "
            f"| {reaction.method} | {reaction.confidence:.2f} |"
        )
    add("")


def _section_case_profile(add, result: AnalysisResult) -> None:
    overview = result.overview
    itp = result.interpretation
    add("## 3. 病例概览(FAERS)")
    add("")
    add(f"该药在 FAERS 中共有 **{_int(overview.total_reports)}** 份报告。")
    add("")
    add("### 3.1 年度趋势")
    add("")
    _bucket_table(add, overview.yearly, "年份", "报告数")
    add("### 3.2 性别与年龄分布")
    add("")
    add("**性别**:")
    add("")
    _bucket_table(add, overview.sex, "性别", "报告数")
    add("**年龄段**(按 patientonsetage 原始数值,未区分单位,为近似分布):")
    add("")
    _bucket_table(add, overview.age_buckets, "年龄段", "报告数")
    if itp and itp.demographics:
        add(itp.demographics)
        add("")
    add("### 3.3 结局分布(严重结局计数,同一报告可计入多类)")
    add("")
    _bucket_table(add, overview.outcomes, "结局", "报告数")
    if itp and itp.outcomes:
        add(itp.outcomes)
        add("")
    add("### 3.4 报告国别(top 10)")
    add("")
    _bucket_table(add, overview.countries, "国别代码", "报告数")
    add("### 3.5 合并用药(top 10,已剔除目标药本身)")
    add("")
    _bucket_table(add, overview.concomitant_drugs, "药品", "报告数")
    add("### 3.6 适应症(top 10)")
    add("")
    _bucket_table(add, overview.indications, "适应症", "报告数")


_SIGNAL_HEADERS = [
    "reaction", "source", "a", "b", "c", "d", "N",
    "ROR", "ROR_lo", "ROR_hi", "PRR", "PRR_lo", "PRR_hi",
    "chi2", "IC", "IC025", "EBGM", "EB05", "expected_count",
    "haldane_anscombe_applied", "gps_prior_id", "is_signal",
]


def _section_signals(add, result: AnalysisResult) -> None:
    add("## 4. 失比例信号分析")
    add("")
    add(
        "2×2 列联表定义:a=目标药且目标 ADR 的报告数,b=目标药其他 ADR,"
        "c=其他药目标 ADR,d=其他药其他 ADR(d=N−a−b−c,N 为 FAERS 全库)。"
        "任一单元格为 0 时按 Haldane-Anscombe 法(+0.5)校正并在 CSV 中标记。"
    )
    add("")
    add("| ADR (PT) | 来源 | a | ROR [95%CI] | PRR [95%CI] | χ² | IC (IC025) | EBGM (EB05) | 信号 |")
    add("|---|---|---|---|---|---|---|---|---|")
    for row in result.signals:
        add(
            f"| {row.reaction} | {'指定' if row.source == 'user-specified' else 'top'} "
            f"| {_int(row.a)} "
            f"| {_f(row.ror)} [{_f(row.ror_ci95_lower)}, {_f(row.ror_ci95_upper)}] "
            f"| {_f(row.prr)} [{_f(row.prr_ci95_lower)}, {_f(row.prr_ci95_upper)}] "
            f"| {_f(row.chi2)} | {_f(row.ic)} ({_f(row.ic025)}) "
            f"| {_f(row.ebgm)} ({_f(row.eb05)}) "
            f"| {'**是**' if row.is_signal else '否'} |"
        )
    add("")
    add(
        "全精度数值见同目录 signals.csv(与本表同源)。"
        "信号≠因果,详见第 8 节局限性声明。"
    )
    add("")
    if result.interpretation and result.interpretation.signal_commentary:
        add("### 4.1 信号解读")
        add("")
        add(result.interpretation.signal_commentary)
        add("")


def _section_focus_adrs(add, result: AnalysisResult) -> None:
    itp = result.interpretation
    add("## 5. 重点 ADR 解读")
    add("")
    if itp and itp.focus_adrs:
        for index, focus in enumerate(itp.focus_adrs, start=1):
            add(f"### 5.{index} {focus.reaction}")
            add("")
            add(focus.text)
            add("")
    else:
        reason = _degradation_reason(result)
        add(_LLM_DEGRADED_NOTE.format(reason=reason))
        add("")


def _section_label_check(add, result: AnalysisResult) -> None:
    add("## 6. 说明书对照(FDA label)")
    add("")
    check = result.label_check
    if check is None:
        add("未执行说明书对照(无目标 ADR 或 LLM 未配置)。")
        add("")
        return
    if check.status != "ok":
        add(f"说明书对照未完成:{check.note or check.status}")
        add("")
        return
    add("| ADR (PT) | 标注状态 | 证据(原文引用,章节) |")
    add("|---|---|---|")
    status_zh = {
        "labeled": "已标注",
        "partially_labeled": "部分标注",
        "unlabeled": "**未标注**",
    }
    for item in check.checks:
        quotes = (
            "<br>".join(f"“{q.sentence}”({q.section})" for q in item.quotes) or "—"
        )
        add(f"| {item.reaction} | {status_zh.get(item.status, item.status)} | {quotes} |")
    add("")
    if check.label_refs:
        add("对照用说明书记录:" + ";".join(check.label_refs))
        add("")
    if check.note:
        add(f"对照说明:{check.note}")
        add("")
    if result.interpretation and result.interpretation.label_commentary:
        add(result.interpretation.label_commentary)
        add("")


def _section_evidence(add, result: AnalysisResult) -> None:
    add("## 7. 循证证据检索(EviMed)")
    add("")
    evidence = result.evidence
    if evidence is None or not evidence.enabled:
        note = evidence.note if evidence else "证据检索层未启用。"
        add(note)
        add("")
        return
    if evidence.items:
        add("| 标题 | 机构 | 年份 | 链接 |")
        add("|---|---|---|---|")
        for item in evidence.items:
            add(
                f"| {item.title} | {item.publisher or '—'} | {item.year or '—'} "
                f"| {item.url or '—'} |"
            )
        add("")
    if evidence.note:
        add(evidence.note)
        add("")


def _section_limitations(add, result: AnalysisResult) -> None:
    add("## 8. 局限性声明")
    add("")
    limitations = list(_BASE_LIMITATIONS)
    if result.data_source == "openfda_live":
        if result.suspect_binding == "report_contains_suspect_approximation":
            limitations.append(
                "openFDA live 聚合无法把目标药名与 suspect 角色绑定到同一 patient.drug[] 元素;"
                "当前队列是报告级近似,不得解释为 PS-only。"
            )
        else:
            limitations.append(
                "live 队列只按目标药名筛选,未限定该药在报告中的 PS/SS/C/I 角色。"
            )
        limitations.append(
            "2×2 单元格来自可变的 live count 查询;数据库更新后数值可能漂移。"
        )
    else:
        limitations.append(
            "冻结快照可精确绑定同一药品对象,但结果只适用于报告所列快照、时间窗、"
            "药品别名、角色代码和去重规则。"
        )
    if not result.gps_prior_fitted:
        limitations.append(
            "EBGM/EB05 使用未拟合的 GPS 优化起始先验(α1=0.2,β1=0.1,α2=2,β2=4,w=1/3);"
            "数值仅供探索,不能标作已完成全矩阵经验贝叶斯拟合。"
        )
    for i, item in enumerate(limitations, start=1):
        add(f"{i}. {item}")
    add("")
    if result.degradation_notes:
        add("**本次运行的降级与未启用项**:")
        add("")
        for note in result.degradation_notes:
            add(f"- {note}")
        add("")


def _section_appendix(add, result: AnalysisResult) -> None:
    add("## 附录:数据来源与可追溯查询")
    add("")
    if result.snapshot_id:
        add(f"- 快照 ID:`{result.snapshot_id}`")
        add(f"- 快照来源:{result.snapshot_source or '未提供'}")
        add(f"- 快照 SHA-256:`{result.snapshot_sha256 or '未提供'}`")
        add(f"- 快照提取时间:`{result.snapshot_extracted_at or '未提供'}`")
        add(f"- 去重规则:`{result.snapshot_deduplication or '未提供'}`")
        add("")
    add("| 用途 | URL |")
    add("|---|---|")
    labels = {
        "drug_total": "目标药报告总数",
        "grand_total": "FAERS 全库总数(N)",
        "top_pt_counts": "目标药 PT 频数(top 筛查)",
        "label_search": "说明书检索",
    }
    for key, url in result.query_urls.items():
        label = labels.get(key, key.replace("signal_joint", "2×2·联合计数").replace("signal_event", "2×2·事件计数"))
        add(f"| {label} | `{url}` |")
    add("")
    add(f"检索日期:{result.generated_at.astimezone(timezone.utc):%Y-%m-%d}")
    add("")


# -- shared row builders ---------------------------------------------------------


def _signal_row_cells(row: SignalRow) -> list[str]:
    """One signal row as strings — shared by the markdown table and the CSV."""
    return [
        row.reaction,
        row.source,
        _int(row.a), _int(row.b), _int(row.c), _int(row.d), _int(row.n),
        _f(row.ror), _f(row.ror_ci95_lower), _f(row.ror_ci95_upper),
        _f(row.prr), _f(row.prr_ci95_lower), _f(row.prr_ci95_upper),
        _f(row.chi2), _f(row.ic), _f(row.ic025), _f(row.ebgm), _f(row.eb05),
        _f(row.expected_count) if row.expected_count is not None else "",
        "yes" if row.haldane_anscombe_applied else "no",
        row.gps_prior_id or "",
        "yes" if row.is_signal else "no",
    ]


def _bucket_table(add, buckets: list[CountBucket], term_header: str, count_header: str) -> None:
    if not buckets:
        add("_(无数据)_")
        add("")
        return
    add(f"| {term_header} | {count_header} |")
    add("|---|---|")
    for bucket in buckets:
        add(f"| {bucket.term} | {_int(bucket.count)} |")
    add("")


def _degradation_reason(result: AnalysisResult) -> str:
    if result.llm_status == "not_configured":
        return "LLM 未配置"
    for note in result.degradation_notes:
        if "LLM" in note:
            return note
    return "LLM 调用失败"


def _f(value: float) -> str:
    return f"{value:.3f}"


def _int(value: float) -> str:
    return f"{value:,.0f}"
