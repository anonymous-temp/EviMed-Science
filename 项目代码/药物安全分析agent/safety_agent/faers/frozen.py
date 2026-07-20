"""Exact report-level statistics over a frozen, de-identified FAERS snapshot.

openFDA flattens ``patient.drug[]`` for search. A query that ANDs a drug
name with ``drugcharacterization:1`` can therefore match the name on one
array element and the suspect role on another. This module keeps each drug
entry intact and applies both predicates to the same object.

The JSON format is intentionally small and versioned so regression fixtures
and preprocessed quarterly FAERS exports use the same deterministic reader.
It contains no narrative case text or patient identifiers beyond public
FAERS report/case identifiers.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable

from safety_agent.analysis.models import CaseOverview, CountBucket

_VALID_ROLES = frozenset({"PS", "SS", "C", "I"})


def _term(value: str) -> str:
    return " ".join(value.strip().casefold().split())


def _date(value: str | date | None) -> date | None:
    if value is None or isinstance(value, date):
        return value
    compact = value.replace("-", "")
    if len(compact) != 8 or not compact.isdigit():
        raise ValueError(f"invalid FAERS date {value!r}; expected YYYYMMDD")
    return datetime.strptime(compact, "%Y%m%d").date()


@dataclass(frozen=True)
class SnapshotProvenance:
    snapshot_id: str
    source: str
    extracted_at: str
    deduplication: str = "latest_case_version"
    sha256: str | None = None

    def __post_init__(self) -> None:
        for name in ("snapshot_id", "source", "extracted_at", "deduplication"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"snapshot provenance {name} must be nonblank")
        if self.sha256 is not None and (
            len(self.sha256) != 64
            or any(character not in "0123456789abcdef" for character in self.sha256)
        ):
            raise ValueError("snapshot provenance sha256 must be lowercase hexadecimal")


@dataclass(frozen=True)
class DrugEntry:
    medicinal_product: str
    normalized_names: tuple[str, ...]
    role_code: str
    indication: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.medicinal_product, str) or not self.medicinal_product.strip():
            raise ValueError("medicinal_product must be a nonblank string")
        if any(not isinstance(name, str) or not name.strip() for name in self.normalized_names):
            raise ValueError("normalized_names must contain nonblank strings")
        if self.indication is not None and (
            not isinstance(self.indication, str) or not self.indication.strip()
        ):
            raise ValueError("indication must be nonblank when provided")
        role = self.role_code.upper()
        if role not in _VALID_ROLES:
            raise ValueError(f"unsupported FAERS role_code {self.role_code!r}")
        object.__setattr__(self, "role_code", role)

    def matches(self, names: frozenset[str]) -> bool:
        candidates = {_term(self.medicinal_product)}
        candidates.update(_term(name) for name in self.normalized_names)
        return bool(names & candidates)


@dataclass(frozen=True)
class ReportRecord:
    primary_id: str
    case_id: str
    case_version: int
    received_date: date
    drugs: tuple[DrugEntry, ...]
    reactions: tuple[str, ...]
    sex: str | None = None
    age_years: float | None = None
    outcomes: tuple[str, ...] = field(default_factory=tuple)
    country: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.primary_id, str) or not self.primary_id.strip():
            raise ValueError("primary_id must be a nonblank string")
        if not isinstance(self.case_id, str) or not self.case_id.strip():
            raise ValueError("case_id must be a nonblank string")
        if (
            isinstance(self.case_version, bool)
            or not isinstance(self.case_version, int)
            or self.case_version < 1
        ):
            raise ValueError("case_version must be a positive integer")
        if not isinstance(self.received_date, date):
            raise ValueError("received_date must be a date")
        if not self.drugs or any(not isinstance(drug, DrugEntry) for drug in self.drugs):
            raise ValueError("reports need at least one valid drug")
        if not self.reactions or any(
            not isinstance(reaction, str) or not reaction.strip()
            for reaction in self.reactions
        ):
            raise ValueError("reports need at least one nonblank reaction")
        if self.age_years is not None and (
            isinstance(self.age_years, bool)
            or not isinstance(self.age_years, (int, float))
            or not math.isfinite(self.age_years)
            or self.age_years < 0
        ):
            raise ValueError("age_years must be finite and non-negative")
        if any(not isinstance(value, str) or not value.strip() for value in self.outcomes):
            raise ValueError("outcomes must contain nonblank strings")
        for name in ("sex", "country"):
            value = getattr(self, name)
            if value is not None and (
                not isinstance(value, str) or not value.strip()
            ):
                raise ValueError(f"{name} must be nonblank when provided")

    def has_reaction(self, reaction: str) -> bool:
        needle = _term(reaction)
        return any(_term(value) == needle for value in self.reactions)


@dataclass(frozen=True)
class DrugScope:
    """A target drug predicate whose name and role bind to one drug entry."""

    names: tuple[str, ...]
    role_codes: frozenset[str] = field(default_factory=lambda: frozenset({"PS"}))
    date_from: date | str | None = None
    date_to: date | str | None = None

    def __post_init__(self) -> None:
        normalized = tuple(dict.fromkeys(_term(name) for name in self.names if _term(name)))
        if not normalized:
            raise ValueError("DrugScope needs at least one non-empty drug name")
        roles = frozenset(role.upper() for role in self.role_codes)
        if not roles or not roles <= _VALID_ROLES:
            raise ValueError(f"invalid FAERS role codes: {sorted(roles)}")
        start, end = _date(self.date_from), _date(self.date_to)
        if start and end and start > end:
            raise ValueError("DrugScope date_from must not be after date_to")
        object.__setattr__(self, "names", normalized)
        object.__setattr__(self, "role_codes", roles)
        object.__setattr__(self, "date_from", start)
        object.__setattr__(self, "date_to", end)

    @property
    def name_set(self) -> frozenset[str]:
        return frozenset(self.names)

    def contains_date(self, value: date) -> bool:
        return not (
            (self.date_from is not None and value < self.date_from)
            or (self.date_to is not None and value > self.date_to)
        )

    def matches_drug(self, drug: DrugEntry) -> bool:
        return drug.role_code in self.role_codes and drug.matches(self.name_set)


@dataclass(frozen=True)
class ContingencyCounts:
    joint: int
    drug_total: int
    event_total: int
    grand_total: int


class FrozenFAERSSnapshot:
    """In-memory, deduplicated FAERS report snapshot.

    Production snapshots can be generated from quarterly DEMO/DRUG/REAC
    files; tests use the same schema with tiny synthetic report sets.
    """

    schema_version = 1

    def __init__(
        self,
        reports: Iterable[ReportRecord],
        provenance: SnapshotProvenance,
    ) -> None:
        self.provenance = provenance
        self._reports = tuple(self._deduplicate(reports))

    @property
    def reports(self) -> tuple[ReportRecord, ...]:
        return self._reports

    @classmethod
    def from_path(cls, path: str | Path) -> "FrozenFAERSSnapshot":
        source = Path(path)
        payload = json.loads(source.read_text(encoding="utf-8"))
        if payload.get("schema_version") != cls.schema_version:
            raise ValueError(
                f"unsupported frozen FAERS schema {payload.get('schema_version')!r}"
            )
        provenance_payload = payload.get("provenance")
        if not isinstance(provenance_payload, dict):
            raise ValueError("frozen FAERS snapshot needs provenance metadata")
        canonical_payload = dict(payload)
        canonical_provenance = dict(provenance_payload)
        declared_sha256 = canonical_provenance.pop("sha256", None)
        canonical_payload["provenance"] = canonical_provenance
        canonical_bytes = json.dumps(
            canonical_payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        content_sha256 = hashlib.sha256(canonical_bytes).hexdigest()
        if declared_sha256 is not None and declared_sha256 != content_sha256:
            raise ValueError("frozen FAERS snapshot SHA-256 does not match its content")
        canonical_provenance["sha256"] = content_sha256
        provenance = SnapshotProvenance(**canonical_provenance)
        if provenance.deduplication != "latest_case_version":
            raise ValueError(
                "unsupported frozen FAERS deduplication; expected latest_case_version"
            )
        raw_reports = payload.get("reports")
        if not isinstance(raw_reports, list):
            raise ValueError("frozen FAERS snapshot needs a reports list")
        return cls((_parse_report(item) for item in raw_reports), provenance)

    def matching_reports(self, scope: DrugScope) -> tuple[ReportRecord, ...]:
        return tuple(
            report
            for report in self._reports
            if scope.contains_date(report.received_date)
            and any(scope.matches_drug(drug) for drug in report.drugs)
        )

    def contingency(self, scope: DrugScope, reaction: str) -> ContingencyCounts:
        universe = tuple(r for r in self._reports if scope.contains_date(r.received_date))
        drug_reports = {
            report.primary_id
            for report in universe
            if any(scope.matches_drug(drug) for drug in report.drugs)
        }
        event_reports = {
            report.primary_id for report in universe if report.has_reaction(reaction)
        }
        return ContingencyCounts(
            joint=len(drug_reports & event_reports),
            drug_total=len(drug_reports),
            event_total=len(event_reports),
            grand_total=len(universe),
        )

    def top_reactions(self, scope: DrugScope, *, limit: int = 10) -> list[CountBucket]:
        counts: Counter[str] = Counter()
        for report in self.matching_reports(scope):
            counts.update(
                sorted({_term(reaction) for reaction in report.reactions if _term(reaction)})
            )
        return _buckets(counts, limit=limit)

    def overview(self, scope: DrugScope) -> CaseOverview:
        reports = self.matching_reports(scope)
        yearly = Counter(str(report.received_date.year) for report in reports)
        sex = Counter(report.sex for report in reports if report.sex)
        ages = Counter(_age_bucket(report.age_years) for report in reports if report.age_years is not None)
        outcomes = Counter(
            outcome for report in reports for outcome in sorted(set(report.outcomes))
        )
        countries = Counter(report.country for report in reports if report.country)
        concomitant: Counter[str] = Counter()
        indications: Counter[str] = Counter()
        for report in reports:
            report_concomitants: set[str] = set()
            report_indications: set[str] = set()
            for drug in report.drugs:
                if scope.matches_drug(drug):
                    if drug.indication:
                        report_indications.add(drug.indication)
                elif drug.role_code == "C" and not drug.matches(scope.name_set):
                    report_concomitants.add(drug.medicinal_product)
            concomitant.update(report_concomitants)
            indications.update(report_indications)
        return CaseOverview(
            total_reports=len(reports),
            yearly=_buckets(yearly, chronological=True),
            sex=_buckets(sex),
            age_buckets=_buckets(ages),
            outcomes=_buckets(outcomes),
            countries=_buckets(countries, limit=10),
            concomitant_drugs=_buckets(concomitant, limit=10),
            indications=_buckets(indications, limit=10),
        )

    @staticmethod
    def _deduplicate(reports: Iterable[ReportRecord]) -> list[ReportRecord]:
        latest: dict[str, ReportRecord] = {}
        for report in reports:
            current = latest.get(report.case_id)
            if current is None or (report.case_version, report.received_date, report.primary_id) > (
                current.case_version,
                current.received_date,
                current.primary_id,
            ):
                latest[report.case_id] = report
        return sorted(latest.values(), key=lambda report: report.primary_id)


def _parse_report(payload: Any) -> ReportRecord:
    if not isinstance(payload, dict):
        raise ValueError("each frozen FAERS report must be an object")
    raw_drugs = payload.get("drugs")
    raw_reactions = payload.get("reactions")
    if not isinstance(raw_drugs, list) or not raw_drugs:
        raise ValueError("each frozen FAERS report needs at least one drug")
    if not all(isinstance(item, dict) for item in raw_drugs):
        raise ValueError("each frozen FAERS drug entry must be an object")
    if not isinstance(raw_reactions, list) or not all(
        isinstance(value, str) and value.strip() for value in raw_reactions
    ):
        raise ValueError("each frozen FAERS report needs a valid reactions list")
    drugs: list[DrugEntry] = []
    for item in raw_drugs:
        normalized_names = item.get("normalized_names", [])
        if not isinstance(normalized_names, list) or not all(
            isinstance(value, str) and value.strip() for value in normalized_names
        ):
            raise ValueError("normalized_names must be a list of nonblank strings")
        medicinal_product = item.get("medicinal_product")
        role_code = item.get("role_code")
        indication = item.get("indication")
        if not isinstance(medicinal_product, str) or not medicinal_product.strip():
            raise ValueError("medicinal_product must be a nonblank string")
        if not isinstance(role_code, str):
            raise ValueError("role_code must be a string")
        if indication is not None and (
            not isinstance(indication, str) or not indication.strip()
        ):
            raise ValueError("indication must be a nonblank string when provided")
        drugs.append(
            DrugEntry(
                medicinal_product=medicinal_product,
                normalized_names=tuple(normalized_names),
                role_code=role_code,
                indication=indication,
            )
        )
    primary_id = payload.get("primary_id")
    case_id = payload.get("case_id", primary_id)
    if not isinstance(primary_id, str) or not primary_id.strip():
        raise ValueError("primary_id must be a nonblank string")
    if not isinstance(case_id, str) or not case_id.strip():
        raise ValueError("case_id must be a nonblank string")
    if isinstance(payload.get("case_version", 1), bool):
        raise ValueError("case_version must be a positive integer")
    try:
        case_version = int(payload.get("case_version", 1))
    except (TypeError, ValueError) as error:
        raise ValueError("case_version must be a positive integer") from error
    if case_version < 1:
        raise ValueError("case_version must be a positive integer")
    age = payload.get("age_years")
    if age is not None:
        if isinstance(age, bool):
            raise ValueError("age_years must be finite and non-negative")
        try:
            age = float(age)
        except (TypeError, ValueError) as error:
            raise ValueError("age_years must be finite and non-negative") from error
        if not math.isfinite(age) or age < 0:
            raise ValueError("age_years must be finite and non-negative")
    outcomes = payload.get("outcomes", [])
    if not isinstance(outcomes, list) or not all(
        isinstance(value, str) and value.strip() for value in outcomes
    ):
        raise ValueError("outcomes must be a list of nonblank strings")
    received_date_value = payload.get("received_date")
    if not isinstance(received_date_value, str):
        raise ValueError("received_date must be a YYYYMMDD or YYYY-MM-DD string")
    received_date = _date(received_date_value)
    if received_date is None:
        raise ValueError("received_date is required")
    sex = payload.get("sex")
    country = payload.get("country")
    if sex is not None and (not isinstance(sex, str) or not sex.strip()):
        raise ValueError("sex must be a nonblank string when provided")
    if country is not None and (
        not isinstance(country, str) or not country.strip()
    ):
        raise ValueError("country must be a nonblank string when provided")
    return ReportRecord(
        primary_id=primary_id,
        case_id=case_id,
        case_version=case_version,
        received_date=received_date,
        drugs=tuple(drugs),
        reactions=tuple(raw_reactions),
        sex=sex,
        age_years=age,
        outcomes=tuple(outcomes),
        country=country,
    )


def _age_bucket(age: float | None) -> str:
    if age is None:
        return "not reported"
    if age < 18:
        return "<18"
    if age < 45:
        return "18-44"
    if age < 65:
        return "45-64"
    if age < 75:
        return "65-74"
    return "75+"


def _buckets(
    counts: Counter[str], *, limit: int | None = None, chronological: bool = False
) -> list[CountBucket]:
    items = (
        sorted(counts.items())
        if chronological
        else sorted(counts.items(), key=lambda item: (-item[1], str(item[0])))
    )
    if limit is not None:
        items = items[:limit]
    return [CountBucket(term=str(term), count=count) for term, count in items]
