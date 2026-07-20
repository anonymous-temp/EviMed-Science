"""
Tests for RubricLoader
"""
import pytest
from pathlib import Path
import sys

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.utils.rubric_loader import RubricLoader
from src.schemas.rubric import RubricItem, SeverityLevel


class TestRubricLoader:
    """Test suite for RubricLoader"""

    @pytest.fixture
    def loader(self):
        """Create a RubricLoader instance"""
        return RubricLoader()

    def test_list_available_rubrics(self, loader):
        """Test listing available rubric files"""
        rubrics = loader.list_available_rubrics()

        assert isinstance(rubrics, list)
        assert len(rubrics) > 0
        assert "universal_rubric" in rubrics
        assert "consort_2010" in rubrics

    def test_load_universal_rubric(self, loader):
        """Test loading universal rubric"""
        items = loader.load_rubric("universal_rubric")

        assert isinstance(items, list)
        assert len(items) > 0
        assert all(isinstance(item, RubricItem) for item in items)

        # Check first item structure
        first_item = items[0]
        assert hasattr(first_item, 'item_id')
        assert hasattr(first_item, 'question')
        assert hasattr(first_item, 'evaluation_criteria')
        assert isinstance(first_item.severity_if_missing, SeverityLevel)

    def test_load_consort_rubric(self, loader):
        """Test loading CONSORT 2010 rubric"""
        items = loader.load_rubric("consort_2010")

        assert isinstance(items, list)
        assert len(items) >= 20  # CONSORT has 25+ items

        # Check that item IDs are unique
        item_ids = [item.item_id for item in items]
        assert len(item_ids) == len(set(item_ids))

    def test_load_prisma_rubric(self, loader):
        """Test loading PRISMA 2020 rubric"""
        items = loader.load_rubric("prisma_2020")

        assert isinstance(items, list)
        assert len(items) >= 20

        # Check checklist name
        assert all(item.checklist_name == "PRISMA 2020" for item in items)

    def test_load_strobe_rubric(self, loader):
        """Test loading STROBE rubric"""
        items = loader.load_rubric("strobe")

        assert isinstance(items, list)
        assert len(items) >= 20

        # Check for observational study specific items
        item_ids = [item.item_id for item in items]
        assert any("STROBE" in item_id for item_id in item_ids)

    def test_load_tripod_ai_rubric(self, loader):
        """Test loading TRIPOD-AI rubric"""
        items = loader.load_rubric("tripod_ai")

        assert isinstance(items, list)
        assert len(items) >= 20

        # Check for AI-specific items
        questions = [item.question.lower() for item in items]
        assert any("ai" in q or "machine learning" in q for q in questions)

    def test_cache_mechanism(self, loader):
        """Test that rubrics are cached after first load"""
        # Load once
        items1 = loader.load_rubric("universal_rubric")

        # Load again
        items2 = loader.load_rubric("universal_rubric")

        # Should be same objects (from cache)
        assert items1 is items2

    def test_load_rubrics_for_study_types_rct(self, loader):
        """Test loading rubrics for RCT study type"""
        items = loader.load_rubrics_for_study_types(["RCT"])

        assert isinstance(items, list)
        assert len(items) > 0

        # Should include ONLY CONSORT (no Universal when specialized checklist exists)
        checklists = set(item.checklist_name for item in items)
        assert "CONSORT 2010" in checklists
        # New behavior: Universal should NOT be loaded when specialized checklist exists
        assert "Universal" not in str(checklists)

    def test_load_rubrics_for_study_types_systematic_review(self, loader):
        """Test loading rubrics for systematic review"""
        items = loader.load_rubrics_for_study_types(["Systematic Review"])

        checklists = set(item.checklist_name for item in items)
        assert "PRISMA 2020" in checklists

    def test_load_rubrics_for_study_types_observational(self, loader):
        """Test loading rubrics for observational studies"""
        items = loader.load_rubrics_for_study_types(["Cohort Study"])

        checklists = set(item.checklist_name for item in items)
        assert "STROBE" in checklists

    def test_load_rubrics_for_study_types_ai(self, loader):
        """Test loading rubrics for AI prediction models"""
        items = loader.load_rubrics_for_study_types(["AI", "Prognostic Model"])

        checklists = set(item.checklist_name for item in items)
        assert "TRIPOD-AI" in checklists

    def test_load_rubrics_for_multiple_types(self, loader):
        """Test loading rubrics for multiple study types"""
        items = loader.load_rubrics_for_study_types(["RCT", "AI"])

        checklists = set(item.checklist_name for item in items)
        assert "CONSORT 2010" in checklists
        assert "TRIPOD-AI" in checklists
        # New behavior: Universal should NOT be loaded when specialized checklists exist
        assert "Universal" not in str(checklists)

    def test_no_duplicate_items(self, loader):
        """Test that duplicate items are removed"""
        items = loader.load_rubrics_for_study_types(["RCT", "Cluster RCT"])

        # Should not have duplicate item IDs
        item_ids = [item.item_id for item in items]
        assert len(item_ids) == len(set(item_ids))

    def test_universal_rubric_fallback(self, loader):
        """Test that Universal Rubric is used as fallback for unmapped types"""
        # Test with unmapped study type
        items = loader.load_rubrics_for_study_types(["Instrument Development"])

        assert isinstance(items, list)
        assert len(items) > 0

        checklists = set(item.checklist_name for item in items)
        # Should ONLY load Universal Rubric for unmapped types
        assert "Universal" in str(checklists)

    def test_universal_rubric_not_loaded_with_specialized(self, loader):
        """Test that Universal Rubric is NOT loaded when specialized checklist exists"""
        # Mix of mapped and unmapped types
        items = loader.load_rubrics_for_study_types(["RCT", "Instrument Development"])

        checklists = set(item.checklist_name for item in items)
        # Should load CONSORT (specialized), but NOT Universal
        assert "CONSORT 2010" in checklists
        assert "Universal" not in str(checklists)

    def test_get_rubric_metadata(self, loader):
        """Test getting rubric metadata"""
        metadata = loader.get_rubric_metadata("consort_2010")

        assert isinstance(metadata, dict)
        assert "name" in metadata
        assert "version" in metadata
        assert "applicable_to" in metadata
        assert "item_count" in metadata

        assert metadata["name"] == "CONSORT 2010"
        assert metadata["item_count"] > 0

    def test_load_nonexistent_rubric(self, loader):
        """Test loading a non-existent rubric"""
        with pytest.raises(FileNotFoundError):
            loader.load_rubric("nonexistent_checklist")

    def test_severity_levels_valid(self, loader):
        """Test that all rubric items have valid severity levels"""
        for rubric_name in ["universal_rubric", "consort_2010", "prisma_2020"]:
            items = loader.load_rubric(rubric_name)

            for item in items:
                assert isinstance(item.severity_if_missing, SeverityLevel)
                assert item.severity_if_missing in [
                    SeverityLevel.CRITICAL,
                    SeverityLevel.MAJOR,
                    SeverityLevel.MINOR,
                    SeverityLevel.NONE
                ]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
