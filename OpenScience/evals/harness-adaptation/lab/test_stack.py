#!/usr/bin/env python3
"""Tests of the stack definition's pure parts: the levers, the overlay, the pins, the parser probe's PDF, the metrics reading. No Docker, no network.
Run: python3 -I -m unittest discover -s . -p "test_stack.py" (from this directory)."""
import importlib.util
import json
import os
import pathlib
import re
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
OPENSCIENCE = HERE.parents[2]
os.environ["LAB_WORK"] = tempfile.mkdtemp()
os.environ["LAB_SRC"] = str(OPENSCIENCE)
spec = importlib.util.spec_from_file_location("stack", HERE / "stack.py")
stack = importlib.util.module_from_spec(spec)
sys.modules["stack"] = stack
spec.loader.exec_module(stack)


class ContextEngine(unittest.TestCase):
    def test_memory_and_the_context_engine_are_on_as_in_production(self):
        overrides = stack.lab_overrides(3)
        for name in ("OPEN_SCIENCE_OPENVIKING_URL", "OPEN_SCIENCE_MEMORY_ENABLED"):
            self.assertNotIn(name, overrides, f"{name} is no longer a difference from production")
            self.assertNotIn(name, stack.PARITY)
        self.assertIn("evimed-openviking", stack.SERVICES)
        self.assertLess(stack.SERVICES.index("evimed-openviking"), stack.SERVICES.index("open-science-web"), "the engine is started before the control plane")
        self.assertEqual(stack.PARITY["OPEN_SCIENCE_MEMORY_INDEX_PROVIDER"], "openviking")
        self.assertEqual(stack.PARITY["OPEN_SCIENCE_OPENVIKING_ACCOUNT"], "evimed")
        # the levers production sets for the reranker and the recall budgets (the 2026-11-01 snapshot's values)
        self.assertEqual(stack.PARITY["OPEN_SCIENCE_MEMORY_RERANK_MODEL"], "qwen3-rerank")
        self.assertEqual(stack.PARITY["OPEN_SCIENCE_MEMORY_CONTEXT_LIMIT"], "8")

    def test_the_engine_image_is_the_pin_of_deps_version_and_the_compose_default(self):
        image = stack.openviking_image()
        pin = json.loads((OPENSCIENCE / "deps-version.json").read_text())["openviking"]
        self.assertEqual(image, f"ghcr.io/volcengine/openviking:{pin['imageTag']}@{pin['imageDigest']}")
        self.assertRegex(image, r"@sha256:[0-9a-f]{64}$")
        compose = (OPENSCIENCE / "deploy/web/docker-compose.yml").read_text()
        self.assertEqual(len(re.findall(re.escape(image), compose)), 2, "the base stack's engine and its init step name the same pin")

    def test_the_overlay_starts_the_engine_wires_the_parser_and_keeps_the_dataset_hosts_pinned(self):
        overlay = (HERE / "docker-compose.lab.yml").read_text()
        self.assertNotRegex(overlay, r'OPEN_SCIENCE_OPENVIKING_URL:\s*""')
        self.assertRegex(overlay, r"evimed-openviking:\s*\n\s*#[^\n]*\n\s*condition: service_started")
        for name in ("OPEN_SCIENCE_DOCUMENT_PARSER_URL", "OPEN_SCIENCE_DOCUMENT_PARSER_TOKEN_FILE", "OPEN_SCIENCE_DOCUMENT_PARSER_TIMEOUT_MS", "OPEN_SCIENCE_DOCUMENT_PARSER_REVISION"):
            self.assertIn(name, overlay)
        self.assertIn("target: /run/secrets/document-parser-token", overlay)
        self.assertIn('"huggingface.co:127.0.0.1"', overlay)
        # the base stack reads the same names the overlay forwards
        ingestion = (OPENSCIENCE / "deploy/web/docker-compose.ingestion.yml").read_text()
        for name in re.findall(r"OPEN_SCIENCE_DOCUMENT_PARSER_[A-Z_]+", overlay):
            self.assertIn(name, ingestion, f"{name} is a name production's ingestion overlay uses")

    def test_a_lab_without_a_parser_address_asks_for_no_parser(self):
        self.assertEqual(stack.PARITY["OPEN_SCIENCE_REQUIRE_DOCUMENT_PARSER"], "true", "production's value; `env` writes false when the bundle names no service")
        self.assertEqual(stack.optional_secret(pathlib.Path("/nonexistent/document-parser.url")), "")


class ParserProbe(unittest.TestCase):
    def test_the_probe_pdf_is_a_well_formed_one_page_pdf(self):
        pdf = stack.tiny_pdf()
        self.assertTrue(pdf.startswith(b"%PDF-1.4\n") and pdf.endswith(b"%%EOF\n"))
        startxref = int(re.search(rb"startxref\n(\d+)\n", pdf).group(1))
        self.assertEqual(pdf[startxref:startxref + 4], b"xref")
        table = re.findall(rb"(\d{10}) 00000 n \n", pdf)
        self.assertEqual(len(table), 5)
        for number, offset in enumerate(table, 1):
            self.assertEqual(pdf[int(offset):int(offset) + len(f"{number} 0 obj".encode())], f"{number} 0 obj".encode(), f"object {number}")
        self.assertIn(b"RSI lab parser check", pdf)
        length = int(re.search(rb"/Length (\d+)", pdf).group(1))
        body = pdf.split(b"stream\n", 1)[1].split(b"\nendstream", 1)[0]
        self.assertEqual(len(body), length)

    def test_the_probe_prints_no_address_and_no_text(self):
        # counters only: the probe's output fields are booleans, a count and bounded codes
        printed = re.findall(r"out\.(\w+)", stack.PARSER_PROBE)
        self.assertNotIn("url", [name.lower() for name in printed])
        self.assertNotIn("text", printed)


class Metrics(unittest.TestCase):
    def test_commits_refusals_and_records_are_summed_from_the_exposition_text(self):
        text = "\n".join([
            "# HELP open_science_native_memory_turn_commits_total x",
            'open_science_native_memory_turn_commits_total{outcome="committed"} 2',
            'open_science_native_memory_turn_commits_total{outcome="scheduled"} 1',
            'open_science_native_memory_turn_commits_total{outcome="platform_started"} 7',
            'open_science_learning_trigger_refused_total{reason="automated"} 3',
            'open_science_learning_trigger_refused_total{reason="paused"} 1',
            "open_science_learning_evidence_observations_total 4",
            'open_science_learning_evidence_incidents_total{kind="x"} 1',
            "open_science_unrelated_total 99",
        ])
        self.assertEqual(stack.parse_metrics(text), {"read": True, "memoryTurnCommitted": 3.0, "memoryTurnPlatformStarted": 7.0, "learningRefused": 4.0, "learningRecorded": 5.0})
        self.assertEqual(stack.parse_metrics(""), {"read": True, "memoryTurnCommitted": 0.0, "memoryTurnPlatformStarted": 0.0, "learningRefused": 0.0, "learningRecorded": 0.0})


class Deltas(unittest.TestCase):
    def test_the_web_delta_replaces_the_three_places_the_image_holds_the_code_in(self):
        dockerfile = (HERE / "Dockerfile.web-delta").read_text()
        for place in ("/app/apps/server/src", "/app/packages/domain/src", "${DOMAIN_DEPLOYED}/src"):
            self.assertIn(place, dockerfile)
        self.assertRegex(dockerfile, r"RUN rm -rf /app/apps/server/src /app/packages/domain/src \"\$\{DOMAIN_DEPLOYED\}/src\"")
        # the deployed copy's path is the one `pnpm deploy` writes (deploy/web/Dockerfile deploys @ai4s/server with @evimed/domain from the workspace)
        self.assertIn("@evimed+domain@file+packages+domain", dockerfile)
        web = (OPENSCIENCE / "deploy/web/Dockerfile").read_text()
        self.assertIn("pnpm --filter @ai4s/server deploy --prod /server", web)

    def test_the_stack_knows_the_new_commands(self):
        for name in ("cmd_build_web_delta", "cmd_facts"):
            self.assertTrue(callable(getattr(stack, name)), name)
        # sharing a built delta image between jobs by artifact was tried on 2026-11-02 and removed: `docker load` of the saved image fails
        # on the runner ("max depth exceeded"); see .rsi-lab/README.txt on the lanes branch
        self.assertFalse(hasattr(stack, "cmd_save_delta") or hasattr(stack, "cmd_load_delta"))


if __name__ == "__main__":
    unittest.main()
