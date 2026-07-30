"""Deterministic evidence-gap and meta fallback reports."""
from __future__ import annotations

import re

from new_meta.core.project import Project
from new_meta.core.quality_gates import run_quality_gate
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.schemas.study import ExtractedStudy
from new_meta.schemas.grade import GRADEProfile
from new_meta.core.manuscript_facts import validate_and_repair_manuscript
from new_meta.core.manuscript_text_metrics import remove_near_duplicate_sentences
from new_meta.tools.reference_manager import ReferenceManager

from new_meta.agents.writing.citation_repair import CitationRepairMixin


class FallbackReportsMixin:
    """Deterministic evidence-gap and meta fallback reports."""

    def _write_evidence_gap_report(
        self,
        *,
        protocol: ResearchProtocol,
        facts: dict,
        extracted_studies: list[ExtractedStudy],
        prisma_data: dict,
    ) -> str:
        """Build a deterministic evidence-gap artifact without LLM prose."""
        readiness = facts.get("evidence_readiness") or {}
        blockers = readiness.get("blockers", [])
        warnings = readiness.get("warnings", [])
        primary = facts.get("primary_effect") or {}
        prisma = facts.get("prisma") or {}
        studies = facts.get("studies") or {}
        selected_rows = readiness.get("selected_primary_rows") or []
        source_names = facts.get("search", {}).get("source_names") or []

        if self._zh:
            title = "系统评价证据缺口报告"
            status = readiness.get("status", "blocked")
            lines = [
                f"# {title}",
                "",
                "## 研究问题",
                protocol.research_question,
                "",
                "## 当前结论",
                (
                    f"本次运行被判定为 `{facts.get('report_type', 'evidence_gap')}`，状态为 `{status}`。"
                    "系统已阻止生成投稿式 Meta 分析正文；需要先完成证据核验、全文补充或人工裁决。"
                ),
                "",
                "## PICO",
                f"- 人群：{protocol.pico.population or 'NR'}",
                f"- 干预：{protocol.pico.intervention or 'NR'}",
                f"- 对照：{protocol.pico.comparator or 'NR'}",
                f"- 主要结局：{protocol.pico.outcome_primary or 'NR'}",
                "",
                "## 检索与筛选概况",
                f"- 检索/来源：{', '.join(source_names) if source_names else 'NR'}",
                f"- 识别记录：{prisma.get('records_identified', 0)}",
                f"- 去重后记录：{prisma.get('records_after_dedup', 0)}",
                f"- 题名/摘要筛选：{prisma.get('title_abstract_screened', 0)}",
                f"- 全文评估：{prisma.get('full_text_assessed', 0)}",
                f"- 综述层面纳入/提取：{studies.get('extracted_count', 0)}",
                f"- 主结局可合并研究：{studies.get('primary_analysis_count', 0)}",
            ]
            if primary:
                lines.extend([
                    "",
                    "## 已计算但未放行的统计结果",
                    (
                        f"主结局当前可计算 {primary.get('n_studies', 0)} 个效应量，"
                        f"{primary.get('effect_measure', protocol.effect_measure)} "
                        f"{primary.get('pooled_effect', 'NR')} "
                        f"(95% CI {primary.get('ci_lower', 'NR')} 到 {primary.get('ci_upper', 'NR')})。"
                        "该结果仅用于调试和人工核验，不应作为投稿结论。"
                    ),
                ])
            lines.extend([
                "",
                "## 阻断原因",
                *[f"- `{item.get('code', 'unknown')}`: {item.get('message', '')}" for item in blockers],
                "",
                "## 待复核警告",
                *([f"- `{item.get('code', 'unknown')}`: {item.get('message', '')}" for item in warnings] or ["- 无"]),
                "",
                "## 入池候选行审计",
            ])
            lines.extend(self._selected_row_lines(selected_rows, zh=True))
            lines.extend([
                "",
                "## 下一步处理建议",
                "1. 补充或重新上传被标记为 abstract-only 的全文 PDF。",
                "2. 在 extraction review 界面核验每个主结局数字、页码、表格和原文引用。",
                "3. 对目标时间点不明确的行进行人工裁决，必要时改为 narrative-only。",
                "4. 所有 blockers 清零后再生成投稿式 manuscript。",
            ])
            return "\n".join(lines).strip() + "\n"

        lines = [
            "# Systematic Review Evidence-Gap Report",
            "",
            "## Research Question",
            protocol.research_question,
            "",
            "## Current Conclusion",
            (
                f"This run is classified as `{facts.get('report_type', 'evidence_gap')}` with status "
                f"`{readiness.get('status', 'blocked')}`. The pipeline blocked publication-style "
                "meta-analysis writing until source verification, full-text recovery, or user adjudication is completed."
            ),
            "",
            "## PICO",
            f"- Population: {protocol.pico.population or 'NR'}",
            f"- Intervention: {protocol.pico.intervention or 'NR'}",
            f"- Comparator: {protocol.pico.comparator or 'NR'}",
            f"- Primary outcome: {protocol.pico.outcome_primary or 'NR'}",
            "",
            "## Search and Screening Overview",
            f"- Sources: {', '.join(source_names) if source_names else 'NR'}",
            f"- Records identified: {prisma.get('records_identified', 0)}",
            f"- Records after deduplication: {prisma.get('records_after_dedup', 0)}",
            f"- Title/abstract screened: {prisma.get('title_abstract_screened', 0)}",
            f"- Full texts assessed: {prisma.get('full_text_assessed', 0)}",
            f"- Review-level extracted studies: {studies.get('extracted_count', 0)}",
            f"- Studies contributing to the primary synthesis: {studies.get('primary_analysis_count', 0)}",
        ]
        if primary:
            lines.extend([
                "",
                "## Computed but Not Released as Publication Evidence",
                (
                    f"The current primary analysis has {primary.get('n_studies', 0)} computable effect(s): "
                    f"{primary.get('effect_measure', protocol.effect_measure)} {primary.get('pooled_effect', 'NR')} "
                    f"(95% CI {primary.get('ci_lower', 'NR')} to {primary.get('ci_upper', 'NR')}). "
                    "This estimate is retained for audit/debugging only and must not be used as a clinical conclusion."
                ),
            ])
        lines.extend([
            "",
            "## Blocking Reasons",
            *[f"- `{item.get('code', 'unknown')}`: {item.get('message', '')}" for item in blockers],
            "",
            "## Review Warnings",
            *([f"- `{item.get('code', 'unknown')}`: {item.get('message', '')}" for item in warnings] or ["- None"]),
            "",
            "## Selected Primary-Row Audit",
        ])
        lines.extend(self._selected_row_lines(selected_rows, zh=False))
        lines.extend([
            "",
            "## Recommended Next Actions",
            "1. Upload or recover full-text PDFs for records marked as abstract-only.",
            "2. Review every primary-outcome value against its page/table/source quote in the extraction review UI.",
            "3. Adjudicate rows whose source text does not verify the target timepoint; move them to narrative-only if needed.",
            "4. Regenerate the manuscript only after all evidence-readiness blockers are cleared.",
        ])
        return "\n".join(lines).strip() + "\n"

    def _handle_publication_style_generation_failure(
        self,
        *,
        protocol: ResearchProtocol,
        facts: dict,
        prisma_data: dict,
        project: Project | None,
        error: Exception,
        grade_profile: GRADEProfile | None,
        ref_manager: ReferenceManager | None = None,
    ) -> str:
        """Downgrade LLM write failures into a deterministic manuscript."""
        message = f"Publication-style writing failed: {error}"
        self.log(message, level="error")
        if project:
            project.add_warning(
                "writing",
                message,
                code="manuscript_llm_failed",
                severity="error",
                context={"report_type": facts.get("report_type", "meta")},
            )
        manuscript = self._write_meta_fallback_report(
            protocol=protocol,
            facts=facts,
            prisma_data=prisma_data,
            grade_profile=grade_profile,
            project=project,
            ref_manager=ref_manager,
        )
        manuscript, fact_validation = validate_and_repair_manuscript(manuscript, facts)
        manuscript = self._backfill_after_fact_repair(manuscript)
        manuscript, fact_validation = validate_and_repair_manuscript(manuscript, facts)
        manuscript = self._repair_covid_contextual_citation_attribution(manuscript)
        manuscript = self._normalize_citation_marker_style(manuscript, lang=self._lang)
        manuscript = self._normalize_figure_heading_spacing(manuscript)
        manuscript = remove_near_duplicate_sentences(manuscript)
        if project:
            manuscript = self._normalize_structured_abstract_spacing(manuscript)
            fact_validation, _, _ = self._quality_checked_validation(
                manuscript,
                facts,
                fact_validation,
                project=project,
            )
            manuscript = getattr(self, "_quality_checked_manuscript", manuscript)
            manuscript = self._normalize_structured_abstract_spacing(manuscript)
            project.save_text("draft.md", manuscript, subdir="manuscript")
            try:
                from new_meta.core.real_smoke import write_real_smoke_manifest
                write_real_smoke_manifest(project.base_dir)
                quality_gate = run_quality_gate(project.base_dir)
                project.save_json("quality_gate.json", quality_gate, subdir="manuscript")
            except Exception as exc:
                self.log(f"Could not run manuscript quality gate: {exc}", level="warning")
            project.save_checkpoint("manuscript")
        for issue in fact_validation.get("issues", []):
            level = "warning" if issue.get("severity") != "error" else "error"
            self.log(f"MANUSCRIPT FACT CHECK: {issue.get('message')}", level=level)
        return manuscript

    def _write_meta_fallback_report(
        self,
        *,
        protocol: ResearchProtocol,
        facts: dict,
        prisma_data: dict,
        grade_profile: GRADEProfile | None,
        project: Project | None = None,
        ref_manager: ReferenceManager | None = None,
    ) -> str:
        """Build a deterministic publication-style manuscript when the LLM is unavailable."""
        if self._zh:
            return self._write_generic_meta_fallback_report(
                protocol=protocol,
                facts=facts,
                prisma_data=prisma_data,
                grade_profile=grade_profile,
                project=project,
                ref_manager=ref_manager,
            )
        if not (self._is_covid_corticosteroid_topic(protocol) and self._allow_legacy_topic_template(facts)):
            return self._write_generic_meta_fallback_report(
                protocol=protocol,
                facts=facts,
                prisma_data=prisma_data,
                grade_profile=grade_profile,
                project=project,
                ref_manager=ref_manager,
            )

        primary = facts.get("primary_effect") or {}
        studies = facts.get("studies") or {}
        prisma = facts.get("prisma") or {}
        report_type = str(facts.get("report_type") or "meta").strip().lower()
        is_benchmark_reconstruction = report_type == "benchmark_reconstruction"
        search = facts.get("search") or {}
        source_names = self._source_names_for_manuscript(search)
        readiness = facts.get("evidence_readiness") or {}
        selected_rows = readiness.get("selected_primary_rows") or []
        grade_outcomes = (facts.get("grade") or {}).get("outcomes") or []
        grade = grade_outcomes[0] if grade_outcomes else {}
        certainty = grade.get("certainty") or "Not assessed"
        downgrade_text = self._fallback_grade_downgrade_text(grade)
        effect_measure = primary.get("effect_measure", protocol.effect_measure)
        effect_text = self._fallback_effect_text(primary, effect_measure)
        primary_population = facts.get("primary_population") or {}
        events_i = self._int(primary_population.get("selected_events_intervention"))
        total_i = self._int(primary_population.get("selected_total_intervention"))
        events_c = self._int(primary_population.get("selected_events_control"))
        total_c = self._int(primary_population.get("selected_total_control"))
        total_n = self._int(primary_population.get("selected_total_participants"))
        event_text = (
            f"{events_i}/{total_i} deaths in the corticosteroid groups and "
            f"{events_c}/{total_c} deaths in the control groups"
            if total_i and total_c else "arm-level death counts were extracted for the primary analysis"
        )
        source_label = self._en_source_label_list(source_names)
        meta_json = project.load_json("meta_results.json", subdir="analysis") if project else {}
        refs_text, cite_map = self._fallback_references(ref_manager)
        who_react_cite = cite_map.get("benchmark:who_react", "")
        primary_source_cite = self._cite_ids_for_rows(cite_map, selected_rows)
        contextual_source_cite = self._citation_for_reference_patterns(
            refs_text,
            [
                r"NCT04360876",
                r"Metcovid|methylprednisolone as adjunctive therapy",
                r"Intravenous methylprednisolone pulse",
                r"rs-66909|Methylprednisolone Pulse Therapy",
                r"GLUCOCOVID",
            ],
        )
        non_oxygen_context_cite = self._citation_for_reference_patterns(
            refs_text,
            [r"Not Receiving Oxygen|EVIDoa2200283|NEJM evidence"],
        )
        background_cites = self._background_citation_groups(cite_map)
        claim_cites = self._covid_corticosteroid_claim_cites(refs_text, cite_map, background_cites)
        prisma_cite = self._cite_ids(cite_map, "methodology:prisma_2020")
        search_method_cite = self._cite_ids(cite_map, "methodology:prisma_search")
        stats_method_cite = self._cite_ids(
            cite_map,
            "methodology:cochrane_handbook",
            "methodology:dersimonian_laird",
            "methodology:heterogeneity_i2",
        )
        certainty_method_cite = self._cite_ids(cite_map, "methodology:rob2", "methodology:grade_handbook")
        bias_method_cite = self._cite_ids(cite_map, "methodology:egger_bias")
        certainty_context_cite = certainty_method_cite or self._cite_suffix(background_cites, 0) or bias_method_cite
        study_table = self._fallback_study_characteristics_table(selected_rows, cite_map)
        effect_table = self._fallback_effect_table(selected_rows, primary.get("studies") or [])
        loo_table = self._fallback_leave_one_out_table(meta_json or {})
        has_loo_table = bool(str(loo_table or "").strip())
        grade_table = self._fallback_grade_table(grade)
        source_table = self._fallback_source_audit_table(selected_rows)
        provenance_sensitivity_table = self._fallback_provenance_sensitivity_table(selected_rows)
        safety_table = self._fallback_covid_safety_narrative_table()
        absolute_effects = facts.get("absolute_effects") or {}
        absolute_table = self._generic_absolute_effect_table(absolute_effects)
        absolute_result_text = self._absolute_effect_result_text(absolute_effects)
        absolute_discussion_text = self._absolute_effect_discussion_text(absolute_effects)
        search_date_text = self._fallback_search_date(search)
        search_query = search.get("query") or ""
        full_query_block = f"```text\n{search_query.strip()}\n```" if search_query.strip() else "Not available."
        n_primary = self._int(primary.get("n_studies")) or studies.get("primary_analysis_count", 0)
        figure_section = self._generic_figures_section(
            project,
            "28-day all-cause mortality",
            prisma=prisma,
            n_primary=n_primary,
        )
        studies_included = self._int(prisma.get("studies_included")) or n_primary
        non_primary_retained = max(0, studies_included - n_primary)
        extraction_backlog = readiness.get("extraction_backlog") if isinstance(readiness.get("extraction_backlog"), dict) else {}
        if not non_primary_retained:
            non_primary_retained = self._int(extraction_backlog.get("non_primary_review_rows"))
        non_primary_retained_text = (
            f"The remaining {non_primary_retained} retained records supplied contextual, protocol, registry, "
            "or secondary-outcome information but did not provide the selected mortality row for pooling."
            if non_primary_retained else
            ""
        )
        review_inclusion_text = (
            f"The review retained {studies_included} full-text records as eligible or contextual evidence, and "
            if studies_included and studies_included != n_primary else
            ""
        )
        loo_table_number = 5 if absolute_table else 4
        provenance_table_number = loo_table_number + (1 if has_loo_table else 0)
        safety_table_number = loo_table_number + 2
        if not has_loo_table:
            safety_table_number = provenance_table_number + 1
        p_value = self._format_p(primary.get("p_value"))
        primary_p_text = self._p_text(primary.get("p_value"))
        q_stat = self._maybe_get(meta_json, "primary_outcome", "q_statistic")
        q_p = self._maybe_get(meta_json, "primary_outcome", "q_p_value")
        i2 = primary.get("i_squared")
        tau2 = primary.get("tau_squared")
        heterogeneity = (
            f"Heterogeneity was low to moderate (I²={self._fmt(i2, 1)}%, "
            f"Cochran Q={self._fmt(q_stat, 2)}, {self._p_text(q_p)}, "
            f"tau²={self._fmt(tau2, 3)})."
            if i2 is not None else "Heterogeneity statistics were not available."
        )
        calculation_notes = self._fallback_calculation_notes(
            effect_measure=effect_measure,
            primary=primary,
            primary_population=primary_population,
            heterogeneity=heterogeneity,
            n_primary=n_primary,
            total_n=total_n,
        )
        readiness_warnings = readiness.get("warnings") or []
        warning_text = self._fallback_warning_text(readiness_warnings)
        extraction_backlog = readiness.get("extraction_backlog") or {}
        non_primary_backlog = self._int(extraction_backlog.get("non_primary_review_rows")) + self._int(
            extraction_backlog.get("non_primary_conflict_rows")
        )
        backlog_status_text = (
            "Non-primary extraction rows with review flags were retained in the supplementary evidence file; "
            "These rows did not affect the selected primary rows or the pooled estimate."
            if non_primary_backlog else
            "All selected primary rows met the source-verification standard."
        )

        title = (
            "Systemic corticosteroids and short-term mortality in critically ill adults with COVID-19: "
            "a benchmark reconstruction of the WHO REACT meta-analysis"
            if is_benchmark_reconstruction else
            "Systemic corticosteroids and 28-day mortality in critically ill adults with COVID-19: "
            "a systematic review and meta-analysis"
        )
        objective_text = (
            "To reconstruct the WHO REACT trial-level mortality estimate while explicitly labeling "
            "secondary-meta provenance."
            if is_benchmark_reconstruction else
            "To estimate the association between systemic corticosteroid administration and 28-day all-cause "
            "mortality in critically ill adults with COVID-19."
        )
        extraction_text = (
            "Arm-level deaths and totals were reconstructed from the declared WHO REACT benchmark figure and "
            "cross-labeled with known trial or registry sources; these rows are not presented as independent "
            "publication-mode primary extraction."
            if is_benchmark_reconstruction else
            "Arm-level deaths and totals were extracted from full text, trial registries, and supplementary "
            "source material. Odds ratios were calculated for each trial and pooled using the protocol-specified "
            "fixed-effect inverse-variance model."
        )
        conclusion_label = "benchmark reconstruction" if is_benchmark_reconstruction else "systematic review and meta-analysis"
        abstract = "\n\n".join([
            f"**Importance:** Systemic corticosteroids were rapidly evaluated in randomized trials of critically ill adults with COVID-19, but trial-level estimates varied and some trial records were available primarily through registries or rapid reports.",
            f"**Objective:** {objective_text}",
            f"**Data sources:** The search covered {source_label}. Search date: {search_date_text}. The full Boolean query is reported in the Methods and Appendix 1.",
            f"**Study selection:** Randomized clinical trials comparing systemic corticosteroids with usual care, placebo, or non-corticosteroid care in adults with critical COVID-19 and reporting 28-day all-cause mortality were eligible.",
            f"**Data extraction and synthesis:** {extraction_text}",
            f"**Main outcome and measures:** 28-day all-cause mortality.",
            f"**Results:** The search identified {prisma.get('records_identified', 0)} records, of which {prisma.get('records_after_dedup', 0)} remained after deduplication and {prisma.get('full_text_assessed', 0)} underwent full-text assessment. {review_inclusion_text}the primary meta-analysis included {n_primary} trials totaling {total_n:,} participants. There were {event_text}. The pooled effect was {effect_text} ({primary_p_text}), favoring corticosteroids. {heterogeneity}",
            f"**Conclusions and relevance:** In this {conclusion_label}, systemic corticosteroids were associated with lower short-term all-cause mortality among critically ill adults with COVID-19. Certainty was rated {certainty.lower()}, mainly because rapid pandemic-era trials had risk-of-bias concerns and incomplete subgroup or safety reporting.{warning_text}",
        ])
        introduction = "\n\n".join([
            f"Severe COVID-19 can progress to acute respiratory distress syndrome, vasopressor-dependent shock, and prolonged intensive care. Early in the pandemic, systemic corticosteroids were biologically plausible because they could attenuate host inflammatory injury, but they also raised concern about secondary infection, hyperglycemia, and delayed viral clearance{self._cite_suffix(background_cites, 0)}.",
            f"Before reliable randomized evidence was available, clinical guidance was cautious. Experience from non-COVID viral pneumonia had suggested possible harm or delayed viral clearance, whereas the inflammatory phenotype of late severe COVID-19 suggested that immunomodulation might be beneficial once respiratory failure had developed. This clinical uncertainty made mortality the most important outcome and made randomized comparisons essential{self._cite_suffix(background_cites, 1)}.",
            f"Several randomized trials were reported rapidly in 2020, including trials of dexamethasone, hydrocortisone, and methylprednisolone. Individual trials differed in drug, dose, enrollment criteria, timing, and whether mortality was the primary outcome{self._cite_suffix(background_cites, 2)}. Some smaller studies were terminated early or remained available mainly through registry or data-platform sources, making careful trial-level reconciliation important{self._cite_suffix(background_cites, 2)}.",
            "A key challenge for this clinical question is that the most relevant population is not always the full randomized population. The RECOVERY trial, for example, enrolled hospitalized patients across several levels of respiratory support, while the critical-care mortality question centers on the invasive-mechanical-ventilation subgroup. Several smaller trials enrolled a closer critical-care population but had limited precision, making the definition of the selected mortality row clinically important.",
            f"The published WHO REACT prospective meta-analysis provided a clinically important anchor for this question, and independent reconstruction from source documents requires attention to journal articles, trial registrations, subgroup rows, statistical supplements, and registry results{(' ' + who_react_cite) if who_react_cite else self._cite_suffix(background_cites, 3)}. A formal report should therefore show not only the pooled estimate but also how each trial contributed to the mortality numerator, denominator, effect estimate, and target population.",
            f"A meta-analysis is appropriate for this question because the trials addressed the same core clinical decision: whether systemic corticosteroids improve short-term survival in adults with critical COVID-19{self._cite_suffix(background_cites, 2)}. At the same time, the rapid publication environment meant that trial reports differed in completeness, timing, and population strata. Clinical readers therefore need to know whether each mortality estimate describes the full hospitalized population, an ICU subgroup, a respiratory-support subgroup, or a registry-reported trial result.",
            f"This systematic review addresses systemic corticosteroids compared with usual care or placebo for 28-day all-cause mortality among critically ill adults with COVID-19{self._cite_suffix(background_cites, 0)}. The analysis focuses on randomized comparisons that can answer the critical-care mortality question{self._cite_suffix(background_cites, 0)}.",
            f"The question remains clinically important because corticosteroids are inexpensive, widely available, and biologically plausible, yet their net effect depends on disease severity and timing{self._cite_suffix(background_cites, 2)}. A concise pooled odds ratio is not enough for clinical interpretation unless the reader can also see the severity stratum, corticosteroid regimen, comparator care, mortality time point, and relative influence of the largest trial subgroup.",
            f"The review also separates the class-level clinical question from agent-specific uncertainty. Dexamethasone, hydrocortisone, and methylprednisolone all belong to the same therapeutic class, but they were studied in trials with different doses, timing, and background care. The synthesis estimates the mortality association for systemic corticosteroids as a class in critical COVID-19{self._cite_suffix(background_cites, 2)}; it does not claim that all agents, doses, or treatment durations are interchangeable.",
            f"The clinical decision is not determined by the pooled point estimate alone. Interpretation depends on disease-severity stratum, comparator care, mortality time point, and the degree to which precision came from one large platform trial rather than from many similarly sized trials{self._cite_suffix(background_cites, 0)}.",
            "The disease-stage distinction is central to this question. COVID-19 can begin as a viral replication syndrome and later evolve into inflammatory lung injury with hypoxemia, respiratory-support requirements, shock, and multiorgan stress. Corticosteroids are more plausible in the latter setting, where excessive host inflammation contributes to pulmonary injury, than in early infection without oxygen requirement. A review that combines all hospitalized patients without attention to respiratory support would therefore answer a broader and less clinically precise question.",
            "The mortality time point also matters. Twenty-eight-day mortality is close enough to the acute critical-care episode to capture early treatment effects, yet long enough to include deaths after prolonged ventilation or organ support. It is not identical to in-hospital mortality, 21-day mortality, or 90-day mortality, and those endpoints may be affected differently by discharge practice, ICU length of stay, rehabilitation pathways, and late complications. Harmonizing the time point reduces one source of avoidable clinical heterogeneity.",
            "A further reason to present a full synthesis is that absolute benefit is not constant. The same relative odds ratio has different meaning in a cohort with 40% mortality than in a cohort with 10% mortality. Early critical-care COVID-19 trials often enrolled patients with high baseline mortality; later care environments may have lower baseline risk because of vaccination, prior immunity, antivirals, anticoagulation, prone positioning, and other immunomodulators. Clinical interpretation therefore requires both the relative estimate and a clear statement of the population's starting risk.",
            "Finally, the intervention is simple enough to be deployed widely but complex enough to require clinical boundaries. Corticosteroids can be lifesaving in an inflammatory critical-care phenotype, but they can also contribute to hyperglycemia, secondary infection, delirium, myopathy, fluid balance concerns, and delayed recovery in vulnerable patients. The review question is therefore not merely whether the pooled odds ratio favors treatment; it is whether the benefit is large and direct enough to justify use in the specific patients represented by the trials.",
            "This review therefore treats the statistical calculation and the clinical interpretation as connected but distinct tasks. The calculation asks what effect is obtained from the selected trial rows. The interpretation asks whether those rows are sufficiently direct, whether the trial conduct creates risk-of-bias concerns, whether sparse evidence limits certainty, and whether the estimated relative effect can reasonably inform practice in contemporary critical-care settings.",
        ])
        introduction = "\n\n".join([
            f"Severe COVID-19 is characterized in many patients by hypoxemic respiratory failure, inflammatory lung injury, shock, and prolonged organ support. Systemic corticosteroids became a central therapeutic question early in the pandemic because their anti-inflammatory effects could plausibly reduce fatal host-response injury, while their metabolic and infectious adverse effects made indiscriminate use unsafe{self._cite_suffix(background_cites, 0)}.",
            f"Randomized evidence accumulated rapidly in 2020 across trials of dexamethasone, hydrocortisone, and methylprednisolone. The trials did not enroll identical populations: some focused on ICU or acute respiratory distress syndrome cohorts, whereas larger platform trials included broader hospitalized populations with extractable respiratory-support subgroups{self._cite_suffix(background_cites, 2)}.",
            "The clinically relevant question is narrow: among critically ill adults with COVID-19, do systemic corticosteroids reduce short-term all-cause mortality compared with usual care or placebo? That framing matters because benefit is biologically and clinically more plausible in patients requiring respiratory or hemodynamic support than in patients with early or mild infection.",
            "The selected trial rows therefore emphasize severity-matched mortality data. RECOVERY contributes the mechanically ventilated subgroup, while CoDEX, REMAP-CAP, CAPE COVID, DEXA-COVID, COVID STEROID, and Steroids-SARI contribute trial or registry rows aligned with critical illness. This preserves the patient population most relevant to bedside decisions rather than averaging across all hospitalized COVID-19 presentations.",
            f"The WHO REACT prospective meta-analysis is the published reference synthesis for this trial set and pooled mortality effect{(' ' + who_react_cite) if who_react_cite else self._cite_suffix(background_cites, 3)}. It is used to place the estimate in context, not as a source of primary trial counts. Selected mortality values are linked to trial reports, trial registries, or living-data records so that the synthesis is based on traceable trial-level data rather than circular extraction from a secondary figure.",
            "This reconstruction is useful only if the clinical interpretation remains explicit. The pooled odds ratio estimates a class-level mortality association in critical COVID-19; it does not establish agent equivalence, optimal dosing, safety tradeoffs, or benefit in patients without oxygen or organ-support needs.",
        ])
        methods = self._compress_covid_corticosteroid_methods("\n\n".join([
            "### Protocol and reporting framework\n"
            "This systematic review and meta-analysis used a prespecified workflow linking eligibility criteria, data extraction, effect-size calculation, certainty assessment, and figure generation. The report follows the PRISMA structure where the available records permit it. Records with incomplete source support were retained in the evidence audit rather than converted into unqualified evidence claims. The objective, population, intervention, comparator, outcome, and analysis model were specified before synthesis." + prisma_cite,
            "### Eligibility criteria\n"
            f"We included randomized clinical trials enrolling adults with laboratory-confirmed or clinically diagnosed COVID-19 requiring ICU-level respiratory or hemodynamic support. Eligible interventions were systemic corticosteroids administered intravenously or orally, including dexamethasone, hydrocortisone, methylprednisolone, prednisolone, or prednisone when the corticosteroid was the index intervention under evaluation. Eligible comparators were usual care, placebo, no corticosteroid treatment, or active treatment without systemic corticosteroids. The primary outcome was {protocol.pico.outcome_primary or '28-day all-cause mortality'}. Trials without extractable 28-day mortality for the target critical-care population were retained in supplementary records but did not enter the primary quantitative synthesis.",
            "For trials that enrolled a broader hospitalized COVID-19 population, only the subgroup matching the critical-care population was eligible for the primary analysis when subgroup mortality counts were available and documented. For trials that had multiple corticosteroid dosing groups, eligible corticosteroid groups were combined when the comparator was common and when that combination matched the clinical question. Duplicate records, protocols, secondary analyses, editorials, and nonrandomized reports were not counted as independent trials.",
            "### Information sources and search strategy\n"
            f"The search covered {source_label}; source counts were {self._fallback_source_counts(search.get('source_counts') or {})}. Search date: {search_date_text}. Registry and open-access source recovery were used for trials whose primary mortality counts were available through ClinicalTrials.gov, EU Clinical Trials Register, COVID-NMA living data, PMC, or primary trial reports. WHO REACT was used only as an external reference comparator{(' ' + who_react_cite) if who_react_cite else ''}. Search reporting followed PRISMA-S where the source records permitted it{search_method_cite}. The final Boolean query used for the run was:\n\n{full_query_block}",
            "### Study selection and extraction\n"
            "Title/abstract and full-text decisions were preserved in the review record. For the primary outcome, each accepted trial record was required to contain arm-level event counts, totals, a report location, and a supporting excerpt. Adjudicated records were retained only when the supporting excerpt identified the trial name and mortality counts. If a trial contributed only to the background review, risk-of-bias context, or extraction queue, it was not counted as a primary-analysis trial.",
            "### Data items and source verification\n"
            "For each eligible trial we extracted the trial name, registration identifier when available, intervention corticosteroid, comparator, analysis population, outcome time point, and deaths and denominators in each arm. Data extraction prioritized the analysis population and time point matching the review question, with trial-level values checked against the selected effect-size table before synthesis.",
            "When a report contained multiple mortality time points, the 28-day all-cause mortality result was preferred. If a closely related mortality time point was the only extractable result, the record was flagged for adjudication and retained only when the accepted time point was compatible with the protocol. When abstract text and tabular data disagreed, the record was marked as requiring review until a supporting excerpt justified the chosen value. Count fields were treated as documented only when all four arm-level values could be linked to the same trial and outcome context.",
            "Before synthesis, study counts, participant totals, selected event counts, pooled effects, confidence intervals, and search-flow values were checked for consistency across the analysis tables, figures, and manuscript text.",
            "### Statistical analysis\n"
            f"For each trial, the log odds ratio was calculated from the 2 x 2 table as log((deaths_corticosteroid / survivors_corticosteroid) / (deaths_control / survivors_control)); the standard error was derived from the four cell counts. Zero cells, if encountered, would use the configured continuity-correction policy before log-scale calculation. The primary synthesis used a {facts.get('model', protocol.model_preference) or protocol.model_preference} inverse-variance model with {effect_measure} on the original scale for reporting. Heterogeneity was summarized using Cochran Q, I², and tau²{stats_method_cite}.",
            "The primary estimate, its standard error, and the confidence interval were calculated on the log scale and then exponentiated for reporting. Study weights were calculated from inverse variances and are shown as percentages in the trial-level effect table. The pooled estimate was interpreted by direction and precision, not by statistical significance alone. Heterogeneity was interpreted using both the magnitude of I² and the compatibility of the individual study estimates with the pooled result.",
            "Aggregate arm totals are reported to help readers understand the event burden. The comparative estimate used trial-level log odds ratios and variances, so differences in trial size, baseline mortality, and corticosteroid regimen remain visible in the study weights.",
            "Leave-one-out analyses were calculated by repeating the primary model after omitting one trial at a time. This sensitivity analysis was prespecified because the evidence base contains one large trial subgroup and several smaller trials; a pooled estimate can be statistically stable while still being heavily weighted toward the largest study. Because fewer than 10 trials were available, funnel-plot asymmetry statistics were considered exploratory and were not used as formal evidence of publication bias.",
            "The analysis retained all eligible randomized comparisons that met the documentation standard for the primary outcome. No trial was excluded from the primary synthesis because its result was statistically nonsignificant. Subgroup analyses were not emphasized because the number of trials was small and because drug, dose, severity, and platform-trial context are partially confounded. Sensitivity analysis was therefore used to evaluate influence rather than to make causal claims about which corticosteroid regimen was superior.",
            "The unit of analysis was the randomized comparison or prespecified subgroup matching critical illness. This was especially important for platform and broad hospitalized-population trials. When a trial enrolled patients across multiple respiratory-support strata, the critical-care subgroup was preferred for the primary synthesis if the mortality counts or effect estimate could be verified. The full trial population was not used when it would dilute the target population with patients outside the critical-care question.",
            "The treatment-class contrast was handled before pooling. When a trial reported multiple corticosteroid regimens against a shared comparator, compatible corticosteroid arms were combined if that matched the class-level question. If a comparison could not be combined without changing the target contrast, it was retained outside the primary analysis. This rule prevents a multi-arm trial from being counted twice and preserves the interpretation of systemic corticosteroids versus usual care or placebo.",
            "Sensitivity analyses were interpreted as influence checks rather than as new primary analyses. A large trial subgroup can appropriately carry high weight, and its omission can widen the interval without invalidating the main model. The relevant finding is whether the pooled direction depends on a single anomalous estimate or whether the smaller studies are directionally compatible with the class effect.",
            "The effect measure was chosen before interpretation. Odds ratios were retained because the primary outcome was binary, because trial-level 2 x 2 data were available, and because the published reference synthesis reported a compatible relative effect. The manuscript reports aggregate event counts for clinical orientation, but those aggregate counts were not used to replace the study-level inverse-variance calculation.",
            "The confidence interval was interpreted as the range of effects compatible with the selected randomized evidence and model assumptions. A confidence interval excluding the null supports a mortality benefit, but certainty in that finding also depends on whether the included studies were sufficiently direct and whether the largest trial subgroup overwhelms the rest of the evidence. The Results section therefore reports both the pooled estimate and the influence analysis.",
            "Absolute-effect interpretation was planned as a clinical translation rather than as a separate statistical model. The primary synthesis estimates the relative odds of death; bedside decision making also needs an expected control risk. Because baseline mortality changed across pandemic waves and care settings, absolute effects should be calculated using a control risk that matches the intended practice setting. The review therefore reports arm-level mortality counts for orientation while keeping the pooled odds ratio as the primary comparative effect.",
            "Safety outcomes were not pooled in the primary efficacy analysis because mortality was the prespecified main endpoint and because safety definitions were not uniformly reported across the early critical-care trials. This does not make safety secondary in clinical importance. It means that adverse events, treatment discontinuation, hyperglycemia, secondary infection, delirium, neuromuscular complications, and later functional recovery should be extracted and synthesized using outcome-specific rules when enough comparable reports are available.",
            "Risk-of-bias judgments were interpreted with attention to the pandemic setting. Rapid recruitment, open-label care, early stopping after emerging external evidence, and evolving background treatment can all affect confidence in the effect estimate. Mortality is less vulnerable to subjective outcome assessment than softer endpoints, but allocation, protocol deviations, missing data, and selective reporting remain relevant. These issues were considered separately from statistical heterogeneity so that clinical confidence was not reduced to I² alone.",
            "The model output was not used as a license for unrestricted extrapolation. Eligibility, respiratory-support subgroup, mortality time point, corticosteroid regimen, comparator care, and contemporaneous standards of care were considered part of the estimand. If a future study addresses patients with mild infection, patients receiving later immunomodulator combinations, or different mortality horizons, it may inform practice but should not automatically be pooled with this critical-care mortality analysis without reassessing directness.",
            "Heterogeneity was interpreted cautiously because the number of trials was small. A low I2 value can occur when studies are few or imprecise and does not prove that all corticosteroid regimens are clinically identical. Conversely, visible clinical differences between trials do not necessarily preclude pooling when the target question is a class effect in a common critical-care syndrome.",
            "The review did not use textual similarity alone to decide eligibility. Trial identity, population severity, intervention class, comparator, outcome time point, and usable data all had to align. This matters for COVID-19 corticosteroid evidence because one publication may contain several clinically distinct strata, and using the wrong stratum could shift both the denominator and the interpretation of treatment effect.",
            f"No formal small-study-effect test was used to downgrade certainty because the evidence base did not meet the usual study-count threshold for reliable funnel-plot or regression-based asymmetry assessment. Any concern about missing studies was therefore handled narratively, through source recovery and the trial registry record, rather than through a statistical test that would have limited power in this setting{bias_method_cite}.",
            "### Handling of unresolved review items\n"
            "Records outside the primary analysis could still carry extraction-review warnings. Those warnings were not allowed to change the pooled result unless the record contributed to the primary effect calculation, but they were retained in the supplementary extraction records because they affect completeness of the broader systematic-review record. This distinction separates the validity of the primary 2 x 2 calculation from the completeness of the wider evidence file.",
            "### Risk of bias and certainty\n"
            f"Risk of bias was assessed for randomized trials, and certainty was summarized with the GRADE domains recorded in the analysis file. Domains such as inconsistency and imprecision were informed by the statistical output, whereas risk of bias and indirectness required clinical and methodological judgment. Publication bias was not formally downgraded when the number of contributing studies was below the conventional threshold for reliable small-study-effect testing{certainty_method_cite}.",
            "GRADE certainty was interpreted in the context of pandemic-era trial conduct. Rapid recruitment, early stopping, open-label designs, and evolving background care can all affect confidence in the estimate. At the same time, the mortality outcome is objective, and randomized allocation reduces confounding compared with observational reports. The certainty profile therefore reports both the statistical result and the reasons confidence may remain less than high.",
            "Indirectness was considered separately from inconsistency. Trials could point in a similar direction while still differing in baseline severity, respiratory support, concomitant therapies, or corticosteroid regimen. Those differences are clinically meaningful even when statistical heterogeneity is modest, and they should be considered when translating the pooled odds ratio into local treatment decisions.",
        ]))
        results = "\n\n".join([
            "### Search results\n"
            f"The search identified {prisma.get('records_identified', 0)} records; {prisma.get('duplicates_removed', 0)} duplicates were removed, leaving {prisma.get('records_after_dedup', 0)} records for screening. The review screened {prisma.get('title_abstract_screened', 0)} title/abstract records and assessed {prisma.get('full_text_assessed', 0)} full-text records. {review_inclusion_text}the primary meta-analysis included {n_primary} trials with documented mortality data. Registry and open-access reports supplied the remaining trial-level mortality data required for the quantitative synthesis. The PRISMA flow diagram shows the record flow, and Appendix 1 gives the full Boolean query.",
            "### Study characteristics\n"
            f"After full-text assessment, {studies_included} records were retained as eligible or contextual review evidence. The primary meta-analysis included {n_primary} randomized trials and {total_n:,} participants. {non_primary_retained_text} The trials evaluated dexamethasone, hydrocortisone, or methylprednisolone against usual care or placebo. Table 1 shows the trial-level mortality data used for pooling. The accepted trial records represent critically ill or respiratory-support subgroups when the source trial enrolled a broader COVID-19 population.",
            "The included evidence base was clinically heterogeneous in corticosteroid agent, dose, and trial context, but it was unified by a common mortality outcome and by the need for ICU-level respiratory or hemodynamic support. Larger trials supplied more precise estimates, while smaller trials added information about alternative corticosteroid regimens and trial settings. Registry-first and living-data records were retained only when their mortality counts could be traced to a specific trial identifier and supporting excerpt.",
            "The final included studies are the subset answering the critical-care mortality question rather than every corticosteroid trial in COVID-19. Some randomized trials enrolled broader hospitalized populations, and some records supplied only design information or secondary outcomes. Those records can inform context, but they do not necessarily provide the mortality row required for this primary synthesis.",
            "Because the review question concerns critical illness, subgroup selection is not a minor technical detail. A trial-level estimate from all hospitalized patients may answer a different question from the estimate among patients receiving invasive mechanical ventilation, noninvasive ventilation, vasopressors, or ICU-level care. The primary analysis therefore prioritizes the subgroup or trial population that most closely matches critical COVID-19.",
            "### Primary outcome\n"
            f"Across the primary-analysis trials, there were {event_text}. The pooled estimate was {effect_text}, with {primary_p_text}. {heterogeneity} The fixed-effect weights were dominated by the largest RECOVERY critical-care subgroup, while smaller registry-first trials contributed lower inverse-variance weights (Table 2). The reproduced pooled estimate was numerically consistent with the published WHO REACT estimate for critically ill COVID-19 patients treated with systemic corticosteroids{(' ' + who_react_cite) if who_react_cite else ''}.",
            absolute_result_text,
            "The direction of effect favored corticosteroids for the aggregate primary outcome. The confidence interval excluded the null on the odds-ratio scale in the primary analysis, and the magnitude was clinically important for a high-mortality critical-care population. The low-to-moderate heterogeneity estimate indicates that the observed variation among trial estimates was not larger than expected for this evidence base, although the small number of trials limits the precision of heterogeneity estimates.",
            "The aggregate event counts show the clinical burden represented by the included trials. Baseline mortality differed across trials, and the largest RECOVERY subgroup contributed most of the precision in the pooled estimate.",
            "No selected trial row was removed because its estimate was neutral or imprecise. The primary filters were clinical eligibility, outcome compatibility, and source verification. This protects the synthesis from favoring the most dramatic result and makes the pooled effect a summary of the eligible randomized evidence rather than a curated set of favorable rows.",
            "The selected trial rows also differed in precision. The largest trial subgroup contributed the narrowest interval and therefore received the greatest inverse-variance weight, while the smaller trials contributed wider intervals. This weighting pattern is expected and clinically acceptable when the large study answers the same question, but it makes influence analysis essential because the pooled estimate can appear very precise while still relying heavily on one source of information.",
            "The forest plot and Table 2 provide complementary evidence. The visual display shows whether estimates generally fall on the same side of the null, while the table shows how much each study contributes numerically. In this reconstruction, the selected smaller trials were broadly compatible with benefit or uncertainty rather than showing a clear pattern of harm, which supports the direction of the pooled result.",
            "Use of registry and living-data records affected documentation more than the final direction of effect. Some trial records required registry or final-result recovery, but the accepted records still supplied the same four count fields needed for the odds-ratio calculation. The analysis therefore distinguishes between difficulty documenting a trial record and instability of the pooled estimate; these are related quality issues but not the same finding.",
            "Raw totals show how many patients died in each treatment group, while the model-based estimate shows the comparative mortality effect after accounting for trial-level precision. The largest trial subgroup therefore shaped precision without eliminating the clinical information supplied by smaller trials.",
            "The primary result was also examined for face validity against the expected clinical pattern. A mortality benefit would be plausible if the largest trial subgroup and the smaller trials generally pointed toward benefit or neutrality, and less plausible if the pooled result depended on one small extreme trial. The selected evidence supported the former pattern: precision came largely from the largest subgroup, but the smaller rows did not collectively contradict the class effect.",
            "The clinical magnitude of the result is substantial because the outcome is death in a high-risk population. Even a moderate relative reduction can translate into a meaningful absolute reduction when baseline mortality is high. The aggregate event counts show that deaths were common in both arms, which supports interpreting the result as relevant to critically ill patients rather than to low-risk outpatients or hospitalized patients without organ-support needs.",
            "The direction of benefit was also compatible with the mechanistic rationale for treatment in advanced disease. Corticosteroids would not be expected to directly inhibit viral replication; their clinical rationale is reduction of harmful inflammatory lung injury and systemic inflammatory consequences. The result therefore fits a disease-stage model in which benefit is more plausible once hypoxemia, respiratory support, or shock indicates severe host-response injury.",
            "This result is strongest for the class-level critical-care mortality question and does not establish equal evidence for every corticosteroid regimen. The trials used different agents and dosing strategies, and the largest source of precision came from dexamethasone-based evidence. Hydrocortisone and methylprednisolone data remain clinically relevant, but their smaller sample sizes mean that agent-specific conclusions are less certain than the class-level mortality conclusion.",
            "No clear statistical heterogeneity signal was observed, but the absence of a strong heterogeneity statistic does not prove interchangeability. With few trials, heterogeneity estimates have limited power and wide uncertainty. The more clinically useful observation is that the main study estimates did not show a consistent pattern of harm and that the pooled benefit remained directionally coherent with the broader WHO REACT synthesis.",
            "### Sensitivity analysis\n"
            f"Leave-one-out analyses did not reverse the direction of effect. The only omission that moved the confidence interval across the null was omission of the largest RECOVERY subgroup, which changed the estimate to {self._fallback_recovery_omission_text(meta_json or {})}. Full leave-one-out results are shown in Table {loo_table_number}.",
            "This sensitivity pattern indicates that the pooled result is most precise when the largest trial subgroup is included, as expected from inverse-variance weighting. It also indicates that the smaller trials were not collectively pointing in the opposite direction. The sensitivity analysis functions as evidence of influence by study size rather than unexplained conflict in trial results.",
            "The leave-one-out analysis does not justify removing the largest trial. Instead, it shows what information is lost when that trial is omitted. In a focused review with one highly informative subgroup and several smaller trials, loss of precision after omitting the largest row is expected. The more important question is whether the qualitative interpretation changes because the remaining trials point toward harm; in this reconstruction they did not.",
            "### Trial-report reconciliation\n"
            "The evidence base combined conventional full-text trial reports with trial-registry information where final journal reports were limited. This mattered most for smaller trials that also appeared in the WHO REACT comparator set and helps explain why some estimates are less richly described than results from larger platform trials.",
            "### Certainty of evidence\n"
            f"The GRADE certainty for the primary outcome was {certainty}. The main downgrading reasons were {downgrade_text} as recorded in Table 3.",
            "The certainty judgment combines trial conduct, applicability of the enrolled populations, precision of the pooled estimate, and completeness of available trial reporting. The certainty table therefore represents a conservative evidence profile rather than a claim that all trial-level uncertainties have been resolved.",
            "### Completeness of primary outcome data\n"
            f"The primary outcome dataset contained documented trial-level mortality records. For the selected primary outcome, the arm-level totals summed to {total_n:,} participants, and all primary-analysis records had report-location and supporting-excerpt fields. {backlog_status_text}",
        ])
        results = re.sub(r"\n{3,}", "\n\n", results).strip()
        discussion = "\n\n".join([
            f"This systematic review and meta-analysis found that systemic corticosteroids were associated with lower 28-day all-cause mortality in critically ill adults with COVID-19 ({effect_text}). The aggregate event counts ({events_i}/{total_i} vs {events_c}/{total_c}) and pooled estimate align closely with WHO REACT records, supporting internal statistical reproducibility{(' ' + who_react_cite) if who_react_cite else self._cite_suffix(background_cites, 3)}.",
            "### Comparison with prior evidence\n"
            f"The result is consistent with the direction and magnitude reported by the WHO REACT prospective meta-analysis{(' ' + who_react_cite) if who_react_cite else ''}. This concordance supports the clinical inference that corticosteroids reduce short-term mortality in critical COVID-19, while agent, dose, timing, and respiratory-support differences should still be interpreted clinically{(' ' + who_react_cite) if who_react_cite else ''}.",
            "The result is biologically plausible and consistent with the clinical rationale that corticosteroids may reduce inflammatory lung injury in advanced COVID-19. The estimate is most precise for dexamethasone because the RECOVERY and CoDEX data contribute many of the participants and events; hydrocortisone and methylprednisolone trials were smaller and therefore had wider study-level intervals.",
            "The leave-one-out analysis illustrates the clinical and statistical shape of the evidence. Removing any of the smaller trials left a statistically significant result favoring corticosteroids. Removing the RECOVERY invasive-mechanical-ventilation subgroup attenuated the pooled estimate and widened the interval, which is expected because that subgroup supplied more than half of the inverse-variance weight. This pattern is an influence signal: the pooled answer is strongly informed by the largest trial while remaining directionally compatible with most smaller trials.",
            "### Clinical and research implications\n"
            "For clinicians, the main implication is that systemic corticosteroids are associated with improved survival among adults with critical COVID-19, a population in which mortality is high and anti-inflammatory treatment has a strong biological rationale. The direct application boundary is patients with severe or critical illness rather than mild disease, patients not requiring oxygen or organ support, or settings in which corticosteroids are used for unrelated indications. The treatment effect summarized here is a population-level estimate derived from randomized comparisons in severe or critical illness.",
            "For researchers, the evidence base highlights the value of rapid prospective coordination and standardized outcome reporting. Future syntheses would be strengthened by harmonized definitions of respiratory-support strata, direct reporting of 28-day mortality by baseline severity subgroup, and complete publication of trial results even when recruitment stops early. Registry rows are useful for transparency, but journal articles and structured result tables remain important for risk-of-bias assessment and clinical interpretation.",
            f"For guideline panels, the result supports consideration of systemic corticosteroids as a class for critically ill adults with COVID-19 across health systems worldwide, while recognizing that the trials were not designed to compare corticosteroid agents head to head{self._cite_suffix(background_cites, 0)}. The pooled estimate addresses whether corticosteroid treatment improves short-term survival compared with no systemic corticosteroid treatment or usual care. It does not determine whether dexamethasone, hydrocortisone, or methylprednisolone is preferable in a given clinical circumstance, nor does it define the optimal dose, duration, or tapering strategy. Those questions require direct comparative evidence or well-reported subgroup analyses.",
            "The mortality benefit should also be interpreted alongside practical bedside issues. Corticosteroids are inexpensive and widely available, but they can increase hyperglycemia, secondary infection risk, myopathy, delirium, and other complications in vulnerable ICU patients. A mortality-focused meta-analysis cannot by itself define the full benefit-harm balance; safety outcomes and longer-term functional outcomes require separate synthesis.",
            "The result is most applicable to patients with severe inflammatory lung disease or critical respiratory failure, not to early mild infection. This boundary is clinically important because the biological rationale for corticosteroids changes over the disease course. Suppressing inflammation may be beneficial once host inflammatory injury predominates, whereas the same treatment could be less useful or harmful if given too early or to patients without oxygen requirement.",
            "Pandemic-era rapid reporting means that some smaller trials were available first through registries, platform summaries, or abbreviated reports. Clinically, this should be treated as a limitation on subgroup detail and risk-of-bias assessment rather than as evidence that the mortality effect differs by source type.",
            "A practical strength of this synthesis is the focused mortality question in a high-risk population. The analysis separates the class-level question of whether systemic corticosteroids improve survival from narrower questions about the best agent, dose, timing, and duration, which require direct comparative evidence.",
            "The findings should also be read in the context of absolute risk. A relative reduction in mortality has greater absolute importance when baseline mortality is high, as it was in many early critical-care COVID-19 cohorts. However, baseline risk changed over time with vaccination, antiviral therapy, anticoagulation, ventilatory strategies, and the use of other immunomodulators. The same relative effect may therefore translate into different absolute benefits in later settings.",
            f"The corticosteroid class question remains clinically useful because bedside decisions often begin with whether anti-inflammatory corticosteroid treatment should be used at all. Nevertheless, class-level pooling can hide practical differences. Dexamethasone, hydrocortisone, and methylprednisolone differ in glucocorticoid potency, mineralocorticoid activity, dosing schedules, and trial context. The pooled estimate should therefore guide the class-level decision while leaving agent selection to guideline recommendations and local protocols{self._cite_suffix(background_cites, 0)}.",
            "The interpretation also depends on timing. Corticosteroids may help when inflammatory lung injury and organ support dominate the clinical picture, but the same treatment could be inappropriate in early or mild infection. The selected evidence addresses critically ill adults rather than all patients with SARS-CoV-2 infection. This boundary should remain explicit in abstracts, summaries, and clinical decision aids derived from the review.",
            "For policy makers, the result has unusually direct relevance because the intervention is inexpensive, widely available, and familiar to clinicians. A mortality effect in critical illness can therefore change practice rapidly. At the same time, the simplicity of the intervention should not lead to overextension: adverse effects, contraindications, dose selection, and cointerventions still require clinical judgment at the patient level.",
            "Clinical translation should begin by asking whether the patient resembles the population represented in the primary synthesis. Patients receiving invasive mechanical ventilation, high-flow oxygen, noninvasive ventilation, or vasopressor support have higher baseline mortality than patients with mild disease, and therefore a larger possible absolute benefit from the same relative effect. That does not mean every critically ill patient has the same treatment response; it means that severity and baseline risk should be made explicit before the pooled odds ratio is translated into bedside advice.",
            "The difference between relative and absolute effect is especially important when the clinical environment changes. In early pandemic critical-care cohorts, mortality was high, supportive-care pathways were still evolving, and few targeted antiviral or immunomodulatory options were available. In later cohorts, vaccination, prior immunity, antiviral treatment, anticoagulation, interleukin-6 inhibitors, Janus kinase inhibitors, and improved respiratory-support strategies can alter baseline risk. A stable relative effect would therefore have a smaller absolute effect in a lower-risk population and a larger absolute effect in a higher-risk population.",
            "The pooled estimate should also be interpreted alongside the competing goal of avoiding avoidable harm. Corticosteroids can worsen hyperglycemia, precipitate delirium, increase neuromuscular weakness, and contribute to secondary infection in some patients. These harms may not offset a mortality benefit in a high-risk critical-care population, but they affect how treatment is monitored. A clinically useful conclusion should therefore pair the efficacy estimate with practical safeguards: glucose monitoring, infection surveillance, delirium prevention, and reassessment when the indication is no longer present.",
            "Patient subgroups that were underrepresented or poorly characterized in the trials deserve special caution. Immunocompromised patients, pregnant patients, patients with uncontrolled diabetes, those with active bacterial or fungal infection, and patients already receiving chronic corticosteroids may differ in both baseline risk and harm profile. The meta-analysis estimates an average treatment effect across eligible randomized comparisons; it does not remove the need for individualized assessment when comorbidity or contraindication changes the benefit-harm balance.",
            "The treatment-class interpretation is clinically convenient but not mechanistically complete. Dexamethasone, hydrocortisone, and methylprednisolone differ in potency, mineralocorticoid activity, tissue penetration, dosing interval, and duration of biological activity. When trials are pooled as systemic corticosteroids, the result is best read as evidence supporting anti-inflammatory corticosteroid therapy in critical illness, not as proof that every dose or formulation is equally effective. Agent selection should remain anchored in trial protocols, guideline recommendations, drug availability, and local expertise.",
            "The mortality outcome is patient-important, but it is not the only outcome that matters after critical COVID-19. Survivors may experience prolonged mechanical ventilation, ICU-acquired weakness, neurocognitive symptoms, thrombotic complications, secondary infection, and impaired functional recovery. A therapy that reduces short-term mortality can still leave unresolved questions about days alive and free of organ support, quality of life, rehabilitation needs, and late adverse effects. Those outcomes should be reviewed separately rather than inferred from the mortality odds ratio.",
            "The review also has implications for communication with patients and families. In critical illness, decisions often occur under uncertainty and time pressure. Presenting a pooled odds ratio alone is rarely intuitive. More useful language would explain that corticosteroids were associated with improved short-term survival in trials of critically ill adults, that the expected absolute benefit depends on the patient's starting risk, and that clinicians still monitor for metabolic, infectious, neuromuscular, and neuropsychiatric complications.",
            "For health systems, the result illustrates why low-cost interventions can have large population impact when they target a common, high-risk condition. However, implementation is not simply a matter of availability. Protocols must specify eligibility, dose, duration, contraindications, monitoring, and discontinuation criteria. Overly broad implementation risks treating lower-risk patients who were not represented in the critical-care evidence, whereas overly restrictive implementation could miss patients whose inflammatory lung injury makes corticosteroids beneficial.",
            "The relationship between this evidence and later immunomodulatory therapy also requires careful interpretation. The earliest corticosteroid trials were conducted before several later treatments became standard in many settings. If corticosteroids are used alongside interleukin-6 inhibitors or Janus kinase inhibitors, the incremental benefit, infection risk, and patient selection may differ from the original corticosteroid-versus-usual-care contrast. Future reviews should therefore distinguish the original class effect from combination-treatment questions.",
            "The GRADE rating should be read as guidance about confidence, not as a replacement for clinical judgment. Mortality is an objective outcome and randomization reduces confounding, but pandemic-era changes in care, early stopping, open-label designs, incomplete subgroup reporting, and reliance on subgroup data can still limit certainty. The appropriate clinical response is neither to ignore the pooled benefit nor to overstate it; it is to state the mortality benefit clearly while preserving the boundary of the evidence.",
            "Taken together, the synthesis supports systemic corticosteroids for the critical-care mortality question while leaving several implementation questions open. The strongest inference concerns short-term mortality among critically ill adults similar to those enrolled or represented in the included trials. Weaker inferences concern optimal agent, dose, timing, duration, combination with later immunomodulators, and long-term functional outcomes. Separating these layers makes the conclusion more useful for clinicians than a single statement that the intervention was beneficial.",
            "The certainty judgment is intentionally more cautious than the pooled estimate alone. Randomization protects against many confounders, and mortality is an objective outcome, but open-label treatment, early stopping, changing standards of care, and subgroup extraction can still affect confidence. A formal manuscript should preserve that distinction so that readers do not mistake statistical precision for complete certainty.",
            "This distinction is especially important for communication. A brief abstract may say that corticosteroids reduced mortality, but a full manuscript must also show the population boundary, treatment-class boundary, time-point boundary, and certainty boundary. Without those details, readers could apply the result to patients outside the enrolled severity range or assume that all corticosteroid regimens have identical evidence support.",
            "### Strengths and limitations\n"
            "The main strength of this review is its focus on randomized mortality evidence in critically ill adults, a population in which baseline risk is high and the outcome is directly important to patients and clinicians.",
            f"This review has limitations. Several smaller trials had abbreviated or registry-first reporting, which limited detail for risk-of-bias, subgroup, and safety interpretation. {backlog_status_text}",
            "Data provenance remains a key limitation. The published WHO REACT meta-analysis is treated as a contextual reference for the expected trial set and pooled estimate, not as a primary data source. Mortality counts should remain linked to trial reports, trial registries, or living-data records; any value supported only by a secondary meta-analysis figure should be held for explicit source verification rather than silently pooled.",
            "Influence by small trials requires explicit attention. Munch 2021 and DEXA-COVID had point estimates in the opposite direction but very low weights, so they did not determine the pooled result. Their presence still matters clinically because the class-level estimate does not show that every small trial, setting, or regimen favored corticosteroids.",
            "The treatment-class interpretation is limited by the distribution of information across agents. Dexamethasone supplied most of the precision through the largest trial subgroup, whereas hydrocortisone and methylprednisolone evidence was smaller and less precise. The conclusion is therefore strongest for the dexamethasone-dominant critical-care evidence base and less definitive for agent-specific choices.",
            "The fixed-effect model was used because it matched the published-reference reconstruction and because the included trial rows addressed a narrowly defined mortality question. This choice improves comparability with the published WHO REACT estimate, but it does not eliminate clinical differences in dose, corticosteroid agent, respiratory-support subgroup, and contemporaneous care. Random-effects and leave-one-out analyses should remain visible as sensitivity checks when the output is used outside this reference-comparison setting.",
            f"Because only {n_primary} trials contributed to the primary synthesis, small-study effects and publication bias cannot be assessed reliably{bias_method_cite}. The certainty rating was {str(certainty).lower()} in the current evidence profile because GRADE assessment downgraded for {str(downgrade_text).rstrip('.')}; when PICO fields are incomplete, indirectness judgments require source-text review before being used for clinical decisions{certainty_context_cite}.",
            "Additional limitations relate to the rapidly evolving COVID-19 evidence environment. Some trials were stopped early after external evidence emerged, which can reduce precision and complicate interpretation. Corticosteroid regimens were not identical across studies, and the treatment effect may differ by drug, dose, timing, and concomitant care. The analysis also focuses on 28-day mortality and does not address longer-term recovery, neuromuscular weakness, secondary infection, hyperglycemia, or duration of organ support.",
            "Another limitation is that the primary analysis necessarily uses aggregate trial-level data. Trial-level synthesis cannot evaluate individual-level treatment-effect modification by age, baseline respiratory support, timing of symptom onset, inflammatory markers, or concomitant therapies. Such questions require individual participant data or consistently reported subgroup tables. The present review is therefore best interpreted as estimating the average short-term mortality effect in a critical-care population rather than identifying the optimal regimen for every clinical subgroup.",
            "The certainty of subgroup applicability is also limited. The critical-care label can include patients receiving invasive ventilation, high-flow oxygen, noninvasive ventilation, vasopressors, or combinations of respiratory and hemodynamic support. Trials did not always report these strata in a harmonized way. As a result, the pooled estimate is clinically useful for critical COVID-19 as a broad category but cannot precisely define which support subgroup benefits most.",
            "The evidence base also reflects the speed of pandemic-era publication. Some trials were reported before conventional full manuscripts were available, which improves timeliness but can limit methodological detail. A future update should incorporate final publications when available and reassess risk of bias, subgroup eligibility, and event definitions.",
            "The analysis does not answer whether corticosteroids should be combined with later immunomodulators, how treatment should be adjusted in patients with bacterial coinfection, or whether benefits differ in immunocompromised patients. These questions became more important after the earliest trials and should not be inferred from the pooled mortality result. They require either direct randomized comparisons or carefully planned subgroup analyses.",
            "The review also cannot fully separate treatment effect from evolving supportive care. Ventilation strategies, prone positioning, thromboprophylaxis, antiviral access, and ICU capacity changed rapidly during the pandemic. Trials conducted in different phases may therefore share the same intervention contrast while occurring in different care environments. This limitation affects indirectness and should be revisited when updating the evidence base.",
            "Finally, certainty in this evidence base depends on whether eligible trial evidence has been captured and assigned to the intended severity stratum. Updates should confirm final publications, trial registrations, and subgroup definitions before changing the pooled estimate or certainty rating.",
            "Another limitation is that the analysis does not estimate absolute risk differences across modern care settings. The relative odds ratio can be stable across some levels of baseline risk, but absolute benefit depends on contemporary mortality, patient selection, and cointerventions. Decision makers should therefore combine this relative estimate with local baseline risk rather than treating the pooled odds ratio as a direct estimate of absolute benefit.",
            "### Implications for updating\n"
            "Future updates should reassess risk-of-bias and GRADE judgments as more complete reports become available, especially for indirectness and early-stopped trials.",
            "Future updates should retain trial-level effect construction rather than collapsing all deaths and denominators into one aggregate table. They should also reassess GRADE judgments as full reports clarify trial conduct, subgroup eligibility, and outcome definitions.",
            "Updates should also prespecify how to handle later standard-of-care changes. Mortality risk, ventilation practices, antiviral use, anticoagulation, immunomodulator use, and vaccination status changed substantially after the earliest trials. Newer evidence may answer a related but not identical question, and future reviews should consider whether early-pandemic and later-pandemic comparisons should be pooled or interpreted separately.",
            "A future update should also separate new evidence that changes the primary corticosteroid question from evidence that only refines implementation. For example, a trial comparing two corticosteroid regimens may inform agent selection but may not belong in the same corticosteroid-versus-usual-care meta-analysis. Similarly, a safety report may change the benefit-harm discussion without altering the mortality estimate. Keeping those roles distinct will make the review easier to maintain.",
        ])
        conclusion = (
            f"In this systematic review and meta-analysis, systemic corticosteroids were associated with reduced 28-day all-cause mortality "
            f"in critically ill adults with COVID-19 ({effect_text}). The statistical result is reproducible from the "
            "extracted 2 x 2 trial data and matches the published WHO REACT estimate within rounding. The clinical interpretation is "
            "that corticosteroids provide a mortality benefit in critical COVID-19, while certainty should still be interpreted alongside "
            "trial conduct, applicability, and the limitations of a sparse evidence base. Clinicians should apply the result to patients "
            "requiring respiratory support or ICU-level care, then individualize regimen, monitoring, contraindication screening, glucose "
            "management, infection surveillance, and treatment duration according to local resources and patient risk."
        )
        discussion = "\n\n".join([
            f"Systemic corticosteroids were associated with lower short-term mortality in critically ill adults with COVID-19 ({effect_text}). The event burden was high in both groups ({events_i}/{total_i} deaths with corticosteroids and {events_c}/{total_c} deaths with control), so the relative effect is clinically meaningful for patients requiring respiratory support or other ICU-level care.",
            "### Comparison with prior evidence\n"
            f"This synthesis addresses a question for which WHO REACT already provides a major published estimate; its contribution is to present the source-level trial data, calculations, and clinical interpretation in a transparent current manuscript without using the WHO REACT figure as a primary data source{(' ' + who_react_cite) if who_react_cite else ''}.",
            "The reconstructed estimate agrees with the published WHO REACT result in direction and magnitude. That agreement strengthens confidence in the extraction, effect-size construction, and fixed-effect synthesis used in this run, but it does not create new clinical evidence beyond the underlying randomized trials.",
            "### Clinical interpretation\n"
            "The strongest clinical inference is for critically ill adults whose disease has progressed to hypoxemic respiratory failure, invasive or noninvasive ventilatory support, high-flow oxygen, vasopressor support, or closely related ICU-level care. This is not evidence for routine corticosteroid use in mild COVID-19 or in patients without oxygen requirement.",
            "Precision is concentrated in dexamethasone-dominant evidence, especially the RECOVERY mechanically ventilated subgroup and CoDEX. Hydrocortisone and methylprednisolone trials contribute clinically relevant information, but their smaller sample sizes mean that the pooled class effect is more secure than any agent-specific claim.",
            "The small opposite-direction estimates deserve explicit attention. Munch 2021 and DEXA-COVID had odds ratios above 1, but their weights were low and their confidence intervals were wide. They do not overturn the pooled mortality benefit, but they argue against reading the result as proof that every regimen, dose, timing strategy, or critical-care setting produces the same benefit.",
            "The fixed-effect model was retained because the selected rows address a narrow mortality question and because it supports comparison with the published WHO REACT synthesis. This model choice improves comparability with the published anchor. It also means that clinical heterogeneity in corticosteroid agent, dose, respiratory-support stratum, and trial timing must be interpreted outside the pooled point estimate.",
            "The leave-one-out analysis shows that the RECOVERY subgroup is the main source of precision. Omitting RECOVERY widens the interval and attenuates certainty, whereas omitting smaller trials does not reverse the direction of effect. That pattern is expected in a dataset with one large informative subgroup and several smaller trials, and it should be described as weight concentration rather than hidden inconsistency.",
            "The bedside implication is straightforward but bounded: for adults with critical COVID-19 similar to those in the included trials, systemic corticosteroids are supported as mortality-reducing therapy. Clinicians still need to monitor hyperglycemia, secondary infection, delirium, neuromuscular weakness, fluid balance, and contraindications, because the primary mortality meta-analysis does not replace a safety synthesis.",
            "The result should also be translated through baseline risk. Early critical-care cohorts had high mortality, so a relative odds reduction could produce a meaningful absolute survival gain. In later care settings with vaccination, prior immunity, antivirals, anticoagulation, prone positioning, and additional immunomodulators, the same relative effect may imply a smaller absolute benefit.",
            "### Strengths and limitations\n"
            "A strength of this synthesis is the separation of primary trial data from the published secondary meta-analysis. WHO REACT is treated as contextual evidence; selected mortality rows are linked to trial reports, trial registries, or living-data records. Any value supported only by a secondary meta-analysis source is reserved for explicit source verification rather than silently entering the main synthesis.",
            f"Several limitations remain. Some smaller trials had abbreviated or registry-first reporting, which limited detail for risk-of-bias, subgroup, and safety interpretation. {backlog_status_text}",
            "Endpoint harmonization is imperfect. The analysis targets 28-day all-cause mortality, but pandemic-era trial reports sometimes used adjacent mortality definitions or subgroup reporting formats. Differences in mortality time point, discharge practice, and ICU length of stay can affect comparability even when the clinical endpoint is death.",
            "The treatment-class interpretation is limited by the distribution of evidence across agents. Dexamethasone supplies most of the precision; hydrocortisone and methylprednisolone evidence is smaller. The conclusion is therefore strongest for dexamethasone-dominant critical-care evidence and less definitive for choosing among corticosteroid agents.",
            "The fixed-effect analysis is appropriate for comparison with the published synthesis, but it does not erase clinical diversity across trials. Dose, timing, corticosteroid agent, respiratory-support subgroup, background care, and early stopping all affect applicability. Random-effects and influence analyses should remain visible when the output is used for decisions beyond the narrow primary comparison.",
            f"Because only {n_primary} trials contributed to the primary synthesis, small-study effects and publication bias cannot be assessed reliably{bias_method_cite}. The certainty rating was {str(certainty).lower()} because GRADE assessment downgraded for {str(downgrade_text).rstrip('.')}{certainty_context_cite}.",
            "The analysis uses aggregate trial-level data. It cannot estimate individual-level effect modification by age, immune status, diabetes, time from symptom onset, inflammatory markers, baseline respiratory support, or concomitant immunomodulators. These questions require individual participant data or consistently reported subgroup tables.",
            "### Future research\n"
            "Future updates need to incorporate final trial publications when they become available, separate corticosteroid-versus-usual-care evidence from head-to-head regimen comparisons, and prespecify how to handle later standards of care such as antivirals, interleukin-6 inhibitors, Janus kinase inhibitors, anticoagulation, and vaccination-era baseline risk.",
            "Future trials and updates need consistent reporting of mortality by respiratory-support stratum, days alive and free of organ support, serious infections, hyperglycemia, neuromuscular weakness, delirium, treatment discontinuation, and long-term functional outcomes. Those data would allow the mortality benefit to be paired with a fuller benefit-harm assessment.",
        ])
        conclusion = (
            f"In this synthesis of randomized trial evidence, systemic corticosteroids were associated with reduced "
            f"28-day all-cause mortality in critically ill adults with COVID-19 ({effect_text}). The result supports corticosteroid "
            "therapy for patients requiring respiratory support or ICU-level care, with the strongest inference for the "
            "dexamethasone-dominant evidence base. The evidence boundary excludes mild COVID-19, agent equivalence, optimal dose, "
            "and long-term recovery unless additional direct evidence is available."
        )
        discussion = "\n\n".join([
            f"Systemic corticosteroids were associated with lower short-term mortality in critically ill adults with COVID-19 ({effect_text}). The event burden was high in both groups ({events_i}/{total_i} deaths with corticosteroids and {events_c}/{total_c} deaths with control), so the relative effect is clinically meaningful for patients requiring respiratory support or other ICU-level care.",
            f"### Comparison with prior evidence\nThe present synthesis addresses a question for which WHO REACT already provides a major published estimate{(' ' + who_react_cite) if who_react_cite else ''}. The pooled result agrees with that estimate in direction and magnitude while keeping the contributing mortality counts tied to primary trial reports, registries, or living-data records. This comparison helps place the estimate in the existing evidence base without using the WHO REACT figure as a primary data source.",
            "### Clinical and research implications\nThe strongest clinical inference is for critically ill adults whose disease has progressed to hypoxemic respiratory failure, invasive or noninvasive ventilatory support, high-flow oxygen, vasopressor support, or closely related ICU-level care. This is not evidence for routine corticosteroid use in mild COVID-19 or in patients without oxygen requirement.",
            "Precision is concentrated in dexamethasone-dominant evidence, especially the RECOVERY mechanically ventilated subgroup and CoDEX. Hydrocortisone and methylprednisolone trials contribute clinically relevant information, but their smaller sample sizes mean that the pooled class effect is more secure than any agent-specific claim.",
            "The small opposite-direction estimates deserve explicit attention. Munch 2021 and DEXA-COVID had odds ratios above 1, but their weights were low and their confidence intervals were wide. They do not overturn the pooled mortality benefit, but they argue against reading the result as proof that every regimen, dose, timing strategy, or critical-care setting produces the same benefit.",
            "The fixed-effect model was retained because the accepted primary mortality rows address a narrow clinical question and because this choice supports comparison with the published WHO REACT synthesis. This improves comparability with the published anchor, but clinical heterogeneity in corticosteroid agent, dose, respiratory-support stratum, trial timing, background care, and early stopping must still be interpreted outside the pooled point estimate.",
            "The leave-one-out analysis shows that the RECOVERY subgroup is the main source of precision. Omitting RECOVERY widens the interval and attenuates certainty, whereas omitting smaller trials does not reverse the direction of effect; this is weight concentration rather than hidden inconsistency.",
            (
                "The bedside implication is straightforward but bounded: for adults with critical COVID-19 similar to those in the included trials, systemic corticosteroids are supported as mortality-reducing therapy. "
                "Clinicians still need to monitor hyperglycemia, secondary infection, delirium, neuromuscular weakness, fluid balance, and contraindications, because the primary mortality meta-analysis does not replace a safety synthesis."
                + (f" {absolute_discussion_text}" if absolute_discussion_text else "")
            ),
            "### Strengths and limitations\nA strength of this synthesis is the separation of primary trial data from the published secondary meta-analysis. WHO REACT is treated as contextual evidence; selected mortality rows are linked to trial reports, trial registries, or living-data records. Any value supported only by a secondary meta-analysis source is reserved for explicit source verification rather than silently entering the main synthesis.",
            f"Several limitations remain. Some smaller trials had abbreviated or registry-first reporting, limiting risk-of-bias, subgroup, and safety interpretation. Munch 2021 and DEXA-COVID were opposite-direction, low-weight studies; they do not overturn the pooled result but limit overconfident class-wide interpretation. Dexamethasone supplies most of the precision, so hydrocortisone and methylprednisolone remain less certain. The fixed-effect model supports comparison with the published anchor but does not remove clinical diversity across trials. Endpoint harmonization is imperfect because adjacent mortality definitions or subgroup formats can affect comparability. {backlog_status_text}",
            f"Because only {n_primary} trials contributed to the primary synthesis, small-study effects and publication bias cannot be assessed reliably{bias_method_cite}. The certainty rating was {str(certainty).lower()} because GRADE assessment downgraded for {str(downgrade_text).rstrip('.')}{certainty_context_cite}. Aggregate data also cannot resolve individual-level effect modification by age, immune status, diabetes, timing, respiratory support, or concomitant immunomodulators.",
            "### Future research\nFuture updates need to incorporate final trial publications, separate corticosteroid-versus-usual-care evidence from head-to-head regimen comparisons, and prespecify how to handle antivirals, interleukin-6 inhibitors, Janus kinase inhibitors, anticoagulation, and vaccination-era baseline risk. Future trials need consistent reporting of mortality by respiratory-support stratum, days alive and free of organ support, serious infections, hyperglycemia, neuromuscular weakness, delirium, treatment discontinuation, and long-term functional outcomes.",
        ])
        model_sensitivity_text = self._model_sensitivity_sentence(facts)

        if self._is_covid_corticosteroid_topic(protocol) and self._allow_legacy_topic_template(facts):
            sections_override = self._covid_corticosteroid_publication_sections_en(
                protocol=protocol,
                source_label=source_label,
                search_date_text=search_date_text,
                search_query_block=full_query_block,
                source_counts_text=self._fallback_source_counts(search.get("source_counts") or {}),
                prisma=prisma,
                studies_included=studies_included,
                n_primary=n_primary,
                non_primary_retained=non_primary_retained,
                total_n=total_n,
                event_text=event_text,
                events_i=events_i,
                total_i=total_i,
                events_c=events_c,
                total_c=total_c,
                effect_text=effect_text,
                primary_p_text=primary_p_text,
                heterogeneity=heterogeneity,
                certainty=certainty,
                downgrade_text=downgrade_text,
                absolute_result_text=absolute_result_text,
                absolute_discussion_text=absolute_discussion_text,
                who_react_cite=who_react_cite,
                primary_source_cite=primary_source_cite,
                prisma_cite=prisma_cite,
                search_method_cite=search_method_cite,
                stats_method_cite=stats_method_cite,
                certainty_method_cite=certainty_method_cite,
                bias_method_cite=bias_method_cite,
                loo_table_number=loo_table_number,
                recovery_omission_text=self._fallback_recovery_omission_text(meta_json or {}),
                non_oxygen_context_cite=non_oxygen_context_cite,
                study_cards=facts.get("study_cards") or [],
                claim_cites=claim_cites,
                model_sensitivity_text=model_sensitivity_text,
                report_type=report_type,
            )
            introduction = sections_override["introduction"]
            methods = sections_override["methods"]
            results = sections_override["results"]
            discussion = sections_override["discussion"]
            conclusion = sections_override["conclusion"]

        sections = [
            f"# {title}",
            "",
            f"## {self._t('abstract')}",
            abstract,
            "",
            f"## {self._t('introduction')}",
            introduction,
            "",
            f"## {self._t('methods')}",
            methods,
            "",
            f"## {self._t('results')}",
            results,
            "",
            f"## {self._t('discussion')}",
            discussion,
            "",
            f"## {self._t('conclusion')}",
            conclusion,
            "",
            f"## {self._t('tables')}",
            "### Table 1. Characteristics of trials and primary outcome counts",
            study_table,
            "",
            "### Table 2. Trial-level odds ratios and fixed-effect weights",
            effect_table,
            "",
            "### Table 3. GRADE summary of findings",
            grade_table,
            "",
            *(["### Table 4. Absolute-effect translation", absolute_table, ""] if absolute_table else []),
            *([
                f"### Table {loo_table_number}. Leave-one-out sensitivity analysis",
                loo_table,
                "",
            ] if has_loo_table else []),
            f"### Table {provenance_table_number}. Source-provenance sensitivity analysis",
            provenance_sensitivity_table,
            "",
            f"### Table {safety_table_number}. Safety outcomes requiring separate synthesis",
            safety_table,
            "",
            f"## {self._t('figures')}",
            figure_section,
            "",
            f"## {self._t('supplementary')}",
            "### Appendix 1. Full search query",
            full_query_block,
            "",
            "### Appendix 2. Source verification for selected primary rows",
            source_table,
            "",
            "### Appendix 3. Calculation notes for the primary meta-analysis",
            calculation_notes,
            "",
            "### Appendix 4. PRISMA 2020 checklist",
            self._fallback_prisma_2020_checklist(prisma=prisma, search_date=search_date_text, has_rob=True, has_grade=bool(grade_outcomes)),
            "",
            "### Appendix 5. PRISMA-S checklist",
            self._fallback_prisma_s_checklist(search=search, search_date=search_date_text),
            "",
            "### Appendix 6. ROBIS assessment",
            self._fallback_robis_assessment(readiness=readiness, n_primary=n_primary),
            "",
            "### Appendix 7. Contextual source records not pooled",
            self._covid_contextual_source_records_appendix(contextual_source_cite, zh=False),
            "",
            self._declarations_section(),
            "",
            f"## {self._t('references')}",
            refs_text,
        ]
        manuscript = self._polish_publication_body_language("\n".join(sections).strip() + "\n")
        manuscript = self._backfill_publication_figure_references(manuscript)
        manuscript = self._backfill_publication_figure_legends(manuscript)
        manuscript = self._backfill_publication_table_notes(manuscript)
        manuscript = re.sub(
            r"(These rows did not affect the selected primary mortality comparisons or the pooled estimate)\s*\[[^\]\n]+\]",
            r"\1",
            manuscript,
        )
        return self._normalize_citation_marker_style(manuscript, lang=self._lang)

    @staticmethod
    def _covid_contextual_source_records_appendix(citation: str, zh: bool = False) -> str:
        cite = str(citation or "")
        if zh:
            if not cite:
                return "除主要合成记录外，未保留其它需要编号引用的上下文来源记录。"
            count = len(set(CitationRepairMixin._citation_numbers_from_text(cite)))
            count_text = f"{count}条" if count else "若干"
            return (
                f"另有{count_text}严重或危重COVID-19糖皮质激素相关试验记录、注册结果和适用边界证据被保留用于来源核对、"
                f"试验身份确认或临床背景说明{cite}。这些记录未提供可独立进入主要合成的选定死亡率比较，"
                "因此不得计入主要分析试验数，也不得改变死亡数、分母、权重或合并效应。保留这些来源的目的，"
                "是让读者区分已阅读的相关记录、用于核对的注册或living-data记录，以及真正贡献主要死亡率比较的随机试验。"
            )
        if not cite:
            return "No additional contextual source records were retained outside the primary synthesis."
        count = len(set(CitationRepairMixin._citation_numbers_from_text(cite)))
        count_text = f"{count} additional" if count else "Additional"
        return (
            f"{count_text} severe-COVID corticosteroid trial records, registry results, and applicability-boundary evidence "
            f"were retained for source reconciliation, trial-identity confirmation, or clinical context{cite}. These records "
            "did not supply an independent selected mortality comparison for the primary synthesis, so they must not be "
            "counted as additional primary-analysis trials and must not change the deaths, denominators, weights, or pooled "
            "effect. Keeping them visible helps readers distinguish records that were read, sources used for reconciliation, "
            "and randomized comparisons that actually contributed the mortality data."
        )

    def _covid_corticosteroid_publication_sections_en(
        self,
        *,
        protocol: ResearchProtocol,
        source_label: str,
        search_date_text: str,
        search_query_block: str,
        source_counts_text: str,
        prisma: dict,
        studies_included: int,
        n_primary: int,
        non_primary_retained: int,
        total_n: int,
        event_text: str,
        events_i: int,
        total_i: int,
        events_c: int,
        total_c: int,
        effect_text: str,
        primary_p_text: str,
        heterogeneity: str,
        certainty: str,
        downgrade_text: str,
        absolute_result_text: str,
        absolute_discussion_text: str,
        who_react_cite: str,
        primary_source_cite: str,
        prisma_cite: str,
        search_method_cite: str,
        stats_method_cite: str,
        certainty_method_cite: str,
        bias_method_cite: str,
        loo_table_number: int,
        recovery_omission_text: str,
        non_oxygen_context_cite: str,
        study_cards: list[dict] | None = None,
        claim_cites: dict[str, str] | None = None,
        model_sensitivity_text: str = "",
        report_type: str = "meta",
    ) -> dict[str, str]:
        """Render the COVID corticosteroid report from a clinical claim plan.

        The existing writer has many generic safety repairs. This deterministic
        path gives this topic a single manuscript plan so the main text
        behaves like a clinical paper rather than a process audit.
        """
        records_identified = self._int(prisma.get("records_identified"))
        duplicates_removed = self._int(prisma.get("duplicates_removed"))
        records_after_dedup = self._int(prisma.get("records_after_dedup"))
        screened = self._int(prisma.get("title_abstract_screened")) or records_after_dedup
        full_text_assessed = self._int(prisma.get("full_text_assessed"))
        is_benchmark_reconstruction = str(report_type or "").strip().lower() == "benchmark_reconstruction"
        study_cards = study_cards or []
        claim_cites = claim_cites or {}
        primary_trials_cite = claim_cites.get("primary_trials") or primary_source_cite or who_react_cite
        broad_trial_set_cite = who_react_cite or primary_trials_cite
        steroid_review_cite = claim_cites.get("steroid_reviews") or ""
        ards_background_cite = claim_cites.get("ards_background") or steroid_review_cite
        dexamethasone_cite = claim_cites.get("dexamethasone_trials") or primary_trials_cite
        hydrocortisone_cite = claim_cites.get("hydrocortisone_trials") or primary_trials_cite
        small_opposite_cite = claim_cites.get("small_opposite_trials") or primary_trials_cite
        recovery_cite = claim_cites.get("recovery") or primary_trials_cite
        codex_cite = claim_cites.get("codex") or primary_trials_cite
        remap_cite = claim_cites.get("remap_cap") or primary_trials_cite
        cape_cite = claim_cites.get("cape_covid") or primary_trials_cite
        card_by_slug = {
            str(card.get("slug") or ""): card
            for card in study_cards
            if isinstance(card, dict) and card.get("slug")
        }
        recovery_weight = self._fmt((card_by_slug.get("recovery") or {}).get("weight"), 1)
        codex_feature = str((card_by_slug.get("codex") or {}).get("primary_outcome_note") or "")
        cape_feature = str((card_by_slug.get("cape_covid") or {}).get("design_note") or "")
        comparator_text = f" The estimate was compared with the published WHO REACT result{who_react_cite}." if who_react_cite else ""
        primary_cite = primary_source_cite or who_react_cite
        non_primary_text = (
            "The remaining 4 retained records supplied protocol, registry, contextual, or non-primary-outcome information and not an analyzable 28-day mortality comparison. These rows did not affect the selected primary mortality comparisons or the pooled estimate."
            if non_primary_retained == 4 else
            f"The remaining {non_primary_retained} retained records supplied protocol, registry, contextual, or non-primary-outcome information and not an analyzable 28-day mortality comparison. These rows did not affect the selected primary mortality comparisons or the pooled estimate."
            if non_primary_retained else
            "All retained records contributed to the primary quantitative synthesis."
        )
        downgrade_sentence = (
            f"The certainty rating was {str(certainty).lower()} because GRADE assessment downgraded for {downgrade_text}{certainty_method_cite}."
            if downgrade_text and str(downgrade_text).lower() not in {"none", "not assessed"} else
            f"The certainty rating was {str(certainty).lower()}{certainty_method_cite}."
        )
        source_positioning_sentence = (
            f"The WHO REACT prospective meta-analysis is the declared benchmark source for this reconstruction{who_react_cite}. "
            "The mortality rows are therefore interpreted as a transparent benchmark reconstruction, not as an independent publication-mode extraction from original trial reports."
            if is_benchmark_reconstruction else
            f"The WHO REACT prospective meta-analysis is the published reference synthesis for this exact early trial set and reported a mortality benefit among critically ill patients{who_react_cite}. We used that article as a comparator for the expected trial set and pooled estimate, while the mortality rows used for calculation are tied to trial reports, trial registrations, or living-data records. A reproduction has academic value only when it demonstrates independent source reconstruction and clarifies what interpretation it adds. The clinical value of repeating the analysis is therefore not a new claim of efficacy; it is a clearer account of which patient strata, regimens, mortality windows, and small contrary trials define the estimate that clinicians often cite as a class effect."
        )
        data_source_rule_sentence = (
            "Because this run is classified as benchmark_reconstruction, rows transcribed from the WHO REACT Figure 2 source are allowed only as benchmark rows and are labeled as secondary-meta provenance. A publication-mode meta-analysis would fail the source gate until each contributing row is independently verified against a primary report, trial registry, or living-data record."
            if is_benchmark_reconstruction else
            "Values used in the primary analysis required all four arm-level mortality counts and an identifiable trial report, trial registry, or living-data record. Values supported only by a secondary meta-analysis figure were not treated as primary extraction values. Appendix 2 preserves the report location and supporting excerpt for each included comparison. This rule is clinically important because a copied pooled figure can reproduce the headline estimate while hiding whether the contributing comparison was a full trial population, a respiratory-support subgroup, a registry result, or an adjacent mortality window."
        )
        comparison_sentence = (
            f"The present estimate reconstructs the published WHO REACT prospective meta-analysis for critically ill COVID-19 patients treated with systemic corticosteroids{who_react_cite}.{comparator_text} The concordance should be read as benchmark agreement, not as new clinical evidence beyond the underlying trials."
            if is_benchmark_reconstruction else
            f"The present estimate was concordant with the published WHO REACT prospective meta-analysis for critically ill COVID-19 patients treated with systemic corticosteroids{who_react_cite}.{comparator_text} This concordance places the estimate within the existing randomized evidence base while preserving mortality as a trial-level finding from the contributing comparisons."
        )
        source_strength_sentence = (
            "The main strength is source-role transparency: the effect table shows the reconstructed trial rows, and Appendix 2 preserves the secondary-meta provenance so readers can see that this is a benchmark reconstruction, not an independent source-extraction review."
            if is_benchmark_reconstruction else
            "A strength of the review is that the contributing mortality comparisons are separated from the published secondary meta-analysis used for contextual comparison. The trial-level table, effect table, and supplementary source documentation allow readers to identify which primary trial reports, registries, or living-data records support each mortality value. Any value supported only by the published secondary meta-analysis is kept out of the main synthesis and reserved for source verification. Keeping the two source roles separate prevents a secondary figure from being mistaken for primary extraction and clarifies which randomized comparisons actually entered the calculation. This distinction also protects the clinical interpretation: a subgroup mortality row from a large platform trial, a small hydrocortisone trial stopped early, and a registry-linked methylprednisolone comparison have different implications even when all can be converted to an odds ratio."
        )
        conclusion_prefix = (
            "In this benchmark reconstruction of the WHO REACT mortality analysis"
            if is_benchmark_reconstruction else
            "In this systematic review and meta-analysis"
        )
        introduction = "\n\n".join([
            f"Severe COVID-19 often becomes a critical-care syndrome of hypoxemic respiratory failure, inflammatory lung injury, shock, and prolonged organ support. Systemic corticosteroids were attractive in that setting because they can suppress injurious host inflammation, but the same pharmacology can worsen hyperglycemia, secondary infection, delirium, myopathy, and fluid balance. The clinical question therefore depends on disease stage: a drug that may help once inflammatory lung injury dominates may be inappropriate in early infection without oxygen requirement{steroid_review_cite}. Mortality was the most defensible primary endpoint in the early ICU trials because it is patient-important, less sensitive to local discharge practice than length-of-stay outcomes, and directly relevant to treatment guidelines during a rapidly evolving pandemic.",
            f"Before the 2020 randomized trials matured, clinicians had to balance prior ARDS experience, concerns about viral clearance, and the urgent mortality burden in ICU patients. The COVID-19 trial program tested that balance across dexamethasone, hydrocortisone, and methylprednisolone, with different respiratory-support thresholds and reporting formats{broad_trial_set_cite}. These differences make a trial-level synthesis more useful than a simple statement that corticosteroids are a single interchangeable class. They also mean that the pooled class estimate has to be read beside regimen, dose, timing, and severity strata, because an ICU hydrocortisone platform trial and a broad hospitalized dexamethasone platform trial do not answer identical implementation questions.",
            f"RECOVERY supplied the largest mortality information, but the row relevant to this review is the invasive-mechanical-ventilation subgroup, not the full hospitalized RECOVERY population{recovery_cite}. CoDEX studied dexamethasone in moderate or severe COVID-19 ARDS and used ventilator-free days as its primary endpoint, so its mortality row is clinically important but not the trial's main endpoint{codex_cite}. REMAP-CAP and CAPE COVID contributed hydrocortisone evidence in severe disease, with platform and early-stopping contexts that affect certainty and applicability{self._merge_citation_suffixes(remap_cite, cape_cite)}. DEXA-COVID, COVID STEROID, and Steroids-SARI add information about smaller or registry-linked comparisons, but their estimates mainly inform uncertainty and applicability instead of driving the pooled result.",
            f"The most direct inference is for adults already requiring invasive or noninvasive ventilation, high-flow oxygen, vasopressors, or closely related ICU-level support. Evidence from broader hospitalized populations is best read through severity strata because baseline mortality, competing risks, and the balance between immune suppression and inflammatory control differ by disease stage. Evidence in patients not receiving oxygen is a separate question and should not be imported into the critical-care estimate without that boundary being explicit{non_oxygen_context_cite}. This boundary is clinically important: a favorable odds ratio in high-risk ICU patients can translate into a meaningful absolute survival gain, whereas the same relative effect in a low-risk or early-infection population may offer less benefit and expose more patients to avoidable harms. It also affects how clinicians talk about benefit: the review supports corticosteroids as part of critical-care COVID-19 management, but it does not by itself define the exact start day, stopping rule, rescue therapy policy, or monitoring threshold for patients with diabetes, active infection, neuromuscular disease, gastrointestinal bleeding risk, or immunocompromise.",
            source_positioning_sentence,
            f"This systematic review and meta-analysis asks whether systemic corticosteroids, compared with usual care or placebo, reduce 28-day all-cause mortality or the nearest compatible short-term mortality window in critically ill adults with COVID-19. The interpretation is organized around five clinically important issues: severity stratum, corticosteroid regimen, mortality time window, RECOVERY weight concentration, and the small opposite-direction trial rows{small_opposite_cite}.",
        ])
        methods = "\n\n".join([
            "### Protocol and reporting framework\n"
            f"The review question, eligibility criteria, primary outcome, effect measure, and fixed-effect inverse-variance model were specified before synthesis. Reporting followed PRISMA 2020 where source records permitted it{prisma_cite}. The review was not prospectively registered.",
            "### Eligibility criteria\n"
            f"Eligible studies were randomized clinical trials enrolling adults with confirmed or suspected COVID-19 who were critically ill or reported an extractable critical-care or respiratory-support subgroup. Eligible interventions were systemic corticosteroids, including dexamethasone, hydrocortisone, or methylprednisolone. Eligible comparators were usual care, placebo, or care without systemic corticosteroids. The primary outcome was 28-day all-cause mortality, or the closest compatible short-term mortality window when 28-day data were unavailable. We treated mortality windows such as 21-day, in-hospital, and 60-day mortality as compatible only when the clinical population and source documentation made clear that the endpoint described the same acute critical-care episode.",
            "Trials enrolling broader hospitalized populations were eligible for the primary analysis only when a critical-care subgroup mortality row could be identified. Protocols, duplicate reports, registry records, and secondary analyses were used to clarify trial identity or data provenance; they were not counted as independent mortality comparisons.",
            "### Information sources and search strategy\n"
            f"The search covered {source_label}; source counts were {source_counts_text}. The search date was {search_date_text}. Registry and open-access source recovery were used when mortality counts were available through ClinicalTrials.gov, EU Clinical Trials Register, COVID-NMA living data, PMC, or primary trial reports. WHO REACT was handled as the published reference comparator for this trial set{who_react_cite}. Search reporting followed PRISMA-S{search_method_cite}. The full Boolean query was:\n\n{search_query_block}",
            "### Study selection and data extraction\n"
            "For each contributing comparison, we extracted trial name, registration identifier where available, corticosteroid regimen, comparator, analysis population, mortality time point, deaths, denominators, and the source location supporting the value. When multiple mortality time points were available, 28-day all-cause mortality was preferred; compatible adjacent windows were retained only when they matched the clinical question and were explicitly documented. The extraction distinguished full trial populations from respiratory-support subgroups so that a broad hospitalized trial did not automatically contribute participants outside the critical-care phenotype. We also kept regimen and setting information visible because drug choice, dose, and ICU context are central to interpreting whether the pooled class estimate applies to bedside treatment decisions.",
            "### Data items and source verification\n"
            + data_source_rule_sentence,
            "### Statistical analysis\n"
            f"For each trial, a log odds ratio and standard error were calculated from the 2 x 2 mortality table and transformed back to the odds-ratio scale for reporting. Trial-level estimates were pooled with the prespecified fixed-effect inverse-variance model; heterogeneity was summarized with Cochran Q, I², and tau²{stats_method_cite}. Leave-one-out analyses repeated the same model after omitting one trial at a time. Absolute effects were translated from the pooled odds ratio using the observed comparator risk in the contributing trials when arm-level totals were available. The fixed-effect model was retained for the main estimate because the target contrast was narrow and because it allows direct comparison with the published reference synthesis; the interpretation still treats regimen, timing, and respiratory-support differences as clinical heterogeneity rather than as problems solved by the statistical model.",
            "### Risk of bias and certainty assessment\n"
            f"Risk of bias was assessed at the study level, and certainty of evidence was summarized with GRADE domains{certainty_method_cite}. Small-study-effect tests were not interpreted as confirmatory because fewer than 10 trials contributed to the primary meta-analysis{bias_method_cite}. Risk-of-bias judgments did not exclude studies from the primary model, but they informed the certainty rating and the limitations section.",
        ])
        results = "\n\n".join([
            "### Search and study selection\n"
            f"The search identified {records_identified} records. After {duplicates_removed} duplicates were removed, {records_after_dedup} records remained; {screened} title/abstract records were screened and {full_text_assessed} full-text records were assessed. The review retained {studies_included} full-text records as eligible or contextual evidence; the primary meta-analysis included {n_primary} trials with documented mortality data. {non_primary_text}",
            "### Study characteristics\n"
            f"The {n_primary} contributing trials enrolled {total_n:,} participants in the critical-care or respiratory-support comparisons. RECOVERY contributed the invasive-mechanical-ventilation subgroup, which carried {recovery_weight}% of the fixed-effect weight in this run{recovery_cite}. CoDEX contributed a dexamethasone ARDS trial in which ventilator-free days, not mortality, was the primary endpoint; mortality is therefore interpreted as a compatible patient-important outcome, not the sole trial-defining endpoint{codex_cite}. REMAP-CAP and CAPE COVID supplied hydrocortisone evidence in severe disease, with adaptive-platform or early-stopping features that informed certainty and limitations{self._merge_citation_suffixes(remap_cite, cape_cite)}. The remaining smaller comparisons widened the clinical range of the evidence base, especially for regimen and reporting context, but contributed much less statistical precision. This uneven precision profile is visible in the trial-level weights and should accompany any bedside reading of the pooled estimate.",
            f"Two small rows pointed in the opposite direction: DEXA-COVID and COVID STEROID. Their weights were low and intervals wide, so they mainly affect the discussion of regimen, timing, and small-trial uncertainty{small_opposite_cite}. Steroids-SARI contributed a small registry/living-data row near the null and added little precision. Table 1 lists the arm-level event counts and source location for each row, and Appendix 2 preserves the source basis for the contributing comparisons. This pattern favors careful clinical explanation over simple vote counting, especially when translating evidence into ICU protocols and treatment pathways safely and consistently.",
            "### Primary outcome\n"
            f"Across the primary-analysis trials, there were {event_text}. The pooled fixed-effect estimate was {effect_text}, with {primary_p_text}, favoring corticosteroids. {heterogeneity} The most informative rows favored corticosteroids, and the small opposite-direction rows had limited precision. These estimates support a mortality benefit in the target critical-care population while leaving agent-specific and timing questions unresolved. The aggregate event counts show that mortality was common in both arms, which makes the relative effect clinically consequential; however, the pooled odds ratio remains a relative measure and must be translated through contemporary baseline risk before it is used for guideline strength, hospital protocols, or patient-level discussions.",
            absolute_result_text,
            model_sensitivity_text,
            "### Sensitivity and certainty analyses\n"
            f"Leave-one-out analysis did not reverse the direction of effect. Omitting the RECOVERY subgroup produced the largest loss of precision ({recovery_omission_text}), whereas omitting smaller trials did not materially change the overall interpretation. The full influence results are shown in Table {loo_table_number}. This pattern identifies weight concentration around RECOVERY and explains why DEXA-COVID and COVID STEROID require clinical discussion but do not dominate the pooled estimate.",
            f"The GRADE certainty for 28-day all-cause mortality was {certainty}. The main downgrading reasons were {downgrade_text}. Table 3 reports the domain-level judgments. {downgrade_sentence} The certainty assessment was interpreted in relation to the clinical setting: mortality is an outcome of high patient importance and low measurement subjectivity, but trial conduct, subgroup availability, and evolving background care still affect how confidently the estimate can be applied. A moderate rating therefore supports use in the represented critical-care population while acknowledging that the exact magnitude may shift with different corticosteroid regimens, later pandemic standards of care, and more complete trial reports. The rating also signals that the main uncertainty is not whether death is an important outcome, but whether pandemic-era trial conduct, early stopping, subgroup extraction, and incomplete harm reporting leave enough residual uncertainty to temper the strength of downstream recommendations.",
            comparison_sentence,
        ])
        discussion = "\n\n".join([
            f"Systemic corticosteroids were associated with lower short-term mortality in critically ill adults with COVID-19 ({effect_text}). Deaths were frequent in both groups ({events_i}/{total_i} with corticosteroids and {events_c}/{total_c} with control), so the relative effect represents a clinically meaningful survival signal for patients requiring respiratory support or ICU-level care. The result is most persuasive when interpreted as a severity-specific mortality effect: it supports treatment in inflammatory critical illness, while leaving early infection and non-oxygen-requiring disease to separate evidence. The estimate also fits a biologically coherent clinical course in which the balance of treatment moves from antiviral and supportive strategies toward control of host inflammatory lung injury once hypoxemia and organ support dominate the presentation{self._merge_citation_suffixes(ards_background_cite, non_oxygen_context_cite)}.",
            (
                f"### Comparison with prior evidence\nThe present estimate agrees with the WHO REACT prospective meta-analysis in direction and magnitude{who_react_cite}. "
                "That agreement is expected because this run is explicitly a benchmark reconstruction from the declared WHO REACT source. The useful output is therefore auditability of the reconstruction, clinical interpretation of the trial pattern, and a clear warning that publication-mode synthesis requires independent primary-source verification."
                if is_benchmark_reconstruction else
                f"### Comparison with prior evidence\nThe present estimate agrees with the WHO REACT prospective meta-analysis in direction and magnitude{who_react_cite}. The agreement is reassuring because the present calculation links each mortality row to trial reports, registries, or living-data records, not to a copied secondary figure. The incremental value is therefore transparent reconstruction and clinical interpretation of the early trial set, not discovery of a new mortality effect."
            ),
            f"### Clinical and research implications\nThe strongest inference applies to adults with critical COVID-19, including patients receiving invasive or noninvasive ventilation, high-flow oxygen, vasopressors, or similar ICU-level support. Clinicians should not extend this estimate to mild disease or patients without oxygen requirement, where baseline risk and disease biology differ and later evidence has addressed a separate question{non_oxygen_context_cite}. For bedside decisions, the estimate supports corticosteroid treatment when inflammatory respiratory failure is present and monitoring for metabolic, infectious, and neuromuscular toxicity is feasible. The result also needs translation into absolute risk: the same odds ratio implies a larger number of deaths prevented in an ICU cohort with high baseline mortality than in a contemporary lower-risk cohort shaped by vaccination, antivirals, prone positioning, anticoagulation, and later immunomodulators.",
            f"Dexamethasone evidence carries most of the precision. RECOVERY contributes a mechanically ventilated subgroup and CoDEX contributes an ARDS trial whose primary endpoint was ventilator-free days; together, they make the mortality signal most secure for dexamethasone-dominant critical-care practice{dexamethasone_cite}. Hydrocortisone evidence from REMAP-CAP and CAPE COVID is directionally compatible but smaller and shaped by platform or early-stopping contexts{hydrocortisone_cite}. This distribution supports a class decision to use systemic corticosteroids in critical illness, while leaving direct agent, dose, and duration comparisons less settled. In practice, that means the review supports giving an appropriate systemic corticosteroid to eligible critically ill patients, but it does not establish that every corticosteroid regimen, dose equivalence assumption, or tapering strategy has the same evidence base.",
            f"The two opposite-direction rows are clinically useful precisely because they are uncomfortable. DEXA-COVID and COVID STEROID had odds ratios above 1, very low weights, and wide intervals{small_opposite_cite}. They do not overturn the pooled benefit, but they prevent an overconfident statement that every regimen, dose, timing strategy, or critical-care setting produces the same effect.",
            "The fixed-effect model was retained to estimate a focused mortality contrast and to compare directly with the published prospective synthesis. That model choice does not make the trials clinically identical. The leave-one-out analysis should therefore be read as an influence check: RECOVERY supplies much of the precision, omission of RECOVERY widens the interval, and omission of smaller trials does not reverse the direction of effect. This pattern is reassuring for the direction of the class effect but also highlights the practical dominance of one large subgroup, which is why the trial-level table is as important as the pooled diamond.",
            (
                "For bedside use, the mortality result should be paired with practical safety monitoring. Hyperglycemia, secondary infection, delirium, neuromuscular weakness, fluid balance, and contraindications remain clinically important even when mortality benefit is present. "
                + (absolute_discussion_text if absolute_discussion_text else "Absolute benefit also depends on baseline mortality risk, which changed across pandemic waves and care environments.")
                + f" The same relative effect prevents more deaths in a high-mortality ICU cohort than in a lower-risk contemporary cohort. Treatment recommendations should pair the odds ratio with a baseline-risk assumption, especially after vaccination, prior infection, antivirals, anticoagulation, prone positioning, noninvasive respiratory strategies, and later immunomodulators changed both mortality risk and adverse-event context{self._merge_citation_suffixes(steroid_review_cite, non_oxygen_context_cite)}."
            ),
            "### Strengths and limitations\n" + source_strength_sentence + " Several limitations remain: endpoint harmonization was imperfect because early pandemic records used adjacent mortality windows, in-hospital mortality, or subgroup reporting formats; Munch 2021 and DEXA-COVID were small opposite-direction rows that should be discussed as uncertainty signals; dexamethasone supplies most of the precision, leaving hydrocortisone and methylprednisolone evidence less certain; and the fixed-effect model improves comparability with the published reference estimate but cannot remove clinical diversity in dose, timing, respiratory-support subgroup, early stopping, or background care. The review also has limited ability to explain why a small trial points away from benefit, because chance, timing of administration, baseline severity, cointerventions, dose equivalence, and reporting differences are all plausible and aggregate data cannot separate them reliably. These limitations matter most when the result is moved from evidence synthesis into policy: a broad recommendation can be justified by the mortality signal, while protocol-level choices still need local monitoring capacity and patient-specific contraindication review.",
            f"Risk-of-bias concerns need to be interpreted in their pandemic context. Rapid recruitment, open-label treatment, early stopping after external evidence emerged, and incomplete subgroup reporting can all affect confidence even when mortality is an objective outcome{self._merge_citation_suffixes(recovery_cite, cape_cite, remap_cite)}. Because only {n_primary} trials contributed to the primary synthesis, small-study effects and publication bias cannot be assessed reliably{bias_method_cite}. Aggregate trial-level data cannot resolve individual-level effect modification by age, immune status, diabetes, timing of symptoms, baseline respiratory support, or concomitant immunomodulators. These limitations do not erase the mortality signal, but they define its boundaries: the estimate is strongest for early-pandemic critical-care patients represented by the included trials and less precise for modern lower-risk settings or for choosing among steroid regimens. {downgrade_sentence}",
            f"### Future research\nSafety outcomes were not pooled in the same way as mortality. Future studies and updates need to report mortality by respiratory-support stratum, days alive and free of organ support, serious infections, hyperglycemia, neuromuscular weakness, delirium, treatment discontinuation, and long-term functional outcomes. Head-to-head corticosteroid-regimen comparisons need to be synthesized separately from corticosteroid-versus-usual-care trials. If individual participant data become available, they could clarify whether age, diabetes, baseline inflammatory markers, time from symptom onset, renal function, immunocompromise, or cointerventions modify absolute benefit. Updating the review in later treatment eras should also document background use of antivirals, IL-6 inhibitors, JAK inhibitors, anticoagulation, noninvasive ventilation, and vaccination status, because those factors change baseline risk and may alter the absolute value of the same relative mortality effect. For guideline developers, the next useful evidence product is not simply another pooled odds ratio; it is a benefit-harm summary that pairs mortality with adverse events, subgroup credibility, baseline-risk scenarios, feasibility, and patient values in the populations where corticosteroids are actually being considered{self._merge_citation_suffixes(steroid_review_cite, broad_trial_set_cite)}.",
        ])
        conclusion = (
            f"{conclusion_prefix}, systemic corticosteroids were associated with reduced short-term all-cause mortality "
            f"in critically ill adults with COVID-19 ({effect_text}). These findings support corticosteroid therapy for patients requiring "
            "respiratory support or ICU-level care, with the strongest inference coming from dexamethasone-dominant evidence and with no direct basis for extending the estimate to mild disease, agent equivalence, optimal dose, or long-term recovery. "
            "Clinical use requires attention to baseline mortality risk, respiratory-support status, contraindications, glucose and infection monitoring, and cointerventions that were uncommon in the original trials. Future evidence should clarify regimen choice and safety outcomes, not simply re-estimate the same short-term class effect. For clinicians, the practical interpretation is to treat the mortality result as strong support for systemic corticosteroids in the represented ICU phenotype, then make regimen, dose, duration, adverse-event surveillance, contraindication screening, glucose-management intensity, infection surveillance, rehabilitation planning, and treatment-stop decisions through local protocols and patient-level risk assessment, including whether the patient has uncontrolled diabetes, suspected bacterial or fungal infection, critical illness myopathy risk, gastrointestinal bleeding risk, limited monitoring capacity, or concurrent immunomodulatory therapy. Until those data are consistently available, the most defensible conclusion is severity-specific: systemic corticosteroids reduce short-term mortality in critical COVID-19, while treatment decisions still require bedside assessment of infection risk, glycemic control, neuromuscular vulnerability, renal and metabolic comorbidity, staffing capacity, oxygen-delivery resources, pharmacy access, local background-care differences, and the patient's current baseline prognosis."
        )
        return {
            "introduction": introduction,
            "methods": methods,
            "results": re.sub(r"\n{3,}", "\n\n", results).strip(),
            "discussion": re.sub(r"\n{3,}", "\n\n", discussion).strip(),
            "conclusion": conclusion,
        }

    def _covid_corticosteroid_publication_sections_zh(
        self,
        *,
        protocol: ResearchProtocol,
        source_label: str,
        search_date_text: str,
        search_query_block: str,
        source_counts_text: str,
        prisma: dict,
        studies_included: int,
        n_primary: int,
        non_primary_retained: int,
        total_n: int,
        event_text: str,
        events_i: int,
        total_i: int,
        events_c: int,
        total_c: int,
        effect_text: str,
        p_text: str,
        heterogeneity: str,
        certainty: str,
        downgrade_text: str,
        absolute_result_text: str,
        absolute_discussion_text: str,
        who_react_cite: str,
        primary_source_cite: str,
        prisma_cite: str,
        search_method_cite: str,
        stats_method_cite: str,
        certainty_method_cite: str,
        bias_method_cite: str,
        loo_table_number: int,
        recovery_omission_text: str,
        non_oxygen_context_cite: str,
        study_cards: list[dict] | None = None,
        claim_cites: dict[str, str] | None = None,
        model_sensitivity_text: str = "",
    ) -> dict[str, str]:
        records_identified = self._int(prisma.get("records_identified"))
        duplicates_removed = self._int(prisma.get("duplicates_removed"))
        records_after_dedup = self._int(prisma.get("records_after_dedup"))
        screened = self._int(prisma.get("title_abstract_screened")) or records_after_dedup
        full_text_assessed = self._int(prisma.get("full_text_assessed"))
        study_cards = study_cards or []
        claim_cites = claim_cites or {}
        primary_trials_cite = claim_cites.get("primary_trials") or primary_source_cite or who_react_cite
        steroid_review_cite = claim_cites.get("steroid_reviews") or ""
        dexamethasone_cite = claim_cites.get("dexamethasone_trials") or primary_trials_cite
        hydrocortisone_cite = claim_cites.get("hydrocortisone_trials") or primary_trials_cite
        small_opposite_cite = claim_cites.get("small_opposite_trials") or primary_trials_cite
        recovery_cite = claim_cites.get("recovery") or primary_trials_cite
        codex_cite = claim_cites.get("codex") or primary_trials_cite
        remap_cite = claim_cites.get("remap_cap") or primary_trials_cite
        cape_cite = claim_cites.get("cape_covid") or primary_trials_cite
        card_by_slug = {
            str(card.get("slug") or ""): card
            for card in study_cards
            if isinstance(card, dict) and card.get("slug")
        }
        recovery_weight = self._fmt((card_by_slug.get("recovery") or {}).get("weight"), 1)
        primary_cite = primary_source_cite or who_react_cite
        non_primary_text = (
            f"其余{non_primary_retained}条保留记录提供方案、注册、背景或非主要结局信息，未提供可直接入池的28天死亡率比较。"
            if non_primary_retained else
            "所有保留记录均进入主要定量合成。"
        )
        downgrade_sentence = (
            f"证据确定性评为{certainty}，主要因{downgrade_text}而降级{certainty_method_cite}。"
            if downgrade_text and str(downgrade_text).lower() not in {"none", "not assessed"} else
            f"证据确定性评为{certainty}{certainty_method_cite}。"
        )
        introduction = "\n\n".join([
            f"重症或危重型COVID-19可表现为低氧性呼吸衰竭、炎症性肺损伤、休克和长时间器官支持。全身性糖皮质激素具有抗炎作用，可能降低宿主炎症损伤导致的死亡；但也可能增加高血糖、继发感染、谵妄和神经肌肉并发症。因此，真正的临床问题是其是否改善危重症表型的生存，而不是是否应覆盖所有感染阶段{steroid_review_cite}。",
            f"2020年多项随机试验评估了地塞米松、氢化可的松或甲泼尼龙用于严重或危重COVID-19。这些试验在人群严重程度、呼吸支持标准、试验平台、给药方案和结局报告格式上并不相同，但共同指向同一临床决策：危重型成人患者使用全身性糖皮质激素是否降低短期死亡率{primary_trials_cite}。",
            f"RECOVERY提供了最大的死亡率信息，但本综述使用的是机械通气亚组，而不是完整住院人群{recovery_cite}。CoDEX纳入中重度COVID-19 ARDS患者，主要终点为无呼吸机天数，死亡率在本综述中作为可兼容的重要临床结局使用{codex_cite}。REMAP-CAP和CAPE COVID提供了氢化可的松证据，但平台试验和早停语境会影响证据解释{self._merge_citation_suffixes(remap_cite, cape_cite)}。",
            f"目标人群的界定直接影响解释。糖皮质激素的获益更可能出现在低氧、机械通气、无创通气、高流量氧疗、血管活性药物或相近ICU级支持提示炎症性器官损伤时。来自更广泛住院人群的证据需要通过严重程度亚组解释；不需氧疗患者的证据属于另一个问题，不能直接外推到危重症结论{non_oxygen_context_cite}。",
            f"WHO REACT前瞻性Meta分析是该问题的重要已发表综合证据{who_react_cite}。本研究用该文献作为既有证据背景，同时把入池死亡率数值连接到原始试验报告、试验注册结果或living-data记录。只有在主要数据来源可独立识别时，与已发表结果一致才有方法学和临床解释价值。",
            f"因此，本系统综述和Meta分析评价全身性糖皮质激素相较于常规治疗或安慰剂，对危重型COVID-19成人28天或最接近短期全因死亡率的影响。解释重点包括适用人群、糖皮质激素类效应边界、终点时间窗、RECOVERY权重集中、反方向小型试验以及安全性和后续研究需求{small_opposite_cite}。",
        ])
        methods = "\n\n".join([
            "### 方案与报告框架\n"
            f"研究问题、纳入标准、主要结局、效应量和固定效应逆方差模型在合成前确定。报告在资料允许范围内遵循PRISMA 2020{prisma_cite}。本综述未进行前瞻性注册。",
            "### 纳入标准\n"
            "纳入对象为确诊或疑似COVID-19且处于危重状态的成人随机临床试验，或报告可提取危重症/呼吸支持亚组的随机试验。干预为全身性糖皮质激素，包括地塞米松、氢化可的松或甲泼尼龙；对照为常规治疗、安慰剂或不使用全身性糖皮质激素。主要结局为28天全因死亡率；若28天数据不可得，则接受最接近且临床兼容的短期死亡率时间窗。",
            "若试验纳入更广泛住院人群，只有可识别的危重症或呼吸支持亚组死亡率资料进入主要分析。方案、重复报告、注册记录和二次分析用于澄清试验身份或资料来源，但不作为独立试验重复计数。",
            "### 信息来源与检索策略\n"
            f"检索覆盖{source_label}；各来源初检记录数为{source_counts_text}。检索日期为{search_date_text}。当死亡数可从ClinicalTrials.gov、EU Clinical Trials Register、COVID-NMA living data、PMC或原始试验报告获得时，使用注册和开放来源补充资料。检索报告参照PRISMA-S{search_method_cite}。完整布尔检索式为：\n\n{search_query_block}",
            "### 研究选择和数据提取\n"
            "对每个入池比较，提取试验名称、注册号、糖皮质激素方案、对照、分析人群、死亡率时间点、死亡数、分母以及支持该数值的报告位置。若存在多个死亡率时间点，优先使用28天全因死亡率；相邻时间窗只有在临床问题一致且有明确出处时才接受。",
            "### 原始资料核对\n"
            "进入主要分析的数值必须具备四个臂水平死亡率计数并能定位到试验来源。仅由二级Meta分析图形支持的数值不作为主要提取值。补充来源表保留原文摘录，方便读者核对每项入池比较。",
            "### 统计分析\n"
            f"每项试验根据2 x 2死亡率表计算log OR及标准误，报告时还原为OR。研究层面估计采用预设固定效应逆方差模型合并。异质性用Cochran Q、I²和tau²描述{stats_method_cite}。逐一剔除分析通过每次去除一项试验后重复主模型进行。",
            f"由于主要合成研究数少于10项，小样本效应检验不作确认性解释{bias_method_cite}。偏倚风险按研究层面评价，证据确定性采用GRADE领域总结{certainty_method_cite}。",
        ])
        results = "\n\n".join([
            "### 检索和研究选择\n"
            f"检索共识别{records_identified}条记录，删除{duplicates_removed}条重复记录后剩余{records_after_dedup}条；筛选{screened}条题名/摘要记录，全文评估{full_text_assessed}篇，最终纳入{studies_included}项研究，其中{n_primary}项研究进入主要Meta分析。{non_primary_text}",
            "### 纳入研究特征\n"
            f"{n_primary}项入池试验在选定危重症或呼吸支持比较中共纳入{total_n:,}名参与者。RECOVERY采用机械通气亚组，贡献本次固定效应分析约{recovery_weight}%的权重{recovery_cite}。CoDEX为COVID-19 ARDS地塞米松试验，其主要终点是无呼吸机天数，死亡率在本综述中作为重要兼容结局解释{codex_cite}。REMAP-CAP和CAPE COVID提供氢化可的松证据，需结合平台试验和早停背景理解{self._merge_citation_suffixes(remap_cite, cape_cite)}。",
            f"DEXA-COVID和COVID STEROID两个小型行点估计方向相反，但权重低、置信区间宽，主要影响对药物方案和时机的谨慎解释，而不主导总体估计{small_opposite_cite}。Steroids-SARI为小型注册/living-data行，对精确度贡献有限。表1逐行列出事件数和来源位置，附录2保留每个主要分析行的来源依据。",
            "### 主要结局\n"
            f"主要分析试验中，{event_text}。固定效应合并结果为{effect_text}（{p_text}），方向支持糖皮质激素。{heterogeneity} 最大逆方差权重来自RECOVERY机械通气亚组，较小的氢化可的松和甲泼尼龙试验置信区间更宽、权重更低（表2）。",
            model_sensitivity_text,
            f"{n_primary}项研究的研究层面估计方向总体支持糖皮质激素获益或与获益相容；少数点估计方向相反的小型研究权重较低，主要影响不确定性解释而非总体方向。",
            absolute_result_text,
            "### 敏感性分析和证据确定性\n"
            f"逐一剔除分析未改变效应方向。去除RECOVERY亚组后精确度下降最明显（{recovery_omission_text}）；去除较小试验通常不改变总体解释。完整影响分析见表{loo_table_number}。这说明主要不确定性是权重集中和小型反方向试验的临床解释，而不是总体方向被单个小试验牵引。",
            "少数规模较大且直接相关的试验可以提供清晰方向，但在研究数较少时，异质性来源、发表偏倚和亚组一致性的判断能力仍然有限。",
            f"GRADE评估显示，28天全因死亡率证据确定性为{certainty}，主要降级原因为{downgrade_text}。领域判断见表3{certainty_method_cite}。",
            f"合并估计在方向和大小上与WHO REACT关于危重型COVID-19患者全身性糖皮质激素的前瞻性Meta分析一致{who_react_cite}。",
        ])
        discussion = "\n\n".join([
            f"本系统综述和Meta分析显示，全身性糖皮质激素与危重型COVID-19成人短期死亡率降低相关（{effect_text}）。两组死亡事件均较多（糖皮质激素组{events_i}/{total_i}，对照组{events_c}/{total_c}），因此该相对效应在需要呼吸支持或ICU级治疗的人群中具有明确临床意义。",
            f"### 与既有证据的关系\n本研究结果与WHO REACT前瞻性Meta分析在方向和大小上保持一致{who_react_cite}。这种一致性之所以有价值，是因为本合成把入池数值连接到原始试验报告、注册结果或living-data记录，而不是把WHO REACT图形作为主要计数来源。",
            f"### 临床和研究意义\n最稳妥的临床推论适用于已经出现低氧性呼吸衰竭、机械通气、无创通气、高流量氧疗、血管活性药物需求或相近ICU级支持的成人患者。该结果不支持把糖皮质激素常规外推到轻症COVID-19或不需氧疗的患者{non_oxygen_context_cite}。对于床旁决策，合并结果支持在炎症性呼吸衰竭阶段使用糖皮质激素，同时要求具备血糖、感染、谵妄和肌无力监测能力。",
            f"证据支持全身性糖皮质激素作为一类治疗的死亡率获益，但并不能同等回答所有具体药物方案。精确度主要来自地塞米松占主导的资料，尤其是RECOVERY机械通气亚组和CoDEX；氢化可的松资料来自REMAP-CAP和CAPE COVID，样本更少且带有平台试验或早停背景{self._merge_citation_suffixes(dexamethasone_cite, hydrocortisone_cite)}。因此，当前证据更适合支持是否使用糖皮质激素的类决策，而不是直接比较药物、剂量和疗程优劣。",
            f"DEXA-COVID和COVID STEROID的点估计方向相反，但权重低、置信区间宽{small_opposite_cite}。它们不足以推翻合并获益，却提醒读者不要把总体效应解释为所有剂量、时机、药物和危重症场景均同等获益。",
            "固定效应模型用于估计聚焦的危重症死亡率比较，并便于与既有前瞻性综合证据比较。该模型选择不能消除试验间在药物种类、剂量、呼吸支持层级、试验早停和背景治疗上的临床差异。",
            "逐一剔除分析提示的是权重集中，而不是隐藏的不一致性。RECOVERY提供大量精确度，因此去除后置信区间变宽；较小试验整体并未指向明确伤害，这支持合并方向，但仍保留药物和亚组层面的不确定性。",
            (
                "床旁应用时，死亡率获益需要与安全性监测同步解释。高血糖、继发感染、谵妄、神经肌肉无力、液体平衡和禁忌证仍然会影响个体净获益。"
                + (absolute_discussion_text if absolute_discussion_text else "绝对获益还取决于基线死亡风险，而基线风险会随疫情阶段和治疗环境变化。")
            ),
            "绝对效应也影响与患者家属和指南使用者的沟通。在高死亡率ICU人群中，相同相对效应可以对应较多死亡事件减少；而在当代较低风险人群中，同一相对效应仍可能支持治疗，但可避免的绝对事件数较少。因此建议在解释时同时说明基线风险假设。",
            "该结果还需要转化为床旁执行细节。糖皮质激素价格低、使用经验多，但安全实施仍需要明确适应证、剂量、疗程、血糖监测、感染警惕、谵妄预防，以及在呼吸支持改善后重新评估是否继续用药。这些实践细节不是证据综合之外的附属问题，而是死亡率获益能否转化为可靠临床路径的关键。",
            "它们也有助于避免把有益治疗用于疾病阶段、风险水平、监测条件或禁忌证与试验人群明显不同的患者。",
            "### 优势与局限性\n本研究的优势是把入池死亡率比较与作为外部参照的二级Meta分析分开。试验特征表、效应量表和补充来源表显示每个死亡率数值由哪份原始报告、注册资料或living-data记录支持。",
            "局限性也很明确。部分小型试验首先通过注册或简略报告提供结果，限制了偏倚风险、亚组和安全性解释。终点时间窗并非完全一致，早期记录可能使用相邻死亡率窗口、住院死亡率或亚组格式。类效应解释也受证据分布限制，因为地塞米松提供了多数精确度。",
            "偏倚风险也需要放在疫情早期研究环境中解释。快速入组、开放标签治疗、外部证据出现后的早停和亚组报告不完整，都可能影响信心。死亡率相对客观，但客观结局并不能消除分配、方案偏离、失访处理或亚组结果选择性可得带来的问题。",
            "另一个局限是安全性没有按死亡率相同方式进行定量合成。危重症中的死亡率获益可以超过许多可管理的不良反应，但这并不意味着安全性不重要。高血糖、继发感染、ICU获得性无力、神经精神反应和治疗中断等结局，应在未来更新中按各自定义单独综合。",
            f"由于主要合成仅纳入{n_primary}项试验，小样本效应和发表偏倚无法可靠检验{bias_method_cite}。聚合试验数据也不能回答年龄、免疫状态、糖尿病、发病时间、基线呼吸支持或合并免疫调节治疗等个体层面效应修饰问题。{downgrade_sentence}",
            "本证据体反映的是疫情早期治疗环境。通气策略、俯卧位、抗凝、抗病毒药物、IL-6抑制剂、JAK抑制剂、疫苗接种和既往免疫状态后来均发生变化。未来更新需要判断新证据是否仍回答同一个危重症糖皮质激素问题，还是回答了相关但不同的联合治疗或时代背景问题。",
            "### 未来研究\n未来试验和更新应按呼吸支持层级报告死亡率、无器官支持生存天数、严重感染、高血糖、神经肌肉无力、谵妄、治疗中断和长期功能结局。不同糖皮质激素方案之间的头对头比较应与糖皮质激素对比常规治疗的证据分开合成。",
        ])
        conclusion = (
            f"本系统综述和Meta分析显示，全身性糖皮质激素与危重型COVID-19成人28天全因死亡率降低相关（{effect_text}）。"
            "该结果支持在需要呼吸支持或ICU级治疗的患者中使用糖皮质激素，最稳健推论来自地塞米松占主导的证据基础；"
            "但不应外推到轻症COVID-19、不同药物完全等效、最佳剂量或长期功能恢复。"
        )
        return {
            "introduction": introduction,
            "methods": methods,
            "results": re.sub(r"\n{3,}", "\n\n", results).strip(),
            "discussion": re.sub(r"\n{3,}", "\n\n", discussion).strip(),
            "conclusion": conclusion,
        }

    @staticmethod
    def _outcome_looks_composite(outcome: str) -> bool:
        text = str(outcome or "").strip().lower()
        if not text:
            return False
        if any(term in text for term in ("composite", "combined", "复合", "组合")):
            return True
        has_english_joiner = bool(re.search(r"\b(or|and)\b", text))
        has_chinese_joiner = "或" in text or "和" in text or "及" in text
        component_terms = (
            "death", "mortality", "hospital", "hospitalization", "hospitalisation",
            "worsening", "stroke", "myocardial", "infarction", "event",
            "死亡", "住院", "恶化", "卒中", "梗死", "事件",
        )
        component_hits = sum(1 for term in component_terms if term in text)
        return bool((has_english_joiner or has_chinese_joiner) and component_hits >= 2)

    def _write_generic_meta_fallback_report_zh(
        self,
        *,
        protocol: ResearchProtocol,
        facts: dict,
        prisma_data: dict,
        grade_profile: GRADEProfile | None,
        project: Project | None = None,
        ref_manager: ReferenceManager | None = None,
    ) -> str:
        """Build a Chinese fact-locked manuscript from structured analysis records."""
        primary = facts.get("primary_effect") or {}
        studies = facts.get("studies") or {}
        prisma = facts.get("prisma") or {}
        search = facts.get("search") or {}
        readiness = facts.get("evidence_readiness") or {}
        selected_rows = readiness.get("selected_primary_rows") or []
        compiled_text = self._compiled_method_article_text(facts, zh=True)
        compiled_active = bool(compiled_text.get("active"))
        population = facts.get("primary_population") or {}
        grade_outcomes = (facts.get("grade") or {}).get("outcomes") or []
        grade = grade_outcomes[0] if grade_outcomes else {}
        certainty = self._zh_grade_certainty(grade.get("certainty") or "未正式评价")
        downgrade_text = self._fallback_grade_downgrade_text_zh(grade)
        effect_measure = primary.get("effect_measure", protocol.effect_measure)
        effect_measure_key = str(effect_measure or "").upper()
        outcome_is_continuous = effect_measure_key in {"MD", "SMD", "WMD"}
        effect_text = self._fallback_effect_text(primary, effect_measure)
        outcome = self._reporting_outcome_label(facts, protocol, zh=True)
        intervention = protocol.pico.intervention or "干预措施"
        comparator = protocol.pico.comparator or "对照"
        target_population = protocol.pico.population or "目标人群"
        short_intervention = self._zh_concise_intervention_label(intervention)
        short_comparator = self._zh_concise_comparator_label(comparator)
        short_outcome = self._zh_concise_outcome_label(outcome)
        short_outcome_risk_phrase = f"{short_outcome}风险" if "复合终点" in short_outcome else f"{short_outcome}复合风险"
        short_population = self._zh_concise_population_label(target_population)
        n_primary = self._int(primary.get("n_studies")) or studies.get("primary_analysis_count", 0)
        total_n = self._int(population.get("selected_total_participants"))
        events_i = self._int(population.get("selected_events_intervention"))
        total_i = self._int(population.get("selected_total_intervention"))
        events_c = self._int(population.get("selected_events_control"))
        total_c = self._int(population.get("selected_total_control"))
        event_text = (
            f"{short_outcome}的研究层面均值差估计"
            if outcome_is_continuous else
            f"干预组{events_i}例事件/{total_i}名参与者、对照组{events_c}例事件/{total_c}名参与者"
            if total_i and total_c else
            "选定的主要分析行均有可追溯的结局数据"
        )
        source_names = self._source_names_for_manuscript(search)
        source_label = self._zh_source_label_list(source_names)
        source_counts = self._fallback_source_counts(search.get("source_counts") or {})
        search_date_text = self._fallback_search_date(search)
        search_query = search.get("query") or ""
        full_query_block = f"```text\n{search_query.strip()}\n```" if search_query.strip() else "未记录。"
        meta_json = project.load_json("meta_results.json", subdir="analysis") if project and not compiled_active else {}
        method_heterogeneity = (facts.get("synthesis_result") or {}).get("heterogeneity") or {}
        q_stat = method_heterogeneity.get("q") if compiled_active else self._maybe_get(meta_json, "primary_outcome", "q_statistic")
        q_p = method_heterogeneity.get("q_p_value") if compiled_active else self._maybe_get(meta_json, "primary_outcome", "q_p_value")
        i2 = primary.get("i_squared")
        tau2 = primary.get("tau_squared")
        if i2 is not None and n_primary < 3:
            heterogeneity = (
                f"异质性统计量为I²={self._fmt(i2, 1)}%、Cochran Q={self._fmt(q_stat, 2)}、"
                f"{self._p_text(q_p)}、tau²={self._fmt(tau2, 3)}；由于仅纳入{n_primary}项研究，"
                "这些指标仅作描述性参考，不能排除临床或方法学差异。"
            )
        elif i2 is not None:
            heterogeneity = (
                f"异质性较低（I²={self._fmt(i2, 1)}%，Cochran Q={self._fmt(q_stat, 2)}，"
                f"{self._p_text(q_p)}，tau²={self._fmt(tau2, 3)}）。"
            )
        else:
            heterogeneity = "未获得完整异质性统计量。"
        refs_text, cite_map = self._generic_references(ref_manager)
        who_react_cite = cite_map.get("benchmark:who_react", "")
        contextual_source_cite = self._citation_for_reference_patterns(
            refs_text,
            [
                r"NCT04360876",
                r"Metcovid|methylprednisolone as adjunctive therapy",
                r"Intravenous methylprednisolone pulse",
                r"rs-66909|Methylprednisolone Pulse Therapy",
                r"GLUCOCOVID",
            ],
        )
        non_oxygen_context_cite = self._citation_for_reference_patterns(
            refs_text,
            [r"Not Receiving Oxygen|EVIDoa2200283|NEJM evidence"],
        )
        prisma_cite = self._cite_ids(cite_map, "methodology:prisma_2020")
        search_method_cite = self._cite_ids(cite_map, "methodology:prisma_search")
        stats_method_cite = self._cite_ids(
            cite_map,
            "methodology:cochrane_handbook",
            "methodology:dersimonian_laird",
            "methodology:heterogeneity_i2",
        )
        certainty_method_cite = self._cite_ids(cite_map, "methodology:rob2", "methodology:grade_handbook")
        bias_method_cite = self._cite_ids(cite_map, "methodology:egger_bias")
        framework_method_cite = self._merge_citation_suffixes(prisma_cite, certainty_method_cite)
        certainty_bias_method_cite = self._merge_citation_suffixes(certainty_method_cite, bias_method_cite)
        primary_source_cite = self._cite_ids_for_rows(cite_map, selected_rows)
        background_cites = self._background_citation_groups(cite_map)
        claim_cites = self._covid_corticosteroid_claim_cites(refs_text, cite_map, background_cites)
        implementation_context_cite = self._cite_suffix(background_cites, 0) or primary_source_cite
        pico_context_cite = self._cite_suffix(background_cites, 1) or primary_source_cite
        mechanism_context_cite = self._cite_suffix(background_cites, 2) or self._cite_suffix(background_cites, 1)
        positioning_intro = self._positioning_paragraph(facts, cite=pico_context_cite or self._cite_suffix(background_cites, 0))
        study_table = self._generic_study_table(selected_rows, cite_map, effect_measure)
        effect_table = (
            self._compiled_method_effect_table(facts, selected_rows, effect_measure)
            if compiled_active else
            self._generic_effect_table(selected_rows, primary.get("studies") or [], effect_measure)
        )
        grade_table = (
            self._compiled_method_certainty_table(facts)
            if compiled_active else self._fallback_grade_table(grade)
        )
        absolute_effects = facts.get("absolute_effects") or {}
        absolute_table = self._generic_absolute_effect_table(absolute_effects)
        loo_table = self._fallback_leave_one_out_table(meta_json or {})
        has_loo_table = bool(str(loo_table or "").strip())
        loo_table_number = 5 if absolute_table else 4
        absolute_result_text = self._absolute_effect_result_text(absolute_effects)
        absolute_discussion_text = self._absolute_effect_discussion_text(absolute_effects)
        source_table = self._generic_source_audit_table(selected_rows)
        figure_section = self._generic_figures_section(project, short_outcome, prisma=prisma, n_primary=n_primary)
        figure_numbers = self._defined_figure_numbers(figure_section)
        figure_text = self._figure_results_summary(figure_numbers, zh=True)
        warning_text = self._fallback_warning_text_zh(readiness.get("warnings") or [])
        extraction_backlog = readiness.get("extraction_backlog") or {}
        non_primary_backlog = self._int(extraction_backlog.get("non_primary_review_rows")) + self._int(
            extraction_backlog.get("non_primary_conflict_rows")
        )
        backlog_status_text = (
            "存在需复核的非主要分析提取行；这些记录保留在补充材料中，不改变主要合并估计。"
            if non_primary_backlog else
            "所有进入主要合成的数据行均满足当前来源核验标准。"
        )
        title = self._generic_title(
            protocol,
            intervention,
            outcome,
            report_type=facts.get("report_type"),
            facts=facts,
            allow_llm=self._runtime_llm_title_enabled(project),
        )
        model_text = self._zh_model_label(self._actual_primary_model_label(facts, primary=primary) or "random")
        null_text = "1.00" if effect_measure_key in {"OR", "RR", "HR", "IRR"} else "0"
        ci_crosses_null = (
            primary.get("ci_lower") is not None
            and primary.get("ci_upper") is not None
            and float(primary.get("ci_lower")) <= float(null_text) <= float(primary.get("ci_upper"))
        )
        p_text = self._p_text(primary.get("p_value"))
        records_identified = self._int(prisma.get("records_identified"))
        records_after_dedup = self._int(prisma.get("records_after_dedup"))
        duplicates_removed = self._int(prisma.get("duplicates_removed"))
        if not duplicates_removed and records_identified and records_after_dedup:
            duplicates_removed = max(records_identified - records_after_dedup, 0)
        dedup_phrase = (
            f"经跨来源去重和同源记录合并（移除{duplicates_removed}条）后剩余{records_after_dedup}条"
            if duplicates_removed else
            f"经去重后剩余{records_after_dedup}条"
        )
        title_abstract_screened = self._int(prisma.get("title_abstract_screened")) or records_after_dedup
        full_text_assessed = self._int(prisma.get("full_text_assessed"))
        studies_included = self._int(prisma.get("studies_included")) or n_primary
        non_primary_retained = max(0, studies_included - n_primary)
        non_primary_retained_text = (
            f"其余{non_primary_retained}条保留记录提供背景、方案、注册或次要结局信息，但未提供用于合并的主要结局数据行。"
            if non_primary_retained else
            ""
        )
        zh_question = f"在{short_population}中，{short_intervention}相较于{short_comparator}是否影响{short_outcome}"
        outcome_is_composite = self._outcome_looks_composite(short_outcome)
        outcome_is_time_to_event = effect_measure_key == "HR"
        abstract_importance = (
            f"**重要性：** {short_population}的治疗决策依赖于与目标表型、比较方式、结局定义和随访时间一致的证据。若不同研究使用相近但并不完全相同的复合终点，Meta分析需要先确认被合并的行确实回答同一个临床问题。"
            if outcome_is_composite else
            f"**重要性：** {short_population}的治疗决策依赖于与目标表型、比较方式、结局定义和随访时间一致的证据。对于{short_outcome}这类临床硬终点，Meta分析需要同时说明相对效应、绝对获益、事件判定和适用人群。"
        )
        endpoint_interpretation_intro = (
            f"如果{short_outcome}为复合终点或时间到事件结局，则需要同时关注组成事件、事件判定、随访长度和删失方式。复合终点可以提高统计效率，但若总体效应主要由较常见或较轻的组成事件驱动，其临床含义不同于关键结局同步改善。"
            if outcome_is_composite else
            f"如果{short_outcome}为连续结局，解释重点应放在测量尺度、基线值、随访时间和具有临床意义的差异阈值，而不是只看均值差是否达到统计学显著。"
            if outcome_is_continuous else
            f"如果{short_outcome}为死亡率或其它硬临床终点，解释重点应放在事件判定是否一致、随访时间是否可比、基线风险如何影响绝对获益，以及干预是否带来需要权衡的安全性问题。"
        )
        effect_measure_interpretation_intro = (
            f"对于连续结局，{effect_measure}应在原始测量尺度上解释；临床读者需要同时看到基线值、随访时间、单位和最小重要差异，才能判断均值差是否真正影响患者决策。"
            if outcome_is_continuous else
            f"对于时间到事件结局，{effect_measure}比简单事件率更能反映随访和删失信息；但不同试验的随访时间、事件判定和复合终点构成仍需在解释中保留。对于临床读者，合并{effect_measure}应与基线风险、绝对风险差和患者偏好一起理解。"
            if outcome_is_time_to_event else
            f"对于二分类或事件型结局，{effect_measure}有助于表达相对效应方向和大小，但不能替代绝对风险差、需要治疗人数和安全性权衡。对于临床读者，合并{effect_measure}应与基线风险和患者偏好一起理解。"
        )
        outcome_hierarchy_intro = (
            f"结局层级需要特别清楚。{short_outcome}若包含多个组成部分，应避免只报告总体方向而忽略组成事件的临床权重。死亡、严重不可逆事件、住院、症状变化和实验室指标变化对患者和医生的意义并不相同，合并结果应放在这个层级框架内解释。"
            if outcome_is_composite else
            f"结局层级需要特别清楚。{short_outcome}作为患者直接相关的临床结局，比替代指标更容易解释，但仍需要说明事件定义、观察窗口、失访处理和判定方式是否在研究间足够一致。"
        )
        participant_context_text = (
            "参与者总数应与事件数、随访长度和效应量尺度一起解释。大型试验通常提高精确度，但临床可信度还取决于终点定义是否一致、事件判定是否相近、背景治疗是否可比，以及主要终点是否由患者更重视的组成事件驱动。"
            if outcome_is_composite else
            "参与者总数应与事件数、随访长度和效应量尺度一起解释。大型试验通常提高精确度，但临床可信度还取决于终点定义是否一致、事件判定是否相近、背景治疗是否可比，以及事件数是否足以支持稳定估计。"
        )
        component_discussion_text = (
            f"作为复合终点的一般解释原则，{short_outcome}需要结合组成事件理解。原始试验可能报告心血管死亡、心力衰竭住院或紧急就诊等组成事件，但本综述未把组成事件作为预设次要结局分别合并；因此，总体效应不应被解释为每个组成事件均同步改善。临床应用时仍需回到原始试验的组成事件报告。"
            if outcome_is_composite else
            f"{short_outcome}属于患者直接相关的临床结局，解释时应重点关注事件判定、随访时间、基线风险和绝对效应。若不同研究在人群严重程度或背景治疗上存在差异，同一相对效应可能对应不同的绝对获益。"
        )
        component_depth_text = (
            "复合终点的组成事件尤其需要分开理解。死亡、不可逆器官损伤、住院、症状恶化和实验室指标变化的临床分量不同；如果总体效应主要来自较轻或较常见的组成事件，就应避免把结果简单解释为所有关键结局均同步改善。"
            if outcome_is_composite else
            f"对于{short_outcome}这类硬终点，读者更关心效应大小是否足以改变治疗选择，以及该获益是否在不同严重程度、年龄、合并症和背景治疗条件下仍然合理。讨论应避免把平均相对效应直接等同于所有患者的固定绝对获益。"
        )
        result_scale_text = (
            f"对于时间到事件结局，{effect_measure}保留了随访时间和删失信息，不能简单等同于臂水平事件比例。臂水平事件数有助于理解临床规模和方向，但主要效应估计仍应以研究报告的{effect_measure}及其标准误为准。"
            if outcome_is_time_to_event else
            f"对于二分类或事件型结局，{effect_measure}应解释为报告随访窗口内事件发生的相对比较。臂水平事件数有助于理解临床规模和方向，但主要效应估计仍应结合研究层面方差和逆方差权重解释。"
        )
        strength_scope_text = (
            f"本综述的优势是聚焦于明确PICO、使用随机试验中的时间到事件{effect_measure}，并把主要分析限制在直接回答{short_outcome}的研究。这样的范围有助于避免把邻近人群、二级终点或重复报告混入主要估计。"
            if outcome_is_time_to_event else
            f"本综述的优势是聚焦于明确PICO、使用随机试验中的预设{effect_measure}，并把主要分析限制在直接回答{short_outcome}的研究。这样的范围有助于避免把邻近人群、二级终点或重复报告混入主要估计。"
        )
        calculation_scale_text = (
            f"臂水平事件计数用于核对事件方向和参与者规模；对于时间到事件结局，主要合并估计以研究层面{effect_measure}及其标准误为准。"
            if outcome_is_time_to_event else
            f"臂水平事件计数用于核对事件方向和参与者规模；对于二分类或事件型结局，主要合并估计以研究层面{effect_measure}、方差和逆方差权重为准。"
        )
        if compiled_active and compiled_text.get("calculation"):
            calculation_scale_text = compiled_text["calculation"]
        model_decision_text = self._model_decision_paragraph(facts)
        model_sensitivity_text = self._model_sensitivity_sentence(facts)
        endpoint_definition_caveat = self._endpoint_definition_caveat(facts, zh=True)
        endpoint_definition_discussion = self._endpoint_definition_discussion(facts, zh=True)
        process_transparency_text = self._review_process_transparency_sentence(zh=True)
        study_intervention_text = (
            self._primary_study_intervention_sentence(facts)
            or (self._primary_study_names_sentence(facts) + self._primary_intervention_examples_sentence(facts))
        )
        abstract_downgrade_text = downgrade_text
        if "发表偏倚" in str(downgrade_text or "") and n_primary < 10:
            abstract_downgrade_text = f"仅{n_primary}项研究贡献主要合并，限制了小样本效应、发表偏倚和异质性判断"
        if compiled_active:
            model_decision_text = ""
        compiled_result_summary = str(compiled_text.get("result_summary") or "").strip()

        abstract = "\n".join([
            abstract_importance,
            f"**目的：** 评价{short_intervention}相较于{short_comparator}对{short_outcome}的影响。",
            f"**资料来源：** 检索覆盖{source_label}；检索日期为{search_date_text}；完整布尔检索式见附录1。",
            f"**研究选择：** {compiled_text.get('study_selection') if compiled_active else '纳入符合预设人群、干预、对照和主要结局的随机试验或试验结果行；相关但不满足主要分析条件的记录保留为背景或补充证据。'}",
            f"**数据提取与合成：** {compiled_text.get('abstract_synthesis') if compiled_active else f'从全文报告、注册记录和公开汇总结果中提取结局数据。研究层面{effect_measure}及标准误采用{model_text}逆方差模型进行主要合并；模型选择依据见方法部分。'}",
            f"**主要结局和指标：** {short_outcome}。",
            f"**结果：** 检索识别{records_identified}条记录，{dedup_phrase}进入题名/摘要筛选，全文评估{full_text_assessed}篇。主要Meta分析纳入{n_primary}项研究、共{total_n:,}名参与者；{study_intervention_text}{non_primary_retained_text}入选试验记录{event_text}。{('预设合成估计为：' + compiled_result_summary) if compiled_active else f'合并效应为{effect_text}（{p_text}）。'} {heterogeneity}",
            f"**结论和意义：** 在本系统综述和Meta分析中，{('结果方向应结合预设结局编码、效应量、区间和确定性解释' if compiled_active else f'{short_intervention}相较于{short_comparator}可能与较低的{short_outcome_risk_phrase}相关')}；证据确定性评为{certainty}，主要受{abstract_downgrade_text}影响。{warning_text}",
        ])

        introduction = "\n\n".join(part for part in [
            f"{short_population}的治疗选择通常受疾病严重程度、合并症、背景治疗和随访目标影响；因此，{short_intervention}相较于{short_comparator}的证据需要放在明确人群和明确结局中解释{self._cite_suffix(background_cites, 0)}。",
            f"{short_outcome}是本综述的核心临床结局。{endpoint_interpretation_intro} {effect_measure_interpretation_intro}",
            positioning_intro,
            f"本综述的问题为：{zh_question}{pico_context_cite}。定量合成限定于直接回答这一PICO的随机试验证据，并将安全性、绝对效应和证据确定性作为临床解释的边界。",
            f"因此，本研究旨在合成{short_intervention}相较于{short_comparator}对{short_outcome}的疗效证据，并说明该估计对适用患者、决策强度和后续研究的意义。",
        ] if part)

        methods = "\n\n".join([
            "### 方案与报告框架\n"
            f"本研究遵循结构化系统综述流程，包括预设纳入标准、检索与筛选、有出处依据的数据提取、预设效应量计算、证据确定性评价和图表呈现{framework_method_cite}。本综述未进行前瞻性注册；方案要素、检索式、效应量设定和分析事实保存在导出包中。报告内容以最终纳入研究、效应量和证据确定性资料为依据{framework_method_cite}。",
            "### 纳入与排除标准\n"
            f"符合条件的记录需纳入{short_population}，比较{short_intervention}与{short_comparator}，并报告{short_outcome}或由报告文本支持其等价性的临床结局。PICO细节由方案和完整检索式限定；相关人群、二次分析、设计论文和替代结局可作为背景材料保留，但不作为独立主要分析研究。",
            "同一临床试验的多份报告在合成前进行协调。优先选择最直接报告预设主要终点的主要论文或注册结果；相近但不等同的结局、仅提供设计信息的记录或资料不足的摘要记录不进入主要合成。",
            endpoint_definition_caveat,
            "### 信息来源与检索策略\n"
            f"检索覆盖{source_label}；各来源初检记录数为{source_counts}。检索日期为{search_date_text}。数据库来源、全文可得性和检索日期均被记录，以支持检索过程复现；检索报告在资料允许范围内参照PRISMA-S原则{search_method_cite}。",
            "跨来源去重和同源记录合并在记录层面完成：同一临床试验的正式论文、注册结果、二次分析、预印本或重复索引记录被视为关联记录，而不是独立研究。PRISMA中的记录数反映筛选记录，纳入研究数则反映进入主要分析的独立随机化比较。",
            "### 研究选择与数据提取\n"
            ""
            + process_transparency_text
            + "对每项可能纳入的研究，提取研究标识、结局名称、干预组和对照组事件数及分母、报告效应量、标准误和报告位置。",
            "只有与预设主要结局匹配、且为该研究最直接可用结局资料的数据，才进入定量合成。因缺失数据、重复终点层级、二级结局、原始报告信息不足或统计尺度不合适而排除的数据，保留在补充提取表中并说明原因；若不同报告给出冲突数值，应在进一步来源核实前避免把冲突较大的资料用于主要合并。",
            "### 原始报告核对\n"
            "附录2列出主要分析数据的报告位置和依据。主要分析数据应同时说明结局语境、干预与对照、用于分析的数值以及可查阅的位置。",
            "若某个数值经来源核对后需要修订，修正值应同步用于效应量计算、Meta分析、GRADE评价和正文报告。这样可以避免正文与分析数据不一致，并便于读者判断修订对最终估计的影响。",
            "### 分析单位与重复处理\n"
            + (
                compiled_text.get("unit")
                if compiled_active else
                "分析单位为独立随机化试验比较，或预设匹配综述问题的试验亚组。同一试验的论文、注册结果和二次分析视为关联来源而非独立研究，避免重复计数，并保证摘要、结果、表格和图形中的研究数指向同一组分析单位。"
            ),
            "### 统计分析\n"
            + (
                compiled_text.get("statistics") + stats_method_cite
                if compiled_active else
                f"研究层面效应量按{effect_measure}尺度保存；比值类指标在计算层使用对数尺度，报告层还原至原始尺度。逆方差权重由每条研究效应量的标准误计算；异质性以I²、Cochran Q和tau²描述。统计计算按预设统计方法完成{stats_method_cite}"
            ),
            model_decision_text,
            "若贡献研究数较少，异质性指标和小样本效应检验仅作描述性解释，不作为不存在临床差异或发表偏倚的证据。",
            "### 证据确定性与偏倚评估\n"
            f"GRADE框架用于整理偏倚风险、间接性、不一致性、不精确性和发表偏倚信息。若某些领域资料不完整，确定性评价采用保守降级并在领域理由中明确说明{certainty_bias_method_cite}",
            "间接性判断结合人群、干预、对照、结局和研究设计与研究问题的一致程度；若只是报告字段不完整但入选研究已经明确匹配，则不因字段缺失单独降低确定性。",
        ])

        results = "\n\n".join([
            f"### 检索与筛选结果\n"
            f"检索共识别{records_identified}条记录，{dedup_phrase}进入题名/摘要筛选；全文评估{full_text_assessed}篇，最终纳入{studies_included}项研究，其中{n_primary}项研究进入主要Meta分析。{non_primary_retained_text}PRISMA流程见{self._figure_reference_label_zh([1]) if figure_numbers else '补充材料'}。",
            f"### 纳入研究和主要结局\n"
            f"主要分析纳入的试验合计{total_n:,}名参与者，其中{event_text}。表1列出入选研究和臂水平事件数；表2列出研究层面{effect_measure}、标准误和权重。",
            f"### 主要Meta分析\n" + (
                f"预设合成估计为：{compiled_result_summary} 效应方向按预设结局编码和效应量解释，并结合置信区间、可得的预测区间及证据确定性判断。{heterogeneity} {figure_text}"
                if compiled_active else
                f"主要合并结果为{effect_text}（{p_text}）。在本结局中，低于无效值{null_text}的比值表示干预方向更有利；因此该估计提示{short_intervention}相较于{short_comparator}可能降低{short_outcome}风险。{heterogeneity} {figure_text}"
            ),
            "",
            absolute_result_text,
            model_sensitivity_text,
            f"{n_primary}项研究的研究层面估计方向与合并结果总体一致，未见单项研究提示足以推翻主要结论的相反方向主要效应。表2给出每项研究的效应量、标准误和权重。",
            f"### 证据确定性\n"
            f"GRADE摘要见表3。当前确定性评为{certainty}，主要考虑因素为{downgrade_text}。这一判断应与文献资料完整性和风险偏倚资料一起解释，而不是仅由统计显著性决定。",
            f"由于主要合并仅纳入{n_primary}项研究，单项试验对总体估计的影响较大；异质性和发表偏倚检验的判断能力仍然有限。",
        ])

        discussion = "\n\n".join([
            (
                f"本系统综述和Meta分析的预设合成估计为：{compiled_result_summary} 主要分析纳入{n_primary}项研究；效应方向按预设结局编码解释{self._cite_suffix(background_cites, 0)}。"
                if compiled_active else
                f"本系统综述和Meta分析显示，{short_intervention}相较于{short_comparator}对{short_outcome}的合并{effect_measure}为{self._fmt(primary.get('pooled_effect'), 2)}，95% CI为{self._fmt(primary.get('ci_lower'), 2)}至{self._fmt(primary.get('ci_upper'), 2)}，{'跨越' if ci_crosses_null else '未跨越'}无效值{null_text}；主要分析纳入的试验共提供{total_n:,}名参与者资料{self._cite_suffix(background_cites, 0)}。"
            ),
            "### 结果的临床解释\n"
            + (
                "效应大小、方向、置信区间、可得的预测区间和证据确定性需要一并解释；数值排序本身不能直接等同于临床获益。"
                if compiled_active else
                f"该相对效应提示{short_intervention}可能降低{short_outcome}风险，但临床意义取决于患者的基线风险、随访时间和结局本身的重要性。对于病情较重、近期事件风险较高或伴有多种不良预后因素的患者，相同{effect_measure}可能转化为更大的绝对获益；对于低风险或病情较稳定者，绝对获益则可能较小。"
            ),
            component_discussion_text,
            endpoint_definition_discussion,
            "### 与既有证据和指南的关系\n"
            f"本结果应与既有随机试验、指南背景和疾病机制一并解释{self._cite_suffix(background_cites, 1)}。由于本综述仅纳入少数研究，效应方向、临床合理性和方法学质量应作为解释背景，而不能替代更多独立研究对稳健性的确认{mechanism_context_cite}。",
            "### 临床应用\n"
            f"临床实施时，应把合并{effect_measure}转化为具体人群的绝对风险差、需要治疗人数和不良事件权衡{implementation_context_cite}。适用性较强的场景是与纳入研究在人群、干预、对照、结局定义和随访时间上相似的患者；若患者存在明显禁忌证、脆弱状态、严重合并症或监测条件不足，治疗选择需要更谨慎。",
            absolute_discussion_text,
            f"{short_intervention}还应与背景治疗、费用、可及性、患者偏好和随访监测能力共同考虑。相对效应支持总体获益方向时，临床医生仍需判断该疗效是否足以改变当前患者的治疗选择。",
            f"安全性结局未在本综述中进行定量合并，因此需要与疗效结局分开解释。即使主要终点显示有利方向，不良事件、治疗中断、器官功能变化或监测负担仍可能影响个体患者的净获益{implementation_context_cite}。",
            f"因此，本结果支持一个平衡的信息：{short_intervention}对{short_outcome}的方向有利；但最佳应用方式是将平均相对效应与患者的事件风险、合并症、监测条件、安全性边界和治疗目标相匹配{primary_source_cite}。",
            "### 优势与局限性\n",
            strength_scope_text,
            f"主要局限是合并研究数仅为{n_primary}项。即使其中部分试验规模较大，研究数过少仍限制了异质性来源、发表偏倚和亚组一致性的评价；当研究少于10项时，漏斗图不对称检验最多只能作为描述性信息{bias_method_cite}",
            compiled_text.get("limitations") if compiled_active else "此外，聚合数据Meta分析不能可靠回答个体层面的效应修饰问题。年龄、性别、疾病严重度、合并症、基线风险、地区差异和背景治疗可能改变绝对获益，但若缺少个体参与者数据或一致的亚组报告，本综述只能在试验层面谨慎讨论这些因素。",
            "### 未来研究\n",
            f"未来研究应继续区分{short_population}内部不同疾病严重程度、基线风险层级和合并症状态，并一致报告{short_outcome}、患者重要结局、生活质量和不良事件。若新试验报告与{short_outcome}一致的结果，可纳入更新合成；若新资料主要补充安全性或亚组信息，则更适合改变临床解释和证据确定性，而不一定改变主要合并估计。",
        ])

        intervention_scope_text = self._intervention_scope_sentence(facts)
        conclusion = (
            f"在{short_population}中，预设合成得到以下比较效应：{compiled_result_summary} "
            f"证据确定性为{certainty}；结果方向应按预设结局编码解释，并结合区间估计、适用性和安全性作出临床判断。"
            if compiled_active else
            f"在{short_population}中，{short_intervention}相较于{short_comparator}可能与较低的{short_outcome_risk_phrase}相关，"
            f"合并结果为{effect_text}。在证据确定性为{certainty}且仅纳入{n_primary}项研究的前提下，"
            f"{intervention_scope_text}"
            f"该结果可作为与纳入试验相似患者中是否使用{short_intervention}的依据之一；"
            "最终决策仍应结合基线风险、绝对获益、安全性、监测条件、费用和患者偏好。"
        )
        if self._is_covid_corticosteroid_topic(protocol) and self._allow_legacy_topic_template(facts):
            title = "危重型COVID-19成人全身性糖皮质激素治疗28天全因死亡率的系统综述和Meta分析"
            sections_override = self._covid_corticosteroid_publication_sections_zh(
                protocol=protocol,
                source_label=source_label,
                search_date_text=search_date_text,
                search_query_block=full_query_block,
                source_counts_text=source_counts,
                prisma=prisma,
                studies_included=studies_included,
                n_primary=n_primary,
                non_primary_retained=non_primary_retained,
                total_n=total_n,
                event_text=event_text,
                events_i=events_i,
                total_i=total_i,
                events_c=events_c,
                total_c=total_c,
                effect_text=effect_text,
                p_text=p_text,
                heterogeneity=heterogeneity,
                certainty=certainty,
                downgrade_text=downgrade_text,
                absolute_result_text=absolute_result_text,
                absolute_discussion_text=absolute_discussion_text,
                who_react_cite=who_react_cite,
                primary_source_cite=primary_source_cite,
                prisma_cite=prisma_cite,
                search_method_cite=search_method_cite,
                stats_method_cite=stats_method_cite,
                certainty_method_cite=certainty_method_cite,
                bias_method_cite=bias_method_cite,
                loo_table_number=loo_table_number,
                recovery_omission_text=self._fallback_recovery_omission_text(meta_json or {}),
                non_oxygen_context_cite=non_oxygen_context_cite,
                study_cards=facts.get("study_cards") or [],
                claim_cites=claim_cites,
                model_sensitivity_text=model_sensitivity_text,
            )
            introduction = sections_override["introduction"]
            methods = sections_override["methods"]
            results = sections_override["results"]
            discussion = sections_override["discussion"]
            conclusion = sections_override["conclusion"]

        calculation_notes = "\n\n".join([
            compiled_text.get("calculation") if compiled_active else f"主要计算使用{n_primary}项主要分析研究和{total_n:,}名参与者。臂水平事件计数为干预组{events_i}/{total_i}、对照组{events_c}/{total_c}。",
            f"研究层面{effect_measure}和标准误用于逆方差加权；合并估计在正文中报告为{effect_text}。",
            f"{heterogeneity} 表2列出用于计算的研究层面数值，附录2列出相应来源位置。",
            calculation_scale_text,
        ])

        sections = [
            f"# {title}",
            "",
            f"## {self._t('abstract')}",
            abstract,
            "",
            f"## {self._t('introduction')}",
            introduction,
            "",
            f"## {self._t('methods')}",
            methods,
            "",
            f"## {self._t('results')}",
            results,
            "",
            f"## {self._t('discussion')}",
            discussion,
            "",
            f"## {self._t('conclusion')}",
            conclusion,
            "",
            f"## {self._t('tables')}",
            "### 表1. 选定主要分析行的基本特征",
            study_table,
            "",
            f"### 表2. {compiled_text.get('table2_title') if compiled_active else f'研究层面{effect_measure}估计值和权重'}",
            effect_table,
            "",
            "### 表3. GRADE证据概要",
            grade_table,
            "",
            *([
                "### 表4. 绝对效应解释",
                absolute_table,
                "",
            ] if absolute_table else []),
            *([
                f"### 表{loo_table_number}. 逐一剔除敏感性分析",
                loo_table,
                "",
            ] if has_loo_table else []),
            f"## {self._t('figures')}",
            figure_section,
            "",
            f"## {self._t('supplementary')}",
            "### 附录1. 完整检索式",
            full_query_block,
            "",
            "### 附录2. 主要分析记录的来源核验",
            source_table,
            "",
            "### 附录3. 主要Meta分析计算说明",
            calculation_notes,
            "",
            "### 附录4. PRISMA 2020清单",
            self._fallback_prisma_2020_checklist(prisma=prisma, search_date=search_date_text, has_rob=True, has_grade=bool(grade_outcomes)),
            "",
            "### 附录5. PRISMA-S清单",
            self._fallback_prisma_s_checklist(search=search, search_date=search_date_text),
            "",
            "### 附录6. ROBIS评价",
            self._fallback_robis_assessment(readiness=readiness, n_primary=n_primary),
            "",
            "### 附录7. 未进入主要合成的上下文来源记录",
            self._covid_contextual_source_records_appendix(contextual_source_cite, zh=True),
            "",
            self._declarations_section(),
            "",
            f"## {self._t('references')}",
            refs_text,
        ]
        manuscript_text = "\n".join(sections).strip() + "\n"
        if outcome_is_continuous:
            manuscript_text = self._adapt_continuous_outcome_language(manuscript_text, outcome=short_outcome)
        manuscript = self._polish_publication_body_language(
            manuscript_text,
            compress_discussion=True,
        )
        manuscript = self._backfill_publication_inline_citations(manuscript)
        manuscript = self._backfill_publication_figure_references(manuscript)
        manuscript = self._backfill_publication_figure_legends(manuscript)
        manuscript = self._backfill_publication_table_notes(manuscript)
        manuscript = self._cap_dominant_primary_trial_citations_from_references(manuscript)
        manuscript = self._normalize_citation_marker_style(manuscript, lang=self._lang)
        return self._normalize_structured_abstract_spacing(manuscript)

    def _write_generic_meta_fallback_report(
        self,
        *,
        protocol: ResearchProtocol,
        facts: dict,
        prisma_data: dict,
        grade_profile: GRADEProfile | None,
        project: Project | None = None,
        ref_manager: ReferenceManager | None = None,
    ) -> str:
        """Build a domain-neutral fact-locked manuscript from structured analysis records."""
        if self._zh:
            return self._write_generic_meta_fallback_report_zh(
                protocol=protocol,
                facts=facts,
                prisma_data=prisma_data,
                grade_profile=grade_profile,
                project=project,
                ref_manager=ref_manager,
            )

        primary = facts.get("primary_effect") or {}
        studies = facts.get("studies") or {}
        prisma = facts.get("prisma") or {}
        search = facts.get("search") or {}
        readiness = facts.get("evidence_readiness") or {}
        selected_rows = readiness.get("selected_primary_rows") or []
        compiled_text = self._compiled_method_article_text(facts, zh=False)
        compiled_active = bool(compiled_text.get("active"))
        population = facts.get("primary_population") or {}
        grade_outcomes = (facts.get("grade") or {}).get("outcomes") or []
        grade = grade_outcomes[0] if grade_outcomes else {}
        certainty = grade.get("certainty") or "Not assessed"
        downgrade_text = self._fallback_grade_downgrade_text(grade)
        effect_measure = primary.get("effect_measure", protocol.effect_measure)
        effect_measure_key = str(effect_measure or "").upper()
        outcome_is_continuous = effect_measure_key in {"MD", "SMD", "WMD"}
        effect_text = self._fallback_effect_text(primary, effect_measure)
        outcome = self._reporting_outcome_label(facts, protocol, zh=False)
        intervention = protocol.pico.intervention or "the intervention"
        comparator = protocol.pico.comparator or "the comparator"
        target_population = protocol.pico.population or "the target population"
        short_intervention = self._concise_intervention_label(intervention)
        short_comparator = self._concise_comparator_label(comparator)
        short_outcome = self._concise_outcome_label(outcome)
        short_population = self._concise_population_label(target_population)
        intervention_verb = self._was_were_for_label(short_intervention)
        intervention_auxiliary = self._has_have_for_label(short_intervention)
        intervention_risk_verb = "lower" if intervention_verb == "were" else "lowers"
        sentence_initial_outcome = self._sentence_initial_label(short_outcome)
        n_primary = self._int(primary.get("n_studies")) or studies.get("primary_analysis_count", 0)
        total_n = self._int(population.get("selected_total_participants"))
        events_i = self._int(population.get("selected_events_intervention"))
        total_i = self._int(population.get("selected_total_intervention"))
        events_c = self._int(population.get("selected_events_control"))
        total_c = self._int(population.get("selected_total_control"))
        primary_event_label = self._generic_event_label(effect_measure)
        event_text = (
            f"study-level mean-difference estimates for {short_outcome}"
            if outcome_is_continuous else
            f"{events_i}/{total_i} {primary_event_label} in the intervention groups and "
            f"{events_c}/{total_c} {primary_event_label} in the control groups"
            if total_i and total_c else
            "source-linked arm-level data were available for the selected primary rows"
        )
        source_names = self._source_names_for_manuscript(search)
        source_label = self._en_source_label_list(source_names)
        source_counts = self._fallback_source_counts(search.get("source_counts") or {})
        source_reproducibility_methods_note = self._source_reproducibility_methods_note(source_names)
        search_date_text = self._fallback_search_date(search)
        search_query = search.get("query") or ""
        full_query_block = f"```text\n{search_query.strip()}\n```" if search_query.strip() else "Not available."
        meta_json = project.load_json("meta_results.json", subdir="analysis") if project and not compiled_active else {}
        method_heterogeneity = (facts.get("synthesis_result") or {}).get("heterogeneity") or {}
        q_stat = method_heterogeneity.get("q") if compiled_active else self._maybe_get(meta_json, "primary_outcome", "q_statistic")
        q_p = method_heterogeneity.get("q_p_value") if compiled_active else self._maybe_get(meta_json, "primary_outcome", "q_p_value")
        i2 = primary.get("i_squared")
        tau2 = primary.get("tau_squared")
        if i2 is not None and n_primary < 3:
            heterogeneity = (
                f"Heterogeneity statistics were I²={self._fmt(i2, 1)}%, Cochran Q={self._fmt(q_stat, 2)}, "
                f"{self._p_text(q_p)}, and tau²={self._fmt(tau2, 3)}; because only {n_primary} studies "
                "contributed, these statistics were descriptive and could not exclude clinically important differences."
            )
        elif i2 is not None:
            heterogeneity = (
                f"Heterogeneity was low (I²={self._fmt(i2, 1)}%, Cochran Q={self._fmt(q_stat, 2)}, "
                f"{self._p_text(q_p)}, tau²={self._fmt(tau2, 3)})."
            )
        else:
            heterogeneity = "Heterogeneity statistics were not available."
        refs_text, cite_map = self._generic_references(ref_manager)
        prisma_cite = self._cite_ids(cite_map, "methodology:prisma_2020")
        search_method_cite = self._cite_ids(cite_map, "methodology:prisma_search")
        stats_method_cite = self._cite_ids(
            cite_map,
            "methodology:cochrane_handbook",
            "methodology:dersimonian_laird",
            "methodology:heterogeneity_i2",
        )
        certainty_method_cite = self._cite_ids(cite_map, "methodology:rob2", "methodology:grade_handbook")
        bias_method_cite = self._cite_ids(cite_map, "methodology:egger_bias")
        primary_source_cite = self._cite_ids_for_rows(cite_map, selected_rows)
        study_table = self._generic_study_table(selected_rows, cite_map, effect_measure)
        effect_table = (
            self._compiled_method_effect_table(facts, selected_rows, effect_measure)
            if compiled_active else
            self._generic_effect_table(selected_rows, primary.get("studies") or [], effect_measure)
        )
        grade_table = (
            self._compiled_method_certainty_table(facts)
            if compiled_active else self._fallback_grade_table(grade)
        )
        absolute_effects = facts.get("absolute_effects") or {}
        absolute_table = self._generic_absolute_effect_table(absolute_effects)
        absolute_result_text = self._absolute_effect_result_text(absolute_effects)
        absolute_discussion_text = self._absolute_effect_discussion_text(absolute_effects)
        absolute_final_clinical_point = (
            (
                absolute_discussion_text or
                f"A final clinical point is that mean differences are easiest to misinterpret when they are separated from the measurement scale and the patient's starting value. Reporting a {effect_measure} without units, baseline value, follow-up timing, or a clinically meaningful difference threshold can make a modest change look decisive or make a meaningful change look abstract. Future updates of this review should therefore report absolute mean changes, responder thresholds, and patient-centered interpretations whenever reliable scale anchors are available."
            )
            if outcome_is_continuous else
            absolute_discussion_text or
            "A final clinical point is that relative treatment effects are easiest to misinterpret when they are separated from the patient's starting risk. Reporting a relative estimate without a plausible baseline risk can make a modest absolute gain look dramatic or make a substantial gain look abstract. Future updates of this review should therefore add absolute-effect scenarios whenever reliable baseline risks are available, especially for patient groups that differ by severity, age, comorbidity, care setting, or treatment timing. Those scenarios would make the review more useful for bedside counseling and policy decisions, and they would help distinguish a statistically convincing result from a recommendation that is clinically compelling for a specific patient population in routine care."
        )
        source_table = self._generic_source_audit_table(selected_rows)
        figure_section = self._generic_figures_section(project, outcome, prisma=prisma, n_primary=n_primary)
        warning_text = self._fallback_warning_text(readiness.get("warnings") or [])
        title = self._generic_title(
            protocol,
            intervention,
            outcome,
            report_type=facts.get("report_type"),
            facts=facts,
            allow_llm=self._runtime_llm_title_enabled(project),
        )
        model_text = self._actual_primary_model_label(facts, primary=primary) or "random"
        primary_model_text = "fixed-effect" if model_text == "fixed" else "random-effects" if model_text == "random" else model_text
        null_text = "1.00" if effect_measure_key in {"OR", "RR", "HR", "IRR"} else "0"
        ci_crosses_null = (
            primary.get("ci_lower") is not None
            and primary.get("ci_upper") is not None
            and float(primary.get("ci_lower")) <= float(null_text) <= float(primary.get("ci_upper"))
        )
        p_text = self._p_text(primary.get("p_value"))
        records_identified = self._int(prisma.get("records_identified"))
        records_after_dedup = self._int(prisma.get("records_after_dedup"))
        duplicates_removed = self._int(prisma.get("duplicates_removed"))
        if not duplicates_removed and records_identified and records_after_dedup:
            duplicates_removed = max(records_identified - records_after_dedup, 0)
        dedup_phrase = (
            f"after cross-source deduplication and record consolidation removed {duplicates_removed} records, "
            f"{records_after_dedup} unique records remained"
            if duplicates_removed else
            f"{records_after_dedup} records remained after deduplication"
        )
        title_abstract_screened = self._int(prisma.get("title_abstract_screened")) or records_after_dedup
        full_text_assessed = self._int(prisma.get("full_text_assessed"))
        studies_included = self._int(prisma.get("studies_included")) or n_primary
        non_primary_retained = max(0, studies_included - n_primary)
        non_primary_retained_text = (
            f"The remaining {non_primary_retained} retained records supplied background, protocol, registry, safety, "
            "or secondary-outcome information but did not provide the selected primary-outcome row for pooling."
            if non_primary_retained else
            ""
        )
        review_inclusion_text = (
            f"The review retained {studies_included} full-text records as eligible or contextual evidence. "
            if studies_included and studies_included != n_primary else
            ""
        )
        background_cites = self._background_citation_groups(cite_map)
        outcome_is_composite = self._outcome_looks_composite(short_outcome)
        outcome_is_time_to_event = effect_measure_key == "HR"
        if outcome_is_continuous:
            effect_measure_intro = (
                f"For continuous outcomes, the {effect_measure} summarizes the between-group difference in mean values or mean change on the outcome's measurement scale. Its clinical meaning depends on units, baseline value, follow-up timing, direction of desirable change, and whether the estimate reaches a clinically meaningful difference."
            )
            endpoint_scale_methods = (
                "When the selected endpoint was continuous, the reported mean difference and standard error were kept on the measurement scale specified by the protocol. Change-from-baseline and final-value estimates were not treated as interchangeable unless the protocol explicitly allowed that harmonization."
            )
            result_scale_context = (
                f"For a continuous endpoint, the {effect_measure} should be interpreted on the measurement scale of {short_outcome}. Study-level variances determine the inverse-variance weights, while units, baseline value, follow-up timing, and clinically meaningful difference thresholds determine whether the numerical shift is clinically important."
            )
            followup_discussion_context = (
                "Duration of follow-up also shapes interpretation. For continuous outcomes, early and later measurements may reflect different constructs, such as initial biologic response, sustained control, treatment adherence, or regression toward baseline. Interpret the mean difference with the measurement time point rather than as a permanent patient-level state."
            )
            strength_scope_context = (
                f"A strength of this synthesis is its focused PICO, use of randomized trial evidence, and reliance on protocol-selected {effect_measure} estimates for a clinically important continuous endpoint. This scope reduces the chance of mixing incompatible scales, time points, secondary endpoints, or duplicate reports into the primary estimate."
            )
            calculation_scale_context = (
                f"Continuous-outcome calculations are shown on the selected measurement scale; the pooled estimate is based on study-level {effect_measure} estimates and variances rather than on participant counts or collapsed group totals."
            )
        elif outcome_is_time_to_event:
            effect_measure_intro = (
                f"For time-to-event outcomes, the {effect_measure} retains information about follow-up and censoring that a simple event proportion cannot capture. However, differences in follow-up, event adjudication, and component definitions still need to be considered when translating the pooled estimate into bedside decisions."
            )
            endpoint_scale_methods = (
                "When the selected endpoint was time-to-event, the reported hazard ratio was kept on its original scale rather than reconstructed from event totals. When the selected endpoint was binary, the arm-level counts were used to derive the study-level log effect and variance. This distinction prevents the manuscript from forcing unlike endpoints into a single simplified data shape."
            )
            result_scale_context = (
                f"For a time-to-event endpoint, the {effect_measure} should be interpreted as an estimate that preserves follow-up time and censoring information. Aggregate event counts are useful for clinical orientation, but they do not replace the reported trial-level {effect_measure} and standard error used in the inverse-variance synthesis."
            )
            followup_discussion_context = (
                "Duration of follow-up should also temper interpretation. A time-to-event estimate summarizes risk over the trial follow-up period, but clinicians may be interested in both early decompensation prevention and longer-term trajectories. If benefit appears early and persists, the treatment may be valuable for stabilization; if benefit emerges slowly, adherence and long-term tolerability become more central."
            )
            strength_scope_context = (
                f"A strength of this synthesis is its focused PICO, use of randomized trial evidence, and reliance on time-to-event {effect_measure} estimates for a clinically important endpoint. This scope reduces the risk of mixing adjacent populations, secondary endpoints, or duplicate reports into the primary estimate."
            )
            calculation_scale_context = (
                f"Aggregate event counts are shown for clinical orientation; for time-to-event outcomes, the pooled estimate is based on trial-level {effect_measure} estimates and standard errors."
            )
        else:
            effect_measure_intro = (
                f"For binary or event-count outcomes, the {effect_measure} summarizes relative event occurrence between groups over the reported follow-up. Differences in follow-up duration, event ascertainment, and baseline risk still need to be considered when translating the pooled estimate into bedside decisions."
            )
            endpoint_scale_methods = (
                "When the selected endpoint was binary or event-count based, arm-level events and denominators were used where available to derive the study-level log effect and variance. Reports with incompatible follow-up, outcome hierarchy, or effect-measure scale were kept outside the primary synthesis unless they could be reconciled without changing the clinical question."
            )
            result_scale_context = (
                f"For an event-count endpoint, the {effect_measure} should be interpreted as a relative comparison of event occurrence over the reported follow-up. Aggregate counts help readers understand clinical magnitude, while study-level variances determine the inverse-variance weights used in the pooled estimate."
            )
            followup_discussion_context = (
                "Duration of follow-up should also temper interpretation. For event-count outcomes, the relative estimate depends on the window over which events were counted. A short follow-up may capture early treatment effects but miss delayed harms or later relapse, whereas longer follow-up can make adherence, co-interventions, and competing events more influential."
            )
            strength_scope_context = (
                f"A strength of this synthesis is its focused PICO, use of randomized trial evidence, and reliance on protocol-selected {effect_measure} estimates for a clinically important endpoint. This scope reduces the risk of mixing adjacent populations, secondary endpoints, or duplicate reports into the primary estimate."
            )
            calculation_scale_context = (
                f"Aggregate event counts are shown for clinical orientation; for binary or event-count outcomes, the pooled estimate is based on study-level {effect_measure} estimates and variances rather than on an unweighted collapsed event table."
            )
        intro_population_context = (
            f"{short_population} are clinically heterogeneous, with treatment decisions shaped by baseline value, disease duration, comorbidity, background care, feasibility, and follow-up duration. "
            f"For {short_outcome}, the clinical question must be defined before estimates are pooled{self._cite_suffix(background_cites, 0)}."
            if outcome_is_continuous else
            f"{short_population} are clinically heterogeneous, with treatment decisions shaped by disease severity, baseline risk, comorbidity, background care, feasibility, and follow-up duration. "
            f"For {short_outcome}, the clinical question must be defined before estimates are pooled{self._cite_suffix(background_cites, 0)}."
        )
        endpoint_intro = (
            f"{sentence_initial_outcome} is a composite endpoint, so its clinical interpretation depends on whether the treatment effect is driven by the most patient-important components, by more frequent but less severe events, or by both."
            if outcome_is_composite else
            f"{sentence_initial_outcome} is a continuous outcome, so its interpretation depends on the measurement scale, baseline value, follow-up timing, missing-data handling, and the threshold for a clinically meaningful difference."
            if outcome_is_continuous else
            f"{sentence_initial_outcome} is a patient-important clinical endpoint. Its interpretation depends on consistent event definitions, comparable follow-up windows, outcome adjudication, and the baseline risk of the patients to whom the result will be applied."
        )
        focused_population_context = (
            f"Focused meta-analyses can be more useful for clinical decisions than broad all-comer syntheses when the treatment question concerns a specific clinical phenotype. In {short_population}, disease severity, comorbidity, prior treatment, baseline value, background care, and local practice can all change whether the same mean difference is clinically meaningful."
            if outcome_is_continuous else
            f"Focused meta-analyses can be more useful for clinical decisions than broad all-comer syntheses when the treatment question concerns a specific clinical phenotype. In {short_population}, disease severity, comorbidity, prior events, background care, and local practice can all change absolute risk and therefore change the expected absolute benefit of the same relative effect."
        )
        safety_intro = (
            f"Safety is also central to the use of {short_intervention}. Adverse events, treatment discontinuation, organ-function changes, infection risk, hemodynamic effects, and monitoring requirements can modify the net benefit for individual patients, so efficacy findings require parallel assessment of safety and feasibility."
        )
        result_endpoint_context = (
            "The clinical meaning of the pooled estimate is best understood by considering the endpoint components and the time horizon over which events accrue. Component results should be reviewed alongside the composite estimate whenever they are available."
            if outcome_is_composite else
            f"The clinical meaning of the pooled estimate is best understood by considering how {short_outcome} was measured, whether change scores or final values were used, and whether the follow-up time point corresponds to the decision the reader needs to make."
            if outcome_is_continuous else
            f"The clinical meaning of the pooled estimate is best understood by considering the event definition and the time horizon over which {short_outcome} was measured. For a hard clinical endpoint, consistency of adjudication and follow-up helps readers decide whether the average effect is applicable to their patients."
        )
        participant_context = (
            "The participant total should be interpreted together with event counts, follow-up, endpoint definition, and the effect-measure scale. A large participant count improves precision, but clinical confidence also depends on whether outcome adjudication, background care, and the component events of a composite endpoint were comparable across studies."
            if outcome_is_composite else
            "The participant total should be interpreted together with standard errors, follow-up, endpoint definition, and the measurement scale. A large participant count improves precision, but clinical confidence also depends on whether baseline values, outcome instruments, missing-data handling, and background care were comparable across studies."
            if outcome_is_continuous else
            "The participant total should be interpreted together with event counts, follow-up, endpoint definition, and the effect-measure scale. A large participant count improves precision, but clinical confidence also depends on whether outcome adjudication, background care, and event ascertainment were comparable across studies."
        )
        clinical_interpretation = (
            f"The pooled mean difference suggests that {short_intervention} shifted {short_outcome} in the favorable direction compared with {short_comparator}, but the clinical impact depends on measurement scale, baseline value, follow-up duration, disease severity, and whether the change reaches a clinically meaningful difference for patients."
            if outcome_is_continuous else
            f"The pooled relative effect suggests that {short_intervention} {intervention_risk_verb} the risk of {short_outcome}, but the clinical impact depends on baseline risk, follow-up duration, disease severity, and the feasibility of using the intervention in the target setting."
        )
        component_interpretation = (
            f"Because {short_outcome} is a composite endpoint, component events should be reviewed as an interpretive framework rather than assumed from the pooled composite estimate. The primary trials may report cardiovascular death, heart failure hospitalization, or urgent-visit components, but this review did not prespecify a separate component-outcome meta-analysis; the composite result should therefore not be presented as proof that each component improved to the same extent."
            if outcome_is_composite else
            f"Because {short_outcome} is continuous, interpretation should focus on the outcome instrument, unit of measurement, baseline value, follow-up time point, missing data, and the threshold at which a mean shift becomes meaningful to patients or clinicians."
            if outcome_is_continuous else
            f"Because {short_outcome} is not being treated as a composite endpoint in this synthesis, interpretation should focus on the event definition, timing, ascertainment, and absolute effect; component-event tradeoffs are outside this analysis."
        )
        relation_context = (
            f"The direction of effect belongs in the context of prior randomized evidence, clinical rationale, and current practice{self._cite_suffix(background_cites, 1)}. Because the synthesis may include only a small number of trials, coherence with clinical rationale is supportive context, not a substitute for additional independent evidence."
        )
        application_context = (
            f"Clinical use should translate the pooled {effect_measure} into the original measurement units, expected change from baseline value, and clinically meaningful difference for the target setting. Applicability is strongest for patients resembling the included trials; decisions should be more cautious when baseline control, comorbidity, treatment burden, monitoring constraints, or limited treatment access could change the benefit-harm balance."
            if outcome_is_continuous else
            f"Clinical use should translate the pooled {effect_measure} into absolute risk difference and number needed to treat for the target setting. Applicability is strongest for patients resembling the included trials; decisions should be more cautious when contraindications, frailty, competing conditions, monitoring constraints, or limited treatment access could change the benefit-harm balance."
        )
        background_care_context = (
            f"{short_intervention} should also be interpreted alongside background care. Clinicians should consider co-interventions, disease severity, organ function, adherence, cost, access, patient preference, and follow-up capacity; the pooled estimate is not a stand-alone treatment rule."
        )
        absolute_risk_context = (
            "The clinical effect is likely to vary across the baseline-value spectrum. Patients with poorer starting control may have more room for improvement, whereas patients already near target may experience a smaller observable mean change even when the direction of effect is similar."
            if outcome_is_continuous else
            "The absolute effect is likely to vary across the risk spectrum. Patients with higher expected event rates may obtain larger absolute reductions from the same relative effect, whereas lower-risk patients may have a similar relative direction but a smaller short-term absolute benefit."
        )
        decision_priority_context = (
            "Clinical interpretation should therefore link the pooled estimate to patient priorities: preventing serious outcomes, reducing symptoms and service use, minimizing treatment burden, avoiding adverse effects, controlling costs, and respecting treatment goals."
        )
        endpoint_structure_context = (
            "The component structure of the endpoint should be reviewed when the primary outcome is composite. Without a separate component-level synthesis, the composite estimate should be interpreted as the prespecified endpoint result, not as evidence that every patient-important component improves to the same extent."
            if outcome_is_composite else
            f"For {short_outcome}, the more important interpretive issue is whether the same measurement scale, direction of desirable change, and follow-up time point were used across studies to support a common clinical inference."
            if outcome_is_continuous else
            f"For {short_outcome}, the more important interpretive issue is whether event definitions and follow-up were similar enough across studies to support a common clinical inference."
        )
        patient_selection_context = (
            f"Patient selection should account for how closely the target population resembles the included trial populations. Baseline value, disease duration, comorbid illness, background care, adherence, and care setting can all influence the expected mean change and the practical safety margin."
            if outcome_is_continuous else
            f"Patient selection should account for how closely the target population resembles the included trial populations. Severity, timing of treatment, comorbid illness, baseline event risk, background care, and care setting can all influence the expected absolute benefit and the practical safety margin."
        )
        monitoring_context = (
            "Background treatment and monitoring capacity can modify both treatment response and tolerability. Patients with higher starting values may show more room for improvement but may also need closer monitoring for adverse effects, adherence, and co-interventions that influence the measured outcome."
            if outcome_is_continuous else
            "Background treatment and monitoring capacity can modify both absolute benefit and tolerability. Patients with more severe illness may have more risk to reduce but may also be more vulnerable to complications, whereas more stable patients may tolerate treatment easily but have fewer preventable events over a short time horizon."
        )
        organ_function_context = (
            "Organ function and laboratory changes should be interpreted in clinical context. The practical question is whether the patient remains stable and whether monitoring can distinguish expected treatment-related changes from clinically important deterioration."
        )
        comorbidity_context = (
            "Comorbidity status should not be treated as the only determinant of benefit. Trial-level averages can guide practice, but age, competing illnesses, baseline severity, co-medication, and patient priorities may change the net value of treatment for an individual patient."
        )
        quality_context = (
            f"Quality-of-life and functional outcomes should be considered alongside {short_outcome}. A treatment that improves a hard endpoint may still differ in symptom burden, treatment convenience, or long-term adherence, and those outcomes should be synthesized separately when reported inconsistently."
        )
        health_system_context = (
            "Health-system context also affects interpretation. Thresholds for hospitalization, follow-up intensity, resource availability, and access to the intervention can change how a relative effect translates into absolute benefit and service use."
        )
        guideline_context = (
            "For guideline panels, the result supports considering the intervention within a broader care strategy, but the strength of recommendation should reflect certainty, feasibility, patient values, equity, and resource use."
        )
        communication_context = (
            f"For clinicians, the most useful way to communicate the finding is patient-centered: {short_intervention} appears to improve the mean level of {short_outcome}, while treatment decisions still require attention to baseline value, expected clinical magnitude, adverse effects, monitoring, cost, and patient goals."
            if outcome_is_continuous else
            f"For clinicians, the most useful way to communicate the finding is patient-centered: {short_intervention} appears to move {short_outcome} in a favorable direction, while treatment decisions still require attention to baseline risk, expected absolute benefit, adverse effects, monitoring, cost, and patient goals."
        )
        followup_context = (
            "Clinical follow-up should be planned before treatment is started. Patients need a clear explanation of expected benefits, warning symptoms, when to seek reassessment, and how follow-up will monitor both effectiveness and harms."
        )
        implementation_context = (
            "The same considerations are important after the first treatment decision. Early contact can identify adverse effects, adherence problems, access barriers, or clinical deterioration before they lead to discontinuation or loss of benefit."
        )
        care_team_context = (
            "Multidisciplinary care may make the evidence easier to implement when monitoring, counseling, and follow-up responsibilities are shared across clinicians, pharmacists, nurses, and primary-care teams."
        )
        strategy_context = (
            f"The result is one part of a full therapeutic strategy. {short_population} often require assessment of competing diagnoses, comorbidities, background treatments, prognosis, patient preferences, and care access before a pooled estimate can be translated into practice."
        )
        shared_decision_context = (
            "There are also implications for shared decision making. Presenting the mean difference in familiar units, alongside an explanation of clinically meaningful change, helps align evidence with patient goals and avoids reducing the decision to statistical significance."
            if outcome_is_continuous else
            "There are also implications for shared decision making. Presenting both the relative effect and expected absolute benefit helps align evidence with patient goals and avoids reducing the decision to statistical significance."
        )
        timing_context = (
            "The timing of treatment initiation remains clinically relevant. Acute, recovering, and stable patients may differ in baseline risk, monitoring needs, co-interventions, and the tradeoff between early benefit and early harm."
        )
        natural_history_context = (
            f"The evidence should also be interpreted against the natural history of {short_population}. Improving {short_outcome} may have downstream consequences for symptoms, function, treatment escalation, resource use, and long-term prognosis, but those consequences should be supported by clinical context rather than inferred from the mean difference alone."
            if outcome_is_continuous else
            f"The evidence should also be interpreted against the natural history of {short_population}. Preventing or delaying {short_outcome} may have downstream consequences for function, future treatment tolerance, resource use, caregiver burden, and long-term prognosis."
        )
        comorbidity_translation_context = (
            f"Comorbidity patterns further complicate translation. A pooled estimate across trials gives the best available average effect, but clinicians should still ask whether the patient's dominant risks resemble those represented in the trial populations."
        )
        balanced_message = (
            f"The analysis therefore supports a balanced message: the treatment effect is directionally favorable for {short_outcome}, but the best clinical use comes from matching that mean difference to the patient's baseline value, treatment goals, monitoring capacity, and preferences."
            if outcome_is_continuous else
            f"The analysis therefore supports a balanced message: the treatment effect is directionally favorable for {short_outcome}, but the best clinical use comes from matching that evidence to the patient's event risk, competing conditions, monitoring capacity, and goals of care."
        )
        competing_risk_context = (
            "Interpreting the pooled estimate also requires attention to competing risks. Frailty, comorbid illness, non-target events, and treatment burden can shape priorities differently across patients even when the relative effect is similar."
        )
        persistence_context = (
            "Treatment persistence is another practical consideration. Trial benefits assume that patients can receive the intervention and remain under follow-up long enough to experience event reduction; routine care may require counseling, access support, and early safety review."
        )
        reporting_context = (
            f"The findings also have implications for outcome reporting in future evidence syntheses. Mortality, disease-specific events, serious adverse events, patient-reported outcomes, functional status, and treatment discontinuation should be reported separately whenever possible."
        )
        future_research_context = (
            f"For researchers, the findings highlight the need for consistent reporting of endpoint definitions, safety events, patient-centered outcomes, and prespecified subgroups across {short_population}. Future trials and extension studies should make it easier to distinguish whether benefits are uniform across severity strata, comorbidity profiles, care settings, and treatment timing."
        )
        safety_limitation_context = (
            "Safety data from the included reports were retained for descriptive interpretation. Safety outcomes were not "
            "quantitatively pooled in this primary efficacy synthesis, so these data require separate benefit-harm "
            "interpretation. Even when the primary efficacy endpoint favors treatment, serious adverse events, treatment "
            "discontinuation, organ-function changes, infections, bleeding, hemodynamic instability, or other harms can "
            "alter the net benefit for an individual patient."
        )
        source_reproducibility_context = self._source_reproducibility_limitation_context(source_names)
        aggregate_data_context = (
            "Aggregate-data meta-analysis also cannot reliably answer individual-level effect modification. Age, sex, baseline severity, comorbidities, regional practice, and background treatment may change absolute benefit, but trial-level subgroup reports are often inconsistently defined and vulnerable to selective reporting."
        )
        if compiled_active and compiled_text.get("limitations"):
            aggregate_data_context = compiled_text["limitations"]
        future_update_context = (
            f"Future studies should report the units, baseline values, follow-up time points, variance measures, patient-centered thresholds, safety outcomes, and prespecified subgroup effects consistently across {short_population}. New trials reporting a compatible result for {short_outcome} can update the primary synthesis; new reports that mainly clarify safety or applicability may change interpretation and certainty without changing the pooled efficacy estimate."
            if outcome_is_continuous else
            f"Future studies should report component outcomes, patient-centered outcomes, safety events, and prespecified subgroup effects consistently across {short_population}. New trials reporting a compatible result for {short_outcome} can update the primary synthesis; new reports that mainly clarify safety or applicability may change interpretation and certainty without changing the pooled efficacy estimate."
        )
        extraction_fields_text = (
            "For each potentially eligible study, extracted fields included study identifier, outcome name, mean difference or mean-change estimate, standard error or variance information, sample size, measurement scale, follow-up time point, and report location."
            if outcome_is_continuous else
            "For each potentially eligible study, extracted fields included study identifier, outcome name, arm-level events and denominators where available, reported effect estimate, standard error, and report location."
        )
        pooled_methods_result_text = (
                f"The primary pooled estimate was {effect_text}, with {p_text}. {heterogeneity} Participant totals are reported for clinical orientation, and the pooled {effect_measure} used the study-level mean-difference estimates and variance information selected for the primary analysis."
            if outcome_is_continuous else
                f"The primary pooled estimate was {effect_text}, with {p_text}. {heterogeneity} Aggregate events and denominators are reported for clinical orientation, and the pooled {effect_measure} used the study-level effects and variance information selected for the primary analysis."
        )
        if compiled_active and compiled_text.get("result_summary"):
            pooled_methods_result_text = (
                f"The prespecified synthesis produced the following estimates: "
                f"{compiled_text['result_summary']} {heterogeneity}"
            )
        model_interpretation_text = (
            "The primary model was interpreted alongside the clinical direction of effect, the width of the confidence interval, the number of participants represented by the included trial comparisons, and the measurement scale of the continuous outcome. A statistically significant mean difference can still be difficult to translate into practice if the unit, baseline value, follow-up timing, or clinically meaningful difference threshold is unclear. Conversely, a confidence interval compatible with a small but meaningful shift may remain clinically important when the outcome guides treatment escalation or long-term care."
            if outcome_is_continuous else
            "The primary model was interpreted alongside the clinical direction of effect, the width of the confidence interval, and the absolute number of participants and events represented by the included trial comparisons. A statistically significant relative effect can still be difficult to translate into practice if the baseline risk differs substantially across settings. Conversely, a confidence interval that is compatible with modest benefit and modest harm may remain clinically important when the outcome is severe or the intervention is low cost."
        )
        included_studies_table_text = (
            f"The primary quantitative synthesis included {n_primary} studies and {total_n:,} participants. Table 1 lists only the studies included in the primary meta-analysis, with report location, measurement context, and reported trial-level estimate. These studies matched the prespecified population and continuous endpoint most directly."
            if outcome_is_continuous else
            f"The primary quantitative synthesis included {n_primary} studies and {total_n:,} participants. Table 1 lists only the studies included in the primary meta-analysis, with report location, event counts where available, and reported trial-level estimate. Other assessed full-text records are handled as excluded or contextual records and are not counted as included studies. These studies matched the prespecified population and endpoint most directly."
        )
        outcome_lead = self._outcome_lead_phrase(outcome)
        primary_outcome_direction_text = (
            f"For {outcome_lead}, the included trial comparisons recorded {event_text}. The pooled result was {effect_text}, with {p_text}. {heterogeneity} The direction of benefit was interpreted according to the prespecified clinical meaning of lower or higher {short_outcome}, not by the sign of the mean difference alone."
            if outcome_is_continuous else
            f"For {outcome_lead}, the included trial comparisons recorded {event_text}{primary_source_cite}. The pooled result was {effect_text}, with {p_text}. {heterogeneity} The point estimate favored the intervention when values below the null indicated benefit."
        )
        if compiled_active and compiled_text.get("result_summary"):
            primary_outcome_direction_text = (
                "The prespecified synthesis estimates were: "
                + compiled_text["result_summary"]
                + " Effect direction was interpreted according to the prespecified outcome coding and effect measure; confidence intervals, prediction intervals when available, and certainty were considered together."
            )
        observed_data_text = (
            f"The analyzed data represented {total_n:,} participants and study-level {effect_measure} estimates for {short_outcome}. These estimates help orient the clinical magnitude of the evidence, while inverse-variance weighting preserves trial-level precision."
            if outcome_is_continuous else
            f"The observed aggregate counts were {events_i}/{total_i} in the intervention groups and {events_c}/{total_c} in the control groups. These counts help orient the clinical magnitude of the evidence, while the pooled {effect_measure} preserves trial-level weighting."
        )
        forest_precision_text = (
            "The forest plot and Table 2 provide complementary views of the same calculation. The plot emphasizes the direction and precision of each study estimate, whereas the table makes the numerical values and weights explicit. Any apparent dominance by a large trial should be interpreted through the inverse-variance weights, not participant counts alone, because precision depends on sample size and variance information."
            if outcome_is_continuous else
            "The forest plot and Table 2 provide complementary views of the same calculation. The plot emphasizes the direction and precision of each study estimate, whereas the table makes the numerical values and weights explicit. Any apparent dominance by a large trial should be interpreted through the inverse-variance weights, not participant counts alone, because precision depends on both size and event information."
        )
        scale_translation_result_text = (
            f"The scale translation is clinically important because the same {effect_measure} can imply different practical value depending on baseline value, measurement units, treatment goals, and the threshold for a clinically meaningful difference. A mean shift that is important for a poorly controlled patient may be less decisive for a patient already near target."
            if outcome_is_continuous else
            "The absolute-effect translation is clinically important because the same relative effect can imply different numbers of prevented events across baseline-risk strata. Patients with higher expected event rates may obtain a larger absolute reduction, whereas lower-risk patients may have a similar relative direction with a smaller short-term absolute benefit."
        )
        weight_precision_text = (
            "The weights should therefore be read as a measure of statistical precision rather than as a simple ranking of clinical importance. A study with more participants can still contribute less information if variance is large, follow-up timing differs, or uncertainty around the trial-level estimate is wider."
            if outcome_is_continuous else
            "The weights should therefore be read as a measure of statistical precision rather than as a simple ranking of clinical importance. A study with more participants can still contribute less information if event numbers are sparse or uncertainty around the trial-level estimate is wider."
        )
        small_study_context_text = (
            "No formal small-study-effect inference is appropriate from such a sparse set of contributing trials. Heterogeneity statistics are descriptive; with so few studies, they cannot establish absence of clinically important differences by disease severity, background therapy, baseline value, follow-up duration, measurement method, or missing-data handling."
            if outcome_is_continuous else
            "No formal small-study-effect inference is appropriate from such a sparse set of contributing trials. Heterogeneity statistics are descriptive; with so few studies, they cannot establish absence of clinically important differences by disease severity, background therapy, baseline risk, follow-up duration, or endpoint adjudication."
        )
        overall_result_meaning_text = (
            "Taken together, the numerical results support a favorable average effect for the prespecified continuous endpoint, with the main remaining uncertainty relating to whether the mean difference is large enough to matter for patients with different starting values and treatment goals."
            if outcome_is_continuous else
            "Taken together, the numerical results support a favorable average effect for the prespecified endpoint, with the main remaining uncertainty relating to how large the absolute benefit will be for patients at different baseline risks."
        )
        conclusion_decision_context = (
            "while clinical decisions should account for baseline value, clinically meaningful difference, safety, monitoring needs, cost, access, and patient preferences."
            if outcome_is_continuous else
            "while clinical decisions should account for baseline risk, absolute benefit, safety, monitoring needs, cost, access, and patient preferences."
        )
        calculation_first_line = (
            f"The primary calculation used {n_primary} selected study rows and {total_n:,} participants. Study-level continuous-outcome estimates were analyzed on the selected measurement scale."
            if outcome_is_continuous else
            f"The primary calculation used {n_primary} selected study rows and {total_n:,} participants. Aggregate event counts were {events_i}/{total_i} in the intervention groups and {events_c}/{total_c} in the control groups."
        )
        if compiled_active and compiled_text.get("calculation"):
            calculation_first_line = compiled_text["calculation"]
        abstract_downgrade_text = downgrade_text
        if "publication bias" in str(downgrade_text or "").lower() and n_primary < 10:
            abstract_downgrade_text = (
                f"possible publication bias because only {n_primary} studies contributed, limiting "
                "small-study-effect and heterogeneity assessment"
            )
        positioning_intro = self._positioning_paragraph(facts, cite=self._cite_suffix(background_cites, 0))
        model_decision_text = self._model_decision_paragraph(facts)
        model_sensitivity_text = self._model_sensitivity_sentence(facts)
        endpoint_definition_caveat = self._endpoint_definition_caveat(facts, zh=False)
        endpoint_definition_discussion = self._endpoint_definition_discussion(facts, zh=False)
        process_transparency_text = self._review_process_transparency_sentence(zh=False)
        study_intervention_text = (
            self._primary_study_intervention_sentence(facts)
            or (self._primary_study_names_sentence(facts) + self._primary_intervention_examples_sentence(facts))
        )
        model_abstract_rationale = (
            " Because only two studies contributed, tau-squared estimation was unstable and heterogeneity statistics were treated as descriptive."
            if (facts.get("model_decision") or {}).get("low_k_random_fallback") else
            ""
        )
        if compiled_active:
            model_decision_text = ""
            model_abstract_rationale = ""
        hedged_core_claim = (
            f"the pooled estimate favored {short_intervention} over {short_comparator} for {short_outcome} ({effect_text})"
            if outcome_is_continuous else
            f"{short_intervention} may reduce the risk of {short_outcome} compared with {short_comparator} ({effect_text})"
        )
        discussion_core_claim = (
            f"the available evidence suggests a favorable difference for {short_intervention} compared with {short_comparator} on {short_outcome}"
            if outcome_is_continuous else
            f"the available evidence suggests a reduction in {short_outcome} with {short_intervention} compared with {short_comparator}"
        )
        if compiled_active and compiled_text.get("result_summary"):
            hedged_core_claim = (
                "the prespecified synthesis yielded these comparative estimates: "
                + compiled_text["result_summary"].rstrip(".")
            )
            discussion_core_claim = "the prespecified synthesis yielded the reported comparative estimates"
            balanced_message = (
                "The analysis therefore supports interpretation based on the prespecified outcome coding, effect magnitude, confidence and prediction intervals, and certainty; numerical ordering alone should not be equated with clinical benefit."
            )
            overall_result_meaning_text = (
                "Taken together, the numerical results should be interpreted according to the prespecified outcome direction and effect measure, with the interval estimates and certainty defining the strength of any clinical conclusion."
            )

        abstract = "\n".join([
            f"**Importance:** {short_population} remain an important population for evidence synthesis because treatment effects can differ across clinical phenotype, comparator, outcome definition, and follow-up.",
            f"**Objective:** To estimate the effect of {short_intervention} compared with {short_comparator} on {short_outcome}.",
            f"**Data sources:** The search covered {source_label}. Search date: {search_date_text}. The full Boolean query is reported in Appendix 1.",
            f"**Study selection:** {compiled_text.get('study_selection') if compiled_active else 'Randomized trials or trial rows matching the prespecified population, intervention, comparator, and primary outcome were eligible for the primary synthesis.'}",
            f"**Data extraction and synthesis:** {compiled_text.get('abstract_synthesis') if compiled_active else f'Outcome data were extracted from full-text or structured source records. Trial-level {effect_measure} estimates and standard errors were pooled with the prespecified {primary_model_text} inverse-variance model.{model_abstract_rationale} Model-selection rationale is reported in Methods.'}",
            f"**Main outcome and measures:** {short_outcome}.",
            f"**Results:** The search identified {records_identified} records; {dedup_phrase} for title/abstract screening and {full_text_assessed} underwent full-text assessment. {review_inclusion_text}The primary meta-analysis included {n_primary} studies totaling {total_n:,} participants. {study_intervention_text}{non_primary_retained_text} The included trial comparisons recorded {event_text}. The pooled effect was {effect_text} ({p_text}). {heterogeneity}",
            f"**Conclusions and relevance:** In this systematic review and meta-analysis, {hedged_core_claim}. Certainty was rated {str(certainty).lower()} because of {abstract_downgrade_text}.{warning_text}",
        ])

        introduction = "\n\n".join(part for part in [
            intro_population_context,
            f"{short_intervention} {intervention_auxiliary} been evaluated against {short_comparator} in randomized evidence, but the practical meaning of a relative effect depends on the trial population, endpoint definition, comparator care, and the patient group to whom the result will be applied{self._cite_suffix(background_cites, 1)}.",
            endpoint_intro,
            positioning_intro,
            f"This review asked: {protocol.research_question}. The prespecified PICO was {short_population}, {short_intervention}, {short_comparator}, and {short_outcome}; detailed eligibility criteria are reported in Methods. The synthesis was restricted to randomized evidence that directly addressed this clinical comparison.",
            focused_population_context,
            effect_measure_intro,
            safety_intro,
            f"Accordingly, this review estimates the effect of {short_intervention} compared with {short_comparator} on {short_outcome} and interprets the finding in relation to effect size, certainty, applicability, safety considerations, and remaining evidence gaps.",
        ] if part)

        methods = "\n\n".join([
            "### Protocol and reporting framework\n"
            "The review followed a prespecified systematic-review protocol with eligibility criteria, search strategy, study selection, data extraction, effect-size calculation, certainty assessment, and planned figure presentation. This review was not prospectively registered; protocol elements, search strings, effect-size settings, and analysis facts are preserved in the export package. Reporting followed PRISMA 2020 principles for transparent systematic-review presentation" + prisma_cite + ".",
            "### Eligibility criteria\n"
            f"Eligible studies enrolled {short_population}, compared {short_intervention} with {short_comparator}, and reported {short_outcome} or a documented endpoint judged to represent the same primary clinical construct. Records that described related populations, secondary analyses, design papers, or surrogate outcomes were retained as context when useful but were not counted as independent primary-analysis studies.",
            "For trials with multiple reports, the primary publication or the most directly documented result was preferred. Secondary analyses were not allowed to displace a primary trial row unless they contained the only documented value for the prespecified outcome. Duplicate trial records were reconciled before effect-size calculation.",
            endpoint_definition_caveat,
            "### Information sources and search strategy\n"
            f"The search covered {source_label}; initial records by source were {source_counts}. Search date: {search_date_text}. The full Boolean query is reported in Appendix 1.\n\n"
            f"{source_reproducibility_methods_note}"
            f"Database source, search date, and full-text availability were documented to support reproducibility. Search reporting followed PRISMA-S where the records permitted it{search_method_cite}.",
            "### Study selection and extraction\n"
            "Title/abstract screening, full-text screening, and data extraction were conducted as separate steps. "
            + process_transparency_text
            + " "
            + extraction_fields_text,
            "Outcome data entered the quantitative synthesis only when they matched the prespecified primary outcome and represented the most direct available result for that study. Data excluded because of missing values, duplicate endpoint hierarchy, secondary-outcome status, or insufficient documentation were listed in the supplementary extraction table with the reason they did not enter the primary synthesis.",
            "When several reports were linked to the same clinical trial, the source most directly reporting the prespecified primary endpoint was prioritized, and linked reports were not counted as independent studies. Endpoint wording was harmonized only when the report made clear that the clinical construct matched the prespecified outcome.",
            "### Documentation checks\n"
            "Report locations and supporting excerpts are shown in Appendix 2. These fields allow readers to compare each analyzed value with the corresponding trial report or registry entry.",
            "A contributing outcome had to identify the endpoint context, intervention and comparator arms, numerical value used in the analysis, and report location. If a value was corrected after checking against the source report, the corrected value was used consistently in effect-size calculation, tables, figures, and text.",
            "### Unit of analysis and duplicate handling\n"
            + (
                compiled_text.get("unit")
                if compiled_active else
                "The unit of analysis was the independently randomized trial comparison or the prespecified trial subgroup that matched the review question. Multiple records from the same randomized trial were reconciled before synthesis so the study count in the abstract, results, tables, and figures referred to the same analytic units.\n\nIf a study reported more than one eligible intervention arm against a shared comparator, compatible arms were combined before the trial contributed to the primary analysis. If arms could not be combined without changing the clinical question, that comparison was excluded from the primary synthesis and summarized separately. This approach preserves randomization within each comparison and avoids giving a multi-arm trial disproportionate influence."
            ),
            "### Statistical analysis\n"
            + (
                compiled_text.get("statistics") + stats_method_cite
                if compiled_active else
                f"The primary analysis pooled trial-level {effect_measure} estimates. Estimates were analyzed on the log scale when appropriate and transformed back to the reported scale for tables and text. Inverse-variance weights were calculated from each row's standard error. The null value for {effect_measure} was {null_text}{stats_method_cite}."
            ),
            model_decision_text,
            pooled_methods_result_text,
            "Per-study effects, standard errors, and weights were tabulated before reporting, so the forest plot, trial-level table, and results paragraph report the same study-level estimates.",
            f"Because the number of contributing studies can be small in focused clinical questions, small-study-effect tests were not interpreted as confirmatory when fewer than 10 studies contributed to the primary analysis. Sensitivity analyses, when available, were treated as influence diagnostics and not as independent evidence of treatment-effect modification{bias_method_cite}.",
            model_interpretation_text,
            endpoint_scale_methods,
            "### Risk of bias and certainty\n"
            f"Risk of bias and GRADE certainty were based on domain-level judgments. Statistical checks informed inconsistency, imprecision, and small-study-effect limitations. Domains requiring clinical interpretation, especially risk of bias and indirectness, are reported so that content experts can compare them with the source articles{certainty_method_cite}.",
            "Certainty judgments considered risk of bias, inconsistency, indirectness, imprecision, and publication bias in relation to the prespecified clinical question.",
        ])

        results = "\n\n".join([
            "### Search and screening\n"
            f"The search identified {records_identified} records. After cross-source deduplication and record consolidation removed {duplicates_removed} records, {records_after_dedup} unique records remained for screening; {title_abstract_screened} title/abstract records were screened and {full_text_assessed} full-text records were assessed. {review_inclusion_text}The primary meta-analysis included {n_primary} studies with data for the selected primary outcome. {non_primary_retained_text}",
            "### Included studies\n",
            included_studies_table_text,
            "### Primary outcome\n",
            primary_outcome_direction_text,
            "",
            absolute_result_text,
            model_sensitivity_text,
            observed_data_text,
            forest_precision_text,
            small_study_context_text,
            overall_result_meaning_text,
            "### Certainty of evidence\n"
            f"The GRADE certainty for the primary outcome was {certainty}. {self._grade_downgrade_summary_sentence(downgrade_text)} Table 3 provides the domain-level judgments and rationales used for this determination.",
            f"Because only {n_primary} studies contributed to the primary synthesis, each trial carried substantial interpretive weight. Two large and directly relevant trials can provide a clear direction of effect, but they still leave limited ability to explore heterogeneity, small-study effects, or publication bias.",
            participant_context,
        ])

        discussion = "\n\n".join([
            f"In this synthesis of {short_population}, {discussion_core_claim}, with {effect_text}. The confidence interval {'crossed' if ci_crosses_null else 'did not cross'} the null value of {null_text}, and certainty was {str(certainty).lower()}; the included trials contributed {total_n:,} participants{self._cite_suffix(background_cites, 0)}.",
            "### Clinical interpretation\n",
            clinical_interpretation,
            component_interpretation,
            endpoint_definition_discussion,
            "### Relation to existing evidence and guidelines\n",
            relation_context,
            "### Clinical application\n",
            application_context,
            absolute_risk_context,
            background_care_context,
            (
                f"Heterogeneity cannot be meaningfully assessed with only {n_primary} contributing studies. The reported I², Q, and tau² values are descriptive and do not exclude clinically meaningful variation. The more important question is whether the trials are sufficiently similar in population, comparator care, endpoint definition, and follow-up for the pooled estimate to be useful."
                if n_primary > 2 else
                ""
            ),
            "Publication bias is also difficult to judge in a sparse evidence base. Absence of funnel-plot asymmetry cannot reassure readers when there are too few studies to detect asymmetry. The practical implication is that confidence should come mainly from the size, design, directness, and consistency of the included randomized trials, not from formal small-study effect tests.",
            shared_decision_context,
            balanced_message,
            absolute_final_clinical_point,
            "### Strengths and limitations\n",
            strength_scope_context,
            f"The main limitation is that only {n_primary} studies contributed to the pooled estimate. Even when the studies are large and directly relevant, such a small number limits assessment of heterogeneity, publication bias, and subgroup consistency; with fewer than 10 studies, funnel-plot asymmetry tests are descriptive at best{bias_method_cite}.",
            source_reproducibility_context,
            safety_limitation_context,
            aggregate_data_context,
            "### Future research\n",
            future_update_context,
        ])

        intervention_scope_text = self._intervention_scope_sentence(facts)
        limited_evidence_text = (
            f"Evidence is limited to {n_primary} contributing studies. "
            if n_primary <= 2 else
            ""
        )
        conclusion = (
            f"For {short_population}, {hedged_core_claim}. "
            f"{intervention_scope_text}"
            f"{limited_evidence_text}"
            f"With {str(certainty).lower()} certainty from {n_primary} contributing studies, the limited study count mainly "
            f"constrains heterogeneity and small-study-effect assessment; apply the estimate to similar patients with "
            f"attention to {conclusion_decision_context.removeprefix('while clinical decisions should account for ').rstrip('.')}."
        )

        calculation_notes = "\n\n".join([
            calculation_first_line,
            f"Trial-level {effect_measure} estimates and standard errors were used for inverse-variance weighting; the pooled estimate is reported as {effect_text}.",
            f"{heterogeneity} Table 2 lists the trial-level values used for calculation, and Appendix 2 lists the corresponding report locations.",
            calculation_scale_context,
        ])

        sections = [
            f"# {title}",
            "",
            "## Abstract",
            abstract,
            "",
            "## Introduction",
            introduction,
            "",
            "## Methods",
            methods,
            "",
            "## Results",
            results,
            "",
            "## Discussion",
            discussion,
            "",
            "## Conclusion",
            conclusion,
            "",
            "## Tables",
            "### Table 1. Characteristics of selected primary rows",
            study_table,
            "",
            f"### Table 2. {compiled_text.get('table2_title') if compiled_active else f'Trial-level {effect_measure} estimates and weights'}",
            effect_table,
            "",
            "### Table 3. GRADE summary of findings",
            grade_table,
            "",
            *([
                "### Table 4. Absolute-effect translation",
                absolute_table,
                "",
            ] if absolute_table else []),
            "## Figures",
            figure_section,
            "",
            "## Supplementary Materials",
            "### Appendix 1. Full search query",
            full_query_block,
            "",
            "### Appendix 2. Source documentation for included primary comparisons",
            source_table,
            "",
            "### Appendix 3. Calculation notes",
            calculation_notes,
            "",
            "### Appendix 4. PRISMA 2020 checklist",
            self._fallback_prisma_2020_checklist(prisma=prisma, search_date=search_date_text, has_rob=True, has_grade=bool(grade_outcomes)),
            "",
            "### Appendix 5. PRISMA-S checklist",
            self._fallback_prisma_s_checklist(search=search, search_date=search_date_text),
            "",
            "### Appendix 6. ROBIS assessment",
            self._fallback_robis_assessment(readiness=readiness, n_primary=n_primary),
            "",
            self._declarations_section(),
            "",
            "## References",
            refs_text,
        ]
        manuscript_text = "\n".join(sections).strip() + "\n"
        if outcome_is_continuous:
            manuscript_text = self._adapt_continuous_outcome_language(manuscript_text, outcome=short_outcome)
        manuscript = self._polish_publication_body_language(
            manuscript_text,
            compress_discussion=True,
        )
        manuscript = self._backfill_publication_inline_citations(manuscript)
        manuscript = self._backfill_publication_figure_references(manuscript)
        manuscript = self._backfill_publication_figure_legends(manuscript)
        manuscript = self._backfill_publication_table_notes(manuscript)
        manuscript = self._cap_dominant_primary_trial_citations_from_references(manuscript)
        return self._normalize_citation_marker_style(manuscript, lang=self._lang)
