"""Shared contracts and thresholds for the writing agent modules."""
from __future__ import annotations

from pydantic import BaseModel, Field


PUBLICATION_CITATION_DENSITY_PER_1000 = 6.0
PUBLICATION_CITATION_MAX_DENSITY_PER_1000 = 35.0
PUBLICATION_CITATION_DENSITY_MIN_WORDS = 500
PUBLICATION_CITATION_MIN_UNIQUE_REFERENCES = 6
PUBLICATION_INTERPRETIVE_CITED_PARAGRAPH_RATE = 0.67
PUBLICATION_CITATION_MIN_SUBSTANTIAL_PARAGRAPH_WORDS = 35
PUBLICATION_SECTION_CONTEXT_MIN_REFERENCES = 2
PUBLICATION_CITATION_MECHANICAL_MIN_MARKERS = 3
PUBLICATION_CITATION_MECHANICAL_MAX_MARKERS_PER_35_UNITS = 1.5
PUBLICATION_DISCUSSION_MAX_UNITS_EN = 1800
PUBLICATION_DISCUSSION_MAX_UNITS_ZH = 4500
PUBLICATION_DISCUSSION_MAX_PROSE_PARAGRAPHS = 24
PUBLICATION_DISCUSSION_TARGET_PROSE_PARAGRAPHS = 14
PUBLICATION_DISCUSSION_MIN_UNITS_EN = 420
PUBLICATION_DISCUSSION_MIN_UNITS_ZH = 700
PUBLICATION_DISCUSSION_MIN_PROSE_PARAGRAPHS = 5


class SemanticManuscriptPatch(BaseModel):
    heading: str = Field(description="Exact H2 heading to replace, for example Introduction, Discussion, or Conclusion.")
    replacement_markdown: str = Field(description="Replacement body markdown for this H2 section, excluding the H2 heading.")
    reason: str = Field(default="", description="Short editorial reason for the replacement.")


class SemanticManuscriptRevision(BaseModel):
    summary: str = Field(default="", description="Brief summary of the editorial diagnosis.")
    patches: list[SemanticManuscriptPatch] = Field(default_factory=list)
    issues: list[str] = Field(default_factory=list)


class SemanticGuardAdjudication(BaseModel):
    accept: bool = Field(description="Whether the candidate is fact-preserving despite non-hard guard flags.")
    reason: str = Field(default="", description="Short reason for accepting or rejecting the candidate.")


class ClinicalManuscriptReviewIssue(BaseModel):
    heading: str = Field(default="", description="H2 section that should be improved.")
    severity: str = Field(default="major", description="minor, major, or critical.")
    problem: str = Field(default="", description="What reads weakly as a clinical manuscript.")
    revision_instruction: str = Field(default="", description="Actionable edit using only existing facts and citations.")
    evidence_basis: str = Field(default="", description="Which structured facts, study cards, or existing text justify the instruction.")


class ClinicalManuscriptReview(BaseModel):
    summary: str = Field(default="", description="Overall editorial diagnosis.")
    priority_issues: list[ClinicalManuscriptReviewIssue] = Field(default_factory=list)
    global_editing_instructions: list[str] = Field(default_factory=list)
    unsafe_to_fix_without_new_sources: list[str] = Field(default_factory=list)
    citation_or_source_concerns: list[str] = Field(default_factory=list)


class FinalManuscriptReadinessIssue(BaseModel):
    severity: str = Field(default="minor", description="minor, major, or critical.")
    section: str = Field(default="", description="Manuscript section or artifact affected.")
    problem: str = Field(default="", description="Concrete peer-review concern.")
    evidence: str = Field(default="", description="Current manuscript/facts evidence supporting the concern.")
    action: str = Field(default="", description="Specific next action needed.")
    requires_new_source: bool = Field(default=False, description="Whether the issue needs additional full text or references.")


class FinalManuscriptReadinessReview(BaseModel):
    decision: str = Field(default="minor_revision", description="ready, minor_revision, major_revision, or not_ready.")
    score: int = Field(default=0, description="0-100 readiness score for journal-style submission.")
    summary: str = Field(default="", description="Brief editor-style overall assessment.")
    strengths: list[str] = Field(default_factory=list)
    issues: list[FinalManuscriptReadinessIssue] = Field(default_factory=list)
    required_user_inputs: list[str] = Field(default_factory=list)
    citation_or_provenance_concerns: list[str] = Field(default_factory=list)
    safe_to_submit_without_human_review: bool = Field(default=False)


class ManuscriptTitleCandidate(BaseModel):
    title: str = Field(default="", description="Publication-style manuscript title.")
    rationale: str = Field(default="", description="Brief explanation of why the title fits the structured facts.")


class SemanticParagraphPatch(BaseModel):
    heading: str = Field(description="H2 section heading containing the paragraph.")
    paragraph_index: int = Field(description="One-based index of the target paragraph within the H2 section body.")
    replacement_markdown: str = Field(description="Replacement paragraph markdown. Preserve any original H3 heading line if present.")
    reason: str = Field(default="", description="Short editorial reason for this paragraph-level change.")


class SemanticParagraphRevision(BaseModel):
    summary: str = Field(default="", description="Brief paragraph-level editorial diagnosis.")
    patches: list[SemanticParagraphPatch] = Field(default_factory=list)
    issues: list[str] = Field(default_factory=list)


class SemanticSubsectionPatch(BaseModel):
    parent_heading: str = Field(description="H2 parent section heading.")
    subsection_heading: str = Field(description="H3 subsection heading.")
    replacement_markdown: str = Field(description="Replacement subsection body, excluding the H3 heading.")
    reason: str = Field(default="", description="Short editorial reason for this subsection-level change.")


class SemanticSubsectionRevision(BaseModel):
    summary: str = Field(default="", description="Brief subsection-level editorial diagnosis.")
    patches: list[SemanticSubsectionPatch] = Field(default_factory=list)
    issues: list[str] = Field(default_factory=list)


class CitationGroundingPatch(BaseModel):
    heading: str = Field(description="H2 section heading containing the paragraph.")
    paragraph_index: int = Field(description="One-based index of the target paragraph within the H2 section body.")
    replacement_markdown: str = Field(default="", description="Same paragraph with only justified existing reference markers added.")
    citation_numbers: list[int] = Field(default_factory=list, description="Reference numbers added or relied on by the patch.")
    reason: str = Field(default="", description="Why these citations support this paragraph.")


class CitationGroundingRevision(BaseModel):
    summary: str = Field(default="", description="Brief citation-grounding diagnosis.")
    patches: list[CitationGroundingPatch] = Field(default_factory=list)
    unsupported_claims: list[str] = Field(default_factory=list)


class ManuscriptClaimItem(BaseModel):
    id: str = Field(default="", description="Stable short identifier for this claim.")
    section: str = Field(default="", description="Target section: Introduction, Discussion, Conclusion, or supplement.")
    claim_type: str = Field(default="", description="objective, background, controversy, result, applicability, safety, limitation, or conclusion.")
    argument_step: str = Field(default="", description="Role in the clinical argument chain, for example clinical_problem, evidence_gap, objective, primary_finding, clinical_significance, endpoint_interpretation, applicability, evidence_limit, practice_implication, or future_research.")
    claim: str = Field(default="", description="Specific claim to write or consider.")
    support_source: str = Field(default="", description="Structured fact, study card, source quote, or reference that supports the claim.")
    source_study_id: str = ""
    source_location: str = ""
    source_quote: str = ""
    manuscript_use: str = Field(default="main", description="main, supplement, background, or exclude.")
    can_write_main_text: bool = True
    caveat: str = ""


class ManuscriptClaimMap(BaseModel):
    summary: str = ""
    claims: list[ManuscriptClaimItem] = Field(default_factory=list)
    excluded_or_deferred_claims: list[ManuscriptClaimItem] = Field(default_factory=list)
    clinical_argument_chain: list[str] = Field(default_factory=list, description="Ordered authoring arc from clinical problem through result interpretation to practice implication.")
    authoring_strategy: list[str] = Field(default_factory=list)


class ClaimSourceAlignmentItem(BaseModel):
    id: str = Field(default="", description="Claim id being reviewed.")
    decision: str = Field(default="accept", description="accept, revise, or exclude.")
    revised_claim: str = Field(default="", description="Revised claim text if decision is revise.")
    revised_caveat: str = Field(default="", description="Optional revised caveat.")
    reason: str = Field(default="", description="Why the claim-source alignment decision was made.")
    unsupported_phrases: list[str] = Field(default_factory=list)


class ClaimSourceAlignmentReview(BaseModel):
    summary: str = ""
    items: list[ClaimSourceAlignmentItem] = Field(default_factory=list)


class ClaimMapSectionDraft(BaseModel):
    heading: str = Field(description="H2 section heading to replace, for example Introduction, Results, Discussion, or Conclusion.")
    replacement_markdown: str = Field(description="Complete section body markdown, excluding the H2 heading.")
    claims_used: list[str] = Field(default_factory=list)
    rationale: str = ""


class ClaimMapAuthoredSections(BaseModel):
    summary: str = ""
    sections: list[ClaimMapSectionDraft] = Field(default_factory=list)
    unsupported_claims_not_used: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Language-aware section titles and labels
# ---------------------------------------------------------------------------
_EN_SECTIONS = {
    "abstract": "Abstract",
    "introduction": "Introduction",
    "methods": "Methods",
    "results": "Results",
    "discussion": "Discussion",
    "conclusion": "Conclusion",
    "supplementary": "Supplementary Materials",
    "prisma_checklist": "PRISMA 2020 Checklist",
    "tables": "Tables",
    "table1_title": "Table 1. Characteristics of Included Studies",
    "figures": "Figures",
    "figure_legends": "Figure Legends",
    "declarations": "Declarations",
    "references": "References",
    "ref_fallback": "See references.bib for full bibliography.",
}

_ZH_SECTIONS = {
    "abstract": "摘要",
    "introduction": "引言",
    "methods": "方法",
    "results": "结果",
    "discussion": "讨论",
    "conclusion": "结论",
    "supplementary": "补充材料",
    "prisma_checklist": "PRISMA 2020 清单",
    "tables": "表格",
    "table1_title": "表1. 纳入研究基本特征",
    "figures": "图表",
    "figure_legends": "图注",
    "declarations": "声明",
    "references": "参考文献",
    "ref_fallback": "完整参考文献见 references.bib。",
}
