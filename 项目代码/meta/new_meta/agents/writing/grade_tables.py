"""GRADE certainty tables, rationales and the fallback audit tables."""
from __future__ import annotations

import re

from new_meta.core.project import Project


class GradeTablesMixin:
    """GRADE certainty tables, rationales and the fallback audit tables."""

    def _fallback_grade_table(self, grade: dict) -> str:
        domains = grade.get("domains") if isinstance(grade, dict) else None
        certainty = grade.get("certainty", "Not assessed") if isinstance(grade, dict) else "Not assessed"
        effect_summary = grade.get("effect_summary", "") if isinstance(grade, dict) else ""
        lines = (
            [
                "| 结局 | 效应 | 确定性 | 领域 | 判断 | 理由 |",
                "|---|---|---|---|---|---|",
            ]
            if self._zh else
            [
                "| Outcome | Effect | Certainty | Domain | Judgment | Rationale |",
                "|---|---|---|---|---|---|",
            ]
        )
        if self._zh:
            facts = getattr(self, "_manuscript_facts", {}) if isinstance(getattr(self, "_manuscript_facts", {}), dict) else {}
            fact_primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
            fact_pico = facts.get("pico") if isinstance(facts.get("pico"), dict) else {}
            fact_outcome = self._reporting_outcome_label(facts, None, zh=True) if facts else str(
                fact_primary.get("outcome_name") or fact_pico.get("primary_outcome") or grade.get("outcome_name") or "主要结局"
            )
            outcome_name = self._zh_concise_outcome_label(
                fact_outcome if facts else self._concise_outcome_label(grade.get("outcome_name") or "主要结局")
            ) if isinstance(grade, dict) else "主要结局"
            certainty_text = self._zh_grade_certainty(certainty)
            effect_summary_text = self._zh_effect_summary(effect_summary or "NR")
        else:
            facts = getattr(self, "_manuscript_facts", {}) if isinstance(getattr(self, "_manuscript_facts", {}), dict) else {}
            fact_primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
            fact_pico = facts.get("pico") if isinstance(facts.get("pico"), dict) else {}
            fact_outcome = self._reporting_outcome_label(facts, None, zh=False) if facts else str(
                fact_primary.get("outcome_name") or fact_pico.get("primary_outcome") or grade.get("outcome_name") or "primary outcome"
            )
            outcome_name = self._concise_outcome_label(
                fact_outcome if facts else grade.get("outcome_name") or "28-day all-cause mortality"
            ) if isinstance(grade, dict) else "28-day all-cause mortality"
            certainty_text = certainty
            effect_summary_text = effect_summary or "NR"
        if not domains:
            if self._zh:
                lines.append(f"| {self._md_cell(outcome_name)} | {self._md_cell(effect_summary_text)} | {self._md_cell(certainty_text)} | 未正式评价 | NR | 未获得完整GRADE领域细节。 |")
            else:
                lines.append(f"| {self._md_cell(outcome_name)} | {self._md_cell(effect_summary_text)} | {self._md_cell(certainty_text)} | Not assessed | NR | No GRADE domain details were available. |")
            return "\n".join(lines)
        for domain in domains:
            if self._zh:
                row = [
                    self._md_cell(outcome_name),
                    self._md_cell(effect_summary_text),
                    self._md_cell(certainty_text),
                    self._md_cell(self._zh_grade_domain_label(domain.get("domain") or "NR")),
                    self._md_cell(self._zh_grade_rating_label(domain.get("rating") or "NR")),
                    self._md_cell(self._grade_rationale_for_table(
                        domain,
                        zh=True,
                        outcome_name=str(grade.get("outcome_name") or ""),
                    )),
                ]
            else:
                row = [
                    self._md_cell(outcome_name),
                    self._md_cell(effect_summary_text),
                    self._md_cell(certainty_text),
                    self._md_cell(self._en_grade_domain_label(domain.get("domain") or "NR")),
                    self._md_cell(self._en_grade_rating_label(domain.get("rating") or "NR")),
                    self._md_cell(self._grade_rationale_for_table(
                        domain,
                        zh=False,
                        outcome_name=str(grade.get("outcome_name") or ""),
                    )),
                ]
            lines.append(
                "| "
                + " | ".join(row)
                + " |"
            )
        return "\n".join(lines)

    @staticmethod
    def _zh_grade_certainty(certainty: str) -> str:
        raw = re.sub(r"\s+", " ", str(certainty or "")).strip()
        low = raw.lower().replace("_", " ")
        labels = {
            "high": "高",
            "moderate": "中等",
            "low": "低",
            "very low": "极低",
            "not assessed": "未正式评价",
            "not formally assessed": "未正式评价",
        }
        if raw in {"高", "中等", "低", "极低", "未正式评价"}:
            return raw
        return labels.get(low, raw or "未正式评价")

    @staticmethod
    def _en_grade_domain_label(domain: str) -> str:
        raw = re.sub(r"\s+", " ", str(domain or "")).strip()
        low = raw.lower().replace(" ", "_")
        labels = {
            "risk_of_bias": "Risk of bias",
            "inconsistency": "Inconsistency",
            "indirectness": "Indirectness",
            "imprecision": "Imprecision",
            "publication_bias": "Publication bias",
        }
        return labels.get(low, raw or "Not assessed")

    @staticmethod
    def _en_grade_rating_label(rating: str) -> str:
        raw = re.sub(r"\s+", " ", str(rating or "")).strip()
        low = raw.lower().replace("_", " ")
        labels = {
            "no concern": "No serious concern",
            "no concerns": "No serious concern",
            "not serious": "No serious concern",
            "not downgraded": "No serious concern",
            "some concern": "Some concerns",
            "some concerns": "Some concerns",
            "serious": "Serious",
            "very serious": "Very serious",
            "not assessed": "Not assessed",
            "nr": "NR",
        }
        return labels.get(low, raw or "NR")

    @staticmethod
    def _zh_grade_domain_label(domain: str) -> str:
        raw = re.sub(r"\s+", " ", str(domain or "")).strip()
        low = raw.lower().replace(" ", "_")
        labels = {
            "risk_of_bias": "偏倚风险",
            "inconsistency": "不一致性",
            "indirectness": "间接性",
            "imprecision": "不精确性",
            "publication_bias": "发表偏倚",
        }
        return labels.get(low, raw or "未正式评价")

    @staticmethod
    def _zh_grade_rating_label(rating: str) -> str:
        raw = re.sub(r"\s+", " ", str(rating or "")).strip()
        low = raw.lower().replace("_", " ")
        labels = {
            "no concern": "无严重问题",
            "no concerns": "无严重问题",
            "not serious": "无严重问题",
            "not downgraded": "无严重问题",
            "some concerns": "存在一些问题",
            "some concern": "存在一些问题",
            "serious": "严重",
            "very serious": "非常严重",
            "not assessed": "未正式评价",
            "nr": "NR",
        }
        if raw in {"无严重问题", "存在一些问题", "严重", "非常严重", "未正式评价", "NR"}:
            return raw
        return labels.get(low, raw or "NR")

    @staticmethod
    def _zh_effect_summary(effect_summary: str) -> str:
        text = re.sub(r"\s+", " ", str(effect_summary or "")).strip()
        text = re.sub(
            r"\(95%\s*CI:?\s*([0-9.]+)\s+to\s+([0-9.]+)\)",
            r"（95% CI \1至\2）",
            text,
            flags=re.IGNORECASE,
        )
        text = re.sub(r"\s+（", "（", text)
        return text or "NR"

    @staticmethod
    def _grade_rationale_for_table(
        domain: dict,
        zh: bool = False,
        outcome_name: str = "",
    ) -> str:
        details = (domain or {}).get("details")
        domain_name = str((domain or {}).get("domain") or "").lower().replace(" ", "_")
        rating = str((domain or {}).get("rating") or "").lower().replace("_", " ")
        if isinstance(details, dict) and details:
            rendered = GradeTablesMixin._grade_rationale_from_details(
                domain_name=domain_name,
                rating=rating,
                details=details,
                zh=zh,
            )
            if rendered:
                return rendered
        rationale = str((domain or {}).get("rationale") or "NR")
        # Preserve the clinically specific wording used by cached legacy COVID-19
        # artifacts without leaking it into general-topic manuscripts.
        legacy_covid_mortality = bool(
            domain_name == "indirectness"
            and rating in {"serious", "very serious"}
            and re.search(r"\ball-cause mortality\b.*\b28\s*-?\s*days?\b", outcome_name, flags=re.I)
            and re.search(r"Rule-based P/I/C/O directness check", rationale, flags=re.I)
        )
        if legacy_covid_mortality:
            if zh:
                return (
                    "间接性主要来自危重症亚组提取、治疗方案与背景治疗差异，以及死亡率时间窗不完全一致；"
                    "这些因素限制了合并估计向具体患者场景的外推。"
                )
            return (
                "Indirectness reflected differences in critical-care subgroup extraction, treatment and background-care "
                "definitions, and mortality windows; these differences limit applicability to specific patient settings."
            )
        if zh:
            return GradeTablesMixin._zh_grade_rationale(rationale, domain_name=domain_name, rating=rating)
        return GradeTablesMixin._polish_grade_rationale(rationale, domain_name=domain_name, rating=rating)

    @staticmethod
    def _grade_rationale_from_details(domain_name: str, rating: str, details: dict, zh: bool = False) -> str:
        rating_key = str(rating or "").strip().lower()
        downgraded = rating_key in {"serious", "very serious", "严重", "非常严重"}

        if domain_name == "risk_of_bias":
            assessed = int(details.get("n_assessed") or 0)
            total = int(details.get("total_contributing") or assessed or 0)
            high = int(details.get("n_high") or 0)
            some = int(details.get("n_some") or 0)
            low = int(details.get("n_low") or 0)
            not_formal = int(details.get("n_not_formally_assessed") or 0)
            missing = int(details.get("n_missing_assessment") or max(total - assessed, 0))
            if zh:
                if assessed <= 0:
                    return "贡献研究缺少正式偏倚风险评价，需要人工方法学复核。"
                parts = [
                    f"{assessed}/{total}项贡献研究有偏倚风险资料",
                    f"{high}/{assessed}项高风险",
                    f"{some}/{assessed}项存在一些问题",
                    f"{low}/{assessed}项低风险",
                ]
                if not_formal:
                    parts.append(f"{not_formal}/{assessed}项未完成正式评价")
                if missing:
                    parts.append(f"{missing}/{total}项缺少正式评价")
                parts.append("因此因偏倚风险降级" if downgraded else "未因偏倚风险降级")
                return "；".join(parts) + "。"
            if assessed <= 0:
                return "No complete result-level risk-of-bias assessments were available; certainty was conservatively downgraded for unresolved bias."
            parts = [
                f"Risk-of-bias information was available for {assessed}/{total} contributing studies",
                f"{high}/{assessed} high risk",
                f"{some}/{assessed} with some concerns",
                f"{low}/{assessed} low risk",
            ]
            if not_formal:
                parts.append(f"{not_formal}/{assessed} not formally assessed")
            if missing:
                parts.append(f"{missing}/{total} contributing studies lacked formal RoB assessment")
            parts.append("a downgrade was applied for risk of bias" if downgraded else "no downgrade was applied for risk of bias")
            return "; ".join(parts) + "."

        if domain_name == "inconsistency":
            n = int(details.get("n_studies") or 0)
            i2 = details.get("i_squared")
            q_p = details.get("q_p_value")
            i2_text = f"I²={float(i2):.1f}%" if i2 is not None else "I²=NR"
            p_text = f"Chi² p={float(q_p):.3g}" if q_p is not None else "Chi² p=NR"
            if zh:
                if n <= 1:
                    return "仅1项研究贡献该结局，统计不一致性不适用。"
                pi_note = ""
                if details.get("prediction_interval") and details.get("prediction_interval_used_for_rating") is False:
                    pi_note = " 由于贡献研究少于3项，预测区间不用于降级判断。"
                return f"{n}项研究的异质性统计量为{i2_text}、{p_text}；" + ("因此因不一致性降级。" if downgraded else "未因不一致性降级。") + pi_note
            if n <= 1:
                return "Only one study contributed, so statistical inconsistency was not applicable."
            pi_note = ""
            if details.get("prediction_interval") and details.get("prediction_interval_used_for_rating") is False:
                pi_note = " The prediction interval was not used for downgrading because fewer than 3 studies contributed."
            return f"Heterogeneity was assessed across {n} studies ({i2_text}; {p_text}); " + ("a downgrade was applied for inconsistency." if downgraded else "no downgrade was applied for inconsistency.") + pi_note

        if domain_name == "indirectness":
            dims = details.get("dimensions") if isinstance(details.get("dimensions"), dict) else {}
            n = int(details.get("n_contributing") or 0)
            row_label = str(details.get("source_verified_row_label") or "outcome rows")
            if bool(details.get("source_verified_direct_rows")) and not downgraded:
                if zh:
                    return (
                        f"{n}/{n}项贡献研究的主要结局数据可追溯至原始来源；"
                        "研究人群、干预、对照和结局与综述问题足够一致，未因间接性降级。"
                    )
                return (
                    f"Primary outcome data were traceable to source reports for {n}/{n} contributing trials; "
                    "the population, intervention, comparator, and outcome were sufficiently aligned with the "
                    "review question, so no indirectness downgrade was applied."
                )
            signals: list[str] = []
            signal_labels = (
                (("人群", "population") if zh else ("population", "population")),
                (("干预", "intervention") if zh else ("intervention", "intervention")),
                (("对照", "comparator") if zh else ("comparator", "comparator")),
                (("结局", "outcome") if zh else ("outcome", "outcome")),
            )
            for label, key in signal_labels:
                item = dims.get(key) if isinstance(dims.get(key), dict) else {}
                mismatch = int(item.get("mismatch") or 0)
                unverified = int(item.get("unverified") or 0)
                if mismatch:
                    total = int(item.get("total") or n or mismatch)
                    signals.append(f"{label}{'不匹配' if zh else ' mismatch'} {mismatch}/{total}")
                if unverified:
                    total = int(item.get("total") or n or unverified)
                    signals.append(f"{label}{'信息未核验' if zh else ' information unverified'} {unverified}/{total}")
            if bool(details.get("surrogate_outcome")):
                signals.append("存在替代结局问题" if zh else "surrogate-outcome concern")
            if not signals and not downgraded:
                return "纳入研究与综述问题在主要人群、干预、对照和结局上基本直接；未因间接性降级。" if zh else "The contributing studies were sufficiently direct for the review question; no downgrade was applied for indirectness."
            if not signals:
                signals.append("目标问题与贡献证据之间存在适用性差异" if zh else "applicability differences between the target review question and contributing evidence")
            if zh:
                return "间接性判断考虑目标人群、干预、对照、结局和设计与综述问题的匹配程度：" + "；".join(signals) + ("；因此因间接性降级。" if downgraded else "；未因间接性降级。")
            return "Indirectness was judged by comparing the contributing evidence with the target population, intervention, comparator, outcome, and design: " + "; ".join(signals) + ("; a downgrade was applied for indirectness." if downgraded else "; no downgrade was applied for indirectness.")

        if domain_name == "imprecision":
            total_n = int(details.get("total_n") or 0)
            ois = int(details.get("ois") or 0)
            matched = int(details.get("matched_count") or 0)
            n_studies = int(details.get("n_studies") or 0)
            crosses = bool(details.get("crosses_null"))
            prediction = details.get("prediction_interval") if isinstance(details.get("prediction_interval"), list) else []
            prediction_text_zh = (
                f"；95%预测区间为{float(prediction[0]):.2f}至{float(prediction[1]):.2f}"
                if len(prediction) == 2 and all(item is not None for item in prediction) else ""
            )
            prediction_text_en = (
                f"; the 95% prediction interval was {float(prediction[0]):.2f} to {float(prediction[1]):.2f}"
                if len(prediction) == 2 and all(item is not None for item in prediction) else ""
            )
            if zh:
                cross_text = "跨越" if crosses else "未跨越"
                matched_text = f"，其中{matched}/{n_studies}项研究提供入池样本量" if matched and n_studies else ""
                size_text = f"入池比较共{total_n}名参与者{matched_text}"
                ois_text = f"；预设信息量为{ois}" if ois else ""
                return f"{size_text}{ois_text}；置信区间{cross_text}无效值{prediction_text_zh}；" + ("因此因不精确性降级。" if downgraded else "未因不精确性降级。")
            cross_text = "crossed" if crosses else "did not cross"
            matched_text = f" with participant counts from {matched}/{n_studies} studies" if matched and n_studies else ""
            ois_text = f"; the prespecified information size was {ois}" if ois else ""
            return f"The selected pooled rows included {total_n} participants{matched_text}{ois_text}; the confidence interval {cross_text} the null{prediction_text_en}; " + ("a downgrade was applied for imprecision." if downgraded else "no downgrade was applied for imprecision.")

        if domain_name == "publication_bias":
            n = int(details.get("n_studies") or 0)
            if zh:
                if n and n < 10:
                    return (
                        f"少于10项研究贡献该结局（k={n}），小样本效应检验不作确认性解释；"
                        + ("因此因发表偏倚不确定性降级。" if downgraded else "未因发表偏倚降级。")
                    )
                return "未发现足以导致降级的发表偏倚信号。" if not downgraded else "发表偏倚风险足以导致GRADE降级。"
            if n and n < 10:
                return (
                    f"Fewer than 10 studies contributed (k={n}), so small-study-effect tests were not interpreted confirmatorily; "
                    + ("a downgrade was applied for publication-bias uncertainty." if downgraded else "no downgrade was applied for publication bias.")
                )
            return "No publication-bias signal was detected in the available tests; no downgrade was applied for publication bias." if not downgraded else "Publication-bias concerns were sufficient for a GRADE downgrade."

        return ""

    @staticmethod
    def _zh_grade_rationale(rationale: str, domain_name: str = "", rating: str = "") -> str:
        text = re.sub(r"\s+", " ", str(rationale or "")).strip()
        rob = re.search(
            r"RoB assessments were available for (\d+)/(\d+) contributing studies:\s*"
            r"(\d+)/(\d+) studies at high risk,\s*"
            r"(\d+)/(\d+) with some concerns,\s*"
            r"(\d+)/(\d+) at low risk",
            text,
            flags=re.IGNORECASE,
        )
        if rob:
            return (
                f"{rob.group(1)}/{rob.group(2)}项贡献研究有偏倚风险评价；"
                f"{rob.group(3)}/{rob.group(4)}项高风险，"
                f"{rob.group(5)}/{rob.group(6)}项存在一些问题，"
                f"{rob.group(7)}/{rob.group(8)}项低风险。"
            )
        rating_key = str(rating or "").strip().lower()
        if domain_name == "indirectness":
            if rating_key in {"no concern", "no concerns", "not serious", "not downgraded"}:
                return "纳入研究的人群、干预、对照和结局与本综述问题基本一致；未因间接性降级。"
            if rating_key in {"serious", "very serious"}:
                return (
                    "间接性主要来自目标PICO与入池资料之间的适用性差异，"
                    "包括人群、干预、对照、结局定义或随访时间的差异；"
                    "这些因素会影响合并估计向具体患者场景的外推。"
                )
        if domain_name == "inconsistency" or re.search(r"heterogeneity|inconsistency", text, flags=re.IGNORECASE):
            i2 = re.search(r"I[²2]\s*(?:=|of)\s*([0-9.]+)%", text)
            i2_text = f"I²={i2.group(1)}%" if i2 else "I²较低"
            p_value = re.search(r"(?:Chi[²2]|Chi-square|Chi2)?\s*p\s*=\s*([0-9.]+)", text, flags=re.IGNORECASE)
            p_text = f"，Chi²检验p={p_value.group(1)}" if p_value else ""
            k_match = re.search(r"across\s+(\d+)\s+stud(?:y|ies)|(\d+)\s+stud(?:y|ies)\s+contributed|n\s*=\s*(\d+)", text, flags=re.IGNORECASE)
            k_value = next((group for group in (k_match.groups() if k_match else []) if group), None)
            if k_value and int(k_value) < 3:
                return (
                    f"该领域报告了异质性统计量（{i2_text}{p_text}）；但仅{int(k_value)}项研究贡献该结局，"
                    "这些统计量只能描述观察到的差异，不能可靠排除具有临床意义的研究间差异。"
                )
            if re.search(r"low|not statistically significant|did not downgrade|no downgrade|no statistical", text, flags=re.IGNORECASE) or rating in {"no concern", "no concerns", "not serious", "not downgraded"}:
                return f"统计异质性很低（{i2_text}{p_text}），未因不一致性降级。"
            return f"研究间结果存在不一致性信号（{i2_text}{p_text}），因此在证据确定性中降级或保守解释。"
        if re.search(r"no statistical heterogeneity", text, flags=re.IGNORECASE):
            i2 = re.search(r"I[²2]\s*(?:=|of)\s*([0-9.]+)%", text)
            i2_text = f"I²={i2.group(1)}%" if i2 else "I²较低"
            p_value = re.search(r"\bp\s*=\s*([0-9.]+)", text, flags=re.IGNORECASE)
            p_text = f"，Chi²检验p={p_value.group(1)}" if p_value else ""
            return f"统计异质性很低（{i2_text}{p_text}），未因不一致性降级。"
        imprecision = re.search(
            r"Total N\s*=\s*([0-9,]+)(?:\s*\([^)]*\))?\s*vs\s*OIS\s*=\s*([0-9,]+);"
            r"(?:\s*CI width\s*=\s*([0-9.]+);)?\s*CI crosses null\s*=\s*(True|False)",
            text,
            flags=re.IGNORECASE,
        )
        if imprecision:
            crosses_null = imprecision.group(4).lower() == "true"
            cross_text = "跨越" if crosses_null else "未跨越"
            return (
                f"总样本量{imprecision.group(1)}；样本量达到预设信息量要求，置信区间{cross_text}无效值，"
                "因此未因不精确性降级。"
            )
        if re.search(r"fewer than 10 studies", text, flags=re.IGNORECASE):
            if rating_key in {"serious", "very serious", "严重", "非常严重"}:
                return "由于少于10项研究贡献该结局，小样本效应和发表偏倚无法可靠评估；因此因发表偏倚不确定性降级。"
            return "由于少于10项研究贡献该结局，未正式评价发表偏倚；本领域未因此降级。"
        if re.search(r"Rule-based P/I/C/O directness check", text, flags=re.IGNORECASE):
            if re.search(r"no [^.]*mismatch|no concern", text, flags=re.IGNORECASE):
                return "纳入研究的人群、干预、对照和结局与本综述问题基本一致；未因间接性降级。"
            return (
                "间接性主要来自目标PICO与入池资料之间可能存在的临床差异，"
                "包括亚组提取、药物或剂量差异、背景治疗差异以及结局时间窗不完全一致；"
                "这些因素会影响合并估计向具体患者场景的外推。"
            )
        if re.search(r"[A-Za-z]{4,}", text):
            domain_fallbacks = {
                "risk_of_bias": "偏倚风险判断基于贡献研究的领域评价；该领域评级已按GRADE规则纳入证据确定性。",
                "inconsistency": "研究间一致性判断基于异质性统计量和研究效应方向；该领域评级已按GRADE规则纳入证据确定性。",
                "indirectness": "纳入研究与目标人群、干预、对照和结局的匹配程度已用于间接性判断。",
                "imprecision": "不精确性判断基于样本量、置信区间宽度以及置信区间是否跨越无效值。",
                "publication_bias": "发表偏倚判断结合贡献研究数和小样本效应检验的适用性。",
            }
            return domain_fallbacks.get(domain_name, "该GRADE领域已按结构化规则评价。")
        if GradeTablesMixin._grade_rationale_has_internal_terms(text):
            return GradeTablesMixin._grade_domain_safe_fallback(domain_name, rating_key, zh=True)
        return text or "NR"

    @staticmethod
    def _polish_grade_rationale(rationale: str, domain_name: str = "", rating: str = "") -> str:
        """Make cached GRADE rationales read consistently in manuscript tables."""
        text = str(rationale or "")
        rating_key = str(rating or "").strip().lower()
        if domain_name == "indirectness":
            if rating_key in {"no concern", "no concerns", "not serious", "not downgraded"}:
                return (
                    "The contributing studies were judged sufficiently direct for the review question after "
                    "comparison of population, intervention, comparator, outcome, and design; no downgrade "
                    "was applied for indirectness."
                )
            if rating_key in {"serious", "very serious"}:
                return (
                    "Indirectness reflected unresolved applicability differences between the target PICO and the "
                    "contributing evidence across population, intervention, comparator, outcome definition, or follow-up."
                )
        if domain_name == "inconsistency" or re.search(r"heterogeneity|inconsistency", text, flags=re.IGNORECASE):
            i2 = re.search(r"I[²2]\s*(?:=|of)\s*([0-9.]+)%", text)
            p_value = re.search(r"(?:Chi[²2]|Chi-square|Chi2)?\s*p\s*=\s*([0-9.]+)", text, flags=re.IGNORECASE)
            if i2 or p_value:
                parts = []
                if i2:
                    parts.append(f"I²={i2.group(1)}%")
                if p_value:
                    parts.append(f"Chi² p={p_value.group(1)}")
                k_match = re.search(r"across\s+(\d+)\s+stud(?:y|ies)|(\d+)\s+stud(?:y|ies)\s+contributed|n\s*=\s*(\d+)", text, flags=re.IGNORECASE)
                k_value = next((group for group in (k_match.groups() if k_match else []) if group), None)
                if k_value and int(k_value) < 3:
                    return (
                        f"Inconsistency was judged with heterogeneity statistics ({'; '.join(parts)}), but only "
                        f"{int(k_value)} studies contributed; these statistics are descriptive and cannot reliably "
                        "exclude clinically important between-study differences."
                    )
                if re.search(r"low|not statistically significant|did not downgrade|no downgrade|no statistical", text, flags=re.IGNORECASE) or rating in {"no concern", "no concerns", "not serious", "not downgraded"}:
                    return f"Heterogeneity was low ({'; '.join(parts)}), so no downgrade was applied for inconsistency."
                return f"Inconsistency was judged using heterogeneity statistics ({'; '.join(parts)}) and trial-level effect compatibility."
        imprecision = re.search(
            r"Total N\s*=\s*([0-9,]+)(?:\s*\([^)]*\))?\s*vs\s*OIS\s*=\s*([0-9,]+);"
            r"(?:\s*CI width\s*=\s*([0-9.]+);)?\s*CI crosses null\s*=\s*(True|False)",
            text,
            flags=re.IGNORECASE,
        )
        if imprecision:
            crosses_null = imprecision.group(4).lower() == "true"
            cross_text = "crossed" if crosses_null else "did not cross"
            return (
                f"The analysis included {imprecision.group(1)} participants, the information size was sufficient, and the confidence interval "
                f"{cross_text} the null; no downgrade was applied for imprecision."
            )
        if re.search(r"Rule-based P/I/C/O directness check", text, flags=re.IGNORECASE):
            if re.search(r"no [^.]*mismatch|no concern", text, flags=re.IGNORECASE):
                return (
                    "The contributing studies were judged sufficiently direct for the review question after "
                    "comparison of population, intervention, comparator, outcome, and design; no downgrade "
                    "was applied for indirectness."
                )
            return (
                "Indirectness reflected possible clinical differences between the target PICO and contributing rows, "
                "including population, intervention, comparator, outcome, and follow-up compatibility; "
                "these factors affect applicability to specific patient settings."
            )
        text = re.sub(
            r"(\d+)/(\d+) contributing study RoB assessments were not formally assessed",
            r"Among the \2 available RoB assessments, \1 was not formally assessed",
            text,
        )
        if GradeTablesMixin._grade_rationale_has_internal_terms(text):
            return GradeTablesMixin._grade_domain_safe_fallback(domain_name, rating_key, zh=False)
        return text

    @staticmethod
    def _grade_rationale_has_internal_terms(text: str) -> bool:
        return bool(re.search(
            r"Rule-based|OIS\s*=|Total N\s*=|CI crosses null|Synthetic RoB|P/I/C/design|structured GRADE|结构化GRADE",
            str(text or ""),
            flags=re.I,
        ))

    @staticmethod
    def _grade_domain_safe_fallback(domain_name: str, rating: str = "", zh: bool = False) -> str:
        rating_key = str(rating or "").strip().lower()
        downgraded = rating_key in {"serious", "very serious", "严重", "非常严重"}
        if zh:
            if domain_name == "risk_of_bias":
                return "偏倚风险判断基于贡献研究的领域评价；" + ("因此因偏倚风险降级。" if downgraded else "未因偏倚风险降级。")
            if domain_name == "inconsistency":
                return "研究间一致性依据异质性统计量、效应方向和置信区间重叠情况判断；" + ("因此因不一致性降级。" if downgraded else "未因不一致性降级。")
            if domain_name == "indirectness":
                return "间接性依据人群、干预、对照、结局和设计与综述问题的匹配程度判断；" + ("因此因间接性降级。" if downgraded else "未因间接性降级。")
            if domain_name == "imprecision":
                return "不精确性依据入池样本量、事件数和置信区间范围判断；" + ("因此因不精确性降级。" if downgraded else "未因不精确性降级。")
            if domain_name == "publication_bias":
                return "发表偏倚依据贡献研究数和小样本效应评估适用性判断；" + ("因此因发表偏倚降级。" if downgraded else "未因发表偏倚降级。")
            return "该GRADE领域已按结构化字段评价。"
        if domain_name == "risk_of_bias":
            return "Risk of bias was judged from domain-level assessments of the contributing studies; " + ("a downgrade was applied for risk of bias." if downgraded else "no downgrade was applied for risk of bias.")
        if domain_name == "inconsistency":
            return "Inconsistency was judged from heterogeneity statistics, effect direction, and compatibility of trial-level estimates; " + ("a downgrade was applied for inconsistency." if downgraded else "no downgrade was applied for inconsistency.")
        if domain_name == "indirectness":
            return "Indirectness was judged by comparing the population, intervention, comparator, outcome, and design with the review question; " + ("a downgrade was applied for indirectness." if downgraded else "no downgrade was applied for indirectness.")
        if domain_name == "imprecision":
            return "Imprecision was judged from the selected pooled sample size, event information, and confidence-interval range; " + ("a downgrade was applied for imprecision." if downgraded else "no downgrade was applied for imprecision.")
        if domain_name == "publication_bias":
            return "Publication bias was judged from the number of contributing studies and the applicability of small-study-effect assessment; " + ("a downgrade was applied for publication bias." if downgraded else "no downgrade was applied for publication bias.")
        return "This GRADE domain was assessed from structured domain fields."

    @staticmethod
    def _fallback_grade_downgrade_text(grade: dict) -> str:
        domains = grade.get("domains") if isinstance(grade, dict) else None
        if not domains:
            return "limitations requiring review"
        labels = {
            "risk_of_bias": "risk of bias",
            "inconsistency": "inconsistency",
            "indirectness": "indirectness",
            "imprecision": "imprecision",
            "publication_bias": "publication bias",
        }
        downgraded = [
            labels.get(str(domain.get("domain") or ""), str(domain.get("domain") or "domain").replace("_", " "))
            for domain in domains
            if str(domain.get("rating") or "").strip().lower() in {"serious", "very serious"}
        ]
        if not downgraded:
            return "no serious GRADE domain concerns"
        if len(downgraded) == 1:
            return downgraded[0]
        return ", ".join(downgraded[:-1]) + f" and {downgraded[-1]}"

    @staticmethod
    def _grade_downgrade_summary_sentence(downgrade_text: str) -> str:
        text = str(downgrade_text or "").strip().rstrip(".")
        if not text:
            return "No serious GRADE domain concern was identified."
        lowered = text.lower()
        if lowered in {"none", "not assessed", "no serious grade domain concerns"}:
            return "No serious GRADE domain concern was identified."
        is_plural = bool(re.search(r",|\band\b", lowered))
        noun = "reasons were" if is_plural else "reason was"
        return f"The main downgrading {noun} {text}."

    @staticmethod
    def _fallback_grade_downgrade_text_zh(grade: dict) -> str:
        domains = grade.get("domains") if isinstance(grade, dict) else None
        if not domains:
            return "仍需复核的证据限制"
        labels = {
            "risk_of_bias": "偏倚风险",
            "inconsistency": "不一致性",
            "indirectness": "间接性",
            "imprecision": "不精确性",
            "publication_bias": "发表偏倚",
        }
        downgraded = [
            labels.get(str(domain.get("domain") or ""), str(domain.get("domain") or "领域").replace("_", " "))
            for domain in domains
            if str(domain.get("rating") or "").strip().lower() in {"serious", "very serious", "严重", "非常严重"}
        ]
        if not downgraded:
            return "未见严重GRADE领域问题"
        return "、".join(downgraded)

    def _fallback_source_audit_table(self, rows: list[dict]) -> str:
        lines = [
            "| Trial | Row ID | Display source | Original source | Provenance tier | Source excerpt | Confidence |",
            "|---|---|---|---|---|---|---|",
        ]
        for row in rows:
            quote = self._fallback_source_quote(row)
            original_source = (
                row.get("source_location_original")
                or row.get("source_location_raw")
                or row.get("benchmark_source_location")
                or row.get("source_location")
                or ""
            )
            tier = self._fallback_source_tier_label(row)
            lines.append(
                "| "
                + " | ".join([
                    self._md_cell(self._fallback_trial_label(row)),
                    self._md_cell(self._fallback_row_id(row)),
                    self._md_cell(self._fallback_source_location(row)),
                    self._md_cell(original_source),
                    self._md_cell(tier),
                    self._md_cell(self._shorten(quote, 180) or "NR"),
                    self._md_cell(row.get("extraction_confidence") or "NR"),
                ])
                + " |"
            )
        return "\n".join(lines)

    def _fallback_calculation_notes(
        self,
        *,
        effect_measure: str,
        primary: dict,
        primary_population: dict,
        heterogeneity: str,
        n_primary: int,
        total_n: int,
    ) -> str:
        events_i = self._int(primary_population.get("selected_events_intervention"))
        total_i = self._int(primary_population.get("selected_total_intervention"))
        events_c = self._int(primary_population.get("selected_events_control"))
        total_c = self._int(primary_population.get("selected_total_control"))
        effect = self._fallback_effect_text(primary, effect_measure)
        p_text = self._p_text(primary.get("p_value"))
        return "\n\n".join([
            (
                f"The primary calculation used {n_primary} source-verified trial rows and {total_n:,} participants. "
                f"The arm-level totals were {events_i}/{total_i} deaths in the corticosteroid groups and "
                f"{events_c}/{total_c} deaths in the control groups. These aggregate totals are reported for "
                "orientation only; the pooled estimate was calculated from trial-level log effects and variances, "
                "not from a single collapsed 2 x 2 table."
            ),
            (
                "For each trial, survivors were calculated by subtracting deaths from the randomized or analyzed "
                "denominator in that arm. The log odds ratio was computed from deaths and survivors in the two "
                "groups, and the variance was the sum of the reciprocals of the four cells. The resulting log-scale "
                "effect and standard error were stored before any manuscript text was written. Reporting then "
                "exponentiated the pooled log effect and its confidence interval back to the odds-ratio scale."
            ),
            (
                f"The primary pooled result was {effect}, with {p_text}. {heterogeneity} Study weights therefore "
                "reflect both event frequency and sample size, with larger trials contributing greater precision. "
                "The trial-level effect table reports the study odds ratio, log-scale standard error, fixed-effect "
                "weight, and source excerpt so that the statistical row can be checked against the extracted source."
            ),
            (
                "The leave-one-out analysis repeated the same model after removing one trial at a time. This analysis "
                "was used as an influence diagnostic, not as a separate clinical subgroup analysis. A change in "
                "precision after removing the largest study is expected under inverse-variance weighting and should be "
                "interpreted together with the direction of the remaining trial estimates."
            ),
            (
                "No continuity correction affected the reported primary result when all four cells were nonzero. If a "
                "future run includes zero-event cells, the configured continuity-correction policy should be reported "
                "explicitly in this appendix and in the statistical methods section. The saved analysis file remains "
                "the authoritative source for any such correction."
            ),
            (
                "The distinction between the selected primary rows and the broader extraction set is intentional. "
                "Secondary outcomes, background records, and related source documents may remain useful for context, "
                "but they must not alter the primary mortality calculation unless they satisfy the same eligibility, "
                "time-point, and source-verification criteria. This appendix therefore documents the narrow calculation "
                "actually used for the pooled estimate, while the supplementary extraction records document the wider set of "
                "rows that still require human review. This separation also helps readers identify "
                "whether a later correction would change the main effect estimate or only improve documentation of "
                "supporting material. The same convention should be maintained in future updates of the review and in any submitted supplement."
            ),
        ])

    def _fallback_figures_section(
        self,
        project: Project | None,
        *,
        prisma: dict | None = None,
        n_primary: int | None = None,
    ) -> str:
        if not project:
            return "No figure files were available."
        figures = [
            ("Figure 1. PRISMA flow diagram", "prisma_diagram.png"),
            ("Figure 2. Forest plot for 28-day all-cause mortality", "forest_plot.png"),
            ("Figure 3. Leave-one-out sensitivity plot", "sensitivity.png"),
            ("Figure 4. Risk-of-bias summary", "rob_summary.png"),
        ]
        blocks = []
        for caption, filename in figures:
            path = project.base_dir / "figures" / filename
            if path.exists():
                legend = ""
                if filename == "prisma_diagram.png":
                    legend = "\n\n" + self._fallback_prisma_flow_legend(prisma=prisma, n_primary=n_primary)
                blocks.append(f"### {caption}\n\n![{caption}](../figures/{filename}){legend}")
        return "\n\n".join(blocks) if blocks else "No figure files were available."

    @staticmethod
    def _compress_covid_corticosteroid_methods(methods: str) -> str:
        """Keep the COVID corticosteroid Methods section journal-sized and non-repetitive."""
        drop_phrases = (
            "Before synthesis, study counts",
            "Aggregate arm totals are reported",
            "The analysis retained all eligible randomized comparisons",
            "Sensitivity analyses were interpreted as influence checks",
            "The confidence interval was interpreted",
            "Absolute-effect interpretation was planned",
            "The model output was not used as a license",
            "Heterogeneity was interpreted cautiously",
            "The review did not use textual similarity alone",
            "### Handling of unresolved review items",
            "Records outside the primary analysis could still carry",
            "GRADE certainty was interpreted in the context",
            "Indirectness was considered separately",
            "For trials that enrolled a broader hospitalized COVID-19 population",
            "When a report contained multiple mortality time points",
            "The primary estimate, its standard error",
            "The unit of analysis was the randomized comparison",
            "The treatment-class contrast was handled before pooling",
            "The effect measure was chosen before interpretation",
            "Safety outcomes were not pooled in the primary efficacy analysis",
            "Risk-of-bias judgments were interpreted with attention",
        )
        paragraphs = [paragraph for paragraph in str(methods or "").split("\n\n") if paragraph.strip()]
        kept = [
            paragraph
            for paragraph in paragraphs
            if not any(phrase in paragraph for phrase in drop_phrases)
        ]
        return "\n\n".join(kept)

    def _fallback_recovery_omission_text(self, meta_json: dict) -> str:
        for row in meta_json.get("leave_one_out", []) if isinstance(meta_json, dict) else []:
            label = str(row.get("excluded_study_label") or row.get("excluded_study_id") or "")
            if any(token in label for token in ("Peter", "RECOVERY", "Horby", "20137273")):
                effect = self._fmt(row.get("pooled_effect"), 2)
                lower = self._fmt(row.get("ci_lower"), 2)
                upper = self._fmt(row.get("ci_upper"), 2)
                if self._zh:
                    return f"{effect}（95% CI {lower}至{upper}）"
                return f"{effect} (95% CI {lower} to {upper})"
        return "RECOVERY剔除后的估计值" if self._zh else "the RECOVERY-omission estimate"

    @staticmethod
    def _fallback_trial_label(row: dict) -> str:
        study_id = str(row.get("study_id") or "")
        known = {
            "32876689": "CAPE COVID (Dequin et al., 2020)",
            "32876695": "CoDEX (Tomazini et al., 2020)",
            "32876697": "REMAP-CAP (Angus et al., 2020)",
            "10.1101/2020.06.22.20137273": "RECOVERY (Horby et al., 2020)",
            "32799933": "DEXA-COVID 19 (Villar et al., 2020)",
            "benchmark_source:covid_steroid": "COVID STEROID (NCT04348305)",
            "benchmark_source:steroids_sari": "Steroids-SARI (NCT04244591)",
            "known_source:covid_steroid": "COVID STEROID (NCT04348305)",
            "known_source:steroids_sari": "Steroids-SARI (NCT04244591)",
        }
        if study_id in known:
            return known[study_id]
        label = str(row.get("study_label") or study_id or "Unknown trial")
        return re.sub(r"\s+0$", " 2020", label).strip()

    def _fallback_source_quote(self, row: dict) -> str:
        text = str(row.get("source_quote") or "")
        location = str(row.get("source_location") or "")
        study_id = str(row.get("study_id") or "")
        who_source = "who_react_figure2" in (text + " " + location).lower()
        labels = {
            "32876689": "CAPE COVID (NCT02517489)",
            "32876695": "CoDEX (NCT04327401)",
            "32876697": "REMAP-CAP (NCT02735707)",
            "10.1101/2020.06.22.20137273": "RECOVERY (NCT04381936)",
            "32799933": "DEXA-COVID 19 (NCT04325061)",
            "benchmark_source:covid_steroid": "COVID STEROID (NCT04348305)",
            "benchmark_source:steroids_sari": "Steroids-SARI (NCT04244591)",
            "known_source:covid_steroid": "COVID STEROID (NCT04348305)",
            "known_source:steroids_sari": "Steroids-SARI (NCT04244591)",
        }
        if who_source and study_id in labels:
            return (
                f"{labels[study_id]}: deaths/total were "
                f"{self._int(row.get('events_intervention'))}/{self._int(row.get('total_intervention'))} "
                "in the steroid arm and "
                f"{self._int(row.get('events_control'))}/{self._int(row.get('total_control'))} "
                "in the no-steroid arm."
            )
        return text

    @staticmethod
    def _fallback_source_location(row: dict) -> str:
        raw = str(row.get("source_location") or "").strip()
        if not raw:
            return "Source-adjudicated record"
        cleaned = re.sub(r"^uploaded\s+benchmark\s+source:\s*", "", raw, flags=re.IGNORECASE).strip()
        study_id = str(row.get("study_id") or row.get("row_id") or "").strip()
        if "who react" in cleaned.lower() or "who_react_figure2" in cleaned.lower():
            primary_locations = {
                "32876689": "CAPE COVID JAMA 2020 primary trial report",
                "32876695": "CoDEX JAMA 2020 primary trial report",
                "10.1101/2020.06.22.20137273": "RECOVERY trial report/subgroup table",
                "32876697": "REMAP-CAP JAMA 2020 primary trial report",
                "32799933": "DEXA-COVID registry/protocol record",
                "benchmark_source:covid_steroid": "COVID STEROID trial report/registry result",
                "known_source:covid_steroid": "COVID STEROID trial report/registry result",
                "benchmark_source:steroids_sari": "Steroids-SARI ClinicalTrials.gov/COVID-NMA record",
                "known_source:steroids_sari": "Steroids-SARI ClinicalTrials.gov/COVID-NMA record",
            }
            for key, location in primary_locations.items():
                if key in study_id:
                    return location
            return "Primary trial report or registry verification required before pooling"
        if "who_react_figure2_transcribed" in cleaned.lower():
            return "Benchmark figure transcription; not acceptable as a primary extraction source"
        cleaned = re.sub(r"\bbenchmark[-\s]+source\b", "source document", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\bbenchmark\b", "reference", cleaned, flags=re.IGNORECASE)
        return cleaned or "Source-adjudicated record"

    @staticmethod
    def _fallback_row_id(row: dict) -> str:
        raw = str(row.get("row_id") or "").strip()
        if not raw:
            return ""
        return raw.replace("benchmark_source:", "source:").replace("known_source:", "source:")

    @staticmethod
    def _shorten(text: str, limit: int) -> str:
        cleaned = re.sub(r"\s+", " ", str(text or "")).strip()
        if len(cleaned) <= limit:
            return cleaned
        cutoff = max(0, limit - 3)
        candidate = cleaned[:cutoff].rstrip()
        boundary = max(candidate.rfind(" "), candidate.rfind(";"), candidate.rfind(","), candidate.rfind(":"))
        if boundary >= max(20, cutoff // 2):
            candidate = candidate[:boundary].rstrip()
        return candidate.rstrip(" ,;:") + "..."

    @staticmethod
    def _md_cell(text) -> str:
        return str(text or "").replace("|", "\\|").replace("\n", " ").strip()
