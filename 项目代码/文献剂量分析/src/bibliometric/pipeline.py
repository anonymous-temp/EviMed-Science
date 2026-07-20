# [IN] Config, query params
# [OUT] complete analysis results in output directory
# [POS] src/bibliometric/pipeline.py - orchestrates the full analysis pipeline

from __future__ import annotations

import json
import logging
import time

import pandas as pd
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn

from bibliometric.config import Config

logger = logging.getLogger(__name__)
console = Console()


def _search_with_fallback(connector, formal_query, user_query, date_from, date_to, max_records):
    pmids = connector.search(formal_query, date_from, date_to, max_records)
    if pmids or formal_query.strip() == user_query.strip():
        return pmids, None
    logger.warning("Formal PubMed strategy returned zero records; retrying the original topic.")
    return connector.search(user_query, date_from, date_to, max_records), user_query


class AnalysisPipeline:
    """Orchestrates the full bibliometric analysis pipeline."""

    def __init__(self, config: Config, query: str, date_from: str = "",
                 date_to: str = "", max_records: int = 0,
                 modules: str = "all", lang: str = "en"):
        self.config = config
        self.query = query
        self.date_from = date_from
        self.date_to = date_to
        self.max_records = max_records or config.max_records
        self.modules = self._parse_modules(modules)
        self.output_dir = config.output_dir
        self.lang = lang
        self.articles = []
        self.stats = {}
        self.networks = {}

    def _parse_modules(self, modules: str) -> set[str]:
        """Parse module selection string."""
        if modules == "all":
            return {"trend", "network", "burst", "timeline",
                    "frontier", "insight", "report", "citation"}
        return set(modules.split(","))

    def run(self):
        """Execute the full pipeline."""
        self._setup_dirs()
        start = time.time()

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            self._step_search(progress)
            if not self.articles:
                console.print("[bold red]No articles found. Aborting.[/]")
                return
            self._step_clean(progress)
            if not self.articles:
                console.print("[bold red]No articles after cleaning. Aborting.[/]")
                return
            self._step_statistics(progress)
            self._step_bib_laws(progress)
            if self._need("citation"):
                self._step_citations(progress)
            self._step_charts(progress)

            # Auto-enable dependencies: timeline/frontier need network+burst
            if self._need("timeline") or self._need("frontier"):
                self.modules.add("network")
                self.modules.add("burst")

            if self._need("network"):
                self._step_network(progress)
                self._step_network_charts(progress)
                self._step_vosviewer(progress)

            if self._need("burst"):
                self._step_burst(progress)

            if self._need("timeline") or self._need("frontier"):
                self._step_timeline(progress)

            if self._need("frontier"):
                self._step_frontier(progress)

            if self._need("insight"):
                self._step_insight(progress)

            if self._need("report"):
                self._step_ai_narratives(progress)
                self._step_report(progress)

        elapsed = time.time() - start
        console.print(
            f"\n[bold green]Analysis complete![/] "
            f"({elapsed:.1f}s, {len(self.articles)} articles)"
        )
        console.print(f"Output: {self.output_dir}")

    def _need(self, module: str) -> bool:
        return module in self.modules

    def _setup_dirs(self):
        for sub in ["data", "figures", "tables", "vosviewer"]:
            (self.output_dir / sub).mkdir(parents=True, exist_ok=True)

    def _ensure_data_dir(self):
        """Ensure the data subdirectory exists before writing files."""
        (self.output_dir / "data").mkdir(parents=True, exist_ok=True)

    def _step_search(self, progress):
        task = progress.add_task("Searching PubMed...", total=None)

        # Build formal search strategy with MeSH terms
        from bibliometric.pubmed.search_strategy import build_search_strategy
        self.search_strategy = build_search_strategy(
            self.query,
            date_from=self.date_from,
            date_to=self.date_to,
            api_key=self.config.ncbi_api_key or "",
            email=self.config.ncbi_email or "",
        )
        formal_query = self.search_strategy["formal_query"]
        console.print(f"  Search strategy: [dim]{formal_query[:120]}...[/]")

        from bibliometric.pubmed.connector import PubMedConnector
        connector = PubMedConnector(self.config)
        pmids, fallback_query = _search_with_fallback(
            connector, formal_query, self.query,
            self.date_from, self.date_to, self.max_records,
        )
        if fallback_query:
            self.search_strategy["fallback_query"] = fallback_query
            self.search_strategy["fallback_reason"] = "formal_query_zero_results"
        xml_chunks = connector.fetch_details(pmids)
        progress.update(task, completed=True)

        from bibliometric.pubmed.parser import parse_articles
        self.articles = parse_articles(xml_chunks)
        self._save_metadata(len(pmids))
        self._save_raw(self.articles)
        console.print(f"  Retrieved [bold]{len(self.articles)}[/] articles")

    def _step_clean(self, progress):
        task = progress.add_task("Cleaning data...", total=None)
        from bibliometric.cleaning.normalizer import normalize_articles
        from bibliometric.cleaning.dedup import deduplicate

        self.articles = normalize_articles(self.articles)
        self.articles = deduplicate(self.articles)

        # Attempt ROR-based institution resolution (network-optional)
        try:
            from bibliometric.cleaning.ror_lookup import resolve_institutions, apply_ror_mapping
            if self.config.ror_top_n > 0:
                ror_map = resolve_institutions(self.articles, top_n=self.config.ror_top_n)
                apply_ror_mapping(self.articles, ror_map)
        except Exception as exc:
            logger.debug("ROR lookup skipped: %s", exc)

        progress.update(task, completed=True)
        self._save_cleaned()
        self._update_metadata_after_dedup()
        console.print(f"  After cleaning: [bold]{len(self.articles)}[/] articles")

    def _step_statistics(self, progress):
        task = progress.add_task("Computing statistics...", total=None)
        from bibliometric.analysis.statistics import compute_statistics, save_statistics

        self.stats = compute_statistics(self.articles, date_to=self.date_to)
        save_statistics(self.stats, self.output_dir)
        progress.update(task, completed=True)

    def _step_bib_laws(self, progress):
        task = progress.add_task("Testing bibliometric laws...", total=None)
        from bibliometric.analysis.bib_laws import test_bibliometric_laws

        self.stats["bib_laws"] = test_bibliometric_laws(
            self.articles, self.stats
        )
        progress.update(task, completed=True)

    def _step_charts(self, progress):
        task = progress.add_task("Generating charts...", total=None)
        from bibliometric.visualization.trend_charts import generate_trend_charts

        generate_trend_charts(self.stats, str(self.output_dir),
                              lang=getattr(self, "_report_lang", self.lang))
        progress.update(task, completed=True)

    def _step_network(self, progress):
        task = progress.add_task("Building networks...", total=None)
        from bibliometric.analysis.matrix_builder import build_matrices, save_matrices
        from bibliometric.analysis.network_analyzer import analyze_networks

        matrices = build_matrices(self.articles)
        save_matrices(matrices, self.output_dir)
        self.networks = analyze_networks(
            matrices, self.output_dir,
            max_nodes={
                "keyword": self.config.network_max_nodes_keyword,
                "author": self.config.network_max_nodes_author,
                "institution": self.config.network_max_nodes_institution,
                "country": self.config.network_max_nodes_country,
            },
        )
        progress.update(task, completed=True)

    def _step_network_charts(self, progress):
        task = progress.add_task("Visualizing networks...", total=None)
        from bibliometric.visualization.network_charts import generate_network_charts

        generate_network_charts(self.networks, str(self.output_dir),
                                lang=getattr(self, "_report_lang", self.lang))
        progress.update(task, completed=True)

    def _step_vosviewer(self, progress):
        task = progress.add_task("Exporting VOSviewer files...", total=None)
        from bibliometric.export.vosviewer import export_vosviewer

        export_vosviewer(self.networks, str(self.output_dir))
        progress.update(task, completed=True)

    def _step_burst(self, progress):
        task = progress.add_task("Detecting bursts...", total=None)
        from bibliometric.analysis.burst_detector import detect_bursts

        self.stats["bursts"] = detect_bursts(
            self.articles, str(self.output_dir),
            lang=getattr(self, "_report_lang", self.lang),
        )
        progress.update(task, completed=True)

    def _step_timeline(self, progress):
        task = progress.add_task("Building timeline...", total=None)
        from bibliometric.analysis.cluster_labeler import label_clusters
        from bibliometric.analysis.timeline_engine import build_timeline

        kw_net = self.networks.get("keyword", {})
        clusters = kw_net.get("clusters", {})
        self.stats["cluster_labels"] = label_clusters(
            clusters, self.articles
        )
        self.stats["timeline"] = build_timeline(
            clusters, self.articles, self.stats.get("cluster_labels", {}),
            str(self.output_dir),
            lang=getattr(self, "_report_lang", self.lang),
        )
        progress.update(task, completed=True)

    def _step_frontier(self, progress):
        task = progress.add_task("Identifying frontiers...", total=None)
        from bibliometric.analysis.frontier_detector import detect_frontiers

        self.stats["frontiers"] = detect_frontiers(
            self.articles,
            self.stats.get("bursts", {}),
            self.stats.get("cluster_labels", {}),
            self.networks.get("keyword", {}),
            str(self.output_dir),
            query=self.query,
            lang=getattr(self, "_report_lang", self.lang),
        )
        progress.update(task, completed=True)

    def _step_insight(self, progress):
        task = progress.add_task("Mining insights...", total=None)
        from bibliometric.insight.miner import mine_insights

        self.stats["insights"] = mine_insights(
            self.articles, self.stats, self.networks
        )
        progress.update(task, completed=True)

    def _step_citations(self, progress):
        task = progress.add_task("Fetching citations...", total=None)
        from bibliometric.analysis.citation_simulator import (
            fetch_real_citations,
            compute_citation_statistics,
        )

        self.articles, real_count, sim_count = fetch_real_citations(self.articles)
        self.stats["citation_stats"] = compute_citation_statistics(self.articles)
        self.stats["citation_real_count"] = real_count
        self.stats["citation_sim_count"] = sim_count
        progress.update(task, completed=True)

    def _step_ai_narratives(self, progress):
        task = progress.add_task("Generating AI narratives...", total=None)
        from bibliometric.insight.ai_narrator import generate_ai_narratives

        self.stats["ai_narratives"] = generate_ai_narratives(
            self.query, self.articles, self.stats, self.networks,
            config=self.config, lang=getattr(self, "_report_lang", self.lang),
        )
        progress.update(task, completed=True)

    def _step_report(self, progress):
        task = progress.add_task("Generating report...", total=None)
        from bibliometric.report.generator import generate_report

        _lang = getattr(self, "_report_lang", self.lang)
        generate_report(
            query=self.query,
            date_from=self.date_from,
            date_to=self.date_to,
            articles=self.articles,
            stats=self.stats,
            networks=self.networks,
            output_dir=str(self.output_dir),
            lang=_lang,
        )
        progress.update(task, completed=True)
        console.print(f"  Report: {self.output_dir / 'report.md'}")

    def _save_metadata(self, total_found: int):
        self._ensure_data_dir()
        meta = {
            "query": self.query,
            "date_from": self.date_from,
            "date_to": self.date_to,
            "max_records": self.max_records,
            "total_found": total_found,
            "total_fetched": len(self.articles),
            "search_strategy": getattr(self, "search_strategy", {}),
        }
        path = self.output_dir / "data" / "search_metadata.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2, ensure_ascii=False)

    def _update_metadata_after_dedup(self):
        """Update search metadata with post-dedup article count."""
        self._ensure_data_dir()
        path = self.output_dir / "data" / "search_metadata.json"
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
            meta["after_dedup"] = len(self.articles)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(meta, f, indent=2, ensure_ascii=False)
        except Exception:
            pass

    def _save_raw(self, articles: list[dict]):
        self._ensure_data_dir()
        path = self.output_dir / "data" / "raw_records.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(articles, f, indent=2, ensure_ascii=False, default=str)

    def _save_cleaned(self):
        self._ensure_data_dir()
        rows = []
        for a in self.articles:
            rows.append({
                "pmid": a.get("pmid", ""),
                "title": a.get("title", ""),
                "year": a.get("year", ""),
                "journal": a.get("journal", {}).get("title", ""),
                "authors": "; ".join(a.get("authors_normalized", [])),
                "institutions": "; ".join(a.get("institutions", [])),
                "countries": "; ".join(a.get("countries", [])),
                "keywords": "; ".join(a.get("keywords_merged", [])),
                "doi": a.get("doi", ""),
            })
        df = pd.DataFrame(rows)
        df.to_csv(self.output_dir / "data" / "cleaned_records.csv", index=False)
