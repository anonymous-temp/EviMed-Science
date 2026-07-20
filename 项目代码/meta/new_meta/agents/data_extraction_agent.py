"""Data Extraction agent — structured extraction with evidence traceability and self-verification."""
from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from pydantic import BaseModel
from tqdm import tqdm

from new_meta.core.agent_base import BaseAgent
from new_meta.core.project import Project
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.core.extraction_review import apply_extraction_overrides, load_extraction_overrides
from new_meta.core.denominator_recovery import (
    integer_evidenced_in_text,
    recover_denominators_from_percentages,
)
from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.rct_design_reconciliation import reconcile_extracted_rct_designs
from new_meta.schemas.study import ConflictNote, ExtractedStudy, StudyCharacteristics, OutcomeData
from new_meta.prompts import extraction_prompts
from new_meta.agents.pdf_parser import get_page_for_position
from new_meta.config import LLM_MAX_TOKENS_EXTRACTION, MAX_WORKERS, MAX_CHECK_ROUNDS
from new_meta.tools.utils import paper_identity, safe_identifier


class ExtractionCheckResult(BaseModel):
    score: int  # 1-10
    issues: list[str] = []
    suggestions: list[str] = []


class OutcomeList(BaseModel):
    """Wrapper for structured extraction of outcomes."""
    outcomes: list[OutcomeData] = []
    quality_notes: str = ""


class DataExtractionAgent(BaseAgent):
    def __init__(self, model: str = None):
        super().__init__("data_extraction", extraction_prompts.SYSTEM_PROMPT, model=model)

    def run(
        self,
        included_papers: list[dict],
        parsed_papers: dict[str, dict],
        protocol: ResearchProtocol,
        project: Project,
    ) -> list[ExtractedStudy]:
        """Extract structured data from all included papers.

        Returns list of ExtractedStudy with evidence traceability.
        """
        self.log(f"Extracting data from {len(included_papers)} papers...")

        def extract_one(paper):
            paper_id = paper_identity(paper)
            parsed = parsed_papers.get(paper_id, {})
            return self._extract_single(paper, parsed, protocol, project)

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = {executor.submit(extract_one, p): p for p in included_papers}
            results = []
            for future in tqdm(as_completed(futures), total=len(futures), desc="Data Extraction", leave=False):
                try:
                    result = future.result()
                    if result:
                        results.append(result)
                except Exception as e:
                    paper = futures[future]
                    self.log(f"Extraction failed for {paper_identity(paper)}: {e}", level="warning")

        self.log(f"Successfully extracted data from {len(results)} papers")

        overrides = load_extraction_overrides(project)
        applied_overrides = apply_extraction_overrides(results, overrides)
        if applied_overrides:
            self.log(f"Applied {applied_overrides} user extraction override(s)")
            for item in results:
                sid = item.characteristics.pmid or item.characteristics.study_id
                if sid:
                    project.save_json(f"{safe_identifier(sid)}.json", item, subdir="extraction")

        design_reconciliation = reconcile_extracted_rct_designs(
            protocol,
            results,
            parsed_papers=parsed_papers,
        )
        project.save_json(
            "rct_design_reconciliation.json",
            design_reconciliation,
            subdir="extraction",
        )
        if design_reconciliation.get("changed"):
            project.save_json("protocol.json", protocol)
            for item in results:
                sid = item.characteristics.pmid or item.characteristics.study_id
                if sid:
                    project.save_json(f"{safe_identifier(sid)}.json", item, subdir="extraction")

        # Save all extractions
        project.save_json("all_extractions.json", results, subdir="extraction")
        audit = self._build_extraction_audit(results)
        audit["summary"]["overrides_revision"] = overrides.current_revision
        audit["summary"]["overrides_applied"] = applied_overrides
        project.save_json("extraction_audit.json", audit, subdir="extraction")
        project.save_text("extraction_audit.md", self._audit_to_markdown(audit), subdir="extraction")
        migrate_extractions_to_ledger(
            project,
            protocol=protocol,
            extracted_studies=results,
        )
        return results

    def _extract_single(
        self, paper: dict, parsed: dict, protocol: ResearchProtocol, project: Project
    ) -> ExtractedStudy | None:
        """Extract data from a single paper with self-verification loop."""
        paper_id = paper_identity(paper)
        pmid = paper.get("pmid", "")
        full_text = parsed.get("full_text", "")
        tables = parsed.get("tables", [])

        if paper.get("metadata_only") or paper.get("text_availability") == "metadata_only":
            self.log(
                f"Skipping extraction for metadata-only registry record {paper_id}; user full text is required.",
                level="warning",
            )
            project.add_warning(
                "extraction",
                "Skipped metadata-only registry record; outcome extraction requires user-uploaded full text or verified source data.",
                code="metadata_only_extraction_skipped",
                context={
                    "paper_id": paper_id,
                    "title": paper.get("title", ""),
                    "trial_registration": paper.get("trial_registration") or paper.get("nct_id") or "",
                },
            )
            return None

        if (
            paper.get("text_availability") == "abstract_only"
            or paper.get("fulltext_source") == "europe_pmc_abstract"
        ):
            self.log(
                f"Skipping extraction for abstract-only record {paper_id}; article full text is required.",
                level="warning",
            )
            project.add_warning(
                "extraction",
                "Skipped abstract-only record; quantitative outcome extraction requires article full text or verified source data.",
                code="abstract_only_extraction_skipped",
                context={
                    "paper_id": paper_id,
                    "title": paper.get("title", ""),
                    "fulltext_source": paper.get("fulltext_source", ""),
                },
            )
            return None

        if not full_text:
            self.log(
                f"Skipping extraction for {paper_id}; parsed article full text is unavailable.",
                level="warning",
            )
            project.add_warning(
                "extraction",
                "Skipped record because parsed article full text was unavailable; abstract metadata was not used for quantitative extraction.",
                code="parsed_full_text_missing",
                context={
                    "paper_id": paper_id,
                    "title": paper.get("title", ""),
                    "pdf_path": paper.get("pdf_path", ""),
                    "fulltext_path": paper.get("fulltext_path", ""),
                },
            )
            return None

        # Combine text and tables
        paper_content = full_text
        if tables:
            paper_content += "\n\n## EXTRACTED TABLES\n\n" + "\n\n".join(tables)

        # Truncate for token limit — keep head (context) + tail (results/tables)
        max_chars = 40000
        if len(paper_content) > max_chars:
            head = int(max_chars * 0.4)
            tail = max_chars - head - 30
            paper_content = paper_content[:head] + "\n\n[... middle sections omitted ...]\n\n" + paper_content[-tail:]

        # Step 1: Extract characteristics (with retry)
        char_prompt = extraction_prompts.CHARACTERISTICS_EXTRACTION_PROMPT.format(
            population=protocol.pico.population,
            intervention=protocol.pico.intervention,
            comparator=protocol.pico.comparator,
            study_design=protocol.study_design,
            paper_content=paper_content,
        )
        characteristics = self._extract_with_retry(char_prompt, StudyCharacteristics, paper_id)
        self._apply_paper_metadata(characteristics, paper, paper_id)

        # Step 2: Extract outcomes (with retry)
        secondary_str = ", ".join(protocol.pico.outcomes_secondary) if protocol.pico.outcomes_secondary else "None"
        outcome_prompt = extraction_prompts.OUTCOME_EXTRACTION_PROMPT.format(
            primary_outcome=protocol.pico.outcome_primary,
            secondary_outcomes=secondary_str,
            effect_measure=protocol.effect_measure,
            paper_content=paper_content,
        )

        outcome_data = self._extract_with_retry(outcome_prompt, OutcomeList, paper_id)

        extracted = ExtractedStudy(
            characteristics=characteristics,
            outcomes=outcome_data.outcomes,
            quality_notes=outcome_data.quality_notes,
        )

        # Step 3: Self-verification loop
        for check_round in range(MAX_CHECK_ROUNDS):
            try:
                check_result = self._check_extraction(paper_content, extracted)
            except Exception as e:
                self.log(f"[{paper_id}] Extraction check failed (round {check_round + 1}): {e}", level="warning")
                break  # keep current extraction, skip further rounds
            if check_result.score >= 7:
                self.log(f"[{paper_id}] Extraction verified (score: {check_result.score}/10, round {check_round + 1})")
                break
            else:
                self.log(f"[{paper_id}] Extraction needs improvement (score: {check_result.score}/10, round {check_round + 1})")
                extracted = self._refine_extraction(paper_content, extracted, check_result, protocol)

        # Step 4: Validate source quotes and resolve page numbers
        page_map = parsed.get("page_map", [])
        self._validate_source_quotes(extracted, paper_content, page_map)
        # Step 4b: Recover missing arm denominators from reported percentages.
        # Trials often quote arm events + percentages in prose while the per-arm
        # denominator sits in a table or refers to a subgroup; without the
        # denominator the row cannot be pooled. Recovery is deterministic and
        # guarded (recomputed percentage and any reported effect must match).
        for outcome in extracted.outcomes:
            try:
                recover_denominators_from_percentages(outcome)
            except Exception as exc:  # pragma: no cover - defensive
                self.log(f"[{paper_id}] Denominator recovery skipped: {exc}", level="warning")
        self._finalize_outcome_review_fields(extracted, protocol)

        # Save individual extraction
        sid = extracted.characteristics.pmid or extracted.characteristics.study_id or paper_id
        project.save_json(f"{safe_identifier(sid)}.json", extracted, subdir="extraction")
        return extracted

    @staticmethod
    def _has_real_value(value) -> bool:
        """Return True for metadata values that should override LLM-extracted values."""
        if value is None:
            return False
        if isinstance(value, str):
            return bool(value.strip()) and value.strip().lower() not in {"unknown", "nr", "n/a", "na"}
        if isinstance(value, list):
            return any(DataExtractionAgent._has_real_value(v) for v in value)
        if isinstance(value, int):
            return value > 0
        return bool(value)

    def _apply_paper_metadata(self, characteristics: StudyCharacteristics, paper: dict, paper_id: str) -> None:
        """Merge bibliographic metadata without overwriting PDF-extracted values with blanks.

        User-uploaded PDFs often arrive without PMID/authors/year. In those cases, keep
        the LLM-extracted bibliographic fields instead of replacing them with empty
        placeholders from the upload wrapper.
        """
        pmid = str(paper.get("pmid") or "").strip()
        characteristics.study_id = paper_id or characteristics.study_id

        if self._has_real_value(paper.get("title")):
            characteristics.title = paper.get("title", "")
        if self._has_real_value(paper.get("authors")):
            characteristics.authors = paper.get("authors", [])
        if self._has_real_value(paper.get("year")):
            characteristics.year = paper.get("year", 0)
        if self._has_real_value(paper.get("journal")):
            characteristics.journal = paper.get("journal", "")
        if self._has_real_value(paper.get("doi")):
            characteristics.doi = paper.get("doi", "")

        if pmid and not str(pmid).startswith("user_pdf_"):
            characteristics.pmid = pmid
        elif characteristics.pmid.startswith("user_pdf_"):
            characteristics.pmid = ""

        characteristics.pdf_path = paper.get("pdf_path", "") or characteristics.pdf_path
        characteristics.source_type = paper.get("source_type") or (
            "user_upload" if str(pmid).startswith("user_pdf_") or paper.get("pdf_path") else "database"
        )
        if self._has_real_value(paper.get("authors")) or self._has_real_value(paper.get("year")):
            characteristics.metadata_source = "bibliographic_metadata"
        elif characteristics.authors or characteristics.year:
            characteristics.metadata_source = "llm_extracted_from_pdf"
        else:
            characteristics.metadata_source = "missing"

    def _extract_with_retry(self, prompt: str, schema: type[BaseModel], pmid: str, max_retries: int = 2) -> BaseModel:
        """Call structured extraction with retry and simplified fallback."""
        for attempt in range(max_retries):
            try:
                return self.call_llm_structured(prompt, schema, max_tokens=LLM_MAX_TOKENS_EXTRACTION)
            except (ValueError, Exception) as e:
                self.log(f"[{pmid}] Structured extraction attempt {attempt + 1} failed: {e}", level="warning")
                if attempt < max_retries - 1:
                    continue

        # Fallback: use simpler prompt asking for minimal data
        self.log(f"[{pmid}] Falling back to simplified extraction", level="warning")
        try:
            simple_prompt = (
                f"Extract any available data from the following text as JSON.\n"
                f"Just fill in what you can find. For fields you cannot find, use null or empty string.\n"
                f"Respond ONLY with a valid JSON object.\n\n"
                f"Schema fields needed: {', '.join(schema.model_fields.keys())}\n\n"
                f"Text:\n{prompt[:15000]}"
            )
            return self.call_llm_structured(simple_prompt, schema, max_tokens=LLM_MAX_TOKENS_EXTRACTION)
        except Exception as e:
            self.log(f"[{pmid}] Simplified extraction also failed: {e}", level="warning")
            # Last resort: return empty/default instance with extraction_failed marker
            try:
                obj = schema.model_construct()
            except Exception:
                obj = schema()
            # Mark as failed so downstream can distinguish "no data" from "extraction failed"
            if isinstance(obj, OutcomeList):
                obj.quality_notes = "EXTRACTION_FAILED"
            elif hasattr(obj, 'quality_notes'):
                obj.quality_notes = "EXTRACTION_FAILED"
            self.log(f"[{pmid}] Marked as EXTRACTION_FAILED", level="warning")
            return obj

    def _check_extraction(self, paper_content: str, extracted: ExtractedStudy) -> ExtractionCheckResult:
        """Verify extraction quality."""
        prompt = extraction_prompts.EXTRACTION_CHECK_PROMPT.format(
            paper_content=paper_content[:20000],
            extracted_data=json.dumps(extracted.model_dump(), indent=2, ensure_ascii=False),
        )
        return self.call_llm_structured(prompt, ExtractionCheckResult, max_tokens=4096)

    def _refine_extraction(
        self, paper_content: str, current: ExtractedStudy,
        check_result: ExtractionCheckResult, protocol: ResearchProtocol,
    ) -> ExtractedStudy:
        """Re-extract with feedback from the checker."""
        feedback = "\n".join(f"- {s}" for s in check_result.suggestions)
        prompt = (
            f"The previous extraction had these issues:\n{feedback}\n\n"
            f"Please re-extract the data more carefully, addressing each issue.\n\n"
            f"Paper content:\n{paper_content[:30000]}\n\n"
            f"Previous extraction:\n{json.dumps(current.model_dump(), indent=2, ensure_ascii=False)}\n\n"
            f"Protocol — Primary outcome: {protocol.pico.outcome_primary}, "
            f"Effect measure: {protocol.effect_measure}"
        )
        try:
            refined = self.call_llm_structured(prompt, ExtractedStudy)
            # Preserve metadata
            refined.characteristics.study_id = current.characteristics.study_id
            refined.characteristics.title = current.characteristics.title
            refined.characteristics.authors = current.characteristics.authors
            refined.characteristics.doi = current.characteristics.doi
            refined.characteristics.pmid = current.characteristics.pmid
            refined.characteristics.year = current.characteristics.year
            refined.characteristics.journal = current.characteristics.journal
            return refined
        except Exception:
            return current

    def _validate_source_quotes(
        self, extracted: ExtractedStudy, source_text: str, page_map: list[dict]
    ) -> None:
        """Verify source_quote exists in text and resolve source_page from character position.

        Modifies extracted in place.
        """
        if not source_text:
            return

        for outcome in extracted.outcomes:
            quote = outcome.source_quote
            if quote and len(quote) > 10:
                pos, match_text = self._find_quote(source_text, quote)
                outcome.source_quote_verified = pos >= 0
                if match_text:
                    outcome.source_quote_match = match_text[:240]

                if pos >= 0 and outcome.source_page is None:
                    page = get_page_for_position(pos, page_map) if page_map else None
                    if page is None:
                        page = self._nearest_page_marker(source_text, pos)
                    outcome.source_page = page

                # Fallback: a quote the LLM lightly reformatted ("14 (11%)" -> "14/133
                # (11%)") or that spells out a count ("Eight out of 56") fails a verbatim
                # match even though the data is plainly in the source. Treat the row as
                # verified when every reported 2x2 count is evidenced (digit or English
                # word) in the source text — the numbers are what need verifying.
                if not outcome.source_quote_verified and self._counts_evidenced_in_source(outcome, source_text):
                    outcome.source_quote_verified = True
                    note = "verified by numeric presence of all reported counts in source text"
                    outcome.source_quote_match = (
                        f"{outcome.source_quote_match} | {note}" if outcome.source_quote_match else note
                    )
            elif quote:
                outcome.source_quote_verified = False

    @staticmethod
    def _counts_evidenced_in_source(outcome: OutcomeData, source_text: str) -> bool:
        """True when a near-complete 2x2 is evidenced in one local source window."""
        counts = [
            outcome.events_intervention, outcome.total_intervention,
            outcome.events_control, outcome.total_control,
        ]
        present = [value for value in counts if value is not None]
        if len(present) < 3:
            return False
        window_size = 1600
        stride = window_size // 2
        text = str(source_text or "")
        if len(text) <= window_size:
            return all(integer_evidenced_in_text(value, text) for value in present)
        for start in range(0, len(text), stride):
            window = text[start:start + window_size]
            if all(integer_evidenced_in_text(value, window) for value in present):
                return True
            if start + window_size >= len(text):
                break
        return False

    @staticmethod
    def _find_quote(text: str, quote: str) -> tuple[int, str]:
        """Find a source quote with tolerance for whitespace and ellipses."""
        pos = text.find(quote)
        if pos >= 0:
            return pos, quote

        raw_candidates = [quote]
        for sep in ("...", "…", "[...]", "[ … ]"):
            if sep in quote:
                raw_candidates.extend(part.strip() for part in quote.split(sep) if len(part.strip()) >= 20)
        compact = " ".join(quote.split())
        if len(compact) >= 80:
            raw_candidates.append(compact[:120])
        if len(compact) >= 50:
            raw_candidates.append(compact[:80])
        raw_candidates.append(compact[:50])

        for candidate in raw_candidates:
            candidate = " ".join(candidate.split()).strip()
            if len(candidate) < 20:
                continue
            pattern = r"\s+".join(re.escape(part) for part in candidate.split())
            match = re.search(pattern, text, flags=re.IGNORECASE)
            if match:
                return match.start(), match.group(0)
        numeric_match = DataExtractionAgent._find_quote_by_numeric_window(text, quote)
        if numeric_match:
            return numeric_match
        return -1, ""

    @staticmethod
    def _find_quote_by_numeric_window(text: str, quote: str) -> tuple[int, str] | None:
        """Find quotes whose sentence was interrupted by PDF side-column text."""
        numbers = list(dict.fromkeys(re.findall(r"\d+(?:\.\d+)?", quote or "")))
        if len(numbers) < 4:
            return None
        first = numbers[0]
        quote_lower = (quote or "").lower()
        required_phrases = [
            phrase
            for phrase in ("hazard ratio", "confidence interval", "primary outcome", "event occurred")
            if phrase in quote_lower
        ]
        for match in re.finditer(rf"(?<!\d){re.escape(first)}(?!\d)", text, flags=re.IGNORECASE):
            start = max(0, match.start() - 300)
            end = min(len(text), match.start() + 1500)
            window = text[start:end]
            window_lower = window.lower()
            present_numbers = sum(
                1 for number in numbers
                if re.search(rf"(?<!\d){re.escape(number)}(?!\d)", window)
            )
            enough_numbers = present_numbers >= min(len(numbers), 6)
            enough_phrases = not required_phrases or any(phrase in window_lower for phrase in required_phrases)
            if enough_numbers and enough_phrases:
                return match.start(), window[:240]
        return None

    @staticmethod
    def _nearest_page_marker(text: str, pos: int) -> int | None:
        markers = list(re.finditer(r"\[PAGE\s+(\d+)\]", text[:pos + 1], flags=re.IGNORECASE))
        if not markers:
            return None
        return int(markers[-1].group(1))

    def _finalize_outcome_review_fields(self, extracted: ExtractedStudy, protocol: ResearchProtocol) -> None:
        """Fill confidence defaults and add deterministic review flags."""
        for outcome in extracted.outcomes:
            outcome.extraction_confidence = self._normalize_confidence(outcome)
            self._flag_internal_conflicts(outcome, protocol)

    @staticmethod
    def _normalize_confidence(outcome: OutcomeData) -> str:
        conf = (outcome.extraction_confidence or "").strip().lower()
        if conf in {"high", "medium", "low"}:
            return conf

        has_value = DataExtractionAgent._outcome_value_summary(outcome) != "no quantitative values"
        if not has_value:
            return "low"
        if outcome.source_quote_verified is True and outcome.source_page is not None:
            return "high"
        if outcome.source_quote_verified is True:
            return "medium"
        if outcome.source_quote_verified is False or not outcome.source_quote:
            return "low"
        return "medium"

    @staticmethod
    def _add_conflict(outcome: OutcomeData, note: ConflictNote) -> None:
        key = (note.field, note.message)
        existing = {(item.field, item.message) for item in outcome.conflicts}
        if key not in existing:
            outcome.conflicts.append(note)

    def _flag_internal_conflicts(self, outcome: OutcomeData, protocol: ResearchProtocol) -> None:
        """Detect obvious within-row numeric contradictions before downstream analysis."""
        if (
            outcome.events_intervention is not None
            and outcome.total_intervention is not None
            and outcome.events_intervention > outcome.total_intervention
        ):
            self._add_conflict(outcome, ConflictNote(
                field="events_intervention",
                severity="error",
                message="events_intervention exceeds total_intervention",
                observed_values={
                    "events_intervention": outcome.events_intervention,
                    "total_intervention": outcome.total_intervention,
                },
            ))
        if (
            outcome.events_control is not None
            and outcome.total_control is not None
            and outcome.events_control > outcome.total_control
        ):
            self._add_conflict(outcome, ConflictNote(
                field="events_control",
                severity="error",
                message="events_control exceeds total_control",
                observed_values={
                    "events_control": outcome.events_control,
                    "total_control": outcome.total_control,
                },
            ))

        measure = (protocol.effect_measure or "").upper()
        if (
            measure in {"MD", "SMD"}
            and outcome.effect_size is not None
            and outcome.mean_intervention is not None
            and outcome.mean_control is not None
        ):
            raw_md = outcome.mean_intervention - outcome.mean_control
            tolerance = max(0.05, abs(raw_md) * 0.1)
            if abs(outcome.effect_size - raw_md) > tolerance:
                self._add_conflict(outcome, ConflictNote(
                    field="effect_size",
                    severity="warning",
                    message="reported effect_size differs from intervention-control mean difference",
                    observed_values={
                        "effect_size": outcome.effect_size,
                        "mean_intervention_minus_control": raw_md,
                    },
                    sources=[outcome.source_location] if outcome.source_location else [],
                ))

    @staticmethod
    def _outcome_value_summary(outcome: OutcomeData) -> str:
        parts = []
        if outcome.effect_size is not None:
            parts.append(f"effect={outcome.effect_size}")
            if outcome.ci_lower is not None and outcome.ci_upper is not None:
                parts.append(f"95% CI {outcome.ci_lower}-{outcome.ci_upper}")
        if outcome.mean_intervention is not None or outcome.mean_control is not None:
            parts.append(
                f"I mean/SD/N={outcome.mean_intervention}/{outcome.sd_intervention}/{outcome.n_intervention}"
            )
            parts.append(
                f"C mean/SD/N={outcome.mean_control}/{outcome.sd_control}/{outcome.n_control}"
            )
        if outcome.median_intervention is not None or outcome.median_control is not None:
            parts.append(
                f"I median(Q1,Q3)/N={outcome.median_intervention}({outcome.q1_intervention},{outcome.q3_intervention})/{outcome.n_intervention}"
            )
            parts.append(
                f"C median(Q1,Q3)/N={outcome.median_control}({outcome.q1_control},{outcome.q3_control})/{outcome.n_control}"
            )
        if outcome.events_intervention is not None or outcome.events_control is not None:
            parts.append(f"I events/total={outcome.events_intervention}/{outcome.total_intervention}")
            parts.append(f"C events/total={outcome.events_control}/{outcome.total_control}")
        if outcome.hazard_ratio is not None:
            parts.append(f"HR={outcome.hazard_ratio}")
        if outcome.p_value is not None:
            parts.append(f"p={outcome.p_value}")
        return "; ".join(parts) if parts else "no quantitative values"

    @classmethod
    def _build_extraction_audit(cls, studies: list[ExtractedStudy]) -> dict:
        rows = []
        for study in studies:
            c = study.characteristics
            sid = c.pmid or c.study_id
            for outcome_index, outcome in enumerate(study.outcomes):
                requires_review = (
                    outcome.source_quote_verified is False
                    or outcome.extraction_confidence == "low"
                    or bool(outcome.conflicts)
                    or not outcome.source_quote
                )
                rows.append({
                    "row_id": f"{sid}:{outcome_index}",
                    "study_id": sid,
                    "outcome_index": outcome_index,
                    "study_label": f"{(c.authors[0].split()[0] if c.authors else 'Unknown')} {c.year or 'NR'}",
                    "title": c.title,
                    "outcome_name": outcome.outcome_name,
                    "outcome_type": outcome.outcome_type,
                    "value_summary": cls._outcome_value_summary(outcome),
                    "source_location": outcome.source_location,
                    "source_page": outcome.source_page,
                    "source_section": outcome.source_section,
                    "source_quote_verified": outcome.source_quote_verified,
                    "source_quote_match": outcome.source_quote_match,
                    "source_quote": outcome.source_quote,
                    "extraction_confidence": outcome.extraction_confidence,
                    "timepoint": outcome.timepoint,
                    "accepted_timepoint": outcome.accepted_timepoint,
                    "timepoint_adjudication": outcome.timepoint_adjudication,
                    "timepoint_adjudication_note": outcome.timepoint_adjudication_note,
                    "manual_adjudication": outcome.manual_adjudication,
                    "conflicts": [item.model_dump() for item in outcome.conflicts],
                    "requires_review": requires_review,
                    "user_override_applied": outcome.user_override_applied,
                    "override_revision": outcome.override_revision,
                    "quality_notes": study.quality_notes,
                })
        verified = sum(1 for row in rows if row["source_quote_verified"] is True)
        unverified = sum(1 for row in rows if row["source_quote_verified"] is False)
        unknown = len(rows) - verified - unverified
        confidence_counts = {
            "high": sum(1 for row in rows if row.get("extraction_confidence") == "high"),
            "medium": sum(1 for row in rows if row.get("extraction_confidence") == "medium"),
            "low": sum(1 for row in rows if row.get("extraction_confidence") == "low"),
        }
        return {
            "summary": {
                "studies": len(studies),
                "outcomes": len(rows),
                "source_quotes_verified": verified,
                "source_quotes_unverified": unverified,
                "source_quotes_not_checked": unknown,
                "confidence": confidence_counts,
                "rows_requiring_review": sum(1 for row in rows if row["requires_review"]),
                "conflict_rows": sum(1 for row in rows if row["conflicts"]),
            },
            "rows": rows,
        }

    @staticmethod
    def _audit_to_markdown(audit: dict) -> str:
        summary = audit.get("summary", {})
        lines = [
            "# Data Extraction Audit",
            "",
            f"- Studies extracted: {summary.get('studies', 0)}",
            f"- Outcomes extracted: {summary.get('outcomes', 0)}",
            f"- Source quotes verified: {summary.get('source_quotes_verified', 0)}",
            f"- Source quotes unverified: {summary.get('source_quotes_unverified', 0)}",
            f"- Source quotes not checked: {summary.get('source_quotes_not_checked', 0)}",
            f"- Rows requiring review: {summary.get('rows_requiring_review', 0)}",
            f"- Override revision: {summary.get('overrides_revision', 0)}",
            "",
            "| Study | Outcome | Values | Source | Confidence | Quote verified | Review |",
            "|---|---|---|---|---|---|---|",
        ]
        for row in audit.get("rows", []):
            source = f"{row.get('source_location') or 'NR'}"
            if row.get("source_page"):
                source += f", p. {row['source_page']}"
            verified = row.get("source_quote_verified")
            verified_text = "yes" if verified is True else "no" if verified is False else "not checked"
            review_text = "yes" if row.get("requires_review") else "no"
            lines.append(
                "| {study} | {outcome} | {values} | {source} | {confidence} | {verified} | {review} |".format(
                    study=str(row.get("study_label", "")).replace("|", "/"),
                    outcome=str(row.get("outcome_name", "")).replace("|", "/"),
                    values=str(row.get("value_summary", "")).replace("|", "/")[:180],
                    source=source.replace("|", "/"),
                    confidence=str(row.get("extraction_confidence") or "NR").replace("|", "/"),
                    verified=verified_text,
                    review=review_text,
                )
            )
        return "\n".join(lines) + "\n"
