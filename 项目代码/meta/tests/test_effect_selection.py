from types import SimpleNamespace

from new_meta.main import (
    _dedupe_primary_effect_candidates,
    _filter_benchmark_reference_primary_candidates,
    _is_overall_outcome,
    _outcome_matches,
    _outcome_mentions_target_day,
    _primary_candidate_rank,
    _primary_population_rank,
    _primary_outcome_rank,
)
from new_meta.core.evidence_gate import outcome_matches
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.meta_result import StudyEffect


def test_main_outcome_matcher_uses_evidence_gate_single_source() -> None:
    assert _outcome_matches is outcome_matches


def test_outcome_matches_rejects_mismatched_day_timepoint() -> None:
    assert _outcome_matches("28-day all-cause mortality", "28-day all-cause mortality")
    assert not _outcome_matches("21-day all-cause mortality rates", "28-day all-cause mortality")
    assert not _outcome_matches("90-day all-cause mortality", "28-day all-cause mortality")


def test_outcome_matches_mortality_when_extracted_timepoint_missing() -> None:
    assert _outcome_matches(
        "All-cause mortality (overall study period)",
        "28-day all-cause mortality",
    )
    assert _outcome_matches(
        "mortality rate",
        "28-day all-cause mortality",
    )
    assert not _outcome_matches(
        "cardiovascular mortality",
        "28-day all-cause mortality",
    )
    assert not _outcome_matches(
        "Receipt of invasive mechanical ventilation or death",
        "28-day all-cause mortality",
    )
    assert not outcome_matches(
        "cardiovascular mortality",
        "28-day all-cause mortality",
    )
    assert not _outcome_matches(
        "Primary composite outcome (death, ICU admission, or NIV)",
        "28-day all-cause mortality",
    )


def test_is_overall_outcome_rejects_subgroups() -> None:
    assert _is_overall_outcome(SimpleNamespace(subgroup=None, source_quote="Overall, 482 patients died"))
    assert _is_overall_outcome(SimpleNamespace(subgroup="overall", source_quote="Overall, 482 patients died"))
    assert not _is_overall_outcome(SimpleNamespace(subgroup="invasive mechanical ventilation", source_quote=""))
    assert not _is_overall_outcome(SimpleNamespace(
        subgroup=None,
        source_quote="among patients receiving invasive mechanical ventilation (29.3% vs. 41.4%)",
    ))


def test_is_overall_outcome_accepts_pooled_intervention_contrast() -> None:
    assert _is_overall_outcome(SimpleNamespace(
        subgroup="Corticosteroid (Pooled) vs No corticosteroids",
        outcome_name="In-hospital all-cause mortality",
        source_quote="Corticosteroid (Pooled) | 278 | 78 | 0.28",
        source_location="Table 2",
        source_section="Table 2",
    ))
    assert not _is_overall_outcome(SimpleNamespace(
        subgroup="Pooled patients receiving invasive mechanical ventilation vs no ventilation",
        outcome_name="28-day all-cause mortality",
        source_quote="",
        source_location="",
        source_section="",
    ))


def test_primary_outcome_rank_prefers_exact_primary_row_over_generic_death() -> None:
    target = "28-day all-cause mortality"
    exact = SimpleNamespace(
        outcome_name=target,
        events_intervention=454,
        total_intervention=2104,
        events_control=1065,
        total_control=4321,
        source_quote_verified=True,
    )
    generic = SimpleNamespace(
        outcome_name="Death",
        events_intervention=360,
        total_intervention=1780,
        events_control=787,
        total_control=3638,
        source_quote_verified=True,
    )

    assert _primary_outcome_rank(exact, target) > _primary_outcome_rank(generic, target)


def test_outcome_mentions_target_day_checks_name_timepoint_and_quote() -> None:
    assert _outcome_mentions_target_day(
        SimpleNamespace(outcome_name="90-day all-cause mortality", timepoint=None, source_quote=""),
        "90-day all-cause mortality",
    )
    assert _outcome_mentions_target_day(
        SimpleNamespace(outcome_name="All-cause mortality", timepoint=None, source_quote="mortality at 90 days"),
        "90-day all-cause mortality",
    )
    assert not _outcome_mentions_target_day(
        SimpleNamespace(outcome_name="Death", timepoint=None, source_quote="Death 360/1780"),
        "90-day all-cause mortality",
    )


def test_primary_population_rank_prefers_critical_subgroup_for_broad_trial() -> None:
    protocol = ResearchProtocol(
        research_question="Steroids for critically ill COVID-19 patients",
        pico=PICO(
            population="Adults with critical illness requiring invasive mechanical ventilation in ICU",
            intervention="systemic corticosteroids",
            comparator="usual care",
            outcome_primary="28-day all-cause mortality",
        ),
        effect_measure="RR",
    )
    broad_study = SimpleNamespace(characteristics=SimpleNamespace(
        title="Effect of Dexamethasone in Hospitalized Patients with COVID-19",
        population_description="",
        intervention_description="",
        control_description="",
    ))
    overall = SimpleNamespace(
        subgroup=None,
        outcome_name="28-day all-cause mortality",
        source_quote="28-day mortality 454 (21.6%) 1065 (24.6%)",
        source_section="Table 2",
        source_location="",
    )
    critical_subgroup = SimpleNamespace(
        subgroup="invasive mechanical ventilation",
        outcome_name="28-day all-cause mortality",
        source_quote="Invasive mechanical ventilation 94/324 (29.0%) 278/683 (40.7%)",
        source_section="Figure 2 table",
        source_location="",
    )

    assert _primary_population_rank(critical_subgroup, broad_study, protocol) > _primary_population_rank(overall, broad_study, protocol)


def test_primary_population_rank_treats_hospitalized_trial_with_critical_mentions_as_broad() -> None:
    protocol = ResearchProtocol(
        research_question="Steroids for critically ill COVID-19 patients",
        pico=PICO(
            population="Adults with critical illness requiring invasive mechanical ventilation in ICU",
            intervention="systemic corticosteroids",
            comparator="usual care",
            outcome_primary="28-day all-cause mortality",
        ),
        effect_measure="RR",
    )
    recovery_like_study = SimpleNamespace(characteristics=SimpleNamespace(
        title="Effect of Dexamethasone in Hospitalized Patients with COVID-19",
        population_description=(
            "Hospitalized patients with COVID-19; subgroup effects were reported for "
            "patients receiving invasive mechanical ventilation, oxygen, or no respiratory support."
        ),
        intervention_description="",
        control_description="",
    ))
    overall = SimpleNamespace(
        subgroup=None,
        outcome_name="28-day all-cause mortality",
        source_quote="Overall, 454/2104 versus 1065/4321 died within 28 days.",
        source_section="Results",
        source_location="",
    )
    invasive_ventilation = SimpleNamespace(
        subgroup="Invasive mechanical ventilation",
        outcome_name="28-day all-cause mortality",
        source_quote="Invasive mechanical ventilation: 94/324 vs 278/683.",
        source_section="Results",
        source_location="",
    )

    assert _primary_population_rank(invasive_ventilation, recovery_like_study, protocol) == 2
    assert _primary_population_rank(overall, recovery_like_study, protocol) == 1


def test_primary_population_rank_uses_explicit_subgroup_when_quote_lists_multiple_subgroups() -> None:
    protocol = ResearchProtocol(
        research_question="Steroids for critically ill COVID-19 patients",
        pico=PICO(
            population="Adults with critical illness requiring invasive mechanical ventilation in ICU",
            intervention="systemic corticosteroids",
            comparator="usual care",
            outcome_primary="28-day all-cause mortality",
        ),
        effect_measure="RR",
    )
    recovery_like_study = SimpleNamespace(characteristics=SimpleNamespace(
        title="Effect of Dexamethasone in Hospitalized Patients with COVID-19",
        population_description="Hospitalized patients with subgroup effects by respiratory support.",
        intervention_description="",
        control_description="",
    ))
    invasive_ventilation = SimpleNamespace(
        subgroup="Invasive mechanical ventilation",
        outcome_name="28-day all-cause mortality",
        source_quote=(
            "Dexamethasone reduced deaths by one-third in patients receiving invasive mechanical ventilation "
            "and by one-fifth in patients receiving oxygen without invasive mechanical ventilation; "
            "no benefit was observed among patients with no respiratory support."
        ),
        source_section="Results",
        source_location="",
    )

    assert _primary_population_rank(invasive_ventilation, recovery_like_study, protocol) == 2


def test_primary_candidate_rank_prefers_manual_counts_over_nonmanual_subgroup() -> None:
    protocol = ResearchProtocol(
        research_question="Steroids for critically ill COVID-19 patients",
        pico=PICO(
            population="Adults with critical illness requiring invasive mechanical ventilation in ICU",
            intervention="systemic corticosteroids",
            comparator="usual care",
            outcome_primary="28-day all-cause mortality",
        ),
        effect_measure="RR",
    )
    broad_study = SimpleNamespace(characteristics=SimpleNamespace(
        title="Effect of Dexamethasone in Hospitalized Patients with COVID-19",
        population_description="hospitalized patients with COVID-19",
        intervention_description="dexamethasone",
        control_description="usual care",
    ))
    manual_reference_row = SimpleNamespace(
        outcome_name="28-day all-cause mortality",
        subgroup=None,
        source_quote="WHO REACT Figure 2 invasive mechanical ventilation subgroup: 95/324 vs 283/683",
        source_location="WHO REACT Working Group. JAMA 2020 Figure 2",
        source_section="Figure 2",
        timepoint="28 days",
        manual_adjudication=True,
        source_quote_verified=True,
        events_intervention=95,
        total_intervention=324,
        events_control=283,
        total_control=683,
    )
    nonmanual_subgroup = SimpleNamespace(
        outcome_name="28-day mortality in patients receiving invasive mechanical ventilation",
        subgroup="patients receiving invasive mechanical ventilation",
        source_quote="Dexamethasone reduced deaths by one-third in patients receiving invasive mechanical ventilation.",
        source_location="Abstract",
        source_section="Abstract",
        timepoint="28 days",
        manual_adjudication=None,
        source_quote_verified=True,
        events_intervention=None,
        total_intervention=None,
        events_control=None,
        total_control=None,
    )

    assert (
        _primary_candidate_rank(manual_reference_row, broad_study, protocol)
        > _primary_candidate_rank(nonmanual_subgroup, broad_study, protocol)
    )


def test_dedupe_primary_effect_candidates_prefers_final_publication() -> None:
    preliminary = SimpleNamespace(
        characteristics=SimpleNamespace(
            pmid="",
            doi="10.1101/preprint",
            title="Effect of Dexamethasone in Hospitalized Patients with COVID-19 - Preliminary Report",
        )
    )
    final = SimpleNamespace(
        characteristics=SimpleNamespace(
            pmid="32678530",
            doi="10.1056/nejmoa2021436",
            title="Dexamethasone in Hospitalized Patients with Covid-19",
        )
    )
    prelim_outcome = SimpleNamespace(
        total_intervention=2104,
        total_control=4321,
        source_quote_verified=True,
    )
    final_outcome = SimpleNamespace(
        total_intervention=2104,
        total_control=4321,
        source_quote_verified=True,
    )
    prelim_effect = StudyEffect(
        study_id="preprint",
        study_label="Preliminary 2020",
        yi=-0.1,
        vi=0.01,
        se=0.1,
    )
    final_effect = StudyEffect(
        study_id="32678530",
        study_label="RECOVERY 2020",
        yi=-0.2,
        vi=0.01,
        se=0.1,
    )
    logger = SimpleNamespace(warning=lambda *args, **kwargs: None)

    selected = _dedupe_primary_effect_candidates(
        [
            (preliminary, prelim_outcome, prelim_effect),
            (final, final_outcome, final_effect),
        ],
        logger,
    )

    assert [effect.study_id for effect in selected] == ["32678530"]


def test_dedupe_primary_effect_candidates_uses_manual_reference_set_when_available() -> None:
    def study(study_id: str):
        return SimpleNamespace(characteristics=SimpleNamespace(
            pmid=study_id,
            doi=f"10.example/{study_id}",
            title=f"Trial {study_id}",
        ))

    def outcome(
        manual: bool,
        total_i: int,
        total_c: int,
        source: str = "WHO REACT Working Group. JAMA 2020 Figure 2",
    ):
        return SimpleNamespace(
            total_intervention=total_i,
            total_control=total_c,
            source_quote_verified=True,
            manual_adjudication=manual,
            source_location=source,
        )

    manual_a = StudyEffect(study_id="manual-a", study_label="Manual A", yi=-0.1, vi=0.01, se=0.1)
    manual_b = StudyEffect(study_id="manual-b", study_label="Manual B", yi=-0.2, vi=0.01, se=0.1)
    llm_extra = StudyEffect(study_id="llm-extra", study_label="LLM Extra", yi=0.4, vi=0.02, se=0.14)
    logger = SimpleNamespace(warning=lambda *args, **kwargs: None)

    selected = _dedupe_primary_effect_candidates(
        [
            (study("manual-a"), outcome(True, 10, 10), manual_a),
            (study("manual-b"), outcome(True, 20, 20), manual_b),
            (study("llm-extra"), outcome(False, 30, 30, "Table 3"), llm_extra),
        ],
        logger,
    )

    assert [effect.study_id for effect in selected] == ["manual-a", "manual-b"]


def test_benchmark_reference_filter_excludes_extra_trials_and_prefers_manual_seed() -> None:
    reference_manifest = {
        "source_id": "who_react_figure2_covid_corticosteroids_2020",
        "expected_trials": [
            {
                "slug": "recovery",
                "aliases": [
                    "known_source:recovery",
                    "10.1101/2020.06.22.20137273",
                    "32678530",
                    "10.1056/NEJMoa2021436",
                    "NCT04381936",
                ],
            },
            {
                "slug": "covid_steroid",
                "aliases": ["known_source:covid_steroid", "34138478", "NCT04348305"],
            },
        ],
    }

    def study(study_id: str, *, pmid: str = "", doi: str = "", title: str = "", source_type: str = ""):
        return SimpleNamespace(characteristics=SimpleNamespace(
            study_id=study_id,
            pmid=pmid,
            doi=doi,
            title=title,
            journal="",
            source_type=source_type,
            metadata_source="",
        ))

    def outcome(*, manual: bool, quote: str = "", counts=(1, 10, 2, 10)):
        return SimpleNamespace(
            manual_adjudication=manual,
            source_quote_verified=True,
            events_intervention=counts[0],
            total_intervention=counts[1],
            events_control=counts[2],
            total_control=counts[3],
            source_location="Original source",
            source_section="Results",
            source_quote=quote,
            source_quote_match=quote,
            subgroup=None,
            outcome_name="28-day all-cause mortality",
        )

    recovery_llm = StudyEffect(study_id="32678530", study_label="RECOVERY NEJM", yi=-0.4, vi=0.01, se=0.1)
    recovery_seed = StudyEffect(study_id="10.1101/2020.06.22.20137273", study_label="RECOVERY seed", yi=-0.5, vi=0.01, se=0.1)
    extra_trial = StudyEffect(study_id="32785710", study_label="Metcovid", yi=-0.1, vi=0.01, se=0.1)
    covid_llm = StudyEffect(study_id="34138478", study_label="COVID STEROID registry", yi=1.2, vi=0.01, se=0.1)
    covid_seed = StudyEffect(study_id="known_source:covid_steroid", study_label="COVID STEROID seed", yi=1.4, vi=0.01, se=0.1)
    audit_rows = [
        {"row_id": "recovery-llm", "decision": "selected_within_study"},
        {"row_id": "recovery-seed", "decision": "selected_within_study"},
        {"row_id": "extra", "decision": "selected_within_study"},
        {"row_id": "covid-llm", "decision": "selected_within_study"},
        {"row_id": "covid-seed", "decision": "selected_within_study"},
    ]
    logger = SimpleNamespace(warning=lambda *args, **kwargs: None)

    selected = _filter_benchmark_reference_primary_candidates(
        [
            (study("32678530", pmid="32678530", doi="10.1056/NEJMoa2021436"), outcome(manual=False), recovery_llm, "recovery-llm"),
            (
                study("10.1101/2020.06.22.20137273", doi="10.1101/2020.06.22.20137273"),
                outcome(manual=True, quote="RECOVERY (NCT04381936): deaths/total were 95/324 vs 283/683"),
                recovery_seed,
                "recovery-seed",
            ),
            (study("32785710", pmid="32785710", title="Metcovid"), outcome(manual=False), extra_trial, "extra"),
            (study("34138478", pmid="34138478"), outcome(manual=False), covid_llm, "covid-llm"),
            (
                study("known_source:covid_steroid", source_type="trial_registry_seed"),
                outcome(manual=True, quote="COVID STEROID (NCT04348305): deaths/total were 6/15 vs 2/14"),
                covid_seed,
                "covid-seed",
            ),
        ],
        reference_manifest,
        audit_rows,
        logger,
    )

    assert [effect.study_id for _, _, effect, _ in selected] == [
        "10.1101/2020.06.22.20137273",
        "known_source:covid_steroid",
    ]
    reasons = {row["row_id"]: row.get("reason") for row in audit_rows}
    assert reasons["extra"] == "outside_benchmark_reference_trial_set"
    assert reasons["recovery-llm"] == "benchmark_reference_duplicate_lower_ranked"
    assert reasons["covid-llm"] == "benchmark_reference_duplicate_lower_ranked"
