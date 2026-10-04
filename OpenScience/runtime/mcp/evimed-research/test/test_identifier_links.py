"""Linked identifiers: PMID, PMCID and DOI resolved to one another against the recorded wire.

The answers come from `wire/` (recorded 2026-10-04). The world below serves a
recording only for a question the recording answers, and filters a recorded list
to the ids actually asked, as the live APIs do; a question with no recording fails
the test instead of getting a plausible reply.
"""

import hashlib
import json
import os
import pathlib
import sys
import tempfile
import unittest
import urllib.parse
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import identifier_links as links  # noqa: E402
import public_sources  # noqa: E402
import source_outcome  # noqa: E402
import source_transport  # noqa: E402
import wire_fixtures as wire  # noqa: E402

IDCONV_FILES = {
    "pmid": "idconv__pmid_found_and_not_in_pmc.json",
    "pmcid": "idconv__pmcid_found_and_missing.json",
    "doi": "idconv__doi_found_and_missing.json",
}
ESUMMARY_FILES = ("pubmed__esummary_three_pmids.json", "pubmed__esummary_two_pmids_from_links.json")


class World:
    """The recorded APIs, as a door (`public_sources._open_remote`)."""

    def __init__(self, failing=None, edit_esummary=None):
        self.calls = []
        self.failing = failing or {}
        self.edit_esummary = edit_esummary

    def __call__(self, url, accepted, **options):
        self.calls.append(url)
        parts = urllib.parse.urlsplit(url)
        query = urllib.parse.parse_qs(parts.query)
        host = parts.hostname
        if host == "pmc.ncbi.nlm.nih.gov" and "/tools/idconv/" in parts.path:
            return self._answer("idconv", self._idconv(query))
        if host == "eutils.ncbi.nlm.nih.gov" and parts.path.endswith("esummary.fcgi"):
            return self._answer("pubmed", self._esummary(query))
        if host == "www.ebi.ac.uk" and parts.path.endswith("/search"):
            return self._answer("europepmc", self._europe_pmc(query))
        if host == "api.crossref.org" and parts.path.endswith("/works"):
            return self._answer("crossref", self._crossref(query))
        raise AssertionError("the recorded wire has no answer for %s" % url)

    def _answer(self, source, response):
        failure = self.failing.get(source)
        if failure is not None:
            if isinstance(failure, list):
                if failure:
                    raise failure.pop(0)
            else:
                raise failure
        return response

    def _idconv(self, query):
        kind = query["idtype"][0]
        asked = query["ids"][0].split(",")
        name = IDCONV_FILES[kind]
        recorded = wire.json_body(name)
        fold = kind == "doi"
        known = {record["requested-id"].casefold() if fold else record["requested-id"]: record for record in recorded["records"]}
        missing = [value for value in asked if (value.casefold() if fold else value) not in known]
        assert not missing, "the idconv recording %s has no answer for %s" % (name, missing)
        recorded["records"] = [known[value.casefold() if fold else value] for value in asked]
        return wire.derived(recorded)

    def _esummary(self, query):
        asked = query["id"][0].split(",")
        recorded = {}
        for name in ESUMMARY_FILES:
            body = wire.json_body(name)
            recorded.update({uid: body["result"][uid] for uid in body["result"]["uids"]})
        missing = [uid for uid in asked if uid not in recorded]
        assert not missing, "no recorded PubMed answer for %s" % missing
        answer = {"header": {"type": "esummary", "version": "0.3"}, "result": {"uids": list(asked), **{uid: recorded[uid] for uid in asked}}}
        if self.edit_esummary:
            self.edit_esummary(answer)
        return wire.derived(answer)

    def _europe_pmc(self, query):
        table = {
            'DOI:"10.9999/does-not-exist"': "europepmc__search_lite_doi_missing.json",
            "PMCID:PMC9999999999": "europepmc__search_lite_pmcid_missing.json",
        }
        name = table.get(query["query"][0])
        assert name, "no recorded Europe PMC answer for %r" % query["query"][0]
        return wire.ok(name)

    def _crossref(self, query):
        asked = {term.split(":", 1)[1].casefold() for term in query["filter"][0].split(",")}
        recorded = wire.json_body("crossref__works_filter_two_of_three.json")
        held = [record for record in recorded["message"]["items"] if record["DOI"].casefold() in asked]
        recorded["message"]["items"] = held
        recorded["message"]["total-results"] = len(held)
        return wire.derived(recorded)


class Workspace(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.workspace = pathlib.Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)
        environment = mock.patch.dict(os.environ, {"OPEN_SCIENCE_WORKSPACE_DIR": str(self.workspace)})
        environment.start()
        self.addCleanup(environment.stop)
        for name in ("EVIMED_PUBLIC_SOURCE_GATEWAY_URL", "EVIMED_MCP_FIXTURES", "NCBI_API_KEY"):
            os.environ.pop(name, None)
        pace = mock.patch.object(public_sources, "_ncbi_pace")
        pace.start()
        self.addCleanup(pace.stop)
        self.sleeps = []
        sleep = mock.patch.object(source_transport.time, "sleep", side_effect=self.sleeps.append)
        sleep.start()
        self.addCleanup(sleep.stop)

    def resolve(self, identifiers, **world):
        self.world = World(**world)
        with mock.patch.object(public_sources, "_open_remote", self.world):
            return links.resolve({"identifiers": identifiers})


class ParsingTests(unittest.TestCase):
    def test_the_three_kinds_in_the_forms_people_paste_them(self):
        cases = {
            "30221596": ("pmid", "30221596"),
            " PMID: 30221596 ": ("pmid", "30221596"),
            "pmid30221596": ("pmid", "30221596"),
            "https://pubmed.ncbi.nlm.nih.gov/30221596/": ("pmid", "30221596"),
            "PMC6426126": ("pmcid", "PMC6426126"),
            "pmc6426126": ("pmcid", "PMC6426126"),
            "PMCID: PMC6426126": ("pmcid", "PMC6426126"),
            "https://pmc.ncbi.nlm.nih.gov/articles/PMC6426126/": ("pmcid", "PMC6426126"),
            "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6426126.1/": ("pmcid", "PMC6426126"),
            "10.1056/NEJMoa1800722": ("doi", "10.1056/nejmoa1800722"),
            "doi:10.1056/NEJMoa1800722": ("doi", "10.1056/nejmoa1800722"),
            "https://doi.org/10.1056/NEJMoa1800722": ("doi", "10.1056/nejmoa1800722"),
            "10.1056/NEJMoa1800722.": ("doi", "10.1056/nejmoa1800722"),
            "10.1016/S0140-6736(18)31880-4": ("doi", "10.1016/s0140-6736(18)31880-4"),
            "10.1016/S0140-6736(18)31880-4).": ("doi", "10.1016/s0140-6736(18)31880-4"),
        }
        for raw, (kind, value) in cases.items():
            with self.subTest(raw=raw):
                parsed = links.parse_identifier(raw)
                self.assertEqual((parsed["kind"], parsed["value"]), (kind, value))

    def test_a_pmcid_version_is_kept_apart_from_the_identifier(self):
        parsed = links.parse_identifier("PMC6143516.2")
        self.assertEqual((parsed["value"], parsed["requestedVersion"]), ("PMC6143516", 2))

    def test_what_is_not_an_identifier_is_invalid_with_its_reason(self):
        cases = {
            "": "empty", "   ": "empty", "NCT04280705": "not_a_pmid_pmcid_or_doi", "ISBN 978-3-16-148410-0": "not_a_pmid_pmcid_or_doi",
            "1234567890": "not_a_pmid_pmcid_or_doi", "PMC12": "not_a_pmid_pmcid_or_doi", "10.1056/ NEJM": "doi_contains_whitespace",
            "x" * 400: "too_long",
        }
        for raw, reason in cases.items():
            with self.subTest(raw=raw[:30]):
                parsed = links.parse_identifier(raw)
                self.assertEqual((parsed["kind"], parsed["reason"]), ("invalid", reason))
        self.assertEqual(links.parse_identifier(None)["reason"], "empty")


class ResolveTests(Workspace):
    def test_a_pmid_in_pmc_one_only_in_pubmed_and_one_nowhere(self):
        result = self.resolve(["29045601", "30153985", "99999999"])
        data = result["data"]
        in_pmc, pubmed_only = data["items"]
        self.assertEqual(
            (in_pmc["status"], in_pmc["pmid"], in_pmc["pmcid"], in_pmc["doi"], in_pmc["inPmc"]),
            ("resolved", "29045601", "PMC5737441", "10.1093/gbe/evx215", True),
        )
        self.assertEqual(in_pmc["pmcVersions"], [{"id": "PMC5737441.1", "current": True}])
        self.assertEqual(in_pmc["resolvedBy"], ["ncbi-idconv", "pubmed"])
        self.assertIn("Sockeye Salmon", in_pmc["title"])
        # The converter says "Identifier not found in PMC" for a PMID that exists:
        # that is "no PMCID", and PubMed is what says whether the PMID exists.
        self.assertEqual(
            (pubmed_only["status"], pubmed_only["pmcid"], pubmed_only["inPmc"], pubmed_only["resolvedBy"]),
            ("resolved", None, False, ["pubmed"]),
        )
        self.assertEqual(pubmed_only["unresolved"], {"pmcid": "not_in_pmc"})
        self.assertEqual(pubmed_only["doi"], "10.1016/S0140-6736(18)31880-4")
        self.assertIn("TIM-HF2", pubmed_only["title"])
        (nowhere,) = data["unresolved"]
        self.assertEqual((nowhere["input"], nowhere["status"]), ("99999999", "not_found"))
        self.assertEqual(nowhere["notFoundIn"], ["the NCBI ID converter", "PubMed"])
        self.assertEqual(data["summary"], {"requested": 3, "resolved": 2, "conflict": 0, "not_found": 1, "invalid": 0, "unchecked": 0})
        self.assertEqual(data["outcome"]["state"], "complete")
        self.assertEqual(result["status"], "warning")
        self.assertIn("not evidence the paper does not exist", " ".join(result["warnings"]))
        self.assertEqual([source["id"] for source in result["sources"]], ["PMID:29045601", "PMID:30153985"])
        self.assertTrue(all(source["evidenceAccess"] == "bibliographic_only" for source in result["sources"]), "a metadata answer is metadata")

    def test_a_doi_and_a_pmcid_are_each_asked_with_their_own_type(self):
        result = self.resolve(["10.1056/NEJMoa1800722", "PMC6143516", "29045601"])
        by_input = {item["input"]: item for item in result["data"]["items"]}
        self.assertEqual(by_input["10.1056/NEJMoa1800722"]["pmid"], "30221596")
        self.assertEqual(by_input["10.1056/NEJMoa1800722"]["pmcid"], "PMC6426126")
        self.assertEqual(by_input["10.1056/NEJMoa1800722"]["doi"], "10.1056/NEJMoa1800722", "the DOI as the converter registered it")
        self.assertEqual((by_input["PMC6143516"]["pmid"], by_input["PMC6143516"]["doi"]), ("30228269", "10.1038/s41467-018-05727-y"))
        idconv = [urllib.parse.parse_qs(urllib.parse.urlsplit(url).query) for url in self.world.calls if "/tools/idconv/" in url]
        self.assertEqual(sorted(call["idtype"][0] for call in idconv), ["doi", "pmcid", "pmid"])
        for call in idconv:
            kind = call["idtype"][0]
            pattern = {"pmid": "^[0-9]+$", "pmcid": "^PMC[0-9]+$", "doi": "^10[.]"}[kind]
            import re
            self.assertTrue(all(re.match(pattern, value) for value in call["ids"][0].split(",")), "one type per request (the converter refuses a mix)")
            self.assertEqual(call["versions"], ["yes"])
            self.assertEqual(call["tool"], ["evimed_research"])

    def test_a_doi_nobody_holds_is_not_found_in_every_source_asked_and_is_not_an_error(self):
        result = self.resolve(["10.9999/does-not-exist"])
        self.assertEqual(result["data"]["items"], [])
        (missing,) = result["data"]["unresolved"]
        self.assertEqual(missing["status"], "not_found")
        self.assertEqual(missing["notFoundIn"], ["the NCBI ID converter", "Europe PMC", "Crossref"])
        self.assertEqual(result["data"]["outcome"]["state"], "no_results")
        self.assertEqual(result["data"]["outcome"]["reason"], "none_resolved")
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["sources"], [])

    def test_a_pmcid_the_converter_does_not_hold_is_asked_of_europe_pmc(self):
        result = self.resolve(["PMC9999999999"])
        (missing,) = result["data"]["unresolved"]
        self.assertEqual(missing["notFoundIn"], ["the NCBI ID converter", "Europe PMC"])
        self.assertTrue(any("europe" in url or "ebi.ac.uk" in url for url in self.world.calls))

    def test_what_is_not_an_identifier_is_named_invalid_and_never_asked(self):
        result = self.resolve(["29045601", "NCT04280705", "10.1056/ NEJM"])
        data = result["data"]
        self.assertEqual([item["input"] for item in data["items"]], ["29045601"])
        self.assertEqual([(item["input"], item["status"], item["reason"]) for item in data["unresolved"]], [
            ("NCT04280705", "invalid", "not_a_pmid_pmcid_or_doi"), ("10.1056/ NEJM", "invalid", "doi_contains_whitespace"),
        ])
        self.assertEqual(data["summary"]["invalid"], 2)
        self.assertFalse(any("NCT04280705" in url for url in self.world.calls))
        self.assertIn("not a PMID, a PMCID or a DOI", " ".join(result["warnings"]))

    def test_nothing_that_is_an_identifier_is_an_input_error_and_asks_nothing(self):
        with mock.patch.object(public_sources, "_open_remote", World()) as door:
            with self.assertRaises(public_sources.PublicSourceError) as raised:
                links.resolve({"identifiers": ["NCT04280705", ""]})
        self.assertEqual(raised.exception.code, "public_source_identifier_invalid")
        self.assertEqual(door.calls, [])
        for bad in (None, [], "30221596", ["1"] * (links.MAX_IDENTIFIERS + 1)):
            with self.assertRaises(public_sources.PublicSourceError):
                links.resolve({"identifiers": bad})

    def test_the_same_identifier_twice_is_asked_once_and_answered_twice(self):
        result = self.resolve(["29045601", "PMID: 29045601"])
        self.assertEqual([item["input"] for item in result["data"]["items"]], ["29045601", "PMID: 29045601"])
        self.assertEqual(result["data"]["items"][1]["duplicateOf"], 0)
        converter = [url for url in self.world.calls if "/tools/idconv/" in url]
        self.assertEqual(len(converter), 1)
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(converter[0]).query)["ids"], ["29045601"])

    def test_the_article_version_asked_for_is_compared_with_the_current_one(self):
        current = self.resolve(["PMC6143516.1"])["data"]["items"][0]
        self.assertEqual((current["requestedVersion"], current["requestedVersionIsCurrent"]), (1, True))
        later = self.resolve(["PMC6143516.2"])["data"]["items"][0]
        self.assertEqual((later["requestedVersion"], later["requestedVersionIsCurrent"]), (2, False))
        self.assertEqual(later["pmcVersions"], [{"id": "PMC6143516.1", "current": True}])


def five_hundreds(count=3):
    """A source that answers HTTP 500 every time it is asked (a recorded 500, as the gateway relays it)."""
    return [wire.through_gateway("europepmc__fulltextxml_500.json") for _ in range(count)]


class FailureTests(Workspace):
    def test_a_source_that_fails_is_named_and_what_the_others_said_stands(self):
        result = self.resolve(["29045601"], failing={"pubmed": five_hundreds()})
        (item,) = result["data"]["items"]
        self.assertEqual((item["status"], item["pmcid"], item["resolvedBy"]), ("resolved", "PMC5737441", ["ncbi-idconv"]))
        self.assertNotIn("title", item, "PubMed supplies the title and did not answer")
        failed = result["data"]["outcome"]["failed"]
        self.assertEqual([(entry["scope"], entry["state"], entry["reason"]) for entry in failed], [("PubMed", "unavailable", "upstream_error")])
        self.assertEqual(result["data"]["outcome"]["state"], "complete")
        self.assertEqual(result["status"], "warning")
        self.assertIn("PubMed answered with an error", " ".join(result["warnings"]))
        self.assertIn("not evidence that the record does not exist", " ".join(result["next_actions"]))

    def test_nothing_answering_at_all_makes_the_failure_the_whole_result(self):
        # Both sources asked about the only identifier failed: that is not "not found".
        with mock.patch.object(public_sources, "_open_remote", World(failing={"idconv": five_hundreds(), "pubmed": five_hundreds()})):
            with self.assertRaises(source_outcome.SourceError) as raised:
                links.resolve({"identifiers": ["99999999"]})
        self.assertEqual((raised.exception.state, raised.exception.code), ("unavailable", "source_unavailable"))

    def test_a_rate_limit_that_names_its_wait_is_waited_out(self):
        result = self.resolve(["29045601"], failing={"idconv": [wire.through_gateway("idconv__429.html", retry_after=1)]})
        self.assertEqual(result["data"]["items"][0]["pmcid"], "PMC5737441")
        self.assertEqual(self.sleeps, [1.0])
        self.assertNotIn("failed", result["data"]["outcome"], "a failure that was waited out is not reported as one")

    def test_a_rate_limit_that_never_lifts_is_a_failure_after_the_attempts(self):
        # The live converter answered 429 as HTML with no Retry-After on the first
        # request from this box.
        limited = {"idconv": [wire.through_gateway("idconv__429.html") for _ in range(3)], "pubmed": [wire.through_gateway("idconv__429.html") for _ in range(3)]}
        with mock.patch.object(public_sources, "_open_remote", World(failing=limited)):
            with self.assertRaises(source_outcome.SourceError) as raised:
                links.resolve({"identifiers": ["29045601"]})
        self.assertEqual((raised.exception.state, raised.exception.reason), ("unavailable", "rate_limited"))
        self.assertEqual(len(self.sleeps), 2 * (source_transport.ATTEMPTS - 1), "two waits per source, none after the last attempt")

    def test_a_source_that_does_not_answer_in_time_is_a_timeout(self):
        with mock.patch.object(public_sources, "_open_remote", World(failing={"idconv": [TimeoutError("timed out")], "pubmed": [TimeoutError("timed out")]})):
            with self.assertRaises(source_outcome.SourceError) as raised:
                links.resolve({"identifiers": ["29045601"]})
        self.assertEqual((raised.exception.state, raised.exception.code), ("timeout", "source_timeout"))
        self.assertEqual(self.sleeps, [], "a timeout spent the time: it is not retried")

    def test_an_identifier_a_failed_source_was_the_only_one_asked_about_is_unchecked(self):
        # Two identifiers: one the converter answers for, one only PubMed could place,
        # and PubMed fails. The second has no answer from anyone.
        result = self.resolve(["29045601", "30153985"], failing={"pubmed": five_hundreds()})
        by_input = {item["input"]: item for item in result["data"]["items"] + result["data"]["unresolved"]}
        self.assertEqual(by_input["29045601"]["status"], "resolved")
        self.assertEqual(by_input["30153985"]["status"], "unchecked")
        self.assertEqual(by_input["30153985"]["failed"][0]["state"], "unavailable")
        self.assertEqual(result["data"]["summary"]["unchecked"], 1)
        self.assertIn("could not be checked", " ".join(result["warnings"]))


class ConflictAndPreservationTests(Workspace):
    def test_two_sources_that_disagree_make_a_conflict_and_never_a_silent_pick(self):
        def disagree(recorded):
            # Constructed: PubMed's record of 30221596 names another DOI than the converter's.
            for entry in recorded["result"]["30221596"]["articleids"]:
                if entry["idtype"] == "doi":
                    entry["value"] = "10.1056/OTHER1800722"

        result = self.resolve(["10.1056/NEJMoa1800722"], edit_esummary=disagree)
        (item,) = result["data"]["items"]
        self.assertEqual(item["status"], "conflict")
        self.assertEqual(item["conflicts"], [{"field": "doi", "values": {"ncbi-idconv": "10.1056/NEJMoa1800722", "pubmed": "10.1056/OTHER1800722"}}])
        self.assertIn("linked differently", " ".join(result["warnings"]))
        self.assertIn("decide which link is right", " ".join(result["next_actions"]))

    def test_the_answer_is_preserved_by_content_and_a_changed_answer_is_a_new_version_beside_it(self):
        first = self.resolve(["29045601", "30153985"])
        second = self.resolve(["29045601", "30153985"])
        path = first["data"]["preserved"]["path"]
        self.assertEqual(path, second["data"]["preserved"]["path"], "the same answer is the same bytes at the same path")
        self.assertTrue(path.startswith(".evimed-sources/identifiers/"))
        payload = (self.workspace / path).read_bytes()
        self.assertEqual(first["data"]["preserved"]["sha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(first["data"]["artifactSha256s"], {path: hashlib.sha256(payload).hexdigest()})
        self.assertEqual(first["artifacts"], [path])
        stored = json.loads(payload)
        self.assertEqual([item["pmid"] for item in stored["items"]], ["29045601", "30153985"])
        self.assertNotIn("retrievedAt", payload.decode("utf-8"), "a timestamp in the bytes would make every call a new version")

        def retitled(recorded):
            recorded["result"]["29045601"]["title"] = "A corrected title"

        third = self.resolve(["29045601", "30153985"], edit_esummary=retitled)
        changed = third["data"]["preserved"]["path"]
        self.assertNotEqual(changed, path)
        self.assertEqual(changed.rsplit("/", 2)[0], path.rsplit("/", 2)[0], "the same request, a new version")
        self.assertTrue((self.workspace / path).is_file() and (self.workspace / changed).is_file(), "the old version is kept")

    def test_a_workspace_that_cannot_be_written_does_not_stop_the_answer(self):
        os.environ["OPEN_SCIENCE_WORKSPACE_DIR"] = str(self.workspace / "missing")
        result = self.resolve(["29045601"])
        self.assertNotIn("preserved", result["data"])
        self.assertNotIn("artifacts", result)
        self.assertIn("could not be preserved", " ".join(result["warnings"]))
        self.assertEqual(result["data"]["items"][0]["status"], "resolved")


def load_server():
    import importlib.util
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_identifiers", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ThroughTheServerTests(Workspace):
    """The tool as the runtime calls it: the server's ToolResult contract is part of the tool."""

    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def call(self, arguments, **world):
        self.world = World(**world)
        with mock.patch.object(public_sources, "_open_remote", self.world):
            return self.server.call_tool("identifier_resolve", arguments)

    def test_the_tool_is_declared_with_its_bound_and_a_short_description(self):
        tool = self.server.TOOLS["identifier_resolve"]
        self.assertEqual(tool["inputSchema"]["properties"]["identifiers"]["maxItems"], 200)
        self.assertEqual(tool["inputSchema"]["required"], ["identifiers"])
        self.assertFalse(tool["inputSchema"]["additionalProperties"])
        self.assertLess(len(tool["description"]), 600)

    def test_a_partly_resolved_batch_is_a_valid_warning_result(self):
        result = self.call({"identifiers": ["29045601", "30153985", "99999999"]})
        self.assertEqual(result["status"], "warning", result)
        self.assertEqual([item["pmid"] for item in result["data"]["items"]], ["29045601", "30153985"])
        self.assertEqual(result["data"]["provenance"]["tool"], "identifier_resolve")
        self.assertTrue(result["warnings"] and result["next_actions"])
        self.assertEqual([source["id"] for source in result["sources"]], ["PMID:29045601", "PMID:30153985"])
        for source in result["sources"]:
            self.assertEqual(set(source) - {"id", "title", "url", "source", "retrievedAt", "evidenceAccess", "sourceType"}, set())
        self.assertEqual(result["artifacts"], [result["data"]["preserved"]["path"]])

    def test_a_fully_resolved_batch_is_a_success(self):
        result = self.call({"identifiers": ["29045601"]})
        self.assertEqual(result["status"], "success", result)
        self.assertNotIn("warnings", result)

    def test_nothing_resolved_is_a_warning_with_no_sources_and_the_named_outcome(self):
        result = self.call({"identifiers": ["10.9999/does-not-exist"]})
        self.assertEqual(result["status"], "warning", result)
        self.assertEqual(result["data"]["outcome"]["state"], "no_results")
        self.assertEqual(result["data"]["unresolved"][0]["status"], "not_found")

    def test_a_whole_failure_is_an_error_result_in_the_closed_vocabulary(self):
        with mock.patch.object(public_sources, "_open_remote", World(failing={"idconv": five_hundreds(), "pubmed": five_hundreds()})):
            result = self.server.call_tool("identifier_resolve", {"identifiers": ["99999999"]})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "source_unavailable")
        self.assertEqual(set(result["error"]), {"code", "message", "retryable", "stopReason"})
        self.assertIs(result["error"]["retryable"], True)
        self.assertIn("not evidence that the record does not exist", " ".join(result["next_actions"]))
        with mock.patch.object(public_sources, "_open_remote", World(failing={"idconv": [TimeoutError("t")], "pubmed": [TimeoutError("t")]})):
            self.assertEqual(self.server.call_tool("identifier_resolve", {"identifiers": ["29045601"]})["error"]["code"], "source_timeout")

    def test_input_the_run_built_wrongly_is_told_so_and_is_not_an_outage(self):
        result = self.call({"identifiers": ["NCT04280705"]})
        self.assertEqual(result["error"]["code"], "public_source_identifier_invalid")
        self.assertIs(result["error"]["retryable"], False)
        self.assertEqual(result["next_actions"], ["Correct the named field and call again."])
        self.assertEqual(self.world.calls, [])
        too_many = self.call({"identifiers": ["1"] * 201})
        self.assertEqual(too_many["error"]["code"], "invalid_input")


if __name__ == "__main__":
    unittest.main()
