"""The six outcomes and the one deadline: how a retrieval ends, and what it costs to find out.

Everything here runs against a fake of the gateway door (`public_sources._open_remote`)
with a clock the test advances, so a deadline is spent by a step of the fake clock
and not by sleeping. The shapes the fakes copy were recorded from the live wire on
2026-10-04 (`test/wire/manifest.json` lists which): the ID converter answered
`429 Too Many Requests` as HTML with no Retry-After, the PMC supplementary-file
URL answered a reCAPTCHA page with HTTP 200 and `text/html`, and the gateway's own
errors are `{error: {code, message}}` envelopes.
"""

import http.client
import io
import json
import pathlib
import sys
import unittest
import urllib.error
from email.message import Message
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import public_sources  # noqa: E402
import source_outcome  # noqa: E402
import source_transport as transport  # noqa: E402


class FakeClock:
    def __init__(self):
        self.now = 1000.0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


def message(**headers):
    value = Message()
    for name, content in headers.items():
        value[name.replace("_", "-")] = content
    return value


class FakeResponse(io.BytesIO):
    """An HTTP response: a body read in chunks, a clock that moves as it is read."""

    def __init__(self, body=b"{}", content_type="application/json", status=200, clock=None, step=0.0, content_length=True, **headers):
        super().__init__(body)
        self.status = status
        self.headers = message(Content_Type=content_type, **headers)
        if content_length:
            self.headers["Content-Length"] = str(len(body))
        self._clock, self._step = clock, step

    def read(self, amount=-1):
        if self._clock is not None:
            self._clock.now += self._step
        return super().read(amount)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def http_error(status, envelope=None, retry_after=None):
    body = json.dumps({"error": envelope} if envelope else {}).encode()
    headers = message(Content_Type="application/json")
    if retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    return urllib.error.HTTPError("https://gateway.invalid/", status, "error", headers, io.BytesIO(body))


class Door:
    """A scripted `_open_remote`: each call takes the next step (a response or an exception)."""

    def __init__(self, *steps):
        self.steps = list(steps)
        self.calls = []

    def __call__(self, url, accepted, **options):
        self.calls.append((url, accepted, options))
        step = self.steps.pop(0)
        if isinstance(step, BaseException):
            raise step
        return step


class OutcomeVocabularyTests(unittest.TestCase):
    def test_six_states_three_of_them_failures(self):
        self.assertEqual(
            source_outcome.STATES,
            ("more_available", "truncated", "no_results", "denied", "timeout", "unavailable"),
        )
        self.assertEqual(set(source_outcome.FAILURE_CODES), {"denied", "timeout", "unavailable"})
        self.assertEqual(len(set(source_outcome.FAILURE_CODES.values())), 3)

    def test_every_legacy_code_reads_as_one_of_the_three_failures(self):
        for code, state in source_outcome.LEGACY_STATE_OF_CODE.items():
            with self.subTest(code=code):
                self.assertEqual(source_outcome.state_of(code), state)
                self.assertIn(state, source_outcome.FAILURE_STATES)
        self.assertEqual(source_outcome.state_of("source_timeout"), "timeout")
        self.assertEqual(source_outcome.state_of("public_source_unpaywall_credential_missing"), "denied")
        self.assertIsNone(source_outcome.state_of("public_source_pmid_invalid"))
        self.assertIsNone(source_outcome.state_of(None))

    def test_page_truncation_and_empty_blocks_say_what_to_do_next(self):
        page = source_outcome.more_available(
            returned=10, total=38, next_arguments={"pageToken": "abc"}, how="Call again with pageToken abc for the next 10.",
        )
        self.assertEqual((page["state"], page["remaining"]), ("more_available", 28))
        self.assertEqual(page["next"]["arguments"], {"pageToken": "abc"})
        unknown_total = source_outcome.more_available(returned=5, total=None, next_arguments={"page": 2}, how="Ask for page 2.")
        self.assertIsNone(unknown_total.get("remaining"))
        self.assertNotIn("total", unknown_total, "an unknown total is absent, never 0")
        cut = source_outcome.truncated(kept=200, limit=200, unit="items", how="Narrow the query.")
        self.assertEqual((cut["state"], cut["kept"], cut["unit"]), ("truncated", 200, "items"))
        empty = source_outcome.no_results(reason="not_in_pmc", how="The article is not in PMC.")
        self.assertEqual((empty["state"], empty["reason"]), ("no_results", "not_in_pmc"))

    def test_a_failed_part_uses_the_failure_names_only(self):
        entry = source_outcome.failed_part("crossref", "timeout", "no_answer_in_time", "Retry once.")
        self.assertEqual(entry["state"], "timeout")
        with self.assertRaises(ValueError):
            source_outcome.failed_part("crossref", "no_results", "x", "y")
        block = source_outcome.with_failures(source_outcome.complete(), [entry])
        self.assertEqual(block["failed"], [entry])
        self.assertNotIn("failed", source_outcome.with_failures(source_outcome.complete(), []))

    def test_a_source_error_becomes_an_error_result_with_the_closed_code(self):
        for state, code in source_outcome.FAILURE_CODES.items():
            error = source_outcome.SourceError(state, "Nothing worked.", scope="Europe PMC")
            result = source_outcome.error_result(error)
            self.assertEqual(result["status"], "error")
            self.assertEqual(result["error"]["code"], code)
            self.assertEqual(set(result["error"]), {"code", "message", "retryable", "stopReason"})
            self.assertTrue(result["next_actions"])
            self.assertIsInstance(error, public_sources.PublicSourceError)
        self.assertIs(source_outcome.error_result(source_outcome.SourceError("denied", "No.", scope="x"))["error"]["retryable"], False)
        self.assertIs(source_outcome.error_result(source_outcome.SourceError("unavailable", "Down.", scope="x"))["error"]["retryable"], True)

    def test_what_a_run_is_told_differs_by_state(self):
        denied = " ".join(source_outcome.SourceError("denied", "No.", scope="Europe PMC").next_actions())
        timeout = " ".join(source_outcome.SourceError("timeout", "Slow.", scope="Europe PMC").next_actions())
        down = " ".join(source_outcome.SourceError("unavailable", "Down.", scope="Europe PMC", retry_after=30).next_actions())
        self.assertIn("Do not retry", denied)
        self.assertIn("knowledge base", denied)
        self.assertIn("time budget was spent", timeout)
        self.assertIn("not evidence that the record does not exist", down)
        self.assertIn("30 s", down)


class DeadlineAndRetryAfterTests(unittest.TestCase):
    def test_a_deadline_counts_down_on_its_clock_and_bounds_a_socket_wait(self):
        clock = FakeClock()
        deadline = transport.Deadline(30, clock=clock)
        self.assertEqual((deadline.remaining(), deadline.expired()), (30.0, False))
        self.assertEqual(deadline.socket_timeout(20), 20.0)
        clock.now += 25
        self.assertEqual(deadline.socket_timeout(20), 5.0)
        clock.now += 10
        self.assertTrue(deadline.expired())
        self.assertEqual(deadline.socket_timeout(20), 1.0, "never below the one second the door allows")

    def test_a_deadline_never_exceeds_what_the_kernel_allows_a_tool_call(self):
        self.assertEqual(transport.Deadline(10_000).seconds, transport.MAX_DEADLINE_SECONDS)
        self.assertLess(transport.MAX_DEADLINE_SECONDS, 180)

    def test_retry_after_is_seconds_or_a_date_and_bounded(self):
        self.assertEqual(transport.parse_retry_after("2"), 2)
        self.assertEqual(transport.parse_retry_after(" 30 "), 30)
        self.assertEqual(transport.parse_retry_after("999999"), transport.MAX_RETRY_AFTER_SECONDS)
        self.assertIsNone(transport.parse_retry_after("soon"))
        self.assertIsNone(transport.parse_retry_after(None))
        from datetime import datetime, timezone
        now = datetime(2026, 10, 4, 12, 0, 0, tzinfo=timezone.utc)
        self.assertEqual(transport.parse_retry_after("Sun, 04 Oct 2026 12:00:45 GMT", now=now), 45)
        self.assertEqual(transport.parse_retry_after("Sun, 04 Oct 2026 11:00:00 GMT", now=now), 0)

    def test_backoff_is_bounded_and_a_retry_after_is_taken_as_given(self):
        self.assertAlmostEqual(transport.retry_delay(1, rng=lambda: 0.0), 0.4)
        self.assertAlmostEqual(transport.retry_delay(2, rng=lambda: 0.0), 0.8)
        self.assertAlmostEqual(transport.retry_delay(9, rng=lambda: 0.0), transport.BACKOFF_CAP_SECONDS)
        self.assertEqual(transport.retry_delay(1, 17, rng=lambda: 0.5), 17.0)


class FetchTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.deadline = transport.Deadline(60, clock=self.clock)

    def fetch(self, *steps, **options):
        door = Door(*steps)
        options.setdefault("sleep", self.clock.sleep)
        options.setdefault("rng", lambda: 0.0)
        with mock.patch.object(public_sources, "_open_remote", door), mock.patch.object(public_sources, "_ncbi_pace"):
            try:
                return door, transport.fetch(
                    "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=1", ("application/json",),
                    deadline=self.deadline, scope="the NCBI ID converter", **options,
                )
            except Exception as error:  # noqa: BLE001 - the tests read the exception
                return door, error

    def test_one_good_answer_is_one_attempt_and_the_door_is_given_the_time_left(self):
        door, response = self.fetch(FakeResponse(b'{"ok": true}'))
        self.assertEqual((response.status, response.attempts, response.waited), (200, 1, 0.0))
        self.assertEqual(response.json(), {"ok": True})
        self.assertEqual(len(door.calls), 1)
        self.assertEqual(door.calls[0][2]["timeout_seconds"], transport.PER_ATTEMPT_SECONDS)

    def test_a_rate_limit_that_names_its_wait_is_waited_out_then_retried(self):
        # The live ID converter answered 429 as HTML with no Retry-After; the
        # gateway now forwards one when the source sends it.
        door, response = self.fetch(
            http_error(429, {"code": "public_source_gateway_rate_limited", "message": "slow down"}, retry_after=2),
            FakeResponse(b"{}"),
        )
        self.assertEqual((response.attempts, response.waited), (2, 2.0))
        self.assertEqual(self.clock.sleeps, [2.0])

    def test_a_retry_after_that_does_not_fit_the_time_left_stops_the_call_at_once(self):
        self.clock.now += 50  # 10 s of 60 remain
        door, error = self.fetch(
            http_error(429, {"code": "public_source_gateway_rate_limited", "message": "slow down"}, retry_after=120),
            FakeResponse(b"{}"),
        )
        self.assertIsInstance(error, source_outcome.SourceError)
        self.assertEqual((error.state, error.reason, error.retry_after), ("unavailable", "retry_after_exceeds_deadline", 120))
        self.assertEqual(self.clock.sleeps, [], "a wait that cannot fit is never slept")
        self.assertEqual(len(door.calls), 1)
        self.assertIn("120 s", str(error))
        self.assertIn("10 s", str(error))

    def test_a_rate_limit_without_a_retry_after_backs_off_and_gives_up_after_the_attempts(self):
        door, error = self.fetch(*[http_error(429, {"code": "public_source_gateway_rate_limited", "message": "x"})] * 3)
        self.assertEqual((error.state, error.reason), ("unavailable", "rate_limited"))
        self.assertEqual(len(door.calls), transport.ATTEMPTS)
        self.assertEqual(self.clock.sleeps, [0.4, 0.8])

    def test_a_server_error_is_retried_a_refusal_is_not(self):
        door, response = self.fetch(
            http_error(502, {"code": "public_source_gateway_upstream_error", "message": "x"}), FakeResponse(b"{}"),
        )
        self.assertEqual(response.attempts, 2)
        for envelope, reason in (
            ({"code": "public_source_gateway_upstream_denied", "message": "refused"}, "refused_by_source"),
            ({"code": "public_source_gateway_url_forbidden", "message": "not approved"}, "policy"),
        ):
            with self.subTest(code=envelope["code"]):
                door, error = self.fetch(http_error(403, envelope), FakeResponse(b"{}"))
                self.assertEqual((error.state, error.reason, len(door.calls)), ("denied", reason, 1))
                self.assertIs(error.retryable, False)

    def test_a_gateway_timeout_is_the_deadline_and_is_not_retried(self):
        door, error = self.fetch(http_error(504, {"code": "public_source_gateway_timeout", "message": "slow"}), FakeResponse(b"{}"))
        self.assertEqual((error.state, len(door.calls)), ("timeout", 1))

    def test_a_socket_timeout_is_a_timeout_and_a_refused_connection_is_retried(self):
        door, error = self.fetch(TimeoutError("timed out"), FakeResponse(b"{}"))
        self.assertEqual((error.state, error.reason, len(door.calls)), ("timeout", "no_answer_in_time", 1))
        door, response = self.fetch(urllib.error.URLError(ConnectionRefusedError("refused")), FakeResponse(b"{}"))
        self.assertEqual((response.attempts, len(door.calls)), (2, 2))
        door, error = self.fetch(*[urllib.error.URLError(ConnectionRefusedError("refused"))] * 3)
        self.assertEqual((error.state, error.reason, len(door.calls)), ("unavailable", "connection_failed", 3))

    def test_the_deadline_is_one_budget_across_attempts_and_waits(self):
        # 5 s remain. The first answer asks for 4 s, which fits and is slept; the
        # second asks for 3 s with 1 s left, which does not fit and is not slept.
        self.clock.now += 55
        limited = {"code": "public_source_gateway_rate_limited", "message": "x"}
        door, error = self.fetch(http_error(429, limited, retry_after=4), http_error(429, limited, retry_after=3), FakeResponse(b"{}"))
        self.assertEqual((error.reason, error.retry_after, self.clock.sleeps), ("retry_after_exceeds_deadline", 3, [4.0]))
        self.assertEqual(len(door.calls), 2)
        # A budget already spent asks nothing at all.
        self.clock.now += 100
        door, error = self.fetch(FakeResponse(b"{}"))
        self.assertEqual((error.state, error.reason, door.calls), ("timeout", "deadline_before_attempt", []))

    def test_a_missing_record_is_an_answer_when_the_caller_expects_one(self):
        door, response = self.fetch(http_error(404), accept_statuses=(404,))
        self.assertEqual((response.status, response.body), (404, b""))
        door, error = self.fetch(http_error(404))
        self.assertEqual((error.state, error.reason, error.retryable), ("unavailable", "not_found", False))

    def test_a_request_the_source_rejects_is_not_retried(self):
        door, error = self.fetch(http_error(400, {"code": "public_source_gateway_upstream_error", "message": "x"}), FakeResponse(b"{}"))
        self.assertEqual((error.reason, len(door.calls)), ("request_rejected", 1))

    def test_a_refusal_says_which_side_refused(self):
        # 2026-10-05, production: a source's 4xx (DailyMed's 406) and the gateway's own validation both reached the
        # runtime as HTTP 400 and were worded "DailyMed rejected the request as invalid (HTTP 400)".
        # The gateway relays every source 4xx but 404 and 429 as its own 400 with the source's status in the envelope.
        source = {"code": "public_source_gateway_upstream_error", "message": "The official public source returned HTTP 406.", "upstreamStatus": 406}
        door, error = self.fetch(http_error(400, source), FakeResponse(b"{}"))
        self.assertEqual((error.state, error.reason, error.retryable, len(door.calls)), ("unavailable", "request_rejected", False, 1))
        self.assertIn("itself rejected this request (HTTP 406)", str(error))
        self.assertNotIn("invalid", str(error))
        self.assertIn("HTTP 406", error.next_actions()[0])
        self.assertIn("rather than saying the record is missing", error.next_actions()[0])

        # The gateway's own refusal: the source was never asked, and the words say so.
        own = {"code": "public_source_gateway_accept_invalid", "message": "The public-source accepted content types are invalid."}
        door, error = self.fetch(http_error(400, own), FakeResponse(b"{}"))
        self.assertEqual((error.state, error.reason, error.retryable, len(door.calls)), ("unavailable", "gateway_refused", False, 1))
        self.assertIn("EviMed's own gateway refused this request before it reached", str(error))
        self.assertIn("public_source_gateway_accept_invalid", str(error))
        self.assertIn("was not asked", str(error))
        self.assertNotIn("rejected the request", str(error))
        self.assertIn("fault on the EviMed side", error.next_actions()[0])

        # A policy refusal of the gateway is the deployment's too, still a denial and no source's.
        door, error = self.fetch(http_error(403, {"code": "public_source_api_path_forbidden", "message": "The API path is not approved on this host."}), FakeResponse(b"{}"))
        self.assertEqual((error.state, error.reason), ("denied", "policy"))
        self.assertIn("EviMed's own gateway refused", str(error))
        self.assertIn("never saw it", error.next_actions()[0])

        # With nothing to say who refused, the words say that and nothing more.
        door, error = self.fetch(http_error(400, {"code": "public_source_gateway_upstream_error", "message": "x"}), FakeResponse(b"{}"))
        self.assertIn("nothing says whether the source or EviMed's gateway refused", str(error))

    def test_a_source_that_refuses_by_address_is_not_called_an_item_it_will_not_serve(self):
        # The gateway's 400 for a source's 403, with the status the source answered (recorded 2026-10-05: NCBI's file
        # server answers 403 text/html to the production host for a public file).
        refused = {"code": "public_source_gateway_upstream_denied", "message": "The official public source refused this request (HTTP 403).", "upstreamStatus": 403}
        door, error = self.fetch(http_error(400, refused), FakeResponse(b"{}"))
        self.assertEqual((error.state, error.reason, error.retryable), ("denied", "refused_by_source", False))
        self.assertIn("(HTTP 403)", str(error), "the source's status, not the gateway's 400")
        self.assertNotIn("HTTP 400", str(error))
        actions = " ".join(error.next_actions())
        self.assertNotIn("unauthenticated", actions)
        self.assertIn("refusal of this server's address", actions)
        self.assertIn("a later call may be served", actions)

    def test_a_verification_page_with_status_200_is_a_refusal_never_a_file(self):
        # Recorded 2026-10-04: pmc.ncbi.nlm.nih.gov/articles/instance/<id>/bin/<file>
        # answers a reCAPTCHA page, HTTP 200, text/html, to a plain client.
        door, error = self.fetch(FakeResponse(b"<html>recaptcha</html>", content_type="text/html"))
        self.assertEqual((error.state, error.reason), ("denied", "verification_page"))
        door, error = self.fetch(FakeResponse(b"x", content_type="application/pdf"))
        self.assertEqual((error.state, error.reason), ("unavailable", "unexpected_content_type"))

    def test_a_source_nobody_configured_is_named_and_not_retried(self):
        envelope = {
            "code": "public_source_unpaywall_credential_missing",
            "message": "Unpaywall is not configured for this deployment or this account; the user can add their own credential under 设置 → 数据源.",
        }
        door, error = self.fetch(http_error(503, envelope), FakeResponse(b"{}"))
        self.assertIsInstance(error, public_sources.SourceNotConfigured)
        self.assertEqual(len(door.calls), 1)

    def test_a_request_that_changes_something_is_retried_only_when_it_says_it_is_safe(self):
        step = http_error(502, {"code": "public_source_gateway_upstream_error", "message": "x"})
        door, error = self.fetch(step, FakeResponse(b"{}"), method="POST", json_body={"q": 1})
        self.assertEqual((error.state, len(door.calls)), ("unavailable", 1))
        step = http_error(502, {"code": "public_source_gateway_upstream_error", "message": "x"})
        door, response = self.fetch(step, FakeResponse(b"{}"), method="POST", json_body={"q": 1}, idempotent=True)
        self.assertEqual(response.attempts, 2)

    def test_fetch_json_names_a_body_that_is_not_json_and_returns_none_for_a_missing_record(self):
        with mock.patch.object(public_sources, "_open_remote", Door(FakeResponse(b"not json"))), mock.patch.object(public_sources, "_ncbi_pace"):
            with self.assertRaises(source_outcome.SourceError) as raised:
                transport.fetch_json("https://api.crossref.org/x", deadline=self.deadline, scope="Crossref")
        self.assertEqual(raised.exception.reason, "invalid_response")
        with mock.patch.object(public_sources, "_open_remote", Door(http_error(404))):
            value, response = transport.fetch_json("https://api.crossref.org/x", deadline=self.deadline, scope="Crossref", accept_statuses=(404,))
        self.assertEqual((value, response.status), (None, 404))
        # NCBI sends literal control characters inside strings; tolerated only when asked.
        with mock.patch.object(public_sources, "_open_remote", Door(FakeResponse(b'{"t": "a\tb"}'))):
            value, _ = transport.fetch_json("https://api.crossref.org/x", deadline=self.deadline, scope="NCBI", strict=False)
        self.assertEqual(value, {"t": "a\tb"})


class StreamedBodyTests(unittest.TestCase):
    """The deadline covers a body still streaming, the byte bound covers a body that never ends."""

    def setUp(self):
        self.clock = FakeClock()

    def read(self, response, *, seconds=60, max_bytes=1000, chunk=10):
        return transport.read_body(response, max_bytes=max_bytes, deadline=transport.Deadline(seconds, clock=self.clock), scope="Europe PMC", chunk=chunk)

    def test_a_whole_body_is_returned_in_chunks(self):
        self.assertEqual(self.read(FakeResponse(b"x" * 95)), b"x" * 95)

    def test_a_body_still_streaming_when_the_deadline_passes_is_a_timeout_that_says_how_far_it_got(self):
        # 34 s to the first byte and 136 s in all, measured for a 3.5 MB
        # supplementary zip: a deadline shorter than that must be a timeout, not a short file.
        response = FakeResponse(b"x" * 500, clock=self.clock, step=10.0)
        with self.assertRaises(source_outcome.SourceError) as raised:
            self.read(response, seconds=35)
        error = raised.exception
        self.assertEqual((error.state, error.reason), ("timeout", "deadline_during_body"))
        # The fourth read began at 30 s and ended at 40 s: a read in flight when the
        # deadline passes finishes, and the next one is never started.
        self.assertEqual(error.partial["bytesReceived"], 40)
        self.assertIn("40 bytes", str(error))

    def test_a_stalled_read_is_a_timeout(self):
        class Stalled(FakeResponse):
            def read(self, amount=-1):
                raise TimeoutError("timed out")

        with self.assertRaises(source_outcome.SourceError) as raised:
            self.read(Stalled(b"x" * 50))
        self.assertEqual(raised.exception.reason, "read_stalled")

    def test_a_body_past_the_bound_is_truncated_not_returned(self):
        with self.assertRaises(source_outcome.Truncated) as raised:
            self.read(FakeResponse(b"x" * 5000, content_length=False), max_bytes=100)
        self.assertEqual((raised.exception.reason, raised.exception.limit), ("size_limit", 100))
        self.assertGreater(raised.exception.received, 100)

    def test_a_declared_size_over_the_bound_is_refused_before_a_byte_is_read(self):
        response = FakeResponse(b"x" * 5000)
        with self.assertRaises(source_outcome.Truncated) as raised:
            self.read(response, max_bytes=100)
        self.assertEqual((raised.exception.received, raised.exception.declared), (0, 5000))
        self.assertEqual(response.tell(), 0)

    def test_a_connection_that_closes_early_is_truncated(self):
        short = FakeResponse(b"x" * 40)
        short.headers.replace_header("Content-Length", "100")
        with self.assertRaises(source_outcome.Truncated) as raised:
            self.read(short)
        self.assertEqual((raised.exception.reason, raised.exception.received, raised.exception.declared), ("connection_closed_early", 40, 100))

        class Chunked(FakeResponse):
            def read(self, amount=-1):
                raise http.client.IncompleteRead(b"x" * 25)

        with self.assertRaises(source_outcome.Truncated) as raised:
            self.read(Chunked(b"", content_length=False))
        self.assertEqual((raised.exception.reason, raised.exception.received), ("connection_closed_early", 25))


class DownloadTests(unittest.TestCase):
    """A named download keeps what arrived when the body stops early, and says why it stopped."""

    def setUp(self):
        self.clock = FakeClock()
        self.deadline = transport.Deadline(60, clock=self.clock)

    def download(self, *steps, kind="epmc-supplements", params=None, **options):
        door = Door(*steps)
        params = params or {"pmcid": "PMC6454835"}
        with mock.patch.object(public_sources, "_open_remote", door), \
                mock.patch.object(public_sources, "_gateway_settings", return_value=None):
            try:
                return door, transport.download(kind, params, deadline=self.deadline, scope="Europe PMC", sleep=self.clock.sleep, rng=lambda: 0.0, **options)
            except Exception as error:  # noqa: BLE001
                return door, error

    def test_the_kinds_are_the_ones_the_gateway_serves(self):
        self.assertEqual(set(transport.DOWNLOAD_KINDS), {
            "epmc-supplements", "dailymed-spl-zip",
            "ncbi-gene-expression-series-matrix", "ncbi-gene-expression-series-record", "ncbi-gene-expression-platform-record",
        })

    def test_a_whole_zip_is_complete_and_asked_for_at_the_upstream_address_when_there_is_no_gateway(self):
        door, result = self.download(FakeResponse(b"PK" + b"x" * 50, content_type="application/zip"))
        self.assertEqual((result.complete, result.reason, result.received, result.content_type), (True, None, 52, "application/zip"))
        self.assertEqual(door.calls[0][0], "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC6454835/supplementaryFiles")
        door, result = self.download(
            FakeResponse(b"PK", content_type="application/zip"), kind="dailymed-spl-zip",
            params={"setid": "5E81B4A7-B971-45E1-9C31-29CEA8C87CE7", "version": 36},
        )
        self.assertEqual(
            door.calls[0][0],
            "https://dailymed.nlm.nih.gov/dailymed/getFile.cfm?setid=5e81b4a7-b971-45e1-9c31-29cea8c87ce7&type=zip&version=36",
        )

    def test_a_stream_still_running_at_the_deadline_returns_what_arrived_and_says_it_is_incomplete(self):
        # 3.5 MB took 136 s on the live wire; with a 35 s budget the first chunks
        # are all there is, and they are not the file.
        response = FakeResponse(b"PK" + b"x" * 500, content_type="application/zip", clock=self.clock, step=10.0, content_length=False)
        self.deadline = transport.Deadline(35, clock=self.clock)
        door, result = self.download(response, chunk=10)
        self.assertEqual((result.complete, result.reason), (False, "deadline"))
        self.assertEqual(result.received, 40, "four reads of ten bytes began before 35 s")
        self.assertEqual(result.body, (b"PK" + b"x" * 500)[:40])

    def test_a_connection_that_closes_early_keeps_the_part_and_names_the_reason(self):
        short = FakeResponse(b"PK" + b"x" * 40, content_type="application/zip")
        short.headers.replace_header("Content-Length", "900")
        door, result = self.download(short)
        self.assertEqual((result.complete, result.reason, result.received, result.declared), (False, "connection_closed_early", 42, 900))

        class Chunked(FakeResponse):
            def read(self, amount=-1):
                raise http.client.IncompleteRead(b"PK-partial")

        door, result = self.download(Chunked(b"", content_type="application/zip", content_length=False))
        self.assertEqual((result.complete, result.reason, result.body), (False, "connection_closed_early", b"PK-partial"))

    def test_the_byte_bound_cuts_the_stream_and_the_body_never_exceeds_it(self):
        door, result = self.download(FakeResponse(b"x" * 5000, content_type="application/zip", content_length=False), max_bytes=1000)
        self.assertEqual((result.complete, result.reason, result.received), (False, "size_limit", 1000))

    def test_a_small_xml_answer_is_returned_whole_for_the_caller_to_read(self):
        error_bean = (b'<?xml version="1.0"?><ns4:errorBean><errCode>0</errCode>'
                      b'<errMsg>Article with id PMC6533834 is not open access one</errMsg></ns4:errorBean>')
        door, result = self.download(FakeResponse(error_bean, content_type="application/xml"))
        self.assertEqual((result.complete, result.content_type, result.body), (True, "application/xml", error_bean))

    def test_a_refusal_a_missing_file_or_a_web_page_is_not_a_download(self):
        door, error = self.download(http_error(403, {"code": "public_source_gateway_upstream_denied", "message": "no"}))
        self.assertEqual((error.state, error.reason), ("denied", "refused_by_source"))
        door, error = self.download(http_error(404))
        self.assertEqual((error.state, error.reason), ("unavailable", "not_found"))
        door, error = self.download(FakeResponse(b"<html>recaptcha</html>", content_type="text/html"))
        self.assertEqual((error.state, error.reason), ("denied", "verification_page"))

    def test_through_the_gateway_the_request_names_a_kind_and_its_identifiers_and_nothing_else(self):
        import http.server
        import os
        import tempfile
        import threading
        seen = []

        class Gateway(http.server.BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - the stdlib's name
                seen.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
                # A chunked body that ends without its terminator: the shape a gateway
                # cut short by its deadline or byte bound leaves on the wire.
                self.send_response(200)
                self.send_header("content-type", "application/zip")
                self.send_header("transfer-encoding", "chunked")
                self.end_headers()
                self.wfile.write(b"a\r\nPK-partial\r\n")
                self.wfile.flush()
                self.close_connection = True

            def log_message(self, *_args):
                return

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory() as directory:
            token = pathlib.Path(directory) / "gateway.token"
            token.write_text("runtime-token\n")
            os.chmod(token, 0o600)
            environment = {
                "EVIMED_PUBLIC_SOURCE_GATEWAY_URL": "http://127.0.0.1:%d/internal/sources/v1/fetch" % server.server_address[1],
                "EVIMED_MODEL_GATEWAY_TOKEN_FILE": str(token),
            }
            with mock.patch.dict(os.environ, environment):
                os.environ.pop("EVIMED_MODEL_CONFIG_FILE", None)
                os.environ.pop("EVIMED_MCP_FIXTURES", None)
                result = transport.download(
                    "epmc-supplements", {"pmcid": "PMC6454835"}, deadline=transport.Deadline(30), scope="Europe PMC",
                )
        self.assertEqual(seen, [{"download": {"kind": "epmc-supplements", "pmcid": "PMC6454835"}}])
        self.assertEqual((result.complete, result.reason, result.body), (False, "connection_closed_early", b"PK-partial"))


if __name__ == "__main__":
    unittest.main()
