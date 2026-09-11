"""Explicit mocked independent clinical judgments for synthetic method fixtures.

Numerical delivery tests supply known aligned cohorts/outcomes. The source-backed
judgment behavior itself is exercised by test_primary_analysis_alignment.py.
"""
from new_meta.core.primary_analysis_alignment import record_checked_alignments


def approve_synthetic_method_fixture(project, protocol, studies):
    for study in studies:
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
        record_checked_alignments(project, protocol, study, assessments,
                                  source_text="\n".join(source_rows), assessor_id="mock-independent-checker")
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", studies, subdir="extraction")
