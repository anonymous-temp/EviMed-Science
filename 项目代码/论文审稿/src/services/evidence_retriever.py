"""
Evidence Retriever - Three-stage evidence retrieval system
Stage 1: Structure-based retrieval (using section hints)
Stage 2: Semantic retrieval (using embeddings)
Stage 3: LLM fallback (full-text analysis)
"""
import re
import time
from typing import List, Optional, Dict, Any
from collections import defaultdict

from ..schemas.document_ir import DocumentIR, ParagraphIndex, SectionIndex
from ..schemas.rubric import RubricItem
from ..schemas.review_state import EvidenceSpan, RetrievalTrace
from ..services.llm_gateway import LLMGateway, ModelTier


class EvidenceRetriever:
    """
    Three-stage evidence retrieval system for finding relevant text in manuscripts.

    Stage 1: Structure-based retrieval using section hints
    Stage 2: Semantic retrieval using embeddings
    Stage 3: LLM fallback for full-text analysis
    """

    def __init__(self, llm_gateway: LLMGateway):
        """
        Initialize the evidence retriever.

        Args:
            llm_gateway: LLM gateway for semantic search and fallback
        """
        self.llm = llm_gateway
        self.synonym_map = self._build_synonym_map()

    def retrieve(
        self,
        item: RubricItem,
        document_ir: DocumentIR,
        evidence_map: Optional[Dict[str, Any]] = None,
        mode: str = "hybrid",
        score_threshold: float = 0.35
    ) -> tuple[List[EvidenceSpan], RetrievalTrace]:
        """
        Retrieve evidence for a rubric item using three-stage strategy.

        Args:
            item: Rubric item to find evidence for
            document_ir: Document intermediate representation
            evidence_map: Optional evidence map (legacy, may be None)
            mode: Retrieval mode ("hybrid", "structure_only", "semantic_only")
            score_threshold: Minimum score threshold for Stage 1+2

        Returns:
            Tuple of (evidence_spans, retrieval_trace)
        """
        start_time = time.time()
        all_evidence: List[EvidenceSpan] = []
        trace = RetrievalTrace()

        # Stage 1: Structure-based retrieval
        if mode in ["hybrid", "structure_only"]:
            stage1_evidence = self._stage1_structure_retrieval(item, document_ir)
            all_evidence.extend(stage1_evidence)
            trace.stage1_hits = len(stage1_evidence)

        # Stage 2: Semantic retrieval (if Stage 1 insufficient)
        if mode in ["hybrid", "semantic_only"]:
            best_score = max([e.score for e in all_evidence], default=0.0)
            if best_score < score_threshold:
                stage2_evidence = self._stage2_semantic_retrieval(item, document_ir)
                all_evidence.extend(stage2_evidence)
                trace.stage2_hits = len(stage2_evidence)

        # Stage 3: LLM fallback (if Stage 1+2 insufficient)
        if mode == "hybrid":
            best_score = max([e.score for e in all_evidence], default=0.0)
            if best_score < score_threshold:
                stage3_evidence = self._stage3_llm_fallback(item, document_ir)
                all_evidence.extend(stage3_evidence)
                trace.stage3_used = len(stage3_evidence) > 0

        # Deduplicate and sort by score
        all_evidence = self._deduplicate_evidence(all_evidence)
        all_evidence.sort(key=lambda e: e.score, reverse=True)

        # Update trace
        trace.total_candidates = len(all_evidence)
        trace.retrieval_time_ms = (time.time() - start_time) * 1000

        return all_evidence, trace

    def _stage1_structure_retrieval(
        self,
        item: RubricItem,
        document_ir: DocumentIR
    ) -> List[EvidenceSpan]:
        """
        Stage 1: Structure-based retrieval using section hints.

        Strategy:
        - Parse evidence_location_hint (e.g., "methods.randomization")
        - Try exact section match
        - Try fuzzy section title matching
        - Extract keywords and search within matched sections
        """
        evidence_spans: List[EvidenceSpan] = []
        hint = item.evidence_location_hint

        # Extract keywords from hint and item
        keywords = self._extract_keywords(hint, item)

        # Try to find matching sections
        candidate_sections = self._find_candidate_sections(hint, document_ir)

        # Search within candidate sections
        for section_name, section_obj in candidate_sections:
            section_text = self._extract_section_text(section_obj)

            # Search for keywords in section text
            for paragraph in section_text:
                if not paragraph.strip():
                    continue

                # Calculate relevance score based on keyword matches
                score = self._calculate_keyword_score(paragraph, keywords)

                if score > 0.3:  # Minimum threshold for structure-based
                    # Create evidence span
                    # Note: offset calculation is approximate if fulltext not available
                    evidence_spans.append(EvidenceSpan(
                        quote=paragraph[:500],  # Limit quote length
                        page=None,  # Will be populated if available
                        start_offset=0,  # Approximate
                        end_offset=len(paragraph),
                        section=section_name,
                        score=score,
                        method="structure"
                    ))

        return evidence_spans

    def _stage2_semantic_retrieval(
        self,
        item: RubricItem,
        document_ir: DocumentIR
    ) -> List[EvidenceSpan]:
        """
        Stage 2: Semantic retrieval using embeddings.

        Strategy:
        - Generate query from item.question + item.evaluation_criteria
        - Use paragraphs from document_ir (if available) or split fulltext
        - Calculate semantic similarity (using LLM or local embeddings)
        - Return top-k most relevant paragraphs
        """
        evidence_spans: List[EvidenceSpan] = []

        # Generate search query
        query = f"{item.question} {item.evaluation_criteria}"

        # Get paragraphs to search
        if document_ir.paragraphs:
            paragraphs = document_ir.paragraphs
        else:
            # Fallback: extract paragraphs from structured sections
            paragraphs = self._extract_all_paragraphs(document_ir)

        if not paragraphs:
            return evidence_spans

        # For now, use simple keyword-based similarity as fallback
        # TODO: Implement proper embedding-based search
        keywords = self._extract_keywords_from_query(query)

        for para in paragraphs[:100]:  # Limit to first 100 paragraphs for performance
            score = self._calculate_keyword_score(para.text if hasattr(para, 'text') else str(para), keywords)

            if score > 0.25:  # Lower threshold for semantic stage
                evidence_spans.append(EvidenceSpan(
                    quote=(para.text if hasattr(para, 'text') else str(para))[:500],
                    page=para.page if hasattr(para, 'page') else None,
                    start_offset=para.offset if hasattr(para, 'offset') else 0,
                    end_offset=(para.offset if hasattr(para, 'offset') else 0) + len(para.text if hasattr(para, 'text') else str(para)),
                    section=para.section if hasattr(para, 'section') else "unknown",
                    score=score * 0.9,  # Slightly lower weight for semantic
                    method="semantic"
                ))

        return evidence_spans

    def _stage3_llm_fallback(
        self,
        item: RubricItem,
        document_ir: DocumentIR
    ) -> List[EvidenceSpan]:
        """
        Stage 3: LLM fallback for full-text analysis.

        Strategy:
        - Provide LLM with full text or key sections
        - Ask LLM to identify relevant passages
        - LLM must provide exact quotes with location information
        """
        evidence_spans: List[EvidenceSpan] = []

        # Prepare context (use fulltext if available, otherwise construct)
        if document_ir.fulltext:
            context = document_ir.fulltext[:8000]  # Limit to 8000 chars
        else:
            context = self._construct_full_context(document_ir)[:8000]

        # Build prompt for LLM
        prompt = f"""
You are analyzing a research manuscript to find evidence for a specific criterion.

**CRITERION:**
- Question: {item.question}
- Evaluation Standard: {item.evaluation_criteria}

**MANUSCRIPT TEXT:**
{context}

**YOUR TASK:**
Identify if there is ANY text in the manuscript that addresses this criterion.
If found, provide:
1. The exact quote (verbatim, max 200 characters)
2. A relevance score (0.0 to 1.0)
3. Brief explanation

Respond in JSON format:
{{
  "found": true/false,
  "quote": "exact text from manuscript",
  "score": 0.0-1.0,
  "explanation": "why this is relevant"
}}

If no relevant information exists, set "found": false.
"""

        try:
            # Call LLM (using existing gateway)
            # Note: This is a simplified version, actual implementation may vary
            # based on LLM gateway capabilities

            # For now, return empty list as LLM fallback requires async
            # This will be implemented in the actual integration
            pass

        except Exception as e:
            # Log error but don't fail
            pass

        return evidence_spans

    def _find_candidate_sections(
        self,
        hint: str,
        document_ir: DocumentIR
    ) -> List[tuple[str, Any]]:
        """
        Find candidate sections based on location hint.

        Supports:
        - Exact match: "methods.randomization"
        - Fuzzy match: "methods" matches "methods.*"
        - Normalized title match: "random" matches "randomization"
        """
        candidates: List[tuple[str, Any]] = []

        # Parse hint
        hint_parts = hint.split(".")

        # Try exact navigation
        if len(hint_parts) >= 1:
            section_name = hint_parts[0]

            # Check top-level sections
            if hasattr(document_ir, section_name):
                section_obj = getattr(document_ir, section_name)

                if len(hint_parts) == 1:
                    # Top-level section
                    candidates.append((section_name, section_obj))
                elif len(hint_parts) == 2 and hasattr(section_obj, hint_parts[1]):
                    # Subsection
                    subsection_obj = getattr(section_obj, hint_parts[1])
                    candidates.append((hint, subsection_obj))
                else:
                    # Fuzzy match: add all subsections
                    if hasattr(section_obj, '__dict__'):
                        for attr_name, attr_value in section_obj.__dict__.items():
                            if attr_value is not None and attr_name != 'full_text':
                                candidates.append((f"{section_name}.{attr_name}", attr_value))

        # If no exact match, try fuzzy matching on section names
        if not candidates:
            keywords = self._extract_keywords_from_hint(hint)
            for section_name in ['introduction', 'methods', 'results', 'discussion', 'conclusion']:
                if hasattr(document_ir, section_name):
                    section_obj = getattr(document_ir, section_name)
                    # Check if any keyword matches section name
                    if any(kw in section_name.lower() for kw in keywords):
                        candidates.append((section_name, section_obj))

        return candidates

    def _extract_section_text(self, section_obj: Any) -> List[str]:
        """Extract text from a section object."""
        texts: List[str] = []

        if section_obj is None:
            return texts

        # Handle SectionText
        if hasattr(section_obj, 'text'):
            if isinstance(section_obj.text, list):
                texts.extend(section_obj.text)
            elif isinstance(section_obj.text, str):
                texts.append(section_obj.text)

        # Handle nested sections
        if hasattr(section_obj, '__dict__'):
            for attr_name, attr_value in section_obj.__dict__.items():
                if attr_name == 'text':
                    continue
                if attr_value is not None and hasattr(attr_value, 'text'):
                    if isinstance(attr_value.text, list):
                        texts.extend(attr_value.text)
                    elif isinstance(attr_value.text, str):
                        texts.append(attr_value.text)

        return texts

    def _extract_keywords(self, hint: str, item: RubricItem) -> List[str]:
        """Extract keywords from hint and rubric item."""
        keywords: List[str] = []

        # From hint
        hint_clean = hint.replace("methods.", "").replace("results.", "").replace("discussion.", "")
        keywords.append(hint_clean.lower())

        # Add synonyms
        if hint_clean.lower() in self.synonym_map:
            keywords.extend(self.synonym_map[hint_clean.lower()])

        # From question (extract key terms)
        question_words = re.findall(r'\b\w{4,}\b', item.question.lower())
        keywords.extend([w for w in question_words if w not in ['does', 'were', 'have', 'been', 'this', 'that', 'with', 'from']])

        return list(set(keywords))

    def _extract_keywords_from_query(self, query: str) -> List[str]:
        """Extract keywords from a search query."""
        # Simple keyword extraction
        words = re.findall(r'\b\w{4,}\b', query.lower())
        # Filter out common words
        stopwords = {'does', 'were', 'have', 'been', 'this', 'that', 'with', 'from', 'should', 'would', 'could'}
        return [w for w in words if w not in stopwords]

    def _extract_keywords_from_hint(self, hint: str) -> List[str]:
        """Extract keywords from location hint."""
        parts = hint.split(".")
        keywords = [p.lower() for p in parts]

        # Add synonyms
        expanded = []
        for kw in keywords:
            expanded.append(kw)
            if kw in self.synonym_map:
                expanded.extend(self.synonym_map[kw])

        return expanded

    def _calculate_keyword_score(self, text: str, keywords: List[str]) -> float:
        """Calculate relevance score based on keyword matches."""
        if not text or not keywords:
            return 0.0

        text_lower = text.lower()
        matches = 0
        total_keywords = len(keywords)

        for keyword in keywords:
            if keyword in text_lower:
                matches += 1

        # Base score from match ratio
        score = matches / total_keywords if total_keywords > 0 else 0.0

        # Boost if multiple keywords appear
        if matches > 1:
            score = min(1.0, score * 1.2)

        return score

    def _extract_all_paragraphs(self, document_ir: DocumentIR) -> List[Any]:
        """Extract all paragraphs from document structure."""
        paragraphs = []

        # Extract from all major sections
        for section_name in ['abstract', 'introduction', 'methods', 'results', 'discussion', 'conclusion']:
            if hasattr(document_ir, section_name):
                section = getattr(document_ir, section_name)
                texts = self._extract_section_text(section)
                for i, text in enumerate(texts):
                    # Create pseudo-paragraph object
                    class PseudoParagraph:
                        def __init__(self, text, section):
                            self.text = text
                            self.section = section
                            self.page = None
                            self.offset = 0

                    paragraphs.append(PseudoParagraph(text, section_name))

        return paragraphs

    def _construct_full_context(self, document_ir: DocumentIR) -> str:
        """Construct full context from document structure."""
        parts = []

        if document_ir.title:
            parts.append(f"# {document_ir.title}\n")

        if document_ir.abstract and document_ir.abstract.text:
            parts.append("## Abstract\n")
            parts.append("\n".join(document_ir.abstract.text))

        for section_name in ['introduction', 'methods', 'results', 'discussion', 'conclusion']:
            if hasattr(document_ir, section_name):
                section = getattr(document_ir, section_name)
                texts = self._extract_section_text(section)
                if texts:
                    parts.append(f"\n## {section_name.title()}\n")
                    parts.append("\n".join(texts))

        return "\n".join(parts)

    def _deduplicate_evidence(self, evidence_spans: List[EvidenceSpan]) -> List[EvidenceSpan]:
        """Remove duplicate evidence spans."""
        seen_quotes = set()
        unique_spans = []

        for span in evidence_spans:
            # Use first 100 chars of quote as key
            key = span.quote[:100].strip().lower()
            if key not in seen_quotes:
                seen_quotes.add(key)
                unique_spans.append(span)

        return unique_spans

    def _build_synonym_map(self) -> Dict[str, List[str]]:
        """Build synonym map for common research terms."""
        return {
            "randomization": ["random assignment", "randomisation", "allocation", "randomized", "randomly assigned"],
            "participants": ["subjects", "patients", "individuals", "cases", "cohort"],
            "blinding": ["masking", "concealment", "blinded", "masked", "double-blind"],
            "sample": ["sample size", "participants", "subjects", "cohort", "population"],
            "intervention": ["treatment", "therapy", "procedure", "protocol", "arm"],
            "outcome": ["endpoint", "result", "measure", "assessment", "outcome measure"],
            "statistical": ["analysis", "statistics", "statistical analysis", "statistical methods", "statistical test"],
            "ethics": ["ethical approval", "irb", "ethics committee", "institutional review", "ethical"],
            "consent": ["informed consent", "consent form", "patient consent", "written consent"],
            "funding": ["financial support", "grant", "sponsor", "financial disclosure", "funding source"],
        }
