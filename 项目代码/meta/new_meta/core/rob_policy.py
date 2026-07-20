"""Review-family-specific risk-of-bias policy selection."""
from __future__ import annotations

from dataclasses import dataclass

from new_meta.prompts import rob_prompts
from new_meta.schemas.method_policy import ReviewFamily
from new_meta.schemas.risk_of_bias import RoBTargetEffect


@dataclass(frozen=True)
class RoBPolicy:
    tool_name: str
    tool_version: str
    target_effect: RoBTargetEffect
    domain_names: tuple[str, ...]
    prompt_template: str


def resolve_rob_policy(*, family: ReviewFamily | str, study_design: str = "") -> RoBPolicy:
    family = family if isinstance(family, ReviewFamily) else ReviewFamily(str(family))
    if family is ReviewFamily.INTERVENTION_RCT:
        return RoBPolicy(
            "RoB 2",
            "RoB 2 v2 (2019)",
            RoBTargetEffect.ASSIGNMENT,
            (
                "Randomization process", "Deviations from intended interventions",
                "Missing outcome data", "Measurement of the outcome",
                "Selection of the reported result",
            ),
            rob_prompts.ROB2_PROMPT,
        )
    if family is ReviewFamily.INTERVENTION_NRSI:
        return RoBPolicy(
            "ROBINS-I",
            "ROBINS-I (2016)",
            RoBTargetEffect.EXPOSURE,
            (
                "Confounding", "Selection of participants", "Classification of interventions",
                "Deviations from intended interventions", "Missing data",
                "Measurement of outcomes", "Selection of the reported result",
            ),
            rob_prompts.ROBINS_I_PROMPT,
        )
    if family is ReviewFamily.PREVALENCE_INCIDENCE:
        return RoBPolicy(
            "JBI Critical Appraisal Checklist for Prevalence Studies",
            "JBI Prevalence Checklist (2020)",
            RoBTargetEffect.PREVALENCE,
            (
                "Sample frame", "Sampling method", "Sample size", "Subjects and setting",
                "Coverage of identified sample", "Condition measurement",
                "Measurement reliability", "Statistical analysis", "Response rate",
            ),
            rob_prompts.JBI_PREVALENCE_PROMPT,
        )
    if family is ReviewFamily.DIAGNOSTIC_ACCURACY:
        return RoBPolicy(
            "QUADAS-2",
            "QUADAS-2 (2011)",
            RoBTargetEffect.DIAGNOSTIC_ACCURACY,
            ("Patient selection", "Index test", "Reference standard", "Flow and timing"),
            rob_prompts.QUADAS2_PROMPT,
        )
    if family is ReviewFamily.PROGNOSTIC_FACTOR:
        return RoBPolicy(
            "QUIPS",
            "QUIPS",
            RoBTargetEffect.PROGNOSTIC_ASSOCIATION,
            (
                "Study participation", "Study attrition", "Prognostic factor measurement",
                "Outcome measurement", "Study confounding", "Statistical analysis and reporting",
            ),
            rob_prompts.QUIPS_PROMPT,
        )
    if family is ReviewFamily.PREDICTION_MODEL:
        return RoBPolicy(
            "PROBAST",
            "PROBAST (2019)",
            RoBTargetEffect.PREDICTION_MODEL,
            ("Participants", "Predictors", "Outcome", "Analysis"),
            rob_prompts.PROBAST_PROMPT,
        )
    # Complex/narrative families still resolve by the contributing study design.
    lowered = str(study_design or "").lower()
    fallback_family = (
        ReviewFamily.INTERVENTION_RCT
        if any(marker in lowered for marker in ("rct", "random", "随机"))
        else ReviewFamily.INTERVENTION_NRSI
    )
    return resolve_rob_policy(family=fallback_family, study_design=study_design)
