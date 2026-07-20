"""Publication-style similarity review for manuscript handoff packages."""
from __future__ import annotations

from html import escape
import re
from typing import Any

from new_meta.core.artifact_package_language import (
    html_lang as _html_lang,
    is_zh_review_language as _is_zh_review_language,
    normalize_review_language as _normalize_review_language,
)
from new_meta.core.project import Project
from new_meta.core.report_style import (
    data_table as _data_table,
    page_header as _page_header,
    panel as _panel,
    render_page as _render_page,
    stat_chip as _stat_chip,
)


PUBLICATION_SIMILARITY_THRESHOLD = 85


def build_publication_similarity_review(
    project: Project,
    *,
    abstract_audit: dict | None = None,
    publication_tone_audit: dict | None = None,
    readability_audit: dict | None = None,
    clinical_interpretation_audit: dict | None = None,
    citation_audit: dict | None = None,
    prisma_audit: dict | None = None,
    figure_audit: dict | None = None,
    figure_legend_audit: dict | None = None,
    cross_reference_audit: dict | None = None,
    table_footnote_audit: dict | None = None,
    calculation_audit: dict | None = None,
    primary_source_trace: dict | None = None,
    benchmark_review: dict | None = None,
    search_strategy_audit: dict | None = None,
) -> dict | None:
    draft_path = project.base_dir / "manuscript" / "draft.md"
    if not draft_path.exists() or draft_path.stat().st_size <= 0:
        return None
    draft_text = draft_path.read_text(encoding="utf-8", errors="replace")
    facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    facts = facts if isinstance(facts, dict) else {}
    if facts.get("report_type") and facts.get("report_type") != "meta":
        return None
    if not _looks_like_meta_publication(draft_text, facts):
        return None

    language = _normalize_review_language(
        str(facts.get("output_language") or facts.get("language") or "")
    ) or _review_language_from_text(draft_text)
    zh = _is_zh_review_language(language)
    main_text = _main_article_text(draft_text)
    sections = _h2_sections(main_text)
    search_query_file_present, search_query_reproduced = _search_query_reproduced(
        project,
        draft_text,
        search_strategy_audit=search_strategy_audit,
    )
    components = [
        _score_structure(main_text, sections, zh=zh),
        _score_abstract(sections, abstract_audit, zh=zh),
        _score_methods(
            sections,
            search_query_file_present=search_query_file_present,
            search_query_reproduced=search_query_reproduced,
            zh=zh,
        ),
        _score_results(sections, prisma_audit, calculation_audit, figure_audit, zh=zh),
        _score_citations(citation_audit, main_text),
        _score_clinical_discussion(clinical_interpretation_audit, sections),
        _score_artifacts(
            project,
            figure_audit=figure_audit,
            figure_legend_audit=figure_legend_audit,
            cross_reference_audit=cross_reference_audit,
            table_footnote_audit=table_footnote_audit,
            calculation_audit=calculation_audit,
            primary_source_trace=primary_source_trace,
        ),
        _score_tone_and_readability(
            publication_tone_audit,
            readability_audit,
            project.load_json("manuscript_validation.json", subdir="manuscript"),
        ),
    ]
    benchmark_component = _score_published_benchmark_alignment(benchmark_review, zh=zh)
    if benchmark_component:
        components.append(benchmark_component)
    total = round(sum(float(item["score"]) for item in components), 1)
    max_score = sum(float(item["max_score"]) for item in components)
    similarity = round(total / max_score * 100, 1) if max_score else 0.0
    issues = _similarity_issues(components, similarity)
    return {
        "schema_version": 1,
        "language": language,
        "threshold": PUBLICATION_SIMILARITY_THRESHOLD,
        "similarity_score": similarity,
        "passed": similarity >= PUBLICATION_SIMILARITY_THRESHOLD,
        "summary": {
            "similarity_score": similarity,
            "threshold": PUBLICATION_SIMILARITY_THRESHOLD,
            "component_count": len(components),
            "components_passing": sum(1 for item in components if item.get("passed")),
            "components_below_target": sum(1 for item in components if not item.get("passed")),
            "main_word_count": _text_unit_count(main_text),
        },
        "components": components,
        "issues": issues,
        "next_actions": _similarity_next_actions(components, zh=zh),
    }


def render_publication_similarity_html(review: dict) -> str:
    language = _normalize_review_language(review.get("language") or "")
    zh = _is_zh_review_language(language)
    title = "MetaAgent 发表稿相似度审查" if zh else "MetaAgent Publication Similarity Review"
    subtitle = (
        "按真实发表Meta分析论文的结构、引用、统计报告和临床讨论画像打分。"
        if zh else
        "Scores the manuscript against a publication-style meta-analysis profile: structure, citations, statistical reporting, and clinical interpretation."
    )
    summary = review.get("summary") or {}
    component_rows = "\n".join(
        _render_component_row(item, language=language)
        for item in review.get("components") or []
    )
    if not component_rows:
        component_rows = (
            '<tr><td colspan="5">未记录评分维度。</td></tr>'
            if zh else
            '<tr><td colspan="5">No scoring components were recorded.</td></tr>'
        )
    actions = review.get("next_actions") or []
    action_items = "".join(f"<li>{escape(str(item))}</li>" for item in actions) or (
        "<li>无待处理建议。</li>" if zh else "<li>No next actions recorded.</li>"
    )
    labels = {
        "score": "相似度" if zh else "Similarity",
        "threshold": "阈值" if zh else "Threshold",
        "components": "通过维度" if zh else "Passing components",
        "words": "正文词/字数" if zh else "Main text units",
        "component": "维度" if zh else "Component",
        "status": "状态" if zh else "Status",
        "points": "得分" if zh else "Points",
        "details": "细节" if zh else "Details",
        "next": "下一步" if zh else "Next Actions",
    }
    chips = [
        _stat_chip(labels["score"], f"{review.get('similarity_score', 0)}%"),
        _stat_chip(labels["threshold"], f"{review.get('threshold', PUBLICATION_SIMILARITY_THRESHOLD)}%"),
        _stat_chip(labels["components"], f"{summary.get('components_passing', 0)}/{summary.get('component_count', 0)}"),
        _stat_chip(labels["words"], summary.get("main_word_count", 0)),
    ]
    actions_panel = f"""    <section class="panel">
      <h2>{labels["next"]}</h2>
      <ul>{action_items}</ul>
    </section>"""
    body = f"""{_page_header(title, subtitle, chips)}
  <main>
{_panel(labels["component"], _data_table([labels["status"], labels["component"], labels["points"], labels["details"]], component_rows))}
{actions_panel}
  </main>"""
    return _render_page(title=title, body=body, lang=_html_lang(language))


def _score_structure(main_text: str, sections: dict[str, str], *, zh: bool) -> dict[str, Any]:
    required = ["abstract", "introduction", "methods", "results", "discussion", "conclusion"]
    optional = ["tables", "figures", "references", "declarations"]
    covered_required = sum(1 for item in required if item in sections)
    covered_optional = sum(1 for item in optional if item in sections)
    word_units = _text_unit_count(main_text)
    length_points = 2 if word_units >= 4500 else 1 if word_units >= 2500 else 0
    score = covered_required / len(required) * 8 + min(covered_optional, 3) / 3 * 2 + length_points
    details = f"required={covered_required}/{len(required)}; optional={covered_optional}/{len(optional)}; main_units={word_units}"
    return _component("article_structure", "文章结构" if zh else "Article structure", score, 12, details)


def _score_abstract(sections: dict[str, str], abstract_audit: dict | None, *, zh: bool) -> dict[str, Any]:
    summary = (abstract_audit or {}).get("summary") or {}
    present = int(summary.get("present_labels") or 0)
    required = int(summary.get("required_labels") or 0) or 5
    forbidden = int(summary.get("forbidden_phrase_count") or 0)
    abstract = sections.get("abstract", "")
    if present:
        label_score = min(present / required, 1.0) * 7
    else:
        label_score = 5 if _text_unit_count(abstract) >= 120 else 2 if abstract.strip() else 0
    score = max(0, label_score + (1 if forbidden == 0 else 0))
    details = f"structured_labels={present}/{required}; forbidden_phrases={forbidden}; abstract_units={_text_unit_count(abstract)}"
    return _component("structured_abstract", "结构化摘要" if zh else "Structured abstract", score, 8, details)


def _search_query_reproduced(
    project: Project,
    draft_text: str,
    *,
    search_strategy_audit: dict | None,
) -> tuple[bool, bool]:
    summary = (search_strategy_audit or {}).get("summary") if isinstance(search_strategy_audit, dict) else None
    if isinstance(summary, dict):
        return bool(summary.get("query_file_present")), bool(summary.get("exact_query_reproduced"))
    query_path = project.base_dir / "search_query.txt"
    if not query_path.exists():
        return False, False
    query_text = query_path.read_text(encoding="utf-8", errors="replace").strip()
    normalized_query = _normalize_search_query_for_similarity(query_text)
    if not normalized_query:
        return True, False
    normalized_draft = _normalize_search_query_for_similarity(draft_text)
    return True, normalized_query in normalized_draft


def _normalize_search_query_for_similarity(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


def _score_methods(
    sections: dict[str, str],
    *,
    search_query_file_present: bool,
    search_query_reproduced: bool,
    zh: bool,
) -> dict[str, Any]:
    methods = sections.get("methods", "")
    patterns = [
        r"search|检索",
        r"eligib|纳入|排除|入选",
        r"screen|筛选",
        r"extract|提取",
        r"risk\s+of\s+bias|偏倚风险",
        r"statistical|fixed|random|inverse|统计|固定效应|随机效应|逆方差",
        r"grade|证据确定性|确定性",
        r"prisma|报告规范",
    ]
    hits = sum(1 for pattern in patterns if re.search(pattern, methods, flags=re.I))
    score = min(hits / len(patterns), 1.0) * 10 + (2 if search_query_reproduced else 0)
    details = (
        f"method_topics={hits}/{len(patterns)}; "
        f"search_query_file={bool(search_query_file_present)}; "
        f"exact_query_reproduced={bool(search_query_reproduced)}"
    )
    return _component("methods_specificity", "方法细节" if zh else "Methods specificity", score, 12, details)


def _score_results(
    sections: dict[str, str],
    prisma_audit: dict | None,
    calculation_audit: dict | None,
    figure_audit: dict | None,
    *,
    zh: bool,
) -> dict[str, Any]:
    results = sections.get("results", "")
    calc_summary = (calculation_audit or {}).get("summary") or {}
    figure_summary = (figure_audit or {}).get("summary") or {}
    checks = [
        bool(re.search(r"\b(?:OR|RR|HR|MD|SMD|IRR)\b|合并", results, flags=re.I)),
        bool(re.search(r"95\s*%\s*(?:CI|confidence interval)|95\s*%\s*可信区间|95\s*%\s*CI", results, flags=re.I)),
        bool(re.search(r"I[²2]|heterogeneity|异质性", results, flags=re.I)),
        bool(re.search(r"PRISMA|screened|assessed|included|筛选|全文|纳入", results, flags=re.I)),
        bool(re.search(r"forest|Figure|图|Table|表", results, flags=re.I)),
        bool(calc_summary.get("selected_primary_rows") or calc_summary.get("rows") or calculation_audit),
        bool(figure_summary.get("figures_present") or figure_summary.get("available_figures") or figure_audit),
    ]
    score = sum(1 for item in checks if item) / len(checks) * 14
    details = f"quantitative_checks={sum(1 for item in checks if item)}/{len(checks)}; prisma_audit={bool(prisma_audit)}"
    return _component("quantitative_results", "定量结果报告" if zh else "Quantitative results", score, 14, details)


def _score_citations(citation_audit: dict | None, main_text: str) -> dict[str, Any]:
    summary = (citation_audit or {}).get("summary") or {}
    refs = int(summary.get("reference_entries") or _reference_count_from_text(main_text))
    density = float(summary.get("citation_density_per_1000_words") or _citation_density(main_text))
    intro_cov = float(summary.get("introduction_cited_paragraph_rate") or 0)
    discussion_cov = float(summary.get("discussion_cited_paragraph_rate") or 0)
    failed = int(summary.get("failed_issues") or 0)
    mechanical = int(summary.get("mechanical_citation_density_paragraphs") or 0)
    repeated = int(summary.get("repeated_large_citation_clusters") or 0)
    excessive = bool(summary.get("excessive_citation_density"))
    score = 0.0
    score += min(refs / 20, 1.0) * 4
    score += min(density / 6.0, 1.0) * 3
    score += min((intro_cov + discussion_cov) / 1.34, 1.0) * 3
    score += 2 if failed == 0 and mechanical == 0 and repeated == 0 and not excessive else 0
    details = (
        f"references={refs}; density={density}; intro_coverage={intro_cov}; "
        f"discussion_coverage={discussion_cov}; failed={failed}; mechanical={mechanical}; "
        f"repeated={repeated}; excessive_density={excessive}"
    )
    return _component("citation_profile", "引用画像" if _is_zh_review_language((citation_audit or {}).get("language") or "") else "Citation profile", score, 12, details)


def _score_clinical_discussion(clinical_interpretation_audit: dict | None, sections: dict[str, str]) -> dict[str, Any]:
    summary = (clinical_interpretation_audit or {}).get("summary") or {}
    language = _normalize_review_language((clinical_interpretation_audit or {}).get("language") or "")
    zh = _is_zh_review_language(language)
    domain_count = int(summary.get("domain_count") or 8)
    covered = int(summary.get("covered_domains") or 0)
    result_context = bool(summary.get("result_context_present"))
    failed = int(summary.get("failed_issues") or 0)
    process = int(summary.get("process_framing_paragraphs") or 0)
    redundant = int(summary.get("redundant_domain_count") or 0)
    discussion = sections.get("discussion", "")
    paragraphs = int(summary.get("discussion_paragraph_count") or len(_paragraphs(discussion)))
    domain_score = min(covered / max(domain_count, 1), 1.0) * 10
    shape_score = 3 if 4 <= paragraphs <= 16 else 1 if paragraphs else 0
    guard_score = 5 if result_context and failed == 0 and process == 0 and redundant == 0 else 2 if result_context else 0
    score = domain_score + shape_score + guard_score
    details = f"domains={covered}/{domain_count}; result_context={result_context}; paragraphs={paragraphs}; process={process}; redundant={redundant}; failed={failed}"
    return _component("clinical_discussion", "临床讨论" if zh else "Clinical discussion", score, 18, details)


def _score_artifacts(
    project: Project,
    *,
    figure_audit: dict | None,
    figure_legend_audit: dict | None,
    cross_reference_audit: dict | None,
    table_footnote_audit: dict | None,
    calculation_audit: dict | None,
    primary_source_trace: dict | None,
) -> dict[str, Any]:
    checks = [
        (project.base_dir / "manuscript" / "draft.docx").exists(),
        (project.base_dir / "manuscript" / "draft.pdf").exists(),
        (project.base_dir / "references.bib").exists(),
        (project.base_dir / "search_query.txt").exists(),
        bool(calculation_audit and calculation_audit.get("passed") is not False),
        bool(primary_source_trace and primary_source_trace.get("passed") is not False),
        bool(figure_audit and figure_audit.get("passed") is not False),
        bool(figure_legend_audit and figure_legend_audit.get("passed") is not False),
        bool(cross_reference_audit and cross_reference_audit.get("passed") is not False),
        bool(table_footnote_audit and table_footnote_audit.get("passed") is not False),
    ]
    score = sum(1 for item in checks if item) / len(checks) * 14
    details = f"artifact_checks={sum(1 for item in checks if item)}/{len(checks)}"
    return _component("submission_artifacts", "投稿附件完整性" if _review_language_from_text((project.base_dir / "manuscript" / "draft.md").read_text(encoding="utf-8", errors="replace")) == "zh" else "Submission artifacts", score, 14, details)


def _score_tone_and_readability(
    publication_tone_audit: dict | None,
    readability_audit: dict | None,
    validation: Any,
) -> dict[str, Any]:
    validation = validation if isinstance(validation, dict) else {}
    validation_blockers = sum(
        1 for issue in validation.get("issues") or []
        if isinstance(issue, dict) and issue.get("severity") in {"error", "fail", "failed", "blocker"}
    )
    checks = [
        bool(publication_tone_audit and publication_tone_audit.get("passed") is True),
        bool(readability_audit and readability_audit.get("passed") is True),
        bool(validation.get("passed") is True),
        validation_blockers == 0,
    ]
    score = sum(1 for item in checks if item) / len(checks) * 10
    details = f"tone_passed={bool(publication_tone_audit and publication_tone_audit.get('passed') is True)}; readability_passed={bool(readability_audit and readability_audit.get('passed') is True)}; validation_blockers={validation_blockers}"
    return _component("tone_readability", "语气和可读性" if _is_zh_review_language((publication_tone_audit or {}).get("language") or "") else "Tone and readability", score, 10, details)


def _score_published_benchmark_alignment(benchmark_review: dict | None, *, zh: bool) -> dict[str, Any] | None:
    if not isinstance(benchmark_review, dict):
        return None
    gates = [gate for gate in (benchmark_review.get("gates") or []) if isinstance(gate, dict)]
    total_gates = len(gates)
    passed_gates = sum(1 for gate in gates if gate.get("passed") is True)
    gate_score = (passed_gates / total_gates * 10) if total_gates else 0.0
    numeric_score = _published_benchmark_numeric_score(benchmark_review)
    score = gate_score + numeric_score
    anchor = benchmark_review.get("published_anchor") if isinstance(benchmark_review.get("published_anchor"), dict) else {}
    observed = benchmark_review.get("observed_primary") if isinstance(benchmark_review.get("observed_primary"), dict) else {}
    details = (
        f"benchmark={benchmark_review.get('benchmark_id') or ''}; "
        f"gates={passed_gates}/{total_gates}; "
        f"numeric_alignment={round(numeric_score, 1)}/10; "
        f"anchor_effect={anchor.get('effect', 'NR')} "
        f"({anchor.get('ci_lower', 'NR')}-{anchor.get('ci_upper', 'NR')}); "
        f"observed_effect={observed.get('effect', 'NR')} "
        f"({observed.get('ci_lower', 'NR')}-{observed.get('ci_upper', 'NR')})"
    )
    return _component(
        "published_benchmark_alignment",
        "发表锚点对齐" if zh else "Published benchmark alignment",
        score,
        20,
        details,
    )


def _published_benchmark_numeric_score(benchmark_review: dict) -> float:
    anchor = benchmark_review.get("published_anchor") if isinstance(benchmark_review.get("published_anchor"), dict) else {}
    observed = benchmark_review.get("observed_primary") if isinstance(benchmark_review.get("observed_primary"), dict) else {}
    if not anchor or not observed:
        pooled = benchmark_review.get("pooled_effect") if isinstance(benchmark_review.get("pooled_effect"), dict) else {}
        anchor = anchor or {
            "effect": pooled.get("expected_effect"),
            "ci_lower": pooled.get("expected_ci_lower"),
            "ci_upper": pooled.get("expected_ci_upper"),
            "effect_measure": pooled.get("expected_effect_measure"),
            "model_preference": pooled.get("expected_model_preference"),
            "n_trials": pooled.get("expected_n_trials"),
        }
        observed = observed or {
            "effect": pooled.get("observed_effect"),
            "ci_lower": pooled.get("observed_ci_lower"),
            "ci_upper": pooled.get("observed_ci_upper"),
            "effect_measure": pooled.get("observed_effect_measure"),
            "model_preference": pooled.get("observed_model_preference"),
            "n_studies": pooled.get("observed_n_studies"),
        }
    score = 0.0
    if _normalized_token(anchor.get("effect_measure")) and _normalized_token(anchor.get("effect_measure")) == _normalized_token(observed.get("effect_measure")):
        score += 1.5
    expected_n = _coerce_int(anchor.get("n_trials") or anchor.get("n_studies"))
    observed_n = _coerce_int(observed.get("n_studies") or observed.get("n_trials"))
    if expected_n and observed_n and expected_n == observed_n:
        score += 1.5
    expected_total = _coerce_int(anchor.get("n_participants") or anchor.get("total_participants"))
    observed_total = _coerce_int(observed.get("total_participants") or observed.get("n_participants"))
    if expected_total and observed_total:
        diff = abs(expected_total - observed_total)
        score += 1.0 if diff == 0 else max(0.0, 1.0 - diff / max(expected_total, 1) * 10)
    score += _numeric_alignment_points(anchor.get("effect"), observed.get("effect"), full_points=3.0, tolerance=0.03)
    score += _numeric_alignment_points(anchor.get("ci_lower"), observed.get("ci_lower"), full_points=1.5, tolerance=0.04)
    score += _numeric_alignment_points(anchor.get("ci_upper"), observed.get("ci_upper"), full_points=1.5, tolerance=0.04)
    return min(score, 10.0)


def _numeric_alignment_points(expected: Any, observed: Any, *, full_points: float, tolerance: float) -> float:
    expected_number = _coerce_float(expected)
    observed_number = _coerce_float(observed)
    if expected_number is None or observed_number is None:
        return 0.0
    difference = abs(expected_number - observed_number)
    if difference <= tolerance:
        return full_points
    return max(0.0, full_points * (1.0 - difference / max(tolerance * 4, 1e-9)))


def _coerce_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _normalized_token(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def _component(component_id: str, label: str, score: float, max_score: float, details: str) -> dict[str, Any]:
    rounded = round(max(0.0, min(float(score), float(max_score))), 1)
    target = round(float(max_score) * 0.85, 1)
    return {
        "id": component_id,
        "label": label,
        "score": rounded,
        "max_score": max_score,
        "target_score": target,
        "percent": round(rounded / float(max_score) * 100, 1) if max_score else 0.0,
        "passed": rounded >= target,
        "details": details,
    }


def _similarity_issues(components: list[dict[str, Any]], similarity: float) -> list[dict[str, Any]]:
    issues = []
    if similarity < PUBLICATION_SIMILARITY_THRESHOLD:
        issues.append({
            "code": "publication_similarity_below_threshold",
            "severity": "warn",
            "message": f"Publication similarity score is {similarity}%, below the {PUBLICATION_SIMILARITY_THRESHOLD}% target.",
        })
    for item in components:
        if item.get("passed"):
            continue
        issues.append({
            "code": f"publication_similarity_component_low:{item.get('id')}",
            "severity": "warn",
            "component": item.get("id"),
            "message": f"{item.get('label')} scored {item.get('score')}/{item.get('max_score')}. {item.get('details')}",
        })
    return issues


def _similarity_next_actions(components: list[dict[str, Any]], *, zh: bool) -> list[str]:
    mapping_zh = {
        "article_structure": "补齐正式论文结构：摘要、引言、方法、结果、讨论、结论、表图、声明和参考文献。",
        "structured_abstract": "把摘要改成期刊常见结构，并保留主要效应量、研究数和证据确定性。",
        "methods_specificity": "补强方法学段落：检索式、筛选、提取、偏倚风险、统计模型、GRADE和发表偏倚处理。",
        "quantitative_results": "结果中明确报告PRISMA流程、合并效应、95%CI、异质性、图表和绝对效应。",
        "citation_profile": "提升引用深度和分布，避免大引用簇重复，把背景、方法和讨论声明分别引用到具体来源。",
        "clinical_discussion": "把讨论集中在效应大小、绝对获益、复合终点、安全性、适用性、执行和证据确定性。",
        "submission_artifacts": "补齐docx/PDF、BibTeX、检索式、图表、计算审计和来源追踪文件。",
        "tone_readability": "清理流程自述、超长句和内部工程措辞，保持正式医学论文语气。",
        "published_benchmark_alignment": "检查检索召回、纳入研究、参与者总数和主效应量是否与真实发表锚点一致。",
    }
    mapping_en = {
        "article_structure": "Complete the journal article shape: abstract, introduction, methods, results, discussion, conclusion, tables/figures, declarations, and references.",
        "structured_abstract": "Use a journal-style structured abstract with the main effect, study count, and certainty.",
        "methods_specificity": "Strengthen methods: search strategy, screening, extraction, risk of bias, statistical model, GRADE, and publication-bias handling.",
        "quantitative_results": "Report PRISMA flow, pooled effect, 95% CI, heterogeneity, figures/tables, and absolute effects in Results.",
        "citation_profile": "Improve citation depth and distribution; cite specific sources rather than repeating broad citation bundles.",
        "clinical_discussion": "Focus Discussion on effect size, absolute benefit, composite endpoint meaning, safety, applicability, implementation, and certainty.",
        "submission_artifacts": "Include DOCX/PDF, BibTeX, search query, figures, calculation audit, and source trace files.",
        "tone_readability": "Remove process commentary, overlong sentences, and internal engineering wording.",
        "published_benchmark_alignment": "Check retrieval recall, included studies, participant totals, and the primary effect against the published benchmark anchor.",
    }
    mapping = mapping_zh if zh else mapping_en
    return [mapping.get(str(item.get("id")), str(item.get("details") or "")) for item in components if not item.get("passed")][:6]


def _render_component_row(item: dict[str, Any], *, language: str) -> str:
    passed = bool(item.get("passed"))
    status = "通过" if passed and _is_zh_review_language(language) else "Pass" if passed else "需改进" if _is_zh_review_language(language) else "Needs work"
    cls = "pass" if passed else "warn"
    return (
        "<tr>"
        f'<td class="{cls}">{escape(status)}</td>'
        f"<td>{escape(str(item.get('label') or item.get('id') or ''))}</td>"
        f"<td>{escape(str(item.get('score', 0)))}/{escape(str(item.get('max_score', 0)))} ({escape(str(item.get('percent', 0)))}%)</td>"
        f"<td>{escape(str(item.get('details') or ''))}</td>"
        "</tr>"
    )


def _looks_like_meta_publication(text: str, facts: dict[str, Any]) -> bool:
    if facts.get("report_type") == "meta":
        readiness = facts.get("evidence_readiness") or {}
        if readiness.get("blockers"):
            return False
        primary = facts.get("primary_effect") or {}
        selected_rows = readiness.get("selected_primary_rows") or []
        primary_n = _coerce_int(primary.get("n_studies")) or len(selected_rows)
        return primary_n >= 2
    headings = set(_h2_sections(text).keys())
    return {"abstract", "methods", "results", "discussion"}.issubset(headings) and _text_unit_count(text) >= 2500


def _main_article_text(text: str) -> str:
    main = str(text or "")
    cut_points = [
        pos for marker in ("## Supplementary Materials", "## 补充材料")
        if (pos := main.find(marker)) >= 0
    ]
    if cut_points:
        main = main[:min(cut_points)]
    return main


def _h2_sections(text: str) -> dict[str, str]:
    matches = list(re.finditer(r"^##\s+(.+?)\s*$", str(text or ""), flags=re.M))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        key = _canonical_heading(match.group(1))
        sections.setdefault(key, text[start:end].strip())
    return sections


def _canonical_heading(heading: str) -> str:
    raw = re.sub(r"[*_`#]+", "", str(heading or "")).strip().lower()
    raw = re.sub(r"\s+", " ", raw)
    zh_map = {
        "摘要": "abstract",
        "引言": "introduction",
        "绪论": "introduction",
        "背景": "introduction",
        "方法": "methods",
        "材料与方法": "methods",
        "结果": "results",
        "讨论": "discussion",
        "结论": "conclusion",
        "表格": "tables",
        "表": "tables",
        "图": "figures",
        "图表": "figures",
        "声明": "declarations",
        "利益冲突": "declarations",
        "参考文献": "references",
    }
    if raw in zh_map:
        return zh_map[raw]
    if raw.startswith("table"):
        return "tables"
    if raw.startswith("figure"):
        return "figures"
    if raw in {"references", "bibliography"}:
        return "references"
    if raw in {"declarations", "funding", "ethics"}:
        return "declarations"
    return raw


def _review_language_from_text(text: str) -> str:
    raw = re.sub(r"```[\s\S]*?```", " ", str(text or ""))
    cjk_chars = len(re.findall(r"[\u4e00-\u9fff]", raw))
    latin_words = len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", raw))
    return "zh" if cjk_chars and cjk_chars >= latin_words else "en"


def _text_unit_count(text: str) -> int:
    cleaned = re.sub(r"```[\s\S]*?```", " ", str(text or ""))
    cleaned = re.sub(r"!\[[^\]]*\]\([^)]+\)", " ", cleaned)
    cleaned = re.sub(r"\[[^\]]+\]\([^)]+\)", " ", cleaned)
    cleaned = "\n".join(line for line in cleaned.splitlines() if not line.lstrip().startswith("|"))
    return len(re.findall(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?|[\u4e00-\u9fff]", cleaned))


def _paragraphs(text: str) -> list[str]:
    return [
        item.strip()
        for item in re.split(r"\n\s*\n+", str(text or ""))
        if item.strip() and not item.strip().startswith(("#", "|", "!["))
    ]


def _reference_count_from_text(text: str) -> int:
    ref_match = re.search(r"^##\s+(?:References|参考文献)\s*$([\s\S]*)", str(text or ""), flags=re.M)
    if not ref_match:
        return 0
    return len(re.findall(r"^\s*\[\d+\]", ref_match.group(1), flags=re.M))


def _citation_density(text: str) -> float:
    main = _main_article_text(text)
    citations = re.findall(r"[\[［][0-9\s,，、;；\-–—至]+[\]］]", main)
    units = _text_unit_count(main)
    return round(len(citations) / units * 1000, 2) if units else 0.0


def _coerce_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0
