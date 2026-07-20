"""Shared utility functions."""

from __future__ import annotations

import math


def safe_float(val) -> float | None:
    """Convert to float, returning None for NaN/None/NA."""
    if val is None:
        return None
    try:
        f = float(val)
        return None if math.isnan(f) or math.isinf(f) else f
    except (ValueError, TypeError):
        return None


def safe_int(val) -> int | None:
    """Convert to int, returning None for NaN/None/NA."""
    if val is None:
        return None
    try:
        f = float(val)
        return None if math.isnan(f) or math.isinf(f) else int(f)
    except (ValueError, TypeError):
        return None
