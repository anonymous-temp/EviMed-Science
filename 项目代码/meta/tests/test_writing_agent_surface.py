"""The composed WritingAgent must not silently lose a mixin's work.

Ten mixins are combined by MRO. If two of them ever define the same name, the
later one simply disappears: no import error, no failing test, just a method
that stops running. The same goes for a contract other modules import from
this module's namespace. Both failures are invisible unless something counts.
"""
import inspect

import new_meta.agents.writing_agent as writing_agent
from new_meta.agents import writing
from new_meta.agents.writing_agent import WritingAgent


def _declared(cls) -> set[str]:
    return {name for name in vars(cls) if not name.startswith("__")}


def test_no_two_mixins_define_the_same_name() -> None:
    seen: dict[str, str] = {}
    collisions: list[str] = []
    for mixin in writing.__all__:
        cls = getattr(writing, mixin)
        for name in _declared(cls):
            if name in seen:
                collisions.append(f"{name}: {seen[name]} and {mixin}")
            seen[name] = mixin
    assert collisions == [], f"MRO would silently drop one of these: {collisions}"


def test_every_mixin_member_reaches_the_composed_class() -> None:
    for mixin in writing.__all__:
        cls = getattr(writing, mixin)
        for name in _declared(cls):
            assert hasattr(WritingAgent, name), f"{mixin}.{name} is not reachable on WritingAgent"
            assert inspect.getattr_static(WritingAgent, name) is inspect.getattr_static(cls, name), (
                f"{mixin}.{name} resolves to a different implementation on WritingAgent"
            )


def test_the_contracts_other_modules_import_stay_exported() -> None:
    # Tests and the pipeline construct these off this module's namespace.
    for name in (
        "WritingAgent",
        "ClaimMapAuthoredSections",
        "ClaimMapSectionDraft",
        "ClaimSourceAlignmentItem",
        "ClaimSourceAlignmentReview",
        "CitationGroundingRevision",
        "ClinicalManuscriptReview",
        "FinalManuscriptReadinessReview",
        "ManuscriptClaimItem",
        "ManuscriptClaimMap",
        "ManuscriptTitleCandidate",
        "SemanticGuardAdjudication",
        "SemanticManuscriptPatch",
        "SemanticManuscriptRevision",
        "SemanticParagraphRevision",
        "SemanticSubsectionRevision",
    ):
        assert hasattr(writing_agent, name), f"writing_agent no longer exports {name}"
