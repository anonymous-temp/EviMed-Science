"""Small, versioned event taxonomy seam for SOC, SMQ, and IME groupings."""

from __future__ import annotations

import json
from pathlib import Path

from .models import EventTaxonomyRow


class EventTaxonomy:
    def __init__(self, payload: dict) -> None:
        if payload.get("schema_version") != 1:
            raise ValueError("unsupported event taxonomy schema")
        self.source = payload["source"]
        self._terms = {
            self._term(name): value for name, value in payload.get("terms", {}).items()
        }

    @classmethod
    def bundled(cls) -> "EventTaxonomy":
        path = Path(__file__).resolve().parent.parent / "data" / "event_taxonomy.json"
        return cls(json.loads(path.read_text(encoding="utf-8")))

    def classify(self, reaction: str) -> EventTaxonomyRow:
        item = self._terms.get(self._term(reaction))
        if item is None:
            return EventTaxonomyRow(reaction=reaction, source="unmapped")
        return EventTaxonomyRow(
            reaction=reaction,
            soc=item.get("soc"),
            smqs=item.get("smqs", []),
            is_ime=bool(item.get("ime", False)),
            source=self.source,
        )

    @staticmethod
    def _term(value: str) -> str:
        return " ".join(value.strip().casefold().split())
