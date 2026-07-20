"""openFDA ``search`` clause builders for drug/event.json and drug/label.json.

openFDA drug/event requires fully qualified field paths — e.g.
``patient.drug.medicinalproduct``; a bare ``medicinalproduct:...`` query
returns 404 NOT_FOUND even when matching reports exist. All builders here
emit the qualified form.

Clause values are double-quoted and escaped exactly like the OpenScience
evimed-research connector (``_openfda_search`` in public_sources.py), and
clauses are joined with ``" AND "`` so urlencode can keep the boolean
operator semantics (spaces encode as ``+`` once; embedding literal ``+``
here would turn into ``%2B`` and search for a literal ``+AND+`` token).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date

from safety_agent.core.exceptions import SafetyAgentError

#: Fully qualified drug/event.json field paths (openFDA FAERS schema).
FIELD_DRUG = "patient.drug.medicinalproduct"
FIELD_REACTION = "patient.reaction.reactionmeddrapt"
FIELD_RECEIVE_DATE = "receivedate"
FIELD_SERIOUS = "serious"
FIELD_SERIOUSNESS_DEATH = "seriousnessdeath"
FIELD_SERIOUSNESS_LIFE_THREATENING = "seriousnesslifethreatening"
FIELD_SERIOUSNESS_HOSPITALIZATION = "seriousnesshospitalization"
FIELD_SERIOUSNESS_DISABLING = "seriousnessdisabling"
FIELD_SERIOUSNESS_CONGENITAL_ANOMALY = "seriousnesscongenitalanomali"
FIELD_SERIOUSNESS_OTHER = "seriousnessother"
FIELD_PATIENT_SEX = "patient.patientsex"
FIELD_PATIENT_AGE = "patient.patientonsetage"
FIELD_PATIENT_AGE_UNIT = "patient.patientonsetageunit"
FIELD_OCCUR_COUNTRY = "occurcountry"
FIELD_PRIMARY_SOURCE_COUNTRY = "primarysourcecountry"

#: Standardized drug-name field (openFDA enrichment). NOTE: values are
#: stored as uppercase salt forms ("ATORVASTATIN CALCIUM") and the field is
#: only populated for a subset of reports (~74% for atorvastatin), so
#: ``.exact`` is unusable and coverage is partial — see drug_clause().
FIELD_DRUG_GENERIC = "patient.drug.openfda.generic_name"

#: Drug-role field. The raw-FAERS name is ``role_cod``, but openFDA does
#: NOT expose it (verified 404); the documented equivalent is
#: ``drugcharacterization`` (1=Suspect, 2=Concomitant, 3=Interacting).
#: Important: value 1 lumps primary AND secondary suspect, so a
#: "PS-only" filter through openFDA is an approximation of raw-FAERS
#: role_cod=PS (documented in the report limitations).
FIELD_DRUG_CHARACTERIZATION = "patient.drug.drugcharacterization"
FIELD_DRUG_ROUTE = "patient.drug.drugadministrationroute"

#: Exact-match variants used by ``count`` queries.
FIELD_DRUG_EXACT = FIELD_DRUG + ".exact"
FIELD_REACTION_EXACT = FIELD_REACTION + ".exact"

#: Drug-name query modes.
DRUG_FIELD_MEDICINALPRODUCT = "medicinalproduct"
DRUG_FIELD_OPENFDA_GENERIC = "openfda_generic"

_SEX_CODES = {"male": "1", "female": "2"}

_OUTCOME_FIELDS = {
    "death": FIELD_SERIOUSNESS_DEATH,
    "life_threatening": FIELD_SERIOUSNESS_LIFE_THREATENING,
    "hospitalization": FIELD_SERIOUSNESS_HOSPITALIZATION,
    "disabling": FIELD_SERIOUSNESS_DISABLING,
    "congenital_anomaly": FIELD_SERIOUSNESS_CONGENITAL_ANOMALY,
    "other": FIELD_SERIOUSNESS_OTHER,
}


def quoted_term(field_path: str, term: str) -> str:
    """``field:"term"`` with openFDA escaping of quotes and backslashes."""
    cleaned = " ".join(term.split())
    if not cleaned:
        raise SafetyAgentError("openFDA search term must not be empty")
    escaped = cleaned.replace("\\", "\\\\").replace('"', '\\"')
    return f'{field_path}:"{escaped}"'


def drug_clause(drug: str, *, field: str = DRUG_FIELD_MEDICINALPRODUCT) -> str:
    """Drug-name search clause.

    ``medicinalproduct``: raw reporter-supplied name (brand/salt variants
    scattered across spellings). ``openfda_generic``: tokenized match on
    the standardized generic-name field — closer to the WHO-DD substance
    level used by published FAERS studies. The tokenized form is used
    deliberately: ``.exact`` is case-sensitive and the stored values are
    uppercase salt forms, so ``generic_name.exact:"metformin"`` misses
    "METFORMIN HYDROCHLORIDE" (verified empirically).
    """
    if field == DRUG_FIELD_OPENFDA_GENERIC:
        return quoted_term(FIELD_DRUG_GENERIC, drug)
    if field != DRUG_FIELD_MEDICINALPRODUCT:
        raise SafetyAgentError(
            f"unsupported drug field {field!r}; expected "
            f"{DRUG_FIELD_MEDICINALPRODUCT!r} or {DRUG_FIELD_OPENFDA_GENERIC!r}"
        )
    return quoted_term(FIELD_DRUG, drug)


def suspect_only_clause() -> str:
    """Approximate primary-suspect-only filter.

    openFDA has no ``role_cod`` field (verified 404); the documented
    equivalent ``drugcharacterization:1`` selects suspect-drug reports but
    lumps primary and secondary suspect — see FIELD_DRUG_CHARACTERIZATION.
    """
    return f"{FIELD_DRUG_CHARACTERIZATION}:1"


def route_clause(route_code: str) -> str:
    """ICH E2B route code on a drug entry (for example 048=oral)."""
    return quoted_term(FIELD_DRUG_ROUTE, route_code)


def reaction_clause(reaction_pt: str, *, exact: bool = False) -> str:
    """Reaction PT clause; ``exact`` uses the case-sensitive .exact field
    (pass the MedDRA-preferred casing, e.g. "Lactic acidosis")."""
    return quoted_term(FIELD_REACTION_EXACT if exact else FIELD_REACTION, reaction_pt)


def reaction_any_clause(reaction_pts: list[str], *, exact: bool = False) -> str:
    """Parenthesized OR of several reaction PTs (e.g. multi-PT endpoints)."""
    pts = [pt for pt in (p.strip() for p in reaction_pts) if pt]
    if not pts:
        raise SafetyAgentError("reaction_any_clause needs at least one PT")
    if len(pts) == 1:
        return reaction_clause(pts[0], exact=exact)
    return "(" + " OR ".join(reaction_clause(pt, exact=exact) for pt in pts) + ")"


def date_range_clause(date_from: date | str | None, date_to: date | str | None) -> str:
    """receivedate:[YYYYMMDD TO YYYYMMDD]; open bounds default to FAERS span."""
    start = _yyyymmdd(date_from) if date_from else "20040101"
    end = _yyyymmdd(date_to) if date_to else date.today().strftime("%Y%m%d")
    if start > end:
        raise SafetyAgentError(f"invalid date range: {date_from} > {date_to}")
    return f"{FIELD_RECEIVE_DATE}:[{start} TO {end}]"


def sex_clause(sex: str) -> str:
    code = _SEX_CODES.get(sex.strip().lower())
    if code is None:
        raise SafetyAgentError(f"unsupported sex filter {sex!r}; expected 'male' or 'female'")
    return f"{FIELD_PATIENT_SEX}:{code}"


def age_range_clause(age_min: int | None, age_max: int | None) -> str:
    """Numeric range on patientonsetage.

    FAERS ages carry heterogeneous units (``patientonsetageunit``); the
    numeric range matches the raw stored number, so treat the result as an
    approximation and document it downstream.
    """
    if age_min is None and age_max is None:
        raise SafetyAgentError("age range needs at least one bound")
    lo = 0 if age_min is None else age_min
    hi = 150 if age_max is None else age_max
    if lo < 0 or hi < 0 or lo > hi:
        raise SafetyAgentError(f"invalid age range [{age_min}, {age_max}]")
    return f"{FIELD_PATIENT_AGE}:[{lo} TO {hi}]"


def age_years_range_clause(age_min: int | None, age_max: int | None) -> str:
    """Age range normalized across the ICH onset-age unit codes.

    ``patientonsetage`` is not intrinsically measured in years.  The paired
    ``patientonsetageunit`` field uses 800=decade, 801=year, 802=month,
    803=week, 804=day and 805=hour.  Each unit-specific branch below maps a
    non-overlapping whole-year interval back to the raw unit before the
    branches are ORed.  Decade-coded ages are necessarily approximate and
    are assigned by their decade's lower bound (for example, 7 -> 70 years).
    """
    if age_min is None and age_max is None:
        raise SafetyAgentError("age range needs at least one bound")
    lo = 0 if age_min is None else age_min
    hi = 150 if age_max is None else age_max
    if lo < 0 or hi < 0 or lo > hi:
        raise SafetyAgentError(f"invalid age range [{age_min}, {age_max}]")

    # Raw units per year.  The decade branch is handled as the reciprocal.
    unit_factors = (("801", 1), ("802", 12), ("803", 52), ("804", 365), ("805", 8760))
    branches: list[str] = []
    decade_lo = math.ceil(lo / 10)
    decade_hi = math.ceil((hi + 1) / 10) - 1
    if decade_lo <= decade_hi:
        branches.append(
            f"({FIELD_PATIENT_AGE_UNIT}:800 AND "
            f"{FIELD_PATIENT_AGE}:[{decade_lo} TO {decade_hi}])"
        )
    for unit, factor in unit_factors:
        raw_lo = lo * factor
        raw_hi = (hi + 1) * factor - 1
        branches.append(
            f"({FIELD_PATIENT_AGE_UNIT}:{unit} AND "
            f"{FIELD_PATIENT_AGE}:[{raw_lo} TO {raw_hi}])"
        )
    return "(" + " OR ".join(branches) + ")"


def serious_clause() -> str:
    return f"{FIELD_SERIOUS}:1"


def outcome_clause(outcome: str) -> str:
    field_path = _OUTCOME_FIELDS.get(outcome.strip().lower())
    if field_path is None:
        raise SafetyAgentError(
            f"unsupported outcome {outcome!r}; expected one of {sorted(_OUTCOME_FIELDS)}"
        )
    return f"{field_path}:1"


def country_clause(country_code: str, *, primary_source: bool = False) -> str:
    """Two-letter lower-case country code on occurcountry (or primarysourcecountry)."""
    code = country_code.strip().lower()
    if len(code) != 2 or not code.isalpha():
        raise SafetyAgentError(f"invalid country code {country_code!r}; expected ISO-3166 alpha-2")
    field_path = FIELD_PRIMARY_SOURCE_COUNTRY if primary_source else FIELD_OCCUR_COUNTRY
    return f"{field_path}:{code}"


def _yyyymmdd(value: date | str) -> str:
    if isinstance(value, date):
        return value.strftime("%Y%m%d")
    digits = value.replace("-", "")
    if len(digits) != 8 or not digits.isdigit():
        raise SafetyAgentError(f"invalid date {value!r}; expected YYYY-MM-DD or YYYYMMDD")
    return digits


@dataclass(frozen=True)
class EventQuery:
    """Structured drug/event.json filter set; None fields are omitted."""

    drug: str | None = None
    reaction: str | None = None
    date_from: date | str | None = None
    date_to: date | str | None = None
    sex: str | None = None
    age_min: int | None = None
    age_max: int | None = None
    serious_only: bool = False
    outcome: str | None = None
    country: str | None = None
    drug_field: str = DRUG_FIELD_MEDICINALPRODUCT
    ps_only: bool = False
    extra_clauses: tuple[str, ...] = field(default_factory=tuple)

    def build_search(self) -> str:
        clauses: list[str] = []
        if self.drug:
            clauses.append(drug_clause(self.drug, field=self.drug_field))
        if self.ps_only:
            clauses.append(suspect_only_clause())
        if self.reaction:
            clauses.append(reaction_clause(self.reaction))
        if self.date_from or self.date_to:
            clauses.append(date_range_clause(self.date_from, self.date_to))
        if self.sex:
            clauses.append(sex_clause(self.sex))
        if self.age_min is not None or self.age_max is not None:
            clauses.append(age_range_clause(self.age_min, self.age_max))
        if self.serious_only:
            clauses.append(serious_clause())
        if self.outcome:
            clauses.append(outcome_clause(self.outcome))
        if self.country:
            clauses.append(country_clause(self.country))
        clauses.extend(self.extra_clauses)
        if not clauses:
            raise SafetyAgentError("EventQuery has no filters; refusing an unscoped search")
        return " AND ".join(clauses)
