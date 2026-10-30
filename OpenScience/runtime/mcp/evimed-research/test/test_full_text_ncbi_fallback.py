"""`open_access_full_text` when Europe PMC cannot answer: NCBI PMC serves the same open-access JATS (2026-10-28).

A 34-minute clinical review met Europe PMC answering HTTP 503 for the whole window, so every paper was read from its
abstract. The tool now asks NCBI (E-utilities `efetch db=pmc`) when Europe PMC is *unavailable* — an error status or no
answer in time — and never when it *refused* (not open access) or holds no record.

The NCBI shapes here were checked against the live E-utilities on 2026-10-28: `efetch` answers `text/xml` and HTTP 200
whatever it holds (an `<error>` element for a PMCID it lacks), its article is the same JATS Europe PMC serves wrapped in a
`pmc-articleset`, and `esummary db=pubmed` lists `articleids` with the PMC id under `idtype: pmc`. PMC's own `[doi]`
search is no field, so a DOI is resolved through PubMed (see `_ncbi_resolve`).
"""

import json
import os
import pathlib
import sys
import unittest
import urllib.parse
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import open_access_fulltext as fulltext  # noqa: E402
import source_outcome  # noqa: E402
import source_transport as transport  # noqa: E402
import wire_fixtures as wire  # noqa: E402
from test_full_text_versions import PMCID, Workspace  # noqa: E402

RECORDED = wire.body("europepmc__fulltext_PMC6454835.xml")
ARTICLE = RECORDED[RECORDED.index(b"<article"):].strip()
PROLOG = b'<?xml version="1.0"  ?><!DOCTYPE pmc-articleset PUBLIC "-//NLM//DTD ARTICLE SET 2.0//EN" "https://dtd.nlm.nih.gov/ncbi/pmc/articleset/nlm-articleset-2.0.dtd"><pmc-articleset>'
NCBI_XML = PROLOG + ARTICLE + b"</pmc-articleset>"
NO_BODY_XML = PROLOG + (
    b'<article article-type="research-article"><front><article-meta><article-id pub-id-type="pmcid">PMC6454835</article-id>'
    b"<title-group><article-title>Restricted</article-title></title-group><abstract><p>Only the abstract.</p></abstract></article-meta></front></article>"
) + b"</pmc-articleset>"
NOT_HELD_XML = PROLOG + b'<error id="99999999999">The following PMCID is not available: 99999999999</error></pmc-articleset>'
DOI = "10.3389/fphys.2018.01776"


def europe_down(reason="upstream_error", *, timeout=False):
    """What `_request_bytes` raises when Europe PMC answers an error status (or does not answer in time)."""
    if timeout:
        error = source_outcome.timed_out("Europe PMC did not answer within 60 s.", scope="Europe PMC", reason=reason, retryable=True)
    else:
        error = source_outcome.unavailable("Europe PMC answered with an error (HTTP 503).", scope="Europe PMC", reason=reason, retryable=True)
    return fulltext.FullTextError(error.code, str(error), True, source_error=error)


def ncbi_down():
    error = source_outcome.unavailable("NCBI PMC answered with an error (HTTP 503).", scope="NCBI PMC", reason="upstream_error", retryable=True)
    return fulltext.FullTextError(error.code, str(error), True, source_error=error)


def esummary(pmid, doi, pmc, title="Aging and Comorbidities in Acute Pancreatitis II.", pubtype=("Journal Article", "Review")):
    ids = [{"idtype": "pubmed", "idtypen": 1, "value": pmid}]
    if pmc:
        ids += [{"idtype": "pmc", "idtypen": 8, "value": pmc}, {"idtype": "pmcid", "idtypen": 5, "value": "pmc-id: %s;" % pmc}]
    if doi:
        ids.append({"idtype": "doi", "idtypen": 3, "value": doi})
    return {"uid": pmid, "title": title, "pubtype": list(pubtype), "articleids": ids}


def summary_payload(*records):
    return {"header": {"type": "esummary", "version": "0.3"}, "result": {"uids": [r["uid"] for r in records], **{r["uid"]: r for r in records}}}


class Network:
    """Europe PMC and NCBI as two answers apiece (bytes, JSON), told apart by the host of the URL asked."""

    def __init__(self, test, *, europe_bytes=None, ncbi_bytes=None, europe_json=None, ncbi_json=None):
        self.asked = []
        self.answers = {("bytes", "europe"): europe_bytes, ("bytes", "ncbi"): ncbi_bytes, ("json", "europe"): europe_json, ("json", "ncbi"): ncbi_json}
        for name, kind in (("_request_bytes", "bytes"), ("_request_json", "json")):
            patch = mock.patch.object(fulltext, name, side_effect=self.route(kind))
            patch.start()
            test.addCleanup(patch.stop)

    def route(self, kind):
        def handle(url, *args, **kwargs):
            side = "ncbi" if "eutils.ncbi.nlm.nih.gov" in url else "europe"
            self.asked.append((kind, side, url))
            answer = self.answers[(kind, side)]
            if answer is None:
                raise AssertionError("unexpected %s request to %s: %s" % (kind, side, url))
            value = answer(url) if callable(answer) else answer
            if isinstance(value, BaseException):
                raise value
            return value
        return handle

    def urls(self, kind, side):
        return [url for k, s, url in self.asked if (k, s) == (kind, side)]


def query_of(url):
    return urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)


class NcbiServesWhenEuropePmcCannot(Workspace):
    def read(self, result, key="markdownPath"):
        return (self.workspace / result["data"][key]).read_text(encoding="utf-8")

    def test_a_503_on_the_full_text_is_answered_by_ncbi_and_the_result_says_so(self):
        network = Network(self, europe_bytes=europe_down(), ncbi_bytes=NCBI_XML, europe_json=europe_down())
        result = fulltext.fetch({"identifier": PMCID})
        self.assertEqual(result["status"], "success", result)
        data = result["data"]
        self.assertEqual((data["route"], data["contentLevel"]), ("ncbi-pmc-xml", "full_text_xml"))
        # Europe PMC was tried first, and NCBI asked for exactly this article as JATS.
        self.assertEqual(len(network.urls("bytes", "europe")), 1)
        (efetch,) = network.urls("bytes", "ncbi")
        self.assertIn("/efetch.fcgi?", efetch)
        self.assertEqual({key: value[0] for key, value in query_of(efetch).items() if key in ("db", "id", "retmode", "tool")}, {"db": "pmc", "id": "6454835", "retmode": "xml", "tool": "evimed_research"})
        # Provenance: NCBI's page is the primary source everywhere the text names one.
        primary = "https://pmc.ncbi.nlm.nih.gov/articles/%s/" % PMCID
        self.assertEqual((result["sources"][0]["url"], result["sources"][0]["source"], result["sources"][0]["evidenceAccess"]), (primary, "ncbi-pmc-fulltext", "full_text"))
        text = self.read(result)
        self.assertIn("- Primary source: %s" % primary, text)
        self.assertNotIn("europepmc.org", text)
        sidecar = json.loads((self.workspace / pathlib.Path(data["markdownPath"]).parent / "source.json").read_text(encoding="utf-8"))
        self.assertEqual((sidecar["url"], sidecar["route"]), (primary, "ncbi-pmc-xml"))
        # What the article says of itself is read from NCBI's JATS the same way.
        self.assertEqual(data["version"]["pmcVersion"], "PMC6454835.1")
        self.assertEqual(data["fallbackFrom"]["route"], "europe-pmc-xml")
        self.assertEqual((data["fallbackFrom"]["state"], data["fallbackFrom"]["reason"]), ("unavailable", "upstream_error"))
        self.assertIn("Europe PMC was unavailable (upstream error)", result["summary"])
        self.assertIn("NCBI PMC served the complete open-access article", result["summary"])
        # The bytes preserved are the ones NCBI sent, and the quote check can read them.
        self.assertEqual((self.workspace / data["xmlPath"]).read_bytes(), NCBI_XML)
        self.assertEqual(data["artifactSha256s"][data["markdownPath"]], __import__("hashlib").sha256(text.encode("utf-8")).hexdigest())

    def test_no_answer_in_time_is_a_reason_too(self):
        network = Network(self, europe_bytes=europe_down("no_answer_in_time", timeout=True), ncbi_bytes=NCBI_XML)
        result = fulltext.fetch({"identifier": PMCID})
        self.assertEqual((result["status"], result["data"]["route"]), ("success", "ncbi-pmc-xml"), result)
        self.assertEqual(result["data"]["fallbackFrom"]["state"], "timeout")
        self.assertEqual(len(network.urls("bytes", "ncbi")), 1)

    def test_a_capture_europe_pmc_served_keeps_its_own_route_and_bytes(self):
        Network(self, europe_bytes=NCBI_XML.replace(PROLOG, b"").replace(b"</pmc-articleset>", b""))
        result = fulltext.fetch({"identifier": PMCID})
        self.assertEqual((result["data"]["route"], result["sources"][0]["source"]), ("europe-pmc-xml", "europe-pmc-fulltext"))
        self.assertNotIn("fallbackFrom", result["data"])
        self.assertEqual(result["sources"][0]["url"], "https://europepmc.org/articles/%s" % PMCID)
        sidecar = json.loads((self.workspace / pathlib.Path(result["data"]["markdownPath"]).parent / "source.json").read_text(encoding="utf-8"))
        self.assertNotIn("route", sidecar)

    def test_a_pmid_europe_pmc_cannot_look_up_is_resolved_by_ncbi_and_europe_pmc_is_not_asked_again(self):
        network = Network(
            self, europe_json=lambda url: europe_down(), ncbi_bytes=NCBI_XML,
            ncbi_json=lambda url: summary_payload(esummary("31001148", DOI, PMCID)),
        )
        result = fulltext.fetch({"identifier": "PMID: 31001148"})
        self.assertEqual(result["status"], "success", result)
        self.assertEqual(result["data"]["route"], "ncbi-pmc-xml")
        (lookup,) = network.urls("json", "ncbi")
        self.assertIn("/esummary.fcgi?", lookup)
        self.assertEqual((query_of(lookup)["db"], query_of(lookup)["id"], query_of(lookup)["retmode"]), (["pubmed"], ["31001148"], ["json"]))
        self.assertEqual(network.urls("bytes", "europe"), [], "Europe PMC had just failed: its full text is not asked for")
        self.assertIn("efetch.fcgi", network.urls("bytes", "ncbi")[0])
        # NCBI's record supplies what Europe PMC's would have: the publication types in the capture's source.json.
        sidecar = json.loads((self.workspace / pathlib.Path(result["data"]["markdownPath"]).parent / "source.json").read_text(encoding="utf-8"))
        self.assertEqual(sidecar["publicationTypes"], ["Journal Article", "Review"])

    def test_a_doi_is_resolved_through_pubmed_and_a_record_for_another_doi_is_not_taken(self):
        def ncbi_json(url):
            if "esearch.fcgi" in url:
                self.assertEqual((query_of(url)["db"], query_of(url)["term"]), (["pubmed"], ['"%s"[doi]' % DOI]))
                return {"esearchresult": {"count": "2", "idlist": ["11111111", "31001148"]}}
            self.assertEqual(query_of(url)["id"], ["11111111,31001148"])
            return summary_payload(esummary("11111111", "10.9999/other", "PMC1111111"), esummary("31001148", DOI.upper(), PMCID))

        network = Network(self, europe_json=lambda url: europe_down(), ncbi_bytes=NCBI_XML, ncbi_json=ncbi_json)
        result = fulltext.fetch({"identifier": "https://doi.org/" + DOI})
        self.assertEqual((result["status"], result["data"]["route"], result["data"]["pmcid"]), ("success", "ncbi-pmc-xml", PMCID), result)
        self.assertEqual(len(network.urls("json", "ncbi")), 2)
        self.assertEqual(query_of(network.urls("bytes", "ncbi")[0])["id"], ["6454835"], "the PMC article of the matching DOI, not the first hit")

    def test_a_doi_with_parentheses_reaches_pubmed_quoted(self):
        # PubMed reads an unquoted ( ) : ; as query syntax, and the DOIs of older journals carry all of them.
        awkward = "10.1002/(SICI)1097-0258(19980430)17:8<873::AID-SIM779>3.0.CO;2-I"
        asked = []

        def ncbi_json(url):
            if "esearch.fcgi" in url:
                asked.append(query_of(url)["term"][0])
                return {"esearchresult": {"count": "1", "idlist": ["9595617"]}}
            return summary_payload(esummary("9595617", awkward, ""))

        Network(self, europe_json=lambda url: europe_down(), ncbi_json=ncbi_json)
        sentinel = {"status": "success", "data": {}, "sources": [], "artifacts": []}
        with mock.patch.object(fulltext, "_fetch_open_access_pdf", return_value=sentinel):
            fulltext.fetch({"identifier": awkward})
        self.assertEqual(asked, ['"%s"[doi]' % awkward])
        self.assertEqual(fulltext._doi_term('10.1/a"b'), '"10.1/ab"[doi]')

    def test_a_doi_pubmed_does_not_hold_goes_on_to_the_pdf_route_with_that_doi(self):
        Network(self, europe_json=lambda url: europe_down(), ncbi_json=lambda url: {"esearchresult": {"count": "0", "idlist": []}})
        sentinel = {"status": "success", "data": {}, "sources": [], "artifacts": []}
        with mock.patch.object(fulltext, "_fetch_open_access_pdf", return_value=sentinel) as pdf_route:
            result = fulltext.fetch({"identifier": DOI})
        self.assertIs(result, sentinel)
        self.assertEqual(pdf_route.call_args.args[0]["doi"], DOI)

    def test_a_pmid_with_no_pmc_copy_and_no_doi_is_not_available(self):
        Network(self, europe_json=lambda url: europe_down(), ncbi_json=lambda url: summary_payload(esummary("31001148", "", "")))
        result = fulltext.fetch({"identifier": "31001148"})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "full_text_not_available")

    def test_a_pmid_ncbi_has_no_record_of_is_not_available(self):
        Network(self, europe_json=lambda url: europe_down(), ncbi_json=lambda url: {"result": {"uids": [], "99999999": {"uid": "99999999", "error": "cannot get document summary"}}})
        result = fulltext.fetch({"identifier": "99999999"})
        self.assertEqual((result["status"], result["error"]["code"]), ("error", "full_text_not_available"))


class BothRoutesFail(Workspace):
    def test_an_article_ncbi_lists_without_its_text_is_not_available_and_not_retryable(self):
        with self.assertRaises(fulltext.FullTextError) as raised:
            Network(self, ncbi_bytes=NO_BODY_XML)
            fulltext._ncbi_full_text(PMCID, transport.Deadline(60))
        error = raised.exception
        self.assertEqual((error.code, error.retryable, error.source_error.state, error.source_error.reason), ("source_access_denied", False, "denied", "not_open_access"))
        self.assertIn("without its text", str(error))

    def test_a_pmcid_ncbi_does_not_hold_is_not_available(self):
        Network(self, ncbi_bytes=NOT_HELD_XML)
        with self.assertRaises(fulltext.FullTextError) as raised:
            fulltext._ncbi_full_text("PMC99999999999", transport.Deadline(60))
        self.assertEqual((raised.exception.code, raised.exception.retryable), ("full_text_not_available", False))
        self.assertIn("The following PMCID is not available", str(raised.exception))

    def test_both_failing_says_both_and_keeps_the_europe_pmc_code_when_ncbi_could_not_answer_either(self):
        Network(self, europe_bytes=europe_down(), ncbi_bytes=ncbi_down(), europe_json=europe_down())
        result = fulltext.fetch({"identifier": PMCID})
        self.assertEqual(result["status"], "error")
        error = result["error"]
        self.assertEqual((error["code"], error["retryable"]), ("source_unavailable", True))
        self.assertIn("Europe PMC answered with an error (HTTP 503)", error["message"])
        self.assertIn("NCBI PMC was asked next and did not serve it either", error["message"])
        self.assertIn("NCBI PMC answered with an error (HTTP 503)", error["message"])
        self.assertTrue(any("Retry" in action for action in result["next_actions"]))

    def test_europe_pmc_down_and_ncbi_saying_not_open_access_is_a_final_answer_not_a_reason_to_retry(self):
        # NCBI answered: the article is listed without its text. Europe PMC coming back cannot change that, and the error
        # used to carry Europe PMC's retry hint all the same (review of 2026-10-28).
        Network(self, europe_bytes=europe_down(), ncbi_bytes=NO_BODY_XML, europe_json=europe_down())
        result = fulltext.fetch({"identifier": PMCID})
        self.assertEqual(result["status"], "error")
        error = result["error"]
        self.assertEqual((error["code"], error["retryable"]), ("source_access_denied", False))
        self.assertIn("Europe PMC answered with an error (HTTP 503)", error["message"])
        self.assertIn("NCBI PMC was asked next and did not serve it either", error["message"])
        self.assertIn("without its text", error["message"])
        self.assertIn("retrying cannot change the result", error["stopReason"])
        self.assertTrue(any(action.startswith("Do not retry") for action in result["next_actions"]), result["next_actions"])
        self.assertFalse(any("Retry" in action for action in result["next_actions"]), result["next_actions"])

    def test_a_record_ncbi_does_not_hold_is_final_too(self):
        combined = fulltext._both_failed(europe_down(), fulltext.FullTextError("full_text_not_available", "NCBI PMC holds no article PMC1.", False))
        self.assertEqual((combined.code, combined.retryable), ("full_text_not_available", False))
        self.assertTrue(combined.also_tried_ncbi)
        # While a malformed answer is not an answer: it keeps the retry hint of the call that could not be answered.
        malformed = fulltext._both_failed(europe_down(), fulltext.FullTextError("full_text_xml_invalid", "NCBI PMC returned malformed full-text XML.", True))
        self.assertEqual((malformed.code, malformed.retryable), ("source_unavailable", True))

    def test_both_failing_with_a_doi_still_tries_the_open_access_pdf_and_names_both(self):
        Network(self, europe_bytes=europe_down(), ncbi_bytes=ncbi_down(), europe_json=europe_down())
        sentinel = {"status": "success", "data": {}, "sources": [], "artifacts": []}
        with mock.patch.object(fulltext, "_resolve", return_value={"pmcid": PMCID, "doi": DOI, "isOpenAccess": "Y"}), \
                mock.patch.object(fulltext, "_fetch_open_access_pdf", return_value=sentinel) as pdf_route:
            result = fulltext.fetch({"identifier": PMCID})
        self.assertIs(result, sentinel)
        failure = pdf_route.call_args.kwargs["xml_failure"]
        self.assertEqual(failure.code, "source_unavailable")
        self.assertIn("NCBI PMC was asked next", str(failure))
        self.assertTrue(failure.also_tried_ncbi)

    def test_the_pdf_route_that_takes_over_says_neither_europe_pmc_nor_ncbi_would_serve_the_xml(self):
        europe = europe_down()
        failure = fulltext._both_failed(europe, ncbi_down())
        pdf = b"%PDF-1.7 open access"
        parsed = {"text": "Table 2. Hazard ratio 0.74 (95% CI 0.65-0.85).", "extractor": {"name": "evimed-extract", "version": "1"}, "pageMap": [{"page": 1}]}
        with mock.patch.object(fulltext, "_open_access_pdf", return_value=(pdf, {"origin": "o", "version": "", "license": ""}, parsed, None)):
            result = fulltext._fetch_open_access_pdf({"doi": "10.1/oa", "title": "T"}, self.workspace, xml_failure=failure, deadline=transport.Deadline(30))
        self.assertIn("would not serve the publisher's XML (upstream error) and neither would NCBI PMC; the open-access PDF was read instead", result["summary"])

    def test_a_lookup_that_fails_on_both_sides_is_one_error_with_europe_pmcs_code(self):
        Network(self, europe_json=europe_down(), ncbi_json=ncbi_down())
        result = fulltext.fetch({"identifier": "31001148"})
        self.assertEqual((result["status"], result["error"]["code"], result["error"]["retryable"]), ("error", "source_unavailable", True))
        self.assertIn("NCBI PMC answered with an error (HTTP 503)", result["error"]["message"])


class NcbiIsNotAskedForAnAnswerEuropePmcGave(Workspace):
    def test_a_refusal_is_not_retried_elsewhere(self):
        denied = source_outcome.denied("Europe PMC serves the full-text XML only for open-access articles; PMC6533834 is in PMC without an open license.", scope="Europe PMC", reason="not_open_access", retryable=False)
        network = Network(self, europe_bytes=fulltext.FullTextError(denied.code, str(denied), False, source_error=denied), ncbi_bytes=NCBI_XML)
        with mock.patch.object(fulltext, "_resolve", return_value={"pmcid": "PMC6533834", "doi": ""}):
            result = fulltext.fetch({"identifier": "PMC6533834"})
        self.assertEqual((result["status"], result["error"]["code"]), ("error", "source_access_denied"))
        self.assertEqual(network.urls("bytes", "ncbi") + network.urls("json", "ncbi"), [])

    def test_an_open_access_flag_of_no_settles_an_ambiguous_500_as_a_refusal_before_ncbi_is_considered(self):
        # Europe PMC answers a non-open-access article's full text with a 500, so the 500 alone is ambiguous; the
        # record's own `isOpenAccess: N` makes it the refusal it is, and NCBI (which would hold no body either) is not asked.
        network = Network(
            self, europe_bytes=europe_down(), ncbi_bytes=NCBI_XML,
            europe_json=lambda url: {"resultList": {"result": [{"pmcid": "PMC6533834", "isOpenAccess": "N"}]}},
        )
        result = fulltext.fetch({"identifier": "PMC6533834"})
        self.assertEqual((result["status"], result["error"]["code"], result["error"]["retryable"]), ("error", "source_access_denied", False))
        self.assertEqual(network.urls("bytes", "ncbi"), [])

    def test_a_pmcid_europe_pmc_has_no_record_of_is_not_looked_for_at_ncbi(self):
        network = Network(self, europe_bytes=europe_down(), ncbi_bytes=NCBI_XML, europe_json=lambda url: {"resultList": {"result": []}})
        result = fulltext.fetch({"identifier": "PMC99999999"})
        self.assertEqual((result["status"], result["error"]["code"]), ("error", "full_text_not_available"))
        self.assertEqual(network.urls("bytes", "ncbi"), [])

    def test_a_lookup_europe_pmc_answered_is_not_repeated_at_ncbi(self):
        network = Network(self, europe_json=lambda url: {"resultList": {"result": []}}, ncbi_json=lambda url: {})
        result = fulltext.fetch({"identifier": "31001148"})
        self.assertEqual((result["status"], result["error"]["code"]), ("error", "full_text_not_available"))
        self.assertEqual(network.urls("json", "ncbi"), [])


class NcbiRequestsGoThroughTheTransport(unittest.TestCase):
    def test_the_full_text_is_read_by_the_deadline_bound_transport_as_xml_under_its_own_scope(self):
        deadline = transport.Deadline(60)
        answer = transport.Response(200, {}, "text/xml", NCBI_XML)
        with mock.patch.object(fulltext.transport, "fetch", return_value=answer) as fetch:
            self.assertEqual(fulltext._ncbi_full_text(PMCID, deadline), NCBI_XML)
        (url, accepted), kwargs = fetch.call_args.args, fetch.call_args.kwargs
        self.assertTrue(url.startswith("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?"))
        self.assertEqual(set(accepted), {"text/xml", "application/xml"})
        self.assertEqual((kwargs["scope"], kwargs["max_bytes"]), ("NCBI PMC", fulltext.MAX_RESPONSE_BYTES))
        self.assertIs(kwargs["deadline"], deadline)

    def test_the_e_utilities_base_is_the_one_setting_literature_search_reads_and_the_key_is_added(self):
        with mock.patch.dict(os.environ, {"EVIMED_PUBMED_BASE_URL": "https://eutils.example.test/entrez/eutils/", "NCBI_API_KEY": "k-test"}):
            url = fulltext._ncbi_url("efetch.fcgi", {"db": "pmc", "id": "1", "retmode": "xml"})
        self.assertTrue(url.startswith("https://eutils.example.test/entrez/eutils/efetch.fcgi?"), url)
        self.assertEqual(query_of(url)["api_key"], ["k-test"])

    def test_ncbi_gets_a_budget_of_its_own_when_europe_pmc_spent_the_call(self):
        spent = transport.Deadline(110, clock=iter([0.0, 109.0, 109.0, 109.0]).__next__)
        fresh = fulltext._ncbi_deadline(spent)
        self.assertIsNot(fresh, spent)
        self.assertEqual(fresh.seconds, fulltext.NCBI_ROUTE_SECONDS)
        roomy = transport.Deadline(110)
        self.assertIs(fulltext._ncbi_deadline(roomy), roomy)


if __name__ == "__main__":
    unittest.main()
