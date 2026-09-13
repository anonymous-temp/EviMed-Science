"""New extraction vocabulary and the existing pairwise engine input contract."""
from types import MappingProxyType
from typing import Literal, get_args


ExtractedOutcomeType = Literal[
    "dichotomous", "continuous", "time_to_event", "proportion", "correlation", "count",
    "incidence_rate", "diagnostic_accuracy", "discrimination", "calibration", "overall_performance",
]
CANONICAL_EXTRACTION_OUTCOME_TYPES = get_args(ExtractedOutcomeType)

# This is the existing compute_effect_size admission table, including its
# historical binary alias. DTA and prediction inputs have their own compiled
# engines; allowing their extraction does not admit them to the pairwise engine.
PAIRWISE_EFFECT_MEASURES_BY_OUTCOME_TYPE = MappingProxyType({
    "dichotomous": frozenset({"OR", "RR", "RD", "IRR"}),
    "binary": frozenset({"OR", "RR", "RD", "IRR"}),
    "continuous": frozenset({"MD", "SMD"}),
    "time_to_event": frozenset({"HR"}),
    "proportion": frozenset({"PROP"}),
    "correlation": frozenset({"COR"}),
    "count": frozenset({"IRR"}),
    "incidence_rate": frozenset({"IRR"}),
})
