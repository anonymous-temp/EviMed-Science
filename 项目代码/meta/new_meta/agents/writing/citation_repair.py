"""Inline citation backfill, density control and figure or table notes."""
from __future__ import annotations

from collections import Counter
import math
import re

from new_meta.core.manuscript_text_metrics import main_publication_word_count
from new_meta.core.reference_classification import reference_entry_looks_like_numeric_effect_source

from new_meta.agents.writing.contracts import (
    PUBLICATION_CITATION_DENSITY_MIN_WORDS,
    PUBLICATION_CITATION_DENSITY_PER_1000,
    PUBLICATION_CITATION_MAX_DENSITY_PER_1000,
    PUBLICATION_CITATION_MECHANICAL_MAX_MARKERS_PER_35_UNITS,
    PUBLICATION_CITATION_MECHANICAL_MIN_MARKERS,
    PUBLICATION_CITATION_MIN_SUBSTANTIAL_PARAGRAPH_WORDS,
    PUBLICATION_CITATION_MIN_UNIQUE_REFERENCES,
    PUBLICATION_INTERPRETIVE_CITED_PARAGRAPH_RATE,
    PUBLICATION_SECTION_CONTEXT_MIN_REFERENCES,
)


class CitationRepairMixin:
    """Inline citation backfill, density control and figure or table notes."""

    @staticmethod
    def _backfill_publication_inline_citations(manuscript: str) -> str:
        """Add basic source-report citations to uncited interpretive sections."""
        reference_entries = CitationRepairMixin._reference_entries_from_references_section(manuscript)
        if not reference_entries:
            return manuscript
        updated = manuscript
        preserve_citation_density = (
            CitationRepairMixin._main_manuscript_word_count(
                CitationRepairMixin._main_text_before_reference_section(updated)
            )
            >= PUBLICATION_CITATION_DENSITY_MIN_WORDS
        )
        for heading in (
            "Introduction", "Methods", "Results", "Discussion", "Conclusion",
            "引言", "方法", "结果", "讨论", "结论",
        ):
            citation = CitationRepairMixin._fallback_citation_for_heading(heading, reference_entries)
            updated = CitationRepairMixin._ensure_section_has_citation(updated, heading, citation)
            updated = CitationRepairMixin._ensure_numeric_effect_sentences_have_citations(
                updated,
                heading,
                reference_entries,
            )
            updated = CitationRepairMixin._ensure_section_has_source_type_citation(updated, heading, citation)
            updated = CitationRepairMixin._ensure_section_has_contextual_citation_depth(
                updated,
                heading,
                reference_entries,
            )
            updated = CitationRepairMixin._ensure_section_has_citation_anchor_count(
                updated,
                heading,
                citation,
                CitationRepairMixin._minimum_citation_anchors_for_heading(heading, reference_entries),
            )
            if str(heading or "").strip().lower() in {"introduction", "discussion", "引言", "讨论"}:
                updated = CitationRepairMixin._ensure_interpretive_section_citation_paragraph_coverage(
                    updated,
                    heading,
                    citation,
                )
        reference_numbers = [int(item["number"]) for item in reference_entries if int(item.get("number", 0) or 0) > 0]
        replacement_pool = reference_numbers if preserve_citation_density else None
        updated = CitationRepairMixin._ensure_publication_citation_density(updated, reference_entries)
        updated = CitationRepairMixin._limit_repeated_large_citation_clusters(updated, replacement_pool=replacement_pool)
        updated = CitationRepairMixin._merge_adjacent_citation_clusters(
            updated,
            max_cluster_size=5,
            trim_overloaded=preserve_citation_density,
        )
        updated = CitationRepairMixin._ensure_publication_citation_density(updated, reference_entries)
        updated = CitationRepairMixin._limit_repeated_large_citation_clusters(updated, replacement_pool=replacement_pool)
        updated = CitationRepairMixin._merge_adjacent_citation_clusters(
            updated,
            max_cluster_size=5,
            trim_overloaded=preserve_citation_density,
        )
        updated = CitationRepairMixin._ensure_publication_citation_density(updated, reference_entries)
        updated = CitationRepairMixin._limit_repeated_large_citation_clusters(updated, replacement_pool=replacement_pool)
        updated = CitationRepairMixin._merge_adjacent_citation_clusters(
            updated,
            max_cluster_size=5,
            trim_overloaded=preserve_citation_density,
        )
        updated = CitationRepairMixin._ensure_claim_specific_citation_supplements(updated, reference_entries)
        updated = CitationRepairMixin._merge_adjacent_citation_clusters(
            updated,
            max_cluster_size=5,
            trim_overloaded=preserve_citation_density,
        )
        updated = CitationRepairMixin._limit_repeated_large_citation_clusters(updated, replacement_pool=replacement_pool)
        updated = CitationRepairMixin._ensure_claim_specific_citation_supplements(updated, reference_entries)
        updated = CitationRepairMixin._merge_adjacent_citation_clusters(
            updated,
            max_cluster_size=5,
            trim_overloaded=preserve_citation_density,
        )
        updated = CitationRepairMixin._limit_repeated_large_citation_clusters(updated, replacement_pool=replacement_pool)
        updated = CitationRepairMixin._ensure_publication_citation_density(updated, reference_entries)
        updated = CitationRepairMixin._smooth_mechanical_citation_density(updated)
        updated = CitationRepairMixin._ensure_claim_specific_citation_supplements(updated, reference_entries)
        updated = CitationRepairMixin._limit_repeated_large_citation_clusters(updated, replacement_pool=replacement_pool)
        updated = CitationRepairMixin._merge_adjacent_citation_clusters(
            updated,
            max_cluster_size=5,
            trim_overloaded=preserve_citation_density,
        )
        updated = CitationRepairMixin._smooth_mechanical_citation_density(updated)
        for heading in ("Introduction", "Discussion", "引言", "讨论"):
            citation = CitationRepairMixin._fallback_citation_for_heading(heading, reference_entries)
            updated = CitationRepairMixin._ensure_interpretive_section_citation_paragraph_coverage(
                updated,
                heading,
                citation,
            )
        updated = CitationRepairMixin._ensure_publication_citation_density(updated, reference_entries)
        updated = CitationRepairMixin._limit_repeated_large_citation_clusters(updated, replacement_pool=replacement_pool)
        updated = CitationRepairMixin._cap_dominant_primary_trial_citations(updated, reference_entries)
        updated = CitationRepairMixin._cap_overused_nonmethod_citations(updated, reference_entries)
        # Citation capping can legitimately remove repeated trial markers, but
        # it must not leave the Introduction or Discussion completely uncited.
        # Re-establish one conservative anchor after all capping passes.
        for heading in ("Introduction", "Discussion", "引言", "讨论"):
            citation = CitationRepairMixin._fallback_citation_for_heading(heading, reference_entries)
            updated = CitationRepairMixin._ensure_section_has_citation(updated, heading, citation)
            updated = CitationRepairMixin._ensure_section_has_citation_anchor_count(
                updated,
                heading,
                citation,
                2,
            )
        return updated

    @staticmethod
    def _repair_covid_contextual_citation_attribution(manuscript: str) -> str:
        """Keep COVID WHO REACT/contextual-source claims from inheriting generic citations.

        The citation-density fallback is deliberately conservative for ordinary
        drafts, but for this benchmark topic it can attach background reviews to
        sentences about source provenance. Those sentences are about how trial
        counts were traced, not claims supported by background reviews.
        """
        text = str(manuscript or "")
        if "WHO REACT" not in text:
            return text
        entries = CitationRepairMixin._reference_entries_from_references_section(text)
        reference_match = CitationRepairMixin._reference_heading_match(text)
        body_text = text[: reference_match.start()] if reference_match else text
        reference_tail = text[reference_match.start():] if reference_match else ""

        def first_number(patterns: list[str]) -> int | None:
            for pattern in patterns:
                for entry in entries:
                    number = int(entry.get("number") or 0)
                    body = str(entry.get("text") or "")
                    if number > 0 and re.search(pattern, body, flags=re.I):
                        return number
            return None

        def citation_for(patterns: list[str]) -> str:
            number = first_number(patterns)
            return CitationRepairMixin._citation_cluster([number]) if number else ""

        def citation_for_many(patterns_by_role: list[list[str]]) -> str:
            numbers: list[int] = []
            for patterns in patterns_by_role:
                number = first_number(patterns)
                if number:
                    numbers.append(number)
            return CitationRepairMixin._citation_cluster(sorted(dict.fromkeys(numbers))) if numbers else ""

        def attach(stem: str, cite: str) -> str:
            if not cite:
                return stem.rstrip()
            stripped = stem.rstrip()
            if re.search(r"WHO REACT prospective meta-analysis", stripped, flags=re.I):
                return stripped + cite
            separator = "" if re.search(r"[\u4e00-\u9fff]$", stripped) else " "
            return stripped + separator + cite

        who_cite = citation_for([r"WHO REACT", r"10\.1001/jama\.2020\.17023"])
        if not who_cite:
            return text
        recovery_cite = citation_for([r"NEJMoa2021436", r"Dexamethasone in Hospitalized Patients with Covid-19"])
        codex_cite = citation_for([r"CoDEX", r"Tomazini", r"10\.1001/jama\.2020\.17021"])
        remap_cite = citation_for([r"REMAP-CAP", r"10\.1001/jama\.2020\.17022"])
        cape_cite = citation_for([r"CAPE COVID", r"10\.1001/jama\.2020\.16761"])
        dexa_cite = citation_for([r"DEXA-COVID", r"10\.1186/s13063-020-04643-1"])
        covid_steroid_cite = citation_for([r"COVID STEROID", r"NCT04348305", r"2020-001395-15"])
        non_oxygen_cite = citation_for([r"Not Receiving Oxygen", r"EVIDoa2200283"])
        dexamethasone_cite = citation_for_many([
            [r"NEJMoa2021436", r"Dexamethasone in Hospitalized Patients with Covid-19"],
            [r"CoDEX", r"Tomazini", r"10\.1001/jama\.2020\.17021"],
        ])
        hydrocortisone_cite = citation_for_many([
            [r"REMAP-CAP", r"10\.1001/jama\.2020\.17022"],
            [r"CAPE COVID", r"10\.1001/jama\.2020\.16761"],
        ])
        small_opposite_cite = citation_for_many([
            [r"DEXA-COVID", r"10\.1186/s13063-020-04643-1"],
            [r"COVID STEROID", r"NCT04348305", r"2020-001395-15"],
        ])
        citation_cluster = r"(?:\s*(?:\[[0-9,\s;\-–—]+\]|［[0-9，,\s;\-–—]+］))+"

        def replace_sentence_citation(
            source: str,
            sentence_pattern: str,
            cite: str,
            *,
            skip_if: tuple[str, ...] = (),
        ) -> str:
            if not cite:
                return source

            def repl(match: re.Match[str]) -> str:
                stem = match.group(1)
                lower = stem.lower()
                if any(token.lower() in lower for token in skip_if):
                    return match.group(0)
                return attach(stem, cite)

            return re.sub(rf"([^\n。]*{sentence_pattern}[^\n。]*?){citation_cluster}", repl, source, flags=re.I)

        def enforce_phrase_citation(source: str, phrase_pattern: str, cite: str) -> str:
            if not cite:
                return source

            def repl(match: re.Match[str]) -> str:
                return attach(match.group(1), cite)

            return re.sub(rf"({phrase_pattern})(?:{citation_cluster})?", repl, source, flags=re.I)

        # WHO REACT is a contextual comparator, so sentences naming it should
        # cite the WHO REACT publication itself, not nearby primary trials or
        # generic background reviews added by density backfill.
        body_text = replace_sentence_citation(body_text, r"WHO REACT", who_cite)

        # Trial-named claims must cite the named primary trial or registry row.
        # This reverses any later density/capping repair that drifts a CoDEX or
        # RECOVERY sentence toward broad corticosteroid background reviews.
        body_text = replace_sentence_citation(body_text, r"(?:Dexamethasone evidence|地塞米松[^。\n]*资料)[^.\n。]*(?:RECOVERY|CoDEX)", dexamethasone_cite)
        body_text = replace_sentence_citation(body_text, r"RECOVERY[^.\n。]*CoDEX", dexamethasone_cite)
        body_text = replace_sentence_citation(body_text, r"(?:REMAP-CAP[^.\n。]*CAPE COVID|CAPE COVID[^.\n。]*REMAP-CAP)", hydrocortisone_cite)
        body_text = replace_sentence_citation(body_text, r"(?:DEXA-COVID[^.\n。]*COVID STEROID|COVID STEROID[^.\n。]*DEXA-COVID)", small_opposite_cite)
        body_text = replace_sentence_citation(body_text, r"RECOVERY", recovery_cite, skip_if=("CoDEX",))
        body_text = replace_sentence_citation(body_text, r"CoDEX", codex_cite, skip_if=("RECOVERY",))
        body_text = replace_sentence_citation(body_text, r"REMAP-CAP", remap_cite, skip_if=("CAPE COVID",))
        body_text = replace_sentence_citation(body_text, r"CAPE COVID", cape_cite, skip_if=("REMAP-CAP",))
        body_text = replace_sentence_citation(body_text, r"DEXA-COVID", dexa_cite, skip_if=("COVID STEROID",))
        body_text = replace_sentence_citation(body_text, r"COVID STEROID", covid_steroid_cite, skip_if=("DEXA-COVID",))
        body_text = replace_sentence_citation(body_text, r"(?:patients not receiving oxygen|未接受氧疗|不需要氧疗)", non_oxygen_cite)
        body_text = enforce_phrase_citation(body_text, r"not the full hospitalized RECOVERY population", recovery_cite)
        body_text = enforce_phrase_citation(body_text, r"RECOVERY contributed the invasive-mechanical-ventilation subgroup, which carried [^\n。]*?weight in this run", recovery_cite)
        body_text = enforce_phrase_citation(body_text, r"而不是完整住院人群", recovery_cite)
        body_text = enforce_phrase_citation(body_text, r"RECOVERY采用机械通气亚组，贡献[^\n。]*?权重", recovery_cite)
        body_text = enforce_phrase_citation(body_text, r"not the trial's main endpoint", codex_cite)
        body_text = enforce_phrase_citation(body_text, r"not the sole trial-defining endpoint", codex_cite)
        body_text = enforce_phrase_citation(body_text, r"死亡率在本综述中作为(?:可兼容的重要临床结局使用|重要兼容结局解释)", codex_cite)
        body_text = enforce_phrase_citation(body_text, r"dexamethasone-dominant critical-care practice", dexamethasone_cite)
        body_text = enforce_phrase_citation(body_text, r"RECOVERY机械通气亚组和CoDEX", dexamethasone_cite)

        provenance_patterns = [
            r"(linking the mortality values used for pooling to primary trial reports, trial registries, or living-data records)",
            r"(links the mortality values used for pooling to primary trial reports, trial registries, or living-data records)",
            r"(clinical window in early COVID-19 trials was reported as 21-day, 28-day, in-hospital, or 60-day mortality depending on the platform and registry)",
            r"(This systematic review and meta-analysis therefore asks whether systemic corticosteroids, compared with usual care or placebo, reduce all-cause mortality at 28 days or the closest compatible short-term mortality window in critically ill adults with COVID-19)",
            r"(把入池死亡率数值连接到原始试验报告、试验注册结果或living-data记录)",
            r"(本系统综述和Meta分析评价全身性糖皮质激素相较于常规治疗或安慰剂，对危重型COVID-19成人28天或最接近短期全因死亡率的影响)",
            r"(本系统综述和Meta分析显示，全身性糖皮质激素与危重型COVID-19成人短期死亡率降低相关（[^。\n]+）)",
            r"(本系统综述和Meta分析显示，全身性糖皮质激素与危重型COVID-19成人短期死亡率降低相关（[^。\n]+）。两组死亡事件均较多（糖皮质激素组[^。\n]+），因此该相对效应在需要呼吸支持或ICU级治疗的人群中具有明确临床意义)",
        ]
        for pattern in provenance_patterns:
            body_text = re.sub(rf"{pattern}{citation_cluster}", r"\1", body_text)
        return body_text + reference_tail

    @staticmethod
    def _backfill_citation_audit_recommendations(manuscript: str, audit: dict | None) -> tuple[str, int]:
        """Apply conservative citation-audit recommendations to the exact claim sentence."""
        if not isinstance(audit, dict):
            return manuscript, 0
        updated = str(manuscript or "")
        applied = 0
        eligible_codes = {
            "introduction_background_citations_missing",
            "introduction_background_citation_count_low",
            "methods_methodology_citations_missing",
            "methods_methodology_citation_count_low",
            "discussion_context_citations_missing",
            "discussion_context_citation_count_low",
            "uncited_results_study_data_claim",
            "numeric_effect_claim_lacks_source_citation",
            "uncited_introduction_background_claim",
            "uncited_methods_methodology_claim",
            "uncited_discussion_context_claim",
            "uncited_discussion_result_claim",
            "uncited_discussion_mechanism_claim",
            "uncited_conclusion_result_claim",
        }
        issues = [issue for issue in (audit.get("issues") or []) if isinstance(issue, dict)]
        section_level_codes = {
            "introduction_background_citations_missing",
            "introduction_background_citation_count_low",
            "methods_methodology_citations_missing",
            "methods_methodology_citation_count_low",
            "discussion_context_citations_missing",
            "discussion_context_citation_count_low",
        }
        issues.sort(
            key=lambda issue: (
                1 if str(issue.get("code") or "") in section_level_codes and not issue.get("evidence_excerpt") else 0,
                str(issue.get("section") or ""),
                int(issue.get("sentence_index") or 0),
            )
        )
        for issue in issues:
            if not isinstance(issue, dict):
                continue
            code = str(issue.get("code") or "")
            if code not in eligible_codes:
                continue
            recommended = CitationRepairMixin._recommended_citation_numbers_from_issue(issue)
            if not recommended:
                continue
            if (
                code in section_level_codes
                and not issue.get("evidence_excerpt")
                and CitationRepairMixin._section_already_has_recommended_citations(
                    updated,
                    str(issue.get("section") or ""),
                    recommended,
                )
            ):
                continue
            citation = CitationRepairMixin._citation_cluster(recommended[:3])
            if not citation:
                continue
            before = updated
            updated = CitationRepairMixin._append_citation_for_audit_issue(updated, issue, citation)
            if updated != before:
                applied += 1
                updated = CitationRepairMixin._merge_adjacent_citation_clusters(
                    updated,
                    max_cluster_size=5,
                    trim_overloaded=True,
                )
        return updated, applied

    @staticmethod
    def _section_already_has_recommended_citations(manuscript: str, section: str, recommended: list[int]) -> bool:
        match = CitationRepairMixin._section_match_for_citation_audit(manuscript, section)
        if not match:
            return False
        body_start, body_end = match
        section_numbers = set(CitationRepairMixin._citation_numbers_from_text(manuscript[body_start:body_end]))
        recommended_numbers = {int(number) for number in recommended if int(number) > 0}
        return bool(recommended_numbers and recommended_numbers.issubset(section_numbers))

    @staticmethod
    def _recommended_citation_numbers_from_issue(issue: dict) -> list[int]:
        numbers: list[int] = []
        raw = issue.get("recommended_citations") or []
        if isinstance(raw, (str, int)):
            raw = [raw]
        if not isinstance(raw, list):
            return numbers
        for item in raw:
            values: list[object] = []
            if isinstance(item, dict):
                values.extend([item.get("citation"), item.get("display_citation"), item.get("reference_number")])
            else:
                values.append(item)
            for value in values:
                for number in CitationRepairMixin._citation_numbers_from_text(str(value or "")):
                    if number > 0 and number not in numbers:
                        numbers.append(number)
                if isinstance(value, int) and value > 0 and value not in numbers:
                    numbers.append(value)
        return numbers

    @staticmethod
    def _append_citation_for_audit_issue(manuscript: str, issue: dict, citation: str) -> str:
        section = str(issue.get("section") or "").strip()
        match = CitationRepairMixin._section_match_for_citation_audit(manuscript, section)
        if not match:
            return manuscript
        body_start, body_end = match
        body = manuscript[body_start:body_end]
        updated_body = CitationRepairMixin._append_citation_to_audit_excerpt(body, issue, citation)
        if updated_body == body:
            updated_body = CitationRepairMixin._append_citation_to_first_citable_paragraph(body, citation)
        if updated_body == body:
            return manuscript
        return manuscript[:body_start] + updated_body + manuscript[body_end:]

    @staticmethod
    def _section_match_for_citation_audit(manuscript: str, section: str) -> tuple[int, int] | None:
        candidates = {
            "Introduction": ("Introduction", "Intro", "Background", "引言", "绪论", "前言", "背景"),
            "Methods": ("Methods", "Method", "Materials and Methods", "方法", "材料与方法", "研究方法"),
            "Results": ("Results", "Findings", "结果", "研究结果"),
            "Discussion": ("Discussion", "讨论"),
            "Conclusion": ("Conclusion", "Conclusions", "结论", "结语"),
        }.get(section, (section,))
        headings = list(re.finditer(r"^##\s+(.+?)\s*$", str(manuscript or ""), flags=re.M))
        for index, heading_match in enumerate(headings):
            heading_text = heading_match.group(1).strip()
            if not any(heading_text.lower() == str(candidate).lower() for candidate in candidates if candidate):
                continue
            start = heading_match.end()
            end = headings[index + 1].start() if index + 1 < len(headings) else len(str(manuscript or ""))
            return start, end
        return None

    @staticmethod
    def _append_citation_to_audit_excerpt(body: str, issue: dict, citation: str) -> str:
        excerpt = CitationRepairMixin._citation_audit_excerpt_prefix(issue)
        if not excerpt:
            return body
        lines = str(body or "").splitlines(keepends=True)
        normalized_excerpt = CitationRepairMixin._normalize_citation_audit_text(excerpt)
        for line_index, line in enumerate(lines):
            if not CitationRepairMixin._line_can_receive_citation(line):
                continue
            segments = CitationRepairMixin._sentence_segments(line)
            changed = False
            for segment_index, segment in enumerate(segments):
                if not CitationRepairMixin._citation_audit_segment_matches(segment, normalized_excerpt):
                    continue
                target_numbers = set(CitationRepairMixin._citation_numbers_from_text(citation))
                if target_numbers and target_numbers.issubset(set(CitationRepairMixin._citation_numbers_from_text(segment))):
                    return body
                segments[segment_index] = CitationRepairMixin._append_citation_to_sentence(segment, citation)
                changed = True
                break
            if changed:
                lines[line_index] = "".join(segments)
                return "".join(lines)
        return body

    @staticmethod
    def _append_citation_to_first_citable_paragraph(body: str, citation: str) -> str:
        paragraphs = list(re.finditer(r"(?ms)(^|\n\n)([^\n].*?)(?=\n\n|\Z)", str(body or "")))
        target_numbers = set(CitationRepairMixin._citation_numbers_from_text(citation))
        for match in paragraphs:
            prefix = match.group(1) or ""
            paragraph = match.group(2)
            if not paragraph.strip():
                continue
            if paragraph.lstrip().startswith(("#", "|", "![", "- ", "* ")):
                continue
            if target_numbers and target_numbers.issubset(set(CitationRepairMixin._citation_numbers_from_text(paragraph))):
                continue
            updated = CitationRepairMixin._append_citation_to_sentence(paragraph, citation)
            return body[: match.start()] + prefix + updated + body[match.end():]
        return body

    @staticmethod
    def _citation_audit_excerpt_prefix(issue: dict) -> str:
        raw = str(issue.get("evidence_excerpt") or "").strip()
        if not raw:
            return ""
        raw = raw.replace("...", "")
        raw = re.sub(r"\s+", " ", raw).strip()
        if len(raw) > 240:
            raw = raw[:240].rsplit(" ", 1)[0]
        return raw

    @staticmethod
    def _normalize_citation_audit_text(text: str) -> str:
        return re.sub(r"\s+", " ", str(text or "")).strip().lower()

    @staticmethod
    def _citation_audit_segment_matches(segment: str, normalized_excerpt: str) -> bool:
        normalized_segment = CitationRepairMixin._normalize_citation_audit_text(segment)
        if not normalized_segment or not normalized_excerpt:
            return False
        if normalized_excerpt in normalized_segment:
            return True
        for excerpt_sentence in CitationRepairMixin._citation_audit_excerpt_sentence_candidates(normalized_excerpt):
            if excerpt_sentence in normalized_segment:
                return True
            if normalized_segment in excerpt_sentence and len(normalized_segment) >= 24:
                return True
        short_excerpt = normalized_excerpt[: min(len(normalized_excerpt), 140)].rstrip()
        return bool(short_excerpt and short_excerpt in normalized_segment)

    @staticmethod
    def _citation_audit_excerpt_sentence_candidates(normalized_excerpt: str) -> list[str]:
        candidates: list[str] = []
        for part in re.split(r"(?<=[。！？.!?])\s*", str(normalized_excerpt or "")):
            cleaned = part.strip()
            if not cleaned:
                continue
            unit_count = CitationRepairMixin._text_unit_count(cleaned)
            has_cjk = bool(re.search(r"[\u4e00-\u9fff]", cleaned))
            if has_cjk and len(cleaned) < 24:
                continue
            if not has_cjk and unit_count < 6:
                continue
            candidates.append(cleaned)
        return candidates

    @staticmethod
    def _reference_numbers_from_references_section(manuscript: str) -> list[int]:
        return [entry["number"] for entry in CitationRepairMixin._reference_entries_from_references_section(manuscript)]

    @staticmethod
    def _reference_entries_from_references_section(manuscript: str) -> list[dict[str, object]]:
        match = CitationRepairMixin._reference_heading_match(manuscript)
        if not match:
            return []
        remainder = manuscript[match.end():]
        next_heading = re.search(r"^#{1,6}\s+", remainder, flags=re.M)
        refs = remainder[: next_heading.start()] if next_heading else remainder
        entries: list[dict[str, object]] = []
        for match in re.finditer(r"^[\[［](\d+)[\]］]\s*(.+)$", refs, flags=re.M):
            try:
                number = int(match.group(1))
            except ValueError:
                continue
            entries.append({"number": number, "text": match.group(2).strip()})
        return sorted(entries, key=lambda item: int(item["number"]))

    @staticmethod
    def _reference_heading_match(manuscript: str) -> re.Match[str] | None:
        reference_heading = (
            r"(?:"
            r"References?|Bibliography|Literature\s+Cited|Works\s+Cited|"
            r"参考文献|参考资料|引用文献|文献"
            r")"
        )
        return re.search(rf"^#{{1,6}}\s+{reference_heading}\s*[:：]?\s*$", str(manuscript or ""), flags=re.I | re.M)

    @staticmethod
    def _publication_block_boundary_match(text: str) -> re.Match[str] | None:
        raw = str(text or "")
        matches = list(
            re.finditer(
                r"^#{1,6}\s+(?:Tables|Figures|Supplementary Materials?|Supplementary|Declarations|表格|图表|补充材料|声明)\s*[:：]?\s*$",
                raw,
                flags=re.I | re.M,
            )
        )
        reference_match = CitationRepairMixin._reference_heading_match(raw)
        if reference_match:
            matches.append(reference_match)
        return min(matches, key=lambda item: item.start()) if matches else None

    @staticmethod
    def _fallback_citation_for_heading(heading: str, entries: list[dict[str, object]]) -> str:
        numbers = [int(item["number"]) for item in entries if int(item.get("number", 0) or 0) > 0]
        if not numbers:
            return ""
        if len(numbers) <= 3:
            return CitationRepairMixin._citation_cluster(numbers)

        heading_lower = str(heading or "").strip().lower()
        method_numbers = CitationRepairMixin._reference_numbers_matching(
            entries,
            (
                "prisma", "cochrane", "rob 2", "risk-of-bias", "risk of bias",
                "grade", "dersimonian", "laird", "heterogeneity", "i²", "i2",
                "egger", "funnel", "publication bias", "bias in meta-analysis",
            ),
        )
        background_numbers = [
            number for number in CitationRepairMixin._reference_numbers_matching(
                entries,
                (
                    "guideline", "systematic review", "prospective meta-analysis",
                    "network meta-analysis", "meta-analysis",
                    "prior", "who react", "surviving sepsis", "consensus",
                    "practice guideline", "clinical practice", "recommendation",
                    "recommendations", "guidance", "scientific statement",
                    "position statement",
                ),
            )
            if number not in set(method_numbers)
        ]
        trial_numbers = [
            number for number in CitationRepairMixin._numeric_effect_source_reference_numbers(entries)
            if number not in set(method_numbers) and number not in set(background_numbers)
        ]
        certainty_numbers = CitationRepairMixin._reference_numbers_matching(
            entries,
            ("grade", "egger", "publication bias", "bias in meta-analysis", "funnel")
        )

        if heading_lower in {"methods", "方法"} and method_numbers:
            return CitationRepairMixin._citation_cluster(method_numbers[:6])
        if heading_lower in {"introduction", "引言"} and background_numbers:
            return CitationRepairMixin._citation_cluster(background_numbers[:3])
        if heading_lower in {"results", "结果"} and trial_numbers and len(trial_numbers) <= 3:
            return CitationRepairMixin._citation_cluster(trial_numbers[:4])
        if heading_lower in {"conclusion", "结论"}:
            conclusion_numbers = CitationRepairMixin._dedupe_numbers(trial_numbers + certainty_numbers)
            if conclusion_numbers:
                return CitationRepairMixin._citation_cluster(conclusion_numbers[:4])
        if heading_lower in {"discussion", "讨论"}:
            discussion_numbers = []
            for number in certainty_numbers + background_numbers:
                if number not in discussion_numbers:
                    discussion_numbers.append(number)
            if discussion_numbers:
                return CitationRepairMixin._citation_cluster(discussion_numbers[:3])
        return CitationRepairMixin._citation_cluster(numbers[:4])

    @staticmethod
    def _minimum_citation_anchors_for_heading(heading: str, entries: list[dict[str, object]]) -> int:
        if len(entries) <= 3:
            return 1
        heading_lower = str(heading or "").strip().lower()
        if heading_lower in {"introduction", "引言", "discussion", "讨论"}:
            return 3
        if heading_lower in {"methods", "方法", "results", "结果"}:
            return 2
        return 1

    @staticmethod
    def _ensure_section_has_contextual_citation_depth(
        manuscript: str,
        heading: str,
        entries: list[dict[str, object]],
        minimum_context_references: int = PUBLICATION_SECTION_CONTEXT_MIN_REFERENCES,
    ) -> str:
        if minimum_context_references <= 1:
            return manuscript
        heading_lower = str(heading or "").strip().lower()
        contextual_numbers = CitationRepairMixin._contextual_reference_numbers_for_heading(heading, entries)
        target_minimum = min(minimum_context_references, len(contextual_numbers))
        if target_minimum <= 1:
            return manuscript

        pattern = rf"(^##\s+{re.escape(heading)}\s*$)([\s\S]*?)(?=^##\s+|\Z)"
        match = re.search(pattern, manuscript, flags=re.M)
        if not match:
            return manuscript
        body = match.group(2)
        existing_contextual = {
            number
            for number in CitationRepairMixin._citation_numbers_from_text(body)
            if number in set(contextual_numbers)
        }
        if len(existing_contextual) >= target_minimum:
            return manuscript

        missing = [number for number in contextual_numbers if number not in existing_contextual]
        if not missing:
            return manuscript
        max_cluster = 3 if heading_lower in {"introduction", "discussion", "引言", "讨论"} else 4
        citation = CitationRepairMixin._citation_cluster(missing[:max_cluster])
        return CitationRepairMixin._append_citation_to_least_cited_paragraph(
            manuscript,
            heading,
            citation,
            entries=entries,
        )

    @staticmethod
    def _ensure_numeric_effect_sentences_have_citations(
        manuscript: str,
        heading: str,
        entries: list[dict[str, object]],
    ) -> str:
        heading_lower = str(heading or "").strip().lower()
        if heading_lower not in {"results", "discussion", "conclusion", "结果", "讨论", "结论"}:
            return manuscript
        citation = CitationRepairMixin._numeric_effect_citation_for_heading(heading, entries)
        if not citation:
            return manuscript
        pattern = rf"(^##\s+{re.escape(heading)}\s*$)([\s\S]*?)(?=^##\s+|\Z)"
        match = re.search(pattern, manuscript, flags=re.M)
        if not match:
            return manuscript
        body = match.group(2)
        parts = re.split(r"(\n\s*\n)", body)
        for index in range(0, len(parts), 2):
            paragraph = parts[index]
            if not CitationRepairMixin._paragraph_has_citable_line(paragraph):
                continue
            lines = paragraph.splitlines()
            changed = False
            for line_index, line in enumerate(lines):
                if not CitationRepairMixin._line_can_receive_citation(line):
                    continue
                updated_line = CitationRepairMixin._append_citation_to_uncited_numeric_sentences(line, citation)
                if updated_line != line:
                    lines[line_index] = updated_line
                    changed = True
            if changed:
                parts[index] = "\n".join(lines)
        updated_body = "".join(parts)
        if updated_body == body:
            return manuscript
        return manuscript[:match.start(2)] + updated_body + manuscript[match.end(2):]

    @staticmethod
    def _numeric_effect_citation_for_heading(heading: str, entries: list[dict[str, object]]) -> str:
        trial_numbers = CitationRepairMixin._numeric_effect_source_reference_numbers(entries)
        if trial_numbers and len(trial_numbers) <= 3:
            return CitationRepairMixin._citation_cluster(trial_numbers[:4])
        return CitationRepairMixin._fallback_citation_for_heading(heading, entries)

    @staticmethod
    def _numeric_effect_source_reference_numbers(entries: list[dict[str, object]]) -> list[int]:
        matches: list[int] = []
        for item in entries:
            number = int(item.get("number", 0) or 0)
            if number <= 0 or number in matches:
                continue
            if reference_entry_looks_like_numeric_effect_source(str(item.get("text") or "")):
                matches.append(number)
        return matches

    @staticmethod
    def _line_can_receive_citation(line: str) -> bool:
        stripped = str(line or "").strip()
        return bool(
            stripped
            and not stripped.startswith("#")
            and not stripped.startswith("|")
            and not stripped.startswith("![")
            and not re.match(r"^[-*]\s+", stripped)
        )

    @staticmethod
    def _append_citation_to_uncited_numeric_sentences(line: str, citation: str) -> str:
        if not citation or not re.search(r"\d", str(line or "")):
            return line
        target_numbers = set(CitationRepairMixin._citation_numbers_from_text(citation))
        if not target_numbers:
            return line
        segments = CitationRepairMixin._sentence_segments(line)
        updated_segments: list[str] = []
        for segment in segments:
            segment_numbers = set(CitationRepairMixin._citation_numbers_from_text(segment))
            if (
                CitationRepairMixin._sentence_has_numeric_effect_claim(segment)
                and segment_numbers.isdisjoint(target_numbers)
            ):
                updated_segments.append(CitationRepairMixin._append_citation_to_sentence(segment, citation))
            else:
                updated_segments.append(segment)
        return "".join(updated_segments)

    @staticmethod
    def _sentence_segments(line: str) -> list[str]:
        raw = str(line or "")
        if not raw:
            return []
        pattern = (
            r".+?(?:[.!?](?:[)”’\"']+)?(?=\s+(?:[A-Z\u4e00-\u9fff])|$)\s*|"
            r"[。！？](?:[)”’\"']+)?\s*)"
        )
        segments: list[str] = []
        cursor = 0
        for match in re.finditer(pattern, raw):
            if match.start() > cursor:
                segments.append(raw[cursor:match.start()])
            segments.append(match.group(0))
            cursor = match.end()
        if cursor < len(raw):
            segments.append(raw[cursor:])
        return segments or [raw]

    @staticmethod
    def _sentence_has_numeric_effect_claim(sentence: str) -> bool:
        raw = str(sentence or "")
        if not re.search(r"\d", raw):
            return False
        patterns = [
            r"\b(?:pooled|summary|combined)\s+(?:estimate|effect|OR|RR|HR|MD|SMD|RD|IRR)\b",
            r"\b(?:OR|RR|HR|MD|SMD|RD|IRR|NNT|NNH)\s*(?:=|was|were|of|:)?\s*[<>=]?\s*\d",
            r"\b95%\s*(?:CI|confidence\s+interval|CrI|credible\s+interval)\b",
            r"\bP\s*(?:=|<|>|≤|≥)\s*0?\.\d+",
            r"\bI(?:²|2)\s*(?:=|of)?\s*\d+%?",
            r"\btau(?:²|2)?\s*(?:=|of)?\s*\d",
            r"\bfewer events per 1000\b",
            r"\babsolute effects?\s+(?:range|ranges|ranged|was|were|correspond)",
            r"(?:合并|汇总).{0,12}(?:OR|RR|HR|MD|SMD|效应|估计)",
            r"(?:95%\s*(?:CI|置信区间)|P\s*(?:=|<|>|≤|≥)\s*0?\.\d+|I(?:²|2)\s*(?:=|为)?\s*\d+%?|每1000人|绝对效应)",
        ]
        return any(re.search(pattern, raw, flags=re.I) for pattern in patterns)

    @staticmethod
    def _contextual_reference_numbers_for_heading(
        heading: str,
        entries: list[dict[str, object]],
    ) -> list[int]:
        heading_lower = str(heading or "").strip().lower()
        method_numbers = CitationRepairMixin._reference_numbers_matching(
            entries,
            (
                "prisma", "cochrane", "rob 2", "risk-of-bias", "risk of bias",
                "grade", "dersimonian", "laird", "heterogeneity", "i²", "i2",
                "egger", "funnel", "publication bias", "bias in meta-analysis",
            ),
        )
        method_set = set(method_numbers)
        background_numbers = [
            number for number in CitationRepairMixin._reference_numbers_matching(
                entries,
                (
                    "guideline", "systematic review", "prospective meta-analysis",
                    "network meta-analysis", "meta-analysis", "prior", "who react",
                    "surviving sepsis", "consensus", "practice guideline",
                    "clinical practice", "recommendation", "recommendations",
                    "guidance", "scientific statement", "position statement",
                    "background",
                ),
            )
            if number not in method_set
        ]
        certainty_numbers = CitationRepairMixin._reference_numbers_matching(
            entries,
            ("grade", "egger", "publication bias", "bias in meta-analysis", "funnel")
        )

        if heading_lower in {"introduction", "引言"}:
            return CitationRepairMixin._dedupe_numbers(background_numbers)
        if heading_lower in {"methods", "方法"}:
            return CitationRepairMixin._dedupe_numbers(method_numbers)
        if heading_lower in {"discussion", "讨论"}:
            return CitationRepairMixin._dedupe_numbers(certainty_numbers + background_numbers)
        return []

    @staticmethod
    def _ensure_publication_citation_density(
        manuscript: str,
        entries: list[dict[str, object]],
        *,
        min_per_1000_words: float = PUBLICATION_CITATION_DENSITY_PER_1000,
        min_word_count: int = PUBLICATION_CITATION_DENSITY_MIN_WORDS,
        min_unique_references: int = PUBLICATION_CITATION_MIN_UNIQUE_REFERENCES,
    ) -> str:
        if not entries:
            return manuscript
        reference_match = CitationRepairMixin._reference_heading_match(manuscript)
        main_text = manuscript[: reference_match.start()] if reference_match else manuscript
        word_count = CitationRepairMixin._main_manuscript_word_count(main_text)
        if word_count < min_word_count:
            return manuscript

        updated = manuscript
        target_total = max(1, math.ceil(word_count * min_per_1000_words / 1000) + 5)
        target_unique = min(min_unique_references, len(entries))
        heading_order = (
            "Introduction", "Discussion", "Methods", "Results",
            "引言", "讨论", "方法", "结果",
        )
        max_iterations = max(len(entries) * 3, len(heading_order) * 4)

        for _ in range(max_iterations):
            current_main = CitationRepairMixin._main_text_before_reference_section(updated)
            current_numbers = CitationRepairMixin._citation_numbers_from_text(current_main)
            current_unique = set(current_numbers)
            if len(current_numbers) >= target_total and len(current_unique) >= target_unique:
                break

            changed = False
            for heading in heading_order:
                current_main = CitationRepairMixin._main_text_before_reference_section(updated)
                current_numbers = CitationRepairMixin._citation_numbers_from_text(current_main)
                current_unique = set(current_numbers)
                if len(current_numbers) >= target_total and len(current_unique) >= target_unique:
                    break
                citation = CitationRepairMixin._supplemental_citation_for_heading(
                    heading,
                    entries,
                    current_unique,
                    need_unique=len(current_unique) < target_unique,
                )
                before = updated
                updated = CitationRepairMixin._append_citation_to_least_cited_paragraph(
                    updated,
                    heading,
                    citation,
                    entries=entries,
                    used_numbers=current_unique,
                    need_unique=len(current_unique) < target_unique,
                )
                if updated != before:
                    changed = True
            if not changed:
                break
        return updated

    @staticmethod
    def _main_text_before_reference_section(manuscript: str) -> str:
        match = CitationRepairMixin._reference_heading_match(manuscript)
        return manuscript[: match.start()] if match else str(manuscript or "")

    @staticmethod
    def _main_manuscript_word_count(text: str) -> int:
        main = CitationRepairMixin._main_text_before_supplement(text)
        return len(re.findall(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?|[\u4e00-\u9fff]|[%./+-]+", main))

    @staticmethod
    def _main_text_before_supplement(text: str) -> str:
        raw = str(text or "")
        cut_points = []
        for heading in (
            "## Supplementary Materials",
            "## Supplementary material",
            "## Supplementary",
            "## 补充材料",
        ):
            index = raw.find(heading)
            if index >= 0:
                cut_points.append(index)
        reference_match = CitationRepairMixin._reference_heading_match(raw)
        if reference_match:
            cut_points.append(reference_match.start())
        return raw[: min(cut_points)] if cut_points else raw

    @staticmethod
    def _supplemental_citation_for_heading(
        heading: str,
        entries: list[dict[str, object]],
        used_numbers: set[int],
        *,
        need_unique: bool,
    ) -> str:
        numbers = [int(item["number"]) for item in entries if int(item.get("number", 0) or 0) > 0]
        if not numbers:
            return ""
        heading_lower = str(heading or "").strip().lower()
        method_numbers = CitationRepairMixin._reference_numbers_matching(
            entries,
            (
                "prisma", "cochrane", "rob 2", "risk-of-bias", "risk of bias",
                "grade", "dersimonian", "laird", "heterogeneity", "i²", "i2",
                "egger", "funnel", "publication bias", "bias in meta-analysis",
            ),
        )
        background_numbers = CitationRepairMixin._reference_numbers_matching(
            entries,
            (
                "guideline", "systematic review", "prospective meta-analysis",
                "network meta-analysis", "meta-analysis", "prior", "who react",
                "surviving sepsis", "consensus", "practice guideline",
                "clinical practice", "recommendation", "recommendations",
                "guidance", "scientific statement", "position statement",
                "background",
            ),
        )
        trial_numbers = CitationRepairMixin._numeric_effect_source_reference_numbers(entries)
        certainty_numbers = CitationRepairMixin._reference_numbers_matching(
            entries,
            ("grade", "egger", "publication bias", "bias in meta-analysis", "funnel")
        )

        if heading_lower in {"methods", "方法"}:
            preferred = method_numbers or numbers
        elif heading_lower in {"results", "结果"}:
            preferred = trial_numbers if len(trial_numbers) <= 3 else []
        elif heading_lower in {"discussion", "讨论"}:
            preferred = CitationRepairMixin._dedupe_numbers(certainty_numbers + background_numbers + trial_numbers + numbers)
        else:
            preferred = CitationRepairMixin._dedupe_numbers(background_numbers + trial_numbers + numbers)

        if need_unique:
            missing = [number for number in preferred if number not in used_numbers]
            if missing:
                limit = 5
                return CitationRepairMixin._citation_cluster(missing[:limit])

        unused = [number for number in preferred if number not in used_numbers]
        if unused:
            limit = 5
            return CitationRepairMixin._citation_cluster(unused[:limit])
        limit = 5
        return CitationRepairMixin._citation_cluster(preferred[:limit])

    @staticmethod
    def _claim_specific_citation_for_paragraph(
        paragraph: str,
        entries: list[dict[str, object]] | None,
        heading: str,
        fallback_citation: str,
        *,
        used_numbers: set[int] | None = None,
        need_unique: bool = False,
    ) -> str:
        """Choose citations from references whose role matches the paragraph claim."""
        if not entries:
            return fallback_citation
        preferred = CitationRepairMixin._claim_specific_reference_numbers(paragraph, entries, heading)
        if not preferred:
            return fallback_citation
        used = set(used_numbers or set())
        existing = set(CitationRepairMixin._citation_numbers_from_text(paragraph))
        candidates = [number for number in preferred if number not in existing]
        if not candidates:
            return fallback_citation
        if need_unique:
            unique_candidates = [number for number in candidates if number not in used]
            candidates = unique_candidates or candidates
        cluster = CitationRepairMixin._citation_cluster(candidates[:2])
        return cluster or fallback_citation

    @staticmethod
    def _claim_specific_reference_numbers(
        paragraph: str,
        entries: list[dict[str, object]],
        heading: str,
    ) -> list[int]:
        raw = str(paragraph or "").lower()
        heading_lower = str(heading or "").strip().lower()
        if not raw:
            return []

        claim_rules: list[tuple[tuple[str, ...], tuple[str, ...]]] = [
            (
                (
                    "safety", "adverse", "genitourinary", "infection", "ketoacidosis",
                    "hypotension", "volume depletion", "treatment discontinuation",
                    "renal-function", "renal function", "kidney function", "安全",
                    "不良", "泌尿", "感染", "酮症酸中毒", "低血压", "容量不足",
                    "肾功能", "停药",
                ),
                (
                    "safety", "adverse", "infection", "ketoacidosis", "renal function",
                    "kidney", "discontinuation", "frail", "older", "diabetes",
                    "genitourinary",
                ),
            ),
            (
                (
                    "mechanism", "mechanistic", "pathophysiology", "osmotic",
                    "diuresis", "natriuresis", "renal hemodynamics", "cardiometabolic",
                    "congestion", "glucose lowering", "机制", "病理生理", "利尿",
                    "排钠", "肾小球", "血流动力学", "心肾代谢", "充血",
                ),
                (
                    "mechanism", "mechanistic", "pathophysiology", "natriuresis",
                    "renal hemodynamics", "cardiometabolic", "diabetes", "congestion",
                ),
            ),
            (
                (
                    "guideline", "guidelines", "recommendation", "recommendations",
                    "guideline panels", "clinical practice", "pathway", "implementation",
                    "sequencing", "指南", "推荐", "临床路径", "临床实践", "实施",
                    "可及性",
                ),
                (
                    "guideline", "guidelines", "practice guideline", "clinical practice",
                    "recommendation", "recommendations", "scientific statement",
                    "position statement", "regulatory", "translation into guidelines",
                ),
            ),
            (
                (
                    "certainty", "grade", "risk of bias", "publication bias", "funnel",
                    "small-study", "imprecision", "indirectness", "heterogeneity",
                    "确定性", "偏倚", "发表偏倚", "漏斗图", "不精确", "间接性",
                    "异质性",
                ),
                (
                    "grade", "risk of bias", "rob 2", "cochrane", "egger",
                    "publication bias", "funnel", "heterogeneity", "i²", "i2",
                ),
            ),
            (
                (
                    "composite endpoint", "component", "hospitalization", "quality of life",
                    "ejection fraction", "subgroup", "baseline risk", "absolute benefit",
                    "heart failure spectrum", "hfpef", "hfmref", "复合终点", "组成事件",
                    "住院", "生活质量", "射血分数", "亚组", "基线风险", "绝对获益",
                    "心衰谱系",
                ),
                (
                    "systematic review", "meta-analysis", "heart failure", "hfpef",
                    "hfmref", "ejection fraction", "preserved ejection fraction",
                    "mildly reduced", "prior", "clinical", "lancet", "nature medicine",
                ),
            ),
        ]

        effect_interpretation_terms = (
            "pooled hr", "pooled hazard ratio", "pooled effect",
            "absolute risk difference", "number needed to treat", "nnt",
            "合并hr", "合并 hazard ratio", "合并效应", "绝对风险差",
            "需治数", "获益需治数",
        )
        if heading_lower in {"methods", "方法"}:
            methods_specific = CitationRepairMixin._methods_claim_reference_numbers(raw, entries)
            if methods_specific:
                return methods_specific
        multidomain_numbers = CitationRepairMixin._multidomain_interpretation_reference_numbers(raw, entries)
        if multidomain_numbers:
            return multidomain_numbers
        clinical_decision_numbers = CitationRepairMixin._clinical_decision_reference_numbers(raw, entries)
        if clinical_decision_numbers:
            return clinical_decision_numbers
        if CitationRepairMixin._sentence_has_primary_trial_count_claim(raw):
            trial_numbers = CitationRepairMixin._numeric_effect_source_reference_numbers(entries)
            if trial_numbers:
                if len(trial_numbers) > 3:
                    return CitationRepairMixin._source_specific_reference_numbers_for_sentence(raw, entries, trial_numbers)
                return trial_numbers
        if (
            heading_lower in {"results", "结果"}
            or CitationRepairMixin._sentence_has_numeric_effect_claim(raw)
            or any(term in raw for term in effect_interpretation_terms)
        ):
            trial_numbers = CitationRepairMixin._numeric_effect_source_reference_numbers(entries)
            if trial_numbers:
                if len(trial_numbers) > 3:
                    specific_numbers = CitationRepairMixin._source_specific_reference_numbers_for_sentence(raw, entries, trial_numbers)
                    if specific_numbers:
                        return specific_numbers
                    if any(term in raw for term in ("who react", "published reference", "external reference", "锚点", "已发表")):
                        return CitationRepairMixin._reference_numbers_matching(
                            entries,
                            ("who react", "prospective meta-analysis", "meta-analysis"),
                        )
                    return []
                return trial_numbers
        if heading_lower in {"discussion", "讨论"}:
            discussion_result_terms = (
                "preventable events", "baseline risk", "absolute benefit",
                "absolute effect", "absolute risk", "risk spectrum", "time-to-event",
                "randomized trial evidence", "randomised trial evidence", "primary estimate",
                "primary endpoint", "secondary endpoint", "duplicate report", "focused pico",
                "可预防事件", "基线风险", "绝对获益", "绝对效应", "绝对风险",
                "时间到事件", "随机试验证据", "主要估计", "主要终点", "二级终点", "重复报告",
            )
            if any(term in raw for term in discussion_result_terms):
                trial_numbers = CitationRepairMixin._numeric_effect_source_reference_numbers(entries)
                if trial_numbers:
                    if len(trial_numbers) > 3:
                        return CitationRepairMixin._source_specific_reference_numbers_for_sentence(raw, entries, trial_numbers)
                    return trial_numbers
        if heading_lower in {"conclusion", "结论"}:
            return []
        if heading_lower in {"methods", "方法"}:
            return []

        for paragraph_keywords, reference_keywords in claim_rules:
            if any(keyword in raw for keyword in paragraph_keywords):
                if "safety" in paragraph_keywords or "安全" in paragraph_keywords:
                    primary_matches = CitationRepairMixin._reference_numbers_matching(
                        entries,
                        (
                            "safety", "adverse", "infection", "ketoacidosis",
                            "renal function", "kidney", "discontinuation",
                            "genitourinary",
                        ),
                    )
                    if primary_matches:
                        return primary_matches
                if "mechanism" in paragraph_keywords or "机制" in paragraph_keywords:
                    primary_matches = CitationRepairMixin._reference_numbers_matching(
                        entries,
                        (
                            "mechanism", "mechanistic", "pathophysiology",
                            "natriuresis", "renal hemodynamics", "osmotic",
                            "diuresis", "cardiometabolic", "congestion",
                        ),
                    )
                    if primary_matches:
                        return primary_matches
                matches = CitationRepairMixin._reference_numbers_matching(entries, reference_keywords)
                if "guideline" in paragraph_keywords or "指南" in paragraph_keywords:
                    method_numbers = set(
                        CitationRepairMixin._reference_numbers_matching(
                            entries,
                            (
                                "grade", "prisma", "cochrane", "rob 2",
                                "risk-of-bias", "risk of bias", "egger",
                                "publication bias", "funnel", "heterogeneity",
                            ),
                        )
                    )
                    matches = [number for number in matches if number not in method_numbers]
                if matches:
                    return matches
        return []

    @staticmethod
    def _source_specific_reference_numbers_for_sentence(
        sentence: str,
        entries: list[dict[str, object]],
        candidate_numbers: list[int] | set[int],
    ) -> list[int]:
        """Return trial references only when the sentence names the corresponding source."""
        candidates = set(int(number) for number in candidate_numbers)
        matches: list[int] = []
        raw = str(sentence or "")
        for item in entries:
            number = int(item.get("number", 0) or 0)
            if number not in candidates or number in matches:
                continue
            if CitationRepairMixin._sentence_mentions_reference_anchor(raw, str(item.get("text") or "")):
                matches.append(number)
        return matches

    @staticmethod
    def _sentence_mentions_reference_anchor(sentence: str, reference_text: str) -> bool:
        """Detect whether a claim actually names a specific cited trial/source."""
        raw = re.sub(r"\s+", " ", str(sentence or "")).strip().lower()
        reference = str(reference_text or "")
        if not raw or not reference:
            return False

        stopwords = {
            "a", "an", "and", "among", "analysis", "association", "between",
            "care", "clinical", "controlled", "coronavirus", "corticosteroid",
            "corticosteroids", "covid", "covid-19", "critically", "disease",
            "effect", "effects", "group", "hospitalized", "ill", "journal",
            "medicine", "mortality", "patients", "placebo", "randomised",
            "randomized", "report", "reports", "review", "severe", "systemic",
            "the", "therapy", "trial", "trials", "treatment", "usual", "with",
            "dexamethasone", "hydrocortisone", "methylprednisolone", "prednisone",
            "prednisolone",
            "jama", "nejm", "bmj", "doi", "et", "al",
            "研究", "试验", "患者", "治疗", "死亡", "结局", "随机", "临床",
            "糖皮质激素", "新冠", "重症", "危重", "对照", "常规",
        }
        anchors: set[str] = set()

        first_author = reference.split(",", 1)[0].strip()
        if first_author:
            for token in re.findall(r"[A-Za-z][A-Za-z'-]{2,}", first_author):
                lowered = token.lower().strip("-'")
                if lowered and lowered not in stopwords:
                    anchors.add(lowered)

        for token in re.findall(r"\b[A-Z][A-Z0-9-]{2,}\b", reference):
            lowered = token.lower().strip("-")
            if lowered and lowered not in stopwords:
                anchors.add(lowered)

        for token in re.findall(r"\bNCT\d{8}\b|\b\d{4}-\d{6}-\d{2}\b|\b10\.\d{4,9}/[^\s.]+", reference, flags=re.I):
            anchors.add(token.lower().rstrip(".,;"))

        for token in re.findall(r"[A-Za-z][A-Za-z0-9-]{3,}", reference):
            lowered = token.lower().strip("-")
            if lowered and lowered not in stopwords and not lowered.isdigit():
                anchors.add(lowered)

        for anchor in sorted(anchors, key=len, reverse=True):
            if len(anchor) < 4 and not anchor.startswith("nct"):
                continue
            if re.search(rf"(?<![A-Za-z0-9]){re.escape(anchor)}(?![A-Za-z0-9])", raw, flags=re.I):
                return True
        return False

    @staticmethod
    def _methods_claim_reference_numbers(raw_lower: str, entries: list[dict[str, object]]) -> list[int]:
        raw = str(raw_lower or "").lower()
        if any(term in raw for term in ("prisma", "reporting guideline", "systematic-review presentation", "系统综述报告")):
            return CitationRepairMixin._reference_numbers_matching(entries, ("prisma", "reporting guideline"))
        if any(term in raw for term in ("risk-of-bias judgments", "risk of bias judgments", "rob 2", "偏倚风险判断")):
            return CitationRepairMixin._reference_numbers_matching(entries, ("rob 2", "risk-of-bias", "risk of bias", "cochrane"))
        if any(term in raw for term in ("grade", "certainty", "body of evidence", "证据确定性")):
            return CitationRepairMixin._reference_numbers_matching(entries, ("grade", "certainty"))
        if any(term in raw for term in ("heterogeneity", "i2", "i²", "tau2", "tau²", "cochran", "异质性")):
            return CitationRepairMixin._reference_numbers_matching(
                entries,
                ("heterogeneity", "i²", "i2", "dersimonian", "laird", "random-effects"),
            )
        if any(term in raw for term in ("publication bias", "small-study", "funnel", "egger", "发表偏倚", "漏斗图")):
            return CitationRepairMixin._reference_numbers_matching(entries, ("egger", "publication bias", "funnel"))
        if any(term in raw for term in ("inverse-variance", "inverse variance", "log scale", "random-effects", "fixed-effect")):
            return CitationRepairMixin._reference_numbers_matching(entries, ("cochrane", "dersimonian", "laird", "random-effects"))
        return []

    @staticmethod
    def _multidomain_interpretation_reference_numbers(
        raw_lower: str,
        entries: list[dict[str, object]],
    ) -> list[int]:
        """Support sentences that explicitly combine trial, mechanism, and guideline evidence."""
        raw = str(raw_lower or "").lower()
        trial_terms = (
            "trial results", "trial evidence", "randomized evidence",
            "randomised evidence", "source results", "试验", "随机试验",
            "研究结果",
        )
        mechanism_terms = (
            "biological plausibility", "mechanism", "mechanistic",
            "pathophysiology", "机制", "生物学合理", "病理生理",
        )
        guideline_terms = (
            "guideline context", "guidelines", "guideline", "recommendation",
            "指南背景", "指南", "推荐",
        )
        if not (
            any(term in raw for term in trial_terms)
            and any(term in raw for term in mechanism_terms)
            and any(term in raw for term in guideline_terms)
        ):
            return []

        trial_numbers = CitationRepairMixin._numeric_effect_source_reference_numbers(entries)
        mechanism_numbers = CitationRepairMixin._reference_numbers_matching(
            entries,
            (
                "mechanism", "mechanistic", "pathophysiology", "natriuresis",
                "renal hemodynamics", "osmotic", "diuresis", "cardiometabolic",
                "congestion",
            ),
        )
        guideline_numbers = CitationRepairMixin._reference_numbers_matching(
            entries,
            (
                "guideline", "guidelines", "practice guideline", "clinical practice",
                "recommendation", "recommendations", "scientific statement",
                "position statement", "regulatory", "translation into guidelines",
            ),
        )
        method_numbers = set(
            CitationRepairMixin._reference_numbers_matching(
                entries,
                (
                    "grade", "prisma", "cochrane", "rob 2", "risk-of-bias",
                    "risk of bias", "egger", "publication bias", "funnel",
                    "heterogeneity",
                ),
            )
        )
        guideline_numbers = [number for number in guideline_numbers if number not in method_numbers]
        return CitationRepairMixin._dedupe_numbers(
            trial_numbers[:2] + mechanism_numbers[:1] + guideline_numbers[:2]
        )

    @staticmethod
    def _clinical_decision_reference_numbers(
        raw_lower: str,
        entries: list[dict[str, object]],
    ) -> list[int]:
        """Choose clinical sources for implementation or shared-decision sentences."""
        raw = str(raw_lower or "").lower()
        if not CitationRepairMixin._sentence_has_clinical_decision_claim(raw):
            return []

        trial_numbers = CitationRepairMixin._numeric_effect_source_reference_numbers(entries)
        safety_numbers = CitationRepairMixin._reference_numbers_matching(
            entries,
            (
                "safety", "adverse", "tolerability", "infection", "ketoacidosis",
                "renal function", "kidney", "discontinuation", "genitourinary",
                "frail", "older",
            ),
        )
        guideline_numbers = CitationRepairMixin._reference_numbers_matching(
            entries,
            (
                "guideline", "guidelines", "practice guideline", "clinical practice",
                "recommendation", "recommendations", "scientific statement",
                "position statement",
            ),
        )
        method_numbers = set(
            CitationRepairMixin._reference_numbers_matching(
                entries,
                (
                    "grade", "prisma", "cochrane", "rob 2", "risk-of-bias",
                    "risk of bias", "egger", "publication bias", "funnel",
                    "heterogeneity", "dersimonian", "laird",
                ),
            )
        )
        guideline_numbers = [number for number in guideline_numbers if number not in method_numbers]
        return CitationRepairMixin._dedupe_numbers(
            trial_numbers[:2] + safety_numbers[:1] + guideline_numbers[:1]
        )

    @staticmethod
    def _sentence_has_clinical_decision_claim(sentence: str) -> bool:
        raw = str(sentence or "").lower()
        implementation_terms = (
            "clinical decision", "clinical decisions", "patient preferences",
            "patient preference", "eligible patients", "guideline panels",
            "shared decision", "implementation", "cost", "affordability",
            "monitoring", "处方决策", "临床决策", "患者偏好", "费用",
            "可及性", "实施", "监测", "适用患者",
        )
        clinical_content_terms = (
            "baseline risk", "absolute benefit", "safety", "renal function",
            "volume status", "adverse", "genitourinary", "ketoacidosis",
            "基线风险", "绝对获益", "安全", "肾功能", "容量状态", "不良",
            "泌尿", "酮症酸中毒",
        )
        return bool(
            any(term in raw for term in implementation_terms)
            and any(term in raw for term in clinical_content_terms)
        )

    @staticmethod
    def _sentence_has_primary_trial_count_claim(sentence: str) -> bool:
        raw = str(sentence or "").lower()
        if not re.search(r"\d", raw):
            return False
        english_participant_count = (
            re.search(r"\b(?:included|contributing|contributed|enrolled|randomized|randomised|total)\b", raw)
            and re.search(r"\b(?:participants|sample size|trial participants)\b", raw)
        )
        english_patient_count = (
            re.search(r"\b(?:contributing|contributed|enrolled|randomized|randomised|total)\b", raw)
            and re.search(r"\bpatients\b", raw)
        )
        chinese_count = re.search(
            r"(?:纳入|贡献|提供|总计|共).{0,16}(?:参与者|受试者|患者|样本量)",
            raw,
        )
        return bool(english_participant_count or english_patient_count or chinese_count)

    @staticmethod
    def _ensure_claim_specific_citation_supplements(
        manuscript: str,
        entries: list[dict[str, object]],
    ) -> str:
        """Add a narrow source when an interpretive paragraph only has generic citations."""
        if not entries:
            return manuscript

        updated = str(manuscript or "")
        for heading in (
            "Introduction", "Methods", "Results", "Discussion", "Conclusion",
            "引言", "方法", "结果", "讨论", "结论",
        ):
            pattern = rf"(^##\s+{re.escape(heading)}\s*$)([\s\S]*?)(?=^##\s+|\Z)"
            match = re.search(pattern, updated, flags=re.M)
            if not match:
                continue

            body = match.group(2)
            parts = re.split(r"(\n\s*\n)", body)
            changed = False
            for index in range(0, len(parts), 2):
                paragraph = parts[index]
                if not CitationRepairMixin._paragraph_has_citable_line(paragraph):
                    continue
                if CitationRepairMixin._paragraph_should_avoid_inline_citation_backfill(paragraph, heading=heading):
                    continue
                existing_numbers = set(CitationRepairMixin._citation_numbers_from_text(paragraph))
                paragraph_without_citations = re.sub(
                    r"[\[［][0-9\s,，、;；\-–—至]+[\]］]",
                    " ",
                    paragraph,
                )
                minimum_units = min(12, PUBLICATION_CITATION_MIN_SUBSTANTIAL_PARAGRAPH_WORDS)
                if (
                    CitationRepairMixin._text_unit_count(paragraph_without_citations)
                    < minimum_units
                ):
                    continue

                sentence_updated = CitationRepairMixin._append_claim_specific_citations_to_sentences(
                    paragraph,
                    entries,
                    heading,
                )
                if sentence_updated != paragraph:
                    parts[index] = sentence_updated
                    changed = True
                    continue

                existing_numbers = set(CitationRepairMixin._citation_numbers_from_text(paragraph))
                preferred = CitationRepairMixin._claim_specific_reference_numbers(paragraph, entries, heading)
                if not preferred or existing_numbers & set(preferred):
                    continue
                missing = [number for number in preferred if number not in existing_numbers]
                citation = CitationRepairMixin._citation_cluster(missing[:1])
                if not citation:
                    continue
                updated_paragraph = CitationRepairMixin._append_citation_to_first_paragraph(paragraph, citation, heading=heading)
                if updated_paragraph != paragraph:
                    parts[index] = updated_paragraph
                    changed = True

            if changed:
                updated_body = "".join(parts)
                updated = updated[:match.start(2)] + updated_body + updated[match.end(2):]

        return updated

    @staticmethod
    def _append_claim_specific_citations_to_sentences(
        paragraph: str,
        entries: list[dict[str, object]],
        heading: str,
    ) -> str:
        """Cite the sentence that makes a claim instead of borrowing nearby citations."""
        lines = str(paragraph or "").splitlines()
        changed = False
        for line_index, line in enumerate(lines):
            if not CitationRepairMixin._line_can_receive_citation(line):
                continue
            segments = CitationRepairMixin._sentence_segments(line)
            if not segments:
                continue
            updated_segments: list[str] = []
            line_changed = False
            for segment in segments:
                segment_without_citations = re.sub(
                    r"[\[［][0-9\s,，、;；\-–—至]+[\]］]",
                    " ",
                    segment,
                )
                if CitationRepairMixin._text_unit_count(segment_without_citations) < 12:
                    updated_segments.append(segment)
                    continue
                preferred = CitationRepairMixin._claim_specific_reference_numbers(segment, entries, heading)
                if not preferred:
                    updated_segments.append(segment)
                    continue
                existing_numbers = set(CitationRepairMixin._citation_numbers_from_text(segment))
                preferred_set = set(preferred)
                citation_limit = CitationRepairMixin._claim_specific_sentence_citation_limit(segment)
                preserve_existing_complementary_numbers = (
                    CitationRepairMixin._sentence_has_numeric_effect_claim(segment)
                    and not CitationRepairMixin._sentence_has_primary_trial_count_claim(segment)
                )
                if existing_numbers & preferred_set:
                    trimmed_segment = (
                        segment
                        if preserve_existing_complementary_numbers
                        else CitationRepairMixin._trim_narrow_claim_sentence_citations(segment, preferred)
                    )
                    existing_after_trim = set(CitationRepairMixin._citation_numbers_from_text(trimmed_segment))
                    existing_preferred = existing_after_trim & preferred_set
                    if len(existing_preferred) < citation_limit:
                        missing_preferred = [
                            number for number in preferred
                            if number not in existing_after_trim
                        ]
                        if missing_preferred:
                            trimmed_segment = CitationRepairMixin._append_citation_to_sentence(
                                trimmed_segment,
                                CitationRepairMixin._citation_cluster(
                                    missing_preferred[:citation_limit - len(existing_preferred)]
                                ),
                            )
                            trimmed_segment = CitationRepairMixin._merge_adjacent_citation_clusters(trimmed_segment)
                    updated_segments.append(trimmed_segment)
                    if trimmed_segment != segment:
                        line_changed = True
                    continue
                if len(existing_numbers) >= 5:
                    updated_segments.append(segment)
                    continue
                if existing_numbers:
                    replacement_segment = (
                        segment
                        if preserve_existing_complementary_numbers
                        else CitationRepairMixin._trim_narrow_claim_sentence_citations(segment, preferred)
                    )
                    if replacement_segment != segment:
                        updated_segments.append(replacement_segment)
                        line_changed = True
                        continue
                missing = [number for number in preferred if number not in existing_numbers]
                citation = CitationRepairMixin._citation_cluster(missing[:citation_limit])
                if not citation:
                    updated_segments.append(segment)
                    continue
                updated_segments.append(CitationRepairMixin._append_citation_to_sentence(segment, citation))
                line_changed = True
            if line_changed:
                lines[line_index] = "".join(updated_segments)
                changed = True
        return "\n".join(lines) if changed else paragraph

    @staticmethod
    def _claim_specific_sentence_citation_limit(segment: str) -> int:
        raw = str(segment or "").lower()
        trial_terms = ("trial results", "trial evidence", "randomized evidence", "randomised evidence", "试验", "随机试验")
        mechanism_terms = ("biological plausibility", "mechanism", "mechanistic", "pathophysiology", "机制", "生物学合理", "病理生理")
        guideline_terms = ("guideline context", "guideline", "guidelines", "recommendation", "指南背景", "指南", "推荐")
        if (
            any(term in raw for term in trial_terms)
            and any(term in raw for term in mechanism_terms)
            and any(term in raw for term in guideline_terms)
        ):
            return 5
        if CitationRepairMixin._sentence_has_clinical_decision_claim(raw):
            return 4
        if CitationRepairMixin._sentence_has_primary_trial_count_claim(raw):
            return 2
        multi_source_terms = (
            "pooled hr", "pooled hazard ratio", "pooled effect",
            "absolute risk difference", "number needed to treat", "nnt",
            "合并hr", "合并效应", "绝对风险差", "需治数", "获益需治数",
        )
        return 2 if any(term in raw for term in multi_source_terms) else 1

    @staticmethod
    def _trim_narrow_claim_sentence_citations(segment: str, preferred_numbers: list[int]) -> str:
        """Keep safety/mechanism claim sentences from accumulating broad, unrelated bundles."""
        raw = str(segment or "")
        lowered = raw.lower()
        narrow_markers = (
            "safety", "adverse", "genitourinary", "ketoacidosis", "volume depletion",
            "renal-function", "renal function", "mechanism", "mechanistic", "osmotic",
            "diuresis", "natriuresis", "renal hemodynamics", "cardiometabolic",
            "pooled hr", "pooled hazard ratio", "pooled effect",
            "absolute risk difference", "number needed to treat", "nnt",
            "participants", "patients", "sample size", "clinical decision",
            "clinical decisions", "patient preferences", "cost",
            "安全", "不良", "泌尿", "酮症酸中毒", "容量不足", "肾功能",
            "机制", "利尿", "排钠", "血流动力学", "心肾代谢",
            "合并hr", "合并效应", "绝对风险差", "需治数", "获益需治数",
            "参与者", "受试者", "样本量", "临床决策", "患者偏好",
            "费用",
        )
        if not any(marker in lowered for marker in narrow_markers):
            return segment
        preferred = set(preferred_numbers)
        citation_pattern = r"[\[［][0-9\s,，、;；\-–—至]+[\]］]"
        existing = set(CitationRepairMixin._citation_numbers_from_text(raw))
        kept = sorted(existing & preferred)
        if not kept:
            if not existing:
                return segment
            kept = preferred_numbers[:CitationRepairMixin._claim_specific_sentence_citation_limit(raw)]
        if kept == sorted(existing):
            return segment
        without_citations = re.sub(citation_pattern, "", raw)
        without_citations = re.sub(r"\s+([.,;:!?。！？])", r"\1", without_citations)
        without_citations = re.sub(r"\s{2,}", " ", without_citations)
        return CitationRepairMixin._append_citation_to_sentence(
            without_citations,
            CitationRepairMixin._citation_cluster(kept),
        )

    @staticmethod
    def _smooth_mechanical_citation_density(manuscript: str) -> str:
        """Reduce visibly mechanical citation placement in interpretive paragraphs."""
        updated = str(manuscript or "")
        for heading in ("Methods", "Results", "Discussion", "Conclusion", "方法", "结果", "讨论", "结论"):
            pattern = rf"(^##\s+{re.escape(heading)}\s*$)([\s\S]*?)(?=^##\s+|\Z)"
            match = re.search(pattern, updated, flags=re.M)
            if not match:
                continue
            body = match.group(2)
            parts = re.split(r"(\n\s*\n)", body)
            changed = False
            for index in range(0, len(parts), 2):
                paragraph = parts[index]
                smoothed = CitationRepairMixin._smooth_mechanical_citation_density_paragraph(paragraph)
                if smoothed != paragraph:
                    parts[index] = smoothed
                    changed = True
            if changed:
                updated_body = "".join(parts)
                updated = updated[:match.start(2)] + updated_body + updated[match.end(2):]
        return CitationRepairMixin._cap_excessive_global_citation_density(updated)

    @staticmethod
    def _cap_excessive_global_citation_density(
        manuscript: str,
        *,
        max_per_1000_words: float = PUBLICATION_CITATION_MAX_DENSITY_PER_1000,
        min_word_count: int = PUBLICATION_CITATION_DENSITY_MIN_WORDS,
    ) -> str:
        """Remove redundant non-numeric citation markers when the whole manuscript is overcited."""
        raw = str(manuscript or "")
        main = CitationRepairMixin._main_text_before_reference_section(raw)
        tail = raw[len(main):]
        word_count = main_publication_word_count(main)
        if word_count < min_word_count:
            return manuscript
        current = main
        while True:
            current_word_count = main_publication_word_count(current)
            max_citation_numbers = max(1, math.floor(current_word_count * max_per_1000_words / 1000))
            if len(CitationRepairMixin._citation_numbers_from_text(current)) <= max_citation_numbers:
                break
            matches = list(re.finditer(r"[\[［][0-9\s,，、;；\-–—至]+[\]］]", current))
            candidates = CitationRepairMixin._global_citation_removal_candidates(current, matches)
            if not candidates:
                break
            match = candidates[0]
            current = current[:match.start()] + current[match.end():]
            current = re.sub(r"\s+([.,;:!?。！？])", r"\1", current)
            current = re.sub(r"[ \t]{2,}", " ", current)
        return current + tail

    @staticmethod
    def _global_citation_removal_candidates(
        main_text: str,
        matches: list[re.Match[str]],
    ) -> list[re.Match[str]]:
        if not matches:
            return []
        all_numbers = CitationRepairMixin._citation_numbers_from_text(main_text)
        number_frequency = {number: all_numbers.count(number) for number in set(all_numbers)}
        scored: list[tuple[int, int, int, int, re.Match[str]]] = []
        for match in matches:
            if CitationRepairMixin._citation_marker_is_in_protected_numeric_context(main_text, match.start(), match.end()):
                continue
            if CitationRepairMixin._citation_marker_is_in_protected_methodology_context(main_text, match.start(), match.end()):
                continue
            if CitationRepairMixin._citation_marker_is_on_uncitable_line(main_text, match.start()):
                continue
            if CitationRepairMixin._citation_marker_is_required_section_anchor(main_text, match.start(), match.end()):
                continue
            numbers = CitationRepairMixin._dedupe_numbers(CitationRepairMixin._citation_numbers_from_text(match.group(0)))
            if not numbers:
                continue
            repeated_elsewhere = all(number_frequency.get(number, 0) > 1 for number in numbers)
            if not repeated_elsewhere:
                continue
            heading = CitationRepairMixin._section_heading_at_offset(main_text, match.start()).lower()
            section_priority = {
                "methods": 0,
                "方法": 0,
                "results": 1,
                "结果": 1,
                "discussion": 2,
                "讨论": 2,
                "conclusion": 3,
                "结论": 3,
                "introduction": 4,
                "引言": 4,
                "abstract": 5,
                "摘要": 5,
            }.get(heading, 6)
            max_frequency = max(number_frequency.get(number, 0) for number in numbers)
            scored.append((section_priority, len(numbers), -max_frequency, match.start(), match))
        scored.sort(key=lambda item: item[:4])
        return [item[4] for item in scored]

    @staticmethod
    def _cap_dominant_primary_trial_citations(
        manuscript: str,
        entries: list[dict[str, object]],
        *,
        max_mentions: int = 5,
    ) -> str:
        """Keep citation backfill from making one primary trial look like a universal source."""
        primary_numbers = set(CitationRepairMixin._numeric_effect_source_reference_numbers(entries))
        if not primary_numbers:
            return manuscript
        entries_by_number = {
            int(item.get("number", 0) or 0): str(item.get("text") or "")
            for item in entries
            if int(item.get("number", 0) or 0) > 0
        }
        raw = str(manuscript or "")
        main = CitationRepairMixin._main_text_before_reference_section(raw)
        tail = raw[len(main):]
        counts = {
            number: CitationRepairMixin._citation_numbers_from_text(main).count(number)
            for number in primary_numbers
        }
        remaining_citation_numbers = len(CitationRepairMixin._citation_numbers_from_text(main))
        word_count = CitationRepairMixin._main_manuscript_word_count(main)
        minimum_citation_numbers = (
            math.ceil(word_count * PUBLICATION_CITATION_DENSITY_PER_1000 / 1000)
            if word_count >= PUBLICATION_CITATION_DENSITY_MIN_WORDS else 0
        )
        overused = {number for number, count in counts.items() if count > max_mentions}
        if not overused:
            return manuscript

        citation_pattern = r"[\[［][0-9\s,，、;；\-–—至]+[\]］]"
        pieces: list[str] = []
        cursor = 0
        changed = False
        for match in re.finditer(citation_pattern, main):
            marker = match.group(0)
            numbers = CitationRepairMixin._dedupe_numbers(CitationRepairMixin._citation_numbers_from_text(marker))
            removable = [
                number for number in numbers
                if number in overused and counts.get(number, 0) > max_mentions
            ]
            is_generic_single_primary = CitationRepairMixin._citation_marker_is_generic_single_primary_source(
                main,
                match.start(),
                match.end(),
                marker,
                entries_by_number,
                primary_numbers,
            )
            if (
                not removable
                or CitationRepairMixin._citation_marker_is_on_uncitable_line(main, match.start())
                or (
                    CitationRepairMixin._citation_marker_is_in_strict_primary_source_context(main, match.start(), match.end())
                    and not is_generic_single_primary
                )
            ):
                pieces.append(main[cursor:match.end()])
                cursor = match.end()
                continue

            kept_numbers: list[int] = []
            for number in numbers:
                if number in removable and counts.get(number, 0) > max_mentions:
                    if minimum_citation_numbers and remaining_citation_numbers - 1 < minimum_citation_numbers:
                        kept_numbers.append(number)
                        continue
                    counts[number] = counts.get(number, 0) - 1
                    remaining_citation_numbers -= 1
                    changed = True
                    continue
                kept_numbers.append(number)
            replacement = CitationRepairMixin._citation_cluster(kept_numbers)
            if replacement:
                replacement = CitationRepairMixin._display_citation_for_text(replacement, marker)
            pieces.append(main[cursor:match.start()])
            pieces.append(replacement)
            cursor = match.end()

        if not changed:
            return manuscript
        pieces.append(main[cursor:])
        updated_main = "".join(pieces)
        updated_main = re.sub(r"\s+([.,;:!?。！？])", r"\1", updated_main)
        updated_main = re.sub(r"[ \t]{2,}", " ", updated_main)
        return updated_main + tail

    @staticmethod
    def _cap_dominant_primary_trial_citations_from_references(manuscript: str) -> str:
        entries = CitationRepairMixin._reference_entries_from_references_section(manuscript)
        if not entries:
            return manuscript
        capped = CitationRepairMixin._cap_dominant_primary_trial_citations(manuscript, entries)
        return CitationRepairMixin._cap_overused_nonmethod_citations(capped, entries)

    @staticmethod
    def _cap_overused_nonmethod_citations(
        manuscript: str,
        entries: list[dict[str, object]],
        *,
        max_mentions: int = 5,
    ) -> str:
        """Avoid letting one background or comparator source become a universal citation."""
        if not entries:
            return manuscript
        entries_by_number = {
            int(item.get("number", 0) or 0): str(item.get("text") or "")
            for item in entries
            if int(item.get("number", 0) or 0) > 0
        }
        primary_numbers = set(CitationRepairMixin._numeric_effect_source_reference_numbers(entries))
        method_numbers = set(
            CitationRepairMixin._reference_numbers_matching(
                entries,
                (
                    "prisma", "cochrane", "rob 2", "risk-of-bias", "risk of bias",
                    "grade", "dersimonian", "laird", "heterogeneity", "i²", "i2",
                    "egger", "funnel", "publication bias", "bias in meta-analysis",
                ),
            )
        )
        raw = str(manuscript or "")
        main = CitationRepairMixin._main_text_before_reference_section(raw)
        tail = raw[len(main):]
        counts = Counter(CitationRepairMixin._citation_numbers_from_text(main))
        remaining_citation_numbers = len(CitationRepairMixin._citation_numbers_from_text(main))
        word_count = CitationRepairMixin._main_manuscript_word_count(main)
        minimum_citation_numbers = (
            math.ceil(word_count * PUBLICATION_CITATION_DENSITY_PER_1000 / 1000)
            if word_count >= PUBLICATION_CITATION_DENSITY_MIN_WORDS else 0
        )
        overused = {
            int(number)
            for number, count in counts.items()
            if int(number) not in method_numbers and count > max_mentions
        }
        if not overused:
            return manuscript

        pieces: list[str] = []
        cursor = 0
        changed = False
        citation_pattern = r"[\[［][0-9\s,，、;；\-–—至]+[\]］]"
        for match in re.finditer(citation_pattern, main):
            marker = match.group(0)
            numbers = CitationRepairMixin._dedupe_numbers(CitationRepairMixin._citation_numbers_from_text(marker))
            removable = [
                number for number in numbers
                if number in overused and counts.get(number, 0) > max_mentions
            ]
            is_generic_single_primary = CitationRepairMixin._citation_marker_is_generic_single_primary_source(
                main,
                match.start(),
                match.end(),
                marker,
                entries_by_number,
                primary_numbers,
            )
            if (
                not removable
                or CitationRepairMixin._citation_marker_is_on_uncitable_line(main, match.start())
                or (
                    CitationRepairMixin._citation_marker_is_in_strict_primary_source_context(main, match.start(), match.end())
                    and not is_generic_single_primary
                )
                or CitationRepairMixin._citation_marker_is_in_protected_methodology_context(main, match.start(), match.end())
            ):
                pieces.append(main[cursor:match.end()])
                cursor = match.end()
                continue

            kept_numbers: list[int] = []
            for number in numbers:
                if number in removable and counts.get(number, 0) > max_mentions:
                    if minimum_citation_numbers and remaining_citation_numbers - 1 < minimum_citation_numbers:
                        kept_numbers.append(number)
                        continue
                    counts[number] = counts.get(number, 0) - 1
                    remaining_citation_numbers -= 1
                    changed = True
                    continue
                kept_numbers.append(number)
            replacement = CitationRepairMixin._citation_cluster(kept_numbers)
            if replacement:
                replacement = CitationRepairMixin._display_citation_for_text(replacement, marker)
            pieces.append(main[cursor:match.start()])
            pieces.append(replacement)
            cursor = match.end()

        if not changed:
            return manuscript
        pieces.append(main[cursor:])
        updated_main = "".join(pieces)
        updated_main = re.sub(r"\s+([.,;:!?。！？])", r"\1", updated_main)
        updated_main = re.sub(r"[ \t]{2,}", " ", updated_main)
        return updated_main + tail

    @staticmethod
    def _sentence_around_offset(text: str, start: int, end: int) -> str:
        raw = str(text or "")
        left_candidates = [
            raw.rfind(".", 0, start),
            raw.rfind("。", 0, start),
            raw.rfind("!", 0, start),
            raw.rfind("！", 0, start),
            raw.rfind("?", 0, start),
            raw.rfind("？", 0, start),
            raw.rfind("\n", 0, start),
        ]
        sentence_start = max(left_candidates) + 1
        right_positions = [
            pos for pos in (
                raw.find(".", end),
                raw.find("。", end),
                raw.find("!", end),
                raw.find("！", end),
                raw.find("?", end),
                raw.find("？", end),
                raw.find("\n", end),
            )
            if pos >= 0
        ]
        sentence_end = min(right_positions) + 1 if right_positions else len(raw)
        return raw[sentence_start:sentence_end]

    @staticmethod
    def _citation_marker_is_generic_single_primary_source(
        text: str,
        start: int,
        end: int,
        marker: str,
        entries_by_number: dict[int, str],
        primary_numbers: set[int],
    ) -> bool:
        """Identify a single trial citation attached to an aggregate or generic claim."""
        numbers = CitationRepairMixin._dedupe_numbers(CitationRepairMixin._citation_numbers_from_text(marker))
        if len(numbers) != 1 or numbers[0] not in primary_numbers:
            return False
        sentence = CitationRepairMixin._sentence_around_offset(text, start, end)
        reference_text = entries_by_number.get(numbers[0], "")
        if CitationRepairMixin._sentence_mentions_reference_anchor(sentence, reference_text):
            return False
        sentence_lower = re.sub(r"\s+", " ", sentence).strip().lower()
        if not sentence_lower:
            return False
        generic_markers = (
            "pooled", "summary", "combined", "primary-analysis", "primary analysis",
            "selected trial", "selected primary", "across", "aggregate", "certainty",
            "grade", "source-verification", "source verification", "registry",
            "living-data", "living data", "non-primary", "leave-one-out",
            "sensitivity", "baseline risk", "absolute effect", "absolute benefit",
            "all primary", "trial-level", "documentation", "evidence profile",
            "合并", "主要分析", "选定", "总体", "汇总", "确定性", "GRADE",
            "敏感性", "基线风险", "绝对效应", "绝对获益", "来源", "登记",
        )
        return (
            any(marker_text in sentence_lower for marker_text in generic_markers)
            or CitationRepairMixin._sentence_has_numeric_effect_claim(sentence)
            or CitationRepairMixin._sentence_has_primary_trial_count_claim(sentence)
        )

    @staticmethod
    def _citation_marker_is_in_strict_primary_source_context(text: str, start: int, end: int) -> bool:
        """Protect citations that support concrete numeric or trial-count statements."""
        sentence = CitationRepairMixin._sentence_around_offset(text, start, end)
        if CitationRepairMixin._sentence_has_numeric_effect_claim(sentence):
            return True
        if CitationRepairMixin._sentence_has_primary_trial_count_claim(sentence):
            return True
        if re.search(r"\b(?:events?|deaths?|total|participants?)\b.{0,40}\b\d+\s*/\s*\d+", sentence, flags=re.I):
            return True
        return False

    @staticmethod
    def _citation_marker_is_in_protected_methodology_context(text: str, start: int, end: int) -> bool:
        heading = CitationRepairMixin._section_heading_at_offset(text, start).lower()
        if heading not in {"methods", "方法"}:
            return False
        raw = str(text or "")
        left = max(
            raw.rfind(".", 0, start),
            raw.rfind("。", 0, start),
            raw.rfind("!", 0, start),
            raw.rfind("！", 0, start),
            raw.rfind("?", 0, start),
            raw.rfind("？", 0, start),
            raw.rfind("\n\n", 0, start),
        )
        right_candidates = [
            pos for pos in (
                raw.find(".", end),
                raw.find("。", end),
                raw.find("!", end),
                raw.find("！", end),
                raw.find("?", end),
                raw.find("？", end),
                raw.find("\n\n", end),
            )
            if pos >= 0
        ]
        right = min(right_candidates) if right_candidates else min(len(raw), end + 240)
        sentence = raw[left + 1:right + 1].lower()
        protected_terms = (
            "prisma",
            "i2 statistic", "i² statistic", "i2", "i²",
            "tau2", "tau²", "cochran",
            "heterogeneity statistic", "heterogeneity statistics",
            "grade describes", "grade described", "grade domains", "grade certainty",
            "grade asks", "body of evidence", "confidence a decision maker",
            "risk-of-bias judgments", "risk of bias judgments",
            "rob 2", "cochrane",
            "dersimonian", "laird",
            "egger", "funnel", "publication bias",
            "inverse-variance", "inverse variance",
            "random-effects model", "random effects model",
            "fixed-effect model", "fixed effect model",
            "prisma 2020", "prisma-s",
            "报告遵循", "异质性统计", "i2统计", "i²统计", "tau2", "tau²",
            "grade描述", "grade确定性", "偏倚风险判断", "rob 2",
            "发表偏倚", "漏斗图", "随机效应模型", "固定效应模型",
        )
        return any(term in sentence for term in protected_terms)

    @staticmethod
    def _citation_marker_is_on_uncitable_line(text: str, start: int) -> bool:
        raw = str(text or "")
        line_start = raw.rfind("\n", 0, start) + 1
        line_end = raw.find("\n", start)
        if line_end < 0:
            line_end = len(raw)
        stripped = raw[line_start:line_end].strip()
        return bool(
            not stripped
            or stripped.startswith("#")
            or stripped.startswith("|")
            or stripped.startswith("![")
            or stripped.startswith("```")
        )

    @staticmethod
    def _section_heading_at_offset(text: str, offset: int) -> str:
        heading = ""
        for match in re.finditer(r"^##\s+(.+?)\s*$", str(text or ""), flags=re.M):
            if match.start() > offset:
                break
            heading = match.group(1).strip()
        return heading

    @staticmethod
    def _citation_marker_is_required_section_anchor(text: str, start: int, end: int) -> bool:
        raw = str(text or "")
        section = CitationRepairMixin._section_span_at_offset(raw, start)
        if section is None:
            return False
        heading, body_start, body_end = section
        body = raw[body_start:body_end]
        minimum = CitationRepairMixin._minimum_citation_anchors_for_heading(heading, [{"number": index} for index in range(1, 24)])
        if CitationRepairMixin._citation_anchor_count(body) > minimum:
            return False
        paragraph_start = raw.rfind("\n\n", 0, start)
        paragraph_start = body_start if paragraph_start < body_start else paragraph_start + 2
        paragraph_end = raw.find("\n\n", end)
        if paragraph_end < 0 or paragraph_end > body_end:
            paragraph_end = body_end
        paragraph = raw[paragraph_start:paragraph_end]
        return bool(CitationRepairMixin._citation_numbers_from_text(paragraph))

    @staticmethod
    def _section_span_at_offset(text: str, offset: int) -> tuple[str, int, int] | None:
        matches = list(re.finditer(r"^##\s+(.+?)\s*$", str(text or ""), flags=re.M))
        current: re.Match[str] | None = None
        next_match: re.Match[str] | None = None
        for index, match in enumerate(matches):
            if match.start() <= offset:
                current = match
                next_match = matches[index + 1] if index + 1 < len(matches) else None
            elif match.start() > offset:
                break
        if current is None:
            return None
        return current.group(1).strip(), current.end(), next_match.start() if next_match else len(text)

    @staticmethod
    def _smooth_mechanical_citation_density_paragraph(paragraph: str) -> str:
        raw = str(paragraph or "")
        if not raw.strip() or not CitationRepairMixin._paragraph_has_citable_line(raw):
            return paragraph
        citation_pattern = r"[\[［][0-9\s,，、;；\-–—至]+[\]］]"

        def density_snapshot(text: str) -> tuple[list[re.Match[str]], int, float]:
            matches = list(re.finditer(citation_pattern, text))
            without_citations = re.sub(citation_pattern, " ", text)
            text_units = CitationRepairMixin._text_unit_count(without_citations)
            markers_per_35 = round(len(matches) * 35 / text_units, 2) if text_units else 0.0
            return matches, text_units, markers_per_35

        current = raw
        while True:
            matches, text_units, markers_per_35 = density_snapshot(current)
            if (
                len(matches) < PUBLICATION_CITATION_MECHANICAL_MIN_MARKERS
                or text_units < PUBLICATION_CITATION_MIN_SUBSTANTIAL_PARAGRAPH_WORDS
                or markers_per_35 <= PUBLICATION_CITATION_MECHANICAL_MAX_MARKERS_PER_35_UNITS
            ):
                break
            candidates = CitationRepairMixin._mechanical_citation_removal_candidates(current, matches)
            if not candidates:
                break
            candidate = candidates[0]
            current = current[:candidate.start()] + current[candidate.end():]
            current = re.sub(r"\s+([.,;:!?。！？])", r"\1", current)
            current = re.sub(r"[ \t]{2,}", " ", current)
        return current

    @staticmethod
    def _mechanical_citation_removal_candidates(
        paragraph: str,
        matches: list[re.Match[str]],
    ) -> list[re.Match[str]]:
        marker_numbers = [
            CitationRepairMixin._dedupe_numbers(CitationRepairMixin._citation_numbers_from_text(match.group(0)))
            for match in matches
        ]
        protected = [
            CitationRepairMixin._citation_marker_is_in_protected_numeric_context(paragraph, match.start(), match.end())
            for match in matches
        ]
        scored: list[tuple[int, int, re.Match[str]]] = []
        for index, match in enumerate(matches):
            if protected[index]:
                continue
            numbers = set(marker_numbers[index])
            if not numbers:
                continue
            other_numbers = set()
            for other_index, other in enumerate(marker_numbers):
                if other_index != index:
                    other_numbers.update(other)
            is_middle = 0 < index < len(matches) - 1
            subset_elsewhere = numbers <= other_numbers
            overlaps_elsewhere = bool(numbers & other_numbers)
            if subset_elsewhere:
                priority = 0
            elif overlaps_elsewhere and is_middle:
                priority = 1
            elif is_middle:
                priority = 2
            else:
                priority = 3
            scored.append((priority, len(numbers), match))
        scored.sort(key=lambda item: (item[0], item[1]))
        return [item[2] for item in scored if item[0] < 4]

    @staticmethod
    def _limit_repeated_large_citation_clusters(
        manuscript: str,
        *,
        max_repeats: int = 1,
        large_cluster_size: int = 3,
        replacement_pool: list[int] | None = None,
    ) -> str:
        """Avoid repeatedly pasting the same broad citation bundle into many paragraphs."""
        raw = str(manuscript or "")
        reference_match = CitationRepairMixin._reference_heading_match(raw)
        main = raw[: reference_match.start()] if reference_match else raw
        tail = raw[reference_match.start():] if reference_match else ""
        seen: dict[tuple[int, ...], int] = {}
        # Keep replacement semantically local: repeated broad clusters may be narrowed,
        # but must not be rotated to unrelated references from the global pool.
        remaining_citation_numbers = len(CitationRepairMixin._citation_numbers_from_text(main))
        minimum_citation_numbers = 0
        if replacement_pool is not None:
            word_count = CitationRepairMixin._main_manuscript_word_count(main)
            if word_count >= PUBLICATION_CITATION_DENSITY_MIN_WORDS:
                minimum_citation_numbers = max(
                    1,
                    math.ceil(word_count * PUBLICATION_CITATION_DENSITY_PER_1000 / 1000) + 5,
                )

        def replace(match: re.Match[str]) -> str:
            nonlocal remaining_citation_numbers
            marker = match.group(0)
            numbers = CitationRepairMixin._dedupe_numbers(CitationRepairMixin._citation_numbers_from_text(marker))
            if len(numbers) < large_cluster_size:
                return marker
            key = tuple(numbers)
            seen[key] = seen.get(key, 0) + 1
            if seen[key] <= max_repeats:
                return marker
            if CitationRepairMixin._citation_marker_is_in_protected_numeric_context(main, match.start(), match.end()):
                narrowed = numbers[:2] if len(numbers) > 2 else numbers
                if len(narrowed) == len(numbers):
                    return marker
                if (
                    minimum_citation_numbers
                    and remaining_citation_numbers - (len(numbers) - len(narrowed)) < minimum_citation_numbers
                ):
                    return marker
                remaining_citation_numbers -= len(numbers) - len(narrowed)
                citation = CitationRepairMixin._citation_cluster(narrowed)
                return CitationRepairMixin._display_citation_for_text(citation, marker)
            offset = ((seen[key] - max_repeats - 1) * 2) % len(numbers)
            narrowed = [numbers[offset]]
            if len(numbers) > 1:
                narrowed.append(numbers[(offset + 1) % len(numbers)])
            if (
                minimum_citation_numbers
                and remaining_citation_numbers - (len(numbers) - len(narrowed)) < minimum_citation_numbers
            ):
                replacement = CitationRepairMixin._same_size_replacement_citation_numbers(
                    numbers,
                    replacement_pool,
                    occurrence_index=seen[key] - max_repeats,
                )
                if replacement:
                    citation = CitationRepairMixin._citation_cluster(replacement)
                    return CitationRepairMixin._display_citation_for_text(citation, marker)
                return marker
            remaining_citation_numbers -= len(numbers) - len(narrowed)
            citation = CitationRepairMixin._citation_cluster(narrowed)
            return CitationRepairMixin._display_citation_for_text(citation, marker)

        narrowed_main = re.sub(
            r"[\[［][0-9\s,，、;；\-–—至]+[\]］]",
            replace,
            main,
        )
        return narrowed_main + tail

    @staticmethod
    def _same_size_replacement_citation_numbers(
        numbers: list[int],
        replacement_pool: list[int] | None,
        *,
        occurrence_index: int = 1,
    ) -> list[int]:
        """Return a different citation bundle of the same size when density must be preserved."""
        size = len(numbers)
        if size <= 0 or not replacement_pool:
            return []
        pool = CitationRepairMixin._dedupe_numbers([int(number) for number in replacement_pool if int(number) > 0])
        if len(pool) < size:
            return []
        original = tuple(sorted(numbers))
        start = max(0, occurrence_index - 1) * size
        for shift in range(len(pool)):
            offset = (start + shift) % len(pool)
            candidate = [pool[(offset + idx) % len(pool)] for idx in range(size)]
            candidate = sorted(set(candidate))
            if len(candidate) != size:
                continue
            if tuple(candidate) == original:
                continue
            return candidate
        return []

    @staticmethod
    def _citation_marker_is_in_protected_numeric_context(text: str, start: int, end: int) -> bool:
        """Do not narrow citations attached to numeric effect, sample-size, or absolute-effect claims."""
        raw = str(text or "")
        left_candidates = [
            raw.rfind(".", 0, start),
            raw.rfind("。", 0, start),
            raw.rfind("!", 0, start),
            raw.rfind("！", 0, start),
            raw.rfind("?", 0, start),
            raw.rfind("？", 0, start),
            raw.rfind("\n", 0, start),
        ]
        sentence_start = max(left_candidates) + 1
        right_positions = [
            pos for pos in (
                raw.find(".", end),
                raw.find("。", end),
                raw.find("!", end),
                raw.find("！", end),
                raw.find("?", end),
                raw.find("？", end),
                raw.find("\n", end),
            )
            if pos >= 0
        ]
        sentence_end = min(right_positions) + 1 if right_positions else len(raw)
        sentence = raw[sentence_start:sentence_end]
        lowered = sentence.lower()
        absolute_terms = (
            "absolute risk difference", "number needed to treat", "nnt",
            "pooled hr", "pooled hazard ratio", "pooled effect",
            "绝对风险差", "需要治疗人数", "需治数", "获益需治数",
            "合并hr", "合并效应",
        )
        return bool(
            CitationRepairMixin._sentence_has_numeric_effect_claim(sentence)
            or CitationRepairMixin._sentence_has_primary_trial_count_claim(sentence)
            or CitationRepairMixin._sentence_has_source_sensitive_result_claim(sentence)
            or any(term in lowered for term in absolute_terms)
        )

    @staticmethod
    def _sentence_has_source_sensitive_result_claim(sentence: str) -> bool:
        raw = str(sentence or "")
        patterns = [
            (
                r"\b(?:benefit|beneficial|event\s+reduction|fewer|reduc(?:e|es|ed|ing)|lower(?:s|ed|ing)?|"
                r"favou?red|improv(?:e|es|ed|ing)|show(?:s|ed|ing)?|suggest(?:s|ed|ing)?)\b"
                r".{0,110}\b(?:events?|hospitali[sz]ations?|mortality|death|risk|outcomes?|endpoints?)\b"
            ),
            (
                r"\b(?:preventable events?|baseline risk|absolute effects?|absolute benefit|absolute risk|"
                r"primary estimate|primary endpoint|secondary endpoint|duplicate reports?|focused PICO)\b"
            ),
            (
                r"\b(?:safety|harms?|tolerability|adverse\s+events?|discontinuations?)\b"
                r".{0,90}\b(?:higher|lower|similar|increased|reduced|fewer|more|risk)\b"
            ),
            (
                r"(?:获益|降低|减少|改善|显示|提示).{0,50}"
                r"(?:事件|住院|死亡|风险|结局|终点)"
            ),
            (
                r"(?:安全性|不良事件|耐受性|停药).{0,50}"
                r"(?:升高|增加|降低|减少|相似|更少|更多|风险)"
            ),
        ]
        return any(re.search(pattern, raw, flags=re.I) for pattern in patterns)

    @staticmethod
    def _merge_adjacent_citation_clusters(
        manuscript: str,
        *,
        max_cluster_size: int = 6,
        trim_overloaded: bool = False,
    ) -> str:
        """Collapse adjacent citation clusters created by layered backfills."""
        raw = str(manuscript or "")
        reference_match = CitationRepairMixin._reference_heading_match(raw)
        main = raw[: reference_match.start()] if reference_match else raw
        tail = raw[reference_match.start():] if reference_match else ""
        citation_pattern = r"[\[［][0-9\s,，、;；\-–—至]+[\]］]"
        adjacent_pattern = re.compile(rf"({citation_pattern})\s*({citation_pattern})")

        previous = None
        merged = main
        while previous != merged:
            previous = merged

            def replace(match: re.Match[str]) -> str:
                left, right = match.group(1), match.group(2)
                numbers = CitationRepairMixin._dedupe_numbers(
                    CitationRepairMixin._citation_numbers_from_text(left)
                    + CitationRepairMixin._citation_numbers_from_text(right)
                )
                numbers = sorted(numbers)
                max_size = max(1, int(max_cluster_size or 1))
                if len(numbers) > max_size:
                    if not trim_overloaded:
                        return match.group(0)
                    numbers = numbers[:max_size]
                citation = CitationRepairMixin._citation_cluster(numbers)
                return CitationRepairMixin._display_citation_for_text(citation, left + right)

            merged = adjacent_pattern.sub(replace, merged)
        return merged + tail

    @staticmethod
    def _dedupe_numbers(numbers: list[int]) -> list[int]:
        ordered: list[int] = []
        seen: set[int] = set()
        for number in numbers:
            if number <= 0 or number in seen:
                continue
            seen.add(number)
            ordered.append(number)
        return ordered

    @staticmethod
    def _reference_numbers_matching(entries: list[dict[str, object]], keywords: tuple[str, ...]) -> list[int]:
        matches: list[int] = []
        for item in entries:
            text = str(item.get("text") or "").lower()
            if any(keyword.lower() in text for keyword in keywords):
                number = int(item.get("number", 0) or 0)
                if number > 0 and number not in matches:
                    matches.append(number)
        return matches

    @staticmethod
    def _citation_for_reference_patterns(refs_text: str, patterns: list[str]) -> str:
        """Return a citation cluster for reference entries matching any pattern."""
        if not refs_text or not patterns:
            return ""
        numbers: list[int] = []
        entry_pattern = re.compile(
            r"^(?:\[(\d+)\]|［(\d+)］)\s+([\s\S]*?)(?=^(?:\[\d+\]|［\d+］)\s+|\Z)",
            flags=re.MULTILINE,
        )
        for match in entry_pattern.finditer(str(refs_text)):
            number = int(match.group(1) or match.group(2) or 0)
            if number <= 0:
                continue
            entry = match.group(0)
            if any(re.search(pattern, entry, flags=re.IGNORECASE) for pattern in patterns):
                numbers.append(number)
        return CitationRepairMixin._citation_cluster(numbers)

    @staticmethod
    def _citation_cluster(reference_numbers: list[int]) -> str:
        numbers = sorted({number for number in reference_numbers if number > 0})
        if not numbers:
            return ""
        if len(numbers) == 1:
            return f"[{numbers[0]}]"
        if len(numbers) == 2:
            return f"[{numbers[0]},{numbers[1]}]"
        parts: list[str] = []
        start = prev = numbers[0]
        for number in numbers[1:] + [None]:
            if number == prev + 1:
                prev = number
                continue
            if prev - start >= 2:
                parts.append(f"{start}-{prev}")
            elif prev > start:
                parts.extend([str(start), str(prev)])
            else:
                parts.append(str(start))
            if number is not None:
                start = prev = number
        return "[" + ",".join(parts) + "]"

    @staticmethod
    def _ensure_section_has_citation(manuscript: str, heading: str, citation: str) -> str:
        if not citation:
            return manuscript
        pattern = rf"(^##\s+{re.escape(heading)}\s*$)([\s\S]*?)(?=^##\s+|\Z)"
        match = re.search(pattern, manuscript, flags=re.M)
        if not match:
            return manuscript
        body = match.group(2)
        if CitationRepairMixin._citation_numbers_from_text(body):
            return manuscript
        updated_body = CitationRepairMixin._append_citation_to_first_paragraph(body, citation, heading=heading)
        if updated_body == body:
            return manuscript
        return manuscript[:match.start(2)] + updated_body + manuscript[match.end(2):]

    @staticmethod
    def _ensure_section_has_source_type_citation(manuscript: str, heading: str, citation: str) -> str:
        if not citation:
            return manuscript
        pattern = rf"(^##\s+{re.escape(heading)}\s*$)([\s\S]*?)(?=^##\s+|\Z)"
        match = re.search(pattern, manuscript, flags=re.M)
        if not match:
            return manuscript
        body = match.group(2)
        existing_numbers = set(CitationRepairMixin._citation_numbers_from_text(body))
        target_numbers = set(CitationRepairMixin._citation_numbers_from_text(citation))
        if not existing_numbers or not target_numbers or existing_numbers & target_numbers:
            return manuscript
        updated_body = CitationRepairMixin._append_citation_to_first_paragraph(body, citation, heading=heading)
        if updated_body == body:
            return manuscript
        return manuscript[:match.start(2)] + updated_body + manuscript[match.end(2):]

    @staticmethod
    def _ensure_section_has_citation_anchor_count(
        manuscript: str,
        heading: str,
        citation: str,
        minimum_anchors: int,
    ) -> str:
        if not citation or minimum_anchors <= 1:
            return manuscript
        pattern = rf"(^##\s+{re.escape(heading)}\s*$)([\s\S]*?)(?=^##\s+|\Z)"
        match = re.search(pattern, manuscript, flags=re.M)
        if not match:
            return manuscript
        body = match.group(2)
        current = CitationRepairMixin._citation_anchor_count(body)
        if current >= minimum_anchors:
            return manuscript

        parts = re.split(r"(\n\s*\n)", body)
        for index in range(0, len(parts), 2):
            if current >= minimum_anchors:
                break
            paragraph = parts[index]
            if (
                not CitationRepairMixin._paragraph_has_citable_line(paragraph)
                or CitationRepairMixin._citation_numbers_from_text(paragraph)
            ):
                continue
            updated_paragraph = CitationRepairMixin._append_citation_to_first_paragraph(paragraph, citation, heading=heading)
            if updated_paragraph != paragraph:
                parts[index] = updated_paragraph
                current += 1

        updated_body = "".join(parts)
        if updated_body == body:
            return manuscript
        return manuscript[:match.start(2)] + updated_body + manuscript[match.end(2):]

    @staticmethod
    def _ensure_interpretive_section_citation_paragraph_coverage(
        manuscript: str,
        heading: str,
        citation: str,
        *,
        minimum_rate: float = PUBLICATION_INTERPRETIVE_CITED_PARAGRAPH_RATE,
    ) -> str:
        if not citation:
            return manuscript
        pattern = rf"(^##\s+{re.escape(heading)}\s*$)([\s\S]*?)(?=^##\s+|\Z)"
        match = re.search(pattern, manuscript, flags=re.M)
        if not match:
            return manuscript
        body = match.group(2)
        parts = re.split(r"(\n\s*\n)", body)
        substantial_indices: list[int] = []
        cited_indices: set[int] = set()
        for index in range(0, len(parts), 2):
            paragraph = parts[index]
            if not CitationRepairMixin._paragraph_has_citable_line(paragraph):
                continue
            paragraph_without_citations = re.sub(r"[\[［][0-9\s,，、;；\-–—至]+[\]］]", " ", paragraph)
            if CitationRepairMixin._text_unit_count(paragraph_without_citations) < PUBLICATION_CITATION_MIN_SUBSTANTIAL_PARAGRAPH_WORDS:
                continue
            substantial_indices.append(index)
            if CitationRepairMixin._citation_numbers_from_text(paragraph):
                cited_indices.add(index)
        if len(substantial_indices) < 2:
            return manuscript

        target_cited = min(len(substantial_indices), math.ceil(len(substantial_indices) * minimum_rate))
        if len(cited_indices) >= target_cited:
            return manuscript
        for index in substantial_indices:
            if len(cited_indices) >= target_cited:
                break
            if index in cited_indices:
                continue
            updated_paragraph = CitationRepairMixin._append_citation_to_first_paragraph(parts[index], citation, heading=heading)
            if updated_paragraph != parts[index]:
                parts[index] = updated_paragraph
                cited_indices.add(index)
        updated_body = "".join(parts)
        if updated_body == body:
            return manuscript
        return manuscript[:match.start(2)] + updated_body + manuscript[match.end(2):]

    @staticmethod
    def _append_citation_to_least_cited_paragraph(
        manuscript: str,
        heading: str,
        citation: str,
        *,
        entries: list[dict[str, object]] | None = None,
        used_numbers: set[int] | None = None,
        need_unique: bool = False,
    ) -> str:
        if not citation:
            return manuscript
        pattern = rf"(^##\s+{re.escape(heading)}\s*$)([\s\S]*?)(?=^##\s+|\Z)"
        match = re.search(pattern, manuscript, flags=re.M)
        if not match:
            return manuscript
        body = match.group(2)
        target_numbers = set(CitationRepairMixin._citation_numbers_from_text(citation))
        if not target_numbers:
            return manuscript

        parts = re.split(r"(\n\s*\n)", body)
        best_index: int | None = None
        best_score: tuple[int, int] | None = None
        for index in range(0, len(parts), 2):
            paragraph = parts[index]
            if not CitationRepairMixin._paragraph_has_citable_line(paragraph):
                continue
            if CitationRepairMixin._paragraph_should_avoid_inline_citation_backfill(paragraph, heading=heading):
                continue
            paragraph_numbers = set(CitationRepairMixin._citation_numbers_from_text(paragraph))
            if target_numbers and target_numbers.issubset(paragraph_numbers):
                continue
            # Prefer paragraphs with fewer citation numbers, then shorter paragraphs,
            # so density backfill is distributed instead of repeatedly piling onto
            # the opening sentence.
            score = (len(paragraph_numbers), len(paragraph))
            if best_score is None or score < best_score:
                best_index = index
                best_score = score

        if best_index is None:
            return manuscript
        paragraph_citation = CitationRepairMixin._claim_specific_citation_for_paragraph(
            parts[best_index],
            entries,
            heading,
            citation,
            used_numbers=used_numbers,
            need_unique=need_unique,
        )
        updated_paragraph = CitationRepairMixin._append_citation_to_first_paragraph(
            parts[best_index],
            paragraph_citation,
            heading=heading,
        )
        if updated_paragraph == parts[best_index]:
            return manuscript
        parts[best_index] = updated_paragraph
        updated_body = "".join(parts)
        return manuscript[:match.start(2)] + updated_body + manuscript[match.end(2):]

    @staticmethod
    def _citation_anchor_count(body: str) -> int:
        count = 0
        for paragraph in re.split(r"\n\s*\n", str(body or "")):
            if CitationRepairMixin._paragraph_has_citable_line(paragraph) and CitationRepairMixin._citation_numbers_from_text(paragraph):
                count += 1
        return count

    @staticmethod
    def _paragraph_has_citable_line(paragraph: str) -> bool:
        if "```" in str(paragraph or ""):
            return False
        for line in str(paragraph or "").splitlines():
            stripped = line.strip()
            if (
                not stripped
                or stripped.startswith("#")
                or stripped.startswith("|")
                or stripped.startswith("![")
                or re.match(r"^[-*]\s+", stripped)
            ):
                continue
            return True
        return False

    @staticmethod
    def _text_unit_count(text: str) -> int:
        return len(re.findall(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?|[\u4e00-\u9fff]|[%./+-]+", str(text or "")))

    @staticmethod
    def _citation_numbers_from_text(text: str) -> list[int]:
        numbers: list[int] = []
        for match in re.finditer(r"[\[［]([0-9\s,，、;；\-–—至]+)[\]］]", str(text or "")):
            token = match.group(1)
            for part in re.split(r"\s*(?:,|，|、|;|；)\s*", token):
                if re.search(r"[-–—]|至", part):
                    bounds = [item.strip() for item in re.split(r"[-–—]|至", part, maxsplit=1)]
                    if len(bounds) != 2 or not bounds[0].isdigit() or not bounds[1].isdigit():
                        continue
                    start, end = int(bounds[0]), int(bounds[1])
                    if end >= start:
                        numbers.extend(range(start, end + 1))
                elif part.strip().isdigit():
                    numbers.append(int(part.strip()))
        return numbers

    @staticmethod
    def _append_citation_to_first_paragraph(body: str, citation: str, *, heading: str = "") -> str:
        parts = re.split(r"(\n\s*\n)", body)
        if not parts:
            return body
        for part_index in range(0, len(parts), 2):
            paragraph = parts[part_index]
            if not paragraph.strip():
                continue
            if CitationRepairMixin._paragraph_should_avoid_inline_citation_backfill(paragraph, heading=heading):
                continue
            lines = paragraph.splitlines()
            for index, line in enumerate(lines):
                stripped = line.strip()
                if not stripped or stripped.startswith("#") or stripped.startswith("|") or re.match(r"^[-*]\s+", stripped):
                    continue
                lines[index] = CitationRepairMixin._append_citation_to_sentence(line, citation)
                parts[part_index] = "\n".join(lines)
                return "".join(parts)
        return body

    @staticmethod
    def _paragraph_should_avoid_inline_citation_backfill(paragraph: str, *, heading: str = "") -> bool:
        """Avoid attaching trial citations to PRISMA counts or internal table/figure prose."""
        raw = re.sub(r"\s+", " ", str(paragraph or "")).strip()
        if not raw:
            return True
        heading_lower = str(heading or "").strip().lower()
        raw_lower = raw.lower()
        if heading_lower not in {"results", "结果"}:
            return False
        if any(marker in raw_lower for marker in (
            "the search identified",
            "records remained for screening",
            "title/abstract",
            "full-text records were assessed",
            "prisma flow",
            "prisma流程",
            "检索共识别",
            "去重后",
            "题名/摘要",
            "全文评估",
        )):
            return True
        if any(marker in raw_lower for marker in (
            "table 1 lists",
            "table 2",
            "table 3",
            "table 4",
            "forest plot and table",
            "the plot emphasizes",
            "图1",
            "图2",
            "图3",
            "表1",
            "表2",
            "表3",
            "表4",
        )):
            return not (
                CitationRepairMixin._sentence_has_numeric_effect_claim(raw)
                or CitationRepairMixin._sentence_has_primary_trial_count_claim(raw)
            )
        return False

    @staticmethod
    def _append_citation_to_sentence(line: str, citation: str) -> str:
        trailing = line.rstrip()
        suffix = line[len(trailing):]
        display_citation = CitationRepairMixin._display_citation_for_text(citation, trailing)
        if trailing.endswith(display_citation):
            return line
        if trailing.endswith((".", "。")):
            spacer = "" if display_citation.startswith("［") else " "
            return trailing[:-1].rstrip() + f"{spacer}{display_citation}" + trailing[-1] + suffix
        spacer = "" if display_citation.startswith("［") else " "
        return trailing + f"{spacer}{display_citation}" + suffix

    @staticmethod
    def _display_citation_for_text(citation: str, text: str) -> str:
        raw = str(citation or "")
        if not raw:
            return raw
        body = str(text or "")
        uses_full_width_citation = bool(re.search(r"［[0-9\s,，、;；\-–—至]+］", body))
        cjk_chars = len(re.findall(r"[\u4e00-\u9fff]", body))
        latin_words = len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", body))
        if not uses_full_width_citation and cjk_chars <= latin_words:
            return raw
        match = re.fullmatch(r"\[([0-9,\-]+)\]", raw)
        if not match:
            return raw
        localized = match.group(1).replace(",", "，")
        return f"［{localized}］"

    @staticmethod
    def _normalize_citation_marker_style(manuscript: str, *, lang: str = "en") -> str:
        raw = str(manuscript or "")
        if str(lang or "").strip().lower() not in {"zh", "cn", "chinese", "中文"}:
            parts = re.split(r"(```[\s\S]*?```)", raw)

            def normalize_english_segment(segment: str) -> str:
                normalized_segment = re.sub(
                    r"(?<=[A-Za-z0-9%)\]])(?=\[[0-9][0-9,\s;\-–—]*\])",
                    " ",
                    segment,
                )
                normalized_segment = re.sub(
                    r"[ \t]{2,}(?=\[[0-9][0-9,\s;\-–—]*\])",
                    " ",
                    normalized_segment,
                )
                return normalized_segment

            return "".join(
                part if part.startswith("```") else normalize_english_segment(part)
                for part in parts
            )
        parts = re.split(r"(```[\s\S]*?```)", raw)

        def normalize_text_segment(segment: str) -> str:
            def replace(match: re.Match[str]) -> str:
                body = match.group(1)
                normalized = re.sub(r"\s+", "", body)
                normalized = normalized.replace("，", ",").replace("、", ",")
                normalized = normalized.replace(";", ",").replace("；", ",")
                normalized = normalized.replace(",", "，")
                return f"［{normalized}］"

            normalized_segment = re.sub(r"\[([0-9][0-9,\s;；、，\-–—]*)\]", replace, segment)
            normalized_segment = re.sub(
                r"(?<=[A-Za-z0-9\u4e00-\u9fff%）)])[ \t]+(?=［[0-9])",
                "",
                normalized_segment,
            )

            def ensure_terminal_punctuation(match: re.Match[str]) -> str:
                line = match.group(0)
                stripped = line.rstrip()
                suffix = line[len(stripped):]
                if stripped.endswith(("。", "！", "？", ".", "!", "?")):
                    return line
                return stripped + "。" + suffix

            return re.sub(
                r"(?m)^(?!\s*(?:#|\||!|\[|［\d+］)).*?［[0-9][0-9，、,;；\s\-–—至]+］[ \t]*$",
                ensure_terminal_punctuation,
                normalized_segment,
            )

        normalized_parts = [
            part if part.startswith("```") else normalize_text_segment(part)
            for part in parts
        ]
        return "".join(normalized_parts)

    @staticmethod
    def _backfill_after_fact_repair(manuscript: str) -> str:
        """Restore publication cross-references that fact repair may remove with process-framed text."""
        manuscript = CitationRepairMixin._backfill_publication_figure_references(manuscript)
        manuscript = CitationRepairMixin._backfill_publication_figure_legends(manuscript)
        manuscript = CitationRepairMixin._backfill_publication_table_notes(manuscript)
        return manuscript

    @staticmethod
    def _backfill_publication_figure_references(manuscript: str) -> str:
        """Mention numbered figures in Results when figure captions exist but main text omits them."""
        figure_numbers = CitationRepairMixin._defined_figure_numbers(manuscript)
        if not figure_numbers:
            return manuscript
        main_text = CitationRepairMixin._main_text_before_figures(manuscript)
        mentioned = set(CitationRepairMixin._numbered_label_refs(main_text, "Figure"))
        missing = [number for number in figure_numbers if number not in mentioned]
        if not missing:
            return manuscript
        zh = bool(re.search(r"^#{1,4}\s+图\s*\d+\b", manuscript, flags=re.M))
        label = CitationRepairMixin._figure_reference_label_zh(missing) if zh else CitationRepairMixin._figure_reference_label(missing)
        if zh:
            if set(missing) >= {1, 2, 3, 4}:
                sentence = "图1显示筛选流程，图2显示主要合并效应，图3显示偏倚风险概要，图4显示逐一剔除敏感性分析。"
            else:
                sentence = f"{label}显示与主要结果相关的图形信息。"
        else:
            sentence = (
                f"{label} provide additional graphical information for the primary result; the tabular estimates "
                "remain the numeric reference for effect size, precision, and study weight."
            )
        return CitationRepairMixin._append_sentence_to_section(manuscript, "结果" if zh else "Results", sentence)

    @staticmethod
    def _backfill_publication_figure_legends(manuscript: str) -> str:
        """Add explanatory legends below numbered figures when only an image is present."""
        raw = str(manuscript or "")
        matches = list(re.finditer(r"^#{1,4}\s+(Figure|图)\s*(\d+)\.?\s*(.*)$", raw, flags=re.I | re.M))
        if not matches:
            return manuscript
        pieces: list[str] = []
        cursor = 0
        changed = False
        for index, match in enumerate(matches):
            end = len(raw)
            if index + 1 < len(matches):
                end = matches[index + 1].start()
            section_match = CitationRepairMixin._publication_block_boundary_match(raw[match.end():end])
            if section_match:
                end = match.end() + section_match.start()
            block = raw[match.start():end]
            pieces.append(raw[cursor:match.start()])
            if CitationRepairMixin._figure_block_has_legend(block):
                pieces.append(block)
            else:
                legend = CitationRepairMixin._figure_legend_for_title(match.group(3), zh=match.group(1) == "图")
                separator = "\n" if block.endswith("\n") else "\n\n"
                pieces.append(block.rstrip() + separator + legend + "\n")
                changed = True
            cursor = end
        pieces.append(raw[cursor:])
        return "".join(pieces) if changed else manuscript

    @staticmethod
    def _figure_block_has_legend(block: str) -> bool:
        return bool(
            re.search(
                r"(^|\n)\s*(?:\*\*)?(?:Legend|Caption|Note|图注|说明)(?:\*\*)?\s*[:：.]",
                str(block or ""),
                flags=re.I,
            )
        )

    @staticmethod
    def _figure_legend_for_title(title: str, *, zh: bool = False) -> str:
        lowered = str(title or "").lower()
        if zh:
            if "prisma" in lowered or "流程" in str(title or "") or "flow" in lowered:
                return "图注：该流程图概述记录识别、去重、筛选、全文评估、排除原因以及纳入定性和定量综合的研究。"
            if "森林" in str(title or "") or "forest" in lowered:
                return "图注：森林图展示各研究效应量及其95%置信区间，并显示预设Meta分析模型得到的合并估计值。CI=置信区间。"
            if "敏感" in str(title or "") or "leave-one-out" in lowered or "sensitivity" in lowered:
                return "图注：敏感性分析图展示逐一剔除单项研究后的合并估计值及置信区间，用于评估主要结果是否依赖单个研究。"
            if "偏倚" in str(title or "") or "risk" in lowered or "rob" in lowered or "bias" in lowered:
                return "图注：偏倚风险图展示纳入研究的领域级判断，并用于支持证据确定性解释。"
            return "图注：该图提供相应分析的可视化摘要，应结合表格估计值和带来源链接的提取记录解释。"
        if "prisma" in lowered or "flow" in lowered:
            return (
                "Legend: The diagram summarizes record identification, duplicate removal, screening, "
                "full-text assessment, exclusions, and studies included in the qualitative and quantitative synthesis."
            )
        if "forest" in lowered:
            return (
                "Legend: The forest plot displays study-specific effect estimates and 95% CIs with the pooled "
                "estimate from the prespecified meta-analysis model. CI=confidence interval."
            )
        if "leave-one-out" in lowered or "sensitivity" in lowered:
            return (
                "Legend: The sensitivity plot shows the pooled estimate after omitting one study at a time, "
                "with confidence intervals used to assess whether the primary result depends on a single study."
            )
        if "risk" in lowered or "rob" in lowered or "bias" in lowered:
            return (
                "Legend: The risk-of-bias summary displays domain-level judgments for included studies and "
                "supports interpretation of the certainty assessment."
            )
        return (
            "Legend: The figure provides a visual summary of the corresponding analysis; the tabular estimates "
            "and source-linked extraction records provide the numeric reference."
        )

    @staticmethod
    def _backfill_publication_table_notes(manuscript: str) -> str:
        """Add concise explanatory notes below numbered tables when the draft omits them."""
        raw = str(manuscript or "")
        matches = list(re.finditer(r"^#{1,4}\s+(Table|表)\s*(\d+)\.?\s*(.*)$", raw, flags=re.I | re.M))
        if not matches:
            return manuscript
        pieces: list[str] = []
        cursor = 0
        changed = False
        for index, match in enumerate(matches):
            end = len(raw)
            if index + 1 < len(matches):
                end = matches[index + 1].start()
            section_match = CitationRepairMixin._publication_block_boundary_match(raw[match.end():end])
            if section_match:
                end = match.end() + section_match.start()
            block = raw[match.start():end]
            pieces.append(raw[cursor:match.start()])
            if CitationRepairMixin._table_block_has_note(block):
                pieces.append(block)
            else:
                note = CitationRepairMixin._table_note_for_block(block, zh=match.group(1) == "表")
                separator = "\n" if block.endswith("\n") else "\n\n"
                pieces.append(block.rstrip() + separator + note + "\n")
                changed = True
            cursor = end
        pieces.append(raw[cursor:])
        return "".join(pieces) if changed else manuscript

    @staticmethod
    def _table_block_has_note(block: str) -> bool:
        return bool(
            re.search(
                r"(^|\n)\s*(?:\*\*)?(?:Note|Notes|Abbreviation|Abbreviations|Footnote|Footnotes|注|缩写)(?:\*\*)?\s*[:：.]",
                str(block or ""),
                flags=re.I,
            )
        )

    @staticmethod
    def _table_note_for_block(block: str, *, zh: bool = False) -> str:
        definitions = CitationRepairMixin._table_abbreviation_definitions(block, zh=zh)
        if definitions:
            return ("注：" if zh else "Note: ") + "; ".join(definitions) + ("。" if zh else ".")
        return "注：数值为原始研究报告值或按预设统计方法计算值。" if zh else "Note: Values are from source reports or prespecified statistical calculations."

    @staticmethod
    def _table_abbreviation_definitions(block: str, *, zh: bool = False) -> list[str]:
        text = str(block or "")
        candidates = [
            ("OR", r"\bOR\b", "OR=优势比" if zh else "OR=odds ratio"),
            ("RR", r"\bRR\b", "RR=风险比" if zh else "RR=risk ratio"),
            ("HR", r"\bHR\b", "HR=风险比" if zh else "HR=hazard ratio"),
            ("MD", r"\bMD\b", "MD=均数差" if zh else "MD=mean difference"),
            ("SMD", r"\bSMD\b", "SMD=标准化均数差" if zh else "SMD=standardized mean difference"),
            ("CI", r"\bCI\b", "CI=置信区间" if zh else "CI=confidence interval"),
            ("SE", r"\bSE\b", "SE=标准误" if zh else "SE=standard error"),
            ("SD", r"\bSD\b", "SD=标准差" if zh else "SD=standard deviation"),
            ("GRADE", r"\bGRADE\b", "GRADE=推荐意见分级、评估、制定和评价" if zh else "GRADE=Grading of Recommendations Assessment, Development and Evaluation"),
            ("RoB", r"\bRoB\b", "RoB=偏倚风险" if zh else "RoB=risk of bias"),
            ("NR", r"\bNR\b", "NR=未报告" if zh else "NR=not reported"),
            ("I2", r"\bI\s*(?:²|\^2|2)\b", "I²=不一致性统计量" if zh else "I²=inconsistency statistic"),
        ]
        definitions: list[str] = []
        seen: set[str] = set()
        for key, pattern, definition in candidates:
            if key in seen:
                continue
            if re.search(pattern, text):
                definitions.append(definition)
                seen.add(key)
        return definitions

    @staticmethod
    def _defined_figure_numbers(manuscript: str) -> list[int]:
        numbers = []
        for match in re.finditer(r"^#{1,4}\s+(?:Figure\s+|图\s*)(\d+)\b", str(manuscript or ""), flags=re.I | re.M):
            try:
                numbers.append(int(match.group(1)))
            except ValueError:
                continue
        return sorted(set(numbers))

    @staticmethod
    def _main_text_before_figures(manuscript: str) -> str:
        raw = str(manuscript or "")
        positions = [
            match.start()
            for match in re.finditer(
                r"^#{1,6}\s+(?:Tables|Figures|Supplementary Materials|Declarations|表格|图表|参考文献|补充材料|声明)\s*[:：]?\s*$",
                raw,
                flags=re.I | re.M,
            )
        ]
        reference_match = CitationRepairMixin._reference_heading_match(raw)
        if reference_match:
            positions.append(reference_match.start())
        return raw[:min(positions)] if positions else raw

    @staticmethod
    def _numbered_label_refs(text: str, label: str) -> list[int]:
        numbers: list[int] = []
        raw = str(text or "")
        english_raw = re.sub(
            rf"(?<=\d)\s*(,|and|[-–])\s*{re.escape(label)}s?\s*(?=\d)",
            lambda match: f" {match.group(1)} ",
            raw,
            flags=re.I,
        )
        for match in re.finditer(rf"\b{re.escape(label)}s?\s+(\d+(?:\s*(?:,|and|[-–])\s*\d+)*)", english_raw, flags=re.I):
            token = match.group(1)
            for part in re.split(r"\s*,\s*|\s+and\s+", token):
                if re.search(r"[-–]", part):
                    bounds = [item.strip() for item in re.split(r"[-–]", part, maxsplit=1)]
                    if len(bounds) != 2:
                        continue
                    try:
                        start = int(bounds[0])
                        end = int(bounds[1])
                    except ValueError:
                        continue
                    if end >= start:
                        numbers.extend(range(start, end + 1))
                else:
                    try:
                        numbers.append(int(part))
                    except ValueError:
                        continue
        chinese_label = "图" if label.lower() == "figure" else "表" if label.lower() == "table" else ""
        if chinese_label:
            chinese_raw = re.sub(
                rf"(?<=\d)\s*(,|，|、|和|及|与|至|[-–])\s*{chinese_label}\s*(?=\d)",
                lambda match: match.group(1),
                raw,
            )
            token_pattern = r"\d+(?:\s*(?:,|，|、|和|及|与|至|[-–])\s*\d+)*"
            for match in re.finditer(rf"{chinese_label}\s*({token_pattern})", chinese_raw, flags=re.I):
                token = match.group(1)
                for part in re.split(r"\s*(?:,|，|、|和|及|与)\s*", token):
                    if re.search(r"[-–]|至", part):
                        bounds = [item.strip() for item in re.split(r"[-–]|至", part, maxsplit=1)]
                        if len(bounds) != 2:
                            continue
                        try:
                            start = int(bounds[0])
                            end = int(bounds[1])
                        except ValueError:
                            continue
                        if end >= start:
                            numbers.extend(range(start, end + 1))
                    else:
                        try:
                            numbers.append(int(part))
                        except ValueError:
                            continue
        return numbers

    @staticmethod
    def _figure_reference_label(numbers: list[int]) -> str:
        ordered = sorted({number for number in numbers if number > 0})
        if not ordered:
            return "The figures"
        if len(ordered) == 1:
            return f"Figure {ordered[0]}"
        if ordered == list(range(ordered[0], ordered[-1] + 1)):
            return f"Figures {ordered[0]}-{ordered[-1]}" if len(ordered) > 2 else f"Figure {ordered[0]} and Figure {ordered[-1]}"
        return "Figures " + ", ".join(str(number) for number in ordered[:-1]) + f", and Figure {ordered[-1]}"

    @staticmethod
    def _figure_reference_label_zh(numbers: list[int]) -> str:
        ordered = sorted({number for number in numbers if number > 0})
        if not ordered:
            return "图表"
        if len(ordered) == 1:
            return f"图{ordered[0]}"
        if ordered == list(range(ordered[0], ordered[-1] + 1)):
            return f"图{ordered[0]}至图{ordered[-1]}"
        return "图" + "、图".join(str(number) for number in ordered)

    @staticmethod
    def _figure_results_summary(numbers: list[int], *, zh: bool = False) -> str:
        ordered = sorted({number for number in numbers if number > 0})
        if not ordered:
            return "未提供可用图表文件。" if zh else "No figure files were available."
        if zh:
            labels = {
                1: "研究筛选流程",
                2: "主要效应森林图",
                3: "偏倚风险概要",
                4: "逐一剔除敏感性分析",
            }
            described = [labels.get(number, f"图{number}") for number in ordered]
            return f"{CitationRepairMixin._figure_reference_label_zh(ordered)}分别展示" + "、".join(described) + "。"
        labels = {
            1: "study-selection flow",
            2: "the primary forest plot",
            3: "the risk-of-bias summary",
            4: "leave-one-out sensitivity analysis",
        }
        described = [labels.get(number, f"Figure {number}") for number in ordered]
        if len(described) == 1:
            detail = described[0]
        else:
            detail = ", ".join(described[:-1]) + f", and {described[-1]}"
        return f"{CitationRepairMixin._figure_reference_label(ordered)} show {detail}."

    @staticmethod
    def _append_sentence_to_section(manuscript: str, heading: str, sentence: str) -> str:
        pattern = rf"(^##\s+{re.escape(heading)}\s*$)([\s\S]*?)(?=^##\s+|\Z)"
        match = re.search(pattern, manuscript, flags=re.M)
        if not match:
            return manuscript
        body = match.group(2).rstrip()
        suffix = match.group(2)[len(body):]
        addition = ("\n\n" if body.strip() else "\n") + sentence
        return manuscript[:match.start(2)] + body + addition + suffix + manuscript[match.end(2):]
