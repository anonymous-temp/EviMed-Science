"""Topic modules composing the writing agent."""
from __future__ import annotations

from new_meta.agents.writing.citation_repair import CitationRepairMixin
from new_meta.agents.writing.grade_tables import GradeTablesMixin
from new_meta.agents.writing.semantic_review import SemanticReviewMixin
from new_meta.agents.writing.citation_grounding import CitationGroundingMixin
from new_meta.agents.writing.claim_map import ClaimMapMixin
from new_meta.agents.writing.fallback_reports import FallbackReportsMixin
from new_meta.agents.writing.publication_polish import PublicationPolishMixin
from new_meta.agents.writing.fallback_content import FallbackContentMixin
from new_meta.agents.writing.section_writers import SectionWritersMixin
from new_meta.agents.writing.consistency_guards import ConsistencyGuardsMixin

__all__ = ["CitationRepairMixin", "GradeTablesMixin", "SemanticReviewMixin", "CitationGroundingMixin", "ClaimMapMixin", "FallbackReportsMixin", "PublicationPolishMixin", "FallbackContentMixin", "SectionWritersMixin", "ConsistencyGuardsMixin"]
