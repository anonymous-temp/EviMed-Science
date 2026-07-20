"""Analysis orchestration: normalize -> overview -> signals -> evidence -> interpret -> assemble."""

from typing import TYPE_CHECKING

from .models import (
    AnalysisResult,
    CaseOverview,
    CountBucket,
    FocusAdrInterpretation,
    Interpretation,
    NormalizedReaction,
    SignalRow,
)
if TYPE_CHECKING:
    from .pipeline import AnalysisPipeline, StageCallback

__all__ = [
    "AnalysisPipeline",
    "AnalysisResult",
    "CaseOverview",
    "CountBucket",
    "FocusAdrInterpretation",
    "Interpretation",
    "NormalizedReaction",
    "SignalRow",
    "StageCallback",
]


def __getattr__(name: str):
    """Load the pipeline lazily so data-source modules can reuse models."""
    if name in {"AnalysisPipeline", "StageCallback"}:
        from .pipeline import AnalysisPipeline, StageCallback

        return {"AnalysisPipeline": AnalysisPipeline, "StageCallback": StageCallback}[name]
    raise AttributeError(name)
