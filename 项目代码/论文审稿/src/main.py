"""
Main Review Orchestrator - End-to-end manuscript review pipeline

Enhanced with Plan-Retrieve-Argue architecture:
- Plan: Strategic review planning based on study type
- Retrieve: Material gathering without judgments
- Argue: Evidence-gated report synthesis
"""
import asyncio
import uuid
import time
from typing import Tuple, Optional
from pathlib import Path

from .schemas.review_state import ReviewState, JobStatus
from .schemas.reports import AuthorReport, EditorReport
from .schemas.cognitive_review import CognitiveReviewResult
from .schemas.plan_retrieve_argue import PRAState, ReviewPlan, MaterialSnippet, ReviewFocus
from .services.document_parser import DocumentParser
from .services.llm_gateway import LLMGateway, LLMProvider
from .agents.document_analyzer import DocumentAnalyzerAgent
from .agents.integrity_guard import IntegrityEthicsGuard
from .agents.rubric_orchestrator import RubricOrchestrator
from .agents.methodology_reviewer import MethodologyReviewerAgent, MaterialEngineAgent
from .agents.statistician_reviewer import StatisticianReviewerAgent
from .agents.cognitive_reviewer import CognitiveReviewerAgent
from .agents.editor_synthesizer import EditorSynthesizerAgent
from .agents.review_planner import ReviewPlannerAgent
from .utils.rubric_loader import RubricLoader

from dotenv import load_dotenv
load_dotenv()

class ReviewOrchestrator:
    """
    Main orchestrator for the end-to-end manuscript review pipeline.

    Implements Plan-Retrieve-Argue architecture:
    1. Parse: Document parsing and cleaning
    2. Analyze: Structured IR generation + Coverage Meter
    3. Guard: Security and ethics checks
    4. Plan: Strategic review planning (NEW)
    5. Retrieve: Material gathering (NEW - replaces direct review)
    6. Review: Concurrent methodology + statistical + cognitive review
    7. Argue: Evidence-gated report synthesis (Enhanced)
    """

    def __init__(
        self,
        llm_api_key: str = None,
        llm_provider: str = "deepseek",
        rubrics_dir: str = None,
        use_pra_architecture: bool = True  # NEW: Toggle for Plan-Retrieve-Argue
    ):
        """
        Initialize the review orchestrator.

        Args:
            llm_api_key: API key for LLM provider
            llm_provider: LLM provider name
            rubrics_dir: Custom directory for rubric files (optional)
            use_pra_architecture: Whether to use Plan-Retrieve-Argue (default: True)
        """
        # Initialize services
        provider = LLMProvider.DEEPSEEK
        self.llm_gateway = LLMGateway(provider=provider, api_key=llm_api_key)
        self.document_parser = DocumentParser()
        self.rubric_loader = RubricLoader(rubrics_dir)

        # Initialize agents
        self.document_analyzer = DocumentAnalyzerAgent(self.llm_gateway)
        self.integrity_guard = IntegrityEthicsGuard()
        self.rubric_orchestrator = RubricOrchestrator(self.rubric_loader)
        self.editor_synthesizer = EditorSynthesizerAgent(self.llm_gateway)

        # NEW: Plan-Retrieve-Argue agents
        self.review_planner = ReviewPlannerAgent(self.llm_gateway)
        self.material_engine = MaterialEngineAgent(self.llm_gateway)
        self.use_pra = use_pra_architecture

    async def review_manuscript(
        self,
        manuscript_path: str,
        job_id: str = None,
        is_review_article: bool = True
    ) -> Tuple[ReviewState, AuthorReport, EditorReport]:
        """
        Execute complete review pipeline for a manuscript.

        Args:
            manuscript_path: Path to the manuscript file (.docx, .pdf, .txt)
            job_id: Optional job ID (will be generated if not provided)
            is_review_article: Whether the manuscript is a review article

        Returns:
            Tuple of (ReviewState, AuthorReport, EditorReport)
        """
        # Initialize job
        if job_id is None:
            job_id = str(uuid.uuid4())

        review_state = ReviewState(
            job_id=job_id,
            manuscript_path=manuscript_path,
            status=JobStatus.PENDING,
            is_review_article=is_review_article
        )

        # Initialize PRA state
        pra_state = PRAState()

        try:
            print(f"\n{'='*60}")
            print(f"[{job_id}] Starting manuscript review pipeline")
            print(f"[{job_id}] Architecture: {'Plan-Retrieve-Argue' if self.use_pra else 'Legacy'}")
            print(f"[{job_id}] is_review_article={is_review_article}")
            print(f"{'='*60}\n")

            # ============================================================
            # STAGE 1: Document Parsing and Cleaning
            # ============================================================
            print(f"\n[{job_id}] Stage 1/7: Parsing document...")
            review_state.status = JobStatus.PARSING
            review_state.update_progress()

            manuscript_text, parse_metadata = self.document_parser.parse(manuscript_path)
            print(f"  → Parse method: {parse_metadata.get('parse_method', 'unknown')}")
            print(f"  → Parse quality: {parse_metadata.get('parse_quality', 'unknown')}")

            # ============================================================
            # STAGE 2: Structured IR Generation + Coverage Meter
            # ============================================================
            print(f"[{job_id}] Stage 2/7: Analyzing manuscript structure...")

            # NEW: analyze() now returns coverage_summary
            document_ir, study_profile, evidence_map, coverage_summary = await self.document_analyzer.analyze(
                manuscript_text,
                parse_metadata=parse_metadata
            )

            review_state.document_ir = document_ir
            review_state.study_profile = study_profile
            review_state.evidence_map = evidence_map
            pra_state.coverage_summary = coverage_summary

            lang = document_ir.language
            # Force Chinese report output regardless of detected language
            lang = "zh"
            print(f"  → Detected language: {document_ir.language} → report language forced to: {lang}")

            print(f"  → Identified study types: {', '.join(study_profile.study_types)}")
            print(f"  → Coverage: {coverage_summary.section_coverage_percentage:.1f}% of standard sections")
            print(f"  → Tables parsed: {len(coverage_summary.tables_parsed)}")
            print(f"  → Figures parsed: {len(coverage_summary.figures_parsed)}")

            # ============================================================
            # STAGE 3: Security and Ethics Checks
            # ============================================================
            print(f"[{job_id}] Stage 3/7: Running security and ethics checks...")

            security_alerts = await self.integrity_guard.check(manuscript_text)
            review_state.security_alerts = security_alerts

            if security_alerts:
                print(f"  → Found {len(security_alerts)} security/ethics alerts")
                for alert in security_alerts:
                    if alert.severity == "CRITICAL":
                        print(f"     ⚠️  CRITICAL: {alert.alert_type.value}")

            # ============================================================
            # STAGE 4: Review Planning (NEW in PRA)
            # ============================================================
            if self.use_pra:
                print(f"[{job_id}] Stage 4/7: Planning review strategy...")
                plan_start = time.time()

                review_plan = await self.review_planner.generate_plan(
                    document_ir=document_ir,
                    study_profile=study_profile,
                    coverage_summary=coverage_summary
                )

                pra_state.review_plan = review_plan
                pra_state.plan_duration_ms = (time.time() - plan_start) * 1000

                print(f"  → Review strategy: {review_plan.overall_strategy[:80]}...")
                print(f"  → Focus areas: {', '.join([f.topic for f in review_plan.review_focus])}")
                print(f"  → High-risk areas: {', '.join(review_plan.high_risk_areas[:3])}")

            # ============================================================
            # STAGE 5: Rubric Orchestration
            # ============================================================
            print(f"[{job_id}] Stage 5/7: Orchestrating rubrics...")

            rubric_blocks = self.rubric_orchestrator.orchestrate(study_profile, is_review_article=is_review_article)
            review_state.orchestration.rubric_blocks = rubric_blocks
            review_state.orchestration.total_blocks = len(rubric_blocks)

            print(f"  → Created {len(rubric_blocks)} review blocks")

            # ============================================================
            # STAGE 6: Concurrent Review Execution (Enhanced with Material Gathering)
            # ============================================================
            print(f"[{job_id}] Stage 6/7: Executing concurrent reviews...")
            review_state.status = JobStatus.REVIEWING
            review_state.update_progress()

            # NEW: Gather materials first if using PRA
            if self.use_pra and pra_state.review_plan:
                print(f"  → Gathering materials for {len(pra_state.review_plan.review_focus)} focus areas...")
                retrieve_start = time.time()

                # Map focus topics to rubric items
                rubric_items_map = self._map_focus_to_items(
                    pra_state.review_plan.review_focus,
                    rubric_blocks
                )

                # Debug: Show mapping statistics
                for focus_topic, items in rubric_items_map.items():
                    print(f"     • {focus_topic}: {len(items)} items")

                # Gather materials concurrently
                materials = await self.material_engine.gather_materials_batch(
                    focus_list=pra_state.review_plan.review_focus,
                    document_ir=document_ir,
                    rubric_items_map=rubric_items_map
                )

                pra_state.material_snippets = materials
                pra_state.retrieve_duration_ms = (time.time() - retrieve_start) * 1000

                print(f"  → Gathered {len(materials)} material snippets")
                if len(materials) > 0:
                    found_count = sum(1 for m in materials if m.status.value == "FOUND")
                    print(f"  → Evidence found: {found_count}/{len(materials)} ({100*found_count/len(materials):.1f}%)")
                else:
                    print(f"  → Warning: No materials gathered. Check focus-to-item mapping.")

            # Create concurrent tasks for all rubric blocks
            review_tasks = []
            for block in rubric_blocks:
                methodology_reviewer = MethodologyReviewerAgent(self.llm_gateway)
                task = methodology_reviewer.review_block(
                    rubric_block=block,
                    document_ir=document_ir,
                    evidence_map=evidence_map,
                    language=lang
                )
                review_tasks.append(task)

            # Also run statistical review concurrently
            statistician_reviewer = StatisticianReviewerAgent(self.llm_gateway)
            stats_task = statistician_reviewer.review_statistics(
                document_ir=document_ir,
                evidence_map=evidence_map
            )
            review_tasks.append(stats_task)

            # Execute all reviews concurrently
            print(f"  → Running {len(review_tasks)} concurrent review tasks...")
            review_results = await asyncio.gather(*review_tasks, return_exceptions=True)

            # Filter out exceptions and collect successful results
            successful_results = []
            for i, result in enumerate(review_results):
                if isinstance(result, Exception):
                    print(f"     ⚠️  Block {i+1} failed: {str(result)}")
                    review_state.add_error("3005", f"Block {i+1} execution failed", {"error": str(result)})
                else:
                    successful_results.append(result)
                    review_state.review_results[result.block_id] = result
                    review_state.orchestration.completed_blocks += 1
                    print(f"     Y Completed block: {result.block_name} ({result.execution_time_seconds:.1f}s)")

            review_state.update_progress()

            # ============================================================
            # STAGE 6.5: Cognitive Review (High-level Assessment)
            # ============================================================
            print(f"[{job_id}] Stage 6.5/7: Performing cognitive review...")

            cognitive_reviewer = CognitiveReviewerAgent(self.llm_gateway)
            rubric_summary = cognitive_reviewer.summarize_rubric_results(successful_results)

            try:
                cognitive_result = await cognitive_reviewer.review(
                    document_ir=document_ir,
                    rubric_summary=rubric_summary,
                    language=lang
                )

                print(f"     Y Cognitive review completed")
                print(f"       - Novelty: {cognitive_result.novelty_score:.1f}/10")
                print(f"       - Contribution: {cognitive_result.contribution_score:.1f}/10")
                print(f"       - Recommendation: {cognitive_result.overall_recommendation}")

                review_state.metrics["cognitive_review"] = {
                    "novelty_score": cognitive_result.novelty_score,
                    "contribution_score": cognitive_result.contribution_score,
                    "overall_recommendation": cognitive_result.overall_recommendation,
                }

            except Exception as e:
                print(f"     ⚠️  Cognitive review failed: {str(e)}")
                review_state.add_error("3006", "Cognitive review failed", {"error": str(e)})
                cognitive_result = None

            # ============================================================
            # STAGE 7: Report Synthesis (Enhanced with Evidence Gate)
            # ============================================================
            print(f"[{job_id}] Stage 7/7: Synthesizing final reports...")
            review_state.status = JobStatus.SYNTHESIZING
            review_state.update_progress()

            argue_start = time.time()

            # Get list of checklists that were actually applied
            checklists_applied = list(set(
                item.checklist_name
                for block in rubric_blocks
                for item in block.items
            ))

            # Use enhanced synthesis if PRA is enabled
            # Always use filename as manuscript title for display
            _title = Path(manuscript_path).stem
            # Build full rubric items map: item_id -> question text (Chinese preferred)
            full_rubric_items = {
                item.item_id: (item.question_zh if lang == "zh" and item.question_zh else item.question)
                for block in rubric_blocks
                for item in block.items
            }
            if self.use_pra and pra_state.review_plan:
                author_report, editor_report = await self.editor_synthesizer.synthesize_with_plan(
                    job_id=job_id,
                    manuscript_title=_title,
                    review_plan=pra_state.review_plan,
                    materials=pra_state.material_snippets,
                    coverage_summary=pra_state.coverage_summary,
                    review_results=successful_results,
                    security_alerts=security_alerts,
                    cognitive_result=cognitive_result,
                    language=lang,
                    full_rubric_items=full_rubric_items,
                )
            else:
                author_report, editor_report = await self.editor_synthesizer.synthesize(
                    job_id=job_id,
                    manuscript_title=_title,
                    study_types=study_profile.study_types,
                    checklists_applied=checklists_applied,
                    review_results=successful_results,
                    security_alerts=security_alerts,
                    cognitive_result=cognitive_result,
                    language=lang
                )

            pra_state.argue_duration_ms = (time.time() - argue_start) * 1000

            # Store reports in review state
            review_state.final_reports["author_report"] = author_report.to_markdown()
            review_state.final_reports["editor_report"] = editor_report.to_markdown()

            # ============================================================
            # COMPLETION
            # ============================================================
            review_state.status = JobStatus.COMPLETED
            review_state.update_progress()

            # Add PRA metrics
            if self.use_pra:
                review_state.metrics["pra_timing"] = {
                    "plan_duration_ms": pra_state.plan_duration_ms,
                    "retrieve_duration_ms": pra_state.retrieve_duration_ms,
                    "argue_duration_ms": pra_state.argue_duration_ms,
                    "materials_gathered": len(pra_state.material_snippets)
                }

            print(f"\n[{job_id}] ✅ Review completed successfully!")
            print(f"  → Total issues found: {author_report.total_issues}")
            print(f"  → Critical: {len(author_report.critical_issues)}, Major: {len(author_report.major_issues)}, Minor: {len(author_report.minor_issues)}")
            print(f"  → Editor recommendation: {editor_report.recommendation}")

            if self.use_pra:
                print(f"  → PRA Timing: Plan={pra_state.plan_duration_ms:.0f}ms, Retrieve={pra_state.retrieve_duration_ms:.0f}ms, Argue={pra_state.argue_duration_ms:.0f}ms")

            return review_state, author_report, editor_report

        except Exception as e:
            # Handle failures
            review_state.status = JobStatus.FAILED
            review_state.add_error("9001", "Review pipeline failed", {"error": str(e)})
            print(f"\n[{job_id}] ❌ Review failed: {str(e)}")
            raise

    def _map_focus_to_items(
        self,
        focus_list: list,
        rubric_blocks: list
    ) -> dict:
        """Map focus topics to relevant rubric items"""
        from .schemas.rubric import RubricItem

        result = {}

        # Flatten all items
        all_items = []
        for block in rubric_blocks:
            all_items.extend(block.items)

        # Map each focus to relevant items
        for focus in focus_list:
            # Get items from focus.rubric_materials
            focus_items = []
            for material_id in focus.rubric_materials:
                matching = [item for item in all_items if item.item_id == material_id]
                focus_items.extend(matching)

            # If no specific items, use items from related sections
            if not focus_items:
                topic_lower = focus.topic.lower()
                for item in all_items:
                    if topic_lower in item.evidence_location_hint.lower():
                        focus_items.append(item)
                    elif topic_lower in item.question.lower():
                        focus_items.append(item)

            # If still no items, use evidence_slots to find items
            if not focus_items and focus.evidence_slots:
                for slot in focus.evidence_slots:
                    slot_lower = slot.lower()
                    for item in all_items:
                        if slot_lower in item.evidence_location_hint.lower():
                            focus_items.append(item)
                        # Also check if section name matches (e.g., "methods" in "methods.statistics")
                        section_name = slot.split('.')[0] if '.' in slot else slot
                        if section_name.lower() in item.evidence_location_hint.lower():
                            focus_items.append(item)

            # If STILL no items, assign first few items from all_items as fallback
            if not focus_items and all_items:
                print(f"  → Warning: No items matched for focus '{focus.topic}', using fallback items")
                # Use first 3 items as fallback
                focus_items = all_items[:3]

            # Remove duplicates while preserving order
            seen = set()
            unique_items = []
            for item in focus_items:
                if item.item_id not in seen:
                    seen.add(item.item_id)
                    unique_items.append(item)

            # Limit to top 5 items per focus
            result[focus.topic] = unique_items[:5]

        return result


async def main():
    """Example usage of the review orchestrator"""
    import os
    import sys

    # Get API key from environment
    api_key = os.getenv("DEEPSEEK_API_KEY") or "dummy_key"

    # Check if manuscript path provided
    if len(sys.argv) < 2:
        print("Usage: python -m src.main <path_to_manuscript>")
        print("Example: python -m src.main /path/to/paper.pdf")
        sys.exit(1)

    manuscript_path = sys.argv[1]

    # Initialize orchestrator
    orchestrator = ReviewOrchestrator(
        llm_api_key=api_key,
        use_pra_architecture=True  # Enable Plan-Retrieve-Argue
    )

    # Run review
    review_state, author_report, editor_report = await orchestrator.review_manuscript(
        manuscript_path=manuscript_path
    )

    # Save reports
    output_dir = Path("./review_output")
    output_dir.mkdir(exist_ok=True)

    author_report_path = output_dir / f"{review_state.job_id}_author_report.md"
    editor_report_path = output_dir / f"{review_state.job_id}_editor_report.md"

    with open(author_report_path, "w", encoding="utf-8") as f:
        f.write(author_report.to_markdown())

    with open(editor_report_path, "w", encoding="utf-8") as f:
        f.write(editor_report.to_markdown())

    print(f"\n📄 Reports saved:")
    print(f"  → Author report: {author_report_path}")
    print(f"  → Editor report: {editor_report_path}")


if __name__ == "__main__":
    asyncio.run(main())
