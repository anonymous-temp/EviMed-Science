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
import build_pharmacy_reference as pharmacy_builder


class PublicSourceConnectorTests(unittest.TestCase):
    def test_clinpgx_uses_the_current_official_api_domain(self):
        payload = {"data": [{"id": "PA451906", "name": "warfarin", "types": ["Drug"]}]}
        with mock.patch.object(sources, "_get_json", return_value=payload) as request:
            result = sources._clinpgx("warfarin", 2)

        self.assertTrue(request.call_args.args[0].startswith("https://api.clinpgx.org/v1/data/chemical?"))
        self.assertEqual(result["data"]["items"][0]["id"], "PA451906")
        self.assertEqual(result["sources"][0]["source"], "clinpgx-pharmgkb")

    def test_private_pharmacy_reference_builder_and_read_only_search(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source_root = root / "sources"
            source_root.mkdir()
            (source_root / "sample.csv").write_text(
                "药品,规则,备注\n阿司匹林,高风险剂量复核,仅供测试\n二甲双胍,肾功能监测,仅供测试\n",
                encoding="utf-8",
            )
            database = root / "pharmacy.sqlite"
            with mock.patch.object(pharmacy_builder, "DATASETS", {"high-risk-dose": "sample.csv"}):
                receipt = pharmacy_builder.build(source_root, database)
            self.assertEqual(receipt["datasets"], 1)
            self.assertEqual(receipt["rows"], 2)
            with mock.patch.dict(os.environ, {"EVIMED_PHARMACY_REFERENCE_DB": str(database)}):
                self.assertTrue(sources.configured("pharmacy_reference_search"))
                result = sources.pharmacy_reference({"query": "阿司匹林", "limit": 5})
            self.assertEqual(result["status"], "warning")
            self.assertEqual(result["data"]["items"][0]["fields"]["药品"], "阿司匹林")
            self.assertEqual(result["sources"][0]["evidenceAccess"], "user_provided_other")
            self.assertTrue(any("not proof" in warning for warning in result["warnings"]))

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

    def test_documented_evimed_endpoint_is_the_default_internal_literature_source(self):
        payload = {
            "code": 200,
            "data": {
                "total": 1,
                "list": [{
                    "id": "paper-1", "title": "观察研究", "year": 2025,
                    "url": "https://pubmed.ncbi.nlm.nih.gov/12345678/",
                }],
            },
        }
        with mock.patch.object(sources, "_get_json", return_value=payload) as request:
            result = sources.literature({"query": "观察药 综合评价", "limit": 3})
        self.assertEqual(result["data"]["items"][0]["id"], "EVIMED-LITERATURE:paper-1")
        self.assertEqual(result["sources"][0]["source"], "evimed-literature")
        self.assertEqual(request.call_args.kwargs["credential_profile"], "evimed-evidence")

    def test_composite_evimed_literature_filters_candidates_by_every_required_concept(self):
        payload = {
            "code": 200,
            "data": {
                "total": 2,
                "list": [
                    {"id": "irrelevant", "title": "Metformin and preeclampsia prevention"},
                    {
                        "id": "background-only",
                        "title": "Glucose screening in polycystic ovary syndrome",
                        "abstract": "Participants had previously received metformin.",
                    },
                    {
                        "id": "relevant",
                        "title": "Metformin for polycystic ovary syndrome",
                        "abstract": "A randomized study in participants with PCOS.",
                    },
                ],
            },
        }
        with mock.patch.object(sources, "_get_json", return_value=payload) as request:
            result = sources._evimed_literature_records({
                "query": "metformin polycystic ovary syndrome",
                "requiredConcepts": ["metformin", "polycystic ovary syndrome"],
                "requiredTitleConcepts": ["metformin"],
                "limit": 3,
            })
        self.assertEqual([item["id"] for item in result["data"]["items"]], ["EVIMED-LITERATURE:relevant"])
        self.assertEqual(request.call_args.kwargs["json_body"]["count"], 15)
        self.assertTrue(any("Excluded 1" in warning for warning in result["warnings"]))
        self.assertTrue(any("titles" in warning for warning in result["warnings"]))

    def test_relevance_filter_does_not_match_ascii_concepts_inside_other_words(self):
        records, filtered = sources._filter_evimed_records(
            [{"title": "Cardiovascular heart outcomes"}],
            ["art"],
        )
        self.assertEqual(records, [])
        self.assertEqual(filtered, 1)

    def test_empty_evimed_us_label_result_falls_back_to_openfda(self):
        empty = {"status": "warning", "data": {"items": []}, "sources": [], "warnings": []}
        payload = {"results": [{
            "set_id": "set-1",
            "openfda": {"brand_name": ["Observed"], "generic_name": ["observed"]},
        }]}
        with mock.patch.object(sources, "_evimed_instruction_records", return_value=empty):
            with mock.patch.object(sources, "_get_json", return_value=payload):
                result = sources.labels({"drug": "observed", "jurisdiction": "US", "limit": 1})
        self.assertEqual(result["data"]["items"][0]["id"], "set-1")
        self.assertEqual(result["sources"][0]["source"], "openfda-label")
        self.assertTrue(any("no records" in warning for warning in result["warnings"]))
        self.assertTrue(any("No exact product" in warning for warning in result["warnings"]))

    def test_pubmed_fallback_keeps_only_titles_that_identify_the_medicine(self):
        empty = {"status": "warning", "data": {"items": []}, "sources": [], "warnings": []}
        fallback = {
            "summary": "Retrieved records.",
            "data": {"items": [
                {"id": "PMID:1", "title": "Weight management outcomes"},
                {"id": "PMID:2", "title": "Semaglutide for chronic weight management"},
            ]},
            "sources": [{"id": "PMID:1"}, {"id": "PMID:2"}],
        }
        with mock.patch.object(sources, "_evimed_literature_records", return_value=empty):
            with mock.patch.object(sources, "_pubmed", return_value=fallback):
                result = sources.literature({
                    "query": "semaglutide obesity",
                    "databases": ["internal", "pubmed"],
                    "requiredConcepts": ["semaglutide", "obesity"],
                    "requiredTitleConcepts": ["semaglutide"],
                    "limit": 2,
                })
        self.assertEqual([item["id"] for item in result["data"]["items"]], ["PMID:2"])
        self.assertEqual([item["id"] for item in result["sources"]], ["PMID:2"])
        self.assertTrue(any("bibliographic candidates" in warning for warning in result["warnings"]))

    def test_evimed_guideline_never_inherits_the_requested_jurisdiction(self):
        payload = {
            "code": 200,
            "data": {"total": 1, "list": [{
                "id": "guide-1",
                "title": "European obesity guideline",
                "publisher": "European Society",
                "region": "European Union",
            }]},
        }
        with mock.patch.object(sources, "_get_json", return_value=payload):
            result = sources._evimed_guidelines({
                "query": "obesity",
                "jurisdiction": "United States",
                "limit": 1,
            })
        self.assertEqual(result["data"]["requestedJurisdiction"], "United States")
        self.assertEqual(result["data"]["items"][0]["jurisdiction"], "European Union")

    def test_trial_relevance_requires_drug_intervention_and_condition(self):
        records = [
            {
                "title": "Exercise for polycystic ovary syndrome",
                "conditions": ["polycystic ovary syndrome"],
                "interventions": ["exercise"],
                "description": "Past metformin use was permitted.",
            },
            {
                "title": "Metformin for polycystic ovary syndrome",
                "conditions": ["polycystic ovary syndrome"],
                "interventions": ["metformin"],
            },
        ]
        filtered, count = sources._filter_trial_records(
            records,
            ["metformin", "polycystic ovary syndrome"],
        )
        self.assertEqual([item["title"] for item in filtered], ["Metformin for polycystic ovary syndrome"])
        self.assertEqual(count, 1)

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
        self.assertEqual(
            literature.call_args.args[0]["requiredConcepts"],
            ["观察药", "观察适应证"],
        )
        self.assertEqual(literature.call_args.args[0]["requiredTitleConcepts"], ["观察药"])

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

    def test_trusted_adapter_uses_owner_only_file_backed_evimed_credential(self):
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
                return b'{"code":200,"data":{}}'

        with tempfile.TemporaryDirectory() as temporary:
            credential = pathlib.Path(temporary) / "evimed-api-key"
            credential.write_text("test-file-backed-evidence-key", encoding="utf-8")
            credential.chmod(0o600)
            with mock.patch.dict(
                os.environ,
                {"EVIMED_EVIDENCE_SEARCH_KEY_FILE": str(credential)},
                clear=False,
            ):
                with mock.patch.object(sources._OPENER, "open", return_value=Response()) as opener:
                    value = sources._get_json(
                        "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/literature",
                        method="POST",
                        json_body={"query": "observed", "count": 1},
                        credential_profile="evimed-evidence",
                    )
            self.assertEqual(value, {"code": 200, "data": {}})
            request = opener.call_args.args[0]
            self.assertEqual(request.full_url, "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/literature")
            self.assertEqual(request.get_header("Authorization"), "Bearer test-file-backed-evidence-key")

            credential.chmod(0o644)
            with mock.patch.dict(
                os.environ,
                {"EVIMED_EVIDENCE_SEARCH_KEY_FILE": str(credential)},
                clear=False,
            ):
                with self.assertRaisesRegex(sources.PublicSourceError, "unavailable or unsafe"):
                    sources._direct_credential("evimed-evidence")

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

    def test_an_empty_connector_result_says_so_and_names_the_query_shape(self):
        with mock.patch.object(sources, "_get_json_value", return_value=[]):
            result = sources.biomedical_search({"source": "cbioportal", "query": "IDH1", "limit": 5})
        self.assertIn("matched", result["summary"])
        self.assertNotIn("Retrieved 0", result["summary"])
        warning = " ".join(result["warnings"])
        self.assertIn("matched nothing", warning)
        self.assertIn("study catalogue", warning)
        # The follow-up for an empty result cannot be "verify the cited record".
        self.assertNotIn("Open and verify", " ".join(result["next_actions"]))

    def test_string_sends_a_gene_list_as_separate_identifiers(self):
        # STRING reads space- or comma-joined text as a single identifier and
        # returns nothing for it, so a network query naming several genes has
        # to arrive carriage-return separated.
        payload = [{"stringId": "9606.ENSP0001", "preferredName": "APP"}]
        with mock.patch.object(sources, "_get_json_value", return_value=payload) as request:
            sources.biomedical_search({"source": "string", "query": "APP, PSEN1 APOE", "limit": 5})
        url = request.call_args.args[0]
        self.assertIn("identifiers=APP%0DPSEN1%0DAPOE", url)

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

    def test_europe_pmc_requests_core_records_and_marks_abstract_evidence(self):
        payload = {"resultList": {"result": [
            {"pmid": "101", "title": "With abstract", "doi": "10.1/observed", "pubYear": "2024",
             "abstractText": "An <i>important</i>   abstract."},
            {"pmid": "102", "title": "Without abstract"},
        ]}}
        with mock.patch.object(sources, "_get_json", return_value=payload) as request:
            result = sources.biomedical_search({"source": "europe-pmc", "query": "observed", "limit": 2})
        self.assertIn("resultType=core", request.call_args.args[0])
        first, second = result["data"]["items"]
        self.assertEqual(first["abstract"], "An important abstract.")
        self.assertEqual(first["evidenceLevel"], "abstract")
        self.assertNotIn("abstract", second)
        self.assertEqual(second["evidenceLevel"], "metadata")
        self.assertEqual(len(result["sources"]), 2)

    def test_openalex_reconstructs_abstracts_from_the_inverted_index(self):
        payload = {"results": [
            {"id": "https://openalex.org/W1", "doi": "https://doi.org/10.1/observed", "title": "Observed",
             "publication_year": 2024, "type": "article",
             "abstract_inverted_index": {"Observed": [0], "abstract": [1], "text.": [2]}},
            {"id": "https://openalex.org/W2", "title": "No abstract"},
        ]}
        with mock.patch.object(sources, "_get_json", return_value=payload) as request:
            result = sources.biomedical_search({"source": "openalex", "query": "observed", "limit": 2})
        self.assertIn("abstract_inverted_index", request.call_args.args[0])
        first, second = result["data"]["items"]
        self.assertEqual(first["abstract"], "Observed abstract text.")
        self.assertEqual(first["evidenceLevel"], "abstract")
        self.assertNotIn("abstract", second)
        self.assertEqual(second["evidenceLevel"], "metadata")

    def test_pubmed_search_attaches_efetch_abstracts_to_top_hits(self):
        ids = [str(100 + index) for index in range(6)]
        search = {"esearchresult": {"idlist": ids}}
        summary = {"result": {identifier: {"uid": identifier, "title": "Observed %s" % identifier} for identifier in ids}}
        efetch_xml = """
        <PubmedArticleSet>
          <PubmedArticle><MedlineCitation><PMID>100</PMID><Article><Abstract>
            <AbstractText Label="BACKGROUND">Observed background.</AbstractText>
            <AbstractText>Plain section.</AbstractText>
          </Abstract></Article></MedlineCitation></PubmedArticle>
          <PubmedArticle><MedlineCitation><PMID>101</PMID><Article><Abstract>
            <AbstractText>Second abstract.</AbstractText>
          </Abstract></Article></MedlineCitation></PubmedArticle>
        </PubmedArticleSet>
        """
        with mock.patch.object(sources, "_get_json", side_effect=[search, summary]):
            with mock.patch.object(sources, "_get_text", return_value=efetch_xml) as fetch:
                result = sources.biomedical_search({"source": "pubmed", "query": "observed", "limit": 6})
        fetch_url = fetch.call_args.args[0]
        self.assertIn("efetch.fcgi", fetch_url)
        self.assertIn("rettype=abstract", fetch_url)
        self.assertIn("id=100%2C101%2C102%2C103%2C104", fetch_url)
        self.assertNotIn("105", fetch_url)
        items = result["data"]["items"]
        self.assertEqual(items[0]["abstract"], "BACKGROUND: Observed background. Plain section.")
        self.assertEqual(items[0]["evidenceLevel"], "abstract")
        self.assertEqual(items[1]["abstract"], "Second abstract.")
        for item in items[2:]:
            self.assertEqual(item["evidenceLevel"], "metadata")
            self.assertNotIn("abstract", item)
        self.assertEqual(len(result["sources"]), 6)

    def test_pubmed_abstract_failure_degrades_to_metadata_with_a_note(self):
        search = {"esearchresult": {"idlist": ["101"]}}
        summary = {"result": {"101": {"uid": "101", "title": "Observed"}}}
        unavailable = sources.PublicSourceError("public_source_unavailable", "timed out", True)
        with mock.patch.object(sources, "_get_json", side_effect=[search, summary]):
            with mock.patch.object(sources, "_get_text", side_effect=unavailable):
                with mock.patch.object(sources.time, "sleep"):
                    result = sources.biomedical_search({"source": "pubmed", "query": "observed", "limit": 1})
        item = result["data"]["items"][0]
        self.assertEqual(item["title"], "Observed")
        self.assertEqual(item["evidenceLevel"], "metadata")
        self.assertNotIn("abstract", item)
        self.assertTrue(any("bibliographic metadata only" in warning for warning in result["warnings"]))

    def test_non_pubmed_ncbi_databases_never_fetch_abstracts(self):
        search = {"esearchresult": {"idlist": ["101"]}}
        summary = {"result": {"101": {"uid": "101", "title": "Observed"}}}
        with mock.patch.object(sources, "_get_json", side_effect=[search, summary]):
            with mock.patch.object(sources, "_get_text") as fetch:
                result = sources.biomedical_search({"source": "pmc", "query": "observed", "limit": 1})
        fetch.assert_not_called()
        self.assertNotIn("evidenceLevel", result["data"]["items"][0])

    def test_rxnorm_resolve_prefers_the_ingredient_concept(self):
        payload = {"drugGroup": {"conceptGroup": [
            {"tty": "BN", "conceptProperties": [{"rxcui": "5640", "name": "Advil", "synonym": "", "tty": "BN"}]},
            {"tty": "IN", "conceptProperties": [{"rxcui": "161", "name": "Ibuprofen", "synonym": "Brufen", "tty": "IN"}]},
        ]}}
        with mock.patch.object(sources, "_get_json", return_value=payload):
            resolved = sources.rxnorm_resolve("ibuprofen")
        self.assertEqual(resolved["rxcui"], "161")
        self.assertEqual(resolved["preferred"], "Ibuprofen")
        self.assertIn("Advil", resolved["synonyms"])
        self.assertIn("Brufen", resolved["synonyms"])

    def test_rxnorm_resolve_returns_none_without_concepts(self):
        with mock.patch.object(sources, "_get_json", return_value={"drugGroup": {}}):
            self.assertIsNone(sources.rxnorm_resolve("not-a-drug"))

    def test_rxnorm_connector_still_returns_traceable_records(self):
        payload = {"drugGroup": {"conceptGroup": [
            {"tty": "IN", "conceptProperties": [{"rxcui": "1191", "name": "Aspirin", "tty": "IN"}]},
        ]}}
        with mock.patch.object(sources, "_get_json", return_value=payload) as request:
            result = sources.biomedical_search({"source": "rxnorm", "query": "aspirin", "limit": 5})
        self.assertIn("drugs.json", request.call_args.args[0])
        self.assertEqual(result["data"]["items"][0]["id"], "1191")
        self.assertEqual(result["sources"][0]["source"], "rxnorm")

    def test_semantic_scholar_operates_keyless_public_without_managed_credential(self):
        payload = {"data": [{"paperId": "paper-1", "title": "Observed paper"}]}
        with mock.patch.dict(os.environ, {}, clear=True):
            with mock.patch.object(sources, "_get_json_value", return_value=payload) as request:
                result = sources.biomedical_search({"source": "semantic-scholar", "query": "TP53", "limit": 1})
        self.assertNotIn("credential_profile", request.call_args.kwargs)
        self.assertEqual(result["data"]["credentialMode"], "keyless-public")
        self.assertEqual(len(result["data"]["items"]), 1)
        self.assertTrue(any("rate limits" in warning for warning in result["warnings"]))

    def test_unpaywall_keyless_tier_requires_a_contact_email(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(sources.PublicSourceError) as raised:
                sources.biomedical_search({"source": "unpaywall", "query": "TP53", "limit": 1})
        self.assertEqual(raised.exception.code, "public_source_managed_credential_required")

    def test_unpaywall_operates_keyless_public_with_a_contact_email(self):
        payload = {"results": [{"response": {"doi": "10.1/observed", "title": "Observed OA"}}]}
        with mock.patch.dict(os.environ, {"EVIMED_UNPAYWALL_EMAIL": "researcher@example.org"}, clear=True):
            with mock.patch.object(sources, "_get_json_value", return_value=payload) as request:
                result = sources.biomedical_search({"source": "unpaywall", "query": "TP53", "limit": 1})
        self.assertNotIn("credential_profile", request.call_args.kwargs)
        self.assertIn("email=researcher%40example.org", request.call_args.args[0])
        self.assertEqual(result["data"]["credentialMode"], "keyless-public")
        self.assertEqual(len(result["data"]["items"]), 1)

    def test_keyless_public_never_bypasses_the_managed_gateway(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = pathlib.Path(temporary) / "opencode.json"
            config.write_text(json.dumps({
                "provider": {"deepseek": {"options": {"apiKey": "runtime-token"}}}
            }), encoding="utf-8")
            environment = {
                "EVIMED_PUBLIC_SOURCE_GATEWAY_URL": "http://internal.test/internal/sources/v1/fetch",
                "EVIMED_MODEL_CONFIG_FILE": str(config),
            }
            with mock.patch.dict(os.environ, environment, clear=True):
                with mock.patch.object(sources, "_get_json_value", return_value={"data": []}) as request:
                    result = sources.biomedical_search({"source": "semantic-scholar", "query": "TP53", "limit": 1})
        self.assertEqual(request.call_args.kwargs.get("credential_profile"), "semantic-scholar")
        self.assertEqual(result["data"]["credentialMode"], "managed")

    def test_other_credentialed_connectors_still_fail_closed(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            for profile in ("core", "umls", "omim", "addgene", "biogrid", "opengwas"):
                with self.subTest(profile=profile):
                    self.assertIsNone(sources._keyless_public_params(profile))
                    with self.assertRaises(sources.PublicSourceError) as raised:
                        sources._credentialed_json("https://example.test/api", profile)
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

    def test_prr_confidence_interval_and_chi_square_enable_the_evans_signal_flag(self):
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
                "metrics": ["prr"],
            })
        metrics = result["data"]["metrics"]
        # a=10, b=90, c=40, d=860, N=1000.
        self.assertTrue(math.isclose(metrics["prr"], (10 / 100) / (40 / 900)))  # 2.25
        se = math.sqrt(1 / 10 - 1 / 100 + 1 / 40 - 1 / 900)
        self.assertTrue(math.isclose(metrics["prr95CI"][0], math.exp(math.log(2.25) - 1.96 * se)))
        self.assertTrue(math.isclose(metrics["prr95CI"][1], math.exp(math.log(2.25) + 1.96 * se)))
        expected_chi = (1000 * (abs(10 * 860 - 90 * 40) - 500) ** 2) / (100 * 900 * 50 * 950)
        self.assertTrue(math.isclose(metrics["chiSquaredYates"], expected_chi))
        self.assertGreaterEqual(metrics["chiSquaredYates"], 4)
        # PRR>=2 and chi2>=4 and a>=3 -> EVANS signal true.
        self.assertTrue(metrics["evansSignal"])

    def test_evans_signal_is_false_when_disproportionality_is_weak(self):
        # a=3, b=97, c=40, d=860 -> PRR small, no EVANS signal even though estimable.
        totals = [
            (3, "https://source.test/joint"),
            (100, "https://source.test/drug"),
            (43, "https://source.test/event"),
            (1000, "https://source.test/total"),
        ]
        with mock.patch.object(sources, "_openfda_total", side_effect=totals):
            result = sources.adr_signal({
                "drug": "observed drug",
                "adverseEvent": "observed event",
                "metrics": ["prr"],
            })
        metrics = result["data"]["metrics"]
        self.assertIn("prr95CI", metrics)
        self.assertIn("chiSquaredYates", metrics)
        self.assertFalse(metrics["evansSignal"])

    def test_zero_faers_cells_are_reported_as_not_estimable_without_corrected_pseudo_signals(self):
        # Both terms are in the vocabulary; they were simply never co-reported.
        totals = [
            (0, "https://source.test/joint"),
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
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["metricStatus"], "not_estimable")
        self.assertEqual(result["data"]["metrics"], {})
        self.assertTrue(any("not estimable" in item for item in result["warnings"]))

    def test_a_term_that_matches_nothing_is_not_reported_as_an_absence_of_reports(self):
        # openFDA answers an unmatched term with 404 and the reader turns that
        # into a count of zero, so a misremembered MedDRA preferred term used to
        # read exactly like a genuine null. Measured against the live API:
        # "Takotsubo cardiomyopathy" returns 0 while the real preferred term,
        # "Stress cardiomyopathy", has 5710 reports.
        totals = [
            (0, "https://source.test/joint"),
            (53807, "https://source.test/drug"),
            (0, "https://source.test/event"),
            (20692690, "https://source.test/total"),
        ]
        candidates = [
            {"term": "Stress cardiomyopathy", "reportCount": 5710},
            {"term": "Cardiomyopathy", "reportCount": 20351},
        ]
        with mock.patch.object(sources, "_openfda_total", side_effect=totals), \
                mock.patch.object(sources, "_openfda_term_candidates", return_value=(candidates, "https://source.test/candidates")):
            result = sources.adr_signal({
                "drug": "nitroglycerin",
                "adverseEvent": "Takotsubo cardiomyopathy",
                "metrics": ["ror", "prr", "ic"],
            })
        self.assertEqual(result["data"]["metricStatus"], "term_unmatched")
        self.assertEqual(result["data"]["metrics"], {})
        self.assertEqual(
            result["data"]["unmatchedTerms"]["adverseEvent"]["searched"],
            "Takotsubo cardiomyopathy",
        )
        self.assertNotIn("drug", result["data"]["unmatchedTerms"], "the drug term did match")
        warning = next(item for item in result["warnings"] if "matched no FAERS record" in item)
        self.assertIn("do not report it as a null finding", warning)
        self.assertIn("Stress cardiomyopathy (5710 reports)", warning)

    def test_candidate_lookup_reads_the_vocabulary_rather_than_guessing(self):
        asked = []

        def fake_get_json(url, **kwargs):
            asked.append(url)
            return {"results": [
                {"term": "Paraesthesia", "count": 402113},
                {"term": "Paraesthesia oral", "count": 14184},
                {"term": "Oral pain", "count": 30112},
            ]}

        with mock.patch.object(sources, "_get_json", side_effect=fake_get_json):
            found, url = sources._openfda_term_candidates(
                "https://api.fda.gov", "patient.reaction.reactionmeddrapt", "Oral paraesthesia",
            )
        # Ranked by how many of the searched words the term contains, not by
        # size: ranking by size alone puts Paraesthesia (402113) above the term
        # actually being looked for.
        self.assertEqual(found[0], {"term": "Paraesthesia oral", "reportCount": 14184})
        self.assertEqual(len(asked), 1, "the narrow query answered; the broad one is not needed")
        self.assertIn("count=patient.reaction.reactionmeddrapt.exact", asked[0])
        self.assertIn("AND", asked[0])
        self.assertEqual(url, asked[0])

    def test_candidate_lookup_widens_when_a_word_is_not_in_the_vocabulary(self):
        # "takotsubo" appears in no preferred term at all, so requiring every
        # word matches nothing and only the broad query reaches the answer.
        asked = []

        def fake_get_json(url, **kwargs):
            asked.append(url)
            if "AND" in url:
                return {"results": []}
            return {"results": [{"term": "Stress cardiomyopathy", "count": 5710}]}

        with mock.patch.object(sources, "_get_json", side_effect=fake_get_json):
            found, _ = sources._openfda_term_candidates(
                "https://api.fda.gov", "patient.reaction.reactionmeddrapt", "Takotsubo cardiomyopathy",
            )
        self.assertEqual(len(asked), 2)
        self.assertIn("AND", asked[0])
        self.assertIn("OR", asked[1])
        self.assertEqual(found, [{"term": "Stress cardiomyopathy", "reportCount": 5710}])

        # A term with no usable words asks nothing at all rather than querying
        # the whole database.
        with mock.patch.object(sources, "_get_json", side_effect=AssertionError("must not query")):
            self.assertEqual(sources._openfda_term_candidates("https://api.fda.gov", "field", "x 12"), ([], None))

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


class RecordUrlNeverPointsAtTheApi(unittest.TestCase):
    """A record with no public link must carry no link.

    The endpoint that returned the record is an internal API route. Using it as
    the record's URL handed callers something they are forbidden to cite, and a
    clinical evidence report was rejected for citing it with no alternative
    available.
    """

    def test_a_record_without_a_url_gets_none(self):
        self.assertIsNone(sources._evimed_record_url(None))
        self.assertIsNone(sources._evimed_record_url(""))
        self.assertIsNone(sources._evimed_record_url({}))

    def test_a_record_with_a_public_url_keeps_it(self):
        self.assertEqual(
            sources._evimed_record_url("https://pubmed.ncbi.nlm.nih.gov/14678917/"),
            "https://pubmed.ncbi.nlm.nih.gov/14678917/",
        )
        self.assertEqual(
            sources._evimed_record_url({"Pubmed": "https://pubmed.ncbi.nlm.nih.gov/16440063/"}),
            "https://pubmed.ncbi.nlm.nih.gov/16440063/",
        )

    def test_a_source_entry_omits_an_absent_url(self):
        entry = sources._source("EVIMED-GUIDE:7", "A guideline", None, "evimed-guideline")
        self.assertNotIn("url", entry)
        self.assertEqual(entry["id"], "EVIMED-GUIDE:7")

    def test_no_caller_can_fall_back_to_the_internal_base_url(self):
        source = pathlib.Path(sources.__file__).read_text(encoding="utf-8")
        self.assertNotIn('record.get("url"), endpoint', source)
        self.assertNotIn('record.get("pdfUrl"), endpoint', source)


class RecordUrlIsCitableOrAbsent(unittest.TestCase):
    """Citations must be HTTPS, so an http:// record URL exists only to be
    rejected. A run cited two of them and the whole package was refused; the
    agent had no way to tell which of its sources were citable."""

    def test_http_is_upgraded(self):
        self.assertEqual(
            sources._citable_url("http://qikan.cqvip.com/Qikan/Article/Detail?id=7104224078"),
            "https://qikan.cqvip.com/Qikan/Article/Detail?id=7104224078",
        )

    def test_https_is_left_alone(self):
        url = "https://pubmed.ncbi.nlm.nih.gov/14678917/"
        self.assertEqual(sources._citable_url(url), url)

    def test_anything_else_yields_nothing(self):
        for value in ("", None, "ftp://example.org/paper.pdf", "not a url", "   "):
            self.assertIsNone(sources._citable_url(value), value)

    def test_record_urls_go_through_the_same_normalisation(self):
        self.assertEqual(
            sources._evimed_record_url({"Pubmed": "http://pubmed.ncbi.nlm.nih.gov/1/"}),
            "https://pubmed.ncbi.nlm.nih.gov/1/",
        )
        self.assertIsNone(sources._evimed_record_url({"url": "ftp://example.org/x"}))

    def test_no_caller_emits_an_unnormalised_record_url(self):
        source = pathlib.Path(sources.__file__).read_text(encoding="utf-8")
        self.assertNotIn('record_url = _first_text(record.get("url"))', source)
        self.assertNotIn('record.get("url"), endpoint', source)
