"""The per-section manuscript writers and the figure assembly."""
from __future__ import annotations

import json
import re

from new_meta.core.project import Project
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.schemas.meta_result import MetaAnalysisResults
from new_meta.schemas.study import ExtractedStudy
from new_meta.schemas.risk_of_bias import StudyRoB
from new_meta.schemas.grade import GRADEProfile
from new_meta.tools.utils import first_author_lastname as _first_author
from new_meta.prompts import writing_prompts
from new_meta.engines.meta_engine import _to_original


class SectionWritersMixin:
    """The per-section manuscript writers and the figure assembly."""

    def _write_validation_blocked_report(
        self,
        *,
        protocol: ResearchProtocol,
        facts: dict,
        validation: dict,
    ) -> str:
        """Build a deterministic report when generated prose fails hard fact checks."""
        errors = [item for item in validation.get("issues", []) if item.get("severity") == "error"]
        warnings = [item for item in validation.get("issues", []) if item.get("severity") != "error"]
        primary = facts.get("primary_effect") or {}
        population = facts.get("primary_population") or {}
        readiness = facts.get("evidence_readiness") or {}
        has_primary_effect = all(
            primary.get(key) not in {None, "", "NR"}
            for key in ("pooled_effect", "ci_lower", "ci_upper")
        )

        if self._zh:
            lines = [
                "# Manuscript Validation Blocked",
                "",
                "## 当前状态",
                (
                    f"本次运行已经进入 `{facts.get('report_type', 'meta')}` 写作路径，但最终事实校验失败。"
                    "系统已阻止把投稿式正文作为最终稿输出；被拒绝的草稿保存在 `manuscript/draft.rejected.md`，"
                    "用于定位写作器问题。"
                ),
                "",
                "## 已核验的主分析",
                f"- 主结局：{primary.get('outcome_name') or protocol.pico.outcome_primary or '未报告'}",
                f"- 入池研究数：{primary.get('n_studies', '不适用')}",
                (
                    f"- 合并效应：{primary.get('effect_measure', protocol.effect_measure)} "
                    f"{primary.get('pooled_effect')} "
                    f"(95% CI {primary.get('ci_lower')} 到 {primary.get('ci_upper')})"
                    if has_primary_effect
                    else "- 定量合成：未进行。"
                ),
                f"- 主分析总样本量：{population.get('selected_total_participants', '不适用')}",
                "",
                "## 阻断的事实校验错误",
            ]
            lines.extend(self._validation_issue_lines(errors, empty="- 无 hard error。"))
            lines.extend([
                "",
                "## 仍需复核的警告",
            ])
            lines.extend(self._validation_issue_lines(warnings, empty="- 无 warning。"))
            lines.extend([
                "",
                "## 下一步处理建议",
                "1. 先修复上述 hard validation 错误，尤其是样本量、效应量、图表/表格引用和结局名称串位。",
                "2. 若错误来自提取数据，回到 extraction review 做人工裁决并写入 overrides。",
                "3. 若错误来自写作器，把对应章节改为从 manuscript_facts.json 渲染或重写。",
                "4. 只有 `manuscript_validation.json` 中 `passed=true` 后，才允许导出投稿式 manuscript。",
            ])
            if readiness.get("warnings"):
                lines.extend([
                    "",
                    "## 证据复核提示",
                    *[f"- `{item.get('code', 'unknown')}`: {item.get('message', '')}" for item in readiness.get("warnings", [])],
                ])
            return "\n".join(lines).strip() + "\n"

        lines = [
            "# Manuscript Validation Blocked",
            "",
            "## Current Status",
            (
                f"This run reached the `{facts.get('report_type', 'meta')}` writing path, but hard fact validation failed. "
                "The pipeline blocked the publication-style draft from being saved as the final manuscript. "
                "The rejected draft is retained at `manuscript/draft.rejected.md` for debugging."
            ),
            "",
            "## Verified Primary Analysis",
            f"- Primary outcome: {primary.get('outcome_name') or protocol.pico.outcome_primary or 'Not reported'}",
            f"- Studies contributing to the primary synthesis: {primary.get('n_studies', 'Not applicable')}",
            (
                f"- Pooled effect: {primary.get('effect_measure', protocol.effect_measure)} "
                f"{primary.get('pooled_effect')} "
                f"(95% CI {primary.get('ci_lower')} to {primary.get('ci_upper')})"
                if has_primary_effect
                else "- Quantitative synthesis: Not performed."
            ),
            f"- Selected primary-analysis participants: {population.get('selected_total_participants', 'Not applicable')}",
            "",
            "## Blocking Fact-Check Errors",
        ]
        lines.extend(self._validation_issue_lines(errors, empty="- No hard errors."))
        lines.extend([
            "",
            "## Remaining Warnings",
        ])
        lines.extend(self._validation_issue_lines(warnings, empty="- No warnings."))
        lines.extend([
            "",
            "## Recommended Next Actions",
            "1. Fix the hard validation errors above, especially participant totals, effect estimates, figure/table references, and outcome/effect alignment.",
            "2. If an error comes from extracted data, adjudicate it in the extraction review workflow and persist an override.",
            "3. If an error comes from prose generation, render that section from manuscript_facts.json or rewrite it.",
            "4. Export a publication-style manuscript only after manuscript_validation.json reports passed=true.",
        ])
        if readiness.get("warnings"):
            lines.extend([
                "",
                "## Evidence Review Notes",
                *[f"- `{item.get('code', 'unknown')}`: {item.get('message', '')}" for item in readiness.get("warnings", [])],
            ])
        return "\n".join(lines).strip() + "\n"

    @staticmethod
    def _validation_issue_lines(issues: list[dict], *, empty: str) -> list[str]:
        if not issues:
            return [empty]
        lines = []
        for issue in issues:
            kind = issue.get("kind") or "unknown"
            message = issue.get("message") or ""
            lines.append(f"- `{kind}`: {message}")
        return lines

    @staticmethod
    def _selected_row_lines(rows: list[dict], *, zh: bool) -> list[str]:
        if not rows:
            return ["- 未选择主结局候选行。" if zh else "- No selected primary rows were recorded."]
        header = (
            "| 行 | 研究 | 结局 | 来源 | 引用验证 | 置信度 |"
            if zh else
            "| Row | Study | Outcome | Source | Quote verified | Confidence |"
        )
        out = [header, "|---|---|---|---|---|---|"]
        for row in rows:
            out.append(
                "| {row_id} | {study_id} | {outcome} | {source} | {verified} | {confidence} |".format(
                    row_id=SectionWritersMixin._cell(row.get("row_id") or "NR"),
                    study_id=SectionWritersMixin._cell(row.get("study_id") or "NR"),
                    outcome=SectionWritersMixin._cell(row.get("outcome_name") or "NR"),
                    source=SectionWritersMixin._cell(row.get("source_location") or row.get("source_section") or "NR"),
                    verified="yes" if row.get("source_quote_verified") is True else "no",
                    confidence=SectionWritersMixin._cell(row.get("extraction_confidence") or "missing"),
                )
            )
        return out

    @staticmethod
    def _cell(value) -> str:
        return str(value).replace("|", "\\|").replace("\n", " ").strip()

    def _write_title(self, protocol: ResearchProtocol, results: MetaAnalysisResults, studies: list = None) -> str:
        n = self._included_count
        if self._narrative_mode:
            prompt = self._zh_prefix() + writing_prompts.NARRATIVE_TITLE_PROMPT.format(
                research_question=protocol.research_question,
                population=protocol.pico.population,
                intervention=protocol.pico.intervention,
                comparator=protocol.pico.comparator,
                outcome=protocol.pico.outcome_primary,
                n_studies=n,
            )
        else:
            prompt = self._zh_prefix() + writing_prompts.TITLE_PROMPT.format(
                research_question=protocol.research_question,
                population=protocol.pico.population,
                intervention=protocol.pico.intervention,
                comparator=protocol.pico.comparator,
                outcome=protocol.pico.outcome_primary,
                n_studies=n,
            )
        return self.call_llm(prompt, max_tokens=self._writing_tokens("title")).strip().strip('"')

    def _write_abstract(
        self,
        protocol: ResearchProtocol,
        results: MetaAnalysisResults,
        grade_profile: GRADEProfile = None,
        studies: list = None,
    ) -> str:
        n_studies = self._included_count

        if self._narrative_mode:
            # Build study results summary so the abstract has real data to work with
            study_summary = self._build_study_results_text(studies or [])
            n_direct = len(getattr(self, '_direct_rct_studies', []))
            total_screened = len(studies or [])
            prompt = self._zh_prefix() + writing_prompts.NARRATIVE_ABSTRACT_PROMPT.format(
                protocol_json=json.dumps(protocol.model_dump(), indent=2, ensure_ascii=False),
                n_direct_rct=n_direct if n_direct > 0 else n_studies,
                total_screened=total_screened,
                evidence_class_summary=getattr(self, '_evidence_class_summary', f"- Total studies: {n_studies}"),
                n_studies=n_studies,
            )
            prompt += (
                f"\n\n## Individual Study Results (use ONLY these data):\n{study_summary}"
            )
            return self.call_llm(prompt, max_tokens=self._writing_tokens("abstract"))

        po = results.primary_outcome
        pub_bias = "Not assessed"
        if results.publication_bias:
            pb = results.publication_bias
            pub_bias = f"Egger's p={pb.egger_p_value:.3f}" if pb.egger_p_value else "Not significant"

        grade_conclusion = ""
        if grade_profile and grade_profile.outcomes:
            primary_grade = grade_profile.outcomes[0]
            grade_conclusion = f"- GRADE certainty: {primary_grade.certainty} certainty evidence"

        prompt = self._zh_prefix() + writing_prompts.ABSTRACT_PROMPT.format(
            protocol_json=json.dumps(protocol.model_dump(), indent=2, ensure_ascii=False),
            n_studies=po.n_studies,
            total_screened=len(studies or []),
            effect_measure=po.effect_measure,
            pooled_effect=f"{po.pooled_effect:.2f}",
            ci_lower=f"{po.ci_lower:.2f}",
            ci_upper=f"{po.ci_upper:.2f}",
            p_value=f"{po.p_value:.4f}",
            i_squared=f"{po.i_squared:.1f}",
            pub_bias_summary=pub_bias,
            grade_conclusion=grade_conclusion,
            evidence_class_summary=getattr(self, '_evidence_class_summary', ''),
        )
        return self.call_llm(prompt, max_tokens=self._writing_tokens("abstract"))

    def _write_introduction(self, protocol: ResearchProtocol) -> str:
        if self._narrative_mode:
            lang_inst = "中文" if self._zh else "English"
            prompt = self._zh_prefix() + writing_prompts.NARRATIVE_INTRODUCTION_PROMPT.format(
                research_question=protocol.research_question,
                pico_json=json.dumps(protocol.pico.model_dump(), indent=2, ensure_ascii=False),
                lang_instruction=lang_inst,
            )
        else:
            prompt = self._zh_prefix() + writing_prompts.INTRODUCTION_PROMPT.format(
                research_question=protocol.research_question,
                pico_json=json.dumps(protocol.pico.model_dump(), indent=2, ensure_ascii=False),
            )
        citation_context = str(getattr(self, "_background_citation_context", "") or "").strip()
        if citation_context:
            prompt += (
                "\n\n## Background citation context\n"
                "Use these citations for background, guideline, prior-review, and trial-registry context. "
                "Cite claims with the bracket numbers exactly as shown, and do not invent additional references.\n"
                f"{citation_context}"
            )
        prompt += self._section_fact_contract_block("introduction")
        prompt += self._section_citation_requirement_block(
            "narrative_introduction" if self._narrative_mode else "introduction"
        )
        return self.call_llm(prompt, max_tokens=self._writing_tokens("section"))

    def _write_methods(self, protocol: ResearchProtocol, prisma: dict, query: str, rob_results: list[StudyRoB], search_date: str = "") -> str:
        # Prefer report_state for PRISMA numbers (single source of truth)
        rs = getattr(self, '_report_state', None)
        if rs is not None:
            records_identified = rs.prisma_records_identified
            records_dedup = rs.prisma_after_dedup
            full_text_assessed = rs.prisma_full_text_assessed
            included = rs.n_direct_eligible
        else:
            ident = prisma.get("identification", {})
            screen = prisma.get("screening", {})
            elig = prisma.get("eligibility", {})
            incl = prisma.get("included", {})
            records_identified = ident.get("records_identified", 0)
            records_dedup = ident.get("records_after_dedup", 0)
            full_text_assessed = elig.get("full_text_assessed", 0)
            included = incl.get("studies_included", 0)
        if rs is not None:
            screened = rs.prisma_screened or rs.prisma_after_dedup
        else:
            screened = prisma.get("screening", {}).get("title_abstract_screened", 0)

        has_rob = bool(rob_results)
        rob_tools = set(r.tool_used for r in rob_results) if rob_results else set()
        rob_tool_name = ", ".join(rob_tools) if rob_tools else ("未适用" if self._zh else "N/A")

        if self._narrative_mode:
            prompt = self._zh_prefix() + writing_prompts.NARRATIVE_METHODS_PROMPT.format(
                protocol_json=json.dumps(protocol.model_dump(), indent=2, ensure_ascii=False),
                databases=", ".join(protocol.databases),
                search_query=query,
                search_date=search_date or "未报告" if self._zh else "Not reported",
                records_identified=records_identified,
                records_dedup=records_dedup,
                screened=screened,
                full_text_assessed=full_text_assessed,
                included=included,
            )
            # When RoB was not assessed, strip the RoB section from prompt and add instruction
            if not has_rob:
                rob_section = f"## Risk of Bias Tool: {rob_tool_name}\n"
                prompt = prompt.replace(rob_section, "")
                prompt += (
                    "\n\nNOTE: Risk of bias assessment was NOT performed. "
                    "Do NOT describe any RoB tools, assessment methods, or bias evaluation procedures in the Methods."
                )
        else:
            # Build statistical methods text based on actual k
            k = included
            stats_parts = [
                f"Effect measure: {protocol.effect_measure}",
                f"Model: {protocol.model_preference} effects (DerSimonian-Laird for random effects)",
                "Heterogeneity: Cochran's Q test, I² statistic, τ², prediction interval",
            ]
            if k >= 3:
                stats_parts.append("Sensitivity: Leave-one-out analysis, cumulative meta-analysis")
            else:
                stats_parts.append("Sensitivity: Not performed (fewer than 3 studies)")
            if k >= 10:
                stats_parts.append(
                    "Publication bias: Egger's test, Begg's test, trim-and-fill, fail-safe N, "
                    "contour-enhanced funnel plot"
                )
            else:
                stats_parts.append(
                    "Publication bias: Not assessed (fewer than 10 studies)"
                )
            if k >= 3:
                stats_parts.append(
                    "Influence diagnostics: Cook's distance, DFBETAS, Baujat plot, Galbraith (radial) plot"
                )
            else:
                stats_parts.append("Influence diagnostics: Not performed (fewer than 3 studies)")
            stats_parts.append("Certainty of evidence: GRADE framework")
            stats_parts.append("Software: Python (custom meta-analysis engine)")
            statistical_methods_text = "\n".join(f"- {p}" for p in stats_parts)

            prompt = self._zh_prefix() + writing_prompts.METHODS_PROMPT.format(
                protocol_json=json.dumps(protocol.model_dump(), indent=2, ensure_ascii=False),
                databases=", ".join(protocol.databases),
                search_query=query,
                search_date=search_date or "Not reported",
                records_identified=records_identified,
                records_dedup=records_dedup,
                screened=screened,
                full_text_assessed=full_text_assessed,
                included=included,
                statistical_methods_text=statistical_methods_text,
            )
        methodology_context = str(getattr(self, "_methodology_citation_context", "") or "").strip()
        if methodology_context:
            prompt += (
                "\n\n## Methodology citation context\n"
                "Use these citations for reporting standards, search reporting, risk-of-bias tools, "
                "GRADE certainty, heterogeneity statistics, random-effects methods, and publication-bias methods. "
                "Cite methodological claims with the bracket numbers exactly as shown.\n"
                f"{methodology_context}"
            )
        prompt += self._section_fact_contract_block("methods")
        prompt += self._section_citation_requirement_block("methods")
        methods = self.call_llm(prompt, max_tokens=self._writing_tokens("section"))
        return self._ensure_exact_search_query_in_methods(methods, query)

    def _ensure_exact_search_query_in_methods(self, methods: str, query: str) -> str:
        query_text = str(query or "").strip()
        if not query_text:
            return methods
        methods_text = str(methods or "").strip()
        if self._normalized_search_query(query_text) in self._normalized_search_query(methods_text):
            return methods_text
        label = "完整检索式" if self._zh else "Full search query"
        insertion = f"\n\n{label}:\n```text\n{query_text}\n```"
        heading = re.search(r"(^#{2,4}\s+(?:Methods|方法|研究方法|材料与方法)[^\n]*\n?)", methods_text, flags=re.I | re.M)
        if heading:
            return methods_text[:heading.end()].rstrip() + insertion + "\n\n" + methods_text[heading.end():].lstrip()
        return f"{label}:\n```text\n{query_text}\n```\n\n{methods_text}".strip()

    @staticmethod
    def _normalized_search_query(text: str) -> str:
        return re.sub(r"\s+", " ", str(text or "")).strip().lower()

    def _write_results(
        self,
        protocol: ResearchProtocol,
        results: MetaAnalysisResults,
        studies: list[ExtractedStudy],
        rob_results: list[StudyRoB],
        prisma: dict,
        grade_profile: GRADEProfile = None,
        citation_map: str = "",
    ) -> str:
        po = results.primary_outcome

        per_study = []
        for s in po.studies:
            yi_orig = _to_original(s.yi, po.effect_measure)
            per_study.append(f"  {s.study_label}: {po.effect_measure}={yi_orig:.3f}, SE={s.se:.3f}, weight={s.weight:.1f}%")
        per_study_str = "\n".join(per_study)

        secondary_str = ""
        for sec in results.secondary_outcomes:
            secondary_str += f"\n- {sec.outcome_name}: {sec.pooled_effect:.2f} (95% CI: {sec.ci_lower:.2f} to {sec.ci_upper:.2f}), I²={sec.i_squared:.1f}%"

        sensitivity_str = ""
        for loo in results.leave_one_out:
            sensitivity_str += f"\n  Excl. {loo.excluded_study_label}: {loo.pooled_effect:.2f} [{loo.ci_lower:.2f}, {loo.ci_upper:.2f}], I²={loo.i_squared:.1f}%"

        rob_counts = {}
        for r in rob_results:
            j = r.overall_judgment
            rob_counts[j] = rob_counts.get(j, 0) + 1
        rob_str = ", ".join(f"{k}: {v}" for k, v in rob_counts.items())

        study_rows = []
        # Only list direct RCT studies in the table
        direct_studies = getattr(self, '_direct_rct_studies', None) or studies
        for s in direct_studies:
            c = s.characteristics
            first = _first_author(c.authors)
            study_rows.append(f"  {first} {c.year}: {c.study_design}, N={c.total_sample_size or 'NR'}, {c.country}")
        study_table = "\n".join(study_rows)

        k = po.n_studies if hasattr(po, 'n_studies') else len(po.studies)
        zh = self._zh
        if k < 10:
            pub_bias_section = (
                "发表偏倚检验因研究数量不足（<10项）未实施 / Publication bias not assessed (fewer than 10 studies)"
                if zh else "Publication bias not assessed (fewer than 10 studies)"
            )
            pub_bias_instruction = (
                "State that publication bias was NOT assessed due to insufficient number of studies (<10)"
            )
        else:
            pb = results.publication_bias
            pub_bias_section = (
                f"- Egger's test: intercept={pb.egger_intercept:.3f}, p={pb.egger_p_value:.3f}\n"
                f"- Begg's test: τ={pb.begg_tau:.3f}, p={pb.begg_p_value:.3f}\n"
                f"- Trim-and-fill: {pb.trim_fill_missing} missing studies\n"
                f"- Fail-safe N: {pb.failsafe_n}"
            ) if pb else "Not assessed"
            pub_bias_instruction = "reference **Figure 3** (funnel plot), **Figure 7** (contour-enhanced funnel)"

        pred = f"({po.prediction_interval[0]:.2f}, {po.prediction_interval[1]:.2f})" if po.prediction_interval else "N/A"

        grade_str = ""
        if grade_profile:
            for go in grade_profile.outcomes:
                domains_str = "; ".join(f"{d.domain}={d.rating}" for d in go.domains)
                grade_str += f"\n- {go.outcome_name}: {go.certainty} ({domains_str})"
        if not grade_str:
            grade_str = "Not assessed"

        nma_str = ""
        if results.nma_result:
            nma = results.nma_result
            for c in nma.league_table[:20]:
                nma_str += f"\n  {c.treatment} vs {c.comparator}: {c.effect:.2f} [{c.ci_lower:.2f}, {c.ci_upper:.2f}]"
        if not nma_str:
            nma_str = "Not performed"

        prompt = self._zh_prefix() + writing_prompts.RESULTS_PROMPT.format(
            prisma_json=json.dumps(prisma, indent=2),
            evidence_class_summary=getattr(self, '_evidence_class_summary', ''),
            study_table=study_table,
            rob_summary=rob_str,
            primary_outcome_name=po.outcome_name,
            model=po.model,
            effect_measure=po.effect_measure,
            pooled_effect=f"{po.pooled_effect:.2f}",
            ci_lower=f"{po.ci_lower:.2f}",
            ci_upper=f"{po.ci_upper:.2f}",
            p_value=f"{po.p_value:.4f}",
            q_stat=f"{po.q_statistic:.2f}",
            q_p=f"{po.q_p_value:.4f}",
            i_squared=f"{po.i_squared:.1f}",
            tau_squared=f"{po.tau_squared:.4f}",
            pred_interval=pred,
            per_study_data=per_study_str,
            secondary_outcomes_data=secondary_str or "None",
            sensitivity_data=sensitivity_str or "Not performed (< 3 studies)",
            pub_bias_section=pub_bias_section,
            pub_bias_instruction=pub_bias_instruction,
            grade_data=grade_str,
            nma_data=nma_str,
            citation_map=citation_map or "No citation map available",
            n_studies=self._included_count,
        )
        prompt += self._section_fact_contract_block("results")
        prompt += self._section_citation_requirement_block("results", citation_map=citation_map)
        return self.call_llm(prompt, max_tokens=self._writing_tokens("section"))

    def _write_discussion(
        self,
        protocol: ResearchProtocol,
        results: MetaAnalysisResults,
        rob_results: list[StudyRoB],
        grade_profile: GRADEProfile = None,
        citation_map: str = "",
    ) -> str:
        po = results.primary_outcome

        if self._zh:
            het_interp = "低" if po.i_squared < 30 else "中等" if po.i_squared < 60 else "较大" if po.i_squared < 75 else "很大"
            primary_summary = (
                f"合并 {po.effect_measure} 为 {po.pooled_effect:.2f}"
                f"（95% CI：{po.ci_lower:.2f} 至 {po.ci_upper:.2f}；"
                f"p={'<0.001' if po.p_value < 0.001 else f'{po.p_value:.3f}'}），"
                f"基于 {po.n_studies} 项研究。"
            )
        else:
            het_interp = "low" if po.i_squared < 30 else "moderate" if po.i_squared < 60 else "substantial" if po.i_squared < 75 else "considerable"
            primary_summary = (
                f"The pooled {po.effect_measure} was {po.pooled_effect:.2f} "
                f"(95% CI: {po.ci_lower:.2f} to {po.ci_upper:.2f}; p={'<0.001' if po.p_value < 0.001 else f'{po.p_value:.3f}'}), "
                f"based on {po.n_studies} studies."
            )

        pb = results.publication_bias
        if self._zh:
            pub_interp = "未检测到" if not (pb and pb.egger_p_value and pb.egger_p_value < 0.1) else "Egger 检验提示存在"
        else:
            pub_interp = "not detected"
            if pb and pb.egger_p_value and pb.egger_p_value < 0.1:
                pub_interp = "suggested by Egger's test"

        rob_counts = {}
        for r in rob_results:
            j = r.overall_judgment or "Not assessed"
            rob_counts[j] = rob_counts.get(j, 0) + 1

        grade_interp = ""
        if grade_profile and grade_profile.outcomes:
            g = grade_profile.outcomes[0]
            if self._zh:
                grade_interp = f"GRADE 评级：{g.certainty} 确定性。"
            else:
                grade_interp = f"GRADE assessment: {g.certainty} certainty. "
            grade_interp += "; ".join(f"{d.domain}: {d.rating}" for d in g.domains)
        if not grade_interp:
            grade_interp = "未评估" if self._zh else "Not assessed"

        prompt = self._zh_prefix() + writing_prompts.DISCUSSION_PROMPT.format(
            primary_summary=primary_summary,
            heterogeneity_interpretation=f"{het_interp} (I²={po.i_squared:.1f}%)",
            pub_bias_interpretation=pub_interp,
            rob_summary=", ".join(f"{k}: {v}" for k, v in rob_counts.items()),
            grade_interpretation=grade_interp,
            n_studies=self._included_count,
            protocol_json=json.dumps(protocol.model_dump(), indent=2, ensure_ascii=False),
            citation_map=citation_map or "No citation map available",
        )
        methodology_context = str(getattr(self, "_methodology_citation_context", "") or "").strip()
        background_context = str(getattr(self, "_background_citation_context", "") or "").strip()
        if methodology_context or background_context:
            prompt += (
                "\n\n## Discussion citation context\n"
                "Use relevant citation numbers for comparison with prior evidence, guideline context, "
                "certainty limitations, and methods limitations; do not invent references.\n"
                f"{background_context}\n{methodology_context}".strip()
            )
        prompt += self._section_fact_contract_block("discussion")
        prompt += self._section_citation_requirement_block("discussion", citation_map=citation_map)
        return self.call_llm(prompt, max_tokens=self._writing_tokens("section"))

    def _write_conclusion(self, results: MetaAnalysisResults, grade_profile: GRADEProfile = None) -> str:
        po = results.primary_outcome

        # Derive GRADE certainty from grade_profile if available
        grade_certainty = None
        if grade_profile and grade_profile.outcomes:
            primary_outcome = grade_profile.outcomes[0] if grade_profile.outcomes else None
            if primary_outcome:
                grade_certainty = getattr(primary_outcome, 'certainty', None) or getattr(primary_outcome, 'overall_certainty', None)

        if self._zh:
            sig = "具有统计学意义" if po.p_value < 0.05 else "无统计学意义"
            primary_summary = (
                f"合并 {po.effect_measure}：{po.pooled_effect:.2f}"
                f"（95% CI：{po.ci_lower:.2f}~{po.ci_upper:.2f}，p={po.p_value:.4f}），{sig}"
            )
            if grade_certainty:
                grade_map = {"high": "高", "moderate": "中等", "low": "低", "very low": "极低"}
                certainty = grade_map.get(grade_certainty.lower(), grade_certainty)
            else:
                certainty = "中等" if po.i_squared < 50 else "低"
            het = "低" if po.i_squared < 30 else "中等" if po.i_squared < 60 else "较大"
            key_limitation = f"异质性为{het}（I²={po.i_squared:.1f}%）"
        else:
            sig = "statistically significant" if po.p_value < 0.05 else "not statistically significant"
            primary_summary = (
                f"Pooled {po.effect_measure}: {po.pooled_effect:.2f} "
                f"(95% CI: {po.ci_lower:.2f}-{po.ci_upper:.2f}, p={po.p_value:.4f}), {sig}"
            )
            if grade_certainty:
                certainty = grade_certainty.lower()
            else:
                certainty = "moderate" if po.i_squared < 50 else "low"
            key_limitation = f"heterogeneity was {'low' if po.i_squared < 30 else 'moderate' if po.i_squared < 60 else 'substantial'} (I²={po.i_squared:.1f}%)"

        prompt = self._zh_prefix() + writing_prompts.CONCLUSION_PROMPT.format(
            topic=self._topic or "",
            primary_summary=primary_summary,
            n_studies=po.n_studies,
            certainty=certainty,
            key_limitation=key_limitation,
        )
        prompt += self._section_fact_contract_block("conclusion")
        return self.call_llm(prompt, max_tokens=self._writing_tokens("short"))

    def _write_table1(self, studies: list[ExtractedStudy]) -> str:
        # Only include direct eligible RCTs in Table 1
        direct_studies = getattr(self, '_direct_rct_studies', None) or studies
        if not direct_studies:
            return ""
        prompt = self._zh_prefix() + writing_prompts.TABLE1_PROMPT.format(
            studies_json=json.dumps([s.characteristics.model_dump() for s in direct_studies], indent=2, ensure_ascii=False),
        )
        result = self.call_llm(prompt, max_tokens=self._writing_tokens("section"))

        # P4: Validate output is actually a markdown table, not prose
        if not self._is_valid_table(result):
            self.log("Table 1 validation failed (not a valid table), retrying with stronger constraint", level="warning")
            retry_prompt = prompt + (
                "\n\nCRITICAL: Your previous output was NOT a markdown table. "
                "You MUST output ONLY a markdown table with | delimiters. "
                "Do NOT include any prose paragraphs, section headers (摘要/背景/方法/结果/讨论/结论), "
                "or narrative text. ONLY the table."
            )
            result = self.call_llm(retry_prompt, max_tokens=self._writing_tokens("section"))
            if not self._is_valid_table(result):
                self.log("Table 1 retry also failed, using programmatic fallback", level="warning")
                result = self._build_table1_programmatic(direct_studies)
        return result

    @staticmethod
    def _is_valid_table(text: str) -> bool:
        """Check if text is a valid markdown table (not prose)."""
        lines = [l.strip() for l in text.strip().split('\n') if l.strip()]
        table_lines = [l for l in lines if l.startswith('|')]
        # Must have at least header + separator + 1 data row
        if len(table_lines) < 3:
            return False
        # Separator row must exist
        if not any('---' in l for l in table_lines):
            return False
        # More than 50% must be table lines
        if len(table_lines) < len(lines) * 0.5:
            return False
        # Must not contain prose section headers
        prose_markers = ['摘要', '背景', '方法', '结果', '讨论', '结论',
                         'Abstract', 'Background', 'Methods', 'Results', 'Discussion', 'Conclusion']
        for marker in prose_markers:
            if any(marker in l and not l.startswith('|') for l in lines):
                return False
        return True

    @staticmethod
    def _build_table1_programmatic(studies: list[ExtractedStudy]) -> str:
        """Deterministic Table 1 fallback — no LLM."""
        header = "| Study | Year | Design | Country | N | Population | Intervention | Control | Follow-up | Outcomes |"
        sep = "|---|---|---|---|---|---|---|---|---|---|"
        rows = []
        for s in studies:
            c = s.characteristics
            first = (c.authors[0].split()[0] if c.authors else "Unknown")
            label = f"{first} et al."
            n = str(c.total_sample_size or "NR")
            pop = (c.population_description or "NR")[:50].replace("|", "/")
            intv = (c.intervention_description or "NR")[:40].replace("|", "/")
            ctrl = (c.control_description or "NR")[:40].replace("|", "/")
            fu = (c.follow_up_duration or "NR").replace("|", "/")
            design = (c.study_design or "NR").replace("|", "/")
            outcomes = ", ".join(o.outcome_name for o in s.outcomes[:2] if o.outcome_name) or "NR"
            rows.append(f"| {label} | {c.year} | {design} | {c.country or 'NR'} | {n} | {pop} | {intv} | {ctrl} | {fu} | {outcomes} |")
        return header + "\n" + sep + "\n" + "\n".join(rows)

    def _build_study_results_text(self, studies: list[ExtractedStudy]) -> str:
        """Build per-study result summaries for narrative prompts.

        When a study has NO extractable quantitative outcome data, emit a mandatory
        "no data" statement so the LLM cannot hallucinate results.
        """
        lines = []
        for s in studies:
            c = s.characteristics
            first = _first_author(c.authors)
            has_quantitative = False
            outcomes_text = []
            for o in s.outcomes:
                # Check if any real numeric data exists
                has_effect = o.effect_size is not None
                has_continuous = (
                    o.mean_intervention is not None and o.sd_intervention is not None
                    and o.n_intervention is not None
                )
                has_dichotomous = (
                    o.events_intervention is not None and o.total_intervention is not None
                )
                has_hr = o.hazard_ratio is not None
                has_prop = o.events is not None and o.total_n is not None
                has_corr = o.correlation_r is not None

                if has_effect or has_continuous or has_dichotomous or has_hr or has_prop or has_corr:
                    has_quantitative = True
                    # Build descriptive text from actual data
                    parts = [o.outcome_name]
                    if has_effect:
                        measure = str(o.reported_effect_measure or "effect").strip()
                        parts.append(f"{measure}={o.effect_size}")
                        if o.ci_lower is not None and o.ci_upper is not None:
                            parts.append(f"95%CI: {o.ci_lower}-{o.ci_upper}")
                        if o.p_value is not None:
                            source_quote = str(o.source_quote or "")
                            operator = "<" if re.search(r"\bp\s*<", source_quote, flags=re.I) else "="
                            parts.append(f"p{operator}{o.p_value}")
                    elif has_continuous:
                        parts.append(f"mean_I={o.mean_intervention}, SD_I={o.sd_intervention}, N_I={o.n_intervention}")
                        if o.mean_control is not None:
                            parts.append(f"mean_C={o.mean_control}")
                    elif has_dichotomous:
                        parts.append(f"events_I={o.events_intervention}/{o.total_intervention}")
                        if o.events_control is not None:
                            parts.append(f"events_C={o.events_control}/{o.total_control}")
                    elif has_hr:
                        parts.append(f"HR={o.hazard_ratio}")
                        if o.hr_ci_lower is not None:
                            parts.append(f"95%CI: {o.hr_ci_lower}-{o.hr_ci_upper}")
                    elif has_prop:
                        parts.append(f"events={o.events}/{o.total_n}")
                    elif has_corr:
                        parts.append(f"r={o.correlation_r}, N={o.correlation_n}")
                    outcomes_text.append(", ".join(parts))
                else:
                    # NO quantitative data for this outcome
                    if o.outcome_name:
                        outcomes_text.append(
                            f"{o.outcome_name}: 未提供具体数据，无法判断效应方向"
                            if self._zh else
                            f"{o.outcome_name}: no quantitative data provided; effect direction cannot be determined"
                        )
                    else:
                        outcomes_text.append(
                            "未提供具体数据，无法判断效应方向"
                            if self._zh else
                            "no quantitative data provided; effect direction cannot be determined"
                        )

            if not outcomes_text:
                outcomes_text.append(
                    "未提供具体数据，无法判断效应方向"
                    if self._zh else
                    "no quantitative data provided; effect direction cannot be determined"
                )
            outcome_str = "; ".join(outcomes_text)
            lines.append(f"- {first} {c.year} (N={c.total_sample_size or 'NR'}): {outcome_str}")
        return "\n".join(lines)

    def _build_rob_summary_text(self, rob_results: list[StudyRoB]) -> str:
        """Build risk of bias summary text."""
        if not rob_results:
            return "Not assessed"
        rob_counts = {}
        for r in rob_results:
            j = r.overall_judgment or "Not assessed"
            rob_counts[j] = rob_counts.get(j, 0) + 1
        return ", ".join(f"{k}: {v}" for k, v in rob_counts.items())

    def _build_qualitative_certainty(self, studies: list[ExtractedStudy], rob_results: list[StudyRoB]) -> str:
        """Build qualitative evidence certainty assessment for narrative mode."""
        zh = self._zh
        n = len(studies)
        # P6: When no direct eligible studies, report "no direct evidence" not "low certainty"
        if n == 0 or getattr(self, '_included_count', 0) == 0:
            if zh:
                return ("未纳入直接研究，无法进行正式证据确定性评级。"
                        "当前结论为直接证据缺失，而非低质量证据。")
            return ("No direct eligible studies; certainty cannot be formally assessed. "
                    "The finding is absence of direct evidence, not low-quality evidence.")
        rob_summary = self._build_rob_summary_text(rob_results)

        # Count high/unclear/low risk of bias
        high_rob = sum(1 for r in (rob_results or []) if "high" in (r.overall_judgment or "").lower())
        low_rob = sum(1 for r in (rob_results or []) if "low" in (r.overall_judgment or "").lower())

        if zh:
            parts = []
            parts.append(f"纳入 {n} 项研究。")
            if high_rob > n // 2:
                parts.append("多数研究偏倚风险较高。")
            elif low_rob > n // 2:
                parts.append("多数研究偏倚风险较低。")
            else:
                parts.append("研究偏倚风险参差不齐。")

            if n <= 3:
                parts.append("研究数量较少，证据不精确性较高。")
            elif n <= 5:
                parts.append("研究数量有限，可能存在不精确性。")

            if n > 0 and high_rob == 0 and low_rob >= n * 0.6:
                level = "中等"
            elif high_rob >= n * 0.5 or n <= 2:
                level = "很低"
            else:
                level = "低"
            parts.append(f"综合判断：证据总体确定性可能为{level}。")
            return " ".join(parts)
        else:
            parts = []
            parts.append(f"{n} studies included.")
            if high_rob > n // 2:
                parts.append("Most studies had high risk of bias.")
            elif low_rob > n // 2:
                parts.append("Most studies had low risk of bias.")
            else:
                parts.append("Risk of bias was mixed across studies.")

            if n <= 3:
                parts.append("The small number of studies leads to high imprecision.")
            elif n <= 5:
                parts.append("The limited number of studies may contribute to imprecision.")

            if n > 0 and high_rob == 0 and low_rob >= n * 0.6:
                level = "moderate"
            elif high_rob >= n * 0.5 or n <= 2:
                level = "very low"
            else:
                level = "low"
            parts.append(f"Overall certainty of evidence: possibly {level}.")
            return " ".join(parts)

    def _build_study_table_text(self, studies: list[ExtractedStudy]) -> str:
        """Build concise study characteristics for prompts."""
        rows = []
        for s in studies:
            c = s.characteristics
            first = _first_author(c.authors)
            rows.append(f"  {first} {c.year}: {c.study_design}, N={c.total_sample_size or 'NR'}, {c.country}")
        return "\n".join(rows)

    def _write_narrative_results(
        self,
        protocol: ResearchProtocol,
        studies: list[ExtractedStudy],
        rob_results: list[StudyRoB],
        prisma: dict,
        citation_map: str,
    ) -> str:
        has_rob = bool(rob_results)
        rob_text = self._build_rob_summary_text(rob_results) if has_rob else ""

        # Use only direct eligible studies for the narrative results table
        direct_studies = self._direct_rct_studies if self._direct_rct_studies else studies

        prompt = self._zh_prefix() + writing_prompts.NARRATIVE_RESULTS_PROMPT.format(
            prisma_json=json.dumps(prisma, indent=2),
            evidence_class_summary=getattr(self, '_evidence_class_summary', f'- Included studies: {len(direct_studies)}'),
            study_table=self._build_study_table_text(direct_studies),
            rob_summary=rob_text,
            individual_study_results=self._build_study_results_text(direct_studies),
            citation_map=citation_map or "No citation map available",
        )

        # If no RoB assessment was done, strip the RoB section from the prompt instructions
        if not has_rob:
            rob_instruction = "3. Risk of bias: describe risk of bias profile for each study\n"
            prompt = prompt.replace(rob_instruction, "")
            prompt += (
                "\n\nADDITIONAL NOTE: Risk of bias assessment was NOT performed for this review. "
                "Do NOT discuss risk of bias in the results section. "
                "Skip any RoB-related content entirely."
            )
        prompt += self._section_fact_contract_block("results")
        prompt += self._section_citation_requirement_block("narrative_results", citation_map=citation_map)

        result = self.call_llm(prompt, max_tokens=self._writing_tokens("section"))
        # Inject fixed programmatic sentence at the top of results
        if self._zh:
            fixed = (
                "由于纳入研究中可用于主要结局定量合并的数据不足，且/或研究间临床异质性较大，"
                "未进行定量Meta分析，以下结果采用叙述性综合方式呈现。\n\n"
            )
        else:
            fixed = (
                "Because fewer than two eligible studies were available, quantitative meta-analysis was not performed. "
                "The following results are presented as a narrative synthesis.\n\n"
            )
        return fixed + result

    def _write_narrative_discussion(
        self,
        protocol: ResearchProtocol,
        studies: list[ExtractedStudy],
        rob_results: list[StudyRoB],
        citation_map: str,
    ) -> str:
        zh = self._zh
        # Use direct eligible studies for discussion content
        direct_studies = self._direct_rct_studies if self._direct_rct_studies else studies
        findings = self._build_study_results_text(direct_studies)
        has_rob = bool(rob_results)
        rob_summary = self._build_rob_summary_text(rob_results) if has_rob else ""
        certainty = self._build_qualitative_certainty(direct_studies, rob_results)

        prompt = self._zh_prefix() + writing_prompts.NARRATIVE_DISCUSSION_PROMPT.format(
            findings_summary=findings,
            rob_summary=rob_summary,
            n_studies=self._included_count,
            protocol_json=json.dumps(protocol.model_dump(), indent=2, ensure_ascii=False),
            citation_map=citation_map or "No citation map available",
        )

        if not has_rob:
            prompt += (
                "\n\nADDITIONAL NOTE: Risk of bias assessment was NOT performed. "
                "Do NOT discuss risk of bias in the discussion. "
                "Remove any references to RoB tools, bias ratings, or bias-related limitations."
            )

        # Append certainty info as additional context to the prompt
        if zh:
            prompt += f"\n\n## 定性证据确定性判断（仅供参考，请融入讨论中）\n{certainty}"
        else:
            prompt += f"\n\n## Qualitative Evidence Certainty Assessment (for context, integrate into discussion)\n{certainty}"
        prompt += self._section_fact_contract_block("discussion")
        prompt += self._section_citation_requirement_block("narrative_discussion", citation_map=citation_map)
        return self.call_llm(prompt, max_tokens=self._writing_tokens("section"))

    def _write_narrative_conclusion(
        self,
        protocol: ResearchProtocol,
        studies: list[ExtractedStudy],
    ) -> str:
        zh = self._zh
        n = self._included_count
        direct_studies = self._direct_rct_studies if self._direct_rct_studies else studies
        findings_summary = self._build_study_results_text(direct_studies)
        if zh:
            key_limitation = f"仅纳入 {n} 项研究，可提取定量数据不足，未能进行定量Meta分析合并"
        else:
            key_limitation = f"Only {n} studies included with insufficient extractable quantitative data for meta-analysis"

        prompt = self._zh_prefix() + writing_prompts.NARRATIVE_CONCLUSION_PROMPT.format(
            findings_summary=findings_summary,
            n_studies=n,
            key_limitation=key_limitation,
        )
        prompt += self._section_fact_contract_block("conclusion")
        return self.call_llm(prompt, max_tokens=self._writing_tokens("short"))

    def _write_narrative_supplementary(self, studies: list, rob_results: list[StudyRoB]) -> str:
        """Narrative mode: conditional RoB summary + qualitative evidence certainty, no statistical tables."""
        zh = self._zh
        has_rob = bool(rob_results)
        parts = []

        # RoB summary table — only if RoB was actually assessed
        if has_rob:
            if zh:
                parts.append("### 补充表 S1：偏倚风险汇总\n")
                parts.append("| 研究 | 整体评价 | 工具 |")
            else:
                parts.append("### Supplementary Table S1: Risk of Bias Summary\n")
                parts.append("| Study | Overall Judgment | Tool |")
            parts.append("|---|---|---|")
            for r in rob_results:
                study_label = getattr(r, "study_id", "Unknown")
                parts.append(f"| {study_label} | {r.overall_judgment or 'N/A'} | {r.tool_used or 'N/A'} |")

        # Qualitative evidence certainty
        certainty = self._build_qualitative_certainty(studies, rob_results)
        if zh:
            parts.append("\n### 定性证据确定性判断\n")
            parts.append(certainty)
            if has_rob:
                parts.append("\n*注：此判断基于偏倚风险、研究数量、结果一致性的定性评估，"
                             "非正式 GRADE 量化评级。*")
            else:
                parts.append("\n*注：此判断仅基于研究数量和结果一致性，"
                             "因未进行偏倚风险评估，无法纳入偏倚风险维度。*")
        else:
            parts.append("\n### Qualitative Evidence Certainty\n")
            parts.append(certainty)
            if has_rob:
                parts.append("\n*Note: This assessment is based on a qualitative evaluation of risk of bias, "
                             "study count, and result consistency — not a formal GRADE rating.*")
            else:
                parts.append("\n*Note: This assessment is based only on study count and result consistency. "
                             "Risk of bias was not assessed and could not be incorporated.*")

        return "\n".join(parts)

    def _write_supplementary(self, results: MetaAnalysisResults, grade_profile: GRADEProfile = None) -> str:
        """Generate supplementary materials with detailed statistical tables."""
        po = results.primary_outcome
        zh = self._zh

        def _fmt_p(val: float) -> str:
            """Format p-value: avoid showing 0.0000."""
            if val < 0.0001:
                return "<0.0001"
            return f"{val:.4f}"

        if zh:
            lines = ["### 补充表 S1：详细统计结果\n"]
            lines.append("| 参数 | 数值 |")
        else:
            lines = ["### Supplementary Table S1: Detailed Statistical Results\n"]
            lines.append("| Parameter | Value |")
        lines.append("|---|---|")

        if zh:
            lines.append(f"| 效应量指标 | {po.effect_measure} |")
            model_map = {"fixed": "固定效应", "random": "随机效应", "narrative": "叙述性合成"}
            model_desc = model_map.get(po.model, po.model)
            if po.model == "random":
                model_desc += f"（{po.tau_estimator}）"
            lines.append(f"| 模型 | {model_desc} |")
            lines.append(f"| 合并效应量 | {po.pooled_effect:.4f} |")
            lines.append(f"| 95% CI | {po.ci_lower:.4f} 至 {po.ci_upper:.4f} |")
            lines.append(f"| p 值 | {_fmt_p(po.p_value)} |")
            lines.append(f"| Q 统计量 | {po.q_statistic:.2f} |")
            lines.append(f"| Q p 值 | {_fmt_p(po.q_p_value)} |")
            lines.append(f"| I² | {po.i_squared:.1f}% |")
            lines.append(f"| τ² | {po.tau_squared:.4f} |")
            lines.append(f"| H² | {po.h_squared:.2f} |")
            if po.prediction_interval:
                lines.append(f"| 预测区间 | {po.prediction_interval[0]:.4f} 至 {po.prediction_interval[1]:.4f} |")
            lines.append(f"| 纳入研究数 | {po.n_studies} |")
        else:
            lines.append(f"| Effect measure | {po.effect_measure} |")
            model_desc = "Narrative synthesis" if po.model == "narrative" else f"{po.model}-effect"
            if po.model == "random":
                model_desc += f" ({po.tau_estimator})"
            lines.append(f"| Model | {model_desc} |")
            lines.append(f"| Pooled effect | {po.pooled_effect:.4f} |")
            lines.append(f"| 95% CI | {po.ci_lower:.4f} to {po.ci_upper:.4f} |")
            lines.append(f"| p-value | {_fmt_p(po.p_value)} |")
            lines.append(f"| Q statistic | {po.q_statistic:.2f} |")
            lines.append(f"| Q p-value | {_fmt_p(po.q_p_value)} |")
            lines.append(f"| I² | {po.i_squared:.1f}% |")
            lines.append(f"| τ² | {po.tau_squared:.4f} |")
            lines.append(f"| H² | {po.h_squared:.2f} |")
            if po.prediction_interval:
                lines.append(f"| Prediction interval | {po.prediction_interval[0]:.4f} to {po.prediction_interval[1]:.4f} |")
            lines.append(f"| Number of studies | {po.n_studies} |")

        if results.meta_regression:
            if zh:
                lines.append("\n### 补充表 S2：Meta 回归结果\n")
            else:
                lines.append("\n### Supplementary Table S2: Meta-Regression Results\n")
            for mr in results.meta_regression:
                lines.append(
                    f"- {mr.covariate_name}: β={mr.coefficient:.4f} "
                    f"(p={mr.p_value:.4f}), R²={mr.r_squared_analog:.1%}"
                )

        if grade_profile:
            if zh:
                lines.append("\n### 补充表 S3：GRADE 证据概要\n")
                lines.append(
                    "| 结局 | 研究数 | 效应量 | 偏倚风险 | 不一致性 | 间接性 | 不精确性 | 发表偏倚 | 确定性 |"
                )
            else:
                lines.append("\n### Supplementary Table S3: GRADE Evidence Profile\n")
                lines.append(
                    "| Outcome | Studies | Effect | RoB | Inconsistency | Indirectness | Imprecision | Pub Bias | Certainty |"
                )
            lines.append("|---|---|---|---|---|---|---|---|---|")
            for go in grade_profile.outcomes:
                domains_map = {d.domain: d.rating for d in go.domains}
                lines.append(
                    f"| {go.outcome_name} | {go.n_studies} | {go.effect_summary} "
                    f"| {domains_map.get('risk_of_bias', 'N/A')} "
                    f"| {domains_map.get('inconsistency', 'N/A')} "
                    f"| {domains_map.get('indirectness', 'N/A')} "
                    f"| {domains_map.get('imprecision', 'N/A')} "
                    f"| {domains_map.get('publication_bias', 'N/A')} "
                    f"| **{go.certainty}** |"
                )

        return "\n".join(lines)

    def _generate_prisma_checklist(
        self,
        rob_results: list[StudyRoB] = None,
        grade_profile: GRADEProfile = None,
        figures_b64: dict | None = None,
    ) -> str:
        """Generate PRISMA 2020 checklist table, adapted to actual work done."""
        na = "未适用" if self._zh else "N/A"
        narrative = self._narrative_mode
        has_rob = bool(rob_results)
        has_grade = grade_profile is not None and hasattr(grade_profile, 'outcomes') and len(grade_profile.outcomes) > 0
        figure_numbers = self._figure_number_map(figures_b64 or {})

        def fig_location(key: str, fallback: str) -> str:
            number = figure_numbers.get(key)
            if not number:
                return fallback
            return f"结果，图{number}" if self._zh else f"Results, Figure {number}"

        selection_location = fig_location("prisma_diagram", "结果" if self._zh else "Results")
        synthesis_location = "结果" if self._zh else "Results"
        if not narrative:
            synthesis_location = fig_location("forest_plot", synthesis_location)
        reporting_bias_location = na if narrative else fig_location("funnel_plot", "结果" if self._zh else "Results")
        rob_location = fig_location("rob_plot", "结果" if self._zh and has_rob else "Results" if has_rob else na)

        if self._zh:
            lines = [
                "| 章节/主题 | 条目 # | 清单条目 | 报告位置 |",
                "|---|---|---|---|",
                "| **标题** | | | |",
                "| 标题 | 1 | 将报告标识为系统评价 | 标题 |",
                "| **摘要** | | | |",
                "| 摘要 | 2 | 结构化摘要（背景、方法、结果、结论） | 摘要 |",
                "| **引言** | | | |",
                "| 理论依据 | 3 | 描述现有知识背景中的研究依据 | 引言 |",
                "| 研究目的 | 4 | 明确陈述基于 PICO 的研究问题 | 引言 |",
                "| **方法** | | | |",
                "| 纳入排除标准 | 5 | 明确说明纳入和排除标准 | 方法 |",
                "| 信息来源 | 6 | 描述所有信息来源及检索日期 | 方法 |",
                "| 检索策略 | 7 | 展示所有数据库的完整检索策略 | 方法、附录 |",
                "| 筛选过程 | 8 | 说明文献筛选方法 | 方法 |",
                "| 数据提取 | 9 | 描述数据提取方法 | 方法 |",
                "| 数据条目 | 10a | 列出并定义所有结局变量 | 方法 |",
                f"| 偏倚风险 | 11 | 描述偏倚风险评估方法 | {'方法' if has_rob else na} |",
                f"| 效应量指标 | 12 | 说明所使用的效应量指标 | {'方法' if not narrative else na} |",
                f"| 合成方法 | 13a-f | 描述{'Meta分析方法' if not narrative else '叙述性合成方法'} | 方法 |",
                f"| 发表偏倚 | 14 | 描述发表偏倚评估方法 | {'方法' if not narrative else na} |",
                f"| 证据确定性 | 15 | 描述证据确定性评估方法 | {'方法' if has_grade else na} |",
                "| **结果** | | | |",
                f"| 文献筛选 | 16a-b | 报告检索和筛选结果（PRISMA 流程） | {selection_location} |",
                "| 研究特征 | 17 | 报告纳入研究特征 | 结果，表1 |",
                f"| 偏倚风险 | 18 | 报告偏倚风险评估结果 | {rob_location} |",
                f"| 合成结果 | 19a-d | 报告{'Meta分析结果' if not narrative else '各研究结果（叙述性）'} | {synthesis_location} |",
                f"| 发表偏倚 | 20a-b | 报告发表偏倚评估结果 | {reporting_bias_location} |",
                f"| 证据确定性 | 21 | 报告每个结局的 GRADE 评级 | {'结果' if has_grade else na} |",
                "| **讨论** | | | |",
                "| 讨论 | 22a-d | 综合解释、局限性、启示 | 讨论 |",
                "| **其他** | | | |",
                "| 注册信息 | 23a | 提供注册信息 | 不适用 |",
                "| 研究方案 | 23b | 说明研究方案获取途径 | 不适用 |",
                "| 资助来源 | 23c | 描述资金/非资金支持来源 | 不适用 |",
                "| 利益冲突 | 23d | 声明利益冲突 | 不适用 |",
                "| 数据可得性 | 23e | 描述数据和代码的可得性 | 不适用 |",
            ]
        else:
            lines = [
                "| Section/Topic | Item # | Checklist Item | Location |",
                "|---|---|---|---|",
                "| **TITLE** | | | |",
                "| Title | 1 | Identify the report as a systematic review | Title |",
                "| **ABSTRACT** | | | |",
                "| Abstract | 2 | Structured summary (background, methods, results, conclusions) | Abstract |",
                "| **INTRODUCTION** | | | |",
                "| Rationale | 3 | Describe the rationale in the context of existing knowledge | Introduction |",
                "| Objectives | 4 | Provide an explicit statement of the question(s) with PICO | Introduction |",
                "| **METHODS** | | | |",
                "| Eligibility criteria | 5 | Specify inclusion and exclusion criteria | Methods |",
                "| Information sources | 6 | Describe all information sources and date of search | Methods |",
                "| Search strategy | 7 | Present full search strategies for all databases | Methods, Appendix |",
                "| Selection process | 8 | Specify methods for study selection (screening) | Methods |",
                "| Data collection | 9 | Describe methods for data extraction | Methods |",
                "| Data items | 10a | List and define all outcome variables | Methods |",
                f"| Study risk of bias | 11 | Describe methods for assessing risk of bias | {'Methods' if has_rob else na} |",
                f"| Effect measures | 12 | Specify effect measures used | {'Methods' if not narrative else na} |",
                f"| Synthesis methods | 13a-f | Describe {'meta-analytic methods' if not narrative else 'narrative synthesis methods'} | Methods |",
                f"| Reporting bias | 14 | Describe methods for assessing publication bias | {'Methods' if not narrative else na} |",
                f"| Certainty assessment | 15 | Describe methods for assessing certainty (GRADE) | {'Methods' if has_grade else na} |",
                "| **RESULTS** | | | |",
                f"| Study selection | 16a-b | Report results of search, screening (PRISMA flow) | {selection_location} |",
                "| Study characteristics | 17 | Report study characteristics | Results, Table 1 |",
                f"| Risk of bias in studies | 18 | Report results of risk of bias assessments | {rob_location} |",
                f"| Results of syntheses | 19a-d | Report {'meta-analysis results' if not narrative else 'individual study results (narrative)'} | {synthesis_location} |",
                f"| Reporting biases | 20a-b | Report results of publication bias assessment | {reporting_bias_location} |",
                f"| Certainty of evidence | 21 | Report GRADE certainty for each outcome | {'Results' if has_grade else na} |",
                "| **DISCUSSION** | | | |",
                "| Discussion | 22a-d | General interpretation, limitations, implications | Discussion |",
                "| **OTHER** | | | |",
                "| Registration | 23a | Provide registration information | N/A |",
                "| Protocol | 23b | Indicate where the protocol can be accessed | N/A |",
                "| Support | 23c | Describe sources of financial/non-financial support | N/A |",
                "| Competing interests | 23d | Declare competing interests | N/A |",
                "| Data availability | 23e | Describe availability of data and code | N/A |",
            ]
        return "\n".join(lines)

    def _figure_catalog(self) -> list[tuple[str, str, str]]:
        """Return figure keys in the numbering order used across manuscript sections."""
        if self._narrative_mode:
            return [
                (
                    "prisma_diagram",
                    "PRISMA 流程图" if self._zh else "PRISMA flow diagram",
                    "PRISMA 2020 流程图，展示文献筛选过程。" if self._zh
                    else "PRISMA 2020 flow diagram showing the study selection process.",
                ),
            ]
        if self._zh:
            return [
                ("prisma_diagram", "PRISMA 流程图", "PRISMA 2020 流程图，展示文献筛选过程。"),
                ("forest_plot", "森林图", "森林图展示主要结局的研究层面效应量和合并估计值。"),
                ("funnel_plot", "漏斗图", "用于评估发表偏倚的漏斗图。垂直虚线表示合并效应估计值。"),
                ("rob_plot", "偏倚风险图", "偏倚风险汇总图，展示各纳入研究的领域判断。"),
                ("contour_funnel_plot", "轮廓增强漏斗图", "轮廓增强漏斗图，用于辅助区分小样本效应与发表偏倚模式。"),
                ("sensitivity_plot", "敏感性分析图", "逐一剔除敏感性分析图。"),
                ("cumulative_forest", "累积 Meta 分析图", "累积 Meta 分析森林图。"),
                ("nma_network", "网络图", "网络图，展示治疗比较的几何结构。"),
            ]
        return [
            ("prisma_diagram", "PRISMA flow diagram", "PRISMA 2020 flow diagram showing the study selection process."),
            ("forest_plot", "Forest plot", "Forest plot showing study-level and pooled effects for the primary outcome."),
            ("funnel_plot", "Funnel plot", "Funnel plot for assessment of publication bias. The vertical dashed line represents the pooled effect estimate."),
            ("rob_plot", "Risk-of-bias plot", "Risk-of-bias summary plot showing domain-level judgments across included studies."),
            ("contour_funnel_plot", "Contour-enhanced funnel plot", "Contour-enhanced funnel plot to help distinguish small-study effects from publication-bias patterns."),
            ("sensitivity_plot", "Sensitivity plot", "Leave-one-out sensitivity analysis plot."),
            ("cumulative_forest", "Cumulative meta-analysis plot", "Cumulative meta-analysis forest plot."),
            ("nma_network", "Network plot", "Network plot showing the geometry of treatment comparisons."),
        ]

    def _figure_number_map(self, figures_b64: dict) -> dict[str, int]:
        numbering = {}
        fig_num = 1
        for key, _, _ in self._figure_catalog():
            if not self._should_include_figure_key(key):
                continue
            if figures_b64.get(key):
                numbering[key] = fig_num
                fig_num += 1
        return numbering

    def _should_include_figure_key(self, key: str) -> bool:
        primary = self._manuscript_facts.get("primary_effect") if isinstance(self._manuscript_facts, dict) else {}
        try:
            n_studies = int((primary or {}).get("n_studies") or 0)
        except (TypeError, ValueError):
            n_studies = 0
        if n_studies and n_studies < 10 and key in {"funnel_plot", "contour_funnel_plot"}:
            return False
        if n_studies and n_studies < 3 and key in {"sensitivity_plot", "cumulative_forest"}:
            return False
        return True

    @staticmethod
    def _figure_file_map() -> dict[str, str]:
        return {
            "prisma_diagram": "prisma_diagram.png",
            "forest_plot": "forest_plot.png",
            "funnel_plot": "funnel_plot.png",
            "rob_plot": "rob_summary.png",
            "contour_funnel_plot": "contour_funnel_plot.png",
            "sensitivity_plot": "sensitivity.png",
            "cumulative_forest": "cumulative_forest.png",
            "nma_network": "nma_network.png",
        }

    def _embed_figures(self, figures_b64: dict, *, project: Project | None = None) -> str:
        """Embed generated figures by relative file path, never as base64 data URIs."""
        if not figures_b64:
            return ""
        lines = [f"## {self._t('figures')}", ""]
        figure_numbers = self._figure_number_map(figures_b64)
        figure_files = self._figure_file_map()
        for key, name, _ in self._figure_catalog():
            if not self._should_include_figure_key(key):
                continue
            b64 = figures_b64.get(key)
            fig_num = figure_numbers.get(key)
            if not b64 or not fig_num:
                continue
            filename = figure_files.get(key)
            if not filename:
                continue
            if project:
                figure_path = project.base_dir / "figures" / filename
                if not figure_path.exists() or figure_path.stat().st_size <= 0:
                    continue
            image_ref = f"../figures/{filename}"
            caption = f"图{fig_num}. {name}" if self._zh else f"Figure {fig_num}. {name}"
            lines.extend([
                f"![{caption}]({image_ref})",
                "",
                f"*{caption}*",
                "",
            ])
        if len(lines) <= 2:
            return ""  # No figures generated
        return "\n".join(lines).rstrip() + "\n"

    def _figure_legends(self, results: MetaAnalysisResults, figures_b64: dict) -> str:
        zh = self._zh

        if not figures_b64:
            return ""

        lines = [f"## {self._t('figure_legends')}\n"]
        figure_numbers = self._figure_number_map(figures_b64)
        for key, _, default_desc in self._figure_catalog():
            if not self._should_include_figure_key(key):
                continue
            fig_num = figure_numbers.get(key)
            if not fig_num:
                continue
            desc = default_desc
            if key == "forest_plot" and results and results.primary_outcome:
                po = results.primary_outcome
                desc = (
                    f"{po.outcome_name} 的森林图（{po.effect_measure}，{po.model}效应模型）。菱形表示合并效应估计值。"
                    if zh else
                    f"Forest plot of {po.outcome_name} ({po.effect_measure}, {po.model}-effect model). The diamond represents the pooled effect estimate."
                )
            lines.append(f"**图{fig_num}.** {desc}\n" if zh else f"**Figure {fig_num}.** {desc}\n")

        return "\n".join(lines)
