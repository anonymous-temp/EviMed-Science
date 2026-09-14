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
