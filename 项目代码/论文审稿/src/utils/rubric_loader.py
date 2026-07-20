"""
Rubric Loader - Load and parse YAML rubric files
"""
import os
import yaml
from typing import List, Dict, Any
from pathlib import Path

from ..schemas.rubric import RubricItem, SeverityLevel


class RubricLoader:
    """
    Utility class for loading rubrics from YAML files.
    Supports git-based version control for rubric library.
    """

    def __init__(self, rubrics_dir: str = None):
        """
        Initialize rubric loader.

        Args:
            rubrics_dir: Path to directory containing rubric YAML files.
                        Defaults to src/rubrics/
        """
        if rubrics_dir is None:
            # Default to src/rubrics directory
            current_file = Path(__file__)
            self.rubrics_dir = current_file.parent.parent / "rubrics"
        else:
            self.rubrics_dir = Path(rubrics_dir)

        if not self.rubrics_dir.exists():
            raise FileNotFoundError(f"Rubrics directory not found: {self.rubrics_dir}")

        # Cache loaded rubrics
        self._cache: Dict[str, List[RubricItem]] = {}

    def load_rubric(self, rubric_name: str) -> List[RubricItem]:
        """
        Load a rubric by name.

        Args:
            rubric_name: Name of the rubric file (without .yaml extension)
                        e.g., "consort_2010", "universal_rubric"

        Returns:
            List of RubricItem objects

        Raises:
            FileNotFoundError: If rubric file doesn't exist
            ValueError: If rubric file is invalid
        """
        # Check cache first
        if rubric_name in self._cache:
            return self._cache[rubric_name]

        # Construct file path
        rubric_path = self.rubrics_dir / f"{rubric_name}.yaml"

        if not rubric_path.exists():
            raise FileNotFoundError(f"Rubric file not found: {rubric_path}")

        # Load and parse YAML
        try:
            with open(rubric_path, "r", encoding="utf-8") as f:
                rubric_data = yaml.safe_load(f)

            # Convert to RubricItem objects
            rubric_items = self._parse_rubric_yaml(rubric_data)

            # Cache and return
            self._cache[rubric_name] = rubric_items
            return rubric_items

        except yaml.YAMLError as e:
            raise ValueError(f"Invalid YAML in rubric file {rubric_path}: {str(e)}")
        except Exception as e:
            raise ValueError(f"Failed to parse rubric file {rubric_path}: {str(e)}")

    def _parse_rubric_yaml(self, rubric_data: Dict[str, Any]) -> List[RubricItem]:
        """Parse rubric YAML data into RubricItem objects"""
        rubric_name = rubric_data.get("name", "Unknown Rubric")
        items_data = rubric_data.get("items", [])

        rubric_items = []
        for item_data in items_data:
            # Map severity string to enum
            severity_str = item_data.get("severity_if_missing", "MAJOR")
            severity = SeverityLevel[severity_str]

            rubric_item = RubricItem(
                item_id=item_data["item_id"],
                checklist_name=rubric_name,
                item_number=item_data["item_number"],
                question=item_data["question"],
                question_zh=item_data.get("question_zh", ""),
                evaluation_criteria=item_data["evaluation_criteria"],
                evidence_location_hint=item_data["evidence_location_hint"],
                severity_if_missing=severity,
                category=item_data.get("category", "General")
            )
            rubric_items.append(rubric_item)

        return rubric_items

    def load_rubrics_for_study_types(self, study_types: List[str]) -> List[RubricItem]:
        """
        Load all applicable rubrics for given study types.

        Strategy:
        - If study type has specialized checklist (CONSORT, PRISMA, etc.), use ONLY that checklist
        - If study type has NO mapping, use Universal Rubric as fallback
        - Universal Rubric focuses on research value and contribution, not technical details

        Args:
            study_types: List of study type labels (e.g., ["RCT", "AI"])

        Returns:
            Combined list of all applicable RubricItems (with duplicates removed)
        """
        all_items: List[RubricItem] = []

        # Study type to rubric mapping
        study_type_to_rubric = {
            "RCT": "consort_2010",
            "Cluster RCT": "consort_2010",
            "Pragmatic RCT": "consort_2010",
            "Non-Inferiority RCT": "consort_2010",
            "Systematic Review": "prisma_2020",
            "Meta-Analysis": "prisma_2020",
            "Network Meta-Analysis": "prisma_2020",
            "IPD Meta-Analysis": "prisma_2020",
            "Scoping Review": "prisma_2020",
            "Narrative Review": "prisma_2020",
            "Literature Review": "prisma_2020",
            "Umbrella Review": "prisma_2020",
            "Rapid Review": "prisma_2020",
            "Observational Study": "strobe",
            "Cohort Study": "strobe",
            "Case-Control Study": "strobe",
            "Cross-Sectional Study": "strobe",
            "Real World Data Study": "strobe",
            "Prognostic Model": "tripod_ai",
            "Prediction Model": "tripod_ai",
            "AI": "tripod_ai",
            "Machine Learning": "tripod_ai",
            "Diagnostic Study": "stard",
            "Diagnostic Accuracy Study": "stard",
            "Case Report": "care",
            "Case Series": "care",
            "Animal Study": "arrive",
            "In Vivo Study": "arrive",
            "Qualitative Research": "coreq",
            "Interview Study": "coreq",
            "Focus Group Study": "coreq",
            "Economic Evaluation": "cheers_2022",
            "Cost-Effectiveness Analysis": "cheers_2022",
            "Cost-Utility Analysis": "cheers_2022",
            "Budget Impact Analysis": "cheers_2022",
            "Clinical Practice Guideline": "grade",
            "Expert Consensus": "grade",
            "Recommendation": "grade",
            # 组学/基因组学
            "Genomics Study": "miame_minseqe",
            "Transcriptomics Study": "miame_minseqe",
            "Sequencing Study": "miame_minseqe",
            "Proteomics Study": "miame_minseqe",
            "Multi-Omics Study": "miame_minseqe",
            # 神经影像
            "Neuroimaging Study": "cobidas_mri",
            "fMRI Study": "cobidas_mri",
            "MRI Study": "cobidas_mri",
            "Diffusion MRI Study": "cobidas_mri",
            "PET Study": "cobidas_mri",
            # 流式细胞
            "Flow Cytometry Study": "miflowcyt",
            "Mass Cytometry Study": "miflowcyt",
        }

        # Load rubrics for each study type
        loaded_rubrics = set()
        has_specialized_checklist = False

        for study_type in study_types:
            rubric_name = study_type_to_rubric.get(study_type)
            if rubric_name and rubric_name not in loaded_rubrics:
                try:
                    items = self.load_rubric(rubric_name)
                    all_items.extend(items)
                    loaded_rubrics.add(rubric_name)
                    has_specialized_checklist = True
                except FileNotFoundError:
                    # Rubric not yet implemented, skip
                    continue

        # Fallback: Use Universal Rubric ONLY if no specialized checklist was loaded
        if not has_specialized_checklist:
            universal_items = self.load_rubric("universal_rubric")
            all_items.extend(universal_items)

        # Remove duplicates based on item_id
        seen_ids = set()
        unique_items = []
        for item in all_items:
            if item.item_id not in seen_ids:
                unique_items.append(item)
                seen_ids.add(item.item_id)

        return unique_items

    def list_available_rubrics(self) -> List[str]:
        """List all available rubric files"""
        rubric_files = list(self.rubrics_dir.glob("*.yaml"))
        return [f.stem for f in rubric_files]

    def get_rubric_metadata(self, rubric_name: str) -> Dict[str, Any]:
        """Get metadata about a rubric without loading all items"""
        rubric_path = self.rubrics_dir / f"{rubric_name}.yaml"

        if not rubric_path.exists():
            raise FileNotFoundError(f"Rubric file not found: {rubric_path}")

        with open(rubric_path, "r", encoding="utf-8") as f:
            rubric_data = yaml.safe_load(f)

        return {
            "name": rubric_data.get("name"),
            "version": rubric_data.get("version"),
            "applicable_to": rubric_data.get("applicable_to", []),
            "description": rubric_data.get("description"),
            "item_count": len(rubric_data.get("items", []))
        }
