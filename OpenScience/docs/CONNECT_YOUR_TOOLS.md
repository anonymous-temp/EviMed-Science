# Connect your lab tools

EviMed is a workbench: it aggregates tools, it doesn't replace them. In the hosted product
the agent reaches tools through an **MCP server** (Model Context Protocol) that the platform
manages, and it follows **skills**. Skills are the part a researcher adds; the set of MCP
servers is fixed by the deployment, because a multi-tenant runtime must not take executable
tool code from a browser.

## Built-in science connectors

Seven science connectors are tools of the platform's `evimed` MCP server
(`runtime/mcp/evimed-research/science_connectors.py`). There is nothing to enable or
install: they are present in every project's runtime. They reach their sources through the
control plane's fixed-host public-source gateway, so the runtime container keeps an
internal-only network and any upstream credential stays with the control plane. Today:

- **Literature search** (all fields) — scholarly records from Crossref.
- **Biomedical records** (biology) — PubMed, ClinicalTrials.gov and ClinVar.
- **Materials Project** (materials) — material summaries by id or formula; needs the
  operator's Materials Project API key.
- **FRED economic data** (economics) — Federal Reserve time series by series id.
- **Space weather** (physics) — current NOAA SWPC alerts.
- **Weather & climate** (earth) — current and forecast weather from Open-Meteo.
- **USGS water data** (earth) — recent instantaneous water observations for a site.

Literature and database results carry real identifiers (DOI / PMID), so the
`traceability-review` skill can audit them afterward. The research server also carries the
platform's own retrieval, pharmacy-data, knowledge-base and specialist-engine tools; see
[`runtime/mcp/README.md`](../runtime/mcp/README.md).

## Other tools and MCP servers

A hosted runtime mounts one MCP server, `evimed`. A deployment may add one more, the
ToolUniverse sidecar, by setting `OPEN_SCIENCE_TOOLUNIVERSE_MCP_URL`. The hosted account
pages have no control for adding, enabling or removing an MCP server.

To make an internal ELN, LIMS, database gateway or instrument bridge reachable, add it as a
tool of the platform's MCP server (or as a deployment-level sidecar) and ship it with the
platform, after reviewing its license, network behavior, credentials and data flow; see
[Third-party components](./WEB_PRIVACY_AND_COMPLIANCE.md#third-party-components-and-licenses).
A tool that needs a credential gets it through a control-plane gateway, never in the runtime
container.

## Bring your own skill

A skill is a folder with a `SKILL.md` (instructions the agent follows) plus any
scripts/templates it needs. In the hosted product it is managed on the **插件与技能** page
(`/app/extensions`, tab **技能**):

- The platform's own skills are listed read-only; you can copy one into your own skills to
  edit it.
- Your own skills are created in the editor, or imported from a file, from a public
  repository at one exact 40-character commit, or from an earlier export of your account.
  Each saved state is kept, so an earlier one can be restored.
- A skill is used in a project only once you switch it on for that project. The control
  plane validates it in a disposable container and mounts it read-only into that project's
  runtime; a selected skill that cannot be mounted is left out and the conversation carries
  on.

Whatever scripts a skill carries run only inside the project's own runtime, never in the
control plane. The runtime image also ships first-party skills (e.g. `traceability-review`).

A skill body must carry paths **relative to the skill root** — the Agent Skills
standard — and never a deployment path. The absolute roots are a deployment fact
that differs per family and is declared once by the runtime; 45 shipped skills once
pointed at a config directory the image no longer had, and a wrong path in a
Markdown body fails at the moment a model tries to use it and nowhere else.

## Safety

- Every tool the platform adds can make its own network calls and run its own code, which is
  why none is installed from a browser and each is reviewed before it ships.
- A project's runtime can read and write only that project's workspace. In a hosted
  deployment the approval policy is `never`, which means auto-refuse: command execution,
  file deletion, dependency installs and remote connections that step outside the sandbox
  are refused, not asked about.
- Provider keys and connector credentials are held by the control plane's gateways. They
  never enter the runtime, the workspace, provenance, logs or exports.
