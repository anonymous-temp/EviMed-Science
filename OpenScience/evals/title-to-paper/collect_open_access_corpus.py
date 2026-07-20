#!/usr/bin/env python3
"""Build a stratified 50-paper evaluator corpus from the Europe PMC OA API."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any


API_ROOT = "https://www.ebi.ac.uk/europepmc/webservices/rest"
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
BASE_FILTER = (
    "SRC:MED AND OPEN_ACCESS:Y AND IN_EPMC:Y AND HAS_ABSTRACT:Y "
    "AND FIRST_PDATE:[2021-01-01 TO 2025-12-31]"
)
CATEGORY_QUERIES = {
    "randomized-trial": (
        'PUB_TYPE:"Randomized Controlled Trial" '
        'NOT (TITLE:COVID OR TITLE:SARS-CoV-2 OR ABSTRACT:COVID-19)'
    ),
    "systematic-review-meta-analysis": (
        '(PUB_TYPE:"Systematic Review" OR PUB_TYPE:"Meta-Analysis")'
    ),
    "observational-cohort": (
        '(TITLE:cohort OR TITLE:observational OR ABSTRACT:"prospective cohort") '
        'NOT (TITLE:COVID OR TITLE:SARS-CoV-2 OR ABSTRACT:COVID-19)'
    ),
    "diagnostic-prognostic": (
        '(TITLE:diagnostic OR TITLE:prognostic OR TITLE:prediction) '
        'AND (ABSTRACT:sensitivity OR ABSTRACT:specificity OR ABSTRACT:discrimination)'
    ),
    "case-report": (
        'TITLE:"case report" '
        'NOT (TITLE:COVID OR TITLE:SARS-CoV-2 OR ABSTRACT:COVID-19)'
    ),
    "public-health-epidemiology": (
        '(TITLE:prevalence OR TITLE:epidemiology OR TITLE:"public health" '
        'OR ABSTRACT:"population-based")'
    ),
    "pharmacovigilance-drug-safety": (
        '(TITLE:pharmacovigilance OR TITLE:"adverse event" OR TITLE:"drug safety" '
        'OR ABSTRACT:pharmacovigilance)'
    ),
    "genomics-omics": (
        '(TITLE:genomic OR TITLE:transcriptomic OR TITLE:proteomic '
        'OR TITLE:"single-cell" OR ABSTRACT:"single-cell")'
    ),
    "biomedical-ai": (
        '(TITLE:"machine learning" OR TITLE:"deep learning" '
        'OR TITLE:"artificial intelligence")'
    ),
    "methods-software": (
        '(TITLE:software OR TITLE:tool OR TITLE:pipeline OR TITLE:method '
        'OR TITLE:framework)'
    ),
}
EXCLUDED_TITLE = re.compile(
    r"\b(correction|corrigendum|erratum|retraction|withdrawn|editorial)\b",
    re.IGNORECASE,
)
TITLE_STOPWORDS = {
    "about", "after", "analysis", "associated", "association", "based", "between",
    "clinical", "development", "from", "human", "patients", "report", "study",
    "using", "with", "years",
}


def fetch(url: str, *, accept: str, attempts: int = 3) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": accept,
            "User-Agent": "EviMedScience-Eval/1.0",
        },
    )
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                data = response.read(MAX_RESPONSE_BYTES + 1)
                if len(data) > MAX_RESPONSE_BYTES:
                    raise ValueError("Europe PMC response exceeded the evaluator size limit")
                return data
        except (OSError, urllib.error.HTTPError, urllib.error.URLError, ValueError) as error:
            last_error = error
            if attempt + 1 < attempts:
                time.sleep(1.0 * (2**attempt))
    raise RuntimeError(f"Europe PMC request failed: {url}: {last_error}")


def search(category_query: str, page_size: int) -> list[dict[str, Any]]:
    query = f"{BASE_FILTER} AND {category_query}"
    url = f"{API_ROOT}/search?" + urllib.parse.urlencode(
        {
            "query": query,
            "format": "json",
            "resultType": "core",
            "pageSize": page_size,
            "sort": "CITED desc",
        }
    )
    payload = json.loads(fetch(url, accept="application/json"))
    return payload.get("resultList", {}).get("result", [])


def text_content(node: ET.Element | None) -> str:
    if node is None:
        return ""
    return re.sub(r"\s+", " ", "".join(node.itertext())).strip()


def first_text(root: ET.Element, paths: list[str]) -> str:
    for path in paths:
        value = text_content(root.find(path))
        if value:
            return value
    return ""


def section_text(root: ET.Element, labels: tuple[str, ...]) -> str:
    matches: list[str] = []
    for section in root.findall(".//body//sec"):
        title = text_content(section.find("title")).lower()
        if title and any(label in title for label in labels):
            body = "\n".join(text_content(paragraph) for paragraph in section.findall(".//p"))
            if body.strip():
                matches.append(body.strip())
    return "\n\n".join(matches)


def parse_article(xml_bytes: bytes) -> dict[str, Any]:
    root = ET.fromstring(xml_bytes)
    title = first_text(root, [".//article-meta/title-group/article-title"])
    abstract = first_text(root, [".//article-meta/abstract"])
    license_node = root.find(".//article-meta/permissions/license")
    license_text = text_content(license_node)
    license_url = ""
    if license_node is not None:
        license_url = (
            license_node.attrib.get("{http://www.w3.org/1999/xlink}href", "")
            or license_node.attrib.get("href", "")
        )
    body_paragraphs = [text_content(node) for node in root.findall(".//body//p")]
    body = "\n\n".join(value for value in body_paragraphs if value)
    references = []
    for reference in root.findall(".//ref-list/ref"):
        citation = text_content(reference)
        if citation:
            references.append(citation)
    return {
        "articleType": root.attrib.get("article-type", ""),
        "title": html.unescape(title),
        "abstract": abstract,
        "introduction": section_text(root, ("introduction", "background")),
        "methods": section_text(root, ("method", "materials", "patients", "study design")),
        "results": section_text(root, ("result", "finding")),
        "discussion": section_text(root, ("discussion", "conclusion", "limitation")),
        "body": body,
        "references": references,
        "licenseText": license_text,
        "licenseUrl": license_url,
    }


def normalized_title(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", html.unescape(value).lower()).strip()


def title_tokens(value: str) -> set[str]:
    return {
        token
        for token in normalized_title(value).split()
        if len(token) >= 4 and token not in TITLE_STOPWORDS
    }


def too_similar(title: str, selected: list[dict[str, Any]]) -> bool:
    tokens = title_tokens(title)
    if not tokens:
        return False
    for existing in selected:
        other = title_tokens(existing["title"])
        union = tokens | other
        if union and len(tokens & other) / len(union) >= 0.45:
            return True
    return False


def acceptable(record: dict[str, Any], parsed: dict[str, Any]) -> bool:
    title = html.unescape(str(record.get("title") or parsed.get("title") or "")).strip()
    publication_types = [str(item).lower() for item in record.get("pubTypeList", {}).get("pubType", [])]
    if not title or EXCLUDED_TITLE.search(title) or "preprint" in publication_types:
        return False
    if len(parsed.get("body", "")) < 3_000:
        return False
    xml_title = normalized_title(parsed.get("title", ""))
    metadata_title = normalized_title(title)
    if xml_title and metadata_title and xml_title[:80] != metadata_title[:80]:
        return False
    return bool(parsed.get("licenseText") or parsed.get("licenseUrl"))


def build_prompt(title: str) -> str:
    return (
        f"请以已发表论文题目《{title}》为检索入口，检索其开放获取原始全文，并重写一份结构化科研正文"
        "（摘要、引言、方法、结果、讨论）。方法、样本量、主要数值、局限性和结论必须来自可核验原文，"
        "保留 DOI 或 PMCID 及来源链接；不得逐字复制，不得把题目或摘要推断成全文事实。"
        "若无法获得全文，请明确停止并列出缺失证据，不要编造。"
    )


def collect(output_dir: Path, per_category: int, candidates: int) -> list[dict[str, Any]]:
    full_text_dir = output_dir / "fulltext"
    references_dir = output_dir / "references"
    full_text_dir.mkdir(parents=True, exist_ok=True)
    references_dir.mkdir(parents=True, exist_ok=True)
    selected: list[dict[str, Any]] = []
    used_pmcids: set[str] = set()
    for category, query in CATEGORY_QUERIES.items():
        category_count = 0
        for record in search(query, candidates):
            pmcid = str(record.get("pmcid") or "").strip()
            if not pmcid or pmcid in used_pmcids:
                continue
            xml_url = f"{API_ROOT}/{urllib.parse.quote(pmcid)}/fullTextXML"
            try:
                xml_bytes = fetch(xml_url, accept="application/xml")
                parsed = parse_article(xml_bytes)
            except (RuntimeError, ET.ParseError, ValueError):
                continue
            if not acceptable(record, parsed):
                continue
            title = html.unescape(str(record.get("title") or parsed["title"])).strip()
            if too_similar(title, selected):
                continue
            reference = {
                "caseId": f"paper-{len(selected) + 1:03d}",
                "category": category,
                "title": title,
                "pmcid": pmcid,
                "pmid": str(record.get("pmid") or record.get("id") or ""),
                "doi": str(record.get("doi") or ""),
                "journal": str(record.get("journalTitle") or ""),
                "publicationDate": str(
                    record.get("firstPublicationDate") or record.get("firstIndexDate") or ""
                ),
                "publicationTypes": record.get("pubTypeList", {}).get("pubType", []),
                "authors": str(record.get("authorString") or ""),
                "articleType": parsed["articleType"],
                "abstract": parsed["abstract"],
                "introduction": parsed["introduction"],
                "methods": parsed["methods"],
                "results": parsed["results"],
                "discussion": parsed["discussion"],
                "referenceCount": len(parsed["references"]),
                "licenseText": parsed["licenseText"],
                "licenseUrl": parsed["licenseUrl"],
                "fullTextUrl": xml_url,
                "fullTextSha256": hashlib.sha256(xml_bytes).hexdigest(),
                "fullTextCharacters": len(parsed["body"]),
                "prompt": build_prompt(title),
            }
            (full_text_dir / f"{pmcid}.xml").write_bytes(xml_bytes)
            (references_dir / f"{reference['caseId']}.json").write_text(
                json.dumps(reference, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            selected.append(reference)
            used_pmcids.add(pmcid)
            category_count += 1
            print(f"[{len(selected):02d}] {category}: {pmcid} {title}")
            time.sleep(0.25)
            if category_count >= per_category:
                break
        if category_count != per_category:
            raise RuntimeError(
                f"Category {category} yielded {category_count}/{per_category} acceptable papers"
            )
    return selected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parent / "corpus",
    )
    parser.add_argument("--per-category", type=int, default=5)
    parser.add_argument("--candidates", type=int, default=80)
    args = parser.parse_args()
    if not 1 <= args.per_category <= 10:
        raise SystemExit("--per-category must be between 1 and 10")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    selected = collect(args.output_dir, args.per_category, args.candidates)
    manifest = {
        "schemaVersion": 1,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "Europe PMC OA fullTextXML",
        "automatedRetrievalPolicy": "Official Europe PMC REST OA endpoint only",
        "caseCount": len(selected),
        "categories": CATEGORY_QUERIES,
        "cases": selected,
    }
    manifest_path = args.output_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(selected)} cases to {manifest_path}")


if __name__ == "__main__":
    main()
