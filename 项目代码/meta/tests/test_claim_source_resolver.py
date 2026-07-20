from new_meta.core.claim_source_resolver import resolve_claim_sources


def test_claim_source_resolver_excludes_unsupported_claims() -> None:
    facts = {
        "primary_effect": {"effect": 0.8},
        "background_evidence": {
            "references": [
                {"id": "guideline1", "title": "Heart failure guideline"}
            ]
        },
        "study_cards": [
            {"study_id": "S1", "title": "Trial one"}
        ],
    }
    claim_map = [
        {"id": "primary", "claim": "Treatment reduced events.", "support_source": "analysis.meta_results.primary_outcome"},
        {"id": "background", "claim": "Guidelines discuss the condition.", "support_source": "guideline1"},
        {"id": "unsupported", "claim": "A new mechanism is proven.", "support_source": "not in supplied evidence"},
    ]

    resolved = resolve_claim_sources(claim_map, facts)

    assert resolved["summary"]["resolved_count"] == 2
    assert resolved["summary"]["unresolved_count"] == 1
    unsupported = resolved["claim_map"][2]
    assert unsupported["can_write_main_text"] is False
    assert unsupported["manuscript_use"] == "exclude"


def test_claim_source_resolver_requires_resolvable_source_for_quotes() -> None:
    facts = {
        "pico": {"population": "Adults with HFpEF"},
        "research_question": "SGLT2 inhibitors in HFpEF",
    }
    claim_map = [
        {
            "id": "quote_only",
            "claim": "A plausible quote-backed claim.",
            "source_quote": "A quote exists, but no source identity is supplied.",
        },
        {
            "id": "pico_claim",
            "claim": "This review evaluates adults with HFpEF.",
            "support_source": "pico_definition",
            "source_location": "Protocol PICO",
        },
    ]

    resolved = resolve_claim_sources(claim_map, facts)

    assert resolved["summary"]["resolved_count"] == 1
    assert resolved["summary"]["unresolved_count"] == 1
    assert resolved["claim_map"][0]["source_resolution"]["reason"] == "source_quote_without_resolvable_source"
    assert resolved["claim_map"][0]["manuscript_use"] == "exclude"
    assert resolved["claim_map"][1]["source_resolution"]["resolved"] is True
    assert resolved["claim_map"][1]["source_spans"][0]["source_type"] == "structured_fact"
    assert resolved["claim_map"][1]["source_spans"][0]["support_strength"] == "structured"


def test_claim_source_resolver_treats_endpoint_definition_as_structured_fact() -> None:
    facts = {
        "pico": {"outcome": "Cardiovascular death or worsening heart failure"},
        "primary_effect": {"outcome_name": "Composite endpoint", "n_studies": 2},
        "domain_controversy_candidates": [
            {
                "kind": "endpoint_interpretation",
                "candidate_claim": "Composite endpoint components require interpretation.",
            }
        ],
    }
    claim_map = [
        {
            "id": "endpoint",
            "claim": "The endpoint should be interpreted as worsening heart failure rather than hospitalization only.",
            "support_source": "endpoint_definition_caveat and endpoint_definition_discussion",
            "source_quote": "Composite endpoint components require interpretation.",
        }
    ]

    resolved = resolve_claim_sources(claim_map, facts)

    assert resolved["summary"]["resolved_count"] == 1
    assert resolved["summary"]["unresolved_count"] == 0
    assert resolved["claim_map"][0]["source_spans"][0]["source_type"] == "structured_fact"
    assert resolved["claim_map"][0]["source_spans"][0]["support_strength"] == "structured"


def test_claim_source_resolver_rejects_quote_not_found_in_structured_fact() -> None:
    facts = {
        "primary_effect": {
            "effect_measure": "HR",
            "pooled_effect": 0.81,
            "ci_lower": 0.74,
            "ci_upper": 0.89,
            "n_studies": 2,
            "total_n": 12251,
        },
        "grade": {
            "certainty": "Moderate",
            "domains": [
                {
                    "domain": "publication_bias",
                    "judgment": "downgraded",
                    "reason": "Only 2 studies contributed to the primary meta-analysis.",
                }
            ],
        },
    }
    claim_map = [
        {
            "id": "good_primary",
            "claim": "The pooled primary estimate favored treatment.",
            "support_source": "primary_effect",
            "source_quote": "Pooled HR 0.81 with 95% CI 0.74 to 0.89.",
        },
        {
            "id": "bad_primary",
            "claim": "The pooled primary estimate showed no important difference.",
            "support_source": "primary_effect",
            "source_quote": "Pooled HR 1.25 with 95% CI 1.02 to 1.48.",
        },
        {
            "id": "good_grade",
            "claim": "GRADE certainty was downgraded for publication-bias uncertainty.",
            "support_source": "grade",
            "source_quote": "Only 2 studies contributed to the primary meta-analysis.",
        },
        {
            "id": "mixed_source_primary",
            "claim": "The conclusion combines PICO, GRADE, and primary effect facts.",
            "support_source": "primary_effect + grade + pico",
            "source_quote": "HR 0.81 (95% CI 0.74 to 0.89)",
        },
    ]

    resolved = resolve_claim_sources(claim_map, facts)

    assert resolved["summary"]["resolved_count"] == 3
    assert resolved["summary"]["unresolved_count"] == 1
    assert resolved["claim_map"][0]["source_resolution"]["resolved"] is True
    assert resolved["claim_map"][1]["manuscript_use"] == "exclude"
    assert resolved["claim_map"][1]["source_resolution"]["reason"] == "source_quote_not_found_in_structured_fact"
    assert resolved["claim_map"][2]["source_resolution"]["resolved"] is True
    assert resolved["claim_map"][3]["source_spans"][0]["source_id"] == "primaryeffect"


def test_claim_source_resolver_excludes_claims_that_negate_available_analysis_outputs() -> None:
    facts = {
        "primary_effect": {"pooled_effect": 0.81, "n_studies": 2},
        "absolute_effects": {
            "scenarios": [
                {
                    "assumed_control_risk_per_1000": 183,
                    "intervention_risk_per_1000": 151,
                    "events_avoided_per_1000": 33,
                    "nnt": 31,
                }
            ]
        },
    }
    claim_map = [
        {
            "id": "bad_absolute",
            "claim": "由于未提供绝对风险降低值或需治数，本综述仅能报告相对效应指标。",
            "support_source": "primary_effect",
            "source_quote": "Pooled HR 0.81.",
        },
        {
            "id": "bad_synthesis",
            "claim": "各研究结果仅能独立解读，无法进行跨研究比较或归纳。",
            "support_source": "primary_effect",
            "source_quote": "Two studies contributed to the pooled estimate.",
        },
        {
            "id": "good_absolute",
            "claim": "绝对效应换算显示每1000人约减少33例事件，需治数约31。",
            "support_source": "absolute_effects",
        },
    ]

    resolved = resolve_claim_sources(claim_map, facts)

    assert resolved["summary"]["resolved_count"] == 1
    assert resolved["summary"]["unresolved_count"] == 2
    assert resolved["claim_map"][0]["manuscript_use"] == "exclude"
    assert resolved["claim_map"][0]["source_resolution"]["reason"] == "claim_contradicts_available_absolute_effects"
    assert resolved["claim_map"][1]["manuscript_use"] == "exclude"
    assert resolved["claim_map"][1]["source_resolution"]["reason"] == "claim_contradicts_available_primary_synthesis"
    assert resolved["claim_map"][2]["source_resolution"]["resolved"] is True


def test_claim_source_resolver_excludes_claims_that_negate_available_safety_notes() -> None:
    facts = {
        "study_cards": [
            {
                "study_id": "Trial A",
                "safety_notes": [
                    "Serious adverse events occurred in 43.5% of the intervention group vs 45.5% of placebo.",
                ],
            }
        ],
    }
    claim_map = [
        {
            "id": "bad_safety",
            "section": "Discussion",
            "claim": "Structured safety notes were not provided for meta-analysis.",
            "support_source": "study_cards",
            "source_quote": "No safety_notes provided for quantitative pooling",
        },
        {
            "id": "good_safety",
            "section": "Discussion",
            "claim": "Safety outcomes were not quantitatively pooled in this meta-analysis. Safety notes were available from the included studies and summarized narratively.",
            "support_source": "study_cards",
            "source_quote": "Serious adverse events occurred in 43.5% vs 45.5%.",
        },
    ]

    resolved = resolve_claim_sources(claim_map, facts)

    assert resolved["summary"]["resolved_count"] == 1
    assert resolved["summary"]["unresolved_count"] == 1
    assert resolved["claim_map"][0]["manuscript_use"] == "exclude"
    assert resolved["claim_map"][0]["source_resolution"]["reason"] == "claim_contradicts_available_safety_notes"
    assert resolved["claim_map"][1]["source_resolution"]["resolved"] is True


def test_claim_source_resolver_rejects_quote_not_found_in_resolved_study_card() -> None:
    facts = {
        "study_cards": [
            {
                "study_id": "RECOVERY",
                "title": "Dexamethasone in hospitalized patients with Covid-19",
                "source_backed_claims": [
                    {
                        "claim": "Mortality data were reported for the dexamethasone comparison.",
                        "source_quote": "Deaths occurred in 95 of 324 patients assigned to dexamethasone and 283 of 683 assigned to usual care.",
                        "source_location": "Results",
                    }
                ],
            }
        ],
    }
    claim_map = [
        {
            "id": "good",
            "claim": "RECOVERY reported mortality data for dexamethasone.",
            "source_study_id": "RECOVERY",
            "support_source": "RECOVERY",
            "source_quote": "Deaths occurred in 95 of 324 patients assigned to dexamethasone and 283 of 683 assigned to usual care.",
        },
        {
            "id": "bad",
            "claim": "RECOVERY reported a dapagliflozin hazard ratio.",
            "source_study_id": "RECOVERY",
            "support_source": "RECOVERY",
            "source_quote": "The hazard ratio for dapagliflozin was 0.82.",
        },
    ]

    resolved = resolve_claim_sources(claim_map, facts)

    assert resolved["summary"]["resolved_count"] == 1
    assert resolved["summary"]["unresolved_count"] == 1
    assert resolved["claim_map"][0]["source_resolution"]["resolved"] is True
    assert resolved["claim_map"][1]["manuscript_use"] == "exclude"
    assert resolved["claim_map"][1]["source_resolution"]["reason"] == "source_quote_not_found_in_resolved_source"


def test_claim_source_resolver_rejects_quote_not_found_in_background_reference() -> None:
    facts = {
        "background_evidence": {
            "references": [
                {
                    "id": "guideline2026",
                    "title": "Heart failure guideline",
                    "abstract": "Guidelines recommend considering baseline risk, renal function, and patient preferences.",
                }
            ]
        }
    }
    claim_map = [
        {
            "id": "background_good",
            "claim": "Guidelines emphasize baseline risk and patient preferences.",
            "reference_id": "guideline2026",
            "support_source": "guideline2026",
            "source_quote": "Guidelines recommend considering baseline risk, renal function, and patient preferences.",
        },
        {
            "id": "background_bad",
            "claim": "The guideline reports a pooled odds ratio.",
            "reference_id": "guideline2026",
            "support_source": "guideline2026",
            "source_quote": "The pooled odds ratio was 0.66.",
        },
    ]

    resolved = resolve_claim_sources(claim_map, facts)

    assert resolved["summary"]["resolved_count"] == 1
    assert resolved["summary"]["unresolved_count"] == 1
    assert resolved["claim_map"][1]["source_resolution"]["reason"] == "source_quote_not_found_in_resolved_source"


def test_claim_source_resolver_keeps_translated_background_quote_as_indirect_support() -> None:
    facts = {
        "background_evidence": {
            "references": [
                {
                    "id": "guideline2026",
                    "title": "Heart failure guideline",
                    "abstract": "Guidelines recommend considering baseline risk, renal function, and patient preferences.",
                }
            ]
        }
    }
    claim_map = [
        {
            "id": "translated_background",
            "claim": "指南强调解释治疗获益时应结合基线风险和患者偏好。",
            "reference_id": "guideline2026",
            "support_source": "guideline2026",
            "source_quote": "指南建议结合基线风险、肾功能和患者偏好解释治疗获益。",
        },
    ]

    resolved = resolve_claim_sources(claim_map, facts)

    assert resolved["summary"]["resolved_count"] == 1
    span = resolved["claim_map"][0]["source_spans"][0]
    assert span["source_type"] == "background_reference"
    assert span["support_strength"] == "indirect"
    assert span["verified"] is False
