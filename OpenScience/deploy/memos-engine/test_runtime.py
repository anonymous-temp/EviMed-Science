import asyncio
import contextlib
import io
import json
import logging
import logging.config
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

from serve import PrivateMemoryApplication, silence_upstream_logging


class LoggingBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.disabled = logging.root.manager.disable
        logging.disable(logging.NOTSET)
        logging.getLogger("memos").disabled = False

    def tearDown(self):
        logging.disable(self.disabled)

    def test_request_body_and_exception_details_never_enter_operational_output(self):
        output = io.StringIO()
        responses = []
        marker = "synthetic-private-memory-body"

        async def inner(scope, receive, send):
            payload = await receive()
            logging.getLogger("memos").error(payload["body"].decode())
            raise ValueError(marker)

        async def receive():
            return {"type": "http.request", "body": marker.encode(), "more_body": False}

        async def send(message):
            responses.append(message)

        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            silence_upstream_logging()
            asyncio.run(PrivateMemoryApplication(inner)({"type": "http", "method": "POST", "path": "/product/add", "query_string": marker.encode()}, receive, send))
        self.assertNotIn(marker, output.getvalue())
        event = json.loads(output.getvalue())
        self.assertEqual(event["status"], 500)
        self.assertEqual(event["path"], "/product/add")
        self.assertEqual(responses[0]["status"], 500)
        self.assertNotIn(marker.encode(), responses[1]["body"])

    def test_success_records_only_fixed_route_status_and_elapsed_time(self):
        async def inner(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"healthy"})

        async def unused():
            return {"type": "http.disconnect"}

        async def send(message):
            pass

        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            asyncio.run(PrivateMemoryApplication(inner)({"type": "http", "method": "GET", "path": "/sensitive-account-name"}, unused, send))
        event = json.loads(output.getvalue())
        self.assertEqual(event["path"], "/unmatched")
        self.assertEqual(event["status"], 200)
        self.assertGreaterEqual(event["elapsedMs"], 0)
        self.assertNotIn("sensitive-account-name", output.getvalue())

    def test_upstream_logger_reconfiguration_does_not_restore_message_logging(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            silence_upstream_logging()
            logging.config.dictConfig({"version": 1, "disable_existing_loggers": False, "handlers": {"console": {"class": "logging.StreamHandler", "stream": "ext://sys.stdout"}}, "root": {"level": "DEBUG", "handlers": ["console"]}})
            logging.getLogger("memos").critical("synthetic-hidden-credential")
        self.assertEqual(output.getvalue(), "")

    def test_canceled_partial_response_is_recorded_as_failed_without_an_extra_response(self):
        responses = []

        async def inner(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": []})
            raise asyncio.CancelledError("synthetic-private-cancellation")

        async def unused():
            return {"type": "http.disconnect"}

        async def send(message):
            responses.append(message)

        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(asyncio.CancelledError):
            asyncio.run(PrivateMemoryApplication(inner)({"type": "http", "method": "GET", "path": "/health"}, unused, send))
        event = json.loads(output.getvalue())
        self.assertTrue(event["failed"])
        self.assertTrue(event["canceled"])
        self.assertEqual(len(responses), 1)
        self.assertNotIn("synthetic-private-cancellation", output.getvalue())

    def test_process_boundary_blocks_console_and_file_handlers_with_negative_control(self):
        script = textwrap.dedent("""
            import logging, logging.config, sys
            from serve import silence_upstream_logging
            if sys.argv[1] == "on":
                silence_upstream_logging()
            logging.config.dictConfig({
                "version": 1, "disable_existing_loggers": False,
                "handlers": {
                    "console": {"class": "logging.StreamHandler", "stream": "ext://sys.stderr"},
                    "file": {"class": "logging.FileHandler", "filename": sys.argv[2]},
                },
                "root": {"level": "DEBUG", "handlers": ["console", "file"]},
            })
            logging.getLogger("memos").critical("synthetic-private-console-and-file")
            logging.shutdown()
        """)
        with tempfile.TemporaryDirectory(prefix="evimed-memory-log-") as directory:
            for mode in ["off", "on"]:
                logfile = os.path.join(directory, mode + ".log")
                result = subprocess.run([sys.executable, "-c", script, mode, logfile],
                                        cwd=Path(__file__).parent, capture_output=True,
                                        text=True, timeout=5, check=True)
                console = result.stdout + result.stderr
                persisted = Path(logfile).read_text()
                if mode == "off":
                    self.assertIn("synthetic-private-console-and-file", console)
                    self.assertIn("synthetic-private-console-and-file", persisted)
                else:
                    self.assertNotIn("synthetic-private-console-and-file", console)
                    self.assertNotIn("synthetic-private-console-and-file", persisted)


if __name__ == "__main__":
    unittest.main()
