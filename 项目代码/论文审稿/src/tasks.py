"""
Celery tasks for distributed review execution
"""
from celery import group, chord
from typing import Dict, Any
import asyncio

from .celery_app import app
from .services.llm_gateway import LLMGateway, LLMProvider
from .agents.methodology_reviewer import MethodologyReviewerAgent
from .agents.statistician_reviewer import StatisticianReviewerAgent
from .schemas.document_ir import DocumentIR, EvidenceMap
from .schemas.rubric import RubricBlock, BlockReviewResult
from .utils.logging_config import get_logger


# Initialize logger
logger = get_logger(__name__)


def run_async(coro):
    """Helper to run async functions in Celery tasks"""
    loop = asyncio.get_event_loop()
    return loop.run_until_complete(coro)


@app.task(name='review_rubric_block', bind=True, max_retries=3)
def review_rubric_block_task(
    self,
    block_data: Dict[str, Any],
    document_ir_data: Dict[str, Any],
    evidence_map_data: Dict[str, Any],
    llm_config: Dict[str, str]
) -> Dict[str, Any]:
    """
    Celery task to review a single rubric block.

    Args:
        self: Celery task instance (for retry)
        block_data: Serialized RubricBlock
        document_ir_data: Serialized DocumentIR
        evidence_map_data: Serialized EvidenceMap
        llm_config: LLM configuration (provider, api_key)

    Returns:
        Serialized BlockReviewResult
    """
    try:
        # Deserialize inputs
        rubric_block = RubricBlock(**block_data)
        document_ir = DocumentIR(**document_ir_data)
        evidence_map = EvidenceMap(**evidence_map_data)

        # Initialize LLM gateway
        provider = LLMProvider[llm_config['provider'].upper()]
        llm_gateway = LLMGateway(
            provider=provider,
            api_key=llm_config.get('api_key')
        )

        # Create reviewer agent
        reviewer = MethodologyReviewerAgent(llm_gateway)

        # Execute review (async)
        result = run_async(reviewer.review_block(
            rubric_block=rubric_block,
            document_ir=document_ir,
            evidence_map=evidence_map
        ))

        # Log success
        logger.log_agent_execution(
            agent_type="MethodologyReviewer",
            task_id=self.request.id,
            duration_ms=result.execution_time_seconds * 1000,
            success=True
        )

        # Return serialized result
        return result.model_dump()

    except Exception as exc:
        # Log error
        logger.log_agent_execution(
            agent_type="MethodologyReviewer",
            task_id=self.request.id,
            duration_ms=0,
            success=False,
            error=str(exc)
        )

        # Retry with exponential backoff
        raise self.retry(exc=exc, countdown=2 ** self.request.retries)


@app.task(name='review_statistics', bind=True, max_retries=3)
def review_statistics_task(
    self,
    document_ir_data: Dict[str, Any],
    evidence_map_data: Dict[str, Any],
    llm_config: Dict[str, str]
) -> Dict[str, Any]:
    """
    Celery task for specialized statistical review.

    Args:
        self: Celery task instance
        document_ir_data: Serialized DocumentIR
        evidence_map_data: Serialized EvidenceMap
        llm_config: LLM configuration

    Returns:
        Serialized BlockReviewResult
    """
    try:
        # Deserialize inputs
        document_ir = DocumentIR(**document_ir_data)
        evidence_map = EvidenceMap(**evidence_map_data)

        # Initialize LLM gateway
        provider = LLMProvider[llm_config['provider'].upper()]
        llm_gateway = LLMGateway(
            provider=provider,
            api_key=llm_config.get('api_key')
        )

        # Create statistician reviewer
        statistician = StatisticianReviewerAgent(llm_gateway)

        # Execute review
        result = run_async(statistician.review_statistics(
            document_ir=document_ir,
            evidence_map=evidence_map
        ))

        # Log success
        logger.log_agent_execution(
            agent_type="StatisticianReviewer",
            task_id=self.request.id,
            duration_ms=result.execution_time_seconds * 1000,
            success=True
        )

        return result.model_dump()

    except Exception as exc:
        logger.log_agent_execution(
            agent_type="StatisticianReviewer",
            task_id=self.request.id,
            duration_ms=0,
            success=False,
            error=str(exc)
        )

        raise self.retry(exc=exc, countdown=2 ** self.request.retries)


def dispatch_concurrent_reviews(
    rubric_blocks: list,
    document_ir: DocumentIR,
    evidence_map: EvidenceMap,
    llm_config: Dict[str, str]
) -> list:
    """
    Dispatch concurrent review tasks using Celery groups.

    Args:
        rubric_blocks: List of RubricBlock objects
        document_ir: DocumentIR instance
        evidence_map: EvidenceMap instance
        llm_config: LLM configuration

    Returns:
        List of BlockReviewResult objects
    """
    # Serialize shared data
    document_ir_data = document_ir.model_dump()
    evidence_map_data = evidence_map.model_dump()

    # Create task group for concurrent execution
    tasks = []

    # Add rubric block review tasks
    for block in rubric_blocks:
        task = review_rubric_block_task.s(
            block_data=block.model_dump(),
            document_ir_data=document_ir_data,
            evidence_map_data=evidence_map_data,
            llm_config=llm_config
        )
        tasks.append(task)

    # Add statistics review task
    stats_task = review_statistics_task.s(
        document_ir_data=document_ir_data,
        evidence_map_data=evidence_map_data,
        llm_config=llm_config
    )
    tasks.append(stats_task)

    # Execute all tasks concurrently
    job = group(tasks)
    result_group = job.apply_async()

    # Wait for all tasks to complete
    results = result_group.get()  # This blocks until all tasks complete

    # Deserialize results
    review_results = [BlockReviewResult(**r) for r in results]

    return review_results
