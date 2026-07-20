from new_meta.agents.rob_agent import RoBAgent, RoBQuoteRepairPlan
from new_meta.agents.writing_agent import WritingAgent
from new_meta.core.artifact_package import (
    _PRISMA_AUDIT_FIELDS,
    _claim_support_grade_certainty_claim,
    _clinical_interpretation_domain_rows,
    _extract_prisma_reported_values,
)
from new_meta.core.manuscript_facts import _repair_overlong_interpretive_sentences
from new_meta.schemas.risk_of_bias import RoBDomain, StudyRoB


def test_result_rob_retry_supplies_only_verified_domain_quote_candidates() -> None:
    full_text = """
For patients who were discharged or
unrelated right-column text appears here and continues across the page with enough intervening material to exceed
the conservative quote-verification gap while preserving the visibly interleaved two-column parse output and adding
many unrelated tokens about anesthesia surgery monitoring recovery medication laboratory values hospital workflow
staffing documentation equipment positioning ventilation hemodynamics temperature fluids transfusion and discharge
died within 5 days, the last delirium assessment results
were used to replace the missing data when calculating
incidence within 5 days; missing data were not replaced
A total of 710 patients who were randomized and underwent surgeries were included in the intention-to-treat analysis.
Trial registration: www. chictr. org. cn: ChiCTR1800017182 (Date of registration: July 17, 2018)
The primary outcome was the incidence of delirium within 5 days after surgery.
"""
    assessment = StudyRoB(
        study_id="S1",
        tool_used="RoB 2",
        domains=[
            RoBDomain(
                domain="Domain 3: Risk of bias due to missing outcome data",
                judgment="Low risk",
                support="Nearly all randomized participants were analyzed.",
                source_quote=(
                    "For patients who left hospital or died within 5 days, the last delirium assessment results "
                    "were used to replace the missing data when calculating incidence within 5 days... "
                    "A total of 710 patients who were randomized and underwent surgeries were included in the "
                    "intention-to-treat analysis."
                ),
            ),
            RoBDomain(
                domain="Domain 5: Risk of bias in selection of the reported result",
                judgment="Low risk",
                support="The trial was registered and identified a primary outcome.",
                source_quote="The trial was registered before enrolment and reported its prespecified outcome.",
            ),
        ],
        overall_judgment="Low risk",
    )

    feedback = RoBAgent._rob_grounding_feedback(assessment, full_text)

    assert "FAILED DOMAIN: Domain 3" in feedback
    assert "FAILED DOMAIN: Domain 5" in feedback
    assert "A total of 710 patients" in feedback
    assert "Trial registration:" in feedback
    for domain in assessment.domains:
        candidates = RoBAgent._verified_quote_candidates(full_text, domain)
        assert candidates
        assert all(RoBAgent._quote_occurs(item, full_text) for item in candidates)


def test_result_rob_quote_repair_selects_without_rewriting_verified_excerpt() -> None:
    full_text = (
        "A total of 710 patients who were randomized and underwent surgeries were included in the "
        "intention-to-treat analysis.\n"
        "Trial registration: www.chictr.org.cn ChiCTR1800017182 before enrolment."
    )
    assessment = StudyRoB(
        study_id="S1",
        tool_used="RoB 2",
        domains=[
            RoBDomain(
                domain="Domain 3: Risk of bias due to missing outcome data",
                judgment="Low risk",
                support="Nearly all participants were analyzed.",
                source_quote="A paraphrase that is not in the report.",
            ),
            RoBDomain(
                domain="Domain 5: Risk of bias in selection of the reported result",
                judgment="Low risk",
                support="The trial was registered.",
                source_quote="Another unsupported paraphrase.",
            ),
        ],
        overall_judgment="Low risk",
    )
    agent = object.__new__(RoBAgent)
    domain_3_candidates = agent._verified_quote_candidates(full_text, assessment.domains[0])
    domain_5_candidates = agent._verified_quote_candidates(full_text, assessment.domains[1])
    domain_3_index = next(
        index for index, item in enumerate(domain_3_candidates, start=1)
        if item.startswith("A total of 710 patients")
    )
    domain_5_index = next(
        index for index, item in enumerate(domain_5_candidates, start=1)
        if item.startswith("Trial registration:")
    )
    agent.call_llm_structured = lambda *args, **kwargs: RoBQuoteRepairPlan.model_validate({
        "selections": [
            {"domain": assessment.domains[0].domain, "candidate_index": domain_3_index},
            {"domain": assessment.domains[1].domain, "candidate_index": domain_5_index},
        ],
    })

    repaired = agent._repair_rob_quotes_from_verified_candidates(assessment, full_text)

    assert repaired is not None
    assert all(RoBAgent._quote_occurs(domain.source_quote or "", full_text) for domain in repaired.domains)
    assert repaired.domains[0].source_quote.startswith("A total of 710 patients")
    assert repaired.domains[1].source_quote.startswith("Trial registration:")


def test_prisma_audit_recognizes_number_before_included_and_number_words() -> None:
    patterns = next(
        item["patterns"]
        for item in _PRISMA_AUDIT_FIELDS
        if item["field"] == "studies_included"
    )
    text = (
        "Ten studies were identified as eligible or contextual evidence. "
        "Four studies provided data for the primary meta-analysis. "
        "Figure 1 shows 10 studies included and 4 studies in the quantitative synthesis."
    )

    values = _extract_prisma_reported_values(text, patterns)

    assert 10 in values


def test_prisma_after_dedup_does_not_confuse_remaining_context_records() -> None:
    patterns = next(
        item["patterns"]
        for item in _PRISMA_AUDIT_FIELDS
        if item["field"] == "records_after_dedup"
    )
    text = (
        "After cross-source deduplication, 200 unique records remained for screening. "
        "The remaining 6 records supplied contextual evidence."
    )

    assert _extract_prisma_reported_values(text, patterns) == [200]


def test_discussion_depth_is_hard_guarded_when_claim_map_can_support_it() -> None:
    writer = object.__new__(WritingAgent)
    writer._lang = "en"
    facts = {
        "primary_effect": {"estimate": 0.8},
        "claim_map": [
            {
                "id": f"disc-{index}",
                "section": "Discussion",
                "can_write_main_text": True,
                "manuscript_use": "main",
            }
            for index in range(5)
        ],
    }
    shallow = "One short result paragraph.\n\nOne short limitation paragraph."
    developed = "\n\n".join(
        " ".join([f"supported{index}"] * 90)
        for index in range(5)
    )

    issues = writer._publication_section_depth_issues("Discussion", shallow, facts)

    assert issues and issues[0]["code"] == "discussion_underdeveloped"
    assert writer._publication_section_depth_issues("Discussion", developed, facts) == []


def test_absolute_effect_claim_uses_two_sided_null_crossing_translation() -> None:
    writer = object.__new__(WritingAgent)
    writer._lang = "en"
    claims = [{
        "id": "disc-clinical-significance",
        "section": "Discussion",
        "argument_step": "clinical_significance",
        "claim": "The NNT was 41 (95% CI 20 to 20).",
    }]
    facts = {
        "absolute_effects": {
            "scenarios": [{
                "assumed_control_risk_per_1000": 120,
                "intervention_risk_per_1000": 96,
                "events_avoided_per_1000": 24,
                "events_avoided_ci_low_per_1000": 0,
                "events_avoided_ci_high_per_1000": 51,
                "events_increased_ci_low_per_1000": 0,
                "events_increased_ci_high_per_1000": 12,
                "absolute_ci_crosses_null": True,
                "nnt": 41,
                "nnt_type": "NNTB",
            }],
        },
    }

    normalized, rewritten = writer._normalize_absolute_effect_claims(claims, facts)

    assert rewritten == 1
    assert "51 fewer to 12 more" in normalized[0]["claim"]
    assert "finite NNT interval is not defined" in normalized[0]["claim"]
    assert "20 to 20" not in normalized[0]["claim"]


def test_clinical_interpretation_audit_is_outcome_agnostic() -> None:
    rows = _clinical_interpretation_domain_rows(
        (
            "Outcome assessment tools and the delirium assessment time window differed across trials. "
            "Applicability to patients with frailty and cognitive impairment remains uncertain."
        ),
        language="en",
    )
    covered = {row["domain"] for row in rows if row["covered"]}

    assert "endpoint_meaning" in covered
    assert "applicability_subgroups" in covered


def test_grade_domain_rating_is_not_misclassified_as_overall_certainty() -> None:
    grade = {"outcomes": [{"certainty": "very low"}]}
    domain_sentence = (
        "Two studies were rated low risk and two had some concerns, leading to a serious rating in the GRADE domain."
    )
    certainty_sentence = "The GRADE certainty of evidence was very low."

    assert _claim_support_grade_certainty_claim(domain_sentence, grade) is None
    assert _claim_support_grade_certainty_claim(certainty_sentence, grade)["status"] == "supported"


def test_relative_and_absolute_effect_bridge_is_split_for_readability() -> None:
    manuscript = (
        "The pooled risk ratio was 0.80 (95% CI 0.58 to 1.10), corresponding to 24 fewer events per 1000 "
        "(95% CI 51 fewer to 12 more)."
    )

    repaired, issues = _repair_overlong_interpretive_sentences(manuscript)

    assert ". This corresponds to 24 fewer" in repaired
    assert issues and issues[0]["kind"] == "overlong_interpretive_sentence_split"


def test_chinese_publication_paragraphs_are_split_without_inter_sentence_spaces() -> None:
    manuscript = "".join(f"第{index}句报告临床结果。" for index in range(1, 9))

    repaired = WritingAgent._enforce_publication_paragraph_rhythm(manuscript)

    paragraphs = repaired.split("\n\n")
    assert len(paragraphs) == 2
    assert paragraphs[0].count("。") == 6
    assert paragraphs[1].count("。") == 2
