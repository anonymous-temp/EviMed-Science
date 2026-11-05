#!/usr/bin/env python3
"""Find open-access randomized trials with a printed baseline table, and fetch their PDFs.

    python3 select_papers.py --work /tmp/vcr-baseline-tables/pdfs [--per-journal 8]

Candidates come from the Europe PMC search API (publication type "Randomized Controlled Trial", open access, in PMC, a Creative Commons
licence) for a spread of journals, so the tables are typeset by different publishers. The PDF, the licence record and the JATS XML of each come
from the PMC Open Access dataset on AWS (``pmc-oa-opendata``), over plain HTTPS: no key, no account, and no contact identity in any header.
Each PDF is screened with ``pdftotext`` for a page whose table caption names baseline characteristics and that has the numeric rows of a
table; ``screen.json`` lists what was found. The PDFs stay in the work directory and are never committed: ``papers.json`` records the
PMCID, the licence, the page and the PDF's SHA-256, so the same files can be fetched again.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

SEARCH = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?"
BUCKET = "https://pmc-oa-opendata.s3.amazonaws.com/"
JOURNALS = ["BMJ Open", "PLoS One", "Trials", "BMC Med", "Nutrients", "Sci Rep", "BMC Cancer", "Medicine (Baltimore)", "BMC Public Health",
            "Diabetes Obes Metab", "Front Med (Lausanne)", "Front Nutr", "Medicina (Kaunas)", "Eur J Med Res", "BMC Pulm Med", "BMC Geriatr"]
CAPTION = re.compile(r"^\s*(table\s*(\d+|[ivx]+)[\s.:|-])", re.I)
TOPIC = re.compile(r"baseline|characteristic|demograph|patient and|participant", re.I)


def get(url: str, binary: bool = False, timeout: int = 90):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        data = response.read()
    return data if binary else data.decode("utf-8", "replace")


def candidates(journal: str, years: str, count: int):
    query = ('JOURNAL:"%s" AND PUB_TYPE:"Randomized Controlled Trial" AND OPEN_ACCESS:y AND IN_PMC:y AND HAS_FT:y AND PUB_YEAR:%s '
             'AND (LICENSE:"cc by" OR LICENSE:"cc0")' % (journal, years))
    url = SEARCH + urllib.parse.urlencode({"query": query, "format": "json", "pageSize": count, "resultType": "core"})
    return json.loads(get(url))["resultList"]["result"]


def bucket_prefix(pmcid: str):
    listing = get(BUCKET + "?" + urllib.parse.urlencode({"list-type": "2", "prefix": pmcid + ".", "max-keys": 50}))
    return sorted(set(re.findall(r"<Key>(%s\.\d+)/" % pmcid, listing)))


def screen_pdf(pdf: Path):
    """Pages that look like a baseline table: a caption line near a topic word and a block of numeric rows."""
    text = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True, check=False).stdout
    pages = text.split("\f")
    found = []
    for number, page in enumerate(pages, start=1):
        lines = page.splitlines()
        for index, line in enumerate(lines):
            if CAPTION.match(line) and TOPIC.search(" ".join(lines[index:index + 3])):
                numeric = sum(1 for row in lines[index + 1:index + 70] if len(re.findall(r"\d+(?:[.,]\d+)?", row)) >= 2 and len(row.strip()) < 160)
                found.append({"page": number, "caption": re.sub(r"\s+", " ", " ".join(lines[index:index + 2]).strip())[:140], "numericRows": numeric})
    return len(pages) - 1, found


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--work", required=True)
    parser.add_argument("--per-journal", type=int, default=8)
    parser.add_argument("--years", default="[2019 TO 2025]")
    args = parser.parse_args(argv)
    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)
    screened = []
    for journal in JOURNALS:
        try:
            rows = candidates(journal, args.years, args.per_journal)
        except Exception as error:  # noqa: BLE001 - a journal the search does not know is skipped, said, and the rest goes on
            print("%s: search failed (%s)" % (journal, type(error).__name__), file=sys.stderr)
            continue
        for row in rows:
            pmcid = row.get("pmcid")
            if not pmcid or (work / (pmcid + ".json")).exists() and any(s["pmcid"] == pmcid for s in screened):
                continue
            versions = bucket_prefix(pmcid)
            if not versions:
                continue
            base = versions[-1]
            try:
                meta = json.loads(get("%s%s/%s.json" % (BUCKET, base, base)))
                pdf = work / (pmcid + ".pdf")
                if not pdf.exists():
                    pdf.write_bytes(get("%s%s/%s.pdf" % (BUCKET, base, base), binary=True, timeout=180))
                xml = work / (pmcid + ".xml")
                if not xml.exists():
                    xml.write_bytes(get("%s%s/%s.xml" % (BUCKET, base, base), binary=True, timeout=180))
            except Exception as error:  # noqa: BLE001
                print("%s: fetch failed (%s)" % (pmcid, type(error).__name__), file=sys.stderr)
                continue
            pages, found = screen_pdf(pdf)
            (work / (pmcid + ".json")).write_text(json.dumps(meta), encoding="utf-8")
            screened.append({"pmcid": pmcid, "version": base, "journal": journal, "year": row.get("pubYear"), "title": (row.get("title") or "")[:160],
                             "licence": meta.get("license_code"), "pdfPages": pages, "pdfBytes": pdf.stat().st_size,
                             "pdfSha256": hashlib.sha256(pdf.read_bytes()).hexdigest(), "tables": found})
            print("%s %-22s %s pages=%d tables=%s" % (pmcid, journal, meta.get("license_code"), pages, [(t["page"], t["numericRows"]) for t in found][:3]), flush=True)
    (work / "screen.json").write_text(json.dumps(screened, ensure_ascii=False, indent=1), encoding="utf-8")
    print("screened %d papers; %d with a baseline-looking table" % (len(screened), sum(1 for s in screened if s["tables"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
