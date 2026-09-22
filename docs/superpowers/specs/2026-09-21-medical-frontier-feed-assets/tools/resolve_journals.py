#!/usr/bin/env python3
"""Second pass: resolve ISSNs through Crossref's journal index (OpenAlex now needs a key), with manual
overrides for titles that resolve badly, then measure 7- and 30-day volume in Crossref and PubMed."""
import json, sys, time, re, urllib.parse, subprocess, datetime as dt, os
SRC, OUT = sys.argv[1], sys.argv[2]
OVERRIDE = {
 "The New England Journal of Medicine": ["0028-4793","1533-4406"],
 "JAMA": ["0098-7484","1538-3598"],
 "BMJ": ["0959-8138","1756-1833"],
 "The Lancet Gastroenterology & Hepatology": ["2468-1253","2468-1156"],
 "PEDIATRICS": ["0031-4005","1098-4275"],
 "CHEST Journal": ["0012-3692","1931-3543"],
 "Med": ["2666-6340","2666-6359"],
 "Blood": ["0006-4971","1528-0020"],
 "Drugs": ["0012-6667","1179-1950"],
 "Epidemiology": ["1044-3983","1531-5487"],
 "Radiology": ["0033-8419","1527-1315"],
 "Ophthalmology": ["0161-6420","1549-4713"],
 "Anesthesiology": ["0003-3022","1528-1175"],
 "Chinese Medicine": ["1749-8546"],
 "Systematic Reviews": ["2046-4053"],
 "Cochrane Database of Systematic Reviews": ["1469-493X","1465-1858"],
 "The Lancet Child & Adolescent Health": ["2352-4642","2352-4650"],
 "Clinical Pharmacology & Therapeutics": ["0009-9236","1532-6535"],
 "BMJ Evidence-Based Medicine": ["2515-446X","2515-4478"],
 "Journal of Traditional Chinese Medicine": ["0254-6272","2589-451X"],
}
def get(url, timeout=40):
    for attempt in range(3):
        p = subprocess.run(["curl","-sS","-g","-L","--compressed","-m",str(timeout),"-A","EviMedFrontierResearch/0.1 (source registry build)",url],capture_output=True,text=True)
        try: return json.loads(p.stdout)
        except Exception: time.sleep(2+attempt*3)
    return None
def norm(s): return re.sub(r"[^a-z0-9]+"," ",re.sub(r"^the\s+","",s.lower())).strip()
prev = {}
if os.path.exists(SRC):
    for line in open(SRC, encoding="utf-8"):
        r = json.loads(line); prev[r["title"]] = r
done = set()
if os.path.exists(OUT):
    for line in open(OUT, encoding="utf-8"):
        try: done.add(json.loads(line)["title"])
        except Exception: pass
today = dt.date.today(); d7 = (today-dt.timedelta(days=7)).isoformat(); d30 = (today-dt.timedelta(days=30)).isoformat()
for line in open("/tmp/medhot/journals.tsv", encoding="utf-8"):
    cat, sub, title, zh = line.rstrip("\n").split("\t")
    if title in done: continue
    row = {"title": title, "name": zh, "category": cat, "subcategory": sub}
    old = prev.get(title, {})
    if title in OVERRIDE:
        issns, how = OVERRIDE[title], "manual"
    elif old.get("exact") and old.get("issns"):
        issns, how = old["issns"], "openalex-exact"
        row["org"] = old.get("org"); row["homepage"] = old.get("homepage")
    else:
        d = get("https://api.crossref.org/journals?rows=8&query="+urllib.parse.quote(title))
        items = ((d or {}).get("message") or {}).get("items", [])
        exact = [j for j in items if norm(j.get("title","")) == norm(title)]
        pick = max(exact, key=lambda j: (j.get("counts") or {}).get("total-dois", 0), default=None)
        if not pick:
            row["error"] = "no-exact-match"; row["candidates"] = [j.get("title") for j in items][:5]
            open(OUT,"a",encoding="utf-8").write(json.dumps(row,ensure_ascii=False)+"\n"); print("NO MATCH", title, row["candidates"], flush=True); continue
        issns, how = pick.get("ISSN") or [], "crossref-exact"; row["org"] = pick.get("publisher")
        time.sleep(0.3)
    row["issns"], row["resolved_by"] = issns, how
    best = None
    for issn in issns:
        c7 = get(f"https://api.crossref.org/journals/{issn}/works?filter=from-created-date:{d7},type:journal-article&rows=1&sort=created&order=desc&select=DOI,title,created,abstract")
        if not c7 or c7.get("status") != "ok": time.sleep(0.3); continue
        c30 = get(f"https://api.crossref.org/journals/{issn}/works?filter=from-created-date:{d30},type:journal-article&rows=1&sort=created&order=desc&select=DOI,created,abstract")
        m7, m30 = c7["message"], ((c30 or {}).get("message") or {})
        items = m30.get("items") or m7.get("items") or []
        cand = {"issn": issn, "created_last_7d": m7.get("total-results",0), "created_last_30d": m30.get("total-results",0), "latest_created": (items[0]["created"]["date-time"] if items else None), "latest_has_abstract": bool(items and items[0].get("abstract"))}
        if not best or cand["created_last_30d"] > best["created_last_30d"]: best = cand
        if cand["created_last_30d"] > 0: break
        time.sleep(0.3)
    row["crossref"] = best
    term = "+OR+".join(f"{i}[is]" for i in issns)
    for days, key in ((7,"pubmed_last_7d"),(30,"pubmed_last_30d")):
        p = get(f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=0&datetype=edat&reldate={days}&term=({term})")
        try: row[key] = int(p["esearchresult"]["count"])
        except Exception: row[key] = None
        time.sleep(0.4)
    open(OUT,"a",encoding="utf-8").write(json.dumps(row,ensure_ascii=False)+"\n")
    b = best or {}
    print(f'{title[:44]:44s} {how:14s} {issns} cr7={b.get("created_last_7d")} cr30={b.get("created_last_30d")} latest={str(b.get("latest_created"))[:10]} abs={b.get("latest_has_abstract")} pm7={row.get("pubmed_last_7d")} pm30={row.get("pubmed_last_30d")}', flush=True)
