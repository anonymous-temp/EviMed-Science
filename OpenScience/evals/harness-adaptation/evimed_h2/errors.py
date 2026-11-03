"""Failure classes. The one rule they carry: a failure of the machinery is never a result about a harness.

`InfrastructureFailure` is raised for the lab (slot, broker, bundle), the improver channel (quota, transport, timeout) and the
budget guards. It carries `infrastructure = True`, which the one patched line of upstream's `recursion._roll` reads, so a dead
rollout is not folded into a RunView and a stage that could not run is not folded into an inherited-harness candidate.
"""

from __future__ import annotations


class InfrastructureFailure(Exception):
    """The machinery failed, not the harness. Retry later; never score it, never adopt around it."""

    infrastructure = True

    def __init__(self, kind: str, message: str, *, retry_after_s: int | None = None, cost_usd: float = 0.0):
        super().__init__(f"[{kind}] {message}")
        self.kind = kind
        self.detail = message
        self.retry_after_s = retry_after_s
        self.cost_usd = cost_usd


class QuotaExhausted(InfrastructureFailure):
    """The improver's account is out of quota or rate-limited: every later session would fail the same way."""

    def __init__(self, message: str, *, retry_after_s: int | None = None):
        super().__init__("quota", message, retry_after_s=retry_after_s)


class BudgetStop(InfrastructureFailure):
    """The round's money guard fired (balance below the floor for good, or the round cap reached)."""

    def __init__(self, message: str):
        super().__init__("budget", message)


class IdentityMismatch(RuntimeError):
    """A resumed directory belongs to different inputs, models or tasks. Configuration, not infrastructure: nothing to retry."""


class ContaminationRefused(ValueError):
    """A request or tree that would carry a gold answer, a rubric, a score or task text. Message is actionable prose."""
