#!/usr/bin/env python3
"""Dry run of the FRONT HALF of the medical frontier-feed ingester over the real P0 sources.

Fetch only, no storage and no ranking: pull every P0 row of sources.json, normalise what comes
back into one item shape, and measure what the data actually looks like — volume, dates, text
length, duplicates and the token bill an ingester would pay per day.

Standard library plus curl, so it runs on any box without an install step.
Every raw response is cached under /tmp/medhot2/raw/, so a re-run resumes instead of re-fetching.

Usage:
    dryrun_ingest.py all                 # every phase, in order
    dryrun_ingest.py crossref            # 1. journals (crossref-issn), strictly serial
    dryrun_ingest.py pubmed              # 2. PubMed enrichment of the journal DOIs
    dryrun_ingest.py feeds               # 3. rss/atom, 4 workers
    dryrun_ingest.py jsonapi             # 4. json-api families
    dryrun_ingest.py analyze             # 5. compute the report
"""
import concurrent.futures
import datetime as dt
import email.utils
import html
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.dirname(HERE)
REGISTRY = os.path.join(ASSETS, "sources.json")
OUT_JSON = os.path.join(ASSETS, "research", "dryrun-p0-2026-09-21.json")
WORK = "/tmp/medhot2"
RAW = os.path.join(WORK, "raw")
NORM = os.path.join(WORK, "norm")
REPORT_MD = os.path.join(WORK, "dryrun-report.md")

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/126.0 Safari/537.36")
ACCEPT = ("application/rss+xml, application/atom+xml, application/xml;q=0.9, "
          "application/json;q=0.9, text/html;q=0.8, */*;q=0.5")

TODAY = dt.datetime.now(dt.timezone.utc).date()
WINDOW_DAYS = 7
WINDOW_START = TODAY - dt.timedelta(days=WINDOW_DAYS)

# Crossref refuses `subtype` and `language` on the /journals/{issn}/works route (validation-failure
# `select-not-available`), so the select carries the nine fields that route does accept.
CROSSREF_SELECT = "DOI,title,created,published,type,update-to,abstract,author,container-title"
CROSSREF_SELECT_REFUSED = ["subtype", "language"]

EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
DOI_RE = re.compile(r"10\.\d{4,9}/[-._;()/:A-Za-z0-9<>\[\]]+", re.I)
TAG_RE = re.compile(r"<[^>]+>")
SCRIPT_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.I | re.S)
WS_RE = re.compile(r"\s+")
PUNCT_RE = re.compile(r"[^\w一-鿿]+", re.UNICODE)

TRUNCATION_MARKS = ("…", "...", "[...]", "[…]", "(...)", "read more", "continue reading",
                    "read the full", "阅读全文", "查看全文", "详情请见", "more »", "read more »")

NON_RESEARCH_TYPES = {
    "Letter", "Comment", "Editorial", "News", "Published Erratum", "Biography", "Portrait",
    "Retraction of Publication", "Expression of Concern", "Personal Narrative", "Interview",
}
RESEARCH_TYPES_EXACT = {
    "Randomized Controlled Trial", "Meta-Analysis", "Systematic Review", "Practice Guideline",
    "Guideline", "Observational Study", "Multicenter Study", "Comparative Study", "Review",
}
NON_ARTICLE_PREFIXES = [
    "Correction", "Erratum", "Author Correction", "Publisher Correction", "Retraction",
    "Reply", "Response to", "In this issue", "Issue Information", "Cover",
    "Table of Contents", "Editorial Board",
]

_print_lock = threading.Lock()


def log(msg):
    with _print_lock:
        sys.stderr.write(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {msg}\n")
        sys.stderr.flush()


# ---------------------------------------------------------------- fetch + cache

def fetch(url, timeout=35, method="GET", body=None, content_type=None):
    """One curl call. `-g` is required: several endpoints carry literal [brackets]."""
    tmp = tempfile.NamedTemporaryFile(delete=False)
    tmp.close()
    cmd = ["curl", "-sS", "-g", "-L", "--compressed", "-m", str(timeout), "-A", UA,
           "-H", f"Accept: {ACCEPT}", "-H", "Accept-Language: en;q=0.9,zh-CN;q=0.8",
           "-o", tmp.name, "-w", "%{http_code}\t%{content_type}\t%{url_effective}\t%{time_total}"]
    if method == "POST":
        cmd += ["-X", "POST", "--data-binary", body or ""]
        cmd += ["-H", f"Content-Type: {content_type or 'application/x-www-form-urlencoded'}"]
    cmd.append(url)
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 15)
        meta = (done.stdout or "").strip().split("\t")
        with open(tmp.name, "rb") as handle:
            raw = handle.read()
        err = (done.stderr or "").strip()[:200]
    except subprocess.TimeoutExpired:
        meta, raw, err = ["000", "", url, str(timeout)], b"", "timeout"
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
    while len(meta) < 4:
        meta.append("")
    return {"http": int(meta[0] or 0), "content_type": meta[1].split(";")[0].strip(),
            "final_url": meta[2], "seconds": round(float(meta[3] or 0), 2),
            "bytes": len(raw), "error": err or None}, raw


def cached(key, ext, url, **kw):
    """Fetch once and keep it. A key whose .meta.json exists is never fetched again."""
    os.makedirs(RAW, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", key)[:120]
    body_path = os.path.join(RAW, f"{safe}.{ext}")
    meta_path = os.path.join(RAW, f"{safe}.meta.json")
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as handle:
            meta = json.load(handle)
        raw = b""
        if os.path.exists(body_path):
            with open(body_path, "rb") as handle:
                raw = handle.read()
        meta["from_cache"] = True
        return meta, raw
    meta, raw = fetch(url, **kw)
    meta["url"] = url
    meta["fetched_at"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(body_path, "wb") as handle:
        handle.write(raw)
    with open(meta_path, "w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False)
    meta["from_cache"] = False
    return meta, raw


class Pacer:
    """Minimum spacing between the STARTS of consecutive calls against one host pool."""

    def __init__(self, gap):
        self.gap = gap
        self.last = 0.0
        self.lock = threading.Lock()

    def wait(self):
        with self.lock:
            now = time.monotonic()
            sleep_for = self.gap - (now - self.last)
            if sleep_for > 0:
                time.sleep(sleep_for)
            self.last = time.monotonic()


CROSSREF_PACER = Pacer(1.25)   # anonymous pool answers 429 under concurrency
NCBI_PACER = Pacer(0.42)       # <= 2.5 requests/second overall, no api key


# ---------------------------------------------------------------- text helpers

def strip_markup(text):
    if not text:
        return ""
    text = SCRIPT_RE.sub(" ", text)
    text = TAG_RE.sub(" ", text)
    text = html.unescape(text)
    return WS_RE.sub(" ", text).strip()


def cjk_ratio(text):
    if not text:
        return 0.0
    letters = [c for c in text if not c.isspace()]
    if not letters:
        return 0.0
    cjk = sum(1 for c in letters if is_cjk(c))
    return cjk / len(letters)


def is_cjk(char):
    code = ord(char)
    return (0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF or 0x3040 <= code <= 0x30FF
            or 0xAC00 <= code <= 0xD7AF or 0xF900 <= code <= 0xFAFF or 0xFF00 <= code <= 0xFF60)


def est_tokens(text):
    """0.3 tokens per English character, 0.6 per CJK character."""
    if not text:
        return 0.0
    cjk = sum(1 for c in text if is_cjk(c))
    return round(0.6 * cjk + 0.3 * (len(text) - cjk), 1)


def norm_title(title):
    if not title:
        return ""
    folded = unicodedata.normalize("NFKC", title).lower()
    return PUNCT_RE.sub("", folded)


def find_doi(*candidates):
    for cand in candidates:
        if not cand:
            continue
        match = DOI_RE.search(cand)
        if match:
            return match.group(0).rstrip(".,;)").lower()
    return None


def looks_truncated(summary):
    if summary is None:
        return False
    low = summary.strip().lower()
    if len(low) < 80:
        return True
    return any(low.endswith(mark) or low.rstrip(" .»›>").endswith(mark) for mark in TRUNCATION_MARKS)


def parse_any_date(text):
    if not text:
        return None
    text = text.strip()
    try:
        parsed = email.utils.parsedate_to_datetime(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc).date()
    except Exception:
        pass
    match = re.search(r"(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})", text)
    if match:
        year, month, day = (int(g) for g in match.groups())
        try:
            return dt.date(year, month, day)
        except ValueError:
            return None
    # openFDA ships MM/DD/YYYY on /drug/shortages and YYYYMMDD everywhere else
    match = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})$", text)
    if match:
        month, day, year = (int(g) for g in match.groups())
        try:
            return dt.date(year, month, day)
        except ValueError:
            return None
    match = re.search(r"(\d{8})$", text)
    if match:
        try:
            return dt.datetime.strptime(match.group(1), "%Y%m%d").date()
        except ValueError:
            return None
    return None


def in_window(day):
    return day is not None and WINDOW_START <= day <= TODAY + dt.timedelta(days=1)


# ---------------------------------------------------------------- registry

def load_p0():
    with open(REGISTRY, encoding="utf-8") as handle:
        rows = json.load(handle)
    return [r for r in rows if r.get("launch_tier") == "P0"]


def item_record(row, **kw):
    """One unified item shape across every access family."""
    title = kw.get("title") or ""
    summary = kw.get("summary") or ""
    full = kw.get("full") or ""
    rec = {
        "source_id": row["id"], "access": row.get("access"), "lane": row.get("lane"),
        "lang": row.get("lang"), "category": row.get("category"),
        "title": title[:400], "title_chars": len(title),
        "link": kw.get("link"), "date": kw.get("date").isoformat() if kw.get("date") else None,
        "summary_chars": len(summary), "full_chars": len(full),
        "has_full": bool(full) and len(full) > len(summary),
        "truncated": looks_truncated(summary) if summary else None,
        "cjk_title_ratio": round(cjk_ratio(title), 3),
        "doi": kw.get("doi"),
    }
    best = full if rec["has_full"] else summary
    rec["tokens"] = est_tokens(title + " " + best)
    rec["best_text_chars"] = len(best)
    return rec


def write_jsonl(name, records):
    os.makedirs(NORM, exist_ok=True)
    path = os.path.join(NORM, name)
    with open(path, "w", encoding="utf-8") as handle:
        for rec in records:
            handle.write(json.dumps(rec, ensure_ascii=False) + "\n")
    log(f"wrote {path} ({len(records)} rows)")


def read_jsonl(name):
    path = os.path.join(NORM, name)
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


# ---------------------------------------------------------------- 1. journals

def crossref_url(endpoint):
    """Keep the row's own filter and rows; force the select to carry the fields we measure."""
    if "select=" in endpoint:
        return re.sub(r"select=[^&]*", "select=" + CROSSREF_SELECT, endpoint)
    joiner = "&" if "?" in endpoint else "?"
    return f"{endpoint}{joiner}select={CROSSREF_SELECT}"


def crossref_work(row, work):
    doi = (work.get("DOI") or "").lower() or None
    title_list = work.get("title") or []
    title = strip_markup(title_list[0]) if title_list else ""
    abstract = strip_markup(work.get("abstract") or "")
    created = None
    if isinstance(work.get("created"), dict):
        created = parse_any_date(work["created"].get("date-time") or "")
    published = None
    if isinstance(work.get("published"), dict):
        parts = (work["published"].get("date-parts") or [[]])[0]
        if len(parts) >= 3:
            try:
                published = dt.date(parts[0], parts[1], parts[2])
            except (ValueError, TypeError):
                published = None
        elif len(parts) >= 1 and parts[0]:
            published = None
    updates = work.get("update-to") or []
    container = work.get("container-title") or []
    return {
        "source_id": row["id"], "source_name": row.get("name"), "lane": row.get("lane"),
        "doi": doi, "title": title, "title_chars": len(title),
        "type": work.get("type"), "subtype": work.get("subtype"),
        "has_abstract": bool(abstract), "abstract_chars": len(abstract),
        "created_date": created.isoformat() if created else None,
        "published_date": published.isoformat() if published else None,
        "n_authors": len(work.get("author") or []),
        "is_update": bool(updates),
        "update_types": sorted({u.get("type") for u in updates if isinstance(u, dict) and u.get("type")}),
        "container": container[0] if container else None,
    }


def phase_crossref(rows):
    journals = [r for r in rows if r.get("access") == "crossref-issn"]
    log(f"crossref: {len(journals)} journal rows")
    works, status = [], []
    for index, row in enumerate(journals, 1):
        url = crossref_url(row["endpoint"])
        meta, raw = cached(f"cr_{row['id']}", "json", url, timeout=40)
        attempts = 0
        while (not meta.get("from_cache")) and meta["http"] == 429 and attempts < 3:
            attempts += 1
            log(f"  429 on {row['id']} — sleeping 20 s (retry {attempts}/3)")
            time.sleep(20)
            os.remove(os.path.join(RAW, f"cr_{row['id']}.meta.json"))
            CROSSREF_PACER.wait()
            meta, raw = cached(f"cr_{row['id']}", "json", url, timeout=40)
        entry = {"source_id": row["id"], "name": row.get("name"), "http": meta["http"],
                 "bytes": meta["bytes"], "seconds": meta["seconds"], "cached": meta.get("from_cache"),
                 "error": meta.get("error"), "retries_429": attempts}
        try:
            payload = json.loads(raw.decode("utf-8", "replace"))
            message = payload["message"]
            items = message.get("items") or []
            entry["total_results"] = message.get("total-results")
            entry["items"] = len(items)
            entry["truncated_by_rows"] = bool(
                entry["total_results"] and entry["total_results"] > len(items))
            entry["ok"] = True
            for work in items:
                works.append(crossref_work(row, work))
        except Exception as exc:
            entry["ok"] = False
            entry["parse_error"] = f"{type(exc).__name__}: {exc}"[:160]
        status.append(entry)
        if not meta.get("from_cache"):
            CROSSREF_PACER.wait()
        if index % 25 == 0:
            log(f"  crossref {index}/{len(journals)} — {len(works)} works so far")
    write_jsonl("crossref_works.jsonl", works)
    write_jsonl("crossref_status.jsonl", status)


# ---------------------------------------------------------------- 2. PubMed

def eutils_post(script, params, key):
    NCBI_PACER.wait()
    body = "&".join(f"{k}={v}" for k, v in params)
    ext = "json" if params and any(k == "retmode" and v == "json" for k, v in params) else "xml"
    meta, raw = cached(key, ext, f"{EUTILS}/{script}", timeout=90, method="POST", body=body)
    return meta, raw


def url_quote(text):
    import urllib.parse
    return urllib.parse.quote(str(text), safe="")


def pubmed_esearch_dois(dois, batch_index):
    term = " OR ".join(f"{doi}[doi]" for doi in dois)
    params = [("db", "pubmed"), ("retmode", "json"), ("retmax", "200"),
              ("term", url_quote(term))]
    meta, raw = eutils_post("esearch.fcgi", params, f"pm_esearch_doi_{batch_index:03d}")
    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
        result = payload.get("esearchresult", {})
        return result.get("idlist") or [], int(result.get("count") or 0), meta
    except Exception:
        return [], 0, meta


def parse_pubmed_xml(raw):
    """One record per PubmedArticle / PubmedBookArticle."""
    out = []
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return out
    for art in root.iter():
        tag = art.tag.split("}")[-1]
        if tag not in ("PubmedArticle", "PubmedBookArticle"):
            continue
        rec = {"pmid": None, "doi": None, "pub_types": [], "has_abstract": False,
               "abstract_chars": 0, "language": None, "entry_date": None, "title": ""}
        for node in art.iter():
            local = node.tag.split("}")[-1]
            text = (node.text or "").strip()
            if local == "PMID" and rec["pmid"] is None:
                rec["pmid"] = text
            elif local == "ArticleId" and node.get("IdType") == "doi" and not rec["doi"]:
                rec["doi"] = text.lower()
            elif local == "ELocationID" and node.get("EIdType") == "doi" and not rec["doi"]:
                rec["doi"] = text.lower()
            elif local == "PublicationType" and text:
                rec["pub_types"].append(text)
            elif local == "Language" and rec["language"] is None:
                rec["language"] = text
            elif local in ("ArticleTitle", "BookTitle") and not rec["title"]:
                rec["title"] = strip_markup("".join(node.itertext()))
        abstract_parts = []
        for node in art.iter():
            if node.tag.split("}")[-1] == "AbstractText":
                abstract_parts.append("".join(node.itertext()))
        abstract = strip_markup(" ".join(abstract_parts))
        rec["has_abstract"] = bool(abstract)
        rec["abstract_chars"] = len(abstract)
        best = None
        for node in art.iter():
            if node.tag.split("}")[-1] != "PubMedPubDate":
                continue
            status = node.get("PubStatus")
            if status not in ("entrez", "pubmed"):
                continue
            parts = {}
            for child in node:
                parts[child.tag.split("}")[-1]] = (child.text or "").strip()
            try:
                day = dt.date(int(parts["Year"]), int(parts["Month"]), int(parts["Day"]))
            except (KeyError, ValueError, TypeError):
                continue
            if status == "entrez" or best is None:
                best = day
        rec["entry_date"] = best.isoformat() if best else None
        rec["pub_types"] = sorted(set(rec["pub_types"]))
        out.append(rec)
    return out


def pubmed_efetch(pmids, key):
    params = [("db", "pubmed"), ("retmode", "xml"), ("rettype", "xml"),
              ("id", ",".join(pmids))]
    meta, raw = eutils_post("efetch.fcgi", params, key)
    return parse_pubmed_xml(raw), meta


def phase_pubmed():
    works = read_jsonl("crossref_works.jsonl")
    dois = sorted({w["doi"] for w in works if w.get("doi")})
    log(f"pubmed: enriching {len(dois)} distinct DOIs from {len(works)} works")
    pmids, search_stats = [], []
    batches = [dois[i:i + 40] for i in range(0, len(dois), 40)]
    for index, batch in enumerate(batches):
        found, count, meta = pubmed_esearch_dois(batch, index)
        pmids.extend(found)
        search_stats.append({"batch": index, "dois": len(batch), "count": count,
                             "http": meta["http"], "cached": meta.get("from_cache")})
        if (index + 1) % 20 == 0:
            log(f"  esearch {index + 1}/{len(batches)} — {len(pmids)} pmids")
    pmids = sorted(set(pmids))
    log(f"pubmed: {len(pmids)} distinct PMIDs; efetch in batches of 150")
    records = []
    chunks = [pmids[i:i + 150] for i in range(0, len(pmids), 150)]
    for index, chunk in enumerate(chunks):
        got, meta = pubmed_efetch(chunk, f"pm_efetch_doi_{index:03d}")
        records.extend(got)
        log(f"  efetch {index + 1}/{len(chunks)} — {len(got)} records (http {meta['http']})")
    write_jsonl("pubmed_records.jsonl", records)
    write_jsonl("pubmed_search_stats.jsonl", search_stats)


# ---------------------------------------------------------------- 3. feeds

def local(tag):
    return tag.split("}")[-1].lower()


def feed_items_xml(raw):
    """Parse rss/atom with ElementTree; return a list of {tag: [texts]} plus attribute links."""
    text = raw.decode("utf-8", "replace")
    text = text.lstrip("﻿ \r\n\t")
    # undefined HTML entities are common in hand-rolled feeds
    text = re.sub(r"&(?!#\d+;|#x[0-9a-fA-F]+;|amp;|lt;|gt;|quot;|apos;)", "&amp;", text)
    try:
        root = ET.fromstring(text.encode("utf-8"))
    except ET.ParseError:
        return None
    items = []
    for node in root.iter():
        if local(node.tag) in ("item", "entry"):
            items.append(node)
    return items


def feed_field(node, names):
    for child in node:
        if local(child.tag) in names:
            joined = "".join(child.itertext())
            if joined and joined.strip():
                return joined
    return ""


def feed_link(node):
    for child in node:
        name = local(child.tag)
        if name == "link":
            href = child.get("href")
            rel = (child.get("rel") or "alternate").lower()
            if href and rel == "alternate":
                return href.strip()
            if not href and (child.text or "").strip():
                return child.text.strip()
    for child in node:
        if local(child.tag) == "link" and child.get("href"):
            return child.get("href").strip()
    for child in node:
        if local(child.tag) == "guid" and (child.text or "").strip().startswith("http"):
            return child.text.strip()
    for child in node:
        if local(child.tag) == "id" and (child.text or "").strip().startswith("http"):
            return child.text.strip()
    return None


def phase_feeds(rows):
    feeds = [r for r in rows if r.get("access") in ("rss", "atom")]
    log(f"feeds: {len(feeds)} rows, 4 workers")
    results, statuses = [], []
    lock = threading.Lock()

    def work(row):
        meta, raw = cached(f"feed_{row['id']}", "xml", row["endpoint"], timeout=45)
        entry = {"source_id": row["id"], "name": row.get("name"), "access": row["access"],
                 "lane": row.get("lane"), "http": meta["http"], "bytes": meta["bytes"],
                 "seconds": meta["seconds"], "error": meta.get("error"),
                 "cached": meta.get("from_cache")}
        nodes = feed_items_xml(raw) if raw else None
        if nodes is None:
            entry["ok"] = False
            entry["parse_error"] = "xml-parse-failed" if raw else "empty-body"
            with lock:
                statuses.append(entry)
            return
        recs = []
        for node in nodes:
            title = strip_markup(feed_field(node, {"title"}))
            summary_raw = feed_field(node, {"description", "summary", "subtitle"})
            full_raw = feed_field(node, {"encoded", "content"})
            summary = strip_markup(summary_raw)
            full = strip_markup(full_raw)
            date_text = feed_field(node, {"pubdate", "published", "updated", "date",
                                          "publicationdate", "coverdate", "created", "issued"})
            day = parse_any_date(date_text)
            link = feed_link(node)
            guid = feed_field(node, {"guid", "id"})
            recs.append(item_record(row, title=title, summary=summary, full=full,
                                    date=day, link=link, doi=find_doi(link or "", guid)))
        entry["ok"] = True
        entry["items"] = len(recs)
        entry["items_7d"] = sum(1 for r in recs if in_window(parse_any_date(r["date"] or "")))
        entry["items_dated"] = sum(1 for r in recs if r["date"])
        dates = sorted(r["date"] for r in recs if r["date"])
        entry["latest"] = dates[-1] if dates else None
        entry["oldest"] = dates[0] if dates else None
        with lock:
            statuses.append(entry)
            results.extend(recs)

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(work, feeds))
    write_jsonl("feed_items.jsonl", results)
    write_jsonl("feed_status.jsonl", statuses)


# ---------------------------------------------------------------- 4. json-api

def deep_get(obj, path):
    cur = obj
    for key in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(key)
        else:
            return None
        if cur is None:
            return None
    return cur


def json_family(row):
    url = row["endpoint"]
    if "email=" in url or "@" in url.split("?", 1)[-1]:
        return "skip-email-in-url"
    if "eutils.ncbi.nlm.nih.gov" in url and "esearch.fcgi" in url:
        return "eutils-esearch"
    if "eutils.ncbi.nlm.nih.gov" in url and "esummary.fcgi" in url:
        return "eutils-esummary"
    if "ebi.ac.uk/europepmc" in url:
        return "europepmc"
    if "clinicaltrials.gov/api/v2" in url:
        return "ctgov-v2"
    if "api.fda.gov" in url:
        return "openfda"
    if "api.crossref.org" in url:
        return "crossref-works"
    if "www.who.int/api" in url:
        return "who-odata"
    if "api.medrxiv.org" in url or "api.biorxiv.org" in url:
        return "biorxiv"
    if "federalregister.gov" in url:
        return "federalregister"
    return "generic"


def openfda_item(row, res):
    url = row["endpoint"]
    if "/enforcement" in url:
        title = res.get("product_description") or res.get("recalling_firm") or ""
        day = parse_any_date(res.get("report_date") or "")
        text = res.get("reason_for_recall") or ""
    elif "/drugsfda" in url:
        products = res.get("products") or []
        title = (res.get("openfda", {}).get("brand_name") or [None])[0] or \
            (products[0].get("brand_name") if products else None) or res.get("application_number") or ""
        subs = res.get("submissions") or []
        days = [parse_any_date(s.get("submission_status_date") or "") for s in subs]
        days = [d for d in days if d]
        day = max(days) if days else None
        text = res.get("sponsor_name") or ""
    elif "/shortages" in url:
        title = f"{res.get('generic_name') or ''} {res.get('dosage_form') or ''}".strip()
        day = parse_any_date(res.get("update_date") or res.get("initial_posting_date") or "")
        text = res.get("shortage_reason") or res.get("status") or ""
    elif "/event" in url:
        drugs = (res.get("patient") or {}).get("drug") or []
        title = (drugs[0].get("medicinalproduct") if drugs else None) or "FAERS case"
        day = parse_any_date(res.get("receivedate") or "")
        text = ", ".join(r.get("reactionmeddrapt", "") for r in
                         ((res.get("patient") or {}).get("reaction") or []))[:2000]
    else:
        title, day, text = "", None, ""
    return strip_markup(str(title)), day, strip_markup(str(text))


def generic_item(res):
    """Last resort: guess title / date / longest text from an unknown record."""
    title, day, text = "", None, ""
    for key in ("title", "Title", "name", "headline", "briefTitle", "article_title", "subject"):
        value = res.get(key)
        if isinstance(value, str) and value.strip():
            title = value
            break
    for key, value in res.items():
        if not isinstance(value, str):
            continue
        low = key.lower()
        if ("date" in low or "time" in low or low.endswith("_at")) and day is None:
            day = parse_any_date(value)
    for key, value in res.items():
        if isinstance(value, str) and len(value) > len(text) and key != title:
            low = key.lower()
            if "email" in low or "phone" in low or "contact" in low:
                continue
            if value is not title:
                text = value
    return strip_markup(title), day, strip_markup(text)


def phase_jsonapi(rows):
    api_rows = [r for r in rows if r.get("access") == "json-api"]
    log(f"json-api: {len(api_rows)} rows")
    items, statuses = [], []
    for row in api_rows:
        family = json_family(row)
        entry = {"source_id": row["id"], "name": row.get("name"), "lane": row.get("lane"),
                 "family": family, "ok": False, "items": 0, "skipped": False}
        if family == "skip-email-in-url":
            entry.update(skipped=True, skip_reason="endpoint carries an e-mail address parameter")
            statuses.append(entry)
            continue
        if family in ("eutils-esearch",):
            recs, info = jsonapi_eutils(row)
        else:
            if family == "europepmc":
                time.sleep(1.0)
            meta, raw = cached(f"api_{row['id']}", "json", row["endpoint"], timeout=45)
            entry.update(http=meta["http"], bytes=meta["bytes"], seconds=meta["seconds"],
                         error=meta.get("error"), cached=meta.get("from_cache"))
            recs, info = jsonapi_parse(row, family, raw)
        entry.update(info)
        entry["items"] = len(recs)
        entry["ok"] = bool(recs) or info.get("ok", False)
        entry["items_7d"] = sum(1 for r in recs if in_window(parse_any_date(r["date"] or "")))
        statuses.append(entry)
        items.extend(recs)
        log(f"  {row['id']:34s} {family:16s} items={len(recs)}")
    write_jsonl("api_items.jsonl", items)
    write_jsonl("api_status.jsonl", statuses)


def jsonapi_eutils(row):
    """An esearch query stream: count for the window, then efetch up to 100 records."""
    NCBI_PACER.wait()
    meta, raw = cached(f"api_{row['id']}", "json", row["endpoint"], timeout=60)
    info = {"http": meta["http"], "bytes": meta["bytes"], "cached": meta.get("from_cache"),
            "seconds": meta["seconds"]}
    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
        result = payload["esearchresult"]
        ids = result.get("idlist") or []
        info["esearch_count"] = int(result.get("count") or 0)
        info["esearch_returned"] = len(ids)
        info["window"] = "reldate in the row's own endpoint"
    except Exception as exc:
        info["parse_error"] = f"{type(exc).__name__}: {exc}"[:120]
        return [], info
    if not ids:
        info["ok"] = True
        return [], info
    records, fetch_meta = pubmed_efetch(ids[:100], f"api_efetch_{row['id']}")
    info["efetch_http"] = fetch_meta["http"]
    info["efetch_records"] = len(records)
    info["ok"] = True
    out = []
    for rec in records:
        day = parse_any_date(rec.get("entry_date") or "")
        out.append(item_record(
            row, title=rec.get("title") or "",
            summary="x" * rec["abstract_chars"] if rec["abstract_chars"] else "",
            date=day, link=f"https://pubmed.ncbi.nlm.nih.gov/{rec['pmid']}/" if rec.get("pmid") else None,
            doi=rec.get("doi")))
        out[-1]["pub_types"] = rec["pub_types"]
        out[-1]["pubmed_language"] = rec.get("language")
    info["pub_type_sample"] = sorted({t for r in records for t in r["pub_types"]})[:12]
    return out, info


def jsonapi_parse(row, family, raw):
    info = {}
    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
    except Exception as exc:
        info["parse_error"] = f"not-json: {type(exc).__name__}"
        info["body_head"] = raw[:120].decode("utf-8", "replace")
        return [], info
    out = []
    if family == "europepmc":
        results = deep_get(payload, "resultList.result") or []
        info["hit_count"] = payload.get("hitCount")
        for res in results:
            day = parse_any_date(res.get("firstPublicationDate") or res.get("pubYear") or "")
            abstract = strip_markup(res.get("abstractText") or "")
            out.append(item_record(row, title=strip_markup(res.get("title") or ""),
                                   summary=abstract, date=day,
                                   link=res.get("doi") and f"https://doi.org/{res['doi']}",
                                   doi=(res.get("doi") or "").lower() or None))
    elif family == "ctgov-v2":
        studies = payload.get("studies") or []
        info["total_count"] = payload.get("totalCount")
        for study in studies:
            proto = study.get("protocolSection") or {}
            ident = proto.get("identificationModule") or {}
            status = proto.get("statusModule") or {}
            desc = proto.get("descriptionModule") or {}
            day = None
            for key in ("studyFirstPostDateStruct", "resultsFirstPostDateStruct",
                        "lastUpdatePostDateStruct"):
                struct = status.get(key) or {}
                day = parse_any_date(struct.get("date") or "")
                if day:
                    break
            nct = ident.get("nctId")
            out.append(item_record(row, title=strip_markup(ident.get("briefTitle") or ""),
                                   summary=strip_markup(desc.get("briefSummary") or ""),
                                   date=day,
                                   link=nct and f"https://clinicaltrials.gov/study/{nct}"))
    elif family == "openfda":
        results = payload.get("results") or []
        info["total"] = deep_get(payload, "meta.results.total")
        info["last_updated"] = deep_get(payload, "meta.last_updated")
        for res in results:
            title, day, text = openfda_item(row, res)
            out.append(item_record(row, title=title, summary=text, date=day, link=None))
    elif family == "crossref-works":
        items = deep_get(payload, "message.items") or []
        info["total_results"] = deep_get(payload, "message.total-results")
        for work in items:
            norm = crossref_work(row, work)
            day = parse_any_date(norm["created_date"] or "")
            out.append(item_record(row, title=norm["title"],
                                   summary="x" * norm["abstract_chars"] if norm["abstract_chars"] else "",
                                   date=day, doi=norm["doi"],
                                   link=norm["doi"] and f"https://doi.org/{norm['doi']}"))
            out[-1]["update_types"] = norm["update_types"]
    elif family == "who-odata":
        values = payload.get("value") or []
        for res in values:
            day = parse_any_date(res.get("PublicationDateAndTime") or "")
            text = ""
            for key in ("Summary", "Overview", "BodySummary", "Description", "Abstract"):
                if isinstance(res.get(key), str) and res[key].strip():
                    text = strip_markup(res[key])
                    break
            url = res.get("ItemDefaultUrl") or ""
            out.append(item_record(row, title=strip_markup(res.get("Title") or ""),
                                   summary=text, date=day,
                                   link=url and f"https://www.who.int{url}"))
        info["odata_fields_with_body"] = bool(out and any(r["summary_chars"] for r in out))
    elif family == "biorxiv":
        collection = payload.get("collection") or []
        messages = payload.get("messages") or []
        if messages:
            info["message"] = {k: messages[0].get(k) for k in ("count", "total", "status")}
        for res in collection:
            day = parse_any_date(res.get("date") or "")
            doi = (res.get("doi") or "").lower() or None
            out.append(item_record(row, title=strip_markup(res.get("title") or ""),
                                   summary=strip_markup(res.get("abstract") or ""),
                                   date=day, doi=doi,
                                   link=doi and f"https://doi.org/{doi}"))
    elif family == "federalregister":
        results = payload.get("results") or []
        info["count"] = payload.get("count")
        for res in results:
            out.append(item_record(row, title=strip_markup(res.get("title") or ""),
                                   summary=strip_markup(res.get("abstract") or ""),
                                   date=parse_any_date(res.get("publication_date") or ""),
                                   link=res.get("html_url")))
    elif family == "eutils-esummary":
        docs = deep_get(payload, "result") or {}
        uids = docs.get("uids") or []
        for uid in uids:
            res = docs.get(uid) or {}
            out.append(item_record(row, title=strip_markup(res.get("title") or ""), summary="",
                                   date=parse_any_date(res.get("sortpubdate") or res.get("pubdate") or ""),
                                   link=f"https://pubmed.ncbi.nlm.nih.gov/{uid}/"))
        info["ok"] = True
    else:
        candidates = []
        if isinstance(payload, list):
            candidates = payload
        elif isinstance(payload, dict):
            best = []
            for key, value in payload.items():
                if isinstance(value, list) and value and isinstance(value[0], dict):
                    if len(value) > len(best):
                        best = value
                        info["list_key"] = key
                if isinstance(value, dict):
                    for key2, value2 in value.items():
                        if isinstance(value2, list) and value2 and isinstance(value2[0], dict):
                            if len(value2) > len(best):
                                best = value2
                                info["list_key"] = f"{key}.{key2}"
            candidates = best
        if not candidates:
            info["skip_reason"] = "no recognisable record list in the response"
            info["top_keys"] = list(payload)[:10] if isinstance(payload, dict) else None
            return [], info
        for res in candidates:
            title, day, text = generic_item(res)
            out.append(item_record(row, title=title, summary=text, date=day, link=None))
    return out, info


# ---------------------------------------------------------------- 5. analysis

def pct(n, d):
    return {"n": n, "of": d, "share": round(n / d, 4) if d else None}


def quantiles(values):
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return {"n": 0, "median": None, "p90": None, "mean": None, "max": None}
    idx = min(len(vals) - 1, int(round(0.9 * (len(vals) - 1))))
    return {"n": len(vals), "median": round(statistics.median(vals), 1),
            "p90": round(vals[idx], 1), "mean": round(statistics.fmean(vals), 1),
            "max": round(vals[-1], 1)}


def tally(values, top=None):
    counts = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], str(kv[0])))
    if top:
        ordered = ordered[:top]
    return {str(k): v for k, v in ordered}


def phase_analyze(rows):
    works = read_jsonl("crossref_works.jsonl")
    cr_status = read_jsonl("crossref_status.jsonl")
    pubmed = read_jsonl("pubmed_records.jsonl")
    feed_items = read_jsonl("feed_items.jsonl")
    feed_status = read_jsonl("feed_status.jsonl")
    api_items = read_jsonl("api_items.jsonl")
    api_status = read_jsonl("api_status.jsonl")

    out = {
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window": {"days": WINDOW_DAYS, "from": WINDOW_START.isoformat(), "to": TODAY.isoformat()},
        "scope": {"registry_rows": len(json.load(open(REGISTRY, encoding='utf-8'))),
                  "p0_rows": len(rows),
                  "by_access": tally(r.get("access") for r in rows)},
        "notes": {
            "crossref_select": CROSSREF_SELECT,
            "crossref_select_refused": CROSSREF_SELECT_REFUSED,
            "crossref_filter_kept_from_registry": "from-created-date:<7d ago>,type:journal-article",
        },
    }

    # ---- journal works as unified items, for the cross-family sections
    work_items = []
    for work in works:
        day = parse_any_date(work.get("created_date") or "")
        work_items.append({
            "source_id": work["source_id"], "access": "crossref-issn", "lane": work.get("lane"),
            "lang": "en", "title": work["title"], "title_chars": work["title_chars"],
            "link": work["doi"] and f"https://doi.org/{work['doi']}",
            "date": day.isoformat() if day else None,
            "summary_chars": work["abstract_chars"], "full_chars": 0, "has_full": False,
            "truncated": looks_truncated("x" * work["abstract_chars"]) if work["abstract_chars"] else None,
            "cjk_title_ratio": round(cjk_ratio(work["title"]), 3), "doi": work["doi"],
            "best_text_chars": work["abstract_chars"],
            "tokens": est_tokens(work["title"]) + 0.3 * work["abstract_chars"],
        })

    all_items = work_items + feed_items + api_items

    # ---- per access family
    families = {}
    by_access_rows = {}
    for row in rows:
        by_access_rows.setdefault(row.get("access"), []).append(row)
    ok_ids = {"crossref-issn": {s["source_id"] for s in cr_status if s.get("ok")},
              "rss": {s["source_id"] for s in feed_status if s.get("ok") and s["access"] == "rss"},
              "atom": {s["source_id"] for s in feed_status if s.get("ok") and s["access"] == "atom"},
              "json-api": {s["source_id"] for s in api_status if s.get("ok")}}
    skipped_ids = {"html-list": {r["id"] for r in by_access_rows.get("html-list", [])},
                   "json-api": {s["source_id"] for s in api_status if s.get("skipped")
                                or s.get("skip_reason")}}
    for access, rws in by_access_rows.items():
        ids = {r["id"] for r in rws}
        items = [i for i in all_items if i["access"] == access] if access != "crossref-issn" \
            else work_items
        recent = [i for i in items if in_window(parse_any_date(i["date"] or ""))]
        skipped = skipped_ids.get(access, set()) & ids
        attempted = len(ids) - (len(skipped) if access == "html-list" else 0)
        ok = len(ok_ids.get(access, set()) & ids)
        families[access] = {
            "sources_attempted": attempted,
            "sources_ok": ok,
            "sources_failed": attempted - ok - len(skipped if access != "html-list" else set()),
            "sources_skipped": len(skipped),
            "skip_reason": ("html-list rows are out of scope for this dry run"
                            if access == "html-list" else None),
            "items_returned_total": len(items),
            "items_last_7d": len(recent),
            "items_per_day": round(len(recent) / WINDOW_DAYS, 1),
            "title_chars": quantiles([i["title_chars"] for i in items]),
            "summary_or_abstract_chars": quantiles([i["best_text_chars"] for i in items]),
            "no_date": pct(sum(1 for i in items if not i["date"]), len(items)),
            "no_link": pct(sum(1 for i in items if not i["link"]), len(items)),
            "no_summary": pct(sum(1 for i in items if not i["best_text_chars"]), len(items)),
            "truncated_summary_of_items_with_summary": pct(
                sum(1 for i in items if i["best_text_chars"] and i.get("truncated")),
                sum(1 for i in items if i["best_text_chars"])),
            "full_content_present": pct(sum(1 for i in items if i.get("has_full")), len(items)),
            "cjk_items": pct(sum(1 for i in items if i["cjk_title_ratio"] >= 0.3), len(items)),
            "items_older_than_30d": pct(
                sum(1 for i in items if i["date"] and
                    (TODAY - parse_any_date(i["date"])).days > 30), len(items)),
        }
    out["per_access_family"] = families

    # ---- journals
    pm_by_doi = {}
    for rec in pubmed:
        if rec.get("doi"):
            pm_by_doi.setdefault(rec["doi"], rec)
    works_7d = [w for w in works if in_window(parse_any_date(w.get("created_date") or ""))]
    lags, buckets = [], {"0-1d": [0, 0], "2-3d": [0, 0], "4-7d": [0, 0]}
    pubtype_counter, only_non_research, has_research, rest = [], 0, 0, 0
    found = 0
    found_with_abstract = 0
    for work in works:
        rec = pm_by_doi.get(work.get("doi") or "")
        created = parse_any_date(work.get("created_date") or "")
        age = (TODAY - created).days if created else None
        bucket = None
        if age is not None:
            bucket = "0-1d" if age <= 1 else "2-3d" if age <= 3 else "4-7d" if age <= 7 else None
        if bucket:
            buckets[bucket][1] += 1
        if rec:
            found += 1
            if bucket:
                buckets[bucket][0] += 1
            if rec.get("has_abstract"):
                found_with_abstract += 1
            entry = parse_any_date(rec.get("entry_date") or "")
            if entry and created:
                lags.append((entry - created).days)
            types = set(rec.get("pub_types") or [])
            pubtype_counter.extend(types)
            if types and types <= NON_RESEARCH_TYPES:
                only_non_research += 1
            elif any(t in RESEARCH_TYPES_EXACT or t.startswith("Clinical Trial") for t in types):
                has_research += 1
            else:
                rest += 1
    prefix_hits = []
    for work in works:
        title = (work.get("title") or "").strip()
        for prefix in NON_ARTICLE_PREFIXES:
            if title.lower().startswith(prefix.lower()):
                prefix_hits.append({"source_id": work["source_id"], "prefix": prefix,
                                    "title": title[:140], "doi": work.get("doi")})
                break
    update_works = [w for w in works if w.get("is_update")]
    out["journals"] = {
        "journal_rows": len(by_access_rows.get("crossref-issn", [])),
        "rows_answering_200_and_parsed": sum(1 for s in cr_status if s.get("ok")),
        "rows_failed": [{"source_id": s["source_id"], "http": s.get("http"),
                         "error": s.get("error") or s.get("parse_error")}
                        for s in cr_status if not s.get("ok")],
        "rows_truncated_by_rows_100": [s["source_id"] for s in cr_status
                                       if s.get("truncated_by_rows")],
        "works_returned": len(works),
        "works_in_7d_window_by_created": len(works_7d),
        "works_per_day": round(len(works_7d) / WINDOW_DAYS, 1),
        "crossref_type_distribution": tally(w.get("type") for w in works),
        "crossref_type_note": "the registry endpoints carry filter type:journal-article, "
                              "so this distribution is pinned by the query, not by the data",
        "with_crossref_abstract": pct(sum(1 for w in works if w.get("has_abstract")), len(works)),
        "crossref_abstract_chars": quantiles(
            [w["abstract_chars"] for w in works if w.get("has_abstract")]),
        "found_in_pubmed": pct(found, len(works)),
        "with_pubmed_abstract_among_found": pct(found_with_abstract, found),
        "pubmed_abstract_chars": quantiles(
            [pm_by_doi[w["doi"]]["abstract_chars"] for w in works
             if w.get("doi") in pm_by_doi and pm_by_doi[w["doi"]]["has_abstract"]]),
        "crossref_to_pubmed_lag_days": quantiles(lags),
        "lag_days_distribution": tally(lags),
        "not_yet_in_pubmed_by_age_bucket": {
            name: pct(total - hit, total) for name, (hit, total) in buckets.items()},
        "pubmed_publication_types_top25": tally(pubtype_counter, top=25),
        "publication_type_classes": {
            "only_non_research": pct(only_non_research, found),
            "has_research_type": pct(has_research, found),
            "rest": pct(rest, found),
            "non_research_set": sorted(NON_RESEARCH_TYPES),
            "research_set": sorted(RESEARCH_TYPES_EXACT | {"Clinical Trial*"}),
        },
        "is_update": pct(len(update_works), len(works)),
        "update_types": tally([t for w in update_works for t in w.get("update_types") or []]),
        "non_article_title_prefix": pct(len(prefix_hits), len(works)),
        "non_article_title_prefix_by_prefix": tally(h["prefix"] for h in prefix_hits),
        "non_article_title_examples": prefix_hits[:15],
        "works_with_no_title": pct(sum(1 for w in works if not w.get("title")), len(works)),
        "works_with_zero_authors": pct(sum(1 for w in works if not w.get("n_authors")), len(works)),
        "n_authors": quantiles([w["n_authors"] for w in works]),
        "works_created_per_day": tally(w.get("created_date") for w in works),
        "works_created_per_weekday": tally(
            [parse_any_date(w["created_date"]).strftime("%a") for w in works
             if w.get("created_date")]),
        "pubmed_enrichment": {
            "distinct_dois_queried": len({w["doi"] for w in works if w.get("doi")}),
            "esearch_batches": len(read_jsonl("pubmed_search_stats.jsonl")),
            "pmids_returned": sum(s["count"] for s in read_jsonl("pubmed_search_stats.jsonl")),
            "pubmed_records_fetched": len(pubmed),
            "records_with_doi": sum(1 for r in pubmed if r.get("doi")),
            "records_with_entry_date": sum(1 for r in pubmed if r.get("entry_date")),
            "records_whose_doi_was_not_in_the_query": pct(
                sum(1 for r in pubmed
                    if (r.get("doi") or "") not in {w["doi"] for w in works if w.get("doi")}),
                len(pubmed)),
            "over_return_note": "PubMed's <doi>[doi] term is not an exact-string match; a batch of "
                                "40 DOIs answers with PMIDs the batch never asked for, so the "
                                "efetch result must be re-joined on the DOI, not trusted by count",
        },
    }

    # ---- duplicates
    doi_sources, title_sources, link_sources = {}, {}, {}
    for item in all_items:
        if item.get("doi"):
            doi_sources.setdefault(item["doi"], set()).add(item["source_id"])
        key = norm_title(item.get("title") or "")
        if len(key) >= 12:
            title_sources.setdefault(key, []).append(item)
        if item.get("link"):
            link_sources.setdefault(item["link"], set()).add(item["source_id"])
    multi_doi = {d: s for d, s in doi_sources.items() if len(s) > 1}
    multi_title = {t: v for t, v in title_sources.items()
                   if len({i["source_id"] for i in v}) > 1}
    multi_link = {l: s for l, s in link_sources.items() if len(s) > 1}
    items_on_multi_doi = sum(1 for i in all_items if i.get("doi") in multi_doi)
    out["duplicates"] = {
        "items_considered": len(all_items),
        "items_with_doi": pct(sum(1 for i in all_items if i.get("doi")), len(all_items)),
        "distinct_dois": len(doi_sources),
        "dois_in_more_than_one_source": pct(len(multi_doi), len(doi_sources)),
        "items_carrying_a_multi_source_doi": pct(items_on_multi_doi, len(all_items)),
        "doi_examples": [{"doi": d, "sources": sorted(s)} for d, s in
                         sorted(multi_doi.items(), key=lambda kv: -len(kv[1]))[:15]],
        "distinct_normalised_titles": len(title_sources),
        "titles_in_more_than_one_source": pct(len(multi_title), len(title_sources)),
        "title_examples": [
            {"title": v[0]["title"][:120],
             "sources": sorted({i["source_id"] for i in v})}
            for v in sorted(multi_title.values(), key=lambda v: -len(v))[:15]],
        "identical_links_across_sources": pct(len(multi_link), len(link_sources)),
        "link_examples": [{"link": l[:140], "sources": sorted(s)} for l, s in
                          sorted(multi_link.items(), key=lambda kv: -len(kv[1]))[:10]],
        "exact_duplicate_items_within_one_source": pct(
            len(all_items) - len({(i["source_id"], norm_title(i["title"] or ""), i.get("link"))
                                  for i in all_items}), len(all_items)),
    }

    # ---- tokens + lanes
    lanes = {}
    for item in all_items:
        lanes.setdefault(item.get("lane") or "unknown", []).append(item)
    lane_block, token_block = {}, {}
    for lane, items in sorted(lanes.items()):
        recent = [i for i in items if in_window(parse_any_date(i["date"] or ""))]
        lane_block[lane] = {
            "sources": len({i["source_id"] for i in items}),
            "items_returned": len(items),
            "items_last_7d": len(recent),
            "items_per_day": round(len(recent) / WINDOW_DAYS, 1),
        }
        token_block[lane] = {
            "tokens_per_item": quantiles([i["tokens"] for i in items]),
            "tokens_per_day_from_7d_items": round(sum(i["tokens"] for i in recent) / WINDOW_DAYS),
        }
    recent_all = [i for i in all_items if in_window(parse_any_date(i["date"] or ""))]
    out["per_lane"] = lane_block
    out["token_estimate"] = {
        "formula": "0.3 tokens per non-CJK character, 0.6 per CJK character, over title + best text",
        "per_lane": token_block,
        "all_items": quantiles([i["tokens"] for i in all_items]),
        "total_tokens_per_day_7d_items": round(sum(i["tokens"] for i in recent_all) / WINDOW_DAYS),
        "total_items_per_day_7d": round(len(recent_all) / WINDOW_DAYS, 1),
        "note": "titles-only ingestion would cost "
                f"{round(sum(est_tokens(i['title'] or '') for i in recent_all) / WINDOW_DAYS)} tokens/day",
    }

    # ---- per source detail
    out["feeds"] = {
        "rows": len(feed_status),
        "ok": sum(1 for s in feed_status if s.get("ok")),
        "failed": [{"source_id": s["source_id"], "http": s.get("http"),
                    "error": s.get("error"), "parse_error": s.get("parse_error")}
                   for s in feed_status if not s.get("ok")],
        "feeds_over_300_items": sorted(
            ({"source_id": s["source_id"], "items": s["items"], "bytes": s["bytes"]}
             for s in feed_status if s.get("ok") and s.get("items", 0) > 300),
            key=lambda s: -s["items"]),
        "feeds_with_no_dated_item": [s["source_id"] for s in feed_status
                                     if s.get("ok") and not s.get("items_dated")],
        "feeds_with_zero_items_in_7d": [
            {"source_id": s["source_id"], "items": s["items"], "latest": s["latest"]}
            for s in feed_status if s.get("ok") and s.get("items_7d") == 0],
        "feeds_whose_newest_item_is_over_30d_old": [
            {"source_id": s["source_id"], "latest": s["latest"]}
            for s in feed_status if s.get("ok") and s.get("latest")
            and (TODAY - parse_any_date(s["latest"])).days > 30],
        "items_per_feed": quantiles([s["items"] for s in feed_status if s.get("ok")]),
        "bytes_downloaded_total": sum(s.get("bytes") or 0 for s in feed_status),
        "share_of_feed_items_older_than_30d": pct(
            sum(1 for i in feed_items if i["date"]
                and (TODAY - parse_any_date(i["date"])).days > 30), len(feed_items)),
        "feeds_whose_every_item_is_older_than_30d": [
            s["source_id"] for s in feed_status if s.get("ok") and s.get("items")
            and s.get("latest") and (TODAY - parse_any_date(s["latest"])).days > 30],
        "per_source": sorted(feed_status, key=lambda s: -(s.get("items") or 0)),
    }
    out["json_api"] = {
        "rows": len(api_status),
        "ok": sum(1 for s in api_status if s.get("ok")),
        "skipped": [{"source_id": s["source_id"], "reason": s.get("skip_reason")}
                    for s in api_status if s.get("skipped") or s.get("skip_reason")],
        "failed": [{"source_id": s["source_id"], "http": s.get("http"),
                    "error": s.get("error"), "parse_error": s.get("parse_error")}
                   for s in api_status
                   if not s.get("ok") and not (s.get("skipped") or s.get("skip_reason"))],
        "families": tally(s.get("family") for s in api_status),
        "per_source": api_status,
    }
    out["journal_sources"] = sorted(cr_status, key=lambda s: -(s.get("items") or 0))[:400]

    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as handle:
        json.dump(out, handle, ensure_ascii=False, indent=1)
    log(f"wrote {OUT_JSON}")
    return out


def main(argv):
    phase = argv[0] if argv else "all"
    rows = load_p0()
    if phase in ("all", "crossref"):
        phase_crossref(rows)
    if phase in ("all", "pubmed"):
        phase_pubmed()
    if phase in ("all", "feeds"):
        phase_feeds(rows)
    if phase in ("all", "jsonapi"):
        phase_jsonapi(rows)
    if phase in ("all", "analyze"):
        phase_analyze(rows)


if __name__ == "__main__":
    main(sys.argv[1:])
