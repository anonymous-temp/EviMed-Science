import re
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import new_meta.main as main_module
import new_meta.core.proofreading as proofreading_module
import pytest
from new_meta.agents.writing_agent import WritingAgent
from new_meta.core.artifact_package import _build_citation_audit_review
from new_meta.core.manuscript_polish import audit_manuscript_style, polish_manuscript_text, preservation_guard_issues
from new_meta.core.manuscript_text_metrics import main_publication_word_count
from new_meta.core.proofreading import LanguageToolProofreader
from new_meta.core.project import Project
from new_meta.core.reference_classification import reference_entry_looks_like_numeric_effect_source
from new_meta.main import _add_methodology_references, _filter_evidence_context_references
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.risk_of_bias import StudyRoB
from new_meta.tools.reference_manager import ReferenceManager


def _web_clinical_discussion_text(
    *,
    citation: str = "[1]",
    effect: str = "OR 0.66",
    endpoint: str = "primary outcome",
) -> str:
    return (
        f"The pooled {effect} should be interpreted as the direction and magnitude of effect for {endpoint} {citation}.\n\n"
        "Clinical translation depends on baseline risk, absolute risk difference, and number needed to treat.\n\n"
        f"The endpoint should be interpreted by its clinical components and follow-up time, while benefit-harm balance requires safety, adverse events, tolerability, and treatment discontinuation to be considered {citation}.\n\n"
        "Applicability depends on patient age, comorbidity, subgroup profile, disease severity, renal function, and background therapy.\n\n"
        f"Implementation requires monitoring, follow-up, patient preference, cost, and access, and certainty of evidence, heterogeneity, publication bias, and other limitations should temper inference {citation}."
    )


def _protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Do systemic corticosteroids reduce mortality in critically ill adults with COVID-19?",
        pico=PICO(
            population="Critically ill adults with COVID-19",
            intervention="Systemic corticosteroids",
            comparator="Usual care or placebo",
            outcome_primary="28-day all-cause mortality",
        ),
        effect_measure="OR",
        model_preference="fixed",
    )


def test_cli_output_language_resolver_prefers_explicit_user_choice() -> None:
    assert main_module._resolve_output_language(
        SimpleNamespace(topic="SGLT2 inhibitors for heart failure", output_language="中文")
    ) == "zh"
    assert main_module._resolve_output_language(
        SimpleNamespace(topic="二甲双胍治疗2型糖尿病", language="English")
    ) == "en"
    assert main_module._resolve_output_language(
        SimpleNamespace(topic="二甲双胍治疗2型糖尿病")
    ) == "zh"
    assert main_module._resolve_output_language(
        SimpleNamespace(topic="SGLT2 inhibitors for heart failure")
    ) == "en"
    with pytest.raises(ValueError, match="output language"):
        main_module._resolve_output_language(
            SimpleNamespace(topic="SGLT2 inhibitors for heart failure", output_language="Klingon")
        )


@pytest.mark.parametrize(
    ("body", "heading", "expected"),
    [
        ("## 结果\n\nTrial findings.", "Results", "Trial findings."),
        ("**Results**\n\nTrial findings.", "Results", "Trial findings."),
        ("Results:\n\nTrial findings.", "Results", "Trial findings."),
        ("Trial findings.", "Results", "Trial findings."),
    ],
)
def test_section_writer_removes_provider_duplicate_headings_across_supported_languages(
    body: str,
    heading: str,
    expected: str,
) -> None:
    assert WritingAgent(lang="en")._strip_duplicate_heading(body, heading) == expected


def test_explicit_polish_manuscript_defaults_to_full_scope_without_scope_override(monkeypatch) -> None:
    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_REWRITE_SCOPE", "targeted")

    assert main_module._resolve_manuscript_polish_scope(
        SimpleNamespace(polish_manuscript=True, manuscript_polish_scope=None, polish_scope=None)
    ) == "all"
    assert main_module._resolve_manuscript_polish_scope(
        SimpleNamespace(polish_manuscript=True, manuscript_polish_scope="targeted", polish_scope=None)
    ) == "targeted"
    assert main_module._resolve_manuscript_polish_scope(
        SimpleNamespace(polish_manuscript=False, manuscript_polish_scope=None, polish_scope=None)
    ) == "targeted"


def test_project_polish_rejects_post_processing_that_changes_citations(tmp_path, monkeypatch) -> None:
    project = Project("citation-safe polish", output_dir=tmp_path / uuid4().hex)
    draft = "\n\n".join(
        [
            "# Manuscript",
            "## Discussion",
            "The pooled HR was 0.78 (95% CI 0.72 to 0.85), and clinical interpretation remains cautious [1].",
            "## References",
            "[1] Trial reference.",
        ]
    )
    project.save_text("draft.md", draft, subdir="manuscript")
    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", False)
    monkeypatch.setattr(
        WritingAgent,
        "_polish_publication_body_language",
        staticmethod(lambda text, compress_discussion=False: text),
    )
    monkeypatch.setattr(
        WritingAgent,
        "_backfill_publication_inline_citations",
        staticmethod(lambda text: text.replace("cautious [1].", "cautious [1, 2].")),
    )
    monkeypatch.setattr(
        main_module,
        "_apply_post_polish_citation_audit_backfill",
        lambda project, polished, **kwargs: (polished, {"applied": False, "mode": "test"}),
    )
    monkeypatch.setattr(
        WritingAgent,
        "_normalize_citation_marker_style",
        staticmethod(lambda text, lang="en": text),
    )

    result = main_module._polish_project_manuscript(
        project,
        SimpleNamespace(no_polish_manuscript=False, polish_manuscript=True, manuscript_polish_scope="targeted", polish_scope=None),
        model=None,
        lang="en",
    )

    saved = (project.base_dir / "manuscript" / "draft.md").read_text(encoding="utf-8")
    audit = project.load_json("manuscript_polish_audit.json", subdir="manuscript")
    assert result == draft
    assert saved == draft
    assert audit["final_preservation_guard"]["applied"] is True
    assert "citations_changed" in audit["final_preservation_guard"]["issue_codes"]


def test_project_polish_rejects_post_processing_that_strengthens_clinical_claim(tmp_path, monkeypatch) -> None:
    project = Project("claim-safe polish", output_dir=tmp_path / uuid4().hex)
    draft = "\n\n".join(
        [
            "# Manuscript",
            "## Discussion",
            "The pooled HR was 0.78 (95% CI 0.72 to 0.85), and the estimate should be interpreted with baseline risk [1].",
            "## References",
            "[1] Trial reference.",
        ]
    )
    project.save_text("draft.md", draft, subdir="manuscript")
    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", False)
    monkeypatch.setattr(
        WritingAgent,
        "_polish_publication_body_language",
        staticmethod(lambda text, compress_discussion=False: text.replace("was 0.78", "reduced risk")),
    )
    monkeypatch.setattr(
        WritingAgent,
        "_backfill_publication_inline_citations",
        staticmethod(lambda text: text),
    )
    monkeypatch.setattr(
        main_module,
        "_apply_post_polish_citation_audit_backfill",
        lambda project, polished, **kwargs: (polished, {"applied": False, "mode": "test"}),
    )
    monkeypatch.setattr(
        WritingAgent,
        "_normalize_citation_marker_style",
        staticmethod(lambda text, lang="en": text),
    )

    result = main_module._polish_project_manuscript(
        project,
        SimpleNamespace(no_polish_manuscript=False, polish_manuscript=True, manuscript_polish_scope="targeted", polish_scope=None),
        model=None,
        lang="en",
    )

    saved = (project.base_dir / "manuscript" / "draft.md").read_text(encoding="utf-8")
    audit = project.load_json("manuscript_polish_audit.json", subdir="manuscript")
    assert result == draft
    assert saved == draft
    assert audit["final_preservation_guard"]["applied"] is True
    assert {
        "numeric_tokens_changed",
        "clinical_claim_terms_changed",
        "directional_terms_changed",
    } & set(audit["final_preservation_guard"]["issue_codes"])


def test_final_llm_readiness_review_is_saved_after_final_draft(tmp_path, monkeypatch) -> None:
    project = Project("final readiness", output_dir=tmp_path / uuid4().hex)
    project.save_text(
        "draft.md",
        "# Title\n\n## Abstract\n\n**Results:** HR 0.81.\n\n## Discussion\n\nClinical interpretation.\n",
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_facts.json",
        {
            "report_type": "meta",
            "manuscript_mode": "clinical_meta_analysis",
            "primary_effect": {"n_studies": 2, "effect_measure": "HR", "pooled_effect": 0.81},
            "source_provenance": {"counts": {"primary_report": 2}, "publication_blocking_count": 0},
            "evidence_readiness": {"status": "ready", "blocker_codes": [], "warnings": []},
        },
        subdir="manuscript",
    )
    project.save_json("manuscript_validation.json", {"passed": True, "issues": []}, subdir="manuscript")
    project.save_json("manuscript_quality_gate.json", {"passed": True, "summary": {"issue_count": 0}}, subdir="manuscript")
    project.save_json("submission_quality_gate.json", {"status": "pass", "failed_count": 0, "checks": []}, subdir="manuscript")
    monkeypatch.setattr(main_module, "LLM_API_KEY", "test-key")

    def fake_review(self, manuscript, facts, **kwargs):
        assert "Clinical interpretation" in manuscript
        assert facts["source_provenance"]["counts"]["primary_report"] == 2
        assert "citation_audit" in kwargs
        assert kwargs["submission_quality_gate"]["status"] == "pass"
        return {
            "schema_version": 1,
            "enabled": True,
            "status": "ok",
            "decision": "minor_revision",
            "score": 86,
            "summary": "Clinically coherent with ordinary author checks remaining.",
            "issues": [],
            "required_user_inputs": [],
            "citation_or_provenance_concerns": [],
            "safe_to_submit_without_human_review": False,
        }

    monkeypatch.setattr(WritingAgent, "_llm_final_manuscript_readiness_review", fake_review)

    review = main_module._run_final_manuscript_llm_readiness_review(project, model=None, lang="en")

    saved = project.load_json("manuscript_llm_readiness_review.json", subdir="manuscript")
    assert review["status"] == "ok"
    assert saved["decision"] == "minor_revision"
    assert saved["score"] == 86


def test_discussion_prompt_prioritizes_clinical_interpretation_over_process_commentary() -> None:
    from new_meta.prompts.writing_prompts import DISCUSSION_PROMPT

    lowered = DISCUSSION_PROMPT.lower()
    assert "absolute-risk" in lowered or "absolute risk" in lowered
    assert "baseline risk" in lowered
    assert "benefit-harm" in lowered or "benefit harm" in lowered
    assert "do not make process transparency" in lowered
    assert "source verification" in lowered or "source audit" in lowered
    assert "8-14 paragraphs" in lowered
    assert "one paragraph per clinical theme" in lowered
    assert "do not repeat baseline risk" in lowered


def _minimal_meta_facts_for_language_tests() -> dict:
    return {
        "report_type": "meta",
        "primary_effect": {
            "outcome_name": "cardiovascular death or hospitalization for heart failure",
            "effect_measure": "HR",
            "n_studies": 2,
            "pooled_effect": 0.78,
            "ci_lower": 0.72,
            "ci_upper": 0.85,
            "p_value": 0.0001,
            "i_squared": 0.0,
            "tau_squared": 0.0,
            "model": "fixed",
            "studies": [
                {"study_id": "DELIVER", "effect": 0.82, "se": 0.05, "weight": 48.0},
                {"study_id": "EMPEROR", "effect": 0.76, "se": 0.04, "weight": 52.0},
            ],
        },
        "studies": {"primary_analysis_count": 2},
        "prisma": {
            "records_identified": 24,
            "records_after_dedup": 18,
            "full_text_assessed": 4,
            "studies_included": 2,
        },
        "search": {
            "source_names": ["PubMed"],
            "source_counts": {"PubMed": 24},
            "query": "(SGLT2 inhibitors) AND (HFpEF OR preserved ejection fraction)",
        },
        "primary_population": {
            "selected_total_participants": 12251,
            "selected_events_intervention": 1100,
            "selected_total_intervention": 6128,
            "selected_events_control": 1366,
            "selected_total_control": 6123,
        },
        "absolute_effects": {
            "method": "proportional_hazards_baseline_risk_translation",
            "scenarios": [
                {
                    "label": "Observed comparator risk in included trials",
                    "assumed_control_risk_per_1000": 183,
                    "intervention_risk_per_1000": 146,
                    "absolute_effect_per_1000": -37,
                    "ci_lower_absolute_per_1000": -52,
                    "ci_upper_absolute_per_1000": -27,
                    "nnt": 27,
                    "nnt_ci_lower": 20,
                    "nnt_ci_upper": 38,
                }
            ],
        },
        "evidence_readiness": {
            "status": "ready",
            "blockers": [],
            "warnings": [],
            "selected_primary_rows": [
                {
                    "row_id": "DELIVER:0",
                    "study_id": "DELIVER",
                    "study_label": "DELIVER",
                    "outcome_name": "cardiovascular death or worsening heart failure",
                    "events_intervention": 610,
                    "total_intervention": 3131,
                    "events_control": 769,
                    "total_control": 3132,
                    "effect": 0.82,
                    "se": 0.05,
                    "source_location": "Table 2, p. 7",
                    "source_quote": "The primary outcome occurred less often with dapagliflozin than placebo.",
                    "source_quote_verified": True,
                    "extraction_confidence": "high",
                },
                {
                    "row_id": "EMPEROR:0",
                    "study_id": "EMPEROR",
                    "study_label": "EMPEROR-Preserved",
                    "outcome_name": "cardiovascular death or hospitalization for heart failure",
                    "events_intervention": 490,
                    "total_intervention": 2997,
                    "events_control": 597,
                    "total_control": 2991,
                    "effect": 0.76,
                    "se": 0.04,
                    "source_location": "Table 2, p. 8",
                    "source_quote": "Empagliflozin reduced the combined risk of cardiovascular death or hospitalization for heart failure.",
                    "source_quote_verified": True,
                    "extraction_confidence": "high",
                },
            ],
        },
        "grade": {
            "outcomes": [
                {
                    "outcome_name": "cardiovascular death or hospitalization for heart failure",
                    "certainty": "Moderate",
                    "domains": [],
                }
            ]
        },
        "writing_constraints": {"publication_min_main_words": 100},
    }


def _continuous_md_meta_facts_for_language_tests() -> dict:
    facts = deepcopy(_minimal_meta_facts_for_language_tests())
    facts["primary_effect"].update(
        {
            "outcome_name": "HbA1c change from baseline",
            "effect_measure": "MD",
            "pooled_effect": -0.62,
            "ci_lower": -0.84,
            "ci_upper": -0.40,
            "p_value": 0.002,
            "studies": [
                {"study_id": "GLP1_TRIAL_A", "effect": -0.58, "se": 0.11, "weight": 46.0},
                {"study_id": "GLP1_TRIAL_B", "effect": -0.66, "se": 0.10, "weight": 54.0},
            ],
        }
    )
    facts["search"]["query"] = "(type 2 diabetes) AND (GLP-1 receptor agonists) AND HbA1c"
    facts["primary_population"] = {
        "selected_total_participants": 900,
        "selected_events_intervention": None,
        "selected_total_intervention": None,
        "selected_events_control": None,
        "selected_total_control": None,
    }
    facts["absolute_effects"] = {}
    facts["grade"]["outcomes"][0]["outcome_name"] = "HbA1c change from baseline"
    for index, row in enumerate(facts["evidence_readiness"]["selected_primary_rows"], start=1):
        row.update(
            {
                "row_id": f"GLP1_TRIAL_{index}:0",
                "study_id": f"GLP1_TRIAL_{index}",
                "study_label": f"GLP-1 Trial {index}",
                "outcome_name": "HbA1c change from baseline",
                "events_intervention": None,
                "total_intervention": None,
                "events_control": None,
                "total_control": None,
                "effect": -0.58 if index == 1 else -0.66,
                "se": 0.11 if index == 1 else 0.10,
                "source_location": "Table 2",
                "source_quote": "The trial reported mean change in HbA1c from baseline by treatment group.",
            }
        )
    return facts


def test_reference_classifier_recognizes_real_drug_outcome_trial_title_without_trial_keyword() -> None:
    assert reference_entry_looks_like_numeric_effect_source(
        "Lincoff AM, Brown-Frandsen K, Colhoun HM, et al. "
        "Semaglutide and Cardiovascular Outcomes in Obesity without Diabetes. "
        "N Engl J Med. 2023;389:2221-2232."
    )
    assert not reference_entry_looks_like_numeric_effect_source(
        "Example Authors. Network meta-analysis of semaglutide for obesity outcomes. BMJ. 2024."
    )


def test_generic_fact_locked_writer_outputs_chinese_when_requested() -> None:
    writer = WritingAgent(lang="zh")
    protocol = ResearchProtocol(
        research_question="在射血分数保留或轻度降低的心力衰竭成人中，SGLT2抑制剂能否降低心血管死亡或心衰住院？",
        pico=PICO(
            population="射血分数保留或轻度降低的心力衰竭成人",
            intervention="SGLT2抑制剂",
            comparator="安慰剂",
            outcome_primary="心血管死亡或心衰住院",
        ),
        effect_measure="HR",
        model_preference="fixed",
    )

    manuscript = writer._write_generic_meta_fallback_report(
        protocol=protocol,
        facts=_minimal_meta_facts_for_language_tests(),
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    assert "## 摘要" in manuscript
    assert "## 引言" in manuscript
    assert "## 方法" in manuscript
    assert "## 结果" in manuscript
    assert "## 讨论" in manuscript
    assert "## 参考文献" in manuscript
    assert "## Abstract" not in manuscript
    assert "## Introduction" not in manuscript
    assert "## Methods" not in manuscript
    assert "跨来源去重和同源记录合并（移除6条）" in manuscript
    assert "剩余18条进入题名/摘要筛选" in manuscript
    cjk_chars = len(re.findall(r"[\u4e00-\u9fff]", manuscript))
    latin_words = len(re.findall(r"\b[A-Za-z][A-Za-z'-]*\b", manuscript))
    assert cjk_chars > latin_words


def test_generic_meta_discussion_stays_clinical_instead_of_process_framed() -> None:
    writer = WritingAgent()
    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question=(
                "Do SGLT2 inhibitors reduce cardiovascular death or hospitalization "
                "for heart failure in adults with mildly reduced or preserved ejection fraction?"
            ),
            pico=PICO(
                population="Adults with heart failure with mildly reduced or preserved ejection fraction",
                intervention="SGLT2 inhibitors",
                comparator="Placebo",
                outcome_primary="Cardiovascular death or hospitalization for heart failure",
            ),
            effect_measure="HR",
            model_preference="fixed",
        ),
        facts=_minimal_meta_facts_for_language_tests(),
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    discussion = manuscript.split("## Discussion", 1)[1].split("## Conclusion", 1)[0]
    forbidden = [
        "structured handoff",
        "human review",
        "auditability",
        "source quote",
        "source appendix",
        "source-verification",
        "source verification",
        "generated manuscript",
        "calculation summary",
        "final checks",
        "evidence chain",
        "reviewers a concrete list",
        "selected rows",
        "selected primary rows",
        "source-linked",
    ]
    assert not any(phrase.lower() in discussion.lower() for phrase in forbidden)
    assert "baseline risk" in discussion
    assert "absolute benefit" in discussion
    assert "composite" in discussion
    assert "safety" in discussion.lower()
    assert "subgroup" in discussion.lower()
    assert "SGLT2 inhibitors lowers" not in discussion
    assert "SGLT2 inhibitors lower" in discussion


def test_generic_english_meta_fallback_does_not_carry_heart_failure_template_into_other_topics() -> None:
    facts = _minimal_meta_facts_for_language_tests()
    facts["primary_effect"]["outcome_name"] = "28-day all-cause mortality"
    facts["primary_effect"]["effect_measure"] = "OR"
    facts["grade"]["outcomes"][0]["outcome_name"] = "28-day all-cause mortality"
    facts["search"]["query"] = "(COVID-19) AND (corticosteroids) AND mortality"
    facts["search"]["source_counts"] = {"PubMed": 24}
    for index, row in enumerate(facts["evidence_readiness"]["selected_primary_rows"], start=1):
        row["study_id"] = f"COVID_STEROID_{index}"
        row["study_label"] = f"COVID Steroid Trial {index}"
        row["outcome_name"] = "28-day all-cause mortality"
        row["source_quote"] = "The trial reported 28-day mortality by treatment group."
    writer = WritingAgent()

    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question=(
                "Do systemic corticosteroids reduce 28-day all-cause mortality "
                "in critically ill adults with COVID-19?"
            ),
            pico=PICO(
                population="Critically ill adults with COVID-19",
                intervention="Systemic corticosteroids",
                comparator="Placebo or usual care",
                outcome_primary="28-day all-cause mortality",
            ),
            effect_measure="OR",
            model_preference="random",
        ),
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    main_text = manuscript.split("## References", 1)[0].lower()
    forbidden = [
        "sglt2",
        "heart failure",
        "hfpef",
        "hfmref",
        "ejection fraction",
        "cardiovascular death",
        "natriuresis",
        "osmotic diuresis",
        "arni",
        "mra",
        "genitourinary",
        "ketoacidosis",
        "worsening heart failure",
    ]
    assert not any(term in main_text for term in forbidden)
    assert "time-to-event" not in main_text
    discussion = manuscript.split("## Discussion", 1)[1].split("## Conclusion", 1)[0]
    discussion_lower = discussion.lower()
    assert "critically ill adults with covid-19" in discussion_lower
    assert "28-day all-cause mortality" in discussion_lower
    assert "baseline risk" in discussion_lower
    assert "absolute" in discussion_lower


def test_generic_english_meta_fallback_uses_continuous_outcome_language_for_md() -> None:
    writer = WritingAgent()

    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question=(
                "Do GLP-1 receptor agonists reduce HbA1c in adults with type 2 diabetes?"
            ),
            pico=PICO(
                population="Adults with type 2 diabetes",
                intervention="GLP-1 receptor agonists",
                comparator="Placebo or usual care",
                outcome_primary="HbA1c change from baseline",
            ),
            effect_measure="MD",
            model_preference="random",
        ),
        facts=_continuous_md_meta_facts_for_language_tests(),
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    main_text = manuscript.split("## Supplementary Materials", 1)[0].lower()
    forbidden = [
        "risk of hba1c",
        "event-count endpoint",
        "event counts",
        "aggregate events",
        "absolute risk",
        "baseline risk",
        "number needed to treat",
        "nnt",
        "prevented events",
    ]
    assert not any(phrase in main_text for phrase in forbidden)
    assert "mean difference" in main_text
    assert "measurement scale" in main_text
    assert "clinically meaningful difference" in main_text
    assert "baseline value" in main_text
    assert "MD -0.62" in manuscript
    assert "HbA1c change from baseline" in manuscript


def test_grade_summary_table_uses_publication_language_not_pipeline_jargon() -> None:
    grade = {
        "outcome_name": "All-cause mortality at 28 days",
        "certainty": "Moderate",
        "effect_summary": "OR 0.66 (95% CI: 0.53 to 0.82)",
        "domains": [
            {
                "domain": "indirectness",
                "rating": "no concern",
                "rationale": (
                    "Rule-based P/I/C/O directness check found no obvious population, intervention, "
                    "comparator, or outcome mismatch. P/I/C/design fields were incomplete, but verified "
                    "primary outcome rows matched the pooled outcome in 7/7 contributing studies."
                ),
            },
            {
                "domain": "imprecision",
                "rating": "no concern",
                "rationale": "Total N=1703 (extracted arm totals) vs OIS=600; CI width=0.428; CI crosses null=False.",
            },
        ],
    }

    table = WritingAgent()._fallback_grade_table(grade)
    zh_table = WritingAgent(lang="zh")._fallback_grade_table(grade)

    forbidden = [
        "Rule-based",
        "P/I/C",
        "P/I/C/design",
        "OIS",
        "CI crosses null",
        "False",
        "规则化P/I/C/O",
    ]
    assert not any(term in table for term in forbidden)
    assert not any(term in zh_table for term in forbidden)
    assert "sufficiently direct for the review question" in table
    assert "confidence interval did not cross the null" in table
    assert "人群、干预、对照和结局" in zh_table
    assert "置信区间未跨越无效值" in zh_table


def test_grade_publication_bias_serious_low_k_states_downgrade_in_both_languages() -> None:
    grade = {
        "outcome_name": "Cardiovascular death or heart failure hospitalization",
        "certainty": "Moderate",
        "effect_summary": "HR 0.81 (95% CI: 0.74 to 0.88)",
        "domains": [
            {
                "domain": "publication_bias",
                "rating": "serious",
                "details": {"n_studies": 2, "reason": "too_few_studies_for_small_study_effect_tests"},
            },
        ],
    }

    table = WritingAgent()._fallback_grade_table(grade)
    zh_table = WritingAgent(lang="zh")._fallback_grade_table(grade)

    assert "a downgrade was applied for publication-bias uncertainty" in table
    assert "no downgrade was applied for publication bias" not in table
    assert "因此因发表偏倚不确定性降级" in zh_table
    assert "未因发表偏倚降级" not in zh_table


def test_grade_serious_indirectness_uses_topic_specific_clinical_language() -> None:
    grade = {
        "outcome_name": "All-cause mortality at 28 days",
        "certainty": "Low",
        "effect_summary": "OR 0.66 (95% CI: 0.53 to 0.82)",
        "domains": [
            {
                "domain": "indirectness",
                "rating": "serious",
                "rationale": (
                    "Rule-based P/I/C/O directness check found possible mismatch. "
                    "P/I/C/design fields were incomplete."
                ),
            },
        ],
    }

    table = WritingAgent()._fallback_grade_table(grade)
    zh_table = WritingAgent(lang="zh")._fallback_grade_table(grade)

    forbidden = ["Rule-based", "P/I/C", "P/I/C/design", "规则化P/I/C/O", "结构化GRADE理由"]
    assert not any(term in table for term in forbidden)
    assert not any(term in zh_table for term in forbidden)
    assert "critical-care subgroup extraction" in table
    assert "mortality windows" in table
    assert "危重症亚组提取" in zh_table
    assert "死亡率时间窗" in zh_table


def test_covid_contextual_source_appendix_cites_retained_nonpooled_records() -> None:
    refs = "\n\n".join(
        [
            "[5] NCT04360876. Targeted Steroids pilot trial.",
            "[8] Metcovid. Methylprednisolone as adjunctive therapy.",
            "[9] Intravenous methylprednisolone pulse as COVID-19 therapy.",
            "[10] rs-66909. Methylprednisolone Pulse Therapy.",
            "[12] GLUCOCOVID randomized trial.",
            "[15] EU Clinical Trials Register 2020-001395-15.",
            "[16] COVID-NMA Steroids-SARI trial living-data record.",
            "[20] Not Receiving Oxygen. NEJM Evidence.",
        ]
    )

    contextual = WritingAgent._citation_for_reference_patterns(
        refs,
        [
            r"NCT04360876",
            r"Metcovid|methylprednisolone as adjunctive therapy",
            r"Intravenous methylprednisolone pulse",
            r"rs-66909|Methylprednisolone Pulse Therapy",
            r"GLUCOCOVID",
            r"2020-001395-15",
            r"Steroids-SARI trial living-data record",
        ],
    )
    non_oxygen = WritingAgent._citation_for_reference_patterns(
        refs,
        [r"Not Receiving Oxygen|NEJM Evidence"],
    )
    appendix = WritingAgent._covid_contextual_source_records_appendix(contextual)
    zh_appendix = WritingAgent._covid_contextual_source_records_appendix(contextual, zh=True)

    assert contextual == "[5,8-10,12,15,16]"
    assert non_oxygen == "[20]"
    assert "did not supply an independent selected mortality comparison" in appendix
    assert "[5,8-10,12,15,16]" in appendix
    assert "未提供可独立进入主要合成的选定死亡率比较" in zh_appendix
    assert "[5,8-10,12,15,16]" in zh_appendix


def test_covid_corticosteroid_no_polish_has_specific_limitations_and_clean_source_language() -> None:
    facts = _minimal_meta_facts_for_language_tests()
    facts["primary_effect"].update(
        {
            "outcome_name": "28-day all-cause mortality",
            "effect_measure": "OR",
            "n_studies": 7,
            "pooled_effect": 0.66,
            "ci_lower": 0.53,
            "ci_upper": 0.82,
            "i_squared": 15.6,
            "tau_squared": 0.021,
        }
    )
    facts["primary_population"] = {
        "selected_total_participants": 1703,
        "selected_events_intervention": 222,
        "selected_total_intervention": 678,
        "selected_events_control": 425,
        "selected_total_control": 1025,
    }
    facts["grade"]["outcomes"][0].update(
        {
            "outcome_name": "All-cause mortality at 28 days post-randomization or initiation of treatment.",
            "effect_summary": "OR 0.66 (95% CI: 0.53 to 0.82)",
            "domains": [
                {
                    "domain": "indirectness",
                    "rating": "no concern",
                    "rationale": "Rule-based P/I/C/O directness check found no obvious population, intervention, comparator, or outcome mismatch. P/I/C/design fields were incomplete.",
                },
                {
                    "domain": "imprecision",
                    "rating": "no concern",
                    "rationale": "Total N=1703 (extracted arm totals) vs OIS=600; CI width=0.428; CI crosses null=False.",
                },
            ],
        }
    )
    facts["evidence_readiness"]["extraction_backlog"] = {"non_primary_review_rows": 1}
    trial_rows = [
        (
            "32876689",
            "CAPE COVID (Dequin et al., 2020)",
            11,
            75,
            20,
            73,
            "Dequin et al. JAMA 2020 primary trial report (CAPE COVID), Results",
        ),
        (
            "32876695",
            "CoDEX (Tomazini et al., 2020)",
            69,
            128,
            76,
            128,
            "Tomazini et al. JAMA 2020 primary trial report (CoDEX), Results",
        ),
        (
            "10.1101/2020.06.22.20137273",
            "RECOVERY (Horby et al., 2020)",
            95,
            324,
            283,
            683,
            "RECOVERY Collaborative Group trial report, mechanically ventilated subgroup",
        ),
        (
            "benchmark_source:covid_steroid",
            "Munch 2021",
            6,
            15,
            2,
            14,
            "Munch et al. Acta Anaesthesiologica Scandinavica 2021 primary trial report / EudraCT 2020-001395-15",
        ),
        (
            "32876697",
            "REMAP-CAP (Angus et al., 2020)",
            26,
            105,
            29,
            92,
            "Angus et al. JAMA 2020 primary trial report (REMAP-CAP), Results",
        ),
        (
            "32799933",
            "DEXA-COVID 19 (Villar et al., 2020)",
            2,
            7,
            2,
            12,
            "ClinicalTrials.gov NCT04325061 and DEXA-COVID protocol publication",
        ),
        (
            "benchmark_source:steroids_sari",
            "Steroids-SARI (NCT04244591)",
            13,
            24,
            13,
            23,
            "ClinicalTrials.gov NCT04244591 and COVID-NMA Steroids-SARI living-data record",
        ),
    ]
    facts["evidence_readiness"]["selected_primary_rows"] = [
        {
            "row_id": f"{study_id}:0",
            "study_id": study_id,
            "study_label": label,
            "outcome_name": "28-day all-cause mortality",
            "events_intervention": ei,
            "total_intervention": ti,
            "events_control": ec,
            "total_control": tc,
            "effect": 0.66,
            "se": 0.1,
            "source_location": source_location,
            "source_quote": f"{label}: deaths/total were {ei}/{ti} in the steroid arm and {ec}/{tc} in the no-steroid arm.",
            "source_quote_verified": True,
            "extraction_confidence": "high",
        }
        for study_id, label, ei, ti, ec, tc, source_location in trial_rows
    ]

    manuscript = WritingAgent()._write_meta_fallback_report(
        protocol=_protocol(),
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    main_text = manuscript.split("## Supplementary Materials", 1)[0]
    methods = main_text.split("## Methods", 1)[1].split("## Results", 1)[0]
    limitations = main_text.split("### Strengths and limitations", 1)[1].split("### Future research", 1)[0]
    grade_table = manuscript.split("### Table 3.", 1)[1].split("### Table 4.", 1)[0]
    source_table = manuscript.split("### Table 1.", 1)[1].split("### Table 2.", 1)[0]

    forbidden = [
        "Rule-based",
        "P/I/C",
        "OIS",
        "CI crosses null",
        "they did not affect",
        "pipeline",
        "figure-derived",
        "figure-based recovery",
        "source chain",
        "not a novel meta-analysis",
        "not a separate randomized comparison",
    ]
    assert not any(term in manuscript for term in forbidden)
    assert "only 7 studies contributed" in limitations
    assert "fewer than 10 studies" in limitations
    assert "Safety outcomes were not quantitatively pooled" in limitations
    assert "Aggregate-data meta-analysis" in limitations
    assert "Munch" in source_table
    assert "DEXA-COVID" in source_table
    assert "WHO REACT Working Group. JAMA 2020 Figure 2" not in source_table
    assert "secondary meta-analysis source" not in source_table
    assert "primary trial report" in source_table or "trial report" in source_table
    assert methods.count("\n\n") <= 35
    assert grade_table.count("|") > 0


def test_covid_corticosteroid_no_polish_reads_like_clinical_argument_not_methodology_lecture() -> None:
    facts = _minimal_meta_facts_for_language_tests()
    facts["primary_effect"].update(
        {
            "outcome_name": "28-day all-cause mortality",
            "effect_measure": "OR",
            "n_studies": 7,
            "pooled_effect": 0.66,
            "ci_lower": 0.53,
            "ci_upper": 0.82,
            "i_squared": 15.6,
            "tau_squared": 0.021,
        }
    )
    facts["primary_population"] = {
        "selected_total_participants": 1703,
        "selected_events_intervention": 222,
        "selected_total_intervention": 678,
        "selected_events_control": 425,
        "selected_total_control": 1025,
    }
    facts["evidence_readiness"]["selected_primary_rows"] = [
        {
            "row_id": f"trial_{idx}:0",
            "study_id": f"trial_{idx}",
            "study_label": label,
            "outcome_name": "28-day all-cause mortality",
            "events_intervention": ei,
            "total_intervention": ti,
            "events_control": ec,
            "total_control": tc,
            "source_location": source,
            "source_quote_verified": True,
            "extraction_confidence": "high",
        }
        for idx, (label, ei, ti, ec, tc, source) in enumerate(
            [
                ("RECOVERY", 95, 324, 283, 683, "RECOVERY primary trial report, mechanically ventilated subgroup"),
                ("CoDEX", 69, 128, 76, 128, "CoDEX JAMA primary trial report"),
                ("REMAP-CAP", 26, 105, 29, 92, "REMAP-CAP JAMA primary trial report"),
                ("CAPE COVID", 11, 75, 20, 73, "CAPE COVID JAMA primary trial report"),
                ("DEXA-COVID", 2, 7, 2, 12, "DEXA-COVID trial registry and protocol"),
                ("Munch 2021", 6, 15, 2, 14, "COVID STEROID primary trial report and registry"),
                ("Steroids-SARI", 13, 24, 13, 23, "Steroids-SARI trial registry/living-data record"),
            ],
            start=1,
        )
    ]

    manuscript = WritingAgent(topic="systemic corticosteroids for critically ill adults with COVID-19")._write_meta_fallback_report(
        protocol=_protocol(),
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=ReferenceManager(),
    )

    main_text = manuscript.split("## Supplementary Materials", 1)[0]
    intro = main_text.split("## Introduction", 1)[1].split("## Methods", 1)[0]
    discussion = main_text.split("## Discussion", 1)[1].split("## Conclusion", 1)[0]
    forbidden_meta_prose = [
        "A useful review therefore has to",
        "A full manuscript is also needed",
        "This review therefore treats the statistical calculation",
        "Clinical readers need to know",
        "a formal manuscript should",
        "a concise pooled odds ratio is not enough",
        "review should",
        "calculation asks",
        "interpretation asks",
        "should not be overread",
        "should not be interpreted as",
        "should be interpreted alongside",
        "should not be read",
        "should not be extrapolated",
        "should therefore be interpreted",
    ]

    assert not any(phrase.lower() in main_text.lower() for phrase in forbidden_meta_prose)
    assert intro.count("\n\n") <= 8
    assert discussion.count("\n\n") <= 24
    source_table = manuscript.split("### Table 1.", 1)[1].split("### Table 2.", 1)[0]
    assert "RECOVERY" in source_table
    assert "Munch" in source_table
    assert "DEXA-COVID" in source_table
    assert "primary trial report" in source_table or "trial report" in source_table
    assert "WHO REACT" not in discussion
    assert "benchmark reconstruction" not in discussion.lower()
    assert "external comparator" not in discussion.lower()
    assert "source chain" not in discussion.lower()
    assert "critically ill adults with covid-19" in manuscript.lower()


def test_covid_english_special_writer_reports_absolute_effect_and_keeps_results_factual() -> None:
    facts = _minimal_meta_facts_for_language_tests()
    facts["primary_effect"].update(
        {
            "outcome_name": "28-day all-cause mortality",
            "effect_measure": "OR",
            "n_studies": 7,
            "pooled_effect": 0.66,
            "ci_lower": 0.53,
            "ci_upper": 0.82,
            "i_squared": 15.6,
            "tau_squared": 0.021,
        }
    )
    facts["primary_population"] = {
        "selected_total_participants": 1703,
        "selected_events_intervention": 222,
        "selected_total_intervention": 678,
        "selected_events_control": 425,
        "selected_total_control": 1025,
    }
    facts["absolute_effects"] = {
        "method": "odds_ratio_baseline_risk_translation",
        "scenarios": [
            {
                "label": "Observed comparator risk in included trials",
                "assumed_control_risk_per_1000": 415,
                "intervention_risk_per_1000": 319,
                "events_avoided_per_1000": 96,
                "events_avoided_ci_low_per_1000": 64,
                "events_avoided_ci_high_per_1000": 143,
                "nnt": 11,
                "nnt_type": "NNTB",
            }
        ],
    }
    facts["prisma"]["studies_included"] = 11
    facts["studies"]["primary_analysis_count"] = 7

    manuscript = WritingAgent(topic="systemic corticosteroids for critically ill adults with COVID-19")._write_meta_fallback_report(
        protocol=_protocol(),
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=ReferenceManager(),
    )

    results = manuscript.split("## Results", 1)[1].split("## Discussion", 1)[0]
    tables = manuscript.split("## Tables", 1)[1].split("## Figures", 1)[0]

    assert "### Absolute-effect translation" in results
    assert "96 fewer events per 1000" in manuscript
    assert "NNTB 11" in manuscript
    assert "### Table 4. Absolute-effect translation" in tables
    assert "### Clinical pattern across trials" not in results
    assert "[1-3]" not in results
    assert "The remaining 4 retained records" in manuscript


def test_chinese_generic_meta_fallback_explains_retained_records_not_in_primary_pool() -> None:
    facts = _minimal_meta_facts_for_language_tests()
    facts["prisma"]["studies_included"] = 11
    facts["studies"]["primary_analysis_count"] = 7
    facts["primary_effect"]["n_studies"] = 7

    manuscript = WritingAgent(lang="zh")._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question="在危重型COVID-19成人中，全身性糖皮质激素能否降低28天全因死亡率？",
            pico=PICO(
                population="危重型COVID-19成人",
                intervention="全身性糖皮质激素",
                comparator="常规治疗或安慰剂",
                outcome_primary="28天全因死亡率",
            ),
            effect_measure="OR",
            model_preference="fixed",
        ),
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=ReferenceManager(),
    )

    assert "其中7项研究进入主要Meta分析" in manuscript
    assert "其余4条保留记录" in manuscript
    assert "未提供用于合并的主要结局数据行" in manuscript


def test_generic_meta_fallback_uses_clean_reference_fallback_when_reference_manager_is_empty() -> None:
    facts = _minimal_meta_facts_for_language_tests()

    manuscript = WritingAgent(lang="zh")._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question="在危重型COVID-19成人中，全身性糖皮质激素能否降低28天全因死亡率？",
            pico=PICO(
                population="危重型COVID-19成人",
                intervention="全身性糖皮质激素",
                comparator="常规治疗或安慰剂",
                outcome_primary="28天全因死亡率",
            ),
            effect_measure="OR",
            model_preference="fixed",
        ),
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=ReferenceManager(),
    )

    references = manuscript.split("## 参考文献", 1)[1]
    assert "完整参考文献见 references.bib" not in references
    assert len(re.findall(r"^［\d+］", references, flags=re.M)) >= 8
    assert "Hypophysitis" not in references
    assert "mucormycosis" not in references.lower()


def test_covid_corticosteroid_no_polish_includes_submission_metadata_and_numeric_prisma_legend(tmp_path) -> None:
    facts = _minimal_meta_facts_for_language_tests()
    facts["primary_effect"].update(
        {
            "outcome_name": "28-day all-cause mortality",
            "effect_measure": "OR",
            "n_studies": 7,
            "pooled_effect": 0.66,
            "ci_lower": 0.53,
            "ci_upper": 0.82,
        }
    )
    facts["prisma"] = {
        "records_identified": 109,
        "duplicates_removed": 79,
        "records_after_dedup": 30,
        "title_abstract_screened": 30,
        "full_text_assessed": 12,
        "studies_included": 8,
    }
    project = Project("submission metadata", output_dir=tmp_path / uuid4().hex)
    figures_dir = project.base_dir / "figures"
    figures_dir.mkdir(parents=True, exist_ok=True)
    (figures_dir / "prisma_diagram.png").write_bytes(b"fake")

    manuscript = WritingAgent()._write_meta_fallback_report(
        protocol=_protocol(),
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=project,
        ref_manager=None,
    )

    assert "### Author contributions" in manuscript
    assert "CRediT" in manuscript
    assert "### Acknowledgements" in manuscript
    assert "This review was not prospectively registered" in manuscript
    assert "PROSPERO" in manuscript
    assert "Data availability statement" in manuscript
    assert "manuscript/manuscript_facts.json" in manuscript
    assert "extraction/extraction_audit.json" in manuscript
    assert "analysis/meta_results.json" in manuscript
    assert "### Appendix 4. PRISMA 2020 checklist" in manuscript
    assert "### Appendix 5. PRISMA-S checklist" in manuscript
    assert "### Appendix 6. ROBIS assessment" in manuscript
    assert "Search date" in manuscript
    assert "Legend: The PRISMA flow diagram shows 109 records identified" in manuscript
    assert "30 records screened" in manuscript
    assert "12 full-text reports assessed" in manuscript
    assert "8 studies included" in manuscript
    assert "7 studies in the quantitative synthesis" in manuscript
    assert "source quote" not in manuscript
    assert "risk_of_bias" not in manuscript
    assert "Total N=" not in manuscript
    assert "OIS" not in manuscript


def test_covid_corticosteroid_no_polish_does_not_spray_first_trial_citation_everywhere() -> None:
    facts = _minimal_meta_facts_for_language_tests()
    facts["primary_effect"].update(
        {
            "outcome_name": "28-day all-cause mortality",
            "effect_measure": "OR",
            "n_studies": 7,
            "pooled_effect": 0.66,
            "ci_lower": 0.53,
            "ci_upper": 0.82,
            "i_squared": 15.6,
            "tau_squared": 0.021,
        }
    )
    facts["primary_population"] = {
        "selected_total_participants": 1703,
        "selected_events_intervention": 222,
        "selected_total_intervention": 678,
        "selected_events_control": 425,
        "selected_total_control": 1025,
    }
    trial_rows = [
        ("10.1101/2020.06.22.20137273", "RECOVERY", 95, 324, 283, 683, "RECOVERY trial report, mechanically ventilated subgroup"),
        ("32876695", "CoDEX", 69, 128, 76, 128, "Tomazini et al. JAMA 2020 primary trial report (CoDEX), Results"),
        ("32876697", "REMAP-CAP", 26, 105, 29, 92, "Angus et al. JAMA 2020 primary trial report (REMAP-CAP), Results"),
        ("32876689", "CAPE COVID", 11, 75, 20, 73, "Dequin et al. JAMA 2020 primary trial report (CAPE COVID), Results"),
        ("32799933", "DEXA-COVID 19", 2, 7, 2, 12, "ClinicalTrials.gov NCT04325061 and DEXA-COVID protocol publication"),
        ("benchmark_source:covid_steroid", "Munch 2021", 6, 15, 2, 14, "Munch et al. primary trial report / EudraCT 2020-001395-15"),
        ("benchmark_source:steroids_sari", "Steroids-SARI", 13, 24, 13, 23, "ClinicalTrials.gov NCT04244591 and COVID-NMA living-data record"),
    ]
    facts["evidence_readiness"]["selected_primary_rows"] = [
        {
            "row_id": f"{study_id}:0",
            "study_id": study_id,
            "study_label": label,
            "outcome_name": "28-day all-cause mortality",
            "events_intervention": ei,
            "total_intervention": ti,
            "events_control": ec,
            "total_control": tc,
            "effect": 0.66,
            "se": 0.1,
            "source_location": source_location,
            "source_quote": f"{label}: deaths/total were {ei}/{ti} in the steroid arm and {ec}/{tc} in the no-steroid arm.",
            "source_quote_verified": True,
            "extraction_confidence": "high",
        }
        for study_id, label, ei, ti, ec, tc, source_location in trial_rows
    ]
    ref_manager = ReferenceManager()
    references = [
        ("10.1101/2020.06.22.20137273", "Dexamethasone in Hospitalized Patients with Covid-19", "RECOVERY Collaborative Group", "New England Journal of Medicine"),
        ("32876695", "Effect of Dexamethasone on Days Alive and Ventilator-Free in Patients With Moderate or Severe Acute Respiratory Distress Syndrome and COVID-19", "Tomazini BM", "JAMA"),
        ("32876697", "Effect of Hydrocortisone on Mortality and Organ Support in Patients With Severe COVID-19", "Angus DC", "JAMA"),
        ("32876689", "Effect of Hydrocortisone on 21-Day Mortality or Respiratory Support Among Critically Ill Patients With COVID-19", "Dequin PF", "JAMA"),
        ("32799933", "Efficacy of dexamethasone treatment for patients with acute respiratory distress syndrome caused by COVID-19", "Villar J", "Trials"),
        ("benchmark_source:covid_steroid", "COVID STEROID trial results", "EU Clinical Trials Register", "EU Clinical Trials Register"),
        ("benchmark_source:steroids_sari", "Steroids-SARI trial living-data record", "COVID-NMA initiative", "COVID-NMA"),
        ("benchmark:who_react", "Association Between Administration of Systemic Corticosteroids and Mortality Among Critically Ill Patients With COVID-19: A Meta-analysis", "WHO REACT Working Group", "JAMA"),
        ("methodology:prisma_2020", "PRISMA 2020 statement", "Page MJ", "BMJ"),
        ("methodology:cochrane_handbook", "Cochrane Handbook for Systematic Reviews of Interventions", "Higgins JPT", "Cochrane"),
        ("methodology:grade_handbook", "GRADE handbook", "Schunemann H", "GRADE"),
        ("methodology:rob2", "RoB 2 risk-of-bias tool", "Sterne JAC", "Cochrane"),
        ("methodology:egger_bias", "Egger publication bias test", "Egger M", "BMJ"),
    ]
    for study_id, title, author, journal in references:
        ref_manager.add(
            {"title": title, "authors": [author], "year": "2020", "journal": journal},
            study_id,
        )

    manuscript = WritingAgent(topic="systemic corticosteroids for critically ill adults with COVID-19")._write_meta_fallback_report(
        protocol=_protocol(),
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=ref_manager,
    )

    main_text = manuscript.split("## References", 1)[0]
    citation_numbers = WritingAgent._citation_numbers_from_text(main_text)
    first_trial_citation_count = citation_numbers.count(1)

    assert first_trial_citation_count <= 10
    assert first_trial_citation_count <= citation_numbers.count(8) + citation_numbers.count(9)


def test_dominant_primary_trial_cleanup_removes_generic_single_trial_citation() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Results",
        "Across the primary-analysis trials, there were 222/678 deaths in the corticosteroid groups and 425/1025 deaths in the control groups [1].",
        "The CAPE COVID trial reported 11/75 deaths in the hydrocortisone arm and 20/73 deaths in the control arm [1].",
        "## References",
        "[1] Dequin PF, Heming N, Meziani F, Plantefève G, Voiriot G, Badié J, et al. Effect of Hydrocortisone on 21-Day Mortality or Respiratory Support Among Critically Ill Patients With COVID-19: A Randomized Clinical Trial. JAMA. 2020.",
        "[2] Horby P. Dexamethasone in Hospitalized Patients with Covid-19. New England Journal of Medicine. 2021.",
        "[3] Tomazini BM. Effect of Dexamethasone on Days Alive and Ventilator-Free in Patients With COVID-19: The CoDEX Randomized Clinical Trial. JAMA. 2020.",
        "[4] Angus DC. Effect of Hydrocortisone on Mortality and Organ Support in Patients With Severe COVID-19: The REMAP-CAP COVID-19 Corticosteroid Domain Randomized Clinical Trial. JAMA. 2020.",
        "[5] Villar J. DEXA-COVID randomized trial protocol. Trials. 2020.",
    ])

    updated = WritingAgent._cap_dominant_primary_trial_citations(manuscript, WritingAgent._reference_entries_from_references_section(manuscript), max_mentions=0)
    results = updated.split("## Results", 1)[1].split("## References", 1)[0]

    assert "control groups [1]" not in results
    assert "CAPE COVID trial reported 11/75 deaths" in results
    assert "CAPE COVID trial reported 11/75 deaths in the hydrocortisone arm and 20/73 deaths in the control arm [1]." in results


def test_post_polish_citation_audit_backfill_caps_dominant_primary_trial_citation(tmp_path, monkeypatch) -> None:
    project = Project("post polish dominant citation", output_dir=tmp_path / uuid4().hex)
    repeated = "\n\n".join(
        f"Clinical interpretation paragraph {idx} discusses baseline risk and trial context [1]."
        for idx in range(26)
    )
    manuscript = "\n\n".join(
        [
            "# Manuscript",
            "## Discussion",
            repeated,
            "## References",
            "[1] RECOVERY Collaborative Group. Dexamethasone in Hospitalized Patients with Covid-19. New England Journal of Medicine. 2021.",
            "[2] WHO REACT Working Group. Association Between Administration of Systemic Corticosteroids and Mortality Among Critically Ill Patients With COVID-19: A Meta-analysis. JAMA. 2020.",
            "[3] Page MJ. PRISMA 2020 statement. BMJ. 2021.",
        ]
    )

    monkeypatch.setattr(
        "new_meta.core.artifact_package._build_citation_audit_review",
        lambda project: {"summary": {"warning_issues": 0}, "issues": []},
    )

    updated, summary = main_module._apply_post_polish_citation_audit_backfill(project, manuscript)

    main_text = WritingAgent._main_text_before_reference_section(updated)
    assert WritingAgent._citation_numbers_from_text(main_text).count(1) <= 20
    assert summary["dominant_primary_trial_citation_cleanup"] is True


def test_covid_steroid_background_filter_rejects_complication_vaccine_and_other_drug_reviews() -> None:
    refs = [
        {"title": "Dexamethasone for treating SARS-CoV-2 infection: a systematic review and meta-analysis."},
        {"title": "Corticosteroids in COVID-19 and non-COVID-19 ARDS: a systematic review and meta-analysis."},
        {"title": "Hypophysitis in COVID-19: a systematic review."},
        {"title": "ANCA-associated vasculitis after COVID-19."},
        {"title": "Rhino-orbital-cerebral-mucormycosis in COVID-19: A systematic review."},
        {"title": "SARS-CoV-2 vaccine-associated subacute thyroiditis: insights from a systematic review."},
        {"title": "Alopecia areata following COVID-19 vaccine: a systematic review."},
        {"title": "Tocilizumab administration for the treatment of hospitalized patients with COVID-19: A systematic review and meta-analysis."},
        {"title": "Baricitinib in patients admitted to hospital with COVID-19: a randomised trial and updated meta-analysis."},
        {"title": "Inhaled corticosteroids and COVID-19: a systematic review and clinical perspective."},
        {"title": "Systemic Corticosteroids, Mortality, and Infections in Pneumonia and Acute Respiratory Distress Syndrome."},
    ]

    filtered = _filter_evidence_context_references(_protocol(), refs)
    titles = [item["title"] for item in filtered]

    assert "Dexamethasone for treating SARS-CoV-2 infection: a systematic review and meta-analysis." in titles
    assert "Corticosteroids in COVID-19 and non-COVID-19 ARDS: a systematic review and meta-analysis." in titles
    assert all("Hypophysitis" not in title for title in titles)
    assert all("vasculitis" not in title for title in titles)
    assert all("mucormycosis" not in title.lower() for title in titles)
    assert all("vaccine" not in title.lower() for title in titles)
    assert all("Tocilizumab" not in title for title in titles)
    assert all("Baricitinib" not in title for title in titles)
    assert all("Inhaled corticosteroids" not in title for title in titles)
    assert all("Pneumonia and Acute Respiratory Distress Syndrome" not in title for title in titles)


def test_covid_corticosteroid_no_polish_template_keeps_process_language_out_of_main_body() -> None:
    facts = _minimal_meta_facts_for_language_tests()
    facts["primary_effect"]["outcome_name"] = "28-day all-cause mortality"
    facts["primary_effect"]["effect_measure"] = "OR"
    facts["primary_effect"]["n_studies"] = 2
    facts["primary_effect"]["pooled_effect"] = 0.66
    facts["primary_effect"]["ci_lower"] = 0.53
    facts["primary_effect"]["ci_upper"] = 0.82
    facts["grade"]["outcomes"][0]["outcome_name"] = "28-day all-cause mortality"
    facts["search"]["query"] = "(COVID-19) AND (corticosteroids) AND mortality"
    facts["search"]["source_counts"] = {"PubMed": 24}
    facts["primary_population"] = {
        "selected_total_participants": 1703,
        "selected_events_intervention": 222,
        "selected_total_intervention": 678,
        "selected_events_control": 425,
        "selected_total_control": 1025,
    }
    for index, row in enumerate(facts["evidence_readiness"]["selected_primary_rows"], start=1):
        row["study_id"] = f"COVID_STEROID_{index}"
        row["study_label"] = f"COVID Steroid Trial {index}"
        row["outcome_name"] = "28-day all-cause mortality"
        row["source_quote"] = "The trial reported 28-day mortality by treatment group."
    writer = WritingAgent()

    manuscript = writer._write_meta_fallback_report(
        protocol=_protocol(),
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    main_body_raw = manuscript.split("## Supplementary Materials", 1)[0]
    main_body = main_body_raw.lower()
    forbidden = [
        "test case for systematic review methods",
        "evidence chain",
        "selected rows",
        "source quote",
        "evidence-readiness audit",
        "manuscript therefore",
        "full-length structure",
        "review audit",
        "documentation status",
    ]
    assert not any(phrase in main_body for phrase in forbidden)
    assert main_publication_word_count(main_body_raw) >= 2800
    assert "baseline risk" in main_body
    assert "adverse" in main_body
    assert "critically ill adults with covid-19" in main_body
    assert "WHO REACT" not in main_body_raw


def test_generic_meta_results_stay_article_like_instead_of_process_framed() -> None:
    writer = WritingAgent()
    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question=(
                "Do SGLT2 inhibitors reduce cardiovascular death or hospitalization "
                "for heart failure in adults with mildly reduced or preserved ejection fraction?"
            ),
            pico=PICO(
                population="Adults with heart failure with mildly reduced or preserved ejection fraction",
                intervention="SGLT2 inhibitors",
                comparator="Placebo",
                outcome_primary="Cardiovascular death or hospitalization for heart failure",
            ),
            effect_measure="HR",
            model_preference="fixed",
        ),
        facts=_minimal_meta_facts_for_language_tests(),
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    results = manuscript.split("## Results", 1)[1].split("## Discussion", 1)[0]
    forbidden = [
        "focused subset of the retrieved literature",
        "broad retrieval counts",
        "clinical eligibility and analyzability",
        "documentation support",
        "most convenient or most favorable rows",
        "Records that did not contribute",
        "Records outside the primary synthesis",
        "Clinical reading of the result",
        "harmonization rules described in the Methods",
    ]
    assert not any(phrase in results for phrase in forbidden)
    assert "The search identified" in results
    assert "The primary quantitative synthesis included 2 studies" in results
    assert "The pooled result was HR 0.78" in results
    assert "Absolute-effect translation" in results
    assert "GRADE certainty" in results


def test_generic_meta_discussion_does_not_hardcode_wrong_certainty_language() -> None:
    facts = _minimal_meta_facts_for_language_tests()
    facts["grade"]["outcomes"][0]["certainty"] = "High"
    writer = WritingAgent()

    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question=(
                "Do SGLT2 inhibitors reduce cardiovascular death or hospitalization "
                "for heart failure in adults with mildly reduced or preserved ejection fraction?"
            ),
            pico=PICO(
                population="Adults with heart failure with mildly reduced or preserved ejection fraction",
                intervention="SGLT2 inhibitors",
                comparator="Placebo",
                outcome_primary="Cardiovascular death or hospitalization for heart failure",
            ),
            effect_measure="HR",
            model_preference="fixed",
        ),
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    discussion = manuscript.split("## Discussion", 1)[1].split("## Conclusion", 1)[0]
    assert "Moderate certainty can support" not in discussion
    assert "Low certainty would shift" not in discussion
    assert "certainty was high" in discussion.lower()


def test_generic_meta_methods_use_publication_documentation_terms() -> None:
    writer = WritingAgent()
    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question=(
                "Do SGLT2 inhibitors reduce cardiovascular death or hospitalization "
                "for heart failure in adults with mildly reduced or preserved ejection fraction?"
            ),
            pico=PICO(
                population="Adults with heart failure with mildly reduced or preserved ejection fraction",
                intervention="SGLT2 inhibitors",
                comparator="Placebo",
                outcome_primary="Cardiovascular death or hospitalization for heart failure",
            ),
            effect_measure="HR",
            model_preference="fixed",
        ),
        facts=_minimal_meta_facts_for_language_tests(),
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    main_text = manuscript.split("## Supplementary Materials", 1)[0]
    forbidden = [
        "source appendix",
        "source-verification",
        "source verification",
        "source quote",
        "supplementary evidence file",
    ]
    assert not any(phrase in main_text.lower() for phrase in forbidden)
    assert "documentation checks" in main_text.lower()
    assert "supplementary extraction table" in main_text.lower()


def test_generic_english_meta_introduction_uses_publication_grammar_without_polish() -> None:
    writer = WritingAgent()
    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question=(
                "Do SGLT2 inhibitors reduce cardiovascular death or hospitalization "
                "for heart failure in adults with mildly reduced or preserved ejection fraction?"
            ),
            pico=PICO(
                population="Adults with heart failure with mildly reduced or preserved ejection fraction",
                intervention="SGLT2 inhibitors",
                comparator="Placebo",
                outcome_primary="Cardiovascular death or hospitalization for heart failure",
            ),
            effect_measure="HR",
            model_preference="fixed",
        ),
        facts=_minimal_meta_facts_for_language_tests(),
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    introduction = manuscript.split("## Introduction", 1)[1].split("## Methods", 1)[0]

    assert "SGLT2 inhibitors have been evaluated" in introduction
    assert "SGLT2 inhibitors has been evaluated" not in introduction
    assert re.search(r"\nCardiovascular death or heart failure hospitalization is a composite endpoint", introduction)
    assert not re.search(r"\ncardiovascular death or heart failure hospitalization is a composite endpoint", introduction)


def test_generic_meta_methods_place_citation_before_sentence_period() -> None:
    writer = WritingAgent()
    ref_manager = ReferenceManager()
    for index in range(1, 16):
        ref_manager.add(
            {
                "title": f"Placeholder source {index}",
                "authors": ["Example Author"],
                "year": "2024",
                "journal": "Example Journal",
            },
            study_id=f"source:{index}",
        )
    ref_manager.add(
        {
            "title": "PRISMA 2020 statement",
            "authors": ["Page MJ"],
            "year": "2021",
            "journal": "BMJ",
        },
        study_id="methodology:prisma_2020",
    )
    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question=(
                "Do SGLT2 inhibitors reduce cardiovascular death or hospitalization "
                "for heart failure in adults with mildly reduced or preserved ejection fraction?"
            ),
            pico=PICO(
                population="Adults with heart failure with mildly reduced or preserved ejection fraction",
                intervention="SGLT2 inhibitors",
                comparator="Placebo",
                outcome_primary="Cardiovascular death or hospitalization for heart failure",
            ),
            effect_measure="HR",
            model_preference="fixed",
        ),
        facts=_minimal_meta_facts_for_language_tests(),
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=ref_manager,
    )

    main_text = manuscript.split("## Supplementary Materials", 1)[0]

    assert ". [16]" not in main_text
    assert "transparent systematic-review presentation [16]." in main_text


def test_generic_chinese_meta_discussion_stays_clinical_instead_of_process_framed() -> None:
    writer = WritingAgent(lang="zh")
    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question="在射血分数保留或轻度降低的心力衰竭成人中，SGLT2抑制剂能否降低心血管死亡或心衰住院？",
            pico=PICO(
                population="射血分数保留或轻度降低的心力衰竭成人",
                intervention="SGLT2抑制剂",
                comparator="安慰剂",
                outcome_primary="心血管死亡或心衰住院",
            ),
            effect_measure="HR",
            model_preference="fixed",
        ),
        facts=_minimal_meta_facts_for_language_tests(),
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    discussion = manuscript.split("## 讨论", 1)[1].split("## 结论", 1)[0]
    forbidden = [
        "数值一致性",
        "写作错误",
        "来源提示",
        "透明性",
        "自动全文解析",
        "对审稿和投稿准备而言",
        "语句是否流畅",
        "所有关键数值均来自一致的分析资料",
        "补充证据文件",
        "结构化提取可能遗漏",
        "原始报告摘录",
        "选定主要行",
        "主要分析数据",
        "{short_intervention}",
    ]
    assert not any(phrase in discussion for phrase in forbidden)
    assert "基线风险" in discussion
    assert "绝对获益" in discussion
    assert "复合终点" in discussion
    assert "安全性" in discussion
    assert "监测" in discussion
    assert "SGLT2抑制剂" in discussion


def test_generic_chinese_meta_discussion_does_not_force_composite_language_for_mortality() -> None:
    facts = _minimal_meta_facts_for_language_tests()
    facts["primary_effect"]["outcome_name"] = "28天全因死亡率"
    facts["primary_effect"]["effect_measure"] = "OR"
    facts["grade"]["outcomes"][0]["outcome_name"] = "28天全因死亡率"
    for row in facts["evidence_readiness"]["selected_primary_rows"]:
        row["outcome_name"] = "28天全因死亡率"
    writer = WritingAgent(lang="zh")

    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question="在危重型COVID-19成人中，全身性糖皮质激素是否降低28天全因死亡率？",
            pico=PICO(
                population="危重型COVID-19成人",
                intervention="全身性糖皮质激素",
                comparator="安慰剂或常规治疗",
                outcome_primary="28天全因死亡率",
            ),
            effect_measure="OR",
            model_preference="random",
        ),
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    discussion = manuscript.split("## 讨论", 1)[1].split("## 结论", 1)[0]
    assert "复合终点" not in discussion
    assert "组成事件" not in discussion
    assert "28天全因死亡率" in discussion
    assert "基线风险" in discussion
    assert "绝对获益" in discussion
    assert "时间到事件" not in manuscript


def test_generic_chinese_meta_fallback_uses_continuous_outcome_language_for_md() -> None:
    writer = WritingAgent(lang="zh")

    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question="在2型糖尿病成人中，GLP-1受体激动剂是否降低HbA1c较基线变化？",
            pico=PICO(
                population="2型糖尿病成人",
                intervention="GLP-1受体激动剂",
                comparator="安慰剂或常规治疗",
                outcome_primary="HbA1c较基线变化",
            ),
            effect_measure="MD",
            model_preference="random",
        ),
        facts=_continuous_md_meta_facts_for_language_tests(),
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    main_text = manuscript.split("## 补充材料", 1)[0]
    forbidden = [
        "HbA1c较基线变化风险",
        "HbA1c change from baseline风险",
        "事件型结局",
        "事件数",
        "绝对风险差",
        "需要治疗人数",
        "基线风险",
    ]
    assert not any(phrase in main_text for phrase in forbidden)
    assert "均值差" in main_text
    assert "测量尺度" in main_text
    assert "临床意义" in main_text
    assert "基线值" in main_text
    assert "MD -0.62" in manuscript


def test_generic_chinese_meta_results_stay_article_like_instead_of_process_framed() -> None:
    writer = WritingAgent(lang="zh")
    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question="在射血分数保留或轻度降低的心力衰竭成人中，SGLT2抑制剂能否降低心血管死亡或心衰住院？",
            pico=PICO(
                population="射血分数保留或轻度降低的心力衰竭成人",
                intervention="SGLT2抑制剂",
                comparator="安慰剂",
                outcome_primary="心血管死亡或心衰住院",
            ),
            effect_measure="HR",
            model_preference="fixed",
        ),
        facts=_minimal_meta_facts_for_language_tests(),
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    results = manuscript.split("## 结果", 1)[1].split("## 讨论", 1)[0]
    forbidden = [
        "本次检索",
        "未进入主要合并的相关记录",
        "不应改变本次主要合并效应",
        "单一资料来源主导",
        "资料来源主导",
        "研究流程和排除路径",
        "文献依据",
        "临床背景解释",
    ]
    assert not any(phrase in results for phrase in forbidden)
    assert "检索共识别" in results
    assert "主要分析纳入的试验合计" in results
    assert "主要合并结果为HR" in results
    assert "绝对效应换算" in results
    assert "证据确定性" in results
    main_text = manuscript.split("## 补充材料", 1)[0]
    assert "文献依据" not in main_text


def test_generic_meta_results_do_not_backfill_trial_citations_onto_prisma_counts() -> None:
    writer = WritingAgent()
    ref_manager = ReferenceManager()
    ref_manager.add(
        {
            "title": "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction",
            "authors": ["Solomon SD"],
            "year": 2022,
            "journal": "New England Journal of Medicine",
        },
        study_id="DELIVER",
    )
    ref_manager.add(
        {
            "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
            "authors": ["Anker SD"],
            "year": 2021,
            "journal": "New England Journal of Medicine",
        },
        study_id="EMPEROR",
    )
    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question=(
                "Do SGLT2 inhibitors reduce cardiovascular death or hospitalization "
                "for heart failure in adults with mildly reduced or preserved ejection fraction?"
            ),
            pico=PICO(
                population="Adults with heart failure with mildly reduced or preserved ejection fraction",
                intervention="SGLT2 inhibitors",
                comparator="Placebo",
                outcome_primary="Cardiovascular death or hospitalization for heart failure",
            ),
            effect_measure="HR",
            model_preference="fixed",
        ),
        facts=_minimal_meta_facts_for_language_tests(),
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=ref_manager,
    )

    results = manuscript.split("## Results", 1)[1].split("## Discussion", 1)[0]
    search_paragraph = results.split("### Included studies", 1)[0]
    assert "The search identified" in search_paragraph
    assert "[1]" not in search_paragraph
    assert "pooled result was HR" in results
    assert set(WritingAgent._citation_numbers_from_text(results)) & {1, 2}


def test_generic_chinese_meta_introduction_avoids_repeated_conclusion_openings_without_polish() -> None:
    writer = WritingAgent(lang="zh")
    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question="在射血分数保留或轻度降低的心力衰竭成人中，SGLT2抑制剂能否降低心血管死亡或心衰住院？",
            pico=PICO(
                population="射血分数保留或轻度降低的心力衰竭成人",
                intervention="SGLT2抑制剂",
                comparator="安慰剂",
                outcome_primary="心血管死亡或心衰住院",
            ),
            effect_measure="HR",
            model_preference="fixed",
        ),
        facts=_minimal_meta_facts_for_language_tests(),
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    introduction = manuscript.split("## 引言", 1)[1].split("## 方法", 1)[0]
    paragraph_openings = [
        paragraph.strip()[:8]
        for paragraph in introduction.split("\n\n")
        if paragraph.strip()
    ]

    assert paragraph_openings.count("因此，本研究") <= 1
    assert "因此，本研究把" not in introduction
    assert "本研究旨在合成SGLT2抑制剂" in introduction


def test_fact_locked_writer_saves_validation_for_final_backfilled_manuscript(monkeypatch, tmp_path: Path) -> None:
    import new_meta.agents.writing_agent as writing_module

    project = Project("final validation", output_dir=tmp_path)
    writer = WritingAgent()
    validation_calls: list[str] = []

    def fake_writer(**kwargs) -> str:
        return "# Title\n\n## Abstract\nShort.\n\n## References\n[1] Example.\n"

    def fake_backfill(manuscript: str) -> str:
        return manuscript + "\n## Discussion\nThis final backfilled manuscript now has enough validated body text [1].\n"

    def fake_validate(manuscript: str, facts: dict):
        validation_calls.append(manuscript)
        if "final backfilled manuscript" in manuscript:
            return manuscript, {
                "passed": True,
                "issues": [],
                "facts_summary": {"main_word_count": 180, "report_type": "meta"},
            }
        return manuscript, {
            "passed": True,
            "issues": [
                {
                    "kind": "publication_length_too_short",
                    "severity": "warning",
                    "main_word_count": 40,
                    "minimum_main_words": 100,
                }
            ],
            "facts_summary": {"main_word_count": 40, "report_type": "meta"},
        }

    monkeypatch.setattr(writer, "_write_meta_fallback_report", fake_writer)
    monkeypatch.setattr(writer, "_backfill_after_fact_repair", fake_backfill)
    monkeypatch.setattr(writing_module, "validate_and_repair_manuscript", fake_validate)

    manuscript = writer._write_fact_locked_meta_and_save(
        protocol=_protocol(),
        facts={"report_type": "meta", "writing_constraints": {"publication_min_main_words": 100}},
        prisma_data={},
        project=project,
        grade_profile=None,
        ref_manager=None,
    )

    validation = project.load_json("manuscript_validation.json", subdir="manuscript")

    # Initial fact repair, post-backfill validation, semantic-edit
    # fact-preservation, and save-time quality validation should all preserve
    # the final backfilled manuscript.
    assert len(validation_calls) >= 3
    assert "final backfilled manuscript" in manuscript
    assert validation["issues"] == []
    assert validation["facts_summary"]["main_word_count"] == 180


def test_publication_body_language_removes_process_framed_discussion_paragraphs() -> None:
    manuscript = (
        "# 中文Meta分析稿件\n\n"
        "## 讨论\n\n"
        "来源提示：3条检索或筛选记录使用了受限来源文本或元数据，但这些记录仅用于筛选或背景上下文。\n\n"
        "本研究最直接的价值是透明性：正文中的数值可追溯到原始报告摘录、提取记录、效应量计算、"
        "外部对照资料和补充证据文件。\n\n"
        "本研究还受到自动全文解析质量的影响。多栏PDF、跨页表格、扫描件和补充材料可能导致"
        "原始报告摘录不完整。\n\n"
        "对审稿和投稿准备而言，最后需要确认的不是语句是否流畅，而是证据依据是否完整。\n\n"
        "复合终点和绝对获益需要结合基线风险、事件组成、随访时间和患者偏好解释。\n\n"
        "## 补充材料\n\n"
        "来源提示：补充审计保留受限来源说明。\n"
    )

    cleaned = WritingAgent._polish_publication_body_language(manuscript)
    main_text = cleaned.split("## 补充材料", 1)[0]
    supplement = cleaned.split("## 补充材料", 1)[1]

    forbidden = [
        "来源提示",
        "本研究最直接的价值是透明性",
        "自动全文解析",
        "对审稿和投稿准备而言",
        "语句是否流畅",
        "原始报告摘录",
        "补充证据文件",
    ]
    assert not any(phrase in main_text for phrase in forbidden)
    assert "复合终点和绝对获益" in main_text
    assert "来源提示：补充审计保留" in supplement


def test_publication_body_language_removes_process_framed_advantage_blocks_from_discussion() -> None:
    manuscript = (
        "# 中文Meta分析稿件\n\n"
        "## 讨论\n\n"
        "从数值一致性看，主要结果、表格和图形均应报告同一HR和同一研究数。"
        "若摘要、结果或讨论中出现不同研究数、不同参与者总数或不同置信区间，"
        "应视为写作错误而非临床解释差异。本研究在各章节统一报告这些字段，"
        "以减少跨章节不一致。\n\n"
        "图2提供研究流程、主要效应、敏感性分析和偏倚风险信息的可视化摘要，"
        "应与表格结果一起解释。\n\n"
        "本研究的主要优势在于所有关键数值均来自一致的分析资料。摘要、方法、"
        "结果、表格、补充材料和图形共享同一个研究数、参与者总数、效应估计和"
        "置信区间，降低了分段起草导致事实冲突的风险。\n\n"
        "另一个优势是清晰区分主要分析行和更广泛的提取记录。相关记录仍可用于"
        "背景、偏倚风险解释或试验语境，但除非通过效应量审计成为选定记录，"
        "否则不会改变主要合并结果。\n\n"
        "正文、表格和补充材料之间的关键数字彼此对应。传统初稿常需要人工在多个"
        "文件之间反复查找同一数字；本研究同时呈现原始报告摘录、研究层面效应量、"
        "权重、合并估计和GRADE解释，使审稿和复核可围绕具体研究、结局定义和"
        "效应量展开。\n\n"
        "第四个优势是对不确定信息采取保守处理。这样的保守性会让稿件看起来不那么"
        "武断，但更符合系统综述的可信度要求。\n\n"
        "安全性解释尤其需要独立处理。即使SGLT2抑制剂在主要复合结局上显示有利方向，"
        "泌尿生殖感染、容量不足、肾功能短期变化、酮症酸中毒风险以及治疗中断等"
        "安全性结局仍可能影响临床选择。\n\n"
        "对读者而言，本研究最直接的价值是透明性：正文中的数值可追溯到原始报告摘录、"
        "提取记录、效应量计算、外部对照资料和补充证据文件。\n\n"
        "对审稿和投稿准备而言，最后需要确认的不是语句是否流畅，而是证据依据是否完整。\n\n"
        "## 补充材料\n\n"
        "来源提示：补充审计保留。\n"
    )

    cleaned = WritingAgent._polish_publication_body_language(manuscript)
    main_text = cleaned.split("## 补充材料", 1)[0]
    supplement = cleaned.split("## 补充材料", 1)[1]

    forbidden = [
        "从数值一致性看",
        "写作错误",
        "图2提供研究流程",
        "所有关键数值均来自一致的分析资料",
        "清晰区分主要分析行",
        "传统初稿",
        "稿件看起来",
        "本研究最直接的价值是透明性",
        "原始报告摘录",
        "补充证据文件",
        "对审稿和投稿准备而言",
    ]
    assert not any(phrase in main_text for phrase in forbidden)
    assert "安全性解释尤其需要独立处理" in main_text
    assert "泌尿生殖感染" in main_text
    assert "来源提示：补充审计保留" in supplement


def test_publication_body_language_removes_english_source_audit_process_fragments() -> None:
    manuscript = (
        "# Meta-analysis manuscript\n\n"
        "## Discussion\n\n"
        "The mortality benefit should be interpreted alongside practical bedside issues. Corticosteroids are "
        "inexpensive and widely available, but they can increase hyperglycemia, secondary infection risk, "
        "myopathy, delirium, and other complications in vulnerable ICU patients [1].\n\n"
        "The result is consistent with the direction and magnitude reported by the WHO REACT prospective "
        "meta-analysis [3]. The present reconstruction is not intended to supersede that collaborative "
        "prospective effort; rather, it demonstrates that the same clinical conclusion can be recovered from "
        "transparent trial rows.\n\n"
        "The review also illustrates why source provenance needs to be visible. Some selected rows come from "
        "polished journal articles, while others come from trial registries, open-access source pages, or a WHO "
        "REACT Figure 2 transcription. These source types differ in how directly a reader can verify the "
        "extracted number. The source appendix therefore records the source location, quote, and verification "
        "status for each selected primary row [2].\n\n"
        "A practical strength of this report is that the manuscript text, tables, and figures are all tied to the "
        "same analysis dataset. The numbers in the abstract, results section, trial-level tables, leave-one-out "
        "table, and figure captions come from the selected primary rows and meta-analysis result rather than "
        "from separate manual summaries [2].\n\n"
        "The current manuscript reports the source pathway so that readers can inspect those links. A human "
        "reviewer should still confirm trial registrations, final publications, and subgroup definitions against "
        "the original reports [2].\n\n"
        "The findings should also be read in the context of absolute risk. A relative reduction in mortality has "
        "greater absolute importance when baseline mortality is high [1].\n\n"
        "## Supplementary Materials\n\n"
        "The source appendix records the source location, quote, and verification status for each selected row.\n"
    )

    cleaned = WritingAgent._polish_publication_body_language(manuscript)
    main_text = cleaned.split("## Supplementary Materials", 1)[0]
    supplement = cleaned.split("## Supplementary Materials", 1)[1]

    forbidden = [
        "source provenance needs to be visible",
        "These source types differ",
        "source appendix therefore records",
        "manuscript text, tables, and figures are all tied to the same analysis dataset",
        "source pathway",
        "human reviewer should still confirm",
        "present reconstruction",
        "transparent trial rows",
    ]
    assert not any(phrase in main_text for phrase in forbidden)
    assert "consistent with the direction and magnitude reported by the WHO REACT prospective meta-analysis" in main_text
    assert "should still be interpreted clinically [3]." in main_text
    assert "practical bedside issues" in main_text
    assert "absolute risk" in main_text
    assert "source appendix records" in supplement


def test_publication_body_language_removes_hardcoded_source_appendix_process_blocks() -> None:
    manuscript = (
        "# Meta-analysis manuscript\n\n"
        "## Methods\n\n"
        "For each eligible trial we extracted the trial name, registration identifier when available, intervention "
        "corticosteroid, comparator, analysis population, outcome time point, deaths and denominators in each arm, "
        "source location, source excerpt, extraction confidence, and verification status [30]. The source appendix "
        "lists the exact source location and quote for every selected primary row [30]. This structure was intended "
        "to make each numeric claim traceable from the manuscript back to a row in the extraction record, rather "
        "than relying on a narrative summary alone [30].\n\n"
        "Before synthesis, selected rows were reconciled against the effect-size dataset and the PRISMA record. "
        "Study counts, participant totals, selected event counts, pooled effects, confidence intervals, and "
        "search-flow values were required to match the structured analysis dataset before they were reported in "
        "the manuscript [16].\n\n"
        "## Discussion\n\n"
        "The analysis combined conventional full-text sources with registry and source-document recovery [1]. "
        "The final tables retain source locations and quote verification status for each selected row [1]. "
        "The source appendix provides the row identifiers needed to trace the selected counts back to the "
        "extraction record [1].\n\n"
        "The certainty judgment should be read alongside the source appendix. The statistical result itself was "
        "reproducible from the selected data, but certainty also depends on trial conduct, applicability of the "
        "enrolled populations, precision of the pooled estimate, and completeness of the retrieved source record [1].\n\n"
        "Clinically, the pooled mortality estimate should be interpreted with attention to baseline risk, respiratory "
        "support, corticosteroid agent, dose, timing, and adverse-event monitoring [1].\n\n"
        "## Supplementary Materials\n\n"
        "The source appendix lists source excerpts for reviewers.\n"
    )

    cleaned = WritingAgent._polish_publication_body_language(manuscript)
    main_text = cleaned.split("## Supplementary Materials", 1)[0]
    supplement = cleaned.split("## Supplementary Materials", 1)[1]

    forbidden = [
        "source appendix",
        "source-document recovery",
        "source locations",
        "verification status",
        "same analysis dataset",
        "structured analysis dataset",
        "traceable from the manuscript",
        "documentation checks revise",
    ]
    assert not any(phrase in main_text.lower() for phrase in forbidden)
    assert "baseline risk" in main_text
    assert "adverse-event monitoring" in main_text
    assert "source appendix lists source excerpts" in supplement


def test_publication_body_language_backfills_citation_after_existing_who_react_rewrite() -> None:
    manuscript = (
        "# Meta-analysis manuscript\n\n"
        "## Discussion\n\n"
        "The result is consistent with the direction and magnitude reported by the WHO REACT prospective "
        "meta-analysis [9]. This concordance supports the clinical inference that corticosteroids reduce "
        "short-term mortality in critical COVID-19, while agent, dose, timing, and respiratory-support differences "
        "should still be interpreted clinically.\n"
    )

    cleaned = WritingAgent._polish_publication_body_language(manuscript)

    assert "should still be interpreted clinically [9]." in cleaned
    assert "should still be interpreted clinically.\n" not in cleaned


def test_publication_body_language_compresses_overlong_repetitive_discussion() -> None:
    repeated = [
        (
            f"Paragraph {i} repeats that the pooled HR was 0.81, baseline risk changes absolute benefit, "
            "the composite endpoint needs component interpretation, safety affects the benefit-harm balance, "
            "applicability depends on subgroups, implementation requires monitoring and follow-up, and certainty "
            "limits the conclusion."
        )
        for i in range(1, 29)
    ]
    manuscript = (
        "# Meta-analysis manuscript\n\n"
        "## Discussion\n\n"
        + "\n\n".join(repeated)
        + "\n\n## Conclusion\n\n"
        "The pooled effect supports individualized clinical decisions.\n\n"
        "## Supplementary Materials\n\n"
        + "\n\n".join(repeated)
    )

    cleaned = WritingAgent._polish_publication_body_language(manuscript)
    main_text = cleaned.split("## Supplementary Materials", 1)[0]
    supplement = cleaned.split("## Supplementary Materials", 1)[1]
    discussion = main_text.split("## Discussion", 1)[1].split("## Conclusion", 1)[0]
    paragraphs = [item for item in discussion.split("\n\n") if item.strip()]

    assert len(paragraphs) <= 14
    assert "pooled HR was 0.81" in discussion
    assert "baseline risk" in discussion
    assert "safety affects the benefit-harm balance" in discussion
    assert supplement.count("Paragraph ") == 28


def test_polish_rejects_overcompressed_rewrite_even_when_numbers_and_citations_are_preserved() -> None:
    filler = " ".join(
        [
            "This clinical interpretation sentence keeps the discussion focused on patient-level reasoning",
            "rather than generic manuscript mechanics",
        ]
        * 12
    )
    manuscript = (
        "# Meta-analysis manuscript\n\n"
        "## Discussion\n\n"
        f"The pooled HR was 0.81 (95% CI 0.74 to 0.88), and the result favored treatment [1]. {filler}.\n\n"
        "## References\n\n"
        "[1] Trial report.\n"
    )

    def overcompress(section_text: str, meta: dict) -> str:
        return "The pooled HR was 0.81 (95% CI 0.74 to 0.88), and the result favored treatment [1]."

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=overcompress,
        enabled=True,
        rewrite_scope="all",
        max_rewrite_chunks=5,
    )

    assert "patient-level reasoning" in polished
    assert report["rejected_chunks"] >= 1
    assert any(issue.get("code") == "rewrite_overcompressed" for issue in report["issues"])


def test_post_write_polish_reverts_publication_body_cleanup_when_it_changes_crossrefs(tmp_path) -> None:
    project = Project("post write publication body cleanup guarded", output_dir=tmp_path)
    draft = (
        "# 中文Meta分析稿件\n\n"
        "## 讨论\n\n"
        "图2提供研究流程、主要效应、敏感性分析和偏倚风险信息的可视化摘要，"
        "应与表格结果一起解释。\n\n"
        "另一个优势是清晰区分主要分析行和更广泛的提取记录。相关记录仍可用于"
        "背景、偏倚风险解释或试验语境。\n\n"
        "安全性解释尤其需要独立处理。泌尿生殖感染、容量不足、肾功能短期变化、"
        "酮症酸中毒风险以及治疗中断等安全性结局仍可能影响临床选择。\n\n"
        "## 参考文献\n\n"
        "［1］ Trial report.\n"
    )
    project.save_text("draft.md", draft, subdir="manuscript")

    polished = main_module._polish_project_manuscript(
        project,
        SimpleNamespace(polish_manuscript=True, no_polish_manuscript=False, manuscript_polish_scope="targeted"),
        model=None,
        lang="zh",
    )

    assert polished is not None
    saved = project.load_text("draft.md", subdir="manuscript")
    assert saved == draft
    audit = project.load_json("manuscript_polish_audit.json", subdir="manuscript")
    assert audit["publication_body_cleanup"]["applied"] is True
    assert audit["final_preservation_guard"]["applied"] is True
    assert "cross_references_changed" in audit["final_preservation_guard"]["issue_codes"]


def test_generic_meta_report_uses_specific_figure_refs_and_avoids_process_appendix_notes() -> None:
    protocol_en = ResearchProtocol(
        research_question=(
            "Do SGLT2 inhibitors reduce cardiovascular death or hospitalization "
            "for heart failure in adults with mildly reduced or preserved ejection fraction?"
        ),
        pico=PICO(
            population="Adults with heart failure with mildly reduced or preserved ejection fraction",
            intervention="SGLT2 inhibitors",
            comparator="Placebo",
            outcome_primary="Cardiovascular death or hospitalization for heart failure",
        ),
        effect_measure="HR",
        model_preference="fixed",
    )
    protocol_zh = ResearchProtocol(
        research_question="在射血分数保留或轻度降低的心力衰竭成人中，SGLT2抑制剂能否降低心血管死亡或心衰住院？",
        pico=PICO(
            population="射血分数保留或轻度降低的心力衰竭成人",
            intervention="SGLT2抑制剂",
            comparator="安慰剂",
            outcome_primary="心血管死亡或心衰住院",
        ),
        effect_measure="HR",
        model_preference="fixed",
    )
    facts = _minimal_meta_facts_for_language_tests()

    english = WritingAgent()._write_generic_meta_fallback_report(
        protocol=protocol_en,
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )
    chinese = WritingAgent(lang="zh")._write_generic_meta_fallback_report(
        protocol=protocol_zh,
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    figure_backfill_input = "\n".join([
        "# 稿件",
        "## 结果",
        "图1至图3展示研究流程、主要效应和偏倚风险。",
        "## 图表",
        "### 图1. PRISMA流程图",
        "![图1](../figures/prisma.png)",
        "### 图2. 森林图",
        "![图2](../figures/forest.png)",
        "### 图3. 偏倚风险概要",
        "![图3](../figures/rob.png)",
    ])
    figure_backfill_output = WritingAgent._backfill_publication_figure_references(figure_backfill_input)
    assert "图2提供研究流程" not in figure_backfill_output
    assert figure_backfill_output == figure_backfill_input
    assert WritingAgent._numbered_label_refs("图1至图3展示研究流程和森林图。", "Figure") == [1, 2, 3]
    assert WritingAgent._numbered_label_refs("表1至表3列出主要结果。", "Table") == [1, 2, 3]

    chinese_forbidden = [
        "写作前",
        "重新生成",
        "来源核验表应一起阅读",
        "结构化综述数据",
        "外部对照资料和稿件正文",
    ]
    english_forbidden = [
        "stored before writing",
        "regenerated",
        "source-audit table",
        "structured review dataset",
        "manuscript outputs",
    ]
    assert not any(phrase in chinese for phrase in chinese_forbidden)
    assert not any(phrase.lower() in english.lower() for phrase in english_forbidden)


def test_generic_meta_report_includes_absolute_effect_scenario_when_available() -> None:
    facts = _minimal_meta_facts_for_language_tests()
    facts["absolute_effects"] = {
        "effect_measure": "HR",
        "source": "observed_comparator_event_risk",
        "method": "proportional_hazards_baseline_risk_translation",
        "scenarios": [
            {
                "label": "Observed comparator risk in included trials",
                "assumed_control_risk_per_1000": 183,
                "intervention_risk_per_1000": 151,
                "risk_difference_per_1000": -33,
                "events_avoided_per_1000": 33,
                "events_avoided_ci_low_per_1000": 20,
                "events_avoided_ci_high_per_1000": 44,
                "nnt": 31,
                "nnt_ci_low": 23,
                "nnt_ci_high": 51,
            }
        ],
    }
    protocol_en = ResearchProtocol(
        research_question=(
            "Do SGLT2 inhibitors reduce cardiovascular death or hospitalization "
            "for heart failure in adults with mildly reduced or preserved ejection fraction?"
        ),
        pico=PICO(
            population="Adults with heart failure with mildly reduced or preserved ejection fraction",
            intervention="SGLT2 inhibitors",
            comparator="Placebo",
            outcome_primary="Cardiovascular death or hospitalization for heart failure",
        ),
        effect_measure="HR",
        model_preference="fixed",
    )
    protocol_zh = ResearchProtocol(
        research_question="在射血分数保留或轻度降低的心力衰竭成人中，SGLT2抑制剂能否降低心血管死亡或心衰住院？",
        pico=PICO(
            population="射血分数保留或轻度降低的心力衰竭成人",
            intervention="SGLT2抑制剂",
            comparator="安慰剂",
            outcome_primary="心血管死亡或心衰住院",
        ),
        effect_measure="HR",
        model_preference="fixed",
    )

    english = WritingAgent()._write_generic_meta_fallback_report(
        protocol=protocol_en,
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )
    chinese = WritingAgent(lang="zh")._write_generic_meta_fallback_report(
        protocol=protocol_zh,
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    assert "Table 4. Absolute-effect translation" in english
    assert "183 per 1000" in english
    assert "33 fewer events per 1000" in english
    assert "NNTB 31" in english
    assert "proportional hazards approximation" in english
    assert "Future updates of this review should therefore add absolute-effect scenarios" not in english

    assert "表4. 绝对效应解释" in chinese
    assert "每1000人183例" in chinese
    assert "每1000人减少33例事件" in chinese
    assert "获益需治数31" in chinese
    assert "比例风险近似" in chinese


def test_generic_meta_report_renders_multiple_baseline_risk_scenarios() -> None:
    facts = _minimal_meta_facts_for_language_tests()
    facts["absolute_effects"] = {
        "effect_measure": "HR",
        "source": "observed_comparator_event_risk",
        "method": "proportional_hazards_baseline_risk_translation",
        "scenarios": [
            {
                "label": "Observed comparator risk in included trials",
                "label_zh": "纳入试验对照组观察风险",
                "assumed_control_risk_per_1000": 183,
                "intervention_risk_per_1000": 151,
                "events_avoided_per_1000": 33,
                "events_avoided_ci_low_per_1000": 20,
                "events_avoided_ci_high_per_1000": 44,
                "nnt": 31,
                "nnt_type": "NNTB",
                "nnt_ci_low": 23,
                "nnt_ci_high": 51,
            },
            {
                "label": "Lower-risk target population",
                "label_zh": "较低风险目标人群",
                "assumed_control_risk_per_1000": 100,
                "intervention_risk_per_1000": 82,
                "events_avoided_per_1000": 18,
                "events_avoided_ci_low_per_1000": 11,
                "events_avoided_ci_high_per_1000": 25,
                "nnt": 55,
                "nnt_type": "NNTB",
                "nnt_ci_low": 40,
                "nnt_ci_high": 88,
            },
            {
                "label": "Higher-risk post-discharge population",
                "label_zh": "较高风险出院后人群",
                "assumed_control_risk_per_1000": 300,
                "intervention_risk_per_1000": 250,
                "events_avoided_per_1000": 50,
                "events_avoided_ci_low_per_1000": 30,
                "events_avoided_ci_high_per_1000": 68,
                "nnt": 21,
                "nnt_type": "NNTB",
                "nnt_ci_low": 15,
                "nnt_ci_high": 33,
            },
        ],
    }
    protocol_en = ResearchProtocol(
        research_question="Do SGLT2 inhibitors reduce heart failure events?",
        pico=PICO(
            population="Adults with HFmrEF/HFpEF",
            intervention="SGLT2 inhibitors",
            comparator="Placebo",
            outcome_primary="Cardiovascular death or hospitalization for heart failure",
        ),
        effect_measure="HR",
        model_preference="fixed",
    )
    protocol_zh = ResearchProtocol(
        research_question="SGLT2抑制剂能否降低HFmrEF/HFpEF患者心衰事件？",
        pico=PICO(
            population="HFmrEF/HFpEF成人",
            intervention="SGLT2抑制剂",
            comparator="安慰剂",
            outcome_primary="心血管死亡或心衰住院",
        ),
        effect_measure="HR",
        model_preference="fixed",
    )

    english = WritingAgent()._write_generic_meta_fallback_report(
        protocol=protocol_en,
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )
    chinese = WritingAgent(lang="zh")._write_generic_meta_fallback_report(
        protocol=protocol_zh,
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    assert "Lower-risk target population" in english
    assert "100 per 1000" in english
    assert "18 fewer events per 1000" in english
    assert "NNTB 55" in english
    assert "Higher-risk post-discharge population" in english
    assert "300 per 1000" in english
    assert "50 fewer events per 1000" in english
    assert "NNTB 21" in english
    assert "The Results section and Table 4 provide the numerical absolute-effect translation" in english

    assert "较低风险目标人群" in chinese
    assert "每1000人100例" in chinese
    assert "每1000人减少18例事件" in chinese
    assert "获益需治数55" in chinese
    assert "较高风险出院后人群" in chinese
    assert "每1000人300例" in chinese
    assert "每1000人减少50例事件" in chinese
    assert "获益需治数21" in chinese
    assert "结果部分和表4已经给出" in chinese


def test_generic_chinese_meta_methods_use_publication_documentation_terms() -> None:
    writer = WritingAgent(lang="zh")
    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question="在射血分数保留或轻度降低的心力衰竭成人中，SGLT2抑制剂能否降低心血管死亡或心衰住院？",
            pico=PICO(
                population="射血分数保留或轻度降低的心力衰竭成人",
                intervention="SGLT2抑制剂",
                comparator="安慰剂",
                outcome_primary="心血管死亡或心衰住院",
            ),
            effect_measure="HR",
            model_preference="fixed",
        ),
        facts=_minimal_meta_facts_for_language_tests(),
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    main_text = manuscript.split("## 补充材料", 1)[0]
    assert "补充证据文件" not in main_text
    assert "来源核验字段" not in main_text
    assert "原始报告摘录" not in main_text
    assert "补充提取表" in main_text


def test_generic_meta_methods_do_not_leak_internal_generation_or_file_workflow() -> None:
    protocol_en = ResearchProtocol(
        research_question=(
            "Do SGLT2 inhibitors reduce cardiovascular death or hospitalization "
            "for heart failure in adults with mildly reduced or preserved ejection fraction?"
        ),
        pico=PICO(
            population="Adults with heart failure with mildly reduced or preserved ejection fraction",
            intervention="SGLT2 inhibitors",
            comparator="Placebo",
            outcome_primary="Cardiovascular death or hospitalization for heart failure",
        ),
        effect_measure="HR",
        model_preference="fixed",
    )
    protocol_zh = ResearchProtocol(
        research_question="在射血分数保留或轻度降低的心力衰竭成人中，SGLT2抑制剂能否降低心血管死亡或心衰住院？",
        pico=PICO(
            population="射血分数保留或轻度降低的心力衰竭成人",
            intervention="SGLT2抑制剂",
            comparator="安慰剂",
            outcome_primary="心血管死亡或心衰住院",
        ),
        effect_measure="HR",
        model_preference="fixed",
    )
    english = WritingAgent()._write_generic_meta_fallback_report(
        protocol=protocol_en,
        facts=_minimal_meta_facts_for_language_tests(),
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )
    chinese = WritingAgent(lang="zh")._write_generic_meta_fallback_report(
        protocol=protocol_zh,
        facts=_minimal_meta_facts_for_language_tests(),
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    english_methods = english.split("## Methods", 1)[1].split("## Results", 1)[0]
    chinese_methods = chinese.split("## 方法", 1)[1].split("## 结果", 1)[0]

    english_forbidden = [
        "analysis file",
        "statistical object",
        "regenerated",
        "edited independently",
        "language model",
        "file records",
    ]
    chinese_forbidden = [
        "撰写正文",
        "从分析结果文件读取",
        "自动写成",
        "不由语言模型估计",
        "语言模型叙述",
        "本稿",
        "审稿人",
        "静默丢弃",
        "重新生成",
    ]
    assert not any(phrase.lower() in english_methods.lower() for phrase in english_forbidden)
    assert not any(phrase in chinese_methods for phrase in chinese_forbidden)


def test_generic_meta_introduction_frames_clinical_question_not_generation_process() -> None:
    writer = WritingAgent()
    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question=(
                "Do SGLT2 inhibitors reduce cardiovascular death or hospitalization "
                "for heart failure in adults with mildly reduced or preserved ejection fraction?"
            ),
            pico=PICO(
                population="Adults with heart failure with mildly reduced or preserved ejection fraction",
                intervention="SGLT2 inhibitors",
                comparator="Placebo",
                outcome_primary="Cardiovascular death or hospitalization for heart failure",
            ),
            effect_measure="HR",
            model_preference="fixed",
        ),
        facts=_minimal_meta_facts_for_language_tests(),
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    introduction = manuscript.split("## Introduction", 1)[1].split("## Methods", 1)[0]
    forbidden = [
        "source text",
        "source quote",
        "source verification",
        "regenerated",
        "calculation receipt",
        "clinical value of this format",
        "numeric claims remain consistent",
        "structured data",
        "full-length manuscript",
    ]
    assert not any(phrase.lower() in introduction.lower() for phrase in forbidden)
    assert "heart failure" in introduction.lower()
    assert "composite" in introduction.lower()
    assert "time-to-event" in introduction.lower()
    assert "baseline risk" in introduction.lower()


def test_generic_english_meta_fallback_balances_length_with_discussion_bounds() -> None:
    writer = WritingAgent()
    facts = _minimal_meta_facts_for_language_tests()
    facts["writing_constraints"] = {"publication_min_main_words": 6000}
    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question=(
                "Do SGLT2 inhibitors reduce cardiovascular death or hospitalization "
                "for heart failure in adults with mildly reduced or preserved ejection fraction?"
            ),
            pico=PICO(
                population="Adults with heart failure with mildly reduced or preserved ejection fraction",
                intervention="SGLT2 inhibitors",
                comparator="Placebo",
                outcome_primary="Cardiovascular death or hospitalization for heart failure",
            ),
            effect_measure="HR",
            model_preference="fixed",
        ),
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    main_text = manuscript.split("## Supplementary Materials", 1)[0]
    discussion = main_text.split("## Discussion", 1)[1].split("## Conclusion", 1)[0]

    assert WritingAgent._main_manuscript_word_count(main_text) >= 3300
    assert WritingAgent._main_manuscript_word_count(discussion) <= 1200


def test_generic_chinese_meta_introduction_frames_clinical_question_not_generation_process() -> None:
    writer = WritingAgent(lang="zh")
    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question="在射血分数保留或轻度降低的心力衰竭成人中，SGLT2抑制剂能否降低心血管死亡或心衰住院？",
            pico=PICO(
                population="射血分数保留或轻度降低的心力衰竭成人",
                intervention="SGLT2抑制剂",
                comparator="安慰剂",
                outcome_primary="心血管死亡或心衰住院",
            ),
            effect_measure="HR",
            model_preference="fixed",
        ),
        facts=_minimal_meta_facts_for_language_tests(),
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    introduction = manuscript.split("## 引言", 1)[1].split("## 方法", 1)[0]
    forbidden = [
        "追溯到原文",
        "跨章节不一致",
        "提高了透明性",
        "质量控制",
        "叙述上的流畅感",
        "来源位置",
        "正文都应基于",
        "完整论文格式在这里",
    ]
    assert not any(phrase in introduction for phrase in forbidden)
    assert "心力衰竭" in introduction
    assert "复合终点" in introduction
    assert "时间到事件" in introduction
    assert "基线风险" in introduction


def test_generic_chinese_meta_fallback_meets_publication_length_floor() -> None:
    writer = WritingAgent(lang="zh")
    facts = _minimal_meta_facts_for_language_tests()
    facts["writing_constraints"] = {"publication_min_main_words": 6000}
    manuscript = writer._write_generic_meta_fallback_report(
        protocol=ResearchProtocol(
            research_question="在射血分数保留或轻度降低的心力衰竭成人中，SGLT2抑制剂能否降低心血管死亡或心衰住院？",
            pico=PICO(
                population="射血分数保留或轻度降低的心力衰竭成人",
                intervention="SGLT2抑制剂",
                comparator="安慰剂",
                outcome_primary="心血管死亡或心衰住院",
            ),
            effect_measure="HR",
            model_preference="fixed",
        ),
        facts=facts,
        prisma_data={},
        grade_profile=None,
        project=None,
        ref_manager=None,
    )

    main_text = manuscript.split("## 补充材料", 1)[0]

    assert WritingAgent._main_manuscript_word_count(main_text) >= 3800
    assert "完整检索式如下" not in main_text
    assert "```text" not in main_text


def test_repeated_large_citation_clusters_are_narrowed_after_backfill() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## 引言\n背景证据需要引用。",
        "## 方法\n方法学描述需要引用。",
        "## 结果\n合并HR为0.81，需要引用。",
        "## 讨论",
        "第一段讨论复合终点和基线风险［3，5，7，20，23］。",
        "第二段讨论绝对获益和安全性［3，5，7，20，23］。",
        "第三段讨论指南适用性和亚组［3，5，7，20，23］。",
        "第四段讨论发表偏倚和确定性［3，5，7，20，23］。",
        "## 参考文献",
        "［3］ Guyatt GH. GRADE guidelines.",
        "［5］ Heart failure clinical guideline.",
        "［7］ Prior systematic review of SGLT2 inhibitors.",
        "［20］ Network meta-analysis of SGLT2 inhibitors.",
        "［23］ Egger M. Bias in meta-analysis.",
    ])

    updated = WritingAgent._limit_repeated_large_citation_clusters(manuscript)

    assert updated.count("［3，5，7，20，23］") <= 1
    assert "［3，5］" in updated
    assert "［7，20］" in updated
    repeated_large = [
        marker for marker in re.findall(r"［[0-9，、,;\s-]+］|\[[0-9,;\s-]+\]", updated)
        if len(WritingAgent._citation_numbers_from_text(marker)) >= 4 and updated.count(marker) > 1
    ]
    assert repeated_large == []


def test_mechanical_discussion_citation_density_is_smoothed_without_touching_numeric_effects() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Discussion",
        (
            "Publication bias is hard to judge in a sparse evidence base [23]. "
            "Absence of funnel-plot asymmetry cannot reassure readers when there are too few studies [18]. "
            "Confidence should rest more on trial size, directness, and outcome adjudication [12-14,18]."
        ),
        (
            "The pooled HR was 0.80 (95% CI, 0.73 to 0.88) [1]. "
            "This numeric effect sentence should keep its exact source citation."
        ),
        (
            "Medication persistence is another practical consideration. "
            "The benefit shown in trials assumes patients can remain on therapy long enough to experience event reduction [1,2]. "
            "In routine practice, discontinuation may occur because of cost or adverse effects [1,2]. "
            "Implementation support may influence real-world effectiveness [3,5]."
        ),
        "## References",
        "\n".join(f"[{i}] Reference {i}." for i in range(1, 24)),
    ])

    updated = WritingAgent._smooth_mechanical_citation_density(manuscript)

    assert "too few studies [18]." not in updated
    assert "[12-14,18]" in updated
    assert "The pooled HR was 0.80 (95% CI, 0.73 to 0.88) [1]." in updated
    assert "event reduction [1,2]." in updated


def test_mechanical_methods_citation_density_is_smoothed_while_preserving_result_sources() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Methods",
        (
            "The protocol specified eligibility criteria before screening [16]. "
            "The search strategy was documented before record screening [16]. "
            "Outcome extraction used prespecified fields [16]. "
            "Risk-of-bias judgments were summarized by domain [16]. "
            "Certainty assessment followed GRADE domains [16]."
        ),
        "## Results",
        (
            "The pooled HR was 0.80 (95% CI, 0.73 to 0.88) [1]. "
            "Heterogeneity was I2 0% [1]. "
            "The participant total was 12251 [1]."
        ),
        "## References",
        "\n".join(f"[{i}] Reference {i}." for i in range(1, 24)),
    ])

    updated = WritingAgent._smooth_mechanical_citation_density(manuscript)

    methods = updated.split("## Methods", 1)[1].split("## Results", 1)[0]
    results = updated.split("## Results", 1)[1].split("## References", 1)[0]
    assert methods.count("[16]") < 5
    assert "The pooled HR was 0.80 (95% CI, 0.73 to 0.88) [1]." in results
    assert "Heterogeneity was I2 0% [1]." in results


def test_global_citation_density_is_capped_without_dropping_numeric_sources() -> None:
    methods_paragraphs = [
        (
            f"Protocol paragraph {index} describes eligibility, screening, extraction, "
            "risk-of-bias assessment, and certainty reporting [16]."
        )
        for index in range(70)
    ]
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Methods",
        "\n\n".join(methods_paragraphs),
        "## Results",
        (
            "The pooled HR was 0.80 (95% CI, 0.73 to 0.88) [1]. "
            "Heterogeneity was I2 0% [1]. "
            "The participant total was 12251 [1]."
        ),
        "## References",
        "\n".join(f"[{i}] Reference {i}." for i in range(1, 24)),
    ])

    updated = WritingAgent._smooth_mechanical_citation_density(manuscript)
    main_text = WritingAgent._main_text_before_reference_section(updated)
    word_count = WritingAgent._main_manuscript_word_count(main_text)
    citation_count = len(WritingAgent._citation_numbers_from_text(main_text))
    density = citation_count * 1000 / word_count

    assert density <= 35.0
    assert "The pooled HR was 0.80 (95% CI, 0.73 to 0.88) [1]." in updated
    assert "Heterogeneity was I2 0% [1]." in updated


def test_global_citation_density_cap_keeps_methodology_claim_sources() -> None:
    methods_paragraphs = [
        "Reporting followed PRISMA 2020 principles for systematic-review presentation [16].",
        "The I2 statistic and tau2 described heterogeneity across study estimates [21,22].",
        "Risk-of-bias judgments were treated as study-level judgments [19].",
        "GRADE described confidence in the body of evidence [20].",
    ] + [
        (
            f"Protocol paragraph {index} describes eligibility, screening, extraction, "
            "risk-of-bias assessment, and certainty reporting [16]."
        )
        for index in range(70)
    ]
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Methods",
        "\n\n".join(methods_paragraphs),
        "## Results",
        "The pooled HR was 0.80 (95% CI, 0.73 to 0.88) [1].",
        "## References",
        "\n".join(f"[{i}] Reference {i}." for i in range(1, 24)),
    ])

    updated = WritingAgent._smooth_mechanical_citation_density(manuscript)
    main_text = WritingAgent._main_text_before_reference_section(updated)
    word_count = WritingAgent._main_manuscript_word_count(main_text)
    citation_count = len(WritingAgent._citation_numbers_from_text(main_text))

    assert "PRISMA 2020 principles for systematic-review presentation [16]." in updated
    assert "I2 statistic and tau2 described heterogeneity across study estimates [21,22]." in updated
    assert "Risk-of-bias judgments were treated as study-level judgments [19]." in updated
    assert "GRADE described confidence in the body of evidence [20]." in updated
    assert citation_count * 1000 / word_count <= 35.0


def test_publication_backfill_restores_methodology_sentence_sources_after_density_cap() -> None:
    generic_methods = [
        (
            f"Protocol paragraph {index} describes eligibility, screening, extraction, "
            "risk-of-bias assessment, and certainty reporting [16]."
        )
        for index in range(70)
    ]
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Methods",
        (
            "The primary pooled estimate was HR 0.81 (95% CI 0.74 to 0.88), with p<0.001. "
            "Heterogeneity was low (I2=0.0%, Cochran Q=0.17, p=0.678, tau2=0.000)."
        ),
        "A narrow confidence interval describes precision, heterogeneity describes compatibility of study estimates, and GRADE describes confidence in the body of evidence.",
        "Risk-of-bias judgments were treated as study-level judgments that can influence certainty even when the direction of effect is stable.",
        "\n\n".join(generic_methods),
        "## Results",
        "The pooled HR was 0.80 (95% CI, 0.73 to 0.88) [1].",
        "## References",
        "\n".join([
            "[1] Trial A randomized clinical trial.",
            "[16] PRISMA 2020 statement.",
            "[17] PRISMA-S search reporting guideline.",
            "[19] Cochrane RoB 2 risk-of-bias tool.",
            "[20] GRADE handbook.",
            "[21] DerSimonian and Laird random-effects methods.",
            "[22] Higgins I2 heterogeneity statistic.",
            "[23] Egger publication bias test.",
        ]),
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)
    main_text = WritingAgent._main_text_before_reference_section(updated)
    word_count = WritingAgent._main_manuscript_word_count(main_text)
    citation_count = len(WritingAgent._citation_numbers_from_text(main_text))

    assert "Heterogeneity was low (I2=0.0%, Cochran Q=0.17, p=0.678, tau2=0.000) [21,22]." in updated
    assert "GRADE describes confidence in the body of evidence [20]." in updated
    assert "Risk-of-bias judgments were treated as study-level judgments that can influence certainty even when the direction of effect is stable [19]." in updated
    assert citation_count * 1000 / word_count <= 35.0


def test_publication_backfill_limits_large_clusters_after_final_claim_supplements() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Discussion",
        "Clinical decisions should account for baseline risk, absolute benefit, safety, renal function, cost, and patient preferences [1-3,5].",
        "## Conclusion",
        "The result supports use in patients resembling the included trials while accounting for baseline risk, safety, renal function, cost, and patient preferences [1-3,5].",
        "## References",
        "\n".join([
            "[1] Trial A randomized clinical trial.",
            "[2] Trial B randomized clinical trial.",
            "[3] Heart failure clinical guideline.",
            "[4] Prior systematic review.",
            "[5] SGLT2 inhibitor safety review.",
            "[20] GRADE handbook.",
            "[23] Egger publication bias test.",
        ]),
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)
    repeated_clusters = [
        marker for marker in re.findall(r"\[[0-9,;\s-]+\]", updated)
        if len(WritingAgent._citation_numbers_from_text(marker)) >= 4 and updated.count(marker) > 1
    ]

    assert repeated_clusters == []


def test_adjacent_citation_clusters_are_merged_after_backfill() -> None:
    manuscript = (
        "## Discussion\n"
        "The finding aligns with guidelines [3,13] [1,2]. "
        "证据确定性需要结合方法学判断［20］［19，20，23］。\n\n"
        "## References\n"
        "[1] Trial A.\n[2] Trial B.\n[3] Guideline.\n[13] Review.\n[19] RoB.\n[20] GRADE.\n[23] Bias.\n"
    )

    updated = WritingAgent._merge_adjacent_citation_clusters(manuscript)

    assert "[3,13] [1,2]" not in updated
    assert "［20］［19，20，23］" not in updated
    assert "[1-3,13]" in updated
    assert "［19，20，23］" in updated


def test_adjacent_citation_clusters_merge_overlapping_six_reference_cluster() -> None:
    manuscript = (
        "## 讨论\n"
        "主要结果需要同时参考试验、指南和方法学资料［1-4，13］［1，2，5］。\n\n"
        "## 参考文献\n"
        "［1］ Trial A.\n［2］ Trial B.\n［3］ Guideline.\n［4］ Review.\n"
        "［5］ Prior review.\n［13］ Mechanistic review.\n"
    )

    updated = WritingAgent._merge_adjacent_citation_clusters(manuscript)

    assert "］［" not in updated
    assert "［1-5，13］" in updated


def test_adjacent_citation_clusters_trim_overloaded_cluster_in_publication_mode() -> None:
    manuscript = (
        "## 讨论\n"
        "一句话被多轮补引堆出了两个连续角标［1，2，4-6］［3，13］。\n\n"
        "## 参考文献\n"
        "［1］ Trial A.\n［2］ Trial B.\n［3］ Guideline.\n［4］ Review.\n"
        "［5］ Prior review.\n［6］ Context.\n［13］ Mechanistic review.\n"
    )

    updated = WritingAgent._merge_adjacent_citation_clusters(
        manuscript,
        max_cluster_size=5,
        trim_overloaded=True,
    )

    assert "］［" not in updated
    assert "［1-5］" in updated


def test_citation_audit_backfill_merges_with_existing_sentence_citations() -> None:
    manuscript = (
        "## Discussion\n"
        "The treatment appears to reduce heart failure events [3,13].\n\n"
        "## References\n"
        "[1] Trial A.\n[2] Trial B.\n[3] Guideline.\n[13] Review.\n"
    )
    audit = {
        "issues": [
            {
                "code": "uncited_discussion_result_claim",
                "section": "Discussion",
                "recommended_citations": [1, 2],
                "evidence_excerpt": "The treatment appears to reduce heart failure events",
            }
        ]
    }

    updated, applied = WritingAgent._backfill_citation_audit_recommendations(manuscript, audit)

    assert applied == 1
    assert "[3,13] [1,2]" not in updated
    assert "[1-3,13]" in updated


def test_citation_audit_backfill_matches_substantive_sentence_inside_multisentence_excerpt() -> None:
    manuscript = (
        "## 引言\n"
        "危重型COVID-19患者需要清晰的随机证据背景。\n\n"
        "结局层级需要特别清楚。28天全因死亡率作为患者直接相关的临床结局，比替代指标更容易解释，但仍需要说明事件定义、观察窗口、失访处理和判定方式是否在研究间足够一致。\n\n"
        "## 参考文献\n"
        "［12］ Trial report.\n"
    )
    audit = {
        "issues": [
            {
                "code": "uncited_introduction_background_claim",
                "section": "Introduction",
                "recommended_citations": [12],
                "evidence_excerpt": "结局层级需要特别清楚。28天全因死亡率作为患者直接相关的临床结局，比替代指标更容易解释，但仍需要说明事件定义、观察窗口、失访处理和判定方式是否在研究间足够一致。",
            }
        ]
    }

    updated, applied = WritingAgent._backfill_citation_audit_recommendations(manuscript, audit)

    assert applied == 1
    assert "足够一致［12］" in updated
    assert "随机证据背景［12］" not in updated


def test_publication_citation_backfill_limits_repeated_clusters_after_final_density() -> None:
    long_discussion = "\n\n".join(
        [
            (
                "This clinical paragraph explains baseline risk, composite endpoint interpretation, "
                "safety monitoring, kidney function, patient preferences, and follow-up decisions in "
                "enough detail to be treated as a substantial interpretive paragraph [1,2,5]."
            )
            for _ in range(7)
        ]
    )
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Introduction\nBackground rationale needs a citation and clinical context.",
        "## Methods\nMethods describe search, screening, certainty assessment, and statistics.",
        "## Results\nThe pooled HR was 0.81 and the confidence interval excluded 1.00.",
        "## Discussion",
        long_discussion,
        "## References",
        "[1] Trial A randomized clinical trial.",
        "[2] Trial B randomized clinical trial.",
        "[3] Heart failure guideline.",
        "[4] Prior systematic review.",
        "[5] Mechanistic review.",
        "[20] GRADE handbook.",
        "[23] Bias in meta-analysis.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    assert updated.count("[1,2,5]") <= 1
    repeated_clusters = [
        marker for marker in re.findall(r"\[[0-9,;\s-]+\]", updated)
        if len(WritingAgent._citation_numbers_from_text(marker)) >= 3 and updated.count(marker) > 1
    ]
    assert repeated_clusters == []


def test_overused_background_citation_is_capped_without_removing_numeric_sources() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Discussion",
        "The pooled OR was 0.66 (95% CI 0.53 to 0.82) [1].",
        "\n\n".join(
            f"Background interpretation sentence {i} explains clinical context [19]."
            for i in range(18)
        ),
        "## References",
        "[1] RECOVERY randomized clinical trial.",
        "[19] Corticosteroids in COVID-19 systematic review and meta-analysis.",
        "[21] Page MJ, et al. PRISMA 2020 statement.",
    ])
    entries = WritingAgent._reference_entries_from_references_section(manuscript)

    updated = WritingAgent._cap_overused_nonmethod_citations(manuscript, entries, max_mentions=12)
    main = WritingAgent._main_text_before_reference_section(updated)

    assert WritingAgent._citation_numbers_from_text(main).count(19) <= 12
    assert "OR was 0.66 (95% CI 0.53 to 0.82) [1]." in updated


def test_least_cited_paragraph_backfill_uses_claim_specific_reference_type() -> None:
    safety_manuscript = "\n\n".join([
        "# Manuscript",
        "## Discussion",
        (
            "Safety outcomes require separate interpretation because genitourinary infection, "
            "volume depletion, ketoacidosis risk, and renal-function changes can alter net benefit."
        ),
        "## References",
        "[1] Trial A randomized clinical trial.",
        "[2] Heart failure clinical guideline.",
        "[3] Mechanistic review of SGLT2 inhibitors, natriuresis, and renal hemodynamics.",
        "[4] SGLT2 inhibitor safety review of genitourinary infection, ketoacidosis, renal function, and treatment discontinuation.",
        "[5] GRADE handbook.",
    ])
    mechanism_manuscript = "\n\n".join([
        "# Manuscript",
        "## Discussion",
        (
            "Plausible mechanisms include osmotic diuresis, natriuresis, lower congestion, "
            "favorable renal hemodynamics, and cardiometabolic stress pathways."
        ),
        "## References",
        "[1] Trial A randomized clinical trial.",
        "[2] Heart failure clinical guideline.",
        "[3] Mechanistic review of SGLT2 inhibitors, natriuresis, and renal hemodynamics.",
        "[4] SGLT2 inhibitor safety review of genitourinary infection, ketoacidosis, renal function, and treatment discontinuation.",
        "[5] GRADE handbook.",
    ])
    safety_entries = WritingAgent._reference_entries_from_references_section(safety_manuscript)
    mechanism_entries = WritingAgent._reference_entries_from_references_section(mechanism_manuscript)

    safety_updated = WritingAgent._append_citation_to_least_cited_paragraph(
        safety_manuscript,
        "Discussion",
        "[2]",
        entries=safety_entries,
    )
    mechanism_updated = WritingAgent._append_citation_to_least_cited_paragraph(
        mechanism_manuscript,
        "Discussion",
        "[2]",
        entries=mechanism_entries,
    )

    assert "net benefit [4]." in safety_updated
    assert "stress pathways [3]." in mechanism_updated
    assert "net benefit [2]." not in safety_updated
    assert "stress pathways [2]." not in mechanism_updated


def test_publication_backfill_supplements_existing_generic_citation_with_claim_specific_source() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Discussion",
        (
            "Safety outcomes require separate interpretation because genitourinary infection, "
            "volume depletion, ketoacidosis risk, and renal-function changes can alter net benefit [2]."
        ),
        (
            "Plausible mechanisms include osmotic diuresis, natriuresis, lower congestion, "
            "favorable renal hemodynamics, and cardiometabolic stress pathways [2]."
        ),
        "## References",
        "[1] Trial A randomized clinical trial.",
        "[2] Heart failure clinical guideline.",
        "[3] Mechanistic review of SGLT2 inhibitors, natriuresis, and renal hemodynamics.",
        "[4] SGLT2 inhibitor safety review of genitourinary infection, ketoacidosis, renal function, and treatment discontinuation.",
        "[5] GRADE handbook.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    assert "net benefit [4]." in updated
    assert "stress pathways [3]." in updated
    assert "net benefit [2]." not in updated
    assert "stress pathways [2]." not in updated


def test_publication_backfill_cites_uncited_safety_claims_in_interpretive_sections() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Introduction",
        (
            "Safety is also central to SGLT2 inhibitor use because volume depletion, "
            "genitourinary infection, early renal-function changes, and ketoacidosis "
            "can modify individual net benefit."
        ),
        "## Discussion",
        (
            "Safety outcomes require separate interpretation because genitourinary infection, "
            "volume depletion, ketoacidosis risk, and renal-function changes can alter net benefit."
        ),
        "## References",
        "[1] Trial A randomized clinical trial.",
        "[2] Heart failure clinical guideline.",
        "[3] Mechanistic review of SGLT2 inhibitors, natriuresis, and renal hemodynamics.",
        "[4] SGLT2 inhibitor safety review of genitourinary infection, ketoacidosis, renal function, and treatment discontinuation.",
        "[5] GRADE handbook.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    assert re.search(r"individual net benefit \[[^\]]*4[^\]]*\]\.", updated)
    assert re.search(r"alter net benefit \[[^\]]*4[^\]]*\]\.", updated)


def test_publication_backfill_cites_claim_sentence_even_when_paragraph_has_matching_source() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Discussion",
        (
            "The direction aligns with mechanistic evidence [2]. "
            "Plausible mechanisms include osmotic diuresis, natriuresis, lower congestion, "
            "favorable renal hemodynamics, and cardiometabolic stress pathways."
        ),
        "## References",
        "[1] Trial A randomized clinical trial.",
        "[2] Mechanistic review of SGLT2 inhibitors, natriuresis, and renal hemodynamics.",
        "[3] Heart failure clinical guideline.",
        "[4] GRADE handbook.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    assert "mechanistic evidence [2]. Plausible mechanisms" in updated
    assert "stress pathways [2]." in updated


def test_publication_backfill_does_not_cite_short_claim_lead_in_sentences() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Discussion",
        (
            "Safety needs separate consideration. Genitourinary infection, volume depletion, "
            "ketoacidosis risk, and renal-function changes can alter individual net benefit."
        ),
        "## References",
        "[1] Trial A randomized clinical trial.",
        "[2] Heart failure clinical guideline.",
        "[3] Mechanistic review of SGLT2 inhibitors.",
        "[4] SGLT2 inhibitor safety review of genitourinary infection, ketoacidosis, renal function, and treatment discontinuation.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    assert "Safety needs separate consideration [4]." not in updated
    assert "individual net benefit [4]." in updated


def test_mechanism_claim_prefers_pathophysiology_source_over_generic_diabetes_source() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Discussion",
        (
            "Plausible mechanisms include osmotic diuresis, natriuresis, lower congestion, "
            "favorable renal hemodynamics, and cardiometabolic stress pathways."
        ),
        "## References",
        "[1] SGLT2 inhibitors in frail or older people with type 2 diabetes and heart failure: a safety review.",
        "[2] Epidemiology, Pathophysiology, Diagnosis and Treatment of Heart Failure in Diabetes.",
        "[3] Heart failure clinical guideline.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    assert "stress pathways [2]." in updated
    assert "stress pathways [1]." not in updated


def test_absolute_effect_interpretation_uses_primary_trial_sources() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Discussion",
        (
            "Clinical use should translate the pooled HR into absolute risk difference "
            "and number needed to treat for the target setting."
        ),
        "## References",
        "[1] Trial A randomized clinical trial.",
        "[2] Trial B randomized clinical trial.",
        "[3] Mechanistic review of SGLT2 inhibitors.",
        "[4] GRADE handbook.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    sentence = next(line for line in updated.splitlines() if "target setting" in line)
    assert {1, 2}.issubset(WritingAgent._citation_numbers_from_text(sentence))


def test_sentence_level_absolute_effect_citation_uses_two_primary_sources() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Discussion",
        "Placeholder.",
        "## References",
        "[1] Trial A randomized clinical trial.",
        "[2] Trial B randomized clinical trial.",
        "[3] GRADE handbook.",
    ])
    entries = WritingAgent._reference_entries_from_references_section(manuscript)

    updated = WritingAgent._append_claim_specific_citations_to_sentences(
        "Clinical use should translate the pooled HR into absolute risk difference and number needed to treat.",
        entries,
        "Discussion",
    )

    assert updated.endswith("number needed to treat [1,2].")


def test_methods_and_results_claim_backfill_removes_publication_audit_warnings(tmp_path) -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Introduction",
        "Heart failure with preserved ejection fraction is clinically important [3].",
        "## Methods",
        (
            "Heterogeneity was low (I2=0.0%, Cochran Q=0.17, p=0.678, tau2=0.000). "
            "The I2 statistic was used to describe the proportion of observed variability "
            "not attributed to sampling error."
        ),
        "## Results",
        (
            "The primary quantitative synthesis included 2 studies and 12,251 participants. "
            "Table 1 lists the included studies, report location, event counts, and documentation status."
        ),
        "## Discussion",
        "The result should be interpreted in the context of the included randomized trials [1,2].",
        "## References",
        "[1] Empagliflozin in Heart Failure with a Preserved Ejection Fraction. Randomized clinical trial.",
        "[2] Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction. Randomized clinical trial.",
        "[3] Heart failure clinical guideline.",
        "[4] DerSimonian R, Laird N. Meta-analysis in clinical trials.",
        "[5] Higgins JPT, Thompson SG, Deeks JJ, Altman DG. Measuring inconsistency in meta-analyses.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)
    project = Project("methods-results-backfill", output_dir=tmp_path / uuid4().hex)
    project.save_text("draft.md", updated, subdir="manuscript")
    audit = _build_citation_audit_review(project)

    assert audit["summary"]["uncited_methods_methodology_claims"] == 0
    assert audit["summary"]["uncited_results_study_data_claims"] == 0
    assert re.search(r"Heterogeneity was low .*\[[^\]]*(?:4|5)[^\]]*\]\.", updated)
    assert re.search(r"12,251 participants \[[^\]]*(?:1|2)[^\]]*\]\.", updated)
    assert re.search(r"documentation status \[[^\]]*(?:1|2)[^\]]*\]\.", updated)


def test_methods_claim_backfill_does_not_spray_methodology_refs_on_process_sentences() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Methods",
        "Placeholder.",
        "## References",
        "[1] RECOVERY randomized clinical trial.",
        "[2] CoDEX randomized clinical trial.",
        "[21] Page MJ, et al. PRISMA 2020 statement.",
        "[24] RoB 2 risk-of-bias tool.",
        "[25] GRADE handbook.",
        "[28] Egger publication bias test.",
    ])
    entries = WritingAgent._reference_entries_from_references_section(manuscript)

    process_sentence = (
        "For each study, reviewers extracted study identity, outcome name, intervention and "
        "control arm events, denominators, reported effect estimates, standard errors, and "
        "report location."
    )
    methodology_sentence = (
        "GRADE certainty was summarized across risk of bias, inconsistency, indirectness, "
        "imprecision, and publication bias."
    )

    process_updated = WritingAgent._append_claim_specific_citations_to_sentences(
        process_sentence,
        entries,
        "Methods",
    )
    methodology_updated = WritingAgent._append_claim_specific_citations_to_sentences(
        methodology_sentence,
        entries,
        "Methods",
    )

    assert process_updated == process_sentence
    assert re.search(r"publication bias \[[^\]]*(?:25|28)[^\]]*\]\.", methodology_updated)


def test_discussion_result_claim_backfill_cites_absolute_and_clinical_context(tmp_path) -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Introduction",
        "Heart failure with preserved ejection fraction is clinically important [3].",
        "## Methods",
        "We used prespecified methods [4].",
        "## Results",
        "The primary analysis included two randomized trials [1,2].",
        "## Discussion",
        (
            "Conversely, patients with less congestion may tolerate therapy easily but have fewer "
            "preventable events over a short time horizon. Across the baseline-risk scenarios in "
            "Table 4, absolute effects range from 18 to 50 fewer events per 1000. This scope "
            "reduces the risk of mixing adjacent populations, secondary endpoints, or duplicate "
            "reports into the primary estimate."
        ),
        "## References",
        "[1] Empagliflozin in Heart Failure with a Preserved Ejection Fraction. Randomized clinical trial.",
        "[2] Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction. Randomized clinical trial.",
        "[3] Heart failure clinical guideline.",
        "[4] GRADE handbook.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)
    project = Project("discussion-result-backfill", output_dir=tmp_path / uuid4().hex)
    project.save_text("draft.md", updated, subdir="manuscript")
    audit = _build_citation_audit_review(project)

    assert audit["summary"]["uncited_discussion_result_claims"] == 0
    assert re.search(r"short time horizon \[[^\]]*(?:1|2)[^\]]*\]\.", updated)
    assert re.search(r"fewer events per 1000 \[[^\]]*(?:1|2)[^\]]*\]\.", updated)
    assert re.search(r"primary estimate \[[^\]]*(?:1|2)[^\]]*\]\.", updated)


def test_composite_interpretation_sentence_keeps_trial_mechanism_and_guideline_sources() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Discussion",
        "Placeholder.",
        "## References",
        "[1] Trial A randomized clinical trial.",
        "[2] Trial B randomized clinical trial.",
        "[5] Mechanistic review of SGLT2 inhibitors, natriuresis, and renal hemodynamics.",
        "[8] Heart failure clinical guideline.",
    ])
    entries = WritingAgent._reference_entries_from_references_section(manuscript)

    updated = WritingAgent._append_claim_specific_citations_to_sentences(
        (
            "The meta-analysis does not prove mechanism, but coherence between trial results, "
            "biological plausibility, and guideline context strengthens the clinical interpretation."
        ),
        entries,
        "Discussion",
    )

    assert updated.endswith("clinical interpretation [1,2,5,8].")


def test_participant_count_sentence_replaces_background_refs_with_primary_trial_sources() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Discussion",
        "Placeholder.",
        "## References",
        "[1] Empagliflozin in Heart Failure with a Preserved Ejection Fraction. Randomized clinical trial.",
        "[2] Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction. Randomized clinical trial.",
        "[5] Heart failure background review.",
        "[6] Prior narrative review.",
        "[7] Mechanistic review.",
    ])
    entries = WritingAgent._reference_entries_from_references_section(manuscript)

    updated = WritingAgent._append_claim_specific_citations_to_sentences(
        (
            "The confidence interval did not cross the null value, and the included trials "
            "contributed 12,251 participants [5-7]."
        ),
        entries,
        "Discussion",
    )

    assert updated.endswith("12,251 participants [1,2].")
    assert "[5-7]" not in updated


def test_conclusion_clinical_decision_sentence_uses_clinical_sources_not_publication_bias_methods() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Conclusion",
        "Placeholder.",
        "## References",
        "[1] Empagliflozin in Heart Failure with a Preserved Ejection Fraction. Randomized clinical trial.",
        "[2] Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction. Randomized clinical trial.",
        "[5] Safety and tolerability of SGLT2 inhibitors in heart failure.",
        "[13] Heart failure clinical guideline and recommendations.",
        "[20] GRADE certainty framework.",
        "[23] Egger test for publication bias in meta-analysis.",
    ])
    entries = WritingAgent._reference_entries_from_references_section(manuscript)

    updated = WritingAgent._append_claim_specific_citations_to_sentences(
        (
            "The result supports consideration of SGLT2 inhibitors for patients resembling the "
            "included trials, while clinical decisions should account for baseline risk, absolute "
            "benefit, safety, renal function, cost, and patient preferences [1,2,20,23]."
        ),
        entries,
        "Conclusion",
    )

    assert updated.endswith("patient preferences [1,2,5,13].")
    assert "20" not in updated
    assert "23" not in updated


def test_chinese_absolute_effect_sentence_restores_primary_trial_sources_after_context_citations() -> None:
    manuscript = "\n\n".join([
        "# 中文稿件",
        "## 讨论",
        "占位。",
        "## 参考文献",
        "［1］ Empagliflozin in Heart Failure with a Preserved Ejection Fraction. Randomized clinical trial.",
        "［2］ Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction. Randomized clinical trial.",
        "［3］ Heart failure clinical guideline.",
        "［5］ Safety and tolerability of SGLT2 inhibitors in heart failure.",
    ])
    entries = WritingAgent._reference_entries_from_references_section(manuscript)

    updated = WritingAgent._append_claim_specific_citations_to_sentences(
        "临床实施时，应把合并HR转化为具体人群的绝对风险差、需要治疗人数和不良事件权衡［3，5］。",
        entries,
        "讨论",
    )

    numbers = set(WritingAgent._citation_numbers_from_text(updated))
    assert {1, 2}.issubset(numbers)
    assert {3, 5}.issubset(numbers)


def test_methodology_references_are_added_and_saved_for_manuscript_context(tmp_path) -> None:
    project = Project("methodology refs", output_dir=tmp_path)
    ref_manager = ReferenceManager()

    summary = _add_methodology_references(
        project,
        ref_manager,
        include_rob=True,
        include_grade=True,
        include_publication_bias=True,
    )

    context = project.load_json("methodology_context.json", subdir="search")
    titles = " ".join(item["title"] for item in context["references"])

    assert summary["added_references"] >= 7
    assert "PRISMA 2020" in titles
    assert "GRADE" in titles
    assert "DerSimonian" in titles
    assert all(re.match(r"^\[\d+\]$", item["citation"]) for item in context["references"])
    assert ref_manager.to_bibtex().count("@article{") == len(context["references"])


def test_writing_agent_passes_methodology_context_to_methods_prompt(monkeypatch) -> None:
    writer = WritingAgent()
    writer._methodology_citation_context = (
        "- [1] reporting guideline: PRISMA 2020\n"
        "- [2] certainty framework: GRADE\n"
        "- [3] statistical method: DerSimonian-Laird random-effects model"
    )
    captured: list[str] = []

    def fake_llm(prompt, *args, **kwargs):
        captured.append(prompt)
        return "## Methods\nMethods text."

    monkeypatch.setattr(writer, "call_llm", fake_llm)

    writer._write_methods(
        _protocol(),
        prisma={
            "identification": {"records_identified": 10, "records_after_dedup": 9},
            "screening": {"title_abstract_screened": 9},
            "eligibility": {"full_text_assessed": 4},
            "included": {"studies_included": 3},
        },
        query="COVID-19 AND corticosteroids",
        rob_results=[StudyRoB(study_id="S1", tool_used="RoB 2")],
        search_date="2026-05-23",
    )

    assert "Methodology citation context" in captured[0]
    assert "PRISMA 2020" in captured[0]
    assert "GRADE" in captured[0]
    assert "DerSimonian-Laird" in captured[0]


def test_writing_agent_prompts_include_section_citation_requirements(monkeypatch) -> None:
    writer = WritingAgent()
    writer._background_citation_context = (
        "- [4] guideline: Heart failure guideline\n"
        "- [5] prior review: Prior systematic review"
    )
    writer._methodology_citation_context = (
        "- [2] reporting guideline: PRISMA 2020\n"
        "- [3] methods handbook: Cochrane Handbook\n"
        "- [6] certainty framework: GRADE"
    )
    captured: list[str] = []

    def fake_llm(prompt, *args, **kwargs):
        captured.append(prompt)
        return "section text"

    monkeypatch.setattr(writer, "call_llm", fake_llm)

    writer._write_introduction(_protocol())
    writer._write_methods(
        _protocol(),
        prisma={
            "identification": {"records_identified": 10, "records_after_dedup": 9},
            "screening": {"title_abstract_screened": 9},
            "eligibility": {"full_text_assessed": 4},
            "included": {"studies_included": 3},
        },
        query="COVID-19 AND corticosteroids",
        rob_results=[],
        search_date="2026-05-23",
    )

    intro_prompt, methods_prompt = captured[:2]
    assert "Section citation requirements" in intro_prompt
    assert "Introduction: cite at least 2 background/guideline/prior-review sources" in intro_prompt
    assert "[4]" in intro_prompt and "[5]" in intro_prompt
    assert "Section citation requirements" in methods_prompt
    assert "Methods: cite reporting standards and methods sources" in methods_prompt
    assert "[2]" in methods_prompt and "[3]" in methods_prompt and "[6]" in methods_prompt


def test_writing_agent_chinese_prompt_localizes_section_citation_requirements(monkeypatch) -> None:
    writer = WritingAgent(lang="zh")
    writer._background_citation_context = (
        "- [4] guideline: Heart failure guideline\n"
        "- [5] prior review: Prior systematic review"
    )
    captured: list[str] = []

    def fake_llm(prompt, *args, **kwargs):
        captured.append(prompt)
        return "section text"

    monkeypatch.setattr(writer, "call_llm", fake_llm)

    writer._write_introduction(_protocol())

    assert "## 章节引用要求" in captured[0]
    assert "引言：至少引用2条背景、指南或既往综述来源" in captured[0]
    assert "Section citation requirements" not in captured[0]


def test_publication_inline_citation_backfill_handles_chinese_sections() -> None:
    manuscript = """
## 引言

这是引言段落。

## 方法

这是方法段落。

## 结果

这是结果段落。

## 讨论

这是讨论段落。

## 参考文献

[1] Example reference.

[2] Another reference.
"""

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    assert "这是引言段落［1，2］。" in updated
    assert "这是方法段落［1，2］。" in updated
    assert "这是结果段落［1，2］。" in updated
    assert "这是讨论段落［1，2］。" in updated


def test_publication_inline_citation_backfill_uses_section_specific_reference_subsets() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Introduction\nBackground rationale needs sources.",
        "## Methods\nMethods need reporting and statistical sources.",
        "## Results\nResults need trial sources.",
        "## Discussion\nDiscussion needs comparison and certainty sources.",
        "## References",
        "[1] Smith J. Randomized trial report.",
        "[2] Page MJ. The PRISMA 2020 statement.",
        "[3] Rethlefsen ML. PRISMA-S literature search extension.",
        "[4] Higgins JPT. Cochrane Handbook for Systematic Reviews of Interventions.",
        "[5] Guyatt GH. GRADE guidelines.",
        "[6] DerSimonian R, Laird N. Meta-analysis in clinical trials.",
        "[7] Egger M. Bias in meta-analysis detected by a simple graphical test.",
        "[8] WHO REACT Working Group. Prospective meta-analysis of corticosteroids in COVID-19.",
        "[9] Surviving Sepsis Campaign guideline for COVID-19.",
        "[10] Prior systematic review of corticosteroids in ARDS.",
        "[11] Jones J. Randomized clinical trial.",
        "[12] ClinicalTrials.gov registry record.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    assert "[1-12]" not in updated
    methods = updated.split("## Methods", 1)[1].split("## Results", 1)[0]
    introduction = updated.split("## Introduction", 1)[1].split("## Methods", 1)[0]
    results = updated.split("## Results", 1)[1].split("## Discussion", 1)[0]
    discussion = updated.split("## Discussion", 1)[1].split("## References", 1)[0]
    assert "[2-7]" in methods
    assert "[8-10]" in introduction
    assert "[1,11,12]" in results
    assert "[5,7,8]" in discussion


def test_publication_inline_citation_backfill_adds_multiple_anchors_to_long_sections() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Introduction",
        "Background paragraph one needs current context.",
        "Background paragraph two explains disease burden.",
        "Background paragraph three explains prior evidence.",
        "Background paragraph four explains why this review matters.",
        "## Methods",
        "Reporting methods paragraph needs reporting guidance.",
        "Certainty methods paragraph needs certainty guidance.",
        "## Results",
        "Results need trial sources.",
        "## Discussion",
        "Discussion paragraph one compares with guidance.",
        "Discussion paragraph two interprets certainty.",
        "Discussion paragraph three frames research implications.",
        "Discussion paragraph four notes limitations.",
        "## References",
        "[1] Smith J. Randomized trial report.",
        "[2] Page MJ. The PRISMA 2020 statement.",
        "[3] Guyatt GH. GRADE guidelines.",
        "[4] Heart failure clinical guideline.",
        "[5] Prior systematic review.",
        "[6] Network meta-analysis of SGLT2 inhibitors.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    introduction = updated.split("## Introduction", 1)[1].split("## Methods", 1)[0]
    methods = updated.split("## Methods", 1)[1].split("## Results", 1)[0]
    discussion = updated.split("## Discussion", 1)[1].split("## References", 1)[0]
    assert introduction.count("[4-6]") == 1
    assert "[4,5]" in introduction
    assert "[4,6]" in introduction
    assert methods.count("[2,3]") == 2
    assert discussion.count("[3-5]") == 1
    assert "[3,4]" in discussion
    assert "[3,5]" in discussion


def test_publication_inline_citation_backfill_meets_interpretive_paragraph_coverage(tmp_path) -> None:
    intro_paragraphs = [
        " ".join([f"Background paragraph {index} explains clinical context and prior uncertainty"] * 5)
        for index in range(1, 7)
    ]
    discussion_paragraphs = [
        " ".join([f"Discussion paragraph {index} interprets applicability and certainty limits"] * 5)
        for index in range(1, 7)
    ]
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Introduction",
        *intro_paragraphs,
        "## Methods",
        "Reporting methods paragraph needs reporting guidance.",
        "Certainty methods paragraph needs certainty guidance.",
        "## Results",
        "Results need trial sources.",
        "## Discussion",
        *discussion_paragraphs,
        "## References",
        "[1] Smith J. Randomized trial report.",
        "[2] Jones J. Randomized clinical trial.",
        "[3] Page MJ. The PRISMA 2020 statement.",
        "[4] Guyatt GH. GRADE guidelines.",
        "[5] Heart failure clinical guideline.",
        "[6] Prior systematic review.",
        "[7] Network meta-analysis of SGLT2 inhibitors.",
        "[8] Scientific statement on heart failure management.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)
    project = Project("paragraph-coverage-backfill", output_dir=tmp_path / uuid4().hex)
    project.save_text("draft.md", updated, subdir="manuscript")
    audit = _build_citation_audit_review(project)

    codes = {issue["code"] for issue in audit["issues"]}
    assert audit["summary"]["introduction_substantial_paragraphs"] == 6
    assert audit["summary"]["discussion_substantial_paragraphs"] == 6
    assert audit["summary"]["introduction_cited_paragraph_rate"] >= 0.67
    assert audit["summary"]["discussion_cited_paragraph_rate"] >= 0.67
    assert "introduction_paragraph_citation_coverage_low" not in codes
    assert "discussion_paragraph_citation_coverage_low" not in codes


def test_publication_inline_citation_backfill_lifts_formal_draft_citation_density(tmp_path) -> None:
    paragraph = " ".join(["evidence sentence"] * 350)
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Introduction",
        paragraph,
        paragraph,
        paragraph,
        "## Methods",
        paragraph,
        paragraph,
        "## Results",
        paragraph,
        paragraph,
        "## Discussion",
        paragraph,
        paragraph,
        paragraph,
        "## References",
        "[1] Smith J. Randomized trial report.",
        "[2] Jones J. Randomized clinical trial.",
        "[3] Background reference.",
        "[4] Background reference.",
        "[5] Background reference.",
        "[6] Background reference.",
        "[7] Background reference.",
        "[8] Background reference.",
        "[9] Background reference.",
        "[10] Background reference.",
        "[11] Background reference.",
        "[12] Background reference.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)
    project = Project("citation-density-backfill", output_dir=tmp_path / uuid4().hex)
    project.save_text("draft.md", updated, subdir="manuscript")
    audit = _build_citation_audit_review(project)

    codes = {issue["code"] for issue in audit["issues"]}
    assert "low_citation_density" not in codes
    assert audit["summary"]["citation_density_per_1000_words"] >= 6.0
    assert audit["summary"]["main_text_inline_citations"] >= 12
    assert updated.count("[") < 40


def test_publication_inline_citation_backfill_recognizes_meta_analysis_and_recommendation_titles() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Introduction\nBackground rationale needs current evidence and recommendations.",
        "## Methods\nMethods need reporting and certainty sources.",
        "## Results\nResults need trial sources.",
        "## Discussion\nDiscussion needs comparison with guidance and prior evidence.",
        "## References",
        "[1] Smith J. Randomized trial report.",
        "[2] Jones J. Randomized clinical trial.",
        "[3] Lee A. Network meta-analysis of SGLT2 inhibitors in heart failure.",
        "[4] Example Society. Focused update and recommendations for heart failure management.",
        "[5] Guyatt GH. GRADE guidelines.",
        "[6] Page MJ. The PRISMA 2020 statement.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    introduction = updated.split("## Introduction", 1)[1].split("## Methods", 1)[0]
    methods = updated.split("## Methods", 1)[1].split("## Results", 1)[0]
    results = updated.split("## Results", 1)[1].split("## Discussion", 1)[0]
    discussion = updated.split("## Discussion", 1)[1].split("## References", 1)[0]
    assert "[1-4]" not in introduction
    assert "[3,4]" in introduction
    assert "[5,6]" in methods
    assert "[1,2]" in results
    assert "[3-5]" in discussion


def test_publication_inline_citation_backfill_supplements_wrong_source_type_citations() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Introduction\nBackground rationale currently cites only the trial report [1].",
        "## Methods\nMethods currently cite only the trial report [1].",
        "## Results\nResults cite the trial report [1].",
        "## Discussion\nDiscussion currently cites only the trial report [1].",
        "## References",
        "[1] Smith J. Randomized trial report.",
        "[2] Page MJ. The PRISMA 2020 statement.",
        "[3] Rethlefsen ML. PRISMA-S literature search extension.",
        "[4] Higgins JPT. Cochrane Handbook for Systematic Reviews of Interventions.",
        "[5] Guyatt GH. GRADE guidelines.",
        "[6] DerSimonian R, Laird N. Meta-analysis in clinical trials.",
        "[7] Egger M. Bias in meta-analysis detected by a simple graphical test.",
        "[8] WHO REACT Working Group. Prospective meta-analysis of corticosteroids in COVID-19.",
        "[9] Surviving Sepsis Campaign guideline for COVID-19.",
        "[10] Prior systematic review of corticosteroids in ARDS.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    introduction = updated.split("## Introduction", 1)[1].split("## Methods", 1)[0]
    methods = updated.split("## Methods", 1)[1].split("## Results", 1)[0]
    discussion = updated.split("## Discussion", 1)[1].split("## References", 1)[0]
    references = updated.split("## References", 1)[1]
    assert "trial report [1,8-10]." in introduction
    assert "trial report [1] [2-7]." in methods
    assert "trial report [1,5,7,8]." in discussion
    assert references.count("[1] Smith") == 1


def test_publication_inline_citation_backfill_supplements_low_contextual_depth(tmp_path) -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Introduction\nBackground rationale already cites one guideline [4].",
        "## Methods\nMethods already cite PRISMA [2].",
        "## Results\nResults cite the trial report [1].",
        "## Discussion\nDiscussion already cites clinical guidance [4].",
        "## References",
        "[1] Smith J. Randomized trial report.",
        "[2] Page MJ. The PRISMA 2020 statement.",
        "[3] Higgins JPT. Cochrane Handbook for Systematic Reviews of Interventions.",
        "[4] Heart failure clinical guideline.",
        "[5] Prior systematic review of SGLT2 inhibitors.",
        "[6] Guyatt GH. GRADE guidelines.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    introduction = updated.split("## Introduction", 1)[1].split("## Methods", 1)[0]
    methods = updated.split("## Methods", 1)[1].split("## Results", 1)[0]
    discussion = updated.split("## Discussion", 1)[1].split("## References", 1)[0]
    assert set(WritingAgent._citation_numbers_from_text(introduction)) >= {4, 5}
    assert set(WritingAgent._citation_numbers_from_text(methods)) >= {2, 3}
    assert set(WritingAgent._citation_numbers_from_text(discussion)) >= {4, 5}

    project = Project("context-depth-backfill", output_dir=tmp_path / uuid4().hex)
    project.save_text("draft.md", updated, subdir="manuscript")
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {"study_id": "methodology:prisma", "citation": "[2]", "source_type": "reporting_guideline"},
                {"study_id": "methodology:cochrane", "citation": "[3]", "source_type": "methods_handbook"},
                {"study_id": "methodology:grade", "citation": "[6]", "source_type": "certainty_framework"},
            ]
        },
        subdir="search",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {"study_id": "evidence:guideline", "citation": "[4]", "source_type": "guideline"},
                {"study_id": "evidence:review", "citation": "[5]", "source_type": "prior_review"},
            ]
        },
        subdir="search",
    )
    audit = _build_citation_audit_review(project)
    codes = {issue["code"] for issue in audit["issues"]}
    assert "introduction_background_citation_count_low" not in codes
    assert "methods_methodology_citation_count_low" not in codes
    assert "discussion_context_citation_count_low" not in codes


def test_publication_inline_citation_backfill_supplements_chinese_full_width_source_citations() -> None:
    manuscript = "\n\n".join([
        "# 中文稿件",
        "## 引言\n背景论述目前只引用了试验报告［1］。",
        "## 方法\n方法描述目前只引用了试验报告［1］。",
        "## 结果\n结果部分引用试验报告［1］。",
        "## 讨论\n讨论目前只引用了试验报告［1］。",
        "## 参考文献",
        "[1] Smith J. Randomized trial report.",
        "[2] Page MJ. The PRISMA 2020 statement.",
        "[3] Guyatt GH. GRADE guidelines.",
        "[4] Heart failure clinical guideline.",
        "[5] Prior systematic review.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    introduction = updated.split("## 引言", 1)[1].split("## 方法", 1)[0]
    methods = updated.split("## 方法", 1)[1].split("## 结果", 1)[0]
    discussion = updated.split("## 讨论", 1)[1].split("## 参考文献", 1)[0]
    assert "试验报告［1，4，5］。" in introduction
    assert "试验报告［1-3］。" in methods
    assert "试验报告［1，3-5］。" in discussion


def test_publication_inline_citation_backfill_does_not_duplicate_full_width_target_citations() -> None:
    manuscript = "\n\n".join([
        "# 中文稿件",
        "## 引言\n背景论述已经引用了指南［4］。",
        "## 方法\n方法描述已经引用了PRISMA［2］。",
        "## 结果\n结果部分引用试验报告［1］。",
        "## 讨论\n讨论已经引用了GRADE和指南［3，4］。",
        "## 参考文献",
        "[1] Smith J. Randomized trial report.",
        "[2] Page MJ. The PRISMA 2020 statement.",
        "[3] Guyatt GH. GRADE guidelines.",
        "[4] Heart failure clinical guideline.",
        "[5] Prior systematic review.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    introduction = updated.split("## 引言", 1)[1].split("## 方法", 1)[0]
    methods = updated.split("## 方法", 1)[1].split("## 结果", 1)[0]
    discussion = updated.split("## 讨论", 1)[1].split("## 参考文献", 1)[0]
    assert introduction.count("[4,5]") == 0
    assert methods.count("[2,3]") == 0
    assert discussion.count("[3-5]") == 0
    assert "指南［4，5］。" in introduction
    assert "PRISMA［2，3］。" in methods
    assert "GRADE和指南［3，4］。" in discussion


def test_publication_inline_citation_backfill_recognizes_bibliography_heading() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Introduction\nBackground rationale needs sources.",
        "## Methods\nMethods need reporting and statistical sources.",
        "## Results\nResults need trial sources.",
        "## Discussion\nDiscussion needs comparison and certainty sources.",
        "## Bibliography",
        "[1] Smith J. Randomized trial report.",
        "[2] Page MJ. The PRISMA 2020 statement.",
        "[3] Guyatt GH. GRADE guidelines.",
        "[4] Prior systematic review of the intervention.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    introduction = updated.split("## Introduction", 1)[1].split("## Methods", 1)[0]
    methods = updated.split("## Methods", 1)[1].split("## Results", 1)[0]
    results = updated.split("## Results", 1)[1].split("## Discussion", 1)[0]
    discussion = updated.split("## Discussion", 1)[1].split("## Bibliography", 1)[0]
    bibliography = updated.split("## Bibliography", 1)[1]

    assert "[4]" in introduction
    assert "[2,3]" in methods
    assert "[1]" in results
    assert "[3,4]" in discussion
    assert bibliography.count("[1] Smith") == 1


def test_publication_inline_citation_backfill_adds_conclusion_citations() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Introduction\nBackground rationale is supported by current guidance [4].",
        "## Methods\nMethods followed reporting and certainty guidance [2,3].",
        "## Results\nThe pooled HR was 0.81 [1].",
        "## Discussion\nThe findings were interpreted alongside prior evidence [4].",
        "## Conclusion\nSGLT2 inhibitors reduced heart failure hospitalization, with moderate-certainty evidence.",
        "## References",
        "[1] Smith J. Randomized trial report.",
        "[2] Page MJ. The PRISMA 2020 statement.",
        "[3] Guyatt GH. GRADE guidelines.",
        "[4] Heart failure clinical guideline.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    conclusion = updated.split("## Conclusion", 1)[1].split("## References", 1)[0]
    assert "moderate-certainty evidence [1,3]." in conclusion


def test_publication_inline_citation_backfill_reads_full_width_chinese_references() -> None:
    manuscript = "\n\n".join([
        "# 中文稿件",
        "## 引言\n背景论述需要来源。",
        "## 方法\n方法描述需要来源。",
        "## 结果\n结果部分描述研究结果。",
        "## 讨论\n讨论部分解释证据确定性。",
        "## 结论\n结论提示治疗可能降低住院风险。",
        "## 参考文献",
        "［1］ Smith J. Randomized trial report.",
        "［2］ Page MJ. The PRISMA 2020 statement.",
        "［3］ Guyatt GH. GRADE guidelines.",
        "［4］ Heart failure clinical guideline.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    introduction = updated.split("## 引言", 1)[1].split("## 方法", 1)[0]
    methods = updated.split("## 方法", 1)[1].split("## 结果", 1)[0]
    conclusion = updated.split("## 结论", 1)[1].split("## 参考文献", 1)[0]
    assert "背景论述需要来源［4］。" in introduction
    assert "方法描述需要来源［2，3］。" in methods
    assert "结论提示治疗可能降低住院风险［1，3］。" in conclusion


def test_chinese_publication_citation_style_normalization_preserves_search_query_code_block() -> None:
    manuscript = "\n".join([
        "# 中文稿件",
        "",
        "## 方法",
        "本研究遵循PRISMA报告规范 [16,19,20]。",
        "",
        "```text",
        '("HFpEF"[tiab] AND "SGLT2 inhibitor"[tiab])',
        "```",
        "",
        "## 结果",
        "合并HR为0.81 [1,2]。",
        "",
        "## 参考文献",
        "[1] Trial A.",
        "[2] Trial B.",
        "[16] PRISMA 2020.",
        "[19] RoB 2.",
        "[20] GRADE.",
    ])

    normalized = WritingAgent._normalize_citation_marker_style(manuscript, lang="zh")

    assert "[16,19,20]" not in normalized
    assert "[1,2]" not in normalized
    assert "［16，19，20］" in normalized
    assert "［1，2］" in normalized
    assert "［1］ Trial A." in normalized
    assert "## 参考文献\n［1］ Trial A." in normalized
    assert "## 参考文献［1］" not in normalized
    assert '"HFpEF"[tiab]' in normalized
    assert '"SGLT2 inhibitor"[tiab]' in normalized


def test_chinese_publication_citation_style_normalization_tightens_spacing_and_terminal_punctuation() -> None:
    manuscript = "\n".join([
        "# 中文稿件",
        "",
        "## 讨论",
        "本结果与既有证据方向相符 ［13-15］。",
        "",
        "当研究少于10项时，漏斗图不对称检验最多只能作为描述性信息 [23]",
        "",
        "## 参考文献",
        "[13] Review.",
        "[14] Guideline.",
        "[15] Trial.",
        "[23] Egger M. Bias in meta-analysis.",
    ])

    normalized = WritingAgent._normalize_citation_marker_style(manuscript, lang="zh")

    assert "相符 ［13-15］" not in normalized
    assert "相符［13-15］。" in normalized
    assert "描述性信息［23］。" in normalized


def test_publication_inline_citation_backfill_attaches_chinese_numeric_effect_claims_to_same_sentence() -> None:
    manuscript = "\n\n".join([
        "# 中文稿件",
        "## 引言\n背景论述已有指南依据［4］。",
        "## 方法\n方法描述已有报告规范和GRADE依据［2，3］。",
        "## 结果\n合并HR为0.81（95% CI 0.74–0.88）。该结果基于两项随机试验［1，2］。",
        "## 讨论\n结果需要结合证据确定性解释［3］。",
        "## 结论\nSGLT2抑制剂与心血管死亡或心力衰竭住院风险降低相关（HR 0.81，95% CI 0.74–0.88）。证据确定性较高［3］。",
        "## 参考文献",
        "［1］ Smith J. Randomized trial report.",
        "［2］ Jones J. Randomized clinical trial.",
        "［3］ Guyatt GH. GRADE guidelines.",
        "［4］ Heart failure clinical guideline.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    results = updated.split("## 结果", 1)[1].split("## 讨论", 1)[0]
    conclusion = updated.split("## 结论", 1)[1].split("## 参考文献", 1)[0]
    assert "合并HR为0.81（95% CI 0.74–0.88）［1，2］。" in results
    assert "风险降低相关（HR 0.81，95% CI 0.74–0.88）［1，2］。" in conclusion


def test_publication_inline_citation_backfill_supplements_wrong_source_type_on_numeric_effect_sentence() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Introduction\nBackground rationale is supported by current guidance [4].",
        "## Methods\nMethods followed reporting and certainty guidance [2,3].",
        "## Results\nThe pooled HR was 0.81 (95% CI 0.74 to 0.88) [3]. Certainty was assessed separately.",
        "## Discussion\nThe result was interpreted with certainty guidance [3].",
        "## References",
        "[1] Smith J. Randomized trial report.",
        "[2] Page MJ. The PRISMA 2020 statement.",
        "[3] Guyatt GH. GRADE guidelines.",
        "[4] Heart failure clinical guideline.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    results = updated.split("## Results", 1)[1].split("## Discussion", 1)[0]
    assert "The pooled HR was 0.81 (95% CI 0.74 to 0.88) [1,3]. Certainty was assessed separately." in results
    assert "Certainty was assessed separately [1]." not in results


def test_publication_inline_citation_backfill_recognizes_real_sglt2_trial_titles_for_numeric_effects() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Introduction\nHeart failure with preserved ejection fraction remains clinically important [4].",
        "## Methods\nMethods followed reporting and certainty guidance [3,4].",
        "## Results\nThe pooled HR was 0.81 (95% CI 0.75 to 0.88) [3].",
        "## Discussion\nThe result was interpreted with certainty guidance [3].",
        "## References",
        "[1] Solomon SD, McMurray JJV, Claggett B, et al. Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction. N Engl J Med. 2022;387:1089-1098.",
        "[2] Anker SD, Butler J, Filippatos G, et al. Empagliflozin in Heart Failure with a Preserved Ejection Fraction. N Engl J Med. 2021;385:1451-1461.",
        "[3] Guyatt GH. GRADE guidelines.",
        "[4] Page MJ. The PRISMA 2020 statement.",
    ])

    updated = WritingAgent._backfill_publication_inline_citations(manuscript)

    results = updated.split("## Results", 1)[1].split("## Discussion", 1)[0]
    assert "The pooled HR was 0.81 (95% CI 0.75 to 0.88) [1-3]." in results


def test_covid_contextual_citation_repair_keeps_who_react_and_source_claims_grounded() -> None:
    manuscript = "\n\n".join([
        "# Manuscript",
        "## Introduction",
        "The WHO REACT prospective meta-analysis provided a major published synthesis of this trial set [1-3,13]. "
        "The present analysis links the mortality values used for pooling to primary trial reports, trial registries, or living-data records [17,18].",
        "This systematic review and meta-analysis therefore asks whether systemic corticosteroids, compared with usual care or placebo, reduce all-cause mortality at 28 days or the closest compatible short-term mortality window in critically ill adults with COVID-19 [13,17,19].",
        "## Discussion",
        "The pooled estimate was concordant with the published WHO REACT prospective meta-analysis for critically ill COVID-19 patients treated with systemic corticosteroids [1-3,13].",
        "## References",
        "[1] Horby P. Dexamethasone in Hospitalized Patients with Covid-19.",
        "[2] Tomazini BM. CoDEX randomized clinical trial.",
        "[3] Angus DC. REMAP-CAP randomized clinical trial.",
        "[13] WHO REACT Working Group. Association Between Administration of Systemic Corticosteroids and Mortality Among Critically Ill Patients With COVID-19: A Meta-analysis.",
        "[17] Chaudhuri D. Corticosteroids in COVID-19 and non-COVID-19 ARDS.",
        "[18] Fernandes M. COVID-19, corticosteroids and public health.",
        "[19] Ferreto L. Dexamethasone for treating SARS-CoV-2 infection.",
    ])

    updated = WritingAgent._repair_covid_contextual_citation_attribution(manuscript)

    assert "WHO REACT prospective meta-analysis provided a major published synthesis of this trial set[13]" in updated
    assert "WHO REACT prospective meta-analysis for critically ill COVID-19 patients treated with systemic corticosteroids[13]" in updated
    assert "living-data records [17,18]" not in updated
    assert "critical COVID-19 [13,17,19]" not in updated


def test_polish_manuscript_accepts_conservative_bilingual_rewrite_and_saves_audit() -> None:
    manuscript = (
        "# Title\n\n"
        "## Introduction\n\n"
        "It is important to note that the pooled OR was 0.66 (95% CI 0.53 to 0.82) [1].\n\n"
        "## 讨论\n\n"
        "值得注意的是，该结果需要结合临床背景解释 [1]。\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("It is important to note that ", "").replace("值得注意的是，", "")

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)

    assert "\n## Introduction\n\n" in polished
    assert "\n## 讨论\n\n" in polished
    assert "## Introductionthe" not in polished
    assert "The pooled OR was 0.66 (95% CI 0.53 to 0.82) [1]." in polished
    assert "该结果需要结合临床背景解释 [1]。" in polished
    assert report["accepted_sections"] == 2
    assert report["rejected_sections"] == 0
    assert report["accepted_edit_count"] == 2
    assert len(report["accepted_edits"]) == 2
    assert report["accepted_edits"][0]["heading"] == "Introduction"
    assert "It is important to note" in report["accepted_edits"][0]["original_text"]
    assert "It is important to note" not in report["accepted_edits"][0]["candidate_text"]
    assert "-It is important to note" in report["accepted_edits"][0]["diff"]
    assert audit_manuscript_style(manuscript)["language"] == "mixed"


def test_polish_guard_allows_acronyms_adjacent_to_chinese_text() -> None:
    import new_meta.core.manuscript_polish as polish_module

    original = "SGLT2 inhibitors降低心衰风险。HR 0.81（95% CI 0.74至0.88）[1]。"
    candidate = "SGLT2抑制剂降低心衰风险。HR 0.81（95% CI 0.74至0.88）[1]。"

    issues = polish_module._preservation_issues(original, candidate, "摘要")

    assert not any(issue["code"] == "protected_terms_changed" for issue in issues)


def test_polish_manuscript_strips_llm_section_label_before_fact_guard() -> None:
    manuscript = (
        "# 标题\n\n"
        "## 讨论\n\n"
        "值得注意的是，SGLT2抑制剂降低心衰风险。HR 0.81（95% CI 0.74至0.88）[1]。\n\n"
        "## 参考文献\n\n"
        "[1] 示例参考文献。\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return f"SECTION: {meta['heading']}\n\n{section_text}"

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=rewrite,
        enabled=True,
        max_rewrite_chars=120,
    )

    assert "SECTION:" not in polished
    assert "SGLT2抑制剂降低心衰风险" in polished
    assert report["accepted_chunks"] == 1
    assert report["rejected_chunks"] == 0
    assert not any(issue["code"] == "protected_terms_changed" for issue in report["issues"])


def test_polish_guard_does_not_treat_chinese_confidence_phrasing_as_clinical_direction() -> None:
    import new_meta.core.manuscript_polish as polish_module

    original = (
        "与锚点一致可提高对检索、提取和合并流程的信心；"
        "SGLT2抑制剂降低心衰住院风险。"
    )
    candidate = (
        "与锚点一致有助于增强对检索、提取和合并流程的信心；"
        "SGLT2抑制剂降低心衰住院风险。"
    )

    issues = polish_module._preservation_issues(original, candidate, "讨论")

    assert not any(issue["code"] == "directional_terms_changed" for issue in issues)


def test_polish_manuscript_does_not_record_accepted_edits_for_rejected_section(monkeypatch) -> None:
    import new_meta.core.manuscript_polish as polish_module

    manuscript = (
        "# Title\n\n"
        "## Introduction\n\n"
        "It is important to note that the pooled OR was 0.66 (95% CI 0.53 to 0.82) [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    calls = {"count": 0}

    def section_guard_rejects_after_chunk_acceptance(original: str, candidate: str, heading: str) -> list[dict]:
        calls["count"] += 1
        if calls["count"] == 1:
            return []
        return [{
            "code": "section_level_guard_rejection",
            "heading": heading,
            "message": "Section-level guard rejected the assembled rewrite.",
        }]

    monkeypatch.setattr(polish_module, "_preservation_issues", section_guard_rejects_after_chunk_acceptance)

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("It is important to note that ", "")

    polished, report = polish_module.polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)

    assert polished == manuscript
    assert report["rejected_sections"] == 1
    assert report["accepted_sections"] == 0
    assert report["accepted_chunks"] == 0
    assert report["accepted_edit_count"] == 0
    assert report["accepted_edits"] == []
    assert report["issues"][0]["code"] == "section_level_guard_rejection"


def test_polish_manuscript_splits_long_sections_into_paragraph_rewrites() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "It is important to note that the pooled OR was 0.66 (95% CI 0.53 to 0.82) [1].\n\n"
        "It is important to note that this certainty statement should remain linked to GRADE [2].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
        "[2] GRADE reference.\n"
    )
    calls: list[str] = []

    def rewrite(section_text: str, meta: dict) -> str:
        calls.append(section_text)
        return section_text.replace("It is important to note that ", "")

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=rewrite,
        enabled=True,
        max_rewrite_chars=90,
    )

    assert len(calls) == 2
    assert all(len(call) <= 90 for call in calls)
    assert "The pooled OR was 0.66 (95% CI 0.53 to 0.82) [1]." in polished
    assert "This certainty statement should remain linked to GRADE [2]." in polished
    assert report["accepted_sections"] == 1
    assert report["accepted_chunks"] == 2


def test_polish_manuscript_respects_rewrite_chunk_budget_and_records_skips() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "It is important to note that paragraph one reports OR 0.66 [1].\n\n"
        "It is important to note that paragraph two reports HR 0.81 [1].\n\n"
        "It is important to note that paragraph three reports RR 0.73 [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )
    calls: list[str] = []

    def rewrite(section_text: str, meta: dict) -> str:
        calls.append(section_text)
        return section_text.replace("It is important to note that ", "")

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=rewrite,
        enabled=True,
        max_rewrite_chars=80,
        max_rewrite_chunks=2,
    )

    assert len(calls) == 2
    assert "Paragraph one reports OR 0.66 [1]." in polished
    assert "Paragraph two reports HR 0.81 [1]." in polished
    assert "Paragraph three reports RR 0.73 [1]." in polished
    assert "It is important to note that" not in polished
    assert report["accepted_chunks"] == 2
    assert report["skipped_chunks"] == 1
    assert report["attempted_chunks"] == 2
    assert report["total_rewrite_chunks"] == 3
    assert report["polish_budget_exhausted"] is True
    budget_issue = next(issue for issue in report["issues"] if issue["code"] == "polish_budget_exhausted")
    assert budget_issue["skipped_chunks"] == 1
    assert budget_issue["skipped_chunk_details"][0]["heading"] == "Discussion"
    assert budget_issue["skipped_chunk_details"][0]["chunk_index"] == 2
    assert budget_issue["review_action"] == "rerun_with_higher_polish_budget"
    assert report["skipped_chunk_details"][0]["reason"] == "polish_budget_exhausted"
    assert report["skipped_chunk_details"][0]["deterministic_cleanup_applied"] is True
    assert "Paragraph three reports RR 0.73" in report["skipped_chunk_details"][0]["kept_text"]


def test_polish_manuscript_retries_rejected_candidate_with_guard_feedback() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "It is important to note that the pooled OR was 0.66 (95% CI 0.53 to 0.82) [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )
    calls: list[dict] = []

    def rewrite(section_text: str, meta: dict) -> str:
        calls.append(dict(meta))
        if not meta.get("retry_after_preservation_rejection"):
            return section_text.replace("0.66", "0.68")
        assert "numeric_tokens_changed" in meta["preservation_issue_codes"]
        assert "0.68" in meta["rejected_candidate_excerpt"]
        return section_text

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=rewrite,
        enabled=True,
        max_rewrite_chars=120,
    )

    assert len(calls) == 2
    assert calls[1]["retry_after_preservation_rejection"] is True
    assert "It is important to note that" not in polished
    assert "The pooled OR was 0.66 (95% CI 0.53 to 0.82) [1]." in polished
    assert "0.68" not in polished
    assert report["accepted_chunks"] == 1
    assert report["rejected_chunks"] == 0
    assert report["rewrite_retries"] == 1
    assert report["retry_recovered_chunks"] == 1
    assert report["issues"] == []


def test_targeted_polish_does_not_spend_llm_budget_on_clean_chunks() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The analysis shows the endpoint was source verified [1]. "
        "The analysis shows the endpoint used the prespecified HR [1]. "
        "The analysis shows the endpoint retained the original CI [1].\n\n"
        "The evidence table links every selected value to the source quote. "
        "Clinical interpretation remains tied to the prespecified comparator and model.\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )
    calls: list[str] = []

    def rewrite(section_text: str, meta: dict) -> str:
        calls.append(section_text)
        return (
            "The endpoint was source verified [1]. "
            "The prespecified HR was retained [1]. "
            "The original CI remained attached to the endpoint [1]."
        )

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=rewrite,
        enabled=True,
        max_rewrite_chars=240,
        max_rewrite_chunks=1,
        rewrite_scope="targeted",
    )

    assert len(calls) == 1
    assert "The endpoint was source verified [1]." in polished
    assert "The evidence table links every selected value to the source quote." in polished
    assert report["rewrite_scope"] == "targeted"
    assert report["attempted_chunks"] == 1
    assert report["targeted_chunks"] == 1
    assert report["non_target_chunks"] == 1
    assert report["total_rewrite_chunks"] == 1
    assert report["skipped_chunks"] == 0
    assert report["polish_budget_exhausted"] is False
    assert not any(issue["code"] == "polish_budget_exhausted" for issue in report["issues"])


def test_targeted_polish_records_deterministic_cleanup_edits_without_llm_calls() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "It is important to note that paragraph one reports OR 0.66 [1].\n\n"
        "值得注意的是，第二段报告HR 0.81［1］。\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )
    calls: list[str] = []

    def rewrite(section_text: str, meta: dict) -> str:
        calls.append(section_text)
        return section_text

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=rewrite,
        enabled=True,
        max_rewrite_chars=120,
        max_rewrite_chunks=6,
        rewrite_scope="targeted",
    )

    assert calls == []
    assert "It is important to note that" not in polished
    assert "值得注意的是" not in polished
    assert "Paragraph one reports OR 0.66 [1]." in polished
    assert "第二段报告HR 0.81［1］。" in polished
    assert report["accepted_chunks"] == 0
    assert report["attempted_chunks"] == 0
    assert report["accepted_edit_count"] == 1
    assert all(edit["edit_source"] == "deterministic_cleanup" for edit in report["accepted_edits"])
    assert "It is important to note" in report["accepted_edits"][0]["original_text"]
    assert "It is important to note" not in report["accepted_edits"][0]["candidate_text"]
    assert "值得注意的是" in report["accepted_edits"][0]["original_text"]
    assert "值得注意的是" not in report["accepted_edits"][0]["candidate_text"]


def test_polish_manuscript_applies_deterministic_cleanup_to_skipped_chunks() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "It is important to note that paragraph one reports OR 0.66 [1].\n\n"
        "It is important to note that paragraph two reports HR 0.81 [1].\n\n"
        "值得注意的是，第三段报告RR 0.73［1］。\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )
    calls: list[str] = []

    def rewrite(section_text: str, meta: dict) -> str:
        calls.append(section_text)
        return section_text

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=rewrite,
        enabled=True,
        max_rewrite_chars=80,
        max_rewrite_chunks=1,
    )

    assert len(calls) == 1
    assert report["attempted_chunks"] == 1
    assert report["skipped_chunks"] == 2
    assert "It is important to note that" not in polished
    assert "值得注意的是" not in polished
    assert "Paragraph one reports OR 0.66 [1]." in polished
    assert "Paragraph two reports HR 0.81 [1]." in polished
    assert "第三段报告RR 0.73［1］。" in polished


def test_polish_retry_attempts_do_not_consume_global_chunk_budget() -> None:
    manuscript = (
        "# Title\n\n"
        "## Introduction\n\n"
        "The pooled HR was 0.81 [1].\n\n"
        "## Discussion\n\n"
        "The result should be interpreted with baseline risk [1].\n\n"
        "## References\n\n"
        "[1] Trial report.\n"
    )
    calls: list[str] = []

    def rewrite(section_text: str, meta: dict) -> str:
        calls.append(str(meta.get("heading") or ""))
        if str(meta.get("heading") or "") == "Introduction":
            return "The pooled HR was 0.82."
        return section_text

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=rewrite,
        enabled=True,
        max_rewrite_chars=1000,
        max_rewrite_chunks=2,
        rewrite_scope="all",
    )

    assert "Discussion" in calls
    assert report["skipped_chunks"] == 0
    assert report["polish_budget_exhausted"] is False
    assert "The result should be interpreted with baseline risk [1]." in polished


def test_polish_manuscript_capitalizes_sentence_after_deterministic_cleanup() -> None:
    manuscript = (
        "# Title\n\n"
        "## Conclusion\n\n"
        "It is important to note that the conclusion keeps RR 0.73 [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=lambda section_text, meta: section_text,
        enabled=True,
        max_rewrite_chars=80,
        max_rewrite_chunks=0,
    )

    assert "The conclusion keeps RR 0.73 [1]." in polished
    assert "the conclusion keeps RR 0.73 [1]." not in polished
    assert report["polish_budget_exhausted"] is True


def test_polish_manuscript_removes_in_conclusion_template_phrase() -> None:
    manuscript = (
        "# Title\n\n"
        "## Conclusion\n\n"
        "In conclusion, the pooled HR was 0.81 (95% CI 0.74 to 0.88) [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=lambda section_text, meta: section_text,
        enabled=True,
        max_rewrite_chars=80,
        max_rewrite_chunks=0,
    )

    assert "In conclusion" not in polished
    assert "The pooled HR was 0.81 (95% CI 0.74 to 0.88) [1]." in polished
    assert report["polish_budget_exhausted"] is True


def test_polish_manuscript_removes_additional_chinese_template_phrases_without_llm_budget() -> None:
    manuscript = (
        "# 中文Meta分析稿件\n\n"
        "## 讨论\n\n"
        "总体而言，主要结局维持HR 0.81（95% CI 0.74至0.88）［1］。"
        "需要指出的是，证据确定性仍需结合GRADE解释［2］。\n\n"
        "## 参考文献\n\n"
        "［1］ Trial report.\n"
        "［2］ GRADE guidance.\n"
    )
    before = audit_manuscript_style(manuscript)

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=lambda section_text, meta: section_text,
        enabled=True,
        max_rewrite_chars=120,
        max_rewrite_chunks=0,
    )

    assert {"总体而言", "需要指出的是"} <= set(before["template_phrase_hits"])
    assert "总体而言" not in polished
    assert "需要指出的是" not in polished
    assert "主要结局维持HR 0.81（95% CI 0.74至0.88）［1］。" in polished
    assert "证据确定性仍需结合GRADE解释［2］。" in polished
    assert report["polish_budget_exhausted"] is True


def test_polish_manuscript_removes_more_common_chinese_filler_openings_without_llm_budget() -> None:
    manuscript = (
        "# 中文Meta分析稿件\n\n"
        "## 讨论\n\n"
        "总的来看，主要复合结局仍按预设HR报告［1］。"
        "需要说明的是，GRADE判断没有改变［2］。"
        "从整体来看，安全性结局需要单独解释［1］。\n\n"
        "## 参考文献\n\n"
        "［1］ Trial report.\n"
        "［2］ GRADE guidance.\n"
    )
    before = audit_manuscript_style(manuscript)

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=lambda section_text, meta: section_text,
        enabled=True,
        max_rewrite_chars=120,
        max_rewrite_chunks=0,
    )

    assert {"总的来看", "需要说明的是", "从整体来看"} <= set(before["template_phrase_hits"])
    assert "总的来看" not in polished
    assert "需要说明的是" not in polished
    assert "从整体来看" not in polished
    assert "主要复合结局仍按预设HR报告［1］。" in polished
    assert "GRADE判断没有改变［2］。" in polished
    assert "安全性结局需要单独解释［1］。" in polished
    assert report["polish_budget_exhausted"] is True


def test_polish_manuscript_varies_known_repeated_method_openings_without_llm_budget() -> None:
    manuscript = (
        "# Title\n\n"
        "## Methods\n\n"
        "When the selected endpoint was time-to-event, the reported hazard ratio was kept on its original scale [1].\n\n"
        "When the selected endpoint was binary, the arm-level counts were used to derive the study-level log effect [1].\n\n"
        "The manuscript therefore reports the effect measure exactly as selected for the primary analysis [1].\n\n"
        "The manuscript therefore reports the certainty profile as a companion to the statistical result [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=lambda section_text, meta: section_text,
        enabled=True,
        max_rewrite_chars=120,
        max_rewrite_chunks=0,
    )
    audit = audit_manuscript_style(polished)

    assert "For time-to-event endpoints, the reported hazard ratio was kept on its original scale [1]." in polished
    assert "For binary endpoints, the arm-level counts were used to derive the study-level log effect [1]." in polished
    assert "Accordingly, the manuscript reports the effect measure exactly as selected for the primary analysis [1]." in polished
    assert "The certainty profile is reported as a companion to the statistical result [1]." in polished
    assert "when the selected endpoint was" not in audit["repeated_sentence_openings"]
    assert "the manuscript therefore reports the" not in audit["repeated_sentence_openings"]
    assert report["polish_budget_exhausted"] is True


def test_publication_body_language_removes_manuscript_self_reference_without_rewriting_result() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The source reconciliation step affected presentation more than the final direction of effect. "
        "Some rows required registry or source-figure recovery, but the accepted selected rows still supplied "
        "the same four count fields needed for the odds-ratio calculation [1]. "
        "The manuscript therefore distinguishes between difficulty verifying a row and instability of the "
        "pooled estimate; these are related quality issues but not the same finding.\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    cleaned = WritingAgent._polish_publication_body_language(manuscript, compress_discussion=False)

    assert "The manuscript therefore" not in cleaned
    assert "the analysis therefore distinguishes" in cleaned.lower()
    assert "the same four count fields needed for the odds-ratio calculation [1]" in cleaned


def test_polish_manuscript_varies_known_chinese_repeated_openings_without_llm_budget() -> None:
    manuscript = (
        "# 中文Meta分析稿件\n\n"
        "## 引言\n\n"
        "对于心血管死亡或心力衰竭住院，单项试验常报告复合终点［1］。"
        "对于心血管死亡或心力衰竭住院这类临床复合终点，解释时还需要关注组成事件［1］。\n\n"
        "本研究在各章节统一报告研究数量、参与者总数、效应量和GRADE判断［1］。"
        "本研究在各章节统一报告这些字段，以减少跨章节不一致［1］。\n\n"
        "即使SGLT2抑制剂在总体合并结果中显示有利方向，仍需结合基线风险解释［1］。"
        "即使SGLT2抑制剂在主要复合结局上显示出有利方向，安全性仍需独立处理［1］。\n\n"
        "## 参考文献\n\n"
        "［1］ Trial report.\n"
    )

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=lambda section_text, meta: section_text,
        enabled=True,
        max_rewrite_chars=1200,
        max_rewrite_chunks=0,
    )
    audit = audit_manuscript_style(polished)
    issue_codes = {issue["code"] for issue in audit["ai_style_signal"]["issues"]}

    assert "repeated_sentence_starts" not in issue_codes
    assert "对于心血管死" not in audit["repeated_sentence_openings"]
    assert "本研究在各章" not in audit["repeated_sentence_openings"]
    assert "即使抑制剂在" not in audit["repeated_sentence_openings"]
    assert "［1］" in polished
    assert "SGLT2抑制剂" in polished
    assert report["polish_budget_exhausted"] is True


def test_polish_manuscript_batches_short_paragraphs_before_rewrite() -> None:
    paragraphs = [
        "It is important to note that paragraph one reports OR 0.66 [1].",
        "It is important to note that paragraph two reports HR 0.81 [1].",
        "It is important to note that paragraph three reports RR 0.73 [1].",
        "It is important to note that paragraph four reports MD -1.13 [1].",
    ]
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        + "\n\n".join(paragraphs)
        + "\n\n## References\n\n[1] Example reference.\n"
    )
    calls: list[str] = []

    def rewrite(section_text: str, meta: dict) -> str:
        calls.append(section_text)
        return section_text.replace("It is important to note that ", "")

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=rewrite,
        enabled=True,
        max_rewrite_chars=180,
    )

    assert len(calls) == 2
    assert report["attempted_chunks"] == 2
    assert report["total_rewrite_chunks"] == 2
    assert report["accepted_chunks"] == 2
    assert "Paragraph four reports MD -1.13 [1]." in polished


def test_polish_manuscript_keeps_fenced_code_blocks_out_of_rewrite_budget() -> None:
    manuscript = (
        "# Title\n\n"
        "## Methods\n\n"
        "### Search strategy\n\n"
        "```text\n"
        "((\"HFpEF\"[tiab] OR \"HFmrEF\"[tiab]) AND \"SGLT2 inhibitor\"[tiab])\n"
        "```\n\n"
        "It is important to note that screening decisions were stored separately from extraction [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )
    calls: list[str] = []

    def rewrite(section_text: str, meta: dict) -> str:
        calls.append(section_text)
        return section_text.replace("It is important to note that ", "")

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=rewrite,
        enabled=True,
        max_rewrite_chars=1200,
        max_rewrite_chunks=1,
    )

    assert len(calls) == 1
    assert "```text" not in calls[0]
    assert "(\"HFpEF\"[tiab] OR \"HFmrEF\"[tiab])" in polished
    assert "Screening decisions were stored separately from extraction [1]." in polished
    assert report["attempted_chunks"] == 1
    assert report["total_rewrite_chunks"] == 1
    assert report["polish_budget_exhausted"] is False


def test_polish_manuscript_collapses_budget_exhaustion_to_one_issue() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "It is important to note that paragraph one reports OR 0.66 [1].\n\n"
        "It is important to note that paragraph two reports HR 0.81 [1].\n\n"
        "## Conclusion\n\n"
        "It is important to note that the conclusion keeps RR 0.73 [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("It is important to note that ", "")

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=rewrite,
        enabled=True,
        max_rewrite_chars=80,
        max_rewrite_chunks=1,
    )

    budget_issues = [issue for issue in report["issues"] if issue["code"] == "polish_budget_exhausted"]
    assert len(budget_issues) == 1
    assert report["attempted_chunks"] == 1
    assert report["skipped_chunks"] >= 2
    assert budget_issues[0]["skipped_chunks"] == report["skipped_chunks"]
    assert "The conclusion keeps RR 0.73 [1]." in polished
    assert "It is important to note that" not in polished


def test_audit_manuscript_style_flags_ai_like_bilingual_patterns() -> None:
    english = (
        "It is important to note that the result was clinically relevant. "
        "It is important to note that the estimate remained uncertain. "
        "It is important to note that further studies are needed."
    )
    chinese = "值得注意的是，该结果需要谨慎解释。值得注意的是，证据质量仍然有限。值得注意的是，仍需要更多研究。"

    english_audit = audit_manuscript_style(english)
    chinese_audit = audit_manuscript_style(chinese)

    assert english_audit["ai_style_signal"]["score"] >= 3
    assert {
        item["code"] for item in english_audit["ai_style_signal"]["issues"]
    } >= {"template_phrase_hits", "repeated_sentence_starts", "low_sentence_length_variation"}
    assert chinese_audit["language"] == "zh"
    assert chinese_audit["ai_style_signal"]["score"] >= 2
    assert {
        item["code"] for item in chinese_audit["ai_style_signal"]["issues"]
    } >= {"template_phrase_hits", "repeated_sentence_starts"}


def test_audit_manuscript_style_detects_chinese_main_text_despite_english_references() -> None:
    manuscript = (
        "# 中文题目\n\n"
        "## 引言\n\n"
        "值得注意的是，该治疗策略仍需结合患者基线风险解释。"
        "值得注意的是，证据质量受到样本量限制。"
        "值得注意的是，未来研究应报告长期结局。\n\n"
        "## 参考文献\n\n"
        "[1] Smith J. Randomized clinical trial. New England Journal of Medicine. 2024.\n"
        "[2] Page MJ. The PRISMA 2020 statement. BMJ. 2021.\n"
    )

    audit = audit_manuscript_style(manuscript)

    assert audit["language"] == "zh"
    assert audit["cjk_chars"] > 0
    assert audit["latin_words"] > 0
    assert any(issue["code"] == "template_phrase_hits" for issue in audit["ai_style_signal"]["issues"])


def test_audit_manuscript_style_treats_zh_dominant_medical_acronyms_as_chinese() -> None:
    manuscript = (
        "# 中文Meta分析稿件\n\n"
        "## 引言\n\n"
        "HFmrEF/HFpEF患者需要评估SGLT2抑制剂。"
        "HR 0.81（95% CI 0.74至0.88）来自DELIVER和EMPEROR-Preserved。"
        "这些英文缩写是医学术语，不应让中文稿件被标记为 mixed。\n\n"
        "## 参考文献\n\n"
        "［1］ Trial report.\n"
    )

    polished, report = polish_manuscript_text(manuscript, enabled=False)
    audit = audit_manuscript_style(manuscript)

    assert polished == manuscript
    assert audit["language"] == "zh"
    assert report["language"] == "zh"
    assert report["style_policy"]["language"] == "zh"


def test_audit_manuscript_style_ignores_repeated_chinese_clinical_acronym_topic_openings() -> None:
    manuscript = (
        "# 中文Meta分析稿件\n\n"
        "## 摘要\n\n"
        "HFmrEF/HFpEF患者的治疗决策依赖于终点定义一致的随机证据。"
        "HFmrEF/HFpEF患者需要结合基线风险和随访时间解释相对效应。"
        "HFmrEF/HFpEF患者是否直接适用主要结果，仍取决于纳入试验的人群特征。"
        "The manuscript uses cardiovascular death, heart failure hospitalization, endpoint definition, randomized trial evidence, baseline therapy, placebo comparison, event adjudication, source verification, trial population, background therapy, follow-up duration, composite endpoint, main pooled estimate, source quote, evidence certainty, clinical applicability, subgroup consistency, outcome hierarchy, methods transparency, protocol alignment, extraction audit, and reference context as technical labels.\n\n"
        "## 引言\n\n"
        "SGLT2抑制剂在多个随机试验中用于评价心力衰竭结局。"
        "SGLT2抑制剂相关证据需要保留研究身份、终点定义和来源摘录。\n\n"
        "## 参考文献\n\n"
        "［1］ Trial report.\n"
    )

    audit = audit_manuscript_style(manuscript)
    issue_codes = {issue["code"] for issue in audit["ai_style_signal"]["issues"]}

    assert audit["language"] == "mixed"
    assert "repeated_sentence_starts" not in issue_codes
    assert "hfmref" not in audit["repeated_sentence_openings"]
    assert "sglt" not in audit["repeated_sentence_openings"]


def test_audit_manuscript_style_ignores_template_phrases_in_references() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The pooled estimate was clinically interpreted alongside certainty of evidence. "
        "The direction of effect was consistent across the main trial reports.\n\n"
        "## References\n\n"
        "[1] Smith J. In conclusion, trial reporting improved over time. BMJ. 2024.\n"
    )

    audit = audit_manuscript_style(manuscript)

    assert audit["language"] == "en"
    assert audit["template_phrase_hits"] == {}
    assert "template_phrase_hits" not in {
        issue["code"] for issue in audit["ai_style_signal"]["issues"]
    }


def test_audit_manuscript_style_does_not_count_template_substrings() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The relevant question is whether the remaining evidence becomes clinically incompatible "
        "with the main conclusion when that study is omitted.\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    audit = audit_manuscript_style(manuscript)

    assert audit["template_phrase_hits"] == {}
    assert "template_phrase_hits" not in {
        issue["code"] for issue in audit["ai_style_signal"]["issues"]
    }


def test_audit_manuscript_style_ignores_tables_and_figure_sections() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The pooled estimate was interpreted alongside source verification and certainty assessment. "
        "Clinical interpretation remained anchored to the prespecified endpoint.\n\n"
        "## Tables\n\n"
        "| Metric | Value |\n"
        "| --- | --- |\n"
        "| CI | 0.74 to 0.88 |\n"
        "| CI | 0.70 to 0.90 |\n\n"
        "## Figures\n\n"
        "Figure 1. Forest plot for the primary outcome.\n"
        "Figure 2. Funnel plot for the primary outcome.\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    audit = audit_manuscript_style(manuscript)
    issue_codes = {issue["code"] for issue in audit["ai_style_signal"]["issues"]}

    assert "repeated_sentence_starts" not in issue_codes
    assert "ci" not in audit["repeated_sentence_openings"]
    assert "figure" not in audit["repeated_sentence_openings"]


def test_audit_manuscript_style_does_not_split_decimal_statistics_as_sentences() -> None:
    manuscript = (
        "# Title\n\n"
        "## Results\n\n"
        "The pooled HR was 0.81 (95% CI 0.74 to 0.88), with p<0.001. "
        "Heterogeneity was low (I²=0.0%, Cochran Q=0.17, p=0.678).\n\n"
        "## Discussion\n\n"
        "These findings were interpreted alongside source verification and certainty assessment.\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    audit = audit_manuscript_style(manuscript)

    assert "ci" not in audit["repeated_sentence_openings"]
    assert "p" not in audit["repeated_sentence_openings"]
    assert "to" not in audit["repeated_sentence_openings"]
    assert audit["sentences"] == 3


def test_audit_manuscript_style_uses_content_words_for_technical_lexical_diversity() -> None:
    body = " ".join([
        "Within the review, the selected endpoint and the source verification for the analysis were recorded with hazard ratio, censoring window, event definition, and adjudication rule.",
        "Within the review, the selected endpoint and the source verification for the analysis were recorded with registry status, allocation concealment, follow-up duration, and comparator label.",
        "Within the review, the selected endpoint and the source verification for the analysis were recorded with treatment contrast, variance estimate, extraction audit, and eligibility window.",
        "Within the review, the selected endpoint and the source verification for the analysis were recorded with risk-of-bias domain, imprecision boundary, indirectness rationale, and consistency judgment.",
        "Within the review, the selected endpoint and the source verification for the analysis were recorded with subgroup definition, baseline severity, hospitalization threshold, and mortality component.",
        "Within the review, the selected endpoint and the source verification for the analysis were recorded with publication year, trial acronym, funding statement, and protocol amendment.",
    ])
    manuscript = (
        "# Title\n\n"
        "## Results\n\n"
        f"{body}\n\n"
        "## References\n\n"
        "[1] Example trial report.\n"
    )

    audit = audit_manuscript_style(manuscript)

    assert audit["lexical_diversity"] >= 0.28
    assert "low_lexical_diversity" not in {
        issue["code"] for issue in audit["ai_style_signal"]["issues"]
    }


def test_audit_manuscript_style_uses_length_adjusted_chinese_lexical_diversity() -> None:
    body = "".join([
        "SGLT2抑制剂治疗射血分数保留或轻度降低心力衰竭时，主要证据来自随机双盲试验，并以心血管死亡或心力衰竭住院作为核心复合终点［1］。",
        "临床解释需要同时查看基线射血分数、既往糖尿病状态、利尿剂使用和事件判定方式，因为这些因素会影响绝对获益［1］。",
        "DELIVER试验报告了复合终点、全因死亡、安全性事件和停药情况，因而可以支持定量合并［1］。",
        "EMPEROR-Preserved试验同样提供了随访期间心力衰竭住院和心血管死亡的数据，并保留了亚组信息［1］。",
        "方法学评价应记录随机化、分配隐藏、盲法实施、失访比例和预设终点层级，避免把统计显著性等同于证据确定性［1］。",
        "临床应用部分需要区分相对危险度下降和基线风险差异，并说明复合终点中住院事件对总效应的贡献［1］。",
        "安全性解读应单独列出严重不良事件、低血压、容量不足、肾功能变化和因不良事件停药，而不只依赖总体疗效结论［1］。",
        "纳入研究数量较少时，异质性估计和发表偏倚检验的解释空间有限，正文应明确说明这一限制［1］。",
        "证据确定性判断需要把风险偏倚、不精确性、间接性、不一致性和发表偏倚分开描述，不能用单一形容词替代GRADE判断［1］。",
        "引言可以引用心力衰竭流行病学、治疗指南、既往系统综述和关键随机试验，以解释为什么需要更新定量合并［1］。",
        "结果部分应把主要结局、次要结局和安全性结局分别呈现，避免让读者误以为所有终点都有同等证据基础［1］。",
        "讨论部分还应指出复合终点的组成事件可能驱动总体效应，尤其是心力衰竭住院通常比心血管死亡更容易出现差异［1］。",
        "亚组结果只能作为解释性证据，稿件需要保留交互检验和预设状态，防止过度解读单个分类的点估计［1］。",
        "这些表述反复使用疾病名称、药物类别、结局术语和方法学标签，是医学论文必须保留的技术词汇，而不是机械模板句［1］。",
    ])
    manuscript = (
        "# 中文Meta分析稿件\n\n"
        f"## 引言\n\n{body}\n\n"
        f"## 讨论\n\n{body}\n\n"
        "## 参考文献\n\n"
        "［1］ Trial report.\n"
    )

    audit = audit_manuscript_style(manuscript)
    issue_codes = {issue["code"] for issue in audit["ai_style_signal"]["issues"]}

    assert "repeated_sentence_starts" in issue_codes
    assert audit["lexical_diversity"] >= 0.32
    assert "low_lexical_diversity" not in issue_codes


def test_audit_manuscript_style_ignores_repeated_statistical_result_openings() -> None:
    manuscript = (
        "# Title\n\n"
        "## Abstract\n\n"
        "Heterogeneity was low (I²=0.0%, Cochran Q=0.17, p=0.678).\n\n"
        "## Results\n\n"
        "Heterogeneity was low (I²=0.0%, Cochran Q=0.17, p=0.678).\n\n"
        "## Discussion\n\n"
        "Heterogeneity was low (I²=0.0%, Cochran Q=0.17, p=0.678). "
        "The interpretation remained anchored to the prespecified endpoint.\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    audit = audit_manuscript_style(manuscript)

    assert "heterogeneity was low cochran q" not in audit["repeated_sentence_openings"]
    assert "repeated_sentence_starts" not in {
        issue["code"] for issue in audit["ai_style_signal"]["issues"]
    }


def test_audit_manuscript_style_allows_formal_meta_result_repetition_across_sections() -> None:
    manuscript = (
        "# 标题\n\n"
        "## 摘要\n\n"
        "HFmrEF/HFpEF的治疗决策依赖于终点定义一致的证据。"
        "合并效应为HR 0.81（95% CI 0.74至0.88）（p<0.001）。"
        "异质性较低（I²=0.0%，Cochran Q=0.17，p=0.678，tau²=0.000）。\n\n"
        "## 引言\n\n"
        "HFmrEF/HFpEF是一类临床异质性较强的人群。"
        "对于cardiovascular death or heart failure hospitalization这类复合终点，解释时需要关注组成事件。\n\n"
        "## 结果\n\n"
        "主要合并结果为HR 0.81（95% CI 0.74至0.88）（p<0.001）。"
        "异质性较低（I²=0.0%，Cochran Q=0.17，p=0.678，tau²=0.000）。\n\n"
        "## 讨论\n\n"
        "在本结局中，低于无效值1.00的比值表示干预方向更有利；因此该估计提示SGLT2抑制剂降低cardiovascular death or heart failure hospitalization风险。"
        "这些结果应结合基线风险和证据确定性解释。\n\n"
        "## 参考文献\n\n"
        "[1] 示例参考文献。\n"
    )

    audit = audit_manuscript_style(manuscript)
    issue_codes = {issue["code"] for issue in audit["ai_style_signal"]["issues"]}

    assert "repeated_sentence_starts" not in issue_codes
    assert "ci p" not in audit["repeated_sentence_openings"]
    assert "cochran q p" not in audit["repeated_sentence_openings"]


def test_audit_manuscript_style_recognizes_common_reference_heading_variants() -> None:
    english = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The pooled estimate was interpreted with the certainty assessment.\n\n"
        "## Bibliography\n\n"
        "[1] Smith J. In conclusion, trial reporting improved over time. BMJ. 2024.\n"
    )
    chinese = (
        "# 中文题目\n\n"
        "## 讨论\n\n"
        "该结果需要结合证据质量和临床背景解释。\n\n"
        "## 参考资料\n\n"
        "[1] Smith J. In conclusion, randomized trial report. BMJ. 2024.\n"
    )

    english_audit = audit_manuscript_style(english)
    chinese_audit = audit_manuscript_style(chinese)

    assert english_audit["template_phrase_hits"] == {}
    assert english_audit["sentences"] == 1
    assert chinese_audit["language"] == "zh"
    assert chinese_audit["template_phrase_hits"] == {}
    assert chinese_audit["sentences"] == 1


def test_polish_rewriter_receives_style_targets_from_audit() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "It is important to note that the pooled OR was 0.66 [1]. "
        "It is important to note that the certainty was moderate [1]. "
        "It is important to note that clinical interpretation remained cautious [1]. "
        "It is important to note that future updates should preserve the endpoint [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )
    metas: list[dict] = []

    def rewrite(section_text: str, meta: dict) -> str:
        metas.append(meta)
        return section_text.replace("It is important to note that ", "")

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)

    assert "The pooled OR was 0.66 [1]." in polished
    assert report["accepted_sections"] == 1
    assert metas[0]["style_targets"]["remove_template_phrases"] is True
    assert metas[0]["style_targets"]["vary_sentence_openings"] is True
    assert "it is important to note that" in metas[0]["style_targets"]["template_phrases"]


def test_llm_polish_prompt_uses_naturalness_framing_not_detector_optimization(monkeypatch) -> None:
    captured: list[list[dict]] = []

    class FakeLLMClient:
        def __init__(self, model=None):
            self.model = model

        def chat(self, messages, temperature=0, max_tokens=None):
            captured.append(messages)
            return "The pooled OR was 0.66 [1]."

    monkeypatch.setattr(main_module, "LLMClient", FakeLLMClient)

    rewrite = main_module._llm_polish_rewriter(model="qwen-test", lang="en")
    rewrite(
        "It is important to note that the pooled OR was 0.66 [1].",
        {
            "heading": "Discussion",
            "style_targets": {
                "template_phrases": ["it is important to note that"],
                "detector_optimization": "disabled",
            },
        },
    )

    user_prompt = captured[0][-1]["content"].lower()
    assert "reduce formulaic or generic prose" in user_prompt
    assert "do not optimize for ai detectors" in user_prompt
    assert "do not strengthen" in user_prompt
    assert "reduced risk" in user_prompt
    assert "associated with" in user_prompt
    assert "nnt" in user_prompt
    assert "arr" in user_prompt
    assert "risk difference" in user_prompt
    assert "number needed to treat" in user_prompt
    assert "keep each citation marker attached to the same sentence" in user_prompt
    assert "preserve protected clinical terms and acronyms exactly" in user_prompt
    assert "do not shorten the section by more than" in user_prompt
    assert "detector-like" not in user_prompt


def test_llm_polish_prompt_includes_preservation_retry_feedback(monkeypatch) -> None:
    captured: list[list[dict]] = []

    class FakeLLMClient:
        def __init__(self, model=None):
            self.model = model

        def chat(self, messages, temperature=0, max_tokens=None):
            captured.append(messages)
            return "The pooled OR was 0.66 [1]."

    monkeypatch.setattr(main_module, "LLMClient", FakeLLMClient)

    rewrite = main_module._llm_polish_rewriter(model="qwen-test", lang="en")
    rewrite(
        "The pooled OR was 0.66 [1].",
        {
            "heading": "Discussion",
            "retry_after_preservation_rejection": True,
            "preservation_issue_codes": ["numeric_tokens_changed", "citations_changed"],
            "rejected_candidate_excerpt": "The pooled OR was 0.68.",
            "style_targets": {"detector_optimization": "disabled"},
        },
    )

    user_prompt = captured[0][-1]["content"].lower()
    assert "previous rewrite attempt was rejected" in user_prompt
    assert "numeric_tokens_changed" in user_prompt
    assert "citations_changed" in user_prompt
    assert "the pooled or was 0.68" in user_prompt
    assert "preserve the original numbers and citation markers exactly" in user_prompt


def test_llm_polish_prompt_blocks_new_clinical_metrics_in_chinese(monkeypatch) -> None:
    captured: list[list[dict]] = []

    class FakeLLMClient:
        def __init__(self, model=None):
            self.model = model

        def chat(self, messages, temperature=0, max_tokens=None):
            captured.append(messages)
            return "合并OR为0.66 [1]。"

    monkeypatch.setattr(main_module, "LLMClient", FakeLLMClient)

    rewrite = main_module._llm_polish_rewriter(model="qwen-test", lang="zh")
    rewrite(
        "值得注意的是，合并OR为0.66 [1]。",
        {
            "heading": "讨论",
            "style_targets": {
                "template_phrases": ["值得注意的是"],
                "detector_optimization": "disabled",
            },
        },
    )

    user_prompt = captured[0][-1]["content"]
    assert "不得新增NNT" in user_prompt
    assert "ARR" in user_prompt
    assert "风险差" in user_prompt
    assert "需治数" in user_prompt
    assert "引用编号必须留在原句" in user_prompt
    assert "保护性临床术语和缩写必须原样保留" in user_prompt
    assert "不要把段落压缩超过" in user_prompt
    assert "不要针对AI检测器做规避优化" in user_prompt


def test_polish_manuscript_rejects_rewrite_that_changes_numbers_or_citations() -> None:
    manuscript = (
                "# Title\n\n"
                "## Discussion\n\n"
                f"{_web_clinical_discussion_text(citation='[1]', effect='OR 0.66 (95% CI 0.53 to 0.82)', endpoint='mortality')}\n\n"
                "## References\n\n"
                "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("0.66", "0.70").replace("[1]", "[2]")

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 1
    assert {issue["code"] for issue in report["issues"]} >= {"numeric_tokens_changed", "citations_changed"}


def test_polish_manuscript_rejects_rewrite_that_removes_full_width_chinese_citation() -> None:
    manuscript = (
        "# 中文Meta分析稿件\n\n"
        "## 讨论\n\n"
        "主要结果需要结合证据确定性解释［1，2］。\n\n"
        "## 参考文献\n\n"
        "［1］ Example reference.\n"
        "［2］ GRADE reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("［1，2］", "")

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 1
    assert any(issue["code"] == "citations_changed" for issue in report["issues"])


def test_polish_manuscript_allows_rewrite_that_normalizes_chinese_citation_style() -> None:
    manuscript = (
        "# 中文Meta分析稿件\n\n"
        "## 讨论\n\n"
        "主要结果需要结合证据确定性解释［1，2］。\n\n"
        "## 参考文献\n\n"
        "［1］ Example reference.\n"
        "［2］ GRADE reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("［1，2］", "[1,2]")

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)

    assert "[1,2]" in polished
    assert report["accepted_sections"] == 1
    assert report["rejected_sections"] == 0
    assert not any(issue["code"] == "citations_changed" for issue in report["issues"])


def test_polish_manuscript_rejects_rewrite_that_moves_citation_to_different_sentence() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The pooled estimate favored treatment [1]. "
        "Interpretation should consider baseline risk.\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace(
            "The pooled estimate favored treatment [1]. Interpretation should consider baseline risk.",
            "The pooled estimate favored treatment. Interpretation should consider baseline risk [1].",
        )

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 1
    issue = next(issue for issue in report["issues"] if issue["code"] == "citation_sentence_binding_changed")
    assert "pooled estimate favored treatment" in issue["original_text"]
    assert "baseline risk [1]" in issue["candidate_text"]
    assert issue["original_citation_bindings"] != issue["candidate_citation_bindings"]


def test_polish_manuscript_rejects_chinese_rewrite_that_moves_citation_to_different_clause() -> None:
    manuscript = (
        "# 中文Meta分析稿件\n\n"
        "## 讨论\n\n"
        "主要结果显示获益［1］，但解释仍需结合基线风险。\n\n"
        "## 参考文献\n\n"
        "［1］ 示例参考文献。\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace(
            "主要结果显示获益［1］，但解释仍需结合基线风险。",
            "主要结果显示获益，但解释仍需结合基线风险［1］。",
        )

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 1
    issue = next(issue for issue in report["issues"] if issue["code"] == "citation_sentence_binding_changed")
    assert "主要结果显示获益［1］" in issue["original_text"]
    assert "基线风险［1］" in issue["candidate_text"]
    assert issue["original_citation_bindings"] != issue["candidate_citation_bindings"]


def test_polish_manuscript_rejected_rewrite_keeps_review_material() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The pooled OR was 0.66 (95% CI 0.53 to 0.82) [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("0.66", "0.70")

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    numeric_issue = next(issue for issue in report["issues"] if issue["code"] == "numeric_tokens_changed")

    assert polished == manuscript
    assert numeric_issue["heading"] == "Discussion"
    assert numeric_issue["chunk_index"] == 0
    assert "0.66" in numeric_issue["original_text"]
    assert "0.70" in numeric_issue["candidate_text"]
    assert numeric_issue["review_action"] == "manual_review_required"


def test_polish_manuscript_rejects_rewrite_that_changes_unicode_inequality_numbers() -> None:
    manuscript = (
        "# 中文Meta分析稿件\n\n"
        "## 结果\n\n"
        "主要结局达到统计学阈值（P≤0.05），异质性阈值为P≥0.10［1］。\n\n"
        "## 参考文献\n\n"
        "［1］ Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("P≤0.05", "P<0.05").replace("P≥0.10", "P>0.10")

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    numeric_issue = next(issue for issue in report["issues"] if issue["code"] == "numeric_tokens_changed")

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 1
    assert "P≤0.05" in numeric_issue["original_text"]
    assert "P<0.05" in numeric_issue["candidate_text"]


def test_polish_manuscript_rejects_rewrite_that_removes_negative_effect_sign() -> None:
    manuscript = (
        "# Title\n\n"
        "## Results\n\n"
        "The pooled MD was −1.13 (95% CI −2.06 to −0.20) [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("−1.13", "1.13").replace("−2.06", "2.06")

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    numeric_issue = next(issue for issue in report["issues"] if issue["code"] == "numeric_tokens_changed")

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 1
    assert "−1.13" in numeric_issue["original_text"]
    assert "1.13" in numeric_issue["candidate_text"]


def test_polish_manuscript_rejects_rewrite_that_changes_effect_measure_terms() -> None:
    manuscript = (
        "# Title\n\n"
        "## Results\n\n"
        "The pooled OR was 0.66 (95% CI 0.53 to 0.82) [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("OR", "RR").replace("CI", "CrI")

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    term_issue = next(issue for issue in report["issues"] if issue["code"] == "protected_terms_changed")

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 1
    assert "or" in term_issue["original_terms"]
    assert "rr" in term_issue["candidate_terms"]


def test_polish_manuscript_allows_rewrite_of_plain_lowercase_or_phrase() -> None:
    manuscript = (
        "# Title\n\n"
        "## Methods\n\n"
        "Eligible comparisons used usual care or placebo as the comparator [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("usual care or placebo", "usual care/placebo")

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)

    assert "usual care/placebo as the comparator [1]." in polished
    assert report["accepted_sections"] == 1
    assert report["rejected_sections"] == 0
    assert not any(issue["code"] == "protected_terms_changed" for issue in report["issues"])


def test_polish_manuscript_rejects_rewrite_that_reverses_directional_claims() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The intervention reduced mortality without changing the prespecified OR [1].\n\n"
        "## 讨论\n\n"
        "干预措施降低了死亡风险，但未改变预设效应量［1］。\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("reduced mortality", "increased mortality").replace("降低了死亡风险", "增加了死亡风险")

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    direction_issue = next(issue for issue in report["issues"] if issue["code"] == "directional_terms_changed")

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 2
    assert direction_issue["original_directional_terms"] == ["lower"]
    assert direction_issue["candidate_directional_terms"] == ["higher"]


def test_polish_manuscript_allows_same_direction_wording_change() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The intervention reduced mortality without changing the prespecified OR [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("reduced mortality", "lowered mortality")

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)

    assert "lowered mortality without changing the prespecified OR [1]." in polished
    assert report["accepted_sections"] == 1
    assert report["rejected_sections"] == 0
    assert not any(issue["code"] == "directional_terms_changed" for issue in report["issues"])


def test_polish_manuscript_allows_methodological_rank_terms() -> None:
    manuscript = (
        "# Title\n\n"
        "## Methods\n\n"
        "Rows were excluded when they duplicated a higher-ranked primary row or lower-priority endpoint [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace(
            "Rows were excluded when they duplicated a higher-ranked primary row or lower-priority endpoint",
            "Rows duplicating a higher-ranked primary row were excluded",
        )

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)

    assert "Rows duplicating a higher-ranked primary row were excluded [1]." in polished
    assert report["accepted_sections"] == 1
    assert not any(issue["code"] == "directional_terms_changed" for issue in report["issues"])


def test_polish_manuscript_allows_nonclinical_direction_terms_in_certainty_context() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "A precise pooled estimate can receive a lower certainty rating if the evidence is indirect. "
        "This reduces the risk that certainty is overstated in the manuscript [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace(
            "A precise pooled estimate can receive a lower certainty rating if the evidence is indirect. "
            "This reduces the risk that certainty is overstated in the manuscript",
            "A precise pooled estimate can still be rated as less certain when evidence is indirect. "
            "This limits overstatement of certainty in the manuscript",
        )

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)

    assert "less certain when evidence is indirect" in polished
    assert report["accepted_sections"] == 1
    assert not any(issue["code"] == "directional_terms_changed" for issue in report["issues"])


def test_polish_manuscript_rejects_rewrite_that_removes_directional_negation() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The intervention did not reduce mortality in the primary analysis [1].\n\n"
        "## 讨论\n\n"
        "干预措施未降低主要分析中的死亡风险［1］。\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("did not reduce mortality", "reduced mortality").replace("未降低", "降低")

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    direction_issue = next(issue for issue in report["issues"] if issue["code"] == "directional_terms_changed")

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 2
    assert direction_issue["original_directional_terms"] == ["not_lower"]
    assert direction_issue["candidate_directional_terms"] == ["lower"]


def test_polish_manuscript_rejects_rewrite_that_adds_clinical_benefit_claims() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The primary analysis was associated with an HR of 0.81 for hospitalization [1].\n\n"
        "## 讨论\n\n"
        "主要分析与住院风险的HR 0.81相关［1］。\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return (
            section_text
            .replace(
                "was associated with an HR of 0.81 for hospitalization",
                "showed a clinical benefit with an HR of 0.81 for hospitalization",
            )
            .replace("HR 0.81相关", "HR 0.81提示临床获益")
        )

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    claim_issue = next(issue for issue in report["issues"] if issue["code"] == "clinical_claim_terms_changed")

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 2
    assert claim_issue["original_clinical_claim_terms"] == []
    assert claim_issue["candidate_clinical_claim_terms"] == ["benefit"]
    assert "clinical benefit" in claim_issue["candidate_text"]


def test_polish_manuscript_rejects_rewrite_that_removes_clinical_hedging() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The pooled estimate may reduce hospitalization, but certainty remains limited [1].\n\n"
        "## 讨论\n\n"
        "合并估计可能降低住院风险，但证据确定性仍然有限［1］。\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return (
            section_text
            .replace("may reduce hospitalization", "reduces hospitalization")
            .replace("可能降低住院风险", "降低住院风险")
        )

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    certainty_issue = next(issue for issue in report["issues"] if issue["code"] == "interpretive_certainty_changed")

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 2
    assert certainty_issue["original_interpretive_certainty_terms"] == ["hedged"]
    assert certainty_issue["candidate_interpretive_certainty_terms"] == []
    assert "reduces hospitalization" in certainty_issue["candidate_text"]


def test_polish_manuscript_rejects_rewrite_that_changes_grade_certainty_rating() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "GRADE certainty was low for the hospitalization outcome [1].\n\n"
        "## 讨论\n\n"
        "住院结局的GRADE证据确定性为低［1］。\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return (
            section_text
            .replace("certainty was low", "certainty was moderate")
            .replace("证据确定性为低", "证据确定性为中等")
        )

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    rating_issue = next(issue for issue in report["issues"] if issue["code"] == "certainty_rating_changed")

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 2
    assert rating_issue["original_certainty_ratings"] == ["low"]
    assert rating_issue["candidate_certainty_ratings"] == ["moderate"]
    assert "certainty was moderate" in rating_issue["candidate_text"]


def test_polish_manuscript_rejects_rewrite_that_changes_risk_of_bias_rating() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The primary trials were judged at low risk of bias for outcome measurement [1].\n\n"
        "## 讨论\n\n"
        "主要试验在结局测量方面被评为低偏倚风险［1］。\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return (
            section_text
            .replace("low risk of bias", "high risk of bias")
            .replace("低偏倚风险", "高偏倚风险")
        )

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    rob_issue = next(issue for issue in report["issues"] if issue["code"] == "risk_of_bias_rating_changed")

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 2
    assert rob_issue["original_risk_of_bias_ratings"] == ["low"]
    assert rob_issue["candidate_risk_of_bias_ratings"] == ["high"]
    assert "high risk of bias" in rob_issue["candidate_text"]


def test_polish_manuscript_rejects_rewrite_that_changes_statistical_model_terms() -> None:
    manuscript = (
        "# Title\n\n"
        "## Methods\n\n"
        "We used a random-effects model with REML estimation for the primary synthesis [1].\n\n"
        "## 方法\n\n"
        "主要合并采用随机效应模型，并使用REML估计τ²［1］。\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return (
            section_text
            .replace("random-effects model", "fixed-effect model")
            .replace("随机效应模型", "固定效应模型")
        )

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    model_issue = next(issue for issue in report["issues"] if issue["code"] == "statistical_model_changed")

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 2
    assert model_issue["original_statistical_models"] == ["random_effects", "reml"]
    assert model_issue["candidate_statistical_models"] == ["fixed_effect", "reml"]
    assert "fixed-effect model" in model_issue["candidate_text"]


def test_polish_manuscript_rejects_rewrite_that_changes_statistical_significance() -> None:
    manuscript = (
        "# Title\n\n"
        "## Results\n\n"
        "The subgroup interaction was not statistically significant (P = 0.08) [1].\n\n"
        "## 结果\n\n"
        "亚组交互作用未达到统计学显著（P = 0.08）［1］。\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return (
            section_text
            .replace("was not statistically significant", "was statistically significant")
            .replace("未达到统计学显著", "达到统计学显著")
        )

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    significance_issue = next(issue for issue in report["issues"] if issue["code"] == "statistical_significance_changed")

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 2
    assert significance_issue["original_statistical_significance"] == ["not_significant"]
    assert significance_issue["candidate_statistical_significance"] == ["significant"]
    assert "statistically significant" in significance_issue["candidate_text"]


def test_polish_manuscript_rejects_rewrite_that_changes_study_design_terms() -> None:
    manuscript = (
        "# Title\n\n"
        "## Methods\n\n"
        "Eligible evidence came from randomized controlled trials with blinded outcome adjudication [1].\n\n"
        "## 方法\n\n"
        "符合条件的证据来自随机对照试验，并采用盲法结局判定［1］。\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return (
            section_text
            .replace("randomized controlled trials", "observational cohort studies")
            .replace("随机对照试验", "观察性队列研究")
        )

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    design_issue = next(issue for issue in report["issues"] if issue["code"] == "study_design_changed")

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 2
    assert design_issue["original_study_design_terms"] == ["randomized_trial", "blinded"]
    assert design_issue["candidate_study_design_terms"] == ["observational_study", "cohort_study", "blinded"]
    assert "observational cohort studies" in design_issue["candidate_text"]


def test_polish_manuscript_rejects_rewrite_that_changes_output_language() -> None:
    manuscript = (
        "# Title\n\n"
        "## Methods\n\n"
        "We included randomized trials and extracted prespecified outcomes in duplicate [1].\n\n"
        "## 方法\n\n"
        "我们纳入随机试验，并重复提取预先指定的结局［1］。\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        if meta.get("heading") == "Methods":
            return section_text.replace(
                "We included randomized trials and extracted prespecified outcomes in duplicate",
                "我们纳入随机试验，并重复提取预先指定的结局",
            )
        if meta.get("heading") == "方法":
            return section_text.replace(
                "我们纳入随机试验，并重复提取预先指定的结局",
                "We included randomized trials and extracted prespecified outcomes in duplicate",
            )
        return section_text

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    language_issue = next(issue for issue in report["issues"] if issue["code"] == "language_changed")

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 2
    assert language_issue["original_language"] == "en"
    assert language_issue["candidate_language"] == "zh"
    assert "我们纳入随机试验" in language_issue["candidate_text"]


def test_polish_manuscript_rejects_rewrite_that_mixes_output_language() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The findings should be interpreted with attention to clinical applicability and certainty [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace(
            "clinical applicability and certainty",
            "clinical applicability 和证据确定性",
        )

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    language_issue = next(issue for issue in report["issues"] if issue["code"] == "language_changed")

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 1
    assert language_issue["original_language"] == "en"
    assert language_issue["candidate_language"] == "mixed"
    assert "和证据确定性" in language_issue["candidate_text"]


def test_polish_manuscript_rejects_rewrite_that_changes_clinical_outcome_terms() -> None:
    manuscript = (
        "# Title\n\n"
        "## Results\n\n"
        "The pooled HR for heart failure hospitalization was 0.81 (95% CI 0.75 to 0.88) [1].\n\n"
        "## 结果\n\n"
        "心力衰竭住院的合并HR为0.81（95% CI 0.75至0.88）［1］。\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return (
            section_text
            .replace("heart failure hospitalization", "cardiovascular mortality")
            .replace("心力衰竭住院", "心血管死亡")
        )

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    entity_issue = next(issue for issue in report["issues"] if issue["code"] == "clinical_entities_changed")

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 2
    assert entity_issue["original_clinical_entities"] == ["heart_failure_hospitalization"]
    assert entity_issue["candidate_clinical_entities"] == ["cardiovascular_death"]
    assert "cardiovascular mortality" in entity_issue["candidate_text"]


def test_polish_manuscript_rejects_rewrite_that_changes_comparator_terms() -> None:
    manuscript = (
        "# Title\n\n"
        "## Results\n\n"
        "The intervention was compared with placebo in the primary analysis [1].\n\n"
        "## 结果\n\n"
        "主要分析中，干预组与安慰剂进行比较［1］。\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return (
            section_text
            .replace("compared with placebo", "compared with standard care")
            .replace("与安慰剂进行比较", "与常规治疗进行比较")
        )

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    entity_issue = next(issue for issue in report["issues"] if issue["code"] == "clinical_entities_changed")

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 2
    assert entity_issue["original_clinical_entities"] == ["intervention_group", "placebo"]
    assert entity_issue["candidate_clinical_entities"] == ["intervention_group", "standard_care"]
    assert "standard care" in entity_issue["candidate_text"]


def test_polish_manuscript_rejects_changed_compact_chinese_table_figure_refs() -> None:
    manuscript = (
        "# 中文Meta分析稿件\n\n"
        "## 结果\n\n"
        "纳入研究特征见表1，主要效应见图2［1］。\n\n"
        "## 参考文献\n\n"
        "［1］ Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("表1", "表2").replace("图2", "图3")

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)

    assert polished == manuscript
    assert report["accepted_sections"] == 0
    assert report["rejected_sections"] == 1
    assert any(issue["code"] == "cross_references_changed" for issue in report["issues"])


def test_polish_manuscript_rejects_detector_evasion_language() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The pooled OR was 0.66 (95% CI 0.53 to 0.82) [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return (
            section_text.strip()
            + " This revision was polished to lower the AI detector score while preserving the result."
        )

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    policy_issue = next(issue for issue in report["issues"] if issue["code"] == "detector_evasion_language")

    assert polished == manuscript
    assert report["style_policy"]["detector_evasion"] is False
    assert report["rejected_sections"] == 1
    assert "lower the AI detector score" in policy_issue["candidate_text"]
    assert policy_issue["review_action"] == "manual_review_required"


def test_preservation_guard_rejects_prompt_excerpt_artifacts() -> None:
    original = (
        "The pooled HR was 0.81 (95% CI 0.74 to 0.88). "
        "Clinical interpretation depends on baseline risk and certainty."
    )
    candidate = (
        "The pooled HR was 0.81 (95% CI 0.74 to 0.88).\n\n"
        "[...middle of this existing section omitted for prompt length; do not treat the section as missing...]\n\n"
        "Clinical interpretation depends on baseline risk and certainty."
    )

    issues = preservation_guard_issues(original, candidate, "Discussion")

    assert any(issue["code"] == "prompt_artifact_leaked" for issue in issues)


def test_preservation_guard_rejects_unsupported_proprietary_source_label() -> None:
    original = (
        "The search included a local curated literature repository and OpenAlex. "
        "The export package preserves the query, source counts, and retained record list."
    )
    candidate = (
        "The search included a proprietary local repository and OpenAlex. "
        "The export package preserves the query, source counts, and retained record list."
    )

    issues = preservation_guard_issues(original, candidate, "Methods")

    assert any(issue["code"] == "unsupported_source_characterization" for issue in issues)

    searchable_candidate = (
        "The search included a local curated literature repository and OpenAlex. "
        "Verification relies on the export package because the curated dataset is not publicly searchable."
    )
    searchable_issues = preservation_guard_issues(original, searchable_candidate, "Methods")

    assert any(issue["code"] == "unsupported_source_characterization" for issue in searchable_issues)

    composition_candidate = (
        "The search included a local curated literature repository and OpenAlex. "
        "OpenAlex contained many preprints and conference abstracts, causing high overlap with the local repository."
    )
    composition_issues = preservation_guard_issues(original, composition_candidate, "Abstract")

    assert any(issue["code"] == "unsupported_source_characterization" for issue in composition_issues)


def test_preservation_guard_rejects_unsupported_workflow_disclosure() -> None:
    original = (
        "GRADE间接性判断结合人群、干预、对照、结局和研究设计与综述问题的一致程度。"
        "主要结局行来源已验证，未因间接性降级。"
    )
    candidate = (
        "GRADE间接性判断结合人群、干预、对照、结局和研究设计与综述问题的一致程度。"
        "PICO要素虽未进行人工双重验证，但自动化规则匹配确认无直接不匹配，且主要结局行来源已验证，故未降级。"
    )

    issues = preservation_guard_issues(original, candidate, "Results")

    assert any(issue["code"] == "unsupported_workflow_disclosure" for issue in issues)


def test_polish_manuscript_rejects_chinese_detector_evasion_language() -> None:
    manuscript = (
        "# 中文Meta分析稿件\n\n"
        "## 讨论\n\n"
        "合并OR为0.66，结果需要结合证据确定性解释［1］。\n\n"
        "## 参考文献\n\n"
        "［1］ Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.strip() + " 这版润色可以帮助绕开AI查重，同时保留原始结论。"

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    policy_issue = next(issue for issue in report["issues"] if issue["code"] == "detector_evasion_language")

    assert polished == manuscript
    assert report["style_policy"]["detector_evasion"] is False
    assert report["rejected_sections"] == 1
    assert "绕开AI查重" in policy_issue["candidate_text"]
    assert policy_issue["review_action"] == "manual_review_required"


def test_polish_unsectioned_manuscript_rejection_keeps_review_material() -> None:
    manuscript = "The pooled OR was 0.66 (95% CI 0.53 to 0.82) [1]."

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("0.66", "0.70")

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    numeric_issue = next(issue for issue in report["issues"] if issue["code"] == "numeric_tokens_changed")

    assert polished == manuscript
    assert numeric_issue["heading"] == "document"
    assert "0.66" in numeric_issue["original_text"]
    assert "0.70" in numeric_issue["candidate_text"]
    assert numeric_issue["review_action"] == "manual_review_required"


def test_polish_manuscript_rejects_changed_trial_or_drug_terms() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The DAPA-HF and DELIVER trials evaluated dapagliflozin in heart failure [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("DAPA-HF", "EMPEROR-Preserved").replace("dapagliflozin", "empagliflozin")

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    term_issue = next(issue for issue in report["issues"] if issue["code"] == "protected_terms_changed")

    assert polished == manuscript
    assert "DAPA-HF" in term_issue["original_text"]
    assert "EMPEROR-Preserved" in term_issue["candidate_text"]
    assert term_issue["review_action"] == "manual_review_required"


def test_polish_manuscript_rewrite_failure_keeps_review_material() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "The DAPA-HF trial evaluated dapagliflozin in heart failure [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )

    def rewrite(section_text: str, meta: dict) -> str:
        raise RuntimeError("provider timeout")

    polished, report = polish_manuscript_text(manuscript, rewrite_fn=rewrite, enabled=True)
    failure = next(issue for issue in report["issues"] if issue["code"] == "rewrite_failed")

    assert polished == manuscript
    assert "provider timeout" in failure["message"]
    assert "DAPA-HF" in failure["original_text"]
    assert failure["candidate_text"] == ""
    assert failure["review_action"] == "manual_review_required"


def test_language_tool_proofreader_normalizes_bilingual_matches(monkeypatch) -> None:
    calls: list[dict] = []

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "matches": [
                    {
                        "message": "Possible agreement issue.",
                        "shortMessage": "Agreement",
                        "offset": 3,
                        "length": 5,
                        "sentence": "This are important.",
                        "replacements": [{"value": "is"}, {"value": "was"}, {"value": "were"}, {"value": "be"}],
                        "rule": {
                            "id": "EN_AGREEMENT",
                            "issueType": "grammar",
                            "category": {"id": "GRAMMAR", "name": "Grammar"},
                        },
                    }
                ]
            }

    def fake_post(url: str, data: dict, timeout: float):
        calls.append({"url": url, "data": data, "timeout": timeout})
        return FakeResponse()

    monkeypatch.setattr(proofreading_module.requests, "post", fake_post)

    result = LanguageToolProofreader("http://localhost:8010", timeout_seconds=2.5).check(
        "This are important.",
        {"language": "zh"},
    )

    assert calls == [
        {
            "url": "http://localhost:8010/v2/check",
            "data": {"text": "This are important.", "language": "zh-CN"},
            "timeout": 2.5,
        }
    ]
    assert result["provider"] == "languagetool"
    assert result["language_code"] == "zh-CN"
    assert result["issue_count"] == 1
    assert result["issues"][0]["rule_id"] == "EN_AGREEMENT"
    assert result["issues"][0]["replacements"] == ["is", "was", "were"]


def test_polish_report_records_transparent_policy_and_optional_proofreading() -> None:
    manuscript = (
        "# Title\n\n"
        "## Discussion\n\n"
        "It is important to note that the pooled OR was 0.66 [1].\n\n"
        "## References\n\n"
        "[1] Example reference.\n"
    )
    proofread_calls: list[dict] = []

    def proofread(text: str, meta: dict) -> dict:
        proofread_calls.append({"text": text, "meta": meta})
        return {
            "provider": "languagetool",
            "language_code": "en-US",
            "issues": [{"rule_id": "STYLE_PASSIVE", "message": "Consider a more direct phrase."}],
        }

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=lambda section_text, meta: section_text.replace("It is important to note that ", ""),
        proofread_fn=proofread,
        enabled=True,
    )

    assert "The pooled OR was 0.66 [1]." in polished
    assert report["style_policy"]["name"] == "MetaAgent conservative scholarly polish"
    assert report["style_policy"]["detector_evasion"] is False
    assert report["style_policy"]["detector_optimization"] == "disabled"
    assert "numbers" in report["style_policy"]["protected_facts"]
    assert proofread_calls[0]["meta"]["language"] == "en"
    assert proofread_calls[0]["meta"]["style_policy"]["detector_evasion"] is False
    assert report["proofreading"]["enabled"] is True
    assert report["proofreading"]["provider"] == "languagetool"
    assert report["proofreading"]["issue_count"] == 1
    assert report["proofreading"]["issues"][0]["rule_id"] == "STYLE_PASSIVE"


def test_polish_proofreader_uses_chinese_for_zh_dominant_technical_manuscript() -> None:
    manuscript = (
        "# 中文Meta分析稿件\n\n"
        "## 讨论\n\n"
        "DAPA-HF和EMPEROR-Preserved均为关键研究。"
        "总体来看，中文正文占据主要篇幅，英文缩写仅作为研究名称和方法术语保留［1］。\n\n"
        "## 参考文献\n\n"
        "［1］ Example reference.\n"
    )
    proofread_calls: list[dict] = []

    def proofread(text: str, meta: dict) -> dict:
        proofread_calls.append({"text": text, "meta": meta})
        return {"provider": "languagetool", "language_code": "zh-CN", "issues": []}

    polished, report = polish_manuscript_text(manuscript, proofread_fn=proofread, enabled=True)

    assert polished == manuscript
    assert audit_manuscript_style(manuscript)["language"] == "zh"
    assert proofread_calls[0]["meta"]["language"] == "zh"
    assert proofread_calls[0]["meta"]["audit_language"] == "zh"
    assert report["proofreading"]["language_code"] == "zh-CN"


def test_web_manuscript_reference_helper_reuses_cli_context_enrichment(monkeypatch, tmp_path) -> None:
    from start import _prepare_web_manuscript_references

    project = Project("web refs", output_dir=tmp_path)
    ref_manager = ReferenceManager()
    calls = {"evidence": 0}

    def fake_evidence(project_arg, protocol_arg, ref_manager_arg, *, search_query=""):
        calls["evidence"] += 1
        assert project_arg is project
        assert protocol_arg.pico.outcome_primary == "28-day all-cause mortality"
        assert search_query == "COVID-19 corticosteroids mortality"
        return {"status": "ok", "added_references": 0, "query": search_query}

    monkeypatch.setattr(main_module, "_add_evidence_context_references", fake_evidence)

    summary = _prepare_web_manuscript_references(
        project,
        _protocol(),
        ref_manager,
        papers=[
            {
                "pmid": "12345",
                "title": "Trial report",
                "authors": ["Smith John"],
                "year": "2020",
                "journal": "Example Journal",
            }
        ],
        extracted_studies=[],
        search_query="COVID-19 corticosteroids mortality",
        include_rob=True,
        include_grade=True,
        include_publication_bias=True,
    )

    bibtex = project.load_text("references.bib")
    methodology = project.load_json("methodology_context.json", subdir="search")

    assert calls["evidence"] == 1
    assert summary["n_references"] == len(ref_manager.entries)
    assert summary["methodology"]["added_references"] >= 7
    assert "Trial report" in bibtex
    assert "PRISMA 2020" in " ".join(item["title"] for item in methodology["references"])


def test_web_manuscript_polish_helper_persists_audit(monkeypatch, tmp_path) -> None:
    from start import _polish_web_manuscript

    project = Project("web polish", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Discussion\n\n"
            f"{_web_clinical_discussion_text(citation='[1]', effect='OR 0.66 (95% CI 0.53 to 0.82)', endpoint='mortality')}\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", False)

    polished = _polish_web_manuscript(
        project,
        payload={"polish_manuscript": True},
        model=None,
        lang="en",
    )
    audit = project.load_json("manuscript_polish_audit.json", subdir="manuscript")

    assert polished == project.load_text("draft.md", subdir="manuscript")
    assert audit["enabled"] is True
    assert audit["language"] == "en"


def test_manuscript_polish_is_disabled_by_default_and_can_be_requested() -> None:
    assert main_module.MANUSCRIPT_POLISH_ENABLED is False
    assert main_module._should_polish_manuscript(SimpleNamespace()) is False
    assert main_module._should_polish_manuscript(SimpleNamespace(polish_manuscript=True)) is True
    assert main_module._should_polish_manuscript(SimpleNamespace(no_polish_manuscript=True)) is False


def test_cli_manuscript_polish_uses_targeted_rewrite_scope_when_env_enabled(monkeypatch, tmp_path) -> None:
    project = Project("cli polish scope", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        "# Title\n\n## Discussion\n\nThe pooled OR was 0.66 [1].\n\n## References\n\n[1] Example.\n",
        subdir="manuscript",
    )
    calls: list[dict] = []

    def fake_polish(manuscript: str, **kwargs):
        calls.append(kwargs)
        return manuscript, {
            "enabled": kwargs.get("enabled"),
            "language": "en",
            "rewrite_scope": kwargs.get("rewrite_scope"),
            "issues": [],
            "before": {"ai_style_signal": {"score": 0, "issues": []}},
            "after": {"ai_style_signal": {"score": 0, "issues": []}},
        }

    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", False)
    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_ENABLED", True)
    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_REWRITE_SCOPE", "targeted", raising=False)
    monkeypatch.setattr(main_module, "polish_manuscript_text", fake_polish)

    main_module._polish_project_manuscript(
        project,
        SimpleNamespace(polish_manuscript=False, no_polish_manuscript=False),
        model=None,
        lang="en",
    )

    assert calls[0]["rewrite_scope"] == "targeted"
    language_record = project.load_json("manuscript_output_language.json", subdir="manuscript")
    assert language_record["expected_language"] == "en"
    assert language_record["output_language"] == "en"
    assert language_record["source"] == "pipeline_requested_output_language"
    assert language_record["polish_enabled"] is True


def test_cli_manuscript_polish_scope_can_request_all_chunks(monkeypatch, tmp_path) -> None:
    project = Project("cli polish all scope", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        "# Title\n\n## Discussion\n\nThe pooled OR was 0.66 [1].\n\n## References\n\n[1] Example.\n",
        subdir="manuscript",
    )
    calls: list[dict] = []

    def fake_polish(manuscript: str, **kwargs):
        calls.append(kwargs)
        return manuscript, {
            "enabled": kwargs.get("enabled"),
            "language": "en",
            "rewrite_scope": kwargs.get("rewrite_scope"),
            "issues": [],
            "before": {"ai_style_signal": {"score": 0, "issues": []}},
            "after": {"ai_style_signal": {"score": 0, "issues": []}},
        }

    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", False)
    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_REWRITE_SCOPE", "targeted", raising=False)
    monkeypatch.setattr(main_module, "polish_manuscript_text", fake_polish)

    main_module._polish_project_manuscript(
        project,
        SimpleNamespace(
            polish_manuscript=True,
            no_polish_manuscript=False,
            manuscript_polish_scope="all",
        ),
        model=None,
        lang="en",
    )

    assert calls[0]["rewrite_scope"] == "all"


def test_cli_manuscript_polish_all_scope_raises_default_llm_chunk_budget(monkeypatch, tmp_path) -> None:
    project = Project("cli polish all default budget", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        "# Title\n\n## Discussion\n\nThe pooled OR was 0.66 [1].\n\n## References\n\n[1] Example.\n",
        subdir="manuscript",
    )
    calls: list[dict] = []

    def fake_polish(manuscript: str, **kwargs):
        calls.append(kwargs)
        return manuscript, {
            "enabled": kwargs.get("enabled"),
            "language": "en",
            "rewrite_scope": kwargs.get("rewrite_scope"),
            "issues": [],
            "before": {"ai_style_signal": {"score": 0, "issues": []}},
            "after": {"ai_style_signal": {"score": 0, "issues": []}},
        }

    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", True)
    monkeypatch.setattr(main_module, "LLM_API_KEY", "test-key")
    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_MAX_LLM_CHUNKS", 6)
    monkeypatch.delenv("MANUSCRIPT_POLISH_MAX_LLM_CHUNKS", raising=False)
    monkeypatch.setattr(main_module, "_llm_polish_rewriter", lambda **kwargs: (lambda text, context: text))
    monkeypatch.setattr(main_module, "polish_manuscript_text", fake_polish)

    main_module._polish_project_manuscript(
        project,
        SimpleNamespace(
            polish_manuscript=True,
            no_polish_manuscript=False,
            manuscript_polish_scope="all",
        ),
        model="qwen3.6-plus",
        lang="en",
    )

    assert calls[0]["rewrite_scope"] == "all"
    assert calls[0]["max_rewrite_chunks"] >= 24


def test_cli_manuscript_polish_does_not_revert_only_for_publication_length_floor(monkeypatch, tmp_path) -> None:
    project = Project("cli polish treats length floor as soft target", output_dir=tmp_path)
    original_discussion = " ".join(["Clinically relevant interpretation remains available"] * 18)
    shortened_discussion = " ".join(["Clinically relevant interpretation remains available"] * 14)
    project.save_json(
        "manuscript_facts.json",
        {"writing_constraints": {"publication_min_main_words": 80}},
        subdir="manuscript",
    )
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            f"## Discussion\n\n{original_discussion} [1].\n\n"
            "## References\n\n[1] Example.\n"
        ),
        subdir="manuscript",
    )

    def fake_polish(manuscript: str, **kwargs):
        return (
            "# Title\n\n"
            f"## Discussion\n\n{shortened_discussion} [1].\n\n"
            "## References\n\n[1] Example.\n",
            {
                "enabled": kwargs.get("enabled"),
                "language": "en",
                "rewrite_scope": kwargs.get("rewrite_scope"),
                "issues": [],
                "before": {"ai_style_signal": {"score": 0, "issues": []}},
                "after": {"ai_style_signal": {"score": 0, "issues": []}},
            },
        )

    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", False)
    monkeypatch.setattr(main_module, "polish_manuscript_text", fake_polish)

    main_module._polish_project_manuscript(
        project,
        SimpleNamespace(polish_manuscript=True, no_polish_manuscript=False),
        model=None,
        lang="en",
    )

    saved = project.load_text("draft.md", subdir="manuscript")
    audit = project.load_json("manuscript_polish_audit.json", subdir="manuscript")
    assert shortened_discussion in saved
    assert original_discussion not in saved
    length_guard = audit.get("length_floor_guard") or {}
    assert length_guard.get("applied") is False
    assert length_guard.get("below_target_after_polish") is True
    assert not any(issue.get("code") == "polish_length_floor_regression" for issue in audit.get("issues", []))


def test_cli_manuscript_polish_forwards_progress_callback_to_core(monkeypatch, tmp_path) -> None:
    project = Project("cli polish progress", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        "# Title\n\n## Discussion\n\nThe pooled HR was 0.78 [1].\n\n## References\n\n[1] Trial report.\n",
        subdir="manuscript",
    )
    progress_events: list[dict] = []
    progress_cb = progress_events.append
    captured: dict[str, object] = {}

    def fake_polish(manuscript: str, **kwargs):
        captured["progress_cb"] = kwargs.get("progress_cb")
        progress_cb = kwargs.get("progress_cb")
        if progress_cb:
            progress_cb({"stage": "manuscript_polish", "event": "chunk_started"})
        return manuscript, {
            "enabled": kwargs.get("enabled"),
            "language": "en",
            "rewrite_scope": kwargs.get("rewrite_scope"),
            "issues": [],
            "before": {"ai_style_signal": {"score": 0, "issues": []}},
            "after": {"ai_style_signal": {"score": 0, "issues": []}},
        }

    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", False)
    monkeypatch.setattr(main_module, "polish_manuscript_text", fake_polish)

    main_module._polish_project_manuscript(
        project,
        SimpleNamespace(polish_manuscript=True, no_polish_manuscript=False),
        model=None,
        lang="en",
        progress_cb=progress_cb,
    )

    assert captured["progress_cb"] is progress_cb
    assert progress_events == [{"stage": "manuscript_polish", "event": "chunk_started"}]


def test_cli_manuscript_polish_reverts_post_citation_backfill_after_llm_rewrite(monkeypatch, tmp_path) -> None:
    project = Project("cli polish post citation backfill guarded", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Results\n\n"
            "The pooled HR was 0.81 (95% CI 0.75 to 0.88) [2].\n\n"
            "## References\n\n"
            "[1] Solomon SD. Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction. N Engl J Med. 2022.\n\n"
            "[2] Guyatt GH. GRADE guidelines.\n"
        ),
        subdir="manuscript",
    )

    def fake_polish(manuscript: str, **kwargs):
        return manuscript, {
            "enabled": True,
            "language": "en",
            "rewrite_scope": kwargs.get("rewrite_scope"),
            "issues": [],
            "before": {"ai_style_signal": {"score": 0, "issues": []}},
            "after": {"ai_style_signal": {"score": 0, "issues": []}},
        }

    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", False)
    monkeypatch.setattr(main_module, "polish_manuscript_text", fake_polish)

    main_module._polish_project_manuscript(
        project,
        SimpleNamespace(polish_manuscript=True, no_polish_manuscript=False),
        model=None,
        lang="en",
    )

    draft = project.load_text("draft.md", subdir="manuscript")
    report = project.load_json("manuscript_polish_audit.json", subdir="manuscript")

    assert "The pooled HR was 0.81 (95% CI 0.75 to 0.88) [2]." in draft
    assert "[1,2]" not in draft
    assert report["post_polish_citation_backfill"]["applied"] is True
    assert report["final_preservation_guard"]["applied"] is True
    assert "citations_changed" in report["final_preservation_guard"]["issue_codes"]


def test_polish_keeps_safe_grammar_cleanup_when_llm_candidate_is_rejected() -> None:
    manuscript = (
        "## Introduction\n\n"
        "SGLT2 inhibitors has been evaluated in randomized evidence against placebo [1]. "
        "This review asked: do SGLT2 inhibitors improve outcomes? .\n\n"
        "## References\n\n"
        "[1] Trial report.\n"
    )

    def unsafe_rewrite(section_text: str, meta: dict) -> str:
        return section_text.replace("randomized evidence", "randomized trials and observational cohorts")

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=unsafe_rewrite,
        enabled=True,
        max_rewrite_chunks=1,
        rewrite_scope="all",
    )

    assert "SGLT2 inhibitors have been evaluated" in polished
    assert "outcomes? ." not in polished
    assert "randomized trials and observational cohorts" not in polished
    assert report["rejected_chunks"] >= 1


def test_manuscript_polish_emits_chunk_progress_events_for_accepted_and_rejected_rewrites() -> None:
    manuscript = (
        "## Discussion\n\n"
        "SGLT2 inhibitors have been studied in heart failure populations against placebo [1].\n\n"
        "The pooled HR was 0.78 (95% CI 0.72 to 0.85), favoring treatment [1].\n\n"
        "## References\n\n"
        "[1] Trial report.\n"
    )
    events: list[dict] = []

    def rewrite(section_text: str, meta: dict) -> str:
        if meta.get("chunk_index") == 0:
            return section_text.replace("have been studied", "have been evaluated")
        return section_text.replace("0.78", "0.70")

    polished, report = polish_manuscript_text(
        manuscript,
        rewrite_fn=rewrite,
        enabled=True,
        max_rewrite_chars=120,
        max_rewrite_chunks=2,
        rewrite_scope="all",
        progress_cb=events.append,
    )

    assert "have been evaluated" in polished
    assert "The pooled HR was 0.78" in polished
    assert report["accepted_chunks"] == 1
    assert report["rejected_chunks"] == 1
    started = [item for item in events if item["event"] == "chunk_started"]
    accepted = [item for item in events if item["event"] == "chunk_accepted"]
    rejected = [item for item in events if item["event"] == "chunk_rejected"]
    retries = [item for item in events if item["event"] == "chunk_retry"]
    assert len(started) == 2
    assert len(accepted) == 1
    assert len(rejected) == 1
    assert len(retries) == 1
    assert started[0]["stage"] == "manuscript_polish"
    assert started[0]["heading"] == "Discussion"
    assert started[0]["chunk_index"] == 0
    assert started[0]["chunk_count"] == 2
    assert accepted[0]["accepted_chunks"] == 1
    assert rejected[0]["rejected_chunks"] == 1
    assert "numeric_tokens_changed" in rejected[0]["issue_codes"]


def test_post_polish_citation_audit_recommendations_are_applied_to_recommended_sentences(tmp_path) -> None:
    project = Project("post polish citation recommendation backfill", output_dir=tmp_path)
    draft = (
        "# Title\n\n"
        "## Introduction\n\n"
        "Heart failure with preserved ejection fraction has substantial clinical burden.\n\n"
        "## Methods\n\n"
        "Heterogeneity was assessed with I² and Cochran Q.\n\n"
        "## Results\n\n"
        "The pooled HR was 0.81 (95% CI 0.74 to 0.88) [1].\n\n"
        "## Discussion\n\n"
        "The findings should be interpreted alongside GRADE certainty.\n\n"
        "## References\n\n"
        "[1] Trial report.\n\n"
        "[2] Heart failure guideline.\n\n"
        "[3] Measuring inconsistency in meta-analyses.\n\n"
        "[4] GRADE guidelines.\n"
    )
    project.save_text("draft.md", draft, subdir="manuscript")
    project.save_json(
        "evidence_context.json",
        {"references": [{"citation": "[2]", "title": "Heart failure background review", "source_type": "pubmed_background"}]},
        subdir="search",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {"citation": "[3]", "title": "Measuring inconsistency in meta-analyses", "source_type": "statistical_method"},
                {"citation": "[4]", "title": "GRADE guidelines", "source_type": "certainty_framework"},
            ]
        },
        subdir="search",
    )

    audit_before = _build_citation_audit_review(project)
    assert audit_before["summary"]["uncited_introduction_background_claims"] == 1
    assert audit_before["summary"]["uncited_methods_methodology_claims"] == 1
    assert audit_before["summary"]["uncited_discussion_context_claims"] == 1

    updated, summary = main_module._apply_post_polish_citation_audit_backfill(project, draft, max_iterations=2)

    assert summary["applied"] is True
    assert summary["applied_citation_recommendations"] >= 3
    assert "clinical burden [2]." in updated
    assert "Cochran Q [3,4]." in updated
    assert "GRADE certainty [2,4]." in updated
    audit_after = _build_citation_audit_review(project)
    assert audit_after["summary"]["uncited_introduction_background_claims"] == 0
    assert audit_after["summary"]["uncited_methods_methodology_claims"] == 0
    assert audit_after["summary"]["uncited_discussion_context_claims"] == 0


def test_post_polish_citation_cleanup_limits_repeated_large_clusters(tmp_path) -> None:
    project = Project("post polish citation cluster cleanup", output_dir=tmp_path)
    draft = (
        "# 中文Meta分析稿件\n\n"
        "## 讨论\n\n"
        "第一段讨论基线风险和绝对获益［3，5，7，20，23］。\n\n"
        "第二段讨论安全性和肾功能［3，5，7，20，23］。\n\n"
        "第三段讨论指南适用性和亚组一致性［3，5，7，20，23］。\n\n"
        "第四段讨论发表偏倚和证据确定性［3，5，7，20，23］。\n\n"
        "## 参考文献\n\n"
        "［3］ GRADE guidance.\n"
        "［5］ Heart failure guideline.\n"
        "［7］ Prior systematic review.\n"
        "［20］ Mechanistic review.\n"
        "［23］ Bias in meta-analysis.\n"
    )
    project.save_text("draft.md", draft, subdir="manuscript")

    updated, summary = main_module._apply_post_polish_citation_audit_backfill(
        project,
        draft,
        max_iterations=0,
    )

    assert summary["applied"] is True
    assert summary["applied_citation_cleanup"] is True
    assert updated.count("［3，5，7，20，23］") <= 1
    repeated_large = [
        marker for marker in re.findall(r"［[0-9，、,;\s\-–—至]+］|\[[0-9,;\s\-–—]+\]", updated)
        if len(WritingAgent._citation_numbers_from_text(marker)) >= 4 and updated.count(marker) > 1
    ]
    assert repeated_large == []


def test_post_polish_citation_cleanup_smooths_mechanical_density(tmp_path) -> None:
    project = Project("post polish mechanical citation cleanup", output_dir=tmp_path)
    references = "\n".join(f"[{i}] Reference {i}." for i in range(1, 24))
    draft = (
        "# Manuscript\n\n"
        "## Discussion\n\n"
        "Publication bias is hard to judge in a sparse evidence base [23]. "
        "Absence of funnel-plot asymmetry cannot reassure readers when there are too few studies [18]. "
        "Confidence should rest more on trial size, directness, and outcome adjudication [12-14,18].\n\n"
        "## References\n\n"
        f"{references}\n"
    )
    project.save_text("draft.md", draft, subdir="manuscript")

    updated, summary = main_module._apply_post_polish_citation_audit_backfill(
        project,
        draft,
        max_iterations=0,
    )

    assert summary["applied"] is True
    assert summary["applied_citation_cleanup"] is True
    assert "too few studies [18]." not in updated
    final_audit = _build_citation_audit_review(project)
    assert final_audit["summary"]["mechanical_citation_density_paragraphs"] == 0


def test_citation_audit_backfill_restores_sentence_citations_after_cleanup(tmp_path) -> None:
    project = Project("post cleanup citation audit repair", output_dir=tmp_path)
    draft = (
        "# Manuscript\n\n"
        "## Methods\n\n"
        "GRADE certainty was interpreted in the context of pandemic-era trial conduct. "
        "Rapid recruitment, early stopping, open-label designs, and evolving background care can all affect confidence in the estimate [2]. "
        "At the same time, the mortality outcome is objective, and randomized allocation reduces confounding compared with observational reports [1]. "
        "The certainty profile therefore reports both the statistical result and the reasons confidence may remain less than high [3].\n\n"
        "## References\n\n"
        "[1] Trial report.\n\n"
        "[2] PRISMA reporting guideline.\n\n"
        "[3] GRADE guidelines.\n"
    )
    project.save_text("draft.md", draft, subdir="manuscript")
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {"citation": "[2]", "title": "PRISMA reporting guideline", "source_type": "reporting_guideline"},
                {"citation": "[3]", "title": "GRADE guidelines", "source_type": "certainty_framework"},
            ]
        },
        subdir="search",
    )

    updated, summary = main_module._apply_post_polish_citation_audit_backfill(
        project,
        draft,
        max_iterations=2,
    )

    assert summary["applied"] is True
    assert "pandemic-era trial conduct [3]." in updated
    final_audit = _build_citation_audit_review(project)
    assert final_audit["summary"]["uncited_methods_methodology_claims"] == 0


def test_post_cleanup_sentence_repair_rechecks_global_citation_density(tmp_path) -> None:
    project = Project("post cleanup density repair", output_dir=tmp_path)
    references = "\n\n".join(f"[{i}] Reference {i}." for i in range(1, 25))
    filler_blocks = []
    for index in range(4, 19):
        filler_words = " ".join(f"context{index}_{word}" for word in range(31))
        filler_blocks.append(
            f"{filler_words} This sentence supplies contextual evidence for the review [{index}]."
        )
    draft = (
        "# Manuscript\n\n"
        "## Methods\n\n"
        "GRADE certainty was interpreted in the context of pandemic-era trial conduct. "
        "Rapid recruitment and evolving care can affect confidence in estimates [2]. "
        "The certainty profile reports both the statistical result and the reasons confidence may remain less than high [24].\n\n"
        "## Discussion\n\n"
        + "\n\n".join(filler_blocks)
        + "\n\n## References\n\n"
        + references
        + "\n"
    )
    project.save_text("draft.md", draft, subdir="manuscript")
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {"citation": "[2]", "title": "PRISMA reporting guideline", "source_type": "reporting_guideline"},
                {"citation": "[24]", "title": "GRADE guidelines", "source_type": "certainty_framework"},
            ]
        },
        subdir="search",
    )

    updated, summary = main_module._apply_post_polish_citation_audit_backfill(
        project,
        draft,
        max_iterations=2,
    )

    assert "pandemic-era trial conduct [24]." in updated
    assert summary["post_cleanup_repair_recommendations"] >= 1
    final_audit = _build_citation_audit_review(project)
    assert final_audit["summary"]["uncited_methods_methodology_claims"] == 0
    assert final_audit["summary"]["excessive_citation_density"] is False
    assert final_audit["summary"]["warning_issues"] == 0


def test_post_polish_citation_cleanup_does_not_rotate_into_existing_range_clusters(tmp_path) -> None:
    project = Project("post polish citation range cluster cleanup", output_dir=tmp_path)
    discussion_paragraphs = [
        "第一段讨论主要试验和合并效应［4-6］。",
        "第二段讨论绝对获益和基线风险［4-6］。",
        "第三段讨论安全性和临床适用性［4-6］。",
        "第四段已有相邻背景引用［5-7］。",
        "第五段已有指南引用［7-9］。",
        "第六段已有机制引用［10-12］。",
        "第七段已有治疗背景引用［13-15］。",
        "第八段已有亚组引用［16-18］。",
        "第九段已有长期随访引用［19-21］。",
    ]
    references = "\n".join(f"［{idx}］ Reference {idx}." for idx in range(1, 24))
    draft = (
        "# 中文Meta分析稿件\n\n"
        "## 讨论\n\n"
        + "\n\n".join(discussion_paragraphs)
        + "\n\n## 参考文献\n\n"
        + references
        + "\n"
    )
    project.save_text("draft.md", draft, subdir="manuscript")

    updated, summary = main_module._apply_post_polish_citation_audit_backfill(
        project,
        draft,
        max_iterations=0,
    )

    assert summary["applied_citation_cleanup"] is True
    repeated_large = [
        marker for marker in re.findall(r"［[0-9，、,;\s\-–—至]+］|\[[0-9,;\s\-–—]+\]", updated)
        if len(WritingAgent._citation_numbers_from_text(marker)) >= 3 and updated.count(marker) > 1
    ]
    assert repeated_large == []


def test_cli_manuscript_polish_persists_disabled_requested_language(monkeypatch, tmp_path) -> None:
    project = Project("cli polish disabled language record", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        "# 中文稿件\n\n## 讨论\n\n合并OR为0.66［1］。\n\n## 参考文献\n\n［1］ Example.\n",
        subdir="manuscript",
    )

    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", False)

    main_module._polish_project_manuscript(
        project,
        SimpleNamespace(polish_manuscript=False, no_polish_manuscript=True),
        model=None,
        lang="zh",
    )

    language_record = project.load_json("manuscript_output_language.json", subdir="manuscript")
    assert language_record["expected_language"] == "zh"
    assert language_record["output_language"] == "zh"
    assert language_record["polish_enabled"] is False


def test_cli_no_polish_defers_citation_grounding_to_final_llm_review(monkeypatch, tmp_path) -> None:
    project = Project("no polish citation grounding deferred", output_dir=tmp_path)
    draft = (
        "# Manuscript\n\n"
        "## Methods\n\n"
        "Heterogeneity was assessed with I² and Cochran Q.\n\n"
        "GRADE certainty was interpreted in the context of pandemic-era trial conduct.\n\n"
        "## References\n\n"
        "[1] Trial report.\n\n"
        "[2] Measuring inconsistency in meta-analyses.\n\n"
        "[3] GRADE guidelines.\n"
    )
    project.save_text("draft.md", draft, subdir="manuscript")
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {"citation": "[2]", "title": "Measuring inconsistency in meta-analyses", "source_type": "statistical_method"},
                {"citation": "[3]", "title": "GRADE guidelines", "source_type": "certainty_framework"},
            ]
        },
        subdir="search",
    )
    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", False)

    result = main_module._polish_project_manuscript(
        project,
        SimpleNamespace(polish_manuscript=False, no_polish_manuscript=True),
        model=None,
        lang="en",
    )

    assert result is None
    updated = (project.base_dir / "manuscript" / "draft.md").read_text(encoding="utf-8")
    assert "Cochran Q [2]." not in updated
    assert "pandemic-era trial conduct [3]." not in updated
    audit_after = _build_citation_audit_review(project)
    assert audit_after["summary"]["uncited_methods_methodology_claims"] >= 1
    report = project.load_json("manuscript_polish_audit.json", subdir="manuscript")
    assert report["enabled"] is False
    assert report["post_polish_citation_audit_backfill"]["mode"] == "skipped_no_polish_semantic_citation_grounding_deferred_to_final_llm_review"
    assert report["post_polish_citation_audit_backfill"]["applied"] is False


def test_web_manuscript_polish_helper_honors_requested_output_language(monkeypatch, tmp_path) -> None:
    from start import _polish_web_manuscript

    project = Project("web polish requested language", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Discussion\n\n"
            f"{_web_clinical_discussion_text(citation='[1]', effect='OR 0.66 (95% CI 0.53 to 0.82)', endpoint='mortality')}\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    calls: list[dict] = []

    def fake_polish(project_arg, args, *, model, lang):
        calls.append({"project": project_arg, "args": args, "model": model, "lang": lang})
        return "polished manuscript"

    monkeypatch.setattr(main_module, "_polish_project_manuscript", fake_polish)

    polished = _polish_web_manuscript(
        project,
        payload={"polish_manuscript": True, "output_language": "中文", "manuscript_polish_scope": "all"},
        model="qwen-plus",
        lang="en",
    )

    assert polished == "polished manuscript"
    assert calls[0]["lang"] == "zh"
    assert calls[0]["args"].polish_manuscript is True
    assert calls[0]["args"].manuscript_polish_scope == "all"


def test_web_manuscript_polish_helper_forwards_progress_callback(monkeypatch, tmp_path) -> None:
    from start import _polish_web_manuscript

    project = Project("web polish progress", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        "# Title\n\n## Discussion\n\nThe pooled HR was 0.78 [1].\n\n## References\n\n[1] Trial report.\n",
        subdir="manuscript",
    )
    progress_events: list[dict] = []
    progress_cb = progress_events.append
    calls: list[dict] = []

    def fake_polish(project_arg, args, *, model, lang, progress_cb=None):
        calls.append({"progress_cb": progress_cb, "lang": lang})
        if progress_cb:
            progress_cb({"stage": "manuscript_polish", "event": "section_started"})
        return "polished manuscript"

    monkeypatch.setattr(main_module, "_polish_project_manuscript", fake_polish)

    polished = _polish_web_manuscript(
        project,
        payload={"polish_manuscript": True},
        model="qwen-plus",
        lang="en",
        progress_cb=progress_cb,
    )

    assert polished == "polished manuscript"
    assert calls[0]["progress_cb"] is progress_cb
    assert progress_events == [{"stage": "manuscript_polish", "event": "section_started"}]


def test_web_manuscript_quality_payload_summarizes_citation_and_polish_audits(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web manuscript quality", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Background statement [1].\n\n"
            "## Methods\n\n"
            "We followed PRISMA [2].\n\n"
            "## Results\n\n"
            "The pooled OR was 0.66 [1].\n\n"
            "## Discussion\n\n"
            f"{_web_clinical_discussion_text(citation='[1]', effect='OR 0.66', endpoint='mortality')}\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] PRISMA statement.\n"
        ),
        subdir="manuscript",
    )
    project.save_text(
        "references.bib",
        "@article{trial,title={Trial report}}\n\n@article{prisma,title={PRISMA statement}}",
    )
    project.save_json(
        "methodology_context.json",
        {"references": [{"citation": "[2]", "title": "PRISMA statement", "source_type": "reporting_guideline"}]},
        subdir="search",
    )
    project.save_json(
        "evidence_context.json",
        {"references": [{"citation": "[1]", "title": "Trial report", "source_type": "included_trial"}]},
        subdir="search",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "rewrite_scope": "targeted",
            "accepted_chunks": 2,
            "rejected_chunks": 0,
            "unchanged_chunks": 1,
            "attempted_chunks": 3,
            "skipped_chunks": 1,
            "total_rewrite_chunks": 4,
            "targeted_chunks": 3,
            "non_target_chunks": 1,
            "rewrite_retries": 2,
            "retry_recovered_chunks": 1,
            "polish_budget_exhausted": True,
            "skipped_chunk_details": [
                {
                    "heading": "Discussion",
                    "chunk_index": 2,
                    "chunk_count": 4,
                    "reason": "polish_budget_exhausted",
                    "original_text": "It is important to note that skipped paragraph reports RR 0.73 [1].",
                    "kept_text": "Skipped paragraph reports RR 0.73 [1].",
                    "deterministic_cleanup_applied": True,
                    "review_action": "rerun_with_higher_polish_budget",
                }
            ],
            "accepted_edit_count": 1,
            "accepted_edits": [
                {
                    "heading": "Discussion",
                    "chunk_index": 0,
                    "chunk_count": 1,
                    "original_text": "It is important to note that the pooled OR was 0.66 [1].",
                    "candidate_text": "The pooled OR was 0.66 [1].",
                    "diff": "--- original\n+++ polished\n@@ -1 +1 @@\n-It is important to note that the pooled OR was 0.66 [1].\n+The pooled OR was 0.66 [1].",
                    "review_action": "accepted_fact_preserving_polish",
                }
            ],
            "issues": [],
        },
        subdir="manuscript",
    )
    ctx: dict = {}

    payload = _load_manuscript_quality_payload(project, ctx)

    assert payload["type"] == "manuscript_quality"
    assert payload["action_required"] is False
    assert payload["review_required"] is True
    assert payload["quality_status"] == "needs_review"
    assert any(warning["code"] == "polish_budget_exhausted" for warning in payload["warnings"])
    assert payload["reference_entries"] == 2
    assert payload["citation_audit"]["passed"] is True
    assert payload["citation_audit"]["summary"]["methods_inline_citations"] == 1
    assert payload["polish"]["enabled"] is True
    assert payload["polish"]["accepted_chunks"] == 2
    assert payload["polish"]["rewrite_scope"] == "targeted"
    assert payload["polish"]["attempted_chunks"] == 3
    assert payload["polish"]["skipped_chunks"] == 1
    assert payload["polish"]["total_rewrite_chunks"] == 4
    assert payload["polish"]["targeted_chunks"] == 3
    assert payload["polish"]["non_target_chunks"] == 1
    assert payload["polish"]["rewrite_retries"] == 2
    assert payload["polish"]["retry_recovered_chunks"] == 1
    assert payload["polish"]["polish_budget_exhausted"] is True
    assert payload["polish"]["skipped_chunk_details"][0]["heading"] == "Discussion"
    assert "RR 0.73" in payload["polish"]["skipped_chunk_details"][0]["kept_text"]
    assert payload["polish"]["accepted_edit_count"] == 1
    assert payload["polish"]["accepted_edits"][0]["heading"] == "Discussion"
    assert "It is important to note" in payload["polish"]["accepted_edits"][0]["original_text"]
    queue = payload["polish"]["review_queue"]
    assert queue["status"] == "budget_review_required"
    assert queue["accepted_auto_edits"] == 1
    assert queue["rewrite_retries"] == 2
    assert queue["retry_recovered_chunks"] == 1
    assert queue["manual_review_items"] == 1
    assert queue["budget_exhausted"] is True
    assert any("chunk budget" in action for action in queue["next_actions"])
    assert payload["methodology_context"]["reference_count"] == 1
    assert payload["evidence_context"]["reference_count"] == 1
    assert ctx["citation_audit_passed"] is True
    assert ctx["n_reference_entries"] == 2


def test_web_manuscript_quality_payload_surfaces_clinical_interpretation_failures(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web manuscript clinical interpretation", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Meta-analysis manuscript\n\n"
            "## Abstract\n\n"
            "**Importance:** The clinical topic needs synthesis.\n"
            "**Objective:** To estimate treatment effects.\n"
            "**Data sources:** PubMed.\n"
            "**Study selection:** Randomized trials.\n"
            "**Data extraction and synthesis:** Aggregate data were synthesized.\n"
            "**Main outcome and measures:** Cardiovascular events.\n"
            "**Results:** Two studies contributed data.\n"
            "**Conclusions and relevance:** Treatment may reduce events.\n\n"
            "## Introduction\n\n"
            "The clinical question needs a systematic review [1].\n\n"
            "## Methods\n\n"
            "Randomized trials were synthesized [1].\n\n"
            "## Results\n\n"
            "The pooled estimate favored treatment [1].\n\n"
            "## Discussion\n\n"
            "The main value of this review is transparent traceability from extracted rows to the final manuscript. "
            "Readers can inspect the source audit, calculation files, and generated tables to confirm that the "
            "same numeric fields were used across sections.\n\n"
            "## Conclusion\n\n"
            "The manuscript provides a transparent summary.\n\n"
            "## References\n\n"
            "[1] Smith J. Trial report.\n"
        ),
        subdir="manuscript",
    )
    project.save_text("references.bib", "@article{smith,title={Trial report}}")
    project.save_json("manuscript_facts.json", {"report_type": "meta"}, subdir="manuscript")

    ctx: dict = {}
    payload = _load_manuscript_quality_payload(project, ctx)

    warning_codes = {warning["code"] for warning in payload["warnings"]}
    assert "clinical_interpretation_issues" in warning_codes
    assert payload["clinical_interpretation_audit"]["passed"] is False
    assert payload["clinical_interpretation_audit"]["summary"]["failed_issues"] == 1
    assert payload["clinical_interpretation_audit"]["summary"]["covered_domains"] < payload["clinical_interpretation_audit"]["summary"]["minimum_domains"]
    issue = next(item for item in payload["actionable_issues"] if item["source"] == "clinical_interpretation")
    assert issue["code"] == "clinical_interpretation_depth_low"
    assert issue["severity"] == "fail"
    assert issue["target"]["type"] == "markdown_section"
    assert issue["remediation"]["kind"] == "rewrite_discussion_clinical_interpretation"
    assert payload["review_contract"]["clinical_interpretation"]["review_type"] == "clinical_interpretation_depth_audit"
    assert ctx["n_clinical_interpretation_failed_issues"] == 1
    assert ctx["n_clinical_interpretation_covered_domains"] < ctx["n_clinical_interpretation_minimum_domains"]


def test_web_manuscript_quality_payload_blocks_requested_chinese_when_draft_is_english(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web manuscript language mismatch zh", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Sodium-glucose cotransporter 2 inhibitors in heart failure\n\n"
            "## Introduction\n\n"
            "Heart failure with preserved ejection fraction is a major clinical burden [1].\n\n"
            "## Methods\n\n"
            "We searched PubMed and ClinicalTrials.gov according to a prespecified protocol [2].\n\n"
            "## Results\n\n"
            "The pooled hazard ratio favored SGLT2 inhibitors [1].\n\n"
            "## Discussion\n\n"
            "The findings should be interpreted alongside trial eligibility criteria [2].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] Protocol.\n"
        ),
        subdir="manuscript",
    )
    project.save_text(
        "references.bib",
        "@article{trial,title={Trial report}}\n\n@article{protocol,title={Protocol}}",
    )
    project.save_json(
        "manuscript_output_language.json",
        {
            "schema_version": 1,
            "expected_language": "zh",
            "output_language": "zh",
            "source": "pipeline_requested_output_language",
            "polish_enabled": True,
        },
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {"enabled": True, "language": "zh", "accepted_chunks": 0, "rejected_chunks": 0},
        subdir="manuscript",
    )

    ctx: dict = {}
    payload = _load_manuscript_quality_payload(project, ctx)

    assert payload["language_gate"]["expected_language"] == "zh"
    assert payload["language_gate"]["detected_language"] == "en"
    assert payload["language_gate"]["matched"] is False
    assert payload["action_required"] is True
    assert payload["quality_status"] == "blocked"
    warning = next(item for item in payload["warnings"] if item["code"] == "manuscript_language_mismatch")
    assert warning["expected_language"] == "zh"
    assert warning["detected_language"] == "en"
    assert "中文" in warning["message"]
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "requested_language_mismatch")
    assert issue["source"] == "manuscript_language"
    assert issue["severity"] == "fail"
    assert issue["target"]["type"] == "manuscript"
    assert issue["target"]["expected_language"] == "zh"
    assert "重新生成" in issue["suggested_action"]
    assert ctx["manuscript_expected_language"] == "zh"
    assert ctx["manuscript_detected_language"] == "en"
    assert ctx["manuscript_language_matches_expected"] is False


def test_web_manuscript_quality_payload_localizes_language_mismatch_for_chinese_draft(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web manuscript language mismatch en", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# SGLT2抑制剂治疗心力衰竭\n\n"
            "## 引言\n\n"
            "射血分数保留型心力衰竭具有较高疾病负担［1］。\n\n"
            "## 方法\n\n"
            "我们按照预设方案检索PubMed和ClinicalTrials.gov［2］。\n\n"
            "## 结果\n\n"
            "合并HR提示SGLT2抑制剂降低主要复合结局风险［1］。\n\n"
            "## 讨论\n\n"
            "结果需要结合试验纳排标准和随访时间解释［2］。\n\n"
            "## 参考文献\n\n"
            "［1］ 试验报告。\n\n"
            "［2］ 研究方案。\n"
        ),
        subdir="manuscript",
    )
    project.save_text(
        "references.bib",
        "@article{trial,title={Trial report}}\n\n@article{protocol,title={Protocol}}",
    )
    project.save_json(
        "manuscript_output_language.json",
        {
            "schema_version": 1,
            "expected_language": "en",
            "output_language": "en",
            "source": "pipeline_requested_output_language",
            "polish_enabled": True,
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})

    warning = next(item for item in payload["warnings"] if item["code"] == "manuscript_language_mismatch")
    assert payload["language_gate"]["expected_language"] == "en"
    assert payload["language_gate"]["detected_language"] == "zh"
    assert warning["expected_language"] == "en"
    assert warning["detected_language"] == "zh"
    assert "英文" in warning["message"]
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "requested_language_mismatch")
    assert issue["source"] == "manuscript_language"
    assert "英文" in issue["suggested_action"]
    assert issue["remediation"]["can_auto_apply"] is False


def test_web_manuscript_quality_payload_blocks_heading_only_translation(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web manuscript mixed language", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# SGLT2抑制剂治疗心力衰竭\n\n"
            "## 引言\n\n"
            "Heart failure with preserved ejection fraction is a major clinical syndrome with high "
            "morbidity, recurrent hospitalization, and limited disease-modifying treatment options [1]. "
            "Prior cardiovascular outcome trials suggested that sodium-glucose cotransporter 2 inhibitors "
            "may reduce heart failure events across diabetic and non-diabetic populations [2].\n\n"
            "## 方法\n\n"
            "We searched PubMed, Embase, ClinicalTrials.gov, and trial registries from inception to "
            "May 2026 using predefined eligibility criteria for randomized controlled trials [3]. "
            "Two reviewers screened records, extracted hazard ratios, and assessed risk of bias according "
            "to a prespecified protocol.\n\n"
            "## 结果\n\n"
            "The pooled hazard ratio favored SGLT2 inhibitors for the primary composite outcome, but "
            "certainty depended on event definitions, follow-up duration, and trial-level eligibility [1].\n\n"
            "## 讨论\n\n"
            "These results support a clinically coherent class effect, although applicability should be "
            "considered in relation to baseline ejection fraction, kidney function, and background therapy [2].\n\n"
            "## 参考文献\n\n"
            "［1］ Trial report.\n\n"
            "［2］ Background review.\n\n"
            "［3］ Reporting guideline.\n"
        ),
        subdir="manuscript",
    )
    project.save_text(
        "references.bib",
        (
            "@article{trial,title={Trial report}}\n\n"
            "@article{background,title={Background review}}\n\n"
            "@article{guideline,title={Reporting guideline}}"
        ),
    )
    project.save_json(
        "manuscript_output_language.json",
        {
            "schema_version": 1,
            "expected_language": "zh",
            "output_language": "zh",
            "source": "pipeline_requested_output_language",
            "polish_enabled": True,
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})

    assert payload["language_gate"]["expected_language"] == "zh"
    assert payload["language_gate"]["detected_language"] == "mixed"
    assert payload["language_gate"]["matched"] is False
    warning = next(item for item in payload["warnings"] if item["code"] == "manuscript_language_mismatch")
    assert "mixed" in warning["message"].lower()
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "requested_language_mismatch")
    assert "do not only translate headings" in issue["suggested_action"].lower()


def test_web_manuscript_quality_payload_surfaces_llm_reliability_warnings(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web llm reliability quality", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Background statement [1].\n\n"
            "## Methods\n\n"
            "We followed PRISMA [2].\n\n"
            "## Results\n\n"
            "The pooled OR was 0.66 [1].\n\n"
            "## Discussion\n\n"
            f"{_web_clinical_discussion_text(citation='[1]', effect='OR 0.66', endpoint='mortality')}\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] PRISMA statement.\n"
        ),
        subdir="manuscript",
    )
    project.save_text(
        "references.bib",
        "@article{trial,title={Trial report}}\n\n@article{prisma,title={PRISMA statement}}",
    )
    project.save_json(
        "llm_usage_manifest.json",
        {
            "schema_version": 1,
            "summary": {
                "total_calls": 2,
                "prompt_tokens": 300,
                "completion_tokens": 600,
                "total_tokens": 900,
                "estimated_cost_usd": 0.001,
                "retryable_output_issues": 1,
                "near_truncation_events": 1,
                "output_reliability_warnings": 1,
            },
            "events": [
                {
                    "timestamp": "2026-05-23T00:00:00Z",
                    "model": "qwen3.6-plus",
                    "endpoint": "chat.completions",
                    "prompt_tokens": 100,
                    "completion_tokens": 512,
                    "total_tokens": 612,
                    "max_tokens": 512,
                    "finish_reason": "length",
                    "retryable_output_issue": "truncated",
                    "near_truncation": True,
                },
                {
                    "timestamp": "2026-05-23T00:00:01Z",
                    "model": "qwen3.6-plus",
                    "endpoint": "chat.completions",
                    "prompt_tokens": 200,
                    "completion_tokens": 88,
                    "total_tokens": 288,
                    "max_tokens": 1536,
                    "finish_reason": "stop",
                    "retryable_output_issue": "",
                    "near_truncation": False,
                },
            ],
        },
    )

    ctx: dict = {}
    payload = _load_manuscript_quality_payload(project, ctx)

    warning = next(item for item in payload["warnings"] if item["code"] == "llm_reliability_warnings")
    assert payload["action_required"] is False
    assert payload["review_required"] is True
    assert payload["quality_status"] == "needs_review"
    assert payload["llm_reliability"]["summary"]["retryable_output_issues"] == 1
    assert payload["llm_reliability"]["summary"]["near_truncation_events"] == 1
    assert payload["llm_reliability"]["issues"][0]["code"] == "llm_retryable_output_issue"
    actionable = next(item for item in payload["actionable_issues"] if item["source"] == "llm_reliability")
    assert actionable["code"] == "llm_retryable_output_issue"
    assert actionable["event_index"] == 1
    assert actionable["model"] == "qwen3.6-plus"
    assert actionable["review"]["retryable_output_issue"] == "truncated"
    assert actionable["review"]["near_truncation"] is True
    assert actionable["remediation"]["kind"] == "rerun_generation_stage"
    assert actionable["remediation"]["current_max_tokens"] == 512
    assert actionable["remediation"]["recommended_max_tokens"] == 1536
    assert actionable["remediation"]["can_auto_apply"] is False
    assert actionable["remediation"]["requires_human_review"] is True
    assert "generated section" in actionable["suggested_action"].lower()
    assert warning["retryable_output_issues"] == 1
    assert warning["near_truncation_events"] == 1
    assert warning["actionable_issue_count"] == 2
    assert "review" in warning["message"].lower()
    assert ctx["n_llm_retryable_output_issues"] == 1
    assert ctx["n_llm_near_truncation_events"] == 1


def test_web_manuscript_quality_payload_surfaces_primary_result_and_claim_support_failures(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web primary result claim support quality", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Claim support manuscript\n\n"
            "## Abstract\n\n"
            "The pooled HR was 0.90 (95% CI 0.80 to 1.01), suggesting no clear reduction [1].\n\n"
            "## Methods\n\n"
            "We searched PubMed and trial registries according to a prespecified protocol [2].\n\n"
            "## Results\n\n"
            "The primary meta-analysis included 2 trials totaling 60 participants. "
            "There were 4/30 events in the intervention groups and 8/30 events in the control groups. "
            "The pooled HR was 0.90 (95% CI 0.74 to 0.88), and certainty was High [1].\n\n"
            "## Discussion\n\n"
            "The primary finding was interpreted against the prespecified endpoint [2].\n\n"
            "## References\n\n"
            "[1] Example trial.\n\n"
            "[2] Protocol.\n"
        ),
        subdir="manuscript",
    )
    project.save_text(
        "references.bib",
        "@article{trial,title={Example trial}}\n\n@article{protocol,title={Protocol}}",
    )
    selected_rows = [
        {
            "row_id": "S1:0",
            "study_id": "S1",
            "study_label": "Trial 1",
            "outcome_name": "Composite endpoint",
            "events_intervention": 1,
            "total_intervention": 10,
            "events_control": 2,
            "total_control": 10,
            "source_quote_verified": True,
        },
        {
            "row_id": "S2:0",
            "study_id": "S2",
            "study_label": "Trial 2",
            "outcome_name": "Composite endpoint",
            "events_intervention": 3,
            "total_intervention": 20,
            "events_control": 6,
            "total_control": 20,
            "source_quote_verified": True,
        },
    ]
    project.save_json(
        "manuscript_facts.json",
        {
            "report_type": "meta",
            "primary_effect": {
                "outcome_name": "Composite endpoint",
                "effect_measure": "HR",
                "n_studies": 2,
                "pooled_effect": 0.81,
                "ci_lower": 0.74,
                "ci_upper": 0.88,
            },
            "grade": {
                "outcomes": [
                    {
                        "outcome_name": "Composite endpoint",
                        "certainty": "High",
                        "effect_summary": "HR 0.81 (95% CI: 0.74 to 0.88)",
                    }
                ]
            },
            "evidence_readiness": {
                "status": "ready",
                "blockers": [],
                "selected_primary_rows": selected_rows,
            },
        },
        subdir="manuscript",
    )
    project.save_json(
        "meta_results.json",
        {
            "primary_outcome": {
                "outcome_name": "Composite endpoint",
                "n_studies": 2,
                "effect_measure": "HR",
                "pooled_effect": 0.81,
                "ci_lower": 0.74,
                "ci_upper": 0.88,
                "model": "fixed",
                "studies": [
                    {"study_id": "S1", "study_label": "Trial 1", "yi": -0.21, "vi": 0.04, "se": 0.2, "weight": 50.0},
                    {"study_id": "S2", "study_label": "Trial 2", "yi": -0.22, "vi": 0.04, "se": 0.2, "weight": 50.0},
                ],
            }
        },
        subdir="analysis",
    )
    project.save_json("manuscript_validation.json", {"passed": True, "issues": []}, subdir="manuscript")

    ctx: dict = {}
    payload = _load_manuscript_quality_payload(project, ctx)

    assert payload["primary_result_audit"]["summary"]["mismatched_fields"] == 1
    assert payload["claim_support_audit"]["summary"]["unsupported_claims"] == 2
    assert payload["action_required"] is True
    assert payload["quality_status"] == "blocked"
    warning_codes = {warning["code"] for warning in payload["warnings"]}
    assert "primary_result_mismatch" in warning_codes
    assert "claim_support_issues" in warning_codes
    primary_issue = next(item for item in payload["actionable_issues"] if item["source"] == "primary_result")
    assert primary_issue["code"] == "primary_result_field_missing"
    assert primary_issue["target"]["field"] == "pooled_effect"
    assert "0.81" in primary_issue["message"]
    claim_issue = next(item for item in payload["actionable_issues"] if item["source"] == "claim_support")
    assert claim_issue["code"] == "unsupported_manuscript_claim"
    assert "0.90" in claim_issue["snippet"]
    assert claim_issue["remediation"]["can_auto_apply"] is False
    assert ctx["n_primary_result_mismatched_fields"] == 1
    assert ctx["n_claim_support_unsupported_claims"] == 2


def test_manuscript_quality_delta_tracks_primary_result_and_claim_support_resolution() -> None:
    from start import _manuscript_quality_delta

    before = {
        "quality_status": "blocked",
        "action_required": True,
        "review_required": True,
        "reference_entries": 12,
        "primary_result_audit": {
            "passed": False,
            "summary": {"mismatched_fields": 2, "failed_issues": 2},
        },
        "claim_support_audit": {
            "passed": False,
            "summary": {"unsupported_claims": 1, "failed_issues": 1},
        },
        "actionable_issues": [
            {"id": "primary_result:0:pooled_effect", "source": "primary_result"},
            {"id": "primary_result:1:ci_lower", "source": "primary_result"},
            {"id": "claim_support:0:primary_effect", "source": "claim_support"},
        ],
    }
    after = {
        "quality_status": "ready",
        "action_required": False,
        "review_required": False,
        "reference_entries": 12,
        "primary_result_audit": {
            "passed": True,
            "summary": {"mismatched_fields": 0, "failed_issues": 0},
        },
        "claim_support_audit": {
            "passed": True,
            "summary": {"unsupported_claims": 0, "failed_issues": 0},
        },
        "actionable_issues": [],
    }

    delta = _manuscript_quality_delta(before, after)

    assert delta["primary_result_mismatched_fields_before"] == 2
    assert delta["primary_result_mismatched_fields_after"] == 0
    assert delta["primary_result_mismatched_fields_resolved"] == 2
    assert delta["claim_support_unsupported_claims_before"] == 1
    assert delta["claim_support_unsupported_claims_after"] == 0
    assert delta["claim_support_unsupported_claims_resolved"] == 1
    assert delta["primary_result_audit_passed_after"] is True
    assert delta["claim_support_audit_passed_after"] is True
    assert delta["resolved_primary_result_issue_ids"] == [
        "primary_result:0:pooled_effect",
        "primary_result:1:ci_lower",
    ]
    assert delta["resolved_claim_support_issue_ids"] == ["claim_support:0:primary_effect"]


def test_web_manuscript_quality_payload_includes_frontend_review_contract(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web manuscript quality contract", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Background statement [1].\n\n"
            "## Methods\n\n"
            "We searched PubMed and screened records according to predefined eligibility criteria.\n\n"
            "## Results\n\n"
            "The pooled OR was 0.66 [1].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted with GRADE [1].\n\n"
            "## References\n\n"
            "[1] Trial report.\n"
        ),
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    contract = payload["review_contract"]

    assert contract["schema_version"] == 1
    assert contract["citation_patch"]["preview_request_type"] == "manuscript_citation_patch_preview"
    assert contract["citation_patch"]["apply_request_type"] == "manuscript_citation_patch_apply"
    assert contract["citation_patch"]["requires_expected_revision"] is True
    assert contract["citation_patch"]["apply_response_fields"] == ["manuscript_quality", "quality_delta"]
    assert contract["reference_add"]["preview_request_type"] == "manuscript_reference_add_preview"
    assert contract["reference_add"]["apply_request_type"] == "manuscript_reference_add_apply"
    assert contract["reference_add"]["requires_human_review"] is True
    assert contract["reference_add"]["requires_expected_revision"] is True
    assert contract["reference_add"]["apply_response_fields"] == ["manuscript_quality", "quality_delta"]
    assert contract["reference_add_batch"]["preview_request_type"] == "manuscript_reference_add_batch_preview"
    assert contract["reference_add_batch"]["apply_request_type"] == "manuscript_reference_add_batch_apply"
    assert contract["reference_add_batch"]["requires_human_review"] is True
    assert contract["reference_add_batch"]["requires_expected_revision"] is True
    assert contract["reference_add_batch"]["item_fields"] == ["issue_id", "candidate_id", "target_section"]
    assert contract["reference_add_batch"]["apply_response_fields"] == ["manuscript_quality", "quality_delta"]
    assert contract["polish_guard"]["can_auto_apply_rejected_edits"] is False
    assert contract["polish_guard"]["review_action"] == "manual_review_required"
    assert contract["llm_reliability"]["can_auto_apply"] is False
    assert contract["llm_reliability"]["review_action"] == "manual_review_required"
    assert contract["llm_reliability"]["remediation_kind"] == "rerun_generation_stage"
    assert contract["llm_reliability"]["remediation_fields"] == [
        "kind",
        "current_max_tokens",
        "recommended_max_tokens",
        "can_auto_apply",
        "requires_human_review",
    ]


def test_web_manuscript_quality_payload_recommends_section_appropriate_citations(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web section-aware citation quality", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Source-aware citation manuscript\n\n"
            "## Introduction\n\n"
            "The disease burden and prior evidence base remain clinically important [1].\n\n"
            "## Methods\n\n"
            "This systematic review followed predefined eligibility and certainty assessment methods [1].\n\n"
            "## Results\n\n"
            "Two trials contributed primary outcome data [1].\n\n"
            "## Discussion\n\n"
            "The findings should be compared with existing guidance [1].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] PRISMA 2020 statement.\n\n"
            "[3] GRADE guidance.\n\n"
            "[4] Heart failure clinical guideline.\n\n"
            "[5] Prior systematic review.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {
                    "study_id": "methodology:prisma",
                    "citation": "[2]",
                    "source_type": "reporting_guideline",
                    "title": "PRISMA 2020 statement",
                },
                {
                    "study_id": "methodology:grade",
                    "citation": "[3]",
                    "source_type": "certainty_framework",
                    "title": "GRADE guidance",
                },
            ]
        },
        subdir="search",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evidence:guideline",
                    "citation": "[4]",
                    "source_type": "guideline",
                    "title": "Heart failure clinical guideline",
                },
                {
                    "study_id": "evidence:review",
                    "citation": "[5]",
                    "source_type": "prior_review",
                    "title": "Prior systematic review",
                },
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})

    intro_issue = next(
        item for item in payload["actionable_issues"]
        if item["code"] == "introduction_background_citations_missing"
    )
    methods_issue = next(
        item for item in payload["actionable_issues"]
        if item["code"] == "methods_methodology_citations_missing"
    )
    assert [item["citation"] for item in intro_issue["recommended_citations"]] == ["[4]", "[5]"]
    assert [item["citation"] for item in methods_issue["recommended_citations"]] == ["[2]", "[3]"]
    assert "[4]" in intro_issue["suggested_action"]
    assert "[2]" in methods_issue["suggested_action"]


def test_web_manuscript_quality_payload_warns_when_discussion_lacks_context_citations(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web discussion context citation quality", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Source-aware citation manuscript\n\n"
            "## Introduction\n\n"
            "The disease burden and prior evidence base remain clinically important [4].\n\n"
            "## Methods\n\n"
            "This systematic review followed predefined eligibility and certainty assessment methods [2].\n\n"
            "## Results\n\n"
            "Two trials contributed primary outcome data [1].\n\n"
            "## Discussion\n\n"
            "The findings should be compared with existing guidance and certainty limitations [1].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] PRISMA 2020 statement.\n\n"
            "[3] GRADE guidance.\n\n"
            "[4] Heart failure clinical guideline.\n\n"
            "[5] Prior systematic review.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {
                    "study_id": "methodology:prisma",
                    "citation": "[2]",
                    "source_type": "reporting_guideline",
                    "title": "PRISMA 2020 statement",
                },
                {
                    "study_id": "methodology:grade",
                    "citation": "[3]",
                    "source_type": "certainty_framework",
                    "title": "GRADE guidance",
                },
            ]
        },
        subdir="search",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evidence:guideline",
                    "citation": "[4]",
                    "source_type": "guideline",
                    "title": "Heart failure clinical guideline",
                },
                {
                    "study_id": "evidence:review",
                    "citation": "[5]",
                    "source_type": "prior_review",
                    "title": "Prior systematic review",
                },
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    discussion_issue = next(
        item for item in payload["actionable_issues"]
        if item["code"] == "discussion_context_citations_missing"
    )

    assert payload["citation_audit"]["summary"]["discussion_context_inline_citations"] == 0
    assert [item["citation"] for item in discussion_issue["recommended_citations"]] == ["[4]", "[5]", "[3]"]
    assert discussion_issue["section"] == "Discussion"
    assert "[4]" in discussion_issue["suggested_action"]


def test_citation_audit_warns_about_overloaded_citation_clusters(tmp_path) -> None:
    project = Project("citation cluster audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important across populations [1,2,3,4,5,6,7].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "The pooled HR was 0.81 [1].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [2].\n\n"
            "## References\n\n"
            + "\n\n".join(f"[{index}] Reference {index}." for index in range(1, 8))
        ),
        subdir="manuscript",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "overloaded_citation_cluster")

    assert audit["summary"]["overloaded_citation_clusters"] == 1
    assert issue["severity"] == "warn"
    assert issue["section"] == "Introduction"
    assert issue["cluster_size"] == 7
    assert issue["maximum_cluster_size"] == 5
    assert issue["citation_numbers"] == [1, 2, 3, 4, 5, 6, 7]


def test_web_manuscript_quality_payload_explains_overloaded_citation_cluster(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web overloaded citation cluster", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important across populations [1,2,3,4,5,6,7].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "The pooled HR was 0.81 [1].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [2].\n\n"
            "## References\n\n"
            + "\n\n".join(f"[{index}] Reference {index}." for index in range(1, 8))
        ),
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "overloaded_citation_cluster")

    assert issue["source"] == "citation_audit"
    assert "split" in issue["suggested_action"].lower()
    assert "specific claim" in issue["suggested_action"].lower()
    assert issue["raw_issue"]["citation_numbers"] == [1, 2, 3, 4, 5, 6, 7]


def test_citation_audit_warns_about_uncited_numeric_effect_claims(tmp_path) -> None:
    project = Project("uncited numeric effect audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [1].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "The pooled HR was 0.81 (95% CI 0.75 to 0.88). "
            "Two trial reports contributed data [1].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [2].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] Prior review.\n"
        ),
        subdir="manuscript",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "uncited_numeric_effect_claim")

    assert audit["summary"]["uncited_numeric_effect_claims"] == 1
    assert issue["severity"] == "warn"
    assert issue["section"] == "Results"
    assert "pooled HR was 0.81" in issue["evidence_excerpt"]
    assert issue["sentence_index"] == 1


def test_citation_audit_warns_about_uncited_results_study_data_claims(tmp_path) -> None:
    project = Project("uncited results study data audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [1].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two included trials contributed primary outcome data. "
            "The pooled HR was 0.82 [2].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [1].\n\n"
            "## References\n\n"
            "[1] Prior review.\n\n"
            "[2] Trial report.\n\n"
            "[3] Registry results.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "trial:published",
                    "citation": "[2]",
                    "source_type": "included_trial",
                    "title": "Trial report",
                },
                {
                    "study_id": "trial:registry",
                    "citation": "[3]",
                    "source_type": "registry_results",
                    "title": "Registry results",
                },
            ]
        },
        subdir="search",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "uncited_results_study_data_claim")

    assert audit["summary"]["uncited_results_study_data_claims"] == 1
    assert issue["severity"] == "warn"
    assert issue["section"] == "Results"
    assert issue["results_claim_types"] == ["study_data_source"]
    assert issue["recommended_citations"] == [2, 3]
    assert "included trials contributed primary outcome data" in issue["evidence_excerpt"]


def test_citation_audit_warns_about_uncited_methods_methodology_claims(tmp_path) -> None:
    project = Project("uncited methods methodology audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [1].\n\n"
            "## Methods\n\n"
            "This review followed PRISMA guidance [2]. "
            "Risk of bias was assessed using the Cochrane RoB 2 tool.\n\n"
            "## Results\n\n"
            "Two trial reports contributed data [1].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [1].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] PRISMA 2020 statement.\n\n"
            "[3] Cochrane RoB 2 tool.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {
                    "study_id": "methodology:prisma",
                    "citation": "[2]",
                    "source_type": "reporting_guideline",
                    "title": "PRISMA 2020 statement",
                },
                {
                    "study_id": "methodology:rob2",
                    "citation": "[3]",
                    "source_type": "risk_of_bias_tool",
                    "title": "Cochrane RoB 2 tool",
                },
            ]
        },
        subdir="search",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "uncited_methods_methodology_claim")

    assert audit["summary"]["uncited_methods_methodology_claims"] == 1
    assert issue["severity"] == "warn"
    assert issue["section"] == "Methods"
    assert issue["methodology_claim_types"] == ["risk_of_bias_tool"]
    assert issue["recommended_citations"] == [3]
    assert "Cochrane RoB 2 tool" in issue["evidence_excerpt"]


def test_citation_audit_warns_about_uncited_chinese_heterogeneity_method_claim(tmp_path) -> None:
    project = Project("uncited zh heterogeneity methodology audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# 中文Meta分析稿件\n\n"
            "## 引言\n\n"
            "心力衰竭仍具有重要临床负担［1］。\n\n"
            "## 方法\n\n"
            "本研究遵循PRISMA 2020报告规范［2］。"
            "异质性采用I²统计量和Cochran Q检验评价，并报告τ²作为研究间方差估计。\n\n"
            "## 结果\n\n"
            "两项随机试验贡献了主要结局数据［1］。\n\n"
            "## 讨论\n\n"
            "结果需结合既往证据解释［1］。\n\n"
            "## 参考文献\n\n"
            "［1］ 试验报告。\n\n"
            "［2］ PRISMA 2020声明。\n\n"
            "［3］ Meta分析统计方法来源。\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {
                    "study_id": "methodology:prisma",
                    "citation": "［2］",
                    "source_type": "reporting_guideline",
                    "title": "PRISMA 2020 statement",
                },
                {
                    "study_id": "methodology:stats",
                    "citation": "［3］",
                    "source_type": "statistical_method",
                    "title": "Meta-analysis statistical methods",
                },
            ]
        },
        subdir="search",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "uncited_methods_methodology_claim")

    assert audit["summary"]["uncited_methods_methodology_claims"] == 1
    assert issue["methodology_claim_types"] == ["statistical_method"]
    assert issue["recommended_citations"] == [3]
    assert "I²统计量和Cochran Q检验" in issue["evidence_excerpt"]


def test_citation_audit_warns_about_uncited_introduction_background_claims(tmp_path) -> None:
    project = Project("uncited intro background audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure imposes substantial morbidity and mortality worldwide. "
            "Current guidelines recommend SGLT2 inhibitors for selected patients [2].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two trial reports contributed data [1].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [3].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] Heart failure clinical guideline.\n\n"
            "[3] Prior systematic review.\n\n"
            "[4] Epidemiology background source.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evidence:guideline",
                    "citation": "[2]",
                    "source_type": "clinical_guideline",
                    "title": "Heart failure clinical guideline",
                },
                {
                    "study_id": "evidence:review",
                    "citation": "[3]",
                    "source_type": "prior_review",
                    "title": "Prior systematic review",
                },
                {
                    "study_id": "evidence:background",
                    "citation": "[4]",
                    "source_type": "pubmed_background",
                    "title": "Epidemiology background source",
                },
            ]
        },
        subdir="search",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "uncited_introduction_background_claim")

    assert audit["summary"]["uncited_introduction_background_claims"] == 1
    assert issue["severity"] == "warn"
    assert issue["section"] == "Introduction"
    assert issue["background_claim_types"] == ["disease_burden"]
    assert issue["recommended_citations"] == [4]
    assert "morbidity and mortality" in issue["evidence_excerpt"]


def test_citation_audit_requires_matching_source_for_each_intro_background_claim_type(tmp_path) -> None:
    project = Project("mixed intro background claim support audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Current guidelines recommend SGLT2 inhibitors for selected patients [2], "
            "but heart failure imposes substantial morbidity and mortality worldwide.\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two trial reports contributed data [1].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [3].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] Heart failure clinical guideline.\n\n"
            "[3] Prior systematic review.\n\n"
            "[4] Epidemiology background source.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evidence:guideline",
                    "citation": "[2]",
                    "source_type": "clinical_guideline",
                    "title": "Heart failure clinical guideline",
                },
                {
                    "study_id": "evidence:review",
                    "citation": "[3]",
                    "source_type": "prior_review",
                    "title": "Prior systematic review",
                },
                {
                    "study_id": "evidence:background",
                    "citation": "[4]",
                    "source_type": "pubmed_background",
                    "title": "Epidemiology background source",
                },
            ]
        },
        subdir="search",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "uncited_introduction_background_claim")

    assert audit["summary"]["uncited_introduction_background_claims"] == 1
    assert issue["background_claim_types"] == ["disease_burden"]
    assert issue["existing_citations"] == [2]
    assert issue["recommended_citations"] == [4]
    assert "morbidity and mortality" in issue["evidence_excerpt"]


def test_citation_audit_splits_chinese_introduction_sentences_without_spaces(tmp_path) -> None:
    project = Project("uncited zh intro background audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# 中文Meta分析稿件\n\n"
            "## 引言\n\n"
            "心力衰竭患者的住院和死亡风险仍然较高。指南建议在特定患者中使用SGLT2抑制剂［2］。\n\n"
            "## 方法\n\n"
            "我们遵循预设方法［1］。\n\n"
            "## 结果\n\n"
            "两项随机试验贡献了主要结局数据［1］。\n\n"
            "## 讨论\n\n"
            "结果需结合既往证据解释［3］。\n\n"
            "## 参考文献\n\n"
            "［1］ 试验报告。\n\n"
            "［2］ 心力衰竭临床指南。\n\n"
            "［3］ 既往系统综述。\n\n"
            "［4］ 心力衰竭流行病学来源。\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evidence:guideline",
                    "citation": "［2］",
                    "source_type": "clinical_guideline",
                    "title": "心力衰竭临床指南",
                },
                {
                    "study_id": "evidence:review",
                    "citation": "［3］",
                    "source_type": "prior_review",
                    "title": "既往系统综述",
                },
                {
                    "study_id": "evidence:background",
                    "citation": "［4］",
                    "source_type": "pubmed_background",
                    "title": "心力衰竭流行病学来源",
                },
            ]
        },
        subdir="search",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "uncited_introduction_background_claim")

    assert audit["language"] == "zh"
    assert audit["summary"]["uncited_introduction_background_claims"] == 1
    assert issue["section"] == "Introduction"
    assert issue["background_claim_types"] == ["disease_burden"]
    assert issue["recommended_citations"] == [4]
    assert issue["evidence_excerpt"] == "心力衰竭患者的住院和死亡风险仍然较高。"


def test_citation_audit_treats_chinese_background_heading_as_introduction(tmp_path) -> None:
    project = Project("uncited zh background heading audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# 中文Meta分析稿件\n\n"
            "## 背景\n\n"
            "心力衰竭患者的住院和死亡风险仍然较高。指南建议在特定患者中使用SGLT2抑制剂［2］。\n\n"
            "## 方法\n\n"
            "我们遵循预设方法［1］。\n\n"
            "## 结果\n\n"
            "两项随机试验贡献了主要结局数据［1］。\n\n"
            "## 讨论\n\n"
            "结果需结合既往证据解释［3］。\n\n"
            "## 参考文献\n\n"
            "［1］ 试验报告。\n\n"
            "［2］ 心力衰竭临床指南。\n\n"
            "［3］ 既往系统综述。\n\n"
            "［4］ 心力衰竭流行病学来源。\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evidence:guideline",
                    "citation": "［2］",
                    "source_type": "clinical_guideline",
                    "title": "心力衰竭临床指南",
                },
                {
                    "study_id": "evidence:review",
                    "citation": "［3］",
                    "source_type": "prior_review",
                    "title": "既往系统综述",
                },
                {
                    "study_id": "evidence:background",
                    "citation": "［4］",
                    "source_type": "pubmed_background",
                    "title": "心力衰竭流行病学来源",
                },
            ]
        },
        subdir="search",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "uncited_introduction_background_claim")

    assert audit["language"] == "zh"
    assert audit["section_counts"]["Introduction"] == 1
    assert audit["summary"]["introduction_inline_citations"] == 1
    assert audit["summary"]["uncited_introduction_background_claims"] == 1
    assert issue["background_claim_types"] == ["disease_burden"]
    assert issue["recommended_citations"] == [4]


def test_citation_audit_maps_compound_chinese_section_headings(tmp_path) -> None:
    project = Project("compound zh heading citation audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# 中文Meta分析稿件\n\n"
            "## 背景与目的\n\n"
            "心力衰竭患者的住院和死亡风险仍然较高。指南建议在特定患者中使用SGLT2抑制剂［2］。\n\n"
            "## 资料与方法\n\n"
            "本研究遵循PRISMA 2020报告规范，并使用Cochrane RoB 2工具评价偏倚风险。\n\n"
            "## 研究结果\n\n"
            "两项随机试验贡献了主要结局数据［1］。\n\n"
            "## 讨论\n\n"
            "结果需结合既往证据解释［3］。\n\n"
            "## 结论与意义\n\n"
            "当前证据支持谨慎解释主要结果［1］。\n\n"
            "## 参考文献\n\n"
            "［1］ 试验报告。\n\n"
            "［2］ 心力衰竭临床指南。\n\n"
            "［3］ 既往系统综述。\n\n"
            "［4］ 心力衰竭流行病学来源。\n\n"
            "［5］ PRISMA 2020声明。\n\n"
            "［6］ Cochrane RoB 2工具。\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {"study_id": "trial:source", "citation": "［1］", "source_type": "included_trial"},
                {"study_id": "evidence:guideline", "citation": "［2］", "source_type": "clinical_guideline"},
                {"study_id": "evidence:review", "citation": "［3］", "source_type": "prior_review"},
                {"study_id": "evidence:background", "citation": "［4］", "source_type": "pubmed_background"},
            ]
        },
        subdir="search",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {"study_id": "method:prisma", "citation": "［5］", "source_type": "reporting_guideline"},
                {"study_id": "method:rob2", "citation": "［6］", "source_type": "risk_of_bias_tool"},
            ]
        },
        subdir="search",
    )

    audit = _build_citation_audit_review(project)
    issues_by_code = {item["code"]: item for item in audit["issues"]}

    assert audit["section_counts"]["Introduction"] == 1
    assert audit["section_counts"]["Methods"] == 0
    assert audit["section_counts"]["Results"] == 1
    assert audit["section_counts"]["Conclusion"] == 1
    assert audit["summary"]["uncited_introduction_background_claims"] == 1
    assert audit["summary"]["uncited_methods_methodology_claims"] == 1
    assert issues_by_code["uncited_introduction_background_claim"]["recommended_citations"] == [4]
    assert issues_by_code["uncited_methods_methodology_claim"]["recommended_citations"] == [5, 6]


def test_citation_audit_checks_unpunctuated_trailing_chinese_introduction_claim(tmp_path) -> None:
    project = Project("uncited zh trailing intro background audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# 中文Meta分析稿件\n\n"
            "## 引言\n\n"
            "指南建议在特定患者中使用SGLT2抑制剂［2］。心力衰竭患者的住院和死亡风险仍然较高\n\n"
            "## 方法\n\n"
            "我们遵循预设方法［1］。\n\n"
            "## 结果\n\n"
            "两项随机试验贡献了主要结局数据［1］。\n\n"
            "## 讨论\n\n"
            "结果需结合既往证据解释［3］。\n\n"
            "## 参考文献\n\n"
            "［1］ 试验报告。\n\n"
            "［2］ 心力衰竭临床指南。\n\n"
            "［3］ 既往系统综述。\n\n"
            "［4］ 心力衰竭流行病学来源。\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evidence:guideline",
                    "citation": "［2］",
                    "source_type": "clinical_guideline",
                    "title": "心力衰竭临床指南",
                },
                {
                    "study_id": "evidence:review",
                    "citation": "［3］",
                    "source_type": "prior_review",
                    "title": "既往系统综述",
                },
                {
                    "study_id": "evidence:background",
                    "citation": "［4］",
                    "source_type": "pubmed_background",
                    "title": "心力衰竭流行病学来源",
                },
            ]
        },
        subdir="search",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "uncited_introduction_background_claim")

    assert audit["summary"]["uncited_introduction_background_claims"] == 1
    assert issue["background_claim_types"] == ["disease_burden"]
    assert issue["recommended_citations"] == [4]
    assert issue["evidence_excerpt"] == "心力衰竭患者的住院和死亡风险仍然较高"


def test_citation_audit_warns_about_uncited_discussion_context_claims(tmp_path) -> None:
    project = Project("uncited discussion context audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [2].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two trial reports contributed data [1].\n\n"
            "## Discussion\n\n"
            "The findings were consistent with prior systematic reviews. "
            "GRADE certainty remained low for the primary outcome [4].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] Heart failure clinical guideline.\n\n"
            "[3] Prior systematic review.\n\n"
            "[4] GRADE guidance.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evidence:guideline",
                    "citation": "[2]",
                    "source_type": "clinical_guideline",
                    "title": "Heart failure clinical guideline",
                },
                {
                    "study_id": "evidence:review",
                    "citation": "[3]",
                    "source_type": "prior_review",
                    "title": "Prior systematic review",
                },
            ]
        },
        subdir="search",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {
                    "study_id": "methodology:grade",
                    "citation": "[4]",
                    "source_type": "certainty_framework",
                    "title": "GRADE guidance",
                },
            ]
        },
        subdir="search",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "uncited_discussion_context_claim")

    assert audit["summary"]["uncited_discussion_context_claims"] == 1
    assert issue["severity"] == "warn"
    assert issue["section"] == "Discussion"
    assert issue["discussion_context_claim_types"] == ["prior_evidence"]
    assert issue["recommended_citations"] == [3]
    assert "consistent with prior systematic reviews" in issue["evidence_excerpt"]


def test_citation_audit_warns_about_uncited_discussion_existing_evidence_base_claims(tmp_path) -> None:
    project = Project("uncited discussion evidence base audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [2].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two trial reports contributed data [1].\n\n"
            "## Discussion\n\n"
            "These findings add to the existing evidence base for SGLT2 inhibitors in HFpEF. "
            "GRADE certainty remained low for the primary outcome [4].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] Heart failure clinical guideline.\n\n"
            "[3] Prior systematic review.\n\n"
            "[4] GRADE guidance.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evidence:review",
                    "citation": "[3]",
                    "source_type": "prior_review",
                    "title": "Prior systematic review",
                },
            ]
        },
        subdir="search",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "uncited_discussion_context_claim")

    assert audit["summary"]["uncited_discussion_context_claims"] == 1
    assert issue["discussion_context_claim_types"] == ["prior_evidence"]
    assert issue["recommended_citations"] == [3]
    assert "existing evidence base" in issue["evidence_excerpt"]


def test_citation_audit_warns_about_uncited_discussion_safety_result_claims(tmp_path) -> None:
    project = Project("uncited discussion safety result audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [1].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two included trials contributed safety data [2].\n\n"
            "## Discussion\n\n"
            "Serious adverse events were not increased with SGLT2 inhibitors. "
            "The findings were interpreted alongside prior evidence [1].\n\n"
            "## References\n\n"
            "[1] Prior review.\n\n"
            "[2] Trial report.\n\n"
            "[3] Registry safety results.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "trial:published",
                    "citation": "[2]",
                    "source_type": "included_trial",
                    "title": "Trial report",
                },
                {
                    "study_id": "trial:registry",
                    "citation": "[3]",
                    "source_type": "registry_results",
                    "title": "Registry safety results",
                },
            ]
        },
        subdir="search",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "uncited_discussion_result_claim")

    assert audit["summary"]["uncited_discussion_result_claims"] == 1
    assert issue["severity"] == "warn"
    assert issue["section"] == "Discussion"
    assert issue["discussion_result_claim_types"] == ["safety_result"]
    assert issue["recommended_citations"] == [2, 3]
    assert "Serious adverse events were not increased" in issue["evidence_excerpt"]


def test_citation_audit_warns_about_uncited_discussion_mechanism_claims(tmp_path) -> None:
    project = Project("uncited discussion mechanism audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [1].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two included trials contributed primary outcome data [2].\n\n"
            "## Discussion\n\n"
            "These benefits may reflect natriuresis and improved ventricular loading conditions. "
            "The findings were interpreted alongside prior evidence [1].\n\n"
            "## References\n\n"
            "[1] Prior review.\n\n"
            "[2] Trial report.\n\n"
            "[3] Mechanistic background source.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evidence:mechanism",
                    "citation": "[3]",
                    "source_type": "pubmed_background",
                    "title": "Mechanistic background source",
                },
            ]
        },
        subdir="search",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "uncited_discussion_mechanism_claim")

    assert audit["summary"]["uncited_discussion_mechanism_claims"] == 1
    assert issue["severity"] == "warn"
    assert issue["section"] == "Discussion"
    assert issue["discussion_mechanism_claim_types"] == ["mechanistic_explanation"]
    assert issue["recommended_citations"] == [3]
    assert "may reflect natriuresis" in issue["evidence_excerpt"]


def test_citation_audit_warns_about_uncited_conclusion_result_claims(tmp_path) -> None:
    project = Project("uncited conclusion result audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [1].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two included trials contributed primary outcome data [2].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [1].\n\n"
            "## Conclusion\n\n"
            "SGLT2 inhibitors were associated with fewer cardiovascular events.\n\n"
            "## References\n\n"
            "[1] Prior review.\n\n"
            "[2] Trial report.\n\n"
            "[3] Registry results.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "trial:published",
                    "citation": "[2]",
                    "source_type": "included_trial",
                    "title": "Trial report",
                },
                {
                    "study_id": "trial:registry",
                    "citation": "[3]",
                    "source_type": "registry_results",
                    "title": "Registry results",
                },
            ]
        },
        subdir="search",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "uncited_conclusion_result_claim")

    assert audit["summary"]["conclusion_inline_citations"] == 0
    assert audit["summary"]["uncited_conclusion_result_claims"] == 1
    assert issue["severity"] == "warn"
    assert issue["section"] == "Conclusion"
    assert issue["conclusion_claim_types"] == ["primary_result"]
    assert issue["recommended_citations"] == [2, 3]
    assert "associated with fewer cardiovascular events" in issue["evidence_excerpt"]


def test_citation_audit_warns_about_uncited_hedged_conclusion_result_claims(tmp_path) -> None:
    project = Project("uncited hedged conclusion result audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [1].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two included trials contributed primary outcome data [2].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [1].\n\n"
            "## Conclusion\n\n"
            "The evidence suggested fewer heart failure hospitalizations.\n\n"
            "## References\n\n"
            "[1] Prior review.\n\n"
            "[2] Trial report.\n\n"
            "[3] Registry results.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "trial:published",
                    "citation": "[2]",
                    "source_type": "included_trial",
                    "title": "Trial report",
                },
                {
                    "study_id": "trial:registry",
                    "citation": "[3]",
                    "source_type": "registry_results",
                    "title": "Registry results",
                },
            ]
        },
        subdir="search",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "uncited_conclusion_result_claim")

    assert audit["summary"]["uncited_conclusion_result_claims"] == 1
    assert issue["conclusion_claim_types"] == ["primary_result"]
    assert issue["recommended_citations"] == [2, 3]
    assert "suggested fewer heart failure hospitalizations" in issue["evidence_excerpt"]


def test_citation_audit_warns_about_uncited_conclusion_safety_result_claims(tmp_path) -> None:
    project = Project("uncited conclusion safety result audit", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [1].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two included trials contributed safety data [2].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [1].\n\n"
            "## Conclusion\n\n"
            "Serious adverse events were not increased with SGLT2 inhibitors.\n\n"
            "## References\n\n"
            "[1] Prior review.\n\n"
            "[2] Trial report.\n\n"
            "[3] Registry safety results.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "trial:published",
                    "citation": "[2]",
                    "source_type": "included_trial",
                    "title": "Trial report",
                },
                {
                    "study_id": "trial:registry",
                    "citation": "[3]",
                    "source_type": "registry_results",
                    "title": "Registry safety results",
                },
            ]
        },
        subdir="search",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "uncited_conclusion_result_claim")

    assert audit["summary"]["uncited_conclusion_result_claims"] == 1
    assert issue["conclusion_claim_types"] == ["safety_result"]
    assert issue["recommended_citations"] == [2, 3]
    assert "Serious adverse events were not increased" in issue["evidence_excerpt"]


def test_web_manuscript_quality_payload_explains_uncited_numeric_effect_claim(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web uncited numeric effect", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [1].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "The pooled HR was 0.81 (95% CI 0.75 to 0.88). "
            "Two trial reports contributed data [1].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [2].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] Prior review.\n"
        ),
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "uncited_numeric_effect_claim")

    assert issue["source"] == "citation_audit"
    assert "effect estimate" in issue["suggested_action"].lower()
    assert "inline citation" in issue["suggested_action"].lower()
    assert "pooled HR was 0.81" in issue["snippet"]


def test_web_manuscript_quality_payload_explains_numeric_effect_wrong_source_citation(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web numeric effect wrong source citation", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [4].\n\n"
            "## Methods\n\n"
            "We followed PRISMA and assessed certainty [2,3].\n\n"
            "## Results\n\n"
            "The pooled HR was 0.81 (95% CI 0.75 to 0.88) [3].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside GRADE certainty [3].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] The PRISMA 2020 statement.\n\n"
            "[3] GRADE guidance.\n\n"
            "[4] Heart failure guideline.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "trial:primary",
                    "citation": "[1]",
                    "source_type": "trial_report",
                    "title": "Trial report",
                },
                {
                    "study_id": "guideline:hf",
                    "citation": "[4]",
                    "source_type": "guideline",
                    "title": "Heart failure guideline",
                },
            ]
        },
        subdir="search",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {"study_id": "methodology:prisma", "citation": "[2]", "source_type": "reporting_guideline"},
                {"study_id": "methodology:grade", "citation": "[3]", "source_type": "certainty_framework"},
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(
        item
        for item in payload["actionable_issues"]
        if item["code"] == "numeric_effect_claim_lacks_source_citation"
    )

    assert issue["source"] == "citation_audit"
    assert issue["existing_citations"] == ["[3]"]
    assert issue["recommended_citations"][0]["citation"] == "[1]"
    assert "source-report" in issue["suggested_action"].lower()
    assert "pooled HR was 0.81" in issue["snippet"]


def test_web_manuscript_quality_payload_recommends_reference_list_trial_when_context_missing(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web numeric effect bibliography fallback", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [4].\n\n"
            "## Methods\n\n"
            "We followed PRISMA and assessed certainty [2,3].\n\n"
            "## Results\n\n"
            "The pooled HR was 0.81 (95% CI 0.75 to 0.88) [3].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside GRADE certainty [3].\n\n"
            "## References\n\n"
            "[1] Smith J. Randomized clinical trial report of dapagliflozin in heart failure.\n\n"
            "[2] The PRISMA 2020 statement.\n\n"
            "[3] GRADE guidance.\n\n"
            "[4] Heart failure guideline.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {"study_id": "methodology:prisma", "citation": "[2]", "source_type": "reporting_guideline"},
                {"study_id": "methodology:grade", "citation": "[3]", "source_type": "certainty_framework"},
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(
        item
        for item in payload["actionable_issues"]
        if item["code"] == "numeric_effect_claim_lacks_source_citation"
    )

    assert issue["recommended_citations"][0]["citation"] == "[1]"
    assert issue["recommended_citations"][0]["title"].startswith("Smith J.")
    assert "source-report" in issue["suggested_action"].lower()


def test_citation_audit_treats_real_sglt2_trial_references_as_numeric_effect_sources(tmp_path) -> None:
    project = Project("numeric effect real sglt2 source fallback", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure with preserved ejection fraction remains clinically important [4].\n\n"
            "## Methods\n\n"
            "We followed PRISMA and assessed certainty [3,4].\n\n"
            "## Results\n\n"
            "The pooled HR was 0.81 (95% CI 0.75 to 0.88) [3].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside GRADE certainty [3].\n\n"
            "## References\n\n"
            "[1] Solomon SD, McMurray JJV, Claggett B, et al. Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction. N Engl J Med. 2022;387:1089-1098.\n\n"
            "[2] Anker SD, Butler J, Filippatos G, et al. Empagliflozin in Heart Failure with a Preserved Ejection Fraction. N Engl J Med. 2021;385:1451-1461.\n\n"
            "[3] Guyatt GH. GRADE guidelines.\n\n"
            "[4] Page MJ. The PRISMA 2020 statement.\n"
        ),
        subdir="manuscript",
    )

    audit = _build_citation_audit_review(project)
    issue = next(item for item in audit["issues"] if item["code"] == "numeric_effect_claim_lacks_source_citation")

    assert issue["recommended_citations"][:2] == [1, 2]
    assert audit["summary"]["numeric_effect_claims_without_source_citations"] == 1


def test_citation_audit_uses_bibliography_roles_for_background_and_methodology_when_context_missing(tmp_path) -> None:
    project = Project("bibliography reference role fallback", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Guidelines recommend SGLT2 inhibitors for heart failure, and prior meta-analyses summarize existing evidence.\n\n"
            "## Methods\n\n"
            "We followed PRISMA and used GRADE to assess certainty.\n\n"
            "## Results\n\n"
            "Two trial reports contributed data [5].\n\n"
            "## Discussion\n\n"
            "The findings were compared with prior systematic reviews and guideline recommendations.\n\n"
            "## References\n\n"
            "[1] Heidenreich PA, Bozkurt B, Aguilar D, et al. 2022 AHA/ACC/HFSA Guideline for the Management of Heart Failure. Circulation. 2022.\n\n"
            "[2] Smith J, Jones K. Network meta-analysis of SGLT2 inhibitors in heart failure. BMJ. 2023.\n\n"
            "[3] Page MJ, McKenzie JE, Bossuyt PM, et al. The PRISMA 2020 statement. BMJ. 2021.\n\n"
            "[4] Guyatt GH, Oxman AD, Vist GE, et al. GRADE guidelines: rating the certainty of evidence. J Clin Epidemiol. 2011.\n\n"
            "[5] Solomon SD, McMurray JJV, Claggett B, et al. Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction. N Engl J Med. 2022.\n"
        ),
        subdir="manuscript",
    )

    audit = _build_citation_audit_review(project)
    issues_by_code = {item["code"]: item for item in audit["issues"]}

    assert issues_by_code["uncited_introduction_background_claim"]["recommended_citations"] == [1, 2]
    assert issues_by_code["uncited_methods_methodology_claim"]["recommended_citations"] == [3, 4]
    assert issues_by_code["uncited_discussion_context_claim"]["recommended_citations"] == [2, 1]


def test_apply_numeric_effect_wrong_source_citation_patch_clears_quality_issue(tmp_path) -> None:
    from start import META_ROOT, _apply_manuscript_citation_patch_payload, _load_manuscript_quality_payload

    project = Project(
        "web numeric effect wrong source patch apply",
        output_dir=META_ROOT / "output" / "pytest_numeric_effect_wrong_source_patch" / uuid4().hex,
    )
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [4].\n\n"
            "## Methods\n\n"
            "We followed PRISMA and assessed certainty [2,3].\n\n"
            "## Results\n\n"
            "The pooled HR was 0.81 (95% CI 0.75 to 0.88) [3].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside GRADE certainty [3].\n\n"
            "## References\n\n"
            "[1] Smith J. Randomized clinical trial report of dapagliflozin in heart failure.\n\n"
            "[2] The PRISMA 2020 statement.\n\n"
            "[3] GRADE guidance.\n\n"
            "[4] Heart failure guideline.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {"study_id": "methodology:prisma", "citation": "[2]", "source_type": "reporting_guideline"},
                {"study_id": "methodology:grade", "citation": "[3]", "source_type": "certainty_framework"},
            ]
        },
        subdir="search",
    )
    issue = next(
        item
        for item in _load_manuscript_quality_payload(project, {})["actionable_issues"]
        if item["code"] == "numeric_effect_claim_lacks_source_citation"
    )

    result = _apply_manuscript_citation_patch_payload(
        {
            "project_dir": str(project.base_dir),
            "issue_id": issue["id"],
            "expected_revision": 0,
        },
        user_id="tester",
    )

    draft = project.load_text("draft.md", subdir="manuscript")
    log = project.load_json("manuscript_citation_fixes.json", subdir="manuscript")
    remaining_codes = {item["code"] for item in result["manuscript_quality"]["actionable_issues"]}

    assert result["ok"] is True
    assert result["citation"] == "[1]"
    assert "The pooled HR was 0.81 (95% CI 0.75 to 0.88) [3] [1]." in draft
    assert "numeric_effect_claim_lacks_source_citation" not in remaining_codes
    assert result["quality_delta"]["resolved_issue_ids"] == [issue["id"]]
    assert log["entries"][0]["issue_id"] == issue["id"]
    assert log["entries"][0]["citation"] == "[1]"


def test_web_manuscript_quality_payload_explains_uncited_conclusion_result_claim(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web uncited conclusion result claim", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [1].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two included trials contributed primary outcome data [2].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [1].\n\n"
            "## Conclusion\n\n"
            "SGLT2 inhibitors were associated with fewer cardiovascular events.\n\n"
            "## References\n\n"
            "[1] Prior review.\n\n"
            "[2] Trial report.\n\n"
            "[3] Registry results.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "trial:published",
                    "citation": "[2]",
                    "source_type": "included_trial",
                    "title": "Trial report",
                },
                {
                    "study_id": "trial:registry",
                    "citation": "[3]",
                    "source_type": "registry_results",
                    "title": "Registry results",
                },
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "uncited_conclusion_result_claim")

    assert issue["section"] == "Conclusion"
    assert "Conclusion result claim" in issue["suggested_action"]
    assert "same sentence" in issue["suggested_action"]
    assert [item["citation"] for item in issue["recommended_citations"]] == ["[2]", "[3]"]
    assert "associated with fewer cardiovascular events" in issue["snippet"]


def test_web_manuscript_quality_payload_explains_uncited_results_study_data_claim(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web uncited results study data", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [1].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two included trials contributed primary outcome data. "
            "The pooled HR was 0.82 [2].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [1].\n\n"
            "## References\n\n"
            "[1] Prior review.\n\n"
            "[2] Trial report.\n\n"
            "[3] Registry results.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "trial:published",
                    "citation": "[2]",
                    "source_type": "included_trial",
                    "title": "Trial report",
                },
                {
                    "study_id": "trial:registry",
                    "citation": "[3]",
                    "source_type": "registry_results",
                    "title": "Registry results",
                },
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "uncited_results_study_data_claim")

    assert issue["source"] == "citation_audit"
    assert "study data claim" in issue["suggested_action"].lower()
    assert "same sentence" in issue["suggested_action"].lower()
    assert [item["citation"] for item in issue["recommended_citations"]] == ["[2]", "[3]"]
    assert "included trials contributed primary outcome data" in issue["snippet"]


def test_web_manuscript_quality_payload_explains_uncited_methods_methodology_claim(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web uncited methods methodology", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [1].\n\n"
            "## Methods\n\n"
            "This review followed PRISMA guidance [2]. "
            "Risk of bias was assessed using the Cochrane RoB 2 tool.\n\n"
            "## Results\n\n"
            "Two trial reports contributed data [1].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [1].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] PRISMA 2020 statement.\n\n"
            "[3] Cochrane RoB 2 tool.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {
                    "study_id": "methodology:prisma",
                    "citation": "[2]",
                    "source_type": "reporting_guideline",
                    "title": "PRISMA 2020 statement",
                },
                {
                    "study_id": "methodology:rob2",
                    "citation": "[3]",
                    "source_type": "risk_of_bias_tool",
                    "title": "Cochrane RoB 2 tool",
                },
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "uncited_methods_methodology_claim")

    assert issue["source"] == "citation_audit"
    assert "methodology claim" in issue["suggested_action"].lower()
    assert "same sentence" in issue["suggested_action"].lower()
    assert [item["citation"] for item in issue["recommended_citations"]] == ["[3]"]
    assert "Cochrane RoB 2 tool" in issue["snippet"]


def test_web_manuscript_quality_payload_explains_uncited_introduction_background_claim(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web uncited intro background", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure imposes substantial morbidity and mortality worldwide. "
            "Current guidelines recommend SGLT2 inhibitors for selected patients [2].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two trial reports contributed data [1].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [3].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] Heart failure clinical guideline.\n\n"
            "[3] Prior systematic review.\n\n"
            "[4] Epidemiology background source.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evidence:guideline",
                    "citation": "[2]",
                    "source_type": "clinical_guideline",
                    "title": "Heart failure clinical guideline",
                },
                {
                    "study_id": "evidence:review",
                    "citation": "[3]",
                    "source_type": "prior_review",
                    "title": "Prior systematic review",
                },
                {
                    "study_id": "evidence:background",
                    "citation": "[4]",
                    "source_type": "pubmed_background",
                    "title": "Epidemiology background source",
                },
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "uncited_introduction_background_claim")

    assert issue["source"] == "citation_audit"
    assert "background claim" in issue["suggested_action"].lower()
    assert "same sentence" in issue["suggested_action"].lower()
    assert [item["citation"] for item in issue["recommended_citations"]] == ["[4]"]
    assert "morbidity and mortality" in issue["snippet"]


def test_web_manuscript_quality_payload_exposes_existing_citations_for_mismatched_intro_claim(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web mismatched intro background citation", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Current guidelines recommend SGLT2 inhibitors for selected patients [2], "
            "but heart failure imposes substantial morbidity and mortality worldwide.\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two trial reports contributed data [1].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [3].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] Heart failure clinical guideline.\n\n"
            "[3] Prior systematic review.\n\n"
            "[4] Epidemiology background source.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {"citation": "[2]", "title": "Heart failure clinical guideline", "source_type": "clinical_guideline"},
                {"citation": "[3]", "title": "Prior systematic review", "source_type": "prior_review"},
                {"citation": "[4]", "title": "Epidemiology background source", "source_type": "pubmed_background"},
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "uncited_introduction_background_claim")

    assert issue["existing_citations"] == ["[2]"]
    assert issue["raw_issue"]["existing_citations"] == [2]
    assert issue["raw_issue"]["background_claim_types"] == ["disease_burden"]
    assert [item["citation"] for item in issue["recommended_citations"]] == ["[4]"]


def test_web_manuscript_quality_payload_explains_uncited_discussion_context_claim(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web uncited discussion context", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [2].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two trial reports contributed data [1].\n\n"
            "## Discussion\n\n"
            "The findings were consistent with prior systematic reviews. "
            "GRADE certainty remained low for the primary outcome [4].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] Heart failure clinical guideline.\n\n"
            "[3] Prior systematic review.\n\n"
            "[4] GRADE guidance.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evidence:guideline",
                    "citation": "[2]",
                    "source_type": "clinical_guideline",
                    "title": "Heart failure clinical guideline",
                },
                {
                    "study_id": "evidence:review",
                    "citation": "[3]",
                    "source_type": "prior_review",
                    "title": "Prior systematic review",
                },
            ]
        },
        subdir="search",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {
                    "study_id": "methodology:grade",
                    "citation": "[4]",
                    "source_type": "certainty_framework",
                    "title": "GRADE guidance",
                },
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "uncited_discussion_context_claim")

    assert issue["source"] == "citation_audit"
    assert "discussion claim" in issue["suggested_action"].lower()
    assert "same sentence" in issue["suggested_action"].lower()
    assert [item["citation"] for item in issue["recommended_citations"]] == ["[3]"]
    assert "consistent with prior systematic reviews" in issue["snippet"]


def test_web_manuscript_quality_payload_explains_uncited_discussion_result_claim(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web uncited discussion result claim", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [1].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two included trials contributed safety data [2].\n\n"
            "## Discussion\n\n"
            "Serious adverse events were not increased with SGLT2 inhibitors. "
            "The findings were interpreted alongside prior evidence [1].\n\n"
            "## References\n\n"
            "[1] Prior review.\n\n"
            "[2] Trial report.\n\n"
            "[3] Registry safety results.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "trial:published",
                    "citation": "[2]",
                    "source_type": "included_trial",
                    "title": "Trial report",
                },
                {
                    "study_id": "trial:registry",
                    "citation": "[3]",
                    "source_type": "registry_results",
                    "title": "Registry safety results",
                },
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "uncited_discussion_result_claim")

    assert issue["source"] == "citation_audit"
    assert issue["section"] == "Discussion"
    assert "discussion result claim" in issue["suggested_action"].lower()
    assert "same sentence" in issue["suggested_action"].lower()
    assert [item["citation"] for item in issue["recommended_citations"]] == ["[2]", "[3]"]
    assert "Serious adverse events were not increased" in issue["snippet"]


def test_web_manuscript_quality_payload_explains_uncited_discussion_mechanism_claim(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web uncited discussion mechanism", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [1].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two included trials contributed primary outcome data [2].\n\n"
            "## Discussion\n\n"
            "These benefits may reflect natriuresis and improved ventricular loading conditions. "
            "The findings were interpreted alongside prior evidence [1].\n\n"
            "## References\n\n"
            "[1] Prior review.\n\n"
            "[2] Trial report.\n\n"
            "[3] Mechanistic background source.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evidence:mechanism",
                    "citation": "[3]",
                    "source_type": "pubmed_background",
                    "title": "Mechanistic background source",
                },
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "uncited_discussion_mechanism_claim")

    assert issue["source"] == "citation_audit"
    assert issue["section"] == "Discussion"
    assert "mechanism claim" in issue["suggested_action"].lower()
    assert "same sentence" in issue["suggested_action"].lower()
    assert [item["citation"] for item in issue["recommended_citations"]] == ["[3]"]
    assert "may reflect natriuresis" in issue["snippet"]


def test_web_manuscript_quality_payload_recommends_missing_contextual_depth_citations(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web section citation depth quality", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Source-depth citation manuscript\n\n"
            "## Introduction\n\n"
            "The disease burden and prior evidence base remain clinically important [4].\n\n"
            "## Methods\n\n"
            "This systematic review followed predefined eligibility and certainty assessment methods [2].\n\n"
            "## Results\n\n"
            "Two trials contributed primary outcome data [1].\n\n"
            "## Discussion\n\n"
            "The findings should be compared with existing guidance and certainty limitations [4].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] PRISMA 2020 statement.\n\n"
            "[3] Cochrane Handbook.\n\n"
            "[4] Heart failure clinical guideline.\n\n"
            "[5] Prior systematic review.\n\n"
            "[6] GRADE guidance.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {
                    "study_id": "methodology:prisma",
                    "citation": "[2]",
                    "source_type": "reporting_guideline",
                    "title": "PRISMA 2020 statement",
                },
                {
                    "study_id": "methodology:cochrane",
                    "citation": "[3]",
                    "source_type": "methods_handbook",
                    "title": "Cochrane Handbook",
                },
                {
                    "study_id": "methodology:grade",
                    "citation": "[6]",
                    "source_type": "certainty_framework",
                    "title": "GRADE guidance",
                },
            ]
        },
        subdir="search",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evidence:guideline",
                    "citation": "[4]",
                    "source_type": "guideline",
                    "title": "Heart failure clinical guideline",
                },
                {
                    "study_id": "evidence:review",
                    "citation": "[5]",
                    "source_type": "prior_review",
                    "title": "Prior systematic review",
                },
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})

    intro_issue = next(
        item for item in payload["actionable_issues"]
        if item["code"] == "introduction_background_citation_count_low"
    )
    methods_issue = next(
        item for item in payload["actionable_issues"]
        if item["code"] == "methods_methodology_citation_count_low"
    )
    discussion_issue = next(
        item for item in payload["actionable_issues"]
        if item["code"] == "discussion_context_citation_count_low"
    )
    assert [item["citation"] for item in intro_issue["recommended_citations"]] == ["[5]"]
    assert [item["citation"] for item in methods_issue["recommended_citations"]][:2] == ["[3]", "[6]"]
    assert [item["citation"] for item in discussion_issue["recommended_citations"]][:2] == ["[5]", "[6]"]
    assert "[5]" in intro_issue["suggested_action"]
    assert "[3]" in methods_issue["suggested_action"]
    assert "[6]" in discussion_issue["suggested_action"]


def test_web_manuscript_quality_payload_exposes_polish_style_review_summary(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web polish style review summary", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Discussion\n\n"
            f"{_web_clinical_discussion_text(citation='[1]', effect='OR 0.66 (95% CI 0.53 to 0.82)', endpoint='mortality')}\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "accepted_chunks": 1,
            "rejected_chunks": 0,
            "unchanged_chunks": 0,
            "before": {
                "language": "en",
                "template_phrase_hits": {"it is important to note that": 3},
                "ai_style_signal": {
                    "score": 3,
                    "issues": [
                        {"code": "template_phrase_hits", "count": 3},
                        {"code": "repeated_sentence_starts", "count": 2},
                    ],
                },
            },
            "after": {
                "language": "en",
                "template_phrase_hits": {},
                "ai_style_signal": {
                    "score": 1,
                    "issues": [{"code": "low_sentence_length_variation", "value": 0.08}],
                },
            },
            "issues": [],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    style_review = payload["polish"]["style_review"]

    assert style_review["available"] is True
    assert style_review["before_score"] == 3
    assert style_review["after_score"] == 1
    assert style_review["delta"] == -2
    assert style_review["improved"] is True
    assert style_review["status"] == "improved_with_remaining_issues"
    assert style_review["resolved_issue_codes"] == ["template_phrase_hits", "repeated_sentence_starts"]
    assert style_review["resolved_issue_count"] == 2
    assert [item["code"] for item in style_review["resolved_issues"]] == [
        "template_phrase_hits",
        "repeated_sentence_starts",
    ]
    assert "Template-like transition phrases" in style_review["resolved_issues"][0]["message"]
    assert "resolved" in style_review["resolved_issues"][0]["status"]
    assert style_review["remaining_issue_codes"] == ["low_sentence_length_variation"]
    assert style_review["remaining_issue_count"] == 1
    assert style_review["remaining_issues"][0]["code"] == "low_sentence_length_variation"
    assert "Sentence lengths are too uniform" in style_review["remaining_issues"][0]["message"]
    assert "manual" in style_review["remaining_issues"][0]["suggested_action"].lower()
    assert style_review["can_auto_apply"] is False
    assert "fact-preserving" in style_review["suggested_action"]
    assert payload["review_required"] is True
    assert payload["quality_status"] == "needs_review"
    polish_warning = next(item for item in payload["warnings"] if item["code"] == "polish_review_required")
    assert polish_warning["manual_review_items"] == 1
    assert any("style signals" in action for action in polish_warning["next_actions"])


def test_web_manuscript_quality_payload_enriches_remaining_template_phrase_details(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web polish remaining template phrase details", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# 中文Meta分析稿件\n\n"
            "## 讨论\n\n"
            "总体而言，主要结局维持HR 0.81［1］。需要说明的是，GRADE判断没有改变［2］。\n\n"
            "## 参考文献\n\n"
            "［1］ Trial report.\n"
            "［2］ GRADE guidance.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "zh",
            "before": {"language": "zh", "ai_style_signal": {"score": 0, "issues": []}},
            "after": {
                "language": "zh",
                "template_phrase_hits": {"总体而言": 1, "需要说明的是": 1},
                "ai_style_signal": {
                    "score": 1,
                    "issues": [{"code": "template_phrase_hits", "count": 2}],
                },
            },
            "issues": [],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = payload["polish"]["style_review"]["remaining_issues"][0]

    assert issue["code"] == "template_phrase_hits"
    assert issue["phrases"] == ["总体而言", "需要说明的是"]
    assert "模板" in issue["message"]


def test_web_manuscript_quality_payload_does_not_push_more_polish_when_style_signals_clear(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web polish style clear", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Discussion\n\n"
            "The pooled OR was 0.66 (95% CI 0.53 to 0.82) [1].\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "accepted_chunks": 1,
            "rejected_chunks": 0,
            "unchanged_chunks": 0,
            "before": {
                "language": "en",
                "ai_style_signal": {
                    "score": 1,
                    "issues": [{"code": "template_phrase_hits", "count": 1}],
                },
            },
            "after": {
                "language": "en",
                "ai_style_signal": {"score": 0, "issues": []},
            },
            "issues": [],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    style_review = payload["polish"]["style_review"]

    assert style_review["status"] == "improved_no_obvious_remaining_issue"
    assert style_review["resolved_issue_codes"] == ["template_phrase_hits"]
    assert style_review["resolved_issue_count"] == 1
    assert style_review["remaining_issue_count"] == 0
    assert style_review["remaining_issue_codes"] == []
    assert "No obvious AI-style signal remains" in style_review["suggested_action"]
    assert "detector score" not in style_review["suggested_action"].lower()


def test_web_manuscript_quality_payload_exposes_polish_policy_and_proofreading(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web polish policy and proofreader", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
                "# Title\n\n"
                "## Discussion\n\n"
                f"{_web_clinical_discussion_text(citation='[1]', effect='OR 0.66', endpoint='mortality')}\n\n"
                "## References\n\n"
                "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "accepted_chunks": 1,
            "rejected_chunks": 0,
            "unchanged_chunks": 0,
            "style_policy": {
                "name": "MetaAgent conservative scholarly polish",
                "detector_evasion": False,
                "detector_optimization": "disabled",
                "external_proofreader_role": "review_only",
            },
            "proofreading": {
                "enabled": True,
                "status": "ok",
                "provider": "languagetool",
                "language_code": "en-US",
                "issue_count": 1,
                "issues": [{"rule_id": "STYLE_PASSIVE", "message": "Consider direct phrasing."}],
            },
            "before": {"language": "en", "ai_style_signal": {"score": 1, "issues": []}},
            "after": {"language": "en", "ai_style_signal": {"score": 0, "issues": []}},
            "issues": [],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})

    assert payload["polish"]["style_policy"]["detector_evasion"] is False
    assert payload["polish"]["style_policy"]["detector_optimization"] == "disabled"
    assert payload["polish"]["proofreading"]["provider"] == "languagetool"
    assert payload["polish"]["proofreading"]["issue_count"] == 1
    assert payload["polish"]["proofreading"]["issues"][0]["rule_id"] == "STYLE_PASSIVE"


def test_web_manuscript_quality_payload_warns_when_proofreading_failed(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web polish proofreader failure", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Discussion\n\n"
            f"{_web_clinical_discussion_text(citation='[1]', effect='OR 0.66', endpoint='mortality')}\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "accepted_chunks": 1,
            "rejected_chunks": 0,
            "unchanged_chunks": 0,
            "proofreading": {
                "enabled": True,
                "status": "failed",
                "provider": "languagetool",
                "issue_count": 0,
                "issues": [],
                "error": "timeout",
            },
            "before": {"language": "en", "ai_style_signal": {"score": 1, "issues": []}},
            "after": {"language": "en", "ai_style_signal": {"score": 0, "issues": []}},
            "issues": [],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})

    warning = next(item for item in payload["warnings"] if item["code"] == "polish_proofreading_failed")
    assert payload["quality_status"] == "needs_review"
    assert payload["review_required"] is True
    assert payload["polish"]["proofreading"]["status"] == "failed"
    assert payload["polish"]["proofreading"]["error"] == "timeout"
    assert payload["polish"]["review_queue"]["proofreading_failed"] is True
    assert payload["polish"]["review_queue"]["manual_review_items"] == 1
    assert "rerun" in warning["next_actions"][0].lower()


def test_web_manuscript_quality_payload_exposes_chinese_readability_issues(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web chinese readability issue", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# 中文Meta分析稿件\n\n"
            "## 摘要\n\n"
            "**重要性：** HFpEF需要证据综合。\n\n"
            "## 方法\n\n"
            "合格研究纳入经超声心动图、心脏磁共振或核素心室造影确认的HFpEF成人。\n\n"
            "## 讨论\n\n"
            "解释结果时，应考虑本地人群是否符合经超声心动图、心脏磁共振或核素心室造影确认的HFpEF成人。\n\n"
            "## 参考文献\n\n"
            "[1] Smith J. Trial report.\n"
        ),
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})

    warning = next(item for item in payload["warnings"] if item["code"] == "readability_issues")
    readability_issues = [item for item in payload["actionable_issues"] if item["source"] == "readability"]

    assert payload["quality_status"] == "blocked"
    assert payload["readability_audit"]["summary"]["failed_issues"] == 4
    assert warning["failed_issues"] == 4
    assert "可读性" in warning["message"]
    assert {"方法", "讨论"} <= {item["section"] for item in readability_issues}
    issue = next(item for item in readability_issues if item["section"] == "讨论")
    assert issue["section"] == "讨论"
    assert issue["code"] == "verbose_pico_fragment"
    assert "方法部分" in issue["suggested_action"]
    assert "超声心动图" in issue["snippet"]


def test_web_manuscript_quality_payload_exposes_rejected_polish_candidates(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web rejected polish candidates", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Discussion\n\n"
            "The pooled OR was 0.66 (95% CI 0.53 to 0.82) [1].\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "accepted_chunks": 0,
            "rejected_chunks": 1,
            "before": {"language": "en", "ai_style_signal": {"score": 1, "issues": []}},
            "after": {"language": "en", "ai_style_signal": {"score": 1, "issues": []}},
            "issues": [
                {
                    "code": "numeric_tokens_changed",
                    "heading": "Discussion",
                    "message": "Polish rewrite changed numeric values.",
                    "original_text": "The pooled OR was 0.66 (95% CI 0.53 to 0.82) [1].",
                    "candidate_text": "The pooled OR was 0.68 (95% CI 0.53 to 0.82) [1].",
                    "review_action": "manual_review_required",
                }
            ],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    rejected = payload["polish"]["rejected_edits"][0]
    actionable = next(item for item in payload["actionable_issues"] if item["source"] == "polish_guard")
    queue = payload["polish"]["review_queue"]

    assert rejected["candidate_id"].startswith("rejected:0:numeric_tokens_changed")
    assert rejected["can_auto_apply"] is False
    assert rejected["manual_accept_allowed"] is True
    assert rejected["code"] == "numeric_tokens_changed"
    assert "0.68" in rejected["candidate_text"]
    assert "0.66" in rejected["original_text"]
    assert "human confirms" in rejected["manual_accept_condition"]
    assert queue["status"] == "human_review_required"
    assert queue["rejected_candidates"] == 1
    assert queue["manual_review_items"] == 1
    assert queue["can_auto_apply_rejected_edits"] is False
    polish_warning = next(item for item in payload["warnings"] if item["code"] == "polish_review_required")
    assert polish_warning["review_queue_status"] == "human_review_required"
    assert any("human confirms" in action for action in polish_warning["next_actions"])
    assert actionable["review"]["can_auto_apply"] is False
    assert actionable["review"]["manual_accept_allowed"] is True
    assert "0.68" in actionable["review"]["candidate_text"]


def test_web_manuscript_quality_payload_explains_moved_citation_polish_rejection(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web polish moved citation rejection", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Discussion\n\n"
            "The pooled estimate favored treatment [1]. Interpretation should consider baseline risk.\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "accepted_chunks": 0,
            "rejected_chunks": 1,
            "before": {"language": "en", "ai_style_signal": {"score": 1, "issues": []}},
            "after": {"language": "en", "ai_style_signal": {"score": 1, "issues": []}},
            "issues": [
                {
                    "code": "citation_sentence_binding_changed",
                    "heading": "Discussion",
                    "message": "Polish rewrite moved citation markers to a different sentence or claim.",
                    "original_text": "The pooled estimate favored treatment [1]. Interpretation should consider baseline risk.",
                    "candidate_text": "The pooled estimate favored treatment. Interpretation should consider baseline risk [1].",
                    "original_citation_bindings": ["[1]|the pooled estimate favored treatment"],
                    "candidate_citation_bindings": ["[1]|interpretation should consider baseline risk"],
                    "review_action": "manual_review_required",
                }
            ],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["source"] == "polish_guard")
    rejected = payload["polish"]["rejected_edits"][0]

    assert issue["code"] == "citation_sentence_binding_changed"
    assert "same sentence" in issue["suggested_action"].lower()
    assert "citation" in issue["suggested_action"].lower()
    assert rejected["code"] == "citation_sentence_binding_changed"
    assert rejected["original_citation_bindings"] == ["[1]|the pooled estimate favored treatment"]
    assert rejected["candidate_citation_bindings"] == ["[1]|interpretation should consider baseline risk"]


def test_web_manuscript_quality_payload_localizes_chinese_moved_citation_polish_rejection(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web chinese polish moved citation rejection", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# 中文Meta分析稿件\n\n"
            "## 讨论\n\n"
            "主要结果显示获益［1］，但解释仍需结合基线风险。\n\n"
            "## 参考文献\n\n"
            "［1］ 示例参考文献。\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "zh",
            "accepted_chunks": 0,
            "rejected_chunks": 1,
            "before": {"language": "zh", "ai_style_signal": {"score": 1, "issues": []}},
            "after": {"language": "zh", "ai_style_signal": {"score": 1, "issues": []}},
            "issues": [
                {
                    "code": "citation_sentence_binding_changed",
                    "heading": "讨论",
                    "message": "Polish rewrite moved citation markers to a different sentence or claim.",
                    "original_text": "主要结果显示获益［1］，但解释仍需结合基线风险。",
                    "candidate_text": "主要结果显示获益，但解释仍需结合基线风险［1］。",
                    "original_citation_bindings": ["[1]|sentence:0|clause:0"],
                    "candidate_citation_bindings": ["[1]|sentence:0|clause:1"],
                    "review_action": "manual_review_required",
                }
            ],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["source"] == "polish_guard")
    rejected = payload["polish"]["rejected_edits"][0]

    assert issue["code"] == "citation_sentence_binding_changed"
    assert "同一句事实声明" in issue["suggested_action"]
    assert "不能从结果句、机制句或安全性句移动到另一句" in issue["suggested_action"]
    assert "不同句子或声明" in issue["message"]
    assert rejected["original_citation_bindings"] == ["[1]|sentence:0|clause:0"]
    assert rejected["candidate_citation_bindings"] == ["[1]|sentence:0|clause:1"]


def test_web_manuscript_quality_payload_localizes_chinese_actions(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web chinese manuscript quality actions", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# 中文Meta分析稿件\n\n"
            "## 引言\n\n"
            "背景证据需要引用［1］。\n\n"
            "## 方法\n\n"
            "根据PRISMA 2020构建检索、筛选和数据提取流程。\n\n"
            "## 结果\n\n"
            "主要Meta分析纳入2项研究［1］。\n\n"
            "## 讨论\n\n"
            "结果结合GRADE证据确定性解释［1］。\n\n"
            "## 参考文献\n\n"
            "［1］ Trial report.\n"
            "［2］ PRISMA 2020 statement.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "methodology_context.json",
        {"references": [{"citation": "[2]", "title": "PRISMA 2020 statement", "source_type": "reporting_guideline"}]},
        subdir="search",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "zh",
            "accepted_chunks": 0,
            "rejected_chunks": 1,
            "unchanged_chunks": 0,
            "before": {
                "language": "zh",
                "ai_style_signal": {"score": 2, "issues": [{"code": "template_phrase_hits"}]},
            },
            "after": {
                "language": "zh",
                "ai_style_signal": {"score": 1, "issues": [{"code": "low_sentence_length_variation"}]},
            },
            "issues": [
                {
                    "code": "citations_changed",
                    "heading": "讨论",
                    "message": "Polish rewrite changed citation markers.",
                    "original_text": "结果结合GRADE证据确定性解释［1］。",
                    "candidate_text": "结果结合GRADE证据确定性解释。",
                    "review_action": "manual_review_required",
                }
            ],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    methods_issue = next(
        item
        for item in payload["actionable_issues"]
        if item["source"] == "citation_audit" and item["section"] == "Methods"
    )
    polish_issue = next(item for item in payload["actionable_issues"] if item["source"] == "polish_guard")

    assert "请在方法部分至少加入一处文内引用" in methods_issue["suggested_action"]
    assert "建议插入：［2］" in methods_issue["suggested_action"]
    assert "人工复核" in polish_issue["suggested_action"]
    assert "不要改变数字、引用、研究名称或结论" in polish_issue["suggested_action"]
    rejected = payload["polish"]["rejected_edits"][0]
    assert "引用标记" in rejected["message"]
    assert "引用标记" in polish_issue["review"]["message"]
    assert "复核剩余的风格信号" in payload["polish"]["style_review"]["suggested_action"]
    coverage_warning = next(item for item in payload["warnings"] if item["code"] == "citation_coverage_issues")
    quality_warning = next(item for item in payload["warnings"] if item["code"] == "citation_quality_warnings")
    assert "引用覆盖" in coverage_warning["message"]
    assert "citation coverage" not in coverage_warning["message"]
    assert "引用质量" in quality_warning["message"]
    assert "citation quality" not in quality_warning["message"]
    rejection_warning = next(item for item in payload["warnings"] if item["code"] == "polish_rejections")
    review_warning = next(item for item in payload["warnings"] if item["code"] == "polish_review_required")
    assert "润色事实保护闸" in rejection_warning["message"]
    assert "Polish guard" not in rejection_warning["message"]
    assert "人工复核" in review_warning["message"]
    assert "human review" not in review_warning["message"].lower()
    assert any("人工确认" in action for action in review_warning["next_actions"])


def test_web_manuscript_quality_payload_uses_full_width_citations_in_chinese_actions(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web chinese citation display", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# 中文Meta分析稿件\n\n"
            "## 引言\n\n"
            "背景证据需要引用［1］。\n\n"
            "## 方法\n\n"
            "根据PRISMA 2020构建检索、筛选和数据提取流程。\n\n"
            "## 结果\n\n"
            "主要Meta分析纳入2项研究［1］。\n\n"
            "## 讨论\n\n"
            "结果结合GRADE证据确定性解释［1］。\n\n"
            "## 参考文献\n\n"
            "［1］ Trial report.\n"
            "［2］ PRISMA 2020 statement.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "methodology_context.json",
        {"references": [{"citation": "[2]", "title": "PRISMA 2020 statement", "source_type": "reporting_guideline"}]},
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    methods_issue = next(
        item
        for item in payload["actionable_issues"]
        if item["source"] == "citation_audit" and item["section"] == "Methods"
    )

    assert methods_issue["recommended_citations"][0]["citation"] == "[2]"
    assert methods_issue["recommended_citations"][0]["display_citation"] == "［2］"
    assert "建议插入：［2］" in methods_issue["suggested_action"]
    assert "建议插入：[2]" not in methods_issue["suggested_action"]


def test_web_manuscript_quality_payload_includes_actionable_citation_issue_targets(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web actionable manuscript quality", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Background statement [1].\n\n"
            "## Methods\n\n"
            "We searched PubMed and screened records according to predefined eligibility criteria.\n\n"
            "## Results\n\n"
            "The pooled OR was 0.66 [1].\n\n"
            "## Discussion\n\n"
            f"{_web_clinical_discussion_text(citation='[1]', effect='OR 0.66', endpoint='mortality')}\n\n"
            "## References\n\n"
            "[1] Trial report.\n"
        ),
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    actionable = payload["actionable_issues"]

    assert payload["action_required"] is True
    assert payload["review_required"] is True
    assert payload["quality_status"] == "blocked"
    methods_issue = next(item for item in actionable if item["section"] == "Methods")
    assert methods_issue["source"] == "citation_audit"
    assert methods_issue["code"] == "section_citations_missing"
    assert methods_issue["target"]["type"] == "markdown_section"
    assert methods_issue["target"]["anchor"] == "methods"
    assert "searched PubMed" in methods_issue["snippet"]
    assert "Add at least one inline citation" in methods_issue["suggested_action"]


def test_web_manuscript_quality_payload_exposes_polish_rejection_review_material(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web polish rejection review", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Discussion\n\n"
            "The pooled OR was 0.66 (95% CI 0.53 to 0.82) [1].\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "accepted_chunks": 0,
            "rejected_chunks": 1,
            "unchanged_chunks": 0,
            "issues": [
                {
                    "code": "numeric_tokens_changed",
                    "heading": "Discussion",
                    "message": "Polish rewrite changed numeric tokens.",
                    "chunk_index": 0,
                    "original_text": "The pooled OR was 0.66 (95% CI 0.53 to 0.82) [1].",
                    "candidate_text": "The pooled OR was 0.70 (95% CI 0.53 to 0.82) [1].",
                    "review_action": "manual_review_required",
                }
            ],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["source"] == "polish_guard")

    assert issue["section"] == "Discussion"
    assert issue["target"]["anchor"] == "discussion"
    assert issue["review"]["original_text"].startswith("The pooled OR was 0.66")
    assert issue["review"]["candidate_text"].startswith("The pooled OR was 0.70")
    assert issue["review"]["review_action"] == "manual_review_required"
    assert "manual review" in issue["suggested_action"].lower()


def test_web_manuscript_quality_payload_explains_directional_polish_rejection(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web polish directional review", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Discussion\n\n"
            "The intervention did not reduce mortality compared with placebo [1].\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "accepted_chunks": 0,
            "rejected_chunks": 1,
            "unchanged_chunks": 0,
            "issues": [
                {
                    "code": "directional_terms_changed",
                    "heading": "Discussion",
                    "message": "Polish rewrite changed directional conclusion terms.",
                    "chunk_index": 0,
                    "original_text": "The intervention did not reduce mortality compared with placebo [1].",
                    "candidate_text": "The intervention reduced mortality compared with placebo [1].",
                    "original_directional_terms": ["not_lower"],
                    "candidate_directional_terms": ["lower"],
                    "review_action": "manual_review_required",
                }
            ],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["source"] == "polish_guard")

    assert issue["code"] == "directional_terms_changed"
    assert "direction" in issue["suggested_action"].lower()
    assert "negation" in issue["suggested_action"].lower()
    assert issue["review"]["original_directional_terms"] == ["not_lower"]
    assert issue["review"]["candidate_directional_terms"] == ["lower"]


def test_web_manuscript_quality_payload_explains_clinical_claim_polish_rejection(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web polish clinical claim review", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Discussion\n\n"
            "The primary analysis was associated with an HR of 0.81 for hospitalization [1].\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "accepted_chunks": 0,
            "rejected_chunks": 1,
            "unchanged_chunks": 0,
            "issues": [
                {
                    "code": "clinical_claim_terms_changed",
                    "heading": "Discussion",
                    "message": "Polish rewrite changed clinical claim terms.",
                    "chunk_index": 0,
                    "original_text": "The primary analysis was associated with an HR of 0.81 for hospitalization [1].",
                    "candidate_text": "The primary analysis showed a clinical benefit with an HR of 0.81 for hospitalization [1].",
                    "original_clinical_claim_terms": [],
                    "candidate_clinical_claim_terms": ["benefit"],
                    "review_action": "manual_review_required",
                }
            ],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["source"] == "polish_guard")

    assert issue["code"] == "clinical_claim_terms_changed"
    assert "benefit" in issue["suggested_action"].lower()
    assert "causal" in issue["suggested_action"].lower()
    assert issue["review"]["original_clinical_claim_terms"] == []
    assert issue["review"]["candidate_clinical_claim_terms"] == ["benefit"]


def test_web_manuscript_quality_payload_explains_interpretive_certainty_polish_rejection(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web polish certainty review", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Discussion\n\n"
            "The pooled estimate may reduce hospitalization, but certainty remains limited [1].\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "accepted_chunks": 0,
            "rejected_chunks": 1,
            "unchanged_chunks": 0,
            "issues": [
                {
                    "code": "interpretive_certainty_changed",
                    "heading": "Discussion",
                    "message": "Polish rewrite changed interpretive certainty terms.",
                    "chunk_index": 0,
                    "original_text": "The pooled estimate may reduce hospitalization, but certainty remains limited [1].",
                    "candidate_text": "The pooled estimate reduces hospitalization, but certainty remains limited [1].",
                    "original_interpretive_certainty_terms": ["hedged"],
                    "candidate_interpretive_certainty_terms": [],
                    "review_action": "manual_review_required",
                }
            ],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["source"] == "polish_guard")

    assert issue["code"] == "interpretive_certainty_changed"
    assert "certainty" in issue["suggested_action"].lower()
    assert "hedg" in issue["suggested_action"].lower()
    assert issue["review"]["original_interpretive_certainty_terms"] == ["hedged"]
    assert issue["review"]["candidate_interpretive_certainty_terms"] == []


def test_web_manuscript_quality_payload_explains_certainty_rating_polish_rejection(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web polish certainty rating review", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Discussion\n\n"
            "GRADE certainty was low for the hospitalization outcome [1].\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "accepted_chunks": 0,
            "rejected_chunks": 1,
            "unchanged_chunks": 0,
            "issues": [
                {
                    "code": "certainty_rating_changed",
                    "heading": "Discussion",
                    "message": "Polish rewrite changed GRADE certainty ratings.",
                    "chunk_index": 0,
                    "original_text": "GRADE certainty was low for the hospitalization outcome [1].",
                    "candidate_text": "GRADE certainty was moderate for the hospitalization outcome [1].",
                    "original_certainty_ratings": ["low"],
                    "candidate_certainty_ratings": ["moderate"],
                    "review_action": "manual_review_required",
                }
            ],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["source"] == "polish_guard")

    assert issue["code"] == "certainty_rating_changed"
    assert "grade" in issue["suggested_action"].lower()
    assert "certainty rating" in issue["suggested_action"].lower()
    assert issue["review"]["original_certainty_ratings"] == ["low"]
    assert issue["review"]["candidate_certainty_ratings"] == ["moderate"]


def test_web_manuscript_quality_payload_explains_risk_of_bias_rating_polish_rejection(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web polish rob rating review", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Discussion\n\n"
            "The primary trials were judged at low risk of bias for outcome measurement [1].\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "accepted_chunks": 0,
            "rejected_chunks": 1,
            "unchanged_chunks": 0,
            "issues": [
                {
                    "code": "risk_of_bias_rating_changed",
                    "heading": "Discussion",
                    "message": "Polish rewrite changed risk-of-bias rating terms.",
                    "chunk_index": 0,
                    "original_text": "The primary trials were judged at low risk of bias for outcome measurement [1].",
                    "candidate_text": "The primary trials were judged at high risk of bias for outcome measurement [1].",
                    "original_risk_of_bias_ratings": ["low"],
                    "candidate_risk_of_bias_ratings": ["high"],
                    "review_action": "manual_review_required",
                }
            ],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["source"] == "polish_guard")

    assert issue["code"] == "risk_of_bias_rating_changed"
    assert "risk of bias" in issue["suggested_action"].lower()
    assert "rating" in issue["suggested_action"].lower()
    assert issue["review"]["original_risk_of_bias_ratings"] == ["low"]
    assert issue["review"]["candidate_risk_of_bias_ratings"] == ["high"]


def test_web_manuscript_quality_payload_explains_statistical_model_polish_rejection(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web polish statistical model review", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Methods\n\n"
            "We used a random-effects model with REML estimation for the primary synthesis [1].\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "accepted_chunks": 0,
            "rejected_chunks": 1,
            "unchanged_chunks": 0,
            "issues": [
                {
                    "code": "statistical_model_changed",
                    "heading": "Methods",
                    "message": "Polish rewrite changed statistical model or estimator terms.",
                    "chunk_index": 0,
                    "original_text": "We used a random-effects model with REML estimation for the primary synthesis [1].",
                    "candidate_text": "We used a fixed-effect model with REML estimation for the primary synthesis [1].",
                    "original_statistical_models": ["random_effects"],
                    "candidate_statistical_models": ["fixed_effect"],
                    "review_action": "manual_review_required",
                }
            ],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["source"] == "polish_guard")

    assert issue["code"] == "statistical_model_changed"
    assert "statistical model" in issue["suggested_action"].lower()
    assert "random" in issue["suggested_action"].lower()
    assert issue["review"]["original_statistical_models"] == ["random_effects"]
    assert issue["review"]["candidate_statistical_models"] == ["fixed_effect"]


def test_web_manuscript_quality_payload_explains_statistical_significance_polish_rejection(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web polish statistical significance review", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Results\n\n"
            "The subgroup interaction was not statistically significant (P = 0.08) [1].\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "accepted_chunks": 0,
            "rejected_chunks": 1,
            "unchanged_chunks": 0,
            "issues": [
                {
                    "code": "statistical_significance_changed",
                    "heading": "Results",
                    "message": "Polish rewrite changed statistical significance interpretation.",
                    "chunk_index": 0,
                    "original_text": "The subgroup interaction was not statistically significant (P = 0.08) [1].",
                    "candidate_text": "The subgroup interaction was statistically significant (P = 0.08) [1].",
                    "original_statistical_significance": ["not_significant"],
                    "candidate_statistical_significance": ["significant"],
                    "review_action": "manual_review_required",
                }
            ],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["source"] == "polish_guard")

    assert issue["code"] == "statistical_significance_changed"
    assert "statistical significance" in issue["suggested_action"].lower()
    assert "not significant" in issue["suggested_action"].lower()
    assert issue["review"]["original_statistical_significance"] == ["not_significant"]
    assert issue["review"]["candidate_statistical_significance"] == ["significant"]


def test_web_manuscript_quality_payload_explains_study_design_polish_rejection(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web polish study design review", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Methods\n\n"
            "Eligible evidence came from randomized controlled trials with blinded outcome adjudication [1].\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "accepted_chunks": 0,
            "rejected_chunks": 1,
            "unchanged_chunks": 0,
            "issues": [
                {
                    "code": "study_design_changed",
                    "heading": "Methods",
                    "message": "Polish rewrite changed study design terms.",
                    "chunk_index": 0,
                    "original_text": (
                        "Eligible evidence came from randomized controlled trials "
                        "with blinded outcome adjudication [1]."
                    ),
                    "candidate_text": (
                        "Eligible evidence came from observational cohort studies "
                        "with blinded outcome adjudication [1]."
                    ),
                    "original_study_design_terms": ["randomized_trial", "blinded"],
                    "candidate_study_design_terms": ["observational_study", "cohort_study", "blinded"],
                    "review_action": "manual_review_required",
                }
            ],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["source"] == "polish_guard")

    assert issue["code"] == "study_design_changed"
    assert "study design" in issue["suggested_action"].lower()
    assert "randomized" in issue["suggested_action"].lower()
    assert issue["review"]["original_study_design_terms"] == ["randomized_trial", "blinded"]
    assert issue["review"]["candidate_study_design_terms"] == ["observational_study", "cohort_study", "blinded"]


def test_web_manuscript_quality_payload_explains_language_change_polish_rejection(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web polish language review", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Methods\n\n"
            "We included randomized trials and extracted prespecified outcomes in duplicate [1].\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "accepted_chunks": 0,
            "rejected_chunks": 1,
            "unchanged_chunks": 0,
            "issues": [
                {
                    "code": "language_changed",
                    "heading": "Methods",
                    "message": "Polish rewrite changed the manuscript output language.",
                    "chunk_index": 0,
                    "original_text": "We included randomized trials and extracted prespecified outcomes in duplicate [1].",
                    "candidate_text": "我们纳入随机试验，并重复提取预先指定的结局 [1].",
                    "original_language": "en",
                    "candidate_language": "zh",
                    "original_language_counts": {"language": "en", "cjk_chars": 0, "latin_words": 8},
                    "candidate_language_counts": {"language": "zh", "cjk_chars": 20, "latin_words": 0},
                    "review_action": "manual_review_required",
                }
            ],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["source"] == "polish_guard")

    assert issue["code"] == "language_changed"
    assert "output language" in issue["suggested_action"].lower()
    assert issue["review"]["original_language"] == "en"
    assert issue["review"]["candidate_language"] == "zh"
    assert issue["review"]["candidate_language_counts"]["language"] == "zh"


def test_web_manuscript_quality_payload_explains_clinical_entity_polish_rejection(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web polish clinical entity review", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Results\n\n"
            "The pooled HR for heart failure hospitalization was 0.81 (95% CI 0.75 to 0.88) [1].\n\n"
            "## References\n\n"
            "[1] Example reference.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "manuscript_polish_audit.json",
        {
            "enabled": True,
            "language": "en",
            "accepted_chunks": 0,
            "rejected_chunks": 1,
            "unchanged_chunks": 0,
            "issues": [
                {
                    "code": "clinical_entities_changed",
                    "heading": "Results",
                    "message": "Polish rewrite changed clinical entity terms.",
                    "chunk_index": 0,
                    "original_text": "The pooled HR for heart failure hospitalization was 0.81 (95% CI 0.75 to 0.88) [1].",
                    "candidate_text": "The pooled HR for cardiovascular mortality was 0.81 (95% CI 0.75 to 0.88) [1].",
                    "original_clinical_entities": ["heart_failure_hospitalization"],
                    "candidate_clinical_entities": ["cardiovascular_death"],
                    "review_action": "manual_review_required",
                }
            ],
        },
        subdir="manuscript",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["source"] == "polish_guard")

    assert issue["code"] == "clinical_entities_changed"
    assert "outcome" in issue["suggested_action"].lower()
    assert "population" in issue["suggested_action"].lower()
    assert issue["review"]["original_clinical_entities"] == ["heart_failure_hospitalization"]
    assert issue["review"]["candidate_clinical_entities"] == ["cardiovascular_death"]


def test_web_manuscript_quality_payload_recommends_section_specific_citations(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web citation suggestions", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Background statement [1].\n\n"
            "## Methods\n\n"
            "We searched PubMed and screened records according to predefined eligibility criteria.\n\n"
            "## Results\n\n"
                "The pooled OR was 0.66 [1].\n\n"
                "## Discussion\n\n"
                f"{_web_clinical_discussion_text(citation='[1]', effect='OR 0.66', endpoint='mortality')}\n\n"
                "## References\n\n"
                "[1] Trial report.\n\n"
            "[2] The PRISMA 2020 statement.\n\n"
            "[3] Cochrane Handbook.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {"citation": "[2]", "title": "The PRISMA 2020 statement", "source_type": "reporting_guideline"},
                {"citation": "[3]", "title": "Cochrane Handbook", "source_type": "methods_handbook"},
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    methods_issue = next(item for item in payload["actionable_issues"] if item["section"] == "Methods")
    suggestions = methods_issue["recommended_citations"]

    assert [item["citation"] for item in suggestions[:2]] == ["[2]", "[3]"]
    assert suggestions[0]["reason"] == "reporting_guideline"
    assert "Suggested insertion" in methods_issue["suggested_action"]
    assert "[2]" in methods_issue["suggested_action"]


def test_web_manuscript_quality_payload_surfaces_sparse_reference_warnings(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web sparse citation warnings", output_dir=tmp_path)
    long_paragraph = ". ".join(["Background evidence sentence"] * 80) + "."
    project.save_text(
        "draft.md",
        "\n\n".join([
            "# Sparse reference manuscript",
                f"## Introduction\n{long_paragraph} [1].",
                f"## Methods\n{long_paragraph} [1].",
                f"## Results\n{long_paragraph} [1].",
                f"## Discussion\n{long_paragraph} [1].\n\n{_web_clinical_discussion_text(citation='[1]', effect='OR 0.66', endpoint='mortality')}",
                "## References",
                "[1] Trial report.",
            "[2] PRISMA 2020 statement.",
            "[3] GRADE guidance.",
            "[4] Prior review.",
        ]),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {"references": [{"citation": "[4]", "title": "Prior review", "source_type": "prior_review"}]},
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    warning_codes = {warning["code"] for warning in payload["warnings"]}
    quality_issue = next(item for item in payload["actionable_issues"] if item["code"] == "insufficient_reference_count")

    assert payload["citation_audit"]["passed"] is True
    assert payload["action_required"] is False
    assert payload["review_required"] is True
    assert payload["quality_status"] == "needs_review"
    assert "citation_quality_warnings" in warning_codes
    assert quality_issue["severity"] == "warn"
    assert quality_issue["section"] == "References"
    assert quality_issue["recommended_citations"][0]["citation"] == "[4]"
    assert "Add more verified references" in quality_issue["suggested_action"]


def test_web_sparse_reference_recommendations_prioritize_uncited_context_references(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web sparse uncited citation suggestions", output_dir=tmp_path)
    long_paragraph = " ".join(["background evidence sentence"] * 80)
    project.save_text(
        "draft.md",
        "\n\n".join([
            "# Sparse reference manuscript",
            f"## Introduction\n{long_paragraph} [1].",
            f"## Methods\n{long_paragraph} [1].",
            f"## Results\n{long_paragraph} [1].",
            f"## Discussion\n{long_paragraph} [1].",
            "## References",
            "[1] Trial report.",
            "[2] Guideline.",
            "[3] Prior systematic review.",
            "[4] PRISMA statement.",
        ]),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {"citation": "[1]", "title": "Trial report", "source_type": "included_trial"},
                {"citation": "[2]", "title": "Guideline", "source_type": "guideline"},
                {"citation": "[3]", "title": "Prior systematic review", "source_type": "prior_review"},
            ]
        },
        subdir="search",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {"citation": "[4]", "title": "PRISMA statement", "source_type": "reporting_guideline"},
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    low_unique = next(item for item in payload["actionable_issues"] if item["code"] == "low_unique_cited_references")
    citations = [item["citation"] for item in low_unique["recommended_citations"]]

    assert citations[:3] == ["[3]", "[2]", "[4]"]
    assert "[1]" not in citations[:3]
    assert low_unique["recommended_citations"][0]["recommended_sections"] == ["Introduction", "Discussion"]


def test_preview_citation_patch_for_sparse_warning_uses_recommended_section(tmp_path) -> None:
    from start import META_ROOT, _load_manuscript_quality_payload, _preview_manuscript_citation_patch_payload

    project = Project(
        "web sparse citation patch preview",
        output_dir=META_ROOT / "output" / "pytest_sparse_citation_patch_preview" / uuid4().hex,
    )
    long_paragraph = " ".join(["background evidence sentence"] * 80)
    draft = "\n\n".join([
        "# Sparse reference manuscript",
        f"## Introduction\n{long_paragraph} [1].",
        f"## Methods\n{long_paragraph} [1].",
        f"## Results\n{long_paragraph} [1].",
        f"## Discussion\n{long_paragraph} [1].",
        "## References",
        "[1] Trial report.",
        "[2] Guideline.",
        "[3] Prior systematic review.",
    ])
    project.save_text("draft.md", draft, subdir="manuscript")
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {"citation": "[1]", "title": "Trial report", "source_type": "included_trial"},
                {"citation": "[2]", "title": "Guideline", "source_type": "guideline"},
                {"citation": "[3]", "title": "Prior systematic review", "source_type": "prior_review"},
            ]
        },
        subdir="search",
    )
    issue = next(
        item
        for item in _load_manuscript_quality_payload(project, {})["actionable_issues"]
        if item["code"] == "low_unique_cited_references"
    )

    result = _preview_manuscript_citation_patch_payload(
        {
            "project_dir": str(project.base_dir),
            "issue_id": issue["id"],
            "citation": "[3]",
        }
    )

    assert result["ok"] is True
    assert result["target_section"] == "Introduction"
    assert "# Sparse reference manuscript [3]" not in result["updated_text"]
    assert f"## Introduction\n{long_paragraph} [1] [3]." in result["updated_text"]
    assert project.load_text("draft.md", subdir="manuscript") == draft


def test_preview_citation_patch_accepts_full_width_payload_and_preserves_chinese_style(tmp_path) -> None:
    from start import META_ROOT, _load_manuscript_quality_payload, _preview_manuscript_citation_patch_payload

    project = Project(
        "web full width citation patch",
        output_dir=META_ROOT / "output" / "pytest_full_width_citation_patch" / uuid4().hex,
    )
    project.save_text(
        "draft.md",
        "\n\n".join([
            "# 中文Meta分析稿件",
            "## 引言\n背景证据需要引用［1］。",
            "## 方法\n根据PRISMA 2020构建检索、筛选和数据提取流程。",
            "## 结果\n主要Meta分析纳入2项研究［1］。",
            "## 讨论\n结果结合GRADE证据确定性解释［1］。",
            "## 参考文献",
            "［1］ Trial report.",
            "［2］ PRISMA 2020 statement.",
        ]),
        subdir="manuscript",
    )
    project.save_json(
        "methodology_context.json",
        {"references": [{"citation": "[2]", "title": "PRISMA 2020 statement", "source_type": "reporting_guideline"}]},
        subdir="search",
    )
    quality = _load_manuscript_quality_payload(project, {})
    issue = next(
        item
        for item in quality["actionable_issues"]
        if item["code"] == "section_citations_missing" and item["section"] == "Methods"
    )

    result = _preview_manuscript_citation_patch_payload(
        {
            "project_dir": str(project.base_dir),
            "issue_id": issue["id"],
            "citation": "［2］",
            "target_section": "Methods",
        }
    )

    assert result["ok"] is True
    assert result["citation"] == "[2]"
    assert "## 方法\n根据PRISMA 2020构建检索、筛选和数据提取流程［2］。" in result["updated_text"]
    assert "[2]。" not in result["updated_text"]


def test_apply_citation_patch_logs_full_width_display_citation_for_chinese_style(tmp_path) -> None:
    from start import META_ROOT, _apply_manuscript_citation_patch_payload, _load_manuscript_quality_payload

    project = Project(
        "web full width citation patch apply",
        output_dir=META_ROOT / "output" / "pytest_full_width_citation_patch_apply" / uuid4().hex,
    )
    project.save_text(
        "draft.md",
        "\n\n".join([
            "# 中文Meta分析稿件",
            "## 引言\n背景证据需要引用［1］。",
            "## 方法\n根据PRISMA 2020构建检索、筛选和数据提取流程。",
            "## 结果\n主要Meta分析纳入2项研究［1］。",
            "## 讨论\n结果结合GRADE证据确定性解释［1］。",
            "## 参考文献",
            "［1］ Trial report.",
            "［2］ PRISMA 2020 statement.",
        ]),
        subdir="manuscript",
    )
    project.save_json(
        "methodology_context.json",
        {"references": [{"citation": "[2]", "title": "PRISMA 2020 statement", "source_type": "reporting_guideline"}]},
        subdir="search",
    )
    quality = _load_manuscript_quality_payload(project, {})
    issue = next(
        item
        for item in quality["actionable_issues"]
        if item["code"] == "section_citations_missing" and item["section"] == "Methods"
    )

    result = _apply_manuscript_citation_patch_payload(
        {
            "project_dir": str(project.base_dir),
            "issue_id": issue["id"],
            "citation": "［2］",
            "target_section": "Methods",
            "expected_revision": 0,
        },
        user_id="tester",
    )
    draft = project.load_text("draft.md", subdir="manuscript")
    log = project.load_json("manuscript_citation_fixes.json", subdir="manuscript")

    assert result["ok"] is True
    assert result["citation"] == "[2]"
    assert result["display_citation"] == "［2］"
    assert "根据PRISMA 2020构建检索、筛选和数据提取流程［2］。" in draft
    assert log["entries"][0]["citation"] == "[2]"
    assert log["entries"][0]["display_citation"] == "［2］"


def test_web_quality_payload_exposes_external_reference_add_candidates(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web external reference candidates", output_dir=tmp_path)
    long_paragraph = " ".join(["background evidence sentence"] * 80)
    project.save_text(
        "draft.md",
        "\n\n".join([
            "# Sparse reference manuscript",
            f"## Introduction\n{long_paragraph} [1].",
            f"## Methods\n{long_paragraph} [1].",
            f"## Results\n{long_paragraph} [1].",
            f"## Discussion\n{long_paragraph} [1].",
            "## References",
            "[1] Trial report.",
        ]),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:guide:hf",
                    "title": "Heart failure guideline",
                    "source_type": "guideline",
                    "paper": {
                        "title": "Heart failure guideline",
                        "authors": ["Example Society"],
                        "journal": "Guideline",
                        "year": "2024",
                        "url": "https://example.test/guideline",
                    },
                }
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "insufficient_reference_count")
    candidate = issue["reference_add_candidates"][0]

    assert candidate["candidate_id"] == "evimed:guide:hf"
    assert candidate["proposed_citation"] == "[2]"
    assert candidate["recommended_sections"] == ["Introduction", "Discussion"]
    assert "Heart failure guideline" in candidate["reference_text"]
    assert "Add reference candidate" in issue["suggested_action"]


def test_web_quality_payload_suggests_external_reference_for_section_missing_citation(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web section reference candidate", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        "\n\n".join([
            "# Sparse section manuscript",
            "## Introduction\nHeart failure with preserved ejection fraction has a substantial clinical burden.",
            "## Methods\nWe followed PRISMA guidance [1].",
            "## Results\nThe pooled HR was 0.82 [2].",
            "## Discussion\nThe findings were interpreted cautiously [2].",
            "## References",
            "[1] PRISMA 2020 statement.",
            "[2] Trial report.",
        ]),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:prior-review:hfpef",
                    "title": "SGLT2 inhibitors for heart failure: prior systematic review",
                    "source_type": "prior_review",
                    "paper": {
                        "title": "SGLT2 inhibitors for heart failure: prior systematic review",
                        "authors": ["Example A", "Example B"],
                        "journal": "Heart Failure Reviews",
                        "year": "2025",
                        "doi": "10.1000/hf-review",
                    },
                }
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(
        item
        for item in payload["actionable_issues"]
        if item["code"] == "section_citations_missing" and item["section"] == "Introduction"
    )
    candidate = issue["reference_add_candidates"][0]

    assert candidate["candidate_id"] == "evimed:prior-review:hfpef"
    assert candidate["proposed_citation"] == "[3]"
    assert candidate["recommended_sections"] == ["Introduction", "Discussion"]
    assert "prior systematic review" in candidate["reference_text"]
    assert "Add reference candidate [3]" in issue["suggested_action"]


def test_reference_add_candidate_prefers_claim_specific_intro_background_source(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web claim specific intro reference candidate", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure imposes substantial morbidity and mortality worldwide.\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two trial reports contributed data [1].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [1].\n\n"
            "## References\n\n"
            "[1] Trial report.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:guideline:hf",
                    "title": "Heart failure clinical guideline",
                    "source_type": "clinical_guideline",
                    "paper": {
                        "title": "Heart failure clinical guideline",
                        "authors": ["Guideline Group"],
                        "journal": "Guideline",
                        "year": "2024",
                    },
                },
                {
                    "study_id": "evimed:background:hf-burden",
                    "title": "Heart failure epidemiology and burden",
                    "source_type": "pubmed_background",
                    "paper": {
                        "title": "Heart failure epidemiology and burden",
                        "authors": ["Background Group"],
                        "journal": "Circulation",
                        "year": "2023",
                    },
                },
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "uncited_introduction_background_claim")
    candidate = issue["reference_add_candidates"][0]

    assert issue["raw_issue"]["background_claim_types"] == ["disease_burden"]
    assert candidate["candidate_id"] == "evimed:background:hf-burden"
    assert candidate["source_type"] == "pubmed_background"
    assert candidate["recommended_sections"][0] == "Introduction"


def test_reference_add_candidate_prefers_claim_specific_methods_source(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web claim specific methods reference candidate", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [1].\n\n"
            "## Methods\n\n"
            "This review followed PRISMA guidance [1]. "
            "Risk of bias was assessed using the Cochrane RoB 2 tool.\n\n"
            "## Results\n\n"
            "Two trial reports contributed data [1].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [1].\n\n"
            "## References\n\n"
            "[1] Trial report.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {
                    "study_id": "methodology:prisma",
                    "title": "PRISMA 2020 statement",
                    "source_type": "reporting_guideline",
                    "paper": {
                        "title": "PRISMA 2020 statement",
                        "authors": ["PRISMA Group"],
                        "journal": "BMJ",
                        "year": "2021",
                    },
                },
                {
                    "study_id": "methodology:rob2",
                    "title": "Cochrane RoB 2 tool",
                    "source_type": "risk_of_bias_tool",
                    "paper": {
                        "title": "Cochrane RoB 2 tool",
                        "authors": ["Cochrane Methods Group"],
                        "journal": "Cochrane",
                        "year": "2024",
                    },
                },
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "uncited_methods_methodology_claim")
    candidate = issue["reference_add_candidates"][0]

    assert issue["raw_issue"]["methodology_claim_types"] == ["risk_of_bias_tool"]
    assert candidate["candidate_id"] == "methodology:rob2"
    assert candidate["source_type"] == "risk_of_bias_tool"
    assert candidate["recommended_sections"][0] == "Methods"


def test_reference_add_candidate_allows_discussion_certainty_context_source(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web discussion certainty reference candidate", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure remains clinically important [1].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two trial reports contributed data [1].\n\n"
            "## Discussion\n\n"
            "GRADE certainty remained low for the primary outcome.\n\n"
            "## References\n\n"
            "[1] Trial report.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:review:hf",
                    "title": "Prior systematic review of heart failure",
                    "source_type": "prior_review",
                    "paper": {
                        "title": "Prior systematic review of heart failure",
                        "authors": ["Evidence Group"],
                        "journal": "Evidence Reviews",
                        "year": "2025",
                    },
                }
            ]
        },
        subdir="search",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {
                    "study_id": "methodology:grade",
                    "title": "GRADE guidance",
                    "source_type": "certainty_framework",
                    "paper": {
                        "title": "GRADE guidance",
                        "authors": ["GRADE Working Group"],
                        "journal": "J Clin Epidemiol",
                        "year": "2024",
                    },
                }
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "uncited_discussion_context_claim")
    candidate = issue["reference_add_candidates"][0]

    assert issue["raw_issue"]["discussion_context_claim_types"] == ["certainty_context"]
    assert candidate["candidate_id"] == "methodology:grade"
    assert candidate["source_type"] == "certainty_framework"
    assert candidate["recommended_sections"][0] == "Discussion"


def test_web_reference_add_candidates_count_full_width_existing_references(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web full width reference candidates", output_dir=tmp_path)
    long_paragraph = " ".join(["background evidence sentence"] * 160)
    project.save_text(
        "draft.md",
        "\n\n".join([
            "# 中文Meta分析稿件",
            f"## 引言\n{long_paragraph}［1，2］。",
            f"## 方法\n{long_paragraph}［2］。",
            f"## 结果\n{long_paragraph}［1-2］。",
            f"## 讨论\n{long_paragraph}［1，2］。",
            "## 参考文献",
            "［1］ Trial report.",
            "［2］ PRISMA 2020 statement.",
        ]),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:review:zh",
                    "title": "Prior systematic review",
                    "source_type": "prior_review",
                    "paper": {
                        "title": "Prior systematic review",
                        "authors": ["Evidence Group"],
                        "journal": "Evidence Reviews",
                        "year": "2025",
                        "doi": "10.1000/fullwidth",
                    },
                }
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "insufficient_reference_count")
    candidate = issue["reference_add_candidates"][0]

    assert payload["citation_audit"]["summary"]["reference_entries"] == 2
    assert candidate["proposed_citation"] == "[3]"
    assert candidate["reference_number"] == 3


def test_web_reference_add_candidate_uses_full_width_display_citation_in_chinese_actions(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web full width reference candidate display", output_dir=tmp_path)
    long_paragraph = " ".join(["background evidence sentence"] * 160)
    project.save_text(
        "draft.md",
        "\n\n".join([
            "# 中文Meta分析稿件",
            f"## 引言\n{long_paragraph}［1，2］。",
            f"## 方法\n{long_paragraph}［2］。",
            f"## 结果\n{long_paragraph}［1-2］。",
            f"## 讨论\n{long_paragraph}［1，2］。",
            "## 参考文献",
            "［1］ Trial report.",
            "［2］ PRISMA 2020 statement.",
        ]),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:review:zh-display",
                    "title": "Prior systematic review",
                    "source_type": "prior_review",
                    "paper": {
                        "title": "Prior systematic review",
                        "authors": ["Evidence Group"],
                        "journal": "Evidence Reviews",
                        "year": "2025",
                        "doi": "10.1000/fullwidthdisplay",
                    },
                }
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "insufficient_reference_count")
    candidate = issue["reference_add_candidates"][0]

    assert candidate["proposed_citation"] == "[3]"
    assert candidate["display_proposed_citation"] == "［3］"
    assert "可新增参考文献候选 ［3］" in issue["suggested_action"]
    assert "可新增参考文献候选 [3]" not in issue["suggested_action"]


def test_web_quality_payload_includes_ready_reference_add_batch_suggestion(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web reference add batch suggestion", output_dir=tmp_path)
    long_paragraph = " ".join(["background evidence sentence"] * 80)
    project.save_text(
        "draft.md",
        "\n\n".join([
            "# Sparse reference manuscript",
            f"## Introduction\n{long_paragraph} [1].",
            f"## Methods\n{long_paragraph} [1].",
            f"## Results\n{long_paragraph} [1].",
            f"## Discussion\n{long_paragraph} [1].",
            "## References",
            "[1] Trial report.",
        ]),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:guide:hf",
                    "title": "Heart failure guideline",
                    "source_type": "guideline",
                    "paper": {
                        "title": "Heart failure guideline",
                        "authors": ["Example Society"],
                        "journal": "Guideline",
                        "year": "2024",
                        "url": "https://example.test/guideline",
                    },
                },
                {
                    "study_id": "evimed:review:hf",
                    "title": "Prior systematic review of heart failure",
                    "source_type": "prior_review",
                    "paper": {
                        "title": "Prior systematic review of heart failure",
                        "authors": ["Evidence Group"],
                        "journal": "Evidence Reviews",
                        "year": "2025",
                        "doi": "10.1000/review",
                    },
                },
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    batch = payload["reference_add_batch"]

    assert batch["available"] is True
    assert batch["requires_human_review"] is True
    assert batch["preview_request_type"] == "manuscript_reference_add_batch_preview"
    assert batch["apply_request_type"] == "manuscript_reference_add_batch_apply"
    assert batch["expected_revision"] == 0
    assert batch["preview_payload"]["project_dir"] == str(project.base_dir)
    assert batch["preview_payload"]["expected_revision"] == 0
    assert [item["candidate_id"] for item in batch["items"]] == ["evimed:guide:hf", "evimed:review:hf"]
    assert [item["target_section"] for item in batch["items"]] == ["Introduction", "Introduction"]
    assert batch["items"][0]["trust"]["requires_human_review"] is True
    assert batch["items"][0]["source"]["source"] == "reference_context"
    assert batch["items"][0]["title"] == "Heart failure guideline"


def test_reference_add_batch_targets_the_issue_section_when_candidate_fits_multiple_sections(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web reference add batch section target", output_dir=tmp_path)
    project.save_text(
        "draft.md",
        "\n\n".join([
            "# Section target manuscript",
            "## Introduction\nBackground statement [1].",
            "## Methods\nWe followed eligibility criteria [1].",
            "## Results\nThe pooled HR was 0.82 [1].",
            "## Discussion\nThe findings need comparison with prior evidence.",
            "## References",
            "[1] Trial report.",
        ]),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:review:hf",
                    "title": "Prior systematic review of heart failure",
                    "source_type": "prior_review",
                    "paper": {
                        "title": "Prior systematic review of heart failure",
                        "authors": ["Evidence Group"],
                        "journal": "Evidence Reviews",
                        "year": "2025",
                        "doi": "10.1000/review",
                    },
                }
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    batch = payload["reference_add_batch"]

    assert batch["available"] is True
    assert batch["items"][0]["issue_section"] == "Discussion"
    assert batch["items"][0]["recommended_sections"] == ["Introduction", "Discussion"]
    assert batch["items"][0]["target_section"] == "Discussion"
    assert batch["preview_payload"]["items"][0]["target_section"] == "Discussion"


def test_reference_add_batch_prioritizes_distinct_issues_before_alternates(tmp_path) -> None:
    from start import _build_reference_add_batch_suggestion

    project = Project("web reference add batch issue spread", output_dir=tmp_path)
    intro_candidates = [
        {
            "candidate_id": f"intro:background:{idx}",
            "title": f"Background source {idx}",
            "source_type": "pubmed_background",
            "proposed_citation": f"[{idx + 2}]",
            "reference_number": idx + 2,
            "recommended_sections": ["Introduction", "Discussion"],
        }
        for idx in range(5)
    ]
    actionables = [
        {
            "id": "citation_audit:0:uncited_introduction_background_claim:introduction",
            "source": "citation_audit",
            "code": "uncited_introduction_background_claim",
            "section": "Introduction",
            "reference_add_candidates": intro_candidates,
        },
        {
            "id": "citation_audit:1:uncited_methods_methodology_claim:methods",
            "source": "citation_audit",
            "code": "uncited_methods_methodology_claim",
            "section": "Methods",
            "reference_add_candidates": [
                {
                    "candidate_id": "methodology:rob2",
                    "title": "Cochrane RoB 2 tool",
                    "source_type": "risk_of_bias_tool",
                    "proposed_citation": "[7]",
                    "reference_number": 7,
                    "recommended_sections": ["Methods"],
                }
            ],
        },
        {
            "id": "citation_audit:2:uncited_discussion_context_claim:discussion",
            "source": "citation_audit",
            "code": "uncited_discussion_context_claim",
            "section": "Discussion",
            "reference_add_candidates": [
                {
                    "candidate_id": "methodology:grade",
                    "title": "GRADE guidance",
                    "source_type": "certainty_framework",
                    "proposed_citation": "[8]",
                    "reference_number": 8,
                    "recommended_sections": ["Discussion", "Methods"],
                }
            ],
        },
    ]

    batch = _build_reference_add_batch_suggestion(project, actionables, max_count=3)

    assert [item["candidate_id"] for item in batch["items"]] == [
        "intro:background:0",
        "methodology:rob2",
        "methodology:grade",
    ]
    assert [item["issue_section"] for item in batch["items"]] == ["Introduction", "Methods", "Discussion"]
    assert [item["target_section"] for item in batch["items"]] == ["Introduction", "Methods", "Discussion"]
    assert batch["preview_payload"]["items"] == [
        {
            "issue_id": "citation_audit:0:uncited_introduction_background_claim:introduction",
            "candidate_id": "intro:background:0",
            "target_section": "Introduction",
        },
        {
            "issue_id": "citation_audit:1:uncited_methods_methodology_claim:methods",
            "candidate_id": "methodology:rob2",
            "target_section": "Methods",
        },
        {
            "issue_id": "citation_audit:2:uncited_discussion_context_claim:discussion",
            "candidate_id": "methodology:grade",
            "target_section": "Discussion",
        },
    ]


def test_reference_add_batch_reuses_one_new_reference_across_multiple_sections(tmp_path) -> None:
    from start import META_ROOT, _load_manuscript_quality_payload, _preview_manuscript_reference_add_batch_payload

    project = Project(
        "web reference add batch reuse candidate",
        output_dir=META_ROOT / "output" / "pytest_reference_add_batch_reuse_candidate" / uuid4().hex,
    )
    draft = "\n\n".join([
        "# Reuse reference manuscript",
        "## Introduction\nHeart failure with preserved ejection fraction has substantial clinical burden.",
        "## Methods\nWe followed eligibility criteria [1].",
        "## Results\nThe pooled HR was 0.82 [1].",
        "## Discussion\nThe findings need comparison with prior evidence.",
        "## References",
        "[1] Trial report.",
    ])
    project.save_text("draft.md", draft, subdir="manuscript")
    project.save_text("references.bib", "@article{trial,title={Trial report}}\n")
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:review:hf",
                    "title": "Prior systematic review of heart failure",
                    "source_type": "prior_review",
                    "paper": {
                        "title": "Prior systematic review of heart failure",
                        "authors": ["Evidence Group"],
                        "journal": "Evidence Reviews",
                        "year": "2025",
                        "doi": "10.1000/review",
                    },
                }
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    batch = payload["reference_add_batch"]

    assert batch["available"] is True
    assert [item["target_section"] for item in batch["items"]] == ["Introduction", "Discussion"]
    assert [item["candidate_id"] for item in batch["items"]] == ["evimed:review:hf", "evimed:review:hf"]

    result = _preview_manuscript_reference_add_batch_payload(batch["preview_payload"])

    assert result["ok"] is True
    assert result["added_references"] == 1
    assert [item["citation"] for item in result["items"]] == ["[2]", "[2]"]
    assert "## Introduction\nHeart failure with preserved ejection fraction has substantial clinical burden [2]." in result["updated_text"]
    assert "## Discussion\nThe findings need comparison with prior evidence [2]." in result["updated_text"]
    assert result["updated_text"].count("[2] Evidence Group. Prior systematic review of heart failure.") == 1
    assert len(result["bibtex_entries"]) == 1
    assert project.load_text("draft.md", subdir="manuscript") == draft


def test_apply_reference_add_batch_logs_reused_reference_citation_separately(tmp_path) -> None:
    from start import META_ROOT, _apply_manuscript_reference_add_batch_payload, _load_manuscript_quality_payload

    project = Project(
        "web reference add batch reuse apply",
        output_dir=META_ROOT / "output" / "pytest_reference_add_batch_reuse_apply" / uuid4().hex,
    )
    draft = "\n\n".join([
        "# Reuse reference manuscript",
        "## Introduction\nHeart failure with preserved ejection fraction has substantial clinical burden.",
        "## Methods\nWe followed eligibility criteria [1].",
        "## Results\nThe pooled HR was 0.82 [1].",
        "## Discussion\nThe findings need comparison with prior evidence.",
        "## References",
        "[1] Trial report.",
    ])
    project.save_text("draft.md", draft, subdir="manuscript")
    project.save_text("references.bib", "@article{trial,title={Trial report}}\n")
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:review:hf",
                    "title": "Prior systematic review of heart failure",
                    "source_type": "prior_review",
                    "paper": {
                        "title": "Prior systematic review of heart failure",
                        "authors": ["Evidence Group"],
                        "journal": "Evidence Reviews",
                        "year": "2025",
                        "doi": "10.1000/review",
                    },
                }
            ]
        },
        subdir="search",
    )

    quality = _load_manuscript_quality_payload(project, {})
    batch = quality["reference_add_batch"]
    result = _apply_manuscript_reference_add_batch_payload(batch["apply_payload"], user_id="tester")

    assert result["ok"] is True
    assert result["added_references"] == 1
    assert [item["citation"] for item in result["items"]] == ["[2]", "[2]"]
    assert project.load_text("draft.md", subdir="manuscript").count("[2] Evidence Group. Prior systematic review of heart failure.") == 1
    assert project.load_text("references.bib").count("Prior systematic review of heart failure") == 1
    log = project.load_json("manuscript_citation_fixes.json", subdir="manuscript")
    actions = [entry["action"] for entry in log["entries"]]
    assert actions == ["add_reference", "reuse_reference_citation"]
    assert [entry["reference_added"] for entry in log["entries"]] == [True, False]
    assert {entry["citation"] for entry in log["entries"]} == {"[2]"}


def test_preview_reference_add_preserves_full_width_chinese_citation_style(tmp_path) -> None:
    from start import META_ROOT, _load_manuscript_quality_payload, _preview_manuscript_reference_add_payload

    project = Project(
        "web full width reference add style",
        output_dir=META_ROOT / "output" / "pytest_full_width_reference_add_style" / uuid4().hex,
    )
    long_paragraph = " ".join(["background evidence sentence"] * 160)
    project.save_text(
        "draft.md",
        "\n\n".join([
            "# 中文Meta分析稿件",
            f"## 引言\n{long_paragraph}［1，2］。",
            f"## 方法\n{long_paragraph}［2］。",
            f"## 结果\n{long_paragraph}［1-2］。",
            f"## 讨论\n{long_paragraph}［1，2］。",
            "## 参考文献",
            "［1］ Trial report.",
            "［2］ PRISMA 2020 statement.",
        ]),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:review:zh-style",
                    "title": "Prior systematic review",
                    "source_type": "prior_review",
                    "paper": {
                        "title": "Prior systematic review",
                        "authors": ["Evidence Group"],
                        "journal": "Evidence Reviews",
                        "year": "2025",
                        "doi": "10.1000/fullwidthstyle",
                    },
                }
            ]
        },
        subdir="search",
    )
    quality = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in quality["actionable_issues"] if item["code"] == "insufficient_reference_count")
    candidate = issue["reference_add_candidates"][0]

    result = _preview_manuscript_reference_add_payload(
        {
            "project_dir": str(project.base_dir),
            "issue_id": issue["id"],
            "candidate_id": candidate["candidate_id"],
            "target_section": "Introduction",
        }
    )

    assert result["ok"] is True
    assert result["citation"] == "[3]"
    assert f"## 引言\n{long_paragraph}［1，2］［3］。" in result["updated_text"]
    assert "［3］ Evidence Group. Prior systematic review." in result["updated_text"]
    assert "[3] Evidence Group. Prior systematic review." not in result["updated_text"]


def test_apply_reference_add_logs_full_width_display_citation_for_chinese_style(tmp_path) -> None:
    from start import META_ROOT, _apply_manuscript_reference_add_payload, _load_manuscript_quality_payload

    project = Project(
        "web full width reference add display log",
        output_dir=META_ROOT / "output" / "pytest_full_width_reference_add_display_log" / uuid4().hex,
    )
    long_paragraph = " ".join(["background evidence sentence"] * 160)
    project.save_text(
        "draft.md",
        "\n\n".join([
            "# 中文Meta分析稿件",
            f"## 引言\n{long_paragraph}［1，2］。",
            f"## 方法\n{long_paragraph}［2］。",
            f"## 结果\n{long_paragraph}［1-2］。",
            f"## 讨论\n{long_paragraph}［1，2］。",
            "## 参考文献",
            "［1］ Trial report.",
            "［2］ PRISMA 2020 statement.",
        ]),
        subdir="manuscript",
    )
    project.save_text("references.bib", "@article{trial,title={Trial report}}\n")
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:review:zh-display-log",
                    "title": "Prior systematic review",
                    "source_type": "prior_review",
                    "paper": {
                        "title": "Prior systematic review",
                        "authors": ["Evidence Group"],
                        "journal": "Evidence Reviews",
                        "year": "2025",
                        "doi": "10.1000/fullwidthdisplaylog",
                    },
                }
            ]
        },
        subdir="search",
    )
    quality = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in quality["actionable_issues"] if item["code"] == "insufficient_reference_count")
    candidate = issue["reference_add_candidates"][0]

    result = _apply_manuscript_reference_add_payload(
        {
            "project_dir": str(project.base_dir),
            "issue_id": issue["id"],
            "candidate_id": candidate["candidate_id"],
            "target_section": "Introduction",
        },
        user_id="tester",
    )

    draft = project.load_text("draft.md", subdir="manuscript")
    log = project.load_json("manuscript_citation_fixes.json", subdir="manuscript")

    assert result["ok"] is True
    assert result["citation"] == "[3]"
    assert result["display_citation"] == "［3］"
    assert f"## 引言\n{long_paragraph}［1，2］［3］。" in draft
    assert "［3］ Evidence Group. Prior systematic review." in draft
    assert log["entries"][0]["citation"] == "[3]"
    assert log["entries"][0]["display_citation"] == "［3］"


def test_reference_add_candidate_exposes_source_and_review_state(tmp_path) -> None:
    from start import _load_manuscript_quality_payload

    project = Project("web reference candidate review metadata", output_dir=tmp_path)
    long_paragraph = " ".join(["background evidence sentence"] * 80)
    project.save_text(
        "draft.md",
        "\n\n".join([
            "# Sparse reference manuscript",
            f"## Introduction\n{long_paragraph} [1].",
            f"## Methods\n{long_paragraph} [1].",
            f"## Results\n{long_paragraph} [1].",
            f"## Discussion\n{long_paragraph} [1].",
            "## References",
            "[1] Trial report.",
        ]),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:review:hf",
                    "title": "Prior systematic review of SGLT2 inhibitors in heart failure",
                    "source_type": "prior_review",
                    "paper": {
                        "title": "Prior systematic review of SGLT2 inhibitors in heart failure",
                        "authors": ["Evidence Group"],
                        "journal": "Evidence Reviews",
                        "year": "2025",
                        "doi": "10.1000/example",
                        "pmid": "12345678",
                        "url": "https://example.test/review",
                    },
                }
            ]
        },
        subdir="search",
    )

    payload = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in payload["actionable_issues"] if item["code"] == "insufficient_reference_count")
    candidate = issue["reference_add_candidates"][0]

    assert candidate["can_auto_apply"] is False
    assert candidate["trust"]["status"] == "needs_review"
    assert candidate["trust"]["requires_human_review"] is True
    assert candidate["trust"]["review_action"] == "verify_reference_before_adding"
    assert candidate["source"]["source_type"] == "prior_review"
    assert candidate["source"]["study_id"] == "evimed:review:hf"
    assert candidate["source"]["doi"] == "10.1000/example"
    assert candidate["source"]["pmid"] == "12345678"
    assert candidate["source"]["url"] == "https://example.test/review"


def test_apply_reference_add_candidate_appends_reference_and_inserts_citation(tmp_path) -> None:
    from start import META_ROOT, _apply_manuscript_reference_add_payload, _load_manuscript_quality_payload

    project = Project(
        "web add reference candidate apply",
        output_dir=META_ROOT / "output" / "pytest_reference_add_apply" / uuid4().hex,
    )
    long_paragraph = " ".join(["background evidence sentence"] * 80)
    project.save_text(
        "draft.md",
        "\n\n".join([
            "# Sparse reference manuscript",
            f"## Introduction\n{long_paragraph} [1].",
            f"## Methods\n{long_paragraph} [1].",
            f"## Results\n{long_paragraph} [1].",
            f"## Discussion\n{long_paragraph} [1].",
            "## References",
            "[1] Trial report.",
        ]),
        subdir="manuscript",
    )
    project.save_text("references.bib", "@article{trial,title={Trial report}}\n")
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:guide:hf",
                    "title": "Heart failure guideline",
                    "source_type": "guideline",
                    "paper": {
                        "title": "Heart failure guideline",
                        "authors": ["Example Society"],
                        "journal": "Guideline",
                        "year": "2024",
                        "url": "https://example.test/guideline",
                    },
                }
            ]
        },
        subdir="search",
    )
    quality = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in quality["actionable_issues"] if item["code"] == "insufficient_reference_count")
    candidate = issue["reference_add_candidates"][0]

    result = _apply_manuscript_reference_add_payload(
        {
            "project_dir": str(project.base_dir),
            "issue_id": issue["id"],
            "candidate_id": candidate["candidate_id"],
            "target_section": "Introduction",
        },
        user_id="tester",
    )

    draft = project.load_text("draft.md", subdir="manuscript")
    bibtex = project.load_text("references.bib")
    log = project.load_json("manuscript_citation_fixes.json", subdir="manuscript")

    assert result["ok"] is True
    assert result["applied"] is True
    assert result["citation"] == "[2]"
    assert f"## Introduction\n{long_paragraph} [1] [2]." in draft
    assert "[2] Example Society. Heart failure guideline. *Guideline*. 2024. https://example.test/guideline" in draft
    assert "Heart failure guideline" in bibtex
    assert log["entries"][0]["action"] == "add_reference"
    assert log["entries"][0]["candidate_id"] == "evimed:guide:hf"


def test_apply_reference_add_candidate_preserves_bibliography_heading(tmp_path) -> None:
    from start import META_ROOT, _apply_manuscript_reference_add_payload, _load_manuscript_quality_payload

    project = Project(
        "web add reference bibliography heading",
        output_dir=META_ROOT / "output" / "pytest_reference_add_bibliography" / uuid4().hex,
    )
    long_paragraph = " ".join(["background evidence sentence"] * 80)
    project.save_text(
        "draft.md",
        "\n\n".join([
            "# Sparse reference manuscript",
            f"## Introduction\n{long_paragraph} [1].",
            f"## Methods\n{long_paragraph} [1].",
            f"## Results\n{long_paragraph} [1].",
            f"## Discussion\n{long_paragraph} [1].",
            "## Bibliography",
            "[1] Trial report.",
        ]),
        subdir="manuscript",
    )
    project.save_text("references.bib", "@article{trial,title={Trial report}}\n")
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:guide:hf",
                    "title": "Heart failure guideline",
                    "source_type": "guideline",
                    "paper": {
                        "title": "Heart failure guideline",
                        "authors": ["Example Society"],
                        "journal": "Guideline",
                        "year": "2024",
                        "url": "https://example.test/guideline",
                    },
                }
            ]
        },
        subdir="search",
    )
    quality = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in quality["actionable_issues"] if item["code"] == "insufficient_reference_count")
    candidate = issue["reference_add_candidates"][0]

    assert candidate["proposed_citation"] == "[2]"

    result = _apply_manuscript_reference_add_payload(
        {
            "project_dir": str(project.base_dir),
            "issue_id": issue["id"],
            "candidate_id": candidate["candidate_id"],
            "target_section": "Introduction",
        },
        user_id="tester",
    )

    draft = project.load_text("draft.md", subdir="manuscript")

    assert result["ok"] is True
    assert result["citation"] == "[2]"
    assert f"## Introduction\n{long_paragraph} [1] [2]." in draft
    assert draft.count("## Bibliography") == 1
    assert "## References" not in draft
    assert "[2] Example Society. Heart failure guideline. *Guideline*. 2024. https://example.test/guideline" in draft


def test_preview_reference_add_candidate_does_not_modify_project_files(tmp_path) -> None:
    from start import META_ROOT, _load_manuscript_quality_payload, _preview_manuscript_reference_add_payload

    project = Project(
        "web add reference candidate preview",
        output_dir=META_ROOT / "output" / "pytest_reference_add_preview" / uuid4().hex,
    )
    long_paragraph = " ".join(["background evidence sentence"] * 80)
    draft = "\n\n".join([
        "# Sparse reference manuscript",
        f"## Introduction\n{long_paragraph} [1].",
        f"## Methods\n{long_paragraph} [1].",
        f"## Results\n{long_paragraph} [1].",
        f"## Discussion\n{long_paragraph} [1].",
        "## References",
        "[1] Trial report.",
    ])
    project.save_text("draft.md", draft, subdir="manuscript")
    project.save_text("references.bib", "@article{trial,title={Trial report}}\n")
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:guide:hf",
                    "title": "Heart failure guideline",
                    "source_type": "guideline",
                    "paper": {
                        "title": "Heart failure guideline",
                        "authors": ["Example Society"],
                        "journal": "Guideline",
                        "year": "2024",
                        "url": "https://example.test/guideline",
                    },
                }
            ]
        },
        subdir="search",
    )
    quality = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in quality["actionable_issues"] if item["code"] == "insufficient_reference_count")
    candidate = issue["reference_add_candidates"][0]
    original_bibtex = project.load_text("references.bib")
    log_path = project.get_path("manuscript_citation_fixes.json", subdir="manuscript")

    result = _preview_manuscript_reference_add_payload(
        {
            "project_dir": str(project.base_dir),
            "issue_id": issue["id"],
            "candidate_id": candidate["candidate_id"],
            "target_section": "Introduction",
        }
    )

    assert result["ok"] is True
    assert result["applied"] is False
    assert result["citation"] == "[2]"
    assert "Heart failure guideline" in result["reference_text"]
    assert "+[2] Example Society. Heart failure guideline." in result["diff"]
    assert project.load_text("draft.md", subdir="manuscript") == draft
    assert project.load_text("references.bib") == original_bibtex
    assert log_path.exists() is False


def test_apply_reference_add_candidate_rejects_stale_revision_without_writes(tmp_path) -> None:
    from start import META_ROOT, _apply_manuscript_reference_add_payload, _load_manuscript_quality_payload

    project = Project(
        "web add reference revision conflict",
        output_dir=META_ROOT / "output" / "pytest_reference_add_revision_conflict" / uuid4().hex,
    )
    long_paragraph = " ".join(["background evidence sentence"] * 80)
    draft = "\n\n".join([
        "# Sparse reference manuscript",
        f"## Introduction\n{long_paragraph} [1].",
        f"## Methods\n{long_paragraph} [1].",
        f"## Results\n{long_paragraph} [1].",
        f"## Discussion\n{long_paragraph} [1].",
        "## References",
        "[1] Trial report.",
    ])
    project.save_text("draft.md", draft, subdir="manuscript")
    project.save_text("references.bib", "@article{trial,title={Trial report}}\n")
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:guide:hf",
                    "title": "Heart failure guideline",
                    "source_type": "guideline",
                    "paper": {
                        "title": "Heart failure guideline",
                        "authors": ["Example Society"],
                        "journal": "Guideline",
                        "year": "2024",
                        "url": "https://example.test/guideline",
                    },
                }
            ]
        },
        subdir="search",
    )
    quality = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in quality["actionable_issues"] if item["code"] == "insufficient_reference_count")
    candidate = issue["reference_add_candidates"][0]
    project.save_json(
        "manuscript_citation_fixes.json",
        {"schema_version": 1, "current_revision": 2, "entries": [{"revision": 2, "action": "manual_edit"}]},
        subdir="manuscript",
    )
    original_bibtex = project.load_text("references.bib")

    result = _apply_manuscript_reference_add_payload(
        {
            "project_dir": str(project.base_dir),
            "issue_id": issue["id"],
            "candidate_id": candidate["candidate_id"],
            "expected_revision": 1,
        },
        user_id="tester",
    )

    assert result["ok"] is False
    assert result["error"] == "revision_conflict"
    assert result["current_revision"] == 2
    assert project.load_text("draft.md", subdir="manuscript") == draft
    assert project.load_text("references.bib") == original_bibtex
    assert project.load_json("manuscript_citation_fixes.json", subdir="manuscript")["entries"] == [
        {"revision": 2, "action": "manual_edit"}
    ]


def test_preview_reference_add_batch_adds_multiple_candidates_without_writes(tmp_path) -> None:
    from start import META_ROOT, _load_manuscript_quality_payload, _preview_manuscript_reference_add_batch_payload

    project = Project(
        "web add reference batch preview",
        output_dir=META_ROOT / "output" / "pytest_reference_add_batch_preview" / uuid4().hex,
    )
    long_paragraph = " ".join(["background evidence sentence"] * 80)
    draft = "\n\n".join([
        "# Sparse reference manuscript",
        f"## Introduction\n{long_paragraph} [1].",
        f"## Methods\n{long_paragraph} [1].",
        f"## Results\n{long_paragraph} [1].",
        f"## Discussion\n{long_paragraph} [1].",
        "## References",
        "[1] Trial report.",
    ])
    project.save_text("draft.md", draft, subdir="manuscript")
    project.save_text("references.bib", "@article{trial,title={Trial report}}\n")
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:guide:hf",
                    "title": "Heart failure guideline",
                    "source_type": "guideline",
                    "paper": {
                        "title": "Heart failure guideline",
                        "authors": ["Example Society"],
                        "journal": "Guideline",
                        "year": "2024",
                        "url": "https://example.test/guideline",
                    },
                },
                {
                    "study_id": "evimed:review:hf",
                    "title": "Prior systematic review of heart failure",
                    "source_type": "prior_review",
                    "paper": {
                        "title": "Prior systematic review of heart failure",
                        "authors": ["Evidence Group"],
                        "journal": "Evidence Reviews",
                        "year": "2025",
                        "doi": "10.1000/review",
                    },
                },
            ]
        },
        subdir="search",
    )
    quality = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in quality["actionable_issues"] if item["code"] == "insufficient_reference_count")
    original_bibtex = project.load_text("references.bib")

    result = _preview_manuscript_reference_add_batch_payload(
        {
            "project_dir": str(project.base_dir),
            "items": [
                {"issue_id": issue["id"], "candidate_id": "evimed:guide:hf", "target_section": "Introduction"},
                {"issue_id": issue["id"], "candidate_id": "evimed:review:hf", "target_section": "Discussion"},
            ],
        }
    )

    assert result["ok"] is True
    assert result["applied"] is False
    assert [item["citation"] for item in result["items"]] == ["[2]", "[3]"]
    assert f"## Introduction\n{long_paragraph} [1] [2]." in result["updated_text"]
    assert f"## Discussion\n{long_paragraph} [1] [3]." in result["updated_text"]
    assert "[2] Example Society. Heart failure guideline." in result["updated_text"]
    assert "[3] Evidence Group. Prior systematic review of heart failure." in result["updated_text"]
    assert project.load_text("draft.md", subdir="manuscript") == draft
    assert project.load_text("references.bib") == original_bibtex


def test_apply_reference_add_batch_logs_each_candidate_and_updates_quality(tmp_path) -> None:
    from start import META_ROOT, _apply_manuscript_reference_add_batch_payload, _load_manuscript_quality_payload

    project = Project(
        "web add reference batch apply",
        output_dir=META_ROOT / "output" / "pytest_reference_add_batch_apply" / uuid4().hex,
    )
    long_paragraph = " ".join(["background evidence sentence"] * 80)
    project.save_text(
        "draft.md",
        "\n\n".join([
            "# Sparse reference manuscript",
            f"## Introduction\n{long_paragraph} [1].",
            f"## Methods\n{long_paragraph} [1].",
            f"## Results\n{long_paragraph} [1].",
            f"## Discussion\n{long_paragraph} [1].",
            "## References",
            "[1] Trial report.",
        ]),
        subdir="manuscript",
    )
    project.save_text("references.bib", "@article{trial,title={Trial report}}\n")
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:guide:hf",
                    "title": "Heart failure guideline",
                    "source_type": "guideline",
                    "paper": {
                        "title": "Heart failure guideline",
                        "authors": ["Example Society"],
                        "journal": "Guideline",
                        "year": "2024",
                        "url": "https://example.test/guideline",
                    },
                },
                {
                    "study_id": "evimed:review:hf",
                    "title": "Prior systematic review of heart failure",
                    "source_type": "prior_review",
                    "paper": {
                        "title": "Prior systematic review of heart failure",
                        "authors": ["Evidence Group"],
                        "journal": "Evidence Reviews",
                        "year": "2025",
                        "doi": "10.1000/review",
                    },
                },
            ]
        },
        subdir="search",
    )
    quality = _load_manuscript_quality_payload(project, {})
    issue = next(item for item in quality["actionable_issues"] if item["code"] == "insufficient_reference_count")

    result = _apply_manuscript_reference_add_batch_payload(
        {
            "project_dir": str(project.base_dir),
            "expected_revision": 0,
            "items": [
                {"issue_id": issue["id"], "candidate_id": "evimed:guide:hf", "target_section": "Introduction"},
                {"issue_id": issue["id"], "candidate_id": "evimed:review:hf", "target_section": "Discussion"},
            ],
        },
        user_id="tester",
    )

    draft = project.load_text("draft.md", subdir="manuscript")
    bibtex = project.load_text("references.bib")
    log = project.load_json("manuscript_citation_fixes.json", subdir="manuscript")

    assert result["ok"] is True
    assert result["applied"] is True
    assert result["current_revision"] == 1
    assert [item["citation"] for item in result["items"]] == ["[2]", "[3]"]
    assert [item["display_citation"] for item in result["items"]] == ["[2]", "[3]"]
    assert f"## Introduction\n{long_paragraph} [1] [2]." in draft
    assert f"## Discussion\n{long_paragraph} [1] [3]." in draft
    assert "Heart failure guideline" in bibtex
    assert "Prior systematic review of heart failure" in bibtex
    assert len(log["entries"]) == 2
    assert {entry["candidate_id"] for entry in log["entries"]} == {"evimed:guide:hf", "evimed:review:hf"}
    assert all(entry["action"] == "add_reference" for entry in log["entries"])
    assert {entry["display_citation"] for entry in log["entries"]} == {"[2]", "[3]"}
    assert result["manuscript_quality"]["review_required"] is True
    assert result["quality_delta"]["reference_entries_before"] == 1
    assert result["quality_delta"]["reference_entries_after"] == 3
    assert result["quality_delta"]["reference_entries_added"] == 2
    assert result["quality_delta"]["quality_status_after"] == result["manuscript_quality"]["quality_status"]
    assert all(entry["quality_delta"]["reference_entries_added"] == 2 for entry in log["entries"])


def test_apply_reference_add_batch_updates_context_citations_for_quality_recheck(tmp_path) -> None:
    from start import META_ROOT, _apply_manuscript_reference_add_batch_payload, _load_manuscript_quality_payload

    project = Project(
        "web reference add batch quality context",
        output_dir=META_ROOT / "output" / "pytest_reference_add_batch_quality_context" / uuid4().hex,
    )
    project.save_text(
        "draft.md",
        "\n\n".join([
            "# Claim-specific citation manuscript",
            "## Introduction\nExisting trial context is available [1]. Heart failure imposes substantial morbidity and mortality worldwide.",
            "## Methods\nEligibility criteria were predefined [1]. Risk of bias was assessed using the Cochrane RoB 2 tool.",
            "## Results\nTwo trial reports contributed data [1].",
            "## Discussion\nThe findings were interpreted cautiously [1]. GRADE certainty remained low for the primary outcome.",
            "## References",
            "[1] Trial report.",
        ]),
        subdir="manuscript",
    )
    project.save_text("references.bib", "@article{trial,title={Trial report}}\n")
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {
                    "study_id": "evimed:background:hf-burden",
                    "title": "Heart failure epidemiology and burden",
                    "source_type": "pubmed_background",
                    "paper": {
                        "title": "Heart failure epidemiology and burden",
                        "authors": ["Background Group"],
                        "journal": "Circulation",
                        "year": "2023",
                    },
                },
            ]
        },
        subdir="search",
    )
    project.save_json(
        "methodology_context.json",
        {
            "references": [
                {
                    "study_id": "methodology:rob2",
                    "title": "Cochrane RoB 2 tool",
                    "source_type": "risk_of_bias_tool",
                    "paper": {
                        "title": "Cochrane RoB 2 tool",
                        "authors": ["Cochrane Methods Group"],
                        "journal": "Cochrane",
                        "year": "2024",
                    },
                },
                {
                    "study_id": "methodology:grade",
                    "title": "GRADE guidance",
                    "source_type": "certainty_framework",
                    "paper": {
                        "title": "GRADE guidance",
                        "authors": ["GRADE Working Group"],
                        "journal": "J Clin Epidemiol",
                        "year": "2024",
                    },
                },
            ]
        },
        subdir="search",
    )
    quality = _load_manuscript_quality_payload(project, {})
    issues = {item["code"]: item for item in quality["actionable_issues"]}

    result = _apply_manuscript_reference_add_batch_payload(
        {
            "project_dir": str(project.base_dir),
            "expected_revision": 0,
            "items": [
                {
                    "issue_id": issues["uncited_introduction_background_claim"]["id"],
                    "candidate_id": "evimed:background:hf-burden",
                    "target_section": "Introduction",
                },
                {
                    "issue_id": issues["uncited_methods_methodology_claim"]["id"],
                    "candidate_id": "methodology:rob2",
                    "target_section": "Methods",
                },
                {
                    "issue_id": issues["uncited_discussion_context_claim"]["id"],
                    "candidate_id": "methodology:grade",
                    "target_section": "Discussion",
                },
            ],
        },
        user_id="tester",
    )

    evidence_context = project.load_json("evidence_context.json", subdir="search")
    methodology_context = project.load_json("methodology_context.json", subdir="search")
    remaining_codes = {item["code"] for item in result["manuscript_quality"]["actionable_issues"]}

    assert result["ok"] is True
    assert [item["citation"] for item in result["items"]] == ["[2]", "[3]", "[4]"]
    assert evidence_context["references"][0]["citation"] == "[2]"
    assert [item["citation"] for item in methodology_context["references"]] == ["[3]", "[4]"]
    assert "uncited_introduction_background_claim" not in remaining_codes
    assert "uncited_methods_methodology_claim" not in remaining_codes
    assert "uncited_discussion_context_claim" not in remaining_codes


def test_preview_manuscript_citation_patch_does_not_modify_draft(tmp_path) -> None:
    from start import META_ROOT, _load_manuscript_quality_payload, _preview_manuscript_citation_patch_payload

    project = Project(
        "web citation patch preview",
        output_dir=META_ROOT / "output" / "pytest_citation_patch_preview" / uuid4().hex,
    )
    draft = (
        "# Title\n\n"
        "## Introduction\n\n"
        "Background statement [1].\n\n"
        "## Methods\n\n"
        "We searched PubMed and screened records according to predefined eligibility criteria.\n\n"
        "## Results\n\n"
        "The pooled OR was 0.66 [1].\n\n"
        "## Discussion\n\n"
        "The findings were interpreted with GRADE [1].\n\n"
        "## References\n\n"
        "[1] Trial report.\n\n"
        "[2] The PRISMA 2020 statement.\n"
    )
    project.save_text("draft.md", draft, subdir="manuscript")
    project.save_json(
        "methodology_context.json",
        {"references": [{"citation": "[2]", "title": "The PRISMA 2020 statement", "source_type": "reporting_guideline"}]},
        subdir="search",
    )
    issue = _load_manuscript_quality_payload(project, {})["actionable_issues"][0]

    result = _preview_manuscript_citation_patch_payload(
        {
            "project_dir": str(project.base_dir),
            "issue_id": issue["id"],
            "citation": "[2]",
        }
    )

    assert result["ok"] is True
    assert result["applied"] is False
    assert "criteria." in result["before"]
    assert "criteria [2]." in result["after"]
    assert "+We searched PubMed and screened records according to predefined eligibility criteria [2]." in result["diff"]
    assert project.load_text("draft.md", subdir="manuscript") == draft


def test_apply_manuscript_citation_patch_updates_draft_and_quality_audit(tmp_path) -> None:
    from start import META_ROOT, _apply_manuscript_citation_patch_payload, _load_manuscript_quality_payload

    project = Project(
        "web citation patch apply",
        output_dir=META_ROOT / "output" / "pytest_citation_patch_apply" / uuid4().hex,
    )
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Background statement [1].\n\n"
            "## Methods\n\n"
            "We searched PubMed and screened records according to predefined eligibility criteria.\n\n"
            "## Results\n\n"
            "The pooled OR was 0.66 [1].\n\n"
            "## Discussion\n\n"
            f"{_web_clinical_discussion_text(citation='[1]', effect='OR 0.66', endpoint='mortality')}\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] The PRISMA 2020 statement.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "methodology_context.json",
        {"references": [{"citation": "[2]", "title": "The PRISMA 2020 statement", "source_type": "reporting_guideline"}]},
        subdir="search",
    )
    issue = _load_manuscript_quality_payload(project, {})["actionable_issues"][0]

    result = _apply_manuscript_citation_patch_payload(
        {
            "project_dir": str(project.base_dir),
            "issue_id": issue["id"],
            "citation": "[2]",
            "expected_revision": 0,
        },
        user_id="tester",
    )

    draft = project.load_text("draft.md", subdir="manuscript")
    log = project.load_json("manuscript_citation_fixes.json", subdir="manuscript")

    assert result["ok"] is True
    assert result["applied"] is True
    assert "criteria [2]." in draft
    assert result["current_revision"] == 1
    assert result["manuscript_quality"]["citation_audit"]["passed"] is True
    assert result["manuscript_quality"]["action_required"] is False
    assert result["quality_delta"]["quality_status_before"] == "blocked"
    assert result["quality_delta"]["quality_status_after"] == "ready"
    assert result["quality_delta"]["citation_failed_issues_before"] == 1
    assert result["quality_delta"]["citation_failed_issues_after"] == 0
    assert issue["id"] in result["quality_delta"]["resolved_issue_ids"]
    assert log["current_revision"] == 1
    assert log["entries"][0]["issue_id"] == issue["id"]
    assert log["entries"][0]["citation"] == "[2]"
    assert log["entries"][0]["quality_delta"]["quality_status_before"] == "blocked"
    assert log["entries"][0]["quality_delta"]["quality_status_after"] == "ready"
    assert issue["id"] in log["entries"][0]["quality_delta"]["resolved_issue_ids"]


def test_apply_discussion_context_citation_patch_clears_discussion_warning(tmp_path) -> None:
    from start import META_ROOT, _apply_manuscript_citation_patch_payload, _load_manuscript_quality_payload

    project = Project(
        "web discussion citation patch apply",
        output_dir=META_ROOT / "output" / "pytest_discussion_citation_patch_apply" / uuid4().hex,
    )
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Background statement [4].\n\n"
            "## Methods\n\n"
            "We searched PubMed and screened records according to predefined eligibility criteria [2].\n\n"
            "## Results\n\n"
            "The pooled OR was 0.66 [1].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted against existing guidance and certainty concerns [1].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] The PRISMA 2020 statement.\n\n"
            "[3] GRADE guidance.\n\n"
            "[4] Heart failure guideline.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "methodology_context.json",
        {"references": [{"citation": "[3]", "title": "GRADE guidance", "source_type": "certainty_framework"}]},
        subdir="search",
    )
    project.save_json(
        "evidence_context.json",
        {"references": [{"citation": "[4]", "title": "Heart failure guideline", "source_type": "guideline"}]},
        subdir="search",
    )
    issue = next(
        item for item in _load_manuscript_quality_payload(project, {})["actionable_issues"]
        if item["code"] == "discussion_context_citations_missing"
    )

    result = _apply_manuscript_citation_patch_payload(
        {
            "project_dir": str(project.base_dir),
            "issue_id": issue["id"],
            "expected_revision": 0,
        },
        user_id="tester",
    )
    draft = project.load_text("draft.md", subdir="manuscript")

    assert result["ok"] is True
    assert result["applied"] is True
    assert result["target_section"] == "Discussion"
    assert result["citation"] == "[4]"
    assert "certainty concerns [1] [4]." in draft
    assert result["manuscript_quality"]["citation_audit"]["summary"]["discussion_context_inline_citations"] == 1
    assert all(
        item["code"] != "discussion_context_citations_missing"
        for item in result["manuscript_quality"]["actionable_issues"]
    )


def test_preview_intro_background_citation_patch_targets_uncited_sentence_not_paragraph_end(tmp_path) -> None:
    from start import META_ROOT, _preview_manuscript_citation_patch_payload, _load_manuscript_quality_payload

    project = Project(
        "web intro sentence citation patch preview",
        output_dir=META_ROOT / "output" / "pytest_intro_sentence_citation_patch_preview" / uuid4().hex,
    )
    project.save_text(
        "draft.md",
        (
            "# Title\n\n"
            "## Introduction\n\n"
            "Heart failure imposes substantial morbidity and mortality worldwide. "
            "Current guidelines recommend SGLT2 inhibitors for selected patients [2].\n\n"
            "## Methods\n\n"
            "We followed predefined methods [1].\n\n"
            "## Results\n\n"
            "Two trial reports contributed data [1].\n\n"
            "## Discussion\n\n"
            "The findings were interpreted alongside prior evidence [3].\n\n"
            "## References\n\n"
            "[1] Trial report.\n\n"
            "[2] Heart failure clinical guideline.\n\n"
            "[3] Prior systematic review.\n\n"
            "[4] Epidemiology background source.\n"
        ),
        subdir="manuscript",
    )
    project.save_json(
        "evidence_context.json",
        {
            "references": [
                {"citation": "[2]", "title": "Heart failure clinical guideline", "source_type": "clinical_guideline"},
                {"citation": "[3]", "title": "Prior systematic review", "source_type": "prior_review"},
                {"citation": "[4]", "title": "Epidemiology background source", "source_type": "pubmed_background"},
            ]
        },
        subdir="search",
    )
    issue = next(
        item for item in _load_manuscript_quality_payload(project, {})["actionable_issues"]
        if item["code"] == "uncited_introduction_background_claim"
    )

    result = _preview_manuscript_citation_patch_payload(
        {
            "project_dir": str(project.base_dir),
            "issue_id": issue["id"],
            "citation": "[4]",
        }
    )

    assert result["ok"] is True
    assert result["after"] == "Heart failure imposes substantial morbidity and mortality worldwide [4]."
    assert "worldwide [4]. Current guidelines" in result["updated_text"]
    assert "patients [2] [4]." not in result["updated_text"]
    assert project.load_text("draft.md", subdir="manuscript").count("[4]") == 1


def test_report_completion_summary_surfaces_manuscript_quality_gate() -> None:
    from start import META_STEP_SUMMARY

    summary = META_STEP_SUMMARY[9]({
        "n_reference_entries": 24,
        "citation_audit_passed": True,
        "n_citation_audit_failed_issues": 0,
        "polish_enabled": True,
        "n_polish_rejected_sections": 1,
        "n_polish_rejected_chunks": 2,
    })

    assert "参考文献：24 条" in summary
    assert "引用覆盖：通过" in summary
    assert "润色保护：已启用" in summary
    assert "拒绝 1 个章节 / 2 个段落块" in summary
