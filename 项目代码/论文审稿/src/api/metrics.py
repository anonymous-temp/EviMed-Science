"""
Prometheus metrics for monitoring the review service
"""
from prometheus_client import Counter, Histogram, Gauge, generate_latest, CONTENT_TYPE_LATEST
from fastapi import FastAPI, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
import time


# Define metrics
REQUEST_COUNT = Counter(
    'review_api_requests_total',
    'Total number of API requests',
    ['method', 'endpoint', 'status']
)

REQUEST_DURATION = Histogram(
    'review_api_request_duration_seconds',
    'API request duration in seconds',
    ['method', 'endpoint']
)

ACTIVE_JOBS = Gauge(
    'review_active_jobs',
    'Number of currently active review jobs'
)

JOB_STATUS_COUNTER = Counter(
    'review_jobs_total',
    'Total number of review jobs by status',
    ['status']
)

LLM_CALLS_TOTAL = Counter(
    'review_llm_calls_total',
    'Total number of LLM API calls',
    ['agent_type', 'model', 'status']
)

LLM_CALL_DURATION = Histogram(
    'review_llm_call_duration_seconds',
    'LLM API call duration in seconds',
    ['agent_type', 'model']
)

LLM_TOKENS_TOTAL = Counter(
    'review_llm_tokens_total',
    'Total number of tokens used',
    ['agent_type', 'model', 'type']  # type: input or output
)

REVIEW_DURATION = Histogram(
    'review_processing_duration_seconds',
    'End-to-end review processing duration',
    ['study_type']
)

CHECKLIST_ITEMS_EVALUATED = Counter(
    'review_checklist_items_evaluated_total',
    'Total number of checklist items evaluated',
    ['checklist', 'severity']
)

ISSUES_FOUND = Counter(
    'review_issues_found_total',
    'Total number of issues found',
    ['severity']
)


class MetricsMiddleware(BaseHTTPMiddleware):
    """Middleware to track request metrics"""

    async def dispatch(self, request: Request, call_next):
        """Track request duration and count"""
        method = request.method
        path = request.url.path

        # Skip metrics endpoint itself
        if path == "/metrics":
            return await call_next(request)

        # Start timer
        start_time = time.time()

        # Process request
        response = await call_next(request)

        # Record metrics
        duration = time.time() - start_time
        status = str(response.status_code)

        REQUEST_DURATION.labels(method=method, endpoint=path).observe(duration)

        return response


def setup_metrics(app: FastAPI):
    """Setup Prometheus metrics for FastAPI app"""
    # Add middleware
    app.add_middleware(MetricsMiddleware)

    # Add metrics endpoint
    @app.get("/metrics")
    async def metrics():
        """Prometheus metrics endpoint"""
        return Response(
            content=generate_latest(),
            media_type=CONTENT_TYPE_LATEST
        )


# Utility functions for tracking LLM metrics
def track_llm_call(
    agent_type: str,
    model: str,
    duration_seconds: float,
    input_tokens: int,
    output_tokens: int,
    success: bool = True
):
    """
    Track metrics for an LLM API call.

    Args:
        agent_type: Type of agent making the call
        model: LLM model used
        duration_seconds: Call duration
        input_tokens: Number of input tokens
        output_tokens: Number of output tokens
        success: Whether call succeeded
    """
    status = "success" if success else "error"

    LLM_CALLS_TOTAL.labels(agent_type=agent_type, model=model, status=status).inc()
    LLM_CALL_DURATION.labels(agent_type=agent_type, model=model).observe(duration_seconds)
    LLM_TOKENS_TOTAL.labels(agent_type=agent_type, model=model, type="input").inc(input_tokens)
    LLM_TOKENS_TOTAL.labels(agent_type=agent_type, model=model, type="output").inc(output_tokens)


def track_review_completion(study_types: list, duration_seconds: float):
    """
    Track completion of a review job.

    Args:
        study_types: List of study types identified
        duration_seconds: Total processing duration
    """
    for study_type in study_types:
        REVIEW_DURATION.labels(study_type=study_type).observe(duration_seconds)


def track_checklist_evaluation(checklist: str, severity: str, count: int = 1):
    """
    Track checklist item evaluation.

    Args:
        checklist: Checklist name
        severity: Severity level
        count: Number of items
    """
    CHECKLIST_ITEMS_EVALUATED.labels(checklist=checklist, severity=severity).inc(count)


def track_issue(severity: str):
    """
    Track an issue found during review.

    Args:
        severity: Issue severity (CRITICAL, MAJOR, MINOR)
    """
    ISSUES_FOUND.labels(severity=severity).inc()
