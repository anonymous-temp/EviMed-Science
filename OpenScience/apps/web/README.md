# apps/web

The React + TypeScript + Vite frontend — the EviMed Science workbench.

It is served by `apps/server` as a single-page app. There is no desktop
packaging: the Tauri shell, its Rust command layer and the browser-side kernel
client (`packages/sdk`) were deleted on 2026-09-04, so this is the whole client.

## Layout

- `src/app/` — `router.tsx` (every route under `/app`, plus the pre-prefix
  redirects), `layout/AppShell.tsx` (auth gate, sidebar, palette),
  `routes/` (one file per page), `providers/`.
- `src/components/` — `sidebar/` (nav, project switcher), `run/` (the run
  ledger's cards and the side panel beside the conversation), `thread/`,
  `notebook/`, `inspector/` (scientific file previews), `settings/` (the cards
  the settings and account pages compose), `cards/`, `command-palette/`,
  `code-viewer/`, `markdown-viewer/`, `ui/` (the primitives).
- `src/lib/` — `apiClient.ts` (the only place an HTTP call to the control plane
  is made), `projects.ts` (which project the shell is looking at), `backend.ts`
  (the command endpoint), `runStream.ts` + `useRunStream.ts` (the run event
  stream), `store.ts` (UI preferences), plus the scientific file parsers.

## The session surface

`/app/chat` frames the kernel's own browser application, served on its own
origin (`/api/me` names it as `runtime.uiOrigin`). A deployment that does not
serve it — or a browser that cannot reach that origin — renders this app's own
run-stream view instead. See `routes/SessionRoute.tsx`.

## Commands

```bash
pnpm --filter @ai4s/web dev         # Vite dev server
pnpm --filter @ai4s/web typecheck
pnpm --filter @ai4s/web test
pnpm --filter @ai4s/web lint
CI=true VITE_OPEN_SCIENCE_API_URL=/api pnpm --filter @ai4s/web build
```
