"""Drug-name normalization: free text -> generic (INN/USAN) name.

Pipeline:
1. rules — case/whitespace cleanup, strength and dosage-form stripping,
   salt/ester suffix stripping ("atorvastatin calcium" -> "atorvastatin"),
   a curated brand->generic map ("Lipitor" -> "atorvastatin");
2. openFDA validation — when an :class:`OpenFDAClient` is available, rule
   candidates are checked against real FAERS counts / label records, which
   both validates the guess and yields ranked candidates;
3. LLM fallback — a seam only: pass any object implementing
   ``async suggest_generic_name(query) -> str | None``. Not implemented in
   this phase (P4 wires DeepSeek); without it the layer is fully
   deterministic.
"""

from __future__ import annotations

import re
from typing import Protocol

from safety_agent.core.exceptions import NoResults, OpenFDAError
from safety_agent.core.logging import get_logger

from .types import NormalizationCandidate, NormalizationResult

logger = get_logger(__name__)

#: Trailing salt / ester / hydrate tokens stripped by rule. Longest first so
#: multi-token matches win; applied repeatedly ("... hydrochloride monohydrate").
_SALT_TOKENS = sorted(
    {
        "hydrochloride", "hydrobromide", "hydroiodide", "sulfate", "sulphate",
        "mesylate", "mesilate", "besylate", "besilate", "tosylate", "esilate",
        "tartrate", "bitartrate", "citrate", "maleate", "succinate", "fumarate",
        "phosphate", "diphosphate", "acetate", "nitrate", "chloride", "bromide",
        "sodium", "potassium", "calcium", "magnesium", "zinc", "lithium",
        "meglumine", "tromethamine", "trometamol", "arginine", "lysinate",
        "pamoate", "stearate", "valerate", "propionate", "enanthate", "cypionate",
        "monohydrate", "dihydrate", "trihydrate", "hemihydrate", "sesquihydrate",
        "anhydrous", "hcl", "hbr", "sod", "pot", "calc",
    },
    key=len,
    reverse=True,
)

#: Dosage-form / release tokens stripped from anywhere in the string.
_FORM_TOKENS = {
    "tablet", "tablets", "tab", "tabs", "capsule", "capsules", "cap", "caps",
    "injection", "injectable", "infusion", "solution", "suspension", "syrup",
    "cream", "ointment", "gel", "lotion", "patch", "patches", "spray", "drops",
    "powder", "sachet", "suppository", "inhaler", "aerosol", "film", "vial",
    "oral", "chewable", "effervescent", "delayed-release", "extended-release",
    "sustained-release", "modified-release", "er", "sr", "xl", "xr", "cr",
    "dr", "la", "cd", "od",
}

_STRENGTH_RE = re.compile(
    r"\b\d+(?:\.\d+)?\s?(?:mg|mcg|µg|ug|g|kg|ml|l|iu|iu/ml|mg/ml|units?|%)\b",
    re.IGNORECASE,
)
_PARENS_RE = re.compile(r"\([^)]*\)")

#: Curated brand -> generic map (lower-case keys). openFDA label lookup
#: covers the long tail when a client is available; this table makes the
#: common cases work offline.
BRAND_TO_GENERIC: dict[str, str] = {
    # statins / cardiovascular
    "lipitor": "atorvastatin", "crestor": "rosuvastatin", "zocor": "simvastatin",
    "mevacor": "lovastatin", "pravachol": "pravastatin", "lescol": "fluvastatin",
    "livalo": "pitavastatin", "plavix": "clopidogrel", "norvasc": "amlodipine",
    "cozaar": "losartan", "diovan": "valsartan", "micardis": "telmisartan",
    "avapro": "irbesartan", "lasix": "furosemide", "xarelto": "rivaroxaban",
    "eliquis": "apixaban", "pradaxa": "dabigatran", "coumadin": "warfarin",
    "jantoven": "warfarin",
    # metabolic
    "glucophage": "metformin", "januvia": "sitagliptin",
    # psychiatry / neurology
    "prozac": "fluoxetine", "zoloft": "sertraline", "paxil": "paroxetine",
    "lexapro": "escitalopram", "celexa": "citalopram", "effexor": "venlafaxine",
    "cymbalta": "duloxetine", "xanax": "alprazolam", "valium": "diazepam",
    "ativan": "lorazepam", "ambien": "zolpidem", "seroquel": "quetiapine",
    "zyprexa": "olanzapine", "risperdal": "risperidone", "abilify": "aripiprazole",
    "depakote": "divalproex sodium", "lamictal": "lamotrigine",
    "topamax": "topiramate", "neurontin": "gabapentin", "lyrica": "pregabalin",
    "dilantin": "phenytoin", "tegretol": "carbamazepine",
    # gastroenterology
    "nexium": "esomeprazole", "prilosec": "omeprazole", "protonix": "pantoprazole",
    # respiratory / allergy
    "singulair": "montelukast", "ventolin": "albuterol", "proventil": "albuterol",
    # urology / men's health
    "flomax": "tamsulosin", "viagra": "sildenafil", "cialis": "tadalafil",
    # analgesics / rheumatology
    "tylenol": "acetaminophen", "advil": "ibuprofen", "motrin": "ibuprofen",
    "aleve": "naproxen", "celebrex": "celecoxib",
    # anti-infectives
    "zithromax": "azithromycin", "amoxil": "amoxicillin", "cipro": "ciprofloxacin",
    "levaquin": "levofloxacin", "flagyl": "metronidazole", "diflucan": "fluconazole",
    # biologics
    "humira": "adalimumab", "enbrel": "etanercept", "remicade": "infliximab",
    "rituxan": "rituximab", "mabthera": "rituximab", "herceptin": "trastuzumab",
    "avastin": "bevacizumab",
    # endocrine
    "synthroid": "levothyroxine", "levoxyl": "levothyroxine",
}


class DrugNameLLMFallback(Protocol):
    """LLM seam for unresolvable names. Wired to DeepSeek in P4."""

    async def suggest_generic_name(self, query: str) -> str | None: ...


def _basic_clean(query: str) -> str:
    text = _PARENS_RE.sub(" ", query)
    text = _STRENGTH_RE.sub(" ", text)
    text = re.sub(r"[,;:/]", " ", text)
    return " ".join(text.lower().split())


def _strip_form_tokens(text: str) -> str:
    tokens = [t for t in text.split() if t not in _FORM_TOKENS]
    return " ".join(tokens)


def _strip_salt_suffixes(text: str) -> str:
    tokens = text.split()
    changed = True
    while changed and len(tokens) > 1:
        changed = False
        if tokens[-1] in _SALT_TOKENS:
            remainder = tokens[:-1]
            # Guard: never strip down to a bare element/salt word —
            # "potassium chloride" is itself a drug, not a salt form.
            if len(remainder) == 1 and remainder[0] in _SALT_TOKENS:
                break
            tokens = remainder
            changed = True
    return " ".join(tokens)


def rule_candidates(query: str) -> list[str]:
    """De-duplicated generic-name guesses, most-processed form first."""
    cleaned = _basic_clean(query)
    form_stripped = _strip_form_tokens(cleaned)
    fully_stripped = _strip_salt_suffixes(form_stripped)
    variants: list[str] = []
    for candidate in (fully_stripped, form_stripped, cleaned):
        if candidate and candidate not in variants:
            variants.append(candidate)
    return variants


async def normalize_drug(
    query: str,
    *,
    client: "object | None" = None,
    llm_fallback: DrugNameLLMFallback | None = None,
) -> NormalizationResult:
    """Normalize a free-text drug name.

    ``client`` is an OpenFDAClient (typed loosely to keep the layer
    importable without httpx). Offline behavior stays deterministic; an
    unreachable openFDA degrades confidence but never raises.
    """
    raw = query or ""
    cleaned = _basic_clean(raw)
    if not cleaned:
        return NormalizationResult(
            query=raw, normalized=None, candidates=[], confidence=0.0, method="empty"
        )

    candidates: list[NormalizationCandidate] = []
    normalized: str | None = None
    confidence = 0.0
    method = "unresolved"

    # 1) brand-name map, on the full cleaned string or its form-stripped form
    brand_hit = BRAND_TO_GENERIC.get(cleaned) or BRAND_TO_GENERIC.get(
        _strip_form_tokens(cleaned)
    )
    if brand_hit is not None:
        candidates.append(NormalizationCandidate(term=brand_hit, source="brand-map", score=0.95))

    # 2) rule variants: most-processed guess first. Without openFDA
    #    validation a rule guess is plausible-but-unconfirmed, so its score
    #    stays below the 0.8 line that suppresses the LLM fallback.
    for i, variant in enumerate(rule_candidates(raw)):
        if all(c.term != variant for c in candidates):
            score = max(0.5, 0.75 - 0.1 * i)
            candidates.append(NormalizationCandidate(term=variant, source="rule", score=score))

    # 3) openFDA validation / enrichment (optional, failure-tolerant)
    if client is not None:
        normalized, confidence, method = await _validate_with_openfda(
            candidates, client
        )

    if normalized is None:
        if candidates:
            best = candidates[0]
            normalized, confidence, method = best.term, best.score, best.source
        else:
            normalized, confidence, method = cleaned, 0.3, "rule-passthrough"

    # 4) LLM fallback seam: only when nothing reached validation-grade
    #    confidence (>= 0.8). Advisory only — failures are logged and
    #    ignored, never propagated. For CJK queries the rules cannot
    #    resolve the name at all, so a *validated* LLM translation becomes
    #    the normalized form; without validation the original text stands
    #    and the pipeline keeps its explicit NoData semantics.
    if confidence < 0.8 and llm_fallback is not None:
        try:
            suggestion = await llm_fallback.suggest_generic_name(cleaned)
        except Exception as exc:  # LLM is advisory; degradation must be visible
            logger.warning("LLM drug-name fallback failed: %s", exc)
            suggestion = None
        if suggestion:
            suggestion = " ".join(suggestion.lower().split())
            if suggestion and all(c.term != suggestion for c in candidates):
                candidates.append(
                    NormalizationCandidate(term=suggestion, source="llm-fallback", score=0.4)
                )
            if suggestion and contains_cjk(cleaned):
                upgraded = await _upgrade_cjk_suggestion(suggestion, client)
                if upgraded is not None:
                    normalized, confidence, method = upgraded

    candidates.sort(key=lambda c: c.score, reverse=True)
    return NormalizationResult(
        query=raw,
        normalized=normalized,
        candidates=candidates,
        confidence=round(confidence, 4),
        method=method,
    )


_CJK_RE = re.compile(r"[㐀-䶿一-鿿]")


def contains_cjk(text: str) -> bool:
    """True when the string carries CJK characters."""
    return bool(_CJK_RE.search(text))


async def _upgrade_cjk_suggestion(
    suggestion: str, client: "object | None"
) -> tuple[str, float, str] | None:
    """Promote an LLM translation to the normalized form when confirmed.

    With an openFDA client, confirmation means the translated name actually
    has FAERS reports; offline, the translation is accepted at low
    confidence. Returns None when nothing can be confirmed — the caller
    then keeps the original (unresolvable) text.
    """
    if client is None:
        return suggestion, 0.5, "llm-fallback"
    from safety_agent.openfda.queries import drug_clause

    try:
        total = await client.count_total(drug_clause(suggestion))
    except NoResults:
        logger.info("LLM suggestion %r not found on openFDA; keeping original", suggestion)
        return None
    except OpenFDAError as exc:
        logger.warning("openFDA validation of LLM suggestion failed: %s", exc)
        return None
    if total > 0:
        return suggestion, 0.7, "llm-fallback+openfda"
    return None


async def _validate_with_openfda(
    candidates: list[NormalizationCandidate],
    client: "object",
) -> tuple[str | None, float, str]:
    """Check rule candidates against FAERS counts and label records.

    Returns (normalized, confidence, method); (None, 0.0, "unresolved") when
    openFDA rejected every candidate. Network/server failures degrade to
    "no validation" with a warning instead of raising.
    """
    from safety_agent.openfda.queries import drug_clause

    if not hasattr(client, "count_total") or not hasattr(client, "search_labels"):
        raise TypeError("client must implement the OpenFDAClient interface")
    for candidate in list(candidates)[:5]:
        try:
            total = await client.count_total(drug_clause(candidate.term))
        except NoResults:
            continue
        except OpenFDAError as exc:
            logger.warning("openFDA validation unavailable: %s", exc)
            break
        if total > 0:
            boosted = min(0.99, candidate.score + 0.1)
            candidate.score = round(boosted, 4)
            candidate.source = candidate.source + "+openfda"
            return candidate.term, boosted, candidate.source
    # Rule guesses found nothing: ask the label endpoint for the generic name.
    probe = candidates[0].term if candidates else ""
    if probe:
        try:
            labels = await client.search_labels(drug=probe, limit=3)
        except NoResults:
            labels = []
        except OpenFDAError as exc:
            logger.warning("openFDA label lookup unavailable: %s", exc)
            labels = []
        for label in labels:
            for generic in label.generic_names:
                term = generic.lower()
                if all(c.term != term for c in candidates):
                    candidates.append(
                        NormalizationCandidate(term=term, source="openfda-label", score=0.7)
                    )
                    return term, 0.7, "openfda-label"
    return None, 0.0, "unresolved"
