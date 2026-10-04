"""How a retrieval ended, in six names a model and a researcher can act on.

Hidden knowledge: until 2026-10-04 a connector that could not finish said so in
whatever words its author chose. A timeout, a refusal, an upstream that was
down and a query that matched nothing all reached the run as "Public source
returned HTTP 502" or as an empty list, and "nothing came back" was read as
"nothing exists" (plan section 5.7: count a metadata response as metadata, and a
failed lookup as a failed lookup). Six outcomes are distinct facts with
distinct next steps, and each one is a name here:

- ``more_available``  the answer is a page of a larger one: how many exist and
  the exact arguments that fetch the next page.
- ``truncated``       a bound cut the answer (a size limit, a count limit): what
  was kept, the limit, and how to get the rest. A body cut at a limit is never
  preserved as if it were the source.
- ``no_results``      the source answered and holds nothing for this request.
  Never evidence that the subject does not exist.
- ``denied``          the source holds it and will not serve it to this caller
  (not open access, a verification page, a policy refusal).
- ``timeout``         the operation's one deadline ran out: while attempting,
  while waiting out a Retry-After, or while a body was still streaming.
- ``unavailable``     the source could not be reached or answered with an
  error; retrying later may work.

A whole retrieval that failed is an error result carrying one of three codes
(``FAILURE_CODES``). A retrieval that succeeded in part carries the failed part
in ``data.outcome.failed`` under the same three names, so one vocabulary covers
"nothing worked" and "most of it worked". The other three live in
``data.outcome`` of a result that has data. ``complete`` is the fourth value a
result's outcome can have and is not one of the six: it says nothing was cut,
nothing was refused and nothing is left.

This module is pure: it builds dicts and one exception. The transport that
decides which outcome a request ended in is ``source_transport``.
"""

from __future__ import annotations

import re

import public_sources

STATES = ("more_available", "truncated", "no_results", "denied", "timeout", "unavailable")
FAILURE_STATES = ("denied", "timeout", "unavailable")
COMPLETE = "complete"

# The code a whole-result failure travels under. `packages/domain/src/
# errorCodes.mjs` classifies each as recoverable: a source that refused,
# stalled or was down is a limitation to report, never a defect in the run.
FAILURE_CODES = {
    "denied": "source_access_denied",
    "timeout": "source_timeout",
    "unavailable": "source_unavailable",
}

# Codes the connectors in this tree already emit for one of the three failure
# names, so a result written before this vocabulary reads in it as well. The
# closed table is the one authority: a test holds every entry classified
# recoverable, and `state_of` answers from nothing else.
LEGACY_STATE_OF_CODE = {
    "public_source_pdf_not_open_access": "denied",
    "public_source_gateway_upstream_denied": "denied",
    "public_source_gateway_url_forbidden": "denied",
    "public_source_api_path_forbidden": "denied",
    "public_source_api_request_forbidden": "denied",
    "public_source_gateway_credential_profile_forbidden": "denied",
    "public_source_gateway_graphql_forbidden": "denied",
    "public_source_pdf_host_forbidden": "denied",
    "web_read_robots_disallowed": "denied",
    "web_read_login_required": "denied",
    "public_source_gateway_timeout": "timeout",
    "web_read_timeout": "timeout",
    "web_search_timeout": "timeout",
    "kb_search_timeout": "timeout",
    "source_parser_timeout": "timeout",
    "public_source_unavailable": "unavailable",
    "public_source_http_error": "unavailable",
    "public_source_gateway_upstream_error": "unavailable",
    "public_source_gateway_upstream_unavailable": "unavailable",
    "public_source_gateway_unavailable": "unavailable",
    "public_source_gateway_rate_limited": "unavailable",
    "public_source_pdf_unavailable": "unavailable",
    "full_text_upstream_unavailable": "unavailable",
    "web_read_upstream_unavailable": "unavailable",
}
_CREDENTIAL_MISSING = re.compile(r"^public_source_[a-z0-9_]+_credential_missing$")


def state_of(code):
    """The failure name a code stands for, or None for a code that is not one."""
    for state, own in FAILURE_CODES.items():
        if code == own:
            return state
    if code in LEGACY_STATE_OF_CODE:
        return LEGACY_STATE_OF_CODE[code]
    # A source nobody configured for this researcher is a refusal to serve them.
    if isinstance(code, str) and _CREDENTIAL_MISSING.match(code):
        return "denied"
    return None


def _clean(facts):
    return {key: value for key, value in facts.items() if value is not None}


def _block(state, facts):
    return {"state": state, **_clean(facts)}


def complete(**facts):
    return _block(COMPLETE, facts)


def more_available(*, returned, total, next_arguments, how, **facts):
    """A page of a larger answer. `total` is None when the source does not say;
    `next_arguments` is what the next call passes, `how` says it in a sentence."""
    return _block("more_available", {
        "returned": returned, "total": total, "remaining": (total - returned) if isinstance(total, int) else None,
        "next": {"arguments": next_arguments, "how": how}, **facts,
    })


def truncated(*, kept, limit, unit, how, **facts):
    """An answer a bound cut. `kept` is what survived, in `unit`; never zero
    bytes of a body that was discarded without being preserved."""
    return _block("truncated", {"kept": kept, "limit": limit, "unit": unit, "how": how, **facts})


def no_results(*, reason, how, **facts):
    """The source answered and holds nothing. `reason` is a closed word of the
    caller's own (`no_match`, `not_found`, `not_in_pmc`, ...)."""
    return _block("no_results", {"reason": reason, "how": how, **facts})


def failed_part(scope, state, reason, how, **facts):
    """One part of a result that did not work, in the failure vocabulary."""
    if state not in FAILURE_STATES:
        raise ValueError("%r is not a failure state" % (state,))
    return _clean({"scope": scope, "state": state, "reason": reason, "how": how, **facts})


def with_failures(block, failures):
    """`block` with its failed parts attached, or unchanged when there are none."""
    if not failures:
        return block
    return {**block, "failed": list(failures)}


class SourceError(public_sources.PublicSourceError):
    """A retrieval that failed as a whole, in one of the three failure names.

    A `PublicSourceError`, so the server's existing handling (the circuit
    breaker, the failure result) applies; it adds the closed `state`, the
    words that tell a run what to do, and the retry hint a rate limit gave.
    """

    def __init__(self, state, message, *, scope=None, reason=None, retryable=None, retry_after=None,
                 partial=None, code=None, how=None):
        if state not in FAILURE_STATES:
            raise ValueError("%r is not a failure state" % (state,))
        super().__init__(code or FAILURE_CODES[state], message, (state != "denied") if retryable is None else retryable)
        self.state = state
        self.scope = scope
        self.reason = reason
        self.retry_after = retry_after
        self.partial = partial
        self.how = how

    def restated(self, reason, message):
        """This failure with a more exact reason and message (the same state)."""
        self.reason = reason
        self.args = (message,)
        return self

    def entry(self):
        """This failure as one `data.outcome.failed` entry."""
        return failed_part(
            self.scope, self.state, self.reason, self.how or self.next_actions()[0],
            message=str(self), retryAfterSeconds=self.retry_after, partial=self.partial,
        )

    def next_actions(self):
        """What the tool result tells the model to do."""
        scope = self.scope or "this source"
        if self.how:
            return [self.how]
        if self.state == "denied":
            return [
                "Do not retry %s: it holds the item and does not serve it to an unauthenticated client." % scope,
                "Say that the item is not openly available here and, if its text matters, that the researcher can add the PDF to the knowledge base.",
            ]
        if self.state == "timeout":
            return [
                "The call's whole time budget was spent; asking again at once usually costs the same wait. Retry once later, or go on with the sources already read.",
                "Say that %s did not answer in time. A source that did not answer is not evidence that the record does not exist." % scope,
            ]
        wait = (" It asked for a wait of %d s." % self.retry_after) if self.retry_after else ""
        return [
            "Retry %s once after a short wait; if it fails again go on with other sources.%s" % (scope, wait),
            "Say that %s could not be reached. A source that could not be reached is not evidence that the record does not exist." % scope,
        ]

    def stop_reason(self):
        return {
            "denied": "The source refused this item, so retrying cannot change the result.",
            "timeout": "The call's time budget was spent before the source finished answering.",
            "unavailable": "The source could not be reached or answered with an error; one later retry is reasonable.",
        }[self.state]


class Truncated(Exception):
    """A body that reached a bound before it ended. Not an error of the source:
    the caller decides whether what arrived is usable, and a body cut at a bound
    is never one a record or a file may be preserved from."""

    def __init__(self, received, limit, *, reason="size_limit", declared=None):
        super().__init__("%d bytes received before the %s of %d" % (received, reason.replace("_", " "), limit))
        self.received = received
        self.limit = limit
        self.reason = reason
        self.declared = declared


def error_result(error):
    """The ToolResult a whole-result `SourceError` becomes: an error with the
    closed code and the next actions for its state."""
    return {
        "status": "error",
        "summary": str(error),
        "next_actions": error.next_actions(),
        "error": {
            "code": error.code,
            "message": str(error),
            "retryable": bool(error.retryable),
            "stopReason": error.stop_reason(),
        },
    }
