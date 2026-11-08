"""Draw the TrialLink report's figures: the architecture, and the two headline boards from leaderboard.json (the tables in README.md
carry every number).

    python3 make_figures.py   # writes fig0-architecture, fig1-ranking and fig2-nih-trialbench (.svg and .png) beside this file
"""
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch  # noqa: E402

HERE = Path(__file__).resolve().parent
SURFACE, INK, INK_2, MUTED, GRID, AXIS = "#fcfcfb", "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7"
ACCENT, OTHER = "#2a78d6", "#898781"  # TrialLink in the accent, every comparator in one recessive tone
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "svg.fonttype": "none"})


def bars(rows, title, subtitle, xlabel, xmax, fmt, out):
    """Horizontal bars from a zero baseline, best first; value at the tip; the TrialLink interval as a thin whisker."""
    rows = sorted(rows, key=lambda r: -r["value"])
    n = len(rows)
    fig, ax = plt.subplots(figsize=(8.2, 0.42 * n + 1.5), facecolor=SURFACE)
    ax.set_facecolor(SURFACE)
    ax.set_xlim(0, xmax)
    ax.set_ylim(n - 0.4, -0.6)
    height = 0.52
    for i, row in enumerate(rows):
        color = ACCENT if row["self"] else OTHER
        v = row["value"]
        ax.barh(i, v, height=height, color=color, linewidth=0)
        tip = v
        if row.get("ci"):
            lo, hi = row["ci"]
            ax.plot([lo, hi], [i, i], color=INK_2, linewidth=1.2, solid_capstyle="butt")
            ax.plot([lo, lo], [i - 0.13, i + 0.13], color=INK_2, linewidth=1.2)
            ax.plot([hi, hi], [i - 0.13, i + 0.13], color=INK_2, linewidth=1.2)
            tip = max(tip, hi)
        ax.text(tip + xmax * 0.012, i, fmt(v, row), va="center", ha="left", color=INK, fontsize=10,
                fontweight="bold" if row["self"] else "normal")
    ax.set_yticks(range(n))
    ax.set_yticklabels([r["label"] for r in rows])
    for label, row in zip(ax.get_yticklabels(), rows):
        label.set_color(INK)
        label.set_fontweight("bold" if row["self"] else "normal")
    ax.tick_params(axis="y", length=0, pad=8)
    ax.tick_params(axis="x", colors=MUTED, length=0)
    ax.xaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    for side in ("top", "right", "bottom"):
        ax.spines[side].set_visible(False)
    ax.spines["left"].set_color(AXIS)
    ax.set_xlabel(xlabel, color=INK_2)
    fig.text(0.012, 0.975, title, ha="left", va="top", fontsize=12.5, fontweight="bold", color=INK)
    fig.text(0.012, 0.975 - 0.32 / fig.get_figheight(), subtitle, ha="left", va="top", fontsize=9.5, color=INK_2)
    fig.tight_layout(rect=(0, 0, 1, 1 - 0.62 / fig.get_figheight()))
    for suffix in ("svg", "png"):
        fig.savefig(HERE / f"{out}.{suffix}", dpi=200, facecolor=SURFACE)
    plt.close(fig)


def architecture(out):
    """One pipeline, three stages: retrieval (two searches fused), ranking (two readings fused) and the criterion-level assessment."""
    fig, ax = plt.subplots(figsize=(11.5, 4.4), facecolor=SURFACE)
    ax.set_facecolor(SURFACE)
    ax.set_xlim(0, 120)
    ax.set_ylim(0, 46)
    ax.axis("off")
    panel, chip = "#f0efec", "#ffffff"

    def box(x, y, w, h, fill, edge=AXIS, lw=1.0, r=1.2):
        ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle=f"round,pad=0,rounding_size={r}", facecolor=fill, edgecolor=edge, linewidth=lw))

    def text(x, y, s, size=9, color=INK, weight="normal", ha="center"):
        ax.text(x, y, s, ha=ha, va="center", fontsize=size, color=color, fontweight=weight, linespacing=1.35)

    def arrow(x0, y0, x1, y1, dashed=False):
        ax.add_patch(FancyArrowPatch((x0, y0), (x1, y1), arrowstyle="-|>", mutation_scale=11, color=INK_2, linewidth=1.2,
                                     linestyle="--" if dashed else "-", shrinkA=0, shrinkB=0))

    def stage(x, number, name, left, right, merged, note):
        box(x, 6, 36, 33, panel, edge=panel)
        text(x + 18, 36, f"{number}  {name}", size=10.5, weight="bold", color=ACCENT)
        box(x + 1.5, 20, 15.5, 12, chip); text(x + 9.25, 26, left)
        box(x + 19, 20, 15.5, 12, chip); text(x + 26.75, 26, right)
        box(x + 1.5, 8, 33, 7.5, chip, edge=ACCENT, lw=1.4); text(x + 18, 11.75, merged)
        arrow(x + 9.25, 20, x + 9.25, 15.5)
        arrow(x + 26.75, 20, x + 26.75, 15.5)
        text(x + 18, 2.8, note, size=8.5, color=INK_2)

    text(1, 43.3, "TrialLink: from a patient record to ranked, assessed clinical trials", size=12.5, weight="bold", ha="left")
    box(1, 17, 10.5, 10, chip)
    text(6.25, 22, "Patient\nrecord", size=9.5, weight="bold")
    stage(15, 1, "Retrieval", "Keyword search\ncondition + 32\nranked terms", "Semantic search\nQwen3.7 text\nembedding",
          "Rank fusion, age/sex filter: top 300", "Live: ClinicalTrials.gov · EU CTIS · ChiCTR")
    stage(55, 2, "Ranking", "Relevance\nreranker\nQwen3.7 rerank", "Eligibility-fit\nscorer\nJev 1.14, 5 levels",
          "Rank fusion of the two orders (k = 60)", "Whole trial record; no general reasoning model")
    box(95, 27, 23.5, 10, chip, edge=ACCENT, lw=1.4)
    text(106.75, 32, "Ranked trials", size=9.5, weight="bold")
    box(95, 6, 23.5, 16, panel, edge=panel)
    text(106.75, 19.5, "3  Assessment", size=10.5, weight="bold", color=ACCENT)
    text(106.75, 12, "Each inclusion and exclusion\ncriterion: met, not met or\nnot enough information\nDeepSeek V4.1 Flash agent", size=8.3)
    arrow(11.5, 22, 15, 22)
    arrow(51, 22, 55, 22)
    ax.plot([91, 93, 93], [22, 22, 32], color=INK_2, linewidth=1.2, solid_joinstyle="miter")
    arrow(93, 32, 95, 32)
    arrow(106.75, 27, 106.75, 22.2, dashed=True)
    text(111.6, 24.6, "trials the\nclinician opens", size=7.5, color=INK_2)
    fig.tight_layout(pad=0.4)
    for suffix in ("svg", "png"):
        fig.savefig(HERE / f"{out}.{suffix}", dpi=200, facecolor=SURFACE)
    plt.close(fig)

def main():
    data = json.loads((HERE / "leaderboard.json").read_text())
    boards = {b["id"]: b for b in data["boards"]}
    architecture("fig0-architecture")
    ranking = [{"label": "TrialLink (EviMed)" if r["system"] == "TrialLink" else f"{r['system']} · {r['models']}",
                "value": r["scores"]["ndcg@10"], "self": r["system"] == "TrialLink", "ci": r.get("ci95", {}).get("ndcg@10")}
               for r in boards["patient-to-trial-ranking"]["rows"]]
    bars(ranking, "Patient-to-trial ranking: nDCG@10",
         "SIGIR 2016 + TREC CT 2021/2022 · 183 patients · TrialGPT 2.0 evaluator · whisker: TrialLink 95% CI",
         "nDCG@10 (macro over three cohorts)", 1.0, lambda v, row: f"{v:.3f}" if row["self"] else f"{v:.2f}", "fig1-ranking")
    nih = [{"label": "TrialLink (EviMed)" if r["system"] == "TrialLink" else (f"{r['system']} · {r['models']}" if r["system"].startswith("TrialGPT") else r["system"]),
            "value": r["scores"]["recall@10 macro"] * 100, "self": r["system"] == "TrialLink"}
           for r in boards["nih-trialbench"]["rows"]]
    bars(nih, "NIH-TrialBench: target trial in the top 10",
         "126 patient vignettes · 11 NIH institutes · recall@10 macro-averaged over institutes, as TrialGPT 2.0 reports it",
         "Recall@10 (%)", 100, lambda v, row: f"{v:.1f}%" if row["self"] else f"{v:.0f}%", "fig2-nih-trialbench")


if __name__ == "__main__":
    main()
