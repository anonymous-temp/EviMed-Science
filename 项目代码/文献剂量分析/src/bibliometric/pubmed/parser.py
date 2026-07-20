# [IN] list of XML strings from EFetch
# [OUT] list of dict with parsed article fields
# [POS] src/bibliometric/pubmed/parser.py - PubMed XML parsing

from __future__ import annotations

import logging
from typing import Optional

from lxml import etree

logger = logging.getLogger(__name__)


def parse_articles(xml_chunks: list[str]) -> list[dict]:
    """Parse EFetch XML chunks into structured article dicts."""
    articles = []
    for i, xml_text in enumerate(xml_chunks):
        try:
            root = etree.fromstring(xml_text.encode("utf-8"))
        except etree.XMLSyntaxError:
            logger.warning("Skipping malformed XML chunk %d", i)
            continue
        for article_el in root.findall(".//PubmedArticle"):
            parsed = _parse_single_article(article_el)
            if parsed:
                articles.append(parsed)
    logger.info("Parsed %d articles from XML", len(articles))
    return articles


def _parse_single_article(el: etree._Element) -> Optional[dict]:
    """Parse one PubmedArticle element into a dict."""
    medline = el.find("MedlineCitation")
    if medline is None:
        return None

    pmid = medline.findtext("PMID", "").strip()
    article = medline.find("Article")
    if article is None:
        return None

    return {
        "pmid": pmid,
        "title": _get_title(article),
        "abstract": _get_abstract(article),
        "authors": _get_authors(article),
        "affiliations": _get_affiliations(article),
        "journal": _get_journal(article),
        "year": _get_year(article, medline),
        "mesh_terms": _get_mesh_terms(medline),
        "keywords": _get_keywords(medline),
        "pub_types": _get_pub_types(article),
        "doi": _get_doi(el),
        "country": _get_country(medline),
    }


def _get_title(article: etree._Element) -> str:
    title_el = article.find("ArticleTitle")
    if title_el is None:
        return ""
    return "".join(title_el.itertext()).strip()


def _get_abstract(article: etree._Element) -> str:
    abstract_el = article.find("Abstract")
    if abstract_el is None:
        return ""
    parts = []
    for text_el in abstract_el.findall("AbstractText"):
        label = text_el.get("Label", "")
        text = "".join(text_el.itertext()).strip()
        if label:
            parts.append(f"{label}: {text}")
        else:
            parts.append(text)
    return " ".join(parts)


def _get_authors(article: etree._Element) -> list[dict]:
    authors = []
    author_list = article.find("AuthorList")
    if author_list is None:
        return authors
    for author_el in author_list.findall("Author"):
        last = author_el.findtext("LastName", "")
        fore = author_el.findtext("ForeName", "")
        initials = author_el.findtext("Initials", "")
        affils = []
        for aff_el in author_el.findall(".//AffiliationInfo/Affiliation"):
            aff_text = "".join(aff_el.itertext()).strip()
            if aff_text:
                affils.append(aff_text)
        authors.append({
            "last_name": last,
            "fore_name": fore,
            "initials": initials,
            "affiliations": affils,
        })
    return authors


def _get_affiliations(article: etree._Element) -> list[str]:
    affils = set()
    author_list = article.find("AuthorList")
    if author_list is None:
        return []
    for aff_el in author_list.findall(".//AffiliationInfo/Affiliation"):
        aff_text = "".join(aff_el.itertext()).strip()
        if aff_text:
            affils.add(aff_text)
    return list(affils)


def _get_journal(article: etree._Element) -> dict:
    journal_el = article.find("Journal")
    if journal_el is None:
        return {"title": "", "iso": "", "issn": ""}
    return {
        "title": journal_el.findtext("Title", "").strip(),
        "iso": journal_el.findtext("ISOAbbreviation", "").strip(),
        "issn": journal_el.findtext("ISSN", "").strip(),
    }


def _get_year(article: etree._Element, medline: etree._Element) -> str:
    journal = article.find("Journal")
    if journal is not None:
        pub_date = journal.find("JournalIssue/PubDate")
        if pub_date is not None:
            year = pub_date.findtext("Year", "")
            if year:
                return year
            medline_date = pub_date.findtext("MedlineDate", "")
            if medline_date and len(medline_date) >= 4:
                return medline_date[:4]
    date_completed = medline.find("DateCompleted")
    if date_completed is not None:
        return date_completed.findtext("Year", "")
    return ""


def _get_mesh_terms(medline: etree._Element) -> list[str]:
    terms = []
    mesh_list = medline.find("MeshHeadingList")
    if mesh_list is None:
        return terms
    for heading in mesh_list.findall("MeshHeading"):
        descriptor = heading.find("DescriptorName")
        if descriptor is not None:
            text = "".join(descriptor.itertext()).strip()
            if text:
                terms.append(text)
        for qualifier in heading.findall("QualifierName"):
            text = "".join(qualifier.itertext()).strip()
            if text:
                terms.append(text)
    return terms


def _get_keywords(medline: etree._Element) -> list[str]:
    kws = []
    for kw_list in medline.findall("KeywordList"):
        for kw in kw_list.findall("Keyword"):
            text = "".join(kw.itertext()).strip()
            if text:
                kws.append(text)
    return kws


def _get_pub_types(article: etree._Element) -> list[str]:
    types = []
    pub_type_list = article.find("PublicationTypeList")
    if pub_type_list is None:
        return types
    for pt in pub_type_list.findall("PublicationType"):
        if pt.text:
            types.append(pt.text.strip())
    return types


def _get_doi(pubmed_article: etree._Element) -> str:
    for id_el in pubmed_article.findall(".//ArticleIdList/ArticleId"):
        if id_el.get("IdType") == "doi" and id_el.text:
            return id_el.text.strip()
    return ""


def _get_country(medline: etree._Element) -> str:
    journal_info = medline.find("MedlineJournalInfo")
    if journal_info is not None:
        country = journal_info.findtext("Country", "")
        if country:
            return country.strip()
    return ""
