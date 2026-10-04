"""Discovery tools say how many more there are and how to continue: PubMed by `offset`, ClinicalTrials.gov by `pageToken`.

The esearch pages and the registry page are recorded (2026-10-04). The PubMed summaries that turn ids into records are
constructed (the esearch pages are what these tests are about), and so is the registry page's next page.
"""

import json
import pathlib
import sys
import unittest
import urllib.parse
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import public_sources as sources  # noqa: E402
import wire_fixtures as wire  # noqa: E402


IDS = ["30158069", "27341534", "33279517"]  # the ids of the recorded first esearch page


def esummary_for(ids):
    return {"result": {"uids": ids, **{uid: {"uid": uid, "title": "Constructed title %s" % uid, "pubdate": "2020", "source": "J", "pubtype": [], "authors": [], "articleids": []} for uid in ids}}}


class PubMedPaging(unittest.TestCase):
    def search(self, recorded, **arguments):
        asked = []

        def get_json(url):
            asked.append(url)
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            if "esearch.fcgi" in url:
                return wire.json_body(recorded)
            return esummary_for(query["id"][0].split(","))

        with mock.patch.object(sources, "_ncbi_get_json", side_effect=get_json):
            result = sources._pubmed("aspirin cardiovascular prevention randomized trial", 3, **arguments)
        self.asked = asked
        return result

    def test_the_first_page_says_how_many_there_are_and_what_to_pass_next(self):
        result = self.search("pubmed__esearch_page1.json")
        data = result["data"]
        self.assertEqual((data["total"], len(data["items"])), (2618, 3))
        outcome = data["outcome"]
        self.assertEqual((outcome["state"], outcome["returned"], outcome["total"], outcome["remaining"]), ("more_available", 3, 2618, 2615))
        self.assertEqual(outcome["next"]["arguments"], {"offset": 3})
        self.assertIn("offset=3", outcome["next"]["how"])
        self.assertIn("relevance order is not stable between pages", outcome["next"]["how"])
        self.assertIn("2618", result["summary"])
        self.assertNotIn("retstart", self.asked[0])

    def test_a_continuation_asks_pubmed_for_the_same_query_from_the_offset(self):
        result = self.search("pubmed__esearch_page2.json", offset=3)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.asked[0]).query)
        self.assertEqual((query["retstart"], query["retmax"]), (["3"], ["3"]))
        self.assertEqual(result["data"]["outcome"]["next"]["arguments"], {"offset": 6})
        self.assertEqual(result["data"]["outcome"]["returned"], 6)
        # The recorded second page repeats a record from the first: the guidance says so.
        self.assertIn("33279517", [item["pmid"] for item in result["data"]["items"]])

    def test_no_match_is_no_results_and_is_not_evidence_of_absence(self):
        result = self.search("pubmed__esearch_no_match.json")
        self.assertEqual((result["data"]["items"], result["data"]["total"]), ([], 0))
        self.assertEqual((result["data"]["outcome"]["state"], result["data"]["outcome"]["reason"]), ("no_results", "no_match"))
        self.assertIn("not evidence that no study exists", result["data"]["outcome"]["how"])

    def test_the_last_page_is_complete_and_what_pubmed_will_not_serve_is_truncated(self):
        recorded = wire.json_body("pubmed__esearch_page1.json")
        recorded["esearchresult"]["count"] = "3"
        with mock.patch.object(sources, "_ncbi_get_json", side_effect=lambda url: recorded if "esearch.fcgi" in url else esummary_for(IDS)):
            complete = sources._pubmed("q", 3)
        self.assertEqual((complete["data"]["outcome"]["state"], complete["data"]["outcome"]["total"]), ("complete", 3))
        deep = wire.json_body("pubmed__esearch_page1.json")
        deep["esearchresult"]["count"] = "20000"
        with mock.patch.object(sources, "_ncbi_get_json", side_effect=lambda url: deep if "esearch.fcgi" in url else esummary_for(IDS)):
            cut = sources._pubmed("q", 3, offset=9996)
        outcome = cut["data"]["outcome"]
        self.assertEqual((outcome["state"], outcome["limit"], outcome["unit"]), ("truncated", 9999, "results reachable"))
        self.assertIn("narrow it", outcome["how"])

    def test_an_unknown_total_is_absent_never_zero(self):
        recorded = wire.json_body("pubmed__esearch_page1.json")
        del recorded["esearchresult"]["count"]
        with mock.patch.object(sources, "_ncbi_get_json", side_effect=lambda url: recorded if "esearch.fcgi" in url else esummary_for(IDS)):
            result = sources._pubmed("q", 3)
        self.assertNotIn("total", result["data"])
        self.assertEqual(result["data"]["outcome"], {"state": "complete", "returned": 3})

    def test_an_offset_skips_the_evimed_index_and_says_so(self):
        with mock.patch.object(sources, "_evimed_literature_records") as internal, \
                mock.patch.object(sources, "_pubmed", return_value={"status": "warning", "summary": "s", "data": {"items": [{"id": "PMID:1"}]}, "sources": []}) as pubmed:
            result = sources.literature({"query": "q", "limit": 3, "offset": 3})
        internal.assert_not_called()
        self.assertEqual(pubmed.call_args.kwargs["offset"], 3)
        self.assertIn("the EviMed index was not asked", " ".join(result["warnings"]))


class RegistryPaging(unittest.TestCase):
    def search(self, body, **arguments):
        with mock.patch.object(sources, "_get_json", return_value=body) as get:
            result = sources._trials_registry({"query": "osimertinib", "limit": 3, **arguments}, "EviMed is not asked.")
        self.url = get.call_args.args[0]
        return result

    def test_a_page_of_a_larger_answer_names_the_registry_total_and_the_token(self):
        result = self.search(wire.json_body("clinicaltrials__search_page.json"))
        outcome = result["data"]["outcome"]
        self.assertEqual((outcome["state"], outcome["registryTotal"], outcome["returned"]), ("more_available", 38, 3))
        self.assertEqual(outcome["next"]["arguments"], {"pageToken": "ZVNj7o2Elu8o3lpwTcito62tmpOQJJxtZfeh3PIW"})
        self.assertNotIn("total", outcome, "the registry's total counts matches before the concept filter; it is not this page's total")
        self.assertIn("38 registry matches", outcome["next"]["how"])
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.url).query)
        self.assertEqual(query["countTotal"], ["true"])
        self.assertNotIn("pageToken", query)

    def test_the_token_continues_the_same_query_and_the_last_page_is_complete(self):
        last = {"totalCount": 38, "studies": wire.json_body("clinicaltrials__search_page.json")["studies"]}
        result = self.search(last, pageToken="ZVNj7o2Elu8o3lpwTcito62tmpOQJJxtZfeh3PIW")
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(self.url).query)["pageToken"], ["ZVNj7o2Elu8o3lpwTcito62tmpOQJJxtZfeh3PIW"])
        self.assertEqual((result["data"]["outcome"]["state"], result["data"]["outcome"]["registryTotal"]), ("complete", 38))

    def test_no_match_is_no_results(self):
        result = self.search({"totalCount": 0, "studies": []})
        self.assertEqual((result["data"]["outcome"]["state"], result["data"]["outcome"]["reason"]), ("no_results", "no_match"))

    def test_a_page_token_skips_the_evimed_index(self):
        with mock.patch.object(sources, "_evimed_trial_records") as internal, mock.patch.object(sources, "_trials_registry", return_value={"data": {"items": []}}) as registry:
            sources.trials({"query": "q", "pageToken": "abc"})
        internal.assert_not_called()
        self.assertIn("EviMed index was not asked", registry.call_args.args[1])


if __name__ == "__main__":
    unittest.main()
