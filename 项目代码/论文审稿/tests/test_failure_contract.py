import unittest
from types import SimpleNamespace

from src.main_v2 import ReviewOrchestratorV2
from src.agents.meta_reviewer import MetaReviewerAgent
from src.agents.narrative_generator import NarrativeReportGenerator


class _FailingParser:
    def parse(self, _path):
        raise ValueError("corrupt manuscript")


class _FailingGateway:
    async def call_with_json_response(self, **_kwargs):
        raise RuntimeError("upstream unavailable")

    async def call_with_retry(self, **_kwargs):
        raise RuntimeError("upstream unavailable")


class PeerReviewFailureContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_pipeline_errors_are_not_returned_as_completed_reviews(self):
        orchestrator = ReviewOrchestratorV2.__new__(ReviewOrchestratorV2)
        orchestrator.document_parser = _FailingParser()

        with self.assertRaisesRegex(RuntimeError, "Peer-review pipeline failed"):
            await orchestrator.review_manuscript("corrupt.pdf", job_id="test-job")

    async def test_meta_review_upstream_failure_is_not_converted_to_a_review(self):
        reviewer = MetaReviewerAgent(_FailingGateway())
        reviewer._extract_issues_from_all_rubrics = lambda _results: []
        reviewer._hard_filter_hallucinations = lambda issues, _document, _profile: issues
        reviewer._build_meta_review_prompt = lambda *_args: "prompt"

        with self.assertRaisesRegex(RuntimeError, "Meta-review synthesis failed"):
            await reviewer.synthesize_multi_rubric_results(
                document_ir=SimpleNamespace(),
                multi_rubric_results={},
                cognitive_result=SimpleNamespace(),
            )

    async def test_narrative_upstream_failure_is_not_converted_to_a_report(self):
        generator = NarrativeReportGenerator(_FailingGateway())

        async def no_verified_issues(_issues, _document):
            return []

        generator._verify_issues_with_llm = no_verified_issues
        generator._build_prompt = lambda *_args: "prompt"
        document = SimpleNamespace(title="Test manuscript")
        meta = SimpleNamespace(
            fatal_issues=[],
            major_issues=[],
            minor_issues=[],
            recommendation="major_revision",
        )

        with self.assertRaisesRegex(RuntimeError, "Narrative peer-review generation failed"):
            await generator.generate_narrative_report(
                document_ir=document,
                meta_review=meta,
                cognitive_result=SimpleNamespace(),
            )


if __name__ == "__main__":
    unittest.main()
