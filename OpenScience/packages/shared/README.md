# packages/shared

`@ai4s/shared`: TypeScript types and a small chart-palette module for the web app. It is a
private workspace package with no build step; `src/index.ts` is its only entry, and
`apps/web` resolves it to the source through its `tsconfig.json` and Vite aliases. No other
workspace package imports it today.

What `src/index.ts` exports:

- **Conversation types**: `Project`, `Session`, `SessionGroup`, and the `ThreadBlock` union
  (user and agent messages, step summaries, tool calls with their `ToolCallStatus`, reviewer
  findings, tables, figures, artifacts, running jobs, status lines).
- **Inspector types**: `Inspector` (artifact, PDF or file preview), `FileRoot`,
  `ArtifactInspector`, `FilePreviewInspector`, `PdfInspector` and their parts.
- **Provenance and citation types**: `ProvenanceRecord` (one line of a project's
  `.openscience/provenance.jsonl`), `ProvenanceEnv`, `HardwareInfo`, `RunRecord`,
  `RunArtifact`, `PackageSnapshot`, `Citation`.
- **Chart palette**: `CHART_PALETTE_LIGHT`, `CHART_PALETTE_DARK`, `chartPalette(theme)` and
  `seriesColor(i, theme)`. The hues are written out as literals so the package has no
  dependencies; `apps/web/src/lib/chartPalette.test.ts` asserts they equal the series in
  `@evimed/design-tokens`, so drift is a failing test.

The shared vocabulary of the platform (tool names, contract kinds, the workspace layout,
state vocabularies, error codes and the delivery-gate rules) is `@evimed/domain`, not this
package. Nothing here does I/O or renders UI; it is types and pure helpers only. The package
has no tests of its own; `pnpm typecheck` checks it through `apps/web`.
