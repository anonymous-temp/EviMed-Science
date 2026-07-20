"""Shared manuscript text metrics used by validation and packaging."""
from __future__ import annotations

import re


DEFAULT_PUBLICATION_MIN_MAIN_WORDS = 4500
TWO_STUDY_PUBLICATION_MIN_MAIN_WORDS = 4500
LIMITED_EVIDENCE_GENERATED_MIN_MAIN_WORDS = 2800


_LEGIT_RESTATEMENT_SECTIONS = {"abstract", "摘要", "conclusion", "conclusions", "结论"}


def remove_near_duplicate_sentences(manuscript: str, *, cross_section: bool = False) -> str:
    """Conservatively remove repeated prose sentences from the manuscript body.

    Default mode (``cross_section=False``) is the original conservative guard used
    during writing: a sentence is dropped only when an identical (citation-stripped)
    sentence appears within the same paragraph or as the immediately preceding
    sentence. Legitimate restatement across sections is preserved — the writing
    agent depends on this behavior, so the default must not change.

    ``cross_section=True`` additionally drops a sentence when an identical sentence
    already appeared earlier ANYWHERE in the main body. This targets the failure
    mode where a verbatim sentence is repeated in two different sections (for
    example a GRADE certainty sentence in both the sensitivity and the limitations
    paragraphs) that the within-paragraph guard cannot see. It is meant for final
    finalization only. It excludes the Abstract and Conclusion, whose restatement
    of the headline result is correct manuscript structure rather than a robotic
    doubling, and it tolerates a heading glued to the following sentence in one
    block.
    """
    text = str(manuscript or "")
    ref_match = re.search(r"\n##\s+(References|参考文献)\b", text)
    if ref_match:
        body, tail = text[:ref_match.start()], text[ref_match.start():]
    else:
        body, tail = text, ""

    blocks = re.split(r"(\n{2,})", body)
    cleaned: list[str] = []
    recent: list[str] = []
    recent_semantic: list[str] = []
    body_seen: set[str] = set()
    body_semantic_seen: set[str] = set()
    in_legit_zone = False
    for block in blocks:
        if not block or re.fullmatch(r"\n{2,}", block):
            cleaned.append(block)
            continue

        stripped = block.strip()
        # Heading-led blocks are preserved verbatim (never reformatted). In
        # cross-section mode we still read the section name from the first line so
        # the Abstract/Conclusion restatement zones can be exempted, even when the
        # heading is glued to its content in the same block (e.g. structured
        # abstracts where each label is its own line).
        if stripped.startswith("#"):
            if cross_section:
                first_heading = re.match(r"^#{1,6}\s+(.+)$", stripped.splitlines()[0].strip())
                if first_heading:
                    in_legit_zone = first_heading.group(1).strip().lower() in _LEGIT_RESTATEMENT_SECTIONS
            cleaned.append(block)
            continue

        if _duplicate_guard_skip_block(block):
            cleaned.append(block)
            continue
        sentences = _split_sentences_for_duplicate_guard(block)
        if len(sentences) <= 1:
            if cross_section and sentences:
                norm = _sentence_fingerprint(sentences[0])
                if norm and not in_legit_zone:
                    if norm in body_seen:
                        cleaned.append("")
                        continue
                    body_seen.add(norm)
            cleaned.append(block)
            continue

        kept: list[str] = []
        paragraph_seen: set[str] = set()
        paragraph_semantic_seen: set[str] = set()
        for sentence in sentences:
            norm = _sentence_fingerprint(sentence)
            semantic_norm = _sentence_semantic_fingerprint(sentence)
            if not norm:
                kept.append(sentence)
                continue
            seen_adjacent = norm in paragraph_seen or (recent and norm == recent[-1])
            seen_semantic_adjacent = bool(
                semantic_norm
                and (semantic_norm in paragraph_semantic_seen or (recent_semantic and semantic_norm == recent_semantic[-1]))
            )
            seen_cross = cross_section and (not in_legit_zone) and norm in body_seen
            seen_semantic_cross = cross_section and (not in_legit_zone) and semantic_norm in body_semantic_seen
            if seen_adjacent or seen_semantic_adjacent or seen_cross or seen_semantic_cross:
                continue
            paragraph_seen.add(norm)
            if semantic_norm:
                paragraph_semantic_seen.add(semantic_norm)
            kept.append(sentence)
            recent.append(norm)
            if semantic_norm:
                recent_semantic.append(semantic_norm)
            if cross_section and not in_legit_zone:
                body_seen.add(norm)
                if semantic_norm:
                    body_semantic_seen.add(semantic_norm)
            if len(recent) > 16:
                recent.pop(0)
            if len(recent_semantic) > 16:
                recent_semantic.pop(0)
        cleaned.append(" ".join(item.strip() for item in kept if item.strip()))
    result = "".join(cleaned)
    if cross_section:
        # Dropping a standalone duplicate paragraph can leave a doubled blank line.
        result = re.sub(r"\n{3,}", "\n\n", result)
    return result + tail


def _duplicate_guard_skip_block(block: str) -> bool:
    stripped = block.strip()
    if not stripped:
        return True
    if stripped.startswith("#") or stripped.startswith("|") or stripped.startswith("!") or stripped.startswith("```"):
        return True
    if re.match(r"^(\s*[-*+]|\s*\d+\.)\s+", stripped):
        return True
    if stripped.count("|") >= 3:
        return True
    return False


def _split_sentences_for_duplicate_guard(block: str) -> list[str]:
    stripped = " ".join(line.strip() for line in block.splitlines() if line.strip())
    if not stripped:
        return []
    parts = re.split(r"(?<=[.!?。！？])\s+", stripped)
    return [part.strip() for part in parts if part.strip()]


def _sentence_fingerprint(sentence: str) -> str:
    raw = re.sub(r"\[[0-9,\-\s]+\]", "", str(sentence or ""))
    raw = re.sub(r"[\uFF08(][^)）]{0,80}[\uFF09)]", " ", raw)
    raw = re.sub(r"[^A-Za-z0-9\u4e00-\u9fff]+", " ", raw).lower().strip()
    tokens = raw.split()
    if len(tokens) < 5 and len(re.findall(r"[\u4e00-\u9fff]", raw)) < 12:
        return ""
    return " ".join(tokens)


def _sentence_semantic_fingerprint(sentence: str) -> str:
    """Return a conservative claim-level fingerprint for known repeated claims.

    This is intentionally much narrower than a paraphrase detector.  It only
    collapses sentences that repeat the same named benchmark/anchor claim in
    adjacent prose, such as saying both that an estimate reconstructs WHO REACT
    and that the same estimate was compared with the published WHO REACT result.
    Generic clinical result restatements are left alone.
    """
    raw = re.sub(r"\[[0-9,\-\s]+\]", "", str(sentence or "")).lower()
    raw = re.sub(r"\s+", " ", raw)
    if "who react" in raw:
        has_estimate = re.search(r"\b(estimate|result|effect|meta-analysis|meta analysis)\b", raw)
        has_anchor_action = re.search(r"\b(reconstruct|reconstructed|reconstructs|reproduced|published|compared|matches|matched|benchmark)\b", raw)
        if has_estimate and has_anchor_action:
            return "benchmark:who-react:published-estimate"
    return ""


def main_publication_word_count(manuscript: str) -> int:
    """Count publication main-text words with tables, figures, and references excluded."""
    main = str(manuscript or "")
    cut_points = [
        pos
        for marker in ("## Tables", "## Figures", "## Supplementary Materials", "## References", "## 表格", "## 图", "## 参考文献", "## 附录")
        if (pos := main.find(marker)) >= 0
    ]
    if cut_points:
        main = main[:min(cut_points)]
    main = re.sub(r"```.*?```", " ", main, flags=re.S)
    main = "\n".join(line for line in main.splitlines() if not line.lstrip().startswith("|"))
    main = re.sub(r"!\[[^\]]*\]\([^)]+\)", " ", main)
    main = re.sub(r"\[[^\]]+\]\([^)]+\)", " ", main)
    return len(re.findall(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?|[\u4e00-\u9fff]", main))


def manuscript_style_audit(manuscript: str) -> dict:
    """Return deterministic style diagnostics for publication-like prose.

    The audit is intentionally conservative: it does not try to detect AI text.
    It counts recurring traits that made drafts read like process prose rather
    than clinical manuscripts: excessive hedging connectors, abstract sentence
    subjects, long paragraphs, and sparse Introduction/Discussion citations.
    """
    text = str(manuscript or "")
    main = _main_text_without_references(text)
    sections = _section_map(main)
    rather_than_count = len(re.findall(r"\brather than\b", main, flags=re.I))
    abstract_subject_patterns = (
        r"\bThe result\b",
        r"\bThe analysis\b",
        r"\bThe evidence base\b",
        r"\bThe pooled estimate\b",
        r"\bThis synthesis\b",
        r"\bThis review\b",
        r"\bThis distinction\b",
    )
    abstract_subject_sentence_count = sum(
        len(re.findall(pattern, main, flags=re.I))
        for pattern in abstract_subject_patterns
    )
    section_metrics = {
        name: _section_style_metrics(body)
        for name, body in sections.items()
    }
    body_section_metrics = {
        name: metrics
        for name, metrics in section_metrics.items()
        if name not in {"Abstract", "摘要"}
    }
    paragraph_sentence_counts = [
        int(metrics.get("max_paragraph_sentences") or 0)
        for metrics in body_section_metrics.values()
    ]
    long_paragraph_count = sum(
        int(metrics.get("long_paragraph_count") or 0)
        for metrics in body_section_metrics.values()
    )
    issues: list[dict] = []
    if rather_than_count > 4:
        issues.append({
            "code": "excessive_rather_than",
            "severity": "warning",
            "message": f"'rather than' appears {rather_than_count} times in main text.",
        })
    if abstract_subject_sentence_count > 14:
        issues.append({
            "code": "abstract_subject_overuse",
            "severity": "warning",
            "message": f"Abstract manuscript subjects appear {abstract_subject_sentence_count} times.",
        })
    if long_paragraph_count:
        issues.append({
            "code": "long_publication_paragraphs",
            "severity": "warning",
            "message": f"{long_paragraph_count} prose paragraph(s) exceed six sentences.",
        })
    intro_density = section_metrics.get("Introduction", {}).get("citation_density_per_1000_words")
    discussion_density = section_metrics.get("Discussion", {}).get("citation_density_per_1000_words")
    methods_density = section_metrics.get("Methods", {}).get("citation_density_per_1000_words")
    if intro_density is not None and methods_density is not None and intro_density < methods_density * 0.8:
        issues.append({
            "code": "introduction_citation_density_low_relative_to_methods",
            "severity": "warning",
            "message": "Introduction citation density is lower than Methods citation density.",
        })
    if discussion_density is not None and methods_density is not None and discussion_density < methods_density * 0.8:
        issues.append({
            "code": "discussion_citation_density_low_relative_to_methods",
            "severity": "warning",
            "message": "Discussion citation density is lower than Methods citation density.",
        })
    return {
        "schema_version": 1,
        "summary": {
            "main_word_count": main_publication_word_count(text),
            "rather_than_count": rather_than_count,
            "abstract_subject_sentence_count": abstract_subject_sentence_count,
            "max_paragraph_sentences": max(paragraph_sentence_counts or [0]),
            "long_paragraph_count": long_paragraph_count,
            "issue_count": len(issues),
        },
        "sections": section_metrics,
        "issues": issues,
    }


def manuscript_quality_gate(manuscript: str, facts: dict | None = None, *, style_audit: dict | None = None) -> dict:
    """Run final manuscript smoke checks that must execute in the real pipeline.

    This gate catches problems that are hard to see from fact validation alone:
    reference-section corruption, internal GRADE jargon leaking into the paper,
    secondary meta-analysis figures masquerading as primary sources, and citation
    repair artifacts such as `word[12]`.
    """
    text = str(manuscript or "")
    facts = facts if isinstance(facts, dict) else {}
    style_audit = style_audit if isinstance(style_audit, dict) else manuscript_style_audit(text)
    issues: list[dict] = []

    issues.extend(_quality_reference_section_issues(text))
    issues.extend(_quality_internal_jargon_issues(text))
    issues.extend(_quality_citation_spacing_issues(text))
    issues.extend(_quality_data_uri_issues(text))
    issues.extend(_quality_malformed_image_issues(text))
    issues.extend(_quality_file_path_spacing_issues(text))
    issues.extend(_quality_heading_glue_issues(text))
    issues.extend(_quality_primary_source_issues(facts))
    issues.extend(_quality_report_type_text_issues(text, facts))
    issues.extend(_quality_self_result_citation_issues(text))
    issues.extend(_quality_methodology_prose_issues(text))
    issues.extend(_quality_residual_sample_size_issues(text, facts))
    issues.extend(_quality_publication_bias_overclaim_issues(text, facts))
    issues.extend(_quality_low_k_heterogeneity_overclaim_issues(text, facts))
    issues.extend(_quality_mechanical_phrase_issues(text, facts))

    for issue in style_audit.get("issues") or []:
        if not isinstance(issue, dict):
            continue
        issues.append({
            "code": str(issue.get("code") or "style_issue"),
            "kind": "style_audit_issue",
            "severity": str(issue.get("severity") or "warning"),
            "message": str(issue.get("message") or "Style audit issue."),
        })

    return {
        "schema_version": 1,
        "passed": not any(issue.get("severity") == "error" for issue in issues),
        "summary": {
            "issue_count": len(issues),
            "error_count": sum(1 for issue in issues if issue.get("severity") == "error"),
            "warning_count": sum(1 for issue in issues if issue.get("severity") == "warning"),
            "reference_entry_count": len(_reference_entries(text)),
            "main_word_count": main_publication_word_count(text),
        },
        "issues": issues,
    }


def publication_min_main_words(facts: dict | None) -> int:
    """Return the adaptive publication-style main-text target for a manuscript."""
    facts = facts if isinstance(facts, dict) else {}
    constraints = facts.get("writing_constraints") if isinstance(facts.get("writing_constraints"), dict) else {}
    override = constraints.get("publication_min_main_words")
    primary_n = _primary_study_count(facts)
    if _is_user_length_override(constraints, override, primary_n):
        try:
            value = int(override)
            if value > 0:
                return value
        except (TypeError, ValueError):
            pass

    if facts.get("report_type", "meta") == "meta" and primary_n == 2:
        return TWO_STUDY_PUBLICATION_MIN_MAIN_WORDS
    return DEFAULT_PUBLICATION_MIN_MAIN_WORDS


def _main_text_without_references(manuscript: str) -> str:
    main = str(manuscript or "")
    cut_points = [
        pos
        for marker in (
            "## Tables",
            "## Figures",
            "## Supplementary Materials",
            "## Declarations",
            "## References",
            "## 表格",
            "## 图",
            "## 附录",
            "## 声明",
            "## 参考文献",
        )
        if (pos := main.find(marker)) >= 0
    ]
    if cut_points:
        main = main[:min(cut_points)]
    return main


def _section_map(text: str) -> dict[str, str]:
    sections: dict[str, str] = {}
    matches = list(re.finditer(r"^##\s+(.+?)\s*$", str(text or ""), flags=re.M))
    for index, match in enumerate(matches):
        name = match.group(1).strip()
        if name in {"Tables", "Figures", "Supplementary Materials", "References", "表格", "图", "附录", "参考文献"}:
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections[name] = text[match.end():end]
    return sections


def _section_style_metrics(body: str) -> dict:
    words = len(re.findall(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?|[\u4e00-\u9fff]", str(body or "")))
    citations = len(re.findall(r"[\[［][0-9\s,，、;；\-–—至]+[\]］]", str(body or "")))
    paragraphs = _prose_paragraphs(str(body or ""))
    sentence_counts = [len(_split_sentences(paragraph)) for paragraph in paragraphs]
    return {
        "word_count": words,
        "citation_count": citations,
        "citation_density_per_1000_words": (citations / words * 1000.0) if words else None,
        "paragraph_count": len(paragraphs),
        "max_paragraph_sentences": max(sentence_counts or [0]),
        "long_paragraph_count": sum(1 for count in sentence_counts if count > 6),
    }


def _prose_paragraphs(text: str) -> list[str]:
    paragraphs: list[str] = []
    for paragraph in re.split(r"\n\s*\n+", str(text or "")):
        stripped = paragraph.strip()
        if not stripped:
            continue
        if stripped.startswith(("#", "|", "![", "- ", "* ", "```")):
            continue
        if "\n|" in stripped or stripped.startswith("Legend:"):
            continue
        paragraphs.append(re.sub(r"\s+", " ", stripped))
    return paragraphs


def _split_sentences(paragraph: str) -> list[str]:
    text = re.sub(r"\s+", " ", str(paragraph or "")).strip()
    if not text:
        return []
    return [
        item.strip()
        for item in re.split(r"(?<=[.!?。！？])\s+(?=[A-Z0-9\u4e00-\u9fff])", text)
        if item.strip()
    ]


def publication_min_main_words_for_primary_count(primary_n: int | None) -> int:
    """Return the default target before a full facts packet exists."""
    try:
        count = int(primary_n or 0)
    except (TypeError, ValueError):
        count = 0
    if 2 <= count <= 7:
        return LIMITED_EVIDENCE_GENERATED_MIN_MAIN_WORDS
    if count == 2:
        return TWO_STUDY_PUBLICATION_MIN_MAIN_WORDS
    return DEFAULT_PUBLICATION_MIN_MAIN_WORDS


def _primary_study_count(facts: dict) -> int:
    primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
    candidates = [
        primary.get("n_studies"),
        len(primary.get("studies") or []) if isinstance(primary.get("studies"), list) else None,
    ]
    readiness = facts.get("evidence_readiness") if isinstance(facts.get("evidence_readiness"), dict) else {}
    selected_rows = readiness.get("selected_primary_rows")
    if isinstance(selected_rows, list):
        candidates.append(len(selected_rows))
    for candidate in candidates:
        try:
            count = int(candidate or 0)
        except (TypeError, ValueError):
            count = 0
        if count > 0:
            return count
    return 0


def _is_user_length_override(constraints: dict, override: object, primary_n: int) -> bool:
    if override in (None, ""):
        return False
    try:
        value = int(override)
    except (TypeError, ValueError):
        return False
    if value <= 0:
        return False
    source = str(
        constraints.get("publication_min_main_words_source")
        or constraints.get("source")
        or ""
    ).strip().lower()
    if source in {"user", "manual", "explicit", "config"}:
        return True
    if primary_n == 2 and value in {DEFAULT_PUBLICATION_MIN_MAIN_WORDS, 6000}:
        return False
    return True


def _quality_reference_section_issues(manuscript: str) -> list[dict]:
    body = _references_body(manuscript)
    if not body:
        return []
    entries = _reference_entries(manuscript)
    if not entries:
        return []
    issues: list[dict] = []
    numbers = [entry["number"] for entry in entries]
    max_number = max(numbers)
    missing = [number for number in range(1, max_number + 1) if number not in set(numbers)]
    if missing:
        issues.append({
            "code": "reference_number_sequence_broken",
            "kind": "manuscript_quality_gate",
            "severity": "error",
            "message": f"Reference section is missing numbered entries: {missing[:10]}.",
            "missing_numbers": missing,
        })
    duplicate_numbers = sorted({number for number in numbers if numbers.count(number) > 1})
    if duplicate_numbers:
        issues.append({
            "code": "reference_number_duplicated",
            "kind": "manuscript_quality_gate",
            "severity": "error",
            "message": f"Reference section contains duplicate numbered entries: {duplicate_numbers[:10]}.",
            "duplicate_numbers": duplicate_numbers,
        })
    for entry in entries:
        text = str(entry.get("text") or "")
        if re.search(r"\s[\[［][0-9]+[\]］]\s+\S", text):
            issues.append({
                "code": "reference_entry_contains_embedded_reference",
                "kind": "manuscript_quality_gate",
                "severity": "error",
                "message": f"Reference entry {entry.get('number')} appears to contain another reference entry.",
                "reference_number": entry.get("number"),
            })
            break
    return issues


def _quality_internal_jargon_issues(manuscript: str) -> list[dict]:
    bad_terms = [
        "Rule-based",
        "OIS=",
        "CI crosses null",
        "Synthetic RoB",
        "P/I/C/design",
        "结构化GRADE",
        "请结合证据审计文件复核",
        "Methodological note",
        "PICO consistency note",
        "Unit consistency note",
        "Caution on results",
        "方法学说明",
        "PICO一致性说明",
        "单位一致性说明",
        "结果解读注意",
        "automated system",
        "automated review workflow",
        "self-verification",
        "self verification",
        "protocol metadata",
        "metadata fields",
        "analysis/model_decision.json",
        "cached analysis file",
        "current structured project record",
        "缓存分析文件",
        "当前结构化项目记录",
        "the results pooled results",
        "results pooled results",
    ]
    found = [term for term in bad_terms if term in str(manuscript or "")]
    if not found:
        return []
    return [{
        "code": "internal_grade_or_pipeline_jargon",
        "kind": "manuscript_quality_gate",
        "severity": "error",
        "message": "Internal GRADE or pipeline wording leaked into the manuscript.",
        "terms": found,
    }]


def _quality_citation_spacing_issues(manuscript: str) -> list[dict]:
    main = _body_before_references(manuscript)
    matches = re.findall(r"[A-Za-z0-9)]\[[0-9]", main)
    if not matches:
        return []
    return [{
        "code": "sticky_english_numeric_citation",
        "kind": "manuscript_quality_gate",
        "severity": "error",
        "message": "English numeric citation markers are attached to preceding words.",
        "examples": matches[:10],
    }]


def _quality_data_uri_issues(manuscript: str) -> list[dict]:
    main = str(manuscript or "")
    if "](data:image/" not in main:
        return []
    return [{
        "code": "embedded_base64_image_in_manuscript",
        "kind": "manuscript_quality_gate",
        "severity": "error",
        "message": "Manuscript embeds a base64 image data URI; publication exports must reference generated figure files.",
    }]


def _quality_malformed_image_issues(manuscript: str) -> list[dict]:
    main = str(manuscript or "")
    examples = []
    for pattern in (r"!\s+\[[^\]]+\]\([^)]*\)", r"!\[[^\]]+\]\([^)]*\s+[^)]*\)", r"\.\s+(?:png|jpe?g|webp)\b"):
        examples.extend(match.group(0)[:160] for match in re.finditer(pattern, main, flags=re.I))
    if not examples:
        return []
    return [{
        "code": "malformed_markdown_image_reference",
        "kind": "manuscript_quality_gate",
        "severity": "error",
        "message": "Manuscript contains malformed image markdown; figure references must render as file links.",
        "examples": examples[:10],
    }]


def _quality_file_path_spacing_issues(manuscript: str) -> list[dict]:
    text = str(manuscript or "")
    examples = [
        match.group(0)
        for match in re.finditer(r"\b[A-Za-z0-9_./-]+\.\s+(?:json|bib|png|jpe?g|webp)\b", text, flags=re.I)
    ]
    examples.extend(
        match.group(0)
        for match in re.finditer(
            r"https?://[^\s)\]]*\.\s+(?:org|com|gov|edu|net)|https?://[^\s)\]]+\?\s+[A-Za-z0-9_=&%-]+",
            text,
            flags=re.I,
        )
    )
    if not examples:
        return []
    return [{
        "code": "file_path_spacing_corruption",
        "kind": "manuscript_quality_gate",
        "severity": "error",
        "message": "File paths or figure filenames contain spaces inserted before extensions.",
        "examples": examples[:10],
    }]


def _quality_heading_glue_issues(manuscript: str) -> list[dict]:
    examples = [
        match.group(0)[:160]
        for match in re.finditer(r"^#{2,6}[ \t]+[^\n#]+?[ \t]+#{2,6}[ \t]+", str(manuscript or ""), flags=re.M)
    ]
    if not examples:
        return []
    return [{
        "code": "glued_markdown_headings",
        "kind": "manuscript_quality_gate",
        "severity": "error",
        "message": "Adjacent markdown headings are glued onto one line.",
        "examples": examples[:10],
    }]


def _quality_primary_source_issues(facts: dict) -> list[dict]:
    readiness = facts.get("evidence_readiness") if isinstance(facts.get("evidence_readiness"), dict) else {}
    rows = readiness.get("selected_primary_rows")
    if not isinstance(rows, list):
        return []
    report_type = str(facts.get("report_type") or readiness.get("report_type") or "meta").lower()
    offenders = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        source_location = str(row.get("source_location") or "")
        original_location = str(
            row.get("source_location_original")
            or row.get("source_location_raw")
            or row.get("benchmark_source_location")
            or ""
        )
        source_role = str(row.get("source_role") or "").lower()
        provenance_tier = str(row.get("source_provenance_tier") or "").lower()
        if (
            provenance_tier == "secondary_meta_figure"
            or _looks_like_secondary_meta_source(source_location)
            or _looks_like_secondary_meta_source(original_location)
            or source_role in {"secondary_meta_analysis", "published_meta_analysis"}
        ):
            offenders.append({
                "row_id": row.get("row_id") or row.get("study_id") or "",
                "source_location": source_location,
                "source_location_original": original_location,
                "source_role": row.get("source_role") or "",
                "source_provenance_tier": provenance_tier or "unknown",
            })
    if not offenders:
        return []
    if report_type == "benchmark_reconstruction":
        return [{
            "code": "secondary_meta_source_declared_for_benchmark_reconstruction",
            "kind": "manuscript_quality_gate",
            "severity": "warning",
            "message": (
                "Selected rows include secondary meta-analysis figure provenance; this is allowed only because "
                "the facts classify the run as benchmark_reconstruction."
            ),
            "rows": offenders[:20],
        }]
    return [{
        "code": "secondary_meta_source_used_as_primary_row",
        "kind": "manuscript_quality_gate",
        "severity": "error",
        "message": "Selected primary-analysis rows still cite a secondary meta-analysis source.",
        "rows": offenders[:20],
    }]


def _quality_report_type_text_issues(manuscript: str, facts: dict) -> list[dict]:
    report_type = str((facts or {}).get("report_type") or "").strip().lower()
    if report_type != "benchmark_reconstruction":
        return []
    main = _body_before_references(manuscript)
    if re.search(r"\bbenchmark reconstruction\b|\breconstruction\b|\bbenchmark\b|基准复现|复现", main, flags=re.I):
        return []
    return [{
        "code": "benchmark_reconstruction_not_declared_in_text",
        "kind": "manuscript_quality_gate",
        "severity": "error",
        "message": "Facts classify this run as benchmark_reconstruction, but the manuscript does not declare that positioning.",
    }]


def _quality_self_result_citation_issues(manuscript: str) -> list[dict]:
    main = _body_before_references(manuscript)
    citation_zh_or_en = r"(?:［[0-9，,\s\-–—]+］|\s*\[[0-9,\s\-–—]+\])"
    patterns = [
        r"((?:This systematic review and meta-analysis|This meta-analysis) (?:found|showed)[^\n]*?)(?:\s*\[[0-9,\s\-–—]+\])",
        r"((?:In (?:a|this) meta-analysis|In (?:a|this) synthesis|In this systematic review and meta-analysis|Pooled analysis)[^\n]*?(?:hazard ratio|odds ratio|risk ratio|HR|OR|RR|pooled (?:estimate|effect|result))[^\n]*?)(?:\s*\[[0-9,\s\-–—]+\])",
        r"((?:The primary pooled estimate|The pooled (?:HR|OR|RR|estimate|effect))(?=[^\n]*(?:\b(?:HR|OR|RR)\b\s*[0-9]|95%\s*CI|NNT|events?\s+per|per\s+1000))[^\n]*?)(?:\s*\[[0-9,\s\-–—]+\])",
        rf"(本系统综述和Meta分析显示[^。\n]*?){citation_zh_or_en}",
        rf"([^。\n]{{0,160}}?(?:合并HR|合并OR|合并RR|合并结果|合并效应)[^。\n]*?(?:HR|OR|RR)\s*[0-9][^。\n]*?){citation_zh_or_en}",
    ]
    # Evaluate one prose sentence at a time.  The earlier line-wide scan could
    # flag a valid citation in the next sentence of the same paragraph merely
    # because the preceding sentence reported the pooled estimate.
    section_bodies = list(_section_map(main).values()) or [main]
    sentences = [
        sentence
        for body in section_bodies
        for paragraph in _prose_paragraphs(body)
        for sentence in _split_sentences(paragraph)
        if re.search(citation_zh_or_en, sentence)
    ]
    for sentence in sentences:
        for pattern in patterns:
            if re.search(pattern, sentence, flags=re.I):
                return [{
                    "code": "self_result_sentence_has_external_trial_citation",
                    "kind": "manuscript_quality_gate",
                    "severity": "warning",
                    "message": "A sentence reporting this review's own pooled result has an external citation marker.",
                }]
    return []


def _primary_n_from_quality_facts(facts: dict) -> int:
    primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
    studies = facts.get("studies") if isinstance(facts.get("studies"), dict) else {}
    for value in (primary.get("n_studies"), studies.get("primary_analysis_count")):
        try:
            n = int(value or 0)
        except (TypeError, ValueError):
            continue
        if n > 0:
            return n
    return 0


def _selected_total_from_quality_facts(facts: dict) -> int:
    population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
    try:
        return int(population.get("selected_total_participants") or 0)
    except (TypeError, ValueError):
        return 0


def _quality_residual_sample_size_issues(manuscript: str, facts: dict) -> list[dict]:
    selected_total = _selected_total_from_quality_facts(facts)
    if selected_total <= 0:
        return []
    main = _body_before_references(manuscript)
    if not re.search(r"total sample size[^.。]{0,180}(?:not fully reported|not reported|\bNR\b)", main, flags=re.I):
        return []
    return [{
        "code": "residual_sample_size_nr_claim",
        "kind": "manuscript_quality_gate",
        "severity": "error",
        "message": "Manuscript still says total sample size was not reported although the selected primary-analysis total is known.",
        "selected_total": selected_total,
    }]


def _quality_publication_bias_overclaim_issues(manuscript: str, facts: dict) -> list[dict]:
    primary_n = _primary_n_from_quality_facts(facts)
    if primary_n <= 0 or primary_n >= 10:
        return []
    main = _body_before_references(manuscript)
    if not re.search(
        r"(?:publication bias|small-study (?:bias|effects?))[^.。]{0,140}(?:not significant|not detected|no evidence)|"
        r"no evidence of[^.。]{0,140}(?:publication bias|small-study (?:bias|effects?))|"
        r"lack of detected publication bias|"
        r"absence of publication bias was confirmed|"
        r"publication bias[^.。]{0,180}to be a major issue despite the inability to test it formally|"
        r"minimum of\s*2\s+studies[^.。]{0,120}(?:publication bias|funnel|Egger)",
        main,
        flags=re.I,
    ):
        return []
    return [{
        "code": "publication_bias_overclaim_for_low_k",
        "kind": "manuscript_quality_gate",
        "severity": "error",
        "message": "Publication-bias wording overinterprets a low-k synthesis.",
        "primary_n": primary_n,
    }]


def _quality_low_k_heterogeneity_overclaim_issues(manuscript: str, facts: dict) -> list[dict]:
    primary_n = _primary_n_from_quality_facts(facts)
    if primary_n <= 0 or primary_n >= 3:
        return []
    main = _body_before_references(manuscript)
    patterns = [
        r"absence of[^.。]{0,120}heterogeneity[^.。]{0,120}(?:reassuring|supports|confirms)",
        r"heterogeneity[^.。]{0,120}(?:reassuring|confirms|proves|demonstrates)",
        r"heterogeneity was low[^.。]{0,120}(?:I²|I2|tau)",
        r"异质性较低[^.。]{0,120}(?:I²|I2|tau)",
        r"(?:consistent|compatible|coherent)[^.。]{0,120}(?:I²|I2|tau|heterogeneity)[^.。]{0,120}(?:reassuring|supports|confirms)",
    ]
    examples: list[str] = []
    for pattern in patterns:
        examples.extend(
            re.sub(r"\s+", " ", match.group(0)).strip()[:220]
            for match in re.finditer(pattern, main, flags=re.I)
        )
    if not examples:
        return []
    return [{
        "code": "low_k_heterogeneity_overinterpretation",
        "kind": "manuscript_quality_gate",
        "severity": "error",
        "message": "Heterogeneity wording overinterprets I²/tau² when fewer than three studies contribute.",
        "primary_n": primary_n,
        "examples": examples[:10],
    }]


def _quality_mechanical_phrase_issues(manuscript: str, facts: dict) -> list[dict]:
    text = str(manuscript or "")
    patterns = [
        r"Protocol and The review protocol",
        r"Heterogeneity and:",
        r"subgroup analyses and were",
        r"(?:the\s+)?results pooled results",
        r"funnel plots or [’']s (?:test|regression test)",
        r"without a prespecified for HFmrEF or HFpEF",
        r"unless a prespecified for HFmrEF or HFpEF",
        r"sensitivity analyses\s+and\s+s\b",
        r"custom meta-analysis engine",
        r"Records were screened records",
        r"remains a area",
        r"formal subgroup was not feasible",
        r"through or is severely restricted",
        r"and The pooled results",
        r"###\s+Author contributions[ \t]+\S",
    ]
    examples = []
    for pattern in patterns:
        examples.extend(match.group(0)[:160] for match in re.finditer(pattern, text, flags=re.I))

    prisma = facts.get("prisma") if isinstance(facts.get("prisma"), dict) else {}
    full_text = _quality_int(prisma.get("full_text_assessed"))
    included = _quality_int(prisma.get("studies_included"))
    if full_text > included > 0:
        wrong_excluded = re.search(r"Of these,\s*(\d+)\s+studies were excluded at the full-text stage", text, flags=re.I)
        if wrong_excluded and _quality_int(wrong_excluded.group(1)) != full_text - included:
            examples.append(wrong_excluded.group(0))

    if not examples:
        return []
    return [{
        "code": "mechanical_manuscript_phrase",
        "kind": "manuscript_quality_gate",
        "severity": "error",
        "message": "Manuscript contains a mechanical or internally inconsistent phrase that should be repaired before release.",
        "examples": examples[:10],
    }]


def _quality_methodology_prose_issues(manuscript: str) -> list[dict]:
    """Flag process/tutorial prose that belongs in neither Results nor Methods.

    Drafts previously read like a meta-analysis handbook because Results and
    Methods spent space explaining why synthesis rules matter instead of
    reporting the review. These patterns are deliberately narrow and target
    recurring failure modes observed in generated manuscripts.
    """
    sections = _section_map(_main_text_without_references(manuscript))
    patterns = [
        ("this_distinction_matters", r"\bthis distinction matters\b|这种区分(?:很)?重要"),
        ("useful_review_meta_tutorial", r"\ba useful review\b|\ba review that\b|一篇有用的综述|好的综述"),
        ("model_preserves_tutorial", r"\bmodel preserves\b|\bpreserving randomization\b|模型保留|保留随机化"),
        (
            "study_level_rather_than_tutorial",
            r"calculated from study-level (?:effects|estimates)[^.。]{0,160}\brather than\b|"
            r"基于研究层面.*而不是|研究层面.*而非",
        ),
        ("manuscript_process_prose", r"\bfor a manuscript\b|\bmanuscript tables\b|正文表格|投稿稿件表格"),
    ]
    issues: list[dict] = []
    for section_name, body in sections.items():
        canonical = section_name.strip().lower()
        if canonical not in {"results", "方法", "methods", "结果"}:
            continue
        hits: list[dict] = []
        for code, pattern in patterns:
            match = re.search(pattern, body, flags=re.I)
            if not match:
                continue
            snippet = re.sub(r"\s+", " ", match.group(0)).strip()
            hits.append({"code": code, "snippet": snippet[:180]})
        if not hits:
            continue
        severity = "error" if canonical in {"results", "结果"} else "warning"
        issues.append({
            "code": "methodology_meta_prose_in_body_section",
            "kind": "manuscript_quality_gate",
            "severity": severity,
            "message": f"{section_name} contains tutorial/process prose instead of manuscript-specific reporting.",
            "section": section_name,
            "hits": hits,
        })
    return issues


def _looks_like_secondary_meta_source(text: str) -> bool:
    raw = str(text or "").lower()
    if not raw:
        return False
    return (
        "who react" in raw
        or "figure 2" in raw and "meta" in raw
        or "published meta-analysis" in raw
        or "secondary meta" in raw
    )


def _references_body(manuscript: str) -> str:
    text = str(manuscript or "")
    match = re.search(r"^##\s+(?:References?|参考文献|引用文献|文献)\s*$", text, flags=re.M)
    if not match:
        return ""
    remainder = text[match.end():]
    next_heading = re.search(r"^##\s+", remainder, flags=re.M)
    return remainder[: next_heading.start()] if next_heading else remainder


def _body_before_references(manuscript: str) -> str:
    text = str(manuscript or "")
    match = re.search(r"^##\s+(?:References?|参考文献|引用文献|文献)\s*$", text, flags=re.M)
    return text[: match.start()] if match else text


def _quality_int(value: object) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _reference_entries(manuscript: str) -> list[dict]:
    body = _references_body(manuscript)
    entries: list[dict] = []
    for match in re.finditer(r"^[\[［](\d+)[\]］]\s*(.+)$", body, flags=re.M):
        try:
            number = int(match.group(1))
        except ValueError:
            continue
        entries.append({"number": number, "text": match.group(2).strip()})
    return entries
