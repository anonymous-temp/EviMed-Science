# [IN] list of article dicts (from parser)
# [OUT] list of article dicts with normalized fields
# [POS] src/bibliometric/cleaning/normalizer.py - metadata standardization

from __future__ import annotations

import re
import logging
from collections import Counter

logger = logging.getLogger(__name__)

# Non-informative MeSH terms to exclude from keyword analysis
MESH_STOPWORDS = {
    "humans", "animals", "male", "female", "adult", "aged",
    "middle aged", "young adult", "adolescent", "child",
    "child, preschool", "infant", "infant, newborn", "pregnancy",
    "rats", "mice", "dogs", "rabbits", "swine",
    "prospective studies", "retrospective studies", "cross-sectional studies",
    "cohort studies", "follow-up studies", "case-control studies",
    "randomized controlled trials as topic",
    "treatment outcome", "time factors", "risk factors",
    "age factors", "sex factors", "prognosis",
    "united states", "china", "japan", "europe",
}
INSTITUTION_ALIASES = {
    "MIT": "Massachusetts Institute of Technology",
    "UCLA": "University of California, Los Angeles",
    "UCSF": "University of California, San Francisco",
    "HMS": "Harvard Medical School",
    "Harvard Medical School": "Harvard Medical School",
    "NIH": "National Institutes of Health",
    "National Institutes of Health": "National Institutes of Health",
    "CDC": "Centers for Disease Control and Prevention",
    "WHO": "World Health Organization",
    "NHS": "National Health Service",
    "FDA": "Food and Drug Administration",
    # Pharma company normalization
    "Novo Nordisk A/S": "Novo Nordisk",
    "Novo Nordisk Inc": "Novo Nordisk",
    "Novo Nordisk Inc.": "Novo Nordisk",
}

# Fragments that are sub-units, not standalone institutions
INSTITUTION_FRAGMENTS = {
    # Faculty / College / School of X
    "college of medicine", "school of medicine", "faculty of medicine",
    "college of pharmacy", "school of pharmacy", "faculty of pharmacy",
    "college of nursing", "school of nursing", "faculty of nursing",
    "college of dentistry", "school of dentistry", "faculty of dentistry",
    "college of public health", "school of public health",
    "faculty of health sciences", "college of health sciences",
    "faculty of health and medical sciences", "faculty of medical sciences",
    "faculty of science", "college of science",
    "school of biomedical sciences", "school of health",
    "graduate school", "medical school",
    # Hospital / clinical sub-units
    "university hospital", "teaching hospital", "affiliated hospital",
    # Department-level fragments
    "department of medicine", "department of surgery",
    "department of internal medicine", "department of endocrinology",
    "department of cardiology", "department of pediatrics",
    "department of pharmacology", "department of pathology",
    "department of radiology", "department of psychiatry",
    "department of neurology", "department of oncology",
    "department of anesthesiology", "department of dermatology",
    "department of ophthalmology", "department of urology",
    "department of obstetrics", "department of orthopedics",
    # Pure discipline / disease names (not institutions)
    "internal medicine", "endocrinology", "cardiology", "pediatrics",
    "pharmacology", "pathology", "radiology", "psychiatry",
    "neurology", "oncology", "surgery", "medicine",
    "diabetes", "diabetes and metabolism", "diabetes research centre",
    "diabetes research center", "diabetes complications research centre",
    "obesity", "cardiovascular",
    "clinical research", "biomedical research",
    "biomedical research centre", "biomedical research center",
}

# Regex pattern for validating that a string looks like a real institution
_INSTITUTION_KEYWORDS_RE = re.compile(
    r"\b(University|Institute|Hospital|Clinic|College|Center|Centre|"
    r"School|Academy|Laboratory|Foundation|Agency|Authority|Ministry|"
    r"Corporation|Company|Inc|Ltd|A/S|GmbH|S\.?A\.?|Novo Nordisk|"
    r"Pfizer|AstraZeneca|Merck|Roche|Novartis|Lilly|Sanofi|"
    r"Mayo Clinic|Cleveland Clinic|Kaiser|Veterans Affairs)\b",
    re.IGNORECASE,
)

# Country patterns for extraction from affiliations
COUNTRY_PATTERNS = [
    (r"\bUSA\b|\bUnited States\b|\bU\.S\.A\b", "United States"),
    (r"\bChina\b|\bP\.R\. China\b|\bPR China\b|\bPeople's Republic of China\b", "China"),
    (r"\bUK\b|\bUnited Kingdom\b|\bEngland\b|\bScotland\b|\bWales\b", "United Kingdom"),
    (r"\bGermany\b", "Germany"),
    (r"\bJapan\b", "Japan"),
    (r"\bFrance\b", "France"),
    (r"\bItaly\b", "Italy"),
    (r"\bCanada\b", "Canada"),
    (r"\bAustralia\b", "Australia"),
    (r"\bSpain\b", "Spain"),
    (r"\bSouth Korea\b|\bKorea\b|\bRepublic of Korea\b", "South Korea"),
    (r"\bBrazil\b", "Brazil"),
    (r"\bIndia\b", "India"),
    (r"\bNetherlands\b|\bThe Netherlands\b", "Netherlands"),
    (r"\bSweden\b", "Sweden"),
    (r"\bSwitzerland\b", "Switzerland"),
    (r"\bTurkey\b|\bTürkiye\b", "Turkey"),
    (r"\bIran\b", "Iran"),
    (r"\bTaiwan\b", "Taiwan"),
    (r"\bDenmark\b", "Denmark"),
    (r"\bBelgium\b", "Belgium"),
    (r"\bAustria\b", "Austria"),
    (r"\bIsrael\b", "Israel"),
    (r"\bNorway\b", "Norway"),
    (r"\bFinland\b", "Finland"),
    (r"\bPoland\b", "Poland"),
    (r"\bPortugal\b", "Portugal"),
    (r"\bGreece\b", "Greece"),
    (r"\bIreland\b", "Ireland"),
    (r"\bSingapore\b", "Singapore"),
    (r"\bMexico\b", "Mexico"),
    (r"\bSaudi Arabia\b", "Saudi Arabia"),
    (r"\bEgypt\b", "Egypt"),
    (r"\bRussia\b|\bRussian Federation\b", "Russia"),
    (r"\bThailand\b", "Thailand"),
    (r"\bMalaysia\b", "Malaysia"),
    (r"\bPakistan\b", "Pakistan"),
    (r"\bArgentina\b", "Argentina"),
    (r"\bColombia\b", "Colombia"),
    (r"\bCzech Republic\b|\bCzechia\b", "Czech Republic"),
    (r"\bNew Zealand\b", "New Zealand"),
    (r"\bSouth Africa\b", "South Africa"),
]


def normalize_articles(articles: list[dict]) -> list[dict]:
    """Normalize all articles: authors, affiliations, keywords."""
    keyword_mapping = _build_keyword_mapping(articles)
    normalized = []
    for art in articles:
        norm = {**art}
        norm["authors_normalized"] = _normalize_authors(art.get("authors", []))
        norm["institutions"] = _extract_institutions(art.get("affiliations", []))
        norm["countries"] = _extract_countries(art.get("affiliations", []))
        norm["keywords_merged"] = _merge_keywords(
            art.get("keywords", []),
            art.get("mesh_terms", []),
            keyword_mapping,
        )
        normalized.append(norm)
    logger.info("Normalized %d articles", len(normalized))
    return normalized


def _normalize_authors(authors: list[dict]) -> list[str]:
    """Normalize author names. Prefer 'LastName ForeName' when fore_name is
    available (most post-2015 PubMed records) to reduce false merges among
    common surnames (e.g. Wang H → Wang Hua vs Wang Hong)."""
    normalized = []
    for a in authors:
        last = a.get("last_name", "").strip()
        if not last:
            continue
        fore = a.get("fore_name", "").strip()
        if fore:
            # Use full fore_name for better disambiguation
            normalized.append(f"{last} {fore}")
        else:
            initials = a.get("initials", "").strip()
            if initials:
                normalized.append(f"{last} {initials}")
            else:
                normalized.append(last)
    return normalized


def _extract_institutions(affiliations: list[str]) -> list[str]:
    """Extract institution names from affiliation strings."""
    institutions = []
    for aff in affiliations:
        inst = _parse_institution(aff)
        if inst:
            institutions.append(inst)
    return list(dict.fromkeys(institutions))


def _is_fragment(name: str) -> bool:
    """Check if a name is a known sub-unit fragment."""
    lower = name.lower().strip()
    return any(lower == frag or lower.startswith(frag + ",")
               for frag in INSTITUTION_FRAGMENTS)


def _looks_like_institution(name: str) -> bool:
    """Check if a name contains keywords typical of real institutions."""
    return bool(_INSTITUTION_KEYWORDS_RE.search(name))


def _parse_institution(affiliation: str) -> str:
    """Extract primary institution from an affiliation string.

    Skips sub-unit fragments (e.g. 'College of Medicine') and looks for the
    parent institution further along the affiliation string.
    Returns empty string if no credible institution name is found.
    """
    for abbr, full in INSTITUTION_ALIASES.items():
        if re.search(rf"\b{re.escape(abbr)}\b", affiliation):
            return full

    patterns = [
        r"(?:Department of .+?,\s*)(.+?)(?:,|$)",
        r"(?:Division of .+?,\s*)(.+?)(?:,|$)",
        r"(?:School of .+?,\s*)(.+?)(?:,|$)",
        r"(?:Faculty of .+?,\s*)(.+?)(?:,|$)",
        # Match full institution names (e.g. "Harvard Medical School", "Johns Hopkins University")
        r"((?:\w+\s+)*?(?:University|Institute|Hospital|College|Center|Centre|"
        r"Academy|Laboratory|Medical (?:Center|School|College))(?:\s+of\s+\w+)*)(?:,|$)",
    ]

    candidates = []
    for pattern in patterns:
        for match in re.finditer(pattern, affiliation, re.IGNORECASE):
            inst = match.group(1).strip().rstrip(".")
            if len(inst) > 5:
                candidates.append(inst)

    # Filter out fragment-only matches; prefer the first non-fragment
    for inst in candidates:
        if not _is_fragment(inst) and _looks_like_institution(inst):
            return inst

    # If all candidates are fragments, try comma-separated parts for a
    # parent institution (e.g. "College of Medicine, University of Florida")
    parts = [p.strip().rstrip(".") for p in affiliation.split(",")]
    for part in parts:
        if len(part) > 5 and not _is_fragment(part) and _looks_like_institution(part):
            return part

    # No credible institution found — return empty rather than a fragment
    return ""


def _extract_countries(affiliations: list[str]) -> list[str]:
    """Extract country names from affiliation strings."""
    countries = []
    for aff in affiliations:
        country = _detect_country(aff)
        if country:
            countries.append(country)
    return list(dict.fromkeys(countries))


def _detect_country(affiliation: str) -> str:
    """Detect country from affiliation text."""
    for pattern, country in COUNTRY_PATTERNS:
        if re.search(pattern, affiliation, re.IGNORECASE):
            return country
    return ""


def _build_keyword_mapping(articles: list[dict]) -> dict[str, str]:
    """Build synonym mapping from all keywords (lowercase → canonical)."""
    all_kws = Counter()
    for art in articles:
        for kw in art.get("keywords", []) + art.get("mesh_terms", []):
            all_kws[kw.strip()] += 1

    mapping = {}
    seen_lower = {}
    for kw in sorted(all_kws, key=all_kws.get, reverse=True):
        lower = kw.lower().strip()
        if lower not in seen_lower:
            seen_lower[lower] = kw
            mapping[kw] = kw
        else:
            mapping[kw] = seen_lower[lower]
    return mapping


def _merge_keywords(
    author_kws: list[str],
    mesh_terms: list[str],
    mapping: dict[str, str],
) -> list[str]:
    """Merge author keywords and MeSH terms with dedup and stopword removal."""
    merged = []
    seen = set()
    for kw in author_kws + mesh_terms:
        canonical = mapping.get(kw.strip(), kw.strip())
        lower = canonical.lower()
        if lower and lower not in seen and lower not in MESH_STOPWORDS:
            seen.add(lower)
            merged.append(canonical)
    return merged
