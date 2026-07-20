from new_meta.core.evidence_gate import EvidenceGate
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def test_evidence_gate_uses_protocol_design_for_extractable_primary_when_design_missing():
    protocol = ResearchProtocol(
        research_question="Do SGLT2 inhibitors reduce cardiovascular death or heart failure hospitalization?",
        pico=PICO(
            population="Adults with heart failure with preserved or mildly reduced ejection fraction",
            intervention="SGLT2 inhibitor",
            comparator="placebo",
            outcome_primary="Composite of cardiovascular death or hospitalization for heart failure",
        ),
        study_design="Randomized Controlled Trial",
        study_designs=["Randomized Controlled Trial"],
        effect_measure="HR",
    )
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="S1",
            pmid="S1",
            title="Large cardiovascular outcome trial",
            authors=["Anker SD"],
            year=2021,
            study_design="",
            population_description="Adults with heart failure with preserved ejection fraction",
            intervention_description="",
            control_description="",
        ),
        outcomes=[
            OutcomeData(
                outcome_name="Composite of cardiovascular death or hospitalization for heart failure",
                outcome_type="time-to-event",
                hazard_ratio=0.79,
                hr_ci_lower=0.69,
                hr_ci_upper=0.90,
                source_quote_verified=True,
            )
        ],
    )

    result = EvidenceGate(protocol).evaluate([study])

    assert result.evidence_classes["S1"] == "direct_eligible_rct"
    assert result.evidence_tiers["S1"] == "direct_eligible_study"
    assert result.meta_eligible_studies == ["S1"]


def test_evidence_gate_deduplicates_computable_ids_when_same_study_seen_twice():
    protocol = ResearchProtocol(
        research_question="Do corticosteroids reduce 28-day mortality in critical COVID-19?",
        pico=PICO(
            population="Critically ill adults with COVID-19",
            intervention="systemic corticosteroids",
            comparator="usual care",
            outcome_primary="28-day all-cause mortality",
        ),
        study_design="Randomized Controlled Trial",
        study_designs=["Randomized Controlled Trial"],
        effect_measure="OR",
    )

    def study(study_id: str, title: str) -> ExtractedStudy:
        return ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id=study_id,
                pmid=study_id,
                title=title,
                authors=["Example A"],
                year=2020,
                study_design="Randomized Controlled Trial",
                population_description="Critically ill adults with COVID-19",
                intervention_description="systemic corticosteroids",
                control_description="usual care",
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="28-day all-cause mortality",
                    outcome_type="dichotomous",
                    events_intervention=10,
                    total_intervention=100,
                    events_control=20,
                    total_control=100,
                    source_quote_verified=True,
                )
            ],
        )

    result = EvidenceGate(protocol).evaluate([
        study("S1", "Trial record"),
        study("S1", "Duplicate registry record"),
        study("S2", "Second trial"),
    ])

    assert result.meta_eligible_studies == ["S1", "S2"]
    assert result.prisma_counts["direct_eligible"] == 2
    assert result.prisma_counts["meta_eligible"] == 2


def test_evidence_gate_treats_sars_cov2_and_covid_critical_illness_as_same_population():
    protocol = ResearchProtocol(
        research_question="Do corticosteroids reduce mortality in adults with critical COVID-19?",
        pico=PICO(
            population="Adults with confirmed or suspected SARS-CoV-2 infection and critical illness",
            intervention="systemic corticosteroids",
            comparator="usual care",
            outcome_primary="28-day all-cause mortality",
        ),
        study_design="Randomized Controlled Trial",
        study_designs=["Randomized Controlled Trial"],
        effect_measure="OR",
    )
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="REMAP-CAP",
            pmid="32876697",
            title="Effect of Hydrocortisone on Mortality and Organ Support in Patients With Severe COVID-19",
            authors=["Angus DC"],
            year=2020,
            study_design="Randomized Clinical Trial",
            population_description=(
                "Patients with severe COVID-19 meeting criteria for critical illness "
                "enrolled in the REMAP-CAP corticosteroid domain."
            ),
            intervention_description="Hydrocortisone fixed-dose or shock-dependent strategy",
            control_description="No hydrocortisone; standard care without protocol-mandated hydrocortisone",
        ),
        outcomes=[
            OutcomeData(
                outcome_name="All-cause mortality at 28 days post-randomization or initiation of treatment.",
                outcome_type="dichotomous",
                events_intervention=26,
                total_intervention=105,
                events_control=29,
                total_control=92,
                source_quote_verified=True,
            )
        ],
    )

    result = EvidenceGate(protocol).evaluate([study])

    assert result.evidence_classes["32876697"] == "direct_eligible_rct"
    assert result.evidence_tiers["32876697"] == "direct_eligible_study"
    assert result.meta_eligible_studies == ["32876697"]


def test_evidence_gate_computable_count_honors_reported_not_extractable_tier():
    protocol = ResearchProtocol(
        research_question="Do corticosteroids reduce mortality in critical COVID-19?",
        pico=PICO(
            population="Adults with COVID-19",
            intervention="systemic corticosteroids",
            comparator="usual care",
            outcome_primary="28-day all-cause mortality",
        ),
        study_design="Randomized Controlled Trial",
        study_designs=["Randomized Controlled Trial"],
        effect_measure="OR",
    )
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="S1",
            pmid="S1",
            title="Trial with incompletely extracted primary row",
            authors=["Example A"],
            year=2020,
            study_design="Randomized Controlled Trial",
            population_description="Adults with COVID-19",
            intervention_description="Hydrocortisone",
            control_description="usual care",
        ),
        outcomes=[
            OutcomeData(
                outcome_name="28-day all-cause mortality",
                outcome_type="dichotomous",
                events_intervention=1,
                total_intervention=10,
                events_control=2,
                total_control=10,
            )
        ],
    )
    gate = EvidenceGate(protocol)

    computable = gate._count_computable(
        [study],
        set(),
        [],
        {"S1": "direct_eligible_rct"},
        {"S1": "outcome_reported_but_not_extractable"},
    )

    assert computable == []
