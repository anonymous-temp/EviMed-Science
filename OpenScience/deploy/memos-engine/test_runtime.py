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
from unittest import mock

import serve
from serve import PrivateMemoryApplication, silence_upstream_logging


class EmbeddingReadinessTests(unittest.TestCase):
    @staticmethod
    def response(payload):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.read.return_value = json.dumps(payload).encode()
        return response

    def engine_response(self):
        return self.response({"status": "healthy", "service": "memos", "version": "1.0.1"})

    def test_health_requires_a_real_embedding_without_provider_keys(self):
        vector = [0.5] + [0.0] * 1023
        embedding = self.response({"model": "bge-m3:latest", "embeddings": [vector]})
        output = io.StringIO()
        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch("urllib.request.urlopen", side_effect=[self.engine_response(), embedding]) as opened, \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.assertTrue(serve.check_health())
        self.assertEqual(opened.call_count, 2)
        first, second = opened.call_args_list
        self.assertEqual(first.args[0].full_url, "http://127.0.0.1:8000/health")
        self.assertEqual(second.args[0].full_url, "http://evimed-memos-ollama:11434/api/embed")
        body = json.loads(second.args[0].data)
        self.assertEqual(body["model"], "bge-m3:latest")
        self.assertEqual(body["keep_alive"], -1)
        self.assertIsInstance(body["input"], str)
        self.assertTrue(body["input"].strip())
        self.assertLessEqual(first.kwargs["timeout"] + second.kwargs["timeout"], 8)
        self.assertEqual(output.getvalue(), "")
        embedding.read.assert_called_once_with(65537)

    def test_metadata_only_missing_zero_or_nonfinite_vectors_are_not_ready(self):
        good = [0.5] * 1024
        payloads = [
            {"models": [{"name": "bge-m3:latest"}]},
            {"model": "bge-m3:latest", "embeddings": []},
            {"model": "bge-m3:latest", "embeddings": [[0.5] * 512]},
            {"model": "different-model", "embeddings": [good]},
            {"model": "bge-m3:latest", "embeddings": [[0.0] * 1024]},
            {"model": "bge-m3:latest", "embeddings": [[float("nan")] + good[1:]]},
            {"model": "bge-m3:latest", "embeddings": [[True] + good[1:]]},
        ]
        for payload in payloads:
            with self.subTest(payload_kind=list(payload)), \
                    mock.patch("urllib.request.urlopen", side_effect=[self.engine_response(), self.response(payload)]), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(serve.check_health())

    def test_dependency_failure_is_bounded_and_does_not_log_response_or_exception(self):
        marker = "synthetic-private-error-or-vector"
        output = io.StringIO()
        with mock.patch("urllib.request.urlopen", side_effect=TimeoutError(marker)) as opened, \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.assertFalse(serve.check_health())
        self.assertEqual(opened.call_count, 1)
        self.assertNotIn(marker, output.getvalue())
        oversized = self.response({})
        oversized.read.return_value = b"x" * 65537
        with mock.patch("urllib.request.urlopen", side_effect=[self.engine_response(), oversized]), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertFalse(serve.check_health())

    def test_unhealthy_engine_cannot_be_hidden_by_a_healthy_model(self):
        with mock.patch("urllib.request.urlopen", return_value=self.response({"status": "unhealthy"})) as opened, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertFalse(serve.check_health())
        self.assertEqual(opened.call_count, 1)

    def test_health_cli_does_not_import_or_start_the_memory_server(self):
        script = textwrap.dedent("""
            import io, json, runpy, sys
            from unittest.mock import patch
            def response(payload):
                body = io.BytesIO(json.dumps(payload).encode())
                body.status = 200
                return body
            responses = [
                response({"status":"healthy","service":"memos","version":"1.0.1"}),
                response({"model":"bge-m3:latest","embeddings":[[0.5]*1024]}),
            ]
            sys.argv = ["serve.py", "--health"]
            with patch("urllib.request.urlopen", side_effect=responses), \
                 patch("importlib.import_module", side_effect=AssertionError("server startup is forbidden")):
                runpy.run_path("serve.py", run_name="__main__")
        """)
        completed = subprocess.run([sys.executable, "-c", script], cwd=Path(__file__).parent,
                                   capture_output=True, text=True, timeout=5, env={"PATH": os.defpath})
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout, "")


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
