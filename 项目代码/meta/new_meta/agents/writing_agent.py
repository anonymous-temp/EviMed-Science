"""Writing agent — generates full manuscript section by section from structured data."""
from __future__ import annotations

import re

from new_meta.core.agent_base import BaseAgent
from new_meta.core.claim_alignment import claim_alignment_input_hash
from new_meta.core.claim_source_resolver import resolve_claim_sources
from new_meta.core.artifact_package_citation_audit import build_citation_audit_review
from new_meta.core.project import Project
from new_meta.core.quality_gates import run_quality_gate
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.schemas.meta_result import MetaAnalysisResults
from new_meta.schemas.study import ExtractedStudy
from new_meta.schemas.risk_of_bias import StudyRoB
from new_meta.schemas.grade import GRADEProfile
from new_meta.core.manuscript_facts import (
    build_manuscript_facts,
    validate_and_repair_manuscript,
)
from new_meta.core.manuscript_text_metrics import (
    main_publication_word_count,
    manuscript_quality_gate,
    manuscript_style_audit,
    remove_near_duplicate_sentences,
)
from new_meta.config import LLM_MAX_TOKENS_WRITING
from new_meta.tools.reference_manager import ReferenceManager
from new_meta.tools.utils import first_author_lastname as _first_author
from new_meta.prompts import writing_prompts

from new_meta.agents.writing import (
    CitationRepairMixin,
    GradeTablesMixin,
    SemanticReviewMixin,
    CitationGroundingMixin,
    ClaimMapMixin,
    FallbackReportsMixin,
    PublicationPolishMixin,
    FallbackContentMixin,
    SectionWritersMixin,
    ConsistencyGuardsMixin,
)
from new_meta.agents.writing.contracts import (
    CitationGroundingPatch,
    CitationGroundingRevision,
    ClaimMapAuthoredSections,
    ClaimMapSectionDraft,
    ClaimSourceAlignmentItem,
    ClaimSourceAlignmentReview,
    ClinicalManuscriptReview,
    ClinicalManuscriptReviewIssue,
    FinalManuscriptReadinessIssue,
    FinalManuscriptReadinessReview,
    ManuscriptClaimItem,
    ManuscriptClaimMap,
    ManuscriptTitleCandidate,
    PUBLICATION_CITATION_DENSITY_MIN_WORDS,
    PUBLICATION_CITATION_DENSITY_PER_1000,
    PUBLICATION_CITATION_MAX_DENSITY_PER_1000,
    PUBLICATION_CITATION_MECHANICAL_MAX_MARKERS_PER_35_UNITS,
    PUBLICATION_CITATION_MECHANICAL_MIN_MARKERS,
    PUBLICATION_CITATION_MIN_SUBSTANTIAL_PARAGRAPH_WORDS,
    PUBLICATION_CITATION_MIN_UNIQUE_REFERENCES,
    PUBLICATION_DISCUSSION_MAX_PROSE_PARAGRAPHS,
    PUBLICATION_DISCUSSION_MAX_UNITS_EN,
    PUBLICATION_DISCUSSION_MAX_UNITS_ZH,
    PUBLICATION_DISCUSSION_MIN_PROSE_PARAGRAPHS,
    PUBLICATION_DISCUSSION_MIN_UNITS_EN,
    PUBLICATION_DISCUSSION_MIN_UNITS_ZH,
    PUBLICATION_DISCUSSION_TARGET_PROSE_PARAGRAPHS,
    PUBLICATION_INTERPRETIVE_CITED_PARAGRAPH_RATE,
    PUBLICATION_SECTION_CONTEXT_MIN_REFERENCES,
    SemanticGuardAdjudication,
    SemanticManuscriptPatch,
    SemanticManuscriptRevision,
    SemanticParagraphPatch,
    SemanticParagraphRevision,
    SemanticSubsectionPatch,
    SemanticSubsectionRevision,
    _EN_SECTIONS,
    _ZH_SECTIONS,
)


class WritingAgent(
    CitationRepairMixin,
    GradeTablesMixin,
    SemanticReviewMixin,
    CitationGroundingMixin,
    ClaimMapMixin,
    FallbackReportsMixin,
    PublicationPolishMixin,
    FallbackContentMixin,
    SectionWritersMixin,
    ConsistencyGuardsMixin,
    BaseAgent,
):

    def __init__(self, model: str = None, lang: str = "en", narrative_mode: bool = False, topic: str = ""):
        self._lang = lang
        self._narrative_mode = narrative_mode
        self._topic = topic
        self._included_count = 0
        self._manuscript_facts: dict = {}
        self._manuscript_claim_map: list[dict] = []
        system = writing_prompts.SYSTEM_PROMPT
        if narrative_mode:
            system += (
                "\n\nCRITICAL: This is a NARRATIVE SYSTEMATIC REVIEW, NOT a meta-analysis. "
                "Do NOT include any pooled effect estimates, forest plots, funnel plots, "
                "I², τ², sensitivity analysis, or other meta-analysis-specific content. "
                "Describe individual study results separately using narrative synthesis."
            )
        if topic:
            system += (
                f"\n\nSCOPE CONSTRAINT: This review is specifically about: {topic}. "
                f"Do NOT mention drugs, diseases, or outcomes that are unrelated to this topic. "
                f"For example, if this review is about {topic.split()[0] if topic.split() else topic}, "
                f"do NOT discuss drugs for other conditions or unrelated clinical outcomes. "
                f"Stay strictly within the scope of the research question above."
            )
        if lang == "zh":
            system += (
                "\n\nIMPORTANT: You must write the ENTIRE manuscript in **Chinese (中文)**. "
                "All section titles, body text, table headers, and figure legends must be in Chinese. "
                "Keep technical terms, drug names, statistical abbreviations, and references in their original form "
                "(e.g., HbA1c, I², RR, CI, metformin). "
                "Section titles should follow Chinese academic convention "
                "(摘要、引言、方法、结果、讨论、结论)."
            )
        else:
            system += (
                "\n\nIMPORTANT: You must write the ENTIRE manuscript in English. "
                "All section titles, body text, table headers, and figure legends must be in English. "
                "Do not translate section headings or the manuscript title into Chinese, even when source material "
                "contains Chinese text. Section titles must follow English academic convention "
                "(Abstract, Introduction, Methods, Results, Discussion, Conclusion)."
            )
        super().__init__("writing", system, model=model)

    @property
    def _zh(self) -> bool:
        return self._lang == "zh"

    def _t(self, key: str) -> str:
        return (_ZH_SECTIONS if self._zh else _EN_SECTIONS).get(key, key)

    def _declarations_section(self) -> str:
        """Return journal-style declarations that do not invent author-specific claims."""
        if self._zh:
            return "\n".join([
                f"## {self._t('declarations')}",
                "",
                "### 作者贡献（CRediT）",
                "具名作者应按 CRediT taxonomy 确认作者贡献声明，包括概念化、方法学、数据整理、正式分析、可视化、初稿写作、审阅与修改、监督和项目管理等角色；作者名单和个人贡献需由投稿团队确认，本文不虚构作者角色。",
                "",
                "### 致谢",
                "当前项目记录未提供需要单独致谢的个人、机构或服务。",
                "",
                "### 注册和方案",
                "本综述未在 PROSPERO 前瞻性注册。PICO、纳入标准、效应量指标和合成设置保存在导出包的 protocol.json 和 manuscript/manuscript_facts.json 中。",
                "",
                "### 伦理批准",
                "本研究综合已发表文献、注册记录和公开汇总数据，不涉及新的个体参与者招募或个体层面数据收集，通常不需要额外伦理审批。",
                "",
                "### 数据与代码可用性",
                "数据可得性声明：汇总提取数据、检索策略、分析输出、图表和审查记录随导出包提供，主要路径包括 protocol.json、manuscript/manuscript_facts.json、extraction/all_extractions.json、extraction/extraction_audit.json、analysis/effect_sizes.json、analysis/meta_results.json、analysis/grade_profile.json、figures/ 和 references.bib；未使用个体参与者数据。",
                "",
                "### 资助",
                "本研究未记录专门的外部资助来源。",
                "",
                "### 利益冲突",
                "本研究未记录利益冲突。",
            ])
        return "\n".join([
            f"## {self._t('declarations')}",
            "",
            "### Author contributions",
            "Named author roles were not supplied. The submitted version should include CRediT role assignments from the author team, covering roles such as conceptualization, methodology, data curation, formal analysis, visualization, drafting, review and editing, supervision, and project administration. No individual roles were inferred or invented.",
            "",
            "### Acknowledgements",
            "No individuals, institutions, or services requiring acknowledgement were supplied.",
            "",
            "### Registration and protocol",
            "This review was not prospectively registered in PROSPERO. The protocol-defining PICO, eligibility criteria, effect measure, and synthesis settings are preserved in protocol.json and manuscript/manuscript_facts.json in the export package.",
            "",
            "### Ethics approval",
            "This review synthesized published reports, trial registry records, and publicly available aggregate data; no new participant recruitment or individual participant data collection was performed.",
            "",
            "### Data and code availability",
            "Data availability statement: aggregate extracted data, search strategy, analysis outputs, figures, and review records are included in the export package at protocol.json, manuscript/manuscript_facts.json, extraction/all_extractions.json, extraction/extraction_audit.json, analysis/effect_sizes.json, analysis/meta_results.json, analysis/grade_profile.json, figures/, and references.bib. No individual participant data were used.",
            "",
            "### Funding",
            "No dedicated external funding source was recorded for this review.",
            "",
            "### Competing interests",
            "No competing interests were recorded for this review.",
        ])

    def _zh_prefix(self) -> str:
        """Chinese writing instruction + report state injection to prepend to every LLM prompt."""
        rs_inject = self._report_state_prefix()
        if not self._zh:
            return rs_inject
        return (
            "【重要指令】你必须使用中文撰写以下全部内容。"
            "所有标题、正文、表格表头、图例说明均使用中文。"
            "保留专业术语的英文原文（如 HbA1c、I²、RR、CI、metformin、PRISMA）。"
            "图表引用使用中文格式（如「图1」而非「Figure 1」，「表1」而非「Table 1」）。"
            "章节小标题使用中文学术规范（如「背景」而非「Background」，「方法」而非「Methods」）。"
            "不要在正文开头重复当前章节的大标题（如不要在「摘要」章节里再次写「**摘要**」）。"
            "PICO要素不要使用列表格式，直接用段落或加粗文本描述。"
            "正文中不要使用加粗格式（**...**），仅允许在段落首的小标题处使用加粗。"
            "不要对段落正文、数据描述、结论等普通文本加粗。\n\n"
        ) + rs_inject

    @staticmethod
    def _writing_tokens(kind: str = "section") -> int:
        """Token ceilings for manuscript writing, separated from extraction/screening budgets."""
        configured = max(int(LLM_MAX_TOKENS_WRITING), 8192)
        if kind == "title":
            return 256
        if kind == "short":
            return max(2048, min(configured, 4096))
        if kind == "abstract":
            return max(4096, min(configured, 8192))
        return configured

    def _quality_checked_validation(
        self,
        manuscript: str,
        facts: dict,
        validation: dict | None,
        *,
        project: Project | None = None,
    ) -> tuple[dict, dict, dict]:
        """Run final style/smoke checks and merge them into manuscript validation.

        Fact validation can happen before final citation and figure repairs. This
        method is deliberately called at save time so the artifacts users see are
        the same artifacts that passed the smoke gate.
        """
        base_validation = dict(validation or {})
        self._quality_checked_manuscript = manuscript
        style_audit = manuscript_style_audit(manuscript)
        quality_gate = manuscript_quality_gate(manuscript, facts, style_audit=style_audit)
        citation_audit = None
        if project:
            project.save_text("draft.md", manuscript, subdir="manuscript")
            try:
                citation_audit = build_citation_audit_review(project)
            except Exception as exc:
                citation_audit = {
                    "passed": False,
                    "summary": {"error_count": 1, "warning_count": 0},
                    "issues": [{
                        "code": "citation_audit_failed_to_run",
                        "kind": "citation_audit",
                        "severity": "fail",
                        "message": f"Citation audit failed to run: {exc}",
                    }],
                }
            if isinstance(citation_audit, dict) and self._citation_audit_has_repairable_grounding_issues(citation_audit):
                repaired, grounding_audit = self._llm_ground_citation_audit_issues(
                    manuscript,
                    facts,
                    citation_audit,
                )
                if int(grounding_audit.get("accepted_patches") or 0) > 0 and repaired != manuscript:
                    manuscript = self._normalize_citation_marker_style(repaired, lang=self._lang)
                    project.save_text("draft.md", manuscript, subdir="manuscript")
                    style_audit = manuscript_style_audit(manuscript)
                    quality_gate = manuscript_quality_gate(manuscript, facts, style_audit=style_audit)
                    try:
                        citation_audit = build_citation_audit_review(project)
                    except Exception as exc:
                        citation_audit = {
                            "passed": False,
                            "summary": {"error_count": 1, "warning_count": 0},
                            "issues": [{
                                "code": "citation_audit_failed_to_run",
                                "kind": "citation_audit",
                                "severity": "fail",
                                "message": f"Citation audit failed to run after grounding repair: {exc}",
                            }],
                        }
                project.save_json("citation_grounding_audit.json", grounding_audit, subdir="manuscript")
        merged = dict(base_validation)
        merged["quality_gate"] = {
            "passed": quality_gate.get("passed", False),
            "summary": quality_gate.get("summary", {}),
        }
        if isinstance(citation_audit, dict):
            merged["citation_audit"] = {
                "passed": bool(citation_audit.get("passed", False)),
                "summary": citation_audit.get("summary", {}),
            }
        issues = list(merged.get("issues") or [])
        for issue in quality_gate.get("issues") or []:
            if not isinstance(issue, dict):
                continue
            enriched = dict(issue)
            enriched.setdefault("kind", "manuscript_quality_gate")
            issues.append(enriched)
        if isinstance(citation_audit, dict):
            for issue in citation_audit.get("issues") or []:
                if not isinstance(issue, dict):
                    continue
                severity = str(issue.get("severity") or "").lower()
                if severity not in {"fail", "error"}:
                    continue
                enriched = dict(issue)
                enriched["kind"] = "citation_audit"
                enriched["severity"] = "error"
                issues.append(enriched)
        merged["issues"] = issues
        citation_passed = True if citation_audit is None else bool(citation_audit.get("passed", False))
        merged["passed"] = (
            bool(base_validation.get("passed", True))
            and bool(quality_gate.get("passed", False))
            and citation_passed
        )
        facts_summary = dict(merged.get("facts_summary") or {})
        final_main_word_count = main_publication_word_count(manuscript)
        facts_summary.setdefault("main_word_count", final_main_word_count)
        facts_summary["quality_gate_main_word_count"] = final_main_word_count
        facts_summary["quality_gate_error_count"] = int((quality_gate.get("summary") or {}).get("error_count") or 0)
        facts_summary["quality_gate_warning_count"] = int((quality_gate.get("summary") or {}).get("warning_count") or 0)
        if isinstance(citation_audit, dict):
            citation_summary = citation_audit.get("summary") or {}
            facts_summary["citation_audit_error_count"] = int(citation_summary.get("error_count") or 0)
            facts_summary["citation_audit_warning_count"] = int(citation_summary.get("warning_count") or 0)
        merged["facts_summary"] = facts_summary
        if project:
            project.save_json("manuscript_validation.json", merged, subdir="manuscript")
            project.save_json("manuscript_style_audit.json", style_audit, subdir="manuscript")
            project.save_json("manuscript_quality_gate.json", quality_gate, subdir="manuscript")
            if isinstance(citation_audit, dict):
                project.save_json("citation_audit_review.json", citation_audit, subdir="manuscript")
            self._save_submission_quality_gate(project)
        for issue in quality_gate.get("issues") or []:
            if not isinstance(issue, dict):
                continue
            level = "error" if issue.get("severity") == "error" else "warning"
            self.log(f"MANUSCRIPT QUALITY GATE: {issue.get('message')}", level=level)
        self._quality_checked_manuscript = manuscript
        return merged, style_audit, quality_gate

    def _save_submission_quality_gate(self, project: Project) -> dict:
        """Persist the project-level submission contract gate.

        ``manuscript_quality_gate.json`` checks the rendered text. The
        submission gate checks the surrounding evidence contract: claim map,
        citation contract, source alignment, authoring audit, benchmarks, and
        real-run smoke artifacts. A failed submission gate is still saved so UI
        and packaging layers do not mistake a text-clean draft for a
        submission-ready manuscript.
        """
        try:
            from new_meta.core.real_smoke import write_real_smoke_manifest
            write_real_smoke_manifest(project.base_dir)
        except Exception as exc:
            self.log(f"Could not write real smoke manifest: {exc}", level="warning")
        try:
            submission_gate = run_quality_gate(project.base_dir)
        except Exception as exc:
            submission_gate = {
                "status": "fail",
                "failed_count": 1,
                "warning_count": 0,
                "checks": [{
                    "name": "submission_quality_gate",
                    "status": "fail",
                    "message": f"Project-level submission quality gate failed to run: {exc}",
                }],
            }
            self.log(f"Could not run project-level submission quality gate: {exc}", level="warning")
        project.save_json("submission_quality_gate.json", submission_gate, subdir="manuscript")
        project.save_json("quality_gate.json", submission_gate, subdir="manuscript")
        return submission_gate

    def _strip_duplicate_heading(self, text: str, heading: str) -> str:
        """Remove a duplicate leading section heading from LLM output.

        Section bodies are wrapped in the canonical H2 by the caller.  Some
        providers nevertheless return their own Markdown or bold heading,
        occasionally translated into the other supported language.  Keeping
        that line creates a second top-level section and makes downstream
        validation inspect the short wrapper instead of the real body.
        """
        aliases = {
            "abstract": {"abstract", "摘要"},
            "introduction": {"introduction", "引言"},
            "methods": {"methods", "method", "方法"},
            "results": {"results", "result", "结果"},
            "discussion": {"discussion", "讨论"},
            "conclusion": {"conclusion", "conclusions", "结论"},
        }
        normalized_heading = re.sub(r"[^a-z\u4e00-\u9fff]+", "", str(heading or "").lower())
        accepted = {normalized_heading}
        for values in aliases.values():
            normalized_values = {
                re.sub(r"[^a-z\u4e00-\u9fff]+", "", value.lower())
                for value in values
            }
            if normalized_heading in normalized_values:
                accepted.update(normalized_values)
                break

        lines = str(text or "").splitlines()
        while lines and not lines[0].strip():
            lines.pop(0)
        if not lines:
            return ""
        first = lines[0].strip()
        candidate = re.sub(r"^#{1,6}\s*", "", first)
        candidate = re.sub(r"^\*\*(.*?)\*\*$", r"\1", candidate).strip().rstrip(":：")
        normalized_candidate = re.sub(r"[^a-z\u4e00-\u9fff]+", "", candidate.lower())
        if normalized_candidate in accepted:
            lines.pop(0)
            while lines and not lines[0].strip():
                lines.pop(0)
        return "\n".join(lines)

    def _report_state_prefix(self) -> str:
        """Build REPORT_STATE_INJECTION string from current report_state."""
        rs = getattr(self, '_report_state', None)
        if rs is None:
            return ""
        from new_meta.prompts.writing_prompts import REPORT_STATE_INJECTION
        return REPORT_STATE_INJECTION.format(
            report_type=rs.report_type,
            n_direct_eligible=rs.n_direct_eligible,
            n_analyzable_primary=rs.n_analyzable_primary,
            n_meta_eligible=rs.n_meta_eligible,
            total_sample_size_or_nr=str(rs.total_sample_size) if rs.total_sample_size else "NR",
            prisma_records_identified=rs.prisma_records_identified,
            prisma_after_dedup=rs.prisma_after_dedup,
            prisma_full_text_assessed=rs.prisma_full_text_assessed,
            prisma_source_database=getattr(rs, 'prisma_source_database', 0),
            prisma_source_user_upload=getattr(rs, 'prisma_source_user_upload', 0),
            search_end_year=rs.search_end_year or "N/A",
        )

    @staticmethod
    def _strip_code_block(text: str) -> str:
        """Remove markdown code block wrappers (```markdown ... ```)."""
        text = re.sub(r'^```\w*\n?', '', text.strip(), count=1)
        text = re.sub(r'\n?```\s*$', '', text, count=1)
        return text.strip()

    @staticmethod
    def _strip_body_bold(text: str) -> str:
        """Remove bold formatting from body text while preserving markdown headings.

        Keeps bold inside: # headings, table | rows, figure legends (**Figure X.**)
        Removes bold from: all other body text paragraphs.
        """
        lines = text.split("\n")
        out = []
        in_table = False
        for line in lines:
            stripped = line.strip()
            # Heading lines — keep as-is
            if stripped.startswith("#"):
                out.append(line)
                continue
            # Table lines — keep as-is
            if stripped.startswith("|"):
                in_table = True
                out.append(line)
                continue
            if in_table and not stripped.startswith("|"):
                in_table = False
            # Figure legend lines like **Figure 1.** or **图1.** — keep as-is
            if re.match(r"^\*\*(Figure|图)\s*\d+", stripped):
                out.append(line)
                continue
            # Body text — strip all **...** bold markers
            cleaned = re.sub(r"\*\*([^*]+)\*\*", r"\1", line)
            out.append(cleaned)
        return "\n".join(out)

    def run(
        self,
        protocol: ResearchProtocol,
        meta_results: MetaAnalysisResults = None,
        extracted_studies: list[ExtractedStudy] = None,
        rob_results: list[StudyRoB] = None,
        prisma_data: dict = None,
        search_query: str = "",
        search_date: str = "",
        project: Project = None,
        ref_manager: ReferenceManager = None,
        grade_profile: GRADEProfile = None,
        figures_b64: dict = None,
        evidence_classes: dict[str, str] = None,
        report_state=None,
    ) -> str:
        """Generate the complete manuscript."""
        from new_meta.core.evidence_gate import ReportState
        self.log(f"Generating manuscript (narrative_mode={self._narrative_mode})...")
        extracted_studies = extracted_studies or []
        rob_results = rob_results or []
        prisma_data = prisma_data or {}
        figures_b64 = figures_b64 or {}
        if project:
            self._clear_stale_manuscript_warnings(project)
        self._background_citation_context = self._load_background_citation_context(project, ref_manager)
        self._methodology_citation_context = self._load_methodology_citation_context(project, ref_manager)
        manuscript_facts = build_manuscript_facts(
            protocol=protocol,
            meta_results=meta_results,
            extracted_studies=extracted_studies,
            rob_results=rob_results,
            prisma_data=prisma_data,
            search_query=search_query,
            project=project,
            grade_profile=grade_profile,
        )
        manuscript_facts["output_language"] = self._lang
        if report_state is not None and getattr(report_state, "report_type", None) == "evidence_gap":
            self._force_report_state_evidence_gap(manuscript_facts, report_state)
        elif report_state is not None and getattr(report_state, "report_type", None) == "narrative":
            self._force_report_state_narrative(manuscript_facts, report_state)
        elif self._narrative_mode and not meta_results:
            self._force_narrative_mode_facts(manuscript_facts)
        manuscript_mode = self._resolve_manuscript_mode(protocol, manuscript_facts)
        manuscript_claim_map = self._build_manuscript_claim_map(protocol, manuscript_facts, manuscript_mode)
        llm_claim_map, claim_map_audit = self._llm_build_manuscript_claim_map(
            protocol,
            manuscript_facts,
            manuscript_claim_map,
        )
        if llm_claim_map:
            manuscript_claim_map = llm_claim_map
        claim_source_resolution = resolve_claim_sources(manuscript_claim_map, manuscript_facts)
        manuscript_claim_map = claim_source_resolution["claim_map"]
        manuscript_claim_map, claim_source_alignment = self._llm_align_claim_sources(
            manuscript_claim_map,
            manuscript_facts,
        )
        if claim_source_alignment.get("status") == "ok" and claim_source_alignment.get("changed"):
            claim_source_resolution = resolve_claim_sources(manuscript_claim_map, manuscript_facts)
            manuscript_claim_map = claim_source_resolution["claim_map"]
        if claim_source_alignment.get("status") == "ok":
            # Source resolution can add deterministic metadata or exclude an
            # unresolved item after the semantic review.  Bind the audit to
            # that exact final writable map so stale-audit detection compares
            # like with like.
            claim_source_alignment["alignment_input_hash"] = claim_alignment_input_hash(
                manuscript_claim_map,
                manuscript_facts,
                output_language=self._lang,
            )
        if isinstance(claim_map_audit, dict):
            claim_map_audit["source_resolution"] = claim_source_resolution.get("summary", {})
            claim_map_audit["unresolved_claims"] = claim_source_resolution.get("unresolved_claims", [])
            claim_map_audit["source_alignment"] = claim_source_alignment
        clinical_argument_chain = claim_map_audit.get("clinical_argument_chain") if isinstance(claim_map_audit, dict) else None
        if not clinical_argument_chain:
            clinical_argument_chain = [
                item.get("argument_step")
                for item in manuscript_claim_map
                if isinstance(item, dict) and item.get("argument_step")
            ]
        manuscript_facts["clinical_argument_chain"] = [
            str(item) for item in (clinical_argument_chain or []) if str(item or "").strip()
        ]
        manuscript_facts["manuscript_mode"] = manuscript_mode
        manuscript_facts["claim_map"] = manuscript_claim_map
        self._manuscript_facts = manuscript_facts
        self._manuscript_claim_map = manuscript_claim_map
        if project:
            project.save_json("manuscript_facts.json", manuscript_facts, subdir="manuscript")
            project.save_json("claim_map.json", manuscript_claim_map, subdir="manuscript")
            project.save_json("claim_map_audit.json", claim_map_audit, subdir="manuscript")
            project.save_json("claim_source_resolution_audit.json", claim_source_resolution, subdir="manuscript")
            project.save_json("claim_source_alignment_audit.json", claim_source_alignment, subdir="manuscript")
            project.save_json(
                "manuscript_plan.json",
                {
                    "mode": manuscript_mode,
                    "claim_map": manuscript_claim_map,
                    "output_language": self._lang,
                },
                subdir="manuscript",
            )
        if manuscript_facts.get("report_type") == "evidence_gap":
            self.log("Evidence readiness blocked publication-style writing; generating evidence-gap report.", level="warning")
            manuscript = self._write_evidence_gap_report(
                protocol=protocol,
                facts=manuscript_facts,
                extracted_studies=extracted_studies,
                prisma_data=prisma_data,
            )
            manuscript = remove_near_duplicate_sentences(manuscript)
            manuscript, fact_validation = validate_and_repair_manuscript(manuscript, manuscript_facts)
            if project:
                manuscript = self._normalize_structured_abstract_spacing(manuscript)
                fact_validation, _, _ = self._quality_checked_validation(
                    manuscript,
                    manuscript_facts,
                    fact_validation,
                    project=project,
                )
                manuscript = getattr(self, "_quality_checked_manuscript", manuscript)
                manuscript = self._normalize_structured_abstract_spacing(manuscript)
                project.save_text("draft.md", manuscript, subdir="manuscript")
            for issue in fact_validation.get("issues", []):
                level = "warning" if issue.get("severity") != "error" else "error"
                self.log(f"MANUSCRIPT FACT CHECK: {issue.get('message')}", level=level)
            self.log(f"Evidence-gap report saved ({len(manuscript)} chars, ~{len(manuscript.split())} words)")
            return manuscript

        if self._should_use_fact_locked_first(protocol, manuscript_facts, meta_results):
            self.log("Generating fact-locked meta manuscript before LLM prose.")
            return self._write_fact_locked_meta_and_save(
                protocol=protocol,
                facts=manuscript_facts,
                prisma_data=prisma_data,
                project=project,
                grade_profile=grade_profile,
                ref_manager=ref_manager,
            )

        # Use report_state as primary source of truth when available
        if report_state is not None:
            evidence_classes = report_state.evidence_classes

        evidence_classes = evidence_classes or {}

        # ── Build evidence classification summary ──
        self._evidence_classes = evidence_classes
        self._report_state = report_state
        direct_rct_ids = {sid for sid, cls in evidence_classes.items() if cls == "direct_eligible_rct"}
        indirect_ids = {sid for sid, cls in evidence_classes.items()
                        if cls in ("indirect_clinical", "posthoc_or_secondary", "real_world_evidence")}
        observational_ids = {sid for sid, cls in evidence_classes.items() if cls == "observational"}
        excluded_ids = {sid for sid, cls in evidence_classes.items()
                        if cls in ("excluded", "systematic_review_or_nma", "case_report",
                                   "basic_or_preclinical", "untraceable")}

        # Split studies into direct RCT vs others for table generation
        if report_state is not None:
            direct_set = set(report_state.direct_eligible_ids)
        else:
            direct_set = direct_rct_ids
        self._direct_rct_studies = [s for s in extracted_studies
                                     if (s.characteristics.pmid or s.characteristics.study_id) in direct_set]
        self._indirect_studies = [s for s in extracted_studies
                                   if (s.characteristics.pmid or s.characteristics.study_id) in indirect_ids]
        self._observational_studies = [s for s in extracted_studies
                                        if (s.characteristics.pmid or s.characteristics.study_id) in observational_ids]
        self._excluded_studies = [s for s in extracted_studies
                                   if (s.characteristics.pmid or s.characteristics.study_id) in excluded_ids]

        # If no evidence_classes provided, fall back to all studies as direct
        if not evidence_classes and report_state is None:
            self._direct_rct_studies = extracted_studies

        n_direct = len(self._direct_rct_studies)
        n_indirect = len(self._indirect_studies)
        n_observational = len(self._observational_studies)
        n_excluded = len(self._excluded_studies)

        ec_lines = [f"- Direct eligible RCTs: {n_direct}"]
        if n_indirect:
            ec_lines.append(f"- Indirect clinical evidence (post-hoc, real-world, non-randomized): {n_indirect}")
        if n_observational:
            ec_lines.append(f"- Observational (cohort, case-control, cross-sectional): {n_observational}")
        if n_excluded:
            ec_lines.append(f"- Excluded (reviews, case reports, animal/in vitro, untraceable): {n_excluded}")
        self._evidence_class_summary = "\n".join(ec_lines)

        # ── Single source of truth for included study count ──
        if report_state is not None:
            self._included_count = report_state.n_direct_eligible
        elif self._direct_rct_studies:
            self._included_count = len(self._direct_rct_studies)
        else:
            prisma_incl = prisma_data.get("included", {}).get("studies_included", 0)
            self._included_count = prisma_incl if prisma_incl > 0 else len(self._direct_rct_studies) or len(extracted_studies)

        # ── Fix PRISMA logical errors: 0→non-0 is impossible ──
        # If records_identified=0 but records_after_dedup>0, set identified=dedup
        ident = prisma_data.get("identification", {})
        ri = ident.get("records_identified", 0)
        rad = ident.get("records_after_dedup", 0)
        if ri == 0 and rad > 0:
            prisma_data["identification"]["records_identified"] = rad
            prisma_data["identification"]["duplicates_removed"] = 0
            self.log(f"修正PRISMA: records_identified 0→{rad}", level="warning")
        # Ensure monotonic: identified >= dedup >= screened >= assessed >= included
        screen = prisma_data.get("screening", {})
        elig = prisma_data.get("eligibility", {})
        incl = prisma_data.get("included", {})
        _ri = prisma_data["identification"].get("records_identified", 0)
        _rad = prisma_data["identification"].get("records_after_dedup", 0)
        _screened = screen.get("title_abstract_screened", 0)
        _assessed = elig.get("full_text_assessed", 0)
        _included = incl.get("studies_included", 0)
        if _ri == 0 and _rad == 0 and _screened == 0 and _assessed == 0 and _included == 0:
            # No PRISMA data at all — use included_count
            prisma_data["identification"]["records_identified"] = self._included_count
            prisma_data["identification"]["records_after_dedup"] = self._included_count
            prisma_data["identification"]["duplicates_removed"] = 0
            prisma_data.setdefault("screening", {})["title_abstract_screened"] = self._included_count
            prisma_data.setdefault("eligibility", {})["full_text_assessed"] = self._included_count
            prisma_data.setdefault("included", {})["studies_included"] = self._included_count

        # Build citation mapping for inline references
        citation_map = ""
        if ref_manager:
            cite_lines = []
            for s in extracted_studies:
                c = s.characteristics
                sid = c.pmid or c.study_id
                first = _first_author(c.authors)
                cite_num = ref_manager.cite(sid)
                cite_lines.append(f"  {first} {c.year} = {cite_num}")
            citation_map = "\n".join(cite_lines)

        try:
            sections = []

            # Title
            self.log("Writing Title...")
            title = self._write_section_with_retry(
                "Title",
                lambda: self._write_title(protocol, meta_results, extracted_studies),
            )
            sections.append(f"# {title}\n")

            # Abstract
            self.log("Writing Abstract...")
            abstract = self._strip_duplicate_heading(
                self._write_section_with_retry(
                    "Abstract",
                    lambda: self._write_abstract(protocol, meta_results, grade_profile, extracted_studies),
                ),
                self._t("abstract"),
            )
            sections.append(f"## {self._t('abstract')}\n\n{abstract}\n")

            # Introduction
            self.log("Writing Introduction...")
            intro = self._strip_duplicate_heading(
                self._write_section_with_retry("Introduction", lambda: self._write_introduction(protocol)),
                self._t("introduction"),
            )
            sections.append(f"## {self._t('introduction')}\n\n{intro}\n")

            # Methods
            self.log("Writing Methods...")
            methods = self._strip_duplicate_heading(
                self._write_section_with_retry(
                    "Methods",
                    lambda: self._write_methods(protocol, prisma_data, search_query, rob_results, search_date),
                ),
                self._t("methods"),
            )
            sections.append(f"## {self._t('methods')}\n\n{methods}\n")

            # Results
            self.log("Writing Results...")
            if self._narrative_mode:
                results = self._strip_duplicate_heading(
                    self._write_section_with_retry(
                        "Narrative Results",
                        lambda: self._write_narrative_results(
                            protocol, extracted_studies, rob_results, prisma_data, citation_map,
                        ),
                    ),
                    self._t("results"),
                )
            else:
                results = self._strip_duplicate_heading(
                    self._write_section_with_retry(
                        "Results",
                        lambda: self._write_results(
                            protocol, meta_results, extracted_studies, rob_results,
                            prisma_data, grade_profile, citation_map,
                        ),
                    ),
                    self._t("results"),
                )
            sections.append(f"## {self._t('results')}\n\n{results}\n")

            # Discussion
            self.log("Writing Discussion...")
            if self._narrative_mode:
                discussion = self._strip_duplicate_heading(
                    self._write_section_with_retry(
                        "Narrative Discussion",
                        lambda: self._write_narrative_discussion(
                            protocol, extracted_studies, rob_results, citation_map,
                        ),
                    ),
                    self._t("discussion"),
                )
            else:
                discussion = self._strip_duplicate_heading(
                    self._write_section_with_retry(
                        "Discussion",
                        lambda: self._write_discussion(
                            protocol, meta_results, rob_results, grade_profile, citation_map,
                        ),
                    ),
                    self._t("discussion"),
                )
            sections.append(f"## {self._t('discussion')}\n\n{discussion}\n")

            # Conclusion
            self.log("Writing Conclusion...")
            if self._narrative_mode:
                conclusion = self._strip_duplicate_heading(
                    self._write_section_with_retry(
                        "Narrative Conclusion",
                        lambda: self._write_narrative_conclusion(protocol, extracted_studies),
                    ),
                    self._t("conclusion"),
                )
            else:
                conclusion = self._strip_duplicate_heading(
                    self._write_section_with_retry(
                        "Conclusion",
                        lambda: self._write_conclusion(meta_results, grade_profile),
                    ),
                    self._t("conclusion"),
                )
            sections.append(f"## {self._t('conclusion')}\n\n{conclusion}\n")

            # Supplementary Materials
            self.log("Generating Supplementary Materials...")
            if self._narrative_mode:
                supp = self._write_narrative_supplementary(extracted_studies, rob_results)
            else:
                supp = self._write_supplementary(meta_results, grade_profile)
            if supp:
                sections.append(f"## {self._t('supplementary')}\n\n{supp}\n")

            # PRISMA 2020 Checklist
            self.log("Generating PRISMA 2020 Checklist...")
            prisma_checklist = self._generate_prisma_checklist(rob_results, grade_profile, figures_b64)
            sections.append(f"## {self._t('prisma_checklist')}\n\n{prisma_checklist}\n")

            # Tables — skip Table 1 in evidence_gap mode (no direct eligible studies)
            self.log("Generating Tables...")
            if report_state is None or report_state.report_type != "evidence_gap":
                table1 = self._strip_code_block(self._write_table1(extracted_studies))
                sections.append(f"## {self._t('tables')}\n\n### {self._t('table1_title')}\n\n{table1}\n")

            # Figures (embed actual images)
            fig_section = self._embed_figures(figures_b64, project=project)
            if fig_section:
                sections.append(fig_section)

            # Figure legends — only for figures that actually exist
            legend_section = self._figure_legends(meta_results, figures_b64)
            if legend_section:
                sections.append(legend_section)

            sections.append(self._declarations_section())

            # References
            if ref_manager:
                sections.append(f"## {self._t('references')}\n\n{ref_manager.to_numbered_list()}\n")
            else:
                sections.append(f"## {self._t('references')}\n\n{self._t('ref_fallback')}\n")

            manuscript = "\n\n".join(sections)
            if project:
                open_headings = ["引言", "结果", "讨论", "结论"] if self._zh else [
                    "Introduction", "Results", "Discussion", "Conclusion",
                ]
                accepted_headings = [
                    heading for heading in open_headings
                    if str(self._h2_section_body(manuscript, heading) or "").strip()
                ]
                project.save_json(
                    "claim_map_authoring_audit.json",
                    {
                        "schema_version": 1,
                        "enabled": True,
                        "status": "ok" if accepted_headings else "skipped",
                        "mode": "section_generation_with_fact_contract",
                        "accepted_sections": len(accepted_headings),
                        "accepted_headings": accepted_headings,
                        "claim_map_items": len(manuscript_claim_map),
                        "reason": "" if accepted_headings else "no_open_argument_sections",
                    },
                    subdir="manuscript",
                )
        except Exception as exc:
            return self._handle_publication_style_generation_failure(
                protocol=protocol,
                facts=manuscript_facts,
                prisma_data=prisma_data,
                project=project,
                error=exc,
                grade_profile=grade_profile,
                ref_manager=ref_manager,
            )

        # Strip bold from body text — keep bold only in markdown headings and table headers
        manuscript = self._strip_body_bold(manuscript)

        # Post-write consistency validation
        manuscript = self._validate_consistency(manuscript)

        # 【一】结论确定性措辞修复
        manuscript = self._enforce_hedged_language(manuscript)

        # 【八+九】Narrative 模式约束 + 自动一致性检查
        if self._narrative_mode:
            manuscript = self._enforce_narrative_constraints(manuscript)

        # 【新1】禁止跨研究整合（检测测量异质性）
        manuscript = self._enforce_no_cross_study_synthesis(manuscript, extracted_studies)

        # 【新2】禁止无依据推测性解释
        manuscript = self._enforce_no_speculation(manuscript)

        # 【新3】统计表达修复（p=0.0→p<0.001，单位缺失标记）
        manuscript = self._fix_statistical_expressions(manuscript)

        # 【新3b】单位一致性校验（mg/dL vs mmol/L等）
        manuscript = self._check_unit_consistency(manuscript, extracted_studies)

        # 【新3c】医学合理性校验（体重异常增加、HbA1c方向异常）
        manuscript = self._check_medical_plausibility(manuscript)

        # 【新4】PICO一致性校验（人群+主要结局）
        manuscript = self._check_pico_consistency(manuscript, extracted_studies, protocol)

        # 【新4b】RoB工具约束（全RCT时移除NOS引用）
        manuscript = self._enforce_rob_tool_constraint(manuscript, rob_results)

        # 【九】自动一致性检查 — 少量研究降级 + 缺失统计量说明
        manuscript = self._auto_consistency_check(manuscript, extracted_studies, grade_profile, rob_results)

        # 【六】PRISMA清单与正文一致性
        manuscript = self._fix_prisma_checklist_consistency(manuscript, rob_results, grade_profile)

        # 【新5】PRISMA确定性标签修复（narrative模式定性评估标注）
        manuscript = self._fix_prisma_certainty_labels(manuscript, rob_results, grade_profile)

        # 【新5b】表格研究名规范（PMID → 作者+年份）
        manuscript = self._fix_table_study_names(manuscript, extracted_studies)

        # 【新6】结构修复（重复标题、空章节）
        manuscript = self._fix_structure(manuscript)

        # 【新6a】投稿主文语气与讨论压缩（避免流程复盘、重复临床主题）
        manuscript = self._polish_publication_body_language(manuscript)

        # 【新6c】正文引用兜底（正式稿不能只有参考文献列表，没有主文引用）
        manuscript = self._backfill_publication_inline_citations(manuscript)
        manuscript = self._backfill_publication_figure_references(manuscript)
        manuscript = self._backfill_publication_figure_legends(manuscript)
        manuscript = self._backfill_publication_table_notes(manuscript)
        manuscript = self._cap_dominant_primary_trial_citations_from_references(manuscript)
        manuscript = self._normalize_citation_marker_style(manuscript, lang=self._lang)
        manuscript = self._repair_covid_contextual_citation_attribution(manuscript)
        manuscript = self._normalize_citation_marker_style(manuscript, lang=self._lang)
        manuscript = re.sub(
            r"(These rows did not affect the selected primary mortality comparisons or the pooled estimate)\s*\[[^\]\n]+\]",
            r"\1",
            manuscript,
        )
        manuscript = self._repair_markdown_image_syntax(manuscript)

        # 【十】Report state consistency check
        manuscript = self._check_report_state_consistency(manuscript)

        # 【新6b】语言统一检查（结构元素）
        manuscript = self._check_language_uniformity(manuscript)

        # 【新7】narrative模式最终约束（强化）
        if self._narrative_mode:
            manuscript = self._enforce_narrative_final(manuscript)

        # ====== Meta分析专用后处理 ======
        # 【Meta-1】禁止"做Meta又否定Meta"
        manuscript = self._fix_meta_contradiction(manuscript)

        # 【Meta-2】效应方向校验
        manuscript = self._check_effect_direction(manuscript, meta_results)

        # 【Meta-4】异常值处理
        manuscript = self._check_outliers(manuscript, extracted_studies)

        # 【Meta-5】剂量组处理
        manuscript = self._check_dose_groups(manuscript, extracted_studies)

        # 【Meta-6】发表偏倚限制（<10项研究）
        manuscript = self._enforce_pub_bias_limit(manuscript, extracted_studies)

        # 【Meta-7】纳入标准一致性
        manuscript = self._check_inclusion_criteria(manuscript, extracted_studies, protocol)

        # 【Meta-8】注册信息占位符清理
        manuscript = self._clean_registration_placeholders(manuscript)

        # Narrative mode: enforce title must not contain "Meta分析"
        if self._narrative_mode:
            manuscript = self._enforce_narrative_title(manuscript)

        # P10: Final consistency check
        rs = getattr(self, '_report_state', None)
        if rs is not None:
            manuscript, issues = self._final_consistency_check(manuscript, rs, prisma_data)
            for issue in issues:
                self.log(f"FINAL CHECK: {issue}", level="warning")

        manuscript, citation_plan_audit = self._apply_claim_map_citations(manuscript, manuscript_facts)
        manuscript = self._normalize_citation_marker_style(manuscript, lang=self._lang)
        if project:
            project.save_json("final_claim_map_citation_plan.json", citation_plan_audit, subdir="manuscript")
            self._save_citation_contract(project, manuscript_facts)

        manuscript, fact_validation = validate_and_repair_manuscript(manuscript, manuscript_facts)
        manuscript = self._backfill_after_fact_repair(manuscript)
        if project:
            project.save_json("manuscript_validation.json", fact_validation, subdir="manuscript")
        for issue in fact_validation.get("issues", []):
            level = "warning" if issue.get("severity") != "error" else "error"
            self.log(f"MANUSCRIPT FACT CHECK: {issue.get('message')}", level=level)
        if self._needs_fact_locked_rewrite(fact_validation):
            self.log(
                "Substantive fact repairs were needed after LLM drafting; rewriting with the fact-locked manuscript template.",
                level="warning",
            )
            manuscript = self._write_meta_fallback_report(
                protocol=protocol,
                facts=manuscript_facts,
                prisma_data=prisma_data,
                grade_profile=grade_profile,
                project=project,
                ref_manager=ref_manager,
            )
            manuscript, fact_validation = validate_and_repair_manuscript(manuscript, manuscript_facts)
            manuscript = self._backfill_after_fact_repair(manuscript)
            manuscript = self._normalize_figure_heading_spacing(manuscript)
            manuscript = self._repair_markdown_image_syntax(manuscript)
            if project:
                project.save_json("manuscript_validation.json", fact_validation, subdir="manuscript")
            for issue in fact_validation.get("issues", []):
                level = "warning" if issue.get("severity") != "error" else "error"
                self.log(f"FACT-LOCKED MANUSCRIPT CHECK: {issue.get('message')}", level=level)
        if not fact_validation.get("passed", False):
            if project:
                project.save_text("draft.rejected.md", manuscript, subdir="manuscript")
            manuscript = self._write_validation_blocked_report(
                protocol=protocol,
                facts=manuscript_facts,
                validation=fact_validation,
            )
            self.log(
                "Manuscript failed hard validation; saved validation-blocked report instead of publication-style draft.",
                level="error",
            )

        manuscript = re.sub(
            r"(These rows did not affect the selected primary mortality comparisons or the pooled estimate)\s*\[[^\]\n]+\]",
            r"\1",
            manuscript,
        )
        manuscript = self._normalize_figure_heading_spacing(manuscript)
        manuscript = self._repair_markdown_image_syntax(manuscript)
        manuscript = remove_near_duplicate_sentences(manuscript)
        manuscript = self._repair_markdown_image_syntax(manuscript)
        manuscript = self._normalize_structured_abstract_spacing(manuscript)
        manuscript, final_fact_validation = validate_and_repair_manuscript(manuscript, manuscript_facts)
        manuscript = self._normalize_figure_heading_spacing(manuscript)
        manuscript = self._repair_markdown_image_syntax(manuscript)
        manuscript = self._normalize_structured_abstract_spacing(manuscript)
        if not final_fact_validation.get("passed", False):
            fact_validation = final_fact_validation
            if project:
                project.save_text("draft.rejected.md", manuscript, subdir="manuscript")
            manuscript = self._write_validation_blocked_report(
                protocol=protocol,
                facts=manuscript_facts,
                validation=fact_validation,
            )
            self.log(
                "Final manuscript failed hard validation after post-processing; saved validation-blocked report instead of publication-style draft.",
                level="error",
            )
        else:
            fact_validation = final_fact_validation

        # Save
        if project:
            manuscript = self._normalize_structured_abstract_spacing(manuscript)
            fact_validation, _, _ = self._quality_checked_validation(
                manuscript,
                manuscript_facts,
                fact_validation,
                project=project,
            )
            manuscript = getattr(self, "_quality_checked_manuscript", manuscript)
            if not fact_validation.get("passed", False):
                project.save_text("draft.rejected.md", manuscript, subdir="manuscript")
                manuscript = self._write_validation_blocked_report(
                    protocol=protocol,
                    facts=manuscript_facts,
                    validation=fact_validation,
                )
                fact_validation, _, _ = self._quality_checked_validation(
                    manuscript,
                    manuscript_facts,
                    fact_validation,
                    project=project,
                )
                manuscript = getattr(self, "_quality_checked_manuscript", manuscript)
            manuscript = self._normalize_structured_abstract_spacing(manuscript)
            project.save_text("draft.md", manuscript, subdir="manuscript")
        self.log(f"Manuscript saved ({len(manuscript)} chars, ~{len(manuscript.split())} words)")

        return manuscript
