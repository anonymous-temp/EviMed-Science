from new_meta.agents.grade_agent import GRADEAgent
from new_meta.schemas.meta_result import PooledEffect, PublicationBiasResult, StudyEffect
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.risk_of_bias import StudyRoB
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def test_synthetic_rob_forces_grade_risk_of_bias_concern() -> None:
    agent = GRADEAgent()

    domain = agent._assess_risk_of_bias(
        [
            StudyRoB(
                study_id="S1",
                tool_used="RoB 2",
                overall_judgment="Not assessed (insufficient information)",
                is_synthetic=True,
            ),
            StudyRoB(
                study_id="S2",
                tool_used="RoB 2",
                overall_judgment="Not assessed (insufficient information)",
                is_synthetic=True,
            ),
        ],
        {"S1", "S2"},
    )

    assert domain.rating == "very serious"
    assert "not formally assessed" in domain.rationale.lower()
    assert domain.details["n_not_formally_assessed"] == 2
    assert "synthetic rob" not in domain.rationale.lower()
    assert "must not be treated" not in domain.rationale.lower()


def test_legacy_not_assessed_rob_is_treated_as_synthetic() -> None:
    agent = GRADEAgent()

    domain = agent._assess_risk_of_bias(
        [
            StudyRoB(
                study_id="S1",
                tool_used="RoB 2",
                overall_judgment="Not assessed (insufficient information)",
            )
        ],
        {"S1"},
    )

    assert domain.rating == "very serious"


def test_grade_indirectness_uses_rule_based_population_mismatch(monkeypatch) -> None:
    agent = GRADEAgent()
    monkeypatch.setattr(agent, "call_llm", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("no llm")))
    protocol = ResearchProtocol(
        research_question="Corticosteroids for mortality in critically ill COVID-19 patients",
        pico=PICO(
            population="critically ill ICU COVID-19 patients receiving invasive mechanical ventilation",
            intervention="corticosteroids",
            comparator="usual care",
            outcome_primary="28-day mortality",
        ),
        effect_measure="RR",
    )
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="S1",
            population_description="severe non-intubated pulmonary-phase COVID-19 patients in a ward",
            intervention_description="corticosteroids",
            control_description="usual care",
            study_design="randomized trial",
        ),
        outcomes=[OutcomeData(outcome_name="28-day mortality")],
    )

    domain = agent._assess_indirectness([study], protocol, {"S1"}, "28-day mortality")

    assert domain.rating == "very serious"
    assert "population mismatch" in domain.rationale


def test_grade_indirectness_flags_surrogate_outcome(monkeypatch) -> None:
    agent = GRADEAgent()
    monkeypatch.setattr(agent, "call_llm", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("no llm")))
    protocol = ResearchProtocol(
        research_question="Drug for mortality in adults",
        pico=PICO(
            population="adults with heart failure",
            intervention="drug",
            comparator="placebo",
            outcome_primary="mortality",
        ),
        effect_measure="RR",
    )
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="S1",
            population_description="adults with heart failure",
            intervention_description="drug",
            control_description="placebo",
            study_design="RCT",
        ),
        outcomes=[OutcomeData(outcome_name="biomarker score")],
    )

    domain = agent._assess_indirectness([study], protocol, {"S1"}, "biomarker score")

    assert domain.rating == "serious"
    assert "surrogate" in domain.rationale


def test_grade_indirectness_exposes_rule_based_dimension_counts(monkeypatch) -> None:
    agent = GRADEAgent()
    monkeypatch.setattr(agent, "call_llm", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("no llm")))
    protocol = ResearchProtocol(
        research_question="Corticosteroids for mortality in critically ill COVID-19 patients",
        pico=PICO(
            population="critically ill ICU COVID-19 patients receiving invasive mechanical ventilation",
            intervention="corticosteroids",
            comparator="usual care",
            outcome_primary="28-day mortality",
        ),
        effect_measure="RR",
    )
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="S1",
                population_description="critically ill ICU COVID-19 patients receiving invasive mechanical ventilation",
                intervention_description="corticosteroids",
                control_description="usual care",
                study_design="randomized controlled trial",
            ),
            outcomes=[OutcomeData(outcome_name="28-day mortality")],
        ),
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="S2",
                population_description="severe non-intubated COVID-19 ward patients",
                intervention_description="corticosteroids",
                control_description="active antiviral therapy",
                study_design="prospective cohort study",
            ),
            outcomes=[OutcomeData(outcome_name="biomarker score")],
        ),
    ]

    domain = agent._assess_indirectness(studies, protocol, {"S1", "S2"}, "28-day mortality")

    assert domain.details["method"] == "rule_based_pico_directness_v1"
    assert domain.details["n_contributing"] == 2
    assert domain.details["dimensions"]["population"]["mismatch"] == 1
    assert domain.details["dimensions"]["comparator"]["mismatch"] == 1
    assert domain.details["dimensions"]["outcome"]["mismatch"] == 1
    assert domain.details["dimensions"]["design"]["non_randomized"] == 1


def test_grade_indirectness_treats_missing_pico_as_unverified_not_mismatch(monkeypatch) -> None:
    agent = GRADEAgent()
    monkeypatch.setattr(
        agent,
        "call_llm",
        lambda *args, **kwargs: '{"rating":"very serious","rationale":"Missing fields prevent direct assessment."}',
    )
    protocol = ResearchProtocol(
        research_question="SGLT2 inhibitors for HFpEF",
        pico=PICO(
            population="adults with heart failure with preserved ejection fraction",
            intervention="SGLT2 inhibitors",
            comparator="placebo",
            outcome_primary="cardiovascular death or hospitalization for heart failure",
        ),
        effect_measure="HR",
    )
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(study_id="S1"),
            outcomes=[OutcomeData(outcome_name="cardiovascular death or hospitalization for heart failure")],
        ),
        ExtractedStudy(
            characteristics=StudyCharacteristics(study_id="S2"),
            outcomes=[OutcomeData(outcome_name="cardiovascular death or hospitalization for heart failure")],
        ),
    ]

    domain = agent._assess_indirectness(
        studies,
        protocol,
        {"S1", "S2"},
        "cardiovascular death or hospitalization for heart failure",
    )

    assert domain.rating == "serious"
    assert "unverified" in domain.rationale
    assert "population mismatch" not in domain.rationale
    assert "non-randomized" not in domain.rationale
    assert domain.details["dimensions"]["population"]["unverified"] == 2
    assert domain.details["dimensions"]["intervention"]["unverified"] == 2
    assert domain.details["dimensions"]["comparator"]["unverified"] == 2
    assert "Missing fields prevent direct assessment" not in domain.rationale


def test_grade_indirectness_does_not_downgrade_verified_direct_rows_for_empty_characteristics(monkeypatch) -> None:
    agent = GRADEAgent()
    monkeypatch.setattr(agent, "call_llm", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("no llm")))
    protocol = ResearchProtocol(
        research_question="SGLT2 inhibitors for HFpEF",
        pico=PICO(
            population="adults with heart failure with preserved ejection fraction",
            intervention="SGLT2 inhibitors",
            comparator="placebo",
            outcome_primary="cardiovascular death or hospitalization for heart failure",
        ),
        effect_measure="HR",
    )
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="S1",
                title="Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="Composite of cardiovascular death or first hospitalization for heart failure",
                    source_quote="primary outcome event occurred in the empagliflozin group and placebo group",
                    source_quote_verified=True,
                )
            ],
        ),
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="S2",
                title="Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction",
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="Composite of cardiovascular death or first hospitalization for heart failure",
                    source_quote="primary outcome occurred in the dapagliflozin group and placebo group",
                    source_quote_verified=True,
                )
            ],
        ),
    ]

    domain = agent._assess_indirectness(
        studies,
        protocol,
        {"S1", "S2"},
        "Composite of cardiovascular death or first hospitalization for heart failure",
    )

    assert domain.rating == "no concern"
    assert "source-verified primary outcome rows" in domain.rationale.lower()
    assert "population mismatch" not in domain.rationale


def test_grade_indirectness_does_not_contradict_verified_primary_row_adjudication(monkeypatch) -> None:
    agent = GRADEAgent()
    monkeypatch.setattr(agent, "call_llm", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("no llm")))
    protocol = ResearchProtocol(
        research_question="Corticosteroids for mortality in critically ill COVID-19 patients",
        pico=PICO(
            population="critically ill adults with COVID-19 requiring ICU or mechanical ventilation",
            intervention="systemic corticosteroids",
            comparator="usual care",
            outcome_primary="28-day all-cause mortality",
        ),
        effect_measure="OR",
    )
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="S1",
                population_description="critically ill adults with COVID-19 receiving invasive mechanical ventilation",
                intervention_description="systemic corticosteroids",
                control_description="usual care",
                study_design="randomized controlled trial",
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="28-day all-cause mortality",
                    source_quote="deaths/total were reported for the critical-care subgroup",
                    source_quote_verified=True,
                    manual_adjudication=True,
                )
            ],
        ),
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="S2",
                population_description="hospitalized adults with COVID-19",
                intervention_description="systemic corticosteroids",
                control_description="usual care",
                study_design="randomized controlled trial",
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="28-day all-cause mortality",
                    source_quote="deaths/total were reported for the critical-care subgroup",
                    source_quote_verified=True,
                    manual_adjudication=True,
                )
            ],
        ),
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="S3",
                population_description="critically ill ICU adults with COVID-19",
                intervention_description="systemic corticosteroids",
                control_description="usual care",
                study_design="randomized controlled trial",
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="28-day all-cause mortality",
                    source_quote="deaths/total were reported for the critical-care subgroup",
                    source_quote_verified=True,
                    manual_adjudication=True,
                )
            ],
        ),
    ]

    domain = agent._assess_indirectness(studies, protocol, {"S1", "S2", "S3"}, "28-day all-cause mortality")

    assert domain.rating == "no concern"
    assert "population mismatch" not in domain.rationale
    assert "no indirectness downgrade" in domain.rationale


def test_grade_indirectness_deduplicates_extracted_records_by_contributing_study_id(monkeypatch) -> None:
    agent = GRADEAgent()
    monkeypatch.setattr(agent, "call_llm", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("no llm")))
    protocol = ResearchProtocol(
        research_question="Corticosteroids for mortality in critically ill COVID-19 patients",
        pico=PICO(
            population="critically ill adults with COVID-19",
            intervention="systemic corticosteroids",
            comparator="usual care",
            outcome_primary="28-day mortality",
        ),
        effect_measure="OR",
    )
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(study_id="S1", population_description="critically ill adults with COVID-19"),
            outcomes=[OutcomeData(outcome_name="28-day mortality", source_quote="S1 row", source_quote_verified=True)],
        ),
        ExtractedStudy(
            characteristics=StudyCharacteristics(study_id="S1", population_description="critically ill adults with COVID-19"),
            outcomes=[OutcomeData(outcome_name="28-day mortality", source_quote="duplicate S1 row", source_quote_verified=True)],
        ),
        ExtractedStudy(
            characteristics=StudyCharacteristics(study_id="S2", population_description="critically ill adults with COVID-19"),
            outcomes=[OutcomeData(outcome_name="28-day mortality", source_quote="S2 row", source_quote_verified=True)],
        ),
    ]

    domain = agent._assess_indirectness(studies, protocol, {"S1", "S2"}, "28-day mortality")

    assert domain.details["n_contributing"] == 2
    assert "2/2 contributing studies" in domain.rationale
    assert "3/3 contributing studies" not in domain.rationale


def test_grade_indirectness_does_not_call_secondary_verified_rows_primary(monkeypatch) -> None:
    agent = GRADEAgent()
    monkeypatch.setattr(agent, "call_llm", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("no llm")))
    protocol = ResearchProtocol(
        research_question="Corticosteroids for mortality in critically ill COVID-19 patients",
        pico=PICO(
            population="critically ill adults with COVID-19",
            intervention="systemic corticosteroids",
            comparator="usual care",
            outcome_primary="28-day mortality",
        ),
        effect_measure="OR",
    )
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(study_id="S1"),
            outcomes=[
                OutcomeData(
                    outcome_name="Serious adverse events related to treatment",
                    source_quote="serious adverse events were reported by treatment group",
                    source_quote_verified=True,
                )
            ],
        ),
        ExtractedStudy(
            characteristics=StudyCharacteristics(study_id="S2"),
            outcomes=[
                OutcomeData(
                    outcome_name="Serious adverse events related to treatment",
                    source_quote="serious adverse events were reported by treatment group",
                    source_quote_verified=True,
                )
            ],
        ),
    ]

    domain = agent._assess_indirectness(
        studies,
        protocol,
        {"S1", "S2"},
        "Serious adverse events related to treatment",
    )

    assert domain.rating == "no concern"
    assert "source-verified outcome rows" in domain.rationale.lower()
    assert "source-verified primary outcome rows" not in domain.rationale.lower()


def test_grade_primary_row_label_does_not_match_secondary_on_generic_overlap() -> None:
    agent = GRADEAgent()

    assert (
        agent._source_verified_row_label(
            "Serious adverse events related to treatment",
            "All-cause mortality at 28 days after initiation of treatment",
        )
        == "outcome rows"
    )


def test_grade_initial_certainty_defaults_to_high_when_design_missing() -> None:
    agent = GRADEAgent()
    studies = [
        ExtractedStudy(characteristics=StudyCharacteristics(study_id="S1")),
        ExtractedStudy(characteristics=StudyCharacteristics(study_id="S2")),
    ]

    assert agent._initial_certainty(studies, {"S1", "S2"}) == 4


def test_grade_initial_certainty_does_not_treat_non_randomized_as_rct() -> None:
    agent = GRADEAgent()
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="S1",
                study_design="non-randomized cohort study",
            )
        )
    ]

    assert agent._initial_certainty(studies, {"S1"}) == 2


def test_grade_rob_rationale_reports_contributing_denominator_even_if_llm_hallucinates(monkeypatch) -> None:
    agent = GRADEAgent()
    monkeypatch.setattr(
        agent,
        "call_llm",
        lambda *args, **kwargs: '{"rationale":"Across the four included studies, none were high risk."}',
    )

    domain = agent._assess_risk_of_bias(
        [
            StudyRoB(study_id="S1", tool_used="RoB 2", overall_judgment="Low risk"),
            StudyRoB(study_id="S2", tool_used="RoB 2", overall_judgment="Some concerns"),
            StudyRoB(study_id="S3", tool_used="RoB 2", overall_judgment="Some concerns"),
            StudyRoB(study_id="S4", tool_used="RoB 2", overall_judgment="Some concerns"),
        ],
        {"S1", "S2", "S3", "S4", "S5", "S6", "S7"},
    )

    assert domain.rating == "serious"
    assert "4/7 contributing studies" in domain.rationale
    assert "3/4 with some concerns" in domain.rationale
    assert "four included studies" not in domain.rationale


def test_grade_imprecision_uses_extracted_arm_totals_instead_of_variance_proxy(monkeypatch) -> None:
    agent = GRADEAgent()
    monkeypatch.setattr(agent, "call_llm", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("no llm")))
    pooled = PooledEffect(
        outcome_name="28-day mortality",
        n_studies=2,
        effect_measure="OR",
        pooled_effect=0.70,
        ci_lower=0.55,
        ci_upper=0.89,
        p_value=0.01,
        studies=[
            StudyEffect(study_id="S1", study_label="One", yi=-0.2, vi=1.0, se=1.0),
            StudyEffect(study_id="S2", study_label="Two", yi=-0.3, vi=1.0, se=1.0),
        ],
    )
    extracted = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(study_id="S1", study_design="randomized trial"),
            outcomes=[OutcomeData(outcome_name="28-day mortality", events_intervention=50, total_intervention=250, events_control=80, total_control=250)],
        ),
        ExtractedStudy(
            characteristics=StudyCharacteristics(study_id="S2", study_design="randomized trial"),
            outcomes=[OutcomeData(outcome_name="28-day mortality", events_intervention=60, total_intervention=250, events_control=90, total_control=250)],
        ),
    ]

    outcome = agent._assess_outcome(
        pooled=pooled,
        rob_results=[],
        pub_bias=None,
        studies=extracted,
        protocol=ResearchProtocol(
            research_question="Corticosteroids for COVID-19 mortality",
            pico=PICO(
                population="critically ill adults with COVID-19",
                intervention="corticosteroids",
                comparator="usual care",
                outcome_primary="28-day mortality",
            ),
            effect_measure="OR",
        ),
    )
    imprecision = next(domain for domain in outcome.domains if domain.domain == "imprecision")

    assert imprecision.rating == "no concern"
    assert imprecision.details["total_n"] == 1000
    assert imprecision.details["ois"] == 600
    assert "1000 participants" in imprecision.rationale
    assert "optimal information size threshold was 600" in imprecision.rationale
    assert "Total N=" not in imprecision.rationale
    assert "OIS" not in imprecision.rationale


def test_grade_imprecision_prefers_adjudicated_primary_row_over_broader_trial_row() -> None:
    agent = GRADEAgent()
    pooled = PooledEffect(
        outcome_name="28-day all-cause mortality in critically ill adults",
        n_studies=1,
        effect_measure="OR",
        pooled_effect=0.59,
        ci_lower=0.45,
        ci_upper=0.78,
        p_value=0.001,
        studies=[StudyEffect(study_id="RECOVERY_SUBGROUP", study_label="RECOVERY", yi=-0.53, vi=0.02, se=0.14)],
    )
    extracted = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(study_id="RECOVERY_SUBGROUP", study_design="randomized trial"),
            outcomes=[
                OutcomeData(
                    outcome_name="28-day all-cause mortality",
                    events_intervention=454,
                    total_intervention=2104,
                    events_control=1065,
                    total_control=4321,
                    source_quote_verified=True,
                ),
                OutcomeData(
                    outcome_name="28-day all-cause mortality in critically ill adults",
                    events_intervention=95,
                    total_intervention=324,
                    events_control=283,
                    total_control=683,
                    source_quote_verified=True,
                    manual_adjudication=True,
                    accepted_timepoint="28-day all-cause mortality in critically ill adults",
                ),
            ],
        )
    ]

    domain = agent._assess_imprecision(
        pooled,
        studies=extracted,
        study_ids={"RECOVERY_SUBGROUP"},
        outcome_name="28-day all-cause mortality in critically ill adults",
    )

    assert domain.details["total_n"] == 1007
    assert "1007 participants" in domain.rationale
    assert "Total N=" not in domain.rationale
    assert "6425" not in domain.rationale


def test_grade_publication_bias_is_not_downgraded_for_less_than_10_studies() -> None:
    agent = GRADEAgent()
    pooled = PooledEffect(
        outcome_name="28-day mortality",
        n_studies=7,
        effect_measure="OR",
        pooled_effect=0.66,
        ci_lower=0.53,
        ci_upper=0.82,
        p_value=0.001,
        studies=[
            StudyEffect(study_id=f"S{i}", study_label=f"Study {i}", yi=-0.4, vi=0.1, se=0.316)
            for i in range(7)
        ],
    )
    pub_bias = PublicationBiasResult(
        egger_p_value=0.02,
        begg_p_value=0.03,
        trim_fill_missing=7,
        trim_fill_adjusted_effect=0.69,
        trim_fill_adjusted_ci_lower=0.50,
        trim_fill_adjusted_ci_upper=0.95,
    )

    domain = agent._assess_publication_bias(pub_bias, pooled)

    assert domain.rating == "no concern"
    assert "fewer than 10 studies" in domain.rationale.lower()
    assert "no downgrade was applied" in domain.rationale


def test_grade_publication_bias_downgrades_when_only_two_studies_contribute() -> None:
    agent = GRADEAgent()
    pooled = PooledEffect(
        outcome_name="cardiovascular death or heart failure hospitalization",
        n_studies=2,
        effect_measure="HR",
        pooled_effect=0.81,
        ci_lower=0.74,
        ci_upper=0.88,
        p_value=0.001,
        studies=[
            StudyEffect(study_id=f"S{i}", study_label=f"Study {i}", yi=-0.2, vi=0.02, se=0.141)
            for i in range(2)
        ],
    )

    domain = agent._assess_publication_bias(None, pooled)

    assert domain.rating == "serious"
    assert "only 2 studies" in domain.rationale.lower()
    assert "downgrade was applied" in domain.rationale


def test_grade_inconsistency_does_not_downgrade_k2_for_prediction_interval_only(monkeypatch) -> None:
    agent = GRADEAgent()
    monkeypatch.setattr(agent, "call_llm", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("no llm")))
    pooled = PooledEffect(
        outcome_name="cardiovascular death or heart failure hospitalization",
        n_studies=2,
        effect_measure="HR",
        pooled_effect=0.81,
        ci_lower=0.74,
        ci_upper=0.88,
        p_value=0.001,
        i_squared=0.0,
        q_p_value=0.678,
        prediction_interval=(0.46, 1.42),
        studies=[
            StudyEffect(study_id="S1", study_label="EMPEROR-Preserved", yi=-0.2357, vi=0.00459, se=0.0678),
            StudyEffect(study_id="S2", study_label="DELIVER", yi=-0.1985, vi=0.00348, se=0.0590),
        ],
    )

    domain = agent._assess_inconsistency(pooled)

    assert domain.rating == "no concern"
    assert "fewer than 3 studies" in domain.rationale
