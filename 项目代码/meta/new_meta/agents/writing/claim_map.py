"""Citation context, the manuscript claim map and fact-locked writing."""
from __future__ import annotations

from collections import Counter
import json
import math
import re

from new_meta.core.claim_alignment import (
    claim_alignment_input_hash,
    claim_alignment_payload,
    source_backed_claims_for_alignment,
)
from new_meta.core.project import Project
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.schemas.meta_result import MetaAnalysisResults
from new_meta.schemas.grade import GRADEProfile
from new_meta.schemas.manuscript_contract import (
    CitationContract,
    CitationContractItem,
    SourceSpan,
)
from new_meta.core.manuscript_facts import validate_and_repair_manuscript
from new_meta.core.manuscript_polish import preservation_guard_issues
from new_meta.core.manuscript_text_metrics import remove_near_duplicate_sentences
from new_meta.tools.reference_manager import ReferenceManager

from new_meta.agents.writing.contracts import (
    ClaimSourceAlignmentReview,
    ManuscriptClaimMap,
    PUBLICATION_CITATION_MIN_SUBSTANTIAL_PARAGRAPH_WORDS,
    PUBLICATION_INTERPRETIVE_CITED_PARAGRAPH_RATE,
    SemanticParagraphRevision,
)

from new_meta.agents.writing.citation_repair import CitationRepairMixin
from new_meta.agents.writing.grade_tables import GradeTablesMixin


class ClaimMapMixin:
    """Citation context, the manuscript claim map and fact-locked writing."""

    @staticmethod
    def _clear_stale_manuscript_warnings(project: Project) -> None:
        """Remove stale writer-failure warnings before attempting a fresh manuscript run."""
        warnings = project.load_json("pipeline_warnings.json") or []
        if not isinstance(warnings, list):
            return
        kept = [
            item for item in warnings
            if not (item.get("stage") == "writing" and item.get("code") == "manuscript_llm_failed")
        ]
        if len(kept) != len(warnings):
            project.save_json("pipeline_warnings.json", kept)

    def _load_background_citation_context(
        self,
        project: Project | None,
        ref_manager: ReferenceManager | None,
        *,
        max_items: int = 8,
    ) -> str:
        """Load Evimed/background evidence references as prompt-ready citation context."""
        self._background_reference_ids = []
        if not project or not ref_manager:
            return ""
        context = project.load_json("evidence_context.json", subdir="search") or {}
        references = context.get("references") or []
        lines: list[str] = []
        for item in references:
            if not isinstance(item, dict):
                continue
            study_id = str(item.get("study_id") or "").strip()
            if not study_id:
                continue
            citation = ref_manager.cite(study_id)
            if citation == "[?]":
                citation = str(item.get("citation") or "").strip()
            if not citation or citation == "[?]":
                continue
            self._background_reference_ids.append(study_id)
            title = str(item.get("title") or (item.get("paper") or {}).get("title") or "").strip()
            source_type = str(item.get("source_type") or "background").replace("_", " ")
            year = str((item.get("paper") or {}).get("year") or "").strip()
            summary = self._shorten(item.get("summary") or item.get("question") or "", 260)
            detail = " ".join(part for part in (year, title) if part)
            if summary:
                detail = f"{detail}: {summary}" if detail else summary
            lines.append(f"- {citation} {source_type}: {detail}".strip())
            if len(lines) >= max_items:
                break
        return "\n".join(lines)

    def _background_citation_groups(self, cite_map: dict[str, str], *, group_size: int = 3) -> list[str]:
        """Return compact citation clusters for background references."""
        numbers: list[int] = []
        for study_id in getattr(self, "_background_reference_ids", []) or []:
            citation = cite_map.get(str(study_id), "")
            for match in re.finditer(r"\d+", citation):
                try:
                    numbers.append(int(match.group(0)))
                except ValueError:
                    continue
        numbers = sorted(dict.fromkeys(number for number in numbers if number > 0))
        if not numbers:
            return []
        groups = []
        for i in range(0, len(numbers), max(1, group_size)):
            groups.append(self._citation_cluster(numbers[i:i + group_size]))
        return groups

    def _covid_corticosteroid_claim_cites(
        self,
        refs_text: str,
        cite_map: dict[str, str],
        background_cites: list[str],
    ) -> dict[str, str]:
        """Map COVID corticosteroid claims to supporting reference roles.

        This is deliberately claim-oriented. The previous density-based citation
        repairs could attach whichever citation was available; this map keeps
        trial-specific, benchmark, non-oxygen, and background claims separate.
        """
        trial_patterns = {
            "recovery": [r"Dexamethasone in Hospitalized Patients with Covid-19", r"NEJMoa2021436", r"NCT04381936"],
            "codex": [r"CoDEX", r"Tomazini", r"10\.1001/jama\.2020\.17021", r"NCT04327401"],
            "remap_cap": [r"REMAP-CAP.*Corticosteroid", r"10\.1001/jama\.2020\.17022", r"NCT02735707"],
            "cape_covid": [r"CAPE COVID", r"10\.1001/jama\.2020\.16761", r"NCT02517489"],
            "dexa_covid_19": [r"DEXA-COVID", r"10\.1186/s13063-020-04643-1", r"NCT04325061"],
            "covid_steroid": [r"COVID STEROID", r"NCT04348305", r"2020-001395-15"],
            "steroids_sari": [r"Steroids-SARI", r"NCT04244591", r"COVID-NMA"],
        }
        cites = {
            key: self._citation_for_reference_patterns(refs_text, patterns)
            for key, patterns in trial_patterns.items()
        }
        cites["who_react"] = cite_map.get("benchmark:who_react", "") or self._citation_for_reference_patterns(
            refs_text,
            [r"WHO REACT", r"10\.1001/jama\.2020\.17023"],
        )
        cites["non_oxygen"] = self._citation_for_reference_patterns(
            refs_text,
            [r"Not Receiving Oxygen", r"EVIDoa2200283", r"NEJM evidence"],
        )
        cites["ards_background"] = self._citation_for_reference_patterns(
            refs_text,
            [r"COVID-19 and non-COVID-19 ARDS", r"10\.1007/s00134-021-06394-2"],
        )
        cites["steroid_reviews"] = self._citation_for_reference_patterns(
            refs_text,
            [
                r"Corticosteroids in COVID-19 and non-COVID-19 ARDS",
                r"Dexamethasone for treating SARS-CoV-2",
                r"COVID-19, corticosteroids and public health",
            ],
        )
        cites["primary_trials"] = self._merge_citation_suffixes(
            cites.get("recovery", ""),
            cites.get("codex", ""),
            cites.get("remap_cap", ""),
            cites.get("cape_covid", ""),
            cites.get("dexa_covid_19", ""),
            cites.get("covid_steroid", ""),
            cites.get("steroids_sari", ""),
        ).strip()
        cites["dexamethasone_trials"] = self._merge_citation_suffixes(
            cites.get("recovery", ""),
            cites.get("codex", ""),
        ).strip()
        cites["hydrocortisone_trials"] = self._merge_citation_suffixes(
            cites.get("remap_cap", ""),
            cites.get("cape_covid", ""),
            cites.get("covid_steroid", ""),
        ).strip()
        cites["small_opposite_trials"] = self._merge_citation_suffixes(
            cites.get("dexa_covid_19", ""),
            cites.get("covid_steroid", ""),
        ).strip()
        if not cites.get("steroid_reviews"):
            cites["steroid_reviews"] = (background_cites[0] if background_cites else "")
        if not cites.get("ards_background"):
            cites["ards_background"] = cites.get("steroid_reviews", "")
        for key, value in list(cites.items()):
            text = str(value or "")
            if text and not text.startswith(" "):
                cites[key] = f" {text}"
        return cites

    def _load_methodology_citation_context(
        self,
        project: Project | None,
        ref_manager: ReferenceManager | None,
        *,
        max_items: int = 10,
    ) -> str:
        """Load PRISMA/GRADE/statistical method references for methods/discussion prompts."""
        if not project or not ref_manager:
            return ""
        context = project.load_json("methodology_context.json", subdir="search") or {}
        lines: list[str] = []
        for item in context.get("references") or []:
            if not isinstance(item, dict):
                continue
            study_id = str(item.get("study_id") or "").strip()
            citation = ref_manager.cite(study_id) if study_id else ""
            if citation == "[?]":
                citation = str(item.get("citation") or "").strip()
            if not citation or citation == "[?]":
                continue
            source_type = str(item.get("source_type") or "methodology").replace("_", " ")
            paper = item.get("paper") or {}
            title = str(item.get("title") or paper.get("title") or "").strip()
            year = str(paper.get("year") or "").strip()
            detail = " ".join(part for part in (year, title) if part)
            lines.append(f"- {citation} {source_type}: {detail}".strip())
            if len(lines) >= max_items:
                break
        return "\n".join(lines)

    @staticmethod
    def _cite_suffix(groups: list[str], index: int) -> str:
        if index < len(groups) and groups[index]:
            return f" {groups[index]}"
        return ""

    @staticmethod
    def _cite_ids(cite_map: dict[str, str], *study_ids: str) -> str:
        numbers: list[int] = []
        for study_id in study_ids:
            citation = cite_map.get(str(study_id), "")
            for match in re.finditer(r"\d+", citation):
                try:
                    numbers.append(int(match.group(0)))
                except ValueError:
                    continue
        cluster = CitationRepairMixin._citation_cluster(numbers)
        return f" {cluster}" if cluster else ""

    @staticmethod
    def _cite_ids_for_rows(cite_map: dict[str, str], rows: list[dict]) -> str:
        study_ids: list[str] = []
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            for key in ("study_id", "pmid", "trial_id", "registry_id", "nct_id"):
                value = str(row.get(key) or "").strip()
                if value and value not in study_ids:
                    study_ids.append(value)
            row_id = str(row.get("row_id") or "").strip()
            if ":" in row_id:
                prefix = row_id.split(":", 1)[0].strip()
                if prefix and prefix not in study_ids:
                    study_ids.append(prefix)
        return ClaimMapMixin._cite_ids(cite_map, *study_ids)

    @staticmethod
    def _merge_citation_suffixes(*citations: str) -> str:
        numbers: list[int] = []
        for citation in citations:
            numbers.extend(CitationRepairMixin._citation_numbers_from_text(str(citation or "")))
        cluster = CitationRepairMixin._citation_cluster(numbers)
        return f" {cluster}" if cluster else ""

    def _section_citation_requirement_block(self, section: str, citation_map: str = "") -> str:
        """Prompt-level citation targets to reduce post-hoc citation backfilling."""
        section_key = str(section or "").strip().lower()
        background_numbers = CitationRepairMixin._citation_numbers_from_text(
            str(getattr(self, "_background_citation_context", "") or "")
        )
        methodology_numbers = CitationRepairMixin._citation_numbers_from_text(
            str(getattr(self, "_methodology_citation_context", "") or "")
        )
        background_cluster = CitationRepairMixin._citation_cluster(background_numbers[:6])
        methodology_cluster = CitationRepairMixin._citation_cluster(methodology_numbers[:8])
        lines: list[str] = []
        zh = self._zh

        if section_key in {"introduction", "narrative_introduction"} and background_cluster:
            if zh:
                lines.append(
                    f"引言：至少引用2条背景、指南或既往综述来源；优先使用已列出的上下文引用，如 {background_cluster}。"
                )
            else:
                lines.append(
                    "Introduction: cite at least 2 background/guideline/prior-review sources "
                    f"when available, using the listed context citations such as {background_cluster}."
                )
        elif section_key in {"methods", "method"} and methodology_cluster:
            if zh:
                lines.append(
                    "方法：引用报告规范和方法学来源来支持PRISMA/检索报告、偏倚风险、GRADE、"
                    f"异质性、随机效应和发表偏倚方法；优先使用 {methodology_cluster}。"
                )
            else:
                lines.append(
                    "Methods: cite reporting standards and methods sources for PRISMA/search reporting, "
                    f"risk of bias, GRADE, heterogeneity, random-effects, and publication-bias methods using {methodology_cluster}."
                )
        elif section_key in {"results", "narrative_results"}:
            if citation_map and "No citation map" not in citation_map:
                if zh:
                    lines.append(
                        "结果：命名具体研究或描述研究层面结果时，使用Citation Map中的纳入研究编号；"
                        "不要把仅用于背景的参考文献当作研究报告引用。"
                    )
                else:
                    lines.append(
                        "Results: cite included studies from the Citation Map when naming studies or describing "
                        "study-level findings; do not cite background-only references as study reports."
                    )
        elif section_key in {"discussion", "narrative_discussion"}:
            targets = []
            if background_cluster:
                targets.append(
                    f"既往证据/指南 {background_cluster}" if zh else f"prior evidence/guidelines {background_cluster}"
                )
            if methodology_cluster:
                targets.append(
                    f"证据确定性和方法学局限 {methodology_cluster}"
                    if zh else
                    f"certainty and methods limitations {methodology_cluster}"
                )
            if targets:
                if zh:
                    lines.append("讨论：比较、确定性和局限性判断必须引用" + "；".join(targets) + "。")
                else:
                    lines.append(
                        "Discussion: cite comparison, certainty, and limitation claims with "
                        + "; ".join(targets)
                        + "."
                    )

        if not lines:
            return ""
        if zh:
            return (
                "\n\n## 章节引用要求\n"
                "撰写本节时必须满足以下要求。请严格保留方括号引用编号；不要虚构上下文之外的引用。\n"
                + "\n".join(f"- {line}" for line in lines)
            )
        return (
            "\n\n## Section citation requirements\n"
            "Use these requirements while drafting this section. Preserve bracket numbers exactly; "
            "do not invent citations beyond the supplied context.\n"
            + "\n".join(f"- {line}" for line in lines)
        )

    @staticmethod
    def _needs_fact_locked_rewrite(validation: dict) -> bool:
        """Use deterministic prose when the LLM draft needed substantive fact repair."""
        substantive_kinds = {
            "primary_count_mismatch",
            "patient_total_mismatch",
            "primary_ci_mismatch",
            "primary_effect_not_found",
            "publication_length_too_short",
            "non_primary_study_claim_repaired",
        }
        return any(
            issue.get("kind") in substantive_kinds
            and issue.get("severity") in {"fixed", "warning", "error"}
            for issue in validation.get("issues", [])
        )

    def _resolve_manuscript_mode(self, protocol: ResearchProtocol, facts: dict) -> str:
        """Choose the writing contract before rendering prose."""
        report_type = str((facts or {}).get("report_type") or "meta").strip().lower()
        if report_type in {"evidence_gap", "failed", "narrative", "benchmark_reconstruction"}:
            return report_type
        primary = (facts or {}).get("primary_effect") or {}
        n_studies = self._int(primary.get("n_studies"))
        if n_studies < 2:
            return "narrative"
        if self._is_covid_corticosteroid_topic(protocol) and self._allow_legacy_topic_template(facts):
            return "clinical_meta_analysis_with_published_anchor"
        return "clinical_meta_analysis"

    @staticmethod
    def _allow_legacy_topic_template(facts: dict | None) -> bool:
        """Legacy topic scripts are opt-in only.

        They are useful as regression fixtures, but publication generation
        should use the generic fact-locked skeleton plus LLM semantic editing
        rather than a topic-specific manuscript script.
        """
        constraints = (facts or {}).get("writing_constraints") if isinstance(facts, dict) else {}
        return bool(isinstance(constraints, dict) and constraints.get("allow_legacy_topic_template") is True)

    def _build_manuscript_claim_map(self, protocol: ResearchProtocol, facts: dict, mode: str) -> list[dict]:
        """Declare the finite set of claims the manuscript is allowed to make."""
        facts = facts or {}
        primary = facts.get("primary_effect") or {}
        population = facts.get("primary_population") or {}
        grade_outcomes = (facts.get("grade") or {}).get("outcomes") or []
        grade = grade_outcomes[0] if grade_outcomes else {}
        readiness = facts.get("evidence_readiness") or {}
        selected_rows = readiness.get("selected_primary_rows") or []
        outcome = primary.get("outcome_name") or protocol.pico.outcome_primary or "primary outcome"
        effect_measure = primary.get("effect_measure") or protocol.effect_measure
        effect = self._fmt(primary.get("pooled_effect"), 2)
        ci = f"{self._fmt(primary.get('ci_lower'), 2)} to {self._fmt(primary.get('ci_upper'), 2)}"
        n_studies = self._int(primary.get("n_studies"))
        total_n = self._int(population.get("selected_total_participants"))
        method_family = str(facts.get("method_family") or "")
        synthesis = facts.get("synthesis_result") if isinstance(facts.get("synthesis_result"), dict) else {}
        method_estimates = [item for item in synthesis.get("primary_estimates") or [] if isinstance(item, dict)]
        eligible_evidence_claim = (
            f"{n_studies} independent studies contributed to the prespecified {method_family.replace('_', ' ')} synthesis."
            if method_family else
            f"{n_studies} randomized trial comparisons contributed to the primary meta-analysis."
        )
        primary_effect_claim = (
            "The prespecified synthesis estimates were: " + "; ".join(
                f"{item.get('label')}: {item.get('measure')} {self._fmt(item.get('estimate'), 2)} "
                f"(95% CI {self._fmt(item.get('ci_lower'), 2)} to {self._fmt(item.get('ci_upper'), 2)})"
                for item in method_estimates
            ) + "."
            if method_family and method_estimates else
            f"The pooled {effect_measure} was {effect} (95% CI {ci})."
        )
        claims = [
            {
                "id": "objective",
                "section": "Introduction",
                "claim": f"The review evaluates {protocol.pico.intervention or 'the intervention'} versus {protocol.pico.comparator or 'the comparator'} for {outcome}.",
                "support_source": "protocol.pico",
            },
            {
                "id": "eligible_evidence",
                "section": "Results",
                "claim": eligible_evidence_claim,
                "support_source": "manuscript_facts.primary_effect.n_studies",
            },
            {
                "id": "primary_effect",
                "section": "Abstract/Results/Conclusion",
                "claim": primary_effect_claim,
                "support_source": (
                    "analysis.synthesis_result.primary_estimates"
                    if method_family else "analysis.meta_results.primary_outcome"
                ),
            },
            {
                "id": "participant_total",
                "section": "Abstract/Results",
                "claim": f"The selected primary comparisons included {total_n} participants.",
                "support_source": "manuscript_facts.primary_population",
            },
            {
                "id": "certainty",
                "section": "Results/Discussion",
                "claim": f"Certainty was {grade.get('certainty') or 'not assessed'} for the primary outcome.",
                "support_source": (
                    "analysis.method_certainty" if method_family else "analysis.grade_profile"
                ),
            },
            {
                "id": "source_basis",
                "section": "Methods/Supplementary Materials",
                "claim": "Contributing primary-outcome values must be linked to trial reports, registries, or living-data records.",
                "support_source": "evidence_readiness.selected_primary_rows",
                "row_count": len(selected_rows) if isinstance(selected_rows, list) else 0,
            },
            {
                "id": "limitations",
                "section": "Discussion",
                "claim": "Sparse study counts limit heterogeneity, small-study-effect, and subgroup interpretation.",
                "support_source": "manuscript_facts.primary_effect.n_studies",
            },
        ]
        if mode in {"clinical_meta_analysis_with_published_anchor", "benchmark_reconstruction"}:
            claims.append({
                "id": "published_anchor",
                "section": "Introduction/Discussion",
                "claim": "WHO REACT is a published reference synthesis for trial set and pooled effect, not the primary source of extracted counts.",
                "support_source": "references.benchmark:who_react + selected_primary_rows.source_location",
            })
            claims.append({
                "id": "clinical_boundary",
                "section": "Discussion/Conclusion",
                "claim": "The finding applies most directly to critically ill adults requiring respiratory or ICU-level support.",
                "support_source": "protocol.pico.population + selected_primary_rows.population_rank",
            })
        safety_note_examples = self._study_card_safety_note_examples(facts)
        if safety_note_examples:
            claims.append({
                "id": "safety_scope",
                "section": "Discussion",
                "claim": (
                    "Safety findings were available from study cards for narrative interpretation, but safety outcomes "
                    "were not quantitatively pooled in the primary efficacy synthesis."
                ),
                "support_source": "manuscript_facts.study_cards.safety_notes",
                "source_quote": " | ".join(safety_note_examples),
            })
        return claims

    def _llm_build_manuscript_claim_map(
        self,
        protocol: ResearchProtocol,
        facts: dict,
        base_claims: list[dict],
    ) -> tuple[list[dict] | None, dict]:
        """Use LLM evidence understanding to decide which claims can be written."""
        evidence_understanding = facts.get("evidence_understanding") if isinstance(facts.get("evidence_understanding"), dict) else {}
        background_evidence = facts.get("background_evidence") if isinstance(facts.get("background_evidence"), dict) else {}
        controversy_candidates = (
            facts.get("domain_controversy_candidates")
            if isinstance(facts.get("domain_controversy_candidates"), list)
            else []
        )
        study_cards = facts.get("study_cards") if isinstance(facts.get("study_cards"), list) else []
        has_llm_cards = any(card.get("evidence_understanding_available") for card in study_cards if isinstance(card, dict))
        has_background_evidence = bool(background_evidence.get("references")) or bool(controversy_candidates)
        safety_note_count = sum(
            len(card.get("safety_notes") or [])
            for card in study_cards
            if isinstance(card, dict)
        )
        safety_notes_by_study = [
            {
                "study_id": card.get("study_id") or card.get("display_name") or card.get("study_label") or "study_card",
                "display_name": card.get("display_name") or card.get("study_label") or card.get("study_id") or "Study",
                "safety_notes": card.get("safety_notes") or [],
            }
            for card in study_cards
            if isinstance(card, dict) and card.get("safety_notes")
        ]
        if not has_llm_cards and not evidence_understanding.get("cross_study_claims") and not has_background_evidence:
            return None, {
                "schema_version": 1,
                "enabled": True,
                "status": "skipped",
                "reason": "no_evidence_understanding_or_background_evidence_available",
            }

        primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
        population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
        grade = ((facts.get("grade") or {}).get("outcomes") or [{}])[0] if isinstance(facts.get("grade"), dict) else {}
        reporting_outcome = self._reporting_outcome_label(facts, protocol, zh=self._zh)
        endpoint_definition_caveat = self._endpoint_definition_caveat(facts, zh=self._zh)
        endpoint_definition_discussion = self._endpoint_definition_discussion(facts, zh=self._zh)
        facts_block = {
            "output_language": self._lang,
            "research_question": facts.get("research_question"),
            "pico": facts.get("pico"),
            "reporting_outcome_label": reporting_outcome,
            "endpoint_definition_caveat": endpoint_definition_caveat,
            "endpoint_definition_discussion": endpoint_definition_discussion,
            "claim_strength": self._claim_strength_guidance(facts),
            "report_type": facts.get("report_type"),
            "primary_effect": primary,
            "primary_population": population,
            "absolute_effects": facts.get("absolute_effects") or {},
            "grade": {
                "certainty": grade.get("certainty"),
                "effect_summary": grade.get("effect_summary"),
                "domains": grade.get("domains"),
            },
            "background_evidence": background_evidence,
            "domain_controversy_candidates": controversy_candidates[:16],
            "safety_notes_available": safety_note_count,
            "safety_notes_by_study": safety_notes_by_study[:8],
            "evidence_understanding": evidence_understanding,
            "study_cards": study_cards[:12],
            "base_claims": base_claims,
        }
        language_rule = "Chinese" if self._zh else "English"
        prompt = (
            "You are the claim architect for a clinical systematic review manuscript. Build a claim map before prose writing.\n\n"
            f"Respond in {language_rule}. Return JSON only.\n"
            "Do not write final manuscript paragraphs. Decide which claims can appear in Introduction, Discussion, and Conclusion.\n"
            "Use only structured facts, study cards, source-backed claims, background_evidence references, "
            "domain_controversy_candidates, and existing evidence-understanding notes. "
            "A claim can be written in main text only if it is supported by a structured fact, a source-backed claim, "
            "a background_evidence reference, or a clearly marked interpretive synthesis of those facts. "
            "For Introduction, add clinically useful background claims only when a background_evidence reference supports "
            "the exact assertion; include the reference study_id/citation in support_source or source_study_id and put "
            "the summary sentence in source_quote. For Discussion, add controversy/tension claims only when the supplied "
            "domain_controversy_candidates or study cards support them, such as endpoint interpretation, population "
            "heterogeneity, class-vs-agent applicability, safety tradeoffs, or guideline context. Unsupported clinical "
            "background, mechanism, safety, subgroup, novelty, or guideline claims must go into excluded_or_deferred_claims.\n\n"
            "Construct a layered clinical argument chain before selecting final claims. The chain should usually cover: "
            "clinical_problem, evidence_gap, objective, primary_finding, clinical_significance, endpoint_interpretation, "
            "applicability, evidence_limit, practice_implication, and future_research. Use only steps supported by the "
            "supplied material. Put the ordered chain in clinical_argument_chain, and set each claim's argument_step to "
            "the matching step. Claims without an argument_step are incomplete.\n\n"
            "Always include an Introduction objective/scope claim with claim_type='objective' that preserves the review "
            "PICO and primary outcome from the protocol or base_claims. Background claims must enrich this objective, "
            "not replace it.\n\n"
            "When background_evidence.references are available, the Introduction should usually have a small but real "
            "argument chain rather than only one background sentence: clinical_problem, evidence_context or endpoint "
            "relevance, and objective. Use only references whose title/summary supports the assertion, and put any "
            "unsupported background idea into excluded_or_deferred_claims.\n\n"
            "If reporting_outcome_label or endpoint_definition_caveat is supplied, use that outcome wording in result, "
            "discussion, and conclusion claims. Do not collapse a broader worsening-heart-failure endpoint into a "
            "hospitalization-only endpoint. Treat endpoint_definition_caveat as the detailed Methods wording. For "
            "Discussion endpoint claims, do not name individual trials or list their component definitions when Methods "
            "already contains endpoint_definition_caveat; use endpoint_definition_discussion itself as the claim text "
            "and keep trial names/component definitions in source_quote, Methods, or tables only.\n\n"
            "Calibrate clinical claim strength to claim_strength. When certainty is not high or fewer than three studies "
            "contribute, prefer cautious effect verbs such as 'may reduce' or 'suggests a reduction' rather than stronger "
            "phrasing such as 'reduces', 'establishes', or 'points toward a lower risk'.\n\n"
            "If background_evidence.references are supplied, include 2-4 Introduction or Discussion background claims "
            "unless the references are off-topic. If domain_controversy_candidates are supplied, include 2-4 Discussion "
            "claims from them when they are supported by the supplied facts. At least one of those claims should use "
            "claim_type='controversy' for endpoint interpretation, class-vs-agent uncertainty, subgroup heterogeneity, "
            "safety tradeoff, or evidence tension; at least one should use claim_type='applicability' for population or "
            "practice-boundary interpretation. If no controversy is truly supported, put the rejected controversy "
            "candidate in excluded_or_deferred_claims with a short reason. "
            "Do not replace these with generic cautionary language.\n\n"
            "If study_cards contain safety_notes, include one Discussion claim with claim_type='safety' and "
            "argument_step='safety_scope'. That claim should summarize only the safety information actually present "
            "in the safety_notes and should distinguish narrative safety interpretation from quantitative pooling. "
            "When safety_notes_available is greater than zero, do not write that structured data lack safety notes, "
            "adverse-event counts, discontinuation counts, or source safety information; instead write that safety was "
            "not pooled quantitatively if no safety meta-analysis was supplied. "
            "If safety_notes are absent, do not make safety central in the Introduction; instead place any need for "
            "future safety extraction in excluded_or_deferred_claims.\n\n"
            "For each claim, fill support_source and, when study-level, source_study_id/source_location/source_quote. "
            "Set claim_type to objective, background, controversy, result, applicability, safety, limitation, or conclusion. "
            "The source_quote or structured fact location must support every clinical phrase in the claim. Do not infer "
            "'historically limited treatment options', 'disease-modifying therapy', 'clinically meaningful benefit', "
            "'class effect', 'confirmation', or guideline impact unless those exact ideas are present in supplied sources. "
            "When using GRADE domain facts, write reader-facing clinical rationale rather than internal variable names: "
            "do not use OIS, CI crosses null, Total N, Rule-based, P/I/C/design, structured GRADE, or similar audit terms. "
            "If absolute_effects are supplied, claims may discuss the reported absolute-risk translation, events per 1000, "
            "or NNT using those exact structured values; never claim that ARR, absolute effects, or NNT were not provided. "
            "If absolute effects are not supplied, describe the endpoint as clinically important rather than asserting an "
            "absolute clinical benefit. Applicability claims should define where the result most directly applies, not "
            "state that benefit is confirmed in a subgroup.\n"
            "If primary_effect is supplied, do not say that cross-study synthesis, comparison, or integration is impossible. "
            "You may say that low study count limits heterogeneity, publication-bias, subgroup, component-outcome, or class-effect "
            "inferences, but the prespecified pooled primary effect remains a valid synthesis of the contributing rows.\n"
            "For a full meta-analysis with available primary effect data, aim for 8-14 main-text claims across the chain. "
            "Prefer a complete, source-backed clinical argument over a short abstract-like claim list. Include an "
            "authoring_strategy that explains the clinical arc: why the question matters, what the result means, where it "
            "applies, and what remains uncertain. Future-research claims must state what future studies should measure, "
            "compare, or clarify; do not use future_research to restate current heterogeneity, imprecision, or publication-bias "
            "statistics that already belong in evidence_limit.\n\n"
            "FACTS AND EVIDENCE UNDERSTANDING:\n"
            f"{json.dumps(facts_block, ensure_ascii=False, indent=2)[:26000]}"
        )
        audit = {
            "schema_version": 1,
            "enabled": True,
            "status": "ok",
        }
        try:
            claim_map = self.call_llm_structured(
                prompt,
                ManuscriptClaimMap,
                temperature=0.0,
                max_tokens=max(4096, min(self._writing_tokens("section"), 10000)),
            )
        except Exception as exc:
            audit.update({"status": "failed", "error": str(exc)[:500]})
            return None, audit
        claim_map, development_audit = self._llm_develop_claim_map_if_thin(
            claim_map=claim_map,
            facts_block=facts_block,
            initial_prompt_summary=claim_map.summary,
        )
        claims = [item.model_dump() for item in claim_map.claims if item.can_write_main_text and item.manuscript_use != "exclude"]
        claims, low_k_claim_rewrites = self._normalize_low_k_heterogeneity_claims(claims, facts_block)
        claims, claim_strength_rewrites = self._normalize_claim_strength_claims(claims, facts_block)
        claims, grade_public_language_rewrites = self._normalize_grade_public_claim_language(claims, facts_block)
        claims, absolute_effect_claim_rewrites = self._normalize_absolute_effect_claims(claims, facts_block)
        claims, safety_scope_inserted = self._ensure_safety_scope_claim(claims, facts_block)
        claims, primary_conclusion_inserted = self._ensure_primary_conclusion_claim(claims, facts_block)
        claims, duplicate_claim_merges = self._merge_duplicate_claim_map_claims(claims)
        if not claims:
            audit.update({"status": "empty", "summary": claim_map.summary})
            return None, audit
        audit.update({
            "summary": claim_map.summary,
            "claim_count": len(claims),
            "claim_map_development": development_audit,
            "background_evidence_count": len(background_evidence.get("references") or []),
            "domain_controversy_candidate_count": len(controversy_candidates),
            "excluded_or_deferred_count": len(claim_map.excluded_or_deferred_claims or []),
            "low_k_heterogeneity_claim_rewrites": low_k_claim_rewrites,
            "claim_strength_rewrites": claim_strength_rewrites,
            "grade_public_language_rewrites": grade_public_language_rewrites,
            "absolute_effect_claim_rewrites": absolute_effect_claim_rewrites,
            "safety_scope_claim_inserted": safety_scope_inserted,
            "primary_conclusion_claim_inserted": primary_conclusion_inserted,
            "duplicate_claim_merges": duplicate_claim_merges,
            "argument_step_counts": dict(Counter(str(item.get("argument_step") or "") for item in claims)),
            "clinical_argument_chain": claim_map.clinical_argument_chain,
            "authoring_strategy": claim_map.authoring_strategy,
        })
        return claims, audit

    def _llm_align_claim_sources(self, claims: list[dict], facts: dict) -> tuple[list[dict], dict]:
        """Use an LLM judge to align claim wording with its actual support.

        Deterministic source resolution answers "is there a source?". This pass
        answers the semantic question: "does the source support every clinical
        phrase in the claim?". It may narrow a claim or exclude it, but it does
        not invent new sources.
        """
        source_backed = source_backed_claims_for_alignment(claims)
        alignment_payload = claim_alignment_payload(claims, facts, output_language=self._lang)
        audit = {
            "schema_version": 1,
            "enabled": True,
            "status": "ok",
            "changed": False,
            "reviewed_claims": len(source_backed),
            "reviewed_claim_ids": alignment_payload.get("reviewed_claim_ids") or [],
            "alignment_input_hash": claim_alignment_input_hash(claims, facts, output_language=self._lang),
            "revised_claims": [],
            "excluded_claims": [],
        }
        if not source_backed:
            audit.update({"status": "skipped", "reason": "no_source_backed_claims"})
            return claims, audit
        compact_claims = alignment_payload.get("claims") or []
        facts_context = alignment_payload.get("facts_context") or {}
        language_rule = "Chinese" if self._zh else "English"
        prompt = (
            "You are a clinical evidence editor checking a claim map before manuscript authoring. "
            "This is a semantic source-alignment task, not a keyword filter.\n\n"
            f"Write reasons in {language_rule}. Return JSON only.\n"
            "For each claim, decide whether every clinical phrase is supported by its source_quote, support_source, "
            "structured facts, PICO, or study cards. If a claim contains an unsupported phrase, prefer decision='revise' "
            "and rewrite the claim narrowly so it is fully supported. Use decision='exclude' only when the source cannot "
            "support the claim after narrowing. Every important modifier, example, subgroup, comparator, outcome window, "
            "diagnostic tool, mechanism, guideline implication, and novelty statement must be explicitly supported by the "
            "claim's cited evidence or by the structured facts for that same claim. Examples introduced with 'e.g.', "
            "'including', 'such as', '如', or '包括' require exact support; if the source only supports a broader category, "
            "revise to that broader category. Do not import concepts from the title, search terms, general medical knowledge, "
            "or adjacent background sources. Do not intensify evidentiary strength: if the source says a trial 'reported', "
            "'showed', or 'suggested' an effect, avoid stronger wording such as 'confirmed', 'proven', 'established', "
            "'已证实', or '明确证明' unless the support itself warrants that strength. "
            "For applicability claims, use only the PICO boundary and study-card eligibility/intervention/outcome details; "
            "specific diagnostic scores, comorbidity subgroups, setting details, or extrapolated populations must appear "
            "in the claim's own source_quote or study cards. For internal analysis claims, exact values may be supported "
            "by primary_effect, absolute_effects, or grade. Preserve the claim id and section. Return one item for each "
            "claim that should be accepted, revised, or excluded.\n\n"
            "FACTS CONTEXT:\n"
            f"{json.dumps(facts_context, ensure_ascii=False, indent=2)[:12000]}\n\n"
            "CLAIMS TO REVIEW:\n"
            f"{json.dumps(compact_claims, ensure_ascii=False, indent=2)[:18000]}"
        )
        try:
            review = self.call_llm_structured(
                prompt,
                ClaimSourceAlignmentReview,
                temperature=0.0,
                max_tokens=4096,
            )
        except Exception as exc:
            audit.update({"status": "failed", "error": str(exc)[:500]})
            return claims, audit
        decisions = {str(item.id or "").strip(): item for item in review.items if str(item.id or "").strip()}
        if not decisions:
            audit["summary"] = review.summary
            return claims, audit
        updated: list[dict] = []
        for claim in claims:
            if not isinstance(claim, dict):
                continue
            claim_id = str(claim.get("id") or "").strip()
            decision = decisions.get(claim_id)
            if not decision:
                updated.append(claim)
                continue
            mode = str(decision.decision or "accept").strip().lower()
            if mode == "exclude":
                claim = dict(claim)
                claim["can_write_main_text"] = False
                claim["manuscript_use"] = "exclude"
                claim.setdefault("caveat", "")
                claim["caveat"] = (str(claim.get("caveat") or "") + " Source-alignment exclusion: " + decision.reason).strip()
                updated.append(claim)
                audit["changed"] = True
                audit["excluded_claims"].append({
                    "id": claim_id,
                    "reason": decision.reason,
                    "unsupported_phrases": decision.unsupported_phrases,
                })
                continue
            if mode == "revise" and str(decision.revised_claim or "").strip():
                claim = dict(claim)
                claim["claim"] = str(decision.revised_claim).strip()
                if str(decision.revised_caveat or "").strip():
                    claim["caveat"] = str(decision.revised_caveat).strip()
                updated.append(claim)
                audit["changed"] = True
                audit["revised_claims"].append({
                    "id": claim_id,
                    "reason": decision.reason,
                    "unsupported_phrases": decision.unsupported_phrases,
                })
                continue
            updated.append(claim)
        audit["summary"] = review.summary
        return updated, audit

    def _study_card_safety_note_examples(self, facts: dict, *, limit: int = 4) -> list[str]:
        examples: list[str] = []
        for card in (facts or {}).get("study_cards") or []:
            if not isinstance(card, dict):
                continue
            label = card.get("display_name") or card.get("study_label") or card.get("study_id") or "Study"
            for note in card.get("safety_notes") or []:
                text = re.sub(r"\s+", " ", str(note or "")).strip()
                if text:
                    examples.append(f"{label}: {text}")
                if len(examples) >= limit:
                    return examples
        return examples

    def _ensure_safety_scope_claim(self, claims: list[dict], facts: dict) -> tuple[list[dict], bool]:
        """Keep source-backed safety notes available to the Discussion claim map."""
        examples = self._study_card_safety_note_examples(facts)
        if not examples:
            return claims, False
        updated: list[dict] = []
        has_supported_safety_scope = False
        removed_contradiction = False
        for item in claims:
            if not isinstance(item, dict):
                updated.append(item)
                continue
            argument_step = str(item.get("argument_step") or "").strip().lower()
            claim_type = str(item.get("claim_type") or "").strip().lower()
            joined = " ".join(str(item.get(key) or "") for key in ("claim", "source_quote", "caveat", "support_source")).lower()
            is_safety = argument_step == "safety_scope" or claim_type == "safety"
            if is_safety and self._claim_text_negates_available_safety_notes(joined):
                removed_contradiction = True
                continue
            if is_safety:
                has_supported_safety_scope = True
            updated.append(item)
        if has_supported_safety_scope:
            return updated, removed_contradiction
        safety_source_ids: list[str] = []
        for card in (facts or {}).get("study_cards") or []:
            if not isinstance(card, dict) or not (card.get("safety_notes") or []):
                continue
            study_id = str(card.get("study_id") or card.get("pmid") or "").strip()
            if study_id and study_id.lower() != "none" and study_id not in safety_source_ids:
                safety_source_ids.append(study_id)

        if self._zh:
            claim_text = (
                "研究卡片中已有安全性信息，可用于叙述性获益-风险解释；"
                "但本次主要疗效合成未对安全性结局进行定量合并。"
            )
        else:
            claim_text = (
                "Trial safety notes were available for narrative benefit-harm interpretation, but safety outcomes "
                "were not quantitatively pooled in the primary efficacy synthesis."
            )
        updated.append({
            "id": "safety_scope",
            "section": "Discussion",
            "claim_type": "safety",
            "argument_step": "safety_scope",
            "claim": claim_text,
            "support_source": "manuscript_facts.study_cards.safety_notes",
            "source_study_id": ", ".join(safety_source_ids),
            "source_location": "study_cards.safety_notes",
            "source_quote": " | ".join(examples),
            "manuscript_use": "main",
            "can_write_main_text": True,
        })
        return updated, True

    @staticmethod
    def _claim_text_negates_available_safety_notes(text: str) -> bool:
        lowered = str(text or "").lower()
        has_safety_subject = any(token in lowered for token in (
            "safety",
            "adverse",
            "serious adverse",
            "discontinuation",
            "不良事件",
            "安全",
            "停药",
        ))
        has_unavailable = any(token in lowered for token in (
            "not provided",
            "unavailable",
            "not available",
            "absent",
            "absence",
            "no safety",
            "no adverse",
            "未提供",
            "无法获得",
            "缺少",
        ))
        return has_safety_subject and has_unavailable

    def _ensure_primary_conclusion_claim(self, claims: list[dict], facts: dict) -> tuple[list[dict], bool]:
        """Ensure the conclusion has a clinical primary-effect claim, not only caveats."""
        primary = facts.get("primary_effect") if isinstance(facts, dict) else {}
        primary = primary if isinstance(primary, dict) else {}
        pooled = primary.get("pooled_effect")
        if pooled in (None, ""):
            return claims, False
        effect_measure = str(primary.get("effect_measure") or "").strip() or "effect"
        effect_text = f"{effect_measure} {self._fmt(pooled, 2)}"
        existing_conclusion = [
            item for item in claims
            if isinstance(item, dict)
            and "conclusion" in str(item.get("section") or "").lower()
        ]
        for item in existing_conclusion:
            text = str(item.get("claim") or "")
            if effect_text.lower() in text.lower() or self._fmt(pooled, 2) in text:
                return claims, False

        pico = facts.get("pico") if isinstance(facts.get("pico"), dict) else {}
        intervention = pico.get("intervention") or "the intervention"
        comparator = pico.get("comparator") or "the comparator"
        population = pico.get("population") or "the target population"
        outcome = facts.get("reporting_outcome_label") or primary.get("outcome_name") or pico.get("outcome_primary") or "the primary outcome"
        if self._zh:
            claim_text = (
                f"在{population}中，{intervention}相较于{comparator}可能改善{outcome}"
                f"（{self._fallback_effect_text(primary, effect_measure)}）；结论应结合GRADE确定性、基线风险和终点定义解释。"
            )
        else:
            claim_text = (
                f"In {population}, {intervention} may reduce {outcome} compared with {comparator} "
                f"({self._fallback_effect_text(primary, effect_measure)}); interpretation should account for GRADE "
                "certainty, baseline risk, and endpoint definition."
            )
        inserted = {
            "id": "conc_primary_effect",
            "section": "Conclusion",
            "claim_type": "conclusion",
            "argument_step": "practice_implication",
            "claim": claim_text,
            "support_source": "primary_effect + grade + pico",
            "source_location": "analysis.meta_results.primary_outcome",
            "source_quote": self._fallback_effect_text(primary, effect_measure),
            "manuscript_use": "main",
            "can_write_main_text": True,
        }
        updated: list[dict] = []
        placed = False
        for item in claims:
            is_conclusion = isinstance(item, dict) and "conclusion" in str(item.get("section") or "").lower()
            if not placed and is_conclusion:
                updated.append(inserted)
                placed = True
            if (
                is_conclusion
                and str(item.get("argument_step") or "").strip().lower() == "practice_implication"
            ):
                continue
            updated.append(item)
        if not placed:
            updated.append(inserted)
        return updated, True

    def _merge_duplicate_claim_map_claims(self, claims: list[dict]) -> tuple[list[dict], int]:
        """Merge repeated claim-map entries after LLM generation and normalization.

        The claim map is the manuscript's argument plan. If two entries collapse
        to the same assertion after normalization, letting both proceed causes
        repeated paragraphs later. This merge is intentionally semantic-light:
        it only removes duplicate assertions that are already text-equivalent.
        """
        merged: list[dict] = []
        seen: dict[tuple[str, str, str], int] = {}
        merge_count = 0
        for claim in claims:
            if not isinstance(claim, dict):
                merged.append(claim)
                continue
            text_key = self._normalise_claim_match_text(claim.get("claim") or "")
            if not text_key:
                merged.append(claim)
                continue
            key = (
                self._canonical_semantic_heading(str(claim.get("section") or "")),
                str(claim.get("argument_step") or "").strip().lower(),
                text_key,
            )
            if key not in seen:
                seen[key] = len(merged)
                merged.append(claim)
                continue
            prior = merged[seen[key]]
            if isinstance(prior, dict):
                for field in ("support_source", "source_location", "source_quote", "caveat"):
                    existing = str(prior.get(field) or "").strip()
                    extra = str(claim.get(field) or "").strip()
                    if extra and extra not in existing:
                        prior[field] = (existing + " | " + extra).strip(" |")
            merge_count += 1
        return merged, merge_count

    def _normalize_low_k_heterogeneity_claims(self, claims: list[dict], facts: dict) -> tuple[list[dict], int]:
        """Apply the low-k heterogeneity invariant at the claim-map level."""
        primary = facts.get("primary_effect") if isinstance(facts, dict) else {}
        primary = primary if isinstance(primary, dict) else {}
        n_studies = self._int(primary.get("n_studies"))
        if n_studies <= 0 or n_studies >= 3:
            return claims, 0
        i2 = primary.get("i_squared")
        tau2 = primary.get("tau_squared")
        q_value = primary.get("q_statistic")
        q_p = primary.get("q_p_value")
        stat_parts: list[str] = []
        if i2 is not None:
            stat_parts.append(f"I²={self._fmt(i2, 1)}%")
        if q_value is not None:
            stat_parts.append(f"Cochran Q={self._fmt(q_value, 2)}")
        if q_p is not None:
            stat_parts.append(self._p_text(q_p))
        if tau2 is not None:
            stat_parts.append(f"tau²={self._fmt(tau2, 3)}")
        stat_text = ", ".join(part for part in stat_parts if part) or "heterogeneity statistics"
        replacement_claim = (
            f"With only {n_studies} contributing studies, heterogeneity statistics ({stat_text}) are descriptive and "
            "cannot reliably exclude clinically important between-study differences."
        )
        replacement_quote = (
            f"Heterogeneity statistics were reported as {stat_text}; because only {n_studies} studies contributed, "
            "formal heterogeneity assessment was limited."
        )
        rewritten = 0
        updated: list[dict] = []
        for claim in claims:
            if not isinstance(claim, dict):
                updated.append(claim)
                continue
            if str(claim.get("argument_step") or "").strip().lower() == "future_research":
                updated.append(claim)
                continue
            joined = " ".join(
                str(claim.get(key) or "")
                for key in ("id", "claim", "support_source", "source_location", "source_quote", "caveat")
            ).lower()
            has_heterogeneity_subject = any(
                token in joined
                for token in ("heterogeneity", "i²", "i2", "tau", "τ", "cochran")
            )
            has_overinterpretation = any(
                token in joined
                for token in ("low", "no significant", "no statistical", "absence", "consistent", "compatible", "coherent")
            )
            if has_heterogeneity_subject and has_overinterpretation:
                claim = dict(claim)
                claim["claim"] = replacement_claim
                claim["source_quote"] = replacement_quote
                claim["caveat"] = (
                    "Low study count: do not describe I²/tau² as proof of low, absent, or reassuring heterogeneity."
                )
                if not claim.get("argument_step"):
                    claim["argument_step"] = "evidence_limit"
                rewritten += 1
            updated.append(claim)
        return updated, rewritten

    def _claim_strength_guidance(self, facts: dict) -> dict:
        """Return evidence-strength guidance for clinical interpretation verbs."""
        primary = facts.get("primary_effect") if isinstance(facts, dict) else {}
        primary = primary if isinstance(primary, dict) else {}
        grade = ((facts.get("grade") or {}).get("outcomes") or [{}])[0] if isinstance(facts.get("grade"), dict) else {}
        certainty = str(grade.get("certainty") or "").strip().lower()
        n_studies = self._int(primary.get("n_studies"))
        cautious = bool(certainty and certainty not in {"high", "高"}) or bool(n_studies and n_studies < 3)
        return {
            "certainty": certainty or "not assessed",
            "n_studies": n_studies,
            "cautious_main_effect_language": cautious,
            "recommended_effect_verb": "may reduce / suggests a reduction" if cautious else "reduces",
            "reason": (
                "Use cautious main-effect wording because certainty is not high or fewer than three studies contributed."
                if cautious else
                "High-certainty or sufficiently broad evidence can support more direct effect wording."
            ),
        }

    def _normalize_claim_strength_claims(self, claims: list[dict], facts: dict) -> tuple[list[dict], int]:
        """Calibrate main-effect claim wording to certainty and sparse-study constraints."""
        guidance = self._claim_strength_guidance(facts)
        if not guidance.get("cautious_main_effect_language"):
            return claims, 0
        rewritten = 0
        updated: list[dict] = []
        for claim in claims:
            if not isinstance(claim, dict):
                updated.append(claim)
                continue
            claim_type = str(claim.get("claim_type") or "").strip().lower()
            argument_step = str(claim.get("argument_step") or "").strip().lower()
            target_claim = claim_type in {"result", "conclusion", "applicability"} or argument_step in {
                "primary_finding",
                "clinical_significance",
                "practice_implication",
            }
            if not target_claim:
                updated.append(claim)
                continue
            original = str(claim.get("claim") or "")
            revised = re.sub(r"\breduced the risk of\b", "may reduce the risk of", original, flags=re.IGNORECASE)
            revised = re.sub(r"\breduces the risk of\b", "may reduce the risk of", revised, flags=re.IGNORECASE)
            revised = re.sub(r"\blowered the risk of\b", "may lower the risk of", revised, flags=re.IGNORECASE)
            revised = re.sub(r"\blowers the risk of\b", "may lower the risk of", revised, flags=re.IGNORECASE)
            revised = re.sub(r"\bpoints toward a lower risk of\b", "suggests a reduction in", revised, flags=re.IGNORECASE)
            revised = re.sub(
                r"\bsupporting their consideration in this population\b",
                "suggesting potential benefit in this population",
                revised,
                flags=re.IGNORECASE,
            )
            revised = re.sub(
                r"\bsupporting its consideration in this population\b",
                "suggesting potential benefit in this population",
                revised,
                flags=re.IGNORECASE,
            )
            revised = revised.replace("支持在该人群中使用", "提示该人群可能获益")
            if revised != original:
                claim = dict(claim)
                claim["claim"] = revised
                caveat = str(claim.get("caveat") or "").strip()
                strength_note = "Claim strength calibrated to certainty and sparse-study constraints."
                claim["caveat"] = f"{caveat} {strength_note}".strip()
                rewritten += 1
            updated.append(claim)
        return updated, rewritten

    def _normalize_absolute_effect_claims(self, claims: list[dict], facts: dict) -> tuple[list[dict], int]:
        """Bind absolute-effect claims to the deterministic scenario representation."""
        absolute_effects = facts.get("absolute_effects") if isinstance(facts, dict) else {}
        scenario = self._absolute_effect_primary_scenario(absolute_effects)
        if not scenario:
            return claims, 0
        absolute_phrase = self._absolute_effect_phrase(scenario)
        nnt_phrase = self._nnt_phrase(scenario)
        if not absolute_phrase:
            return claims, 0
        rewritten = 0
        updated: list[dict] = []
        for claim in claims:
            if not isinstance(claim, dict):
                updated.append(claim)
                continue
            claim_text = str(claim.get("claim") or "")
            argument_step = str(claim.get("argument_step") or "").casefold()
            support_source = str(claim.get("support_source") or "").casefold()
            is_absolute_claim = (
                argument_step == "clinical_significance"
                or "absolute effect" in support_source
                or bool(re.search(r"\b(?:absolute risk|risk difference|NNT|per 1000)\b", claim_text, flags=re.I))
            )
            if not is_absolute_claim:
                updated.append(claim)
                continue
            if self._zh:
                revised = f"按纳入试验观察到的对照组风险换算，{absolute_phrase}；近似{nnt_phrase}。"
            else:
                revised = (
                    "Using the observed comparator risk in the included trials, the pooled relative effect corresponds "
                    f"to {absolute_phrase}; approximate {nnt_phrase}."
                )
            if revised != claim_text:
                claim = dict(claim)
                claim["claim"] = revised
                claim["support_source"] = "Absolute effects scenario"
                claim["source_location"] = "Absolute effects"
                claim["source_quote"] = json.dumps(
                    {
                        key: scenario.get(key)
                        for key in (
                            "assumed_control_risk_per_1000",
                            "intervention_risk_per_1000",
                            "events_avoided_per_1000",
                            "events_avoided_ci_high_per_1000",
                            "events_increased_ci_high_per_1000",
                            "absolute_ci_crosses_null",
                            "nnt",
                            "nnt_type",
                        )
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                )
                claim["caveat"] = (
                    "The absolute translation depends on the observed comparator risk and is not a universal risk difference."
                    if not self._zh else
                    "该绝对效应换算取决于观察到的对照组风险，并非通用于所有场景的风险差。"
                )
                rewritten += 1
            updated.append(claim)
        return updated, rewritten

    def _normalize_grade_public_claim_language(self, claims: list[dict], facts: dict) -> tuple[list[dict], int]:
        """Render GRADE-domain claims in reader-facing language before authoring."""
        primary = facts.get("primary_effect") if isinstance(facts, dict) else {}
        primary = primary if isinstance(primary, dict) else {}
        population = facts.get("primary_population") if isinstance(facts, dict) else {}
        population = population if isinstance(population, dict) else {}
        total_n = self._int(population.get("selected_total_participants"))
        effect_measure = str(primary.get("effect_measure") or "").upper()
        ci_lower = primary.get("ci_lower")
        ci_upper = primary.get("ci_upper")
        null_value = 0 if effect_measure in {"MD", "SMD", "WMD", "RD"} else 1
        crosses_null = False
        try:
            crosses_null = float(ci_lower) <= float(null_value) <= float(ci_upper)
        except (TypeError, ValueError):
            crosses_null = False
        rewritten = 0
        updated: list[dict] = []
        for claim in claims:
            if not isinstance(claim, dict):
                updated.append(claim)
                continue
            joined = " ".join(
                str(claim.get(key) or "")
                for key in ("id", "claim", "support_source", "source_location", "source_quote", "caveat")
            ).lower()
            grade_related = "grade" in joined or "证据确定性" in joined
            internal_terms = bool(GradeTablesMixin._grade_rationale_has_internal_terms(joined))
            if not grade_related and not internal_terms:
                updated.append(claim)
                continue
            claim = dict(claim)
            changed = False
            if "imprecision" in joined or "不精确" in joined or "ois" in joined or "ci crosses null" in joined:
                if self._zh:
                    claim["claim"] = (
                        f"入池比较共{total_n}名参与者；样本量达到预设信息量要求，"
                        f"置信区间{'跨越' if crosses_null else '未跨越'}无效值，因此未因不精确性降级。"
                        if total_n else
                        f"样本量和置信区间支持不因不精确性降级，置信区间{'跨越' if crosses_null else '未跨越'}无效值。"
                    )
                    claim["source_quote"] = "不精确性判断基于入池样本量、置信区间宽度以及置信区间是否跨越无效值。"
                else:
                    claim["claim"] = (
                        f"The analysis included {total_n} participants; the information size was sufficient and the confidence interval "
                        f"{'crossed' if crosses_null else 'did not cross'} the null, so no downgrade was applied for imprecision."
                        if total_n else
                        f"The information size and confidence interval supported no downgrade for imprecision; the confidence interval "
                        f"{'crossed' if crosses_null else 'did not cross'} the null."
                    )
                    claim["source_quote"] = "Imprecision was judged from contributing sample size, confidence interval width, and whether the confidence interval crossed the null."
                changed = True
            for key in ("claim", "source_quote", "caveat"):
                if key in claim:
                    value = str(claim.get(key) or "")
                    cleaned = re.sub(r"\bOIS\s*=\s*[0-9,]+\b", "the prespecified information-size requirement", value, flags=re.IGNORECASE)
                    cleaned = re.sub(r"\bCI crosses null\s*=\s*(?:True|False)\b", "whether the confidence interval crossed the null", cleaned, flags=re.IGNORECASE)
                    cleaned = re.sub(r"\bTotal N\s*=\s*[0-9,]+\b", "the contributing sample size", cleaned, flags=re.IGNORECASE)
                    cleaned = re.sub(r"Rule-based\s+P/I/C/O\s+directness\s+check", "directness assessment", cleaned, flags=re.IGNORECASE)
                    cleaned = re.sub(r"P/I/C/design fields", "population, intervention, comparator, outcome, and design fields", cleaned, flags=re.IGNORECASE)
                    if cleaned != value:
                        claim[key] = cleaned
                        changed = True
            if changed:
                rewritten += 1
            updated.append(claim)
        return updated, rewritten

    def _llm_develop_claim_map_if_thin(
        self,
        *,
        claim_map: ManuscriptClaimMap,
        facts_block: dict,
        initial_prompt_summary: str = "",
    ) -> tuple[ManuscriptClaimMap, dict]:
        """Ask the LLM to deepen an underdeveloped clinical argument map."""
        claims = [
            item for item in claim_map.claims
            if item.can_write_main_text and item.manuscript_use != "exclude"
        ]
        step_counts = Counter(str(item.argument_step or "") for item in claims)
        discussion_count = sum(1 for item in claims if "discussion" in str(item.section or "").lower())
        has_primary = bool((facts_block.get("primary_effect") or {}).get("pooled_effect"))
        missing_steps = [
            step for step in (
                "clinical_significance",
                "endpoint_interpretation",
                "applicability",
                "evidence_limit",
                "practice_implication",
            )
            if not step_counts.get(step)
        ]
        safety_note_count = sum(
            len(card.get("safety_notes") or [])
            for card in facts_block.get("study_cards") or []
            if isinstance(card, dict)
        )
        if safety_note_count and not step_counts.get("safety_scope"):
            missing_steps.append("safety_scope")
        thin_reasons: list[str] = []
        if has_primary and len(claims) < 9:
            thin_reasons.append(f"only_{len(claims)}_main_claims")
        if has_primary and discussion_count < 4:
            thin_reasons.append(f"only_{discussion_count}_discussion_claims")
        if has_primary and len([step for step in step_counts if step]) < 8:
            thin_reasons.append("few_argument_steps")
        if has_primary and missing_steps:
            thin_reasons.append("missing_steps:" + ",".join(missing_steps))
        if not thin_reasons:
            return claim_map, {
                "status": "not_needed",
                "initial_claim_count": len(claims),
                "initial_discussion_claim_count": discussion_count,
                "initial_argument_steps": dict(step_counts),
            }

        prompt = (
            "You are revising a clinical systematic review Claim Map that is too thin for a publication-style "
            "Introduction/Discussion. Expand the claim map, but do not write prose.\n\n"
            f"Write in {'Chinese' if self._zh else 'English'}. Return JSON only.\n"
            "Use the same structured evidence. Keep all correct existing claims, but add source-backed claims so the "
            "clinical argument has enough depth for a manuscript. Do not invent background, mechanisms, safety outcomes, "
            "subgroup effects, or guideline implications not supported by supplied facts.\n\n"
            "Expansion priorities:\n"
            "- preserve objective and primary finding;\n"
            "- add clinical_significance when the primary effect or background evidence supports why the result matters;\n"
            "- add endpoint_interpretation for composite outcomes or time-to-event interpretation when supported;\n"
            "- add applicability for population, comparator, care setting, or LVEF boundary;\n"
            "- add evidence_limit for low study count, publication bias, GRADE, RoB, imprecision, or missing safety/subgroup data;\n"
            "- add safety_scope when study-card safety_notes are supplied; summarize those notes narratively and state "
            "whether safety was quantitatively pooled;\n"
            "- add practice_implication and future_research only when the source material supports cautious statements.\n\n"
            "If endpoint_definition_caveat and endpoint_definition_discussion are both present, keep the full endpoint "
            "definition contrast in Methods-oriented claims and use only the clinical implication in Discussion claims. "
            "Discussion endpoint claims should use endpoint_definition_discussion itself as the claim text; keep trial "
            "names and component definitions in source_quote, Methods, or tables only.\n\n"
            "For a full meta-analysis with primary effect data, target 9-14 main claims, including at least 4 Discussion "
            "claims. Each main claim must have claim_type, argument_step, support_source, and source_quote or structured "
            "fact location. The source_quote must support every substantive clinical phrase in the claim. Do not infer "
            "'historically limited treatment options', 'disease-modifying therapy', 'clinically meaningful benefit', "
            "'class effect', 'confirmation', or guideline impact unless those exact ideas are present in supplied sources. "
            "If absolute_effects are supplied in structured facts, use those values when discussing absolute risk, events per "
            "1000, ARR, or NNT; never claim those quantities were not provided. If absolute effects are not supplied, describe "
            "the endpoint as clinically important rather than asserting an absolute clinical benefit. Applicability claims "
            "should define where the result most directly applies, not state that benefit is confirmed in a subgroup. If "
            "primary_effect is supplied, do not claim that cross-study synthesis or comparison is impossible; instead say "
            "that low study count limits heterogeneity, publication-bias, subgroup, component-outcome, or class-effect "
            "inferences while preserving the prespecified pooled primary effect. Put unsupported ideas into excluded_or_deferred_claims.\n\n"
            "When STRUCTURED FACTS include safety_notes_available greater than zero, include one Discussion safety claim "
            "with argument_step='safety_scope'. Use only supplied safety_notes; do not invent additional adverse events, "
            "mechanisms, or trial-level safety results. Do not say safety notes or adverse-event counts were unavailable "
            "when safety_notes_by_study lists them; say only that they were not quantitatively pooled unless a safety "
            "meta-analysis is supplied.\n\n"
            f"THINNESS DIAGNOSIS: {thin_reasons}\n\n"
            "CURRENT CLAIM MAP:\n"
            f"{claim_map.model_dump_json(indent=2)}\n\n"
            "STRUCTURED FACTS AND EVIDENCE:\n"
            f"{json.dumps(facts_block, ensure_ascii=False, indent=2)[:28000]}"
        )
        try:
            revised = self.call_llm_structured(
                prompt,
                ManuscriptClaimMap,
                temperature=0.0,
                max_tokens=max(4096, min(self._writing_tokens("section"), 12000)),
            )
        except Exception as exc:
            return claim_map, {
                "status": "failed",
                "reason": str(exc)[:500],
                "thin_reasons": thin_reasons,
            }
        revised_claims = [
            item for item in revised.claims
            if item.can_write_main_text and item.manuscript_use != "exclude"
        ]
        if len(revised_claims) <= len(claims):
            return claim_map, {
                "status": "rejected_no_expansion",
                "thin_reasons": thin_reasons,
                "initial_claim_count": len(claims),
                "revised_claim_count": len(revised_claims),
                "initial_summary": initial_prompt_summary,
            }
        return revised, {
            "status": "expanded",
            "thin_reasons": thin_reasons,
            "initial_claim_count": len(claims),
            "revised_claim_count": len(revised_claims),
            "initial_discussion_claim_count": discussion_count,
            "revised_discussion_claim_count": sum(
                1 for item in revised_claims if "discussion" in str(item.section or "").lower()
            ),
            "initial_argument_steps": dict(step_counts),
            "revised_argument_steps": dict(Counter(str(item.argument_step or "") for item in revised_claims)),
        }

    def _section_fact_contract_block(self, section_key: str) -> str:
        """Return a compact facts/claim contract for LLM-drafted sections.

        The LLM may improve prose, but it must not invent the clinical facts,
        conclusions, references, or provenance status. This block is intentionally
        compact so it can be appended to section prompts without swamping the
        actual writing instruction.
        """
        facts = getattr(self, "_manuscript_facts", None) if isinstance(getattr(self, "_manuscript_facts", None), dict) else {}
        if not facts:
            return ""
        section = str(section_key or "").strip().lower()
        primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
        population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
        readiness = facts.get("evidence_readiness") if isinstance(facts.get("evidence_readiness"), dict) else {}
        provenance = facts.get("source_provenance") if isinstance(facts.get("source_provenance"), dict) else {}
        positioning = facts.get("positioning") if isinstance(facts.get("positioning"), dict) else {}
        search = facts.get("search") if isinstance(facts.get("search"), dict) else {}
        grade_outcomes = (facts.get("grade") or {}).get("outcomes") if isinstance(facts.get("grade"), dict) else []
        grade = grade_outcomes[0] if isinstance(grade_outcomes, list) and grade_outcomes else {}
        source_names = self._source_names_for_manuscript(search)
        source_text = ", ".join(str(item) for item in source_names if str(item).strip())
        cards = [
            self._compact_study_card_for_prompt(card)
            for card in (facts.get("study_cards") or [])[:8]
            if isinstance(card, dict)
        ]
        claims = [
            {
                "id": item.get("id"),
                "claim": item.get("claim"),
                "support_source": item.get("support_source"),
            }
            for item in (getattr(self, "_manuscript_claim_map", None) or facts.get("claim_map") or [])
            if isinstance(item, dict) and self._claim_applies_to_section(item, section)
        ]
        payload = {
            "report_type": facts.get("report_type"),
            "manuscript_mode": facts.get("manuscript_mode"),
            "section": section_key,
            "allowed_claims_for_this_section": claims,
            "primary_effect": {
                "outcome_name": primary.get("outcome_name"),
                "effect_measure": primary.get("effect_measure"),
                "n_studies": primary.get("n_studies"),
                "pooled_effect": primary.get("pooled_effect"),
                "ci_lower": primary.get("ci_lower"),
                "ci_upper": primary.get("ci_upper"),
                "p_value": primary.get("p_value"),
                "model": primary.get("model"),
                "i_squared": primary.get("i_squared"),
            },
            "primary_population": {
                "selected_total_participants": population.get("selected_total_participants"),
                "events_intervention": population.get("events_intervention"),
                "total_intervention": population.get("total_intervention"),
                "events_control": population.get("events_control"),
                "total_control": population.get("total_control"),
            },
            "grade_primary": {
                "certainty": grade.get("certainty"),
                "effect_summary": grade.get("effect_summary"),
            } if isinstance(grade, dict) else {},
            "evidence_readiness": {
                "status": readiness.get("status"),
                "blocker_codes": readiness.get("blocker_codes") or [
                    item.get("code") for item in readiness.get("blockers", []) if isinstance(item, dict)
                ],
                "warning_codes": [
                    item.get("code") for item in readiness.get("warnings", []) if isinstance(item, dict)
                ],
                "selected_primary_row_count": len(readiness.get("selected_primary_rows") or []),
            },
            "source_provenance": {
                "counts": provenance.get("counts"),
                "publication_ready": provenance.get("publication_ready"),
                "benchmark_ready": provenance.get("benchmark_ready"),
            },
            "positioning": {
                "category": positioning.get("category"),
                "anchor_label": ((positioning.get("anchor_review") or {}) if isinstance(positioning.get("anchor_review"), dict) else {}).get("label"),
            },
            "search": {
                "sources_text": source_text,
                "source_counts": search.get("source_counts"),
                "search_query": search.get("query"),
            },
            "study_cards": cards,
        }
        if self._zh:
            rules = (
                "\n\n## 事实锁定写作合同\n"
                "下列 JSON 是本节唯一可使用的结构化事实。请遵守：\n"
                "- 只能使用 allowed_claims_for_this_section 和 study_cards 支撑临床判断；不要自行补充机制、指南或既往证据。\n"
                "- 数字、研究数、样本量、效应量、置信区间、GRADE 确定性和来源状态必须与 JSON 完全一致。\n"
                "- 不要解释流水线、解析器、fact table、source of truth、hard validation 或写作步骤。\n"
                "- 除非 JSON 明确提供人工双评审信息，不要声称“两名独立评审员”或“双人独立提取”；应中性描述筛选和提取。\n"
                "- 方法部分命名检索来源时必须使用 search.sources_text 的原文；不要自行推断或补写“未检索”其它数据库。\n"
                "- Methods/Results 只写本研究做了什么和发现了什么；不要写 meta-analysis 教科书式常识。\n"
                "- 每段最多 6 句；一段只表达一个论点。\n"
            )
        else:
            rules = (
                "\n\n## Fact-grounded writing contract\n"
                "The JSON below is the only structured fact base for this section. Follow these rules:\n"
                "- Use only allowed_claims_for_this_section and study_cards to support clinical interpretation; do not add mechanisms, guidelines, or prior-evidence claims unless supplied in citation context.\n"
                "- Numbers, study counts, sample sizes, effect estimates, confidence intervals, GRADE certainty, and provenance status must match the JSON exactly.\n"
                "- Do not describe the pipeline, parser, fact table, source of truth, hard validation, or writing process.\n"
                "- Do not claim two independent human reviewers or dual independent extraction unless that reviewer process is explicitly supplied in the JSON; describe screening and extraction neutrally.\n"
                "- When naming search sources in Methods, use search.sources_text exactly; do not infer or add statements that other databases were not searched unless explicitly supplied.\n"
                "- Methods and Results must report what was done and found; do not teach generic meta-analysis principles.\n"
                "- Keep each paragraph to 6 sentences or fewer, with one claim per paragraph.\n"
            )
        return rules + "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"

    @staticmethod
    def _claim_applies_to_section(claim: dict, section_key: str) -> bool:
        raw = str(claim.get("section") or "").lower()
        if not raw:
            return False
        aliases = {
            "intro": {"introduction", "intro"},
            "introduction": {"introduction", "intro"},
            "methods": {"methods", "method"},
            "results": {"results", "result", "abstract"},
            "discussion": {"discussion", "conclusion", "conclusions"},
            "conclusion": {"conclusion", "conclusions", "abstract"},
        }
        targets = aliases.get(section_key, {section_key})
        return any(target in raw for target in targets)

    @staticmethod
    def _compact_study_card_for_prompt(card: dict) -> dict:
        return {
            "display_name": card.get("display_name") or card.get("study_label"),
            "study_label": card.get("study_label"),
            "intervention": card.get("intervention"),
            "analysis_population": card.get("analysis_population"),
            "design_note": card.get("design_note"),
            "primary_outcome_note": card.get("primary_outcome_note"),
            "distinctive_feature": card.get("distinctive_feature"),
            "interpretation_note": card.get("interpretation_note"),
            "mortality_timepoint": card.get("mortality_timepoint"),
            "weight": card.get("weight"),
            "counts": card.get("counts"),
            "source_provenance_tier": card.get("source_provenance_tier") or card.get("source_role"),
            "source_location": card.get("source_location"),
        }

    def _positioning_paragraph(self, facts: dict, *, cite: str = "") -> str:
        """Render structured review-positioning facts as manuscript prose."""
        facts = facts or {}
        positioning = facts.get("positioning") if isinstance(facts.get("positioning"), dict) else {}
        category = str(positioning.get("category") or "").strip()
        if not category:
            return ""
        anchor = positioning.get("anchor_review") if isinstance(positioning.get("anchor_review"), dict) else {}
        anchor_label = str(anchor.get("label") or "the published reference synthesis").strip()
        prior_reviews = positioning.get("prior_reviews") if isinstance(positioning.get("prior_reviews"), list) else []
        cite = cite or ""
        if self._zh:
            if category == "reproduction_or_benchmark_alignment":
                return (
                    f"本综述的定位是与既有发表证据进行基准对照的重建性Meta分析，而不是把相同资料包装成新的临床发现。"
                    f"既有锚点为{anchor_label}；本研究的增量在于按预设PICO重新追溯入池研究、主要结局行、效应量构建、模型选择和证据确定性，并明确区分原始试验来源与既往合成结果{cite}。"
                )
            if category == "potential_update_or_expansion":
                count_text = f"检索记录中识别到{len(prior_reviews)}条可能相关的既往系统综述或Meta分析；" if prior_reviews else ""
                return (
                    f"{count_text}因此，本稿应被解读为潜在更新或范围扩展，而不是默认具有全新发现。"
                    "其增量需要通过检索日期、纳入标准、结局定义、分析模型和新增研究与既往综述逐项比较后确认。"
                )
            return (
                "本综述不以是否存在既往系统综述作为新颖性声明，而是把贡献限定为截至本次检索日期、"
                "按预设PICO和来源核验规则形成的可复查证据合成。"
            )
        if category == "reproduction_or_benchmark_alignment":
            return (
                "This review is positioned as a benchmark-aligned reconstruction rather than as a claim of a new "
                f"clinical discovery. The published anchor is {anchor_label}; the added value is the source-level "
                "reconstruction of the included trials, selected outcome rows, effect-size calculations, model choice, "
                f"and certainty assessment while keeping primary trial sources separate from prior syntheses{cite}."
            )
        if category == "potential_update_or_expansion":
            count_text = f"{len(prior_reviews)} candidate prior systematic reviews or meta-analyses were recorded; " if prior_reviews else ""
            return (
                f"{count_text}this manuscript represents a potential update or scope expansion "
                "rather than an automatically novel synthesis. Its incremental contribution depends on the search date, "
                "eligibility criteria, outcome definition, analysis model, and whether new studies or decisions differ from earlier reviews."
            )
        return (
            "This review does not base its contribution on a claim that no prior systematic review exists. Its contribution "
            "is limited to the reproducible synthesis documented by the current search date, eligibility criteria, and "
            "source-linked study rows."
        )

    def _model_decision_paragraph(self, facts: dict) -> str:
        decision = facts.get("model_decision") if isinstance(facts.get("model_decision"), dict) else {}
        if not decision:
            return ""
        reason = str(decision.get("reason") or "").strip()
        primary = str(decision.get("primary_engine_model") or decision.get("primary_model") or "").strip()
        tau = str(decision.get("tau_estimator") or "").strip()
        if self._zh:
            if decision.get("low_k_random_fallback"):
                k_text = str(decision.get("k") or "少量")
                return (
                    "模型选择在合成和正文生成前确定。"
                    f"本结局仅有{k_text}项研究，tau²估计和预测区间不稳定；"
                    "因此主要分析报告固定效应逆方差估计。预设随机效应分析触发低研究数保护，"
                    "不解释独立随机效应估计或预测区间。"
                )
            if not reason:
                reason = "模型选择依据记录在分析文件中"
            tau_text = f"（{tau}）" if tau and primary == "random" else ""
            return f"模型选择在合成和正文生成前确定。主要分析采用{self._zh_model_label(primary or 'random')}{tau_text}；选择理由为：{reason}。"
        if not reason:
            reason = "the model choice was recorded in the analysis files"
        if decision.get("low_k_random_fallback"):
            k_text = str(decision.get("k") or "few")
            return (
                "Model choice was finalized before synthesis and manuscript rendering. "
                f"Only {k_text} studies contributed to this outcome, making tau-squared estimation and prediction intervals unstable; "
                "the primary analysis therefore reports the fixed-effect inverse-variance estimate. The prespecified random-effects "
                "analysis triggered the low-k safeguard, so no independent random-effects estimate or prediction interval is interpreted."
            )
        tau_text = f" ({tau})" if tau and primary == "random" else ""
        model_label = f"{primary or 'random'}-effects"
        return f"Model choice was finalized before synthesis and manuscript rendering. The primary analysis used a {model_label}{tau_text} model because {reason}."

    def _model_sensitivity_sentence(self, facts: dict) -> str:
        sensitivity = facts.get("model_sensitivity") if isinstance(facts.get("model_sensitivity"), dict) else {}
        fixed = sensitivity.get("fixed") if isinstance(sensitivity.get("fixed"), dict) else {}
        random = sensitivity.get("random") if isinstance(sensitivity.get("random"), dict) else {}
        if not fixed or not random:
            return ""
        model_decision = facts.get("model_decision") if isinstance(facts.get("model_decision"), dict) else {}
        random_model = str(random.get("model") or "").strip().lower()
        if model_decision.get("low_k_random_fallback") or random_model == "fixed":
            if self._zh:
                return (
                    "由于贡献研究少于3项，随机效应敏感性分析按预设保护规则退回固定效应估计；"
                    "因此本文不把固定效应与随机效应之间的相同数值解释为研究间差异不存在。"
                )
            return (
                "Because fewer than 3 studies contributed, the random-effects sensitivity analysis used the prespecified "
                "fixed-effect safeguard; identical fixed and random values are therefore not interpreted as evidence that "
                "between-study differences are absent."
            )
        fixed_effect = self._fmt(fixed.get("pooled_effect"), 2)
        fixed_low = self._fmt(fixed.get("ci_lower"), 2)
        fixed_high = self._fmt(fixed.get("ci_upper"), 2)
        random_effect = self._fmt(random.get("pooled_effect"), 2)
        random_low = self._fmt(random.get("ci_lower"), 2)
        random_high = self._fmt(random.get("ci_upper"), 2)
        same_estimate = fixed_effect == random_effect and fixed_low == random_low and fixed_high == random_high
        if self._zh:
            if same_estimate:
                return (
                    f"固定效应和随机效应敏感性估计相同，均为{fixed_effect}"
                    f"（95%CI {fixed_low}至{fixed_high}）；这表明在当前资料中模型选择未改变主要方向。"
                )
            return (
                f"固定效应敏感性估计为{fixed_effect}（95%CI {fixed_low}至{fixed_high}），"
                f"随机效应敏感性估计为{random_effect}（95%CI {random_low}至{random_high}）；"
                "两者用于判断模型选择是否改变主要方向。"
            )
        if same_estimate:
            return (
                f"The fixed-effect and random-effects sensitivity estimates were identical at {fixed_effect} "
                f"(95% CI {fixed_low} to {fixed_high}), indicating that model choice did not change the main direction "
                "in the available data."
            )
        return (
            f"The fixed-effect sensitivity estimate was {fixed_effect} (95% CI {fixed_low} to {fixed_high}), "
            f"and the random-effects sensitivity estimate was {random_effect} (95% CI {random_low} to {random_high}); "
            "these paired estimates were used to judge whether model choice changed the direction of inference."
        )

    def _write_fact_locked_meta_and_save(
        self,
        *,
        protocol: ResearchProtocol,
        facts: dict,
        prisma_data: dict,
        project: Project | None,
        grade_profile: GRADEProfile | None,
        ref_manager: ReferenceManager | None,
    ) -> str:
        """Render the fact-locked meta manuscript and persist validation/draft outputs."""
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
        manuscript, citation_plan_audit = self._apply_claim_map_citations(manuscript, facts)
        if project:
            project.save_json("claim_map_citation_plan.json", citation_plan_audit, subdir="manuscript")
            self._save_citation_contract(project, facts)
        before_claim_map_authoring = manuscript
        manuscript, authoring_audit = self._llm_author_open_sections_from_claim_map(manuscript, facts)
        manuscript, post_author_citation_audit = self._apply_claim_map_citations(manuscript, facts)
        if project:
            authoring_audit["post_authoring_citation_plan"] = post_author_citation_audit
            project.save_json("claim_map_authoring_audit.json", authoring_audit, subdir="manuscript")
            self._save_citation_contract(project, facts)
        if manuscript != before_claim_map_authoring and int(authoring_audit.get("accepted_sections") or 0) > 0:
            manuscript, fact_validation = validate_and_repair_manuscript(manuscript, facts)
        manuscript, semantic_audit = self._semantic_edit_open_sections(manuscript, facts, project=project)
        manuscript, post_semantic_citation_audit = self._apply_claim_map_citations(manuscript, facts)
        if project:
            self._save_citation_contract(project, facts)
        manuscript, methodology_audit = self._llm_methodology_review_low_k_heterogeneity(manuscript, facts)
        manuscript = self._harmonize_open_section_outcome_label(manuscript, facts, protocol)
        manuscript = self._deduplicate_adjacent_subsections(manuscript)
        manuscript = self._normalize_citation_marker_style(manuscript, lang=self._lang)
        if isinstance(semantic_audit, dict):
            semantic_audit["post_semantic_citation_plan"] = post_semantic_citation_audit
            semantic_audit["low_k_methodology_review"] = methodology_audit
        manuscript = self._normalize_sentence_boundary_spacing(manuscript)
        manuscript = self._normalize_structured_abstract_spacing(manuscript)
        # Open-section authoring and claim-map passes may rebalance citations.
        # Reapply the conservative publication anchors before the terminal fact
        # check so a clean draft cannot end with an uncited Introduction.
        manuscript = self._backfill_publication_inline_citations(manuscript)
        manuscript, fact_validation = validate_and_repair_manuscript(manuscript, facts)
        manuscript = remove_near_duplicate_sentences(manuscript, cross_section=True)
        manuscript, fact_validation = validate_and_repair_manuscript(manuscript, facts)
        manuscript = self._normalize_figure_heading_spacing(manuscript)
        manuscript = self._repair_markdown_image_syntax(manuscript)
        manuscript = self._normalize_sentence_boundary_spacing(manuscript)
        manuscript = self._normalize_structured_abstract_spacing(manuscript)
        if project:
            project.save_json("low_k_methodology_review_audit.json", methodology_audit, subdir="manuscript")
            project.save_json("manuscript_semantic_edit_audit.json", semantic_audit, subdir="manuscript")
            fact_validation, _, _ = self._quality_checked_validation(
                manuscript,
                facts,
                fact_validation,
                project=project,
            )
            manuscript = getattr(self, "_quality_checked_manuscript", manuscript)
        for issue in fact_validation.get("issues", []):
            level = "warning" if issue.get("severity") != "error" else "error"
            self.log(f"FACT-LOCKED MANUSCRIPT CHECK: {issue.get('message')}", level=level)
        if not fact_validation.get("passed", False):
            if project:
                project.save_text("draft.rejected.md", manuscript, subdir="manuscript")
            manuscript = self._write_validation_blocked_report(
                protocol=protocol,
                facts=facts,
                validation=fact_validation,
            )
            self.log(
                "Fact-locked manuscript failed hard validation; saved validation-blocked report.",
                level="error",
            )
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
        self.log(f"Manuscript saved ({len(manuscript)} chars, ~{len(manuscript.split())} words)")
        return manuscript

    def _llm_methodology_review_low_k_heterogeneity(self, manuscript: str, facts: dict) -> tuple[str, dict]:
        """Ask a methodologist LLM to handle low-k heterogeneity interpretation.

        This pass is deliberately principle-based: deterministic code only
        identifies the methodological situation (fewer than three studies and a
        paragraph discussing heterogeneity statistics). The LLM decides whether
        the paragraph actually overinterprets the statistics and, if needed,
        proposes a local replacement that still passes fact-preservation guards.
        """
        primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
        try:
            n_studies = int(primary.get("n_studies") or primary.get("k") or 0)
        except (TypeError, ValueError):
            n_studies = 0
        audit = {
            "schema_version": 1,
            "status": "skipped",
            "n_studies": n_studies,
            "accepted_patches": 0,
            "rejected_patches": 0,
            "issues": [],
        }
        if n_studies <= 0 or n_studies >= 3:
            audit["reason"] = "primary_analysis_not_low_k"
            return manuscript, audit

        targets: list[dict[str, object]] = []
        section_paragraphs: dict[str, list[str]] = {}
        topic_pattern = r"heterogeneity|I²|I2|tau|τ|异质性"
        for heading in self._semantic_edit_allowed_headings():
            body = self._h2_section_body(manuscript, heading)
            if not body.strip():
                continue
            paragraphs = re.split(r"\n\s*\n", body.strip())
            section_paragraphs[heading] = paragraphs
            for index, paragraph in enumerate(paragraphs, 1):
                text = str(paragraph or "")
                if text.startswith("|") or text.startswith("!["):
                    continue
                if re.search(topic_pattern, text, flags=re.I):
                    targets.append({
                        "heading": heading,
                        "paragraph_index": index,
                        "text": text,
                    })
        if not targets:
            audit["reason"] = "no_heterogeneity_discussion_targets"
            return manuscript, audit
        targets = targets[:12]
        language_rule = "Chinese" if self._zh else "English"
        prompt = (
            "You are a senior systematic-review methodologist. Review only the listed paragraphs for one issue: "
            "when fewer than three studies contribute to a meta-analysis, heterogeneity statistics such as I², Q, "
            "and tau² may be reported descriptively but must not be used to claim clinical consistency, absence of "
            "between-study differences, model-equivalence reassurance, or proof that heterogeneity is unimportant. "
            "Also check statistical accuracy: Q tests have low power with very few studies, whereas I² and tau² are "
            "estimates with substantial uncertainty; do not describe I² or tau² themselves as hypothesis tests or "
            "as having statistical power.\n\n"
            f"Write in {language_rule}. Return JSON only. Provide a patch only for paragraphs that actually "
            "overinterpret heterogeneity statistics or describe low-k heterogeneity metrics inaccurately under this "
            "principle. If a paragraph already treats these statistics as descriptive and statistically accurate, "
            "omit it. Keep the same heading and paragraph_index. Preserve all effect "
            "estimates, confidence intervals, p values, study counts, study names, citation markers, and endpoint "
            "definitions unless they are part of the specific overinterpretive wording being replaced. Do not add "
            "new claims, safety findings, subgroup claims, or references.\n\n"
            "STRUCTURED FACTS:\n"
            f"{json.dumps({'primary_effect': primary, 'model_decision': facts.get('model_decision')}, ensure_ascii=False, indent=2)[:6000]}\n\n"
            "TARGET PARAGRAPHS:\n"
            f"{json.dumps(targets, ensure_ascii=False, indent=2)[:16000]}"
        )
        try:
            revision = self.call_llm_structured(
                prompt,
                SemanticParagraphRevision,
                temperature=0.0,
                max_tokens=max(2048, min(self._writing_tokens("section"), 8000)),
            )
        except Exception as exc:
            audit.update({"status": "failed", "error": str(exc)[:500], "target_count": len(targets)})
            return manuscript, audit

        audit.update({
            "status": "ok",
            "summary": revision.summary,
            "target_count": len(targets),
        })
        changed_sections: set[str] = set()
        for patch in revision.patches[:12]:
            heading = self._canonical_semantic_heading(patch.heading)
            paragraphs = section_paragraphs.get(heading)
            if not paragraphs:
                audit["rejected_patches"] += 1
                audit["issues"].append({
                    "code": "unsupported_methodology_heading",
                    "heading": patch.heading,
                    "reason": patch.reason,
                })
                continue
            try:
                paragraph_index = int(patch.paragraph_index)
            except Exception:
                paragraph_index = 0
            if paragraph_index < 1 or paragraph_index > len(paragraphs):
                audit["rejected_patches"] += 1
                audit["issues"].append({
                    "code": "invalid_methodology_paragraph_index",
                    "heading": heading,
                    "paragraph_index": patch.paragraph_index,
                    "reason": patch.reason,
                })
                continue
            original = paragraphs[paragraph_index - 1].strip()
            replacement = str(patch.replacement_markdown or "").strip()
            if not replacement or replacement == original:
                audit["issues"].append({
                    "code": "methodology_paragraph_unchanged",
                    "heading": heading,
                    "paragraph_index": paragraph_index,
                    "reason": patch.reason,
                })
                continue
            guard_issues = preservation_guard_issues(original, replacement, heading)
            accepted_by_adjudication = False
            adjudication_reason = ""
            if guard_issues and self._semantic_guard_can_be_llm_adjudicated(guard_issues, heading=heading):
                adjudication = self._adjudicate_semantic_guard(
                    heading=heading,
                    original_body=original,
                    candidate_body=replacement,
                    guard_issues=guard_issues,
                    facts=facts,
                )
                if adjudication is not None and adjudication.accept:
                    accepted_by_adjudication = True
                    adjudication_reason = adjudication.reason
            if guard_issues and not accepted_by_adjudication:
                audit["rejected_patches"] += 1
                audit["issues"].append({
                    "code": "methodology_paragraph_guard_rejected",
                    "heading": heading,
                    "paragraph_index": paragraph_index,
                    "reason": patch.reason,
                    "guard_issues": self._semantic_guard_issue_summary(guard_issues),
                })
                continue
            paragraphs[paragraph_index - 1] = replacement
            changed_sections.add(heading)
            audit["accepted_patches"] += 1
            audit["issues"].append({
                "code": (
                    "methodology_paragraph_adjudicated_and_accepted"
                    if accepted_by_adjudication else
                    "methodology_paragraph_accepted"
                ),
                "heading": heading,
                "paragraph_index": paragraph_index,
                "reason": adjudication_reason or patch.reason,
            })
        repaired = manuscript
        for heading in changed_sections:
            repaired = self._replace_h2_section_body(
                repaired,
                heading,
                "\n\n".join(paragraph for paragraph in section_paragraphs[heading] if paragraph.strip()) + "\n",
            )
        return repaired, audit

    @staticmethod
    def _should_use_fact_locked_first(
        protocol: ResearchProtocol,
        facts: dict,
        meta_results: MetaAnalysisResults | None,
    ) -> bool:
        """Decide when deterministic prose must precede LLM drafting.

        Publication-ready reviews now start from the structured facts rather
        than from unconstrained section-by-section prose. The LLM can still be
        used for bounded background and clinical interpretation, but the
        high-risk manuscript skeleton (methods, PRISMA counts, primary results,
        GRADE, tables, declarations, and figure references) must be rendered
        from the same facts that passed the evidence gate.
        """
        if facts.get("report_type") not in {"meta", "benchmark_reconstruction"}:
            return False
        compiled_method = bool(
            facts.get("method_family")
            and isinstance(facts.get("synthesis_result"), dict)
            and (facts.get("synthesis_result") or {}).get("primary_estimates")
        )
        if meta_results is None and not compiled_method:
            return False
        constraints = facts.get("writing_constraints") if isinstance(facts.get("writing_constraints"), dict) else {}
        if constraints.get("force_fact_locked_first") is True:
            return True
        if str(facts.get("report_type") or "").lower() == "benchmark_reconstruction":
            return True
        readiness = facts.get("evidence_readiness") or {}
        if readiness.get("blockers"):
            return False
        return True

    def _apply_claim_map_citations(self, manuscript: str, facts: dict) -> tuple[str, dict]:
        """Restore source-backed claim citations after LLM open-section authoring.

        The authoring model is allowed to rewrite Introduction, Discussion, and
        Conclusion for clinical coherence, but source-backed claims must remain
        visibly connected to the references chosen by claim/source resolution.
        This is not density backfilling: citations are derived from claim-map
        source IDs, source locations, selected primary rows, and the current
        reference list.
        """
        audit: dict = {
            "schema_version": 1,
            "status": "ok",
            "sections_touched": 0,
            "issues": [],
        }
        entries = self._reference_entries_from_references_section(manuscript)
        if not entries:
            audit.update({"status": "skipped", "reason": "no_reference_entries"})
            return manuscript, audit
        claim_map = facts.get("claim_map") if isinstance(facts.get("claim_map"), list) else []
        self._current_claim_citation_facts = facts
        source_id_map = self._source_id_reference_number_map(entries, facts)
        refs_text = "\n\n".join(f"[{int(entry.get('number') or 0)}] {entry.get('text') or ''}" for entry in entries)
        claim_marker_map = self._claim_marker_reference_number_map(entries, facts, refs_text)
        source_marker_map = {**source_id_map, **claim_marker_map}
        self._claim_map_source_id_citation_map = source_marker_map
        self._claim_map_reference_entries = entries
        self._claim_map_references_text = refs_text
        self._claim_map_citation_contract = self._claim_citation_contract(entries, facts, refs_text)
        manuscript = self._replace_source_id_citation_markers(manuscript, source_marker_map)
        plan = self._claim_map_section_citation_plan(entries, facts)
        self._claim_map_citation_candidates = plan
        if self._claim_map_citation_contract:
            audit["claim_citation_contract"] = self._claim_map_citation_contract
        if not plan and not claim_map:
            audit.update({"status": "skipped", "reason": "no_claim_source_citations"})
            return manuscript, audit

        updated = manuscript
        headings = ["引言", "讨论", "结论"] if self._zh else ["Introduction", "Discussion", "Conclusion"]
        for heading in headings:
            citations = plan.get(heading) or []
            if not citations and not claim_map:
                continue
            body = self._h2_section_body(updated, heading)
            if not str(body or "").strip():
                continue
            original_body = body
            restored = self._apply_claim_sentence_citations(body, claim_map, entries, refs_text, heading)
            if restored != body:
                body = restored
                audit["issues"].append({
                    "code": "claim_sentence_citations_resolved",
                    "heading": heading,
                })
                audit["sections_touched"] += 1
            if claim_map:
                if body != original_body:
                    updated = self._replace_h2_section_body(updated, heading, body.rstrip() + "\n")
                continue
            if not citations:
                if restored != self._h2_section_body(updated, heading):
                    updated = self._replace_h2_section_body(updated, heading, body.rstrip() + "\n")
                continue
            restored = self._apply_citations_to_section_body(body, citations, heading)
            if restored != original_body:
                updated = self._replace_h2_section_body(updated, heading, restored.rstrip() + "\n")
                if restored != body:
                    audit["sections_touched"] += 1
                    audit["issues"].append({
                        "code": "claim_map_citations_restored",
                        "heading": heading,
                        "citations": citations[:8],
                    })
        return updated, audit

    def _apply_claim_sentence_citations(
        self,
        body: str,
        claim_map: list,
        entries: list[dict[str, object]],
        refs_text: str,
        heading: str,
    ) -> str:
        """Pin inline citations to the sentences backed by claim-map sources."""
        if not claim_map:
            return body
        updated = str(body or "")
        for claim in claim_map:
            if not isinstance(claim, dict):
                continue
            if not self._claim_section_matches_heading(str(claim.get("section") or ""), heading):
                continue
            claim_text = str(claim.get("claim") or "").strip()
            if len(claim_text) < 24:
                continue
            citation = self._citation_for_claim_source(entries, refs_text, claim)
            citation = self._display_citation_for_text(citation, "中文" if self._zh else "English")
            if not citation or not self._citation_numbers_from_text(citation):
                continue
            updated = self._replace_or_append_claim_sentence_citation(updated, claim_text, citation)
        return updated

    def _replace_or_append_claim_sentence_citation(self, body: str, claim_text: str, citation: str) -> str:
        citation_numbers = set(self._citation_numbers_from_text(citation))
        if not citation_numbers:
            return body
        pieces: list[str] = []
        cursor = 0
        changed = False
        for start, end in self._sentence_spans_for_claim_citations(body):
            pieces.append(body[cursor:start])
            sentence = body[start:end]
            if not changed and self._sentence_matches_claim(sentence, claim_text):
                current_numbers = set(self._citation_numbers_from_text(sentence))
                if not current_numbers:
                    sentence = self._append_citation_to_sentence(sentence, citation)
                    changed = True
                elif not (current_numbers & citation_numbers):
                    replaced = re.sub(
                        r"[\[［][0-9\s,，、;；\-–—至]+[\]］](?=\s*[。！？.!?]?$)",
                        citation,
                        sentence,
                        count=1,
                    )
                    if replaced == sentence:
                        replaced = self._append_citation_to_sentence(sentence, citation)
                    sentence = replaced
                    changed = True
            pieces.append(sentence)
            cursor = end
        pieces.append(body[cursor:])
        return "".join(pieces)

    @staticmethod
    def _sentence_spans_for_claim_citations(text: str) -> list[tuple[int, int]]:
        """Return sentence spans without splitting decimal numbers such as 0.81."""
        raw = str(text or "")
        spans: list[tuple[int, int]] = []
        start = 0
        for index, char in enumerate(raw):
            if char == "\n":
                if index > start:
                    spans.append((start, index))
                start = index + 1
                continue
            if char not in ".!?。！？":
                continue
            if char == ".":
                prev_char = raw[index - 1] if index > 0 else ""
                next_char = raw[index + 1] if index + 1 < len(raw) else ""
                if prev_char.isdigit() and next_char.isdigit():
                    continue
                before = raw[:index + 1].lower()
                if re.search(r"(?:^|[\s(])(?:e\.|i\.|vs\.|etc\.)$", before[-12:]):
                    continue
                if before.endswith(("e.g.", "i.e.")):
                    continue
                if re.search(r"(?:^|[\s(])[a-z]\.$", before[-4:]) and next_char.isalpha():
                    continue
            end = index + 1
            while end < len(raw) and raw[end].isspace() and raw[end] != "\n":
                end += 1
            spans.append((start, end))
            start = end
        if start < len(raw):
            spans.append((start, len(raw)))
        return [(s, e) for s, e in spans if str(raw[s:e]).strip()]

    def _sentence_matches_claim(self, sentence: str, claim_text: str) -> bool:
        sentence_norm = self._normalise_claim_match_text(sentence)
        claim_norm = self._normalise_claim_match_text(claim_text)
        if not sentence_norm or not claim_norm:
            return False
        if claim_norm in sentence_norm or sentence_norm in claim_norm:
            return True
        if self._zh:
            compact_sentence = re.sub(r"\s+", "", sentence_norm)
            compact_claim = re.sub(r"\s+", "", claim_norm)
            if len(compact_claim) >= 24 and compact_claim[:24] in compact_sentence:
                return True
        claim_tokens = set(self._claim_match_tokens(claim_norm))
        sentence_tokens = set(self._claim_match_tokens(sentence_norm))
        if not claim_tokens or not sentence_tokens:
            return False
        overlap = claim_tokens & sentence_tokens
        return len(overlap) >= max(4, math.ceil(len(claim_tokens) * 0.62))

    @staticmethod
    def _normalise_claim_match_text(text: str) -> str:
        text = re.sub(r"[\[［][0-9\s,，、;；\-–—至]+[\]］]", " ", str(text or ""))
        text = re.sub(r"\s+", " ", text).strip().lower()
        return text

    @staticmethod
    def _claim_match_tokens(text: str) -> list[str]:
        return [
            token for token in re.findall(r"[A-Za-z0-9]+", str(text or "").lower())
            if len(token) >= 4 and token not in {
                "with", "from", "that", "this", "study", "trial", "analysis", "meta",
                "patients", "outcome", "heart", "failure",
            }
        ]

    @staticmethod
    def _append_citation_to_sentence(sentence: str, citation: str) -> str:
        raw = str(sentence or "")
        match = re.search(r"(\s*[。！？.!?]\s*)$", raw)
        if match:
            return raw[:match.start()] + str(citation or "") + match.group(1)
        return raw.rstrip() + str(citation or "")

    def _apply_claim_section_citations(self, heading: str, body: str, facts: dict) -> str:
        """Apply the current claim citation plan to a candidate section body."""
        plan = getattr(self, "_claim_map_citation_candidates", None)
        source_id_map = getattr(self, "_claim_map_source_id_citation_map", None)
        if isinstance(source_id_map, dict) and source_id_map:
            body = self._replace_source_id_citation_markers(body, source_id_map)
        entries = getattr(self, "_claim_map_reference_entries", None)
        refs_text = getattr(self, "_claim_map_references_text", "")
        claim_map = facts.get("claim_map") if isinstance(facts.get("claim_map"), list) else []
        if isinstance(entries, list) and entries and claim_map:
            body = self._apply_claim_sentence_citations(body, claim_map, entries, str(refs_text or ""), heading)
            return body
        if not isinstance(plan, dict) or not plan:
            return body
        canonical = self._canonical_semantic_heading(heading)
        citations = plan.get(canonical) or plan.get(heading) or []
        if not citations:
            return body
        return self._apply_citations_to_section_body(body, citations, canonical)

    def _claim_section_matches_heading(self, claim_section: str, heading: str) -> bool:
        claim_canonical = self._canonical_semantic_heading(claim_section)
        heading_canonical = self._canonical_semantic_heading(heading)
        if str(claim_canonical or "").strip().lower() == str(heading_canonical or "").strip().lower():
            return True
        for part in re.split(r"\s*(?:/|,|，|;|；|\||&|\band\b|\bor\b)\s*", str(claim_section or ""), flags=re.I):
            part = part.strip()
            if not part:
                continue
            part_canonical = self._canonical_semantic_heading(part)
            if str(part_canonical or "").strip().lower() == str(heading_canonical or "").strip().lower():
                return True
        claim_raw = str(claim_section or "").strip().lower()
        heading_raw = str(heading or "").strip().lower()
        return bool(claim_raw and heading_raw and (claim_raw in heading_raw or heading_raw in claim_raw))

    def _apply_citations_to_section_body(self, body: str, citations: list[str], heading: str) -> str:
        unique_citations = []
        for citation in citations:
            raw = str(citation or "").strip()
            if not raw:
                continue
            if raw not in unique_citations:
                unique_citations.append(raw)
        if not unique_citations:
            return body
        parts = re.split(r"(\n\s*\n)", str(body or ""))
        substantial_indices: list[int] = []
        cited_indices: set[int] = set()
        for index in range(0, len(parts), 2):
            paragraph = parts[index]
            if not self._paragraph_has_citable_line(paragraph):
                continue
            paragraph_without_citations = re.sub(r"[\[［][0-9\s,，、;；\-–—至]+[\]］]", " ", paragraph)
            if self._text_unit_count(paragraph_without_citations) < PUBLICATION_CITATION_MIN_SUBSTANTIAL_PARAGRAPH_WORDS:
                continue
            substantial_indices.append(index)
            if self._citation_numbers_from_text(paragraph):
                cited_indices.add(index)
        if not substantial_indices:
            return body
        if str(heading or "").strip().lower() in {"conclusion", "结论"}:
            target_cited = 1
        else:
            target_cited = min(
                len(substantial_indices),
                max(1, math.ceil(len(substantial_indices) * PUBLICATION_INTERPRETIVE_CITED_PARAGRAPH_RATE)),
            )
        if len(cited_indices) >= target_cited:
            return body
        citation_index = 0
        for index in substantial_indices:
            if len(cited_indices) >= target_cited:
                break
            if index in cited_indices:
                continue
            if (
                self._paragraph_reports_own_pooled_result(parts[index])
                and str(heading or "").strip().lower() not in {"conclusion", "结论"}
            ):
                continue
            citation = unique_citations[citation_index % len(unique_citations)]
            citation_index += 1
            updated_paragraph = self._append_citation_to_first_paragraph(
                parts[index],
                citation,
                heading=heading,
            )
            if updated_paragraph != parts[index]:
                parts[index] = updated_paragraph
                cited_indices.add(index)
        return "".join(parts)

    def _claim_map_section_citation_plan(self, entries: list[dict[str, object]], facts: dict) -> dict[str, list[str]]:
        claim_map = facts.get("claim_map") if isinstance(facts.get("claim_map"), list) else []
        refs_text = "\n\n".join(f"[{int(entry.get('number') or 0)}] {entry.get('text') or ''}" for entry in entries)
        selected_rows = (
            ((facts.get("evidence_readiness") or {}).get("selected_primary_rows") or [])
            if isinstance(facts.get("evidence_readiness"), dict) else []
        )
        plan: dict[str, list[str]] = {}
        headings = ["引言", "讨论", "结论"] if self._zh else ["Introduction", "Discussion", "Conclusion"]
        for heading in headings:
            citations: list[str] = []
            for claim in claim_map:
                if not isinstance(claim, dict):
                    continue
                if not self._claim_section_matches_heading(str(claim.get("section") or ""), heading):
                    continue
                citation = self._citation_for_claim_source(entries, refs_text, claim)
                if citation:
                    citations.append(citation)
            deduped: list[str] = []
            for citation in citations:
                normalized = str(citation or "").strip()
                if not normalized:
                    continue
                if len(self._citation_numbers_from_text(normalized)) > 3:
                    continue
                display = self._display_citation_for_text(normalized, "中文" if self._zh else "English")
                if display not in deduped:
                    deduped.append(display)
            if deduped:
                plan[heading] = deduped[:8]
            elif str(heading or "").strip().lower() in {"conclusion", "结论"}:
                selected_citation = self._citation_for_selected_rows(entries, selected_rows)
                selected_citation = self._display_citation_for_text(
                    selected_citation,
                    "中文" if self._zh else "English",
                )
                if selected_citation:
                    plan[heading] = [selected_citation]
        return plan

    def _claim_citation_contract(
        self,
        entries: list[dict[str, object]],
        facts: dict,
        refs_text: str,
    ) -> dict[str, dict[str, object]]:
        """Return approved citation markers for source-backed claim-map items."""
        claim_map = facts.get("claim_map") if isinstance(facts.get("claim_map"), list) else []
        contract: dict[str, dict[str, object]] = {}
        for claim in claim_map:
            if not isinstance(claim, dict):
                continue
            if claim.get("can_write_main_text", True) is False:
                continue
            if str(claim.get("manuscript_use") or "main").strip().lower() == "exclude":
                continue
            claim_id = str(claim.get("id") or "").strip()
            if not claim_id:
                continue
            citation = self._citation_for_claim_source(entries, refs_text, claim)
            citation = self._display_citation_for_text(citation, "中文" if self._zh else "English")
            numbers = self._citation_numbers_from_text(citation)
            source_spans = self._source_spans_for_contract_claim(claim)
            if not numbers and not source_spans:
                continue
            contract[claim_id] = {
                "citation": citation if numbers else "",
                "reference_numbers": numbers[:3],
                "source_study_id": str(claim.get("source_study_id") or ""),
                "source_location": str(claim.get("source_location") or ""),
                "support_source": str(claim.get("support_source") or ""),
            }
        return contract

    def _citation_contract_document(self, facts: dict) -> CitationContract:
        """Return the typed claim-to-citation contract for audit and reuse.

        The runtime contract is deliberately small and optimized for authoring.
        This document is the durable hand-off artifact: it carries source spans,
        reference ids, and citation numbers so later validation does not need to
        infer citation provenance from prose.
        """
        raw_contract = getattr(self, "_claim_map_citation_contract", None)
        if not isinstance(raw_contract, dict) or not raw_contract:
            return CitationContract(status="skipped")
        claim_map = facts.get("claim_map") if isinstance(facts, dict) and isinstance(facts.get("claim_map"), list) else []
        claims_by_id = {
            str(claim.get("id") or ""): claim
            for claim in claim_map
            if (
                isinstance(claim, dict)
                and str(claim.get("id") or "").strip()
                and claim.get("can_write_main_text", True) is not False
                and str(claim.get("manuscript_use") or "main").strip().lower() != "exclude"
            )
        }
        entries = getattr(self, "_claim_map_reference_entries", None)
        reference_ids_by_number = self._reference_ids_by_number(entries if isinstance(entries, list) else [])
        items: list[CitationContractItem] = []
        for claim_id, item in raw_contract.items():
            if not isinstance(item, dict):
                continue
            numbers = [
                int(number)
                for number in (item.get("reference_numbers") or [])
                if isinstance(number, int) or str(number).isdigit()
            ]
            claim = claims_by_id.get(str(claim_id)) or {}
            if not claim:
                continue
            source_spans = self._source_spans_for_contract_claim(claim)
            items.append(
                CitationContractItem(
                    claim_id=str(claim_id),
                    citation=str(item.get("citation") or ""),
                    reference_numbers=numbers,
                    reference_ids=[
                        reference_ids_by_number.get(number, "")
                        for number in numbers
                        if reference_ids_by_number.get(number, "")
                    ],
                    source_spans=source_spans,
                    support_source=str(item.get("support_source") or claim.get("support_source") or ""),
                )
            )
        return CitationContract(status="ok" if items else "skipped", items=items)

    def _save_citation_contract(self, project: Project, facts: dict) -> None:
        contract = self._citation_contract_document(facts)
        project.save_json("citation_contract.json", contract.model_dump(), subdir="manuscript")

    @staticmethod
    def _reference_ids_by_number(entries: list[dict[str, object]]) -> dict[int, str]:
        mapping: dict[int, str] = {}
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            try:
                number = int(entry.get("number") or 0)
            except (TypeError, ValueError):
                continue
            if number <= 0:
                continue
            text = str(entry.get("text") or "")
            pmid_match = re.search(r"\bPMID:\s*([0-9]+)", text, flags=re.I)
            doi_match = re.search(r"\bdoi:\s*([^\s.]+(?:\.[^\s.]+)*)", text, flags=re.I)
            if pmid_match:
                mapping[number] = f"pmid:{pmid_match.group(1)}"
            elif doi_match:
                mapping[number] = f"doi:{doi_match.group(1).rstrip('.,;')}"
            else:
                mapping[number] = str(entry.get("id") or "")
        return mapping

    @staticmethod
    def _source_spans_for_contract_claim(claim: dict) -> list[SourceSpan]:
        raw_spans = claim.get("source_spans") if isinstance(claim, dict) else None
        spans: list[SourceSpan] = []
        if isinstance(raw_spans, list):
            for raw in raw_spans:
                if isinstance(raw, SourceSpan):
                    spans.append(raw)
                elif isinstance(raw, dict):
                    try:
                        spans.append(SourceSpan.model_validate(raw))
                    except Exception:
                        continue
        if spans:
            return spans
        if not isinstance(claim, dict):
            return []
        source_id = str(claim.get("source_study_id") or claim.get("support_source") or "").strip()
        if not source_id:
            return []
        return [
            SourceSpan(
                source_id=source_id,
                study_id=str(claim.get("source_study_id") or ""),
                source_type="claim_source",
                location=str(claim.get("source_location") or ""),
                quote=str(claim.get("source_quote") or ""),
                verified=bool(str(claim.get("source_quote") or "").strip()),
                support_strength="direct" if str(claim.get("source_quote") or "").strip() else "indirect",
            )
        ]

    def _source_id_reference_number_map(self, entries: list[dict[str, object]], facts: dict) -> dict[str, int]:
        mapping: dict[str, int] = {}
        selected_rows = (
            ((facts.get("evidence_readiness") or {}).get("selected_primary_rows") or [])
            if isinstance(facts.get("evidence_readiness"), dict) else []
        )
        for row in selected_rows:
            if not isinstance(row, dict):
                continue
            source_id = str(row.get("study_id") or row.get("pmid") or "").strip()
            if not source_id:
                continue
            numbers = self._reference_numbers_for_terms(
                entries,
                [
                    str(row.get("study_label") or ""),
                    str(row.get("title") or ""),
                    "Empagliflozin in Heart Failure with a Preserved Ejection Fraction" if source_id == "34449189" else "",
                    "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction" if source_id == "36027570" else "",
                ],
            )
            if numbers:
                mapping[source_id] = int(numbers[0])
        claim_map = facts.get("claim_map") if isinstance(facts.get("claim_map"), list) else []
        refs_text = "\n\n".join(f"[{int(entry.get('number') or 0)}] {entry.get('text') or ''}" for entry in entries)
        for claim in claim_map:
            if not isinstance(claim, dict):
                continue
            source_ids = [
                item.split(":", 1)[-1].strip()
                for item in re.split(r"\s*(?:,|，|;|；)\s*", str(claim.get("source_study_id") or ""))
                if item.strip()
            ]
            unresolved = [item for item in source_ids if item and item not in mapping]
            if not unresolved:
                continue
            citation = self._citation_for_claim_source(entries, refs_text, claim)
            numbers = self._citation_numbers_from_text(citation)
            if not numbers:
                continue
            if len(numbers) == len(source_ids):
                for source_id, number in zip(source_ids, numbers):
                    mapping.setdefault(source_id, int(number))
            elif len(numbers) == 1:
                for source_id in unresolved:
                    mapping.setdefault(source_id, int(numbers[0]))
        return mapping

    @staticmethod
    def _replace_source_id_citation_markers(text: str, source_id_map: dict[str, object]) -> str:
        if not source_id_map:
            return text

        def repl(match: re.Match[str]) -> str:
            opener = match.group(1)
            body = match.group(2)
            closer = match.group(3)
            parts = [part.strip() for part in re.split(r"(?:,|，|、|;|；)", body) if part.strip()]
            if not parts:
                return match.group(0)
            changed = False
            numbers: list[int] = []
            for part in parts:
                if re.search(r"[-–—至]", part):
                    return match.group(0)
                compact = re.sub(r"\D", "", part)
                marker_key = ClaimMapMixin._claim_source_marker_key(part)
                mapped = None
                if compact in source_id_map:
                    mapped = source_id_map[compact]
                elif marker_key in source_id_map:
                    mapped = source_id_map[marker_key]
                if mapped is not None:
                    mapped_values = mapped if isinstance(mapped, (list, tuple, set)) else [mapped]
                    for value in mapped_values:
                        try:
                            number = int(value)
                        except (TypeError, ValueError):
                            continue
                        if number > 0:
                            numbers.append(number)
                    changed = True
                elif compact.isdigit():
                    try:
                        value = int(compact)
                    except ValueError:
                        value = 0
                    # Keep ordinary reference numbers. Drop very large unmapped
                    # source identifiers rather than treating them as references.
                    if 0 < value < 1000:
                        numbers.append(value)
                    else:
                        changed = True
                else:
                    if ClaimMapMixin._claim_source_marker_is_internal(part):
                        changed = True
                        continue
                    return match.group(0)
            if not changed:
                return match.group(0)
            cluster = CitationRepairMixin._citation_cluster(numbers)
            if not cluster:
                return ""
            if opener == "［":
                return cluster.replace("[", "［").replace("]", "］").replace(",", "，")
            return cluster

        return re.sub(r"(\[|［)([0-9A-Za-z_.\s,，、;；:\-–—]+)(\]|］)", repl, str(text or ""))

    @staticmethod
    def _claim_source_marker_key(value: str) -> str:
        return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())

    @staticmethod
    def _claim_source_marker_is_internal(value: str) -> bool:
        key = ClaimMapMixin._claim_source_marker_key(value)
        internal_tokens = (
            "primaryeffect",
            "primaryeffectdata",
            "primarypopulation",
            "metaanalysis",
            "metares",
            "gradesummary",
            "gradecertainty",
            "gradedomains",
            "gradedomainpublicationbias",
            "gradedomaininconsistency",
            "gradedomainriskofbias",
            "gradedomainimprecision",
            "gradedomainindirectness",
            "pico",
            "picopopulation",
            "picointervention",
            "picocomparator",
            "protocolpico",
            "researchquestion",
        )
        return any(token in key for token in internal_tokens)

    def _claim_marker_reference_number_map(
        self,
        entries: list[dict[str, object]],
        facts: dict,
        refs_text: str,
    ) -> dict[str, list[int]]:
        mapping: dict[str, list[int]] = {}
        claim_map = facts.get("claim_map") if isinstance(facts.get("claim_map"), list) else []
        for claim in claim_map:
            if not isinstance(claim, dict):
                continue
            citation = self._citation_for_claim_source(entries, refs_text, claim)
            numbers = self._citation_numbers_from_text(citation)
            if not numbers:
                continue
            marker_values: list[str] = []
            for key in ("support_source", "source_location", "source_study_id"):
                raw = str(claim.get(key) or "").strip()
                if not raw:
                    continue
                marker_values.append(raw)
                marker_values.extend(part.strip() for part in re.split(r"\s*(?:,|，|;|；)\s*", raw) if part.strip())
            for marker in marker_values:
                marker_key = self._claim_source_marker_key(marker)
                if marker_key:
                    background_numbers = self._reference_numbers_for_background_marker(entries, facts, marker)
                    mapping.setdefault(marker_key, (background_numbers or numbers)[:3])
        return mapping

    def _reference_numbers_for_background_marker(
        self,
        entries: list[dict[str, object]],
        facts: dict,
        marker: str,
    ) -> list[int]:
        marker_text = str(marker or "").strip()
        match = re.search(r"pubmed_background\s*:?\s*([0-9]{6,9})", marker_text, flags=re.I)
        if not match:
            return []
        pmid = match.group(1)
        background_refs = (
            ((facts.get("background_evidence") or {}).get("references") or [])
            if isinstance(facts, dict) else []
        )
        for ref in background_refs:
            if not isinstance(ref, dict):
                continue
            if str(ref.get("pmid") or "").strip() != pmid:
                continue
            terms = [
                str(ref.get("title") or ""),
                str(ref.get("citation") or ""),
                str(ref.get("source") or ""),
            ]
            numbers = self._reference_numbers_for_terms(entries, terms)
            if numbers:
                return numbers
        return []

    def _citation_for_claim_source(self, entries: list[dict[str, object]], refs_text: str, claim: dict) -> str:
        support_source = str(claim.get("support_source") or "").strip().lower()
        source_location_l = str(claim.get("source_location") or "").strip().lower()
        has_external_source = any(token in support_source for token in (
            "pubmed_background",
            "background",
            "guideline",
            "prior_review",
            "systematic_review",
            "endpoint_definition",
            "study_card",
            "trial",
        ))
        has_internal_source = any(token in support_source for token in (
            "primary_effect",
            "primary effect",
            "primaryeffect",
            "pooled effect",
            "pooled estimate",
            "meta-analysis result",
            "grade certainty",
            "grade summary",
        ))
        if "endpoint_definition" in support_source or "endpoint definition" in source_location_l:
            selected_rows = (
                ((getattr(self, "_current_claim_citation_facts", {}) or {}).get("evidence_readiness") or {}).get("selected_primary_rows") or []
            )
            citation = self._citation_for_selected_rows(entries, selected_rows)
            if citation:
                return citation
        if any(token in support_source for token in ("pico.population", "pico.intervention", "pico.comparator", "primary_population")):
            selected_rows = (
                ((getattr(self, "_current_claim_citation_facts", {}) or {}).get("evidence_readiness") or {}).get("selected_primary_rows") or []
            )
            citation = self._citation_for_selected_rows(entries, selected_rows)
            if citation:
                return citation
        patterns: list[str] = []
        source_ids = [
            item for item in re.split(r"\s*(?:,|，|;|；)\s*", str(claim.get("source_study_id") or ""))
            if item and str(item).strip().lower() not in {"none", "null", "na", "n/a"}
        ]
        source_id_numbers = self._reference_numbers_for_source_ids(entries, source_ids)
        if source_id_numbers:
            return self._citation_cluster(source_id_numbers)
        # Numbered manuscript references do not always print PMID values.  Use
        # the source-linked study card/selected row to recover stable title and
        # author-year terms for the same source id.
        source_terms: list[str] = []
        facts = getattr(self, "_current_claim_citation_facts", {}) or {}
        normalized_ids = {
            str(item or "").strip().split(":", 1)[-1]
            for item in source_ids
            if str(item or "").strip()
        }
        for row in ((facts.get("evidence_readiness") or {}).get("selected_primary_rows") or []):
            if not isinstance(row, dict):
                continue
            row_id = str(row.get("study_id") or row.get("pmid") or "").strip().split(":", 1)[-1]
            if row_id not in normalized_ids:
                continue
            source_terms.extend(str(row.get(key) or "") for key in ("study_label", "title", "pmid"))
        for card in facts.get("study_cards") or []:
            if not isinstance(card, dict):
                continue
            card_id = str(card.get("study_id") or card.get("pmid") or "").strip().split(":", 1)[-1]
            if card_id not in normalized_ids:
                continue
            source_terms.extend(
                str(card.get(key) or "")
                for key in ("display_name", "study_label", "title", "pmid")
            )
        source_term_numbers = self._reference_numbers_for_terms(entries, source_terms)
        if source_term_numbers:
            return self._citation_cluster(source_term_numbers)
        if any(token in support_source for token in ("primary_effect", "primary effect", "absolute_effect", "absolute effects", "pooled effect", "pooled estimate")):
            selected_rows = (
                ((getattr(self, "_current_claim_citation_facts", {}) or {}).get("evidence_readiness") or {}).get("selected_primary_rows") or []
            )
            citation = self._citation_for_selected_rows(entries, selected_rows)
            if citation:
                return citation
        if has_internal_source and not has_external_source:
            return ""
        known_id_terms = {
            "34449189": ["Empagliflozin in Heart Failure with a Preserved Ejection Fraction", "Anker"],
            "36027570": ["Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction", "Solomon"],
            "32876695": ["CoDEX", "Tomazini"],
            "32876697": ["REMAP-CAP", "Angus"],
            "32876689": ["CAPE COVID", "Dequin"],
            "32785710": ["Metcovid", "Jeronimo"],
        }
        for raw_source_id in source_ids:
            source_id = str(raw_source_id or "").strip()
            if not source_id:
                continue
            source_id = source_id.split(":", 1)[-1]
            if len(source_id) >= 4 and not source_id.isdigit():
                patterns.append(re.escape(source_id))
            for term in known_id_terms.get(source_id, []):
                patterns.append(re.escape(term))
        source_location = str(claim.get("source_location") or "").strip()
        if len(source_location) >= 12:
            patterns.append(re.escape(source_location[:120]))
        citation = self._citation_for_reference_patterns(refs_text, patterns)
        if citation:
            return citation
        terms = [source_location]
        for term in known_id_terms.get(str(claim.get("source_study_id") or "").strip(), []):
            terms.append(term)
        numbers = self._reference_numbers_for_terms(entries, terms)
        return self._citation_cluster(numbers)

    @staticmethod
    def _reference_numbers_for_source_ids(entries: list[dict[str, object]], source_ids: list[str]) -> list[int]:
        known_exact_terms = {
            "34449189": ["Empagliflozin in Heart Failure with a Preserved Ejection Fraction"],
            "36027570": ["Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction"],
            "32876695": ["CoDEX"],
            "32876697": ["REMAP-CAP"],
            "32876689": ["CAPE COVID"],
            "32785710": ["Metcovid"],
        }
        numbers: list[int] = []
        for raw_source_id in source_ids or []:
            source_id = str(raw_source_id or "").strip().split(":", 1)[-1]
            if not source_id:
                continue
            terms = known_exact_terms.get(source_id, [])
            if source_id.isdigit():
                terms = [source_id] + terms
            for entry in entries:
                try:
                    number = int(entry.get("number") or 0)
                except (TypeError, ValueError):
                    number = 0
                if number <= 0 or number in numbers:
                    continue
                text = str(entry.get("text") or "")
                text_lower = text.lower()
                matched = False
                for term in terms:
                    term = str(term or "").strip()
                    if not term:
                        continue
                    if term.isdigit():
                        if re.search(rf"\b(?:pmid|pubmed)\s*:?\s*{re.escape(term)}\b", text_lower):
                            matched = True
                            break
                        continue
                    if term.lower() in text_lower:
                        matched = True
                        break
                if matched:
                    numbers.append(number)
                    break
        return numbers

    def _citation_for_selected_rows(self, entries: list[dict[str, object]], rows: list[dict]) -> str:
        source_ids = [
            str(row.get("study_id") or row.get("pmid") or row.get("trial_id") or "").strip()
            for row in rows or []
            if isinstance(row, dict)
        ]
        exact_numbers = self._reference_numbers_for_source_ids(entries, source_ids)
        if exact_numbers:
            return self._citation_cluster(exact_numbers)
        terms: list[str] = []
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            for key in ("study_label", "study_id", "trial_id", "title"):
                value = str(row.get(key) or "").strip()
                if value:
                    terms.append(value)
            study_id = str(row.get("study_id") or "").strip()
            if study_id == "34449189":
                terms.append("Empagliflozin in Heart Failure with a Preserved Ejection Fraction")
            if study_id == "36027570":
                terms.append("Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction")
        return self._citation_cluster(self._reference_numbers_for_terms(entries, terms))

    @staticmethod
    def _reference_numbers_for_terms(entries: list[dict[str, object]], terms: list[str]) -> list[int]:
        numbers: list[int] = []
        for term in terms:
            tokens = [
                token for token in re.findall(r"[A-Za-z0-9]+", str(term or "").lower())
                if len(token) >= 4 and token not in {"with", "from", "study", "trial", "page", "table", "figure", "abstract", "results"}
            ]
            if not tokens:
                continue
            token_set = set(tokens)
            for entry in entries:
                text = str(entry.get("text") or "").lower()
                entry_tokens = set(re.findall(r"[A-Za-z0-9]+", text))
                overlap = token_set & entry_tokens
                required = min(4, max(2, math.ceil(len(token_set) * 0.55)))
                if len(overlap) >= required:
                    try:
                        number = int(entry.get("number") or 0)
                    except (TypeError, ValueError):
                        number = 0
                    if number > 0 and number not in numbers:
                        numbers.append(number)
        return numbers
