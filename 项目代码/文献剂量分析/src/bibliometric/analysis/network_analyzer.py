# [IN] co-occurrence matrices (DataFrames), output_dir
# [OUT] dict of network analysis results (graphs, centrality, clusters)
# [POS] src/bibliometric/analysis/network_analyzer.py - NetworkX graph analysis

from __future__ import annotations

import json
import logging
from pathlib import Path

import networkx as nx
import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

try:
    import community as community_louvain
    HAS_LOUVAIN = True
except ImportError:
    HAS_LOUVAIN = False
    logger.warning("python-louvain not installed, community detection disabled")


def analyze_networks(
    matrices: dict[str, pd.DataFrame], output_dir,
    max_nodes: dict[str, int] | None = None,
) -> dict[str, dict]:
    """Analyze all co-occurrence networks."""
    output_dir = Path(output_dir)
    results = {}

    default_max = {"keyword": 50, "author": 30, "institution": 20, "country": 10}
    if max_nodes:
        default_max.update(max_nodes)

    network_configs = {
        "keyword": ("keyword_cooccurrence", default_max["keyword"]),
        "author": ("author_collaboration", default_max["author"]),
        "institution": ("institution_collaboration", default_max["institution"]),
        "country": ("country_collaboration", default_max["country"]),
    }

    for net_name, (matrix_key, max_nodes) in network_configs.items():
        df = matrices.get(matrix_key)
        if df is None or df.empty:
            continue
        result = _analyze_single_network(df, max_nodes)
        results[net_name] = result
        _save_graph_json(result, net_name, output_dir / "data")

    return results


def _analyze_single_network(
    edge_df: pd.DataFrame, max_nodes: int
) -> dict:
    """Build and analyze a single network."""
    G = _build_graph(edge_df, max_nodes)
    if G.number_of_nodes() == 0:
        return {"graph": G, "centrality": {}, "clusters": {}}

    centrality = _compute_centrality(G)
    clusters = _detect_communities(G)
    components = _analyze_components(G)
    quality = _compute_cluster_quality(G, clusters)

    return {
        "graph": G,
        "centrality": centrality,
        "clusters": clusters,
        "components": components,
        "quality": quality,
        "node_count": G.number_of_nodes(),
        "edge_count": G.number_of_edges(),
    }


def _build_graph(edge_df: pd.DataFrame, max_nodes: int) -> nx.Graph:
    """Build NetworkX graph from edge DataFrame, filtered to top nodes."""
    node_weights = {}
    for _, row in edge_df.iterrows():
        src, tgt = row["source"], row["target"]
        node_weights[src] = max(
            node_weights.get(src, 0), row.get("source_freq", 1)
        )
        node_weights[tgt] = max(
            node_weights.get(tgt, 0), row.get("target_freq", 1)
        )

    top_nodes = set(
        sorted(node_weights, key=node_weights.get, reverse=True)[:max_nodes]
    )

    G = nx.Graph()
    for node in top_nodes:
        G.add_node(node, weight=node_weights.get(node, 1))

    for _, row in edge_df.iterrows():
        if row["source"] in top_nodes and row["target"] in top_nodes:
            G.add_edge(row["source"], row["target"], weight=row["weight"])

    isolated = list(nx.isolates(G))
    G.remove_nodes_from(isolated)
    return G


def _compute_centrality(G: nx.Graph) -> dict:
    """Compute multiple centrality measures."""
    degree = nx.degree_centrality(G)

    # betweenness: weight = distance, so invert co-occurrence weight
    inv_weight = "inv_weight"
    for u, v, d in G.edges(data=True):
        d[inv_weight] = 1.0 / max(d.get("weight", 1), 0.001)
    betweenness = nx.betweenness_centrality(G, weight=inv_weight)
    closeness = nx.closeness_centrality(G, distance=inv_weight)

    centrality = {}
    for node in G.nodes():
        centrality[node] = {
            "degree": round(degree.get(node, 0), 4),
            "betweenness": round(betweenness.get(node, 0), 4),
            "closeness": round(closeness.get(node, 0), 4),
            "weighted_degree": sum(
                d["weight"] for _, _, d in G.edges(node, data=True)
            ),
        }

    return centrality


def _detect_communities(G: nx.Graph) -> dict[int, list[str]]:
    """Detect communities using Louvain algorithm."""
    if not HAS_LOUVAIN or G.number_of_nodes() < 3:
        return {}

    partition = community_louvain.best_partition(G, weight="weight")

    clusters = {}
    for node, cluster_id in partition.items():
        clusters.setdefault(cluster_id, []).append(node)

    for node in G.nodes():
        G.nodes[node]["cluster"] = partition.get(node, -1)

    logger.info("Found %d communities", len(clusters))
    return clusters


def _analyze_components(G: nx.Graph) -> list[dict]:
    """Analyze connected components."""
    components = []
    for comp in sorted(nx.connected_components(G), key=len, reverse=True):
        components.append({
            "size": len(comp),
            "nodes": sorted(comp)[:10],
        })
    return components[:5]


def _compute_cluster_quality(
    G: nx.Graph, clusters: dict[int, list[str]]
) -> dict:
    """Compute modularity Q and mean silhouette S for clusters."""
    if not clusters or G.number_of_nodes() < 3:
        return {"modularity": 0.0, "silhouette": 0.0}

    partition_list = []
    for members in clusters.values():
        partition_list.append(set(members))

    modularity = nx.community.modularity(G, partition_list, weight="weight")

    silhouette = _compute_silhouette(G, clusters)

    return {
        "modularity": round(modularity, 4),
        "silhouette": round(silhouette, 4),
        "num_clusters": len(clusters),
    }


def _compute_silhouette(G: nx.Graph, clusters: dict) -> float:
    """Compute mean silhouette score for network clustering."""
    node_to_cluster = {}
    for cid, members in clusters.items():
        for m in members:
            node_to_cluster[m] = cid

    nodes = list(G.nodes())
    if len(nodes) < 3:
        return 0.0

    sil_scores = []
    for node in nodes:
        cid = node_to_cluster.get(node)
        if cid is None:
            continue
        same = [n for n in clusters.get(cid, []) if n != node]
        if not same:
            continue

        a_i = _mean_distance(G, node, same)

        b_i = float("inf")
        for other_cid, members in clusters.items():
            if other_cid == cid or not members:
                continue
            dist = _mean_distance(G, node, members)
            b_i = min(b_i, dist)

        if b_i == float("inf"):
            continue
        denom = max(a_i, b_i)
        if denom > 0:
            sil_scores.append((b_i - a_i) / denom)

    return float(np.mean(sil_scores)) if sil_scores else 0.0


def _mean_distance(G: nx.Graph, node: str, others: list[str]) -> float:
    """Mean distance (inverse weight) from node to a set of others."""
    dists = []
    for other in others:
        if G.has_edge(node, other):
            w = G[node][other].get("weight", 1)
            dists.append(1.0 / max(w, 0.001))
        else:
            dists.append(2.0)  # penalty for no direct edge
    return float(np.mean(dists)) if dists else 2.0


def _save_graph_json(result: dict, name: str, data_dir: Path):
    """Save graph data as JSON for downstream use."""
    data_dir.mkdir(parents=True, exist_ok=True)
    G = result.get("graph")
    if G is None:
        return

    graph_data = {
        "nodes": [
            {
                "id": n,
                "weight": G.nodes[n].get("weight", 1),
                "cluster": G.nodes[n].get("cluster", -1),
                **result.get("centrality", {}).get(n, {}),
            }
            for n in G.nodes()
        ],
        "edges": [
            {"source": u, "target": v, "weight": d.get("weight", 1)}
            for u, v, d in G.edges(data=True)
        ],
    }

    path = data_dir / f"{name}_network.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(graph_data, f, indent=2, ensure_ascii=False, default=_json_default)
    logger.info("Saved %s", path)


def _json_default(obj):
    """Handle numpy types in JSON serialization."""
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    return str(obj)
