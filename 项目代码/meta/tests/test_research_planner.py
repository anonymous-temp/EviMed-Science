from new_meta.agents.research_planner import ResearchPlanner
from new_meta.schemas.protocol import PICO, ResearchProtocol


def test_research_planner_forces_hr_for_hfpef_composite_time_to_event_endpoint(monkeypatch) -> None:
    planner = ResearchPlanner()

    def fake_structured(*args, **kwargs):
        return ResearchProtocol(
            research_question=(
                "Do SGLT2 inhibitors reduce cardiovascular death or hospitalization "
                "for heart failure in HFpEF?"
            ),
            pico=PICO(
                population="Adults with heart failure with mildly reduced or preserved ejection fraction",
                intervention="SGLT2 inhibitors",
                comparator="Placebo",
                outcome_primary="cardiovascular death or hospitalization for heart failure",
            ),
            effect_measure="RR",
        )

    monkeypatch.setattr(planner, "call_llm_structured", fake_structured)

    protocol = planner.run(
        "SGLT2 inhibitors versus placebo for cardiovascular death or hospitalization for heart failure"
    )

    assert protocol.effect_measure == "HR"


def test_research_planner_keeps_rr_for_plain_binary_mortality_endpoint(monkeypatch) -> None:
    planner = ResearchPlanner()

    def fake_structured(*args, **kwargs):
        return ResearchProtocol(
            research_question="Do corticosteroids reduce 28-day mortality?",
            pico=PICO(
                population="Critically ill adults",
                intervention="Corticosteroids",
                comparator="Usual care",
                outcome_primary="28-day all-cause mortality",
            ),
            effect_measure="RR",
        )

    monkeypatch.setattr(planner, "call_llm_structured", fake_structured)

    protocol = planner.run("Corticosteroids versus usual care for 28-day all-cause mortality")

    assert protocol.effect_measure == "RR"


def test_research_planner_forces_hr_for_explicit_survival_endpoint() -> None:
    protocol = ResearchProtocol(
        research_question="Does treatment improve progression-free survival?",
        pico=PICO(
            population="Adults with cancer",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="progression-free survival",
        ),
        effect_measure="RR",
    )

    ResearchPlanner._apply_effect_measure_rules(protocol)

    assert protocol.effect_measure == "HR"
