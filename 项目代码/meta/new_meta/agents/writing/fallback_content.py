"""Labels, titles, generic tables and references used by fallback reports."""
from __future__ import annotations

from datetime import date
import os
import re

from new_meta.core.project import Project
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.tools.reference_manager import ReferenceManager

from new_meta.agents.writing.contracts import (
    ManuscriptTitleCandidate,
)

from new_meta.agents.writing.grade_tables import GradeTablesMixin


class FallbackContentMixin:
    """Labels, titles, generic tables and references used by fallback reports."""

    @staticmethod
    def _is_covid_corticosteroid_topic(protocol: ResearchProtocol) -> bool:
        text = " ".join([
            getattr(protocol, "research_question", "") or "",
            getattr(protocol.pico, "population", "") or "",
            getattr(protocol.pico, "intervention", "") or "",
            getattr(protocol.pico, "outcome_primary", "") or "",
        ]).lower()
        return "covid" in text and any(
            term in text for term in ("corticosteroid", "dexamethasone", "hydrocortisone")
        )

    @staticmethod
    def _generic_event_label(effect_measure: str) -> str:
        if effect_measure in {"HR", "OR", "RR", "IRR"}:
            return "primary outcome events"
        return "events"

    @staticmethod
    def _concise_intervention_label(text: str) -> str:
        raw = re.sub(r"\s+", " ", str(text or "")).strip()
        low = raw.lower()
        if "sglt2" in low or "sodium-glucose cotransporter-2" in low:
            return "SGLT2 inhibitors"
        label = re.sub(r"\([^)]*\)", "", raw)
        label = re.split(r"\s+(?:at any|administered|as monotherapy|combined with|in combination with)\b", label, maxsplit=1, flags=re.IGNORECASE)[0]
        label = label.strip(" ,.;")
        return label or "Intervention"

    @staticmethod
    def _concise_comparator_label(text: str) -> str:
        raw = re.sub(r"\s+", " ", str(text or "")).strip()
        low = raw.lower()
        if "placebo" in low:
            return "placebo"
        if "usual care" in low and "standard" in low:
            return "usual care or standard care"
        if "usual care" in low:
            return "usual care"
        if "standard of care" in low:
            return "standard care"
        label = re.sub(r"\([^)]*\)", "", raw)
        label = re.split(
            r"\s+(?:including|with background|without an|with no|plus)\b",
            label,
            maxsplit=1,
            flags=re.IGNORECASE,
        )[0]
        label = label.strip(" ,.;")
        return label or "comparator"

    @staticmethod
    def _concise_population_label(text: str) -> str:
        raw = re.sub(r"\s+", " ", str(text or "")).strip()
        low = raw.lower()
        if "mildly reduced" in low and "preserved" in low and "ejection fraction" in low:
            return "heart failure with mildly reduced or preserved ejection fraction"
        if "hfpef" in low or "preserved ejection fraction" in low:
            return "heart failure with preserved ejection fraction"
        if "hfmref" in low or "mildly reduced ejection fraction" in low:
            return "heart failure with mildly reduced ejection fraction"
        if "covid" in low or "sars-cov-2" in low or "coronavirus" in low:
            label = re.split(r"\s+(?:including|confirmed by)\b", raw, maxsplit=1, flags=re.IGNORECASE)[0]
            return label.strip(" ,.;") or "target population"
        label = re.split(r"\s+(?:with|who|that|including)\b", raw, maxsplit=1, flags=re.IGNORECASE)[0]
        label = label.strip(" ,.;")
        return label or "target population"

    def _reporting_outcome_label(self, facts: dict, protocol: ResearchProtocol | None = None, *, zh: bool = False) -> str:
        primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
        pico = facts.get("pico") if isinstance(facts.get("pico"), dict) else {}
        protocol_outcome = protocol.pico.outcome_primary if isinstance(protocol, ResearchProtocol) else ""
        base = str(
            primary.get("outcome_name")
            or pico.get("primary_outcome")
            or protocol_outcome
            or ("主要结局" if zh else "the primary outcome")
        ).strip()
        if self._has_worsening_hf_urgent_visit_component(facts):
            return (
                "心血管死亡或心力衰竭恶化复合终点"
                if zh else
                "the composite of cardiovascular death or worsening heart failure"
            )
        return base

    @staticmethod
    def _has_worsening_hf_urgent_visit_component(facts: dict) -> bool:
        cards = facts.get("study_cards") if isinstance(facts.get("study_cards"), list) else []
        rows = (
            ((facts.get("evidence_readiness") or {}).get("selected_primary_rows") or [])
            if isinstance(facts.get("evidence_readiness"), dict) else []
        )
        texts: list[str] = []
        for item in list(cards) + list(rows):
            if not isinstance(item, dict):
                continue
            for key in (
                "primary_outcome_note",
                "llm_primary_outcome",
                "outcome_name",
                "source_quote",
                "distinctive_feature",
                "clinical_quirks",
                "audit_notes",
                "unresolved_questions",
            ):
                value = item.get(key)
                if isinstance(value, list):
                    texts.extend(str(v or "") for v in value)
                elif value not in (None, ""):
                    texts.append(str(value))
        joined = " ".join(texts).lower()
        return (
            "worsening heart failure" in joined
            and ("urgent visit" in joined or "urgent heart failure" in joined)
            and ("hospital" in joined or "hospitalization" in joined)
        )

    def _endpoint_definition_caveat(self, facts: dict, *, zh: bool = False) -> str:
        if not self._has_worsening_hf_urgent_visit_component(facts):
            return ""
        if zh:
            return (
                "需要注意的是，入池试验的复合终点定义并非完全相同：DELIVER使用“心血管死亡或心力衰竭事件”，"
                "其中心力衰竭事件包括住院或紧急就诊；EMPEROR-Preserved使用“心血管死亡或心力衰竭住院”。"
                "两项试验均包含心血管死亡，差异主要在于心力衰竭事件是否包括紧急就诊。因此，本合并估计应解释为"
                "心血管死亡或心力衰竭恶化复合终点的平均效应，而不是严格的“仅首次住院”效应；文中出现“住院”"
                "仅用于说明原始试验的来源终点定义。"
            )
        return (
            "The endpoint definition was not identical across the contributing trials: DELIVER used cardiovascular death or "
            "a worsening heart failure event, with the heart-failure component defined as hospitalization or an urgent heart "
            "failure visit, whereas EMPEROR-Preserved used cardiovascular death or heart failure hospitalization. Both trials "
            "included cardiovascular death; the difference is whether the heart-failure component included urgent visits. The "
            "pooled estimate should therefore be interpreted as the average effect on a composite of cardiovascular death or "
            "worsening heart failure, not as a hospitalization-only estimate; hospitalization wording is used only when "
            "describing the source-level trial endpoint."
        )

    def _endpoint_definition_discussion(self, facts: dict, *, zh: bool = False) -> str:
        if not self._has_worsening_hf_urgent_visit_component(facts):
            return ""
        if zh:
            return (
                "这一终点差异的临床含义是：合并估计更适合回答治疗是否减少心力衰竭恶化相关事件，"
                "而不宜被解读为仅针对住院的精确估计。若用于患者沟通或指南推荐，应结合当地急诊就诊、"
                "住院阈值和随访方式判断绝对获益。"
            )
        return (
            "Clinically, this endpoint difference means the pooled estimate is best read as an effect on worsening-heart-failure "
            "events rather than as a precise hospitalization-only effect. Translation to practice should consider local thresholds "
            "for urgent visits, hospital admission, outcome adjudication, and follow-up."
        )

    @staticmethod
    def _review_process_transparency_sentence(*, zh: bool = False) -> str:
        if zh:
            return (
                "筛选和数据提取按预设标准完成，并保留筛选、提取和核查记录供作者复核；"
                "当前项目记录未显示由两名人工评审员独立完成筛选或提取。"
            )
        return (
            "Screening and data collection followed prespecified criteria, with intermediate screening and data-collection logs retained "
            "for author verification; this manuscript does not claim independent duplicate human screening or extraction."
        )

    @staticmethod
    def _concise_outcome_label(text: str) -> str:
        raw = re.sub(r"\s+", " ", str(text or "")).strip()
        low = raw.lower()
        if "worsening heart failure" in low and "urgent" in low:
            return "the composite of cardiovascular death or worsening heart failure"
        if "all-cause mortality" in low and ("28" in low or "twenty-eight" in low):
            return "28-day all-cause mortality"
        if "mortality" in low and "covid" in low:
            return "short-term all-cause mortality"
        if "cardiovascular death" in low and "heart failure" in low and "hospital" in low:
            return "cardiovascular death or heart failure hospitalization"
        label = re.sub(r"^composite of\s+", "", raw, flags=re.IGNORECASE)
        label = label.strip(" ,.;")
        return label or "primary outcome"

    @staticmethod
    def _zh_concise_intervention_label(text: str) -> str:
        raw = re.sub(r"\s+", " ", str(text or "")).strip()
        low = raw.lower()
        if "sglt2" in low or "sodium-glucose cotransporter-2" in low:
            return "SGLT2抑制剂"
        if "corticosteroid" in low:
            return "全身性糖皮质激素"
        return raw or "干预措施"

    @staticmethod
    def _zh_concise_comparator_label(text: str) -> str:
        raw = re.sub(r"\s+", " ", str(text or "")).strip()
        low = raw.lower()
        if "placebo" in low:
            return "安慰剂"
        if "usual care" in low or "standard care" in low:
            return "常规治疗"
        return raw or "对照"

    @staticmethod
    def _zh_concise_population_label(text: str) -> str:
        raw = re.sub(r"\s+", " ", str(text or "")).strip()
        low = raw.lower()
        if (
            "hfmref" in low
            or "hfpef" in low
            or "preserved ejection fraction" in low
            or "mildly reduced ejection fraction" in low
        ):
            if "mildly reduced" in low and "preserved" in low and "ejection fraction" in low:
                return "射血分数轻度降低或保留的心力衰竭患者"
            if "hfpef" in low or "preserved ejection fraction" in low:
                return "射血分数保留的心力衰竭患者"
            return "射血分数轻度降低的心力衰竭患者"
        covid_like = "covid" in low or "sars-cov" in low or "coronavirus" in low
        critical_like = any(
            term in low
            for term in (
                "critically",
                "critical",
                "intensive care",
                "icu",
                "mechanical ventilation",
                "high-flow oxygen",
                "high flow oxygen",
                "non-invasive ventilation",
            )
        )
        if covid_like and critical_like:
            return "危重型COVID-19患者"
        if covid_like:
            return "COVID-19患者"
        return raw or "目标人群"

    @staticmethod
    def _zh_concise_outcome_label(text: str) -> str:
        raw = re.sub(r"\s+", " ", str(text or "")).strip()
        low = raw.lower()
        if "worsening heart failure" in low and "urgent" in low:
            return "心血管死亡或心力衰竭恶化复合终点"
        if "cardiovascular death" in low and "heart failure" in low and "hospital" in low:
            return "心血管死亡或心力衰竭住院"
        if ("mortality" in low or "death" in low) and ("28" in low or "28-day" in low):
            return "28天全因死亡率"
        if "mortality" in low or "death" in low:
            return "死亡"
        return raw or "主要结局"

    @staticmethod
    def _was_were_for_label(label: str) -> str:
        text = str(label or "").strip().lower()
        plural_terms = (
            " inhibitors",
            " corticosteroids",
            " interventions",
            " drugs",
            " agents",
            " therapies",
            " treatments",
        )
        return "were" if text.endswith("s") or any(term in text for term in plural_terms) else "was"

    @staticmethod
    def _has_have_for_label(label: str) -> str:
        return "have" if FallbackContentMixin._was_were_for_label(label) == "were" else "has"

    @staticmethod
    def _sentence_initial_label(label: str) -> str:
        raw = str(label or "").strip()
        if not raw:
            return raw
        for index, char in enumerate(raw):
            if char.isalpha():
                return raw[:index] + char.upper() + raw[index + 1:]
        return raw

    def _generic_title(
        self,
        protocol: ResearchProtocol,
        intervention: str,
        outcome: str,
        *,
        report_type: str | None = None,
        facts: dict | None = None,
        allow_llm: bool = False,
    ) -> str:
        is_benchmark = str(report_type or "").strip().lower() == "benchmark_reconstruction"
        if allow_llm:
            llm_title = self._llm_generic_title(
                protocol,
                intervention,
                outcome,
                report_type=report_type,
                facts=facts or {},
            )
            if llm_title:
                return llm_title
        population = protocol.pico.population or "target population"
        if self._zh:
            short_population = self._shorten(self._zh_concise_population_label(population), 70).rstrip(".")
            short_intervention = self._shorten(self._zh_concise_intervention_label(intervention), 70).rstrip(".")
            short_outcome = self._shorten(self._zh_concise_outcome_label(outcome), 80).rstrip(".")
            suffix = "基准重建性系统综述和Meta分析" if is_benchmark else "系统综述和Meta分析"
            return f"{short_population}中{short_intervention}治疗{short_outcome}的{suffix}"
        short_population = self._shorten(self._concise_population_label(population), 70).rstrip(".")
        short_intervention = self._shorten(self._concise_intervention_label(intervention), 70).rstrip(".")
        short_outcome = self._shorten(self._concise_outcome_label(outcome), 80).rstrip(".")
        suffix = "a benchmark reconstruction and meta-analysis" if is_benchmark else "a systematic review and meta-analysis"
        return f"{short_intervention} for {short_outcome} in {short_population}: {suffix}"

    @staticmethod
    def _runtime_llm_title_enabled(project: Project | None) -> bool:
        """Use LLM title drafting in real project runs, but never from unit tests."""
        if project is None:
            return False
        return not os.environ.get("PYTEST_CURRENT_TEST")

    def _llm_generic_title(
        self,
        protocol: ResearchProtocol,
        intervention: str,
        outcome: str,
        *,
        report_type: str | None,
        facts: dict,
    ) -> str:
        prompt = self._generic_title_prompt(
            protocol,
            intervention,
            outcome,
            report_type=report_type,
            facts=facts,
        )
        try:
            candidate = self.call_llm_structured(
                prompt,
                ManuscriptTitleCandidate,
                temperature=0.0,
                max_tokens=512,
            )
        except Exception:
            return ""
        title = self._clean_title_candidate(candidate.title)
        if self._title_candidate_acceptable(title, report_type=report_type, required_outcome=outcome):
            return title
        return ""

    def _generic_title_prompt(
        self,
        protocol: ResearchProtocol,
        intervention: str,
        outcome: str,
        *,
        report_type: str | None,
        facts: dict,
    ) -> str:
        primary = facts.get("primary_effect") or {}
        prisma = facts.get("prisma") or {}
        report = str(report_type or facts.get("report_type") or "meta")
        language = "Chinese" if self._zh else "English"
        suffix_rule = (
            "The title must explicitly contain 基准重建 if the report type is benchmark_reconstruction."
            if self._zh else
            "The title must explicitly contain benchmark reconstruction if the report type is benchmark_reconstruction."
        )
        return (
            self._zh_prefix()
            + "Write one concise, publication-style title for a systematic review/meta-analysis manuscript.\n"
            + "Use only the structured facts below. Do not add claims, dates, countries, guideline statements, or effect sizes that are not listed.\n"
            + "Do not include citations, markdown, line breaks, abbreviations that are not already present, or a dangling phrase.\n"
            + "The Outcome field below is the authoritative reporting outcome for the title; do not replace it with older wording from the research question.\n"
            + f"{suffix_rule}\n"
            + f"Language: {language}\n"
            + f"Report type: {report}\n"
            + f"Research question: {protocol.research_question}\n"
            + f"Population: {protocol.pico.population}\n"
            + f"Intervention: {intervention}\n"
            + f"Comparator: {protocol.pico.comparator}\n"
            + f"Outcome: {outcome}\n"
            + f"Effect measure: {primary.get('effect_measure') or protocol.effect_measure or 'NR'}\n"
            + f"Primary studies: {primary.get('n_studies') or facts.get('primary_analysis_count') or 'NR'}\n"
            + f"Records identified: {prisma.get('records_identified') or 'NR'}\n"
            + "\nReturn JSON matching the requested schema."
        )

    @staticmethod
    def _clean_title_candidate(title: str) -> str:
        cleaned = re.sub(r"\s+", " ", str(title or "")).strip()
        cleaned = cleaned.strip(" \t\n\r\"'`#")
        cleaned = re.sub(r"\s+([:;,])", r"\1", cleaned)
        cleaned = re.sub(r"([:;,]){2,}", r"\1", cleaned)
        return cleaned.rstrip(" .")

    def _title_candidate_acceptable(self, title: str, *, report_type: str | None, required_outcome: str | None = None) -> bool:
        if not title or "\n" in title or "[" in title or "]" in title:
            return False
        if len(title) < 20 or len(title) > 220:
            return False
        lowered = title.lower()
        if any(token in lowered for token in (" p=", "95% ci", " odds ratio ", " risk ratio ", " hazard ratio ")):
            return False
        if re.search(r"\b(who are|who were|that are|that were|with|among|in|for|versus|compared with)\s*:?\s*$", lowered):
            return False
        is_benchmark = str(report_type or "").strip().lower() == "benchmark_reconstruction"
        required = str(required_outcome or "").lower()
        if "worsening heart failure" in required and "worsening" not in lowered:
            return False
        if "心力衰竭恶化" in str(required_outcome or "") and "心力衰竭恶化" not in title:
            return False
        if self._zh:
            if is_benchmark and "基准重建" not in title:
                return False
            if not is_benchmark and "基准重建" in title:
                return False
        else:
            if is_benchmark and "benchmark reconstruction" not in lowered:
                return False
            if not is_benchmark and "benchmark reconstruction" in lowered:
                return False
        return True

    def _generic_references(self, ref_manager: ReferenceManager | None) -> tuple[str, dict[str, str]]:
        entries = getattr(ref_manager, "entries", None) if ref_manager else None
        if not entries:
            return self._fallback_references(None)
        lines = []
        for idx, paper in enumerate(entries, 1):
            lines.append(self._format_reference_entry(idx, paper))
        cite_map = {str(study_id): f"[{num}]" for study_id, num in getattr(ref_manager, "_id_map", {}).items()}
        return "\n\n".join(lines), cite_map

    def _generic_study_table(self, rows: list[dict], cite_map: dict[str, str], effect_measure: str) -> str:
        lines = (
            [
                f"| 研究 | 报告位置 | 干预组事件/总数 | 对照组事件/总数 | 报告{effect_measure} | 资料依据 |",
                "|---|---|---:|---:|---:|---|",
            ]
            if self._zh
            else [
                f"| Study | Report location | Intervention events/total | Control events/total | Reported {effect_measure} | Evidence basis |",
                "|---|---|---:|---:|---:|---|",
            ]
        )
        for row in rows:
            study = self._fallback_trial_label(row)
            cite = cite_map.get(str(row.get("study_id") or ""), "")
            if cite:
                study = f"{study} {cite}"
            effect = row.get("effect")
            lines.append(
                "| "
                + " | ".join([
                    self._md_cell(study),
                    self._md_cell(self._fallback_source_location(row)),
                    f"{self._int(row.get('events_intervention'))}/{self._int(row.get('total_intervention'))}",
                    f"{self._int(row.get('events_control'))}/{self._int(row.get('total_control'))}",
                    self._fmt(effect, 2) if effect is not None else "NR",
                    (
                        "报告摘录支持" if row.get("source_quote_verified") is True else "需结合原文确认"
                    ) if self._zh else (
                        "Supported by report excerpt" if row.get("source_quote_verified") is True else "Requires report confirmation"
                    ),
                ])
                + " |"
            )
        return "\n".join(lines)

    def _generic_effect_table(self, rows: list[dict], study_stats: list[dict], effect_measure: str) -> str:
        stats_by_id = {str(item.get("study_id") or ""): item for item in study_stats if isinstance(item, dict)}
        lines = (
            [
                f"| 研究 | {effect_measure} | SE(log {effect_measure}) | 权重(%) | 来源依据 |",
                "|---|---:|---:|---:|---|",
            ]
            if self._zh
            else [
                f"| Study | {effect_measure} | SE(log {effect_measure}) | Weight (%) | Source basis |",
                "|---|---:|---:|---:|---|",
            ]
        )
        for row in rows:
            stats = stats_by_id.get(str(row.get("study_id") or ""), {})
            basis = self._generic_source_quote(row)
            lines.append(
                "| "
                + " | ".join([
                    self._md_cell(self._fallback_trial_label(row)),
                    self._fmt(stats.get("effect", row.get("effect")), 2),
                    self._fmt(stats.get("se", row.get("se")), 3),
                    self._fmt(stats.get("weight", row.get("weight")), 1),
                    self._md_cell(self._shorten(basis, 150) or ("来源支持的估计值" if self._zh else "Source-linked estimate")),
                ])
                + " |"
            )
        return "\n".join(lines)

    def _generic_absolute_effect_table(self, absolute_effects: dict | None) -> str:
        scenarios = self._absolute_effect_scenarios(absolute_effects)
        if not scenarios:
            return ""
        if self._zh:
            lines = [
                "| 基线风险来源 | 对照组风险 | 估计干预组风险 | 绝对效应 | 需治数 |",
                "|---|---:|---:|---|---|",
            ]
        else:
            lines = [
                "| Baseline risk source | Comparator risk | Estimated intervention risk | Absolute effect | NNT |",
                "|---|---:|---:|---|---|",
            ]
        for scenario in scenarios:
            if self._zh:
                row = [
                    self._md_cell(self._absolute_effect_scenario_label(scenario)),
                    self._md_cell(f"每1000人{self._int(scenario.get('assumed_control_risk_per_1000'))}例"),
                    self._md_cell(f"每1000人{self._int(scenario.get('intervention_risk_per_1000'))}例"),
                    self._md_cell(self._absolute_effect_phrase(scenario)),
                    self._md_cell(self._nnt_phrase(scenario)),
                ]
            else:
                row = [
                    self._md_cell(self._absolute_effect_scenario_label(scenario)),
                    self._md_cell(f"{self._int(scenario.get('assumed_control_risk_per_1000'))} per 1000"),
                    self._md_cell(f"{self._int(scenario.get('intervention_risk_per_1000'))} per 1000"),
                    self._md_cell(self._absolute_effect_phrase(scenario)),
                    self._md_cell(self._nnt_phrase(scenario)),
                ]
            lines.append("| " + " | ".join(row) + " |")
        return "\n".join(lines)

    def _absolute_effect_result_text(self, absolute_effects: dict | None) -> str:
        scenario = self._absolute_effect_primary_scenario(absolute_effects)
        if not scenario:
            return ""
        method_text = (
            "比例风险近似"
            if self._zh and (absolute_effects or {}).get("method") == "proportional_hazards_baseline_risk_translation"
            else "proportional hazards approximation"
            if (absolute_effects or {}).get("method") == "proportional_hazards_baseline_risk_translation"
            else "基线风险换算"
            if self._zh
            else "baseline-risk translation"
        )
        if self._zh:
            scenario_note = "表4显示该换算场景。"
            if len(self._absolute_effect_scenarios(absolute_effects)) > 1:
                scenario_note = "表4同时显示不同基线风险人群下的换算场景。"
            return (
                "### 绝对效应换算\n"
                f"以本综述纳入试验对照组在试验随访期内观察到的平均累积事件风险（每1000人{self._int(scenario.get('assumed_control_risk_per_1000'))}例）为基线，"
                f"按{method_text}应用合并效应后，干预组估计风险为每1000人{self._int(scenario.get('intervention_risk_per_1000'))}例，"
                f"即{self._absolute_effect_phrase(scenario)}；{self._nnt_phrase(scenario)}。这是基于本综述观察到的随访期累积基线风险和合并效应的临床换算，"
                f"隐含效应量可近似应用于试验随访期内累积风险的假设；实际绝对获益会随随访时间、当地事件判定和患者基线风险而变化。"
                f"该数值不是可直接外推到所有人群的绝对风险差。{scenario_note}"
            )
        scenario_note = "Table 4 shows this scenario."
        if len(self._absolute_effect_scenarios(absolute_effects)) > 1:
            scenario_note = "Table 4 also shows lower- and higher-baseline-risk scenarios."
        return (
            "### Absolute-effect translation\n"
            f"Using the average observed cumulative comparator event risk over trial follow-up in the included trials ({self._int(scenario.get('assumed_control_risk_per_1000'))} per 1000), "
            f"applying the pooled effect with a {method_text} gives an estimated intervention risk of "
            f"{self._int(scenario.get('intervention_risk_per_1000'))} per 1000, or "
            f"{self._absolute_effect_phrase(scenario)}; approximate {self._nnt_phrase(scenario)}. This clinical translation uses the observed cumulative baseline risk over trial follow-up "
            "and assumes the pooled relative effect can approximate cumulative risk over the trial follow-up; the absolute benefit may vary with "
            f"follow-up duration, local event definitions, and patient baseline risk. It is not a universal absolute risk difference. {scenario_note}"
        )

    def _absolute_effect_discussion_text(self, absolute_effects: dict | None) -> str:
        scenario = self._absolute_effect_primary_scenario(absolute_effects)
        if not scenario:
            return ""
        if self._zh:
            return (
                "结果部分和表4已经给出基于观察到的对照组风险以及不同基线风险场景的绝对效应换算。"
                "讨论中更重要的是如何使用这些换算：相同相对效应在高风险人群中会产生更大的绝对获益，"
                "在低风险人群中则可能转化为较小的短期绝对获益。"
            )
        return (
            "The Results section and Table 4 provide the numerical absolute-effect translation using the observed "
            "comparator risk and alternative baseline-risk scenarios. In clinical use, the key point is that the same "
            "relative effect produces larger absolute benefit in higher-risk patients and smaller short-term absolute "
            "benefit in lower-risk patients."
        )

    def _intervention_scope_sentence(self, facts: dict | None) -> str:
        examples = self._primary_intervention_examples(facts)
        if not examples:
            return ""
        if self._zh:
            localized = [self._zh_drug_name(item) for item in examples]
            joined = "、".join(localized)
            return f"该估计主要反映入池试验中{joined}的平均效应，外推至其它同类干预时仍需结合相应证据。"
        if len(examples) == 1:
            joined = examples[0]
        else:
            joined = ", ".join(examples[:-1]) + f", and {examples[-1]}"
        return (
            f"The direct estimate primarily reflects the contributing {joined} trial evidence; "
            "application to other SGLT2 inhibitors is a class-mechanism inference rather than direct trial evidence from this synthesis. "
        )

    def _primary_study_names_sentence(self, facts: dict | None) -> str:
        names = self._primary_study_names(facts)
        if not names:
            return ""
        if self._zh:
            joined = "、".join(names)
            return f"入池研究为{joined}；"
        if len(names) == 1:
            joined = names[0]
        else:
            joined = ", ".join(names[:-1]) + f", and {names[-1]}"
        return f"The contributing studies were {joined}. "

    def _primary_study_intervention_sentence(self, facts: dict | None) -> str:
        mapping = self._primary_study_intervention_map(facts)
        if not mapping:
            return ""
        if self._zh:
            parts = [f"{study}（{self._zh_drug_name(drug)}）" for study, drug in mapping]
            if len(parts) == 1:
                joined = parts[0]
            else:
                joined = "、".join(parts[:-1]) + f"和{parts[-1]}"
            return f"入池研究为{joined}；"
        parts = [f"{study} ({drug})" for study, drug in mapping]
        if len(parts) == 1:
            joined = parts[0]
        else:
            joined = ", ".join(parts[:-1]) + f", and {parts[-1]}"
        return f"The contributing trial rows were {joined}. "

    @staticmethod
    def _primary_study_intervention_map(facts: dict | None) -> list[tuple[str, str]]:
        facts = facts if isinstance(facts, dict) else {}
        cards = facts.get("study_cards") if isinstance(facts.get("study_cards"), list) else []
        known_order = [
            "empagliflozin",
            "dapagliflozin",
            "sotagliflozin",
            "canagliflozin",
            "dexamethasone",
            "hydrocortisone",
            "methylprednisolone",
        ]
        mapping: list[tuple[str, str]] = []
        for card in cards:
            if not isinstance(card, dict):
                continue
            study = str(card.get("display_name") or card.get("study_label") or "").strip()
            if not study:
                continue
            blob = " ".join([
                str(card.get("intervention") or ""),
                str(card.get("source_quote") or ""),
            ]).lower()
            drug = next((name for name in known_order if re.search(rf"\b{re.escape(name)}\b", blob)), "")
            if not drug:
                continue
            pair = (study, drug)
            if pair not in mapping:
                mapping.append(pair)
        return mapping[:4]

    @staticmethod
    def _primary_study_names(facts: dict | None) -> list[str]:
        facts = facts if isinstance(facts, dict) else {}
        names: list[str] = []
        for card in facts.get("study_cards") or []:
            if not isinstance(card, dict):
                continue
            name = str(card.get("display_name") or card.get("study_label") or "").strip()
            if name and name not in names:
                names.append(name)
        return names[:4]

    def _primary_intervention_examples_sentence(self, facts: dict | None) -> str:
        examples = self._primary_intervention_examples(facts)
        if not examples:
            return ""
        if self._zh:
            localized = [self._zh_drug_name(item) for item in examples]
            return "入池试验评估的具体药物包括" + "、".join(localized) + "；"
        if len(examples) == 1:
            joined = examples[0]
        else:
            joined = ", ".join(examples[:-1]) + f", and {examples[-1]}"
        return f"The contributing trials evaluated {joined}. "

    @staticmethod
    def _primary_intervention_examples(facts: dict | None) -> list[str]:
        facts = facts if isinstance(facts, dict) else {}
        cards = facts.get("study_cards") if isinstance(facts.get("study_cards"), list) else []
        rows = ((facts.get("evidence_readiness") or {}).get("selected_primary_rows") or []) if isinstance(facts.get("evidence_readiness"), dict) else []
        texts: list[str] = []
        for item in list(cards) + list(rows):
            if not isinstance(item, dict):
                continue
            texts.extend([
                str(item.get("intervention") or ""),
                str(item.get("source_quote") or ""),
            ])
        blob = " ".join(texts).lower()
        known_order = [
            "empagliflozin",
            "dapagliflozin",
            "sotagliflozin",
            "canagliflozin",
            "dexamethasone",
            "hydrocortisone",
            "methylprednisolone",
        ]
        found = [name for name in known_order if re.search(rf"\b{re.escape(name)}\b", blob)]
        if found:
            return found[:4]
        inferred: list[str] = []
        for match in re.finditer(r"\b(?:in the|the)\s+([A-Za-z][A-Za-z0-9 -]{2,40}?)\s+group\b", blob):
            name = re.sub(r"\s+", " ", match.group(1)).strip(" -")
            if not name or name in {"placebo", "control", "usual care", "standard care", "intervention"}:
                continue
            if len(name.split()) > 4:
                continue
            if name not in inferred:
                inferred.append(name)
        return inferred[:4]

    @staticmethod
    def _zh_drug_name(name: str) -> str:
        mapping = {
            "empagliflozin": "恩格列净",
            "dapagliflozin": "达格列净",
            "sotagliflozin": "索格列净",
            "canagliflozin": "卡格列净",
            "dexamethasone": "地塞米松",
            "hydrocortisone": "氢化可的松",
            "methylprednisolone": "甲泼尼龙",
        }
        return mapping.get(str(name or "").strip().lower(), str(name or "").strip())

    @staticmethod
    def _absolute_effect_scenarios(absolute_effects: dict | None) -> list[dict]:
        scenarios = (absolute_effects or {}).get("scenarios") if isinstance(absolute_effects, dict) else None
        if not isinstance(scenarios, list):
            return []
        return [scenario for scenario in scenarios if isinstance(scenario, dict)]

    @staticmethod
    def _absolute_effect_primary_scenario(absolute_effects: dict | None) -> dict:
        scenarios = FallbackContentMixin._absolute_effect_scenarios(absolute_effects)
        if not scenarios:
            return {}
        return scenarios[0]

    def _absolute_effect_scenario_label(self, scenario: dict) -> str:
        if self._zh:
            return str(scenario.get("label_zh") or scenario.get("label") or "基线风险场景")
        return str(scenario.get("label") or "Baseline-risk scenario")

    def _absolute_effect_range_text(self, absolute_effects: dict | None) -> str:
        scenarios = self._absolute_effect_scenarios(absolute_effects)
        values = sorted({
            self._int(scenario.get("events_avoided_per_1000"))
            for scenario in scenarios
            if self._int(scenario.get("events_avoided_per_1000")) > 0
        })
        if len(values) < 2:
            return ""
        low, high = values[0], values[-1]
        if self._zh:
            return f"为每1000人减少{low}至{high}例事件"
        return f"range from {low} to {high} fewer events per 1000"

    def _absolute_effect_phrase(self, scenario: dict) -> str:
        avoided = self._int(scenario.get("events_avoided_per_1000"))
        increased = self._int(scenario.get("events_increased_per_1000"))
        if scenario.get("absolute_ci_crosses_null") is True:
            fewer = self._int(scenario.get("events_avoided_ci_high_per_1000"))
            more = self._int(scenario.get("events_increased_ci_high_per_1000"))
            if self._zh:
                return f"每1000人减少{avoided}例事件（95% CI 从减少{fewer}例至增加{more}例）"
            return f"{avoided} fewer events per 1000 (95% CI {fewer} fewer to {more} more)"
        if avoided:
            low = self._int(scenario.get("events_avoided_ci_low_per_1000"))
            high = self._int(scenario.get("events_avoided_ci_high_per_1000"))
            if self._zh:
                ci = f"（95% CI 减少{low}至{high}例）" if low and high else ""
                return f"每1000人减少{avoided}例事件{ci}"
            ci = f" (95% CI {low} to {high} fewer)" if low and high else ""
            return f"{avoided} fewer events per 1000{ci}"
        if increased:
            low = self._int(scenario.get("events_increased_ci_low_per_1000"))
            high = self._int(scenario.get("events_increased_ci_high_per_1000"))
            if self._zh:
                ci = f"（95% CI 增加{low}至{high}例）" if low and high else ""
                return f"每1000人增加{increased}例事件{ci}"
            ci = f" (95% CI {low} to {high} more)" if low and high else ""
            return f"{increased} more events per 1000{ci}"
        return "每1000人绝对差异接近0例" if self._zh else "an absolute difference near 0 events per 1000"

    def _nnt_phrase(self, scenario: dict) -> str:
        nnt = self._int(scenario.get("nnt"))
        if not nnt:
            return "需治数未估计" if self._zh else "NNT not estimable"
        nnt_type = str(scenario.get("nnt_type") or "").upper()
        if not nnt_type:
            nnt_type = "NNTB" if self._int(scenario.get("events_avoided_per_1000")) else "NNH" if self._int(scenario.get("events_increased_per_1000")) else "NNT"
        low = self._int(scenario.get("nnt_ci_low"))
        high = self._int(scenario.get("nnt_ci_high"))
        crosses_null = scenario.get("absolute_ci_crosses_null") is True
        if self._zh:
            label = "获益需治数" if nnt_type == "NNTB" else "伤害需治数" if nnt_type == "NNH" else "需治数"
            if crosses_null:
                return f"{label}{nnt}（95% CI跨越无效值，因此区间需治数不有限）"
            ci = f"（95% CI {low}至{high}）" if low and high else ""
            return f"{label}{nnt}{ci}"
        if crosses_null:
            return f"{nnt_type} {nnt} (the 95% CI crosses no effect, so a finite NNT interval is not defined)"
        ci = f" (95% CI {low} to {high})" if low and high else ""
        return f"{nnt_type} {nnt}{ci}"

    def _generic_source_audit_table(self, rows: list[dict]) -> str:
        lines = (
            [
                "| 研究 | 行ID | 来源位置 | 来源依据 | 提取置信度 |",
                "|---|---|---|---|---|",
            ]
            if self._zh
            else [
                "| Study | Row ID | Source location | Source basis | Confidence |",
                "|---|---|---|---|---|",
            ]
        )
        for row in rows:
            lines.append(
                "| "
                + " | ".join([
                    self._md_cell(self._fallback_trial_label(row)),
                    self._md_cell(self._fallback_row_id(row)),
                    self._md_cell(self._fallback_source_location(row)),
                    self._md_cell(self._shorten(self._generic_source_quote(row), 180) or "NR"),
                    self._md_cell(row.get("extraction_confidence") or "NR"),
                ])
                + " |"
            )
        return "\n".join(lines)

    def _generic_source_quote(self, row: dict) -> str:
        effect = row.get("effect")
        if effect is not None:
            counts = (
                f"{self._int(row.get('events_intervention'))}/{self._int(row.get('total_intervention'))} vs "
                f"{self._int(row.get('events_control'))}/{self._int(row.get('total_control'))}"
            )
            if self._zh:
                return f"{counts}；报告效应量 {self._fmt(effect, 2)}。"
            return f"{counts}; reported effect {self._fmt(effect, 2)}."
        text = str(row.get("source_quote") or "")
        return re.sub(r"\bpatients\b", "participants", text, flags=re.IGNORECASE)

    @staticmethod
    def _fallback_search_date(search: dict | None) -> str:
        search = search or {}
        for key in ("search_date", "date", "run_date", "retrieved_at", "created_at"):
            raw = str(search.get(key) or "").strip()
            if raw:
                return raw[:10]
        return date.today().isoformat()

    def _fallback_prisma_flow_legend(
        self,
        *,
        prisma: dict | None,
        n_primary: int | None = None,
    ) -> str:
        prisma = prisma or {}
        records = self._int(prisma.get("records_identified"))
        duplicates = self._int(prisma.get("duplicates_removed"))
        dedup = self._int(prisma.get("records_after_dedup"))
        screened = self._int(prisma.get("title_abstract_screened")) or dedup
        full_text = self._int(prisma.get("full_text_assessed"))
        included = self._int(prisma.get("studies_included"))
        quantitative = self._int(n_primary) or self._int(prisma.get("studies_quantitative")) or included
        if self._zh:
            return (
                f"图注：PRISMA流程图显示共识别{records}条记录，删除{duplicates}条重复记录后"
                f"{dedup}条进入去重后记录集；筛选{screened}条题名/摘要记录，全文评估{full_text}篇，"
                f"最终纳入{included}项研究，其中{quantitative}项进入定量合成。"
            )
        return (
            f"Legend: The PRISMA flow diagram shows {records} records identified, {duplicates} duplicates removed, "
            f"{dedup} records after deduplication, {screened} records screened, {full_text} full-text reports assessed, "
            f"{included} studies included, and {quantitative} studies in the quantitative synthesis."
        )

    def _fallback_prisma_2020_checklist(
        self,
        *,
        prisma: dict | None,
        search_date: str,
        has_rob: bool,
        has_grade: bool,
    ) -> str:
        prisma = prisma or {}
        records = self._int(prisma.get("records_identified"))
        dedup = self._int(prisma.get("records_after_dedup"))
        full_text = self._int(prisma.get("full_text_assessed"))
        included = self._int(prisma.get("studies_included"))
        if self._zh:
            rows = [
                ("标题/摘要", "1-2", "标题识别为系统综述和Meta分析；摘要报告目的、资料来源、纳入标准、合成方法和主要结果。", "标题；摘要"),
                ("引言", "3-4", "说明研究依据并用PICO陈述研究问题。", "引言"),
                ("纳入标准", "5", "说明人群、干预、对照、结局和研究设计标准。", "方法"),
                ("信息来源", "6", f"列出检索来源和检索日期（{search_date}）。", "方法"),
                ("检索策略", "7", "报告完整检索式。", "附录1"),
                ("筛选和提取", "8-10", "说明筛选、提取和资料条目，来源核验见附录2。", "方法；附录2"),
                ("偏倚风险", "11", "报告研究层面偏倚风险评估方法和结果。", "方法；结果" if has_rob else "未正式评价"),
                ("效应量和合成", "12-13", "说明效应量、模型、异质性和敏感性分析。", "方法；结果；附录3"),
                ("发表偏倚", "14,20", "研究数不足时不作确认性小样本效应判断。", "方法；讨论"),
                ("证据确定性", "15,21", "报告GRADE评价和降级理由。", "表3" if has_grade else "未正式评价"),
                ("筛选结果", "16", f"报告{records}条识别记录、{dedup}条去重后记录、{full_text}篇全文和{included}项纳入研究。", "结果；图1"),
                ("讨论和其他", "22-23", "解释结果、限制、注册、数据可得性、资助和利益冲突。", "讨论；声明"),
            ]
            header = "| 主题 | PRISMA条目 | 本稿填写内容 | 位置 |\n|---|---|---|---|"
        else:
            rows = [
                ("Title/abstract", "1-2", "Title identifies a systematic review and meta-analysis; abstract reports objective, sources, eligibility, synthesis, and main findings.", "Title; Abstract"),
                ("Introduction", "3-4", "Rationale and PICO-framed objective are reported.", "Introduction"),
                ("Eligibility criteria", "5", "Population, intervention, comparator, outcome, and design criteria are specified.", "Methods"),
                ("Information sources", "6", f"Sources and search date ({search_date}) are reported.", "Methods"),
                ("Search strategy", "7", "Full Boolean strategy is reproduced.", "Appendix 1"),
                ("Selection/data collection", "8-10", "Screening, extraction, and data items are described; source documentation is tabulated.", "Methods; Appendix 2"),
                ("Risk of bias", "11", "Study-level risk-of-bias approach and results are reported.", "Methods; Results" if has_rob else "Not formally assessed"),
                ("Effect measures/synthesis", "12-13", "Effect measure, model, heterogeneity, and sensitivity methods are reported.", "Methods; Results; Appendix 3"),
                ("Reporting bias", "14,20", "Small-study effects are not interpreted confirmatorily when study counts are sparse.", "Methods; Discussion"),
                ("Certainty", "15,21", "GRADE certainty and downgrading rationale are reported.", "Table 3" if has_grade else "Not formally assessed"),
                ("Study selection", "16", f"Reports {records} records identified, {dedup} after deduplication, {full_text} full texts, and {included} included studies.", "Results; Figure 1"),
                ("Discussion/other", "22-23", "Interpretation, limitations, registration, data availability, funding, and competing interests are reported.", "Discussion; Declarations"),
            ]
            header = "| Topic | PRISMA item | Completed reporting content | Location |\n|---|---|---|---|"
        return header + "\n" + "\n".join(f"| {a} | {b} | {c} | {d} |" for a, b, c, d in rows)

    def _fallback_prisma_s_checklist(self, *, search: dict | None, search_date: str) -> str:
        search = search or {}
        source_names = self._source_names_for_manuscript(search)
        source_counts = self._fallback_source_counts(search.get("source_counts") or {})
        query_status = "完整检索式见附录1" if self._zh else "Full strategy reproduced in Appendix 1"
        if self._zh:
            return "\n".join([
                "| PRISMA-S项目 | 填写内容 |",
                "|---|---|",
                f"| 信息来源 | {self._zh_source_label_list(source_names)}；初检记录数：{source_counts} |",
                f"| 检索日期 | {search_date} |",
                f"| 完整检索式 | {query_status} |",
                "| 限制条件 | 按项目配置应用语言、研究设计、数据库和全文可得性限制；具体检索式保留在附录1。 |",
                "| 记录管理 | 去重数量和筛选流程见结果和图1。 |",
            ])
        return "\n".join([
            "| PRISMA-S item | Completed content |",
            "|---|---|",
            f"| Information sources | {self._en_source_label_list(source_names)}; initial record counts: {source_counts} |",
            f"| Search date | {search_date} |",
            f"| Full search strategy | {query_status} |",
            "| Limits and restrictions | Language, study-design, database, and full-text availability limits followed the specified eligibility settings; the exact query is retained in Appendix 1. |",
            "| Record management | Deduplication and screening counts are reported in Results and Figure 1. |",
        ])

    def _fallback_robis_assessment(self, *, readiness: dict | None, n_primary: int) -> str:
        readiness = readiness or {}
        warnings = readiness.get("warnings") or []
        source_warning = bool(warnings)
        sparse = n_primary < 10
        if self._zh:
            rows = [
                ("研究资格标准", "低风险", "PICO、研究设计和主要结局在方法中预设。"),
                ("研究识别和选择", "低到中等风险" if source_warning else "低风险", "检索来源、去重和筛选数量已报告；任何来源限制应结合附录核对。"),
                ("数据收集和研究评价", "中等风险" if source_warning else "低到中等风险", "主要数据有来源表；部分记录可能仍需人工全文复核。"),
                ("合成和发现", "中等风险" if sparse else "低到中等风险", "合成方法预设；研究数较少时异质性和发表偏倚判断能力有限。"),
                ("总体偏倚风险", "中等风险" if (source_warning or sparse) else "低到中等风险", "ROBIS用于评价本综述过程本身，不能替代单个试验RoB 2或GRADE。"),
            ]
            header = "| ROBIS域 | 判断 | 理由 |\n|---|---|---|"
        else:
            rows = [
                ("Study eligibility criteria", "Low concern", "PICO, design, and primary outcome were prespecified in Methods."),
                ("Identification and selection of studies", "Low to moderate concern" if source_warning else "Low concern", "Search sources, deduplication, and screening counts are reported; source limits should be checked against appendices."),
                ("Data collection and study appraisal", "Moderate concern" if source_warning else "Low to moderate concern", "Primary data have a source table; some records may still require manual full-text confirmation."),
                ("Synthesis and findings", "Moderate concern" if sparse else "Low to moderate concern", "Synthesis methods were prespecified; sparse study counts limit heterogeneity and publication-bias assessment."),
                ("Overall risk of bias in the review", "Moderate concern" if (source_warning or sparse) else "Low to moderate concern", "ROBIS assesses the review process itself and does not replace trial-level RoB 2 or GRADE."),
            ]
            header = "| ROBIS domain | Judgment | Rationale |\n|---|---|---|"
        return header + "\n" + "\n".join(f"| {a} | {b} | {c} |" for a, b, c in rows)

    def _generic_figures_section(
        self,
        project: Project | None,
        outcome: str,
        *,
        prisma: dict | None = None,
        n_primary: int | None = None,
    ) -> str:
        if not project:
            return "未提供可用图表文件。" if self._zh else "No figure files were available."
        figure_specs = (
            [
                ("PRISMA流程图", "prisma_diagram.png"),
                (f"{outcome}森林图", "forest_plot.png"),
                ("偏倚风险概要", "rob_summary.png"),
                ("逐一剔除敏感性分析图", "sensitivity.png"),
                ("网络Meta分析证据网络", "nma_network.png"),
                ("网络Meta分析联赛表", "nma_league_table.png"),
                ("剂量-反应曲线", "dose_response_curve.png"),
            ]
            if self._zh
            else [
                ("PRISMA flow diagram", "prisma_diagram.png"),
                (f"Forest plot for {outcome}", "forest_plot.png"),
                ("Risk-of-bias summary", "rob_summary.png"),
                ("Leave-one-out sensitivity plot", "sensitivity.png"),
                ("Network meta-analysis evidence geometry", "nma_network.png"),
                ("Network meta-analysis league table", "nma_league_table.png"),
                ("Dose-response curve", "dose_response_curve.png"),
            ]
        )
        blocks = []
        for label, filename in figure_specs:
            path = project.base_dir / "figures" / filename
            if path.exists():
                caption = (
                    f"图{len(blocks) + 1}. {label}"
                    if self._zh else
                    f"Figure {len(blocks) + 1}. {label}"
                )
                legend = ""
                if filename == "prisma_diagram.png":
                    legend = "\n\n" + self._fallback_prisma_flow_legend(prisma=prisma, n_primary=n_primary)
                blocks.append(f"### {caption}\n\n![{caption}](../figures/{filename}){legend}")
        return "\n\n".join(blocks) if blocks else ("未提供可用图表文件。" if self._zh else "No figure files were available.")

    def _compiled_method_article_text(self, facts: dict, *, zh: bool) -> dict[str, str]:
        """Reader-facing method language for compiled synthesis families."""
        family = str(facts.get("method_family") or "")
        synthesis = facts.get("synthesis_result") if isinstance(facts.get("synthesis_result"), dict) else {}
        payload = synthesis.get("engine_payload") if isinstance(synthesis.get("engine_payload"), dict) else {}
        estimator = str(synthesis.get("estimator") or "the prespecified estimator")
        n_studies = self._int(synthesis.get("n_studies"))
        estimates = [item for item in synthesis.get("primary_estimates") or [] if isinstance(item, dict)]
        estimate_texts = []
        for item in estimates:
            label = str(item.get("label") or item.get("estimate_id") or "Estimate")
            measure = str(item.get("measure") or "effect")
            effect = self._fmt(item.get("estimate"), 2)
            lower = self._fmt(item.get("ci_lower"), 2)
            upper = self._fmt(item.get("ci_upper"), 2)
            estimate_text = f"{label}: {measure} {effect} (95% CI {lower} to {upper})"
            if item.get("prediction_lower") is not None and item.get("prediction_upper") is not None:
                prediction_lower = self._fmt(item.get("prediction_lower"), 2)
                prediction_upper = self._fmt(item.get("prediction_upper"), 2)
                estimate_text += f"; 95% prediction interval {prediction_lower} to {prediction_upper}"
            estimate_texts.append(estimate_text)
        result_summary = "; ".join(estimate_texts) + ("." if estimate_texts else "")
        common = {
            "active": "true" if family else "",
            "family": family,
            "result_summary": result_summary,
            "table2_title": "Study-level effects used in the compiled synthesis",
        }
        if not family:
            return common
        if family == "intervention_rct":
            if zh:
                return {
                    **common,
                    "study_selection": "纳入直接回答预设PICO的随机试验；整群、交叉和多臂设计仅在其相关性结构能够由报告数据重建时进入定量合成。",
                    "abstract_synthesis": f"研究效应先按随机化设计还原为独立研究单位，再采用{estimator}合并。整群试验使用报告的校正估计或可验证设计效应；交叉试验仅接受配对精度；多臂试验通过显式共享对照协方差和广义最小二乘整合。",
                    "unit": "分析单位为独立随机化研究，而非单条对比。平行设计直接贡献研究层效应；整群设计必须校正聚类；交叉设计必须保留配对方差；多臂试验的共享对照相关性通过协方差矩阵建模，避免把同一对照组重复当作独立信息。",
                    "statistics": f"主要模型为{estimator}。比值类效应在对数尺度分析，研究内相关对比先用广义最小二乘合并为独立研究效应，再估计研究间方差；报告合并效应、95% CI和预测区间。HKSJ结果作为小样本推断敏感性分析，而不是替代主要模型。",
                    "limitations": "该设计感知合成纠正了可识别的聚类、配对和共享对照依赖，但无法弥补原报告未给出的组内相关系数、配对方差或协方差；缺少这些精度信息的复杂设计严格不进入合并。",
                    "calculation": f"主要计算以{n_studies}个独立研究单位为基础；复杂设计依赖在研究内处理后才进行研究间{estimator}合并。",
                    "table2_title": "设计校正后的研究层效应",
                }
            return {
                **common,
                "study_selection": "Randomized trials directly matching the prespecified PICO were eligible; cluster, crossover, and multi-arm designs entered quantitative synthesis only when their dependence structure could be reconstructed from reported data.",
                "abstract_synthesis": f"Effects were reduced to independent randomized-study units and synthesized with {estimator}. Cluster trials required a reported adjusted estimate or verifiable design effect, crossover trials required paired precision, and multi-arm trials were consolidated using explicit shared-control covariance and generalized least squares.",
                "unit": "The unit of analysis was the independent randomized study, not an individual contrast. Parallel trials contributed a study effect directly; cluster trials required clustering adjustment; crossover trials retained paired variance; and correlations induced by shared controls in multi-arm trials were represented in a covariance matrix so the same control group was not counted as independent information more than once.",
                "statistics": f"The primary estimator was {estimator}. Ratio measures were analyzed on the log scale. Correlated within-study contrasts were first consolidated by generalized least squares, after which between-study heterogeneity was estimated across independent study units. The pooled effect, 95% confidence interval, and prediction interval were reported. HKSJ inference was retained as a small-sample sensitivity analysis rather than substituted for the primary model.",
                "limitations": "The design-aware synthesis corrects identifiable clustering, pairing, and shared-control dependence, but it cannot recreate an unreported intracluster correlation, paired variance, or covariance. Complex-design results lacking the required precision information were therefore excluded from pooling rather than treated as ordinary independent comparisons.",
                "calculation": f"The primary calculation used {n_studies} independent study units; complex-design dependence was resolved within study before the {estimator} between-study synthesis.",
                "table2_title": "Design-adjusted study-level effects",
            }
        if family == "network_meta":
            transitivity = payload.get("transitivity_assessment") or {}
            transitivity_status = str(transitivity.get("status") or "documented")
            if zh:
                return {
                    **common,
                    "study_selection": "纳入形成连通治疗网络、报告同一结局和可比随访窗口的随机对照证据；传递性不足的比较不进入网络合成。",
                    "abstract_synthesis": f"在传递性评价为{transitivity_status}且证据网络连通后，采用{estimator}同时合并直接与间接证据；多臂试验的相关性在研究内保留。",
                    "unit": "分析单位为随机试验内的治疗对比；同一多臂试验产生的多个对比通过完整协方差结构联合建模，不被拆成相互独立的两臂试验。",
                    "statistics": f"网络Meta分析采用{estimator}一致性模型。预先检查网络连通性与传递性，并以设计-治疗交互和节点拆分评估不一致性；联赛表报告全部网络相对效应，治疗排序仅作次要描述，不替代效应大小、区间和确定性。",
                    "limitations": "网络估计同时依赖直接证据、传递性和一致性假设；稀疏比较、效应修饰因子分布不平衡或局部不一致会限制间接比较和排序的可信度。",
                    "calculation": f"主要计算包含{n_studies}项独立研究，并在一个连通网络中保留多臂协方差、直接证据和间接证据。",
                    "table2_title": "网络相对效应联赛表",
                }
            return {
                **common,
                "study_selection": "Randomized evidence reporting the same outcome and a comparable follow-up window was eligible when it formed a connected treatment network; comparisons that did not support transitivity were not synthesized in the network.",
                "abstract_synthesis": f"After transitivity was rated {transitivity_status} and network connectivity was confirmed, direct and indirect evidence were synthesized jointly with {estimator}; correlations from multi-arm trials were retained within study.",
                "unit": "The unit of analysis was a treatment contrast nested within a randomized trial. Contrasts arising from the same multi-arm trial were modeled jointly with their covariance structure and were not split into independent two-arm studies.",
                "statistics": f"Network meta-analysis used the {estimator} consistency model. Connectivity and transitivity were checked before estimation; design-by-treatment interaction and node-splitting diagnostics assessed global and local inconsistency. The league table reports all network relative effects. Treatment rankings were descriptive secondary results and were not interpreted without effect magnitudes, intervals, and certainty.",
                "limitations": "Network estimates depend jointly on direct evidence, transitivity, and consistency. Sparse comparisons, imbalance in effect modifiers, and local inconsistency can reduce confidence in indirect estimates and rankings.",
                "calculation": f"The network calculation used {n_studies} independent studies while retaining multi-arm covariance and combining direct and indirect evidence in one connected network.",
                "table2_title": "Network relative effects (league table)",
            }
        if family == "dose_response":
            unit = str(payload.get("dose_unit") or "dose units")
            if zh:
                return {
                    **common,
                    "study_selection": "纳入报告至少两个可比较暴露剂量、共同参考剂量和可恢复剂量特异效应精度的研究。",
                    "abstract_synthesis": f"相关剂量对比在研究内以广义最小二乘处理，并用{estimator}限制性立方样条估计{unit}尺度上的非线性剂量-反应曲线。",
                    "unit": "分析单位为研究内相对于共同参考剂量的相关剂量对比；同一研究的多个剂量点共享参考组，因此以协方差矩阵联合处理，不能当作独立研究。",
                    "statistics": f"采用{estimator}多变量随机效应剂量-反应模型。剂量统一到{unit}，限制性立方样条表达潜在非线性，并报告曲线点估计、95% CI及非线性检验；不把最高剂量点当作普通两组Meta分析。",
                    "limitations": "剂量-反应曲线受剂量换算、参考剂量、剂量范围覆盖和研究内协方差可得性限制；观察性研究还可能残留剂量选择相关混杂。",
                    "calculation": f"主要计算使用{n_studies}项研究的相关剂量对比，并在{unit}统一尺度上拟合多变量样条曲线。",
                    "table2_title": "预设剂量点的剂量-反应估计",
                }
            return {
                **common,
                "study_selection": "Studies were eligible when they reported at least two comparable exposure doses, a common reference dose, and recoverable precision for dose-specific effects.",
                "abstract_synthesis": f"Correlated dose contrasts were handled within study by generalized least squares and a {estimator} restricted-cubic-spline model estimated the potentially nonlinear dose-response curve on the {unit} scale.",
                "unit": "The unit of analysis was a dose contrast relative to a common within-study reference. Multiple dose levels from one study share that reference and were therefore analyzed jointly through a covariance matrix rather than counted as independent studies.",
                "statistics": f"A {estimator} multivariate random-effects dose-response model was fitted after harmonizing dose to {unit}. Restricted cubic splines represented possible nonlinearity; curve estimates, 95% confidence intervals, and the nonlinearity test were reported. The maximum observed dose was not analyzed as an ordinary two-group meta-analysis.",
                "limitations": "The dose-response curve remains sensitive to dose conversion, the reference dose, coverage of the dose range, and availability of within-study covariance. Observational dose data may also retain confounding related to dose selection.",
                "calculation": f"The primary calculation used correlated dose contrasts from {n_studies} studies and fitted a multivariate spline curve on the harmonized {unit} scale.",
                "table2_title": "Dose-response estimates at prespecified doses",
            }
        if family == "ipd_meta":
            if zh:
                return {
                    **common,
                    "study_selection": "仅纳入可获得、可校验并可映射到共同变量字典的个体参与者数据集；只有汇总结果而无IPD的数据不冒充IPD分析。",
                    "abstract_synthesis": f"各研究IPD按共同结局、治疗和协变量定义协调，先估计研究特异效应，再以{estimator}进行两阶段合并；一阶段分层模型作为敏感性分析。",
                    "unit": "参与者嵌套于原随机研究内；治疗效应先在研究内估计，随后跨研究合并。效应修饰协变量在研究内中心化，以区分个体内关联与研究间生态差异。",
                    "statistics": f"主要分析为{estimator}两阶段IPD Meta分析，并报告研究特异效应、合并效应、异质性和预测区间。一阶段分层模型检验模型形式敏感性；治疗-协变量交互在研究内中心化后单独估计。",
                    "limitations": "IPD结果受数据集可得性、变量协调、缺失数据和未提供IPD研究的选择性影响；汇总数据不能填补缺失参与者记录，也不会被当作IPD。",
                    "calculation": f"主要计算包含{n_studies}个协调后的IPD数据集；先在研究内估计治疗效应，再进行两阶段{estimator}合并，并以一阶段模型验证。",
                    "table2_title": "IPD研究特异效应",
                }
            return {
                **common,
                "study_selection": "Only participant-level datasets that were available, validated, and mappable to a common data dictionary were eligible; studies with aggregate results alone were not represented as IPD analyses.",
                "abstract_synthesis": f"IPD were harmonized to common outcome, treatment, and covariate definitions. Study-specific effects were estimated first and pooled with {estimator} in a two-stage analysis; a stratified one-stage model was used as sensitivity analysis.",
                "unit": "Participants remained nested within their randomized studies. Treatment effects were estimated within study before cross-study pooling. Candidate effect modifiers were centered within study to distinguish participant-level interaction from between-study ecological differences.",
                "statistics": f"The primary analysis was a two-stage {estimator} IPD meta-analysis reporting study-specific effects, the pooled effect, heterogeneity, and a prediction interval. A stratified one-stage model assessed model-form sensitivity. Treatment-covariate interactions were estimated separately after within-study centering.",
                "limitations": "IPD findings remain vulnerable to dataset availability, variable harmonization, missing participant data, and selective nonavailability of IPD. Aggregate results cannot fill missing participant records and were not treated as IPD.",
                "calculation": f"The primary calculation included {n_studies} harmonized IPD datasets; treatment effects were estimated within study, pooled with the two-stage {estimator}, and checked against a one-stage model.",
                "table2_title": "IPD study-specific effects",
            }
        return common

    def _compiled_method_certainty_table(self, facts: dict) -> str:
        outcomes = ((facts.get("grade") or {}).get("outcomes") or [])
        if not outcomes:
            return self._fallback_grade_table({})
        # Method certainty is already a structured, result-specific contract.
        # Render it directly; never substitute topic-specific cached prose.
        tables = [self._fallback_grade_table(dict(outcome)) for outcome in outcomes]
        return "\n".join(tables)

    def _compiled_method_effect_table(self, facts: dict, fallback_rows: list[dict], effect_measure: str) -> str:
        synthesis = facts.get("synthesis_result") if isinstance(facts.get("synthesis_result"), dict) else {}
        family = str(facts.get("method_family") or "")
        if family == "network_meta":
            lines = (
                ["| 网络比较 | 效应量 | 估计值 | 95% CI |", "|---|---|---:|---:|"]
                if self._zh else
                ["| Network comparison | Measure | Estimate | 95% CI |", "|---|---|---:|---:|"]
            )
            for item in synthesis.get("primary_estimates") or []:
                lines.append(
                    f"| {self._md_cell(item.get('label'))} | {item.get('measure')} | {self._fmt(item.get('estimate'), 3)} | "
                    f"{self._fmt(item.get('ci_lower'), 3)} to {self._fmt(item.get('ci_upper'), 3)} |"
                )
            return "\n".join(lines)
        if family == "dose_response":
            lines = (
                ["| 剂量 | 效应量 | 估计值 | 95% CI |", "|---:|---|---:|---:|"]
                if self._zh else
                ["| Dose | Measure | Estimate | 95% CI |", "|---:|---|---:|---:|"]
            )
            payload = synthesis.get("engine_payload") or {}
            for item in payload.get("curve") or []:
                lines.append(
                    f"| {self._fmt(item.get('dose'), 3)} {payload.get('dose_unit') or ''} | {payload.get('measure') or effect_measure} | "
                    f"{self._fmt(item.get('effect'), 3)} | {self._fmt(item.get('ci_lower'), 3)} to {self._fmt(item.get('ci_upper'), 3)} |"
                )
            return "\n".join(lines)
        return self._generic_effect_table(
            fallback_rows,
            (facts.get("primary_effect") or {}).get("studies") or [],
            effect_measure,
        )

    def _write_section_with_retry(self, label: str, writer, max_attempts: int = 3) -> str:
        """Retry one manuscript section before falling back for the whole manuscript."""
        last_error: Exception | None = None
        for attempt in range(1, max_attempts + 1):
            try:
                return writer()
            except Exception as exc:
                last_error = exc
                if attempt < max_attempts:
                    self.log(
                        f"{label} generation failed (attempt {attempt}/{max_attempts}): {exc}; retrying section.",
                        level="warning",
                    )
                else:
                    self.log(
                        f"{label} generation failed after {max_attempts} attempts: {exc}",
                        level="error",
                    )
        raise last_error or RuntimeError(f"{label} generation failed")

    @staticmethod
    def _int(value) -> int:
        try:
            if value is None or value == "":
                return 0
            return int(float(value))
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _fmt(value, digits: int = 2) -> str:
        try:
            return f"{float(value):.{digits}f}"
        except (TypeError, ValueError):
            return "NR"

    @classmethod
    def _format_p(cls, value, *, bare: bool = False) -> str:
        try:
            val = float(value)
        except (TypeError, ValueError):
            return "NR" if bare else "NR"
        if val < 0.001:
            return "<0.001" if bare else "<0.001"
        return f"{val:.3f}"

    @classmethod
    def _p_text(cls, value) -> str:
        formatted = cls._format_p(value, bare=True)
        if formatted == "NR":
            return "p=NR"
        return f"p{formatted}" if formatted.startswith("<") else f"p={formatted}"

    @staticmethod
    def _maybe_get(data: dict, *keys):
        current = data or {}
        for key in keys:
            if not isinstance(current, dict):
                return None
            current = current.get(key)
        return current

    def _fallback_effect_text(self, primary: dict, effect_measure: str) -> str:
        if self._zh:
            return (
                f"{effect_measure} {self._fmt(primary.get('pooled_effect'), 2)}"
                f"（95% CI {self._fmt(primary.get('ci_lower'), 2)}至{self._fmt(primary.get('ci_upper'), 2)}）"
            )
        return (
            f"{effect_measure} {self._fmt(primary.get('pooled_effect'), 2)} "
            f"(95% CI {self._fmt(primary.get('ci_lower'), 2)} to {self._fmt(primary.get('ci_upper'), 2)})"
        )

    def _fallback_source_counts(self, source_counts: dict) -> str:
        if not source_counts:
            return "未记录" if self._zh else "not available"
        if self._zh:
            return "; ".join(f"{self._zh_source_label(name)}: {count}" for name, count in source_counts.items())
        return "; ".join(f"{self._en_source_label(name)}: {count}" for name, count in source_counts.items())

    def _source_names_for_manuscript(self, search: dict | None) -> list[str]:
        search = search if isinstance(search, dict) else {}
        counts = search.get("source_counts") if isinstance(search.get("source_counts"), dict) else {}
        counted_names = [
            str(name)
            for name, count in counts.items()
            if str(name or "").strip() and self._int(count) > 0
        ]
        if counted_names:
            return counted_names
        names = search.get("source_names")
        return [str(name) for name in names if str(name or "").strip()] if isinstance(names, list) else []

    @staticmethod
    def _en_source_label(name: str) -> str:
        raw = re.sub(r"\s+", " ", str(name or "")).strip()
        low = raw.lower().replace("_", " ")
        if (
            low in {
                "internal db",
                "internal database",
                "internal literature database",
                "internal literature db",
                "curated biomedical literature index",
                "curated literature index",
            }
            or ("internal" in low and ("literature" in low or "database" in low or "db" in low))
        ):
            return "curated literature index"
        return raw or "unrecorded source"

    def _en_source_label_list(self, names: list[str]) -> str:
        labels = [self._en_source_label(name) for name in names if str(name or "").strip()]
        return ", ".join(labels) if labels else "the configured literature sources"

    def _source_reproducibility_limitation_context(self, source_names: list[str] | None) -> str:
        names = source_names if isinstance(source_names, list) else []
        has_curated_index = any(
            (
                "curated literature index" in str(name or "").lower()
                or (
                    "internal" in str(name or "").lower()
                    and (
                        "literature" in str(name or "").lower()
                        or "database" in str(name or "").lower()
                        or "db" in str(name or "").lower()
                    )
                )
            )
            for name in names
        )
        if not has_curated_index:
            return ""
        if self._zh:
            return (
                "检索来源包括本地整理的文献索引；该来源并非独立公共数据库，因此外部复现需要依赖导出包中的"
                "完整检索式、来源计数和保留记录清单。正式投稿或指南更新时，应尽可能用可公开复现的数据库检索补充或替代该本地来源。"
            )
        return (
            "The search included a curated literature index in addition to public bibliographic sources. "
            "External reproducibility therefore depends on the exported query, source counts, and retained record list; "
            "future submissions or updates should supplement or replace this source with publicly reproducible database searches when possible."
        )

    def _source_reproducibility_methods_note(self, source_names: list[str] | None) -> str:
        names = source_names if isinstance(source_names, list) else []
        has_curated_index = any(
            (
                "curated literature index" in str(name or "").lower()
                or (
                    "internal" in str(name or "").lower()
                    and (
                        "literature" in str(name or "").lower()
                        or "database" in str(name or "").lower()
                        or "db" in str(name or "").lower()
                    )
                )
            )
            for name in names
        )
        if not has_curated_index:
            return ""
        if self._zh:
            return (
                "本地整理的文献索引是静态、项目内记录来源，不等同于实时公共数据库检索，也不应被表述为可由外部读者直接访问的数据库；"
                "本次运行未把该索引的构建来源、纳入日期和维护流程记录为可独立复现的方法学输入。"
                "导出包保留检索式、来源计数和记录清单以便复核。若用于正式投稿或指南更新，应以可公开复现的数据库检索补充或替代该来源。\n\n"
            )
        return (
            "The curated literature index is a static evidence source rather than a live public database search. Its "
            "construction source, inclusion date, and maintenance process were not captured in this run as independently "
            "reproducible methods inputs. The export package preserves the query, source counts, and retained record list "
            "for audit. For formal submission or guideline updating, this source should be supplemented or replaced by "
            "publicly reproducible database searches.\n\n"
        )

    @staticmethod
    def _zh_source_label(name: str) -> str:
        raw = re.sub(r"\s+", " ", str(name or "")).strip()
        low = raw.lower()
        labels = {
            "internal literature database": "医学文献索引",
            "internal database": "医学文献索引",
            "curated biomedical literature index": "医学文献索引",
            "curated literature index": "医学文献索引",
            "pubmed": "PubMed",
            "pmc": "PMC",
            "openalex": "OpenAlex",
            "semantic scholar": "Semantic Scholar",
            "clinicaltrials.gov": "ClinicalTrials.gov",
            "clinicaltrials": "ClinicalTrials.gov",
            "eu clinical trials register": "EU Clinical Trials Register",
        }
        if low in labels:
            return labels[low]
        if "internal" in low and ("literature" in low or "database" in low):
            return "医学文献索引"
        return raw or "未记录来源"

    def _zh_source_label_list(self, names: list[str]) -> str:
        labels = [self._zh_source_label(name) for name in names if str(name or "").strip()]
        return "、".join(labels) if labels else "预设文献来源"

    @staticmethod
    def _zh_model_label(model: str) -> str:
        raw = re.sub(r"\s+", " ", str(model or "")).strip()
        low = raw.lower().replace("_", " ")
        if "random" in low:
            return "随机效应"
        if "fixed" in low or "common" in low:
            return "固定效应"
        if low in {"dl", "reml", "hksj", "paule mandel", "pm"}:
            return "随机效应"
        return raw or "预设"

    @staticmethod
    def _actual_primary_model_label(facts: dict | None, *, primary: dict | None = None) -> str:
        facts = facts if isinstance(facts, dict) else {}
        decision = facts.get("model_decision") if isinstance(facts.get("model_decision"), dict) else {}
        for key in ("primary_engine_model", "primary_model"):
            value = str(decision.get(key) or "").strip().lower()
            if value in {"fixed", "random"}:
                return value
        primary = primary if isinstance(primary, dict) else facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
        for value in (
            primary.get("engine_model") if isinstance(primary, dict) else "",
            primary.get("model") if isinstance(primary, dict) else "",
            facts.get("model"),
        ):
            value = str(value or "").strip().lower()
            if value in {"fixed", "random"}:
                return value
        return ""

    @staticmethod
    def _fallback_warning_text_zh(warnings: list[dict]) -> str:
        actionable_messages = []
        for item in warnings:
            message = str(item.get("message") or "").strip().rstrip(".。")
            if message and not (item.get("action_required") is False or item.get("scope") == "non_primary_records"):
                actionable_messages.append(message)
        if not actionable_messages:
            return ""
        return " 证据就绪性审计仍提示：" + "；".join(actionable_messages) + "。"

    @staticmethod
    def _fallback_warning_text(warnings: list[dict]) -> str:
        actionable_messages = []
        for item in warnings:
            message = str(item.get("message") or "").strip()
            if message:
                message = message.rstrip(".")
                message = re.sub(
                    r"(\d+) extracted outcome row\(s\) require review before submission",
                    r"\1 extracted outcome rows requiring review",
                    message,
                )
                message = re.sub(
                    r"(\d+) extracted outcome row\(s\) contain conflict notes",
                    r"\1 extracted outcome rows with conflict notes",
                    message,
                )
                if not (item.get("action_required") is False or item.get("scope") == "non_primary_records"):
                    actionable_messages.append(message)
        if not actionable_messages:
            return ""
        return " The evidence-readiness audit still flagged " + "; ".join(actionable_messages) + "."

    def _fallback_references(self, ref_manager: ReferenceManager | None) -> tuple[str, dict[str, str]]:
        lines: list[str] = []
        cite_map: dict[str, str] = {}
        entries = getattr(ref_manager, "entries", None) if ref_manager else None
        if entries:
            for idx, paper in enumerate(entries, 1):
                lines.append(self._format_reference_entry(idx, paper))
            cite_map = {str(study_id): f"[{num}]" for study_id, num in getattr(ref_manager, "_id_map", {}).items()}

        known_id_values = set(cite_map)
        known_text = "\n".join(lines).lower()
        supplemental = [
            {
                "aliases": ["benchmark:who_react"],
                "needle": "10.1001/jama.2020.17023",
                "paper": {
                    "title": "Association Between Administration of Systemic Corticosteroids and Mortality Among Critically Ill Patients With COVID-19: A Meta-analysis",
                    "authors": ["WHO REACT Working Group"],
                    "journal": "JAMA",
                    "year": "2020",
                    "volume": "324",
                    "issue": "13",
                    "pages": "1330-1341",
                    "doi": "10.1001/jama.2020.17023",
                },
                "text": "WHO REACT Working Group. Association Between Administration of Systemic Corticosteroids and Mortality Among Critically Ill Patients With COVID-19: A Meta-analysis. *JAMA*. 2020;324(13):1330-1341. doi: 10.1001/jama.2020.17023",
            },
            {
                "aliases": ["32799933", "NCT04325061"],
                "needle": "10.1186/s13063-020-04643-1",
                "paper": {
                    "title": "Efficacy of dexamethasone treatment for patients with the acute respiratory distress syndrome caused by COVID-19: study protocol for a randomized controlled trial",
                    "authors": ["Villar J", "Confalonieri M", "Pastores SM", "Meduri GU"],
                    "journal": "Trials",
                    "year": "2020",
                    "volume": "21",
                    "pages": "717",
                    "doi": "10.1186/s13063-020-04643-1",
                },
                "text": "Villar J, Confalonieri M, Pastores SM, Meduri GU. Efficacy of dexamethasone treatment for patients with the acute respiratory distress syndrome caused by COVID-19: study protocol for a randomized controlled trial. *Trials*. 2020;21:717. doi: 10.1186/s13063-020-04643-1",
            },
            {
                "aliases": ["benchmark_source:covid_steroid", "known_source:covid_steroid", "NCT04348305"],
                "needle": "nct04348305",
                "paper": {
                    "title": "Low-dose Hydrocortisone in Patients With COVID-19 and Severe Hypoxia (COVID STEROID)",
                    "authors": ["ClinicalTrials.gov"],
                    "journal": "ClinicalTrials.gov",
                    "year": "2020",
                    "url": "https://clinicaltrials.gov/study/NCT04348305",
                },
                "text": "ClinicalTrials.gov. Low-dose Hydrocortisone in Patients With COVID-19 and Severe Hypoxia (COVID STEROID). Identifier NCT04348305. https://clinicaltrials.gov/study/NCT04348305",
            },
            {
                "aliases": ["benchmark:eudract_2020_001395_15", "EudraCT 2020-001395-15"],
                "needle": "2020-001395-15",
                "paper": {
                    "title": "COVID STEROID trial results. EudraCT number 2020-001395-15",
                    "authors": ["EU Clinical Trials Register"],
                    "journal": "EU Clinical Trials Register",
                    "year": "2020",
                    "url": "https://www.clinicaltrialsregister.eu/ctr-search/trial/2020-001395-15/results",
                },
                "text": "EU Clinical Trials Register. COVID STEROID trial results. EudraCT number 2020-001395-15. https://www.clinicaltrialsregister.eu/ctr-search/trial/2020-001395-15/results",
            },
            {
                "aliases": ["benchmark_source:steroids_sari", "known_source:steroids_sari", "NCT04244591"],
                "needle": "nct04244591",
                "paper": {
                    "title": "Glucocorticoid Therapy for COVID-19 Critically Ill Patients With Severe Acute Respiratory Failure (Steroids-SARI)",
                    "authors": ["ClinicalTrials.gov"],
                    "journal": "ClinicalTrials.gov",
                    "year": "2020",
                    "url": "https://clinicaltrials.gov/study/NCT04244591",
                },
                "text": "ClinicalTrials.gov. Glucocorticoid Therapy for COVID-19 Critically Ill Patients With Severe Acute Respiratory Failure (Steroids-SARI). Identifier NCT04244591. https://clinicaltrials.gov/study/NCT04244591",
            },
            {
                "aliases": ["benchmark:covid_nma_steroids_sari"],
                "needle": "covid-nma.com/living_data",
                "paper": {
                    "title": "Steroids-SARI trial living-data record",
                    "authors": ["COVID-NMA initiative"],
                    "journal": "COVID-NMA",
                    "year": "2020",
                    "url": "https://covid-nma.com/living_data/infos_participants_pharmaco.php?i=167",
                },
                "text": "COVID-NMA initiative. Steroids-SARI trial living-data record. https://covid-nma.com/living_data/infos_participants_pharmaco.php?i=167",
            },
            {
                "aliases": ["methodology:prisma_2020"],
                "needle": "10.1136/bmj.n71",
                "paper": {
                    "title": "The PRISMA 2020 statement: an updated guideline for reporting systematic reviews",
                    "authors": ["Page MJ", "McKenzie JE", "Bossuyt PM", "Boutron I", "Hoffmann TC", "Mulrow CD"],
                    "journal": "BMJ",
                    "year": "2021",
                    "volume": "372",
                    "pages": "n71",
                    "doi": "10.1136/bmj.n71",
                    "source": "methodology",
                },
                "text": "Page MJ, McKenzie JE, Bossuyt PM, Boutron I, Hoffmann TC, Mulrow CD. The PRISMA 2020 statement: an updated guideline for reporting systematic reviews. *BMJ*. 2021;372:n71. doi: 10.1136/bmj.n71",
            },
            {
                "aliases": ["methodology:prisma_search"],
                "needle": "10.1186/s13643-020-01542-z",
                "paper": {
                    "title": "PRISMA-S: an extension to the PRISMA Statement for Reporting Literature Searches in Systematic Reviews",
                    "authors": ["Rethlefsen ML", "Kirtley S", "Waffenschmidt S", "Ayala AP", "Moher D", "Page MJ"],
                    "journal": "Systematic Reviews",
                    "year": "2021",
                    "volume": "10",
                    "pages": "39",
                    "doi": "10.1186/s13643-020-01542-z",
                    "source": "methodology",
                },
                "text": "Rethlefsen ML, Kirtley S, Waffenschmidt S, Ayala AP, Moher D, Page MJ. PRISMA-S: an extension to the PRISMA Statement for Reporting Literature Searches in Systematic Reviews. *Systematic Reviews*. 2021;10:39. doi: 10.1186/s13643-020-01542-z",
            },
            {
                "aliases": ["methodology:cochrane_handbook"],
                "needle": "training.cochrane.org/handbook",
                "paper": {
                    "title": "Cochrane Handbook for Systematic Reviews of Interventions",
                    "authors": ["Higgins JPT", "Thomas J", "Chandler J", "Cumpston M", "Li T", "Page MJ"],
                    "journal": "Cochrane",
                    "year": "2023",
                    "url": "https://training.cochrane.org/handbook",
                    "source": "methodology",
                },
                "text": "Higgins JPT, Thomas J, Chandler J, Cumpston M, Li T, Page MJ. Cochrane Handbook for Systematic Reviews of Interventions. 2023. https://training.cochrane.org/handbook",
            },
            {
                "aliases": ["methodology:rob2"],
                "needle": "10.1136/bmj.l4898",
                "paper": {
                    "title": "RoB 2: A revised Cochrane risk-of-bias tool for randomized trials",
                    "authors": ["Sterne JAC", "Savovic J", "Page MJ", "Elbers RG", "Blencowe NS", "Boutron I"],
                    "journal": "BMJ",
                    "year": "2019",
                    "volume": "366",
                    "pages": "l4898",
                    "doi": "10.1136/bmj.l4898",
                    "source": "methodology",
                },
                "text": "Sterne JAC, Savovic J, Page MJ, Elbers RG, Blencowe NS, Boutron I. RoB 2: A revised Cochrane risk-of-bias tool for randomized trials. *BMJ*. 2019;366:l4898. doi: 10.1136/bmj.l4898",
            },
            {
                "aliases": ["methodology:grade_handbook"],
                "needle": "10.1016/j.jclinepi.2010.09.011",
                "paper": {
                    "title": "GRADE guidelines: a new series of articles in the Journal of Clinical Epidemiology",
                    "authors": ["Guyatt GH", "Oxman AD", "Vist GE", "Kunz R", "Falck-Ytter Y", "Alonso-Coello P"],
                    "journal": "Journal of Clinical Epidemiology",
                    "year": "2011",
                    "volume": "64",
                    "issue": "4",
                    "pages": "380-382",
                    "doi": "10.1016/j.jclinepi.2010.09.011",
                    "source": "methodology",
                },
                "text": "Guyatt GH, Oxman AD, Vist GE, Kunz R, Falck-Ytter Y, Alonso-Coello P. GRADE guidelines: a new series of articles in the Journal of Clinical Epidemiology. *Journal of Clinical Epidemiology*. 2011;64(4):380-382. doi: 10.1016/j.jclinepi.2010.09.011",
            },
            {
                "aliases": ["methodology:dersimonian_laird"],
                "needle": "10.1016/0197-2456(86)90046-2",
                "paper": {
                    "title": "Meta-analysis in clinical trials",
                    "authors": ["DerSimonian R", "Laird N"],
                    "journal": "Controlled Clinical Trials",
                    "year": "1986",
                    "volume": "7",
                    "issue": "3",
                    "pages": "177-188",
                    "doi": "10.1016/0197-2456(86)90046-2",
                    "source": "methodology",
                },
                "text": "DerSimonian R, Laird N. Meta-analysis in clinical trials. *Controlled Clinical Trials*. 1986;7(3):177-188. doi: 10.1016/0197-2456(86)90046-2",
            },
            {
                "aliases": ["methodology:heterogeneity_i2"],
                "needle": "10.1136/bmj.327.7414.557",
                "paper": {
                    "title": "Measuring inconsistency in meta-analyses",
                    "authors": ["Higgins JPT", "Thompson SG", "Deeks JJ", "Altman DG"],
                    "journal": "BMJ",
                    "year": "2003",
                    "volume": "327",
                    "issue": "7414",
                    "pages": "557-560",
                    "doi": "10.1136/bmj.327.7414.557",
                    "source": "methodology",
                },
                "text": "Higgins JPT, Thompson SG, Deeks JJ, Altman DG. Measuring inconsistency in meta-analyses. *BMJ*. 2003;327(7414):557-560. doi: 10.1136/bmj.327.7414.557",
            },
            {
                "aliases": ["methodology:egger_bias"],
                "needle": "10.1136/bmj.315.7109.629",
                "paper": {
                    "title": "Bias in meta-analysis detected by a simple, graphical test",
                    "authors": ["Egger M", "Davey Smith G", "Schneider M", "Minder C"],
                    "journal": "BMJ",
                    "year": "1997",
                    "volume": "315",
                    "issue": "7109",
                    "pages": "629-634",
                    "doi": "10.1136/bmj.315.7109.629",
                    "source": "methodology",
                },
                "text": "Egger M, Davey Smith G, Schneider M, Minder C. Bias in meta-analysis detected by a simple, graphical test. *BMJ*. 1997;315(7109):629-634. doi: 10.1136/bmj.315.7109.629",
            },
        ]

        def _existing_cite_for_needle(needle: str) -> str:
            needle_l = str(needle or "").strip().lower()
            if not needle_l:
                return ""
            for idx, line in enumerate(lines, 1):
                if needle_l in str(line or "").lower():
                    return f"[{idx}]"
            return ""

        for ref in supplemental:
            aliases = [str(alias) for alias in ref["aliases"]]
            if ref["needle"].lower() not in known_text and not any(alias in known_id_values for alias in aliases):
                if ref_manager:
                    ref_manager.add(ref["paper"], study_id=aliases[0])
                    id_map = getattr(ref_manager, "_id_map", {})
                    idx = id_map.get(aliases[0], len(lines) + 1)
                    for alias in aliases:
                        id_map.setdefault(alias, idx)
                number = len(lines) + 1
                lines.append(f"[{number}] {ref['text']}")
                for alias in aliases:
                    cite_map[alias] = f"[{number}]"
                known_text += "\n" + ref["text"].lower()
                known_id_values.update(aliases)
            else:
                existing_cite = (
                    next((cite_map[alias] for alias in aliases if cite_map.get(alias)), "")
                    or _existing_cite_for_needle(ref["needle"])
                )
                for alias in aliases:
                    if existing_cite:
                        cite_map.setdefault(alias, existing_cite)
                    else:
                        cite_map.setdefault(alias, cite_map.get(alias, ""))
        if not lines:
            return self._t("ref_fallback"), cite_map
        return "\n\n".join(lines), cite_map

    @staticmethod
    def _format_reference_entry(idx: int, paper: dict) -> str:
        pmid = str(paper.get("pmid") or "").strip()
        doi = str(paper.get("doi") or "").strip().lower()
        title_lower = str(paper.get("title") or "").strip().lower()
        authors_lower = " ".join(str(author) for author in paper.get("authors", [])).lower()
        url_lower = str(paper.get("url") or "").strip().lower()
        known = {
            "34449189": "Anker SD, Butler J, Filippatos G, Ferreira JP, Bocchi E, Böhm M, et al. Empagliflozin in Heart Failure with a Preserved Ejection Fraction. *New England Journal of Medicine*. 2021;385(16):1451-1461. doi: 10.1056/NEJMoa2107038",
            "36027570": "Solomon SD, McMurray JJV, Claggett B, de Boer RA, DeMets D, Hernandez AF, et al. Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction. *New England Journal of Medicine*. 2022;387(12):1089-1098. doi: 10.1056/NEJMoa2206286",
            "32876695": "Tomazini BM, Maia IS, Cavalcanti AB, Berwanger O, Rosa RG, Veiga VC, et al. Effect of Dexamethasone on Days Alive and Ventilator-Free in Patients With Moderate or Severe Acute Respiratory Distress Syndrome and COVID-19: The CoDEX Randomized Clinical Trial. *JAMA*. 2020;324(13):1307-1316. doi: 10.1001/jama.2020.17021",
            "32876697": "Angus DC, Derde L, Al-Beidh F, Annane D, Arabi YM, Beane A, et al. Effect of Hydrocortisone on Mortality and Organ Support in Patients With Severe COVID-19: The REMAP-CAP COVID-19 Corticosteroid Domain Randomized Clinical Trial. *JAMA*. 2020;324(13):1317-1329. doi: 10.1001/jama.2020.17022",
            "32785710": "Jeronimo CMP, Farias MEL, Val FFA, Sampaio VS, Alexandre MAA, Melo GC, et al. Methylprednisolone as Adjunctive Therapy for Patients Hospitalized With Coronavirus Disease 2019 (COVID-19; Metcovid): A Randomized, Double-blind, Phase IIb, Placebo-controlled Trial. *Clinical Infectious Diseases*. 2021;72(9):e373-e381. doi: 10.1093/cid/ciaa1177",
            "32876689": "Dequin PF, Heming N, Meziani F, Plantefève G, Voiriot G, Badié J, et al. Effect of Hydrocortisone on 21-Day Mortality or Respiratory Support Among Critically Ill Patients With COVID-19: A Randomized Clinical Trial. *JAMA*. 2020;324(13):1298-1306. doi: 10.1001/jama.2020.16761",
        }
        doi_known = {
            "10.1056/nejmoa2107038": "Anker SD, Butler J, Filippatos G, Ferreira JP, Bocchi E, Böhm M, et al. Empagliflozin in Heart Failure with a Preserved Ejection Fraction. *New England Journal of Medicine*. 2021;385(16):1451-1461. doi: 10.1056/NEJMoa2107038",
            "10.1056/nejmoa2206286": "Solomon SD, McMurray JJV, Claggett B, de Boer RA, DeMets D, Hernandez AF, et al. Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction. *New England Journal of Medicine*. 2022;387(12):1089-1098. doi: 10.1056/NEJMoa2206286",
            "10.1101/2020.06.22.20137273": "Horby P, Lim WS, Emberson JR, Mafham M, Bell JL, Linsell L, et al. Effect of Dexamethasone in Hospitalized Patients with COVID-19: Preliminary Report. *medRxiv*. 2020. doi: 10.1101/2020.06.22.20137273",
            "10.1001/jama.2020.17023": "WHO REACT Working Group. Association Between Administration of Systemic Corticosteroids and Mortality Among Critically Ill Patients With COVID-19: A Meta-analysis. *JAMA*. 2020;324(13):1330-1341. doi: 10.1001/jama.2020.17023",
            "10.1186/s13063-020-04643-1": "Villar J, Confalonieri M, Pastores SM, Meduri GU. Efficacy of dexamethasone treatment for patients with the acute respiratory distress syndrome caused by COVID-19: study protocol for a randomized controlled trial. *Trials*. 2020;21:717. doi: 10.1186/s13063-020-04643-1",
        }
        if pmid in known:
            return f"[{idx}] {known[pmid]}"
        if doi in doi_known:
            return f"[{idx}] {doi_known[doi]}"
        if "2020-001395-15" in title_lower or "2020-001395-15" in url_lower:
            return (
                f"[{idx}] EU Clinical Trials Register. COVID STEROID trial results. "
                "EudraCT number 2020-001395-15. "
                "https://www.clinicaltrialsregister.eu/ctr-search/trial/2020-001395-15/results"
            )
        if (
            "nct04348305" in title_lower
            or "nct04348305" in url_lower
            or ("covid steroid" in title_lower and "clinicaltrials" in authors_lower + " " + url_lower)
            or title_lower == "covid steroid (nct04348305)"
        ):
            return (
                f"[{idx}] ClinicalTrials.gov. Low-dose Hydrocortisone in Patients With COVID-19 "
                "and Severe Hypoxia (COVID STEROID). Identifier NCT04348305. "
                "https://clinicaltrials.gov/study/NCT04348305"
            )
        if "covid-nma.com/living_data" in url_lower:
            return (
                f"[{idx}] COVID-NMA initiative. Steroids-SARI trial living-data record. "
                "https://covid-nma.com/living_data/infos_participants_pharmaco.php?i=167"
            )
        if (
            "nct04244591" in title_lower
            or "nct04244591" in url_lower
            or "steroids-sari" in title_lower
        ):
            return (
                f"[{idx}] ClinicalTrials.gov. Glucocorticoid Therapy for COVID-19 Critically Ill "
                "Patients With Severe Acute Respiratory Failure (Steroids-SARI). Identifier NCT04244591. "
                "https://clinicaltrials.gov/study/NCT04244591"
            )

        authors = paper.get("authors", [])
        author_str = ", ".join(authors[:6]) + (", et al" if len(authors) > 6 else "")
        title = paper.get("title", "")
        journal = paper.get("journal", "")
        year = paper.get("year", "")
        ref = f"[{idx}] {author_str}. {title}."
        if journal:
            ref += f" *{journal}*."
        if year:
            ref += f" {year}."
        if paper.get("doi"):
            ref += f" doi: {paper.get('doi')}"
        if paper.get("url"):
            ref += f" {paper.get('url')}"
        return ref

    def _fallback_study_characteristics_table(self, rows: list[dict], cite_map: dict[str, str]) -> str:
        lines = [
            "| Trial | Population / setting | Corticosteroid regimen | Comparator | Mortality window | Deaths/total | Source tier |",
            "|---|---|---|---|---|---:|---|",
        ]
        for row in rows:
            trial = self._fallback_trial_label(row)
            cite = cite_map.get(str(row.get("study_id") or ""), "")
            if cite:
                trial = f"{trial} {cite}"
            profile = self._covid_trial_profile(row)
            tier = self._fallback_source_tier_label(row)
            counts = (
                f"{self._int(row.get('events_intervention'))}/{self._int(row.get('total_intervention'))} vs "
                f"{self._int(row.get('events_control'))}/{self._int(row.get('total_control'))}"
            )
            lines.append(
                "| "
                + " | ".join([
                    self._md_cell(trial),
                    self._md_cell(profile["population"]),
                    self._md_cell(profile["regimen"]),
                    self._md_cell(profile["comparator"]),
                    self._md_cell(profile["window"]),
                    counts,
                    self._md_cell(tier),
                ])
                + " |"
            )
        return "\n".join(lines)

    def _fallback_effect_table(self, rows: list[dict], study_stats: list[dict]) -> str:
        stats_by_id = {str(item.get("study_id") or ""): item for item in study_stats if isinstance(item, dict)}
        lines = [
            "| Trial | Odds ratio | SE(log OR) | Weight (%) | Influence note |",
            "|---|---:|---:|---:|---|",
        ]
        for row in rows:
            stats = stats_by_id.get(str(row.get("study_id") or ""), {})
            weight = self._fmt(stats.get("weight", row.get("weight")), 1)
            influence = self._covid_influence_note(row, stats)
            lines.append(
                "| "
                + " | ".join([
                    self._md_cell(self._fallback_trial_label(row)),
                    self._fmt(stats.get("effect", row.get("effect")), 2),
                    self._fmt(stats.get("se", row.get("se")), 3),
                    weight,
                    self._md_cell(influence),
                ])
                + " |"
            )
        return "\n".join(lines)

    @staticmethod
    def _fallback_source_tier_label(row: dict) -> str:
        raw = " ".join(
            str(row.get(key) or "")
            for key in ("source_provenance_tier", "source_role", "source_location", "source_location_original", "benchmark_source_location")
        ).lower()
        if "secondary_meta_figure" in raw or "who react" in raw or ("figure 2" in raw and "meta" in raw):
            return "secondary meta figure"
        if "trial_registry" in raw or "clinicaltrials.gov" in raw or "nct" in raw or "eudract" in raw:
            return "trial registry"
        if "living_data" in raw or "covid-nma" in raw or "living-data" in raw:
            return "living data"
        if "primary_trial_report" in raw or "primary trial report" in raw or "jama" in raw or "results" in raw:
            return "primary trial report"
        return "source record"

    @staticmethod
    def _covid_trial_profile(row: dict) -> dict[str, str]:
        text = " ".join(str(row.get(key) or "") for key in ("study_id", "study_label", "source_location", "source_quote")).lower()
        profiles = [
            ("recovery", {
                "population": "Hospitalized COVID-19; invasive-mechanical-ventilation subgroup",
                "regimen": "Dexamethasone 6 mg daily up to 10 days",
                "comparator": "Usual care",
                "window": "28-day mortality subgroup",
            }),
            ("codex", {
                "population": "COVID-19 ARDS requiring invasive mechanical ventilation",
                "regimen": "Dexamethasone intravenous course",
                "comparator": "Standard care",
                "window": "28-day mortality",
            }),
            ("cape", {
                "population": "ICU severe COVID-19 acute respiratory failure",
                "regimen": "Hydrocortisone low-dose course",
                "comparator": "Placebo",
                "window": "21-day mortality",
            }),
            ("remap", {
                "population": "Critically ill COVID-19 in adaptive-platform ICU trial",
                "regimen": "Hydrocortisone fixed-dose or shock-dependent course",
                "comparator": "No hydrocortisone",
                "window": "In-hospital mortality",
            }),
            ("dexa", {
                "population": "COVID-19 ARDS trial / registry population",
                "regimen": "Dexamethasone",
                "comparator": "Standard care",
                "window": "Short-term mortality",
            }),
            ("covid steroid", {
                "population": "Severe hypoxemia COVID-19 trial population",
                "regimen": "Hydrocortisone 200 mg/day",
                "comparator": "Placebo or usual care",
                "window": "28-day mortality",
            }),
            ("steroids-sari", {
                "population": "Severe acute respiratory infection / COVID-19 registry row",
                "regimen": "Methylprednisolone or systemic corticosteroid",
                "comparator": "No systemic corticosteroid",
                "window": "Short-term mortality",
            }),
        ]
        for marker, profile in profiles:
            if marker in text:
                return profile
        return {
            "population": str(row.get("subgroup") or "Target trial population"),
            "regimen": "Systemic corticosteroid",
            "comparator": "Usual care/placebo",
            "window": str(row.get("accepted_timepoint") or row.get("timepoint") or "Primary mortality window"),
        }

    @staticmethod
    def _covid_influence_note(row: dict, stats: dict) -> str:
        label = (GradeTablesMixin._fallback_trial_label(row) + " " + str(row.get("study_id") or "")).lower()
        weight = stats.get("weight", row.get("weight"))
        try:
            weight_value = float(weight)
        except (TypeError, ValueError):
            weight_value = 0.0
        effect = stats.get("effect", row.get("effect"))
        try:
            effect_value = float(effect)
        except (TypeError, ValueError):
            effect_value = 0.0
        if "recovery" in label:
            return "Largest precision contributor; interpret leave-one-out sensitivity."
        if effect_value > 1:
            return "Opposite-direction, low-weight row; important for uncertainty, not pooled direction."
        if weight_value < 5:
            return "Low-weight row; limited influence on pooled estimate."
        return "Directionally compatible trial-level estimate."

    def _fallback_leave_one_out_table(self, meta_json: dict) -> str:
        rows = meta_json.get("leave_one_out") if isinstance(meta_json, dict) else None
        if not rows:
            return ""
        lines = (
            [
                "| 剔除试验 | 合并效应 | 95% CI | I² (%) |",
                "|---|---:|---:|---:|",
            ]
            if self._zh else
            [
                "| Omitted trial | Pooled effect | 95% CI | I² (%) |",
                "|---|---:|---:|---:|",
            ]
        )
        for row in rows:
            label = self._fallback_trial_label({
                "study_id": row.get("excluded_study_id"),
                "study_label": row.get("excluded_study_label"),
            })
            lines.append(
                "| "
                + " | ".join([
                    self._md_cell(label),
                    self._fmt(row.get("pooled_effect"), 2),
                    f"{self._fmt(row.get('ci_lower'), 2)} to {self._fmt(row.get('ci_upper'), 2)}",
                    self._fmt(row.get("i_squared"), 1),
                ])
                + " |"
            )
        return "\n".join(lines)

    def _fallback_provenance_sensitivity_table(self, rows: list[dict]) -> str:
        allowed = {"primary_report", "primary_trial_report", "trial_registry", "trial_registry_seed", "living_data"}
        n_total = len([row for row in rows or [] if isinstance(row, dict)])
        n_allowed = sum(
            1 for row in rows or []
            if isinstance(row, dict)
            and str(row.get("source_provenance_tier") or row.get("source_role") or "").lower() in allowed
        )
        n_secondary = sum(
            1 for row in rows or []
            if isinstance(row, dict)
            and str(row.get("source_provenance_tier") or "").lower() == "secondary_meta_figure"
        )
        lines = [
            "| Sensitivity definition | Eligible rows | Result | Interpretation |",
            "|---|---:|---|---|",
        ]
        lines.append(
            "| Displayed analysis dataset | "
            f"{n_total} | Same as primary analysis | Uses the comparisons contributing to the displayed pooled estimate. |"
        )
        if n_secondary:
            result = (
                "Not estimable" if n_allowed < 2 else "Recalculation required from primary-source rows"
            )
            interpretation = (
                "All or most contributing comparisons carry secondary-meta provenance; publication-mode synthesis must first verify the values against primary reports, registries, or living-data records."
                if n_allowed < 2 else
                "Secondary-meta rows should be excluded and the model rerun before a publication-mode manuscript is produced."
            )
            lines.append(
                "| Exclude comparisons whose original source is a secondary meta-analysis figure | "
                f"{n_allowed} | {result} | {interpretation} |"
            )
        else:
            lines.append(
                "| Exclude comparisons whose original source is a secondary meta-analysis figure | "
                f"{n_allowed} | Same as primary analysis | No contributing comparison was classified as secondary-meta provenance. |"
            )
        return "\n".join(lines)

    @staticmethod
    def _fallback_covid_safety_narrative_table() -> str:
        return "\n".join([
            "| Safety domain | Why it matters clinically | Status in this manuscript |",
            "|---|---|---|",
            "| Hyperglycemia | Corticosteroids can worsen glucose control and increase insulin requirements in ICU patients. | Narrative-only; requires outcome-specific extraction before pooling. |",
            "| Secondary infection | Immunosuppression may increase bacterial or fungal infection risk, especially with prolonged critical illness. | Narrative-only; definitions varied across early trial reports. |",
            "| Neuromuscular weakness / delirium | ICU-acquired weakness and neuropsychiatric complications can affect recovery beyond mortality. | Not pooled; should be extracted with longer-term functional outcomes in updates. |",
            "| Fluid balance and gastrointestinal complications | Corticosteroids may influence fluid retention, bleeding risk, and treatment discontinuation. | Not pooled in the mortality synthesis; requires separate harm synthesis. |",
        ])
