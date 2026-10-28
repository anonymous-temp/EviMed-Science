"""PubMed records on request: publication types for every hit, abstracts for the
records a run keeps, each abstract preserved so a claim can quote it."""

import hashlib
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import public_sources as sources  # noqa: E402
import quote_locator  # noqa: E402


EFETCH_XML = """<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>30221597</PMID>
      <Article>
        <Journal><JournalIssue><PubDate><Year>2018</Year></PubDate></JournalIssue>
          <Title>The New England journal of medicine</Title></Journal>
        <ArticleTitle>Effect of Aspirin on Disability-free Survival in the Healthy Elderly.</ArticleTitle>
        <Abstract>
          <AbstractText Label="BACKGROUND">Information on the use of aspirin to increase healthy independent life span in older persons is limited.</AbstractText>
          <AbstractText Label="RESULTS">The rate of the composite of death, dementia, or persistent physical disability was 21.5 events per 1000 person-years in the aspirin group.</AbstractText>
        </Abstract>
        <PublicationTypeList>
          <PublicationType UI="D016428">Journal Article</PublicationType>
          <PublicationType UI="D016449">Randomized Controlled Trial</PublicationType>
        </PublicationTypeList>
      </Article>
      <MeshHeadingList>
        <MeshHeading><DescriptorName MajorTopicYN="Y">Aspirin</DescriptorName></MeshHeading>
        <MeshHeading><DescriptorName MajorTopicYN="N">Aged</DescriptorName></MeshHeading>
      </MeshHeadingList>
    </MedlineCitation>
    <PubmedData><ArticleIdList>
      <ArticleId IdType="pubmed">30221597</ArticleId>
      <ArticleId IdType="doi">10.1056/NEJMoa1800722</ArticleId>
    </ArticleIdList></PubmedData>
  </PubmedArticle>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>11111111</PMID>
      <Article><ArticleTitle>A letter without an abstract.</ArticleTitle>
        <PublicationTypeList><PublicationType>Letter</PublicationType></PublicationTypeList>
      </Article>
    </MedlineCitation>
  </PubmedArticle>
</PubmedArticleSet>
"""


def many_records_xml(pmids, abstract_chars=2000, headings=24):
    """A realistic batch: long titles, an abstract of about two thousand characters and a full MeSH list on each record."""
    articles = []
    for pmid in pmids:
        words = ("Outcome of therapy %s in adults with chronic disease: a multicentre randomised study. " % pmid) * 2
        abstract = ("Result sentence for record %s reports an effect with a confidence interval. " % pmid) * (abstract_chars // 70)
        mesh = "".join(
            '<MeshHeading><DescriptorName MajorTopicYN="N">Descriptor %s number %d</DescriptorName></MeshHeading>' % (pmid, index)
            for index in range(headings)
        )
        articles.append(
            "<PubmedArticle><MedlineCitation><PMID>%s</PMID><Article>"
            "<Journal><JournalIssue><PubDate><Year>2020</Year></PubDate></JournalIssue><Title>Journal of Long Titles</Title></Journal>"
            "<ArticleTitle>%s</ArticleTitle><Abstract><AbstractText Label=\"RESULTS\">%s</AbstractText></Abstract>"
            "<PublicationTypeList><PublicationType>Journal Article</PublicationType><PublicationType>Randomized Controlled Trial</PublicationType></PublicationTypeList>"
            "</Article><MeshHeadingList>%s</MeshHeadingList></MedlineCitation>"
            "<PubmedData><ArticleIdList><ArticleId IdType=\"doi\">10.1000/study.%s</ArticleId></ArticleIdList></PubmedData></PubmedArticle>"
            % (pmid, words, abstract, mesh, pmid)
        )
    return '<?xml version="1.0"?><PubmedArticleSet>%s</PubmedArticleSet>' % "".join(articles)


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_pubmed", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PubmedAbstractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.workspace = pathlib.Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)
        environment = mock.patch.dict(os.environ, {"OPEN_SCIENCE_WORKSPACE_DIR": str(self.workspace)})
        environment.start()
        self.addCleanup(environment.stop)

    def test_pmids_fetch_type_and_preserve_the_abstracts(self):
        with mock.patch.object(sources, "_get_text", return_value=EFETCH_XML) as fetch:
            result = sources.literature({"pmids": ["30221597", "PMID: 11111111", "99999999"]})
        url = fetch.call_args.args[0]
        self.assertIn("efetch.fcgi", url)
        self.assertIn("id=30221597%2C11111111%2C99999999", url)
        self.assertEqual(fetch.call_count, 1)

        self.assertEqual(result["status"], "warning")
        first, letter = result["data"]["items"]
        self.assertEqual(first["publicationTypes"], ["Journal Article", "Randomized Controlled Trial"])
        self.assertEqual(first["meshHeadings"], ["Aspirin*", "Aged"])
        self.assertEqual(first["doi"], "10.1056/NEJMoa1800722")
        self.assertEqual(first["evidenceLevel"], "abstract")
        self.assertIn("RESULTS: The rate of the composite", first["abstract"])
        self.assertEqual(letter["evidenceLevel"], "metadata")
        self.assertNotIn("artifactPath", letter)

        # The preserved abstract is the bytes the digest names, under the path
        # the source record carries: what the control plane's provenance check
        # and the run-side gate both require before a claim may quote it.
        path = first["artifactPath"]
        self.assertTrue(path.startswith(".evimed-sources/pubmed/PMID30221597/"))
        payload = (self.workspace / path).read_bytes()
        self.assertEqual(result["data"]["artifactSha256s"], {path: hashlib.sha256(payload).hexdigest()})
        self.assertEqual(result["artifacts"], [path])
        source = result["sources"][0]
        self.assertEqual(source["artifactPath"], path)
        self.assertEqual(source["evidenceAccess"], "abstract")
        self.assertEqual(result["sources"][1]["id"], "PMID:11111111")

        # And a claim can quote it.
        self.assertTrue(quote_locator.quote_is_present(
            payload.decode("utf-8"),
            "the rate of the composite of death, dementia, or persistent physical disability was 21.5 events per 1000 person-years",
        ))
        warnings = " ".join(result["warnings"])
        self.assertIn("99999999", warnings)
        self.assertIn("no abstract for PMID 11111111", warnings)

    def test_past_the_inline_budget_an_abstract_is_named_by_its_preserved_file(self):
        # An answer too large is cut by the kernel and stops being JSON, and then no file in it reads as preserved
        # (live check 2026-10-28): past the budget the item carries its path and the text stays on disk.
        with mock.patch.object(sources, "PUBMED_INLINE_ABSTRACT_BUDGET", 10), \
             mock.patch.object(sources, "_get_text", return_value=EFETCH_XML):
            result = sources.literature({"pmids": ["30221597"]})
        item = result["data"]["items"][0]
        self.assertNotIn("abstract", item)
        self.assertNotIn("meshHeadings", item)
        self.assertIs(item["abstractInline"], False)
        self.assertEqual(item["evidenceLevel"], "abstract")
        path = item["artifactPath"]
        self.assertIn("RESULTS: The rate of the composite", (self.workspace / path).read_text("utf-8"))
        self.assertEqual(result["artifacts"], [path])
        self.assertIn(path, result["data"]["artifactSha256s"])
        self.assertTrue(any("30221597" in action and "artifactPath" in action for action in result["next_actions"]))

    def test_the_whole_answer_stays_under_what_the_kernel_cuts(self):
        # The first guard budgeted the abstract text alone. A record also carries its metadata and its path four times over, so
        # sixty ids came to about 70,000 characters against a cut at about 50,000 (review of 2026-10-28). The answer is the
        # budget now, and a record that does not fit even leanly is left out and named, never listed without being written.
        pmids = [str(30000000 + index) for index in range(60)]
        with mock.patch.object(sources, "_get_text", return_value=many_records_xml(pmids)):
            result = sources.literature({"pmids": pmids})
        body = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        self.assertLessEqual(len(body), sources.PUBMED_ANSWER_BUDGET, "one answer, never cut")
        listed = [item["pmid"] for item in result["data"]["items"]]
        deferred = result["data"]["deferred"]
        self.assertTrue(listed and deferred, "some records fit and some do not")
        self.assertEqual(listed + deferred, pmids, "every requested record is either listed or named, in order")
        # What is listed was written, and what was written is listed: paths, digests, sources and items agree.
        paths = [item["artifactPath"] for item in result["data"]["items"]]
        self.assertEqual(result["artifacts"], paths)
        self.assertEqual(sorted(result["data"]["artifactSha256s"]), sorted(paths))
        self.assertEqual([source["artifactPath"] for source in result["sources"]], paths)
        for path in paths:
            self.assertTrue((self.workspace / path).is_file(), path)
        # A record left out is not in the workspace, and the answer says how to get it.
        pubmed_directory = self.workspace / ".evimed-sources" / "pubmed"
        self.assertEqual(sorted(entry.name for entry in pubmed_directory.iterdir()), sorted("PMID%s" % pmid for pmid in listed))
        self.assertEqual(result["status"], "warning")
        self.assertTrue(any("did not fit one answer" in warning and deferred[0] in warning for warning in result["warnings"]))
        self.assertTrue(any(deferred[-1] in action and "following call" in action for action in result["next_actions"]))
        # Asking for the rest completes the batch.
        with mock.patch.object(sources, "_get_text", return_value=many_records_xml(deferred)):
            rest = sources.literature({"pmids": deferred})
        self.assertEqual([item["pmid"] for item in rest["data"]["items"]] + rest["data"].get("deferred", []), deferred)

    def test_records_are_read_in_full_while_the_room_lasts_and_then_name_their_file(self):
        pmids = [str(30000000 + index) for index in range(10)]
        with mock.patch.object(sources, "_get_text", return_value=many_records_xml(pmids)):
            result = sources.literature({"pmids": pmids})
        self.assertNotIn("deferred", result["data"])
        items = result["data"]["items"]
        self.assertEqual([item["pmid"] for item in items], pmids)
        self.assertIn("abstract", items[0])
        self.assertIs(items[-1].get("abstractInline"), False)
        self.assertNotIn("abstract", items[-1])
        self.assertLessEqual(len(json.dumps(result, ensure_ascii=False, separators=(",", ":"))), sources.PUBMED_ANSWER_BUDGET)
        # Every record, read in full or not, was preserved and listed once.
        self.assertEqual(sorted(result["artifacts"]), sorted(item["artifactPath"] for item in items))

    def test_a_batch_that_fits_is_answered_whole_and_unchanged(self):
        pmids = ["30221597"]
        with mock.patch.object(sources, "_get_text", return_value=EFETCH_XML):
            result = sources.literature({"pmids": pmids})
        self.assertNotIn("deferred", result["data"])
        self.assertIn("abstract", result["data"]["items"][0])

    def test_an_abstract_that_could_not_be_saved_is_never_said_to_be_saved(self):
        # The note used to list every abstract left out of the answer as "preserved at its artifactPath", whether or not the
        # write had worked; a run sent to read a file that was never written.
        pmids = ["30221597"]
        with mock.patch.object(sources, "PUBMED_INLINE_ABSTRACT_BUDGET", 10), \
             mock.patch.object(sources, "_preserve_pubmed_abstract", return_value=None), \
             mock.patch.object(sources, "_get_text", return_value=EFETCH_XML):
            result = sources.literature({"pmids": pmids})
        item = result["data"]["items"][0]
        self.assertNotIn("artifactPath", item)
        self.assertNotIn("abstract", item)
        self.assertEqual(result["artifacts"], [])
        text = " ".join(result["warnings"]) + " " + " ".join(result["next_actions"])
        self.assertIn("could not be preserved", text)
        self.assertIn("ask for it again on its own", text)
        self.assertNotIn("Each is preserved at its artifactPath", text)

    def test_fetching_the_same_record_again_reuses_its_capture(self):
        with mock.patch.object(sources, "_get_text", return_value=EFETCH_XML):
            first = sources.literature({"pmids": ["30221597"]})
            second = sources.literature({"pmids": ["30221597"]})
        self.assertEqual(first["status"], "success")
        self.assertEqual(first["artifacts"], second["artifacts"])

    def test_more_than_one_batch_is_split_at_the_batch_size(self):
        with mock.patch.object(sources, "PUBMED_EFETCH_BATCH", 2), \
             mock.patch.object(sources, "_get_text", return_value="<PubmedArticleSet/>") as fetch:
            result = sources.literature({"pmids": ["1", "2", "3", "4", "5"]})
        self.assertEqual(fetch.call_count, 3)
        batches = [call.args[0].split("id=")[1].split("&")[0] for call in fetch.call_args_list]
        self.assertEqual(batches, ["1%2C2", "3%2C4", "5"])
        self.assertEqual(result["data"]["items"], [])
        self.assertIn("no record for PMID 1, 2, 3, 4, 5", result["warnings"][0])

    def test_ids_that_are_not_pmids_are_refused_before_any_request(self):
        for pmids in (["PMC123"], ["10.1056/x"], [], ["1"] * 201):
            with self.subTest(pmids=len(pmids)), mock.patch.object(sources, "_get_text") as fetch:
                with self.assertRaises(sources.PublicSourceError) as raised:
                    sources.pubmed_abstracts(pmids)
                self.assertEqual(raised.exception.code, "public_source_pmid_invalid")
                fetch.assert_not_called()

    def test_without_a_workspace_the_abstract_is_returned_and_marked_unquotable(self):
        with mock.patch.dict(os.environ, {"OPEN_SCIENCE_WORKSPACE_DIR": ""}), \
             mock.patch.object(sources, "_get_text", return_value=EFETCH_XML):
            result = sources.literature({"pmids": ["30221597"]})
        item = result["data"]["items"][0]
        self.assertIn("abstract", item)
        self.assertNotIn("artifactPath", item)
        self.assertIn("cannot carry a claim", " ".join(result["warnings"]))

    def test_literature_search_hits_carry_publication_types(self):
        search = {"esearchresult": {"idlist": ["30221597"]}}
        summary = {"result": {"30221597": {
            "uid": "30221597", "title": "Effect of Aspirin on Disability-free Survival in the Healthy Elderly.",
            "pubtype": ["Journal Article", "Randomized Controlled Trial"], "attributes": ["Has Abstract"],
        }}}
        with mock.patch.object(sources, "_get_json", side_effect=[search, summary]):
            result = sources.literature({"query": "aspirin elderly", "databases": ["pubmed"], "limit": 1})
        item = result["data"]["items"][0]
        self.assertEqual(item["publicationTypes"], ["Journal Article", "Randomized Controlled Trial"])
        self.assertTrue(item["hasAbstract"])
        self.assertTrue(any("pmids" in action for action in result["next_actions"]))


class LiteratureSearchContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def test_pmids_are_a_mode_that_needs_no_query(self):
        schema = self.server.TOOLS["literature_search"]["inputSchema"]
        self.assertNotIn("required", schema)
        self.server._validate({"pmids": ["30221597", "PMID:1"]}, schema, "arguments")
        for invalid in ({"pmids": []}, {"pmids": ["x1"]}, {"pmids": ["1"] * 201}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.server._validate(invalid, schema, "arguments")

    def test_a_call_with_nothing_to_search_for_is_refused(self):
        result = self.server.call_tool("literature_search", {"limit": 5})
        self.assertEqual(result["error"]["code"], "invalid_input")

    def test_pmids_go_to_pubmed_even_when_a_private_adapter_is_configured(self):
        with mock.patch.dict(os.environ, {"EVIMED_LITERATURE_SEARCH_URL": "https://adapter.invalid/literature"}), \
             mock.patch.object(self.server.public_sources, "pubmed_abstracts", return_value={
                 "status": "success", "summary": "Fetched 1 PubMed abstract(s).",
                 "data": {"items": [{"id": "PMID:1", "title": "t"}]},
                 "sources": [{"id": "PMID:1", "source": "pubmed", "retrievedAt": "2026-09-18T00:00:00Z"}],
             }) as fetch, \
             mock.patch.object(self.server, "_adapter_call") as adapter:
            result = self.server.call_tool("literature_search", {"pmids": ["1"]})
        adapter.assert_not_called()
        fetch.assert_called_once()
        self.assertEqual(result["status"], "success")


if __name__ == "__main__":
    unittest.main()
