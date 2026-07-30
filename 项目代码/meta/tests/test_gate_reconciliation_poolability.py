"""Final effect rows set the study list; they do not overturn a poolability refusal."""
from new_meta.core.evidence_gate import GateDecision, GateResult
from new_meta.main import _reconcile_gate_result_with_final_effect_sizes
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


class _Project:
    def __init__(self, rows):
        self._rows = rows

    def load_json(self, name, subdir=None):
        return self._rows if name == "effect_sizes.json" else None


def _protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="probiotics for antibiotic-associated diarrhea",
        pico=PICO(
            population="adults on antibiotics",
            intervention="probiotics",
            comparator="placebo",
            outcome_primary="incidence of antibiotic-associated diarrhea",
        ),
    )


def _study(study_id: str, intervention: str) -> ExtractedStudy:
    return ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id=study_id,
            pmid=study_id,
            title=f"{intervention} trial",
            intervention=intervention,
            intervention_description=intervention,
            comparator="placebo",
        ),
        outcomes=[
            OutcomeData(
                outcome_name="incidence of antibiotic-associated diarrhea",
                outcome_type="dichotomous",
                intervention_events=10,
                intervention_total=50,
                control_events=15,
                control_total=50,
            )
        ],
    )


def _gate(decision: GateDecision) -> GateResult:
    return GateResult(decision=decision, summary="", reasons=[], prisma_counts={"full_text_assessed": 2})


def test_incompatible_interventions_stay_narrative_with_two_rows() -> None:
    studies = [_study("1", "Lactobacillus rhamnosus GG"), _study("2", "Enterococcus faecium")]
    result = _reconcile_gate_result_with_final_effect_sizes(
        _Project([{"study_id": "1"}, {"study_id": "2"}]), _gate(GateDecision.NARRATIVE), _protocol(), studies
    )
    assert result.decision == GateDecision.NARRATIVE
    assert any("不兼容" in reason for reason in result.reasons)


def test_a_compatible_pair_is_still_promoted() -> None:
    studies = [_study("1", "Lactobacillus rhamnosus GG"), _study("2", "Lactobacillus rhamnosus GG")]
    result = _reconcile_gate_result_with_final_effect_sizes(
        _Project([{"study_id": "1"}, {"study_id": "2"}]), _gate(GateDecision.NARRATIVE), _protocol(), studies
    )
    assert result.decision == GateDecision.META
    assert result.prisma_counts["meta_eligible"] == 2
