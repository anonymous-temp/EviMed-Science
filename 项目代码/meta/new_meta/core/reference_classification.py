"""Small reference-entry classifiers shared by citation audit and writing."""
from __future__ import annotations

import re


_REGISTRY_TERMS = (
    "clinicaltrials.gov",
    "eudract",
    "clinical trials register",
    "trial registry",
    "registry results",
)

_EXPLICIT_TRIAL_PATTERNS = (
    r"\bnct\d{8}\b",
    r"\brandomi[sz]ed(?:\s+\w+){0,4}\s+trial\b",
    r"\brandomi[sz]ed(?:\s+\w+){0,4}\s+clinical\s+trial\b",
    r"\bclinical\s+trial\b",
    r"\bcontrolled\s+trial\b",
    r"\bplacebo-controlled\s+trial\b",
    r"\btrial\s+report\b",
    r"\bphase\s+(?:ii|iii|2|3)(?:\s+\w+){0,4}\s+trial\b",
)

_TRIAL_REPORT_JOURNAL_TERMS = (
    "n engl j med",
    "new england journal of medicine",
    "jama",
    "lancet",
    "bmj",
    "ann intern med",
    "circulation",
    "eur heart j",
)

_NON_NUMERIC_EFFECT_SOURCE_TERMS = (
    "systematic review",
    "meta-analysis",
    "network meta-analysis",
    "guideline",
    "guidelines",
    "recommendation",
    "recommendations",
    "editorial",
    "comment",
    "letter",
    "protocol",
    "rationale and design",
)

_THERAPEUTIC_AGENT_OR_CLASS_TERMS = (
    "dapagliflozin",
    "empagliflozin",
    "canagliflozin",
    "ertugliflozin",
    "sotagliflozin",
    "sglt2",
    "sglt-2",
    "gliflozin",
    "corticosteroid",
    "corticosteroids",
    "dexamethasone",
    "hydrocortisone",
    "remdesivir",
    "tocilizumab",
    "baricitinib",
    "semaglutide",
    "tirzepatide",
    "liraglutide",
)

_DRUG_LIKE_TOKEN_PATTERN = re.compile(
    r"\b[a-z][a-z0-9-]{4,}(?:glutide|flozin|mab|nib|vir|statin|pril|sartan|olol|ciclib)\b",
    flags=re.I,
)

_CLINICAL_CONDITION_TERMS = (
    "patients",
    "adults",
    "heart failure",
    "preserved ejection fraction",
    "mildly reduced",
    "covid",
    "diabetes",
    "mortality",
    "cardiovascular outcomes",
    "outcomes",
    "obesity",
    "kidney disease",
    "renal",
    "stroke",
    "myocardial infarction",
    "hospitalization",
    "hospitalisation",
)


def reference_entry_source_types(reference_text: str) -> set[str]:
    """Classify a numbered reference entry into source roles used by audits.

    The classifier is intentionally conservative and role-based: downstream
    code asks for source roles such as ``clinical_guideline`` or
    ``certainty_framework`` instead of re-implementing title keyword checks in
    each audit path.
    """
    lower = str(reference_text or "").lower()
    roles: set[str] = set()
    if _looks_like_numeric_effect_source_lower(lower):
        roles.update({"included_trial", "trial_report", "clinical_trial"})
        if any(term in lower for term in _REGISTRY_TERMS) or re.search(r"\bnct\d{8}\b", lower):
            roles.add("registry_results")
    if re.search(r"\bprisma\b|preferred reporting items", lower, flags=re.I):
        roles.add("reporting_guideline")
    if re.search(r"\bcochrane\s+(?:handbook|methods?|guidance)\b", lower, flags=re.I):
        roles.add("methods_handbook")
    if re.search(r"\b(?:risk[-\s]+of[-\s]+bias|rob\s*2?)\b", lower, flags=re.I):
        roles.add("risk_of_bias_tool")
    if re.search(r"\bgrade\b|certainty\s+of\s+evidence|quality\s+of\s+evidence", lower, flags=re.I):
        roles.add("certainty_framework")
    if re.search(
        r"\bdersimonian\b|\blaird\b|\breml\b|hartung[-\s]+knapp|paule[-\s]+mandel|"
        r"\bcochran(?:'s)?\s+q\b|\bi(?:²|2)\b|\btau(?:²|2)?\b|random[-\s]+effects?|fixed[-\s]+effects?",
        lower,
        flags=re.I,
    ):
        roles.add("statistical_method")
    if re.search(r"\begger\b|\bbegg\b|funnel\s+plot|publication\s+bias|trim[-\s]+and[-\s]+fill", lower, flags=re.I):
        roles.add("publication_bias_method")
    if re.search(r"\b(?:systematic\s+review|meta[-\s]+analysis|network\s+meta[-\s]+analysis)\b", lower, flags=re.I):
        roles.update({"prior_review", "systematic_review"})
    if _looks_like_clinical_guideline_lower(lower):
        roles.update({"clinical_guideline", "guideline"})
    if re.search(r"\b(?:burden|prevalence|incidence|epidemiology|morbidity|mortality|global|worldwide)\b", lower, flags=re.I):
        roles.add("pubmed_background")
    return roles


def _looks_like_clinical_guideline_lower(lower: str) -> bool:
    if "guideline" not in lower and "guidelines" not in lower and "recommendation" not in lower:
        return False
    if "grade guideline" in lower or "grade guidelines" in lower:
        return False
    clinical_markers = (
        "clinical practice",
        "management of",
        "treatment",
        "heart failure",
        "diabetes",
        "covid",
        "surviving sepsis",
        "aha/acc",
        "hfsa",
        "esc",
        "nice",
        "who",
    )
    return any(marker in lower for marker in clinical_markers)


def reference_entry_looks_like_numeric_effect_source(reference_text: str) -> bool:
    """Return True for references likely to be original trial/registry source reports.

    Many high-impact trial reports do not put "randomized trial" in the title
    line. For example, NEJM trial titles can be terse drug-in-disease phrases
    such as "Dapagliflozin in Heart Failure...". This helper keeps explicit
    registry/trial detection, then adds a conservative high-impact-journal
    heuristic requiring both an intervention/drug-class term and a clinical
    population/outcome term.
    """
    return _looks_like_numeric_effect_source_lower(str(reference_text or "").lower())


def _looks_like_numeric_effect_source_lower(lower: str) -> bool:
    if any(term in lower for term in _REGISTRY_TERMS):
        return True
    if any(term in lower for term in _NON_NUMERIC_EFFECT_SOURCE_TERMS):
        return False
    if any(re.search(pattern, lower, flags=re.I) for pattern in _EXPLICIT_TRIAL_PATTERNS):
        return True
    if not any(term in lower for term in _TRIAL_REPORT_JOURNAL_TERMS):
        return False
    has_treatment = (
        any(term in lower for term in _THERAPEUTIC_AGENT_OR_CLASS_TERMS)
        or bool(_DRUG_LIKE_TOKEN_PATTERN.search(lower))
    )
    if not has_treatment:
        return False
    return any(term in lower for term in _CLINICAL_CONDITION_TERMS)
