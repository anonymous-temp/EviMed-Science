"""Draw the TrialLink report's figures from leaderboard.json: the architecture (fig0) and the leaderboard, one panel per benchmark with
TrialLink first and every published system beside it, plus a final panel of TrialLink against the best published system (fig1).

    python3 make_figures.py   # writes fig0-architecture and fig1-leaderboard (.svg and .png) beside this file
"""
import json
import textwrap
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap  # noqa: E402
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch, Patch, Rectangle  # noqa: E402

HERE = Path(__file__).resolve().parent
SURFACE, INK, INK_2, MUTED, GRID, AXIS = "#fcfcfb", "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7"
ACCENT, OTHER = "#2a78d6", "#898781"  # TrialLink in the accent, every comparator in one recessive tone
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "svg.fonttype": "none", "svg.hashsalt": "triallink"})


# Bar fills: a vertical gradient per kind, saturated at the top as in common model-card leaderboards.
FILLS = {
    "ours": ("#bcd2f3", "#2a64d6"),
    "published": ("#f1f0ec", "#a9a8a1"),
    "manual": ("#f4f3f0", "#c9c8c1"),
    "human": ("#f4f3f0", "#c9c8c1"),
    "baseline": ("#f7f7f5", "#d6d5cf"),
    "reference": ("#f7f7f5", "#d6d5cf"),
}


def gradient_bar(ax, x, width, value, kind):
    low, high = FILLS.get(kind, FILLS["published"])
    cmap = LinearSegmentedColormap.from_list(kind, [low, high])
    clip = Rectangle((x - width / 2, 0), width, value, transform=ax.transData, facecolor="none", edgecolor="none")
    ax.add_patch(clip)
    image = ax.imshow([[0], [1]], cmap=cmap, origin="lower", aspect="auto", extent=(x - width / 2, x + width / 2, 0, value), zorder=2, interpolation="bicubic")
    image.set_clip_path(clip)


def fmt_value(value, scale, ours=False):
    """TrialLink's own score at a fixed precision; a published score as its source gives it, shown to at most three decimals (the JSON
    keeps the exact value)."""
    if scale == 100:
        return f"{value:.1f}"
    if ours:
        return f"{value:.3f}"
    shown = Decimal(str(value)).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)
    text = f"{shown:f}".rstrip("0")
    return text if len(text.split(".")[1]) >= 2 else f"{value:.2f}"


def panel(ax, cap):
    rows = cap["rows"]
    ours = [r for r in rows if r["kind"] == "ours"]
    others = sorted([r for r in rows if r["kind"] != "ours"], key=lambda r: -(r["value"] or 0))
    rows = ours + others
    top = max(r["value"] or 0 for r in rows)
    ax.set_facecolor(SURFACE)
    ax.set_xlim(-0.6, len(rows) - 0.4)
    ax.set_ylim(0, top * 1.22)
    for i, r in enumerate(rows):
        if r["value"] is None:
            ax.text(i, top * 0.05, "pending", rotation=90, ha="center", va="bottom", color=INK_2, fontsize=8)
            continue
        gradient_bar(ax, i, 0.68, r["value"], r["kind"])
        ax.text(i, r["value"] + top * 0.025, fmt_value(r["value"], cap["scale"], r["kind"] == "ours"), ha="center", va="bottom", fontsize=8.6,
                color=INK, fontweight="bold" if r["kind"] == "ours" else "normal")
    ax.set_xticks(range(len(rows)))
    ax.set_xticklabels([textwrap.fill(r["label"], 16) for r in rows], rotation=55, ha="right", rotation_mode="anchor", fontsize=7.2)
    for label, r in zip(ax.get_xticklabels(), rows):
        label.set_color(INK if r["kind"] == "ours" else INK_2)
        label.set_fontweight("bold" if r["kind"] == "ours" else "normal")
    ax.tick_params(axis="x", length=0, pad=3)
    ax.tick_params(axis="y", colors=MUTED, labelsize=7.5, length=0)
    ax.yaxis.grid(True, color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(AXIS)
    ax.text(0, 1.04, cap["title"], transform=ax.transAxes, fontsize=11, fontweight="bold", color=INK, ha="left", va="bottom")


def relative_panel(ax, caps, final):
    rows = []
    for cap in caps:
        ours = next(r for r in cap["rows"] if r["kind"] == "ours")
        best = max((r["value"] for r in cap["rows"] if r["kind"] == "published" and r["value"] is not None), default=None)
        if ours["value"] is not None and best:
            rows.append({"label": cap["short"], "value": round(ours["value"] / best * 100, 1), "kind": "ours"})
    ax.set_facecolor(SURFACE)
    ax.set_xlim(-0.6, len(rows) - 0.4)
    ax.set_ylim(0, max(r["value"] for r in rows) * 1.18)
    for i, r in enumerate(rows):
        gradient_bar(ax, i, 0.68, r["value"], "ours" if r["value"] >= 100 else "published")
        ax.text(i, r["value"] + 2, f"{r['value']:.0f}", ha="center", va="bottom", fontsize=8.2, color=INK, fontweight="bold" if r["value"] >= 100 else "normal")
    ax.axhline(100, color=INK_2, linewidth=0.9, linestyle=(0, (4, 3)), zorder=3)
    ax.set_xticks(range(len(rows)))
    ax.set_xticklabels([textwrap.fill(r["label"], 16) for r in rows], rotation=55, ha="right", rotation_mode="anchor", fontsize=7.2, color=INK_2)
    ax.tick_params(axis="x", length=0, pad=3)
    ax.tick_params(axis="y", colors=MUTED, labelsize=7.5, length=0)
    ax.yaxis.grid(True, color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(AXIS)
    ax.text(0, 1.04, final["title"], transform=ax.transAxes, fontsize=11, fontweight="bold", color=INK, ha="left", va="bottom")
    return rows


def leaderboard(data, out):
    caps = [cap for cap in data["capabilities"] if cap.get("figure", True)]
    cols = 3 if len(caps) + 1 <= 9 else 4
    rows_n = -(-(len(caps) + 1) // cols)
    fig, axes = plt.subplots(rows_n, cols, figsize=(5.2 * cols, 4.7 * rows_n), facecolor=SURFACE)
    flat = axes.ravel()
    for ax, cap in zip(flat, caps):
        panel(ax, cap)
    relative_panel(flat[len(caps)], caps, data["final"])
    for ax in flat[len(caps) + 1:]:
        ax.axis("off")
    kinds = {r["kind"] for cap in caps for r in cap["rows"]}
    legend = [("ours", "TrialLink"), ("published", "Published system"), ("human", "Physicians"), ("reference", "Median or baseline")]
    handles = [Patch(facecolor=FILLS[kind][1], label=label) for kind, label in legend
               if kind in kinds or (kind == "reference" and "baseline" in kinds)]
    fig.legend(handles=handles, loc="lower center", ncol=4, frameon=False, fontsize=10.5, bbox_to_anchor=(0.5, 0.004))
    fig.tight_layout(rect=(0.01, 0.03, 0.99, 0.99), h_pad=4.2, w_pad=2.2)
    for suffix in ("svg", "png"):
        fig.savefig(HERE / f"{out}.{suffix}", dpi=150, facecolor=SURFACE, metadata={"Date": None} if suffix == "svg" else None)
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
        fig.savefig(HERE / f"{out}.{suffix}", dpi=200, facecolor=SURFACE, metadata={"Date": None} if suffix == "svg" else None)
    plt.close(fig)
RANKED = ("ours", "published")
HEADERS = {
    "en": ("Rank", "System", "Score", "Source", "this report", "not ranked: {kind}"),
    "zh": ("排名", "系统", "成绩", "来源", "本报告", "不参与排名：{kind}"),
}
KIND_WORDS = {"en": {"manual": "manual run", "human": "physician", "baseline": "baseline", "reference": "reference"},
              "zh": {"manual": "人工提交", "human": "医生", "baseline": "基线", "reference": "参考线"}}


def table(cap, lang):
    """One capability's rows, best first; TrialLink and published systems are ranked, the rest are listed beside them unranked."""
    rank_h, system_h, score_h, source_h, own, unranked = HEADERS[lang]
    rows = sorted(cap["rows"], key=lambda r: -(r["value"] if r["value"] is not None else -1))
    lines = [f"| {rank_h} | {system_h} | {cap['metric']} | {source_h} |", "|---|---|---|---|"]
    ranked = [r["value"] for r in rows if r["kind"] in RANKED and r["value"] is not None]
    for r in rows:
        # Equal scores share a rank (1 + how many ranked systems score strictly higher), as Arena-style boards do.
        place = str(1 + sum(v > r["value"] for v in ranked)) if r["kind"] in RANKED and r["value"] is not None else "–"
        value = "pending" if r["value"] is None else fmt_value(r["value"], cap["scale"], r["kind"] == "ours")
        if r["kind"] == "ours" and r.get("ci95") and r["value"] is not None:
            lo, hi = r["ci95"]
            value += f" ({fmt_value(lo, cap['scale'], True)}–{fmt_value(hi, cap['scale'], True)})"
        name = f"**{r['label']}**" if r["kind"] == "ours" else r["label"]
        if r["kind"] not in RANKED:
            name += f" ({KIND_WORDS[lang][r['kind']]})"
        lines.append(f"| {place} | {name} | {'**' + value + '**' if r['kind'] == 'ours' else value} | {own if r['kind'] == 'ours' else r['source']} |")
    return "\n".join(lines)


def write_tables(data):
    """Replace the generated block in each README with tables rendered from leaderboard.json."""
    for name, lang in (("README.md", "en"), ("README.zh-CN.md", "zh")):
        path = HERE / name
        text = path.read_text()
        start, end = "<!-- tables:start -->", "<!-- tables:end -->"
        if start not in text:
            continue
        blocks = []
        for cap in data["capabilities"]:
            title = cap.get("title_zh", cap["title"]) if lang == "zh" else cap["title"]
            subtitle = cap.get("subtitle_zh", cap["subtitle"]) if lang == "zh" else cap["subtitle"]
            note = cap.get("note_zh" if lang == "zh" else "note")
            blocks.append(f"#### {title}\n\n{subtitle}\n\n{table(cap, lang)}" + (f"\n\n{note}" if note else ""))
        head, rest = text.split(start, 1)
        _, tail = rest.split(end, 1)
        path.write_text(f"{head}{start}\n\n" + "\n\n".join(blocks) + f"\n\n{end}{tail}")


def main():
    data = json.loads((HERE / "leaderboard.json").read_text())
    architecture("fig0-architecture")
    leaderboard(data, "fig1-leaderboard")
    write_tables(data)


if __name__ == "__main__":
    main()
