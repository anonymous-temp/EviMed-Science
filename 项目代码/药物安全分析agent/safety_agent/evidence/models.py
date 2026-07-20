"""Shared types for the evidence layer."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class EvidenceItem(BaseModel):
    """One guideline/evidence record from the EviMed retrieval API.

    The upstream ``data.list`` item shape is not part of the documented
    contract, so well-known fields are extracted best-effort and the raw
    record is kept for downstream use.
    """

    title: str
    publisher: str | None = None
    year: int | None = None
    url: str | None = None
    raw: dict[str, Any] = Field(default_factory=dict, exclude=True)


class EvidenceLayerResult(BaseModel):
    """Outcome of the (optional) EviMed evidence retrieval layer."""

    enabled: bool
    items: list[EvidenceItem] = Field(default_factory=list)
    note: str = ""  # why the layer was skipped or what it returned
