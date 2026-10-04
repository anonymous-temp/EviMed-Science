#!/usr/bin/env python3
"""Re-count every count/sum/share the report states itself, from the files that
hold the items. Prints one line per check: value | what it is | source file."""
import csv
import json
import os
import re

RUN = ("/workspace/bibliometric-analysis-runs/"
       "bibliometric-20261004071320-d725e01dbd9b/output")
REPORT = "/workspace/deliverables/glp1-obesity-bibliometric/bibliometric-analysis-report.md"


def rows(name):
    with open(os.path.join(RUN, name), newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def sig3(x):
    from decimal import Decimal
    from math import floor, log10
    d = Decimal(str(x))
    return float(round(d, 3 - int(floor(log10(abs(float(d))))) - 1))


out = []


def chk(label, value, src):
    out.append((label, value, src))


year = {int(r["year"]): int(r["count"]) for r in rows("tables/year_trend.csv")}
tot = sum(year.values())
chk("sum of year counts", tot, "tables/year_trend.csv")
chk("2024+2025 = 836", year[2024] + year[2025], "tables/year_trend.csv")
chk("share 2024-2025 = 0.676", sig3((year[2024] + year[2025]) / tot), "tables/year_trend.csv")
chk("2024..2026 = 931", year[2024] + year[2025] + year[2026], "tables/year_trend.csv")
chk("share 2024-2026 = 0.753", sig3((year[2024] + year[2025] + year[2026]) / tot), "tables/year_trend.csv")
chk("2015..2020 = 125", sum(year[y] for y in range(2015, 2021)), "tables/year_trend.csv")
chk("share 2015-2020 = 0.101", sig3(sum(year[y] for y in range(2015, 2021)) / tot), "tables/year_trend.csv")
chk("2021..2023 = 180", sum(year[y] for y in range(2021, 2024)), "tables/year_trend.csv")
chk("share 2021-2023 = 0.146", sig3(sum(year[y] for y in range(2021, 2024)) / tot), "tables/year_trend.csv")

au = rows("tables/top_authors.csv")
chk("max author count", max(int(r["count"]) for r in au), "tables/top_authors.csv")
chk("authors in top table", len(au), "tables/top_authors.csv")

inst = rows("tables/top_institutions.csv")
chk("max institution count", max(int(r["count"]) for r in inst), "tables/top_institutions.csv")
chk("top-3 institutions sum = 132", sum(int(r["count"]) for r in inst[:3]), "tables/top_institutions.csv")
chk("truncated institution names",
    [r["institutions"] for r in inst if not r["institutions"][:1].isupper()],
    "tables/top_institutions.csv")

j = rows("tables/top_journals.csv")
chk("journals in top table", len(j), "tables/top_journals.csv")
chk("max journal count", max(int(r["count"]) for r in j), "tables/top_journals.csv")

k = {r["keywords_merged"]: int(r["count"]) for r in rows("tables/top_keywords.csv")}
for term in ["Obesity", "Glucagon-Like Peptide-1 Receptor Agonists", "Diabetes Mellitus, Type 2",
             "Hypoglycemic Agents", "Weight Loss", "GLP-1 receptor agonists",
             "Glucagon-Like Peptide 1", "Semaglutide", "Liraglutide", "Tirzepatide", "Exenatide"]:
    chk(f"keyword {term}", k.get(term), "tables/top_keywords.csv")

pt = rows("tables/pub_type_distribution.csv")
chk("publication-type rows", len(pt), "tables/pub_type_distribution.csv")
_pcol = list(pt[0].keys())[1]
chk("publication-type class sum = 2379", sum(int(r[_pcol]) for r in pt), "tables/pub_type_distribution.csv")
chk("type table raw", pt, "tables/pub_type_distribution.csv")

c = [(r["countries"], int(r["count"])) for r in rows("tables/top_countries.csv")]
cw = sum(w for _, w in c)
sh = [w / cw for _, w in c]
chk("countries in table", len(c), "tables/top_countries.csv")
chk("table attributed total = 1332", cw, "tables/top_countries.csv")
chk("top-3 share = 0.491", sig3(sum(sh[:3])), "tables/top_countries.csv")
chk("top-5 share = 0.616", sig3(sum(sh[:5])), "tables/top_countries.csv")
chk("HHI (20 countries) = 0.124", sig3(sum(s * s for s in sh)), "tables/top_countries.csv")

pairs = rows("data/country_collaboration.csv")
seen = {}
for p in pairs:
    seen[p["source"]] = int(p["source_freq"])
    seen[p["target"]] = int(p["target_freq"])
cw_all = sum(seen.values())
sh_all = sorted((w / cw_all for w in seen.values()), reverse=True)
chk("countries in collaboration file", len(seen), "data/country_collaboration.csv")
chk("all-country attributed total = 1534", cw_all, "data/country_collaboration.csv")
chk("top-3 share all countries = 0.426", sig3(sum(sh_all[:3])), "data/country_collaboration.csv")
chk("top-5 share all countries = 0.535", sig3(sum(sh_all[:5])), "data/country_collaboration.csv")
chk("HHI all countries = 0.0943", sig3(sum(s * s for s in sh_all)), "data/country_collaboration.csv")
chk("table share of all mentions = 0.868", sig3(cw / cw_all), "both country files")

res = json.load(open(os.path.join(RUN, "result.json"), encoding="utf-8"))
cov = res["citationCoverage"]
chk("citation observed/total = 0.0291", sig3(cov["observed"] / cov["total"]), "result.json")
chk("citation observed", cov["observed"], "result.json")
chk("citation missing", cov["missing"], "result.json")

cr = rows("tables/collaboration_pairs.csv") if os.path.exists(
    os.path.join(RUN, "tables/collaboration_pairs.csv")) else None
chk("coupling pairs", len(rows("tables/bibliographic_coupling_pairs.csv")),
    "tables/bibliographic_coupling_pairs.csv")
chk("cocitation pairs", len(rows("tables/cocitation_pairs.csv")), "tables/cocitation_pairs.csv")

# what the report says, for side-by-side
text = open(REPORT, encoding="utf-8").read()
for pat in [r"1,3\d\d 条", r"占全部记录的 [\d.]+%", r"合计 \d+ 条", r"0\.\d{3}", r"模块度 Q 为 [\d.]+"]:
    chk(f"report mentions /{pat}/", sorted(set(re.findall(pat, text)))[:12], "report")

for label, value, src in out:
    print(f"{str(value):<70} | {label:<48} | {src}")
