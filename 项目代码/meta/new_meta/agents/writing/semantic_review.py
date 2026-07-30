"""LLM section authoring, semantic patching and final readiness review."""
from __future__ import annotations

from datetime import date
import json
import re

from new_meta.core.project import Project
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.core.manuscript_polish import preservation_guard_issues
from new_meta.core.manuscript_text_metrics import (
    main_publication_word_count,
    manuscript_quality_gate,
    manuscript_style_audit,
)

from new_meta.agents.writing.contracts import (
    ClaimMapAuthoredSections,
    ClaimMapSectionDraft,
    ClinicalManuscriptReview,
    ClinicalManuscriptReviewIssue,
    FinalManuscriptReadinessReview,
    PUBLICATION_DISCUSSION_MIN_PROSE_PARAGRAPHS,
    PUBLICATION_DISCUSSION_MIN_UNITS_EN,
    PUBLICATION_DISCUSSION_MIN_UNITS_ZH,
    SemanticGuardAdjudication,
    SemanticManuscriptPatch,
    SemanticManuscriptRevision,
    SemanticParagraphRevision,
)


class SemanticReviewMixin:
    """LLM section authoring, semantic patching and final readiness review."""

    def _llm_author_open_sections_from_claim_map(self, manuscript: str, facts: dict) -> tuple[str, dict]:
        """Let the LLM author open argument sections from the claim map."""
        claim_map = facts.get("claim_map") if isinstance(facts.get("claim_map"), list) else []
        study_cards = facts.get("study_cards") if isinstance(facts.get("study_cards"), list) else []
        evidence_understanding = facts.get("evidence_understanding") if isinstance(facts.get("evidence_understanding"), dict) else {}
        background_evidence = facts.get("background_evidence") if isinstance(facts.get("background_evidence"), dict) else {}
        controversy_candidates = (
            facts.get("domain_controversy_candidates")
            if isinstance(facts.get("domain_controversy_candidates"), list)
            else []
        )
        has_evidence_understanding = (
            any(card.get("evidence_understanding_available") for card in study_cards if isinstance(card, dict))
            or bool(evidence_understanding.get("cross_study_claims"))
            or bool(evidence_understanding.get("authoring_priorities"))
        )
        has_background_authoring_material = bool(background_evidence.get("references")) or bool(controversy_candidates)
        audit = {
            "schema_version": 1,
            "enabled": True,
            "status": "ok",
            "accepted_sections": 0,
            "rejected_sections": 0,
            "issues": [],
        }
        if not claim_map or not (has_evidence_understanding or has_background_authoring_material):
            audit.update({
                "status": "skipped",
                "reason": "claim_map_or_authoring_evidence_missing",
            })
            return manuscript, audit

        target_headings = ["引言", "结果", "讨论", "结论"] if self._zh else ["Introduction", "Results", "Discussion", "Conclusion"]
        current_sections = {
            heading: self._h2_section_body(manuscript, heading)
            for heading in target_headings
        }
        current_sections = {k: v for k, v in current_sections.items() if str(v or "").strip()}
        if not current_sections:
            audit.update({"status": "skipped", "reason": "no_open_argument_sections"})
            return manuscript, audit

        primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
        population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
        grade = ((facts.get("grade") or {}).get("outcomes") or [{}])[0] if isinstance(facts.get("grade"), dict) else {}
        endpoint_definition_caveat = self._endpoint_definition_caveat(facts, zh=self._zh)
        endpoint_definition_discussion = self._endpoint_definition_discussion(facts, zh=self._zh)
        reporting_outcome_label = self._reporting_outcome_label(facts, None, zh=self._zh)
        authoring_study_cards = [
            {
                "study_id": card.get("study_id"),
                "display_name": card.get("display_name") or card.get("study_label"),
                "design": card.get("design_note") or card.get("design"),
                "population": card.get("analysis_population") or card.get("population"),
                "intervention": card.get("intervention"),
                "comparator": card.get("comparator"),
                "primary_outcome": card.get("primary_outcome_note") or card.get("primary_outcome"),
                "outcome_window": card.get("mortality_timepoint") or card.get("outcome_window"),
                "distinctive_feature": card.get("distinctive_feature"),
            }
            for card in study_cards[:12]
            if isinstance(card, dict)
        ]
        section_claims_by_heading: dict[str, list[dict]] = {}
        for heading in target_headings:
            section_claims_by_heading[heading] = [
                item for item in claim_map
                if isinstance(item, dict)
                and self._claim_section_matches_heading(str(item.get("section") or ""), heading)
            ][:18]
        prompt_payload = {
            "output_language": self._lang,
            "research_question": facts.get("research_question"),
            "pico": facts.get("pico"),
            "reporting_outcome_label": reporting_outcome_label,
            "endpoint_definition_caveat": endpoint_definition_caveat,
            "claim_strength": self._claim_strength_guidance(facts),
            "primary_effect": primary,
            "primary_population": population,
            "prisma": facts.get("prisma") if isinstance(facts.get("prisma"), dict) else {},
            "search": facts.get("search") if isinstance(facts.get("search"), dict) else {},
            "evidence_readiness": facts.get("evidence_readiness") if isinstance(facts.get("evidence_readiness"), dict) else {},
            "grade": {
                "certainty": grade.get("certainty"),
                "effect_summary": grade.get("effect_summary"),
                "domains": grade.get("domains"),
            },
            "absolute_effects": facts.get("absolute_effects") or {},
            "endpoint_definition_discussion": endpoint_definition_discussion,
            "study_card_index": authoring_study_cards,
            "section_claims_by_heading": section_claims_by_heading,
            "claim_citation_contract": getattr(self, "_claim_map_citation_contract", {}),
            "claim_map": claim_map[:40],
            "clinical_argument_chain": facts.get("clinical_argument_chain") or [
                item.get("argument_step")
                for item in claim_map
                if isinstance(item, dict) and item.get("argument_step")
            ],
            "current_sections": current_sections,
        }
        language_rule = "Chinese" if self._zh else "English"
        prompt = (
            "You are the author of a clinical systematic review manuscript. Rewrite only the open argument sections "
            "from a pre-approved claim map.\n\n"
            f"Write in {language_rule}. Return JSON only.\n"
            "Target sections are Introduction, Results, Discussion, and Conclusion (or their Chinese equivalents). "
            "Do not write Methods, tables, figures, declarations, or references. "
            "For Introduction, preserve the objective/scope claim and use background claims to motivate it; do not "
            "replace the PICO, intervention, comparator, or primary outcome with generic disease background. "
            "Use all approved Introduction claims. When an Introduction has background plus objective claims, write a "
            "complete journal-style Introduction rather than a compressed abstract: normally 3-5 concise paragraphs in "
            "English, or 3-5 concise paragraphs in Chinese, each tied to a claim. "
            "For Results, write a concise journal-style findings section from structured facts and Results claims: "
            "search/selection counts when present, included studies/participants, primary pooled effect, heterogeneity "
            "as descriptive when k is small, absolute-effect translation when available, and certainty summary. "
            "Results should report findings rather than teach meta-analysis methods; do not include general lessons "
            "about inverse-variance weighting, interpreting large trials, or why tables and figures are useful. "
            "Use claim_map as the authority for what each section may argue. Structured facts may supply exact numbers, "
            "study counts, certainty ratings, and participant counts. The study_card_index is only an identity and "
            "design aid; do not use it to introduce extra results, safety findings, subgroup findings, mechanisms, "
            "guideline claims, or novelty claims. "
            "For each target section, use only the claims listed under section_claims_by_heading for that same heading; "
            "do not borrow Discussion-only claims for Conclusion or Conclusion-only claims for Introduction. "
            "Every sentence in a replacement section must be traceable to a claim id from section_claims_by_heading "
            "or to an exact structured fact included in AUTHORING INPUT. Do not add extra clinical history, mechanism, "
            "treatment-evolution, guideline, or novelty context just because it sounds plausible. "
            "Within each section, order paragraphs according to clinical_argument_chain and the claim argument_step values. "
            "Discussion should read as a clinical argument: interpret the primary finding, explain clinical significance, "
            "handle endpoint/applicability controversies, then state evidence limits and practice implications when those "
            "claims are present. Do not collapse distinct argument steps into one generic limitation sentence. "
            "For a full meta-analysis with primary effect data, write Discussion as a complete journal-style section: "
            "normally 5-8 concise paragraphs in English or Chinese, with separate paragraphs for primary finding, "
            "clinical significance/absolute effect, endpoint or applicability caveats, safety scope when present, "
            "and evidence limitations. Do not compress the Discussion into an abstract-like claim list. "
            "Do not repeat the same limitation in multiple paragraphs. If low study count, endpoint-definition differences, "
            "sparse subgroup evidence, and publication-bias uncertainty are all relevant, synthesize them into one focused "
            "limitations paragraph and avoid a second paragraph that restates the same constraint. "
            "If endpoint_definition_caveat is present, keep that endpoint interpretation explicit and do not describe "
            "the pooled endpoint as hospitalization-only. "
            "If fewer than three studies contribute to the primary analysis, do not write that heterogeneity was low "
            "or absent, that I²/tau² support consistency, or that fixed-effect and random-effects estimates are clinically "
            "equivalent. Instead, state that heterogeneity statistics are descriptive and cannot reliably exclude "
            "clinically important between-study differences. "
            "Do not intensify claim wording beyond the claim map: avoid 'confirms', 'proves', 'establishes', 'class effect', "
            "or 'disease-modifying' unless those exact ideas appear in the approved claim support. "
            "Use claim_strength to choose effect verbs. If claim_strength recommends cautious wording, write 'may reduce', "
            "'suggests a reduction', or equivalent cautious language for the main clinical interpretation; avoid stronger "
            "phrasing such as 'points toward a lower risk' or unqualified 'reduces'. "
            "Do not add unsupported background, mechanism, safety, subgroup, guideline, or novelty claims. "
            "Keep inline numeric citations from the approved source-backed claims. If a claim in section_claims_by_heading "
            "has a source_study_id or source_location, the sentence expressing that claim must retain an inline citation marker. "
            "Use claim_citation_contract to choose citation markers for source-backed claim ids when available. If a "
            "claim has no citation in that contract because it is supported by this review's own calculation, structured "
            "facts, or protocol PICO, do not invent a trial citation for that sentence. "
            "If a claim is supported by structured facts, primary_effect, grade, absolute_effects, or this review's own "
            "calculation rather than by source_study_id/source_location, do not attach external trial citations to that "
            "sentence; cite trial reports only for source-level trial data or named trial statements. "
            "Do not return an uncited Introduction, Discussion, or Conclusion when source-backed claims are used. "
            "Keep numeric effect estimates, confidence intervals, study counts, participant counts, certainty ratings, "
            "study names, and clinical direction exactly aligned with structured facts. "
            "Discussion and Conclusion must preserve the primary effect estimate, confidence interval, number of "
            "contributing studies, and certainty rating whenever those values are available in structured facts. "
            "Calibrate the final conclusion to the structured GRADE certainty: if certainty is moderate or high, do not "
            "write that the evidence is simply 'limited' or 'very limited'. Instead, name the certainty rating and then "
            "state the specific remaining uncertainty, such as few contributing studies or endpoint-definition differences. "
            "When absolute_effects are available, the Conclusion should include one concise clinical sentence with the "
            "absolute-effect translation; do not leave the Conclusion as only a relative-effect summary. "
            "When endpoint definitions differ across contributing trials, Applicability or Limitations should state that "
            "absolute benefit may vary when local practice counts urgent visits differently from hospital admissions. "
            "If the detailed endpoint-definition contrast already appears in Methods, Discussion should use "
            "endpoint_definition_discussion as the clinical implication and should not name individual trials or repeat "
            "their component definitions. "
            "When a meta-analysis has been performed, do not write that cross-study comparison or synthesis is impossible. "
            "For sparse evidence, distinguish what the synthesis can support (the prespecified average effect and observed "
            "direction of contributing trials) from what it cannot support (robust subgroup effects, heterogeneity sources, "
            "or an unqualified class effect across unstudied agents). "
            "In Chinese, avoid statements such as '无法进行跨研究比较或归纳'; write instead that the pooled estimate answers "
            "the broader prespecified construct, while hospitalization-only effects, subgroup effects, or unstudied class "
            "effects require separate evidence. "
            "Do not repeat low study count, publication-bias uncertainty, or unstable heterogeneity in Clinical Significance, "
            "Applicability, Practice Implications, and Evidence Limitations. Put the detailed caveat in Evidence Limitations; "
            "other paragraphs may mention only the specific clinical implication they add. "
            "In Discussion, do not repeat the full heterogeneity statistic list already reported in Results. If low study "
            "count affects interpretation, write the clinical consequence once in the limitations paragraph without "
            "restating I², Q, p-value, and tau² together. "
            "Use the study cards to write concrete clinical interpretation rather than template-like meta-analysis commentary. "
            "Each replacement_markdown must be the complete body for that H2 section and must not include the H2 heading.\n\n"
            "AUTHORING INPUT:\n"
            f"{json.dumps(prompt_payload, ensure_ascii=False, indent=2)[:30000]}"
        )
        try:
            authored = self.call_llm_structured(
                prompt,
                ClaimMapAuthoredSections,
                temperature=0.25,
                max_tokens=max(4096, min(self._writing_tokens("section"), 12000)),
            )
        except Exception as exc:
            audit.update({"status": "failed", "error": str(exc)[:500]})
            return manuscript, audit

        audit["summary"] = authored.summary
        repaired = manuscript
        accepted_headings: set[str] = set()
        for section in authored.sections[:8]:
            heading = self._canonical_semantic_heading(section.heading)
            if heading not in current_sections:
                audit["rejected_sections"] += 1
                audit["issues"].append({
                    "code": "unsupported_authoring_heading",
                    "heading": section.heading,
                    "rationale": section.rationale,
                })
                continue
            if heading in accepted_headings:
                audit["rejected_sections"] += 1
                audit["issues"].append({
                    "code": "duplicate_authoring_heading",
                    "heading": heading,
                    "rationale": section.rationale,
                })
                continue
            replacement = str(section.replacement_markdown or "").strip()
            if not replacement or re.search(r"^##\s+", replacement, flags=re.M):
                audit["rejected_sections"] += 1
                audit["issues"].append({
                    "code": "invalid_authoring_replacement",
                    "heading": heading,
                    "rationale": section.rationale,
                })
                continue
            original = current_sections[heading].strip()
            replacement = self._apply_claim_section_citations(heading, replacement, facts)
            if replacement == original:
                audit["issues"].append({
                    "code": "authoring_section_unchanged",
                    "heading": heading,
                    "rationale": section.rationale,
                })
                continue
            depth_issues = self._publication_section_depth_issues(heading, replacement, facts)
            old_template_guard_issues = preservation_guard_issues(original, replacement, heading) + depth_issues
            adjudication = None
            if not depth_issues:
                adjudication = self._adjudicate_claim_map_authoring_guard(
                    heading=heading,
                    candidate_body=replacement,
                    guard_issues=old_template_guard_issues,
                    facts=facts,
                    claims_used=section.claims_used,
                    rationale=section.rationale,
                )
            if adjudication is None or not adjudication.accept:
                repair_issue: dict | None = None
                retry_section = self._repair_claim_map_authoring_section_with_guard_feedback(
                    heading=heading,
                    original_body=original,
                    rejected_body=replacement,
                    guard_issues=old_template_guard_issues,
                    facts=facts,
                    claims_used=section.claims_used,
                    rationale=section.rationale,
                    adjudication_reason=(
                        "; ".join(str(item.get("message") or item.get("code") or "") for item in depth_issues)
                        if depth_issues else
                        (getattr(adjudication, "reason", "") if adjudication else "")
                    ),
                )
                if retry_section is not None:
                    retry_replacement = str(retry_section.replacement_markdown or "").strip()
                    if (
                        retry_replacement
                        and retry_replacement != original
                        and not re.search(r"^##\s+", retry_replacement, flags=re.M)
                    ):
                        retry_replacement = self._apply_claim_section_citations(
                            heading,
                            retry_replacement,
                            facts,
                        )
                        retry_depth_issues = self._publication_section_depth_issues(
                            heading,
                            retry_replacement,
                            facts,
                        )
                        retry_guard_issues = (
                            preservation_guard_issues(original, retry_replacement, heading)
                            + retry_depth_issues
                        )
                        retry_adjudication = None
                        if not retry_depth_issues:
                            retry_adjudication = self._adjudicate_claim_map_authoring_guard(
                                heading=heading,
                                candidate_body=retry_replacement,
                                guard_issues=retry_guard_issues,
                                facts=facts,
                                claims_used=retry_section.claims_used or section.claims_used,
                                rationale=retry_section.rationale or section.rationale,
                            )
                        if retry_adjudication is not None and retry_adjudication.accept:
                            repaired = self._replace_h2_section_body(repaired, heading, retry_replacement + "\n")
                            current_sections[heading] = retry_replacement
                            accepted_headings.add(heading)
                            audit["accepted_sections"] += 1
                            audit["issues"].append({
                                "code": "claim_map_authoring_repaired_and_accepted",
                                "heading": heading,
                                "claims_used": (retry_section.claims_used or section.claims_used)[:12],
                                "rationale": retry_section.rationale or section.rationale,
                                "old_template_guard_issues": self._semantic_guard_issue_summary(old_template_guard_issues),
                                "retry_old_template_guard_issues": self._semantic_guard_issue_summary(retry_guard_issues),
                                "adjudication_reason": getattr(retry_adjudication, "reason", "") if retry_adjudication else "",
                            })
                            continue
                        repair_issue = {
                            "code": "claim_map_authoring_repair_rejected",
                            "heading": heading,
                            "claims_used": (retry_section.claims_used or section.claims_used)[:12],
                            "retry_old_template_guard_issues": self._semantic_guard_issue_summary(retry_guard_issues),
                            "retry_adjudication_reason": getattr(retry_adjudication, "reason", "") if retry_adjudication else "",
                            "rationale": retry_section.rationale or section.rationale,
                        }
                    else:
                        repair_issue = {
                            "code": "claim_map_authoring_repair_invalid",
                            "heading": heading,
                            "claims_used": (retry_section.claims_used or section.claims_used)[:12],
                            "rationale": retry_section.rationale or section.rationale,
                        }
                else:
                    repair_issue = {
                        "code": "claim_map_authoring_repair_failed",
                        "heading": heading,
                        "claims_used": section.claims_used[:12],
                        "rationale": section.rationale,
                    }
                if repair_issue:
                    audit["issues"].append(repair_issue)
                audit["rejected_sections"] += 1
                audit["issues"].append({
                    "code": "authoring_evidence_judge_rejected",
                    "heading": heading,
                    "rationale": section.rationale,
                    "old_template_guard_issues": self._semantic_guard_issue_summary(old_template_guard_issues),
                    "adjudication_reason": getattr(adjudication, "reason", "") if adjudication else "",
                })
                continue
            audit["issues"].append({
                "code": "authoring_evidence_judge_accepted",
                "heading": heading,
                "reason": adjudication.reason or section.rationale,
                "old_template_guard_issues": self._semantic_guard_issue_summary(old_template_guard_issues),
            })
            repaired = self._replace_h2_section_body(repaired, heading, replacement + "\n")
            current_sections[heading] = replacement
            accepted_headings.add(heading)
            audit["accepted_sections"] += 1
            audit["issues"].append({
                "code": "claim_map_authoring_section_accepted",
                "heading": heading,
                "claims_used": section.claims_used[:12],
                "rationale": section.rationale,
            })
        if authored.unsupported_claims_not_used:
            audit["unsupported_claims_not_used"] = authored.unsupported_claims_not_used[:20]
        return repaired, audit

    def _publication_section_depth_issues(self, heading: str, body: str, facts: dict) -> list[dict]:
        """Keep a fact-locked Discussion from collapsing into an abstract.

        The minimum applies only when the claim map contains enough writable,
        distinct Discussion claims. It therefore asks the authoring model to
        develop supported material, not to manufacture filler for sparse reviews.
        """
        if self._canonical_semantic_heading(heading) != ("讨论" if self._zh else "Discussion"):
            return []
        if not isinstance(facts.get("primary_effect"), dict):
            return []
        claim_map = facts.get("claim_map") if isinstance(facts.get("claim_map"), list) else []
        writable_claims = [
            item for item in claim_map
            if isinstance(item, dict)
            and self._claim_section_matches_heading(str(item.get("section") or ""), heading)
            and item.get("can_write_main_text") is not False
            and str(item.get("manuscript_use") or "main").casefold() not in {"exclude", "supplement"}
        ]
        if len(writable_claims) < 4:
            return []
        paragraphs = [
            paragraph.strip()
            for paragraph in re.split(r"\n\s*\n", str(body or ""))
            if paragraph.strip()
            and not paragraph.lstrip().startswith(("#", "|", "!", "```"))
        ]
        minimum_paragraphs = min(PUBLICATION_DISCUSSION_MIN_PROSE_PARAGRAPHS, len(writable_claims))
        minimum_units = (
            PUBLICATION_DISCUSSION_MIN_UNITS_ZH
            if self._zh else
            PUBLICATION_DISCUSSION_MIN_UNITS_EN
        )
        units = main_publication_word_count(body)
        issues: list[dict] = []
        if len(paragraphs) < minimum_paragraphs or units < minimum_units:
            issues.append({
                "code": "discussion_underdeveloped",
                "message": (
                    "Discussion is underdeveloped for the available approved claims; write separate supported "
                    "paragraphs for the primary finding, absolute clinical meaning, endpoint or design caveats, "
                    "applicability, and evidence limitations."
                ),
                "paragraph_count": len(paragraphs),
                "minimum_paragraphs": minimum_paragraphs,
                "unit_count": units,
                "minimum_units": minimum_units,
                "writable_discussion_claims": len(writable_claims),
            })
        return issues

    def _repair_claim_map_authoring_section_with_guard_feedback(
        self,
        *,
        heading: str,
        original_body: str,
        rejected_body: str,
        guard_issues: list[dict],
        facts: dict,
        claims_used: list[str] | None = None,
        rationale: str = "",
        adjudication_reason: str = "",
    ) -> ClaimMapSectionDraft | None:
        """Ask the LLM to revise a rejected claim-map section against reviewer feedback."""
        claim_map = facts.get("claim_map") if isinstance(facts.get("claim_map"), list) else []
        if not claim_map:
            return None
        claims_used_set = {str(item).strip() for item in (claims_used or []) if str(item).strip()}
        section_claims = [
            item for item in claim_map
            if isinstance(item, dict)
            and (
                str(item.get("id") or "").strip() in claims_used_set
                or self._claim_section_matches_heading(str(item.get("section") or ""), heading)
            )
        ]
        if not section_claims:
            return None
        primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
        population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
        grade = ((facts.get("grade") or {}).get("outcomes") or [{}])[0] if isinstance(facts.get("grade"), dict) else {}
        study_cards = facts.get("study_cards") if isinstance(facts.get("study_cards"), list) else []
        structured_context = {
            "primary_effect": primary,
            "primary_population": population,
            "absolute_effects": facts.get("absolute_effects") or {},
            "grade": grade,
            "prisma": facts.get("prisma") if isinstance(facts.get("prisma"), dict) else {},
            "search": facts.get("search") if isinstance(facts.get("search"), dict) else {},
            "evidence_readiness": facts.get("evidence_readiness") if isinstance(facts.get("evidence_readiness"), dict) else {},
        }
        language_rule = "Chinese" if self._zh else "English"
        prompt = (
            "You are revising a rejected claim-map-authored manuscript section after an evidence-grounding review. "
            "This is a revision loop, not a new rule-based cleanup.\n\n"
            f"Write in {language_rule}. Return JSON only using the ClaimMapSectionDraft schema.\n"
            "Keep the same heading. Treat EVIDENCE REVIEW REJECTION REASON as the reviewer checklist for this revision: "
            "remove or narrow only the unsupported assertions it identifies, then preserve the supported argument "
            "rather than compressing the section into a generic summary. Rewrite from SECTION CLAIMS and STRUCTURED "
            "FACTS only. Do not invent extra clinical history, mechanisms, guidelines, novelty, subgroup effects, or "
            "safety findings. Each sentence must be traceable to a SECTION CLAIM id or an exact structured fact below. "
            "If a rejected sentence cannot be traced, remove that unsupported detail instead of replacing it with "
            "another plausible statement. Preserve exact effect estimates, confidence intervals, study counts, "
            "participant counts, certainty ratings, study names, supported intervention scope, and source-backed "
            "citation markers when the corresponding claim remains. Do not remove the primary effect, certainty "
            "rating, contributing-study count, absolute-effect interpretation, or approved scope limitation merely to "
            "make the section shorter. OLD TEMPLATE BODY and OLD-TEMPLATE DIFF DEBUG INFO are supplied only to explain "
            "why the previous template-preservation guard was noisy; do not treat them as requirements to restore old "
            "methodological prose, old length, or old terminology. The goal is to produce the strongest journal-style section that "
            "survives the evidence review, not to restore the old template or over-compress into an abstract.\n\n"
            "Use CLAIM CITATION CONTRACT for inline citation markers. If a claim id has a citation in the contract, "
            "the sentence expressing that source-backed claim should use that marker. If a claim id has no contract "
            "citation because it is supported by this review's calculation, structured facts, or protocol PICO, do not "
            "invent a trial citation for that sentence.\n\n"
            f"HEADING: {heading}\n"
            f"INITIAL AUTHORING RATIONALE: {rationale}\n"
            f"EVIDENCE REVIEW REJECTION REASON: {adjudication_reason}\n\n"
            "STRUCTURED FACTS:\n"
            f"{json.dumps(structured_context, ensure_ascii=False, indent=2)[:12000]}\n\n"
            "SECTION CLAIMS:\n"
            f"{json.dumps(section_claims[:24], ensure_ascii=False, indent=2)[:14000]}\n\n"
            "CLAIM CITATION CONTRACT:\n"
            f"{json.dumps({str(item.get('id') or ''): (getattr(self, '_claim_map_citation_contract', {}) or {}).get(str(item.get('id') or ''), {}) for item in section_claims[:24] if isinstance(item, dict)}, ensure_ascii=False, indent=2)[:6000]}\n\n"
            "STUDY CARDS:\n"
            f"{json.dumps(study_cards[:8], ensure_ascii=False, indent=2)[:12000]}\n\n"
            "OLD-TEMPLATE DIFF DEBUG INFO, NOT A REJECTION CHECKLIST:\n"
            f"{json.dumps(self._semantic_guard_issue_summary(guard_issues), ensure_ascii=False, indent=2)[:6000]}\n\n"
            "OLD TEMPLATE BODY THAT WAS REPLACED, FOR CONTEXT ONLY:\n"
            f"{original_body[:9000]}\n\n"
            "REJECTED CANDIDATE BODY:\n"
            f"{rejected_body[:12000]}"
        )
        try:
            return self.call_llm_structured(
                prompt,
                ClaimMapSectionDraft,
                temperature=0.1,
                max_tokens=max(4096, min(self._writing_tokens("section"), 12000)),
            )
        except Exception:
            return None

    def _semantic_edit_open_sections(
        self,
        manuscript: str,
        facts: dict,
        *,
        project: Project | None = None,
    ) -> tuple[str, dict]:
        """Use the LLM as a bounded semantic editor for open argument sections.

        The editor is intentionally not allowed to touch tables, GRADE,
        declarations, figures, or references. Candidate
        replacements must preserve numbers, citations, cross-references, and
        protected clinical terms; otherwise they are rejected and the
        fact-locked text remains in place.
        """
        if not isinstance(facts.get("primary_effect"), dict):
            return manuscript, {
                "schema_version": 1,
                "enabled": True,
                "status": "skipped",
                "reason": "insufficient_structured_facts",
                "accepted_patches": 0,
                "rejected_patches": 0,
                "issues": [],
            }
        allowed = self._semantic_edit_allowed_headings()
        sections = {
            heading: self._h2_section_body(manuscript, heading)
            for heading in allowed
        }
        sections = {heading: body for heading, body in sections.items() if body.strip()}
        if not sections:
            return manuscript, {
                "schema_version": 1,
                "enabled": True,
                "status": "skipped",
                "reason": "no_open_sections",
                "accepted_patches": 0,
                "rejected_patches": 0,
                "issues": [],
            }
        audit = {
            "schema_version": 1,
            "enabled": True,
            "status": "ok",
            "accepted_patches": 0,
            "rejected_patches": 0,
            "issues": [],
        }
        clinical_review, clinical_review_audit = self._llm_clinical_manuscript_review(facts, sections)
        audit["clinical_review"] = clinical_review_audit
        prompt = self._semantic_edit_prompt(facts, sections, clinical_review=clinical_review)
        try:
            revision = self.call_llm_structured(
                prompt,
                SemanticManuscriptRevision,
                temperature=0.2,
                max_tokens=max(4096, min(self._writing_tokens("section"), 12000)),
            )
        except Exception as exc:
            audit.update({
                "status": "failed",
                "error": str(exc)[:500],
            })
            return manuscript, audit

        audit["summary"] = revision.summary
        repaired = manuscript
        for patch in revision.patches[:3]:
            heading = self._canonical_semantic_heading(patch.heading)
            if heading not in sections:
                audit["rejected_patches"] += 1
                audit["issues"].append({
                    "code": "unsupported_heading",
                    "heading": patch.heading,
                    "reason": patch.reason,
                })
                continue
            replacement = str(patch.replacement_markdown or "").strip()
            if not replacement or re.search(r"^##\s+", replacement, flags=re.M):
                audit["rejected_patches"] += 1
                audit["issues"].append({
                    "code": "invalid_replacement_shape",
                    "heading": heading,
                    "reason": patch.reason,
                })
                continue
            original_body = sections[heading].strip()
            if replacement == original_body:
                audit["issues"].append({
                    "code": "semantic_patch_unchanged",
                    "heading": heading,
                    "reason": patch.reason,
                })
                continue
            depth_issues = self._publication_section_depth_issues(heading, replacement, facts)
            guard_issues = preservation_guard_issues(original_body, replacement, heading) + depth_issues
            if (
                guard_issues
                and not depth_issues
                and self._semantic_guard_can_be_llm_adjudicated(guard_issues, heading=heading)
            ):
                adjudication = self._adjudicate_semantic_guard(
                    heading=heading,
                    original_body=original_body,
                    candidate_body=replacement,
                    guard_issues=guard_issues,
                    facts=facts,
                )
                if adjudication is not None and adjudication.accept:
                    repaired = self._replace_h2_section_body(repaired, heading, replacement + "\n")
                    sections[heading] = replacement
                    audit["accepted_patches"] += 1
                    audit["issues"].append({
                        "code": "semantic_patch_adjudicated_and_accepted",
                        "heading": heading,
                        "reason": adjudication.reason or patch.reason,
                        "guard_issues": self._semantic_guard_issue_summary(guard_issues),
                    })
                    continue
            if guard_issues:
                retry_patch = self._repair_semantic_patch_with_guard_feedback(
                    heading=heading,
                    original_body=original_body,
                    rejected_body=replacement,
                    guard_issues=guard_issues,
                    facts=facts,
                    reason=patch.reason,
                )
                if retry_patch is not None:
                    retry_replacement = str(retry_patch.replacement_markdown or "").strip()
                    if (
                        retry_replacement
                        and retry_replacement != original_body
                        and not re.search(r"^##\s+", retry_replacement, flags=re.M)
                    ):
                        retry_depth_issues = self._publication_section_depth_issues(
                            heading,
                            retry_replacement,
                            facts,
                        )
                        retry_guard_issues = (
                            preservation_guard_issues(original_body, retry_replacement, heading)
                            + retry_depth_issues
                        )
                        if not retry_guard_issues:
                            repaired = self._replace_h2_section_body(repaired, heading, retry_replacement + "\n")
                            sections[heading] = retry_replacement
                            audit["accepted_patches"] += 1
                            audit["issues"].append({
                                "code": "semantic_patch_repaired_and_accepted",
                                "heading": heading,
                                "reason": retry_patch.reason or patch.reason,
                                "initial_guard_issues": self._semantic_guard_issue_summary(guard_issues),
                            })
                            continue
                        if (
                            not retry_depth_issues
                            and self._semantic_guard_can_be_llm_adjudicated(retry_guard_issues, heading=heading)
                        ):
                            retry_adjudication = self._adjudicate_semantic_guard(
                                heading=heading,
                                original_body=original_body,
                                candidate_body=retry_replacement,
                                guard_issues=retry_guard_issues,
                                facts=facts,
                            )
                            if retry_adjudication is not None and retry_adjudication.accept:
                                repaired = self._replace_h2_section_body(repaired, heading, retry_replacement + "\n")
                                sections[heading] = retry_replacement
                                audit["accepted_patches"] += 1
                                audit["issues"].append({
                                    "code": "semantic_patch_repaired_adjudicated_and_accepted",
                                    "heading": heading,
                                    "reason": retry_adjudication.reason or retry_patch.reason or patch.reason,
                                    "initial_guard_issues": self._semantic_guard_issue_summary(guard_issues),
                                    "retry_guard_issues": self._semantic_guard_issue_summary(retry_guard_issues),
                                })
                                continue
                        guard_issues = retry_guard_issues
                audit["rejected_patches"] += 1
                audit["issues"].append({
                    "code": "fact_preservation_guard_rejected",
                    "heading": heading,
                    "reason": patch.reason,
                    "guard_issues": guard_issues[:10],
                })
                continue
            repaired = self._replace_h2_section_body(repaired, heading, replacement + "\n")
            sections[heading] = replacement
            audit["accepted_patches"] += 1
            audit["issues"].append({
                "code": "semantic_patch_accepted",
                "heading": heading,
                "reason": patch.reason,
            })
        paragraph_summaries: list[str] = []
        for round_index in range(2):
            before_paragraph_pass = repaired
            repaired, paragraph_audit = self._semantic_edit_style_paragraphs(
                repaired,
                facts,
                clinical_review=clinical_review,
                round_index=round_index + 1,
            )
            audit["accepted_patches"] += int(paragraph_audit.get("accepted_patches") or 0)
            audit["rejected_patches"] += int(paragraph_audit.get("rejected_patches") or 0)
            audit["issues"].extend(paragraph_audit.get("issues") or [])
            if paragraph_audit.get("summary"):
                paragraph_summaries.append(str(paragraph_audit.get("summary")))
            if int(paragraph_audit.get("accepted_patches") or 0) <= 0 or repaired == before_paragraph_pass:
                break
        if paragraph_summaries:
            audit["paragraph_summary"] = " / ".join(paragraph_summaries[:2])
        style_cleanup_summaries: list[str] = []
        for style_round in range(2):
            style_snapshot = manuscript_style_audit(repaired)
            gate_snapshot = manuscript_quality_gate(repaired, facts, style_audit=style_snapshot)
            repairable_gate_issues = [
                issue for issue in (gate_snapshot.get("issues") or [])
                if issue.get("code") in {"low_k_heterogeneity_overinterpretation"}
            ]
            if not (style_snapshot.get("issues") or []) and not repairable_gate_issues:
                break
            before_style_pass = repaired
            repaired, style_only_audit = self._semantic_edit_style_paragraphs(
                repaired,
                facts,
                clinical_review=None,
                style_issue_brief=style_snapshot.get("issues") or [],
                round_index=style_round + 1,
                max_targets=30,
            )
            style_only_audit["style_only_after_review"] = True
            audit["accepted_patches"] += int(style_only_audit.get("accepted_patches") or 0)
            audit["rejected_patches"] += int(style_only_audit.get("rejected_patches") or 0)
            audit["issues"].extend(style_only_audit.get("issues") or [])
            if style_only_audit.get("summary"):
                style_cleanup_summaries.append(str(style_only_audit.get("summary")))
            if int(style_only_audit.get("accepted_patches") or 0) <= 0 or repaired == before_style_pass:
                break
        if style_cleanup_summaries:
            audit["style_cleanup_summary"] = " / ".join(style_cleanup_summaries[:2])
        return repaired, audit

    def _llm_clinical_manuscript_review(
        self,
        facts: dict,
        sections: dict[str, str],
    ) -> tuple[ClinicalManuscriptReview | None, dict]:
        """Ask an LLM reviewer for semantic priorities before editing prose.

        This replaces the temptation to add more brittle phrase rules: the LLM
        diagnoses whether the open sections read like a clinical manuscript,
        while later preservation guards still prevent factual or citation drift.
        """
        audit = {
            "schema_version": 1,
            "status": "skipped",
            "issues": [],
        }
        if not sections:
            audit["reason"] = "no_sections"
            return None, audit
        prompt = self._clinical_manuscript_review_prompt(facts, sections)
        try:
            review = self.call_llm_structured(
                prompt,
                ClinicalManuscriptReview,
                temperature=0.0,
                max_tokens=4096,
            )
        except Exception as exc:
            audit.update({
                "status": "failed",
                "error": str(exc)[:500],
            })
            return None, audit
        review, sanitize_audit = self._llm_sanitize_clinical_review_against_facts(
            review,
            facts=facts,
            sections=sections,
        )
        issue_count = len(review.priority_issues or [])
        audit.update({
            "status": "ok",
            "summary": review.summary,
            "priority_issue_count": issue_count,
            "unsafe_to_fix_count": len(review.unsafe_to_fix_without_new_sources or []),
            "citation_or_source_concern_count": len(review.citation_or_source_concerns or []),
            "sanitization": sanitize_audit,
        })
        if issue_count:
            audit["priority_issues"] = [
                issue.model_dump()
                for issue in (review.priority_issues or [])[:8]
            ]
        return review, audit

    def _llm_sanitize_clinical_review_against_facts(
        self,
        review: ClinicalManuscriptReview,
        *,
        facts: dict,
        sections: dict[str, str],
    ) -> tuple[ClinicalManuscriptReview, dict]:
        """Use an LLM judge to keep clinical review suggestions source-grounded."""
        audit = {
            "schema_version": 1,
            "status": "skipped",
            "initial_issue_count": len(review.priority_issues or []),
        }
        if not review.priority_issues:
            audit["reason"] = "no_priority_issues"
            return review, audit

        primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
        grade = ((facts.get("grade") or {}).get("outcomes") or [{}])[0] if isinstance(facts.get("grade"), dict) else {}
        evidence_payload = {
            "output_language": self._lang,
            "primary_effect": primary,
            "absolute_effects": facts.get("absolute_effects") or {},
            "secondary_effects": facts.get("secondary_effects", []),
            "subgroup_effects": facts.get("subgroup_effects", []),
            "grade": {
                "certainty": grade.get("certainty"),
                "domains": grade.get("domains"),
            },
            "study_cards": (facts.get("study_cards") or [])[:8] if isinstance(facts.get("study_cards"), list) else [],
            "claim_map": (facts.get("claim_map") or [])[:24] if isinstance(facts.get("claim_map"), list) else [],
            "evidence_warnings": (facts.get("evidence_readiness") or {}).get("warnings", []),
        }
        section_text, _ = self._semantic_sections_prompt_text(sections, max_chars_per_section=4500)
        prompt = (
            "You are auditing a peer-review plan before it is allowed to edit a clinical systematic review manuscript.\n\n"
            f"Respond in {'Chinese' if self._zh else 'English'}. Return JSON only using the same ClinicalManuscriptReview schema.\n"
            "Keep only revision instructions that can be completed using the structured facts, claim_map, study cards, "
            "or current manuscript text below. Move any suggestion that would require new full text, a new citation, "
            "or expert speculation into unsafe_to_fix_without_new_sources instead of priority_issues.\n\n"
            "Important boundary: do not let the review plan add new mechanistic explanations, event-rate explanations, "
            "sponsorship or industry explanations, selective-reporting narratives, guideline implications, subgroup effects, "
            "safety findings, or component-outcome claims unless those exact ideas are present in the supplied facts or "
            "current manuscript text. The review may ask the manuscript to be clearer, less repetitive, or more clinically "
            "focused; it may not ask the authoring step to invent plausible reasons.\n\n"
            "ORIGINAL REVIEW PLAN:\n"
            f"{review.model_dump_json(indent=2)}\n\n"
            "STRUCTURED FACTS AND CLAIM MAP:\n"
            f"{json.dumps(evidence_payload, ensure_ascii=False, indent=2)[:18000]}\n\n"
            "CURRENT OPEN SECTIONS:\n"
            f"{section_text[:12000]}"
        )
        try:
            sanitized = self.call_llm_structured(
                prompt,
                ClinicalManuscriptReview,
                temperature=0.0,
                max_tokens=4096,
            )
        except Exception as exc:
            audit.update({
                "status": "failed",
                "error": str(exc)[:500],
            })
            return review, audit
        audit.update({
            "status": "ok",
            "final_issue_count": len(sanitized.priority_issues or []),
            "unsafe_to_fix_count": len(sanitized.unsafe_to_fix_without_new_sources or []),
            "removed_or_deferred_count": max(0, len(review.priority_issues or []) - len(sanitized.priority_issues or [])),
        })
        return sanitized, audit

    def _semantic_edit_allowed_headings(self) -> list[str]:
        if self._zh:
            return ["摘要", "引言", "方法", "结果", "讨论", "结论"]
        return ["Abstract", "Introduction", "Methods", "Results", "Discussion", "Conclusion"]

    def _canonical_semantic_heading(self, heading: str) -> str:
        raw = str(heading or "").strip().strip("#").strip().lower()
        if self._zh:
            aliases = {
                "abstract": "摘要",
                "introduction": "引言",
                "methods": "方法",
                "results": "结果",
                "discussion": "讨论",
                "conclusion": "结论",
                "摘要": "摘要",
                "引言": "引言",
                "方法": "方法",
                "结果": "结果",
                "讨论": "讨论",
                "结论": "结论",
            }
        else:
            aliases = {
                "abstract": "Abstract",
                "introduction": "Introduction",
                "methods": "Methods",
                "results": "Results",
                "discussion": "Discussion",
                "conclusion": "Conclusion",
                "摘要": "Abstract",
                "引言": "Introduction",
                "方法": "Methods",
                "结果": "Results",
                "讨论": "Discussion",
                "结论": "Conclusion",
            }
        return aliases.get(raw, str(heading or "").strip())

    def _repair_semantic_patch_with_guard_feedback(
        self,
        *,
        heading: str,
        original_body: str,
        rejected_body: str,
        guard_issues: list[dict],
        facts: dict,
        reason: str = "",
    ) -> SemanticManuscriptPatch | None:
        """Ask the LLM to repair a rejected semantic edit using guard feedback."""
        primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
        population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
        grade = ((facts.get("grade") or {}).get("outcomes") or [{}])[0] if isinstance(facts.get("grade"), dict) else {}
        guard_summary = self._semantic_guard_issue_summary(guard_issues)
        language_rule = "Chinese" if self._zh else "English"
        prompt = (
            "You are revising a rejected manuscript edit. The prior edit was rejected because it changed protected "
            "facts, citations, numeric tokens, or clinical terms. Repair it conservatively.\n\n"
            f"Write in {language_rule}. Return JSON only using the requested schema.\n"
            "Start from ORIGINAL BODY, not from a fresh essay. Preserve bracket citation markers on every remaining "
            "supported claim, in the same order. You may remove citation markers only when you remove the entire "
            "redundant sentence or paragraph they supported. Preserve every analytic numeric token, confidence interval, "
            "table/figure reference, study name, drug name, outcome name, and certainty rating. You may substantially "
            "condense Methods or Results when the removed text is teaching-style explanation, duplicated prose, or "
            "material already preserved in tables/appendices. You may improve paragraph flow, remove template-like self-commentary, and make the "
            "clinical argument more direct only when the protected facts remain unchanged. Do not return the original "
            "body unchanged if a safe local copyedit is possible; prefer small sentence-level revisions that keep the "
            "same facts and citation bindings.\n\n"
            f"HEADING: {heading}\n"
            f"ORIGINAL EDITORIAL REASON: {reason}\n"
            "PROTECTED FACTS:\n"
            f"{json.dumps({'primary_effect': primary, 'primary_population': population, 'grade': grade}, ensure_ascii=False, indent=2)[:6000]}\n\n"
            "GUARD FEEDBACK TO FIX:\n"
            f"{json.dumps(guard_summary, ensure_ascii=False, indent=2)[:6000]}\n\n"
            "ORIGINAL BODY:\n"
            f"{original_body[:12000]}\n\n"
            "REJECTED BODY:\n"
            f"{rejected_body[:12000]}"
        )
        try:
            return self.call_llm_structured(
                prompt,
                SemanticManuscriptPatch,
                temperature=0.1,
                max_tokens=max(4096, min(self._writing_tokens("section"), 12000)),
            )
        except Exception:
            return None

    @staticmethod
    def _semantic_guard_can_be_llm_adjudicated(guard_issues: list[dict], *, heading: str = "") -> bool:
        hard_codes = {
            "detector_evasion_language",
            "prompt_artifact_leaked",
            "unsupported_source_characterization",
            "language_changed",
            "cross_references_changed",
        }
        editable_heading = str(heading or "").strip().lower() in {
            "abstract",
            "introduction",
            "methods",
            "results",
            "discussion",
            "conclusion",
            "摘要",
            "引言",
            "方法",
            "结果",
            "讨论",
            "结论",
        }
        for issue in guard_issues or []:
            code = str((issue or {}).get("code") or "")
            if code in hard_codes:
                return False
            if code in {"rewrite_overcompressed", "numeric_tokens_changed", "citations_changed"} and not editable_heading:
                return False
        return bool(guard_issues)

    def _semantic_edit_style_paragraphs(
        self,
        manuscript: str,
        facts: dict,
        *,
        clinical_review: ClinicalManuscriptReview | None = None,
        style_issue_brief: list[dict] | None = None,
        round_index: int = 1,
        max_targets: int = 18,
    ) -> tuple[str, dict]:
        """Use LLM paragraph patches for local style and reviewer-identified problems."""
        targets: list[dict[str, object]] = []
        section_paragraphs: dict[str, list[str]] = {}
        for heading in self._semantic_edit_allowed_headings():
            body = self._h2_section_body(manuscript, heading)
            if not body.strip():
                continue
            paragraphs = re.split(r"\n\s*\n", body.strip())
            section_paragraphs[heading] = paragraphs
            for index, paragraph in enumerate(paragraphs, 1):
                review_issue = self._clinical_review_issue_for_paragraph(
                    heading,
                    paragraph,
                    clinical_review,
                )
                if not self._semantic_paragraph_needs_llm_edit(paragraph) and review_issue is None:
                    continue
                targets.append({
                    "heading": heading,
                    "paragraph_index": index,
                    "text": paragraph,
                    "style_signals": {
                        "rather_than_count": len(re.findall(r"\brather than\b", paragraph, flags=re.I)),
                        "abstract_subject_examples": re.findall(
                            r"\b(?:the analysis|the result|the evidence base|the pooled estimate|the review|the manuscript|this review|this synthesis|this distinction)\b",
                            paragraph,
                            flags=re.I,
                        )[:6],
                        "low_k_heterogeneity_overinterpretation": self._paragraph_has_low_k_heterogeneity_overinterpretation(paragraph),
                        "clinical_review_issue": review_issue,
                    },
                    "_priority": 0 if review_issue is not None else 1,
                })
        targets = sorted(
            targets,
            key=lambda item: (
                int(item.get("_priority", 1)),
                self._semantic_edit_allowed_headings().index(str(item.get("heading")))
                if str(item.get("heading")) in self._semantic_edit_allowed_headings()
                else 99,
                int(item.get("paragraph_index") or 0),
            ),
        )[:max_targets]
        for target in targets:
            target.pop("_priority", None)
        audit = {
            "schema_version": 1,
            "status": "skipped",
            "round": round_index,
            "accepted_patches": 0,
            "rejected_patches": 0,
            "issues": [],
        }
        if not targets:
            audit["reason"] = "no_style_paragraph_targets"
            return manuscript, audit
        prompt = self._semantic_paragraph_edit_prompt(
            facts,
            targets,
            clinical_review=clinical_review,
            style_issue_brief=style_issue_brief,
            round_index=round_index,
        )
        try:
            revision = self.call_llm_structured(
                prompt,
                SemanticParagraphRevision,
                temperature=0.15,
                max_tokens=max(4096, min(self._writing_tokens("section"), 12000)),
            )
        except Exception as exc:
            audit.update({
                "status": "failed",
                "error": str(exc)[:500],
            })
            return manuscript, audit

        audit["status"] = "ok"
        audit["summary"] = revision.summary
        changed_sections: set[str] = set()
        for patch in revision.patches[:max_targets]:
            heading = self._canonical_semantic_heading(patch.heading)
            paragraphs = section_paragraphs.get(heading)
            if not paragraphs:
                audit["rejected_patches"] += 1
                audit["issues"].append({
                    "code": "unsupported_paragraph_heading",
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
                    "code": "invalid_paragraph_index",
                    "heading": heading,
                    "paragraph_index": patch.paragraph_index,
                    "reason": patch.reason,
                })
                continue
            original = paragraphs[paragraph_index - 1].strip()
            replacement = str(patch.replacement_markdown or "").strip()
            delete_paragraph = replacement == "[[DELETE_PARAGRAPH]]"
            if delete_paragraph:
                if not self._semantic_paragraph_deletion_is_safe(original, reason=patch.reason):
                    audit["rejected_patches"] += 1
                    audit["issues"].append({
                        "code": "unsafe_semantic_paragraph_delete",
                        "heading": heading,
                        "paragraph_index": paragraph_index,
                        "reason": patch.reason,
                    })
                    continue
                paragraphs[paragraph_index - 1] = ""
                changed_sections.add(heading)
                audit["accepted_patches"] += 1
                audit["issues"].append({
                    "code": "semantic_paragraph_deleted",
                    "heading": heading,
                    "paragraph_index": paragraph_index,
                    "reason": patch.reason,
                })
                continue
            if not replacement or replacement == original:
                audit["issues"].append({
                    "code": "semantic_paragraph_unchanged",
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
                    "code": "semantic_paragraph_guard_rejected",
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
                    "semantic_paragraph_adjudicated_and_accepted"
                    if accepted_by_adjudication else
                    "semantic_paragraph_accepted"
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
    def _semantic_paragraph_deletion_is_safe(paragraph: str, *, reason: str = "") -> bool:
        text = str(paragraph or "").strip()
        if not text or text.startswith("###") or text.startswith("|") or text.startswith("!["):
            return False
        reason_text = str(reason or "").lower()
        if not re.search(r"redundan|repeat|duplicat|overlap|consolidat|重复|冗余|合并", reason_text):
            return False
        if re.search(r"[\[［][0-9\s,，、;；\-–—至]+[\]］]", text):
            return False
        if re.search(r"\b(?:Table|Figure|Appendix|表|图|附录)\s*\d+", text, flags=re.I):
            return False
        if re.search(r"\b(?:Anker|Solomon|DAPA|EMPEROR|DELIVER|RECOVERY|CoDEX|REMAP|CAPE)\b", text, flags=re.I):
            return False
        if re.search(r"\b\d+(?:,\d{3})*(?:\.\d+)?%?\b", text):
            return False
        return True

    @staticmethod
    def _semantic_paragraph_needs_llm_edit(paragraph: str) -> bool:
        text = str(paragraph or "").strip()
        if not text or text.startswith("|") or text.startswith("!["):
            return False
        if len(text) < 80:
            return False
        if not text.startswith("**Importance:**") and SemanticReviewMixin._paragraph_sentence_count(text) > 6:
            return True
        if re.search(r"\brather than\b", text, flags=re.I):
            return True
        if re.search(
            r"\b(?:the analysis|the result|the evidence base|the pooled estimate|the review|the manuscript|this review|this synthesis|this distinction)\b",
            text,
            flags=re.I,
        ):
            return True
        if SemanticReviewMixin._paragraph_has_low_k_heterogeneity_overinterpretation(text):
            return True
        if re.search(r"\bthis distinction\b|\bthis rule\b|\bthis prevents\b", text, flags=re.I):
            return True
        return False

    @staticmethod
    def _paragraph_sentence_count(paragraph: str) -> int:
        text = re.sub(r"\s+", " ", str(paragraph or "")).strip()
        if not text:
            return 0
        return len([part for part in re.split(r"(?<=[.!?。！？])\s+", text) if part.strip()])

    @staticmethod
    def _paragraph_has_low_k_heterogeneity_overinterpretation(paragraph: str) -> bool:
        text = str(paragraph or "")
        return bool(
            re.search(r"\bheterogeneity\b|I²|I2|tau", text, flags=re.I)
            and re.search(
                r"\breassuring\b|\bconsistent\b|\bconsistency\b|\bcompatible\b|\bcoherent\b|\babsence of\b|\bsupports?\b|\bconfirms?\b",
                text,
                flags=re.I,
            )
        )

    def _clinical_review_issue_for_paragraph(
        self,
        heading: str,
        paragraph: str,
        clinical_review: ClinicalManuscriptReview | None,
    ) -> dict | None:
        if not isinstance(clinical_review, ClinicalManuscriptReview):
            return None
        paragraph_text = re.sub(r"\s+", " ", str(paragraph or "").lower())
        if not paragraph_text:
            return None
        canonical_heading = self._canonical_semantic_heading(heading)
        for issue in clinical_review.priority_issues or []:
            issue_heading = self._canonical_semantic_heading(issue.heading)
            if issue_heading != canonical_heading:
                continue
            issue_text = " ".join([
                str(issue.problem or ""),
                str(issue.revision_instruction or ""),
                str(issue.evidence_basis or ""),
            ])
            keywords = self._clinical_review_keywords(issue_text)
            if keywords and any(keyword in paragraph_text for keyword in keywords):
                return issue.model_dump()
        return None

    @staticmethod
    def _clinical_review_keywords(text: str) -> list[str]:
        stopwords = {
            "about", "above", "after", "again", "because", "before", "being", "could", "every",
            "facts", "given", "however", "issue", "major", "manuscript", "method", "methods",
            "minor", "should", "state", "studies", "study", "their", "there", "these", "those",
            "trial", "trials", "using", "without", "within", "would", "which", "where", "while",
            "because", "therefore", "section", "sentence", "reported", "current", "clinical",
            "evidence", "structured", "review", "result", "results",
        }
        words = []
        for raw in re.findall(r"[A-Za-z][A-Za-z0-9_-]{4,}", str(text or "").lower()):
            token = raw.strip("-_")
            if token and token not in stopwords:
                words.append(token)
        return list(dict.fromkeys(words))[:20]

    def _semantic_paragraph_edit_prompt(
        self,
        facts: dict,
        targets: list[dict[str, object]],
        *,
        clinical_review: ClinicalManuscriptReview | None = None,
        style_issue_brief: list[dict] | None = None,
        round_index: int = 1,
    ) -> str:
        primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
        population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
        grade = ((facts.get("grade") or {}).get("outcomes") or [{}])[0] if isinstance(facts.get("grade"), dict) else {}
        language_rule = "Chinese" if self._zh else "English"
        review_block = (
            clinical_review.model_dump()
            if isinstance(clinical_review, ClinicalManuscriptReview)
            else {}
        )
        style_brief = style_issue_brief if isinstance(style_issue_brief, list) else []
        return (
            "You are a clinical manuscript line editor. Edit only the listed paragraphs. The goal is to remove "
            "template-like wording, repeated 'rather than' constructions, abstract manuscript-subject openings, and "
            "clinical reviewer concerns attached to specific paragraphs, "
            "while preserving all facts.\n\n"
            f"Write in {language_rule}. This is paragraph-editing round {round_index}. Return JSON only.\n"
            "For each patch, keep the same heading and paragraph_index. Preserve every number, confidence interval, "
            "citation marker, study name, drug name, outcome name, and table/figure reference. Do not add new claims. "
            "Prefer small local rewrites over paragraph replacement. If a paragraph cannot be safely improved, omit it. "
            "Do not edit tables or references. Follow clinical_review_issue instructions only when the change can be "
            "made with facts and citations already present in that paragraph or the structured facts. If the same "
            "review issue applies to several target paragraphs, fix it once in the most directly relevant paragraph "
            "rather than appending the same caveat throughout the section; repeated disclaimer sentences make the "
            "manuscript read mechanically and should be avoided. If a target paragraph is purely redundant after "
            "another paragraph consolidates the same point, set replacement_markdown exactly to [[DELETE_PARAGRAPH]]. "
            "Use deletion only for paragraphs that contain no unique numbers, citations, study names, or table/figure references.\n\n"
            "Treat clinical review issues as target-specific, not as global instructions. If a target's "
            "style_signals.clinical_review_issue is null, perform only local prose/style cleanup and do not import "
            "unrelated review issues into that paragraph. If a target's clinical_review_issue asks whether safety "
            "outcomes were quantitatively synthesized, state the scope limitation directly (for example, that safety "
            "outcomes were not quantitatively pooled in this review) and do not invent specific adverse-event findings "
            "or trial-level safety results that are not already in the target paragraph or structured facts.\n\n"
            "If editing an Abstract paragraph, preserve structured labels and field line breaks (for example Importance, Objective, Results, "
            "and Conclusions and relevance) and keep all numeric results exactly unchanged. Improve clinical framing "
            "without turning the abstract into background exposition.\n\n"
            "If STYLE ISSUES includes abstract_subject_overuse, reduce sentences whose grammatical subject is an "
            "abstract manuscript object such as 'the review', 'the analysis', 'the result', 'the evidence base', "
            "'the pooled estimate', 'this synthesis', or 'this distinction'. When safe, recast those sentences so the "
            "subject is a patient group, intervention, trial, outcome, estimate direction, certainty limitation, or "
            "clinical decision. Preserve all numbers and citations exactly.\n\n"
            "For paragraphs involving heterogeneity, remember that fewer than three contributing studies makes formal "
            "heterogeneity assessment limited even when I²=0%; preserve the reported statistics but avoid reassurance "
            "or claims of proven consistency. If style_signals.low_k_heterogeneity_overinterpretation is true, remove "
            "language saying the heterogeneity signal is reassuring, supports the direction, confirms consistency, or "
            "proves homogeneity; replace it with a descriptive statement that heterogeneity statistics are limited by "
            "the sparse number of contributing studies.\n\n"
            "FACTS:\n"
            f"{json.dumps({'primary_effect': primary, 'primary_population': population, 'grade': grade, 'model_decision': facts.get('model_decision') if isinstance(facts.get('model_decision'), dict) else {}, 'model_sensitivity': facts.get('model_sensitivity') if isinstance(facts.get('model_sensitivity'), dict) else {}}, ensure_ascii=False, indent=2)[:8000]}\n\n"
            "CLINICAL REVIEW BRIEF:\n"
            f"{json.dumps(review_block, ensure_ascii=False, indent=2)[:10000]}\n\n"
            "STYLE ISSUES:\n"
            f"{json.dumps(style_brief, ensure_ascii=False, indent=2)[:6000]}\n\n"
            "TARGET PARAGRAPHS:\n"
            f"{json.dumps(targets, ensure_ascii=False, indent=2)[:24000]}"
        )

    def _adjudicate_semantic_guard(
        self,
        *,
        heading: str,
        original_body: str,
        candidate_body: str,
        guard_issues: list[dict],
        facts: dict,
    ) -> SemanticGuardAdjudication | None:
        """Use an LLM judge for semantic guard flags that are not hard fact changes."""
        primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
        population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
        grade = ((facts.get("grade") or {}).get("outcomes") or [{}])[0] if isinstance(facts.get("grade"), dict) else {}
        study_cards = facts.get("study_cards") if isinstance(facts.get("study_cards"), list) else []
        prompt = (
            "You are a clinical systematic-review fact-preservation judge. A deterministic guard flagged a manuscript "
            "edit for semantic differences. Decide whether the candidate remains fact-preserving.\n\n"
            "Reject if the candidate changes any core numeric result, search or screening count, study identity, "
            "intervention, comparison, outcome, certainty rating, clinical direction, or strength of conclusion. "
            "Accept narrowing from a broad class label to the actual contributing agents or interventions when the "
            "study cards show that narrower wording and the edit avoids overgeneralization. "
            "Citation markers may be fewer only when the candidate removes a whole redundant sentence or moves details "
            "already preserved in tables, figures, or appendices; reject if a remaining claim loses the reference that "
            "supports it. Numeric tokens may be fewer only when they belong to deleted search-query boilerplate or "
            "duplicated teaching prose; reject if any analytic number, date, effect estimate, confidence interval, "
            "participant count, event count, p value, study count, table/figure number, or GRADE judgment is lost or "
            "changed. Accept only if the edit is a clinically faithful journal-style condensation or safer hedging. "
            "Return JSON only.\n\n"
            f"HEADING: {heading}\n"
            "STRUCTURED FACTS:\n"
            f"{json.dumps({'primary_effect': primary, 'primary_population': population, 'grade': grade, 'study_cards': study_cards[:8]}, ensure_ascii=False, indent=2)[:9000]}\n\n"
            "GUARD FLAGS:\n"
            f"{json.dumps(self._semantic_guard_issue_summary(guard_issues), ensure_ascii=False, indent=2)[:6000]}\n\n"
            "ORIGINAL BODY:\n"
            f"{original_body[:10000]}\n\n"
            "CANDIDATE BODY:\n"
            f"{candidate_body[:10000]}"
        )
        try:
            return self.call_llm_structured(
                prompt,
                SemanticGuardAdjudication,
                temperature=0.0,
                max_tokens=2048,
            )
        except Exception:
            return None

    def _adjudicate_claim_map_authoring_guard(
        self,
        *,
        heading: str,
        candidate_body: str,
        guard_issues: list[dict],
        facts: dict,
        claims_used: list[str] | None = None,
        rationale: str = "",
    ) -> SemanticGuardAdjudication | None:
        """Judge claim-map authored text against evidence, not against the old template.

        Claim-map authoring is intentionally a larger rewrite than polish. The
        old section can be template-heavy, so the correct reference is the
        approved claim map plus structured facts and study cards. The old-body
        preservation guard is retained in audits for debugging, but it is not
        evidence for accepting or rejecting a claim-map-authored section.
        """
        claim_map = facts.get("claim_map") if isinstance(facts.get("claim_map"), list) else []
        if not claim_map:
            return None
        primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
        population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
        grade = ((facts.get("grade") or {}).get("outcomes") or [{}])[0] if isinstance(facts.get("grade"), dict) else {}
        study_cards = facts.get("study_cards") if isinstance(facts.get("study_cards"), list) else []
        structured_context = {
            "primary_effect": primary,
            "primary_population": population,
            "absolute_effects": facts.get("absolute_effects") or {},
            "grade": grade,
            "prisma": facts.get("prisma") if isinstance(facts.get("prisma"), dict) else {},
            "search": facts.get("search") if isinstance(facts.get("search"), dict) else {},
            "evidence_readiness": facts.get("evidence_readiness") if isinstance(facts.get("evidence_readiness"), dict) else {},
        }
        claims_used_set = {str(item).strip() for item in (claims_used or []) if str(item).strip()}
        section_claims = []
        for item in claim_map:
            if not isinstance(item, dict):
                continue
            item_id = str(item.get("id") or "").strip()
            if item_id in claims_used_set or self._claim_section_matches_heading(str(item.get("section") or ""), heading):
                section_claims.append(item)
        if not section_claims:
            section_claims = claim_map[:20]
        language_rule = "Chinese" if self._zh else "English"
        prompt = (
            "You are judging a claim-map-authored systematic-review section. This is not a conservative polish pass: "
            "the candidate may legitimately replace template-heavy old prose. Decide whether the candidate is fully "
            "supported by the approved claim map, structured facts, and study cards.\n\n"
            f"Write the reason in {language_rule}. Return JSON only.\n"
            "Accept only if every clinical, methodological, safety, subgroup, mechanism, novelty, certainty, and "
            "numerical assertion in the candidate is supported by SECTION CLAIMS, STRUCTURED FACTS, or STUDY CARDS. "
            "Map each candidate sentence to a SECTION CLAIM id or exact structured fact before accepting; reject if any "
            "sentence adds plausible but unmapped clinical history, treatment-evolution context, mechanism, guideline "
            "implication, or novelty framing. "
            "Reject if the candidate introduces an unsupported diagnostic method, population boundary, guideline claim, "
            "mechanism, component-outcome conclusion, safety claim, subgroup conclusion, study count, participant count, "
            "effect estimate, confidence interval, direction, certainty rating, or citation-dependent assertion. "
            "Do not reject merely because the candidate is shorter or uses different clinical terms than the old template. "
            "However, reject if source-backed claims are expressed without inline citations after citation restoration; "
            "citation markers may change only when the new markers still point to the approved supporting sources. "
            "Use CLAIM CITATION CONTRACT to judge whether a citation marker is approved for a claim id; do not reject "
            "a marker solely because it is a compact numeric citation when the contract maps that claim id to the same "
            "reference number. "
            "Do not compare the candidate against the old section. The old section may be template-heavy or clinically "
            "thin; judge only whether the candidate is grounded in the supplied claims and structured facts.\n\n"
            f"HEADING: {heading}\n"
            f"AUTHORING RATIONALE: {rationale}\n"
            "STRUCTURED FACTS:\n"
            f"{json.dumps(structured_context, ensure_ascii=False, indent=2)[:11000]}\n\n"
            "SECTION CLAIMS:\n"
            f"{json.dumps(section_claims[:24], ensure_ascii=False, indent=2)[:14000]}\n\n"
            "CLAIM CITATION CONTRACT:\n"
            f"{json.dumps({str(item.get('id') or ''): (getattr(self, '_claim_map_citation_contract', {}) or {}).get(str(item.get('id') or ''), {}) for item in section_claims[:24] if isinstance(item, dict)}, ensure_ascii=False, indent=2)[:6000]}\n\n"
            "STUDY CARDS:\n"
            f"{json.dumps(study_cards[:8], ensure_ascii=False, indent=2)[:14000]}\n\n"
            "CANDIDATE BODY:\n"
            f"{candidate_body[:12000]}"
        )
        try:
            return self.call_llm_structured(
                prompt,
                SemanticGuardAdjudication,
                temperature=0.0,
                max_tokens=2048,
            )
        except Exception:
            return None

    @staticmethod
    def _semantic_guard_issue_summary(guard_issues: list[dict]) -> list[dict]:
        summary: list[dict] = []
        for issue in guard_issues[:8]:
            if not isinstance(issue, dict):
                continue
            compact = {
                "code": issue.get("code"),
                "message": issue.get("message"),
            }
            for key in (
                "original_units",
                "candidate_units",
                "minimum_candidate_units",
                "original_terms",
                "candidate_terms",
                "original_clinical_entities",
                "candidate_clinical_entities",
                "original_directional_terms",
                "candidate_directional_terms",
                "original_risk_of_bias_ratings",
                "candidate_risk_of_bias_ratings",
                "original_certainty_ratings",
                "candidate_certainty_ratings",
            ):
                if key in issue:
                    compact[key] = issue.get(key)
            summary.append(compact)
        return summary

    @staticmethod
    def _h2_section_body(manuscript: str, heading: str) -> str:
        text = str(manuscript or "")
        pattern = re.compile(rf"^##\s+{re.escape(heading)}\s*$", flags=re.M)
        match = pattern.search(text)
        if not match:
            return ""
        next_match = re.search(r"^##\s+", text[match.end():], flags=re.M)
        end = match.end() + next_match.start() if next_match else len(text)
        return text[match.end():end].strip("\n")

    def _harmonize_open_section_outcome_label(
        self,
        manuscript: str,
        facts: dict,
        protocol: ResearchProtocol,
    ) -> str:
        """Keep open prose sections aligned to the authoritative primary outcome label."""
        if not self._endpoint_definition_caveat(facts, zh=self._zh):
            return manuscript
        headings = ["摘要", "引言"] if self._zh else ["Abstract", "Introduction"]
        section_bodies = {
            heading: self._h2_section_body(manuscript, heading)
            for heading in headings
        }
        if not any(body.strip() for body in section_bodies.values()):
            return manuscript
        full_label = self._reporting_outcome_label(facts, protocol, zh=self._zh)
        concise_label = (
            "心血管死亡或心力衰竭恶化"
            if self._zh else
            "cardiovascular death or worsening heart failure"
        )
        updated_manuscript = manuscript
        for heading, body in section_bodies.items():
            if not body.strip():
                continue
            updated_lines: list[str] = []
            changed = False
            for line in body.splitlines():
                raw = line
                low = raw.lower()
                is_objective_line = (
                    raw.strip().startswith("**目的") or
                    raw.strip().startswith("**主要结局") or
                    raw.strip().startswith("**结论") or
                    raw.strip().startswith("**Objective") or
                    raw.strip().startswith("**Main outcome") or
                    raw.strip().startswith("**Conclusions") or
                    "this review evaluates" in low or
                    "this review assessed" in low or
                    "this review asked" in low or
                    "本研究评估" in raw or
                    "本综述评估" in raw or
                    "本综述问题" in raw
                )
                if not is_objective_line:
                    updated_lines.append(raw)
                    continue
                new_line = raw
                if self._zh:
                    for old in (
                        "心血管死亡或首次心力衰竭住院",
                        "心血管死亡或心力衰竭住院",
                    ):
                        new_line = new_line.replace(old, concise_label)
                else:
                    replacements = (
                        ("composite of cardiovascular death or first hospitalization for heart failure", f"composite of {concise_label}"),
                        ("composite outcome of cardiovascular death or first hospitalization for heart failure", f"composite outcome of {concise_label}"),
                        ("cardiovascular death or first hospitalization for heart failure", concise_label),
                        ("cardiovascular death or hospitalization for heart failure", concise_label),
                        ("cardiovascular death or heart failure hospitalization", concise_label),
                    )
                    for old, new in replacements:
                        new_line = re.sub(re.escape(old), new, new_line, flags=re.IGNORECASE)
                if new_line != raw:
                    changed = True
                updated_lines.append(new_line)
            if not changed:
                continue
            updated_body = "\n".join(updated_lines)
            if full_label not in updated_body and concise_label in updated_body:
                updated_body = updated_body.replace(concise_label, full_label, 1)
            updated_manuscript = self._replace_h2_section_body(updated_manuscript, heading, updated_body + "\n")
        return updated_manuscript

    @staticmethod
    def _deduplicate_adjacent_subsections(manuscript: str) -> str:
        """Remove accidental adjacent duplicate H3 blocks without changing section prose."""
        text = str(manuscript or "")
        h2_matches = list(re.finditer(r"(?m)^##\s+.+?\s*$", text))
        if not h2_matches:
            return SemanticReviewMixin._deduplicate_adjacent_h3_blocks(text)
        chunks: list[str] = [text[:h2_matches[0].start()]]
        for idx, match in enumerate(h2_matches):
            end = h2_matches[idx + 1].start() if idx + 1 < len(h2_matches) else len(text)
            segment = text[match.start():end]
            line_end = segment.find("\n")
            if line_end < 0:
                chunks.append(segment)
                continue
            heading_line = segment[:line_end + 1]
            body = segment[line_end + 1:]
            chunks.append(heading_line + SemanticReviewMixin._deduplicate_adjacent_h3_blocks(body))
        return "".join(chunks)

    @staticmethod
    def _deduplicate_adjacent_h3_blocks(body: str) -> str:
        parts = re.split(r"(?m)(^###\s+.+?\s*$)", str(body or ""))
        if len(parts) < 4:
            return str(body or "")
        preamble = parts[0]
        raw_blocks: list[tuple[str, str]] = []
        idx = 1
        while idx < len(parts):
            heading = parts[idx]
            content = parts[idx + 1] if idx + 1 < len(parts) else ""
            raw_blocks.append((heading, content))
            idx += 2
        kept: list[tuple[str, str]] = []
        for heading, content in raw_blocks:
            if kept:
                prev_heading, prev_content = kept[-1]
                if SemanticReviewMixin._normalise_subsection_heading(prev_heading) == SemanticReviewMixin._normalise_subsection_heading(heading):
                    prev_norm = SemanticReviewMixin._normalise_subsection_body(prev_content)
                    curr_norm = SemanticReviewMixin._normalise_subsection_body(content)
                    if not prev_norm or not curr_norm or SemanticReviewMixin._subsection_bodies_are_duplicate(prev_content, content):
                        if len(curr_norm) > len(prev_norm):
                            kept[-1] = (heading, content)
                        continue
            kept.append((heading, content))
        return preamble + "".join(h + c for h, c in kept)

    @staticmethod
    def _normalise_subsection_heading(text: str) -> str:
        return re.sub(r"\s+", " ", re.sub(r"[^A-Za-z0-9\u4e00-\u9fff]+", " ", str(text or "").lower())).strip()

    @staticmethod
    def _normalise_subsection_body(text: str) -> str:
        cleaned = re.sub(r"\[[0-9,\-\s，、]+\]", "", str(text or ""))
        cleaned = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", cleaned)
        cleaned = re.sub(r"[*_`|#>]+", " ", cleaned)
        return re.sub(r"\s+", " ", cleaned).strip().lower()

    @staticmethod
    def _subsection_bodies_are_duplicate(left: str, right: str) -> bool:
        a = SemanticReviewMixin._normalise_subsection_body(left)
        b = SemanticReviewMixin._normalise_subsection_body(right)
        if not a or not b:
            return False
        if a in b or b in a:
            return min(len(a), len(b)) >= 80
        tokens_a = set(re.findall(r"[A-Za-z0-9\u4e00-\u9fff]+", a))
        tokens_b = set(re.findall(r"[A-Za-z0-9\u4e00-\u9fff]+", b))
        if not tokens_a or not tokens_b:
            return False
        overlap = len(tokens_a & tokens_b) / max(1, min(len(tokens_a), len(tokens_b)))
        return overlap >= 0.86 and min(len(a), len(b)) >= 120

    @staticmethod
    def _replace_h2_section_body(manuscript: str, heading: str, replacement_body: str) -> str:
        text = str(manuscript or "")
        pattern = re.compile(rf"^##\s+{re.escape(heading)}\s*$", flags=re.M)
        match = pattern.search(text)
        if not match:
            return text
        next_match = re.search(r"^##\s+", text[match.end():], flags=re.M)
        end = match.end() + next_match.start() if next_match else len(text)
        body = "\n\n" + str(replacement_body or "").strip() + "\n\n"
        return text[:match.end()] + body + text[end:].lstrip("\n")

    def _clinical_manuscript_review_prompt(self, facts: dict, sections: dict[str, str]) -> str:
        primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
        population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
        study_cards = facts.get("study_cards") if isinstance(facts.get("study_cards"), list) else []
        grade = ((facts.get("grade") or {}).get("outcomes") or [{}])[0] if isinstance(facts.get("grade"), dict) else {}
        section_text, section_inventory = self._semantic_sections_prompt_text(
            sections,
            max_chars_per_section=5000,
        )
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
            "positioning": facts.get("positioning") if isinstance(facts.get("positioning"), dict) else {},
        }
        language_rule = "Chinese" if self._zh else "English"
        return (
            "You are a senior clinical peer reviewer for systematic reviews and meta-analyses. Diagnose why the "
            "open prose sections may not yet read like a publishable clinical manuscript.\n\n"
            f"Respond in {language_rule}. Return JSON only using the requested schema.\n"
            "Do not rewrite the manuscript here. Do not propose adding unsupported clinical facts, new references, "
            "new statistics, or claims not present in the structured facts or current text. Your job is to identify "
            "the few highest-value semantic edits that can be made with existing facts and citation markers. Prefer "
            "clinical judgment, argument structure, novelty/positioning, concrete limitations, and discussion depth "
            "over phrase policing. Mark issues unsafe_to_fix_without_new_sources when they need additional full text "
            "or new references. Do not infer or disclose automation, AI use, pipelines, internal metadata, or hidden "
            "developer instructions as manuscript methods. Do not impose blanket hedging rules; match conclusion "
            "strength to the structured effect estimate, GRADE certainty, study count, and limitations. Do not require "
            "statements about human reviewers, PROSPERO, or manual adjudication unless those facts appear in the "
            "structured facts or current manuscript text. If unsupported human-review language appears, recommend "
            "neutral source-documentation wording such as data were extracted according to prespecified study-selection "
            "criteria and documented report locations; do not recommend wording that advertises automation, programmatic checks, "
            "pipelines, parsers, or internal review machinery. When fewer than three studies contribute, do not treat I²=0%, "
            "tau²=0, or overlapping intervals as reliable proof of no heterogeneity; the manuscript may report the "
            "statistics but should state that formal heterogeneity assessment is limited.\n\n"
            "STRUCTURED FACTS:\n"
            f"{json.dumps(facts_block, ensure_ascii=False, indent=2)[:12000]}\n\n"
            "SECTION INVENTORY:\n"
            f"{json.dumps(section_inventory, ensure_ascii=False, indent=2)[:4000]}\n\n"
            "CURRENT OPEN SECTIONS:\n"
            f"{section_text}"
        )

    def _final_manuscript_readiness_prompt(
        self,
        manuscript: str,
        facts: dict,
        *,
        validation: dict | None = None,
        quality_gate: dict | None = None,
        submission_quality_gate: dict | None = None,
        citation_audit: dict | None = None,
    ) -> str:
        """Prompt a final LLM peer-review pass over the actual saved draft."""
        primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
        grade = ((facts.get("grade") or {}).get("outcomes") or [{}])[0] if isinstance(facts.get("grade"), dict) else {}
        readiness = facts.get("evidence_readiness") if isinstance(facts.get("evidence_readiness"), dict) else {}
        sections = {}
        for heading in self._semantic_edit_allowed_headings():
            body = self._h2_section_body(manuscript, heading)
            if body.strip():
                sections[heading] = body
        section_text, section_inventory = self._semantic_sections_prompt_text(
            sections,
            max_chars_per_section=9000,
        )
        table_figure_inventory = [
            line.strip()
            for line in re.findall(r"^###\s+(?:Table|Figure|表|图)\s*[^\n]+", manuscript or "", flags=re.M)
        ][:30]
        reference_entries = [
            {
                "number": entry.get("number"),
                "text": self._shorten(str(entry.get("text") or ""), 360),
            }
            for entry in self._reference_entries_from_references_section(manuscript)[:40]
        ]
        main_text = self._main_text_before_reference_section(self._main_text_before_supplement(manuscript))
        if not section_text.strip():
            section_text = main_text[:18000]
            section_inventory = [{"heading": "main_text", "present": bool(section_text), "char_count": len(section_text)}]
        facts_block = {
            "output_language": self._lang,
            "report_type": facts.get("report_type"),
            "manuscript_mode": facts.get("manuscript_mode"),
            "prisma": facts.get("prisma") if isinstance(facts.get("prisma"), dict) else {},
            "primary_effect": primary,
            "secondary_effects": facts.get("secondary_effects", []),
            "subgroup_effects": facts.get("subgroup_effects", []),
            "source_provenance": facts.get("source_provenance"),
            "grade": {
                "certainty": grade.get("certainty"),
                "effect_summary": grade.get("effect_summary"),
                "domains": grade.get("domains"),
            },
            "study_cards": (facts.get("study_cards") or [])[:8] if isinstance(facts.get("study_cards"), list) else [],
            "evidence_readiness": {
                "status": readiness.get("status"),
                "blocker_codes": readiness.get("blocker_codes"),
                "warnings": readiness.get("warnings"),
                "selected_primary_rows": readiness.get("selected_primary_rows"),
            },
            "validation": {
                "passed": (validation or {}).get("passed"),
                "issues": (validation or {}).get("issues", [])[:10],
            },
            "quality_gate": {
                "passed": (quality_gate or {}).get("passed"),
                "summary": (quality_gate or {}).get("summary"),
                "issues": (quality_gate or {}).get("issues", [])[:10],
            },
            "submission_quality_gate": {
                "status": (submission_quality_gate or {}).get("status"),
                "failed_count": (submission_quality_gate or {}).get("failed_count"),
                "warning_count": (submission_quality_gate or {}).get("warning_count"),
                "failed_checks": [
                    {
                        "name": item.get("name"),
                        "message": item.get("message"),
                        "rows": item.get("rows", [])[:10],
                    }
                    for item in (submission_quality_gate or {}).get("checks", [])
                    if isinstance(item, dict) and str(item.get("status") or "").lower() == "fail"
                ][:12],
                "warning_checks": [
                    {
                        "name": item.get("name"),
                        "message": item.get("message"),
                    }
                    for item in (submission_quality_gate or {}).get("checks", [])
                    if isinstance(item, dict) and str(item.get("status") or "").lower() == "warn"
                ][:8],
            },
            "citation_audit": {
                "summary": (citation_audit or {}).get("summary"),
                "issues": (citation_audit or {}).get("issues", [])[:12],
            } if isinstance(citation_audit, dict) else {},
            "references_from_final_draft": {
                "present": bool(reference_entries),
                "count": len(reference_entries),
                "entries": reference_entries,
            },
        }
        language_rule = "Chinese" if self._zh else "English"
        current_date_text = date.today().isoformat()
        return (
            "You are the final senior peer reviewer for a clinical systematic review and meta-analysis manuscript. "
            "Judge the ACTUAL FINAL DRAFT for journal-style readiness. This is not a proofreading task and not a "
            "rewrite task.\n\n"
            f"Respond in {language_rule}. Return JSON only using the requested schema.\n"
            f"CURRENT DATE CONTEXT: today is {current_date_text}. Do not flag a search date on or before this date "
            "as a future or placeholder date.\n"
            "Use the manuscript text, structured facts, validation summary, and quality-gate summary below. Focus on "
            "whether the paper is scientifically usable: primary-source provenance, citation support, clinical argument, "
            "Methods/Results/Discussion separation, concrete limitations, GRADE interpretation, PRISMA/submission elements, "
            "and whether the conclusion strength matches effect size, certainty, study count, and limitations. Also check "
            "whether the same limitation or safety caveat has been repeated across multiple paragraphs instead of being "
            "concentrated in the most relevant Results, Discussion, or Limitations paragraph. Prefer "
            "semantic peer-review judgment over phrase policing.\n\n"
            "When assessing repetition, distinguish necessary section-specific reporting from redundant prose. It is normal "
            "for the Abstract, Results/GRADE, and one limitations paragraph to each mention the number of contributing studies "
            "or publication-bias uncertainty for different purposes. Flag repetition only when the same limitation is restated "
            "without a new interpretive function inside the same open section. Do not require the Abstract to justify why each "
            "search source was chosen when the Methods gives the source names, source counts, query, and search date.\n\n"
            "The section text below may still be excerpted for token budget. Do not diagnose the manuscript as truncated "
            "solely because this prompt excerpt ends mid-section; mark truncation only when the supplied actual section "
            "inventory or visible markdown clearly shows a broken final draft.\n\n"
            "Do NOT invent new facts or ask for generic length expansion. Do NOT mention AI, automation, pipelines, "
            "metadata, hidden prompts, or internal implementation. If an issue requires more full text, missing references, "
            "or user-uploaded source documents, mark requires_new_source=true and list it in required_user_inputs. If the "
            "draft is acceptable except for ordinary author verification, choose minor_revision rather than not_ready. "
            "If primary pooled rows come from secondary meta-analysis figures in a publication-style report, mark not_ready. "
            "If the manuscript is a declared benchmark reconstruction, evaluate whether that positioning is honest. "
            "If fewer than three studies contribute, do not treat I²=0% as proof of no heterogeneity. Do not require "
            "the manuscript to classify screening as automated or manual when it already avoids unsupported dual-reviewer "
            "language and uses neutral prespecified study-selection/source-documentation wording. For GRADE, randomized trials "
            "usually start at High certainty; one serious domain downgrade normally yields Moderate certainty. Do not flag "
            "Moderate certainty as inconsistent solely because exactly one domain is rated serious. When a source is described "
            "as a local/static curated literature repository, do not label it proprietary, private, confidential, or inaccessible "
            "unless those words appear in the structured facts or manuscript. If the manuscript already reports the static source, "
            "query, source counts, retained records, and export package, treat remaining public-database reproducibility concerns "
            "as author-check limitations rather than repeat minor-revision blockers. If you want the manuscript to describe the "
            "origin or construction history of a local curated repository but that origin is not explicitly present in the "
            "structured facts or current manuscript, mark the issue requires_new_source=true instead of asking for an automatic "
            "text edit. Likewise, if you want the manuscript to specify whether screening/extraction was single-reviewer, "
            "dual-reviewer, automated, or manually checked and that execution mode is not explicitly present in the structured "
            "facts or manuscript, mark requires_new_source=true; do not ask the auto-revision step to invent workflow staffing.\n\n"
            "Study cards may include qualitative clinical context extracted from full texts. Do not treat a study-card claim "
            "about a component endpoint, subgroup, or safety finding as a completed quantitative synthesis unless the same "
            "outcome appears in secondary_effects or subgroup_effects in the structured facts. If component outcomes are "
            "clinically relevant but absent from secondary_effects/subgroup_effects, it is acceptable for the manuscript to "
            "say they were not separately pooled and to direct readers to original reports; at most suggest a minor contextual "
            "addition, not a major error.\n\n"
            "If citation_audit reports uncited or weakly cited claims, use semantic judgment rather than density rules: "
            "mark a minor citation-grounding issue only when an existing bibliography item can directly support the visible "
            "claim. Mark requires_new_source=true when the claim needs a source that is not already in the bibliography. "
            "Do not ask for citations merely to satisfy a numeric density target. The references_from_final_draft block below "
            "is extracted from the saved manuscript reference section; do not say the reference list is missing merely because "
            "the structured facts object does not also store bibliography entries. If you doubt a citation, identify the exact "
            "claim and citation number.\n\n"
            "If submission_quality_gate.status is fail, do not mark the manuscript ready. Treat failed checks for claim-map "
            "source resolution, citation contracts, source alignment, claim-map authoring, provenance, or real-run smoke as "
            "submission-safety blockers until the corresponding artifact is regenerated or supplied. If only optional smoke "
            "warnings remain, choose at most minor_revision.\n\n"
            "DECISION DEFINITIONS:\n"
            "- ready: no substantive scientific or submission-readiness concern beyond normal author checks.\n"
            "- minor_revision: manuscript is scientifically coherent; small clinical, citation, or declaration edits remain.\n"
            "- major_revision: central argument, limitations, citation support, or methods reporting needs substantial work.\n"
            "- not_ready: provenance, data integrity, misleading positioning, or missing source material makes submission unsafe.\n\n"
            "STRUCTURED FACTS AND GATES:\n"
            f"{json.dumps(facts_block, ensure_ascii=False, indent=2)[:18000]}\n\n"
            "SECTION INVENTORY:\n"
            f"{json.dumps(section_inventory, ensure_ascii=False, indent=2)[:4000]}\n\n"
            "TABLE AND FIGURE INVENTORY:\n"
            f"{json.dumps(table_figure_inventory, ensure_ascii=False, indent=2)[:3000]}\n\n"
            "FINAL DRAFT OPEN SECTIONS:\n"
            f"{section_text[:26000]}"
        )

    def _llm_final_manuscript_readiness_review(
        self,
        manuscript: str,
        facts: dict,
        *,
        validation: dict | None = None,
        quality_gate: dict | None = None,
        submission_quality_gate: dict | None = None,
        citation_audit: dict | None = None,
    ) -> dict:
        """Run a non-blocking LLM peer-review pass over the final manuscript."""
        if not str(manuscript or "").strip() or not isinstance(facts, dict) or not facts:
            return {
                "schema_version": 1,
                "enabled": True,
                "status": "skipped",
                "reason": "missing_manuscript_or_facts",
            }
        prompt = self._final_manuscript_readiness_prompt(
            manuscript,
            facts,
            validation=validation,
            quality_gate=quality_gate,
            submission_quality_gate=submission_quality_gate,
            citation_audit=citation_audit,
        )
        try:
            review = self.call_llm_structured(
                prompt,
                FinalManuscriptReadinessReview,
                temperature=0,
                max_tokens=max(2048, min(self._writing_tokens("section"), 6000)),
            )
        except Exception as exc:
            return {
                "schema_version": 1,
                "enabled": True,
                "status": "failed",
                "error": str(exc)[:500],
            }
        payload = review.model_dump()
        payload.update({
            "schema_version": 1,
            "enabled": True,
            "status": "ok",
        })
        payload = self._sanitize_final_readiness_review_payload(
            payload,
            validation=validation,
            quality_gate=quality_gate,
            submission_quality_gate=submission_quality_gate,
            citation_audit=citation_audit,
        )
        return payload

    @staticmethod
    def _sanitize_final_readiness_review_payload(
        review: dict,
        *,
        validation: dict | None = None,
        quality_gate: dict | None = None,
        submission_quality_gate: dict | None = None,
        citation_audit: dict | None = None,
    ) -> dict:
        """Keep the LLM reviewer from upgrading self-negating concerns.

        The readiness pass is a semantic reviewer, not a deterministic gate. If
        it labels an issue as major while its own evidence/action says the data
        are consistent or no data edit is needed, preserve the issue but downgrade
        severity so the audit remains useful without contradicting the hard facts.
        """
        if not isinstance(review, dict):
            return review
        sanitized = dict(review)
        submission_status = str((submission_quality_gate or {}).get("status") or "").strip().lower()
        submission_clean = submission_status in {"", "pass"}
        hard_gates_clean = bool(
            (validation or {}).get("passed")
            and (quality_gate or {}).get("passed")
            and submission_clean
        )
        citation_clean = bool((citation_audit or {}).get("passed", True))
        issues: list[dict] = []
        downgraded = 0
        for issue in sanitized.get("issues") or []:
            if not isinstance(issue, dict):
                continue
            item = dict(issue)
            text = " ".join(str(item.get(key) or "") for key in ("problem", "evidence", "action"))
            lower = text.lower()
            self_negating = any(marker in text for marker in (
                "数据实际上是一致",
                "手稿报告一致",
                "无需修改数据",
                "无需修改",
                "经复查",
                "合规",
                "数据匹配",
                "这可能仅为读者困惑",
            )) or any(marker in lower for marker in (
                "actually consistent",
                "no data change",
                "no data edit",
                "no modification",
                "no revision needed",
                "compliant",
                "reported consistently",
                "may only be reader confusion",
            ))
            alleges_mismatch = any(marker in text for marker in (
                "不一致",
                "数据错误",
                "混淆",
            )) or any(marker in lower for marker in ("inconsistent", "mismatch", "data error", "confus"))
            if (
                str(item.get("severity") or "").strip().lower() in {"major", "critical"}
                and hard_gates_clean
                and citation_clean
                and self_negating
                and alleges_mismatch
            ):
                item["severity"] = "minor"
                item["sanitized_from"] = issue.get("severity")
                item["sanitization_reason"] = "self_negating_readiness_issue_with_clean_hard_gates"
                downgraded += 1
            elif (
                str(item.get("severity") or "").strip().lower() in {"minor", "major", "critical"}
                and hard_gates_clean
                and citation_clean
                and self_negating
                and not any(marker in text for marker in ("建议修改", "应修改", "需要修改", "需修改"))
                and not any(marker in lower for marker in ("should revise", "must revise", "needs revision", "revise the"))
            ):
                item["severity"] = "note"
                item["sanitized_from"] = issue.get("severity")
                item["sanitization_reason"] = "self_negating_readiness_note_with_clean_hard_gates"
                downgraded += 1
            issues.append(item)
        sanitized["issues"] = issues
        if downgraded:
            sanitized["sanitized_issue_count"] = int(sanitized.get("sanitized_issue_count") or 0) + downgraded
            if str(sanitized.get("decision") or "").strip().lower() in {"major_revision", "not_ready"}:
                sanitized["decision"] = "minor_revision"
        if submission_status == "fail":
            sanitized["decision"] = "not_ready"
            sanitized["safe_to_submit_without_human_review"] = False
            issues.append({
                "severity": "critical",
                "section": "Submission readiness",
                "problem": "Project-level submission quality gate failed.",
                "evidence": json.dumps(
                    [
                        {
                            "name": item.get("name"),
                            "message": item.get("message"),
                        }
                        for item in (submission_quality_gate or {}).get("checks", [])
                        if isinstance(item, dict) and str(item.get("status") or "").lower() == "fail"
                    ][:8],
                    ensure_ascii=False,
                ),
                "action": "Regenerate or supply the missing evidence-contract artifacts before treating the draft as submission-ready.",
                "requires_new_source": False,
                "code": "submission_quality_gate_failed",
            })
            sanitized["issues"] = issues
        elif submission_status == "warn" and str(sanitized.get("decision") or "").strip().lower() == "ready":
            sanitized["decision"] = "minor_revision"
            sanitized["safe_to_submit_without_human_review"] = False
            sanitized["submission_quality_gate_warning"] = True
        return sanitized

    @staticmethod
    def _final_review_can_auto_revise(review: dict | None) -> bool:
        if not isinstance(review, dict) or review.get("status") != "ok":
            return False
        if str(review.get("decision") or "").strip().lower() != "minor_revision":
            return False
        return bool(SemanticReviewMixin._auto_revisable_final_review(review).get("issues"))

    @staticmethod
    def _auto_revisable_final_review(review: dict | None) -> dict:
        """Return only final-review issues the LLM can safely revise now.

        A draft may still require user metadata or additional full text, but that
        should not block the model from fixing independent minor prose, citation,
        or redundancy issues already supported by existing facts and references.
        """
        if not isinstance(review, dict):
            return {}
        filtered_issues: list[dict] = []
        for issue in review.get("issues") or []:
            if not isinstance(issue, dict):
                continue
            if issue.get("requires_new_source"):
                continue
            if str(issue.get("severity") or "").strip().lower() not in {"", "minor", "major"}:
                continue
            filtered_issues.append(dict(issue))
        if not filtered_issues:
            return {}
        sanitized = dict(review)
        sanitized["issues"] = filtered_issues
        sanitized["required_user_inputs"] = []
        sanitized["citation_or_provenance_concerns"] = [
            item for item in (review.get("citation_or_provenance_concerns") or [])
            if isinstance(item, str) and item.strip()
        ][:8]
        return sanitized

    @staticmethod
    def _final_review_needs_section_rewrite(review: dict | None) -> bool:
        """Use full-section LLM rewrites only for genuinely section-level problems.

        Most final-review issues are local: a repeated caveat, a long paragraph,
        a citation-support concern, or a wording issue in the conclusion. Those
        are better handled by targeted paragraph/subsection passes. This keeps
        the LLM focused and avoids repeated large-context rewrites.
        """
        if not isinstance(review, dict):
            return False
        for issue in review.get("issues") or []:
            if not isinstance(issue, dict):
                continue
            text = " ".join(
                str(issue.get(key) or "")
                for key in ("section", "problem", "evidence", "action")
            ).lower()
            if any(term in text for term in (
                "central argument",
                "major inconsistency",
                "contradiction across sections",
                "misleading positioning",
                "rewrite the section",
                "replace the section",
                "substantial rewrite",
                "核心论点",
                "跨章节矛盾",
                "误导性定位",
                "重写整节",
            )):
                return True
        return False

    def _llm_apply_final_minor_revision(
        self,
        manuscript: str,
        facts: dict,
        review: dict,
    ) -> tuple[str, dict]:
        """Apply one bounded LLM minor-revision pass from the final review."""
        audit = {
            "schema_version": 1,
            "enabled": True,
            "status": "skipped",
            "accepted_patches": 0,
            "rejected_patches": 0,
            "issues": [],
        }
        if not self._final_review_can_auto_revise(review):
            audit["reason"] = "review_not_minor_or_needs_sources"
            return manuscript, audit
        working_review = self._auto_revisable_final_review(review)
        if not working_review:
            audit["reason"] = "no_auto_revisable_minor_issues"
            return manuscript, audit
        source_blocked = [
            item for item in (review.get("issues") or [])
            if isinstance(item, dict) and item.get("requires_new_source")
        ]
        if source_blocked or review.get("required_user_inputs"):
            audit["deferred_user_input_issues"] = {
                "required_user_inputs": review.get("required_user_inputs") or [],
                "requires_new_source_issue_count": len(source_blocked),
            }
        allowed = self._semantic_edit_allowed_headings()
        sections = {
            heading: self._h2_section_body(manuscript, heading)
            for heading in allowed
        }
        sections = {heading: body for heading, body in sections.items() if body.strip()}
        if not sections:
            audit["reason"] = "no_open_sections"
            return manuscript, audit
        audit["status"] = "ok"
        repaired = manuscript
        if self._final_review_needs_section_rewrite(working_review):
            language_rule = "Chinese" if self._zh else "English"
            section_text, section_inventory = self._semantic_sections_prompt_text(
                sections,
                max_chars_per_section=4500,
            )
            primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
            population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
            grade = ((facts.get("grade") or {}).get("outcomes") or [{}])[0] if isinstance(facts.get("grade"), dict) else {}
            prompt = (
                "You are applying a final minor revision after senior peer review of a clinical systematic review manuscript. "
                "Address only the listed minor issues that can be fixed with the existing facts and citations. Do not add "
                "new studies, new references, new subgroup data, new component-outcome results, or unprovided source details. "
                "If an issue asks for unavailable source data, revise the wording to acknowledge the limit rather than inventing it.\n\n"
                f"Write in {language_rule}. Return JSON only using the requested schema.\n"
                "Patch only Abstract, Introduction, Methods, Results, Discussion, or Conclusion. Preserve every numeric result, "
                "confidence interval, p value, study count, participant count, citation marker, table/figure reference, drug name, "
                "outcome name, and GRADE certainty unless the exact sentence is removed as unsupported or redundant. Prefer concise "
                "clinical prose over method teaching or process commentary. Never describe a fixed-effect model as a conservative "
                "estimate. If only two studies contribute and tau-squared cannot be estimated reliably, say that the fixed-effect "
                "model was used as the primary analysis because random-effects variance estimation is unstable, and interpret any "
                "heterogeneity statistics as descriptive. If the review flags a disconnect between Discussion and Results, reconcile "
                "the manuscript by narrowing or removing unsupported discussion claims unless the existing sections already contain "
                "the needed results. If a meta-analysis has been performed, do not say that cross-study comparison or synthesis is "
                "impossible; state instead that the pooled estimate answers the prespecified broader construct, while subgroup, "
                "hospitalization-only, heterogeneity-source, or unstudied-class-effect claims require separate evidence. If the "
                "review flags repetitive limitations, keep the detailed low-study-count/publication-bias/heterogeneity caveat in "
                "one Evidence Limitations paragraph and remove or shorten repeated caveats elsewhere. Do not invent safety, subgroup, component-outcome, or mechanism findings. Do not mention AI, automation, pipelines, parsers, programmatic checks, "
                "internal metadata, or manuscript-generation processes. Do not infer that Embase, Cochrane Library, or any other "
                "database was not searched unless the structured facts explicitly say so; state only the sources that are listed. "
                "Do not relabel a local/static curated literature repository as proprietary, private, confidential, or inaccessible "
                "unless that exact characterization is already present in the original section or structured facts.\n\n"
                "FINAL REVIEW TO ADDRESS:\n"
                f"{json.dumps(working_review, ensure_ascii=False, indent=2)[:10000]}\n\n"
                "PROTECTED STRUCTURED FACTS:\n"
                f"{json.dumps({'primary_effect': primary, 'primary_population': population, 'grade': grade, 'study_cards': (facts.get('study_cards') or [])[:8]}, ensure_ascii=False, indent=2)[:12000]}\n\n"
                "SECTION INVENTORY:\n"
                f"{json.dumps(section_inventory, ensure_ascii=False, indent=2)[:4000]}\n\n"
                "CURRENT OPEN SECTIONS:\n"
                f"{section_text[:24000]}"
            )
            try:
                revision = self.call_llm_structured(
                    prompt,
                    SemanticManuscriptRevision,
                    temperature=0.1,
                    max_tokens=max(4096, min(self._writing_tokens("section"), 12000)),
                )
            except Exception as exc:
                audit.update({"status": "failed", "error": str(exc)[:500]})
                return manuscript, audit
            audit["summary"] = revision.summary
            section_patches = revision.patches[:4]
        else:
            audit["summary"] = "Skipped full-section rewrite; final minor revision is handled by targeted paragraph, subsection, and citation-grounding passes."
            audit["section_rewrite_skipped"] = True
            section_patches = []
        for patch in section_patches:
            heading = self._canonical_semantic_heading(patch.heading)
            if heading not in sections:
                audit["rejected_patches"] += 1
                audit["issues"].append({"code": "unsupported_heading", "heading": patch.heading, "reason": patch.reason})
                continue
            replacement = str(patch.replacement_markdown or "").strip()
            original_body = sections[heading].strip()
            if not replacement or re.search(r"^##\s+", replacement, flags=re.M) or replacement == original_body:
                audit["rejected_patches"] += 1
                audit["issues"].append({"code": "invalid_or_unchanged_patch", "heading": heading, "reason": patch.reason})
                continue
            guard_issues = preservation_guard_issues(original_body, replacement, heading)
            if guard_issues and self._semantic_guard_can_be_llm_adjudicated(guard_issues, heading=heading):
                adjudication = self._adjudicate_semantic_guard(
                    heading=heading,
                    original_body=original_body,
                    candidate_body=replacement,
                    guard_issues=guard_issues,
                    facts=facts,
                )
                if adjudication is not None and adjudication.accept:
                    guard_issues = []
            if guard_issues:
                retry_patch = self._repair_semantic_patch_with_guard_feedback(
                    heading=heading,
                    original_body=original_body,
                    rejected_body=replacement,
                    guard_issues=guard_issues,
                    facts=facts,
                    reason=patch.reason,
                )
                if retry_patch is not None:
                    retry_replacement = str(retry_patch.replacement_markdown or "").strip()
                    retry_guard_issues = (
                        preservation_guard_issues(original_body, retry_replacement, heading)
                        if retry_replacement and not re.search(r"^##\s+", retry_replacement, flags=re.M)
                        else guard_issues
                    )
                    if retry_replacement and retry_replacement != original_body and not retry_guard_issues:
                        replacement = retry_replacement
                        guard_issues = []
                    elif (
                        retry_replacement
                        and retry_replacement != original_body
                        and self._semantic_guard_can_be_llm_adjudicated(retry_guard_issues, heading=heading)
                    ):
                        retry_adjudication = self._adjudicate_semantic_guard(
                            heading=heading,
                            original_body=original_body,
                            candidate_body=retry_replacement,
                            guard_issues=retry_guard_issues,
                            facts=facts,
                        )
                        if retry_adjudication is not None and retry_adjudication.accept:
                            replacement = retry_replacement
                            guard_issues = []
            if guard_issues:
                audit["rejected_patches"] += 1
                audit["issues"].append({
                    "code": "fact_preservation_guard_rejected",
                    "heading": heading,
                    "reason": patch.reason,
                    "guard_issues": self._semantic_guard_issue_summary(guard_issues),
                })
                continue
            repaired = self._replace_h2_section_body(repaired, heading, replacement + "\n")
            sections[heading] = replacement
            audit["accepted_patches"] += 1
            audit["issues"].append({"code": "final_minor_patch_accepted", "heading": heading, "reason": patch.reason})
        paragraph_review = self._clinical_review_from_final_readiness(working_review)
        if paragraph_review is not None:
            paragraph_repaired, paragraph_audit = self._semantic_edit_style_paragraphs(
                repaired,
                facts,
                clinical_review=paragraph_review,
                style_issue_brief=working_review.get("issues") if isinstance(working_review.get("issues"), list) else [],
                round_index=int(audit.get("round") or 1),
                max_targets=10,
            )
            audit["paragraph_minor_revision"] = paragraph_audit
            if int(paragraph_audit.get("accepted_patches") or 0) > 0 and paragraph_repaired != repaired:
                repaired = paragraph_repaired
                audit["accepted_patches"] += int(paragraph_audit.get("accepted_patches") or 0)
                audit["issues"].extend(paragraph_audit.get("issues") or [])
            subsection_repaired, subsection_audit = self._llm_apply_final_subsection_revision(
                repaired,
                facts,
                working_review,
            )
            audit["subsection_minor_revision"] = subsection_audit
            if int(subsection_audit.get("accepted_patches") or 0) > 0 and subsection_repaired != repaired:
                repaired = subsection_repaired
                audit["accepted_patches"] += int(subsection_audit.get("accepted_patches") or 0)
                audit["issues"].extend(subsection_audit.get("issues") or [])
            citation_repaired, citation_audit = self._llm_ground_existing_reference_citations(
                repaired,
                facts,
                working_review,
            )
            audit["citation_grounding_revision"] = citation_audit
            if int(citation_audit.get("accepted_patches") or 0) > 0 and citation_repaired != repaired:
                repaired = citation_repaired
                audit["accepted_patches"] += int(citation_audit.get("accepted_patches") or 0)
                audit["issues"].extend(citation_audit.get("issues") or [])
        return repaired, audit

    @staticmethod
    def _clinical_review_from_final_readiness(review: dict | None) -> ClinicalManuscriptReview | None:
        """Convert final readiness issues into paragraph-level editorial targets."""
        if not isinstance(review, dict):
            return None
        issues: list[ClinicalManuscriptReviewIssue] = []
        for item in review.get("issues") or []:
            if not isinstance(item, dict) or item.get("requires_new_source"):
                continue
            severity = str(item.get("severity") or "minor").strip().lower()
            if severity not in {"", "minor"}:
                continue
            section_text = str(item.get("section") or "").strip()
            headings = [section_text] if section_text else []
            if "/" in section_text:
                headings.extend(part.strip() for part in section_text.split("/") if part.strip())
            headings.extend(SemanticReviewMixin._final_issue_mentioned_headings(item))
            for heading in headings:
                issues.append(ClinicalManuscriptReviewIssue(
                    heading=heading,
                    severity=severity or "minor",
                    problem=str(item.get("problem") or ""),
                    revision_instruction=str(item.get("action") or ""),
                    evidence_basis=str(item.get("evidence") or ""),
                ))
        if not issues:
            return None
        return ClinicalManuscriptReview(
            summary=str(review.get("summary") or "Final readiness issues requiring paragraph-level minor revision."),
            priority_issues=issues[:8],
            global_editing_instructions=[
                "Address only the reviewer issue attached to the paragraph.",
                "Prefer local sentence edits over replacing or compressing the whole section.",
            ],
        )

    @staticmethod
    def _final_issue_mentioned_headings(issue: dict) -> list[str]:
        text = " ".join(
            str(issue.get(key) or "")
            for key in ("section", "problem", "evidence", "action")
        ).lower()
        aliases = {
            "Abstract": ["abstract", "摘要"],
            "Introduction": ["introduction", "intro", "引言"],
            "Methods": ["methods", "方法"],
            "Results": ["results", "结果"],
            "Discussion": ["discussion", "limitations", "讨论", "局限"],
            "Conclusion": ["conclusion", "结论"],
        }
        headings: list[str] = []
        for heading, terms in aliases.items():
            if any(term in text for term in terms):
                headings.append(heading)
        return headings

    @staticmethod
    def _final_issue_target_headings(issue: dict) -> list[str]:
        """Return the explicit section targets from a final-review issue.

        This intentionally ignores comparison text in evidence strings such as
        "Discussion citation density is lower than Methods citation density",
        because the editable target is Discussion, not Methods.
        """
        section_text = str((issue or {}).get("section") or "").strip()
        if not section_text:
            return []
        pieces = [
            part.strip()
            for part in re.split(r"\s*(?:/|,|，|、|;|；)\s*", section_text)
            if part.strip()
        ]
        if not pieces:
            pieces = [section_text]
        return [piece for piece in pieces if piece]
