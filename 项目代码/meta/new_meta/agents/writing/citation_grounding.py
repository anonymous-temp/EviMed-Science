"""Grounding existing citation markers against the recorded sources."""
from __future__ import annotations

import json
import re

from new_meta.core.manuscript_polish import preservation_guard_issues

from new_meta.agents.writing.contracts import (
    CitationGroundingRevision,
    ClinicalManuscriptReview,
    SemanticSubsectionRevision,
)

from new_meta.agents.writing.citation_repair import CitationRepairMixin
from new_meta.agents.writing.semantic_review import SemanticReviewMixin


class CitationGroundingMixin:
    """Grounding existing citation markers against the recorded sources."""

    def _llm_ground_existing_reference_citations(
        self,
        manuscript: str,
        facts: dict,
        review: dict,
    ) -> tuple[str, dict]:
        audit = {
            "schema_version": 1,
            "status": "skipped",
            "accepted_patches": 0,
            "rejected_patches": 0,
            "issues": [],
        }
        if not self._final_review_has_citation_grounding_issue(review):
            audit["reason"] = "no_citation_grounding_issue"
            return manuscript, audit
        references = self._reference_inventory_from_manuscript(manuscript)
        if not references:
            audit["reason"] = "no_reference_inventory"
            return manuscript, audit
        targets, section_paragraphs = self._citation_grounding_targets(manuscript, review, max_targets=10)
        if not targets:
            audit["reason"] = "no_citation_grounding_targets"
            return manuscript, audit
        prompt = self._citation_grounding_prompt(
            facts=facts,
            review=review,
            references=references,
            targets=targets,
        )
        try:
            revision = self.call_llm_structured(
                prompt,
                CitationGroundingRevision,
                temperature=0.05,
                max_tokens=max(4096, min(self._writing_tokens("section"), 12000)),
            )
        except Exception as exc:
            audit.update({"status": "failed", "error": str(exc)[:500]})
            return manuscript, audit

        audit["status"] = "ok"
        audit["summary"] = revision.summary
        if revision.unsupported_claims:
            audit["unsupported_claims"] = revision.unsupported_claims[:12]
        valid_numbers = {int(item["number"]) for item in references if str(item.get("number") or "").isdigit()}
        changed_sections: set[str] = set()
        for patch in revision.patches[:10]:
            heading = self._canonical_semantic_heading(patch.heading)
            paragraphs = section_paragraphs.get(heading)
            if not paragraphs:
                audit["rejected_patches"] += 1
                audit["issues"].append({
                    "code": "unsupported_citation_heading",
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
                    "code": "invalid_citation_paragraph_index",
                    "heading": heading,
                    "paragraph_index": patch.paragraph_index,
                    "reason": patch.reason,
                })
                continue
            original = paragraphs[paragraph_index - 1].strip()
            replacement = str(patch.replacement_markdown or "").strip()
            if replacement == original:
                audit["issues"].append({
                    "code": "citation_grounding_unchanged",
                    "heading": heading,
                    "paragraph_index": paragraph_index,
                    "reason": patch.reason,
                })
                continue
            guard_issues = self._citation_grounding_guard_issues(original, replacement, valid_numbers)
            if guard_issues:
                audit["rejected_patches"] += 1
                audit["issues"].append({
                    "code": "citation_grounding_guard_rejected",
                    "heading": heading,
                    "paragraph_index": paragraph_index,
                    "reason": patch.reason,
                    "guard_issues": guard_issues,
                })
                continue
            paragraphs[paragraph_index - 1] = replacement
            changed_sections.add(heading)
            audit["accepted_patches"] += 1
            audit["issues"].append({
                "code": "citation_grounding_accepted",
                "heading": heading,
                "paragraph_index": paragraph_index,
                "citation_numbers": patch.citation_numbers,
                "reason": patch.reason,
            })
        repaired = manuscript
        for heading in changed_sections:
            repaired = self._replace_h2_section_body(
                repaired,
                heading,
                "\n\n".join(paragraph for paragraph in section_paragraphs[heading] if paragraph.strip()) + "\n",
            )
        return repaired, audit

    def _llm_ground_citation_audit_issues(
        self,
        manuscript: str,
        facts: dict,
        citation_audit: dict,
    ) -> tuple[str, dict]:
        """Use the LLM citation resolver before citation-audit failures block output."""
        issues: list[dict] = []
        for issue in (citation_audit or {}).get("issues") or []:
            if not isinstance(issue, dict):
                continue
            severity = str(issue.get("severity") or "").lower()
            code = str(issue.get("code") or "")
            if severity not in {"fail", "error"} and code not in {
                "section_citations_missing",
                "repeated_large_citation_cluster",
                "overloaded_citation_cluster",
                "chinese_ascii_numeric_citation_marker_style",
                "uncited_numeric_effect_claim",
                "uncited_introduction_background_claim",
                "uncited_discussion_context_claim",
                "uncited_discussion_result_claim",
                "uncited_discussion_mechanism_claim",
            }:
                continue
            issues.append({
                "severity": "minor",
                "section": issue.get("section") or ", ".join(issue.get("sections") or []) or "Main text",
                "problem": issue.get("message") or code,
                "evidence": json.dumps({
                    "code": code,
                    "citation_marker": issue.get("citation_marker"),
                    "citation_numbers": issue.get("citation_numbers"),
                    "occurrences": issue.get("occurrences"),
                    "evidence_excerpt": issue.get("evidence_excerpt"),
                }, ensure_ascii=False),
                "action": (
                    "Use the existing bibliography to correct or add citation markers by claim. "
                    "Replace repeated broad citation clusters with the smallest set of references that directly supports "
                    "the sentence; add a citation to uncited numeric, background, result, context, or mechanism claims only "
                    "when an existing reference directly supports the visible sentence; use Chinese full-width citation markers "
                    "in Chinese manuscripts."
                ),
                "requires_new_source": False,
            })
        audit = {
            "schema_version": 1,
            "status": "skipped",
            "accepted_patches": 0,
            "rejected_patches": 0,
            "issues": [],
        }
        if not issues:
            audit["reason"] = "no_repairable_citation_audit_issues"
            return manuscript, audit
        review = {
            "schema_version": 1,
            "status": "ok",
            "decision": "minor_revision",
            "summary": "Citation audit requested citation grounding before hard validation.",
            "issues": issues[:8],
        }
        repaired, grounding_audit = self._llm_ground_existing_reference_citations(
            manuscript,
            facts,
            review,
        )
        grounding_audit["trigger"] = "citation_audit"
        grounding_audit["trigger_issue_count"] = len(issues)
        return repaired, grounding_audit

    @staticmethod
    def _citation_audit_has_repairable_grounding_issues(citation_audit: dict | None) -> bool:
        if not isinstance(citation_audit, dict):
            return False
        repairable = {
            "section_citations_missing",
            "repeated_large_citation_cluster",
            "overloaded_citation_cluster",
            "chinese_ascii_numeric_citation_marker_style",
            "uncited_numeric_effect_claim",
            "uncited_introduction_background_claim",
            "uncited_discussion_context_claim",
            "uncited_discussion_result_claim",
            "uncited_discussion_mechanism_claim",
        }
        for issue in citation_audit.get("issues") or []:
            if isinstance(issue, dict) and str(issue.get("code") or "") in repairable:
                return True
        return False

    def _final_review_has_citation_grounding_issue(self, review: dict | None) -> bool:
        if not isinstance(review, dict):
            return False
        for issue in review.get("issues") or []:
            if not isinstance(issue, dict) or issue.get("requires_new_source"):
                continue
            text = " ".join(str(issue.get(key) or "") for key in ("section", "problem", "evidence", "action")).lower()
            if any(term in text for term in ("citation", "reference", "引用", "参考文献")):
                return True
        return False

    def _citation_grounding_targets(
        self,
        manuscript: str,
        review: dict,
        *,
        max_targets: int = 10,
    ) -> tuple[list[dict[str, object]], dict[str, list[str]]]:
        issue_sections: list[str] = []
        for issue in review.get("issues") or []:
            if not isinstance(issue, dict) or issue.get("requires_new_source"):
                continue
            text = " ".join(str(issue.get(key) or "") for key in ("problem", "evidence", "action")).lower()
            if not any(term in text for term in ("citation", "reference", "引用", "参考文献")):
                continue
            for heading in self._final_issue_target_headings(issue):
                canonical = self._canonical_semantic_heading(heading)
                if canonical in self._semantic_edit_allowed_headings() and canonical not in issue_sections:
                    issue_sections.append(canonical)
        if not issue_sections:
            issue_sections = [
                self._canonical_semantic_heading("Introduction"),
                self._canonical_semantic_heading("Discussion"),
            ]
        section_paragraphs: dict[str, list[str]] = {}
        targets: list[dict[str, object]] = []
        per_section_limit = max(1, min(4, max_targets // max(1, len(issue_sections))))
        for heading in issue_sections:
            body = self._h2_section_body(manuscript, heading)
            if not body.strip():
                continue
            paragraphs = re.split(r"\n\s*\n", body.strip())
            section_paragraphs[heading] = paragraphs
            section_target_count = 0
            for index, paragraph in enumerate(paragraphs, 1):
                if not self._paragraph_has_citable_line(paragraph):
                    continue
                stripped = paragraph.strip()
                if stripped.startswith("###") or stripped.startswith("|") or stripped.startswith("!["):
                    continue
                citation_count = len(set(self._citation_numbers_from_text(stripped)))
                targets.append({
                    "heading": heading,
                    "paragraph_index": index,
                    "citation_count": citation_count,
                    "text": stripped,
                })
                section_target_count += 1
                if len(targets) >= max_targets:
                    return targets, section_paragraphs
                if section_target_count >= per_section_limit:
                    break
        return targets, section_paragraphs

    def _citation_grounding_prompt(
        self,
        *,
        facts: dict,
        review: dict,
        references: list[dict[str, object]],
        targets: list[dict[str, object]],
    ) -> str:
        language_rule = "Chinese" if self._zh else "English"
        primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
        population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
        return (
            "You are grounding citations for a clinical systematic-review manuscript. Use judgment, not citation-density filling. "
            "For each target paragraph, add only existing reference numbers that directly support a specific claim in that paragraph. "
            "If an existing citation cluster is too broad or repeated mechanically, replace it with the smallest existing-reference "
            "set that directly supports the sentence. "
            "If none of the existing references clearly supports the paragraph, omit the patch and list the unsupported claim. "
            "Do not add placeholder citations. Do not cite primary trial reports for broad background or guideline claims unless the "
            "paragraph specifically discusses those named trials or their results. Do not introduce new references. Do not add "
            "external reference citations to sentences reporting this review's own pooled estimate, pooled HR/OR/RR, confidence "
            "interval, p value, GRADE conclusion, or absolute-effect calculation; those are analysis outputs and should be supported "
            "by tables, figures, and the supplementary source table rather than by citing the primary trials as if they reported the pooled result.\n\n"
            f"Write in {language_rule}. Return JSON only. Each replacement_markdown must be the same paragraph with citation markers only; "
            "do not reword, add facts, delete sentences, or change numbers. You may add, remove, or replace citation markers only when "
            "the revised marker better grounds the exact sentence claim.\n\n"
            "FINAL REVIEW CONTEXT:\n"
            f"{json.dumps(review, ensure_ascii=False, indent=2)[:8000]}\n\n"
            "PROTECTED FACTS:\n"
            f"{json.dumps({'primary_effect': primary, 'primary_population': population, 'study_cards': (facts.get('study_cards') or [])[:8]}, ensure_ascii=False, indent=2)[:10000]}\n\n"
            "AVAILABLE REFERENCES:\n"
            f"{json.dumps(references[:80], ensure_ascii=False, indent=2)[:18000]}\n\n"
            "TARGET PARAGRAPHS:\n"
            f"{json.dumps(targets, ensure_ascii=False, indent=2)[:18000]}"
        )

    @staticmethod
    def _reference_inventory_from_manuscript(manuscript: str) -> list[dict[str, object]]:
        body = SemanticReviewMixin._h2_section_body(manuscript, "References")
        if not body:
            body = SemanticReviewMixin._h2_section_body(manuscript, "参考文献")
        if not body:
            return []
        matches = list(re.finditer(r"(?m)^[\[［]([0-9]+)[\]］]\s+", body))
        references: list[dict[str, object]] = []
        for index, match in enumerate(matches):
            end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
            entry = body[match.end():end].strip()
            try:
                number = int(match.group(1))
            except Exception:
                continue
            references.append({
                "number": number,
                "entry": re.sub(r"\s+", " ", entry)[:900],
            })
        return references

    @staticmethod
    def _citation_grounding_guard_issues(
        original: str,
        replacement: str,
        valid_numbers: set[int],
    ) -> list[dict[str, object]]:
        issues: list[dict[str, object]] = []
        if not replacement.strip():
            return [{"code": "empty_citation_patch", "message": "Citation patch is empty."}]
        original_number_list = CitationRepairMixin._citation_numbers_from_text(original)
        replacement_number_list = CitationRepairMixin._citation_numbers_from_text(replacement)
        original_numbers = set(original_number_list)
        replacement_numbers = set(replacement_number_list)
        if original_number_list == replacement_number_list:
            issues.append({"code": "no_citation_marker_change", "message": "Citation patch changed no citation markers."})
        invalid_numbers = sorted(number for number in replacement_numbers if number not in valid_numbers)
        if invalid_numbers:
            issues.append({
                "code": "invalid_reference_number",
                "message": "Citation patch used reference numbers not present in the bibliography.",
                "numbers": invalid_numbers,
            })
        if original_numbers and not replacement_numbers:
            issues.append({"code": "all_citations_removed", "message": "Citation patch removed all citation support."})
        original_without_citations = CitationGroundingMixin._normalize_text_without_inline_citations(original)
        replacement_without_citations = CitationGroundingMixin._normalize_text_without_inline_citations(replacement)
        if original_without_citations != replacement_without_citations:
            issues.append({
                "code": "citation_patch_changed_text",
                "message": "Citation grounding patches may only change citation markers.",
            })
        if (
            CitationGroundingMixin._paragraph_reports_own_pooled_result(original)
            and len(replacement_numbers - original_numbers) > 0
        ):
            issues.append({
                "code": "self_result_external_citation_added",
                "message": "Do not add external reference markers to this review's own pooled estimate or analysis output.",
            })
        return issues

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

    @staticmethod
    def _normalize_text_without_inline_citations(text: str) -> str:
        raw = re.sub(r"[\[［][0-9\s,，、;；\-–—至]+[\]］]", "", str(text or ""))
        raw = re.sub(r"\s+([.,;:!?。；：！？])", r"\1", raw)
        raw = re.sub(r"\s+", " ", raw)
        return raw.strip()

    def _llm_apply_final_subsection_revision(
        self,
        manuscript: str,
        facts: dict,
        review: dict,
    ) -> tuple[str, dict]:
        audit = {
            "schema_version": 1,
            "status": "skipped",
            "accepted_patches": 0,
            "rejected_patches": 0,
            "issues": [],
        }
        targets = self._final_review_subsection_targets(manuscript, review, max_targets=4)
        if not targets:
            audit["reason"] = "no_subsection_targets"
            return manuscript, audit
        prompt = self._semantic_subsection_edit_prompt(facts, targets, review)
        try:
            revision = self.call_llm_structured(
                prompt,
                SemanticSubsectionRevision,
                temperature=0.12,
                max_tokens=max(4096, min(self._writing_tokens("section"), 12000)),
            )
        except Exception as exc:
            audit.update({"status": "failed", "error": str(exc)[:500]})
            return manuscript, audit

        audit["status"] = "ok"
        audit["summary"] = revision.summary
        repaired = manuscript
        target_map = {
            (
                self._canonical_semantic_heading(str(item.get("parent_heading") or "")),
                str(item.get("subsection_heading") or "").strip().lower(),
            ): item
            for item in targets
        }
        for patch in revision.patches[:4]:
            parent = self._canonical_semantic_heading(patch.parent_heading)
            subheading = str(patch.subsection_heading or "").strip()
            target = target_map.get((parent, subheading.lower()))
            if not target:
                audit["rejected_patches"] += 1
                audit["issues"].append({
                    "code": "unsupported_subsection_patch",
                    "parent_heading": patch.parent_heading,
                    "subsection_heading": patch.subsection_heading,
                    "reason": patch.reason,
                })
                continue
            replacement = str(patch.replacement_markdown or "").strip()
            if not replacement or re.search(r"^##+\s+", replacement, flags=re.M):
                audit["rejected_patches"] += 1
                audit["issues"].append({
                    "code": "invalid_subsection_patch",
                    "parent_heading": parent,
                    "subsection_heading": subheading,
                    "reason": patch.reason,
                })
                continue
            original_body = str(target.get("body") or "").strip()
            if replacement == original_body:
                audit["issues"].append({
                    "code": "semantic_subsection_unchanged",
                    "parent_heading": parent,
                    "subsection_heading": subheading,
                    "reason": patch.reason,
                })
                continue
            guard_issues = preservation_guard_issues(original_body, replacement, f"{parent}/{subheading}")
            if guard_issues and self._semantic_guard_can_be_llm_adjudicated(guard_issues, heading=parent):
                adjudication = self._adjudicate_semantic_guard(
                    heading=f"{parent}/{subheading}",
                    original_body=original_body,
                    candidate_body=replacement,
                    guard_issues=guard_issues,
                    facts=facts,
                )
                if adjudication is not None and adjudication.accept:
                    guard_issues = []
            if guard_issues:
                audit["rejected_patches"] += 1
                audit["issues"].append({
                    "code": "semantic_subsection_guard_rejected",
                    "parent_heading": parent,
                    "subsection_heading": subheading,
                    "reason": patch.reason,
                    "guard_issues": self._semantic_guard_issue_summary(guard_issues),
                })
                continue
            repaired = self._replace_h3_subsection_body(
                repaired,
                parent_heading=parent,
                subsection_heading=subheading,
                replacement_body=replacement + "\n",
            )
            audit["accepted_patches"] += 1
            audit["issues"].append({
                "code": "semantic_subsection_accepted",
                "parent_heading": parent,
                "subsection_heading": subheading,
                "reason": patch.reason,
            })
        return repaired, audit

    def _final_review_subsection_targets(
        self,
        manuscript: str,
        review: dict,
        *,
        max_targets: int = 4,
    ) -> list[dict[str, object]]:
        issues = [
            item for item in (review.get("issues") or [])
            if isinstance(item, dict) and not item.get("requires_new_source")
        ]
        if not issues:
            return []
        targets: list[dict[str, object]] = []
        for parent in self._semantic_edit_allowed_headings():
            body = self._h2_section_body(manuscript, parent)
            if not body.strip():
                continue
            for subsection in self._h3_subsections(body):
                matched_issue = self._final_review_issue_for_subsection(parent, subsection, issues)
                if matched_issue is None:
                    continue
                targets.append({
                    "parent_heading": parent,
                    "subsection_heading": subsection["heading"],
                    "body": subsection["body"],
                    "review_issue": matched_issue,
                })
                if len(targets) >= max_targets:
                    return targets
        return targets

    def _final_review_issue_for_subsection(
        self,
        parent_heading: str,
        subsection: dict[str, str],
        issues: list[dict],
    ) -> dict | None:
        parent = self._canonical_semantic_heading(parent_heading)
        subsection_text = re.sub(r"\s+", " ", str(subsection.get("body") or "").lower())
        subheading = str(subsection.get("heading") or "").lower()
        for issue in issues:
            headings = [
                self._canonical_semantic_heading(heading)
                for heading in self._final_issue_target_headings(issue)
            ]
            if not headings:
                headings = [self._canonical_semantic_heading(str(issue.get("section") or ""))]
            if parent not in headings:
                continue
            issue_text = " ".join(str(issue.get(key) or "") for key in ("section", "problem", "evidence", "action"))
            if subheading and subheading in issue_text.lower():
                return issue
            keywords = self._clinical_review_keywords(issue_text)
            if keywords and any(keyword in subsection_text for keyword in keywords):
                return issue
        return None

    def _semantic_subsection_edit_prompt(
        self,
        facts: dict,
        targets: list[dict[str, object]],
        review: dict,
    ) -> str:
        primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
        population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
        grade = ((facts.get("grade") or {}).get("outcomes") or [{}])[0] if isinstance(facts.get("grade"), dict) else {}
        language_rule = "Chinese" if self._zh else "English"
        return (
            "You are a senior clinical manuscript editor. Rewrite only the listed H3 subsection bodies to address "
            "the attached final-review issue. This is a local subsection edit, not a full manuscript rewrite.\n\n"
            f"Write in {language_rule}. Return JSON only.\n"
            "For each patch, keep parent_heading and subsection_heading exactly as provided. Return replacement_markdown "
            "for the subsection body only; do not include the H3 heading. Preserve every number, confidence interval, "
            "citation marker, study name, drug name, outcome name, table/figure reference, and certainty rating. Do not "
            "add new claims or new sources. Consolidate repeated caveats into one cohesive paragraph when the review asks "
            "for reduced redundancy. If a subsection cannot be safely improved with existing facts and citations, omit it.\n\n"
            "When the attached issue concerns safety interpretation, distinguish clearly between the efficacy endpoint "
            "that was quantitatively pooled and safety outcomes that were not quantitatively pooled. Do not add named "
            "adverse events or trial-specific safety findings unless those facts already appear in the subsection body "
            "or structured facts.\n\n"
            "FACTS:\n"
            f"{json.dumps({'primary_effect': primary, 'primary_population': population, 'grade': grade}, ensure_ascii=False, indent=2)[:8000]}\n\n"
            "FINAL REVIEW:\n"
            f"{json.dumps(review, ensure_ascii=False, indent=2)[:10000]}\n\n"
            "TARGET SUBSECTIONS:\n"
            f"{json.dumps(targets, ensure_ascii=False, indent=2)[:18000]}"
        )

    @staticmethod
    def _h3_subsections(h2_body: str) -> list[dict[str, str]]:
        text = str(h2_body or "")
        matches = list(re.finditer(r"^###\s+(.+?)\s*$", text, flags=re.M))
        subsections: list[dict[str, str]] = []
        for index, match in enumerate(matches):
            start = match.end()
            end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            subsections.append({"heading": match.group(1).strip(), "body": text[start:end].strip()})
        return subsections

    @staticmethod
    def _replace_h3_subsection_body(
        manuscript: str,
        *,
        parent_heading: str,
        subsection_heading: str,
        replacement_body: str,
    ) -> str:
        parent_body = SemanticReviewMixin._h2_section_body(manuscript, parent_heading)
        if not parent_body:
            return manuscript
        pattern = re.compile(rf"^###\s+{re.escape(subsection_heading)}\s*$", flags=re.M)
        match = pattern.search(parent_body)
        if not match:
            return manuscript
        next_match = re.search(r"^###\s+", parent_body[match.end():], flags=re.M)
        end = match.end() + next_match.start() if next_match else len(parent_body)
        new_parent_body = (
            parent_body[:match.end()]
            + "\n\n"
            + str(replacement_body or "").strip()
            + "\n\n"
            + parent_body[end:].lstrip("\n")
        )
        new_parent_body = re.sub(
            rf"(^###\s+{re.escape(subsection_heading)}\s*)\n{{3,}}",
            r"\1\n\n",
            new_parent_body,
            flags=re.M,
        )
        return SemanticReviewMixin._replace_h2_section_body(manuscript, parent_heading, new_parent_body + "\n")

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
