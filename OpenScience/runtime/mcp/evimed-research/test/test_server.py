import contextlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SERVER_FILE = ROOT / "server.py"


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp", SERVER_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ToolContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def assert_contract(self, result):
        allowed = {
            "status",
            "summary",
            "data",
            "sources",
            "warnings",
            "next_actions",
            "artifacts",
            "error",
        }
        self.assertLessEqual(set(result), allowed)
        self.assertIn(result["status"], {"success", "warning", "error"})
        self.assertIsInstance(result["summary"], str)
        if "error" in result:
            self.assertEqual(
                set(result["error"]) - {"stopReason"},
                {"code", "message", "retryable"},
            )

    def test_registry_exposes_manifest_tools_with_narrow_object_schemas(self):
        tools = self.server.list_tools()
        by_name = {tool["name"]: tool for tool in tools}
        expected = {
            "evimed_health",
            "evimed_data_source_catalog",
            "evimed_biomedical_source_search",
            "evimed_official_page_fetch",
            "evimed_open_access_full_text",
            "evimed_term_normalize",
            "evimed_drug_term_normalize",
            "evimed_evidence_deduplicate",
            "evimed_literature_search",
            "evimed_guideline_search",
            "evimed_clinical_trial_search",
            "evimed_patent_search",
            "evimed_pharmacy_reference_search",
            "evimed_drug_label_search",
            "evimed_adr_case_query",
            "evimed_adr_signal_analysis",
            "evimed_offlabel_evidence_packet",
            "evimed_comprehensive_drug_evaluation",
            "evimed_drug_selection_evaluation",
            "evimed_meta_analysis",
            "evimed_mendelian_randomization",
            "evimed_bibliometric_analysis",
            "evimed_research_topic_selection",
            "evimed_peer_review",
            "evimed_drug_safety_analysis",
        }
        self.assertEqual(set(by_name), expected)
        for tool in tools:
            schema = tool["inputSchema"]
            self.assertEqual(schema["type"], "object")
            self.assertFalse(schema["additionalProperties"])
            self.assertIn("properties", schema)
        self.assertEqual(by_name["evimed_drug_label_search"]["inputSchema"]["properties"]["limit"]["maximum"], 3)
        for name in {
            "evimed_meta_analysis",
            "evimed_mendelian_randomization",
            "evimed_bibliometric_analysis",
            "evimed_research_topic_selection",
            "evimed_peer_review",
            "evimed_drug_safety_analysis",
        }:
            wait_schema = by_name[name]["inputSchema"]["properties"]["waitSeconds"]
            self.assertEqual(wait_schema, {"type": "integer", "minimum": 0, "maximum": 45})
        self.assertEqual(
            set(by_name["evimed_biomedical_source_search"]["inputSchema"]["properties"]["source"]["enum"]),
            set(self.server.public_sources.QUERYABLE_BIOMEDICAL_SOURCE_IDS),
        )
        self.assertTrue(
            set(self.server.public_sources.BIOMEDICAL_SOURCE_IDS).isdisjoint(
                self.server.public_sources.CONDITIONAL_BIOMEDICAL_SOURCE_IDS,
            )
        )

    def test_managed_status_wait_reuses_one_tool_call_until_terminal(self):
        statuses = iter(["running", "running", "succeeded"])

        def status_call(arguments):
            self.assertNotIn("waitSeconds", arguments)
            job_status = next(statuses)
            return {
                "status": "warning" if job_status == "running" else "success",
                "summary": job_status,
                "data": {"jobStatus": job_status},
            }

        with mock.patch.object(self.server.time, "monotonic", side_effect=[0, 0, 0.2, 0.4, 0.6]), mock.patch.object(
            self.server.time, "sleep"
        ) as sleep:
            result = self.server._managed_status_with_wait(
                status_call, {"action": "status", "jobId": "job", "waitSeconds": 1}
            )

        self.assertEqual(result["data"]["jobStatus"], "succeeded")
        self.assertEqual(sleep.call_count, 2)

    def test_catalog_is_searchable_and_never_turns_blocked_sources_into_evidence(self):
        active = self.server.call_tool("evimed_data_source_catalog", {"status": "connected_public", "limit": 123})
        blocked = self.server.call_tool("evimed_data_source_catalog", {"status": "blocked_license", "limit": 123})
        self.assert_contract(active)
        self.assert_contract(blocked)
        self.assertEqual(active["status"], "success")
        self.assertGreater(len(active["data"]["items"]), 20)
        self.assertTrue(all(item["connectionState"] == "connected_public" for item in active["data"]["items"]))
        self.assertTrue(all(item["status"] == "connected_public" for item in active["data"]["items"]))
        self.assertTrue(all(item["catalogStatus"] == "active_tool" for item in active["data"]["items"]))
        summary = active["data"]["integrationSummary"]
        registered = set(self.server.public_sources.BIOMEDICAL_SOURCE_IDS)
        self.assertEqual(summary["reviewedTotal"], 123)
        self.assertEqual(summary["connectedPublic"], len(registered))
        self.assertEqual(summary["skillGuidanceOnly"], 13)
        self.assertEqual(summary["notConnected"], 123 - len(registered) - 13)
        self.assertEqual({item["connector"] for item in active["data"]["items"]}, registered)
        self.assertEqual(summary["productionConnectorRoute"], "controlled_connector_routes")
        self.assertEqual(
            summary["productionConnectorRoutes"],
            ["bundled_verified_dataset", "server_allowlisted_gateway"],
        )
        self.assertFalse(summary["runtimeArbitraryEgress"])
        self.assertTrue(all(item["status"] == "blocked_license" for item in blocked["data"]["items"]))
        self.assertTrue(all(item.get("blocker") for item in blocked["data"]["items"]))
        self.assertNotIn("sources", blocked)

    def test_biomedical_search_rejects_unregistered_source_before_network(self):
        result = self.server.call_tool(
            "evimed_biomedical_source_search", {"source": "unreviewed-web-scraper", "query": "observed"}
        )
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "invalid_input")

    def test_health_and_term_normalization_are_deterministic(self):
        scope = {
            "tenantId": "user-1",
            "userId": "user-1",
            "projectId": "project-1",
            "workspaceDir": "/workspace",
        }
        with mock.patch.dict(os.environ, {
            "OPEN_SCIENCE_TENANT_ID": scope["tenantId"],
            "OPEN_SCIENCE_USER_ID": scope["userId"],
            "OPEN_SCIENCE_PROJECT_ID": scope["projectId"],
            "OPEN_SCIENCE_WORKSPACE_DIR": scope["workspaceDir"],
        }):
            first = self.server.call_tool("evimed_health", {})
            second = self.server.call_tool("evimed_health", {})
            drug_arguments = {"term": "  acetaminophen  "}
            event_arguments = {"term": "心肌梗死", "domain": "adverse_event"}
            drug = self.server.call_tool("evimed_drug_term_normalize", drug_arguments)
            event = self.server.call_tool("evimed_term_normalize", event_arguments)
        self.assert_contract(first)
        self.assertEqual(first, second)
        self.assertEqual(first["data"]["service"], "evimed-research")
        self.assertEqual(first["data"]["dataSourceCatalog"]["reviewedTotal"], 123)
        self.assertIn("pubmed", first["data"]["dataSourceCatalog"]["activeConnectorIds"])
        self.assertNotIn("retrievedAt", first["data"])
        self.assertEqual(first["data"]["provenance"], {
            "tool": "evimed_health",
            "arguments": {},
            "scope": scope,
        })
        self.assertEqual(drug["data"]["preferred"], "paracetamol")
        self.assertIn("acetaminophen", drug["data"]["synonyms"])
        self.assertEqual(drug["data"]["provenance"], {
            "tool": "evimed_drug_term_normalize",
            "arguments": drug_arguments,
            "scope": scope,
        })
        self.assertEqual(event["data"]["preferred"], "myocardial infarction")
        self.assertEqual(event["data"]["provenance"], {
            "tool": "evimed_term_normalize",
            "arguments": event_arguments,
            "scope": scope,
        })

    def test_deduplicate_uses_identifiers_then_normalized_titles(self):
        arguments = {
            "items": [
                {"id": "a", "title": "A Trial", "doi": "https://doi.org/10.1/ABC"},
                {"id": "b", "title": "Different", "doi": "doi:10.1/abc"},
                {"id": "c", "title": "  Same: evidence!  "},
                {"id": "d", "title": "same evidence"},
                {"id": "e", "title": "Unique"},
            ]
        }
        scope = {
            "tenantId": "user-1",
            "userId": "user-1",
            "projectId": "project-1",
            "workspaceDir": "/workspace",
        }
        with mock.patch.dict(os.environ, {
            "OPEN_SCIENCE_TENANT_ID": scope["tenantId"],
            "OPEN_SCIENCE_USER_ID": scope["userId"],
            "OPEN_SCIENCE_PROJECT_ID": scope["projectId"],
            "OPEN_SCIENCE_WORKSPACE_DIR": scope["workspaceDir"],
        }):
            result = self.server.call_tool("evimed_evidence_deduplicate", arguments)
        self.assert_contract(result)
        self.assertEqual([item["id"] for item in result["data"]["items"]], ["a", "c", "e"])
        self.assertEqual(result["data"]["duplicates"], [
            {"duplicateId": "b", "canonicalId": "a", "matchedBy": "doi"},
            {"duplicateId": "d", "canonicalId": "c", "matchedBy": "title"},
        ])
        self.assertEqual(result["data"]["provenance"], {
            "tool": "evimed_evidence_deduplicate",
            "arguments": arguments,
            "scope": scope,
        })

    def test_invalid_input_returns_actionable_tool_error(self):
        result = self.server.call_tool("evimed_term_normalize", {"term": "", "extra": True})
        self.assert_contract(result)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "invalid_input")
        self.assertFalse(result["error"]["retryable"])
        self.assertTrue(result["error"]["stopReason"])
        self.assertTrue(result["next_actions"])

    def test_legacy_business_adapters_are_declared_and_fail_honestly_when_unconfigured(self):
        cases = [
            (
                "evimed_comprehensive_drug_evaluation",
                {"drug": "dapagliflozin", "indication": "chronic kidney disease"},
                "EVIMED_COMPREHENSIVE_DRUG_EVALUATION_URL",
            ),
            (
                "evimed_drug_selection_evaluation",
                {"candidateDrugs": ["drug-a", "drug-b"], "indication": "hypertension"},
                "EVIMED_DRUG_SELECTION_EVALUATION_URL",
            ),
        ]
        for tool, arguments, env_name in cases:
            with self.subTest(tool=tool), mock.patch.dict(os.environ, {
                "EVIMED_PUBLIC_CONNECTORS_ENABLED": "false",
            }, clear=False):
                os.environ.pop(env_name, None)
                result = self.server.call_tool(tool, arguments)
                self.assert_contract(result)
                self.assertEqual(result["status"], "error")
                self.assertEqual(result["error"]["code"], "adapter_unconfigured")
                self.assertIn(env_name, result["summary"])
                self.assertNotIn("data", result)
                self.assertNotIn("sources", result)


class AdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def setUp(self):
        self.old_env = os.environ.copy()
        self.server._ADAPTER_CIRCUITS.clear()
        self.token_dir = tempfile.TemporaryDirectory()
        self.token_file = pathlib.Path(self.token_dir.name) / "evimed-workload.token"
        self.token_file.write_text("test-only.signed.workload-token\n", encoding="utf-8")
        self.token_file.chmod(0o600)
        os.environ["EVIMED_WORKLOAD_TOKEN_FILE"] = str(self.token_file)
        os.environ.pop("EVIMED_WORKLOAD_TOKEN", None)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old_env)
        self.token_dir.cleanup()

    def call_with_response(self, body, arguments=None):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                self.rfile.read(length)
                payload = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            os.environ["EVIMED_LITERATURE_SEARCH_URL"] = (
                f"http://127.0.0.1:{httpd.server_port}/search"
            )
            return self.server.call_tool(
                "evimed_literature_search", arguments or {"query": "observed"}
            )
        finally:
            httpd.shutdown()
            thread.join()
            httpd.server_close()

    def assert_contract_rejection(self, result):
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "adapter_contract_invalid")
        self.assertFalse(result["error"]["retryable"])
        self.assertTrue(result["error"]["stopReason"])
        self.assertTrue(result["next_actions"])
        self.assertNotIn("data", result)
        self.assertNotIn("sources", result)

    def test_adapter_timeout_covers_managed_status_wait_budget(self):
        with mock.patch.dict(os.environ, {"EVIMED_ADAPTER_TIMEOUT_SECONDS": "15"}):
            self.assertEqual(
                self.server._adapter_timeout_seconds(
                    {"action": "status", "jobId": "job", "waitSeconds": 45}
                ),
                50,
            )
            self.assertEqual(
                self.server._adapter_timeout_seconds(
                    {"action": "status", "jobId": "job", "waitSeconds": 5}
                ),
                15,
            )
            self.assertEqual(
                self.server._adapter_timeout_seconds({"action": "start"}),
                15,
            )

        with mock.patch.dict(os.environ, {"EVIMED_ADAPTER_TIMEOUT_SECONDS": "invalid"}):
            self.assertEqual(
                self.server._adapter_timeout_seconds(
                    {"action": "status", "jobId": "job", "waitSeconds": 45}
                ),
                50,
            )

    def test_managed_status_rejects_waits_that_compete_with_mcp_deadline(self):
        result = self.server.call_tool(
            "evimed_drug_safety_analysis",
            {"action": "status", "jobId": "safety-12345678", "waitSeconds": 60},
        )

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "invalid_input")

    def test_unconfigured_adapter_fails_without_fabricated_evidence(self):
        os.environ.pop("EVIMED_LITERATURE_SEARCH_URL", None)
        os.environ["EVIMED_PUBLIC_CONNECTORS_ENABLED"] = "false"
        result = self.server.call_tool("evimed_literature_search", {"query": "osimertinib"})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "adapter_unconfigured")
        self.assertFalse(result["error"]["retryable"])
        self.assertNotIn("data", result)
        self.assertNotIn("sources", result)

    def test_public_pubmed_connector_is_real_traceable_and_needs_no_private_token(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def do_GET(self):
                requests.append({"path": self.path, "authorization": self.headers.get("authorization")})
                if self.path.startswith("/esearch.fcgi"):
                    body = {"esearchresult": {"idlist": ["12345"]}}
                elif self.path.startswith("/esummary.fcgi"):
                    body = {
                        "result": {
                            "12345": {
                                "uid": "12345",
                                "title": "Observed rituximab evidence",
                                "fulljournalname": "Evidence Journal",
                                "pubdate": "2026",
                                "authors": [{"name": "Researcher A"}],
                                "articleids": [{"idtype": "doi", "value": "10.1/observed"}],
                            }
                        }
                    }
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                payload = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            os.environ.pop("EVIMED_LITERATURE_SEARCH_URL", None)
            os.environ.pop("EVIMED_WORKLOAD_TOKEN_FILE", None)
            os.environ["EVIMED_PUBLIC_CONNECTORS_ENABLED"] = "true"
            os.environ["EVIMED_PUBMED_BASE_URL"] = f"http://127.0.0.1:{httpd.server_port}"
            os.environ["OPEN_SCIENCE_USER_ID"] = "user-public"
            os.environ["OPEN_SCIENCE_PROJECT_ID"] = "project-public"
            os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = "/workspace/public"
            result = self.server.call_tool(
                "evimed_literature_search",
                {"query": "rituximab", "limit": 3, "databases": ["pubmed"]},
            )
        finally:
            httpd.shutdown()
            thread.join()
            httpd.server_close()

        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["items"][0]["pmid"], "12345")
        self.assertEqual(result["sources"][0]["source"], "pubmed")
        self.assertTrue(any("bibliographic metadata only" in item for item in result["warnings"]))
        self.assertTrue(any("abstract or full text" in item for item in result["next_actions"]))
        self.assertEqual(result["data"]["provenance"]["scope"]["userId"], "user-public")
        self.assertEqual(len(requests), 2)
        self.assertTrue(all(item["authorization"] is None for item in requests))

    def test_documented_evimed_endpoints_are_exposed_through_managed_public_tools(self):
        os.environ["EVIMED_PUBLIC_CONNECTORS_ENABLED"] = "true"
        for env_name in (
            "EVIMED_LITERATURE_SEARCH_URL", "EVIMED_GUIDELINE_SEARCH_URL",
            "EVIMED_CLINICAL_TRIAL_SEARCH_URL", "EVIMED_PATENT_SEARCH_URL",
        ):
            os.environ.pop(env_name, None)
        responses = {
            "review/api/literature": {"code": 200, "data": {"total": 1, "list": [{"id": "p1", "title": "Observed paper", "url": {"Pubmed": "https://pubmed.ncbi.nlm.nih.gov/1/"}}]}},
            "review/api/guide-block": {"code": 200, "data": {"total": 1, "guides": [{"guideId": "g1", "title": "Observed guideline", "blocks": ["Verified recommendation block"], "url": "https://www.evimed.com/guide/g1"}]}},
            "review/api/clinical-trial": {"code": 200, "data": {"total": 1, "list": [{"registrationNo": "NCT1", "title": "Observed trial", "url": "https://clinicaltrials.gov/study/NCT1"}]}},
            "review/api/patent": {"code": 200, "data": {"total": 1, "list": [{"id": "pt1", "title": "Observed patent", "patentNumber": "WO-1", "url": "https://example.invalid/patent/1"}]}},
        }
        calls = []

        def fake_get_json(url, **kwargs):
            calls.append((url, kwargs))
            return next(value for suffix, value in responses.items() if url.endswith(suffix))

        with mock.patch.object(self.server.public_sources, "_get_json", side_effect=fake_get_json):
            literature = self.server.call_tool("evimed_literature_search", {"query": "observed", "limit": 2})
            guideline = self.server.call_tool("evimed_guideline_search", {"query": "observed", "mode": "blocks", "publisher": "NCCN"})
            trial = self.server.call_tool("evimed_clinical_trial_search", {"query": "observed", "registry": 1})
            patent = self.server.call_tool("evimed_patent_search", {"query": "observed"})

        self.assertEqual(literature["data"]["items"][0]["id"], "EVIMED-LITERATURE:p1")
        self.assertEqual(guideline["data"]["items"][0]["blocks"], ["Verified recommendation block"])
        self.assertEqual(trial["data"]["items"][0]["id"], "NCT1")
        self.assertEqual(patent["data"]["items"][0]["patentNumber"], "WO-1")
        self.assertTrue(all(kwargs["credential_profile"] == "evimed-evidence" for _, kwargs in calls))

    def test_public_connector_retryable_failure_participates_in_the_circuit_breaker(self):
        os.environ.pop("EVIMED_LITERATURE_SEARCH_URL", None)
        os.environ["EVIMED_PUBLIC_CONNECTORS_ENABLED"] = "true"
        os.environ["EVIMED_ADAPTER_CIRCUIT_FAILURES"] = "2"
        error = self.server.public_sources.PublicSourceError(
            "public_source_unavailable", "source down", True
        )
        with mock.patch.object(self.server.public_sources, "call", side_effect=error):
            first = self.server.call_tool("evimed_literature_search", {"query": "one"})
            second = self.server.call_tool("evimed_literature_search", {"query": "two"})
            third = self.server.call_tool("evimed_literature_search", {"query": "three"})
        self.assertEqual(first["error"]["code"], "public_source_unavailable")
        self.assertEqual(second["error"]["code"], "public_source_unavailable")
        self.assertEqual(third["error"]["code"], "adapter_circuit_open")

    def test_biomedical_source_circuits_isolate_unrelated_upstreams(self):
        os.environ["EVIMED_PUBLIC_CONNECTORS_ENABLED"] = "true"
        os.environ["EVIMED_ADAPTER_CIRCUIT_FAILURES"] = "1"
        unavailable = self.server.public_sources.PublicSourceError(
            "public_source_unavailable", "source down", True
        )

        def public_call(_name, arguments):
            if arguments["source"] == "pubchem":
                raise unavailable
            return {"summary": "No records.", "data": {"items": []}, "sources": []}

        with mock.patch.object(self.server.public_sources, "call", side_effect=public_call) as call:
            failed = self.server.call_tool(
                "evimed_biomedical_source_search", {"source": "pubchem", "query": "aspirin"}
            )
            paused = self.server.call_tool(
                "evimed_biomedical_source_search", {"source": "pubchem", "query": "metformin"}
            )
            unrelated = self.server.call_tool(
                "evimed_biomedical_source_search", {"source": "pubmed", "query": "aspirin"}
            )

        self.assertEqual(failed["error"]["code"], "public_source_unavailable")
        self.assertEqual(paused["error"]["code"], "adapter_circuit_open")
        self.assertEqual(unrelated["status"], "warning")
        self.assertEqual(call.call_count, 2)

    def test_public_adr_signal_uses_a_traceable_contingency_table_without_inventing_ebgm(self):
        public = self.server.public_sources
        with mock.patch.object(
            public,
            "_openfda_total",
            side_effect=[
                (10, "https://example.test/joint"),
                (100, "https://example.test/drug"),
                (1000, "https://example.test/event"),
                (10000, "https://example.test/all"),
            ],
        ):
            result = public.adr_signal({
                "drug": "observed-drug",
                "adverseEvent": "observed-event",
                "metrics": ["ror", "prr", "ic", "ebgm"],
            })

        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["cells"], {"a": 10, "b": 90, "c": 990, "d": 8910})
        self.assertAlmostEqual(result["data"]["metrics"]["ror"], 1.0)
        self.assertAlmostEqual(result["data"]["metrics"]["prr"], 1.0)
        self.assertNotIn("ebgm", result["data"]["metrics"])
        self.assertEqual(len(result["sources"]), 4)
        self.assertTrue(any("EBGM requires" in item for item in result["warnings"]))
        self.assertTrue(any("does not establish causality or incidence" in item for item in result["warnings"]))

    def test_public_specialist_packets_preserve_evidence_domains_and_never_fabricate_scores(self):
        public = self.server.public_sources

        def observed(source):
            return {
                "summary": "Observed source.",
                "data": {"items": [{"id": source}]},
                "sources": [{
                    "id": source,
                    "source": source,
                    "retrievedAt": "2026-07-17T00:00:00Z",
                }],
            }

        with (
            mock.patch.object(public, "labels", side_effect=lambda _args: observed("label")),
            mock.patch.object(public, "guideline", side_effect=lambda _args: observed("guideline")),
            mock.patch.object(public, "trials", side_effect=lambda _args: observed("trial")),
            mock.patch.object(public, "literature", side_effect=lambda _args: observed("literature")),
        ):
            offlabel = public.call("evimed_offlabel_evidence_packet", {
                "drug": "observed-drug",
                "proposedUse": "observed-use",
            })
            comprehensive = public.call("evimed_comprehensive_drug_evaluation", {
                "drug": "observed-drug",
                "indication": "observed-indication",
            })
            selection = public.call("evimed_drug_selection_evaluation", {
                "candidateDrugs": ["drug-a", "drug-b"],
                "indication": "observed-indication",
            })

        for packet, mode in (
            (offlabel, "off-label"),
            (comprehensive, "comprehensive-drug-evaluation"),
        ):
            self.assertEqual(packet["status"], "warning")
            self.assertEqual(packet["data"]["mode"], mode)
            for domain in ("labels", "guidelines", "trials", "literature"):
                self.assertEqual(len(packet["data"][domain]), 1)
            self.assertEqual(len(packet["sources"]), 4)
            self.assertTrue(any("not equivalent to a complete" in item for item in packet["warnings"]))

        self.assertEqual(selection["status"], "warning")
        self.assertEqual(len(selection["data"]["items"]), 2)
        self.assertTrue(all(item["scores"] is None for item in selection["data"]["items"]))
        self.assertTrue(any("not validated formulary scores" in item for item in selection["warnings"]))

    def test_adapter_passes_scoped_context_and_preserves_sources(self):
        captured = {}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                captured["body"] = json.loads(self.rfile.read(length))
                captured["headers"] = dict(self.headers)
                response = {
                    "data": {"items": [{"id": "PMID:1", "title": "Observed evidence"}]},
                    "sources": [
                        {
                            "id": "PMID:1",
                            "title": "Observed evidence",
                            "url": "https://pubmed.ncbi.nlm.nih.gov/1/",
                            "source": "pubmed",
                            "retrievedAt": "2026-07-16T00:00:00Z",
                        }
                    ],
                }
                payload = json.dumps(response).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            os.environ["EVIMED_LITERATURE_SEARCH_URL"] = (
                f"http://127.0.0.1:{httpd.server_port}/search"
            )
            os.environ["OPEN_SCIENCE_USER_ID"] = "user-1"
            os.environ["OPEN_SCIENCE_PROJECT_ID"] = "project-1"
            os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = "/workspace"
            result = self.server.call_tool(
                "evimed_literature_search", {"query": "observed", "limit": 5}
            )
        finally:
            httpd.shutdown()
            thread.join()
            httpd.server_close()

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["sources"][0]["source"], "pubmed")
        self.assertEqual(result["data"]["provenance"], {
            "tool": "evimed_literature_search",
            "arguments": {"query": "observed", "limit": 5},
            "scope": {
                "tenantId": "user-1",
                "userId": "user-1",
                "projectId": "project-1",
                "workspaceDir": "/workspace",
            },
        })
        self.assertEqual(captured["body"], {"query": "observed", "limit": 5})
        self.assertEqual(
            captured["headers"]["Authorization"],
            "Bearer test-only.signed.workload-token",
        )
        self.assertNotIn("X-Open-Science-User", captured["headers"])
        self.assertNotIn("X-Open-Science-Project", captured["headers"])
        self.assertNotIn("X-Open-Science-Workspace", captured["headers"])

    def test_adapter_requires_a_server_minted_workload_token(self):
        os.environ.pop("EVIMED_WORKLOAD_TOKEN_FILE")
        os.environ["EVIMED_WORKLOAD_TOKEN"] = "caller-controlled-token-must-be-ignored"
        os.environ["EVIMED_LITERATURE_SEARCH_URL"] = "https://evidence.internal/search"
        result = self.server.call_tool("evimed_literature_search", {"query": "observed"})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "adapter_workload_token_unavailable")
        self.assertFalse(result["error"]["retryable"])

    def test_adapter_rereads_rotated_workload_token_without_process_restart(self):
        authorizations = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                self.rfile.read(length)
                authorizations.append(self.headers.get("authorization"))
                payload = json.dumps({
                    "data": {"items": [{"id": "PMID:1"}]},
                    "sources": [{
                        "id": "PMID:1",
                        "source": "pubmed",
                        "retrievedAt": "2026-07-16T00:00:00Z",
                    }],
                }).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            os.environ["EVIMED_LITERATURE_SEARCH_URL"] = (
                f"http://127.0.0.1:{httpd.server_port}/search"
            )
            first = self.server.call_tool("evimed_literature_search", {"query": "first"})
            self.token_file.write_text("rotated.signed.workload-token\n", encoding="utf-8")
            self.token_file.chmod(0o600)
            second = self.server.call_tool("evimed_literature_search", {"query": "second"})
        finally:
            httpd.shutdown()
            thread.join()
            httpd.server_close()

        self.assertEqual(first["status"], "success")
        self.assertEqual(second["status"], "success")
        self.assertEqual(authorizations, [
            "Bearer test-only.signed.workload-token",
            "Bearer rotated.signed.workload-token",
        ])

    def test_workload_token_file_rejects_missing_symlink_and_oversize_files(self):
        outside = pathlib.Path(self.token_dir.name) / "outside.token"
        outside.write_text("outside.signed.token\n", encoding="utf-8")
        outside.chmod(0o600)
        cases = []

        self.token_file.unlink()
        cases.append(("missing", self.token_file))

        symlink_file = pathlib.Path(self.token_dir.name) / "symlink.token"
        symlink_file.symlink_to(outside)
        cases.append(("symlink", symlink_file))

        oversized_file = pathlib.Path(self.token_dir.name) / "oversized.token"
        oversized_file.write_bytes(b"x" * (8 * 1024 + 1))
        oversized_file.chmod(0o600)
        cases.append(("oversized", oversized_file))

        os.environ["EVIMED_LITERATURE_SEARCH_URL"] = "https://evidence.internal/search"
        for label, token_file in cases:
            with self.subTest(label=label):
                os.environ["EVIMED_WORKLOAD_TOKEN_FILE"] = str(token_file)
                result = self.server.call_tool(
                    "evimed_literature_search", {"query": "observed"}
                )
                self.assertEqual(result["status"], "error")
                self.assertEqual(
                    result["error"]["code"], "adapter_workload_token_unavailable"
                )
                self.assertFalse(result["error"]["retryable"])

    def test_empty_adapter_result_is_an_explicit_warning(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                self.rfile.read(length)
                payload = b'{"data":{"items":[]},"sources":[]}'
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            os.environ["EVIMED_GUIDELINE_SEARCH_URL"] = (
                f"http://127.0.0.1:{httpd.server_port}/search"
            )
            result = self.server.call_tool("evimed_guideline_search", {"query": "rare"})
        finally:
            httpd.shutdown()
            thread.join()
            httpd.server_close()

        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"], {"items": []})
        self.assertTrue(result["warnings"])
        self.assertTrue(result["next_actions"])

    def test_http_failure_reports_root_cause_retry_and_stop_condition(self):
        os.environ["EVIMED_ADR_CASE_QUERY_URL"] = "http://127.0.0.1:1/cases"
        result = self.server.call_tool(
            "evimed_adr_case_query", {"drug": "osimertinib", "limit": 20}
        )
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "adapter_unavailable")
        self.assertTrue(result["error"]["retryable"])
        self.assertTrue(result["error"]["stopReason"])
        self.assertTrue(result["next_actions"])
        self.assertNotIn("data", result)

    def test_repeated_retryable_failures_open_a_visible_adapter_circuit(self):
        os.environ["EVIMED_ADAPTER_CIRCUIT_FAILURES"] = "2"
        os.environ["EVIMED_ADAPTER_CIRCUIT_COOLDOWN_SECONDS"] = "60"
        os.environ["EVIMED_ADR_CASE_QUERY_URL"] = "http://127.0.0.1:1/cases"
        arguments = {"drug": "osimertinib", "limit": 20}

        first = self.server.call_tool("evimed_adr_case_query", arguments)
        second = self.server.call_tool("evimed_adr_case_query", arguments)
        third = self.server.call_tool("evimed_adr_case_query", arguments)
        health = self.server.call_tool("evimed_health", {})

        self.assertEqual(first["error"]["code"], "adapter_unavailable")
        self.assertEqual(second["error"]["code"], "adapter_unavailable")
        self.assertEqual(third["error"]["code"], "adapter_circuit_open")
        connector = next(
            item for item in health["data"]["adapters"]
            if item["tool"] == "evimed_adr_case_query"
        )
        self.assertEqual(connector["state"], "open")
        self.assertEqual(connector["failures"], 2)
        self.assertGreater(connector["retryAfterSeconds"], 0)

    def test_prewrapped_success_requires_strict_contract_and_traceable_sources(self):
        invalid = [
            {
                "status": "ok",
                "summary": "Evidence returned.",
                "data": {"items": [{"id": "PMID:1"}]},
                "sources": [{
                    "id": "PMID:1",
                    "source": "pubmed",
                    "retrievedAt": "2026-07-16T00:00:00Z",
                }],
            },
            {"status": "success", "summary": " ", "data": {"items": []}},
            {"status": "success", "summary": "Empty.", "data": {"items": []}, "extra": True},
            {
                "status": "success",
                "summary": "Evidence returned.",
                "data": {"items": [{"id": "PMID:1"}]},
                "sources": [],
            },
        ]
        for body in invalid:
            with self.subTest(body=body):
                self.assert_contract_rejection(self.call_with_response(body))

    def test_prewrapped_warning_requires_actions_warnings_and_provenance_for_evidence(self):
        source = {
            "id": "PMID:1",
            "source": "pubmed",
            "retrievedAt": "2026-07-16T00:00:00Z",
        }
        invalid = [
            {
                "status": "warning",
                "summary": "Partial evidence.",
                "data": {"items": []},
                "sources": [],
                "warnings": [],
                "next_actions": ["Broaden the query."],
            },
            {
                "status": "warning",
                "summary": "Partial evidence.",
                "data": {"items": []},
                "sources": [],
                "warnings": ["Coverage is incomplete."],
                "next_actions": [],
            },
            {
                "status": "warning",
                "summary": "Partial evidence.",
                "data": {"items": [{"id": "PMID:1"}]},
                "sources": [],
                "warnings": ["Coverage is incomplete."],
                "next_actions": ["Broaden the query."],
            },
            {
                "status": "warning",
                "summary": "Partial evidence.",
                "data": {"items": [{"id": "PMID:1"}]},
                "sources": [source],
                "warnings": [""],
                "next_actions": ["Broaden the query."],
            },
        ]
        for body in invalid:
            with self.subTest(body=body):
                self.assert_contract_rejection(self.call_with_response(body))

    def test_prewrapped_error_requires_exact_actionable_error_contract(self):
        invalid = [
            {
                "status": "error",
                "summary": "Upstream failed.",
                "next_actions": ["Check upstream."],
            },
            {
                "status": "error",
                "summary": "Upstream failed.",
                "next_actions": [],
                "error": {
                    "code": "upstream_failed",
                    "message": "Upstream failed.",
                    "retryable": True,
                    "stopReason": "Stop after one retry.",
                },
            },
            {
                "status": "error",
                "summary": "Upstream failed.",
                "next_actions": ["Check upstream."],
                "error": {
                    "code": "upstream_failed",
                    "message": "Upstream failed.",
                    "retryable": "yes",
                    "stopReason": "Stop after one retry.",
                },
            },
            {
                "status": "error",
                "summary": "Upstream failed.",
                "next_actions": ["Check upstream."],
                "error": {
                    "code": "upstream_failed",
                    "message": "Upstream failed.",
                    "retryable": True,
                    "stopReason": "",
                },
            },
        ]
        for body in invalid:
            with self.subTest(body=body):
                self.assert_contract_rejection(self.call_with_response(body))

    def test_sources_require_iso_timestamp_stable_locator_and_known_fields(self):
        invalid_sources = [
            {"id": "PMID:1", "source": "pubmed", "retrievedAt": "yesterday"},
            {"source": "pubmed", "retrievedAt": "2026-07-16T00:00:00Z"},
            {
                "url": "/relative",
                "source": "pubmed",
                "retrievedAt": "2026-07-16T00:00:00Z",
            },
            {
                "id": "PMID:1",
                "source": "pubmed",
                "retrievedAt": "2026-07-16T00:00:00Z",
                "unexpected": True,
            },
        ]
        for source in invalid_sources:
            with self.subTest(source=source):
                result = self.call_with_response({
                    "data": {"items": [{"id": "PMID:1"}]},
                    "sources": [source],
                })
                self.assert_contract_rejection(result)

    def test_valid_prewrapped_success_keeps_contract_and_adds_input_provenance(self):
        os.environ["OPEN_SCIENCE_USER_ID"] = "user-1"
        os.environ["OPEN_SCIENCE_PROJECT_ID"] = "project-1"
        os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = "/workspace"
        body = {
            "status": "success",
            "summary": "Evidence returned.",
            "data": {"items": [{"id": "PMID:1", "title": "Observed evidence"}]},
            "sources": [{
                "id": "PMID:1",
                "title": "Observed evidence",
                "url": "https://pubmed.ncbi.nlm.nih.gov/1/",
                "source": "pubmed",
                "retrievedAt": "2026-07-16T00:00:00Z",
            }],
        }
        result = self.call_with_response(body, {"query": "observed", "limit": 3})
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["summary"], "Evidence returned.")
        self.assertEqual(result["data"]["provenance"], {
            "tool": "evimed_literature_search",
            "arguments": {"query": "observed", "limit": 3},
            "scope": {
                "tenantId": "user-1",
                "userId": "user-1",
                "projectId": "project-1",
                "workspaceDir": "/workspace",
            },
        })
        self.assertEqual(result["sources"], body["sources"])

    def test_valid_prewrapped_warning_adds_input_provenance(self):
        os.environ["OPEN_SCIENCE_USER_ID"] = "user-1"
        os.environ["OPEN_SCIENCE_PROJECT_ID"] = "project-1"
        os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = "/workspace"
        body = {
            "status": "warning",
            "summary": "Evidence coverage is partial.",
            "data": {"items": [{"id": "PMID:1"}]},
            "sources": [{
                "id": "PMID:1",
                "source": "pubmed",
                "retrievedAt": "2026-07-16T00:00:00Z",
            }],
            "warnings": ["One configured source was unavailable."],
            "next_actions": ["Retry once after checking source readiness."],
        }
        result = self.call_with_response(body, {"query": "observed", "limit": 3})
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["provenance"], {
            "tool": "evimed_literature_search",
            "arguments": {"query": "observed", "limit": 3},
            "scope": {
                "tenantId": "user-1",
                "userId": "user-1",
                "projectId": "project-1",
                "workspaceDir": "/workspace",
            },
        })

    def test_adapter_refuses_redirects_without_contacting_the_second_hop(self):
        second_hop_requests = []

        class TargetHandler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def do_GET(self):
                second_hop_requests.append(self.path)
                self.send_response(200)
                self.end_headers()

            def do_POST(self):
                second_hop_requests.append(self.path)
                self.send_response(200)
                self.end_headers()

        target = ThreadingHTTPServer(("127.0.0.1", 0), TargetHandler)
        target_thread = threading.Thread(target=target.serve_forever, daemon=True)
        target_thread.start()

        class RedirectHandler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def do_POST(self):
                self.send_response(302)
                self.send_header(
                    "location", f"http://127.0.0.1:{target.server_port}/second-hop"
                )
                self.end_headers()

        redirect = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
        redirect_thread = threading.Thread(target=redirect.serve_forever, daemon=True)
        redirect_thread.start()
        try:
            os.environ["EVIMED_LITERATURE_SEARCH_URL"] = (
                f"http://127.0.0.1:{redirect.server_port}/redirect"
            )
            result = self.server.call_tool(
                "evimed_literature_search", {"query": "observed"}
            )
        finally:
            redirect.shutdown()
            redirect_thread.join()
            redirect.server_close()
            target.shutdown()
            target_thread.join()
            target.server_close()

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "adapter_redirect_forbidden")
        self.assertFalse(result["error"]["retryable"])
        self.assertEqual(second_hop_requests, [])


class ProtocolTests(unittest.TestCase):
    def test_stdio_json_rpc_supports_initialize_list_call_and_notification(self):
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "evimed_health", "arguments": {}},
            },
        ]
        proc = subprocess.run(
            [sys.executable, str(SERVER_FILE)],
            input="".join(json.dumps(message) + "\n" for message in messages),
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stderr, "")
        lines = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual([line["id"] for line in lines], [1, 2, 3])
        self.assertEqual(lines[0]["result"]["serverInfo"]["name"], "evimed-research")
        names = {tool["name"] for tool in lines[1]["result"]["tools"]}
        self.assertIn("evimed_health", names)
        tool_result = lines[2]["result"]["structuredContent"]
        self.assertEqual(tool_result["status"], "success")
        self.assertEqual(
            json.loads(lines[2]["result"]["content"][0]["text"]), tool_result
        )

    def test_unknown_method_uses_json_rpc_error_without_stdout_noise(self):
        request = {"jsonrpc": "2.0", "id": 9, "method": "unknown", "params": {}}
        proc = subprocess.run(
            [sys.executable, str(SERVER_FILE)],
            input=json.dumps(request) + "\n",
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )
        self.assertEqual(proc.returncode, 0)
        response = json.loads(proc.stdout)
        self.assertEqual(response["error"]["code"], -32601)
        self.assertEqual(proc.stderr, "")

    def test_oversized_stdio_frame_is_rejected_and_next_request_still_runs(self):
        oversized = b'{"jsonrpc":"2.0","id":41,"padding":"' + (b"x" * (1024 * 1024)) + b'"}\n'
        valid = json.dumps({
            "jsonrpc": "2.0",
            "id": 42,
            "method": "tools/call",
            "params": {"name": "evimed_health", "arguments": {}},
        }).encode() + b"\n"
        proc = subprocess.run(
            [sys.executable, str(SERVER_FILE)],
            input=oversized + valid,
            capture_output=True,
            check=False,
            timeout=5,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        responses = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertIn(responses[0]["error"]["code"], {-32600, -32700})
        self.assertEqual(responses[1]["id"], 42)
        self.assertEqual(responses[1]["result"]["structuredContent"]["status"], "success")

    def test_internal_error_preserves_the_parsed_request_id(self):
        server = load_server()
        response = server.process_frame(
            json.dumps({"jsonrpc": "2.0", "id": "request-7", "method": "tools/list"}).encode(),
            handler=lambda _request: (_ for _ in ()).throw(RuntimeError("boom")),
        )
        self.assertEqual(response["id"], "request-7")
        self.assertEqual(response["error"]["code"], -32603)


if __name__ == "__main__":
    unittest.main()
