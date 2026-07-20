"""Query Builder agent — SQP-based PubMed search query generator.

Architecture (borrowed from query-system):
  LLM → Structured Query Plan (SQP) → Deterministic Compiler → PubMed Query

The LLM generates an SQP (concept blocks with PICO-typed IDs, weighted terms,
MeSH candidates). A deterministic compiler then assembles the final Boolean
query with proper field tags, explode rules, and length fallback. This
separation prevents LLM hallucination in the final query string.

Pipeline:
  1. LLM generates SQP from protocol (concept blocks + logic expression)
  2. MeSH validation and enrichment (API + abbreviation expansion)
  3. PubChem drug synonym expansion (for intervention blocks)
  4. Deterministic query compilation (field tags, explode rules)
  5. Length fallback if query exceeds PubMed limit
  6. LLM review pass
  7. Strategy report generation
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Tuple

from new_meta.core.agent_base import BaseAgent
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.tools.mesh import (
    lookup_mesh_term,
    expand_mesh_term,
    validate_mesh_terms,
    suggest_mesh_terms,
    pubchem_synonyms,
    expand_abbreviations,
    fuzzy_mesh_search,
)

logger = logging.getLogger("metaagent.query_builder")

# =============================================================================
# SQP Data Model
# =============================================================================

TERM_WEIGHT_CANONICAL = 1.00
TERM_WEIGHT_ENTRY = 0.90
TERM_WEIGHT_SUPPLEMENTARY = 0.85
TERM_WEIGHT_PUBCHEM = 0.80
TERM_WEIGHT_ABBREVIATION = 0.75
TERM_WEIGHT_LLM_EXTRA = 0.70

# PubMed query character limit
_PUBMED_MAX_CHARS = 4000
ENABLE_LLM_QUERY_REVIEW = os.getenv("ENABLE_LLM_QUERY_REVIEW", "0").lower() in {
    "1",
    "true",
    "yes",
}


_ESSENTIAL_QUERY_CONCEPTS: list[dict[str, object]] = [
    {
        "name": "COVID-19 / SARS-CoV-2",
        "triggers": (
            "covid",
            "sars-cov-2",
            "sars cov 2",
            "2019-ncov",
            "coronavirus disease 2019",
        ),
        "terms": (
            "COVID-19",
            "COVID19",
            "SARS-CoV-2",
            "2019-nCoV",
            "coronavirus disease 2019",
        ),
        "mesh": "COVID-19",
    },
    {
        "name": "SARS",
        "triggers": ("severe acute respiratory syndrome",),
        "terms": ("severe acute respiratory syndrome", "SARS"),
        "mesh": "Severe Acute Respiratory Syndrome",
    },
]


@dataclass
class FreeTerm:
    """A single search term with weight and provenance."""
    term: str
    weight: float = TERM_WEIGHT_CANONICAL
    source: str = "llm"  # llm | mesh_entry | pubchem | abbreviation | supplementary


@dataclass
class MeSHCandidate:
    """A MeSH descriptor candidate for a concept block."""
    descriptor_name: str
    descriptor_ui: str = ""
    confidence: float = 1.0
    entry_terms: list[str] = field(default_factory=list)
    tree_numbers: list[str] = field(default_factory=list)
    validated: bool = False


@dataclass
class ConceptBlock:
    """A PICO-typed concept block in the Structured Query Plan.

    block_id follows the pattern [PICSO][0-9]+ — e.g. P1, I1, C1, O1, S1.
    """
    block_id: str  # P1, I1, C1, O1, S1, etc.
    canonical_label: str
    free_terms: list[FreeTerm] = field(default_factory=list)
    mesh_candidates: list[MeSHCandidate] = field(default_factory=list)
    explode: bool = True  # True for [mh] (explode), False for [mh:noexp]

    @property
    def pico_type(self) -> str:
        """Return the PICO category letter (P, I, C, O, S)."""
        return self.block_id[0] if self.block_id else "?"


@dataclass
class StructuredQueryPlan:
    """The intermediate representation between LLM and query compiler."""
    blocks: list[ConceptBlock] = field(default_factory=list)
    logic_expression: str = ""  # e.g. "P1 AND I1 AND O1"
    use_mesh: bool = True
    use_synonyms: bool = True
    use_explode: bool = True
    filter_humans: bool = False
    filter_animals: bool = False


# =============================================================================
# Monotherapy Detection
# =============================================================================

# Patterns that indicate combination / multi-drug therapy
_COMBINATION_PATTERNS = re.compile(
    r"(?:combination|combined|联合|复方|复合|加用|添加|add-?on|adjunct|plus|"
    r"co-?administration|triple|dual|两药|三联|四联|with\s+\w+\s+and\s+\w+|"
    r"\w+\s*[\+＋]\s*\w+)",
    re.IGNORECASE,
)

# Delimiters that suggest multiple drugs when present in intervention string
_MULTI_DRUG_SEPARATORS = re.compile(
    r"(?:\s+and\s+|\s*,\s*(?:and\s+)?|\s*[/|]\s*)",
    re.IGNORECASE,
)


def is_single_drug(intervention: str) -> bool:
    """Determine if the intervention describes a single drug (not combination).

    Returns True when the intervention is clearly a single drug like
    "metformin", "二甲双胍", "GLP-1 receptor agonists", "insulin glargine".
    Returns False for combinations like "metformin and sitagliptin",
    "二甲双胍联合磺脲类", "A+B combination therapy".
    """
    if not intervention or not intervention.strip():
        return False
    text = intervention.strip()
    if _COMBINATION_PATTERNS.search(text):
        return False
    # Count drug-like tokens separated by conjunctions/punctuation
    # e.g. "metformin and sitagliptin" -> 2 parts -> not single
    parts = _MULTI_DRUG_SEPARATORS.split(text)
    # Filter out very short parts (< 3 chars) like "and", "or"
    drug_parts = [p.strip() for p in parts if len(p.strip()) >= 3]
    # If 2+ drug-like parts separated by "and"/","/"/", it's combination
    if len(drug_parts) >= 2 and any(s in text.lower() for s in [" and ", "/", "|", ","]):
        return False
    return True


def build_monotherapy_query(
    primary_query: str,
    intervention: str,
    study_design_filter: str = "",
) -> str:
    """Build a monotherapy-focused PubMed query from the primary query.

    Strategy:
    1. Keep the original query structure (population + intervention + outcome)
    2. Add monotherapy preference terms to the intervention block
    3. Use PubMed title field [ti] for intervention to prioritize studies
       where the drug is the PRIMARY subject, not background therapy

    The resulting query uses a two-arm OR strategy:
      Arm A (strict): intervention in title AND monotherapy terms
      Arm B (broad): original query as-is
    This ensures we get monotherapy-focused results first, supplemented by
    the broader query results.
    """
    drug_terms = re.findall(r'"([^"]+)"', intervention)
    if not drug_terms:
        drug_terms = [intervention.strip().strip('"')]

    # Extract the primary drug name (shortest meaningful term)
    drug_name = min(drug_terms, key=len) if drug_terms else intervention.strip()

    # Build monotherapy title filter
    mono_terms = (
        f'"{drug_name}"[ti] AND '
        f'("monotherapy"[tiab] OR "single agent"[tiab] OR "alone"[tiab] '
        f'OR "versus"[tiab] OR "compared with"[tiab] '
        f'OR "initial therapy"[tiab] OR "first-line"[tiab] '
        f'OR "单一用药"[tiab] OR "单药"[tiab])'
    )

    # Two-arm strategy: monotherapy-focused OR original broad query
    # This prioritizes monotherapy studies while keeping all relevant results
    parts = [f"({mono_terms})"]
    if primary_query:
        parts.append(f"({primary_query})")

    combined = " OR ".join(parts)

    # Add study design filter if present
    if study_design_filter:
        combined = f"({combined}) AND ({study_design_filter})"

    return combined


# =============================================================================
# Explode Rules — block type determines MeSH field tag
# =============================================================================

def _mesh_field_tag(block: ConceptBlock, use_explode: bool = True) -> str:
    """Return the appropriate MeSH field tag for a concept block.

    Population/Outcome blocks: [mh] (explosion ON — includes narrower terms)
    Intervention blocks:       [mh:noexp] (explosion OFF — precise matching)
    Study design blocks:       [pt] (publication type)
    """
    if not use_explode:
        return "[mh:noexp]"

    pico = block.pico_type
    if pico == "S":
        return "[pt]"
    elif pico == "I":
        return "[mh:noexp]"
    else:  # P, C, O
        return "[mh]"


# =============================================================================
# Prompt Constants
# =============================================================================

SYSTEM_PROMPT = (
    "You are a medical librarian specializing in systematic review search "
    "strategies. You construct comprehensive PubMed search queries using MeSH "
    "terms and free-text keywords with Boolean operators. Your queries must "
    "balance sensitivity (high recall) with reasonable specificity."
)

SQP_GENERATION_PROMPT = """You are an expert medical librarian. Analyze the following research protocol and produce a **Structured Query Plan (SQP)** in JSON format.

## Research Protocol
- Research Question: {research_question}
- Population: {population}
- Intervention: {intervention}
- Comparator: {comparator}
- Primary Outcome: {outcome}
- Study Design: {study_design}

## SQP Format
Return a JSON object with these fields:
- "logic_expression": A high-recall Boolean expression combining Population and Intervention block IDs (e.g., "P1 AND I1"). Use AND/OR and parentheses as needed. Study-design filtering is appended deterministically by the compiler.
- "blocks": An array of concept blocks, each with:
  - "block_id": String following pattern [PICSO][0-9]+ (P=Population, I=Intervention, C=Comparator, O=Outcome, S=Study design)
  - "canonical_label": The primary concept name
  - "free_terms": Array of objects with "term" (string) and "source" ("llm")
  - "mesh_candidates": Array of objects with "descriptor_name" (string) and "confidence" (0.0-1.0)
  - "explode": Boolean. Use true for disease/population concepts (to include narrower MeSH terms). Use false for drug/intervention concepts (for precision).
- "strategy_toggles": Object with "use_mesh" (bool), "use_synonyms" (bool), "filter_humans" (bool)

## Rules
1. Create SEPARATE blocks for distinct concepts within each PICO element. Example: if the intervention is "GLP-1 receptor agonists" and comparator is "placebo", create I1 for GLP-1 agonists and C1 for placebo.
2. For Population, generate 5-10 free terms including: clinical term, common synonyms, abbreviations, ICD keywords.
3. For Intervention, generate terms for each specific drug/class. Set explode=false for drugs.
4. For Comparator and Outcome, create blocks for documentation and downstream screening, but DO NOT require them in logic_expression. Comparator and outcome terminology is often absent from titles/abstracts and requiring it causes systematic-review retrieval bias.
5. For Study design, include publication types. Set explode=false.
6. Each free_term must be an actual search keyword (no field tags, no Boolean operators).
7. Include MeSH candidates you are confident about (confidence >= 0.7).
8. The default high-recall logic is Population AND Intervention. Combine synonyms or alternative blocks within the same PICO element with OR. Do not add Study design to logic_expression because the compiler appends one canonical design filter.

## Example Output
```json
{{
  "logic_expression": "P1 AND (I1 OR I2)",
  "blocks": [
    {{
      "block_id": "P1",
      "canonical_label": "Type 2 Diabetes",
      "free_terms": [
        {{"term": "type 2 diabetes mellitus", "source": "llm"}},
        {{"term": "T2DM", "source": "llm"}},
        {{"term": "non-insulin dependent diabetes", "source": "llm"}},
        {{"term": "NIDDM", "source": "llm"}},
        {{"term": "adult onset diabetes", "source": "llm"}}
      ],
      "mesh_candidates": [
        {{"descriptor_name": "Diabetes Mellitus, Type 2", "confidence": 0.95}}
      ],
      "explode": true
    }},
    {{
      "block_id": "I1",
      "canonical_label": "Metformin",
      "free_terms": [
        {{"term": "metformin", "source": "llm"}},
        {{"term": "glucophage", "source": "llm"}}
      ],
      "mesh_candidates": [
        {{"descriptor_name": "Metformin", "confidence": 0.98}}
      ],
      "explode": false
    }}
  ],
  "strategy_toggles": {{"use_mesh": true, "use_synonyms": true, "filter_humans": false}}
}}
```

Return ONLY the JSON. No markdown fences, no explanation."""

QUERY_REVIEW_PROMPT = """Review the following PubMed search query built from a Structured Query Plan.

## Research Protocol
- Research Question: {research_question}
- Population: {population}
- Intervention: {intervention}
- Comparator: {comparator}
- Primary Outcome: {outcome}

## Compiled Query ({query_length} chars)
{compiled_query}

## SQP Summary
{sqp_summary}

## Instructions
1. Check syntax validity for PubMed E-utilities.
2. If important synonyms are MISSING, add them as "[tiab]" terms in the appropriate block.
3. Remove clearly irrelevant or overly broad terms.
4. Do NOT change MeSH field tags ([mh], [mh:noexp], [pt]) — they were set by explode rules.
5. Ensure the query remains HIGH RECALL.
6. Keep the query under {max_chars} characters.

Return ONLY the final query string. No explanation."""

FALLBACK_QUERY_PROMPT = """Build a PubMed search query for this meta-analysis protocol.

## Research Protocol
- Research Question: {research_question}
- Population: {population}
- Intervention: {intervention}
- Comparator: {comparator}
- Primary Outcome: {outcome}
- Study Design: {study_design}
- Date Range: {date_range}
- Language: {language}

## Requirements:
1. Use MeSH terms where available (format: "term"[mh])
2. Use [mh:noexp] for drugs, [mh] for diseases/conditions
3. Include free-text synonyms as [tiab] terms
4. Combine within each PICO element using OR
5. Use Population AND Intervention as the high-recall concept backbone; do not require Comparator or Outcome terms
6. Add study design filter with [pt] tags
7. The query should be HIGH RECALL

Return ONLY the PubMed search query string. No explanation."""


# =============================================================================
# Study design publication-type filters
# =============================================================================

_STUDY_DESIGN_FILTERS: dict[str, str] = {
    "RCT": (
        '("randomized controlled trial"[pt] OR "controlled clinical trial"[pt] '
        'OR "randomized"[tiab] OR "randomised"[tiab] OR "randomly"[tiab] '
        'OR "trial"[tiab])'
    ),
    "observational": (
        '("cohort studies"[mh] OR "case-control studies"[mh] '
        'OR "cross-sectional studies"[mh] OR "observational study"[pt])'
    ),
    "both": (
        '("randomized controlled trial"[pt] OR "controlled clinical trial"[pt] '
        'OR "cohort studies"[mh] OR "case-control studies"[mh] '
        'OR "observational study"[pt] OR "clinical trial"[pt])'
    ),
}


def _normalized_pubmed_language_filter(value: str | None) -> str:
    """Return a PubMed language value or an empty string for no restriction."""
    language = re.sub(r"\s+", " ", str(value or "").strip())
    normalized = language.casefold().replace("_", " ").replace("-", " ")
    unrestricted = {
        "",
        "all",
        "all languages",
        "any",
        "any language",
        "no restriction",
        "no restrictions",
        "no language restriction",
        "no language restrictions",
        "not restricted",
        "unrestricted",
        "none",
        "不限",
        "不限语言",
        "无语言限制",
        "所有语言",
    }
    return "" if normalized in unrestricted else language


def _study_design_filter(value: str | None) -> str:
    """Resolve natural-language planner output to a validated PubMed filter."""
    normalized = re.sub(r"[^a-z0-9]+", "_", str(value or "").casefold()).strip("_")
    if normalized in {"rct", "randomized", "randomised"} or any(
        marker in normalized
        for marker in (
            "randomized_controlled",
            "randomised_controlled",
            "randomized_trial",
            "randomised_trial",
        )
    ):
        return _STUDY_DESIGN_FILTERS["RCT"]
    if any(marker in normalized for marker in ("observational", "cohort", "case_control", "cross_sectional")):
        return _STUDY_DESIGN_FILTERS["observational"]
    if any(marker in normalized for marker in ("both", "randomized_and_observational", "mixed_design")):
        return _STUDY_DESIGN_FILTERS["both"]
    return _STUDY_DESIGN_FILTERS.get(str(value or ""), "")


# =============================================================================
# Deterministic Query Compiler
# =============================================================================

class QueryCompiler:
    """Compiles a StructuredQueryPlan into a PubMed Boolean query.

    Handles field tags ([mh] vs [mh:noexp] vs [tiab] vs [pt]),
    weight-based term ordering, and length fallback.
    """

    def __init__(self, sqp: StructuredQueryPlan, max_chars: int = _PUBMED_MAX_CHARS):
        self.sqp = sqp
        self.max_chars = max_chars

    def compile(self) -> str:
        """Compile the SQP into a PubMed query string.

        Tries 3 fallback levels if the query exceeds max_chars:
          Level 1: Trim low-weight free terms
          Level 2: MeSH terms only (drop all free text)
          Level 3: Remove explode (all [mh:noexp])
        """
        # Level 0: Full query
        query = self._compile_full(use_explode=True, min_weight=0.0)
        if len(query) <= self.max_chars:
            return query

        logger.info("Query too long (%d chars), trying Level 1 fallback (trim by weight)", len(query))

        # Level 1: Drop terms with weight < 0.75
        query = self._compile_full(use_explode=True, min_weight=TERM_WEIGHT_ABBREVIATION)
        if len(query) <= self.max_chars:
            return query

        logger.info("Still too long (%d chars), trying Level 2 fallback (MeSH only)", len(query))

        # Level 2: MeSH terms only
        query = self._compile_mesh_only(use_explode=True)
        if len(query) <= self.max_chars:
            return query

        logger.info("Still too long (%d chars), trying Level 3 fallback (no explode)", len(query))

        # Level 3: MeSH only + no explode
        query = self._compile_mesh_only(use_explode=False)
        return query

    def _compile_full(self, use_explode: bool, min_weight: float) -> str:
        """Compile with both MeSH and free-text terms."""
        block_queries: dict[str, str] = {}

        for block in self.sqp.blocks:
            clauses: list[str] = []

            # MeSH descriptors
            if self.sqp.use_mesh:
                tag = _mesh_field_tag(block, use_explode)
                for mc in block.mesh_candidates:
                    if mc.validated:
                        clauses.append(f'"{mc.descriptor_name}"{tag}')

            # Free-text terms (sorted by weight descending)
            sorted_terms = sorted(block.free_terms, key=lambda t: t.weight, reverse=True)
            for ft in sorted_terms:
                if ft.weight < min_weight:
                    continue
                clauses.append(f'"{ft.term}"[tiab]')

            if clauses:
                inner = " OR ".join(clauses)
                block_queries[block.block_id] = f"({inner})"

        return self._substitute_logic(block_queries)

    def _compile_mesh_only(self, use_explode: bool) -> str:
        """Compile using only validated MeSH terms."""
        block_queries: dict[str, str] = {}

        for block in self.sqp.blocks:
            clauses: list[str] = []
            tag = _mesh_field_tag(block, use_explode)
            for mc in block.mesh_candidates:
                if mc.validated:
                    clauses.append(f'"{mc.descriptor_name}"{tag}')

            # If no MeSH, fall back to canonical label as free text
            if not clauses:
                clauses.append(f'"{block.canonical_label}"[tiab]')

            inner = " OR ".join(clauses)
            block_queries[block.block_id] = f"({inner})"

        return self._substitute_logic(block_queries)

    def _substitute_logic(self, block_queries: dict[str, str]) -> str:
        """Substitute block IDs in the logic expression with compiled blocks."""
        expr = self.sqp.logic_expression
        if not expr:
            # Default: AND all blocks
            expr = " AND ".join(sorted(block_queries.keys()))

        # Sort block IDs by length descending to avoid partial replacement
        for bid in sorted(block_queries.keys(), key=len, reverse=True):
            expr = expr.replace(bid, block_queries.get(bid, bid))

        return expr


def _high_recall_logic_expression(sqp: StructuredQueryPlan) -> str:
    """Return a deterministic P/I retrieval backbone for review searches.

    Comparator and outcome blocks remain in the SQP for protocol traceability
    and eligibility screening. Requiring them in the database expression is a
    known source of avoidable false negatives because abstracts frequently do
    not name the comparator or the review's exact outcome wording.
    """
    block_ids_by_type: dict[str, list[str]] = {"P": [], "I": []}
    for block in sqp.blocks:
        if block.pico_type in block_ids_by_type:
            block_ids_by_type[block.pico_type].append(block.block_id)

    groups: list[str] = []
    for pico_type in ("P", "I"):
        block_ids = block_ids_by_type[pico_type]
        if not block_ids:
            continue
        group = " OR ".join(block_ids)
        groups.append(f"({group})" if len(block_ids) > 1 else group)

    if groups:
        return " AND ".join(groups)

    # Defensive fallback for non-PICO/narrative protocols.
    return sqp.logic_expression or " AND ".join(
        block.block_id for block in sqp.blocks
    )


def _review_preserves_high_recall_contract(
    *,
    reviewed: str,
    compiled_query: str,
    sqp: StructuredQueryPlan,
) -> bool:
    """Reject an LLM rewrite that narrows or changes the reviewed search plan."""
    candidate = str(reviewed or "").strip()
    if not candidate or candidate.count("(") != candidate.count(")"):
        return False

    candidate_folded = candidate.casefold()
    compiled_folded = str(compiled_query or "").casefold()
    if "[la]" in candidate_folded and "[la]" not in compiled_folded:
        return False

    def quoted(term: str, text: str) -> bool:
        normalized = str(term or "").strip().casefold()
        return bool(normalized) and f'"{normalized}"' in text

    # Comparator/outcome blocks are eligibility concepts, not mandatory
    # database concepts. The reviewer must not silently add them back.
    for block in sqp.blocks:
        terms = [
            block.canonical_label,
            *(item.term for item in block.free_terms),
            *(item.descriptor_name for item in block.mesh_candidates),
        ]
        if block.pico_type in {"C", "O"} and any(
            quoted(term, candidate_folded) and not quoted(term, compiled_folded)
            for term in terms
        ):
            return False

    # Population and intervention must each retain at least one compiled term.
    for pico_type in ("P", "I"):
        blocks = [block for block in sqp.blocks if block.pico_type == pico_type]
        if not blocks:
            continue
        terms = [
            term
            for block in blocks
            for term in (
                block.canonical_label,
                *(item.term for item in block.free_terms),
                *(item.descriptor_name for item in block.mesh_candidates),
            )
            if quoted(term, compiled_folded)
        ]
        if terms and not any(quoted(term, candidate_folded) for term in terms):
            return False

    return True


# =============================================================================
# QueryBuilder Agent
# =============================================================================

class QueryBuilder(BaseAgent):
    """Builds a validated, MeSH-enriched PubMed search query via SQP."""

    def __init__(self, model: str = None):
        super().__init__("query_builder", SYSTEM_PROMPT, model=model)

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def run(self, protocol: ResearchProtocol) -> Tuple[str, str, bool]:
        """Generate a PubMed search query and a strategy report.

        Returns (final_query, strategy_report, is_single_drug).
        """
        self.log("Starting SQP-based search strategy construction...")

        single_drug = is_single_drug(protocol.pico.intervention)
        if single_drug:
            self.log(f"检测到单药干预: {protocol.pico.intervention}，将启用单药优先检索")

        try:
            query, report = self._build_with_sqp(protocol)
        except Exception as exc:
            self.log(
                f"SQP pipeline failed ({exc}); falling back to LLM-only approach.",
                level="warning",
            )
            try:
                query, report = self._build_fallback(protocol)
            except Exception as fallback_exc:
                self.log(
                    f"LLM-only query fallback failed ({fallback_exc}); using deterministic emergency query.",
                    level="warning",
                )
                query, report = self._build_emergency_fallback(
                    protocol,
                    reason=f"SQP error: {exc}; LLM fallback error: {fallback_exc}",
                )

        query, report = self._enforce_required_concepts(protocol, query, report)
        query, report = self._enforce_boolean_not_scope(query, report)
        self.log(f"Search query finalised ({len(query)} chars)")
        return query, report, single_drug

    # ------------------------------------------------------------------
    # Main SQP Pipeline
    # ------------------------------------------------------------------

    def _build_with_sqp(self, protocol: ResearchProtocol) -> Tuple[str, str]:
        # Step 1: LLM generates SQP
        sqp = self._generate_sqp(protocol)

        # Step 2: MeSH validation and enrichment
        sqp = self._validate_and_enrich_mesh(sqp)

        # Step 3: Abbreviation expansion (all blocks)
        sqp = self._expand_abbreviations(sqp)

        # Step 4: PubChem drug synonym expansion (intervention blocks)
        sqp = self._expand_pubchem(sqp)

        # Step 5: Deterministic compilation
        compiler = QueryCompiler(sqp)
        compiled_query = compiler.compile()

        # Step 6: Apply filters (date, language, study design)
        filtered_query = self._apply_filters(compiled_query, protocol)

        # Step 7: optional LLM review. The deterministic SQP compiler is the
        # release default because free-form rewrites repeatedly reintroduced
        # comparator/outcome/language restrictions and consumed large thinking
        # budgets without improving recall.
        if ENABLE_LLM_QUERY_REVIEW:
            final_query = self._review_query(protocol, filtered_query, sqp)
        else:
            self.log("Step 7: Using deterministic high-recall query (LLM rewrite disabled).")
            final_query = filtered_query

        # Step 8: Generate strategy report
        report = self._generate_report(protocol, sqp, compiled_query, final_query)

        return final_query, report

    # ------------------------------------------------------------------
    # Step 1 — SQP Generation
    # ------------------------------------------------------------------

    def _generate_sqp(self, protocol: ResearchProtocol) -> StructuredQueryPlan:
        """Ask the LLM to produce an SQP from the research protocol."""
        self.log("Step 1: Generating Structured Query Plan (SQP) via LLM...")

        prompt = SQP_GENERATION_PROMPT.format(
            research_question=protocol.research_question,
            population=protocol.pico.population,
            intervention=protocol.pico.intervention,
            comparator=protocol.pico.comparator,
            outcome=protocol.pico.outcome_primary,
            study_design=protocol.study_design,
        )

        raw = self.call_llm(prompt, max_tokens=8192)
        raw = _strip_markdown_fences(raw)

        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            self.log("LLM returned non-JSON SQP; attempting repair...", level="warning")
            repair_prompt = (
                "The following text was supposed to be a valid JSON Structured Query Plan. "
                "Fix it and return ONLY the corrected JSON. No explanation.\n\n"
                f"{raw}"
            )
            raw = _strip_markdown_fences(self.call_llm(repair_prompt, max_tokens=8192))
            data = json.loads(raw)

        return self._parse_sqp(data)

    def _parse_sqp(self, data: dict) -> StructuredQueryPlan:
        """Parse LLM JSON output into a StructuredQueryPlan."""
        sqp = StructuredQueryPlan()
        sqp.logic_expression = data.get("logic_expression", "")

        toggles = data.get("strategy_toggles", {})
        sqp.use_mesh = toggles.get("use_mesh", True)
        sqp.use_synonyms = toggles.get("use_synonyms", True)
        sqp.filter_humans = toggles.get("filter_humans", False)
        sqp.filter_animals = toggles.get("filter_animals", False)

        for block_data in data.get("blocks", []):
            block_id = block_data.get("block_id", "")
            if not re.match(r"^[PICSO]\d+$", block_id):
                self.log(f"Skipping invalid block_id: {block_id}", level="warning")
                continue

            block = ConceptBlock(
                block_id=block_id,
                canonical_label=block_data.get("canonical_label", ""),
                explode=block_data.get("explode", True),
            )

            # Parse free terms
            for ft_data in block_data.get("free_terms", []):
                term_str = ft_data.get("term", "") if isinstance(ft_data, dict) else str(ft_data)
                source = ft_data.get("source", "llm") if isinstance(ft_data, dict) else "llm"
                if term_str.strip():
                    block.free_terms.append(FreeTerm(
                        term=term_str.strip(),
                        weight=TERM_WEIGHT_CANONICAL,
                        source=source,
                    ))

            # Parse MeSH candidates
            for mc_data in block_data.get("mesh_candidates", []):
                if isinstance(mc_data, dict):
                    block.mesh_candidates.append(MeSHCandidate(
                        descriptor_name=mc_data.get("descriptor_name", ""),
                        descriptor_ui=mc_data.get("descriptor_ui", ""),
                        confidence=mc_data.get("confidence", 0.5),
                    ))

            sqp.blocks.append(block)

        original_logic = sqp.logic_expression
        sqp.logic_expression = _high_recall_logic_expression(sqp)
        if original_logic and original_logic != sqp.logic_expression:
            self.log(
                "Normalized SQP logic for systematic-review recall: "
                f"{original_logic} -> {sqp.logic_expression}",
                level="warning",
            )

        n_blocks = len(sqp.blocks)
        n_terms = sum(len(b.free_terms) for b in sqp.blocks)
        n_mesh = sum(len(b.mesh_candidates) for b in sqp.blocks)
        self.log(f"  SQP parsed: {n_blocks} blocks, {n_terms} terms, {n_mesh} MeSH candidates")
        self.log(f"  Logic: {sqp.logic_expression}")

        return sqp

    # ------------------------------------------------------------------
    # Step 2 — MeSH Validation and Enrichment
    # ------------------------------------------------------------------

    def _validate_and_enrich_mesh(self, sqp: StructuredQueryPlan) -> StructuredQueryPlan:
        """Validate MeSH candidates via API. For unvalidated ones, try fuzzy search."""
        self.log("Step 2: Validating MeSH candidates...")

        for block in sqp.blocks:
            validated_candidates: list[MeSHCandidate] = []

            for mc in block.mesh_candidates:
                detail = lookup_mesh_term(mc.descriptor_name)
                if detail is not None:
                    mc.validated = True
                    mc.descriptor_name = detail["descriptor_name"]
                    mc.descriptor_ui = detail.get("descriptor_ui", "")
                    mc.entry_terms = detail.get("entry_terms", [])
                    mc.tree_numbers = detail.get("tree_numbers", [])
                    validated_candidates.append(mc)

                    # Add entry terms as free terms with weight 0.9
                    if sqp.use_synonyms:
                        for et in mc.entry_terms[:8]:  # Cap at 8 per descriptor
                            if not any(ft.term.lower() == et.lower() for ft in block.free_terms):
                                block.free_terms.append(FreeTerm(
                                    term=et,
                                    weight=TERM_WEIGHT_ENTRY,
                                    source="mesh_entry",
                                ))
                else:
                    # Try fuzzy search
                    fuzzy_results = fuzzy_mesh_search(mc.descriptor_name, max_results=3)
                    if fuzzy_results:
                        best = fuzzy_results[0]
                        mc.descriptor_name = best["descriptor_name"]
                        mc.descriptor_ui = best.get("descriptor_ui", "")
                        mc.confidence = best.get("confidence", 0.7)
                        mc.validated = True
                        validated_candidates.append(mc)
                        self.log(f"    Fuzzy match: '{mc.descriptor_name}' → '{best['descriptor_name']}'")

                        # Fetch entry terms for fuzzy match
                        if sqp.use_synonyms:
                            entry_terms = expand_mesh_term(best["descriptor_name"])
                            mc.entry_terms = entry_terms
                            for et in entry_terms[:5]:
                                if not any(ft.term.lower() == et.lower() for ft in block.free_terms):
                                    block.free_terms.append(FreeTerm(
                                        term=et,
                                        weight=TERM_WEIGHT_SUPPLEMENTARY,
                                        source="mesh_entry",
                                    ))
                    else:
                        self.log(f"    Not found: '{mc.descriptor_name}'", level="warning")

            block.mesh_candidates = validated_candidates

            n_val = sum(1 for mc in block.mesh_candidates if mc.validated)
            self.log(f"  {block.block_id} ({block.canonical_label}): {n_val} MeSH validated")

        return sqp

    # ------------------------------------------------------------------
    # Step 3 — Abbreviation Expansion
    # ------------------------------------------------------------------

    def _expand_abbreviations(self, sqp: StructuredQueryPlan) -> StructuredQueryPlan:
        """Expand abbreviations in free terms using the common abbreviation map."""
        self.log("Step 3: Expanding abbreviations...")

        for block in sqp.blocks:
            new_terms: list[FreeTerm] = []
            for ft in block.free_terms:
                expansions = expand_abbreviations(ft.term)
                for exp in expansions:
                    if not any(t.term.lower() == exp.lower() for t in block.free_terms):
                        if not any(t.term.lower() == exp.lower() for t in new_terms):
                            new_terms.append(FreeTerm(
                                term=exp,
                                weight=TERM_WEIGHT_ABBREVIATION,
                                source="abbreviation",
                            ))

            if new_terms:
                self.log(f"  {block.block_id}: +{len(new_terms)} abbreviation expansions")
                block.free_terms.extend(new_terms)

        return sqp

    # ------------------------------------------------------------------
    # Step 4 — PubChem Drug Synonym Expansion
    # ------------------------------------------------------------------

    def _expand_pubchem(self, sqp: StructuredQueryPlan) -> StructuredQueryPlan:
        """Expand intervention blocks with PubChem drug synonyms."""
        self.log("Step 4: PubChem drug synonym expansion...")

        for block in sqp.blocks:
            if block.pico_type != "I":
                continue

            try:
                synonyms = pubchem_synonyms(block.canonical_label, max_synonyms=10)
            except Exception:
                synonyms = []

            new_terms = 0
            for syn in synonyms:
                # Skip if already present
                if any(ft.term.lower() == syn.lower() for ft in block.free_terms):
                    continue
                block.free_terms.append(FreeTerm(
                    term=syn,
                    weight=TERM_WEIGHT_PUBCHEM,
                    source="pubchem",
                ))
                new_terms += 1

            if new_terms > 0:
                self.log(f"  {block.block_id} ({block.canonical_label}): +{new_terms} PubChem synonyms")

        return sqp

    # ------------------------------------------------------------------
    # Step 5/6 — Filters
    # ------------------------------------------------------------------

    def _apply_filters(self, query: str, protocol: ResearchProtocol) -> str:
        """Append study design, date, and language filters."""
        parts = [query] if query else []

        # Study design filter
        design_filter = _study_design_filter(protocol.study_design or "RCT")
        if design_filter:
            parts.append(design_filter)

        # Humans filter
        # (Some protocols want to exclude animal studies)

        # Date filter
        if protocol.date_range:
            import datetime
            date_parts = protocol.date_range.replace(" ", "").replace("–", "-").split("-")
            if len(date_parts) == 2:
                start_year, end_year = date_parts[0], str(max(int(date_parts[1]), datetime.datetime.now().year))
                parts.append(f'("{start_year}/01/01"[PDAT] : "{end_year}/12/31"[PDAT])')

        # Language filter
        language = _normalized_pubmed_language_filter(protocol.language)
        if language:
            parts.append(f'"{language}"[la]')

        if len(parts) > 1:
            return " AND ".join(f"({p})" if " OR " in p else p for p in parts)
        return parts[0] if parts else ""

    # ------------------------------------------------------------------
    # Step 7 — LLM Review
    # ------------------------------------------------------------------

    def _review_query(
        self,
        protocol: ResearchProtocol,
        compiled_query: str,
        sqp: StructuredQueryPlan,
    ) -> str:
        """Have the LLM review and optimize the compiled query."""
        self.log("Step 7: LLM reviewing compiled query...")

        # Build SQP summary for the reviewer
        summary_lines = []
        for block in sqp.blocks:
            n_mesh = sum(1 for mc in block.mesh_candidates if mc.validated)
            n_free = len(block.free_terms)
            tag = _mesh_field_tag(block, sqp.use_explode)
            summary_lines.append(
                f"  {block.block_id} ({block.canonical_label}): "
                f"{n_mesh} MeSH{tag}, {n_free} free terms, "
                f"explode={'ON' if block.explode else 'OFF'}"
            )
        sqp_summary = "\n".join(summary_lines)

        prompt = QUERY_REVIEW_PROMPT.format(
            research_question=protocol.research_question,
            population=protocol.pico.population,
            intervention=protocol.pico.intervention,
            comparator=protocol.pico.comparator,
            outcome=protocol.pico.outcome_primary,
            compiled_query=compiled_query,
            query_length=len(compiled_query),
            sqp_summary=sqp_summary,
            max_chars=_PUBMED_MAX_CHARS,
        )

        reviewed = self.call_llm(prompt, max_tokens=8192)
        reviewed = reviewed.strip().strip("`").strip()

        # Strip leading language labels
        if reviewed.lower().startswith(("sql", "pubmed", "query")):
            reviewed = "\n".join(reviewed.split("\n")[1:]).strip()

        if not _review_preserves_high_recall_contract(
            reviewed=reviewed,
            compiled_query=compiled_query,
            sqp=sqp,
        ):
            self.log(
                "LLM query review violated the high-recall P/I contract; "
                "retaining the deterministic compiled query.",
                level="warning",
            )
            return compiled_query

        self.log(f"  Reviewed query ({len(reviewed)} chars)")
        return reviewed

    # ------------------------------------------------------------------
    # Step 8 — Strategy Report
    # ------------------------------------------------------------------

    def _generate_report(
        self,
        protocol: ResearchProtocol,
        sqp: StructuredQueryPlan,
        compiled_query: str,
        final_query: str,
    ) -> str:
        """Compile a comprehensive search strategy report."""
        lines: list[str] = []

        lines.append("=" * 72)
        lines.append("SEARCH STRATEGY REPORT")
        lines.append("=" * 72)

        # --- Protocol ---
        lines.append("\n## Research Question")
        lines.append(protocol.research_question)
        lines.append(f"\n  Population   : {protocol.pico.population}")
        lines.append(f"  Intervention : {protocol.pico.intervention}")
        lines.append(f"  Comparator   : {protocol.pico.comparator}")
        lines.append(f"  Outcome      : {protocol.pico.outcome_primary}")
        lines.append(f"  Study Design : {protocol.study_design}")
        lines.append(f"  Date Range   : {protocol.date_range or 'No restriction'}")
        lines.append(f"  Language     : {protocol.language}")

        # --- SQP Structure ---
        lines.append("\n## Structured Query Plan (SQP)")
        lines.append(f"  Logic: {sqp.logic_expression}")
        lines.append(f"  Toggles: MeSH={sqp.use_mesh}, Synonyms={sqp.use_synonyms}, "
                      f"Explode={sqp.use_explode}")

        for block in sqp.blocks:
            tag = _mesh_field_tag(block, sqp.use_explode)
            lines.append(f"\n### {block.block_id}: {block.canonical_label}")
            lines.append(f"  Type: {block.pico_type}, Explode: {block.explode}, "
                          f"MeSH tag: {tag}")

            # MeSH candidates
            lines.append("  MeSH descriptors:")
            if block.mesh_candidates:
                for mc in block.mesh_candidates:
                    status = "VALIDATED" if mc.validated else "not found"
                    lines.append(f"    * {mc.descriptor_name} ({mc.descriptor_ui}) "
                                  f"[{status}, conf={mc.confidence:.2f}]")
                    if mc.tree_numbers:
                        lines.append(f"      Trees: {', '.join(mc.tree_numbers[:5])}")
                    if mc.entry_terms:
                        shown = mc.entry_terms[:5]
                        lines.append(f"      Entry terms: {', '.join(shown)}"
                                      f"{'...' if len(mc.entry_terms) > 5 else ''}")
            else:
                lines.append("    (none)")

            # Free terms by source
            by_source: dict[str, list[FreeTerm]] = {}
            for ft in block.free_terms:
                by_source.setdefault(ft.source, []).append(ft)

            lines.append("  Free-text terms:")
            for source, terms in sorted(by_source.items()):
                terms_sorted = sorted(terms, key=lambda t: t.weight, reverse=True)
                term_strs = [f"{t.term} (w={t.weight:.2f})" for t in terms_sorted]
                lines.append(f"    [{source}] {', '.join(term_strs)}")

        # --- Compilation stats ---
        total_mesh = sum(len(b.mesh_candidates) for b in sqp.blocks)
        total_mesh_val = sum(1 for b in sqp.blocks for mc in b.mesh_candidates if mc.validated)
        total_free = sum(len(b.free_terms) for b in sqp.blocks)
        by_source_all: dict[str, int] = {}
        for b in sqp.blocks:
            for ft in b.free_terms:
                by_source_all[ft.source] = by_source_all.get(ft.source, 0) + 1

        lines.append("\n## Compilation Statistics")
        lines.append(f"  Blocks: {len(sqp.blocks)}")
        lines.append(f"  MeSH candidates: {total_mesh_val}/{total_mesh} validated")
        lines.append(f"  Free-text terms: {total_free}")
        for source, count in sorted(by_source_all.items()):
            lines.append(f"    {source}: {count}")
        lines.append(f"  Compiled query: {len(compiled_query)} chars")
        lines.append(f"  Final query: {len(final_query)} chars")

        # --- Queries ---
        lines.append("\n## Compiled Query (Deterministic)")
        lines.append(compiled_query)

        query_label = (
            "LLM-Reviewed with deterministic recall gate"
            if ENABLE_LLM_QUERY_REVIEW
            else "Deterministic high-recall query"
        )
        lines.append(f"\n## Final Query ({query_label})")
        lines.append(final_query)

        lines.append("\n" + "=" * 72)
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # Fallback — LLM-only query generation
    # ------------------------------------------------------------------

    def _build_fallback(self, protocol: ResearchProtocol) -> Tuple[str, str]:
        """Generate a query using only the LLM (no MeSH/PubChem APIs)."""
        self.log("Using LLM-only fallback for query generation...")

        prompt = FALLBACK_QUERY_PROMPT.format(
            research_question=protocol.research_question,
            population=protocol.pico.population,
            intervention=protocol.pico.intervention,
            comparator=protocol.pico.comparator,
            outcome=protocol.pico.outcome_primary,
            study_design=protocol.study_design,
            date_range=protocol.date_range or "no restriction",
            language=protocol.language,
        )

        query = self.call_llm(prompt, max_tokens=2048)
        query = query.strip().strip("`").strip()
        if query.lower().startswith(("sql", "pubmed", "query")):
            query = "\n".join(query.split("\n")[1:]).strip()

        report = (
            "=" * 72 + "\n"
            "SEARCH STRATEGY REPORT (FALLBACK — LLM-ONLY)\n"
            + "=" * 72 + "\n\n"
            "MeSH/PubChem APIs were unavailable. The query was generated\n"
            "entirely by the LLM without programmatic verification.\n\n"
            f"## Research Question\n{protocol.research_question}\n\n"
            f"## Final Query\n{query}\n\n"
            + "=" * 72
        )

        self.log(f"Fallback query generated ({len(query)} chars)")
        return query, report

    def _build_emergency_fallback(self, protocol: ResearchProtocol, *, reason: str = "") -> Tuple[str, str]:
        """Build a conservative PubMed query without any LLM calls.

        This is a last-resort path for provider outages or platform content
        filters. It favors recall over elegance so the pipeline can still reach
        PubMed and downstream precision supplements.
        """
        population_text = f"{protocol.research_question} {protocol.pico.population}"
        intervention_text = protocol.pico.intervention
        outcome_text = protocol.pico.outcome_primary

        groups = []
        for label, text in (
            ("Population", population_text),
            ("Intervention", intervention_text),
            ("Outcome", outcome_text),
        ):
            terms = self._emergency_terms(text, label)
            if terms:
                groups.append((label, terms))

        base_query = " AND ".join(
            f"({self._emergency_or_group(terms)})"
            for _label, terms in groups
            if self._emergency_or_group(terms)
        )
        query = self._apply_filters(base_query, protocol)

        report_lines = [
            "=" * 72,
            "SEARCH STRATEGY REPORT (EMERGENCY — DETERMINISTIC)",
            "=" * 72,
            "",
            "The LLM-assisted SQP and LLM-only fallback paths were unavailable.",
            "A conservative deterministic query was generated from the protocol fields.",
        ]
        if reason:
            report_lines.extend(["", f"Failure reason: {reason}"])
        report_lines.extend([
            "",
            f"## Research Question\n{protocol.research_question}",
            "",
            "## Deterministic Concept Groups",
        ])
        for label, terms in groups:
            report_lines.append(f"- {label}: {', '.join(terms)}")
        report_lines.extend([
            "",
            f"## Final Query\n{query}",
            "",
            "=" * 72,
        ])

        self.log(f"Emergency deterministic query generated ({len(query)} chars)")
        return query, "\n".join(report_lines)

    @staticmethod
    def _emergency_terms(text: str, label: str) -> list[str]:
        lower = (text or "").lower()
        terms: list[str] = []

        def add(items: list[str] | tuple[str, ...]) -> None:
            for item in items:
                if item and item.lower() not in {term.lower() for term in terms}:
                    terms.append(item)

        if any(trigger in lower for trigger in ("covid", "sars-cov-2", "sars cov 2", "2019-ncov")):
            add(("COVID-19", "SARS-CoV-2", "2019-nCoV"))
        if any(trigger in lower for trigger in ("critical", "critically", "icu", "intensive care", "mechanical ventilation")):
            add(("critically ill", "critical illness", "ICU", "intensive care", "mechanical ventilation"))
        if any(trigger in lower for trigger in ("corticosteroid", "glucocorticoid", "steroid", "dexamethasone", "hydrocortisone", "methylprednisolone")):
            add(("corticosteroid*", "glucocorticoid*", "dexamethasone", "hydrocortisone", "methylprednisolone"))
        if any(trigger in lower for trigger in ("mortality", "death", "survival")):
            add(("mortality", "death", "survival"))

        stopwords = {
            "with", "without", "patients", "adults", "adult", "among", "effect",
            "compared", "usual", "care", "standard", "systemic", "including",
            "study", "trial", "outcome", "what", "does", "post", "days",
        }
        for token in re.findall(r"[A-Za-z][A-Za-z0-9-]{3,}", text or ""):
            token_l = token.lower()
            if token_l in stopwords:
                continue
            if token_l in {term.lower().rstrip("*") for term in terms}:
                continue
            terms.append(token)
            if len(terms) >= 12:
                break

        return terms[:12]

    @staticmethod
    def _emergency_or_group(terms: list[str]) -> str:
        formatted = []
        for term in terms:
            safe = term.strip().replace('"', "")
            if not safe:
                continue
            if safe.endswith("*"):
                formatted.append(f"{safe}[tiab]")
            else:
                formatted.append(f'"{safe}"[tiab]')
        return " OR ".join(formatted)

    # ------------------------------------------------------------------
    # Deterministic safety checks
    # ------------------------------------------------------------------

    def _enforce_required_concepts(
        self,
        protocol: ResearchProtocol,
        query: str,
        report: str,
    ) -> Tuple[str, str]:
        """Ensure high-salience protocol concepts survive SQP/review steps.

        The LLM review pass can accidentally remove the disease/entity term
        while preserving generic population terms (e.g. ICU, mortality). That
        creates catastrophic recall drift. Keep this check small and explicit:
        only concepts with unambiguous trigger vocabularies are auto-enforced.
        """
        required = _required_query_concepts(protocol)
        if not required:
            return query, report

        added_sections: list[str] = []
        final_query = query
        for concept in required:
            terms = tuple(str(t) for t in concept["terms"])
            mesh = str(concept.get("mesh") or "")
            if _query_contains_any(final_query, terms + ((mesh,) if mesh else ())):
                continue

            clause_terms = [f'"{term}"[tiab]' for term in terms]
            if mesh:
                clause_terms.insert(0, f'"{mesh}"[mh]')
            clause = "(" + " OR ".join(clause_terms) + ")"
            final_query = f"({final_query}) AND {clause}" if final_query else clause
            added_sections.append(
                f"- Added mandatory concept block for {concept['name']}: {clause}"
            )

        if not added_sections:
            return final_query, report

        self.log(
            "Search query was missing required protocol concept(s); "
            f"added {len(added_sections)} deterministic block(s).",
            level="warning",
        )
        report = (
            f"{report.rstrip()}\n\n"
            "## Deterministic Query Safety Checks\n"
            + "\n".join(added_sections)
            + "\n"
        )
        return final_query, report

    def _enforce_boolean_not_scope(self, query: str, report: str) -> Tuple[str, str]:
        """Normalize inline NOT clauses that survived the LLM review pass."""
        normalized, changed = normalize_pubmed_boolean_not_scope(query)
        if not changed:
            return query, report

        self.log(
            "Search query contained inline NOT terms inside an OR concept block; "
            "normalized their Boolean scope.",
            level="warning",
        )
        report = (
            f"{report.rstrip()}\n\n"
            "## Boolean NOT Scope Normalization\n"
            "- Moved inline NOT terms outside their OR concept block so PubMed "
            "applies exclusions to the full positive concept group.\n"
        )
        return normalized, report


# =============================================================================
# Helpers
# =============================================================================

def _strip_markdown_fences(text: str) -> str:
    """Remove markdown code fences from LLM output."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:])
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()
    return text


def _normalize_for_query_check(text: str) -> str:
    """Lowercase and remove punctuation noise for containment checks."""
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def _query_contains_any(query: str, terms: tuple[str, ...]) -> bool:
    normalized_query = _normalize_for_query_check(query)
    return any(_normalize_for_query_check(term) in normalized_query for term in terms if term)


def normalize_pubmed_boolean_not_scope(query: str) -> tuple[str, bool]:
    """Lift inline NOT operators out of simple OR concept groups.

    LLM review can produce blocks such as ``A OR B NOT C NOT D``. PubMed will
    accept that text, but the scope is hard for users to audit. For simple
    parenthesized concept blocks, rewrite it as ``(A OR B) NOT (C OR D)``.
    Nested Boolean structure is preserved and processed recursively.
    """
    text = str(query or "")
    result: list[str] = []
    changed = False
    i = 0
    while i < len(text):
        if text[i] != "(":
            result.append(text[i])
            i += 1
            continue

        end = _matching_paren_index(text, i)
        if end < 0:
            result.append(text[i])
            i += 1
            continue

        inner = text[i + 1:end]
        processed_inner, recursive_changed = normalize_pubmed_boolean_not_scope(inner)
        rewritten, group_changed = _rewrite_simple_inline_not_group(processed_inner)
        if group_changed:
            result.append(rewritten)
        else:
            result.append(f"({processed_inner})")
        changed = changed or recursive_changed or group_changed
        i = end + 1

    return "".join(result), changed


def _matching_paren_index(text: str, start: int) -> int:
    depth = 0
    in_quote = False
    i = start
    while i < len(text):
        ch = text[i]
        if ch == '"':
            in_quote = not in_quote
        elif not in_quote:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    return i
        i += 1
    return -1


def _rewrite_simple_inline_not_group(inner: str) -> tuple[str, bool]:
    if "(" in inner or ")" in inner:
        return inner, False
    parts = [part.strip() for part in re.split(r"\s+\bNOT\b\s+", inner, flags=re.I) if part.strip()]
    if len(parts) < 2:
        return inner, False

    positive = parts[0]
    negatives = parts[1:]
    if not re.search(r"\bOR\b", positive, flags=re.I):
        return inner, False
    if re.search(r"\bAND\b", positive, flags=re.I):
        return inner, False
    if any(re.search(r"\bAND\b", negative, flags=re.I) for negative in negatives):
        return inner, False

    negative_group = " OR ".join(negatives)
    return f"(({positive}) NOT ({negative_group}))", True


def _required_query_concepts(protocol: ResearchProtocol) -> list[dict[str, object]]:
    """Detect protocol concepts that are too important to omit from search."""
    haystack = " ".join(
        [
            protocol.research_question or "",
            protocol.pico.population or "",
            protocol.pico.intervention or "",
            protocol.pico.comparator or "",
            protocol.pico.outcome_primary or "",
        ]
    )
    normalized = _normalize_for_query_check(haystack)

    required: list[dict[str, object]] = []
    for concept in _ESSENTIAL_QUERY_CONCEPTS:
        triggers = tuple(str(t) for t in concept["triggers"])
        if any(_normalize_for_query_check(trigger) in normalized for trigger in triggers):
            required.append(concept)
    return required
