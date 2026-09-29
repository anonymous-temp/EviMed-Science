"""The new model-output boundary; persisted OutcomeData remains permissive."""
from typing import Literal

from pydantic import Field

from new_meta.schemas.outcome_types import ExtractedOutcomeType
from new_meta.schemas.study import OutcomeData


class ExtractedOutcomeData(OutcomeData):
    """Require a canonical type for newly generated or corrected extraction rows."""

    outcome_type: ExtractedOutcomeType = Field(
        ...,
        description=(
            "Choose exactly one statistical outcome type from the enum. Keep clinical "
            "endpoint names, composite components, population qualifiers and time horizons "
            "in the existing outcome description fields. Do not invent type suffixes or aliases."
        ),
    )
    protocol_outcome_role: Literal["primary", "secondary", "other", ""] = Field(
        "",
        description=(
            "Which protocol outcome this source result reports: primary when it is the "
            "protocol's Primary Outcome (whatever language or wording either uses), "
            "secondary when it is one of the listed Secondary Outcomes, otherwise other "
            "(empty only for a row carried over from before this field). "
            "A clinical judgment about the endpoint; keep outcome_name as the source names it."
        ),
    )
    treatment_arm_role: Literal["review_intervention", "review_comparator", "other", ""] = Field(
        "",
        description=(
            "What the treatment_arm receives, judged against the protocol's Intervention and "
            "Comparator text (not against the arm's label): review_intervention when it receives "
            "the review's intervention, review_comparator when it receives the review's "
            "comparator (placebo, saline, no treatment - whatever the source calls it), other when "
            "it receives anything else (a different active drug, a regimen outside the protocol). "
            "Empty only when the result has no arms."
        ),
    )
    reference_arm_role: Literal["review_intervention", "review_comparator", "other", ""] = Field(
        "",
        description=(
            "What the reference_arm receives, judged the same way as treatment_arm_role: "
            "review_intervention, review_comparator or other. Empty only when the result has no arms."
        ),
    )
    subgroup_values: dict[str, str] = Field(
        default_factory=dict,
        exclude_if=lambda value: not value,
        description=(
            "One entry per closed subgroup variable listed in the prompt: the variable id mapped to "
            "exactly one of that variable's listed values, judged for this row's own comparison "
            "(what its treatment arm receives, and whom the comparison reports on) against the value "
            "definitions; not_reported when the source does not say. Use only the listed ids and values. "
            "Empty when the prompt lists no closed subgroup variables."
        ),
    )
    comparative_design: Literal[
        "", "unknown", "parallel_rct", "cluster_rct", "crossover_rct", "multi_arm_rct",
    ] = Field(
        ...,
        description=(
            "Required source-based design for this result. Use exactly one canonical RCT "
            "design, unknown when unresolved or when multiple complex dependencies cannot "
            "be represented by one design, or an empty string for a non-RCT result. "
            "Keep descriptive wording in study_design and quality_notes, not in this enum. "
            "Parallel arms can coexist with cluster allocation: retain cluster_rct. "
            "Never assume parallel_rct from a missing design or the review's eligibility."
        ),
    )
