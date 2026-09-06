import xml.etree.ElementTree as ET

from services.pubmed_service import PubMedSearchService
from core.research_portfolio import build_research_portfolio
from models.schemas import LiteratureRecord
import pytest


def test_pubmed_records_preserve_current_publication_status_for_retraction_gating():
    record = PubMedSearchService()._parse_article(ET.fromstring("""
      <PubmedArticle>
        <MedlineCitation><PMID>41936250</PMID><Article>
          <ArticleTitle>RETRACTED: Dynamic trajectories in sepsis</ArticleTitle>
          <Abstract><AbstractText>Retracted work.</AbstractText></Abstract>
          <Journal><Title>Example Journal</Title><JournalIssue><PubDate><Year>2026</Year></PubDate></JournalIssue></Journal>
          <PublicationTypeList><PublicationType>Retracted Publication</PublicationType></PublicationTypeList>
        </Article></MedlineCitation>
        <PubmedData><ArticleIdList><ArticleId IdType="doi">10.1000/retracted</ArticleId></ArticleIdList></PubmedData>
      </PubmedArticle>
    """))
    assert record.publication_types == ["Retracted Publication"]
    assert record.publication_status == "retracted"
    assert record.status_source == "PubMed"
    assert record.status_checked_at


def test_retracted_evidence_cannot_back_a_recommended_portfolio_candidate():
    evidence = LiteratureRecord(
        id="pubmed_41936250", pmid="41936250", title="Retracted sepsis study",
        publication_status="retracted", status_checked_at="2026-09-06T00:00:00Z", status_source="PubMed",
    )
    source = {"opportunity_id": "BOM1", "evidence_pmids": ["41936250"], "support_level": "direct"}
    topic = {"source_opportunity_id": "BOM1", "source_evidence_pmids": ["41936250"], "support_level": "direct"}
    with pytest.raises(ValueError, match="retracted"):
        build_research_portfolio("Sepsis", {}, [topic], [source], [evidence])
