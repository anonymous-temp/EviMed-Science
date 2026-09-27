"""The FAERS reaction-term vocabulary and its deterministic matcher.

The vocabulary is ``data/faers_reaction_terms.json``: every MedDRA Preferred
Term string openFDA returned from FAERS's reaction field when the file was
generated (``python -m safety_agent.normalize.build_vocabulary``), merged with
the curated PTs of ``adr_map``. It holds strings, never codes or hierarchy.

``VocabularyIndex.resolve`` answers one question: which vocabulary term is the
query, allowing only differences a rule can decide -- case, whitespace,
hyphens and apostrophes, American versus MedDRA (British) spelling, and a
singular or plural word. Every variant it tries is confirmed by membership in
the vocabulary, so an over-eager rule costs nothing: a variant that is not a
FAERS term is never used. When two different terms match at the same step the
query is ambiguous and nothing is chosen. Synonyms and lay language ("heart
racing") are not rules; they belong to the model path in ``adr.py``, whose
answer must itself resolve here or be confirmed by openFDA.
"""

from __future__ import annotations

import difflib
import json
import re
import unicodedata
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from safety_agent.core.logging import get_logger

logger = get_logger(__name__)

VOCABULARY_PATH = Path(__file__).resolve().parents[1] / "data" / "faers_reaction_terms.json"

_DASHES = dict.fromkeys(map(ord, "‐‑‒–—―−"), "-")
_QUOTES = dict.fromkeys(map(ord, "‘’ʼ`´"), "'")
_LOOSE_SEPARATORS = re.compile(r"[\s\-_/,]+")

#: American spelling -> the British form MedDRA PTs use. Applied as regexes to
#: the whole query; a result counts only if it is a vocabulary term.
_US_TO_UK: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pattern), replacement)
    for pattern, replacement in (
        (r"\bhem(?=[aeo])", "haem"),          # hemorrhage, hematuria, hemolysis
        (r"(?<=[b-df-hj-np-tv-z])emi(?=a|c)", "aemi"),  # anemia, ischemic, leukemia
        (r"\bedem", "oedem"),                 # edema, edematous
        (r"\besophag", "oesophag"),
        (r"\bestr(?=o|a|i)", "oestr"),        # estrogen, estradiol
        (r"\bfet(?=al|us|o)", "foet"),
        (r"\bfec(?=al|es|alo)", "faec"),
        (r"pnea\b", "pnoea"),                 # dyspnea, apnea, tachypnea
        (r"rrhea\b", "rrhoea"),               # diarrhea, rhinorrhea, amenorrhea
        (r"\bpediatr", "paediatr"),
        (r"\borthoped", "orthopaed"),
        (r"\banesthe", "anaesthe"),
        (r"\bgynec", "gynaec"),
        (r"\bcesarean", "caesarean"),
        (r"\bceliac", "coeliac"),
        (r"\btumor", "tumour"),
        (r"\bbehavior", "behaviour"),
        (r"\bcolor", "colour"),
        (r"\blabor\b", "labour"),
        (r"\bodor", "odour"),
        (r"\baluminum", "aluminium"),
        (r"(?<=[a-z])iz(?=e\b|ed\b|es\b|ing\b|ation)", "is"),  # hospitalization
    )
)

#: The few places FAERS keeps the American form a British writer would not.
_UK_TO_US: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pattern), replacement)
    for pattern, replacement in (
        (r"\bleuc(?=o)", "leuk"),             # leucocytosis -> leukocytosis
        (r"\bsulph", "sulf"),
    )
)


def canonical(text: str) -> str:
    """Unicode-, case- and whitespace-normalized form of one term."""
    value = unicodedata.normalize("NFKC", text or "").translate(_DASHES).translate(_QUOTES)
    value = " ".join(value.casefold().split())
    return value.strip(" .;:,!?\"")


def loose_key(text: str) -> str:
    """Key that ignores hyphens, slashes, commas, apostrophes and spacing."""
    return _LOOSE_SEPARATORS.sub(" ", canonical(text).replace("'", "")).strip()


def spelling_variants(term: str) -> list[str]:
    """The query rewritten US->UK (every rule, then each rule alone) and UK->US."""
    variants: list[str] = []
    for table in (_US_TO_UK, _UK_TO_US):
        combined = term
        for pattern, replacement in table:
            combined = pattern.sub(replacement, combined)
            single = pattern.sub(replacement, term)
            if single != term:
                variants.append(single)
        if combined != term:
            variants.insert(0, combined)
    return list(dict.fromkeys(variants))


def _word_inflections(word: str) -> list[str]:
    forms: list[str] = []
    if len(word) < 3 or not word.isalpha():
        return forms
    # plural -> singular
    if word.endswith("ies") and len(word) > 4:
        forms.append(word[:-3] + "y")
    if re.search(r"(?:s|x|z|sh|ch)es$", word):
        forms.append(word[:-2])
    if word.endswith("s") and not re.search(r"(?:ss|us|is)$", word):
        forms.append(word[:-1])
    # singular -> plural
    if re.search(r"[^aeiou]y$", word):
        forms.append(word[:-1] + "ies")
    elif re.search(r"(?:s|x|z|sh|ch)$", word):
        forms.append(word + "es")
    else:
        forms.append(word + "s")
    return forms


def inflection_variants(term: str) -> list[str]:
    """The term with one word switched between singular and plural."""
    words = term.split(" ")
    variants: list[str] = []
    # The last word first: "muscle spasm" -> "muscle spasms" is the common case.
    for index in sorted(range(len(words)), key=lambda i: i != len(words) - 1):
        for form in _word_inflections(words[index]):
            variants.append(" ".join([*words[:index], form, *words[index + 1 :]]))
    return list(dict.fromkeys(variants))


@dataclass(frozen=True)
class VocabularyMatch:
    term: str
    method: str  # pt-direct | pt-punctuation | pt-spelling | pt-inflection
    confidence: float


@dataclass(frozen=True)
class VocabularyAmbiguity:
    """Two or more vocabulary terms matched at the same step; none is chosen."""

    terms: tuple[str, ...]


class VocabularyIndex:
    """Membership and deterministic variant matching over the vocabulary."""

    def __init__(self, counts: Mapping[str, int], *, source: str = "", last_updated: str | None = None):
        self._counts = {canonical(term): max(0, int(count)) for term, count in counts.items() if canonical(term)}
        loose: dict[str, set[str]] = {}
        for term in self._counts:
            loose.setdefault(loose_key(term), set()).add(term)
        self._loose = {key: tuple(sorted(terms)) for key, terms in loose.items()}
        self._pool = sorted(self._counts, key=lambda term: (-self._counts[term], term))
        self.source = source
        self.last_updated = last_updated

    def __len__(self) -> int:
        return len(self._counts)

    def __contains__(self, term: object) -> bool:
        return isinstance(term, str) and canonical(term) in self._counts

    def count(self, term: str) -> int:
        return self._counts.get(canonical(term), 0)

    def _hits(self, variants: Iterable[str]) -> set[str]:
        hits: set[str] = set()
        for variant in variants:
            if variant in self._counts:
                hits.add(variant)
            else:
                hits.update(self._loose.get(loose_key(variant), ()))
        return hits

    def resolve(self, query: str) -> VocabularyMatch | VocabularyAmbiguity | None:
        term = canonical(query)
        if not term:
            return None
        if term in self._counts:
            return VocabularyMatch(term, "pt-direct", 1.0)
        spelled = spelling_variants(term)
        steps: tuple[tuple[str, float, list[str]], ...] = (
            ("pt-punctuation", 0.95, [term]),
            ("pt-spelling", 0.95, spelled),
            ("pt-inflection", 0.9, inflection_variants(term)),
            (
                "pt-inflection",
                0.85,
                [form for variant in spelled for form in inflection_variants(variant)],
            ),
        )
        for method, confidence, variants in steps:
            hits = self._hits(variants)
            if len(hits) == 1:
                return VocabularyMatch(next(iter(hits)), method, confidence)
            if len(hits) > 1:
                return VocabularyAmbiguity(tuple(sorted(hits, key=lambda t: (-self.count(t), t))))
        return None

    def candidates(self, query: str, *, limit: int = 5) -> list[tuple[str, float]]:
        """Near spellings and containing terms, for a person to choose from."""
        term = canonical(query)
        if not term:
            return []
        close = difflib.get_close_matches(term, self._pool, n=limit, cutoff=0.6)
        scored = [(match, round(difflib.SequenceMatcher(None, term, match).ratio(), 4)) for match in close]
        if len(term) >= 4:
            containing = [t for t in self._pool if term in t and t not in close][:limit]
            scored.extend((t, 0.5) for t in containing)
        return scored


def _read_document(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def load_vocabulary() -> VocabularyIndex:
    """The shipped vocabulary plus the curated PTs; loaded once per process."""
    from .adr_map import all_known_pts

    counts: dict[str, int] = {}
    source, last_updated = "", None
    try:
        document = _read_document(VOCABULARY_PATH)
        raw_terms = document.get("terms")
        if not isinstance(raw_terms, dict):
            raise ValueError("terms is not an object")
        counts.update({str(term): int(count) for term, count in raw_terms.items()})
        source = str(document.get("source") or "")
        last_updated = document.get("sourceLastUpdated")
    except (OSError, ValueError, TypeError) as exc:
        # The engine still runs on the curated PTs; the degradation is logged,
        # and the vocabulary test fails the build long before this happens.
        logger.error("FAERS reaction vocabulary unavailable (%s); curated PTs only", exc)
    for term in all_known_pts():
        counts.setdefault(term, 0)
    return VocabularyIndex(counts, source=source, last_updated=last_updated)
