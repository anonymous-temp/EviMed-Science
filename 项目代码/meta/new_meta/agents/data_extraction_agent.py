"""Data Extraction agent — structured extraction with evidence traceability and self-verification."""
from __future__ import annotations

import json
import hashlib
import re
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any
from uuid import uuid4
from pydantic import BaseModel, ConfigDict, Field
from tqdm import tqdm

from new_meta.core.agent_base import BaseAgent
from new_meta.core.extraction_status import extraction_failure, extraction_incomplete
from new_meta.core.project import Project
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.core.extraction_review import apply_extraction_overrides, load_extraction_overrides
from new_meta.core.denominator_recovery import (
    integer_evidenced_in_text,
    recover_denominators_from_percentages,
)
from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.rct_design_reconciliation import reconcile_extracted_rct_designs
from new_meta.schemas.study import ConflictNote, ExtractedStudy, ExtractionDataIssue, StudyCharacteristics, OutcomeData, PrimaryAlignmentAssessment
from new_meta.prompts import extraction_prompts
from new_meta.agents.pdf_parser import get_page_for_position
from new_meta.config import LLM_MAX_TOKENS_EXTRACTION, MAX_WORKERS, MAX_CHECK_ROUNDS
from new_meta.tools.utils import paper_identity, safe_identifier


class ExtractionCheckResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    score: int = Field(ge=1, le=10)  # Advisory only; never overrides source checks.
    issues: list[str] = Field(default_factory=list, description="Advisory observations only. Every actual row-data defect must be in data_issues; clinical fit belongs in primary_analysis_alignment.")
    data_issues: list[ExtractionDataIssue] = Field(max_length=128, description="Required, possibly empty list of actual defects in the supplied indexed rows only. Never include omitted other study outcomes or clinical mismatch here.")
    suggestions: list[str] = []
    primary_analysis_alignment: list[PrimaryAlignmentAssessment] = []


class IndexedOutcomeCorrection(BaseModel):
    outcome_index: int = Field(ge=0, strict=True)
    outcome: OutcomeData


class ExtractionRefinement(BaseModel):
    outcomes: list[IndexedOutcomeCorrection]


VERIFICATION_BATCH_SIZE = 4
VERIFICATION_SOURCE_CHAR_LIMIT = 128_000


class OutcomeList(BaseModel):
    """Wrapper for structured extraction of outcomes."""
    outcomes: list[OutcomeData] = []
    quality_notes: str = ""


class StudyExtractionFailed(RuntimeError):
    """Structured extraction exhausted retries without manufacturing a record."""

    def __init__(self, study_id, schema_name, attempts, *, code="structured_extraction_failed", retryable=True):
        self.failure = extraction_failure(
            study_id, code, retryable=retryable,
            schema=schema_name, attempts=attempts,
        )
        super().__init__(f"{study_id}: {schema_name} extraction incomplete ({code})")


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

        verification_inputs = {}
        failures = []
        required_ids = {paper_identity(paper) for paper in included_papers}
        previous_status = project.load_json("extraction_status.json", subdir="extraction") or {}
        if previous_status.get("status") not in {None, "succeeded"}:
            prior_ids = set(previous_status.get("data", {}).get("required_study_ids", []))
            screening = project.load_json("full_text_screening.json", subdir="screening") or []
            excluded_ids = {paper_identity(row["paper"]) for row in screening
                            if row.get("decision") == "exclude" and isinstance(row.get("paper"), dict)}
            missing_ids = prior_ids - required_ids - excluded_ids
            prior_failures = {row["study_id"]: row for row in previous_status.get("data", {}).get("failures", [])}
            failures.extend(prior_failures.get(sid) or extraction_failure(sid, "required_study_extraction_missing")
                            for sid in sorted(missing_ids))
            required_ids.update(missing_ids)
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = {executor.submit(extract_one, p): p for p in included_papers}
            results = []
            for future in tqdm(as_completed(futures), total=len(futures), desc="Data Extraction", leave=False):
                try:
                    result = future.result()
                    paper = futures[future]
                    if result and result.outcomes and "EXTRACTION_FAILED" not in result.quality_notes:
                        results.append(result)
                        verification_inputs[id(result)] = (paper, parsed_papers.get(paper_identity(paper), {}))
                    else:
                        code = ("extraction_failed" if result and "EXTRACTION_FAILED" in result.quality_notes
                                else "extraction_outcomes_empty" if result else "extraction_source_unavailable")
                        failures.append(extraction_failure(
                            paper_identity(paper), code, retryable=code == "extraction_failed",
                        ))
                except Exception as e:
                    paper = futures[future]
                    self.log(f"Extraction failed for {paper_identity(paper)}: {type(e).__name__}", level="warning")
                    failures.append(e.failure if isinstance(e, StudyExtractionFailed) else extraction_failure(
                        paper_identity(paper), "study_extraction_failed", retryable=True, error_type=type(e).__name__,
                    ))

        if failures:
            # Preserve the completed source extractions before raising. They remain
            # unverified until the full phase can finish its independent checks.
            project.save_json("all_extractions.json", results, subdir="extraction")
            audit = self._build_extraction_audit(results)
            audit["summary"].update({"status": "incomplete", "required_studies": len(required_ids),
                                     "incomplete_studies": len(failures)})
            audit["failures"] = failures
            project.save_json("extraction_audit.json", audit, subdir="extraction")
            project.save_text("extraction_audit.md", self._audit_to_markdown(audit), subdir="extraction")
            raise extraction_incomplete(
                project, failures,
                completed_ids=[study.characteristics.study_id for study in results],
                required_ids=sorted(required_ids),
            )

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

        # The existing independent verification pass sees reconciled clinical fields.
        # It is not a second extraction call or an extra model review layer.
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            checked = list(executor.map(
                lambda study: self._verify_alignment(
                    study, *verification_inputs[id(study)], protocol, project,
                ),
                results,
            ))
        results = checked
        # Refinement may change clinical fields. Reconciliation is deterministic;
        # changed rows/protocol will invalidate the preceding check, never rebind it.
        reconcile_extracted_rct_designs(protocol, results, parsed_papers=parsed_papers)
        for study in results:
            sid = study.characteristics.pmid or study.characteristics.study_id
            project.save_json(f"{safe_identifier(sid)}.json", study, subdir="extraction")

        # Save all extractions
        project.save_json("all_extractions.json", results, subdir="extraction")
        audit = self._build_extraction_audit(results)
        audit["summary"]["overrides_revision"] = overrides.current_revision
        audit["summary"]["overrides_applied"] = applied_overrides
        project.save_json("extraction_audit.json", audit, subdir="extraction")
        project.save_text("extraction_audit.md", self._audit_to_markdown(audit), subdir="extraction")
        migration = migrate_extractions_to_ledger(
            project,
            protocol=protocol,
            extracted_studies=results,
        )
        # A dropped dependency-design result changes what the review pools, so
        # it is reported where a reader will meet it rather than left in a
        # return value nobody read.
        for skipped in migration.skipped_results:
            self.log(
                "Dropped %s from the evidence ledger: a %s result is missing %s and cannot be pooled."
                % (skipped["resultId"], skipped["design"], ", ".join(skipped["missing"])),
                level="warning",
            )
            project.add_warning(
                "extraction",
                "A %s result was excluded from the meta-analysis because it is missing %s; pooling it as an "
                "ordinary two-arm aggregate would overstate its precision."
                % (skipped["design"], ", ".join(skipped["missing"])),
                code="dependency_metadata_incomplete",
                context=skipped,
            )
        from new_meta.schemas.phase_result import PhaseResult
        project.save_json("extraction_status.json", PhaseResult(
            run_id=project.base_dir.name, status="succeeded", phase="extraction",
            summary="Extraction completed for every required study.",
            data={"required_study_ids": [paper_identity(paper) for paper in included_papers]},
        ), subdir="extraction")
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

        # Extraction and verification must see the same complete bounded source.
        # Silently dropping the middle removes Results while retaining discussion.
        if len(paper_content) > VERIFICATION_SOURCE_CHAR_LIMIT:
            error = StudyExtractionFailed(
                paper_id, "source_context", [], code="extraction_source_context_unavailable", retryable=False,
            )
            error.failure.update({"source_chars": len(paper_content), "source_char_limit": VERIFICATION_SOURCE_CHAR_LIMIT})
            raise error

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
            population=protocol.pico.population,
            intervention=protocol.pico.intervention,
            comparator=protocol.pico.comparator,
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

        # Model output cannot create runtime verification provenance.
        for outcome in extracted.outcomes:
            outcome.primary_analysis_alignment = None

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
        from new_meta.core.primary_analysis_alignment import (
            _read_scoped, invalidate_alignment_proofs, recover_issue_history,
        )
        try:
            previous = ExtractedStudy.model_validate(json.loads(_read_scoped(
                project, f"extraction/{safe_identifier(sid)}.json")))
        except FileNotFoundError:
            previous = None
        except (OSError, ValueError):
            # The persisted existence check in recover_issue_history will mark
            # unreadable or malformed prior provenance as incomplete.
            previous = None
        if previous is not None:
            # A fresh extraction is not permission to forget an earlier defect.
            # Preserve the prior row's issue origin; changed values still need
            # fresh independent verification, and source conflicts remain blocked.
            for index, outcome in enumerate(extracted.outcomes):
                if index < len(previous.outcomes):
                    outcome.primary_analysis_alignment = previous.outcomes[index].primary_analysis_alignment
        histories = {index: recover_issue_history(project, extracted, index, allow_new=True)
                     for index in range(len(extracted.outcomes))}
        invalidate_alignment_proofs(project, protocol, extracted, histories,
                                    reason="Initial extraction awaits independent verification.")
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
        characteristics.source_type = self._source_type(paper)
        if self._has_real_value(paper.get("authors")) or self._has_real_value(paper.get("year")):
            characteristics.metadata_source = "bibliographic_metadata"
        elif characteristics.authors or characteristics.year:
            characteristics.metadata_source = "llm_extracted_from_pdf"
        else:
            characteristics.metadata_source = "missing"

    @staticmethod
    def _source_type(paper: dict) -> str:
        """Use ingestion metadata, never an LLM label or a local path, for origin."""
        origin = str(paper.get("fulltext_source") or "").strip().lower()
        if paper.get("user_uploaded_full_text") is True or origin == "user_upload":
            return "user_upload"
        source_type = str(paper.get("source_type") or "").strip()
        if source_type:
            return source_type
        if str(paper.get("pmid") or "").startswith("user_pdf_"):
            return "user_upload"
        if origin in {"pdf", "europe_pmc_fulltext", "europe_pmc_html", "registry_seed_source_pdf", "registry_seed_source"}:
            return "database"
        if paper.get("retrieval_sources"):
            return "database"
        return "unknown"

    def _extract_with_retry(self, prompt: str, schema: type[BaseModel], pmid: str, max_retries: int = 2) -> BaseModel:
        """Call structured extraction with retry and simplified fallback."""
        attempts = []

        def record_failure(error, attempt):
            # Provider bodies and source text may contain private data. Preserve
            # stable diagnostic types/status codes, not arbitrary exception prose.
            attempts.append({"attempt": attempt, "error_type": type(error).__name__,
                             "status_code": getattr(error, "status_code", None)})

        for attempt in range(max_retries):
            try:
                return self.call_llm_structured(prompt, schema, max_tokens=LLM_MAX_TOKENS_EXTRACTION)
            except Exception as e:
                record_failure(e, attempt + 1)
                self.log(f"[{pmid}] Structured extraction attempt {attempt + 1} failed: {type(e).__name__}", level="warning")
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
                f"Text:\n{prompt}"
            )
            return self.call_llm_structured(simple_prompt, schema, max_tokens=LLM_MAX_TOKENS_EXTRACTION)
        except Exception as e:
            record_failure(e, "simplified")
            self.log(f"[{pmid}] Simplified extraction also failed: {type(e).__name__}", level="warning")
            raise StudyExtractionFailed(pmid, schema.__name__, attempts) from e

    def _check_extraction(
        self, paper_content: str, extracted: ExtractedStudy, protocol: ResearchProtocol,
        outcome_indices: list[int] | None = None, feedback: list[dict[str, Any]] | None = None,
        on_raw_response=None,
    ) -> ExtractionCheckResult:
        """Check original-indexed rows against the full bounded source snapshot."""
        from new_meta.core.extraction_verification import CHECKER_HIDDEN_FIELDS, numeric_fields
        indices = list(range(len(extracted.outcomes))) if outcome_indices is None else outcome_indices
        data = {"characteristics": extracted.characteristics.model_dump(mode="json"),
                "indexed_outcomes": [{"outcome_index": index,
                    "outcome": extracted.outcomes[index].model_dump(mode="json", exclude=CHECKER_HIDDEN_FIELDS),
                    "numeric_fields_to_verify": numeric_fields(extracted.outcomes[index])} for index in indices]}
        prompt = extraction_prompts.EXTRACTION_CHECK_PROMPT.format(
            paper_content=paper_content, protocol=protocol.model_dump_json(),
            extracted_data=json.dumps(data, ensure_ascii=False),
        )
        prompt += "\nExpected original outcome indices: " + json.dumps(indices)
        if feedback:
            prompt += "\nPrevious response validation errors (repair judgments; do not alter source data):\n" + json.dumps(feedback, ensure_ascii=False)
        return self.llm.structured_output(
            [{"role": "system", "content": self.system_prompt}, {"role": "user", "content": prompt}],
            ExtractionCheckResult, max_tokens=LLM_MAX_TOKENS_EXTRACTION,
            source_faithful=True, on_raw_response=on_raw_response,
        )

    def _verify_alignment(self, extracted: ExtractedStudy, paper: dict, parsed: dict,
                          protocol: ResearchProtocol, project: Project) -> ExtractedStudy:
        from new_meta.core.extraction_verification import (
            refinement_indices, unresolved_issue_errors, update_issue_history,
            validate_check_batch, validate_data_issues, verification_verdict,
        )
        from new_meta.core.primary_analysis_alignment import (
            _PROOF_DIR, _read_scoped, _write_scoped_atomic, _write_scoped_once, digest, protocol_fingerprint,
            invalidate_alignment_proofs, record_checked_alignments, recover_issue_history, row_fingerprint,
        )
        content = str(parsed.get("full_text") or "")
        if parsed.get("tables"):
            content += "\n\n## EXTRACTED TABLES\n\n" + "\n\n".join(parsed["tables"])
        histories = {index: recover_issue_history(project, extracted, index, allow_new=True)
                     for index in range(len(extracted.outcomes))}
        invalidate_alignment_proofs(project, protocol, extracted, histories,
                                    reason="A fresh independent verification has not completed.")
        source_path = paper.get("pdf_path") or paper.get("fulltext_path") or None
        source_before = None
        source_sha = hashlib.sha256(content.encode()).hexdigest() if source_path is None else ""
        study_id = extracted.characteristics.pmid or extracted.characteristics.study_id
        checked_sha = hashlib.sha256(content.encode()).hexdigest()
        protocol_sha = protocol_fingerprint(protocol)
        verification_id = uuid4().hex

        def persist_pending_extraction():
            # Use the existing per-study checkpoint. An interruption after an
            # observed defect must not resume from the earlier issue-free row.
            _write_scoped_atomic(project, f"extraction/{safe_identifier(study_id)}.json",
                                 extracted.model_dump_json(indent=2).encode())

        persist_pending_extraction()

        def record_attempt(batch, attempt, status, errors, checked=None, snapshot=None,
                           raw_response=None, retained_data_issues=None, retained_clinical_judgments=None):
            payload = {"schema_version": 1, "study_id": study_id, "outcome_indices": batch,
                "verification_id": verification_id,
                "attempt": attempt, "status": status, "source_sha256": source_sha,
                "checked_source_sha256": checked_sha, "source_characters": len(content),
                "protocol_sha256": protocol_sha, "row_sha256": snapshot or {},
                "response": checked.model_dump(mode="json") if checked else None,
                "reasons": errors, "assessor": "extraction-check-v2", "assessor_id": self.llm.model}
            if raw_response is not None:
                raw_content = raw_response.get("content")
                payload.update({"raw_response": dict(raw_response),
                    "raw_response_sha256": hashlib.sha256(raw_content.encode()).hexdigest() if isinstance(raw_content, str) else None,
                    "retained_data_issues": retained_data_issues or [],
                    "retained_clinical_judgments": retained_clinical_judgments or []})
            if checked:
                payload["row_verdicts"] = {str(item.outcome_index): verification_verdict(item, protocol)
                                           for item in checked.primary_analysis_alignment}
            encoded = json.dumps(payload, ensure_ascii=False, indent=2).encode()
            if len(encoded) > 1024 * 1024:
                raise ValueError("Verification diagnostic exceeds its bounded artifact size")
            _write_scoped_once(project, f"extraction/verification/{digest(payload)}.json", encoded)

        indices = list(range(len(extracted.outcomes)))
        if not indices:
            return extracted
        if source_path is not None:
            source_path = Path(source_path)
            try:
                relative_source = source_path.absolute().relative_to(project.base_dir.absolute()).as_posix()
                source_before = _read_scoped(project, relative_source)
                source_sha = hashlib.sha256(source_before).hexdigest()
                if parsed.get("_source_sha256") != source_sha:
                    raise ValueError("Parsed source version does not match current document")
            except (OSError, ValueError) as exc:
                record_attempt(indices, 0, "needs_input", [{"code": "verification_source_version_invalid", "error_type": type(exc).__name__}])
                return extracted
        if not content.strip() or len(content) > VERIFICATION_SOURCE_CHAR_LIMIT:
            record_attempt(indices, 0, "needs_input", [{"code": "verification_source_context_unavailable",
                "source_characters": len(content), "limit": VERIFICATION_SOURCE_CHAR_LIMIT}])
            return extracted
        _write_scoped_once(project, f"{_PROOF_DIR}/{checked_sha}.txt", content.encode())
        assessments, checked_rows, pending_reasons = {}, {}, {}
        for start in range(0, len(indices), VERIFICATION_BATCH_SIZE):
            batch = indices[start:start + VERIFICATION_BATCH_SIZE]
            feedback = []
            for round_index in range(MAX_CHECK_ROUNDS):
                snapshot = {index: row_fingerprint(extracted, index) for index in batch}
                checked = None
                data_errors = []
                terminal_observation = False
                observation_errors = []
                observed_negative_rows = set()

                def persist_observation_pending():
                    # This attempt alone owns the temporary incomplete marker.
                    # Keep the original history flags in memory; the normal
                    # completion path may restore those flags, never older ones.
                    pending = {index: (issues, False if index in batch else available)
                               for index, (issues, available) in histories.items()}
                    invalidate_alignment_proofs(project, protocol, extracted, pending,
                        reason="Independent verification is awaiting durable observation completion.")

                def observe(raw_response):
                    nonlocal terminal_observation, observation_errors
                    from new_meta.core.extraction_observations import inspect_extraction_observation
                    try:
                        observation = inspect_extraction_observation(raw_response["content"],
                            ExtractionCheckResult, extracted, batch, content, protocol)
                        observation_errors = observation["errors"]
                        retained = [item for item in observation["data_errors"] if item["code"] in {
                            "row_data_issue", "row_source_conflict_requires_adjudication"}]
                        stable = (protocol_fingerprint(protocol) == protocol_sha and all(
                            row_fingerprint(extracted, index) == fingerprint for index, fingerprint in snapshot.items()))
                        if not stable:
                            retained = []
                            observation_errors.append({"code": "verification_inputs_changed_during_observation"})
                        update_issue_history(extracted, batch, histories, retained,
                            source_sha256=source_sha, checked_source_sha256=checked_sha, protocol_sha256=protocol_sha,
                            checked_rows=snapshot, complete_current_check=set())
                        negative_rows = {item["outcome_index"] for item in observation["clinical_negatives"]}
                        observed_negative_rows.update(negative_rows)
                        incomplete = (bool(observation_errors) or raw_response["finish_reason"] == "length"
                                      or observation["response"] is None)
                        if negative_rows and incomplete:
                            terminal_observation = True
                            for index in negative_rows:
                                histories[index] = histories[index][0], False
                            observation_errors.append({"code": "verification_partial_clinical_judgment_retained",
                                                       "outcome_indices": sorted(negative_rows)})
                        # Commit retained issues and an incomplete checkpoint first.
                        # A crash at any later raw/proof write cannot expose the
                        # earlier clean checkpoint as current verification history.
                        persist_observation_pending()
                        record_attempt(batch, round_index + 1, "observed", observation_errors,
                            checked=observation["response"], snapshot=snapshot, raw_response=raw_response,
                            retained_data_issues=retained,
                            retained_clinical_judgments=observation["clinical_negatives"])
                    except Exception:
                        terminal_observation = True
                        # Failure to retain an observation cannot authorize regeneration.
                        for index in batch:
                            histories[index] = histories[index][0], False
                        raise
                    if terminal_observation:
                        raise ValueError("Incomplete independent verification retains a clinical nonmatch")

                try:
                    # Mark before the provider call so interruptions during the
                    # first observer write, or any internal length retry, fail closed.
                    persist_observation_pending()
                    checked = self._check_extraction(content, extracted, protocol, batch, feedback, observe)
                    feedback = validate_check_batch(extracted, batch, checked.primary_analysis_alignment, content, protocol)
                    feedback.extend(item for item in observation_errors if item["code"].startswith(
                        ("verification_duplicate", "verification_raw_")))
                    data_errors = validate_data_issues(extracted, batch, checked.data_issues, content)
                    feedback.extend(data_errors)
                    if protocol_fingerprint(protocol) != protocol_sha:
                        feedback.append({"code": "verification_protocol_changed_during_check"})
                    if any(row_fingerprint(extracted, index) != fingerprint for index, fingerprint in snapshot.items()):
                        feedback.append({"code": "verification_row_changed_during_check"})
                    if source_before is not None and _read_scoped(project, relative_source) != source_before:
                        feedback.append({"code": "verification_source_changed_during_check"})
                except Exception as exc:
                    feedback = [{"code": "verification_response_unavailable", "error_type": type(exc).__name__}]
                    feedback.extend(observation_errors)
                    cause = exc.__cause__
                    if hasattr(cause, "errors"):
                        feedback[0]["validation_errors"] = cause.errors(include_input=False, include_context=False)
                    self.log(f"Independent verification for {study_id}, rows {batch}, attempt {round_index + 1} failed: {type(exc).__name__}", level="warning")
                stable_rows = all(row_fingerprint(extracted, index) == fingerprint for index, fingerprint in snapshot.items())
                complete_rows = {index for index in batch if not any(
                    item.get("outcome_index") in {None, index} or item["code"].startswith("verification_")
                    for item in feedback)}
                update_issue_history(extracted, batch, histories, data_errors if stable_rows else [],
                    source_sha256=source_sha, checked_source_sha256=checked_sha, protocol_sha256=protocol_sha,
                    checked_rows=snapshot, complete_current_check=complete_rows)
                feedback = [item for item in feedback if item["code"] not in {
                    "row_data_issue", "row_source_conflict_requires_adjudication"}]
                feedback.extend(unresolved_issue_errors(batch, histories))
                if observed_negative_rows and feedback:
                    # Even a complete negative may be followed by a transport,
                    # usage, or final-validation failure. Regeneration cannot
                    # replace that observed judgment with a fresh positive.
                    terminal_observation = True
                    for index in observed_negative_rows:
                        histories[index] = histories[index][0], False
                    feedback.append({"code": "verification_observed_clinical_judgment_incomplete",
                                     "outcome_indices": sorted(observed_negative_rows)})
                for index in batch:
                    if index in complete_rows and histories[index][1] and not histories[index][0] and checked is not None:
                        assessments[index] = next(item for item in checked.primary_analysis_alignment if item.outcome_index == index)
                        checked_rows[index] = snapshot[index]
                    else:
                        assessments.pop(index, None)
                        checked_rows.pop(index, None)
                invalidate_alignment_proofs(project, protocol, extracted, histories,
                                            reason="Independent verification is incomplete or row-data issues remain.")
                persist_pending_extraction()
                complete = not feedback
                exhausted = terminal_observation or round_index + 1 == MAX_CHECK_ROUNDS or (bool(feedback) and all(
                    item["code"] in {"numeric_conflict_requires_adjudication", "row_source_conflict_requires_adjudication"} for item in feedback))
                record_attempt(batch, round_index + 1, "complete" if complete else "needs_input" if exhausted else "retry",
                               feedback, checked=checked, snapshot=snapshot)
                if complete:
                    break
                for index in batch:
                    pending_reasons[index] = list(feedback)
                if exhausted:
                    break
                repair_rows = refinement_indices(feedback)
                if not exhausted and checked is not None and repair_rows:
                    extracted = self._refine_extraction(content, extracted, checked, protocol, repair_rows, feedback)
                    self._validate_source_quotes(extracted, content, parsed.get("page_map", []))
                    for index in repair_rows:
                        recover_denominators_from_percentages(extracted.outcomes[index])
                    self._finalize_outcome_review_fields(extracted, protocol)
        try:
            if protocol_fingerprint(protocol) != protocol_sha:
                raise ValueError("Protocol changed during independent verification")
            if source_before is not None and _read_scoped(project, relative_source) != source_before:
                raise ValueError("Source changed during independent verification")
            record_errors = record_checked_alignments(project, protocol, extracted, list(assessments.values()),
                source_text=content, source_path=source_path, checked_rows=checked_rows,
                expected_source_sha256=source_sha or None, assessor_id=self.llm.model,
                pending_reasons=pending_reasons, issue_histories=histories)
            if record_errors:
                record_attempt(indices, 0, "needs_input", record_errors)
        except (OSError, ValueError) as exc:
            record_attempt(indices, 0, "needs_input", [{"code": "verification_source_changed", "error_type": type(exc).__name__}])
            invalidate_alignment_proofs(project, protocol, extracted, histories,
                                        reason="Source or protocol changed during independent verification.")
        persist_pending_extraction()
        return extracted

    def _refine_extraction(
        self, paper_content: str, current: ExtractedStudy, check_result: ExtractionCheckResult,
        protocol: ResearchProtocol, outcome_indices: list[int] | None = None,
        feedback: list[dict[str, Any]] | None = None,
    ) -> ExtractedStudy:
        """Repair reported values in explicitly indexed rows, then reverify them."""
        from new_meta.core.extraction_verification import NUMERIC_MAP_FIELDS, REFINABLE_FIELDS
        indices = list(range(len(current.outcomes))) if outcome_indices is None else outcome_indices
        prompt = (
            "Correct the inaccurate numerical extraction using the complete source below. "
            "Return exactly the original outcome_index values requested. Do not reorder, add or drop rows. "
            "Never change endpoint/population/contrast labels to make a result eligible. "
            "Prefer directly reported estimates and precision over deriving them from a damaged abstract. "
            "Do not delete an unresolved value to evade verification; retain it with a conflict note.\n"
            f"Protocol: {protocol.model_dump_json()}\n"
            f"Row data defects: {json.dumps([item.model_dump(mode='json') for item in check_result.data_issues if item.outcome_index in indices], ensure_ascii=False)}\n"
            f"Validation errors: {json.dumps([item for item in feedback or [] if item.get('outcome_index') in indices], ensure_ascii=False)}\n"
            f"Original indexed rows: {json.dumps([{'outcome_index': index, 'outcome': current.outcomes[index].model_dump(mode='json', exclude={'primary_analysis_alignment'})} for index in indices], ensure_ascii=False)}\n"
            f"Complete source:\n{paper_content}"
        )
        try:
            refined = self.call_llm_structured(prompt, ExtractionRefinement, max_tokens=LLM_MAX_TOKENS_EXTRACTION)
            returned = [item.outcome_index for item in refined.outcomes]
            if set(returned) != set(indices) or len(returned) != len(indices):
                return current
            result = current.model_copy(deep=True)
            allowed = REFINABLE_FIELDS
            for item in refined.outcomes:
                original = result.outcomes[item.outcome_index]
                data = original.model_dump(mode="json", exclude={"primary_analysis_alignment"})
                for field in allowed & item.outcome.model_fields_set:
                    value = getattr(item.outcome, field)
                    if field in NUMERIC_MAP_FIELDS:
                        data[field] = {**data.get(field, {}), **{key: entry for key, entry in value.items() if entry is not None}}
                    elif value is not None and value != "":
                        data[field] = value
                result.outcomes[item.outcome_index] = OutcomeData.model_validate(data)
                result.outcomes[item.outcome_index].primary_analysis_alignment = original.primary_analysis_alignment
            return result
        except Exception as exc:
            self.log(f"Numeric refinement unavailable: {type(exc).__name__}", level="warning")
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
            measure == "MD"
            and outcome.reported_effect_adjusted is False
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
                    "primary_analysis_alignment": outcome.primary_analysis_alignment.model_dump(mode="json") if outcome.primary_analysis_alignment else None,
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
            f"- Phase status: {summary.get('status', 'complete')}",
            f"- Incomplete studies: {summary.get('incomplete_studies', 0)}",
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
