"""Explicit mocked independent clinical judgments for synthetic method fixtures.

Numerical delivery tests supply known aligned cohorts/outcomes. The source-backed
judgment behavior itself is exercised by test_primary_analysis_alignment.py.
"""
from new_meta.core.primary_analysis_alignment import record_checked_alignments


def approve_synthetic_method_fixture(project, protocol, studies):
    from new_meta.core.extraction_verification import numeric_fields
    from verification_fixture import verification_payload
    for study_number, study in enumerate(studies, start=1):
        assessments = []
        source_rows = []
        for index, outcome in enumerate(study.outcomes):
            quotes = {
                "outcome": f"The fixture's primary outcome is {protocol.pico.outcome_primary}.",
                "population": f"The analyzed fixture population is {protocol.pico.population}.",
                "contrast": f"The fixture compares {protocol.pico.intervention} with {protocol.pico.comparator}.",
            }
            source_rows.extend(quotes.values())
            source_rows.append(outcome.source_quote or "")
            assessments.append({"outcome_index": index, **{
                name: {"status": "match", "rationale": "The synthetic fixture explicitly satisfies this protocol dimension.",
                       "quote": quote, "source_location": "Synthetic study fixture"}
                for name, quote in quotes.items()
            }})
        randomized = protocol.review_family in {"", "intervention_rct", "network_meta"}
        registry_id = f"NCT{study_number:08d}"
        trial_quote = f"The independent trial was registered as {registry_id}."
        source_rows.append(trial_quote)
        for index, outcome in enumerate(study.outcomes):
            numeric_quotes = {field: f"The reported {field} was {value}." for field, value in numeric_fields(outcome).items()}
            source_rows.extend(numeric_quotes.values())
            assessments[index]["verification"] = verification_payload(outcome, assessments[index], numeric_quotes=numeric_quotes,
                registry_id=registry_id, trial_quote=trial_quote, randomized=randomized)
        record_checked_alignments(project, protocol, study, assessments,
                                  source_text="\n".join(source_rows), assessor_id="mock-independent-checker",
                                  issue_histories={index: ([], True) for index in range(len(study.outcomes))})
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", studies, subdir="extraction")
    # The real producer runs this existing migration after independent checking.
    # Bind the synthetic ledger inputs to those explicit verifier oracles too.
    from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
    migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies)
