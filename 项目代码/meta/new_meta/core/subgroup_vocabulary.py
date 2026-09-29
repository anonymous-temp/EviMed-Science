"""The protocol's prespecified subgroup variables as a closed vocabulary.

A subgroup analysis compares contrasts by what distinguishes them - a route, a
dose, a population. Which route a contrast gives is a language judgment;
grouping the extractor's own wording is not one. On 2026-09-28 (ma-001,
production job meta-20260928185649) the protocol prespecified "Route of
tranexamic acid administration (intravenous vs topical vs combined)" and the
design-aware engine grouped contrasts by their free-text subgroup labels: two
trials giving the same topical route ("Topical (intra-articular) route",
"Topical (intra-articular) TXA") became two one-study labels, nothing was
pooled and no route was compared.

So the values are fixed once per protocol, before extraction. One model call
reads the protocol's own wording and proposes, for each subgroup variable,
2-8 short values with a one-line definition; code checks what it can (one
entry per protocol variable, its text verbatim, well-formed unique values
within bounds, ``not_reported`` never proposed) and appends the reserved
``not_reported`` to every variable. Variable ids are code's, derived from the
protocol text. The artefact is bound to the protocol fingerprint: a resumed
run reuses it, a changed protocol derives it again. The extractor assigns each
contrast exactly one value per variable, a value outside the vocabulary is
refused, and the engines group by the closed value.
"""
from __future__ import annotations

import re
from typing import Any, Callable, Literal

from pydantic import BaseModel, Field

from new_meta.core.llm_retry import (
    StageOutputUnusable,
    bounded_output_call,
    clear_stage_failure,
    record_exhausted,
    strict_suffix,
)
from new_meta.schemas.study import SUBGROUP_NOT_REPORTED, SUBGROUP_TOKEN_MAX_LENGTH, _subgroup_token

STAGE = "subgroup_vocabulary"
ENTITY_ID = "protocol"
VOCABULARY_FILE = "subgroup_vocabulary.json"
VOCABULARY_SUBDIR = "extraction"
MIN_VALUES = 2
MAX_VALUES = 8
MAX_DEFINITION_LENGTH = 300
_VARIABLE_ID_LENGTH = 40
#: What a reader is told when a variable has no closed values to group by.
NO_CLOSED_VALUES = "no closed subgroup values"
NOT_RUN_CONSEQUENCE = "subgroup analysis not run: no closed subgroup values"


class SubgroupVocabularyRefused(ValueError):
    """The model's proposed vocabulary breaks a rule code can check; it is asked again."""


class ProposedSubgroupValue(BaseModel):
    value: str = Field(description=(
        "A short lowercase snake_case token (letters, digits and underscores, at most 40 characters), "
        "for example intravenous."))
    definition: str = Field(description=(
        "One line: what a comparison must have to take this value, in the protocol's own terms."))


class ProposedSubgroupVariable(BaseModel):
    protocol_text: str = Field(description="The protocol's subgroup variable, copied character for character.")
    values: list[ProposedSubgroupValue] = Field(description=(
        "2 to 8 mutually exclusive values covering the categories the protocol's wording distinguishes. "
        "Never a value for not reported or unclear: it is added for you."))


class SubgroupVocabularyProposal(BaseModel):
    variables: list[ProposedSubgroupVariable] = Field(description=(
        "Exactly one entry per prespecified subgroup variable, in any order."))


class SubgroupValue(BaseModel):
    value: str
    definition: str


class SubgroupVariable(BaseModel):
    variable_id: str
    protocol_text: str
    values: list[SubgroupValue]

    @property
    def value_tokens(self) -> list[str]:
        return [item.value for item in self.values]


class SubgroupVocabulary(BaseModel):
    schema_version: int = 1
    protocol_sha256: str
    status: Literal["derived", "unavailable"] = "derived"
    reason: str = ""
    variables: list[SubgroupVariable] = Field(default_factory=list)

    def allowed(self) -> dict[str, set[str]]:
        return {item.variable_id: set(item.value_tokens) for item in self.variables}


SUBGROUP_VOCABULARY_PROMPT = """A systematic review protocol prespecifies subgroup analyses. Before any paper is
read, fix for each subgroup variable the closed set of values that every
extracted comparison will be assigned to.

## Review protocol
- Research question: {research_question}
- Population: {population}
- Intervention: {intervention}
- Comparator: {comparator}
- Primary outcome: {primary_outcome}

## Prespecified subgroup variables
{variables}

For every variable above return one entry:
- protocol_text: the variable exactly as written above, character for character.
- values: 2 to 8 mutually exclusive values - the categories the protocol's own
  wording distinguishes (a variable written "route (intravenous vs topical vs
  combined)" has the values intravenous, topical and combined). Each value is a
  short lowercase snake_case token (letters, digits, underscores; at most 40
  characters) with a one-line definition stating what a comparison must have to
  take that value, so that a reader of any paper, in any language or wording,
  assigns the same value. Cover every category the protocol names; add no
  category it does not imply.
- Never add a value meaning "not reported", "unclear" or "other/unknown": the
  reserved value not_reported is added to every variable for you.
"""


def protocol_subgroup_variables(protocol) -> list[str]:
    """The protocol's subgroup variables, blank entries left out, in protocol order."""
    return [str(item).strip() for item in (getattr(protocol, "subgroup_variables", None) or []) if str(item).strip()]


def variable_ids(texts: list[str]) -> list[str]:
    """Stable, unique, readable ids for protocol subgroup variables, assigned by code.

    A slug of the protocol text cut at a word boundary; a text without Latin
    letters or digits (a Chinese protocol) is numbered. Equal slugs are
    numbered apart, so the same protocol always gives the same ids.
    """
    ids: list[str] = []
    for position, text in enumerate(texts, start=1):
        words = re.findall(r"[a-z0-9]+", text.casefold())
        slug = ""
        for word in words:
            candidate = f"{slug}_{word}" if slug else word
            if len(candidate) > _VARIABLE_ID_LENGTH:
                break
            slug = candidate
        if not slug or not slug[0].isalpha():
            slug = f"subgroup_{position}" if not slug else f"subgroup_{slug}"[:_VARIABLE_ID_LENGTH].rstrip("_")
        unique, suffix = slug, 2
        while unique in ids:
            unique, suffix = f"{slug}_{suffix}", suffix + 1
        ids.append(unique)
    return ids


def vocabulary_prompt(protocol) -> str:
    texts = protocol_subgroup_variables(protocol)
    return SUBGROUP_VOCABULARY_PROMPT.format(
        research_question=protocol.research_question,
        population=protocol.pico.population,
        intervention=protocol.pico.intervention,
        comparator=protocol.pico.comparator,
        primary_outcome=protocol.pico.outcome_primary,
        variables="\n".join(f"- {text}" for text in texts),
    )


def validated_vocabulary(proposal: SubgroupVocabularyProposal | dict, protocol) -> SubgroupVocabulary:
    """Check what code can of a proposed vocabulary; raise SubgroupVocabularyRefused otherwise."""
    from new_meta.core.primary_analysis_alignment import protocol_fingerprint

    if not isinstance(proposal, SubgroupVocabularyProposal):
        proposal = SubgroupVocabularyProposal.model_validate(proposal)
    texts = protocol_subgroup_variables(protocol)
    ids = dict(zip(texts, variable_ids(texts)))
    by_text: dict[str, ProposedSubgroupVariable] = {}
    for item in proposal.variables:
        text = " ".join(item.protocol_text.split())
        match = next((original for original in texts if " ".join(original.split()) == text), None)
        if match is None:
            raise SubgroupVocabularyRefused(f"not a protocol subgroup variable, verbatim: {item.protocol_text!r}")
        if match in by_text:
            raise SubgroupVocabularyRefused(f"subgroup variable given more than once: {match!r}")
        by_text[match] = item
    missing = [text for text in texts if text not in by_text]
    if missing:
        raise SubgroupVocabularyRefused(f"subgroup variable(s) without values: {missing!r}")
    variables = []
    for text in texts:
        proposed = by_text[text].values
        if not MIN_VALUES <= len(proposed) <= MAX_VALUES:
            raise SubgroupVocabularyRefused(
                f"{text!r} has {len(proposed)} value(s); {MIN_VALUES} to {MAX_VALUES} are required")
        values = []
        for item in proposed:
            token = _subgroup_token(item.value)
            if not token or len(token) > _VARIABLE_ID_LENGTH:
                raise SubgroupVocabularyRefused(f"{text!r}: {item.value!r} is not a short snake_case token")
            if token == SUBGROUP_NOT_REPORTED:
                raise SubgroupVocabularyRefused(f"{text!r}: {SUBGROUP_NOT_REPORTED} is reserved and added by code")
            if token in {value.value for value in values}:
                raise SubgroupVocabularyRefused(f"{text!r}: value {token!r} is given more than once")
            definition = item.definition.strip()
            if not definition or "\n" in definition or len(definition) > MAX_DEFINITION_LENGTH:
                raise SubgroupVocabularyRefused(f"{text!r}: value {token!r} needs a one-line definition")
            values.append(SubgroupValue(value=token, definition=definition))
        values.append(SubgroupValue(value=SUBGROUP_NOT_REPORTED,
                                    definition="The source does not say which value this comparison has."))
        variables.append(SubgroupVariable(variable_id=ids[text], protocol_text=text, values=values))
    return SubgroupVocabulary(protocol_sha256=protocol_fingerprint(protocol), variables=variables)


def load_subgroup_vocabulary(project, protocol) -> SubgroupVocabulary | None:
    """The derived vocabulary of exactly this protocol, or None."""
    from new_meta.core.primary_analysis_alignment import protocol_fingerprint

    if project is None or not protocol_subgroup_variables(protocol):
        return None
    try:
        payload = project.load_json(VOCABULARY_FILE, subdir=VOCABULARY_SUBDIR)
        vocabulary = SubgroupVocabulary.model_validate(payload) if payload else None
    except (OSError, ValueError, TypeError):
        return None
    if (vocabulary is None or vocabulary.status != "derived"
            or vocabulary.protocol_sha256 != protocol_fingerprint(protocol)
            or [item.protocol_text for item in vocabulary.variables] != protocol_subgroup_variables(protocol)):
        return None
    return vocabulary


def ensure_subgroup_vocabulary(
    project, protocol, ask: Callable[[str, type[BaseModel]], Any], *, log: Callable[[str], Any] | None = None,
) -> SubgroupVocabulary | None:
    """Derive (or reuse) the protocol's closed subgroup vocabulary before extraction.

    ``ask(prompt, schema)`` is one structured model call. No subgroup
    variables, no call. When every bounded attempt is unusable the failure is
    recorded with its consequence and extraction goes on with no vocabulary:
    no contrast gets a closed value, and every subgroup analysis reports that
    it was not run for want of closed values.
    """
    from new_meta.core.primary_analysis_alignment import protocol_fingerprint

    if not protocol_subgroup_variables(protocol):
        return None
    saved = load_subgroup_vocabulary(project, protocol)
    if saved is not None:
        return saved
    prompt = vocabulary_prompt(protocol)

    def call(attempt: int) -> SubgroupVocabulary:
        return validated_vocabulary(ask(prompt + strict_suffix(attempt), SubgroupVocabularyProposal), protocol)

    try:
        vocabulary = bounded_output_call(call, stage=STAGE, entity_id=ENTITY_ID, log=log)
    except StageOutputUnusable as exc:
        last = exc.last_error
        record_exhausted(project, exc, consequence=NOT_RUN_CONSEQUENCE,
                         detail={"last_error": str(last)[:500]} if last is not None else None)
        project.save_json(VOCABULARY_FILE, SubgroupVocabulary(
            protocol_sha256=protocol_fingerprint(protocol), status="unavailable", reason=NOT_RUN_CONSEQUENCE,
        ), subdir=VOCABULARY_SUBDIR)
        return None
    clear_stage_failure(project, STAGE, ENTITY_ID)
    project.save_json(VOCABULARY_FILE, vocabulary, subdir=VOCABULARY_SUBDIR)
    return vocabulary


def admit_subgroup_values(values: dict[str, str] | None,
                          vocabulary: SubgroupVocabulary | None) -> tuple[dict[str, str], list[dict[str, str]]]:
    """Keep a known variable's in-vocabulary value; refuse (never guess) the rest."""
    allowed = vocabulary.allowed() if vocabulary is not None else {}
    kept: dict[str, str] = {}
    refused: list[dict[str, str]] = []
    for variable, value in (values.items() if isinstance(values, dict) else ()):
        if not isinstance(variable, str) or not isinstance(value, str):
            refused.append({"variable_id": str(variable), "value": str(value), "reason": "malformed"})
        elif variable not in allowed:
            refused.append({"variable_id": variable, "value": value, "reason": "unknown_variable"})
        elif value not in allowed[variable]:
            refused.append({"variable_id": variable, "value": value, "reason": "value_outside_vocabulary"})
        else:
            kept[variable] = value
    return kept, refused


def extraction_prompt_block(vocabulary: SubgroupVocabulary | None) -> str:
    """The closed variables as the outcome extraction prompt lists them."""
    if vocabulary is None or not vocabulary.variables:
        return "None. Leave subgroup_values empty."
    lines = []
    for variable in vocabulary.variables:
        lines.append(f"- {variable.variable_id} (\"{variable.protocol_text}\"):")
        lines.extend(f"    - {item.value}: {item.definition}" for item in variable.values)
    return "\n".join(lines)


def engine_subgroup_variables(protocol, vocabulary: SubgroupVocabulary | None) -> list[dict[str, Any]]:
    """Every protocol subgroup variable as an engine takes it: id, protocol text, closed values.

    A variable without a derived vocabulary has no values, and the engine
    reports it as not analysed for want of closed values.
    """
    if vocabulary is not None:
        return [{"variable_id": item.variable_id, "label": item.protocol_text, "values": item.value_tokens}
                for item in vocabulary.variables]
    texts = protocol_subgroup_variables(protocol)
    return [{"variable_id": variable_id, "label": text, "values": []}
            for variable_id, text in zip(variable_ids(texts), texts)]


def selected_row_subgroup_values(project, extracted_studies, vocabulary: SubgroupVocabulary | None) -> dict[str, dict[str, str]]:
    """Per study id, the admitted closed values of the row its primary effect came from.

    The pairwise path pools one effect per study; which row it came from is
    the effect-selection audit's (row selected within its study and in the
    final primary analysis).
    """
    if vocabulary is None or project is None:
        return {}
    audit = project.load_json("effect_selection_audit.json", subdir="analysis") or []
    studies = {str(study.characteristics.pmid or study.characteristics.study_id or study.characteristics.doi or ""): study
               for study in extracted_studies or []}
    values: dict[str, dict[str, str]] = {}
    for row in audit if isinstance(audit, list) else []:
        if not isinstance(row, dict) or not row.get("in_final_primary_analysis"):
            continue
        study = studies.get(str(row.get("study_id") or ""))
        index = row.get("outcome_index")
        if study is None or not isinstance(index, int) or not 0 <= index < len(study.outcomes):
            continue
        kept, _ = admit_subgroup_values(study.outcomes[index].subgroup_values, vocabulary)
        values[str(row["study_id"])] = kept
    return values


__all__ = [
    "ENTITY_ID", "MAX_VALUES", "MIN_VALUES", "NOT_RUN_CONSEQUENCE", "NO_CLOSED_VALUES", "STAGE",
    "SUBGROUP_NOT_REPORTED", "SUBGROUP_TOKEN_MAX_LENGTH", "SubgroupValue", "SubgroupVariable",
    "SubgroupVocabulary", "SubgroupVocabularyProposal", "SubgroupVocabularyRefused", "VOCABULARY_FILE",
    "admit_subgroup_values", "engine_subgroup_variables", "ensure_subgroup_vocabulary",
    "extraction_prompt_block", "load_subgroup_vocabulary", "protocol_subgroup_variables",
    "selected_row_subgroup_values", "validated_vocabulary", "variable_ids", "vocabulary_prompt",
]
