#!/usr/bin/env python3
"""Derived values for the GLP-1 / obesity bibliometric report.

Every value printed here is computed from the managed job's own output files
under RUN (read-only). The report copies these values; nothing is typed by hand.

Definitions
-----------
derived.AnnualTotals  sums of tables/year_trend.csv counts (counting basis: one
                      record per row)
derived.RecentShare   sum(2024,2025) / sum(all years)  and the 2024-2026 variant
derived.EarlyShare    sum(2015..2020) / sum(all years)
derived.MidShare      sum(2021..2023) / sum(all years)
derived.CountryShares share of the country-attributed total (data/country_collaboration.csv
                      weight column); top3/top5 shares are sums of the largest shares
derived.HHI           sum of squared country shares (Herfindahl-Hirschman index)
derived.CitationShare observed / analysed records for the citation module
derived.CorpusTotals  sums over tables/top_authors.csv and tables/top_institutions.csv
"""
import csv
import json
import os

RUN = ("/workspace/bibliometric-analysis-runs/"
       "bibliometric-20261004071320-d725e01dbd9b/output")
OUT = "/workspace/deliverables/glp1-obesity-bibliometric/derived-values.json"


def rows(name):
    with open(os.path.join(RUN, name), newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def r3(x):
    """3 significant figures, as the engine's display convention requires."""
    if x == 0:
        return 0.0
    from decimal import Decimal
    from math import floor, log10
    d = Decimal(str(x))
    digits = 3 - int(floor(log10(abs(float(d))))) - 1
    return float(round(d, digits))


year = {int(r["year"]): int(r["count"]) for r in rows("tables/year_trend.csv")}
total = sum(year.values())
ann = {
    "years": sorted(year),
    "counts": {str(k): year[k] for k in sorted(year)},
    "total": total,
    "sum_2024_2025": year[2024] + year[2025],
    "sum_2024_2026": year[2024] + year[2025] + year[2026],
    "sum_2015_2020": sum(year[y] for y in range(2015, 2021)),
    "sum_2021_2023": sum(year[y] for y in range(2021, 2024)),
    "share_2024_2025": r3((year[2024] + year[2025]) / total),
    "share_2024_2026": r3((year[2024] + year[2025] + year[2026]) / total),
    "share_2015_2020": r3(sum(year[y] for y in range(2015, 2021)) / total),
    "share_2021_2023": r3(sum(year[y] for y in range(2021, 2024)) / total),
}

ctry = [(r["countries"], int(r["count"])) for r in rows("tables/top_countries.csv")]
ctry.sort(key=lambda t: -t[1])
n_table = len(ctry)
cw = sum(w for _, w in ctry)
shares = [(c, w, w / cw) for c, w in ctry]

# same three shares on the wider denominator: every country that appears in the
# collaboration file, taken from the node frequency columns the file carries.
pairs, seen = rows("data/country_collaboration.csv"), {}
for p in pairs:
    seen[p["source"]] = int(p["source_freq"])
    seen[p["target"]] = int(p["target_freq"])
cw_all = sum(seen.values())
shares_all = sorted(((c, w / cw_all) for c, w in seen.items()), key=lambda t: -t[1])

country = {
    "table_countries": n_table,
    "table_attributed_total": cw,
    "all_countries": len(seen),
    "all_attributed_total": cw_all,
    "table_share_of_all_mentions": r3(cw / cw_all),
    "top10": [{"country": c, "weight": w, "share": r3(s)} for c, w, s in shares[:10]],
    "share_top3": r3(sum(s for _, _, s in shares[:3])),
    "share_top5": r3(sum(s for _, _, s in shares[:5])),
    "hhi": r3(sum(s * s for _, _, s in shares)),
    "share_top3_all_countries": r3(sum(s for _, s in shares_all[:3])),
    "share_top5_all_countries": r3(sum(s for _, s in shares_all[:5])),
    "hhi_all_countries": r3(sum(s * s for _, s in shares_all)),
}

r = json.load(open(os.path.join(RUN, "result.json"), encoding="utf-8"))
cov = r["citationCoverage"]
citation = {
    "analysed_records": r["records"],
    "observed": cov["observed"],
    "missing": cov["missing"],
    "observed_share": r3(cov["observed"] / r["records"]),
    "by_source": cov["by_source"],
    "reference_relations": cov["reference_relations"],
}

top_authors = rows("tables/top_authors.csv")
top_inst = rows("tables/top_institutions.csv")

out = {
    "source_run_output": RUN,
    "definitions": __doc__.split("Definitions")[1].strip().split("derived.CorpusTotals")[0].strip(),
    "derived": {
        "AnnualTotals": ann,
        "CountryShares": country,
        "CitationCoverage": citation,
        "TopListCounts": {
            "top_authors_rows": len(top_authors),
            "top_authors_max": max(int(x["count"]) for x in top_authors),
            "top_institutions_rows": len(top_inst),
            "top_institutions_max": max(int(x["count"]) for x in top_inst),
            "top_institutions_top3_sum": sum(int(x["count"]) for x in top_inst[:3]),
            "top_institutions_truncated_names": [
                x["institutions"] for x in top_inst if not x["institutions"][:1].isupper()
            ],
        },
    },
}
with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, indent=2)
print(json.dumps(out["derived"], ensure_ascii=False, indent=2))
