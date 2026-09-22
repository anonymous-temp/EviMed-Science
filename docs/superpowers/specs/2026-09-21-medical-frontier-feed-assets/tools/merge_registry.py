#!/usr/bin/env python3
"""Merge the research slices into one registry (sources.json), de-duplicate, and map every row to a reader-facing lane.
Usage: merge_registry.py            -> writes ../sources.json and prints a tally."""
import json, glob, os, re, datetime as dt, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__)); R = os.path.join(HERE, "..", "research"); OUT = os.path.join(HERE, "..", "sources.json")
LANE = {  # research category -> reader-facing lane
 "journal-general": "evidence", "journal-specialty": "evidence", "journal-ai-med": "ai", "journal-methods": "research", "journal-tcm": "evidence",
 "journal-pharmacy": "safety", "journal-cn": "evidence", "literature-stream": "evidence", "preprint": "evidence", "trial-registry": "pipeline",
 "scholarly-signal": "research", "regulator": "regulatory", "drug-safety": "safety", "hta-access": "regulatory", "industry-media": "pipeline",
 "company": "pipeline", "evidence": "guideline", "guideline": "guideline", "methods": "research", "public-health": "public-health",
 "funding-policy": "research", "med-news-en": "news", "conference": "conference", "cn-media-clinical": "news", "cn-media-pharma": "pipeline",
 "cn-media-science": "research", "cn-wechat": "news", "ai-vendor": "ai", "ai-media": "ai", "ai-medicine": "ai", "ai-research-tools": "ai", "ai-benchmark": "ai"}
ORDER = ["04-", "07-", "05-", "10-", "06-", "08-", "09-"]
def key(url):
    u = urllib.parse.urlsplit(url.strip()); host = u.netloc.lower().removeprefix("www.")
    return host + u.path.rstrip("/") + ("?" + u.query if u.query else "")
rows, seen = [], {}
since = (dt.date.today() - dt.timedelta(days=7)).isoformat()
jf = os.path.join(R, "01-journals.jsonl")
if os.path.exists(jf):
    for line in open(jf, encoding="utf-8"):
        j = json.loads(line)
        if j.get("error") or not j.get("issns"): continue
        cr = j.get("crossref") or {}; issn = cr.get("issn") or j["issns"][0]
        term = "+OR+".join(f"{i}[is]" for i in j["issns"])
        rows.append({"id": "j-" + issn.lower(), "name": j["name"], "org": j.get("org") or "", "category": j["category"], "subcategory": j["subcategory"],
          "lang": "en", "region": "INT", "homepage": j.get("homepage") or "", "access": "crossref-issn",
          "endpoint": f"https://api.crossref.org/journals/{issn}/works?filter=from-created-date:{since},type:journal-article&rows=100&sort=created&order=desc&select=DOI,title,created,type,abstract,author,container-title",
          "endpoint_alt": [f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=100&datetype=edat&reldate=7&term=({term})"],
          "cadence": "daily", "volume_per_week": max(cr.get("created_last_7d") or 0, j.get("pubmed_last_7d") or 0),
          "signal": "新发表论文（Crossref 登记即发现，PubMed / Europe PMC 补摘要与文献类型）", "why": "", "tier": "P0" if (cr.get("created_last_30d") or j.get("pubmed_last_30d")) else "P1",
          "anti_bot": "none", "fallback": "", "note": f"ISSN {', '.join(j['issns'])}；近 30 天 Crossref {cr.get('created_last_30d')} 篇、PubMed {j.get('pubmed_last_30d')} 篇；Crossref 自带摘要：{'是' if cr.get('latest_has_abstract') else '否'}",
          "measured": {"crossref_7d": cr.get("created_last_7d"), "crossref_30d": cr.get("created_last_30d"), "pubmed_7d": j.get("pubmed_last_7d"), "pubmed_30d": j.get("pubmed_last_30d"), "latest_created": cr.get("latest_created")}, "slice": "01-journals"})
files = sorted([f for f in glob.glob(os.path.join(R, "*.jsonl")) if re.match(r"\d\d-", os.path.basename(f))], key=lambda f: next((i for i, p in enumerate(ORDER) if os.path.basename(f).startswith(p)), 99))
for f in files:
    base = os.path.basename(f)
    if base.startswith("01-"): continue
    for n, line in enumerate(open(f, encoding="utf-8"), 1):
        line = line.strip()
        if not line: continue
        try: r = json.loads(line)
        except Exception as e: print("BAD", base, n, e); continue
        r["slice"] = base.replace(".jsonl", ""); rows.append(r)
out, dropped = [], []
ids = set()
for r in rows:
    k = key(r["endpoint"]) if r.get("endpoint", "").startswith("http") else "id:" + r["id"]
    if k in seen: dropped.append((r["id"], seen[k])); continue
    seen[k] = r["id"]
    if r["id"] in ids: r["id"] = r["id"] + "-" + r["slice"][:2]
    ids.add(r["id"]); r["lane"] = LANE.get(r.get("category"), "news"); out.append(r)
json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("rows", len(out), "dropped duplicates", len(dropped))
for d in dropped: print("  dup", d)
