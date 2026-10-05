"""DailyMed labels by version: normalised, preserved, compared, and always the US label.

The documents are real, recorded 2026-10-04: a small OTC SPL (`wire/dailymed__spl_walmart_saline_v2.xml`, version 2),
its real version-1 zip (`wire/dailymed__spl_zip_walmart_saline_v1.zip`, served as DailyMed serves an older version),
the real history and real list pages. The prescription structure the OTC label lacks (active moiety, route, marketing
category with territory) is exercised on a fragment copied from the recorded Tagrisso SPL markup and marked so in
the test; the 514 KB document itself is not stored.
"""

import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from email.message import Message
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import label_snapshots as labels  # noqa: E402
import public_sources  # noqa: E402
import source_outcome  # noqa: E402
import source_transport  # noqa: E402
import wire_fixtures as wire  # noqa: E402

SETID = "06906744-49a5-4bab-8539-af2d235df9e8"
V2 = wire.body("dailymed__spl_walmart_saline_v2.xml")
V1_ZIP = wire.body("dailymed__spl_zip_walmart_saline_v1.zip")


class DailyMed:
    """DailyMed as a door: the recorded documents, history and list pages, and the recorded misses."""

    def __init__(self, current_xml=V2, history="dailymed__history_walmart_saline.json", zip_bytes=V1_ZIP, failing=None):
        self.current_xml, self.history, self.zip_bytes, self.failing = current_xml, history, zip_bytes, failing
        self.calls = []

    def __call__(self, url, accepted, **options):
        self.calls.append(url)
        if self.failing:
            raise self.failing.pop(0)
        parts = urllib.parse.urlsplit(url)
        assert parts.hostname == "dailymed.nlm.nih.gov", url
        query = urllib.parse.parse_qs(parts.query)
        if parts.path.endswith("/spls.json"):
            name = {"1": "dailymed__spls_saline_page1.json", "2": "dailymed__spls_saline_page2.json"}[query.get("page", ["1"])[0]]
            if query["drug_name"][0] == "zzzzqqqq":
                name = "dailymed__spls_no_match.json"
            return wire.ok(name)
        if parts.path.endswith("/history.json"):
            if SETID not in parts.path:
                return wire.ok("dailymed__history_unknown_setid.json")
            return wire.ok(self.history)
        if parts.path.endswith("%s.xml" % SETID):
            # DailyMed's own behaviour, recorded 2026-10-05: an Accept of XML types alone is a 406 (which the gateway
            # relays as its own 400); one that also names application/json is served the document.
            if "application/json" not in accepted:
                raise wire.through_gateway("dailymed__spl_current_xml_accept_406.json")
            return wire.derived(self.current_xml, "application/xml")
        if parts.path.endswith(".xml"):
            raise wire.through_gateway("dailymed__spl_unknown_setid.txt")
        if parts.path.endswith("getFile.cfm"):
            assert query["setid"] == [SETID] and query["type"] == ["zip"], url
            return wire.derived(self.zip_bytes, "application/zip")
        raise AssertionError("no recorded DailyMed answer for %s" % url)


class Workspace(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.workspace = pathlib.Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)
        patch = mock.patch.dict(os.environ, {"OPEN_SCIENCE_WORKSPACE_DIR": str(self.workspace)})
        patch.start()
        self.addCleanup(patch.stop)
        for name in ("EVIMED_PUBLIC_SOURCE_GATEWAY_URL", "EVIMED_MCP_FIXTURES"):
            os.environ.pop(name, None)
        sleep = mock.patch.object(source_transport.time, "sleep")
        sleep.start()
        self.addCleanup(sleep.stop)

    def call(self, arguments, world=None):
        self.world = world or DailyMed()
        with mock.patch.object(public_sources, "_open_remote", self.world), mock.patch.object(public_sources, "_gateway_settings", return_value=None):
            return labels.snapshot(arguments)


class ParseTests(unittest.TestCase):
    def test_the_real_otc_label_is_normalised(self):
        label, sections = labels.parse_spl(V2)
        self.assertEqual((label["setId"], label["version"], label["effectiveDate"]), (SETID, 2, "2025-10-28"))
        self.assertEqual(label["documentType"], {"code": "34390-5", "name": "HUMAN OTC DRUG LABEL"})
        self.assertEqual(label["labeler"], "WALMART STORES INC")
        (product,) = label["products"]
        self.assertEqual((product["name"], product["ndcProduct"], product["form"], product["genericName"]), ("WALMART SALINE", "79903-304", "SPRAY", "saline nasal (sodium chloride)"))
        active = product["activeIngredients"]
        self.assertEqual([(item["name"], item["strength"]["numerator"]) for item in active], [("sodium chloride", {"value": "6.5", "unit": "mg"})])
        self.assertTrue(active[0]["unii"] and len(active[0]["unii"]) == 10, "a UNII is the cross-jurisdiction key for an ingredient")
        self.assertEqual({item["name"] for item in product["inactiveIngredients"]}, {"benzalkonium chloride", "sodium phosphate, dibasic, unspecified form", "sodium phosphate, monobasic, anhydrous", "benzyl alcohol", "water"})
        self.assertEqual(product["ndcPackages"], ["79903-304-30"], "the package NDC extends the product NDC")
        names = [section["name"] for section in sections]
        for expected in ("otc_active_ingredient", "indications_and_usage", "warnings", "dosage_and_administration", "package_label_principal_display_panel"):
            self.assertIn(expected, names)
        self.assertTrue(all(len(section["sha256"]) == 64 for section in sections))

    def test_the_label_states_it_is_united_states_and_why(self):
        label, _ = labels.parse_spl(V2)
        jurisdiction = label["jurisdiction"]
        self.assertEqual((jurisdiction["country"], jurisdiction["authority"]), ("US", "FDA"))
        self.assertEqual(jurisdiction["basis"], "the approval in the document names the territory USA")
        self.assertIn("not the label of China (NMPA)", jurisdiction["note"])
        # A document that names no territory is still US because of where it comes from, and says so.
        bare = labels.jurisdiction_of(set())
        self.assertEqual((bare["country"], bare["authority"]), ("US", "FDA"))
        self.assertIn("DailyMed is the US FDA's labeling repository; the document names no territory", bare["basis"])

    RX_FRAGMENT = b"""<?xml version="1.0" encoding="UTF-8"?>
<document xmlns="urn:hl7-org:v3"><id root="bc71de23-ee63-49b7-8b0e-97e5e8a52d05"/><code code="34391-3" displayName="HUMAN PRESCRIPTION DRUG LABEL"/>
<title>TAGRISSO</title><effectiveTime value="20260914"/><setId root="5e81b4a7-b971-45e1-9c31-29cea8c87ce7"/><versionNumber value="37"/>
<author><assignedEntity><representedOrganization><name>AstraZeneca Pharmaceuticals LP</name></representedOrganization></assignedEntity></author>
<component><structuredBody><component><section><code code="48780-1"/><subject><manufacturedProduct><manufacturedProduct>
<code code="0310-1349" codeSystem="2.16.840.1.113883.6.69"/><name>TAGRISSO</name><formCode code="C42931" displayName="TABLET, FILM COATED"/>
<asEntityWithGeneric><genericMedicine><name>osimertinib</name></genericMedicine></asEntityWithGeneric>
<ingredient classCode="ACTIB"><quantity><numerator unit="mg" value="40"/><denominator unit="1" value="1"/></quantity>
<ingredientSubstance><code code="3C06JJ0Z2O" codeSystem="2.16.840.1.113883.4.9"/><name>OSIMERTINIB</name>
<activeMoiety><activeMoiety><code code="3C06JJ0Z2O" codeSystem="2.16.840.1.113883.4.9"/><name>OSIMERTINIB</name></activeMoiety></activeMoiety></ingredientSubstance></ingredient>
<ingredient classCode="IACT"><ingredientSubstance><code code="3OWL53L36A" codeSystem="2.16.840.1.113883.4.9"/><name>MANNITOL</name></ingredientSubstance></ingredient>
<consumedIn><substanceAdministration><routeCode code="C38288" displayName="ORAL"/></substanceAdministration></consumedIn>
</manufacturedProduct><subjectOf><approval><id extension="NDA208065" root="2.16.840.1.113883.3.150"/><code code="C73594" displayName="NDA"/>
<author><territorialAuthority><territory><code code="USA" codeSystem="2.16.840.1.113883.5.28"/></territory></territorialAuthority></author></approval></subjectOf>
</manufacturedProduct></subject></section></component>
<component><section><code code="34067-9"/><title>1 INDICATIONS AND USAGE</title><text>TAGRISSO is a kinase inhibitor indicated for adjuvant therapy.</text>
<component><section><code code="34067-9"/><title>1.1 Adjuvant Therapy</title><text>Sub-section text.</text></section></component></section></component></structuredBody></component></document>"""

    def test_a_prescription_label_carries_active_moiety_route_and_the_approving_territory(self):
        # Constructed from the markup recorded in the real Tagrisso SPL (version 37) on 2026-10-04.
        label, sections = labels.parse_spl(self.RX_FRAGMENT)
        (product,) = label["products"]
        self.assertEqual(product["routes"], ["ORAL"])
        self.assertEqual(product["activeIngredients"][0], {"name": "osimertinib", "unii": "3C06JJ0Z2O", "activeMoiety": "osimertinib", "activeMoietyUnii": "3C06JJ0Z2O", "strength": {"numerator": {"value": "40", "unit": "mg"}, "denominator": {"value": "1", "unit": "1"}}})
        self.assertEqual(label["marketing"], [{"category": "NDA", "number": "NDA208065", "territory": "USA"}])
        self.assertEqual(label["jurisdiction"]["basis"], "the approval in the document names the territory USA")
        self.assertEqual(label["activeIngredients"], [{"name": "osimertinib", "unii": "3C06JJ0Z2O", "activeMoiety": "osimertinib", "activeMoietyUnii": "3C06JJ0Z2O"}])
        self.assertEqual([(section["name"], section["depth"], section["occurrence"]) for section in sections if section["code"] == "34067-9"], [("indications_and_usage", 0, 1), ("indications_and_usage", 1, 2)])
        self.assertEqual(sections[1]["text"], "TAGRISSO is a kinase inhibitor indicated for adjuvant therapy.", "a section's own text, not its subsections'")

    def test_a_document_naming_another_territory_says_so_and_is_not_called_us(self):
        label, _ = labels.parse_spl(self.RX_FRAGMENT.replace(b'code="USA"', b'code="CHN"'))
        self.assertEqual(label["jurisdiction"]["country"], "CHN")
        self.assertIsNone(label["jurisdiction"]["authority"])
        self.assertIn("not the United States", label["jurisdiction"]["note"])

    def test_what_is_not_an_spl_is_refused(self):
        for payload in (b"not xml", b"<other/>", b"<html><body/></html>"):
            with self.assertRaises(ValueError):
                labels.parse_spl(payload)

    def test_dates_and_jurisdiction_names(self):
        self.assertEqual(labels._published("Sep 25, 2026"), "2026-09-25")
        self.assertEqual(labels._published("sometime"), "sometime")
        self.assertTrue(all(labels.is_us(value) for value in (None, "", "US", "USA", "United States", "FDA", "美国")))
        self.assertFalse(any(labels.is_us(value) for value in ("CN", "China", "NMPA", "EU", "EMA", "Japan", "中国")))


class SearchTests(Workspace):
    def test_a_search_is_a_page_of_a_larger_answer_and_says_how_to_continue(self):
        result = self.call({"drug": "sodium chloride nasal", "limit": 2})
        data = result["data"]
        self.assertEqual([(item["setId"][:8], item["version"], item["publishedDate"]) for item in data["items"]], [("fddba85e", 6, "2026-06-11"), ("06906744", 2, "2025-11-17")])
        self.assertEqual((data["outcome"]["state"], data["outcome"]["returned"], data["outcome"]["total"], data["outcome"]["remaining"]), ("more_available", 2, 4, 2))
        self.assertEqual(data["outcome"]["next"]["arguments"], {"drug": "sodium chloride nasal", "limit": 2, "page": 2})
        self.assertIn("page=2", data["outcome"]["next"]["how"])
        self.assertEqual((data["contentLevel"], data["jurisdiction"]["country"]), ("label_metadata", "US"))
        self.assertTrue(all(item["jurisdiction"] == "US" for item in data["items"]))
        self.assertTrue(all(source["evidenceAccess"] == "bibliographic_only" for source in result["sources"]), "a listing is metadata, not the label")
        self.assertIn("United States labels only", " ".join(result["warnings"]))

    def test_the_last_page_is_complete_and_no_match_is_no_results(self):
        last = self.call({"drug": "sodium chloride nasal", "limit": 2, "page": 2})
        self.assertEqual((last["data"]["outcome"]["state"], last["data"]["outcome"]["total"]), ("complete", 4))
        none = self.call({"drug": "zzzzqqqq"})
        self.assertEqual((none["data"]["outcome"]["state"], none["data"]["outcome"]["reason"], none["data"]["items"]), ("no_results", "no_match", []))
        self.assertIn("not evidence that the drug has no label", " ".join(none["warnings"]))
        self.assertNotIn("sources", none)


class ReadTests(Workspace):
    def test_the_current_label_is_preserved_by_version_and_quotable(self):
        result = self.call({"setid": SETID})
        self.assertEqual(result["status"], "success", result)
        data = result["data"]
        self.assertEqual((data["version"], data["currentVersion"], data["isCurrent"], data["publishedDate"], data["effectiveDate"]), (2, 2, True, "2025-11-17", "2025-10-28"))
        self.assertEqual((data["contentLevel"], data["jurisdiction"]["country"], data["jurisdiction"]["authority"]), ("regulatory_label_full_text", "US", "FDA"))
        self.assertIn("United States (FDA) label", result["summary"])
        self.assertEqual([row["version"] for row in data["versions"]], [2, 1])
        text = (self.workspace / data["markdownPath"]).read_text(encoding="utf-8")
        self.assertIn("- Jurisdiction: US (FDA)", text)
        self.assertIn("<!-- LOINC 34067-9 -->", text)
        self.assertEqual((self.workspace / data["xmlPath"]).read_bytes(), V2, "the SPL exactly as DailyMed serves it")
        label = json.loads((self.workspace / data["labelPath"]).read_text(encoding="utf-8"))
        self.assertEqual((label["version"], label["publishedDate"], label["activeIngredients"][0]["name"]), (2, "2025-11-17", "sodium chloride"))
        self.assertEqual(result["sources"][0]["evidenceAccess"], "regulatory_record")
        self.assertIn("say it is the United States (FDA) label", result["next_actions"][0])
        for name, path in {"markdownPath": data["markdownPath"], "xmlPath": data["xmlPath"], "labelPath": data["labelPath"]}.items():
            self.assertIn(path, result["artifacts"], name)
            self.assertIn(path, data["artifactSha256s"])

    def test_an_older_version_comes_from_the_zip_and_is_labelled_not_current(self):
        result = self.call({"setid": SETID, "version": 1})
        data = result["data"]
        self.assertEqual((data["version"], data["isCurrent"], data["publishedDate"], data["effectiveDate"]), (1, False, "2024-10-17", "2024-10-15"))
        self.assertNotEqual(data["publishedDate"], data["effectiveDate"], "published_date is when DailyMed published it, effectiveTime is the label's own date")
        self.assertEqual(data["imagesOmitted"], 1, "the zip's label image is not kept; the SPL is")
        self.assertEqual(result["status"], "warning")
        self.assertIn("not the current label (current is version 2)", " ".join(result["warnings"]))
        self.assertIn("older label", result["summary"])
        zip_call = [url for url in self.world.calls if "getFile.cfm" in url]
        self.assertEqual(len(zip_call), 1)
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(zip_call[0]).query), {"setid": [SETID], "type": ["zip"], "version": ["1"]})
        label = json.loads((self.workspace / data["labelPath"]).read_text(encoding="utf-8"))
        self.assertEqual(label["version"], 1)
        self.assertEqual(self.world.calls.count("https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/%s.xml" % SETID), 0, "the current document is not what an older version is read from")

    def test_each_version_is_its_own_capture_and_comparison_lists_what_changed_by_kind(self):
        self.call({"setid": SETID, "version": 1})
        result = self.call({"setid": SETID})
        data = result["data"]
        self.assertEqual(data["heldVersions"], [1, 2])
        comparison = data["comparison"]
        self.assertEqual((comparison["againstVersion"], comparison["againstEffectiveDate"], comparison["againstPublishedDate"]), (1, "2024-10-15", "2024-10-17"))
        self.assertTrue(set(comparison["counts"]) <= set(labels.LABEL_CHANGE_KINDS))
        self.assertEqual(sum(comparison["counts"].values()), len(comparison["changes"]))
        self.assertFalse(comparison["unchanged"], "version 2 differs from version 1 in at least its effective date's sections or products")
        old = (self.workspace / comparison["againstPath"]).read_text(encoding="utf-8")
        self.assertIn("SPL version: 1", old)
        # Both versions are on disk beside each other.
        directories = sorted(path.name for path in (self.workspace / ".evimed-sources/dailymed" / SETID).iterdir())
        self.assertEqual(len(directories), 2)

    def test_compare_version_fetches_and_preserves_the_other_version_when_it_is_not_held(self):
        result = self.call({"setid": SETID, "compareVersion": 1})
        self.assertEqual(result["data"]["comparison"]["againstVersion"], 1)
        self.assertEqual(result["data"]["heldVersions"], [1, 2])

    def test_the_same_version_again_is_the_same_capture(self):
        first = self.call({"setid": SETID})
        again = self.call({"setid": SETID})
        self.assertEqual(first["artifacts"], again["artifacts"])
        self.assertFalse(again["data"]["thisVersionIsNew"])
        self.assertNotIn("comparison", again["data"])
        self.assertNotIn("retrievedAt", (self.workspace / first["data"]["labelPath"]).read_text(encoding="utf-8"))

    def test_reading_the_current_label_asks_for_the_document_in_a_way_dailymed_serves(self):
        # Production, 2026-10-05: {"setid": ..., "compareVersion": N} with no version reads the CURRENT label, whose
        # document endpoint answered 406 to Accept: application/xml and so failed "(HTTP 400)"; an explicit older
        # version came from the zip and worked. The same read, with an older version to compare with.
        result = self.call({"setid": SETID, "compareVersion": 1})
        self.assertEqual(result["status"], "success")
        self.assertEqual((result["data"]["version"], result["data"]["isCurrent"]), (2, True))
        self.assertEqual(result["data"]["comparison"]["againstVersion"], 1)
        self.assertTrue(any(call.endswith("%s.xml" % SETID) for call in self.world.calls))

    def test_a_document_the_source_answers_406_to_is_the_sources_refusal_and_says_so(self):
        # The tool as it used to ask, replayed: DailyMed's recorded 406 relayed through the gateway as its 400.
        class AsksForXmlOnly(DailyMed):
            def __call__(self, url, accepted, **options):
                if urllib.parse.urlsplit(url).path.endswith("%s.xml" % SETID):
                    self.calls.append(url)
                    raise wire.through_gateway("dailymed__spl_current_xml_accept_406.json")
                return super().__call__(url, accepted, **options)

        self.assertEqual(wire.through_gateway("dailymed__spl_current_xml_accept_406.json").code, 400)
        with self.assertRaises(source_outcome.SourceError) as raised:
            self.call({"setid": SETID}, AsksForXmlOnly())
        error = raised.exception
        self.assertEqual((error.state, error.reason, error.code), ("unavailable", "request_rejected", "source_unavailable"))
        self.assertIn("DailyMed itself rejected this request (HTTP 406)", str(error))
        self.assertNotIn("invalid", str(error))
        self.assertIn("rather than saying the record is missing", " ".join(error.next_actions()))

    def test_a_request_the_gateway_refused_is_not_reported_as_the_sources(self):
        envelope = {"error": {"code": "public_source_gateway_field_invalid", "message": "A download request names a known kind and exactly its identifiers."}}
        headers = Message()
        headers["Content-Type"] = "application/json"
        refused = urllib.error.HTTPError("https://gateway.invalid/", 400, "error", headers, io.BytesIO(json.dumps(envelope).encode()))
        # The history is the first thing asked; the gateway's refusal of it is the deployment's.
        with self.assertRaises(source_outcome.SourceError) as raised:
            self.call({"setid": SETID, "version": 1}, DailyMed(failing=[refused]))
        error = raised.exception
        self.assertEqual((error.state, error.reason), ("unavailable", "gateway_refused"))
        self.assertIn("EviMed's own gateway refused this request before it reached DailyMed", str(error))
        self.assertNotIn("DailyMed rejected", str(error))
        self.assertIn("fault on the EviMed side", " ".join(error.next_actions()))

    def test_a_version_that_was_never_published_is_named_with_the_ones_that_were(self):
        # Recorded: the Tagrisso history has no version 34.
        result = self.call({"setid": SETID, "version": 7})
        self.assertEqual((result["data"]["outcome"]["state"], result["data"]["outcome"]["reason"]), ("no_results", "version_not_published"))
        self.assertEqual([row["version"] for row in result["data"]["versions"]], [2, 1])
        self.assertEqual(result["data"]["currentVersion"], 2)
        self.assertEqual(result["status"], "warning")
        self.assertNotIn("sources", result)
        self.assertFalse([url for url in self.world.calls if "getFile" in url or url.endswith(".xml")], "nothing was downloaded for a version that does not exist")

    def test_an_unknown_setid_is_no_results_not_an_error(self):
        # Recorded: history.json answers HTTP 200 with an empty history.
        result = self.call({"setid": "00000000-0000-0000-0000-000000000000"})
        self.assertEqual((result["status"], result["data"]["outcome"]["reason"]), ("warning", "setid_not_found"))
        self.assertIn("not evidence that the label does not exist elsewhere", " ".join(result["warnings"]))

    def test_a_document_that_is_not_the_one_asked_for_is_refused(self):
        wrong = V2.replace(b'<versionNumber value="2"/>', b'<versionNumber value="9"/>')
        with self.assertRaises(source_outcome.SourceError) as raised:
            self.call({"setid": SETID}, DailyMed(current_xml=wrong))
        self.assertEqual((raised.exception.state, raised.exception.reason), ("unavailable", "identity_mismatch"))
        with self.assertRaises(source_outcome.SourceError) as raised:
            self.call({"setid": SETID}, DailyMed(current_xml=b"<html>login</html>"))
        self.assertEqual(raised.exception.reason, "invalid_response")
        self.assertFalse((self.workspace / ".evimed-sources").exists())

    def test_an_archive_cut_short_is_a_named_failure_and_nothing_is_preserved_from_it(self):
        cut = V1_ZIP[:len(V1_ZIP) // 3]

        class Cut(DailyMed):
            def __call__(self, url, accepted, **options):
                if "getFile" in url:
                    response = wire.derived(cut, "application/zip")
                    response.headers.replace_header("Content-Length", str(len(V1_ZIP)))
                    return response
                return super().__call__(url, accepted, **options)

        with self.assertRaises(source_outcome.SourceError) as raised:
            self.call({"setid": SETID, "version": 1}, Cut())
        self.assertEqual((raised.exception.state, raised.exception.reason), ("unavailable", "connection_closed_early"))
        self.assertIn("stopped arriving after %d bytes" % len(cut), str(raised.exception))
        self.assertFalse((self.workspace / ".evimed-sources").exists())

    def test_the_whole_label_is_preserved_when_intake_is_asked_for_and_never_fails_it(self):
        with mock.patch.object(labels.source_intake, "hand_off", return_value={"available": False, "reason": "no_gateway", "how": "Source intake is offered through the platform gateway."}) as hand_off:
            result = self.call({"setid": SETID, "intake": True})
        self.assertEqual(hand_off.call_args.args[0], "dailymed-%s-v2" % SETID)
        self.assertEqual(hand_off.call_args.args[1], [result["data"]["markdownPath"]])
        self.assertEqual(result["status"], "warning")
        self.assertTrue((self.workspace / result["data"]["markdownPath"]).is_file())


class JurisdictionTests(Workspace):
    def test_another_jurisdiction_is_refused_and_never_answered_with_the_us_label(self):
        for jurisdiction in ("CN", "China", "NMPA", "EU", "Japan"):
            with self.subTest(jurisdiction=jurisdiction):
                world = DailyMed()
                result = self.call({"drug": "osimertinib", "jurisdiction": jurisdiction}, world)
                self.assertEqual(world.calls, [], "nothing was asked of DailyMed")
                self.assertEqual((result["status"], result["data"]["items"], result["data"]["outcome"]["reason"]), ("warning", [], "jurisdiction_not_covered"))
                self.assertEqual(result["data"]["availableJurisdiction"], "United States (FDA)")
                self.assertIn("The US label was not substituted", " ".join(result["warnings"]))
                self.assertIn("drug_label_search", " ".join(result["next_actions"]))
                self.assertNotIn("sources", result)

    def test_the_us_may_be_named_in_any_of_its_forms(self):
        for jurisdiction in ("US", "usa", "United States", "FDA", "美国"):
            self.assertEqual(self.call({"drug": "sodium chloride nasal", "limit": 2, "jurisdiction": jurisdiction})["data"]["jurisdiction"]["country"], "US")


class InputTests(Workspace):
    def test_search_xor_read_and_a_well_formed_setid(self):
        world = DailyMed()
        with mock.patch.object(public_sources, "_open_remote", world):
            for bad in ({}, {"drug": "x", "setid": SETID}, {"setid": "not-a-uuid"}, {"drug": "x", "version": 2}, {"drug": "x", "compareVersion": 1}):
                with self.subTest(arguments=bad):
                    with self.assertRaises(public_sources.PublicSourceError) as raised:
                        labels.snapshot(bad)
                    self.assertEqual(raised.exception.code, "public_source_label_invalid")
        self.assertEqual(world.calls, [])


class FailureTests(Workspace):
    def test_the_three_failures_are_named_for_a_label_read(self):
        from test_trial_snapshots import wire as _wire  # noqa: F401 - the recorded 500
        five_hundreds = [wire.through_gateway("europepmc__fulltextxml_500.json") for _ in range(3)]
        for failing, state, code in ((five_hundreds, "unavailable", "source_unavailable"), ([TimeoutError("t")], "timeout", "source_timeout"), ([wire.through_gateway("idconv__429.html")] * 3, "unavailable", "source_unavailable")):
            with self.assertRaises(source_outcome.SourceError) as raised:
                self.call({"setid": SETID}, DailyMed(failing=list(failing)))
            self.assertEqual((raised.exception.state, raised.exception.code), (state, code))


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_label_snapshots", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ThroughTheServerTests(Workspace):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def call_tool(self, arguments, world=None):
        with mock.patch.object(public_sources, "_open_remote", world or DailyMed()), mock.patch.object(public_sources, "_gateway_settings", return_value=None):
            return self.server.call_tool("dailymed_label", arguments)

    def test_every_result_shape_passes_the_servers_tool_result_contract(self):
        for arguments in ({"drug": "sodium chloride nasal", "limit": 2}, {"drug": "zzzzqqqq"}, {"setid": SETID}, {"setid": SETID, "version": 1},
                          {"setid": SETID, "version": 7}, {"setid": "00000000-0000-0000-0000-000000000000"}, {"drug": "osimertinib", "jurisdiction": "CN"}):
            with self.subTest(arguments=arguments):
                result = self.call_tool(arguments)
                self.assertIn(result["status"], ("success", "warning"), result)
                self.assertEqual(result["data"]["provenance"]["tool"], "dailymed_label")

    def test_the_label_source_is_typed_a_label_and_its_files_are_named_by_digest(self):
        result = self.call_tool({"setid": SETID})
        self.assertEqual(result["sources"][0]["sourceType"], "label")
        self.assertEqual(set(result["artifacts"]) - set(result["data"]["artifactSha256s"]), set())

    def test_bad_input_and_failures_reach_the_run_in_the_closed_vocabulary(self):
        self.assertEqual(self.call_tool({"setid": "nope"})["error"]["code"], "invalid_input")
        self.assertEqual(self.call_tool({})["error"]["code"], "public_source_label_invalid")
        self.assertIs(self.call_tool({})["error"]["retryable"], False)
        result = self.call_tool({"setid": SETID}, DailyMed(failing=[TimeoutError("t")]))
        self.assertEqual((result["status"], result["error"]["code"]), ("error", "source_timeout"))

    def test_locate_quote_finds_the_label_by_its_setid(self):
        self.call_tool({"setid": SETID})
        found = self.server.call_tool("locate_quote", {"sourceId": SETID, "quote": "Jurisdiction: US (FDA)"})
        self.assertEqual(found["status"], "success", found)


if __name__ == "__main__":
    unittest.main()
