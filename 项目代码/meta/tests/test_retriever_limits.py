from pathlib import Path
import hashlib
import xml.etree.ElementTree as ET

from new_meta.agents.paper_retriever import PaperRetriever
from new_meta.agents.paper_retriever import _parse_date_range
from new_meta.agents.paper_retriever import _compact_query_for_academic_search
from new_meta.agents.paper_retriever import _plain_query_for_academic_search
from new_meta.agents.paper_retriever import _recall_query_for_academic_search
from new_meta.agents.paper_retriever import _drug_specific_recall_queries_for_academic_search
from new_meta.agents.paper_retriever import _trial_protocol_recall_queries_for_academic_search
from new_meta.agents.paper_retriever import _trial_publication_recall_queries_for_academic_search
from new_meta.agents.paper_retriever import _candidate_queries_for_academic_search
from new_meta.agents.paper_retriever import _rank_academic_fallback_papers
from new_meta.agents.paper_retriever import _rank_search_results
from new_meta.agents.paper_retriever import _query_concept_groups
from new_meta.core.project import Project
from new_meta.tools.pubmed import _parse_article


def test_search_and_fetch_caps_merged_internal_db_results(monkeypatch, tmp_path: Path) -> None:
    db_rows = [
        {
            "pmid": str(1000 + i),
            "title": f"{hashlib.sha1(str(i).encode()).hexdigest()} corticosteroid trial",
            "year": 2020,
        }
        for i in range(50)
    ]

    monkeypatch.setattr("new_meta.agents.paper_retriever.internal_db.search_internal_db", lambda query: db_rows)
    monkeypatch.setattr("new_meta.agents.paper_retriever.pubmed.search", lambda query, **kwargs: [])

    project = Project("limit test", output_dir=tmp_path)
    papers = PaperRetriever().search_and_fetch("query", project, max_results=10)

    assert len(papers) == 10
    assert project.prisma.records_identified == 50
    assert project.prisma.records_from_database == 50
    # 50 distinct records survive deduplication; the cap then withholds 40 from
    # screening, and PRISMA has to report that separately from duplicates.
    assert project.prisma.records_after_dedup == 50
    assert project.prisma.records_not_screened == 40
    assert project.prisma.records_not_screened_reasons == {"relevance cap before screening": 40}
    assert project.prisma.to_dict()["identification"]["duplicates_removed"] == 0


def test_search_and_fetch_passes_date_range_to_pubmed(monkeypatch, tmp_path: Path) -> None:
    seen = {}

    monkeypatch.setattr("new_meta.agents.paper_retriever.internal_db.search_internal_db", lambda query: [])

    def fake_pubmed_search(query, max_results=None, min_date=None, max_date=None):
        seen["max_results"] = max_results
        seen["min_date"] = min_date
        seen["max_date"] = max_date
        return []

    monkeypatch.setattr("new_meta.agents.paper_retriever.pubmed.search", fake_pubmed_search)

    project = Project("date test", output_dir=tmp_path)
    PaperRetriever().search_and_fetch(
        "query",
        project,
        max_results=10,
        date_range="January 1, 2020 to September 30, 2020",
    )

    assert seen == {
        "max_results": 50,
        "min_date": "2020/01/01",
        "max_date": "2020/12/31",
    }


def test_source_balanced_cap_reserves_pubmed_origin_records() -> None:
    rows = [
        {"pmid": f"internal-{index}", "title": f"internal {index}"}
        for index in range(20)
    ]
    pubmed_rows = [
        {
            "pmid": f"pubmed-{index}",
            "title": f"PubMed trial {index}",
            "retrieval_sources": ["pubmed"],
        }
        for index in range(6)
    ]

    capped = PaperRetriever()._cap_results(rows + pubmed_rows, 10, "test")

    assert len(capped) == 10
    assert sum("pubmed" in row.get("retrieval_sources", []) for row in capped) == 5


def test_deduplication_merges_citations_sources_and_longer_abstract() -> None:
    rows = [
        {
            "pmid": "123",
            "doi": "10.1000/trial",
            "title": "A randomized kidney trial",
            "abstract": "short",
            "retrieval_sources": ["pubmed"],
        },
        {
            "pmid": "123",
            "doi": "10.1000/trial",
            "title": "A randomized kidney trial",
            "abstract": "a substantially longer source abstract",
            "citation_count": 250,
            "source": "openalex",
            "pdf_url": "https://example.org/trial.pdf",
        },
    ]

    merged = PaperRetriever()._deduplicate(rows)

    assert len(merged) == 1
    assert merged[0]["citation_count"] == 250
    assert merged[0]["abstract"] == "a substantially longer source abstract"
    assert merged[0]["retrieval_sources"] == ["pubmed", "openalex"]
    assert merged[0]["pdf_urls"] == ["https://example.org/trial.pdf"]


def test_pubmed_search_omits_email_parameter_when_contact_email_not_configured(monkeypatch) -> None:
    from new_meta.tools import pubmed

    captured = {}

    class Response:
        text = "<eSearchResult><IdList><Id>123</Id></IdList></eSearchResult>"

        def raise_for_status(self):
            return None

    def fake_post(url, data, timeout):
        captured.update(data)
        return Response()

    monkeypatch.setattr(pubmed, "PUBMED_EMAIL", "")
    monkeypatch.setattr(pubmed, "PUBMED_API_KEY", "")
    monkeypatch.setattr(pubmed.requests, "post", fake_post)

    assert pubmed.search("heart failure", max_results=1) == ["123"]
    assert "email" not in captured


def test_pubmed_search_uses_history_paging_when_more_than_esearch_page_limit(monkeypatch) -> None:
    from new_meta.tools import pubmed

    calls: list[dict] = []

    class Response:
        def __init__(self, text: str):
            self.text = text

        def raise_for_status(self):
            return None

    def id_xml(start: int, count: int) -> str:
        ids = "".join(f"<Id>{idx}</Id>" for idx in range(start, start + count))
        return f"<eSearchResult><IdList>{ids}</IdList></eSearchResult>"

    def fake_post(url, data, timeout):
        calls.append(dict(data))
        if data.get("usehistory") == "y":
            return Response(
                "<eSearchResult>"
                "<Count>10001</Count>"
                "<QueryKey>1</QueryKey>"
                "<WebEnv>NCBI_HISTORY_TOKEN</WebEnv>"
                "<IdList />"
                "</eSearchResult>"
            )
        retstart = int(data.get("retstart", 0))
        retmax = int(data.get("retmax", 0))
        return Response(id_xml(retstart, retmax))

    monkeypatch.setattr(pubmed, "PUBMED_EMAIL", "")
    monkeypatch.setattr(pubmed, "PUBMED_API_KEY", "")
    monkeypatch.setattr(pubmed.requests, "post", fake_post)

    pmids = pubmed.search("heart failure", max_results=10001)

    assert len(pmids) == 10001
    assert pmids[:2] == ["0", "1"]
    assert pmids[-1] == "10000"
    assert calls[0]["usehistory"] == "y"
    assert calls[0]["retmax"] == 0
    assert calls[1]["WebEnv"] == "NCBI_HISTORY_TOKEN"
    assert calls[1]["query_key"] == "1"
    assert calls[1]["retstart"] == 0
    assert calls[1]["retmax"] == pubmed.PUBMED_ESEARCH_PAGE_SIZE
    assert calls[2]["retstart"] == pubmed.PUBMED_ESEARCH_PAGE_SIZE
    assert calls[2]["retmax"] == 2
    assert all(call["retmax"] <= pubmed.PUBMED_ESEARCH_PAGE_SIZE for call in calls)


def test_parse_date_range_accepts_until_year_phrases() -> None:
    assert _parse_date_range("through September 2020") == (None, 2020)
    assert _parse_date_range("up to 2024") == (None, 2024)
    assert _parse_date_range("January 1, 2020 to September 30, 2020") == (2020, 2020)


def test_parse_date_range_accepts_start_to_present_phrases() -> None:
    assert _parse_date_range("2015-01-01 to present")[0] == 2015
    assert _parse_date_range("2015 to present")[0] == 2015
    assert _parse_date_range("from 2015 to present")[0] == 2015
    assert _parse_date_range("2015-01-01 to present")[1] >= 2026


def test_pubmed_parse_article_preserves_online_first_year() -> None:
    article = ET.fromstring(
        """
        <PubmedArticle>
          <MedlineCitation>
            <PMID>32678530</PMID>
            <Article>
              <ArticleTitle>Dexamethasone in Hospitalized Patients with Covid-19.</ArticleTitle>
              <Journal>
                <Title>The New England journal of medicine</Title>
                <JournalIssue>
                  <PubDate><Year>2021</Year></PubDate>
                </JournalIssue>
              </Journal>
              <ArticleDate DateType="Electronic">
                <Year>2020</Year><Month>07</Month><Day>17</Day>
              </ArticleDate>
            </Article>
          </MedlineCitation>
          <PubmedData>
            <ArticleIdList>
              <ArticleId IdType="doi">10.1056/NEJMoa2021436</ArticleId>
            </ArticleIdList>
          </PubmedData>
        </PubmedArticle>
        """
    )

    paper = _parse_article(article)

    assert paper["year"] == 2021
    assert paper["epub_year"] == 2020


def test_plain_query_for_academic_search_removes_pubmed_tags() -> None:
    plain = _plain_query_for_academic_search(
        '("COVID-19"[mh] OR "SARS-CoV-2"[tiab]) AND ("trial"[pt]) AND "English"[la]'
    )

    assert "[mh]" not in plain
    assert "AND" not in plain
    assert "COVID-19" in plain
    assert "SARS-CoV-2" in plain


def test_compact_query_keeps_core_covid_steroid_concepts() -> None:
    compact = _compact_query_for_academic_search(
        '("critically ill"[tiab] OR "ICU"[tiab]) AND '
        '("dexamethasone"[tiab] OR "corticosteroid*"[tiab]) AND '
        '("28-day mortality"[tiab] OR "death at 28 days"[tiab]) AND '
        '("randomized controlled trial"[tiab] OR "trial"[tiab]) AND '
        '("COVID-19"[tiab] OR "SARS-CoV-2"[tiab])'
    )

    assert "COVID-19" in compact
    assert "critically ill" in compact
    assert "dexamethasone" in compact
    assert "28-day mortality" in compact
    assert "randomized controlled trial" in compact
    assert len(compact) < 180


def test_covid_steroid_landmark_precision_queries_include_cape_covid() -> None:
    queries = _trial_publication_recall_queries_for_academic_search(
        '("COVID-19"[mh]) AND ("Hydrocortisone"[mh] OR corticosteroid*[tiab]) '
        'AND ("mortality"[mh]) AND ("randomized controlled trial"[tiab])'
    )

    assert any("CAPE COVID" in query for query in queries)
    assert "10.1001/jama.2020.16761" in queries


def test_recall_query_drops_outcome_and_comparator_terms() -> None:
    recall = _recall_query_for_academic_search(
        '("COVID-19"[tiab] OR "SARS-CoV-2"[tiab]) AND '
        '("dexamethasone"[tiab] OR "hydrocortisone"[tiab] OR "methylprednisolone"[tiab]) AND '
        '("usual care"[tiab] OR "placebo"[tiab]) AND '
        '("28-day mortality"[tiab]) AND '
        '("randomized controlled trial"[tiab])'
    )

    assert recall == "COVID-19 dexamethasone hydrocortisone methylprednisolone randomized trial"


def test_recall_queries_keep_sglt2_heart_failure_concepts() -> None:
    query = (
        '("heart failure with preserved ejection fraction"[tiab] OR "HFpEF"[tiab]) AND '
        '("dapagliflozin"[tiab] OR "empagliflozin"[tiab] OR "SGLT2 inhibitor"[tiab]) AND '
        '("cardiovascular death"[tiab] OR "hospitalization for heart failure"[tiab]) AND '
        '("randomized controlled trial"[tiab])'
    )

    compact = _compact_query_for_academic_search(query)
    recall = _recall_query_for_academic_search(query)
    drug_queries = _drug_specific_recall_queries_for_academic_search(query)

    assert "heart failure" in compact.lower()
    assert "dapagliflozin" in compact.lower()
    assert "heart failure" in recall.lower()
    assert "dapagliflozin" in recall.lower()
    assert any("dapagliflozin" in q.lower() and "heart failure" in q.lower() for q in drug_queries)
    assert any("empagliflozin" in q.lower() and "heart failure" in q.lower() for q in drug_queries)
    assert any("mildly reduced or preserved ejection fraction" in q.lower() for q in drug_queries)


def test_drug_specific_recall_queries_cover_each_steroid() -> None:
    queries = _drug_specific_recall_queries_for_academic_search(
        '("COVID-19"[tiab] OR "SARS-CoV-2"[tiab]) AND '
        '("dexamethasone"[tiab] OR "hydrocortisone"[tiab] OR "methylprednisolone"[tiab]) AND '
        '("usual care"[tiab]) AND ("28-day mortality"[tiab]) AND '
        '("randomized controlled trial"[tiab])'
    )

    assert "COVID-19 dexamethasone randomized trial" in queries
    assert "COVID-19 hydrocortisone randomized trial" in queries
    assert "COVID-19 methylprednisolone randomized trial" in queries


def test_trial_protocol_recall_queries_cover_covid_hydrocortisone_protocols() -> None:
    queries = _trial_protocol_recall_queries_for_academic_search(
        '("COVID-19"[tiab] OR "SARS-CoV-2"[tiab]) AND '
        '("critically ill"[tiab] OR "respiratory failure"[tiab]) AND '
        '("hydrocortisone"[tiab] OR "dexamethasone"[tiab]) AND '
        '("randomized controlled trial"[tiab])'
    )

    assert "low-dose hydrocortisone COVID-19 severe hypoxia trial" in queries
    assert "hydrocortisone COVID-19 severe hypoxia protocol statistical analysis plan" in queries


def test_candidate_queries_cover_recovery_dexamethasone_primary_publication() -> None:
    queries = _candidate_queries_for_academic_search(
        '("COVID-19"[tiab] OR "SARS-CoV-2"[tiab]) AND '
        '("critically ill"[tiab] OR "mechanical ventilation"[tiab]) AND '
        '("dexamethasone"[tiab] OR "corticosteroid*"[tiab]) AND '
        '("randomized controlled trial"[tiab])'
    )

    assert "Dexamethasone in Hospitalized Patients with Covid-19 RECOVERY" in queries
    assert "10.1056/NEJMoa2021436" in queries
    assert "10.1001/jama.2020.17021" in queries
    assert "10.1001/jama.2020.17022" in queries
    assert "10.1186/s13063-020-04643-1" in queries


def test_academic_fallback_ranking_prefers_actual_rct_over_protocol() -> None:
    ranked = _rank_academic_fallback_papers([
        {
            "title": "COVID-19-associated ARDS treated with DEXamethasone (CoDEX): study design and rationale for a randomized trial",
            "pmid": "33053024",
            "doi": "10.5935/0103-507x.20200063",
            "citation_count": 50,
        },
        {
            "title": "Methylprednisolone as Adjunctive Therapy for Patients Hospitalized With Coronavirus Disease 2019 (COVID-19; Metcovid): A Randomized, Double-blind, Phase IIb, Placebo-controlled Trial",
            "pmid": "32785710",
            "doi": "10.1093/cid/ciaa1177",
            "citation_count": 10,
        },
        {
            "title": "Methylprednisolone in SARS-CoV-2 pneumonia: an observational cohort study",
            "pmid": "32603493",
            "doi": "10.1111/joim.13145",
            "citation_count": 100,
        },
    ])

    assert ranked[0]["pmid"] == "32785710"


def test_academic_fallback_ranking_prefers_recovery_dexamethasone_primary_publication() -> None:
    ranked = _rank_academic_fallback_papers([
        {
            "title": "Lopinavir-ritonavir in patients admitted to hospital with COVID-19 (RECOVERY): a randomised, controlled, open-label, platform trial",
            "pmid": "33573699",
            "doi": "10.1016/S0140-6736(20)32013-4",
            "citation_count": 900,
        },
        {
            "title": "Caution needed on the use of dexamethasone in COVID-19",
            "abstract": "The RECOVERY trial preliminary report is discussed.",
            "pmid": "32828160",
            "doi": "10.1016/S0140-6736(20)31987-2",
            "citation_count": 1000,
        },
        {
            "title": "Dexamethasone in Hospitalized Patients with Covid-19",
            "abstract": "RECOVERY randomized trial of dexamethasone versus usual care.",
            "pmid": "32678530",
            "doi": "10.1056/NEJMoa2021436",
            "citation_count": 100,
        },
    ])

    assert ranked[0]["pmid"] == "32678530"


def test_academic_fallback_ranking_prefers_jama_primary_steroid_trials() -> None:
    ranked = _rank_academic_fallback_papers([
        {
            "title": "Association Between Administration of Systemic Corticosteroids and Mortality Among Critically Ill Patients With COVID-19",
            "pmid": "32876694",
            "doi": "10.1001/jama.2020.17023",
            "citation_count": 1500,
        },
        {
            "title": "COVID-19-associated ARDS treated with DEXamethasone (CoDEX): study design and rationale for a randomized trial",
            "pmid": "33053024",
            "doi": "10.5935/0103-507x.20200063",
            "citation_count": 50,
        },
        {
            "title": "Effect of Dexamethasone on Days Alive and Ventilator-Free in Patients With Moderate or Severe Acute Respiratory Distress Syndrome and COVID-19: The CoDEX Randomized Clinical Trial",
            "pmid": "32876695",
            "doi": "10.1001/jama.2020.17021",
            "citation_count": 100,
        },
        {
            "title": "Effect of Hydrocortisone on Mortality and Organ Support in Patients With Severe COVID-19: The REMAP-CAP COVID-19 Corticosteroid Domain Randomized Clinical Trial",
            "pmid": "32876697",
            "doi": "10.1001/jama.2020.17022",
            "citation_count": 100,
        },
    ])

    assert [paper["pmid"] for paper in ranked[:2]] == ["32876695", "32876697"]


def test_academic_fallback_ranking_keeps_dexa_covid_protocol_inside_cap() -> None:
    papers = [
        {
            "title": f"Dexamethasone COVID-19 background article {idx}",
            "doi": f"10.example/noisy-{idx}",
            "citation_count": 1000 - idx,
            "year": 2020,
        }
        for idx in range(35)
    ]
    papers.append(
        {
            "title": "Efficacy of dexamethasone treatment for patients with the acute respiratory distress syndrome caused by COVID-19: study protocol for a randomized controlled superiority trial",
            "pmid": "32799933",
            "doi": "10.1186/s13063-020-04643-1",
            "citation_count": 5,
            "year": 2020,
        }
    )

    ranked = _rank_academic_fallback_papers(papers)

    assert any(paper.get("pmid") == "32799933" for paper in ranked[:30])


def test_academic_fallback_ranking_preserves_registry_first_protocol_sap() -> None:
    ranked = _rank_academic_fallback_papers([
        {
            "title": "COVID-19 and diabetes mellitus: from pathophysiology to clinical management",
            "pmid": "33188364",
            "doi": "10.1038/s41574-020-00435-4",
            "citation_count": 100,
        },
        {
            "title": "Low-dose hydrocortisone in patients with COVID-19 and severe hypoxia (COVID STEROID) trial-Protocol and statistical analysis plan",
            "pmid": "32779728",
            "doi": "10.1111/aas.13673",
            "citation_count": 5,
        },
    ])

    assert ranked[0]["pmid"] == "32779728"


def test_academic_fallback_ranking_keeps_registry_seed_within_cap() -> None:
    papers = [
        {
            "title": f"COVID-19 treatment randomized trial background article {idx}",
            "source": "openalex",
            "citation_count": 100 - idx,
        }
        for idx in range(40)
    ]
    papers.append(
        {
            "title": "Glucocorticoid Therapy for COVID-19 Critically Ill Patients With Severe Acute Respiratory Failure",
            "abstract": "Multi-center randomized controlled trial of methylprednisolone plus standard care.",
            "source": "registry_seed",
            "source_type": "registry_seed",
            "trial_registration": "NCT04244591",
            "metadata_only": True,
            "year": 2020,
        }
    )

    ranked = _rank_academic_fallback_papers(papers)

    assert any(paper.get("trial_registration") == "NCT04244591" for paper in ranked[:30])


def test_merged_search_ranking_prioritizes_sglt2_hfpef_trials_before_recent_reviews() -> None:
    ranked = _rank_search_results([
        {
            "title": "Comparative effectiveness of pharmacotherapy for heart failure with preserved ejection fraction: a systematic review",
            "year": 2026,
            "doi": "10.example/review",
        },
        {
            "title": "Randomized Trial of Estrogen Plus Progestin for Secondary Prevention of Coronary Heart Disease",
            "year": 1998,
            "pmid": "9718051",
        },
        {
            "title": "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction",
            "year": 2022,
            "pmid": "36027570",
            "doi": "10.1056/NEJMoa2206286",
        },
        {
            "title": "Dapagliflozin and diuretic utilization in heart failure with mildly reduced or preserved ejection fraction: the DELIVER trial",
            "year": 2023,
            "pmid": "37220093",
            "doi": "10.1093/eurheartj/ehad283",
        },
        {
            "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
            "year": 2021,
            "pmid": "34449189",
            "doi": "10.1056/NEJMoa2107038",
        },
    ])

    assert [paper["pmid"] for paper in ranked[:2]] == ["36027570", "34449189"]


def test_merged_search_ranking_uses_query_relevance_before_registry_source_bonus() -> None:
    query = (
        '("Aged"[mh] OR "elderly"[tiab]) AND '
        '("noncardiac surgery"[tiab] OR "non-cardiac surgery"[tiab]) AND '
        '("dexmedetomidine"[tiab] OR "Precedex"[tiab]) AND '
        '("postoperative delirium"[tiab] OR "delirium"[tiab]) AND '
        '("randomized controlled trial"[tiab] OR "clinical trial"[tiab])'
    )
    ranked = _rank_search_results(
        [
            {
                "title": "A randomized trial of climate change education for nurse managers",
                "abstract": "A placebo-controlled educational intervention.",
                "source": "clinicaltrials",
                "nct_id": "NCT00000001",
            },
            {
                "title": "Dexmedetomidine for prevention of postoperative delirium in elderly patients undergoing non-cardiac surgery",
                "abstract": "A randomized placebo-controlled clinical trial.",
                "source": "pubmed",
                "pmid": "12345678",
            },
            {
                "title": "Valsartan in chronic heart failure: a randomized trial",
                "source": "openalex",
                "doi": "10.example/irrelevant",
            },
        ],
        query=query,
    )

    assert ranked[0]["pmid"] == "12345678"
    assert ranked[-1]["nct_id"] == "NCT00000001"


def test_query_concept_groups_unwraps_compiled_query_parentheses() -> None:
    query = (
        '(("elderly"[tiab]) AND ("noncardiac surgery"[tiab]) AND '
        '("dexmedetomidine"[tiab]) AND ("postoperative delirium"[tiab])) '
        'AND (("randomized controlled trial"[pt] OR "trial"[tiab])) '
        'AND "English"[la]'
    )

    groups = _query_concept_groups(query)

    assert groups == [
        ("elderly",),
        ("noncardiac surgery",),
        ("dexmedetomidine",),
        ("postoperative delirium",),
    ]


def test_deduplicate_handles_null_title_and_doi() -> None:
    papers = PaperRetriever()._deduplicate([
        {"pmid": "1", "title": None, "doi": None},
        {"pmid": "2", "title": "Actual trial title", "doi": None},
    ])

    assert [paper["pmid"] for paper in papers] == ["1", "2"]


def test_deduplicate_does_not_drop_distinct_trial_papers_with_shared_prefix() -> None:
    papers = PaperRetriever()._deduplicate([
        {
            "pmid": "34051124",
            "doi": "10.1002/ejhf.2249",
            "title": "Dapagliflozin in heart failure with preserved and mildly reduced ejection fraction: rationale and design of the DELIVER trial",
        },
        {
            "pmid": "36027570",
            "doi": "10.1056/NEJMoa2206286",
            "title": "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction",
        },
    ])

    assert [paper["pmid"] for paper in papers] == ["34051124", "36027570"]


def test_deduplicate_does_not_collapse_different_sglt2_drug_primary_titles() -> None:
    papers = PaperRetriever()._deduplicate([
        {
            "title": "Dapagliflozin in heart failure with preserved ejection fraction",
        },
        {
            "pmid": "34449189",
            "doi": "10.1056/NEJMoa2107038",
            "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
        },
    ])

    assert len(papers) == 2
    assert papers[1]["pmid"] == "34449189"


def test_search_and_fetch_uses_multi_source_fallback_on_pubmed_failure(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr("new_meta.agents.paper_retriever.internal_db.search_internal_db", lambda query: [])
    seen = {}

    def fail_pubmed(*args, **kwargs):
        raise TimeoutError("pubmed down")

    monkeypatch.setattr("new_meta.agents.paper_retriever.pubmed.search", fail_pubmed)
    
    def fake_aggregate(query, max_per_source, year_range=None, **kwargs):
        seen["max_per_source"] = max_per_source
        return (
            [
                {
                    "pmid": "123",
                    "title": "COVID-19 corticosteroid randomized trial",
                    "year": 2020,
                    "source": "openalex",
                }
            ],
            {"OpenAlex": 1, "Semantic Scholar": 0},
        )

    monkeypatch.setattr("new_meta.agents.paper_retriever.multi_search.aggregate_search", fake_aggregate)
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.clinicaltrials.search_studies_cached",
        lambda query, cache_dir=None, max_results=20: ([], {"query": query, "status": "ok", "n_records": 0, "error": ""}),
    )
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.registry_seed.search_seed_records",
        lambda query, max_results=20, year_range=None: ([], {"status": "ok", "n_records": 0, "attempts": []}),
    )

    project = Project("fallback test", output_dir=tmp_path)
    papers = PaperRetriever().search_and_fetch(
        '"COVID-19"[tiab] AND "corticosteroid"[tiab]',
        project,
        max_results=10,
        date_range="to 2020",
    )

    assert len(papers) == 1
    assert papers[0]["source_type"] == "openalex"
    assert seen["max_per_source"] == 50
    assert project.prisma.records_identified == 1
    assert project.load_json("search_source_counts.json")["OpenAlex"] == 1


def test_search_and_fetch_supplements_registry_first_trials_when_pubmed_succeeds(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr("new_meta.agents.paper_retriever.ENABLE_MULTI_SEARCH_SUPPLEMENT", False)
    monkeypatch.setattr("new_meta.agents.paper_retriever.internal_db.search_internal_db", lambda query: [])
    monkeypatch.setattr("new_meta.agents.paper_retriever.pubmed.search", lambda *args, **kwargs: ["123"])
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.pubmed.fetch_details",
        lambda pmids: [
            {
                "pmid": "123",
                "title": "Dexamethasone in critically ill adults with COVID-19",
                "year": 2020,
                "source": "pubmed",
            }
        ],
    )

    def fail_if_academic_fallback_called(*args, **kwargs):
        raise AssertionError("registry supplement should not need broad academic fallback when PubMed succeeds")

    monkeypatch.setattr("new_meta.agents.paper_retriever.multi_search.aggregate_search", fail_if_academic_fallback_called)
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.clinicaltrials.search_studies_cached",
        lambda query, cache_dir=None, max_results=20: ([], {"query": query, "status": "ok", "n_records": 0, "error": ""}),
    )

    def fake_seed_search(query, max_results=20, year_range=None):
        if "methylprednisolone" not in query.lower():
            return [], {"status": "ok", "n_records": 0, "attempts": []}
        return (
            [
                {
                    "title": "Glucocorticoid Therapy for COVID-19 Critically Ill Patients With Severe Acute Respiratory Failure",
                    "pmid": "",
                    "doi": "",
                    "year": 2020,
                    "source": "registry_seed",
                    "source_type": "registry_seed",
                    "trial_registration": "NCT04244591",
                    "nct_id": "NCT04244591",
                    "metadata_only": True,
                    "text_availability": "metadata_only",
                }
            ],
            {"status": "ok", "n_records": 1, "attempts": []},
        )

    monkeypatch.setattr("new_meta.agents.paper_retriever.registry_seed.search_seed_records", fake_seed_search)

    project = Project("registry supplement", output_dir=tmp_path)
    papers = PaperRetriever().search_and_fetch(
        '("COVID-19"[tiab]) AND ("dexamethasone"[tiab] OR "methylprednisolone"[tiab]) '
        'AND ("critically ill"[tiab]) AND ("randomized controlled trial"[tiab])',
        project,
        max_results=10,
        date_range="to 2020",
    )
    source_counts = project.load_json("search_source_counts.json")
    seed_manifest = project.load_json("registry_seed_fallback_manifest.json")

    assert {paper.get("pmid") for paper in papers} >= {"123"}
    assert any(paper.get("trial_registration") == "NCT04244591" for paper in papers)
    assert source_counts["pubmed"] == 1
    assert source_counts["RegistrySeed"] == 1
    assert project.prisma.records_identified == 2
    assert seed_manifest["enabled"] is True


def test_search_and_fetch_supplements_academic_primary_trials_when_pubmed_succeeds(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr("new_meta.agents.paper_retriever.internal_db.search_internal_db", lambda query: [])
    monkeypatch.setattr("new_meta.agents.paper_retriever.pubmed.search", lambda *args, **kwargs: ["review"])
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.pubmed.fetch_details",
        lambda pmids: [
            {
                "pmid": "review",
                "title": "COVID-19 corticosteroid treatment review",
                "year": 2020,
                "source": "pubmed",
            }
        ],
    )
    seen_queries = []

    def fake_aggregate(query, max_per_source, year_range=None, **kwargs):
        seen_queries.append(query)
        if "dexamethasone" not in query.lower():
            return [], {"OpenAlex": 0, "Semantic Scholar": 0}
        return (
            [
                {
                    "pmid": "32876695",
                    "doi": "10.1001/jama.2020.17021",
                    "title": "Effect of Dexamethasone on Days Alive and Ventilator-Free in Patients With Moderate or Severe Acute Respiratory Distress Syndrome and COVID-19: The CoDEX Randomized Clinical Trial",
                    "year": 2020,
                    "source": "openalex",
                }
            ],
            {"OpenAlex": 1, "Semantic Scholar": 0},
        )

    monkeypatch.setattr("new_meta.agents.paper_retriever.multi_search.aggregate_search", fake_aggregate)
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.clinicaltrials.search_studies_cached",
        lambda query, cache_dir=None, max_results=20: ([], {"query": query, "status": "ok", "n_records": 0, "error": ""}),
    )
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.registry_seed.search_seed_records",
        lambda query, max_results=20, year_range=None: ([], {"status": "ok", "n_records": 0, "attempts": []}),
    )

    project = Project("academic supplement", output_dir=tmp_path)
    papers = PaperRetriever().search_and_fetch(
        '("COVID-19"[tiab]) AND ("dexamethasone"[tiab] OR "hydrocortisone"[tiab]) '
        'AND ("critically ill"[tiab]) AND ("randomized controlled trial"[tiab])',
        project,
        max_results=10,
        date_range="to 2020",
    )
    source_counts = project.load_json("search_source_counts.json")

    assert any(paper.get("pmid") == "32876695" for paper in papers)
    assert any("COVID-19 dexamethasone randomized trial" == query for query in seen_queries)
    assert source_counts["pubmed"] == 1
    assert source_counts["OpenAlex"] == 1
    assert project.prisma.records_identified == 2


def test_search_date_filter_keeps_online_first_pubmed_article_with_epub_year(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr("new_meta.agents.paper_retriever.ENABLE_MULTI_SEARCH_SUPPLEMENT", False)
    monkeypatch.setattr("new_meta.agents.paper_retriever.ENABLE_CLINICALTRIALS_FALLBACK", False)
    monkeypatch.setattr("new_meta.agents.paper_retriever.ENABLE_REGISTRY_SEED_FALLBACK", False)
    monkeypatch.setattr("new_meta.agents.paper_retriever.internal_db.search_internal_db", lambda query: [])
    monkeypatch.setattr("new_meta.agents.paper_retriever.pubmed.search", lambda *args, **kwargs: ["32678530"])
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.pubmed.fetch_details",
        lambda pmids: [
            {
                "pmid": "32678530",
                "title": "Dexamethasone in Hospitalized Patients with Covid-19",
                "year": 2021,
                "epub_year": 2020,
                "doi": "10.1056/NEJMoa2021436",
                "source": "pubmed",
            }
        ],
    )

    project = Project("online first date filter", output_dir=tmp_path)
    papers = PaperRetriever().search_and_fetch(
        "Dexamethasone in Hospitalized Patients with Covid-19 RECOVERY",
        project,
        max_results=10,
        date_range="to 2020",
    )

    assert [paper["pmid"] for paper in papers] == ["32678530"]


def test_search_and_fetch_adds_precision_pubmed_landmark_trial_when_broad_pubmed_succeeds(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr("new_meta.agents.paper_retriever.ENABLE_MULTI_SEARCH_SUPPLEMENT", False)
    monkeypatch.setattr("new_meta.agents.paper_retriever.ENABLE_CLINICALTRIALS_FALLBACK", False)
    monkeypatch.setattr("new_meta.agents.paper_retriever.ENABLE_REGISTRY_SEED_FALLBACK", False)
    monkeypatch.setattr("new_meta.agents.paper_retriever.internal_db.search_internal_db", lambda query: [])
    seen_queries = []

    def fake_pubmed_search(query, max_results=None, min_date=None, max_date=None):
        seen_queries.append(query)
        if "NEJMoa2021436" in query or "Hospitalized Patients with Covid-19" in query:
            return ["32678530"]
        return ["review"]

    def fake_fetch_details(pmids):
        details = {
            "review": {
                "pmid": "review",
                "title": "COVID-19 corticosteroid treatment review",
                "year": 2020,
                "source": "pubmed",
            },
            "32678530": {
                "pmid": "32678530",
                "title": "Dexamethasone in Hospitalized Patients with Covid-19",
                "year": 2021,
                "epub_year": 2020,
                "doi": "10.1056/NEJMoa2021436",
                "source": "pubmed",
            },
        }
        return [details[pmid] for pmid in pmids]

    monkeypatch.setattr("new_meta.agents.paper_retriever.pubmed.search", fake_pubmed_search)
    monkeypatch.setattr("new_meta.agents.paper_retriever.pubmed.fetch_details", fake_fetch_details)

    project = Project("precision PubMed supplement", output_dir=tmp_path)
    papers = PaperRetriever().search_and_fetch(
        '("COVID-19"[tiab]) AND ("dexamethasone"[tiab] OR "corticosteroid*"[tiab]) '
        'AND ("critically ill"[tiab]) AND ("randomized controlled trial"[tiab])',
        project,
        max_results=10,
        date_range="to 2020",
    )

    assert any("NEJMoa2021436" in query for query in seen_queries)
    assert {paper["pmid"] for paper in papers} == {"review", "32678530"}


def test_registry_supplement_caps_noisy_clinicaltrials_results_and_keeps_seed(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr("new_meta.agents.paper_retriever.ENABLE_MULTI_SEARCH_SUPPLEMENT", False)
    monkeypatch.setattr("new_meta.agents.paper_retriever.internal_db.search_internal_db", lambda query: [])
    monkeypatch.setattr("new_meta.agents.paper_retriever.pubmed.search", lambda *args, **kwargs: ["123"])
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.pubmed.fetch_details",
        lambda pmids: [{"pmid": "123", "title": "COVID corticosteroid randomized trial", "year": 2020}],
    )
    monkeypatch.setattr("new_meta.agents.paper_retriever.REGISTRY_SUPPLEMENT_MAX_RESULTS", 3, raising=False)

    noisy_titles = [
        "Alpha antiviral respiratory failure trial",
        "Beta immune modulation oxygen trial",
        "Gamma anticoagulation hospitalized trial",
        "Delta ventilation strategy clinical trial",
        "Epsilon convalescent plasma trial",
        "Zeta interleukin inhibitor trial",
        "Eta antibiotic severe pneumonia trial",
        "Theta antiviral outpatient trial",
        "Iota immune globulin treatment trial",
        "Kappa rehabilitation recovery trial",
    ]
    noisy_registry = [
        {
            "title": title,
            "pmid": "",
            "doi": "",
            "year": 2020,
            "source": "clinicaltrials",
            "source_type": "clinicaltrials",
            "trial_registration": f"NCT990000{idx:02d}",
            "abstract": "Randomized clinical trial registry record.",
        }
        for idx, title in enumerate(noisy_titles)
    ]
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.clinicaltrials.search_studies_cached",
        lambda query, cache_dir=None, max_results=20: (
            noisy_registry,
            {"query": query, "status": "ok", "n_records": len(noisy_registry), "error": ""},
        ),
    )
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.registry_seed.search_seed_records",
        lambda query, max_results=20, year_range=None: (
            [
                {
                    "title": "Glucocorticoid Therapy for COVID-19 Critically Ill Patients With Severe Acute Respiratory Failure",
                    "pmid": "",
                    "doi": "",
                    "year": 2020,
                    "source": "registry_seed",
                    "source_type": "registry_seed",
                    "trial_registration": "NCT04244591",
                    "metadata_only": True,
                    "text_availability": "metadata_only",
                }
            ],
            {"status": "ok", "n_records": 1, "attempts": []},
        ),
    )

    project = Project("registry supplement cap", output_dir=tmp_path)
    papers = PaperRetriever().search_and_fetch(
        '("COVID-19"[tiab]) AND ("methylprednisolone"[tiab]) AND ("randomized controlled trial"[tiab])',
        project,
        max_results=30,
        date_range="to 2020",
    )
    registrations = {paper.get("trial_registration") for paper in papers if paper.get("trial_registration")}
    source_counts = project.load_json("search_source_counts.json")

    assert "NCT04244591" in registrations
    assert len(registrations) <= 3
    assert source_counts["RegistrySeed"] == 1
    assert source_counts["ClinicalTrials.gov"] <= 2


def test_multi_source_fallback_runs_recall_query_first_and_all_variants(monkeypatch) -> None:
    seen_queries = []

    def fake_aggregate(query, max_per_source, year_range=None, **kwargs):
        seen_queries.append(query)
        idx = len(seen_queries)
        titles = {
            1: "COVID steroid trial alpha mortality",
            2: "Hydrocortisone ICU platform beta report",
            3: "Methylprednisolone respiratory gamma study",
            4: "Dexamethasone ventilated delta study",
            5: "Corticosteroid critical illness epsilon trial",
            6: "RECOVERY dexamethasone primary publication",
            7: "RECOVERY dexamethasone DOI record",
            8: "CoDEX dexamethasone primary publication",
            9: "CoDEX dexamethasone DOI record",
            10: "REMAP-CAP hydrocortisone primary publication",
            11: "REMAP-CAP hydrocortisone DOI record",
            12: "DEXA-COVID dexamethasone protocol",
            13: "DEXA-COVID dexamethasone DOI record",
            14: "Low-dose hydrocortisone severe hypoxia protocol",
            15: "Hydrocortisone protocol statistical analysis plan",
            16: "CAPE COVID hydrocortisone primary publication",
            17: "CAPE COVID hydrocortisone DOI record",
        }
        return (
            [
                    {
                        "pmid": f"PMID{idx}",
                        "title": titles[idx],
                        "year": 2020,
                        "source": "openalex",
                    }
            ],
            {"OpenAlex": 1, "Semantic Scholar": 0},
        )

    monkeypatch.setattr("new_meta.agents.paper_retriever.multi_search.aggregate_search", fake_aggregate)
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.clinicaltrials.search_studies_cached",
        lambda query, cache_dir=None, max_results=20: ([], {"query": query, "status": "ok", "n_records": 0, "error": ""}),
    )
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.registry_seed.search_seed_records",
        lambda query, max_results=20, year_range=None: ([], {"status": "ok", "n_records": 0, "attempts": []}),
    )

    query = (
        '("COVID-19"[tiab] OR "SARS-CoV-2"[tiab]) AND '
        '("critically ill"[tiab] OR "respiratory failure"[tiab]) AND '
        '("dexamethasone"[tiab] OR "hydrocortisone"[tiab]) AND '
        '("usual care"[tiab]) AND ("28-day mortality"[tiab]) AND '
        '("randomized controlled trial"[tiab])'
    )
    papers, counts = PaperRetriever()._multi_source_fallback(
        query=query,
        max_results=1,
        start_year=2020,
        end_year=2020,
    )

    assert seen_queries[0] == "COVID-19 dexamethasone hydrocortisone randomized trial"
    assert len(seen_queries) == 17
    assert "COVID-19 dexamethasone randomized trial" in seen_queries
    assert "COVID-19 hydrocortisone randomized trial" in seen_queries
    assert "Dexamethasone in Hospitalized Patients with Covid-19 RECOVERY" in seen_queries
    assert "10.1056/NEJMoa2021436" in seen_queries
    assert "Effect of Dexamethasone on Days Alive and Ventilator-Free CoDEX" in seen_queries
    assert "10.1001/jama.2020.17021" in seen_queries
    assert "Effect of Hydrocortisone on Mortality and Organ Support REMAP-CAP" in seen_queries
    assert "10.1001/jama.2020.17022" in seen_queries
    assert "Efficacy of dexamethasone treatment for patients with acute respiratory distress syndrome caused by COVID-19 DEXA-COVID" in seen_queries
    assert "10.1186/s13063-020-04643-1" in seen_queries
    assert "low-dose hydrocortisone COVID-19 severe hypoxia trial" in seen_queries
    assert "Effect of Hydrocortisone on 21-Day Mortality or Respiratory Support CAPE COVID" in seen_queries
    assert "10.1001/jama.2020.16761" in seen_queries
    assert any("28-day mortality" in q for q in seen_queries[1:])
    assert len(papers) == 17
    assert counts["OpenAlex"] == 17


def test_multi_source_fallback_adds_clinicaltrials_registry_records(monkeypatch) -> None:
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.multi_search.aggregate_search",
        lambda *args, **kwargs: ([], {"OpenAlex": 0, "Semantic Scholar": 0}),
    )

    def fake_registry(query, cache_dir=None, max_results=20):
        if "hydrocortisone" in query.lower():
            return (
                [
                    {
                        "title": "Hydrocortisone for COVID-19 and Severe Hypoxia",
                        "pmid": "",
                        "doi": "",
                        "year": 2020,
                        "source": "clinicaltrials",
                        "source_type": "clinicaltrials",
                        "trial_registration": "NCT04348305",
                        "abstract": "Randomized trial of hydrocortisone in severe COVID-19.",
                    },
                    {
                        "title": "Steroids-SARI",
                        "pmid": "",
                        "doi": "",
                        "year": 2020,
                        "source": "clinicaltrials",
                        "source_type": "clinicaltrials",
                        "trial_registration": "NCT04244591",
                        "abstract": "Methylprednisolone severe acute respiratory infection randomized trial.",
                    },
                ],
                {"query": query, "status": "ok", "n_records": 2, "error": ""},
            )
        return [], {"query": query, "status": "ok", "n_records": 0, "error": ""}

    monkeypatch.setattr("new_meta.agents.paper_retriever.clinicaltrials.search_studies_cached", fake_registry)
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.registry_seed.search_seed_records",
        lambda query, max_results=20, year_range=None: ([], {"status": "ok", "n_records": 0, "attempts": []}),
    )

    query = (
        '("COVID-19"[tiab] OR "SARS-CoV-2"[tiab]) AND '
        '("hydrocortisone"[tiab] OR "methylprednisolone"[tiab]) AND '
        '("randomized controlled trial"[tiab])'
    )
    papers, counts = PaperRetriever()._multi_source_fallback(
        query=query,
        max_results=10,
        start_year=2020,
        end_year=2020,
    )

    registrations = {paper.get("trial_registration") for paper in papers}
    assert {"NCT04348305", "NCT04244591"} <= registrations
    assert counts["ClinicalTrials.gov"] >= 2


def test_multi_source_fallback_circuit_breaks_registry_timeouts(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr("new_meta.agents.paper_retriever.CLINICALTRIALS_FAILURE_LIMIT", 2)

    def fake_aggregate(query, max_per_source, year_range=None, **kwargs):
        return (
            [{"pmid": query[-8:], "title": f"{query} result", "year": 2020, "source": "openalex"}],
            {"OpenAlex": 1, "Semantic Scholar": 0},
        )

    calls = {"n": 0}

    def fake_registry(query, cache_dir=None, max_results=20):
        calls["n"] += 1
        return [], {"query": query, "status": "failed", "n_records": 0, "error": "timeout"}

    monkeypatch.setattr("new_meta.agents.paper_retriever.multi_search.aggregate_search", fake_aggregate)
    monkeypatch.setattr("new_meta.agents.paper_retriever.clinicaltrials.search_studies_cached", fake_registry)
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.registry_seed.search_seed_records",
        lambda query, max_results=20, year_range=None: ([], {"status": "ok", "n_records": 0, "attempts": []}),
    )

    project = Project("registry circuit", output_dir=tmp_path)
    query = (
        '("COVID-19"[tiab]) AND '
        '("dexamethasone"[tiab] OR "hydrocortisone"[tiab]) AND '
        '("randomized controlled trial"[tiab])'
    )
    papers, counts = PaperRetriever()._multi_source_fallback(
        query=query,
        max_results=1,
        start_year=2020,
        end_year=2020,
        project=project,
    )
    manifest = project.load_json("clinicaltrials_fallback_manifest.json")
    warnings = project.load_json("pipeline_warnings.json")

    assert papers
    assert counts["OpenAlex"] == len(papers)
    assert calls["n"] == 2
    assert any(item["status"] == "skipped" for item in manifest["queries"])
    assert any(item.get("error") == "clinicaltrials_failure_limit_reached" for item in manifest["queries"])
    assert warnings[0]["code"] == "clinicaltrials_fallback_failed"


def test_multi_source_fallback_adds_registry_seed_records_when_project_available(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.multi_search.aggregate_search",
        lambda *args, **kwargs: ([], {"OpenAlex": 0, "Semantic Scholar": 0}),
    )
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.clinicaltrials.search_studies_cached",
        lambda query, cache_dir=None, max_results=20: ([], {"query": query, "status": "failed", "n_records": 0, "error": "timeout"}),
    )

    project = Project("registry seed", output_dir=tmp_path)
    query = (
        '("COVID-19"[tiab]) AND '
        '("methylprednisolone"[tiab] OR "glucocorticoid"[tiab]) AND '
        '("respiratory failure"[tiab] OR "critically ill"[tiab]) AND '
        '("standard care"[tiab]) AND ("randomized controlled trial"[tiab])'
    )
    papers, counts = PaperRetriever()._multi_source_fallback(
        query=query,
        max_results=10,
        start_year=2020,
        end_year=2020,
        project=project,
    )
    registrations = {paper.get("trial_registration") for paper in papers}
    seed_manifest = project.load_json("registry_seed_fallback_manifest.json")

    assert "NCT04244591" in registrations
    assert counts["RegistrySeed"] >= 1
    assert seed_manifest["enabled"] is True
    assert any(item["n_records"] >= 1 for item in seed_manifest["queries"])


def test_download_pdfs_skips_metadata_only_registry_seed(monkeypatch, tmp_path: Path) -> None:
    def fail_if_called(*args, **kwargs):
        raise AssertionError("metadata-only registry seed should not trigger full-text network retrieval")

    monkeypatch.setattr("new_meta.agents.paper_retriever.get_europe_pmc_pdf_urls", fail_if_called)
    monkeypatch.setattr("new_meta.agents.paper_retriever.download_pdf", fail_if_called)

    project = Project("registry seed download skip", output_dir=tmp_path)
    with_text, without_text = PaperRetriever().download_pdfs(
        [
            {
                "title": "Glucocorticoid Therapy for COVID-19 Critically Ill Patients With Severe Acute Respiratory Failure",
                "source": "registry_seed",
                "source_type": "registry_seed",
                "trial_registration": "NCT04244591",
                "metadata_only": True,
                "text_availability": "metadata_only",
            }
        ],
        project,
    )

    assert with_text == []
    assert without_text[0]["trial_registration"] == "NCT04244591"
    assert without_text[0]["text_availability"] == "metadata_only"
    assert without_text[0]["needs_user_full_text"] is True


def test_download_pdfs_materializes_clinicaltrials_registry_text(tmp_path: Path) -> None:
    project = Project("clinicaltrials text materialization", output_dir=tmp_path)

    with_text, without_text = PaperRetriever().download_pdfs(
        [
            {
                "title": "Hydrocortisone for COVID-19 and Severe Hypoxia",
                "source": "clinicaltrials",
                "source_type": "clinicaltrials",
                "trial_registration": "NCT04348305",
                "abstract": "ClinicalTrials.gov structured record. " + ("Primary outcome text. " * 80),
            }
        ],
        project,
    )

    assert without_text == []
    assert len(with_text) == 1
    assert with_text[0]["fulltext_source"] == "clinicaltrials_registry"
    assert with_text[0]["text_availability"] == "full_text"
    assert Path(with_text[0]["fulltext_path"]).exists()
    saved = Path(with_text[0]["fulltext_path"]).read_text(encoding="utf-8")
    assert "SOURCE: ClinicalTrials.gov registry record" in saved
    assert "Primary outcome text." in saved


def test_download_pdfs_fetches_registry_seed_source_urls_before_skipping(monkeypatch, tmp_path: Path) -> None:
    project = Project("registry seed source url", output_dir=tmp_path)
    seen = {"urls": []}

    def fake_fetch(url, *, save_path, timeout=15, source_label=""):
        seen["urls"].append(url)
        Path(save_path).write_text("Registry result text. " + ("28-day mortality " * 80), encoding="utf-8")
        return True

    monkeypatch.setattr("new_meta.agents.paper_retriever.fetch_html_fulltext_url", fake_fetch)
    monkeypatch.setattr("new_meta.agents.paper_retriever.get_europe_pmc_pdf_urls", lambda **kwargs: ([], "", ""))
    monkeypatch.setattr("new_meta.agents.paper_retriever.download_pdf", lambda **kwargs: False)

    with_text, without_text = PaperRetriever().download_pdfs(
        [
            {
                "title": "Hydrocortisone for COVID-19 and Severe Hypoxia",
                "source": "registry_seed",
                "source_type": "registry_seed",
                "trial_registration": "NCT04348305",
                "metadata_only": True,
                "text_availability": "metadata_only",
                "source_urls": [
                    "https://clinicaltrials.gov/study/NCT04348305",
                    "https://example.org/eudract-results",
                ],
            }
        ],
        project,
    )

    assert without_text == []
    assert len(with_text) == 1
    assert seen["urls"] == ["https://clinicaltrials.gov/study/NCT04348305"]
    assert with_text[0]["fulltext_source"] == "registry_seed_source"
    assert with_text[0]["text_availability"] == "full_text"
    assert with_text[0]["needs_user_full_text"] is False
    assert with_text[0]["metadata_only"] is False
    assert Path(with_text[0]["fulltext_path"]).exists()


def test_search_and_fetch_writes_clinicaltrials_manifest(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr("new_meta.agents.paper_retriever.internal_db.search_internal_db", lambda query: [])
    monkeypatch.setattr("new_meta.agents.paper_retriever.pubmed.search", lambda *args, **kwargs: (_ for _ in ()).throw(TimeoutError("down")))
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.multi_search.aggregate_search",
        lambda *args, **kwargs: ([], {"OpenAlex": 0, "Semantic Scholar": 0}),
    )
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.clinicaltrials.search_studies_cached",
        lambda query, cache_dir=None, max_results=20: (
            [
                {
                    "title": "Hydrocortisone for COVID-19 and Severe Hypoxia",
                    "year": 2020,
                    "source": "clinicaltrials",
                    "source_type": "clinicaltrials",
                    "trial_registration": "NCT04348305",
                }
            ],
            {"query": query, "status": "ok", "n_records": 1, "error": ""},
        ),
    )

    project = Project("registry manifest", output_dir=tmp_path)
    papers = PaperRetriever().search_and_fetch(
        '("COVID-19"[tiab]) AND ("hydrocortisone"[tiab]) AND ("randomized controlled trial"[tiab])',
        project,
        max_results=10,
        date_range="to 2020",
    )
    manifest = project.load_json("clinicaltrials_fallback_manifest.json")
    source_counts = project.load_json("search_source_counts.json")

    assert any(paper.get("trial_registration") == "NCT04348305" for paper in papers)
    assert manifest["enabled"] is True
    assert manifest["queries"][0]["status"] == "ok"
    assert source_counts["ClinicalTrials.gov"] == 1


def test_search_and_fetch_clears_stale_clinicaltrials_warning_after_success(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr("new_meta.agents.paper_retriever.internal_db.search_internal_db", lambda query: [])
    monkeypatch.setattr("new_meta.agents.paper_retriever.pubmed.search", lambda *args, **kwargs: (_ for _ in ()).throw(TimeoutError("down")))
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.multi_search.aggregate_search",
        lambda *args, **kwargs: ([], {"OpenAlex": 0, "Semantic Scholar": 0}),
    )
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.clinicaltrials.search_studies_cached",
        lambda query, cache_dir=None, max_results=20: (
            [
                {
                    "title": "Recovered ClinicalTrials.gov record",
                    "year": 2020,
                    "source": "clinicaltrials",
                    "source_type": "clinicaltrials",
                    "trial_registration": "NCT04348305",
                }
            ],
            {"query": query, "status": "ok", "n_records": 1, "error": ""},
        ),
    )
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.registry_seed.search_seed_records",
        lambda query, max_results=20, year_range=None: ([], {"status": "ok", "n_records": 0, "attempts": []}),
    )

    project = Project("registry warning clear", output_dir=tmp_path)
    project.add_warning("retrieval", "old failure", code="clinicaltrials_fallback_failed")

    PaperRetriever().search_and_fetch(
        '("COVID-19"[tiab]) AND ("hydrocortisone"[tiab]) AND ("randomized controlled trial"[tiab])',
        project,
        max_results=10,
        date_range="to 2020",
    )
    warnings = project.load_json("pipeline_warnings.json") or []

    assert all(item.get("code") != "clinicaltrials_fallback_failed" for item in warnings)


def test_download_pdfs_hydrates_pdf_url_from_search_results(monkeypatch, tmp_path: Path) -> None:
    project = Project("hydrate test", output_dir=tmp_path)
    monkeypatch.setattr("new_meta.agents.paper_retriever.get_europe_pmc_pdf_urls", lambda **kwargs: ([], "", ""))
    project.save_json(
        "search_results.json",
        [
            {
                "pmid": "123",
                "title": "Known OA paper",
                "pdf_url": "https://example.org/paper.pdf",
                "pdf_urls": ["https://example.org/paper.pdf", "https://example.org/repository.pdf"],
            }
        ],
    )
    seen = {}

    def fake_download_pdf(doi=None, pmid=None, url=None, save_path=None):
        seen["url"] = url
        return True

    monkeypatch.setattr("new_meta.agents.paper_retriever.download_pdf", fake_download_pdf)

    with_pdf, without_pdf = PaperRetriever().download_pdfs(
        [{"pmid": "123", "title": "Known OA paper"}],
        project,
    )

    assert seen["url"] == ["https://example.org/paper.pdf", "https://example.org/repository.pdf"]
    assert len(with_pdf) == 1
    assert without_pdf == []


def test_download_pdfs_uses_html_fulltext_fallback_when_pdf_fails(monkeypatch, tmp_path: Path) -> None:
    project = Project("html fallback test", output_dir=tmp_path)
    monkeypatch.setattr("new_meta.agents.paper_retriever.download_pdf", lambda **kwargs: False)
    monkeypatch.setattr("new_meta.agents.paper_retriever.get_europe_pmc_pdf_urls", lambda **kwargs: ([], "", ""))

    def fake_fulltext(*, pmid="", doi="", save_path="", timeout=15):
        Path(save_path).write_text("Full text " * 200, encoding="utf-8")
        return True

    monkeypatch.setattr("new_meta.agents.paper_retriever.fetch_europe_pmc_fulltext", fake_fulltext)

    with_text, without_text = PaperRetriever().download_pdfs(
        [{"pmid": "32876697", "doi": "10.1001/jama.2020.17022", "title": "Known HTML paper"}],
        project,
    )

    assert len(with_text) == 1
    assert without_text == []
    assert with_text[0]["pdf_path"] is None
    assert with_text[0]["fulltext_source"] == "europe_pmc_fulltext"
    assert with_text[0]["text_availability"] == "full_text"
    assert Path(with_text[0]["fulltext_path"]).exists()


def test_download_pdfs_uses_abstract_fallback_when_fulltext_fails(monkeypatch, tmp_path: Path) -> None:
    project = Project("abstract fallback test", output_dir=tmp_path)
    monkeypatch.setattr("new_meta.agents.paper_retriever.download_pdf", lambda **kwargs: False)
    monkeypatch.setattr("new_meta.agents.paper_retriever.get_europe_pmc_pdf_urls", lambda **kwargs: ([], "", ""))
    monkeypatch.setattr("new_meta.agents.paper_retriever.fetch_europe_pmc_fulltext", lambda **kwargs: False)

    def fake_abstract(*, pmid="", doi="", save_path="", timeout=15):
        Path(save_path).write_text("SOURCE: abstract only\n" + ("Outcome text " * 80), encoding="utf-8")
        return True

    monkeypatch.setattr("new_meta.agents.paper_retriever.fetch_europe_pmc_abstract_text", fake_abstract)

    with_text, without_text = PaperRetriever().download_pdfs(
        [{"pmid": "32876695", "doi": "10.1001/jama.2020.17021", "title": "Blocked full text"}],
        project,
    )

    assert len(with_text) == 1
    assert without_text == []
    assert with_text[0]["fulltext_source"] == "europe_pmc_abstract"
    assert with_text[0]["text_availability"] == "abstract_only"
    assert Path(with_text[0]["fulltext_path"]).exists()


def test_download_pdfs_prioritizes_europe_pmc_pdf_candidates(monkeypatch, tmp_path: Path) -> None:
    project = Project("europe pmc pdf test", output_dir=tmp_path)
    seen = {}

    def fake_links(**kwargs):
        return ["https://europepmc.org/articles/PMC1?pdf=render"], "https://europepmc.org/articles/PMC1", "PMC1"

    def fake_download_pdf(doi=None, pmid=None, url=None, save_path=None):
        seen["url"] = url
        Path(save_path).write_bytes(b"%PDF-1.4\nfake")
        return True

    monkeypatch.setattr("new_meta.agents.paper_retriever.get_europe_pmc_pdf_urls", fake_links)
    monkeypatch.setattr("new_meta.agents.paper_retriever.download_pdf", fake_download_pdf)

    with_pdf, without_pdf = PaperRetriever().download_pdfs(
        [{
            "pmid": "32943404",
            "doi": "10.1183/13993003.02808-2020",
            "title": "Known Europe PMC paper",
            "pdf_urls": ["https://publisher.example/paper.pdf"],
        }],
        project,
    )

    assert without_pdf == []
    assert len(with_pdf) == 1
    assert seen["url"] == [
        "https://europepmc.org/articles/PMC1?pdf=render",
        "https://publisher.example/paper.pdf",
    ]
    assert with_pdf[0]["pmcid"] == "PMC1"
    assert with_pdf[0]["fulltext_url"] == "https://europepmc.org/articles/PMC1"
    assert with_pdf[0]["text_availability"] == "full_text"
