"""Typed engine errors a caller can act on without reading a message."""
from __future__ import annotations


class InsufficientStudiesError(ValueError):
    """Fewer independent studies, contrasts or treatments than the method pools.

    Not a defect of the inputs: the evidence is what it is. The pipeline
    answers it with the narrative / evidence-gap report the pairwise route
    writes, never with a stop (2026-09-29).
    """
