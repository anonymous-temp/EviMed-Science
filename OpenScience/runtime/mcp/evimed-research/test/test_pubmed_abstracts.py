"""PubMed records on request: publication types for every hit, abstracts for the
records a run keeps, each abstract preserved so a claim can quote it."""

import hashlib
import importlib.util
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
