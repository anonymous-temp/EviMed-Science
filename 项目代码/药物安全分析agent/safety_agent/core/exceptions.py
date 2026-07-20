"""Centralized exception hierarchy for the safety agent.

Design rules carried over from the legacy Java service review:
- never leak internal tracebacks or upstream payloads to API callers;
- never swallow an exception silently (log it, then re-raise or wrap it);
- every failure mode has a dedicated type so the API layer can map it to a
  clean 4xx/5xx response instead of a bare 500.
"""

from __future__ import annotations


class SafetyAgentError(Exception):
    """Base class for all agent errors.

    ``message`` is safe to surface to callers; ``detail`` carries internal
    context for logs only.
    """

    def __init__(self, message: str, *, detail: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail

    def __str__(self) -> str:  # keep logs informative without repr noise
        if self.detail:
            return f"{self.message} (detail: {self.detail})"
        return self.message


class ConfigError(SafetyAgentError):
    """Invalid or missing configuration."""


class OpenFDAError(SafetyAgentError):
    """An openFDA request failed in a non-retryable way."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        detail: str | None = None,
    ) -> None:
        super().__init__(message, detail=detail)
        self.status_code = status_code


class OpenFDARateLimited(OpenFDAError):
    """HTTP 429 persisted after all retry attempts."""

    def __init__(self, message: str = "openFDA rate limit exceeded", *, retry_after: float | None = None) -> None:
        super().__init__(message, status_code=429)
        self.retry_after = retry_after


class OpenFDAUnavailable(OpenFDAError):
    """Network errors or HTTP 5xx persisted after all retry attempts."""


class NoResults(OpenFDAError):
    """openFDA answered 404 NOT_FOUND: the query matched zero records.

    This is a legitimate "no data" outcome, not a server failure; callers
    must be able to distinguish it from real errors.
    """

    def __init__(self, message: str = "no matching records on openFDA", *, search: str | None = None) -> None:
        super().__init__(message, status_code=404, detail=f"search={search}" if search else None)
        self.search = search


class NormalizationError(SafetyAgentError):
    """A drug name or ADR term could not be normalized at all.

    The API layer maps this to HTTP 400 (bad input), never to a 500.
    """


class NoDataError(SafetyAgentError):
    """The query is well-formed but matched zero FAERS reports.

    Surfaced to callers as a clear "no data found" outcome (HTTP 404-ish
    business response), never as a 500.
    """


class LLMError(SafetyAgentError):
    """Base class for DeepSeek client failures."""


class LLMAuthError(LLMError):
    """HTTP 401/403: missing or invalid API key. Not retryable."""


class LLMRateLimited(LLMError):
    """HTTP 429 persisted after all retry attempts."""


class LLMUnavailable(LLMError):
    """Network errors or HTTP 5xx persisted after all retry attempts."""


class LLMResponseError(LLMError):
    """The model produced unusable output (bad JSON / schema mismatch)
    even after the single repair retry."""


class EvidenceSearchError(SafetyAgentError):
    """The EviMed evidence retrieval API failed (any non-200 code)."""
