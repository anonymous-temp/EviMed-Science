# [IN] network analysis results (graph, centrality, clusters)
# [OUT] VOSviewer-compatible map and network text files
# [POS] src/bibliometric/export/vosviewer.py - VOSviewer format export

from __future__ import annotations

import logging
from pathlib import Path

import networkx as nx

logger = logging.getLogger(__name__)


def export_vosviewer(
    networks: dict[str, dict], output_dir: str
) -> list[str]:
    """Export all networks to VOSviewer-compatible format."""
    vos_dir = Path(output_dir) / "vosviewer"
    vos_dir.mkdir(parents=True, exist_ok=True)

    saved = []
    for net_name, net_data in networks.items():
        G = net_data.get("graph")
        if G is None or G.number_of_nodes() < 2:
            continue
        centrality = net_data.get("centrality", {})
        map_path = _write_map_file(G, centrality, net_name, vos_dir)
        net_path = _write_network_file(G, net_name, vos_dir)
        saved.extend([map_path, net_path])
    return saved


def _write_map_file(
    G: nx.Graph, centrality: dict, name: str, vos_dir: Path
) -> str:
    """Write VOSviewer map file (tab-separated)."""
    pos = nx.spring_layout(G, k=1.5, iterations=50, seed=42)

    path = vos_dir / f"{name}_map.txt"
    with open(path, "w", encoding="utf-8") as f:
        f.write("id\tlabel\tx\ty\tcluster\tweight<Occurrences>\t"
                "weight<Total link strength>\n")

        for i, node in enumerate(G.nodes()):
            x = pos[node][0]
            y = pos[node][1]
            cluster = max(G.nodes[node].get("cluster", 0) + 1, 1)
            weight = G.nodes[node].get("weight", 1)
            link_strength = centrality.get(node, {}).get("weighted_degree", 0)
            label = str(node).replace("\t", " ")
            f.write(
                f"{i + 1}\t{label}\t{x:.6f}\t{y:.6f}\t"
                f"{cluster}\t{weight}\t{link_strength}\n"
            )

    logger.info("Saved %s", path)
    return str(path)


def _write_network_file(G: nx.Graph, name: str, vos_dir: Path) -> str:
    """Write VOSviewer network file (tab-separated edge list)."""
    node_ids = {node: i + 1 for i, node in enumerate(G.nodes())}

    path = vos_dir / f"{name}_network.txt"
    with open(path, "w", encoding="utf-8") as f:
        for u, v, data in G.edges(data=True):
            id1 = node_ids[u]
            id2 = node_ids[v]
            weight = data.get("weight", 1)
            f.write(f"{id1}\t{id2}\t{weight}\n")

    logger.info("Saved %s", path)
    return str(path)
