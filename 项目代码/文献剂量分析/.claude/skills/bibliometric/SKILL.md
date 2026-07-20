---
name: bibliometric
description: Run a complete AI-driven bibliometric analysis on a PubMed research topic
allowed-tools: Bash, Read, Glob, Write
argument-hint: "<topic> [--date-range YYYY-YYYY] [--max-records N] [--output-dir PATH]"
---

# Bibliometric Analysis Skill

You are running the AI-driven Bibliometric Analysis System. This tool performs a complete bibliometric analysis pipeline on a user-specified research topic from PubMed.

## What the pipeline does

1. **PubMed Search** - Searches NCBI E-utilities API for articles matching the topic
2. **Data Parsing** - Extracts metadata: authors, affiliations, keywords, MeSH terms, journals, publication types
3. **Data Cleaning** - Normalizes author names, institutions, countries; deduplicates records; merges keywords
4. **Descriptive Statistics** - Annual publication trends, top authors/institutions/journals/countries, keyword frequencies
5. **Bibliometric Laws** - Tests Lotka's Law, Bradford's Law, and Zipf's Law
6. **Citation Simulation** - Estimates citations based on journal impact tier, publication age, and article type
7. **Network Analysis** - Builds keyword/author/institution/country co-occurrence networks with Louvain community detection
8. **Burst Detection** - Kleinberg's automaton-based burst detection for identifying trending keywords
9. **Timeline Analysis** - Cluster activity evolution over time
10. **Frontier Identification** - Composite scoring to identify emerging research frontiers
11. **Insight Mining** - Detects 6 pattern types: dominance, migration, imbalance, maturity, emerging, paradox
12. **AI Narrative Generation** - LLM-enhanced report narratives (falls back to templates if no API key)
13. **Report Generation** - Publication-grade Markdown report with embedded figures
14. **VOSviewer Export** - Compatible map/network files for interactive visualization

## Output structure

```
output/<topic>/
├── data/          # Raw JSON, cleaned CSV, network JSON, co-occurrence matrices
├── figures/       # PNG charts (300 DPI): trends, networks, burst terms, timelines, wordclouds
├── tables/        # CSV tables: statistics, burst terms, frontiers, cluster summaries
├── vosviewer/     # VOSviewer-compatible map and network files
└── report.md      # Complete analysis report
```

## How to run

The project is located at `/Users/wangzeyuan/Desktop/文献计量分析`.

Parse the user's arguments from `$ARGUMENTS`. Expected format:
- First argument: research topic (required, in quotes if multi-word)
- `--date-range YYYY-YYYY` or `-d YYYY-YYYY`: optional date range filter
- `--max-records N` or `-n N`: maximum records to fetch (default: 2000)
- `--output-dir PATH` or `-o PATH`: custom output directory
- `--modules LIST` or `-m LIST`: comma-separated module list (default: all)
- `--verbose` or `-v`: enable debug logging

Execute:

```bash
cd /Users/wangzeyuan/Desktop/文献计量分析
source venv/bin/activate
PYTHONPATH=src python3 -m bibliometric analyze $ARGUMENTS
```

If venv doesn't exist, create it first:

```bash
cd /Users/wangzeyuan/Desktop/文献计量分析
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
PYTHONPATH=src python3 -m bibliometric analyze $ARGUMENTS
```

## After completion

1. Report the number of articles analyzed and total processing time
2. List the key output files generated
3. Show the report path so the user can open it
4. Offer to open or summarize the report.md content
5. If the user wants to explore results interactively, mention they can import VOSviewer files

## Examples

```
/bibliometric-analyze "semaglutide obesity" --date-range 2018-2025 --max-records 2000
/bibliometric-analyze "CAR-T lymphoma" -n 500
/bibliometric-analyze "sepsis AI diagnosis" -d 2020-2025 -n 1000
/bibliometric-analyze "CRISPR gene therapy" --modules trend,network,burst
```
