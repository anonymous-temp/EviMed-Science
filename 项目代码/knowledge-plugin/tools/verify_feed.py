#!/usr/bin/env python3
"""Probe one candidate source endpoint and print one JSON line describing what came back.

Usage:  verify_feed.py <url> [<url> ...]
        verify_feed.py --registry sources.json --out verified.json [--only-unverified] [--workers 8]

A feed counts as working when it answers 200 and parses to at least one item.
An HTML list page counts as reachable when it answers 200 without a bot challenge.
Standard library plus curl only, so it runs on any box without an install step.
"""
import concurrent.futures
import datetime as dt
import email.utils
import html.parser
import json
import re
import subprocess
import sys
import tempfile
import os

# Adapted for the plugin (2026-09-22): the default identity is the crawler's own honest one,
# EviMedBot with the contact address from KNOWLEDGE_PLUGIN_CONTACT_EMAIL_FILE (or _EMAIL); VERIFY_UA
# still overrides it. The registry was first probed with a desktop-browser string, but FDA, CDC and
# Health Canada refuse a browser string from a datacenter IP and answer the honest one (2026-09-22),
# so a probe should see what the crawler will see.
def _contact():
    path = os.environ.get("KNOWLEDGE_PLUGIN_CONTACT_EMAIL_FILE")
    if path:
        try:
            with open(path, encoding="utf-8") as handle:
                value = handle.read().strip()
            if value:
                return value
        except OSError:
            pass
    return (os.environ.get("KNOWLEDGE_PLUGIN_CONTACT_EMAIL") or "").strip() or None


_CONTACT = _contact()
UA = os.environ.get("VERIFY_UA") or ("EviMedBot/1.0 (+https://www.evimed.com; knowledge-source monitor"
                                     + (f"; mailto:{_CONTACT})" if _CONTACT else ")"))

CHALLENGES = [
    ("cloudflare", re.compile(r"Just a moment\.\.\.|cf-chl-|challenge-platform|Attention Required! \| Cloudflare", re.I)),
    ("ruishu", re.compile(r"\$_ts\s*=|_\$[a-zA-Z0-9]{2}\(|/[A-Za-z0-9]{8,}/[A-Za-z0-9]{8,}\.[a-f0-9]{6,}\.js", re.I)),
    ("akamai", re.compile(r"Access Denied.*Reference #|errors\.edgesuite\.net", re.I | re.S)),
    ("incapsula", re.compile(r"Incapsula incident|_Incapsula_Resource", re.I)),
    ("datadome", re.compile(r"datadome|captcha-delivery\.com", re.I)),
    ("perimeterx", re.compile(r"px-captcha|perimeterx", re.I)),
    ("aliyun-waf", re.compile(r"acw_sc__v2|aliyun_waf|renderData.*captcha", re.I | re.S)),
    ("volc-waf", re.compile(r"security check|verifycenter|captcha\.volces|byted_acrawler", re.I)),
    ("ruishu", re.compile(r'<meta\s+id="[A-Za-z0-9]{16,}"\s+content=', re.I)),
]

DATE_TAGS = re.compile(
    r"<(?:pubDate|published|updated|dc:date|prism:publicationDate|prism:coverDate|date)[^>]*>\s*([^<]{6,40})\s*<", re.I)


class _Anchors(html.parser.HTMLParser):
    """Counts links that carry real text, nested tags included: <a href><h3>title</h3></a> is a list item too."""
    def __init__(self):
        super().__init__(convert_charrefs=True); self.depth = 0; self.buf = []; self.count = 0
    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href") or ""
            if href and not href.startswith(("#", "javascript:")):
                self.depth += 1; self.buf = []
    def handle_endtag(self, tag):
        if tag == "a" and self.depth:
            self.depth -= 1
            if len("".join(self.buf).strip()) >= 6: self.count += 1
    def handle_data(self, data):
        if self.depth: self.buf.append(data)


def count_text_anchors(text):
    parser = _Anchors()
    try:
        parser.feed(text[:2_000_000])
    except Exception:
        pass
    return parser.count


def parse_date(text):
    text = text.strip()
    try:
        return email.utils.parsedate_to_datetime(text).astimezone(dt.timezone.utc)
    except Exception:
        pass
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?", text)
    if m:
        y, mo, d, h, mi = m.groups()
        try:
            return dt.datetime(int(y), int(mo), int(d), int(h or 0), int(mi or 0), tzinfo=dt.timezone.utc)
        except ValueError:
            return None
    return None


def fetch(url, timeout=35):
    body = tempfile.NamedTemporaryFile(delete=False)
    body.close()
    cmd = ["curl", "-sS", "-g", "-L", "--compressed", "-m", str(timeout), "-A", UA,
           "-H", "Accept: application/rss+xml, application/atom+xml, application/xml;q=0.9, application/json;q=0.9, text/html;q=0.8, */*;q=0.5",
           "-H", "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8",
           "-o", body.name, "-w", "%{http_code}\t%{content_type}\t%{url_effective}\t%{time_total}", url]
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)
        meta = (done.stdout or "").strip().split("\t")
        with open(body.name, "rb") as handle:
            raw = handle.read()
        err = (done.stderr or "").strip()[:200]
    except subprocess.TimeoutExpired:
        meta, raw, err = ["000", "", url, str(timeout)], b"", "timeout"
    finally:
        try:
            os.unlink(body.name)
        except OSError:
            pass
    while len(meta) < 4:
        meta.append("")
    return int(meta[0] or 0), meta[1], meta[2], float(meta[3] or 0), raw, err


def probe(url):
    http, ctype, final_url, seconds, raw, err = fetch(url)
    text = raw[:12_000_000].decode("utf-8", "replace")
    head = text[:6000]
    result = {"url": url, "http": http, "content_type": ctype.split(";")[0].strip(), "bytes": len(raw),
              "seconds": round(seconds, 2), "checked_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    if final_url and final_url != url:
        result["final_url"] = final_url
    if err:
        result["error"] = err
    challenge = next((name for name, pattern in CHALLENGES if pattern.search(head)), None)
    if http in (202, 403, 412, 429, 503, 514) or challenge:
        result["anti_bot"] = challenge or f"http-{http}"
    kind = "unknown"
    stripped = text.lstrip("﻿ \r\n\t")
    if stripped.startswith("{") or stripped.startswith("["):
        kind = "json"
        try:
            data = json.loads(stripped)
            if isinstance(data, dict) and isinstance(data.get("items"), list) and "version" in data:
                kind = "jsonfeed"
                result["items"] = len(data["items"])
            elif isinstance(data, dict):
                result["json_keys"] = list(data.keys())[:12]
                lists = {k: len(v) for k, v in data.items() if isinstance(v, list)}
                if lists:
                    result["json_lists"] = lists
            else:
                result["items"] = len(data)
        except Exception:
            result["json_error"] = True
    elif re.search(r"<rss[\s>]|<rdf:RDF[\s>]", head, re.I):
        kind = "rss"
    elif re.search(r"<feed[\s>]", head, re.I):
        kind = "atom"
    elif re.search(r"<html[\s>]|<!doctype html", head, re.I):
        kind = "html"
    elif stripped.startswith("<?xml") or "xml" in ctype:
        kind = "xml"  # a plain XML API answer (E-utilities efetch, ISRCTN): not a feed, still machine-readable
    result["kind"] = kind
    if kind in ("rss", "atom"):
        result["items"] = len(re.findall(r"<item[\s>]|<entry[\s>]", text))
        dates = [d for d in (parse_date(m) for m in DATE_TAGS.findall(text)) if d]
        now = dt.datetime.now(dt.timezone.utc)
        dates = [d for d in dates if d <= now + dt.timedelta(days=2)]
        if dates:
            newest = max(dates)
            result["latest"] = newest.strftime("%Y-%m-%d")
            result["age_days"] = (now - newest).days
            week = [d for d in dates if (now - d).days <= 7]
            result["dated_last_7d"] = len(week)
        title = re.search(r"<title[^>]*>\s*(?:<!\[CDATA\[)?\s*([^<\]]{1,120})", text)
        if title:
            result["feed_title"] = title.group(1).strip()
    elif kind == "html":
        title = re.search(r"<title[^>]*>\s*([^<]{1,120})", text, re.I)
        if title:
            result["page_title"] = title.group(1).strip()
        result["anchors"] = count_text_anchors(text)
        result["dates_on_page"] = len(re.findall(r"20\d{2}[-/.年]\s?\d{1,2}[-/.月]\s?\d{1,2}", text))
        alt = re.findall(r'<link[^>]+type="application/(?:rss|atom)\+xml"[^>]*href="([^"]+)"', text, re.I)
        if alt:
            result["advertised_feeds"] = alt[:5]
    ok_feed = kind in ("rss", "atom", "jsonfeed") and http == 200 and result.get("items", 0) > 0
    ok_api = http == 200 and ((kind == "json" and not result.get("json_error")) or (kind == "xml" and len(raw) > 500))
    ok_html = kind == "html" and http == 200 and "anti_bot" not in result and result.get("anchors", 0) >= 8
    result["verdict"] = "feed-ok" if ok_feed else "api-ok" if ok_api else "page-ok" if ok_html else "blocked" if "anti_bot" in result else "failed"
    return result


def main(argv):
    if argv and argv[0] == "--registry":
        args = dict(zip(argv[::2], argv[1::2])) if len(argv) % 2 == 0 else {}
        flags = [a for a in argv if a in ("--only-unverified",)]
        path = argv[1]
        out = argv[argv.index("--out") + 1] if "--out" in argv else path
        workers = int(argv[argv.index("--workers") + 1]) if "--workers" in argv else 8
        with open(path, encoding="utf-8") as handle:
            rows = json.load(handle)
        todo = [r for r in rows if r.get("endpoint") and not (flags and r.get("verified", {}).get("verdict") in ("feed-ok", "api-ok", "page-ok"))]
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            for row, res in zip(todo, pool.map(lambda r: probe(r["endpoint"]), todo)):
                res.pop("url", None)
                row["verified"] = res
        with open(out, "w", encoding="utf-8") as handle:
            json.dump(rows, handle, ensure_ascii=False, indent=1)
        tally = {}
        for r in rows:
            v = r.get("verified", {}).get("verdict", "unchecked")
            tally[v] = tally.get(v, 0) + 1
        print(json.dumps(tally, ensure_ascii=False))
        return
    workers = 1
    if "--workers" in argv:
        at = argv.index("--workers"); workers = int(argv[at + 1]); argv = argv[:at] + argv[at + 2:]
    if argv == ["-"]:
        argv = [line.strip() for line in sys.stdin if line.strip()]
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for result in pool.map(probe, argv):
            print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
