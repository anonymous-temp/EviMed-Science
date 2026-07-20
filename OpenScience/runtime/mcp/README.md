# runtime/mcp

MCP (Model Context Protocol) server configurations.

## Bundled runtime servers

| MCP | Purpose | Phase |
| --- | --- | --- |
| `filesystem` | Project file read/write | v0.1 |
| `evimed-research` | EviMed evidence, specialist agents, and public biomedical sources | enabled |
| `science-paper-search` | Crossref scholarly search | enabled |
| `science-biomcp` | PubMed, ClinicalTrials.gov, and ClinVar search | enabled |
| `science-materials-project` | Materials Project summary data | enabled; server-held API key required |
| `science-fred` | Public FRED time series | enabled |
| `science-spaceweather` | NOAA SWPC alerts | enabled |
| `science-open-meteo` | Open-Meteo weather and climate data | enabled |
| `science-usgs-water` | USGS instantaneous water observations | enabled |
| `Zotero MCP` | Reference library | later |
| `GitHub MCP` | Repos / issues / releases | later |
| `local runtime MCP` | Local execution status | later |

Hosted runtimes register all seven science connectors as independent local MCP
processes. Their HTTP requests traverse the authenticated server-side public
source gateway and its fixed official-host allowlist, so runtime containers keep
their default internal-only network. Materials Project credentials are mounted
only into the Web gateway and are never written to OpenCode config.

Desktop users may still install alternative upstream connector packages from
Settings. MCP servers remain pluggable and operator-configurable.
