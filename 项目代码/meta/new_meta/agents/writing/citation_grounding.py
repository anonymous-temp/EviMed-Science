"""Grounding existing citation markers against the recorded sources."""
from __future__ import annotations

import json
import re

from new_meta.core.readability import sentence_length_rule

from new_meta.agents.writing.contracts import ClinicalManuscriptReview


class CitationGroundingMixin:
    """Grounding existing citation markers against the recorded sources."""

    @staticmethod
    def _paragraph_reports_own_pooled_result(text: str) -> bool:
        raw = str(text or "")
        return bool(
            re.search(
                r"(?:This systematic review and meta-analysis|This meta-analysis|In this systematic review|"
                r"In (?:a|this) meta-analysis|In (?:a|this) synthesis|Pooled analysis|"
                r"The primary pooled estimate|The pooled (?:HR|OR|RR|hazard ratio|odds ratio|risk ratio|estimate|effect|result)|"
                r"pooled (?:HR|OR|RR|hazard ratio|odds ratio|risk ratio|estimate|effect|result)|"
                r"本系统综述和Meta分析显示|主要合并结果|合并(?:HR|OR|RR|结果|效应))",
                raw,
                flags=re.IGNORECASE,
            )
            and re.search(
                r"\b(?:HR|OR|RR)\s*(?:=|of|为)?\s*0?\.\d+|"
                r"\b(?:hazard ratio|odds ratio|risk ratio)\s*(?:=|of)?\s*0?\.\d+|"
                r"合并HR为?\s*0?\.\d+",
                raw,
                flags=re.IGNORECASE,
            )
        )

    def _semantic_edit_prompt(
        self,
        facts: dict,
        sections: dict[str, str],
        *,
        clinical_review: ClinicalManuscriptReview | None = None,
    ) -> str:
        primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
        population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
        study_cards = facts.get("study_cards") if isinstance(facts.get("study_cards"), list) else []
        grade = ((facts.get("grade") or {}).get("outcomes") or [{}])[0] if isinstance(facts.get("grade"), dict) else {}
        section_text, section_inventory = self._semantic_sections_prompt_text(
            sections,
            max_chars_per_section=7000,
        )
        style_targets = {
            heading: {
                "rather_than_count": len(re.findall(r"\brather than\b", body, flags=re.I)),
                "abstract_subject_examples": re.findall(
                    r"\b(?:the analysis|the result|the evidence base|the pooled estimate|the review|the manuscript|this review|this synthesis|this distinction)\b",
                    body,
                    flags=re.I,
                )[:10],
            }
            for heading, body in sections.items()
        }
        facts_block = {
            "output_language": self._lang,
            "report_type": facts.get("report_type"),
            "primary_effect": primary,
            "primary_population": population,
            "model_decision": facts.get("model_decision") if isinstance(facts.get("model_decision"), dict) else {},
            "model_sensitivity": facts.get("model_sensitivity") if isinstance(facts.get("model_sensitivity"), dict) else {},
            "grade": {
                "certainty": grade.get("certainty"),
                "effect_summary": grade.get("effect_summary"),
                "domains": grade.get("domains"),
            },
            "study_cards": study_cards[:8],
            "evidence_warnings": (facts.get("evidence_readiness") or {}).get("warnings", []),
        }
        review_block = (
            clinical_review.model_dump()
            if isinstance(clinical_review, ClinicalManuscriptReview)
            else {}
        )
        language_rule = (
            "Write in Chinese. Preserve citation support for every remaining claim."
            if self._zh else
            "Write in English. Preserve citation support for every remaining claim."
        )
        return (
            "You are a senior clinical systematic-review editor. Improve only editable manuscript prose sections "
            "(Abstract narrative fields, Introduction, Methods prose, Results prose, Discussion, Conclusion). Do not edit tables, GRADE, figures, "
            "declarations, or references.\n\n"
            f"{language_rule}\n"
            + sentence_length_rule(self._lang) + "\n"
            "Your job is conservative clinical editing, not a fresh rewrite. Start from each original section and keep "
            "the same factual coverage. Make the manuscript read like a clinical meta-analysis rather than a template: "
            "sharpen the clinical argument, remove generic method self-commentary, make limitations concrete, and "
            "interpret the effect in context. For Methods and Results, prefer journal-style concision over exhaustive "
            "teaching prose: remove duplicated explanation, generic meta-analysis tutorial language, and full search "
            "query blocks when the same material is preserved in Appendix 1. Do not add new facts. Do not change any "
            "number, confidence interval, study name, drug name, outcome, table/figure reference, or certainty rating. "
            "Do not mention AI, automation, pipelines, metadata, or manuscript generation.\n\n"
            "If fewer than three studies contributed, do not describe I²=0%, tau²=0, or overlapping confidence intervals "
            "as reassuring evidence of homogeneity. Preserve the statistics, but keep the interpretation cautious.\n\n"
            "If you cannot safely improve a section while preserving all protected facts and citation support, omit it. "
            "If SECTION INVENTORY marks a section as truncated, do not return a whole-section replacement for that "
            "heading; leave it for paragraph-level editing instead. "
            "For Abstract, preserve structured labels and field line breaks such as Importance, Objective, Data sources, Study selection, "
            "Data extraction and synthesis, Main outcome and measures, Results, and Conclusions and relevance. Tighten "
            "clinical framing and conclusions, but keep all search counts, study counts, participant totals, event "
            "counts, effect estimates, confidence intervals, p values, certainty ratings, and search dates unchanged. "
            "For Methods, preserve every procedure needed to reproduce the review; tighten teaching-style explanations and avoid generic "
            "justification prose. "
            "For Results, edit only prose clarity and remove explanatory method filler; keep statistical sentences and "
            "numeric values intact.\n\n"
            "STYLE TARGETS TO ADDRESS WHEN SAFE:\n"
            f"{json.dumps(style_targets, ensure_ascii=False, indent=2)[:6000]}\n\n"
            "CLINICAL REVIEW BRIEF TO FOLLOW WHEN SAFE:\n"
            f"{json.dumps(review_block, ensure_ascii=False, indent=2)[:10000]}\n\n"
            "SECTION INVENTORY:\n"
            f"{json.dumps(section_inventory, ensure_ascii=False, indent=2)[:4000]}\n\n"
            "Return JSON only. For each section you improve, return the complete replacement body WITHOUT the H2 heading. "
            "If a section is already adequate, omit it.\n\n"
            "FACTS:\n"
            f"{json.dumps(facts_block, ensure_ascii=False, indent=2)[:12000]}\n\n"
            "SECTIONS TO EDIT:\n"
            f"{section_text}"
        )

    @staticmethod
    def _semantic_sections_prompt_text(
        sections: dict[str, str],
        *,
        max_chars_per_section: int,
    ) -> tuple[str, list[dict[str, object]]]:
        rendered: list[str] = []
        inventory: list[dict[str, object]] = []
        for heading, body in sections.items():
            text = str(body or "").strip()
            truncated = len(text) > max_chars_per_section
            if truncated:
                head_chars = max(1000, max_chars_per_section // 2)
                tail_chars = max(1000, max_chars_per_section - head_chars)
                excerpt = (
                    text[:head_chars].rstrip()
                    + "\n\n[...middle of this existing section omitted for prompt length; do not treat the section as missing...]\n\n"
                    + text[-tail_chars:].lstrip()
                )
            else:
                excerpt = text
            rendered.append(f"## {heading}\n{excerpt}")
            inventory.append({
                "heading": heading,
                "present": bool(text),
                "char_count": len(text),
                "truncated": truncated,
            })
        return "\n\n".join(rendered), inventory

    @staticmethod
    def _force_report_state_evidence_gap(facts: dict, report_state) -> None:
        """Keep legacy EvidenceGate report_state aligned with manuscript facts."""
        facts["report_type"] = "evidence_gap"
        readiness = facts.setdefault("evidence_readiness", {})
        readiness["report_type"] = "evidence_gap"
        readiness["status"] = "blocked"
        blockers = readiness.setdefault("blockers", [])
        if not any(item.get("code") == "evidence_gate_evidence_gap" for item in blockers):
            blockers.append({
                "code": "evidence_gate_evidence_gap",
                "message": (
                    "EvidenceGate classified this run as an evidence gap "
                    f"(direct eligible={getattr(report_state, 'n_direct_eligible', 'NR')}, "
                    f"meta eligible={getattr(report_state, 'n_meta_eligible', 'NR')})."
                ),
            })
        readiness["blocker_codes"] = list(dict.fromkeys(item.get("code", "unknown") for item in blockers))

    @staticmethod
    def _force_report_state_narrative(facts: dict, report_state) -> None:
        """Keep legitimate narrative reports from being blocked as evidence gaps."""
        facts["report_type"] = "narrative"
        readiness = facts.setdefault("evidence_readiness", {})
        readiness["report_type"] = "narrative"
        blockers = [
            item for item in readiness.get("blockers", [])
            if item.get("code") not in {
                "insufficient_primary_effects",
                "missing_primary_effect_audit",
                "incomplete_primary_effect_audit",
            }
        ]
        readiness["blockers"] = blockers
        readiness["blocker_codes"] = list(dict.fromkeys(item.get("code", "unknown") for item in blockers))
        readiness["status"] = "blocked" if blockers else "needs_review" if readiness.get("warnings") else "ready"
        facts.setdefault("studies", {})["primary_analysis_count"] = getattr(report_state, "n_analyzable_primary", 0)

    @staticmethod
    def _force_narrative_mode_facts(facts: dict) -> None:
        """Narrative-mode writer produces a narrative artifact, not evidence-gap prose."""
        facts["report_type"] = "narrative"
        readiness = facts.setdefault("evidence_readiness", {})
        readiness["report_type"] = "narrative"
        blockers = [
            item for item in readiness.get("blockers", [])
            if item.get("code") not in {"insufficient_primary_effects", "missing_primary_effect_audit"}
        ]
        readiness["blockers"] = blockers
        readiness["blocker_codes"] = list(dict.fromkeys(item.get("code", "unknown") for item in blockers))
        readiness["status"] = "blocked" if blockers else "needs_review" if readiness.get("warnings") else "ready"
