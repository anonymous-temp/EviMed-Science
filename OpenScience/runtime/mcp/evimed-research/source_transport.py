"""One deadline, bounded retries and a named outcome for every retrieval that reads a record or a file.

Hidden knowledge: the connectors in `public_sources.py` ask the gateway once,
read the whole body, and report any failure as "Public source returned HTTP N"
or "Public source is unavailable". That loses three things a run needs. Whether
the source refused (retrying cannot help), stalled (the time is gone) or was
down (one later retry is reasonable). Whether a 429 said when to come back.
And that a body still streaming when the time ran out is a timeout, not a
success. The three tools that read a record or a file (an identifier
resolution, a full text with its supplements, a trial record, a drug label)
share this module instead of each growing its own answer to those questions
(plan section 5.7; AIPOCH's connector request policy is the reference for the
retry rules below).

The rules, each held by a test in `test_source_transport.py`:

- **One deadline per operation.** A `Deadline` is created once and passed down.
  It bounds every attempt's socket timeout, every wait between attempts and
  every chunk of a streamed body. Nothing resets it.
- **Retry the transient, never the final.** 429 and 5xx (as the gateway maps
  them) and a failed connection are retried, up to `attempts`, with bounded
  exponential backoff and jitter. A socket timeout is not retried: it already
  spent the time. A refusal (401/403), a missing record (404) and a request
  the source rejected (400) are answers, not failures to ride out. A request
  that changes something at the source is retried only when its caller says it
  is idempotent.
- **Retry-After is honoured, inside the time left.** Seconds or an HTTP date.
  When the wait does not fit in what remains, the call stops at once and says
  how long the source asked for, instead of sleeping into a timeout.
- **A body is bounded while it streams.** At most `max_bytes` are read; a body
  that declares more is refused before it is read; a body whose connection
  closes early is `Truncated`, never returned as if it were whole.

The gateway (`apps/server/src/publicSourceGateway.mjs`) is the only door out. It
now answers 403 `public_source_gateway_upstream_denied` for a source that
refused, 504 `public_source_gateway_timeout` for a deadline spent while the
body streamed as well as while it was awaited, and passes the source's
Retry-After through (`retry-after` header and `error.retryAfterSeconds`).
"""

from __future__ import annotations

import http.client
import json
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import public_sources
import source_outcome
from source_outcome import SourceError, Truncated

ATTEMPTS = 3
PER_ATTEMPT_SECONDS = 20.0
BACKOFF_BASE_SECONDS = 0.4
BACKOFF_CAP_SECONDS = 4.0
CHUNK_BYTES = 64 * 1024
DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_RETRY_AFTER_SECONDS = 3600
# The kernel abandons a tool call at 180 s; an operation's deadline stays
# inside that so its own answer, not the kernel's silence, is what a run sees.
MAX_DEADLINE_SECONDS = 150.0
_NCBI_HOSTS = frozenset({"eutils.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov"})
_JSON_TYPES = ("application/json", "text/json")


class Deadline:
    """The one time budget of an operation, on a monotonic clock."""

    def __init__(self, seconds, *, clock=None):
        self.seconds = min(max(float(seconds), 1.0), MAX_DEADLINE_SECONDS)
        self._clock = clock or time.monotonic
        self._start = self._clock()

    def spent(self):
        return self._clock() - self._start

    def remaining(self):
        return max(0.0, self.seconds - self.spent())

    def expired(self):
        return self.remaining() <= 0.0

    def socket_timeout(self, cap):
        """What one socket operation may wait: the smaller of the cap and what is left."""
        return max(1.0, min(float(cap), self.remaining()))


class Response:
    """What came back: status, lower-cased headers, the whole body, and what it cost."""

    __slots__ = ("status", "headers", "content_type", "body", "attempts", "waited")

    def __init__(self, status, headers, content_type, body, attempts=1, waited=0.0):
        self.status = status
        self.headers = headers
        self.content_type = content_type
        self.body = body
        self.attempts = attempts
        self.waited = waited

    def text(self):
        return self.body.decode("utf-8")

    def json(self, strict=True):
        return json.loads(self.text(), strict=strict)


def parse_retry_after(value, *, now=None):
    """A Retry-After header as whole seconds (0..MAX_RETRY_AFTER_SECONDS), or None."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.isdigit():
        return min(int(text), MAX_RETRY_AFTER_SECONDS)
    try:
        moment = parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return None
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    current = now if now is not None else datetime.now(timezone.utc)
    return min(max(int((moment - current).total_seconds() + 0.999), 0), MAX_RETRY_AFTER_SECONDS)


def retry_delay(attempt, retry_after=None, *, rng=None):
    """Seconds to wait before attempt `attempt + 1`: what the source asked for,
    else bounded exponential backoff with jitter."""
    if retry_after is not None:
        return float(retry_after)
    jitter = (rng or random.random)() * BACKOFF_BASE_SECONDS
    return min(BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)), BACKOFF_CAP_SECONDS) + jitter


def _content_type(response):
    headers = response.headers
    getter = getattr(headers, "get_content_type", None)
    if getter is not None:
        return getter()
    raw = ""
    for name, value in (headers.items() if hasattr(headers, "items") else []):
        if str(name).lower() == "content-type":
            raw = str(value)
    return raw.split(";", 1)[0].strip().lower()


def _header_map(response):
    headers = response.headers
    items = headers.items() if hasattr(headers, "items") else []
    return {str(name).lower(): str(value) for name, value in items}


def _declared_length(response):
    try:
        value = response.headers.get("Content-Length")
        declared = int(value) if value is not None and str(value).strip() != "" else None
    except (TypeError, ValueError):
        return None
    return declared if declared is not None and declared >= 0 else None


def _tighten(response, deadline):
    """Shrink the socket's own timeout to what the deadline has left, so a stalled
    read cannot outlive it by a whole per-attempt timeout. Best effort: a body
    that is not a socket (a replayed fixture, a test double) has nothing to shrink."""
    try:
        response.fp.raw._sock.settimeout(max(1.0, deadline.remaining()))  # noqa: SLF001 - CPython's own layout
    except Exception:  # noqa: BLE001
        return


def _is_timeout(error):
    return isinstance(error, (TimeoutError, socket.timeout)) or isinstance(getattr(error, "reason", None), (TimeoutError, socket.timeout))


def read_body(response, *, max_bytes, deadline, scope=None, chunk=CHUNK_BYTES):
    """The body, read in chunks inside the deadline and the byte bound.

    Raises `SourceError(timeout)` when the deadline runs out between chunks or a
    read stalls (with how many bytes had arrived), and `Truncated` when the body
    would pass `max_bytes`, declares more than that, or ends before it should.
    """
    declared = _declared_length(response)
    if declared is not None and declared > max_bytes:
        raise Truncated(0, max_bytes, reason="size_limit", declared=declared)
    parts = []
    received = 0
    while True:
        if deadline.expired():
            raise source_outcome.timed_out("The time budget ran out while %s was still sending its answer (%d bytes had arrived)." % (scope or "the source", received),
                scope=scope, reason="deadline_during_body", retryable=True, partial={"bytesReceived": received},
            )
        _tighten(response, deadline)
        try:
            piece = response.read(min(chunk, max_bytes + 1 - received))
        except http.client.IncompleteRead as error:
            raise Truncated(received + len(error.partial or b""), max_bytes, reason="connection_closed_early", declared=declared) from error
        except (TimeoutError, socket.timeout) as error:
            raise source_outcome.timed_out("%s stopped sending its answer (%d bytes had arrived)." % (scope or "The source", received),
                scope=scope, reason="read_stalled", retryable=True, partial={"bytesReceived": received},
            ) from error
        if not piece:
            break
        parts.append(piece)
        received += len(piece)
        if received > max_bytes:
            raise Truncated(received, max_bytes, declared=declared)
    if declared is not None and received < declared:
        raise Truncated(received, max_bytes, reason="connection_closed_early", declared=declared)
    return b"".join(parts)


def _envelope(error):
    """The gateway's `{error: {code, message, ...}}` from an HTTP error, or {}."""
    try:
        body = json.loads(error.read(64 * 1024).decode("utf-8"))
    except Exception:  # noqa: BLE001 - not the gateway's envelope; the status is the finding
        return {}
    value = body.get("error") if isinstance(body, dict) else None
    return value if isinstance(value, dict) else {}


class NotFound(Exception):
    """The source answered 404: it holds no such record. An answer, not a failure."""


def classify_http_error(error, *, scope):
    """An HTTP error from the gateway (or a source directly) as the exception it means.

    Returns a `SourceError`, a `public_sources.SourceNotConfigured`, a
    `NotFound`, or a `Truncated` (the gateway's own size limit). Never raises.
    """
    status = getattr(error, "code", None)
    envelope = _envelope(error)
    code = envelope.get("code") if isinstance(envelope.get("code"), str) else None
    not_configured = public_sources._not_configured_from_failure(envelope)  # noqa: SLF001
    if not_configured is not None:
        return not_configured
    retry_after = parse_retry_after(error.headers.get("Retry-After") if getattr(error, "headers", None) is not None else None)
    if retry_after is None and isinstance(envelope.get("retryAfterSeconds"), (int, float)):
        retry_after = min(max(int(envelope["retryAfterSeconds"]), 0), MAX_RETRY_AFTER_SECONDS)
    if status == 404:
        return NotFound()
    if code == "public_source_gateway_response_too_large":
        return Truncated(0, 0, reason="gateway_size_limit")
    mapped = source_outcome.state_of(code)
    if status in (401, 403) or mapped == "denied":
        reason = "policy" if mapped == "denied" and code != "public_source_gateway_upstream_denied" else "refused_by_source"
        return source_outcome.denied("%s refused this request (HTTP %s)." % (scope or "The source", status), scope=scope, reason=reason, retryable=False)
    if status in (408, 504) or mapped == "timeout":
        return source_outcome.timed_out("%s did not answer in time." % (scope or "The source"), scope=scope, reason="source_did_not_answer", retryable=True)
    if status == 429 or code == "public_source_gateway_rate_limited":
        return source_outcome.unavailable("%s is rate limiting this caller." % (scope or "The source"), scope=scope, reason="rate_limited", retryable=True, retry_after=retry_after)
    if status == 400:
        return source_outcome.unavailable("%s rejected the request as invalid (HTTP 400)." % (scope or "The source"), scope=scope, reason="request_rejected", retryable=False)
    return source_outcome.unavailable("%s answered with an error (HTTP %s)." % (scope or "The source", status), scope=scope,
        reason="upstream_error", retryable=True, retry_after=retry_after,
    )


def _pace(url):
    if (urllib.parse.urlsplit(url).hostname or "").casefold() in _NCBI_HOSTS:
        public_sources._ncbi_pace()  # noqa: SLF001 - one pacing lock for every NCBI call


def _run(open_response, handle, *, deadline, scope, per_attempt, attempts, idempotent, accept_statuses, sleep, rng, pace_url=None):
    """The attempt loop both `fetch` and `download` share.

    `open_response(timeout_seconds)` opens one response (a context manager);
    `handle(response, attempt, waited)` turns it into the result. Everything
    the module promises about deadlines, retries and Retry-After lives here.
    """
    sleeper = sleep or time.sleep
    allowed_attempts = max(1, int(attempts)) if idempotent else 1
    waited = 0.0
    attempt = 0
    while True:
        attempt += 1
        if deadline.expired():
            raise source_outcome.timed_out("The time budget ran out before %s could be asked%s." % (scope, " again" if attempt > 1 else ""),
                scope=scope, reason="deadline_before_attempt", retryable=True,
            )
        if pace_url:
            _pace(pace_url)
        failure = None
        try:
            with open_response(deadline.socket_timeout(per_attempt)) as response:
                return handle(response, attempt, waited)
        except urllib.error.HTTPError as error:
            classified = classify_http_error(error, scope=scope)
            if isinstance(classified, NotFound):
                if 404 in accept_statuses:
                    return handle(None, attempt, waited)
                raise source_outcome.unavailable("%s holds no record at this address (HTTP 404)." % scope, scope=scope, reason="not_found", retryable=False) from error
            if isinstance(classified, (Truncated, public_sources.SourceNotConfigured)):
                raise classified from error
            if error.code in accept_statuses:
                return handle(None, attempt, waited)
            failure = classified
        except SourceError:
            raise
        except Truncated:
            raise
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError, http.client.HTTPException) as error:
            if _is_timeout(error):
                raise source_outcome.timed_out("%s did not answer within %d s." % (scope, int(deadline.socket_timeout(per_attempt))),
                    scope=scope, reason="no_answer_in_time", retryable=True,
                ) from error
            failure = source_outcome.unavailable("%s could not be reached (%s)." % (scope, getattr(error, "reason", None) or type(error).__name__),
                scope=scope, reason="connection_failed", retryable=True,
            )
        # `failure` is a retryable-or-final SourceError for this attempt.
        if failure.state == "timeout" or not failure.retryable or attempt >= allowed_attempts:
            raise failure
        delay = retry_delay(attempt, failure.retry_after, rng=rng)
        if delay >= deadline.remaining():
            # A wait that does not fit is not slept: say what the source asked for.
            if failure.retry_after is not None:
                raise failure.restated(
                    "retry_after_exceeds_deadline",
                    "%s asked for a wait of %d s and only %d s of the time budget remain." % (
                        scope, failure.retry_after, int(deadline.remaining())),
                )
            raise failure
        sleeper(delay)
        waited += delay


def _wrong_type(content_type, scope):
    """The failure a response of an unasked-for type is: a web page where data
    was asked for is a verification or login wall, anything else is unreadable."""
    if content_type == "text/html":
        return source_outcome.denied("%s answered with a web page instead of the data (a verification or login page)." % scope,
            scope=scope, reason="verification_page", retryable=False,
        )
    return source_outcome.unavailable("%s answered with content type %s, which is not what was asked for." % (scope, content_type or "none"),
        scope=scope, reason="unexpected_content_type", retryable=False,
    )


def fetch(url, accepted, *, deadline, scope, max_bytes=DEFAULT_MAX_BODY_BYTES, per_attempt=PER_ATTEMPT_SECONDS,
          attempts=ATTEMPTS, method="GET", json_body=None, credential_profile=None, idempotent=None,
          accept_statuses=(), sleep=None, rng=None):
    """One retrieval inside `deadline`; a `Response`, or one of the exceptions above.

    `accept_statuses` lists the HTTP statuses the caller wants back as a
    `Response` rather than an exception (a 404 for a lookup by id). A response
    whose type is not in `accepted` is a verification or login page when it is
    HTML (`denied`) and an unreadable answer otherwise (`unavailable`).
    """
    def open_response(timeout):
        return public_sources._open_remote(  # noqa: SLF001 - the one door out
            url, tuple(accepted), method=method, json_body=json_body, timeout_seconds=timeout, credential_profile=credential_profile,
        )

    def handle(response, attempt, waited):
        if response is None:
            return Response(404, {}, "", b"", attempt, waited)
        content_type = _content_type(response)
        if content_type not in accepted:
            raise _wrong_type(content_type, scope)
        body = read_body(response, max_bytes=max_bytes, deadline=deadline, scope=scope)
        return Response(getattr(response, "status", None) or 200, _header_map(response), content_type, body, attempt, waited)

    return _run(
        open_response, handle, deadline=deadline, scope=scope, per_attempt=per_attempt, attempts=attempts,
        idempotent=(method == "GET") if idempotent is None else idempotent, accept_statuses=accept_statuses,
        sleep=sleep, rng=rng, pace_url=url,
    )


# The named downloads (`downloadKinds` in apps/server/src/publicSourceGateway.mjs
# serves the same kinds, and a test holds the two lists equal). `direct` builds
# the upstream address for a deployment with no gateway and for fixture replay,
# which is keyed on the upstream request; through the gateway the runtime sends
# the kind and its identifiers and nothing else.
DOWNLOAD_KINDS = {
    "epmc-supplements": {"direct": lambda p: "https://www.ebi.ac.uk/europepmc/webservices/rest/%s/supplementaryFiles" % p["pmcid"], "accept": ("application/zip", "application/xml")},
    "dailymed-spl-zip": {"direct": lambda p: "https://dailymed.nlm.nih.gov/dailymed/getFile.cfm?setid=%s&type=zip&version=%d" % (str(p["setid"]).lower(), int(p["version"])), "accept": ("application/zip",)},
}


class Download:
    """A named download's outcome: the bytes that arrived and whether the body ended where it should.

    `complete` is False when the deadline, the byte bound or the connection
    ended it first, and `reason` says which; `body` is then what arrived, which
    a caller may still read the finished parts of (a zip's whole entries) but
    must never preserve as the file.
    """

    __slots__ = ("body", "content_type", "complete", "reason", "received", "declared", "attempts", "elapsed")

    def __init__(self, body, content_type, complete, reason, declared, attempts, elapsed):
        self.body = body
        self.content_type = content_type
        self.complete = complete
        self.reason = reason
        self.received = len(body)
        self.declared = declared
        self.attempts = attempts
        self.elapsed = elapsed


def _read_download(response, *, max_bytes, deadline, chunk=CHUNK_BYTES):
    """Read a download inside the deadline and the byte bound, keeping what arrived.

    Returns `(body, reason)`: reason None for a body that ended where it should.
    """
    declared = _declared_length(response)
    parts = []
    received = 0
    reason = None
    while True:
        if deadline.expired():
            reason = "deadline"
            break
        _tighten(response, deadline)
        try:
            piece = response.read(min(chunk, max_bytes + 1 - received))
        except http.client.IncompleteRead as error:
            partial = error.partial or b""
            parts.append(partial)
            received += len(partial)
            reason = "connection_closed_early"
            break
        except (TimeoutError, socket.timeout):
            reason = "read_stalled"
            break
        if not piece:
            break
        parts.append(piece)
        received += len(piece)
        if received > max_bytes:
            reason = "size_limit"
            break
    if reason is None and declared is not None and received < declared:
        reason = "connection_closed_early"
    body = b"".join(parts)
    return (body[:max_bytes] if reason == "size_limit" else body), reason, declared


def download(kind, params, *, deadline, scope, max_bytes=16 * 1024 * 1024, per_attempt=PER_ATTEMPT_SECONDS, attempts=2,
             sleep=None, rng=None, chunk=CHUNK_BYTES):
    """A named download through the gateway, inside `deadline`; a `Download`.

    A refusal, a missing file or a time budget spent before the first byte
    raises exactly as `fetch` does; a body that stops partway returns what
    arrived with `complete=False`. A response of an unasked-for type that is
    small (Europe PMC's "not open access" and "no supplementary files" answers
    are XML with status 200) is returned whole for the caller, who knows that
    wire, to read.
    """
    spec = DOWNLOAD_KINDS[kind]
    accepted = spec["accept"]
    started = deadline.spent()

    def open_response(timeout):
        gateway = None if public_sources.fixtures.fixtures_dir() else public_sources._gateway_settings()  # noqa: SLF001
        if gateway is None:
            return public_sources._open_remote(spec["direct"](params), accepted, timeout_seconds=timeout)  # noqa: SLF001
        gateway_url, token = gateway
        request = urllib.request.Request(
            gateway_url,
            data=json.dumps({"download": {"kind": kind, **params}}).encode("utf-8"),
            headers={
                "accept": ", ".join(accepted), "authorization": "Bearer %s" % token,
                "content-type": "application/json", "user-agent": "EviMed-Research/1.2 (runtime connector)",
            },
            method="POST",
        )
        return public_sources._OPENER.open(request, timeout=min(max(float(timeout), 1), 120))  # noqa: SLF001

    def handle(response, attempt, waited):
        if response is None:
            raise source_outcome.unavailable("%s holds no such file." % scope, scope=scope, reason="not_found", retryable=False)
        content_type = _content_type(response)
        if content_type not in accepted:
            raise _wrong_type(content_type, scope)
        # A small type is an answer in words, not the file: read it whole and bounded.
        limit = max_bytes if content_type == "application/zip" else 64 * 1024
        body, reason, declared = _read_download(response, max_bytes=limit, deadline=deadline, chunk=chunk)
        return Download(body, content_type, reason is None, reason, declared, attempt, deadline.spent() - started)

    return _run(
        open_response, handle, deadline=deadline, scope=scope, per_attempt=per_attempt, attempts=attempts,
        idempotent=True, accept_statuses=(), sleep=sleep, rng=rng,
    )


def fetch_json(url, *, deadline, scope, strict=True, **options):
    """`fetch` for a JSON answer: `(value, response)`; a body that is not JSON is `unavailable`."""
    response = fetch(url, _JSON_TYPES, deadline=deadline, scope=scope, **options)
    if response.status == 404 and not response.body:
        return None, response
    try:
        return response.json(strict=strict), response
    except (UnicodeDecodeError, ValueError) as error:
        raise source_outcome.unavailable("%s answered with text that is not JSON." % scope, scope=scope, reason="invalid_response", retryable=False) from error
