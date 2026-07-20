"""
Rubric Orchestrator - Coordinates rubric selection and block distribution
"""
from typing import List, Dict
import math

from ..schemas.document_ir import StudyProfile
from ..schemas.rubric import RubricItem, RubricBlock
from ..utils.rubric_loader import RubricLoader


class RubricOrchestrator:
    """
    Orchestrator for rubric-driven review process.

    Responsibilities:
    1. Load applicable rubrics based on study types
    2. Divide rubrics into optimal-sized blocks for concurrent execution
    3. Manage task distribution
    """

    BLOCK_SIZE = 6  # Optimal number of items per block (5-8 range)

    def __init__(self, rubric_loader: RubricLoader = None):
        """Initialize orchestrator"""
        self.rubric_loader = rubric_loader or RubricLoader()

    def orchestrate(self, study_profile: StudyProfile, is_review_article: bool = True) -> List[RubricBlock]:
        """
        Load all applicable rubrics and divide into execution blocks.

        Args:
            study_profile: Study classification and metadata
            is_review_article: Whether the manuscript is a review article (systematic review, meta-analysis, etc.)

        Returns:
            List of RubricBlocks ready for concurrent execution
        """
        # Step 1: Load appropriate rubric based on article type
        print(f"[RubricOrchestrator] is_review_article={is_review_article}, study_types={study_profile.study_types}")

        if is_review_article and study_profile.study_types:
            # For review articles, use study-type-specific rubrics (including PRISMA for systematic reviews)
            print(f"[RubricOrchestrator] Loading study-type-specific rubrics for: {study_profile.study_types}")
            rubric_items = self.rubric_loader.load_rubrics_for_study_types(study_profile.study_types)
        else:
            # For non-review articles, always use universal rubric
            # This avoids using PRISMA/CONSORT/STROBE for documents that may not be
            # systematic reviews, RCTs, or observational studies
            print(f"[RubricOrchestrator] Loading universal_rubric (is_review_article={is_review_article})")
            rubric_items = self.rubric_loader.load_rubric("universal_rubric")

        if not rubric_items:
            raise ValueError("Failed to load rubric")

        print(f"[RubricOrchestrator] Loaded {len(rubric_items)} rubric items")
        # Print first few item IDs to verify which rubric was loaded
        if rubric_items:
            sample_ids = [item.item_id for item in rubric_items[:3]]
            print(f"[RubricOrchestrator] Sample item IDs: {sample_ids}")

        # Step 2: Group items by category for logical coherence
        categorized_items = self._categorize_items(rubric_items)

        # Step 3: Create blocks with optimal size
        blocks = self._create_blocks(categorized_items)

        return blocks

    def _categorize_items(self, items: List[RubricItem]) -> Dict[str, List[RubricItem]]:
        """Group rubric items by category"""
        categories: Dict[str, List[RubricItem]] = {}

        for item in items:
            category = item.category
            if category not in categories:
                categories[category] = []
            categories[category].append(item)

        return categories

    def _create_blocks(self, categorized_items: Dict[str, List[RubricItem]]) -> List[RubricBlock]:
        """
        Create rubric blocks from categorized items.

        Strategy:
        - Keep related items (same category) together when possible
        - Aim for BLOCK_SIZE items per block
        - Assign priority based on severity
        """
        blocks: List[RubricBlock] = []
        block_counter = 1

        for category, items in categorized_items.items():
            # Split items into chunks of BLOCK_SIZE
            num_blocks = math.ceil(len(items) / self.BLOCK_SIZE)

            for i in range(num_blocks):
                start_idx = i * self.BLOCK_SIZE
                end_idx = min(start_idx + self.BLOCK_SIZE, len(items))
                block_items = items[start_idx:end_idx]

                # Calculate priority based on severity of items
                priority = self._calculate_block_priority(block_items)

                # Create block name
                block_name = f"{category.replace(' ', '_')}_{i+1}" if num_blocks > 1 else category.replace(' ', '_')

                block = RubricBlock(
                    block_id=f"block_{block_counter:03d}",
                    block_name=block_name,
                    items=block_items,
                    priority=priority
                )

                blocks.append(block)
                block_counter += 1

        # Sort blocks by priority (higher priority first)
        blocks.sort(key=lambda b: b.priority, reverse=True)

        return blocks

    def _calculate_block_priority(self, items: List[RubricItem]) -> int:
        """
        Calculate block priority based on item severities.

        Higher priority = contains more critical items
        """
        severity_weights = {
            "CRITICAL": 10,
            "MAJOR": 5,
            "MINOR": 1,
            "NONE": 0
        }

        total_weight = sum(
            severity_weights.get(item.severity_if_missing.value, 0)
            for item in items
        )

        return total_weight

    def get_orchestration_summary(self, blocks: List[RubricBlock]) -> Dict:
        """Generate a summary of orchestration results"""
        total_items = sum(len(block.items) for block in blocks)
        categories = set(block.block_name.rsplit('_', 1)[0] for block in blocks)

        return {
            "total_blocks": len(blocks),
            "total_items": total_items,
            "average_items_per_block": total_items / len(blocks) if blocks else 0,
            "categories_covered": list(categories),
            "highest_priority": max((b.priority for b in blocks), default=0),
            "blocks_by_priority": sorted(
                [{"block_id": b.block_id, "name": b.block_name, "priority": b.priority, "items": len(b.items)}
                 for b in blocks],
                key=lambda x: x["priority"],
                reverse=True
            )
        }
