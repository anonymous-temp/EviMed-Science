# [IN] network analysis results (graph, centrality, clusters)
# [OUT] PNG network visualization files
# [POS] src/bibliometric/visualization/network_charts.py - network visualization

from __future__ import annotations

import logging
import os as _os
import subprocess as _sp
import threading
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.font_manager as _fm
import matplotlib.pyplot as plt
import networkx as nx

logger = logging.getLogger(__name__)

# matplotlib 全局线程锁
_MATPLOTLIB_LOCK = threading.Lock()

# ── 3-layer CJK font detection ──
_CN_FONT_CANDIDATES = [
    "Microsoft YaHei", "SimHei", "SimSun",
    "WenQuanYi Micro Hei", "WenQuanYi Zen Hei",
    "Noto Sans CJK SC", "Noto Sans SC",
    "Source Han Sans SC", "Source Han Sans CN",
    "PingFang SC", "Heiti SC", "STHeiti",
    "Droid Sans Fallback", "Arial Unicode MS",
]
_available_fonts = {f.name for f in _fm.fontManager.ttflist}
_cn_font = next((f for f in _CN_FONT_CANDIDATES if f in _available_fonts), None)

if _cn_font:
    plt.rcParams["font.sans-serif"] = [_cn_font, "DejaVu Sans"]
    logger.info("matplotlib CJK font (cache): %s", _cn_font)
else:
    _cjk_path = None
    try:
        _out = _sp.check_output(
            ["fc-list", ":lang=zh", "--format=%{file}\n"],
            stderr=_sp.DEVNULL, timeout=5,
        ).decode("utf-8", errors="ignore")
        for _raw in _out.splitlines():
            _p = _raw.strip().split(":")[0].strip()
            if _p and _os.path.exists(_p):
                _cjk_path = _p
                break
    except Exception:
        pass
    if _cjk_path is None:
        for _p in [
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/opentype/wqy/wqy-microhei.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        ]:
            if _os.path.exists(_p):
                _cjk_path = _p
                break
    if _cjk_path:
        _fm.fontManager.addfont(_cjk_path)
        _prop = _fm.FontProperties(fname=_cjk_path)
        plt.rcParams["font.sans-serif"] = [_prop.get_name(), "DejaVu Sans"]
        logger.info("matplotlib CJK font (fc-list/path): %s", _cjk_path)
    else:
        _cjk_paths = [
            p for p in
            _fm.findSystemFonts(fontext="ttf") + _fm.findSystemFonts(fontext="otf")
            if any(k in p.lower() for k in
                   ["cjk", "chinese", "noto", "wqy", "simsun", "simhei", "yahei"])
        ]
        if _cjk_paths:
            _fm.fontManager.addfont(_cjk_paths[0])
            _prop = _fm.FontProperties(fname=_cjk_paths[0])
            plt.rcParams["font.sans-serif"] = [_prop.get_name(), "DejaVu Sans"]
            logger.info("matplotlib CJK font (scan): %s", _cjk_paths[0])
        else:
            plt.rcParams["font.sans-serif"] = ["DejaVu Sans"]
            logger.warning("No CJK font found; Chinese characters may render as boxes.")

plt.rcParams["axes.unicode_minus"] = False

_TITLE_MAP_ZH = {
    "keyword": "关键词共现网络",
    "author": "作者合作网络",
    "institution": "机构合作网络",
    "country": "国家/地区合作网络",
}
_TITLE_MAP_EN = {
    "keyword": "Keyword Co-occurrence Network",
    "author": "Author Collaboration Network",
    "institution": "Institution Collaboration Network",
    "country": "Country Collaboration Network",
}
_INFO_TMPL = {
    "zh": "节点: {nodes}  边: {edges}  聚类: {clusters}",
    "en": "Nodes: {nodes}  Edges: {edges}  Clusters: {clusters}",
}

CLUSTER_COLORS = [
    "#E91E63", "#2196F3", "#4CAF50", "#FF9800", "#9C27B0",
    "#00BCD4", "#FF5722", "#795548", "#607D8B", "#3F51B5",
    "#8BC34A", "#FFC107", "#673AB7", "#009688", "#F44336",
]


def generate_network_charts(
    networks: dict[str, dict], output_dir: str, lang: str = "en"
) -> list[str]:
    """Generate network visualization charts."""
    fig_dir = Path(output_dir) / "figures"
    fig_dir.mkdir(parents=True, exist_ok=True)

    saved = []
    with _MATPLOTLIB_LOCK:
        for net_name, net_data in networks.items():
            G = net_data.get("graph")
            if G is None or G.number_of_nodes() < 2:
                continue
            path = fig_dir / f"{net_name}_network.png"
            _draw_network(G, net_data, str(path), net_name, lang)
            saved.append(str(path))
    return saved


def _draw_network(
    G: nx.Graph, net_data: dict, filepath: str, title: str, lang: str = "en"
):
    """Draw a network graph with clusters and centrality-based sizing."""
    fig, ax = plt.subplots(figsize=(14, 10))

    pos = nx.spring_layout(G, k=1.5, iterations=50, weight="weight", seed=42)

    node_sizes = _compute_node_sizes(G)
    node_colors = _compute_node_colors(G)
    edge_widths = _compute_edge_widths(G)
    edge_alphas = _compute_edge_alphas(G)

    nx.draw_networkx_edges(
        G, pos, ax=ax,
        width=edge_widths,
        alpha=edge_alphas,
        edge_color="#999999",
    )

    nx.draw_networkx_nodes(
        G, pos, ax=ax,
        node_size=node_sizes,
        node_color=node_colors,
        alpha=0.85,
        edgecolors="white",
        linewidths=0.5,
    )

    labels = _select_labels(G, pos, max_labels=25)
    nx.draw_networkx_labels(
        G, pos, labels=labels, ax=ax,
        font_size=8,
        font_weight="bold",
    )

    ax.axis("off")

    clusters = len(set(nx.get_node_attributes(G, "cluster").values()))
    info = _INFO_TMPL[lang if lang in _INFO_TMPL else "en"].format(
        nodes=G.number_of_nodes(),
        edges=G.number_of_edges(),
        clusters=clusters,
    )
    ax.text(
        0.5, -0.02, info,
        transform=ax.transAxes, ha="center", fontsize=9, color="#666",
    )

    plt.tight_layout()
    fig.savefig(filepath, dpi=96, bbox_inches="tight", facecolor="white", edgecolor="none")
    plt.close(fig)
    logger.info("Saved %s", filepath)


def _compute_node_sizes(G: nx.Graph) -> list[float]:
    """Node sizes proportional to weighted degree."""
    degrees = dict(G.degree(weight="weight"))
    if not degrees:
        return [100]
    max_d = max(degrees.values())
    min_d = min(degrees.values())
    spread = max_d - min_d if max_d > min_d else 1
    return [
        100 + 800 * ((degrees[n] - min_d) / spread)
        for n in G.nodes()
    ]


def _compute_node_colors(G: nx.Graph) -> list[str]:
    """Node colors based on cluster assignment."""
    colors = []
    for n in G.nodes():
        cluster = G.nodes[n].get("cluster", 0)
        colors.append(CLUSTER_COLORS[cluster % len(CLUSTER_COLORS)])
    return colors


def _compute_edge_widths(G: nx.Graph) -> list[float]:
    """Edge widths proportional to weight."""
    weights = [d.get("weight", 1) for _, _, d in G.edges(data=True)]
    if not weights:
        return [0.5]
    max_w = max(weights)
    min_w = min(weights)
    spread = max_w - min_w if max_w > min_w else 1
    return [0.3 + 3.0 * ((w - min_w) / spread) for w in weights]


def _compute_edge_alphas(G: nx.Graph) -> list[float]:
    """Edge alpha proportional to weight."""
    weights = [d.get("weight", 1) for _, _, d in G.edges(data=True)]
    if not weights:
        return [0.3]
    max_w = max(weights)
    return [0.15 + 0.5 * (w / max_w) for w in weights]


def _select_labels(
    G: nx.Graph, pos: dict, max_labels: int = 25
) -> dict[str, str]:
    """Select top nodes by degree for labeling to avoid clutter."""
    degree_sorted = sorted(
        G.degree(weight="weight"), key=lambda x: x[1], reverse=True
    )
    top_nodes = [n for n, _ in degree_sorted[:max_labels]]
    return {n: n for n in top_nodes}
