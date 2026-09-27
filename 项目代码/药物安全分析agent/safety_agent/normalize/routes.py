"""Administration-route vocabulary: route names to ICH E2B route codes.

openFDA stores ``patient.drug.drugadministrationroute`` as the three-digit
ICH E2B(R2) route code ("048"), never as a name. A request that says
``ORAL`` therefore matched nothing: the 2026-09-27 adr-001 osimertinib run
went from 31,866 reports to 0 on that one filter and was reported as "no
reports in FAERS". Every route a caller names is resolved here, against a
closed table, before it reaches a query; a name the table does not hold is
refused with the accepted forms, never passed through to match nothing.

The code table is openFDA's own field specification
(https://open.fda.gov/fields/drugevent.yaml, ``drugadministrationroute``,
fetched 2026-09-27), spelling included ("Oropharingeal",
"Sunconjunctival"). The quarterly FAERS ASCII files carry the same labels as
text, so a frozen snapshot built from them matches on the label, and one
built from openFDA matches on the code: :func:`route_match_forms` yields both.
"""

from __future__ import annotations

import re

#: ICH E2B(R2) route of administration codes, as openFDA documents them.
ROUTE_LABELS: dict[str, str] = {
    "001": "Auricular (otic)",
    "002": "Buccal",
    "003": "Cutaneous",
    "004": "Dental",
    "005": "Endocervical",
    "006": "Endosinusial",
    "007": "Endotracheal",
    "008": "Epidural",
    "009": "Extra-amniotic",
    "010": "Hemodialysis",
    "011": "Intra corpus cavernosum",
    "012": "Intra-amniotic",
    "013": "Intra-arterial",
    "014": "Intra-articular",
    "015": "Intra-uterine",
    "016": "Intracardiac",
    "017": "Intracavernous",
    "018": "Intracerebral",
    "019": "Intracervical",
    "020": "Intracisternal",
    "021": "Intracorneal",
    "022": "Intracoronary",
    "023": "Intradermal",
    "024": "Intradiscal (intraspinal)",
    "025": "Intrahepatic",
    "026": "Intralesional",
    "027": "Intralymphatic",
    "028": "Intramedullar (bone marrow)",
    "029": "Intrameningeal",
    "030": "Intramuscular",
    "031": "Intraocular",
    "032": "Intrapericardial",
    "033": "Intraperitoneal",
    "034": "Intrapleural",
    "035": "Intrasynovial",
    "036": "Intratumor",
    "037": "Intrathecal",
    "038": "Intrathoracic",
    "039": "Intratracheal",
    "040": "Intravenous bolus",
    "041": "Intravenous drip",
    "042": "Intravenous (not otherwise specified)",
    "043": "Intravesical",
    "044": "Iontophoresis",
    "045": "Nasal",
    "046": "Occlusive dressing technique",
    "047": "Ophthalmic",
    "048": "Oral",
    "049": "Oropharingeal",
    "050": "Other",
    "051": "Parenteral",
    "052": "Periarticular",
    "053": "Perineural",
    "054": "Rectal",
    "055": "Respiratory (inhalation)",
    "056": "Retrobulbar",
    "057": "Sunconjunctival",
    "058": "Subcutaneous",
    "059": "Subdermal",
    "060": "Sublingual",
    "061": "Topical",
    "062": "Transdermal",
    "063": "Transmammary",
    "064": "Transplacental",
    "065": "Unknown",
    "066": "Urethral",
    "067": "Vaginal",
}

_INTRAVENOUS = ("040", "041", "042")

#: Names that are not a label verbatim. "Intravenous" is every intravenous
#: code: bolus and drip are intravenous administration too, and a caller who
#: names the route alone has not asked to leave them out.
_SYNONYMS: dict[str, tuple[str, ...]] = {
    "otic": ("001",),
    "intravenous": _INTRAVENOUS,
    "iv": _INTRAVENOUS,
    "im": ("030",),
    "sc": ("058",),
    "sq": ("058",),
    "subcut": ("058",),
    "po": ("048",),
    "inhalation": ("055",),
    "inhaled": ("055",),
    "oropharyngeal": ("049",),
    "subconjunctival": ("057",),
    "口服": ("048",),
    "静脉": _INTRAVENOUS,
    "静脉注射": _INTRAVENOUS,
    "静脉推注": ("040",),
    "静脉滴注": ("041",),
    "皮下": ("058",),
    "皮下注射": ("058",),
    "肌内注射": ("030",),
    "肌肉注射": ("030",),
    "皮内注射": ("023",),
    "鞘内注射": ("037",),
    "鼻内": ("045",),
    "经鼻": ("045",),
    "吸入": ("055",),
    "外用": ("061",),
    "透皮": ("062",),
    "经皮": ("062",),
    "舌下": ("060",),
    "直肠": ("054",),
    "阴道": ("067",),
    "眼用": ("047",),
}


def _key(value: str) -> str:
    return " ".join(value.strip().casefold().split())


def _without_qualifier(label: str) -> str:
    """"Auricular (otic)" -> "auricular"."""
    return _key(re.sub(r"\s*\([^)]*\)", "", label))


def _build_index() -> dict[str, tuple[str, ...]]:
    index: dict[str, tuple[str, ...]] = {}
    for code, label in ROUTE_LABELS.items():
        index[code] = (code,)
        index[_key(label)] = (code,)
        index.setdefault(_without_qualifier(label), (code,))
    # A synonym wins over a qualifier-stripped label ("intravenous" is all
    # three intravenous codes, not only the not-otherwise-specified one).
    index.update(_SYNONYMS)
    return index


_INDEX = _build_index()


def resolve_route(value: str) -> tuple[str, ...]:
    """ICH E2B route codes for one requested route.

    Accepts a code ("048", "48"), an openFDA label in any case ("ORAL",
    "Respiratory (inhalation)"), the label without its parenthetical, or a
    listed synonym. Raises ``ValueError`` naming the accepted forms otherwise.
    """
    key = _key(value)
    if key.isdigit() and len(key) <= 3:
        key = key.zfill(3)
    codes = _INDEX.get(key)
    if codes is None:
        raise ValueError(
            f"unknown administration route {value!r}: give an ICH E2B route code "
            "(001-067, e.g. 048) or its name (e.g. ORAL, NASAL, INTRAVENOUS, "
            "SUBCUTANEOUS)"
        )
    return codes


def resolve_routes(values: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    """Codes for several requested routes, de-duplicated, in request order."""
    codes: list[str] = []
    for value in values:
        codes.extend(resolve_route(value))
    return tuple(dict.fromkeys(codes))


def route_match_forms(value: str) -> frozenset[str]:
    """Every casefolded stored form one requested route may take.

    The requested text itself, each resolved code, and each code's label —
    a frozen snapshot holds whichever form its source used.
    """
    codes = resolve_route(value)
    return frozenset(
        {_key(value), *codes, *(_key(ROUTE_LABELS[code]) for code in codes)}
    )


def describe_routes(values: tuple[str, ...] | list[str]) -> str:
    """"oral -> 048" for notes and error messages."""
    return "; ".join(
        f"{value} -> {'/'.join(resolve_route(value))}" for value in values
    )
