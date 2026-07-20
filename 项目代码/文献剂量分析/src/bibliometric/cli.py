# [IN] CLI arguments from user
# [OUT] triggers pipeline execution
# [POS] src/bibliometric/cli.py - CLI entry point (click framework)

from __future__ import annotations

import logging
import sys
from pathlib import Path

import click
from rich.console import Console
from rich.logging import RichHandler

from bibliometric.config import load_config
from bibliometric.pipeline import AnalysisPipeline

console = Console()


def _setup_logging(verbose: bool):
    """Configure logging with rich handler."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(message)s",
        handlers=[RichHandler(console=console, show_time=False, show_path=False)],
    )


@click.group()
@click.version_option(version="0.1.0")
def main():
    """Bibliometric Analysis CLI - AI-driven literature analysis from PubMed."""
    pass


@main.command()
@click.argument("topic")
@click.option("--date-range", "-d", default="",
              help="Date range as YYYY-YYYY (e.g. 2018-2025)")
@click.option("--max-records", "-n", type=int, default=2000,
              help="Maximum number of records to fetch")
@click.option("--output-dir", "-o", default="",
              help="Output directory path")
@click.option("--api-key", default="", help="NCBI API key (overrides .env)")
@click.option("--email", default="", help="NCBI email (overrides .env)")
@click.option("--modules", "-m", default="all",
              help="Comma-separated modules: trend,network,burst,timeline,"
                   "frontier,insight,report (default: all)")
@click.option("--verbose", "-v", is_flag=True, help="Enable debug logging")
def analyze(topic, date_range, max_records, output_dir, api_key,
            email, modules, verbose):
    """Analyze a research topic from PubMed literature."""
    _setup_logging(verbose)

    date_from, date_to = _parse_date_range(date_range)

    config = load_config(
        api_key=api_key,
        email=email,
        output_dir=output_dir,
    )

    if not output_dir and str(config.output_dir) == "./output":
        safe_name = topic.replace(" ", "_")[:50]
        config.output_dir = Path("./output") / safe_name

    console.print(f"\n[bold blue]Bibliometric Analysis[/]")
    console.print(f"  Topic: [bold]{topic}[/]")
    console.print(f"  Date range: {date_from or 'any'} — {date_to or 'any'}")
    console.print(f"  Max records: {max_records}")
    console.print(f"  Output: {config.output_dir}\n")

    pipeline = AnalysisPipeline(
        config=config,
        query=topic,
        date_from=date_from,
        date_to=date_to,
        max_records=max_records,
        modules=modules,
    )

    try:
        pipeline.run()
    except Exception as e:
        console.print(f"\n[bold red]Error:[/] {e}")
        logging.debug("Full traceback:", exc_info=True)
        sys.exit(1)


def _parse_date_range(date_range: str) -> tuple[str, str]:
    """Parse 'YYYY-YYYY' into (from, to) strings."""
    if not date_range:
        return "", ""
    parts = date_range.split("-")
    if len(parts) == 2:
        return parts[0].strip(), parts[1].strip()
    return date_range.strip(), ""


if __name__ == "__main__":
    main()
