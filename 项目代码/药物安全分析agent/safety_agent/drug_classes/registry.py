"""Load and validate publication-traceable drug-class definitions."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from safety_agent.signals import ContingencyTable2x2


def _term(value: str) -> str:
    return " ".join(value.strip().casefold().split())


@dataclass(frozen=True)
class DrugClassMember:
    id: str
    display_name: str
    canonical_name: str
    match_names: tuple[str, ...]
    atc_codes: tuple[str, ...] = ()
    approval_date: str | None = None

    def __post_init__(self) -> None:
        if not all(
            isinstance(value, str) and value.strip()
            for value in (self.id, self.display_name, self.canonical_name)
        ):
            raise ValueError("drug-class member identifiers must be nonblank")
        names = tuple(
            dict.fromkeys(_term(name) for name in self.match_names if _term(name))
        )
        if not names:
            raise ValueError(f"drug-class member {self.id!r} needs match names")
        object.__setattr__(self, "id", _term(self.id))
        object.__setattr__(self, "match_names", names)


@dataclass(frozen=True)
class DrugClassDefinition:
    id: str
    display_name: str
    version: str
    members: tuple[DrugClassMember, ...]
    atc_codes: tuple[str, ...]
    excluded_products: tuple[str, ...]
    therapeutic_comparator_names: tuple[str, ...]
    sources: tuple[str, ...]

    def __post_init__(self) -> None:
        if not self.members:
            raise ValueError(f"drug class {self.id!r} needs at least one member")
        ids = [member.id for member in self.members]
        if len(ids) != len(set(ids)):
            raise ValueError(f"drug class {self.id!r} has duplicate member ids")
        aliases: dict[str, str] = {}
        for member in self.members:
            for alias in (member.id, *member.match_names):
                owner = aliases.setdefault(_term(alias), member.id)
                if owner != member.id:
                    raise ValueError(
                        f"ambiguous alias {alias!r} in class {self.id!r}: "
                        f"{owner!r} and {member.id!r}"
                    )

    @property
    def all_names(self) -> tuple[str, ...]:
        return tuple(
            dict.fromkeys(
                name for member in self.members for name in member.match_names
            )
        )

    def member(self, member_id: str) -> DrugClassMember:
        needle = _term(member_id)
        for item in self.members:
            if item.id == needle:
                return item
        raise KeyError(f"unknown member {member_id!r} in drug class {self.id!r}")

    def resolve_member(self, name: str) -> DrugClassMember:
        needle = _term(name)
        matches = [
            member
            for member in self.members
            if needle == member.id or needle in member.match_names
        ]
        if len(matches) != 1:
            raise KeyError(
                f"drug name {name!r} does not resolve uniquely in class {self.id!r}"
            )
        return matches[0]


class DrugClassRegistry:
    def __init__(self, definitions: tuple[DrugClassDefinition, ...]) -> None:
        self._definitions = {definition.id: definition for definition in definitions}
        if len(self._definitions) != len(definitions):
            raise ValueError("drug-class registry has duplicate class ids")

    @classmethod
    def bundled(cls) -> "DrugClassRegistry":
        path = Path(__file__).resolve().parent.parent / "data" / "drug_classes.json"
        return cls.from_path(path)

    @classmethod
    def from_path(cls, path: str | Path) -> "DrugClassRegistry":
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        if payload.get("schema_version") != 1:
            raise ValueError("unsupported drug-class registry schema")
        raw_classes = payload.get("classes")
        if not isinstance(raw_classes, list):
            raise ValueError("drug-class registry needs a classes list")
        return cls(tuple(_parse_definition(item) for item in raw_classes))

    def ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._definitions))

    def get(self, class_id: str) -> DrugClassDefinition:
        try:
            return self._definitions[_term(class_id)]
        except KeyError as error:
            raise KeyError(f"unknown drug class {class_id!r}") from error


def build_exclusive_table(
    *,
    target_total: int,
    target_event: int,
    comparator_total: int,
    comparator_event: int,
) -> ContingencyTable2x2:
    """Build a 2x2 table from two already-disjoint exposure cohorts."""
    values = {
        "target_total": target_total,
        "target_event": target_event,
        "comparator_total": comparator_total,
        "comparator_event": comparator_event,
    }
    if any(
        isinstance(value, bool) or not isinstance(value, int) or value < 0
        for value in values.values()
    ):
        raise ValueError("exclusive table counts must be non-negative integers")
    if target_event > target_total or comparator_event > comparator_total:
        raise ValueError("event counts cannot exceed their cohort totals")
    return ContingencyTable2x2(
        a=float(target_event),
        b=float(target_total - target_event),
        c=float(comparator_event),
        d=float(comparator_total - comparator_event),
    )


def _parse_definition(payload: Any) -> DrugClassDefinition:
    if not isinstance(payload, dict):
        raise ValueError("each drug-class definition must be an object")
    raw_members = payload.get("members")
    if not isinstance(raw_members, list):
        raise ValueError("drug-class definition needs a members list")
    members = tuple(
        DrugClassMember(
            id=item["id"],
            display_name=item["display_name"],
            canonical_name=item["canonical_name"],
            match_names=tuple(item["match_names"]),
            atc_codes=tuple(item.get("atc_codes", ())),
            approval_date=item.get("approval_date"),
        )
        for item in raw_members
    )
    return DrugClassDefinition(
        id=_term(payload["id"]),
        display_name=payload["display_name"],
        version=payload["version"],
        members=members,
        atc_codes=tuple(payload.get("atc_codes", ())),
        excluded_products=tuple(payload.get("excluded_products", ())),
        therapeutic_comparator_names=tuple(
            payload.get("therapeutic_comparator_names", ())
        ),
        sources=tuple(payload.get("sources", ())),
    )
