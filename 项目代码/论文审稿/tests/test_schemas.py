"""
Tests for data schemas
"""
import pytest
from pathlib import Path
import sys

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.schemas.document_ir import (
    DocumentIR, StudyProfile, EvidenceMap, SectionText,
    MethodsSection, ResultsSection, DiscussionSection
)
from src.schemas.rubric import (
    RubricItem, RubricBlock, RubricItemOutputSchema,
    BlockReviewResult, ItemStatus, SeverityLevel, VerdictType
)
from src.schemas.review_state import ReviewState, SecurityAlert, JobStatus, SecurityAlertType
from src.schemas.reports import AuthorReport, EditorReport, IssueItem


class TestDocumentIR:
    """Test DocumentIR schemas"""

    def test_section_text_creation(self):
        """Test SectionText creation and indexing"""
        section = SectionText(text=["Para 1", "Para 2", "Para 3"])

        assert len(section.text) == 3
        assert section[0] == "Para 1"
        assert section[2] == "Para 3"
        assert section[10] == ""  # Out of bounds returns empty

    def test_document_ir_basic(self):
        """Test basic DocumentIR creation"""
        doc_ir = DocumentIR(
            title="Test Paper",
            abstract=SectionText(text=["Background...", "Methods...", "Results..."]),
            keywords=["keyword1", "keyword2"]
        )

        assert doc_ir.title == "Test Paper"
        assert len(doc_ir.abstract.text) == 3
        assert len(doc_ir.keywords) == 2

    def test_document_ir_methods_section(self):
        """Test Methods section in DocumentIR"""
        methods = MethodsSection(
            randomization=SectionText(text=["Random sequence generated..."]),
            blinding=SectionText(text=["Double-blind design..."]),
            statistics=SectionText(text=["Chi-square test used..."])
        )

        doc_ir = DocumentIR(
            title="RCT Paper",
            methods=methods
        )

        assert doc_ir.methods.randomization[0] == "Random sequence generated..."
        assert len(doc_ir.methods.blinding.text) == 1

    def test_evidence_map_creation(self):
        """Test EvidenceMap creation and lookup"""
        evidence_map = EvidenceMap(term_locations={
            "p-value": ["results.text[3]", "tables[1]"],
            "confidence interval": ["results.text[5]"]
        })

        assert evidence_map.get_locations("p-value") == ["results.text[3]", "tables[1]"]
        assert evidence_map.get_locations("confidence interval") == ["results.text[5]"]
        assert evidence_map.get_locations("nonexistent") == []

    def test_study_profile_creation(self):
        """Test StudyProfile creation"""
        profile = StudyProfile(
            study_types=["RCT", "AI"],
            metadata={
                "sample_size": "350 patients",
                "primary_outcome": "Mortality rate"
            }
        )

        assert len(profile.study_types) == 2
        assert "RCT" in profile.study_types
        assert profile.metadata["sample_size"] == "350 patients"


class TestRubricSchemas:
    """Test Rubric-related schemas"""

    def test_rubric_item_creation(self):
        """Test RubricItem creation"""
        item = RubricItem(
            item_id="TEST_01",
            checklist_name="Test Checklist",
            item_number="1",
            question="Is the study design described?",
            evaluation_criteria="Should clearly state the design",
            evidence_location_hint="methods.study_design",
            severity_if_missing=SeverityLevel.CRITICAL,
            category="Methods"
        )

        assert item.item_id == "TEST_01"
        assert item.severity_if_missing == SeverityLevel.CRITICAL

    def test_rubric_block_creation(self):
        """Test RubricBlock creation"""
        item1 = RubricItem(
            item_id="TEST_01",
            checklist_name="Test",
            item_number="1",
            question="Q1",
            evaluation_criteria="C1",
            evidence_location_hint="methods"
        )

        block = RubricBlock(
            block_id="block_001",
            block_name="Methods_Design",
            items=[item1],
            priority=10
        )

        assert block.block_id == "block_001"
        assert len(block.items) == 1
        assert block.priority == 10

    def test_rubric_item_output_schema(self):
        """Test RubricItemOutputSchema"""
        output = RubricItemOutputSchema(
            item_id="TEST_01",
            status=ItemStatus.COMPLETED,
            verdict=VerdictType.PARTIAL,
            confidence=0.9,
            score=1,
            severity=SeverityLevel.MAJOR,
            evidence_quote=["Quote from paper"],
            evidence_location=["methods.text[0]"],
            missing_detail="Detail X is missing",
            risk_reason="This creates bias",
            actionable_fix="Add detail X to methods",
            confidence_score=0.9
        )

        assert output.score == 1
        assert output.severity == SeverityLevel.MAJOR
        assert output.confidence_score == 0.9

    def test_block_review_result(self):
        """Test BlockReviewResult"""
        output1 = RubricItemOutputSchema(
            item_id="TEST_01",
            verdict=VerdictType.FAIL,
            confidence=0.9,
            score=0,
            severity=SeverityLevel.MAJOR,
            confidence_score=0.9
        )

        result = BlockReviewResult(
            block_id="block_001",
            block_name="Methods",
            results=[output1],
            execution_time_seconds=18.5,
            error_log=[]
        )

        assert result.block_id == "block_001"
        assert len(result.results) == 1
        assert result.execution_time_seconds == 18.5


class TestReviewState:
    """Test ReviewState and related schemas"""

    def test_review_state_creation(self):
        """Test ReviewState creation"""
        state = ReviewState(
            job_id="test-job-123",
            manuscript_path="/path/to/paper.pdf"
        )

        assert state.job_id == "test-job-123"
        assert state.status == JobStatus.PENDING
        assert state.progress_percentage == 0.0

    def test_review_state_add_error(self):
        """Test adding errors to ReviewState"""
        state = ReviewState(
            job_id="test-job-123",
            manuscript_path="/path/to/paper.pdf"
        )

        state.add_error("1001", "Test error", {"detail": "Extra info"})

        assert len(state.error_log) == 1
        assert state.error_log[0]["error_code"] == "1001"
        assert state.error_log[0]["message"] == "Test error"

    def test_security_alert_creation(self):
        """Test SecurityAlert creation"""
        alert = SecurityAlert(
            alert_type=SecurityAlertType.PROMPT_INJECTION,
            severity="CRITICAL",
            evidence="Detected injection pattern",
            location="methods.text[5]"
        )

        assert alert.alert_type == SecurityAlertType.PROMPT_INJECTION
        assert alert.severity == "CRITICAL"

    def test_review_state_add_security_alert(self):
        """Test adding security alerts"""
        state = ReviewState(
            job_id="test-job-123",
            manuscript_path="/path/to/paper.pdf"
        )

        alert = SecurityAlert(
            alert_type=SecurityAlertType.ETHICS_MISSING,
            severity="WARNING",
            evidence="No ethics approval mentioned"
        )

        state.add_security_alert(alert)

        assert len(state.security_alerts) == 1
        assert state.security_alerts[0].alert_type == SecurityAlertType.ETHICS_MISSING


class TestReportSchemas:
    """Test report schemas"""

    def test_issue_item_creation(self):
        """Test IssueItem creation"""
        issue = IssueItem(
            category="Randomization",
            severity=SeverityLevel.CRITICAL,
            description="Missing allocation concealment",
            evidence=["Quote 1", "Quote 2"],
            recommendation="Please describe allocation concealment",
            checklist_reference="CONSORT_9"
        )

        assert issue.category == "Randomization"
        assert issue.severity == SeverityLevel.CRITICAL
        assert len(issue.evidence) == 2

    def test_author_report_creation(self):
        """Test AuthorReport creation"""
        issue1 = IssueItem(
            category="Methods",
            severity=SeverityLevel.MAJOR,
            description="Sample size not justified",
            evidence=[],
            recommendation="Add sample size calculation",
            checklist_reference="CONSORT_7a"
        )

        report = AuthorReport(
            job_id="test-job-123",
            manuscript_title="Test Paper",
            major_issues=[issue1],
            total_issues=1,
            checklists_applied=["CONSORT 2010"]
        )

        assert report.job_id == "test-job-123"
        assert report.total_issues == 1
        assert len(report.major_issues) == 1

    def test_author_report_to_markdown(self):
        """Test AuthorReport markdown generation"""
        report = AuthorReport(
            job_id="test-job-123",
            manuscript_title="Test Paper",
            critical_issues=[],
            major_issues=[],
            minor_issues=[],
            total_issues=0,
            checklists_applied=["CONSORT 2010"]
        )

        markdown = report.to_markdown()

        assert isinstance(markdown, str)
        assert "Test Paper" in markdown
        assert "CONSORT 2010" in markdown

    def test_editor_report_creation(self):
        """Test EditorReport creation"""
        report = EditorReport(
            job_id="test-job-123",
            manuscript_title="Test Paper",
            recommendation="MAJOR_REVISION",
            executive_summary="Multiple methodological issues identified",
            scores={"reporting": 50, "rigor": 45, "novelty": 60, "contribution": 55},
            compliance_summary="Several reporting gaps were identified",
            novelty_assessment="Moderate novelty",
            contribution_assessment="Potential contribution after revision",
            decision_rationale={
                "decision": "MAJOR_REVISION",
                "primary_reason": "Methodological issues require correction",
            },
            uncertainty_metrics={
                "total_items_evaluated": 2,
                "uncertain_count": 0,
                "uncertain_percentage": 0,
                "stage3_fallback_count": 0,
            },
            critical_risks=["Missing allocation concealment"],
            major_risks=["Sample size not justified"],
            study_types_identified=["RCT"],
            checklists_applied=["CONSORT 2010"],
            total_issues=2,
            critical_count=1,
            major_count=1,
            minor_count=0
        )

        assert report.recommendation == "MAJOR_REVISION"
        assert len(report.critical_risks) == 1
        assert report.total_issues == 2

    def test_editor_report_to_markdown(self):
        """Test EditorReport markdown generation"""
        report = EditorReport(
            job_id="test-job-123",
            manuscript_title="Test Paper",
            recommendation="SEND_FOR_REVIEW",
            executive_summary="No significant issues found",
            scores={"reporting": 90, "rigor": 88, "novelty": 80, "contribution": 82},
            compliance_summary="Reporting requirements were met",
            novelty_assessment="Good novelty",
            contribution_assessment="Meaningful contribution",
            decision_rationale={
                "decision": "ACCEPT",
                "primary_reason": "No material pre-review issues",
            },
            uncertainty_metrics={
                "total_items_evaluated": 1,
                "uncertain_count": 0,
                "uncertain_percentage": 0,
                "stage3_fallback_count": 0,
            },
            study_types_identified=["RCT"],
            checklists_applied=["CONSORT 2010"],
            total_issues=0,
            critical_count=0,
            major_count=0,
            minor_count=0
        )

        markdown = report.to_markdown()

        assert isinstance(markdown, str)
        assert "ACCEPT" in markdown
        assert "Test Paper" in markdown


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
