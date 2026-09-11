import hashlib
import http.client
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import parser_service
import uvicorn


class ParserServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def request(self, file: Path, mime_type: str = "text/plain") -> parser_service.ParseRequest:
        return parser_service.ParseRequest(
            path=str(file),
            mimeType=mime_type,
            sha256=hashlib.sha256(file.read_bytes()).hexdigest(),
            sourceId="source-one",
        )

    def test_text_fallback_preserves_cjk_and_accounts_every_chunk(self):
        file = self.root / "研究笔记.txt"
        file.write_text("第一段循证医学资料。\n\n第二段包含结论。", encoding="utf-8")
        result = parser_service.parse_document(self.request(file), data_root=self.root, chunk_chars=12)
        self.assertEqual(result["protocolVersion"], 1)
        self.assertEqual(result["extractor"]["parser"], "fallback")
        self.assertGreater(len(result["units"]), 1)
        self.assertTrue(all(unit["status"] == "extracted" for unit in result["units"]))
        self.assertIn("第二段", result["text"])
        self.assertTrue(result["facts"])

    def test_path_escape_symlink_and_digest_mismatch_are_refused(self):
        outside = Path(self.temp.name).parent / "evimed-parser-outside.txt"
        outside.write_text("outside", encoding="utf-8")
        try:
            with self.assertRaisesRegex(ValueError, "data root"):
                parser_service.parse_document(self.request(outside), data_root=self.root)
            link = self.root / "link.txt"
            link.symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "symbolic link"):
                parser_service.parse_document(self.request(outside).model_copy(update={"path": str(link)}), data_root=self.root)
            file = self.root / "inside.txt"
            file.write_text("inside", encoding="utf-8")
            bad = self.request(file).model_copy(update={"sha256": "0" * 64})
            with self.assertRaisesRegex(ValueError, "digest"):
                parser_service.parse_document(bad, data_root=self.root)
        finally:
            outside.unlink(missing_ok=True)

    def test_mineru_output_maps_page_coverage_and_formula_text(self):
        file = self.root / "formula.pdf"
        file.write_bytes(b"test-only-pdf")

        def fake_run(_file: Path, output: Path, _timeout: int) -> None:
            result_dir = output / "formula" / "auto"
            result_dir.mkdir(parents=True)
            (result_dir / "formula.md").write_text("# 公式\n\n$E = mc^2$", encoding="utf-8")
            (result_dir / "formula_content_list.json").write_text(json.dumps([
                {"page_idx": 0, "type": "text", "text": "公式"},
                {"page_idx": 1, "type": "equation", "text": "E = mc^2"},
            ]), encoding="utf-8")

        with patch.object(parser_service, "run_mineru", side_effect=fake_run), patch.object(parser_service, "physical_unit_count", return_value=3):
            result = parser_service.parse_document(self.request(file, "application/pdf"), data_root=self.root)
        self.assertEqual(result["extractor"], {"name": "mineru", "version": "3.4.5", "parser": "mineru"})
        self.assertEqual([unit["id"] for unit in result["units"]], ["page-1", "page-2", "page-3"])
        self.assertEqual(result["units"][2]["status"], "failed")
        self.assertIn("E = mc^2", result["text"])

    def test_physical_unit_count_reads_real_pdf_and_office_containers(self):
        from pypdf import PdfWriter

        pdf = self.root / "three-pages.pdf"
        writer = PdfWriter()
        for _ in range(3):
            writer.add_blank_page(width=72, height=72)
        with pdf.open("wb") as stream:
            writer.write(stream)
        self.assertEqual(parser_service.physical_unit_count(pdf), 3)

        pptx = self.root / "two-slides.pptx"
        with zipfile.ZipFile(pptx, "w") as archive:
            archive.writestr("ppt/slides/slide1.xml", "<slide/>")
            archive.writestr("ppt/slides/slide2.xml", "<slide/>")
        self.assertEqual(parser_service.physical_unit_count(pptx), 2)

        xlsx = self.root / "two-sheets.xlsx"
        with zipfile.ZipFile(xlsx, "w") as archive:
            archive.writestr("xl/worksheets/sheet1.xml", "<sheet/>")
            archive.writestr("xl/worksheets/sheet2.xml", "<sheet/>")
        self.assertEqual(parser_service.physical_unit_count(xlsx), 2)

    def test_mineru_rejects_an_out_of_range_unit_before_allocating_coverage(self):
        file = self.root / "hostile.pdf"
        file.write_bytes(b"test-only-pdf")
        output = self.root / "mineru-output"
        output.mkdir()
        (output / "hostile.md").write_text("content", encoding="utf-8")
        (output / "hostile_content_list.json").write_text(json.dumps([
            {"page_idx": parser_service.MAX_UNITS + 1, "text": "bad index"},
        ]), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "out-of-range"):
            parser_service.mineru_result(output, file, "source-one")

    def test_bearer_token_is_read_from_owner_only_file(self):
        secret = self.root / "parser.token"
        secret.write_text("test-only-parser-token\n", encoding="utf-8")
        os.chmod(secret, 0o600)
        self.assertEqual(parser_service.read_token(secret), "test-only-parser-token")
        os.chmod(secret, 0o644)
        with self.assertRaisesRegex(RuntimeError, "permissions"):
            parser_service.read_token(secret)


class ParserAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.file = self.root / "fixture.txt"
        self.file.write_text("Parser admission fixture.", encoding="utf-8")
        self.token = "test-only-parser-admission-token"
        token_file = self.root / "parser.token"
        token_file.write_text(self.token, encoding="utf-8")
        token_file.chmod(0o600)
        for name, value in [("TOKEN_FILE", token_file), ("DATA_ROOT", self.root)]:
            setting = patch.object(parser_service, name, value)
            setting.start()
            self.addCleanup(setting.stop)
        self.request = {
            "path": str(self.file), "mimeType": "text/plain",
            "sha256": hashlib.sha256(self.file.read_bytes()).hexdigest(), "sourceId": "source-one",
        }

    @contextmanager
    def serve(self, limit_concurrency=32):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            server = uvicorn.Server(uvicorn.Config(
                parser_service.app, loop="asyncio", http="h11", lifespan="off",
                limit_concurrency=limit_concurrency, timeout_keep_alive=30,
                log_level="critical", access_log=False,
            ))
            thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
            thread.start()
            try:
                deadline = time.monotonic() + 5
                while not server.started and thread.is_alive() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(server.started, "Uvicorn failed to start.")
                yield listener.getsockname()[1]
            finally:
                server.should_exit = True
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive(), "Uvicorn failed to stop.")

    def post(self, port, *, authenticated=True, **updates):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            headers = {"Content-Type": "application/json"}
            if authenticated:
                headers["Authorization"] = f"Bearer {self.token}"
            connection.request("POST", "/v1/parse", json.dumps({**self.request, **updates}), headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_idle_health_connection_does_not_reject_the_first_parse_request(self):
        dockerfile = Path(__file__).with_name("Dockerfile").read_text(encoding="utf-8")
        command = json.loads(next(line[4:] for line in dockerfile.splitlines() if line.startswith("CMD ")))
        self.assertEqual(command[command.index("--workers") + 1], "1")
        deployed_limit = int(command[command.index("--limit-concurrency") + 1])
        # Reproduce the old admission failure on a real keep-alive socket before
        # testing the deployed command; ASGI-only clients cannot catch this bug.
        for limit, expected in [(2, 503), (deployed_limit, 401)]:
            with self.subTest(limit=limit, expected=expected), self.serve(limit) as port:
                health = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                try:
                    health.request("GET", "/health")
                    response = health.getresponse()
                    self.assertEqual(response.status, 200)
                    response.read()
                    self.assertIsNotNone(health.sock, "The health connection must remain open.")
                    self.assertEqual(self.post(port, authenticated=False)[0], expected)
                    if expected == 401:
                        self.assertEqual(self.post(port, sha256="0" * 64)[0], 400)
                        self.assertEqual(self.post(port)[0], 200)
                finally:
                    health.close()

    def test_one_active_parse_refuses_another_without_blocking_health_or_auth(self):
        entered = threading.Event()
        release = threading.Event()

        def blocked_parse(request, **_kwargs):
            if request.sourceId == "active":
                entered.set()
                if not release.wait(timeout=5):
                    raise RuntimeError("Test parse was not released.")
            return {"ok": True}

        with self.serve() as port, ThreadPoolExecutor(max_workers=1) as executor:
            with patch.object(parser_service, "parse_document", side_effect=blocked_parse) as parse:
                first = executor.submit(self.post, port, sourceId="active")
                try:
                    self.assertTrue(entered.wait(timeout=5), "The first parse did not start.")
                    status, headers, body = self.post(port)
                    self.assertEqual(status, 503)
                    self.assertEqual(headers.get("retry-after"), "1")
                    self.assertEqual(json.loads(body), {"detail": "Document parser is busy."})
                    self.assertEqual(self.post(port, authenticated=False)[0], 401)
                    health = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                    try:
                        health.request("GET", "/health")
                        response = health.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertTrue(json.loads(response.read())["ok"])
                    finally:
                        health.close()
                    self.assertEqual(parse.call_count, 1)
                finally:
                    release.set()
                    self.assertEqual(first.result(timeout=5)[0], 200)
            self.assertEqual(self.post(port)[0], 200)

    def test_parse_slot_is_released_after_every_error_path(self):
        failures = [
            (ValueError("invalid"), 400),
            (subprocess.TimeoutExpired("mineru", 900), 504),
            (OSError("unavailable"), 503),
            (RuntimeError("failed"), 503),
            (json.JSONDecodeError("invalid", "", 0), 400),
            (LookupError("unexpected"), 500),
        ]
        with self.serve() as port:
            for error, expected in failures:
                with self.subTest(error=type(error).__name__):
                    with patch.object(parser_service, "parse_document", side_effect=error):
                        self.assertEqual(self.post(port)[0], expected)
                    self.assertEqual(self.post(port)[0], 200)


if __name__ == "__main__":
    unittest.main()
