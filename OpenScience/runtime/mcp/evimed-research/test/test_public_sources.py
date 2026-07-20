import math
import json
import os
import pathlib
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import public_sources as sources


class PublicSourceConnectorTests(unittest.TestCase):
    def test_openfda_event_boolean_operator_is_encoded_exactly_once(self):
        query = sources._event_search({
            "drug": "aspirin",
            "adverseEvent": "nausea",
        })
        url = sources._url("https://api.fda.gov", "drug/event.json", {"search": query, "limit": 1})
        parsed = sources.urllib.parse.parse_qs(sources.urllib.parse.urlparse(url).query)

        self.assertIn(" AND ", query)
        self.assertEqual(parsed["search"], [query])
        self.assertIn("+AND+", url)
        self.assertNotIn("%2BAND%2B", url)

    def test_openfda_case_query_pages_below_response_cap_and_reports_public_limit(self):
        def page(url, allow_not_found=False):
            del allow_not_found
            parsed = sources.urllib.parse.urlparse(url)
            params = sources.urllib.parse.parse_qs(parsed.query)
            limit = int(params["limit"][0])
            skip = int(params["skip"][0])
            return {
                "results": [
                    {
                        "safetyreportid": "case-%d" % index,
                        "receivedate": "20260720",
                        "patient": {"reaction": [], "drug": []},
                    }
                    for index in range(skip, skip + limit)
                ]
            }

        with mock.patch.object(sources, "_get_json", side_effect=page) as request:
            result = sources.adr_cases({
                "drug": "aspirin",
                "adverseEvent": "gastrointestinal haemorrhage",
                "limit": 50,
            })

        self.assertEqual(request.call_count, 5)
        for call in request.call_args_list:
            params = sources.urllib.parse.parse_qs(sources.urllib.parse.urlparse(call.args[0]).query)
            self.assertLessEqual(int(params["limit"][0]), sources._OPENFDA_CASE_BATCH_SIZE)
            self.assertIn("skip", params)
        self.assertEqual(result["status"], "warning")
        self.assertEqual(len(result["data"]["items"]), 25)
        self.assertEqual(result["data"]["requestedLimit"], 50)
        self.assertEqual(result["data"]["effectiveLimit"], 25)
        self.assertEqual(result["data"]["publicConnectorLimit"], 25)
        self.assertEqual(len(result["sources"]), 25)
        self.assertTrue(any("caps" in warning for warning in result["warnings"]))
        self.assertTrue(result["next_actions"])

    def test_openfda_case_query_stops_paging_after_short_page(self):
        with mock.patch.object(
            sources,
            "_get_json",
            return_value={
                "results": [{
                    "safetyreportid": "only-case",
                    "patient": {"reaction": [], "drug": []},
                }],
            },
        ) as request:
            result = sources.adr_cases({"drug": "observed", "limit": 20})

        request.assert_called_once()
        self.assertEqual(result["data"]["requestedLimit"], 20)
        self.assertEqual(result["data"]["effectiveLimit"], 20)
        self.assertEqual([item["id"] for item in result["data"]["items"]], ["only-case"])

    def test_public_label_connector_never_substitutes_fda_for_another_jurisdiction(self):
        unavailable = sources.PublicSourceError("missing", "managed EviMed key unavailable")
        with mock.patch.object(sources, "_evimed_instruction_records", side_effect=unavailable):
            with mock.patch.object(sources, "_get_json") as request:
                result = sources.labels({"drug": "observed-drug", "jurisdiction": "China", "limit": 1})
        request.assert_not_called()
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["items"], [])
        self.assertEqual(result["data"]["availableJurisdiction"], "United States (FDA)")
        self.assertTrue(any("was not substituted" in item for item in result["warnings"]))

    def test_evimed_nmpa_label_candidates_are_traceable_and_require_official_verification(self):
        payload = {
            "code": 200,
            "data": {
                "nmpa": [{
                    "id": "label-1",
                    "genericNames": "观察药",
                    "tradeNames": "观察品牌",
                    "indication": "观察适应症",
                    "revisionDate": "2025-01-01",
                    "url": "https://example.test/nmpa-label",
                }],
                "fda": [], "ema": [], "pmda": [],
            },
        }
        with mock.patch.object(sources, "_get_json", return_value=payload) as request:
            result = sources.labels({"drug": "观察药", "product": "观察品牌 观察厂家", "jurisdiction": "NMPA", "limit": 3})
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["items"][0]["jurisdiction"], "China (NMPA)")
        self.assertEqual(result["data"]["items"][0]["indicationsAndUsage"], "观察适应症")
        self.assertEqual(result["sources"][0]["source"], "evimed-nmpa-label")
        self.assertEqual(request.call_args.kwargs["credential_profile"], "evimed-evidence")
        self.assertEqual(request.call_args.kwargs["json_body"]["query"], "观察药 观察品牌 观察厂家")
        self.assertTrue(any("current official label" in item for item in result["warnings"]))

    def test_evimed_evidence_search_is_the_default_internal_literature_source(self):
        payload = {
            "code": 200,
            "data": {
                "paper": [{
                    "id": "paper-1", "title": "观察研究", "year": 2025,
                    "url": "https://pubmed.ncbi.nlm.nih.gov/12345678/",
                }],
                "guide": [], "clinicalTrials": [], "instructions": [],
            },
        }
        with mock.patch.object(sources, "_get_json", return_value=payload) as request:
            result = sources.literature({"query": "观察药 综合评价", "limit": 3})
        self.assertEqual(result["data"]["items"][0]["id"], "EVIMED-PAPER:paper-1")
        self.assertEqual(result["sources"][0]["source"], "evimed-evidence-paper")
        self.assertEqual(request.call_args.kwargs["credential_profile"], "evimed-evidence")

    def test_composite_drug_workflows_keep_evimed_evidence_enabled_by_default(self):
        empty = {"status": "warning", "data": {"items": []}, "sources": [], "warnings": []}
        with mock.patch.object(sources, "labels", return_value=empty):
            with mock.patch.object(sources, "guideline", return_value=empty):
                with mock.patch.object(sources, "trials", return_value=empty):
                    with mock.patch.object(sources, "literature", return_value=empty) as literature:
                        sources._composite({
                            "drug": "观察药",
                            "product": "观察品牌 观察厂家",
                            "indication": "观察适应证",
                            "jurisdiction": "China",
                        }, "comprehensive-drug-evaluation")
        self.assertEqual(literature.call_args.args[0]["databases"], ["internal", "pubmed"])

    def test_managed_gateway_reuses_the_active_runtime_token_without_direct_egress(self):
        class Headers:
            @staticmethod
            def get_content_type():
                return "application/json"

        class Response:
            headers = Headers()

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            @staticmethod
            def read(_limit):
                return b'{"observed": true}'

        with tempfile.TemporaryDirectory() as temporary:
            config = pathlib.Path(temporary) / "opencode.json"
            config.write_text(json.dumps({
                "provider": {"deepseek": {"options": {"apiKey": "runtime-token"}}}
            }), encoding="utf-8")
            old_gateway = os.environ.get("EVIMED_PUBLIC_SOURCE_GATEWAY_URL")
            old_config = os.environ.get("EVIMED_MODEL_CONFIG_FILE")
            os.environ["EVIMED_PUBLIC_SOURCE_GATEWAY_URL"] = "http://internal.test/internal/sources/v1/fetch"
            os.environ["EVIMED_MODEL_CONFIG_FILE"] = str(config)
            try:
                with mock.patch.object(sources._OPENER, "open", return_value=Response()) as opener:
                    value = sources._get_json("https://api.crossref.org/works?query=observed")
                self.assertEqual(value, {"observed": True})
                request = opener.call_args.args[0]
                self.assertEqual(request.full_url, "http://internal.test/internal/sources/v1/fetch")
                self.assertEqual(request.get_header("Authorization"), "Bearer runtime-token")
                self.assertEqual(
                    json.loads(request.data.decode("utf-8"))["url"],
                    "https://api.crossref.org/works?query=observed",
                )
            finally:
                if old_gateway is None:
                    os.environ.pop("EVIMED_PUBLIC_SOURCE_GATEWAY_URL", None)
                else:
                    os.environ["EVIMED_PUBLIC_SOURCE_GATEWAY_URL"] = old_gateway
                if old_config is None:
                    os.environ.pop("EVIMED_MODEL_CONFIG_FILE", None)
                else:
                    os.environ["EVIMED_MODEL_CONFIG_FILE"] = old_config

    def test_ncbi_dispatch_preserves_database_identity_and_provenance(self):
        search = {"esearchresult": {"idlist": ["101"]}}
        summary = {"result": {"101": {"uid": "101", "caption": "BRCA1", "description": "Observed gene"}}}
        with mock.patch.object(sources, "_get_json", side_effect=[search, summary]):
            result = sources.biomedical_search({"source": "ncbi-gene", "query": "BRCA1", "limit": 1})
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["source"], "ncbi-gene")
        self.assertEqual(result["data"]["items"][0]["id"], "101")
        self.assertEqual(result["sources"][0]["source"], "ncbi-gene")
        self.assertIn("retrievedAt", result["sources"][0])

    def test_ncbi_control_characters_are_tolerated_without_relaxing_other_sources(self):
        class Headers:
            @staticmethod
            def get_content_type():
                return "application/json"

        class Response:
            headers = Headers()

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            @staticmethod
            def read(_limit):
                return b'{"value":"line\x0bfeed"}'

        with mock.patch.object(sources, "_open_remote", return_value=Response()):
            with mock.patch.object(sources.time, "sleep"):
                value = sources._ncbi_get_json(
                    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
                )
            self.assertEqual(value["value"], "line\x0bfeed")
            with self.assertRaises(sources.PublicSourceError):
                sources._get_json("https://api.example.test/strict.json")

    def test_ncbi_requests_retry_bounded_transient_rate_limits(self):
        transient = sources.PublicSourceError("public_source_http_error", "HTTP 429", True)
        with mock.patch.object(sources, "_get_json", side_effect=[transient, {"ok": True}]) as request:
            with mock.patch.object(sources.time, "sleep") as sleep:
                value = sources._ncbi_get_json("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi")
        self.assertEqual(value, {"ok": True})
        self.assertEqual(request.call_count, 2)
        self.assertTrue(any(call.args == (1,) for call in sleep.call_args_list))

    def test_array_json_sources_are_supported_without_weakening_object_connectors(self):
        payload = [{"stringId": "9606.ENSP0001", "preferredName": "TP53"}]
        with mock.patch.object(sources, "_get_json_value", return_value=payload):
            result = sources.biomedical_search({"source": "string", "query": "TP53", "limit": 1})
        self.assertEqual(result["data"]["items"][0]["title"], "TP53")
        self.assertEqual(result["sources"][0]["source"], "string")

    def test_ena_search_uses_bounded_title_matching(self):
        with mock.patch.object(sources, "_get_json_value", return_value=[]) as request:
            result = sources.biomedical_search({"source": "ena", "query": "breast cancer", "limit": 2})
        self.assertEqual(result["data"]["items"], [])
        url = request.call_args.args[0]
        self.assertIn("result=study", url)
        self.assertIn("study_title%3D%22breast+cancer%22", url)

    def test_pride_search_uses_the_documented_search_endpoint(self):
        with mock.patch.object(sources, "_get_json_value", return_value={"_embedded": {"projects": []}}) as request:
            result = sources.biomedical_search({"source": "pride", "query": "diabetes proteomics", "limit": 2})
        self.assertEqual(result["data"]["items"], [])
        self.assertIn("/search/projects?", request.call_args.args[0])

    def test_iuphar_preserves_numeric_target_ids(self):
        payload = [{
            "targetId": 2332,
            "name": "BRCA1 associated deubiquitinase 1",
            "type": "enzyme",
            "familyNames": ["Ubiquitin C-terminal hydrolase"],
        }]
        with mock.patch.object(sources, "_get_json_value", return_value=payload):
            result = sources.biomedical_search({
                "source": "iuphar-bps-guide-to-pharmacology",
                "query": "BRCA1",
                "limit": 1,
            })
        self.assertEqual(result["data"]["items"][0]["id"], "2332")
        self.assertEqual(result["sources"][0]["id"], "2332")
        self.assertIn("objectId=2332", result["sources"][0]["url"])

    def test_ensembl_retries_transient_gateway_failures(self):
        transient = sources.PublicSourceError("public_source_unavailable", "timed out", True)
        record = {"id": "ENSG00000141510", "display_name": "TP53", "biotype": "protein_coding"}
        with mock.patch.object(sources, "_get_json_value", side_effect=[transient, record]) as request:
            with mock.patch.object(sources.time, "sleep") as sleep:
                result = sources.biomedical_search({"source": "ensembl", "query": "TP53", "limit": 1})
        self.assertEqual(request.call_count, 2)
        sleep.assert_called_once_with(1)
        self.assertEqual(result["data"]["items"][0]["id"], "ENSG00000141510")

    def test_sider_queries_only_the_bounded_verified_local_index(self):
        self.assertIn("sider", sources.BIOMEDICAL_SOURCE_IDS)
        with tempfile.TemporaryDirectory() as temporary:
            database = pathlib.Path(temporary) / "sider.sqlite"
            connection = sqlite3.connect(database)
            connection.executescript("""
                CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE drug_names (compound_id TEXT, name TEXT, normalized_name TEXT);
                CREATE TABLE side_effects (compound_id TEXT, concept_id TEXT, effect_name TEXT);
            """)
            connection.execute("INSERT INTO metadata VALUES (?, ?)", ("release", "SIDER 4.1 (2015-10-21)"))
            connection.executemany("INSERT INTO drug_names VALUES (?, ?, ?)", [
                ("CID100002244", "aspirin", "aspirin"),
                ("CID100004091", "metformin", "metformin"),
            ])
            connection.executemany("INSERT INTO side_effects VALUES (?, ?, ?)", [
                ("CID100002244", "C0002", "Observed effect"),
                ("CID100004091", "C0003", "Other effect"),
            ])
            connection.commit()
            connection.close()
            with mock.patch.dict(os.environ, {"EVIMED_SIDER_CACHE_FILE": str(database)}):
                aspirin = sources.biomedical_search({"source": "sider", "query": "aspirin", "limit": 10})
                metformin = sources.biomedical_search({"source": "sider", "query": "metformin", "limit": 10})
            self.assertEqual(len(aspirin["data"]["items"]), 1)
            self.assertEqual(aspirin["data"]["items"][0]["meddraConceptId"], "C0002")
            self.assertEqual(metformin["data"]["items"][0]["sideEffect"], "Other effect")
            self.assertTrue(any("research-only" in item for item in aspirin["warnings"]))

    def test_biomedical_source_registry_and_dispatch_are_exactly_aligned(self):
        self.assertEqual(len(sources.BIOMEDICAL_SOURCE_IDS), len(set(sources.BIOMEDICAL_SOURCE_IDS)))
        self.assertIn("clinicaltrials-gov", sources.BIOMEDICAL_SOURCE_IDS)
        self.assertNotIn("semantic-scholar", sources.BIOMEDICAL_SOURCE_IDS)
        self.assertIn("semantic-scholar", sources.CONDITIONAL_BIOMEDICAL_SOURCE_IDS)
        self.assertEqual(
            set(sources.QUERYABLE_BIOMEDICAL_SOURCE_IDS),
            set(sources.BIOMEDICAL_SOURCE_IDS) | set(sources.CONDITIONAL_BIOMEDICAL_SOURCE_IDS),
        )
        self.assertTrue(set(sources.BIOMEDICAL_SOURCE_IDS).isdisjoint(sources.CONDITIONAL_BIOMEDICAL_SOURCE_IDS))

    def test_credentialed_connectors_have_real_parsers_and_traceable_records(self):
        cases = {
            "semantic-scholar": ({"data": [{"paperId": "paper-1", "title": "Observed paper"}]}, "semantic-scholar"),
            "core": ({"results": [{"id": 1, "title": "Observed work"}]}, "core"),
            "unpaywall": ({"results": [{"response": {"doi": "10.1/observed", "title": "Observed OA"}}]}, "unpaywall"),
            "umls": ({"result": {"results": [{"ui": "C0000001", "name": "Observed concept"}]}}, "umls"),
            "omim-online-mendelian-inheritance-in-man": (
                {"omim": {"searchResponse": {"entryList": [{"entry": {"mimNumber": 1, "titles": {"preferredTitle": "Observed phenotype"}}}]}}},
                "omim",
            ),
            "addgene-plasmid-repository": ({"results": [{"id": 1, "name": "Observed plasmid"}]}, "addgene"),
            "biogrid": ({"1": {"BIOGRID_INTERACTION_ID": 1, "OFFICIAL_SYMBOL_A": "TP53", "OFFICIAL_SYMBOL_B": "MDM2"}}, "biogrid"),
            "opengwas-ieu-gwas": ({"ieu-a-2": {"id": "ieu-a-2", "trait": "Observed trait"}}, "opengwas"),
        }
        for source_id, (payload, expected_profile) in cases.items():
            with self.subTest(source=source_id):
                query = "ieu-a-2" if source_id == "opengwas-ieu-gwas" else "TP53"
                with mock.patch.object(sources, "_credentialed_json", return_value=payload) as request:
                    result = sources.biomedical_search({"source": source_id, "query": query, "limit": 1})
                self.assertEqual(len(result["data"]["items"]), 1)
                self.assertEqual(len(result["sources"]), 1)
                self.assertEqual(request.call_args.args[1], expected_profile)

    def test_credentialed_connector_fails_closed_without_managed_gateway(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(sources.PublicSourceError) as raised:
                sources._get_json("https://uts-ws.nlm.nih.gov/rest/search/current?string=TP53", credential_profile="umls")
        self.assertEqual(raised.exception.code, "public_source_managed_credential_required")

    def test_literature_results_are_explicitly_bibliographic_metadata_only(self):
        result = {
            "summary": "Retrieved one record.",
            "data": {"items": [{"title": "Observed title"}]},
            "sources": [{"id": "PMID:1"}],
        }
        with mock.patch.object(sources, "_pubmed", return_value=result):
            output = sources.literature({"query": "observed", "limit": 1})
        self.assertEqual(output["status"], "warning")
        self.assertEqual(output["data"], result["data"])
        self.assertTrue(any("bibliographic metadata only" in item for item in output["warnings"]))
        self.assertTrue(any("abstract or full text" in item for item in output["next_actions"]))

    def test_trial_records_preserve_registry_identifiers_and_urls(self):
        payload = {
            "studies": [{
                "protocolSection": {
                    "identificationModule": {"nctId": "NCT00000001", "briefTitle": "Observed Trial"},
                    "statusModule": {"overallStatus": "RECRUITING"},
                    "conditionsModule": {"conditions": ["Observed condition"]},
                    "armsInterventionsModule": {"interventions": [{"name": "Observed drug"}]},
                }
            }]
        }
        with mock.patch.object(sources, "_get_json", return_value=payload):
            result = sources.trials({"query": "observed", "limit": 2})
        self.assertEqual(result["data"]["items"][0]["id"], "NCT00000001")
        self.assertEqual(result["sources"][0]["source"], "clinicaltrials.gov")
        self.assertEqual(result["sources"][0]["url"], "https://clinicaltrials.gov/study/NCT00000001")

    def test_label_connector_bounds_large_sections_before_model_context(self):
        payload = {"results": [{
            "set_id": "set-1",
            "openfda": {"brand_name": ["Observed"], "generic_name": ["observed"]},
            "indications_and_usage": ["x" * 20000],
            "warnings": ["y" * 20000],
            "boxed_warning": ["z" * 20000],
        }]}
        with mock.patch.object(sources, "_get_json", return_value=payload):
            result = sources.labels({"drug": "observed", "limit": 1})
        item = result["data"]["items"][0]
        self.assertEqual(len(item["indicationsAndUsage"][0]), 1500)
        self.assertEqual(len(item["warnings"][0]), 1500)
        self.assertEqual(len(item["boxedWarnings"][0]), 1500)
        self.assertTrue(item["contentTruncated"])
        self.assertEqual(result["sources"][0]["id"], "set-1")

    def test_label_connector_defensively_caps_records_even_for_direct_calls(self):
        payload = {"results": [
            {"set_id": "set-%d" % index, "openfda": {"brand_name": ["Observed"]}}
            for index in range(10)
        ]}
        with mock.patch.object(sources, "_get_json", return_value=payload):
            result = sources.labels({"drug": "observed", "limit": 200})
        self.assertEqual(len(result["data"]["items"]), 3)

    def test_faers_signal_metrics_are_derived_from_a_traceable_two_by_two_table(self):
        totals = [
            (10, "https://source.test/joint"),
            (100, "https://source.test/drug"),
            (50, "https://source.test/event"),
            (1000, "https://source.test/total"),
        ]
        with mock.patch.object(sources, "_openfda_total", side_effect=totals):
            result = sources.adr_signal({
                "drug": "observed drug",
                "adverseEvent": "observed event",
                "metrics": ["ror", "prr", "ic"],
            })
        self.assertEqual(result["data"]["cells"], {"a": 10, "b": 90, "c": 40, "d": 860})
        self.assertEqual(result["data"]["metricStatus"], "estimated")
        self.assertTrue(math.isclose(result["data"]["metrics"]["ror"], (10 * 860) / (90 * 40)))
        self.assertEqual(len(result["sources"]), 4)
        self.assertIn("does not establish causality", result["warnings"][0])

    def test_zero_faers_cells_are_reported_as_not_estimable_without_corrected_pseudo_signals(self):
        totals = [
            (0, "https://source.test/joint"),
            (0, "https://source.test/drug"),
            (50, "https://source.test/event"),
            (1000, "https://source.test/total"),
        ]
        with mock.patch.object(sources, "_openfda_total", side_effect=totals):
            result = sources.adr_signal({
                "drug": "unobserved drug",
                "adverseEvent": "observed event",
                "metrics": ["ror", "prr", "ic"],
            })
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["metricStatus"], "not_estimable")
        self.assertEqual(result["data"]["metrics"], {})
        self.assertTrue(any("not estimable" in item for item in result["warnings"]))

    def test_ebgm_is_never_fabricated(self):
        totals = [(1, "https://source.test/a"), (10, "https://source.test/b"), (20, "https://source.test/c"), (100, "https://source.test/d")]
        with mock.patch.object(sources, "_openfda_total", side_effect=totals):
            result = sources.adr_signal({
                "drug": "observed drug",
                "adverseEvent": "observed event",
                "metrics": ["ebgm"],
            })
        self.assertEqual(result["status"], "warning")
        self.assertNotIn("ebgm", result["data"]["metrics"])
        self.assertTrue(any("not calculated" in item for item in result["warnings"]))


if __name__ == "__main__":
    unittest.main()
