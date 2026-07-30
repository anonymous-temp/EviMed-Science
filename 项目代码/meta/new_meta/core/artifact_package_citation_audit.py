"""Citation coverage audit helpers for artifact packages."""
from __future__ import annotations

import re
from typing import Any, Iterable

from new_meta.core.artifact_package_language import (
    is_zh_review_language as _is_zh_review_language,
    normalize_review_language as _normalize_review_language,
)
from new_meta.core.manuscript_text_metrics import (
    main_publication_word_count,
    publication_min_main_words,
)
from new_meta.core.project import Project
from new_meta.core.reference_classification import (
    reference_entry_looks_like_numeric_effect_source as _shared_reference_entry_looks_like_numeric_effect_source,
    reference_entry_source_types,
)


CITATION_AUDIT_FORMAL_MIN_WORDS = 500
CITATION_AUDIT_MIN_REFERENCES = 12
CITATION_AUDIT_PUBLICATION_MIN_REFERENCES = 20
CITATION_AUDIT_MIN_UNIQUE_CITED_REFERENCES = 6
CITATION_AUDIT_MIN_DENSITY_PER_1000_WORDS = 6.0
CITATION_AUDIT_MAX_DENSITY_PER_1000_WORDS = 35.0
CITATION_AUDIT_MIN_SUBSTANTIAL_PARAGRAPH_WORDS = 35
CITATION_AUDIT_MIN_INTERPRETIVE_SECTION_CITED_PARAGRAPH_RATE = 0.67
CITATION_AUDIT_MIN_SECTION_CONTEXT_CITATIONS = 2
CITATION_AUDIT_MAX_INLINE_CLUSTER_SIZE = 5
CITATION_AUDIT_MECHANICAL_DENSITY_SECTIONS = {"Discussion", "Conclusion"}
CITATION_AUDIT_MECHANICAL_DENSITY_MIN_MARKERS = 3
CITATION_AUDIT_MECHANICAL_DENSITY_MIN_TEXT_UNITS = 35
CITATION_AUDIT_MECHANICAL_DENSITY_MAX_MARKERS_PER_35_UNITS = 1.5
CITATION_AUDIT_REPEATED_CLUSTER_MIN_SIZE = 4
CITATION_AUDIT_REPEATED_CLUSTER_MIN_OCCURRENCES = 2
CITATION_AUDIT_BACKGROUND_SOURCE_TYPES = {
    "guide",
    "paper",
    "guideline",
    "clinical_guideline",
    "prior_review",
    "systematic_review",
    "pubmed_background",
}
CITATION_AUDIT_BACKGROUND_SOURCE_TYPES_BY_CLAIM = {
    "disease_burden": ["pubmed_background", "prior_review", "systematic_review"],
    "guideline_context": ["clinical_guideline", "guideline"],
    "prior_evidence": ["prior_review", "systematic_review", "pubmed_background"],
}
CITATION_AUDIT_METHODOLOGY_SOURCE_TYPES = {
    "reporting_guideline",
    "methods_handbook",
    "risk_of_bias_tool",
    "certainty_framework",
    "statistical_method",
    "publication_bias_method",
}
CITATION_AUDIT_DISCUSSION_METHODOLOGY_SOURCE_TYPES = {
    "certainty_framework",
    "publication_bias_method",
}
CITATION_AUDIT_NUMERIC_EFFECT_SOURCE_TYPES = {
    "included_trial",
    "trial_report",
    "registry_results",
    "clinical_trial",
}
CITATION_AUDIT_SECTION_HEADINGS = {
    "Introduction": ["Introduction", "Intro", "Background", "引言", "绪论", "前言", "背景"],
    "Methods": ["Methods", "Method", "Materials and Methods", "方法", "材料与方法", "研究方法"],
    "Results": ["Results", "Findings", "结果", "研究结果"],
    "Discussion": ["Discussion", "讨论"],
    "Conclusion": ["Conclusion", "Conclusions", "结论", "结语"],
}
SGLT2_TEXT_PATTERN = (
    r"\b(?:sglt2|sglt-2|gliflozin|empagliflozin|dapagliflozin|canagliflozin|"
    r"ertugliflozin|sotagliflozin)\b|"
    r"\bsodium[- ]glucose\s+(?:co-?transporter|cotransporter)[- ]?2\b|"
    r"\bsodium[- ]glucose\s+(?:co-?transporter|cotransporter)[- ]two\b"
)


def _number_or_none(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _integer_or_none(value: Any) -> int | None:
    number = _number_or_none(value)
    return int(number) if number is not None else None


def _canonical_publication_heading(heading: str) -> str:
    raw = str(heading or "").strip().lower()
    compact = re.sub(r"[\s\-_/·:：,，、;；()（）]+", "", raw)
    zh_map = {
        "摘要": "abstract",
        "引言": "introduction",
        "绪论": "introduction",
        "前言": "introduction",
        "背景": "introduction",
        "背景目的": "introduction",
        "背景与目的": "introduction",
        "目的": "introduction",
        "研究背景": "introduction",
        "研究目的": "introduction",
        "方法": "methods",
        "材料与方法": "methods",
        "资料与方法": "methods",
        "对象与方法": "methods",
        "研究方法": "methods",
        "结果": "results",
        "研究结果": "results",
        "讨论": "discussion",
        "结论": "conclusion",
        "结论与意义": "conclusion",
        "结语": "conclusion",
    }
    if compact in zh_map:
        return zh_map[compact]
    if re.search(r"[一-鿿]", raw):
        if "方法" in compact:
            return "methods"
        if "结果" in compact:
            return "results"
        if "讨论" in compact:
            return "discussion"
        if "结论" in compact:
            return "conclusion"
        if "引言" in compact or "绪论" in compact or "前言" in compact or "背景" in compact:
            return "introduction"
    if re.search(r"(?:abstract|summary)", raw):
        return "abstract"
    if re.search(r"(?:introduction|intro|background|rationale|objectives?|aims?)", raw):
        return "introduction"
    if re.search(r"(?:methods?|materials\s+and\s+methods|methodology|statistical\s+analysis)", raw):
        return "methods"
    if re.search(r"(?:results?|findings)", raw):
        return "results"
    if re.search(r"discussion", raw):
        return "discussion"
    if re.search(r"(?:conclusions?|conclusions\s+and\s+relevance)", raw):
        return "conclusion"
    return raw


def _markdown_section_text(text: str, heading: str) -> str:
    raw = str(text or "")
    match = re.search(rf"^##\s+{re.escape(heading)}\s*$", raw, flags=re.I | re.M)
    if not match:
        return ""
    remainder = raw[match.end():]
    next_heading = re.search(r"^##\s+", remainder, flags=re.M)
    return remainder[: next_heading.start()] if next_heading else remainder


def _section_can_omit_inline_citation(section: str, section_text: str, facts: dict[str, Any]) -> bool:
    """Allow uncited sections when no external claim support is required."""
    if not str(section_text or "").strip():
        return False
    claim_map = facts.get("claim_map") if isinstance(facts, dict) else None
    has_claim_map = isinstance(claim_map, list) and bool(claim_map)
    if has_claim_map and not _section_requires_external_claim_citation(section, facts, section_text=section_text):
        return True
    if str(section or "").strip().lower() != "conclusion":
        return False
    conclusion_sentences = [
        sentence for sentence in _prose_sentences(section_text)
        if not _paragraph_is_nonprose_block(sentence)
    ]
    if conclusion_sentences and all(
        (
            not _conclusion_result_claim_types(sentence)
            or _sentence_is_internal_analysis_output(sentence, facts)
        )
        for sentence in conclusion_sentences
    ):
        return True
    if not has_claim_map:
        return False
    conclusion_claims = [
        item for item in claim_map
        if isinstance(item, dict)
        and _canonical_publication_heading(str(item.get("section") or "")) == "conclusion"
        and str(item.get("claim") or "").strip()
        and str(item.get("manuscript_use") or "main_text") != "exclude"
    ]
    if not conclusion_claims:
        return False
    return all(_claim_is_internal_analysis_summary(item) for item in conclusion_claims)


def _section_requires_external_claim_citation(
    section: str,
    facts: dict[str, Any],
    *,
    section_text: str = "",
) -> bool:
    """Return True when the claim map/background evidence says this section uses external sources."""
    if not isinstance(facts, dict):
        return False
    canonical = _canonical_publication_heading(section)
    claim_map = facts.get("claim_map")
    if isinstance(claim_map, list) and claim_map:
        for item in claim_map:
            if not isinstance(item, dict):
                continue
            if _canonical_publication_heading(str(item.get("section") or "")) != canonical:
                continue
            if str(item.get("manuscript_use") or "main_text") == "exclude":
                continue
            if not _claim_is_internal_analysis_summary(item):
                return True
        return False
    citation_context = facts.get("_citation_context")
    if isinstance(citation_context, dict):
        if canonical == "introduction" and citation_context.get("has_background_references"):
            return True
        if canonical == "methods" and citation_context.get("has_methodology_references"):
            return True
        if canonical == "discussion" and citation_context.get("has_discussion_references"):
            return True
    if canonical == "methods" and _methods_text_makes_methodology_claim(section_text):
        return True
    if canonical == "introduction":
        background = facts.get("background_evidence")
        if isinstance(background, dict) and background.get("references"):
            return True
    if canonical == "discussion":
        controversies = facts.get("domain_controversy_candidates")
        if isinstance(controversies, list) and controversies:
            return True
    return False


def _methods_text_makes_methodology_claim(section_text: str) -> bool:
    """Detect broad methods claims that need a reporting/statistical source."""
    text = str(section_text or "").lower()
    if not text.strip():
        return False
    methodology_terms = (
        "prisma",
        "searched",
        "search strategy",
        "screened",
        "eligibility criteria",
        "risk of bias",
        "grade",
        "meta-analysis",
        "random-effects",
        "fixed-effect",
        "inverse-variance",
        "检索",
        "筛选",
        "纳入标准",
        "排除标准",
        "偏倚风险",
        "证据分级",
        "固定效应",
        "随机效应",
    )
    return any(term in text for term in methodology_terms)


def _claim_is_internal_analysis_summary(claim: dict[str, Any]) -> bool:
    support = re.sub(r"[^a-z0-9]+", "", str(claim.get("support_source") or "").lower())
    location = re.sub(r"[^a-z0-9]+", "", str(claim.get("source_location") or "").lower())
    external_tokens = (
        "pubmedbackground",
        "backgroundevidence",
        "guideline",
        "priorreview",
        "systematicreview",
        "trialregistry",
        "endpointdefinition",
        "studycards",
    )
    if any(token in support or token in location for token in external_tokens):
        return False
    internal_tokens = (
        "protocolpico",
        "pico",
        "researchquestion",
        "primaryeffect",
        "primarypopulation",
        "metaanalysis",
        "metares",
        "gradecertainty",
        "gradesummary",
        "gradedomain",
        "gradelimitation",
        "gradepublicationbias",
        "publicationbias",
        "studycount",
        "smallstudyeffect",
        "evidencereadinessselectedprimaryrows",
    )
    return any(token in support or token in location for token in internal_tokens)


def _markdown_first_section_text(text: str, headings: list[str]) -> str:
    for heading in headings:
        section = _markdown_section_text(text, heading)
        if section:
            return section
    wanted = {_canonical_publication_heading(heading) for heading in headings}
    for section_heading, section_text in _markdown_h2_sections(text):
        if _canonical_publication_heading(section_heading) in wanted:
            return section_text
    return ""


def _markdown_h2_sections(text: str) -> list[tuple[str, str]]:
    raw = str(text or "")
    matches = list(re.finditer(r"^##\s+(.+?)\s*$", raw, flags=re.M))
    sections: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(raw)
        sections.append((match.group(1).strip(), raw[start:end]))
    return sections


def _strip_markdown_code_fences(text: str) -> str:
    return re.sub(r"```.*?```", "", str(text or ""), flags=re.S)


def _main_article_text_before_supplement(text: str) -> str:
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
    reference_match = _reference_heading_match(raw)
    if reference_match:
        cut_points.append(reference_match.start())
    return raw[: min(cut_points)] if cut_points else raw


def _main_manuscript_word_count(text: str) -> int:
    return main_publication_word_count(text)


def _validation_main_word_count(text: str, facts: dict[str, Any]) -> int:
    try:
        from new_meta.core.manuscript_facts import validate_and_repair_manuscript

        _, validation = validate_and_repair_manuscript(text, facts)
        return int((validation.get("facts_summary") or {}).get("main_word_count") or _main_manuscript_word_count(text))
    except Exception:
        return _main_manuscript_word_count(text)


def _text_unit_count(text: str) -> int:
    raw = str(text or "")
    return len(re.findall(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?|[一-鿿]|[%./+-]+", raw))


def _references_section_text(text: str) -> str:
    raw = str(text or "")
    match = _reference_heading_match(raw)
    if not match:
        return ""
    remainder = raw[match.end():]
    next_heading = re.search(r"^#{1,6}\s+", remainder, flags=re.M)
    return remainder[: next_heading.start()] if next_heading else remainder


def _main_text_before_reference_section(text: str) -> str:
    raw = str(text or "")
    match = _reference_heading_match(raw)
    return raw[: match.start()] if match else raw


def _reference_heading_match(text: str) -> re.Match[str] | None:
    reference_heading = (
        r"(?:"
        r"References?|Bibliography|Literature\s+Cited|Works\s+Cited|"
        r"参考文献|参考资料|引用文献|文献"
        r")"
    )
    return re.search(rf"^#{{1,6}}\s+{reference_heading}\s*[:：]?\s*$", str(text or ""), flags=re.I | re.M)


def _language_detection_text(text: str) -> str:
    raw = _main_text_before_reference_section(str(text or ""))
    raw = re.sub(r"```[\s\S]*?```", " ", raw)
    kept_lines: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            kept_lines.append(line)
            continue
        if stripped.startswith("|") or stripped.startswith("!["):
            continue
        kept_lines.append(line)
    return "\n".join(kept_lines)


def _review_language_from_text(text: str) -> str:
    raw = _language_detection_text(str(text or ""))
    cjk_chars = len(re.findall(r"[一-鿿]", raw))
    latin_letters = len(re.findall(r"[A-Za-z]", raw))
    if cjk_chars >= 10 and latin_letters >= 200:
        cjk_share = cjk_chars / max(1, cjk_chars + latin_letters)
        if 0.01 <= cjk_share <= 0.80:
            return "mixed"
    latin_words = len(re.findall(r"[A-Za-z][A-Za-z'-]*", raw))
    return "zh" if cjk_chars and cjk_chars >= latin_words else "en"


def _expected_manuscript_language(project: Project, facts: dict[str, Any] | None = None) -> str:
    facts = facts if isinstance(facts, dict) else {}
    candidates = [
        facts.get("output_language"),
        facts.get("manuscript_language"),
        facts.get("language"),
    ]
    try:
        language_record = project.load_json("manuscript_output_language.json", subdir="manuscript")
    except Exception:
        language_record = None
    if isinstance(language_record, dict):
        candidates.extend([
            language_record.get("expected_language"),
            language_record.get("output_language"),
            language_record.get("language"),
        ])
    for candidate in candidates:
        normalized = _normalize_review_language(candidate)
        if normalized:
            return normalized
    return ""


def _infer_project_review_language(project: Project, facts: dict[str, Any] | None = None) -> str:
    facts = facts if isinstance(facts, dict) else project.load_json("manuscript_facts.json", subdir="manuscript")
    if not isinstance(facts, dict):
        facts = {}
    draft_path = project.base_dir / "manuscript" / "draft.md"
    draft_text = ""
    if draft_path.exists():
        try:
            draft_text = draft_path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            draft_text = ""
    return _expected_manuscript_language(project, facts) or _review_language_from_text(draft_text)


def _reference_entry_count(references_text: str) -> int:
    text = str(references_text or "")
    numbered = re.findall(r"^\s*(?:\[\d+\]|［\d+］)\s+\S", text, flags=re.M)
    bullets = re.findall(r"^\s*[-*]\s+\S", text, flags=re.M)
    bib = re.findall(r"@\w+\s*\{", text)
    return len(numbered) + len(bullets) + len(bib)


def _publication_min_main_words(facts: dict[str, Any]) -> int:
    return publication_min_main_words(facts)


def _has_publication_section_shape(text: str) -> bool:
    headings = {
        _canonical_publication_heading(match.group(1))
        for match in re.finditer(r"^#{1,3}\s+(.+?)\s*$", str(text or ""), flags=re.M)
    }
    required = {"abstract", "introduction", "methods", "results", "discussion"}
    return required.issubset(headings)


def _pooled_study_count(facts: dict[str, Any]) -> int:
    """How many studies the primary synthesis actually rests on."""
    if not isinstance(facts, dict):
        return 0
    readiness = facts.get("evidence_readiness") or {}
    primary = facts.get("primary_effect") or {}
    selected_rows = readiness.get("selected_primary_rows") or []
    return _coerce_int(primary.get("n_studies")) or len(selected_rows)


def _publication_min_references(facts: dict[str, Any]) -> int:
    """Scale the reference requirement to the evidence the review actually has.

    A review that pooled three trials cannot reach a flat twenty references
    without padding its background, which is how a citation counter turns into
    an instruction to pad. Ask for the general floor plus one per included
    study, and never more than the full publication target.
    """
    pooled = _pooled_study_count(facts)
    if pooled <= 0:
        # No visible evidence base: a formal draft of this length still has to
        # meet the full target rather than benefit from what we cannot see.
        return CITATION_AUDIT_PUBLICATION_MIN_REFERENCES
    return max(
        CITATION_AUDIT_MIN_REFERENCES,
        min(CITATION_AUDIT_PUBLICATION_MIN_REFERENCES, CITATION_AUDIT_MIN_REFERENCES + pooled),
    )


def _requires_publication_length_gate(facts: dict[str, Any]) -> bool:
    if not isinstance(facts, dict) or facts.get("report_type") != "meta":
        return False
    readiness = facts.get("evidence_readiness") or {}
    if readiness.get("blockers"):
        return False
    return _pooled_study_count(facts) >= 2


def _requires_publication_reference_depth_gate(facts: dict[str, Any], draft_text: str, main_word_count: int) -> bool:
    if _requires_publication_length_gate(facts):
        return True
    if isinstance(facts, dict) and facts.get("report_type") and facts.get("report_type") != "meta":
        return False
    minimum_words = _publication_min_main_words(facts if isinstance(facts, dict) else {})
    return main_word_count >= minimum_words and _has_publication_section_shape(draft_text)


def _should_use_chinese_citation_style(text: str, language: str) -> bool:
    if _is_zh_review_language(language):
        return True
    raw = str(text or "")
    return bool(re.search(r"^#*\s*参考文献\s*$", raw, flags=re.M)) or bool(
        re.search(r"[一-鿿]", _main_text_before_reference_section(raw))
    )


def _ascii_numeric_citation_marker_number_count_outside_code(text: str) -> int:
    outside_code = re.sub(r"```[\s\S]*?```", " ", str(text or ""))
    count = 0
    for match in re.finditer(r"\[([0-9][0-9,\s;；、，\-–—]*)\]", outside_code):
        count += len(_citation_numbers_from_text(match.group(0)))
    return count


def _coerce_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _truncate_review_cell(text: str, max_chars: int = 420) -> str:
    clean = str(text or "").strip()
    if len(clean) <= max_chars:
        return clean
    return clean[: max_chars - 1].rstrip() + "..."


def _readability_sentence_excerpt(sentence: str, *, radius: int = 140) -> str:
    compact = re.sub(r"\s+", " ", str(sentence or "")).strip()
    if len(compact) <= radius:
        return compact
    return compact[: max(0, radius - 3)].rstrip() + "..."


def build_citation_audit_review(project: Project) -> dict | None:
    draft_path = project.base_dir / "manuscript" / "draft.md"
    if not draft_path.exists():
        return None
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace")
    references_text = _references_section_text(draft_text)
    reference_entries = _reference_entry_count(references_text)
    if reference_entries <= 0:
        return None
    facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    facts = facts if isinstance(facts, dict) else {}
    facts = dict(facts)

    language = _infer_project_review_language(project, facts) or _review_language_from_text(draft_text)
    main_text = _main_text_before_reference_section(draft_text)
    main_citations = _citation_numbers_from_text(main_text)
    introduction_text = _markdown_first_section_text(draft_text, CITATION_AUDIT_SECTION_HEADINGS["Introduction"])
    methods_text = _markdown_first_section_text(draft_text, CITATION_AUDIT_SECTION_HEADINGS["Methods"])
    discussion_text = _markdown_first_section_text(draft_text, CITATION_AUDIT_SECTION_HEADINGS["Discussion"])
    conclusion_text = _markdown_first_section_text(draft_text, CITATION_AUDIT_SECTION_HEADINGS["Conclusion"])
    intro_citations = _citation_numbers_from_text(introduction_text)
    methods_citations = _citation_numbers_from_text(methods_text)
    results_text = _markdown_first_section_text(draft_text, CITATION_AUDIT_SECTION_HEADINGS["Results"])
    results_citations = _citation_numbers_from_text(results_text)
    discussion_citations = _citation_numbers_from_text(discussion_text)
    conclusion_citations = _citation_numbers_from_text(conclusion_text)
    intro_background_reference_numbers = _context_reference_numbers(
        project,
        "evidence_context.json",
        CITATION_AUDIT_BACKGROUND_SOURCE_TYPES,
    )
    methods_methodology_reference_numbers = _context_reference_numbers(
        project,
        "methodology_context.json",
        CITATION_AUDIT_METHODOLOGY_SOURCE_TYPES,
    )
    discussion_context_reference_numbers = _dedupe_preserving_order(
        _context_reference_numbers(project, "evidence_context.json", CITATION_AUDIT_BACKGROUND_SOURCE_TYPES)
        + _context_reference_numbers(
            project,
            "methodology_context.json",
            CITATION_AUDIT_DISCUSSION_METHODOLOGY_SOURCE_TYPES,
        )
    )
    evidence_context = project.load_json("evidence_context.json", subdir="search") or {}
    methodology_context = project.load_json("methodology_context.json", subdir="search") or {}
    evidence_reference_rows = evidence_context.get("references") if isinstance(evidence_context, dict) else []
    methodology_reference_rows = methodology_context.get("references") if isinstance(methodology_context, dict) else []
    facts["_citation_context"] = {
        "has_background_references": bool(intro_background_reference_numbers) or bool(evidence_reference_rows),
        "has_methodology_references": bool(methods_methodology_reference_numbers) or bool(methodology_reference_rows),
        "has_discussion_references": bool(discussion_context_reference_numbers) or bool(evidence_reference_rows) or bool(methodology_reference_rows),
    }
    background_topic_mismatches = _context_background_topic_mismatches(project)
    intro_background_citations = sorted(set(intro_citations) & set(intro_background_reference_numbers))
    methods_methodology_citations = sorted(set(methods_citations) & set(methods_methodology_reference_numbers))
    discussion_context_citations = sorted(set(discussion_citations) & set(discussion_context_reference_numbers))
    overloaded_citation_clusters = _overloaded_citation_clusters({
        "Introduction": introduction_text,
        "Methods": methods_text,
        "Results": results_text,
        "Discussion": discussion_text,
        "Conclusion": conclusion_text,
    })
    repeated_large_citation_clusters = _repeated_large_citation_clusters({
        "Introduction": introduction_text,
        "Methods": methods_text,
        "Results": results_text,
        "Discussion": discussion_text,
        "Conclusion": conclusion_text,
    })
    mechanical_citation_density_paragraphs = _mechanical_citation_density_paragraphs({
        "Discussion": discussion_text,
        "Conclusion": conclusion_text,
    })
    uncited_numeric_effect_claims = _uncited_numeric_effect_claims({
        "Results": results_text,
        "Discussion": discussion_text,
        "Conclusion": conclusion_text,
    }, facts=facts)
    numeric_effect_claims_without_source_citations = _numeric_effect_claims_without_source_citations(
        project,
        {
            "Results": results_text,
            "Discussion": discussion_text,
            "Conclusion": conclusion_text,
        },
        facts=facts,
    )
    uncited_results_study_data_claims = _uncited_results_study_data_claims(project, results_text, facts=facts)
    uncited_introduction_background_claims = _uncited_introduction_background_claims(project, introduction_text)
    uncited_methods_methodology_claims = _uncited_methods_methodology_claims(project, methods_text)
    uncited_discussion_context_claim_rows = uncited_discussion_context_claims(project, discussion_text)
    uncited_discussion_result_claims = _uncited_discussion_result_claims(project, discussion_text, facts=facts)
    uncited_discussion_mechanism_claims = _uncited_discussion_mechanism_claims(project, discussion_text)
    uncited_conclusion_result_claims = _uncited_conclusion_result_claims(project, conclusion_text, facts=facts)
    minimum_intro_background_citations = min(
        CITATION_AUDIT_MIN_SECTION_CONTEXT_CITATIONS,
        len(intro_background_reference_numbers),
    )
    minimum_methods_methodology_citations = min(
        CITATION_AUDIT_MIN_SECTION_CONTEXT_CITATIONS,
        len(methods_methodology_reference_numbers),
    )
    minimum_discussion_context_citations = min(
        CITATION_AUDIT_MIN_SECTION_CONTEXT_CITATIONS,
        len(discussion_context_reference_numbers),
    )
    valid_references = set(range(1, reference_entries + 1))
    undefined = sorted(set(main_citations) - valid_references)
    unique_cited = sorted(set(main_citations))
    main_word_count = _validation_main_word_count(draft_text, facts)
    citation_density = round((len(main_citations) / main_word_count) * 1000, 2) if main_word_count else 0.0
    publication_reference_depth_required = _requires_publication_reference_depth_gate(
        facts,
        draft_text,
        main_word_count,
    )
    publication_min_references = (
        _publication_min_references(facts if isinstance(facts, dict) else {})
        if publication_reference_depth_required
        else CITATION_AUDIT_MIN_REFERENCES
    )
    intro_paragraph_coverage = _citation_paragraph_coverage(introduction_text)
    discussion_paragraph_coverage = _citation_paragraph_coverage(discussion_text)
    issues: list[dict[str, Any]] = []
    ascii_numeric_citation_markers_in_chinese = (
        _ascii_numeric_citation_marker_number_count_outside_code(draft_text)
        if _should_use_chinese_citation_style(draft_text, language)
        else 0
    )
    if ascii_numeric_citation_markers_in_chinese:
        issues.append({
            "code": "chinese_ascii_numeric_citation_marker_style",
            "severity": "warn",
            "section": "Main text",
            "ascii_numeric_citation_markers": ascii_numeric_citation_markers_in_chinese,
            "message": (
                "Chinese manuscript output contains ASCII numeric citation markers outside code blocks; "
                "use full-width Chinese citation markers consistently."
            ),
        })
    section_counts = {
        "Introduction": len(intro_citations),
        "Methods": len(methods_citations),
        "Results": len(results_citations),
        "Discussion": len(discussion_citations),
        "Conclusion": len(conclusion_citations),
    }
    for section, count in section_counts.items():
        section_text = _markdown_first_section_text(
            draft_text,
            CITATION_AUDIT_SECTION_HEADINGS.get(section, [section]),
        )
        if count == 0 and section_text.strip():
            if _section_can_omit_inline_citation(section, section_text, facts):
                continue
            issues.append({
                "code": "section_citations_missing",
                "severity": "fail",
                "section": section,
                "message": f"{section} has no in-text citation, despite a populated reference list.",
            })
    if introduction_text.strip() and intro_background_reference_numbers and not intro_background_citations:
        issues.append({
            "code": "introduction_background_citations_missing",
            "severity": "warn",
            "section": "Introduction",
            "recommended_citations": intro_background_reference_numbers[:5],
            "message": (
            "Introduction citations do not include available background, guideline, or prior-review sources."
            ),
        })
    elif (
        introduction_text.strip()
        and minimum_intro_background_citations > 0
        and len(intro_background_citations) < minimum_intro_background_citations
    ):
        issues.append({
            "code": "introduction_background_citation_count_low",
            "severity": "warn",
            "section": "Introduction",
            "context_citations": len(intro_background_citations),
            "minimum_context_citations": minimum_intro_background_citations,
            "recommended_citations": _missing_citation_numbers(
                intro_background_reference_numbers,
                intro_background_citations,
            ),
            "message": (
                "Introduction cites too few available background, guideline, or prior-review sources "
                f"({len(intro_background_citations)}/{minimum_intro_background_citations})."
            ),
        })
    if methods_text.strip() and methods_methodology_reference_numbers and not methods_methodology_citations:
        issues.append({
            "code": "methods_methodology_citations_missing",
            "severity": "warn",
            "section": "Methods",
            "recommended_citations": methods_methodology_reference_numbers[:5],
            "message": (
                "Methods citations do not include available reporting-guideline, handbook, GRADE, "
                "risk-of-bias, or statistical-method sources."
            ),
        })
    elif (
        methods_text.strip()
        and minimum_methods_methodology_citations > 0
        and len(methods_methodology_citations) < minimum_methods_methodology_citations
    ):
        issues.append({
            "code": "methods_methodology_citation_count_low",
            "severity": "warn",
            "section": "Methods",
            "context_citations": len(methods_methodology_citations),
            "minimum_context_citations": minimum_methods_methodology_citations,
            "recommended_citations": _missing_citation_numbers(
                methods_methodology_reference_numbers,
                methods_methodology_citations,
            ),
            "message": (
                "Methods cites too few available reporting-guideline, handbook, GRADE, risk-of-bias, "
                "or statistical-method sources "
                f"({len(methods_methodology_citations)}/{minimum_methods_methodology_citations})."
            ),
        })
    if discussion_text.strip() and discussion_context_reference_numbers and not discussion_context_citations:
        issues.append({
            "code": "discussion_context_citations_missing",
            "severity": "warn",
            "section": "Discussion",
            "recommended_citations": discussion_context_reference_numbers[:5],
            "message": (
                "Discussion citations do not include available guideline, prior-review, background, "
                "certainty, or publication-bias context sources."
            ),
        })
    elif (
        discussion_text.strip()
        and minimum_discussion_context_citations > 0
        and len(discussion_context_citations) < minimum_discussion_context_citations
    ):
        issues.append({
            "code": "discussion_context_citation_count_low",
            "severity": "warn",
            "section": "Discussion",
            "context_citations": len(discussion_context_citations),
            "minimum_context_citations": minimum_discussion_context_citations,
            "recommended_citations": _missing_citation_numbers(
                discussion_context_reference_numbers,
                discussion_context_citations,
            ),
            "message": (
                "Discussion cites too few available guideline, prior-review, background, certainty, "
                "or publication-bias context sources "
                f"({len(discussion_context_citations)}/{minimum_discussion_context_citations})."
            ),
        })
    if background_topic_mismatches:
        issues.append({
            "code": "background_reference_topic_mismatch",
            "severity": "warn",
            "section": "References",
            "citation_numbers": [item["citation_number"] for item in background_topic_mismatches],
            "titles": [item["title"] for item in background_topic_mismatches],
            "message": (
                "One or more background references appear off-topic for the review question; "
                "verify evidence_context.json and the final reference list."
            ),
        })
    for cluster in overloaded_citation_clusters:
        issues.append({
            "code": "overloaded_citation_cluster",
            "severity": "warn",
            "section": cluster["section"],
            "citation_numbers": cluster["citation_numbers"],
            "citation_marker": cluster["citation_marker"],
            "cluster_size": cluster["cluster_size"],
            "maximum_cluster_size": CITATION_AUDIT_MAX_INLINE_CLUSTER_SIZE,
            "message": (
                "An inline citation cluster contains too many reference numbers; split sources across "
                "the specific claims they support."
            ),
        })
    for cluster in repeated_large_citation_clusters:
        issues.append({
            "code": "repeated_large_citation_cluster",
            "severity": "fail",
            "section": ", ".join(cluster["sections"]),
            "sections": cluster["sections"],
            "citation_numbers": cluster["citation_numbers"],
            "citation_marker": cluster["citation_marker"],
            "cluster_size": cluster["cluster_size"],
            "occurrences": cluster["occurrences"],
            "minimum_cluster_size": CITATION_AUDIT_REPEATED_CLUSTER_MIN_SIZE,
            "message": (
                "The same large citation cluster appears repeatedly; vary citations by claim so repeated "
                "paragraphs do not all cite the same broad source bundle."
            ),
        })
    for paragraph in mechanical_citation_density_paragraphs:
        issues.append({
            "code": "mechanical_citation_density",
            "severity": "warn",
            "section": paragraph["section"],
            "paragraph_index": paragraph["paragraph_index"],
            "citation_markers": paragraph["citation_markers"],
            "marker_count": paragraph["marker_count"],
            "text_units": paragraph["text_units"],
            "markers_per_35_text_units": paragraph["markers_per_35_text_units"],
            "maximum_markers_per_35_text_units": (
                CITATION_AUDIT_MECHANICAL_DENSITY_MAX_MARKERS_PER_35_UNITS
            ),
            "evidence_excerpt": paragraph["evidence_excerpt"],
            "message": (
                "An interpretive paragraph has mechanically dense citation markers; keep citations attached "
                "to the specific claims they support instead of appending a marker after nearly every short sentence."
            ),
        })
    for claim in uncited_numeric_effect_claims:
        issues.append({
            "code": "uncited_numeric_effect_claim",
            "severity": "warn",
            "section": claim["section"],
            "sentence_index": claim["sentence_index"],
            "evidence_excerpt": claim["evidence_excerpt"],
            "message": (
                "A numeric effect, confidence interval, heterogeneity, or P-value sentence lacks an inline "
                "citation; attach the source citation to the exact quantitative claim."
            ),
        })
    for claim in numeric_effect_claims_without_source_citations:
        issues.append({
            "code": "numeric_effect_claim_lacks_source_citation",
            "severity": "warn",
            "section": claim["section"],
            "sentence_index": claim["sentence_index"],
            "existing_citations": claim["existing_citations"],
            "recommended_citations": claim["recommended_citations"],
            "evidence_excerpt": claim["evidence_excerpt"],
            "message": (
                "A numeric effect, confidence interval, heterogeneity, or P-value sentence is cited, "
                "but not to an available trial, registry, or source-report reference; attach the source "
                "citation to the exact quantitative claim."
            ),
        })
    for claim in uncited_results_study_data_claims:
        issues.append({
            "code": "uncited_results_study_data_claim",
            "severity": "warn",
            "section": "Results",
            "sentence_index": claim["sentence_index"],
            "results_claim_types": claim["results_claim_types"],
            "recommended_citations": claim["recommended_citations"],
            "evidence_excerpt": claim["evidence_excerpt"],
            "message": (
                "A Results sentence describes included studies, trial reports, participants, or outcome-data "
                "contribution without an inline citation; attach the source-report citation to the same sentence."
            ),
        })
    for claim in uncited_introduction_background_claims:
        issue = {
            "code": "uncited_introduction_background_claim",
            "severity": "warn",
            "section": "Introduction",
            "sentence_index": claim["sentence_index"],
            "background_claim_types": claim["background_claim_types"],
            "recommended_citations": claim["recommended_citations"],
            "evidence_excerpt": claim["evidence_excerpt"],
            "message": (
                "An Introduction sentence makes a disease-burden, guideline, or prior-evidence background "
                "claim without a suitable inline citation; attach the relevant background citation to the same sentence."
            ),
        }
        if "existing_citations" in claim:
            issue["existing_citations"] = claim["existing_citations"]
        issues.append(issue)
    for claim in uncited_methods_methodology_claims:
        issues.append({
            "code": "uncited_methods_methodology_claim",
            "severity": "warn",
            "section": "Methods",
            "sentence_index": claim["sentence_index"],
            "methodology_claim_types": claim["methodology_claim_types"],
            "recommended_citations": claim["recommended_citations"],
            "evidence_excerpt": claim["evidence_excerpt"],
            "message": (
                "A methods sentence makes a reporting, risk-of-bias, certainty, or statistical-method "
                "claim without an inline citation; attach the relevant methodology citation to the same sentence."
            ),
        })
    for claim in uncited_discussion_context_claim_rows:
        issues.append({
            "code": "uncited_discussion_context_claim",
            "severity": "warn",
            "section": "Discussion",
            "sentence_index": claim["sentence_index"],
            "discussion_context_claim_types": claim["discussion_context_claim_types"],
            "recommended_citations": claim["recommended_citations"],
            "evidence_excerpt": claim["evidence_excerpt"],
            "message": (
                "A Discussion sentence compares findings with guidelines, prior evidence, certainty, or publication-bias "
                "context without an inline citation; attach the relevant context citation to the same sentence."
            ),
        })
    for claim in uncited_discussion_result_claims:
        issues.append({
            "code": "uncited_discussion_result_claim",
            "severity": "warn",
            "section": "Discussion",
            "sentence_index": claim["sentence_index"],
            "discussion_result_claim_types": claim["discussion_result_claim_types"],
            "recommended_citations": claim["recommended_citations"],
            "evidence_excerpt": claim["evidence_excerpt"],
            "message": (
                "A Discussion sentence makes a primary-result, safety, or clinical-interpretation claim "
                "without an inline citation; attach the supporting source-report citation to the same sentence."
            ),
        })
    for claim in uncited_discussion_mechanism_claims:
        issues.append({
            "code": "uncited_discussion_mechanism_claim",
            "severity": "warn",
            "section": "Discussion",
            "sentence_index": claim["sentence_index"],
            "discussion_mechanism_claim_types": claim["discussion_mechanism_claim_types"],
            "recommended_citations": claim["recommended_citations"],
            "evidence_excerpt": claim["evidence_excerpt"],
            "message": (
                "A Discussion sentence makes a mechanistic or biological explanation claim without an inline "
                "citation; attach the supporting background or prior-review citation to the same sentence."
            ),
        })
    for claim in uncited_conclusion_result_claims:
        issues.append({
            "code": "uncited_conclusion_result_claim",
            "severity": "warn",
            "section": "Conclusion",
            "sentence_index": claim["sentence_index"],
            "conclusion_claim_types": claim["conclusion_claim_types"],
            "recommended_citations": claim["recommended_citations"],
            "evidence_excerpt": claim["evidence_excerpt"],
            "message": (
                "A Conclusion sentence makes a primary-result, safety, clinical-interpretation, or certainty claim "
                "without an inline citation; attach the supporting source citation to the same sentence."
            ),
        })
    if not main_citations:
        any_external_claim_requirement = any(
            _section_requires_external_claim_citation(section, facts)
            for section in ("Introduction", "Methods", "Results", "Discussion", "Conclusion")
        )
        issues.append({
            "code": "main_text_citations_missing",
            "severity": "fail" if any_external_claim_requirement else "warn",
            "section": "Main text",
            "message": "The manuscript main text has no in-text citations before the reference list.",
        })
    if undefined:
        issues.append({
            "code": "undefined_citation_number",
            "severity": "fail",
            "section": "Main text",
            "citation_numbers": undefined,
            "message": "The manuscript cites reference number(s) that are not present in the reference list.",
        })
    if main_word_count >= CITATION_AUDIT_FORMAL_MIN_WORDS:
        for section, coverage in (
            ("Introduction", intro_paragraph_coverage),
            ("Discussion", discussion_paragraph_coverage),
        ):
            if (
                int(coverage.get("substantial_paragraphs", 0) or 0) >= 2
                and float(coverage.get("cited_paragraph_rate", 0.0) or 0.0)
                < CITATION_AUDIT_MIN_INTERPRETIVE_SECTION_CITED_PARAGRAPH_RATE
            ):
                issues.append({
                    "code": f"{section.lower()}_paragraph_citation_coverage_low",
                    "severity": "warn",
                    "section": section,
                    "substantial_paragraphs": coverage.get("substantial_paragraphs", 0),
                    "cited_substantial_paragraphs": coverage.get("cited_substantial_paragraphs", 0),
                    "cited_paragraph_rate": coverage.get("cited_paragraph_rate", 0.0),
                    "minimum_cited_paragraph_rate": CITATION_AUDIT_MIN_INTERPRETIVE_SECTION_CITED_PARAGRAPH_RATE,
                    "uncited_paragraph_indices": coverage.get("uncited_paragraph_indices", []),
                    "message": (
                        f"{section} has too many substantial paragraphs without in-text citations "
                        f"({coverage.get('cited_substantial_paragraphs', 0)}/"
                        f"{coverage.get('substantial_paragraphs', 0)} cited)."
                    ),
                })
        if reference_entries < CITATION_AUDIT_MIN_REFERENCES:
            issues.append({
                "code": "insufficient_reference_count",
                "severity": "warn",
                "section": "References",
                "reference_entries": reference_entries,
                "minimum_reference_entries": CITATION_AUDIT_MIN_REFERENCES,
                "message": (
                    "The manuscript is long enough for a formal submission draft, but the reference list is sparse "
                    f"({reference_entries}/{CITATION_AUDIT_MIN_REFERENCES})."
                ),
            })
        min_unique = min(CITATION_AUDIT_MIN_UNIQUE_CITED_REFERENCES, reference_entries)
        if len(unique_cited) < min_unique:
            issues.append({
                "code": "low_unique_cited_references",
                "severity": "warn",
                "section": "Main text",
                "unique_cited_reference_numbers": len(unique_cited),
                "minimum_unique_cited_references": min_unique,
                "cited_reference_numbers": unique_cited,
                "message": (
                    "The manuscript relies on too few distinct cited references in the main text "
                    f"({len(unique_cited)}/{min_unique})."
                ),
            })
        if citation_density < CITATION_AUDIT_MIN_DENSITY_PER_1000_WORDS:
            issues.append({
                "code": "low_citation_density",
                "severity": "warn",
                "section": "Main text",
                "citation_density_per_1000_words": citation_density,
                "minimum_citation_density_per_1000_words": CITATION_AUDIT_MIN_DENSITY_PER_1000_WORDS,
                "message": (
                    "The manuscript has low citation density for a formal submission draft "
                    f"({citation_density} citations per 1000 words)."
                ),
            })
        if citation_density > CITATION_AUDIT_MAX_DENSITY_PER_1000_WORDS:
            issues.append({
                "code": "excessive_citation_density",
                "severity": "warn",
                "section": "Main text",
                "citation_density_per_1000_words": citation_density,
                "maximum_citation_density_per_1000_words": CITATION_AUDIT_MAX_DENSITY_PER_1000_WORDS,
                "message": (
                    "The manuscript has unusually dense citation markers for a formal submission draft "
                    f"({citation_density} citations per 1000 words); cite specific claims without appending "
                    "reference markers after nearly every sentence."
                ),
            })
        if publication_reference_depth_required and reference_entries < publication_min_references:
            issues.append({
                "code": "publication_reference_count_below_target",
                "severity": "warn",
                "section": "References",
                "reference_entries": reference_entries,
                "minimum_reference_entries": publication_min_references,
                "message": (
                    "This is a publication-style meta-analysis draft, but the reference list remains shallow "
                    f"({reference_entries}/{publication_min_references})."
                ),
            })
    failed_issues = sum(1 for issue in issues if issue.get("severity") == "fail")
    warning_issues = sum(1 for issue in issues if issue.get("severity") == "warn")
    return {
        "schema_version": 1,
        "language": language,
        "passed": failed_issues == 0,
        "summary": {
            "reference_entries": reference_entries,
            "main_text_inline_citations": len(main_citations),
            "unique_cited_reference_numbers": len(unique_cited),
            "main_text_word_count": main_word_count,
            "citation_density_per_1000_words": citation_density,
            "maximum_citation_density_per_1000_words": CITATION_AUDIT_MAX_DENSITY_PER_1000_WORDS,
            "excessive_citation_density": citation_density > CITATION_AUDIT_MAX_DENSITY_PER_1000_WORDS,
            "minimum_reference_entries": CITATION_AUDIT_MIN_REFERENCES,
            "publication_reference_depth_required": publication_reference_depth_required,
            "publication_minimum_reference_entries": publication_min_references,
            "minimum_unique_cited_references": min(CITATION_AUDIT_MIN_UNIQUE_CITED_REFERENCES, reference_entries),
            "minimum_citation_density_per_1000_words": CITATION_AUDIT_MIN_DENSITY_PER_1000_WORDS,
            "introduction_inline_citations": len(intro_citations),
            "introduction_background_inline_citations": len(intro_background_citations),
            "minimum_introduction_background_citations": minimum_intro_background_citations,
            "introduction_substantial_paragraphs": intro_paragraph_coverage.get("substantial_paragraphs", 0),
            "introduction_cited_substantial_paragraphs": intro_paragraph_coverage.get("cited_substantial_paragraphs", 0),
            "introduction_cited_paragraph_rate": intro_paragraph_coverage.get("cited_paragraph_rate", 0.0),
            "methods_inline_citations": len(methods_citations),
            "methods_methodology_inline_citations": len(methods_methodology_citations),
            "minimum_methods_methodology_citations": minimum_methods_methodology_citations,
            "results_inline_citations": len(results_citations),
            "discussion_inline_citations": len(discussion_citations),
            "conclusion_inline_citations": len(conclusion_citations),
            "discussion_context_inline_citations": len(discussion_context_citations),
            "minimum_discussion_context_citations": minimum_discussion_context_citations,
            "discussion_substantial_paragraphs": discussion_paragraph_coverage.get("substantial_paragraphs", 0),
            "discussion_cited_substantial_paragraphs": discussion_paragraph_coverage.get("cited_substantial_paragraphs", 0),
            "discussion_cited_paragraph_rate": discussion_paragraph_coverage.get("cited_paragraph_rate", 0.0),
            "background_reference_topic_mismatch_count": len(background_topic_mismatches),
            "overloaded_citation_clusters": len(overloaded_citation_clusters),
            "maximum_inline_citation_cluster_size": CITATION_AUDIT_MAX_INLINE_CLUSTER_SIZE,
            "repeated_large_citation_clusters": len(repeated_large_citation_clusters),
            "repeated_large_citation_cluster_minimum_size": CITATION_AUDIT_REPEATED_CLUSTER_MIN_SIZE,
            "mechanical_citation_density_paragraphs": len(mechanical_citation_density_paragraphs),
            "maximum_mechanical_markers_per_35_text_units": (
                CITATION_AUDIT_MECHANICAL_DENSITY_MAX_MARKERS_PER_35_UNITS
            ),
            "uncited_numeric_effect_claims": len(uncited_numeric_effect_claims),
            "numeric_effect_claims_without_source_citations": len(numeric_effect_claims_without_source_citations),
            "uncited_results_study_data_claims": len(uncited_results_study_data_claims),
            "uncited_introduction_background_claims": len(uncited_introduction_background_claims),
            "uncited_methods_methodology_claims": len(uncited_methods_methodology_claims),
            "uncited_discussion_context_claims": len(uncited_discussion_context_claim_rows),
            "uncited_discussion_result_claims": len(uncited_discussion_result_claims),
            "uncited_discussion_mechanism_claims": len(uncited_discussion_mechanism_claims),
            "uncited_conclusion_result_claims": len(uncited_conclusion_result_claims),
            "undefined_citation_numbers": len(undefined),
            "ascii_numeric_citation_markers_in_chinese": ascii_numeric_citation_markers_in_chinese,
            "issues": len(issues),
            "failed_issues": failed_issues,
            "warning_issues": warning_issues,
        },
        "section_counts": section_counts,
        "undefined_citation_numbers": undefined,
        "issues": issues,
    }


def _citation_paragraph_coverage(section_text: str) -> dict[str, Any]:
    paragraphs = [
        item.strip()
        for item in re.split(r"\n\s*\n+", _strip_markdown_code_fences(str(section_text or "")))
        if item.strip()
    ]
    substantial = 0
    cited = 0
    uncited_indices: list[int] = []
    for index, paragraph in enumerate(paragraphs, start=1):
        if _paragraph_is_nonprose_block(paragraph):
            continue
        paragraph_without_citations = re.sub(r"[\[［][0-9\s,，、;；\-–—至]+[\]］]", " ", paragraph)
        if _text_unit_count(paragraph_without_citations) < CITATION_AUDIT_MIN_SUBSTANTIAL_PARAGRAPH_WORDS:
            continue
        substantial += 1
        if _citation_numbers_from_text(paragraph):
            cited += 1
        else:
            uncited_indices.append(index)
    rate = round(cited / substantial, 2) if substantial else 1.0
    return {
        "substantial_paragraphs": substantial,
        "cited_substantial_paragraphs": cited,
        "uncited_paragraph_indices": uncited_indices,
        "cited_paragraph_rate": rate,
    }


def _repeated_large_citation_clusters(section_texts: dict[str, str]) -> list[dict[str, Any]]:
    grouped: dict[tuple[int, ...], dict[str, Any]] = {}
    for section, text in section_texts.items():
        for cluster in _citation_clusters_from_text(text):
            numbers = _dedupe_preserving_order(cluster["citation_numbers"])
            if len(numbers) < CITATION_AUDIT_REPEATED_CLUSTER_MIN_SIZE:
                continue
            key = tuple(numbers)
            entry = grouped.setdefault(
                key,
                {
                    "citation_numbers": numbers,
                    "citation_marker": cluster["citation_marker"],
                    "cluster_size": len(numbers),
                    "occurrences": 0,
                    "sections": [],
                },
            )
            entry["occurrences"] += 1
            if section not in entry["sections"]:
                entry["sections"].append(section)
    repeated = [
        entry
        for entry in grouped.values()
        if int(entry.get("occurrences") or 0) >= CITATION_AUDIT_REPEATED_CLUSTER_MIN_OCCURRENCES
    ]
    repeated.sort(key=lambda item: (-int(item.get("occurrences") or 0), item.get("citation_numbers") or []))
    return repeated


def _mechanical_citation_density_paragraphs(section_texts: dict[str, str]) -> list[dict[str, Any]]:
    dense: list[dict[str, Any]] = []
    citation_pattern = r"[\[［][0-9\s,，、;；\-–—至]+[\]］]"
    for section, section_text in section_texts.items():
        if section not in CITATION_AUDIT_MECHANICAL_DENSITY_SECTIONS:
            continue
        paragraphs = [
            item.strip()
            for item in re.split(r"\n\s*\n+", _strip_markdown_code_fences(str(section_text or "")))
            if item.strip()
        ]
        for index, paragraph in enumerate(paragraphs, start=1):
            if _paragraph_is_nonprose_block(paragraph):
                continue
            clusters = _citation_clusters_from_text(paragraph)
            citation_markers = [str(cluster.get("citation_marker") or "") for cluster in clusters]
            citation_markers = [marker for marker in citation_markers if marker]
            marker_count = len(citation_markers)
            if marker_count < CITATION_AUDIT_MECHANICAL_DENSITY_MIN_MARKERS:
                continue
            paragraph_without_citations = re.sub(citation_pattern, " ", paragraph)
            text_units = _text_unit_count(paragraph_without_citations)
            if text_units < CITATION_AUDIT_MECHANICAL_DENSITY_MIN_TEXT_UNITS:
                continue
            markers_per_35 = round(marker_count * 35 / text_units, 2)
            if markers_per_35 <= CITATION_AUDIT_MECHANICAL_DENSITY_MAX_MARKERS_PER_35_UNITS:
                continue
            dense.append({
                "section": section,
                "paragraph_index": index,
                "citation_markers": citation_markers,
                "marker_count": marker_count,
                "text_units": text_units,
                "markers_per_35_text_units": markers_per_35,
                "evidence_excerpt": _readability_sentence_excerpt(paragraph, radius=240),
            })
    return dense


def _overloaded_citation_clusters(section_texts: dict[str, str]) -> list[dict[str, Any]]:
    overloaded: list[dict[str, Any]] = []
    for section, text in section_texts.items():
        for cluster in _citation_clusters_from_text(text):
            numbers = _dedupe_preserving_order(cluster["citation_numbers"])
            if len(numbers) <= CITATION_AUDIT_MAX_INLINE_CLUSTER_SIZE:
                continue
            overloaded.append({
                "section": section,
                "citation_marker": cluster["citation_marker"],
                "citation_numbers": numbers,
                "cluster_size": len(numbers),
            })
    return overloaded


def _citation_clusters_from_text(text: str) -> list[dict[str, Any]]:
    clusters: list[dict[str, Any]] = []
    citation_pattern = r"[\[［]([0-9\s,，、;；\-–—至]+)[\]］]"
    for match in re.finditer(citation_pattern, str(text or "")):
        numbers = _citation_numbers_from_text(match.group(0))
        if not numbers:
            continue
        clusters.append({
            "citation_marker": match.group(0),
            "citation_numbers": numbers,
        })
    return clusters


def _uncited_numeric_effect_claims(section_texts: dict[str, str], *, facts: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    for section, text in section_texts.items():
        sentence_index = 0
        for sentence in _prose_sentences(text):
            if _paragraph_is_nonprose_block(sentence):
                continue
            if not _sentence_has_numeric_effect_claim(sentence):
                continue
            if _sentence_is_internal_analysis_output(sentence, facts or {}):
                continue
            sentence_index += 1
            if _citation_numbers_from_text(sentence):
                continue
            claims.append({
                "section": section,
                "sentence_index": sentence_index,
                "evidence_excerpt": _truncate_review_cell(sentence, max_chars=360),
            })
    return claims


def _numeric_effect_claims_without_source_citations(
    project: Project,
    section_texts: dict[str, str],
    *,
    facts: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    source_numbers = _numeric_effect_source_reference_numbers(project)
    if not source_numbers:
        return []
    source_number_set = set(source_numbers)
    claims: list[dict[str, Any]] = []
    for section, text in section_texts.items():
        sentence_index = 0
        for sentence in _prose_sentences(text):
            if _paragraph_is_nonprose_block(sentence):
                continue
            if not _sentence_has_numeric_effect_claim(sentence):
                continue
            if _sentence_is_internal_analysis_output(sentence, facts or {}):
                continue
            sentence_index += 1
            existing = _dedupe_preserving_order(_citation_numbers_from_text(sentence))
            if not existing:
                continue
            if set(existing) & source_number_set:
                continue
            claims.append({
                "section": section,
                "sentence_index": sentence_index,
                "existing_citations": existing,
                "recommended_citations": source_numbers[:5],
                "evidence_excerpt": _truncate_review_cell(sentence, max_chars=360),
            })
    return claims


def _numeric_effect_source_reference_numbers(project: Project) -> list[int]:
    context = project.load_json("evidence_context.json", subdir="search") or {}
    references = context.get("references") if isinstance(context, dict) else []
    rows = [item for item in references if isinstance(item, dict)] if isinstance(references, list) else []
    numbers: list[int] = []
    for wanted_source_type in CITATION_AUDIT_NUMERIC_EFFECT_SOURCE_TYPES:
        for item in rows:
            source_type = str(item.get("source_type") or "").strip().lower()
            if source_type != wanted_source_type:
                continue
            for number in _citation_numbers_from_text(str(item.get("citation") or "")):
                if number > 0 and number not in numbers:
                    numbers.append(number)
    for number in _numeric_effect_source_reference_numbers_from_bibliography(project):
        if number > 0 and number not in numbers:
            numbers.append(number)
    return numbers


def _numeric_effect_source_reference_numbers_from_bibliography(project: Project) -> list[int]:
    draft_text = project.load_text("draft.md", subdir="manuscript") or ""
    references_text = _references_section_text(draft_text)
    numbers: list[int] = []
    for match in re.finditer(
        r"(?ms)^\s*[\[［](\d+)[\]］]\s*(.*?)(?=^\s*[\[［]\d+[\]］]\s+|\Z)",
        str(references_text or ""),
    ):
        number = int(match.group(1))
        reference_text = match.group(2).strip()
        if number > 0 and number not in numbers and _reference_entry_looks_like_numeric_effect_source(reference_text):
            numbers.append(number)
    return numbers


def _reference_entry_looks_like_numeric_effect_source(reference_text: str) -> bool:
    return _shared_reference_entry_looks_like_numeric_effect_source(reference_text)


def _bibliography_reference_source_types_by_number(project: Project) -> dict[int, set[str]]:
    draft_text = project.load_text("draft.md", subdir="manuscript") or ""
    references_text = _references_section_text(draft_text)
    roles_by_number: dict[int, set[str]] = {}
    for match in re.finditer(
        r"(?ms)^\s*[\[［](\d+)[\]］]\s*(.*?)(?=^\s*[\[［]\d+[\]］]\s+|\Z)",
        str(references_text or ""),
    ):
        number = int(match.group(1))
        roles = reference_entry_source_types(match.group(2).strip())
        if number > 0 and roles:
            roles_by_number.setdefault(number, set()).update(roles)
    return roles_by_number


def _bibliography_reference_numbers_for_source_types(project: Project, source_types: Iterable[str]) -> list[int]:
    wanted = {str(item).strip().lower() for item in source_types if str(item).strip()}
    if not wanted:
        return []
    numbers: list[int] = []
    for number, roles in sorted(_bibliography_reference_source_types_by_number(project).items()):
        if {role.lower() for role in roles} & wanted:
            numbers.append(number)
    return numbers


def _uncited_results_study_data_claims(
    project: Project,
    results_text: str,
    *,
    facts: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    sentence_index = 0
    for sentence in _prose_sentences(results_text):
        if _paragraph_is_nonprose_block(sentence):
            continue
        claim_types = _results_study_data_claim_types(sentence)
        if not claim_types:
            continue
        if _sentence_is_internal_analysis_output(sentence, facts or {}):
            continue
        sentence_index += 1
        if _citation_numbers_from_text(sentence):
            continue
        recommended = _results_study_data_reference_numbers_for_claim(project, claim_types)
        claims.append({
            "sentence_index": sentence_index,
            "results_claim_types": claim_types,
            "recommended_citations": recommended,
            "evidence_excerpt": _truncate_review_cell(sentence, max_chars=360),
        })
    return claims


def _results_study_data_claim_types(sentence: str) -> list[str]:
    raw = str(sentence or "")
    patterns = [
        (
            "study_data_source",
            r"\b(?:included\s+)?(?:studies|trials|trial\s+reports?|RCTs?)\b.{0,80}"
            r"\b(?:contribut(?:e|ed|ing)|provid(?:e|ed|ing)|reported|included|enrolled|randomi[sz]ed)\b|"
            r"\b(?:participants?|patients?)\b.{0,60}\b(?:enrolled|randomi[sz]ed|included|contribut(?:e|ed|ing))\b|"
            r"(?:纳入|包括).{0,12}(?:研究|试验|RCT).{0,20}(?:贡献|提供|报告|数据)|"
            r"(?:患者|受试者|参与者).{0,12}(?:入组|随机|纳入)",
        ),
    ]
    matches: list[tuple[int, str]] = []
    for label, pattern in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            matches.append((match.start(), label))
            break
    seen: set[str] = set()
    ordered: list[str] = []
    for _, label in sorted(matches, key=lambda item: item[0]):
        if label in seen:
            continue
        seen.add(label)
        ordered.append(label)
    return ordered


def _results_study_data_reference_numbers_for_claim(project: Project, claim_types: list[str]) -> list[int]:
    context = project.load_json("evidence_context.json", subdir="search") or {}
    references = context.get("references") if isinstance(context, dict) else []
    preferred = ["included_trial", "trial_report", "registry_results", "clinical_trial"]
    rows = [item for item in references if isinstance(item, dict)] if isinstance(references, list) else []
    numbers: list[int] = []
    for wanted_source_type in preferred:
        for item in rows:
            source_type = str(item.get("source_type") or "").strip().lower()
            if source_type != wanted_source_type:
                continue
            for number in _citation_numbers_from_text(str(item.get("citation") or "")):
                if number > 0 and number not in numbers:
                    numbers.append(number)
    for number in _bibliography_reference_numbers_for_source_types(project, preferred):
        if number > 0 and number not in numbers:
            numbers.append(number)
    return numbers[:5]


def _uncited_introduction_background_claims(project: Project, introduction_text: str) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    sentence_index = 0
    for sentence in _prose_sentences(introduction_text):
        if _paragraph_is_nonprose_block(sentence):
            continue
        claim_types = _introduction_background_claim_types(sentence)
        if not claim_types:
            continue
        sentence_index += 1
        cited_numbers = _citation_numbers_from_text(sentence)
        missing_claim_types = claim_types
        recommended = _background_reference_numbers_for_claim(project, claim_types)
        claim: dict[str, Any] = {
            "sentence_index": sentence_index,
            "evidence_excerpt": _truncate_review_cell(sentence, max_chars=360),
        }
        if cited_numbers:
            missing_claim_types = _background_claim_types_without_matching_citation(project, claim_types, cited_numbers)
            if not missing_claim_types:
                continue
            recommended = _missing_citation_numbers(
                _background_reference_numbers_for_claim(project, missing_claim_types),
                cited_numbers,
            )
            claim["existing_citations"] = cited_numbers
        claim["background_claim_types"] = missing_claim_types
        claim["recommended_citations"] = recommended
        claims.append(claim)
    return claims


def _introduction_background_claim_types(sentence: str) -> list[str]:
    raw = str(sentence or "")
    patterns = [
        (
            "disease_burden",
            r"\b(?:burden|prevalen(?:ce|t)|inciden(?:ce|t)|epidemiolog(?:y|ic)|morbidity|mortality|"
            r"worldwide|globally|common|affect(?:s|ed|ing)?|public\s+health)\b|"
            r"(?:疾病负担|患病率|发病率|流行病学|死亡率|致残|全球|常见|公共卫生)|"
            r"(?:(?:患者|人群|疾病|心力衰竭|心衰|住院|死亡).{0,16}(?:风险|负担).{0,8}(?:高|较高|增加|升高|沉重))",
        ),
        (
            "guideline_context",
            r"\b(?:guideline|guidelines|recommend(?:s|ed|ation|ations)?)\b|(?:指南|推荐|建议)",
        ),
        (
            "prior_evidence",
            r"\b(?:prior|previous|earlier|existing)\s+(?:evidence|studies|trials|reviews?)\b|"
            r"\b(?:systematic\s+review|meta[-\s]+analysis)\b|(?:既往|此前|现有).{0,6}(?:证据|研究|试验|综述)",
        ),
    ]
    matches: list[tuple[int, str]] = []
    for label, pattern in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            matches.append((match.start(), label))
            break
    seen: set[str] = set()
    ordered: list[str] = []
    for _, label in sorted(matches, key=lambda item: item[0]):
        if label in seen:
            continue
        seen.add(label)
        ordered.append(label)
    return ordered


def _background_reference_numbers_for_claim(project: Project, claim_types: list[str]) -> list[int]:
    context = project.load_json("evidence_context.json", subdir="search") or {}
    references = context.get("references") if isinstance(context, dict) else []
    numbers: list[int] = []
    reference_rows = [item for item in references if isinstance(item, dict)] if isinstance(references, list) else []
    for claim_type in claim_types:
        for wanted_source_type in CITATION_AUDIT_BACKGROUND_SOURCE_TYPES_BY_CLAIM.get(str(claim_type), []):
            matched_numbers: list[int] = []
            for item in reference_rows:
                source_type = str(item.get("source_type") or "").strip().lower()
                if source_type != wanted_source_type:
                    continue
                for number in _citation_numbers_from_text(str(item.get("citation") or "")):
                    if number > 0 and number not in matched_numbers:
                        matched_numbers.append(number)
            if matched_numbers:
                for number in matched_numbers:
                    if number not in numbers:
                        numbers.append(number)
                break
            for number in _bibliography_reference_numbers_for_source_types(project, {wanted_source_type}):
                if number not in matched_numbers:
                    matched_numbers.append(number)
            if matched_numbers:
                for number in matched_numbers:
                    if number not in numbers:
                        numbers.append(number)
                break
    return numbers[:5]


def _background_claim_types_without_matching_citation(
    project: Project,
    claim_types: list[str],
    cited_numbers: list[int],
) -> list[str]:
    context = project.load_json("evidence_context.json", subdir="search") or {}
    references = context.get("references") if isinstance(context, dict) else []
    reference_rows = [item for item in references if isinstance(item, dict)] if isinstance(references, list) else []
    source_types_by_number: dict[int, set[str]] = {}
    for item in reference_rows:
        source_type = str(item.get("source_type") or "").strip().lower()
        if not source_type:
            continue
        for number in _citation_numbers_from_text(str(item.get("citation") or "")):
            if number <= 0:
                continue
            source_types_by_number.setdefault(number, set()).add(source_type)
    for number, roles in _bibliography_reference_source_types_by_number(project).items():
        source_types_by_number.setdefault(number, set()).update(roles)

    missing: list[str] = []
    for claim_type in claim_types:
        allowed_source_types = set(CITATION_AUDIT_BACKGROUND_SOURCE_TYPES_BY_CLAIM.get(str(claim_type), []))
        if not allowed_source_types:
            continue
        if any(source_types_by_number.get(number, set()) & allowed_source_types for number in cited_numbers):
            continue
        missing.append(claim_type)
    return missing


def _uncited_methods_methodology_claims(project: Project, methods_text: str) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    sentence_index = 0
    for sentence in _prose_sentences(methods_text):
        if _paragraph_is_nonprose_block(sentence):
            continue
        claim_types = _methodology_claim_types(sentence)
        if not claim_types:
            continue
        sentence_index += 1
        if _citation_numbers_from_text(sentence):
            continue
        recommended = _methodology_reference_numbers_for_claim(project, claim_types)
        claims.append({
            "sentence_index": sentence_index,
            "methodology_claim_types": claim_types,
            "recommended_citations": recommended,
            "evidence_excerpt": _truncate_review_cell(sentence, max_chars=360),
        })
    return claims


def uncited_discussion_context_claims(project: Project, discussion_text: str) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    sentence_index = 0
    for sentence in _prose_sentences(discussion_text):
        if _paragraph_is_nonprose_block(sentence):
            continue
        claim_types = _discussion_context_claim_types(sentence)
        if not claim_types:
            continue
        sentence_index += 1
        if _citation_numbers_from_text(sentence):
            continue
        recommended = _discussion_context_reference_numbers_for_claim(project, claim_types)
        claims.append({
            "sentence_index": sentence_index,
            "discussion_context_claim_types": claim_types,
            "recommended_citations": recommended,
            "evidence_excerpt": _truncate_review_cell(sentence, max_chars=360),
        })
    return claims


def _uncited_discussion_result_claims(
    project: Project,
    discussion_text: str,
    *,
    facts: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    sentence_index = 0
    for sentence in _prose_sentences(discussion_text):
        if _paragraph_is_nonprose_block(sentence):
            continue
        claim_types = _discussion_result_claim_types(sentence)
        if not claim_types:
            continue
        if _sentence_is_internal_analysis_output(sentence, facts or {}):
            continue
        sentence_index += 1
        if _citation_numbers_from_text(sentence):
            continue
        recommended = _discussion_result_reference_numbers_for_claim(project, claim_types)
        claims.append({
            "sentence_index": sentence_index,
            "discussion_result_claim_types": claim_types,
            "recommended_citations": recommended,
            "evidence_excerpt": _truncate_review_cell(sentence, max_chars=360),
        })
    return claims


def _uncited_discussion_mechanism_claims(project: Project, discussion_text: str) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    sentence_index = 0
    for sentence in _prose_sentences(discussion_text):
        if _paragraph_is_nonprose_block(sentence):
            continue
        claim_types = _discussion_mechanism_claim_types(sentence)
        if not claim_types:
            continue
        sentence_index += 1
        if _citation_numbers_from_text(sentence):
            continue
        recommended = _discussion_mechanism_reference_numbers_for_claim(project, claim_types)
        claims.append({
            "sentence_index": sentence_index,
            "discussion_mechanism_claim_types": claim_types,
            "recommended_citations": recommended,
            "evidence_excerpt": _truncate_review_cell(sentence, max_chars=360),
        })
    return claims


def _uncited_conclusion_result_claims(
    project: Project,
    conclusion_text: str,
    *,
    facts: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    sentence_index = 0
    for sentence in _prose_sentences(conclusion_text):
        if _paragraph_is_nonprose_block(sentence):
            continue
        claim_types = _conclusion_result_claim_types(sentence)
        if not claim_types:
            continue
        if _sentence_is_internal_analysis_output(sentence, facts or {}):
            continue
        sentence_index += 1
        if _citation_numbers_from_text(sentence):
            continue
        recommended = _conclusion_result_reference_numbers_for_claim(project, claim_types)
        claims.append({
            "sentence_index": sentence_index,
            "conclusion_claim_types": claim_types,
            "recommended_citations": recommended,
            "evidence_excerpt": _truncate_review_cell(sentence, max_chars=360),
        })
    return claims


def _conclusion_result_claim_types(sentence: str) -> list[str]:
    raw = str(sentence or "")
    patterns = [
        (
            "safety_result",
            r"\b(?:serious\s+)?adverse\s+events?\b.{0,80}\b(?:were\s+)?(?:not\s+)?"
            r"(?:increased|higher|lower|reduced|fewer|similar)\b|"
            r"\b(?:not\s+increased|no\s+increase|similar|fewer|lower|reduced|higher)\b.{0,80}"
            r"\b(?:serious\s+)?adverse\s+events?\b|"
            r"\b(?:safety|harms?|tolerability|discontinuations?)\b.{0,80}"
            r"\b(?:similar|not\s+increased|no\s+increase|increased|higher|lower|fewer|more)\b|"
            r"(?:严重)?不良事件.{0,40}(?:未增加|未升高|无增加|相似|较少|更少|增加|升高)|"
            r"(?:未增加|未升高|无增加|相似|较少|更少).{0,40}(?:严重)?不良事件|"
            r"(?:安全性|耐受性|停药).{0,40}(?:相似|未增加|无增加|增加|升高|较少|更少)",
        ),
        (
            "primary_result",
            r"\b(?:associated\s+with|reduc(?:e|es|ed|ing)|lower(?:s|ed|ing)?|decreas(?:e|es|ed|ing)|"
            r"favou?red|fewer|show(?:s|ed|ing)?|suggest(?:s|ed|ing)?|benefit|beneficial|no\s+(?:clear\s+)?(?:effect|difference)|"
            r"did\s+not\s+(?:reduce|lower|improve))\b.{0,100}"
            r"\b(?:mortality|death|hospitali[sz]ations?|events?|risk|outcomes?|endpoints?|cardiovascular)\b|"
            r"(?:相关|降低|减少|下降|改善|获益|较少|更少|提示|显示|未降低|未减少|无明确差异).{0,40}"
            r"(?:死亡|住院|事件|风险|结局|终点|心血管)",
        ),
        (
            "certainty_context",
            r"\b(?:GRADE|certainty\s+of\s+evidence|quality\s+of\s+evidence)\b|证据确定性|证据质量",
        ),
    ]
    matches: list[tuple[int, str]] = []
    for label, pattern in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            matches.append((match.start(), label))
            break
    if _sentence_has_numeric_effect_claim(raw):
        matches.append((0, "primary_result"))
    seen: set[str] = set()
    ordered: list[str] = []
    for _, label in sorted(matches, key=lambda item: item[0]):
        if label in seen:
            continue
        seen.add(label)
        ordered.append(label)
    return ordered


def _discussion_result_claim_types(sentence: str) -> list[str]:
    raw = str(sentence or "")
    patterns = [
        (
            "safety_result",
            r"\b(?:serious\s+)?adverse\s+events?\b.{0,80}\b(?:were\s+)?(?:not\s+)?"
            r"(?:increased|higher|lower|reduced|fewer|similar)\b|"
            r"\b(?:not\s+increased|no\s+increase|similar|fewer|lower|reduced|higher)\b.{0,80}"
            r"\b(?:serious\s+)?adverse\s+events?\b|"
            r"\b(?:safety|harms?|tolerability|discontinuations?)\b.{0,80}"
            r"\b(?:similar|not\s+increased|no\s+increase|increased|higher|lower|fewer|more)\b|"
            r"(?:严重)?不良事件.{0,40}(?:未增加|未升高|无增加|相似|较少|更少|增加|升高)|"
            r"(?:未增加|未升高|无增加|相似|较少|更少).{0,40}(?:严重)?不良事件|"
            r"(?:安全性|耐受性|停药).{0,40}(?:相似|未增加|无增加|增加|升高|较少|更少)",
        ),
        (
            "primary_result",
            r"\b(?:associated\s+with|reduc(?:e|es|ed|ing)|lower(?:s|ed|ing)?|decreas(?:e|es|ed|ing)|"
            r"favou?red|fewer|show(?:s|ed|ing)?|suggest(?:s|ed|ing)?|benefit|beneficial|"
            r"no\s+(?:clear\s+)?(?:effect|difference)|did\s+not\s+(?:reduce|lower|improve))\b.{0,100}"
            r"\b(?:mortality|death|hospitali[sz]ations?|events?|risk|outcomes?|endpoints?|cardiovascular)\b|"
            r"(?:相关|降低|减少|下降|改善|获益|较少|更少|提示|显示|未降低|未减少|无明确差异).{0,40}"
            r"(?:死亡|住院|事件|风险|结局|终点|心血管)",
        ),
    ]
    matches: list[tuple[int, str]] = []
    for label, pattern in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            matches.append((match.start(), label))
            break
    seen: set[str] = set()
    ordered: list[str] = []
    for _, label in sorted(matches, key=lambda item: item[0]):
        if label in seen:
            continue
        seen.add(label)
        ordered.append(label)
    return ordered


def _discussion_result_reference_numbers_for_claim(project: Project, claim_types: list[str]) -> list[int]:
    evidence_context = project.load_json("evidence_context.json", subdir="search") or {}
    evidence_rows = evidence_context.get("references") if isinstance(evidence_context, dict) else []
    rows = [item for item in (evidence_rows if isinstance(evidence_rows, list) else []) if isinstance(item, dict)]
    preferred_by_claim = {
        "safety_result": ["included_trial", "trial_report", "registry_results", "clinical_trial"],
        "primary_result": ["included_trial", "trial_report", "registry_results", "clinical_trial", "prior_review", "systematic_review"],
    }
    numbers: list[int] = []
    for claim_type in claim_types:
        for wanted_source_type in preferred_by_claim.get(str(claim_type), []):
            matched_numbers: list[int] = []
            for item in rows:
                source_type = str(item.get("source_type") or "").strip().lower()
                if source_type != wanted_source_type:
                    continue
                for number in _citation_numbers_from_text(str(item.get("citation") or "")):
                    if number > 0 and number not in matched_numbers:
                        matched_numbers.append(number)
            if matched_numbers:
                for number in matched_numbers:
                    if number not in numbers:
                        numbers.append(number)
                continue
            for number in _bibliography_reference_numbers_for_source_types(project, [wanted_source_type]):
                if number not in matched_numbers:
                    matched_numbers.append(number)
            if matched_numbers:
                for number in matched_numbers:
                    if number not in numbers:
                        numbers.append(number)
    return numbers[:5]


def _conclusion_result_reference_numbers_for_claim(project: Project, claim_types: list[str]) -> list[int]:
    evidence_context = project.load_json("evidence_context.json", subdir="search") or {}
    methodology_context = project.load_json("methodology_context.json", subdir="search") or {}
    evidence_rows = evidence_context.get("references") if isinstance(evidence_context, dict) else []
    methodology_rows = methodology_context.get("references") if isinstance(methodology_context, dict) else []
    rows = [item for item in (evidence_rows if isinstance(evidence_rows, list) else []) if isinstance(item, dict)]
    rows.extend(item for item in (methodology_rows if isinstance(methodology_rows, list) else []) if isinstance(item, dict))
    preferred_by_claim = {
        "safety_result": ["included_trial", "trial_report", "registry_results", "clinical_trial"],
        "primary_result": ["included_trial", "trial_report", "registry_results", "clinical_trial", "prior_review", "systematic_review"],
        "certainty_context": ["certainty_framework"],
    }
    numbers: list[int] = []
    for claim_type in claim_types:
        for wanted_source_type in preferred_by_claim.get(str(claim_type), []):
            matched_numbers: list[int] = []
            for item in rows:
                source_type = str(item.get("source_type") or "").strip().lower()
                if source_type != wanted_source_type:
                    continue
                for number in _citation_numbers_from_text(str(item.get("citation") or "")):
                    if number > 0 and number not in matched_numbers:
                        matched_numbers.append(number)
            if matched_numbers:
                for number in matched_numbers:
                    if number not in numbers:
                        numbers.append(number)
                if claim_type == "certainty_context":
                    break
    return numbers[:5]


def _discussion_mechanism_claim_types(sentence: str) -> list[str]:
    raw = str(sentence or "")
    patterns = [
        (
            "mechanistic_explanation",
            r"\b(?:may|might|could|likely|possibly|plausibly)\s+(?:reflect|relate\s+to|result\s+from|be\s+explained\s+by)\b"
            r".{0,120}\b(?:mechanism|pathophysiolog(?:y|ic)|biology|biological|inflammation|fibrosis|remodeling|"
            r"ventricular|renal|natriuresis|diuresis|hemodynamic|metabolic|endothelial|neurohormonal)\b|"
            r"\b(?:mechanism|pathophysiolog(?:y|ic)|biology|biological|inflammation|fibrosis|remodeling|ventricular|"
            r"renal|natriuresis|diuresis|hemodynamic|metabolic|endothelial|neurohormonal)\b.{0,120}"
            r"\b(?:may|might|could|likely|possibly|plausibly)\s+(?:explain|mediate|underlie|contribute\s+to)\b|"
            r"(?:可能|或许|也许|推测).{0,20}(?:反映|源于|解释为|归因于).{0,60}"
            r"(?:机制|病理生理|生物学|炎症|纤维化|重构|心室|肾脏|利钠|利尿|血流动力学|代谢|内皮|神经激素)|"
            r"(?:机制|病理生理|生物学|炎症|纤维化|重构|心室|肾脏|利钠|利尿|血流动力学|代谢|内皮|神经激素).{0,60}"
            r"(?:可能|或许|也许).{0,20}(?:解释|介导|导致|贡献)",
        ),
    ]
    matches: list[tuple[int, str]] = []
    for label, pattern in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            matches.append((match.start(), label))
            break
    seen: set[str] = set()
    ordered: list[str] = []
    for _, label in sorted(matches, key=lambda item: item[0]):
        if label in seen:
            continue
        seen.add(label)
        ordered.append(label)
    return ordered


def _discussion_mechanism_reference_numbers_for_claim(project: Project, claim_types: list[str]) -> list[int]:
    evidence_context = project.load_json("evidence_context.json", subdir="search") or {}
    evidence_rows = evidence_context.get("references") if isinstance(evidence_context, dict) else []
    rows = [item for item in (evidence_rows if isinstance(evidence_rows, list) else []) if isinstance(item, dict)]
    preferred_by_claim = {
        "mechanistic_explanation": ["pubmed_background", "prior_review", "systematic_review", "clinical_guideline", "guideline"],
    }
    numbers: list[int] = []
    for claim_type in claim_types:
        for wanted_source_type in preferred_by_claim.get(str(claim_type), []):
            matched_numbers: list[int] = []
            for item in rows:
                source_type = str(item.get("source_type") or "").strip().lower()
                if source_type != wanted_source_type:
                    continue
                for number in _citation_numbers_from_text(str(item.get("citation") or "")):
                    if number > 0 and number not in matched_numbers:
                        matched_numbers.append(number)
            if matched_numbers:
                for number in matched_numbers:
                    if number not in numbers:
                        numbers.append(number)
                break
    return numbers[:5]


def _discussion_context_claim_types(sentence: str) -> list[str]:
    raw = str(sentence or "")
    patterns = [
        (
            "prior_evidence",
            r"\b(?:consistent\s+with|aligned\s+with|compared\s+with|comparison\s+with|in\s+line\s+with)\b.{0,80}"
            r"\b(?:prior|previous|earlier|existing)\s+(?:evidence|studies|trials|reviews?)\b|"
            r"\b(?:add(?:s|ed|ing)?|extend(?:s|ed|ing)?|contribut(?:e|es|ed|ing))\s+to\b.{0,80}"
            r"\b(?:prior|previous|earlier|existing)\s+(?:evidence|evidence\s+base|studies|trials|reviews?)\b|"
            r"\b(?:prior|previous|earlier|existing)\s+(?:systematic\s+reviews?|meta[-\s]+analys(?:is|es))\b|"
            r"(?:补充|扩展|丰富).{0,20}(?:既往|此前|现有).{0,12}(?:证据|证据基础|研究|综述|Meta分析)|"
            r"(?:与|和).{0,20}(?:既往|此前|现有).{0,12}(?:证据|研究|综述|Meta分析).{0,12}(?:一致|比较|相比)",
        ),
        (
            "guideline_context",
            r"\b(?:guideline|guidelines|recommend(?:s|ed|ation|ations)?)\b|(?:指南|推荐|建议)",
        ),
        (
            "certainty_context",
            r"\bGRADE\b|certainty\s+of\s+evidence|quality\s+of\s+evidence|证据确定性|证据质量",
        ),
        (
            "publication_bias_context",
            r"\b(?:publication\s+bias|small[-\s]+study\s+effects?|funnel\s+plot|Egger|Begg|trim[-\s]+and[-\s]+fill)\b|"
            r"(?:发表偏倚|小样本效应|漏斗图)",
        ),
    ]
    matches: list[tuple[int, str]] = []
    for label, pattern in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            matches.append((match.start(), label))
            break
    seen: set[str] = set()
    ordered: list[str] = []
    for _, label in sorted(matches, key=lambda item: item[0]):
        if label in seen:
            continue
        seen.add(label)
        ordered.append(label)
    return ordered


def _discussion_context_reference_numbers_for_claim(project: Project, claim_types: list[str]) -> list[int]:
    evidence_context = project.load_json("evidence_context.json", subdir="search") or {}
    methodology_context = project.load_json("methodology_context.json", subdir="search") or {}
    evidence_rows = evidence_context.get("references") if isinstance(evidence_context, dict) else []
    methodology_rows = methodology_context.get("references") if isinstance(methodology_context, dict) else []
    rows = [item for item in (evidence_rows if isinstance(evidence_rows, list) else []) if isinstance(item, dict)]
    rows.extend(item for item in (methodology_rows if isinstance(methodology_rows, list) else []) if isinstance(item, dict))
    preferred_by_claim = {
        "prior_evidence": ["prior_review", "systematic_review", "pubmed_background"],
        "guideline_context": ["clinical_guideline", "guideline"],
        "certainty_context": ["certainty_framework"],
        "publication_bias_context": ["publication_bias_method"],
    }
    numbers: list[int] = []
    for claim_type in claim_types:
        for wanted_source_type in preferred_by_claim.get(str(claim_type), []):
            matched_numbers: list[int] = []
            for item in rows:
                source_type = str(item.get("source_type") or "").strip().lower()
                if source_type != wanted_source_type:
                    continue
                for number in _citation_numbers_from_text(str(item.get("citation") or "")):
                    if number > 0 and number not in matched_numbers:
                        matched_numbers.append(number)
            if matched_numbers:
                for number in matched_numbers:
                    if number not in numbers:
                        numbers.append(number)
                break
            for number in _bibliography_reference_numbers_for_source_types(project, {wanted_source_type}):
                if number not in matched_numbers:
                    matched_numbers.append(number)
            if matched_numbers:
                for number in matched_numbers:
                    if number not in numbers:
                        numbers.append(number)
                break
    return numbers[:5]


def _methodology_claim_types(sentence: str) -> list[str]:
    raw = str(sentence or "")
    patterns = [
        ("reporting_guideline", r"\bPRISMA\b|Preferred Reporting Items|报告规范|报告指南"),
        ("methods_handbook", r"\bCochrane\s+(?:Handbook|methods?|guidance)\b|方法学手册|Cochrane手册"),
        ("risk_of_bias_tool", r"\b(?:risk[-\s]+of[-\s]+bias|RoB\s*2?|ROB\s*2?)\b|偏倚风险|风险偏倚"),
        ("certainty_framework", r"\bGRADE\b|certainty\s+of\s+evidence|quality\s+of\s+evidence|证据确定性|证据质量"),
        (
            "statistical_method",
            r"\brandom[-\s]+effects?\b|\bfixed[-\s]+effects?\b|\bREML\b|\bDerSimonian[-\s]+Laird\b|"
            r"\bHartung[-\s]+Knapp\b|\bPaule[-\s]+Mandel\b|\bCochran(?:'s)?\s+Q\b|\bI(?:²|2)\b|"
            r"\btau(?:²|2)\b|随机效应|固定效应|受限最大似然|限制性最大似然|"
            r"异质性.{0,12}(?:统计量|检验|评价|评估)|研究间方差|τ²|tau²",
        ),
        ("publication_bias_method", r"\b(?:Egger|Begg|funnel\s+plot|trim[-\s]+and[-\s]+fill)\b|漏斗图|发表偏倚"),
    ]
    matches: list[tuple[int, str]] = []
    for label, pattern in patterns:
        for match in re.finditer(pattern, raw, flags=re.I):
            matches.append((match.start(), label))
            break
    seen: set[str] = set()
    ordered: list[str] = []
    for _, label in sorted(matches, key=lambda item: item[0]):
        if label in seen:
            continue
        seen.add(label)
        ordered.append(label)
    return ordered


def _methodology_reference_numbers_for_claim(project: Project, claim_types: list[str]) -> list[int]:
    context = project.load_json("methodology_context.json", subdir="search") or {}
    references = context.get("references") if isinstance(context, dict) else []
    wanted = {str(item) for item in claim_types}
    numbers: list[int] = []
    for item in references if isinstance(references, list) else []:
        if not isinstance(item, dict):
            continue
        source_type = str(item.get("source_type") or "").strip().lower()
        if source_type not in wanted:
            continue
        for number in _citation_numbers_from_text(str(item.get("citation") or "")):
            if number > 0 and number not in numbers:
                numbers.append(number)
    for claim_type in claim_types:
        for number in _bibliography_reference_numbers_for_source_types(project, {str(claim_type)}):
            if number > 0 and number not in numbers:
                numbers.append(number)
    return numbers[:5]


def _prose_sentences(text: str) -> list[str]:
    raw = _strip_markdown_code_fences(str(text or ""))
    raw = re.sub(r"\s+", " ", raw).strip()
    if not raw:
        return []
    if not re.search(r"[.!?。！？]", raw):
        return [raw]
    sentences: list[str] = []
    start = 0
    closing = set(")”’\"']")
    terminal = set(".!?。！？")
    for index, char in enumerate(raw):
        if char not in terminal:
            continue
        end = index + 1
        while end < len(raw) and raw[end] in closing:
            end += 1
        next_char = raw[end:end + 1]
        if next_char and not next_char.isspace() and not ("\u4e00" <= next_char <= "\u9fff"):
            continue
        sentence = raw[start:end].strip()
        if sentence:
            sentences.append(sentence)
        start = end
    tail = raw[start:].strip()
    if tail:
        sentences.append(tail)
    return sentences


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
        r"(?:合并|汇总).{0,12}(?:OR|RR|HR|MD|SMD|效应|估计)",
        r"(?:95%\s*(?:CI|置信区间)|P\s*(?:=|<|>|≤|≥)\s*0?\.\d+|I(?:²|2)\s*(?:=|为)?\s*\d+%?)",
    ]
    return any(re.search(pattern, raw, flags=re.I) for pattern in patterns)


def _sentence_is_internal_analysis_output(sentence: str, facts: dict[str, Any] | None = None) -> bool:
    """Return True when a sentence reports this review's own analysis output, not an external-source claim."""
    raw = re.sub(r"\s+", " ", str(sentence or "")).strip()
    if not raw:
        return False
    facts = facts or {}
    primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
    primary_population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
    absolute_effects = facts.get("absolute_effects") if isinstance(facts.get("absolute_effects"), dict) else {}
    lower = raw.lower()

    if _sentence_contains_primary_effect_anchor(raw, primary):
        return True
    if _sentence_contains_internal_heterogeneity_output(raw, primary):
        return True
    if _sentence_contains_absolute_effect_output(raw, absolute_effects):
        return True
    if _sentence_contains_internal_synthesis_count(raw, primary, primary_population):
        return True
    if _sentence_describes_internal_table_or_model_output(raw):
        return True
    if _sentence_describes_internal_review_scope(raw):
        return True
    if (
        re.search(r"\b(?:GRADE|certainty of evidence|evidence certainty)\b|证据确定性|证据质量", raw, flags=re.I)
        and (
            "primary synthesis" in lower
            or "meta-analysis" in lower
            or "本综述" in raw
            or "meta分析" in raw
        )
    ):
        return True
    return False


def _sentence_describes_internal_table_or_model_output(sentence: str) -> bool:
    raw = str(sentence or "")
    patterns = [
        r"\bTable\s+\d+\s+(?:lists|shows|provides|reports)\b",
        r"\bFigure\s+\d+\s+(?:shows|provides|displays)\b",
        r"(?:表|图)\s*\d+.{0,12}(?:列出|显示|展示|报告)",
        r"\b(?:random-effects?|fixed-effect|model|sensitivity analysis|safeguard)\b.{0,120}\b(?:fewer than\s+3|only\s+\d+|low study count|contributed)\b",
        r"\b(?:fewer than\s+3|only\s+\d+)\s+stud(?:y|ies)\s+contributed\b.{0,120}\b(?:heterogeneity|small-study|publication bias|sensitivity|model)\b",
        r"(?:预设|随机效应|固定效应|模型|敏感性分析|低研究数).{0,40}(?:保护|不解释|研究数|纳入|贡献)",
        r"(?:仅|只有)\s*\d+\s*项研究.{0,60}(?:异质性|发表偏倚|小样本|模型|敏感性)",
    ]
    return any(re.search(pattern, raw, flags=re.I) for pattern in patterns)


def _sentence_describes_internal_review_scope(sentence: str) -> bool:
    """Detect manuscript-scope statements that are supported by the review's own analysis choices."""
    raw = str(sentence or "")
    lower = raw.lower()
    has_self_reference = any(
        token in lower for token in (
            "this review", "this meta-analysis", "this synthesis", "the present review",
        )
    ) or any(token in raw for token in ("本综述", "本Meta分析", "本 meta 分析", "本文"))
    if not has_self_reference:
        return False
    scope_patterns = [
        r"\b(?:not|no)\s+(?:quantitatively\s+)?pooled\b",
        r"\b(?:aggregate[-\s]+data|individual[-\s]+participant\s+data|patient-level)\b",
        r"\b(?:pooled estimate|absolute benefit|absolute-effect|baseline risk|applicability|limitations?)\b",
        r"(?:未|没有).{0,12}(?:合并|定量合并|分别合并)",
        r"(?:合并估计|绝对获益|基线风险|适用性|局限|聚合数据|个体参与者数据)",
    ]
    return any(re.search(pattern, raw, flags=re.I) for pattern in scope_patterns)


def _sentence_contains_primary_effect_anchor(sentence: str, primary: dict[str, Any]) -> bool:
    measure = str(primary.get("effect_measure") or "").upper()
    if measure not in {"HR", "OR", "RR", "IRR", "MD", "SMD", "RD"}:
        return False
    values = [primary.get("pooled_effect"), primary.get("ci_lower"), primary.get("ci_upper")]
    anchors: list[str] = []
    for value in values:
        try:
            anchors.append(f"{float(value):.2f}")
        except Exception:
            continue
    if len(anchors) < 3:
        return False
    effect_terms = {
        "HR": r"(?<![A-Za-z])HR(?![A-Za-z])|hazard ratio",
        "OR": r"(?<![A-Za-z])OR(?![A-Za-z])|odds ratio",
        "RR": r"(?<![A-Za-z])RR(?![A-Za-z])|risk ratio",
        "IRR": r"(?<![A-Za-z])IRR(?![A-Za-z])|incidence rate ratio",
        "MD": r"(?<![A-Za-z])MD(?![A-Za-z])|mean difference",
        "SMD": r"(?<![A-Za-z])SMD(?![A-Za-z])|standardi[sz]ed mean difference",
        "RD": r"(?<![A-Za-z])RD(?![A-Za-z])|risk difference",
    }[measure]
    compact = sentence.replace("．", ".")
    return bool(re.search(effect_terms, compact, flags=re.I) and all(anchor in compact for anchor in anchors))


def _sentence_contains_internal_heterogeneity_output(sentence: str, primary: dict[str, Any]) -> bool:
    if not primary:
        return False
    has_heterogeneity = bool(re.search(r"I(?:²|2)\s*(?:=|为)?\s*\d|Cochran\s+Q|tau(?:²|2)?\s*(?:=|为)?\s*\d|异质性统计", sentence, flags=re.I))
    if not has_heterogeneity:
        return False
    i2 = primary.get("i_squared")
    tau2 = primary.get("tau_squared")
    anchors: list[str] = []
    for value, digits in ((i2, 1), (tau2, 3)):
        try:
            anchors.append(f"{float(value):.{digits}f}")
        except Exception:
            continue
    return not anchors or any(anchor in sentence for anchor in anchors)


def _sentence_contains_absolute_effect_output(sentence: str, absolute_effects: dict[str, Any]) -> bool:
    scenarios = absolute_effects.get("scenarios") if isinstance(absolute_effects, dict) else None
    if not isinstance(scenarios, list) or not scenarios:
        return False
    has_absolute_language = bool(
        re.search(r"\b(?:per\s+1,?000|NNT|NNTB|NNH|absolute(?:-|\s+)effect|baseline risk)\b|每\s*1000|需治数|绝对", sentence, flags=re.I)
    )
    if not has_absolute_language:
        return False
    for scenario in scenarios:
        if not isinstance(scenario, dict):
            continue
        candidates = [
            scenario.get("events_avoided_per_1000"),
            scenario.get("events_increased_per_1000"),
            scenario.get("nnt"),
            scenario.get("assumed_control_risk_per_1000"),
            scenario.get("intervention_risk_per_1000"),
        ]
        for value in candidates:
            try:
                if str(int(round(float(value)))) in sentence:
                    return True
            except Exception:
                continue
    return False


def _sentence_contains_internal_synthesis_count(
    sentence: str,
    primary: dict[str, Any],
    primary_population: dict[str, Any],
) -> bool:
    n_studies = primary.get("n_studies")
    total_n = primary_population.get("selected_total_participants")
    study_anchor = ""
    total_anchor = ""
    try:
        study_anchor = str(int(n_studies))
    except Exception:
        pass
    try:
        total_anchor = f"{int(total_n):,}"
    except Exception:
        pass
    synthesis_terms = (
        "primary synthesis", "primary meta-analysis", "pooled estimate", "meta-analysis",
        "主要合并", "主要meta分析", "合并估计", "本综述",
    )
    if not any(term.lower() in sentence.lower() for term in synthesis_terms):
        return False
    if study_anchor and re.search(rf"\b{re.escape(study_anchor)}\b", sentence):
        return True
    if total_anchor and total_anchor in sentence:
        return True
    return False


def _paragraph_is_nonprose_block(paragraph: str) -> bool:
    lines = [line.strip() for line in str(paragraph or "").splitlines() if line.strip()]
    if not lines:
        return True
    table_or_rule_lines = sum(1 for line in lines if line.startswith("|") or re.fullmatch(r"[-:| ]+", line))
    if table_or_rule_lines and table_or_rule_lines >= max(1, len(lines) // 2):
        return True
    list_lines = sum(1 for line in lines if re.match(r"^(?:[-*+]|\d+[.)])\s+", line))
    return bool(list_lines and list_lines >= max(1, len(lines) // 2))


def _dedupe_preserving_order(values: Iterable[int]) -> list[int]:
    seen: set[int] = set()
    ordered: list[int] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def _context_reference_numbers(project: Project, filename: str, source_types: set[str]) -> list[int]:
    context = project.load_json(filename, subdir="search") or {}
    references = context.get("references") if isinstance(context, dict) else []
    numbers: list[int] = []
    for item in references if isinstance(references, list) else []:
        if not isinstance(item, dict):
            continue
        source_type = str(item.get("source_type") or "").strip().lower()
        if source_type not in source_types:
            continue
        for number in _citation_numbers_from_text(str(item.get("citation") or "")):
            if number > 0 and number not in numbers:
                numbers.append(number)
    return sorted(numbers)


def _missing_citation_numbers(candidates: Iterable[int], cited: Iterable[int], *, max_count: int = 5) -> list[int]:
    cited_set = {int(value) for value in cited if _integer_or_none(value) is not None}
    missing: list[int] = []
    for value in candidates:
        number = _integer_or_none(value)
        if number is None or number <= 0 or number in cited_set or number in missing:
            continue
        missing.append(number)
        if len(missing) >= max_count:
            break
    return missing


def _context_background_topic_mismatches(project: Project) -> list[dict[str, Any]]:
    protocol = project.load_json("protocol.json") or {}
    if not _protocol_is_sglt2_heart_failure(protocol):
        return []
    context = project.load_json("evidence_context.json", subdir="search") or {}
    references = context.get("references") if isinstance(context, dict) else []
    mismatches: list[dict[str, Any]] = []
    for item in references if isinstance(references, list) else []:
        if not isinstance(item, dict):
            continue
        source_type = str(item.get("source_type") or "").strip().lower()
        if source_type not in CITATION_AUDIT_BACKGROUND_SOURCE_TYPES:
            continue
        title = _context_reference_title(item)
        if not title:
            continue
        if re.search(r"\bheart failure\b|\bhfpef\b|\bhfmref\b|\bejection fraction\b", title, flags=re.I):
            continue
        for number in _citation_numbers_from_text(str(item.get("citation") or "")):
            if number > 0:
                mismatches.append({
                    "citation_number": number,
                    "study_id": str(item.get("study_id") or ""),
                    "source_type": source_type,
                    "title": title,
                })
    return mismatches


def _context_reference_title(item: dict[str, Any]) -> str:
    paper = item.get("paper") if isinstance(item.get("paper"), dict) else {}
    return str(paper.get("title") or item.get("title") or "").strip()


def _protocol_is_sglt2_heart_failure(protocol: dict[str, Any]) -> bool:
    if not isinstance(protocol, dict):
        return False
    pico = protocol.get("pico") if isinstance(protocol.get("pico"), dict) else {}
    text = " ".join([
        str(protocol.get("research_question") or ""),
        str(pico.get("population") or ""),
        str(pico.get("intervention") or ""),
        str(pico.get("outcome_primary") or ""),
    ]).lower()
    has_sglt2 = _text_mentions_sglt2(text)
    has_hf = bool(re.search(r"\bheart failure\b|\bhfpef\b|\bhfmref\b|\bejection fraction\b", text))
    return has_sglt2 and has_hf


def _text_mentions_sglt2(text: str) -> bool:
    return bool(re.search(SGLT2_TEXT_PATTERN, str(text or "").lower(), flags=re.I))


def _citation_numbers_from_text(text: str) -> list[int]:
    numbers: list[int] = []
    citation_pattern = r"[\[［]([0-9\s,，、;；\-–—至]+)[\]］]"
    for match in re.finditer(citation_pattern, str(text or "")):
        token = match.group(1)
        for part in re.split(r"\s*(?:,|，|、|;|；)\s*", token):
            if re.search(r"[-–—]|至", part):
                bounds = [item.strip() for item in re.split(r"[-–—]|至", part, maxsplit=1)]
                if len(bounds) != 2:
                    continue
                start = _integer_or_none(bounds[0])
                end = _integer_or_none(bounds[1])
                if start is None or end is None or end < start:
                    continue
                numbers.extend(range(start, end + 1))
            else:
                value = _integer_or_none(part)
                if value is not None:
                    numbers.append(value)
    return numbers
